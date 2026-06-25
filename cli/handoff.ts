/**
 * `keeper handoff` — enqueue a contextful document + instructions for a fresh
 * fire-and-forget claude worker, dispatched by a keeperd worker into the
 * INITIATOR's tmux session. The enqueue is event-sourced: this CLI mints a
 * stable `handoff_id`, applies the configured `handoff_prompt_prefix`, caps the
 * doc at 64KB (REJECT over cap — never truncate, since the body rides inline in
 * `events.data` forever and a fold reads it back), and sends a `request_handoff`
 * RPC (the SIXTH mutating RPC) → main APPENDs a `HandoffRequested` event → the
 * durable `handoffs` projection (status=`requested`). The dispatcher worker
 * (task .3) picks the row up and launches the handoff-ee.
 *
 * `keeper handoff show <handoff_id>` is the read verb — the dispatched worker's
 * FIRST call: it queries the `handoffs` collection and prints the stored `doc`
 * body so the handoff-ee can load its brief.
 *
 * Two forms mirror `keeper dispatch`'s free-form half: `--prompt "<doc>"` or
 * `--prompt-file <path>`, plus `--title`, `--session`, and `--no-prefix` (bypass
 * the configured prefix for a single invocation).
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  resolveConfig,
  resolveHandoffSpillDir,
  resolveSockPath,
} from "../src/db";
import type { ClientFrame, ServerFrame } from "../src/protocol";
import { queryCollection, roundTrip } from "./control-rpc";
import { resolveSession } from "./dispatch";

const HELP = `keeper handoff — enqueue a fire-and-forget claude worker with a contextful brief

Usage:
  keeper handoff --prompt "<doc>" [--title "<t>"] [--session <s>] [--no-prefix]
  keeper handoff --prompt-file <path> [--title "<t>"] [--session <s>] [--no-prefix]
  keeper handoff show <handoff_id>

Enqueue flags:
  --prompt <doc>        The contextful brief + instructions (inline)
  --prompt-file <path>  Read the brief from a file instead of --prompt
  --title <t>           Optional human title for the handoff
  --session <s>         Target tmux session (default: KEEPER_TMUX_SESSION > current > work)
  --no-prefix           Skip the configured handoff_prompt_prefix for this one call
  --sock <path>         Override the daemon socket path

  show <handoff_id>     Print the stored doc body for a handoff (the dispatched
                        worker's first call)

The brief is capped at 64KB — an over-cap brief is REJECTED (exit 2), never
truncated, because it rides inline in the event log and a fold reads it back.
`;

/** Doc-body cap (bytes, UTF-8). The brief rides inline in `events.data` forever
 *  (the canonical fold source), so an uncapped body is a re-fold time-bomb. This
 *  is a SEPARATE replay-cost cap from the dispatch argv cap. Over-cap → exit 2,
 *  never truncate. */
export const HANDOFF_DOC_MAX_BYTES = 64 * 1024;

/** Discriminated result of {@link validateHandoffDoc}. */
export type ValidateDocResult = { ok: true } | { ok: false; error: string };

/**
 * Reject a doc body that cannot ride safely in the event log: a NUL byte (which
 * truncates a C-string at the kernel boundary if it ever reaches an argv) or a
 * body over {@link HANDOFF_DOC_MAX_BYTES}. Pure — exported for unit reach.
 */
export function validateHandoffDoc(doc: string): ValidateDocResult {
  if (doc.length === 0) {
    return { ok: false, error: "handoff brief is empty" };
  }
  if (doc.includes("\0")) {
    return {
      ok: false,
      error: "handoff brief contains a NUL byte",
    };
  }
  const bytes = Buffer.byteLength(doc, "utf8");
  if (bytes > HANDOFF_DOC_MAX_BYTES) {
    return {
      ok: false,
      error: `handoff brief is ${bytes} bytes, over the ${HANDOFF_DOC_MAX_BYTES}-byte cap (reduce it — it is NOT truncated)`,
    };
  }
  return { ok: true };
}

/**
 * Build a well-formed RPC client frame for `request_handoff`. The brief itself is
 * NOT inlined — it rides through the filesystem (`doc_path` points at a spill file
 * the daemon reads back), so the wire frame stays small regardless of doc size
 * (the inline doc overflowed the ~8 KiB UDS send buffer and silently hung). Pure —
 * exported so tests can assert the wire shape.
 */
export function buildRequestHandoffFrame(
  id: string,
  req: {
    handoff_id: string;
    doc_path: string;
    title: string | null;
    target_session: string;
    initiator_session: string | null;
    initiator_pane: string | null;
  },
): ClientFrame {
  return {
    type: "rpc",
    id,
    method: "request_handoff",
    params: { ...req },
  };
}

/**
 * Spill the (already validated + capped) handoff doc to a file under the handoff
 * spill dir and return its absolute path. The daemon reads it back to inline the
 * doc into the `HandoffRequested` event, so durability is unchanged — the spill is
 * a transport detail, not the system of record (the CLI removes it on a successful
 * ack; age-out is the backstop). Pure-ish — exported for the round-trip test.
 */
export function spillHandoffDoc(handoffId: string, doc: string): string {
  const dir = resolveHandoffSpillDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${handoffId}.txt`);
  writeFileSync(path, doc, "utf8");
  return path;
}

function die(message: string): never {
  process.stderr.write(`keeper handoff: ${message}\n`);
  process.exit(1);
}

function argFault(message: string): never {
  process.stderr.write(`keeper handoff: ${message}\n`);
  process.exit(2);
}

export async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    options: {
      prompt: { type: "string" },
      "prompt-file": { type: "string" },
      title: { type: "string" },
      session: { type: "string" },
      "no-prefix": { type: "boolean", default: false },
      sock: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (parsed.values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const sockPath = parsed.values.sock ?? resolveSockPath();
  const [subcommand, ...rest] = parsed.positionals;

  // ---- read verb: `keeper handoff show <id>` ----
  if (subcommand === "show") {
    if (rest.length !== 1 || rest[0] === undefined || rest[0] === "") {
      die(
        "'show' takes exactly one positional <handoff_id>; pass --help for usage.",
      );
    }
    const handoffId = rest[0];
    let rows: Awaited<ReturnType<typeof queryCollection>> = [];
    try {
      rows = await queryCollection(sockPath, "handoffs", {
        handoff_id: handoffId,
      });
    } catch (err) {
      die((err as Error).message);
    }
    const row = rows[0];
    if (row === undefined) {
      die(`no handoff with id '${handoffId}'`);
    }
    // Print the raw stored brief verbatim (the dispatched worker reads it back).
    process.stdout.write(`${String(row.doc ?? "")}\n`);
    process.exit(0);
  }

  if (subcommand !== undefined) {
    die(
      `unknown subcommand '${subcommand}' (expected: show, or no subcommand to enqueue); pass --help for usage.`,
    );
  }

  // ---- enqueue: `keeper handoff --prompt ... ` ----
  const hasPrompt = parsed.values.prompt !== undefined;
  const hasPromptFile = parsed.values["prompt-file"] !== undefined;
  if (hasPrompt === hasPromptFile) {
    argFault("exactly one of --prompt or --prompt-file is required");
  }

  let doc: string;
  if (hasPromptFile) {
    const path = parsed.values["prompt-file"] as string;
    try {
      doc = readFileSync(path, "utf8");
    } catch (err) {
      die(`cannot read --prompt-file '${path}': ${(err as Error).message}`);
    }
  } else {
    doc = parsed.values.prompt as string;
  }

  // Apply the configured `handoff_prompt_prefix` (e.g. `/hack`) so the
  // handoff-ee boots into the prefix skill before reading its brief. `--no-prefix`
  // bypasses it for a single invocation. The prefix prepends `<prefix> ` to the
  // brief; the cap below runs on the FINAL prefixed doc.
  if (!(parsed.values["no-prefix"] ?? false)) {
    const prefix = resolveConfig().handoffPromptPrefix;
    if (prefix !== undefined && prefix !== "") {
      doc = `${prefix} ${doc}`;
    }
  }

  const docCheck = validateHandoffDoc(doc);
  if (!docCheck.ok) {
    // Over-cap / NUL / empty brief is CLI misuse — exit 2.
    argFault(docCheck.error);
  }

  // Resolve the target tmux session (the initiator's) per the documented
  // precedence: `--session` > `$KEEPER_TMUX_SESSION` > `$TMUX`-current > `work`.
  const { session } = resolveSession({ sessionFlag: parsed.values.session });

  // Raw initiator coordinates — always carried so the from-edge anchors even
  // when main can't resolve the pane to a folded job. `TMUX_PANE` is the live
  // pane id; `KEEPER_TMUX_SESSION` the initiator's session.
  const initiatorSession = process.env.KEEPER_TMUX_SESSION ?? null;
  const initiatorPane = process.env.TMUX_PANE ?? null;

  const title = parsed.values.title ?? null;
  const handoffId = crypto.randomUUID();
  const rpcId = crypto.randomUUID();

  // Spill the doc to a file and send only its PATH over the wire. The inline doc
  // (up to 64KB) overflowed the ~8 KiB UDS send buffer and silently hung; the
  // small `doc_path` frame never crosses that boundary. The daemon reads the file
  // back and inlines the doc into the event (durability unchanged), so this file
  // is transient — removed on a successful ack, aged out as a backstop.
  let docPath: string;
  try {
    docPath = spillHandoffDoc(handoffId, doc);
  } catch (err) {
    die(`cannot write the handoff spill file: ${(err as Error).message}`);
  }

  let response: ServerFrame;
  try {
    response = await roundTrip(
      sockPath,
      buildRequestHandoffFrame(rpcId, {
        handoff_id: handoffId,
        doc_path: docPath,
        title,
        target_session: session,
        initiator_session: initiatorSession,
        initiator_pane: initiatorPane,
      }),
      rpcId,
    );
  } catch (err) {
    // Leave the spill for age-out — a failed enqueue may be retried, and the
    // daemon never inlined it.
    die((err as Error).message);
  }

  if (response.type === "rpc_result") {
    // The daemon has inlined the doc into the event by now; best-effort remove
    // the spill (age-out is the backstop if this fails).
    try {
      rmSync(docPath, { force: true });
    } catch {
      // best-effort — age-out cleans it up.
    }
    process.stdout.write(`${JSON.stringify(response.value)}\n`);
    process.exit(0);
  }
  if (response.type === "error") {
    die(`server error ${response.code}: ${response.message}`);
  }
  die(`unexpected frame type: ${response.type}`);
}

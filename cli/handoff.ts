/**
 * `keeper handoff` — enqueue a contextful document + instructions for a fresh
 * fire-and-forget claude worker, dispatched by a keeperd worker into the
 * INITIATOR's tmux session. The enqueue is event-sourced: the agent authors a
 * REQUIRED, globally-unique `--slug` (the handoff id — the worker launches as
 * `handoff::<slug>`), the CLI slugifies it to `[a-z0-9-]+`, and the brief is
 * stored RAW (the dispatcher worker, not this CLI, composes the launch prompt as
 * `handoff_prompt_prefix` + framing + the brief INLINE — so the stored doc stays
 * unprefixed, and `keeper handoff show <slug>` prints it verbatim for
 * inspection). It caps the doc at 64KB (REJECT over
 * cap — never truncate, since the body rides inline in `events.data` forever and
 * a fold reads it back), and sends a `request_handoff` RPC (the SIXTH mutating
 * RPC) → main probes the events log for a host-global slug collision (rejecting a
 * duplicate with exit 3), then APPENDs a `HandoffRequested` event → the durable
 * `handoffs` projection (status=`requested`). The dispatcher worker picks the row
 * up and launches the handoff-ee.
 *
 * `keeper handoff show <slug>` is the read verb: it queries the `handoffs`
 * collection and prints the stored `doc` body so the brief can be inspected.
 *
 * Two forms mirror `keeper dispatch`'s free-form half: `--prompt "<doc>"` or
 * `--prompt-file <path>`, plus `--slug`, `--title`, `--session`, and `--cwd`.
 *
 * `--cwd <path>` is the directory the handoff-ee launches in — defaults to the
 * caller's own cwd. The CLI expands `~`, resolves a relative path against
 * `process.cwd()` to an ABSOLUTE path, and validates it exists + is a directory
 * (exit 2 on a miss) before sending; the dispatcher worker launches the
 * handoff-ee with that path as its cwd.
 *
 * Exit codes: 0 success, 1 daemon-unreachable / generic failure, 2 arg fault
 * (missing/empty `--slug`, over-cap brief, bad `--cwd`), 3 slug already in use.
 */

import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import { resolveHandoffSpillDir, resolveSockPath } from "../src/db";
import { slugifyHandoffSlug } from "../src/handoff-slug";
import type { ClientFrame, ServerFrame } from "../src/protocol";
import { queryCollection, roundTrip } from "./control-rpc";
import { buildParseOptions, HANDOFF_FLAGS } from "./descriptor";
import { resolveSession } from "./dispatch";

const HELP = `keeper handoff — enqueue a fire-and-forget claude worker with a contextful brief

Usage:
  keeper handoff --slug <slug> --prompt "<doc>" [--title "<t>"] [--session <s>]
  keeper handoff --slug <slug> --prompt-file <path> [--title "<t>"] [--session <s>]
  keeper handoff show <slug>

Enqueue flags:
  --slug <slug>         REQUIRED. Human-meaningful, globally-unique id for the
                        handoff; slugified to [a-z0-9-]+. The worker launches as
                        handoff::<slug>. A slug already in use is REJECTED (exit 3).
  --prompt <doc>        The contextful brief + instructions (inline)
  --prompt-file <path>  Read the brief from a file instead of --prompt
  --title <t>           Optional human title for the handoff
  --session <s>         Target tmux session (default: KEEPER_TMUX_SESSION > current > work)
  --cwd <path>          Directory the handoff-ee launches in (default: this
                        caller's cwd). Expands ~, resolves a relative path to an
                        absolute one; a non-existent / non-directory path → exit 2.
  --sock <path>         Override the daemon socket path

  show <slug>           Print the stored doc body for a handoff (inspection)

The brief is capped at 64KB — an over-cap brief is REJECTED (exit 2), never
truncated, because it rides inline in the event log and a fold reads it back.

Exit codes: 0 ok, 1 daemon-unreachable/generic, 2 arg fault, 3 slug already in use.

Run \`keeper handoff --agent-help\` for the terse operator runbook.
`;

/** Terse operator runbook (agent-facing), distinct from the full `--help`. */
const AGENT_HELP = `keeper handoff — operator runbook (agent-facing)

Enqueue a fire-and-forget claude worker with a contextful brief; keeperd boots it
inline in your tmux session. The brief rides inline in the event log.

  keeper handoff --slug <slug> --prompt "<brief>" [--title <t>] [--cwd <path>]
  keeper handoff --slug <slug> --prompt-file <path> [...]
  keeper handoff show <slug>      # read back the stored brief (inspection)

Rules: --slug is globally unique (reuse → exit 3); brief cap 64KB (over → exit 2,
REJECTED never truncated); --cwd launches cross-repo (default: caller's cwd).
Exit codes: 0 enqueued · 1 daemon-unreachable/generic · 2 arg fault · 3 slug in use.
NOT a plan-id launch (that is keeper dispatch) or messaging a running agent (keeper bus).
`;

/** Discriminated result of {@link resolveTargetDir}. */
export type ResolveTargetDirResult =
  | { ok: true; dir: string }
  | { ok: false; error: string };

/**
 * Resolve the handoff-ee's launch directory from the raw `--cwd` flag, against
 * the caller's `cwd`. Absent/empty `--cwd` defaults to `cwd` (the caller's own
 * dir). Otherwise expand a leading `~` against the home dir, resolve a relative
 * path against `cwd` to an ABSOLUTE path, then validate it exists + is a
 * directory (a symlinked dir is valid — `statSync` follows). A miss is CLI
 * misuse → the caller exits 2.
 *
 * TOCTOU is unavoidable (the dir can vanish between here and the launch); this
 * upfront probe is the primary guard, and the worker also catches a spawn-time
 * cwd error. Pure-with-injected-stat — `statDir` is the on-disk probe (defaults
 * to `statSync`), injected so a test drives the miss/non-dir branches without a
 * real path.
 */
export function resolveTargetDir(
  rawDir: string | undefined,
  cwd: string,
  statDir: (path: string) => { isDirectory(): boolean } = statSync,
): ResolveTargetDirResult {
  // Default = the caller's own cwd (always absolute — `process.cwd()`).
  if (rawDir === undefined || rawDir === "") {
    return { ok: true, dir: cwd };
  }
  // Expand a leading `~` / `~/...` against the home dir.
  const expanded =
    rawDir === "~" || rawDir.startsWith("~/")
      ? join(homedir(), rawDir.slice(1))
      : rawDir;
  // Resolve a relative path against the caller's cwd to an ABSOLUTE path.
  const abs = isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
  let st: { isDirectory(): boolean };
  try {
    st = statDir(abs);
  } catch {
    return {
      ok: false,
      error: `--cwd '${rawDir}' does not exist (resolved to ${abs})`,
    };
  }
  if (!st.isDirectory()) {
    return {
      ok: false,
      error: `--cwd '${rawDir}' is not a directory (resolved to ${abs})`,
    };
  }
  return { ok: true, dir: abs };
}

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
    desired_slug: string;
    doc_path: string;
    title: string | null;
    target_session: string;
    target_dir: string;
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
 * ack; age-out is the backstop). Keyed on a THROWAWAY transport id (the rpc id),
 * NEVER the slug — two concurrent same-slug enqueues would otherwise clobber each
 * other's spill before the daemon reads it (the loser then inlines the wrong
 * brief). Pure-ish — exported for the round-trip test.
 */
export function spillHandoffDoc(spillKey: string, doc: string): string {
  const dir = resolveHandoffSpillDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${spillKey}.txt`);
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

/** Exit 3 — a duplicate slug. DISTINCT from exit 1 (daemon-unreachable / generic)
 *  and exit 2 (arg fault) so a caller can machine-distinguish "pick a new slug"
 *  from "the daemon is down". */
function slugTaken(message: string): never {
  process.stderr.write(`keeper handoff: ${message}\n`);
  process.exit(3);
}

/** Parse the handoff flag surface (derived from the pure-data descriptor, ADR
 *  0008). An unknown flag (or a value-shape fault) is CLI misuse → exit 2 with
 *  the parser's own message, never the uncaught-throw exit 1. Keeps the precise
 *  per-flag `values` typing (the `never` from {@link argFault} unions away). */
function parseHandoffArgs(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      options: buildParseOptions(HANDOFF_FLAGS),
      allowPositionals: true,
    });
  } catch (err) {
    argFault((err as Error).message);
  }
}

export async function main(argv: string[]): Promise<void> {
  const parsed = parseHandoffArgs(argv);

  if (parsed.values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (parsed.values["agent-help"]) {
    process.stdout.write(AGENT_HELP);
    process.exit(0);
  }

  const sockPath = parsed.values.sock ?? resolveSockPath();
  const [subcommand, ...rest] = parsed.positionals;

  // ---- read verb: `keeper handoff show <slug>` ----
  if (subcommand === "show") {
    if (rest.length !== 1 || rest[0] === undefined || rest[0] === "") {
      die("'show' takes exactly one positional <slug>; pass --help for usage.");
    }
    const slug = rest[0];
    let rows: Awaited<ReturnType<typeof queryCollection>> = [];
    try {
      rows = await queryCollection(sockPath, "handoffs", {
        handoff_id: slug,
      });
    } catch (err) {
      die((err as Error).message);
    }
    const row = rows[0];
    if (row === undefined) {
      die(`no handoff with slug '${slug}'`);
    }
    // Print the raw stored brief verbatim (inspection only — the handoff-ee gets
    // the brief inline in its launch prompt, not via this verb).
    process.stdout.write(`${String(row.doc ?? "")}\n`);
    process.exit(0);
  }

  if (subcommand !== undefined) {
    die(
      `unknown subcommand '${subcommand}' (expected: show, or no subcommand to enqueue); pass --help for usage.`,
    );
  }

  // ---- enqueue: `keeper handoff --slug <slug> --prompt ... ` ----
  // The slug is REQUIRED and is the handoff's globally-unique id (the worker
  // launches as `handoff::<slug>`). Slugify to `[a-z0-9-]+`; an empty result
  // (all non-ASCII / punctuation-only) is misuse → exit 2.
  if (parsed.values.slug === undefined) {
    argFault("--slug is required (a human-meaningful, globally-unique id)");
  }
  const slug = slugifyHandoffSlug(parsed.values.slug);
  if (slug === null) {
    argFault(
      `--slug '${parsed.values.slug}' slugifies to nothing — use [a-z0-9-]`,
    );
  }

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

  // The brief is stored RAW — the dispatcher worker composes the launch prompt
  // (`handoff_prompt_prefix` + framing + the brief inline), never mutating the
  // stored doc body. Prefixing here would embed a stray `/hack` in the brief that
  // the handoff-ee reads back as inert noise, so the prefix lives at exactly one
  // site: the launcher.
  const docCheck = validateHandoffDoc(doc);
  if (!docCheck.ok) {
    // Over-cap / NUL / empty brief is CLI misuse — exit 2.
    argFault(docCheck.error);
  }

  // Resolve the target tmux session (the initiator's) per the documented
  // precedence: `--session` > `$KEEPER_TMUX_SESSION` > `$TMUX`-current > `work`.
  const { session } = resolveSession({ sessionFlag: parsed.values.session });

  // Resolve the launch directory for the handoff-ee. `--cwd` defaults to THIS
  // caller's cwd; a relative path / `~` is resolved here (the daemon only sees
  // the absolute result) and validated to exist + be a directory — exit 2 on a
  // miss, mirroring dispatch's cwd-existence guard. Always send an absolute
  // `target_dir` so the dispatcher never falls back to keeperd's own cwd.
  const dirResult = resolveTargetDir(parsed.values.cwd, process.cwd());
  if (!dirResult.ok) {
    argFault(dirResult.error);
  }
  const targetDir = dirResult.dir;

  // Raw initiator coordinates — always carried so the from-edge anchors even
  // when main can't resolve the pane to a folded job. `TMUX_PANE` is the live
  // pane id; `KEEPER_TMUX_SESSION` the initiator's session.
  const initiatorSession = process.env.KEEPER_TMUX_SESSION ?? null;
  const initiatorPane = process.env.TMUX_PANE ?? null;

  const title = parsed.values.title ?? null;
  // The slug is the handoff id (resolved daemon-side on uniqueness). The spill is
  // keyed on the THROWAWAY rpc id, NOT the slug, so two concurrent same-slug
  // enqueues never clobber each other's spill before the daemon reads it.
  const rpcId = crypto.randomUUID();

  // Spill the doc to a file and send only its PATH over the wire. The inline doc
  // (up to 64KB) overflowed the ~8 KiB UDS send buffer and silently hung; the
  // small `doc_path` frame never crosses that boundary. The daemon reads the file
  // back and inlines the doc into the event (durability unchanged), so this file
  // is transient — removed on a successful ack, aged out as a backstop.
  let docPath: string;
  try {
    docPath = spillHandoffDoc(rpcId, doc);
  } catch (err) {
    die(`cannot write the handoff spill file: ${(err as Error).message}`);
  }

  let response: ServerFrame;
  try {
    response = await roundTrip(
      sockPath,
      buildRequestHandoffFrame(rpcId, {
        desired_slug: slug,
        doc_path: docPath,
        title,
        target_session: session,
        target_dir: targetDir,
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
    // A taken slug is machine-distinguishable: exit 3, not the generic exit 1.
    if (response.code === "slug_conflict") {
      slugTaken(response.message);
    }
    die(`server error ${response.code}: ${response.message}`);
  }
  die(`unexpected frame type: ${response.type}`);
}

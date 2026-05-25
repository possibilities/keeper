#!/usr/bin/env bun
/**
 * approve — thin RPC client over the keeper subscribe socket. Takes a single
 * planctl id, infers whether it names an epic or a task from its shape, and
 * sends the matching approval RPC. Status defaults to `approved` so the
 * common case is a one-arg invocation.
 *
 * Unlike the example `scripts/board.ts` subscribe client, this
 * CLI is short-lived and read/write-mixed: each round-trip opens a fresh
 * `Bun.connect`, sends ONE frame, awaits the matching response by `id`,
 * and closes. No subscription, no poll, no reconnect — if the daemon is
 * down, `Bun.connect` rejects (typically ECONNREFUSED) and the CLI fails
 * fast (`exit 1`). A user-visible "daemon not running" message is more
 * useful than a backoff loop for a one-shot mutation.
 *
 * Id inference. A planctl task id is `<epic-slug>.<task_number>` (e.g.
 * `fn-592-approval-as-planctl-field.4`); an epic id has no trailing `.N`.
 * `approve` looks for a trailing dot-then-integer:
 *
 *   bun scripts/approve.ts <task_id> [status]
 *     → set_task_approval { epic_id: <derived>, task_id: <task_id>, status }
 *
 *   bun scripts/approve.ts <epic_id> [status]
 *     → set_epic_approval { epic_id: <epic_id>, status }
 *
 * `<status>` defaults to `approved` when omitted. The full vocabulary is
 * `approved | rejected | pending` (hard cut from the schema-v12 verbs; no
 * `clear` alias). `pending` writes "pending" to the planctl JSON file —
 * the file is the canonical source of truth and carries the value
 * verbatim. There is no DELETE path; "absent row = pending" is no longer
 * the invariant (schema v13 — see the epic `fn-592-approval-as-planctl-field`).
 *
 * Epic-approval pre-check. When approving an EPIC (status === "approved"
 * AND the id is an epic id), the CLI first does a pk-lookup `query` on
 * the target epic, decodes the embedded `tasks[]` array, and refuses with
 * exit 1 if any task has `approval !== "approved"`. This is a CLIENT-SIDE
 * gate, not a server enforcement — the underlying `set_epic_approval` RPC
 * still accepts the write. The check rides this CLI because the rule is
 * "no green epic over a yellow task list", a UX invariant of this tool
 * rather than a planctl-file invariant. Skipped when targeting a task or
 * when setting an epic to `rejected` / `pending` (which are always
 * allowed). The query uses `filter: { epic_id }` (a pk lookup) which the
 * server exempts from the descriptor's default scope, so the check works
 * even when the epic is itself already done+approved.
 *
 * Wire round-trip (mirrors `RpcFrame` / `RpcResultFrame` / `ErrorFrame` in
 * `src/protocol.ts`):
 *
 *   client → server: { type: "rpc", id, method, params }
 *   server → client: { type: "rpc_result", id, rev, value }   on success
 *                  | { type: "error",      id, rev, code, message }  on failure
 *
 * Each round-trip's `id` is a fresh `crypto.randomUUID()` — neither
 * connection multiplexes, but echoing the id on the response is part of
 * the protocol contract and the dispatcher's defensive checks rely on it.
 *
 * Usage:
 *   bun scripts/approve.ts [--sock <path>] <id> [status]
 *
 *   <id>         Planctl epic OR task id. A trailing `.N` marks a task
 *                (the epic_id is derived by stripping the suffix).
 *   <status>     Optional. One of: approved, rejected, pending.
 *                Defaults to `approved`.
 *
 *   --sock <path>  Socket path override (else $KEEPER_SOCK, else the
 *                  ~/.local/state/keeper/keeperd.sock default).
 *   --help         Show this help.
 *
 * Exit codes:
 *   0 — `rpc_result` arrived; the handler's return value is printed to
 *       stdout as a single line of JSON.
 *   1 — the daemon is down (connect failed), the server returned `error`,
 *       the response frame never arrived before the deadline, the
 *       arguments are malformed, or the epic-approval pre-check found
 *       unapproved tasks. The human-readable reason goes to stderr.
 */

import { parseArgs } from "node:util";
import { resolveSockPath } from "../src/db";
import {
  type ClientFrame,
  encodeFrame,
  LineBuffer,
  type ServerFrame,
} from "../src/protocol";

/**
 * Hard upper bound on how long the CLI waits for the `rpc_result` /
 * `error` frame after a successful connect. A healthy daemon answers in
 * well under a millisecond on local UDS; 5s is generous and avoids a
 * blocked client wedging forever if the server is wedged. On timeout the
 * CLI surfaces a clear stderr message and exits 1 — never hangs silently.
 */
const RESPONSE_TIMEOUT_MS = 5000;

/** Wire-validated approval enum, mirrored from `src/rpc-handlers.ts`. */
const APPROVAL_STATUSES = new Set(["approved", "rejected", "pending"]);

const HELP = `approve — thin RPC client for the keeper subscribe server's planctl-native approval RPCs

Usage: bun scripts/approve.ts [--sock <path>] <id> [status]

  <id>           Planctl epic OR task id. A trailing '.N' marks a task; the
                 epic_id is derived by stripping the '.N' suffix.
  <status>       Optional. One of: approved, rejected, pending.
                 Defaults to 'approved'.

  --sock <path>  Socket path override ($KEEPER_SOCK / default otherwise)
  --help         Show this help

Routing (inferred from <id>):
  <epic-slug>        → set_epic_approval { epic_id, status }
  <epic-slug>.<N>    → set_task_approval { epic_id, task_id, status }

Epic-approval pre-check:
  When the inferred call is set_epic_approval AND status == 'approved',
  the CLI first queries the epic and refuses (exit 1) if any embedded
  task has approval != 'approved'. Setting an epic to 'rejected' or
  'pending', or targeting a task, skips this check.

Examples:
  bun scripts/approve.ts fn-592-approval-as-planctl-field
  bun scripts/approve.ts fn-592-approval-as-planctl-field.4
  bun scripts/approve.ts fn-592-approval-as-planctl-field rejected
  bun scripts/approve.ts fn-592-approval-as-planctl-field.4 pending

On success: prints the handler's return value as a single JSON line to
stdout and exits 0. On failure (daemon down, validation error, unknown
method, timeout, pre-check fail): prints the reason to stderr and exits 1.
`;

function die(message: string): never {
  process.stderr.write(`approve: ${message}\n`);
  process.exit(1);
}

/**
 * Validate a positional `status` arg against the wire enum. Throws via
 * `die` (exit 1) on a value off the enum.
 */
function validateStatus(value: string): "approved" | "rejected" | "pending" {
  if (!APPROVAL_STATUSES.has(value)) {
    die(`unknown status '${value}' (expected approved|rejected|pending)`);
  }
  return value as "approved" | "rejected" | "pending";
}

/**
 * Decide which RPC to call from positional args, validate them, and return
 * the wire payload. Positionals are `<id> [status]` — when `status` is
 * omitted it defaults to `approved`. The id's shape decides the route:
 * a trailing `.<digits>` segment names a task (the epic_id is derived by
 * stripping the suffix); anything else is treated as an epic id.
 *
 * The task-id regex mirrors `taskNumFromId` in `scripts/board.ts` and
 * `epicNumberFromId` in the daemon — a planctl task id is the epic slug,
 * a dot, then an integer; no other structure carries the same suffix
 * shape in the wire vocabulary, so this is unambiguous.
 */
function routePositionals(positionals: string[]): {
  method: "set_epic_approval" | "set_task_approval";
  params: Record<string, string>;
} {
  if (positionals.length < 1 || positionals.length > 2) {
    die(
      `expected 1 (<id>) or 2 (<id> <status>) positional args; got ${positionals.length}. Pass --help for usage.`,
    );
  }
  const [id, statusRaw] = positionals as [string, string | undefined];
  if (id.length === 0) {
    die("id must be non-empty");
  }
  const status = validateStatus(statusRaw ?? "approved");
  const taskMatch = /^(.+)\.\d+$/.exec(id);
  if (taskMatch) {
    return {
      method: "set_task_approval",
      params: { epic_id: taskMatch[1], task_id: id, status },
    };
  }
  return {
    method: "set_epic_approval",
    params: { epic_id: id, status },
  };
}

/**
 * One round-trip on a fresh UDS connection: open, write `send`, wait for the
 * server frame whose `id === matchId`, return it. Connection-local
 * `LineBuffer` so a partial line never crosses round-trips. Resolves with
 * the matching frame; rejects with an `Error` carrying the human-readable
 * reason on connect-fail, transport error, malformed frame, server-side
 * close before reply, or `RESPONSE_TIMEOUT_MS` elapsing post-connect.
 *
 * The `id`-correlation guard is defensive — the dispatcher today never
 * leaks unrelated frames into an RPC's reply path, but the sibling
 * subscribe path can interleave `patch`/`meta` and the discipline keeps
 * this helper safe to lift if reused.
 */
async function roundTrip(
  sockPath: string,
  send: ClientFrame,
  matchId: string,
): Promise<ServerFrame> {
  return new Promise<ServerFrame>((resolve, reject) => {
    const buffer = new LineBuffer();
    let settled = false;
    let sock: Awaited<ReturnType<typeof Bun.connect>> | null = null;

    const settle = (err: Error | null, frame: ServerFrame | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      try {
        sock?.end();
      } catch {
        // best-effort
      }
      if (err) {
        reject(err);
      } else if (frame) {
        resolve(frame);
      } else {
        reject(new Error("internal: settle called with neither err nor frame"));
      }
    };

    const timeout = setTimeout(() => {
      settle(
        new Error(
          `no response from daemon within ${RESPONSE_TIMEOUT_MS}ms (id ${matchId})`,
        ),
        null,
      );
    }, RESPONSE_TIMEOUT_MS);
    timeout.unref?.();

    Bun.connect({
      unix: sockPath,
      socket: {
        open(s) {
          sock = s;
          s.write(encodeFrame(send));
        },
        data(_s, chunk) {
          let lines: string[];
          try {
            lines = buffer.push(chunk.toString("utf8"));
          } catch (err) {
            settle(
              new Error(`protocol error: ${(err as Error).message}`),
              null,
            );
            return;
          }
          for (const line of lines) {
            if (line.trim().length === 0) {
              continue;
            }
            let frame: ServerFrame;
            try {
              frame = JSON.parse(line) as ServerFrame;
            } catch (err) {
              settle(
                new Error(`malformed server frame: ${(err as Error).message}`),
                null,
              );
              return;
            }
            if ((frame as { id?: string }).id !== matchId) {
              continue;
            }
            settle(null, frame);
            return;
          }
        },
        close() {
          settle(
            new Error(
              `daemon closed connection before responding (id ${matchId})`,
            ),
            null,
          );
        },
        error(_s, err) {
          settle(new Error(`socket error: ${err.message}`), null);
        },
      },
    }).catch((err: Error) => {
      settle(
        new Error(`failed to connect to ${sockPath}: ${err.message}`),
        null,
      );
    });
  });
}

/**
 * Epic-approval pre-check. Sends a pk-lookup `query` for the target epic
 * (pk filter bypasses the server's default scope, so the epic is fetched
 * regardless of its own status/approval), decodes the embedded `tasks[]`
 * array, and dies with exit 1 if any task has `approval !== "approved"`.
 * A task with no `approval` cell counts as not-approved per the file-is-
 * canonical invariant (the planctl `approval` field is required schema v13).
 *
 * Why client-side: the rule "an epic can't be green over a yellow task
 * list" is a UX invariant of THIS CLI, not a planctl-file invariant. The
 * underlying `set_epic_approval` RPC still accepts the write — other
 * callers may need to override the rule (e.g. a scripted bulk close).
 */
async function preCheckEpicApproval(
  sockPath: string,
  epicId: string,
): Promise<void> {
  const queryId = crypto.randomUUID();
  let frame: ServerFrame;
  try {
    frame = await roundTrip(
      sockPath,
      {
        type: "query",
        collection: "epics",
        id: queryId,
        filter: { epic_id: epicId },
        limit: 1,
      },
      queryId,
    );
  } catch (err) {
    die((err as Error).message);
  }
  if (frame.type === "error") {
    die(`server error ${frame.code}: ${frame.message}`);
  }
  if (frame.type !== "result") {
    die(`unexpected frame type for pre-check: ${frame.type}`);
  }
  if (frame.rows.length === 0) {
    die(`epic '${epicId}' not found`);
  }
  const row = frame.rows[0] as Record<string, unknown>;
  const tasks = Array.isArray(row.tasks) ? row.tasks : [];
  const unapproved = tasks
    .map((t) => t as Record<string, unknown>)
    .filter((t) => t.approval !== "approved")
    .map((t) => `${String(t.task_id)}=${String(t.approval ?? "pending")}`);
  if (unapproved.length > 0) {
    die(
      `cannot approve epic '${epicId}': ${unapproved.length} task(s) not approved: ${unapproved.join(", ")}`,
    );
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      sock: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (parsed.values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const { method, params } = routePositionals(parsed.positionals);
  const sockPath = parsed.values.sock ?? resolveSockPath();

  // Pre-check: only when approving an EPIC. Task-targeted RPCs and
  // status-to-rejected/pending epic RPCs skip this step.
  if (method === "set_epic_approval" && params.status === "approved") {
    await preCheckEpicApproval(sockPath, params.epic_id);
  }

  // One fresh id per round-trip. The CLI never multiplexes within a
  // connection, but the protocol requires a non-empty string id and the
  // dispatcher echoes it back so we can match the response defensively.
  const rpcId = crypto.randomUUID();
  let frame: ServerFrame;
  try {
    frame = await roundTrip(
      sockPath,
      { type: "rpc", id: rpcId, method, params },
      rpcId,
    );
  } catch (err) {
    die((err as Error).message);
  }
  if (frame.type === "rpc_result") {
    // For set_epic_approval the value is `{ ok: true, epic_id, approval }`;
    // for set_task_approval it's `{ ok: true, epic_id, task_id, approval }`.
    // One JSON line so a caller pipes it cleanly into `jq`.
    process.stdout.write(`${JSON.stringify(frame.value)}\n`);
    process.exit(0);
  }
  if (frame.type === "error") {
    die(`server error ${frame.code}: ${frame.message}`);
  }
  die(`unexpected frame type for id ${rpcId}: ${frame.type}`);
}

await main();

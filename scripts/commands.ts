#!/usr/bin/env bun
/**
 * commands — print the autopilot plan-dispatch command pair for a single
 * planctl id. Takes an epic OR task id, infers which from its shape, queries
 * the keeper subscribe socket for the owning epic, and prints the two
 * `cd … && claude … '/plan:<verb> <id>'` shell commands autopilot would
 * dispatch for that row:
 *
 *   - a TASK id (`<epic-slug>.<N>`) → the `work` command + the `approve`
 *     command, with the worker `cd` target taken from the task's
 *     `target_repo` (falling back to the epic's `project_dir`) and the
 *     task's `tier` threaded into `--plugin-dir` exactly as autopilot does.
 *   - an EPIC id (`<epic-slug>`) → the `close` command + the `approve`
 *     command, both `cd`'d to the epic's `project_dir`.
 *
 * The commands are rendered through `buildWorkerCommand` imported from
 * `src/autopilot-worker.ts` — the single source the server-side autopilot
 * reconciler dispatches through — so the printed strings are byte-identical
 * to what a live reconciler launches on the matching readiness edge
 * (`work`/`close` on `→ ready`, `approve` on `→ job-pending`). The approve line is the
 * `/plan:approve` claude command (autopilot's live job-pending dispatch),
 * NOT the `bun approve.ts <id>` form autopilot's static display-helper
 * uses.
 *
 * Like `scripts/approve.ts`, this is a short-lived one-shot read: a fresh
 * `Bun.connect`, one `query` frame, the matching `result` awaited by `id`,
 * then close. No subscription, no reconnect — if the daemon is down,
 * `Bun.connect` rejects and the CLI fails fast (exit 1).
 *
 * Id inference mirrors `approve.ts`: a trailing `.<digits>` segment marks a
 * task (the epic_id is derived by stripping the suffix); anything else is
 * an epic id.
 *
 * Usage:
 *   bun scripts/commands.ts [--sock <path>] <id>
 *
 *   <id>           Planctl epic OR task id. A trailing '.N' marks a task.
 *   --sock <path>  Socket path override (else $KEEPER_SOCK, else the
 *                  ~/.local/state/keeper/keeperd.sock default).
 *   --help         Show this help.
 *
 * Exit codes:
 *   0 — the two commands were printed (one per line) to stdout.
 *   1 — the daemon is down, the server returned `error`, the response
 *       never arrived before the deadline, the epic/task wasn't found, or
 *       the arguments are malformed. The reason goes to stderr.
 */

import { parseArgs } from "node:util";
import { buildWorkerCommand } from "../src/autopilot-worker";
import { resolveSockPath } from "../src/db";
import {
  type ClientFrame,
  encodeFrame,
  LineBuffer,
  type ServerFrame,
} from "../src/protocol";
import type { Epic, Task } from "../src/types";

/**
 * Hard upper bound on how long the CLI waits for the `result` frame after a
 * successful connect. Mirrors `approve.ts` — a healthy daemon answers in
 * well under a millisecond on local UDS; 5s is generous and avoids a
 * blocked client wedging forever.
 */
const RESPONSE_TIMEOUT_MS = 5000;

const HELP = `commands — print the autopilot plan-dispatch command pair for a planctl id

Usage: bun scripts/commands.ts [--sock <path>] <id>

  <id>           Planctl epic OR task id. A trailing '.N' marks a task; the
                 epic_id is derived by stripping the '.N' suffix.

  --sock <path>  Socket path override ($KEEPER_SOCK / default otherwise)
  --help         Show this help

Output (two lines, exactly what autopilot dispatches):
  <epic-slug>.<N>  → work command + approve command (task scope)
  <epic-slug>      → close command + approve command (epic scope)

Examples:
  bun scripts/commands.ts fn-592-approval-as-planctl-field
  bun scripts/commands.ts fn-592-approval-as-planctl-field.4

On success: prints the two commands (one per line) to stdout and exits 0.
On failure (daemon down, not found, timeout): prints the reason to stderr
and exits 1.
`;

const seg = (v: unknown): string => (v == null ? "" : String(v));

function die(message: string): never {
  process.stderr.write(`commands: ${message}\n`);
  process.exit(1);
}

/**
 * One round-trip on a fresh UDS connection: open, write `send`, wait for the
 * server frame whose `id === matchId`, return it. Copied from `approve.ts`'s
 * `roundTrip` (not exported there) — connection-local `LineBuffer` so a
 * partial line never crosses round-trips; rejects with a human-readable
 * `Error` on connect-fail, transport error, malformed frame, server-side
 * close before reply, or `RESPONSE_TIMEOUT_MS` elapsing post-connect.
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
 * Fetch the owning epic by pk. A pk-filter `query` bypasses the server's
 * default scope (mirrors `approve.ts`'s pre-check), so the epic is returned
 * regardless of its own status/approval. Dies (exit 1) on transport error,
 * a server `error` frame, an unexpected frame type, or a not-found epic.
 */
async function fetchEpic(sockPath: string, epicId: string): Promise<Epic> {
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
    die(`unexpected frame type for query: ${frame.type}`);
  }
  if (frame.rows.length === 0) {
    die(`epic '${epicId}' not found`);
  }
  return frame.rows[0] as unknown as Epic;
}

/**
 * Effective `cd` target for a task's worker command: the task's
 * `target_repo` when set (a task may live in a different repo than its
 * epic), else the epic's `project_dir`. Same fallback the autopilot
 * renderers and the plan worker's task seeding use.
 */
function taskCdDir(task: Task, projectDir: string): string {
  if (task.target_repo != null && seg(task.target_repo) !== "") {
    return seg(task.target_repo);
  }
  return projectDir;
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

  const positionals = parsed.positionals;
  if (positionals.length !== 1) {
    die(
      `expected exactly 1 positional arg (<id>); got ${positionals.length}. Pass --help for usage.`,
    );
  }
  const id = positionals[0];
  if (id.length === 0) {
    die("id must be non-empty");
  }

  const sockPath = parsed.values.sock ?? resolveSockPath();

  // Id inference mirrors approve.ts: a trailing `.<digits>` marks a task;
  // the epic_id is derived by stripping the suffix.
  const taskMatch = /^(.+)\.\d+$/.exec(id);
  const epicId = taskMatch ? taskMatch[1] : id;

  const epic = await fetchEpic(sockPath, epicId);
  const projectDir = seg(epic.project_dir);

  const lines: string[] = [];
  if (taskMatch) {
    // Task scope: work + approve, cd'd to the task's effective repo.
    const tasks = Array.isArray(epic.tasks) ? epic.tasks : [];
    const task = tasks.find((t) => seg(t.task_id) === id);
    if (task === undefined) {
      die(`task '${id}' not found in epic '${epicId}'`);
    }
    const dir = taskCdDir(task, projectDir);
    lines.push(
      buildWorkerCommand("work", id, dir),
      buildWorkerCommand("approve", id, dir),
    );
  } else {
    // Epic scope: close + approve, cd'd to the epic's project_dir.
    lines.push(
      buildWorkerCommand("close", epicId, projectDir),
      buildWorkerCommand("approve", epicId, projectDir),
    );
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  process.exit(0);
}

if (import.meta.main) {
  await main();
}

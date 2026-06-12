#!/usr/bin/env bun
/**
 * unstick-autopilot — diagnose, and on `--apply` clear, the durable state that
 * wedges the server-side autopilot reconciler.
 *
 * The class of "autopilot is unpaused but dispatches nothing" stall almost
 * always reduces to ONE durable cause: sticky `dispatch_failures` rows. They
 * are the only durable autopilot-owned projection, and by design there is NO
 * auto-retry — every row permanently suppresses re-dispatch of its
 * `(verb, id)` (`src/autopilot-worker.ts`: "skip if an open dispatch_failures
 * row exists for (V, id)"). Worse, the failed task still computes to a
 * non-completed readiness verdict, so it keeps occupying its per-epic AND
 * per-root mutex (`single-task-per-root` / `single-task-per-epic`) and queues
 * every sibling ready task behind it. Net effect: a fully quiescent board.
 *
 * The generic unstick is therefore: clear every `dispatch_failures` row via the
 * `retry_dispatch` RPC (which appends a `DispatchCleared` synthetic event; the
 * reducer DELETEs the matching row on the next drain, and that very DB write is
 * a `data_version` pulse that wakes the level-triggered reconciler). We clear
 * ALL rows, not a scoped subset: clearing a stale row for an already-`done`
 * epic is harmless — the reconciler's own gates (readiness, mutex, repo-clean,
 * uncommitted-epic) decide what ACTUALLY dispatches afterward, so no readiness
 * recomputation is needed here.
 *
 * What this tool deliberately does NOT do: it never writes a projection
 * directly (the RPC round-trips through the reducer, so a re-fold sees the
 * clear), never kills or resurrects the tmux worker session (a heavier,
 * riskier hammer the daemon's exec-backend already self-heals on session-gone),
 * and never auto-unpauses unless you ask (`--play`) — pause is a human safety
 * default. The two adjacent conditions it can't fix (a dirty target repo, a
 * missing tmux session) are surfaced as loud warnings so you fix them
 * deliberately before the cleared dispatches just re-fail.
 *
 * Safe by default: a bare invocation only DIAGNOSES (read-only queries) and
 * prints what it would clear. Mutation happens only under `--apply`.
 *
 * Usage:
 *   bun scripts/unstick-autopilot.ts                 # dry-run diagnosis
 *   bun scripts/unstick-autopilot.ts --apply         # clear every sticky failure
 *   bun scripts/unstick-autopilot.ts --apply --play  # ...and unpause if paused
 *   bun scripts/unstick-autopilot.ts --help
 *
 * Options:
 *   --apply                 Send retry_dispatch for every dispatch_failures row.
 *   --play                  If autopilot is paused, also send set_autopilot_paused{false}.
 *   --session-name <name>   tmux session to liveness-check (default: autopilot).
 *   --sock <path>           Socket path override ($KEEPER_SOCK / default otherwise).
 *   --help                  Show this help.
 */

import { parseArgs } from "node:util";
import { buildRetryFrame, buildSetPausedFrame } from "../cli/autopilot";
import { resolveSockPath } from "../src/db";
import {
  buildTmuxHasSessionArgs,
  MANAGED_EXEC_SESSION,
} from "../src/exec-backend";
import {
  type ClientFrame,
  encodeFrame,
  LineBuffer,
  type ServerFrame,
} from "../src/protocol";

const HELP = `unstick-autopilot — diagnose, and on --apply clear, the sticky dispatch_failures
rows that wedge the autopilot reconciler.

Usage:
  bun scripts/unstick-autopilot.ts                 # dry-run diagnosis (read-only)
  bun scripts/unstick-autopilot.ts --apply         # clear every sticky failure
  bun scripts/unstick-autopilot.ts --apply --play  # ...and unpause if paused

Options:
  --apply                 Send retry_dispatch for every dispatch_failures row.
  --play                  If autopilot is paused, also send set_autopilot_paused{false}.
  --session-name <name>   tmux session to liveness-check (default: ${MANAGED_EXEC_SESSION}).
  --sock <path>           Socket path override ($KEEPER_SOCK / default otherwise).
  --help                  Show this help.

Safe by default: a bare invocation only reads state and prints what it WOULD
clear. The reducer (not this tool) performs every write; clearing re-arms the
reconciler, whose own gates then decide what actually dispatches.
`;

/** Hard cap on a single round-trip post-connect. Mirrors the sibling scripts. */
const RESPONSE_TIMEOUT_MS = 5000;

function die(msg: string): never {
  console.error(`[unstick] ${msg}`);
  process.exit(1);
}

/**
 * One round-trip on a fresh UDS connection: open, write `send`, resolve with
 * the server frame whose `id === matchId`, close. Copied from the proven shape
 * in `scripts/commands.ts` / `scripts/approve.ts` (their `roundTrip` is not
 * exported) — connection-local `LineBuffer` so a partial line never crosses
 * round-trips; rejects on connect-fail, transport error, malformed frame,
 * server close before reply, or `RESPONSE_TIMEOUT_MS` elapsing post-connect.
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

type Row = Record<string, unknown>;

/** Read an entire collection one-shot (`limit: 0` = full filtered set). */
async function queryAll(sockPath: string, collection: string): Promise<Row[]> {
  const queryId = crypto.randomUUID();
  let frame: ServerFrame;
  try {
    frame = await roundTrip(
      sockPath,
      { type: "query", collection, id: queryId, limit: 0 },
      queryId,
    );
  } catch (err) {
    die((err as Error).message);
  }
  if (frame.type === "error") {
    die(`server error querying ${collection}: ${frame.code}: ${frame.message}`);
  }
  if (frame.type !== "result") {
    die(`unexpected frame type for ${collection} query: ${frame.type}`);
  }
  return frame.rows as Row[];
}

const seg = (v: unknown): string => (v == null ? "" : String(v));

type SessionState = "live" | "missing" | "unknown";

/**
 * Liveness-check the tmux worker session via `tmux has-session -t =<name>`
 * (exit 0 = live, non-zero = absent). The `=` prefix forces an EXACT match so
 * `auto` never spuriously matches `autopilot`. Returns `"unknown"` if the binary
 * is missing or the spawn errors (non-fatal — this tool's job is
 * dispatch_failures, not infra).
 */
async function probeSession(session: string): Promise<SessionState> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(buildTmuxHasSessionArgs(session), {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return "unknown";
  }
  const exitCode = await proc.exited;
  return exitCode === 0 ? "live" : "missing";
}

/** Human-readable age from a unix-seconds timestamp. */
function ageFrom(tsSec: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - tsSec));
  if (secs < 90) {
    return `${secs}s`;
  }
  if (secs < 5400) {
    return `${Math.round(secs / 60)}m`;
  }
  return `${Math.round(secs / 3600)}h`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      apply: { type: "boolean", default: false },
      play: { type: "boolean", default: false },
      "session-name": { type: "string", default: MANAGED_EXEC_SESSION },
      sock: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const sock = values.sock ?? resolveSockPath();
  const sessionName = values["session-name"] ?? MANAGED_EXEC_SESSION;

  // --- diagnose (read-only) -------------------------------------------------
  const [apRows, failRows, gitRows] = await Promise.all([
    queryAll(sock, "autopilot_state"),
    queryAll(sock, "dispatch_failures"),
    queryAll(sock, "git"),
  ]);

  const paused = apRows.length > 0 && Number(apRows[0].paused) === 1;
  const dirtyRoots = gitRows.filter((r) => Number(r.dirty_count) > 0);
  const sessionState = await probeSession(sessionName);

  console.log("=== autopilot diagnosis ===");
  console.log(
    `  paused:            ${paused ? "YES (dispatch gated by play)" : "no"}`,
  );
  console.log(`  sticky failures:   ${failRows.length}`);
  console.log(`  dirty repos:       ${dirtyRoots.length}`);
  console.log(
    `  tmux "${sessionName}":  ${sessionState}${sessionState === "missing" ? "  <-- absent: the daemon mints it on next dispatch" : ""}`,
  );

  if (dirtyRoots.length > 0) {
    console.log(
      "\n[warn] dirty target repos block dispatch (readiness predicate 6.5):",
    );
    for (const r of dirtyRoots) {
      console.log(
        `         ${seg(r.project_dir)}  (dirty_count=${seg(r.dirty_count)})`,
      );
    }
  }
  if (sessionState === "missing") {
    console.log(
      `\n[warn] tmux session "${sessionName}" is absent — the daemon's exec-backend`,
    );
    console.log(
      "         mints it on the next dispatch (new-session -d), so this usually",
    );
    console.log(
      `         self-heals; if launches keep failing, inspect it: tmux has-session -t =${sessionName}`,
    );
  }

  if (failRows.length === 0) {
    console.log("\nNo sticky dispatch_failures — nothing to clear.");
    if (paused && values.play) {
      await playIfPaused(sock);
    } else if (paused) {
      console.log(
        "(autopilot is paused — pass --play to unpause, or `keeper autopilot play`.)",
      );
    }
    return;
  }

  console.log("\n=== dispatch_failures ===");
  for (const r of failRows) {
    const key = `${seg(r.verb)}::${seg(r.id)}`;
    const ts = Number(r.ts);
    const age = Number.isFinite(ts) ? ` (${ageFrom(ts)} ago)` : "";
    console.log(`  ${key}`);
    console.log(`      dir:    ${seg(r.dir)}`);
    console.log(`      reason: ${seg(r.reason)}${age}`);
  }

  if (!values.apply) {
    console.log(
      `\nDry run — would clear ${failRows.length} failure row(s). Re-run with --apply to clear them.`,
    );
    return;
  }

  // --- apply ----------------------------------------------------------------
  console.log(
    `\nClearing ${failRows.length} failure row(s) via retry_dispatch ...`,
  );
  let cleared = 0;
  let errored = 0;
  for (const r of failRows) {
    const key = `${seg(r.verb)}::${seg(r.id)}`;
    const rpcId = crypto.randomUUID();
    let frame: ServerFrame;
    try {
      frame = await roundTrip(sock, buildRetryFrame(rpcId, key), rpcId);
    } catch (err) {
      errored++;
      console.log(`  ✗ ${key} — ${(err as Error).message}`);
      continue;
    }
    if (frame.type === "rpc_result") {
      cleared++;
      console.log(`  ✓ ${key}`);
    } else if (frame.type === "error") {
      errored++;
      console.log(`  ✗ ${key} — ${frame.code}: ${frame.message}`);
    } else {
      errored++;
      console.log(`  ✗ ${key} — unexpected frame type ${frame.type}`);
    }
  }

  if (paused) {
    if (values.play) {
      await playIfPaused(sock);
    } else {
      console.log(
        "\n[note] autopilot is PAUSED — it will not dispatch until you `keeper autopilot play` (or re-run with --play).",
      );
    }
  }

  console.log(`\n[unstick] done — ${cleared} cleared, ${errored} errored.`);
  if (errored > 0) {
    process.exit(1);
  }
}

/** Send set_autopilot_paused{false} to unpause + kick a reconcile cycle. */
async function playIfPaused(sock: string): Promise<void> {
  const rpcId = crypto.randomUUID();
  let frame: ServerFrame;
  try {
    frame = await roundTrip(sock, buildSetPausedFrame(rpcId, false), rpcId);
  } catch (err) {
    console.log(`\n[warn] --play failed: ${(err as Error).message}`);
    return;
  }
  if (frame.type === "rpc_result") {
    console.log(
      "\n[unstick] autopilot unpaused (set_autopilot_paused{false}).",
    );
  } else if (frame.type === "error") {
    console.log(`\n[warn] --play rejected: ${frame.code}: ${frame.message}`);
  }
}

if (import.meta.main) {
  await main();
}

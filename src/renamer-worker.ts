/**
 * tmux window-renamer worker (epic fn-801). keeperd's eleventh Bun Worker
 * thread, joining the producer / consumer fleet. A PURE EXTERNAL ACTUATOR:
 * it opens its own read-only connection, watches the `jobs` projection
 * (level-triggered on `PRAGMA data_version` via the shared `watchLoop`
 * primitive), and on every change names each tmux WINDOW hosting a live
 * keeper session after that session's job title, regardless of harness. A
 * window hosting several sessions is named after the one in the LOWEST
 * `pane_index`.
 *
 * It reads the projection read-only and writes ONLY to tmux
 * (`rename-window`); it NEVER writes the DB and posts NOTHING to main beyond
 * the lifecycle close/error events the daemon already wires. Human windows
 * get useful tab names for free; autopilot's managed windows (deliberately
 * unnamed today) finally get labels.
 *
 * Each pulse is pure-decision driven:
 *  1. Read `jobs` via the shared {@link runQuery} read seam.
 *  2. Candidate filter: `state IN (working, stopped)` AND
 *     `backend_exec_type === "tmux"` AND non-null `backend_exec_pane_id` AND
 *     non-empty `title`.
 *  3. INPUT-SIDE dedup gate: hash the stable-sorted candidate tuples
 *     (`Bun.hash`, mirroring restore-worker's `hashPairs`). Unchanged since
 *     last pulse → skip entirely. This keeps the constant data_version churn
 *     of active sessions (every hook event bumps it) from spawning tmux dozens
 *     of times per second. Zero candidates → quiescent, no tmux spawn. The
 *     hash gate is LOAD-BEARING, not an optimization.
 *  4. `backend.listPanes()` — `null` (degraded/missing tmux) → skip the cycle.
 *  5. Pure {@link computeRenames}: join candidates to panes by pane id, group
 *     by window id, winner = the candidate on the LOWEST `pane_index` (tie →
 *     lower `job_id`), target
 *     = the winner's title verbatim; emit a rename ONLY where the swept
 *     `windowName !== target`. Every `rename-window` SUPPRESSES
 *     that window's automatic-rename, so a matching name must not re-rename;
 *     the suppression is deliberately left in place (tmux fighting back on
 *     every activity tick is worse than a stale name on a dead window).
 *  6. Fire `renameWindow` per entry; each failure (a TOCTOU window-close
 *     between sweep and rename) is a logged non-fatal skip. The pulse never
 *     throws (try/catch per pulse, "non-fatal" stderr, next pulse retries).
 *
 * Worker contract (see CLAUDE.md "Worker contract"):
 *  - `isMainThread` guard — a plain import is inert.
 *  - Own read-only `openDb` connection (`prepareStmts:false`, `bootRetry:true`).
 *  - Typed message protocol: `{type:"shutdown"}` main→worker ONLY; NO
 *    worker→main message. Exit 0 clean / 1 crash.
 *  - Subsystem-style teardown: the read-only DB connection is closed in the
 *    shutdown path before `process.exit(0)`.
 */

import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { openDb } from "./db";
import {
  createTmuxPaneOps,
  type PaneInfo,
  type TmuxPaneOps,
} from "./exec-backend";
import { runQuery } from "./server-worker";
import type { Job } from "./types";
import { watchLoop } from "./wake-worker";

/**
 * Data the parent passes via `new Worker(url, { workerData })`. Only the DB
 * path crosses the boundary — the read-only connection is opened on the
 * worker thread, not handed across (handles are thread-affine).
 */
export interface RenamerWorkerData {
  dbPath: string;
  /**
   * Poll cadence in ms for the underlying `data_version` watch. Optional;
   * defaults to {@link watchLoop}'s default. Threaded through workerData for
   * parity with the other consumer workers.
   */
  pollMs?: number;
}

/** Message the parent sends to ask the worker to stop. */
export interface ShutdownMessage {
  type: "shutdown";
}

/**
 * One live-job candidate the rename decision keys on: the tmux pane the job
 * runs in and the title the winning job lends its window.
 */
export interface RenameCandidate {
  job_id: string;
  pane_id: string;
  title: string;
}

/** One window rename the decision emits: rename `windowId` (`@N`) to `name`. */
export interface WindowRename {
  windowId: string;
  name: string;
}

/** In-memory pulse state: the last input-hash gate value. `null` before the
 *  first pulse so the boot pulse always runs. */
interface PulseState {
  lastHash: string | null;
}

/**
 * Narrow the `jobs` projection to the windows worth naming: a live
 * (`working` / `stopped`) tmux job carrying both a pane id and a non-empty
 * title. A job missing either can't contribute a window→name mapping. Pure.
 */
export function renameCandidates(jobs: Job[]): RenameCandidate[] {
  const out: RenameCandidate[] = [];
  for (const job of jobs) {
    if (job.state !== "working" && job.state !== "stopped") {
      continue;
    }
    if (job.backend_exec_type !== "tmux") {
      continue;
    }
    if (job.backend_exec_pane_id == null || job.backend_exec_pane_id === "") {
      continue;
    }
    if (job.title == null || job.title === "") {
      continue;
    }
    out.push({
      job_id: job.job_id,
      pane_id: job.backend_exec_pane_id,
      title: job.title,
    });
  }
  return out;
}

/**
 * Stable hash of the candidate set for the INPUT-side dedup gate. Sorts by
 * `(pane_id, job_id)` so SELECT order doesn't churn the hash, then hashes the
 * joined `(pane_id, title, job_id)` tuple. An empty set is the
 * empty-string hash. Mirrors restore-worker's `hashPairs`.
 */
export function hashCandidates(candidates: RenameCandidate[]): string {
  const sorted = [...candidates].sort((a, b) =>
    a.pane_id < b.pane_id
      ? -1
      : a.pane_id > b.pane_id
        ? 1
        : a.job_id < b.job_id
          ? -1
          : a.job_id > b.job_id
            ? 1
            : 0,
  );
  return String(
    Bun.hash(
      sorted.map((c) => `${c.pane_id}\t${c.title}\t${c.job_id}`).join("\n"),
    ),
  );
}

/**
 * Pure rename decision: join candidates to swept panes by pane id, group by
 * window id, pick the winner per window (the candidate on the LOWEST
 * `pane_index` — the stable leftmost/topmost agent names its window; a tie is
 * impossible in a real tmux window, but a lower `job_id` breaks one so a
 * fabricated sweep can't flicker the name every pulse), and emit a
 * `{windowId, name}` ONLY where the
 * sweep's current `windowName` differs from the winner's title. The comparison
 * uses the title verbatim, so a window already wearing it is NOT re-emitted —
 * every `rename-window` permanently suppresses
 * that window's automatic-rename, so re-issuing a no-op rename is pure churn.
 *
 * Returned in ascending `windowId` order for stable test assertions and a
 * deterministic fire order. Pure relative to its inputs.
 */
export function computeRenames(
  candidates: RenameCandidate[],
  panes: PaneInfo[],
): WindowRename[] {
  // pane id → its window's id + current name + the pane's index in it. A pane
  // appears once per sweep.
  const paneToWindow = new Map<
    string,
    { windowId: string; name: string; paneIndex: number }
  >();
  for (const p of panes) {
    paneToWindow.set(p.paneId, {
      windowId: p.windowId,
      name: p.windowName,
      paneIndex: p.paneIndex,
    });
  }

  // window id → its current swept name + the winning candidate so far.
  const winners = new Map<
    string,
    { windowName: string; winner: RenameCandidate; winnerPaneIndex: number }
  >();
  for (const c of candidates) {
    const w = paneToWindow.get(c.pane_id);
    if (w === undefined) {
      continue;
    }
    const cur = winners.get(w.windowId);
    if (cur === undefined) {
      winners.set(w.windowId, {
        windowName: w.name,
        winner: c,
        winnerPaneIndex: w.paneIndex,
      });
      continue;
    }
    // Lowest pane index wins: the leftmost/topmost agent names the window. An
    // index tie can't occur in a real window; the lower job_id keeps a
    // fabricated sweep deterministic.
    const incomingWins =
      w.paneIndex < cur.winnerPaneIndex ||
      (w.paneIndex === cur.winnerPaneIndex && c.job_id < cur.winner.job_id);
    if (incomingWins) {
      winners.set(w.windowId, {
        windowName: cur.windowName,
        winner: c,
        winnerPaneIndex: w.paneIndex,
      });
    }
  }

  const renames: WindowRename[] = [];
  for (const [windowId, { windowName, winner }] of winners) {
    const target = winner.title;
    if (windowName !== target) {
      renames.push({ windowId, name: target });
    }
  }
  renames.sort((a, b) =>
    a.windowId < b.windowId ? -1 : a.windowId > b.windowId ? 1 : 0,
  );
  return renames;
}

/**
 * Drive one renamer pulse against the worker's read-only connection. Reads
 * `jobs` via the `runQuery` read seam, gates on the input-side dedup hash,
 * sweeps tmux panes, computes the owed renames, and fires them. NEVER throws
 * for an expected degradation: a degraded tmux (null sweep) skips the cycle,
 * and a TOCTOU rename failure is a logged non-fatal skip.
 *
 * Exported for unit reach: tests drive this directly against a seeded DB with
 * an injected backend.
 */
export async function renamerPulse(
  db: Parameters<typeof runQuery>[0],
  backend: Pick<TmuxPaneOps, "listPanes" | "renameWindow">,
  state: PulseState,
): Promise<void> {
  const read = (collection: string): Record<string, unknown>[] => {
    const frame = {
      type: "query" as const,
      collection,
      id: `renamer-${collection}`,
      limit: 0,
    };
    const res = runQuery(db, 0, frame);
    return res.type === "result" ? (res.rows as Record<string, unknown>[]) : [];
  };

  const jobs = read("jobs") as unknown as Job[];
  const candidates = renameCandidates(jobs);

  // INPUT-side dedup gate: an unchanged candidate picture skips the tmux sweep
  // entirely. Zero candidates hashes to the empty-string hash, so a quiescent
  // board re-gates once and then stays quiet. Load-bearing — without it the
  // worker would spawn tmux on every data_version bump (constant during active
  // sessions).
  const hash = hashCandidates(candidates);
  if (state.lastHash === hash) {
    return;
  }

  // Zero candidates means nothing to name; advance the gate and stay quiescent
  // (no tmux spawn).
  if (candidates.length === 0) {
    state.lastHash = hash;
    return;
  }

  const panes = await backend.listPanes();
  if (panes === null) {
    // Degraded/missing tmux — skip this cycle WITHOUT advancing the gate so the
    // next pulse retries against the same (still-unhandled) candidate set.
    return;
  }

  const renames = computeRenames(candidates, panes);
  for (const r of renames) {
    const res = await backend.renameWindow(r.windowId, r.name);
    if (!res.ok) {
      // Expected TOCTOU no-op (the window closed between sweep and rename). Log
      // and move on; the next pulse re-evaluates against the live topology.
      console.error(
        `[renamer-worker] rename of ${r.windowId} skipped (non-fatal): ${res.error}`,
      );
    }
  }

  // Advance the gate only after a completed sweep+fire pass, so a degraded
  // sweep above doesn't suppress the retry.
  state.lastHash = hash;
}

/**
 * Worker entrypoint. Opens its own read-only connection, wires the shutdown
 * message, runs an initial pulse (names already-resident sessions at boot),
 * then drives the watch loop until told to stop.
 */
function main(): void {
  if (!parentPort) {
    console.error("[renamer-worker] no parentPort — not running as a Worker");
    process.exit(1);
  }

  const data = workerData as RenamerWorkerData | undefined;
  if (!data || typeof data.dbPath !== "string") {
    console.error("[renamer-worker] missing dbPath in workerData");
    process.exit(1);
  }

  const { db } = openDb(data.dbPath, {
    readonly: true,
    prepareStmts: false,
    bootRetry: true,
  });
  // Session-agnostic pane-ops seam: only listPanes / renameWindow are used.
  // Direct tmux seam (NOT routed through the removed exec-backend abstraction).
  // Warnings route to stderr.
  const backend = createTmuxPaneOps({
    noteLine: (line: string): void => {
      console.error(`[renamer-worker] ${line}`);
    },
  });
  const state: PulseState = { lastHash: null };
  let shutdown = false;

  parentPort.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg && msg.type === "shutdown") {
      shutdown = true;
    }
  });

  const closeDb = (): void => {
    try {
      db.close();
    } catch {
      // best-effort; we're exiting either way
    }
  };

  const pulse = (): void => {
    // Per-pulse try/catch: a projection-read throw or any unexpected error
    // degrades to a logged non-fatal skip rather than escaping the watch loop
    // (which would fatalExit the daemon over a cosmetic side-effect).
    renamerPulse(db, backend, state).catch((err) => {
      console.error(
        `[renamer-worker] pulse threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  };

  // Initial pulse before the watch loop's first sleep so a freshly-spawned
  // worker names already-resident sessions immediately rather than after the
  // first data_version change.
  pulse();

  watchLoop(db, pulse, () => shutdown, data.pollMs)
    .then(() => {
      closeDb();
      process.exit(0);
    })
    .catch((err) => {
      console.error("[renamer-worker] watch loop crashed:", err);
      closeDb();
      process.exit(1);
    });
}

// Only run inside a real Worker; a plain import on the main thread (tests
// driving the pure decision fns / pulse) is inert.
if (!isMainThread) {
  main();
}

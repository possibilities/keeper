/**
 * Exit-watcher worker. Runs as a Bun Worker thread spawned by the daemon.
 * Detects when a tracked Claude Code session process has exited (without
 * polling `kill(pid, 0)`) so the daemon can fold a synthetic `Killed` event
 * into the row. Pairs with the boot-time `seedKilledSweep` (which folds the
 * stale rows already on disk at startup): the boot sweep covers downtime,
 * this worker covers steady state.
 *
 * Worker contract (mirrors wake-worker / server-worker / transcript-worker /
 * plan-worker):
 * - `isMainThread` guard — a plain `import` is inert (tests pull the
 *   diff/watch helpers directly without spawning a real Worker).
 * - Own read-only `openDb` connection (with `applyPragmas`'s busy_timeout) —
 *   never shares main's writable handle.
 * - Typed messages: `{ kind: "exit", ... }` worker→main; `{ type: "shutdown" }`
 *   main→worker.
 * - Supervisor-owned lifecycle. The kernel-fd resource (kqueue/epoll +
 *   pidfds) is owned by the worker thread — it MUST be released in the
 *   worker's own shutdown handler before exit, or terminate() leaks it.
 * - No in-process self-heal — any unrecoverable error exits non-zero; the
 *   daemon's `error`/`close` listeners escalate via `fatalExit` and the
 *   LaunchAgent restarts the daemon.
 *
 * Two cooperating loops inside the worker:
 *
 * - watchLoop (data_version-driven, ~50ms): on every commit by any OTHER
 *   connection, re-query `jobs` for the candidate set (state IN
 *   ('working','stopped'), with NO pid filter), diff against the
 *   locally-tracked set, and call `ExitWatcher.add(pid, jobIdToken)` for each
 *   new PID-BEARING row. An `alreadyDead` result (kqueue ESRCH or the
 *   post-register kill-0 probe) posts an exit message immediately — the
 *   live-exit window between "row appears" and "kernel arms" closes there.
 *   Invariant: the candidate set INCLUDES NULL-pid rows. A NULL-pid row is
 *   unwatchable (the kernel watcher can never arm it); excluding it from the
 *   candidate set strands the session in `stopped` forever. It is reaped on
 *   sight via a PIDLESS exit message (no kernel registration).
 *   Rows leaving the candidate set (state moved to ended/killed, or pid
 *   cleared) are dropped from the local set; the kqueue/epoll registration is
 *   `EV_ONESHOT`/`EPOLLONESHOT` so we never need to issue EV_DELETE.
 *
 * - waitLoop (kernel-blocking, ~1s timeout slices): drives
 *   `ExitWatcher.wait()` until either a tracked pid exits (post an exit
 *   message) or `wake()` interrupts the wait at shutdown. The two loops run
 *   in parallel — the diff loop never blocks waiting for kernel events, and
 *   the wait loop never blocks waiting for a data_version pulse.
 *
 * Worker→main exit messages carry the JOB ID — not just the pid — so main's
 * verifier can look the row up by job_id and the start_time check is a
 * straight-up "did THIS row's pid/start_time match" question. Recycled-pid
 * confusion is impossible because the FFI `udata` token we register with is
 * a job-id slot we own.
 *
 * Re-fold determinism note: producer-side liveness probing lives here and
 * in `seed-sweep.ts`; the reducer NEVER re-probes. The `Killed` event
 * payload is enough to fold byte-identically on a from-scratch re-fold.
 */

import type { Database } from "bun:sqlite";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { openDb } from "./db";
import { createExitWatcher, type ExitWatcher } from "./exit-watcher-ffi";

/** workerData payload — only the DB path and the optional poll cadence. */
export interface ExitWatcherWorkerData {
  dbPath: string;
  /**
   * Poll cadence for the data_version diff loop (ms). Defaults to 50ms to
   * match the wake worker's cadence — the same logic that says "another
   * connection committed" tells us "new pids may have entered the
   * candidate set." Floored at 25ms.
   */
  pollMs?: number;
}

/**
 * Worker → main exit message. `jobId` is the session id (the token we
 * registered with the FFI layer); `pid` and `startTime` ride along so main
 * can verify the row's persisted identity matches before emitting `Killed`.
 * `startTime` is the SNAPSHOT we captured at register time (NULL when the
 * jobs row had none), NOT a re-read at exit time.
 */
export interface ExitMessage {
  kind: "exit";
  jobId: string;
  /**
   * The exited process pid, OR `null` for a PIDLESS REAP of a
   * `stopped`/`working` row whose persisted pid is NULL — an unwatchable row
   * the kernel watcher can never arm. The diff loop posts the pidless variant
   * the instant it sees such a row (no kernel registration); main's verifier
   * folds a pidless `Killed` against the NULL-pid row. A pidless message
   * carries NO liveness claim — a NULL-pid row is terminal by construction.
   */
  pid: number | null;
  startTime: string | null;
}

/** Main → worker shutdown command (same shape as the other workers). */
export interface ShutdownMessage {
  type: "shutdown";
}

const DEFAULT_POLL_MS = 50;
const MIN_POLL_MS = 25;
/**
 * Wait-loop timeout slice in ms. `ExitWatcher.wait()` already slices its
 * internal kevent/epoll_wait so JS messages are processed promptly; we just
 * need a small ceiling so a shutdown that arrives between FFI slices still
 * unblocks within ~1s without relying on a wake() race.
 */
const WAIT_TIMEOUT_MS = 1000;

/** Internal tracked-pid entry. udata = the i64 token we registered with. */
interface TrackedEntry {
  pid: number;
  startTime: string | null;
  udata: bigint;
}

interface CandidateRow {
  job_id: string;
  /** NULL for the pidless-reap rows (unwatchable, reaped on sight). */
  pid: number | null;
  start_time: string | null;
}

interface DataVersionRow {
  data_version: number;
}

/**
 * Encode a job_id as a stable bigint token for the FFI udata slot. Token
 * uniqueness is per-worker (we never re-use a token mid-process), so a
 * monotonically increasing counter is fine — the worker uses it ONLY to
 * look the entry up in a local map on exit delivery. The job id lives in
 * the map, not in the kernel.
 *
 * Why not encode the job_id bytes into the bigint: job ids are arbitrary
 * strings (session ids, anywhere up to 36+ chars), so they don't fit in 8
 * bytes. Indirecting through the local map is simpler and just as fast.
 */
function nextToken(prev: bigint): bigint {
  return prev + 1n;
}

/**
 * Run the diff loop against an already-open RO connection and an already-
 * constructed `ExitWatcher`. Exported so tests can drive the loop directly
 * with a mock ExitWatcher and a real two-connection DB.
 *
 * Each `data_version` tick re-queries the candidate set and calls
 * `onAdded(pid, jobId, startTime, udata)` for each NEW row and
 * `onRemoved(udata)` for each row that left the set. The caller wires those
 * to `ExitWatcher.add` + the local tracking map.
 *
 * Polls `PRAGMA data_version` every `pollMs` (naked autocommit reads — no
 * BEGIN, or the counter freezes on this connection). Resolves once
 * `isShutdown()` returns true.
 */
export async function diffLoop(
  db: Database,
  onTick: (rows: CandidateRow[]) => void,
  isShutdown: () => boolean,
  pollMs: number = DEFAULT_POLL_MS,
): Promise<void> {
  const interval = Math.max(MIN_POLL_MS, pollMs);
  const versionQuery = db.query("PRAGMA data_version");
  // Invariant: the candidate set INCLUDES NULL-pid rows (no `pid IS NOT NULL`
  // filter). A NULL-pid row is never watched and never folds to terminal on
  // its own, so excluding it strands the session in `stopped` forever. We
  // surface it here and `diffTick` reaps it on sight via a pidless exit
  // message (no kernel registration — there's no pid to arm). Watchable
  // (pid-bearing) rows arm the kernel watcher.
  const candidatesQuery = db.query(
    `SELECT job_id, pid, start_time FROM jobs
       WHERE state IN ('working','stopped')`,
  );

  // Run one initial sweep so rows already present at boot enter the watch
  // set without waiting for a subsequent commit. The pre-spawn drain has
  // already folded everything visible on disk, so this is the snapshot the
  // FIRST set-diff should compute against.
  onTick(candidatesQuery.all() as CandidateRow[]);

  let last = (versionQuery.get() as DataVersionRow).data_version;
  while (!isShutdown()) {
    await Bun.sleep(interval);
    if (isShutdown()) {
      break;
    }
    const cur = (versionQuery.get() as DataVersionRow).data_version;
    if (cur !== last) {
      last = cur;
      onTick(candidatesQuery.all() as CandidateRow[]);
    }
  }
}

/**
 * Worker entrypoint. Opens its own read-only connection, constructs the FFI
 * ExitWatcher, and runs the diff and wait loops in parallel until told to
 * stop. Any unrecoverable error exits non-zero so the daemon's `error` /
 * `close` listeners escalate via `fatalExit`.
 */
function main(): void {
  if (!parentPort) {
    console.error("[exit-watcher] no parentPort — not running as a Worker");
    process.exit(1);
  }

  const data = workerData as ExitWatcherWorkerData | undefined;
  if (!data || typeof data.dbPath !== "string") {
    console.error("[exit-watcher] missing dbPath in workerData");
    process.exit(1);
  }

  const { db } = openDb(data.dbPath, {
    readonly: true,
    prepareStmts: false,
    bootRetry: true,
  });

  let watcher: ExitWatcher;
  try {
    watcher = createExitWatcher();
  } catch (err) {
    console.error("[exit-watcher] createExitWatcher failed:", err);
    db.close();
    process.exit(1);
  }

  let shutdown = false;

  // job_id → tracked entry. We register one pid per job_id; if a row's pid
  // changes (resume re-opens with a new process), we treat the old entry as
  // gone (drop) and the new entry as fresh (add). The kqueue registration
  // is EV_ONESHOT and pidfd is EPOLLONESHOT, so a stale registration auto-
  // deletes on exit; an in-flight delivery for a dropped entry is filtered
  // by the tracked-token lookup below (no entry → ignore).
  const tracked = new Map<string, TrackedEntry>();
  // udata → job_id reverse index, so an FFI exit event resolves back to
  // its row in O(1). udata tokens are unique per-process (monotonic
  // counter), so the index is unambiguous even across resumes.
  const byToken = new Map<bigint, string>();
  let nextUdata = 1n;
  // fn-743: job_ids we've already posted a PIDLESS reap for. A NULL-pid row
  // lingers in the candidate set for several ticks until main's synthetic
  // Killed folds and flips it to `killed` (leaving the set), so we dedupe the
  // pidless `Killed` emission here — emit once per appearance, drop the mark
  // when the row leaves the candidate set so a (theoretical) resurrected
  // NULL-pid row would be reaped afresh.
  const pidlessReaped = new Set<string>();

  function postExit(entry: TrackedEntry, jobId: string): void {
    parentPort?.postMessage({
      kind: "exit",
      jobId,
      pid: entry.pid,
      startTime: entry.startTime,
    } satisfies ExitMessage);
    tracked.delete(jobId);
    byToken.delete(entry.udata);
  }

  function diffTick(rows: CandidateRow[]): void {
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.job_id);
      // fn-743: NULL-pid row — nothing to arm in the kernel. Reap on sight via
      // a pidless exit message (deduped so we emit one Killed per appearance,
      // not one per tick while the fold catches up). It never enters `tracked`
      // (no pid/udata), so the candidate-set drop loop below ignores it; the
      // `pidlessReaped` mark is cleared there instead.
      if (row.pid == null) {
        if (!pidlessReaped.has(row.job_id)) {
          pidlessReaped.add(row.job_id);
          parentPort?.postMessage({
            kind: "exit",
            jobId: row.job_id,
            pid: null,
            startTime: row.start_time,
          } satisfies ExitMessage);
        }
        continue;
      }
      const existing = tracked.get(row.job_id);
      if (existing) {
        // Same job, but a new pid means the row was resumed (SessionStart
        // re-arrived with a fresh process). Drop the old entry; the new
        // pid registers below. Same pid + same start_time → already
        // tracked, no-op.
        if (existing.pid === row.pid && existing.startTime === row.start_time) {
          continue;
        }
        byToken.delete(existing.udata);
        tracked.delete(row.job_id);
      }
      const token = nextUdata;
      nextUdata = nextToken(nextUdata);
      const entry: TrackedEntry = {
        pid: row.pid,
        startTime: row.start_time,
        udata: token,
      };
      // Register with the kernel. An `alreadyDead` result short-circuits to
      // an immediate exit message — the seed sweep + this diff cover boot,
      // and this branch covers the live race between "row visible to us"
      // and "kernel arms" (a process that exited in the few µs between).
      let res: ReturnType<ExitWatcher["add"]>;
      try {
        res = watcher.add(row.pid, token);
      } catch (err) {
        // A single bad registration must not wedge the worker (the row's
        // pid may have been a transient bad value). Log and skip; the diff
        // loop will retry on the next data_version pulse if it's still in
        // the candidate set.
        console.error(
          `[exit-watcher] add(pid=${row.pid}, job=${row.job_id}) failed:`,
          err,
        );
        continue;
      }
      tracked.set(row.job_id, entry);
      byToken.set(token, row.job_id);
      if ("alreadyDead" in res) {
        postExit(entry, row.job_id);
      }
    }
    // Drop entries whose row left the candidate set (state moved to
    // ended/killed, or pid cleared). The kernel registration is one-shot,
    // so no EV_DELETE is required; we just stop caring about its exit
    // delivery via the byToken filter on the wait loop.
    if (tracked.size > seen.size) {
      for (const [jobId, entry] of tracked) {
        if (!seen.has(jobId)) {
          byToken.delete(entry.udata);
          tracked.delete(jobId);
        }
      }
    }
    // fn-743: drop pidless-reap marks whose row left the candidate set (the
    // synthetic Killed folded → row now `killed`, or it gained a pid on
    // resume). A future re-appearance is then reaped afresh.
    if (pidlessReaped.size > 0) {
      for (const jobId of pidlessReaped) {
        if (!seen.has(jobId)) {
          pidlessReaped.delete(jobId);
        }
      }
    }
  }

  // Shutdown wiring. Setting the flag is enough for both loops to unwind:
  // the diff loop checks it each tick; the wait loop receives a wake()
  // (which `ExitWatcher.wait()` translates to a `{ kind: "wakeup" }`
  // result) and the next-iteration check exits the loop. Closing the
  // watcher first ensures any in-flight FFI wait completes immediately.
  parentPort.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg && msg.type === "shutdown") {
      shutdown = true;
      // Best-effort: nudge a blocked wait() to return early so the wait
      // loop unblocks within microseconds rather than ~SLICE_MS.
      try {
        watcher.wake();
      } catch {
        // wake() is contracted not to throw on normal use; ignore any
        // exotic failure (closed watcher races) so shutdown is robust.
      }
    }
  });

  function closeAll(): void {
    try {
      watcher.close();
    } catch {
      // best-effort; we're exiting either way
    }
    try {
      db.close();
    } catch {
      // best-effort
    }
  }

  // Wait loop. Drives `watcher.wait()` in ~1s slices. On `exit`, look the
  // token up in byToken — a stale event (entry was dropped because the row
  // left the candidate set) is silently discarded. On `timeout` or
  // `wakeup`, loop and re-check `shutdown`.
  async function waitLoop(): Promise<void> {
    while (!shutdown) {
      let res: Awaited<ReturnType<ExitWatcher["wait"]>>;
      try {
        res = await watcher.wait(WAIT_TIMEOUT_MS);
      } catch (err) {
        // A wait() throw is fatal — the FFI/kernel state is unrecoverable.
        // Exit non-zero so the daemon's close listener escalates.
        console.error("[exit-watcher] wait() failed:", err);
        throw err;
      }
      if (res.kind === "exit") {
        const jobId = byToken.get(res.udata);
        if (jobId) {
          const entry = tracked.get(jobId);
          if (entry) {
            postExit(entry, jobId);
          }
        }
        // Stale token (row left the candidate set before the kernel
        // delivered the exit) silently falls through; the loop re-checks
        // shutdown and proceeds to the next slice.
      }
      // timeout / wakeup / handled exit — loop and re-check shutdown.
    }
  }

  // Diff loop. The first onTick fires synchronously inside diffLoop, so
  // rows already on disk at boot enter the watch set immediately.
  const diff = diffLoop(db, diffTick, () => shutdown, data.pollMs).catch(
    (err) => {
      console.error("[exit-watcher] diff loop crashed:", err);
      throw err;
    },
  );
  const wait = waitLoop();

  // Both loops must complete before we close the DB + FFI handle. If
  // either throws, we treat the whole worker as fatal: close everything
  // and exit non-zero so the daemon escalates.
  Promise.all([diff, wait])
    .then(() => {
      closeAll();
      process.exit(0);
    })
    .catch((err) => {
      console.error("[exit-watcher] fatal:", err);
      closeAll();
      process.exit(1);
    });
}

// Only boot when actually inside a Worker — a plain `import` from a test
// runs on the main thread where `main()` must not fire. Mirrors the
// `isMainThread` guard on the other workers.
if (!isMainThread) {
  main();
}

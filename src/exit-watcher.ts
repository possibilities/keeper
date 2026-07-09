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
import { type BackstopMessage, buildTimeoutRecord } from "./backstop-telemetry";
import { openDb } from "./db";
import { parsePlanRef } from "./derivers";
import { createExitWatcher, type ExitWatcher } from "./exit-watcher-ffi";
import { NotadbTolerance } from "./notadb-tolerance";
import { readOsStartTime } from "./seed-sweep";
import { isPidAlive } from "./server-worker";
import { findFreshInFlightSubagentAnchor } from "./subagent-invocations";

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

/**
 * Worker → main stuck-state-sentinel message (ADR 0013 layer 3). Posted by the
 * {@link sentinelLoop} when a `working` row is a proven idle contradiction. Main
 * mints the corrective `StopReconciled` quiescence event (when `heal`) AND the
 * sticky `stuck-sentinel` anomaly `dispatch_failures` row — both are producer
 * decisions the worker already change-gated, so main just executes the mint. The
 * `reason` is CLASS-stable (never a live age) so the change-gate does not re-fire
 * every tick; `tsSec` is the producer-stamped wall clock for re-fold determinism.
 */
export interface StuckSentinelMessage {
  kind: "stuck-sentinel";
  /** The stuck session id (== `jobs.job_id` / `events.session_id`). */
  jobId: string;
  /** The class-stable anomaly reason (starts with `stuck-sentinel`). */
  reason: string;
  /** Producer-stamped wall-clock seconds — the corrective event + row ts. */
  tsSec: number;
  /** True for a TIER-ONE self-heal (mint `StopReconciled`); false for a TIER-TWO
   *  detect-only anomaly (visibility row ONLY, state untouched). */
  heal: boolean;
}

/**
 * Every shape the exit-watcher posts to main: the exit reap message, the
 * stuck-state-sentinel anomaly/heal message, plus the backstop-telemetry channel
 * (a `notadb-skip` record when `diffLoop`'s `PRAGMA data_version` poll tolerates a
 * transient `SQLITE_NOTADB`). `main` routes `{kind:"backstop"}` to the
 * sole sidecar writer, `{kind:"stuck-sentinel"}` to the sentinel mint, and
 * everything else to the exit-reap verifier.
 */
export type ExitWatcherOutbound =
  | ExitMessage
  | BackstopMessage
  | StuckSentinelMessage;

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
/**
 * Periodic dead-pid re-probe cadence (ms). The kernel arm (kqueue
 * `EV_ONESHOT` / pidfd `EPOLLONESHOT`) occasionally misses or races, and the
 * boot `seedKilledSweep` runs once per boot — so a non-terminal row whose pid
 * is verifiably dead can sit forever in steady state. This slow sweep is the
 * backstop: re-probe liveness and mint a synthetic `Killed` for confirmed
 * dead/recycled rows. Slow on purpose — the kernel arm is the fast path; this
 * is the rare-miss safety net, so a coarse 60s tick keeps the syscall + `ps`
 * cost negligible.
 */
export const REPROBE_MS = 60_000;
/**
 * Launch-race age gate (seconds). A freshly-launched job whose pid we read
 * before the SessionStart hook's `(pid, start_time)` fully settled must not be
 * reaped — mirror the sitter's `STUCK_JOB_MIN_AGE_SECS` (5 min). The gate keys
 * on `created_at` (NOT `updated_at`, which late git-count/title/monitor writes
 * reset on a stopped row); the dead-pid conjunct carries correctness, the age
 * gate only suppresses the launch-race false positive.
 */
export const REPROBE_MIN_AGE_SECS = 5 * 60;

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
 *
 * fn-1096.3: a transient SQLITE_NOTADB on the `data_version` read is a
 * boot-checkpoint view race, not corruption — tolerated via the shared
 * `NotadbTolerance` helper (skip this tick, bounded consecutive-miss
 * rethrow) rather than letting it crash the worker. `onNotadbSkip` — when
 * given — is invoked with the running consecutive-miss count on every
 * tolerated skip so the caller can post countable backstop telemetry;
 * omitted in the existing direct-loop tests (a skip there just re-attempts
 * next tick, same as production).
 */
export async function diffLoop(
  db: Database,
  onTick: (rows: CandidateRow[]) => void,
  isShutdown: () => boolean,
  pollMs: number = DEFAULT_POLL_MS,
  onNotadbSkip?: (consecutiveMisses: number) => void,
): Promise<void> {
  const interval = Math.max(MIN_POLL_MS, pollMs);
  const versionQuery = db.query("PRAGMA data_version");
  const tolerance = new NotadbTolerance();
  const readVersion = (): number | null => {
    const outcome = tolerance.poll(
      () => (versionQuery.get() as DataVersionRow).data_version,
    );
    if (outcome.skipped) {
      onNotadbSkip?.(outcome.consecutiveMisses);
      return null;
    }
    return outcome.value;
  };
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

  // A tolerated NOTADB on this VERY FIRST read (the boot-checkpoint race is
  // most likely right here) seeds a `null` baseline — the loop below treats
  // `last === null` as "unknown, always re-diff on the next successful
  // read," never a false suppression.
  let last: number | null = readVersion();
  while (!isShutdown()) {
    await Bun.sleep(interval);
    if (isShutdown()) {
      break;
    }
    const cur = readVersion();
    if (cur === null) {
      continue;
    }
    if (cur !== last) {
      last = cur;
      onTick(candidatesQuery.all() as CandidateRow[]);
    }
  }
}

// ---------------------------------------------------------------------------
// Periodic dead-pid re-probe (the kernel-arm-miss backstop)
// ---------------------------------------------------------------------------

/** One candidate row for the re-probe predicate (age gate keys on `created_at`). */
export interface ReprobeRow {
  job_id: string;
  /** NULL rows are out of scope here — the diff loop's pidless arm reaps them. */
  pid: number | null;
  start_time: string | null;
  /** Unix seconds. The launch-race age gate keys on this, NOT `updated_at`. */
  created_at: number;
}

/** A confirmed dead/recycled row plus why — carried into the stderr reap log. */
export interface ReprobeCandidate {
  jobId: string;
  pid: number;
  /** The STORED start_time (what the fold matches), NOT the live recycler's. */
  startTime: string | null;
  reason: "dead" | "recycled";
}

/**
 * Pure predicate: from the candidate rows, the wall-clock `nowSecs`, and two
 * injected probes, return the rows whose pid is verifiably dead or recycled and
 * which are old enough to reap. Pure (no I/O of its own — the probes are
 * injected) so tests drive it clause-by-clause.
 *
 * Mirrors `seedKilledSweep`'s Q7 conservatism, plus the launch-race age gate:
 * - `created_at` younger than `REPROBE_MIN_AGE_SECS` → leave alone (a fresh row
 *   whose pid we may have read before SessionStart settled). The gate is `>=`:
 *   age EQUAL to the threshold is eligible.
 * - NULL pid → out of scope (the diff loop's pidless arm owns those rows).
 * - pid DEAD (`isAlive` false) → `reason: "dead"`, regardless of start_time.
 * - pid ALIVE, stored start_time present, `readStartTime` returns non-null AND
 *   differs → `reason: "recycled"` (pid reused by a different process).
 * - pid ALIVE, stored start_time NULL → leave alone (can't prove recycle from a
 *   bare pid on macOS's small pid space).
 * - pid ALIVE, `readStartTime` returns null (probe failed) → leave alone
 *   (can't distinguish recycled from same-process — conservative).
 * - pid ALIVE, start_time matches → leave alone (same process, still running).
 *
 * `readStartTime` is consulted ONLY for an alive pid with a stored start_time —
 * the dead path never forks `ps`.
 */
export function selectDeadReprobeCandidates(
  rows: ReprobeRow[],
  nowSecs: number,
  isAlive: (pid: number) => boolean,
  readStartTime: (pid: number) => string | null,
): ReprobeCandidate[] {
  const out: ReprobeCandidate[] = [];
  for (const row of rows) {
    if (row.pid == null) {
      continue; // pidless rows are the diff loop's job, not ours.
    }
    if (nowSecs - row.created_at < REPROBE_MIN_AGE_SECS) {
      continue; // launch-race age gate — too fresh to reap.
    }
    if (!isAlive(row.pid)) {
      out.push({
        jobId: row.job_id,
        pid: row.pid,
        startTime: row.start_time,
        reason: "dead",
      });
      continue;
    }
    if (row.start_time == null) {
      continue; // alive, no stored start_time → can't prove recycle.
    }
    const osStart = readStartTime(row.pid);
    if (osStart == null) {
      continue; // probe failed → conservative leave-alone.
    }
    if (osStart === row.start_time) {
      continue; // same process, still alive.
    }
    out.push({
      jobId: row.job_id,
      pid: row.pid,
      startTime: row.start_time,
      reason: "recycled",
    });
  }
  return out;
}

/**
 * Run the periodic re-probe sweep against an already-open RO connection. On a
 * slow (`REPROBE_MS`) tick, query the candidate set, run the pure predicate,
 * and post the SAME `ExitMessage` shape the kernel arm posts for each confirmed
 * dead/recycled row — main's existing onmessage handler (re-read, terminal
 * guard, `(pid,start_time)` match, `insertEvent` + `pumpWakes`) mints the
 * synthetic `Killed` unchanged. We never write the DB, never signal, never
 * mint events here — message-to-main keeps the column list in one place.
 *
 * Exported so tests can drive the loop directly with injected probes and a
 * real DB. Resolves once `isShutdown()` returns true.
 */
export async function reprobeLoop(
  db: Database,
  post: (msg: ExitMessage) => void,
  isShutdown: () => boolean,
  opts: {
    intervalMs?: number;
    nowSecs?: () => number;
    isAlive?: (pid: number) => boolean;
    readStartTime?: (pid: number) => string | null;
  } = {},
): Promise<void> {
  const interval = opts.intervalMs ?? REPROBE_MS;
  const nowSecs = opts.nowSecs ?? (() => Date.now() / 1000);
  const isAlive = opts.isAlive ?? isPidAlive;
  const readStartTime = opts.readStartTime ?? readOsStartTime;
  // Same candidate scope as the diff loop, plus `created_at` for the age gate.
  // The pidless arm of the diff loop handles NULL-pid rows; we filter to
  // pid-bearing rows here (the predicate also skips NULL pids defensively).
  const candidatesQuery = db.query(
    `SELECT job_id, pid, start_time, created_at FROM jobs
       WHERE state IN ('working','stopped') AND pid IS NOT NULL`,
  );

  while (!isShutdown()) {
    // Sleep FIRST: the diff loop's boot tick + seed sweep already covered the
    // rows present at spawn, so there's nothing for an immediate re-probe to
    // catch that they didn't. Wake periodically to re-check shutdown so a
    // shutdown mid-interval unblocks within one slice, not one full REPROBE_MS.
    const slice = Math.min(interval, WAIT_TIMEOUT_MS);
    let waited = 0;
    while (waited < interval && !isShutdown()) {
      await Bun.sleep(slice);
      waited += slice;
    }
    if (isShutdown()) {
      break;
    }
    let rows: ReprobeRow[];
    try {
      rows = candidatesQuery.all() as ReprobeRow[];
    } catch (err) {
      // A bad query (transient read race) must not wedge the sweep — log and
      // retry on the next tick.
      console.error("[exit-watcher] re-probe query failed:", err);
      continue;
    }
    for (const row of rows) {
      // Per-row try/catch: one bad probe (ps glitch, kill races) never aborts
      // the sweep. Run the predicate one row at a time so a throw is isolated.
      let cands: ReprobeCandidate[];
      try {
        cands = selectDeadReprobeCandidates(
          [row],
          nowSecs(),
          isAlive,
          readStartTime,
        );
      } catch (err) {
        console.error(
          `[exit-watcher] re-probe failed for job_id=${row.job_id} pid=${row.pid}:`,
          err,
        );
        continue;
      }
      for (const c of cands) {
        // Reaps are rare and forensic — one stderr line per reap with the full
        // identity tuple. Main's verifier may still skip the mint (a resume
        // between this probe and the fold flips the `(pid,start_time)` match),
        // so this logs the PRODUCER's intent, not a guaranteed terminalization.
        console.error(
          `[exit-watcher] re-probe reap job_id=${c.jobId} pid=${c.pid} start_time=${c.startTime} reason=${c.reason}`,
        );
        post({
          kind: "exit",
          jobId: c.jobId,
          pid: c.pid,
          startTime: c.startTime,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Stuck-state sentinel (ADR 0013 layer 3) — the producer-side sweep that makes
// the "board says working, session is demonstrably idle" contradiction LOUD.
// ---------------------------------------------------------------------------

/**
 * Sweep cadence (ms). Coarse like the re-probe backstop — the contradiction it
 * catches is a permanent stuck state, not a live race, so a 60s tick catches a
 * row within a minute of crossing its staleness threshold while keeping the
 * per-tick DB + `ps` cost negligible.
 */
export const STUCK_SENTINEL_MS = 60_000;

/**
 * TIER ONE (self-heal) minimum event staleness (seconds). A plan job whose task
 * is worker-done while the row still reads `working`, with events at least this
 * stale, a live pid, and no fresh in-flight subagent, is a logical contradiction
 * healed to `stopped`. Conservative by design (the risk note): a real resume
 * within the window keeps events fresh and never trips this.
 */
export const STUCK_TIER1_MIN_AGE_SECS = 10 * 60;

/**
 * TIER TWO (detect-only) minimum event staleness (seconds). ANY `working` row
 * with a live pid this stale mints visibility only — never a correction — so a
 * non-plan free-form job with no worker-done signal is still surfaced.
 */
export const STUCK_TIER2_MIN_AGE_SECS = 60 * 60;

/**
 * Bounded still-stuck re-emit interval (ms). After a first-detect (or a
 * reason-change), the change-gate suppresses re-emits for this long so a
 * persistent condition mints O(1) events, not one per poll tick — then re-emits
 * once so a long-lived stuck state stays fresh. Mirrors the DispatchFailed
 * producer's change-gate precedent.
 */
export const STUCK_SENTINEL_REEMIT_MS = 30 * 60_000;

/**
 * Implausible-skew epsilon (seconds). Legitimate host clock drift is seconds; an
 * event whose `ts` — or the row's lifecycle stamp — sits more than this far in
 * the FUTURE of the sweep's wall clock is implausible event-clock skew, noted on
 * the anomaly reason (the ADR's "flag skew instead of clamping ingest ts").
 */
export const STUCK_SENTINEL_SKEW_EPSILON_SECS = 5 * 60;

/**
 * Fresh-subagent freshness bound (seconds). Mirrors the reducer's
 * `MAX_STOP_YIELD_GAP_SEC`: a parent that dispatched a Task tool yields to a
 * sub-agent sharing its session id, so a fresh in-flight sub means the session is
 * conceptually still working — tier one excludes it. Consulted producer-side via
 * {@link findFreshInFlightSubagentAnchor} against the sweep's wall clock.
 */
export const STUCK_SENTINEL_SUBAGENT_GAP_SEC = 120;

/**
 * One `working` candidate row with every signal the pure predicate needs already
 * RESOLVED off the DB (worker-done, subagent freshness, staleness) — so the
 * predicate stays pure and tests drive it clause-by-clause with plain values.
 */
export interface SentinelRow {
  jobId: string;
  /** NULL rows are out of scope — the sweep query filters `pid IS NOT NULL`; the
   *  predicate skips NULL defensively (a NULL-pid working row is the exit-watcher
   *  diff loop's pidless-reap job, never this sweep's). */
  pid: number | null;
  /** Freshest `events.ts` for the session (`MAX(ts)`), NULL when it has none. The
   *  staleness anchor: wall clock minus this. */
  lastEventTs: number | null;
  /** The row's lifecycle stamp (`jobs.last_lifecycle_ts`) — the skew probe (a
   *  far-future stamp is the phantom-pinning signature), NULL on a fresh row. */
  lastLifecycleTs: number | null;
  /** Task marked worker-done in the plan projection (NOT a jobs column). Resolved
   *  via the job's `plan_ref` → epic → embedded task `worker_phase === "done"`. */
  workerDone: boolean;
  /** A fresh in-flight subagent survives (tier-one exclusion). */
  hasFreshSubagent: boolean;
  /** `jobs.plan_ref` (raw, not the same discriminator as `workerDone`'s parsed
   *  ref). NULL means the session has no plan linkage — a parked-idle
   *  interactive session, including every adopted identity (adoption paths
   *  never spawn under a plan verb). Tier-two ack-row minting excludes these
   *  (ADR 0013/0024 amendment); tier-one self-heal stays unconditional. */
  planRef: string | null;
  /** The harness-agnostic ADOPTED marker (`jobs.adopted`). A defensive second
   *  signal alongside `planRef == null` — an adopted session is soft
   *  telemetry even in the (unobserved) case it somehow carries a plan_ref. */
  adopted: boolean;
}

/** One sentinel verdict — the stuck row plus what to do about it. */
export interface StuckSentinelVerdict {
  jobId: string;
  /** 1 = self-heal contradiction; 2 = detect-only. */
  tier: 1 | 2;
  /** True ONLY for tier one — mint the corrective `StopReconciled`. */
  heal: boolean;
  /** Class-stable anomaly reason (starts with `stuck-sentinel`). */
  reason: string;
}

/**
 * Build the class-stable anomaly reason. NEVER embeds a live age (which would
 * defeat the reason-change change-gate); a newly-observed clock skew flips the
 * class so it re-surfaces exactly once. Pure.
 */
export function sentinelReason(
  cls: "worker-done-while-working" | "stale-working" | "clock-skew",
  clockSkew: boolean,
): string {
  const base = `stuck-sentinel: ${cls}`;
  return clockSkew && cls !== "clock-skew" ? `${base} (clock-skew)` : base;
}

/**
 * Pure two-tier predicate: from the resolved candidate rows, the wall-clock
 * `nowSecs`, and the injected liveness probe, return one verdict per stuck row.
 * Pure (no I/O — every DB read is resolved into the row upstream) so tests drive
 * it clause-by-clause. Wall-clock never enters the fold: this is producer-side.
 *
 *   - NULL pid → skip (the diff loop's pidless-reap job).
 *   - pid DEAD (`isAlive` false) → skip: a dead pid is the exit-watcher's reap,
 *     keeping the two producers DISJOINT (tier one requires a LIVE pid).
 *   - NULL `lastEventTs` → skip (staleness uncomputable).
 *   - TIER ONE (heal): `workerDone` AND NOT `hasFreshSubagent` AND event age
 *     `>= STUCK_TIER1_MIN_AGE_SECS`. The worker-done contradiction + the
 *     fresh-subagent exclusion + the conservative min-age keep a live session
 *     safe (a real resume re-activates under the stamp gate).
 *   - TIER TWO (detect-only): event age `>= STUCK_TIER2_MIN_AGE_SECS`, regardless
 *     of `workerDone` — the universal net for free-form jobs. EXCLUDES a session
 *     with no plan linkage (`planRef == null`, including every adopted
 *     identity): a parked-idle interactive session is soft telemetry — the
 *     working/idle contradiction stays observable on jobs/board, but mints no
 *     needs-human ack-row (ADR 0013/0024 amendment). Plan-linked worker
 *     sessions keep full tier-two coverage.
 *   - CLOCK SKEW with no staleness trip → a detect-only skew anomaly, so an
 *     implausibly-future event/stamp is never silently swallowed. NOT carved
 *     out by the interactive-session exclusion — it flags a different signal
 *     (implausible event clock), not a stale-working contradiction.
 *
 * Skew is computed from BOTH the last event ts and the lifecycle stamp being
 * implausibly ahead of `nowSecs`; it ANNOTATES a firing tier's reason and stands
 * alone as its own detect when nothing else trips.
 */
export function selectStuckSentinelVerdicts(
  rows: SentinelRow[],
  nowSecs: number,
  isAlive: (pid: number) => boolean,
): StuckSentinelVerdict[] {
  const out: StuckSentinelVerdict[] = [];
  for (const row of rows) {
    if (row.pid == null) {
      continue; // pidless rows are the diff loop's job, not ours.
    }
    if (!isAlive(row.pid)) {
      continue; // dead pid → exit-watcher's reap; keep the producers disjoint.
    }
    if (row.lastEventTs == null) {
      continue; // no events → staleness uncomputable.
    }
    const ageSecs = nowSecs - row.lastEventTs;
    const clockSkew =
      row.lastEventTs > nowSecs + STUCK_SENTINEL_SKEW_EPSILON_SECS ||
      (row.lastLifecycleTs != null &&
        row.lastLifecycleTs > nowSecs + STUCK_SENTINEL_SKEW_EPSILON_SECS);
    if (
      row.workerDone &&
      !row.hasFreshSubagent &&
      ageSecs >= STUCK_TIER1_MIN_AGE_SECS
    ) {
      out.push({
        jobId: row.jobId,
        tier: 1,
        heal: true,
        reason: sentinelReason("worker-done-while-working", clockSkew),
      });
      continue;
    }
    if (ageSecs >= STUCK_TIER2_MIN_AGE_SECS) {
      // Interactive/adopted sessions (no plan linkage) are soft telemetry —
      // no tier-two ack-row, but they still fall through to the clock-skew
      // detect below when applicable.
      if (row.planRef != null && !row.adopted) {
        out.push({
          jobId: row.jobId,
          tier: 2,
          heal: false,
          reason: sentinelReason("stale-working", clockSkew),
        });
      }
      continue;
    }
    if (clockSkew) {
      out.push({
        jobId: row.jobId,
        tier: 2,
        heal: false,
        reason: sentinelReason("clock-skew", true),
      });
    }
  }
  return out;
}

/** Prior emit state for one session's change-gate memo. */
export interface SentinelMemoEntry {
  reason: string;
  lastEmitMs: number;
}

/**
 * The change-gate decision: emit iff first appearance, reason-change, or the
 * bounded still-stuck re-emit interval elapsed. Pure over the passed prior state;
 * the loop owns the memo map. Mirrors the DispatchFailed producer's O(1)-per-
 * condition change-gate so a persistent stuck state never emits every poll tick.
 */
export function shouldEmitSentinel(
  prev: SentinelMemoEntry | undefined,
  reason: string,
  nowMs: number,
  reemitMs: number,
): boolean {
  if (prev === undefined) {
    return true; // first appearance.
  }
  if (prev.reason !== reason) {
    return true; // reason-change (e.g. skew newly observed).
  }
  return nowMs - prev.lastEmitMs >= reemitMs; // bounded still-stuck re-emit.
}

/**
 * Resolve the freshest `events.ts` for a session (`MAX(ts)`) — the staleness
 * anchor, NULL when the session has no events. Indexed by `idx_events_session`.
 */
function resolveLastEventTs(db: Database, jobId: string): number | null {
  const row = db
    .query("SELECT MAX(ts) AS ts FROM events WHERE session_id = ?")
    .get(jobId) as { ts: number | null } | null;
  return row?.ts ?? null;
}

/**
 * Resolve worker-done-ness for a plan `work` job by reading the plan projection
 * (worker-done is NOT a jobs column): the job's `plan_ref` → its epic's embedded
 * `tasks` JSON → the matching task's `worker_phase === "done"`. A non-plan /
 * non-task ref, a missing epic, a malformed blob, or an absent task all fold to
 * `false` (never worker-done, so tier one never fires on them). NEVER throws.
 */
function resolveWorkerDone(
  db: Database,
  planVerb: string | null,
  planRef: string | null,
): boolean {
  if (planVerb == null || planRef == null) {
    return false;
  }
  const parsed = parsePlanRef(planRef);
  if (parsed == null || parsed.kind !== "task") {
    return false;
  }
  try {
    const epicRow = db
      .query("SELECT tasks FROM epics WHERE epic_id = ?")
      .get(parsed.epic_id) as { tasks: string | null } | null;
    if (epicRow?.tasks == null) {
      return false;
    }
    const tasks = JSON.parse(epicRow.tasks) as Array<{
      task_id?: unknown;
      worker_phase?: unknown;
    }>;
    if (!Array.isArray(tasks)) {
      return false;
    }
    for (const t of tasks) {
      if (t.task_id === parsed.task_id) {
        return t.worker_phase === "done";
      }
    }
    return false;
  } catch {
    return false; // malformed embedded tasks JSON → conservatively not-done.
  }
}

/** One candidate row from the sentinel sweep query (`working`, pid-bearing). */
interface SentinelCandidateRow {
  job_id: string;
  pid: number | null;
  plan_verb: string | null;
  plan_ref: string | null;
  last_lifecycle_ts: number | null;
  adopted: number | null;
}

/**
 * Run the periodic stuck-state-sentinel sweep against an already-open RO
 * connection. On each slow (`STUCK_SENTINEL_MS`) tick: query the `working`
 * pid-bearing candidate set, RESOLVE each row's staleness + worker-done +
 * subagent-freshness off the same connection, run the pure predicate, apply the
 * in-memory change-gate, and post one {@link StuckSentinelMessage} per newly
 * emittable verdict. We never write the DB, never signal, never mint events here
 * — message-to-main keeps every write on main's sole writer.
 *
 * The change-gate memo is per-worker in-memory, so a daemon restart re-emits at
 * most once per still-present condition (the fold UPSERTs on the row key, so a
 * re-mint is idempotent). Exported for tests. Resolves once `isShutdown()` is
 * true. NEVER throws — a per-row probe failure logs and the sweep continues.
 */
export async function sentinelLoop(
  db: Database,
  post: (msg: StuckSentinelMessage) => void,
  isShutdown: () => boolean,
  opts: {
    intervalMs?: number;
    reemitMs?: number;
    nowSecs?: () => number;
    isAlive?: (pid: number) => boolean;
  } = {},
): Promise<void> {
  const interval = opts.intervalMs ?? STUCK_SENTINEL_MS;
  const reemitMs = opts.reemitMs ?? STUCK_SENTINEL_REEMIT_MS;
  const nowSecs = opts.nowSecs ?? (() => Date.now() / 1000);
  const isAlive = opts.isAlive ?? isPidAlive;
  const candidatesQuery = db.query(
    `SELECT job_id, pid, plan_verb, plan_ref, last_lifecycle_ts, adopted FROM jobs
       WHERE state = 'working' AND pid IS NOT NULL`,
  );
  // Per-session change-gate memo: jobId → last emitted {reason, lastEmitMs}.
  const memo = new Map<string, SentinelMemoEntry>();

  while (!isShutdown()) {
    // Sleep FIRST (like the re-probe loop): the contradiction is a permanent
    // stuck state, so nothing an immediate sweep catches would be missed one
    // interval later. Wake in slices so a shutdown mid-interval unblocks within
    // one slice, not a full interval.
    const slice = Math.min(interval, WAIT_TIMEOUT_MS);
    let waited = 0;
    while (waited < interval && !isShutdown()) {
      await Bun.sleep(slice);
      waited += slice;
    }
    if (isShutdown()) {
      break;
    }
    let candidates: SentinelCandidateRow[];
    try {
      candidates = candidatesQuery.all() as SentinelCandidateRow[];
    } catch (err) {
      console.error("[exit-watcher] sentinel query failed:", err);
      continue;
    }
    const now = nowSecs();
    const rows: SentinelRow[] = [];
    for (const c of candidates) {
      // Per-row try/catch so one bad resolve (read race) never wedges the sweep.
      try {
        rows.push({
          jobId: c.job_id,
          pid: c.pid,
          lastEventTs: resolveLastEventTs(db, c.job_id),
          lastLifecycleTs: c.last_lifecycle_ts,
          workerDone: resolveWorkerDone(db, c.plan_verb, c.plan_ref),
          hasFreshSubagent: findFreshInFlightSubagentAnchor(
            db,
            c.job_id,
            STUCK_SENTINEL_SUBAGENT_GAP_SEC,
            now,
          ),
          planRef: c.plan_ref,
          adopted: c.adopted === 1,
        });
      } catch (err) {
        console.error(
          `[exit-watcher] sentinel resolve failed for job_id=${c.job_id}:`,
          err,
        );
      }
    }
    let verdicts: StuckSentinelVerdict[];
    try {
      verdicts = selectStuckSentinelVerdicts(rows, now, isAlive);
    } catch (err) {
      console.error("[exit-watcher] sentinel predicate failed:", err);
      continue;
    }
    const nowMs = Date.now();
    const seen = new Set<string>();
    for (const v of verdicts) {
      seen.add(v.jobId);
      if (!shouldEmitSentinel(memo.get(v.jobId), v.reason, nowMs, reemitMs)) {
        continue; // change-gated — no re-emit this tick.
      }
      memo.set(v.jobId, { reason: v.reason, lastEmitMs: nowMs });
      console.error(
        `[exit-watcher] stuck-sentinel job_id=${v.jobId} tier=${v.tier} heal=${v.heal} reason="${v.reason}"`,
      );
      post({
        kind: "stuck-sentinel",
        jobId: v.jobId,
        reason: v.reason,
        tsSec: now,
        heal: v.heal,
      });
    }
    // Drop memo entries whose condition cleared (healed to stopped, resumed, or
    // recovered) so a future re-stuck is a fresh first-detect. The sticky
    // `dispatch_failures` row SURVIVES — only `retry_dispatch` clears it — so
    // dropping the memo resets only the emission gate, never the anomaly row.
    if (memo.size > seen.size) {
      for (const jobId of memo.keys()) {
        if (!seen.has(jobId)) {
          memo.delete(jobId);
        }
      }
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
  const diff = diffLoop(
    db,
    diffTick,
    () => shutdown,
    data.pollMs,
    // fn-1096.3: countable backstop telemetry for a tolerated transient
    // SQLITE_NOTADB on the data_version poll — routed to main (the sole
    // sidecar writer) alongside the exit-reap channel.
    (consecutiveMisses) => {
      console.error(
        `[exit-watcher] transient SQLITE_NOTADB on data_version poll — skipped tick (consecutive=${consecutiveMisses})`,
      );
      parentPort?.postMessage({
        kind: "backstop",
        record: buildTimeoutRecord({
          backstop: "notadb-skip",
          worker: "exit-watcher",
          rescued: true,
          now: Date.now(),
          stalenessMs: null,
          detail: { consecutive_misses: String(consecutiveMisses) },
        }),
      } satisfies BackstopMessage);
    },
  ).catch((err) => {
    console.error("[exit-watcher] diff loop crashed:", err);
    throw err;
  });
  const wait = waitLoop();
  // Re-probe loop — the kernel-arm-miss backstop. Slow (~60s) tick that mints
  // a synthetic Killed for a non-terminal row whose pid is verifiably dead and
  // past the launch-race age gate. Posts the SAME exit message the kernel arm
  // posts, so main's onmessage handler folds it unchanged. A throw here is
  // fatal like the other two loops.
  const reprobe = reprobeLoop(
    db,
    (msg) => parentPort?.postMessage(msg),
    () => shutdown,
  ).catch((err) => {
    console.error("[exit-watcher] re-probe loop crashed:", err);
    throw err;
  });
  // Stuck-state sentinel (ADR 0013 layer 3) — the SIBLING producer to the dead-pid
  // reap. It watches the SAME `working` candidate set but the LIVE-pid half: a row
  // whose session is demonstrably idle (worker-done contradiction / very-stale)
  // heals to `stopped` and/or mints a sticky anomaly. Posts `{kind:"stuck-sentinel"}`
  // to main's onmessage handler, which mints the corrective event + distress row on
  // its sole writable connection. A throw here is fatal like the other loops.
  const sentinel = sentinelLoop(
    db,
    (msg) => parentPort?.postMessage(msg),
    () => shutdown,
  ).catch((err) => {
    console.error("[exit-watcher] sentinel loop crashed:", err);
    throw err;
  });

  // All four loops must complete before we close the DB + FFI handle. If any
  // throws, we treat the whole worker as fatal: close everything and exit
  // non-zero so the daemon escalates.
  Promise.all([diff, wait, reprobe, sentinel])
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

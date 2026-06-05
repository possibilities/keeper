/**
 * Keeper daemon — the long-running reducer process. Managed in production by a
 * LaunchAgent that re-runs `bun run src/daemon.ts` on any non-clean exit.
 *
 * Boot sequence (the locked design):
 *
 *   1. Open the writer connection (`openDb`). DDL + forward-only migration run
 *      inside `openDb`; the reducer_state cursor is seeded there too.
 *   2. Boot drain: `while (drain(db, BATCH) > 0) {}` — fold every unfolded event
 *      using the SAME code path as steady-state. After downtime this catches the
 *      projection up before the daemon goes live.
 *   3. Spawn TWELVE worker threads (all AFTER migrate + boot drain + seed sweep,
 *      so their read-only `openDb` connections never race a missing/un-migrated
 *      DB and the exit-watcher's data_version diff sees a settled projection.
 *      Worker fleet as of fn-684 task .5: the legacy `backend-worker` poller
 *      (interval-driven `zellij action list-panes` tab resolver) is retired
 *      and replaced by the always-on zellij-events watcher + main-side
 *      `scanZellijEventsDir` ingestion, both feeding the existing
 *      `BackendExecSnapshot` synthetic event — same fold path, event-driven
 *      now instead of poll-driven):
 *      - the wake worker — opens its own read-only connection, polls
 *        `PRAGMA data_version`, and posts a contentless `{ kind: "wake" }`
 *        whenever another connection commits.
 *      - the server worker — owns the UDS read surface: its own read-only
 *        connection, the `keeperd.lock` ownership lock, an NDJSON listener, and
 *        its own `data_version` poll that fans `jobs` changes out as patches.
 *      - the transcript worker — watches the external transcript tree with
 *        `@parcel/watcher`, tails each session's JSONL for the `custom-title`
 *        line, and posts `{ kind: "transcript-title", sessionId, title }`. Main
 *        turns that into a synthetic `TranscriptTitle` events row (priority-3
 *        title) on its own writable connection — keeperd's first role as an
 *        event PRODUCER. Main stays the sole writer; the worker is read-only.
 *      - the plan worker — watches each project root's `.planctl/{epics,tasks}`
 *        trees with `@parcel/watcher` and posts `{ kind: "plan-epic" | "plan-task",
 *        … }` snapshot messages. Main turns each into a synthetic
 *        `EpicSnapshot` / `TaskSnapshot` events row on its writable connection —
 *        the second producer-worker instance. Main stays the sole writer; the
 *        worker is read-only.
 *      - the exit-watcher worker — owns a kqueue (macOS) / pidfd+epoll (Linux)
 *        fd via `bun:ffi`, polls `data_version` to keep its (jobs.pid) watch set
 *        in sync, and posts `{ kind: "exit", jobId, pid, startTime }` when a
 *        tracked pid exits or the post-register kill-0 probe finds it already
 *        dead. Main turns each into a synthetic `Killed` events row (after a
 *        strict `(pid, start_time)` match against the persisted row) on its
 *        writable connection — the third producer-worker instance. The kqueue/
 *        epoll fd is owned by the worker thread and released in its own
 *        shutdown handler.
 *      - the git worker — polls watched git worktrees (see git-worker.ts's
 *        dynamic membership gate: `.planctl present || dirty || ahead>0`) via
 *        `git status --porcelain=v2 -z`, mines file-tool events from the DB,
 *        and posts `{ kind: "git-snapshot", ... }`. Main turns each into a
 *        synthetic `GitSnapshot` events row — the fourth producer-worker
 *        instance.
 *      - the zellij-events watcher worker (fn-684) — the always-on
 *        replacement for the retired `backend-worker` poller. Watches
 *        the keeper events dir with `@parcel/watcher` for plugin-written
 *        `<session>.ndjson` files (one per zellij session, append-only)
 *        and posts a contentless `{ kind: "zellij-events-changed" }`
 *        "go look" notification. Main re-runs `scanZellijEventsDir`,
 *        which tails each file from its persisted watermark, joins
 *        `(session, pane_id) -> job_id` via `readLiveJobsWithCoords`,
 *        and mints one synthetic `BackendExecSnapshot` event per
 *        resolved line through the EXACT same fold path the poller
 *        used — no reducer change, no schema change. Out-of-process
 *        producer carve-out: the data source is the zellij plugin (a
 *        different process), not a Bun postMessage worker — see
 *        CLAUDE.md "Worker contract".
 *   4. Steady state: every wake triggers a full drain loop. Wakes that arrive
 *      mid-drain coalesce into the next pass via a single "wake pending" flag —
 *      no event is missed (drain always re-reads from the cursor) and drain is
 *      never invoked re-entrantly. A `transcript-title` / `exit` message
 *      inserts the synthetic event then pumps a wake to fold it.
 *   5. SIGTERM: post `{ type: "shutdown" }` to ALL TWELVE workers, await their
 *      `close` events against a short deadline, terminate them, close the db,
 *      exit 0. This is the ONLY clean exit. The server worker releases its
 *      socket + lock, the transcript + plan + dead-letter + zellij-events
 *      workers unsubscribe their watchers, and the exit-watcher releases its
 *      kqueue/pidfd fd — all inside their own shutdown handlers (those
 *      resources are process/thread-owned, so `terminate()` alone would leak
 *      them).
 *
 * Crash policy (single recovery path): ANY unrecoverable error — either worker's
 * `error` event, an unhandled rejection, or a fold throw that escapes the
 * per-event guard — calls `process.exit(1)`. The LaunchAgent
 * `KeepAlive.SuccessfulExit = false` then restarts us. We deliberately keep ONE
 * well-tested recovery path rather than attempting in-process self-heal — no
 * in-process respawn of either worker.
 */

import type { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type {
  AutopilotWorkerData,
  DispatchExpiredMessage,
  DispatchedMessage,
  DispatchFailedMessage,
  Verb,
} from "./autopilot-worker";
import { readLiveJobsWithCoords } from "./backend-worker";
import {
  atomicWriteFile,
  openDb,
  resolveClaudeProjectsRoot,
  resolveConfig,
  resolveDbPath,
  resolveDeadLetterDir,
  resolvePlanRoots,
  resolveUsageRoot,
  resolveZellijEventsDir,
  runPlanctlApprovalMigration,
  type Stmts,
} from "./db";
import { parseDeadLetterLine } from "./dead-letter";
import type {
  DeadLetterChangedMessage,
  DeadLetterWorkerData,
} from "./dead-letter-worker";
import type { ExitMessage, ExitWatcherWorkerData } from "./exit-watcher";
import type {
  AddDiscoveryRootMessage,
  GitWorkerData,
  GitWorkerMessage,
} from "./git-worker";
import type {
  PlanctlCommitChangedMessage,
  PlanWorkerData,
  PlanWorkerOutbound,
  RecheckPendingMessage,
} from "./plan-worker";
import { DEFAULT_BATCH_SIZE, type DrainOptions, drain } from "./reducer";
import type { RestoreWorkerData } from "./restore-worker";
import { seedKilledSweep } from "./seed-sweep";
import type {
  KickMessage,
  KickPlanWorkerRequestMessage,
  ReplayRequestMessage,
  ReplayResultMessage,
  RetryDispatchRequestMessage,
  RetryDispatchResultMessage,
  ServerWorkerData,
  SetAutopilotPausedRequestMessage,
  SetAutopilotPausedResultMessage,
} from "./server-worker";
import type { TabNamerWorkerData } from "./tab-namer-worker";
import type {
  ApiErrorMessage,
  InputRequestMessage,
  TranscriptTitleMessage,
  TranscriptWorkerData,
} from "./transcript-worker";
import type {
  UsageMessage,
  UsageSnapshotMessage,
  UsageWorkerData,
} from "./usage-worker";
import type {
  ShutdownMessage,
  WakeMessage,
  WakeWorkerData,
} from "./wake-worker";
import {
  parseZellijEventLine,
  parseZellijWatermarks,
  peekZellijEpoch,
  serializeZellijWatermarks,
  type ZellijWatermarkFile,
} from "./zellij-events";
import type {
  ZellijEventsChangedMessage,
  ZellijEventsWorkerData,
} from "./zellij-events-worker";

/** Grace period for the worker to exit on shutdown before we close the db anyway. */
const WORKER_SHUTDOWN_DEADLINE_MS = 2000;

/**
 * Drain the projection to completion: loop `drain()` until it reports 0 newly
 * folded events. Shared by boot catch-up and every steady-state wake — the same
 * idempotent code path the design mandates. Each `drain()` call folds at most
 * `batchSize` events in their own transactions, so the writer lock is released
 * between batches and hook inserts are never starved.
 *
 * Pacing (boot only): the boot caller may pass `DrainOptions` to enable a
 * short OS-level sleep AFTER each fold's COMMIT, opening a contention window
 * for concurrent hook INSERTs to slip in instead of starving on the
 * boot-drain's tight `BEGIN IMMEDIATE` loop. The pacing budget
 * (`options.paceEvents`) is the TOTAL number of paced folds across all
 * `drain()` batches in this call — once the budget is spent, the remaining
 * batches run unpaced, so a large from-scratch re-fold catches up to head in
 * bounded time. Steady-state callers (every wake-loop drain) pass no
 * options and the function behaves exactly as before.
 *
 * Single drain code path: pacing is a stateless parameter on the SAME
 * `drain()` function steady state uses — no forked boot drain, per the
 * CLAUDE.md invariant.
 */
export function drainToCompletion(
  db: Database,
  batchSize = DEFAULT_BATCH_SIZE,
  options: DrainOptions = {},
): void {
  // Carry the pacing budget across batches: each `drain()` call decrements it
  // by the number of events paced inside that batch (capped by the batch
  // size). When the budget reaches 0 we stop passing pacing options so the
  // tail of a large backlog runs full-speed.
  let remainingPaceEvents = options.paceEvents ?? 0;
  const paceMs = options.paceMs ?? 0;
  const sleep = options.sleep;
  for (;;) {
    const batchOptions: DrainOptions =
      paceMs > 0 && (remainingPaceEvents > 0 || (options.paceEvents ?? 0) === 0)
        ? {
            paceMs,
            // A bare `paceMs` with no `paceEvents` cap paces the whole batch;
            // a budget caps it to at most `remainingPaceEvents` events this
            // batch. The next iteration sees the post-decrement count.
            paceEvents:
              (options.paceEvents ?? 0) === 0
                ? 0
                : Math.min(remainingPaceEvents, batchSize),
            sleep,
          }
        : {};
    const folded = drain(db, batchSize, batchOptions);
    if (folded === 0) return;
    if (remainingPaceEvents > 0) {
      // The batch paced at most min(remainingPaceEvents, folded) events.
      remainingPaceEvents -= Math.min(remainingPaceEvents, folded);
    }
  }
}

/**
 * SQLite's default WAL auto-checkpoint threshold (pages). `applyPragmas` does
 * not set it, so the writer connection runs at this default in steady state.
 * Made explicit so {@link withBootDrainCheckpointTuning} can disable it for the
 * boot drain and restore the exact steady-state value afterward.
 */
export const WAL_AUTOCHECKPOINT_PAGES = 1000;

/**
 * Post-COMMIT sleep duration (ms) for the boot drain. A real OS sleep — the JS
 * thread is blocked via `Atomics.wait` — opens a writer-lock window after
 * every fold's COMMIT so a concurrent hook INSERT (separate process) lands in
 * the gap instead of starving on the boot drain's tight `BEGIN IMMEDIATE`
 * loop. WAL gives NO writer FIFO fairness, so without this gap a sleeping
 * hook's busy-handler retry routinely loses the race to the reducer's next
 * `BEGIN IMMEDIATE` (microseconds after COMMIT) and exhausts its 2.4s budget
 * → dead-letter. `setImmediate` / event-loop yields do NOT help — they don't
 * release the SQLite lock to a separate process.
 *
 * Sized as small-but-real: 5ms × `BOOT_DRAIN_PACE_EVENTS` = ~2.5s total paced
 * latency budget, well under the bounce window's existing patience. Each gap
 * is wider than the hook's 30ms retry sleep so a hook that catches a paced
 * gap completes its INSERT comfortably.
 */
export const BOOT_DRAIN_PACE_MS = 5;

/**
 * Pacing budget (event count) for the boot drain. After this many paced
 * folds, the remaining drain runs unpaced — guarantees a large from-scratch
 * re-fold (the schema-migration path that rewinds the cursor and replays the
 * ~150k-event log) catches up to head in bounded extra time
 * (`BOOT_DRAIN_PACE_MS × BOOT_DRAIN_PACE_EVENTS` ≈ 2.5s) instead of paying
 * `paceMs` per event for minutes. Normal bounce backlogs (since the last
 * daemon run, seconds of events ≈ a few hundred) fit comfortably inside the
 * budget — they get full coverage of the contention window. The bounce
 * window for which the pacing matters is the first few seconds; events past
 * that are folded with no concurrent hooks waiting on the writer.
 */
export const BOOT_DRAIN_PACE_EVENTS = 500;

/**
 * TTL (ms) for an open `pending_dispatches` row before the producer-side
 * sweep mints a `DispatchExpired` discharge (fn-678, schema v50, task .3).
 *
 * Sized at 120s — strictly greater than the documented worker cold-start
 * P99 (24-33s for a `claude` boot with ~60 plugin dirs on the work tier)
 * with comfortable margin so a slow booting worker is NEVER re-dispatched
 * over while it's still initializing. A shorter TTL re-creates the fn-627
 * double-dispatch hazard the projection exists to eliminate; a phantom
 * row outliving its slot by a few minutes is strictly preferable to a
 * second worker landing on the same task.
 *
 * Compared against `Date.now()` IN MAIN by {@link sweepExpiredPendingDispatches}
 * — the fold reads only `event.ts` so a re-fold remains deterministic
 * (CLAUDE.md "all wallclock lives in the producer" invariant).
 */
export const PENDING_DISPATCH_TTL_MS = 120_000;

/**
 * Heartbeat cadence (ms) for the producer-side `pending_dispatches` TTL
 * sweep (fn-678, schema v50, task .3). The sweep MUST ride a heartbeat,
 * not the level-triggered `data_version` wake: a crashed dispatch can
 * be the only pending row on a quiescent board, and a write-triggered
 * wake would never fire — the slot would stay held indefinitely.
 *
 * 60s matches the existing 60s heartbeat cadence the git-worker
 * documents in its header (`src/git-worker.ts:13`) and the task spec's
 * "60s heartbeat" reference.
 */
export const PENDING_DISPATCH_SWEEP_INTERVAL_MS = 60_000;

/**
 * Pure helper: select every `pending_dispatches` row aged past the TTL
 * that does NOT already have an open `dispatch_failures` row for the
 * same `(verb, id)`. Used by the producer-side TTL sweep in
 * {@link runDaemon} to know which rows to mint a `DispatchExpired` for
 * on each 60s heartbeat.
 *
 * Exported so the daemon test suite can drive the sweep deterministically
 * (seed `pending_dispatches`, advance the wall-clock argument, assert
 * the returned keys). Reads the projection on the passed connection —
 * production passes main's writable connection so the read is sequenced
 * inside the same writer that mints the synthetic events; tests can
 * pass a tmp-DB connection.
 *
 * The LEFT JOIN guard suppresses an expire-mint for a `(verb, id)` whose
 * `DispatchFailed` already discharged the pending row through the same
 * fold path — defensive, since the reducer's `foldDispatchFailed`
 * already DELETEs the matching pending row when present (fn-678,
 * task .2), but the guard protects a transient race where the
 * `DispatchFailed` event has been written but not yet folded into
 * `dispatch_failures` and `pending_dispatches` simultaneously. Belt
 * and braces.
 */
export function selectExpiredPendingDispatches(
  db: Database,
  nowMs: number,
): { verb: string; id: string; dispatched_at: number }[] {
  const rows = db
    .query(
      `SELECT pd.verb AS verb, pd.id AS id, pd.dispatched_at AS dispatched_at
         FROM pending_dispatches pd
         LEFT JOIN dispatch_failures df
           ON df.verb = pd.verb AND df.id = pd.id
         WHERE df.verb IS NULL`,
    )
    .all() as { verb: string; id: string; dispatched_at: number }[];
  const cutoffMs = nowMs - PENDING_DISPATCH_TTL_MS;
  // `dispatched_at` is unix-epoch SECONDS (matches the schema's REAL
  // column and `event.ts` everywhere else in keeper). Compare in
  // milliseconds for a clean TTL constant.
  return rows.filter((r) => r.dispatched_at * 1000 < cutoffMs);
}

/**
 * Run the heavy boot drain with WAL auto-checkpointing DISABLED, then flush the
 * WAL once and restore the steady-state threshold.
 *
 * Why: a from-scratch re-fold (every schema migration rewinds
 * `reducer_state.last_event_id` and clears the projections) commits ~150k
 * one-event transactions back to back. At the default `wal_autocheckpoint=1000`
 * (~4MB) the WAL crosses that line constantly, and whichever commit trips it
 * absorbs a synchronous PASSIVE checkpoint — random writes + fsync into the
 * cold ~950MB main DB, stretching an ~11ms commit to seconds while it holds the
 * single write lock. Concurrent hook INSERTs then exhaust their 1.2s
 * `busy_timeout` (twice — `attempts=2`, `wait≈2.4s`) and dead-letter; this is
 * the dominant `insert:SQLITE_BUSY` drop class the hook-drop diagnostics
 * surfaced, and it recurs on EVERY restart that does a non-trivial drain, not
 * just one migration.
 *
 * With auto-checkpoint off, every fold COMMIT is a pure WAL append
 * (`synchronous=NORMAL` ⇒ commits don't fsync; only checkpoints do), so the
 * write lock is released promptly and hook INSERTs interleave instead of
 * starving. The WAL grows for the duration; a single `wal_checkpoint(PASSIVE)`
 * in the `finally` flushes COMMITted frames back into the main DB without
 * waiting on any writer, and we restore `wal_autocheckpoint` so steady state
 * is unchanged. The `finally` guarantees we never leave the long-running
 * writer with checkpointing disabled even if a drain throws.
 *
 * Why PASSIVE and not TRUNCATE: TRUNCATE waits for any concurrent writers AND
 * for any read transaction old enough to still need pre-WAL pages; under
 * concurrent hook INSERTs landing during the bounce window, a TRUNCATE here
 * absorbs a full hook `busy_timeout` (1.2s) of writer-lock-blocked latency and
 * starves a second hook into dead-letters. PASSIVE skips writers — it
 * checkpoints what it can without blocking — so the bounce window closes
 * cleanly even if a hook is mid-INSERT. The WAL file is not reclaimed on this
 * pass (TRUNCATE's only extra job), but it shrinks naturally on subsequent
 * auto-checkpoints once steady state resumes; the alternative — wedging a
 * concurrent hook into a drop — is strictly worse than carrying a slightly
 * larger WAL forward for a few minutes.
 */
export function withBootDrainCheckpointTuning(
  db: Database,
  body: () => void,
): void {
  db.run("PRAGMA wal_autocheckpoint = 0");
  try {
    body();
  } finally {
    db.run("PRAGMA wal_checkpoint(PASSIVE)");
    db.run(`PRAGMA wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
  }
}

/**
 * Hard cap on the per-pid dead-letter NDJSON file size before we read it. The
 * hook writes one record per dropped INSERT and never truncates / rotates, so
 * a single file could in principle grow unbounded under sustained drop storms.
 * 16 MiB is far above any realistic dead-letter accumulation between daemon
 * restarts (a thousand drops at ~1 KiB each fits in 1 MiB) and prevents a
 * pathological file from OOM'ing the import scan. An oversized file is
 * skip-and-logged — never throws — so one bad file doesn't wedge the rest of
 * the dir scan.
 */
const MAX_DEAD_LETTER_FILE_BYTES = 16 * 1024 * 1024;

/**
 * Serialize a `UsageSnapshotMessage` into the JSON string that rides in the
 * synthetic `UsageSnapshot` event's `data` blob. The reducer
 * (`extractUsageSnapshot` in `src/reducer.ts`) decodes the same shape; every
 * projection-meaningful field MUST appear here or the corresponding `usage`
 * column folds to NULL forever.
 *
 * fn-651 task .1: this was previously an inline `JSON.stringify({...})` in
 * the worker handler that dropped the fn-645 envelope-freshness fields
 * (`status` / `subscription_active` / `error_type` / `error_message` /
 * `error_at`), so `mc1` (no subscription) never got redacted and the status
 * chip never rendered. Extracted into a pure function so the test surface
 * can pin the wire shape directly.
 *
 * NOT serialized: `kind` (event-tag discriminator, not a projection field)
 * and `id` (the agentuse profile id, which rides in `events.session_id`
 * via the synthetic-event pipeline's generic entity-key overload, not in
 * the data blob).
 *
 * Object-literal slot order here is documentation only — the reducer's
 * decoder is shape-tolerant. The load-bearing slot order lives in
 * `usage-worker.ts` `buildUsageMessage` for the change-gate.
 */
export function serializeUsageSnapshot(msg: UsageSnapshotMessage): string {
  return JSON.stringify({
    target: msg.target,
    multiplier: msg.multiplier,
    session_percent: msg.session_percent,
    session_resets_at: msg.session_resets_at,
    week_percent: msg.week_percent,
    week_resets_at: msg.week_resets_at,
    sonnet_week_percent: msg.sonnet_week_percent,
    sonnet_week_resets_at: msg.sonnet_week_resets_at,
    // fn-645 envelope freshness / plan / stale-error axes — forwarded so
    // the reducer's UPSERT populates the columns instead of folding NULL.
    status: msg.status,
    subscription_active: msg.subscription_active,
    error_type: msg.error_type,
    error_message: msg.error_message,
    error_at: msg.error_at,
    // fn-651: rate-limit lift instant — top-level envelope field, folded
    // into `usage.rate_limit_lifts_at` by `parseUsageSnapshot`. The
    // companion `last_usage_fold_at` freshness stamp is NOT a serialized
    // payload field; the reducer derives it from the event `ts` on a
    // "successful usage" fold (CLAUDE.md determinism boundary — never
    // a wall-clock read inside the fold).
    lift_at: msg.lift_at,
  });
}

/**
 * Scan the dead-letter dir and import each NDJSON file's records into the
 * `dead_letters` operational table via `INSERT OR IGNORE` (keyed on `dl_id`).
 * This is a DIRECT operational-table write — NOT an event fold — called both
 * once at boot (in `runDaemon`'s boot sequence, after `seedKilledSweep`) and
 * live on every `{kind:"dead-letter-changed"}` message from the dead-letter
 * worker.
 *
 * Idempotency: `INSERT OR IGNORE` on the `dl_id` PRIMARY KEY means a re-scan
 * of an unchanged file inserts nothing new — the same NDJSON file can be
 * scanned a hundred times and the table converges on the same row set. This
 * makes the "watcher event = re-read everything" pattern safe.
 *
 * Per-file isolation: every recoverable error (missing dir, missing file
 * mid-scan, read error, oversized file, malformed line, INSERT throw) is
 * swallowed to stderr — the import path MUST NOT throw out of the scan, or a
 * single bad file would wedge boot AND the live message loop (both call this
 * function). Exported so the test surface can drive it directly without
 * spawning the worker.
 */
export function scanDeadLetterDir(db: Database, dir: string): void {
  // Missing-dir tolerance: a fresh machine has no dead-letters/ tree until
  // the hook hits its first drop. Returning early is the documented
  // graceful-degradation path; the worker's existsSync guard mirrors this.
  if (!existsSync(dir)) {
    return;
  }

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    console.error(
      `[keeperd] dead-letter scan failed to readdir ${dir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }

  // Prepare the insert statement once outside the loop (bun:sqlite's
  // prepared-statement cache makes a fresh `db.run` near-equivalent, but
  // hoisting it is the documented zero-cost form for hot-ish paths).
  // `INSERT OR IGNORE` collapses a duplicate `dl_id` to a no-op; the
  // primary-key conflict path is the idempotency guarantee.
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO dead_letters
       (dl_id, session_id, hook_event, ts, dl_written_at, pid, bindings,
        status, recovered_at, replayed_event_id, source_file)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', NULL, NULL, ?)`,
  );

  for (const name of names) {
    if (!name.endsWith(".ndjson")) {
      // The hook writes per-pid `<pid>.ndjson` files; ignore anything else
      // that might land in the dir (editor backup files, a future tool
      // dropping logs alongside).
      continue;
    }
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch (err) {
      // Read-vs-delete race (the file vanished between readdir and stat):
      // skip-and-log without throwing. The next watcher event will pick it
      // up if it reappears.
      console.error(
        `[keeperd] dead-letter scan stat failed for ${full}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    if (!st.isFile()) {
      continue;
    }
    if (st.size > MAX_DEAD_LETTER_FILE_BYTES) {
      console.error(
        `[keeperd] dead-letter file ${full} exceeds ${MAX_DEAD_LETTER_FILE_BYTES} bytes (${st.size}); skipping`,
      );
      continue;
    }

    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch (err) {
      console.error(
        `[keeperd] dead-letter scan read failed for ${full}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    // NDJSON: one record per `\n`-delimited line. `parseDeadLetterLine`
    // returns null for an empty / truncated / malformed line — skip those
    // silently, the next valid line (or a later append) still imports. A
    // crash-killed hook may leave a partial trailing line; that is the
    // documented crash-safety contract on the producer side.
    const lines = text.split("\n");
    for (const line of lines) {
      const record = parseDeadLetterLine(line);
      if (record === null) {
        continue;
      }
      try {
        insertStmt.run(
          record.dl_id,
          record.session_id,
          record.hook_event,
          record.ts,
          record.dl_written_at,
          record.pid,
          JSON.stringify(record.bindings),
          full,
        );
      } catch (err) {
        // A bad row (e.g. a forward-compat column we don't store on this
        // schema, a constraint violation that's NOT the PK duplicate
        // INSERT OR IGNORE swallows) must not wedge the rest of the scan
        // OR the boot/live loop. Log and continue.
        console.error(
          `[keeperd] dead-letter INSERT failed for ${record.dl_id} (${full}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}

/**
 * Cap how much of one `<session>.ndjson` file we'll read in one pass.
 * The plugin appends one ~200-byte line per pane/tab delta. Post-fn-706.2
 * it SELF-ROTATES the feed at a ~4 MiB threshold (truncate + fresh-epoch
 * header + full re-snapshot), so a session's live feed self-bounds well
 * under this cap — the consumer detects the rotation via a first-line
 * epoch peek and resets its watermark to byte 0. 16 MiB matches
 * `MAX_DEAD_LETTER_FILE_BYTES` and bounds the per-scan memory cost; it is
 * now a never-frozen safety net rather than the steady state. An oversized
 * file is TAIL-READ instead of skipped (fn-706.1): we seek to
 * `max(priorOffset, size - cap)`, discard the partial leading line to the
 * next `\n`, and parse complete lines only — so a noisy session degrades to
 * "tail-only" and never freezes forever. (Superseded the pre-fn-706
 * skip-and-hand-truncate path, which left the watermark frozen and silently
 * stopped minting `BackendExecSnapshot` for the whole session.) Still never
 * throws — bounded memory, one record lost at the resync seam, the rest of
 * the scan unaffected.
 *
 * Exported so a test can drive an oversize tail-read at a small
 * injected size without materializing a real 16 MiB feed.
 */
export const MAX_ZELLIJ_EVENTS_FILE_BYTES = 16 * 1024 * 1024;

// Env-gated tracing (epic fn-704 task .2). Mirrors the `KEEPER_TRACE_SERVER`
// convention in `server-worker.ts`: read the flag ONCE at module load into a
// `const`, gate AT THE CALL SITE so the increment never allocates when off,
// and trace to `console.error` in an awk-parseable shape on a rolling window.
// This is the MAIN side of `KEEPER_TRACE_ZELLIJ`: it counts actual
// `BackendExecSnapshot` mints/sec inside `scanZellijEventsDir` — the real
// `data_version`-bumping loop driver (the zellij-events worker has NO DB handle
// by design, so the true bump is only observable here, not at the worker's
// notification-post). Pairs with the worker-side notification counter: a high
// notification rate with a LOW mint rate means the feed is noisy-but-harmless;
// a high mint rate that tracks the tab-namer rename rate confirms the suspected
// feed -> rename -> TabUpdate -> re-emit -> feed loop. ADDITIVE + fully gated —
// touches no fold/projection logic, so re-fold determinism is untouched.
const TRACE_ZELLIJ = process.env.KEEPER_TRACE_ZELLIJ === "1";

/** Rolling trace window (ms). The counter flushes one rate line per window. */
const TRACE_ZELLIJ_WINDOW_MS = 10_000;

/**
 * Allocation-free rolling-window mint counter for `KEEPER_TRACE_ZELLIJ`. The
 * caller MUST gate `tick()` behind `TRACE_ZELLIJ`. Exception-free (integer
 * arithmetic + a `console.error` on a plain string), so it is safe inside the
 * scan loop which runs on main's drain path (no-self-heal: a throw here would
 * bounce the daemon).
 */
const traceZellijMints = (() => {
  let count = 0;
  let windowStart = 0;
  return {
    tick(now: number): void {
      if (windowStart === 0) windowStart = now;
      count++;
      if (now - windowStart >= TRACE_ZELLIJ_WINDOW_MS) {
        console.error(
          `[trace-zellij-mints] T=${now} count=${count} window_ms=${now - windowStart}`,
        );
        count = 0;
        windowStart = now;
      }
    },
  };
})();

/**
 * Hidden sidecar filename for the per-session watermark map. Lives at
 * `<events-dir>/.keeperd-watermarks.json` — a dot-prefixed sibling so
 * the plugin's `<session>.ndjson` glob (and the `.endsWith(".ndjson")`
 * filter in the scan loop below) never collides with it. Written
 * atomically (temp+rename) after each scan advances any session's tail.
 */
const ZELLIJ_WATERMARK_BASENAME = ".keeperd-watermarks.json";

/**
 * Scan the zellij events dir (fn-684 task .3) and mint one
 * `BackendExecSnapshot` synthetic event per new pane line whose
 * `(session, pane_id)` joins to a live job. This is the consumer half
 * of the plugin-feed pipeline: the Rust bridge plugin (task .1) appends
 * one NDJSON line per pane/tab delta to `<events-dir>/<session>.ndjson`;
 * this function tails each file from its persisted byte-offset
 * watermark, joins via the EXISTING {@link readLiveJobsWithCoords}, and
 * mints through the EXISTING {@link Stmts.insertEvent}. NO schema or
 * reducer change — the reducer's `foldBackendExecSnapshot` arm folds
 * the event identically whether the producer is the legacy poller or
 * this plugin path.
 *
 * Called once at boot (after the dead-letter import) and live on every
 * `{kind:"zellij-events-changed"}` message from the zellij-events
 * worker. Idempotent on re-call: the watermark sidecar advances every
 * file's tail, so a no-new-lines re-scan emits nothing. A daemon crash
 * mid-scan re-reads the same lines on next boot — the reducer's UPDATE
 * writes the same `(tab_id, tab_name)` values, so re-mint converges.
 *
 * Per-file isolation: every recoverable error (missing dir, missing
 * file mid-scan, read error, oversized file, malformed line, INSERT
 * throw) is swallowed to stderr — the import path MUST NOT throw out
 * of the scan, or a single bad file would wedge boot AND the live
 * message loop (both call this function).
 *
 * Epoch reset: the plugin stamps a fresh `epoch` nonce on every
 * `load()`. A line whose epoch differs from the persisted watermark
 * resets that session's offset to 0 — earlier `seq` values from a
 * prior epoch are not "already seen" after a reload. Without this,
 * a plugin reload would silently drop the first batch of post-reload
 * lines.
 *
 * No-clobber guard: the reducer's fold writes `tab_name = ?` (NOT
 * COALESCE), so a snapshot with an empty `tab_name` would clobber a
 * previously-known name. We skip lines with `tab_name === ""` — the
 * value-preserving fold for tab name is "skip the line", not "fold
 * the empty string".
 *
 * Cross-session pane-id collision: pane ids are unique only within a
 * zellij session. The join MUST stay `(session, pane_id)`, never just
 * `pane_id` — confirmed via the `readLiveJobsWithCoords` row shape
 * (carries `backend_exec_session_id` alongside `backend_exec_pane_id`).
 *
 * Exported so the test surface can drive it directly without spawning
 * the worker — mirrors `scanDeadLetterDir` next door.
 *
 * `maxBytes` is the per-file tail-read cap (fn-706.1), defaulting to
 * the production {@link MAX_ZELLIJ_EVENTS_FILE_BYTES}. It is a pure
 * function argument — NOT an env read (the scan stays env/wallclock-free
 * except the synthetic-event `ts`, per the event-sourcing invariants) —
 * so a test can drive the oversize tail-read path with a tiny injected
 * cap instead of materializing a real 16 MiB feed.
 */
export function scanZellijEventsDir(
  db: Database,
  stmts: Stmts,
  dir: string,
  maxBytes: number = MAX_ZELLIJ_EVENTS_FILE_BYTES,
): void {
  // Missing-dir tolerance: task .4's daemon boot `mkdir` covers the
  // production case, but a fresh test harness may not have created
  // the dir. Returning early is the documented graceful-degradation
  // path; the worker's existsSync guard mirrors this.
  if (!existsSync(dir)) {
    return;
  }

  // Load the per-session watermark sidecar. Missing / corrupt → empty
  // map (tail from byte 0; re-mint converges on the projection side).
  const watermarkPath = join(dir, ZELLIJ_WATERMARK_BASENAME);
  let watermarks: ZellijWatermarkFile = {};
  if (existsSync(watermarkPath)) {
    try {
      watermarks = parseZellijWatermarks(readFileSync(watermarkPath, "utf8"));
    } catch (err) {
      console.error(
        `[keeperd] zellij-events watermark read failed for ${watermarkPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      watermarks = {};
    }
  }

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    console.error(
      `[keeperd] zellij-events scan failed to readdir ${dir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }

  // Build the live-job join once per scan. The map is keyed by
  // `${session}::${pane_id}` so the inner per-line lookup is O(1) and
  // bursts of pane lines against the same session reuse the same
  // projection read. The map is also stable for the whole scan — a
  // session that ends mid-scan still resolves to its last known
  // job_id (last-known sticks; the next scan's read will reflect the
  // ended state via the projection's `state NOT IN (...)` filter
  // inside `readLiveJobsWithCoords`).
  let liveJobs: Map<string, string>;
  try {
    const rows = readLiveJobsWithCoords(db);
    liveJobs = new Map(
      rows.map((r) => [
        `${r.backend_exec_session_id}::${r.backend_exec_pane_id}`,
        r.job_id,
      ]),
    );
  } catch (err) {
    console.error(
      `[keeperd] zellij-events scan failed to read live jobs: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }

  let anyWatermarkAdvanced = false;

  for (const name of names) {
    if (!name.endsWith(".ndjson")) {
      // The plugin writes per-session `<session>.ndjson` files. Ignore
      // the watermark sidecar (`.keeperd-watermarks.json` — dot-prefixed,
      // doesn't end in `.ndjson` anyway) and anything else that might
      // land in the dir.
      continue;
    }
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch (err) {
      // Read-vs-delete race (the file vanished between readdir and
      // stat): skip-and-log without throwing.
      console.error(
        `[keeperd] zellij-events scan stat failed for ${full}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    if (!st.isFile()) {
      continue;
    }
    // The session key is the basename without the `.ndjson` suffix —
    // matches the plugin's `/host/<session>.ndjson` naming.
    const sessionKey = name.slice(0, -".ndjson".length);
    const prior = watermarks[sessionKey];
    let priorOffset =
      prior && prior.offset >= 0 && prior.offset <= st.size ? prior.offset : 0;

    let buf: Buffer;
    try {
      buf = readFileSync(full);
    } catch (err) {
      console.error(
        `[keeperd] zellij-events scan read failed for ${full}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    // Rotation detection via a first-line epoch peek (fn-706.2). The bridge
    // rotates its own feed at the ~4 MiB threshold by truncating to byte 0
    // and writing a fresh-epoch `plugin_start` header + full re-snapshot. The
    // re-snapshot can grow the file PAST `priorOffset`, so the `size <
    // priorOffset` shrink guard (the `prior.offset <= st.size` clamp above)
    // misses it — the behind-consumer hole. Peek the FIRST line's epoch each
    // scan: if it differs from the persisted watermark epoch, the file was
    // rotated (or reloaded), so reset the offset to 0 and re-read from byte 0
    // (consuming the header + snapshot). Robust even when `size >=
    // priorOffset`. The shrink guard is retained above as a secondary signal.
    //
    // `peekZellijEpoch` (NOT `parseZellijEventLine`) lifts the epoch even from
    // the `plugin_start` sentinel header the rotation writes — the per-line
    // parser nulls the sentinel, so it cannot serve this peek.
    if (prior) {
      const firstNl = buf.indexOf(0x0a); // `\n`
      const firstLine =
        firstNl === -1
          ? buf.toString("utf8")
          : buf.subarray(0, firstNl).toString("utf8");
      const firstEpoch = peekZellijEpoch(firstLine);
      if (firstEpoch !== null && firstEpoch !== prior.epoch) {
        // Rotated (or reloaded) since the last scan — the file's first line
        // carries a fresh epoch. Reset to byte 0 so we consume the new
        // header + re-snapshot from the start.
        priorOffset = 0;
      }
    }

    if (st.size === priorOffset) {
      // No new bytes since the last scan — nothing to do for this file.
      continue;
    }

    // Tail-read cap (fn-706.1): an oversize feed is read from a bounded
    // tail window, NOT skipped. The window base is
    // `max(priorOffset, size - cap)` so a behind-consumer never reads
    // more than `cap` bytes in one pass; a noisy session degrades to
    // "tail-only" and the watermark keeps advancing (the pre-fn-706
    // skip-and-log froze the watermark forever, stopping all
    // `BackendExecSnapshot` mints for the session). When the base jumps
    // PAST the prior offset we landed mid-line, so the leading partial
    // bytes are discarded to the first `\n` below.
    const tailBase = Math.max(priorOffset, st.size - maxBytes);

    // Tail from the window base. We re-read the whole file (simpler
    // than a streaming seek; bounded by `MAX_ZELLIJ_EVENTS_FILE_BYTES`)
    // and slice off everything before `tailBase`. The slice MUST be done
    // on the Buffer (byte-indexed) before decoding to UTF-8 — slicing
    // a JS string by the offset would mix byte offsets (the write side
    // advances via `Buffer.byteLength`, the file's `st.size` is in
    // bytes) with UTF-16 code-unit offsets and over-shoot the moment
    // any consumed line contains a multi-byte character (e.g. an emoji
    // in a tab name), silently truncating the next line and persisting
    // the corrupt offset. If the file shrank (epoch-less truncation —
    // not a pattern the plugin uses, but tolerated), the priorOffset>size
    // guard above already reset to 0; we still detect a fresh epoch on
    // the first new line to clear the persisted-epoch mismatch.
    //
    // Mid-line resync (fn-706.1): when `tailBase > priorOffset` we
    // jumped past unconsumed bytes to honor the cap, so the window
    // starts mid-record. Discard the leading partial line (bytes up to
    // and including the first `\n`) and count those bytes as
    // `discardedPartialBytes` — the new watermark accounts for them so
    // the next scan resumes from the right absolute offset. One record
    // is lost at the seam, which is safe: both consumers (tab-namer
    // rename, autopilot reap) are last-writer-wins on per-pane facts
    // and the latest line carries the current `(tab_id, tab_name)`.
    let windowBuf = buf.subarray(tailBase);
    let discardedPartialBytes = 0;
    if (tailBase > priorOffset) {
      const firstNl = windowBuf.indexOf(0x0a); // `\n`
      if (firstNl === -1) {
        // No newline in the entire tail window — the whole window is one
        // incomplete record. Nothing complete to consume; defer the
        // whole partial. Advance the watermark to the window base so we
        // re-read this partial (and whatever completes it) next scan
        // without re-reading the skipped-over prefix. The read-back guard
        // only validates `offset`, so an empty carried-forward epoch is
        // tolerated until a parseable line stamps the real one.
        watermarks[sessionKey] = {
          epoch: prior?.epoch ?? "",
          offset: tailBase,
        };
        anyWatermarkAdvanced = true;
        continue;
      }
      discardedPartialBytes = firstNl + 1; // include the `\n`
      windowBuf = windowBuf.subarray(discardedPartialBytes);
    }
    const tail = windowBuf.toString("utf8");

    // Forward-tail line walk. Split on `\n` and process every COMPLETE
    // line (lines BEFORE the final `\n`). The last element of the
    // split is either an empty string (file ends in `\n` — every line
    // before it is complete) or a partial trailing line written
    // mid-append; either way we leave it for the next scan by
    // advancing the watermark only past the bytes we actually consumed.
    const lines = tail.split("\n");
    const trailingPartialBytes = Buffer.byteLength(
      lines[lines.length - 1] ?? "",
      "utf8",
    );

    // When the window jumped past the prior offset (an oversize tail-read),
    // the persisted epoch is stale relative to the window content — we
    // skipped over the bytes it described. Seed `sessionEpoch` from the
    // FIRST successfully parsed line in the window instead, so a stale
    // persisted epoch can't mis-trigger the reset path on line 0. We
    // can't assume line 0 parses (it may be a `plugin_start` sentinel or
    // garbage → `null`), so seeding happens lazily at the first non-null
    // parse below, gated by `needsEpochSeed`.
    const windowJumped = tailBase > priorOffset;
    let sessionEpoch = windowJumped ? null : (prior?.epoch ?? null);
    let needsEpochSeed = windowJumped;
    let consumedBytesInTail = 0;
    let pendingEpochReset = false;

    // Process all elements EXCEPT the final one (which is either empty
    // — a clean line break — or a partial trailing line not yet
    // terminated by `\n`; in both cases it's not complete).
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i] ?? "";
      // Advance the per-line consumption counter regardless of parse
      // outcome — a malformed line still consumed those bytes, and the
      // next scan must not re-read them.
      consumedBytesInTail += Buffer.byteLength(line, "utf8") + 1; // +1 for the `\n`

      const record = parseZellijEventLine(line);
      if (record === null) {
        continue;
      }

      // Seed the epoch from the first parsed line in a jumped window so
      // the reset detection below doesn't mis-fire against a stale
      // persisted epoch.
      if (needsEpochSeed) {
        sessionEpoch = record.epoch;
        needsEpochSeed = false;
      }

      // Epoch reset detection: an incoming epoch that differs from the
      // persisted one means a plugin reload. The reload restarts `seq`
      // at 0 and may overlap byte offsets with the prior epoch's tail
      // (zellij plugin reloads recreate the WASI sandbox; the append-
      // only open at the same path means the old bytes are still
      // there, but new bytes start with a fresh epoch). We detect the
      // reset at the FIRST line whose epoch differs from prior; for
      // the rest of this scan we treat the new epoch as authoritative
      // and consume normally. The persisted watermark below will
      // record the NEW epoch + the post-scan offset.
      if (sessionEpoch !== null && record.epoch !== sessionEpoch) {
        pendingEpochReset = true;
      }
      sessionEpoch = record.epoch;

      // No-clobber: skip lines with an empty `tab_name`. The reducer
      // writes `tab_name = ?` (non-COALESCE), so an empty value here
      // would erase a previously-resolved name on the matching jobs
      // row.
      if (record.tab_name === "") {
        continue;
      }

      // Cross-session-isolated join: `(session, pane_id)`. A pane id
      // is unique only within a session; conflating across sessions
      // would mint a snapshot against the wrong job.
      const jobId = liveJobs.get(`${record.session}::${record.pane_id}`);
      if (jobId === undefined) {
        // No live job claims this pane right now. Acceptable — the
        // SessionStart that binds the job's `(session, pane_id)` may
        // not have landed yet (race), or this pane belongs to an
        // unrelated zellij window. Skip without minting; the next
        // pane delta will mint if the job has landed by then.
        continue;
      }

      // Mint the synthetic `BackendExecSnapshot` event verbatim — same
      // binding shape as `backend-worker`'s message handler at
      // `daemon.ts:~1914`. The reducer's `foldBackendExecSnapshot`
      // arm folds this identically; the projection update is
      // idempotent on re-mint.
      try {
        stmts.insertEvent.run({
          $ts: Date.now() / 1000,
          $session_id: jobId,
          $pid: null,
          $hook_event: "BackendExecSnapshot",
          $event_type: "backend_exec_snapshot",
          $tool_name: null,
          $matcher: null,
          $cwd: null,
          $permission_mode: null,
          $agent_id: null,
          $agent_type: null,
          $stop_hook_active: null,
          $data: JSON.stringify({
            tab_id: record.tab_id,
            tab_name: record.tab_name,
          }),
          $subagent_agent_id: null,
          $spawn_name: null,
          $start_time: null,
          $slash_command: null,
          $skill_name: null,
          $planctl_op: null,
          $planctl_target: null,
          $planctl_epic_id: null,
          $planctl_task_id: null,
          $planctl_subject_present: null,
          $tool_use_id: null,
          $config_dir: null,
          $planctl_queue_jump: null,
          $bash_mutation_kind: null,
          $bash_mutation_targets: null,
          $planctl_files: null,
          $backend_exec_type: null,
          $backend_exec_session_id: null,
          $backend_exec_pane_id: null,
          $background_task_id: null,
        });
        // fn-704.2 trace: count REAL mints (post-INSERT = the actual
        // `data_version` bump) — the loop driver. Inside the `try` so a failed
        // INSERT (counted in the catch's skip) is not tallied as a bump.
        // Call-site gated so the counter is inert when the flag is off.
        if (TRACE_ZELLIJ) traceZellijMints.tick(Date.now());
      } catch (err) {
        // A failed INSERT must not wedge the rest of the scan. The
        // next watcher message will retry (the watermark still
        // advances past this line — re-mint is idempotent on the
        // projection but a partial-fail row already landed, so we
        // do NOT want to re-attempt it; skipping forward is correct).
        console.error(
          `[keeperd] zellij-events INSERT failed for ${full} session=${record.session} pane=${record.pane_id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    // If the file ended cleanly (no `\n` partial) the trailing partial
    // count is 0 and the final element of the split was empty.
    void trailingPartialBytes;

    // Watermark advance: only update if we consumed any complete lines
    // this pass. Even a no-parseable-records pass that consumed bytes
    // counts — we don't want to re-scan the same garbage on every
    // watcher event.
    if (consumedBytesInTail > 0 || pendingEpochReset) {
      // The watermark is the absolute byte position we've consumed up
      // to, measured from the ACTUAL window base — not `priorOffset`.
      // `tailBase` honors the oversize cap (== priorOffset on a normal
      // in-cap scan), `discardedPartialBytes` accounts for the mid-line
      // leading partial we dropped on a jumped window (0 on a normal
      // scan), and `consumedBytesInTail` is the complete-line bytes
      // walked this pass. Subsequent scans tail forward from here; the
      // plugin's append-only open keeps writing at the file's tail
      // across reloads (zellij#5177-style double-load is handled by the
      // plugin's append-create mode).
      const newOffset = tailBase + discardedPartialBytes + consumedBytesInTail;
      const newEpoch = sessionEpoch ?? prior?.epoch ?? "";
      if (newEpoch.length > 0) {
        watermarks[sessionKey] = { epoch: newEpoch, offset: newOffset };
        anyWatermarkAdvanced = true;
      }
    }
  }

  // Persist the watermark sidecar AFTER all files have been tailed —
  // one atomic write per scan (not one per file). On any throw above
  // we still hit this point because each per-file path swallows its
  // own errors; in the truly catastrophic case the function returns
  // early before we get here, and the next scan re-tails from the
  // same prior offsets.
  if (anyWatermarkAdvanced) {
    try {
      atomicWriteFile(watermarkPath, serializeZellijWatermarks(watermarks));
    } catch (err) {
      console.error(
        `[keeperd] zellij-events watermark persist failed at ${watermarkPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/**
 * The full `events` table column list, in CREATE_EVENTS order. Used by
 * {@link recoverOneDeadLetter} to drive a dynamic INSERT against the
 * row's stored `bindings` blob: only the columns the dead-letter record
 * actually carries are bound, so a re-fold reproduces byte-identical to
 * what the hook would have written had its INSERT not failed. Held as a
 * module constant so adding a column means touching THIS list AND the
 * CREATE_EVENTS literal AND the prepared `insertEvent` statement
 * (a shared boundary that's been tight in this repo since fn-456).
 *
 * `id` is omitted — it's `INTEGER PRIMARY KEY AUTOINCREMENT`, SQLite
 * picks a fresh higher value than every existing row so the replayed
 * event lands at the tail of the log and folds at the end of the next
 * drain pass.
 */
const EVENTS_COLUMNS = [
  "ts",
  "session_id",
  "pid",
  "hook_event",
  "event_type",
  "tool_name",
  "matcher",
  "cwd",
  "permission_mode",
  "agent_id",
  "agent_type",
  "stop_hook_active",
  "data",
  "subagent_agent_id",
  "spawn_name",
  "start_time",
  "slash_command",
  "skill_name",
  "planctl_op",
  "planctl_target",
  "planctl_epic_id",
  "planctl_task_id",
  "planctl_subject_present",
  "tool_use_id",
  "config_dir",
  "planctl_queue_jump",
  "bash_mutation_kind",
  "bash_mutation_targets",
  "planctl_files",
] as const;

/**
 * Recover ONE oldest `waiting` dead-letter row (fn-643 task .4). Picks the
 * row with the smallest `(dl_written_at, dl_id)` tuple, rebuilds an
 * `events` INSERT from its stored `bindings`, and flips the row to
 * `recovered` (stamping `recovered_at` + `replayed_event_id`) — all in
 * ONE `BEGIN IMMEDIATE` transaction. Returns the recovered row's `dl_id`
 * on success, or `null` when the table had zero `waiting` rows.
 *
 * MUST run on main (the daemon's writer connection); the server-worker's
 * `replay_dead_letter` RPC routes through the worker→main bridge so this
 * write lands here, preserving the CLAUDE.md invariant "main is the sole
 * writer of the events log". The replayed event is a PLAIN REAL event
 * (carrying the original `pid`, `start_time`, `config_dir`, `data`,
 * etc.), NOT a synthetic mint — a from-scratch re-fold against the post-
 * recovery event log reproduces the projection byte-identically (the
 * reducer treats the replayed row exactly as it would have treated the
 * hook's original INSERT had it not failed). `dead_letters` itself is
 * never touched by a re-fold per the schema-v37 invariant.
 *
 * Transactional shape (`BEGIN IMMEDIATE`):
 * 1. SELECT the oldest waiting row (`ORDER BY dl_written_at, dl_id LIMIT 1`).
 * 2. If none, COMMIT and return null.
 * 3. Build the INSERT column list from `EVENTS_COLUMNS ∩ keys(bindings)`
 *    — forward-compat: a future-schema binding for an unknown column is
 *    dropped on replay (per the dead-letter docstring's contract).
 * 4. Run the INSERT, capture `lastInsertRowid` as `replayed_event_id`.
 * 5. UPDATE the `dead_letters` row: status='recovered', recovered_at=now,
 *    replayed_event_id=<captured>.
 * 6. COMMIT.
 *
 * A throw inside the transaction rolls back BOTH the INSERT and the
 * UPDATE — the row stays `waiting`, the events log stays untouched, and
 * the dispatcher surfaces `rpc_failed`. The next replay invocation re-
 * tries the same row.
 *
 * Idempotency under re-invocation: a successful recovery flips the row
 * to `recovered`; the same row will never be picked again (the
 * `WHERE status='waiting'` predicate filters it out). Two back-to-back
 * replays drain two rows oldest-first; a third on an empty backlog
 * returns null cleanly.
 *
 * Exported for direct test reach.
 */
export function recoverOneDeadLetter(db: Database): string | null {
  // bun:sqlite exposes `db.transaction(fn)` for an explicit BEGIN/COMMIT
  // wrapper, BUT the inline `db.exec("BEGIN IMMEDIATE"); ... COMMIT/
  // ROLLBACK` form is what the reducer uses (`src/reducer.ts:drain`) and
  // it composes cleanly with the inline SQL here. Symmetry > API
  // shape.
  db.run("BEGIN IMMEDIATE");
  let recoveredDlId: string | null = null;
  try {
    const row = db
      .prepare(
        `SELECT dl_id, bindings, ts, session_id, hook_event, pid
           FROM dead_letters
          WHERE status = 'waiting'
          ORDER BY dl_written_at ASC, dl_id ASC
          LIMIT 1`,
      )
      .get() as {
      dl_id: string;
      bindings: string;
      ts: number;
      session_id: string;
      hook_event: string;
      pid: number | null;
    } | null;
    if (row === null) {
      db.run("COMMIT");
      return null;
    }
    // Parse the stored bindings. A malformed JSON blob is a real bug
    // (the import path validated structure on the way in), but a stored
    // record from a future schema may carry keys we don't know how to
    // bind — we drop those silently per the forward-compat contract.
    // Throwing here would leak `rpc_failed` to the client AND leave the
    // row in `waiting` for the next replay to retry. A schema-bug
    // diagnostic above (logged) would be nice; for now we rely on the
    // import path's parser to reject malformed blobs.
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.bindings);
    } catch (err) {
      // The bindings blob is unparseable. We can't replay the row; throw
      // so the transaction rolls back and the row stays `waiting` for an
      // operator to inspect. The error message names the dl_id so logs
      // pinpoint the offending row.
      throw new Error(
        `replay: bindings JSON parse failed for dl_id ${row.dl_id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        `replay: bindings is not a JSON object for dl_id ${row.dl_id}`,
      );
    }
    const bindings = parsed as Record<string, unknown>;

    // Build the INSERT column list from the intersection of the events
    // column set and the bindings keys. Unknown keys are dropped; missing
    // known keys bind NULL via the `?? null` in the values mapper below.
    // The column list is interpolated directly because EVENTS_COLUMNS is
    // a module constant (no wire text); values are bound positionally.
    const presentCols = EVENTS_COLUMNS.filter((c) =>
      Object.hasOwn(bindings, c),
    );
    if (presentCols.length === 0) {
      throw new Error(
        `replay: bindings carry no recognized events columns for dl_id ${row.dl_id}`,
      );
    }
    const placeholders = presentCols.map(() => "?").join(", ");
    const values = presentCols.map((c) => {
      const v = bindings[c];
      // SQLite storage classes are TEXT / INTEGER / REAL / NULL /
      // BLOB. The dead-letter `bindings` map is constrained to
      // string / number / boolean / null (see
      // `DeadLetterBindings`); booleans serialize as 0/1 here.
      if (typeof v === "boolean") return v ? 1 : 0;
      return v as string | number | null;
    });
    const insertSql = `INSERT INTO events (${presentCols.join(", ")}) VALUES (${placeholders})`;
    const info = db.prepare(insertSql).run(...values);
    const replayedEventId = Number(info.lastInsertRowid);

    db.prepare(
      `UPDATE dead_letters
          SET status = 'recovered',
              recovered_at = ?,
              replayed_event_id = ?
        WHERE dl_id = ?`,
    ).run(Date.now() / 1000, replayedEventId, row.dl_id);

    db.run("COMMIT");
    recoveredDlId = row.dl_id;
  } catch (err) {
    try {
      db.run("ROLLBACK");
    } catch {
      // best-effort; the throw propagates
    }
    throw err;
  }
  return recoveredDlId;
}

/**
 * Force the native `@parcel/watcher` N-API addon to dlopen ONCE on the main
 * thread before any watcher worker spawns (fn-701 task .3).
 *
 * The bug: the daemon spawns six `@parcel/watcher`-loading workers (transcript,
 * plan, git, usage, dead-letter, zellij-events) back-to-back. Each does its own
 * `import("@parcel/watcher")` — and if those FIRST dlopens of the addon race
 * concurrently, Bun crashes the workers with `symbol 'napi_register_module_v1'
 * not found in native module` (residual Bun #15942 many-worker-spawn fragility;
 * Bun v1.3.5 already fixed the original main+worker double-load case). On the
 * daemon's actual bun (1.3.14) this was reproduced reliably under N≥16 concurrent
 * worker dlopens; it crash-loops the daemon at boot (every worker rejects → main
 * `fatalExit` → launchd restart → same race).
 *
 * The fix: a synchronous `require("@parcel/watcher")` on main. CJS `require` is
 * synchronous, so it forces the addon's first dlopen + `napi_register_module_v1`
 * to complete on main BEFORE the spawn block runs. Each worker still does its own
 * `import()` and gets its own `napi_env` (this is NOT a shared watcher — the
 * Worker contract's per-worker subscription ownership is untouched), but the
 * addon is already registered, so the worker dlopens no longer race a
 * not-yet-registered module. The repro check confirmed pre-warm ALONE eliminates
 * the failure (0 failures across 40+ runs at N=8/16/24), so NO spawn staggering
 * is needed — the workers may still spawn back-to-back.
 *
 * A GENUINE permanent load failure (missing `node_modules`, ABI mismatch, a
 * truly broken addon) is unrecoverable — there is no in-process self-heal. This
 * helper logs a LOUD boot assertion (bun version + clear context) so a recurrence
 * is diagnosable instead of a silent crash-loop, then RE-THROWS; the caller takes
 * the single recovery path (`process.exit(1)` → launchd restart). It is split out
 * (pure, injectable `loader` + `logError`) so a test can force the failure branch
 * and assert the loud assertion fires without a real broken addon.
 *
 * Exported for direct test reach.
 */
export function prewarmWatcherAddon(
  loader: () => unknown = () => require("@parcel/watcher"),
  logError: (msg: string) => void = (msg) => console.error(msg),
): void {
  try {
    // Synchronous — forces the first dlopen to finish on main before any worker
    // thread runs its own `import("@parcel/watcher")`.
    loader();
  } catch (err) {
    // Loud boot assertion. Bun version + explicit context so a recurrence is a
    // greppable signal, not a silent loop. The caller escalates to fatalExit;
    // we do NOT downgrade a genuine missing-addon to a warning.
    logError(
      `[keeperd] FATAL: @parcel/watcher addon failed to load after pre-warm ` +
        `on bun ${Bun.version} — the daemon cannot watch filesystem trees and ` +
        `will exit for the LaunchAgent to restart. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
    throw err;
  }
}

/**
 * Run the daemon. Returns once the process is wired up and the steady-state
 * wake loop is running; the loop itself keeps the event loop alive until SIGTERM
 * or a crash. Exported (rather than executed at import) so a test can drive boot
 * drain in isolation via {@link drainToCompletion} without spawning the worker.
 */
function runDaemon(): void {
  process.title = "keeperd";

  const dbPath = resolveDbPath();
  // 256MB page cache on the writer connection: folds run here under the
  // BEGIN IMMEDIATE write lock, and the default ~8MB cache evicted hot
  // attribution-index pages between folds — a fold revisiting cold pages on the
  // ~850MB log paid seconds of I/O and starved concurrent hook INSERTs into
  // dead-letters. Retaining the working set keeps folds fast (and the lock
  // short). The short-lived hook deliberately keeps the small default.
  const { db, stmts } = openDb(dbPath, { cacheSizeKb: 262144 });

  // Step 1b — schema-v13 planctl approval migration (filesystem half). The
  // SQL half (ADD COLUMN `epics.approval` + DROP TABLE `approvals`) ran
  // inside `openDb`'s migrate(). This pass backfills `approval: "approved"`
  // onto every existing epic plan file lacking the field and overlays each
  // (about-to-be-dropped) approvals-table row onto the matching epic/task
  // plan file. MUST run before the plan worker spawns: a watcher callback
  // on a half-migrated tree would post a stale snapshot. Naturally
  // idempotent — a missing-field check skips already-migrated files, the
  // overlay reads from `approvals` (returns 0 rows after the DROP), and the
  // table-exists guard skips the SELECT entirely on a fresh-v13 DB.
  const planRoots = resolvePlanRoots();
  runPlanctlApprovalMigration(db, planRoots);

  // Step 2 — boot drain + seed sweep, wrapped in boot-drain WAL tuning so the
  // (potentially from-scratch) re-fold doesn't starve concurrent hook INSERTs
  // on synchronous WAL checkpoints. See `withBootDrainCheckpointTuning`.
  //
  // The drain MUST finish before the worker spawns: otherwise the worker would
  // fire wakes against a writer connection still iterating boot drain
  // (harmless, drain is idempotent, but wasteful). The pre-sweep drain also
  // brings the `jobs` projection up to the latest persisted lifecycle BEFORE
  // `seedKilledSweep` reads it — without this, a SessionEnd that landed
  // mid-boot would still look like a live row to the sweep.
  //
  // Step 2a — seed sweep. Fold dead/recycled jobs to `killed` BEFORE the
  // workers spawn, so the projection is consistent the moment the UDS server
  // starts serving. See `seedKilledSweep` for the Q7 match rules; the trailing
  // drain folds the synthetic Killed events the sweep just emitted.
  //
  // Boot-pacing: a stateless boot-phase parameter that gates a short OS-level
  // sleep AFTER each fold's COMMIT in the SAME `drain()` function steady
  // state uses (single drain path; CLAUDE.md "one drain code path serves
  // boot and steady-state" invariant preserved). Bounded by
  // `BOOT_DRAIN_PACE_EVENTS` so a from-scratch re-fold catches up to head in
  // bounded time; steady-state wakes pass no options and behave exactly as
  // before. The seed sweep itself is a synchronous write block between the
  // two drain passes, so the SECOND drain's pacing budget starts fresh —
  // covering the post-sweep window where the freshly-emitted `Killed`
  // events are folded and a concurrent hook might race the seed-sweep's
  // own writer lock-release.
  const bootPace: DrainOptions = {
    paceMs: BOOT_DRAIN_PACE_MS,
    paceEvents: BOOT_DRAIN_PACE_EVENTS,
  };
  withBootDrainCheckpointTuning(db, () => {
    drainToCompletion(db, DEFAULT_BATCH_SIZE, bootPace);
    seedKilledSweep(db);
    // fn-667 task .1: unconditional boot-append of an
    // `AutopilotPaused{paused:true}` re-arm. The autopilot worker boots
    // PAUSED in memory (safety default); this synthetic event preserves
    // that safety guarantee in the durable `autopilot_state` projection
    // so the viewer's banner reads `[paused]` honestly from boot, not
    // from a hardcoded fallback. The trailing `drainToCompletion` folds
    // the re-arm BEFORE `serverWorker` spawns below — so a viewer
    // subscribing the instant the socket opens reads a real row (the
    // boot re-arm), never an empty surface.
    //
    // Raw `db.run` INSERT (not `stmts.insertEvent.run`) mirrors
    // `seedKilledSweep`'s `insertKilledEvent` pattern — the column list
    // MUST stay in sync with the prepared-statement form in
    // `prepareStmts`. A future events-column add touches both sites.
    //
    // Re-fold cost: ~1 event per daemon restart. Documented in CLAUDE.md
    // ("Boot-event-every-start is a generic-ES anti-pattern — but
    // keeper's re-fold ≠ replay") and in db.ts's v46→v47 stamp slot
    // — accepted in exchange for re-fold determinism (no migration
    // seed → `created_at` derived purely from the event log).
    db.run(
      `INSERT INTO events (
         ts, session_id, pid, hook_event, event_type, tool_name, matcher,
         cwd, permission_mode, agent_id, agent_type, stop_hook_active, data,
         subagent_agent_id, spawn_name, start_time, slash_command, skill_name,
         planctl_op, planctl_target, planctl_epic_id, planctl_task_id,
         planctl_subject_present, tool_use_id, config_dir, planctl_queue_jump,
         bash_mutation_kind, bash_mutation_targets, planctl_files
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Date.now() / 1000, // unix seconds as REAL — matches the hook + every other synthetic
        "autopilot", // stable synthetic session_id (matches the RPC bridge mint above)
        null, // pid — synthetic event has no process identity
        "AutopilotPaused",
        "autopilot_state", // synthetic event_type tag
        null, // tool_name
        null, // matcher
        null, // cwd
        null, // permission_mode
        null, // agent_id
        null, // agent_type
        null, // stop_hook_active
        JSON.stringify({ paused: true }), // boot re-arm — always paused
        null, // subagent_agent_id
        null, // spawn_name
        null, // start_time
        null, // slash_command
        null, // skill_name
        null, // planctl_op
        null, // planctl_target
        null, // planctl_epic_id
        null, // planctl_task_id
        null, // planctl_subject_present
        null, // tool_use_id
        null, // config_dir
        null, // planctl_queue_jump
        null, // bash_mutation_kind
        null, // bash_mutation_targets
        null, // planctl_files
      ],
    );
    drainToCompletion(db, DEFAULT_BATCH_SIZE, bootPace);
  });

  // Step 2b — dead-letter boot import (fn-643 task .3). Read every NDJSON
  // file the hook wrote during downtime / since the last daemon run and
  // INSERT OR IGNORE each parsed record into `dead_letters` as `waiting`.
  // MUST run before the dead-letter worker spawns (and before the server
  // worker starts serving): a board client subscribing the moment the
  // socket comes up must see the full `waiting` backlog, not a partially
  // imported one. The scan is idempotent (`INSERT OR IGNORE` on `dl_id`),
  // so a re-scan is harmless. Missing dir is tolerated (fresh machine).
  // This is a DIRECT operational-table write — NOT an event fold.
  const deadLetterDir = resolveDeadLetterDir();
  scanDeadLetterDir(db, deadLetterDir);

  // Step 2c — ensure the zellij-events dir exists on boot (fn-684 task .4).
  // The bridge plugin is loaded GLOBALLY into every zellij session by the
  // human's dotfiles `~/.config/zellij/config.kdl` `load_plugins` block,
  // which pins the plugin's `cwd` (= its WASI `/host` mount) to this
  // directory. zellij silently refuses to load a plugin whose `cwd` is
  // missing, so the dir MUST exist before ANY session's plugin loads.
  // The mkdir is the FIRST thing we do for the zellij-events pipeline so
  // it runs before BOTH the boot scan below AND the live watcher worker
  // spawned downstream. `recursive: true` makes it idempotent across
  // daemon restarts (already-exists is a no-op); a failure is logged
  // non-fatally — a broken events dir leaves the feed dormant rather
  // than wedging the daemon.
  const zellijEventsDir = resolveZellijEventsDir();
  try {
    mkdirSync(zellijEventsDir, { recursive: true });
  } catch (err) {
    console.error(
      `[keeperd] failed to ensure zellij events dir ${zellijEventsDir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Step 2c.1 — zellij-events boot import (fn-684 task .3). Read every
  // `<session>.ndjson` the bridge plugin wrote during downtime / since
  // the last daemon run, tail each from its persisted byte-offset
  // watermark, and mint one `BackendExecSnapshot` synthetic event per
  // new pane line whose `(session, pane_id)` joins to a live job.
  // Always-on as of fn-684 task .5 — the legacy `backend-worker`
  // poller is retired; the plugin feed is now the sole producer of
  // `jobs.backend_exec_tab_{id,name}`. MUST run before the
  // zellij-events worker spawns: a watcher notification on a
  // half-imported set of files would re-fold work we already have on
  // disk — harmless but wasteful. The watermark sidecar makes the
  // boot scan idempotent across restarts.
  try {
    scanZellijEventsDir(db, stmts, zellijEventsDir);
  } catch (err) {
    console.error(
      `[keeperd] zellij-events boot scan threw (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Coalescing flag: every wake sets it; the run loop resets it before each
  // drain pass. A wake arriving mid-drain leaves the flag set, so the loop runs
  // one more pass. No event is ever missed because drain re-reads from the
  // cursor on every pass.
  let wakePending = false;
  let draining = false;
  let shuttingDown = false;

  // Autopilot in-memory paused flag (fn-661 task .4). Boots PAUSED — the
  // safety default per the epic rollout invariant "first run after deploy
  // dispatches nothing until the human plays". Lives ONLY in main's
  // memory (never persisted; never RPC-writable except via the
  // `set_autopilot_paused` RPC below, which round-trips through the
  // worker-→main bridge and back). The autopilot worker is told via
  // the existing main→worker `{ type: "set-paused", paused }` channel.
  let autopilotPaused = true;
  // Forward reference filled in below when the autopilot worker spawns.
  // The server-worker's bridge handlers (registered just below) capture
  // this via closure so the relay can target the autopilot worker even
  // though the worker reference is assigned later in this function. Until
  // the worker is constructed (a narrow boot window between the bridge
  // wire-up and the actual `new Worker(...)` call), bridge requests
  // resolve `ok:false, error="autopilot worker not yet ready"` — a
  // best-effort surface for the otherwise-impossible boot race.
  let autopilotWorker: Worker | null = null;
  // Forward reference to the plan worker (constructed later in this function),
  // captured by the server-worker bridge's `kick-plan-worker-request` handler
  // (fn-701 task .2). A `set_*_approval` write makes the plan file
  // dirty/uncommitted; the kick drives the plan-worker to re-run its GATED
  // `recheckPending()` promptly instead of waiting on the 60s heartbeat.
  // Until the plan worker is constructed (the same narrow boot window the
  // autopilot forward-ref above guards), a kick request is a tolerated no-op
  // — the heartbeat backstop covers the gap, identical to a dropped signal.
  let planWorkerRef: Worker | null = null;
  // Forward reference to the git worker (constructed AFTER the plan worker),
  // captured by the plan-worker `onmessage` handler's fn-705 discovery-nudge
  // forward. The plan-worker posts a `nudge-discovery` the first time it sees a
  // `.planctl` tree in a repo; main relays it to the git-worker as an
  // `add-discovery-root` so the git-worker watches that repo's `.git`
  // immediately. `null` until the git worker is constructed — a nudge during
  // that boot window is a tolerated no-op (the next full discovery sweep
  // recovers it), mirroring the `planWorkerRef` ordering tolerance.
  let gitWorkerRef: Worker | null = null;

  /**
   * Process the wake signal. Re-entrancy guard (`draining`) ensures we never
   * call drain recursively if a wake lands while we're already inside the loop;
   * that wake just leaves `wakePending` set for the in-flight loop to pick up.
   */
  function pumpWakes(): void {
    if (draining) {
      return;
    }
    draining = true;
    let folded = false;
    try {
      while (wakePending && !shuttingDown) {
        wakePending = false;
        drainToCompletion(db);
        folded = true;
      }
    } finally {
      draining = false;
    }
    // fn-694 lever B: kick the server-worker AFTER the drain loop returns
    // (post-COMMIT) so it runs `diffTick` immediately instead of waiting for
    // its next ~50ms poll tick — collapsing the second of the two serial
    // `data_version` polls in the hook→fold→patch pipeline. Posted strictly
    // after `drainToCompletion` so the worker never reads a pre-commit
    // `data_version`. The worker's level-triggered `pollLoop` stays as the
    // backstop for any lost-wakeup; the kick handler is idempotent (diffTick
    // is version-gated). Skip on a no-op pump (re-entrant wake that folded
    // nothing) and during shutdown.
    if (folded && !shuttingDown) {
      serverWorker.postMessage({ type: "kick" } satisfies KickMessage);
      // fn-699: also kick the tab-namer so it runs its reconcile tick
      // immediately. A fold may have moved `title` (transcript worker) or
      // `backend_exec_tab_name` (zellij-events feed drift), and the renamer
      // must re-converge the tab name. Same edge-triggered hint as the
      // server-worker kick; the tab-namer's `data_version` poll is the
      // lost-wakeup backstop, and its tick is idempotent so a kick+poll
      // double-fire is a harmless no-op.
      tabNamerWorker.postMessage({ type: "kick" } satisfies KickMessage);
    }
  }

  // Step 2d — pre-warm the native @parcel/watcher addon ON MAIN before ANY
  // worker spawns (fn-701 task .3). Six of the workers below
  // (transcript / plan / git / usage / dead-letter / zellij-events) each run
  // their own `import("@parcel/watcher")`; spawned back-to-back, their FIRST
  // dlopens race and crash with `napi_register_module_v1 not found` (residual
  // Bun #15942). A synchronous main-thread require forces a single serialized
  // first dlopen so the addon is already registered when the workers import it
  // — the repro check showed this ALONE fixes the race (no spawn staggering
  // needed). A genuine permanent load failure logs the loud boot assertion
  // inside the helper, then we take the single recovery path. See
  // {@link prewarmWatcherAddon}.
  try {
    prewarmWatcherAddon();
  } catch {
    // The loud assertion (bun version + context) already fired inside the
    // helper. Escalate to the sole recovery path — exit non-zero so launchd
    // restarts us. NO in-process self-heal.
    fatalExit();
    return;
  }

  // Step 3 — spawn the wake worker. Bun uses the web Worker API; `workerData`
  // is a worker_threads option not in the DOM lib type, hence the cast.
  const worker = new Worker(new URL("./wake-worker.ts", import.meta.url).href, {
    workerData: { dbPath, pollMs: 25 } satisfies WakeWorkerData,
  } as WorkerOptions & { workerData: unknown });

  // Step 4 — each wake message triggers a (coalescing) drain pass.
  worker.onmessage = (ev: MessageEvent<WakeMessage | undefined>): void => {
    if (ev.data && ev.data.kind === "wake") {
      wakePending = true;
      pumpWakes();
    }
  };

  // Worker `error` event is NOT a message — it signals the worker thread itself
  // failed. Per the single-recovery-path policy: crash → exit 1 → launchd
  // restarts. Do NOT attempt to respawn the worker in-process.
  worker.onerror = (err: ErrorEvent): void => {
    console.error("[keeperd] wake worker error:", err.message ?? err);
    fatalExit();
  };

  // A worker `process.exit(1)` (e.g. its own fatalExit) fires `close`, NOT
  // `onerror` — so the steady-state crash path needs its own listener, or a
  // crashing worker leaves a zombie daemon and launchd is never notified. The
  // `!shuttingDown` guard makes this a no-op on the clean path (shutdown() sets
  // the flag before posting `{ type: "shutdown" }`), avoiding a double exit.
  worker.addEventListener("close", () => {
    if (!shuttingDown) fatalExit();
  });

  // Spawn the server worker in the SAME post-migration window: its read-only
  // `openDb` would fail loud against a missing/un-migrated DB. It binds the UDS,
  // acquires the ownership lock, and runs its own `data_version` poll — fully
  // decoupled from the reducer. `dbPath` is the only required field; sock/lock
  // paths default to `resolveSockPath()` worker-side (KEEPER_SOCK honored there).
  const serverWorker = new Worker(
    new URL("./server-worker.ts", import.meta.url).href,
    {
      workerData: { dbPath, role: "server" } satisfies ServerWorkerData,
    } as WorkerOptions & { workerData: unknown },
  );

  // Server-worker → main bridge. Originally the `replay_dead_letter`
  // round-trip (fn-643 task .4); extended for fn-661 task .4 with the
  // autopilot pause/retry pair. Every inbound message carries a `kind`
  // discriminator so a stale reply for one verb can't wrong-resolve
  // another. The `{kind:"ready"}` signal is one-way (worker→main only)
  // and matches no branch — silently dropped.
  serverWorker.onmessage = (
    ev: MessageEvent<
      | ReplayRequestMessage
      | SetAutopilotPausedRequestMessage
      | RetryDispatchRequestMessage
      | KickPlanWorkerRequestMessage
      | { kind: "ready" }
      | undefined
    >,
  ): void => {
    const msg = ev.data;
    if (!msg) return;
    if (msg.kind === "kick-plan-worker-request") {
      // fn-701 task .2: a `set_*_approval` write succeeded in the
      // server-worker. The approval mutation left the plan file
      // dirty/uncommitted, so kick the plan-worker into a GATED
      // `recheckPending()` (NOT a bypass — an uncommitted approval must stay
      // gated, or the fn-627 duplicate-dispatch incident re-opens). One-way:
      // no reply, no correlation id. Null-guarded for the boot race (the plan
      // worker is constructed later in this function); wrapped in try/catch so
      // a transport hiccup on this cosmetic fast-path can NEVER bounce the
      // daemon (no in-process self-heal). The fn-705 plan-worker `data_version`
      // poll is the level-triggered lost-wakeup backstop (the 5s heartbeat is
      // the should-never-fire paranoia floor beneath it).
      try {
        planWorkerRef?.postMessage({ type: "kick" } satisfies KickMessage);
      } catch (err) {
        console.error(
          "[keeperd] plan-worker kick post failed:",
          err instanceof Error ? err.message : err,
        );
      }
      return;
    }
    if (msg.kind === "replay-request") {
      const id = msg.id;
      let reply: ReplayResultMessage;
      try {
        const recoveredDlId = recoverOneDeadLetter(db);
        reply = {
          type: "replay-result",
          id,
          ok: true,
          recovered_dl_id: recoveredDlId,
        };
        if (recoveredDlId !== null) {
          // We appended a real `events` row. Pump a wake so the reducer
          // folds it (jobs / epics / etc.) without waiting for the wake
          // worker's `data_version` poll — symmetry with the other
          // synthetic-event mint sites in this file.
          wakePending = true;
          pumpWakes();
        }
      } catch (err) {
        // The recovery transaction crashed (programming bug or a DB-level
        // failure). Surface as a typed `ok:false` reply; the worker's
        // dispatcher frames `rpc_failed` on the wire.
        reply = {
          type: "replay-result",
          id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      serverWorker.postMessage(reply);
      return;
    }
    if (msg.kind === "set-autopilot-paused-request") {
      // Fn-661 task .4 / fn-667 task .1. APPEND an `AutopilotPaused`
      // synthetic event FIRST onto the writable connection so the reducer
      // folds it into the `autopilot_state` singleton on the next drain
      // (the viewer's banner-truth substrate). THEN — only on a successful
      // insert — flip the in-memory `autopilotPaused` flag and relay a
      // `{type:"set-paused"}` command to the autopilot worker. Order
      // matters: the gate (worker dispatch decision) and the projection
      // (viewer-visible state) MUST NOT diverge on a partial failure. If
      // the insert throws, neither side flips and the RPC returns
      // `ok:false` — the human's pause/play attempt is rejected loud
      // rather than silently dropped half-way.
      //
      // Mirrors the retry-dispatch handler's mint pattern (same column
      // list — keep them in sync on any future events-column add). The
      // session_id is a stable synthetic constant (`"autopilot"`) so
      // every AutopilotPaused row groups onto the same key — useful for
      // event-log scans and matches the producer-side convention every
      // other singleton-bound synthetic uses.
      //
      // Surfaces `ok:false` ONLY if the autopilot worker isn't constructed
      // yet (a narrow boot race between this bridge wire-up and the worker
      // spawn below) OR the insert throws (a writer-lock contention or DB
      // failure). The worker is always present in steady state; the
      // insert is one prepared-statement run, no scan.
      let reply: SetAutopilotPausedResultMessage;
      if (autopilotWorker === null) {
        reply = {
          type: "set-autopilot-paused-result",
          id: msg.id,
          ok: false,
          error: "autopilot worker not yet ready",
        };
      } else {
        try {
          stmts.insertEvent.run({
            $ts: Date.now() / 1000,
            $session_id: "autopilot",
            $pid: null,
            $hook_event: "AutopilotPaused",
            $event_type: "autopilot_state",
            $tool_name: null,
            $matcher: null,
            $cwd: null,
            $permission_mode: null,
            $agent_id: null,
            $agent_type: null,
            $stop_hook_active: null,
            $data: JSON.stringify({ paused: msg.paused }),
            $subagent_agent_id: null,
            $spawn_name: null,
            $start_time: null,
            $slash_command: null,
            $skill_name: null,
            $planctl_op: null,
            $planctl_target: null,
            $planctl_epic_id: null,
            $planctl_task_id: null,
            $planctl_subject_present: null,
            $config_dir: null,
            $planctl_queue_jump: null,
            $bash_mutation_kind: null,
            $bash_mutation_targets: null,
            $planctl_files: null,
            $backend_exec_type: null,
            $backend_exec_session_id: null,
            $backend_exec_pane_id: null,
          });
          wakePending = true;
          pumpWakes();
          // Only AFTER the event is durably appended do we flip the
          // in-memory gate + relay to the worker. A throw above leaves
          // both untouched.
          autopilotPaused = msg.paused;
          autopilotWorker.postMessage({
            type: "set-paused",
            paused: msg.paused,
          });
          reply = {
            type: "set-autopilot-paused-result",
            id: msg.id,
            ok: true,
          };
        } catch (err) {
          reply = {
            type: "set-autopilot-paused-result",
            id: msg.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
      serverWorker.postMessage(reply);
      return;
    }
    if (msg.kind === "retry-dispatch-request") {
      // Fn-661 task .4. Append a `DispatchCleared` synthetic event onto
      // the writable connection so the reducer's fold arm DELETEs the
      // matching `dispatch_failures` row on the next drain. Mirrors the
      // git-worker mint pattern (insertEvent.run + wakePending=true +
      // pumpWakes). The wire `verb` is already validated to be one of
      // `work` / `close` / `approve`; the wire `dispatch_id` is a
      // non-empty token (validated handler-side); main treats both as
      // opaque payload tokens.
      const id = msg.id;
      let reply: RetryDispatchResultMessage;
      try {
        const data = JSON.stringify({
          verb: msg.verb,
          id: msg.dispatch_id,
        });
        stmts.insertEvent.run({
          $ts: Date.now() / 1000,
          // The dispatch key rides as the entity-key overload so a
          // re-fold can correlate the event to its dispatch_failures
          // row without re-parsing the data blob. Same convention as
          // every other synthetic minted on main (the producer-side
          // composite `${verb}::${id}` is unambiguous).
          $session_id: `${msg.verb}::${msg.dispatch_id}`,
          $pid: null,
          $hook_event: "DispatchCleared",
          $event_type: "dispatch_failures",
          $tool_name: null,
          $matcher: null,
          $cwd: null,
          $permission_mode: null,
          $agent_id: null,
          $agent_type: null,
          $stop_hook_active: null,
          $data: data,
          $subagent_agent_id: null,
          $spawn_name: null,
          $start_time: null,
          $slash_command: null,
          $skill_name: null,
          $planctl_op: null,
          $planctl_target: null,
          $planctl_epic_id: null,
          $planctl_task_id: null,
          $planctl_subject_present: null,
          $config_dir: null,
          $planctl_queue_jump: null,
          $bash_mutation_kind: null,
          $bash_mutation_targets: null,
          $planctl_files: null,
          $backend_exec_type: null,
          $backend_exec_session_id: null,
          $backend_exec_pane_id: null,
        });
        wakePending = true;
        pumpWakes();
        reply = { type: "retry-dispatch-result", id, ok: true };
      } catch (err) {
        reply = {
          type: "retry-dispatch-result",
          id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      serverWorker.postMessage(reply);
      return;
    }
  };

  // Same crash policy as the wake worker: any thread failure → fatalExit → exit
  // 1 → launchd restart. No in-process respawn.
  serverWorker.onerror = (err: ErrorEvent): void => {
    console.error("[keeperd] server worker error:", err.message ?? err);
    fatalExit();
  };

  // Same crash-via-`close` gap as the wake worker: a server-worker
  // `process.exit(1)` fires `close`, not `onerror`. Without this the subscribe
  // server could silently vanish while the reducer kept running. `!shuttingDown`
  // makes it inert on the clean shutdown path.
  serverWorker.addEventListener("close", () => {
    if (!shuttingDown) fatalExit();
  });

  // Spawn the transcript worker in the SAME post-migration window. It watches
  // the external transcript tree and posts a `transcript-title` message whenever
  // it tails a `custom-title` line — making the daemon an event PRODUCER for the
  // first time. The watch root is resolved ON MAIN via `resolveClaudeProjectsRoot()`
  // (config `claude_projects_root` → absolute path, default `~/.claude/projects`)
  // and passed as the always-populated `workerData.watchRoot`, mirroring how the
  // plan worker receives `roots: resolvePlanRoots()`.
  if (process.env.KEEPER_WATCH_ROOT) {
    console.error(
      "[keeperd] KEEPER_WATCH_ROOT is deprecated and ignored; set `claude_projects_root` in ~/.config/keeper/config.yaml instead",
    );
  }
  const transcriptWorker = new Worker(
    new URL("./transcript-worker.ts", import.meta.url).href,
    {
      workerData: {
        dbPath,
        watchRoot: resolveClaudeProjectsRoot(),
      } satisfies TranscriptWorkerData,
    } as WorkerOptions & { workerData: unknown },
  );

  // Main stays the SOLE writer: a worker `transcript-title` message becomes a
  // synthetic `TranscriptTitle` events row inserted on the existing WRITABLE
  // connection, then a wake pump folds it (priority-3 'transcript' title). The
  // insert is synchronous on the main thread and so cannot interleave with the
  // synchronous drain inside pumpWakes. Bindings are named — see the comment on
  // `stmts.insertEvent` in `src/db.ts` for why. The title rides in
  // `data.session_title` (the same field the reducer's title rule reads);
  // everything else is NULL (synthetic — never carries a process identity).
  transcriptWorker.onmessage = (
    ev: MessageEvent<
      TranscriptTitleMessage | ApiErrorMessage | InputRequestMessage | undefined
    >,
  ): void => {
    const msg = ev.data;
    if (!msg) {
      return;
    }
    if (msg.kind === "transcript-title") {
      stmts.insertEvent.run({
        $ts: Date.now() / 1000, // unix seconds as REAL, matching the hook
        $session_id: msg.sessionId, // == job_id
        $pid: null,
        $hook_event: "TranscriptTitle", // synthetic; reducer maps → 'transcript'
        $event_type: "transcript_title",
        $tool_name: null,
        $matcher: null,
        $cwd: null,
        $permission_mode: null,
        $agent_id: null,
        $agent_type: null,
        $stop_hook_active: null,
        $data: JSON.stringify({ session_title: msg.title }),
        $subagent_agent_id: null,
        $spawn_name: null,
        $start_time: null,
        $slash_command: null,
        $skill_name: null,
        $planctl_op: null,
        $planctl_target: null,
        $planctl_epic_id: null,
        $planctl_task_id: null,
        $planctl_subject_present: null,
        $config_dir: null,
        $planctl_queue_jump: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $planctl_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
      });
      // Our own INSERT bumps data_version, so the wake worker would re-drain
      // anyway — but pump directly so the title folds without a poll-cycle delay.
      wakePending = true;
      pumpWakes();
      return;
    }
    if (msg.kind === "api-error") {
      // Synthetic `ApiError` event minted from the transcript-worker
      // signal — Claude Code wrote its `isApiErrorMessage: true` synthetic
      // assistant turn to the JSONL, naming the failure mode via a
      // bare-string `error` field (`rate_limit` / `authentication_failed` /
      // `billing_error` / `server_error` / `invalid_request`; anything
      // else routed through the matcher's `"unknown"` fallback). The
      // reducer's dual-case `RateLimited` / `ApiError` arm (schema v24)
      // folds this row by flipping `jobs.state` to `'stopped'` AND
      // stamping `(last_api_error_at, last_api_error_kind)` to the event
      // ts + the matched kind in a single compound UPDATE
      // (re-fold-deterministic). Everything other than `session_id` /
      // `hook_event` / `event_type` / `data` is NULL — synthetics never
      // carry a process identity. The matched kind rides in `data.kind`
      // (read by the reducer's `extractApiErrorKind`); the display text
      // rides alongside in `data.text` for downstream consumers. The
      // pre-v24 `RateLimited` event_type is still folded by the same arm
      // via the dual-case alias so the historical event log re-folds
      // byte-deterministically — we never re-mint it.
      stmts.insertEvent.run({
        $ts: Date.now() / 1000,
        $session_id: msg.sessionId,
        $pid: null,
        $hook_event: "ApiError",
        $event_type: "api_error",
        $tool_name: null,
        $matcher: null,
        $cwd: null,
        $permission_mode: null,
        $agent_id: null,
        $agent_type: null,
        $stop_hook_active: null,
        $data: JSON.stringify({ kind: msg.errorKind, text: msg.text }),
        $subagent_agent_id: null,
        $spawn_name: null,
        $start_time: null,
        $slash_command: null,
        $skill_name: null,
        $planctl_op: null,
        $planctl_target: null,
        $planctl_epic_id: null,
        $planctl_task_id: null,
        $planctl_subject_present: null,
        $config_dir: null,
        $planctl_queue_jump: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $planctl_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
      });
      wakePending = true;
      pumpWakes();
      return;
    }
    if (msg.kind === "input-request") {
      // Synthetic `InputRequest` event minted from the transcript-worker
      // signal — Claude Code used a built-in interactive tool that fires
      // no Pre/PostToolUse hook of its own (initially `AskUserQuestion`).
      // The reducer's `InputRequest` arm (schema v25) folds this row by
      // flipping `jobs.state` to `'stopped'` AND stamping
      // `(last_input_request_at, last_input_request_kind)` to the event
      // ts + the matched kind in a single compound UPDATE
      // (re-fold-deterministic). Everything other than `session_id` /
      // `hook_event` / `event_type` / `data` is NULL — synthetics never
      // carry a process identity. The matched kind rides in `data.kind`
      // (read by the reducer's `extractInputRequestKind`). Mirrors the
      // `api-error` branch above structurally; the transcript matcher
      // arrives in task .2 of fn-617 — until then no `InputRequest`
      // event ever lands and this branch is unreachable in practice,
      // but landing the mint + the reducer arm together preserves the
      // re-fold determinism invariant (an event log emitted by a
      // future task .2 must fold the same way under a re-fold from
      // scratch on this code).
      stmts.insertEvent.run({
        $ts: Date.now() / 1000,
        $session_id: msg.sessionId,
        $pid: null,
        $hook_event: "InputRequest",
        $event_type: "input_request",
        $tool_name: null,
        $matcher: null,
        $cwd: null,
        $permission_mode: null,
        $agent_id: null,
        $agent_type: null,
        $stop_hook_active: null,
        $data: JSON.stringify({ kind: msg.requestKind }),
        $subagent_agent_id: null,
        $spawn_name: null,
        $start_time: null,
        $slash_command: null,
        $skill_name: null,
        $planctl_op: null,
        $planctl_target: null,
        $planctl_epic_id: null,
        $planctl_task_id: null,
        $planctl_subject_present: null,
        $config_dir: null,
        $planctl_queue_jump: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $planctl_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
      });
      wakePending = true;
      pumpWakes();
      return;
    }
  };

  // Same crash policy as the other workers: any thread failure → fatalExit.
  transcriptWorker.onerror = (err: ErrorEvent): void => {
    console.error("[keeperd] transcript worker error:", err.message ?? err);
    fatalExit();
  };

  // Same crash-via-`close` gap: a transcript-worker `process.exit(1)` fires
  // `close`, not `onerror`. `!shuttingDown` makes it inert on clean shutdown.
  transcriptWorker.addEventListener("close", () => {
    if (!shuttingDown) fatalExit();
  });

  // Spawn the plan worker in the SAME post-migration window. It watches each
  // configured project root's `.planctl/{epics,tasks}` trees and posts a
  // `plan-epic`/`plan-task` snapshot message on each change — the second
  // producer-worker instance. `roots` come from `resolvePlanRoots()` (config →
  // absolute, existing dirs); an empty list means there is nothing to watch.
  const planWorker = new Worker(
    new URL("./plan-worker.ts", import.meta.url).href,
    {
      workerData: {
        dbPath,
        roots: planRoots,
      } satisfies PlanWorkerData,
    } as WorkerOptions & { workerData: unknown },
  );
  // fn-701 task .2: publish the plan-worker reference so the server-worker
  // bridge's `kick-plan-worker-request` handler (wired ABOVE, before this
  // construction) can post a `{type:"kick"}` to it. The forward-ref is `null`
  // until this line runs; the bridge handler null-guards for that boot window.
  planWorkerRef = planWorker;

  // Main stays the SOLE writer: a `plan-epic`/`plan-task` snapshot message
  // becomes a synthetic `EpicSnapshot`/`TaskSnapshot` events row inserted on the
  // existing WRITABLE connection, then a wake pump folds it (snapshot upsert into
  // the `epics`/`tasks` projection). The entity id rides in `session_id` (the
  // generic entity-key overload the reducer reads); the full snapshot rides in
  // `data` (the same field `extractPlanSnapshot` parses) with the producer's
  // pre-computed fields mapped to the projection's column names. Mirrors the
  // `transcript-title` branch exactly; bindings are named (see `stmts.insertEvent`
  // in `src/db.ts`). Everything other than session_id/hook_event/event_type/data
  // is NULL (synthetic — never carries a process identity).
  planWorker.onmessage = (
    ev: MessageEvent<PlanWorkerOutbound | undefined>,
  ): void => {
    const msg = ev.data;
    if (!msg) {
      return;
    }
    if (msg.kind === "nudge-discovery") {
      // fn-705 discovery nudge: the plan-worker first saw a `.planctl` tree in
      // `msg.root`. Forward to the git-worker so it folds the root into its
      // discovery candidates and watches that repo's `.git` immediately
      // (attribution/GitSnapshot data then flows). NOT written to the event log
      // — it drives a producer worker, not a projection. The forward-ref
      // null-guards the boot window before the git worker is constructed.
      gitWorkerRef?.postMessage({
        type: "add-discovery-root",
        root: msg.root,
      } satisfies AddDiscoveryRootMessage);
      return;
    }
    let hookEvent: string;
    let data: string;
    if (msg.kind === "plan-epic") {
      hookEvent = "EpicSnapshot";
      data = JSON.stringify({
        epic_number: msg.number,
        title: msg.title,
        project_dir: msg.projectDir,
        status: msg.status,
        approval: msg.approval,
        depends_on_epics: msg.dependsOnEpics,
        last_validated_at: msg.lastValidatedAt,
      });
    } else if (msg.kind === "plan-task") {
      hookEvent = "TaskSnapshot";
      data = JSON.stringify({
        epic_id: msg.epicId,
        task_number: msg.number,
        title: msg.title,
        target_repo: msg.targetRepo,
        // Planctl-native effort tier (fn-602): rides FREE in the embedded-
        // tasks JSON — no schema column, no migration. A pre-fn-602
        // TaskSnapshot blob lacks this key and the reducer reads
        // `snapshot.tier ?? null` (graceful-degradation precedent shared with
        // `worker_phase`/`runtime_status`).
        tier: msg.tier,
        // Renamed from the legacy `status` field. The producer surfaces the
        // derived worker-phase binary (`worker_done_at` present → "done", else
        // "open") under its new name to free up `runtime_status` (sibling
        // below) for planctl's native enum.
        worker_phase: msg.workerPhase,
        // Planctl-native runtime status (`todo|in_progress|done|blocked`)
        // ingested from `.planctl/state/tasks/<task_id>.state.json`. Threads
        // through the synthetic-event pipeline so a re-fold reproduces it.
        runtime_status: msg.runtimeStatus,
        approval: msg.approval,
        depends_on: msg.dependsOn,
      });
    } else if (msg.kind === "plan-epic-deleted") {
      // Tombstone: the reducer deletes the `epics` row (embedded tasks vanish
      // with it). No payload beyond the pk in session_id.
      hookEvent = "EpicDeleted";
      data = "";
    } else if (msg.kind === "plan-task-deleted") {
      // Tombstone: the reducer splices the element out of the parent epic's
      // embedded array. The parent key rides in the `data` blob (the deleted
      // file is gone, so the producer recovered it from the change-gate).
      hookEvent = "TaskDeleted";
      data = JSON.stringify({ epic_id: msg.epicId });
    } else {
      return;
    }
    stmts.insertEvent.run({
      $ts: Date.now() / 1000, // unix seconds as REAL, matching the hook
      $session_id: msg.id, // the entity pk: epic_id / task_id
      $pid: null,
      $hook_event: hookEvent, // synthetic; reducer folds into epics/tasks
      $event_type: "plan_snapshot",
      $tool_name: null,
      $matcher: null,
      $cwd: null,
      $permission_mode: null,
      $agent_id: null,
      $agent_type: null,
      $stop_hook_active: null,
      $data: data, // the full snapshot blob
      $subagent_agent_id: null,
      $spawn_name: null,
      $start_time: null,
      $slash_command: null,
      $skill_name: null,
      $planctl_op: null,
      $planctl_target: null,
      $planctl_epic_id: null,
      $planctl_task_id: null,
      $planctl_subject_present: null,
      $config_dir: null,
      $planctl_queue_jump: null,
      $bash_mutation_kind: null,
      $bash_mutation_targets: null,
      $planctl_files: null,
      $backend_exec_type: null,
      $backend_exec_session_id: null,
      $backend_exec_pane_id: null,
    });
    // Our own INSERT bumps data_version, so the wake worker would re-drain
    // anyway — but pump directly so the snapshot folds without a poll-cycle delay.
    wakePending = true;
    pumpWakes();
  };

  // Same crash policy as the other workers: any thread failure → fatalExit.
  planWorker.onerror = (err: ErrorEvent): void => {
    console.error("[keeperd] plan worker error:", err.message ?? err);
    fatalExit();
  };

  // Same crash-via-`close` gap: a plan-worker `process.exit(1)` fires `close`,
  // not `onerror`. `!shuttingDown` makes it inert on clean shutdown.
  planWorker.addEventListener("close", () => {
    if (!shuttingDown) fatalExit();
  });

  // Spawn the exit-watcher worker in the SAME post-migration window. It owns
  // a kqueue (macOS) / pidfd+epoll (Linux) fd via `bun:ffi`, polls
  // `data_version` to keep its watch set in sync with the candidate jobs
  // rows, and posts `{ kind: "exit", ... }` whenever a tracked pid exits or
  // the post-register kill-0 probe finds it already dead. Spawns AFTER seed
  // sweep + re-drain (above) so its initial candidate-set diff reads a
  // settled projection, not a half-folded one.
  const exitWorker = new Worker(
    new URL("./exit-watcher.ts", import.meta.url).href,
    {
      workerData: { dbPath, pollMs: 50 } satisfies ExitWatcherWorkerData,
    } as WorkerOptions & { workerData: unknown },
  );

  // Main stays the SOLE writer: an `exit` message becomes a synthetic
  // `Killed` events row inserted on the existing WRITABLE connection, then a
  // wake pump folds it. The verifier here re-reads the persisted row and
  // matches `(pid, start_time)` against the message's snapshot — STRICT when
  // the row carries a stored start_time, LOOSE pid-only when the row has
  // none (legacy / pre-schema-v9). A strict-mismatch is a race-recovered
  // stale event (the row was re-opened with a fresh process between
  // register and exit delivery, OR the producer races a SessionStart on the
  // same row); we silently skip it. The reducer's Killed fold ALSO
  // double-checks the match — this verifier is a producer-side optimization
  // that keeps the event log tight (no Killed rows that the reducer would
  // discard as stale).
  exitWorker.onmessage = (ev: MessageEvent<ExitMessage | undefined>): void => {
    const msg = ev.data;
    if (!msg || msg.kind !== "exit") {
      return;
    }
    // Re-read the row to confirm the message's pid + start_time still match
    // what's persisted. A non-matching row means the session was re-opened
    // (and the new process is presumably alive) — skip silently.
    const row = db
      .query("SELECT pid, start_time, state FROM jobs WHERE job_id = ?")
      .get(msg.jobId) as {
      pid: number | null;
      start_time: string | null;
      state: string;
    } | null;
    if (row == null) {
      // Row vanished — nothing to fold against.
      return;
    }
    if (row.state === "ended" || row.state === "killed") {
      // Already terminal — the reducer's Killed terminal-guard would no-op
      // anyway, but skip the event log churn.
      return;
    }
    // Strict-match when both sides carry a start_time; loose pid-only match
    // when EITHER side is NULL (the row is legacy / the message snapshot
    // didn't carry one — Q7 loose-accept rule). A strict mismatch is the
    // race-recovered case.
    const pidMatches = row.pid != null && row.pid === msg.pid;
    if (!pidMatches) {
      return;
    }
    const startMatches =
      row.start_time == null ||
      msg.startTime == null ||
      row.start_time === msg.startTime;
    if (!startMatches) {
      // Strict mismatch — silently skip (the producer raced a re-open).
      return;
    }
    stmts.insertEvent.run({
      $ts: Date.now() / 1000, // unix seconds as REAL, matching the hook
      $session_id: msg.jobId, // == job_id
      $pid: null,
      $hook_event: "Killed", // synthetic; reducer folds → 'killed'
      $event_type: "killed",
      $tool_name: null,
      $matcher: null,
      $cwd: null,
      $permission_mode: null,
      $agent_id: null,
      $agent_type: null,
      $stop_hook_active: null,
      $data: JSON.stringify({ pid: msg.pid, start_time: msg.startTime }),
      $subagent_agent_id: null,
      $spawn_name: null,
      $start_time: null,
      $slash_command: null,
      $skill_name: null,
      $planctl_op: null,
      $planctl_target: null,
      $planctl_epic_id: null,
      $planctl_task_id: null,
      $planctl_subject_present: null,
      $config_dir: null,
      $planctl_queue_jump: null,
      $bash_mutation_kind: null,
      $bash_mutation_targets: null,
      $planctl_files: null,
      $backend_exec_type: null,
      $backend_exec_session_id: null,
      $backend_exec_pane_id: null,
    });
    // Our own INSERT bumps data_version, so the wake worker would re-drain
    // anyway — but pump directly so the Killed fold lands without a poll-
    // cycle delay.
    wakePending = true;
    pumpWakes();
  };

  // Same crash policy as the other workers: any thread failure → fatalExit.
  exitWorker.onerror = (err: ErrorEvent): void => {
    console.error("[keeperd] exit-watcher worker error:", err.message ?? err);
    fatalExit();
  };

  // Same crash-via-`close` gap: an exit-watcher `process.exit(1)` fires
  // `close`, not `onerror`. `!shuttingDown` makes it inert on clean shutdown.
  exitWorker.addEventListener("close", () => {
    if (!shuttingDown) fatalExit();
  });

  // Spawn the git worker after the plan/job projections are caught up. It is
  // event-driven (file watcher + DB data_version wake + 60s heartbeat — see
  // `git-worker.ts` header) and posts a snapshot only when the rendered view
  // changes; main persists each one as a synthetic `GitSnapshot` event so the
  // reducer's `git_status` row is replayable.
  const gitWorker = new Worker(
    new URL("./git-worker.ts", import.meta.url).href,
    {
      workerData: { dbPath } satisfies GitWorkerData,
    } as WorkerOptions & { workerData: unknown },
  );
  // fn-705: publish the git-worker ref so the plan-worker `onmessage` handler's
  // discovery-nudge forward (wired ABOVE) can post `add-discovery-root` to it.
  // Any nudge posted before this line is a tolerated no-op (null-guarded).
  gitWorkerRef = gitWorker;

  gitWorker.onmessage = (
    ev: MessageEvent<GitWorkerMessage | undefined>,
  ): void => {
    const msg = ev.data;
    if (!msg) return;
    if (msg.kind === "planctl-commit-changed") {
      // Epic fn-681: authoritative commit-driven planctl ingest. The
      // git-worker observed a commit in `msg.project_dir` carrying
      // changed `.planctl/**` paths; forward the path list verbatim to
      // plan-worker so it re-ingests each from the COMMITTED worktree
      // bytes via the existing idempotent `onChange` / `onDelete`. NOT
      // written to the `events` log — the reducer must stay a pure
      // function of the immutable log, and this channel exists to drive
      // a producer worker, not a projection. Duplicate fires from a
      // live FSEvent are no-ops via plan-worker's change-gate.
      planWorker.postMessage({
        type: "planctl-commit-changed",
        repo: msg.project_dir,
        changes: msg.changes,
      } satisfies PlanctlCommitChangedMessage);
      return;
    }
    let hookEvent: string;
    let data: string;
    if (msg.kind === "git-snapshot") {
      hookEvent = "GitSnapshot";
      const { kind: _kind, ...snapshot } = msg;
      data = JSON.stringify(snapshot);
    } else if (msg.kind === "git-root-dropped") {
      // Tombstone: the reducer DELETEs the `git_status` row whose primary key
      // is `project_dir`. No payload beyond the pk in `session_id` — matches
      // the EpicDeleted / TaskDeleted shape so re-fold reproduces the deletion.
      hookEvent = "GitRootDropped";
      data = "";
    } else if (msg.kind === "commit") {
      // Per-commit attribution event. The reducer's `foldCommit` arm reads
      // the payload's `files` + `committer_session_id` and updates
      // `file_attributions.last_commit_at` — discharging the committing
      // session's claim on each file, or globally clearing every session's
      // claim when the trailer was absent / malformed.
      hookEvent = "Commit";
      const { kind: _kind, ...commit } = msg;
      data = JSON.stringify(commit);
    } else {
      return;
    }
    stmts.insertEvent.run({
      $ts: Date.now() / 1000,
      $session_id: msg.project_dir,
      $pid: null,
      $hook_event: hookEvent,
      $event_type: "git_snapshot",
      $tool_name: null,
      $matcher: null,
      $cwd: msg.project_dir,
      $permission_mode: null,
      $agent_id: null,
      $agent_type: null,
      $stop_hook_active: null,
      $data: data,
      $subagent_agent_id: null,
      $spawn_name: null,
      $start_time: null,
      $slash_command: null,
      $skill_name: null,
      $planctl_op: null,
      $planctl_target: null,
      $planctl_epic_id: null,
      $planctl_task_id: null,
      $planctl_subject_present: null,
      $config_dir: null,
      $planctl_queue_jump: null,
      $bash_mutation_kind: null,
      $bash_mutation_targets: null,
      $planctl_files: null,
      $backend_exec_type: null,
      $backend_exec_session_id: null,
      $backend_exec_pane_id: null,
    });
    // fn-629 observation-gate drain: a `git-snapshot` or `commit` from
    // the git-worker is the cross-worker "HEAD may have moved" signal a
    // plan-worker cannot observe on its own (a `git commit` leaves the
    // `.planctl/*.json` bytes identical, so FSEvents will not re-fire on
    // the worktree path). Fire `recheck-pending` so the scanner re-runs
    // its tracked-in-HEAD predicate over every path currently held in
    // pending. Cheap (no-op when the set is empty); idempotent.
    if (msg.kind === "git-snapshot" || msg.kind === "commit") {
      planWorker.postMessage({
        type: "recheck-pending",
      } satisfies RecheckPendingMessage);
    }
    wakePending = true;
    pumpWakes();
  };

  gitWorker.onerror = (err: ErrorEvent): void => {
    console.error("[keeperd] git worker error:", err.message ?? err);
    fatalExit();
  };

  gitWorker.addEventListener("close", () => {
    if (!shuttingDown) fatalExit();
  });

  // Spawn the usage worker in the SAME post-migration window. It watches the
  // agentuse daemon's flat leaf state dir (`~/.local/state/agentuse/`) and
  // posts `{kind: "usage-snapshot" | "usage-deleted", ...}` messages — the
  // fifth file-watcher producer-worker instance. Main turns each into a
  // synthetic `UsageSnapshot`/`UsageDeleted` events row on its writable
  // connection. The watch root is resolved on main via `resolveUsageRoot()`
  // and tolerates absence (agentuse may not have run yet).
  const usageWorker = new Worker(
    new URL("./usage-worker.ts", import.meta.url).href,
    {
      workerData: {
        dbPath,
        root: resolveUsageRoot(),
      } satisfies UsageWorkerData,
    } as WorkerOptions & { workerData: unknown },
  );

  // Main stays the SOLE writer: a `usage-snapshot`/`usage-deleted` message
  // becomes a synthetic `UsageSnapshot`/`UsageDeleted` events row inserted on
  // the existing WRITABLE connection, then a wake pump folds it. The agentuse
  // profile id rides in `session_id` (the generic entity-key overload the
  // reducer reads); the flattened snapshot rides in `data` for snapshots, an
  // empty string for tombstones. Everything other than session_id / hook_event /
  // event_type / data is NULL (synthetic — never carries a process identity).
  usageWorker.onmessage = (
    ev: MessageEvent<UsageMessage | undefined>,
  ): void => {
    const msg = ev.data;
    if (!msg) return;
    let hookEvent: string;
    let data: string;
    if (msg.kind === "usage-snapshot") {
      hookEvent = "UsageSnapshot";
      // Pre-flattened payload — the reducer never re-reads the on-disk file.
      // Forwarded via the exported `serializeUsageSnapshot` so the wire
      // shape is pinned by a direct test; fn-651 task .1 fixed the leak
      // that dropped the fn-645 status / subscription_active / error_*
      // fields (those columns folded to NULL forever before this).
      data = serializeUsageSnapshot(msg);
    } else if (msg.kind === "usage-deleted") {
      // Tombstone: the reducer DELETEs the `usage` row whose primary key is
      // `id`. No payload beyond the pk in `session_id` — matches the
      // GitRootDropped / EpicDeleted shape so re-fold reproduces the deletion.
      hookEvent = "UsageDeleted";
      data = "";
    } else {
      return;
    }
    stmts.insertEvent.run({
      $ts: Date.now() / 1000,
      $session_id: msg.id, // the entity pk: agentuse profile id
      $pid: null,
      $hook_event: hookEvent,
      $event_type: "usage_snapshot",
      $tool_name: null,
      $matcher: null,
      $cwd: null,
      $permission_mode: null,
      $agent_id: null,
      $agent_type: null,
      $stop_hook_active: null,
      $data: data,
      $subagent_agent_id: null,
      $spawn_name: null,
      $start_time: null,
      $slash_command: null,
      $skill_name: null,
      $planctl_op: null,
      $planctl_target: null,
      $planctl_epic_id: null,
      $planctl_task_id: null,
      $planctl_subject_present: null,
      $config_dir: null,
      $planctl_queue_jump: null,
      $bash_mutation_kind: null,
      $bash_mutation_targets: null,
      $planctl_files: null,
      $backend_exec_type: null,
      $backend_exec_session_id: null,
      $backend_exec_pane_id: null,
    });
    wakePending = true;
    pumpWakes();
  };

  usageWorker.onerror = (err: ErrorEvent): void => {
    console.error("[keeperd] usage worker error:", err.message ?? err);
    fatalExit();
  };

  usageWorker.addEventListener("close", () => {
    if (!shuttingDown) fatalExit();
  });

  // (fn-684 task .5) The legacy backend-exec tab-resolver worker
  // (fn-668 / schema v48) lived here and shelled
  // `zellij action list-panes -a -j` once per tick per distinct session.
  // It is retired in favor of the always-on zellij-events watcher worker
  // (spawned just below) + main-side `scanZellijEventsDir` pipeline,
  // which feeds the EXACT same `BackendExecSnapshot` synthetic event
  // through the same reducer fold — event-driven now instead of
  // poll-driven. Rollback: `git revert` the fn-684 task .5 commit
  // restores this spawn block and the worker's body in
  // `src/backend-worker.ts`.

  // Spawn the dead-letter worker (fn-643 task .3) in the SAME post-migration
  // window — the seventh worker thread (and sixth file-watcher producer
  // instance). It watches the dead-letters dir for changes and posts a
  // contentless `{kind:"dead-letter-changed"}` message. The worker holds NO
  // DB handle — main is the sole DB writer here, just as it is for the
  // event log; on each worker message main re-runs `scanDeadLetterDir`
  // (same primitive as the boot scan above), which INSERT OR IGNOREs each
  // parsed record into the `dead_letters` operational table.
  //
  // The boot scan above already imported every pre-existing file; this
  // live path covers files the hook writes AFTER the daemon comes up. The
  // worker spawns AFTER the boot import so the table state is settled
  // before any live notification arrives — there is no race where a
  // live message could fire against a half-imported boot state.
  const deadLetterWorker = new Worker(
    new URL("./dead-letter-worker.ts", import.meta.url).href,
    {
      workerData: { dir: deadLetterDir } satisfies DeadLetterWorkerData,
    } as WorkerOptions & { workerData: unknown },
  );

  // Main owns the actual `dead_letters` write: a worker `dead-letter-changed`
  // message triggers a fresh `scanDeadLetterDir` against the on-disk dir
  // (treating the watcher event as "go look", never as the data — the
  // CLAUDE.md "safe value" pattern). The scan is idempotent (`INSERT OR
  // IGNORE` on `dl_id`), so a burst of watcher events collapses harmlessly
  // into the same converged row set. NO wake is pumped here — the write
  // goes to the `dead_letters` table, NOT `events`, so there is no
  // projection to fold; the server worker's data_version polling picks
  // up the row change directly and the board re-renders.
  deadLetterWorker.onmessage = (
    ev: MessageEvent<DeadLetterChangedMessage | undefined>,
  ): void => {
    const msg = ev.data;
    if (!msg || msg.kind !== "dead-letter-changed") {
      return;
    }
    try {
      scanDeadLetterDir(db, deadLetterDir);
    } catch (err) {
      // Defense-in-depth: scanDeadLetterDir's design contract is "never
      // throw out of the scan", but an unexpected internal throw must
      // NOT crash the daemon. Log and continue — the next watcher event
      // will retry the import.
      console.error(
        `[keeperd] dead-letter live import threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  // Same crash policy as the other workers: any thread failure → fatalExit.
  deadLetterWorker.onerror = (err: ErrorEvent): void => {
    console.error("[keeperd] dead-letter worker error:", err.message ?? err);
    fatalExit();
  };

  // Same crash-via-`close` gap: a dead-letter-worker `process.exit(1)`
  // fires `close`, not `onerror`. `!shuttingDown` makes it inert on clean
  // shutdown.
  deadLetterWorker.addEventListener("close", () => {
    if (!shuttingDown) fatalExit();
  });

  // Spawn the zellij-events watcher worker (fn-684 task .3) — the
  // TWELFTH worker thread (and EIGHTH `@parcel/watcher` producer
  // instance). It watches the zellij events dir for changes and posts a
  // contentless `{kind:"zellij-events-changed"}` message. The worker
  // holds NO DB handle — main is the sole DB writer here, just as it
  // is for the event log and the dead-letters table; on each worker
  // message main re-runs `scanZellijEventsDir`, which tails each
  // `<session>.ndjson` from its persisted byte-offset watermark and
  // mints one `BackendExecSnapshot` synthetic event per new pane line
  // whose `(session, pane_id)` joins to a live job (no reducer or
  // schema change — same fold path the retired poller used).
  //
  // Always-on as of fn-684 task .5: the legacy `backend-worker`
  // poller (`zellij action list-panes -a -j` per tick) is retired
  // and removed. The plugin feed is now the sole producer of
  // `jobs.backend_exec_tab_{id,name}`; rollback to the poller is a
  // single `git revert` of the fn-684 task .5 commit.
  //
  // The boot scan above already imported every pre-existing file's
  // post-watermark tail; this live path covers lines the plugin
  // appends AFTER the daemon comes up. The worker spawns AFTER the
  // boot import so the file state is settled before any live
  // notification arrives — there is no race where a live message
  // could fire against a half-imported boot state.
  const zellijEventsWorker = new Worker(
    new URL("./zellij-events-worker.ts", import.meta.url).href,
    {
      workerData: { dir: zellijEventsDir } satisfies ZellijEventsWorkerData,
    } as WorkerOptions & { workerData: unknown },
  );

  // Main owns the actual scan + event mint: a worker
  // `zellij-events-changed` message triggers a fresh
  // `scanZellijEventsDir` against the on-disk dir (treating the
  // watcher event as "go look", never as the data). The scan is
  // idempotent (watermark sidecar advances per file), so a burst of
  // watcher events collapses into the same converged tail. Pumps a
  // wake after any mint so the reducer folds the new
  // `BackendExecSnapshot` rows into `jobs.backend_exec_tab_*`
  // without waiting for the wake worker's `data_version` poll.
  zellijEventsWorker.onmessage = (
    ev: MessageEvent<ZellijEventsChangedMessage | undefined>,
  ): void => {
    const msg = ev.data;
    if (!msg || msg.kind !== "zellij-events-changed") {
      return;
    }
    try {
      scanZellijEventsDir(db, stmts, zellijEventsDir);
    } catch (err) {
      // Defense-in-depth: scanZellijEventsDir's design contract is
      // "never throw out of the scan", but an unexpected internal
      // throw must NOT crash the daemon. Log and continue — the
      // next watcher event will retry the import.
      console.error(
        `[keeperd] zellij-events live import threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    // Pump a wake so the synthetic events fold into the projection
    // promptly; without this the reducer waits up to one wake-worker
    // poll interval before folding the new rows.
    wakePending = true;
    pumpWakes();
  };

  // Same crash policy as the other workers: any thread failure →
  // fatalExit.
  zellijEventsWorker.onerror = (err: ErrorEvent): void => {
    console.error("[keeperd] zellij-events worker error:", err.message ?? err);
    fatalExit();
  };

  // Same crash-via-`close` gap: a zellij-events-worker `process.exit(1)`
  // fires `close`, not `onerror`. `!shuttingDown` makes it inert on
  // clean shutdown.
  zellijEventsWorker.addEventListener("close", () => {
    if (!shuttingDown) fatalExit();
  });

  // Spawn the autopilot reconciler worker (fn-661 task .4) — the eighth
  // worker thread. It runs the level-triggered dispatch reconcile loop
  // server-side: data_version wake → desired-vs-observed verdict →
  // launch via the ExecBackend → confirm via the worker's own read conn
  // → DispatchFailed mint on ceiling (bridged through main, see the
  // `onmessage` handler below). The pure decision logic (`reconcile`,
  // `confirmRunning`, `runReconcileCycle`) lives in `src/autopilot-worker.ts`
  // and is exercised directly by the test suite; this spawn is the
  // structural glue that lights up the worker's main() body.
  //
  // Boots PAUSED: the autopilot worker initializes its in-memory
  // `paused = true` from the supervisor's `paused: true` workerData
  // (the safety default; see the `autopilotPaused` declaration above).
  // The flag flips ONLY via the `set_autopilot_paused` RPC → bridge →
  // main → `{type:"set-paused"}` relay above.
  //
  // Config (`autocloseWindows` / `zellijSession`) is read here on main
  // and threaded into workerData so the worker doesn't open
  // `~/.config/keeper/config.yaml` itself — every config I/O lives on
  // main, every worker receives the resolved values.
  const apConfig = resolveConfig();
  const autopilotWorkerInstance = new Worker(
    new URL("./autopilot-worker.ts", import.meta.url).href,
    {
      workerData: {
        dbPath,
        paused: autopilotPaused,
        autocloseWindows: apConfig.autocloseWindows ?? false,
        zellijSession: apConfig.zellijSession,
      } satisfies AutopilotWorkerData,
    } as WorkerOptions & { workerData: unknown },
  );
  // Wire the forward reference declared above so the server-worker's
  // bridge handler (registered earlier) can target the autopilot worker
  // via `autopilotWorker.postMessage({...})`. Assign BEFORE the
  // onmessage / onerror / close handlers fire so the first bridge
  // request never sees a `null` autopilot worker.
  autopilotWorker = autopilotWorkerInstance;

  // Worker → main: `DispatchFailed` / `Dispatched` / `DispatchExpired`
  // mint requests. Mirrors the git-worker synthetic-event mint pattern
  // (see `:1309-1376`): the worker posts a `{kind, payload}` message,
  // main runs `stmts.insertEvent.run` on its writable connection, then
  // sets `wakePending = true; pumpWakes()` so the reducer folds the row
  // into `dispatch_failures` / `pending_dispatches` without waiting for
  // the wake worker's `data_version` poll. Workers never write the DB;
  // the producer-side `ts` rides in the payload (where the fold reads
  // it) so re-fold determinism holds.
  //
  // The three mint paths share an identical column-binding shape — the
  // only differences are `$hook_event` (`DispatchFailed` / `Dispatched`
  // / `DispatchExpired`), `$event_type` (the projection tag the
  // reducer matches on), and `$cwd` (carried from the payload `dir`
  // when present; `null` for `DispatchExpired`, which is keyed by-pk
  // only). NON-FATAL catch — a failed INSERT logs to stderr and
  // continues; the next reconcile cycle re-attempts the dispatch.
  autopilotWorkerInstance.onmessage = (
    ev: MessageEvent<
      | DispatchFailedMessage
      | DispatchedMessage
      | DispatchExpiredMessage
      | undefined
    >,
  ): void => {
    const msg = ev.data;
    if (!msg) return;
    if (msg.kind === "dispatch-failed") {
      handleDispatchFailedMint(msg.payload);
    } else if (msg.kind === "dispatched") {
      handleDispatchedMint(msg.payload);
    } else if (msg.kind === "dispatch-expired") {
      handleDispatchExpiredMint(msg.payload);
    }
  };

  /**
   * Mint a synthetic `DispatchFailed` event on the writable connection.
   * The dispatch key (`${verb}::${id}`) rides as the entity-key
   * overload on `session_id` so a re-fold can correlate the synthetic
   * event to its `dispatch_failures` row without re-parsing the `data`
   * blob. Same convention the retry-dispatch mint above uses. NON-FATAL
   * on insert failure — the next reconcile wake re-attempts.
   */
  function handleDispatchFailedMint(
    payload: DispatchFailedMessage["payload"],
  ): void {
    const data = JSON.stringify(payload);
    try {
      stmts.insertEvent.run({
        $ts: Date.now() / 1000,
        $session_id: `${payload.verb}::${payload.id}`,
        $pid: null,
        $hook_event: "DispatchFailed",
        $event_type: "dispatch_failures",
        $tool_name: null,
        $matcher: null,
        $cwd: payload.dir,
        $permission_mode: null,
        $agent_id: null,
        $agent_type: null,
        $stop_hook_active: null,
        $data: data,
        $subagent_agent_id: null,
        $spawn_name: null,
        $start_time: null,
        $slash_command: null,
        $skill_name: null,
        $planctl_op: null,
        $planctl_target: null,
        $planctl_epic_id: null,
        $planctl_task_id: null,
        $planctl_subject_present: null,
        $config_dir: null,
        $planctl_queue_jump: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $planctl_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
      });
      wakePending = true;
      pumpWakes();
    } catch (err) {
      // Defense-in-depth: an insert failure (DB-level) must NOT crash
      // the daemon. Log + continue — the next reconcile wake will
      // re-attempt the dispatch (the sticky failure state is bounded
      // by an event in the log; a missed insert is just an extra retry
      // round-trip, not a correctness hazard).
      console.error(
        `[keeperd] DispatchFailed mint threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Mint a synthetic `Dispatched` event on the writable connection
   * (fn-678, schema v50). The reducer's `Dispatched` fold UPSERTs a
   * `pending_dispatches` row keyed `(verb, id)` carrying the
   * producer-side `dispatched_at` lifted off the payload's `ts` —
   * outbox-ordered intent so a crash between mint and `launch()`
   * leaves a phantom row the TTL sweep clears. NON-FATAL on insert
   * failure: a missed mint means the launch-window dedup arm opens up
   * for that `(verb, id)` until the next reconcile cycle, which is
   * preferable to wedging the daemon (the worst case is one extra
   * launch attempt, identical to fn-674's transient-failure
   * degradation).
   */
  function handleDispatchedMint(payload: DispatchedMessage["payload"]): void {
    const data = JSON.stringify(payload);
    try {
      stmts.insertEvent.run({
        $ts: Date.now() / 1000,
        $session_id: `${payload.verb}::${payload.id}`,
        $pid: null,
        $hook_event: "Dispatched",
        $event_type: "pending_dispatches",
        $tool_name: null,
        $matcher: null,
        $cwd: payload.dir,
        $permission_mode: null,
        $agent_id: null,
        $agent_type: null,
        $stop_hook_active: null,
        $data: data,
        $subagent_agent_id: null,
        $spawn_name: null,
        $start_time: null,
        $slash_command: null,
        $skill_name: null,
        $planctl_op: null,
        $planctl_target: null,
        $planctl_epic_id: null,
        $planctl_task_id: null,
        $planctl_subject_present: null,
        $config_dir: null,
        $planctl_queue_jump: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $planctl_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
      });
      wakePending = true;
      pumpWakes();
    } catch (err) {
      console.error(
        `[keeperd] Dispatched mint threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Mint a synthetic `DispatchExpired` event on the writable connection
   * (fn-678, schema v50). The reducer's fold DELETEs the matching
   * `pending_dispatches` row keyed `(verb, id)` — idempotent
   * (re-folding over a missing row is a no-op). NON-FATAL on insert
   * failure: the row stays put until the next heartbeat sweep mints
   * again (the TTL comparison is keyed off the FROZEN
   * `dispatched_at`, so a daemon restart never resets the clock —
   * worst case is one extra TTL window before the row clears).
   */
  function handleDispatchExpiredMint(
    payload: DispatchExpiredMessage["payload"],
  ): void {
    const data = JSON.stringify(payload);
    try {
      stmts.insertEvent.run({
        $ts: Date.now() / 1000,
        $session_id: `${payload.verb}::${payload.id}`,
        $pid: null,
        $hook_event: "DispatchExpired",
        $event_type: "pending_dispatches",
        $tool_name: null,
        $matcher: null,
        $cwd: null,
        $permission_mode: null,
        $agent_id: null,
        $agent_type: null,
        $stop_hook_active: null,
        $data: data,
        $subagent_agent_id: null,
        $spawn_name: null,
        $start_time: null,
        $slash_command: null,
        $skill_name: null,
        $planctl_op: null,
        $planctl_target: null,
        $planctl_epic_id: null,
        $planctl_task_id: null,
        $planctl_subject_present: null,
        $config_dir: null,
        $planctl_queue_jump: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $planctl_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
      });
      wakePending = true;
      pumpWakes();
    } catch (err) {
      console.error(
        `[keeperd] DispatchExpired mint threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Producer-side TTL sweep for `pending_dispatches` (fn-678, schema
  // v50, task .3). Mints a synthetic `DispatchExpired` event for every
  // row whose `dispatched_at` is older than `PENDING_DISPATCH_TTL_MS`
  // and that does NOT already have an open `dispatch_failures` row for
  // the same `(verb, id)` — the LEFT JOIN guard prevents the
  // already-failed dispatch from getting a redundant expire mint (the
  // reducer's `DispatchFailed` fold arm already discharges the pending
  // row through the same `DELETE FROM pending_dispatches` path).
  //
  // MUST ride the 60s HEARTBEAT timer, not the level-triggered
  // `data_version` wake: a crashed dispatch can be the only pending
  // row on an otherwise-quiescent board, and a write-triggered wake
  // would never fire — the row would never expire and the slot would
  // stay held indefinitely. All wallclock (`Date.now()`) lives HERE
  // in the producer, never inside a fold (CLAUDE.md re-fold
  // determinism invariant); the fold reads only `event.ts` and the
  // FROZEN payload, so a re-fold reproduces `pending_dispatches`
  // byte-identically regardless of when the re-fold happens.
  //
  // The sweep reads the projection on main's writable connection
  // (rather than via a separate read-only handle) so the read is
  // sequenced inside the same writer that mints the synthetic event
  // — no read/mint race against the reducer's own UPSERT.
  function sweepExpiredPendingDispatches(): void {
    if (shuttingDown) return;
    let aged: { verb: string; id: string; dispatched_at: number }[];
    try {
      aged = selectExpiredPendingDispatches(db, Date.now());
    } catch (err) {
      // The pending_dispatches / dispatch_failures tables exist from
      // schema v50; a read failure here is unexpected. Log non-fatally
      // and let the next heartbeat retry.
      console.error(
        `[keeperd] pending_dispatches TTL sweep read threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    if (aged.length === 0) return;
    for (const row of aged) {
      // Mint the expire event. Failures inside the helper are logged
      // and swallowed (non-fatal), so a per-row throw does not abort
      // the sweep — every aged row gets its own shot.
      handleDispatchExpiredMint({ verb: row.verb as Verb, id: row.id });
    }
    // `handleDispatchExpiredMint` already pumps wakes on each mint;
    // the trailing flag is defense-in-depth in case the helper ever
    // stops pumping (e.g. on insert throw — every row's mint is
    // independent).
    wakePending = true;
    pumpWakes();
  }

  // Schedule the producer-side TTL sweep on the 60s heartbeat. Stored
  // so the shutdown path can `clearInterval` it (otherwise the
  // outstanding timer keeps a ref on the main loop and the daemon
  // would hang at the shutdown deadline). The timer fires its
  // callback ON THE MAIN THREAD against the writable connection —
  // matching the synthetic-event mint sites the heartbeat targets.
  const pendingDispatchSweepTimer = setInterval(() => {
    sweepExpiredPendingDispatches();
  }, PENDING_DISPATCH_SWEEP_INTERVAL_MS);

  // Same crash policy as the other workers: any thread failure →
  // fatalExit → exit 1 → launchd restart.
  autopilotWorkerInstance.onerror = (err: ErrorEvent): void => {
    console.error("[keeperd] autopilot worker error:", err.message ?? err);
    fatalExit();
  };

  // Same crash-via-`close` gap as every other worker: a
  // `process.exit(1)` inside the autopilot worker fires `close`, not
  // `onerror`. Without this the reconciler could silently vanish while
  // the rest of keeperd kept running. `!shuttingDown` makes it inert
  // on the clean shutdown path.
  autopilotWorkerInstance.addEventListener("close", () => {
    if (!shuttingDown) fatalExit();
  });

  // Spawn the restore-snapshot worker (fn-677 task .3) — the tenth worker
  // thread. A pure CONSUMER: it opens its own read-only connection, polls
  // `PRAGMA data_version`, and on every change reads the `jobs` + `epics`
  // projections via the shared `runQuery` seam, builds a stable descriptor
  // of the live (`working`/`stopped`) jobs grouped by zellij
  // `backend_exec_session_id`, and rewrites `~/.local/state/keeper/restore.json`
  // via `atomicWriteFile` ONLY when the content hash differs. The file is
  // a derived side-file (NOT a projection, NOT in the event log), so the
  // worker carries no `onmessage` handler — it never posts to main, never
  // writes the DB, and never feeds the event log. The `scripts/restore-agents.ts`
  // util (T4) is the sole reader.
  //
  // Write failures inside the worker are SWALLOWED to stderr (the next
  // pulse re-writes); only an unhandled throw out of the watch loop
  // escalates to `onerror`/`close` → fatalExit. Consistent with the other
  // workers' crash policy.
  const restoreWorker = new Worker(
    new URL("./restore-worker.ts", import.meta.url).href,
    {
      workerData: { dbPath } satisfies RestoreWorkerData,
    } as WorkerOptions & { workerData: unknown },
  );

  restoreWorker.onerror = (err: ErrorEvent): void => {
    console.error("[keeperd] restore worker error:", err.message ?? err);
    fatalExit();
  };

  restoreWorker.addEventListener("close", () => {
    if (!shuttingDown) fatalExit();
  });

  // Spawn the tab-namer worker (fn-680, reworked fn-699) — the TWELFTH
  // worker thread. A PURE SIDE-EFFECTOR: it opens its own read-only
  // connection and — reactively, kicked by main after every drain plus a
  // `data_version` poll backstop (mirroring the server-worker) — reads the
  // live jobs that carry a resolved
  // `(backend_exec_session_id, backend_exec_tab_id)` pair AND a non-NULL
  // transcript `title`, then shells the focus-safe zellij
  // `action rename-tab-by-id` op via `ExecBackend.renameTab` UNCONDITIONALLY
  // whenever the sanitized title differs from the last-observed
  // `backend_exec_tab_name` (no permanent suppression — a tab that drifts
  // back to `Tab #N` on resume re-converges within one kick/poll cycle).
  // The worker writes NOTHING to the DB, mints no events, and posts nothing
  // back to main — fn-678 made the tab name purely cosmetic (reap is by
  // `backend_exec_tab_id`, launch dedup by `pending_dispatches`), so
  // renaming every tab is safe and the convergence loop closes through the
  // zellij-events feed's read-back of `backend_exec_tab_name`. It RECEIVES
  // `{type:"kick"}` and `{type:"shutdown"}` from main; it sends nothing.
  const tabNamerWorker = new Worker(
    new URL("./tab-namer-worker.ts", import.meta.url).href,
    {
      workerData: { dbPath } satisfies TabNamerWorkerData,
    } as WorkerOptions & { workerData: unknown },
  );

  tabNamerWorker.onerror = (err: ErrorEvent): void => {
    console.error("[keeperd] tab-namer worker error:", err.message ?? err);
    fatalExit();
  };

  tabNamerWorker.addEventListener("close", () => {
    if (!shuttingDown) fatalExit();
  });

  /** Crash exit. Reserved for unrecoverable errors so launchd restarts us. */
  function fatalExit(): void {
    try {
      db.close();
    } catch {
      // best-effort; we're crashing either way
    }
    process.exit(1);
  }

  // Unrecoverable async errors that escape every guard also take the single
  // recovery path. (A fold throw inside drain bubbles here if it ever escapes
  // the reducer's per-event handling.)
  process.on("unhandledRejection", (reason) => {
    console.error("[keeperd] unhandled rejection:", reason);
    fatalExit();
  });
  process.on("uncaughtException", (err) => {
    console.error("[keeperd] uncaught exception:", err);
    fatalExit();
  });

  // Step 5 — clean shutdown. The ONLY path that exits 0; under
  // KeepAlive.SuccessfulExit = false a clean exit tells launchd NOT to restart.
  async function shutdown(): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    // Clear the producer-side TTL sweep timer FIRST so the heartbeat
    // can't fire a mint into the writer connection mid-teardown.
    // (`clearInterval` is a no-op if the timer already fired.)
    clearInterval(pendingDispatchSweepTimer);

    worker.postMessage({ type: "shutdown" } satisfies ShutdownMessage);
    serverWorker.postMessage({ type: "shutdown" } satisfies ShutdownMessage);
    transcriptWorker.postMessage({
      type: "shutdown",
    } satisfies ShutdownMessage);
    planWorker.postMessage({ type: "shutdown" } satisfies ShutdownMessage);
    exitWorker.postMessage({ type: "shutdown" } satisfies ShutdownMessage);
    gitWorker.postMessage({ type: "shutdown" } satisfies ShutdownMessage);
    usageWorker.postMessage({ type: "shutdown" } satisfies ShutdownMessage);
    deadLetterWorker.postMessage({
      type: "shutdown",
    } satisfies ShutdownMessage);
    autopilotWorkerInstance.postMessage({
      type: "shutdown",
    } satisfies ShutdownMessage);
    restoreWorker.postMessage({
      type: "shutdown",
    } satisfies ShutdownMessage);
    tabNamerWorker.postMessage({
      type: "shutdown",
    } satisfies ShutdownMessage);
    zellijEventsWorker.postMessage({
      type: "shutdown",
    } satisfies ShutdownMessage);

    // Bun surfaces worker exit via the "close" event. Await ALL TWELVE
    // workers' close (the server worker releases its socket + lock, the
    // transcript + plan + usage + dead-letter + zellij-events workers
    // unsubscribe their watchers, the exit-watcher releases its
    // kqueue/pidfd fd, the autopilot worker aborts its in-flight
    // confirm, the restore worker closes its read-only DB connection,
    // and the tab-namer worker clears its tick interval + closes its
    // read-only DB connection in their own shutdown handlers — that
    // teardown must land, or the socket / native watches / kernel fd
    // leak into the next boot), raced against a single shared deadline
    // so a wedged worker can't block our clean shutdown forever.
    const exited = (w: Worker): Promise<void> =>
      new Promise<void>((resolve) => {
        w.addEventListener("close", () => resolve());
      });
    const exitWaits: Promise<void>[] = [
      exited(worker),
      exited(serverWorker),
      exited(transcriptWorker),
      exited(planWorker),
      exited(exitWorker),
      exited(gitWorker),
      exited(usageWorker),
      exited(deadLetterWorker),
      exited(autopilotWorkerInstance),
      exited(restoreWorker),
      exited(tabNamerWorker),
      exited(zellijEventsWorker),
    ];
    await Promise.race([
      Promise.all(exitWaits),
      Bun.sleep(WORKER_SHUTDOWN_DEADLINE_MS),
    ]);

    try {
      worker.terminate();
    } catch {
      // best-effort if it already exited
    }
    try {
      serverWorker.terminate();
    } catch {
      // best-effort if it already exited
    }
    try {
      transcriptWorker.terminate();
    } catch {
      // best-effort if it already exited
    }
    try {
      planWorker.terminate();
    } catch {
      // best-effort if it already exited
    }
    try {
      exitWorker.terminate();
    } catch {
      // best-effort if it already exited
    }
    try {
      gitWorker.terminate();
    } catch {
      // best-effort if it already exited
    }
    try {
      usageWorker.terminate();
    } catch {
      // best-effort if it already exited
    }
    try {
      deadLetterWorker.terminate();
    } catch {
      // best-effort if it already exited
    }
    try {
      autopilotWorkerInstance.terminate();
    } catch {
      // best-effort if it already exited
    }
    try {
      restoreWorker.terminate();
    } catch {
      // best-effort if it already exited
    }
    try {
      tabNamerWorker.terminate();
    } catch {
      // best-effort if it already exited
    }
    try {
      zellijEventsWorker.terminate();
    } catch {
      // best-effort if it already exited
    }

    try {
      db.close();
    } catch {
      // best-effort
    }

    process.exit(0);
  }

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
}

// Only boot the daemon when this file is the process entry point. A plain
// `import` (e.g. a test driving `drainToCompletion` against a tmp DB) must NOT
// spawn the worker or install signal handlers. Mirrors wake-worker's
// `isMainThread` guard.
if (import.meta.main) {
  runDaemon();
}

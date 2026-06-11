/**
 * Keeper daemon — the long-running reducer process. Managed in production by a
 * LaunchAgent that re-runs it on any non-clean exit.
 *
 * Crash policy (single recovery path): any unrecoverable error calls
 * `process.exit(1)`; the LaunchAgent restarts us. ONE well-tested recovery path
 * rather than in-process self-heal — never respawn a worker in-process. A worker
 * owning an external resource releases it in its own shutdown handler;
 * `terminate()` alone would leak it.
 */

import type { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type {
  AutopilotWorkerData,
  DispatchExpiredMessage,
  DispatchedAckMessage,
  DispatchedMessage,
  DispatchFailedMessage,
  Verb,
} from "./autopilot-worker";
import {
  appendBackstopRecord,
  BackstopCounters,
  type BackstopMessage,
  type BackstopRecord,
  buildTimeoutRecord,
} from "./backstop-telemetry";
import { type BackupResult, liveBackupPage } from "./backup";
import type { BuildsMessage, BuildsWorkerData } from "./builds-worker";
import { compactColdBlobs, countAbsentBlobs } from "./compaction";
import {
  openDb,
  resolveBackstopLogPath,
  resolveBuildbotUrl,
  resolveClaudeProjectsRoot,
  resolveConfig,
  resolveDbPath,
  resolveDeadLetterDir,
  resolveEventsLogDir,
  resolvePlanRoots,
  resolveSockPath,
  resolveUsageRoot,
} from "./db";
import { parseDeadLetterLine, parseEventLogLine } from "./dead-letter";
import type {
  DeadLetterChangedMessage,
  DeadLetterWorkerData,
} from "./dead-letter-worker";
import type {
  EventsIngestWorkerData,
  EventsLogChangedMessage,
} from "./events-ingest-worker";
import type { ExitMessage, ExitWatcherWorkerData } from "./exit-watcher";
import type {
  AddDiscoveryRootMessage,
  GitWorkerData,
  GitWorkerMessage,
} from "./git-worker";
import { livePage } from "./integrity-probe";
import type {
  BackupResultMessage,
  MaintenanceLogMessage,
  MaintenancePageMessage,
  MaintenanceWorkerData,
} from "./maintenance-worker";
import type {
  PlanctlCommitChangedMessage,
  PlanWorkerData,
  PlanWorkerOutbound,
  RecheckPendingMessage,
} from "./plan-worker";
import {
  DEFAULT_BATCH_SIZE,
  type DrainOptions,
  drain,
  serializeBuildSnapshot,
} from "./reducer";
import type { RestoreWorkerData } from "./restore-worker";
import { seedKilledSweep } from "./seed-sweep";
import type {
  KickMessage,
  ReplayRequestMessage,
  ReplayResultMessage,
  RetryDispatchRequestMessage,
  RetryDispatchResultMessage,
  ServerWorkerData,
  SetAutopilotModeRequestMessage,
  SetAutopilotModeResultMessage,
  SetAutopilotPausedRequestMessage,
  SetAutopilotPausedResultMessage,
  SetEpicArmedRequestMessage,
  SetEpicArmedResultMessage,
} from "./server-worker";
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

/** Grace period for the worker to exit on shutdown before we close the db anyway. */
const WORKER_SHUTDOWN_DEADLINE_MS = 2000;

/**
 * Drain the projection to completion: loop `drain()` until it reports 0 newly
 * folded events. Each `drain()` call folds at most `batchSize` events in their
 * own transactions, so the writer lock is released between batches and hook
 * inserts are never starved.
 *
 * Pacing (boot only): the boot caller may pass `DrainOptions` to sleep after
 * each fold's COMMIT, opening a contention window for concurrent hook INSERTs.
 * `options.paceEvents` is the TOTAL paced-fold budget across all batches; once
 * spent, the remainder runs unpaced so a large from-scratch re-fold catches up
 * in bounded time. Pacing is a stateless parameter on the SAME `drain()` steady
 * state uses — no forked boot drain.
 */
export function drainToCompletion(
  db: Database,
  batchSize = DEFAULT_BATCH_SIZE,
  options: DrainOptions = {},
): void {
  let remainingPaceEvents = options.paceEvents ?? 0;
  const paceMs = options.paceMs ?? 0;
  const sleep = options.sleep;
  for (;;) {
    const batchOptions: DrainOptions =
      paceMs > 0 && (remainingPaceEvents > 0 || (options.paceEvents ?? 0) === 0)
        ? {
            paceMs,
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
      remainingPaceEvents -= Math.min(remainingPaceEvents, folded);
    }
  }
}

/**
 * SQLite's default WAL auto-checkpoint threshold (pages). `applyPragmas` does
 * not set it, so {@link withBootDrainCheckpointTuning} restores exactly this
 * value after disabling it for the boot drain.
 */
export const WAL_AUTOCHECKPOINT_PAGES = 1000;

/**
 * Post-COMMIT sleep duration (ms) for the boot drain — a real OS sleep
 * (`Atomics.wait`) opening a writer-lock window so a concurrent hook INSERT
 * (separate process) lands in the gap. WAL gives NO writer FIFO fairness, so
 * without the gap a sleeping hook's busy-handler retry loses the race to the
 * reducer's next `BEGIN IMMEDIATE` and exhausts its budget → dead-letter.
 * `setImmediate` / event-loop yields do NOT help — they don't release the
 * SQLite lock to a separate process.
 */
export const BOOT_DRAIN_PACE_MS = 5;

/**
 * Pacing budget (event count) for the boot drain — after this many paced folds
 * the remainder runs unpaced, bounding the extra latency a large from-scratch
 * re-fold pays before catching up to head.
 */
export const BOOT_DRAIN_PACE_EVENTS = 500;

/**
 * TTL (ms) for an open `pending_dispatches` row before the producer-side sweep
 * mints a `DispatchExpired` discharge. Sized strictly greater than worker
 * cold-start P99 so a slow-booting worker is NEVER re-dispatched over while it
 * initializes; a phantom row outliving its slot is strictly preferable to a
 * second worker landing on the same task. Compared against `Date.now()` IN MAIN
 * — the fold reads only `event.ts`, so re-fold stays deterministic.
 */
export const PENDING_DISPATCH_TTL_MS = 120_000;

/**
 * Heartbeat cadence (ms) for the producer-side `pending_dispatches` TTL sweep.
 * MUST ride a heartbeat, not the level-triggered `data_version` wake: a crashed
 * dispatch can be the only pending row on a quiescent board, where a
 * write-triggered wake never fires and the slot would stay held indefinitely.
 */
export const PENDING_DISPATCH_SWEEP_INTERVAL_MS = 60_000;

/**
 * Events-log live-ingest poll-is-truth fallback cadence. The `@parcel/watcher`
 * hint is the fast path; this periodic scan is the safety net guaranteeing every
 * NDJSON line lands within one interval even if a watcher event is
 * dropped/coalesced or the worker never subscribed. Under the realtime fold bar,
 * near-free when the dir is unchanged.
 */
export const EVENTS_INGEST_FALLBACK_INTERVAL_MS = 3_000;

/**
 * Heartbeat cadence (ms) for the producer-side cold-blob compaction pass. Runs
 * on MAIN's writable connection, paced, so it relocates the cold tail of inline
 * `data` blobs over many passes without ever holding the writer lock long enough
 * to starve a concurrent hook INSERT. Slacker than the dispatch sweep: pure
 * space reclamation with no latency-sensitive consumer.
 */
export const COMPACTION_INTERVAL_MS = 300_000;

/**
 * Steady-state WAL checkpoint cadence (ms). The writer runs at the default
 * `wal_autocheckpoint` pages, so under light write load the WAL can sit large
 * before a fold COMMIT crosses the page threshold, and every RO read has to walk
 * the WAL frame index (which grows with WAL size). This heartbeat issues a
 * `wal_checkpoint(PASSIVE)` on cadence to keep read latency bounded. PASSIVE
 * (never TRUNCATE) is mandatory: TRUNCATE waits for a concurrent writer and would
 * starve a contending hook INSERT into a dead-letter; PASSIVE returns immediately
 * if the writer lock is held. Runs on MAIN's writable connection; reads no
 * wall-clock that feeds a fold.
 */
export const WAL_CHECKPOINT_INTERVAL_MS = 30_000;

/**
 * Select every `pending_dispatches` row aged past the TTL that does NOT already
 * have an open `dispatch_failures` row for the same `(verb, id)`. The LEFT JOIN
 * guard suppresses an expire-mint for a `(verb, id)` whose `DispatchFailed`
 * already discharged the pending row, protecting the race where the
 * `DispatchFailed` event is written but not yet folded. Reads the projection on
 * the passed connection — production passes main's writable connection.
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
  // `dispatched_at` is unix-epoch SECONDS; compare in ms.
  return rows.filter((r) => r.dispatched_at * 1000 < cutoffMs);
}

/**
 * Build the `timeout`-class {@link BackstopRecord} for every pending-dispatch
 * row the TTL sweep expired. Each aged row is a `rescued:true` rescue carrying
 * `staleness_ms` (`dispatched_at` is unix SECONDS; the sidecar uses ms) and the
 * `{verb,id}` detail. `nowMs` is injected — a producer wall-clock read, legal
 * outside any fold. Returns `[]` for an empty `aged` set.
 */
export function buildPendingDispatchSweepRecords(
  aged: { verb: string; id: string; dispatched_at: number }[],
  nowMs: number,
): BackstopRecord[] {
  return aged.map((row) =>
    buildTimeoutRecord({
      backstop: "pending-dispatch-sweep",
      worker: "main",
      rescued: true,
      now: nowMs,
      stalenessMs: nowMs - row.dispatched_at * 1000,
      detail: { verb: row.verb, id: row.id },
    }),
  );
}

/**
 * Run the heavy boot drain with WAL auto-checkpointing DISABLED, then flush the
 * WAL once and restore the steady-state threshold.
 *
 * A from-scratch re-fold commits ~150k one-event transactions back to back. At
 * the default `wal_autocheckpoint` the commit that trips the page threshold
 * absorbs a synchronous checkpoint while holding the write lock, and concurrent
 * hook INSERTs exhaust their `busy_timeout` and dead-letter. With auto-checkpoint
 * off, every fold COMMIT is a pure WAL append so the write lock releases promptly
 * and hook INSERTs interleave; a single `wal_checkpoint(TRUNCATE)` in the
 * `finally` flushes frames back and empties the WAL file. The `finally`
 * guarantees we never leave the long-running writer with checkpointing disabled
 * even if a drain throws.
 *
 * TRUNCATE here, PASSIVE in steady state: this call site runs at boot BEFORE any
 * worker thread spawns (the `new Worker(...)` sites are all later in `start`), so
 * the only connection attached to the DB is main's own writer — TRUNCATE has no
 * concurrent writer or reader to wait on. Emptying the WAL means every worker's
 * first `openDb` reads the main file with no WAL frames to scan and no `-shm`
 * recovery path to walk, removing a raciest-moment failure surface at boot. If an
 * external read-only attachment is present (keeper-py, the performance sitter,
 * dashctl), `PRAGMA wal_checkpoint` returns a busy-status ROW rather than throwing,
 * so the worst case degrades to a `busy_timeout`-bounded pause with PASSIVE
 * semantics and boot still proceeds. Steady-state checkpoints stay PASSIVE — the
 * hook no longer writes the DB (since fn-736) but live workers and the reaper run
 * concurrently there, and PASSIVE skips them without blocking.
 */
export function withBootDrainCheckpointTuning(
  db: Database,
  body: () => void,
): void {
  db.run("PRAGMA wal_autocheckpoint = 0");
  try {
    body();
  } finally {
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    db.run(`PRAGMA wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
  }
}

/**
 * Hard cap on the per-pid dead-letter NDJSON file size before we read it (the
 * hook never truncates / rotates). An oversized file is skip-and-logged — never
 * throws — so one pathological file doesn't OOM or wedge the dir scan.
 */
const MAX_DEAD_LETTER_FILE_BYTES = 16 * 1024 * 1024;

/**
 * Serialize a `UsageSnapshotMessage` into the JSON string that rides in the
 * synthetic `UsageSnapshot` event's `data` blob. The reducer
 * (`extractUsageSnapshot`) decodes the same shape; every projection-meaningful
 * field MUST appear here or the corresponding `usage` column folds to NULL
 * forever. NOT serialized: `kind` (event-tag discriminator) and `id` (rides in
 * `events.session_id`, not the data blob). Slot order here is shape-tolerant;
 * the load-bearing order lives in `usage-worker.ts` `buildUsageMessage`.
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
    // Envelope freshness / plan / stale-error axes — forwarded so the
    // reducer's UPSERT populates the columns instead of folding NULL.
    status: msg.status,
    subscription_active: msg.subscription_active,
    error_type: msg.error_type,
    error_message: msg.error_message,
    error_at: msg.error_at,
    // Rate-limit lift instant — folded into `usage.rate_limit_lifts_at`. The
    // companion `last_usage_fold_at` freshness stamp is NOT serialized; the
    // reducer derives it from the event `ts` (never a wall-clock read in a fold).
    lift_at: msg.lift_at,
  });
}

/**
 * True for a TRANSIENT writer-lock starvation — a `bun:sqlite` `SQLiteError`
 * whose `code` is `SQLITE_BUSY` (errno 5) or `SQLITE_LOCKED` (errno 6). These
 * mean "the writer was contended past the connection `busy_timeout`," which
 * clears on its own; they are categorically distinct from `SQLITE_CORRUPT`
 * (errno 11, malformed image — the fn-746 class) and every other fault, which
 * must stay fatal. Discriminates on `.code` (the stable string bun stamps,
 * e.g. the 2026-06-10 crash trace's `code: "SQLITE_BUSY"`), falling back to the
 * numeric `errno` so a future bun that drops the string is still caught.
 *
 * Pure + dependency-free so the mint-tolerance test can drive it directly.
 */
export function isTransientBusyError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return true;
  }
  const errno = (err as { errno?: unknown }).errno;
  return errno === 5 || errno === 6;
}

/**
 * Scan the dead-letter dir and import each NDJSON file's records into the
 * `dead_letters` operational table via `INSERT OR IGNORE` (keyed on `dl_id`) — a
 * DIRECT operational-table write, NOT an event fold. The `INSERT OR IGNORE`
 * makes re-scanning an unchanged file a no-op, so the "watcher event = re-read
 * everything" pattern is safe. Every recoverable error is swallowed to stderr —
 * the import path MUST NOT throw, or one bad file would wedge boot AND the live
 * message loop (both call this).
 */
export function scanDeadLetterDir(db: Database, dir: string): void {
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
      // Read-vs-delete race: skip-and-log without throwing.
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

    // `parseDeadLetterLine` returns null for an empty/truncated/malformed line
    // (a crash-killed hook may leave a partial trailing line) — skip those.
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
        // A bad row must not wedge the rest of the scan or the boot/live loop.
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
 * The full, current `events` table column list, in CREATE_EVENTS order — the
 * canonical column→value contract BOTH the NDJSON ingester ({@link
 * scanEventsLogDir}) AND the dead-letter replay ({@link recoverOneDeadLetter})
 * bind against. `id` is excluded — it's `INTEGER PRIMARY KEY AUTOINCREMENT`,
 * assigned by SQLite so the ingested row lands at the tail of the log.
 *
 * MUST stay in sync with the CREATE_EVENTS literal AND the prepared
 * `insertEvent` statement in `src/db.ts` — adding an events column touches all
 * three. A LOCKSTEP test pins this list to a live migrated DB's `events`
 * columns so a missing entry fails loud instead of silently dropping from
 * ingest + replay. The ingester/replay bind only the INTERSECTION of this list
 * and the record's `bindings` keys (an unknown column is DROPPED, never folded
 * as poison).
 */
export const INGEST_EVENTS_COLUMNS = [
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
  "backend_exec_type",
  "backend_exec_session_id",
  "backend_exec_pane_id",
  "background_task_id",
] as const;

/**
 * Optional telemetry sink {@link scanEventsLogDir} threads through so a parked
 * poison line emits an `events-ingest-poison` backstop record. Held separately
 * from `db` because the dead-letter parking is unconditional while the backstop
 * emit is observational and may be absent. Main is the sole sidecar writer, so
 * `scanEventsLogDir` writes the line directly (no Worker round-trip).
 */
export type EventsIngestContext = {
  counters: BackstopCounters;
  backstopLogPath: string;
};

/**
 * Ingest the per-pid NDJSON events-log files — the lock-free events path's
 * analogue of {@link scanDeadLetterDir}. For each `<pid>.ndjson` file, scan FROM
 * ITS DURABLE BYTE-OFFSET, parse each COMPLETE line, and `INSERT INTO events`
 * WITH the offset advance in ONE `BEGIN IMMEDIATE` — the atomic-cursor invariant
 * applied to NDJSON→events. MUST run on `db` = main's WRITER connection.
 *
 * EXACTLY-ONCE: the durable per-pid byte-offset (`event_ingest_offsets`, keyed
 * on `(path, inode)`) committed atomically with the INSERT means a watcher
 * re-fire or daemon restart re-scans from the offset and never double-inserts.
 * Purely byte offsets, NO line-counting.
 *
 * STRICT TORN-TAIL: bytes after the file's last `\n` are uncommitted; the offset
 * advances ONLY to the end of the last COMPLETE, parseable line. A killed-hook
 * partial trailing line is NOT folded and NOT skipped past.
 *
 * INODE / OFFSET SAFETY: keyed on `(path, inode)`, so a recycled pid reusing a
 * filename gets a fresh row at offset 0. `stat().size < storedOffset` ⇒ the file
 * was truncated/replaced ⇒ fall the offset to 0 and re-read from the top. Main
 * ALWAYS re-reads from the durable offset, NEVER byte 0 unless size proves a reset.
 *
 * POISON-LINE POLICY: a `parseEventLogLine` → null line inside the
 * newline-terminated loop is BLANK (advance silently) or POISON (unparseable, a
 * later append can't fix it). Park poison as a `dead_letters` row with
 * `status='poison'` (replay's `WHERE status='waiting'` skips it) and a
 * deterministic `dl_id`, INSERTed `ON CONFLICT DO NOTHING` in the SAME
 * `BEGIN IMMEDIATE` as the events INSERTs + offset advance, then advance past it.
 * After COMMIT, emit one backstop record per parked line (best-effort). The
 * poison arm is reachable ONLY inside the newline loop; the trailing torn
 * remainder is UNTOUCHED.
 *
 * A line that PARSES but whose INSERT THROWS rolls the WHOLE transaction back —
 * the offset does NOT advance, so we never silently skip a real event (block +
 * retry). The poison-park INSERT rides the same transaction, so a transient
 * failure rolls both back together.
 *
 * PER-FILE CLEANUP: a file is deleted ONLY when its offset reached EOF AND its
 * pid is no longer live — a live hook's file is never reaped from under it. NO
 * size cap (a long session legitimately exceeds it — unlike dead-letter).
 *
 * NEVER THROWS out of the scan: every recoverable error is swallowed to stderr —
 * a single bad file must not wedge boot OR the live message loop. When `ctx` is
 * absent, poison lines are STILL parked and the offset STILL advances; only the
 * backstop record is skipped.
 */
export function scanEventsLogDir(
  db: Database,
  dir: string,
  ctx?: EventsIngestContext,
): void {
  if (!existsSync(dir)) {
    return;
  }

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    console.error(
      `[keeperd] events-log scan failed to readdir ${dir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }

  const readOffsetStmt = db.prepare(
    "SELECT offset FROM event_ingest_offsets WHERE path = ? AND inode = ?",
  );
  const upsertOffsetStmt = db.prepare(
    `INSERT INTO event_ingest_offsets (path, inode, offset, updated_at)
       VALUES (?, ?, ?, ?)
     ON CONFLICT(path, inode) DO UPDATE SET
       offset = excluded.offset,
       updated_at = excluded.updated_at`,
  );

  for (const name of names) {
    if (!name.endsWith(".ndjson")) {
      // The hook writes per-pid `<pid>.ndjson` files; ignore anything else.
      continue;
    }
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch (err) {
      // Read-vs-delete race (file vanished between readdir and stat): skip.
      console.error(
        `[keeperd] events-log scan stat failed for ${full}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    if (!st.isFile()) {
      continue;
    }
    const inode = st.ino;
    const size = st.size;

    // Durable per-file byte-offset. `(path, inode)` keying isolates a recycled
    // filename (different inode ⇒ fresh row ⇒ offset 0).
    const offRow = readOffsetStmt.get(full, inode) as {
      offset: number;
    } | null;
    let startOffset = offRow ? offRow.offset : 0;
    // Truncation / inode-reuse guard: a file shorter than our stored offset was
    // replaced or wiped — re-read from the top rather than seek past its new
    // (smaller) content.
    if (size < startOffset) {
      startOffset = 0;
    }

    // Parse the per-pid pid from the filename for the cleanup liveness probe.
    // A non-numeric stem (shouldn't happen for `<pid>.ndjson`, but be safe)
    // disables cleanup for that file (treated as "pid unknown / assume live").
    const pidStem = name.slice(0, -".ndjson".length);
    const filePid = /^\d+$/.test(pidStem) ? Number(pidStem) : null;

    let newOffset = startOffset;
    if (size > startOffset) {
      let text: string;
      try {
        // Read the whole file; slice the unread tail. (bun:sqlite + Node fs
        // have no cheap pread-from-offset; the file is one writer's append log
        // and a long session is bounded by the session's own event count.)
        text = readFileSync(full, "utf8");
      } catch (err) {
        console.error(
          `[keeperd] events-log scan read failed for ${full}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }
      // Operate on the byte view so the offset is a true byte count (UTF-8
      // multibyte chars must not skew `\n` byte positions).
      const bytes = Buffer.from(text, "utf8");
      const unread = bytes.subarray(startOffset);

      const records: ReturnType<typeof parseEventLogLine>[] = [];
      // Poison lines parked in `dead_letters` (status='poison') inside the SAME
      // transaction as the events INSERTs + offset advance. The loop CONTINUES
      // past a poison line, so one scan drains a multi-poison file.
      const poison: {
        dlId: string;
        rawCapped: string;
        startOffset: number;
        endOffset: number;
      }[] = [];
      let consumed = 0; // bytes consumed past startOffset (whole lines only)
      let nlIndex = unread.indexOf(0x0a); // '\n'
      let lineStart = 0;
      while (nlIndex !== -1) {
        const lineBytes = unread.subarray(lineStart, nlIndex);
        const lineText = lineBytes.toString("utf8");
        const record = parseEventLogLine(lineText);
        if (record === null) {
          // `parseEventLogLine` → null is EITHER a blank line OR poison;
          // classify inline (its signature is frozen — the hook imports it).
          if (lineText.trim().length === 0) {
            // BLANK line: advance past it silently.
          } else {
            // POISON: an unparseable `\n`-terminated line a later append cannot
            // fix. Park it (deterministic dl_id keyed on inode + absolute start
            // offset → idempotent on re-scan) and CONTINUE.
            const absStart = startOffset + lineStart;
            const absEnd = startOffset + nlIndex + 1; // past the consumed '\n'
            poison.push({
              dlId: `poison:${name}:${inode}:${absStart}`,
              // Cap captured raw at 64 KiB — the bindings blob is for triage.
              rawCapped: lineText.slice(0, 64 * 1024),
              startOffset: absStart,
              endOffset: absEnd,
            });
          }
          // Both blank and poison ADVANCE past the line so the offset never
          // sticks on a non-event.
          consumed = nlIndex + 1;
          lineStart = nlIndex + 1;
          nlIndex = unread.indexOf(0x0a, lineStart);
          continue;
        }
        records.push(record);
        // +1 for the consumed '\n'.
        consumed = nlIndex + 1;
        lineStart = nlIndex + 1;
        nlIndex = unread.indexOf(0x0a, lineStart);
      }
      // Trailing bytes after the last `\n` are an uncommitted partial line
      // (strict torn-tail) — `consumed` excludes them; a mid-write event is
      // never dead-lettered or skipped.
      newOffset = startOffset + consumed;

      if (records.length > 0 || poison.length > 0) {
        // Atomic: every events INSERT + every poison park + the offset advance
        // in ONE BEGIN IMMEDIATE. A throw rolls ALL back — the offset never
        // advances past a line we failed to land/park (block + retry). The
        // all-blank case advances the offset in the `else if` branch below.
        db.run("BEGIN IMMEDIATE");
        try {
          for (const record of records) {
            if (record === null) continue;
            const bindings = record.bindings;
            const presentCols = INGEST_EVENTS_COLUMNS.filter((c) =>
              Object.hasOwn(bindings, c),
            );
            if (presentCols.length === 0) {
              // No recognized events column: skip the INSERT but let the offset
              // advance past it (a no-op line, safe to consume).
              continue;
            }
            const placeholders = presentCols.map(() => "?").join(", ");
            const values = presentCols.map((c) => {
              const v = bindings[c];
              // Booleans serialize as 0/1 (matches the hook's INSERT).
              if (typeof v === "boolean") return v ? 1 : 0;
              return v as string | number | null;
            });
            db.prepare(
              `INSERT INTO events (${presentCols.join(", ")}) VALUES (${placeholders})`,
            ).run(...values);
          }
          // Park every poison line as a `dead_letters` row with status='poison'
          // (replay's `WHERE status='waiting'` skips it). `ON CONFLICT DO NOTHING`
          // makes it idempotent on re-scan. `ts`/`dl_written_at` are scan
          // wall-clock — dead_letters is an operational sidecar, never folded.
          const nowSec = Date.now() / 1000;
          for (const p of poison) {
            db.prepare(
              `INSERT INTO dead_letters
                 (dl_id, session_id, hook_event, ts, dl_written_at, pid,
                  bindings, status, recovered_at, replayed_event_id, source_file)
               VALUES (?, 'poison', 'PoisonLine', ?, ?, ?, ?, 'poison', NULL, NULL, ?)
               ON CONFLICT(dl_id) DO NOTHING`,
            ).run(
              p.dlId,
              nowSec,
              nowSec,
              filePid,
              JSON.stringify({
                raw: p.rawCapped,
                file: full,
                start_offset: p.startOffset,
                end_offset: p.endOffset,
              }),
              full,
            );
          }
          upsertOffsetStmt.run(full, inode, newOffset, Date.now() / 1000);
          db.run("COMMIT");
          // After a durable COMMIT, emit one `events-ingest-poison` backstop
          // record per parked line when the sink is wired. Post-COMMIT keeps the
          // metric honest (a rolled-back parse never counts); best-effort.
          if (ctx !== undefined && poison.length > 0) {
            for (const p of poison) {
              ctx.counters.bump("events-ingest-poison", "timeout", true);
              appendBackstopRecord(
                buildTimeoutRecord({
                  backstop: "events-ingest-poison",
                  worker: "main",
                  rescued: true,
                  now: Date.now(),
                  stalenessMs: null,
                  detail: {
                    file: full,
                    start_offset: String(p.startOffset),
                    dl_id: p.dlId,
                  },
                }),
                ctx.backstopLogPath,
              );
            }
          }
        } catch (err) {
          try {
            db.run("ROLLBACK");
          } catch {
            // best-effort
          }
          // Offset did NOT advance (rolled back) — a re-scan retries from the
          // unchanged offset. Log and move on; do NOT throw out of the scan.
          console.error(
            `[keeperd] events-log INSERT failed for ${full} (offset stays ${startOffset}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          continue;
        }
      } else if (newOffset !== startOffset) {
        // No INSERTable records but whole lines WERE consumed (all no-op
        // lines) — still advance the offset durably so we don't re-read them.
        try {
          upsertOffsetStmt.run(full, inode, newOffset, Date.now() / 1000);
        } catch (err) {
          console.error(
            `[keeperd] events-log offset advance failed for ${full}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          continue;
        }
      }
    }

    // Per-file cleanup: delete ONLY when fully drained (offset at EOF) AND the
    // pid is no longer live. `pidAlive` is a producer-side liveness probe.
    if (filePid !== null && newOffset >= size && !pidAlive(filePid)) {
      try {
        unlinkSync(full);
        // Drop the offset row too so the table doesn't accumulate dead rows.
        db.prepare(
          "DELETE FROM event_ingest_offsets WHERE path = ? AND inode = ?",
        ).run(full, inode);
      } catch (err) {
        // Delete race / EPERM — non-fatal; a later scan retries the cleanup.
        console.error(
          `[keeperd] events-log cleanup failed for ${full}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}

/**
 * `process.kill(pid, 0)` — alive iff it resolves or EPERM; ESRCH means gone.
 * Producer-side probe, used ONLY for the events-log file-cleanup gate — never
 * inside a fold.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

/**
 * Recover ONE oldest `waiting` dead-letter row: pick the smallest
 * `(dl_written_at, dl_id)`, rebuild an `events` INSERT from its stored
 * `bindings`, and flip the row to `recovered` — all in ONE `BEGIN IMMEDIATE`.
 * Returns the recovered `dl_id`, or `null` when no `waiting` rows remain.
 *
 * MUST run on main (the writer connection); the server-worker's
 * `replay_dead_letter` RPC routes through the worker→main bridge so the write
 * lands here. The replayed event is a PLAIN REAL event (original `pid`,
 * `start_time`, `data`, etc.), NOT a synthetic mint — a from-scratch re-fold
 * reproduces the projection byte-identically. The INSERT column list is
 * `INGEST_EVENTS_COLUMNS ∩ keys(bindings)`; an unknown column is dropped.
 *
 * A throw rolls back BOTH the INSERT and the UPDATE — the row stays `waiting`,
 * the events log stays untouched, and the next replay retries it. A recovered
 * row is never picked again (`WHERE status='waiting'` filters it out).
 */
export function recoverOneDeadLetter(db: Database): string | null {
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.bindings);
    } catch (err) {
      // Unparseable bindings: throw so the transaction rolls back and the row
      // stays `waiting` for an operator. The dl_id names the offending row.
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

    // INSERT column list = events columns ∩ bindings keys. Unknown keys are
    // dropped. The list is interpolated directly (INGEST_EVENTS_COLUMNS is a
    // module constant, no wire text); values are bound positionally.
    const presentCols = INGEST_EVENTS_COLUMNS.filter((c) =>
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
      // Booleans serialize as 0/1.
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
 * thread before any watcher worker spawns. The daemon spawns several
 * `@parcel/watcher`-loading workers back-to-back; if their FIRST dlopens race
 * concurrently, Bun crashes them with `napi_register_module_v1 not found`. A
 * synchronous `require("@parcel/watcher")` on main forces the first dlopen +
 * registration to complete BEFORE the spawn block runs, so the worker dlopens no
 * longer race a not-yet-registered module (each worker still gets its own
 * `napi_env` — not a shared watcher).
 *
 * A genuine permanent load failure (missing `node_modules`, ABI mismatch) is
 * unrecoverable — no in-process self-heal. This logs a LOUD boot assertion then
 * RE-THROWS; the caller takes the single recovery path (`process.exit(1)` →
 * launchd restart). Split out (injectable `loader` + `logError`) so a test can
 * force the failure branch.
 */
export function prewarmWatcherAddon(
  loader: () => unknown = () => require("@parcel/watcher"),
  logError: (msg: string) => void = (msg) => console.error(msg),
): void {
  try {
    loader();
  } catch (err) {
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
 * The worker threads {@link startDaemon} spawns, each addressable by a stable
 * name so a test can boot a SUBSET. The REDUCER itself runs on MAIN
 * (`drainToCompletion`), woken by the `wake` worker — there is no reducer worker.
 */
export type WorkerName =
  | "wake"
  | "server"
  | "transcript"
  | "plan"
  | "exit"
  | "git"
  | "usage"
  | "builds"
  | "deadLetter"
  | "eventsIngest"
  | "autopilot"
  | "maintenance"
  | "restore";

/**
 * The full worker set, in spawn order — the production boot ({@link runDaemon}
 * passes no `workers` selector, so {@link startDaemon} defaults here). Source of
 * truth for the "production boot spawns all workers" regression test.
 */
export const ALL_WORKERS: readonly WorkerName[] = [
  "wake",
  "server",
  "transcript",
  "plan",
  "exit",
  "git",
  "usage",
  "builds",
  "deadLetter",
  "eventsIngest",
  "autopilot",
  "maintenance",
  "restore",
] as const;

/**
 * The watcher workers that dlopen `@parcel/watcher`. Decides whether the
 * main-thread pre-warm ({@link prewarmWatcherAddon}) is needed: it runs ONLY when
 * at least one of these is in the selected set.
 */
const WATCHER_WORKERS: readonly WorkerName[] = [
  "transcript",
  "plan",
  "git",
  "usage",
  "deadLetter",
  "eventsIngest",
] as const;

/**
 * Options for {@link startDaemon}. The production `runDaemon()` boot passes none;
 * the in-process test harness sets these.
 */
export interface DaemonOptions {
  /**
   * When `true`, every watcher worker skips its `import("@parcel/watcher")` and
   * main skips the {@link prewarmWatcherAddon} pre-warm — so an in-process daemon
   * runs the fold pipeline WITHOUT a worker-thread NAPI-addon dlopen (the SIGTRAP
   * source under the parallel slow-test tier). The plan-worker degrades to its
   * `data_version`-poll + heartbeat fold path; main's events-log fallback poll
   * still ingests every NDJSON line.
   */
  disableNativeWatcher?: boolean;
  /**
   * Worker-set selector. When supplied, {@link startDaemon} spawns ONLY the named
   * workers; every unselected worker stays `null` with no handlers wired. OMITTED
   * (production default) spawns the full {@link ALL_WORKERS} set.
   */
  workers?: readonly WorkerName[];
}

/**
 * The handle {@link startDaemon} returns. `stop()` runs the full teardown WITHOUT
 * `process.exit`, so a test can boot and tear down an in-process daemon many
 * times in one process. `sockPath` is the UDS path the server worker bound.
 */
export interface DaemonHandle {
  /** Tear down all workers + db WITHOUT `process.exit`. Idempotent. */
  stop(): Promise<void>;
  /** The UDS socket path the server worker bound. */
  sockPath: string;
}

/**
 * Boot the daemon programmatically and return a {@link DaemonHandle}. Runs the
 * same migrate → boot-drain → seed-sweep → worker-spawn sequence as production,
 * but returns a handle whose `stop()` tears everything down WITHOUT
 * `process.exit`. The production entry point {@link runDaemon} is a thin wrapper:
 * `startDaemon()` (no opts) plus the SIGTERM/SIGINT → exit-0 handlers (a clean
 * stop exits 0 → launchd does NOT restart; a crash takes `fatalExit` → exit 1 →
 * restart).
 */
export function startDaemon(opts: DaemonOptions = {}): DaemonHandle {
  process.title = "keeperd";
  // Worker-set selector; omitted → ALL_WORKERS. `want(name)` gates each
  // `new Worker(...)` site below. The fold REDUCER runs on MAIN regardless.
  const selectedWorkers = new Set<WorkerName>(opts.workers ?? ALL_WORKERS);
  const want = (name: WorkerName): boolean => selectedWorkers.has(name);
  // Resolve the UDS path the same way the server worker does, so the returned
  // handle exposes it for `waitForDaemon`.
  const sockPath = resolveSockPath();

  const dbPath = resolveDbPath();
  // 256MB page cache on the writer connection: folds run here under the write
  // lock, and the small default cache evicted hot attribution-index pages
  // between folds, paying seconds of I/O on the large log and starving hook
  // INSERTs. The short-lived hook keeps the small default.
  const { db, stmts } = openDb(dbPath, { cacheSizeKb: 262144 });

  // Plan roots wired to the plan worker below. Resolved in the post-migration
  // window so the worker spawns with the same root set the rest of boot uses.
  const planRoots = resolvePlanRoots();

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

  // Step 1b — events-log boot ingest. Land every per-pid NDJSON line the hook
  // wrote during downtime as an `events` row BEFORE the boot drain, so the drain
  // folds them this boot pass. MUST precede `drainToCompletion`. The scan reads
  // each file from its DURABLE per-pid byte-offset (exactly-once), is idempotent
  // under re-scan, and tolerates a missing/empty dir. DIRECT write on `db`
  // (main's writer conn) so the INSERT bumps `data_version`.
  //
  // Backstop-telemetry sidecar: main is the SOLE writer. Each backstop-emitting
  // worker posts a built `{kind:"backstop"}` record up; `handleBackstopMessage`
  // writes the single NDJSON line. `mainBackstopCounters` covers any
  // main-produced backstop and is flushed as an on-shutdown rollup so the
  // denominator survives a clean stop. Declared BEFORE the boot events-log scan
  // so that scan can thread the same sink into `scanEventsLogDir`.
  const backstopLogPath = resolveBackstopLogPath();
  const mainBackstopCounters = new BackstopCounters();
  const handleBackstopMessage = (msg: BackstopMessage): void => {
    appendBackstopRecord(msg.record, backstopLogPath);
  };
  // Shared telemetry sink every `scanEventsLogDir` call site threads so a parked
  // poison line emits a record. Sole-writer: main writes the line directly; the
  // events-ingest worker only posts a contentless "go look" hint.
  const eventsIngestCtx: EventsIngestContext = {
    counters: mainBackstopCounters,
    backstopLogPath,
  };

  const eventsLogDir = resolveEventsLogDir();
  // The events-ingest worker subscribes ONCE at spawn and goes inert with NO
  // retry if the dir is absent. `mkdir` it HERE — before the boot scan AND the
  // worker spawn — so the worker always finds it regardless of deploy ordering,
  // never leaving the live ingest path dead until the next restart.
  mkdirSync(eventsLogDir, { recursive: true });
  scanEventsLogDir(db, eventsLogDir, eventsIngestCtx);

  withBootDrainCheckpointTuning(db, () => {
    drainToCompletion(db, DEFAULT_BATCH_SIZE, bootPace);
    seedKilledSweep(db);
    // Unconditional boot-append of an `AutopilotPaused{paused:true}` re-arm. The
    // worker boots PAUSED in memory (safety default); this synthetic event
    // preserves that in the durable `autopilot_state` projection so the viewer's
    // banner reads `[paused]` honestly from boot. The trailing `drainToCompletion`
    // folds it BEFORE `serverWorker` spawns. Raw `db.run` INSERT — the column list
    // MUST stay in sync with the prepared form in `prepareStmts`.
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
        Date.now() / 1000, // unix seconds as REAL
        "autopilot", // stable synthetic session_id
        null, // pid
        "AutopilotPaused",
        "autopilot_state", // synthetic event_type tag
        null, // tool_name
        null, // matcher
        null, // cwd
        null, // permission_mode
        null, // agent_id
        null, // agent_type
        null, // stop_hook_active
        JSON.stringify({ paused: true }), // boot re-arm
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
    // Unconditional boot-append of an `AutopilotCapSet` re-arm carrying the
    // global concurrency cap, minted AFTER the `AutopilotPaused` re-arm (so the
    // cap fold hits the shared-singleton CONFLICT branch and preserves the
    // just-folded `paused` flag) and BEFORE the trailing `drainToCompletion`. The
    // cap value is read from config HERE, on main, and FROZEN into the payload —
    // `resolveConfig()` is NEVER called inside the fold (re-fold determinism). The
    // column LAGS config until the next restart re-mints. Raw `db.run` INSERT —
    // column list MUST stay in sync with `prepareStmts`.
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
        Date.now() / 1000, // unix seconds as REAL
        "autopilot", // stable synthetic session_id
        null, // pid
        "AutopilotCapSet",
        "autopilot_state", // synthetic event_type tag
        null, // tool_name
        null, // matcher
        null, // cwd
        null, // permission_mode
        null, // agent_id
        null, // agent_type
        null, // stop_hook_active
        // Config read on MAIN, frozen into the payload. `?? null` = unlimited.
        JSON.stringify({
          max_concurrent_jobs: resolveConfig().maxConcurrentJobs ?? null,
        }),
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

  // Step 2b — dead-letter boot import. Read every NDJSON file the hook wrote
  // during downtime and INSERT OR IGNORE each parsed record into `dead_letters`
  // as `waiting`. MUST run before the dead-letter worker AND the server worker
  // start serving so a board client sees the full backlog. Idempotent
  // (`INSERT OR IGNORE` on `dl_id`); a DIRECT operational-table write, NOT a fold.
  const deadLetterDir = resolveDeadLetterDir();
  scanDeadLetterDir(db, deadLetterDir);

  // Coalescing flag: every wake sets it; the run loop resets it before each
  // drain pass. A wake arriving mid-drain leaves the flag set, so the loop runs
  // one more pass — no event is missed (drain re-reads from the cursor).
  let wakePending = false;
  let draining = false;
  let shuttingDown = false;

  // Autopilot in-memory paused flag. Boots PAUSED (safety default). Lives ONLY
  // in main's memory — never persisted, never RPC-writable except via the
  // `set_autopilot_paused` RPC. The worker is told via the main→worker
  // `{ type: "set-paused", paused }` channel.
  let autopilotPaused = true;
  // Forward references filled in when the workers spawn below; the bridge
  // handlers capture these via closure. Until a worker is constructed, a bridge
  // request resolves `ok:false` — a tolerated no-op for the boot-window race.
  let autopilotWorker: Worker | null = null;
  // The plan-worker posts a `nudge-discovery` the first time it sees a `.planctl`
  // tree; main relays it to the git-worker as an `add-discovery-root`. `null`
  // until the git worker is constructed — a nudge during that window is a no-op
  // (the next discovery sweep recovers it).
  let gitWorkerRef: Worker | null = null;
  // `pumpWakes` captures this via closure to `kick` the server after a drain; the
  // `?.` tolerates the null window (and a server-less boot).
  let serverWorker: Worker | null = null;

  /**
   * Process the wake signal. The re-entrancy guard (`draining`) ensures we never
   * drain recursively if a wake lands mid-loop; that wake just leaves
   * `wakePending` set for the in-flight loop to pick up.
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
    // Kick the server-worker AFTER the drain loop returns (post-COMMIT) so it
    // runs `diffTick` immediately instead of waiting for its next poll tick.
    // Posted strictly after `drainToCompletion` so the worker never reads a
    // pre-commit `data_version`; the worker's `pollLoop` is the lost-wakeup
    // backstop and the kick is idempotent. Skip a no-op pump and shutdown.
    if (folded && !shuttingDown) {
      serverWorker?.postMessage({ type: "kick" } satisfies KickMessage);
    }
  }

  /**
   * Mint one synthetic usage `events` row, surviving a transient writer-lock
   * starvation instead of crashing the daemon.
   *
   * The usage producer churns `<id>.json` create/delete events whenever the
   * agentuse daemon rotates a profile, so its mint is the one most likely to
   * land mid-checkpoint while a multi-GB WAL writer holds the lock past the
   * connection `busy_timeout`. `insertEvent.run` is synchronous, so on that
   * miss it throws `SQLITE_BUSY` straight up through `uw.onmessage` (no awaits,
   * no catch) to `process.on("uncaughtException")` → `fatalExit` — turning a
   * recoverable lock-contention blip into a full restart into the unpaused-boot
   * dispatch window. The 2026-06-10 incident took 39 such restarts.
   *
   * A DROPPED usage mint is recoverable BY DESIGN, which is what makes
   * drop-don't-crash safe HERE specifically (the other producer mints have no
   * such re-emit and must NOT adopt this without their own recoverability
   * argument): a snapshot re-emits on the file's next change-gated write, and a
   * tombstone is re-retracted by the next boot scan's {@link UsageScanner.sweep}
   * (it diffs the live projection against the on-disk census). So a transient
   * `SQLITE_BUSY` is logged loudly and dropped; the daemon stays up.
   *
   * Every OTHER error — notably `SQLITE_CORRUPT` (the malformed-image / fn-746
   * class) — still rethrows so the loud-and-`fatalExit`-and-relaunch contract
   * holds for genuine corruption. This narrows the fatal surface to real faults
   * without widening any write path.
   *
   * @returns `true` if the row landed, `false` if a transient busy dropped it.
   */
  function mintUsageEventTolerant(
    params: Parameters<typeof stmts.insertEvent.run>[0],
  ): boolean {
    try {
      stmts.insertEvent.run(params);
      return true;
    } catch (err) {
      if (isTransientBusyError(err)) {
        console.error(
          "[keeperd] usage mint dropped a synthetic event on transient writer-lock " +
            "contention (recoverable via re-emit / boot sweep); daemon stays up:",
          err,
        );
        return false;
      }
      throw err;
    }
  }

  // Step 2d — pre-warm the native @parcel/watcher addon ON MAIN before ANY
  // worker spawns. See {@link prewarmWatcherAddon}. Skip it when the watcher
  // workers won't dlopen the addon (in-process tier — loading it on main would
  // defeat the SIGTRAP avoidance) or when NO watcher worker is selected (no
  // first-dlopen race to serialize).
  const anyWatcherSelected = WATCHER_WORKERS.some((n) => want(n));
  if (!opts.disableNativeWatcher && anyWatcherSelected) {
    try {
      prewarmWatcherAddon();
    } catch {
      // The loud assertion already fired inside the helper. Take the sole
      // recovery path — exit non-zero so launchd restarts us. NO self-heal.
      fatalExit();
      return null as unknown as DaemonHandle;
    }
  }

  // Step 3 — spawn the wake worker. Bun uses the web Worker API; `workerData` is
  // a worker_threads option not in the DOM lib type, hence the cast. A daemon
  // without the wake worker never pumps main's reducer drain, so a fold-driven
  // test MUST include `wake`.
  let worker: Worker | null = null;
  if (want("wake")) {
    worker = new Worker(new URL("./wake-worker.ts", import.meta.url).href, {
      workerData: { dbPath, pollMs: 25 } satisfies WakeWorkerData,
    } as WorkerOptions & { workerData: unknown });

    // Step 4 — each wake message triggers a (coalescing) drain pass.
    worker.onmessage = (ev: MessageEvent<WakeMessage | undefined>): void => {
      if (ev.data && ev.data.kind === "wake") {
        wakePending = true;
        pumpWakes();
      }
    };

    // Worker `error` is NOT a message — the worker thread itself failed. Single
    // recovery path: crash → exit 1 → launchd restarts; never respawn in-process.
    // The `!shuttingDown` guard (mirrored on every worker's onerror) keeps a
    // worker erroring mid-teardown from clobbering the clean `exit(0)`.
    worker.onerror = (err: ErrorEvent): void => {
      console.error("[keeperd] wake worker error:", err.message ?? err);
      if (!shuttingDown) fatalExit();
    };

    // A worker `process.exit(1)` fires `close`, NOT `onerror` — so the crash path
    // needs its own listener, or a crashing worker leaves a zombie daemon. The
    // `!shuttingDown` guard makes this a no-op on the clean path, avoiding a double
    // exit.
    worker.addEventListener("close", () => {
      if (!shuttingDown) fatalExit();
    });
  }

  // Spawn the server worker in the SAME post-migration window: its read-only
  // `openDb` would fail loud against a missing/un-migrated DB. It binds the UDS,
  // acquires the ownership lock, and runs its own `data_version` poll — fully
  // decoupled from the reducer. `dbPath` is the only required field; sock/lock
  // paths default to `resolveSockPath()` worker-side (KEEPER_SOCK honored there).
  // `serverWorker` was forward-declared above (for `pumpWakes`'s kick); assign
  // it here when selected. A boot without the server worker binds no UDS — a
  // query/RPC test MUST include `server`.
  if (want("server")) {
    serverWorker = new Worker(
      new URL("./server-worker.ts", import.meta.url).href,
      {
        workerData: { dbPath, role: "server" } satisfies ServerWorkerData,
      } as WorkerOptions & { workerData: unknown },
    );
    // A non-null local so the bridge closures don't re-narrow the nullable field.
    const sw = serverWorker;

    // Server-worker → main bridge. Every inbound message carries a `kind`
    // discriminator so a stale reply for one verb can't wrong-resolve another.
    // The `{kind:"ready"}` signal is one-way (worker→main) and matches no branch.
    sw.onmessage = (
      ev: MessageEvent<
        | ReplayRequestMessage
        | SetAutopilotPausedRequestMessage
        | RetryDispatchRequestMessage
        | SetAutopilotModeRequestMessage
        | SetEpicArmedRequestMessage
        | { kind: "ready" }
        | undefined
      >,
    ): void => {
      const msg = ev.data;
      if (!msg) return;
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
            // Appended a real `events` row — pump a wake so the reducer folds it
            // without waiting for the wake worker's `data_version` poll.
            wakePending = true;
            pumpWakes();
          }
        } catch (err) {
          // Recovery transaction crashed — surface as a typed `ok:false` reply;
          // the worker's dispatcher frames `rpc_failed` on the wire.
          reply = {
            type: "replay-result",
            id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        sw.postMessage(reply);
        return;
      }
      if (msg.kind === "set-autopilot-paused-request") {
        // APPEND an `AutopilotPaused` synthetic event FIRST so the reducer folds
        // it into the `autopilot_state` singleton, THEN — only on a successful
        // insert — flip the in-memory `autopilotPaused` flag and relay
        // `{type:"set-paused"}` to the worker. Order matters: the gate (dispatch
        // decision) and the projection (viewer state) MUST NOT diverge on a
        // partial failure. If the insert throws, neither flips and the RPC
        // returns `ok:false`. Column list MUST stay in sync with the other
        // synthetic mints. Surfaces `ok:false` only if the worker isn't yet
        // constructed (boot race) or the insert throws.
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
            // Flip the in-memory gate + relay only AFTER the event is durably
            // appended; a throw above leaves both untouched.
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
        sw.postMessage(reply);
        return;
      }
      if (msg.kind === "set-autopilot-mode-request") {
        // APPEND an `AutopilotMode` synthetic event so the reducer folds it into
        // the `autopilot_state` singleton's `mode` column, then pump a wake.
        // APPEND-ONLY, and DELIBERATELY no relay to the worker: the reconciler is
        // level-triggered and re-reads `mode` from the projection every cycle.
        // Mode is durable user intent, not a safety reset like `paused`, so there
        // is no in-memory flag and no boot re-arm. DO NOT "fix" this to a relay.
        const id = msg.id;
        let reply: SetAutopilotModeResultMessage;
        try {
          stmts.insertEvent.run({
            $ts: Date.now() / 1000,
            $session_id: "autopilot",
            $pid: null,
            $hook_event: "AutopilotMode",
            $event_type: "autopilot_state",
            $tool_name: null,
            $matcher: null,
            $cwd: null,
            $permission_mode: null,
            $agent_id: null,
            $agent_type: null,
            $stop_hook_active: null,
            $data: JSON.stringify({ mode: msg.mode }),
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
          reply = { type: "set-autopilot-mode-result", id, ok: true };
        } catch (err) {
          reply = {
            type: "set-autopilot-mode-result",
            id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        sw.postMessage(reply);
        return;
      }
      if (msg.kind === "set-epic-armed-request") {
        // APPEND an `EpicArmed` synthetic event so the reducer folds it into the
        // `armed_epics` PRESENCE table (`armed:true` → INSERT, `armed:false` →
        // DELETE), then pump a wake. APPEND-ONLY, same NO-relay contract as
        // set-autopilot-mode: the reconciler re-reads the armed set each cycle.
        //
        // ONE carve-out: an `armed:true` request against an epic PRESENT in the
        // `epics` projection AND `status='done'` is REJECTED before the append,
        // closing the arm-after-done hole the fold-prune can't reach. `armed:false`
        // (disarm) ALWAYS succeeds, and an ABSENT (not-yet-folded) epics row is
        // STILL allowed — a `done` epic is definitionally folded, so this never
        // rejects a legitimately-racing arm. The status read uses main's writer
        // `db` (the worker-side handler is forbidden a DB connection).
        const id = msg.id;
        let reply: SetEpicArmedResultMessage;
        try {
          if (msg.armed) {
            const epicRow = db
              .query("SELECT status FROM epics WHERE epic_id = ?")
              .get(msg.epic_id) as { status: string } | null;
            if (epicRow && epicRow.status === "done") {
              sw.postMessage({
                type: "set-epic-armed-result",
                id,
                ok: false,
                error: `cannot arm \`${msg.epic_id}\`: epic is already done`,
              });
              return;
            }
          }
          stmts.insertEvent.run({
            $ts: Date.now() / 1000,
            $session_id: msg.epic_id,
            $pid: null,
            $hook_event: "EpicArmed",
            $event_type: "armed_epics",
            $tool_name: null,
            $matcher: null,
            $cwd: null,
            $permission_mode: null,
            $agent_id: null,
            $agent_type: null,
            $stop_hook_active: null,
            $data: JSON.stringify({ epic_id: msg.epic_id, armed: msg.armed }),
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
          reply = { type: "set-epic-armed-result", id, ok: true };
        } catch (err) {
          reply = {
            type: "set-epic-armed-result",
            id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        sw.postMessage(reply);
        return;
      }
      if (msg.kind === "retry-dispatch-request") {
        // Append a `DispatchCleared` synthetic event so the reducer's fold arm
        // DELETEs the matching `dispatch_failures` row on the next drain. The
        // wire `verb` / `dispatch_id` are validated handler-side; main treats
        // both as opaque payload tokens.
        const id = msg.id;
        let reply: RetryDispatchResultMessage;
        try {
          const data = JSON.stringify({
            verb: msg.verb,
            id: msg.dispatch_id,
          });
          stmts.insertEvent.run({
            $ts: Date.now() / 1000,
            // The dispatch key rides as the entity-key overload so a re-fold can
            // correlate the event to its dispatch_failures row without re-parsing
            // the data blob. The composite `${verb}::${id}` is unambiguous.
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
        sw.postMessage(reply);
        return;
      }
    };

    // Same crash policy as the wake worker: any thread failure → fatalExit → exit
    // 1 → launchd restart. No in-process respawn.
    sw.onerror = (err: ErrorEvent): void => {
      console.error("[keeperd] server worker error:", err.message ?? err);
      if (!shuttingDown) fatalExit();
    };

    // Same crash-via-`close` gap as the wake worker: a server-worker
    // `process.exit(1)` fires `close`, not `onerror`. `!shuttingDown` makes it
    // inert on the clean shutdown path.
    sw.addEventListener("close", () => {
      if (!shuttingDown) fatalExit();
    });
  } // end `if (want("server"))`

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
  // Gated on the selector — `null` when unselected; the handler wiring below is
  // guarded so it is never touched.
  const transcriptWorker = want("transcript")
    ? new Worker(new URL("./transcript-worker.ts", import.meta.url).href, {
        workerData: {
          dbPath,
          watchRoot: resolveClaudeProjectsRoot(),
          disableNativeWatcher: opts.disableNativeWatcher,
        } satisfies TranscriptWorkerData,
      } as WorkerOptions & { workerData: unknown })
    : null;

  // Wire handlers only when the worker was selected.
  if (transcriptWorker) {
    const tw = transcriptWorker;
    // Main stays the SOLE writer: a worker `transcript-title` message becomes a
    // synthetic `TranscriptTitle` events row on the WRITABLE connection, then a
    // wake pump folds it. The title rides in `data.session_title` (the field the
    // reducer's title rule reads); everything else is NULL (synthetic).
    tw.onmessage = (
      ev: MessageEvent<
        | TranscriptTitleMessage
        | ApiErrorMessage
        | InputRequestMessage
        | BackstopMessage
        | undefined
      >,
    ): void => {
      const msg = ev.data;
      if (!msg) {
        return;
      }
      if (msg.kind === "backstop") {
        // A backstop rescue/rollup record. Main is the SOLE sidecar writer —
        // append the line. NOT an event fold (never read by the reducer).
        handleBackstopMessage(msg);
        return;
      }
      if (msg.kind === "transcript-title") {
        stmts.insertEvent.run({
          $ts: Date.now() / 1000, // unix seconds as REAL
          $session_id: msg.sessionId, // == job_id
          $pid: null,
          $hook_event: "TranscriptTitle", // reducer maps → 'transcript'
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
        // Our own INSERT bumps data_version — pump directly so the title folds
        // without a poll-cycle delay.
        wakePending = true;
        pumpWakes();
        return;
      }
      if (msg.kind === "api-error") {
        // Synthetic `ApiError` event minted from the transcript-worker signal.
        // The reducer's `ApiError` arm folds it by flipping `jobs.state` to
        // 'stopped' AND stamping `(last_api_error_at, last_api_error_kind)` in
        // one compound UPDATE. The matched kind rides in `data.kind`, the display
        // text in `data.text`; everything else is NULL (synthetic).
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
        // signal — a built-in interactive tool that fires no Pre/PostToolUse hook
        // of its own. The reducer's `InputRequest` arm folds it by flipping
        // `jobs.state` to 'stopped' AND stamping `(last_input_request_at,
        // last_input_request_kind)` in one compound UPDATE. The matched kind
        // rides in `data.kind`; everything else is NULL (synthetic).
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
    tw.onerror = (err: ErrorEvent): void => {
      console.error("[keeperd] transcript worker error:", err.message ?? err);
      if (!shuttingDown) fatalExit();
    };

    // Same crash-via-`close` gap: a transcript-worker `process.exit(1)` fires
    // `close`, not `onerror`. `!shuttingDown` makes it inert on clean shutdown.
    tw.addEventListener("close", () => {
      if (!shuttingDown) fatalExit();
    });
  } // end `if (transcriptWorker)`

  // Spawn the plan worker in the SAME post-migration window. It watches each
  // configured project root's `.planctl/{epics,tasks}` trees and posts a
  // `plan-epic`/`plan-task` snapshot message on each change — the second
  // producer-worker instance. `roots` come from `resolvePlanRoots()` (config →
  // absolute, existing dirs); an empty list means there is nothing to watch.
  // Gated on the selector. Cross-referenced by the git-worker handler (the
  // planctl-commit-changed forward) via `planWorker?.postMessage` — null-safe
  // when unselected.
  const planWorker = want("plan")
    ? new Worker(new URL("./plan-worker.ts", import.meta.url).href, {
        workerData: {
          dbPath,
          roots: planRoots,
          disableNativeWatcher: opts.disableNativeWatcher,
        } satisfies PlanWorkerData,
      } as WorkerOptions & { workerData: unknown })
    : null;

  if (planWorker) {
    const pw = planWorker;
    // Main stays the SOLE writer: a `plan-epic`/`plan-task` snapshot message
    // becomes a synthetic `EpicSnapshot`/`TaskSnapshot` events row on the WRITABLE
    // connection, then a wake pump folds it (upsert into the `epics`/`tasks`
    // projection). The entity id rides in `session_id`; the full snapshot in
    // `data` (the field `extractPlanSnapshot` parses). Everything else is NULL.
    pw.onmessage = (ev: MessageEvent<PlanWorkerOutbound | undefined>): void => {
      const msg = ev.data;
      if (!msg) {
        return;
      }
      if (msg.kind === "backstop") {
        // Main is the SOLE sidecar writer — append the line. NOT an event fold
        // (a pure consumer-side side-file, never read by the reducer).
        handleBackstopMessage(msg);
        return;
      }
      if (msg.kind === "nudge-discovery") {
        // Discovery nudge: the plan-worker first saw a `.planctl` tree in
        // `msg.root`. Forward to the git-worker so it watches that repo's `.git`
        // immediately. NOT written to the event log — it drives a producer
        // worker. The forward-ref null-guards the boot window before the git
        // worker is constructed.
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
          // Planctl-native effort tier — rides FREE in the embedded-tasks JSON
          // (no schema column). An older blob lacks this key and the reducer
          // reads `snapshot.tier ?? null` (graceful degradation).
          tier: msg.tier,
          // Derived worker-phase binary (`worker_done_at` present → "done", else
          // "open"), kept distinct from `runtime_status` (planctl's native enum).
          worker_phase: msg.workerPhase,
          // Planctl-native runtime status (`todo|in_progress|done|blocked`).
          runtime_status: msg.runtimeStatus,
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
    pw.onerror = (err: ErrorEvent): void => {
      console.error("[keeperd] plan worker error:", err.message ?? err);
      if (!shuttingDown) fatalExit();
    };

    // Same crash-via-`close` gap: a plan-worker `process.exit(1)` fires `close`,
    // not `onerror`. `!shuttingDown` makes it inert on clean shutdown.
    pw.addEventListener("close", () => {
      if (!shuttingDown) fatalExit();
    });
  } // end `if (planWorker)`

  // Spawn the exit-watcher worker in the SAME post-migration window. It owns
  // a kqueue (macOS) / pidfd+epoll (Linux) fd via `bun:ffi`, polls
  // `data_version` to keep its watch set in sync with the candidate jobs
  // rows, and posts `{ kind: "exit", ... }` whenever a tracked pid exits or
  // the post-register kill-0 probe finds it already dead. Spawns AFTER seed
  // sweep + re-drain (above) so its initial candidate-set diff reads a
  // settled projection, not a half-folded one.
  // Gated on the selector — `null` when unselected.
  const exitWorker = want("exit")
    ? new Worker(new URL("./exit-watcher.ts", import.meta.url).href, {
        workerData: { dbPath, pollMs: 50 } satisfies ExitWatcherWorkerData,
      } as WorkerOptions & { workerData: unknown })
    : null;

  if (exitWorker) {
    const ew = exitWorker;
    // Main stays the SOLE writer: an `exit` message becomes a synthetic `Killed`
    // events row on the WRITABLE connection, then a wake pump folds it. Before
    // minting, re-read the persisted row and match `(pid, start_time)` against the
    // message snapshot — strict when both carry a start_time, loose pid-only when
    // either is NULL. A strict mismatch is a race-recovered stale event (the row
    // was re-opened with a fresh process); skip it. The reducer's Killed fold also
    // double-checks; this verifier just keeps the event log tight.
    ew.onmessage = (ev: MessageEvent<ExitMessage | undefined>): void => {
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
      // Pidless reap: a `pid: null` message reaps a NULL-pid (unwatchable) row.
      // Guarded both ways — the row's persisted pid must ALSO be NULL, or a resume
      // re-armed it with a real pid since the snapshot (the kernel watcher then
      // owns it).
      if (msg.pid == null) {
        if (row.pid != null) {
          // Re-armed with a real pid since the snapshot — let the watcher own it.
          return;
        }
      } else {
        // Strict-match when both sides carry a start_time; loose pid-only when
        // either is NULL. A strict mismatch is the race-recovered case.
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
      }
      stmts.insertEvent.run({
        $ts: Date.now() / 1000, // unix seconds as REAL
        $session_id: msg.jobId, // == job_id
        $pid: null,
        $hook_event: "Killed", // reducer folds → 'killed'
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
      // Our own INSERT bumps data_version — pump directly so the Killed fold
      // lands without a poll-cycle delay.
      wakePending = true;
      pumpWakes();
    };

    ew.onerror = (err: ErrorEvent): void => {
      console.error("[keeperd] exit-watcher worker error:", err.message ?? err);
      if (!shuttingDown) fatalExit();
    };

    // Same crash-via-`close` gap: an exit-watcher `process.exit(1)` fires
    // `close`, not `onerror`. `!shuttingDown` makes it inert on clean shutdown.
    ew.addEventListener("close", () => {
      if (!shuttingDown) fatalExit();
    });
  } // end `if (exitWorker)`

  // Spawn the git worker after the plan/job projections are caught up. It is
  // event-driven (file watcher + DB data_version wake + 60s heartbeat — see
  // `git-worker.ts` header) and posts a snapshot only when the rendered view
  // changes; main persists each one as a synthetic `GitSnapshot` event so the
  // reducer's `git_status` row is replayable.
  // Gated on the selector — `null` when unselected.
  const gitWorker = want("git")
    ? new Worker(new URL("./git-worker.ts", import.meta.url).href, {
        workerData: {
          dbPath,
          disableNativeWatcher: opts.disableNativeWatcher,
        } satisfies GitWorkerData,
      } as WorkerOptions & { workerData: unknown })
    : null;
  // Publish the git-worker ref so the plan-worker's discovery-nudge forward
  // (wired ABOVE) can post `add-discovery-root` to it. A nudge before this line
  // (or when the git worker is unselected) is a no-op via the existing `?.`.
  gitWorkerRef = gitWorker;

  if (gitWorker) {
    const gw = gitWorker;
    gw.onmessage = (ev: MessageEvent<GitWorkerMessage | undefined>): void => {
      const msg = ev.data;
      if (!msg) return;
      if (msg.kind === "backstop") {
        // Main is the SOLE sidecar writer — append the line. NOT an event fold
        // (a pure consumer-side side-file, never read by the reducer).
        handleBackstopMessage(msg);
        return;
      }
      if (msg.kind === "planctl-commit-changed") {
        // Authoritative commit-driven planctl ingest: the git-worker observed a
        // commit carrying changed `.planctl/**` paths; forward them to plan-worker
        // so it re-ingests each from the COMMITTED worktree bytes via its
        // idempotent `onChange`/`onDelete`. NOT written to the event log — this
        // channel drives a producer worker, not a projection. The `?.` is
        // null-safe for a git-only boot (no plan worker).
        planWorker?.postMessage({
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
      // A `git-snapshot` or `commit` is the cross-worker "HEAD may have moved"
      // signal a plan-worker cannot observe on its own (a `git commit` leaves the
      // `.planctl/*.json` bytes identical, so FSEvents won't re-fire). Fire
      // `recheck-pending` so the scanner re-runs its tracked-in-HEAD predicate.
      // Cheap (no-op when the set is empty); idempotent.
      if (msg.kind === "git-snapshot" || msg.kind === "commit") {
        planWorker?.postMessage({
          type: "recheck-pending",
          // Scope the drain to the single repo whose HEAD may have moved, so the
          // plan-worker re-probes only that repo's pending paths in ONE batched
          // git call instead of every repo's per-path.
          repo: msg.project_dir,
        } satisfies RecheckPendingMessage);
      }
      wakePending = true;
      pumpWakes();
    };

    gw.onerror = (err: ErrorEvent): void => {
      console.error("[keeperd] git worker error:", err.message ?? err);
      if (!shuttingDown) fatalExit();
    };

    gw.addEventListener("close", () => {
      if (!shuttingDown) fatalExit();
    });
  } // end `if (gitWorker)`

  // Spawn the usage worker in the SAME post-migration window. It watches the
  // agentuse daemon's flat leaf state dir (`~/.local/state/agentuse/`) and
  // posts `{kind: "usage-snapshot" | "usage-deleted", ...}` messages — the
  // fifth file-watcher producer-worker instance. Main turns each into a
  // synthetic `UsageSnapshot`/`UsageDeleted` events row on its writable
  // connection. The watch root is resolved on main via `resolveUsageRoot()`
  // and tolerates absence (agentuse may not have run yet).
  // Gated on the selector — `null` when unselected.
  const usageWorker = want("usage")
    ? new Worker(new URL("./usage-worker.ts", import.meta.url).href, {
        workerData: {
          dbPath,
          root: resolveUsageRoot(),
          disableNativeWatcher: opts.disableNativeWatcher,
        } satisfies UsageWorkerData,
      } as WorkerOptions & { workerData: unknown })
    : null;

  if (usageWorker) {
    const uw = usageWorker;
    // Main stays the SOLE writer: a `usage-snapshot`/`usage-deleted` message
    // becomes a synthetic events row on the WRITABLE connection, then a wake pump
    // folds it. The agentuse profile id rides in `session_id`; the flattened
    // snapshot in `data` (empty for tombstones). Everything else is NULL.
    uw.onmessage = (ev: MessageEvent<UsageMessage | undefined>): void => {
      const msg = ev.data;
      if (!msg) return;
      let hookEvent: string;
      let data: string;
      if (msg.kind === "usage-snapshot") {
        hookEvent = "UsageSnapshot";
        // Pre-flattened payload — the reducer never re-reads the on-disk file.
        // Forwarded via the exported `serializeUsageSnapshot` so the wire shape
        // is pinned by a direct test.
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
      // Tolerant mint: a transient writer-lock miss is logged-and-dropped
      // (recoverable via change-gated re-emit / boot sweep) instead of crashing
      // the daemon into the unpaused-boot dispatch window; real corruption still
      // throws on through to `fatalExit`. See {@link mintUsageEventTolerant}.
      const minted = mintUsageEventTolerant({
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
      // Nothing landed on a dropped mint — skip the wake so we don't spin a
      // no-op drain pass; the next re-emit / boot sweep carries the row.
      if (minted) {
        wakePending = true;
        pumpWakes();
      }
    };

    uw.onerror = (err: ErrorEvent): void => {
      console.error("[keeperd] usage worker error:", err.message ?? err);
      if (!shuttingDown) fatalExit();
    };

    uw.addEventListener("close", () => {
      if (!shuttingDown) fatalExit();
    });
  } // end `if (usageWorker)`

  // Spawn the builds worker — keeperd's FIRST outbound-HTTP producer (not a
  // file-watcher; NOT in WATCHER_WORKERS, so it never dlopens @parcel/watcher).
  // It polls the local buildbot master's REST API on a fixed cadence and posts
  // `{kind: "build-snapshot" | "build-deleted", ...}` messages — main turns each
  // into a synthetic `BuildSnapshot`/`BuildDeleted` events row on its writable
  // connection. Gated on the selector AND a configured `buildbot_url` (the spawn
  // mirrors the usage spawn, but the config key has no default — an unconfigured
  // buildbot leaves the worker un-spawned and the daemon boots normally).
  const buildbotUrl = resolveBuildbotUrl();
  const buildsWorker =
    want("builds") && buildbotUrl !== null
      ? new Worker(new URL("./builds-worker.ts", import.meta.url).href, {
          workerData: {
            dbPath,
            buildbotUrl,
          } satisfies BuildsWorkerData,
        } as WorkerOptions & { workerData: unknown })
      : null;

  if (buildsWorker) {
    const bw = buildsWorker;
    // Main stays the SOLE writer: a `build-snapshot`/`build-deleted` message
    // becomes a synthetic events row on the WRITABLE connection, then a wake
    // pump folds it. The builder NAME rides in `session_id`; the flattened
    // snapshot in `data` (empty for tombstones). Everything else is NULL.
    bw.onmessage = (ev: MessageEvent<BuildsMessage | undefined>): void => {
      const msg = ev.data;
      if (!msg) return;
      let hookEvent: string;
      let data: string;
      if (msg.kind === "build-snapshot") {
        hookEvent = "BuildSnapshot";
        // Pre-flattened payload — the reducer never re-reads the buildbot API.
        // Forwarded via the exported `serializeBuildSnapshot` so the wire shape
        // is pinned by the task-1 round-trip test.
        data = serializeBuildSnapshot(msg);
      } else if (msg.kind === "build-deleted") {
        // Tombstone: the reducer DELETEs the `builds` row whose pk is the
        // builder name. No payload beyond the pk in `session_id` — matches the
        // UsageDeleted / EpicDeleted shape so re-fold reproduces the deletion.
        hookEvent = "BuildDeleted";
        data = "";
      } else {
        return;
      }
      // Tolerant mint: a transient writer-lock miss is logged-and-dropped
      // (recoverable via change-gated re-emit on the next poll) instead of
      // crashing the daemon; real corruption still throws through to fatalExit.
      const minted = mintUsageEventTolerant({
        $ts: Date.now() / 1000,
        $session_id: msg.project, // the entity pk: builder name
        $pid: null,
        $hook_event: hookEvent,
        $event_type: "build_snapshot",
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
      if (minted) {
        wakePending = true;
        pumpWakes();
      }
    };

    bw.onerror = (err: ErrorEvent): void => {
      console.error("[keeperd] builds worker error:", err.message ?? err);
      if (!shuttingDown) fatalExit();
    };

    bw.addEventListener("close", () => {
      if (!shuttingDown) fatalExit();
    });
  } // end `if (buildsWorker)`

  // Watches the dead-letters dir and posts a contentless
  // `{kind:"dead-letter-changed"}`. The worker holds NO DB handle — main is the
  // sole writer; on each message main re-runs `scanDeadLetterDir` (the boot-scan
  // primitive), which INSERT OR IGNOREs into `dead_letters`. Spawns AFTER the
  // boot import so no live message races a half-imported state. Gated on the
  // selector — `null` when unselected.
  const deadLetterWorker = want("deadLetter")
    ? new Worker(new URL("./dead-letter-worker.ts", import.meta.url).href, {
        workerData: {
          dir: deadLetterDir,
          disableNativeWatcher: opts.disableNativeWatcher,
        } satisfies DeadLetterWorkerData,
      } as WorkerOptions & { workerData: unknown })
    : null;

  if (deadLetterWorker) {
    const dlw = deadLetterWorker;
    // Main owns the write: a `dead-letter-changed` message triggers a fresh
    // `scanDeadLetterDir` (the watcher event is "go look", never the data). The
    // scan is idempotent, so a watcher-event burst converges harmlessly. NO wake
    // is pumped — the write goes to `dead_letters`, NOT `events`, so there is no
    // projection to fold; the server worker's data_version poll picks it up.
    dlw.onmessage = (
      ev: MessageEvent<DeadLetterChangedMessage | undefined>,
    ): void => {
      const msg = ev.data;
      if (!msg || msg.kind !== "dead-letter-changed") {
        return;
      }
      try {
        scanDeadLetterDir(db, deadLetterDir);
      } catch (err) {
        // Defense-in-depth: an unexpected internal throw must NOT crash the
        // daemon. Log and continue — the next watcher event retries the import.
        console.error(
          `[keeperd] dead-letter live import threw (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    };

    // Same crash policy as the other workers: any thread failure → fatalExit.
    dlw.onerror = (err: ErrorEvent): void => {
      console.error("[keeperd] dead-letter worker error:", err.message ?? err);
      if (!shuttingDown) fatalExit();
    };

    // Same crash-via-`close` gap: a `process.exit(1)` fires `close`, not
    // `onerror`. `!shuttingDown` makes it inert on clean shutdown.
    dlw.addEventListener("close", () => {
      if (!shuttingDown) fatalExit();
    });
  } // end `if (deadLetterWorker)`

  // The lock-free events path's watch-hint thread, the twin of the dead-letter
  // worker. Watches the events-log dir and posts a contentless
  // `{kind:"events-log-changed"}`. The worker holds NO DB handle — main re-runs
  // `scanEventsLogDir` on each message, landing each new NDJSON line as an
  // `events` row (durable per-pid offset, exactly-once) then pumping a wake.
  // Spawns AFTER the boot ingest so the offset state is settled. In-process
  // fold/UDS tests inject events via DIRECT DB INSERT, not this path, so they do
  // NOT need this worker. Gated on the selector — `null` when unselected.
  const eventsIngestWorker = want("eventsIngest")
    ? new Worker(new URL("./events-ingest-worker.ts", import.meta.url).href, {
        workerData: {
          dir: eventsLogDir,
          disableNativeWatcher: opts.disableNativeWatcher,
        } satisfies EventsIngestWorkerData,
      } as WorkerOptions & { workerData: unknown })
    : null;

  if (eventsIngestWorker) {
    const eiw = eventsIngestWorker;
    // Main owns the `events` write: an `events-log-changed` message triggers a
    // fresh `scanEventsLogDir` (the watcher event is "go look", never the data).
    // Exactly-once (durable per-pid byte-offset), so a watcher-event burst
    // converges harmlessly. UNLIKE the dead-letter handler, a wake IS pumped —
    // the write goes to `events` (the fold source), so the reducer must fold it.
    eiw.onmessage = (
      ev: MessageEvent<EventsLogChangedMessage | undefined>,
    ): void => {
      const msg = ev.data;
      if (!msg || msg.kind !== "events-log-changed") {
        return;
      }
      try {
        scanEventsLogDir(db, eventsLogDir, eventsIngestCtx);
        wakePending = true;
        pumpWakes();
      } catch (err) {
        // Defense-in-depth: an unexpected internal throw must NOT crash the
        // daemon. Log and continue — the next watcher event retries the ingest.
        console.error(
          `[keeperd] events-log live ingest threw (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    };

    // Same crash policy as the other workers: any thread failure → fatalExit.
    eiw.onerror = (err: ErrorEvent): void => {
      console.error(
        "[keeperd] events-ingest worker error:",
        err.message ?? err,
      );
      if (!shuttingDown) fatalExit();
    };

    // Same crash-via-`close` gap: a `process.exit(1)` fires `close`, not
    // `onerror`. `!shuttingDown` makes it inert on clean shutdown.
    eiw.addEventListener("close", () => {
      if (!shuttingDown) fatalExit();
    });
  } // end `if (eventsIngestWorker)`

  // The autopilot reconciler worker runs the level-triggered dispatch loop
  // server-side: data_version wake → desired-vs-observed verdict → launch via the
  // ExecBackend → confirm → mint on ceiling (bridged through main). The pure
  // decision logic lives in `src/autopilot-worker.ts`; this spawn is the glue.
  // Boots PAUSED (safety default) from the `paused: true` workerData; the flag
  // flips ONLY via the `set_autopilot_paused` RPC → bridge → `{type:"set-paused"}`
  // relay. Config is read here on main and threaded into workerData so the worker
  // never opens config itself.
  const apConfig = resolveConfig();
  // Gated on the selector — `null` when unselected. The server-worker bridge's
  // `set_autopilot_paused` relay null-guards via `autopilotWorker === null`, so a
  // server-only boot's pause RPC degrades gracefully.
  const autopilotWorkerInstance = want("autopilot")
    ? new Worker(new URL("./autopilot-worker.ts", import.meta.url).href, {
        workerData: {
          dbPath,
          paused: autopilotPaused,
          zellijSession: apConfig.zellijSession,
          maxConcurrentJobs: apConfig.maxConcurrentJobs,
          // Completion-reap toggle, read on main and frozen into workerData.
          // Restart-to-apply: a config flip lags until the next restart.
          autocloseWindows: apConfig.autocloseWindows,
        } satisfies AutopilotWorkerData,
      } as WorkerOptions & { workerData: unknown })
    : null;
  // Wire the forward reference so the server-worker's bridge handler can target
  // the autopilot worker. Assign BEFORE the handlers fire so the first bridge
  // request never sees a `null` worker. (Stays `null` when unselected — the
  // bridge null-guard covers that.)
  autopilotWorker = autopilotWorkerInstance;

  // The `handleDispatch*` mint helpers + the sweep/compaction/checkpoint timers
  // below are interleaved with main's steady state, so rather than wrap the
  // region we gate only the three direct worker-binding sites
  // (`onmessage`/`onerror`/`close`) and `?.` the in-helper `postMessage`.
  if (autopilotWorkerInstance) {
    const aw = autopilotWorkerInstance;
    // Worker → main: `DispatchFailed` / `Dispatched` / `DispatchExpired` mint
    // requests. The worker posts a `{kind, payload}`; main runs
    // `stmts.insertEvent.run` then pumps a wake so the reducer folds it into
    // `dispatch_failures` / `pending_dispatches`. Workers never write the DB; the
    // producer-side `ts` rides in the payload so re-fold determinism holds. The
    // three paths differ only in `$hook_event`, `$event_type`, and `$cwd`.
    // NON-FATAL catch — a failed INSERT logs and the next cycle re-attempts.
    aw.onmessage = (
      ev: MessageEvent<
        | DispatchFailedMessage
        | DispatchedMessage
        | DispatchExpiredMessage
        | BackstopMessage
        | undefined
      >,
    ): void => {
      const msg = ev.data;
      if (!msg) return;
      if (msg.kind === "backstop") {
        // Main is the SOLE sidecar writer — append the line. NOT an event fold
        // (a pure consumer-side side-file, never read by the reducer).
        handleBackstopMessage(msg);
        return;
      }
      if (msg.kind === "dispatch-failed") {
        handleDispatchFailedMint(msg.payload);
      } else if (msg.kind === "dispatched-request") {
        // Durable mint-before-launch: insert the `Dispatched` event, then reply
        // `dispatched-ack{id, ok}` so the worker only `launch()`es AFTER the row
        // is durable (closes the double-dispatch window).
        handleDispatchedMint(msg);
      } else if (msg.kind === "dispatch-expired") {
        handleDispatchExpiredMint(msg.payload);
      }
    };
  } // end `if (autopilotWorkerInstance)` onmessage guard

  /**
   * Mint a synthetic `DispatchFailed` event. The dispatch key (`${verb}::${id}`)
   * rides as the entity-key overload on `session_id` so a re-fold correlates it
   * to its `dispatch_failures` row without re-parsing `data`. NON-FATAL on insert
   * failure — the next reconcile wake re-attempts.
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
      // Defense-in-depth: an insert failure must NOT crash the daemon. Log +
      // continue — the next reconcile wake re-attempts (a missed insert is just
      // an extra retry round-trip, not a correctness hazard).
      console.error(
        `[keeperd] DispatchFailed mint threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Mint a synthetic `Dispatched` event AND reply a durable `dispatched-ack{id,
   * ok}`. The reducer's fold UPSERTs a `pending_dispatches` row keyed `(verb,
   * id)` carrying the producer-side `dispatched_at` — outbox-ordered intent so a
   * crash between mint and `launch()` leaves a phantom row the TTL sweep clears.
   *
   * DURABLE before launch: the worker AWAITS this ack BEFORE `launch()`, so the
   * reply MUST fire on every path (`ok:true` once the insert lands, `ok:false`
   * when it throws). The worker launches only on `ok:true`; an `ok:false` or
   * ack-timeout aborts WITHOUT launching — strictly preferable to the
   * fire-and-forget race that re-opened the double-dispatch window. NON-FATAL on
   * insert failure.
   */
  function handleDispatchedMint(msg: DispatchedMessage): void {
    const { id, payload } = msg;
    const data = JSON.stringify(payload);
    let ok = false;
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
      // The ack promises INSERT durability ONLY — not the fold (idempotent on the
      // next drain). The committed INSERT is the whole contract.
      ok = true;
    } catch (err) {
      console.error(
        `[keeperd] Dispatched mint threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    // Reply on EVERY path — the worker is blocked awaiting this ack before it
    // launches; a `false` reply tells it to abort. Reply IMMEDIATELY after the
    // INSERT, BEFORE the (potentially slow) reducer pump: the launch must not
    // wait on the drain, and the ack already reflects everything it promises.
    // Outbox ordering is UNCHANGED — the insert still precedes the launch. The
    // `?.` keeps it null-safe for the type system on an unselected-autopilot boot.
    autopilotWorkerInstance?.postMessage({
      type: "dispatched-ack",
      id,
      ok,
    } satisfies DispatchedAckMessage);
    // Pump the reducer AFTER the ack, in its own guarded block — a pump throw is
    // logged but can neither flip the sent ack nor escape this handler. Only pump
    // when the insert landed.
    if (ok) {
      try {
        wakePending = true;
        pumpWakes();
      } catch (err) {
        console.error(
          `[keeperd] Dispatched pump threw (non-fatal, ack already sent): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /**
   * Mint a synthetic `DispatchExpired` event. The reducer's fold DELETEs the
   * matching `pending_dispatches` row keyed `(verb, id)` — idempotent. NON-FATAL
   * on insert failure: the row stays put until the next heartbeat sweep mints
   * again (the TTL is keyed off the FROZEN `dispatched_at`, so a restart never
   * resets the clock).
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

  // Producer-side TTL sweep for `pending_dispatches`. Mints a `DispatchExpired`
  // for every row aged past `PENDING_DISPATCH_TTL_MS` without an open
  // `dispatch_failures` row for the same `(verb, id)` (the LEFT JOIN guard).
  // MUST ride the heartbeat timer, not the level-triggered `data_version` wake: a
  // crashed dispatch can be the only pending row on a quiescent board, where a
  // write-triggered wake never fires. All wallclock lives HERE in the producer,
  // never inside a fold; the fold reads only `event.ts` + the FROZEN payload. The
  // sweep reads on main's writable connection so the read is sequenced inside the
  // same writer that mints — no read/mint race against the reducer's UPSERT.
  function sweepExpiredPendingDispatches(): void {
    if (shuttingDown) return;
    let aged: { verb: string; id: string; dispatched_at: number }[];
    try {
      aged = selectExpiredPendingDispatches(db, Date.now());
    } catch (err) {
      // A read failure here is unexpected. Log non-fatally; the next heartbeat
      // retries.
      console.error(
        `[keeperd] pending_dispatches TTL sweep read threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    if (aged.length === 0) {
      // Nothing to expire — the `rescued:false` denominator. Bump the counter
      // only (no line); the rollup carries it.
      mainBackstopCounters.bump("pending-dispatch-sweep", "timeout", false);
      return;
    }
    // Each expired row is a `rescued:true` timeout rescue. Build the records ONCE
    // off a single `Date.now()` so every row shares the sweep's wall-clock. Main
    // is the SOLE sidecar writer, so the lines are written directly.
    const sweepRecords = buildPendingDispatchSweepRecords(aged, Date.now());
    for (const row of aged) {
      // Per-row failures are logged and swallowed inside the helper, so a throw
      // doesn't abort the sweep — every aged row gets its own shot.
      handleDispatchExpiredMint({ verb: row.verb as Verb, id: row.id });
      mainBackstopCounters.bump("pending-dispatch-sweep", "timeout", true);
    }
    for (const rec of sweepRecords) {
      appendBackstopRecord(rec, backstopLogPath);
    }
    // `handleDispatchExpiredMint` already pumps wakes on each mint;
    // the trailing flag is defense-in-depth in case the helper ever
    // stops pumping (e.g. on insert throw — every row's mint is
    // independent).
    wakePending = true;
    pumpWakes();
  }

  // Schedule the producer-side TTL sweep on the heartbeat. Stored so shutdown can
  // `clearInterval` it (an outstanding timer pins a ref on the main loop). Fires
  // ON THE MAIN THREAD against the writable connection.
  const pendingDispatchSweepTimer = setInterval(() => {
    sweepExpiredPendingDispatches();
  }, PENDING_DISPATCH_SWEEP_INTERVAL_MS);

  // Poll-is-truth fallback for the events-log live ingest. The watcher hint is
  // the fast path, but a dropped/coalesced event (or a worker that never
  // subscribed) would otherwise leave hook events undrained until the next boot
  // scan. This periodic scan guarantees every NDJSON line lands within one
  // interval. Runs ON THE MAIN THREAD against the writer conn, is idempotent
  // (durable per-pid byte-offset), and never-throws. Stored so shutdown can clear.
  const eventsIngestFallbackTimer = setInterval(() => {
    if (shuttingDown) return;
    try {
      scanEventsLogDir(db, eventsLogDir, eventsIngestCtx);
      wakePending = true;
      pumpWakes();
    } catch (err) {
      console.error(
        `[keeperd] events-log fallback scan threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }, EVENTS_INGEST_FALLBACK_INTERVAL_MS);

  // Producer-side cold-blob compaction pass. Relocates the cold tail of inline
  // `events.data` blobs into the `event_blobs` side table and NULLs the hot
  // column, paced so the writer lock never starves a concurrent hook INSERT. Runs
  // ON THE MAIN THREAD against the writable connection. `event_blobs` is a
  // content-preserving sidecar, NOT a reducer projection: the relocated value is
  // read back via `COALESCE(events.data, event_blobs.data)`, so a from-scratch
  // re-fold stays byte-identical. The cold predicate (`src/compaction.ts`) never
  // relocates a blob the file-attribution scan could still need.
  function runCompactionPass(): void {
    if (shuttingDown) return;
    let relocated = 0;
    try {
      const result = compactColdBlobs(db);
      relocated = result.relocated;
      if (relocated > 0) {
        console.error(
          `[keeperd] compaction: relocated ${relocated} cold blob(s) in ${result.batches} batch(es) (watermark id<=${result.coldWatermark}${result.moreLikely ? ", more remain" : ""})`,
        );
      }
      // Absent-in-both-places is a genuine data-loss BUG — the relocation path
      // cannot create it, so a positive count means a bug elsewhere. Logged
      // loudly but NOT fatal. Gate the full-table scan on `relocated > 0`: a pass
      // that moved zero blobs can't have created an absent-in-both row, so the
      // scan is wasted work on an idle heartbeat.
      if (relocated > 0) {
        const absent = countAbsentBlobs(db);
        if (absent > 0) {
          console.error(
            `[keeperd] compaction BUG: ${absent} event(s) have a blob in NEITHER events.data NOR event_blobs — data loss, NOT legitimate compaction`,
          );
        }
      }
    } catch (err) {
      // A compaction failure is pure space-reclamation loss, never a correctness
      // issue (the blob stays inline on a rolled-back batch). Log non-fatally.
      console.error(
        `[keeperd] compaction pass threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    // Reclaim WAL space OUTSIDE the per-batch transactions and only when a pass
    // moved bytes. PASSIVE never waits on writers (TRUNCATE would, starving a
    // contending hook); it checkpoints what it can without blocking. Main-DB page
    // reclamation (VACUUM) is left to a separate offline step.
    if (relocated > 0) {
      try {
        db.run("PRAGMA wal_checkpoint(PASSIVE)");
      } catch (err) {
        console.error(
          `[keeperd] compaction PASSIVE checkpoint threw (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  // Schedule the compaction pass on its own slack heartbeat. Stored so shutdown
  // can `clearInterval` it. Fires on the MAIN THREAD against the writable conn.
  const compactionTimer = setInterval(() => {
    runCompactionPass();
  }, COMPACTION_INTERVAL_MS);

  // Steady-state WAL checkpoint cadence, independent of compaction (whose PASSIVE
  // checkpoint only fires when it relocated bytes). Flushes the WAL back into the
  // main DB on cadence so serve/poll read latency stays bounded under a steady
  // fold stream. PASSIVE never waits on a writer — a no-op if a hook holds the
  // lock. Fires on the MAIN THREAD; stored so shutdown can clear it.
  const walCheckpointTimer = setInterval(() => {
    try {
      db.run("PRAGMA wal_checkpoint(PASSIVE)");
    } catch (err) {
      // A checkpoint failure is pure space/latency reclamation loss, never a
      // correctness issue (the page-threshold auto-checkpoint is the backstop).
      console.error(
        `[keeperd] steady-state PASSIVE checkpoint threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }, WAL_CHECKPOINT_INTERVAL_MS);

  // The heavy SQLite maintenance schedules (integrity probe, verified backup,
  // boot catch-up) run on the dedicated `maintenance-worker`, NOT main's fold
  // thread — they are SYNCHRONOUS bun:sqlite ops that would stall main's event
  // loop for their full duration. The worker calls the same `backupDb` /
  // `runIntegrityProbe` bodies against its own short-lived read-only connections;
  // side effects stay on main, driven by relayed outcomes. Compaction + the
  // WAL-checkpoint timers above STAY on main (sole-writer rule).

  // Shared botctl/Telegram page sink for relayed maintenance pages. Best-effort:
  // `livePage` swallows a notifier failure so a relayed page can never crash main.
  const maintenancePage = livePage();
  const backupFailurePage = liveBackupPage();

  // Run the success-log / failure-log+page branch from a relayed `BackupResult`.
  // The `backupDb` call runs worker-side; this is the formatting + logging +
  // paging only.
  function handleBackupResult(result: BackupResult): void {
    if (result.verified && result.snapshotPath !== null) {
      const mb = (result.bytes / (1024 * 1024)).toFixed(1);
      console.error(
        `[keeperd] backup: verified snapshot (${mb} MB) ${result.snapshotPath}${
          result.pruned.length > 0
            ? ` (pruned ${result.pruned.length} old)`
            : ""
        }`,
      );
    } else {
      const detail = result.error ?? "unknown error";
      console.error(`[keeperd] backup FAILED: ${detail}`);
      try {
        backupFailurePage(
          `🔴 keeperd backup FAILED — no fresh verified snapshot, recovery is degraded.\n${detail}`,
        );
      } catch {
        // Page is best-effort; a notifier failure must not crash main.
      }
    }
  }

  // Crash-handler guard — wired only when the worker was selected.
  if (autopilotWorkerInstance) {
    const aw = autopilotWorkerInstance;
    aw.onerror = (err: ErrorEvent): void => {
      console.error("[keeperd] autopilot worker error:", err.message ?? err);
      if (!shuttingDown) fatalExit();
    };

    // Same crash-via-`close` gap: a `process.exit(1)` fires `close`, not
    // `onerror`. `!shuttingDown` makes it inert on the clean shutdown path.
    aw.addEventListener("close", () => {
      if (!shuttingDown) fatalExit();
    });
  }

  // The restore-snapshot worker — a pure CONSUMER: its own read-only connection,
  // polls `data_version`, and rewrites `~/.local/state/keeper/restore.json` (a
  // derived side-file, NOT a projection) only when the content hash differs. It
  // carries no `onmessage` handler — never posts to main, never writes the DB.
  // Write failures are swallowed to stderr; only an unhandled throw escalates to
  // fatalExit.
  //
  // The maintenance worker hosts the heavy SQLite schedules (verified backup,
  // integrity probe, boot catch-up) OFF main's fold thread — synchronous
  // bun:sqlite ops would otherwise stall main's event loop. It calls the same
  // `backupDb` / `runIntegrityProbe` bodies against its own short-lived RO
  // connections and RELAYS outcomes up; main keeps the logging + paging side
  // effects. Gated on the selector — `null` when unselected.
  const maintenanceWorker = want("maintenance")
    ? new Worker(new URL("./maintenance-worker.ts", import.meta.url).href, {
        workerData: { dbPath } satisfies MaintenanceWorkerData,
      } as WorkerOptions & { workerData: unknown })
    : null;

  if (maintenanceWorker) {
    const mw = maintenanceWorker;
    // Worker → main: relayed maintenance outcomes. A backup-result drives main's
    // existing success-log / failure-log+page branch; a maintenance-log line is
    // `console.error`d (the probe's log sink); a maintenance-page is routed to
    // the botctl/Telegram page sink (the probe's page sink). Every handler is
    // non-throwing — a relay never crashes main.
    mw.onmessage = (
      ev: MessageEvent<
        | BackupResultMessage
        | MaintenanceLogMessage
        | MaintenancePageMessage
        | undefined
      >,
    ): void => {
      const msg = ev.data;
      if (!msg) return;
      if (msg.kind === "backup-result") {
        handleBackupResult(msg.result);
      } else if (msg.kind === "maintenance-log") {
        console.error(msg.message);
      } else if (msg.kind === "maintenance-page") {
        try {
          maintenancePage(msg.message);
        } catch {
          // Page is best-effort; a notifier failure must not crash main.
        }
      }
    };

    mw.onerror = (err: ErrorEvent): void => {
      console.error("[keeperd] maintenance worker error:", err.message ?? err);
      if (!shuttingDown) fatalExit();
    };

    // A worker `process.exit(1)` fires `close`, not `onerror`. `!shuttingDown`
    // makes it inert on clean shutdown.
    mw.addEventListener("close", () => {
      if (!shuttingDown) fatalExit();
    });
  }

  // Gated on the selector — `null` when unselected.
  const restoreWorker = want("restore")
    ? new Worker(new URL("./restore-worker.ts", import.meta.url).href, {
        workerData: { dbPath } satisfies RestoreWorkerData,
      } as WorkerOptions & { workerData: unknown })
    : null;

  if (restoreWorker) {
    const rw = restoreWorker;
    rw.onerror = (err: ErrorEvent): void => {
      console.error("[keeperd] restore worker error:", err.message ?? err);
      if (!shuttingDown) fatalExit();
    };

    rw.addEventListener("close", () => {
      if (!shuttingDown) fatalExit();
    });
  }

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
  // recovery path. The `!shuttingDown` guard keeps teardown-race noise (a relay
  // `postMessage` to a just-terminated worker, a worker `db.close()` racing its
  // poll) from clobbering the clean `exit(0)` — both fire AFTER `shuttingDown` is
  // set. Mirrors every worker `onerror` / `close` handler above.
  process.on("unhandledRejection", (reason) => {
    if (shuttingDown) return;
    console.error("[keeperd] unhandled rejection:", reason);
    fatalExit();
  });
  process.on("uncaughtException", (err) => {
    if (shuttingDown) return;
    console.error("[keeperd] uncaught exception:", err);
    fatalExit();
  });

  // Step 5 — clean teardown. TEARDOWN LOGIC ONLY: set the shutdown flag FIRST (so
  // the `!shuttingDown` guards keep teardown noise from tripping `fatalExit`),
  // post `{type:"shutdown"}` to every worker, race their `close` against the
  // deadline, terminate, and close the db — WITHOUT `process.exit`. The exit-0
  // contract lives in the {@link shutdown} wrapper below (the ONLY path that
  // exits 0). Idempotent.
  async function stop(): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    // Flush main-produced backstop counters as on-shutdown rollup records so the
    // rescue-RATE denominator survives a clean stop. Best-effort. Worker-side
    // counters are flushed by the workers' own shutdown handlers.
    for (const rollup of mainBackstopCounters.snapshot(Date.now())) {
      appendBackstopRecord(rollup, backstopLogPath);
    }

    // Clear every main-thread heartbeat so none can fire a write into the writer
    // connection mid-teardown. (`clearInterval` is a no-op if already fired.) The
    // integrity-probe + backup + catch-up timers live on the maintenance worker,
    // which clears its own when main posts `{type:"shutdown"}` below.
    clearInterval(pendingDispatchSweepTimer);
    clearInterval(eventsIngestFallbackTimer);
    clearInterval(compactionTimer);
    clearInterval(walCheckpointTimer);

    // The workers actually spawned this boot (filter out the `null`s). Teardown
    // iterates THIS list, so a minimal-set boot signals only what it spawned.
    const spawnedWorkers: Worker[] = [
      worker,
      serverWorker,
      transcriptWorker,
      planWorker,
      exitWorker,
      gitWorker,
      usageWorker,
      buildsWorker,
      deadLetterWorker,
      eventsIngestWorker,
      autopilotWorkerInstance,
      maintenanceWorker,
      restoreWorker,
    ].filter((w): w is Worker => w !== null);

    // Wrap each shutdown post per-worker: an already-exited worker makes
    // `postMessage` throw `InvalidStateError`, and an unguarded throw would reject
    // `stop()` and hang teardown until launchd's SIGKILL. Swallow per-worker and
    // keep posting to the rest — a dead worker needs no signal.
    for (const w of spawnedWorkers) {
      try {
        w.postMessage({ type: "shutdown" } satisfies ShutdownMessage);
      } catch {
        // Worker already gone; nothing to signal. Keep posting to the rest.
      }
    }

    // Bun surfaces worker exit via the "close" event. Await every spawned
    // worker's close — each releases its own external resource (socket + lock,
    // watcher subscriptions, kernel fd) in its shutdown handler, or those leak
    // into the next boot — raced against a single deadline so a wedged worker
    // can't block our clean shutdown forever.
    const exited = (w: Worker): Promise<void> =>
      new Promise<void>((resolve) => {
        w.addEventListener("close", () => resolve());
      });
    const exitWaits: Promise<void>[] = spawnedWorkers.map((w) => exited(w));
    await Promise.race([
      Promise.all(exitWaits),
      Bun.sleep(WORKER_SHUTDOWN_DEADLINE_MS),
    ]);

    for (const w of spawnedWorkers) {
      try {
        w.terminate();
      } catch {
        // best-effort if it already exited
      }
    }

    try {
      db.close();
    } catch {
      // best-effort
    }
    // NO `process.exit` here — the exit-0 contract lives in {@link shutdown}
    // (installed only by `runDaemon`). An in-process harness caller gets a
    // resolved promise and keeps running.
  }

  // Boot complete. Return the programmatic handle; `runDaemon` installs the
  // SIGTERM/SIGINT → exit-0 handlers around this.
  return { stop, sockPath };
}

/**
 * Production daemon entry point. Boots via {@link startDaemon} (no opts) and
 * installs the SIGTERM/SIGINT → clean-exit-0 handlers. The ONLY path that calls
 * `process.exit(0)`: under launchd `KeepAlive.SuccessfulExit=false` a clean exit
 * tells launchd NOT to restart, while a crash takes `fatalExit` → exit 1 →
 * restart.
 */
function runDaemon(): void {
  const { stop } = startDaemon();
  // The ONLY path that exits 0. `stop()` runs the full teardown (idempotent); we
  // exit 0 once it resolves so launchd does NOT restart a clean stop.
  const shutdown = (): void => {
    void stop().then(() => {
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Only boot the daemon when this file is the process entry point — a plain
// `import` (e.g. a test driving `drainToCompletion`) must NOT spawn workers or
// install signal handlers.
if (import.meta.main) {
  runDaemon();
}

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
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve as resolvePath, sep } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { projectAutopilotPaused } from "../cli/autopilot";
import { HANDOFF_DOC_MAX_BYTES } from "../cli/handoff";
import {
  type AdoptableCodexRollout,
  findAdoptableCodexRollouts,
  resolveCodexResumeTarget,
} from "./agent/codex-session-index";
import type {
  AutocloseIntentMessage,
  AutocloseWorkerData,
} from "./autoclose-worker";
import type {
  AutopilotWorkerData,
  DispatchClearedMessage,
  DispatchExpiredMessage,
  DispatchedAckMessage,
  DispatchedMessage,
  DispatchFailedMessage,
  LaneMergedMessage,
  ResolverOutcome,
  SharedWedgeDistressMessage,
  Verb,
  WorktreeRepoStatusMessage,
} from "./autopilot-worker";
import {
  classifyResolverOutcome,
  WORKER_EFFORT,
  WORKER_MODEL,
} from "./autopilot-worker";
import {
  backfillMutationPath,
  isMutationPathBackfillComplete,
} from "./backfill-mutation-path";
import {
  appendBackstopRecord,
  BackstopCounters,
  type BackstopMessage,
  type BackstopRecord,
  buildTimeoutRecord,
} from "./backstop-telemetry";
import { type BackupResult, liveBackupPage } from "./backup";
import type { BaselineWorkerData } from "./baseline-worker";
import type {
  BirthIngestWorkerData,
  BirthRecordsChangedMessage,
} from "./birth-ingest-worker";
import {
  type BirthRecord,
  parseBirthRecord,
  resolveBirthDir,
} from "./birth-record";
import type { BuildsMessage, BuildsWorkerData } from "./builds-worker";
import type { BusWorkerData } from "./bus-worker";
import {
  type CodexStopSignal,
  collectCodexStopSignals,
  type LiveCodexJob,
  type RolloutCursor,
} from "./codex-state-worker";
import {
  countAbsentBlobs,
  DEFAULT_RETENTION_BATCH_SIZE,
  DEFAULT_RETENTION_MAX_BATCHES,
  deleteColdTmuxFocusRows,
  deleteNoopSnapshotRows,
  reclaimableFreelistBytes,
  reclaimableLogStep,
  retainColdPayloads,
} from "./compaction";
import {
  atomicWriteFile,
  clearDispatchMintGate,
  evictStaleDispatchMintGate,
  openDb,
  readGitProjectionSeedRequired,
  resolveBackstopLogPath,
  resolveBuildbotUrl,
  resolveBusSockPath,
  resolveClaudeProjectsRoot,
  resolveConfig,
  resolveDbPath,
  resolveDeadLetterDir,
  resolveEventsLogDir,
  resolveHandoffSpillDir,
  resolveKeeperAgentPath,
  resolvePlanRoots,
  resolveRestartLedgerPath,
  resolveSockPath,
  resolveStatuslineRoot,
  resolveUsageRoot,
  runDispatchMintGate,
  truncateEphemeralProjections,
} from "./db";
import { parseDeadLetterLine, parseEventLogLine } from "./dead-letter";
import type {
  DeadLetterChangedMessage,
  DeadLetterWorkerData,
} from "./dead-letter-worker";
import { extractMutationPath, parsePlanRef } from "./derivers";
import {
  defaultPlanPrompt,
  type EscalationVerb,
  isRetryableDispatchKey,
} from "./dispatch-command";
import {
  CRASH_LOOP_DISTRESS_ID,
  CRASH_LOOP_DISTRESS_REASON,
  CRASH_LOOP_DISTRESS_VERB,
  isLaneWedgeDistressKey,
  isMergeEscalationReason,
  isSharedDesyncDistressKey,
  isStaleBaseDistressKey,
  MERGE_ESCALATION_REASON_TOKEN,
  SHARED_WEDGE_DISTRESS_VERB,
  STUCK_SENTINEL_DISTRESS_ID_PREFIX,
  STUCK_SENTINEL_DISTRESS_VERB,
} from "./dispatch-failure-key";
import { resolveEscalationLaunchConfig } from "./escalation-config";
import type {
  EventsIngestWorkerData,
  EventsLogChangedMessage,
} from "./events-ingest-worker";
import {
  classifyCloseKind,
  type KillReason,
  keeperAgentLaunch,
  type LaunchSpec,
  MANAGED_EXEC_SESSION,
} from "./exec-backend";
import type {
  ExitWatcherOutbound,
  ExitWatcherWorkerData,
  StuckSentinelMessage,
} from "./exit-watcher";
import { REPROBE_MIN_AGE_SECS, REPROBE_MS } from "./exit-watcher";
import { fingerprintFailure } from "./failure-fingerprint";
import { seedGitProjection } from "./git-boot-seed";
import type {
  AddDiscoveryRootMessage,
  GitWorkerData,
  GitWorkerMessage,
} from "./git-worker";
import { handoffSlugExists } from "./handoff-slug";
import type {
  HandoffDispatchingAckMessage,
  HandoffDispatchingMessage,
  HandoffLaunchFailedMessage,
  HandoffOutboundMessage,
  HandoffWorkerData,
} from "./handoff-worker";
import { KEEPER_TOPIC, livePage } from "./integrity-probe";
import { buildLauncherArgvPrefix } from "./keeper-agent-path";
import type {
  BackupResultMessage,
  MaintenanceLogMessage,
  MaintenancePageMessage,
  MaintenanceWorkerData,
} from "./maintenance-worker";
import type {
  PlanCommitChangedMessage,
  PlanWorkerData,
  PlanWorkerOutbound,
  RecheckPendingMessage,
} from "./plan-worker";
import { isStoppedJobLive } from "./reconcile-core";
import {
  DEFAULT_BATCH_SIZE,
  type DrainOptions,
  drain,
  serializeBuildSnapshot,
} from "./reducer";
import type { RenamerWorkerData } from "./renamer-worker";
import type {
  BackendExecStartMessage,
  RestoreWorkerData,
} from "./restore-worker";
import { nodeResumeResolveFs } from "./resume-resolve";
import { perRootStoredWhileOffNote } from "./rpc-handlers";
import { seedKilledSweep } from "./seed-sweep";
import type {
  BootCompleteMessage,
  KickMessage,
  ReplayRequestMessage,
  ReplayResultMessage,
  RequestHandoffRequestMessage,
  RequestHandoffResultMessage,
  RetryDispatchRequestMessage,
  RetryDispatchResultMessage,
  ServerWorkerData,
  SetAutopilotConfigRequestMessage,
  SetAutopilotConfigResultMessage,
  SetAutopilotModeRequestMessage,
  SetAutopilotModeResultMessage,
  SetAutopilotPausedRequestMessage,
  SetAutopilotPausedResultMessage,
  SetEpicArmedRequestMessage,
  SetEpicArmedResultMessage,
} from "./server-worker";
import type { StatuslineWorkerData } from "./statusline-worker";
import { type PiRepairJob, proposePiRepair } from "./tabs-core";
import { seedTmuxProjection } from "./tmux-boot-seed";
import type {
  TmuxClientFocusSnapshotMessage,
  TmuxControlLivenessMessage,
  TmuxControlWorkerData,
  TmuxControlWorkerMessage,
  TmuxTopologySnapshotMessage,
} from "./tmux-control-worker";
import type {
  ApiErrorMessage,
  InputRequestMessage,
  SubagentTurnMessage,
  TranscriptTitleMessage,
  TranscriptWorkerData,
} from "./transcript-worker";
import type { Job, SessionTelemetryMessage } from "./types";
import type { UsageScraperWorkerData } from "./usage-scraper-worker";
import type {
  UsageMessage,
  UsageSnapshotMessage,
  UsageWorkerData,
} from "./usage-worker";
import type {
  ShutdownMessage,
  WakeWorkerData,
  WakeWorkerOutbound,
} from "./wake-worker";
import { repoToken, worktreePathFor } from "./worktree-plan";

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
  // In-drain WAL checkpoint accounting (boot only — at steady state the drain is
  // a few events and the gates never trip). The boot drain runs with
  // `wal_autocheckpoint=0`, so without this the WAL grows for the whole re-fold.
  // The PASSIVE rides BETWEEN batches, i.e. between per-event `BEGIN IMMEDIATE`
  // transactions — never inside a fold — so it cannot contend its own write lock
  // and the drain's cursor+projection co-advance is untouched. `walPath` is
  // null-safe for `:memory:` / unnamed DBs (the size gate then degrades to the
  // event-count gate alone).
  const walPath =
    db.filename && db.filename !== ":memory:" ? `${db.filename}-wal` : null;
  // Gate thresholds default to the production constants; a test overrides them
  // (smaller) to exercise the periodic-PASSIVE-caps-WAL contract cheaply.
  const checkpointEventInterval =
    options.checkpointEventInterval ?? BOOT_DRAIN_CHECKPOINT_EVENT_INTERVAL;
  const checkpointWalBytes =
    options.checkpointWalBytes ?? BOOT_DRAIN_CHECKPOINT_WAL_BYTES;
  let eventsSinceCheckpoint = 0;
  const maybeCheckpoint = (): void => {
    const sizeTripped =
      walPath !== null &&
      (() => {
        try {
          return statSync(walPath).size >= checkpointWalBytes;
        } catch {
          // `-wal` absent (nothing written yet) or unreadable: no size pressure.
          return false;
        }
      })();
    if (eventsSinceCheckpoint < checkpointEventInterval && !sizeTripped) {
      return;
    }
    eventsSinceCheckpoint = 0;
    try {
      // PASSIVE returns immediately if a writer holds the lock and only flushes
      // already-committed frames; it never blocks the drain. Mirror the
      // steady-state heartbeat call-site: read the result, log it, swallow errors
      // (a checkpoint miss is pure space reclamation loss, never correctness).
      const result = db.query("PRAGMA wal_checkpoint(PASSIVE)").get() as {
        busy: number;
        log: number;
        checkpointed: number;
      } | null;
      if (result) {
        console.error(
          `[keeperd] boot-drain PASSIVE checkpoint: busy=${result.busy} log=${result.log} checkpointed=${result.checkpointed}`,
        );
      }
    } catch (err) {
      console.error(
        `[keeperd] boot-drain PASSIVE checkpoint threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };
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
    eventsSinceCheckpoint += folded;
    maybeCheckpoint();
  }
}

/**
 * One-shot GC for orphaned `dispatch_failures` rows. A row whose composite
 * `${verb}::${id}` the `retry_dispatch` wire validator would reject is UN-retryable
 * — a producer minted a key the operator surface can never clear (e.g. a pre-slug
 * `worktree-recover:<abs-path>`), so it strands forever. This mints the sanctioned
 * `DispatchCleared` for each via `mintClear` (the caller folds + pumps). Returns the
 * count swept (0 on a healthy board). Pure but for the SELECT + the injected mint.
 *
 * EXEMPTS the crash-loop distress key AND every per-lane fan-in wedge ({@link
 * isLaneWedgeDistressKey}) / per-(epic,repo) stale-base-lane ({@link
 * isStaleBaseDistressKey}) / per-repo shared-checkout-desync ({@link
 * isSharedDesyncDistressKey}) distress key, AND the per-repo shared-base repair latch
 * (`repair::<repo-token>`): each is un-retryable by the wire validator BY DESIGN (an
 * operator never clears them through the retry wire), and a level-trigger (main's boot
 * recovery / the recover pass observing the lane clean / the stale-base probe observing
 * the lane re-based or torn down / the desync content probe observing the checkout carry
 * the default tip / the repair sweep observing the base green) owns dropping them — so
 * the orphan sweep must never reap a self-managed row out from under its signal.
 *
 * The per-repo shared-checkout-wedge/-dirty distress family is DELIBERATELY NOT exempt:
 * a dirty or mid-merge shared checkout no longer blocks the working-tree-free base
 * merge, so that signal is a neutered false positive with no live producer — the sweep
 * DRAINS any such row still open so an operator is not left with an un-clearable
 * daemon-verb row.
 */
export function gcUnretryableDispatchFailures(
  db: Database,
  mintClear: (verb: string, id: string) => void,
): number {
  const rows = db.query("SELECT verb, id FROM dispatch_failures").all() as {
    verb: string;
    id: string;
  }[];
  let swept = 0;
  for (const row of rows) {
    if (isRetryableDispatchKey(row.verb, row.id)) {
      continue;
    }
    if (
      row.verb === CRASH_LOOP_DISTRESS_VERB &&
      row.id === CRASH_LOOP_DISTRESS_ID
    ) {
      continue;
    }
    // The per-LANE fan-in wedge distress row — same synthetic `daemon`-verb /
    // recover-pass level-clear discipline on its own `worktree-lane-wedge:` id prefix;
    // the operator surface never clears it, so the orphan sweep must not reap it.
    if (isLaneWedgeDistressKey(row.verb, row.id)) {
      continue;
    }
    // And the per-(epic,repo) stale-base-lane distress row — same synthetic `daemon`-
    // verb / probe level-clear discipline on its own `stale-base-lane:` id prefix; the
    // operator surface never clears it, so the orphan sweep must not reap it.
    if (isStaleBaseDistressKey(row.verb, row.id)) {
      continue;
    }
    // And the per-repo shared-checkout-DESYNC distress row — a LIVE producer (UNLIKE the
    // neutered wedge/dirty family drained above): its own `shared-checkout-desync:` id
    // prefix rides the synthetic `daemon` verb, and the per-cycle content probe's
    // level-trigger owns dropping it, so the orphan sweep must not reap it out from under
    // its signal.
    if (isSharedDesyncDistressKey(row.verb, row.id)) {
      continue;
    }
    // And the per-repo shared-base repair latch (`repair::<repo-token>`) — a LIVE
    // producer owns it (the SHARED_BASE_BROKEN sweep re-mints it while the base is broken
    // and CLEARS it on positive evidence — base green + zero remaining candidates). Its
    // `repair` verb is un-retryable by the wire validator BY DESIGN (the retry-wire stays
    // narrow, per `parseDispatchKey`), so the orphan sweep must not reap it — reaping
    // would drop its once-page / once-dispatch markers and re-page + re-dispatch a
    // declined repair after every daemon restart.
    if (row.verb === "repair") {
      continue;
    }
    mintClear(row.verb, row.id);
    swept++;
  }
  return swept;
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
 * In-drain WAL-checkpoint cadence (folded-event count). The boot drain runs with
 * `wal_autocheckpoint=0` (see {@link withBootDrainCheckpointTuning}), so without a
 * periodic flush the WAL grows for the WHOLE drain — a from-scratch re-fold of
 * ~150k one-event transactions ballooned the WAL to multiple GB before the single
 * final TRUNCATE. {@link drainToCompletion} issues a `wal_checkpoint(PASSIVE)`
 * once this many events have folded since the last in-drain checkpoint, bounding
 * peak WAL to roughly one interval's worth of frames. Gated on COUNT (not
 * per-event) so the millions of near-no-op checkpoints a per-event cadence would
 * cost never dominate drain time. The PASSIVE runs BETWEEN per-event
 * transactions on the writer connection, never inside a fold's `BEGIN IMMEDIATE`.
 */
export const BOOT_DRAIN_CHECKPOINT_EVENT_INTERVAL = 10_000;

/**
 * In-drain WAL-checkpoint size gate (`-wal` file bytes ≈ 50k pages × 4 KiB). The
 * secondary trigger to {@link BOOT_DRAIN_CHECKPOINT_EVENT_INTERVAL}: a burst of
 * large event bodies can grow the WAL past this before the event counter trips,
 * so {@link drainToCompletion} also checkpoints once the `-wal` file crosses this
 * size — whichever fires first. The stat runs at batch boundaries only (~once per
 * `DEFAULT_BATCH_SIZE` folds), never per-event.
 */
export const BOOT_DRAIN_CHECKPOINT_WAL_BYTES = 50_000 * 4096;

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
 * Durable dispatch-mint rate-limit gate window (ms). Within this window after a
 * `verb::id` dispatchKey minted a `Dispatched` event, a re-mint of the SAME key is
 * SUPPRESSED (no second event row) — the restart-surviving guard against one
 * logical dispatch amplifying into N same-instant rows (pre-launch abort loops,
 * restart storms, the insert→fold gap). Sized strictly BELOW the
 * `PENDING_DISPATCH_TTL_MS` (120s) TTL and the `REDISPATCH_COOLDOWN_S` (200s)
 * cooldown so a LEGITIMATE re-dispatch (a TTL-expired re-mint at 120s+, a
 * cooldown-cadence retry at 200s+) passes the gate untouched — only a same-intent
 * burst inside the window is squashed. The window is absolute from the FROZEN
 * first mint (suppression never re-stamps it), so a restart never resets the clock
 * and a legit key can never be suppressed forever.
 */
export const DISPATCH_MINT_GATE_WINDOW_MS = 60_000;

/**
 * Eviction horizon (ms) for a stale `dispatch_mint_gate` row. A row older than
 * this has long since stopped suppressing (window elapsed) and only holds space,
 * so the producer TTL sweep prunes it. Kept a few windows past
 * `DISPATCH_MINT_GATE_WINDOW_MS` so a row is never evicted while it can still
 * suppress.
 */
export const DISPATCH_MINT_GATE_EVICT_MS = DISPATCH_MINT_GATE_WINDOW_MS * 5;

/**
 * Events-log live-ingest poll-is-truth fallback cadence. The `@parcel/watcher`
 * hint is the fast path; this periodic scan is the safety net guaranteeing every
 * NDJSON line lands within one interval even if a watcher event is
 * dropped/coalesced or the worker never subscribed. Under the realtime fold bar,
 * near-free when the dir is unchanged.
 */
export const EVENTS_INGEST_FALLBACK_INTERVAL_MS = 3_000;

/**
 * Heartbeat cadence (ms) for the producer-side retention pass (fn-836.5). Runs
 * on MAIN's writable connection, paced, so it NULLs the cold tail of redundant
 * shed-class `data` bodies over many passes without ever holding the writer lock
 * long enough to starve a concurrent hook INSERT. Slacker than the dispatch
 * sweep: pure space reclamation with no latency-sensitive consumer.
 */
export const RETENTION_INTERVAL_MS = 300_000;

/**
 * Cadence (ms) for the producer-side historical `mutation_path` backfill pass
 * (fn-836.3). Runs on MAIN's writable connection, paced like compaction, so it
 * fills the promoted git-attribution column over the historical mutation tail
 * (inline + already-relocated `event_blobs` rows) across many passes without
 * starving a concurrent hook INSERT. A crash-safe `meta` watermark resumes it,
 * and once `isMutationPathBackfillComplete` holds the pass self-disables — a
 * one-shot historical fill, not steady-state work. Same slack cadence as
 * compaction: pure background catch-up with no latency-sensitive consumer.
 */
export const MUTATION_PATH_BACKFILL_INTERVAL_MS = 300_000;

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
 * Select every `pending_dispatches` row aged past the TTL — UNCONDITIONALLY on
 * `dispatch_failures` membership (fn-870 BUG2). A TTL/lease sweep MUST expire an
 * aged lease regardless of lessee/breaker state: the prior `WHERE df.verb IS NULL`
 * guard was a "suppressed sweep" deadlock — a pending that tripped the never-bound
 * breaker (which mints a sticky `dispatch_failures` row) could NEVER be expired,
 * so it held its launch-window slot + per-root mutex forever (the v76→v79 jam:
 * all 5 phantoms were BLOCKED-by-`dispatch_failures`, so the sweep never freed
 * them). The expiry DELETE is idempotent with a concurrent `DispatchFailed` fold
 * (both DELETE the same `(verb, id)` row), so dropping the guard cannot corrupt
 * the projection — it only re-includes the rows the breaker would otherwise strand.
 * Reads the projection on the passed connection — production passes main's
 * writable connection.
 */
export function selectExpiredPendingDispatches(
  db: Database,
  nowMs: number,
): { verb: string; id: string; dispatched_at: number }[] {
  const rows = db
    .query(`SELECT verb, id, dispatched_at FROM pending_dispatches`)
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
 * Heartbeat cadence (ms) for the daemon block-escalation producer sweep. Rides a
 * heartbeat, NOT the level-triggered `data_version` wake: the `TaskSnapshot` fold
 * that ARMS a `block_escalations` latch does bump `data_version`, but the
 * cancellation guard + per-recipient coalescing want a steady-state re-check even
 * on a quiescent board (a planner-side unblock between sweeps must be observed
 * before the spawn). One-minute cadence matches the pending-dispatch sweep — a
 * blocked task is not latency-sensitive on the order of seconds.
 */
export const BLOCK_ESCALATION_SWEEP_INTERVAL_MS = 60_000;

/**
 * Cadence of the codex resume-target back-fill sweep (fn-1103). A tracked codex
 * job is born with `resume_target` NULL (it mints its own rollout uuid); this
 * sweep resolves the uuid from the rollout head and mints a `ResumeTargetResolved`
 * synthetic event. Seconds-scale so a freshly-launched session becomes resumable
 * promptly, yet the tick is cheap: the candidate query is an indexed point-read and
 * the rollout-tree read runs ONLY when a NULL-target codex job exists.
 */
export const CODEX_RESUME_SWEEP_INTERVAL_MS = 5_000;

/**
 * Recency floor for codex resume candidates: a job whose rollout uuid stays
 * unresolved past this (a same-cwd collision with the originator override
 * stripped, or a rollout that never persisted) drops out of the candidate set so
 * the sweep goes quiet instead of scanning the tree forever. Its presence is
 * unaffected — it simply stays `resume_target` NULL (not-resumable).
 */
export const CODEX_RESUME_RECENT_WINDOW_SEC = 600;

/**
 * Recency window for codex rollout-ADOPTION discovery (fn-1131). Only rollout
 * day-dirs whose sessions started within this window are scanned, so a knob-flip
 * on a codex install with months of history reads a bounded, fixed number of
 * day-dirs — scan cost is a function of THIS window, never of harness lifetime.
 * A day old enough that its whole rollout set predates the floor is skipped. A
 * genuinely stale session (started before the window) is simply never adopted.
 */
export const CODEX_ADOPTION_RECENT_WINDOW_SEC = 24 * 60 * 60;

/**
 * Per-tick adoption mint cap (fn-1131). Bounds how many adopted jobs one sweep
 * tick mints, so a knob-flip that finds a burst of eligible rollouts drains
 * gradually across ticks rather than minting them all under one write lock. The
 * window bounds the scan; this bounds the mints — both invariants are
 * acceptance-bound, the constants themselves are tunable.
 */
export const CODEX_ADOPTION_MINT_CAP_PER_TICK = 8;

/**
 * The ONE blocked category that does NOT escalate to the planner: a
 * `TOOLING_FAILURE` is surface-and-stop (a broken runner / env, not a question a
 * planner can answer on the board). DENYLIST shape — every other worker category
 * (`SPEC_UNCLEAR` / `DEPENDENCY_BLOCKED` / `DESIGN_CONFLICT` / `SCOPE_EXCEEDED` /
 * `EXTERNAL_BLOCKED`) plus `RESUME_EXHAUSTED` escalates — so a future category
 * rides through as escalatable with no code change.
 */
export const BLOCK_ESCALATION_SKIP_CATEGORY = "TOOLING_FAILURE";

/**
 * The blocked category whose authority follows the SHARED (base) surface rather than
 * one task: a worker-confirmed "the shared base is broken" report. It routes NOT to a
 * diagnosis-only `unblock::<task>` session but to a write-capable, trunk-committing
 * `repair::<repo-token>` escalation, keyed per (repo, fingerprint) and fanning its
 * fix out to every affected task across every epic on that repo. Named as its own
 * constant (not folded into the denylist) so the {@link routeBlockedCategory} table
 * can key on it explicitly.
 */
export const SHARED_BASE_BROKEN_CATEGORY = "SHARED_BASE_BROKEN";

/**
 * A pending `block_escalations` latch row joined to its epic's `project_dir` and
 * the embedded task's live `runtime_status` / `target_repo`. The producer sweep's
 * current-state working set — bounded by the number of concurrently-blocked
 * tasks, never a history scan.
 */
export interface PendingBlockEscalation {
  epic_id: string;
  task_id: string;
  /** Owning epic's `project_dir` — the plan state-file root for the reason read. */
  project_dir: string | null;
  /** The embedded task's live `runtime_status` — the cancellation-guard signal. */
  runtime_status: string | null;
  /** The embedded task's `target_repo` — the effective-repo override. */
  target_repo: string | null;
}

/**
 * Select every `block_escalations` row in `status='pending'`, joined to its epic
 * row for `project_dir` and to the embedded task element (decoded from the epic's
 * `tasks` JSON) for the live `runtime_status` + `target_repo`. The cancellation
 * guard re-checks `runtime_status` at sweep time against the live projection — a
 * task unblocked between arm and sweep reads non-`blocked` here and is skipped
 * (the `TaskSnapshot` leave-blocked fold DELETEs its latch on its own). A pending
 * latch with no surviving epic / task element returns null fields; the producer
 * treats that as "no longer escalatable" and skips. Reads the projection on the
 * passed connection — production passes main's writable connection so the read is
 * sequenced inside the same writer that mints.
 */
export function selectPendingBlockEscalations(
  db: Database,
): PendingBlockEscalation[] {
  const latches = db
    .query(
      `SELECT epic_id, task_id FROM block_escalations WHERE status = 'pending'`,
    )
    .all() as { epic_id: string; task_id: string }[];
  if (latches.length === 0) return [];
  const out: PendingBlockEscalation[] = [];
  for (const latch of latches) {
    const epicRow = db
      .query(`SELECT project_dir, tasks FROM epics WHERE epic_id = ?`)
      .get(latch.epic_id) as
      | { project_dir: string | null; tasks: string }
      | null
      | undefined;
    let runtimeStatus: string | null = null;
    let targetRepo: string | null = null;
    if (epicRow != null) {
      // The embedded `tasks` JSON is a foreign-process array; a parse failure
      // folds to "task element not found" (null fields) — never throws into the
      // sweep.
      try {
        const tasks = JSON.parse(epicRow.tasks) as {
          task_id?: unknown;
          runtime_status?: unknown;
          target_repo?: unknown;
        }[];
        const el = tasks.find((t) => t.task_id === latch.task_id);
        if (el != null) {
          runtimeStatus =
            typeof el.runtime_status === "string" ? el.runtime_status : null;
          targetRepo =
            typeof el.target_repo === "string" ? el.target_repo : null;
        }
      } catch {
        // Leave null fields — the producer skips a latch it can't resolve.
      }
    }
    out.push({
      epic_id: latch.epic_id,
      task_id: latch.task_id,
      project_dir: epicRow?.project_dir ?? null,
      runtime_status: runtimeStatus,
      target_repo: targetRepo,
    });
  }
  return out;
}

/**
 * Parse the leading `<CATEGORY>:` prefix off a worker's `blocked_reason` (e.g.
 * `"SPEC_UNCLEAR: the spec ..."` → `"SPEC_UNCLEAR"`). Returns null on an absent /
 * empty / prefix-less reason (no leading `WORD:` token) — the producer treats a
 * null category the same as `TOOLING_FAILURE`: skip. Pure; never throws. The
 * token is `[A-Z_]+` so a free-text reason that happens to contain a `:` later
 * (e.g. `"see foo: bar"`) does NOT false-match.
 */
export function parseBlockedCategory(reason: string | null): string | null {
  if (reason == null) return null;
  const m = reason.match(/^\s*([A-Z_]+):/);
  return m != null ? m[1] : null;
}

/**
 * The escalation gate (DENYLIST): escalate unless the parsed category is
 * `TOOLING_FAILURE` or absent/unparseable. A `null` category (no `<CATEGORY>:`
 * prefix) is NOT escalatable — an unparseable reason is treated as surface-and-stop,
 * never blindly fanned out to the planner. Pure.
 */
export function shouldEscalateBlockedCategory(
  category: string | null,
): boolean {
  return category != null && category !== BLOCK_ESCALATION_SKIP_CATEGORY;
}

/**
 * The route a blocked category takes out of the block-escalation sweep:
 *  - `surface_and_stop` — a `TOOLING_FAILURE` / absent-or-unparseable category:
 *    NEVER dispatch an agent; suppress `work::<task>` re-dispatch (see
 *    {@link runBlockEscalationSweep}).
 *  - `repair` — a `SHARED_BASE_BROKEN` category: the shared base is broken, so
 *    authority follows the repo surface. The sweep does NOT dispatch a
 *    diagnosis-only `unblock::<task>` here; the sibling repair sweep
 *    ({@link runRepairEscalationSweep}) owns the (repo, fingerprint)-keyed,
 *    write-capable `repair::<repo-token>` dispatch, so the block sweep skips the row
 *    (latch left `pending`, re-sweeps; a successful repair unblocks the task,
 *    deleting the latch).
 *  - `unblock` — every other escalatable category: today's per-epic-serialized
 *    `unblock::<task>` dispatch, byte-equivalent.
 */
export type BlockRoute = "surface_and_stop" | "repair" | "unblock";

/**
 * The category→route dispatch TABLE — the shared SEAM the block-escalation sweep
 * routes each blocked row through. Extracted as ONE pure exported function (rather
 * than an inline if/else chain in the sweep body) so a new category route is a
 * one-line edit HERE, never a rewrite of the sweep loop — the seam an in-flight epic
 * adding audit-category routes (AUDIT_READY / AUDIT_SEVERE) extends without a
 * merge-conflict. Pure; total; never throws.
 */
export function routeBlockedCategory(category: string | null): BlockRoute {
  if (category === SHARED_BASE_BROKEN_CATEGORY) return "repair";
  if (!shouldEscalateBlockedCategory(category)) return "surface_and_stop";
  return "unblock";
}

/**
 * Compute the effective repo for an unblock dispatch: the task's `target_repo`
 * override when present, else the epic's `project_dir`, else `""`. Mirrors the
 * autopilot/readiness `effectiveRoot` derivation — the launch cwd for the
 * `unblock::<task>` escalation session, and the `dir` on the surface-and-stop
 * re-dispatch suppression. Pure.
 */
export function effectiveBlockEscalationRepo(
  targetRepo: string | null,
  projectDir: string | null,
): string {
  if (targetRepo != null && targetRepo !== "") return targetRepo;
  if (projectDir != null && projectDir !== "") return projectDir;
  return "";
}

/**
 * The two audit categories the block-escalation producer treats specially. An
 * `AUDIT_READY` block is self-handled by the owning orchestrator (no page while it
 * lives); an `AUDIT_SEVERE` block escalates immediately like any block. Both are
 * plain `<CATEGORY>:` reason prefixes ({@link parseBlockedCategory}), so an epic
 * that emits neither leaves the gate inert.
 */
export const AUDIT_READY_CATEGORY = "AUDIT_READY";
export const AUDIT_SEVERE_CATEGORY = "AUDIT_SEVERE";

/**
 * Grace (ms) after the owning orchestrator job dies before a still-parked
 * `AUDIT_READY` task escalates like any block. A live orchestrator defers
 * indefinitely; only a witnessed death past this window pages. Tunable.
 */
export const AUDIT_READY_ORCHESTRATOR_GRACE_MS = 120_000;

/**
 * The owning orchestrator's liveness as the AUDIT_READY gate reads it off the jobs
 * projection: `live` (a `work`/`close` session for the task or its epic is
 * running), `dead` with the last-activity wall-clock (ms) of the most-recent dead
 * owner, or `absent` (no owner row at all).
 */
export type AuditOrchestratorLiveness =
  | { readonly state: "live" }
  | { readonly state: "dead"; readonly diedAtMs: number }
  | { readonly state: "absent" };

/**
 * Classify the owning orchestrator of a parked AUDIT_READY task off `jobs` — the
 * `work::<task>` session or the `close::<epic>` session that runs (or re-dispatches)
 * the audit and resumes the worker. Liveness rides the shared {@link isStoppedJobLive}
 * rule (`working`, or `stopped` with a live backend — never forked); a dead owner's
 * `updated_at` (an event ts, seconds) is its death anchor, so the ONLY wall-clock is
 * the caller's `now` comparison, never this read. Any live owner wins. Pure over the
 * passed rows; exported for tests.
 */
export function probeAuditOrchestrator(
  jobs: readonly Job[],
  epicId: string,
  taskId: string,
): AuditOrchestratorLiveness {
  let latestDeadMs: number | null = null;
  for (const job of jobs) {
    if (job.plan_verb !== "work" && job.plan_verb !== "close") continue;
    if (job.plan_ref !== taskId && job.plan_ref !== epicId) continue;
    if (
      job.state === "working" ||
      (job.state === "stopped" && isStoppedJobLive(job, null))
    ) {
      return { state: "live" };
    }
    const ms = (job.updated_at ?? 0) * 1000;
    if (latestDeadMs == null || ms > latestDeadMs) latestDeadMs = ms;
  }
  if (latestDeadMs != null) return { state: "dead", diedAtMs: latestDeadMs };
  return { state: "absent" };
}

/**
 * The AUDIT_READY escalation gate. `defer` while the owning orchestrator is live,
 * or dead within the grace window, or absent (no witnessed death — never page a
 * park we cannot even attribute; the safe under-page direction the epic's
 * noise-is-the-dominant-failure stance demands). `escalate` once a dead
 * orchestrator's grace has elapsed, handing the park to the ordinary
 * block-escalation path. Pure.
 */
export function auditReadyEscalationDecision(
  liveness: AuditOrchestratorLiveness,
  nowMs: number,
  graceMs: number,
): "defer" | "escalate" {
  if (liveness.state === "dead" && nowMs - liveness.diedAtMs >= graceMs) {
    return "escalate";
  }
  return "defer";
}

/** The outcome the producer records on the `block_escalations` latch (the
 *  `BlockEscalationAttempted.outcome` column). The TERMINAL `dispatched` (the
 *  `unblock::<task>` session launched) and the two skip terminals advance the latch
 *  to `attempted`; the non-terminal `dispatch_failed` (the launch missed) RESETS it
 *  to `pending` so the sweep re-attempts (`foldBlockEscalationAttempted`). A
 *  cap/occupancy SKIP (`at_cap` / `already_live`) mints NOTHING at all — the latch
 *  stays `pending` and re-sweeps. */
export type BlockEscalationOutcome =
  | "dispatched"
  | "dispatch_failed"
  | "skipped_category"
  | "skipped_unblocked";

/** Injectable dependency surface for {@link runBlockEscalationSweep} — the block/
 *  unblock DISPATCH sweep. Mirrors {@link MergeEscalationSweepDeps}'s fail-open
 *  injectable-deps discipline so the producer is testable with synthetic rows + an
 *  injected dispatcher, and never throws into the daemon loop. */
export interface BlockEscalationSweepDeps {
  /** The current-state pending working set (DELEGATES to
   *  {@link selectPendingBlockEscalations} in production). */
  readonly selectPending: () => PendingBlockEscalation[];
  /** Read the task's `blocked_reason` from its plan state file, or null on any
   *  miss (absent file / unreadable / no field). Producer-side fs read — legal
   *  outside any fold. */
  readonly readBlockedReason: (
    projectDir: string | null,
    taskId: string,
  ) => string | null;
  /** Mint a `BlockEscalationRequested` synthetic event (advances the latch
   *  `pending → requested`). */
  readonly mintRequested: (epicId: string, taskId: string) => void;
  /** Mint a `BlockEscalationAttempted{outcome}` synthetic event (advances the
   *  latch `requested → attempted`, records `outcome`). */
  readonly mintAttempted: (
    epicId: string,
    taskId: string,
    outcome: BlockEscalationOutcome,
  ) => void;
  /** Launch ONE `unblock::<task>` escalation session for the blocked row (into the
   *  managed session, at the escalation model/effort, with the `/plan:unblock`
   *  prompt). DELEGATES to the shared {@link dispatchEscalationSession} in
   *  production, so the global cap + per-key occupancy guard apply. Async +
   *  fail-open — every error degrades to `dispatch_failed`, and a SKIP (`at_cap` /
   *  `already_live`) mints nothing so the row re-sweeps. */
  readonly dispatchUnblock: (
    row: PendingBlockEscalation,
  ) => Promise<EscalationDispatchOutcome>;
  /** True IFF an `unblock::<task>` session for ANY task in `epicId` is already LIVE
   *  — the per-EPIC serialization guard. At most one live unblock session per epic,
   *  so a mass-block never fans an epic's siblings out at once; a same-epic sibling
   *  stays latched `pending` and re-sweeps once the live session goes terminal.
   *  Production reads the live jobs (via {@link epicHasLiveUnblock}) PLUS the
   *  producer's not-yet-folded in-flight memo. */
  readonly isEpicUnblockLive: (epicId: string) => boolean;
  /** Classify the owning orchestrator's liveness for an AUDIT_READY park
   *  (DELEGATES to {@link probeAuditOrchestrator} over the live jobs in
   *  production). Read ONLY for the `AUDIT_READY` category — every other category
   *  ignores it. Optional: absent → the gate reads `absent` and defers, so a
   *  test with no AUDIT_READY row need not supply it. */
  readonly auditOrchestratorLiveness?: (
    row: PendingBlockEscalation,
  ) => AuditOrchestratorLiveness;
  /** Wall-clock now in ms — the AUDIT_READY grace clock (producer-side).
   *  Optional; defaults to {@link Date.now}. */
  readonly now?: () => number;
  /** True IFF an OPEN sticky `dispatch_failures` row already exists for
   *  `work::<taskId>` — the once-only guard for {@link suppressRedispatch}. Reads
   *  the live projection on the writable connection in production; the sweep skips
   *  the mint when this is true so the 60s cadence never re-emits the row. */
  readonly hasOpenWorkFailure: (taskId: string) => boolean;
  /** Durably suppress autopilot re-dispatch of `work::<taskId>` after a
   *  surface-and-stop block (`TOOLING_FAILURE` / absent-or-unparseable category):
   *  mint a sticky `DispatchFailed` on the key so the existing `failedKeys`
   *  reconcile arm holds the task out independent of the transient
   *  `runtime_status='blocked'` / `block_escalations` latch (BOTH deleted on
   *  leave-blocked, so neither can hold the task out past the transient window).
   *  Cleared only by `retry_dispatch` (the human-cleared `failedKeys` contract).
   *  Producer-side mint; fail-open. */
  readonly suppressRedispatch: (args: {
    taskId: string;
    reason: string;
    dir: string | null;
  }) => void;
  /** Warn sink for non-fatal diagnostics. */
  readonly noteLine?: (line: string) => void;
}

/**
 * Run one daemon block-escalation sweep (stage 2) — the producer half of the
 * dispatch-once loop for a blocked task with an escalatable category. Walk the
 * pending `block_escalations` latch rows, gate each by the cancellation guard + the
 * category denylist, then DISPATCH one `unblock::<task>` escalation session per
 * escalatable block — SERIALIZED per epic (at most one live unblock session per
 * epic). No planner@ bus message: the session boots `/plan:unblock` and resolves the
 * blocker without the creator's context.
 *
 * Each row resolves to one of:
 *  - `skipped_unblocked` (terminal) — the cancellation guard fired (task left
 *    `blocked`). Mints Requested→Attempted so the latch leaves `pending`.
 *  - `skipped_category` (terminal) — `TOOLING_FAILURE` / absent-or-unparseable
 *    reason: surface-and-stop. Mints Requested→Attempted AND a durable
 *    `work::<task>` re-dispatch suppression (once-only). NEVER dispatches an agent.
 *  - a same-epic serialization SKIP — a sibling already holds the epic's one live
 *    unblock (won the claim THIS cycle, or still live from a prior cycle): mints
 *    NOTHING, so the latch stays `pending` and re-sweeps once that session goes
 *    terminal (no starvation, no same-epic collision).
 *  - `dispatched` (terminal) / `dispatch_failed` (non-terminal, re-sweeps) — the
 *    launch outcome. A cap/occupancy SKIP (`at_cap` / `already_live`) mints NOTHING.
 *
 * NEVER throws — every helper edge degrades to a recorded outcome (mirrors {@link
 * runMergeEscalationSweep}). The spawn lives ONLY here in the producer, never
 * reachable from `applyEvent`, so a re-fold never re-fires a launch.
 */
export async function runBlockEscalationSweep(
  deps: BlockEscalationSweepDeps,
): Promise<void> {
  const note = deps.noteLine ?? (() => {});
  let pending: PendingBlockEscalation[];
  try {
    pending = deps.selectPending();
  } catch (err) {
    note(
      `# warn: block-escalation sweep read threw (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  if (pending.length === 0) return;

  // Per-EPIC serialization: at most one `unblock::<task>` dispatch per epic per
  // sweep. `claimedEpics` bounds the WITHIN-sweep fan-out (a mass-block of many
  // same-epic tasks); `isEpicUnblockLive` bounds it ACROSS sweeps (a session
  // dispatched a prior cycle is still live). A same-epic sibling loses both guards
  // and stays latched `pending` — it re-sweeps once the live session goes terminal.
  const claimedEpics = new Set<string>();
  for (const row of pending) {
    // Cancellation guard: the task left `blocked` between arm and sweep. The
    // leave-blocked `TaskSnapshot` fold DELETEs the latch on its own, so mint
    // Requested→Attempted{skipped_unblocked} is a belt-and-braces terminal — if
    // the DELETE already ran, both folds no-op on the missing row.
    if (row.runtime_status !== "blocked") {
      deps.mintRequested(row.epic_id, row.task_id);
      deps.mintAttempted(row.epic_id, row.task_id, "skipped_unblocked");
      continue;
    }

    const reason = deps.readBlockedReason(row.project_dir, row.task_id);
    const category = parseBlockedCategory(reason);

    // AUDIT_READY: a per-task audit deliberately parked this task; the owning
    // orchestrator runs the audit and resumes the worker. Self-handled — mint
    // NOTHING while that orchestrator is live (or within the post-death grace),
    // so the latch stays `pending` and re-sweeps without ever paging. Only a
    // witnessed orchestrator death past the grace falls through to escalate like
    // any block (the recovery path — a planner runs or re-dispatches the audit).
    // AUDIT_SEVERE carries no such prefix match and rides the ordinary
    // escalatable path below, paging immediately like any block.
    if (category === AUDIT_READY_CATEGORY) {
      const liveness = deps.auditOrchestratorLiveness?.(row) ?? {
        state: "absent",
      };
      const nowMs = (deps.now ?? Date.now)();
      if (
        auditReadyEscalationDecision(
          liveness,
          nowMs,
          AUDIT_READY_ORCHESTRATOR_GRACE_MS,
        ) === "defer"
      ) {
        continue;
      }
      // Past grace with a dead orchestrator: fall through to the ordinary
      // escalatable dispatch path (AUDIT_READY routes "unblock" below).
    }

    const route = routeBlockedCategory(category);
    if (route === "repair") {
      // SHARED_BASE_BROKEN: authority follows the repo surface, not this one task.
      // The sibling repair sweep owns the (repo, fingerprint)-keyed
      // `repair::<repo-token>` dispatch, so skip WITHOUT minting — the latch stays
      // `pending` and re-sweeps; a successful repair unblocks the task, deleting the
      // latch via the leave-blocked `TaskSnapshot` fold. NEVER dispatch a
      // diagnosis-only unblock for a shared-base breakage (that is the whole point of
      // the repair route), and never surface-and-stop it (it IS escalatable, just to a
      // different owner).
      continue;
    }
    if (route === "surface_and_stop") {
      // TOOLING_FAILURE / absent / unparseable: surface-and-stop, NEVER dispatch an
      // agent. Record a terminal outcome so it never re-evaluates.
      deps.mintRequested(row.epic_id, row.task_id);
      deps.mintAttempted(row.epic_id, row.task_id, "skipped_category");
      // Durable re-dispatch guard: a surface-and-stop block must NOT auto-requeue.
      // The `block_escalations` latch (now leaving `pending`) and the transient
      // `runtime_status='blocked'` flag are both deleted on leave-blocked, so
      // neither holds the task out past the block window — a long-running worker
      // that ends, or fold lag, otherwise re-dispatches it every cycle. Mint a
      // sticky `DispatchFailed` on `work::<task>` so the existing `failedKeys`
      // reconcile arm suppresses cold re-dispatch until a human `retry_dispatch`
      // clears it. Once-only: skip the mint when a row already exists so the 60s
      // sweep never re-emits.
      if (!deps.hasOpenWorkFailure(row.task_id)) {
        deps.suppressRedispatch({
          taskId: row.task_id,
          reason: `blocked: ${category ?? "unparseable"}`,
          dir:
            effectiveBlockEscalationRepo(row.target_repo, row.project_dir) ||
            null,
        });
      }
      continue;
    }

    // Per-epic serialization: an unblock is already in play for this epic — either a
    // sibling won the claim THIS sweep, or a session dispatched a prior cycle is
    // still live. Skip WITHOUT minting so the latch stays `pending` and re-sweeps
    // once that session terminates (a shared root cause the unblock clears takes the
    // sibling out of `blocked`, deleting its latch before it ever dispatches).
    if (claimedEpics.has(row.epic_id) || deps.isEpicUnblockLive(row.epic_id)) {
      continue;
    }
    claimedEpics.add(row.epic_id);

    // The escalatable serialization-winner row. Launch the `unblock::<task>` session,
    // then record the outcome. A SKIP (`at_cap` / `already_live`) mints nothing — the
    // latch stays `pending` and re-sweeps (at cap, or once the in-flight session
    // folds). Only a real attempt (`dispatched` / `dispatch_failed`) mints
    // Requested→Attempted: the fold advances the latch to `attempted` on `dispatched`
    // and RESETS it to `pending` on `dispatch_failed` (a re-sweepable retry).
    let outcome: EscalationDispatchOutcome;
    try {
      outcome = await deps.dispatchUnblock(row);
    } catch (err) {
      // The dispatcher is fail-open by contract; this catch is defense-in-depth so a
      // surprise throw still records a non-terminal outcome and never aborts the sweep.
      note(
        `# warn: unblock dispatch threw for ${row.task_id} (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      outcome = "dispatch_failed";
    }
    if (
      outcome === "at_cap" ||
      outcome === "already_live" ||
      outcome === "checkout_busy"
    ) {
      continue;
    }
    deps.mintRequested(row.epic_id, row.task_id);
    deps.mintAttempted(row.epic_id, row.task_id, outcome);
  }
}

// ---------------------------------------------------------------------------
// fn-1129 — daemon unblock human-notify sweep (stage 3)
// ---------------------------------------------------------------------------
//
// The TERMINAL stage of the block/unblock escalation path, sibling to the
// deconflict human-notify sweep. Where stage 2 (`runBlockEscalationSweep`)
// DISPATCHES an `unblock::<task>` session, this sweep fires the ONE human
// notification — via botctl — only once that session ALSO declines or dies. A
// SUCCESSFUL unblock flips the task out of `blocked`, which DELETEs the latch via
// the leave-blocked `TaskSnapshot` fold, so this sweep never sees a resolved block.

/**
 * A dispatched-but-not-yet-notified `block_escalations` latch row — the stage-3
 * working set (keyed `(epic_id, task_id)`). Bounded by the number of concurrently
 * dispatched-and-declined unblock escalations, never a history scan.
 */
export interface PendingBlockHumanNotify {
  epic_id: string;
  task_id: string;
}

/**
 * Select every `block_escalations` latch whose `unblock::<task>` session was
 * DISPATCHED (`status='attempted'`, `outcome='dispatched'`) but whose human has NOT
 * yet been notified (`human_notified_at IS NULL`). The SQL twin of the stage-3 gate:
 * `outcome='dispatched'` excludes the `skipped_*` terminals (no session ran for
 * them), and a stamped `human_notified_at` (the terminal `notified` fold) drops the
 * row — the notify-once guarantee. The leave-blocked DELETE re-arms the whole chain.
 */
export function selectPendingBlockHumanNotifications(
  db: Database,
): PendingBlockHumanNotify[] {
  return db
    .query(
      `SELECT epic_id, task_id FROM block_escalations
         WHERE status = 'attempted'
           AND outcome = 'dispatched'
           AND human_notified_at IS NULL`,
    )
    .all() as PendingBlockHumanNotify[];
}

/** The outcome the unblock human-notify sweep records on the `BlockHumanNotified`
 *  event. The TERMINAL `notified` stamps the `human_notified_at` once-marker;
 *  `notify_failed` is NON-TERMINAL — the row stays re-sweepable so the next tick
 *  retries (the block stays operator-visible on the board meanwhile). */
export type BlockHumanNotifiedOutcome = "notified" | "notify_failed";

/**
 * Build the ONE structured operator notification the unblock human-notify sweep
 * sends over botctl when an `unblock::<task>` session DECLINES (stamped BLOCKED) or
 * DIES. Short by design — the blocked task already carries the full context on the
 * board (`keeper status` / `keeper plan show`); this is the courtesy ping that names
 * the task, the verdict, and the unstick command. Pure.
 */
export function buildBlockHumanNotifyBody(args: {
  epicId: string;
  taskId: string;
  verdict: "declined" | "died";
}): string {
  const verdictLine =
    args.verdict === "died"
      ? `its job DIED before resolving`
      : `it DECLINED (could not resolve the blocker — stamped BLOCKED)`;
  return [
    `🔴 keeper: unblock::${args.taskId} needs you — the autonomous unblock`,
    `escalation session gave up on the blocked task (${verdictLine}); task`,
    `${args.taskId} (epic ${args.epicId}) stays BLOCKED and will NOT auto-retry.`,
    ``,
    `Resolve the blocker by hand, then unstick the board:`,
    `  keeper plan unblock ${args.taskId}`,
  ].join("\n");
}

/**
 * Build the ONE structured operator page the repair human-notify sweep sends over
 * botctl when a `repair::<repo-token>` session DECLINES or DIES. Short by design — the
 * sticky repair row + every affected task carry the full context on the board; this is
 * the courtesy page that names the repo, the verdict, and the re-arm command. Pure.
 */
export function buildRepairHumanNotifyBody(args: {
  repoToken: string;
  repoDir: string | null;
  verdict: "declined" | "died";
}): string {
  const verdictLine =
    args.verdict === "died"
      ? `its job DIED before landing a fix`
      : `it DECLINED (could not repair the shared base — stamped BLOCKED)`;
  const repo = args.repoDir != null && args.repoDir !== "" ? args.repoDir : "?";
  return [
    `🔴 keeper: repair::${args.repoToken} needs you — the autonomous shared-base`,
    `repair session gave up on the broken base (${verdictLine}); repo ${repo}`,
    `stays broken and every SHARED_BASE_BROKEN task on it stays BLOCKED.`,
    ``,
    `Fix the shared base by hand, then re-arm the repair:`,
    `  keeper autopilot retry repair::${args.repoToken}`,
  ].join("\n");
}

/** Injectable dependency surface for {@link runBlockHumanNotifySweep} — the stage-3
 *  unblock human-notify sweep. Same fail-open injectable-deps discipline as
 *  {@link DeconflictHumanNotifySweepDeps}. */
export interface BlockHumanNotifySweepDeps {
  /** The current-state pending working set (DELEGATES to
   *  {@link selectPendingBlockHumanNotifications} in production). */
  readonly selectPending: () => PendingBlockHumanNotify[];
  /** Re-read that the latch for `(epicId, taskId)` is STILL the dispatched-but-not-
   *  notified stage-3 row — checked immediately before the notify to narrow the
   *  clear-mid-sweep window (a leave-blocked DELETE between select and notify drops
   *  the row). Reads the live projection on the writable connection in production. */
  readonly stillPending: (epicId: string, taskId: string) => boolean;
  /** Classify the dispatched `unblock::<task>` session's outcome for `taskId`
   *  (DELEGATES to {@link classifyEscalationOutcome} over the live `jobs` map in
   *  production). The human is notified ONLY on a terminal verdict; while the session
   *  is live or its job has not folded yet it returns `{terminal:false}` and the
   *  sweep skips the row (a successful unblock clears the latch before this runs). */
  readonly unblockOutcome: (taskId: string) => ResolverOutcome;
  /** Send the ONE botctl notification about the declined/dead unblock session.
   *  Async + fail-open — every error degrades to `notify_failed` so the row re-sweeps
   *  (the block stays operator-visible meanwhile), never a wedge or a silent drop. */
  readonly notifyHuman: (
    row: PendingBlockHumanNotify,
    verdict: "declined" | "died",
  ) => Promise<BlockHumanNotifiedOutcome>;
  /** Mint a `BlockHumanNotified{outcome}` synthetic event. The fold stamps
   *  `human_notified_at` ONLY on the terminal `notified`; it NEVER clears the latch —
   *  only the leave-blocked `TaskSnapshot` DELETE does, which re-arms it at NULL. */
  readonly mintAttempted: (
    epicId: string,
    taskId: string,
    outcome: BlockHumanNotifiedOutcome,
  ) => void;
  /** Warn sink for non-fatal diagnostics. */
  readonly noteLine?: (line: string) => void;
}

/**
 * Run one daemon unblock human-notify sweep (stage 3) — the terminal "notify the
 * human ONCE" half of the block/unblock escalation path. Walk the dispatched-but-
 * not-notified latch rows, re-read that each is STILL pending, sequence behind the
 * `unblock::<task>` session's TERMINAL decline/death, send ONE botctl notification,
 * then mint `BlockHumanNotified{outcome}`.
 *
 * NOTIFIES ONCE — the sweep NEVER clears the latch; only the leave-blocked DELETE
 * does. A TERMINAL `notified` stamps the `human_notified_at` once-marker, so the next
 * sweep's selector drops the row; a `notify_failed` (botctl absent / failed) leaves
 * the marker NULL so the row re-sweeps and the notification is never lost (the block
 * is operator-visible the whole time). NEVER throws — every helper edge degrades to a
 * recorded outcome (mirrors {@link runDeconflictHumanNotifySweep}). The spawn lives
 * ONLY here in the producer, never reachable from `applyEvent`.
 */
export async function runBlockHumanNotifySweep(
  deps: BlockHumanNotifySweepDeps,
): Promise<void> {
  const note = deps.noteLine ?? (() => {});
  let pending: PendingBlockHumanNotify[];
  try {
    pending = deps.selectPending();
  } catch (err) {
    note(
      `# warn: unblock human-notify sweep read threw (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  if (pending.length === 0) return;

  for (const row of pending) {
    // Re-read immediately before the notify: a leave-blocked DELETE (the task got
    // unblocked) or the notified fold between select and notify means there is
    // nothing left to notify — skip without minting.
    if (!deps.stillPending(row.epic_id, row.task_id)) continue;
    // Sequence behind the unblock session: notify the human only once that session
    // reached a TERMINAL decline/death. While it is live — or its job has not folded
    // yet — skip without minting, so the row re-sweeps next tick. A successful unblock
    // takes the task out of `blocked`, deleting the latch before this sweep sees it.
    const outcome = deps.unblockOutcome(row.task_id);
    if (!outcome.terminal) continue;

    let result: BlockHumanNotifiedOutcome;
    try {
      result = await deps.notifyHuman(row, outcome.verdict);
    } catch (err) {
      // The helper is fail-open by contract; this catch is defense-in-depth so a
      // surprise throw still records a non-terminal outcome and never aborts the sweep.
      note(
        `# warn: unblock human-notify threw for ${row.task_id} (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      result = "notify_failed";
    }
    // Mint the attempt regardless of outcome: the fold stamps the once-marker ONLY on a
    // terminal `notified`, so a `notify_failed` folds to a no-op and the row re-sweeps.
    deps.mintAttempted(row.epic_id, row.task_id, result);
  }
}

// ---------------------------------------------------------------------------
// fn-1173 — daemon SHARED_BASE_BROKEN repair-escalation producer
// ---------------------------------------------------------------------------
//
// The write-capable sibling of the unblock/deconflict escalation dispatches. Where a
// `unblock::<task>` session is diagnosis-only and task-scoped, a `repair::<repo-token>`
// session is REPO-scoped and trunk-committing: it fixes the broken shared base ONCE and
// its fix fans out to every affected task across every epic on that repo. The sweep
// coalesces every `SHARED_BASE_BROKEN` blocked task to at most one repair per repo
// (biasing conservative — one repair per shared checkout never races two commits at one
// tree), keying the fingerprint on the reason so escalation-brief can name the defect.

/** The fixed leading token a repair session's sticky `dispatch_failures` row carries in
 *  its `reason` — `shared-base-broken:<fingerprint>`. The SAME contract
 *  `cli/escalation-brief.ts`'s `REPAIR_REASON_RE` parses, established there ahead of this
 *  producer; the fingerprint half is a `\S+` token (see {@link fingerprintFailure}). */
export const REPAIR_REASON_PREFIX = "shared-base-broken";

/** Build the sticky repair row's `reason` for a fingerprint — the mint-side twin of
 *  `cli/escalation-brief.ts`'s `REPAIR_REASON_RE`. Pure. */
export function repairReasonFor(fingerprint: string): string {
  return `${REPAIR_REASON_PREFIX}:${fingerprint}`;
}

/** One `SHARED_BASE_BROKEN` blocked task resolved to the shared repo it hashes to — the
 *  repair sweep's per-row working set, bounded by the number of concurrently
 *  shared-base-broken tasks (never a history scan). Coalesced by {@link repo_token}. */
export interface RepairCandidate {
  epic_id: string;
  task_id: string;
  /** The resolved shared-checkout dir (non-empty) — the repair session's cwd. */
  repo_dir: string;
  /** {@link repoToken}(repo_dir) — the `repair::<token>` key half + row id. */
  repo_token: string;
  /** {@link fingerprintFailure}(blocked reason) — the defect identity in the row reason. */
  fingerprint: string;
}

/** The coalesced representative of a repo token's candidate group — the (repo_dir,
 *  fingerprint) one repair dispatch + one sticky row are keyed on. */
export interface RepairGroup {
  repo_token: string;
  repo_dir: string;
  fingerprint: string;
}

/** An existing sticky `dispatch_failures` repair row (verb `repair`, id the repo
 *  token) — the repair sweep's clear/notify working set. */
export interface PendingRepairRow {
  /** The repo token (`dispatch_failures.id`; verb is `repair`). */
  id: string;
  reason: string;
  dir: string | null;
  /** The dispatch-once marker (stamped by `RepairDispatched`). */
  repair_dispatched_at: number | null;
  /** The page-once marker (stamped by `RepairHumanNotified`). */
  human_notified_at: number | null;
}

/** The outcome the repair sweep records on `RepairDispatched`. The TERMINAL
 *  `dispatched` stamps `repair_dispatched_at`; `dispatch_failed` is NON-terminal. */
export type RepairDispatchOutcome = "dispatched" | "dispatch_failed";

/** The outcome the repair sweep records on `RepairHumanNotified`. The TERMINAL
 *  `notified` stamps `human_notified_at`; `notify_failed` is NON-terminal. */
export type RepairHumanNotifiedOutcome = "notified" | "notify_failed";

/** Injectable dependency surface for {@link runRepairEscalationSweep}. Same fail-open
 *  injectable-deps discipline as the sibling escalation sweeps — the producer is
 *  testable with synthetic candidates + rows and an injected dispatcher, never touching
 *  a real daemon / git / socket, and never throws into the daemon loop. */
export interface RepairEscalationSweepDeps {
  /** The current `SHARED_BASE_BROKEN` blocked candidates, resolved to (repo, fingerprint)
   *  (production builds them from {@link selectPendingBlockEscalations} + the fs reason
   *  read + {@link repoToken} + {@link fingerprintFailure}). */
  readonly selectCandidates: () => RepairCandidate[];
  /** The existing sticky repair rows (production: `dispatch_failures WHERE verb='repair'`). */
  readonly selectRepairRows: () => PendingRepairRow[];
  /** True iff the repo's shared checkout is DIRTY / mid-merge — a DEFER at dispatch time
   *  (no attempt consumed, and no row minted when none exists yet), per the finalize
   *  dirty-degrade precedent. Production reads the `git_status` projection. */
  readonly isDirtyCheckout: (repoDir: string) => boolean;
  /** True iff the repo's shared base reads GREEN — the positive-evidence gate the clear
   *  requires (combined with zero remaining candidates). Anything else (red / unknown /
   *  unseeded) RETAINS the sticky row ("retained on no report"). */
  readonly isBaseGreen: (repoDir: string) => boolean;
  /** Launch ONE `repair::<token>` escalation session for the group (DELEGATES to the
   *  shared {@link dispatchEscalationSession} in production, so the global cap + per-key
   *  occupancy guard apply). Async + fail-open — a SKIP (`at_cap` / `already_live`) mints
   *  nothing so the row re-sweeps. */
  readonly dispatchRepair: (
    group: RepairGroup,
  ) => Promise<EscalationDispatchOutcome>;
  /** Classify the dispatched `repair::<token>` session's outcome (DELEGATES to
   *  {@link classifyEscalationOutcome} over the live `jobs` in production). The human is
   *  paged only on a terminal decline/death; while it is live or unfolded it returns
   *  `{terminal:false}` and the sweep skips (a successful repair unblocks the tasks,
   *  emptying the candidate set so this row reaches the CLEAR pass, not the notify). */
  readonly repairOutcome: (repoToken: string) => ResolverOutcome;
  /** Send the ONE botctl page about a declined/dead `repair::<token>` session. Async +
   *  fail-open — every error degrades to `notify_failed` so the row re-sweeps. */
  readonly notifyHuman: (
    row: PendingRepairRow,
    verdict: "declined" | "died",
  ) => Promise<RepairHumanNotifiedOutcome>;
  /** Mint the sticky repair row (a `DispatchFailed{verb:'repair', id:token,
   *  reason:'shared-base-broken:<fp>', dir:repoDir}`) — the durable latch escalation-brief
   *  reads and the once-page anchor. Idempotent UPSERT (preserves `created_at`). */
  readonly mintRow: (group: RepairGroup) => void;
  /** Mint a `RepairDispatched{outcome}` synthetic event — the fold stamps
   *  `repair_dispatched_at` ONLY on the terminal `dispatched`. */
  readonly mintDispatched: (
    repoToken: string,
    outcome: RepairDispatchOutcome,
  ) => void;
  /** Mint a `RepairHumanNotified{outcome}` synthetic event — the fold stamps
   *  `human_notified_at` ONLY on the terminal `notified`. */
  readonly mintNotified: (
    repoToken: string,
    outcome: RepairHumanNotifiedOutcome,
  ) => void;
  /** Mint a `DispatchCleared{verb:'repair', id:token}` — the positive-evidence clear.
   *  Drops the row + every marker so a fresh breakage re-arms at NULL. */
  readonly clearRow: (repoToken: string) => void;
  /** Warn sink for non-fatal diagnostics. */
  readonly noteLine?: (line: string) => void;
}

/** Deterministic `(epic_id, task_id)` order — the stable total sort the coalesced
 *  representative fingerprint is picked from, so a re-key never flaps. */
function compareRepairCandidate(
  a: RepairCandidate,
  b: RepairCandidate,
): number {
  return (
    a.epic_id.localeCompare(b.epic_id) || a.task_id.localeCompare(b.task_id)
  );
}

/**
 * Run one daemon repair-escalation sweep — the producer for the `SHARED_BASE_BROKEN`
 * incident class. Coalesce every shared-base-broken blocked candidate to one group per
 * repo token (representative = the (repo_dir, fingerprint) of the lexicographically-first
 * candidate), then per token:
 *
 *  - A row with `repair_dispatched_at` set and candidates STILL remaining means the
 *    dispatched repair DECLINED / DIED (a success would have unblocked the tasks, emptying
 *    the group): page the human ONCE via the `human_notified_at` gate, then leave the row
 *    sticky until `retry_dispatch` re-arms it.
 *  - A token with no dispatched repair yet DISPATCHES one `repair::<token>` session (the
 *    global cap + per-key occupancy guard apply via `dispatchRepair`), minting the sticky
 *    latch first when none exists. A DIRTY shared checkout DEFERS — no attempt consumed,
 *    and no row minted when none exists yet.
 *  - A sticky row whose repo token has ZERO remaining candidates AND whose base reads
 *    GREEN is CLEARED on positive evidence (an unknown/red base RETAINS it).
 *
 * NEVER throws — every helper edge degrades to a recorded outcome (mirrors the sibling
 * escalation sweeps). The spawn lives ONLY here in the producer, never reachable from
 * `applyEvent`, so a re-fold never re-fires a launch.
 */
export async function runRepairEscalationSweep(
  deps: RepairEscalationSweepDeps,
): Promise<void> {
  const note = deps.noteLine ?? (() => {});
  let candidates: RepairCandidate[];
  let rows: PendingRepairRow[];
  try {
    candidates = deps.selectCandidates();
  } catch (err) {
    note(
      `# warn: repair-escalation sweep candidate read threw (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  try {
    rows = deps.selectRepairRows();
  } catch (err) {
    note(
      `# warn: repair-escalation sweep row read threw (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  if (candidates.length === 0 && rows.length === 0) return;

  // Coalesce to one group per repo token. The candidates are walked in a stable total
  // order so the representative (repo_dir, fingerprint) is deterministic — a re-key of a
  // token that gains/loses siblings never flaps.
  const groups = new Map<string, RepairGroup>();
  for (const c of [...candidates].sort(compareRepairCandidate)) {
    if (c.repo_token === "" || c.repo_dir === "") continue;
    if (!groups.has(c.repo_token)) {
      groups.set(c.repo_token, {
        repo_token: c.repo_token,
        repo_dir: c.repo_dir,
        fingerprint: c.fingerprint,
      });
    }
  }
  const rowByToken = new Map(rows.map((r) => [r.id, r]));

  // DISPATCH / NOTIFY — one pass over the tokens that still carry a breakage.
  for (const [token, group] of groups) {
    const existing = rowByToken.get(token);
    if (existing != null && existing.repair_dispatched_at != null) {
      // A repair already ran, yet the breakage persists (candidates remain) — it
      // DECLINED / DIED. Page the human ONCE, sequenced behind the session's TERMINAL
      // verdict; the row then stays sticky until `retry_dispatch`.
      if (existing.human_notified_at != null) continue; // already paged
      const outcome = deps.repairOutcome(token);
      if (!outcome.terminal) continue; // still live / job not folded yet
      let result: RepairHumanNotifiedOutcome;
      try {
        result = await deps.notifyHuman(existing, outcome.verdict);
      } catch (err) {
        note(
          `# warn: repair human-notify threw for ${token} (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        result = "notify_failed";
      }
      deps.mintNotified(token, result);
      continue;
    }
    // Not yet dispatched (no row, or a minted-but-undispatched row waiting on a cap slot).
    // A DIRTY shared checkout DEFERS — never launch a write-capable session into a
    // mid-merge/dirty tree, consume no attempt, and mint no row when none exists yet.
    if (deps.isDirtyCheckout(group.repo_dir)) continue;
    if (existing == null) deps.mintRow(group); // the durable latch, minted once
    let outcome: EscalationDispatchOutcome;
    try {
      outcome = await deps.dispatchRepair(group);
    } catch (err) {
      note(
        `# warn: repair dispatch threw for ${token} (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      outcome = "dispatch_failed";
    }
    // A SKIP (`at_cap` / `already_live` / `checkout_busy`) mints nothing — the row
    // persists and re-sweeps. `checkout_busy` is structurally unreachable here (the
    // per-checkout guard only gates the `deconflict` verb), but the shared dispatch
    // outcome type carries it, so this stays exhaustive.
    if (
      outcome === "at_cap" ||
      outcome === "already_live" ||
      outcome === "checkout_busy"
    )
      continue;
    deps.mintDispatched(token, outcome);
  }

  // CLEAR — positive-evidence level-clear. A sticky repair row whose repo token no longer
  // carries ANY shared-base-broken candidate (the breakage is gone) clears IFF the base
  // reads green; an unknown/red base RETAINS the row (never a false clear on no report).
  for (const row of rows) {
    if (groups.has(row.id)) continue; // still broken → owned by the dispatch/notify pass
    if (!deps.isBaseGreen(row.dir ?? "")) continue; // retained on no report / red base
    deps.clearRow(row.id);
  }
}

// ---------------------------------------------------------------------------
// fn-1009 — daemon worktree-merge-conflict close-escalation producer
// ---------------------------------------------------------------------------

// The escalation reason token lives in the dep-free `dispatch-failure-key` leaf
// (the single dispatch-failure vocabulary). Re-exported here so the SQL twin
// `selectPendingMergeEscalations` and `keeper query` keep importing it from
// `daemon`. The gate matches the leading token EXACTLY — never a `worktree-merge`
// prefix — so `worktree-merge-lock-timeout` / `-local-timeout` and the
// `worktree-finalize-*` / `worktree-recover*` siblings never escalate.
export { MERGE_ESCALATION_REASON_TOKEN };

/**
 * A sticky `worktree-merge-conflict` close failure row — the merge-escalation
 * sweep's current-state working set, read straight off `dispatch_failures`
 * (bounded by the number of concurrently-stuck closes, never a history scan). The
 * `id` is the close-row key (the epic id; `verb` is always `close`).
 */
export interface PendingMergeEscalation {
  /** The sticky close-row `dispatch_failures.id` (the epic id; verb is `close`). */
  id: string;
  /** The close failure reason — the `worktree-merge-conflict: …` string to parse. */
  reason: string;
  /** The close row's `dir` — the repo root, for {@link mergeConflictBaseCheckout}. */
  dir: string | null;
}

/** The outcome the deconflict-dispatch sweep records on the `MergeEscalationAttempted`
 *  event. The TERMINAL `dispatched` (the `deconflict::<epic>` session launched) stamps
 *  the `merge_escalated_at` once-marker (task .1's fold); `dispatch_failed` is
 *  NON-terminal — the row stays re-sweepable. */
export type MergeEscalationOutcome = "dispatched" | "dispatch_failed";

/** The outcome the deconflict human-notify sweep (stage 3) records on the
 *  `MergeHumanNotified` event. The TERMINAL `notified` (the one botctl notification
 *  was delivered) stamps the `human_notified_at` once-marker; `notify_failed` is
 *  NON-terminal — the row stays re-sweepable so the next tick retries. */
export type MergeHumanNotifiedOutcome = "notified" | "notify_failed";

/** The result of one shared-helper escalation dispatch. `dispatched` /
 *  `dispatch_failed` are the two MINT outcomes ({@link MergeEscalationOutcome});
 *  `at_cap` (the global concurrency cap is saturated), `already_live` (a
 *  `<verb>::<id>` session is already running, i.e. the mint fold has not caught up),
 *  and `checkout_busy` (a DIFFERENT merge-recreating escalation session already holds
 *  the resolved base checkout) are SKIP outcomes — no marker is minted and the row
 *  re-sweeps next tick. */
export type EscalationDispatchOutcome =
  | MergeEscalationOutcome
  | "at_cap"
  | "already_live"
  | "checkout_busy";

/** Global cap on concurrent escalation sessions (`unblock::` + `deconflict::`
 *  combined). At cap the dispatch is SKIPPED — the row stays pending and re-sweeps —
 *  so a board with many stuck escalations never fans out an unbounded number of
 *  sessions. A coarse safety valve read off the live jobs projection (plus the
 *  producer's not-yet-folded in-flight memo). */
export const MAX_LIVE_ESCALATION_SESSIONS = 3;

/** TTL (ms) for the producer's in-flight escalation memo — a launched-but-not-yet-folded
 *  `<verb>::<id>` key is pruned once its `jobs` row folds OR it ages past this ceiling
 *  (a launch that reported `ok` but never folded a jobs row), so the memo can never
 *  wedge a cap slot forever. Well above the launch → birth-ingest fold lag. */
export const INFLIGHT_ESCALATION_TTL_MS = 5 * 60_000;

/**
 * Select every sticky `worktree-merge-conflict` close failure that has NOT yet been
 * escalated. Reads `dispatch_failures` on the passed connection — production passes
 * MAIN's writable connection so the read is sequenced inside the same writer that
 * mints. The token filter is the SQL twin of {@link shouldEscalateMergeConflict}:
 * the leading token (text up to the FIRST `:`) must be EXACTLY
 * {@link MERGE_ESCALATION_REASON_TOKEN}, so a `worktree-merge-lock-timeout` /
 * `worktree-merge-local-timeout` / `worktree-finalize-non-fast-forward` /
 * `worktree-recover*` row never matches. `merge_escalated_at IS NULL` is the
 * escalate-once gate — a stamped row (the terminal escalation fold) drops out.
 *
 * `resolver_dispatched_at IS NOT NULL` sequences the escalation BEHIND the resolver:
 * the sibling resolver-dispatch sweep owns the conflict first, so a row whose resolver
 * has not yet been dispatched (a fresh row, a paused board, or the window after a
 * `retry_dispatch` re-armed both markers at NULL) is NOT escalatable — the human
 * notify waits. A dispatched-but-still-running resolver is filtered downstream in the
 * sweep by its terminal-outcome check ({@link classifyResolverOutcome}); this SQL gate
 * only rules out the not-yet-dispatched case cheaply off the durable column.
 */
export function selectPendingMergeEscalations(
  db: Database,
): PendingMergeEscalation[] {
  return db
    .query(
      `SELECT id, reason, dir FROM dispatch_failures
         WHERE verb = 'close'
           AND merge_escalated_at IS NULL
           AND resolver_dispatched_at IS NOT NULL
           AND reason IS NOT NULL
           AND instr(reason, ':') > 0
           AND substr(reason, 1, instr(reason, ':') - 1) = ?`,
    )
    .all(MERGE_ESCALATION_REASON_TOKEN) as PendingMergeEscalation[];
}

/**
 * Load the `resolve::<epic>` job rows for `epicId` into the map shape {@link
 * classifyResolverOutcome} reads — the deconflict-dispatch sweep's terminal-resolver
 * probe. Bounded (a handful of rows per epic on the `plan_verb='resolve'` partial
 * index), selecting only the columns the turn-active arm touches. A jobs read failure
 * degrades to an EMPTY map, which classifies as `{terminal:false}` so the escalation
 * conservatively WAITS (never a premature dispatch on a transient error).
 *
 * `instance` scopes the read to the CURRENT block instance (the sticky close row's
 * `instance_event_id`, which task .2 stamps onto the resolve session's
 * `escalation_instance`) so a stale resolve row from a RESOLVED instance can neither
 * suppress nor prematurely mark terminal a re-block's sequencing. The predicate is
 * `escalation_instance = ?instance OR escalation_instance IS NULL` — NULL-stamped rows
 * (the corroboration-miss edge) are conservatively INCLUDED so a stamp-missed resolver
 * can still classify rather than wait forever. A NULL `instance` (absent sticky /
 * legacy caller) falls back to the unscoped verb+ref match. Module-level twin of
 * {@link resolveEscalationJobsFor}.
 */
function resolveJobsForEpic(
  db: Database,
  epicId: string,
  instance: number | null,
): Map<string, Job> {
  const jobs = new Map<string, Job>();
  try {
    const rows =
      instance == null
        ? (db
            .query(
              "SELECT job_id, plan_verb, plan_ref, state, backend_exec_pane_id, escalation_instance FROM jobs WHERE plan_verb = 'resolve' AND plan_ref = ?",
            )
            .all(epicId) as unknown as Job[])
        : (db
            .query(
              "SELECT job_id, plan_verb, plan_ref, state, backend_exec_pane_id, escalation_instance FROM jobs WHERE plan_verb = 'resolve' AND plan_ref = ? AND (escalation_instance = ? OR escalation_instance IS NULL)",
            )
            .all(epicId, instance) as unknown as Job[]);
    for (const row of rows) {
      jobs.set(row.job_id, row);
    }
  } catch {
    // Transient jobs read failure → empty map → terminal:false → wait next tick.
  }
  return jobs;
}

/**
 * The escalation gate: escalate IFF the reason's leading token (the text up to the
 * first `:`) is EXACTLY {@link MERGE_ESCALATION_REASON_TOKEN}. Routes through the
 * `dispatch-failure-key` leaf's {@link isMergeEscalationReason} so this gate and the
 * row router can never diverge — defense-in-depth over {@link
 * selectPendingMergeEscalations}'s SQL filter (re-applied per row in the sweep).
 * Pure; never throws; null/colon-less reason → false. The exact-token match keeps
 * the `worktree-merge-lock-timeout` / `worktree-merge-local-timeout` /
 * `worktree-finalize-non-fast-forward` / `worktree-recover*` siblings OUT.
 */
export function shouldEscalateMergeConflict(reason: string | null): boolean {
  if (reason == null) return false;
  return isMergeEscalationReason(reason);
}

/**
 * Parse the `<source>` + `<base>` branches out of a
 * `worktree-merge-conflict: merging <source> into <base> — <stderr>` reason. Splits
 * on the FIRST ` — ` em-dash (so a stderr that happens to contain one can't poison
 * the branch parse), then lifts `<source>` / `<base>` from the head via
 * `merging … into …`. Returns null on any structural miss — the body builder
 * degrades a parse-miss to a human-actionable brief rather than throwing the sweep.
 * Pure.
 */
function parseMergeConflictReason(
  reason: string,
): { source: string; base: string } | null {
  const dash = reason.indexOf(" — ");
  const head = dash >= 0 ? reason.slice(0, dash) : reason;
  const m = head.match(
    /^\s*worktree-merge-conflict:\s*merging\s+(\S.*?)\s+into\s+(\S.*?)\s*$/,
  );
  if (m == null) return null;
  return { source: m[1], base: m[2] };
}

/**
 * The checkout directory where a merge-conflict reason's BASE branch lives — the cwd
 * where finalize ran the failing merge, so the conflict physically sits there. A
 * `keeper/epic/…` lane base (a rib fan-in into the epic lane) resolves to its worktree
 * lane; the DEFAULT-branch base (a lane→default finalize, e.g. `main`) is NEVER laned,
 * so it resolves to the repo root itself — the shared default checkout `mergeBranchInto`
 * lands in. Passing the default branch to {@link worktreePathFor} would fabricate a
 * nonexistent `<repo>--<default>` dir, and the launch would then ENOENT on the cwd (the
 * whole escalation ladder wedges — the resolver never dispatches, so the human is never
 * paged). Pure.
 */
export function mergeConflictBaseCheckout(
  repoDir: string,
  base: string,
): string {
  return base.startsWith("keeper/epic/")
    ? worktreePathFor(repoDir, base)
    : repoDir;
}

/** Injectable dependency surface for {@link runMergeEscalationSweep} — the daemon's
 *  DECONFLICT-DISPATCH sweep (stage 2). Mirrors {@link ResolverDispatchSweepDeps}'s
 *  fail-open injectable-deps discipline so the producer is testable with synthetic
 *  rows + an injected dispatcher, and never throws into the daemon loop. */
export interface MergeEscalationSweepDeps {
  /** The current-state pending working set (DELEGATES to
   *  {@link selectPendingMergeEscalations} in production). */
  readonly selectPending: () => PendingMergeEscalation[];
  /** Re-read that the sticky close row for `id` is STILL present with
   *  `merge_escalated_at IS NULL` — checked immediately before the launch to narrow
   *  the clear-mid-sweep window (a `retry_dispatch` between select and launch drops
   *  the row). Reads the live projection on the writable connection in production. */
  readonly stillPending: (id: string) => boolean;
  /** Classify the dispatched `resolve::<epic>` resolver's outcome for `id`
   *  (DELEGATES to {@link classifyResolverOutcome} over the live `jobs` map in
   *  production). The deconflict dispatches only after a TERMINAL resolver verdict;
   *  while the resolver is live or its job has not folded yet it returns
   *  `{terminal:false}` and the sweep skips the row (the resolver, tier 1, owns the
   *  conflict first). */
  readonly resolverOutcome: (id: string) => ResolverOutcome;
  /** Launch ONE `deconflict::<epic>` escalation session for the sticky row (into the
   *  managed session, at the escalation model/effort, with the `/plan:deconflict`
   *  prompt). DELEGATES to the shared {@link dispatchEscalationSession} in production,
   *  so the global cap + per-key occupancy guard apply. Async + fail-open — every
   *  error degrades to `dispatch_failed`, and a SKIP (`at_cap` / `already_live`) mints
   *  nothing so the row re-sweeps. */
  readonly dispatchDeconflict: (
    row: PendingMergeEscalation,
  ) => Promise<EscalationDispatchOutcome>;
  /** Mint a `MergeEscalationAttempted{outcome}` synthetic event. Task .1's fold stamps
   *  `merge_escalated_at` ONLY on the terminal `dispatched`; it NEVER clears the sticky
   *  row — only `retry_dispatch` (`DispatchCleared`) does. */
  readonly mintAttempted: (id: string, outcome: MergeEscalationOutcome) => void;
  /** Warn sink for non-fatal diagnostics. */
  readonly noteLine?: (line: string) => void;
}

/**
 * Run one daemon deconflict-dispatch sweep (stage 2) — the producer half of the
 * dispatch-once loop for a stuck worktree fan-in close whose tier-1 resolver has
 * DECLINED or DIED. Walk the sticky `worktree-merge-conflict` close rows, gate each by
 * {@link shouldEscalateMergeConflict} (defense-in-depth over the selector's SQL
 * filter), re-read that the row is STILL pending immediately before the launch
 * (narrowing the clear-mid-sweep window), sequence behind the resolver's TERMINAL
 * verdict, then launch ONE `deconflict::<epic>` session and mint
 * `MergeEscalationAttempted{outcome}`.
 *
 * DISPATCHES ONLY — the sweep NEVER mints `DispatchCleared` and never clears the
 * sticky row; only `retry_dispatch` does (a successful deconflict session fires it on
 * the clear path, dropping the row and every marker with it, so stage 3 never runs).
 * The TERMINAL `dispatched` stamps the `merge_escalated_at` once-marker (task .1's
 * fold), so the next sweep's selector drops the row; a `dispatch_failed` leaves the
 * marker NULL so the row stays re-sweepable, and a SKIP (`at_cap` / `already_live`)
 * mints nothing at all. Each close failure keys on its own epic (`close::<epic>`), so
 * there is one row per epic and no coalescing is needed. NEVER throws — every helper
 * edge degrades to a recorded outcome (mirrors {@link runResolverDispatchSweep}). The
 * spawn lives ONLY here in the producer, never reachable from `applyEvent`, so a
 * re-fold never re-fires a launch.
 */
export async function runMergeEscalationSweep(
  deps: MergeEscalationSweepDeps,
): Promise<void> {
  const note = deps.noteLine ?? (() => {});
  let pending: PendingMergeEscalation[];
  try {
    pending = deps.selectPending();
  } catch (err) {
    note(
      `# warn: deconflict-dispatch sweep read threw (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  if (pending.length === 0) return;

  for (const row of pending) {
    // Defense-in-depth gate: the selector already filters by the exact token, but
    // re-apply the pure gate so an injected/loosened selector can never dispatch a
    // deconflict session for a non-merge-conflict reason.
    if (!shouldEscalateMergeConflict(row.reason)) continue;
    // Re-read immediately before the launch: a `retry_dispatch` that cleared the row
    // (or the fold that stamped the marker) between select and launch means there is
    // nothing left to deconflict — skip without minting.
    if (!deps.stillPending(row.id)) continue;
    // Sequence behind the resolver (tier 1): the sibling resolver-dispatch sweep owns
    // the conflict first (the selector already required `resolver_dispatched_at`), so
    // the deconflict dispatch waits until that resolver reaches a TERMINAL outcome.
    // While it is live — or its job has not folded yet (the launch window) — skip
    // without minting, so the row re-sweeps next tick. `retry_dispatch` re-arms the
    // whole flow by deleting the row.
    if (!deps.resolverOutcome(row.id).terminal) continue;

    let outcome: EscalationDispatchOutcome;
    try {
      outcome = await deps.dispatchDeconflict(row);
    } catch (err) {
      // The dispatcher is fail-open by contract; this catch is defense-in-depth so a
      // surprise throw still records a non-terminal outcome and never aborts the sweep.
      note(
        `# warn: deconflict dispatch threw for ${row.id} (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      outcome = "dispatch_failed";
    }
    // A SKIP (`at_cap` / `already_live` / `checkout_busy`) mints nothing: the marker
    // stays NULL and the row re-sweeps next tick (at cap, once the in-flight session
    // folds, or once the occupied base checkout frees). Only a real dispatch attempt
    // (`dispatched` / `dispatch_failed`) mints — the fold stamps the once-marker ONLY
    // on the terminal `dispatched`, so a `dispatch_failed` folds to a no-op and the row
    // stays re-sweepable.
    if (
      outcome === "at_cap" ||
      outcome === "already_live" ||
      outcome === "checkout_busy"
    ) {
      continue;
    }
    deps.mintAttempted(row.id, outcome);
  }
}

// ---------------------------------------------------------------------------
// fn-1129 — daemon deconflict human-notify sweep (stage 3)
// ---------------------------------------------------------------------------
//
// The TERMINAL stage of the deconflict escalation path. Where stage 2
// (`runMergeEscalationSweep`) DISPATCHES a `deconflict::<epic>` session once its
// tier-1 resolver declined/died, this sweep fires the ONE human notification — via
// botctl — only once that deconflict session ALSO declines or dies. A successful
// deconflict ends with its own `keeper autopilot retry close::<epic>`, which drops the
// sticky row and every marker with it, so this sweep never sees a resolved close.

/**
 * Select every sticky `worktree-merge-conflict` close failure whose deconflict session
 * has been DISPATCHED (`merge_escalated_at IS NOT NULL`) but whose human has NOT yet
 * been notified (`human_notified_at IS NULL`) — the stage-3 working set. The SQL twin
 * of {@link selectPendingMergeEscalations}, gated on the THIRD once-marker. The
 * leading-token filter is identical (exact {@link MERGE_ESCALATION_REASON_TOKEN}), so a
 * non-merge-conflict sibling never matches. A stamped `human_notified_at` (the terminal
 * `notified` fold) drops the row out — the notify-once guarantee. `retry_dispatch`
 * re-arms the whole chain by deleting the row (all three markers back to NULL).
 */
export function selectPendingHumanNotifications(
  db: Database,
): PendingMergeEscalation[] {
  return db
    .query(
      `SELECT id, reason, dir FROM dispatch_failures
         WHERE verb = 'close'
           AND merge_escalated_at IS NOT NULL
           AND human_notified_at IS NULL
           AND reason IS NOT NULL
           AND instr(reason, ':') > 0
           AND substr(reason, 1, instr(reason, ':') - 1) = ?`,
    )
    .all(MERGE_ESCALATION_REASON_TOKEN) as PendingMergeEscalation[];
}

/**
 * Build the ONE structured operator notification the deconflict human-notify sweep
 * sends over botctl when a `deconflict::<epic>` session DECLINES (stamped BLOCKED) or
 * DIES. Short by design — the sticky close row already carries the full context on the
 * board (`keeper status`); this is the courtesy ping that names the epic, the verdict,
 * and the single unstick command. The free-text reason is trimmed onto its own line
 * (it rides as a botctl argv element via an array-form spawn, never a shell string, so
 * no interpolation fires). Pure.
 */
export function buildDeconflictHumanNotifyBody(args: {
  epicId: string;
  reason: string;
  verdict: "declined" | "died";
}): string {
  const epic = args.epicId;
  const verdictLine =
    args.verdict === "died"
      ? `its job DIED before resolving`
      : `it DECLINED (not mechanically clear — stamped BLOCKED)`;
  return [
    `🔴 keeper: deconflict::${epic} needs you — the autonomous merge-resolver AND the`,
    `deconflict escalation session both gave up on \`close::${epic}\` (${verdictLine});`,
    `the worktree fan-in close is STUCK and will NOT auto-retry.`,
    ``,
    `Resolve the conflict by hand in the epic's base worktree (merge BOTH intents,`,
    `never pick one side), then unstick the board:`,
    `  keeper autopilot retry close::${epic}`,
    ``,
    `Failure reason: ${args.reason.trim()}`,
  ].join("\n");
}

/** Injectable dependency surface for {@link runDeconflictHumanNotifySweep} — the
 *  stage-3 human-notify sweep. Same fail-open injectable-deps discipline as
 *  {@link MergeEscalationSweepDeps}. */
export interface DeconflictHumanNotifySweepDeps {
  /** The current-state pending working set (DELEGATES to
   *  {@link selectPendingHumanNotifications} in production). */
  readonly selectPending: () => PendingMergeEscalation[];
  /** Re-read that the sticky close row for `id` is STILL present with
   *  `human_notified_at IS NULL` — checked immediately before the notify to narrow the
   *  clear-mid-sweep window (a `retry_dispatch` between select and notify drops the
   *  row). Reads the live projection on the writable connection in production. */
  readonly stillPending: (id: string) => boolean;
  /** Classify the dispatched `deconflict::<epic>` session's outcome for `id`
   *  (DELEGATES to {@link classifyEscalationOutcome} over the live `jobs` map in
   *  production). The human is notified ONLY on a terminal verdict; while the deconflict
   *  session is live or its job has not folded yet it returns `{terminal:false}` and the
   *  sweep skips the row (a successful deconflict clears the sticky before this runs). */
  readonly deconflictOutcome: (id: string) => ResolverOutcome;
  /** Send the ONE botctl notification about the declined/dead deconflict session.
   *  Async + fail-open — every error degrades to `notify_failed` so the row re-sweeps
   *  (the sticky stays operator-visible meanwhile), never a wedge or a silent drop. */
  readonly notifyHuman: (
    row: PendingMergeEscalation,
    verdict: "declined" | "died",
  ) => Promise<MergeHumanNotifiedOutcome>;
  /** Mint a `MergeHumanNotified{outcome}` synthetic event. The fold stamps
   *  `human_notified_at` ONLY on the terminal `notified`; it NEVER clears the sticky
   *  row — only `retry_dispatch` (`DispatchCleared`) does. */
  readonly mintAttempted: (
    id: string,
    outcome: MergeHumanNotifiedOutcome,
  ) => void;
  /** Warn sink for non-fatal diagnostics. */
  readonly noteLine?: (line: string) => void;
}

/**
 * Run one daemon deconflict human-notify sweep (stage 3) — the terminal "notify the
 * human ONCE" half of the deconflict escalation path. Walk the sticky
 * `worktree-merge-conflict` close rows whose deconflict session was dispatched but
 * whose human is not yet notified, gate each by {@link shouldEscalateMergeConflict}
 * (defense-in-depth), re-read that the row is STILL pending, sequence behind the
 * deconflict session's TERMINAL decline/death, send ONE botctl notification, then mint
 * `MergeHumanNotified{outcome}`.
 *
 * NOTIFIES ONCE — the sweep NEVER clears the sticky row; only `retry_dispatch` does. A
 * TERMINAL `notified` stamps the `human_notified_at` once-marker, so the next sweep's
 * selector drops the row; a `notify_failed` (botctl absent / failed) leaves the marker
 * NULL so the row re-sweeps and the notification is never lost (the sticky is
 * operator-visible the whole time). NEVER throws — every helper edge degrades to a
 * recorded outcome. The spawn lives ONLY here in the producer, never reachable from
 * `applyEvent`.
 */
export async function runDeconflictHumanNotifySweep(
  deps: DeconflictHumanNotifySweepDeps,
): Promise<void> {
  const note = deps.noteLine ?? (() => {});
  let pending: PendingMergeEscalation[];
  try {
    pending = deps.selectPending();
  } catch (err) {
    note(
      `# warn: deconflict human-notify sweep read threw (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  if (pending.length === 0) return;

  for (const row of pending) {
    if (!shouldEscalateMergeConflict(row.reason)) continue;
    // Re-read immediately before the notify: a `retry_dispatch` that cleared the row
    // (or the fold that stamped the marker) between select and notify means there is
    // nothing left to notify — skip without minting.
    if (!deps.stillPending(row.id)) continue;
    // Sequence behind the deconflict session: notify the human only once that session
    // reached a TERMINAL decline/death. While it is live — or its job has not folded
    // yet — skip without minting, so the row re-sweeps next tick. A CLEAR deconflict
    // fires `retry_dispatch`, deleting the row before this sweep ever sees it.
    const outcome = deps.deconflictOutcome(row.id);
    if (!outcome.terminal) continue;

    let result: MergeHumanNotifiedOutcome;
    try {
      result = await deps.notifyHuman(row, outcome.verdict);
    } catch (err) {
      // The helper is fail-open by contract; this catch is defense-in-depth so a
      // surprise throw still records a non-terminal outcome and never aborts the sweep.
      note(
        `# warn: deconflict human-notify threw for ${row.id} (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      result = "notify_failed";
    }
    // Mint the attempt regardless of outcome: the fold stamps the once-marker ONLY on a
    // terminal `notified`, so a `notify_failed` folds to a no-op and the row re-sweeps.
    deps.mintAttempted(row.id, result);
  }
}

// ---------------------------------------------------------------------------
// fn-1088 — daemon resolver-dispatch producer (the merge-resolver worker)
// ---------------------------------------------------------------------------
//
// A SIBLING of the merge-escalation sweep above, riding the SAME sticky
// `worktree-merge-conflict` close rows. Where the merge-escalation sweep NOTIFIES a
// human (`planner@<epic>`) once, this sweep DISPATCHES one autonomous `resolve::<epic>`
// worker once — a narrower-authority automation that resolves ONLY mechanically-clear
// conflicts and stamps BLOCKED for anything state-machine / schema / security /
// transaction-boundary shaped. Each latches on its own `dispatch_failures` column, but
// the resolver goes FIRST: the human escalation is SEQUENCED behind it — the notify fires
// only after a resolver was dispatched AND reached a terminal verdict (declined/BLOCKED or
// job death), so the two never race the same base worktree. The close audit is unchanged
// whichever path resolves.

/** The outcome the resolver-dispatch producer records on the `ResolverDispatchAttempted`
 *  event. The TERMINAL `dispatched` (the `resolve::<epic>` worker launched) stamps the
 *  `resolver_dispatched_at` once-marker (the reducer fold); `dispatch_failed` is
 *  NON-terminal — the row stays re-sweepable. */
export type ResolverDispatchOutcome = "dispatched" | "dispatch_failed";

/** What one resolver-dispatch attempt resolves to. `dispatched` / `dispatch_failed` are
 *  the two MINT outcomes ({@link ResolverDispatchOutcome}); `checkout_busy` is a SKIP —
 *  a DIFFERENT merge-recreating escalation session already holds the resolved base
 *  checkout, so no marker is minted and the row re-sweeps once the checkout frees
 *  (sibling of the shared dispatch path's {@link EscalationDispatchOutcome} skips). */
export type ResolverDispatchResult = ResolverDispatchOutcome | "checkout_busy";

/**
 * A sticky `worktree-merge-conflict` close failure that has NOT yet had a resolver
 * dispatched — the resolver-dispatch sweep's current-state working set, read straight
 * off `dispatch_failures` (bounded by the number of concurrently-stuck closes, never a
 * history scan). The `id` is the close-row key (the epic id; `verb` is always `close`).
 */
export interface PendingResolverDispatch {
  /** The sticky close-row `dispatch_failures.id` (the epic id; verb is `close`). */
  id: string;
  /** The close failure reason — the `worktree-merge-conflict: …` string to parse. */
  reason: string;
  /** The close row's `dir` — the repo root, for {@link mergeConflictBaseCheckout}. */
  dir: string | null;
}

/**
 * Select every sticky `worktree-merge-conflict` close failure that has NOT yet had a
 * resolver dispatched. The SQL twin of {@link selectPendingMergeEscalations}, gated on
 * `resolver_dispatched_at IS NULL` (its own once-latch, INDEPENDENT of
 * `merge_escalated_at` — a row can be human-escalated AND resolver-dispatched, in
 * either order). The leading-token filter is identical: the text up to the FIRST `:`
 * must be EXACTLY {@link MERGE_ESCALATION_REASON_TOKEN}, so a `worktree-merge-lock-timeout`
 * / `-local-timeout` / `worktree-finalize-non-fast-forward` / `worktree-recover*` row
 * never matches. A stamped row (the terminal `dispatched` fold) drops out — the
 * once-per-condition guarantee.
 */
export function selectPendingResolverDispatches(
  db: Database,
): PendingResolverDispatch[] {
  return db
    .query(
      `SELECT id, reason, dir FROM dispatch_failures
         WHERE verb = 'close'
           AND resolver_dispatched_at IS NULL
           AND reason IS NOT NULL
           AND instr(reason, ':') > 0
           AND substr(reason, 1, instr(reason, ':') - 1) = ?`,
    )
    .all(MERGE_ESCALATION_REASON_TOKEN) as PendingResolverDispatch[];
}

/**
 * Build the autonomous resolver brief the resolver-dispatch producer spawns as the
 * `resolve::<epic>` worker's prompt. The ACTIVE sibling of {@link
 * buildMergeEscalationBody} (which briefs a HUMAN): same source/base parse + `--no-ff`
 * recreate recipe + verbatim guardrail classes, but framed as a worker that CLASSIFIES
 * then resolves-or-BLOCKS with authority deliberately narrower than a human's.
 *
 * The decision boundary is encoded from this session's three mechanically-clear
 * exemplars (an install-script fan-in, a CLI help-block fan-in, a skill/doc-section
 * fan-in): a conflict is CLEAR only when both sides are INDEPENDENT ADDITIVE edits to
 * the same region that compose by keeping BOTH intents verbatim; it is NOT CLEAR the
 * moment the two sides encode a shared DECISION (a state machine, a schema, a security
 * posture, a transaction boundary, an ordering/precedence choice) where keeping both
 * would be incoherent. Unsure DEFAULTS to BLOCKED — a confident-but-wrong merge is
 * worse than a stuck close.
 *
 * The CLEAR path resolves preserving both intents, runs the epic's test gate within a
 * bounded budget, commits the merge, then `keeper autopilot retry close::<epic>` (which
 * clears the sticky, dropping BOTH once-markers). The NOT-CLEAR path aborts to a clean
 * lane, stamps BLOCKED with category + evidence + the literal unstick sentence, and
 * leaves the sticky + human escalation exactly as today. The brief NO LONGER pauses/
 * plays autopilot: the recover sweep is excluded per-epic while this worker's
 * `resolve::<epic>` job is live (`epicHasActiveResolver`), so a crash never durably
 * pauses the board and concurrent resolvers never race on a shared global flag. A
 * parse-miss (or missing repo dir) DEGRADES to a still-actionable brief — this producer
 * never throws on a reason it can't parse. Pure.
 */
export function buildResolverBrief(args: {
  epicId: string;
  reason: string;
  repoDir: string | null;
}): string {
  const epic = args.epicId;
  const parsed = parseMergeConflictReason(args.reason);
  const hasRepo = args.repoDir != null && args.repoDir !== "";
  const unstick = `to proceed, tell me exactly: whether to keep both sides, pick one, or how to reconcile them`;
  const guardrail = [
    `INTENT ARCHAEOLOGY — before you classify, read the PRIMARY SOURCES behind each`,
    `side, not just the conflict-marker diff text. For each conflicting commit, read`,
    `its commit message (\`git show\`/\`git log\` the conflicting shas) and run`,
    `\`keeper find-file-history <path>\` / \`keeper search-history <term>\` to recover`,
    `WHY each change was made. Ground your classification in each side's INTENT — the`,
    `diff alone hides whether two edits are independent or encode one shared decision.`,
    ``,
    `GUARDRAIL — your authority is narrower than a human's. Resolve ONLY a`,
    `MECHANICALLY-CLEAR conflict: both sides are INDEPENDENT ADDITIVE edits to the`,
    `same region (e.g. an install-script fan-in gaining two idempotent steps, a CLI`,
    `help-block gaining two entries, a skill/doc section gaining two bullets) that`,
    `compose by keeping BOTH intents verbatim. The moment the two sides encode a`,
    `shared DECISION — a state machine, a schema, a security posture, a`,
    `transaction-boundary, or an ordering/precedence choice — where keeping both would`,
    `be incoherent, it is NOT clear. When UNSURE, default to BLOCKED. A`,
    `confident-but-wrong merge is worse than a stuck close.`,
    ``,
    `SCHEMA-VERSION COLLISION CARVE-OUT — if the conflict is two lanes' SCHEMA_STEPS`,
    `entries colliding on the same version number, run`,
    `\`bun scripts/rebase-schema-migration.ts\` instead of hand-editing: the tool`,
    `exiting 0 is mechanically clear — commit its rewritten output. A tool REFUSAL,`,
    `or any schema SHAPE decision (what a column means, whether a rewind is right, a`,
    `CREATE-literal conflict), is NOT clear — stays BLOCKED for the human exactly as`,
    `today.`,
    ``,
    `Do NOT invent new behaviour — resolve by composing the two intents VERBATIM or`,
    `not at all. If a coherent merge would require writing anything NEITHER side wrote,`,
    `it is NOT mechanically clear: default to BLOCKED.`,
  ];
  const blockedPath = [
    `IF NOT mechanically clear (or you are unsure):`,
    `  - \`git merge --abort\` to leave the lane CLEAN (the recover pass covers any`,
    `    residue); do NOT commit a half-merge.`,
    `  - Stamp BLOCKED with: the guardrail CATEGORY (state-machine / schema / security /`,
    `    transaction-boundary / ordering / unsure), the EVIDENCE (the conflicting`,
    `    hunks + why keeping both is incoherent), and the literal unstick sentence:`,
    `    \`${unstick}\``,
    `  - EXIT. Leave the sticky close row and the human escalation exactly as they`,
    `    are — the human resolves it. (Do NOT pause/play autopilot — the daemon`,
    `    scopes recovery around you; see above.)`,
  ];
  if (parsed == null || !hasRepo) {
    // Parse-miss / no repo dir → a still-actionable brief, never a throw.
    return [
      `You are the autopilot merge-resolver for epic ${epic}. A worktree fan-in close`,
      `is STUCK on a merge conflict (\`close::${epic}\`). Recreate it, classify it, and`,
      `resolve it ONLY if it is mechanically clear — otherwise stamp BLOCKED and leave`,
      `it for the human.`,
      ``,
      `Do NOT \`keeper autopilot pause\` — the daemon holds a per-epic recover`,
      `exclusion for as long as THIS worker is live, so the recover sweep will not`,
      `race your merge and the rest of the board keeps moving. A global pause would`,
      `needlessly halt every unrelated epic.`,
      ``,
      `Open the epic's base worktree, RE-RUN the failed \`git merge --no-ff <source>\``,
      `(NOT \`--squash\` or rebase — a single-parent commit re-conflicts on the next`,
      `fan-in) to recreate the conflict markers, then:`,
      ``,
      ...guardrail,
      ``,
      `IF mechanically clear: resolve merging BOTH intents (never pick one side and`,
      `drop the other), run the epic's tests/build within a bounded budget (passing`,
      `tests are necessary, not sufficient), commit the merge commit, then unstick the`,
      `board: \`keeper autopilot retry close::${epic}\`, then EXIT (no \`play\` — you never paused).`,
      ``,
      ...blockedPath,
      ``,
      `Failure reason:`,
      args.reason.trim(),
    ].join("\n");
  }
  // The checkout where finalize ran the failing merge, for the worker's `cd`: a
  // default-branch base resolves to the repo root (the shared default checkout, never
  // laned), a `keeper/epic/…` lane base to its worktree.
  const worktree = mergeConflictBaseCheckout(
    args.repoDir as string,
    parsed.base,
  );
  return [
    `You are the autopilot merge-resolver for epic ${epic}. A worktree fan-in close is`,
    `STUCK on a merge conflict (\`close::${epic}\`) — the base worktree's merge was`,
    `aborted CLEAN and the sticky close row is staged for retry. Recreate the conflict,`,
    `classify it, and resolve it ONLY if it is mechanically clear.`,
    ``,
    `Do NOT \`keeper autopilot pause\` — the daemon holds a per-epic recover exclusion`,
    `for as long as THIS worker is live, so the recover sweep will not race your merge`,
    `and the rest of the board keeps moving. A global pause would needlessly halt every`,
    `unrelated epic; it also strands the board if you crash before playing.`,
    ``,
    `  1. cd ${worktree}`,
    `  2. git merge --no-ff ${parsed.source}`,
    `     (NOT \`--squash\` or rebase — a single-parent commit re-conflicts on the next`,
    `     fan-in; \`--no-ff\` makes ${parsed.source} an ancestor so the retry merge`,
    `     no-ops. The base worktree is left CLEAN after the abort, so RE-RUN the merge`,
    `     to recreate the conflict markers.)`,
    `  3. Classify the conflict:`,
    ``,
    ...guardrail,
    ``,
    `  4a. IF mechanically clear: resolve merging BOTH intents — never pick one side`,
    `      and drop the other. Run the epic's tests/build within a bounded budget`,
    `      (passing tests are necessary, not sufficient). Commit the merge commit, then`,
    `      verify \`git branch --contains ${parsed.source}\` lists the base branch.`,
    `      Unstick the board and EXIT (no \`play\` — you never paused):`,
    `        keeper autopilot retry close::${epic}`,
    ``,
    `  4b. ${blockedPath[0]}`,
    ...blockedPath.slice(1).map((line) => `      ${line}`),
    ``,
    `Failure reason:`,
    args.reason.trim(),
  ].join("\n");
}

/** Injectable dependency surface for {@link runResolverDispatchSweep}. Mirrors
 *  {@link MergeEscalationSweepDeps}'s fail-open injectable-deps discipline so the
 *  producer is testable with synthetic rows + an injected dispatcher, and never throws
 *  into the daemon loop. */
export interface ResolverDispatchSweepDeps {
  /** The current-state pending working set (DELEGATES to
   *  {@link selectPendingResolverDispatches} in production). */
  readonly selectPending: () => PendingResolverDispatch[];
  /** Re-read that the sticky close row for `id` is STILL present with
   *  `resolver_dispatched_at IS NULL` — checked immediately before the launch to narrow
   *  the clear-mid-sweep window (a `retry_dispatch` between select and launch drops the
   *  row). Reads the live projection on the writable connection in production. */
  readonly stillPending: (id: string) => boolean;
  /** Launch ONE `resolve::<epic>` worker for the sticky row (into the epic lane, with
   *  the resolver brief as its prompt). Async + fail-open — every error degrades to
   *  `dispatch_failed`, never throws into the sweep. Returns the `checkout_busy` SKIP
   *  when the resolved base checkout is already held by a live merge-recreating
   *  escalation session, so the sweep re-sweeps it without minting. */
  readonly dispatchResolver: (
    row: PendingResolverDispatch,
  ) => Promise<ResolverDispatchResult>;
  /** Mint a `ResolverDispatchAttempted{outcome}` synthetic event. The fold stamps
   *  `resolver_dispatched_at` ONLY on a terminal `dispatched`; it NEVER clears the
   *  sticky row — only `retry_dispatch` (`DispatchCleared`) does. */
  readonly mintAttempted: (
    id: string,
    outcome: ResolverDispatchOutcome,
  ) => void;
  /** Warn sink for non-fatal diagnostics. */
  readonly noteLine?: (line: string) => void;
}

/**
 * Run one daemon resolver-dispatch sweep — the producer half of the dispatch-once loop
 * for a stuck worktree fan-in close. Walk the sticky `worktree-merge-conflict` close
 * rows that have not yet had a resolver dispatched, gate each by {@link
 * shouldEscalateMergeConflict} (defense-in-depth over the selector's SQL filter),
 * re-read that the row is STILL pending immediately before the launch (narrowing the
 * clear-mid-sweep window), launch ONE `resolve::<epic>` worker, then mint
 * `ResolverDispatchAttempted{outcome}`.
 *
 * DISPATCHES ONCE — the sweep NEVER mints `DispatchCleared` and never clears the sticky
 * row; only `retry_dispatch` does (the resolver worker fires it on the clear path, or a
 * human does). A TERMINAL `dispatched` stamps the once-marker so the next sweep's
 * selector drops the row — even if the resolver then declines (BLOCKED) or dies, the
 * latch stays stamped and NO second resolver is dispatched until the sticky clears (no
 * resolver churn loop). A `dispatch_failed` leaves the marker NULL so the row stays
 * re-sweepable. Each close failure keys on its own epic, so there is one row per epic
 * and no coalescing is needed. NEVER throws — every helper edge degrades to a recorded
 * outcome (mirrors {@link runMergeEscalationSweep}). The spawn lives ONLY here in the
 * producer, never reachable from `applyEvent`, so a re-fold never re-fires a launch.
 */
export async function runResolverDispatchSweep(
  deps: ResolverDispatchSweepDeps,
): Promise<void> {
  const note = deps.noteLine ?? (() => {});
  let pending: PendingResolverDispatch[];
  try {
    pending = deps.selectPending();
  } catch (err) {
    note(
      `# warn: resolver-dispatch sweep read threw (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  if (pending.length === 0) return;

  for (const row of pending) {
    // Defense-in-depth gate: the selector already filters by the exact token, but
    // re-apply the pure gate so an injected/loosened selector can never dispatch a
    // resolver for a non-merge-conflict reason.
    if (!shouldEscalateMergeConflict(row.reason)) continue;
    // Re-read immediately before the launch: a `retry_dispatch` that cleared the row
    // (or the fold that stamped the marker) between select and launch means there is
    // nothing left to resolve — skip without minting.
    if (!deps.stillPending(row.id)) continue;

    let outcome: ResolverDispatchResult;
    try {
      outcome = await deps.dispatchResolver(row);
    } catch (err) {
      // The dispatcher is fail-open by contract; this catch is defense-in-depth so a
      // surprise throw still records a non-terminal outcome and never aborts the sweep.
      note(
        `# warn: resolver dispatch threw for ${row.id} (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      outcome = "dispatch_failed";
    }
    // A `checkout_busy` SKIP mints nothing: the resolved base checkout is held by a live
    // merge-recreating escalation session, so the marker stays NULL and the row
    // re-sweeps once that session terminates and frees the checkout (per checkout, never
    // global — a different repo's checkout dispatches concurrently).
    if (outcome === "checkout_busy") continue;
    // Mint the attempt regardless of the remaining outcome: the fold stamps the
    // once-marker ONLY on a terminal `dispatched`, so a `dispatch_failed` folds to a
    // no-op and the row stays re-sweepable next tick.
    deps.mintAttempted(row.id, outcome);
  }
}

// ---------------------------------------------------------------------------
// fn-1129 — shared escalation-dispatch substrate (deconflict:: + unblock::)
// ---------------------------------------------------------------------------
//
// The launch machinery both escalation sweeps use to fire a purpose-built plan-skill
// session — the deconflict-dispatch sweep here, the unblock-dispatch sweep in the
// sibling task. A `<verb>::<id>` escalation session is a fresh sonnet/high context that
// boots `/plan:<verb>` and resolves the incident WITHOUT the creator's context; it is
// NEVER a worker cell, so it reads the SEPARATE escalation launch config. The shared
// helper enforces the two guards that keep the fan-out bounded: a global concurrency
// cap across BOTH verbs, and a per-key occupancy guard so cadence + fold lag can never
// double-dispatch the same key.

/**
 * Is this `jobs` row a TURN-ACTIVE escalation session — occupying its slot RIGHT NOW?
 * TRUE iff `state === 'working'` (a live turn). An escalation session is a one-shot
 * interactive session that idles forever after its turn ends, so pane/pid liveness
 * (the shared {@link isStoppedJobLive} rule, unconditionally `true` on this path's
 * `null` probe) would count a FINISHED-but-idling session as live and starve the guards
 * indefinitely — the ghost-worker pitfall (liveness is not progress). Turn-activity is
 * the fix: a `stopped` escalation session has yielded its turn and no longer occupies,
 * so its cap / occupancy / per-epic slot frees. A mid-turn permission prompt STAMPS
 * `last_permission_prompt_at` but never flips `state` off `working` (the reducer's
 * Notification arm layers the `[awaiting:…]` pill on top of the live state), so a parked
 * session stays turn-active here without a marker arm. {@link isStoppedJobLive} is left
 * untouched — every other verb (work / close / resolve / audit) keeps the pane-liveness
 * rule. Pure.
 */
function escalationJobLive(job: Job): boolean {
  return job.state === "working";
}

/**
 * Count the LIVE escalation sessions (`unblock::` + `deconflict::` combined) in `jobs`
 * — the global-cap denominator. Pure over the passed rows; exported for tests.
 */
export function countLiveEscalationSessions(jobs: readonly Job[]): number {
  let n = 0;
  for (const job of jobs) {
    if (job.plan_verb !== "unblock" && job.plan_verb !== "deconflict") continue;
    if (escalationJobLive(job)) n += 1;
  }
  return n;
}

/**
 * Is a `<verb>::<id>` escalation session already LIVE in `jobs`? The per-key occupancy
 * guard: after a dispatch mints its attempt, the once-marker fold may lag the next
 * sweep tick, so the sweep re-reads a still-`NULL` marker — this catches the live
 * session and skips the re-dispatch. Pure over the passed rows; exported for tests.
 */
export function escalationSessionLiveFor(
  jobs: readonly Job[],
  verb: EscalationVerb,
  id: string,
): boolean {
  for (const job of jobs) {
    if (job.plan_verb !== verb || job.plan_ref !== id) continue;
    if (escalationJobLive(job)) return true;
  }
  return false;
}

/**
 * Is `checkout` (a merge-conflict BASE checkout dir) currently OCCUPIED by a live
 * MERGE-RECREATING escalation session — a `resolve::` or `deconflict::` job whose `cwd`
 * is exactly that checkout? Both classes physically re-run the failing merge in the base
 * checkout, so two of them sharing one checkout contend for its single working tree; the
 * `unblock::` class runs in a task checkout and never recreates a merge, so it is neither
 * an occupant here nor a gated candidate. Excludes the candidate's OWN `<verb>::<id>` key
 * so a session never self-blocks (the per-key {@link escalationSessionLiveFor} guard owns
 * that case). Empty `checkout` (an unresolved cwd) is never occupied — a false serialize
 * that wedged an unresolvable launch would be worse than the contention it prevents. Pure
 * over the passed rows; exported for tests.
 */
export function escalationCheckoutOccupiedBy(
  jobs: readonly Job[],
  checkout: string,
  selfVerb: string,
  selfId: string,
): boolean {
  if (checkout === "") return false;
  for (const job of jobs) {
    if (job.plan_verb !== "resolve" && job.plan_verb !== "deconflict") continue;
    if (job.plan_verb === selfVerb && job.plan_ref === selfId) continue;
    if (job.cwd !== checkout) continue;
    if (escalationJobLive(job)) return true;
  }
  return false;
}

/**
 * Is any `unblock::<task>` session for a task in `epicId` LIVE in `jobs`? The
 * per-EPIC serialization guard for the block/unblock dispatch sweep: at most one live
 * unblock session per epic, so a mass-block never fans an epic's siblings out at once.
 * Each live `unblock` row's `plan_ref` is a task id (`<epic>.<ordinal>`), mapped back
 * to its epic via {@link parsePlanRef} — the same parser the reducer's jobs→epic
 * fan-out uses, so the epic mapping never diverges. Pure over the passed rows;
 * exported for tests.
 */
export function epicHasLiveUnblock(
  jobs: readonly Job[],
  epicId: string,
): boolean {
  for (const job of jobs) {
    if (job.plan_verb !== "unblock") continue;
    if (!escalationJobLive(job)) continue;
    const parsed = parsePlanRef(job.plan_ref ?? null);
    if (parsed != null && parsed.epic_id === epicId) return true;
  }
  return false;
}

/**
 * Classify a `<verb>::<id>` escalation session's terminal outcome off `jobs` PLUS the
 * caller's board-state `incidentOpen` — the generalized twin of {@link
 * classifyResolverOutcome} for the deconflict / unblock verbs (the resolver classifier
 * is hard-keyed to `resolve`). `{terminal:false}` while any matching row is TURN-ACTIVE
 * or no `<verb>::<id>` row has folded yet (the launch window), AND while the incident is
 * already closed (`incidentOpen === false` — the escalation resolved it, so there is
 * nothing to page). Otherwise `{terminal:true, verdict}`: `died` when a `killed`/`ended`
 * row is present (the session process terminated abnormally — a one-shot escalation
 * session should idle `stopped` after its turn, never exit the CLI); else `declined`
 * (the session ran its turn, ended `stopped`, and the incident is still open — it
 * attempted and gave up). The old `ended → declined` derivation was UNREACHABLE: a clean
 * decline STOPS the turn, it never exits the CLI. `incidentOpen` is the board-state
 * verdict the caller pre-computes (unblock: the `attempted` block latch survives;
 * deconflict: the sticky close row survives), keeping this pure over its inputs. Coarse
 * by design — the notify only needs "declined vs died". Pure over the passed rows;
 * exported for tests.
 */
export function classifyEscalationOutcome(
  jobs: readonly Job[],
  verb: EscalationVerb,
  id: string,
  incidentOpen: boolean,
): ResolverOutcome {
  let live = false;
  let sawRow = false;
  let sawDead = false;
  for (const job of jobs) {
    if (job.plan_verb !== verb || job.plan_ref !== id) continue;
    sawRow = true;
    if (escalationJobLive(job)) live = true;
    if (job.state === "killed" || job.state === "ended") sawDead = true;
  }
  // Invariant: wait while any row is turn-active or none has folded yet (launch window).
  if (live || !sawRow) return { terminal: false };
  // Incident already resolved (task unblocked / sticky cleared) → the escalation
  // succeeded, so there is no decline/death to page — wait it out (the row drops when
  // its latch clears). Guards the classifier against paging a resolved incident.
  if (!incidentOpen) return { terminal: false };
  return { terminal: true, verdict: sawDead ? "died" : "declined" };
}

/**
 * Load the `<verb>::<id>` escalation job rows into the array shape
 * {@link classifyEscalationOutcome} reads — the stage-3 human-notify sweep's terminal
 * deconflict probe. Bounded (a handful of rows per key), selecting only the columns the
 * liveness arms touch. A jobs read failure degrades to an EMPTY array, which classifies
 * as `{terminal:false}` so the notify conservatively WAITS (never a premature notify on a
 * transient error). Module-level twin of {@link resolveJobsForEpic}.
 *
 * `instance` scopes the read to the CURRENT block instance (the caller's `blocked_since`
 * for unblock, the sticky row's `instance_event_id` for deconflict/resolve/repair) so a
 * stale row from a RESOLVED instance can neither suppress nor prematurely fire stage-3 for
 * a re-block. The predicate is `escalation_instance = ?instance OR (escalation_instance IS
 * NULL AND last_event_id >= ?instance)`: a stamp-missed session (the corroboration-miss
 * edge; see {@link Job.escalation_instance}) is still INCLUDED so it can classify rather
 * than wait forever, but ONLY when its own `last_event_id` clears the instance anchor. A
 * genuine miss row folds every event AFTER the anchor that armed its own escalation, so it
 * always clears it; a resolved PRIOR instance's miss row — whose events all predate this
 * anchor — is excluded, closing the cross-instance leak where an unreaped prior-instance
 * NULL row would page the human for a newer re-block before its own session ran (and latch
 * `human_notified_at`, suppressing the genuine verdict). A NULL `instance` (legacy
 * pre-migration caller context) falls back to the unscoped verb+ref match — the old
 * behavior, untouched.
 */
export function resolveEscalationJobsFor(
  db: Database,
  verb: EscalationVerb,
  id: string,
  instance: number | null,
): Job[] {
  try {
    if (instance == null) {
      return db
        .query(
          "SELECT job_id, plan_verb, plan_ref, state, backend_exec_pane_id, escalation_instance FROM jobs WHERE plan_verb = ? AND plan_ref = ?",
        )
        .all(verb, id) as unknown as Job[];
    }
    return db
      .query(
        "SELECT job_id, plan_verb, plan_ref, state, backend_exec_pane_id, escalation_instance FROM jobs WHERE plan_verb = ? AND plan_ref = ? AND (escalation_instance = ? OR (escalation_instance IS NULL AND last_event_id >= ?))",
      )
      .all(verb, id, instance, instance) as unknown as Job[];
  } catch {
    return [];
  }
}

/** Injectable dependency surface for {@link dispatchEscalationSession}. Fail-open by
 *  contract — no dep throws into a sweep. */
export interface EscalationDispatchDeps {
  /** Count of currently-live escalation sessions (both verbs) for the global cap.
   *  Production: {@link countLiveEscalationSessions} over the live jobs read PLUS the
   *  producer's not-yet-folded in-flight memo. */
  readonly countLiveEscalations: () => number;
  /** True iff a `<verb>::<id>` session is already live — the per-key occupancy guard.
   *  Production: {@link escalationSessionLiveFor} over the same reads. */
  readonly isEscalationLive: (verb: EscalationVerb, id: string) => boolean;
  /** True iff `cwd` (the resolved base checkout) is already held by a DIFFERENT live
   *  merge-recreating escalation session — the per-checkout occupancy guard that
   *  serializes same-checkout escalations. Production: {@link escalationCheckoutOccupiedBy}
   *  over the live jobs read PLUS the in-flight launch memo, gated to the merge-recreating
   *  `deconflict` verb (an `unblock` candidate is never checkout-gated). */
  readonly isCheckoutOccupied: (
    verb: EscalationVerb,
    id: string,
    cwd: string,
  ) => boolean;
  /** Resolve the escalation session's `{model, effort}` (DELEGATES to
   *  {@link resolveEscalationLaunchConfig} in production). */
  readonly resolveConfig: () => { model: string; effort: string };
  /** Launch ONE `<verb>::<id>` session with the built {@link LaunchSpec} + cwd; returns
   *  `{ ok }`. Async + fail-open (a throw is caught and mapped to `dispatch_failed`). */
  readonly launch: (args: {
    spec: LaunchSpec;
    cwd: string;
    label: string;
  }) => Promise<{ ok: boolean }>;
  /** Warn sink for non-fatal diagnostics. */
  readonly noteLine?: (line: string) => void;
}

/**
 * Dispatch ONE `<verb>::<id>` escalation session — the shared launch path both the
 * deconflict-dispatch sweep and the unblock-dispatch sweep call. Enforces, in order:
 * the per-key occupancy guard ({@link EscalationDispatchDeps.isEscalationLive} — a
 * still-live session means the mint fold has not caught up, so skip → `already_live`),
 * then the global concurrency cap ({@link MAX_LIVE_ESCALATION_SESSIONS} — at cap the
 * row stays pending and re-sweeps → `at_cap`). Only past both guards does it resolve
 * the escalation `{model, effort}` and launch the session at `--name <verb>::<id>` +
 * the `/plan:<verb>` prompt. Returns `dispatched` on a successful launch,
 * `dispatch_failed` on a launch miss (or a launcher throw — caught), so the caller
 * mints the once-marker ONLY on `dispatched` and re-sweeps otherwise. NEVER throws.
 */
export async function dispatchEscalationSession(
  deps: EscalationDispatchDeps,
  args: { verb: EscalationVerb; id: string; prompt: string; cwd: string },
): Promise<EscalationDispatchOutcome> {
  const note = deps.noteLine ?? (() => {});
  const label = `${args.verb}::${args.id}`;
  // Occupancy guard FIRST: a live session for this key means a prior tick already
  // launched it and the marker fold is still catching up — skip without launching.
  if (deps.isEscalationLive(args.verb, args.id)) {
    note(`# escalation dispatch skipped — ${label} already live`);
    return "already_live";
  }
  // Per-checkout occupancy guard: a DIFFERENT merge-recreating escalation session already
  // holds the resolved base checkout, so recreating the merge there would contend for the
  // one working tree. Skip WITHOUT launching — the row re-sweeps and dispatches once the
  // occupying session reaches a terminal state. Per checkout, never global: a session for
  // a different repo's checkout dispatches concurrently.
  if (deps.isCheckoutOccupied(args.verb, args.id, args.cwd)) {
    note(
      `# escalation dispatch skipped — checkout ${args.cwd} busy; ${label} stays pending`,
    );
    return "checkout_busy";
  }
  // Global cap: bound the total concurrent escalation sessions across BOTH verbs. At
  // cap the row stays pending and re-sweeps once a session frees a slot.
  if (deps.countLiveEscalations() >= MAX_LIVE_ESCALATION_SESSIONS) {
    note(
      `# escalation dispatch skipped — at cap (${MAX_LIVE_ESCALATION_SESSIONS}); ${label} stays pending`,
    );
    return "at_cap";
  }
  const { model, effort } = deps.resolveConfig();
  const spec: LaunchSpec = {
    prompt: args.prompt,
    claudeName: label,
    model,
    effort,
  };
  let result: { ok: boolean };
  try {
    result = await deps.launch({ spec, cwd: args.cwd, label });
  } catch (err) {
    // The launcher is fail-open by contract; this catch is defense-in-depth so a
    // surprise throw still records a non-terminal outcome and never aborts the sweep.
    note(
      `# warn: escalation launch threw for ${label} (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return "dispatch_failed";
  }
  return result.ok ? "dispatched" : "dispatch_failed";
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
 * TRUNCATE here, PASSIVE in steady state. fn-897 B1 weakened the old "sole
 * connection" precondition: the READ-ONLY server worker now spawns BEFORE this
 * drain (so the control socket is reachable during catch-up), so its reader
 * connection is attached when the final TRUNCATE runs — main's writer is no longer
 * the only attachment. The reader is autocommit and idle between queries, so
 * TRUNCATE usually still collapses the WAL; if a poll-tick read happens to pin a
 * frame (or an external read-only attachment — keeper-py, the performance sitter,
 * dashctl — is present), `PRAGMA wal_checkpoint` returns a busy-status ROW rather
 * than throwing, so the worst case DEGRADES to busy/PASSIVE semantics and the
 * steady-state PASSIVE heartbeat reclaims the space on its next cadence. Emptying
 * the WAL (when it succeeds) still means a worker's first `openDb` reads the main
 * file with no WAL frames to scan and no `-shm` recovery path to walk. Steady-state
 * checkpoints stay PASSIVE — the hook no longer writes the DB (since fn-736) but
 * live workers run concurrently there, and PASSIVE skips them
 * without blocking.
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
    codex_spark_session_percent: msg.codex_spark_session_percent,
    codex_spark_session_resets_at: msg.codex_spark_session_resets_at,
    codex_spark_week_percent: msg.codex_spark_week_percent,
    codex_spark_week_resets_at: msg.codex_spark_week_resets_at,
    // Envelope freshness / plan / stale-error axes — forwarded so the
    // reducer's UPSERT populates the columns instead of folding NULL.
    status: msg.status,
    subscription_active: msg.subscription_active,
    account_state: msg.account_state,
    error_type: msg.error_type,
    error_message: msg.error_message,
    error_at: msg.error_at,
    error_kind: msg.error_kind,
    // Rate-limit lift instant — folded into `usage.rate_limit_lifts_at`. The
    // companion `last_usage_fold_at` freshness stamp is NOT serialized; the
    // reducer derives it from the event `ts` (never a wall-clock read in a fold).
    lift_at: msg.lift_at,
  });
}

/**
 * Serialize a `SessionTelemetryMessage` into the JSON string that rides in the
 * synthetic `SessionTelemetry` event's `data` blob (fn-1024). The reducer
 * (`extractSessionTelemetry`) decodes the same shape; every projection-meaningful
 * field MUST appear here or the corresponding `jobs` column folds to NULL. NOT
 * serialized: `kind` (the event-tag discriminator) and `id` (rides in
 * `events.session_id`, not the data blob) — mirroring {@link
 * serializeUsageSnapshot}. A `null` field stays `null` on the wire so the fold's
 * COALESCE merge preserves whatever a prior snapshot wrote.
 */
export function serializeSessionTelemetry(
  msg: SessionTelemetryMessage,
): string {
  return JSON.stringify({
    model_id: msg.model_id,
    model_display: msg.model_display,
    effort: msg.effort,
    used_percentage: msg.used_percentage,
    input_tokens: msg.input_tokens,
    window_size: msg.window_size,
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

// ── fn-921 git seed-liveness watchdog ──────────────────────────────────────────
/** How often the supervisor checks the git seed-liveness verdict. */
export const GIT_SEED_WATCHDOG_INTERVAL_MS = 30_000;
/**
 * How long `seed_required` may stay set (with no GitSnapshot landing to clear it)
 * before the watchdog acts. Must comfortably exceed the worker's heartbeat
 * (60s — its quiet-repo force-emit window) so a healthy boot-seed-then-clear never
 * trips the watchdog: the force-emit clears the flag within ~one heartbeat, well
 * inside this window.
 */
export const GIT_SEED_STUCK_THRESHOLD_MS = 3 * 60_000;
/**
 * How long since the last worker liveness pulse before the worker is judged
 * MUTE (alive-but-stuck — a hung poll tick). Several poll ticks worth of slack
 * (poll cadence is ~300ms) so transient scheduling jitter never reads as mute.
 */
export const GIT_LIVENESS_STUCK_THRESHOLD_MS = 90_000;
/**
 * How many MAIN-side re-seeds the watchdog tries before escalating to a process
 * restart. The step-2 gated-root key-mismatch fix removes the only DETERMINISTIC
 * stuck cause, so a re-seed is expected to clear a genuine wedge — the cap bounds
 * a crash-loop if some new deterministic-stuck slips through (re-seed, re-seed,
 * then restart, never an infinite re-seed spin).
 */
export const GIT_SEED_MAX_RESEED_ATTEMPTS = 2;

/**
 * Pure verdict for the git seed-liveness watchdog (fn-921). Mirrors
 * {@link decideTranscriptResubscribe} — boolean/clock arithmetic only, no I/O —
 * so the recovery decision is unit-testable with plain inputs.
 *
 * Returns:
 *   - `"ok"`      — healthy: `seed_required` is clear, OR the worker has not yet
 *     pulsed (boot-seed may be in flight — NEVER trip mid-boot), OR the surface
 *     made progress recently enough (under `stuckThresholdMs`).
 *   - `"reseed"`  — the surface made NO progress past `stuckThresholdMs` AND the
 *     worker is still pulsing (alive) AND the re-seed budget remains: re-run the
 *     boot-seed on main.
 *   - `"escalate"` — the worker is MUTE (no pulse past `livenessThresholdMs`), OR
 *     the re-seed budget is spent on a quiet-stuck surface: crash for a
 *     LaunchAgent restart.
 *
 * `lastProgressAtMs` is the STABLE staleness anchor: the last GitSnapshot that
 * landed (real progress), or the watchdog-arm baseline when none has landed
 * yet — so "alive but never seeding" still grows stale and trips, while the
 * latest liveness pulse (`lastLivenessAtMs`) is used ONLY for the mute check.
 */
export function decideGitSeedWatchdog(inputs: {
  seedRequired: boolean;
  lastProgressAtMs: number;
  lastLivenessAtMs: number | null;
  nowMs: number;
  stuckThresholdMs: number;
  livenessThresholdMs: number;
  reseedAttempts: number;
  maxReseedAttempts: number;
}): "ok" | "reseed" | "escalate" {
  const {
    seedRequired,
    lastProgressAtMs,
    lastLivenessAtMs,
    nowMs,
    stuckThresholdMs,
    livenessThresholdMs,
    reseedAttempts,
    maxReseedAttempts,
  } = inputs;
  // Healthy surface — nothing to recover.
  if (!seedRequired) return "ok";
  // Never trip mid-boot: a worker that has not pulsed yet may be mid-boot-seed
  // (or the timer fired in the launch gap before the first tick).
  if (lastLivenessAtMs == null) return "ok";
  // Mute worker (alive-but-stuck — a hung poll tick) → restart. A main re-seed
  // would clear the flag momentarily but the dead producer would re-stale it, so
  // a fresh process is the right recovery.
  if (nowMs - lastLivenessAtMs >= livenessThresholdMs) return "escalate";
  // Quiet-stuck staleness measured from the last progress (snapshot / arm
  // baseline) — a STABLE anchor that grows even while the worker keeps pulsing.
  if (nowMs - lastProgressAtMs < stuckThresholdMs) return "ok";
  // Genuinely stuck + worker alive: re-seed while budget remains, else escalate.
  return reseedAttempts < maxReseedAttempts ? "reseed" : "escalate";
}

// ── fn-952 tmux-control liveness watchdog ──────────────────────────────────────
/** How often the supervisor checks the tmux-control liveness verdict. */
export const TMUX_CONTROL_WATCHDOG_INTERVAL_MS = 30_000;
/**
 * How long since the last tmux-control liveness pulse before the worker is judged
 * MUTE (alive-but-stuck — a wedged reader / re-read). The worker pulses every ~15s
 * (even during long idle), so several pulses' worth of slack keeps transient
 * scheduling jitter from reading as mute.
 */
export const TMUX_CONTROL_LIVENESS_STUCK_THRESHOLD_MS = 90_000;

/**
 * Pure verdict for the tmux-control liveness watchdog (fn-952). Mirrors the
 * MUTE-check half of {@link decideGitSeedWatchdog} — clock arithmetic only, no
 * I/O — so the decision is unit-testable with plain inputs. There is no "reseed"
 * middle state: the control worker has no seed surface, so a mute worker escalates
 * straight to a process restart (the single recovery path; no in-process respawn).
 *
 * Returns `"ok"` when the worker has not yet pulsed (never trip before the first
 * pulse — the worker may be mid-attach/backoff) OR it pulsed recently enough;
 * `"escalate"` when it has gone silent past `livenessThresholdMs`.
 */
export function decideTmuxControlWatchdog(inputs: {
  lastLivenessAtMs: number | null;
  nowMs: number;
  livenessThresholdMs: number;
}): "ok" | "escalate" {
  const { lastLivenessAtMs, nowMs, livenessThresholdMs } = inputs;
  if (lastLivenessAtMs == null) return "ok";
  return nowMs - lastLivenessAtMs >= livenessThresholdMs ? "escalate" : "ok";
}

// ── fn-1082 serve-liveness watchdog ─────────────────────────────────────────────
/** How often the supervisor runs the serve-liveness probes + verdict. */
export const SERVE_WATCHDOG_INTERVAL_MS = 30_000;
/**
 * Hard per-probe timeout for a single real-read round-trip on either serve socket.
 * Generous — a healthy daemon answers a local-UDS read in sub-ms — but well under
 * the interval so a wedged read resolves (as a failure) inside its own tick and the
 * probe-age simply grows across ticks. This is the detector for the ACCEPT-STALL
 * wedge mode (the observed failure: reads timed out while the send path stayed
 * alive), which a connect-only probe would sail straight through.
 */
export const SERVE_PROBE_TIMEOUT_MS = 5_000;
/**
 * How stale the last SUCCESSFUL real-read on either socket may get before the
 * watchdog escalates. Three intervals' worth: a genuine wedge fails every probe,
 * so the age crosses this after ~3 consecutive dead ticks — enough to rule out a
 * one-off blip, short enough that an operator sees a restart, not a permanent hang.
 */
export const SERVE_PROBE_STUCK_THRESHOLD_MS = 3 * SERVE_WATCHDOG_INTERVAL_MS;
/**
 * Main-loop event-loop-delay p99 (ms) that counts as a BUSY-wedge breach for one
 * interval. ~1s of p99 lag means the main loop is starved — legitimate load rarely
 * sustains this. The accept-stall mode shows LOW lag, so this histogram detector is
 * the BELT for a main-thread busy-spin; the real-read probes above are what cover a
 * wedged SERVE thread (whose loop main's histogram cannot see).
 */
export const SERVE_LAG_P99_THRESHOLD_MS = 1_000;
/**
 * Consecutive breaching intervals before a busy-wedge escalates. Requiring N in a
 * row (not one spike) keeps a transient GC pause or a heavy-but-finite fold from
 * tripping a false restart.
 */
export const SERVE_LAG_MAX_CONSECUTIVE_BREACHES = 3;
/**
 * Boot grace: the watchdog never escalates within this window of arming. The serve
 * workers may still be binding and no probe has landed yet, so the arm-time baseline
 * would otherwise read as instantly stale. Generous — a healthy boot binds both
 * sockets and answers the first probes well inside it.
 */
export const SERVE_WATCHDOG_BOOT_GRACE_MS = 60_000;

/**
 * Pure verdict for the serve-liveness watchdog (fn-1082). Mirrors
 * {@link decideGitSeedWatchdog} — clock/threshold arithmetic only, no I/O — so the
 * decision is unit-testable with synthetic clock, probe-age, and lag inputs.
 *
 * Two detectors for two wedge modes, both escalating straight to `fatalExit`
 * (LaunchAgent restart — never an in-process respawn):
 *   - ACCEPT-STALL (low lag, zero read throughput): a real-read probe on either
 *     socket last succeeded past `probeStuckThresholdMs`. The caller stamps
 *     `lastServerProbeOkAtMs`/`lastBusProbeOkAtMs` on each successful round-trip; a
 *     wedged read never stamps, so the age grows until it crosses the window.
 *   - BUSY-wedge (main loop starved): the main event-loop-delay p99 breached its
 *     threshold for `maxConsecutiveLagBreaches` consecutive intervals (the caller
 *     accumulates/resets the count per tick).
 *
 * Returns `{ kind: "ok" }` during the boot-grace window (arm-time baselines are not
 * yet meaningful) and whenever both detectors are clear; otherwise `{ kind:
 * "escalate", trigger }` NAMING which detector fired, so the producer's escalation
 * log pins the wedge mode (accept-stall on which socket, or a busy-lag spin) instead
 * of a bare "something wedged". The server socket is checked before the bus so the
 * trigger is deterministic when both stall at once.
 */
export type ServeLivenessTrigger =
  | "accept-stall-server"
  | "accept-stall-bus"
  | "busy-lag";

export type ServeLivenessVerdict =
  | { kind: "ok" }
  | { kind: "escalate"; trigger: ServeLivenessTrigger };

export function decideServeLivenessWatchdog(inputs: {
  nowMs: number;
  bootGraceUntilMs: number;
  lastServerProbeOkAtMs: number;
  lastBusProbeOkAtMs: number;
  probeStuckThresholdMs: number;
  consecutiveLagBreaches: number;
  maxConsecutiveLagBreaches: number;
}): ServeLivenessVerdict {
  const {
    nowMs,
    bootGraceUntilMs,
    lastServerProbeOkAtMs,
    lastBusProbeOkAtMs,
    probeStuckThresholdMs,
    consecutiveLagBreaches,
    maxConsecutiveLagBreaches,
  } = inputs;
  // Never trip mid-boot: workers may still be binding, first probes not yet landed.
  if (nowMs < bootGraceUntilMs) return { kind: "ok" };
  // Accept-stall on either socket — a real read has not answered within the window.
  if (nowMs - lastServerProbeOkAtMs >= probeStuckThresholdMs) {
    return { kind: "escalate", trigger: "accept-stall-server" };
  }
  if (nowMs - lastBusProbeOkAtMs >= probeStuckThresholdMs) {
    return { kind: "escalate", trigger: "accept-stall-bus" };
  }
  // Busy-wedge — main loop starved for N consecutive intervals.
  if (consecutiveLagBreaches >= maxConsecutiveLagBreaches) {
    return { kind: "escalate", trigger: "busy-lag" };
  }
  return { kind: "ok" };
}

/**
 * One real-read round-trip on a fresh UDS connection for the serve-liveness
 * watchdog: connect, write `request` (newline-delimited JSON — the wire format both
 * the keeperd and bus relays speak), and resolve `true` on the first parsed frame
 * `isMatch` accepts. Resolves `false` on connect-fail, transport error, server close
 * before a match, or `timeoutMs` elapsing — NEVER rejects, so the interval callback
 * stays a plain `.then(ok => …)`. One short-lived connection with an immediate close
 * so a probe holds no connection slot on the serve thread.
 *
 * A REAL read (not connect-only) is the point: the observed wedge kept the send path
 * alive while reads died, so only a round-trip that gets a frame back proves the
 * serve loop is live. Frames are tiny (a status query / a bus `list`), well under the
 * partial-write hang bound (`MAX_CONTROL_FRAME_BYTES`).
 */
async function probeSocketRead(
  sockPath: string,
  request: Record<string, unknown>,
  isMatch: (frame: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let remainder = "";
    let settled = false;
    let sock: Awaited<ReturnType<typeof Bun.connect>> | null = null;

    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock?.end();
      } catch {
        // best-effort — we're done with this connection either way
      }
      resolve(ok);
    };

    const timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref?.();

    Bun.connect({
      unix: sockPath,
      socket: {
        open(s) {
          sock = s;
          try {
            s.write(`${JSON.stringify(request)}\n`);
          } catch {
            settle(false);
          }
        },
        data(_s, chunk) {
          remainder += chunk.toString("utf8");
          let nl = remainder.indexOf("\n");
          while (nl !== -1) {
            const line = remainder.slice(0, nl).trim();
            remainder = remainder.slice(nl + 1);
            if (line.length > 0) {
              let frame: Record<string, unknown>;
              try {
                frame = JSON.parse(line) as Record<string, unknown>;
              } catch {
                nl = remainder.indexOf("\n");
                continue; // ignore a malformed line, keep reading
              }
              if (isMatch(frame)) {
                settle(true);
                return;
              }
            }
            nl = remainder.indexOf("\n");
          }
        },
        close() {
          settle(false);
        },
        error() {
          settle(false);
        },
      },
    }).catch(() => settle(false));
  });
}

// ── crash-loop distress signal ───────────────────────────────────────────────
/**
 * How many boots inside {@link CRASH_LOOP_WINDOW_MS} count as a crash-loop. The
 * plist ships `ThrottleInterval 10` + `KeepAlive{SuccessfulExit:false}`, and an
 * observed wedge-restart cycle is ~60-120s, so a healthy daemon never restarts
 * this often — 8 boots inside a half-hour is an unambiguous self-restart storm,
 * while a routine deploy/reboot (one boot) never approaches it.
 */
export const CRASH_LOOP_THRESHOLD = 8;
/** Sliding window (ms) the boot count is measured over. */
export const CRASH_LOOP_WINDOW_MS = 30 * 60_000;
/**
 * Hard length cap on the restart ledger. Window-aging already bounds it under
 * normal cadence; the cap is the belt against a pathological same-window burst
 * bloating the sidecar. Comfortably above {@link CRASH_LOOP_THRESHOLD} so a real
 * loop still records enough boots to trip.
 */
export const RESTART_LEDGER_CAP = 64;

/**
 * Parse a restart-ledger file body into a boot-timestamp array. FAIL-OPEN: any
 * malformed body (not JSON, not an array, non-finite entries) yields `[]` so a
 * corrupt ledger becomes an empty one — never new `fatalExit` fuel, and never a
 * false crash-loop trip. The next write overwrites it clean. Pure; NEVER throws.
 */
export function parseRestartLedger(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is number => typeof t === "number" && Number.isFinite(t),
    );
  } catch {
    return [];
  }
}

/**
 * Fold this boot into the ledger: drop timestamps outside the window (and any
 * future-dated garbage), append `nowMs`, sort ascending, and keep only the most
 * recent `cap`. Window-aging makes the ledger self-heal after a loop stops;
 * the cap bounds the file under a same-window burst. Pure; NEVER throws.
 */
export function updateRestartLedger(inputs: {
  existing: number[];
  nowMs: number;
  windowMs: number;
  cap: number;
}): number[] {
  const { existing, nowMs, windowMs, cap } = inputs;
  const cutoff = nowMs - windowMs;
  const kept = existing.filter(
    (t) => Number.isFinite(t) && t >= cutoff && t <= nowMs,
  );
  kept.push(nowMs);
  kept.sort((a, b) => a - b);
  return kept.length > cap ? kept.slice(kept.length - cap) : kept;
}

/**
 * Pure crash-loop verdict: how many of `bootTimestamps` fall inside the window
 * ending at `nowMs`, and whether that count reached `threshold`. Windowing here
 * (not just trusting a pre-aged caller) keeps the decision self-contained and
 * unit-testable across the threshold/window/aging axes. NEVER throws.
 */
export function decideCrashLoop(inputs: {
  nowMs: number;
  bootTimestamps: number[];
  threshold: number;
  windowMs: number;
}): { crashLoop: boolean; recentBoots: number } {
  const { nowMs, bootTimestamps, threshold, windowMs } = inputs;
  const cutoff = nowMs - windowMs;
  const recentBoots = bootTimestamps.filter(
    (t) => Number.isFinite(t) && t >= cutoff && t <= nowMs,
  ).length;
  return { crashLoop: recentBoots >= threshold, recentBoots };
}

/**
 * Read + fail-open-parse the restart ledger at `path`. A missing file (first
 * boot) or any read/parse error yields `[]` — the crash-loop detector must never
 * be the thing that crashes boot. Mirrors {@link parseRestartLedger}'s contract.
 */
export function readRestartLedger(path: string): number[] {
  try {
    return parseRestartLedger(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Persist the ledger (best-effort, atomic). A write failure (full disk, ENOENT
 * dir) is swallowed: a lost boot record only undercounts a future loop — strictly
 * safer than crashing boot on the write. NEVER throws.
 */
export function writeRestartLedger(path: string, timestamps: number[]): void {
  try {
    atomicWriteFile(path, JSON.stringify(timestamps));
  } catch (err) {
    console.error(
      `[keeperd] restart-ledger write threw (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
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
 * Age window a `dead_letters` row must exceed before the retention prune removes
 * it — 7 days, matching the reclaim/backup sidecar retention horizon. The gate
 * compares against `recovered_at` (recovered rows) or `dl_written_at` (poison
 * rows), both stored as unix SECONDS (`Date.now() / 1000`).
 */
export const DEAD_LETTER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Injectable knobs for {@link pruneRecoveredDeadLetters} — defaulted so the
 * daemon caller passes none, overridable so the pass body is drivable
 * in-process by a test with no timers / no `startDaemon`.
 */
export interface DeadLetterRetentionOptions {
  /** Wall-clock ms the age gate measures against. Defaults to `Date.now()`. */
  now?: number;
  /** Age window in ms a row must exceed. Defaults to {@link DEAD_LETTER_RETENTION_MS}. */
  retentionMs?: number;
  /** Per-pid liveness probe (the seal check). Defaults to {@link pidAlive}. */
  isPidAlive?: (pid: number) => boolean;
}

export interface DeadLetterRetentionResult {
  /** Sealed dead-letter-dir NDJSON files unlinked this pass. */
  prunedFiles: number;
  /** `dead_letters` rows deleted this pass (file-coupled + row-only). */
  prunedRows: number;
}

/**
 * True iff `filePath` resolves STRICTLY beneath `dir`. The hard backstop that
 * keeps the dead-letter prune's `unlinkSync` from ever escaping
 * `KEEPER_DEAD_LETTER_DIR` — in particular it can never touch an events-log file
 * (poison rows point their `source_file` there).
 */
function isPathUnderDir(dir: string, filePath: string): boolean {
  const base = resolvePath(dir);
  const target = resolvePath(filePath);
  return target !== base && target.startsWith(base + sep);
}

/**
 * The writing pid encoded in a `<pid>.ndjson` dead-letter filename, or `null`
 * when the stem is non-numeric (never a real dead-letter file — disables the
 * prune for it, mirroring the events-log cleanup gate).
 */
function pidFromDeadLetterFile(filePath: string): number | null {
  const name = basename(filePath);
  if (!name.endsWith(".ndjson")) {
    return null;
  }
  const stem = name.slice(0, -".ndjson".length);
  return /^\d+$/.test(stem) ? Number(stem) : null;
}

/**
 * Retention prune for the `dead_letters` operational table + its NDJSON archive
 * — the producer-side complement of {@link scanDeadLetterDir}. Runs on MAIN's
 * writable connection (the maintenance worker stays read-only); an exported,
 * in-process-testable pass body driven by {@link runRetentionPass}.
 *
 * THE RESURRECTION HAZARD is the whole game: `scanDeadLetterDir` INSERT-OR-IGNOREs
 * every surviving line of every file, so deleting a row while its file can still
 * be scanned re-replays the event as `waiting`. Two prune shapes, direction-
 * specific unlink ordering:
 *
 *  - FILE-COUPLED (dead-letter-dir NDJSON files): a file is prunable iff EVERY
 *    row referencing it is `recovered` AND aged past the cutoff — DB-derived via
 *    a GROUP BY (never a line-count/file-read: a torn trailing line yields fewer
 *    rows than lines, so a count-equality check would be wrong; "no row violates
 *    the recovered+aged predicate" is torn-tail safe). A `waiting` row (SACRED)
 *    or a `poison` row on the file keeps it inline. Sealed check: only prune a
 *    file whose writing pid is DEAD (a live pid may append a NEW `waiting` line
 *    that a concurrent scan ingests — deleting `WHERE source_file` would then
 *    race it). Then UNLINK FIRST, DELETE rows second: a crash between the two
 *    leaves orphaned `recovered` rows, harmless (replay's `WHERE status='waiting'`
 *    skips them) and swept next pass (the file is gone, `unlinkSync` ENOENT is a
 *    no-op, the delete still runs).
 *  - ROW-ONLY (no file to resurrect them): `recovered` rows with `source_file
 *    IS NULL` (age on `recovered_at`) and `poison` rows (age on `dl_written_at`
 *    — poison park leaves `recovered_at` NULL). Poison rows' `source_file` points
 *    at an EVENTS-LOG file the ingester solely owns; its durable byte-offset
 *    already advanced past the poison line, so the ROW deletes with no re-ingest
 *    and the file is NEVER touched. Paced (≤500 rows/batch, ≤20 batches) so the
 *    writer lock never starves a concurrent hook INSERT.
 *
 * The `status='waiting'` warn pill is unaffected — this prune removes only
 * `recovered`/`poison` rows. Never throws for a single-file unlink error
 * (per-file non-fatal, mirroring events-log cleanup); a DB-level error propagates
 * to the caller's non-fatal retention try.
 */
export function pruneRecoveredDeadLetters(
  db: Database,
  dir: string,
  options: DeadLetterRetentionOptions = {},
): DeadLetterRetentionResult {
  const now = options.now ?? Date.now();
  const retentionMs = options.retentionMs ?? DEAD_LETTER_RETENTION_MS;
  const probe = options.isPidAlive ?? pidAlive;
  // recovered_at / dl_written_at are unix SECONDS (Date.now()/1000) — compare in
  // the SAME unit, never mix ms.
  const cutoffSec = (now - retentionMs) / 1000;

  let prunedFiles = 0;
  let prunedRows = 0;

  // --- File-coupled prune (dead-letter-dir NDJSON files) --------------------
  const candidateFiles = db
    .prepare(
      `SELECT source_file AS f
         FROM dead_letters
        WHERE source_file IS NOT NULL
        GROUP BY source_file
       HAVING SUM(
                CASE WHEN status = 'recovered'
                       AND recovered_at IS NOT NULL
                       AND recovered_at <= ?
                     THEN 0 ELSE 1 END
              ) = 0`,
    )
    .all(cutoffSec) as { f: string }[];

  const deleteBySourceFile = db.prepare(
    "DELETE FROM dead_letters WHERE source_file = ?",
  );

  for (const { f } of candidateFiles) {
    // Path scope: NEVER unlink outside `dir`. Recovered rows always carry a
    // dead-letter-dir source_file (scanDeadLetterDir stamps join(dir, name)), so
    // this is defense-in-depth against an events-log path ever reaching here.
    if (!isPathUnderDir(dir, f)) {
      continue;
    }
    const pid = pidFromDeadLetterFile(f);
    if (pid === null || probe(pid)) {
      continue;
    }
    try {
      try {
        unlinkSync(f);
      } catch (err) {
        // A crash last pass may have unlinked before the delete — the file is
        // already gone; the row delete below still sweeps the orphans.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }
      const info = deleteBySourceFile.run(f);
      prunedRows += Number(info.changes);
      prunedFiles += 1;
    } catch (err) {
      // Per-file non-fatal (an EPERM unlink, a delete error): the file stays and
      // a later pass retries — one bad file never aborts the rest of the pass.
      console.error(
        `[keeperd] dead-letter prune failed for ${f}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // --- Row-only prune (no file to resurrect them) ---------------------------
  const selectRowOnlyBatch = db.prepare(
    `SELECT dl_id FROM dead_letters
      WHERE (status = 'recovered' AND source_file IS NULL
             AND recovered_at IS NOT NULL AND recovered_at <= ?)
         OR (status = 'poison' AND dl_written_at <= ?)
      LIMIT ?`,
  );
  const deleteByIds = db.prepare(
    "DELETE FROM dead_letters WHERE dl_id IN (SELECT value FROM json_each(?))",
  );
  for (let i = 0; i < DEFAULT_RETENTION_MAX_BATCHES; i++) {
    const idRows = selectRowOnlyBatch.all(
      cutoffSec,
      cutoffSec,
      DEFAULT_RETENTION_BATCH_SIZE,
    ) as { dl_id: string }[];
    if (idRows.length === 0) {
      break;
    }
    const ids = idRows.map((r) => r.dl_id);
    const info = deleteByIds.run(JSON.stringify(ids));
    prunedRows += Number(info.changes);
    if (ids.length < DEFAULT_RETENTION_BATCH_SIZE) {
      break;
    }
  }

  return { prunedFiles, prunedRows };
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
  "plan_op",
  "plan_target",
  "plan_epic_id",
  "plan_task_id",
  "plan_subject_present",
  "tool_use_id",
  "config_dir",
  "bash_mutation_kind",
  "bash_mutation_targets",
  "plan_files",
  "backend_exec_type",
  "backend_exec_session_id",
  "backend_exec_pane_id",
  "background_task_id",
  "mutation_path",
  "worktree",
  "harness",
  "resume_target",
  "adopted",
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
 * Derive `events.mutation_path` for an ingested NDJSON line whose bindings lack
 * it (a PRE-`mutation_path`-deriver hook wrote the line). The ingester is the
 * sole writer of hook-sourced rows, so this seam is the only place a pre-deriver
 * line gets the promoted column — via the SAME pure {@link extractMutationPath}
 * the forward hook runs, so a recomputed row matches a hook-derived one
 * byte-for-byte.
 *
 * `data` rides the binding as a JSON STRING (the on-disk shape); parse it
 * defensively. A missing / non-string / unparseable body, or a body that isn't
 * a plain object, folds to `null` (the deriver's zero-event value) — NEVER a
 * throw, which would roll back the whole ingest transaction. `hook_event` /
 * `tool_name` ride as plain string bindings; the deriver gates on them.
 */
function recomputeMutationPath(
  bindings: Record<string, string | number | boolean | null>,
): string | null {
  const rawData = bindings.data;
  if (typeof rawData !== "string" || rawData.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const hookEvent =
    typeof bindings.hook_event === "string" ? bindings.hook_event : "";
  const toolName =
    typeof bindings.tool_name === "string" ? bindings.tool_name : null;
  return extractMutationPath(
    hookEvent,
    toolName,
    parsed as Record<string, unknown>,
  );
}

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
              // advance past it (a no-op line, safe to consume). Recompute is
              // gated BELOW on a real event line so a degenerate no-column line
              // is never promoted into a constraint-violating INSERT.
              continue;
            }
            // Recompute-for-pre-deriver-lines: the ingester is the SOLE writer
            // of hook-sourced rows, so a real event line a PRE-`mutation_path`-
            // deriver hook wrote (no `mutation_path` binding) gets the column
            // derived HERE from the same pure `extractMutationPath` the forward
            // hook runs — identical result, so a hook-derived and an ingester-
            // recomputed row are byte-identical. Only recompute when ABSENT (a
            // present binding, even NULL, is authoritative — never overwrite the
            // hook's value). Reads `data` as a JSON string (the on-disk binding
            // shape); a malformed/non-string body folds to NULL, never a throw
            // that wedges the ingest transaction.
            if (!presentCols.includes("mutation_path")) {
              bindings.mutation_path = recomputeMutationPath(bindings);
              presentCols.push("mutation_path");
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
 * Convert a birth record's ISO `launch_ts` to the REAL unix-seconds `events.ts`
 * the hook writes for a real SessionStart. A pure function of the record (never
 * scan wall-clock), so a re-scan of the same record mints a byte-identical event
 * — re-fold-safe by construction. Falls back to scan wall-clock ONLY when
 * `launch_ts` is unparseable.
 */
function birthEventTs(record: BirthRecord): number {
  const parsed = Date.parse(record.launch_ts);
  return Number.isNaN(parsed) ? Date.now() / 1000 : parsed / 1000;
}

/**
 * Mint ONE synthetic `SessionStart` event from a birth record on main's WRITER
 * connection. The bindings mirror what the claude SessionStart hook writes
 * (`hook_event='SessionStart'`, `event_type='session_start'`), so the EXISTING
 * jobs fold — the same arm claude/pi run through — turns it into a tracked row
 * with NO reducer arm added: harness + resume_target ride the v107 columns,
 * `pid` + `start_time` seed the recycle-safe identity (NEVER NULL — a NULL-pid
 * seed would be `boot_unwatchable`-reaped; a birth record always carries the
 * child pid), `spawn_name` becomes the title, and the `backend_exec_*` coords
 * fold via the every-event backend arm so the renamer + exit-watcher inherit the
 * row. `data` is NULL (no transcript at birth). SQLite assigns `id`, landing the
 * row at the tail of the log.
 *
 * The column list matches CREATE_EVENTS verbatim (a future column add updates
 * this site AND its `seed-sweep` `insertKilledEvent` sibling); values bind
 * positionally.
 */
function insertBirthSessionStart(db: Database, record: BirthRecord): void {
  db.run(
    `INSERT INTO events (
       ts, session_id, pid, hook_event, event_type, tool_name, matcher,
       cwd, permission_mode, agent_id, agent_type, stop_hook_active, data,
       subagent_agent_id, spawn_name, start_time, slash_command, skill_name,
       plan_op, plan_target, plan_epic_id, plan_task_id,
       plan_subject_present, tool_use_id, config_dir,
       bash_mutation_kind, bash_mutation_targets, plan_files,
       backend_exec_type, backend_exec_session_id, backend_exec_pane_id,
       background_task_id, mutation_path, worktree, harness, resume_target,
       adopted
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      birthEventTs(record),
      record.session_id,
      record.pid,
      "SessionStart",
      "session_start",
      null, // tool_name
      null, // matcher
      record.cwd,
      null, // permission_mode
      null, // agent_id
      null, // agent_type
      null, // stop_hook_active
      null, // data (no transcript at birth)
      null, // subagent_agent_id
      record.spawn_name,
      record.start_time,
      null, // slash_command
      null, // skill_name
      null, // plan_op
      null, // plan_target
      null, // plan_epic_id
      null, // plan_task_id
      null, // plan_subject_present
      null, // tool_use_id
      record.config_dir,
      null, // bash_mutation_kind
      null, // bash_mutation_targets
      null, // plan_files
      record.backend_exec_type,
      record.backend_exec_session_id,
      record.backend_exec_pane_id,
      null, // background_task_id
      null, // mutation_path
      record.worktree,
      record.harness,
      record.resume_target,
      // adopted: births are launcher-owned by definition, so the marker is NULL.
      null,
    ],
  );
}

/** Retire a processed / parked birth record — delete it from `new/`. An ENOENT
 *  retire race (already gone) is a non-fatal no-op; the tree stays bounded. */
function retireBirthFile(full: string): void {
  try {
    unlinkSync(full);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error(
        `[keeperd] births retire failed for ${full}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/**
 * Resolve CODEX_HOME for the resume-target sweep — an explicit non-empty
 * `CODEX_HOME` wins, else `<home>/.codex` (the same rule
 * `codex-trust` / `transcript-watch` use).
 */
export function resolveCodexHomeDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return (env.CODEX_HOME ?? "").trim() || join(homedir(), ".codex");
}

/** A codex job awaiting resume-target back-fill — see {@link findCodexResumeCandidates}. */
export interface CodexResumeCandidate {
  jobId: string;
  cwd: string | null;
  /** Job launch instant in ms (jobs.created_at seconds × 1000). */
  startedAtMs: number;
}

/**
 * The live codex jobs whose native rollout uuid is not yet back-filled: harness
 * `codex`, `resume_target` still NULL, a non-terminal (`working`/`stopped`) state,
 * and launched within `recentWindowSec` of `nowSec`. The recency floor is what
 * makes the sweep go quiet — an old unresolved job (collision, override stripped)
 * drops out instead of provoking a tree scan every tick. Pure over the db + clock.
 */
export function findCodexResumeCandidates(
  db: Database,
  nowSec: number,
  recentWindowSec: number,
): CodexResumeCandidate[] {
  const rows = db
    .query(
      `SELECT job_id, cwd, created_at FROM jobs
         WHERE harness = 'codex' AND resume_target IS NULL
           AND state IN ('working', 'stopped')
           AND created_at >= ?`,
    )
    .all(nowSec - recentWindowSec) as {
    job_id: string;
    cwd: string | null;
    created_at: number;
  }[];
  return rows.map((r) => ({
    jobId: r.job_id,
    cwd: r.cwd,
    startedAtMs: r.created_at * 1000,
  }));
}

/** A resolved (jobId → native rollout uuid) pair the sweep mints as `ResumeTargetResolved`. */
export interface CodexResumeResolution {
  jobId: string;
  resumeTarget: string;
}

/**
 * Resolve the native rollout uuid for every current codex resume candidate,
 * reading each candidate's rollout `SessionMeta` head via
 * {@link resolveCodexResumeTarget} (originator exact-match first, cwd+created-at
 * fallback with refuse-to-guess). An unresolvable candidate is omitted — it keeps
 * its NULL resume_target (not-resumable) and is retried next tick until it ages
 * out of the recency window. Reads NO session content. Returns [] with NO tree
 * read when there are no candidates (the sweep's idle path).
 */
export function resolveCodexResumeCandidates(
  db: Database,
  codexHome: string,
  nowSec: number,
  recentWindowSec: number,
): CodexResumeResolution[] {
  const resolutions: CodexResumeResolution[] = [];
  for (const candidate of findCodexResumeCandidates(
    db,
    nowSec,
    recentWindowSec,
  )) {
    const resumeTarget = resolveCodexResumeTarget({
      codexHome,
      jobId: candidate.jobId,
      expectedCwd: candidate.cwd,
      startedAtMs: candidate.startedAtMs,
    });
    if (resumeTarget !== null) {
      resolutions.push({ jobId: candidate.jobId, resumeTarget });
    }
  }
  return resolutions;
}

/**
 * The recency floor (seconds) for the pi resume-target REPAIR pass — a live pi
 * job launched within this window whose recorded target rotted (names no on-disk
 * artifact) is eligible for an auto-repair. Generous relative to the codex NULL
 * back-fill window because rot is discovered over a session's life, not at launch;
 * the non-terminal state filter already bounds the pass to live jobs, so this is a
 * belt-and-suspenders cap keeping a permanently-unmatchable old job from
 * re-scanning its store forever.
 */
export const PI_RESUME_REPAIR_RECENT_WINDOW_SEC = 7 * 24 * 60 * 60;

/**
 * A rotted-and-repaired pi resume target: the job, the rotted target the proposal
 * was computed against, and the disk-anchored replacement. `oldTarget` is the
 * re-mint's concurrency guard — MAIN re-reads `resume_target` and mints only while
 * it still equals `oldTarget`, so a concurrent fix is never clobbered.
 */
export interface PiResumeRepair {
  jobId: string;
  oldTarget: string;
  newTarget: string;
}

/**
 * The live pi jobs whose recorded resume target may have rotted: harness `pi`, a
 * non-empty `resume_target`, a non-terminal (`working`/`stopped`) state, and
 * launched within `recentWindowSec` of `nowSec`. Same shape as
 * {@link findCodexResumeCandidates} — the recency floor keeps the sweep quiet. The
 * rot check itself (target names no artifact) is deferred to {@link proposePiRepair}.
 * Pure over the db + clock.
 */
export function findRottedPiResumeCandidates(
  db: Database,
  nowSec: number,
  recentWindowSec: number,
): PiRepairJob[] {
  const rows = db
    .query(
      `SELECT job_id, title, cwd, resume_target, created_at FROM jobs
         WHERE harness = 'pi' AND resume_target IS NOT NULL AND resume_target != ''
           AND state IN ('working', 'stopped')
           AND created_at >= ?`,
    )
    .all(nowSec - recentWindowSec) as {
    job_id: string;
    title: string | null;
    cwd: string | null;
    resume_target: string;
    created_at: number;
  }[];
  return rows.map((r) => ({
    jobId: r.job_id,
    label: r.title ?? r.job_id,
    cwd: r.cwd,
    resumeTarget: r.resume_target,
    createdAtMs: r.created_at * 1000,
  }));
}

/**
 * Resolve the disk-anchored replacement for every current rotted-pi candidate,
 * gating each through {@link proposePiRepair} (the SAME confidence gate
 * `keeper tabs repair` reports with) and keeping ONLY the unambiguous
 * single-candidate `resolved` proposals — an `ambiguous` or `unmatched` job is
 * omitted (it stays surfaced by `keeper tabs repair` until it resolves or a human
 * corrects it). Reads the pi session stores via the real fs seam; returns [] with
 * NO store read when there are no candidates (the sweep's idle path).
 */
export function resolvePiResumeRepairs(
  db: Database,
  homeDir: string,
  env: Record<string, string | undefined>,
  nowSec: number,
  recentWindowSec: number,
): PiResumeRepair[] {
  const candidates = findRottedPiResumeCandidates(db, nowSec, recentWindowSec);
  if (candidates.length === 0) {
    return [];
  }
  const fs = nodeResumeResolveFs();
  const repairs: PiResumeRepair[] = [];
  for (const job of candidates) {
    const proposal = proposePiRepair(fs, job, { homeDir, env });
    if (proposal !== null && proposal.kind === "resolved") {
      repairs.push({
        jobId: job.jobId,
        oldTarget: proposal.oldTarget,
        newTarget: proposal.newTarget,
      });
    }
  }
  return repairs;
}

/**
 * The tracked codex jobs whose live stop-churn the state producer tails: harness
 * `codex`, a resolved (non-NULL) `resume_target` — the attributed rollout uuid
 * the tailer keys on, so an unattributed job idles presence-only — and a
 * non-terminal (`working`/`stopped`) state. No recency floor: a non-terminal job
 * is recent by construction (the reapers drive stale sessions terminal), and
 * following a long-lived session's ongoing churn is the point. Pure over the db.
 */
export function findLiveCodexStateJobs(db: Database): LiveCodexJob[] {
  const rows = db
    .query(
      `SELECT job_id, resume_target, created_at FROM jobs
         WHERE harness = 'codex' AND resume_target IS NOT NULL
           AND state IN ('working', 'stopped')`,
    )
    .all() as {
    job_id: string;
    resume_target: string;
    created_at: number;
  }[];
  return rows.map((r) => ({
    jobId: r.job_id,
    resumeTarget: r.resume_target,
    createdAtMs: r.created_at * 1000,
  }));
}

/**
 * Read the durable codex rollout-adoption knob off the `autopilot_state`
 * singleton. Absent row / NULL / 0 all resolve to OFF (the byte-identical
 * default — no fold reads this column). Re-read every sweep tick so a knob flip
 * is a live kill-switch: flipping OFF stops adoption within one tick.
 */
export function isCodexAdoptionEnabled(db: Database): boolean {
  const row = db
    .query("SELECT codex_adoption FROM autopilot_state WHERE id = 1")
    .get() as { codex_adoption: number | null } | null;
  return row?.codex_adoption === 1;
}

/**
 * The dedup predicate for codex adoption: does ANY tracked job already claim this
 * rollout uuid — either as its own `job_id` (a prior adoption of the same
 * rollout) or as its `resume_target` (a launcher-owned session the resume
 * back-fill attributed to this rollout)? Reads the folded `jobs` projection, so
 * it enforces the "discovery never adopts a launcher-owned session" +
 * idempotent-re-mint invariants across ticks.
 */
function codexRolloutClaimed(db: Database, uuid: string): boolean {
  return (
    db
      .query("SELECT 1 FROM jobs WHERE job_id = ? OR resume_target = ? LIMIT 1")
      .get(uuid, uuid) != null
  );
}

/**
 * Canonicalize a rollout's RAW cwd before it enters the adopted `jobs` row —
 * `realpathSync` to defeat symlink escapes when the path exists, falling back to
 * a lexical `resolve` (collapsing `.`/`..`) when it does not. The raw value is
 * user-writable (a rollout file is untrusted input), so canonicalizing here
 * neutralizes path-traversal / injection before the value is stored.
 */
export function canonicalizeAdoptedCwd(rawCwd: string): string {
  try {
    return realpathSync(rawCwd);
  } catch {
    return resolvePath(rawCwd);
  }
}

/**
 * Mint ONE synthetic `SessionStart` for an ADOPTED codex rollout — the pull-side
 * sibling of {@link insertBirthSessionStart}. COORDLESS by design: main mints
 * from a rollout FILE, owning no process and no tmux pane, so `pid`,
 * `start_time`, and every `backend_exec_*`/`worktree` coord bind NULL. The job id
 * AND `resume_target` are both the rollout `uuid` (so the live-state tailer keys
 * on it immediately), `harness` is `codex`, `adopted` is 1 (the non-launcher
 * marker the SessionStart COALESCE arm preserves set-once), `cwd` is the
 * pre-canonicalized value, and `ts` is the rollout's OWN immutable session-start
 * (seconds) — never file mtime, never wall-clock — so a from-scratch re-fold
 * reproduces a byte-identical row. Column list matches CREATE_EVENTS verbatim
 * (a future column add updates this site alongside its `insertBirthSessionStart`
 * sibling); values bind positionally. MUST run on `db` = main's WRITER connection.
 */
export function insertAdoptedCodexSessionStart(
  db: Database,
  uuid: string,
  canonicalCwd: string,
  sessionStartSec: number,
): void {
  db.run(
    `INSERT INTO events (
       ts, session_id, pid, hook_event, event_type, tool_name, matcher,
       cwd, permission_mode, agent_id, agent_type, stop_hook_active, data,
       subagent_agent_id, spawn_name, start_time, slash_command, skill_name,
       plan_op, plan_target, plan_epic_id, plan_task_id,
       plan_subject_present, tool_use_id, config_dir,
       bash_mutation_kind, bash_mutation_targets, plan_files,
       backend_exec_type, backend_exec_session_id, backend_exec_pane_id,
       background_task_id, mutation_path, worktree, harness, resume_target,
       adopted
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionStartSec, // ts — the rollout's own immutable session-start
      uuid, // session_id — the adopted job id
      null, // pid — coordless/pidless: main owns no process for this session
      "SessionStart",
      "session_start",
      null, // tool_name
      null, // matcher
      canonicalCwd, // cwd — canonicalized on the raw rollout value
      null, // permission_mode
      null, // agent_id
      null, // agent_type
      null, // stop_hook_active
      null, // data (no transcript captured at adoption)
      null, // subagent_agent_id
      null, // spawn_name
      null, // start_time
      null, // slash_command
      null, // skill_name
      null, // plan_op
      null, // plan_target
      null, // plan_epic_id
      null, // plan_task_id
      null, // plan_subject_present
      null, // tool_use_id
      null, // config_dir
      null, // bash_mutation_kind
      null, // bash_mutation_targets
      null, // plan_files
      null, // backend_exec_type — COORDLESS
      null, // backend_exec_session_id — COORDLESS
      null, // backend_exec_pane_id — COORDLESS
      null, // background_task_id
      null, // mutation_path
      null, // worktree
      "codex", // harness
      uuid, // resume_target — the native rollout uuid (== job id)
      1, // adopted — the non-launcher adoption marker
    ],
  );
}

/**
 * One codex rollout-adoption sweep tick (fn-1131) — the pull-side sibling of the
 * resume back-fill. Knob-gated (re-read each tick, so OFF stops adoption within
 * one tick), it discovers originator-less, sole-for-their-cwd rollouts within the
 * recency window ({@link findAdoptableCodexRollouts}), then for each — newest
 * first, up to `mintCap` — has MAIN mint a coordless adopted SessionStart inside
 * a `BEGIN IMMEDIATE` guarded by a re-read of {@link codexRolloutClaimed} (skip
 * if any job already claims the uuid). cwd is canonicalized BEFORE the
 * transaction so the write lock never spans that IO. A mint throw rolls its own
 * row back and is logged non-fatally; the tick continues. Returns the number of
 * jobs minted (the caller wakes the fold when > 0). MUST run on `db` = main's
 * WRITER connection.
 */
export function runCodexAdoptionSweep(
  db: Database,
  codexHome: string,
  nowSec: number,
  recentWindowSec: number,
  mintCap: number,
): number {
  if (!isCodexAdoptionEnabled(db)) {
    return 0; // knob OFF — nothing scanned, nothing minted (the default).
  }
  const candidates: AdoptableCodexRollout[] = findAdoptableCodexRollouts(
    codexHome,
    nowSec,
    recentWindowSec,
  );
  let minted = 0;
  for (const candidate of candidates) {
    if (minted >= mintCap) {
      break; // per-tick cap reached — the rest drains on later ticks.
    }
    // Cheap pre-filter (single-threaded main is the sole writer, so the folded
    // `jobs` view is authoritative between ticks): skip an already-claimed uuid
    // WITHOUT a write lock so re-scanned adopted rollouts never churn a txn.
    if (codexRolloutClaimed(db, candidate.uuid)) {
      continue;
    }
    const canonicalCwd = canonicalizeAdoptedCwd(candidate.cwd);
    db.run("BEGIN IMMEDIATE");
    try {
      // Authoritative re-read INSIDE the write lock — the mint is idempotent even
      // against a racing resume back-fill that attributed the same rollout.
      if (codexRolloutClaimed(db, candidate.uuid)) {
        db.run("COMMIT");
        continue;
      }
      insertAdoptedCodexSessionStart(
        db,
        candidate.uuid,
        canonicalCwd,
        candidate.sessionStartMs / 1000,
      );
      db.run("COMMIT");
      minted += 1;
    } catch (err) {
      try {
        db.run("ROLLBACK");
      } catch {
        // best-effort — a rollback failure never escalates a sweep tick.
      }
      console.error(
        `[keeperd] codex-adoption mint failed for ${candidate.uuid} (skipped this tick): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return minted;
}

/**
 * Park a birth record that cannot be folded — a malformed (poison) record, or a
 * stale one whose mint perpetually throws — as a `dead_letters` row with
 * status='poison' (replay's `WHERE status='waiting'` skips it). Deterministic
 * `dl_id` keyed on the file path → `ON CONFLICT DO NOTHING` idempotent.
 * `ts`/`dl_written_at` are scan wall-clock (dead_letters is an operational
 * sidecar, never folded). Returns `true` when the row is durably parked (the
 * caller then retires the file); `false` on a transient DB error (the caller
 * LEAVES the file for the next scan). Emits one `birth-ingest-poison` backstop
 * record when the sink is wired.
 */
function parkPoisonBirth(
  db: Database,
  full: string,
  body: string,
  pid: number | null,
  ctx?: EventsIngestContext,
): boolean {
  const dlId = `birth-poison:${full}`;
  const nowSec = Date.now() / 1000;
  try {
    db.run(
      `INSERT INTO dead_letters
         (dl_id, session_id, hook_event, ts, dl_written_at, pid,
          bindings, status, recovered_at, replayed_event_id, source_file)
       VALUES (?, 'poison', 'PoisonBirthRecord', ?, ?, ?, ?, 'poison', NULL, NULL, ?)
       ON CONFLICT(dl_id) DO NOTHING`,
      [
        dlId,
        nowSec,
        nowSec,
        pid,
        JSON.stringify({ raw: body.slice(0, 64 * 1024), file: full }),
        full,
      ],
    );
  } catch (err) {
    console.error(
      `[keeperd] births poison-park failed for ${full}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
  if (ctx !== undefined) {
    ctx.counters.bump("birth-ingest-poison", "timeout", true);
    appendBackstopRecord(
      buildTimeoutRecord({
        backstop: "birth-ingest-poison",
        worker: "main",
        rescued: true,
        now: Date.now(),
        stalenessMs: null,
        detail: { file: full, dl_id: dlId },
      }),
      ctx.backstopLogPath,
    );
  }
  return true;
}

/** Grace before a mint-failing birth record is eligible for dead-pid GC. A
 *  transient write failure deserves several retries; only a record aged past
 *  this AND whose pid is provably dead is parked. */
const BIRTH_STUCK_GRACE_MS = 5 * 60_000;

/**
 * Bound the births tree against a record whose mint PERPETUALLY throws: once the
 * file has aged past {@link BIRTH_STUCK_GRACE_MS} AND its recorded pid is
 * provably dead (nothing left to track — a live pid still deserves a retry so
 * the session eventually appears), park it to `dead_letters` and retire it. A
 * young or live-pid record is LEFT for the next scan.
 */
function gcStuckBirthRecord(
  db: Database,
  full: string,
  record: BirthRecord,
  ctx?: EventsIngestContext,
): void {
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(full).mtimeMs;
  } catch {
    return; // vanished — nothing to GC
  }
  if (ageMs < BIRTH_STUCK_GRACE_MS || pidAlive(record.pid)) {
    return;
  }
  if (parkPoisonBirth(db, full, JSON.stringify(record), record.pid, ctx)) {
    retireBirthFile(full);
  }
}

/**
 * Ingest the births maildir — the non-hook presence channel's analogue of
 * {@link scanEventsLogDir}, but PROCESS-THEN-RETIRE (births are one-record files,
 * not append logs, so there is no byte-offset cursor). For each record under
 * `<dir>/new/`:
 *
 *  - PARSE ({@link parseBirthRecord}): a torn/partial file never reaches `new/`
 *    (the launcher writes tmp→fsync→rename, an atomic move-in), so a null parse
 *    is a genuinely malformed COMPLETE record — POISON. Park it (idempotent
 *    dl_id) and retire, so one bad record never wedges the scan.
 *  - MINT + RETIRE: a valid record mints ONE synthetic SessionStart
 *    ({@link insertBirthSessionStart}) inside a `BEGIN IMMEDIATE`, then — after
 *    the durable COMMIT — retires the file. A crash in the tiny commit→unlink
 *    window re-mints on the next scan, which is HARMLESS: a duplicate
 *    SessionStart folds idempotently (a resume). At-least-once + idempotent fold
 *    = exactly-once observable, without an fs op inside the SQL transaction.
 *  - INSERT-THROW: rolls the transaction back and LEAVES the file (retry next
 *    scan); {@link gcStuckBirthRecord} bounds the tree if it never recovers.
 *
 * A read that ENOENTs (the file vanished — a concurrent scan retired it) is
 * SKIPPED, never parked. NEVER THROWS out of the scan: every recoverable error
 * is swallowed to stderr so one bad file never wedges boot or the message loop.
 * When `ctx` is absent, poison records are STILL parked; only the backstop
 * record is skipped. MUST run on `db` = main's WRITER connection.
 */
export function scanBirthDir(
  db: Database,
  dir: string,
  ctx?: EventsIngestContext,
): void {
  const newDir = join(dir, "new");
  if (!existsSync(newDir)) {
    return;
  }
  let names: string[];
  try {
    names = readdirSync(newDir);
  } catch (err) {
    console.error(
      `[keeperd] births scan failed to readdir ${newDir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) {
      // The launcher writes `<pid>.<start-time>.json`; ignore anything else.
      continue;
    }
    const full = join(newDir, name);
    let body: string;
    try {
      body = readFileSync(full, "utf8");
    } catch {
      // Read-vs-retire race (file vanished between readdir and read): skip,
      // never park — a maildir move-in is atomic, so a present file is complete.
      continue;
    }
    const record = parseBirthRecord(body);
    if (record === null) {
      // POISON: a complete-but-malformed record. Park + retire so it can never
      // re-poison a later scan. Leave it only on a transient park failure.
      if (parkPoisonBirth(db, full, body, null, ctx)) {
        retireBirthFile(full);
      }
      continue;
    }
    // Valid record: mint the synthetic SessionStart atomically, COMMIT, then
    // retire. A crash in the commit→unlink window re-mints harmlessly.
    let committed = false;
    db.run("BEGIN IMMEDIATE");
    try {
      insertBirthSessionStart(db, record);
      db.run("COMMIT");
      committed = true;
    } catch (err) {
      try {
        db.run("ROLLBACK");
      } catch {
        // best-effort
      }
      console.error(
        `[keeperd] births mint failed for ${full} (leaving for retry): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (committed) {
      retireBirthFile(full);
      continue;
    }
    // Mint kept failing — bound the tree against a permanently-stuck record.
    gcStuckBirthRecord(db, full, record, ctx);
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
  | "statusline"
  | "builds"
  | "usageScraper"
  | "deadLetter"
  | "eventsIngest"
  | "birthIngest"
  | "autopilot"
  | "handoff"
  | "maintenance"
  | "restore"
  | "renamer"
  | "autoclose"
  | "bus"
  | "tmuxControl"
  | "baseline";

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
  "statusline",
  "builds",
  "usageScraper",
  "deadLetter",
  "eventsIngest",
  "birthIngest",
  "autopilot",
  "handoff",
  "maintenance",
  "restore",
  "renamer",
  "autoclose",
  "bus",
  "tmuxControl",
  "baseline",
] as const;

/**
 * The watcher workers that dlopen `@parcel/watcher`. Decides whether the
 * main-thread pre-warm ({@link prewarmWatcherAddon}) is needed: it runs ONLY when
 * at least one of these is in the selected set. fn-921: the git-worker is now
 * POLL-ONLY — it no longer imports `@parcel/watcher`, so it is dropped from this
 * set (a git-only boot needs no pre-warm).
 */
const WATCHER_WORKERS: readonly WorkerName[] = [
  "transcript",
  "plan",
  "usage",
  "statusline",
  "deadLetter",
  "eventsIngest",
  "birthIngest",
] as const;

/**
 * TTL (ms) for an autoclose intent hint. Sized to OUTLIVE the
 * slowest path by which the exit-watcher can observe an autoclosed process's
 * death: the periodic reprobe backstop, which cannot reap a row until it ages
 * past {@link REPROBE_MIN_AGE_SECS} and then fires on up to one more
 * {@link REPROBE_MS} tick. Doubling the age gate and adding a tick keeps a hint
 * alive well past that worst case — a slow-observed autoclose whose hint expired
 * merely mislabels the `Killed` row `exit_watched` (non-fatal, never a crash).
 */
export const AUTOCLOSE_HINT_TTL_MS =
  REPROBE_MIN_AGE_SECS * 2 * 1000 + REPROBE_MS;

/**
 * Consume-once, TTL-bounded set of autoclose intent hints, keyed by job id. The
 * autoclose worker posts a hint IMMEDIATELY before it force-closes
 * a window; main consults it at the SINGLE `Killed`-mint site so a hinted death
 * is stamped `kill_reason: 'autoclosed'` instead of `exit_watched`. The
 * exit-watcher stays the sole `Killed` producer — this only relabels.
 *
 * Pure (the clock is injected), so the insert / consume-once / TTL-expiry /
 * identity-mismatch matrix is unit-tested with no daemon. A hint is consumed AT
 * MOST ONCE (a match deletes it) and only when the exit event's `(pid, startTime)`
 * matches the posted tuple under the same null-tolerant rule the exit verifier
 * uses. An absent, expired, already-consumed, or mismatched hint yields `false`
 * and the mint falls back to `exit_watched`.
 */
export class AutocloseHintSet {
  private readonly hints = new Map<
    string,
    { pid: number | null; startTime: string | null; expiresAtMs: number }
  >();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Record a hint for `jobId`, expiring `ttlMs` from now (a repeat post for the
   *  same job replaces the entry and refreshes its expiry). Opportunistically
   *  prunes expired entries so an aborted kill can't leak one past its TTL. */
  post(jobId: string, pid: number | null, startTime: string | null): void {
    const nowMs = this.now();
    for (const [id, h] of this.hints) {
      if (nowMs >= h.expiresAtMs) this.hints.delete(id);
    }
    this.hints.set(jobId, { pid, startTime, expiresAtMs: nowMs + this.ttlMs });
  }

  /** Consume the hint for `jobId` iff one is live AND its `(pid, startTime)`
   *  identity matches. Returns `true` and deletes the entry on a match; returns
   *  `false` on absent / expired / identity mismatch. */
  consume(
    jobId: string,
    pid: number | null,
    startTime: string | null,
  ): boolean {
    const hint = this.hints.get(jobId);
    if (hint === undefined) return false;
    if (this.now() >= hint.expiresAtMs) {
      this.hints.delete(jobId);
      return false;
    }
    // Null-tolerant identity match, mirroring the exit verifier: pids match when
    // both are NULL or both non-null and equal; start_time matches when either
    // side is NULL or they are equal. A mismatch is a racy/stale hint — leave it
    // (a later correct event may still match within the TTL) and fall back to
    // exit_watched.
    const pidMatches =
      (hint.pid == null && pid == null) ||
      (hint.pid != null && hint.pid === pid);
    const startMatches =
      hint.startTime == null ||
      startTime == null ||
      hint.startTime === startTime;
    if (!pidMatches || !startMatches) return false;
    this.hints.delete(jobId);
    return true;
  }

  /** Live (unexpired) hint count — introspection for tests only. */
  size(): number {
    const nowMs = this.now();
    let n = 0;
    for (const h of this.hints.values()) if (nowMs < h.expiresAtMs) n++;
    return n;
  }
}

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

/** Minimal `Bun.spawnSync`-shaped result the keeper-agent boot self-check reads. */
export interface KeeperAgentProbeResult {
  readonly success: boolean;
  readonly exitCode: number;
}

/** Injectable `Bun.spawnSync`-shaped probe for {@link checkKeeperAgentPresence};
 *  takes the full launcher argv (`[<bun>, <keeper.ts>, "agent", "--version"]`); a
 *  throw models an unlaunchable launcher (ENOENT bun / missing keeper.ts). */
export type KeeperAgentProbeFn = (argv: string[]) => KeeperAgentProbeResult;

/**
 * Fail-fast keeper-agent launcher SELF-check, run at boot ONLY where launch is
 * reachable (the `want("autopilot")` gate). The folded `keeper agent` launcher is
 * keeper's sole, direct launch transport — no tmux-launch fallback — so an
 * unresolvable launcher (a missing bun / a `cli/keeper.ts` the resolver could not
 * locate) would otherwise surface only as a per-launch ENOENT, spiralling into
 * the never-bound breaker. This pre-empts that with one loud boot warning naming
 * the resolved launcher argv + a hint.
 *
 * Never throws and never exits: the daemon still serves reads + pane-ops without
 * a launchable launcher, so a miss is a WARNING, not a hard exit. Returns `true`
 * when present (the self-invocation succeeded with exit 0), `false` otherwise.
 *
 * The probe self-invokes `<bun> <cli/keeper.ts> agent --version` — proving the
 * SAME launcher argv the dispatch path embeds actually answers. `PATH` MUST ride
 * in the env — a bare custom env drops it and a re-exec PATH lookup would
 * false-ENOENT. Injectable `spawn`/`log` for unit tests so the present/missing
 * branches exercise with no real fork.
 */
export function checkKeeperAgentPresence(
  launcherArgvPrefix: string[],
  deps: {
    spawn?: KeeperAgentProbeFn;
    log?: (msg: string) => void;
  } = {},
): boolean {
  const log = deps.log ?? ((msg: string) => console.error(msg));
  const probe: KeeperAgentProbeFn =
    deps.spawn ??
    ((argv: string[]) => {
      const res = Bun.spawnSync(argv, {
        timeout: 5_000,
        // PATH is load-bearing — a bare custom env drops it and a binary that
        // re-execs a PATH lookup false-ENOENTs.
        env: process.env as Record<string, string | undefined>,
      });
      return { success: res.success, exitCode: res.exitCode };
    });
  const probeArgv = [...launcherArgvPrefix, "--version"];
  const launcherLabel = launcherArgvPrefix.join(" ");
  let ok = false;
  try {
    const res = probe(probeArgv);
    ok = res.success && res.exitCode === 0;
  } catch {
    ok = false;
  }
  if (ok) {
    log(`[keeper] keeper agent launch transport: ${launcherLabel}`);
  } else {
    log(
      `[keeper] WARNING: keeper agent launcher not launchable (${launcherLabel}) — ` +
        `worker launch (autopilot + manual dispatch) will FAIL until repaired ` +
        `(ensure bun + cli/keeper.ts are present, or set KEEPER_AGENT_PATH / config keeper_agent_path).`,
    );
  }
  return ok;
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
  // fn-897 B1: the READ-ONLY server worker now spawns BEFORE this drain (right
  // after `migrate()`), so the control socket is reachable while the reducer is
  // still catching up — `serveBootDrain()` below is DEFINED here but INVOKED only
  // after the server-worker spawn. The drain still runs synchronously on main, and
  // its order is unchanged (drain → seedKilledSweep → autopilot re-arm → trailing
  // drain → git boot-seed → ephemeral-truncate). The wake worker (which fires
  // wakes against the writer) and the STATE-CHANGING surfaces (autopilot actuator
  // + mutating RPCs) stay gated AFTER the drain — only the read socket comes up
  // early. The pre-sweep drain brings the `jobs` projection up to the latest
  // persisted lifecycle BEFORE `seedKilledSweep` reads it — without this, a
  // SessionEnd that landed mid-boot would still look like a live row to the sweep.
  //
  // Step 2a — seed sweep. Fold dead/recycled jobs to `killed` so the projection
  // converges to the persisted lifecycle. The early read socket may serve a
  // pre-sweep snapshot during the drain (the boot-status header's `catching_up`
  // flag tells the client it's provisional); the actuator stays gated until the
  // sweep + drain complete. See `seedKilledSweep` for the Q7 match rules; the
  // trailing drain folds the synthetic Killed events the sweep just emitted.
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

  // Dead-letter dir resolved up here so both the boot import (inside
  // `serveBootDrain`) and the dead-letter worker (spawned later) share it.
  const deadLetterDir = resolveDeadLetterDir();

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

  // Step 1c — births boot ingest (fn-1103). The non-hook presence channel's twin
  // of the events-log boot scan: fold every birth record the `keeper agent`
  // launcher dropped for a non-claude harness during downtime into a synthetic
  // SessionStart BEFORE the boot drain, so the drain mints the tracked jobs rows
  // this pass. `mkdir` the maildir `new/` HERE — before the boot scan AND the
  // birth-ingest worker spawn — so the watcher always finds an existing dir
  // (@parcel/watcher's `subscribe` requires one) regardless of deploy ordering.
  // Reuses the same backstop sink as the events-log scan (a distinct
  // `birth-ingest-poison` counter). DIRECT write on `db` (main's writer conn).
  const birthDir = resolveBirthDir(process.env);
  mkdirSync(join(birthDir, "new"), { recursive: true });
  scanBirthDir(db, birthDir, eventsIngestCtx);

  // Captured ONCE at boot (the resolver reads `process.env`, restored by the
  // in-process test harness right after the synchronous boot window). The
  // handoff spill-file read confines `doc_path` under this dir — without the
  // confinement a foreign same-user `request_handoff` caller could name any
  // daemon-readable path and exfiltrate its bytes into the durable `handoffs`
  // projection. See the read site below.
  const handoffSpillDir = resolveHandoffSpillDir();

  // fn-897 B1: the boot drain + seed + ephemeral-truncate runs in `serveBootDrain`
  // below, INVOKED after the server-worker spawn so the read socket is up during
  // this synchronous catch-up. The sequence is byte-for-byte the pre-fn-897 order.
  function serveBootDrain(): void {
    withBootDrainCheckpointTuning(db, () => {
      drainToCompletion(db, DEFAULT_BATCH_SIZE, bootPace);
      seedKilledSweep(db);
      // No autopilot boot-append. The concurrency cap is now RUNTIME-settable via
      // `set_autopilot_config` (→ `AutopilotConfigSet`), not config-file-frozen at
      // boot — so the daemon never mints a synthetic cap event. A fresh board with
      // no `autopilot_state` row at all is correct: the in-memory `autopilotPaused`
      // default (`true`, seeded after the drain below) carries boots-paused, and the
      // reconciler/viewer resolve `max_concurrent_jobs ?? DEFAULT` (unlimited) from
      // the absent row. The singleton materializes lazily on the first
      // pause/play/mode/config event.
    });

    // Step 2a.5 — LIVE-ONLY git boot-seed. The v79 skip-floor makes every
    // historical `GitSnapshot`/`Commit` git fold no-op, so the git surface
    // (`git_status` + `file_attributions` + the 3 jobs git-counters) is EMPTY after
    // the boot drain. Re-derive it for currently-dirty files here — BEFORE serving,
    // so `await git-clean` / `commit-work` / readiness consumers see a populated
    // surface from the first board read. Runs AFTER `seedKilledSweep` (job rows
    // must exist so attribution rendering resolves session state) and BEFORE the
    // git-worker spawn (whose first emit is suppressed). DEGRADE-NOT-FATAL: the
    // seed is time-bound and never throws; a git hang/failure serves the rest of
    // the control plane and leaves `seed_required` set to retry. Reachable from the
    // `startDaemon` test path (this is the same `runDaemon` body). Skipped only on
    // a git-unselected boot (`want("git")` false) — no git surface to seed.
    if (want("git")) {
      seedGitProjection(db, stmts, {
        drainToCompletion: (handle) =>
          drainToCompletion(handle, DEFAULT_BATCH_SIZE, bootPace),
      });
    }

    // Step 2a.5b — LIVE-ONLY tmux location boot-seed (epic fn-907). The v83
    // skip-floor makes every historical `TmuxTopologySnapshot` fold no-op, so the
    // tmux location surface (`jobs.backend_exec_session_id` + `jobs.window_index`)
    // is stale after the boot drain. Re-derive the WHOLE-SERVER pane topology here
    // — AFTER `seedKilledSweep` + `seedGitProjection` (job rows must exist so the
    // synthetic snapshot matches them) and BEFORE the actuator/RPC gate
    // (`boot-complete`), so a worker pane's live location is correct from the first
    // board read and no consumer acts on an unseeded surface. DEGRADE-NOT-FATAL:
    // the probe is time-bound and never throws; a degraded probe (server gone /
    // transient / unresolvable generation) seeds nothing and leaves `seed_required`
    // set for the next boot — it never wipes a job's last-known good location. The
    // topology PRODUCER lives in the restore worker, so this is gated on
    // `want("restore")`; a restore-unselected boot has no producer to keep the
    // surface fresh, so seeding it would only stale.
    if (want("restore")) {
      seedTmuxProjection(db, stmts, {
        drainToCompletion: (handle) =>
          drainToCompletion(handle, DEFAULT_BATCH_SIZE, bootPace),
      });
    }

    // Step 2a.6 — EPHEMERAL projection boot-truncate (fn-870). `pending_dispatches`
    // is in-flight launch-window state, NOT replayed from history: the boot drain
    // above folds historical `Dispatched`/`DispatchExpired` events (the cursor must
    // advance for the deterministic projections), but the in-flight set must start
    // empty so a rewinding migration's full re-fold can't resurrect weeks-old
    // phantoms that consume the dispatch budget + per-root mutex (the v76→v79 jam).
    // Empty-at-boot is CORRECT — the autopilot re-derives genuine in-flight launches
    // from live `jobs`/tmux panes. MUST run AFTER the drain (live folds applied) and
    // BEFORE serving / the autopilot worker spawn (no consumer ever observes a
    // phantom). NOT worker-gated: the truncate is unconditional regardless of the
    // selected worker set. See `truncateEphemeralProjections` / `EPHEMERAL_PROJECTIONS`.
    truncateEphemeralProjections(db);

    // Step 2b — dead-letter boot import. Read every NDJSON file the hook wrote
    // during downtime and INSERT OR IGNORE each parsed record into `dead_letters`
    // as `waiting`. Runs during the early-served drain: a board client connecting
    // mid-boot may briefly see a not-yet-imported backlog, with the boot-status
    // header's `catching_up` flag signalling the snapshot is provisional. Idempotent
    // (`INSERT OR IGNORE` on `dl_id`); a DIRECT operational-table write, NOT a fold.
    scanDeadLetterDir(db, deadLetterDir);
  } // end serveBootDrain

  // Coalescing flag: every wake sets it; the run loop resets it before each
  // drain pass. A wake arriving mid-drain leaves the flag set, so the loop runs
  // one more pass — no event is missed (drain re-reads from the cursor).
  let wakePending = false;
  let draining = false;
  let shuttingDown = false;

  // fn-921 git seed-liveness watchdog state. `lastGitLivenessAtMs` is stamped on
  // every worker poll-tick pulse (and on every GitSnapshot) — the MUTE-check
  // anchor. `lastGitProgressAtMs` is the STABLE staleness anchor: stamped at
  // watchdog-arm (the baseline) and on every GitSnapshot the worker delivers (real
  // progress), so "alive but never seeding" still grows stale. `gitSeedReseedAttempts`
  // caps the MAIN-side re-seed before the watchdog escalates to a restart. The
  // watchdog timer ({@link decideGitSeedWatchdog}) reads these.
  let lastGitLivenessAtMs: number | null = null;
  let lastGitProgressAtMs = Date.now();
  let gitSeedReseedAttempts = 0;
  let gitSeedWatchdogTimer: ReturnType<typeof setInterval> | null = null;

  // fn-952 tmux-control liveness watchdog state. The control worker posts a
  // `tmux-control-liveness` pulse on a steady cadence (even during long idle — no
  // focus change ≠ unhealthy), so a SILENTLY-HUNG client (alive but its reader /
  // re-read wedged) escalates instead of going invisible to the crash-only
  // `onerror`/`close` supervision. `null` until the first pulse — the watchdog
  // never trips before the worker has pulsed once (it may be mid-attach/backoff).
  let lastTmuxControlLivenessAtMs: number | null = null;
  let tmuxControlWatchdogTimer: ReturnType<typeof setInterval> | null = null;

  // fn-1082 serve-liveness watchdog state. Each probe stamps its socket's
  // `last…ProbeOkAtMs` on a successful real read (arm-time baseline until the first
  // success), so a wedged read simply stops advancing it and the age grows across
  // ticks. `serveLagConsecutiveBreaches` accumulates the main-loop lag-breach run
  // (reset on a clean tick). The lag histogram measures MAIN's loop (the belt for a
  // main-thread busy-spin — a wedged SERVE thread is caught by the read probes).
  // {@link decideServeLivenessWatchdog} reads these.
  let lastServerProbeOkAtMs = Date.now();
  let lastBusProbeOkAtMs = Date.now();
  let serveLagConsecutiveBreaches = 0;
  let serveLivenessWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  let serveLagHistogram: ReturnType<typeof monitorEventLoopDelay> | null = null;

  // Autopilot in-memory paused flag. Initialized PAUSED (safety default), then
  // re-seeded from the durable `autopilot_state.paused` column after the boot
  // drain reaches head (below) — so the daemon resumes its last durable state
  // (an intentional `play` survives a restart) and a fresh board still boots
  // PAUSED. Steady-state it is RPC-writable only via `set_autopilot_paused`. The
  // worker is told via the main→worker `{ type: "set-paused", paused }` channel.
  let autopilotPaused = true;
  // Forward references filled in when the workers spawn below; the bridge
  // handlers capture these via closure. Until a worker is constructed, a bridge
  // request resolves `ok:false` — a tolerated no-op for the boot-window race.
  let autopilotWorker: Worker | null = null;
  // The plan-worker posts a `nudge-discovery` the first time it sees a `.keeper`
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
   * agentusage daemon rotates a profile, so its mint is the one most likely to
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

  /**
   * Append a `DispatchCleared` synthetic event — the SOLE legal way to DELETE a
   * `dispatch_failures` row (the reducer's fold arm). The composite `${verb}::${id}`
   * rides as the entity-key (`session_id`) overload so a re-fold correlates the clear
   * to its row without re-parsing the data blob. Caller sets `wakePending` + pumps.
   *
   * ALSO clears the durable `dispatch_mint_gate` row for the key — the single choke
   * point every `DispatchCleared` mint flows through (the `retry_dispatch` RPC fast
   * path and the recover auto-clear), so a human retry or a recover-cleared failure
   * re-dispatches IMMEDIATELY instead of waiting out the mint-gate window. The gate
   * DELETE is a direct producer write (the gate is NOT a projection), idempotent,
   * and runs before the event insert so a clear is never swallowed.
   */
  /**
   * Mint ONE `ResumeTargetResolved` synthetic event that back-fills a job's
   * `resume_target`. Two producers ride this seam: the codex rollout back-fill (a
   * NULL target → its resolved native rollout uuid) and the pi rot repair (a
   * rotted target → its disk-anchored replacement). MAIN is the sole event writer,
   * so both mint here rather than writing `jobs` directly — the fold's dedicated
   * `ResumeTargetResolved` arm folds ONLY `jobs.resume_target` (never lifecycle
   * state, so a late back-fill can never revive a terminal row) and a from-scratch
   * re-fold reproduces it from the event's `resume_target` COLUMN. The caller sets
   * `wakePending` + pumps.
   */
  function mintResumeTargetResolved(resolution: {
    jobId: string;
    resumeTarget: string;
  }): void {
    stmts.insertEvent.run({
      $ts: Date.now() / 1000,
      $session_id: resolution.jobId,
      $pid: null,
      $hook_event: "ResumeTargetResolved",
      $event_type: "resume_target_resolved",
      $tool_name: null,
      $matcher: null,
      $cwd: null,
      $permission_mode: null,
      $agent_id: null,
      $agent_type: null,
      $stop_hook_active: null,
      $data: null,
      $subagent_agent_id: null,
      $spawn_name: null,
      $start_time: null,
      $slash_command: null,
      $skill_name: null,
      $plan_op: null,
      $plan_target: null,
      $plan_epic_id: null,
      $plan_task_id: null,
      $plan_subject_present: null,
      $config_dir: null,
      $bash_mutation_kind: null,
      $bash_mutation_targets: null,
      $plan_files: null,
      $backend_exec_type: null,
      $backend_exec_session_id: null,
      $backend_exec_pane_id: null,
      $worktree: null,
      $resume_target: resolution.resumeTarget,
    });
  }

  /**
   * Mint ONE synthetic `Stop` event (fn-1103) carrying a codex turn-completion
   * the daemon-side rollout tailer parsed. Stamped with the ROLLOUT LINE's own
   * timestamp (never wall-clock), so a boot-scan / tail-catch-up replay of a dead
   * session's rollout folds through the Stop arm's terminal guard as a no-op and
   * can never flicker a killed/ended row back to life. MAIN is the sole event
   * writer, so the tailer mints here rather than writing `jobs` directly — a
   * from-scratch re-fold reproduces the row. Caller sets `wakePending` + pumps.
   */
  function mintCodexStop(signal: CodexStopSignal): void {
    stmts.insertEvent.run({
      $ts: signal.tsSec,
      $session_id: signal.jobId,
      $pid: null,
      $hook_event: "Stop",
      $event_type: "stop",
      $tool_name: null,
      $matcher: null,
      $cwd: null,
      $permission_mode: null,
      $agent_id: null,
      $agent_type: null,
      $stop_hook_active: null,
      $data: null,
      $subagent_agent_id: null,
      $spawn_name: null,
      $start_time: null,
      $slash_command: null,
      $skill_name: null,
      $plan_op: null,
      $plan_target: null,
      $plan_epic_id: null,
      $plan_task_id: null,
      $plan_subject_present: null,
      $config_dir: null,
      $bash_mutation_kind: null,
      $bash_mutation_targets: null,
      $plan_files: null,
      $backend_exec_type: null,
      $backend_exec_session_id: null,
      $backend_exec_pane_id: null,
      $worktree: null,
      $resume_target: null,
    });
  }

  function mintDispatchClearedEvent(verb: string, id: string): void {
    clearDispatchMintGate(db, `${verb}::${id}`);
    stmts.insertEvent.run({
      $ts: Date.now() / 1000,
      $session_id: `${verb}::${id}`,
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
      $data: JSON.stringify({ verb, id }),
      $subagent_agent_id: null,
      $spawn_name: null,
      $start_time: null,
      $slash_command: null,
      $skill_name: null,
      $plan_op: null,
      $plan_target: null,
      $plan_epic_id: null,
      $plan_task_id: null,
      $plan_subject_present: null,
      $config_dir: null,
      $bash_mutation_kind: null,
      $bash_mutation_targets: null,
      $plan_files: null,
      $backend_exec_type: null,
      $backend_exec_session_id: null,
      $backend_exec_pane_id: null,
      $worktree: null,
    });
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
  //
  // fn-897 B1: this now spawns BEFORE `serveBootDrain()` (so the server worker can
  // also come up early). A wake landing during the synchronous boot drain can't
  // interleave — main's event loop is blocked in the drain — so the queued
  // `pumpWakes()` fires only after the drain returns, where it's a no-op (already
  // at head). Harmless: drain is idempotent and re-reads from the cursor.
  let worker: Worker | null = null;
  if (want("wake")) {
    worker = new Worker(new URL("./wake-worker.ts", import.meta.url).href, {
      workerData: { dbPath, pollMs: 25, role: "wake" } satisfies WakeWorkerData,
    } as WorkerOptions & { workerData: unknown });

    // Step 4 — each wake message triggers a (coalescing) drain pass.
    worker.onmessage = (
      ev: MessageEvent<WakeWorkerOutbound | undefined>,
    ): void => {
      if (!ev.data) return;
      if (ev.data.kind === "wake") {
        wakePending = true;
        pumpWakes();
        return;
      }
      // fn-1096.3: a tolerated-NOTADB skip record — route to the sole
      // sidecar writer.
      if (ev.data.kind === "backstop") {
        handleBackstopMessage(ev.data);
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

  // fn-897 B1: spawn the read-only server worker BEFORE the boot drain
  // (`serveBootDrain()` is invoked just after this block). It needs only a
  // migrated schema — its read-only `openDb` would fail loud against a
  // missing/un-migrated DB, but `migrate()` ran inside `openDb` above — and is
  // fully decoupled from the reducer (its own connection + `data_version` poll),
  // so it can bind the UDS and serve reads while the reducer catches up. It boots
  // with its gate un-`ready`: mutating RPCs are rejected `server_booting` and
  // every frame carries `catching_up: true` until main posts `boot-complete`
  // (after the drain). `dbPath` is the only required field; sock/lock paths
  // default to `resolveSockPath()` worker-side (KEEPER_SOCK honored there).
  // `serverWorker` was forward-declared above (for `pumpWakes`'s kick); assign it
  // here when selected. A boot without the server worker binds no UDS — a
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
        | SetAutopilotConfigRequestMessage
        | SetEpicArmedRequestMessage
        | RequestHandoffRequestMessage
        | BackstopMessage
        | { kind: "ready" }
        | undefined
      >,
    ): void => {
      const msg = ev.data;
      if (!msg) return;
      // fn-1096.3: a tolerated-NOTADB skip record — route to the sole
      // sidecar writer.
      if (msg.kind === "backstop") {
        handleBackstopMessage(msg);
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
              $plan_op: null,
              $plan_target: null,
              $plan_epic_id: null,
              $plan_task_id: null,
              $plan_subject_present: null,
              $config_dir: null,
              $bash_mutation_kind: null,
              $bash_mutation_targets: null,
              $plan_files: null,
              $backend_exec_type: null,
              $backend_exec_session_id: null,
              $backend_exec_pane_id: null,
              $worktree: null,
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
            $plan_op: null,
            $plan_target: null,
            $plan_epic_id: null,
            $plan_task_id: null,
            $plan_subject_present: null,
            $config_dir: null,
            $bash_mutation_kind: null,
            $bash_mutation_targets: null,
            $plan_files: null,
            $backend_exec_type: null,
            $backend_exec_session_id: null,
            $backend_exec_pane_id: null,
            $worktree: null,
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
      if (msg.kind === "set-autopilot-config-request") {
        // APPEND an `AutopilotConfigSet` synthetic event carrying the validated
        // partial config patch so the reducer folds it into the `autopilot_state`
        // singleton (setting ONLY the patched columns, preserving the rest), then
        // pump a wake. APPEND-ONLY, same NO-relay contract as set-autopilot-mode:
        // the level-triggered reconciler re-reads the config columns from the
        // projection every cycle. Config is durable user intent (persisted), not a
        // safety reset like `paused`, so there is no in-memory flag and no boot
        // re-arm. The handler validated the patch; main JSON-stringifies it
        // verbatim into `events.data` (the reducer re-validates per-field).
        const id = msg.id;
        let reply: SetAutopilotConfigResultMessage;
        try {
          // Mint the validated patch VERBATIM — `max_concurrent_per_root` is
          // durable stored intent, so a worktree-off patch never coerces/rejects
          // it (the shared checkout safety invariant lives at the consumption
          // seams via `effectivePerRootCap`, which is strictly stronger — a stale
          // > 1 row can no longer over-dispatch).
          stmts.insertEvent.run({
            $ts: Date.now() / 1000,
            $session_id: "autopilot",
            $pid: null,
            $hook_event: "AutopilotConfigSet",
            $event_type: "autopilot_state",
            $tool_name: null,
            $matcher: null,
            $cwd: null,
            $permission_mode: null,
            $agent_id: null,
            $agent_type: null,
            $stop_hook_active: null,
            $data: JSON.stringify(msg.patch),
            $subagent_agent_id: null,
            $spawn_name: null,
            $start_time: null,
            $slash_command: null,
            $skill_name: null,
            $plan_op: null,
            $plan_target: null,
            $plan_epic_id: null,
            $plan_task_id: null,
            $plan_subject_present: null,
            $config_dir: null,
            $bash_mutation_kind: null,
            $bash_mutation_targets: null,
            $plan_files: null,
            $backend_exec_type: null,
            $backend_exec_session_id: null,
            $backend_exec_pane_id: null,
            $worktree: null,
          });
          wakePending = true;
          pumpWakes();
          // `pumpWakes` drains synchronously, so the `AutopilotConfigSet` event is
          // now folded — this read reflects the worktree mode AS OF the applied
          // patch (the folded mode at reply time). A per-root cap stored while
          // worktree mode is off is dormant (effective 1); surface that gap as an
          // advisory note on the otherwise-successful reply.
          const folded = db
            .query("SELECT worktree_mode FROM autopilot_state WHERE id = 1")
            .get() as { worktree_mode: number | null } | null;
          const note = perRootStoredWhileOffNote(
            msg.patch,
            folded?.worktree_mode === 1,
          );
          reply = note
            ? { type: "set-autopilot-config-result", id, ok: true, note }
            : { type: "set-autopilot-config-result", id, ok: true };
        } catch (err) {
          reply = {
            type: "set-autopilot-config-result",
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
            $plan_op: null,
            $plan_target: null,
            $plan_epic_id: null,
            $plan_task_id: null,
            $plan_subject_present: null,
            $config_dir: null,
            $bash_mutation_kind: null,
            $bash_mutation_targets: null,
            $plan_files: null,
            $backend_exec_type: null,
            $backend_exec_session_id: null,
            $backend_exec_pane_id: null,
            $worktree: null,
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
      if (msg.kind === "request-handoff-request") {
        // APPEND a `HandoffRequested` synthetic event into the durable `handoffs`
        // projection (status=`requested`), then pump a wake. APPEND-ONLY, same
        // NO-relay contract as set-epic-armed: the dispatcher worker re-reads the
        // requested set each cycle. MAIN owns the full `jobs` projection, so it
        // resolves `initiator_job_id` best-effort by the raw pane HERE (the
        // worker-side handler is forbidden a DB connection); a null resolution is
        // tolerated (the raw coords always ride on the row + event).
        const id = msg.id;
        let reply: RequestHandoffResultMessage;
        try {
          // Read the brief back from the CLI's spill file and inline it into the
          // event EXACTLY as before — the doc rode through the filesystem (not the
          // wire) only because a 64KB inline frame overflows the UDS send buffer.
          // Durability is unchanged: the doc lands in `events.data`, so `keeper
          // handoff show` and the `handoffs` projection are byte-identical. A
          // missing/unreadable/oversized file is a LOUD `ok:false` failure (the new
          // real failure mode), never a silent hang.
          //
          // CONFINE the read to `handoffSpillDir` BEFORE touching the file: the
          // wire carries a fully caller-controlled `doc_path`, and an unconstrained
          // `readFileSync` is an arbitrary-file-read primitive (a foreign same-user
          // RPC could name `~/.ssh/id_ed25519` and exfiltrate it into the durable
          // `handoffs` projection). Resolve the realpath of both the dir and the
          // target (defeating symlink escapes) and require the target to sit under
          // the dir. `realpathSync` throws on a non-existent path; fall back to a
          // lexical resolve so a missing IN-DIR spill still flows to the loud
          // "cannot read" branch below rather than masquerading as out-of-dir.
          const realDir = ((): string => {
            try {
              return realpathSync(handoffSpillDir);
            } catch {
              return resolvePath(handoffSpillDir);
            }
          })();
          const realDoc = ((): string => {
            try {
              return realpathSync(msg.doc_path);
            } catch {
              return resolvePath(msg.doc_path);
            }
          })();
          if (realDoc !== realDir && !realDoc.startsWith(realDir + sep)) {
            sw.postMessage({
              type: "request-handoff-result",
              id,
              ok: false,
              error: `handoff spill file \`${msg.doc_path}\` resolves outside the spill dir \`${handoffSpillDir}\``,
            });
            return;
          }
          let doc: string;
          try {
            doc = readFileSync(realDoc, "utf8");
          } catch (readErr) {
            sw.postMessage({
              type: "request-handoff-result",
              id,
              ok: false,
              error: `cannot read handoff spill file \`${msg.doc_path}\`: ${
                readErr instanceof Error ? readErr.message : String(readErr)
              }`,
            });
            return;
          }
          if (doc.length === 0) {
            sw.postMessage({
              type: "request-handoff-result",
              id,
              ok: false,
              error: `handoff spill file \`${msg.doc_path}\` is empty`,
            });
            return;
          }
          const docBytes = Buffer.byteLength(doc, "utf8");
          if (docBytes > HANDOFF_DOC_MAX_BYTES) {
            sw.postMessage({
              type: "request-handoff-result",
              id,
              ok: false,
              error: `handoff spill file \`${msg.doc_path}\` is ${docBytes} bytes, over the ${HANDOFF_DOC_MAX_BYTES}-byte cap`,
            });
            return;
          }

          let initiatorJobId: string | null = null;
          if (msg.initiator_pane != null && msg.initiator_pane.length > 0) {
            // Newest live job on this pane wins (a pane is recycled across
            // sessions); `state` ordering keeps a live binder ahead of a terminal
            // one. Null-tolerant — an unfolded pane yields no row.
            const jobRow = db
              .query(
                `SELECT job_id FROM jobs
                  WHERE backend_exec_pane_id = ?
                  ORDER BY created_at DESC
                  LIMIT 1`,
              )
              .get(msg.initiator_pane) as { job_id: string } | null;
            initiatorJobId = jobRow?.job_id ?? null;
          }
          // Host-global uniqueness: probe the events log for the slug and, on a
          // hit, REJECT (never suffix — the slug is user-authored). The probe and
          // the append below are ONE synchronous unit with NO `await` between
          // them, so the single-writer lock makes the check race-free (the only
          // race vector). `conflict:true` routes the CLI to exit 3. The probe is
          // producer-only — it NEVER enters the fold (the resolved slug is frozen
          // in `events.data`; replay never re-checks uniqueness).
          if (handoffSlugExists(msg.desired_slug, db)) {
            sw.postMessage({
              type: "request-handoff-result",
              id,
              ok: false,
              conflict: true,
              error: `handoff slug \`${msg.desired_slug}\` is already in use on this host — pick a new slug`,
            });
            return;
          }
          stmts.insertEvent.run({
            $ts: Date.now() / 1000,
            // The resolved slug is frozen as the entity-key overload so a re-fold
            // correlates the event to its `handoffs` row (never re-slugified).
            $session_id: msg.desired_slug,
            $pid: null,
            $hook_event: "HandoffRequested",
            $event_type: "handoffs",
            $tool_name: null,
            $matcher: null,
            $cwd: null,
            $permission_mode: null,
            $agent_id: null,
            $agent_type: null,
            $stop_hook_active: null,
            $data: JSON.stringify({
              handoff_id: msg.desired_slug,
              doc,
              title: msg.title,
              target_session: msg.target_session,
              target_dir: msg.target_dir,
              initiator_session: msg.initiator_session,
              initiator_pane: msg.initiator_pane,
              initiator_job_id: initiatorJobId,
            }),
            $subagent_agent_id: null,
            $spawn_name: null,
            $start_time: null,
            $slash_command: null,
            $skill_name: null,
            $plan_op: null,
            $plan_target: null,
            $plan_epic_id: null,
            $plan_task_id: null,
            $plan_subject_present: null,
            $config_dir: null,
            $bash_mutation_kind: null,
            $bash_mutation_targets: null,
            $plan_files: null,
            $backend_exec_type: null,
            $backend_exec_session_id: null,
            $backend_exec_pane_id: null,
            $worktree: null,
          });
          wakePending = true;
          pumpWakes();
          reply = { type: "request-handoff-result", id, ok: true };
        } catch (err) {
          reply = {
            type: "request-handoff-result",
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
          // The wire `verb` / `dispatch_id` are validated handler-side; main treats
          // both as opaque payload tokens.
          mintDispatchClearedEvent(msg.verb, msg.dispatch_id);
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

  // fn-897 B1: NOW run the synchronous boot drain + seed sweep + git boot-seed +
  // ephemeral-truncate. The read-only server worker is already bound (above), so
  // the control socket is reachable while this catch-up runs; every served frame
  // carries `catching_up: true` until we signal boot-complete just below. This is
  // also where the early server's reader connection becomes a concurrent
  // attachment during the final `wal_checkpoint(TRUNCATE)` (see
  // `withBootDrainCheckpointTuning`): the reader is autocommit/idle between
  // queries, so TRUNCATE usually still collapses the WAL; if a poll-tick read
  // happens to pin a frame, TRUNCATE degrades to busy/PASSIVE semantics (returns a
  // busy ROW, never throws) and the steady-state PASSIVE heartbeat reclaims the
  // space on the next cadence — an accepted, documented degrade.
  serveBootDrain();

  // One-shot GC for orphaned dispatch_failures. The drain above folded the
  // projection to head, so any UN-retryable row (a key the operator surface can
  // never clear) is now visible. Sweep each by minting the sanctioned
  // `DispatchCleared`, then pump so they fold before steady state. Idempotent and
  // self-healing: once cleared, later boots find none — so it stays silent at zero
  // and logs only when it acts.
  {
    const swept = gcUnretryableDispatchFailures(db, mintDispatchClearedEvent);
    if (swept > 0) {
      console.error(
        `[keeperd] boot GC cleared ${swept} un-retryable dispatch_failures orphan(s)`,
      );
      wakePending = true;
      pumpWakes();
    }
  }

  // Crash-loop distress signal. Fold this boot into the durable restart ledger (a
  // state-dir sidecar — NOT keeper.db, NOT a fold — so it survives the very crash
  // it measures), then LEVEL-TRIGGER a sticky `needs_human` distress row: a boot
  // rate at/over the threshold inside the window mints ONE row on the synthetic
  // crash-loop key (idempotent — the fold UPSERTs, so a persistent loop is one row,
  // not one per boot); a boot whose rate has fallen back under threshold drops the
  // row (the recover-row idiom, resolved on the NEXT boot as the window ages out
  // the old timestamps). A hot ledger inherited by a healthy post-fix boot reports
  // honestly, then self-clears. FAIL-OPEN throughout — a corrupt ledger folds to
  // empty, so the crash-loop detector can never itself become new boot-crash fuel.
  {
    const nowMs = Date.now();
    const ledgerPath = resolveRestartLedgerPath();
    const bootTimestamps = updateRestartLedger({
      existing: readRestartLedger(ledgerPath),
      nowMs,
      windowMs: CRASH_LOOP_WINDOW_MS,
      cap: RESTART_LEDGER_CAP,
    });
    writeRestartLedger(ledgerPath, bootTimestamps);
    const verdict = decideCrashLoop({
      nowMs,
      bootTimestamps,
      threshold: CRASH_LOOP_THRESHOLD,
      windowMs: CRASH_LOOP_WINDOW_MS,
    });
    const distressPresent =
      db
        .query(
          "SELECT 1 FROM dispatch_failures WHERE verb = ? AND id = ? LIMIT 1",
        )
        .get(CRASH_LOOP_DISTRESS_VERB, CRASH_LOOP_DISTRESS_ID) != null;
    const windowMin = Math.round(CRASH_LOOP_WINDOW_MS / 60_000);
    if (verdict.crashLoop && !distressPresent) {
      console.error(
        `[keeperd] crash-loop distress: ${verdict.recentBoots} boots within ${windowMin}min (threshold ${CRASH_LOOP_THRESHOLD}) — minting a sticky needs_human signal`,
      );
      mintCrashLoopDistress(
        `${CRASH_LOOP_DISTRESS_REASON}: ${verdict.recentBoots} daemon boots in ${windowMin}min — the serve/boot path is restart-looping (see server.stderr)`,
        nowMs / 1000,
      );
    } else if (!verdict.crashLoop && distressPresent) {
      console.error(
        "[keeperd] crash-loop distress cleared: boot rate recovered under threshold",
      );
      mintDispatchClearedEvent(
        CRASH_LOOP_DISTRESS_VERB,
        CRASH_LOOP_DISTRESS_ID,
      );
      wakePending = true;
      pumpWakes();
    }
  }

  // fn-897 B1: drain reached head + git-seed + ephemeral-truncate are done.
  // Flip the server worker's boot gate so mutating RPCs are accepted and the
  // `catching_up` header settles. One-way, idempotent; `?.` tolerates a
  // server-less boot. The autopilot actuator (spawned below) is the OTHER gated
  // surface — it arms only after this point because it spawns AFTER this line.
  serverWorker?.postMessage({
    type: "boot-complete",
  } satisfies BootCompleteMessage);

  // Resume the last durable paused state. `serveBootDrain()` above drained to
  // head, so the `autopilot_state` singleton now carries the durable `paused`
  // flag — read it and seed the in-memory `autopilotPaused` (initialized `true`)
  // from it. An intentional `play` therefore survives a restart (durable
  // `paused=0` → boots PLAYING); a fresh board with no `AutopilotPaused` history
  // boots PAUSED via the `AutopilotCapSet` INSERT default. REUSE
  // `projectAutopilotPaused` and honor its null-means-empty contract: an empty
  // singleton returns `null`, which leaves the boots-paused default intact (a
  // bare assignment would coerce that to a truthy/falsy wrong value). Run
  // unconditionally (cheap, one singleton SELECT) even when `want("autopilot")`
  // is false — it keeps the flag honest for the `set_autopilot_paused` RPC's
  // null-guard relay path on a server-only boot.
  {
    const autopilotRows = db
      .query("SELECT paused FROM autopilot_state WHERE id = 1")
      .all() as Record<string, unknown>[];
    const seededPaused = projectAutopilotPaused(autopilotRows);
    if (seededPaused !== null) {
      autopilotPaused = seededPaused;
    }
    // Playing-after-reboot is the new, surprising-by-default behavior — log it
    // once so an operator can tell a resumed-play from a play-RPC after boot.
    if (!autopilotPaused) {
      console.error(
        "[keeperd] autopilot resuming PLAYING from persisted state (durable paused=0)",
      );
    }
  }

  // Spawn the transcript worker in the SAME post-migration window. It watches
  // the external transcript tree and posts a `transcript-title` message whenever
  // it tails a `custom-title` line — making the daemon an event PRODUCER for the
  // first time. The watch root is resolved ON MAIN via `resolveClaudeProjectsRoot()`
  // (config `claude_projects_root` → absolute path, default `~/.claude/projects`)
  // and passed as the always-populated `workerData.watchRoot`, mirroring how the
  // plan worker receives `roots: resolvePlanRoots()`.
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
        | SubagentTurnMessage
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
          $plan_op: null,
          $plan_target: null,
          $plan_epic_id: null,
          $plan_task_id: null,
          $plan_subject_present: null,
          $config_dir: null,
          $bash_mutation_kind: null,
          $bash_mutation_targets: null,
          $plan_files: null,
          $backend_exec_type: null,
          $backend_exec_session_id: null,
          $backend_exec_pane_id: null,
          $worktree: null,
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
          $plan_op: null,
          $plan_target: null,
          $plan_epic_id: null,
          $plan_task_id: null,
          $plan_subject_present: null,
          $config_dir: null,
          $bash_mutation_kind: null,
          $bash_mutation_targets: null,
          $plan_files: null,
          $backend_exec_type: null,
          $backend_exec_session_id: null,
          $backend_exec_pane_id: null,
          $worktree: null,
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
          $plan_op: null,
          $plan_target: null,
          $plan_epic_id: null,
          $plan_task_id: null,
          $plan_subject_present: null,
          $config_dir: null,
          $bash_mutation_kind: null,
          $bash_mutation_targets: null,
          $plan_files: null,
          $backend_exec_type: null,
          $backend_exec_session_id: null,
          $backend_exec_pane_id: null,
          $worktree: null,
        });
        wakePending = true;
        pumpWakes();
        return;
      }
      if (msg.kind === "subagent-turn") {
        // Synthetic `SubagentTurn` event minted from the transcript-worker
        // signal — the terminal disposition of a subagent's most recent
        // assistant turn. The reducer's `SubagentTurn` arm stamps it onto the
        // `subagent_invocations` row's `last_disposition`; the SubagentStop fold
        // reads it to recognize a SILENT_STREAM_CUT (`disposition='cut'`) and
        // flip the still-`working` parent job to `stopped`, driving auto-resume
        // faster than the dead-pid reprobe. The subagent's `agentId` rides in
        // `agent_id` (the field SubagentStart/Stop fold on); the disposition in
        // `data.disposition`; everything else is NULL (synthetic).
        stmts.insertEvent.run({
          $ts: Date.now() / 1000,
          $session_id: msg.sessionId,
          $pid: null,
          $hook_event: "SubagentTurn",
          $event_type: "subagent_turn",
          $tool_name: null,
          $matcher: null,
          $cwd: null,
          $permission_mode: null,
          $agent_id: msg.agentId,
          $agent_type: null,
          $stop_hook_active: null,
          $data: JSON.stringify({ disposition: msg.disposition }),
          $subagent_agent_id: null,
          $spawn_name: null,
          $start_time: null,
          $slash_command: null,
          $skill_name: null,
          $plan_op: null,
          $plan_target: null,
          $plan_epic_id: null,
          $plan_task_id: null,
          $plan_subject_present: null,
          $config_dir: null,
          $bash_mutation_kind: null,
          $bash_mutation_targets: null,
          $plan_files: null,
          $backend_exec_type: null,
          $backend_exec_session_id: null,
          $backend_exec_pane_id: null,
          $worktree: null,
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
  // configured project root's `.keeper/{epics,tasks}` trees and posts a
  // `plan-epic`/`plan-task` snapshot message on each change — the second
  // producer-worker instance. `roots` come from `resolvePlanRoots()` (config →
  // absolute, existing dirs); an empty list means there is nothing to watch.
  // Gated on the selector. Cross-referenced by the git-worker handler (the
  // plan-commit-changed forward) via `planWorker?.postMessage` — null-safe
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
        // Discovery nudge: the plan-worker first saw a `.keeper` tree in
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
          // The epic-level parked-closer question, sourced from the
          // gitignored `.state.json` runtime overlay — rides free in the
          // blob like every other plan-native field (no schema surprise; the
          // reducer folds it onto `epics.question`).
          question: msg.question,
        });
      } else if (msg.kind === "plan-task") {
        hookEvent = "TaskSnapshot";
        data = JSON.stringify({
          epic_id: msg.epicId,
          task_number: msg.number,
          title: msg.title,
          target_repo: msg.targetRepo,
          // plan-native effort tier — rides FREE in the embedded-tasks JSON
          // (no schema column). An older blob lacks this key and the reducer
          // reads `snapshot.tier ?? null` (graceful degradation).
          tier: msg.tier,
          // plan-native worker model — rides FREE in the embedded-tasks JSON
          // (no schema column, like `tier`). An older blob lacks this key and
          // the reducer reads `snapshot.model ?? null` (graceful degradation).
          model: msg.model,
          // Derived worker-phase binary (`worker_done_at` present → "done", else
          // "open"), kept distinct from `runtime_status` (plan's native enum).
          worker_phase: msg.workerPhase,
          // plan-native runtime status (`todo|in_progress|done|blocked`).
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
        $plan_op: null,
        $plan_target: null,
        $plan_epic_id: null,
        $plan_task_id: null,
        $plan_subject_present: null,
        $config_dir: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $plan_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
        $worktree: null,
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

  // The autoclose worker (spawned far below) posts a pre-kill intent hint here so
  // the exit-watcher's SOLE Killed mint can relabel the resulting row
  // `kill_reason: 'autoclosed'`. Declared in the exit worker's scope so the mint
  // site can consume it; the TTL outlives the slowest reprobe-backstop observe.
  const autocloseHints = new AutocloseHintSet(AUTOCLOSE_HINT_TTL_MS);

  if (exitWorker) {
    const ew = exitWorker;
    // Main stays the SOLE writer: an `exit` message becomes a synthetic `Killed`
    // events row on the WRITABLE connection, then a wake pump folds it. Before
    // minting, re-read the persisted row and match `(pid, start_time)` against the
    // message snapshot — strict when both carry a start_time, loose pid-only when
    // either is NULL. A strict mismatch is a race-recovered stale event (the row
    // was re-opened with a fresh process); skip it. The reducer's Killed fold also
    // double-checks; this verifier just keeps the event log tight.
    ew.onmessage = (
      ev: MessageEvent<ExitWatcherOutbound | undefined>,
    ): void => {
      const msg = ev.data;
      if (!msg) {
        return;
      }
      // fn-1096.3: a tolerated-NOTADB skip record — route to the sole
      // sidecar writer, same as the plan/git-worker backstop channel.
      if (msg.kind === "backstop") {
        handleBackstopMessage(msg);
        return;
      }
      // ADR 0013 layer 3: the stuck-state sentinel's heal + anomaly mint. Main is
      // the sole writer — the worker already ran the pure predicate + change-gate,
      // so main just executes the corrective `StopReconciled` (when `heal`) and the
      // sticky `stuck-sentinel` anomaly row. NON-FATAL on mint failure.
      if (msg.kind === "stuck-sentinel") {
        handleStuckSentinelMint(msg);
        return;
      }
      if (msg.kind !== "exit") {
        return;
      }
      // Re-read the row to confirm the message's pid + start_time still match
      // what's persisted. A non-matching row means the session was re-opened
      // (and the new process is presumably alive) — skip silently.
      const row = db
        .query(
          "SELECT pid, start_time, state, backend_exec_pane_id FROM jobs WHERE job_id = ?",
        )
        .get(msg.jobId) as {
        pid: number | null;
        start_time: string | null;
        state: string;
        backend_exec_pane_id: string | null;
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
      // Classify WHY this session died via the SAME main-side tmux probe the
      // boot seed-sweep uses (`classifyCloseKind`), so the steady-state and
      // boot producers stamp `close_kind` identically. The kind rides the
      // payload blob (no `events` column changes); the reducer folds it to
      // `jobs.close_kind` as an opaque string copy for the crash-restore set.
      const closeKind = classifyCloseKind(row.backend_exec_pane_id);
      // WHY keeper reaped: the steady-state exit-watcher observed this process
      // exit (distinct from the boot seed sweep's `boot_*` reasons). Rides the
      // payload blob; the reducer folds it onto `jobs.kill_reason` opaquely. A
      // live, identity-matching autoclose intent hint (posted just before the
      // worker force-closed the window) relabels it `autoclosed` — consumed at
      // most once; an absent/expired/mismatched hint keeps `exit_watched`.
      const killReason: KillReason = autocloseHints.consume(
        msg.jobId,
        msg.pid,
        msg.startTime,
      )
        ? "autoclosed"
        : "exit_watched";
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
        $data: JSON.stringify({
          pid: msg.pid,
          start_time: msg.startTime,
          close_kind: closeKind,
          reason: killReason,
        }),
        $subagent_agent_id: null,
        $spawn_name: null,
        $start_time: null,
        $slash_command: null,
        $skill_name: null,
        $plan_op: null,
        $plan_target: null,
        $plan_epic_id: null,
        $plan_task_id: null,
        $plan_subject_present: null,
        $config_dir: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $plan_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
        $worktree: null,
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
      if (msg.kind === "plan-commit-changed") {
        // Authoritative commit-driven plan ingest: the git-worker observed a
        // commit carrying changed `.keeper/**` paths; forward them to plan-worker
        // so it re-ingests each from the COMMITTED worktree bytes via its
        // idempotent `onChange`/`onDelete`. NOT written to the event log — this
        // channel drives a producer worker, not a projection. The `?.` is
        // null-safe for a git-only boot (no plan worker).
        planWorker?.postMessage({
          type: msg.kind,
          repo: msg.project_dir,
          changes: msg.changes,
        } satisfies PlanCommitChangedMessage);
        return;
      }
      if (msg.kind === "git-liveness") {
        // fn-921 supervisor liveness pulse — the seed-liveness watchdog reads the
        // time since this to tell "alive + ticking" from "alive but stuck". Pure
        // side channel; never folded.
        lastGitLivenessAtMs = msg.at_ms;
        return;
      }
      let hookEvent: string;
      let data: string;
      if (msg.kind === "git-snapshot") {
        hookEvent = "GitSnapshot";
        // fn-921: a delivered snapshot is the strongest liveness signal AND real
        // progress (it may clear a stuck `seed_required`) — stamp both anchors so
        // the watchdog re-measures staleness from here.
        const now = Date.now();
        lastGitProgressAtMs = now;
        lastGitLivenessAtMs = now;
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
        $plan_op: null,
        $plan_target: null,
        $plan_epic_id: null,
        $plan_task_id: null,
        $plan_subject_present: null,
        $config_dir: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $plan_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
        $worktree: null,
      });
      // A `git-snapshot` or `commit` is the cross-worker "HEAD may have moved"
      // signal a plan-worker cannot observe on its own (a `git commit` leaves the
      // `.keeper/*.json` bytes identical, so FSEvents won't re-fire). Fire
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
  // agentusage daemon's flat leaf state dir (`~/.local/state/agentusage/`) and
  // posts `{kind: "usage-snapshot" | "usage-deleted", ...}` messages — the
  // fifth file-watcher producer-worker instance. Main turns each into a
  // synthetic `UsageSnapshot`/`UsageDeleted` events row on its writable
  // connection. The watch root is resolved on main via `resolveUsageRoot()`
  // and tolerates absence (agentusage may not have run yet).
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
    // folds it. The agentusage profile id rides in `session_id`; the flattened
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
        $session_id: msg.id, // the entity pk: agentusage profile id
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
        $plan_op: null,
        $plan_target: null,
        $plan_epic_id: null,
        $plan_task_id: null,
        $plan_subject_present: null,
        $config_dir: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $plan_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
        $worktree: null,
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

  // Spawn the statusline worker in the SAME post-migration window (fn-1024). It
  // watches the keeper-managed statusLine leaf dir (`~/.local/state/keeper/
  // statusline/`, one `<token>.json` per session written by `keeper
  // statusline-sink`) and posts `{kind: "session-telemetry", ...}` messages —
  // the sixth file-watcher producer-worker instance. Main turns each into a
  // synthetic `SessionTelemetry` events row on its writable connection. The watch
  // root is resolved on main via `resolveStatuslineRoot()` and tolerates absence
  // (no keeper-agent claude session may have rendered a statusLine yet). Gated on
  // the selector — `null` when unselected.
  const statuslineWorker = want("statusline")
    ? new Worker(new URL("./statusline-worker.ts", import.meta.url).href, {
        workerData: {
          dbPath,
          root: resolveStatuslineRoot(),
          disableNativeWatcher: opts.disableNativeWatcher,
        } satisfies StatuslineWorkerData,
      } as WorkerOptions & { workerData: unknown })
    : null;

  if (statuslineWorker) {
    const stw = statuslineWorker;
    // Main stays the SOLE writer: a `session-telemetry` message becomes a
    // synthetic `SessionTelemetry` events row on the WRITABLE connection, then a
    // wake pump folds it latest-wins onto the six v100 jobs telemetry columns.
    // The RAW claude `session_id` (== `jobs.job_id`, the fold's only match key)
    // rides in `session_id`; the flattened snapshot in `data`. Everything else is
    // NULL. There is NO tombstone kind — a leaf delete never nulls the columns.
    stw.onmessage = (
      ev: MessageEvent<SessionTelemetryMessage | undefined>,
    ): void => {
      const msg = ev.data;
      if (!msg || msg.kind !== "session-telemetry") return;
      // Tolerant mint (shared with usage): a transient writer-lock miss is
      // logged-and-dropped (recoverable via change-gated re-emit / boot scan)
      // instead of crashing the daemon; real corruption still throws through to
      // `fatalExit`.
      const minted = mintUsageEventTolerant({
        $ts: Date.now() / 1000,
        $session_id: msg.id, // RAW claude session_id === jobs.job_id
        $pid: null,
        $hook_event: "SessionTelemetry",
        $event_type: "session_telemetry",
        $tool_name: null,
        $matcher: null,
        $cwd: null,
        $permission_mode: null,
        $agent_id: null,
        $agent_type: null,
        $stop_hook_active: null,
        // Pre-flattened payload — the reducer never re-reads the on-disk leaf.
        // Pinned by a direct test on `serializeSessionTelemetry`.
        $data: serializeSessionTelemetry(msg),
        $subagent_agent_id: null,
        $spawn_name: null,
        $start_time: null,
        $slash_command: null,
        $skill_name: null,
        $plan_op: null,
        $plan_target: null,
        $plan_epic_id: null,
        $plan_task_id: null,
        $plan_subject_present: null,
        $config_dir: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $plan_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
        $worktree: null,
      });
      if (minted) {
        wakePending = true;
        pumpWakes();
      }
    };

    stw.onerror = (err: ErrorEvent): void => {
      console.error("[keeperd] statusline worker error:", err.message ?? err);
      if (!shuttingDown) fatalExit();
    };

    stw.addEventListener("close", () => {
      if (!shuttingDown) fatalExit();
    });
  } // end `if (statuslineWorker)`

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
        $plan_op: null,
        $plan_target: null,
        $plan_epic_id: null,
        $plan_task_id: null,
        $plan_subject_present: null,
        $config_dir: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $plan_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
        $worktree: null,
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

  // Spawn the usage-scraper PRODUCER worker — the in-process port of the retired
  // agentusage daemon. It runs N per-account scrape loops and writes ONLY the
  // on-disk `<id>.json` / `.error.json` / `events.jsonl` envelopes under the
  // agentusage state root; the existing `usage` CONSUMER worker watches that same
  // dir and mints the events, so the scraper posts NO messages to main and needs
  // no `onmessage` minting. NOT a file-watcher (not in WATCHER_WORKERS). Gated on
  // the plain worker selector — the scrape entry is first-class keeper source
  // (always present), and the scraped model SET is governed by config declaring
  // models (resolved inside the worker), so there is no runtime-resolution gate.
  // The state dir is resolved on main via `resolveUsageRoot()` so the
  // `KEEPER_AGENTUSAGE_ROOT` sandbox seam moves the producer + the consumer
  // together.
  const usageScraperWorker = want("usageScraper")
    ? new Worker(new URL("./usage-scraper-worker.ts", import.meta.url).href, {
        workerData: {
          dbPath,
          stateDir: resolveUsageRoot(),
        } satisfies UsageScraperWorkerData,
      } as WorkerOptions & { workerData: unknown })
    : null;

  if (usageScraperWorker) {
    const usw = usageScraperWorker;
    // No message minting — the producer's only output is its on-disk envelopes
    // (the consumer worker turns those into events). Wire only the crash guards:
    // a producer crash is fatal like every other worker (the `!shuttingDown`
    // gate keeps an orderly teardown quiet).
    usw.onerror = (err: ErrorEvent): void => {
      console.error(
        "[keeperd] usage-scraper worker error:",
        err.message ?? err,
      );
      if (!shuttingDown) fatalExit();
    };

    usw.addEventListener("close", () => {
      if (!shuttingDown) fatalExit();
    });
  } // end `if (usageScraperWorker)`

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

  // The births-tree watch-hint thread (fn-1103), the twin of the events-ingest
  // worker. Watches the births maildir and posts a contentless
  // `{kind:"birth-records-changed"}`. The worker holds NO DB handle — main
  // re-runs `scanBirthDir` on each message, minting a synthetic SessionStart per
  // record (process-then-retire, idempotent fold) then pumping a wake. Spawns
  // AFTER the boot ingest so the tree state is settled. In-process fold/UDS tests
  // inject via DIRECT DB INSERT, not this path. Gated on the selector — `null`
  // when unselected.
  const birthIngestWorker = want("birthIngest")
    ? new Worker(new URL("./birth-ingest-worker.ts", import.meta.url).href, {
        workerData: {
          dir: birthDir,
          disableNativeWatcher: opts.disableNativeWatcher,
        } satisfies BirthIngestWorkerData,
      } as WorkerOptions & { workerData: unknown })
    : null;

  if (birthIngestWorker) {
    const biw = birthIngestWorker;
    // Main owns the write: a `birth-records-changed` message triggers a fresh
    // `scanBirthDir` (the watcher event is "go look", never the data). A wake IS
    // pumped — the mint goes to `events` (the fold source), so the reducer must
    // fold it into the tracked jobs row.
    biw.onmessage = (
      ev: MessageEvent<BirthRecordsChangedMessage | undefined>,
    ): void => {
      const msg = ev.data;
      if (!msg || msg.kind !== "birth-records-changed") {
        return;
      }
      try {
        scanBirthDir(db, birthDir, eventsIngestCtx);
        wakePending = true;
        pumpWakes();
      } catch (err) {
        // Defense-in-depth: an unexpected internal throw must NOT crash the
        // daemon. Log and continue — the next watcher event retries the ingest.
        console.error(
          `[keeperd] births live ingest threw (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    };

    // Same crash policy as the other workers: any thread failure → fatalExit.
    biw.onerror = (err: ErrorEvent): void => {
      console.error("[keeperd] birth-ingest worker error:", err.message ?? err);
      if (!shuttingDown) fatalExit();
    };

    // Same crash-via-`close` gap: a `process.exit(1)` fires `close`, not
    // `onerror`. `!shuttingDown` makes it inert on clean shutdown.
    biw.addEventListener("close", () => {
      if (!shuttingDown) fatalExit();
    });
  } // end `if (birthIngestWorker)`

  // The autopilot reconciler worker runs the level-triggered dispatch loop
  // server-side: data_version wake → desired-vs-observed verdict → launch via
  // keeper agent → confirm → mint on ceiling (bridged through main). The pure
  // decision logic lives in `src/autopilot-worker.ts`; this spawn is the glue.
  // Boots from the `paused: autopilotPaused` workerData — `autopilotPaused` was
  // seeded from the durable `autopilot_state.paused` column after the boot drain,
  // so the worker resumes the last durable state (PLAYING if a `play` was the
  // last durable intent) and a fresh board boots PAUSED. Steady-state the flag
  // flips ONLY via the `set_autopilot_paused` RPC → bridge → `{type:"set-paused"}`
  // relay. The concurrency cap is NO LONGER threaded from config here — it is
  // RUNTIME-settable via `set_autopilot_config` and the reconciler reads it from
  // the `autopilot_state` projection each cycle. `apConfig` survives for the other
  // worker-launch knobs (the launcher prefix prefixes / handoff prompt prefix).
  const apConfig = resolveConfig();
  // The launcher argv prefix (`[bun, cli/keeper.ts, "agent"]`) the reconciler
  // spawns to reach the folded `keeper agent` launcher — keeper's sole launch
  // transport. Resolved once on main (`process.execPath` + env override + config +
  // `~`-expansion), boot-checked for presence, then frozen into workerData;
  // restart-to-apply (a config flip lags until restart).
  const launcherArgvPrefix = buildLauncherArgvPrefix(
    process.execPath,
    resolveKeeperAgentPath(),
  );
  // Fail-fast self-check ONLY where launch is reachable (the autopilot gate): a
  // loud boot warning naming the resolved launcher pre-empts the per-launch
  // ENOENT → never-bound-breaker spiral. Never hard-exits — reads + pane-ops still
  // serve without a launchable launcher.
  if (want("autopilot")) {
    checkKeeperAgentPresence(launcherArgvPrefix);
  }
  // Gated on the selector — `null` when unselected. The server-worker bridge's
  // `set_autopilot_paused` relay null-guards via `autopilotWorker === null`, so a
  // server-only boot's pause RPC degrades gracefully.
  const autopilotWorkerInstance = want("autopilot")
    ? new Worker(new URL("./autopilot-worker.ts", import.meta.url).href, {
        workerData: {
          dbPath,
          paused: autopilotPaused,
          launcherArgvPrefix,
          role: "autopilot",
        } satisfies AutopilotWorkerData,
      } as WorkerOptions & { workerData: unknown })
    : null;
  // Wire the forward reference so the server-worker's bridge handler can target
  // the autopilot worker. Assign BEFORE the handlers fire so the first bridge
  // request never sees a `null` worker. (Stays `null` when unselected — the
  // bridge null-guard covers that.)
  autopilotWorker = autopilotWorkerInstance;

  // The `handleDispatch*` mint helpers + the sweep/retention/checkpoint timers
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
        | DispatchClearedMessage
        | DispatchedMessage
        | DispatchExpiredMessage
        | WorktreeRepoStatusMessage
        | LaneMergedMessage
        | SharedWedgeDistressMessage
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
      } else if (msg.kind === "worktree-repo-status") {
        handleWorktreeRepoStatusMint(msg.entries);
      } else if (msg.kind === "lane-merged") {
        handleLaneMergedMint(msg.entries);
      } else if (msg.kind === "dispatch-cleared") {
        handleDispatchClearedMint(msg.payload);
      } else if (msg.kind === "shared-wedge-distress") {
        // Per-repo shared-checkout-wedge distress: main is the sole writer of the
        // synthetic `daemon`-verb row. The worker's grace tracker already decided
        // exactly-once mint / level-clear; main just executes it.
        if (msg.action === "mint") {
          mintSharedWedgeDistress(
            msg.id,
            msg.reason ?? "",
            msg.ts ?? Date.now() / 1000,
            msg.dir,
          );
        } else {
          mintDispatchClearedEvent(SHARED_WEDGE_DISTRESS_VERB, msg.id);
        }
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

  // The `keeper handoff` dispatch worker — the process-manager reactor that
  // launches a fire-and-forget handoff-ee into the INITIATOR's tmux session. It
  // shares the autopilot's launcher prefix (`keeper agent`, the sole launch
  // transport) and mint-before-launch protocol, but its decider is the durable
  // boot-recovery decision table over the `handoffs` projection (the projection
  // SURVIVES boot, unlike `pending_dispatches`, so the lease + bind check is the
  // double-dispatch guard). Gated on the selector — `null` when unselected. The
  // worker reads keeper.db read-only; every mutation round-trips through main as
  // a synthetic `HandoffDispatching` / `HandoffLaunchFailed` event. `cwd` is
  // keeperd's own cwd (a handoff-ee carries no plan ref; keeper agent reads its own
  // process.cwd for the launch-script `cd`).
  const handoffWorkerInstance = want("handoff")
    ? new Worker(new URL("./handoff-worker.ts", import.meta.url).href, {
        workerData: {
          dbPath,
          launcherArgvPrefix,
          handoffPromptPrefix: apConfig.handoffPromptPrefix,
          cwd: process.cwd(),
        } satisfies HandoffWorkerData,
      } as WorkerOptions & { workerData: unknown })
    : null;

  if (handoffWorkerInstance) {
    const hw = handoffWorkerInstance;
    // Worker → main: the durable `HandoffDispatching` mint (ack round-trip) and
    // the terminal `HandoffLaunchFailed` mint (+ dead-letter). Workers never
    // write the DB; the producer-side intent rides the synthetic event and the
    // fold owns the projection. NON-FATAL on insert failure — the next cycle
    // re-attempts (the lease + bind check make re-dispatch idempotent).
    hw.onmessage = (
      ev: MessageEvent<HandoffOutboundMessage | undefined>,
    ): void => {
      const msg = ev.data;
      if (!msg) return;
      if (msg.kind === "handoff-dispatching-request") {
        handleHandoffDispatchingMint(msg);
      } else if (msg.kind === "handoff-launch-failed") {
        handleHandoffLaunchFailedMint(msg.payload);
      }
    };

    hw.onerror = (err: ErrorEvent): void => {
      console.error("[keeperd] handoff worker error:", err.message ?? err);
      if (!shuttingDown) fatalExit();
    };

    hw.addEventListener("close", () => {
      if (!shuttingDown) fatalExit();
    });
  } // end `if (handoffWorkerInstance)`

  /**
   * Mint a synthetic `HandoffDispatching` event AND reply a durable
   * `handoff-dispatching-ack{id, ok}`. The reducer's fold advances the matching
   * `handoffs` row to `dispatching`, stamps `claimed_at` from the event ts (the
   * lease anchor), and bumps `never_bound_count` (the breaker trips at K=3). The
   * handoff_id rides the entity-key overload on `session_id` so a re-fold
   * correlates it WITHOUT re-parsing `data`.
   *
   * DURABLE before launch: the worker AWAITS this ack BEFORE it launches, so the
   * reply MUST fire on every path (`ok:true` once the insert lands, `ok:false`
   * when it throws). The worker launches only on `ok:true`. NON-FATAL on insert
   * failure. Mirrors {@link handleDispatchedMint}.
   */
  function handleHandoffDispatchingMint(msg: HandoffDispatchingMessage): void {
    const { id, payload } = msg;
    const data = JSON.stringify(payload);
    let ok = false;
    try {
      stmts.insertEvent.run({
        $ts: Date.now() / 1000,
        $session_id: payload.handoff_id,
        $pid: null,
        $hook_event: "HandoffDispatching",
        $event_type: "handoffs",
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
        $plan_op: null,
        $plan_target: null,
        $plan_epic_id: null,
        $plan_task_id: null,
        $plan_subject_present: null,
        $config_dir: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $plan_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
        $worktree: null,
      });
      ok = true;
    } catch (err) {
      console.error(
        `[keeperd] HandoffDispatching mint threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    // Reply on EVERY path — the worker is blocked awaiting this ack before it
    // launches; a `false` reply tells it to abort. Reply IMMEDIATELY after the
    // INSERT, BEFORE the (potentially slow) reducer pump. The `?.` keeps it
    // null-safe on an unselected-handoff boot.
    handoffWorkerInstance?.postMessage({
      type: "handoff-dispatching-ack",
      id,
      ok,
    } satisfies HandoffDispatchingAckMessage);
    if (ok) {
      try {
        wakePending = true;
        pumpWakes();
      } catch (err) {
        console.error(
          `[keeperd] HandoffDispatching pump threw (non-fatal, ack already sent): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /**
   * Mint a synthetic `HandoffLaunchFailed` event (flips the `handoffs` row to
   * terminal `failed`) AND write a `dead_letters` row — a PERMANENT launch
   * failure (keeper agent exit 1/2/3 / a thrown launch). The dead-letter is a
   * DIRECT operational-table write (NOT an event fold), mirroring
   * {@link scanDeadLetterDir}'s INSERT shape, keyed on a fresh `dl_id`. NON-FATAL
   * on either write — the row stays `dispatching` and the never-bound breaker
   * eventually goes sticky.
   */
  function handleHandoffLaunchFailedMint(
    payload: HandoffLaunchFailedMessage["payload"],
  ): void {
    const data = JSON.stringify(payload);
    const nowSec = Date.now() / 1000;
    try {
      stmts.insertEvent.run({
        $ts: nowSec,
        $session_id: payload.handoff_id,
        $pid: null,
        $hook_event: "HandoffLaunchFailed",
        $event_type: "handoffs",
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
        $plan_op: null,
        $plan_target: null,
        $plan_epic_id: null,
        $plan_task_id: null,
        $plan_subject_present: null,
        $config_dir: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $plan_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
        $worktree: null,
      });
      wakePending = true;
      pumpWakes();
    } catch (err) {
      console.error(
        `[keeperd] HandoffLaunchFailed mint threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    // Dead-letter the permanent failure so the operator surface lists it. DIRECT
    // INSERT into `dead_letters` (the same shape `scanDeadLetterDir` uses), keyed
    // on a fresh `dl_id`. NON-FATAL — best-effort operational record.
    try {
      db.run(
        `INSERT OR IGNORE INTO dead_letters
           (dl_id, session_id, hook_event, ts, dl_written_at, pid, bindings,
            status, recovered_at, replayed_event_id, source_file)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', NULL, NULL, ?)`,
        [
          crypto.randomUUID(),
          payload.handoff_id,
          "HandoffLaunchFailed",
          nowSec,
          nowSec,
          null,
          data,
          "handoff-launch-failed",
        ],
      );
    } catch (err) {
      console.error(
        `[keeperd] HandoffLaunchFailed dead-letter write threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

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
        $plan_op: null,
        $plan_target: null,
        $plan_epic_id: null,
        $plan_task_id: null,
        $plan_subject_present: null,
        $config_dir: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $plan_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
        $worktree: null,
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
   * Mint the crash-loop distress `DispatchFailed` on the fixed synthetic key
   * ({@link CRASH_LOOP_DISTRESS_VERB}::{@link CRASH_LOOP_DISTRESS_ID}) — the
   * {@link handleDispatchFailedMint} shape, but the synthetic verb is not part of
   * the strict `DispatchFailedMessage` union so it rides its own thin closure.
   * `reason` MUST start with {@link CRASH_LOOP_DISTRESS_REASON} so the pill maps.
   * `ts` is producer-stamped for re-fold determinism. NON-FATAL on insert failure.
   */
  function mintCrashLoopDistress(reason: string, tsSec: number): void {
    try {
      stmts.insertEvent.run({
        $ts: Date.now() / 1000,
        $session_id: `${CRASH_LOOP_DISTRESS_VERB}::${CRASH_LOOP_DISTRESS_ID}`,
        $pid: null,
        $hook_event: "DispatchFailed",
        $event_type: "dispatch_failures",
        $tool_name: null,
        $matcher: null,
        $cwd: null,
        $permission_mode: null,
        $agent_id: null,
        $agent_type: null,
        $stop_hook_active: null,
        $data: JSON.stringify({
          verb: CRASH_LOOP_DISTRESS_VERB,
          id: CRASH_LOOP_DISTRESS_ID,
          reason,
          dir: null,
          ts: tsSec,
        }),
        $subagent_agent_id: null,
        $spawn_name: null,
        $start_time: null,
        $slash_command: null,
        $skill_name: null,
        $plan_op: null,
        $plan_target: null,
        $plan_epic_id: null,
        $plan_task_id: null,
        $plan_subject_present: null,
        $config_dir: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $plan_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
        $worktree: null,
      });
      wakePending = true;
      pumpWakes();
    } catch (err) {
      console.error(
        `[keeperd] crash-loop distress mint threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Mint a PER-REPO shared-checkout-wedge distress `DispatchFailed` on the synthetic
   * `${SHARED_WEDGE_DISTRESS_VERB}::${id}` key — the crash-loop distress shape, but
   * per-repo (the `id` carries `shared-checkout-wedge:<repoHash>`) and carrying the
   * wedged `dir`. The worker's grace tracker gates it to exactly-once per wedge
   * episode; the fold UPSERTs on `(verb, id)`, so a re-mint after a restart is
   * idempotent. `reason` starts with the shared-wedge display prefix so the pill
   * maps; `ts` is producer-stamped for re-fold determinism. NON-FATAL on failure.
   */
  function mintSharedWedgeDistress(
    id: string,
    reason: string,
    tsSec: number,
    dir: string | null,
  ): void {
    try {
      stmts.insertEvent.run({
        $ts: Date.now() / 1000,
        $session_id: `${SHARED_WEDGE_DISTRESS_VERB}::${id}`,
        $pid: null,
        $hook_event: "DispatchFailed",
        $event_type: "dispatch_failures",
        $tool_name: null,
        $matcher: null,
        $cwd: dir,
        $permission_mode: null,
        $agent_id: null,
        $agent_type: null,
        $stop_hook_active: null,
        $data: JSON.stringify({
          verb: SHARED_WEDGE_DISTRESS_VERB,
          id,
          reason,
          dir,
          ts: tsSec,
        }),
        $subagent_agent_id: null,
        $spawn_name: null,
        $start_time: null,
        $slash_command: null,
        $skill_name: null,
        $plan_op: null,
        $plan_target: null,
        $plan_epic_id: null,
        $plan_task_id: null,
        $plan_subject_present: null,
        $config_dir: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $plan_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
        $worktree: null,
      });
      wakePending = true;
      pumpWakes();
    } catch (err) {
      console.error(
        `[keeperd] shared-checkout-wedge distress mint threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Execute a stuck-state-sentinel mint (ADR 0013 layer 3) — the corrective
   * quiescence (TIER ONE only, `heal`) PLUS the sticky `stuck-sentinel` anomaly
   * `dispatch_failures` row, on main's sole writable connection. The worker's pure
   * predicate + change-gate already decided WHETHER to mint; main just executes.
   *
   * The corrective event is deliberately `StopReconciled`, NOT `Killed`: the
   * exit-watcher is the sole `Killed` producer, `killed` fails the `stopped`-only
   * autoclose gate, and killing mislabels completed work — this only quiesces so
   * autoclose can reap the healed row. `$ts` is the producer-stamped `tsSec` so the
   * fold's stamp advance is re-fold deterministic.
   *
   * The anomaly row keys on the RETRYABLE `close::stuck-sentinel:<jobId>` synthetic
   * key so `retry_dispatch` (operator ack) is its ONLY clear — never a level-trigger
   * — and, being retryable, the boot orphan-GC leaves it alone. The producer-stamped
   * `ts` rides the payload for re-fold determinism; the UPSERT on `(verb, id)`
   * preserves the sticky-since `created_at`, so a bounded still-stuck re-emit
   * refreshes without resetting. Idempotent + NON-FATAL on insert failure.
   */
  function handleStuckSentinelMint(msg: StuckSentinelMessage): void {
    try {
      if (msg.heal) {
        stmts.insertEvent.run({
          $ts: msg.tsSec,
          $session_id: msg.jobId,
          $pid: null,
          $hook_event: "StopReconciled",
          $event_type: "stop_reconciled",
          $tool_name: null,
          $matcher: null,
          $cwd: null,
          $permission_mode: null,
          $agent_id: null,
          $agent_type: null,
          $stop_hook_active: null,
          $data: JSON.stringify({ reason: msg.reason }),
          $subagent_agent_id: null,
          $spawn_name: null,
          $start_time: null,
          $slash_command: null,
          $skill_name: null,
          $plan_op: null,
          $plan_target: null,
          $plan_epic_id: null,
          $plan_task_id: null,
          $plan_subject_present: null,
          $config_dir: null,
          $bash_mutation_kind: null,
          $bash_mutation_targets: null,
          $plan_files: null,
          $backend_exec_type: null,
          $backend_exec_session_id: null,
          $backend_exec_pane_id: null,
          $worktree: null,
        });
      }
      const distressId = `${STUCK_SENTINEL_DISTRESS_ID_PREFIX}${msg.jobId}`;
      stmts.insertEvent.run({
        $ts: Date.now() / 1000,
        $session_id: `${STUCK_SENTINEL_DISTRESS_VERB}::${distressId}`,
        $pid: null,
        $hook_event: "DispatchFailed",
        $event_type: "dispatch_failures",
        $tool_name: null,
        $matcher: null,
        $cwd: null,
        $permission_mode: null,
        $agent_id: null,
        $agent_type: null,
        $stop_hook_active: null,
        $data: JSON.stringify({
          verb: STUCK_SENTINEL_DISTRESS_VERB,
          id: distressId,
          reason: msg.reason,
          dir: null,
          ts: msg.tsSec,
        }),
        $subagent_agent_id: null,
        $spawn_name: null,
        $start_time: null,
        $slash_command: null,
        $skill_name: null,
        $plan_op: null,
        $plan_target: null,
        $plan_epic_id: null,
        $plan_task_id: null,
        $plan_subject_present: null,
        $config_dir: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $plan_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
        $worktree: null,
      });
      wakePending = true;
      pumpWakes();
    } catch (err) {
      console.error(
        `[keeperd] stuck-sentinel mint threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Mint a synthetic `WorktreeRepoStatus` event (fn-1013) carrying the FULL
   * current worktree-disabled set, folded into the LIVE-ONLY
   * `worktree_repo_status` operator projection. Workers never write the DB; the
   * worker dedupes (posts only when the set changes), so this fires at most once
   * per set-change. The disabled set rides `data` as `{ entries }`; the fold does
   * a full-set replace. NON-FATAL on insert failure — the next set-change re-emits
   * (a missed emit just leaves a stale operator view for one cycle, never a
   * correctness hazard). Mirrors {@link handleDispatchFailedMint}.
   */
  function handleWorktreeRepoStatusMint(
    entries: WorktreeRepoStatusMessage["entries"],
  ): void {
    try {
      stmts.insertEvent.run({
        $ts: Date.now() / 1000,
        $session_id: "reconciler",
        $pid: null,
        $hook_event: "WorktreeRepoStatus",
        $event_type: "worktree_repo_status",
        $tool_name: null,
        $matcher: null,
        $cwd: null,
        $permission_mode: null,
        $agent_id: null,
        $agent_type: null,
        $stop_hook_active: null,
        $data: JSON.stringify({ entries }),
        $subagent_agent_id: null,
        $spawn_name: null,
        $start_time: null,
        $slash_command: null,
        $skill_name: null,
        $plan_op: null,
        $plan_target: null,
        $plan_epic_id: null,
        $plan_task_id: null,
        $plan_subject_present: null,
        $config_dir: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $plan_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
        $worktree: null,
      });
      wakePending = true;
      pumpWakes();
    } catch (err) {
      console.error(
        `[keeperd] WorktreeRepoStatus mint threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Mint a synthetic `LaneMerged` event carrying the FULL current
   * merge-landed set, folded into the LIVE-ONLY `lane_merged` observable. Workers
   * never write the DB; the worker dedupes (posts only when the set changes), so
   * this fires at most once per set-change. The merged set rides `data` as
   * `{ entries }`; the fold does a full-set replace. NON-FATAL on insert failure —
   * the next set-change re-emits (a missed emit just leaves a stale `landed` view
   * for one cycle, never a correctness hazard). Mirrors
   * {@link handleWorktreeRepoStatusMint}.
   */
  function handleLaneMergedMint(entries: LaneMergedMessage["entries"]): void {
    try {
      stmts.insertEvent.run({
        $ts: Date.now() / 1000,
        $session_id: "reconciler",
        $pid: null,
        $hook_event: "LaneMerged",
        $event_type: "lane_merged",
        $tool_name: null,
        $matcher: null,
        $cwd: null,
        $permission_mode: null,
        $agent_id: null,
        $agent_type: null,
        $stop_hook_active: null,
        $data: JSON.stringify({ entries }),
        $subagent_agent_id: null,
        $spawn_name: null,
        $start_time: null,
        $slash_command: null,
        $skill_name: null,
        $plan_op: null,
        $plan_target: null,
        $plan_epic_id: null,
        $plan_task_id: null,
        $plan_subject_present: null,
        $config_dir: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $plan_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
        $worktree: null,
      });
      wakePending = true;
      pumpWakes();
    } catch (err) {
      console.error(
        `[keeperd] LaneMerged mint threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Mint a synthetic `DispatchCleared` event on behalf of the recover glue's
   * level-triggered auto-clear, symmetric with {@link handleDispatchFailedMint}.
   * Reuses {@link mintDispatchClearedEvent} — the EXACT path the `retry_dispatch`
   * RPC drives — so the clear round-trips through one event arm. NON-FATAL on
   * insert failure: the row stays sticky and the next recover cycle re-clears.
   */
  function handleDispatchClearedMint(
    payload: DispatchClearedMessage["payload"],
  ): void {
    try {
      mintDispatchClearedEvent(payload.verb, payload.id);
      wakePending = true;
      pumpWakes();
    } catch (err) {
      console.error(
        `[keeperd] DispatchCleared mint threw (non-fatal): ${
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
   * when it throws OR when the durable gate suppresses). The worker launches only
   * on `ok:true`; an `ok:false` or ack-timeout aborts WITHOUT launching — strictly
   * preferable to the fire-and-forget race that re-opened the double-dispatch
   * window. NON-FATAL on insert failure.
   *
   * DURABLE MINT GATE: one logical dispatch attempt otherwise amplifies into N
   * same-instant `Dispatched` rows (pre-launch abort loops, restart storms, the
   * insert→fold gap). The gate read + the conditional event insert run in ONE
   * `BEGIN IMMEDIATE` transaction on main's writable connection: a re-mint of the
   * same `verb::id` inside `DISPATCH_MINT_GATE_WINDOW_MS` inserts NO row and
   * replies a DISTINCT suppressed ack (`ok:false, suppressed:true`); a fresh mint
   * stamps the gate AND inserts atomically, so a crash between them can neither
   * un-dedup the next attempt nor suppress a legit one forever. Suppression does
   * NOT re-stamp the gate — the window stays absolute from the frozen first mint.
   */
  function handleDispatchedMint(msg: DispatchedMessage): void {
    const { id, payload } = msg;
    const dispatchKey = `${payload.verb}::${payload.id}`;
    const data = JSON.stringify(payload);
    let ok = false;
    let suppressed = false;
    try {
      const nowMs = Date.now();
      // The gate read + the conditional insert run atomically in ONE
      // `BEGIN IMMEDIATE`. `onFreshMint` runs only on the mint branch (gate empty
      // or window elapsed); a re-mint inside the window suppresses without
      // inserting. `ok` flips to true only after the insert lands.
      ({ suppressed } = runDispatchMintGate(
        db,
        dispatchKey,
        nowMs,
        DISPATCH_MINT_GATE_WINDOW_MS,
        () => {
          stmts.insertEvent.run({
            $ts: nowMs / 1000,
            $session_id: dispatchKey,
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
            $plan_op: null,
            $plan_target: null,
            $plan_epic_id: null,
            $plan_task_id: null,
            $plan_subject_present: null,
            $config_dir: null,
            $bash_mutation_kind: null,
            $bash_mutation_targets: null,
            $plan_files: null,
            $backend_exec_type: null,
            $backend_exec_session_id: null,
            $backend_exec_pane_id: null,
            $worktree: null,
          });
          // The ack promises INSERT durability ONLY — not the fold (idempotent on
          // the next drain). The committed INSERT is the whole contract.
          ok = true;
        },
      ));
    } catch (err) {
      // A throw rolls back BOTH the gate stamp and the insert, so `ok` stays
      // false and `suppressed` stays false — the worker aborts on a real error,
      // never on a phantom suppression.
      console.error(
        `[keeperd] Dispatched mint threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    // Reply on EVERY path — the worker is blocked awaiting this ack before it
    // launches. A suppressed mint replies a DISTINCT `ok:false, suppressed:true`
    // (a benign dedup, not an error) and needs no pump (nothing was inserted).
    // The `?.` keeps it null-safe for the type system on an unselected-autopilot
    // boot.
    if (suppressed) {
      autopilotWorkerInstance?.postMessage({
        type: "dispatched-ack",
        id,
        ok: false,
        suppressed: true,
      } satisfies DispatchedAckMessage);
      return;
    }
    // Reply IMMEDIATELY after the committed INSERT, BEFORE the (potentially slow)
    // reducer pump: the launch must not wait on the drain, and the ack already
    // reflects everything it promises. Outbox ordering is UNCHANGED — the insert
    // still precedes the launch.
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
        $plan_op: null,
        $plan_target: null,
        $plan_epic_id: null,
        $plan_task_id: null,
        $plan_subject_present: null,
        $config_dir: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $plan_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
        $worktree: null,
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

  /**
   * Mint one synthetic `BlockEscalation{Requested,Attempted}` event onto the
   * writable connection — the producer's only write path into the
   * `block_escalations` latch (it never UPDATEs the projection directly; the
   * reducer fold owns that). `(epic_id, task_id)` rides the entity-key overload on
   * `session_id` so a re-fold correlates the row WITHOUT re-parsing `data`; the
   * full payload also rides `data` for the strict fold parser. NON-FATAL on insert
   * failure — the next heartbeat sweep re-attempts (the latch stays `pending`).
   */
  function mintBlockEscalationEvent(
    hookEvent: "BlockEscalationRequested" | "BlockEscalationAttempted",
    epicId: string,
    taskId: string,
    outcome: string | null,
  ): void {
    const data =
      hookEvent === "BlockEscalationAttempted"
        ? JSON.stringify({ epic_id: epicId, task_id: taskId, outcome })
        : JSON.stringify({ epic_id: epicId, task_id: taskId });
    try {
      stmts.insertEvent.run({
        $ts: Date.now() / 1000,
        $session_id: `${epicId}::${taskId}`,
        $pid: null,
        $hook_event: hookEvent,
        $event_type: "block_escalations",
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
        $plan_op: null,
        $plan_target: null,
        $plan_epic_id: null,
        $plan_task_id: null,
        $plan_subject_present: null,
        $config_dir: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $plan_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
        $worktree: null,
      });
      wakePending = true;
      pumpWakes();
    } catch (err) {
      console.error(
        `[keeperd] ${hookEvent} mint threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Mint one synthetic `BlockHumanNotified` event onto the writable connection — the
   * unblock human-notify sweep's (stage 3) only write path into the
   * `block_escalations.human_notified_at` once-marker (it never UPDATEs the projection
   * directly; the reducer fold owns that, stamping the marker ONLY on the terminal
   * `notified` and NEVER clearing the latch). Sibling of {@link mintBlockEscalationEvent}
   * and {@link mintMergeHumanNotifiedEvent}: `(epic_id, task_id)` rides the entity-key
   * overload on `session_id` so a re-fold correlates the row WITHOUT re-parsing `data`;
   * the full `{ epic_id, task_id, outcome }` payload also rides `data` for the strict
   * fold parser. NON-FATAL on insert failure — the next heartbeat sweep re-attempts
   * (the marker stays NULL on a `notify_failed`).
   */
  function mintBlockHumanNotifiedEvent(
    epicId: string,
    taskId: string,
    outcome: BlockHumanNotifiedOutcome,
  ): void {
    try {
      stmts.insertEvent.run({
        $ts: Date.now() / 1000,
        $session_id: `${epicId}::${taskId}`,
        $pid: null,
        $hook_event: "BlockHumanNotified",
        $event_type: "block_escalations",
        $tool_name: null,
        $matcher: null,
        $cwd: null,
        $permission_mode: null,
        $agent_id: null,
        $agent_type: null,
        $stop_hook_active: null,
        $data: JSON.stringify({ epic_id: epicId, task_id: taskId, outcome }),
        $subagent_agent_id: null,
        $spawn_name: null,
        $start_time: null,
        $slash_command: null,
        $skill_name: null,
        $plan_op: null,
        $plan_target: null,
        $plan_epic_id: null,
        $plan_task_id: null,
        $plan_subject_present: null,
        $config_dir: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $plan_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
        $worktree: null,
      });
      wakePending = true;
      pumpWakes();
    } catch (err) {
      console.error(
        `[keeperd] BlockHumanNotified mint threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Mint one synthetic `MergeEscalationAttempted` event onto the writable
   * connection — the merge-escalation producer's only write path into the
   * `dispatch_failures.merge_escalated_at` once-marker (it never UPDATEs the
   * projection directly; task .1's reducer fold owns that, stamping the marker ONLY
   * on a terminal outcome and NEVER clearing the sticky row). The close-row `id`
   * rides the entity-key overload on `session_id` so a re-fold correlates the row
   * WITHOUT re-parsing `data`; the full `{ id, outcome }` payload also rides `data`
   * for the strict fold parser. NON-FATAL on insert failure — the next heartbeat
   * sweep re-attempts (the marker stays NULL on a non-terminal/failed mint).
   */
  function mintMergeEscalationEvent(
    id: string,
    outcome: MergeEscalationOutcome,
  ): void {
    try {
      stmts.insertEvent.run({
        $ts: Date.now() / 1000,
        $session_id: id,
        $pid: null,
        $hook_event: "MergeEscalationAttempted",
        $event_type: "dispatch_failures",
        $tool_name: null,
        $matcher: null,
        $cwd: null,
        $permission_mode: null,
        $agent_id: null,
        $agent_type: null,
        $stop_hook_active: null,
        $data: JSON.stringify({ id, outcome }),
        $subagent_agent_id: null,
        $spawn_name: null,
        $start_time: null,
        $slash_command: null,
        $skill_name: null,
        $plan_op: null,
        $plan_target: null,
        $plan_epic_id: null,
        $plan_task_id: null,
        $plan_subject_present: null,
        $config_dir: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $plan_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
        $worktree: null,
      });
      wakePending = true;
      pumpWakes();
    } catch (err) {
      console.error(
        `[keeperd] MergeEscalationAttempted mint threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Mint one synthetic `ResolverDispatchAttempted` event onto the writable connection
   * — the resolver-dispatch producer's only write path into the
   * `dispatch_failures.resolver_dispatched_at` once-marker (it never UPDATEs the
   * projection directly; the reducer fold owns that, stamping the marker ONLY on a
   * terminal `dispatched` and NEVER clearing the sticky row). Sibling of
   * {@link mintMergeEscalationEvent}. The close-row `id` rides the entity-key overload
   * on `session_id` so a re-fold correlates the row WITHOUT re-parsing `data`; the full
   * `{ id, outcome }` payload also rides `data` for the strict fold parser. NON-FATAL
   * on insert failure — the next heartbeat sweep re-attempts (the marker stays NULL on
   * a `dispatch_failed`).
   */
  function mintResolverDispatchEvent(
    id: string,
    outcome: ResolverDispatchOutcome,
  ): void {
    try {
      stmts.insertEvent.run({
        $ts: Date.now() / 1000,
        $session_id: id,
        $pid: null,
        $hook_event: "ResolverDispatchAttempted",
        $event_type: "dispatch_failures",
        $tool_name: null,
        $matcher: null,
        $cwd: null,
        $permission_mode: null,
        $agent_id: null,
        $agent_type: null,
        $stop_hook_active: null,
        $data: JSON.stringify({ id, outcome }),
        $subagent_agent_id: null,
        $spawn_name: null,
        $start_time: null,
        $slash_command: null,
        $skill_name: null,
        $plan_op: null,
        $plan_target: null,
        $plan_epic_id: null,
        $plan_task_id: null,
        $plan_subject_present: null,
        $config_dir: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $plan_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
        $worktree: null,
      });
      wakePending = true;
      pumpWakes();
    } catch (err) {
      console.error(
        `[keeperd] ResolverDispatchAttempted mint threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Mint one synthetic `MergeHumanNotified` event onto the writable connection — the
   * deconflict human-notify sweep's (stage 3) only write path into the
   * `dispatch_failures.human_notified_at` once-marker (it never UPDATEs the projection
   * directly; the reducer fold owns that, stamping the marker ONLY on the terminal
   * `notified` and NEVER clearing the sticky row). Sibling of
   * {@link mintMergeEscalationEvent}. The close-row `id` rides the entity-key overload
   * on `session_id` so a re-fold correlates the row WITHOUT re-parsing `data`; the full
   * `{ id, outcome }` payload also rides `data` for the strict fold parser. NON-FATAL on
   * insert failure — the next heartbeat sweep re-attempts (the marker stays NULL on a
   * `notify_failed`).
   */
  function mintMergeHumanNotifiedEvent(
    id: string,
    outcome: MergeHumanNotifiedOutcome,
  ): void {
    try {
      stmts.insertEvent.run({
        $ts: Date.now() / 1000,
        $session_id: id,
        $pid: null,
        $hook_event: "MergeHumanNotified",
        $event_type: "dispatch_failures",
        $tool_name: null,
        $matcher: null,
        $cwd: null,
        $permission_mode: null,
        $agent_id: null,
        $agent_type: null,
        $stop_hook_active: null,
        $data: JSON.stringify({ id, outcome }),
        $subagent_agent_id: null,
        $spawn_name: null,
        $start_time: null,
        $slash_command: null,
        $skill_name: null,
        $plan_op: null,
        $plan_target: null,
        $plan_epic_id: null,
        $plan_task_id: null,
        $plan_subject_present: null,
        $config_dir: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $plan_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
        $worktree: null,
      });
      wakePending = true;
      pumpWakes();
    } catch (err) {
      console.error(
        `[keeperd] MergeHumanNotified mint threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Mint the sticky repair-latch `DispatchFailed` on the `repair::<repo-token>` key —
   * the durable `dispatch_failures` row (verb `repair`, id the token) escalation-brief
   * reads and the once-page / once-dispatch markers hang on. Rides its OWN thin closure
   * (like the distress mints) because the `repair` verb is NOT part of the strict
   * `DispatchFailedMessage["payload"]` union {@link handleDispatchFailedMint} takes. The
   * fold UPSERTs on `(verb, id)` preserving `created_at` + every marker, so a re-mint
   * while the base stays broken is idempotent; `ts` is producer-stamped for re-fold
   * determinism. NON-FATAL on insert failure — the next heartbeat sweep re-attempts.
   */
  function mintRepairRowEvent(
    token: string,
    reason: string,
    dir: string | null,
    tsSec: number,
  ): void {
    try {
      stmts.insertEvent.run({
        $ts: Date.now() / 1000,
        $session_id: `repair::${token}`,
        $pid: null,
        $hook_event: "DispatchFailed",
        $event_type: "dispatch_failures",
        $tool_name: null,
        $matcher: null,
        $cwd: dir,
        $permission_mode: null,
        $agent_id: null,
        $agent_type: null,
        $stop_hook_active: null,
        $data: JSON.stringify({
          verb: "repair",
          id: token,
          reason,
          dir,
          ts: tsSec,
        }),
        $subagent_agent_id: null,
        $spawn_name: null,
        $start_time: null,
        $slash_command: null,
        $skill_name: null,
        $plan_op: null,
        $plan_target: null,
        $plan_epic_id: null,
        $plan_task_id: null,
        $plan_subject_present: null,
        $config_dir: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $plan_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
        $worktree: null,
      });
      wakePending = true;
      pumpWakes();
    } catch (err) {
      console.error(
        `[keeperd] repair-latch DispatchFailed mint threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Mint one synthetic `RepairDispatched` event onto the writable connection — the
   * repair sweep's only write path into the `dispatch_failures.repair_dispatched_at`
   * once-marker (the reducer fold owns the UPDATE, stamping ONLY on a terminal
   * `dispatched` and NEVER clearing the sticky row). Sibling of
   * {@link mintResolverDispatchEvent}; the repo-token `id` rides the entity-key overload
   * on `session_id`. NON-FATAL on insert failure — the next heartbeat sweep re-attempts.
   */
  function mintRepairDispatchedEvent(
    id: string,
    outcome: RepairDispatchOutcome,
  ): void {
    try {
      stmts.insertEvent.run({
        $ts: Date.now() / 1000,
        $session_id: id,
        $pid: null,
        $hook_event: "RepairDispatched",
        $event_type: "dispatch_failures",
        $tool_name: null,
        $matcher: null,
        $cwd: null,
        $permission_mode: null,
        $agent_id: null,
        $agent_type: null,
        $stop_hook_active: null,
        $data: JSON.stringify({ id, outcome }),
        $subagent_agent_id: null,
        $spawn_name: null,
        $start_time: null,
        $slash_command: null,
        $skill_name: null,
        $plan_op: null,
        $plan_target: null,
        $plan_epic_id: null,
        $plan_task_id: null,
        $plan_subject_present: null,
        $config_dir: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $plan_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
        $worktree: null,
      });
      wakePending = true;
      pumpWakes();
    } catch (err) {
      console.error(
        `[keeperd] RepairDispatched mint threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Mint one synthetic `RepairHumanNotified` event onto the writable connection — the
   * repair sweep's only write path into the `dispatch_failures.human_notified_at`
   * once-marker on the repair row (the reducer fold owns the UPDATE, stamping ONLY on a
   * terminal `notified` and NEVER clearing the sticky row). Sibling of
   * {@link mintMergeHumanNotifiedEvent}. NON-FATAL on insert failure — the next
   * heartbeat sweep re-attempts (the marker stays NULL on a `notify_failed`).
   */
  function mintRepairHumanNotifiedEvent(
    id: string,
    outcome: RepairHumanNotifiedOutcome,
  ): void {
    try {
      stmts.insertEvent.run({
        $ts: Date.now() / 1000,
        $session_id: id,
        $pid: null,
        $hook_event: "RepairHumanNotified",
        $event_type: "dispatch_failures",
        $tool_name: null,
        $matcher: null,
        $cwd: null,
        $permission_mode: null,
        $agent_id: null,
        $agent_type: null,
        $stop_hook_active: null,
        $data: JSON.stringify({ id, outcome }),
        $subagent_agent_id: null,
        $spawn_name: null,
        $start_time: null,
        $slash_command: null,
        $skill_name: null,
        $plan_op: null,
        $plan_target: null,
        $plan_epic_id: null,
        $plan_task_id: null,
        $plan_subject_present: null,
        $config_dir: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $plan_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
        $worktree: null,
      });
      wakePending = true;
      pumpWakes();
    } catch (err) {
      console.error(
        `[keeperd] RepairHumanNotified mint threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Read the task's `blocked_reason` from its plan state file
   * (`<project_dir>/.keeper/state/tasks/<task_id>.state.json`). Producer-side fs
   * read — legal OUTSIDE any fold. Returns null on every miss (no `project_dir`,
   * absent / unreadable file, malformed JSON, no `blocked_reason` field) so the
   * category gate folds an unresolved reason to "skip". NEVER throws.
   */
  function readTaskBlockedReason(
    projectDir: string | null,
    taskId: string,
  ): string | null {
    if (projectDir == null || projectDir === "") return null;
    const statePath = join(
      projectDir,
      ".keeper",
      "state",
      "tasks",
      `${taskId}.state.json`,
    );
    try {
      if (!existsSync(statePath)) return null;
      const parsed = JSON.parse(readFileSync(statePath, "utf8")) as {
        blocked_reason?: unknown;
      };
      return typeof parsed.blocked_reason === "string"
        ? parsed.blocked_reason
        : null;
    } catch {
      return null;
    }
  }

  // Producer-side TTL sweep for `pending_dispatches`. Mints a `DispatchExpired`
  // for every row aged past `PENDING_DISPATCH_TTL_MS`, UNCONDITIONALLY on
  // `dispatch_failures` membership (fn-870 BUG2 self-heal — a lease sweep must
  // expire an aged row even when the never-bound breaker has minted a sticky
  // failure for the key, else the slot is held forever; see
  // `selectExpiredPendingDispatches`). The expiry DELETE is idempotent with a
  // concurrent `DispatchFailed` fold, so re-including those rows can't corrupt
  // the projection.
  // MUST ride the heartbeat timer, not the level-triggered `data_version` wake: a
  // crashed dispatch can be the only pending row on a quiescent board, where a
  // write-triggered wake never fires. All wallclock lives HERE in the producer,
  // never inside a fold; the fold reads only `event.ts` + the FROZEN payload. The
  // sweep reads on main's writable connection so the read is sequenced inside the
  // same writer that mints — no read/mint race against the reducer's UPSERT.
  function sweepExpiredPendingDispatches(): void {
    if (shuttingDown) return;
    // Prune stale `dispatch_mint_gate` rows FIRST (unconditionally — the pending
    // sweep below early-returns when nothing is aged). A gate row older than the
    // evict horizon has long since stopped suppressing; this bounds the durable
    // table. Producer write on main's writable connection, non-fatal on failure.
    try {
      evictStaleDispatchMintGate(
        db,
        (Date.now() - DISPATCH_MINT_GATE_EVICT_MS) / 1000,
      );
    } catch (err) {
      console.error(
        `[keeperd] dispatch_mint_gate eviction threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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
      handleDispatchExpiredMint({
        verb: row.verb as Verb,
        id: row.id,
        // WHY this mint fired — the producer-side TTL sweep aged the pending row
        // past its ceiling. Attribution telemetry on the event blob; the reducer
        // fold reads only `(verb, id)`.
        reason: "dispatch_expiry_timeout",
      });
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

  // Shared escalation-dispatch production wiring (fn-1129) — the deconflict-dispatch
  // sweep AND the block/unblock-dispatch sweep both launch a
  // `<verb>::<id>` plan-skill session through `dispatchEscalationSession`, bounded by the
  // global concurrency cap + a per-key occupancy guard. `inFlightEscalations` is a
  // producer-side memo of keys THIS process launched that may not have folded into the
  // `jobs` projection yet (a session boots + emits a birth record + gets ingested SECONDS
  // after launch), so the cap counts them until they fold and a within-tick burst can't
  // over-dispatch. It is GC'd once a key appears in the jobs read (folded — live OR
  // terminal) or ages past its TTL (a never-folded launch), so it stays bounded and is
  // NEVER a fold input.
  const inFlightEscalations = new Map<string, number>();
  // Producer-side memo of the resolved base CHECKOUT each merge-recreating escalation
  // (`resolve::` / `deconflict::`) was launched into, keyed by `<verb>::<id>` label — the
  // per-checkout occupancy guard's not-yet-folded arm (a launch's `jobs.cwd` folds SECONDS
  // after launch, so a within-tick burst of same-checkout dispatches would otherwise all
  // slip past the live-jobs probe). GC'd on the SAME rule as `inFlightEscalations` (folded
  // into the widened jobs read OR aged past its TTL), so it stays bounded and is NEVER a
  // fold input. `unblock::` launches never land here — they recreate no merge.
  const inFlightCheckouts = new Map<string, { cwd: string; ts: number }>();
  function readLiveEscalationJobs(): Job[] {
    let jobs: Job[];
    try {
      // `resolve` rides this read too (beyond the cap's `unblock`/`deconflict`): it is a
      // merge-recreating occupant of a base checkout, so the per-checkout guard must see
      // live resolvers. The cap count + per-key liveness filter to their own verbs, so
      // the extra rows never inflate either.
      jobs = db
        .query(
          "SELECT job_id, plan_verb, plan_ref, state, backend_exec_pane_id, cwd FROM jobs WHERE plan_verb IN ('resolve', 'unblock', 'deconflict', 'repair')",
        )
        .all() as unknown as Job[];
    } catch {
      // A transient jobs read failure degrades to an empty set — the cap/occupancy
      // guards then rely on the in-flight memo alone (never a false skip that loses a
      // dispatch, never a false over-count that wedges the cap).
      jobs = [];
    }
    if (inFlightEscalations.size > 0 || inFlightCheckouts.size > 0) {
      const cutoff = Date.now() - INFLIGHT_ESCALATION_TTL_MS;
      const folded = new Set(jobs.map((j) => `${j.plan_verb}::${j.plan_ref}`));
      for (const [key, ts] of inFlightEscalations) {
        if (folded.has(key) || ts < cutoff) inFlightEscalations.delete(key);
      }
      for (const [key, rec] of inFlightCheckouts) {
        if (folded.has(key) || rec.ts < cutoff) inFlightCheckouts.delete(key);
      }
    }
    return jobs;
  }
  // The per-checkout occupancy probe both merge-recreating dispatch paths consult: a
  // DIFFERENT live `resolve::`/`deconflict::` session (folded into `jobs`, or still
  // in-flight in the memo) already holds `checkout`. Excludes the candidate's own
  // `<verb>::<id>` key so a session never self-blocks. Empty checkout → never occupied.
  function escalationCheckoutOccupied(
    selfVerb: string,
    selfId: string,
    checkout: string,
  ): boolean {
    if (checkout === "") return false;
    const selfLabel = `${selfVerb}::${selfId}`;
    // `readLiveEscalationJobs` GCs the in-flight memo first, so the two arms are disjoint
    // (folded-live jobs + not-yet-folded launches).
    const jobs = readLiveEscalationJobs();
    if (escalationCheckoutOccupiedBy(jobs, checkout, selfVerb, selfId))
      return true;
    for (const [label, rec] of inFlightCheckouts) {
      if (label === selfLabel) continue;
      if (rec.cwd === checkout) return true;
    }
    return false;
  }
  // The owning-orchestrator jobs for an AUDIT_READY park — the `work::<task>` and
  // `close::<epic>` sessions that run (or re-dispatch) the audit and resume the
  // worker. Selects `updated_at` (the dead-owner death anchor) on top of the
  // liveness columns. A read failure degrades to `[]` → `probeAuditOrchestrator`
  // reads `absent` → the gate DEFERS, never a premature page on a transient error.
  function readAuditOrchestratorJobs(epicId: string, taskId: string): Job[] {
    try {
      return db
        .query(
          "SELECT job_id, plan_verb, plan_ref, state, backend_exec_pane_id, updated_at FROM jobs WHERE plan_verb IN ('work', 'close') AND plan_ref IN (?, ?)",
        )
        .all(taskId, epicId) as unknown as Job[];
    } catch {
      return [];
    }
  }
  const liveEscalationDispatchDeps: EscalationDispatchDeps = {
    countLiveEscalations: () =>
      // GC-then-count: `readLiveEscalationJobs` prunes folded keys from the memo first,
      // so the two summands are disjoint (folded-live jobs + not-yet-folded in-flight).
      countLiveEscalationSessions(readLiveEscalationJobs()) +
      inFlightEscalations.size,
    isEscalationLive: (verb, id) => {
      const jobs = readLiveEscalationJobs();
      return (
        inFlightEscalations.has(`${verb}::${id}`) ||
        escalationSessionLiveFor(jobs, verb, id)
      );
    },
    // The per-checkout guard applies ONLY to the merge-recreating `deconflict` verb — an
    // `unblock` session runs in a task checkout and recreates no merge, so it is never
    // checkout-gated (the resolver's own path is gated in `dispatchResolver` directly).
    isCheckoutOccupied: (verb, id, cwd) =>
      verb === "deconflict" && escalationCheckoutOccupied(verb, id, cwd),
    resolveConfig: () => resolveEscalationLaunchConfig(),
    launch: async ({ spec, cwd, label }) => {
      const result = await keeperAgentLaunch({
        noteLine: (line) => console.error(`[keeperd] ${line}`),
        launcherArgvPrefix,
        session: MANAGED_EXEC_SESSION,
        cwd,
        label,
        spec,
      });
      // Record the just-launched key so the cap counts it until its jobs row folds. A
      // `deconflict::` launch also records its base checkout so the per-checkout guard
      // serializes a within-tick sibling before the jobs row folds; `unblock::` never
      // recreates a merge, so it stays out of the checkout memo.
      if (result.ok) {
        inFlightEscalations.set(label, Date.now());
        if (label.startsWith("deconflict::")) {
          inFlightCheckouts.set(label, { cwd, ts: Date.now() });
        }
      }
      return { ok: result.ok };
    },
    noteLine: (line) => console.error(`[keeperd] ${line}`),
  };

  // Launch ONE `deconflict::<epic>` escalation session for a sticky close whose tier-1
  // resolver declined/died. Mirrors `dispatchResolver`: cwd = the epic's base worktree
  // (a parse-miss leaves the repo root; the skill re-derives context from its escalation
  // brief), the prompt is `/plan:deconflict <epic>`, and the launch runs at the SEPARATE
  // escalation model/effort via the shared `dispatchEscalationSession` (so the cap +
  // occupancy guard apply). Producer-only — never reachable from a fold.
  async function dispatchDeconflict(
    row: PendingMergeEscalation,
  ): Promise<EscalationDispatchOutcome> {
    // The checkout where finalize ran the failing merge — see `dispatchResolver`:
    // `mergeConflictBaseCheckout` maps a default-branch base to the repo root (never
    // laned) and a `keeper/epic/…` lane base to its worktree, so Bun.spawn never ENOENTs.
    const parsed = parseMergeConflictReason(row.reason);
    const hasRepo = row.dir != null && row.dir !== "";
    const cwd =
      parsed != null && hasRepo
        ? mergeConflictBaseCheckout(row.dir as string, parsed.base)
        : (row.dir ?? "");
    return dispatchEscalationSession(liveEscalationDispatchDeps, {
      verb: "deconflict",
      id: row.id,
      prompt: defaultPlanPrompt("deconflict", row.id),
      cwd,
    });
  }

  // Send the ONE botctl notification about a declined/dead `deconflict::<epic>` session
  // (stage 3). ASYNC spawn (never `spawnSync` — that would block the main loop), array
  // form so the free-text body rides as a literal argv element (no shell interpolation).
  // A non-zero exit OR a missing botctl maps to `notify_failed` — NON-terminal, so the
  // marker stays NULL and the row re-sweeps: the notification is never lost, and the
  // sticky close row stays operator-visible via `keeper status` throughout, so it never
  // goes silent.
  async function notifyHumanOfDeconflict(
    row: PendingMergeEscalation,
    verdict: "declined" | "died",
  ): Promise<MergeHumanNotifiedOutcome> {
    const body = buildDeconflictHumanNotifyBody({
      epicId: row.id,
      reason: row.reason,
      verdict,
    });
    try {
      const proc = Bun.spawn(
        ["botctl", "send-message", "--topic", KEEPER_TOPIC, body],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          env: process.env as Record<string, string | undefined>,
        },
      );
      const exitCode = await proc.exited;
      return exitCode === 0 ? "notified" : "notify_failed";
    } catch (err) {
      console.error(
        `[keeperd] deconflict human-notify spawn threw for ${row.id} (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return "notify_failed";
    }
  }

  // Producer-side deconflict-dispatch sweep (fn-1129 stage 2), the rewired successor to
  // the merge-escalation planner@ notify. Each heartbeat tick walks the sticky
  // `worktree-merge-conflict` close rows whose tier-1 resolver reached a TERMINAL
  // verdict, and DISPATCHES one `deconflict::<epic>` escalation session per stuck close
  // (never a planner@ bus message). A terminal `dispatched` stamps the
  // `merge_escalated_at` once-marker (the reducer fold), so a daemon dispatches a given
  // stuck close's deconflict ONCE; a `dispatch_failed` or a cap/occupancy SKIP leaves it
  // re-sweepable. All wall-clock + spawn lives HERE in the producer; the spawn lives only
  // here, so a re-fold never re-fires a launch. Rides the SAME 60s heartbeat as the block
  // tick. `void` + `.catch`: the async launch must not block the heartbeat.
  async function runMergeEscalationSweepTick(): Promise<void> {
    if (shuttingDown) return;
    // Paused = the human is in control (the `[paused]` banner is authoritative); a paused
    // board never auto-dispatches a NEW escalation session, mirroring the resolver-
    // dispatch + reconciler pause gate. So a fresh sticky on a paused board defers the
    // deconflict dispatch (and, downstream, the human notify) until play.
    if (autopilotPaused) return;
    await runMergeEscalationSweep({
      selectPending: () => selectPendingMergeEscalations(db),
      stillPending: (id) => {
        try {
          return (
            db
              .query(
                "SELECT 1 FROM dispatch_failures WHERE verb = 'close' AND id = ? AND merge_escalated_at IS NULL LIMIT 1",
              )
              .get(id) != null
          );
        } catch {
          // A point-read failure (unexpected) conservatively skips THIS tick's launch
          // for the row — the selector already succeeded, the marker stays NULL, and
          // the next heartbeat re-sweeps. Never a false dispatch.
          return false;
        }
      },
      resolverOutcome: (id) =>
        classifyResolverOutcome(
          resolveJobsForEpic(db, id, stickyCloseInstanceFor(id)),
          id,
        ),
      dispatchDeconflict: (row) => dispatchDeconflict(row),
      mintAttempted: (id, outcome) => mintMergeEscalationEvent(id, outcome),
      noteLine: (line) => console.error(`[keeperd] ${line}`),
    });
  }
  // Gated on the autopilot role — the sweep LAUNCHES a session, so it runs only where the
  // launcher is reachable (a server-only boot never dispatches). Rides the same 60s
  // heartbeat as the resolver-dispatch sweep.
  const mergeEscalationSweepTimer = want("autopilot")
    ? setInterval(() => {
        void runMergeEscalationSweepTick().catch((err) => {
          console.error(
            `[keeperd] deconflict-dispatch sweep tick threw (non-fatal): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }, BLOCK_ESCALATION_SWEEP_INTERVAL_MS)
    : null;

  // The stage-3 board-state gate for the deconflict notify: is the epic's sticky
  // `close::<epic>` merge-conflict row still present? A successful deconflict clears it
  // (its own `retry_dispatch`) before the notify fires, so a surviving row means the
  // conflict is unresolved — the incident {@link classifyEscalationOutcome} may page on.
  // A read miss degrades to `false` (incident treated closed → the notify WAITS, never a
  // premature page on a transient error), mirroring the empty-jobs `{terminal:false}`
  // fallback.
  function deconflictIncidentOpen(id: string): boolean {
    try {
      return (
        db
          .query(
            "SELECT 1 FROM dispatch_failures WHERE verb = 'close' AND id = ? LIMIT 1",
          )
          .get(id) != null
      );
    } catch {
      return false;
    }
  }

  // The sticky close row's `instance_event_id` — the block-instance anchor the
  // resolver-outcome probe (stage 2) and the deconflict human-notify (stage 3) both
  // scope their jobs reads on, so a stale resolve/deconflict row from a resolved
  // incident never suppresses or prematurely fires a re-escalated close. The column is
  // marker-agnostic (the first-appearance incident id, preserved through UPSERT), so
  // one read serves both stages. A read miss or absent row degrades to NULL (the
  // unscoped verb+ref fallback), never a thrown error.
  function stickyCloseInstanceFor(id: string): number | null {
    try {
      const row = db
        .query(
          "SELECT instance_event_id FROM dispatch_failures WHERE verb = 'close' AND id = ? LIMIT 1",
        )
        .get(id) as { instance_event_id: number | null } | null;
      return row?.instance_event_id ?? null;
    } catch {
      return null;
    }
  }

  // Producer-side deconflict human-notify sweep (fn-1129 stage 3). Each heartbeat tick
  // walks the sticky closes whose deconflict session was dispatched but whose human is
  // not yet notified, and sends ONE botctl notification once that session reaches a
  // TERMINAL decline/death — then mints `MergeHumanNotified{outcome}`. A terminal
  // `notified` stamps the `human_notified_at` once-marker so the human is notified ONCE;
  // a `notify_failed` re-sweeps. A successful deconflict clears the sticky (its own
  // `retry_dispatch`) before this ever fires. Same pause + autopilot-role gating as the
  // dispatch sweep.
  async function runDeconflictHumanNotifySweepTick(): Promise<void> {
    if (shuttingDown) return;
    if (autopilotPaused) return;
    await runDeconflictHumanNotifySweep({
      selectPending: () => selectPendingHumanNotifications(db),
      stillPending: (id) => {
        try {
          return (
            db
              .query(
                "SELECT 1 FROM dispatch_failures WHERE verb = 'close' AND id = ? AND human_notified_at IS NULL LIMIT 1",
              )
              .get(id) != null
          );
        } catch {
          return false;
        }
      },
      deconflictOutcome: (id) =>
        classifyEscalationOutcome(
          resolveEscalationJobsFor(
            db,
            "deconflict",
            id,
            stickyCloseInstanceFor(id),
          ),
          "deconflict",
          id,
          deconflictIncidentOpen(id),
        ),
      notifyHuman: (row, verdict) => notifyHumanOfDeconflict(row, verdict),
      mintAttempted: (id, outcome) => mintMergeHumanNotifiedEvent(id, outcome),
      noteLine: (line) => console.error(`[keeperd] ${line}`),
    });
  }
  const deconflictHumanNotifySweepTimer = want("autopilot")
    ? setInterval(() => {
        void runDeconflictHumanNotifySweepTick().catch((err) => {
          console.error(
            `[keeperd] deconflict human-notify sweep tick threw (non-fatal): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }, BLOCK_ESCALATION_SWEEP_INTERVAL_MS)
    : null;

  // Launch ONE `unblock::<task>` escalation session for a blocked task with an
  // escalatable category. Sibling of `dispatchDeconflict`: cwd = the task's effective
  // repo (the lane worktree / project dir — the skill re-derives context from its
  // escalation brief), the prompt is `/plan:unblock <task>`, and the launch runs at the
  // SEPARATE escalation model/effort via the shared `dispatchEscalationSession` (so the
  // global cap + per-key occupancy guard apply). Producer-only — never reachable from a
  // fold.
  async function dispatchUnblock(
    row: PendingBlockEscalation,
  ): Promise<EscalationDispatchOutcome> {
    return dispatchEscalationSession(liveEscalationDispatchDeps, {
      verb: "unblock",
      id: row.task_id,
      prompt: defaultPlanPrompt("unblock", row.task_id),
      cwd: effectiveBlockEscalationRepo(row.target_repo, row.project_dir),
    });
  }

  // The per-EPIC serialization guard: is any `unblock::<task>` session for a task in
  // `epicId` already live? Reads the live jobs (mapped task→epic via `epicHasLiveUnblock`)
  // PLUS the producer's not-yet-folded in-flight memo (a session launched THIS tick that
  // has not folded a jobs row yet), so a same-epic sibling can never double-dispatch while
  // one is in flight. `readLiveEscalationJobs` GCs the memo first, so the two reads stay
  // disjoint.
  function epicUnblockLive(epicId: string): boolean {
    const jobs = readLiveEscalationJobs();
    for (const key of inFlightEscalations.keys()) {
      if (!key.startsWith("unblock::")) continue;
      const parsed = parsePlanRef(key.slice("unblock::".length));
      if (parsed != null && parsed.epic_id === epicId) return true;
    }
    return epicHasLiveUnblock(jobs, epicId);
  }

  // Send the ONE botctl notification about a declined/dead `unblock::<task>` session
  // (stage 3). Sibling of `notifyHumanOfDeconflict`: ASYNC spawn, array form so the body
  // rides as a literal argv element (no shell interpolation). A non-zero exit OR a missing
  // botctl maps to `notify_failed` — NON-terminal, so the marker stays NULL and the row
  // re-sweeps: the notification is never lost, and the blocked task stays operator-visible
  // on the board throughout.
  async function notifyHumanOfBlock(
    row: PendingBlockHumanNotify,
    verdict: "declined" | "died",
  ): Promise<BlockHumanNotifiedOutcome> {
    const body = buildBlockHumanNotifyBody({
      epicId: row.epic_id,
      taskId: row.task_id,
      verdict,
    });
    try {
      const proc = Bun.spawn(
        ["botctl", "send-message", "--topic", KEEPER_TOPIC, body],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          env: process.env as Record<string, string | undefined>,
        },
      );
      const exitCode = await proc.exited;
      return exitCode === 0 ? "notified" : "notify_failed";
    } catch (err) {
      console.error(
        `[keeperd] unblock human-notify spawn threw for ${row.task_id} (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return "notify_failed";
    }
  }

  // Producer-side block/unblock-dispatch sweep (fn-1129 stage 2), the rewired successor to
  // the block-escalation planner@ notify. Each heartbeat tick walks the pending
  // `block_escalations` latch rows, gates each by the cancellation guard + the
  // TOOLING_FAILURE denylist (surface-and-stop still suppresses `work::<task>` re-dispatch,
  // never dispatching an agent), and DISPATCHES one `unblock::<task>` escalation session
  // per escalatable block — SERIALIZED per epic (at most one live unblock per epic). A
  // terminal `dispatched` stamps the latch to `attempted` (the reducer fold); a
  // `dispatch_failed` resets it to `pending`, and a cap/occupancy or same-epic
  // serialization SKIP leaves it `pending` — all re-sweepable. All wall-clock + fs + spawn
  // lives HERE in the producer; the spawn lives only here, so a re-fold never re-fires a
  // launch.
  async function runBlockEscalationSweepTick(): Promise<void> {
    if (shuttingDown) return;
    // Paused = the human is in control; a paused board never auto-dispatches a NEW
    // escalation session, mirroring the deconflict + resolver + reconciler pause gate.
    if (autopilotPaused) return;
    await runBlockEscalationSweep({
      selectPending: () => selectPendingBlockEscalations(db),
      readBlockedReason: readTaskBlockedReason,
      mintRequested: (epicId, taskId) =>
        mintBlockEscalationEvent(
          "BlockEscalationRequested",
          epicId,
          taskId,
          null,
        ),
      mintAttempted: (epicId, taskId, outcome) =>
        mintBlockEscalationEvent(
          "BlockEscalationAttempted",
          epicId,
          taskId,
          outcome,
        ),
      dispatchUnblock: (row) => dispatchUnblock(row),
      isEpicUnblockLive: (epicId) => epicUnblockLive(epicId),
      auditOrchestratorLiveness: (row) =>
        probeAuditOrchestrator(
          readAuditOrchestratorJobs(row.epic_id, row.task_id),
          row.epic_id,
          row.task_id,
        ),
      now: () => Date.now(),
      hasOpenWorkFailure: (taskId) => {
        try {
          return (
            db
              .query(
                "SELECT 1 FROM dispatch_failures WHERE verb = 'work' AND id = ? LIMIT 1",
              )
              .get(taskId) != null
          );
        } catch {
          // Fail-open: a read miss re-mints, which is an idempotent UPSERT (the
          // row's `created_at` is preserved), so the worst case is one redundant
          // event — never a missed suppression.
          return false;
        }
      },
      suppressRedispatch: ({ taskId, reason, dir }) =>
        handleDispatchFailedMint({
          verb: "work",
          id: taskId,
          reason,
          dir,
          ts: Date.now() / 1000,
        }),
      noteLine: (line) => console.error(`[keeperd] ${line}`),
    });
  }
  // Gated on the autopilot role — the sweep LAUNCHES a session, so it runs only where the
  // launcher is reachable (a server-only boot never dispatches). Rides the same 60s
  // heartbeat as the deconflict-dispatch sweep.
  const blockEscalationSweepTimer = want("autopilot")
    ? setInterval(() => {
        void runBlockEscalationSweepTick().catch((err) => {
          console.error(
            `[keeperd] block-escalation sweep tick threw (non-fatal): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }, BLOCK_ESCALATION_SWEEP_INTERVAL_MS)
    : null;

  // The stage-3 board-state gate for the unblock notify: is the task's block still OPEN
  // under an `attempted` latch? The `block_escalations` latch is DELETED the moment the
  // task leaves `blocked`, so a surviving `status='attempted'` row means the escalation
  // was dispatched AND the task is still blocked — the incident {@link
  // classifyEscalationOutcome} may page on. A read miss degrades to `false` (incident
  // treated closed → the notify WAITS, never a premature page on a transient error).
  // `task_id` is globally unique (`<epic>.<ordinal>`), so it keys the (epic_id, task_id)
  // latch alone.
  function unblockIncidentOpen(taskId: string): boolean {
    try {
      return (
        db
          .query(
            "SELECT 1 FROM block_escalations WHERE task_id = ? AND status = 'attempted' LIMIT 1",
          )
          .get(taskId) != null
      );
    } catch {
      return false;
    }
  }

  // The block latch's `blocked_since` — the block-instance anchor stage-3 scopes
  // {@link resolveEscalationJobsFor} on so a stale row from a resolved (unblocked) prior
  // instance never suppresses or prematurely pages a re-blocked task's fresh escalation.
  // A read miss or absent latch degrades to NULL (the unscoped verb+ref fallback), never
  // a thrown error. `task_id` is globally unique, keying the latch alone.
  function unblockInstanceFor(taskId: string): number | null {
    try {
      const row = db
        .query(
          "SELECT blocked_since FROM block_escalations WHERE task_id = ? AND status = 'attempted' LIMIT 1",
        )
        .get(taskId) as { blocked_since: number } | null;
      return row?.blocked_since ?? null;
    } catch {
      return null;
    }
  }

  // Producer-side unblock human-notify sweep (fn-1129 stage 3). Each heartbeat tick walks
  // the block latches whose `unblock::<task>` session was dispatched but whose human is
  // not yet notified, and sends ONE botctl notification once that session reaches a
  // TERMINAL decline/death — then mints `BlockHumanNotified{outcome}`. A terminal
  // `notified` stamps the `human_notified_at` once-marker so the human is notified ONCE; a
  // `notify_failed` re-sweeps. A successful unblock takes the task out of `blocked`,
  // deleting the latch before this ever fires. Same pause + autopilot-role gating as the
  // dispatch sweep.
  async function runBlockHumanNotifySweepTick(): Promise<void> {
    if (shuttingDown) return;
    if (autopilotPaused) return;
    await runBlockHumanNotifySweep({
      selectPending: () => selectPendingBlockHumanNotifications(db),
      stillPending: (epicId, taskId) => {
        try {
          return (
            db
              .query(
                "SELECT 1 FROM block_escalations WHERE epic_id = ? AND task_id = ? AND status = 'attempted' AND outcome = 'dispatched' AND human_notified_at IS NULL LIMIT 1",
              )
              .get(epicId, taskId) != null
          );
        } catch {
          return false;
        }
      },
      unblockOutcome: (taskId) =>
        classifyEscalationOutcome(
          resolveEscalationJobsFor(
            db,
            "unblock",
            taskId,
            unblockInstanceFor(taskId),
          ),
          "unblock",
          taskId,
          unblockIncidentOpen(taskId),
        ),
      notifyHuman: (row, verdict) => notifyHumanOfBlock(row, verdict),
      mintAttempted: (epicId, taskId, outcome) =>
        mintBlockHumanNotifiedEvent(epicId, taskId, outcome),
      noteLine: (line) => console.error(`[keeperd] ${line}`),
    });
  }
  const blockHumanNotifySweepTimer = want("autopilot")
    ? setInterval(() => {
        void runBlockHumanNotifySweepTick().catch((err) => {
          console.error(
            `[keeperd] unblock human-notify sweep tick threw (non-fatal): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }, BLOCK_ESCALATION_SWEEP_INTERVAL_MS)
    : null;

  // Producer-side SHARED_BASE_BROKEN repair-escalation sweep (fn-1173). Each heartbeat
  // tick coalesces every shared-base-broken blocked task to one `repair::<repo-token>`
  // dispatch per repo (write-capable, trunk-committing), pages a declined repair ONCE via
  // the `human_notified_at` gate, and clears the sticky row on positive evidence (base
  // green + zero remaining candidates). All wall-clock + fs + spawn lives HERE in the
  // producer; the spawn lives only here, so a re-fold never re-fires a launch.

  // Read the `git_status` projection dirty-count for a repo dir. Returns the count, or
  // `null` when no row exists (an unseeded / unknown surface — never treated as clean).
  function repoDirtyCount(repoDir: string): number | null {
    try {
      const row = db
        .query("SELECT dirty_count FROM git_status WHERE project_dir = ?")
        .get(repoDir) as { dirty_count: number } | null | undefined;
      return row == null ? null : row.dirty_count;
    } catch {
      return null;
    }
  }
  // DEFER gate: a repo whose shared checkout is dirty (>0) OR unknown (no seeded row) is
  // NOT safe for a write-capable repair launch, so DEFER conservatively on both.
  function isRepairCheckoutDirty(repoDir: string): boolean {
    const n = repoDirtyCount(repoDir);
    return n == null || n > 0;
  }
  // Positive-evidence gate: the base reads green only when the shared checkout is seeded
  // AND clean (dirty_count === 0). Unknown / dirty RETAINS the sticky row (no false clear).
  function isRepairBaseGreen(repoDir: string): boolean {
    return repoDirtyCount(repoDir) === 0;
  }

  // Build the repair candidate set from the SHARED_BASE_BROKEN blocked tasks: reuse the
  // block-escalation pending selector + the fs reason read, keep only the shared-base
  // route, and resolve each to (repo_dir, repo_token, fingerprint). Producer-side fs reads
  // are legal outside any fold. A row with no effective repo is skipped (unrepairable).
  function selectRepairCandidates(): RepairCandidate[] {
    const out: RepairCandidate[] = [];
    for (const row of selectPendingBlockEscalations(db)) {
      if (row.runtime_status !== "blocked") continue;
      const reason = readTaskBlockedReason(row.project_dir, row.task_id);
      if (routeBlockedCategory(parseBlockedCategory(reason)) !== "repair") {
        continue;
      }
      const repoDir = effectiveBlockEscalationRepo(
        row.target_repo,
        row.project_dir,
      );
      if (repoDir === "") continue;
      out.push({
        epic_id: row.epic_id,
        task_id: row.task_id,
        repo_dir: repoDir,
        repo_token: repoToken(repoDir),
        // `reason` is non-null here (route === "repair" required a parseable category).
        fingerprint: fingerprintFailure(reason ?? ""),
      });
    }
    return out;
  }

  // Read the existing sticky repair rows off the writable connection (sequenced inside
  // the same writer that mints). A read failure degrades to an empty set (the sweep
  // re-sweeps next tick).
  function selectRepairRows(): PendingRepairRow[] {
    try {
      return db
        .query(
          "SELECT id, reason, dir, repair_dispatched_at, human_notified_at FROM dispatch_failures WHERE verb = 'repair'",
        )
        .all() as PendingRepairRow[];
    } catch {
      return [];
    }
  }

  // Launch ONE `repair::<repo-token>` escalation session. cwd = the repo's SHARED
  // checkout (the repo dir itself — NOT the lane-or-project resolution unblock uses),
  // where the base branch lives and `keeper commit-work` lands a trunk commit; the prompt
  // is `/plan:repair <token>`, run at the escalation model/effort via the shared
  // `dispatchEscalationSession` (so the global cap + per-key occupancy guard apply).
  async function dispatchRepair(
    group: RepairGroup,
  ): Promise<EscalationDispatchOutcome> {
    return dispatchEscalationSession(liveEscalationDispatchDeps, {
      verb: "repair",
      id: group.repo_token,
      prompt: defaultPlanPrompt("repair", group.repo_token),
      cwd: group.repo_dir,
    });
  }

  // Send the ONE botctl page about a declined/dead `repair::<token>` session. Sibling of
  // `notifyHumanOfBlock`: ASYNC spawn, array form so the body rides as a literal argv
  // element. A non-zero exit OR a missing botctl maps to `notify_failed` — NON-terminal,
  // so the marker stays NULL and the row re-sweeps: the page is never lost, and the sticky
  // repair row stays operator-visible on the board throughout.
  async function notifyHumanOfRepair(
    row: PendingRepairRow,
    verdict: "declined" | "died",
  ): Promise<RepairHumanNotifiedOutcome> {
    const body = buildRepairHumanNotifyBody({
      repoToken: row.id,
      repoDir: row.dir,
      verdict,
    });
    try {
      const proc = Bun.spawn(
        ["botctl", "send-message", "--topic", KEEPER_TOPIC, body],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          env: process.env as Record<string, string | undefined>,
        },
      );
      const exitCode = await proc.exited;
      return exitCode === 0 ? "notified" : "notify_failed";
    } catch (err) {
      console.error(
        `[keeperd] repair human-notify spawn threw for ${row.id} (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return "notify_failed";
    }
  }

  // The stage-3 board-state gate for the repair notify: is the sticky
  // `repair::<token>` row still present? A successful repair clears it (the sweep's
  // positive-evidence `DispatchCleared`) before the notify fires, so a surviving row
  // means the breakage is unresolved — the incident {@link classifyEscalationOutcome}
  // may page on. A read miss degrades to `false` (incident treated closed → the
  // notify WAITS, never a premature page on a transient error), mirroring
  // {@link deconflictIncidentOpen}.
  function repairIncidentOpen(token: string): boolean {
    try {
      return (
        db
          .query(
            "SELECT 1 FROM dispatch_failures WHERE verb = 'repair' AND id = ? LIMIT 1",
          )
          .get(token) != null
      );
    } catch {
      return false;
    }
  }

  // The sticky repair row's `instance_event_id` — the incident anchor the repair
  // human-notify probe scopes its jobs read on, so a stale `repair::<token>` session
  // row from a resolved (cleared) prior breakage never suppresses or prematurely
  // fires the notify for a re-minted one. A read miss or absent row degrades to NULL
  // (the unscoped verb+ref fallback), never a thrown error — mirrors
  // {@link stickyCloseInstanceFor}.
  function stickyRepairInstanceFor(token: string): number | null {
    try {
      const row = db
        .query(
          "SELECT instance_event_id FROM dispatch_failures WHERE verb = 'repair' AND id = ? LIMIT 1",
        )
        .get(token) as { instance_event_id: number | null } | null;
      return row?.instance_event_id ?? null;
    } catch {
      return null;
    }
  }

  async function runRepairEscalationSweepTick(): Promise<void> {
    if (shuttingDown) return;
    // Paused = the human is in control; a paused board never auto-dispatches a NEW
    // escalation session (mirrors the block/deconflict/resolver pause gate). So a fresh
    // shared-base breakage on a paused board defers BOTH the repair dispatch and the page
    // until play.
    if (autopilotPaused) return;
    await runRepairEscalationSweep({
      selectCandidates: () => selectRepairCandidates(),
      selectRepairRows: () => selectRepairRows(),
      isDirtyCheckout: (repoDir) => isRepairCheckoutDirty(repoDir),
      isBaseGreen: (repoDir) => isRepairBaseGreen(repoDir),
      dispatchRepair: (group) => dispatchRepair(group),
      repairOutcome: (token) =>
        classifyEscalationOutcome(
          resolveEscalationJobsFor(
            db,
            "repair",
            token,
            stickyRepairInstanceFor(token),
          ),
          "repair",
          token,
          repairIncidentOpen(token),
        ),
      notifyHuman: (row, verdict) => notifyHumanOfRepair(row, verdict),
      mintRow: (group) =>
        mintRepairRowEvent(
          group.repo_token,
          repairReasonFor(group.fingerprint),
          group.repo_dir,
          Date.now() / 1000,
        ),
      mintDispatched: (token, outcome) =>
        mintRepairDispatchedEvent(token, outcome),
      mintNotified: (token, outcome) =>
        mintRepairHumanNotifiedEvent(token, outcome),
      clearRow: (token) => mintDispatchClearedEvent("repair", token),
      noteLine: (line) => console.error(`[keeperd] ${line}`),
    });
  }
  // Gated on the autopilot role — the sweep LAUNCHES a session, so it runs only where the
  // launcher is reachable. Rides the same 60s heartbeat as the block-escalation sweep.
  const repairEscalationSweepTimer = want("autopilot")
    ? setInterval(() => {
        void runRepairEscalationSweepTick().catch((err) => {
          console.error(
            `[keeperd] repair-escalation sweep tick threw (non-fatal): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }, BLOCK_ESCALATION_SWEEP_INTERVAL_MS)
    : null;

  // Producer-side resolver-dispatch (fn-1088), the ACTIVE sibling of the
  // merge-escalation notify above. Where that sweep pings a human ONCE, this one
  // launches ONE autonomous `resolve::<epic>` merge-resolver worker ONCE per sticky
  // condition — narrower authority (mechanically-clear conflicts only; everything else
  // stamps BLOCKED and stays for the human). The `resolver_dispatched_at` latch is a
  // DISTINCT column from `merge_escalated_at`, but the two are no longer independent: the
  // human escalation is SEQUENCED behind this resolver (the notify fires only once a
  // resolver was dispatched AND reached a terminal verdict — declined/BLOCKED or job
  // death), so the two never race the same base. Both re-arm at NULL only when
  // `retry_dispatch` drops the row.
  //
  // Spawns into the MANAGED autopilot session with `--name resolve::<epic>`, so the
  // worker folds a first-class `jobs` row and every reap / instant-death-breaker /
  // slot-occupancy discipline applies to it like any dispatch key. That live jobs row
  // IS the mutex: the recover sweep's pass-1 skips a lane whose epic has a live
  // `resolve::<epic>` job (`epicHasActiveResolver`), a SCOPED per-epic exclusion that
  // replaced the resolver's old GLOBAL `keeper autopilot pause` — so a crashed resolver
  // strands nothing (the skip auto-lifts on reap) and concurrent fan-ins stay
  // independent. The launch cwd is the epic's base worktree (where the fan-in lives).
  async function dispatchResolver(
    row: PendingResolverDispatch,
  ): Promise<ResolverDispatchResult> {
    // The checkout where finalize ran the failing merge (the conflict lives there):
    // `mergeConflictBaseCheckout` maps a default-branch base to the repo root (the shared
    // default checkout, never laned) and a `keeper/epic/…` lane base to its worktree. A
    // parse-miss / no repo dir degrades to the repo root; the brief guides the worker.
    const parsed = parseMergeConflictReason(row.reason);
    const hasRepo = row.dir != null && row.dir !== "";
    const cwd =
      parsed != null && hasRepo
        ? mergeConflictBaseCheckout(row.dir as string, parsed.base)
        : (row.dir ?? "");
    // Per-checkout occupancy guard: a DIFFERENT live merge-recreating escalation session
    // (`resolve::`/`deconflict::`) already holds this base checkout, so recreating the
    // merge here would contend for the one working tree. SKIP without launching — the row
    // re-sweeps and dispatches once the occupying session terminates. Per checkout, never
    // global: a resolver for a different repo's checkout dispatches concurrently.
    if (escalationCheckoutOccupied("resolve", row.id, cwd)) {
      console.error(
        `[keeperd] # resolver dispatch skipped — checkout ${cwd} busy; resolve::${row.id} stays pending`,
      );
      return "checkout_busy";
    }
    const spec: LaunchSpec = {
      prompt: buildResolverBrief({
        epicId: row.id,
        reason: row.reason,
        repoDir: row.dir,
      }),
      claudeName: `resolve::${row.id}`,
      model: WORKER_MODEL,
      effort: WORKER_EFFORT,
    };
    const result = await keeperAgentLaunch({
      noteLine: (line) => console.error(`[keeperd] ${line}`),
      launcherArgvPrefix,
      session: MANAGED_EXEC_SESSION,
      cwd,
      label: `resolve::${row.id}`,
      spec,
    });
    // A launch failure (bad launcher / ENOENT cwd / non-zero exit) is NON-terminal:
    // the marker stays NULL and the row re-sweeps next tick, exactly like the
    // merge-escalation `send_failed`. A successful launch stamps the once-marker, so
    // even a resolver that then declines or dies mints no second dispatch — and records
    // its base checkout so the per-checkout guard serializes a within-tick sibling
    // before the resolver's jobs row folds.
    if (result.ok) {
      inFlightCheckouts.set(`resolve::${row.id}`, { cwd, ts: Date.now() });
    }
    return result.ok ? "dispatched" : "dispatch_failed";
  }

  async function runResolverDispatchSweepTick(): Promise<void> {
    if (shuttingDown) return;
    // Paused = the human is in control (the `[paused]` banner is authoritative); a
    // paused board never auto-dispatches a NEW resolver, mirroring the reconciler's own
    // pause gate. Pause does NOT stop an in-flight resolver, and the merge-escalation
    // sweep still runs — it stays sequenced behind that resolver's verdict. So a fresh
    // sticky on a paused board defers BOTH the launch and the notify until play (a human
    // watching a paused board reads the sticky via `keeper status` meanwhile).
    if (autopilotPaused) return;
    await runResolverDispatchSweep({
      selectPending: () => selectPendingResolverDispatches(db),
      stillPending: (id) => {
        try {
          return (
            db
              .query(
                "SELECT 1 FROM dispatch_failures WHERE verb = 'close' AND id = ? AND resolver_dispatched_at IS NULL LIMIT 1",
              )
              .get(id) != null
          );
        } catch {
          // A point-read failure (unexpected) conservatively skips THIS tick's launch
          // for the row — the selector already succeeded, the marker stays NULL, and
          // the next heartbeat re-sweeps. Never a false dispatch.
          return false;
        }
      },
      dispatchResolver: (r) => dispatchResolver(r),
      mintAttempted: (id, outcome) => mintResolverDispatchEvent(id, outcome),
      noteLine: (line) => console.error(`[keeperd] ${line}`),
    });
  }
  // Gated on the autopilot role — the sweep LAUNCHES a worker, so it runs only where
  // the launcher is reachable (a server-only boot never dispatches). Rides the same
  // 60s heartbeat as the merge-escalation sweep.
  const resolverDispatchSweepTimer = want("autopilot")
    ? setInterval(() => {
        void runResolverDispatchSweepTick().catch((err) => {
          console.error(
            `[keeperd] resolver-dispatch sweep tick threw (non-fatal): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }, BLOCK_ESCALATION_SWEEP_INTERVAL_MS)
    : null;

  // Codex resume-target back-fill producer (fn-1103). A tracked codex job is born
  // with resume_target NULL (it mints its own rollout uuid post-launch); this
  // sweep resolves that uuid from the rollout SessionMeta head — originator
  // exact-match (the launcher's CODEX_INTERNAL_ORIGINATOR_OVERRIDE) first, cwd +
  // created-at with refuse-to-guess fallback — and has MAIN mint a
  // `ResumeTargetResolved` synthetic event (never a direct jobs write, so a
  // from-scratch re-fold reproduces it). Reads ONLY session metadata, never
  // content, and does NO tree read when no NULL-target codex job exists (the
  // candidate query is an indexed point-read). Gated on the `exit` lifecycle role
  // — the sibling steady-state jobs producer — so a server-only boot skips it. A
  // per-tick no-throw guard keeps a transient rollout-read error off fatalExit.
  const codexResumeHome = resolveCodexHomeDir();
  // Codex live-state producer cursors (fn-1103): per-job rollout forward-tail
  // offsets, EOF-anchored on first sight and GC'd once a job leaves the live set,
  // so the map stays bounded by the live codex sessions, never history. Rides the
  // same `exit`-role sweep tick as the resume back-fill below.
  const codexStateCursors = new Map<string, RolloutCursor>();
  const codexResumeSweepTimer = want("exit")
    ? setInterval(() => {
        if (shuttingDown) return;
        try {
          const resolutions = resolveCodexResumeCandidates(
            db,
            codexResumeHome,
            Date.now() / 1000,
            CODEX_RESUME_RECENT_WINDOW_SEC,
          );
          let minted = false;
          for (const resolution of resolutions) {
            // Re-read: mint only while resume_target is still NULL. The candidate
            // query already filters it, but a concurrent fold (a resume re-seed)
            // could have set it since — never overwrite a resolved target.
            const row = db
              .query("SELECT resume_target FROM jobs WHERE job_id = ?")
              .get(resolution.jobId) as { resume_target: string | null } | null;
            if (!row || row.resume_target != null) {
              continue;
            }
            mintResumeTargetResolved(resolution);
            minted = true;
          }
          if (minted) {
            wakePending = true;
            pumpWakes();
          }
        } catch (err) {
          console.error(
            `[keeperd] codex-resume sweep tick threw (non-fatal): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        // Pi resume-target REPAIR (fn-1162) — the twin pass beside the codex NULL
        // back-fill, under its OWN guard so a pi store throw never skips the codex
        // mints (and vice versa). Heals a LIVE pi job whose recorded resume target
        // rotted (names no on-disk artifact) by disk-anchoring a same-cwd session
        // via the SAME confidence gate `keeper tabs repair` reports with — only an
        // UNAMBIGUOUS single-candidate match. Re-reads resume_target before minting
        // and applies only while it still equals the rotted target the proposal was
        // computed against, so a concurrent fix is never clobbered.
        try {
          const repairs = resolvePiResumeRepairs(
            db,
            homedir(),
            process.env as Record<string, string | undefined>,
            Date.now() / 1000,
            PI_RESUME_REPAIR_RECENT_WINDOW_SEC,
          );
          let repaired = false;
          for (const repair of repairs) {
            if (repair.newTarget === repair.oldTarget) {
              continue; // no-op — never mint an identity re-pin.
            }
            const row = db
              .query("SELECT resume_target FROM jobs WHERE job_id = ?")
              .get(repair.jobId) as { resume_target: string | null } | null;
            if (!row || row.resume_target !== repair.oldTarget) {
              continue; // changed concurrently — never clobber a resolved target.
            }
            mintResumeTargetResolved({
              jobId: repair.jobId,
              resumeTarget: repair.newTarget,
            });
            repaired = true;
          }
          if (repaired) {
            wakePending = true;
            pumpWakes();
          }
        } catch (err) {
          console.error(
            `[keeperd] pi-resume repair sweep tick threw (non-fatal): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        // Codex live stop-churn (fn-1103) rides the same tick under its OWN guard,
        // so a rollout-tail throw never skips the resume mint above (and vice
        // versa). Forward-tails each attributed codex job's rollout and mints a
        // synthetic Stop per turn-completion — an unattributed job is absent from
        // the query and stays presence-only. A job attributed THIS tick is folded
        // by a later tick, so the state read here always sees the settled target.
        try {
          const stopSignals = collectCodexStopSignals(
            findLiveCodexStateJobs(db),
            codexResumeHome,
            codexStateCursors,
          );
          if (stopSignals.length > 0) {
            for (const signal of stopSignals) {
              mintCodexStop(signal);
            }
            wakePending = true;
            pumpWakes();
          }
        } catch (err) {
          console.error(
            `[keeperd] codex-state sweep tick threw (non-fatal): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        // Codex rollout-ADOPTION discovery (fn-1131) rides the same tick under its
        // OWN guard, so a scan/mint throw here never skips the resume/state mints
        // above (and vice versa). Knob-gated OFF by default and re-read inside the
        // sweep (a live kill-switch); when ON it discovers originator-less,
        // sole-for-cwd rollouts within the recency window and has MAIN mint each,
        // capped, as a coordless adopted job. A just-adopted job (resume_target =
        // its own uuid) is picked up by the live-state tailer on a later tick.
        try {
          const adopted = runCodexAdoptionSweep(
            db,
            codexResumeHome,
            Date.now() / 1000,
            CODEX_ADOPTION_RECENT_WINDOW_SEC,
            CODEX_ADOPTION_MINT_CAP_PER_TICK,
          );
          if (adopted > 0) {
            wakePending = true;
            pumpWakes();
          }
        } catch (err) {
          console.error(
            `[keeperd] codex-adoption sweep tick threw (non-fatal): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }, CODEX_RESUME_SWEEP_INTERVAL_MS)
    : null;

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
    // fn-1103: the births tree rides the SAME fallback tick (own guard so a
    // birth-scan throw never skips the wake). The watcher hint is the fast path;
    // this poll guarantees every record lands within one interval even if the
    // birth-ingest worker never subscribed or dropped an event.
    try {
      scanBirthDir(db, birthDir, eventsIngestCtx);
      wakePending = true;
      pumpWakes();
    } catch (err) {
      console.error(
        `[keeperd] births fallback scan threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }, EVENTS_INGEST_FALLBACK_INTERVAL_MS);

  // Producer-side retention pass. TWO complementary reclaims, both paced so the
  // writer lock never starves a concurrent hook INSERT and both gated strictly
  // below the fold cursor + cold watermark:
  //  - BODY-NULL (fn-836.5): NULLs the cold tail of redundant shed-class
  //    `events.data` bodies in place — the complement of the keep-set ALLOW-list,
  //    whose file_path the fold reads from `mutation_path` not the body. Reclaims
  //    body bytes, never rows.
  //  - ROW-DELETE (fn-934.5): physically DELETEs the cold tail of the no-op-arm
  //    snapshot classes (`BackendExecSnapshot`/`TmuxPaneSnapshot`/
  //    `WindowIndexSnapshot`), reclaiming the per-row overhead the NULL pass
  //    leaves behind. PROVEN re-fold-safe for those three ONLY (no-op fold arms,
  //    no producer-scanned column), pinned by a guarding test.
  // Both run ON THE MAIN THREAD against the writable connection (keeper's OWN
  // writer process — a separate process + long reader would pin the WAL), STRICTLY
  // outside the fold, returning freed pages via per-batch `incremental_vacuum`.
  // `events.data` is the canonical event log, NOT a reducer projection: NULLing a
  // redundant shed-class body and deleting a no-op-snapshot row both touch no
  // projection, so a from-scratch re-fold over the surviving rows stays
  // byte-identical. The shed predicate (`src/compaction.ts`) never strips a body
  // the fold still needs (it excludes any row still owing a `mutation_path`
  // backfill).
  //
  // Reclaimable-space observability (fn-1051): body-NULLing feeds pages to the
  // freelist that only an offline `keeper reclaim` returns to the filesystem. The
  // step-latch below emits the pool size ONLY on a fresh 100MB step crossing — an
  // unconditional per-pass line would grow the very server.stderr this epic bounds.
  let lastLoggedReclaimStep = 0;
  function runRetentionPass(): void {
    if (shuttingDown) return;
    let shed = 0;
    let deleted = 0;
    try {
      const result = retainColdPayloads(db);
      shed = result.shed;
      if (shed > 0) {
        console.error(
          `[keeperd] retention: shed ${shed} cold body/bodies in ${result.batches} batch(es), reclaimed ${result.reclaimedPages} page(s) (watermark id<=${result.coldWatermark}, cursor<${result.cursor}${result.moreLikely ? ", more remain" : ""})`,
        );
      }
      // Row-growth bound (fn-934.5): physically DELETE cold rows of the no-op-arm
      // snapshot classes — the body-NULL pass above reclaims body bytes but never
      // the per-row overhead. PROVEN re-fold-safe for these three classes ONLY
      // (their fold arms are no-ops and they carry no producer-scanned column);
      // the predicate is pinned to that set by a guarding test so it can't widen.
      // Same writable-connection / paced / cursor-gated discipline as the NULL
      // pass — and it runs in keeper's OWN writer process (a separate process + a
      // long reader would pin the WAL during the delete).
      const del = deleteNoopSnapshotRows(db);
      deleted = del.deleted;
      if (deleted > 0) {
        console.error(
          `[keeperd] retention: deleted ${deleted} cold no-op-snapshot row(s) in ${del.batches} batch(es), reclaimed ${del.reclaimedPages} page(s) (watermark id<=${del.coldWatermark}, cursor<${del.cursor}${del.moreLikely ? ", more remain" : ""})`,
        );
      }
      // Row-growth bound for the epic fn-952 `TmuxClientFocusSnapshot` tail —
      // active window/session navigation logs a slow trickle of focus snapshots.
      // Re-fold-safe for an INDEPENDENT reason from the no-op classes: the focus
      // fold writes ONLY the `tmux_client_focus` LIVE-ONLY singleton and the rows
      // carry no producer-scanned column, so deleting a cold one leaves every
      // deterministic projection byte-identical (its own SAFE+NECESSARY pair pins
      // this). A SEPARATELY-NAMED predicate, never folded into the no-op set.
      const focusDel = deleteColdTmuxFocusRows(db);
      deleted += focusDel.deleted;
      if (focusDel.deleted > 0) {
        console.error(
          `[keeperd] retention: deleted ${focusDel.deleted} cold tmux-focus row(s) in ${focusDel.batches} batch(es), reclaimed ${focusDel.reclaimedPages} page(s) (watermark id<=${focusDel.coldWatermark}, cursor<${focusDel.cursor}${focusDel.moreLikely ? ", more remain" : ""})`,
        );
      }
      // Dead-letter retention (resurrection-safe): prune fully-recovered aged
      // sealed files (unlink-FIRST, rows second) + row-only recovered/poison
      // tails. Its own try so a prune failure is non-fatal AND leaves the
      // compaction checkpoint gate below untouched — a DB error here must not
      // forfeit the WAL checkpoint the NULL/DELETE passes just earned. Successful
      // deletions DO count toward the gate (reclaimed dead_letters pages want the
      // same PASSIVE checkpoint).
      try {
        const dlPrune = pruneRecoveredDeadLetters(db, deadLetterDir);
        deleted += dlPrune.prunedRows;
        if (dlPrune.prunedRows > 0) {
          console.error(
            `[keeperd] retention: pruned ${dlPrune.prunedRows} recovered/poison dead-letter row(s) across ${dlPrune.prunedFiles} sealed file(s)`,
          );
        }
      } catch (err) {
        console.error(
          `[keeperd] dead-letter retention threw (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      // The re-spec'd data-loss sentinel: a NULL body that is NOT shed-class is a
      // missing keep-set body — genuine data loss neither retention path can
      // create (the NULL pass matches ONLY shed-class rows; the DELETE pass
      // removes ONLY no-op-snapshot rows, an absent row never surfacing as a NULL
      // body). Logged loudly but NOT fatal. Gate on a pass having moved bytes: a
      // pass that touched nothing cannot have introduced a missing keep-set body,
      // so the scan is wasted work on an idle slack tick.
      if (shed > 0 || deleted > 0) {
        const absent = countAbsentBlobs(db);
        if (absent > 0) {
          console.error(
            `[keeperd] retention BUG: ${absent} keep-set event(s) have a NULL body — data loss, NOT legitimate retention`,
          );
        }
      }
    } catch (err) {
      // A retention failure is pure space-reclamation loss, never a correctness
      // issue (the body stays inline / the row stays present on a rolled-back
      // batch). Log non-fatally; the next slack tick retries.
      console.error(
        `[keeperd] retention pass threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    // Checkpoint WAL space OUTSIDE the per-batch transactions and only when a pass
    // moved bytes (shed a body OR deleted a row). PASSIVE never waits on writers
    // (TRUNCATE would, starving a contending hook); it checkpoints what it can
    // without blocking. Per-batch `incremental_vacuum` already returned freed
    // pages to the file tail.
    if (shed > 0 || deleted > 0) {
      try {
        db.run("PRAGMA wal_checkpoint(PASSIVE)");
      } catch (err) {
        console.error(
          `[keeperd] retention PASSIVE checkpoint threw (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      // Reclaimable-space observability: only a pass that moved bytes can have
      // grown the freelist, so probe it here. Log ONLY on a fresh upward 100MB
      // step and name the remedy; the latch lowers with the pool so a later
      // regrowth re-logs. A cheap pragma probe — fail-open on a read throw.
      try {
        const reclaimable = reclaimableFreelistBytes(db);
        const { shouldLog, step } = reclaimableLogStep(
          reclaimable,
          lastLoggedReclaimStep,
        );
        if (shouldLog) {
          console.error(
            `[keeperd] retention: ~${Math.floor(
              reclaimable / (1024 * 1024),
            )}MB reclaimable on the freelist; run offline \`keeper reclaim\` to return it to the filesystem`,
          );
        }
        lastLoggedReclaimStep = step;
      } catch (err) {
        console.error(
          `[keeperd] retention reclaimable-space probe threw (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  // Schedule the retention pass on its own slack heartbeat. Stored so shutdown
  // can `clearInterval` it. Fires on the MAIN THREAD against the writable conn.
  const retentionTimer = setInterval(() => {
    runRetentionPass();
  }, RETENTION_INTERVAL_MS);

  // Producer-side historical `mutation_path` backfill pass (fn-836.3). Fills the
  // promoted git-attribution column over the historical mutation tail the
  // forward write path (hook deriver + ingester recompute) never touched, reading
  // the inline `events.data` body (post-shed there is no `event_blobs` side
  // table). Paced like retention (≤500 rows/batch, ≤20 batches/pass, crash-safe `meta`
  // watermark advanced in the SAME transaction as each batch's UPDATE), so the
  // writer lock never starves a concurrent hook INSERT and a mid-pass crash
  // resumes from the last committed batch. Runs ON THE MAIN THREAD against the
  // writable connection. `events.mutation_path` is a content-preserving promoted
  // column of the immutable event log, NOT a reducer projection — backfilling it
  // touches no projection, so a from-scratch re-fold stays byte-identical (the
  // fold reads the column's value, which equals what the old two-arm scan read
  // off the body). Once complete the pass self-disables (one-shot historical
  // fill); steady-state rows arrive already-stamped via the forward path.
  let backfillDone = false;
  function runMutationPathBackfillPass(): void {
    if (shuttingDown || backfillDone) return;
    let scanned = 0;
    try {
      const result = backfillMutationPath(db);
      scanned = result.scanned;
      if (scanned > 0) {
        console.error(
          `[keeperd] mutation_path backfill: filled ${scanned} row(s) in ${result.batches} batch(es) (watermark id<=${result.watermark}${result.moreLikely ? ", more remain" : ""})`,
        );
      }
      // Self-disable once the historical tail is provably exhausted — the
      // completion gate counts ONLY rows whose body still yields an unstamped
      // file_path, so a legitimately-NULL row (malformed / no file_path) never
      // keeps it running. After this the forward path keeps new rows stamped.
      if (isMutationPathBackfillComplete(db)) {
        backfillDone = true;
        clearInterval(mutationPathBackfillTimer);
        if (scanned > 0) {
          console.error(
            "[keeperd] mutation_path backfill: complete — git-attribution column fully populated, pass disabled",
          );
        }
      }
    } catch (err) {
      // A backfill failure is pure catch-up loss, never a correctness issue (the
      // column stays NULL on a rolled-back batch and the next pass retries; the
      // git-attribution flip is gated on the completion predicate, not on this
      // pass succeeding). Log non-fatally.
      console.error(
        `[keeperd] mutation_path backfill pass threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    // Reclaim WAL space OUTSIDE the per-batch transactions, only when a pass
    // moved bytes — same PASSIVE-never-TRUNCATE rule as compaction.
    if (scanned > 0) {
      try {
        db.run("PRAGMA wal_checkpoint(PASSIVE)");
      } catch (err) {
        console.error(
          `[keeperd] mutation_path backfill PASSIVE checkpoint threw (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  // Schedule the backfill on its own slack heartbeat. Stored so shutdown can
  // `clearInterval` it (and so the self-disable on completion can clear it).
  // Fires on the MAIN THREAD against the writable connection.
  const mutationPathBackfillTimer = setInterval(() => {
    runMutationPathBackfillPass();
  }, MUTATION_PATH_BACKFILL_INTERVAL_MS);

  // Steady-state WAL checkpoint cadence, independent of retention (whose PASSIVE
  // checkpoint only fires when it shed bytes). Flushes the WAL back into the
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

  // The restore-snapshot worker — its own read-only connection, polls
  // `data_version`, and rewrites `~/.local/state/keeper/restore.json` (a derived
  // side-file, NOT a projection) only when the content hash differs. Write
  // failures are swallowed to stderr; only an unhandled throw escalates to
  // fatalExit. Riding the same pulse (plus a ~1s idle wake), it runs ONE cheap
  // `display-message -p '#{pid}:#{start_time}'` generation probe and posts
  // `{kind:"backend-exec-start"}` (its ONLY worker→main channel) — `rw.onmessage`
  // mints the `BackendExecStart` synthetic event below. The whole-server topology
  // is produced by the control-worker (epic fn-968), not here.
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
    // Worker → main: the restore-worker's ONLY worker→main channel is the
    // `backend-exec-start` generation boundary. Main is the SOLE synthetic-event
    // writer — mint ONE `BackendExecStart` row carrying the payload in `data`,
    // folded via an explicit reducer NO-OP arm (the boundary lives in the
    // event-log `id` order, not a projection column). The whole-server topology
    // channel moved to the control-worker (epic fn-968), and the pane-fill /
    // window-index channels retired with it. The restore-file write path stays a
    // pure consumer (no message). The worker dedups, so a post here always
    // carries a changed payload.
    rw.onmessage = (
      ev: MessageEvent<BackendExecStartMessage | undefined>,
    ): void => {
      const msg = ev.data;
      if (!msg) return;
      if (msg.kind !== "backend-exec-start") return;
      // Stable synthetic `session_id` — `events.session_id` is NOT NULL, and the
      // no-op fold keys on nothing, so a constant satisfies the constraint and
      // keeps re-fold deterministic.
      const hookEvent = "BackendExecStart";
      const eventType = "backend_exec_start";
      const sessionId = "backend-exec-start";
      const data = JSON.stringify({
        backend_type: msg.backend_type,
        generation_id: msg.generation_id,
      });
      stmts.insertEvent.run({
        $ts: Date.now() / 1000,
        $session_id: sessionId,
        $pid: null,
        $hook_event: hookEvent,
        $event_type: eventType,
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
        $plan_op: null,
        $plan_target: null,
        $plan_epic_id: null,
        $plan_task_id: null,
        $plan_subject_present: null,
        $config_dir: null,
        $bash_mutation_kind: null,
        $bash_mutation_targets: null,
        $plan_files: null,
        $backend_exec_type: null,
        $backend_exec_session_id: null,
        $backend_exec_pane_id: null,
        $worktree: null,
      });
      wakePending = true;
      pumpWakes();
    };

    rw.onerror = (err: ErrorEvent): void => {
      console.error("[keeperd] restore worker error:", err.message ?? err);
      if (!shuttingDown) fatalExit();
    };

    rw.addEventListener("close", () => {
      if (!shuttingDown) fatalExit();
    });
  }

  // Gated on the selector — `null` when unselected.
  const renamerWorker = want("renamer")
    ? new Worker(new URL("./renamer-worker.ts", import.meta.url).href, {
        workerData: { dbPath } satisfies RenamerWorkerData,
      } as WorkerOptions & { workerData: unknown })
    : null;

  if (renamerWorker) {
    const nw = renamerWorker;
    // NO onmessage handler: the renamer is a pure external actuator (reads the
    // jobs projection read-only, writes ONLY to tmux via rename-window). It
    // never posts to main and never writes the DB — only the lifecycle
    // onerror + close guards escalate to the single recovery path.
    nw.onerror = (err: ErrorEvent): void => {
      console.error("[keeperd] renamer worker error:", err.message ?? err);
      if (!shuttingDown) fatalExit();
    };

    nw.addEventListener("close", () => {
      if (!shuttingDown) fatalExit();
    });
  }

  // Gated on the selector — `null` when unselected. The autoclose worker
  // is a pure external actuator cloned from the renamer — reads the
  // jobs projection READ-ONLY, self-gates on `autoclose_enabled` every pulse, and
  // writes ONLY to tmux (`kill-window`), NEVER keeper.db. ALWAYS spawned (a
  // runtime enable/disable flip needs no restart); NOT a WATCHER_WORKER (dlopens
  // no parcel watcher). Unlike the renamer it DOES post to main — the pre-kill
  // intent hint — which `autocloseHints` records so the exit-watcher's sole
  // Killed mint labels the row 'autoclosed'.
  const autocloseWorker = want("autoclose")
    ? new Worker(new URL("./autoclose-worker.ts", import.meta.url).href, {
        workerData: { dbPath } satisfies AutocloseWorkerData,
      } as WorkerOptions & { workerData: unknown })
    : null;

  if (autocloseWorker) {
    const aw = autocloseWorker;
    aw.onmessage = (
      ev: MessageEvent<AutocloseIntentMessage | undefined>,
    ): void => {
      const msg = ev.data;
      if (!msg || msg.kind !== "autoclose-intent") return;
      // Record the pre-kill hint keyed by jobId; the exit-watcher's SOLE Killed
      // mint consumes it (identity-checked, once) to stamp 'autoclosed'.
      autocloseHints.post(msg.jobId, msg.pid, msg.startTime);
    };
    aw.onerror = (err: ErrorEvent): void => {
      console.error("[keeperd] autoclose worker error:", err.message ?? err);
      if (!shuttingDown) fatalExit();
    };

    aw.addEventListener("close", () => {
      if (!shuttingDown) fatalExit();
    });
  }

  // Gated on the selector — `null` when unselected. The Agent Bus relay
  // (epic fn-875): opens keeper.db READ-ONLY for jobs identity reads and owns
  // its OWN writable bus.db + dedicated bus.sock (paths default to
  // `resolveBusDbPath()`/`resolveBusSockPath()` worker-side, honoring
  // KEEPER_BUS_DB / KEEPER_BUS_SOCK). NOT a WATCHER_WORKER — socket-driven, no
  // parcel watcher.
  const busWorker = want("bus")
    ? new Worker(new URL("./bus-worker.ts", import.meta.url).href, {
        workerData: { dbPath } satisfies BusWorkerData,
      } as WorkerOptions & { workerData: unknown })
    : null;

  if (busWorker) {
    const bw = busWorker;
    // NO onmessage handler: the bus is a pure relay actuator — it reads keeper's
    // jobs projection READ-ONLY and writes ONLY its own bus.db, never keeper.db,
    // and posts NOTHING to main. Only the lifecycle onerror + close guards
    // escalate to the single recovery path (a bus boot failure bounces the
    // daemon; the documented fallback is the sibling --bus-only LaunchAgent).
    bw.onerror = (err: ErrorEvent): void => {
      console.error("[keeperd] bus worker error:", err.message ?? err);
      if (!shuttingDown) fatalExit();
    };

    bw.addEventListener("close", () => {
      if (!shuttingDown) fatalExit();
    });
  }

  // fn-952 — the persistent `tmux -C` control-focus worker. Gated on the selector
  // AND `!disableNativeWatcher`: it attaches a REAL tmux control client, so the
  // in-process test tier (always `disableNativeWatcher:true`) must never spawn it.
  // Posts `tmux-client-focus-snapshot` (a focus observation) + `tmux-control-
  // liveness` (a supervisor pulse) — main, the SOLE synthetic-event writer, mints
  // ONE `TmuxClientFocusSnapshot` event from the focus post; the liveness pulse is
  // a pure side channel (never folded).
  const tmuxControlWorker =
    want("tmuxControl") && !opts.disableNativeWatcher
      ? new Worker(new URL("./tmux-control-worker.ts", import.meta.url).href, {
          workerData: { dbPath } satisfies TmuxControlWorkerData,
        } as WorkerOptions & { workerData: unknown })
      : null;

  if (tmuxControlWorker) {
    const tw = tmuxControlWorker;
    tw.onmessage = (
      ev: MessageEvent<TmuxControlWorkerMessage | undefined>,
    ): void => {
      const msg = ev.data;
      if (!msg) return;
      if (msg.kind === "tmux-control-liveness") {
        // Supervisor liveness pulse — the watchdog reads the time since this to
        // tell "alive + observing" from "alive but stuck". Pure side channel;
        // never folded.
        lastTmuxControlLivenessAtMs = (msg as TmuxControlLivenessMessage).at_ms;
        return;
      }
      if (msg.kind === "tmux-client-focus-snapshot") {
        // Mint ONE synthetic `TmuxClientFocusSnapshot` event carrying exactly the
        // fold's `{status, generation_id, session_name, window_index, pane_id}`
        // payload in `$data`. Stable synthetic `session_id` (events.session_id is
        // NOT NULL and the live-only fold keys on `id=1`, never `event.session_id`).
        const focus = msg as TmuxClientFocusSnapshotMessage;
        stmts.insertEvent.run({
          $ts: Date.now() / 1000,
          $session_id: "tmux-client-focus-snapshot",
          $pid: null,
          $hook_event: "TmuxClientFocusSnapshot",
          $event_type: "tmux_client_focus_snapshot",
          $tool_name: null,
          $matcher: null,
          $cwd: null,
          $permission_mode: null,
          $agent_id: null,
          $agent_type: null,
          $stop_hook_active: null,
          $data: JSON.stringify({
            status: focus.status,
            generation_id: focus.generation_id,
            session_name: focus.session_name,
            window_index: focus.window_index,
            pane_id: focus.pane_id,
          }),
          $subagent_agent_id: null,
          $spawn_name: null,
          $start_time: null,
          $slash_command: null,
          $skill_name: null,
          $plan_op: null,
          $plan_target: null,
          $plan_epic_id: null,
          $plan_task_id: null,
          $plan_subject_present: null,
          $config_dir: null,
          $bash_mutation_kind: null,
          $bash_mutation_targets: null,
          $plan_files: null,
          $backend_exec_type: null,
          $backend_exec_session_id: null,
          $backend_exec_pane_id: null,
          $worktree: null,
        });
        wakePending = true;
        pumpWakes();
        return;
      }
      if (msg.kind === "tmux-topology-snapshot") {
        // epic fn-968 — the LIVE-LOCATION channel, relocated onto the control
        // worker's existing framed re-read (no new tmux command, no subprocess).
        // Mints ONE `TmuxTopologySnapshot` carrying `{generation_id, panes}` —
        // BYTE-IDENTICAL to the restore-worker poll's payload, so the live-only
        // fold (gated above `tmux_projection_state.floor`, recycle-guarded on
        // `(generation_id, pane_id)`) OVERWRITES each tmux job's live session +
        // `window_index` exactly as before. Stable synthetic `session_id` per
        // kind (events.session_id is NOT NULL; the fold keys on the payload).
        const topo = msg as TmuxTopologySnapshotMessage;
        stmts.insertEvent.run({
          $ts: Date.now() / 1000,
          $session_id: "tmux-topology-snapshot",
          $pid: null,
          $hook_event: "TmuxTopologySnapshot",
          $event_type: "tmux_topology_snapshot",
          $tool_name: null,
          $matcher: null,
          $cwd: null,
          $permission_mode: null,
          $agent_id: null,
          $agent_type: null,
          $stop_hook_active: null,
          $data: JSON.stringify({
            generation_id: topo.generation_id,
            panes: topo.panes,
          }),
          $subagent_agent_id: null,
          $spawn_name: null,
          $start_time: null,
          $slash_command: null,
          $skill_name: null,
          $plan_op: null,
          $plan_target: null,
          $plan_epic_id: null,
          $plan_task_id: null,
          $plan_subject_present: null,
          $config_dir: null,
          $bash_mutation_kind: null,
          $bash_mutation_targets: null,
          $plan_files: null,
          $backend_exec_type: null,
          $backend_exec_session_id: null,
          $backend_exec_pane_id: null,
          $worktree: null,
        });
        wakePending = true;
        pumpWakes();
      }
    };

    tw.onerror = (err: ErrorEvent): void => {
      console.error("[keeperd] tmux-control worker error:", err.message ?? err);
      if (!shuttingDown) fatalExit();
    };

    tw.addEventListener("close", () => {
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

  // fn-921 seed-liveness watchdog. The git-worker is poll-only now, so a mute
  // FSEvents stream can no longer freeze it — but a worker that is alive-but-stuck
  // (a hung poll tick) OR a `seed_required` that a quiet repo never clears is still
  // a wedge `onerror`/`close` supervision can't see. This timer reads the verdict
  // (see {@link decideGitSeedWatchdog}) and recovers: re-run the boot-seed on MAIN
  // FIRST (re-arm, capped), `fatalExit → LaunchAgent restart` only as a last
  // resort. Gated on `want("git")` (no git surface otherwise) and disabled in the
  // in-process tier (`disableNativeWatcher` — the worker arms no producer there).
  if (gitWorker && want("git") && !opts.disableNativeWatcher) {
    // Stamp the staleness baseline at arm time (boot-seed has just run), so the
    // stuck-timer measures from a fresh anchor rather than the early declaration.
    lastGitProgressAtMs = Date.now();
    gitSeedWatchdogTimer = setInterval(() => {
      if (shuttingDown) return;
      let seedRequired: boolean;
      try {
        seedRequired = readGitProjectionSeedRequired(db);
      } catch {
        return; // a transient read failure is not a wedge signal
      }
      const verdict = decideGitSeedWatchdog({
        seedRequired,
        lastProgressAtMs: lastGitProgressAtMs,
        lastLivenessAtMs: lastGitLivenessAtMs,
        nowMs: Date.now(),
        stuckThresholdMs: GIT_SEED_STUCK_THRESHOLD_MS,
        livenessThresholdMs: GIT_LIVENESS_STUCK_THRESHOLD_MS,
        reseedAttempts: gitSeedReseedAttempts,
        maxReseedAttempts: GIT_SEED_MAX_RESEED_ATTEMPTS,
      });
      if (verdict === "ok") return;
      if (verdict === "reseed") {
        gitSeedReseedAttempts++;
        console.error(
          `[keeperd] git seed-liveness watchdog: seed_required stuck — re-running boot-seed (attempt ${gitSeedReseedAttempts}/${GIT_SEED_MAX_RESEED_ATTEMPTS})`,
        );
        try {
          // Re-arm on MAIN, exactly like boot: re-derive the surface for
          // currently-dirty/gated roots and clear the flag once every gated root
          // has an above-floor row. The reducer self-clear + the worker's own
          // force-emit may ALSO clear it; this is the supervisor-side belt. A
          // reset baseline (lastGitSnapshotAtMs) lets the next tick re-measure
          // staleness from the re-seed, not from the original wedge.
          seedGitProjection(db, stmts, {
            drainToCompletion: (handle) =>
              drainToCompletion(handle, DEFAULT_BATCH_SIZE, bootPace),
          });
          lastGitProgressAtMs = Date.now();
        } catch (err) {
          console.error(
            `[keeperd] git seed-liveness watchdog re-seed failed: ${String(err)}`,
          );
        }
        return;
      }
      // "escalate" — the re-seed budget is spent (or the worker is mute). A fresh
      // process re-seeds HEAD correctly; this is the single recovery path.
      console.error(
        "[keeperd] git seed-liveness watchdog: surface stuck after " +
          `${gitSeedReseedAttempts} re-seed attempt(s) (or worker mute) — exiting for LaunchAgent restart`,
      );
      if (!shuttingDown) fatalExit();
    }, GIT_SEED_WATCHDOG_INTERVAL_MS);
  }

  // fn-952 tmux-control liveness watchdog. The control worker pulses on a steady
  // cadence (even during long idle), so a SILENTLY-HUNG client (alive but its
  // reader / re-read wedged) is invisible to the crash-only onerror/close guards.
  // This timer reads the verdict ({@link decideTmuxControlWatchdog}) and escalates
  // to a process restart on a mute worker — no in-process respawn. Gated on the
  // worker actually being spawned (selector + `!disableNativeWatcher`).
  if (tmuxControlWorker) {
    tmuxControlWatchdogTimer = setInterval(() => {
      if (shuttingDown) return;
      const verdict = decideTmuxControlWatchdog({
        lastLivenessAtMs: lastTmuxControlLivenessAtMs,
        nowMs: Date.now(),
        livenessThresholdMs: TMUX_CONTROL_LIVENESS_STUCK_THRESHOLD_MS,
      });
      if (verdict === "escalate") {
        console.error(
          "[keeperd] tmux-control liveness watchdog: control client mute — " +
            "exiting for LaunchAgent restart",
        );
        if (!shuttingDown) fatalExit();
      }
    }, TMUX_CONTROL_WATCHDOG_INTERVAL_MS);
  }

  // fn-1082 serve-liveness watchdog. The UDS serve layer has twice gone dark while
  // every worker thread stayed healthy — status reads and bus registry reads timed
  // out (while sends still delivered), a wedge the crash-only `onerror`/`close`
  // guards never see. This timer runs a REAL bounded-timeout read on each served
  // socket from MAIN (each socket is served by a DISTINCT worker thread, so a
  // self-probe from main is sound: a wedged serve loop cannot answer main's read)
  // plus a main-loop lag histogram, feeds them to the verdict
  // ({@link decideServeLivenessWatchdog}), and escalates a detected wedge straight
  // to `fatalExit` (LaunchAgent restart — the sole recovery path; never a respawn).
  // Gated on actually serving a socket + out of the in-process tier.
  if ((serverWorker || busWorker) && !opts.disableNativeWatcher) {
    const busSockPath = resolveBusSockPath();
    // Re-stamp the probe baselines at ARM time (the sockets are bound now), so the
    // stuck-age measures from a fresh anchor, not the early declaration — a long
    // boot drain must not read as instant staleness. Mirrors the git seed
    // watchdog's arm-time baseline. Combined with the boot grace below, the first
    // post-grace tick still measures well under the stuck window even if the
    // opening probe missed.
    lastServerProbeOkAtMs = Date.now();
    lastBusProbeOkAtMs = Date.now();
    const bootGraceUntilMs = Date.now() + SERVE_WATCHDOG_BOOT_GRACE_MS;
    serveLagHistogram = monitorEventLoopDelay({ resolution: 20 });
    serveLagHistogram.enable();
    const lagHistogram = serveLagHistogram;
    serveLivenessWatchdogTimer = setInterval(() => {
      if (shuttingDown) return;
      // Main-loop lag for this interval (ns → ms), then reset the window.
      const lagP99Ms = lagHistogram.percentile(99) / 1e6;
      lagHistogram.reset();
      serveLagConsecutiveBreaches =
        lagP99Ms >= SERVE_LAG_P99_THRESHOLD_MS
          ? serveLagConsecutiveBreaches + 1
          : 0;

      // Fire a real read on each served socket; stamp on success. A wedged read
      // never resolves `true` inside its timeout, so the age grows across ticks.
      // The probes are asynchronous — this tick's verdict reads the PRIOR tick's
      // result (the timeout << interval, so the latest probe has always settled).
      if (serverWorker) {
        const id = crypto.randomUUID();
        void probeSocketRead(
          sockPath,
          { type: "query", id, collection: "autopilot_state", limit: 0 },
          (f) => f.id === id,
          SERVE_PROBE_TIMEOUT_MS,
        ).then((ok) => {
          if (ok) lastServerProbeOkAtMs = Date.now();
        });
      }
      if (busWorker) {
        void probeSocketRead(
          busSockPath,
          { op: "list" },
          (f) => f.type === "ack" && f.op === "list",
          SERVE_PROBE_TIMEOUT_MS,
        ).then((ok) => {
          if (ok) lastBusProbeOkAtMs = Date.now();
        });
      }

      const verdictNowMs = Date.now();
      const verdict = decideServeLivenessWatchdog({
        nowMs: verdictNowMs,
        bootGraceUntilMs,
        // A socket we do not serve never trips: keep its age perpetually fresh.
        lastServerProbeOkAtMs: serverWorker
          ? lastServerProbeOkAtMs
          : verdictNowMs,
        lastBusProbeOkAtMs: busWorker ? lastBusProbeOkAtMs : verdictNowMs,
        probeStuckThresholdMs: SERVE_PROBE_STUCK_THRESHOLD_MS,
        consecutiveLagBreaches: serveLagConsecutiveBreaches,
        maxConsecutiveLagBreaches: SERVE_LAG_MAX_CONSECUTIVE_BREACHES,
      });
      if (verdict.kind === "escalate") {
        // Name the wedge mode + carry both probe ages and the lag-breach count so
        // the crash-loop's cause is legible in server.stderr, not a bare "wedged".
        const serverAgeMs = serverWorker
          ? verdictNowMs - lastServerProbeOkAtMs
          : null;
        const busAgeMs = busWorker ? verdictNowMs - lastBusProbeOkAtMs : null;
        console.error(
          `[keeperd] serve-liveness watchdog: ${verdict.trigger} — server-probe-age=${
            serverAgeMs ?? "n/a"
          }ms bus-probe-age=${busAgeMs ?? "n/a"}ms lag-breaches=${serveLagConsecutiveBreaches}/${SERVE_LAG_MAX_CONSECUTIVE_BREACHES} — exiting for LaunchAgent restart`,
        );
        if (!shuttingDown) fatalExit();
      }
    }, SERVE_WATCHDOG_INTERVAL_MS);
  }

  // Spawn the Baseline runner PRODUCER worker (docs/adr/0005). It consumes the
  // CLI-written request spool, computes the fast-gate suite result once per key in
  // a detached scratch worktree, and is the SOLE writer of the per-key result
  // leafs — a pure on-disk producer, so like the usage-scraper it posts NO message
  // to main (no synthetic event, no keeper.db write). It boot-prunes orphaned
  // scratch worktrees itself.
  const baselineWorker = want("baseline")
    ? new Worker(new URL("./baseline-worker.ts", import.meta.url).href, {
        workerData: {} satisfies BaselineWorkerData,
      } as WorkerOptions & { workerData: unknown })
    : null;

  if (baselineWorker) {
    const blw = baselineWorker;
    // Same crash policy as every other worker: any thread failure → fatalExit →
    // LaunchAgent restart (never an in-process respawn).
    blw.onerror = (err: ErrorEvent): void => {
      console.error("[keeperd] baseline worker error:", err.message ?? err);
      if (!shuttingDown) fatalExit();
    };
    // A worker `process.exit(1)` fires `close`, not `onerror`. `!shuttingDown`
    // makes it inert on clean shutdown.
    blw.addEventListener("close", () => {
      if (!shuttingDown) fatalExit();
    });
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
    if (blockEscalationSweepTimer !== null) {
      clearInterval(blockEscalationSweepTimer);
    }
    if (blockHumanNotifySweepTimer !== null) {
      clearInterval(blockHumanNotifySweepTimer);
    }
    if (repairEscalationSweepTimer !== null) {
      clearInterval(repairEscalationSweepTimer);
    }
    if (mergeEscalationSweepTimer !== null) {
      clearInterval(mergeEscalationSweepTimer);
    }
    if (deconflictHumanNotifySweepTimer !== null) {
      clearInterval(deconflictHumanNotifySweepTimer);
    }
    if (resolverDispatchSweepTimer !== null) {
      clearInterval(resolverDispatchSweepTimer);
    }
    if (codexResumeSweepTimer !== null) {
      clearInterval(codexResumeSweepTimer);
    }
    clearInterval(eventsIngestFallbackTimer);
    clearInterval(retentionTimer);
    clearInterval(mutationPathBackfillTimer);
    clearInterval(walCheckpointTimer);
    if (gitSeedWatchdogTimer != null) clearInterval(gitSeedWatchdogTimer);
    if (tmuxControlWatchdogTimer != null)
      clearInterval(tmuxControlWatchdogTimer);
    if (serveLivenessWatchdogTimer != null)
      clearInterval(serveLivenessWatchdogTimer);
    // Release the event-loop-delay monitor so it stops pinning a libuv handle.
    try {
      serveLagHistogram?.disable();
    } catch {
      // best-effort — we're tearing down either way
    }

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
      statuslineWorker,
      buildsWorker,
      usageScraperWorker,
      deadLetterWorker,
      eventsIngestWorker,
      birthIngestWorker,
      autopilotWorkerInstance,
      handoffWorkerInstance,
      maintenanceWorker,
      restoreWorker,
      renamerWorker,
      autocloseWorker,
      busWorker,
      tmuxControlWorker,
      baselineWorker,
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

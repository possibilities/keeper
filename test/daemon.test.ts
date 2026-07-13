/**
 * Daemon boot-drain test. Verifies the catch-up path independent of the wake
 * mechanism: pre-seed the `events` table, then drive `drainToCompletion`
 * directly against a tmp DB (no Worker spawned — `daemon.ts` is import-safe
 * behind its `import.meta.main` guard). The full wake-worker → reducer
 * round-trip is covered by the end-to-end integration test.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectAutopilotPaused } from "../cli/autopilot";
import {
  appendBackstopRecord,
  BackstopCounters,
} from "../src/backstop-telemetry";
import type {
  GreenResult,
  InfraErrorResult,
  SuiteRedResult,
  TimeoutResult,
  ToolchainFingerprint,
} from "../src/baseline-store";
import {
  ALL_WORKERS,
  AUDIT_READY_ORCHESTRATOR_GRACE_MS,
  AUTOCLOSE_HINT_TTL_MS,
  type AuditOrchestratorLiveness,
  AutocloseHintSet,
  appendRestartLedgerLine,
  auditReadyEscalationDecision,
  BLOCK_ESCALATION_SKIP_CATEGORY,
  BLOCK_ESCALATION_SWEEP_INTERVAL_MS,
  type BlockCandidateDropClass,
  type BlockEscalationOutcome,
  type BlockEscalationSweepDeps,
  type BlockHumanNotifiedOutcome,
  type BlockHumanNotifySweepDeps,
  BOOT_DRAIN_PACE_EVENTS,
  BOOT_DRAIN_PACE_MS,
  baselineRedIsConfirmed,
  baselineRepairFingerprint,
  buildBaselineRepairCandidates,
  buildBlockHumanNotifyBody,
  buildDeconflictHumanNotifyBody,
  buildPendingDispatchSweepRecords,
  buildResolverBrief,
  buildSharedCheckoutPageBody,
  buildSharedDirtyObservation,
  buildWorkMergeHumanNotifyBody,
  buildWorkResolverBrief,
  CRASH_LOOP_THRESHOLD,
  CRASH_LOOP_WINDOW_MS,
  CRASH_LOOP_YOUNG_RUNTIME_MS,
  checkKeeperAgentPresence,
  classifyBaselineForRepair,
  classifyEscalationOutcome,
  classifyRestartProvenance,
  classifyWorkResolverOutcome,
  collapseRestartLedger,
  compactRestartLedger,
  countLiveEscalationSessions,
  type DaemonHandle,
  DEAD_LETTER_RETENTION_MS,
  type DeconflictHumanNotifySweepDeps,
  DISPATCH_MINT_GATE_EVICT_MS,
  DISPATCH_MINT_GATE_WINDOW_MS,
  decideCrashLoop,
  decideGitSeedWatchdog,
  decideServeLivenessWatchdog,
  dispatchEscalationSession,
  drainToCompletion,
  type EscalationDispatchDeps,
  type EscalationDispatchOutcome,
  effectiveBlockEscalationRepo,
  epicHasLiveUnblock,
  escalationCheckoutOccupiedBy,
  escalationSessionLiveFor,
  foldBootIntoRestartLedger,
  GIT_SEED_MAX_RESEED_ATTEMPTS,
  GIT_SEED_STUCK_THRESHOLD_MS,
  gcUnretryableDispatchFailures,
  isTransientBusyError,
  KEEPERD_LAUNCHD_LABEL,
  MAX_LIVE_ESCALATION_SESSIONS,
  MERGE_ESCALATION_REASON_TOKEN,
  type MergeEscalationOutcome,
  type MergeEscalationSweepDeps,
  type MergeHumanNotifiedOutcome,
  mergeConflictBaseCheckout,
  PENDING_DISPATCH_SWEEP_INTERVAL_MS,
  PENDING_DISPATCH_TTL_MS,
  type PendingBlockEscalation,
  type PendingBlockHumanNotify,
  type PendingMergeEscalation,
  type PendingRepairRow,
  type PendingResolverDispatch,
  type PendingWorkMergeConflict,
  PROBE_LIFE_ADMISSION_CODES,
  PROBE_SETTLE_INITIAL,
  type ProbeSettleEvent,
  type ProbeSettleState,
  type ProbeTickOutcome,
  parseBlockedCategory,
  parseRestartLedger,
  parseRestartLedgerLine,
  prewarmWatcherAddon,
  probeAuditOrchestrator,
  probeReplyProvesLife,
  probeSettleStep,
  pruneRecoveredDeadLetters,
  qualifyCrashLoopBootTimestamps,
  RESTART_LEDGER_CAP,
  RESTART_LEDGER_REASON_MAX_LEN,
  type RepairCandidate,
  type RepairCandidateDropClass,
  type RepairEscalationSweepDeps,
  type RepairGroup,
  type RepairHumanNotifiedOutcome,
  type ResolverDispatchOutcome,
  type ResolverDispatchResult,
  type ResolverDispatchSweepDeps,
  type RestartBoot,
  type RestartBootLine,
  type RestartLedgerLine,
  type RestartProvenance,
  readRestartLedger,
  readTaskBlockedReason,
  recoverOneDeadLetter,
  repairCheckoutDirty,
  repairReasonFor,
  repairTipBaselineGreen,
  resolveEscalationJobsFor,
  resolveProbeArming,
  routeBlockedCategory,
  runBlockEscalationSweep,
  runBlockHumanNotifySweep,
  runDeconflictHumanNotifySweep,
  runMergeEscalationSweep,
  runRepairEscalationSweep,
  runResolverDispatchSweep,
  runSharedCheckoutPageSweep,
  runWorkMergeHumanNotifySweep,
  SERVE_CLOCK_JUMP_FACTOR,
  SERVE_LAG_MAX_CONSECUTIVE_BREACHES,
  SERVE_PROBE_MAX_FAIL_STREAK,
  SERVE_REPORT_MUTE_THRESHOLD_MS,
  SERVE_STARVATION_MAX_BREACH_STREAK,
  SERVE_WATCHDOG_BOOT_GRACE_MS,
  SERVE_WATCHDOG_INITIAL_STATE,
  SERVE_WATCHDOG_INTERVAL_MS,
  type ServeWatchdogTriggerState,
  SHARED_BASE_BROKEN_CATEGORY,
  type SharedCheckoutNotifiedOutcome,
  type SharedCheckoutPageRow,
  type SharedCheckoutPageSweepDeps,
  scanDeadLetterDir,
  selectExpiredPendingDispatches,
  selectPendingBlockEscalations,
  selectPendingBlockHumanNotifications,
  selectPendingHumanNotifications,
  selectPendingMergeEscalations,
  selectPendingResolverDispatches,
  selectPendingWorkMergeEscalations,
  selectPendingWorkMergeNotifications,
  selectPendingWorkResolverDispatches,
  selectRepairCandidates,
  serializeRestartLedgerLine,
  serializeSessionTelemetry,
  shouldEscalateBlockedCategory,
  shouldEscalateMergeConflict,
  startDaemon,
  WAL_AUTOCHECKPOINT_PAGES,
  WORK_RESOLVER_LEASE_SEC,
  type WorkerName,
  type WorkMergeHumanNotifySweepDeps,
  withBootDrainCheckpointTuning,
  workLaneBusyForResolver,
  writeRestartLedger,
} from "../src/daemon";
import {
  clearDispatchMintGate,
  EPHEMERAL_PROJECTIONS,
  evictStaleDispatchMintGate,
  openDb,
  readDispatchMintGate,
  runDispatchMintGate,
  SCHEMA_VERSION,
  upsertDispatchMintGate,
} from "../src/db";
import { serializeDeadLetterRecord } from "../src/dead-letter";
import {
  CRASH_LOOP_DISTRESS_ID,
  CRASH_LOOP_DISTRESS_REASON,
  CRASH_LOOP_DISTRESS_VERB,
  LANE_WEDGE_DISTRESS_ID_PREFIX,
  SHARED_DESYNC_DISTRESS_ID_PREFIX,
  SHARED_DESYNC_DISTRESS_VERB,
  SHARED_DIRTY_DISTRESS_ID_PREFIX,
  SHARED_WEDGE_DISTRESS_ID_PREFIX,
  SHARED_WEDGE_DISTRESS_VERB,
} from "../src/dispatch-failure-key";
import { MAX_LINE_LENGTH } from "../src/protocol";
import type { ResolverOutcome } from "../src/reconcile-core";
import { classifyResolverOutcome } from "../src/reconcile-core";
import {
  drain,
  extractSessionTelemetry,
  GIT_STATUS_DIRTY_FILES_WIRE_CAP,
} from "../src/reducer";
import { seedKilledSweep } from "../src/seed-sweep";
import {
  type CensusConnView,
  censusConns,
  type FanoutCursor,
  isDaemonSelfConn,
  isPidAlive,
  MAX_SUBS_PER_TICK,
  newFanoutCursor,
  runQuery,
  sliceFanout,
} from "../src/server-worker";
import type { Event, Job } from "../src/types";
import { repoToken, worktreePathFor } from "../src/worktree-plan";
import { sandboxEnv } from "./helpers/sandbox-env";
import { freshDbFile, freshMemDb } from "./helpers/template-db";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-daemon-test-"));
  dbPath = join(tmpDir, "keeper.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedEvent(
  db: ReturnType<typeof openDb>["db"],
  sessionId: string,
  hookEvent: string,
  ts: number,
  permissionMode: string | null = null,
): void {
  db.run(
    `INSERT INTO events (ts, session_id, pid, hook_event, event_type, permission_mode, data)
       VALUES (?, ?, ?, ?, 'lifecycle', ?, '{}')`,
    [ts, sessionId, 4242, hookEvent, permissionMode],
  );
}

test("boot drain folds a pre-seeded events table to completion", () => {
  const { db } = freshMemDb();

  // Pre-seed a full session lifecycle as if events accumulated during downtime.
  seedEvent(db, "sess-a", "SessionStart", 1);
  seedEvent(db, "sess-a", "UserPromptSubmit", 2, "plan");
  seedEvent(db, "sess-a", "Stop", 3);
  seedEvent(db, "sess-b", "SessionStart", 4);
  seedEvent(db, "sess-b", "SessionEnd", 5);

  // Cursor starts at 0 (fresh DB) — nothing folded yet.
  const before = db
    .query("SELECT last_event_id FROM reducer_state WHERE id = 1")
    .get() as { last_event_id: number };
  expect(before.last_event_id).toBe(0);

  drainToCompletion(db);

  // Cursor advanced past every seeded event.
  const after = db
    .query("SELECT last_event_id FROM reducer_state WHERE id = 1")
    .get() as { last_event_id: number };
  expect(after.last_event_id).toBe(5);

  // Projection reflects the folded lifecycle.
  const jobA = db
    .query("SELECT state FROM jobs WHERE job_id = 'sess-a'")
    .get() as { state: string };
  expect(jobA.state).toBe("stopped");

  const jobB = db
    .query("SELECT state FROM jobs WHERE job_id = 'sess-b'")
    .get() as { state: string };
  expect(jobB.state).toBe("ended");

  db.close();
});

test("git first-frame: a worktree with thousands of dirty files serves a git snapshot frame under the NDJSON line cap, dirty_count stays exact", () => {
  const { db } = freshMemDb();

  // A single plan-backed worktree with a pathological dirty-file count — the
  // observed board-stall trigger. Rendered whole, one worktree's `dirty_files[]`
  // array serializes past 1 MiB on its own; the board's subscribe first-frame
  // ships the `git` result as ONE NDJSON line, so an over-`MAX_LINE_LENGTH` frame
  // is REJECTED by the viewer's parser — it reconnect-loops and no first frame
  // ever lands (a snapshot timeout even past the default window).
  const N = 6000;
  const projectDir = "/repo/worktree";
  const dirtyFiles = Array.from({ length: N }, (_, i) => ({
    // Long, realistically-nested paths so the UNCAPPED array clears 1 MiB.
    path: `src/${"deeply/nested/".repeat(8)}module_${i}/component.ts`,
    xy: " M",
    mtime_ms: null,
  }));
  db.run(
    `INSERT INTO events (ts, session_id, pid, hook_event, event_type, cwd, data)
       VALUES (?, ?, ?, 'GitSnapshot', 'git_snapshot', ?, ?)`,
    [
      5000,
      projectDir,
      null,
      projectDir,
      JSON.stringify({
        project_dir: projectDir,
        branch: "main",
        head_oid: "abc123",
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        dirty_files: dirtyFiles,
      }),
    ],
  );

  drainToCompletion(db);

  const row = db
    .query(
      "SELECT dirty_count, orphaned_count, unattributed_to_live_count, dirty_files FROM git_status WHERE project_dir = ?",
    )
    .get(projectDir) as {
    dirty_count: number;
    orphaned_count: number;
    unattributed_to_live_count: number;
    dirty_files: string;
  };

  // The scalar the board actually renders stays EXACT — the full dirty count.
  expect(row.dirty_count).toBe(N);
  // None of the N fixture files carry a file_attributions row, so all are
  // orphans — this exercises pass 4's rollup-from-the-FULL-snapshot invariant
  // (not the capped `dirty_files[]` mirror below).
  expect(row.orphaned_count).toBe(N);
  // The unattributed-to-live scalar is exact too — an orphan (zero
  // attributions) always counts toward it.
  expect(row.unattributed_to_live_count).toBe(N);
  // The materialized mirror is bounded, so no single row can blow the frame.
  const storedFiles = JSON.parse(row.dirty_files) as unknown[];
  expect(storedFiles.length).toBe(GIT_STATUS_DIRTY_FILES_WIRE_CAP);

  // The served first-frame — one NDJSON line — stays under the cap the viewer
  // enforces, so it is actually deliverable. Without the fold cap the row would
  // carry all N entries and this line would blow past MAX_LINE_LENGTH.
  const worldRev = (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;
  const frame = runQuery(db, worldRev, {
    type: "query",
    collection: "git",
    limit: 0,
  });
  expect(frame.type).toBe("result");
  expect(JSON.stringify(frame).length).toBeLessThan(MAX_LINE_LENGTH);

  // Guard the guard: the cap is load-bearing — N unbounded entries at this
  // per-entry size WOULD exceed the line cap (a lower bound on the uncapped frame).
  const perEntryBytes = JSON.stringify(storedFiles[0]).length;
  expect(perEntryBytes * N).toBeGreaterThan(MAX_LINE_LENGTH);

  db.close();
});

test("boot drain is idempotent — a second pass folds nothing", () => {
  const { db } = freshMemDb();
  seedEvent(db, "sess-a", "SessionStart", 1);
  seedEvent(db, "sess-a", "Stop", 2);

  drainToCompletion(db);
  const firstCursor = (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;

  // A second drain over an unchanged events table must fold zero new events.
  expect(drain(db)).toBe(0);
  drainToCompletion(db);
  const secondCursor = (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;

  expect(secondCursor).toBe(firstCursor);
  db.close();
});

test("gcUnretryableDispatchFailures: sweeps only the rows the retry wire path can't clear", () => {
  const { db } = freshMemDb();
  // Two clearable rows (normal keys) and one orphan with a raw-path key the
  // retry_dispatch validator rejects (the pre-slug worktree-recover shape).
  const insert = db.prepare(
    `INSERT INTO dispatch_failures (verb, id, reason, dir, ts, last_event_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 100, ?, 100, 100)`,
  );
  insert.run("close", "fn-1-foo", "some reason", "/repo", 10);
  insert.run("work", "fn-2-bar.3", "some reason", "/repo", 11);
  insert.run(
    "close",
    "worktree-recover:/Users/mike/code/arthack",
    "worktree-recover-abort-failed: …",
    "/Users/mike/code/arthack",
    12,
  );

  const cleared: { verb: string; id: string }[] = [];
  const swept = gcUnretryableDispatchFailures(db, (verb, id) =>
    cleared.push({ verb, id }),
  );

  // Only the raw-path orphan is swept; the two clearable rows are left alone.
  expect(swept).toBe(1);
  expect(cleared).toEqual([
    { verb: "close", id: "worktree-recover:/Users/mike/code/arthack" },
  ]);
  db.close();
});

test("gcUnretryableDispatchFailures: the crash-loop distress row is EXEMPT (self-managed, never orphan-swept)", () => {
  const { db } = freshMemDb();
  // The distress row's synthetic verb is un-retryable by the wire validator BY
  // DESIGN — but main's level-triggered recovery owns it, so the orphan sweep
  // must leave it alone rather than reap the live distress signal.
  db.prepare(
    `INSERT INTO dispatch_failures (verb, id, reason, dir, ts, last_event_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 100, 20, 100, 100)`,
  ).run(
    CRASH_LOOP_DISTRESS_VERB,
    CRASH_LOOP_DISTRESS_ID,
    `${CRASH_LOOP_DISTRESS_REASON}: 8 daemon boots in 30min`,
  );

  const cleared: { verb: string; id: string }[] = [];
  const swept = gcUnretryableDispatchFailures(db, (verb, id) =>
    cleared.push({ verb, id }),
  );

  expect(swept).toBe(0);
  expect(cleared).toEqual([]);
  db.close();
});

test("gcUnretryableDispatchFailures: DRAINS the neutered shared-checkout WEDGE row, EXEMPTS the now-live shared-checkout-DIRTY + lane-wedge + crash-loop + desync rows", () => {
  const { db } = freshMemDb();
  // Post base-merge decouple the shared-checkout mid-merge WEDGE distress is a false
  // positive with no live producer, so the orphan sweep DRAINS any such row left open (it
  // is no longer exempt). Its SIBLING plain-DIRTY row regained a LIVE producer (the
  // repair-escalation sweep), so it is EXEMPT alongside the per-lane fan-in wedge +
  // crash-loop + desync rows — all still-live, self-managed signals a level-trigger owns.
  const insert = db.prepare(
    `INSERT INTO dispatch_failures (verb, id, reason, dir, ts, last_event_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 100, ?, 100, 100)`,
  );
  const wedgeId = `${SHARED_WEDGE_DISTRESS_ID_PREFIX}abc123`;
  const dirtyId = `${SHARED_DIRTY_DISTRESS_ID_PREFIX}abc123`;
  const laneId = `${LANE_WEDGE_DISTRESS_ID_PREFIX}def456`;
  const desyncId = `${SHARED_DESYNC_DISTRESS_ID_PREFIX}abc123`;
  insert.run(
    SHARED_WEDGE_DISTRESS_VERB,
    wedgeId,
    "shared-checkout-wedge: …",
    "/repo",
    30,
  );
  insert.run(
    SHARED_WEDGE_DISTRESS_VERB,
    dirtyId,
    "shared-checkout-dirty: …",
    "/repo",
    31,
  );
  insert.run(
    SHARED_WEDGE_DISTRESS_VERB,
    laneId,
    "worktree-lane-wedge: …",
    "/lane",
    32,
  );
  insert.run(
    CRASH_LOOP_DISTRESS_VERB,
    CRASH_LOOP_DISTRESS_ID,
    `${CRASH_LOOP_DISTRESS_REASON}: 8 daemon boots in 30min`,
    null,
    33,
  );
  insert.run(
    SHARED_DESYNC_DISTRESS_VERB,
    desyncId,
    "shared-checkout-desync: …",
    "/repo",
    34,
  );

  const cleared: { verb: string; id: string }[] = [];
  const swept = gcUnretryableDispatchFailures(db, (verb, id) =>
    cleared.push({ verb, id }),
  );

  // ONLY the mid-merge wedge row is drained; the now-live dirty + lane-wedge + crash-loop
  // + desync rows are left untouched (assert the drained set, order-independent).
  expect(swept).toBe(1);
  expect(cleared.map((c) => c.id)).toEqual([wedgeId]);
  expect(cleared.some((c) => c.id === dirtyId)).toBe(false);
  expect(cleared.some((c) => c.id === laneId)).toBe(false);
  expect(cleared.some((c) => c.id === CRASH_LOOP_DISTRESS_ID)).toBe(false);
  expect(cleared.some((c) => c.id === desyncId)).toBe(false);
  db.close();
});

/**
 * Seed one synthetic `autopilot_state` event (`AutopilotPaused` /
 * `AutopilotCapSet`) carrying a JSON `data` payload — the shape the daemon's
 * boot drain folds into the singleton.
 */
function seedAutopilotEvent(
  db: ReturnType<typeof openDb>["db"],
  hookEvent: "AutopilotPaused" | "AutopilotCapSet",
  ts: number,
  data: Record<string, unknown>,
): void {
  db.run(
    `INSERT INTO events (ts, session_id, pid, hook_event, event_type, data)
       VALUES (?, 'autopilot', NULL, ?, 'autopilot_state', ?)`,
    [ts, hookEvent, JSON.stringify(data)],
  );
}

test("boot-drain seed: a durable AutopilotPaused{paused:false} resumes PLAYING; a fresh board boots PAUSED (the daemon's seed-from-column step)", () => {
  // Leg A — durable `play`: a real `AutopilotPaused{paused:false}` in history,
  // then the daemon's `AutopilotCapSet` boot re-arm (NO forced boot-pause). The
  // CapSet ON CONFLICT branch preserves the durable paused=0. After the drain
  // the daemon reads the singleton via `projectAutopilotPaused` and seeds its
  // in-memory `autopilotPaused` — a non-null `false` means BOOTS PLAYING.
  const playingDb = freshMemDb().db;
  seedAutopilotEvent(playingDb, "AutopilotPaused", 1, { paused: false });
  seedAutopilotEvent(playingDb, "AutopilotCapSet", 2, {
    max_concurrent_jobs: null,
  });
  drainToCompletion(playingDb);
  const playingRows = playingDb
    .query("SELECT paused FROM autopilot_state WHERE id = 1")
    .all() as Record<string, unknown>[];
  // The daemon's exact seed step: `const p = projectAutopilotPaused(rows); if
  // (p !== null) autopilotPaused = p;`. Provenance: a real durable play event.
  const seededPlaying = projectAutopilotPaused(playingRows);
  expect(seededPlaying).toBe(false); // boots PLAYING
  playingDb.close();

  // Leg B — legacy replay: an OLD DB whose only autopilot_state event is a
  // historical `AutopilotCapSet` (no longer produced — the boot-append is gone,
  // but the fold arm is RETAINED for replay). Its INSERT path (`VALUES (1, 1, …)`)
  // materializes a `paused=1` singleton, so the seed resolves to PAUSED. (On a
  // truly fresh board there is NO row at all — that is Leg C below.)
  const freshDb = freshMemDb().db;
  seedAutopilotEvent(freshDb, "AutopilotCapSet", 1, {
    max_concurrent_jobs: null,
  });
  drainToCompletion(freshDb);
  const freshRows = freshDb
    .query("SELECT paused FROM autopilot_state WHERE id = 1")
    .all() as Record<string, unknown>[];
  const seededFresh = projectAutopilotPaused(freshRows);
  expect(seededFresh).toBe(true); // boots PAUSED
  freshDb.close();

  // Leg C — empty singleton: no autopilot events at all. The seed step leaves
  // the in-memory boots-paused default untouched (`null` means "keep default").
  const emptyDb = freshMemDb().db;
  drainToCompletion(emptyDb);
  const emptyRows = emptyDb
    .query("SELECT paused FROM autopilot_state WHERE id = 1")
    .all() as Record<string, unknown>[];
  expect(projectAutopilotPaused(emptyRows)).toBeNull();
  emptyDb.close();
});

test("withBootDrainCheckpointTuning disables autocheckpoint inside the body and restores it after", () => {
  const { db } = freshMemDb();

  // Steady-state default before the wrapper runs.
  const initial = (
    db.query("PRAGMA wal_autocheckpoint").get() as {
      wal_autocheckpoint: number;
    }
  ).wal_autocheckpoint;
  expect(initial).toBe(WAL_AUTOCHECKPOINT_PAGES);

  let insideValue = -1;
  withBootDrainCheckpointTuning(db, () => {
    insideValue = (
      db.query("PRAGMA wal_autocheckpoint").get() as {
        wal_autocheckpoint: number;
      }
    ).wal_autocheckpoint;
  });

  // Auto-checkpoint is OFF during the boot drain so fold commits never absorb a
  // synchronous checkpoint…
  expect(insideValue).toBe(0);
  // …and the steady-state threshold is restored once the drain completes.
  const after = (
    db.query("PRAGMA wal_autocheckpoint").get() as {
      wal_autocheckpoint: number;
    }
  ).wal_autocheckpoint;
  expect(after).toBe(WAL_AUTOCHECKPOINT_PAGES);

  db.close();
});

test("withBootDrainCheckpointTuning restores autocheckpoint even if the body throws", () => {
  const { db } = freshMemDb();

  expect(() =>
    withBootDrainCheckpointTuning(db, () => {
      throw new Error("drain blew up");
    }),
  ).toThrow("drain blew up");

  // The `finally` must re-arm steady-state checkpointing — leaving the
  // long-running writer with autocheckpoint=0 would let the WAL grow unbounded.
  const after = (
    db.query("PRAGMA wal_autocheckpoint").get() as {
      wal_autocheckpoint: number;
    }
  ).wal_autocheckpoint;
  expect(after).toBe(WAL_AUTOCHECKPOINT_PAGES);

  db.close();
});

test("withBootDrainCheckpointTuning still folds the boot backlog to completion", () => {
  // keep-migrate: a real on-disk WAL is required. The trailing
  // `wal_checkpoint(PASSIVE)` assertion (`checkpointed == log`) is only
  // meaningful against actual WAL frames; a `:memory:` clone has no WAL file
  // (WAL is a no-op on memory DBs) and the checkpoint would pass vacuously 0==0.
  const { db } = openDb(dbPath);

  seedEvent(db, "sess-a", "SessionStart", 1);
  seedEvent(db, "sess-a", "Stop", 2);
  seedEvent(db, "sess-b", "SessionStart", 3);

  // The real boot shape: drain inside the checkpoint-tuning wrapper.
  withBootDrainCheckpointTuning(db, () => {
    drainToCompletion(db);
  });

  const cursor = (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;
  expect(cursor).toBe(3);

  // The trailing TRUNCATE checkpoint flushed every COMMITted frame from the
  // WAL into the main DB AND reclaimed the WAL file. A subsequent PASSIVE
  // therefore sees an empty WAL: `log == 0`, `checkpointed == 0` (nothing left
  // to move), and `busy == 0` (no concurrent writer blocked us — at boot main's
  // writer is the only attached connection). The `checkpointed == log` invariant
  // (here 0 == 0) holds because every frame was already flushed.
  const checkpoint = db.query("PRAGMA wal_checkpoint(PASSIVE)").get() as {
    busy: number;
    log: number;
    checkpointed: number;
  };
  expect(checkpoint.busy).toBe(0);
  expect(checkpoint.checkpointed).toBe(checkpoint.log);

  db.close();
});

test("boot drain checkpoints the WAL periodically so peak stays bounded, and the final TRUNCATE collapses it", () => {
  // The in-drain PASSIVE is gated on a folded-event count (or `-wal` size), so
  // the backlog must cross the interval several times. A small TEST-SCALE
  // interval exercises the identical periodic-PASSIVE-caps-WAL contract as the
  // 10k production constant at ~1/50th the event/IO volume, so the case stays
  // well under the suite timeout even on a loaded host. The size gate keeps its
  // production default and never trips at this event count, leaving the count
  // gate as the sole in-drain driver. With `wal_autocheckpoint=0` and NO
  // in-drain checkpoint the `-wal` file grows with the whole drain length; the
  // periodic PASSIVE lets SQLite reuse the file so the high-water plateaus near
  // one interval. The `-wal` file never shrinks mid-drain, so its final size IS
  // the peak high-water the drain reached.
  const interval = 200;

  const walHigh = (path: string): number =>
    existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0;

  // Drive a synthetic backlog through `drainToCompletion`, returning the
  // peak `-wal` file size reached during the drain (captured at the end of the
  // wrapper body, BEFORE its final TRUNCATE) and the post-TRUNCATE size.
  const driveDrain = (
    path: string,
    total: number,
  ): { folded: number; peakWalBytes: number; postTruncateWalBytes: number } => {
    // keep-migrate: this test measures the on-disk `-wal` high-water via
    // `statSync(${path}-wal)`. A `:memory:` clone has no WAL file at all, so the
    // size gates would be meaningless — a real on-disk migrate is the contract.
    const { db } = openDb(path);
    db.run("BEGIN");
    for (let i = 1; i <= total; i += 1) {
      db.run(
        `INSERT INTO events (ts, session_id, pid, hook_event, event_type, permission_mode, data)
           VALUES (?, ?, 4242, 'SessionStart', 'lifecycle', NULL, '{}')`,
        [i, `sess-${i}`],
      );
    }
    db.run("COMMIT");

    let peakWalBytes = 0;
    withBootDrainCheckpointTuning(db, () => {
      drainToCompletion(db, undefined, { checkpointEventInterval: interval });
      peakWalBytes = walHigh(path);
    });
    const folded = (
      db
        .query("SELECT last_event_id FROM reducer_state WHERE id = 1")
        .get() as {
        last_event_id: number;
      }
    ).last_event_id;
    const postTruncateWalBytes = walHigh(path);
    db.close();
    return { folded, peakWalBytes, postTruncateWalBytes };
  };

  // A control backlog JUST UNDER the interval never trips the in-drain gate.
  const controlDir = mkdtempSync(join(tmpdir(), "keeper-wal-control-"));
  const control = driveDrain(
    join(controlDir, "keeper.db"),
    Math.floor(interval * 0.9),
  );
  rmSync(controlDir, { recursive: true, force: true });
  expect(control.peakWalBytes).toBeGreaterThan(0);

  // The large backlog spans several intervals — the in-drain PASSIVE fires
  // repeatedly, so its peak WAL must NOT scale up with the extra length.
  const total = interval * 3;
  const large = driveDrain(dbPath, total);

  // Every event folded — the periodic checkpoint never disturbed the cursor.
  expect(large.folded).toBe(total);

  // The large backlog folds ~3.3× the control's events, but its periodic
  // checkpoint holds the peak WAL within ~2× the (un-checkpointed) control's —
  // NOT the ~3.3× a linear, un-checkpointed WAL would balloon to. This relative
  // bound is what proves the peak does not scale with the drain length.
  expect(large.peakWalBytes).toBeLessThan(control.peakWalBytes * 2);

  // The final TRUNCATE in the wrapper collapsed the WAL file to empty.
  expect(large.postTruncateWalBytes).toBe(0);
});

test("boot drain spanning multiple batches catches up every event", () => {
  const { db } = freshMemDb();

  // More events than a single small batch, to exercise the drain loop.
  const total = 25;
  for (let i = 1; i <= total; i += 1) {
    seedEvent(db, `sess-${i}`, "SessionStart", i);
  }

  // Drive drain with a batch size smaller than the backlog so the loop must
  // iterate — same code path boot uses, just a tighter batch.
  while (drain(db, 10) > 0) {
    // keep folding
  }

  const cursor = (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;
  expect(cursor).toBe(total);

  const jobCount = (
    db.query("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }
  ).n;
  expect(jobCount).toBe(total);

  db.close();
});

// =============================================================================
// fn-659 task .1 — boot-drain pacing for bounce-window starvation mitigation
// =============================================================================
//
// The reducer's `drain()` accepts an optional `DrainOptions` with `paceMs` +
// `paceEvents`. When `paceMs > 0`, the fold loop inserts a real OS-level sleep
// AFTER each event's `BEGIN IMMEDIATE` COMMITs (post-COMMIT seam, OUTSIDE the
// fold transaction), opening a writer-lock window for a concurrent hook
// INSERT (separate process) to slip in instead of starving on the tight
// re-entry into the next `BEGIN IMMEDIATE`. The budget (`paceEvents`) caps
// how many folds are paced so a large from-scratch re-fold catches up to
// head in bounded time.
//
// The tests below exercise:
//   - the mock-sleep counter (the mechanism is invoked the right number of
//     times)
//   - the cross-batch budget exhaustion in `drainToCompletion`
//   - re-fold byte-identical determinism (the post-COMMIT sleep is not an
//     input to any projection)
//   - a deterministic starvation repro using a subprocess concurrent writer
//     (a known-wide-gap drain consistently yields the lock; a known-tight
//     loop consistently starves a short-`busy_timeout` writer)
//   - the large-backlog wedge guard (the budget caps total paced latency)
//   - `withBootDrainCheckpointTuning`'s end-of-boot checkpoint is TRUNCATE
//     (empties the WAL — boot runs before any worker spawns, so nothing to
//     block on; every worker's first open then sees no WAL/-shm recovery path)

test("drain post-COMMIT pacing invokes the injected sleep exactly once per folded event", () => {
  const { db } = freshMemDb();

  const total = 10;
  for (let i = 1; i <= total; i += 1) {
    seedEvent(db, `sess-${i}`, "SessionStart", i);
  }

  // Mock sleep: record every call. The reducer's `drain` must call this once
  // per folded event (post-COMMIT) whenever `paceMs > 0` and the budget is
  // not yet exhausted.
  const sleepCalls: number[] = [];
  const mockSleep = (ms: number) => {
    sleepCalls.push(ms);
  };

  const folded = drain(db, /* batchSize */ 100, {
    paceMs: 7,
    paceEvents: 0, // "pace every event in the batch" — no budget cap
    sleep: mockSleep,
  });

  expect(folded).toBe(total);
  expect(sleepCalls.length).toBe(total);
  expect(sleepCalls.every((ms) => ms === 7)).toBe(true);

  db.close();
});

test("drain post-COMMIT pacing is OFF by default — no sleep call when paceMs is unset", () => {
  const { db } = freshMemDb();

  const total = 5;
  for (let i = 1; i <= total; i += 1) {
    seedEvent(db, `sess-${i}`, "SessionStart", i);
  }

  const sleepCalls: number[] = [];
  const mockSleep = (ms: number) => {
    sleepCalls.push(ms);
  };

  // Pacing knob unset → mockSleep MUST NOT be invoked. Steady-state wakes
  // pass no options and rely on this behavior — the per-event budget is
  // zero, the loop runs at full speed.
  const folded = drain(db, /* batchSize */ 100, { sleep: mockSleep });

  expect(folded).toBe(total);
  expect(sleepCalls.length).toBe(0);

  db.close();
});

test("drain paceEvents budget caps how many folds in a single batch get paced", () => {
  const { db } = freshMemDb();

  const total = 10;
  for (let i = 1; i <= total; i += 1) {
    seedEvent(db, `sess-${i}`, "SessionStart", i);
  }

  const sleepCalls: number[] = [];
  const mockSleep = (ms: number) => {
    sleepCalls.push(ms);
  };

  // Budget = 4 events; the remaining 6 must fold unpaced. This is the
  // mechanism that keeps a large from-scratch re-fold from wedging boot.
  const folded = drain(db, /* batchSize */ 100, {
    paceMs: 3,
    paceEvents: 4,
    sleep: mockSleep,
  });

  expect(folded).toBe(total);
  expect(sleepCalls.length).toBe(4);
  expect(sleepCalls.every((ms) => ms === 3)).toBe(true);

  db.close();
});

test("drainToCompletion pace budget carries across batches and exhausts cleanly", () => {
  const { db } = freshMemDb();

  // 30 events × batchSize 10 = three drain batches.
  const total = 30;
  for (let i = 1; i <= total; i += 1) {
    seedEvent(db, `sess-${i}`, "SessionStart", i);
  }

  const sleepCalls: number[] = [];
  const mockSleep = (ms: number) => {
    sleepCalls.push(ms);
  };

  // Pace budget = 12 events; spread across three batches it should be:
  //   batch1 (10 events): all 10 paced (budget remaining 2 after)
  //   batch2 (10 events): 2 paced + 8 unpaced (budget 0 after)
  //   batch3 (10 events): 0 paced
  // Total mock sleep calls = 12, all at paceMs.
  drainToCompletion(db, /* batchSize */ 10, {
    paceMs: 2,
    paceEvents: 12,
    sleep: mockSleep,
  });

  expect(sleepCalls.length).toBe(12);
  expect(sleepCalls.every((ms) => ms === 2)).toBe(true);

  // Cursor reached head even though only part of the drain was paced.
  const cursor = (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;
  expect(cursor).toBe(total);

  db.close();
});

test("drainToCompletion: large backlog with bounded paceEvents catches up to head in bounded time", () => {
  const { db } = freshMemDb();

  // Simulate a from-scratch re-fold scale: enough events that an unbounded
  // pace (paceEvents=0) at the production paceMs would clearly wedge boot.
  // 2000 events × 5ms = 10s of pacing; capping to 50 keeps it to ~250ms even
  // with a real sleep.
  const total = 2000;
  for (let i = 1; i <= total; i += 1) {
    seedEvent(db, `sess-${i}`, "SessionStart", i);
  }

  const sleepCalls: number[] = [];
  const mockSleep = (ms: number) => {
    sleepCalls.push(ms);
  };

  drainToCompletion(db, /* batchSize */ 200, {
    paceMs: 5,
    paceEvents: 50, // tight cap: only the bounce window's worth of pacing
    sleep: mockSleep,
  });

  // Pacing burned exactly the budget; the remaining 1950 events folded
  // unpaced. Without this cap the drain would have paced all 2000 →
  // 10 seconds of sleep, the wedge case the spec calls out.
  expect(sleepCalls.length).toBe(50);

  const cursor = (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;
  expect(cursor).toBe(total);

  // Projection contains every job.
  const jobCount = (
    db.query("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }
  ).n;
  expect(jobCount).toBe(total);

  db.close();
});

test("BOOT_DRAIN_PACE constants stay inside the documented budget", () => {
  // Documented contract: total worst-case paced latency at boot
  // (`BOOT_DRAIN_PACE_MS × BOOT_DRAIN_PACE_EVENTS`) stays well under any
  // realistic bounce-window patience — under 3 seconds. If a future tweak
  // bumps either constant past this gate, the test signals the implicit
  // boot-latency budget the docs promise.
  expect(BOOT_DRAIN_PACE_MS).toBeGreaterThan(0);
  expect(BOOT_DRAIN_PACE_EVENTS).toBeGreaterThan(0);
  expect(BOOT_DRAIN_PACE_MS * BOOT_DRAIN_PACE_EVENTS).toBeLessThanOrEqual(3000);
});

test("pacing preserves re-fold byte-identical determinism (projection unchanged)", () => {
  // Re-fold determinism is the CLAUDE.md invariant: a from-scratch re-fold
  // (rewind cursor, DELETE projection rows, re-drain) reproduces byte-
  // identical rows. The post-COMMIT sleep is OUTSIDE the fold transaction
  // and reads no wall-clock value into any projection write — so flipping
  // pacing on/off MUST NOT change any projected row.
  function snapshot(db: ReturnType<typeof openDb>["db"]): string {
    // Serialize `jobs` in a stable order. The projection is shape-pinned so
    // the JSON string is a sufficient byte-identity probe; if any pacing
    // path leaked into a projection write it would diverge here. The cell
    // set covers every reducer-write target — lifecycle state, identity,
    // epoch + cursor — without the wall-clock `updated_at` (the reducer
    // stamps the event's own `ts` there, NOT a fresh wall clock, so it
    // would still be byte-identical, but excluding it tightens the probe
    // against an accidental `Date.now()` slip).
    const rows = db
      .query(
        `SELECT job_id, state, title, title_source, pid, start_time, cwd,
                last_event_id, plan_verb, plan_ref, epic_links,
                last_api_error_at, last_api_error_kind
           FROM jobs ORDER BY job_id ASC`,
      )
      .all();
    return JSON.stringify(rows);
  }

  // First fold: NO pacing (the historical shape).
  const a = freshMemDb();
  for (let i = 1; i <= 25; i += 1) {
    seedEvent(a.db, `sess-${i}`, "SessionStart", i);
    seedEvent(
      a.db,
      `sess-${i}`,
      "UserPromptSubmit",
      i + 100,
      i % 2 === 0 ? "plan" : null,
    );
    seedEvent(a.db, `sess-${i}`, "Stop", i + 200);
  }
  drainToCompletion(a.db);
  const snapA = snapshot(a.db);
  a.db.close();

  // Second fold: pacing ON via a mock sleep (no real time spent). Identical
  // event seed.
  const b = freshMemDb();
  for (let i = 1; i <= 25; i += 1) {
    seedEvent(b.db, `sess-${i}`, "SessionStart", i);
    seedEvent(
      b.db,
      `sess-${i}`,
      "UserPromptSubmit",
      i + 100,
      i % 2 === 0 ? "plan" : null,
    );
    seedEvent(b.db, `sess-${i}`, "Stop", i + 200);
  }
  drainToCompletion(b.db, /* batchSize */ 200, {
    paceMs: 7,
    paceEvents: 50,
    sleep: () => {
      /* no-op mock — proves a sleep at all is not what changes the projection */
    },
  });
  const snapB = snapshot(b.db);
  b.db.close();

  // Byte-identical projection rows under pacing on/off.
  expect(snapB).toEqual(snapA);
});

test("isTransientBusyError classifies writer-lock starvation as transient and everything else as fatal", () => {
  // The discriminator the usage mint's drop-don't-crash hinges on. Transient =
  // recoverable lock contention (re-emit / boot-sweep heals a dropped row);
  // everything else, notably SQLITE_CORRUPT (the fn-746 malformed-image class),
  // must stay fatal so the loud-and-fatalExit-and-relaunch contract holds.
  // Both the string `code` (what bun stamps) AND the numeric `errno` fallback.
  expect(isTransientBusyError({ code: "SQLITE_BUSY", errno: 5 })).toBe(true);
  expect(isTransientBusyError({ code: "SQLITE_LOCKED", errno: 6 })).toBe(true);
  expect(isTransientBusyError({ errno: 5 })).toBe(true); // code dropped → errno
  expect(isTransientBusyError({ errno: 6 })).toBe(true);

  // Fatal classes — must NOT be swallowed.
  expect(isTransientBusyError({ code: "SQLITE_CORRUPT", errno: 11 })).toBe(
    false,
  );
  expect(isTransientBusyError({ code: "SQLITE_CONSTRAINT", errno: 19 })).toBe(
    false,
  );
  expect(isTransientBusyError(new Error("plain"))).toBe(false);
  expect(isTransientBusyError("SQLITE_BUSY")).toBe(false); // a bare string
  expect(isTransientBusyError(null)).toBe(false);
  expect(isTransientBusyError(undefined)).toBe(false);
});

// ---------------------------------------------------------------------------
// fn-921 — git seed-liveness watchdog pure verdict
// ---------------------------------------------------------------------------

const WD_BASE = {
  seedRequired: true,
  lastProgressAtMs: 0,
  lastLivenessAtMs: 100_000,
  nowMs: 100_000,
  stuckThresholdMs: GIT_SEED_STUCK_THRESHOLD_MS,
  livenessThresholdMs: 90_000,
  reseedAttempts: 0,
  maxReseedAttempts: GIT_SEED_MAX_RESEED_ATTEMPTS,
};

test("decideGitSeedWatchdog: seed cleared → ok (the healthy steady state)", () => {
  expect(decideGitSeedWatchdog({ ...WD_BASE, seedRequired: false })).toBe("ok");
});

test("decideGitSeedWatchdog: worker never pulsed → ok (never trip mid-boot-seed)", () => {
  // lastLivenessAtMs null = boot-seed may still be in flight. Even with a long-
  // stale progress anchor, we must not act.
  expect(
    decideGitSeedWatchdog({
      ...WD_BASE,
      lastLivenessAtMs: null,
      lastProgressAtMs: 0,
      nowMs: 10_000_000,
    }),
  ).toBe("ok");
});

test("decideGitSeedWatchdog: recent progress → ok (staleness under the threshold)", () => {
  // A snapshot landed 1s ago; seed_required set but not yet stuck.
  expect(
    decideGitSeedWatchdog({
      ...WD_BASE,
      lastProgressAtMs: 100_000,
      lastLivenessAtMs: 100_500,
      nowMs: 101_000,
    }),
  ).toBe("ok");
});

test("decideGitSeedWatchdog: stuck + worker alive + budget remaining → reseed", () => {
  // No progress for > stuckThreshold, but the worker is still pulsing (alive),
  // and we have not exhausted the re-seed budget → re-seed on main first.
  const now = WD_BASE.lastProgressAtMs + GIT_SEED_STUCK_THRESHOLD_MS + 1;
  expect(
    decideGitSeedWatchdog({
      ...WD_BASE,
      nowMs: now,
      lastLivenessAtMs: now, // pulsed just now → alive
      reseedAttempts: 0,
    }),
  ).toBe("reseed");
});

test("decideGitSeedWatchdog: stuck + re-seed budget spent → escalate", () => {
  const now = WD_BASE.lastProgressAtMs + GIT_SEED_STUCK_THRESHOLD_MS + 1;
  expect(
    decideGitSeedWatchdog({
      ...WD_BASE,
      nowMs: now,
      lastLivenessAtMs: now,
      reseedAttempts: GIT_SEED_MAX_RESEED_ATTEMPTS,
    }),
  ).toBe("escalate");
});

test("decideGitSeedWatchdog: mute worker (no pulse past livenessThreshold) → escalate, regardless of re-seed budget", () => {
  // The worker stopped pulsing > livenessThreshold ago — a hung poll tick. A main
  // re-seed would only momentarily clear the flag before the dead producer
  // re-staled it, so restart is the correct recovery even with budget remaining.
  expect(
    decideGitSeedWatchdog({
      ...WD_BASE,
      lastLivenessAtMs: 0,
      nowMs: 200_000, // 200s since last pulse, > 90s liveness threshold
      reseedAttempts: 0,
    }),
  ).toBe("escalate");
});

test("decideGitSeedWatchdog: alive-but-never-seeding still grows stale from the arm baseline → reseed", () => {
  // The stable progress anchor (the watchdog-arm baseline) grows stale even while
  // the worker keeps pulsing — so a quiet repo whose force-emit never clears the
  // flag is still recovered, not stuck forever. Pulse stays fresh (alive); the
  // progress anchor is old (no snapshot ever landed).
  const baseline = 0;
  const now = baseline + GIT_SEED_STUCK_THRESHOLD_MS + 1;
  expect(
    decideGitSeedWatchdog({
      ...WD_BASE,
      lastProgressAtMs: baseline,
      lastLivenessAtMs: now, // still pulsing → alive
      nowMs: now,
      reseedAttempts: 0,
    }),
  ).toBe("reseed");
});

// ---------------------------------------------------------------------------
// fn-1082 / fn-1222 — serve-liveness watchdog pure reducer
// ---------------------------------------------------------------------------

// One monotonic tick at NOW; the previous tick was one interval earlier. Threshold
// inputs are hand-chosen (1s served-latency, floor of 20 samples) so every
// expectation below is hand-reasoned, never re-derived by the reducer under test.
const SWD_NOW = 1_000_000;
const SWD_INTERVAL = SERVE_WATCHDOG_INTERVAL_MS;

// A healthy carried state at the previous tick: every streak clear, the last report
// just arrived, the prior tick one interval back.
const SWD_STATE: ServeWatchdogTriggerState = {
  serverProbeFailStreak: 0,
  busProbeFailStreak: 0,
  lagBreachStreak: 0,
  starvationBreachStreak: 0,
  reportBaselineMonoMs: SWD_NOW,
  lastTickMonoMs: SWD_NOW - SWD_INTERVAL,
};

// Healthy tick inputs: boot grace elapsed, both probes live, no lag, a fresh report,
// and quiet-but-not-breaching starvation terms. Each case perturbs one axis.
const SWD_BASE = {
  nowMonoMs: SWD_NOW,
  bootGraceUntilMonoMs: SWD_NOW - SERVE_WATCHDOG_BOOT_GRACE_MS,
  intervalMs: SWD_INTERVAL,
  clockJumpFactor: SERVE_CLOCK_JUMP_FACTOR,
  prev: SWD_STATE,
  serverProbe: "live" as ProbeTickOutcome,
  busProbe: "live" as ProbeTickOutcome,
  maxProbeFailStreak: SERVE_PROBE_MAX_FAIL_STREAK,
  lagBreached: false,
  maxLagBreachStreak: SERVE_LAG_MAX_CONSECUTIVE_BREACHES,
  lastReportArrivalMonoMs: SWD_NOW as number | null,
  reportMuteThresholdMs: SERVE_REPORT_MUTE_THRESHOLD_MS,
  servedLatencyP99Ms: 5,
  servedLatencyThresholdMs: 1_000,
  queueing: false,
  ourFault: false,
  sampleCount: 100,
  sampleFloor: 20,
  maxStarvationBreachStreak: SERVE_STARVATION_MAX_BREACH_STREAK,
};

// Run one reducer tick with per-tick + carried-state overrides.
function swd(
  over: Partial<Omit<typeof SWD_BASE, "prev">> = {},
  prevOver: Partial<ServeWatchdogTriggerState> = {},
) {
  return decideServeLivenessWatchdog({
    ...SWD_BASE,
    ...over,
    prev: { ...SWD_STATE, ...prevOver },
  });
}

// The full first-paint starvation conjunction for one window — every term breaching.
const SWD_STARVATION_BREACH = {
  servedLatencyP99Ms: 1_500,
  queueing: true,
  lagBreached: true,
  ourFault: true,
  sampleCount: 100,
} as const;

test("decideServeLivenessWatchdog: healthy — live probes, no lag, fresh report → ok", () => {
  expect(swd().verdict).toEqual({ kind: "ok" });
});

test("decideServeLivenessWatchdog: within boot grace → ok with every streak cleared, whatever the inputs look like", () => {
  // Arm-time baselines are meaningless until workers bind + report once; the grace
  // window suppresses the verdict AND holds every streak clear regardless of inputs.
  const r = swd(
    {
      nowMonoMs: SWD_BASE.bootGraceUntilMonoMs - 1,
      serverProbe: "dead",
      busProbe: "dead",
      lagBreached: true,
    },
    {
      lastTickMonoMs: null,
      serverProbeFailStreak: 5,
      busProbeFailStreak: 5,
      lagBreachStreak: 5,
      starvationBreachStreak: 5,
    },
  );
  expect(r.verdict).toEqual({ kind: "ok" });
  expect(r.state.serverProbeFailStreak).toBe(0);
  expect(r.state.busProbeFailStreak).toBe(0);
  expect(r.state.lagBreachStreak).toBe(0);
  expect(r.state.starvationBreachStreak).toBe(0);
});

test("decideServeLivenessWatchdog: accept-stall-server — the fail streak reaches the cap on a dead read", () => {
  // Consecutive-attempt counting, not wall-clock age: one more dead read tips a
  // streak already one short of the cap over, and the verdict NAMES the socket.
  const r = swd(
    { serverProbe: "dead" },
    { serverProbeFailStreak: SERVE_PROBE_MAX_FAIL_STREAK - 1 },
  );
  expect(r.verdict).toEqual({
    kind: "escalate",
    trigger: "accept-stall-server",
  });
  expect(r.state.serverProbeFailStreak).toBe(SERVE_PROBE_MAX_FAIL_STREAK);
});

test("decideServeLivenessWatchdog: accept-stall-server one dead read short of the cap → ok", () => {
  expect(
    swd(
      { serverProbe: "dead" },
      { serverProbeFailStreak: SERVE_PROBE_MAX_FAIL_STREAK - 2 },
    ).verdict,
  ).toEqual({ kind: "ok" });
});

test("decideServeLivenessWatchdog: a live read resets the accept-stall streak (consecutive, not cumulative)", () => {
  // One proof-of-life read breaks the run — the streak must count consecutive
  // failures, so a single answered probe zeroes an almost-tripped streak.
  const r = swd(
    { serverProbe: "live" },
    { serverProbeFailStreak: SERVE_PROBE_MAX_FAIL_STREAK - 1 },
  );
  expect(r.verdict).toEqual({ kind: "ok" });
  expect(r.state.serverProbeFailStreak).toBe(0);
});

test("decideServeLivenessWatchdog: an unarmed socket never accumulates a fail streak (cannot false-trip)", () => {
  // A not-served / not-yet-ready socket fires no probe: its tick outcome is
  // `unarmed`, which resets rather than advances the streak.
  const r = swd(
    { serverProbe: "unarmed" },
    { serverProbeFailStreak: SERVE_PROBE_MAX_FAIL_STREAK - 1 },
  );
  expect(r.verdict).toEqual({ kind: "ok" });
  expect(r.state.serverProbeFailStreak).toBe(0);
});

test("decideServeLivenessWatchdog: accept-stall-bus — the bus fail streak reaches the cap", () => {
  expect(
    swd(
      { busProbe: "dead" },
      { busProbeFailStreak: SERVE_PROBE_MAX_FAIL_STREAK - 1 },
    ).verdict,
  ).toEqual({ kind: "escalate", trigger: "accept-stall-bus" });
});

test("decideServeLivenessWatchdog: both sockets stalled → server trigger wins (deterministic)", () => {
  expect(
    swd(
      { serverProbe: "dead", busProbe: "dead" },
      {
        serverProbeFailStreak: SERVE_PROBE_MAX_FAIL_STREAK - 1,
        busProbeFailStreak: SERVE_PROBE_MAX_FAIL_STREAK - 1,
      },
    ).verdict,
  ).toEqual({ kind: "escalate", trigger: "accept-stall-server" });
});

test("decideServeLivenessWatchdog: busy-lag — lag breached for N consecutive windows → escalate", () => {
  expect(
    swd(
      { lagBreached: true },
      { lagBreachStreak: SERVE_LAG_MAX_CONSECUTIVE_BREACHES - 1 },
    ).verdict,
  ).toEqual({ kind: "escalate", trigger: "busy-lag" });
});

test("decideServeLivenessWatchdog: busy-but-not-wedged — lag breached fewer than N windows → ok", () => {
  expect(
    swd(
      { lagBreached: true },
      { lagBreachStreak: SERVE_LAG_MAX_CONSECUTIVE_BREACHES - 2 },
    ).verdict,
  ).toEqual({ kind: "ok" });
});

test("decideServeLivenessWatchdog: serve-report-mute — no report within the staleness bound (main's arrival clock)", () => {
  // The serve loop froze and stopped posting: the newest arrival is exactly the mute
  // bound old on main's own clock, so mute fires (`>=`).
  const stale = SWD_NOW - SERVE_REPORT_MUTE_THRESHOLD_MS;
  expect(
    swd({ lastReportArrivalMonoMs: stale }, { reportBaselineMonoMs: stale })
      .verdict,
  ).toEqual({ kind: "escalate", trigger: "serve-report-mute" });
});

test("decideServeLivenessWatchdog: report arrival just inside the mute bound → ok", () => {
  const almost = SWD_NOW - SERVE_REPORT_MUTE_THRESHOLD_MS + 1;
  expect(
    swd({ lastReportArrivalMonoMs: almost }, { reportBaselineMonoMs: almost })
      .verdict,
  ).toEqual({ kind: "ok" });
});

test("decideServeLivenessWatchdog: a fresh report advances the baseline and clears an aging mute", () => {
  // A report arriving this tick re-bases the staleness clock; a stale prior baseline
  // must not linger once a newer arrival lands.
  const r = swd(
    { lastReportArrivalMonoMs: SWD_NOW },
    { reportBaselineMonoMs: SWD_NOW - SERVE_REPORT_MUTE_THRESHOLD_MS },
  );
  expect(r.verdict).toEqual({ kind: "ok" });
  expect(r.state.reportBaselineMonoMs).toBe(SWD_NOW);
});

test("decideServeLivenessWatchdog: serve-starvation — the full conjunction reaches N consecutive windows → escalate", () => {
  const r = swd(SWD_STARVATION_BREACH, {
    starvationBreachStreak: SERVE_STARVATION_MAX_BREACH_STREAK - 1,
  });
  expect(r.verdict).toEqual({ kind: "escalate", trigger: "serve-starvation" });
  expect(r.state.starvationBreachStreak).toBe(
    SERVE_STARVATION_MAX_BREACH_STREAK,
  );
});

test("decideServeLivenessWatchdog: serve-starvation one window short of the cap → ok", () => {
  expect(
    swd(SWD_STARVATION_BREACH, {
      starvationBreachStreak: SERVE_STARVATION_MAX_BREACH_STREAK - 2,
    }).verdict,
  ).toEqual({ kind: "ok" });
});

// Each starvation term is individually necessary: drop any one and the window is
// inconclusive — the streak resets to zero and no escalation fires, even one window
// from the cap.
for (const [term, override] of [
  ["served latency below threshold", { servedLatencyP99Ms: 5 }],
  ["the worker loop is not queueing", { queueing: false }],
  ["the daemon is not saturated", { lagBreached: false }],
  ["the daemon is not burning its own cpu", { ourFault: false }],
  ["the sample count is below the floor", { sampleCount: 5 }],
] as const) {
  test(`decideServeLivenessWatchdog: serve-starvation inconclusive when ${term} — streak resets, no escalate`, () => {
    const r = swd(
      { ...SWD_STARVATION_BREACH, ...override },
      { starvationBreachStreak: SERVE_STARVATION_MAX_BREACH_STREAK - 1 },
    );
    expect(r.verdict).toEqual({ kind: "ok" });
    expect(r.state.starvationBreachStreak).toBe(0);
  });
}

test("decideServeLivenessWatchdog: a clock discontinuity resets EVERY trigger's state and fires nothing across it", () => {
  // Laptop suspend/resume: the tick gap leaps past the jump factor. Even with every
  // streak at the cap and inputs that would otherwise escalate, the resume tick
  // returns ok and zeroes all trigger state + re-bases the arrival clock to now.
  const r = swd(
    {
      // A gap beyond clockJumpFactor× the interval since the prior tick, with every
      // other input at its escalating value (starvation breach includes lagBreached).
      serverProbe: "dead",
      busProbe: "dead",
      ...SWD_STARVATION_BREACH,
      lastReportArrivalMonoMs: SWD_NOW - SERVE_REPORT_MUTE_THRESHOLD_MS * 10,
    },
    {
      lastTickMonoMs:
        SWD_NOW - (SERVE_CLOCK_JUMP_FACTOR * SWD_INTERVAL + SWD_INTERVAL),
      serverProbeFailStreak: SERVE_PROBE_MAX_FAIL_STREAK,
      busProbeFailStreak: SERVE_PROBE_MAX_FAIL_STREAK,
      lagBreachStreak: SERVE_LAG_MAX_CONSECUTIVE_BREACHES,
      starvationBreachStreak: SERVE_STARVATION_MAX_BREACH_STREAK,
      reportBaselineMonoMs: SWD_NOW - SERVE_REPORT_MUTE_THRESHOLD_MS * 10,
    },
  );
  expect(r.verdict).toEqual({ kind: "ok" });
  expect(r.state).toEqual({
    serverProbeFailStreak: 0,
    busProbeFailStreak: 0,
    lagBreachStreak: 0,
    starvationBreachStreak: 0,
    reportBaselineMonoMs: SWD_NOW,
    lastTickMonoMs: SWD_NOW,
  });
});

test("decideServeLivenessWatchdog: a gap exactly at the jump factor is NOT a discontinuity (normal eval)", () => {
  // The guard is strictly `>`: a gap of exactly clockJumpFactor× the interval still
  // evaluates the triggers, so a dead-read streak at the cap still escalates.
  const r = swd(
    { serverProbe: "dead" },
    {
      lastTickMonoMs: SWD_NOW - SERVE_CLOCK_JUMP_FACTOR * SWD_INTERVAL,
      serverProbeFailStreak: SERVE_PROBE_MAX_FAIL_STREAK - 1,
    },
  );
  expect(r.verdict).toEqual({
    kind: "escalate",
    trigger: "accept-stall-server",
  });
});

test("SERVE_WATCHDOG_INITIAL_STATE is a clean zeroed state", () => {
  expect(SERVE_WATCHDOG_INITIAL_STATE).toEqual({
    serverProbeFailStreak: 0,
    busProbeFailStreak: 0,
    lagBreachStreak: 0,
    starvationBreachStreak: 0,
    reportBaselineMonoMs: null,
    lastTickMonoMs: null,
  });
});

// ---------------------------------------------------------------------------
// fn-1222 — serve-liveness probe hardening: the probe cannot kill the daemon it
// protects. Pure seams only — the fast tier covers the settle machine, the
// proof-of-life matcher, the self-exempt census, and per-worker arming with zero
// real sockets.
// ---------------------------------------------------------------------------

// -- probeSettleStep: a probe connection is closed on EVERY settle path ---------

test("probeSettleStep: timeout BEFORE open settles false, then the late open closes the orphaned socket", () => {
  // The exact leak the incident rode: the timeout fires before the connection
  // opens, so settle has no socket to end — then open hands us a live socket
  // nobody would otherwise close, orphaning a connection every tick.
  let state: ProbeSettleState = PROBE_SETTLE_INITIAL;

  const t = probeSettleStep(state, { kind: "timeout" });
  state = t.state;
  // Settled false; no socket held yet, so no close is directed at settle time.
  expect(t.actions).toEqual([{ kind: "resolve", ok: false }]);
  expect(state.settled).toBe(true);

  const o = probeSettleStep(state, { kind: "open" });
  state = o.state;
  // The socket that arrived AFTER settling MUST be closed — zero lingering conns.
  expect(o.actions).toEqual([{ kind: "close-socket" }]);
  expect(state.haveSocket).toBe(true);
});

test("probeSettleStep: open then a matched frame settles true and closes the held socket", () => {
  let state: ProbeSettleState = PROBE_SETTLE_INITIAL;
  state = probeSettleStep(state, { kind: "open" }).state;
  const m = probeSettleStep(state, { kind: "match" });
  expect(m.actions).toEqual([
    { kind: "resolve", ok: true },
    { kind: "close-socket" },
  ]);
  expect(m.state.settled).toBe(true);
});

test("probeSettleStep: open then timeout settles false and closes the held socket", () => {
  let state: ProbeSettleState = PROBE_SETTLE_INITIAL;
  state = probeSettleStep(state, { kind: "open" }).state;
  expect(probeSettleStep(state, { kind: "timeout" }).actions).toEqual([
    { kind: "resolve", ok: false },
    { kind: "close-socket" },
  ]);
});

test("probeSettleStep: a close before open settles false, then the late open still closes the socket", () => {
  const state: ProbeSettleState = PROBE_SETTLE_INITIAL;
  const c = probeSettleStep(state, { kind: "close" });
  expect(c.actions).toEqual([{ kind: "resolve", ok: false }]);
  const o = probeSettleStep(c.state, { kind: "open" });
  expect(o.actions).toEqual([{ kind: "close-socket" }]);
});

test("probeSettleStep: post-settle events other than the first open are inert (idempotent, no double-close)", () => {
  let state: ProbeSettleState = PROBE_SETTLE_INITIAL;
  state = probeSettleStep(state, { kind: "open" }).state; // haveSocket
  state = probeSettleStep(state, { kind: "match" }).state; // settled, already closed
  for (const ev of [
    { kind: "match" },
    { kind: "close" },
    { kind: "error" },
    { kind: "timeout" },
    { kind: "open" }, // socket already held — no second close
  ] as ProbeSettleEvent[]) {
    expect(probeSettleStep(state, ev).actions).toEqual([]);
  }
});

// -- probeReplyProvesLife: proof-of-life scoring --------------------------------

test("probeReplyProvesLife: a result frame echoing the correlation id proves life", () => {
  expect(
    probeReplyProvesLife(
      { type: "result", id: "abc-123", rows: [] },
      "abc-123",
    ),
  ).toBe(true);
});

test("probeReplyProvesLife: an error frame echoing the correlation id proves life", () => {
  // The worker read the request to echo the id and answered — the accept→read→
  // write path an accept-stall wedge kills is alive even when the answer errors.
  expect(
    probeReplyProvesLife(
      { type: "error", id: "abc-123", code: "rpc_failed" },
      "abc-123",
    ),
  ).toBe(true);
});

test("probeReplyProvesLife: a cap rejection proves life even though it cannot carry the id", () => {
  // Emitted at accept time, before the request line is read — so it cannot echo
  // the correlation id, yet it proves the accept path answered this connection.
  // This is the id-less-reject the incident wrongly scored as a death.
  expect(
    probeReplyProvesLife(
      { type: "error", code: "too_many_connections" },
      "abc-123",
    ),
  ).toBe(true);
  expect(
    probeReplyProvesLife({ type: "error", code: "max_connections" }, "abc-123"),
  ).toBe(true);
});

test("probeReplyProvesLife: a frame for a DIFFERENT correlation id is not life", () => {
  expect(probeReplyProvesLife({ type: "result", id: "other" }, "abc-123")).toBe(
    false,
  );
});

test("probeReplyProvesLife: an unrelated id-less error is not life", () => {
  // A bad_frame error that neither echoes the id nor is an admission rejection is
  // NOT life — an id-carrying answer (proving the read path) is the bar.
  expect(
    probeReplyProvesLife({ type: "error", code: "bad_frame" }, "abc-123"),
  ).toBe(false);
});

test("probeReplyProvesLife: the bus ack (no rpc id) proves life via extraMatch only", () => {
  const busMatch = (f: Record<string, unknown>): boolean =>
    f.type === "ack" && f.op === "list";
  expect(
    probeReplyProvesLife({ type: "ack", op: "list" }, null, busMatch),
  ).toBe(true);
  expect(
    probeReplyProvesLife({ type: "ack", op: "other" }, null, busMatch),
  ).toBe(false);
});

test("PROBE_LIFE_ADMISSION_CODES holds exactly the two cap-rejection codes", () => {
  // Independent source of truth: the codes server-worker.ts emits at cap-reject.
  expect([...PROBE_LIFE_ADMISSION_CODES].sort()).toEqual([
    "max_connections",
    "too_many_connections",
  ]);
});

// -- isDaemonSelfConn + censusConns: self-exemption + distinct census bucket ----

test("isDaemonSelfConn: an exact pid match only; null / another pid is external", () => {
  expect(isDaemonSelfConn(4242, 4242)).toBe(true);
  expect(isDaemonSelfConn(4243, 4242)).toBe(false);
  expect(isDaemonSelfConn(null, 4242)).toBe(false);
});

function makeCensusConn(o: {
  peerPid: number | null;
  subs?: number;
  pending?: boolean;
  everEngaged?: boolean;
  connectedAt?: number;
  lastActivityAt?: number;
}): CensusConnView {
  const subs = new Map<string | null, unknown>();
  for (let i = 0; i < (o.subs ?? 0); i++) subs.set(String(i), {});
  return {
    data: {
      peerPid: o.peerPid,
      pending: o.pending ? { bytes: new Uint8Array(0), offset: 0 } : null,
      subs: subs as unknown as CensusConnView["data"]["subs"],
      everEngaged: o.everEngaged ?? false,
      connectedAt: o.connectedAt ?? 0,
      // Default fresh (== NOW at the census call sites below), so a conn is
      // `subAbandoned` only when a test explicitly ages its inbound activity.
      lastActivityAt: o.lastActivityAt ?? 1_000_000,
    },
  };
}

test("censusConns: the daemon's own conns land in a distinct self bucket, apart from external classification", () => {
  const SELF = 4242;
  const NOW = 1_000_000;
  const TTL = 30_000;
  const conns: CensusConnView[] = [
    // Three self-probes (peer pid == daemon pid) — the self bucket, never
    // double-counted into pending / zero_sub / sub_* even when subscribed or
    // backpressured.
    makeCensusConn({ peerPid: SELF }),
    makeCensusConn({ peerPid: SELF, subs: 2 }),
    makeCensusConn({ peerPid: SELF, pending: true }),
    // External clients across the reaper-mirroring buckets (5000 alive, 6000 dead).
    makeCensusConn({ peerPid: 5000, subs: 1 }), // sub_live
    makeCensusConn({ peerPid: 6000, subs: 1 }), // sub_dead
    makeCensusConn({ peerPid: null, subs: 1 }), // sub_unknown
    makeCensusConn({ peerPid: 5000, connectedAt: NOW, everEngaged: true }), // zero_sub, fresh
    makeCensusConn({ peerPid: 6000 }), // zero_sub + dead
    makeCensusConn({ peerPid: 5000, connectedAt: 0, everEngaged: false }), // zero_sub + unengaged
    makeCensusConn({ peerPid: 5000, subs: 1, pending: true }), // sub_live + pending
  ];
  const c = censusConns(conns, {
    selfPid: SELF,
    nowMs: NOW,
    unengagedTtlMs: TTL,
    subscribedSilenceTtlMs: 45_000,
    isPidAlive: (pid) => pid === 5000,
  });
  // Hand-computed from the fixtures above (independent of the implementation).
  // Every subscribed fixture defaults `lastActivityAt` to NOW (fresh) → none
  // abandoned; the dedicated aging test below covers `subAbandoned`.
  expect(c).toEqual({
    total: 10,
    self: 3,
    pending: 1, // only the external sub_live+pending conn; the self one is exempt
    zeroSub: 3,
    zeroSubDead: 1,
    zeroSubUnengaged: 1,
    subLive: 2,
    subDead: 1,
    subUnknown: 1,
    subAbandoned: 0,
  });
});

test("censusConns: a subscribed conn inbound-silent past the heartbeat ceiling counts as sub_abandoned; a fresh-heartbeat board never does", () => {
  const SELF = 4242;
  const NOW = 2_000_000;
  const SILENCE_TTL = 45_000;
  const conns: CensusConnView[] = [
    // Abandoned-but-alive: subscribed, peer alive, inbound-silent 60s > 45s.
    makeCensusConn({ peerPid: 5000, subs: 1, lastActivityAt: NOW - 60_000 }),
    // Fresh heartbeat (5s ago < 45s): a legitimately-quiet live board — SAFE,
    // never reaped, never counted abandoned even though it is silent.
    makeCensusConn({ peerPid: 5000, subs: 1, lastActivityAt: NOW - 5_000 }),
    // Exactly at the ceiling counts (>=), independent of peer liveness: a
    // subscribed conn whose peer probe is unavailable is still abandonable.
    makeCensusConn({
      peerPid: null,
      subs: 2,
      lastActivityAt: NOW - SILENCE_TTL,
    }),
    // Zero-sub silent conn is OUT of scope — the idle/unengaged arms own it, so
    // an old lastActivityAt here must NOT count as sub_abandoned.
    makeCensusConn({ peerPid: 5000, subs: 0, lastActivityAt: NOW - 600_000 }),
    // Self-probe subscribed + silent: exempt (self bucket), never abandoned.
    makeCensusConn({ peerPid: SELF, subs: 1, lastActivityAt: NOW - 600_000 }),
  ];
  const c = censusConns(conns, {
    selfPid: SELF,
    nowMs: NOW,
    unengagedTtlMs: 30_000,
    subscribedSilenceTtlMs: SILENCE_TTL,
    isPidAlive: (pid) => pid === 5000,
  });
  // Hand-computed: 2 abandoned (the 60s sub_live + the at-ceiling sub_unknown);
  // the 5s-fresh board, the zero-sub conn, and the self-probe are all excluded.
  expect(c.subAbandoned).toBe(2);
  expect(c.subLive).toBe(2); // the 60s + the 5s conns (both peer 5000, subscribed)
  expect(c.subUnknown).toBe(1); // the null-peer subscribed conn
  expect(c.zeroSub).toBe(1);
  expect(c.self).toBe(1);
  expect(c.total).toBe(5);
});

// -- sliceFanout: bounded per-tick fan-out + round-robin anti-starvation --------

test("sliceFanout: below-budget set serves every unit and resets the cursor (no-op bound)", () => {
  const units = [0, 1, 2, 3];
  const cursor = newFanoutCursor();
  cursor.value = 3; // even a non-zero cursor is ignored when the budget covers all
  const slice = sliceFanout(units, cursor, 10);
  expect(slice.serve).toEqual([0, 1, 2, 3]);
  expect(slice.deferred).toBe(0);
  expect(cursor.value).toBe(0);
});

test("sliceFanout: an empty set serves nothing and resets the cursor", () => {
  const cursor = newFanoutCursor();
  cursor.value = 5;
  const slice = sliceFanout<number>([], cursor, 4);
  expect(slice.serve).toEqual([]);
  expect(slice.deferred).toBe(0);
  expect(cursor.value).toBe(0);
});

test("sliceFanout: over-budget set serves a bounded window and advances the cursor round-robin", () => {
  const units = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const cursor = newFanoutCursor();
  // Tick 1: [0,1,2], cursor → 3.
  expect(sliceFanout(units, cursor, 3).serve).toEqual([0, 1, 2]);
  expect(cursor.value).toBe(3);
  // Tick 2: [3,4,5], cursor → 6.
  expect(sliceFanout(units, cursor, 3).serve).toEqual([3, 4, 5]);
  expect(cursor.value).toBe(6);
  // Tick 3: [6,7,8], cursor → 9.
  expect(sliceFanout(units, cursor, 3).serve).toEqual([6, 7, 8]);
  expect(cursor.value).toBe(9);
  // Tick 4: wraps — [9,0,1], cursor → 2. Every unit served within 4 = ceil(10/3).
  expect(sliceFanout(units, cursor, 3).serve).toEqual([9, 0, 1]);
  expect(cursor.value).toBe(2);
});

test("sliceFanout: every unit is serviced within ceil(N/budget) ticks from ANY starting cursor, and no tick exceeds the budget", () => {
  // The anti-starvation guarantee, proven over a fake unit set for a spread of
  // (N, budget) shapes and every starting offset — the property the serve loop
  // relies on so a deferred subscription can never be starved.
  for (const n of [7, 10, 16, 33, 64, 100]) {
    for (const budget of [1, 3, 8, 13, 64]) {
      if (budget >= n) continue; // the no-op-bound case, covered above
      const bound = Math.ceil(n / budget);
      const units = Array.from({ length: n }, (_, i) => i);
      for (const startOffset of [0, 1, budget, n - 1]) {
        const cursor = newFanoutCursor();
        cursor.value = startOffset;
        // Track, per unit, the last tick it was served; assert no gap exceeds
        // `bound`. Prime "last served" at -1 so a unit unseen through the first
        // `bound` ticks trips the gap check.
        const lastServed = new Array<number>(n).fill(-1);
        // Run enough ticks to observe steady-state gaps well past one wrap.
        for (let tick = 0; tick < bound * 3; tick++) {
          const slice = sliceFanout(units, cursor, budget);
          expect(slice.serve.length).toBe(budget); // never exceeds the budget
          expect(slice.deferred).toBe(n - budget);
          for (const u of slice.serve) lastServed[u] = tick;
          if (tick >= bound - 1) {
            // From the first full window onward, every unit must have been seen
            // within the trailing `bound` ticks.
            for (let u = 0; u < n; u++) {
              expect(tick - lastServed[u]).toBeLessThan(bound);
            }
          }
        }
      }
    }
  }
});

test("sliceFanout: a cursor left past a shrunken ring is normalized, not out-of-bounds", () => {
  // A conn set that shrank between ticks (conns closed) can leave the cursor
  // pointing past the new length; the slice must wrap it, never index undefined.
  const units = [0, 1, 2];
  const cursor: FanoutCursor = { value: 999 };
  const slice = sliceFanout(units, cursor, 2);
  expect(slice.serve).toEqual([0, 1]); // 999 % 3 === 0 → start at 0
  expect(slice.serve.every((u) => u !== undefined)).toBe(true);
  expect(cursor.value).toBe(2);
});

test("MAX_SUBS_PER_TICK is a positive bound", () => {
  // Guards the constant against an accidental 0/negative edit that would make
  // `sliceFanout` treat the production path as unbounded.
  expect(MAX_SUBS_PER_TICK).toBeGreaterThan(0);
});

// -- resolveProbeArming: each socket arms only after its own worker is ready ----

test("resolveProbeArming: an un-armed served socket does not fire and reads fresh (cannot false-trip)", () => {
  const r = resolveProbeArming({
    serverServed: true,
    busServed: true,
    serverArmed: false, // the server worker has not reported ready yet
    busArmed: true,
    nowMs: 2_000,
    lastServerProbeOkAtMs: 0, // stale, but un-armed → ignored
    lastBusProbeOkAtMs: 1_500,
  });
  expect(r.fireServerProbe).toBe(false);
  expect(r.verdictServerProbeOkAtMs).toBe(2_000); // fresh = nowMs, never trips
  expect(r.fireBusProbe).toBe(true);
  expect(r.verdictBusProbeOkAtMs).toBe(1_500); // armed → real probe anchor
});

test("resolveProbeArming: an armed served socket fires and uses its real probe anchor", () => {
  const r = resolveProbeArming({
    serverServed: true,
    busServed: false, // bus not served this boot
    serverArmed: true,
    busArmed: false,
    nowMs: 2_000,
    lastServerProbeOkAtMs: 1_200,
    lastBusProbeOkAtMs: 0,
  });
  expect(r.fireServerProbe).toBe(true);
  expect(r.verdictServerProbeOkAtMs).toBe(1_200);
  expect(r.fireBusProbe).toBe(false);
  expect(r.verdictBusProbeOkAtMs).toBe(2_000); // unserved → fresh
});

test("resolveProbeArming: a bus-only boot arms its bus probe and leaves the unserved server fresh", () => {
  const r = resolveProbeArming({
    serverServed: false,
    busServed: true,
    serverArmed: false,
    busArmed: true,
    nowMs: 5_000,
    lastServerProbeOkAtMs: 0,
    lastBusProbeOkAtMs: 4_900,
  });
  expect(r.fireServerProbe).toBe(false);
  expect(r.verdictServerProbeOkAtMs).toBe(5_000);
  expect(r.fireBusProbe).toBe(true);
  expect(r.verdictBusProbeOkAtMs).toBe(4_900);
});

// ---------------------------------------------------------------------------
// crash-loop distress — pure verdict + restart ledger
// ---------------------------------------------------------------------------

const CL_NOW = 10_000_000;
const CL_WINDOW = CRASH_LOOP_WINDOW_MS;

// N boots spaced one interval apart, ending at `end`. `stepMs` defaults to a
// mid-window spacing so all N land inside one window unless a test says otherwise.
function bootsEndingAt(end: number, n: number, stepMs: number): number[] {
  return Array.from({ length: n }, (_, i) => end - (n - 1 - i) * stepMs);
}

test("decideCrashLoop: boot count at threshold inside the window → crash-loop", () => {
  const bootTimestamps = bootsEndingAt(CL_NOW, CRASH_LOOP_THRESHOLD, 90_000);
  expect(
    decideCrashLoop({
      nowMs: CL_NOW,
      bootTimestamps,
      threshold: CRASH_LOOP_THRESHOLD,
      windowMs: CL_WINDOW,
    }),
  ).toEqual({ crashLoop: true, recentBoots: CRASH_LOOP_THRESHOLD });
});

test("decideCrashLoop: one under threshold → healthy", () => {
  const bootTimestamps = bootsEndingAt(
    CL_NOW,
    CRASH_LOOP_THRESHOLD - 1,
    90_000,
  );
  expect(
    decideCrashLoop({
      nowMs: CL_NOW,
      bootTimestamps,
      threshold: CRASH_LOOP_THRESHOLD,
      windowMs: CL_WINDOW,
    }),
  ).toEqual({ crashLoop: false, recentBoots: CRASH_LOOP_THRESHOLD - 1 });
});

test("decideCrashLoop: boots aged past the window are not counted", () => {
  // Threshold-many boots, but all older than one full window → window-aging drops
  // them, so a daemon that looped-then-recovered reads healthy.
  const bootTimestamps = bootsEndingAt(
    CL_NOW - CL_WINDOW - 1,
    CRASH_LOOP_THRESHOLD,
    1_000,
  );
  expect(
    decideCrashLoop({
      nowMs: CL_NOW,
      bootTimestamps,
      threshold: CRASH_LOOP_THRESHOLD,
      windowMs: CL_WINDOW,
    }),
  ).toEqual({ crashLoop: false, recentBoots: 0 });
});

test("decideCrashLoop: future-dated garbage is ignored", () => {
  expect(
    decideCrashLoop({
      nowMs: CL_NOW,
      bootTimestamps: [CL_NOW + 5_000, CL_NOW + 10_000],
      threshold: 1,
      windowMs: CL_WINDOW,
    }),
  ).toEqual({ crashLoop: false, recentBoots: 0 });
});

function bootLine(
  bootId: string,
  ts: number,
  provenance: RestartProvenance,
  prevRuntimeMs: number | null,
): RestartBootLine {
  return {
    kind: "boot",
    boot_id: bootId,
    ts,
    provenance,
    prev_runtime_ms: prevRuntimeMs,
  };
}

// ── provenance heuristic ─────────────────────────────────────────────────────

test("classifyRestartProvenance: the launchd label (and a suffixed sibling) is launchd", () => {
  expect(classifyRestartProvenance(KEEPERD_LAUNCHD_LABEL)).toBe("launchd");
  expect(classifyRestartProvenance(`${KEEPERD_LAUNCHD_LABEL}.bus-only`)).toBe(
    "launchd",
  );
});

test("classifyRestartProvenance: missing / empty / the '0' sentinel maps to unknown", () => {
  expect(classifyRestartProvenance(undefined)).toBe("unknown");
  expect(classifyRestartProvenance(null)).toBe("unknown");
  expect(classifyRestartProvenance("")).toBe("unknown");
  expect(classifyRestartProvenance("   ")).toBe("unknown");
  expect(classifyRestartProvenance("0")).toBe("unknown");
});

test("classifyRestartProvenance: any other service name is a foreign context", () => {
  expect(classifyRestartProvenance("com.apple.Terminal")).toBe("foreign");
  expect(classifyRestartProvenance("dev.direnv.thing")).toBe("foreign");
});

// ── NDJSON line serialize / parse (torn-tail contract) ───────────────────────

test("serializeRestartLedgerLine / parseRestartLedgerLine: a boot line round-trips", () => {
  const line = bootLine("abc", 1234, "launchd", 90_000);
  const s = serializeRestartLedgerLine(line);
  expect(s.endsWith("\n")).toBe(true);
  expect(parseRestartLedgerLine(s)).toEqual(line);
});

test("serializeRestartLedgerLine / parseRestartLedgerLine: an enrich line round-trips", () => {
  const line: RestartLedgerLine = {
    kind: "enrich",
    boot_id: "abc",
    ts: 1300,
    reason: "uncaughtException: boom",
  };
  expect(parseRestartLedgerLine(serializeRestartLedgerLine(line))).toEqual(
    line,
  );
});

test("parseRestartLedgerLine: a torn / partial trailing line folds to null (never corrupts)", () => {
  expect(parseRestartLedgerLine('{"kind":"boot","boot_id":"a","ts')).toBeNull();
  expect(parseRestartLedgerLine("")).toBeNull();
  expect(parseRestartLedgerLine("   ")).toBeNull();
});

test("parseRestartLedgerLine: a missing boot_id or non-finite ts folds to null", () => {
  expect(parseRestartLedgerLine('{"kind":"boot","ts":1}')).toBeNull();
  expect(
    parseRestartLedgerLine('{"kind":"boot","boot_id":"a","ts":null}'),
  ).toBeNull();
  expect(
    parseRestartLedgerLine('{"kind":"boot","boot_id":"","ts":1}'),
  ).toBeNull();
});

test("parseRestartLedgerLine: an unknown kind folds to null", () => {
  expect(
    parseRestartLedgerLine('{"kind":"other","boot_id":"a","ts":1}'),
  ).toBeNull();
});

test("parseRestartLedgerLine: garbage provenance folds to unknown, a missing gap to null", () => {
  expect(
    parseRestartLedgerLine(
      '{"kind":"boot","boot_id":"a","ts":1,"provenance":"martian"}',
    ),
  ).toEqual(bootLine("a", 1, "unknown", null));
});

test("parseRestartLedgerLine: an enrich line with a non-string reason folds to null", () => {
  expect(
    parseRestartLedgerLine('{"kind":"enrich","boot_id":"a","ts":1,"reason":5}'),
  ).toBeNull();
});

test("parseRestartLedgerLine: an overlong reason is bounded on read", () => {
  const line: RestartLedgerLine = {
    kind: "enrich",
    boot_id: "a",
    ts: 1,
    reason: "x".repeat(RESTART_LEDGER_REASON_MAX_LEN + 500),
  };
  const parsed = parseRestartLedgerLine(serializeRestartLedgerLine(line)) as {
    reason: string;
  };
  expect(parsed.reason.length).toBe(RESTART_LEDGER_REASON_MAX_LEN);
});

// ── whole-body parse: NDJSON + legacy dual-read ──────────────────────────────

test("parseRestartLedger: NDJSON multi-line round-trips every line", () => {
  const lines: RestartLedgerLine[] = [
    bootLine("a", 1, "launchd", null),
    { kind: "enrich", boot_id: "a", ts: 2, reason: "boom" },
    bootLine("b", 3, "foreign", 2),
  ];
  const raw = lines.map(serializeRestartLedgerLine).join("");
  expect(parseRestartLedger(raw)).toEqual(lines);
});

test("parseRestartLedger: a torn trailing line is dropped, earlier lines survive", () => {
  const raw =
    serializeRestartLedgerLine(bootLine("a", 1, "launchd", null)) +
    '{"kind":"boot","boot_id":"b","ts';
  expect(parseRestartLedger(raw)).toEqual([bootLine("a", 1, "launchd", null)]);
});

test("parseRestartLedger: dual-reads the legacy number array as unknown-provenance boots", () => {
  expect(parseRestartLedger("[1, 2, 3]")).toEqual([
    bootLine("legacy:0:1", 1, "unknown", null),
    bootLine("legacy:1:2", 2, "unknown", null),
    bootLine("legacy:2:3", 3, "unknown", null),
  ]);
});

test("parseRestartLedger: dual-reads legacy object entries, a reason becoming an enrich line", () => {
  const raw = JSON.stringify([{ ts: 1 }, { ts: 2, reason: "boom" }]);
  expect(parseRestartLedger(raw)).toEqual([
    bootLine("legacy:0:1", 1, "unknown", null),
    bootLine("legacy:1:2", 2, "unknown", null),
    { kind: "enrich", boot_id: "legacy:1:2", ts: 2, reason: "boom" },
  ]);
});

test("parseRestartLedger: a legacy non-string reason drops the reason but keeps the boot", () => {
  expect(parseRestartLedger('[{"ts": 5, "reason": 12345}]')).toEqual([
    bootLine("legacy:0:5", 5, "unknown", null),
  ]);
});

test("parseRestartLedger: corrupt / garbage bodies fail open to empty (never trip)", () => {
  expect(parseRestartLedger("not json at all")).toEqual([]);
  expect(parseRestartLedger('{"not":"an array"}')).toEqual([]);
  expect(parseRestartLedger("")).toEqual([]);
  // A legacy array with malformed members keeps only the finite-ts entries.
  expect(
    parseRestartLedger('[1, "two", null, 3, 1e999, {}, {"ts":"nope"}]'),
  ).toEqual([
    bootLine("legacy:0:1", 1, "unknown", null),
    bootLine("legacy:3:3", 3, "unknown", null),
  ]);
});

test("parseRestartLedger: a legacy rapid-boot array still trips the loop after the format flip", () => {
  // Acceptance: the count survives the transition. THRESHOLD+1 boots 90s apart
  // dual-read into forensic boot records; collapse backfills the young gaps.
  const legacy = bootsEndingAt(CL_NOW, CRASH_LOOP_THRESHOLD + 1, 90_000);
  const lines = parseRestartLedger(JSON.stringify(legacy));
  expect(lines.filter((l) => l.kind === "boot").length).toBe(
    CRASH_LOOP_THRESHOLD + 1,
  );
  const qualified = qualifyCrashLoopBootTimestamps(
    collapseRestartLedger(lines),
    CRASH_LOOP_YOUNG_RUNTIME_MS,
  );
  expect(
    decideCrashLoop({
      nowMs: CL_NOW,
      bootTimestamps: qualified,
      threshold: CRASH_LOOP_THRESHOLD,
      windowMs: CL_WINDOW,
    }),
  ).toEqual({ crashLoop: true, recentBoots: CRASH_LOOP_THRESHOLD });
});

// ── collapse: per-boot_id merge, prev backfill, orphan forensics ─────────────

test("collapseRestartLedger: a boot line and its enrichment collapse to one record", () => {
  expect(
    collapseRestartLedger([
      bootLine("a", 1000, "launchd", null),
      { kind: "enrich", boot_id: "a", ts: 1500, reason: "boom" },
    ]),
  ).toEqual([
    {
      boot_id: "a",
      ts: 1000,
      provenance: "launchd",
      prev_runtime_ms: null,
      reason: "boom",
      died_at_ms: 1500,
    },
  ]);
});

test("collapseRestartLedger: an orphan enrichment synthesizes a forensic record, never dropped", () => {
  expect(
    collapseRestartLedger([
      { kind: "enrich", boot_id: "orphan", ts: 5000, reason: "late" },
    ]),
  ).toEqual([
    {
      boot_id: "orphan",
      ts: 5000,
      provenance: "unknown",
      prev_runtime_ms: null,
      reason: "late",
      died_at_ms: 5000,
    },
  ]);
});

test("collapseRestartLedger: backfills a missing prev_runtime from the gap, preserves a frozen one", () => {
  const boots = collapseRestartLedger([
    bootLine("a", 1000, "launchd", null),
    bootLine("b", 1000 + 90_000, "launchd", null),
    bootLine("c", 1000 + 90_000 + 500_000, "launchd", 42),
  ]);
  // a: first → null. b: backfilled to the 90s gap. c: frozen 42 preserved.
  expect(boots.map((b) => b.prev_runtime_ms)).toEqual([null, 90_000, 42]);
});

// ── fold this boot: gap freeze + overlapping-boot retention ──────────────────

test("foldBootIntoRestartLedger: the first-ever boot has a null predecessor gap", () => {
  const { lines, bootLine: bl } = foldBootIntoRestartLedger({
    existing: [],
    bootId: "first",
    provenance: "launchd",
    nowMs: CL_NOW,
    windowMs: CL_WINDOW,
    cap: RESTART_LEDGER_CAP,
  });
  expect(bl).toEqual(bootLine("first", CL_NOW, "launchd", null));
  expect(lines).toEqual([bl]);
});

test("foldBootIntoRestartLedger: freezes the inter-boot gap to the predecessor", () => {
  const { bootLine: bl } = foldBootIntoRestartLedger({
    existing: [bootLine("prev", CL_NOW - 90_000, "launchd", null)],
    bootId: "cur",
    provenance: "launchd",
    nowMs: CL_NOW,
    windowMs: CL_WINDOW,
    cap: RESTART_LEDGER_CAP,
  });
  expect(bl.prev_runtime_ms).toBe(90_000);
});

test("foldBootIntoRestartLedger: overlapping boots at the same instant each retain their own line", () => {
  // Fails against a timestamp-keyed ledger, which filtered out any entry whose ts
  // equalled the booting process's nowMs — erasing the overlapping boot's record.
  const { lines } = foldBootIntoRestartLedger({
    existing: [bootLine("a", CL_NOW, "launchd", null)],
    bootId: "b",
    provenance: "unknown",
    nowMs: CL_NOW,
    windowMs: CL_WINDOW,
    cap: RESTART_LEDGER_CAP,
  });
  const bootIds = lines.filter((l) => l.kind === "boot").map((l) => l.boot_id);
  expect(bootIds).toEqual(["a", "b"]);
});

test("collapseRestartLedger: a dying boot's enrichment touches only its own overlapping line", () => {
  // Two daemons overlap; boot "a" dies and appends an enrich line. Boot "b" is
  // untouched — the append-only enrich cannot erase the overlapping boot the way
  // the old ts-keyed read-modify-write did.
  const boots = collapseRestartLedger([
    bootLine("a", CL_NOW, "launchd", null),
    bootLine("b", CL_NOW, "foreign", null),
    { kind: "enrich", boot_id: "a", ts: CL_NOW + 10, reason: "a-died" },
  ]);
  expect(boots.length).toBe(2);
  expect(boots.find((x) => x.boot_id === "a")?.reason).toBe("a-died");
  expect(boots.find((x) => x.boot_id === "b")?.reason).toBeUndefined();
});

// ── compaction: window aging + cap + flatten ─────────────────────────────────

test("compactRestartLedger: ages out an old boot, keeps in-window boots and their enrichment", () => {
  const out = compactRestartLedger(
    [
      bootLine("old", CL_NOW - CL_WINDOW - 1, "launchd", null),
      bootLine("keep1", CL_NOW - 1_000, "launchd", null),
      { kind: "enrich", boot_id: "keep1", ts: CL_NOW - 500, reason: "boom" },
      bootLine("keep2", CL_NOW, "launchd", 1_000),
    ],
    { nowMs: CL_NOW, windowMs: CL_WINDOW, cap: RESTART_LEDGER_CAP },
  );
  expect(out.filter((l) => l.kind === "boot").map((l) => l.boot_id)).toEqual([
    "keep1",
    "keep2",
  ]);
  expect(out.filter((l) => l.kind === "enrich").map((l) => l.boot_id)).toEqual([
    "keep1",
  ]);
});

test("compactRestartLedger: the length cap keeps the most recent boots", () => {
  const many: RestartLedgerLine[] = [];
  for (let i = 0; i < RESTART_LEDGER_CAP + 5; i++) {
    many.push(
      bootLine(
        `b-${i}`,
        CL_NOW - (RESTART_LEDGER_CAP + 5 - i) * 100,
        "launchd",
        null,
      ),
    );
  }
  const boots = compactRestartLedger(many, {
    nowMs: CL_NOW,
    windowMs: CL_WINDOW,
    cap: RESTART_LEDGER_CAP,
  }).filter((l) => l.kind === "boot");
  expect(boots.length).toBe(RESTART_LEDGER_CAP);
  expect(boots[boots.length - 1].boot_id).toBe(`b-${RESTART_LEDGER_CAP + 4}`);
});

test("compactRestartLedger: a future-dated boot is dropped", () => {
  const out = compactRestartLedger(
    [
      bootLine("now", CL_NOW, "launchd", null),
      bootLine("future", CL_NOW + 10_000, "launchd", null),
    ],
    { nowMs: CL_NOW, windowMs: CL_WINDOW, cap: RESTART_LEDGER_CAP },
  );
  expect(out.filter((l) => l.kind === "boot").map((l) => l.boot_id)).toEqual([
    "now",
  ]);
});

// ── runtime-qualified crash-loop counting ────────────────────────────────────

test("qualifyCrashLoopBootTimestamps: young predecessors count, healthy bounce / no-pred / foreign do not", () => {
  const base = 1_000_000;
  const boots: RestartBoot[] = collapseRestartLedger([
    bootLine("h", base, "launchd", null), // no predecessor → excluded
    bootLine("a", base + 3_600_000, "launchd", 3_600_000), // ran 1h → excluded
    bootLine("b", base + 3_600_000 + 90_000, "launchd", 90_000), // young → counts
    bootLine("c", base + 3_600_000 + 180_000, "unknown", 90_000), // unknown young → counts
    bootLine("f", base + 3_600_000 + 270_000, "foreign", 90_000), // foreign → excluded
  ]);
  expect(
    qualifyCrashLoopBootTimestamps(boots, CRASH_LOOP_YOUNG_RUNTIME_MS),
  ).toEqual([base + 3_600_000 + 90_000, base + 3_600_000 + 180_000]);
});

test("qualify + decideCrashLoop: a bounce of a healthy long-running daemon does not trip", () => {
  const boots = collapseRestartLedger([
    bootLine("h", CL_NOW - 3_600_000, "launchd", null),
    bootLine("x", CL_NOW, "launchd", 3_600_000), // bounced after 1h
  ]);
  expect(
    decideCrashLoop({
      nowMs: CL_NOW,
      bootTimestamps: qualifyCrashLoopBootTimestamps(
        boots,
        CRASH_LOOP_YOUNG_RUNTIME_MS,
      ),
      threshold: CRASH_LOOP_THRESHOLD,
      windowMs: CL_WINDOW,
    }),
  ).toEqual({ crashLoop: false, recentBoots: 0 });
});

test("qualify + decideCrashLoop: repeated young deaths trip the loop", () => {
  const lines: RestartLedgerLine[] = [];
  // THRESHOLD+1 boots 90s apart: the leading boot has no predecessor (excluded),
  // the following THRESHOLD each had a young (90s) predecessor → exactly THRESHOLD.
  for (let i = 0; i <= CRASH_LOOP_THRESHOLD; i++) {
    lines.push(
      bootLine(
        `loop-${i}`,
        CL_NOW - (CRASH_LOOP_THRESHOLD - i) * 90_000,
        "launchd",
        i === 0 ? null : 90_000,
      ),
    );
  }
  expect(
    decideCrashLoop({
      nowMs: CL_NOW,
      bootTimestamps: qualifyCrashLoopBootTimestamps(
        collapseRestartLedger(lines),
        CRASH_LOOP_YOUNG_RUNTIME_MS,
      ),
      threshold: CRASH_LOOP_THRESHOLD,
      windowMs: CL_WINDOW,
    }),
  ).toEqual({ crashLoop: true, recentBoots: CRASH_LOOP_THRESHOLD });
});

// ── file round-trip: NDJSON write / read / append ────────────────────────────

test("readRestartLedger / writeRestartLedger: NDJSON round-trip through a real file, no temp left behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-restart-ledger-"));
  const path = join(dir, "restart-ledger.json");
  try {
    const lines: RestartLedgerLine[] = [
      bootLine("a", 1, "launchd", null),
      {
        kind: "enrich",
        boot_id: "a",
        ts: 2,
        reason: "serve-liveness-watchdog: probe-stuck",
      },
      bootLine("b", 3, "foreign", 2),
    ];
    writeRestartLedger(path, lines);
    expect(readRestartLedger(path)).toEqual(lines);
    const leftovers = readdirSync(dir).filter(
      (f) => f !== "restart-ledger.json",
    );
    expect(leftovers).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendRestartLedgerLine: appends one line without overwriting existing content", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-restart-ledger-"));
  const path = join(dir, "restart-ledger.json");
  try {
    writeFileSync(
      path,
      serializeRestartLedgerLine(bootLine("a", 1, "launchd", null)),
    );
    appendRestartLedgerLine(path, {
      kind: "enrich",
      boot_id: "a",
      ts: 2,
      reason: "boom",
    });
    expect(readRestartLedger(path)).toEqual([
      bootLine("a", 1, "launchd", null),
      { kind: "enrich", boot_id: "a", ts: 2, reason: "boom" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRestartLedger: a missing file fails open to empty", () => {
  expect(
    readRestartLedger(join(tmpdir(), "keeper-nonexistent-ledger.json")),
  ).toEqual([]);
});

test("withBootDrainCheckpointTuning ends the boot with a TRUNCATE checkpoint (empties the WAL)", () => {
  // The end-of-boot checkpoint runs in the `finally` AFTER the drain body. It
  // is TRUNCATE, not PASSIVE: this wrapper runs at boot BEFORE any worker
  // thread spawns, so main's writer is the only connection attached and there
  // is nothing to wait on. TRUNCATE empties the WAL file so every worker's
  // first `openDb` reads the main file with no WAL frames to scan and no `-shm`
  // recovery path to walk — closing a boot-race failure surface under load.
  //
  // Probe the choice via the WAL file's observable post-state. After the
  // wrapper exits:
  //   - TRUNCATE leaves `log == 0` (WAL file reclaimed)
  //   - PASSIVE leaves `log > 0` (frames flushed but the file is not reclaimed)
  // This test pins the SPECIFIC checkpoint mode by asserting `log == 0` after —
  // the regression signal if a future tweak switches the trailing checkpoint
  // back to PASSIVE.
  //
  // keep-migrate: this pins the TRUNCATE-vs-PASSIVE checkpoint mode via the
  // on-disk WAL's post-state (`log == 0` after TRUNCATE reclaims the file). A
  // `:memory:` clone has no WAL file, so the probe would pass vacuously.
  const { db } = openDb(dbPath);

  // Seed enough events that PASSIVE would leave a measurable WAL frame count —
  // so the `log == 0` assertion below is meaningful (a too-small WAL would also
  // yield log=0 under PASSIVE, masking a regression).
  for (let i = 1; i <= 20; i += 1) {
    seedEvent(db, `sess-${i}`, "SessionStart", i);
    seedEvent(db, `sess-${i}`, "Stop", i + 1000);
  }

  withBootDrainCheckpointTuning(db, () => {
    drainToCompletion(db);
  });

  // Probe the post-state. TRUNCATE reclaimed the WAL file, so a follow-up
  // checkpoint sees an empty WAL: `log == 0`. A regression to PASSIVE would
  // leave `log > 0` here.
  const probe = db.query("PRAGMA wal_checkpoint(PASSIVE)").get() as {
    busy: number;
    log: number;
    checkpointed: number;
  };
  expect(probe.busy).toBe(0);
  expect(probe.log).toBe(0);
  expect(probe.checkpointed).toBe(0);

  db.close();
});

/**
 * The plan-worker → main path: a `plan-epic`/`plan-task` snapshot message
 * becomes a synthetic `EpicSnapshot`/`TaskSnapshot` events row that main inserts
 * on its writable connection (entity id in `session_id`, the snapshot in
 * `data`), then folds. This mirrors exactly what `runDaemon`'s
 * `planWorker.onmessage` branch does (insert via the same positional column
 * order, then pump a drain) — driven directly here so no Worker is spawned.
 */
function insertPlanSnapshot(
  stmts: ReturnType<typeof openDb>["stmts"],
  hookEvent: "EpicSnapshot" | "TaskSnapshot",
  entityId: string,
  ts: number,
  data: Record<string, unknown>,
): void {
  stmts.insertEvent.run({
    $ts: ts,
    $session_id: entityId, // the entity pk
    $pid: null,
    $hook_event: hookEvent,
    $event_type: "plan_snapshot",
    $tool_name: null,
    $matcher: null,
    $cwd: null,
    $permission_mode: null,
    $agent_id: null,
    $agent_type: null,
    $stop_hook_active: null,
    $data: JSON.stringify(data), // the full snapshot blob
    $subagent_agent_id: null,
    $spawn_name: null,
    $start_time: null,
  });
}

test("synthetic EpicSnapshot/TaskSnapshot events fold into epics (tasks embedded)", () => {
  const { db, stmts } = freshMemDb();

  insertPlanSnapshot(stmts, "EpicSnapshot", "fn-7-add-oauth", 1, {
    epic_number: 7,
    title: "Add OAuth",
    project_dir: "/Users/mike/code/keeper",
    status: "in_progress",
  });
  insertPlanSnapshot(stmts, "TaskSnapshot", "fn-7-add-oauth.2", 2, {
    epic_id: "fn-7-add-oauth",
    task_number: 2,
    title: "Wire the callback",
    target_repo: "/Users/mike/code/keeper",
    status: "open",
  });

  drainToCompletion(db);

  // Cursor advanced past both synthetic events.
  const cursor = (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;
  expect(cursor).toBe(2);

  const epic = db
    .query(
      "SELECT epic_number, title, project_dir, status, last_event_id, tasks FROM epics WHERE epic_id = 'fn-7-add-oauth'",
    )
    .get() as {
    epic_number: number;
    title: string;
    project_dir: string;
    status: string;
    last_event_id: number;
    tasks: string;
  };
  expect(epic.epic_number).toBe(7);
  expect(epic.title).toBe("Add OAuth");
  expect(epic.project_dir).toBe("/Users/mike/code/keeper");
  expect(epic.status).toBe("in_progress");
  // Schema v7: the TaskSnapshot folds into the epic's embedded array and bumps
  // the parent epic's last_event_id (so the epic row patches).
  expect(epic.last_event_id).toBe(2);

  // The task is embedded in the parent epic's `tasks` array (no standalone
  // tasks table).
  const tasks = JSON.parse(epic.tasks) as {
    task_id: string;
    epic_id: string;
    task_number: number;
    title: string;
    target_repo: string;
    tier: string | null;
    model: string | null;
    worker_phase: string;
    runtime_status: string;
    depends_on: string[];
    jobs: unknown[];
  }[];
  expect(tasks.length).toBe(1);
  expect(tasks[0]).toEqual({
    task_id: "fn-7-add-oauth.2",
    epic_id: "fn-7-add-oauth",
    task_number: 2,
    title: "Wire the callback",
    target_repo: "/Users/mike/code/keeper",
    // fn-602: `tier` rides FREE in the embedded JSON. This synthetic event
    // omits the field — the reducer reads `snapshot.tier ?? null` so the
    // embedded element folds to `null` deterministically (graceful-
    // degradation precedent shared with `worker_phase`/`runtime_status`).
    tier: null,
    // `model` rides FREE alongside `tier`; an omitting event folds to null.
    model: null,
    // Schema v19: the legacy `status` column was renamed to `worker_phase`
    // (derived worker-phase binary) and a sibling `runtime_status` field
    // surfaces the plan-native enum. A TaskSnapshot blob without a state
    // file folds `runtime_status` to the plan `"todo"` default.
    worker_phase: "open",
    runtime_status: "todo",
    depends_on: [],
    // Schema v11: first-sight task element gets an empty embedded jobs sub-array.
    jobs: [],
  });

  db.close();
});

test("EpicSnapshot folds depends_on_epics; TaskSnapshot folds depends_on into the embedded element", () => {
  const { db, stmts } = freshMemDb();

  insertPlanSnapshot(stmts, "EpicSnapshot", "fn-7-add-oauth", 1, {
    epic_number: 7,
    title: "Add OAuth",
    status: "open",
    depends_on_epics: ["fn-3-base", "fn-5-prereq"],
  });
  insertPlanSnapshot(stmts, "TaskSnapshot", "fn-7-add-oauth.2", 2, {
    epic_id: "fn-7-add-oauth",
    task_number: 2,
    title: "Wire the callback",
    status: "open",
    depends_on: ["fn-7-add-oauth.1"],
  });
  drainToCompletion(db);

  const epic = db
    .query(
      "SELECT depends_on_epics, tasks FROM epics WHERE epic_id = 'fn-7-add-oauth'",
    )
    .get() as { depends_on_epics: string; tasks: string };
  // Epic deps are stored as a JSON-TEXT array column.
  expect(JSON.parse(epic.depends_on_epics)).toEqual([
    "fn-3-base",
    "fn-5-prereq",
  ]);
  // Task deps ride inside the embedded element.
  const tasks = JSON.parse(epic.tasks) as { depends_on: string[] }[];
  expect(tasks[0]?.depends_on).toEqual(["fn-7-add-oauth.1"]);

  db.close();
});

test("a re-arrived EpicSnapshot upserts last-write-wins with monotonic last_event_id", () => {
  const { db, stmts } = freshMemDb();

  insertPlanSnapshot(stmts, "EpicSnapshot", "fn-7-add-oauth", 1, {
    epic_number: 7,
    title: "Add OAuth",
    project_dir: "/Users/mike/code/keeper",
    status: "open",
  });
  drainToCompletion(db);

  // A later snapshot for the same epic (status moved on disk) upserts in place.
  insertPlanSnapshot(stmts, "EpicSnapshot", "fn-7-add-oauth", 2, {
    epic_number: 7,
    title: "Add OAuth",
    project_dir: "/Users/mike/code/keeper",
    status: "done",
  });
  drainToCompletion(db);

  const rows = db
    .query(
      "SELECT status, last_event_id FROM epics WHERE epic_id = 'fn-7-add-oauth'",
    )
    .all() as { status: string; last_event_id: number }[];
  // One row (idempotent upsert), the newer snapshot won, version advanced.
  expect(rows.length).toBe(1);
  expect(rows[0].status).toBe("done");
  expect(rows[0].last_event_id).toBe(2);

  db.close();
});

// ---------------------------------------------------------------------------
// Seed sweep — Q7 boot-time liveness pass (dead → Killed; alive+recycled →
// Killed; alive+matching → leave; legacy NULL start_time → leave).
// ---------------------------------------------------------------------------

/**
 * Pre-seed a `jobs` row directly (bypassing the events log). The sweep reads
 * `jobs` to decide who to probe, so seeding the projection is enough — the
 * subsequent `drainToCompletion` only needs to fold the synthetic Killed
 * events the sweep emits.
 */
function seedJobsRow(
  db: ReturnType<typeof openDb>["db"],
  jobId: string,
  pid: number | null,
  startTime: string | null,
  state = "stopped",
): void {
  db.run(
    `INSERT INTO jobs (job_id, created_at, cwd, pid, state, last_event_id,
                       updated_at, title, title_source, transcript_path, start_time)
       VALUES (?, ?, NULL, ?, ?, 0, ?, NULL, NULL, NULL, ?)`,
    [jobId, 0, pid, state, 0, startTime],
  );
}

/**
 * Find a pid that is definitely NOT in use right now. Starts from 999_990 and
 * walks downward — the OS pid space on macOS caps at 99_999 by default and on
 * Linux at 4_194_304; either way, a 6-digit pid above the live range is
 * essentially always free. Returns the first dead pid we land on; throws if
 * the loop somehow exhausts the search (impossibly contended host).
 */
function pickDeadPid(): number {
  for (let candidate = 999_990; candidate > 100_000; candidate -= 1) {
    if (!isPidAlive(candidate)) {
      return candidate;
    }
  }
  throw new Error("seed sweep test: could not find a dead pid");
}

test("seed sweep folds dead/recycled rows to killed; leaves alive+matching and legacy NULL alone", () => {
  const { db } = openDb(dbPath);

  // (a) alive matching pid+start_time → leave alone. We don't yet know the
  // OS-reported start_time for process.pid; the post-sweep assertion is just
  // that this row stayed `stopped` regardless (we re-use the same alive pid
  // for (b) below with a deliberately-wrong stored start_time, so any
  // recycle-fold would target (b) — not (a)).
  // We seed (a) with the SAME stored start_time we'll read off the OS below,
  // by reflecting the seed sweep's own producer logic: the sweep only emits
  // Killed when alive+stored differs from alive+OS-now. To make (a)
  // deterministically NOT fold, we set start_time=NULL and assert state stays
  // `stopped`. NOTE: that overlaps semantically with case (e), so we use a
  // distinct invariant: case (a) keeps a non-null start_time obtained from
  // the OS-now read so the match is true. The simplest seed: don't read the
  // OS at all — set start_time to a sentinel that NEVER matches, and the
  // expected outcome flips to "folded to killed". Instead we model (a) as
  // alive+stored=OS-now by piggy-backing on the producer: seed start_time
  // unknown, but use a known-alive pid with a sentinel that DOES match a
  // freshly-read OS value. We achieve that by reading the OS value here and
  // mirroring the seed-sweep's own reader contract via a same-process
  // platform probe.
  const alivePid = process.pid;
  // Read the OS start_time the SAME way the producer does (darwin: ps lstart,
  // linux: /proc stat). Re-using the producer parsers would be cleaner but
  // would tightly couple the test to the producer's import surface; the
  // duplication here is deliberate — the test asserts ROUND-TRIP equality
  // against a freshly-read OS value, which is the contract the sweep promises.
  function readOsStartTimeForTest(pid: number): string | null {
    if (process.platform === "darwin") {
      const result = Bun.spawnSync(
        ["ps", "-ww", "-p", String(pid), "-o", "lstart="],
        { timeout: 500 },
      );
      if (!result.success || result.exitCode !== 0) return null;
      const text = result.stdout?.toString().replace(/^\s+|\s+$/g, "") ?? "";
      if (text.length < 24) return null;
      return `darwin:${text.slice(0, 24)}`;
    }
    if (process.platform === "linux") {
      try {
        const { readFileSync } = require("node:fs") as typeof import("node:fs");
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const close = stat.lastIndexOf(")");
        if (close < 0) return null;
        const fields = stat
          .slice(close + 1)
          .trim()
          .split(/\s+/);
        const raw = fields[19];
        return raw && /^\d+$/.test(raw) ? `linux:${raw}` : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  const aliveStart = readOsStartTimeForTest(alivePid);
  // The test only runs the matching-row assertion when the platform probe
  // works — on a CI image with no `ps` or `/proc` access, case (a) collapses
  // to "we don't know the matching start_time" and we skip that arm. The
  // dead/recycled/legacy arms below remain valid regardless.
  if (aliveStart != null) {
    seedJobsRow(db, "sess-a-alive-matching", alivePid, aliveStart);
  }
  // (b) alive recycled — stored start_time deliberately wrong for the live pid.
  seedJobsRow(
    db,
    "sess-b-alive-recycled",
    alivePid,
    "darwin:Wed Jan 01 00:00:00 1970",
  );
  // (c) dead pid with stored start_time → Killed regardless.
  const deadPid = pickDeadPid();
  seedJobsRow(
    db,
    "sess-c-dead-with-start",
    deadPid,
    "darwin:Wed Jan 01 00:00:00 1970",
  );
  // (d) dead pid no start_time → Killed (Q7 dead-pid rule).
  seedJobsRow(db, "sess-d-dead-no-start", deadPid, null);
  // (e) alive pid, no start_time (legacy / pre-schema-v9) → leave alone.
  seedJobsRow(db, "sess-e-alive-legacy", alivePid, null);

  // Run the sweep + drain (the same `sweep → drain` pair the daemon's boot
  // sequence runs).
  seedKilledSweep(db);
  drainToCompletion(db);

  function stateOf(jobId: string): string | undefined {
    const row = db
      .query("SELECT state FROM jobs WHERE job_id = ?")
      .get(jobId) as { state: string } | null;
    return row?.state;
  }

  // (b),(c),(d) → killed.
  expect(stateOf("sess-b-alive-recycled")).toBe("killed");
  expect(stateOf("sess-c-dead-with-start")).toBe("killed");
  expect(stateOf("sess-d-dead-no-start")).toBe("killed");
  // (e) legacy → unchanged.
  expect(stateOf("sess-e-alive-legacy")).toBe("stopped");
  // (a) alive matching → unchanged (when the platform probe was available).
  if (aliveStart != null) {
    expect(stateOf("sess-a-alive-matching")).toBe("stopped");
  }

  db.close();
});

test("seed sweep is idempotent — a second sweep emits no duplicate Killed events", () => {
  const { db } = freshMemDb();

  const deadPid = pickDeadPid();
  seedJobsRow(db, "sess-zombie", deadPid, null);

  // First sweep: should emit ONE Killed event and fold to `killed`.
  seedKilledSweep(db);
  drainToCompletion(db);
  expect(
    (
      db.query("SELECT state FROM jobs WHERE job_id = 'sess-zombie'").get() as {
        state: string;
      }
    ).state,
  ).toBe("killed");
  const firstKilledCount = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM events WHERE hook_event = 'Killed' AND session_id = 'sess-zombie'",
      )
      .get() as { n: number }
  ).n;
  expect(firstKilledCount).toBe(1);

  // Second sweep: the row is now `killed` (terminal), so it's outside the
  // candidate query (`state IN ('working','stopped')`) and the sweep emits
  // NOTHING for it. This is the idempotency guarantee — we don't churn the
  // event log on every boot for already-killed sessions.
  seedKilledSweep(db);
  drainToCompletion(db);
  const secondKilledCount = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM events WHERE hook_event = 'Killed' AND session_id = 'sess-zombie'",
      )
      .get() as { n: number }
  ).n;
  expect(secondKilledCount).toBe(1);

  db.close();
});

test("seed sweep ignores terminal rows (ended, killed) — incl. NULL-pid ones", () => {
  const { db } = freshMemDb();

  const deadPid = pickDeadPid();
  // Terminal states are out of scope per the candidate query — even with a
  // NULL pid (a terminal NULL-pid row stays put; the fn-743 reap is for
  // NON-terminal NULL-pid rows only).
  seedJobsRow(db, "sess-ended", deadPid, null, "ended");
  seedJobsRow(db, "sess-already-killed", deadPid, null, "killed");
  seedJobsRow(db, "sess-no-pid-ended", null, null, "ended");

  seedKilledSweep(db);
  drainToCompletion(db);

  // None of these should have had a Killed event emitted against them.
  const killedCount = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM events WHERE hook_event = 'Killed' AND session_id IN ('sess-ended','sess-already-killed','sess-no-pid-ended')",
      )
      .get() as { n: number }
  ).n;
  expect(killedCount).toBe(0);

  // States preserved.
  function stateOf(jobId: string): string {
    return (
      db.query("SELECT state FROM jobs WHERE job_id = ?").get(jobId) as {
        state: string;
      }
    ).state;
  }
  expect(stateOf("sess-ended")).toBe("ended");
  expect(stateOf("sess-already-killed")).toBe("killed");
  expect(stateOf("sess-no-pid-ended")).toBe("ended");

  db.close();
});

test("fn-743 seed sweep: a NON-terminal NULL-pid (stopped) row IS reaped to killed", () => {
  // The stuck-`stopped` incident (2026-06-08): a NULL-pid stopped row is
  // unwatchable (exit-watcher's old `pid IS NOT NULL` filter never armed it)
  // and unprobeable, so it lived forever. The sweep now reaps it via a pidless
  // Killed. Default state for `seedJobsRow` is `stopped`.
  const { db } = freshMemDb();
  seedJobsRow(db, "sess-no-pid", null, null);

  seedKilledSweep(db);
  drainToCompletion(db);

  const killedCount = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM events WHERE hook_event = 'Killed' AND session_id = 'sess-no-pid'",
      )
      .get() as { n: number }
  ).n;
  expect(killedCount).toBe(1);
  const state = (
    db.query("SELECT state FROM jobs WHERE job_id = 'sess-no-pid'").get() as {
      state: string;
    }
  ).state;
  expect(state).toBe("killed");

  db.close();
});

// ---------------------------------------------------------------------------
// recoverOneDeadLetter (fn-643 task .4 — the replay transaction)
// ---------------------------------------------------------------------------

/**
 * Insert one dead-letter row in the `waiting` state. Mirrors what
 * `scanDeadLetterDir` would have written from a parsed NDJSON record. Each
 * test that needs more rows calls this multiple times — write-time keys
 * `(dl_written_at, dl_id)` drive the oldest-first replay pick.
 */
function seedDeadLetter(
  db: ReturnType<typeof openDb>["db"],
  opts: {
    dl_id: string;
    session_id: string;
    hook_event: string;
    ts: number;
    dl_written_at: number;
    pid?: number | null;
    bindings: Record<string, unknown>;
    source_file?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO dead_letters
       (dl_id, session_id, hook_event, ts, dl_written_at, pid, bindings,
        status, recovered_at, replayed_event_id, source_file)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', NULL, NULL, ?)`,
  ).run(
    opts.dl_id,
    opts.session_id,
    opts.hook_event,
    opts.ts,
    opts.dl_written_at,
    opts.pid ?? null,
    JSON.stringify(opts.bindings),
    opts.source_file ?? null,
  );
}

test("recoverOneDeadLetter appends a real events row + flips dead_letters to recovered, in one transaction", () => {
  const { db } = freshMemDb();
  // Seed one SessionStart dead-letter — the dropped-incident scenario.
  seedDeadLetter(db, {
    dl_id: "dl-aaa",
    session_id: "sess-recovered",
    hook_event: "SessionStart",
    ts: 1_700_000_000,
    dl_written_at: 1_700_000_001,
    pid: 4242,
    bindings: {
      ts: 1_700_000_000,
      session_id: "sess-recovered",
      pid: 4242,
      hook_event: "SessionStart",
      event_type: "lifecycle",
      data: JSON.stringify({}),
      cwd: "/tmp/foo",
      spawn_name: "agent-x",
      start_time: "darwin:Mon Jan  1 00:00:00 2026",
      config_dir: null,
    },
  });

  const eventsBefore = (
    db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }
  ).n;

  const dlId = recoverOneDeadLetter(db);
  expect(dlId).toBe("dl-aaa");

  // A real events row landed, carrying the stored bindings verbatim.
  const eventsAfter = (
    db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }
  ).n;
  expect(eventsAfter).toBe(eventsBefore + 1);
  const replayed = db
    .query(
      `SELECT id, session_id, hook_event, pid, cwd, spawn_name, start_time, ts
         FROM events WHERE session_id = 'sess-recovered'`,
    )
    .get() as {
    id: number;
    session_id: string;
    hook_event: string;
    pid: number | null;
    cwd: string | null;
    spawn_name: string | null;
    start_time: string | null;
    ts: number;
  };
  expect(replayed.hook_event).toBe("SessionStart");
  expect(replayed.pid).toBe(4242);
  expect(replayed.cwd).toBe("/tmp/foo");
  expect(replayed.spawn_name).toBe("agent-x");
  expect(replayed.start_time).toBe("darwin:Mon Jan  1 00:00:00 2026");
  // ts preserved verbatim (NOT stamped to Date.now()/1000 — this is a real
  // event with the original wall-clock time).
  expect(replayed.ts).toBe(1_700_000_000);

  // Dead-letter row flipped to recovered with the captured event id.
  const dlRow = db
    .query(
      `SELECT status, recovered_at, replayed_event_id FROM dead_letters WHERE dl_id = 'dl-aaa'`,
    )
    .get() as {
    status: string;
    recovered_at: number;
    replayed_event_id: number;
  };
  expect(dlRow.status).toBe("recovered");
  expect(dlRow.replayed_event_id).toBe(replayed.id);
  expect(typeof dlRow.recovered_at).toBe("number");
  expect(dlRow.recovered_at).toBeGreaterThan(0);

  db.close();
});

test("recoverOneDeadLetter folded by the reducer → jobs row appears for the recovered session", () => {
  const { db } = freshMemDb();
  seedDeadLetter(db, {
    dl_id: "dl-bbb",
    session_id: "sess-folded",
    hook_event: "SessionStart",
    ts: 1_700_000_010,
    dl_written_at: 1_700_000_011,
    pid: 9999,
    bindings: {
      ts: 1_700_000_010,
      session_id: "sess-folded",
      pid: 9999,
      hook_event: "SessionStart",
      event_type: "lifecycle",
      data: JSON.stringify({}),
      cwd: "/work",
    },
  });

  // No jobs row yet — the SessionStart was dropped before this test ran.
  const before = db
    .query("SELECT COUNT(*) AS n FROM jobs WHERE job_id = 'sess-folded'")
    .get() as { n: number };
  expect(before.n).toBe(0);

  expect(recoverOneDeadLetter(db)).toBe("dl-bbb");

  // Drain folds the appended event into the projection.
  drainToCompletion(db);

  const after = db
    .query("SELECT job_id, state, cwd FROM jobs WHERE job_id = 'sess-folded'")
    .get() as { job_id: string; state: string; cwd: string };
  expect(after.job_id).toBe("sess-folded");
  // The reducer's SessionStart fold seeds a row in 'stopped' state — the
  // session would flip to 'working' on the next UserPromptSubmit. Replaying
  // just the dropped SessionStart resurrects the row, which is the whole
  // point of the recovery (the row appears on the board where it was
  // invisible before).
  expect(after.state).toBe("stopped");
  expect(after.cwd).toBe("/work");

  db.close();
});

test("recoverOneDeadLetter picks the OLDEST waiting row, ordered by (dl_written_at ASC, dl_id ASC)", () => {
  const { db } = freshMemDb();
  // Three rows; the middle write_at is the oldest by dl_written_at, and the
  // dl_id tiebreaker resolves the dl_written_at tie deterministically.
  seedDeadLetter(db, {
    dl_id: "dl-2",
    session_id: "sess-2",
    hook_event: "SessionStart",
    ts: 1,
    dl_written_at: 200,
    bindings: {
      ts: 1,
      session_id: "sess-2",
      hook_event: "SessionStart",
      event_type: "lifecycle",
      data: "{}",
    },
  });
  seedDeadLetter(db, {
    dl_id: "dl-1a",
    session_id: "sess-1a",
    hook_event: "SessionStart",
    ts: 1,
    dl_written_at: 100,
    bindings: {
      ts: 1,
      session_id: "sess-1a",
      hook_event: "SessionStart",
      event_type: "lifecycle",
      data: "{}",
    },
  });
  seedDeadLetter(db, {
    dl_id: "dl-1b",
    session_id: "sess-1b",
    hook_event: "SessionStart",
    ts: 1,
    dl_written_at: 100,
    bindings: {
      ts: 1,
      session_id: "sess-1b",
      hook_event: "SessionStart",
      event_type: "lifecycle",
      data: "{}",
    },
  });

  // Oldest by dl_written_at (100) with the smallest dl_id ('dl-1a') wins.
  expect(recoverOneDeadLetter(db)).toBe("dl-1a");
  // Next oldest at dl_written_at=100 with dl_id 'dl-1b'.
  expect(recoverOneDeadLetter(db)).toBe("dl-1b");
  // Then the dl_written_at=200 row.
  expect(recoverOneDeadLetter(db)).toBe("dl-2");
  // No more waiting rows.
  expect(recoverOneDeadLetter(db)).toBeNull();

  db.close();
});

test("recoverOneDeadLetter on empty backlog returns null and writes nothing", () => {
  const { db } = freshMemDb();
  const eventsBefore = (
    db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }
  ).n;
  expect(recoverOneDeadLetter(db)).toBeNull();
  const eventsAfter = (
    db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }
  ).n;
  expect(eventsAfter).toBe(eventsBefore);
  db.close();
});

test("recoverOneDeadLetter rolls back the events INSERT on malformed bindings; row stays waiting", () => {
  const { db } = freshMemDb();
  // Hand-write a row with garbage `bindings` JSON (bypassing
  // parseDeadLetterLine which would have rejected it on the import path).
  db.prepare(
    `INSERT INTO dead_letters
       (dl_id, session_id, hook_event, ts, dl_written_at, pid, bindings,
        status, recovered_at, replayed_event_id, source_file)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', NULL, NULL, NULL)`,
  ).run("dl-bad", "sess-bad", "SessionStart", 1, 1, null, "this is not json");

  const eventsBefore = (
    db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }
  ).n;
  expect(() => recoverOneDeadLetter(db)).toThrow(/bindings JSON parse failed/);
  // Transaction rolled back: no events row, dead-letter row still waiting.
  const eventsAfter = (
    db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }
  ).n;
  expect(eventsAfter).toBe(eventsBefore);
  const dlRow = db
    .query("SELECT status FROM dead_letters WHERE dl_id = 'dl-bad'")
    .get() as { status: string };
  expect(dlRow.status).toBe("waiting");
  db.close();
});

test("recoverOneDeadLetter forward-compat: unknown columns in bindings are dropped, known ones bind", () => {
  const { db } = freshMemDb();
  seedDeadLetter(db, {
    dl_id: "dl-fwd",
    session_id: "sess-fwd",
    hook_event: "SessionStart",
    ts: 5,
    dl_written_at: 5,
    bindings: {
      ts: 5,
      session_id: "sess-fwd",
      hook_event: "SessionStart",
      event_type: "lifecycle",
      data: "{}",
      // A column from a hypothetical future schema — dropped on replay.
      future_column_v99: "should-be-ignored",
    },
  });
  expect(recoverOneDeadLetter(db)).toBe("dl-fwd");
  const row = db
    .query(
      "SELECT session_id, hook_event FROM events WHERE session_id = 'sess-fwd'",
    )
    .get() as { session_id: string; hook_event: string };
  expect(row.session_id).toBe("sess-fwd");
  expect(row.hook_event).toBe("SessionStart");
  db.close();
});

test("recoverOneDeadLetter skips rows already in `recovered` status (idempotency under re-invocation)", () => {
  const { db } = freshMemDb();
  seedDeadLetter(db, {
    dl_id: "dl-once",
    session_id: "sess-once",
    hook_event: "SessionStart",
    ts: 1,
    dl_written_at: 1,
    bindings: {
      ts: 1,
      session_id: "sess-once",
      hook_event: "SessionStart",
      event_type: "lifecycle",
      data: "{}",
    },
  });
  expect(recoverOneDeadLetter(db)).toBe("dl-once");
  // A second invocation sees zero waiting rows — the same dl_id never
  // recovers twice.
  expect(recoverOneDeadLetter(db)).toBeNull();
  db.close();
});

test("recoverOneDeadLetter does NOT touch dead_letters on a re-fold (the row survives DELETE FROM jobs+epics)", () => {
  // Re-fold determinism invariant (CLAUDE.md "DO NOT" — dead_letters is an
  // operational sidecar, NEVER a fold target). Recover, then simulate a
  // from-scratch re-fold: zero the cursor + delete projections + re-drain.
  // dead_letters row must survive byte-identically.
  const { db } = freshMemDb();
  seedDeadLetter(db, {
    dl_id: "dl-refold",
    session_id: "sess-refold",
    hook_event: "SessionStart",
    ts: 7,
    dl_written_at: 7,
    bindings: {
      ts: 7,
      session_id: "sess-refold",
      hook_event: "SessionStart",
      event_type: "lifecycle",
      data: "{}",
    },
  });
  expect(recoverOneDeadLetter(db)).toBe("dl-refold");
  drainToCompletion(db);

  const dlBefore = db
    .query("SELECT * FROM dead_letters WHERE dl_id = 'dl-refold'")
    .get() as Record<string, unknown>;

  // Simulate a from-scratch re-fold.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  drainToCompletion(db);

  const dlAfter = db
    .query("SELECT * FROM dead_letters WHERE dl_id = 'dl-refold'")
    .get() as Record<string, unknown>;
  expect(dlAfter).toEqual(dlBefore);
  // The re-fold reproduced the jobs row from the events log.
  const job = db
    .query("SELECT state FROM jobs WHERE job_id = 'sess-refold'")
    .get() as { state: string };
  // The reducer's SessionStart fold seeds a row in 'stopped' state (the
  // initial state — the row flips to 'working' only on the next
  // UserPromptSubmit). Replaying just the SessionStart resurrects the row;
  // the rest of the session lifecycle would arrive via subsequent events
  // if any were dead-lettered alongside (out of scope for v1 — replay is
  // one record at a time, and a partial recovery is still strictly better
  // than the row never appearing on the board).
  expect(job.state).toBe("stopped");
  db.close();
});

// ---------------------------------------------------------------------------
// pruneRecoveredDeadLetters (fn-1051 task .2 — resurrection-safe retention)
// ---------------------------------------------------------------------------

/**
 * Insert one `dead_letters` row in an arbitrary lifecycle state — the recovered
 * / poison seeds the retention prune consumes (`seedDeadLetter` only ever writes
 * `waiting`). `bindings` is irrelevant to the prune, so a fixed `'{}'` suffices.
 */
function seedDlRow(
  db: ReturnType<typeof openDb>["db"],
  opts: {
    dl_id: string;
    status: "waiting" | "recovered" | "poison";
    dl_written_at: number;
    recovered_at?: number | null;
    source_file?: string | null;
    pid?: number | null;
  },
): void {
  db.prepare(
    `INSERT INTO dead_letters
       (dl_id, session_id, hook_event, ts, dl_written_at, pid, bindings,
        status, recovered_at, replayed_event_id, source_file)
     VALUES (?, 'sess', 'PreToolUse', ?, ?, ?, '{}', ?, ?, NULL, ?)`,
  ).run(
    opts.dl_id,
    opts.dl_written_at,
    opts.dl_written_at,
    opts.pid ?? null,
    opts.status,
    opts.recovered_at ?? null,
    opts.source_file ?? null,
  );
}

const PROBE_DEAD = (): boolean => false; // sealed: writing pid is gone
const PROBE_ALIVE = (): boolean => true; // unsealed: writing pid still running
const DL_NOW_MS = 2_000_000_000_000;
// One day PAST the cutoff (unix seconds — the stored unit).
const DL_AGED_SEC = DL_NOW_MS / 1000 - DEAD_LETTER_RETENTION_MS / 1000 - 86_400;
// One hour ago — comfortably INSIDE the retention window.
const DL_FRESH_SEC = DL_NOW_MS / 1000 - 3_600;

function dlCount(db: ReturnType<typeof openDb>["db"]): number {
  return (
    db.query("SELECT COUNT(*) AS n FROM dead_letters").get() as { n: number }
  ).n;
}

test("pruneRecoveredDeadLetters: fully-recovered aged SEALED file → file unlinked + its rows deleted", () => {
  const { db } = freshMemDb();
  const dir = mkdtempSync(join(tmpDir, "dl-"));
  const file = join(dir, "4242.ndjson");
  writeFileSync(file, "line-a\nline-b\n");
  seedDlRow(db, {
    dl_id: "r1",
    status: "recovered",
    dl_written_at: DL_AGED_SEC,
    recovered_at: DL_AGED_SEC,
    source_file: file,
    pid: 4242,
  });
  seedDlRow(db, {
    dl_id: "r2",
    status: "recovered",
    dl_written_at: DL_AGED_SEC,
    recovered_at: DL_AGED_SEC,
    source_file: file,
    pid: 4242,
  });

  const res = pruneRecoveredDeadLetters(db, dir, {
    now: DL_NOW_MS,
    isPidAlive: PROBE_DEAD,
  });

  expect(res.prunedFiles).toBe(1);
  expect(res.prunedRows).toBe(2);
  expect(existsSync(file)).toBe(false);
  expect(dlCount(db)).toBe(0);
  db.close();
});

test("pruneRecoveredDeadLetters: a `waiting` row keeps its whole file inline (rows + file SACRED)", () => {
  const { db } = freshMemDb();
  const dir = mkdtempSync(join(tmpDir, "dl-"));
  const file = join(dir, "555.ndjson");
  writeFileSync(file, "x\n");
  seedDlRow(db, {
    dl_id: "w1",
    status: "waiting",
    dl_written_at: DL_AGED_SEC,
    source_file: file,
    pid: 555,
  });
  seedDlRow(db, {
    dl_id: "r1",
    status: "recovered",
    dl_written_at: DL_AGED_SEC,
    recovered_at: DL_AGED_SEC,
    source_file: file,
    pid: 555,
  });

  const res = pruneRecoveredDeadLetters(db, dir, {
    now: DL_NOW_MS,
    isPidAlive: PROBE_DEAD,
  });

  expect(res.prunedFiles).toBe(0);
  expect(res.prunedRows).toBe(0);
  expect(existsSync(file)).toBe(true);
  expect(dlCount(db)).toBe(2);
  db.close();
});

test("pruneRecoveredDeadLetters: a LIVE-pid file is skipped even when fully recovered + aged", () => {
  const { db } = freshMemDb();
  const dir = mkdtempSync(join(tmpDir, "dl-"));
  const file = join(dir, "888.ndjson");
  writeFileSync(file, "x\n");
  seedDlRow(db, {
    dl_id: "r1",
    status: "recovered",
    dl_written_at: DL_AGED_SEC,
    recovered_at: DL_AGED_SEC,
    source_file: file,
    pid: 888,
  });

  const res = pruneRecoveredDeadLetters(db, dir, {
    now: DL_NOW_MS,
    isPidAlive: PROBE_ALIVE,
  });

  expect(res.prunedFiles).toBe(0);
  expect(existsSync(file)).toBe(true);
  expect(dlCount(db)).toBe(1);
  db.close();
});

test("pruneRecoveredDeadLetters: poison rows age on dl_written_at (aged delete, fresh kept); events-log file NEVER unlinked", () => {
  const { db } = freshMemDb();
  const dlDir = mkdtempSync(join(tmpDir, "dl-"));
  const eventsLogDir = mkdtempSync(join(tmpDir, "el-"));
  const eventsLogFile = join(eventsLogDir, "777.ndjson");
  writeFileSync(eventsLogFile, "poison-bytes\n");
  // Poison rows point source_file at an events-log file (the ingester owns it).
  seedDlRow(db, {
    dl_id: "p-old",
    status: "poison",
    dl_written_at: DL_AGED_SEC,
    recovered_at: null,
    source_file: eventsLogFile,
    pid: 777,
  });
  seedDlRow(db, {
    dl_id: "p-new",
    status: "poison",
    dl_written_at: DL_FRESH_SEC,
    recovered_at: null,
    source_file: eventsLogFile,
    pid: 777,
  });

  const res = pruneRecoveredDeadLetters(db, dlDir, {
    now: DL_NOW_MS,
    isPidAlive: PROBE_DEAD,
  });

  expect(res.prunedRows).toBe(1);
  expect(res.prunedFiles).toBe(0);
  expect(existsSync(eventsLogFile)).toBe(true);
  const remaining = db.query("SELECT dl_id FROM dead_letters").all() as {
    dl_id: string;
  }[];
  expect(remaining.map((r) => r.dl_id)).toEqual(["p-new"]);
  db.close();
});

test("pruneRecoveredDeadLetters: recovered rows with source_file NULL age-prune by ROW (no file to resurrect them)", () => {
  const { db } = freshMemDb();
  const dir = mkdtempSync(join(tmpDir, "dl-"));
  seedDlRow(db, {
    dl_id: "n-old",
    status: "recovered",
    dl_written_at: DL_AGED_SEC,
    recovered_at: DL_AGED_SEC,
    source_file: null,
  });
  seedDlRow(db, {
    dl_id: "n-new",
    status: "recovered",
    dl_written_at: DL_FRESH_SEC,
    recovered_at: DL_FRESH_SEC,
    source_file: null,
  });

  const res = pruneRecoveredDeadLetters(db, dir, {
    now: DL_NOW_MS,
    isPidAlive: PROBE_DEAD,
  });

  expect(res.prunedRows).toBe(1);
  expect(res.prunedFiles).toBe(0);
  const remaining = db.query("SELECT dl_id FROM dead_letters").all() as {
    dl_id: string;
  }[];
  expect(remaining.map((r) => r.dl_id)).toEqual(["n-new"]);
  db.close();
});

test("pruneRecoveredDeadLetters: crash between unlink and delete → next pass sweeps the orphan rows (missing file is a no-op)", () => {
  const { db } = freshMemDb();
  const dir = mkdtempSync(join(tmpDir, "dl-"));
  const file = join(dir, "4242.ndjson");
  // The prior pass crashed AFTER unlink, BEFORE the row delete: the file is
  // already gone but the recovered rows survive. This pass must sweep them.
  seedDlRow(db, {
    dl_id: "r1",
    status: "recovered",
    dl_written_at: DL_AGED_SEC,
    recovered_at: DL_AGED_SEC,
    source_file: file,
    pid: 4242,
  });

  const res = pruneRecoveredDeadLetters(db, dir, {
    now: DL_NOW_MS,
    isPidAlive: PROBE_DEAD,
  });

  expect(res.prunedFiles).toBe(1);
  expect(res.prunedRows).toBe(1);
  expect(dlCount(db)).toBe(0);
  db.close();
});

test("pruneRecoveredDeadLetters: a fully-recovered file INSIDE the retention window is not pruned (age gate)", () => {
  const { db } = freshMemDb();
  const dir = mkdtempSync(join(tmpDir, "dl-"));
  const file = join(dir, "999.ndjson");
  writeFileSync(file, "x\n");
  seedDlRow(db, {
    dl_id: "r1",
    status: "recovered",
    dl_written_at: DL_FRESH_SEC,
    recovered_at: DL_FRESH_SEC,
    source_file: file,
    pid: 999,
  });

  const res = pruneRecoveredDeadLetters(db, dir, {
    now: DL_NOW_MS,
    isPidAlive: PROBE_DEAD,
  });

  expect(res.prunedFiles).toBe(0);
  expect(existsSync(file)).toBe(true);
  expect(dlCount(db)).toBe(1);
  db.close();
});

test("pruneRecoveredDeadLetters: a recovered source_file OUTSIDE the dead-letter dir is never unlinked (path scope) and its row survives", () => {
  const { db } = freshMemDb();
  const dir = mkdtempSync(join(tmpDir, "dl-"));
  const outside = mkdtempSync(join(tmpDir, "out-"));
  const strayFile = join(outside, "4242.ndjson");
  writeFileSync(strayFile, "x\n");
  seedDlRow(db, {
    dl_id: "r1",
    status: "recovered",
    dl_written_at: DL_AGED_SEC,
    recovered_at: DL_AGED_SEC,
    source_file: strayFile,
    pid: 4242,
  });

  const res = pruneRecoveredDeadLetters(db, dir, {
    now: DL_NOW_MS,
    isPidAlive: PROBE_DEAD,
  });

  expect(res.prunedFiles).toBe(0);
  // Path scope kept the unlink inside `dir`; the row stays too (deleting it while
  // its file survives would resurrect it on the next scan).
  expect(existsSync(strayFile)).toBe(true);
  expect(dlCount(db)).toBe(1);
  db.close();
});

// ---------------------------------------------------------------------------
// fn-739 task .1 — backlog-drain: end-to-end scan→replay re-fold parity, and
// the torn-tail scan-skip. The earlier `recoverOneDeadLetter` block seeds the
// `dead_letters` row directly; these two drive the FULL on-disk NDJSON path
// (`scanDeadLetterDir` import → `recoverOneDeadLetter` replay) so the file
// import + idempotency + torn-tail contracts are exercised together.
// ---------------------------------------------------------------------------

test("scan→replay re-fold parity: a record imported from an NDJSON file folds byte-identically to a directly-landed event", () => {
  // Bindings the hook would have written had its INSERT not been dropped — a
  // full SessionStart binding incl. the SessionStart-scraped fields.
  const bindings = {
    ts: 1_700_000_500,
    session_id: "sess-parity",
    pid: 4242,
    hook_event: "SessionStart",
    event_type: "lifecycle",
    data: "{}",
    cwd: "/tmp/parity",
    permission_mode: null,
    spawn_name: "agent-parity",
    start_time: "darwin:Mon Jan  1 00:00:00 2026",
    config_dir: null,
  };

  // (A) Directly-landed reference: INSERT the same bindings straight into
  // `events` and fold — this is what the hook's original INSERT would have
  // produced.
  const { db: refDb } = freshMemDb();
  const refCols = Object.keys(bindings);
  refDb.run(
    `INSERT INTO events (${refCols.join(", ")}) VALUES (${refCols.map(() => "?").join(", ")})`,
    refCols.map(
      (c) => (bindings as Record<string, unknown>)[c] as string | number | null,
    ),
  );
  drainToCompletion(refDb);
  const refJob = refDb
    .query("SELECT * FROM jobs WHERE job_id = 'sess-parity'")
    .get() as Record<string, unknown>;
  refDb.close();

  // (B) Replayed path: write the record to an on-disk per-pid NDJSON file,
  // import via `scanDeadLetterDir`, replay via `recoverOneDeadLetter`, fold.
  const { db } = freshMemDb();
  const dlDir = join(tmpDir, "dead-letters");
  mkdirSync(dlDir, { recursive: true });
  writeFileSync(
    join(dlDir, "4242.ndjson"),
    serializeDeadLetterRecord({
      dl_id: "dl-parity",
      session_id: "sess-parity",
      hook_event: "SessionStart",
      ts: 1_700_000_500,
      dl_written_at: 1_700_000_501,
      pid: 4242,
      bindings,
    }),
  );
  scanDeadLetterDir(db, dlDir);
  expect(recoverOneDeadLetter(db)).toBe("dl-parity");
  drainToCompletion(db);
  const job = db
    .query("SELECT * FROM jobs WHERE job_id = 'sess-parity'")
    .get() as Record<string, unknown>;

  // The replayed-path projection row is byte-identical to the directly-landed
  // one — the re-fold determinism invariant holds through the replay path.
  expect(job).toEqual(refJob);
  db.close();
});

test("scan→replay idempotency: importing + replaying twice yields exactly one events row (no dup on re-run)", () => {
  const { db } = freshMemDb();
  const dlDir = join(tmpDir, "dead-letters");
  mkdirSync(dlDir, { recursive: true });
  const line = serializeDeadLetterRecord({
    dl_id: "dl-idem",
    session_id: "sess-idem",
    hook_event: "SessionStart",
    ts: 9,
    dl_written_at: 9,
    pid: 7,
    bindings: {
      ts: 9,
      session_id: "sess-idem",
      hook_event: "SessionStart",
      event_type: "lifecycle",
      data: "{}",
    },
  });
  writeFileSync(join(dlDir, "7.ndjson"), line);

  // First drain: import (INSERT OR IGNORE on dl_id) + replay.
  scanDeadLetterDir(db, dlDir);
  expect(recoverOneDeadLetter(db)).toBe("dl-idem");

  // Re-run the WHOLE path (file still on disk — as it is in production until a
  // cleanup pass moves it): the re-scan's INSERT OR IGNORE is a no-op on the
  // existing dl_id, and the row is already `recovered` so replay skips it.
  scanDeadLetterDir(db, dlDir);
  expect(recoverOneDeadLetter(db)).toBeNull();

  // Exactly one events row for the session — no duplicate.
  const n = (
    db
      .query("SELECT COUNT(*) AS n FROM events WHERE session_id = 'sess-idem'")
      .get() as { n: number }
  ).n;
  expect(n).toBe(1);
  db.close();
});

test("scanDeadLetterDir skips a torn final line — the partial record is never imported or replayed", () => {
  const { db } = freshMemDb();
  const dlDir = join(tmpDir, "dead-letters");
  mkdirSync(dlDir, { recursive: true });

  const whole = serializeDeadLetterRecord({
    dl_id: "dl-whole",
    session_id: "sess-whole",
    hook_event: "SessionStart",
    ts: 1,
    dl_written_at: 1,
    pid: 1,
    bindings: {
      ts: 1,
      session_id: "sess-whole",
      hook_event: "SessionStart",
      event_type: "lifecycle",
      data: "{}",
    },
  });
  // A second record truncated mid-write (no trailing newline, JSON cut off) —
  // exactly what a killed hook process leaves behind.
  const torn = '{"dl_id":"dl-torn","session_id":"sess-torn","hook_eve';
  writeFileSync(join(dlDir, "1.ndjson"), whole + torn);

  scanDeadLetterDir(db, dlDir);

  // Only the whole record imported; the torn tail produced no row.
  const ids = (
    db.query("SELECT dl_id FROM dead_letters ORDER BY dl_id").all() as {
      dl_id: string;
    }[]
  ).map((r) => r.dl_id);
  expect(ids).toEqual(["dl-whole"]);

  // And replay drains only the whole one; the torn record never replays.
  expect(recoverOneDeadLetter(db)).toBe("dl-whole");
  expect(recoverOneDeadLetter(db)).toBeNull();
  expect(
    (
      db
        .query(
          "SELECT COUNT(*) AS n FROM events WHERE session_id = 'sess-torn'",
        )
        .get() as { n: number }
    ).n,
  ).toBe(0);
  db.close();
});

// ---------------------------------------------------------------------------
// fn-740 task .1 — archive-recovered-dead-letters.ts eligibility gate. F2 from
// the fn-739 audit: the script's DATA-SAFETY CONTRACT (allConfirmed gate,
// ids.length===0 early-exit, recovered-but-no-replayed_event_id exclusion, and
// the --apply move) had zero direct coverage. These four tests drive the real
// script as a subprocess against a sandboxed KEEPER_DB + KEEPER_DEAD_LETTER_DIR
// and assert on whether the on-disk file is moved to archive/ or left in place.
// ---------------------------------------------------------------------------

const ARCHIVE_SCRIPT = join(
  import.meta.dir,
  "..",
  "scripts",
  "archive-recovered-dead-letters.ts",
);

/**
 * Insert a `recovered` dead_letters row AND its landed `events` row so the
 * script's `confirmed` set (status='recovered' AND replayed_event_id IS NOT
 * NULL AND that events row EXISTS) includes this dl_id. Returns the dl_id.
 */
function seedConfirmedRecovered(
  db: ReturnType<typeof openDb>["db"],
  dlId: string,
  sessionId: string,
): void {
  const info = db
    .prepare(
      `INSERT INTO events (ts, session_id, hook_event, event_type, data)
       VALUES (?, ?, 'SessionStart', 'lifecycle', '{}')`,
    )
    .run(1, sessionId);
  db.prepare(
    `INSERT INTO dead_letters
       (dl_id, session_id, hook_event, ts, dl_written_at, pid, bindings,
        status, recovered_at, replayed_event_id, source_file)
     VALUES (?, ?, 'SessionStart', 1, 1, 1, '{}', 'recovered', 1, ?, NULL)`,
  ).run(dlId, sessionId, info.lastInsertRowid as number);
}

/** Seed a `waiting` (not-yet-recovered) dead_letters row — no events row. */
function seedWaiting(
  db: ReturnType<typeof openDb>["db"],
  dlId: string,
  sessionId: string,
): void {
  db.prepare(
    `INSERT INTO dead_letters
       (dl_id, session_id, hook_event, ts, dl_written_at, pid, bindings,
        status, recovered_at, replayed_event_id, source_file)
     VALUES (?, ?, 'SessionStart', 1, 1, 1, '{}', 'waiting', NULL, NULL, NULL)`,
  ).run(dlId, sessionId);
}

/** Serialize one NDJSON line carrying just the dl_id the script keys on. */
function dlLine(dlId: string, sessionId: string): string {
  return serializeDeadLetterRecord({
    dl_id: dlId,
    session_id: sessionId,
    hook_event: "SessionStart",
    ts: 1,
    dl_written_at: 1,
    pid: 1,
    bindings: {
      ts: 1,
      session_id: sessionId,
      hook_event: "SessionStart",
      event_type: "lifecycle",
      data: "{}",
    },
  });
}

/** Run the archive script as a subprocess against the sandboxed DB + dl dir. */
function runArchiveScript(args: string[] = []): void {
  const proc = Bun.spawnSync(["bun", ARCHIVE_SCRIPT, ...args], {
    env: sandboxEnv({ tmpDir, dbPath }),
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `archive script exited ${proc.exitCode}: ${proc.stderr.toString()}`,
    );
  }
}

test("archive eligibility: a file with one still-waiting record is left in place (allConfirmed gate fires)", () => {
  // The DB must exist + be migrated before the read-only script opens it.
  openDb(dbPath).db.close();
  const { db } = openDb(dbPath);
  // One confirmed-recovered record and one still-waiting record share a file.
  seedConfirmedRecovered(db, "dl-ok", "sess-ok");
  seedWaiting(db, "dl-wait", "sess-wait");
  db.close();

  const dlDir = join(tmpDir, "dead-letters");
  mkdirSync(dlDir, { recursive: true });
  const file = join(dlDir, "mixed.ndjson");
  writeFileSync(
    file,
    dlLine("dl-ok", "sess-ok") + dlLine("dl-wait", "sess-wait"),
  );

  runArchiveScript(["--apply"]);

  // allConfirmed === false (the waiting record is not in `confirmed`) → the
  // whole file stays, never archived on a guess.
  expect(existsSync(file)).toBe(true);
  expect(existsSync(join(dlDir, "archive", "mixed.ndjson"))).toBe(false);
});

test("archive eligibility: a recovered record with no replayed_event_id is excluded; the file stays", () => {
  openDb(dbPath).db.close();
  const { db } = openDb(dbPath);
  // Status flipped to `recovered` but replayed_event_id never stamped (the
  // should-never-happen case). The script's `EXISTS` SELECT excludes it from
  // `confirmed`, so allConfirmed fires false.
  db.prepare(
    `INSERT INTO dead_letters
       (dl_id, session_id, hook_event, ts, dl_written_at, pid, bindings,
        status, recovered_at, replayed_event_id, source_file)
     VALUES ('dl-noid', 'sess-noid', 'SessionStart', 1, 1, 1, '{}',
             'recovered', 1, NULL, NULL)`,
  ).run();
  db.close();

  const dlDir = join(tmpDir, "dead-letters");
  mkdirSync(dlDir, { recursive: true });
  const file = join(dlDir, "noid.ndjson");
  writeFileSync(file, dlLine("dl-noid", "sess-noid"));

  runArchiveScript(["--apply"]);

  expect(existsSync(file)).toBe(true);
  expect(existsSync(join(dlDir, "archive", "noid.ndjson"))).toBe(false);
});

test("archive eligibility: an all-torn file (ids.length === 0) is left untouched", () => {
  openDb(dbPath).db.close();

  const dlDir = join(tmpDir, "dead-letters");
  mkdirSync(dlDir, { recursive: true });
  const file = join(dlDir, "torn.ndjson");
  // Every line is unparseable garbage — no recoverable record. parseDeadLetterLine
  // returns null for each → ids stays empty → the file is not archived (nothing
  // to confirm landed).
  writeFileSync(file, "not json\n{bad\n");

  runArchiveScript(["--apply"]);

  expect(existsSync(file)).toBe(true);
  expect(existsSync(join(dlDir, "archive", "torn.ndjson"))).toBe(false);
});

test("archive eligibility: --apply moves a fully-confirmed file to the archive/ subdir", () => {
  openDb(dbPath).db.close();
  const { db } = openDb(dbPath);
  seedConfirmedRecovered(db, "dl-a", "sess-a");
  seedConfirmedRecovered(db, "dl-b", "sess-b");
  db.close();

  const dlDir = join(tmpDir, "dead-letters");
  mkdirSync(dlDir, { recursive: true });
  const file = join(dlDir, "done.ndjson");
  writeFileSync(file, dlLine("dl-a", "sess-a") + dlLine("dl-b", "sess-b"));

  // Dry run first: every record is confirmed, but without --apply the file
  // stays put (only reported).
  runArchiveScript();
  expect(existsSync(file)).toBe(true);
  expect(existsSync(join(dlDir, "archive", "done.ndjson"))).toBe(false);

  // --apply moves the eligible file into archive/.
  runArchiveScript(["--apply"]);
  expect(existsSync(file)).toBe(false);
  expect(existsSync(join(dlDir, "archive", "done.ndjson"))).toBe(true);
});

test("fn-1024: serializeSessionTelemetry forwards the six telemetry fields and drops kind/id", () => {
  const wire = JSON.parse(
    serializeSessionTelemetry({
      kind: "session-telemetry",
      id: "sess-xyz",
      model_id: "claude-opus-4-8",
      model_display: "Opus",
      effort: "high",
      used_percentage: 42.5,
      input_tokens: 85000,
      window_size: 200000,
    }),
  );
  expect(wire).toEqual({
    model_id: "claude-opus-4-8",
    model_display: "Opus",
    effort: "high",
    used_percentage: 42.5,
    input_tokens: 85000,
    window_size: 200000,
  });
  // `kind` is the event-tag discriminator; `id` rides in events.session_id.
  expect(wire.kind).toBeUndefined();
  expect(wire.id).toBeUndefined();
});

test("fn-1024: serializeSessionTelemetry ↔ extractSessionTelemetry round-trips the six fields (wire-shape aligned)", () => {
  // A full snapshot serialized by main and decoded by the reducer must recover
  // exactly the six projection fields — the two ends must never drift on key
  // names or the whole feature silently folds NULL.
  const data = serializeSessionTelemetry({
    kind: "session-telemetry",
    id: "sess-rt",
    model_id: "claude-sonnet-4-6",
    model_display: "Sonnet",
    effort: "medium",
    used_percentage: 7.25,
    input_tokens: 14500,
    window_size: 1000000,
  });
  const decoded = extractSessionTelemetry({
    id: 1,
    session_id: "sess-rt",
    data,
  } as Event);
  expect(decoded).toEqual({
    model_id: "claude-sonnet-4-6",
    model_display: "Sonnet",
    effort: "medium",
    used_percentage: 7.25,
    input_tokens: 14500,
    window_size: 1000000,
  });
});

// ---------------------------------------------------------------------------
// fn-678 task .3 — pending_dispatches TTL sweep (producer-side, 60s heartbeat)
// ---------------------------------------------------------------------------

/**
 * Insert a row directly into `pending_dispatches`. Bypasses the reducer
 * — fine for unit testing the sweep selector, which doesn't depend on
 * how the row arrived (the reducer's `foldDispatched` UPSERT path is
 * covered by `reducer.test.ts`).
 */
function seedPendingDispatch(
  db: ReturnType<typeof openDb>["db"],
  verb: string,
  id: string,
  dispatchedAtSec: number,
  dir: string | null = null,
  lastEventId = 1,
): void {
  db.run(
    `INSERT INTO pending_dispatches (verb, id, dir, dispatched_at, last_event_id)
       VALUES (?, ?, ?, ?, ?)`,
    [verb, id, dir, dispatchedAtSec, lastEventId],
  );
}

function seedDispatchFailure(
  db: ReturnType<typeof openDb>["db"],
  verb: string,
  id: string,
  tsSec: number,
): void {
  db.run(
    `INSERT INTO dispatch_failures (
       verb, id, reason, dir, ts, last_event_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [verb, id, "ceiling-elapsed", null, tsSec, 1, tsSec, tsSec],
  );
}

test("PENDING_DISPATCH_TTL_MS is 120s (>= 2x the documented 60s cold-start ceiling)", () => {
  // The constant defends the fn-627 double-dispatch invariant: a worker
  // mid-boot must NEVER be re-dispatched over. Documented cold start P99
  // is ~24-33s; 120s gives ~3-4x margin. A regression here would
  // re-create the hazard the projection exists to eliminate.
  expect(PENDING_DISPATCH_TTL_MS).toBe(120_000);
});

test("fn-724: SCHEMA_VERSION tracks the live schema (durable ack itself added no schema)", () => {
  // The fn-724 durable mint-before-launch + three-way outcome is entirely
  // a producer-side control-flow change: a new id-correlated
  // dispatched-request/ack on the main↔autopilot-worker channel and the
  // ceiling→indoubt emit suppression. The reducer arms
  // (foldDispatched / foldDispatchFailed / foldDispatchExpired) were
  // UNTOUCHED by fn-724 — no new event, no new column, no migration; it
  // landed against the fn-719 schema value (59).
  //
  // The schema has since LEGITIMATELY advanced — to 60 via fn-725 (the
  // max_concurrent_jobs cap snapshot), to 61 via fn-736 task .1 (the
  // `event_ingest_offsets` NDJSON→events ingest cursor), to 62 via fn-751
  // task .1 (the autopilot `mode` column + the `armed_epics` presence table),
  // to 63 via fn-756 task .2 (drop `epics.approval` + rewrite
  // `default_visible`), to 64 via fn-781 task .1 (the `builds` buildbot
  // dashboard projection table), to 65 via fn-784 task .1 (the folded
  // `jobs.active_since` recency column for the unified dash AGENTS timeline),
  // to 66 via fn-787 task .2 (the session-anchored partial index
  // `idx_events_pretooluse_agent_session` for the SubagentStart fold's
  // pending-PreToolUse bridge), to 67 via fn-807 task .2 (the
  // `commit_trailer_facts` projection table that de-blobs the commit-trailer
  // channel of `syncPlanLinks`), to 68 via fn-813 task .1 (the
  // `scheduled_tasks` projection table folding the CronCreate/CronDelete
  // PostToolUse pair onto the jobs surface), to 69 via fn-38 task .2 (the
  // `subagent_invocations.last_disposition` column feeding the SILENT_STREAM_CUT
  // drop detector), to 70 via fn-817 task .1 (the producer-stamped
  // `jobs.close_kind` column the DB-derived crash-restore set reads), to 71
  // via fn-817 task .2 (the folded `jobs.window_index` column carrying visual
  // window order for the DB-only crash-restore derivation), to 72 via
  // fn-826 task .1 (widening the `file_attributions.source` CHECK to accept the
  // renamed `'plan'` alongside legacy `'planctl'` — a row-preserving table
  // rebuild, no cursor rewind), to 73 via fn-836 task .2 (the additive
  // `events.mutation_path` column promoting the git-attribution fold's lone
  // cross-event field — instant ADD COLUMN, no rebuild, no cursor rewind), and to
  // 74 via fn-836 task .4 (the DESTRUCTIVE shed: restore keep-set bodies inline +
  // DROP `event_blobs` at the migration tail — no cursor rewind, projection
  // re-fold stays byte-identical), and to 75 via fn-831 task .1 (rewriting stored
  // `file_attributions.source='planctl'` rows to `'plan'` in lockstep with the
  // producer mint flip — in-transaction with the version stamp, no cursor rewind,
  // re-fold byte-identical), and to 76 via fn-846 task .1 (the never-bound
  // dispatch circuit breaker's additive `dispatch_never_bound` projection table —
  // CREATE-only, no cursor rewind, re-fold byte-identical), and to 77 via fn-856
  // task .1 (ungating the plan-link classifier from the `/plan:plan` time-window
  // model — the fold output changed, so the migration REWINDS the cursor and
  // wipes the canonical projection list to repopulate from the corrected derive,
  // re-fold byte-identical via the classifier's `(ts, event_id)` total order),
  // and to 78 via fn-864 task .1 (renaming the `plan_*` schema surface →
  // `plan_*` + rewriting historical `planctl_invocation` envelopes → forward —
  // value-preserving, NO cursor rewind, re-fold byte-identical across the
  // rename). And to 79 via fn-868 task .1 (the LIVE-ONLY git projection: a new
  // `git_projection_state` control singleton + skip-floor, additive table +
  // floor-raise, NO cursor rewind of the deterministic projections — the git
  // surface is carved out of the re-fold charter, the other ~16 stay
  // byte-identical). And to 80 via fn-881 task .1 (excluding the worker's `done`
  // and the closer's `close` op from the plan-link classifier — the fold output
  // changed, so the migration REWINDS the cursor and wipes the canonical
  // projection list to repopulate from the corrected derive, but RAISES the git
  // skip-floor instead of resetting it to 0 to keep the v79 git carve-out, so the
  // deterministic link projections re-fold byte-identically). And to 81 via fn-888
  // task .2 (converging `epics.job_links` under task .1's cheap per-session
  // `mergeJobLinkSlice` merge — the fold is byte-identical to the old per event, so
  // this rewind-and-redrain is a convergence + self-validation pass, mirroring v80's
  // rewind/wipe block exactly: cursor→0, deterministic projections wiped,
  // `commit_trailer_facts` preserved, git skip-floor RAISED not reset). And to 82
  // via fn-889 task .3 (retiring the last live `planctl` residue: rewriting the
  // historical Commit-event `events.data` keys `planctl_op`/`planctl_target` →
  // `plan_op`/`plan_target` + narrowing the `file_attributions.source` CHECK to
  // drop `'planctl'` — value-preserving, NO cursor rewind, `commit_trailer_facts`
  // re-folds byte-identical under the new keys). And to 83 via fn-907 task .1
  // (adding the `jobs.backend_exec_generation_id` + `backend_exec_birth_session_id`
  // columns + the `tmux_projection_state` live-only control singleton, flipping
  // `backend_exec_session_id` + `window_index` to LIVE-ONLY, and backfilling the
  // birth session from the frozen launch env — NO cursor rewind, the two columns
  // become boot-seeded/live so history is never re-folded for them). And to 84
  // via fn-924 task .1 (carrying the existing `jobs.active_since` fact on the
  // embedded `epics.jobs` element — a JSON-cell-only add, fix-forward: no column,
  // no rewind, absent ≡ null — so readiness's new `bound-pending` predicate holds
  // a freshly-bound `stopped` worker's root across the bind → first-activity
  // handoff). And to 85 via fn-936 task .1 (stripping the static priority/
  // ordering machinery — DROP `epics.sort_path` / `queue_jump` /
  // `created_by_closer_of` + `events.plan_queue_jump` via a table rebuild +
  // full rewind-and-redrain). And to 86 via fn-941 task .2 (adding the
  // `block_escalations` escalate-once latch projection table — comment-only
  // no-op, NO cursor rewind: the latch re-folds byte-identical from the
  // `TaskSnapshot` / `BlockEscalation*` stream). This pin tracks the LIVE schema
  // version: the guard it provides is "an accidental reducer/schema change must
  // surface as a failing whitelist + this pin", which still holds — bump both
  // together when the schema genuinely moves. And to 87 via fn-946 task .1
  // (adding the `handoffs` durable `keeper handoff` projection table — comment-
  // only no-op, NO cursor rewind: the projection re-folds byte-identical from
  // the `HandoffRequested` / dispatcher / bind stream, empty on a pre-feature
  // log). And to 88 via fn-946 task .2 (appending the `jobs.handoff_links`
  // column — an additive ALTER, NO cursor rewind: the `'[]'` default matches the
  // zero-event projection so a pre-feature log re-folds byte-identical). And to
  // 89 via fn-952 task .2 (adding the `tmux_client_focus` LIVE-ONLY client-focus
  // singleton — comment-only no-op, NO cursor rewind: no seed/floor, registered
  // in LIVE_ONLY_PROJECTIONS, so an empty log leaves the table empty and the
  // surface is excluded from the byte-identical re-fold charter). And to 90 via
  // fn-954 task .1 (appending the `autopilot_state.max_concurrent_per_root`
  // config column — an additive ALTER, NO cursor rewind: NULL = the in-memory
  // default, the fold never reads it, so a pre-feature log re-folds byte-identical).
  // And to 91 via fn-959 task .1 (appending the `autopilot_state.worktree_mode`
  // config column — an additive ALTER, NO cursor rewind: NULL = OFF, the fold
  // never reads it, so a pre-feature log re-folds byte-identical). And to 92 via
  // fn-977 task .2 (NULLing `backend_exec_pane_id` + `backend_exec_generation_id`
  // on existing terminal jobs so a dead job stops holding a tmux-recyclable pane
  // id that could be mis-attributed to a fresh window — a one-time version-guarded data-fix
  // UPDATE, NO cursor rewind: the pane column re-folds NULL for a terminal job
  // under the new terminal-clear fold arms and the generation column is live-only,
  // so the existing rows simply converge to what a re-fold would produce). And to
  // 93 via nullable codex-spark usage columns (additive ALTER, NO cursor rewind:
  // existing rows stay NULL until the next usage snapshot). And to 94 via fn-997
  // task .1 (appending the nullable `events.worktree` + `jobs.worktree` durable
  // lane-branch marker — an additive ALTER, NO cursor rewind: a pre-v94 event
  // carries no worktree value, so a from-scratch re-fold leaves `jobs.worktree`
  // NULL byte-identical). And to 95 via fn-1000 task .1 (appending the nullable
  // `usage.error_kind` failure-classification column — an additive ALTER, NO
  // cursor rewind: a pre-v95 event carries no `error_kind`, so a from-scratch
  // re-fold leaves the column NULL byte-identical). And to 96 via fn-1003 task .2
  // (appending the nullable `handoffs.target_dir` launch-directory column — an
  // additive ALTER, NO cursor rewind: a pre-v96 `HandoffRequested` event carries
  // no `target_dir`, so a from-scratch re-fold leaves the column NULL
  // byte-identical). And to 97 via fn-1007 task .1 (appending the nullable
  // `usage.account_state` account-axis column — an additive ALTER, NO cursor
  // rewind: a pre-v97 `UsageSnapshot` carries no `account_state`, so a
  // from-scratch re-fold leaves the column NULL byte-identical). And to 98 via
  // fn-1009 task .1 (appending the nullable `dispatch_failures.merge_escalated_at`
  // escalate-once marker for the daemon merge-escalation sweep — an additive
  // ALTER, NO cursor rewind: a pre-v98 stream carries no `MergeEscalationAttempted`
  // event, so a from-scratch re-fold leaves the column NULL byte-identical, and
  // `foldDispatchFailed` preserves it across the UPSERT). And to 99 via fn-1016
  // task .1 (the LIVE-ONLY `lane_merged` merge-landed observable — a CREATE-only
  // table registered in LIVE_ONLY_PROJECTIONS, NO cursor rewind: the merged verdict
  // is git-derived and re-emitted each cycle, so an empty log leaves the table
  // empty and the surface is excluded from the byte-identical re-fold charter).
  // And to 100 via fn-1024 task .1 (the six nullable per-session telemetry columns
  // on `jobs` — current model / reasoning effort / context-window usage projected
  // from the Claude Code statusLine payload; additive ALTERs, NO cursor rewind: a
  // pre-v100 stream carries no `SessionTelemetry` event, so a from-scratch re-fold
  // leaves the columns NULL byte-identical). And to 101 via fn-1034 task .1
  // (appending the nullable `autopilot_state.worktree_multi_repo` rollout flag for
  // multi-repo worktree epics — an additive ALTER, NO cursor rewind: the fold never
  // reads it, the reconciler resolves it `?? OFF`, so a from-scratch re-fold leaves
  // it NULL byte-identical). And to 102 via fn-1061 task .1 (the DURABLE producer-
  // owned `dispatch_mint_gate` table — the one-logical-dispatch-one-row rate-limit
  // gate at the `Dispatched` mint site; a CREATE-only table, NO cursor rewind:
  // producer state like `dead_letters`, never folded, so it is excluded from
  // `EPHEMERAL_PROJECTIONS`, the rewind DELETE list, and the byte-identical re-fold
  // charter, and an empty log leaves the table empty). And to 103 via fn-1075 task
  // .2 (appending the nullable `jobs.kill_reason` column — WHY keeper reaped a job,
  // the producer arm that minted the synthetic `Killed`; an additive ALTER folded
  // on as an opaque string copy, NO cursor rewind: a historical Killed carries no
  // `reason`, so a from-scratch re-fold leaves it NULL byte-identical). And to 104
  // via fn-1083 task .2 (appending the nullable `epics.question` column — the
  // epic-level parked-closer question folded from `EpicSnapshot.question`; an
  // additive ALTER, NO cursor rewind: a historical EpicSnapshot carries no
  // `question` key, so a from-scratch re-fold leaves it NULL byte-identical). And
  // to 105 via fn-1086 task .1 (the `dispatch_instant_death` reducer projection —
  // the instant-death circuit breaker's counter; a CREATE-only table, NO cursor
  // rewind: an existing DB gains the empty table and folds forward, and a
  // from-scratch re-fold replays the historical terminal events into it
  // byte-identical, a deterministic-replayed projection like `dispatch_never_bound`).
  // And to 106 via fn-1088 task .1 (appending the nullable
  // `dispatch_failures.resolver_dispatched_at` once-marker — the merge-resolver
  // dispatch latch, sibling of `merge_escalated_at`; an additive ALTER, NO cursor
  // rewind: a pre-v106 stream carries no `ResolverDispatchAttempted` event, so a
  // from-scratch re-fold leaves it NULL byte-identical). And to 107 via fn-1102
  // task .1 (adding the `events.tmux_generation_id` VIRTUAL generated column + the
  // partial covering index `idx_events_tmux_generation` the bounded
  // generation-summary walk seeks — the column re-derives from each row's `data`,
  // NO cursor rewind: a from-scratch re-fold recomputes it byte-identical). And to
  // 108 via fn-1107 task .1 (appending the nullable `jobs.dispatch_origin`
  // provenance column — `'autopilot'` iff the SessionStart discharged a real
  // `pending_dispatches` row, else NULL; an additive ALTER, NO cursor rewind: the
  // `Dispatched` event precedes its binding SessionStart in the log, so a
  // from-scratch re-fold reproduces the same discharge and the same stamp
  // byte-identical). And to 109 via fn-1103 task .3 (appending the nullable
  // `harness`/`resume_target` columns to BOTH events — a five-place lockstep —
  // and jobs — migration-only; an additive ALTER, NO cursor rewind: a pre-v109
  // stream carries neither value, so a from-scratch re-fold folds both NULL
  // byte-identical, and the fold never synthesizes a harness value). And to 110
  // via fn-1129 task .1 (appending the nullable `human_notified_at` once-marker to
  // BOTH `dispatch_failures` and `block_escalations` — the terminal human-notify
  // stage of the two escalation paths, stamped by `MergeHumanNotified` /
  // `BlockHumanNotified` on a declined/dead escalation session; additive ALTERs,
  // NO cursor rewind: a pre-v110 stream carries neither event, so a from-scratch
  // re-fold leaves both columns NULL byte-identical, and `foldDispatchFailed`
  // preserves the dispatch_failures marker across the UPSERT).
  // And to 111 via fn-1131 task .1 (appending the nullable `adopted` INTEGER column to BOTH
  // events — a five-place lockstep — and jobs — migration-only, plus the
  // `autopilot_state.codex_adoption` knob; additive ALTERs, NO cursor rewind: a
  // pre-v111 stream carries no adopted value and no fold reads codex_adoption, so
  // a from-scratch re-fold folds all three NULL byte-identical, and the fold never
  // synthesizes an adopted value).
  // And to 112 via fn-1151 task .2 (appending the nullable `epics.selection_review`
  // TEXT column — the epic-level selection-review record; an additive ALTER, NO
  // cursor rewind: a pre-v112 EpicSnapshot carries no `selection_review` key, so a
  // from-scratch re-fold folds it NULL byte-identical, and the producer coerces the
  // value before it ever reaches the fold).
  // And to 113 via fn-1164 task .1 (appending the nullable `jobs.last_lifecycle_ts`
  // REAL column — the per-row lifecycle stamp; the fold gate is polarity-aware and
  // pure over event.ts + the pre-update state, so it stays re-fold deterministic.
  // This migration REWINDS the cursor and wipes the deterministic projection set
  // so the stamp is back-derived purely by replay and existing phantom-working
  // rows self-heal — `commit_trailer_facts` is spared per the v80/v81/v85 carve-out).
  // And to 114 via fn-1171 task .2 (appending the nullable `jobs.escalation_instance`
  // + `dispatch_failures.instance_event_id` INTEGER columns — the escalation-session
  // block-instance binding; the binding-SessionStart stamp is COALESCE-preserved and
  // `instance_event_id` copies the event's own id, so a plain additive ALTER with NO
  // cursor rewind stays re-fold deterministic — a from-scratch re-fold reproduces
  // every stamp and every corroboration miss byte-identical).
  // And to 115 via fn-1173 task .4 (appending the nullable
  // `dispatch_failures.repair_dispatched_at` once-marker — the shared-base repair
  // dispatch latch on the `repair::<repo-token>` sticky row, sibling of
  // `merge_escalated_at` / `resolver_dispatched_at`; an additive ALTER, NO cursor
  // rewind: a pre-v115 stream carries no `RepairDispatched` event, so a from-scratch
  // re-fold leaves it NULL byte-identical, and `foldDispatchFailed` preserves it across
  // the UPSERT).
  // And to 116 via fn-1172 task .3 (DROPPING the `epics.selection_review` TEXT
  // column via a REWINDING migration — a pre-removal EpicSnapshot's `selection_review`
  // key folds away unread, so a from-scratch re-fold over any stream produces the
  // narrower epics shape byte-identically; `commit_trailer_facts` spared per the
  // same carve-out).
  // And to 117 via fn-1216 task .1 (appending the nullable `epics.blocks_closing_of`
  // TEXT column — the blocking-follow-up close-gate pointer, sibling of `question`;
  // an additive ALTER declared in the `CREATE_EPICS` literal too, NO cursor rewind:
  // a pre-v117 EpicSnapshot carries no `blocks_closing_of` key, so a from-scratch
  // re-fold leaves it NULL byte-identical).
  // And to 118 via fn-1226 task .1 (appending the nullable
  // `git_status.unattributed_to_live_count` INTEGER column — the exact
  // project-wide count the reducer's pass 4 already computed but only ever
  // stamped onto `jobs.git_unattributed_to_live_count`; an additive ALTER, NO
  // cursor rewind: `git_status` is LIVE-ONLY, so the boot-seed re-derives the
  // value rather than replay).
  // And to 119 via fn-1239 task .3 (appending the nullable `events.account_route`
  // + `jobs.account_route` TEXT columns — the PII-free per-launch account route
  // the hook captures from KEEPER_ACCOUNT_ROUTE at SessionStart; additive ALTERs,
  // NO cursor rewind: a pre-v119 event carries no route, so a from-scratch
  // re-fold leaves both NULL byte-identical).
  // And to 120 via fn-1239 task .6 (unconditionally DROPping the retired `usage`
  // / `profiles` tables — the account-routing boundary supersedes the
  // Keeper-owned usage/profile projections; mirrors the `event_blobs` v74 tail
  // DROP. The `UsageSnapshot` / `UsageDeleted` fold arms become explicit
  // no-ops and the `RateLimited`/`ApiError` profile-level fan-out is deleted,
  // so NO cursor rewind: neither retired table is ever read again and a
  // from-scratch re-fold never touches them).
  // And to 121 re-appending the nullable `autopilot_state.worker_provider`
  // TEXT enum column — the durable work-dispatch provider pin, docs/adr/0047;
  // fn-1256 task .3's original ladder entry was lost to the b39fab28
  // stale-tree sweep while fn-1239's v119/v120 landed in its place, so it
  // returns as a NEW tail step (an idempotent additive ALTER, NO cursor
  // rewind: a stream with no worker_provider patch folds the column NULL
  // byte-identically).
  // And to 122 backfilling the `autopilot_state.worker_provider` family-label
  // value 'codex' → 'gpt' (docs/adr/0047 amendment) — a pure data UPDATE, NO
  // cursor rewind: the reducer fold normalizes the same alias so a from-scratch
  // re-fold reaches 'gpt' byte-identically.
  // And to 123 renumbering fn-1252 task .3's base-drift threshold columns
  // (`autopilot_state.drift_behind_threshold` / `drift_age_threshold_days`)
  // onto the tail, and to 124 appending fn-1252 task .6's
  // `dispatch_failures.conflicted_files` TEXT column — both idempotent additive
  // ALTERs, NO cursor rewind.
  expect(SCHEMA_VERSION).toBe(124);
});

test("PENDING_DISPATCH_SWEEP_INTERVAL_MS is 60s (matches the documented heartbeat cadence)", () => {
  // The sweep MUST ride the heartbeat, not the data_version wake — a
  // crashed dispatch can be the only pending row on a quiescent board,
  // and a write-triggered wake would never fire. The 60s cadence
  // matches the git-worker / git-status / readiness heartbeats keeper
  // already uses elsewhere.
  expect(PENDING_DISPATCH_SWEEP_INTERVAL_MS).toBe(60_000);
});

test("selectExpiredPendingDispatches returns aged rows past the TTL", () => {
  const { db } = freshMemDb();
  const now = 1_700_000_000_000; // arbitrary fixed epoch (ms)
  const nowSec = now / 1000;
  // Aged: dispatched 121s ago (past the 120s TTL).
  seedPendingDispatch(db, "work", "fn-1-foo.1", nowSec - 121);
  // Fresh: dispatched 30s ago (well inside the TTL).
  seedPendingDispatch(db, "work", "fn-1-foo.2", nowSec - 30);
  // Exact boundary: dispatched exactly 120s ago — equal is NOT past,
  // so this row is NOT expired (cutoff is strict less-than).
  seedPendingDispatch(db, "work", "fn-1-foo.3", nowSec - 120);

  const expired = selectExpiredPendingDispatches(db, now);
  expect(expired.map((r) => r.id).sort()).toEqual(["fn-1-foo.1"]);
  db.close();
});

test("selectExpiredPendingDispatches expires an aged row EVEN with an open dispatch_failures row (fn-870 BUG2 self-heal)", () => {
  const { db } = freshMemDb();
  const now = 1_700_000_000_000;
  const nowSec = now / 1000;
  // Aged row WITH a sticky dispatch_failures row for the same (verb, id). The
  // prior `WHERE df.verb IS NULL` guard shielded this row from the sweep forever
  // — the "suppressed sweep" deadlock (the v76→v79 jam: every phantom was
  // BLOCKED-by-dispatch_failures, so the sweep never freed the slot). The TTL
  // sweep is now UNCONDITIONAL on dispatch_failures membership, so this aged row
  // expires.
  seedPendingDispatch(db, "work", "fn-1-foo.1", nowSec - 200);
  seedDispatchFailure(db, "work", "fn-1-foo.1", nowSec - 200);
  // Another aged row WITHOUT a matching failure — also expires.
  seedPendingDispatch(db, "work", "fn-1-foo.2", nowSec - 200);

  const expired = selectExpiredPendingDispatches(db, now);
  expect(expired.map((r) => r.id).sort()).toEqual(["fn-1-foo.1", "fn-1-foo.2"]);
  db.close();
});

test("selectExpiredPendingDispatches measures TTL against frozen dispatched_at (a daemon restart never resets the clock)", () => {
  const { db } = freshMemDb();
  // The frozen `dispatched_at` lifts off the synthetic event's payload,
  // not `Date.now()` inside the fold (CLAUDE.md re-fold determinism).
  // This test confirms the SWEEP side honors the same contract: the
  // expire decision is `Date.now() - dispatched_at*1000 > TTL`,
  // independent of when the daemon (re)started.
  const dispatchedAtSec = 1_699_000_000;
  seedPendingDispatch(db, "work", "fn-1-bar.1", dispatchedAtSec);

  // Sweep "shortly after" — fresh row, not expired.
  const justAfter = dispatchedAtSec * 1000 + 30_000;
  expect(selectExpiredPendingDispatches(db, justAfter)).toEqual([]);

  // Sweep "after a daemon restart that took 2 minutes" — same row,
  // same frozen dispatched_at, NOW past the TTL.
  const muchLater = dispatchedAtSec * 1000 + PENDING_DISPATCH_TTL_MS + 1;
  const aged = selectExpiredPendingDispatches(db, muchLater);
  expect(aged.map((r) => r.id)).toEqual(["fn-1-bar.1"]);
  db.close();
});

test("selectExpiredPendingDispatches on an empty pending_dispatches table returns []", () => {
  const { db } = freshMemDb();
  expect(selectExpiredPendingDispatches(db, 1_700_000_000_000)).toEqual([]);
  db.close();
});

// ---------------------------------------------------------------------------
// fn-1061 task .1 — the DURABLE dispatch-mint rate-limit gate. One logical
// dispatch = one durable `Dispatched` row: the gate read + the conditional event
// insert are one transaction at the mint site, a re-mint of the same `verb::id`
// inside the window is suppressed, the gate survives a restart, `retry_dispatch`
// (via `clearDispatchMintGate`) clears it, and stale rows age out via eviction.
// ---------------------------------------------------------------------------

/** Insert a minimal `Dispatched` event exactly as the mint site does. */
function insertDispatchedRow(
  db: ReturnType<typeof openDb>["db"],
  dispatchKey: string,
  tsSec: number,
): void {
  db.run(
    `INSERT INTO events (ts, session_id, hook_event, event_type, data)
       VALUES (?, ?, 'Dispatched', 'pending_dispatches', '{}')`,
    [tsSec, dispatchKey],
  );
}

function countDispatchedRows(
  db: ReturnType<typeof openDb>["db"],
  dispatchKey: string,
): number {
  return (
    db
      .query(
        "SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND hook_event = 'Dispatched'",
      )
      .get(dispatchKey) as { n: number }
  ).n;
}

test("DISPATCH_MINT_GATE_WINDOW_MS is 60s, below the TTL, and the evict horizon sits a few windows past it", () => {
  // Sized strictly below the 120s pending-dispatch TTL (and the 200s cooldown) so
  // a legit re-dispatch passes the gate; eviction is kept past the window so a row
  // is never pruned while it can still suppress.
  expect(DISPATCH_MINT_GATE_WINDOW_MS).toBe(60_000);
  expect(DISPATCH_MINT_GATE_WINDOW_MS).toBeLessThan(PENDING_DISPATCH_TTL_MS);
  expect(DISPATCH_MINT_GATE_EVICT_MS).toBeGreaterThan(
    DISPATCH_MINT_GATE_WINDOW_MS,
  );
});

test("openDb materializes the durable dispatch_mint_gate table (NOT an ephemeral projection)", () => {
  const { db } = freshMemDb();
  const tables = new Set(
    (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((t) => t.name),
  );
  expect(tables.has("dispatch_mint_gate")).toBe(true);
  // Producer state (same class as dead_letters), NOT a boot-truncated projection.
  expect(EPHEMERAL_PROJECTIONS as readonly string[]).not.toContain(
    "dispatch_mint_gate",
  );
  db.close();
});

test("runDispatchMintGate: first mint runs onFreshMint and stamps the gate", () => {
  const { db } = freshMemDb();
  const key = "work::fn-1-foo.1";
  const t0 = 1_700_000_000_000;
  let mints = 0;
  const { suppressed } = runDispatchMintGate(
    db,
    key,
    t0,
    DISPATCH_MINT_GATE_WINDOW_MS,
    () => {
      mints += 1;
    },
  );
  expect(suppressed).toBe(false);
  expect(mints).toBe(1);
  // The gate is stamped at `nowMs / 1000` (unix-epoch seconds).
  expect(readDispatchMintGate(db, key)).toBe(t0 / 1000);
  db.close();
});

test("runDispatchMintGate: a re-mint inside the window is suppressed and inserts NO second events row", () => {
  const { db } = freshMemDb();
  const key = "work::fn-1-foo.1";
  const t0 = 1_700_000_000_000;

  const first = runDispatchMintGate(
    db,
    key,
    t0,
    DISPATCH_MINT_GATE_WINDOW_MS,
    () => insertDispatchedRow(db, key, t0 / 1000),
  );
  expect(first.suppressed).toBe(false);
  expect(countDispatchedRows(db, key)).toBe(1);

  // Re-mint 30s later — inside the 60s window: suppressed, onFreshMint never runs.
  let secondRan = false;
  const second = runDispatchMintGate(
    db,
    key,
    t0 + 30_000,
    DISPATCH_MINT_GATE_WINDOW_MS,
    () => {
      secondRan = true;
      insertDispatchedRow(db, key, (t0 + 30_000) / 1000);
    },
  );
  expect(second.suppressed).toBe(true);
  expect(secondRan).toBe(false);
  // Still EXACTLY one durable row for the logical dispatch.
  expect(countDispatchedRows(db, key)).toBe(1);
  db.close();
});

test("runDispatchMintGate: a re-mint AFTER the window passes (legit re-dispatch) mints a second row", () => {
  const { db } = freshMemDb();
  const key = "work::fn-1-foo.1";
  const t0 = 1_700_000_000_000;

  runDispatchMintGate(db, key, t0, DISPATCH_MINT_GATE_WINDOW_MS, () =>
    insertDispatchedRow(db, key, t0 / 1000),
  );
  // A TTL-cadence re-dispatch at +120s (past the 60s window) passes untouched.
  const later = t0 + PENDING_DISPATCH_TTL_MS;
  const { suppressed } = runDispatchMintGate(
    db,
    key,
    later,
    DISPATCH_MINT_GATE_WINDOW_MS,
    () => insertDispatchedRow(db, key, later / 1000),
  );
  expect(suppressed).toBe(false);
  expect(countDispatchedRows(db, key)).toBe(2);
  // The mint branch re-stamped the gate to the later time.
  expect(readDispatchMintGate(db, key)).toBe(later / 1000);
  db.close();
});

test("runDispatchMintGate: suppression does NOT re-stamp the gate (window stays anchored to the frozen first mint)", () => {
  const { db } = freshMemDb();
  const key = "work::fn-1-foo.1";
  const t0 = 1_700_000_000_000;

  runDispatchMintGate(db, key, t0, DISPATCH_MINT_GATE_WINDOW_MS, () => {});
  // A drip of suppressed re-mints across the window must not renew it.
  for (const dt of [10_000, 20_000, 50_000]) {
    const { suppressed } = runDispatchMintGate(
      db,
      key,
      t0 + dt,
      DISPATCH_MINT_GATE_WINDOW_MS,
      () => {},
    );
    expect(suppressed).toBe(true);
    // Gate still anchored to t0 — never advanced by a suppress.
    expect(readDispatchMintGate(db, key)).toBe(t0 / 1000);
  }
  // So the very next attempt just past 60s from t0 passes, not perpetually blocked.
  const past = runDispatchMintGate(
    db,
    key,
    t0 + DISPATCH_MINT_GATE_WINDOW_MS,
    DISPATCH_MINT_GATE_WINDOW_MS,
    () => {},
  );
  expect(past.suppressed).toBe(false);
  db.close();
});

test("runDispatchMintGate: a throw from onFreshMint rolls back the gate stamp (atomicity — the next attempt is NOT wrongly suppressed)", () => {
  const { db } = freshMemDb();
  const key = "work::fn-1-foo.1";
  const t0 = 1_700_000_000_000;

  expect(() =>
    runDispatchMintGate(db, key, t0, DISPATCH_MINT_GATE_WINDOW_MS, () => {
      throw new Error("insert failed");
    }),
  ).toThrow("insert failed");
  // The transaction rolled back: no gate row, so a real retry is not suppressed.
  expect(readDispatchMintGate(db, key)).toBeNull();
  const retry = runDispatchMintGate(
    db,
    key,
    t0 + 1_000,
    DISPATCH_MINT_GATE_WINDOW_MS,
    () => {},
  );
  expect(retry.suppressed).toBe(false);
  db.close();
});

test("the dispatch_mint_gate survives a daemon restart within the window (durable, read fresh from disk)", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-mint-gate-"));
  const path = join(dir, "keeper.db");
  const t0 = 1_700_000_000_000;
  try {
    // Boot 1: mint stamps the gate, then the daemon "restarts" (close).
    const boot1 = freshDbFile(path);
    runDispatchMintGate(
      boot1.db,
      "work::fn-1-foo.1",
      t0,
      DISPATCH_MINT_GATE_WINDOW_MS,
      () => insertDispatchedRow(boot1.db, "work::fn-1-foo.1", t0 / 1000),
    );
    boot1.db.close();

    // Boot 2: a fresh connection reads the persisted gate row — a re-mint 30s
    // later (still inside the window) is suppressed across the restart.
    const boot2 = openDb(path);
    expect(readDispatchMintGate(boot2.db, "work::fn-1-foo.1")).toBe(t0 / 1000);
    const { suppressed } = runDispatchMintGate(
      boot2.db,
      "work::fn-1-foo.1",
      t0 + 30_000,
      DISPATCH_MINT_GATE_WINDOW_MS,
      () =>
        insertDispatchedRow(boot2.db, "work::fn-1-foo.1", (t0 + 30_000) / 1000),
    );
    expect(suppressed).toBe(true);
    expect(countDispatchedRows(boot2.db, "work::fn-1-foo.1")).toBe(1);
    boot2.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearDispatchMintGate: clearing a key (the retry_dispatch fast path) lets an immediate re-mint pass", () => {
  const { db } = freshMemDb();
  const key = "close::fn-1-foo";
  const t0 = 1_700_000_000_000;

  runDispatchMintGate(db, key, t0, DISPATCH_MINT_GATE_WINDOW_MS, () => {});
  // A human retry clears the gate row...
  clearDispatchMintGate(db, key);
  expect(readDispatchMintGate(db, key)).toBeNull();
  // ...so an immediate re-mint (well inside the window) is NOT suppressed.
  const { suppressed } = runDispatchMintGate(
    db,
    key,
    t0 + 1_000,
    DISPATCH_MINT_GATE_WINDOW_MS,
    () => {},
  );
  expect(suppressed).toBe(false);
  db.close();
});

test("evictStaleDispatchMintGate prunes rows past the cutoff and keeps fresh ones", () => {
  const { db } = freshMemDb();
  const nowMs = 1_700_000_000_000;
  const nowSec = nowMs / 1000;
  // Stale: stamped a full evict horizon + a window ago.
  upsertDispatchMintGate(
    db,
    "work::stale.1",
    nowSec -
      (DISPATCH_MINT_GATE_EVICT_MS + DISPATCH_MINT_GATE_WINDOW_MS) / 1000,
  );
  // Fresh: stamped just now — still inside the window.
  upsertDispatchMintGate(db, "work::fresh.1", nowSec);

  const cutoffSec = (nowMs - DISPATCH_MINT_GATE_EVICT_MS) / 1000;
  const evicted = evictStaleDispatchMintGate(db, cutoffSec);
  expect(evicted).toBe(1);
  expect(readDispatchMintGate(db, "work::stale.1")).toBeNull();
  expect(readDispatchMintGate(db, "work::fresh.1")).toBe(nowSec);
  db.close();
});

// ---------------------------------------------------------------------------
// fn-720 task .3 — pending-dispatch sweep backstop telemetry (timeout class)
// ---------------------------------------------------------------------------

test("buildPendingDispatchSweepRecords: an expired row posts a timeout rescue with elapsed-since-dispatch staleness", () => {
  // The sweep's per-row telemetry is a `timeout`-class rescue: fast_path and
  // last_fast_path_at are ALWAYS null (no fast-path notion), staleness_ms is
  // elapsed-since-dispatch (now − dispatched_at*1000), and the {verb,id}
  // triage detail rides along. backstop/worker pin to the sweep + main.
  const dispatchedAtSec = 1_699_000_000;
  const nowMs = dispatchedAtSec * 1000 + 150_000; // 150s after dispatch
  const aged = [
    { verb: "work", id: "fn-1-foo.1", dispatched_at: dispatchedAtSec },
  ];
  const recs = buildPendingDispatchSweepRecords(aged, nowMs);
  expect(recs.length).toBe(1);
  const rec = recs[0];
  expect(rec?.kind).toBe("backstop-rescue");
  expect(rec?.class).toBe("timeout");
  expect(rec?.backstop).toBe("pending-dispatch-sweep");
  expect(rec?.worker).toBe("main");
  expect(rec?.rescued).toBe(true);
  expect(rec?.staleness_ms).toBe(150_000);
  // timeout class carries null fast_path / last_fast_path_at (epic acceptance).
  expect(rec?.fast_path).toBeNull();
  expect(rec?.last_fast_path_at).toBeNull();
  expect(rec?.detail).toEqual({ verb: "work", id: "fn-1-foo.1" });
});

test("buildPendingDispatchSweepRecords: an empty sweep yields no records (denominator-only)", () => {
  // An empty sweep writes NO line — it only bumps the rescued:false
  // denominator (a counter bump the caller does directly). The helper returns
  // [] so the no-op sweep never spams the sidecar.
  expect(buildPendingDispatchSweepRecords([], 1_700_000_000_000)).toEqual([]);
});

test("pending-dispatch sweep telemetry round-trips to the sidecar; empty sweep bumps the rescued:false denominator", () => {
  // Mirrors the daemon-side sweep composition end to end: aged rows →
  // buildPendingDispatchSweepRecords → appendBackstopRecord (main is the SOLE
  // sidecar writer); an EMPTY sweep bumps the rescued:false denominator on the
  // shared BackstopCounters. Asserts the rescue line lands on disk and the
  // rollup carries fires_total > rescues_total once a no-op sweep is counted.
  const logPath = join(tmpDir, "backstop.ndjson");
  const counters = new BackstopCounters();

  // Rescue pass: one aged row → one record line + a rescued:true counter bump.
  const dispatchedAtSec = 1_699_000_000;
  const nowMs = dispatchedAtSec * 1000 + 200_000;
  const aged = [
    { verb: "work", id: "fn-2-bar.3", dispatched_at: dispatchedAtSec },
  ];
  const recs = buildPendingDispatchSweepRecords(aged, nowMs);
  for (const rec of recs) {
    appendBackstopRecord(rec, logPath);
    counters.bump("pending-dispatch-sweep", "timeout", true);
  }

  // Empty sweep: no record line, just the rescued:false denominator bump.
  expect(buildPendingDispatchSweepRecords([], nowMs)).toEqual([]);
  counters.bump("pending-dispatch-sweep", "timeout", false);

  // The sidecar has exactly the one rescue line, parseable as the timeout
  // record (reader tolerates the trailing newline → final empty segment).
  const lines = readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  expect(lines.length).toBe(1);
  const parsed = JSON.parse(lines[0] ?? "{}");
  expect(parsed.class).toBe("timeout");
  expect(parsed.backstop).toBe("pending-dispatch-sweep");
  expect(parsed.rescued).toBe(true);
  expect(parsed.staleness_ms).toBe(200_000);
  expect(parsed.fast_path).toBeNull();
  expect(parsed.last_fast_path_at).toBeNull();

  // The rollup denominator reflects BOTH fires (one rescue + one no-op) so
  // scripts/backstop-stats.ts can compute a true rescue RATE (1/2).
  const rollups = counters.snapshot(nowMs);
  expect(rollups.length).toBe(1);
  expect(rollups[0]?.backstop).toBe("pending-dispatch-sweep");
  expect(rollups[0]?.class).toBe("timeout");
  expect(rollups[0]?.fires_total).toBe(2);
  expect(rollups[0]?.rescues_total).toBe(1);
});

// ---------------------------------------------------------------------------
// fn-941 task .3 — daemon block-escalation producer
// ---------------------------------------------------------------------------

test("BLOCK_ESCALATION_SWEEP_INTERVAL_MS is 60s (rides the heartbeat, not the data_version wake)", () => {
  expect(BLOCK_ESCALATION_SWEEP_INTERVAL_MS).toBe(60_000);
});

test("parseBlockedCategory: lifts the leading <CATEGORY>: token, null on absent/unparseable", () => {
  expect(parseBlockedCategory("SPEC_UNCLEAR: the spec is vague")).toBe(
    "SPEC_UNCLEAR",
  );
  expect(parseBlockedCategory("  TOOLING_FAILURE: broken runner")).toBe(
    "TOOLING_FAILURE",
  );
  expect(parseBlockedCategory("RESUME_EXHAUSTED: out of resume budget")).toBe(
    "RESUME_EXHAUSTED",
  );
  // No leading WORD: token → null (a later colon never false-matches).
  expect(parseBlockedCategory("see foo: bar")).toBeNull();
  expect(parseBlockedCategory("no category here")).toBeNull();
  expect(parseBlockedCategory("")).toBeNull();
  expect(parseBlockedCategory(null)).toBeNull();
  // Lowercase prefix is NOT a category token.
  expect(parseBlockedCategory("spec_unclear: nope")).toBeNull();
});

test("shouldEscalateBlockedCategory: denylist — only TOOLING_FAILURE and null are skipped", () => {
  expect(shouldEscalateBlockedCategory("SPEC_UNCLEAR")).toBe(true);
  expect(shouldEscalateBlockedCategory("DEPENDENCY_BLOCKED")).toBe(true);
  expect(shouldEscalateBlockedCategory("DESIGN_CONFLICT")).toBe(true);
  expect(shouldEscalateBlockedCategory("SCOPE_EXCEEDED")).toBe(true);
  expect(shouldEscalateBlockedCategory("EXTERNAL_BLOCKED")).toBe(true);
  expect(shouldEscalateBlockedCategory("RESUME_EXHAUSTED")).toBe(true);
  // Skipped: the one denylisted category + an absent/unparseable reason.
  expect(shouldEscalateBlockedCategory(BLOCK_ESCALATION_SKIP_CATEGORY)).toBe(
    false,
  );
  expect(shouldEscalateBlockedCategory("TOOLING_FAILURE")).toBe(false);
  expect(shouldEscalateBlockedCategory(null)).toBe(false);
});

test("effectiveBlockEscalationRepo: target_repo override, else project_dir, else empty", () => {
  expect(effectiveBlockEscalationRepo("/repo/a", "/proj")).toBe("/repo/a");
  expect(effectiveBlockEscalationRepo(null, "/proj")).toBe("/proj");
  expect(effectiveBlockEscalationRepo("", "/proj")).toBe("/proj");
  expect(effectiveBlockEscalationRepo(null, null)).toBe("");
  expect(effectiveBlockEscalationRepo("", "")).toBe("");
});

// ---- selectPendingBlockEscalations (the current-state working-set read) -----

function seedEpicWithTasks(
  db: ReturnType<typeof openDb>["db"],
  epicId: string,
  projectDir: string | null,
  tasks: {
    task_id: string;
    runtime_status?: string;
    target_repo?: string | null;
  }[],
): void {
  db.run(
    `INSERT INTO epics (epic_id, project_dir, status, last_event_id, updated_at, tasks)
       VALUES (?, ?, 'open', 1, 0, ?)`,
    [epicId, projectDir, JSON.stringify(tasks)],
  );
}

function seedBlockLatch(
  db: ReturnType<typeof openDb>["db"],
  epicId: string,
  taskId: string,
  status = "pending",
): void {
  db.run(
    `INSERT INTO block_escalations (epic_id, task_id, blocked_since, status, outcome, last_event_id)
       VALUES (?, ?, 1, ?, NULL, 1)`,
    [epicId, taskId, status],
  );
}

test("selectPendingBlockEscalations: joins pending latch to epic project_dir + embedded task runtime_status/target_repo", () => {
  const { db } = freshMemDb();
  seedEpicWithTasks(db, "fn-1-foo", "/proj/foo", [
    {
      task_id: "fn-1-foo.1",
      runtime_status: "blocked",
      target_repo: "/repo/x",
    },
    { task_id: "fn-1-foo.2", runtime_status: "todo", target_repo: null },
  ]);
  seedBlockLatch(db, "fn-1-foo", "fn-1-foo.1");
  // A non-pending (already-attempted) latch is NOT returned.
  seedBlockLatch(db, "fn-1-foo", "fn-1-foo.2", "attempted");

  const rows = selectPendingBlockEscalations(db);
  expect(rows.length).toBe(1);
  expect(rows[0]).toEqual({
    epic_id: "fn-1-foo",
    task_id: "fn-1-foo.1",
    project_dir: "/proj/foo",
    runtime_status: "blocked",
    target_repo: "/repo/x",
  });
  db.close();
});

test("selectPendingBlockEscalations: a pending latch with no surviving epic/task element returns null fields", () => {
  const { db } = freshMemDb();
  // Latch with NO matching epic row.
  seedBlockLatch(db, "fn-2-ghost", "fn-2-ghost.1");
  // Latch whose epic exists but the embedded task element is absent.
  seedEpicWithTasks(db, "fn-3-bar", "/proj/bar", [
    { task_id: "fn-3-bar.9", runtime_status: "blocked" },
  ]);
  seedBlockLatch(db, "fn-3-bar", "fn-3-bar.1");

  const rows = selectPendingBlockEscalations(db);
  const ghost = rows.find((r) => r.task_id === "fn-2-ghost.1");
  expect(ghost).toEqual({
    epic_id: "fn-2-ghost",
    task_id: "fn-2-ghost.1",
    project_dir: null,
    runtime_status: null,
    target_repo: null,
  });
  const missingEl = rows.find((r) => r.task_id === "fn-3-bar.1");
  expect(missingEl).toEqual({
    epic_id: "fn-3-bar",
    task_id: "fn-3-bar.1",
    project_dir: "/proj/bar",
    runtime_status: null,
    target_repo: null,
  });
  db.close();
});

test("selectPendingBlockEscalations: empty table returns []", () => {
  const { db } = freshMemDb();
  expect(selectPendingBlockEscalations(db)).toEqual([]);
  db.close();
});

// ---- runBlockEscalationSweep (the dispatch core, injected deps) -------------

interface MintCall {
  kind: "requested" | "attempted";
  epicId: string;
  taskId: string;
  outcome?: BlockEscalationOutcome;
}

/** One blocked pending row with sensible defaults (blocked + `/proj`). */
function blockedRow(
  epicId: string,
  taskId: string,
  overrides: Partial<PendingBlockEscalation> = {},
): PendingBlockEscalation {
  return {
    epic_id: epicId,
    task_id: taskId,
    project_dir: "/proj",
    runtime_status: "blocked",
    target_repo: null,
    ...overrides,
  };
}

/** Build injectable deps over a synthetic pending set + a reason map + a dispatch
 *  stub, recording every mint + dispatch call for assertion. */
function fakeSweepDeps(opts: {
  pending: PendingBlockEscalation[];
  reasons?: Record<string, string | null>;
  /** Task ids whose `work::<id>` already has an open `dispatch_failures` row —
   *  drives the once-only guard for the durable re-dispatch suppression. */
  alreadyFailed?: Set<string>;
  /** Epic ids for which an `unblock::<task>` session is already LIVE — drives the
   *  per-epic serialization (across-sweep) guard. */
  epicLive?: Set<string>;
  /** Owning-orchestrator liveness keyed by task id — drives the AUDIT_READY gate.
   *  A task with no entry reads `absent`. */
  orchestrator?: Record<string, AuditOrchestratorLiveness>;
  /** Fixed wall-clock (ms) for the AUDIT_READY grace comparison. */
  nowMs?: number;
  dispatch?: (
    row: PendingBlockEscalation,
  ) => Promise<EscalationDispatchOutcome>;
}): {
  deps: BlockEscalationSweepDeps;
  mints: MintCall[];
  dispatches: { epicId: string; taskId: string }[];
  suppressions: { taskId: string; reason: string; dir: string | null }[];
  notes: string[];
} {
  const mints: MintCall[] = [];
  const dispatches: { epicId: string; taskId: string }[] = [];
  const suppressions: { taskId: string; reason: string; dir: string | null }[] =
    [];
  const notes: string[] = [];
  const deps: BlockEscalationSweepDeps = {
    selectPending: () => opts.pending,
    readBlockedReason: (_projectDir, taskId) => opts.reasons?.[taskId] ?? null,
    mintRequested: (epicId, taskId) =>
      mints.push({ kind: "requested", epicId, taskId }),
    mintAttempted: (epicId, taskId, outcome) =>
      mints.push({ kind: "attempted", epicId, taskId, outcome }),
    dispatchUnblock: async (row) => {
      dispatches.push({ epicId: row.epic_id, taskId: row.task_id });
      return (await opts.dispatch?.(row)) ?? "dispatched";
    },
    isEpicUnblockLive: (epicId) => opts.epicLive?.has(epicId) ?? false,
    auditOrchestratorLiveness: (row) =>
      opts.orchestrator?.[row.task_id] ?? { state: "absent" },
    now: () => opts.nowMs ?? Date.now(),
    hasOpenWorkFailure: (taskId) => opts.alreadyFailed?.has(taskId) ?? false,
    suppressRedispatch: (args) => suppressions.push(args),
    noteLine: (line) => notes.push(line),
  };
  return { deps, mints, dispatches, suppressions, notes };
}

test("runBlockEscalationSweep: an escalatable block DISPATCHES one unblock and mints Requested→Attempted{dispatched} (no planner@ send)", async () => {
  const { deps, mints, dispatches } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1")],
    reasons: { "fn-1-foo.1": "SPEC_UNCLEAR: ambiguous acceptance" },
  });
  await runBlockEscalationSweep(deps);

  // Exactly one unblock dispatch for the task — and no planner@ bus message (the
  // deps surface has no notify path at all now).
  expect(dispatches).toEqual([{ epicId: "fn-1-foo", taskId: "fn-1-foo.1" }]);
  // Requested STRICTLY before Attempted; the terminal outcome is `dispatched`.
  expect(mints).toEqual([
    { kind: "requested", epicId: "fn-1-foo", taskId: "fn-1-foo.1" },
    {
      kind: "attempted",
      epicId: "fn-1-foo",
      taskId: "fn-1-foo.1",
      outcome: "dispatched",
    },
  ]);
});

test("runBlockEscalationSweep: TOOLING_FAILURE never dispatches an agent (skipped_category)", async () => {
  const { deps, mints, dispatches, notes } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1")],
    reasons: { "fn-1-foo.1": "TOOLING_FAILURE: the runner is broken" },
  });
  await runBlockEscalationSweep(deps);

  expect(dispatches).toEqual([]);
  expect(mints).toEqual([
    { kind: "requested", epicId: "fn-1-foo", taskId: "fn-1-foo.1" },
    {
      kind: "attempted",
      epicId: "fn-1-foo",
      taskId: "fn-1-foo.1",
      outcome: "skipped_category",
    },
  ]);
  // A readable-but-non-escalatable category leaves its own class-stable trace.
  expect(notes).toEqual([
    "# block-escalation-drop task=fn-1-foo.1 class=surface_and_stop category=TOOLING_FAILURE",
  ]);
});

test("runBlockEscalationSweep: an absent/unparseable reason never dispatches (surface-and-stop)", async () => {
  const { deps, mints, dispatches, notes } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1")],
    // No reason entry → readBlockedReason returns null → category null → skip.
    reasons: {},
  });
  await runBlockEscalationSweep(deps);

  expect(dispatches).toEqual([]);
  expect(mints.map((m) => m.kind === "attempted" && m.outcome)).toContain(
    "skipped_category",
  );
  // The unreadable-reason gate leaves ITS OWN trace — never the sibling
  // `surface_and_stop` class too (a row drops through exactly one class-carrying
  // gate per cycle).
  expect(notes).toEqual([
    "# block-escalation-drop task=fn-1-foo.1 class=reason_unreadable project_dir=/proj",
  ]);
});

test("runBlockEscalationSweep: a TOOLING_FAILURE block mints a durable DispatchFailed on work::<task> (re-dispatch suppression)", async () => {
  const { deps, suppressions } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1", { target_repo: "/lane" })],
    reasons: { "fn-1-foo.1": "TOOLING_FAILURE: the runner is broken" },
  });
  await runBlockEscalationSweep(deps);

  // The surface-and-stop block durably suppresses re-dispatch via a sticky
  // failure on the WORK key, carrying the effective repo as `dir`.
  expect(suppressions).toEqual([
    { taskId: "fn-1-foo.1", reason: "blocked: TOOLING_FAILURE", dir: "/lane" },
  ]);
});

test("runBlockEscalationSweep: an absent/unparseable block also durably suppresses (surface-and-stop)", async () => {
  const { deps, suppressions } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1")],
    reasons: {},
  });
  await runBlockEscalationSweep(deps);

  // No target_repo → `dir` falls back to the epic project_dir.
  expect(suppressions).toEqual([
    { taskId: "fn-1-foo.1", reason: "blocked: unparseable", dir: "/proj" },
  ]);
});

test("runBlockEscalationSweep: the durable suppression is once-only — skipped when a work failure row already exists", async () => {
  const { deps, mints, suppressions } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1")],
    reasons: { "fn-1-foo.1": "TOOLING_FAILURE: still broken" },
    alreadyFailed: new Set(["fn-1-foo.1"]),
  });
  await runBlockEscalationSweep(deps);

  // The sticky row already exists → no re-mint (the 60s sweep never re-emits) ...
  expect(suppressions).toEqual([]);
  // ... but the latch still advances pending→requested→attempted exactly once.
  expect(mints).toEqual([
    { kind: "requested", epicId: "fn-1-foo", taskId: "fn-1-foo.1" },
    {
      kind: "attempted",
      epicId: "fn-1-foo",
      taskId: "fn-1-foo.1",
      outcome: "skipped_category",
    },
  ]);
});

test("runBlockEscalationSweep: an escalatable block does NOT durably suppress (only surface-and-stop categories do)", async () => {
  const { deps, suppressions, dispatches } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1")],
    reasons: { "fn-1-foo.1": "SPEC_UNCLEAR: ambiguous acceptance" },
  });
  await runBlockEscalationSweep(deps);

  // SPEC_UNCLEAR dispatches an unblock session; the autopilot re-dispatch path stays
  // open, so NO durable failure is minted.
  expect(dispatches).toEqual([{ epicId: "fn-1-foo", taskId: "fn-1-foo.1" }]);
  expect(suppressions).toEqual([]);
});

test("runBlockEscalationSweep: cancellation guard — a task that left blocked is skipped_unblocked, no dispatch", async () => {
  const { deps, mints, dispatches, notes } = fakeSweepDeps({
    // Latch still pending, but the live task already left blocked.
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1", { runtime_status: "todo" })],
    reasons: { "fn-1-foo.1": "SPEC_UNCLEAR: would-escalate-if-still-blocked" },
  });
  await runBlockEscalationSweep(deps);

  expect(dispatches).toEqual([]);
  expect(mints).toEqual([
    { kind: "requested", epicId: "fn-1-foo", taskId: "fn-1-foo.1" },
    {
      kind: "attempted",
      epicId: "fn-1-foo",
      taskId: "fn-1-foo.1",
      outcome: "skipped_unblocked",
    },
  ]);
  expect(notes).toEqual([
    "# block-escalation-drop task=fn-1-foo.1 class=not_blocked runtime_status=todo",
  ]);
});

test("runBlockEscalationSweep: per-epic serialization — two blocked tasks in one epic DISPATCH once, the sibling stays latched", async () => {
  const { deps, mints, dispatches } = fakeSweepDeps({
    pending: [
      blockedRow("fn-1-foo", "fn-1-foo.1"),
      blockedRow("fn-1-foo", "fn-1-foo.2"),
    ],
    reasons: {
      "fn-1-foo.1": "SPEC_UNCLEAR: a",
      "fn-1-foo.2": "DEPENDENCY_BLOCKED: b",
    },
  });
  await runBlockEscalationSweep(deps);

  // Exactly ONE unblock dispatch for the epic (the first row wins the claim).
  expect(dispatches).toEqual([{ epicId: "fn-1-foo", taskId: "fn-1-foo.1" }]);
  // The winner mints dispatched; the same-epic sibling mints NOTHING (stays pending,
  // re-sweeps once the live session goes terminal — no starvation, no collision).
  expect(mints).toEqual([
    { kind: "requested", epicId: "fn-1-foo", taskId: "fn-1-foo.1" },
    {
      kind: "attempted",
      epicId: "fn-1-foo",
      taskId: "fn-1-foo.1",
      outcome: "dispatched",
    },
  ]);
});

test("runBlockEscalationSweep: a sibling is NOT dispatched while the epic's unblock is already live (across-sweep guard)", async () => {
  const { deps, mints, dispatches, notes } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.2")],
    reasons: { "fn-1-foo.2": "SPEC_UNCLEAR: still blocked" },
    // A prior cycle already dispatched `unblock::fn-1-foo.1`, still live.
    epicLive: new Set(["fn-1-foo"]),
  });
  await runBlockEscalationSweep(deps);

  // The epic already holds its one live unblock → skip WITHOUT minting (stays latched).
  expect(dispatches).toEqual([]);
  expect(mints).toEqual([]);
  // The occupancy park is a SKIP, not a drop — observable, but re-sweepable.
  expect(notes).toEqual([
    "# block-escalation-skip epic=fn-1-foo task=fn-1-foo.2 class=epic_serialized",
  ]);
});

test("runBlockEscalationSweep: once the epic's unblock terminates, a pending sibling dispatches (none starved)", async () => {
  const { deps, mints, dispatches } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.2")],
    reasons: { "fn-1-foo.2": "SPEC_UNCLEAR: still blocked" },
    // The prior session went terminal → the epic is no longer live.
    epicLive: new Set(),
  });
  await runBlockEscalationSweep(deps);

  expect(dispatches).toEqual([{ epicId: "fn-1-foo", taskId: "fn-1-foo.2" }]);
  expect(mints).toEqual([
    { kind: "requested", epicId: "fn-1-foo", taskId: "fn-1-foo.2" },
    {
      kind: "attempted",
      epicId: "fn-1-foo",
      taskId: "fn-1-foo.2",
      outcome: "dispatched",
    },
  ]);
});

test("runBlockEscalationSweep: two DIFFERENT epics each get their own dispatch (serialization is per-epic)", async () => {
  const { deps, dispatches } = fakeSweepDeps({
    pending: [
      blockedRow("fn-1-foo", "fn-1-foo.1"),
      blockedRow("fn-2-bar", "fn-2-bar.1", { project_dir: "/proj2" }),
    ],
    reasons: {
      "fn-1-foo.1": "SPEC_UNCLEAR: a",
      "fn-2-bar.1": "SCOPE_EXCEEDED: b",
    },
  });
  await runBlockEscalationSweep(deps);

  expect(dispatches).toEqual([
    { epicId: "fn-1-foo", taskId: "fn-1-foo.1" },
    { epicId: "fn-2-bar", taskId: "fn-2-bar.1" },
  ]);
});

test("runBlockEscalationSweep: an at_cap skip mints NOTHING (row stays pending, re-sweeps)", async () => {
  const { deps, mints, dispatches, notes } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1")],
    reasons: { "fn-1-foo.1": "SPEC_UNCLEAR: a" },
    dispatch: async () => "at_cap",
  });
  await runBlockEscalationSweep(deps);

  // The dispatcher was consulted, but the cap skip mints no marker — the row re-sweeps.
  expect(dispatches.length).toBe(1);
  expect(mints).toEqual([]);
  expect(notes).toEqual([
    "# block-escalation-skip epic=fn-1-foo task=fn-1-foo.1 class=at_cap",
  ]);
});

test("runBlockEscalationSweep: an already_live skip (occupancy guard) mints NOTHING", async () => {
  const { deps, mints, notes } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1")],
    reasons: { "fn-1-foo.1": "SPEC_UNCLEAR: a" },
    dispatch: async () => "already_live",
  });
  await runBlockEscalationSweep(deps);
  expect(mints).toEqual([]);
  expect(notes).toEqual([
    "# block-escalation-skip epic=fn-1-foo task=fn-1-foo.1 class=already_live",
  ]);
});

test("runBlockEscalationSweep: a dispatch_failed outcome mints Requested→Attempted{dispatch_failed} (re-sweepable)", async () => {
  const { deps, mints } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1")],
    reasons: { "fn-1-foo.1": "EXTERNAL_BLOCKED: api down" },
    dispatch: async () => "dispatch_failed",
  });
  await runBlockEscalationSweep(deps);

  // dispatch_failed mints attempted{dispatch_failed} — the fold resets the latch to
  // pending, so the next sweep retries.
  expect(mints).toEqual([
    { kind: "requested", epicId: "fn-1-foo", taskId: "fn-1-foo.1" },
    {
      kind: "attempted",
      epicId: "fn-1-foo",
      taskId: "fn-1-foo.1",
      outcome: "dispatch_failed",
    },
  ]);
});

test("runBlockEscalationSweep: a THROWING dispatcher never aborts the sweep (records dispatch_failed)", async () => {
  const { deps, mints } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1")],
    reasons: { "fn-1-foo.1": "DESIGN_CONFLICT: clash" },
    dispatch: async () => {
      throw new Error("boom");
    },
  });
  // MUST resolve (never throw) and record a non-terminal outcome.
  await runBlockEscalationSweep(deps);
  expect(mints).toContainEqual({
    kind: "attempted",
    epicId: "fn-1-foo",
    taskId: "fn-1-foo.1",
    outcome: "dispatch_failed",
  });
});

test("runBlockEscalationSweep: an empty pending set is a no-op (no mints, no dispatches)", async () => {
  const { deps, mints, dispatches } = fakeSweepDeps({ pending: [] });
  await runBlockEscalationSweep(deps);
  expect(mints).toEqual([]);
  expect(dispatches).toEqual([]);
});

// ---- AUDIT_READY / AUDIT_SEVERE gate (the variable-depth per-task audit) -----

const AUDIT_READY_REASON = "AUDIT_READY: per-task audit parked this task";
const AUDIT_SEVERE_REASON =
  "AUDIT_SEVERE: verified-severe finding survived refute";

test("runBlockEscalationSweep: AUDIT_READY with a LIVE orchestrator defers — no dispatch, no mint (self-handled)", async () => {
  const { deps, mints, dispatches } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1")],
    reasons: { "fn-1-foo.1": AUDIT_READY_REASON },
    orchestrator: { "fn-1-foo.1": { state: "live" } },
    nowMs: 1_000_000,
  });
  await runBlockEscalationSweep(deps);

  // A live orchestrator owns the audit — the producer pages no one and mints
  // nothing, so the latch stays pending and re-sweeps.
  expect(dispatches).toEqual([]);
  expect(mints).toEqual([]);
});

test("runBlockEscalationSweep: AUDIT_READY with a DEAD orchestrator PAST grace escalates like any block (one unblock dispatch)", async () => {
  const { deps, mints, dispatches } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1")],
    reasons: { "fn-1-foo.1": AUDIT_READY_REASON },
    // Died 200s ago, grace is 120s — past grace → escalate.
    orchestrator: { "fn-1-foo.1": { state: "dead", diedAtMs: 800_000 } },
    nowMs: 1_000_000,
  });
  // Guard: the fixture's elapsed exceeds the grace we test against.
  expect(1_000_000 - 800_000).toBeGreaterThanOrEqual(
    AUDIT_READY_ORCHESTRATOR_GRACE_MS,
  );
  await runBlockEscalationSweep(deps);

  // A witnessed death past grace hands the park to the ordinary block path —
  // exactly one unblock dispatch, latch advanced pending→requested→attempted once.
  expect(dispatches).toEqual([{ epicId: "fn-1-foo", taskId: "fn-1-foo.1" }]);
  expect(mints).toEqual([
    { kind: "requested", epicId: "fn-1-foo", taskId: "fn-1-foo.1" },
    {
      kind: "attempted",
      epicId: "fn-1-foo",
      taskId: "fn-1-foo.1",
      outcome: "dispatched",
    },
  ]);
});

test("runBlockEscalationSweep: AUDIT_READY with a DEAD orchestrator WITHIN grace defers (no page yet)", async () => {
  const { deps, mints, dispatches } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1")],
    reasons: { "fn-1-foo.1": AUDIT_READY_REASON },
    // Died 50s ago, grace is 120s — inside the window → defer.
    orchestrator: { "fn-1-foo.1": { state: "dead", diedAtMs: 950_000 } },
    nowMs: 1_000_000,
  });
  expect(1_000_000 - 950_000).toBeLessThan(AUDIT_READY_ORCHESTRATOR_GRACE_MS);
  await runBlockEscalationSweep(deps);

  expect(dispatches).toEqual([]);
  expect(mints).toEqual([]);
});

test("runBlockEscalationSweep: AUDIT_READY with an ABSENT orchestrator defers (never pages a park it cannot attribute)", async () => {
  const { deps, mints, dispatches } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1")],
    reasons: { "fn-1-foo.1": AUDIT_READY_REASON },
    // No orchestrator entry → the gate reads `absent` → defer (no death witnessed).
    nowMs: 1_000_000,
  });
  await runBlockEscalationSweep(deps);

  expect(dispatches).toEqual([]);
  expect(mints).toEqual([]);
});

test("runBlockEscalationSweep: a deferred AUDIT_READY mints nothing across repeated sweeps (no per-cycle re-emit)", async () => {
  const { deps, mints, dispatches } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1")],
    reasons: { "fn-1-foo.1": AUDIT_READY_REASON },
    orchestrator: { "fn-1-foo.1": { state: "live" } },
    nowMs: 1_000_000,
  });
  await runBlockEscalationSweep(deps);
  await runBlockEscalationSweep(deps);

  // Two sweeps, still no marker — the defer path is a pure continue (change-gated
  // by minting nothing at all, so the latch never re-emits per cycle).
  expect(dispatches).toEqual([]);
  expect(mints).toEqual([]);
});

test("runBlockEscalationSweep: AUDIT_SEVERE escalates immediately like any block (orchestrator liveness ignored)", async () => {
  const { deps, mints, dispatches } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1")],
    reasons: { "fn-1-foo.1": AUDIT_SEVERE_REASON },
    // A live orchestrator MUST NOT suppress a severe finding — the deny gate
    // never consults liveness for AUDIT_SEVERE.
    orchestrator: { "fn-1-foo.1": { state: "live" } },
    nowMs: 1_000_000,
  });
  await runBlockEscalationSweep(deps);

  expect(dispatches).toEqual([{ epicId: "fn-1-foo", taskId: "fn-1-foo.1" }]);
  expect(mints).toEqual([
    { kind: "requested", epicId: "fn-1-foo", taskId: "fn-1-foo.1" },
    {
      kind: "attempted",
      epicId: "fn-1-foo",
      taskId: "fn-1-foo.1",
      outcome: "dispatched",
    },
  ]);
});

// ---- probeAuditOrchestrator / auditReadyEscalationDecision (pure) ------------

/** A synthetic owning-orchestrator jobs row: the liveness columns plus the
 *  `updated_at` death anchor `probeAuditOrchestrator` reads. */
function orchJob(
  planVerb: string,
  planRef: string,
  state: string,
  updatedAt: number,
): Job {
  return {
    plan_verb: planVerb,
    plan_ref: planRef,
    state,
    backend_exec_pane_id: null,
    updated_at: updatedAt,
  } as unknown as Job;
}

test("probeAuditOrchestrator: a working work::<task> session reads live", () => {
  const jobs: Job[] = [orchJob("work", "fn-1-foo.1", "working", 100)];
  expect(probeAuditOrchestrator(jobs, "fn-1-foo", "fn-1-foo.1")).toEqual({
    state: "live",
  });
});

test("probeAuditOrchestrator: a working close::<epic> session (covering the task's audit) reads live", () => {
  const jobs: Job[] = [orchJob("close", "fn-1-foo", "working", 100)];
  expect(probeAuditOrchestrator(jobs, "fn-1-foo", "fn-1-foo.1")).toEqual({
    state: "live",
  });
});

test("probeAuditOrchestrator: a stopped owner with a live backend reads live (shared isStoppedJobLive rule)", () => {
  const jobs: Job[] = [orchJob("work", "fn-1-foo.1", "stopped", 100)];
  expect(probeAuditOrchestrator(jobs, "fn-1-foo", "fn-1-foo.1")).toEqual({
    state: "live",
  });
});

test("probeAuditOrchestrator: only-dead owners read dead at the MOST-RECENT death (updated_at → ms)", () => {
  const jobs: Job[] = [
    orchJob("work", "fn-1-foo.1", "ended", 500),
    orchJob("close", "fn-1-foo", "killed", 700), // more recent death
  ];
  expect(probeAuditOrchestrator(jobs, "fn-1-foo", "fn-1-foo.1")).toEqual({
    state: "dead",
    diedAtMs: 700_000,
  });
});

test("probeAuditOrchestrator: a live owner wins over a dead sibling row", () => {
  const jobs: Job[] = [
    orchJob("work", "fn-1-foo.1", "ended", 500),
    orchJob("work", "fn-1-foo.1", "working", 900),
  ];
  expect(probeAuditOrchestrator(jobs, "fn-1-foo", "fn-1-foo.1")).toEqual({
    state: "live",
  });
});

test("probeAuditOrchestrator: no matching owner (wrong verb, wrong ref, sibling task) reads absent", () => {
  const jobs: Job[] = [
    orchJob("plan", "fn-1-foo", "working", 100), // wrong verb
    orchJob("work", "fn-9-other.1", "working", 100), // different epic
    orchJob("work", "fn-1-foo.2", "working", 100), // sibling task, not this task or its epic
  ];
  expect(probeAuditOrchestrator(jobs, "fn-1-foo", "fn-1-foo.1")).toEqual({
    state: "absent",
  });
});

test("auditReadyEscalationDecision: escalate only on a dead orchestrator past grace; defer otherwise", () => {
  const grace = 120_000;
  // Dead, elapsed exactly at grace → escalate (>=).
  expect(
    auditReadyEscalationDecision({ state: "dead", diedAtMs: 0 }, grace, grace),
  ).toBe("escalate");
  // Dead, elapsed just under grace → defer.
  expect(
    auditReadyEscalationDecision({ state: "dead", diedAtMs: 1 }, grace, grace),
  ).toBe("defer");
  // Live → defer regardless of clock.
  expect(
    auditReadyEscalationDecision({ state: "live" }, 10 * grace, grace),
  ).toBe("defer");
  // Absent → defer (no witnessed death).
  expect(
    auditReadyEscalationDecision({ state: "absent" }, 10 * grace, grace),
  ).toBe("defer");
});

test("runBlockEscalationSweep: a SHARED_BASE_BROKEN block routes to REPAIR — never dispatches an unblock, never surface-and-stops", async () => {
  // The repair route is owned by the sibling repair sweep, so the block sweep skips the
  // row WITHOUT minting: no unblock dispatch, no Requested/Attempted, no work:: suppression.
  const { deps, mints, dispatches, suppressions, notes } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1")],
    reasons: {
      "fn-1-foo.1": "SHARED_BASE_BROKEN: `bun test` red at base sha abc1234",
    },
  });
  await runBlockEscalationSweep(deps);
  expect(dispatches).toEqual([]);
  expect(mints).toEqual([]);
  expect(suppressions).toEqual([]);
  // Silent hand-off to the sibling repair sweep still leaves a class-stable trace —
  // this is the exact gate that starved the repair route in production.
  expect(notes).toEqual([
    "# block-escalation-drop task=fn-1-foo.1 class=repair category=SHARED_BASE_BROKEN",
  ]);
});

test("runBlockEscalationSweep: an empty effective repo drops the row (no dispatch attempt) with a class-stable trace", async () => {
  const { deps, mints, dispatches, notes } = fakeSweepDeps({
    // Both `target_repo` and `project_dir` resolve empty — the injected reader
    // (unlike the production `readTaskBlockedReason`) doesn't tie reason-readability
    // to `project_dir`, so this row reaches the dedicated repo guard.
    pending: [
      blockedRow("fn-1-foo", "fn-1-foo.1", {
        project_dir: null,
        target_repo: null,
      }),
    ],
    reasons: { "fn-1-foo.1": "SPEC_UNCLEAR: a" },
  });
  await runBlockEscalationSweep(deps);

  expect(dispatches).toEqual([]);
  expect(mints).toEqual([]);
  expect(notes).toEqual([
    "# block-escalation-drop task=fn-1-foo.1 class=empty_repo target_repo=null project_dir=null",
  ]);
});

test("runBlockEscalationSweep: every reachable candidate-drop gate emits its class-stable diagnostic", async () => {
  const { deps, notes } = fakeSweepDeps({
    pending: [
      // (1) not_blocked: the latch is pending but the live task left `blocked`.
      blockedRow("fn-1-nb", "fn-1-nb.1", { runtime_status: "todo" }),
      // (2) reason_unreadable: blocked, but no reason on file.
      blockedRow("fn-2-ur", "fn-2-ur.1"),
      // (3) repair: a SHARED_BASE_BROKEN category hands off to the sibling sweep.
      blockedRow("fn-3-rp", "fn-3-rp.1"),
      // (4) surface_and_stop: a readable, non-escalatable category.
      blockedRow("fn-4-ss", "fn-4-ss.1"),
      // (5) empty_repo: readable + escalatable, but no resolvable repo.
      blockedRow("fn-5-er", "fn-5-er.1", {
        project_dir: null,
        target_repo: null,
      }),
    ],
    reasons: {
      "fn-3-rp.1": "SHARED_BASE_BROKEN: base red at HEAD",
      "fn-4-ss.1": "TOOLING_FAILURE: the runner is broken",
      "fn-5-er.1": "SPEC_UNCLEAR: a",
    },
  });
  await runBlockEscalationSweep(deps);

  // Each silent-drop gate now leaves a greppable trace, keyed by class — one line
  // per dropped candidate, never more.
  const classes = notes.map((n) => n.match(/class=(\w+)/)?.[1]).sort();
  expect(classes).toEqual([
    "empty_repo",
    "not_blocked",
    "reason_unreadable",
    "repair",
    "surface_and_stop",
  ]);
  const byTask = (t: string) => notes.find((n) => n.includes(`task=${t}`));
  expect(byTask("fn-1-nb.1")).toContain("class=not_blocked");
  expect(byTask("fn-2-ur.1")).toContain("class=reason_unreadable");
  expect(byTask("fn-3-rp.1")).toContain("class=repair");
  expect(byTask("fn-4-ss.1")).toContain("class=surface_and_stop");
  expect(byTask("fn-5-er.1")).toContain("class=empty_repo");
});

test("runBlockEscalationSweep: candidate-drop diagnostics are class-stable across repeated sweeps on unchanged state (safe to dedupe)", async () => {
  const { deps, notes } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1", { runtime_status: "todo" })],
  });
  await runBlockEscalationSweep(deps);
  const firstPass = [...notes];
  await runBlockEscalationSweep(deps);
  const secondPass = notes.slice(firstPass.length);

  expect(firstPass).toEqual([
    "# block-escalation-drop task=fn-1-foo.1 class=not_blocked runtime_status=todo",
  ]);
  // Unchanged state re-emits the BYTE-IDENTICAL line on the next cycle — no live
  // age or churn folded in, so a log viewer can dedupe across ticks.
  expect(secondPass).toEqual(firstPass);
});

test("BlockCandidateDropClass: the class union is stable (alarm/grep contract)", () => {
  const classes: BlockCandidateDropClass[] = [
    "not_blocked",
    "reason_unreadable",
    "repair",
    "surface_and_stop",
    "empty_repo",
  ];
  expect(classes.length).toBe(5);
});

// ---- routeBlockedCategory (the category→handler dispatch table / shared seam) --

test("routeBlockedCategory: the three routes are keyed by category", () => {
  // SHARED_BASE_BROKEN → repair; TOOLING_FAILURE / null / unparseable → surface_and_stop;
  // every other escalatable category → unblock.
  expect(routeBlockedCategory(SHARED_BASE_BROKEN_CATEGORY)).toBe("repair");
  expect(routeBlockedCategory(BLOCK_ESCALATION_SKIP_CATEGORY)).toBe(
    "surface_and_stop",
  );
  expect(routeBlockedCategory(null)).toBe("surface_and_stop");
  for (const c of [
    "SPEC_UNCLEAR",
    "DEPENDENCY_BLOCKED",
    "DESIGN_CONFLICT",
    "SCOPE_EXCEEDED",
    "EXTERNAL_BLOCKED",
    "RESUME_EXHAUSTED",
  ]) {
    expect(routeBlockedCategory(c)).toBe("unblock");
  }
});

// ---- runRepairEscalationSweep (SHARED_BASE_BROKEN repair core, injected deps) --

interface RepairMint {
  kind: "row" | "dispatched" | "notified" | "clear";
  token: string;
  reason?: string;
  dir?: string | null;
  outcome?: string;
}

function repairCandidate(
  epicId: string,
  taskId: string,
  overrides: Partial<RepairCandidate> = {},
): RepairCandidate {
  return {
    epic_id: epicId,
    task_id: taskId,
    repo_dir: "/repo",
    repo_token: "repo-abc",
    fingerprint: "fp1",
    ...overrides,
  };
}

function repairRow(
  overrides: Partial<PendingRepairRow> = {},
): PendingRepairRow {
  return {
    id: "repo-abc",
    reason: "shared-base-broken:fp1",
    dir: "/repo",
    repair_dispatched_at: null,
    human_notified_at: null,
    ...overrides,
  };
}

function fakeRepairSweepDeps(opts: {
  candidates?: RepairCandidate[];
  rows?: PendingRepairRow[];
  /** repo_dirs whose shared checkout is DIRTY (DEFER). */
  dirty?: Set<string>;
  /** repo_dir → active shared-checkout-dirty distress row id (defer-note naming). */
  activeDirty?: Map<string, string>;
  /** repo_dirs whose base reads GREEN (positive-evidence clear gate). */
  green?: Set<string>;
  dispatch?: (group: RepairGroup) => Promise<EscalationDispatchOutcome>;
  repairOutcome?: (token: string) => ResolverOutcome;
  notify?: (
    row: PendingRepairRow,
    verdict: "declined" | "died",
  ) => Promise<RepairHumanNotifiedOutcome>;
  candidatesThrow?: boolean;
  rowsThrow?: boolean;
}): {
  deps: RepairEscalationSweepDeps;
  mints: RepairMint[];
  dispatches: RepairGroup[];
  notifies: { token: string; verdict: "declined" | "died" }[];
  notes: string[];
} {
  const mints: RepairMint[] = [];
  const dispatches: RepairGroup[] = [];
  const notifies: { token: string; verdict: "declined" | "died" }[] = [];
  const notes: string[] = [];
  const deps: RepairEscalationSweepDeps = {
    noteLine: (line) => notes.push(line),
    selectCandidates: () => {
      if (opts.candidatesThrow) throw new Error("candidate read boom");
      return opts.candidates ?? [];
    },
    selectRepairRows: () => {
      if (opts.rowsThrow) throw new Error("row read boom");
      return opts.rows ?? [];
    },
    isDirtyCheckout: (dir) => opts.dirty?.has(dir) ?? false,
    activeDirtyDistressId: (dir) => opts.activeDirty?.get(dir) ?? null,
    isBaseGreen: (dir) => opts.green?.has(dir) ?? false,
    dispatchRepair: async (group) => {
      dispatches.push(group);
      return (await opts.dispatch?.(group)) ?? "dispatched";
    },
    repairOutcome:
      opts.repairOutcome ?? (() => ({ terminal: true, verdict: "declined" })),
    notifyHuman: async (row, verdict) => {
      notifies.push({ token: row.id, verdict });
      return (await opts.notify?.(row, verdict)) ?? "notified";
    },
    mintRow: (group) =>
      mints.push({
        kind: "row",
        token: group.repo_token,
        reason: repairReasonFor(group.fingerprint),
        dir: group.repo_dir,
      }),
    mintDispatched: (token, outcome) =>
      mints.push({ kind: "dispatched", token, outcome }),
    mintNotified: (token, outcome) =>
      mints.push({ kind: "notified", token, outcome }),
    clearRow: (token) => mints.push({ kind: "clear", token }),
  };
  return { deps, mints, dispatches, notifies, notes };
}

test("runRepairEscalationSweep: N SHARED_BASE_BROKEN tasks across epics on ONE repo+fingerprint → exactly one dispatch + one sticky row", async () => {
  const { deps, mints, dispatches } = fakeRepairSweepDeps({
    candidates: [
      repairCandidate("fn-1-foo", "fn-1-foo.2"),
      repairCandidate("fn-1-foo", "fn-1-foo.3"),
      repairCandidate("fn-2-bar", "fn-2-bar.1"),
    ],
  });
  await runRepairEscalationSweep(deps);
  // Coalesced to ONE repair for the repo token.
  expect(dispatches).toEqual([
    { repo_token: "repo-abc", repo_dir: "/repo", fingerprint: "fp1" },
  ]);
  expect(mints).toEqual([
    {
      kind: "row",
      token: "repo-abc",
      reason: "shared-base-broken:fp1",
      dir: "/repo",
    },
    { kind: "dispatched", token: "repo-abc", outcome: "dispatched" },
  ]);
});

test("runRepairEscalationSweep: two distinct repos each dispatch under the cap (independent tokens)", async () => {
  const { deps, dispatches } = fakeRepairSweepDeps({
    candidates: [
      repairCandidate("fn-1-foo", "fn-1-foo.2", {
        repo_dir: "/a",
        repo_token: "a-111",
        fingerprint: "fpa",
      }),
      repairCandidate("fn-2-bar", "fn-2-bar.1", {
        repo_dir: "/b",
        repo_token: "b-222",
        fingerprint: "fpb",
      }),
    ],
  });
  await runRepairEscalationSweep(deps);
  expect(dispatches.map((g) => g.repo_token).sort()).toEqual([
    "a-111",
    "b-222",
  ]);
});

test("runRepairEscalationSweep: a dirty shared checkout DEFERS — no dispatch, no row minted, no attempt, but leaves an observable trace", async () => {
  const { deps, mints, dispatches, notes } = fakeRepairSweepDeps({
    candidates: [repairCandidate("fn-1-foo", "fn-1-foo.2")],
    dirty: new Set(["/repo"]),
  });
  await runRepairEscalationSweep(deps);
  expect(dispatches).toEqual([]);
  expect(mints).toEqual([]);
  // Regression guard (fn-1198): the incident dirty-defer was invisible — every defer
  // MUST now emit a class-stable, token+dir-keyed diagnostic so a starving repair route
  // is greppable instead of looking like a dead feature. With no ACTIVE dirt distress row
  // yet (sustained dirt has not crossed grace), the note carries no `distress=` suffix.
  expect(notes).toEqual([
    "# repair-defer token=repo-abc class=dirty_checkout dir=/repo",
  ]);
});

test("runRepairEscalationSweep: a dirty defer NAMES the active shared-checkout-dirty distress row (one incident, two consumers)", async () => {
  // Once sustained dirt has crossed grace and minted its per-repo distress row, the
  // repair-defer trace names that SAME row so a greppable defer and the operator-visible
  // needs-human row are the one incident — the whole point of routing the two consumers
  // (the sweep defer + the distress family) through one `shared-checkout-dirty:<hash>` id.
  const distressId = `${SHARED_DIRTY_DISTRESS_ID_PREFIX}abc123`;
  const { deps, mints, dispatches, notes } = fakeRepairSweepDeps({
    candidates: [repairCandidate("fn-1-foo", "fn-1-foo.2")],
    dirty: new Set(["/repo"]),
    activeDirty: new Map([["/repo", distressId]]),
  });
  await runRepairEscalationSweep(deps);
  // Still a pure DEFER — no dispatch, no repair row minted (the naming is diagnostic-only).
  expect(dispatches).toEqual([]);
  expect(mints).toEqual([]);
  expect(notes).toEqual([
    `# repair-defer token=repo-abc class=dirty_checkout dir=/repo distress=${distressId}`,
  ]);
});

test("buildSharedDirtyObservation: candidate-scoped GENUINE dirt mints; unseeded/clean never; open rows RETAIN until observed clean", () => {
  const clean = "/clean";
  const dirtyRepo = "/dirty";
  const unseeded = "/unseeded";
  const staleRepo = "/stale"; // an open distress row's repo, no live candidate
  // Hand-computed dirty_count fixtures (an independent source of truth, never re-derived).
  const counts = new Map<string, number | null>([
    [clean, 0],
    [dirtyRepo, 3],
    [unseeded, null],
    [staleRepo, 2],
  ]);
  const dirtyCount = (dir: string) =>
    counts.has(dir) ? (counts.get(dir) as number | null) : null;

  const candidates = [
    repairCandidate("fn-1-a", "fn-1-a.1", {
      repo_dir: clean,
      repo_token: "clean-t",
    }),
    repairCandidate("fn-2-b", "fn-2-b.1", {
      repo_dir: dirtyRepo,
      repo_token: "dirty-t",
    }),
    repairCandidate("fn-3-c", "fn-3-c.1", {
      repo_dir: unseeded,
      repo_token: "unseeded-t",
    }),
  ];
  // Two open distress rows: one whose checkout is still dirty (RETAIN), one now clean (DROP).
  const openRows = [
    { id: `${SHARED_DIRTY_DISTRESS_ID_PREFIX}stale`, dir: staleRepo },
    { id: `${SHARED_DIRTY_DISTRESS_ID_PREFIX}wasdirty`, dir: clean },
  ];

  const obs = buildSharedDirtyObservation(candidates, openRows, dirtyCount);

  // MINT: only the genuinely-dirty candidate (dirty_count > 0) is observed. A clean
  // candidate (0) and an unseeded/unknown one (null) never enter the map (no page on the
  // human's own clean checkout, no false page on an unseeded surface).
  expect(obs.has(dirtyRepo)).toBe(true);
  expect(obs.has(clean)).toBe(false);
  expect(obs.has(unseeded)).toBe(false);
  // RETAIN: the open distress row whose checkout is STILL dirty stays in the map so the
  // tracker's level-clear retains it — cleared ONLY on observed clean, never on the
  // candidate resolving elsewhere while dirt remains.
  expect(obs.has(staleRepo)).toBe(true);
  // The exact set — no extra keys leaked in.
  expect([...obs.keys()].sort()).toEqual([dirtyRepo, staleRepo].sort());
});

test("runRepairEscalationSweep: an at_cap dispatch mints the sticky row but NO RepairDispatched (re-sweeps), with an observable skip trace", async () => {
  const { deps, mints, dispatches, notes } = fakeRepairSweepDeps({
    candidates: [repairCandidate("fn-1-foo", "fn-1-foo.2")],
    dispatch: async () => "at_cap",
  });
  await runRepairEscalationSweep(deps);
  expect(dispatches.length).toBe(1);
  // The latch is minted (durable), but repair_dispatched_at stays NULL (no RepairDispatched).
  expect(mints).toEqual([
    {
      kind: "row",
      token: "repo-abc",
      reason: "shared-base-broken:fp1",
      dir: "/repo",
    },
  ]);
  expect(notes).toEqual(["# repair-skip token=repo-abc class=at_cap"]);
});

test("runRepairEscalationSweep: a dispatch_failed mints RepairDispatched{dispatch_failed} (non-terminal, re-sweeps)", async () => {
  const { deps, mints } = fakeRepairSweepDeps({
    candidates: [repairCandidate("fn-1-foo", "fn-1-foo.2")],
    dispatch: async () => "dispatch_failed",
  });
  await runRepairEscalationSweep(deps);
  expect(mints).toContainEqual({
    kind: "dispatched",
    token: "repo-abc",
    outcome: "dispatch_failed",
  });
});

test("runRepairEscalationSweep: a LIVE repair (row dispatched, session not terminal) → no re-dispatch, no page", async () => {
  const { deps, mints, dispatches, notifies } = fakeRepairSweepDeps({
    candidates: [repairCandidate("fn-1-foo", "fn-1-foo.2")],
    rows: [repairRow({ repair_dispatched_at: 100 })],
    repairOutcome: () => ({ terminal: false }),
  });
  await runRepairEscalationSweep(deps);
  expect(dispatches).toEqual([]);
  expect(notifies).toEqual([]);
  expect(mints).toEqual([]);
});

test("runRepairEscalationSweep: a DECLINED repair (dispatched, terminal, candidates remain) pages the human ONCE", async () => {
  const { deps, mints, dispatches, notifies } = fakeRepairSweepDeps({
    candidates: [repairCandidate("fn-1-foo", "fn-1-foo.2")],
    rows: [repairRow({ repair_dispatched_at: 100 })],
    repairOutcome: () => ({ terminal: true, verdict: "declined" }),
  });
  await runRepairEscalationSweep(deps);
  expect(dispatches).toEqual([]);
  expect(notifies).toEqual([{ token: "repo-abc", verdict: "declined" }]);
  expect(mints).toEqual([
    { kind: "notified", token: "repo-abc", outcome: "notified" },
  ]);
});

test("runRepairEscalationSweep: an already-paged repair does NOT re-page and does NOT re-dispatch (sticky until retry)", async () => {
  const { deps, mints, dispatches, notifies } = fakeRepairSweepDeps({
    candidates: [repairCandidate("fn-1-foo", "fn-1-foo.2")],
    rows: [repairRow({ repair_dispatched_at: 100, human_notified_at: 200 })],
  });
  await runRepairEscalationSweep(deps);
  expect(dispatches).toEqual([]);
  expect(notifies).toEqual([]);
  expect(mints).toEqual([]);
});

test("runRepairEscalationSweep: a notify_failed leaves the page marker unset (re-sweepable, never silent)", async () => {
  const { deps, mints } = fakeRepairSweepDeps({
    candidates: [repairCandidate("fn-1-foo", "fn-1-foo.2")],
    rows: [repairRow({ repair_dispatched_at: 100 })],
    notify: async () => "notify_failed",
  });
  await runRepairEscalationSweep(deps);
  expect(mints).toEqual([
    { kind: "notified", token: "repo-abc", outcome: "notify_failed" },
  ]);
});

test("runRepairEscalationSweep: positive-evidence CLEAR — a row with zero candidates + green base clears", async () => {
  const { deps, mints, dispatches } = fakeRepairSweepDeps({
    candidates: [],
    rows: [repairRow({ repair_dispatched_at: 100 })],
    green: new Set(["/repo"]),
  });
  await runRepairEscalationSweep(deps);
  expect(dispatches).toEqual([]);
  expect(mints).toEqual([{ kind: "clear", token: "repo-abc" }]);
});

test("runRepairEscalationSweep: a row with zero candidates but a NON-green base is RETAINED (no report)", async () => {
  const { deps, mints } = fakeRepairSweepDeps({
    candidates: [],
    rows: [repairRow({ repair_dispatched_at: 100 })],
    green: new Set(), // base not green / unknown → retain
  });
  await runRepairEscalationSweep(deps);
  expect(mints).toEqual([]);
});

test("runRepairEscalationSweep: a row whose token STILL has candidates is never cleared (owned by dispatch/notify)", async () => {
  const { deps, mints } = fakeRepairSweepDeps({
    candidates: [repairCandidate("fn-1-foo", "fn-1-foo.2")],
    rows: [repairRow({ repair_dispatched_at: 100 })],
    green: new Set(["/repo"]), // green, but candidates remain → NOT cleared
    repairOutcome: () => ({ terminal: false }),
  });
  await runRepairEscalationSweep(deps);
  expect(mints.find((m) => m.kind === "clear")).toBeUndefined();
});

test("runRepairEscalationSweep: empty candidates + empty rows is a no-op", async () => {
  const { deps, mints, dispatches } = fakeRepairSweepDeps({});
  await runRepairEscalationSweep(deps);
  expect(mints).toEqual([]);
  expect(dispatches).toEqual([]);
});

test("runRepairEscalationSweep: a throwing candidate read degrades to a no-op (fail-open)", async () => {
  const { deps, mints, dispatches } = fakeRepairSweepDeps({
    candidatesThrow: true,
    rows: [repairRow()],
  });
  await runRepairEscalationSweep(deps);
  expect(mints).toEqual([]);
  expect(dispatches).toEqual([]);
});

// ---- runSharedCheckoutPageSweep (dirty/desync distress page-once, injected deps) --

interface SharedCheckoutPageMint {
  id: string;
  outcome: SharedCheckoutNotifiedOutcome;
}

function sharedCheckoutRow(
  id: string,
  overrides: Partial<SharedCheckoutPageRow> = {},
): SharedCheckoutPageRow {
  return {
    id,
    dir: "/repo",
    reason: `${id}: /repo has stayed live past the grace window`,
    ...overrides,
  };
}

/**
 * Fake-deps fixture for the pure page-once sweep. The `live` map models the OPEN,
 * not-yet-paged working set the daemon reader returns; a terminal `notified` mint
 * models the fold stamping `human_notified_at` (the row drops out of `IS NULL`
 * selection), while a `notify_failed` mint is a no-op (the row stays live and
 * re-sweeps). No real daemon / botctl / DB.
 */
function fakeSharedCheckoutPageDeps(opts: {
  rows?: SharedCheckoutPageRow[];
  notify?: (
    row: SharedCheckoutPageRow,
  ) => Promise<SharedCheckoutNotifiedOutcome>;
  rowsThrow?: boolean;
}): {
  deps: SharedCheckoutPageSweepDeps;
  mints: SharedCheckoutPageMint[];
  pages: string[];
  notes: string[];
  live: Map<string, SharedCheckoutPageRow>;
} {
  const mints: SharedCheckoutPageMint[] = [];
  const pages: string[] = [];
  const notes: string[] = [];
  const live = new Map((opts.rows ?? []).map((r) => [r.id, r] as const));
  const deps: SharedCheckoutPageSweepDeps = {
    noteLine: (line) => notes.push(line),
    selectUnpaged: () => {
      if (opts.rowsThrow) throw new Error("row read boom");
      return [...live.values()];
    },
    notifyHuman: async (row) => {
      pages.push(row.id);
      return (await opts.notify?.(row)) ?? "notified";
    },
    mintNotified: (id, outcome) => {
      mints.push({ id, outcome });
      // Fold-sim: the terminal `notified` stamps human_notified_at → the row drops
      // out of the unpaged set; a `notify_failed` is a no-op (stays live, re-sweeps).
      if (outcome === "notified") live.delete(id);
    },
  };
  return { deps, mints, pages, notes, live };
}

test("runSharedCheckoutPageSweep: pages each OPEN dirty/desync row ONCE, then a stamped row never re-pages", async () => {
  const { deps, mints, pages } = fakeSharedCheckoutPageDeps({
    rows: [
      sharedCheckoutRow("shared-checkout-dirty:abc"),
      sharedCheckoutRow("shared-checkout-desync:def"),
    ],
  });
  await runSharedCheckoutPageSweep(deps);
  expect(pages).toEqual([
    "shared-checkout-dirty:abc",
    "shared-checkout-desync:def",
  ]);
  expect(mints).toEqual([
    { id: "shared-checkout-dirty:abc", outcome: "notified" },
    { id: "shared-checkout-desync:def", outcome: "notified" },
  ]);
  // A second heartbeat: both rows now carry human_notified_at (dropped from the
  // unpaged set) → no re-page, page-once per row instance honored.
  await runSharedCheckoutPageSweep(deps);
  expect(pages).toHaveLength(2);
  expect(mints).toHaveLength(2);
});

test("runSharedCheckoutPageSweep: a notify_failed leaves the row unpaged (re-sweeps and pages again next heartbeat)", async () => {
  let attempt = 0;
  const { deps, mints, pages } = fakeSharedCheckoutPageDeps({
    rows: [sharedCheckoutRow("shared-checkout-dirty:abc")],
    notify: async () => (++attempt === 1 ? "notify_failed" : "notified"),
  });
  // Tick 1: the botctl send FAILS → non-terminal, marker stays NULL.
  await runSharedCheckoutPageSweep(deps);
  expect(pages).toEqual(["shared-checkout-dirty:abc"]);
  expect(mints).toEqual([
    { id: "shared-checkout-dirty:abc", outcome: "notify_failed" },
  ]);
  // Tick 2: the row is STILL unpaged → pages again, succeeds this time.
  await runSharedCheckoutPageSweep(deps);
  expect(pages).toEqual([
    "shared-checkout-dirty:abc",
    "shared-checkout-dirty:abc",
  ]);
  expect(mints[1]).toEqual({
    id: "shared-checkout-dirty:abc",
    outcome: "notified",
  });
  // Tick 3: now stamped → silent.
  await runSharedCheckoutPageSweep(deps);
  expect(pages).toHaveLength(2);
});

test("runSharedCheckoutPageSweep: a cleared-then-reminted row pages ANEW (fresh incident episode)", async () => {
  const { deps, mints, pages, live } = fakeSharedCheckoutPageDeps({
    rows: [sharedCheckoutRow("shared-checkout-desync:def")],
  });
  await runSharedCheckoutPageSweep(deps); // pages + stamps → drops out
  expect(pages).toEqual(["shared-checkout-desync:def"]);
  await runSharedCheckoutPageSweep(deps); // stamped → silent
  expect(pages).toHaveLength(1);
  // The producer's observed-clean level-clear DELETEs the row; after a fresh grace it
  // re-mints at human_notified_at NULL (the DispatchCleared re-arm) — modeled by
  // re-inserting into the live working set.
  live.set(
    "shared-checkout-desync:def",
    sharedCheckoutRow("shared-checkout-desync:def"),
  );
  await runSharedCheckoutPageSweep(deps); // re-minted → pages anew
  expect(pages).toEqual([
    "shared-checkout-desync:def",
    "shared-checkout-desync:def",
  ]);
  expect(mints.filter((m) => m.outcome === "notified")).toHaveLength(2);
});

test("runSharedCheckoutPageSweep: a throwing notify degrades to notify_failed (fail-open, re-sweepable)", async () => {
  const { deps, mints, notes } = fakeSharedCheckoutPageDeps({
    rows: [sharedCheckoutRow("shared-checkout-dirty:abc")],
    notify: async () => {
      throw new Error("botctl spawn boom");
    },
  });
  await runSharedCheckoutPageSweep(deps);
  expect(mints).toEqual([
    { id: "shared-checkout-dirty:abc", outcome: "notify_failed" },
  ]);
  expect(notes.some((n) => n.includes("shared-checkout page threw"))).toBe(
    true,
  );
});

test("runSharedCheckoutPageSweep: a throwing row read degrades to a no-op (fail-open)", async () => {
  const { deps, mints, pages } = fakeSharedCheckoutPageDeps({
    rowsThrow: true,
    rows: [sharedCheckoutRow("shared-checkout-dirty:abc")],
  });
  await runSharedCheckoutPageSweep(deps);
  expect(pages).toEqual([]);
  expect(mints).toEqual([]);
});

test("runSharedCheckoutPageSweep: an empty working set pages nobody (the shape a paused/clean board presents past the inherited heartbeat gate)", async () => {
  // Pause + boot-catch-up suppression is the repair-escalation TICK's inherited
  // early-return (`if (autopilotPaused) return`), upstream of this sweep — a paused
  // board never even calls it. The pure sweep's own contract: page exactly the OPEN
  // unpaged rows, so an empty set is a no-op.
  const { deps, mints, pages } = fakeSharedCheckoutPageDeps({ rows: [] });
  await runSharedCheckoutPageSweep(deps);
  expect(pages).toEqual([]);
  expect(mints).toEqual([]);
});

test("buildSharedCheckoutPageBody: names the repo and picks dirty-vs-desync wording by id prefix", () => {
  const dirty = buildSharedCheckoutPageBody({
    id: "shared-checkout-dirty:abc",
    dir: "/repo",
    reason: "x",
  });
  expect(dirty).toContain("/repo");
  expect(dirty).toContain("DIRTY");
  expect(dirty).not.toContain("DESYNCED");

  const desync = buildSharedCheckoutPageBody({
    id: "shared-checkout-desync:def",
    dir: "/repo",
    reason: "x",
  });
  expect(desync).toContain("DESYNCED");

  // A null dir renders a placeholder, never the literal "null".
  const noDir = buildSharedCheckoutPageBody({
    id: "shared-checkout-dirty:abc",
    dir: null,
    reason: "x",
  });
  expect(noDir).toContain("repo ?");
  expect(noDir).not.toContain("null");
});

test("repairReasonFor: the mint-side reason matches escalation-brief's REPAIR_REASON_RE", () => {
  const reason = repairReasonFor("abc123");
  expect(reason).toBe("shared-base-broken:abc123");
  // The exact contract cli/escalation-brief.ts parses.
  expect(reason).toMatch(/^shared-base-broken:\s*(\S+)/);
});

// ---- selectRepairCandidates round-trip (fn-1198 regression) ------------------
//
// The repair route NEVER fired in production: the first four SHARED_BASE_BROKEN
// blocks all sat pending for hours with zero repair dispatch. Root cause (confirmed
// via replayable keeper.db GitSnapshot events): the shared checkout `/Users/mike/code/
// keeper` on `main` held dirty_count >= 3 for the entire incident window, so the
// repair sweep's `isDirtyCheckout` DEFER `continue`d on every ~60s tick — minting no
// row, dispatching nothing, and (the actual bug) emitting NO diagnostic, so the
// non-dispatch was indistinguishable from a dead feature. The candidate gates UPSTREAM
// of the defer were all healthy — proven here by round-tripping a reason through the
// EXACT plan-`block`-verb on-disk contract into the sweep's REAL reader (no mocked
// reason-read: that is the reader/writer-mismatch bug class this guards against).

/** Write a task's runtime state file in the EXACT shape the plan `block` verb lands
 *  (`LocalFileStateStore.saveRuntime`: top-level `blocked_reason` + `status`), so the
 *  daemon's real {@link readTaskBlockedReason} round-trips a genuine block write. */
function writeBlockedStateFile(
  projectDir: string,
  taskId: string,
  blockedReason: string,
): void {
  const dir = join(projectDir, ".keeper", "state", "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${taskId}.state.json`),
    `${JSON.stringify(
      {
        assignee: null,
        blocked_reason: blockedReason,
        claim_note: "",
        claimed_at: null,
        evidence: null,
        status: "blocked",
        updated_at: "2026-07-08T00:00:00.000000Z",
      },
      null,
      2,
    )}\n`,
  );
}

test("readTaskBlockedReason: round-trips a real block-written state file (reader contract)", () => {
  const proj = join(tmpDir, "proj");
  writeBlockedStateFile(
    proj,
    "fn-1-foo.1",
    "SHARED_BASE_BROKEN: origin/main red",
  );
  expect(readTaskBlockedReason(proj, "fn-1-foo.1")).toBe(
    "SHARED_BASE_BROKEN: origin/main red",
  );
  // Every miss folds to null (no file, no project dir) — never a throw.
  expect(readTaskBlockedReason(proj, "fn-1-foo.9")).toBeNull();
  expect(readTaskBlockedReason(null, "fn-1-foo.1")).toBeNull();
});

test("selectRepairCandidates: a SHARED_BASE_BROKEN block written by the real writer + read by the real reader yields a repair candidate", () => {
  const { db } = freshMemDb();
  const proj = join(tmpDir, "proj");
  // Real plan-state block write (exact on-disk contract) — NOT a mocked reason.
  writeBlockedStateFile(
    proj,
    "fn-1-foo.1",
    "SHARED_BASE_BROKEN: main HEAD red on 4 pre-existing tests, baseline-confirmed",
  );
  seedEpicWithTasks(db, "fn-1-foo", proj, [
    { task_id: "fn-1-foo.1", runtime_status: "blocked", target_repo: proj },
  ]);
  seedBlockLatch(db, "fn-1-foo", "fn-1-foo.1");

  const notes: string[] = [];
  const candidates = selectRepairCandidates(db, readTaskBlockedReason, (l) =>
    notes.push(l),
  );
  expect(candidates.length).toBe(1);
  expect(candidates[0]?.task_id).toBe("fn-1-foo.1");
  expect(candidates[0]?.repo_dir).toBe(proj);
  // A produced candidate drops nothing → no diagnostic.
  expect(notes).toEqual([]);
  db.close();
});

test("selectRepairCandidates: the real round-trip drives an actual dispatch decision at the pure sweep seam (clean checkout)", async () => {
  const { db } = freshMemDb();
  const proj = join(tmpDir, "proj");
  writeBlockedStateFile(
    proj,
    "fn-1-foo.1",
    "SHARED_BASE_BROKEN: base red at HEAD",
  );
  seedEpicWithTasks(db, "fn-1-foo", proj, [
    { task_id: "fn-1-foo.1", runtime_status: "blocked", target_repo: proj },
  ]);
  seedBlockLatch(db, "fn-1-foo", "fn-1-foo.1");

  // Feed the REAL candidate selector into the sweep; clean checkout (dirty set empty).
  const dispatches: RepairGroup[] = [];
  await runRepairEscalationSweep({
    selectCandidates: () => selectRepairCandidates(db, readTaskBlockedReason),
    selectRepairRows: () => [],
    isDirtyCheckout: () => false,
    isBaseGreen: () => false,
    dispatchRepair: async (group) => {
      dispatches.push(group);
      return "dispatched";
    },
    repairOutcome: () => ({ terminal: false }),
    notifyHuman: async () => "notified",
    mintRow: () => {},
    mintDispatched: () => {},
    mintNotified: () => {},
    clearRow: () => {},
  });
  // One sweep invocation → one repair dispatch decision for the repo.
  expect(dispatches.length).toBe(1);
  expect(dispatches[0]?.repo_dir).toBe(proj);
  db.close();
});

test("selectRepairCandidates: a non-repair category (SPEC_UNCLEAR) yields NO candidate and a class-stable drop diagnostic (no over-dispatch)", () => {
  const { db } = freshMemDb();
  const proj = join(tmpDir, "proj");
  writeBlockedStateFile(
    proj,
    "fn-1-foo.1",
    "SPEC_UNCLEAR: the acceptance is ambiguous",
  );
  seedEpicWithTasks(db, "fn-1-foo", proj, [
    { task_id: "fn-1-foo.1", runtime_status: "blocked", target_repo: proj },
  ]);
  seedBlockLatch(db, "fn-1-foo", "fn-1-foo.1");

  const notes: string[] = [];
  const candidates = selectRepairCandidates(db, readTaskBlockedReason, (l) =>
    notes.push(l),
  );
  expect(candidates).toEqual([]);
  expect(notes).toEqual([
    "# repair-candidate-drop task=fn-1-foo.1 class=non_repair_category category=SPEC_UNCLEAR",
  ]);
  db.close();
});

test("selectRepairCandidates: an inconclusive base gate down-categorized to TOOLING_FAILURE yields NO repair candidate (timeout-aware attestation, daemon-side)", () => {
  // A starved / timed-out base gate is INCONCLUSIVE, not a confirmed base red: the
  // worker guidance routes it to TOOLING_FAILURE, never SHARED_BASE_BROKEN. The daemon
  // trusts that category token as the sole red-vs-inconclusive discriminator, so a
  // TOOLING_FAILURE block mints no repair candidate — a starved gate can never fabricate
  // a repair::<repo> distress row. A genuine SHARED_BASE_BROKEN still mints (round-trip
  // case above), so the confirmed-red safety net is unchanged.
  const { db } = freshMemDb();
  const proj = join(tmpDir, "proj");
  writeBlockedStateFile(
    proj,
    "fn-1-foo.1",
    "TOOLING_FAILURE: base gate timed out (starved host); inconclusive, not a confirmed base red",
  );
  seedEpicWithTasks(db, "fn-1-foo", proj, [
    { task_id: "fn-1-foo.1", runtime_status: "blocked", target_repo: proj },
  ]);
  seedBlockLatch(db, "fn-1-foo", "fn-1-foo.1");

  const notes: string[] = [];
  const candidates = selectRepairCandidates(db, readTaskBlockedReason, (l) =>
    notes.push(l),
  );
  expect(candidates).toEqual([]);
  expect(notes).toEqual([
    "# repair-candidate-drop task=fn-1-foo.1 class=non_repair_category category=TOOLING_FAILURE",
  ]);
  db.close();
});

test("selectRepairCandidates: every reachable candidate-drop gate emits its class-stable diagnostic", () => {
  const { db } = freshMemDb();
  const proj = join(tmpDir, "proj");
  // (1) not_blocked: latch pending but runtime left blocked (belt-and-braces vs the
  // leave-blocked latch DELETE).
  seedEpicWithTasks(db, "fn-1-nb", proj, [
    { task_id: "fn-1-nb.1", runtime_status: "todo", target_repo: proj },
  ]);
  seedBlockLatch(db, "fn-1-nb", "fn-1-nb.1");
  // (2) reason_unreadable: blocked, but no state file on disk — the reader/writer
  // mismatch bug class the incident feared (here simulated as an absent file).
  seedEpicWithTasks(db, "fn-2-ur", proj, [
    { task_id: "fn-2-ur.1", runtime_status: "blocked", target_repo: proj },
  ]);
  seedBlockLatch(db, "fn-2-ur", "fn-2-ur.1");
  // (3) non_repair_category: a readable but non-repair category (ordinary block).
  writeBlockedStateFile(
    proj,
    "fn-3-nr.1",
    "DEPENDENCY_BLOCKED: waiting on fn-9",
  );
  seedEpicWithTasks(db, "fn-3-nr", proj, [
    { task_id: "fn-3-nr.1", runtime_status: "blocked", target_repo: proj },
  ]);
  seedBlockLatch(db, "fn-3-nr", "fn-3-nr.1");

  const notes: string[] = [];
  const candidates = selectRepairCandidates(db, readTaskBlockedReason, (l) =>
    notes.push(l),
  );
  expect(candidates).toEqual([]);
  // Each silent-drop gate now leaves a greppable trace, keyed by class.
  const classes = notes.map((n) => n.match(/class=(\w+)/)?.[1]).sort();
  expect(classes).toEqual([
    "non_repair_category",
    "not_blocked",
    "reason_unreadable",
  ]);
  const byTask = (t: string) => notes.find((n) => n.includes(`task=${t}`));
  expect(byTask("fn-1-nb.1")).toContain("class=not_blocked");
  expect(byTask("fn-2-ur.1")).toContain("class=reason_unreadable");
  expect(byTask("fn-3-nr.1")).toContain("class=non_repair_category");
  db.close();
});

test("RepairCandidateDropClass: the class union is stable (alarm/grep contract)", () => {
  // `empty_repo` is a defensive guard: since the reason-read keys on `project_dir`, a
  // readable reason implies a non-empty `project_dir`, which makes the effective repo
  // non-empty — so the gate cannot fire today, but the class stays part of the
  // greppable contract in case the read seam ever changes. `empty_token` covers the
  // sibling sweep-side gate: a candidate with an empty repo token or dir is dropped
  // before it can be coalesced into a repair group.
  const classes: RepairCandidateDropClass[] = [
    "not_blocked",
    "reason_unreadable",
    "non_repair_category",
    "empty_repo",
    "empty_token",
  ];
  expect(classes.length).toBe(5);
});

// ---- fn-1203 baseline-sourced repair candidate source ------------------------

const BL_TC: ToolchainFingerprint = {
  bunVersion: "1.3.14",
  platform: "test-x64",
};

function greenLeaf(sha = "aaaaaaa"): GreenResult {
  return {
    key: `k-${sha}`,
    sha,
    toolchain: BL_TC,
    computedAt: 1000,
    status: "green",
    runs: [{ startedAt: 0, durationMs: 1, exitCode: 0, failingTests: [] }],
  };
}

/** A suite-red leaf with `runs` runs, `hard` tests failing every run (flakySuspect
 *  false) and `flaky` tests marked flakySuspect — the two shapes the confirmed-red gate
 *  discriminates. */
function suiteRedLeaf(opts: {
  runs: number;
  hard?: string[];
  flaky?: string[];
  sha?: string;
}): SuiteRedResult {
  const sha = opts.sha ?? "bbbbbbb";
  const allIds = [...(opts.hard ?? []), ...(opts.flaky ?? [])];
  return {
    key: `k-${sha}`,
    sha,
    toolchain: BL_TC,
    computedAt: 1000,
    status: "suite-red",
    failing: [
      ...(opts.hard ?? []).map((id) => ({ id, flakySuspect: false })),
      ...(opts.flaky ?? []).map((id) => ({ id, flakySuspect: true })),
    ],
    runs: Array.from({ length: opts.runs }, (_, i) => ({
      startedAt: i,
      durationMs: 1,
      exitCode: 1,
      failingTests: allIds,
    })),
  };
}

function infraLeaf(sha = "ccccccc"): InfraErrorResult {
  return {
    key: `k-${sha}`,
    sha,
    toolchain: BL_TC,
    computedAt: 1000,
    status: "infra-error",
    kind: "checkout",
    message: "checkout failed",
  };
}

function timeoutLeaf(sha = "ddddddd"): TimeoutResult {
  return {
    key: `k-${sha}`,
    sha,
    toolchain: BL_TC,
    computedAt: 1000,
    status: "timeout",
    deadlineMs: 60000,
    runs: [],
  };
}

test("classifyBaselineForRepair: a confirmed suite-red (>=2 runs + a hard fail) is confirmed-red", () => {
  expect(
    classifyBaselineForRepair(suiteRedLeaf({ runs: 2, hard: ["alpha_fail"] })),
  ).toBe("confirmed-red");
});

test("classifyBaselineForRepair: a single-run red is rerun — a single run has no flake signal", () => {
  expect(
    classifyBaselineForRepair(suiteRedLeaf({ runs: 1, hard: ["alpha_fail"] })),
  ).toBe("rerun");
});

test("classifyBaselineForRepair: an all-flaky suite-red (fail-then-pass) is rerun, not a dispatch", () => {
  expect(
    classifyBaselineForRepair(suiteRedLeaf({ runs: 2, flaky: ["alpha_fail"] })),
  ).toBe("rerun");
});

test("classifyBaselineForRepair: green / infra-error / timeout / null are none (never red)", () => {
  expect(classifyBaselineForRepair(greenLeaf())).toBe("none");
  expect(classifyBaselineForRepair(infraLeaf())).toBe("none");
  expect(classifyBaselineForRepair(timeoutLeaf())).toBe("none");
  expect(classifyBaselineForRepair(null)).toBe("none");
});

test("baselineRedIsConfirmed: requires BOTH >=2 runs AND a non-flaky failure", () => {
  expect(baselineRedIsConfirmed(suiteRedLeaf({ runs: 2, hard: ["a"] }))).toBe(
    true,
  );
  // Single run — the confirming re-run never ran.
  expect(baselineRedIsConfirmed(suiteRedLeaf({ runs: 1, hard: ["a"] }))).toBe(
    false,
  );
  // Two runs but every failure flaky (fail-then-pass).
  expect(baselineRedIsConfirmed(suiteRedLeaf({ runs: 2, flaky: ["a"] }))).toBe(
    false,
  );
  // A mixed leaf is confirmed on its hard failure.
  expect(
    baselineRedIsConfirmed(
      suiteRedLeaf({ runs: 2, hard: ["a"], flaky: ["b"] }),
    ),
  ).toBe(true);
});

test("buildBaselineRepairCandidates: a confirmed-red leaf with ZERO blocked tasks yields exactly one task-less candidate", () => {
  const notes: string[] = [];
  const out = buildBaselineRepairCandidates(
    [
      {
        repoDir: "/repo",
        leaf: suiteRedLeaf({ runs: 2, hard: ["alpha_fail"] }),
      },
    ],
    (l) => notes.push(l),
  );
  expect(out.length).toBe(1);
  const c = out[0] as RepairCandidate;
  expect(c.repo_dir).toBe("/repo");
  expect(c.repo_token).toBe(repoToken("/repo"));
  expect(c.task_id).toBe(`baseline-tip::${repoToken("/repo")}`);
  expect(c.epic_id).toBe("");
  expect(c.fingerprint.length).toBeGreaterThan(0);
  // A confirmed-red is a candidate, NOT a rerun trace.
  expect(notes).toEqual([]);
});

test("buildBaselineRepairCandidates: a single-run red yields NO candidate + a class=single_run rerun trace", () => {
  const notes: string[] = [];
  const out = buildBaselineRepairCandidates(
    [
      {
        repoDir: "/repo",
        leaf: suiteRedLeaf({ runs: 1, hard: ["alpha_fail"], sha: "deadbee" }),
      },
    ],
    (l) => notes.push(l),
  );
  expect(out).toEqual([]);
  expect(notes).toEqual([
    "# baseline-repair-rerun repo=/repo sha=deadbee class=single_run",
  ]);
});

test("buildBaselineRepairCandidates: a flake-suspect red yields NO candidate + a class=flake_suspect rerun trace", () => {
  const notes: string[] = [];
  const out = buildBaselineRepairCandidates(
    [
      {
        repoDir: "/repo",
        leaf: suiteRedLeaf({ runs: 2, flaky: ["alpha_fail"], sha: "beefbee" }),
      },
    ],
    (l) => notes.push(l),
  );
  expect(out).toEqual([]);
  expect(notes).toEqual([
    "# baseline-repair-rerun repo=/repo sha=beefbee class=flake_suspect",
  ]);
});

test("buildBaselineRepairCandidates: infra / timeout / green / null / empty-dir yield nothing (no candidate, no rerun)", () => {
  const notes: string[] = [];
  const out = buildBaselineRepairCandidates(
    [
      { repoDir: "/a", leaf: infraLeaf() },
      { repoDir: "/b", leaf: timeoutLeaf() },
      { repoDir: "/c", leaf: greenLeaf() },
      { repoDir: "/d", leaf: null },
      { repoDir: "", leaf: suiteRedLeaf({ runs: 2, hard: ["x"] }) },
    ],
    (l) => notes.push(l),
  );
  expect(out).toEqual([]);
  expect(notes).toEqual([]);
});

test("runRepairEscalationSweep: a confirmed-red baseline candidate with ZERO blocked tasks drives ONE dispatch + one sticky row", async () => {
  const baseline = buildBaselineRepairCandidates([
    { repoDir: "/repo", leaf: suiteRedLeaf({ runs: 2, hard: ["alpha_fail"] }) },
  ]);
  const { deps, mints, dispatches } = fakeRepairSweepDeps({
    candidates: baseline,
  });
  await runRepairEscalationSweep(deps);
  expect(dispatches.length).toBe(1);
  expect((dispatches[0] as RepairGroup).repo_token).toBe(repoToken("/repo"));
  expect(mints.filter((m) => m.kind === "row").length).toBe(1);
  expect(mints.filter((m) => m.kind === "dispatched").length).toBe(1);
});

test("runRepairEscalationSweep: a worker-stamped block + a baseline-red candidate on one repo+fingerprint coalesce to ONE sticky", async () => {
  const baseline = buildBaselineRepairCandidates([
    { repoDir: "/repo", leaf: suiteRedLeaf({ runs: 2, hard: ["alpha_fail"] }) },
  ]);
  const bc = baseline[0] as RepairCandidate;
  // A worker-sourced candidate on the SAME repo (same token) + SAME fingerprint.
  const worker: RepairCandidate = {
    epic_id: "fn-9-x",
    task_id: "fn-9-x.1",
    repo_dir: bc.repo_dir,
    repo_token: bc.repo_token,
    fingerprint: bc.fingerprint,
  };
  const { deps, mints, dispatches } = fakeRepairSweepDeps({
    candidates: [worker, bc],
  });
  await runRepairEscalationSweep(deps);
  // Coalesced by repo token → exactly one dispatch + one sticky row.
  expect(dispatches.length).toBe(1);
  expect((dispatches[0] as RepairGroup).repo_token).toBe(bc.repo_token);
  expect(mints.filter((m) => m.kind === "row").length).toBe(1);
  expect(mints.filter((m) => m.kind === "dispatched").length).toBe(1);
});

test("repairCheckoutDirty (DEFER gate): dirty (>0) or unseeded (null) defers; a clean 0 does not", () => {
  expect(repairCheckoutDirty(null)).toBe(true);
  expect(repairCheckoutDirty(3)).toBe(true);
  expect(repairCheckoutDirty(0)).toBe(false);
});

test("repairTipBaselineGreen (CLEAR gate): green ONLY on a suite-green leaf; red / infra / timeout / null retain", () => {
  expect(repairTipBaselineGreen(greenLeaf())).toBe(true);
  expect(repairTipBaselineGreen(suiteRedLeaf({ runs: 2, hard: ["a"] }))).toBe(
    false,
  );
  expect(repairTipBaselineGreen(infraLeaf())).toBe(false);
  expect(repairTipBaselineGreen(timeoutLeaf())).toBe(false);
  expect(repairTipBaselineGreen(null)).toBe(false);
});

test("the suite-green and checkout-clean gates are DISTINCT: a clean checkout does not imply suite-green", () => {
  // The exact ambiguity the gap analysis named: a checkout can be pristine (nothing to
  // commit) while the suite is red at that tip. The DEFER gate reads clean; the CLEAR
  // gate reads NOT green — the sweep must never conflate them into one "green".
  expect(repairCheckoutDirty(0)).toBe(false); // checkout clean → not deferred
  expect(
    repairTipBaselineGreen(suiteRedLeaf({ runs: 2, hard: ["alpha_fail"] })),
  ).toBe(false); // suite red at tip → row RETAINED
});

test("baselineRepairFingerprint: deterministic + stable across sha/flaky noise, keyed on the hard failures", () => {
  const a = baselineRepairFingerprint(
    suiteRedLeaf({
      runs: 2,
      hard: ["alpha_fail", "beta_fail"],
      sha: "1111111",
    }),
  );
  const b = baselineRepairFingerprint(
    suiteRedLeaf({
      runs: 2,
      hard: ["alpha_fail", "beta_fail"],
      flaky: ["gamma_fail"],
      sha: "2222222",
    }),
  );
  // Same hard failures — a different sha + an extra flaky test are incidental noise.
  expect(a).toBe(b);
  // A structurally different failure set fingerprints differently.
  expect(
    baselineRepairFingerprint(suiteRedLeaf({ runs: 2, hard: ["zeta_fail"] })),
  ).not.toBe(a);
});

// ---- epicHasLiveUnblock (per-epic serialization liveness) --------------------

test("epicHasLiveUnblock: true iff a LIVE unblock:: session exists for a task in the epic", () => {
  const jobs: Job[] = [
    escJob("unblock", "fn-1-foo.2", "working"), // live, epic fn-1-foo
    escJob("unblock", "fn-2-bar.1", "ended"), // terminal — not live
    escJob("deconflict", "fn-1-foo", "working"), // wrong verb (deconflict keys on epic)
    escJob("work", "fn-1-foo.9", "working"), // a plain worker — not an escalation
  ];
  expect(epicHasLiveUnblock(jobs, "fn-1-foo")).toBe(true);
  // The unblock for fn-2-bar is terminal → not live.
  expect(epicHasLiveUnblock(jobs, "fn-2-bar")).toBe(false);
  // No unblock session maps to this epic.
  expect(epicHasLiveUnblock(jobs, "fn-9-none")).toBe(false);
  expect(epicHasLiveUnblock([], "fn-1-foo")).toBe(false);
  // A stopped (finished, idling) unblock session no longer serializes its epic —
  // turn-active occupancy releases the per-epic slot on turn end, so a sibling re-block
  // in the same epic can dispatch.
  expect(
    epicHasLiveUnblock(
      [escJob("unblock", "fn-1-foo.5", "stopped")],
      "fn-1-foo",
    ),
  ).toBe(false);
});

// ---- buildBlockHumanNotifyBody (pure stage-3 notification body) --------------

test("buildBlockHumanNotifyBody: names the task, the epic, the declined verdict, and the unblock command", () => {
  const body = buildBlockHumanNotifyBody({
    epicId: "fn-9-foo",
    taskId: "fn-9-foo.2",
    verdict: "declined",
  });
  expect(body).toContain("fn-9-foo.2");
  expect(body).toContain("fn-9-foo");
  expect(body).toContain("DECLINED");
  expect(body).toContain("keeper plan unblock fn-9-foo.2");
});

test("buildBlockHumanNotifyBody: a died verdict names the death", () => {
  const body = buildBlockHumanNotifyBody({
    epicId: "fn-9-foo",
    taskId: "fn-9-foo.2",
    verdict: "died",
  });
  expect(body).toContain("DIED");
  expect(body).toContain("keeper plan unblock fn-9-foo.2");
});

// ---- selectPendingBlockHumanNotifications (the stage-3 working-set read) ------

/** Seed one `block_escalations` latch row with the full stage-3 column set. */
function seedFullBlockLatch(
  db: ReturnType<typeof openDb>["db"],
  epicId: string,
  taskId: string,
  status: string,
  outcome: string | null,
  humanNotifiedAt: number | null,
): void {
  db.run(
    `INSERT INTO block_escalations (epic_id, task_id, blocked_since, status, outcome, last_event_id, human_notified_at)
       VALUES (?, ?, 1, ?, ?, 1, ?)`,
    [epicId, taskId, status, outcome, humanNotifiedAt],
  );
}

test("selectPendingBlockHumanNotifications: picks only dispatched-but-not-notified latches", () => {
  const { db } = freshMemDb();
  // Dispatched, human not yet notified → SELECTED (the stage-3 working set).
  seedFullBlockLatch(
    db,
    "fn-1-foo",
    "fn-1-foo.1",
    "attempted",
    "dispatched",
    null,
  );
  // Not-yet-dispatched (a skipped_category terminal — no session ran) → dropped.
  seedFullBlockLatch(
    db,
    "fn-2-tool",
    "fn-2-tool.1",
    "attempted",
    "skipped_category",
    null,
  );
  // Still pending (stage 2 owns it) → dropped.
  seedFullBlockLatch(db, "fn-3-pend", "fn-3-pend.1", "pending", null, null);
  // Already human-notified → dropped (notify-once).
  seedFullBlockLatch(
    db,
    "fn-4-done",
    "fn-4-done.1",
    "attempted",
    "dispatched",
    333,
  );

  const rows = selectPendingBlockHumanNotifications(db);
  expect(rows).toEqual([{ epic_id: "fn-1-foo", task_id: "fn-1-foo.1" }]);
  db.close();
});

test("selectPendingBlockHumanNotifications: empty table returns []", () => {
  const { db } = freshMemDb();
  expect(selectPendingBlockHumanNotifications(db)).toEqual([]);
  db.close();
});

// ---- runBlockHumanNotifySweep (stage-3 orchestration core, injected deps) -----

interface BlockHumanNotifyMintCall {
  epicId: string;
  taskId: string;
  outcome: BlockHumanNotifiedOutcome;
}

function fakeBlockHumanNotifySweepDeps(opts: {
  pending: PendingBlockHumanNotify[];
  stillPending?: (epicId: string, taskId: string) => boolean;
  unblockOutcome?: (taskId: string) => ResolverOutcome;
  notify?: (
    row: PendingBlockHumanNotify,
    verdict: "declined" | "died",
  ) => Promise<BlockHumanNotifiedOutcome>;
  selectThrows?: boolean;
}): {
  deps: BlockHumanNotifySweepDeps;
  mints: BlockHumanNotifyMintCall[];
  notifies: { taskId: string; verdict: "declined" | "died" }[];
} {
  const mints: BlockHumanNotifyMintCall[] = [];
  const notifies: { taskId: string; verdict: "declined" | "died" }[] = [];
  const deps: BlockHumanNotifySweepDeps = {
    selectPending: () => {
      if (opts.selectThrows) throw new Error("read boom");
      return opts.pending;
    },
    stillPending: opts.stillPending ?? (() => true),
    // Default: the unblock session already declined (terminal), so the notify fires.
    unblockOutcome:
      opts.unblockOutcome ?? (() => ({ terminal: true, verdict: "declined" })),
    notifyHuman: async (row, verdict) => {
      notifies.push({ taskId: row.task_id, verdict });
      return (await opts.notify?.(row, verdict)) ?? "notified";
    },
    mintAttempted: (epicId, taskId, outcome) =>
      mints.push({ epicId, taskId, outcome }),
  };
  return { deps, mints, notifies };
}

function blockNotifyPending(): PendingBlockHumanNotify[] {
  return [{ epic_id: "fn-1-foo", task_id: "fn-1-foo.1" }];
}

test("runBlockHumanNotifySweep: a declined unblock notifies the human ONCE and mints notified", async () => {
  const { deps, mints, notifies } = fakeBlockHumanNotifySweepDeps({
    pending: blockNotifyPending(),
  });
  await runBlockHumanNotifySweep(deps);
  expect(notifies).toEqual([{ taskId: "fn-1-foo.1", verdict: "declined" }]);
  expect(mints).toEqual([
    { epicId: "fn-1-foo", taskId: "fn-1-foo.1", outcome: "notified" },
  ]);
});

test("runBlockHumanNotifySweep: a DIED unblock notifies once and carries the died verdict", async () => {
  const { deps, mints, notifies } = fakeBlockHumanNotifySweepDeps({
    pending: blockNotifyPending(),
    unblockOutcome: () => ({ terminal: true, verdict: "died" }),
  });
  await runBlockHumanNotifySweep(deps);
  expect(notifies).toEqual([{ taskId: "fn-1-foo.1", verdict: "died" }]);
  expect(mints).toEqual([
    { epicId: "fn-1-foo", taskId: "fn-1-foo.1", outcome: "notified" },
  ]);
});

test("runBlockHumanNotifySweep: a notify_failed leaves the marker unset (re-sweepable, never silent)", async () => {
  const { deps, mints } = fakeBlockHumanNotifySweepDeps({
    pending: blockNotifyPending(),
    notify: async () => "notify_failed",
  });
  await runBlockHumanNotifySweep(deps);
  expect(mints).toEqual([
    { epicId: "fn-1-foo", taskId: "fn-1-foo.1", outcome: "notify_failed" },
  ]);
});

test("runBlockHumanNotifySweep: a THROWING notify never aborts the sweep (records notify_failed)", async () => {
  const { deps, mints } = fakeBlockHumanNotifySweepDeps({
    pending: blockNotifyPending(),
    notify: async () => {
      throw new Error("botctl boom");
    },
  });
  await runBlockHumanNotifySweep(deps);
  expect(mints).toEqual([
    { epicId: "fn-1-foo", taskId: "fn-1-foo.1", outcome: "notify_failed" },
  ]);
});

test("runBlockHumanNotifySweep: a live/not-yet-terminal unblock defers — no notify, no mint", async () => {
  const { deps, mints, notifies } = fakeBlockHumanNotifySweepDeps({
    pending: blockNotifyPending(),
    unblockOutcome: () => ({ terminal: false }),
  });
  await runBlockHumanNotifySweep(deps);
  expect(notifies).toEqual([]);
  expect(mints).toEqual([]);
});

test("runBlockHumanNotifySweep: a row cleared mid-sweep (stillPending false, e.g. the task got unblocked) is skipped", async () => {
  const { deps, mints, notifies } = fakeBlockHumanNotifySweepDeps({
    pending: blockNotifyPending(),
    stillPending: () => false,
  });
  await runBlockHumanNotifySweep(deps);
  expect(notifies).toEqual([]);
  expect(mints).toEqual([]);
});

test("runBlockHumanNotifySweep: an empty pending set is a no-op", async () => {
  const { deps, mints, notifies } = fakeBlockHumanNotifySweepDeps({
    pending: [],
  });
  await runBlockHumanNotifySweep(deps);
  expect(mints).toEqual([]);
  expect(notifies).toEqual([]);
});

test("runBlockHumanNotifySweep: a throwing selectPending degrades to a no-op (fail-open)", async () => {
  const { deps, mints, notifies } = fakeBlockHumanNotifySweepDeps({
    pending: [],
    selectThrows: true,
  });
  await runBlockHumanNotifySweep(deps);
  expect(mints).toEqual([]);
  expect(notifies).toEqual([]);
});

// ---------------------------------------------------------------------------
// fn-1009 task .2 — daemon worktree-merge-conflict close-escalation producer
// ---------------------------------------------------------------------------

// The EXACT ` — ` separator the autopilot mints (src/autopilot-worker.ts) — a
// space + U+2014 em-dash + space. Pin it: the reason parser splits on this exact
// sequence, so a drift in the producer string must break this test, not silently
// degrade every escalation body to a parse-miss.
const EM_DASH = "—";
function mergeConflictReason(
  source: string,
  base: string,
  stderr = "CONFLICT (content): Merge conflict in src/foo.ts",
): string {
  return `worktree-merge-conflict: merging ${source} into ${base} ${EM_DASH} ${stderr}`;
}

test("MERGE_ESCALATION_REASON_TOKEN is the exact worktree-merge-conflict leading token", () => {
  expect(MERGE_ESCALATION_REASON_TOKEN).toBe("worktree-merge-conflict");
});

test("shouldEscalateMergeConflict: exact leading-token gate — only worktree-merge-conflict escalates", () => {
  expect(
    shouldEscalateMergeConflict(
      mergeConflictReason("fn-9-foo.2", "keeper/epic/fn-9-foo"),
    ),
  ).toBe(true);
  // The excluded siblings — a `worktree-merge` PREFIX must NOT match.
  expect(
    shouldEscalateMergeConflict(
      "worktree-merge-lock-timeout: could not acquire the lock",
    ),
  ).toBe(false);
  expect(
    shouldEscalateMergeConflict(
      "worktree-merge-local-timeout: a local git op timed out",
    ),
  ).toBe(false);
  expect(
    shouldEscalateMergeConflict(
      "worktree-finalize-non-fast-forward: origin is ahead",
    ),
  ).toBe(false);
  expect(
    shouldEscalateMergeConflict(
      "worktree-recover-dirty: lane has uncommitted work",
    ),
  ).toBe(false);
  // A longer token that merely STARTS with the token string is not an exact match.
  expect(
    shouldEscalateMergeConflict("worktree-merge-conflict-extra: nope"),
  ).toBe(false);
  // No colon / empty / null → false.
  expect(shouldEscalateMergeConflict("worktree-merge-conflict")).toBe(false);
  expect(shouldEscalateMergeConflict("")).toBe(false);
  expect(shouldEscalateMergeConflict(null)).toBe(false);
});

// ---- selectPendingMergeEscalations (the current-state working-set read) -----

function seedMergeFailureRow(
  db: ReturnType<typeof openDb>["db"],
  args: {
    verb: string;
    id: string;
    reason: string;
    dir?: string | null;
    mergeEscalatedAt?: number | null;
    resolverDispatchedAt?: number | null;
  },
): void {
  db.run(
    `INSERT INTO dispatch_failures
       (verb, id, reason, dir, ts, last_event_id, created_at, updated_at, merge_escalated_at, resolver_dispatched_at)
       VALUES (?, ?, ?, ?, 1, 1, 1, 1, ?, ?)`,
    [
      args.verb,
      args.id,
      args.reason,
      args.dir ?? null,
      args.mergeEscalatedAt ?? null,
      args.resolverDispatchedAt ?? null,
    ],
  );
}

test("selectPendingMergeEscalations: picks only close rows with an exact worktree-merge-conflict token, a NULL escalate marker, and a dispatched resolver", () => {
  const { db } = freshMemDb();
  // Escalatable: a sticky close merge conflict, not yet escalated, whose resolver has
  // already been dispatched (resolver_dispatched_at set) — the escalation sequences
  // behind the resolver.
  seedMergeFailureRow(db, {
    verb: "close",
    id: "fn-1-foo",
    reason: mergeConflictReason("fn-1-foo.2", "keeper/epic/fn-1-foo"),
    dir: "/repo/root",
    resolverDispatchedAt: 555,
  });
  // Resolver NOT yet dispatched (a fresh row, or the window after a retry re-armed
  // both markers) → dropped: the resolver owns the conflict first.
  seedMergeFailureRow(db, {
    verb: "close",
    id: "fn-8-nores",
    reason: mergeConflictReason("fn-8-nores.1", "keeper/epic/fn-8-nores"),
    dir: "/repo/root",
  });
  // Already escalated (marker set) → dropped.
  seedMergeFailureRow(db, {
    verb: "close",
    id: "fn-2-bar",
    reason: mergeConflictReason("fn-2-bar.1", "keeper/epic/fn-2-bar"),
    dir: "/repo/root",
    mergeEscalatedAt: 12345,
  });
  // Excluded reasons on a close row — a `worktree-merge` prefix must NOT match.
  seedMergeFailureRow(db, {
    verb: "close",
    id: "fn-3-lock",
    reason: "worktree-merge-lock-timeout: could not acquire the lock",
  });
  seedMergeFailureRow(db, {
    verb: "close",
    id: "fn-4-local",
    reason: "worktree-merge-local-timeout: a local git op timed out",
  });
  seedMergeFailureRow(db, {
    verb: "close",
    id: "fn-5-nonff",
    reason: "worktree-finalize-non-fast-forward: origin is ahead",
  });
  seedMergeFailureRow(db, {
    verb: "close",
    id: "fn-6-recover",
    reason: "worktree-recover-dirty: lane has uncommitted work",
  });
  // A WORK row carrying the same reason token — wrong verb, dropped.
  seedMergeFailureRow(db, {
    verb: "work",
    id: "fn-7-foo.1",
    reason: mergeConflictReason("fn-7-foo.1", "keeper/epic/fn-7-foo"),
  });

  const rows = selectPendingMergeEscalations(db);
  expect(rows).toEqual([
    {
      id: "fn-1-foo",
      reason: mergeConflictReason("fn-1-foo.2", "keeper/epic/fn-1-foo"),
      dir: "/repo/root",
    },
  ]);
  db.close();
});

test("selectPendingMergeEscalations: empty table returns []", () => {
  const { db } = freshMemDb();
  expect(selectPendingMergeEscalations(db)).toEqual([]);
  db.close();
});

// ---- buildDeconflictHumanNotifyBody (pure stage-3 notification body) ----------

test("buildDeconflictHumanNotifyBody: names the epic, the declined verdict, and the unstick command", () => {
  const body = buildDeconflictHumanNotifyBody({
    epicId: "fn-9-foo",
    reason: mergeConflictReason("fn-9-foo.2", "keeper/epic/fn-9-foo"),
    verdict: "declined",
  });
  expect(body).toContain("deconflict::fn-9-foo");
  // Names the deconflict session's verdict — both tiers gave up, so the human is the
  // final fallback.
  expect(body).toContain("DECLINED");
  expect(body).toContain("close::fn-9-foo");
  // The single unstick command the operator runs after resolving by hand.
  expect(body).toContain("keeper autopilot retry close::fn-9-foo");
  // The free-text reason rides as a body line.
  expect(body).toContain("CONFLICT (content): Merge conflict in src/foo.ts");
});

test("buildDeconflictHumanNotifyBody: a died verdict names the death (never throws on an unparseable reason)", () => {
  const body = buildDeconflictHumanNotifyBody({
    epicId: "fn-9-foo",
    reason: "worktree-merge-conflict: something unparseable happened",
    verdict: "died",
  });
  expect(body).toContain("deconflict::fn-9-foo");
  expect(body).toContain("DIED");
  expect(body).toContain("keeper autopilot retry close::fn-9-foo");
});

// ---- runMergeEscalationSweep (deconflict-dispatch core, injected deps) --------

interface MergeMintCall {
  id: string;
  outcome: MergeEscalationOutcome;
}

function fakeMergeSweepDeps(opts: {
  pending: PendingMergeEscalation[];
  stillPending?: (id: string) => boolean;
  resolverOutcome?: (id: string) => ResolverOutcome;
  dispatch?: (
    row: PendingMergeEscalation,
  ) => Promise<EscalationDispatchOutcome>;
  selectThrows?: boolean;
}): {
  deps: MergeEscalationSweepDeps;
  mints: MergeMintCall[];
  dispatches: PendingMergeEscalation[];
} {
  const mints: MergeMintCall[] = [];
  const dispatches: PendingMergeEscalation[] = [];
  const deps: MergeEscalationSweepDeps = {
    selectPending: () => {
      if (opts.selectThrows) throw new Error("read boom");
      return opts.pending;
    },
    stillPending: opts.stillPending ?? (() => true),
    // Default: the resolver already reached a terminal verdict, so the deconflict
    // dispatch fires (the pre-sequencing behaviour these tests assert). Cases that
    // exercise the wait override this.
    resolverOutcome:
      opts.resolverOutcome ?? (() => ({ terminal: true, verdict: "declined" })),
    dispatchDeconflict: async (row) => {
      dispatches.push(row);
      return (await opts.dispatch?.(row)) ?? "dispatched";
    },
    mintAttempted: (id, outcome) => mints.push({ id, outcome }),
  };
  return { deps, mints, dispatches };
}

test("runMergeEscalationSweep: a terminal-resolver close dispatches ONE deconflict and mints attempted{dispatched} (no planner@ send)", async () => {
  const { deps, mints, dispatches } = fakeMergeSweepDeps({
    pending: [
      {
        id: "fn-1-foo",
        reason: mergeConflictReason("fn-1-foo.2", "keeper/epic/fn-1-foo"),
        dir: "/repo/root",
      },
    ],
  });
  await runMergeEscalationSweep(deps);

  // Exactly one deconflict dispatch for the epic — and no planner@ bus message (the
  // deps surface has no notify path at all now).
  expect(dispatches.length).toBe(1);
  expect(dispatches[0]?.id).toBe("fn-1-foo");
  // Mints the terminal outcome — and NEVER a DispatchCleared (the sticky row is cleared
  // only by retry_dispatch).
  expect(mints).toEqual([{ id: "fn-1-foo", outcome: "dispatched" }]);
});

test("runMergeEscalationSweep: a non-token reason in the pending set is NOT dispatched (defense-in-depth gate)", async () => {
  const { deps, mints, dispatches } = fakeMergeSweepDeps({
    pending: [
      {
        id: "fn-1-foo",
        reason: "worktree-merge-lock-timeout: could not acquire the lock",
        dir: "/repo/root",
      },
    ],
  });
  await runMergeEscalationSweep(deps);
  expect(dispatches).toEqual([]);
  expect(mints).toEqual([]);
});

test("runMergeEscalationSweep: a dispatch_failed outcome is recorded and leaves the marker unset (re-sweepable)", async () => {
  const { deps, mints } = fakeMergeSweepDeps({
    pending: [
      {
        id: "fn-1-foo",
        reason: mergeConflictReason("fn-1-foo.2", "keeper/epic/fn-1-foo"),
        dir: "/repo/root",
      },
    ],
    dispatch: async () => "dispatch_failed",
  });
  await runMergeEscalationSweep(deps);
  // dispatch_failed mints attempted{dispatch_failed} — task .1's fold no-ops on it, so
  // the marker stays NULL and the next sweep retries.
  expect(mints).toEqual([{ id: "fn-1-foo", outcome: "dispatch_failed" }]);
});

test("runMergeEscalationSweep: an at_cap skip mints NOTHING (row stays pending, re-sweeps)", async () => {
  const { deps, mints, dispatches } = fakeMergeSweepDeps({
    pending: [
      {
        id: "fn-1-foo",
        reason: mergeConflictReason("fn-1-foo.2", "keeper/epic/fn-1-foo"),
        dir: "/repo/root",
      },
    ],
    dispatch: async () => "at_cap",
  });
  await runMergeEscalationSweep(deps);
  // The dispatcher was consulted, but the cap skip mints no marker — the row re-sweeps.
  expect(dispatches.length).toBe(1);
  expect(mints).toEqual([]);
});

test("runMergeEscalationSweep: an already_live skip (occupancy guard) mints NOTHING", async () => {
  const { deps, mints } = fakeMergeSweepDeps({
    pending: [
      {
        id: "fn-1-foo",
        reason: mergeConflictReason("fn-1-foo.2", "keeper/epic/fn-1-foo"),
        dir: "/repo/root",
      },
    ],
    dispatch: async () => "already_live",
  });
  await runMergeEscalationSweep(deps);
  expect(mints).toEqual([]);
});

test("runMergeEscalationSweep: a checkout_busy skip mints NOTHING (row re-sweeps once the base checkout frees)", async () => {
  const { deps, mints, dispatches } = fakeMergeSweepDeps({
    pending: [
      {
        id: "fn-1-foo",
        reason: mergeConflictReason("fn-1-foo.2", "keeper/epic/fn-1-foo"),
        dir: "/repo/root",
      },
    ],
    dispatch: async () => "checkout_busy",
  });
  await runMergeEscalationSweep(deps);
  // The dispatch was attempted but skipped on occupancy — no once-marker minted, so the
  // sticky row stays re-sweepable and dispatches once the occupying session terminates.
  expect(dispatches.length).toBe(1);
  expect(mints).toEqual([]);
});

test("runMergeEscalationSweep: a THROWING dispatcher never aborts the sweep (records dispatch_failed)", async () => {
  const { deps, mints } = fakeMergeSweepDeps({
    pending: [
      {
        id: "fn-1-foo",
        reason: mergeConflictReason("fn-1-foo.2", "keeper/epic/fn-1-foo"),
        dir: "/repo/root",
      },
    ],
    dispatch: async () => {
      throw new Error("boom");
    },
  });
  await runMergeEscalationSweep(deps);
  expect(mints).toEqual([{ id: "fn-1-foo", outcome: "dispatch_failed" }]);
});

test("runMergeEscalationSweep: a row cleared mid-sweep (stillPending false) is skipped — no dispatch, no mint", async () => {
  const { deps, mints, dispatches } = fakeMergeSweepDeps({
    pending: [
      {
        id: "fn-1-foo",
        reason: mergeConflictReason("fn-1-foo.2", "keeper/epic/fn-1-foo"),
        dir: "/repo/root",
      },
    ],
    stillPending: () => false,
  });
  await runMergeEscalationSweep(deps);
  expect(dispatches).toEqual([]);
  expect(mints).toEqual([]);
});

test("runMergeEscalationSweep: an empty pending set is a no-op", async () => {
  const { deps, mints, dispatches } = fakeMergeSweepDeps({ pending: [] });
  await runMergeEscalationSweep(deps);
  expect(mints).toEqual([]);
  expect(dispatches).toEqual([]);
});

test("runMergeEscalationSweep: a throwing selectPending degrades to a no-op (fail-open)", async () => {
  const { deps, mints, dispatches } = fakeMergeSweepDeps({
    pending: [],
    selectThrows: true,
  });
  // MUST resolve (never throw) and do nothing.
  await runMergeEscalationSweep(deps);
  expect(mints).toEqual([]);
  expect(dispatches).toEqual([]);
});

test("runMergeEscalationSweep: a live/not-yet-terminal resolver defers the dispatch — no dispatch, no mint", async () => {
  const { deps, mints, dispatches } = fakeMergeSweepDeps({
    pending: [
      {
        id: "fn-1-foo",
        reason: mergeConflictReason("fn-1-foo.2", "keeper/epic/fn-1-foo"),
        dir: "/repo/root",
      },
    ],
    // The resolver (tier 1) still owns the conflict (live, or its job has not folded yet).
    resolverOutcome: () => ({ terminal: false }),
  });
  await runMergeEscalationSweep(deps);
  // The deconflict dispatch waits for the resolver's verdict: nothing dispatched.
  expect(dispatches).toEqual([]);
  expect(mints).toEqual([]);
});

test("runMergeEscalationSweep: a resolver that DIED is terminal — the deconflict dispatches once", async () => {
  const { deps, mints, dispatches } = fakeMergeSweepDeps({
    pending: [
      {
        id: "fn-1-foo",
        reason: mergeConflictReason("fn-1-foo.2", "keeper/epic/fn-1-foo"),
        dir: "/repo/root",
      },
    ],
    resolverOutcome: () => ({ terminal: true, verdict: "died" }),
  });
  await runMergeEscalationSweep(deps);
  expect(dispatches.length).toBe(1);
  expect(mints).toEqual([{ id: "fn-1-foo", outcome: "dispatched" }]);
});

// ---- turn-active resolver classifier × deconflict sequencing (end-to-end) -----
// fn-1171.6 — wire the REAL classifyResolverOutcome into runMergeEscalationSweep, not
// a mocked outcome, to prove the epic's fix unstarves the deconflict dispatch: a
// stopped-idle resolver (turn ended) must read terminal so the deconflict follows,
// while a working (turn-active) resolver must still defer it.

/** Minimal `Job` builder for the classifier tests — mirrors autopilot-worker.test's
 *  `makeJob`, defaulting a resolve session row. */
function mkResolveJob(overrides: Partial<Job>): Job {
  return {
    job_id: "j-res",
    created_at: 0,
    cwd: null,
    pid: null,
    state: "stopped",
    last_event_id: 0,
    updated_at: 0,
    title: null,
    title_source: null,
    transcript_path: null,
    start_time: null,
    plan_verb: "resolve",
    plan_ref: "fn-1-foo",
    epic_links: [],
    last_api_error_at: null,
    last_api_error_kind: null,
    last_input_request_at: null,
    last_input_request_kind: null,
    config_dir: null,
    git_dirty_count: 0,
    git_unattributed_to_live_count: 0,
    git_orphan_count: 0,
    ...overrides,
  } as Job;
}

test("runMergeEscalationSweep + REAL classifyResolverOutcome: a stopped-idle resolver reads terminal and the deconflict dispatches (the epic bug fix, end-to-end)", async () => {
  // A finished `/plan:resolve` session idling `stopped` in its pane. Under the OLD
  // pane-liveness rule it counted LIVE and the deconflict NEVER dispatched; turn-active
  // occupancy reads its yielded turn as terminal so the sequencing proceeds.
  const jobs = new Map<string, Job>([
    ["j-res", mkResolveJob({ state: "stopped", backend_exec_pane_id: "%7" })],
  ]);
  const { deps, mints, dispatches } = fakeMergeSweepDeps({
    pending: [
      {
        id: "fn-1-foo",
        reason: mergeConflictReason("fn-1-foo.2", "keeper/epic/fn-1-foo"),
        dir: "/repo/root",
      },
    ],
    resolverOutcome: (id) => classifyResolverOutcome(jobs, id),
  });
  await runMergeEscalationSweep(deps);
  expect(dispatches.length).toBe(1);
  expect(mints).toEqual([{ id: "fn-1-foo", outcome: "dispatched" }]);
});

test("runMergeEscalationSweep + REAL classifyResolverOutcome: a working (turn-active) resolver still defers the deconflict (sequencing unchanged)", async () => {
  const jobs = new Map<string, Job>([
    ["j-res", mkResolveJob({ state: "working", backend_exec_pane_id: "%1" })],
  ]);
  const { deps, mints, dispatches } = fakeMergeSweepDeps({
    pending: [
      {
        id: "fn-1-foo",
        reason: mergeConflictReason("fn-1-foo.2", "keeper/epic/fn-1-foo"),
        dir: "/repo/root",
      },
    ],
    resolverOutcome: (id) => classifyResolverOutcome(jobs, id),
  });
  await runMergeEscalationSweep(deps);
  // The resolver still owns the conflict (its turn is live) → nothing dispatched.
  expect(dispatches).toEqual([]);
  expect(mints).toEqual([]);
});

// ---- duplicate-spawn-name pair coexistence (autoclose off) -------------------
// fn-1171.6 second audit strand — a re-block while an old idle `unblock::<task>`
// session still lingers (autoclose off) launches a SECOND session with the SAME spawn
// name. Task .2 already proves the jobs fold stamps two rows with distinct job_ids +
// escalation_instances (test/reducer-projections.test.ts). This proves the CONSUMERS
// this task touches — turn-active occupancy guards + instance-scoped stage-3 — stay
// correct with the pair coexisting: no starvation, no double-count, no cross-adoption.

/** Minimal `Job` builder defaulting an `unblock::<task>` escalation session row. */
function mkUnblockJob(overrides: Partial<Job>): Job {
  return mkResolveJob({
    plan_verb: "unblock",
    plan_ref: "fn-1-foo.2",
    ...overrides,
  });
}

test("duplicate unblock pair (old idle + fresh dispatch, same task, distinct instances): turn-active guards see exactly ONE live occupant — no starvation, no double-count", () => {
  // Old instance A finished and idles `stopped`; fresh instance B is turn-active
  // (`working`). Same spawn name, distinct job_ids + escalation_instances.
  const oldIdle = mkUnblockJob({
    job_id: "j-old",
    state: "stopped",
    backend_exec_pane_id: "%7",
    escalation_instance: 100,
  });
  const freshLive = mkUnblockJob({
    job_id: "j-new",
    state: "working",
    backend_exec_pane_id: "%8",
    escalation_instance: 200,
  });
  const pair = [oldIdle, freshLive];

  // Global cap denominator: the idle old session freed its slot; only the live one
  // counts. Pane-liveness would have counted BOTH, double-charging the cap.
  expect(countLiveEscalationSessions(pair)).toBe(1);
  // Per-key occupancy guard: exactly one live occupant for the key, so a third
  // dispatch is correctly suppressed while B runs (never starved by the idle A).
  expect(escalationSessionLiveFor(pair, "unblock", "fn-1-foo.2")).toBe(true);
  // Per-epic serialization: one live unblock in the epic.
  expect(epicHasLiveUnblock(pair, "fn-1-foo")).toBe(true);
});

test("duplicate unblock pair both finished-idle (autoclose off): every turn-active guard frees the slot so a re-block gets a fresh dispatch", () => {
  // Both the old and the once-fresh session have ended their turns and idle `stopped`
  // (autoclose left the panes open). Turn-active occupancy frees the slot entirely.
  const first = mkUnblockJob({
    job_id: "j-old",
    state: "stopped",
    backend_exec_pane_id: "%7",
    escalation_instance: 100,
  });
  const second = mkUnblockJob({
    job_id: "j-new",
    state: "stopped",
    backend_exec_pane_id: "%8",
    escalation_instance: 200,
  });
  const pair = [first, second];
  expect(countLiveEscalationSessions(pair)).toBe(0);
  expect(escalationSessionLiveFor(pair, "unblock", "fn-1-foo.2")).toBe(false);
  expect(epicHasLiveUnblock(pair, "fn-1-foo")).toBe(false);
});

test("duplicate unblock pair: instance-scoped stage-3 read classifies each instance INDEPENDENTLY — the stale idle row never speaks for the live one, nor vice versa", () => {
  const { db } = openDb(dbPath);
  // Two coexisting `unblock::fn-1-foo.2` rows: old instance A idle+stopped, fresh
  // instance B turn-active+working. Same plan_verb/plan_ref, distinct job_ids +
  // escalation_instances — the fold-tolerated pair.
  const seed = (
    jobId: string,
    state: string,
    instance: number,
    pane: string,
  ): void => {
    db.run(
      `INSERT INTO jobs (job_id, created_at, cwd, pid, state, last_event_id,
                         updated_at, title, title_source, transcript_path, start_time,
                         plan_verb, plan_ref, backend_exec_pane_id, escalation_instance)
         VALUES (?, 0, NULL, NULL, ?, 0, 0, NULL, NULL, NULL, NULL,
                 'unblock', 'fn-1-foo.2', ?, ?)`,
      [jobId, state, pane, instance],
    );
  };
  seed("j-old", "stopped", 100, "%7");
  seed("j-new", "working", 200, "%8");

  // Scoped to instance B (the live re-block): only the working row is in scope, so the
  // stage-3 classifier WAITS (never pages a live session), unpolluted by the stale A.
  const bRows = resolveEscalationJobsFor(db, "unblock", "fn-1-foo.2", 200);
  expect(bRows.map((j) => j.job_id).sort()).toEqual(["j-new"]);
  expect(
    classifyEscalationOutcome(bRows, "unblock", "fn-1-foo.2", true),
  ).toEqual({ terminal: false });

  // Scoped to instance A (the resolved prior episode): only the stopped row is in
  // scope. Were its incident still open it would classify declined — proving the two
  // instances are read independently, no cross-adoption of B's live turn into A.
  const aRows = resolveEscalationJobsFor(db, "unblock", "fn-1-foo.2", 100);
  expect(aRows.map((j) => j.job_id).sort()).toEqual(["j-old"]);
  expect(
    classifyEscalationOutcome(aRows, "unblock", "fn-1-foo.2", true),
  ).toEqual({ terminal: true, verdict: "declined" });
});

// ---- selectPendingResolverDispatches (the resolver working-set read) ---------
// fn-1088.1 — the resolver-dispatch sweep's selector, gated on the INDEPENDENT
// `resolver_dispatched_at IS NULL` latch (sibling of `merge_escalated_at`).

function seedResolverFailureRow(
  db: ReturnType<typeof openDb>["db"],
  args: {
    verb: string;
    id: string;
    reason: string;
    dir?: string | null;
    mergeEscalatedAt?: number | null;
    resolverDispatchedAt?: number | null;
  },
): void {
  db.run(
    `INSERT INTO dispatch_failures
       (verb, id, reason, dir, ts, last_event_id, created_at, updated_at, merge_escalated_at, resolver_dispatched_at)
       VALUES (?, ?, ?, ?, 1, 1, 1, 1, ?, ?)`,
    [
      args.verb,
      args.id,
      args.reason,
      args.dir ?? null,
      args.mergeEscalatedAt ?? null,
      args.resolverDispatchedAt ?? null,
    ],
  );
}

test("selectPendingResolverDispatches: picks only close rows with an exact worktree-merge-conflict token and a NULL resolver latch", () => {
  const { db } = freshMemDb();
  // Dispatchable: a sticky close merge conflict, no resolver yet.
  seedResolverFailureRow(db, {
    verb: "close",
    id: "fn-1-foo",
    reason: mergeConflictReason("fn-1-foo.2", "keeper/epic/fn-1-foo"),
    dir: "/repo/root",
  });
  // Already merge-ESCALATED (human notified) but resolver latch still NULL → STILL
  // dispatchable: the two latches are independent consumers of the same sticky.
  seedResolverFailureRow(db, {
    verb: "close",
    id: "fn-2-escalated",
    reason: mergeConflictReason(
      "fn-2-escalated.1",
      "keeper/epic/fn-2-escalated",
    ),
    dir: "/repo/root",
    mergeEscalatedAt: 12345,
  });
  // Already resolver-dispatched (latch set) → dropped (dispatch-once).
  seedResolverFailureRow(db, {
    verb: "close",
    id: "fn-3-done",
    reason: mergeConflictReason("fn-3-done.1", "keeper/epic/fn-3-done"),
    dir: "/repo/root",
    resolverDispatchedAt: 999,
  });
  // Excluded reasons on a close row — a `worktree-merge` prefix must NOT match.
  seedResolverFailureRow(db, {
    verb: "close",
    id: "fn-4-lock",
    reason: "worktree-merge-lock-timeout: could not acquire the lock",
  });
  seedResolverFailureRow(db, {
    verb: "close",
    id: "fn-5-nonff",
    reason: "worktree-finalize-non-fast-forward: origin is ahead",
  });
  // A WORK row carrying the token — wrong verb, dropped.
  seedResolverFailureRow(db, {
    verb: "work",
    id: "fn-6-foo.1",
    reason: mergeConflictReason("fn-6-foo.1", "keeper/epic/fn-6-foo"),
  });

  const rows = selectPendingResolverDispatches(db);
  expect(rows).toEqual([
    {
      id: "fn-1-foo",
      reason: mergeConflictReason("fn-1-foo.2", "keeper/epic/fn-1-foo"),
      dir: "/repo/root",
    },
    {
      id: "fn-2-escalated",
      reason: mergeConflictReason(
        "fn-2-escalated.1",
        "keeper/epic/fn-2-escalated",
      ),
      dir: "/repo/root",
    },
  ]);
  db.close();
});

test("selectPendingResolverDispatches: empty table returns []", () => {
  const { db } = freshMemDb();
  expect(selectPendingResolverDispatches(db)).toEqual([]);
  db.close();
});

test("fn-1119 recover-origin escalation: a bare close::<epic> row with a recover-shaped worktree-merge-conflict reason (merging keeper/epic/<epic> into <default>) is selected by BOTH daemon sweeps, sequenced resolver-first", () => {
  const { db } = freshMemDb();
  const epic = "fn-1119-x";
  // The EXACT reason recoverWorktrees pass-2 mints on a content conflict: the SOURCE
  // is the epic BASE branch and the TARGET is the DEFAULT branch (not a rib into a
  // base), keyed on the BARE epic id. The token gate is id-agnostic + token-exact, so
  // this recover-origin shape escalates identically to finalize's close-sink conflict.
  const reason = mergeConflictReason(`keeper/epic/${epic}`, "main");
  expect(shouldEscalateMergeConflict(reason)).toBe(true);
  // The resolver-dispatch sweep goes FIRST (fresh row, no resolver latch yet).
  seedResolverFailureRow(db, { verb: "close", id: epic, reason, dir: "/repo" });
  expect(selectPendingResolverDispatches(db)).toEqual([
    { id: epic, reason, dir: "/repo" },
  ]);
  // Merge-escalation is SEQUENCED behind the resolver — it selects the same row once
  // a resolver has been dispatched (resolver_dispatched_at set, escalate marker null).
  db.run(
    "UPDATE dispatch_failures SET resolver_dispatched_at = 555 WHERE verb = 'close' AND id = ?",
    [epic],
  );
  expect(selectPendingMergeEscalations(db)).toEqual([
    { id: epic, reason, dir: "/repo" },
  ]);
  db.close();
});

// ---- buildResolverBrief (the autonomous resolver worker prompt) --------------

test("mergeConflictBaseCheckout: a default-branch base resolves to the repo root (never a nonexistent lane path); a keeper/epic lane base to its worktree", () => {
  const repoDir = "/Users/me/code/foo";
  // A lane→default finalize (base = the default branch) is NEVER laned: the cwd is the
  // repo root itself (the shared default checkout). `worktreePathFor(repoDir, "main")`
  // would be a lane dir that does not exist, so a launch cd'ing there ENOENTs and the
  // resolver never dispatches — the regression this pins.
  expect(mergeConflictBaseCheckout(repoDir, "main")).toBe(repoDir);
  expect(mergeConflictBaseCheckout(repoDir, "master")).toBe(repoDir);
  // A rib→lane fan-in (base = the epic lane) resolves to that lane's worktree.
  const lane = "keeper/epic/fn-9-foo";
  expect(mergeConflictBaseCheckout(repoDir, lane)).toBe(
    worktreePathFor(repoDir, lane),
  );
});

test("buildResolverBrief: a lane→default finalize (base = the default branch) cd's into the repo root, NOT a nonexistent <repo>--<default> lane", () => {
  const repoDir = "/Users/me/code/foo";
  const brief = buildResolverBrief({
    epicId: "fn-9-foo",
    // The production shape: the epic base branch merged INTO the default branch.
    reason: mergeConflictReason("keeper/epic/fn-9-foo", "main"),
    repoDir,
  });
  // The worker cd's into the repo root (the shared default checkout finalize merged in),
  // never the fabricated lane dir that made the resolver launch ENOENT.
  expect(brief).toContain(`cd ${repoDir}`);
  expect(brief).not.toContain(worktreePathFor(repoDir, "main"));
  expect(brief).toContain("git merge --no-ff keeper/epic/fn-9-foo");
});

test("buildResolverBrief: encodes recreate + both-intents + test-gate + retry on the clear path, BLOCKED + unstick on everything else", () => {
  const repoDir = "/Users/me/code/foo";
  const base = "keeper/epic/fn-9-foo";
  const source = "fn-9-foo.2";
  const brief = buildResolverBrief({
    epicId: "fn-9-foo",
    reason: mergeConflictReason(source, base),
    repoDir,
  });
  // Recreate the merge in the base worktree with --no-ff (never squash/rebase).
  expect(brief).toContain(worktreePathFor(repoDir, base));
  expect(brief).toContain(`git merge --no-ff ${source}`);
  expect(brief).toContain("--squash");
  expect(brief).toContain("rebase");
  // NO global pause/play — the daemon scopes recovery per-epic while this resolver
  // is live (fn-1095), so a crash never durably pauses the board and concurrent
  // resolvers never race on a shared flag. The brief PROHIBITS a pause (the only
  // mention of "pause" is the "Do NOT" guard) and issues NO terminal `play`.
  expect(brief).toContain("Do NOT `keeper autopilot pause`");
  expect(brief).toContain("per-epic recover exclusion");
  expect(brief).not.toContain("keeper autopilot play");
  // The CLEAR path: BOTH intents, run the epic tests, commit, retry the close.
  expect(brief).toContain("BOTH");
  expect(brief).toContain("tests");
  expect(brief).toContain("keeper autopilot retry close::fn-9-foo");
  // Intent archaeology BEFORE classifying: read each side's primary sources
  // (commits + keeper history) to ground classification in intent, not diff text.
  expect(brief).toContain("INTENT ARCHAEOLOGY");
  expect(brief).toContain("keeper find-file-history");
  expect(brief).toContain("keeper search-history");
  // The do-not-invent-new-behaviour guard: compose verbatim or default to BLOCKED.
  expect(brief).toContain("Do NOT invent new behaviour");
  // The guardrail classes named VERBATIM + unsure-defaults-to-BLOCKED.
  expect(brief).toContain("state machine");
  expect(brief).toContain("schema");
  expect(brief).toContain("security");
  expect(brief).toContain("transaction-boundary");
  expect(brief).toContain("BLOCKED");
  expect(brief).toContain("UNSURE");
  // The schema-version collision carve-out: the tool's exit-0-clear / refusal-BLOCKED
  // boundary, distinct from a schema SHAPE decision.
  expect(brief).toContain("SCHEMA-VERSION COLLISION CARVE-OUT");
  expect(brief).toContain("bun scripts/rebase-schema-migration.ts");
  expect(brief).toContain("schema SHAPE decision");
  // The literal unstick sentence.
  expect(brief).toContain("to proceed, tell me exactly:");
  // The NOT-clear path aborts to a clean lane (never a half-merge).
  expect(brief).toContain("git merge --abort");
  // The foreign-staged guard: before BOTH the concluding commit and the decline abort,
  // unstage (leave-in-tree) any path staged OUTSIDE this merge's own set — a concurrent
  // commit's staged work a whole-index commit / abort would otherwise sweep or destroy.
  // Keyed on the merge's OWN set (`git diff HEAD MERGE_HEAD`) so a resolved-then-staged
  // conflict file is never mistaken for foreign work.
  expect(brief).toContain("FOREIGN staged path");
  expect(brief).toContain("git restore --staged");
  expect(brief).toContain("git diff --cached --name-only");
  expect(brief).toContain("git diff --name-only HEAD MERGE_HEAD");
  // The free-text reason rides as a body line.
  expect(brief).toContain("CONFLICT (content): Merge conflict in src/foo.ts");
});

test("buildResolverBrief: a parse-miss degrades to a still-actionable brief (never throws)", () => {
  const brief = buildResolverBrief({
    epicId: "fn-9-foo",
    reason: "worktree-merge-conflict: something unparseable happened",
    repoDir: "/Users/me/code/foo",
  });
  expect(brief).toContain("close::fn-9-foo");
  expect(brief).toContain("--no-ff");
  expect(brief).toContain("Do NOT `keeper autopilot pause`");
  expect(brief).not.toContain("keeper autopilot play");
  expect(brief).toContain("BLOCKED");
  expect(brief).toContain("to proceed, tell me exactly:");
  // The archaeology step + do-not-invent guard ride the shared guardrail into the
  // parse-miss branch too.
  expect(brief).toContain("INTENT ARCHAEOLOGY");
  expect(brief).toContain("keeper find-file-history");
  expect(brief).toContain("Do NOT invent new behaviour");
  expect(brief).toContain("SCHEMA-VERSION COLLISION CARVE-OUT");
  // The foreign-staged guard rides the shared blockedPath (abort) + clear-path commit
  // into the parse-miss branch too.
  expect(brief).toContain("FOREIGN staged path");
  expect(brief).toContain("git restore --staged");
  expect(brief).toContain("git diff --name-only HEAD MERGE_HEAD");
});

test("buildResolverBrief: a null/empty repoDir degrades to the manual body (never throws)", () => {
  const brief = buildResolverBrief({
    epicId: "fn-9-foo",
    reason: mergeConflictReason("fn-9-foo.2", "keeper/epic/fn-9-foo"),
    repoDir: null,
  });
  expect(brief).toContain("close::fn-9-foo");
  expect(brief).toContain("--no-ff");
  expect(brief).toContain("Do NOT `keeper autopilot pause`");
  expect(brief).not.toContain("keeper autopilot play");
  expect(brief).toContain("BLOCKED");
  // The archaeology step + do-not-invent guard ride the shared guardrail into the
  // null-repo manual branch too.
  expect(brief).toContain("INTENT ARCHAEOLOGY");
  expect(brief).toContain("Do NOT invent new behaviour");
  expect(brief).toContain("SCHEMA-VERSION COLLISION CARVE-OUT");
});

// ---- runResolverDispatchSweep (orchestration core, injected deps) ------------

interface ResolverMintCall {
  id: string;
  outcome: ResolverDispatchOutcome;
}

function fakeResolverSweepDeps(opts: {
  pending: PendingResolverDispatch[];
  stillPending?: (id: string) => boolean;
  dispatch?: (row: PendingResolverDispatch) => Promise<ResolverDispatchResult>;
  selectThrows?: boolean;
}): {
  deps: ResolverDispatchSweepDeps;
  mints: ResolverMintCall[];
  dispatches: PendingResolverDispatch[];
} {
  const mints: ResolverMintCall[] = [];
  const dispatches: PendingResolverDispatch[] = [];
  const deps: ResolverDispatchSweepDeps = {
    selectPending: () => {
      if (opts.selectThrows) throw new Error("read boom");
      return opts.pending;
    },
    stillPending: opts.stillPending ?? (() => true),
    dispatchResolver: async (row) => {
      dispatches.push(row);
      return (await opts.dispatch?.(row)) ?? "dispatched";
    },
    mintAttempted: (id, outcome) => mints.push({ id, outcome }),
  };
  return { deps, mints, dispatches };
}

test("runResolverDispatchSweep: a dispatchable close launches ONE resolver and mints attempted{dispatched}", async () => {
  const { deps, mints, dispatches } = fakeResolverSweepDeps({
    pending: [
      {
        id: "fn-1-foo",
        reason: mergeConflictReason("fn-1-foo.2", "keeper/epic/fn-1-foo"),
        dir: "/repo/root",
      },
    ],
  });
  await runResolverDispatchSweep(deps);
  expect(dispatches.length).toBe(1);
  expect(dispatches[0]?.id).toBe("fn-1-foo");
  // The terminal `dispatched` outcome stamps the once-marker (via the fold); NEVER a
  // DispatchCleared (the sweep has no clear path — only retry_dispatch clears).
  expect(mints).toEqual([{ id: "fn-1-foo", outcome: "dispatched" }]);
});

test("runResolverDispatchSweep: a non-token reason in the pending set is NOT dispatched (defense-in-depth gate)", async () => {
  const { deps, mints, dispatches } = fakeResolverSweepDeps({
    pending: [
      {
        id: "fn-1-foo",
        reason: "worktree-merge-lock-timeout: could not acquire the lock",
        dir: "/repo/root",
      },
    ],
  });
  await runResolverDispatchSweep(deps);
  expect(dispatches).toEqual([]);
  expect(mints).toEqual([]);
});

test("runResolverDispatchSweep: a dispatch_failed outcome is recorded and leaves the latch unset (re-sweepable)", async () => {
  const { deps, mints } = fakeResolverSweepDeps({
    pending: [
      {
        id: "fn-1-foo",
        reason: mergeConflictReason("fn-1-foo.2", "keeper/epic/fn-1-foo"),
        dir: "/repo/root",
      },
    ],
    dispatch: async () => "dispatch_failed",
  });
  await runResolverDispatchSweep(deps);
  // dispatch_failed mints attempted{dispatch_failed} — the fold no-ops on it, so the
  // latch stays NULL and the next sweep retries.
  expect(mints).toEqual([{ id: "fn-1-foo", outcome: "dispatch_failed" }]);
});

test("runResolverDispatchSweep: a THROWING dispatcher never aborts the sweep (records dispatch_failed)", async () => {
  const { deps, mints } = fakeResolverSweepDeps({
    pending: [
      {
        id: "fn-1-foo",
        reason: mergeConflictReason("fn-1-foo.2", "keeper/epic/fn-1-foo"),
        dir: "/repo/root",
      },
    ],
    dispatch: async () => {
      throw new Error("boom");
    },
  });
  await runResolverDispatchSweep(deps);
  expect(mints).toEqual([{ id: "fn-1-foo", outcome: "dispatch_failed" }]);
});

test("runResolverDispatchSweep: a row cleared mid-sweep (stillPending false) is skipped — no dispatch, no mint", async () => {
  const { deps, mints, dispatches } = fakeResolverSweepDeps({
    pending: [
      {
        id: "fn-1-foo",
        reason: mergeConflictReason("fn-1-foo.2", "keeper/epic/fn-1-foo"),
        dir: "/repo/root",
      },
    ],
    stillPending: () => false,
  });
  await runResolverDispatchSweep(deps);
  expect(dispatches).toEqual([]);
  expect(mints).toEqual([]);
});

test("runResolverDispatchSweep: a checkout_busy skip mints NOTHING (row re-sweeps once the base checkout frees)", async () => {
  const { deps, mints, dispatches } = fakeResolverSweepDeps({
    pending: [
      {
        id: "fn-1-foo",
        reason: mergeConflictReason("fn-1-foo.2", "keeper/epic/fn-1-foo"),
        dir: "/repo/root",
      },
    ],
    dispatch: async () => "checkout_busy",
  });
  await runResolverDispatchSweep(deps);
  // The resolver dispatch was attempted but the base checkout is held by another live
  // escalation — no `resolver_dispatched_at` once-marker minted, so the row re-sweeps.
  expect(dispatches.length).toBe(1);
  expect(mints).toEqual([]);
});

test("runResolverDispatchSweep: an empty pending set is a no-op", async () => {
  const { deps, mints, dispatches } = fakeResolverSweepDeps({ pending: [] });
  await runResolverDispatchSweep(deps);
  expect(mints).toEqual([]);
  expect(dispatches).toEqual([]);
});

test("runResolverDispatchSweep: a throwing selectPending degrades to a no-op (fail-open)", async () => {
  const { deps, mints, dispatches } = fakeResolverSweepDeps({
    pending: [],
    selectThrows: true,
  });
  await runResolverDispatchSweep(deps);
  expect(mints).toEqual([]);
  expect(dispatches).toEqual([]);
});

// ---- fn-1129 escalation cap/occupancy/classify (pure helpers over a jobs set) --

function escJob(planVerb: string, planRef: string, state: string): Job {
  return {
    plan_verb: planVerb,
    plan_ref: planRef,
    state,
    backend_exec_pane_id: null,
  } as unknown as Job;
}

function escJobCwd(
  planVerb: string,
  planRef: string,
  state: string,
  cwd: string | null,
): Job {
  return {
    plan_verb: planVerb,
    plan_ref: planRef,
    state,
    backend_exec_pane_id: null,
    cwd,
  } as unknown as Job;
}

test("countLiveEscalationSessions: counts only TURN-ACTIVE (working) unblock:: + deconflict:: rows; a stopped/terminal escalation frees its cap slot", () => {
  const jobs: Job[] = [
    escJob("deconflict", "fn-1-foo", "working"), // turn-active → counts
    escJob("unblock", "fn-2-bar.3", "working"), // turn-active → counts
    escJob("unblock", "fn-7-idle.1", "stopped"), // finished-but-idling → no longer counts
    escJob("deconflict", "fn-3-dead", "ended"), // terminal — not counted
    escJob("deconflict", "fn-4-killed", "killed"), // terminal — not counted
    escJob("resolve", "fn-5-res", "working"), // the resolver is NOT an escalation
    escJob("work", "fn-6-work.1", "working"), // a plain worker — not counted
  ];
  // Turn-active occupancy: only the two `working` escalation rows count — the stopped
  // (idling) session released its cap slot, so a re-block can re-dispatch under the cap.
  expect(countLiveEscalationSessions(jobs)).toBe(2);
  expect(countLiveEscalationSessions([])).toBe(0);
});

test("countLiveEscalationSessions: a work `deconflict::<taskId>` shares the SAME cap as a close `deconflict::<epic>` (no starvation)", () => {
  // fn-1240: the work-verb deconflict dispatches through the SAME `dispatchEscalationSession`
  // as the close path, keyed on the `deconflict` verb regardless of whether its id is an
  // epic id (close) or a task id (work). Both count toward the one global cap, so neither
  // starves the other — as slots free, whichever sweep runs next dispatches.
  const jobs: Job[] = [
    escJob("deconflict", "fn-1-foo", "working"), // close: epic id
    escJob("deconflict", "fn-2-bar.3", "working"), // work: task id — SAME cap
    escJob("unblock", "fn-3-baz.1", "working"), // shares the cap too
  ];
  expect(countLiveEscalationSessions(jobs)).toBe(3);
  // The per-key liveness guard distinguishes the two deconflict namespaces exactly.
  expect(escalationSessionLiveFor(jobs, "deconflict", "fn-2-bar.3")).toBe(true);
  expect(escalationSessionLiveFor(jobs, "deconflict", "fn-1-foo")).toBe(true);
});

test("escalationSessionLiveFor: matches a live session for the exact verb+id only", () => {
  const jobs: Job[] = [
    escJob("deconflict", "fn-1-foo", "working"),
    escJob("unblock", "fn-1-foo", "ended"), // same id, wrong verb + terminal
  ];
  expect(escalationSessionLiveFor(jobs, "deconflict", "fn-1-foo")).toBe(true);
  // The unblock row for the same id is terminal → not live.
  expect(escalationSessionLiveFor(jobs, "unblock", "fn-1-foo")).toBe(false);
  // No row for this key at all.
  expect(escalationSessionLiveFor(jobs, "deconflict", "fn-9-none")).toBe(false);
  // A finished-but-idling (stopped) session no longer occupies its per-key slot —
  // turn-active occupancy releases it so a re-block re-dispatches instead of starving.
  expect(
    escalationSessionLiveFor(
      [escJob("unblock", "fn-8-idle.2", "stopped")],
      "unblock",
      "fn-8-idle.2",
    ),
  ).toBe(false);
});

test("escalationCheckoutOccupiedBy: a live deconflict in the SAME checkout occupies a different-epic candidate (same-repo serialization)", () => {
  const jobs: Job[] = [
    escJobCwd("deconflict", "fn-1-foo", "working", "/repo/root"),
  ];
  // A second same-repo escalation (different epic) resolving to the same shared checkout
  // is blocked while the first is live.
  expect(
    escalationCheckoutOccupiedBy(jobs, "/repo/root", "deconflict", "fn-2-bar"),
  ).toBe(true);
  expect(
    escalationCheckoutOccupiedBy(jobs, "/repo/root", "resolve", "fn-2-bar"),
  ).toBe(true);
});

test("escalationCheckoutOccupiedBy: a live resolve occupies the checkout too (both classes recreate the merge)", () => {
  const jobs: Job[] = [
    escJobCwd("resolve", "fn-1-foo", "working", "/repo/root"),
  ];
  expect(
    escalationCheckoutOccupiedBy(jobs, "/repo/root", "deconflict", "fn-2-bar"),
  ).toBe(true);
});

test("escalationCheckoutOccupiedBy: a checkout in a DIFFERENT repo is free (per checkout, never global — cross-repo concurrency)", () => {
  const jobs: Job[] = [
    escJobCwd("deconflict", "fn-1-foo", "working", "/repo-a/root"),
  ];
  // The candidate's checkout is a different repo root → the two dispatch concurrently.
  expect(
    escalationCheckoutOccupiedBy(
      jobs,
      "/repo-b/root",
      "deconflict",
      "fn-2-bar",
    ),
  ).toBe(false);
});

test("escalationCheckoutOccupiedBy: an unblock session never occupies (it recreates no merge)", () => {
  const jobs: Job[] = [
    escJobCwd("unblock", "fn-1-foo.3", "working", "/repo/root"),
  ];
  expect(
    escalationCheckoutOccupiedBy(jobs, "/repo/root", "deconflict", "fn-2-bar"),
  ).toBe(false);
});

test("escalationCheckoutOccupiedBy: the candidate's OWN key never self-blocks", () => {
  const jobs: Job[] = [
    escJobCwd("deconflict", "fn-1-foo", "working", "/repo/root"),
  ];
  expect(
    escalationCheckoutOccupiedBy(jobs, "/repo/root", "deconflict", "fn-1-foo"),
  ).toBe(false);
});

test("escalationCheckoutOccupiedBy: a TERMINAL occupant frees the checkout (the deferred second re-sweeps and dispatches)", () => {
  // The first escalation reached a terminal state → its checkout is free again, so the
  // second (which deferred while it was live) now dispatches.
  const ended: Job[] = [
    escJobCwd("deconflict", "fn-1-foo", "ended", "/repo/root"),
  ];
  expect(
    escalationCheckoutOccupiedBy(ended, "/repo/root", "deconflict", "fn-2-bar"),
  ).toBe(false);
  const killed: Job[] = [
    escJobCwd("resolve", "fn-1-foo", "killed", "/repo/root"),
  ];
  expect(
    escalationCheckoutOccupiedBy(
      killed,
      "/repo/root",
      "deconflict",
      "fn-2-bar",
    ),
  ).toBe(false);
});

test("escalationCheckoutOccupiedBy: an empty checkout (unresolved cwd) is never occupied, and a NULL job cwd never matches", () => {
  expect(
    escalationCheckoutOccupiedBy(
      [escJobCwd("deconflict", "fn-1-foo", "working", "")],
      "",
      "deconflict",
      "fn-2-bar",
    ),
  ).toBe(false);
  // A live occupant with a null cwd cannot collide with a resolved candidate checkout.
  expect(
    escalationCheckoutOccupiedBy(
      [escJobCwd("deconflict", "fn-1-foo", "working", null)],
      "/repo/root",
      "deconflict",
      "fn-2-bar",
    ),
  ).toBe(false);
});

test("classifyEscalationOutcome: turn-active + launch-window → not terminal; stopped+open → declined; killed/ended+open → died; incident closed → not terminal", () => {
  // A turn-active session (working) → the notify waits, even with the incident open.
  expect(
    classifyEscalationOutcome(
      [escJob("deconflict", "fn-1-foo", "working")],
      "deconflict",
      "fn-1-foo",
      true,
    ),
  ).toEqual({ terminal: false });
  // No `deconflict::fn-1-foo` row folded yet (launch window) → waits.
  expect(classifyEscalationOutcome([], "deconflict", "fn-1-foo", true)).toEqual(
    {
      terminal: false,
    },
  );
  // A stopped session (turn ended, idling) with the incident still open → declined:
  // it ran its turn and gave up. The OLD derivation keyed declined on `ended`, which a
  // clean decline never reaches — a decline STOPS the turn, it never exits the CLI.
  expect(
    classifyEscalationOutcome(
      [escJob("unblock", "fn-2-bar.3", "stopped")],
      "unblock",
      "fn-2-bar.3",
      true,
    ),
  ).toEqual({ terminal: true, verdict: "declined" });
  // A `killed` row + open incident → died (the session process was killed).
  expect(
    classifyEscalationOutcome(
      [escJob("deconflict", "fn-1-foo", "killed")],
      "deconflict",
      "fn-1-foo",
      true,
    ),
  ).toEqual({ terminal: true, verdict: "died" });
  // An `ended` row + open incident → died: a one-shot escalation session idles
  // `stopped` after its turn, so a CLI exit is an abnormal death, never a clean decline.
  expect(
    classifyEscalationOutcome(
      [escJob("deconflict", "fn-1-foo", "ended")],
      "deconflict",
      "fn-1-foo",
      true,
    ),
  ).toEqual({ terminal: true, verdict: "died" });
  // Incident already resolved (the escalation succeeded → latch/sticky cleared): a
  // stopped row with `incidentOpen === false` classifies non-terminal — pages nobody.
  expect(
    classifyEscalationOutcome(
      [escJob("unblock", "fn-2-bar.3", "stopped")],
      "unblock",
      "fn-2-bar.3",
      false,
    ),
  ).toEqual({ terminal: false });
});

test("permission-parked pin: a session parked on a mid-turn permission prompt stays 'working' until Stop, so turn-active occupancy is NOT freed while parked", () => {
  // The load-bearing pin for turn-active occupancy: `escalationJobLive` keys on
  // `state === 'working'`, so a session that STOPPED off `working` mid-turn while parked
  // on a permission prompt would prematurely free its escalation slot. Fold a real
  // permission-prompt lifecycle through the reducer and prove the parked session never
  // leaves `working` before its turn-final Stop — so no parked-marker live arm is needed.
  const { db } = freshMemDb();
  seedEvent(db, "esc-sess", "SessionStart", 1);
  seedEvent(db, "esc-sess", "UserPromptSubmit", 2);
  // A tool-permission dialog: `Notification` with event_type `permission_prompt`. The
  // reducer STAMPS `last_permission_prompt_at` but never flips `state` (the pill layers
  // `[awaiting:…]` on top of the live turn).
  db.run(
    `INSERT INTO events (ts, session_id, pid, hook_event, event_type, data)
       VALUES (3, 'esc-sess', 4242, 'Notification', 'permission_prompt', '{}')`,
  );
  drainToCompletion(db);

  const parked = db
    .query(
      "SELECT state, last_permission_prompt_at FROM jobs WHERE job_id = 'esc-sess'",
    )
    .get() as { state: string; last_permission_prompt_at: number | null };
  // The prompt folded (marker stamped) yet the session is STILL turn-active.
  expect(parked.last_permission_prompt_at).not.toBeNull();
  expect(parked.state).toBe("working");
  // The exported per-key guard the dispatch sweep consults sees the parked session as
  // occupying its slot — it must NOT be freed mid-turn.
  const parkedJob = {
    plan_verb: "unblock",
    plan_ref: "esc-sess",
    state: parked.state,
    backend_exec_pane_id: null,
  } as unknown as Job;
  expect(escalationSessionLiveFor([parkedJob], "unblock", "esc-sess")).toBe(
    true,
  );

  // The turn-final Stop is the ONLY thing that frees occupancy.
  seedEvent(db, "esc-sess", "Stop", 4);
  drainToCompletion(db);
  const stopped = db
    .query("SELECT state FROM jobs WHERE job_id = 'esc-sess'")
    .get() as { state: string };
  expect(stopped.state).toBe("stopped");
  const stoppedJob = { ...parkedJob, state: stopped.state } as unknown as Job;
  expect(escalationSessionLiveFor([stoppedJob], "unblock", "esc-sess")).toBe(
    false,
  );
  db.close();
});

test("resolveEscalationJobsFor: reads only the matching verb+id rows; empty DB → []", () => {
  const { db } = freshMemDb();
  expect(resolveEscalationJobsFor(db, "deconflict", "fn-1-foo", null)).toEqual(
    [],
  );
  db.run(
    `INSERT INTO jobs (job_id, created_at, updated_at, state, plan_verb, plan_ref)
       VALUES (?, 0, 0, 'working', 'deconflict', 'fn-1-foo')`,
    ["dc-job-1"],
  );
  db.run(
    `INSERT INTO jobs (job_id, created_at, updated_at, state, plan_verb, plan_ref)
       VALUES (?, 0, 0, 'working', 'deconflict', 'fn-2-other')`,
    ["dc-job-2"],
  );
  const rows = resolveEscalationJobsFor(db, "deconflict", "fn-1-foo", null);
  expect(rows.map((r) => r.plan_ref)).toEqual(["fn-1-foo"]);
  // The read feeds the classifier — a turn-active row classifies as not-yet-terminal.
  expect(
    classifyEscalationOutcome(rows, "deconflict", "fn-1-foo", true),
  ).toEqual({
    terminal: false,
  });
  db.close();
});

test("resolveEscalationJobsFor: instance-scoped — stale resolved-instance rows excluded, NULL-stamped included, current-instance rows included", () => {
  const { db } = freshMemDb();
  db.run(
    `INSERT INTO jobs (job_id, created_at, updated_at, state, plan_verb, plan_ref, escalation_instance, last_event_id)
       VALUES (?, 0, 0, 'stopped', 'unblock', 'fn-2-bar.3', 100, 150)`,
    ["job-instance-a"],
  );
  db.run(
    `INSERT INTO jobs (job_id, created_at, updated_at, state, plan_verb, plan_ref, escalation_instance, last_event_id)
       VALUES (?, 0, 0, 'working', 'unblock', 'fn-2-bar.3', 200, 250)`,
    ["job-instance-b"],
  );
  // A genuine corroboration-miss for the CURRENT instance: NULL-stamped, but its own
  // events (last_event_id 260) fold AFTER the instance-200 anchor, so it clears it.
  db.run(
    `INSERT INTO jobs (job_id, created_at, updated_at, state, plan_verb, plan_ref, escalation_instance, last_event_id)
       VALUES (?, 0, 0, 'working', 'unblock', 'fn-2-bar.3', NULL, 260)`,
    ["job-instance-null"],
  );
  // Scoped to the CURRENT instance (200): the stale instance-100 row (a resolved prior
  // episode) is excluded, the current-instance row and the NULL-stamped
  // corroboration-miss row are both included.
  const scoped = resolveEscalationJobsFor(db, "unblock", "fn-2-bar.3", 200);
  expect(scoped.map((r) => r.job_id).sort()).toEqual([
    "job-instance-b",
    "job-instance-null",
  ]);
  // The stale instance-100 row alone must never suppress or falsely terminate the
  // classification for instance 200 — it isn't even in the read.
  expect(scoped.some((r) => r.job_id === "job-instance-a")).toBe(false);

  // A NULL caller-side instance (legacy pre-migration caller context) falls back to the
  // unscoped verb+ref match — every row, including the stale instance-100 one.
  const unscoped = resolveEscalationJobsFor(db, "unblock", "fn-2-bar.3", null);
  expect(unscoped.map((r) => r.job_id).sort()).toEqual([
    "job-instance-a",
    "job-instance-b",
    "job-instance-null",
  ]);
  db.close();
});

test("resolveEscalationJobsFor: cross-instance classification — a stale stopped row from a resolved instance neither pages nor suppresses a fresh re-block's escalation", () => {
  const { db } = freshMemDb();
  // Instance A: an unblock session ran its turn and stopped WITHOUT resolving the block
  // (would classify declined) — but the task then re-blocked, opening instance B, and A's
  // window still idles in its pane (killed/reaped later, or simply left behind).
  db.run(
    `INSERT INTO jobs (job_id, created_at, updated_at, state, plan_verb, plan_ref, escalation_instance)
       VALUES (?, 0, 0, 'stopped', 'unblock', 'fn-2-bar.3', 100)`,
    ["job-stale-a"],
  );
  // Instance B: the fresh dispatch hasn't folded its SessionStart yet (launch window).
  const rowsForB = resolveEscalationJobsFor(db, "unblock", "fn-2-bar.3", 200);
  expect(rowsForB).toEqual([]);
  // No row for instance B yet → not terminal (launch window), even though instance A's
  // stale row would have classified as terminal/declined if it leaked in.
  expect(
    classifyEscalationOutcome(rowsForB, "unblock", "fn-2-bar.3", true),
  ).toEqual({ terminal: false });

  // Instance B's own session folds and stops without resolving — NOW instance B
  // classifies declined, scoped correctly to its own row plus (excluded here) any
  // NULL-stamped miss.
  db.run(
    `INSERT INTO jobs (job_id, created_at, updated_at, state, plan_verb, plan_ref, escalation_instance)
       VALUES (?, 0, 0, 'stopped', 'unblock', 'fn-2-bar.3', 200)`,
    ["job-fresh-b"],
  );
  const rowsForB2 = resolveEscalationJobsFor(db, "unblock", "fn-2-bar.3", 200);
  expect(rowsForB2.map((r) => r.job_id)).toEqual(["job-fresh-b"]);
  expect(
    classifyEscalationOutcome(rowsForB2, "unblock", "fn-2-bar.3", true),
  ).toEqual({ terminal: true, verdict: "declined" });
  db.close();
});

test("resolveEscalationJobsFor: cross-instance NULL contamination — a resolved prior instance's NULL-stamped miss row never pages a launch-window re-block, yet the re-block's OWN NULL miss still classifies", () => {
  const { db } = freshMemDb();
  // Instance A (blocked_since 100): an `unblock::fn-2-bar.3` session was dispatched but
  // corroboration-MISSED (escalation_instance stayed NULL — the task cycled
  // unblocked→re-blocked before its SessionStart folded), ran its turn, and stopped
  // WITHOUT resolving. A NULL-stamped row is never reaped (isEscalationCandidate requires
  // a non-null instance), so it lingers — all its events (last_event_id 150) predating the
  // re-block anchor.
  db.run(
    `INSERT INTO jobs (job_id, created_at, updated_at, state, plan_verb, plan_ref, escalation_instance, last_event_id)
       VALUES (?, 0, 0, 'stopped', 'unblock', 'fn-2-bar.3', NULL, 150)`,
    ["job-null-stale-a"],
  );
  // Instance B's launch window (blocked_since 200): B's latch is marked dispatched but its
  // own SessionStart has not folded yet. Scoped to 200, A's stale NULL row (last_event_id
  // 150 < 200) is EXCLUDED — the classifier WAITS instead of reading it as a declined
  // verdict and paging the human for B before B ever ran (which would latch
  // human_notified_at and suppress B's genuine page).
  const rowsForB = resolveEscalationJobsFor(db, "unblock", "fn-2-bar.3", 200);
  expect(rowsForB).toEqual([]);
  expect(
    classifyEscalationOutcome(rowsForB, "unblock", "fn-2-bar.3", true),
  ).toEqual({ terminal: false });

  // NULL-fallback intent preserved: B's OWN corroboration-miss session — dispatched for
  // instance B, so its events fold AFTER the anchor (last_event_id 260 >= 200) — stops
  // without resolving and DOES classify declined for B, while A's stale NULL row stays out.
  db.run(
    `INSERT INTO jobs (job_id, created_at, updated_at, state, plan_verb, plan_ref, escalation_instance, last_event_id)
       VALUES (?, 0, 0, 'stopped', 'unblock', 'fn-2-bar.3', NULL, 260)`,
    ["job-null-miss-b"],
  );
  const rowsForB2 = resolveEscalationJobsFor(db, "unblock", "fn-2-bar.3", 200);
  expect(rowsForB2.map((r) => r.job_id)).toEqual(["job-null-miss-b"]);
  expect(
    classifyEscalationOutcome(rowsForB2, "unblock", "fn-2-bar.3", true),
  ).toEqual({ terminal: true, verdict: "declined" });
  db.close();
});

// ---- dispatchEscalationSession (shared cap + occupancy + launch) --------------

function fakeEscalationDispatchDeps(opts: {
  countLive?: number;
  isLive?: boolean;
  checkoutBusy?: boolean;
  launchOk?: boolean;
  launchThrows?: boolean;
  config?: { model: string; effort: string };
}): {
  deps: EscalationDispatchDeps;
  launches: { spec: unknown; cwd: string; label: string }[];
} {
  const launches: { spec: unknown; cwd: string; label: string }[] = [];
  const deps: EscalationDispatchDeps = {
    countLiveEscalations: () => opts.countLive ?? 0,
    isEscalationLive: () => opts.isLive ?? false,
    isCheckoutOccupied: () => opts.checkoutBusy ?? false,
    resolveConfig: () => opts.config ?? { model: "sonnet", effort: "high" },
    launch: async (args) => {
      if (opts.launchThrows) throw new Error("launch boom");
      launches.push(args);
      return { ok: opts.launchOk ?? true };
    },
  };
  return { deps, launches };
}

test("dispatchEscalationSession: under cap + not live → launches ONE session at the config model/effort and returns dispatched", async () => {
  const { deps, launches } = fakeEscalationDispatchDeps({
    config: { model: "sonnet", effort: "high" },
  });
  const outcome = await dispatchEscalationSession(deps, {
    verb: "deconflict",
    id: "fn-1-foo",
    prompt: "/plan:deconflict fn-1-foo",
    cwd: "/repo/wt",
  });
  expect(outcome).toBe("dispatched");
  expect(launches.length).toBe(1);
  expect(launches[0]?.label).toBe("deconflict::fn-1-foo");
  expect(launches[0]?.cwd).toBe("/repo/wt");
  expect(launches[0]?.spec).toEqual({
    prompt: "/plan:deconflict fn-1-foo",
    claudeName: "deconflict::fn-1-foo",
    model: "sonnet",
    effort: "high",
  });
});

test("dispatchEscalationSession: a launch miss returns dispatch_failed", async () => {
  const { deps } = fakeEscalationDispatchDeps({ launchOk: false });
  const outcome = await dispatchEscalationSession(deps, {
    verb: "deconflict",
    id: "fn-1-foo",
    prompt: "/plan:deconflict fn-1-foo",
    cwd: "/repo/wt",
  });
  expect(outcome).toBe("dispatch_failed");
});

test("dispatchEscalationSession: at the global cap → at_cap, launch NOT called (row stays pending)", async () => {
  const { deps, launches } = fakeEscalationDispatchDeps({
    countLive: MAX_LIVE_ESCALATION_SESSIONS,
  });
  const outcome = await dispatchEscalationSession(deps, {
    verb: "unblock",
    id: "fn-1-foo.3",
    prompt: "/plan:unblock fn-1-foo.3",
    cwd: "/repo",
  });
  expect(outcome).toBe("at_cap");
  expect(launches).toEqual([]);
});

test("dispatchEscalationSession: an already-live session → already_live, launch NOT called (occupancy guard wins over the cap)", async () => {
  const { deps, launches } = fakeEscalationDispatchDeps({
    isLive: true,
    // Even under cap, occupancy short-circuits first.
    countLive: 0,
  });
  const outcome = await dispatchEscalationSession(deps, {
    verb: "deconflict",
    id: "fn-1-foo",
    prompt: "/plan:deconflict fn-1-foo",
    cwd: "/repo/wt",
  });
  expect(outcome).toBe("already_live");
  expect(launches).toEqual([]);
});

test("dispatchEscalationSession: an occupied base checkout → checkout_busy, launch NOT called (the per-checkout serialization guard)", async () => {
  const { deps, launches } = fakeEscalationDispatchDeps({
    checkoutBusy: true,
    // Under cap and not the same key live — only the per-checkout guard blocks.
    countLive: 0,
    isLive: false,
  });
  const outcome = await dispatchEscalationSession(deps, {
    verb: "deconflict",
    id: "fn-2-bar",
    prompt: "/plan:deconflict fn-2-bar",
    cwd: "/repo/root",
  });
  expect(outcome).toBe("checkout_busy");
  expect(launches).toEqual([]);
});

test("dispatchEscalationSession: the per-key already_live guard wins over a busy checkout", async () => {
  // Both guards would fire; already_live is checked first (the specific-key short-circuit).
  const { deps, launches } = fakeEscalationDispatchDeps({
    isLive: true,
    checkoutBusy: true,
  });
  const outcome = await dispatchEscalationSession(deps, {
    verb: "deconflict",
    id: "fn-1-foo",
    prompt: "/plan:deconflict fn-1-foo",
    cwd: "/repo/root",
  });
  expect(outcome).toBe("already_live");
  expect(launches).toEqual([]);
});

test("dispatchEscalationSession: the checkout guard wins over the cap (an occupied checkout skips before the cap is consulted)", async () => {
  let capConsulted = false;
  const launches: { spec: unknown; cwd: string; label: string }[] = [];
  const deps: EscalationDispatchDeps = {
    countLiveEscalations: () => {
      capConsulted = true;
      return MAX_LIVE_ESCALATION_SESSIONS;
    },
    isEscalationLive: () => false,
    isCheckoutOccupied: () => true,
    resolveConfig: () => ({ model: "sonnet", effort: "high" }),
    launch: async (args) => {
      launches.push(args);
      return { ok: true };
    },
  };
  const outcome = await dispatchEscalationSession(deps, {
    verb: "deconflict",
    id: "fn-2-bar",
    prompt: "/plan:deconflict fn-2-bar",
    cwd: "/repo/root",
  });
  expect(outcome).toBe("checkout_busy");
  expect(launches).toEqual([]);
  expect(capConsulted).toBe(false);
});

test("dispatchEscalationSession: a free checkout under cap dispatches normally (the guard is not a blanket block)", async () => {
  const { deps, launches } = fakeEscalationDispatchDeps({
    checkoutBusy: false,
  });
  const outcome = await dispatchEscalationSession(deps, {
    verb: "deconflict",
    id: "fn-1-foo",
    prompt: "/plan:deconflict fn-1-foo",
    cwd: "/repo/root",
  });
  expect(outcome).toBe("dispatched");
  expect(launches.length).toBe(1);
});

test("dispatchEscalationSession: a THROWING launcher degrades to dispatch_failed (never throws)", async () => {
  const { deps } = fakeEscalationDispatchDeps({ launchThrows: true });
  const outcome = await dispatchEscalationSession(deps, {
    verb: "deconflict",
    id: "fn-1-foo",
    prompt: "/plan:deconflict fn-1-foo",
    cwd: "/repo/wt",
  });
  expect(outcome).toBe("dispatch_failed");
});

// ---- selectPendingHumanNotifications (the stage-3 working-set read) -----------

test("selectPendingHumanNotifications: picks only dispatched-but-not-notified close rows with the exact token", () => {
  const { db } = freshMemDb();
  // Deconflict dispatched, human not yet notified → SELECTED (the stage-3 working set).
  seedResolverFailureRow(db, {
    verb: "close",
    id: "fn-1-foo",
    reason: mergeConflictReason("fn-1-foo.2", "keeper/epic/fn-1-foo"),
    dir: "/repo/root",
    mergeEscalatedAt: 111,
  });
  // Not yet dispatched (merge_escalated_at NULL) → dropped (stage 2 owns it still).
  seedResolverFailureRow(db, {
    verb: "close",
    id: "fn-2-pending",
    reason: mergeConflictReason("fn-2-pending.1", "keeper/epic/fn-2-pending"),
    dir: "/repo/root",
  });
  // Already human-notified → dropped (notify-once).
  seedResolverFailureRow(db, {
    verb: "close",
    id: "fn-3-notified",
    reason: mergeConflictReason("fn-3-notified.1", "keeper/epic/fn-3-notified"),
    dir: "/repo/root",
    mergeEscalatedAt: 222,
  });
  db.run(
    "UPDATE dispatch_failures SET human_notified_at = 333 WHERE verb = 'close' AND id = ?",
    ["fn-3-notified"],
  );
  // Dispatched but an excluded reason token → dropped.
  seedResolverFailureRow(db, {
    verb: "close",
    id: "fn-4-lock",
    reason: "worktree-merge-lock-timeout: could not acquire the lock",
    mergeEscalatedAt: 444,
  });

  const rows = selectPendingHumanNotifications(db);
  expect(rows).toEqual([
    {
      id: "fn-1-foo",
      reason: mergeConflictReason("fn-1-foo.2", "keeper/epic/fn-1-foo"),
      dir: "/repo/root",
    },
  ]);
  db.close();
});

test("selectPendingHumanNotifications: empty table returns []", () => {
  const { db } = freshMemDb();
  expect(selectPendingHumanNotifications(db)).toEqual([]);
  db.close();
});

// ---- runDeconflictHumanNotifySweep (stage-3 orchestration core, injected deps) -

interface HumanNotifyMintCall {
  id: string;
  outcome: MergeHumanNotifiedOutcome;
}

function fakeHumanNotifySweepDeps(opts: {
  pending: PendingMergeEscalation[];
  stillPending?: (id: string) => boolean;
  deconflictOutcome?: (id: string) => ResolverOutcome;
  notify?: (
    row: PendingMergeEscalation,
    verdict: "declined" | "died",
  ) => Promise<MergeHumanNotifiedOutcome>;
  selectThrows?: boolean;
}): {
  deps: DeconflictHumanNotifySweepDeps;
  mints: HumanNotifyMintCall[];
  notifies: { id: string; verdict: "declined" | "died" }[];
} {
  const mints: HumanNotifyMintCall[] = [];
  const notifies: { id: string; verdict: "declined" | "died" }[] = [];
  const deps: DeconflictHumanNotifySweepDeps = {
    selectPending: () => {
      if (opts.selectThrows) throw new Error("read boom");
      return opts.pending;
    },
    stillPending: opts.stillPending ?? (() => true),
    // Default: the deconflict session already declined (terminal), so the notify fires.
    deconflictOutcome:
      opts.deconflictOutcome ??
      (() => ({ terminal: true, verdict: "declined" })),
    notifyHuman: async (row, verdict) => {
      notifies.push({ id: row.id, verdict });
      return (await opts.notify?.(row, verdict)) ?? "notified";
    },
    mintAttempted: (id, outcome) => mints.push({ id, outcome }),
  };
  return { deps, mints, notifies };
}

function humanNotifyPending(): PendingMergeEscalation[] {
  return [
    {
      id: "fn-1-foo",
      reason: mergeConflictReason("fn-1-foo.2", "keeper/epic/fn-1-foo"),
      dir: "/repo/root",
    },
  ];
}

test("runDeconflictHumanNotifySweep: a declined deconflict notifies the human ONCE and mints notified", async () => {
  const { deps, mints, notifies } = fakeHumanNotifySweepDeps({
    pending: humanNotifyPending(),
  });
  await runDeconflictHumanNotifySweep(deps);
  expect(notifies).toEqual([{ id: "fn-1-foo", verdict: "declined" }]);
  expect(mints).toEqual([{ id: "fn-1-foo", outcome: "notified" }]);
});

test("runDeconflictHumanNotifySweep: a DIED deconflict notifies once and carries the died verdict", async () => {
  const { deps, mints, notifies } = fakeHumanNotifySweepDeps({
    pending: humanNotifyPending(),
    deconflictOutcome: () => ({ terminal: true, verdict: "died" }),
  });
  await runDeconflictHumanNotifySweep(deps);
  expect(notifies).toEqual([{ id: "fn-1-foo", verdict: "died" }]);
  expect(mints).toEqual([{ id: "fn-1-foo", outcome: "notified" }]);
});

test("runDeconflictHumanNotifySweep: a notify_failed leaves the marker unset (re-sweepable, never silent)", async () => {
  const { deps, mints } = fakeHumanNotifySweepDeps({
    pending: humanNotifyPending(),
    notify: async () => "notify_failed",
  });
  await runDeconflictHumanNotifySweep(deps);
  expect(mints).toEqual([{ id: "fn-1-foo", outcome: "notify_failed" }]);
});

test("runDeconflictHumanNotifySweep: a THROWING notify never aborts the sweep (records notify_failed)", async () => {
  const { deps, mints } = fakeHumanNotifySweepDeps({
    pending: humanNotifyPending(),
    notify: async () => {
      throw new Error("botctl boom");
    },
  });
  await runDeconflictHumanNotifySweep(deps);
  expect(mints).toEqual([{ id: "fn-1-foo", outcome: "notify_failed" }]);
});

test("runDeconflictHumanNotifySweep: a live/not-yet-terminal deconflict defers — no notify, no mint", async () => {
  const { deps, mints, notifies } = fakeHumanNotifySweepDeps({
    pending: humanNotifyPending(),
    deconflictOutcome: () => ({ terminal: false }),
  });
  await runDeconflictHumanNotifySweep(deps);
  expect(notifies).toEqual([]);
  expect(mints).toEqual([]);
});

test("runDeconflictHumanNotifySweep: a row cleared mid-sweep (stillPending false, e.g. retry_dispatch) is skipped — no notify, no mint", async () => {
  const { deps, mints, notifies } = fakeHumanNotifySweepDeps({
    pending: humanNotifyPending(),
    stillPending: () => false,
  });
  await runDeconflictHumanNotifySweep(deps);
  expect(notifies).toEqual([]);
  expect(mints).toEqual([]);
});

test("runDeconflictHumanNotifySweep: a non-token reason is skipped (defense-in-depth gate)", async () => {
  const { deps, mints, notifies } = fakeHumanNotifySweepDeps({
    pending: [
      {
        id: "fn-1-foo",
        reason: "worktree-merge-lock-timeout: could not acquire the lock",
        dir: "/repo/root",
      },
    ],
  });
  await runDeconflictHumanNotifySweep(deps);
  expect(notifies).toEqual([]);
  expect(mints).toEqual([]);
});

test("runDeconflictHumanNotifySweep: an empty pending set is a no-op", async () => {
  const { deps, mints, notifies } = fakeHumanNotifySweepDeps({ pending: [] });
  await runDeconflictHumanNotifySweep(deps);
  expect(mints).toEqual([]);
  expect(notifies).toEqual([]);
});

test("runDeconflictHumanNotifySweep: a throwing selectPending degrades to a no-op (fail-open)", async () => {
  const { deps, mints, notifies } = fakeHumanNotifySweepDeps({
    pending: [],
    selectThrows: true,
  });
  await runDeconflictHumanNotifySweep(deps);
  expect(mints).toEqual([]);
  expect(notifies).toEqual([]);
});

// fn-701 task .3 — @parcel/watcher pre-warm. The native-addon dlopen race is
// timing-dependent and cannot be regression-tested directly, so these cover the
// helper's two contractual branches: a healthy load is a silent no-op (invoking
// the loader exactly once), and a genuine load failure fires the LOUD boot
// assertion (bun version + context) and RE-THROWS so the caller can take the
// single recovery path. The real boot wiring (`prewarmWatcherAddon()` →
// `fatalExit()`) is exercised by the live daemon; here we inject the loader +
// logger to drive the failure branch without a real broken addon.
test("prewarmWatcherAddon invokes the loader exactly once and stays silent on success", () => {
  let loaderCalls = 0;
  const logs: string[] = [];
  prewarmWatcherAddon(
    () => {
      loaderCalls += 1;
      return {};
    },
    (msg) => logs.push(msg),
  );
  expect(loaderCalls).toBe(1);
  expect(logs).toEqual([]);
});

test("prewarmWatcherAddon logs a loud boot assertion (bun version + context) and re-throws on a genuine load failure", () => {
  const logs: string[] = [];
  const boom = new Error("symbol 'napi_register_module_v1' not found");
  expect(() =>
    prewarmWatcherAddon(
      () => {
        throw boom;
      },
      (msg) => logs.push(msg),
    ),
  ).toThrow(boom);
  // Exactly one loud assertion line, and it must carry the diagnostic anchors:
  // the FATAL marker, the addon name, the actual bun version, and the
  // underlying error message — so a recurrence is greppable, not silent.
  expect(logs).toHaveLength(1);
  const line = logs[0] ?? "";
  expect(line).toContain("FATAL");
  expect(line).toContain("@parcel/watcher");
  expect(line).toContain(Bun.version);
  expect(line).toContain("napi_register_module_v1");
});

test("prewarmWatcherAddon: the loud assertion does NOT downgrade a genuine failure to a warning (it re-throws)", () => {
  // A no-op logger that swallows the line proves the escalation is in the
  // THROW, not the log — the caller (boot) escalates to fatalExit regardless of
  // what the logger does with the message.
  expect(() =>
    prewarmWatcherAddon(
      () => {
        throw new Error("ABI mismatch");
      },
      () => {},
    ),
  ).toThrow("ABI mismatch");
});

// ---- fn-1240 work-verb fan-in merge-conflict escalation (tier-2) --------------
// The full WORK escalation, mirroring the close pipeline: a stuck `work::<taskId>`
// `worktree-merge-conflict` row → `resolve::<taskId>` resolver (stage 1) → on its terminal
// decline a `deconflict::<taskId>` session (stage 2, sequenced behind the resolver's leased
// terminal verdict) → on ITS terminal decline the human is paged ONCE (stage 3). Identity
// is task-scoped so `resolve::`/`deconflict::<taskId>` never collide with the close path's
// epic-scoped sessions; `retry_dispatch` drops the row and re-arms the whole chain.

// ---- selectPendingWorkResolverDispatches (stage-1 working-set read) -----------

test("selectPendingWorkResolverDispatches: picks only work rows with the exact token and a NULL resolver latch", () => {
  const { db } = freshMemDb();
  // Dispatchable: a sticky work fan-in conflict, no resolver yet.
  seedResolverFailureRow(db, {
    verb: "work",
    id: "fn-1-foo.2",
    reason: mergeConflictReason("fn-1-foo.1", "keeper/epic/fn-1-foo"),
    dir: "/wt/lane",
  });
  // Already resolver-dispatched (latch set) → dropped (dispatch-once).
  seedResolverFailureRow(db, {
    verb: "work",
    id: "fn-2-done.3",
    reason: mergeConflictReason("fn-2-done.1", "keeper/epic/fn-2-done"),
    dir: "/wt/lane2",
    resolverDispatchedAt: 999,
  });
  // A non-merge-conflict work failure → dropped.
  seedResolverFailureRow(db, {
    verb: "work",
    id: "fn-3-launch.1",
    reason: "launch_failed: worker never bound",
    dir: "/wt/lane3",
  });
  // A `worktree-merge` PREFIX (not the exact token) → dropped.
  seedResolverFailureRow(db, {
    verb: "work",
    id: "fn-4-lock.1",
    reason: "worktree-merge-lock-timeout: could not acquire the lock",
    dir: "/wt/lane4",
  });
  // A CLOSE merge-conflict row → dropped (this selector is work-verb only).
  seedResolverFailureRow(db, {
    verb: "close",
    id: "fn-5-close",
    reason: mergeConflictReason("fn-5-close.1", "keeper/epic/fn-5-close"),
    dir: "/repo/root",
  });

  expect(selectPendingWorkResolverDispatches(db)).toEqual([
    {
      id: "fn-1-foo.2",
      reason: mergeConflictReason("fn-1-foo.1", "keeper/epic/fn-1-foo"),
      dir: "/wt/lane",
    },
  ]);
  db.close();
});

// ---- selectPendingWorkMergeEscalations (stage-2 working-set read) -------------

test("selectPendingWorkMergeEscalations: picks work rows with resolver dispatched but deconflict NOT yet dispatched", () => {
  const { db } = freshMemDb();
  // Escalatable: resolver dispatched (latch SET), deconflict latch still NULL.
  seedResolverFailureRow(db, {
    verb: "work",
    id: "fn-1-foo.2",
    reason: mergeConflictReason("fn-1-foo.1", "keeper/epic/fn-1-foo"),
    dir: "/wt/lane",
    resolverDispatchedAt: 111,
  });
  // Resolver NOT yet dispatched → NOT escalatable (the deconflict is sequenced behind it).
  seedResolverFailureRow(db, {
    verb: "work",
    id: "fn-2-nores.1",
    reason: mergeConflictReason("fn-2-nores.1", "keeper/epic/fn-2-nores"),
    dir: "/wt/lane2",
  });
  // Already escalated (deconflict dispatched) → dropped (escalate-once).
  seedResolverFailureRow(db, {
    verb: "work",
    id: "fn-3-esc.1",
    reason: mergeConflictReason("fn-3-esc.1", "keeper/epic/fn-3-esc"),
    dir: "/wt/lane3",
    resolverDispatchedAt: 111,
    mergeEscalatedAt: 222,
  });
  // A CLOSE row with the same latch shape → dropped (work-verb only).
  seedResolverFailureRow(db, {
    verb: "close",
    id: "fn-4-close",
    reason: mergeConflictReason("fn-4-close.1", "keeper/epic/fn-4-close"),
    dir: "/repo/root",
    resolverDispatchedAt: 111,
  });

  expect(selectPendingWorkMergeEscalations(db)).toEqual([
    {
      id: "fn-1-foo.2",
      reason: mergeConflictReason("fn-1-foo.1", "keeper/epic/fn-1-foo"),
      dir: "/wt/lane",
    },
  ]);
  db.close();
});

// ---- selectPendingWorkMergeNotifications (stage-3 working-set read) -----------
// Tier-2: the page is now SEQUENCED — gated on `merge_escalated_at IS NOT NULL` (the
// deconflict was dispatched), NOT firing straight away as in the page-only tier.

test("selectPendingWorkMergeNotifications: picks work rows with deconflict dispatched but human NOT yet paged", () => {
  const { db } = freshMemDb();
  // Pageable: deconflict dispatched (merge_escalated_at SET), not yet paged.
  seedResolverFailureRow(db, {
    verb: "work",
    id: "fn-1-foo.2",
    reason: mergeConflictReason("fn-1-foo.1", "keeper/epic/fn-1-foo"),
    dir: "/wt/lane",
    resolverDispatchedAt: 111,
    mergeEscalatedAt: 222,
  });
  // Deconflict NOT yet dispatched (merge_escalated_at NULL) → dropped (the tier-2 page
  // waits for the deconflict, unlike the old page-only tier which fired straight away).
  seedResolverFailureRow(db, {
    verb: "work",
    id: "fn-2-noesc.1",
    reason: mergeConflictReason("fn-2-noesc.1", "keeper/epic/fn-2-noesc"),
    dir: "/wt/lane2",
    resolverDispatchedAt: 111,
  });
  // Already paged (human_notified_at set) → dropped (page-once).
  seedResolverFailureRow(db, {
    verb: "work",
    id: "fn-3-paged.1",
    reason: mergeConflictReason("fn-3-paged.1", "keeper/epic/fn-3-paged"),
    dir: "/wt/lane3",
    resolverDispatchedAt: 111,
    mergeEscalatedAt: 222,
  });
  db.run(
    "UPDATE dispatch_failures SET human_notified_at = 333 WHERE verb = 'work' AND id = ?",
    ["fn-3-paged.1"],
  );
  // A non-merge-conflict work failure → dropped (never pages).
  seedResolverFailureRow(db, {
    verb: "work",
    id: "fn-4-launch.1",
    reason: "launch_failed: worker never bound",
    dir: "/wt/lane4",
    mergeEscalatedAt: 222,
  });
  // A CLOSE merge-conflict row → dropped (this selector is work-verb only).
  seedResolverFailureRow(db, {
    verb: "close",
    id: "fn-5-close",
    reason: mergeConflictReason("fn-5-close.1", "keeper/epic/fn-5-close"),
    dir: "/repo/root",
    resolverDispatchedAt: 111,
    mergeEscalatedAt: 222,
  });

  expect(selectPendingWorkMergeNotifications(db)).toEqual([
    {
      id: "fn-1-foo.2",
      reason: mergeConflictReason("fn-1-foo.1", "keeper/epic/fn-1-foo"),
      dir: "/wt/lane",
    },
  ]);
  db.close();
});

test("selectPendingWork* selectors: empty table returns []", () => {
  const { db } = freshMemDb();
  expect(selectPendingWorkResolverDispatches(db)).toEqual([]);
  expect(selectPendingWorkMergeEscalations(db)).toEqual([]);
  expect(selectPendingWorkMergeNotifications(db)).toEqual([]);
  db.close();
});

// ---- buildWorkMergeHumanNotifyBody (pure terminal page body) ------------------

test("buildWorkMergeHumanNotifyBody: names the task, verdict, lane, reason, and the unstick command", () => {
  const body = buildWorkMergeHumanNotifyBody({
    taskId: "fn-1-foo.2",
    lane: "/wt/lane",
    reason: mergeConflictReason("fn-1-foo.1", "keeper/epic/fn-1-foo"),
    verdict: "declined",
  });
  expect(body).toContain("work::fn-1-foo.2");
  // Tier-2 framing: both the resolver AND the deconflict session gave up.
  expect(body).toContain("the autonomous merge-resolver AND the");
  expect(body).toContain("DECLINED");
  expect(body).toContain("keeper autopilot retry work::fn-1-foo.2");
  expect(body).toContain("Lane: /wt/lane");
  expect(body).toContain("CONFLICT (content): Merge conflict in src/foo.ts");
});

test("buildWorkMergeHumanNotifyBody: a `died` verdict frames the deconflict session death", () => {
  const body = buildWorkMergeHumanNotifyBody({
    taskId: "fn-1-foo.2",
    lane: "/wt/lane",
    reason: mergeConflictReason("fn-1-foo.1", "keeper/epic/fn-1-foo"),
    verdict: "died",
  });
  expect(body).toContain("DIED");
});

test("buildWorkMergeHumanNotifyBody: a null/empty lane degrades to `?` (never throws)", () => {
  const body = buildWorkMergeHumanNotifyBody({
    taskId: "fn-1-foo.2",
    lane: null,
    reason: "worktree-merge-conflict: merging a into b — x",
    verdict: "declined",
  });
  expect(body).toContain("Lane: ?");
});

test("buildWorkMergeHumanNotifyBody: a pathological reason is size-bounded (no unbounded botctl arg)", () => {
  const hugeStderr = "CONFLICT ".repeat(500); // ~4.5k chars
  const body = buildWorkMergeHumanNotifyBody({
    taskId: "fn-1-foo.2",
    lane: "/wt/lane",
    reason: `worktree-merge-conflict: merging a into b — ${hugeStderr}`,
    verdict: "declined",
  });
  expect(body).toContain("[truncated]");
  // The whole body stays comfortably bounded despite the pathological stderr.
  expect(body.length).toBeLessThan(1200);
});

// ---- buildWorkResolverBrief (pure resolver brief) ----------------------------

test("buildWorkResolverBrief: task-scoped framing, the lane cwd DIRECTLY, and the shared guardrail", () => {
  const brief = buildWorkResolverBrief({
    taskId: "fn-1-foo.2",
    reason: mergeConflictReason("fn-1-foo.1", "keeper/epic/fn-1-foo"),
    laneDir: "/wt/lane",
  });
  // Task-scoped framing + unstick command (never the close path's epic/close::).
  expect(brief).toContain("task fn-1-foo.2");
  expect(brief).toContain("work::fn-1-foo.2");
  expect(brief).toContain("keeper autopilot retry work::fn-1-foo.2");
  expect(brief).not.toContain("close::");
  // The worker cds to the lane dir DIRECTLY (per the ADR — not a fabricated worktree path)
  // and re-runs the fan-in merge of the parsed source.
  expect(brief).toContain("cd /wt/lane");
  expect(brief).toContain("git merge --no-ff fn-1-foo.1");
  // The classify-or-BLOCK guardrail is reused VERBATIM from the close resolver brief.
  expect(brief).toContain(
    "GUARDRAIL — your authority is narrower than a human's.",
  );
  expect(brief).toContain("SCHEMA-VERSION COLLISION CARVE-OUT");
  // Green-gate: passing tests are necessary, not sufficient.
  expect(brief).toContain("passing tests are");
});

test("buildWorkResolverBrief: a parse-miss / missing lane degrades to a still-actionable brief (never throws)", () => {
  const brief = buildWorkResolverBrief({
    taskId: "fn-1-foo.2",
    reason: "worktree-merge-conflict: unparseable head",
    laneDir: null,
  });
  expect(brief).toContain("task fn-1-foo.2");
  expect(brief).toContain("keeper autopilot retry work::fn-1-foo.2");
  // Still carries the guardrail even on the degraded path.
  expect(brief).toContain(
    "GUARDRAIL — your authority is narrower than a human's.",
  );
});

// ---- runWorkMergeHumanNotifySweep (orchestration core, injected deps) ---------

function fakeWorkMergeSweepDeps(opts: {
  pending: PendingWorkMergeConflict[];
  stillPending?: (id: string) => boolean;
  deconflictOutcome?: (id: string) => ResolverOutcome;
  notify?: (
    row: PendingWorkMergeConflict,
    verdict: "declined" | "died",
  ) => Promise<MergeHumanNotifiedOutcome>;
  selectThrows?: boolean;
}): {
  deps: WorkMergeHumanNotifySweepDeps;
  mints: HumanNotifyMintCall[];
  notifies: Array<{ id: string; verdict: "declined" | "died" }>;
} {
  const mints: HumanNotifyMintCall[] = [];
  const notifies: Array<{ id: string; verdict: "declined" | "died" }> = [];
  const deps: WorkMergeHumanNotifySweepDeps = {
    selectPending: () => {
      if (opts.selectThrows) throw new Error("read boom");
      return opts.pending;
    },
    stillPending: opts.stillPending ?? (() => true),
    // Default: the deconflict already declined (terminal), so the page fires.
    deconflictOutcome:
      opts.deconflictOutcome ??
      (() => ({ terminal: true, verdict: "declined" }) as ResolverOutcome),
    notifyHuman: async (row, verdict) => {
      notifies.push({ id: row.id, verdict });
      return (await opts.notify?.(row, verdict)) ?? "notified";
    },
    mintAttempted: (id, outcome) => mints.push({ id, outcome }),
  };
  return { deps, mints, notifies };
}

function workMergePending(): PendingWorkMergeConflict[] {
  return [
    {
      id: "fn-1-foo.2",
      reason: mergeConflictReason("fn-1-foo.1", "keeper/epic/fn-1-foo"),
      dir: "/wt/lane",
    },
  ];
}

test("runWorkMergeHumanNotifySweep: a declined deconflict pages the human ONCE with the verdict and mints notified", async () => {
  const { deps, mints, notifies } = fakeWorkMergeSweepDeps({
    pending: workMergePending(),
  });
  await runWorkMergeHumanNotifySweep(deps);
  expect(notifies).toEqual([{ id: "fn-1-foo.2", verdict: "declined" }]);
  expect(mints).toEqual([{ id: "fn-1-foo.2", outcome: "notified" }]);
});

test("runWorkMergeHumanNotifySweep: a LIVE (non-terminal) deconflict session defers the page — no page, no mint", async () => {
  // Sequencing: the human is paged ONLY at the deconflict's terminal decline. While it is
  // live (or its job has not folded yet) the sweep skips without minting — a successful
  // deconflict would clear the sticky before this ever fires.
  const { deps, mints, notifies } = fakeWorkMergeSweepDeps({
    pending: workMergePending(),
    deconflictOutcome: () => ({ terminal: false }),
  });
  await runWorkMergeHumanNotifySweep(deps);
  expect(notifies).toEqual([]);
  expect(mints).toEqual([]);
});

test("runWorkMergeHumanNotifySweep: a died deconflict pages with the `died` verdict", async () => {
  const { deps, notifies } = fakeWorkMergeSweepDeps({
    pending: workMergePending(),
    deconflictOutcome: () => ({ terminal: true, verdict: "died" }),
  });
  await runWorkMergeHumanNotifySweep(deps);
  expect(notifies).toEqual([{ id: "fn-1-foo.2", verdict: "died" }]);
});

test("runWorkMergeHumanNotifySweep: an empty pending set (already-paged row dropped by selector) is a no-op", async () => {
  const { deps, mints, notifies } = fakeWorkMergeSweepDeps({ pending: [] });
  await runWorkMergeHumanNotifySweep(deps);
  expect(notifies).toEqual([]);
  expect(mints).toEqual([]);
});

test("runWorkMergeHumanNotifySweep: a failed page leaves the marker unminted-terminal (notify_failed re-sweeps)", async () => {
  const { deps, mints } = fakeWorkMergeSweepDeps({
    pending: workMergePending(),
    notify: async () => "notify_failed",
  });
  await runWorkMergeHumanNotifySweep(deps);
  // notify_failed mints attempted{notify_failed} — the fold no-ops on it, so the marker
  // stays NULL and the next sweep retries the page.
  expect(mints).toEqual([{ id: "fn-1-foo.2", outcome: "notify_failed" }]);
});

test("runWorkMergeHumanNotifySweep: a THROWING notifier never aborts the sweep (records notify_failed)", async () => {
  const { deps, mints } = fakeWorkMergeSweepDeps({
    pending: workMergePending(),
    notify: async () => {
      throw new Error("botctl boom");
    },
  });
  await runWorkMergeHumanNotifySweep(deps);
  expect(mints).toEqual([{ id: "fn-1-foo.2", outcome: "notify_failed" }]);
});

test("runWorkMergeHumanNotifySweep: a row cleared mid-sweep (stillPending false) is skipped — no page, no mint", async () => {
  const { deps, mints, notifies } = fakeWorkMergeSweepDeps({
    pending: workMergePending(),
    stillPending: () => false,
  });
  await runWorkMergeHumanNotifySweep(deps);
  expect(notifies).toEqual([]);
  expect(mints).toEqual([]);
});

test("runWorkMergeHumanNotifySweep: a non-token reason in the pending set is NOT paged (defense-in-depth gate)", async () => {
  const { deps, mints, notifies } = fakeWorkMergeSweepDeps({
    pending: [
      {
        id: "fn-1-foo.2",
        reason: "worktree-merge-lock-timeout: could not acquire the lock",
        dir: "/wt/lane",
      },
    ],
  });
  await runWorkMergeHumanNotifySweep(deps);
  expect(notifies).toEqual([]);
  expect(mints).toEqual([]);
});

test("runWorkMergeHumanNotifySweep: a throwing selectPending degrades to a no-op (fail-open)", async () => {
  const { deps, mints, notifies } = fakeWorkMergeSweepDeps({
    pending: [],
    selectThrows: true,
  });
  await runWorkMergeHumanNotifySweep(deps);
  expect(mints).toEqual([]);
  expect(notifies).toEqual([]);
});

// ---- workLaneBusyForResolver (the retry-in-flight resolver exclusion) ---------

test("workLaneBusyForResolver: a live work OR resolve session for the task blocks; a stopped/dead one does not", () => {
  const taskId = "fn-1-foo.2";
  // A manual `retry_dispatch` re-dispatched the work lane → a live `work::<taskId>` → busy.
  expect(
    workLaneBusyForResolver(
      [mkResolveJob({ plan_verb: "work", plan_ref: taskId, state: "working" })],
      taskId,
    ),
  ).toBe(true);
  // A resolver already in flight → live `resolve::<taskId>` → busy (double-dispatch guard).
  expect(
    workLaneBusyForResolver(
      [mkResolveJob({ plan_ref: taskId, state: "working" })],
      taskId,
    ),
  ).toBe(true);
  // A stopped work/resolve session has yielded its turn → NOT busy.
  expect(
    workLaneBusyForResolver(
      [
        mkResolveJob({ plan_verb: "work", plan_ref: taskId, state: "stopped" }),
        mkResolveJob({ plan_ref: taskId, state: "killed" }),
      ],
      taskId,
    ),
  ).toBe(false);
  // A DIFFERENT task's live work session never blocks this one.
  expect(
    workLaneBusyForResolver(
      [
        mkResolveJob({
          plan_verb: "work",
          plan_ref: "fn-2-bar.1",
          state: "working",
        }),
      ],
      taskId,
    ),
  ).toBe(false);
  // Empty jobs → not busy.
  expect(workLaneBusyForResolver([], taskId)).toBe(false);
});

// ---- classifyWorkResolverOutcome (the leased resolver-outcome gate) -----------

test("classifyWorkResolverOutcome: a declined/died/live resolver classifies exactly as the base (no lease)", () => {
  const taskId = "fn-1-foo.2";
  const now = 10_000;
  // Stopped resolver, sticky survives → declined.
  const declined = new Map<string, Job>([
    ["j", mkResolveJob({ plan_ref: taskId, state: "stopped" })],
  ]);
  expect(
    classifyWorkResolverOutcome(
      declined,
      taskId,
      100,
      now,
      WORK_RESOLVER_LEASE_SEC,
    ),
  ).toEqual({ terminal: true, verdict: "declined" });
  // Killed resolver → died.
  const died = new Map<string, Job>([
    ["j", mkResolveJob({ plan_ref: taskId, state: "killed" })],
  ]);
  expect(
    classifyWorkResolverOutcome(
      died,
      taskId,
      100,
      now,
      WORK_RESOLVER_LEASE_SEC,
    ),
  ).toEqual({ terminal: true, verdict: "died" });
  // Working resolver → NOT terminal, and NEVER leased out even with an ancient latch.
  const live = new Map<string, Job>([
    ["j", mkResolveJob({ plan_ref: taskId, state: "working" })],
  ]);
  expect(
    classifyWorkResolverOutcome(live, taskId, 1, now, WORK_RESOLVER_LEASE_SEC),
  ).toEqual({ terminal: false });
});

test("classifyWorkResolverOutcome: a never-folded resolver waits within the lease, then reclaims as died (no deadlock)", () => {
  const taskId = "fn-1-foo.2";
  const empty = new Map<string, Job>(); // launch reported ok, jobs row never folded
  const dispatchedAt = 1_000;
  // Within the lease: still waiting for the row to fold (base non-terminal).
  expect(
    classifyWorkResolverOutcome(
      empty,
      taskId,
      dispatchedAt,
      dispatchedAt + WORK_RESOLVER_LEASE_SEC - 1,
      WORK_RESOLVER_LEASE_SEC,
    ),
  ).toEqual({ terminal: false });
  // Past the lease with no live resolver → reclaim as died so the deconflict dispatches.
  expect(
    classifyWorkResolverOutcome(
      empty,
      taskId,
      dispatchedAt,
      dispatchedAt + WORK_RESOLVER_LEASE_SEC + 1,
      WORK_RESOLVER_LEASE_SEC,
    ),
  ).toEqual({ terminal: true, verdict: "died" });
  // A NULL latch (no dispatch recorded) never reclaims — nothing to lease against.
  expect(
    classifyWorkResolverOutcome(
      empty,
      taskId,
      null,
      10_000_000,
      WORK_RESOLVER_LEASE_SEC,
    ),
  ).toEqual({ terminal: false });
});

test("runMergeEscalationSweep + classifyWorkResolverOutcome: a leased-out crashed resolver dispatches the work deconflict (end-to-end)", async () => {
  // The stage-2 sweep is the generic `runMergeEscalationSweep`; wired with the work-verb
  // leased resolver-outcome classifier, a crashed/never-folded resolver past the lease reads
  // terminal and the deconflict dispatches — the no-deadlock guarantee end-to-end.
  const empty = new Map<string, Job>();
  const { deps, mints, dispatches } = fakeMergeSweepDeps({
    pending: [
      {
        id: "fn-1-foo.2",
        reason: mergeConflictReason("fn-1-foo.1", "keeper/epic/fn-1-foo"),
        dir: "/wt/lane",
      },
    ],
    resolverOutcome: (id) =>
      classifyWorkResolverOutcome(
        empty,
        id,
        1_000,
        1_000 + WORK_RESOLVER_LEASE_SEC + 5,
        WORK_RESOLVER_LEASE_SEC,
      ),
  });
  await runMergeEscalationSweep(deps);
  expect(dispatches.length).toBe(1);
  expect(mints).toEqual([{ id: "fn-1-foo.2", outcome: "dispatched" }]);
});

// ---------------------------------------------------------------------------
// fn-749 task .1 — worker-set selector
// ---------------------------------------------------------------------------

/** Map a spawned worker-module URL back to its {@link WorkerName}. */
const WORKER_MODULE_TO_NAME: Record<string, WorkerName> = {
  "wake-worker.ts": "wake",
  "server-worker.ts": "server",
  "transcript-worker.ts": "transcript",
  "plan-worker.ts": "plan",
  "exit-watcher.ts": "exit",
  "git-worker.ts": "git",
  "statusline-worker.ts": "statusline",
  "builds-worker.ts": "builds",
  "account-observer-worker.ts": "accountObserver",
  "dead-letter-worker.ts": "deadLetter",
  "events-ingest-worker.ts": "eventsIngest",
  "birth-ingest-worker.ts": "birthIngest",
  "autopilot-worker.ts": "autopilot",
  "handoff-worker.ts": "handoff",
  "maintenance-worker.ts": "maintenance",
  "restore-worker.ts": "restore",
  "renamer-worker.ts": "renamer",
  "autoclose-worker.ts": "autoclose",
  "bus-worker.ts": "bus",
  "tmux-control-worker.ts": "tmuxControl",
  "baseline-worker.ts": "baseline",
};

/**
 * fn-749 — boot `startDaemon(opts)` under a `globalThis.Worker` constructor SPY
 * that records each spawned worker's module name WITHOUT creating a real thread
 * (so no `@parcel/watcher` dlopen, no UDS bind, no kernel fd). The stub satisfies
 * the property/method surface `startDaemon` touches during its synchronous boot
 * (`onmessage`/`onerror` setters + `addEventListener`); the boot's DB work runs
 * for real against the sandboxed tmp DB. Returns the captured set of spawned
 * worker NAMES, in spawn order.
 *
 * The `close` listeners the boot wires (the fatalExit-on-crash guards) are NEVER
 * fired by the stub, so the `!shuttingDown` crash path can't trip the test
 * runner. We do NOT call `handle.stop()` (no real workers to tear down); the
 * sandboxed DB connection is released when the test process ends and the tmpdir
 * is removed in `afterEach`.
 */
function spawnedWorkerNames(opts?: {
  workers?: readonly WorkerName[];
}): WorkerName[] {
  const captured: WorkerName[] = [];

  // Minimal Worker stub — records the module name, no-ops the lifecycle surface.
  class WorkerSpy {
    onmessage: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    constructor(url: string | URL) {
      const href = typeof url === "string" ? url : url.href;
      const leaf = href.split("/").pop() ?? href;
      const name = WORKER_MODULE_TO_NAME[leaf];
      if (name) captured.push(name);
    }
    addEventListener(): void {}
    postMessage(): void {}
    terminate(): void {}
  }

  const realWorker = globalThis.Worker;
  // Sandbox every state path on the LIVE process.env for the synchronous boot
  // window, mirroring the in-process harness (the path resolvers read
  // process.env directly). Restore exactly afterward — no `await` between set
  // and restore, so it stays parallel-safe.
  const sockPath = join(tmpDir, "keeperd.sock");
  // The builds worker spawn is gated on a configured `buildbot_url`. Pin a temp
  // config carrying it so this boot is deterministic regardless of the live
  // `~/.config/keeper/config.yaml` — `builds` is in ALL_WORKERS and must spawn.
  const configPath = join(tmpDir, "keeper-config.yaml");
  // `builds` is gated on a configured `buildbot_url`; pin it so that worker
  // spawns deterministically.
  writeFileSync(configPath, "buildbot_url: http://localhost:8010\n");
  const sandbox: Record<string, string> = {
    KEEPER_DB: dbPath,
    KEEPER_CONFIG: configPath,
    KEEPER_DEAD_LETTER_DIR: join(tmpDir, "dead-letters"),
    KEEPER_EVENTS_LOG: join(tmpDir, "events-log"),
    KEEPER_DROP_LOG: join(tmpDir, "hook-drops.ndjson"),
    KEEPER_RESTORE_FILE: join(tmpDir, "restore.json"),
    KEEPER_BACKSTOP_LOG: join(tmpDir, "backstop.ndjson"),
    KEEPER_RESTART_LEDGER: join(tmpDir, "restart-ledger.json"),
    KEEPER_SOCK: sockPath,
  };
  const prior: Record<string, string | undefined> = {};
  for (const k of Object.keys(sandbox)) prior[k] = process.env[k];

  let handle: DaemonHandle | null = null;
  try {
    (globalThis as { Worker: unknown }).Worker = WorkerSpy;
    for (const [k, v] of Object.entries(sandbox)) process.env[k] = v;
    // Boot is fully synchronous up to the returned handle (every `new Worker`
    // fires here, under the spy). Disable the single-instance flock: it runs on
    // MAIN (not stubbed by WorkerSpy) and would otherwise take the real host lock.
    handle = startDaemon({
      workers: opts?.workers,
      disableSingleInstanceLock: true,
    });
  } finally {
    (globalThis as { Worker: unknown }).Worker = realWorker;
    for (const k of Object.keys(sandbox)) {
      const v = prior[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  void handle;
  return captured;
}

test("the production boot spawns the complete worker set", () => {
  // A boot with no selector must spawn exactly ALL_WORKERS, in order. The
  // configured buildbot URL makes the optional builds worker deterministic.
  const spawned = spawnedWorkerNames();
  expect(spawned).toEqual([...ALL_WORKERS]);
  expect(spawned).toHaveLength(21);
  // And ALL_WORKERS itself is the exact set, pinned so a future worker add/rename
  // must consciously update this contract.
  expect([...ALL_WORKERS]).toEqual([
    "wake",
    "server",
    "transcript",
    "plan",
    "exit",
    "git",
    "statusline",
    "builds",
    "accountObserver",
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
  ]);
});

// ---------------------------------------------------------------------------
// fn-1107 task .4 — the autoclose intent-hint set + the Killed-mint relabel.
// The autoclose worker posts a pre-kill hint; main consults it at the SOLE
// Killed-mint site so a hinted death stamps `kill_reason: 'autoclosed'` and every
// other death keeps `exit_watched`. The set is a pure structure (injected clock);
// the mint-relabel test mirrors the exit-watcher onmessage closure driven directly
// (the established insertPlanSnapshot/insertDispatchedRow pattern — no Worker).
// ---------------------------------------------------------------------------

test("AUTOCLOSE_HINT_TTL_MS outlives the reprobe backstop worst case", () => {
  // The hint must survive until the slowest exit-observe path mints the Killed:
  // the reprobe backstop cannot reap a row until it ages past REPROBE_MIN_AGE_SECS
  // (300s) and then fires on up to one more REPROBE_MS (60s) tick. The TTL is sized
  // OFF those constants (doubled age gate + a tick), never a guessed literal.
  expect(AUTOCLOSE_HINT_TTL_MS).toBe(300 * 2 * 1000 + 60_000);
  expect(AUTOCLOSE_HINT_TTL_MS).toBeGreaterThan(300 * 1000 + 60_000);
});

test("AutocloseHintSet: a matching hint is consumed exactly once", () => {
  const nowMs = 1_000_000;
  const hints = new AutocloseHintSet(10_000, () => nowMs);
  hints.post("job-a", 4242, "darwin:start-a");
  expect(hints.size()).toBe(1);

  // First consume with the matching identity → true, and the entry is gone.
  expect(hints.consume("job-a", 4242, "darwin:start-a")).toBe(true);
  expect(hints.size()).toBe(0);
  // A second consume finds nothing → exit_watched fallback.
  expect(hints.consume("job-a", 4242, "darwin:start-a")).toBe(false);
});

test("AutocloseHintSet: an expired hint is not consumed", () => {
  let nowMs = 1_000_000;
  const hints = new AutocloseHintSet(10_000, () => nowMs);
  hints.post("job-a", 7, "start");
  // Advance past the TTL — the hint has expired.
  nowMs += 10_001;
  expect(hints.consume("job-a", 7, "start")).toBe(false);
  expect(hints.size()).toBe(0);
});

test("AutocloseHintSet: an identity mismatch does not consume, a later match still does", () => {
  const nowMs = 1_000_000;
  const hints = new AutocloseHintSet(10_000, () => nowMs);
  hints.post("job-a", 100, "start-x");
  // Wrong pid → no consume; the entry survives for a correct event.
  expect(hints.consume("job-a", 999, "start-x")).toBe(false);
  // Wrong start_time → no consume either.
  expect(hints.consume("job-a", 100, "start-y")).toBe(false);
  expect(hints.size()).toBe(1);
  // The correct identity still consumes it once.
  expect(hints.consume("job-a", 100, "start-x")).toBe(true);
  expect(hints.size()).toBe(0);
});

test("AutocloseHintSet: null pid/start_time match null-tolerantly (pidless reap)", () => {
  const hints = new AutocloseHintSet(10_000);
  // A pidless-reap hint: both sides NULL → match.
  hints.post("job-a", null, null);
  expect(hints.consume("job-a", null, null)).toBe(true);

  // A hint with a NULL start_time matches any exit start_time (loose side).
  hints.post("job-b", 55, null);
  expect(hints.consume("job-b", 55, "whatever")).toBe(true);

  // A hint carrying a real pid is NOT matched by a pidless (null-pid) exit.
  hints.post("job-c", 88, "start");
  expect(hints.consume("job-c", null, "start")).toBe(false);
});

test("AutocloseHintSet: a repeat post refreshes expiry and prunes dead entries", () => {
  let nowMs = 0;
  const hints = new AutocloseHintSet(10_000, () => nowMs);
  hints.post("job-a", 1, "s"); // expires at 10_000
  nowMs = 9_000;
  hints.post("job-a", 1, "s"); // refresh → expires at 19_000
  nowMs = 15_000;
  // Still live thanks to the refresh.
  expect(hints.consume("job-a", 1, "s")).toBe(true);

  // A fresh post opportunistically prunes an unrelated expired entry.
  nowMs = 0;
  const h2 = new AutocloseHintSet(10_000, () => nowMs);
  h2.post("stale", 1, "s");
  nowMs = 20_000;
  h2.post("fresh", 2, "s"); // the post-time prune drops `stale`
  expect(h2.consume("stale", 1, "s")).toBe(false);
  expect(h2.consume("fresh", 2, "s")).toBe(true);
});

/** Mint a synthetic `Killed` exactly as the exit-watcher onmessage closure does:
 *  select the reason via the hint set (a match → 'autoclosed', else 'exit_watched')
 *  and ride it on the payload the reducer folds onto `jobs.kill_reason`. */
function mintKilledViaHint(
  db: ReturnType<typeof openDb>["db"],
  hints: AutocloseHintSet,
  jobId: string,
  pid: number | null,
  startTime: string | null,
  tsSec: number,
): void {
  const reason = hints.consume(jobId, pid, startTime)
    ? "autoclosed"
    : "exit_watched";
  db.run(
    `INSERT INTO events (ts, session_id, hook_event, event_type, data)
       VALUES (?, ?, 'Killed', 'killed', ?)`,
    [
      tsSec,
      jobId,
      JSON.stringify({ pid, start_time: startTime, close_kind: null, reason }),
    ],
  );
}

test("the Killed mint stamps 'autoclosed' on a hint match and 'exit_watched' otherwise", () => {
  const { db } = freshMemDb();
  const hints = new AutocloseHintSet(AUTOCLOSE_HINT_TTL_MS);

  // A hinted death (autoclose posted the intent just before killing the window).
  seedJobsRow(db, "sess-autoclosed", 4242, "darwin:start-a");
  hints.post("sess-autoclosed", 4242, "darwin:start-a");
  mintKilledViaHint(db, hints, "sess-autoclosed", 4242, "darwin:start-a", 100);

  // An unhinted death (an ordinary observed exit) — keeps exit_watched.
  seedJobsRow(db, "sess-exit", 5353, "darwin:start-b");
  mintKilledViaHint(db, hints, "sess-exit", 5353, "darwin:start-b", 101);

  drainToCompletion(db);

  const reasonOf = (jobId: string): string | null =>
    (
      db.query("SELECT kill_reason FROM jobs WHERE job_id = ?").get(jobId) as {
        kill_reason: string | null;
      }
    ).kill_reason;
  const stateOf = (jobId: string): string =>
    (
      db.query("SELECT state FROM jobs WHERE job_id = ?").get(jobId) as {
        state: string;
      }
    ).state;

  expect(stateOf("sess-autoclosed")).toBe("killed");
  expect(reasonOf("sess-autoclosed")).toBe("autoclosed");
  expect(stateOf("sess-exit")).toBe("killed");
  expect(reasonOf("sess-exit")).toBe("exit_watched");

  // The hint was consumed once — a second observed exit for the same job falls
  // back to exit_watched (a re-opened row would carry a fresh identity anyway).
  seedJobsRow(db, "sess-autoclosed-again", 4242, "darwin:start-a");
  mintKilledViaHint(
    db,
    hints,
    "sess-autoclosed-again",
    4242,
    "darwin:start-a",
    102,
  );
  drainToCompletion(db);
  expect(reasonOf("sess-autoclosed-again")).toBe("exit_watched");

  db.close();
});

test("fn-749: passing the full ALL_WORKERS set is identical to passing no selector", () => {
  // The production default is ALL_WORKERS, so an explicit full set is a no-op.
  expect(spawnedWorkerNames({ workers: ALL_WORKERS })).toEqual([
    ...ALL_WORKERS,
  ]);
});

test("fn-749: a minimal selector spawns ONLY the named workers (no watcher worker)", () => {
  // The UDS/RPC/fold tier's set: wake (main's reducer pump) + server (UDS).
  const minimal = spawnedWorkerNames({ workers: ["wake", "server"] });
  expect(minimal).toEqual(["wake", "server"]);
  // Crucially NONE of the @parcel/watcher workers spawned.
  for (const w of [
    "transcript",
    "plan",
    "statusline",
    "deadLetter",
    "eventsIngest",
    "birthIngest",
  ] as const) {
    expect(minimal).not.toContain(w);
  }

  // The plan-fold tier's set additionally boots the plan worker — and ONLY it
  // among the watchers.
  const planSet = spawnedWorkerNames({ workers: ["wake", "server", "plan"] });
  expect(planSet).toEqual(["wake", "server", "plan"]);
});

// ---------------------------------------------------------------------------
// fn-929: the folded `keeper agent` launcher is keeper's sole launch transport
// (no tmux-launch fallback), so boot fail-fasts with a loud warning when the
// launcher SELF-check fails rather than spiralling into the per-launch ENOENT →
// never-bound breaker. The self-check self-invokes `<bun> <keeper.ts> agent
// --version` — the SAME launcher argv the dispatch path embeds.
// ---------------------------------------------------------------------------

const PROBE_PREFIX = ["/abs/bun", "/abs/cli/keeper.ts", "agent"];

test("checkKeeperAgentPresence: present (exit 0) returns true, self-invokes `--version`, logs the launcher", () => {
  const logs: string[] = [];
  const probed: string[][] = [];
  const ok = checkKeeperAgentPresence(PROBE_PREFIX, {
    spawn: (argv) => {
      probed.push(argv);
      return { success: true, exitCode: 0 };
    },
    log: (m) => logs.push(m),
  });
  expect(ok).toBe(true);
  // Self-check ran the SAME launcher argv the dispatch path embeds, + --version.
  expect(probed).toEqual([[...PROBE_PREFIX, "--version"]]);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("/abs/cli/keeper.ts");
});

test("checkKeeperAgentPresence: non-zero exit returns false and warns with the launcher + repair hint", () => {
  const logs: string[] = [];
  const ok = checkKeeperAgentPresence(PROBE_PREFIX, {
    spawn: () => ({ success: false, exitCode: 127 }),
    log: (m) => logs.push(m),
  });
  expect(ok).toBe(false);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("WARNING");
  expect(logs[0]).toContain("/abs/cli/keeper.ts");
  expect(logs[0]).toContain("KEEPER_AGENT_PATH");
});

test("checkKeeperAgentPresence: a throwing spawn (unlaunchable launcher) returns false and warns", () => {
  const logs: string[] = [];
  const ok = checkKeeperAgentPresence(
    ["/no/such/bun", "/no/keeper.ts", "agent"],
    {
      spawn: () => {
        throw new Error("ENOENT");
      },
      log: (m) => logs.push(m),
    },
  );
  expect(ok).toBe(false);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("WARNING");
  expect(logs[0]).toContain("/no/keeper.ts");
});

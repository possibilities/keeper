/**
 * Daemon boot-drain test. Verifies the catch-up path independent of the wake
 * mechanism: pre-seed the `events` table, then drive `drainToCompletion`
 * directly against a tmp DB (no Worker spawned — `daemon.ts` is import-safe
 * behind its `import.meta.main` guard). The full wake-worker → reducer
 * round-trip is covered by the end-to-end integration test.
 *
 * Dispatch-clear producer coverage: retry binds at append; boot orphan GC,
 * crash-loop, bus, and paging recovery carry decision-point episodes; worker
 * generic/distress messages preserve their immutable fences; repair and shared
 * dirty positive-evidence clears retain pre-await owners. The common-helper tests
 * pin matching, stale, claimless, and failed-append behavior for every route.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectAutopilotPaused } from "../cli/autopilot";
import { archiveEligibility } from "../scripts/archive-recovered-dead-letters";
import {
  materializeNonFableFocusPolicy,
  readNonFableFocusLeaf,
  serializeNonFableFocusPolicy,
} from "../src/account-focus";
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
import type { RecordedProcessIdentityVerdict } from "../src/commit-work/process-identity";
import {
  ALL_WORKERS,
  AUDIT_READY_ORCHESTRATOR_GRACE_MS,
  AUTOCLOSE_HINT_TTL_MS,
  type AuditOrchestratorLiveness,
  AutocloseHintSet,
  appendDurableRestartBoot,
  appendFencedDispatchClear,
  appendRestartLedgerLine,
  appendServeHealthReportSample,
  auditReadyEscalationDecision,
  BIRTH_STUCK_STATUS,
  BLOCK_ESCALATION_SKIP_CATEGORY,
  BLOCK_ESCALATION_SWEEP_INTERVAL_MS,
  BLOCK_OWNER_GRACE_MS,
  BLOCK_OWNER_REDISPATCH_LIMIT,
  type BlockCandidateDropClass,
  type BlockEscalationOutcome,
  type BlockEscalationSweepDeps,
  type BlockHumanNotifiedOutcome,
  type BlockHumanNotifySweepDeps,
  type BlockNotifyVerdict,
  type BlockOwnerLiveness,
  BOOT_DRAIN_PACE_EVENTS,
  BOOT_DRAIN_PACE_MS,
  baselineRedIsConfirmed,
  baselineRepairFailingTestsDigest,
  baselineRepairFingerprint,
  blockOwnerEscalationDecision,
  buildBaselineRepairCandidates,
  buildBlockHumanNotifyBody,
  buildDispatchClearedData,
  buildIncidentGrant,
  buildIncidentOwnerPageBody,
  buildMaintenanceScaffoldYaml,
  buildPendingDispatchSweepRecords,
  buildRetryDispatchResultMessage,
  buildSharedCheckoutPageBody,
  buildSharedDirtyObservation,
  CRASH_LOOP_THRESHOLD,
  CRASH_LOOP_WINDOW_MS,
  CRASH_LOOP_YOUNG_RUNTIME_MS,
  checkKeeperAgentPresence,
  classifyBaselineForRepair,
  classifyEscalationOutcome,
  classifyExitVerdict,
  classifyRestartProvenance,
  collapseRestartLedger,
  compactRestartLedger,
  createExitAttributionRecorder,
  createMaintenanceMintGate,
  createNonReentrantRepairSweepTick,
  DEAD_LETTER_RETENTION_MS,
  DISPATCH_MINT_GATE_EVICT_MS,
  DISPATCH_MINT_GATE_WINDOW_MS,
  decideCrashLoop,
  decideDispatchClearLiveness,
  decideExitAttribution,
  decideGitSeedWatchdog,
  decidePagingChannelDistress,
  decideRepeatedNativeCrash,
  decideServeBusDistress,
  decideServeLagAttributionLog,
  decideServeLivenessWatchdog,
  dispatchClearFencesAtAppend,
  drainToCompletion,
  type EscalationDispatchOutcome,
  EXTERNAL_BLOCK_RECHECK_INTERVAL_MS,
  type ExitAttributionRecord,
  effectiveBlockEscalationRepo,
  expireIncidentGrants,
  externalBlockRecheckDecision,
  findOsMemoryKillEvidence,
  foldBootIntoRestartLedger,
  GIT_SEED_MAX_RESEED_ATTEMPTS,
  GIT_SEED_STUCK_THRESHOLD_MS,
  gcUnretryableDispatchFailures,
  HARD_KILL_EXIT_ATTRIBUTION_REASON,
  INCIDENT_CLAIM_SWEEP_INTERVAL_MS,
  INCIDENT_DECONFLICT_AGENT_TYPE,
  INCIDENT_GRANT_TTL_MS,
  INCIDENT_RESOLVE_AGENT_TYPE,
  type IncidentClaimSweepDeps,
  type IncidentGrantDeps,
  type IncidentOwnerPageSweepDeps,
  internalIncidentClearFences,
  isTransientBusyError,
  KEEPERD_LAUNCHD_LABEL,
  launchTimesMatch,
  MAINTENANCE_TASK_TITLE_PREFIX,
  type MaintenanceMintOutcome,
  MERGE_ESCALATION_REASON_TOKEN,
  MUTATION_PATH_BACKFILL_INTERVAL_MS,
  maintenanceEpicTitle,
  matchCrashReportToBoot,
  matchOperatorReloadAttribution,
  OS_MEMORY_KILL_EVIDENCE_MAX_LEN,
  PENDING_DISPATCH_SWEEP_INTERVAL_MS,
  PENDING_DISPATCH_TTL_MS,
  type PendingBlockEscalation,
  type PendingBlockHumanNotify,
  type PendingIncidentOwnerPage,
  type PendingRepairRow,
  PROBE_LIFE_ADMISSION_CODES,
  PROBE_SETTLE_INITIAL,
  type ProbeSettleEvent,
  type ProbeSettleState,
  type ProbeTickOutcome,
  parseBlockedCategory,
  parseCrashReportText,
  parseRestartLedger,
  parseRestartLedgerLine,
  planNativeCrashEnrichLines,
  planTerminalSessionClaimReleases,
  prewarmWatcherAddon,
  probeAuditOrchestrator,
  probeBlockOwner,
  probeDispatchClearClaimLiveness,
  probeReplyProvesLife,
  probeSettleStep,
  pruneRecoveredDeadLetters,
  publishFableFocusProjection,
  publishIncidentResolveGrant,
  publishNonFableFocusProjection,
  qualifyCrashLoopBootTimestamps,
  RESTART_LEDGER_CAP,
  RESTART_LEDGER_REASON_MAX_LEN,
  RETENTION_INTERVAL_MS,
  type RepairCandidate,
  type RepairCandidateDropClass,
  type RepairEscalationSweepDeps,
  type RepairHumanNotifiedOutcome,
  type RepairNotifyVerdict,
  type RestartBoot,
  type RestartBootLine,
  type RestartLedgerLine,
  type RestartProvenance,
  readExitAttribution,
  readOperatorReloadAttribution,
  readRestartLedger,
  readServeHealthHistory,
  readSpillDocument,
  readTaskBlockedReason,
  reclassifyPoisonDeadLetter,
  recoverOneDeadLetter,
  repairCheckoutDirty,
  repairReasonFor,
  repairTipBaselineGreen,
  resolveEscalationJobsFor,
  resolveExitAttributionPath,
  resolveOperatorReloadAttributionPath,
  resolvePoisonDeadLetter,
  resolveProbeArming,
  resolveServeHealthHistoryPath,
  rotateIncidentGrantToDeconflict,
  routeBlockedCategory,
  runBlockEscalationSweep,
  runBlockHumanNotifySweep,
  runIncidentClaimSweep,
  runIncidentOwnerPageSweep,
  runNativeCrashAttributionProbe,
  runRepairEscalationSweep,
  runSharedCheckoutPageSweep,
  runTrunkLeaseSweep,
  SERVE_CLOCK_JUMP_FACTOR,
  SERVE_HEALTH_HISTORY_MAX_REPORTS,
  SERVE_LAG_ATTRIBUTION_INITIAL_STATE,
  SERVE_LAG_ATTRIBUTION_LOG_STREAK,
  SERVE_LAG_MAX_CONSECUTIVE_BREACHES,
  SERVE_LAG_P99_THRESHOLD_MS,
  SERVE_PROBE_MAX_FAIL_STREAK,
  SERVE_REPORT_MUTE_THRESHOLD_MS,
  SERVE_STARVATION_MAX_BREACH_STREAK,
  SERVE_WATCHDOG_BOOT_GRACE_MS,
  SERVE_WATCHDOG_INITIAL_STATE,
  SERVE_WATCHDOG_INTERVAL_MS,
  type ServeHealthHistory,
  type ServeWatchdogTriggerState,
  SHARED_BASE_BROKEN_CATEGORY,
  type SharedCheckoutNotifiedOutcome,
  type SharedCheckoutPageRow,
  type SharedCheckoutPageSweepDeps,
  scanCrashReports,
  scanDeadLetterDir,
  selectExpiredPendingDispatches,
  selectPendingBlockEscalations,
  selectPendingBlockHumanNotifications,
  selectPendingIncidentOwnerPages,
  selectRepairCandidates,
  selectWorkerNames,
  serializeRestartLedgerLine,
  serializeSessionTelemetry,
  shouldEnrichPriorExitAttribution,
  shouldEscalateBlockedCategory,
  type TrunkLeaseSweepDeps,
  terminalSessionClaimIsReleaseable,
  WAL_AUTOCHECKPOINT_PAGES,
  withBootDrainCheckpointTuning,
  writeRestartLedger,
  writeServeHealthHistory,
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
  BUS_DEGRADED_DISTRESS_ID,
  BUS_DEGRADED_DISTRESS_REASON,
  BUS_DEGRADED_DISTRESS_VERB,
  CRASH_LOOP_DISTRESS_ID,
  CRASH_LOOP_DISTRESS_REASON,
  CRASH_LOOP_DISTRESS_VERB,
  EVENTS_INGEST_STALL_DISTRESS_ID,
  EVENTS_INGEST_STALL_DISTRESS_REASON,
  EVENTS_INGEST_STALL_DISTRESS_VERB,
  isMergeEscalationReason,
  LANE_WEDGE_DISTRESS_ID_PREFIX,
  MONITOR_SLOT_WEDGE_DISTRESS_ID_PREFIX,
  ORIGIN_CONTAINMENT_DISTRESS_ID_PREFIX,
  ORIGIN_CONTAINMENT_DISTRESS_REASON,
  ORIGIN_CONTAINMENT_DISTRESS_VERB,
  PAGING_CHANNEL_DOWN_DISTRESS_ID,
  PAGING_CHANNEL_DOWN_DISTRESS_REASON,
  PAGING_CHANNEL_DOWN_DISTRESS_VERB,
  REPEATED_NATIVE_CRASH_DISTRESS_ID,
  REPEATED_NATIVE_CRASH_DISTRESS_REASON,
  REPEATED_NATIVE_CRASH_DISTRESS_VERB,
  SHARED_DESYNC_DISTRESS_ID_PREFIX,
  SHARED_DESYNC_DISTRESS_VERB,
  SHARED_DIRTY_DISTRESS_ID_PREFIX,
  SHARED_WEDGE_DISTRESS_ID_PREFIX,
  SHARED_WEDGE_DISTRESS_VERB,
} from "../src/dispatch-failure-key";
import {
  materializeFableFocusPolicy,
  readFableFocusLeaf,
  serializeFableFocusPolicy,
} from "../src/fable-focus";
import {
  decideTrunkIntegrationFence,
  deriveGrantLeafPath,
  type GrantLeaf,
  grantCoversWrite,
  listGrantLeaves,
  readGrantLeaf,
  type SpooledTrunkLeaseRequest,
  TRUNK_LEASE_REQUEST_SCHEMA_VERSION,
  TRUNK_LEASE_SCHEMA_VERSION,
  type TrunkLeaseLeaf,
  writeGrantLeaf,
} from "../src/grant-leaf";
import {
  classifyAgentbotPageOutcome,
  resolveAgentbotBinaryPath,
  sendAgentbotPage,
} from "../src/integrity-probe";
import { MAIN_MAINTENANCE_TICK_BUDGET_MS } from "../src/maintenance-budget";
import { MAX_LINE_LENGTH } from "../src/protocol";
import type {
  ReconcileSnapshot,
  ReconcileState,
  ResolverOutcome,
} from "../src/reconcile-core";
import {
  INCIDENT_OWNER_ATTACHMENT_LIMIT,
  nextIncidentOwnerAttachmentMarker,
  reconcile,
  WORKER_EFFORT,
  WORKER_MODEL,
} from "../src/reconcile-core";
import {
  __resetEpicIndexMemoForTest,
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
  MAX_SUBS_PER_TICK,
  newFanoutCursor,
  runQuery,
  sliceFanout,
} from "../src/server-worker";
import type { Epic, Event, Job, Task } from "../src/types";
import { repoToken } from "../src/worktree-plan";
import { bindGitObservationWatermark } from "./helpers/git-event-payload";
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

test("agentbot page helper resolves absolute binary, latches absence, and classifies outcomes", async () => {
  expect(classifyAgentbotPageOutcome({ kind: "absent" })).toBe(
    "permanent_failure",
  );
  expect(classifyAgentbotPageOutcome({ kind: "spawn_threw" })).toBe(
    "permanent_failure",
  );
  expect(classifyAgentbotPageOutcome({ kind: "exited", exitCode: 17 })).toBe(
    "transient_failure",
  );
  expect(classifyAgentbotPageOutcome({ kind: "exit_threw" })).toBe(
    "transient_failure",
  );
  expect(classifyAgentbotPageOutcome({ kind: "exited", exitCode: 0 })).toBe(
    "notified",
  );

  const configured = join(tmpDir, "configured-agentbot");
  const fallback = join(tmpDir, "default-agentbot");
  const configPath = join(tmpDir, "config.yaml");
  writeFileSync(configPath, `agentbot_path: ${JSON.stringify(configured)}\n`);
  expect(
    resolveAgentbotBinaryPath({ configPath, defaultBinaryPath: fallback }),
  ).toBe(configured);

  const savedPath = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin";
  const argvSeen: string[][] = [];
  try {
    const delivered = await sendAgentbotPage("fixture", {
      configPath,
      defaultBinaryPath: fallback,
      canExecute: (path) => path === configured,
      spawn: (argv) => {
        argvSeen.push(argv);
        return { exited: Promise.resolve(0) };
      },
    });
    expect(delivered).toBe("notified");
    expect(argvSeen[0]).toEqual([
      configured,
      "send-message",
      "--topic",
      "Keeper",
      "fixture",
    ]);
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }

  const transient = await sendAgentbotPage("fixture", {
    binaryPath: configured,
    canExecute: (path) => path === configured,
    spawn: () => ({ exited: Promise.resolve(17) }),
  });
  expect(transient).toBe("transient_failure");

  const logs: string[] = [];
  const latch = { logged: false };
  const absentDeps = {
    binaryPath: join(tmpDir, "missing-agentbot"),
    canExecute: () => false,
    log: (line: string) => logs.push(line),
    absenceLogLatch: latch,
    spawn: () => {
      throw new Error("spawn should not run after failed executable probe");
    },
  };
  const firstAbsent = await sendAgentbotPage("fixture", absentDeps);
  const secondAbsent = await sendAgentbotPage("fixture", absentDeps);
  expect([firstAbsent, secondAbsent]).toEqual([
    "permanent_failure",
    "permanent_failure",
  ]);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("paging transport unavailable");
});

test("paging-channel distress is idempotent and level-clears only after delivery", () => {
  // This fixture is the producer's durable row state, independent of the
  // decision function: absent pager mints once; a transient exit changes nothing;
  // a subsequent successful page clears the existing row.
  let open = false;
  const actions: string[] = [];
  const apply = (
    outcome: "permanent_failure" | "transient_failure" | "notified",
  ) => {
    const action = decidePagingChannelDistress(outcome, open);
    actions.push(action);
    if (action === "mint") open = true;
    if (action === "clear") open = false;
  };
  apply("permanent_failure");
  apply("permanent_failure");
  apply("transient_failure");
  apply("notified");

  expect(actions).toEqual(["mint", "none", "none", "clear"]);
  expect(open).toBe(false);
  expect({
    verb: PAGING_CHANNEL_DOWN_DISTRESS_VERB,
    id: PAGING_CHANNEL_DOWN_DISTRESS_ID,
    reason: PAGING_CHANNEL_DOWN_DISTRESS_REASON,
  }).toEqual({
    verb: "daemon",
    id: "paging-channel-down",
    reason: "paging-channel-down",
  });
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
      bindGitObservationWatermark(
        db,
        "GitSnapshot",
        JSON.stringify({
          project_dir: projectDir,
          branch: "main",
          head_oid: "abc123",
          upstream: "origin/main",
          ahead: 0,
          behind: 0,
          dirty_files: dirtyFiles,
        }),
      ),
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
  db.query(
    `UPDATE dispatch_failures SET attempt_id = 41, instance_event_id = 51
      WHERE verb = 'close' AND id = 'worktree-recover:/Users/mike/code/arthack'`,
  ).run();

  const cleared: Array<{
    verb: string;
    id: string;
    expected_attempt_id: number | null;
    expected_instance_event_id: number | null;
  }> = [];
  const swept = gcUnretryableDispatchFailures(db, (verb, id, fences) =>
    cleared.push({ verb, id, ...fences }),
  );

  // Only the raw-path orphan is swept; its decision-point owners ride intact.
  expect(swept).toBe(1);
  expect(cleared).toEqual([
    {
      verb: "close",
      id: "worktree-recover:/Users/mike/code/arthack",
      expected_attempt_id: 41,
      expected_instance_event_id: 51,
    },
  ]);
  db.close();
});

test("gcUnretryableDispatchFailures: block incidents survive boot GC and the needs-human source equals the live block subset", () => {
  // Exercise the fresh DB's full migration ladder: its retained base literal is
  // needed until the collapse migration retires the old table.
  const { db } = openDb(":memory:");
  expect(
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'block_escalations'",
      )
      .get(),
  ).toBeNull();

  const expectedBlockTaskIds = ["fn-1400-block.1", "fn-1400-block.2"];
  const insert = db.prepare(
    `INSERT INTO dispatch_failures (
       verb, id, reason, dir, ts, last_event_id, created_at, updated_at,
       instance_event_id, blocked_since, block_status, owner_redispatch_attempts
     ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'pending', 0)`,
  );
  insert.run(
    "block",
    expectedBlockTaskIds[0],
    "block-incident",
    100,
    51,
    100,
    100,
    51,
    51,
  );
  insert.run(
    "block",
    expectedBlockTaskIds[1],
    "block-incident",
    101,
    52,
    101,
    101,
    52,
    52,
  );
  // A same-task work row and an unrelated daemon row must not inflate the
  // block-escalation count shown on needs-human surfaces.
  insert.run(
    "work",
    expectedBlockTaskIds[0],
    "other incident",
    102,
    53,
    102,
    102,
    53,
    53,
  );
  insert.run(
    "daemon",
    "other-incident",
    "other incident",
    103,
    54,
    103,
    103,
    54,
    54,
  );

  const liveBlockCount = (
    db
      .query(
        "SELECT COUNT(*) AS count FROM dispatch_failures WHERE verb = 'block'",
      )
      .get() as { count: number }
  ).count;
  expect(liveBlockCount).toBe(2);

  // `ReadinessClientSnapshot.blockEscalations`, whose length feeds the
  // needs-human block count, comes from this descriptor's filtered wire result.
  const blockEscalations = runQuery(db, 0, {
    type: "query",
    collection: "block_escalations",
    limit: 0,
  });
  if (blockEscalations.type !== "result") {
    throw new Error("block_escalations query must return a result");
  }
  expect(blockEscalations.total).toBe(liveBlockCount);
  expect(blockEscalations.rows).toHaveLength(liveBlockCount);
  expect(
    (blockEscalations.rows as Array<{ id: string }>)
      .map((row) => row.id)
      .sort(),
  ).toEqual([...expectedBlockTaskIds].sort());

  const cleared: Array<{
    verb: string;
    id: string;
    expected_attempt_id: number | null;
    expected_instance_event_id: number | null;
  }> = [];
  expect(
    gcUnretryableDispatchFailures(db, (verb, id, fences) =>
      cleared.push({ verb, id, ...fences }),
    ),
  ).toBe(1);
  expect(cleared.map(({ verb, id }) => `${verb}::${id}`)).toEqual([
    "daemon::other-incident",
  ]);
  expect(cleared.some(({ verb }) => verb === "block")).toBe(false);
  expect(
    db
      .query(
        "SELECT id FROM dispatch_failures WHERE verb = 'block' ORDER BY id",
      )
      .all(),
  ).toEqual(expectedBlockTaskIds.map((id) => ({ id })));
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

test("gcUnretryableDispatchFailures: repeated native crashes are producer-owned and EXEMPT", () => {
  const { db } = freshMemDb();
  db.prepare(
    `INSERT INTO dispatch_failures (verb, id, reason, dir, ts, last_event_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 100, 20, 100, 100)`,
  ).run(
    REPEATED_NATIVE_CRASH_DISTRESS_VERB,
    REPEATED_NATIVE_CRASH_DISTRESS_ID,
    `${REPEATED_NATIVE_CRASH_DISTRESS_REASON}: 2 native-attributed boots`,
  );

  const cleared: { verb: string; id: string }[] = [];
  expect(
    gcUnretryableDispatchFailures(db, (verb, id) => cleared.push({ verb, id })),
  ).toBe(0);
  expect(cleared).toEqual([]);
  db.close();
});

test("gcUnretryableDispatchFailures: the paging-channel distress row is EXEMPT until a delivered page level-clears it", () => {
  const { db } = freshMemDb();
  db.prepare(
    `INSERT INTO dispatch_failures (verb, id, reason, dir, ts, last_event_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 100, 20, 100, 100)`,
  ).run("daemon", "paging-channel-down", "paging-channel-down");

  const cleared: { verb: string; id: string }[] = [];
  expect(
    gcUnretryableDispatchFailures(db, (verb, id) => cleared.push({ verb, id })),
  ).toBe(0);
  expect(cleared).toEqual([]);
  db.close();
});

test("gcUnretryableDispatchFailures: bus-degraded is producer-owned until its probe level-clears it", () => {
  const { db } = freshMemDb();
  db.prepare(
    `INSERT INTO dispatch_failures (verb, id, reason, dir, ts, last_event_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 100, 20, 100, 100)`,
  ).run(
    BUS_DEGRADED_DISTRESS_VERB,
    BUS_DEGRADED_DISTRESS_ID,
    BUS_DEGRADED_DISTRESS_REASON,
  );

  const cleared: { verb: string; id: string }[] = [];
  expect(
    gcUnretryableDispatchFailures(db, (verb, id) => cleared.push({ verb, id })),
  ).toBe(0);
  expect(cleared).toEqual([]);
  db.close();
});

test("gcUnretryableDispatchFailures: events-ingest-stalled is producer-owned until backlog clears", () => {
  const { db } = freshMemDb();
  db.prepare(
    `INSERT INTO dispatch_failures (verb, id, reason, dir, ts, last_event_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 100, 20, 100, 100)`,
  ).run(
    EVENTS_INGEST_STALL_DISTRESS_VERB,
    EVENTS_INGEST_STALL_DISTRESS_ID,
    EVENTS_INGEST_STALL_DISTRESS_REASON,
  );

  const cleared: { verb: string; id: string }[] = [];
  expect(
    gcUnretryableDispatchFailures(db, (verb, id) => cleared.push({ verb, id })),
  ).toBe(0);
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
  const monitorSlotId = `${MONITOR_SLOT_WEDGE_DISTRESS_ID_PREFIX}job-1`;
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
  insert.run(
    SHARED_DESYNC_DISTRESS_VERB,
    monitorSlotId,
    "monitor-slot-wedge: …",
    "/repo",
    35,
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
  expect(cleared.some((c) => c.id === monitorSlotId)).toBe(false);
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

test("main maintenance budget cannot span a busy-lag breach streak", () => {
  const budgetedBreachWindows = Math.ceil(
    (MAIN_MAINTENANCE_TICK_BUDGET_MS + SERVE_LAG_P99_THRESHOLD_MS) /
      SERVE_WATCHDOG_INTERVAL_MS,
  );
  const maintenanceIntervalMs = Math.min(
    RETENTION_INTERVAL_MS,
    MUTATION_PATH_BACKFILL_INTERVAL_MS,
  );
  const cleanWindowsBeforeNextMaintenance =
    Math.floor(maintenanceIntervalMs / SERVE_WATCHDOG_INTERVAL_MS) -
    budgetedBreachWindows;

  expect(MAIN_MAINTENANCE_TICK_BUDGET_MS).toBeLessThan(
    SERVE_LAG_P99_THRESHOLD_MS,
  );
  expect(budgetedBreachWindows).toBeLessThan(
    SERVE_LAG_MAX_CONSECUTIVE_BREACHES,
  );
  expect(cleanWindowsBeforeNextMaintenance).toBeGreaterThanOrEqual(
    SERVE_LAG_MAX_CONSECUTIVE_BREACHES,
  );
});

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

test("decideServeLivenessWatchdog: accept-stall-bus — a bus-only fail streak at cap degrades in place", () => {
  const verdict = swd(
    { busProbe: "dead" },
    { busProbeFailStreak: SERVE_PROBE_MAX_FAIL_STREAK - 1 },
  ).verdict;
  expect(verdict).toEqual({ kind: "degrade", trigger: "accept-stall-bus" });
  expect(decideServeBusDistress(verdict, "dead", false)).toBe("mint");
  expect(decideServeBusDistress(verdict, "dead", true)).toBe("none");
});

test("decideServeLivenessWatchdog: a live bus probe after degradation returns ok and level-clears its distress", () => {
  const verdict = swd(
    { busProbe: "live" },
    { busProbeFailStreak: SERVE_PROBE_MAX_FAIL_STREAK },
  ).verdict;
  expect(verdict).toEqual({ kind: "ok" });
  expect(decideServeBusDistress(verdict, "live", true)).toBe("clear");
  expect(decideServeBusDistress(verdict, "live", false)).toBe("none");
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

test("decideServeLagAttributionLog: streak reaching 3 emits one bounded active-work line", () => {
  let state = { ...SERVE_LAG_ATTRIBUTION_INITIAL_STATE };
  const lines: string[] = [];
  for (const streak of [1, 2, SERVE_LAG_ATTRIBUTION_LOG_STREAK, 4, 5]) {
    const result = decideServeLagAttributionLog({
      state,
      lagBreachStreak: streak,
      lagP99Ms: 1234.4,
      activeWork: "maintenance:mutation_path_backfill",
    });
    state = result.state;
    if (result.line !== null) lines.push(result.line);
  }
  expect(lines).toEqual([
    "[keeperd] serve-liveness watchdog: busy-lag breach streak=3 active_work=maintenance:mutation_path_backfill lag_p99_ms=1234",
  ]);

  const reset = decideServeLagAttributionLog({
    state,
    lagBreachStreak: 0,
    lagP99Ms: 5,
    activeWork: null,
  });
  expect(reset.line).toBeNull();
  expect(reset.state.emittedForCurrentStreak).toBe(false);
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
    pid: null,
    start_time: null,
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

test("parseRestartLedgerLine: a native-crash enrich line needs no fatal reason and bounds report text", () => {
  expect(
    parseRestartLedgerLine(
      JSON.stringify({
        kind: "enrich",
        boot_id: "abc",
        ts: 1400,
        native_crash_signal: "SIGSEGV",
        native_crash_exception: "x".repeat(1_000),
        native_crash_report_id: "incident-1",
        died_at_ms: 1350,
      }),
    ),
  ).toEqual({
    kind: "enrich",
    boot_id: "abc",
    ts: 1400,
    native_crash_signal: "SIGSEGV",
    native_crash_exception: "x".repeat(RESTART_LEDGER_REASON_MAX_LEN),
    native_crash_report_id: "incident-1",
    died_at_ms: 1350,
  });
});

test("parseRestartLedgerLine: parses a typed verdict + bounds its evidence, ignores an invalid verdict kind", () => {
  expect(
    parseRestartLedgerLine(
      JSON.stringify({
        kind: "enrich",
        boot_id: "abc",
        ts: 1400,
        reason: "jetsam killing process 999",
        verdict: "os-memory-kill",
        verdict_evidence: "x".repeat(1_000),
      }),
    ),
  ).toEqual({
    kind: "enrich",
    boot_id: "abc",
    ts: 1400,
    reason: "jetsam killing process 999",
    verdict: "os-memory-kill",
    verdict_evidence: "x".repeat(RESTART_LEDGER_REASON_MAX_LEN),
  });
  // An unrecognized verdict kind is dropped (defensive parse), but the line
  // stays valid on its `reason` alone.
  expect(
    parseRestartLedgerLine(
      JSON.stringify({
        kind: "enrich",
        boot_id: "abc",
        ts: 1400,
        reason: "boom",
        verdict: "not-a-real-verdict",
      }),
    ),
  ).toEqual({ kind: "enrich", boot_id: "abc", ts: 1400, reason: "boom" });
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
      pid: null,
      start_time: null,
      ts: 1000,
      provenance: "launchd",
      prev_runtime_ms: null,
      reason: "boom",
      died_at_ms: 1500,
    },
  ]);
});

test("collapse + compact restart ledger preserve fatal and native-crash enrich fields without clobbering", () => {
  const lines: RestartLedgerLine[] = [
    bootLine("mixed", 1000, "launchd", null),
    { kind: "enrich", boot_id: "mixed", ts: 1200, reason: "watchdog" },
    {
      kind: "enrich",
      boot_id: "mixed",
      ts: 1400,
      died_at_ms: 1100,
      native_crash_signal: "SIGBUS",
      native_crash_exception: "EXC_BAD_ACCESS",
      native_crash_report_id: "incident-mixed",
    },
  ];
  const collapsed = collapseRestartLedger(lines);
  expect(collapsed[0]).toMatchObject({
    reason: "watchdog",
    died_at_ms: 1100,
    native_crash_signal: "SIGBUS",
    native_crash_exception: "EXC_BAD_ACCESS",
    native_crash_report_id: "incident-mixed",
  });
  expect(
    collapseRestartLedger(
      compactRestartLedger(lines, { nowMs: 2000, windowMs: 2000, cap: 10 }),
    )[0],
  ).toMatchObject(collapsed[0]);
  expect(
    collapseRestartLedger([lines[0], lines[2], lines[1]])[0],
  ).toMatchObject({
    reason: "watchdog",
    died_at_ms: 1100,
    native_crash_report_id: "incident-mixed",
  });
});

test("collapse + compact restart ledger carry a typed verdict forward, later write wins", () => {
  const lines: RestartLedgerLine[] = [
    bootLine("mixed", 1000, "launchd", null),
    {
      kind: "enrich",
      boot_id: "mixed",
      ts: 1200,
      reason: HARD_KILL_EXIT_ATTRIBUTION_REASON,
      verdict: "no-evidence",
      verdict_evidence: HARD_KILL_EXIT_ATTRIBUTION_REASON,
    },
    {
      kind: "enrich",
      boot_id: "mixed",
      ts: 1400,
      reason: "jetsam killing process 999",
      verdict: "os-memory-kill",
      verdict_evidence: "jetsam killing process 999",
    },
  ];
  const collapsed = collapseRestartLedger(lines);
  expect(collapsed[0]).toMatchObject({
    reason: "jetsam killing process 999",
    verdict: "os-memory-kill",
    verdict_evidence: "jetsam killing process 999",
  });
  expect(
    collapseRestartLedger(
      compactRestartLedger(lines, { nowMs: 2000, windowMs: 2000, cap: 10 }),
    )[0],
  ).toMatchObject({
    verdict: "os-memory-kill",
    verdict_evidence: "jetsam killing process 999",
  });
});

test("collapseRestartLedger: an orphan enrichment synthesizes a forensic record, never dropped", () => {
  expect(
    collapseRestartLedger([
      { kind: "enrich", boot_id: "orphan", ts: 5000, reason: "late" },
    ]),
  ).toEqual([
    {
      boot_id: "orphan",
      pid: null,
      start_time: null,
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

// ── native-crash attribution ────────────────────────────────────────────────

function crashReportBody(inputs: {
  pid: number;
  launchTime: string;
  crashTime: string;
  processPath?: string;
  incident?: string;
}): string {
  return `${JSON.stringify({
    bug_type: "309",
    timestamp: inputs.crashTime,
    incident_id: inputs.incident ?? "incident-1",
  })}\n${JSON.stringify({
    pid: inputs.pid,
    procLaunch: inputs.launchTime,
    captureTime: inputs.crashTime,
    ...(inputs.processPath === undefined
      ? {}
      : { procPath: inputs.processPath }),
    exception: { type: "EXC_BAD_ACCESS", signal: "SIGSEGV" },
    faultingThread: 0,
    threads: [{ frames: [{ imageIndex: 0 }] }],
    usedImages: [{ path: "/opt/keeper/bin/bun" }],
  })}`;
}

test("native-crash launch comparator accepts small skew and rejects recycled-pid launch time", () => {
  const start = "darwin:Wed Jun 18 11:03:02 2025";
  const epoch = Date.parse("Wed Jun 18 11:03:02 2025");
  expect(launchTimesMatch(start, new Date(epoch).toISOString())).toBe(true);
  expect(launchTimesMatch(start, new Date(epoch + 4_000).toISOString())).toBe(
    true,
  );
  expect(launchTimesMatch(start, new Date(epoch + 6_000).toISOString())).toBe(
    false,
  );
});

test("parseCrashReportText tolerates duplicate candidate keys in the two JSON objects", () => {
  const launch = Date.parse("Wed Jun 18 11:03:02 2025");
  const report = parseCrashReportText(
    `{"bug_type":"0","bug_type":"309","incident_id":"duplicate"}\n` +
      `{"pid":7,"pid":8,"procLaunch":"${new Date(launch).toISOString()}","captureTime":"${new Date(launch + 1_000).toISOString()}"}`,
  );
  expect(report).toMatchObject({
    bugType: "309",
    pid: 8,
    reportId: "duplicate",
  });
});

test("parse + match crash report requires pid, launch identity, lifetime, and only optionally a process path", () => {
  const launch = Date.parse("Wed Jun 18 11:03:02 2025");
  const report = parseCrashReportText(
    crashReportBody({
      pid: 4242,
      launchTime: new Date(launch + 1_000).toISOString(),
      crashTime: new Date(launch + 20_000).toISOString(),
    }),
  );
  expect(report).not.toBeNull();
  if (report === null) throw new Error("synthetic report did not parse");
  const boot = {
    boot_id: "dead",
    pid: 4242,
    start_time: "darwin:Wed Jun 18 11:03:02 2025",
    started_at_ms: launch + 2_000,
    died_at_ms: launch + 30_000,
  };
  expect(matchCrashReportToBoot(report, boot)).toBe(true);
  expect(matchCrashReportToBoot(report, { ...boot, pid: 4243 })).toBe(false);
  expect(
    matchCrashReportToBoot(
      { ...report, launchTimeMs: report.launchTimeMs + 10_000 },
      boot,
    ),
  ).toBe(false);
  expect(
    matchCrashReportToBoot(
      { ...report, processPath: "/usr/bin/unrelated" },
      boot,
    ),
  ).toBe(false);
});

test("scanCrashReports backfills any matching boot and stays within file/byte caps", () => {
  const dir = join(tmpDir, "DiagnosticReports");
  mkdirSync(dir);
  const launchA = Date.parse("Wed Jun 18 11:03:02 2025");
  const launchB = launchA + 60_000;
  writeFileSync(
    join(dir, "keeperd-2025-06-18-110322.ips"),
    crashReportBody({
      pid: 100,
      launchTime: new Date(launchA).toISOString(),
      crashTime: new Date(launchA + 20_000).toISOString(),
      processPath: "/opt/keeper/keeperd",
      incident: "incident-a",
    }),
  );
  writeFileSync(
    join(dir, "keeperd-2025-06-18-110422.ips"),
    crashReportBody({
      pid: 200,
      launchTime: new Date(launchB + 20_000).toISOString(),
      crashTime: new Date(launchB + 30_000).toISOString(),
      incident: "recycled-pid",
    }),
  );
  const scan = scanCrashReports({
    directory: dir,
    boots: [
      {
        boot_id: "older-dead-boot",
        pid: 100,
        start_time: "darwin:Wed Jun 18 11:03:02 2025",
        started_at_ms: launchA,
        died_at_ms: launchA + 30_000,
      },
      {
        boot_id: "newer-dead-boot",
        pid: 200,
        start_time: "darwin:Wed Jun 18 11:04:02 2025",
        started_at_ms: launchB,
        died_at_ms: launchB + 40_000,
      },
    ],
    maxFiles: 2,
    maxTotalBytes: 100_000,
  });
  expect(scan.matches).toEqual([
    {
      boot_id: "older-dead-boot",
      died_at_ms: launchA + 20_000,
      native_crash_signal: "SIGSEGV",
      native_crash_exception: "EXC_BAD_ACCESS",
      native_crash_faulting_image: "/opt/keeper/bin/bun",
      native_crash_report_id: "incident-a",
    },
  ]);
  expect(scan.filesInspected).toBeLessThanOrEqual(2);
  expect(scan.bytesRead).toBeLessThanOrEqual(100_000);
});

test("planNativeCrashEnrichLines is idempotent, backfills the window, and records no-report once", () => {
  const boots = collapseRestartLedger([
    {
      ...bootLine("old", 1, "launchd", null),
      pid: 1,
      start_time: "darwin:Wed Jun 18 11:03:02 2025",
    },
    {
      ...bootLine("recent", 2, "launchd", 1),
      pid: 2,
      start_time: "darwin:Wed Jun 18 11:04:02 2025",
    },
    {
      ...bootLine("current", 3, "launchd", 1),
      pid: 3,
      start_time: "darwin:Wed Jun 18 11:05:02 2025",
    },
  ]);
  const attribution = planNativeCrashEnrichLines({
    boots,
    matches: [
      {
        boot_id: "old",
        native_crash_signal: "SIGSEGV",
        native_crash_report_id: "report-old",
        died_at_ms: 1.5,
      },
    ],
    exhausted: false,
    nowMs: 10,
  });
  expect(attribution.map((line) => line.boot_id)).toEqual(["old"]);

  const enriched = collapseRestartLedger([
    ...boots.map((boot) => ({
      kind: "boot" as const,
      boot_id: boot.boot_id,
      pid: boot.pid,
      start_time: boot.start_time,
      ts: boot.ts,
      provenance: boot.provenance,
      prev_runtime_ms: boot.prev_runtime_ms,
    })),
    ...attribution,
  ]);
  expect(
    planNativeCrashEnrichLines({
      boots: enriched,
      matches: [{ boot_id: "old", native_crash_report_id: "report-old" }],
      exhausted: true,
      nowMs: 11,
    }),
  ).toEqual([
    {
      kind: "enrich",
      boot_id: "recent",
      ts: 11,
      native_crash_no_report: true,
    },
  ]);
  const marked = enriched.map((boot) =>
    boot.boot_id === "recent"
      ? { ...boot, native_crash_no_report: true as const }
      : boot,
  );
  expect(
    planNativeCrashEnrichLines({
      boots: marked,
      matches: [],
      exhausted: true,
      nowMs: 12,
    }),
  ).toEqual([]);
});

test("runNativeCrashAttributionProbe backfills long-runtime predecessors and logs scanned/matched/marked", () => {
  const ledgerPath = join(tmpDir, "restart-ledger.ndjson");
  const reportsDir = join(tmpDir, "DiagnosticReports");
  mkdirSync(reportsDir);

  const nowMs = Date.parse("Wed Jun 18 12:00:00 2025");
  const oldStart = nowMs - 90 * 60_000;
  const recentStart = nowMs - 35 * 60_000;
  const darwin = (ms: number) => `darwin:${new Date(ms).toISOString()}`;

  writeRestartLedger(ledgerPath, [
    {
      ...bootLine("old", oldStart, "launchd", null),
      pid: 101,
      start_time: darwin(oldStart),
    },
    {
      ...bootLine("recent", recentStart, "launchd", 55 * 60_000),
      pid: 202,
      start_time: darwin(recentStart),
    },
    {
      ...bootLine("current", nowMs, "launchd", 35 * 60_000),
      pid: 303,
      start_time: darwin(nowMs),
    },
  ]);

  writeFileSync(
    join(reportsDir, "keeperd-2025-06-18-112520.ips"),
    crashReportBody({
      pid: 202,
      launchTime: new Date(recentStart).toISOString(),
      crashTime: new Date(recentStart + 20_000).toISOString(),
      processPath: "/opt/keeper/keeperd",
      incident: "recent-incident",
    }),
  );

  const logs: string[] = [];
  const summary = runNativeCrashAttributionProbe({
    ledgerPath,
    reportsDir,
    exhausted: true,
    nowMs,
    log: (line) => logs.push(line),
  });

  expect(summary).toMatchObject({ scanned: 2, matched: 1, marked: 1 });
  expect(summary.timedOut).toBe(false);
  expect(logs).toEqual([
    "[keeperd] native-crash attribution probe: scanned=2 matched=1 marked=1",
  ]);

  expect(collapseRestartLedger(readRestartLedger(ledgerPath))).toEqual([
    expect.objectContaining({
      boot_id: "old",
      native_crash_no_report: true,
    }),
    expect.objectContaining({
      boot_id: "recent",
      native_crash_report_id: "recent-incident",
      native_crash_signal: "SIGSEGV",
      native_crash_exception: "EXC_BAD_ACCESS",
      native_crash_faulting_image: "/opt/keeper/bin/bun",
    }),
    expect.objectContaining({
      boot_id: "current",
    }),
  ]);
});

test("decideRepeatedNativeCrash mints at two, drains below two, and coexists with crash-loop", () => {
  const attributed = (
    id: string,
    ts: number,
    prevRuntimeMs = 3_600_000,
  ): RestartBoot => ({
    ...collapseRestartLedger([bootLine(id, ts, "launchd", prevRuntimeMs)])[0],
    native_crash_report_id: `report-${id}`,
  });
  expect(decideRepeatedNativeCrash([attributed("a", 1)])).toEqual({
    repeatedNativeCrash: false,
    attributedBoots: 1,
  });
  const spaced = [attributed("a", 1), attributed("b", 3_600_001)];
  expect(decideRepeatedNativeCrash(spaced)).toEqual({
    repeatedNativeCrash: true,
    attributedBoots: 2,
  });
  expect(
    decideCrashLoop({
      nowMs: 3_600_001,
      bootTimestamps: qualifyCrashLoopBootTimestamps(
        spaced,
        CRASH_LOOP_YOUNG_RUNTIME_MS,
      ),
      threshold: CRASH_LOOP_THRESHOLD,
      windowMs: CRASH_LOOP_WINDOW_MS,
    }).crashLoop,
  ).toBe(false);

  const rapid = Array.from({ length: CRASH_LOOP_THRESHOLD }, (_, index) =>
    attributed(`rapid-${index}`, CL_NOW - index * 1_000, 1_000),
  );
  expect(decideRepeatedNativeCrash(rapid).repeatedNativeCrash).toBe(true);
  expect(
    decideCrashLoop({
      nowMs: CL_NOW,
      bootTimestamps: qualifyCrashLoopBootTimestamps(
        rapid,
        CRASH_LOOP_YOUNG_RUNTIME_MS,
      ),
      threshold: CRASH_LOOP_THRESHOLD,
      windowMs: CRASH_LOOP_WINDOW_MS,
    }).crashLoop,
  ).toBe(true);
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

test("exit-attribution records each soft exit path once with a bounded synced leaf", () => {
  const stateDir = join(tmpDir, "state");
  const restartLedgerPath = join(stateDir, "restart-ledger.json");
  const cases: Array<{
    name: string;
    attribution: Omit<ExitAttributionRecord, "boot_id" | "ts">;
    expected: Omit<ExitAttributionRecord, "boot_id" | "ts">;
  }> = [
    {
      name: "fatal",
      attribution: { kind: "fatal_exit", reason: "x".repeat(1_000) },
      expected: {
        kind: "fatal_exit",
        reason: "x".repeat(RESTART_LEDGER_REASON_MAX_LEN),
      },
    },
    {
      name: "uncaught",
      attribution: { kind: "uncaught_exception", reason: "uncaught" },
      expected: { kind: "uncaught_exception", reason: "uncaught" },
    },
    {
      name: "rejection",
      attribution: { kind: "unhandled_rejection", reason: "rejected" },
      expected: { kind: "unhandled_rejection", reason: "rejected" },
    },
    {
      name: "term",
      attribution: { kind: "signal", signal: "SIGTERM" },
      expected: { kind: "signal", signal: "SIGTERM" },
    },
    {
      name: "int",
      attribution: { kind: "signal", signal: "SIGINT" },
      expected: { kind: "signal", signal: "SIGINT" },
    },
    {
      name: "hup",
      attribution: { kind: "signal", signal: "SIGHUP" },
      expected: { kind: "signal", signal: "SIGHUP" },
    },
    {
      name: "clean",
      attribution: { kind: "clean_shutdown" },
      expected: { kind: "clean_shutdown" },
    },
  ];

  expect(resolveExitAttributionPath(restartLedgerPath)).toBe(
    join(stateDir, "exit-attribution.json"),
  );
  for (const { name, attribution, expected } of cases) {
    const path = join(stateDir, `${name}.json`);
    const recorder = createExitAttributionRecorder({
      bootId: `boot-${name}`,
      path,
      nowMs: () => 123,
    });
    recorder.record(attribution);
    recorder.record({ kind: "clean_shutdown" });
    expect(readExitAttribution(path)).toEqual({
      boot_id: `boot-${name}`,
      ts: 123,
      ...expected,
    });
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
  }
});

test("decideExitAttribution prefers operator, then the leaf, then native evidence, then OS memory kill, then hard kill", () => {
  const leaf: ExitAttributionRecord = {
    boot_id: "prior",
    ts: 10,
    kind: "signal",
    signal: "SIGTERM",
  };
  const nativeCrash = {
    native_crash_signal: "SIGSEGV",
    native_crash_report_id: "report-prior",
  };
  const operatorReload = {
    source: "install.sh",
    action: "launchctl-reload",
    ts: 15,
  };
  const osMemoryKill = { reason: "jetsam killing process 123" };

  expect(
    decideExitAttribution({
      bootId: "prior",
      ts: 20,
      exitAttribution: leaf,
      nativeCrash,
      operatorReload,
    }),
  ).toEqual({
    kind: "enrich",
    boot_id: "prior",
    ts: 20,
    reason: "install.sh launchctl-reload",
    verdict: "operator",
    verdict_evidence: "install.sh launchctl-reload",
  });
  expect(
    decideExitAttribution({
      bootId: "prior",
      ts: 20,
      exitAttribution: leaf,
      nativeCrash,
    }),
  ).toEqual({
    kind: "enrich",
    boot_id: "prior",
    ts: 20,
    reason: "signal: SIGTERM",
    verdict: "signal",
    verdict_evidence: "signal: SIGTERM",
  });
  expect(
    decideExitAttribution({
      bootId: "prior",
      ts: 20,
      exitAttribution: null,
      nativeCrash,
    }),
  ).toEqual({
    kind: "enrich",
    boot_id: "prior",
    ts: 20,
    ...nativeCrash,
    verdict: "signal",
    verdict_evidence: "native crash: SIGSEGV",
  });
  expect(
    decideExitAttribution({
      bootId: "prior",
      ts: 20,
      exitAttribution: null,
      nativeCrash: null,
      osMemoryKill,
    }),
  ).toEqual({
    kind: "enrich",
    boot_id: "prior",
    ts: 20,
    reason: "jetsam killing process 123",
    verdict: "os-memory-kill",
    verdict_evidence: "jetsam killing process 123",
  });
  expect(
    decideExitAttribution({
      bootId: "prior",
      ts: 20,
      exitAttribution: null,
      nativeCrash: null,
    }),
  ).toEqual({
    kind: "enrich",
    boot_id: "prior",
    ts: 20,
    reason: HARD_KILL_EXIT_ATTRIBUTION_REASON,
    verdict: "no-evidence",
    verdict_evidence: HARD_KILL_EXIT_ATTRIBUTION_REASON,
  });
});

test("classifyExitVerdict: watchdog vs. generic soft-exit-leaf reasons", () => {
  expect(
    classifyExitVerdict({
      exitAttribution: {
        boot_id: "b",
        ts: 1,
        kind: "fatal_exit",
        reason: "serve-liveness-watchdog: busy-lag lag-breaches=3/3",
      },
      nativeCrash: null,
      operatorReload: null,
      osMemoryKill: null,
    }),
  ).toEqual({
    kind: "watchdog",
    evidence: "serve-liveness-watchdog: busy-lag lag-breaches=3/3",
  });
  expect(
    classifyExitVerdict({
      exitAttribution: {
        boot_id: "b",
        ts: 1,
        kind: "fatal_exit",
        reason: "git-seed-watchdog: surface stuck after 3 re-seed attempt(s)",
      },
      nativeCrash: null,
      operatorReload: null,
      osMemoryKill: null,
    }),
  ).toEqual({
    kind: "watchdog",
    evidence: "git-seed-watchdog: surface stuck after 3 re-seed attempt(s)",
  });
  expect(
    classifyExitVerdict({
      exitAttribution: {
        boot_id: "b",
        ts: 1,
        kind: "fatal_exit",
        reason: "single-instance admission refused",
      },
      nativeCrash: null,
      operatorReload: null,
      osMemoryKill: null,
    }),
  ).toEqual({
    kind: "soft-exit-leaf",
    evidence: "single-instance admission refused",
  });
  expect(
    classifyExitVerdict({
      exitAttribution: { boot_id: "b", ts: 1, kind: "clean_shutdown" },
      nativeCrash: null,
      operatorReload: null,
      osMemoryKill: null,
    }),
  ).toEqual({
    kind: "soft-exit-leaf",
    evidence: "exit attribution: clean_shutdown",
  });
  expect(
    classifyExitVerdict({
      exitAttribution: null,
      nativeCrash: null,
      operatorReload: null,
      osMemoryKill: null,
    }),
  ).toEqual({
    kind: "no-evidence",
    evidence: HARD_KILL_EXIT_ATTRIBUTION_REASON,
  });
});

test("findOsMemoryKillEvidence: matches a real jetsam-kill line naming the pid, ignores background noise and other pids", () => {
  const window = { pid: 56332, startedAtMs: 0, diedAtMs: 1_000 };
  // Ambient runningboardd chatter that mentions jetsam constantly but never kills.
  const noise = [
    "2026-07-20 16:15:28 runningboardd: [jetsam] memorystatus_control error: MEMORYSTATUS_CMD_CONVERT_MEMLIMIT_MB(-1) returned -1 22 (Invalid argument)",
    "2026-07-20 16:15:28 runningboardd: [anon<bun>(501):56332] is not RunningBoard jetsam managed.",
    "2026-07-20 16:15:28 runningboardd: [anon<bun>(501):56332] Ignoring jetsam update because this process is not memory-managed",
  ].join("\n");
  expect(findOsMemoryKillEvidence(noise, window)).toBeNull();
  expect(findOsMemoryKillEvidence("", window)).toBeNull();

  // A real kill line naming a DIFFERENT pid must not match this boot's window.
  const otherPid =
    "2026-07-20 16:15:30 kernel: memorystatus_kill_process: killing pid 99999 [bun] (jetsam) - highwater";
  expect(findOsMemoryKillEvidence(otherPid, window)).toBeNull();

  const realKill =
    "2026-07-20 16:15:30 kernel: memorystatus_kill_process: killing pid 56332 [bun] (jetsam) - highwater, reason: highwater";
  expect(findOsMemoryKillEvidence(`${noise}\n${realKill}`, window)).toEqual({
    reason: realKill,
  });

  const lowSwap =
    "2026-07-20 16:15:30 kernel: low swap: killing largest process with pid 56332 (bun) to reclaim memory";
  expect(findOsMemoryKillEvidence(lowSwap, window)).toEqual({
    reason: lowSwap,
  });

  const bounded = `2026-07-20 kernel: jetsam killing pid 56332 ${"x".repeat(500)}`;
  const result = findOsMemoryKillEvidence(bounded, window);
  expect(result?.reason.length).toBeLessThanOrEqual(
    OS_MEMORY_KILL_EVIDENCE_MAX_LEN,
  );
});

test("resolveOperatorReloadAttributionPath: sibling of the restart ledger, never the exit-attribution leaf", () => {
  const restartLedgerPath = join(tmpDir, "restart-ledger.json");
  expect(resolveOperatorReloadAttributionPath(restartLedgerPath)).toBe(
    join(tmpDir, "install-reload-attribution.json"),
  );
});

test("readOperatorReloadAttribution: reads install.sh's leaf, fails closed on missing/malformed", () => {
  const path = join(tmpDir, "install-reload-attribution.json");
  expect(readOperatorReloadAttribution(path)).toBeNull();
  writeFileSync(
    path,
    `${JSON.stringify({
      schema_version: 1,
      source: "install.sh",
      action: "launchctl-reload",
      ts_ms: 12_345,
      fingerprint: "abc",
    })}\n`,
  );
  expect(readOperatorReloadAttribution(path)).toEqual({
    source: "install.sh",
    action: "launchctl-reload",
    ts: 12_345,
  });
  writeFileSync(path, "not json");
  expect(readOperatorReloadAttribution(path)).toBeNull();
  writeFileSync(path, JSON.stringify({ source: "install.sh" }));
  expect(readOperatorReloadAttribution(path)).toBeNull();
});

test("matchOperatorReloadAttribution: only explains a death whose stamp falls inside the dying boot's own lifetime", () => {
  const attribution = {
    source: "install.sh",
    action: "launchctl-reload",
    ts: 1_000,
  };
  expect(
    matchOperatorReloadAttribution(attribution, {
      startedAtMs: 500,
      diedAtMs: 1_500,
    }),
  ).toEqual(attribution);
  expect(
    matchOperatorReloadAttribution(attribution, {
      startedAtMs: 1_100,
      diedAtMs: 1_500,
    }),
  ).toBeNull();
  expect(
    matchOperatorReloadAttribution(null, { startedAtMs: 0, diedAtMs: 1 }),
  ).toBeNull();
});

test("serve-health history: bounded ring buffer, durable round trip, and resolved sibling path", () => {
  const restartLedgerPath = join(tmpDir, "restart-ledger.json");
  expect(resolveServeHealthHistoryPath(restartLedgerPath)).toBe(
    join(tmpDir, "serve-health-history.json"),
  );
  let history: ServeHealthHistory = { boot_id: "boot-1", reports: [] };
  for (let i = 0; i < SERVE_HEALTH_HISTORY_MAX_REPORTS + 5; i += 1) {
    history = appendServeHealthReportSample(history, {
      ts: i,
      rss_bytes: 1_000_000 + i,
    });
  }
  expect(history.reports.length).toBe(SERVE_HEALTH_HISTORY_MAX_REPORTS);
  // Oldest samples drop first; the ring buffer keeps the most recent tail.
  expect(history.reports[0].ts).toBe(5);
  expect(history.reports.at(-1)?.ts).toBe(SERVE_HEALTH_HISTORY_MAX_REPORTS + 4);

  const path = join(tmpDir, "serve-health-history.json");
  expect(readServeHealthHistory(path)).toBeNull();
  writeServeHealthHistory(path, history);
  expect(readServeHealthHistory(path)).toEqual(history);
});

test("prior exit attribution skips boots already attributed in the restart ledger", () => {
  const prior = {
    ...bootLine("prior", 1, "launchd", null),
    pid: 1,
    start_time: "darwin:2025-01-01T00:00:00.000Z",
  };
  const leaf: ExitAttributionRecord = {
    boot_id: "prior",
    ts: 2,
    kind: "signal",
    signal: "SIGTERM",
  };

  expect(
    shouldEnrichPriorExitAttribution({
      priorBoot: { ...prior, reason: "clean shutdown" },
      exitAttribution: leaf,
      allowHardKillFallback: true,
    }),
  ).toBe(false);
  expect(
    shouldEnrichPriorExitAttribution({
      priorBoot: { ...prior, native_crash_signal: "SIGSEGV" },
      exitAttribution: leaf,
      allowHardKillFallback: true,
    }),
  ).toBe(false);
  expect(
    shouldEnrichPriorExitAttribution({
      priorBoot: prior,
      exitAttribution: null,
      allowHardKillFallback: false,
    }),
  ).toBe(false);
  expect(
    shouldEnrichPriorExitAttribution({
      priorBoot: prior,
      exitAttribution: leaf,
      allowHardKillFallback: false,
    }),
  ).toBe(true);
  expect(
    shouldEnrichPriorExitAttribution({
      priorBoot: prior,
      exitAttribution: null,
      allowHardKillFallback: true,
    }),
  ).toBe(true);
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

test("appendDurableRestartBoot retains old forensic history beyond the read-side cap", () => {
  const path = join(tmpDir, "restart-ledger.ndjson");
  const oldLines = Array.from({ length: RESTART_LEDGER_CAP + 7 }, (_, index) =>
    serializeRestartLedgerLine(
      bootLine(`old-${index}`, index + 1, "launchd", index === 0 ? null : 1),
    ),
  ).join("");
  writeFileSync(path, oldLines);

  const appended = appendDurableRestartBoot({
    path,
    bootId: "current",
    pid: 4321,
    startTime: "darwin:Thu Jan  1 00:00:00 1970",
    provenance: "launchd",
    nowMs: 99_999,
  });

  const raw = readFileSync(path, "utf8");
  expect(raw.startsWith(oldLines)).toBe(true);
  expect(
    parseRestartLedger(raw).filter((line) => line.kind === "boot"),
  ).toHaveLength(RESTART_LEDGER_CAP + 8);
  expect(appended).toMatchObject({
    boot_id: "current",
    pid: 4321,
    start_time: "darwin:Thu Jan  1 00:00:00 1970",
  });
});

test("appendDurableRestartBoot preserves a torn tail and appends a separately parseable boot", () => {
  const path = join(tmpDir, "restart-ledger.ndjson");
  const valid = serializeRestartLedgerLine(bootLine("old", 1, "launchd", null));
  const torn = '{"kind":"boot","boot_id":"torn"';
  writeFileSync(path, valid + torn);

  appendDurableRestartBoot({
    path,
    bootId: "current",
    pid: 55,
    startTime: "linux:1234",
    provenance: "unknown",
    nowMs: 2,
  });

  const raw = readFileSync(path, "utf8");
  expect(raw.startsWith(`${valid + torn}\n`)).toBe(true);
  expect(parseRestartLedger(raw).map((line) => line.boot_id)).toEqual([
    "old",
    "current",
  ]);
});

test("appendDurableRestartBoot explicitly converts legacy history without losing a valid record", () => {
  const path = join(tmpDir, "restart-ledger.json");
  writeFileSync(path, JSON.stringify([1, { ts: 2, reason: "boom" }, 3]));

  appendDurableRestartBoot({
    path,
    bootId: "current",
    pid: 77,
    startTime: "linux:5678",
    provenance: "launchd",
    nowMs: 4,
  });

  const raw = readFileSync(path, "utf8");
  expect(raw.trimStart().startsWith("[")).toBe(false);
  const lines = parseRestartLedger(raw);
  expect(lines.map((line) => `${line.kind}:${line.boot_id}`)).toEqual([
    "boot:legacy:0:1",
    "boot:legacy:1:2",
    "enrich:legacy:1:2",
    "boot:legacy:2:3",
    "boot:current",
  ]);
});

test("appendDurableRestartBoot fails instead of replacing unreadable history with an empty ledger", () => {
  const path = join(tmpDir, "restart-ledger.json");
  mkdirSync(path);

  expect(() =>
    appendDurableRestartBoot({
      path,
      bootId: "current",
      pid: 88,
      startTime: "linux:9999",
      provenance: "launchd",
      nowMs: 5,
    }),
  ).toThrow("cannot read existing history");
  expect(statSync(path).isDirectory()).toBe(true);
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
// Seed sweep — Q7 boot-time liveness pass. The producer probes are injected so
// the lifecycle matrix is independent of host processes and `ps`.
// ---------------------------------------------------------------------------

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

const SEED_SWEEP_DEPS = {
  isPidAlive: (pid: number) => pid === 101,
  readOsStartTime: (pid: number) => (pid === 101 ? "test:start-101" : null),
  classifyCloseKind: () => null,
};

test("seed sweep folds dead/recycled rows to killed; leaves matching and legacy rows alone", () => {
  const { db } = openDb(dbPath);
  seedJobsRow(db, "sess-a-alive-matching", 101, "test:start-101");
  seedJobsRow(db, "sess-b-alive-recycled", 101, "test:old-start");
  seedJobsRow(db, "sess-c-dead-with-start", 102, "test:dead-start");
  seedJobsRow(db, "sess-d-dead-no-start", 102, null);
  seedJobsRow(db, "sess-e-alive-legacy", 101, null);

  seedKilledSweep(db, SEED_SWEEP_DEPS);
  drainToCompletion(db);

  const stateOf = (jobId: string): string | undefined =>
    (
      db.query("SELECT state FROM jobs WHERE job_id = ?").get(jobId) as {
        state: string;
      } | null
    )?.state;
  expect(stateOf("sess-b-alive-recycled")).toBe("killed");
  expect(stateOf("sess-c-dead-with-start")).toBe("killed");
  expect(stateOf("sess-d-dead-no-start")).toBe("killed");
  expect(stateOf("sess-e-alive-legacy")).toBe("stopped");
  expect(stateOf("sess-a-alive-matching")).toBe("stopped");
  db.close();
});

test("seed sweep is idempotent — a second sweep emits no duplicate Killed events", () => {
  const { db } = freshMemDb();

  const deadPid = 102;
  seedJobsRow(db, "sess-zombie", deadPid, null);

  // First sweep: should emit ONE Killed event and fold to `killed`.
  seedKilledSweep(db, SEED_SWEEP_DEPS);
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
  seedKilledSweep(db, SEED_SWEEP_DEPS);
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

  const deadPid = 102;
  // Terminal states are out of scope per the candidate query — even with a
  // NULL pid (a terminal NULL-pid row stays put; the fn-743 reap is for
  // NON-terminal NULL-pid rows only).
  seedJobsRow(db, "sess-ended", deadPid, null, "ended");
  seedJobsRow(db, "sess-already-killed", deadPid, null, "killed");
  seedJobsRow(db, "sess-no-pid-ended", null, null, "ended");

  seedKilledSweep(db, SEED_SWEEP_DEPS);
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

  seedKilledSweep(db, SEED_SWEEP_DEPS);
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

function seedPoisonDeadLetter(
  db: ReturnType<typeof openDb>["db"],
  opts: {
    dl_id: string;
    ts: number;
    bindings: Record<string, unknown>;
    source_file?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO dead_letters
       (dl_id, session_id, hook_event, ts, dl_written_at, pid, bindings,
        status, recovered_at, replayed_event_id, source_file)
     VALUES (?, 'poison', 'PoisonLine', ?, ?, 44, ?, 'poison', NULL, NULL, ?)`,
  ).run(
    opts.dl_id,
    opts.ts,
    opts.ts + 1,
    JSON.stringify(opts.bindings),
    opts.source_file ?? null,
  );
}

test("reclassifyPoisonDeadLetter replays current-parser raw with the original ts and re-folds byte-identically", () => {
  const { db } = freshMemDb();
  seedPoisonDeadLetter(db, {
    dl_id: "poison:fossil",
    ts: 1_700_000_123,
    source_file: "/events/44.ndjson",
    bindings: {
      raw: JSON.stringify({
        bindings: {
          ts: 9_999_999_999,
          session_id: "fossil-session",
          pid: 44,
          hook_event: "SessionStart",
          event_type: "lifecycle",
          data: "{}",
          cwd: "/repo",
        },
      }),
      file: "/events/44.ndjson",
    },
  });

  expect(reclassifyPoisonDeadLetter(db, "poison:fossil")).toBe("reclassified");
  const event = db
    .query(
      "SELECT id, ts, session_id, hook_event FROM events WHERE session_id = 'fossil-session'",
    )
    .get() as {
    id: number;
    ts: number;
    session_id: string;
    hook_event: string;
  };
  expect(event).toEqual({
    id: 1,
    ts: 1_700_000_123,
    session_id: "fossil-session",
    hook_event: "SessionStart",
  });
  expect(
    db
      .query(
        "SELECT status, replayed_event_id, source_file FROM dead_letters WHERE dl_id = 'poison:fossil'",
      )
      .get(),
  ).toEqual({
    status: "recovered",
    replayed_event_id: 1,
    source_file: null,
  });

  drainToCompletion(db);
  const firstProjection = db
    .query("SELECT * FROM jobs WHERE job_id = 'fossil-session'")
    .get() as Record<string, unknown>;
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  __resetEpicIndexMemoForTest(db);
  drainToCompletion(db);
  const refoldedProjection = db
    .query("SELECT * FROM jobs WHERE job_id = 'fossil-session'")
    .get() as Record<string, unknown>;
  expect(refoldedProjection).toEqual(firstProjection);
  db.close();
});

test("reclassifyPoisonDeadLetter returns still_poison without mutating an unclassifiable row", () => {
  const { db } = freshMemDb();
  seedPoisonDeadLetter(db, {
    dl_id: "poison:genuine",
    ts: 77,
    bindings: { raw: "not current-parser input", file: "/events/44.ndjson" },
  });
  const before = db
    .query("SELECT * FROM dead_letters WHERE dl_id = 'poison:genuine'")
    .get() as Record<string, unknown>;
  expect(reclassifyPoisonDeadLetter(db, "poison:genuine")).toBe("still_poison");
  const after = db
    .query("SELECT * FROM dead_letters WHERE dl_id = 'poison:genuine'")
    .get() as Record<string, unknown>;
  expect(after).toEqual(before);
  expect(
    (db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n,
  ).toBe(0);
  db.close();
});

test("resolvePoisonDeadLetter writes a bounded audit and refuses double-resolution idempotently", () => {
  const { db } = freshMemDb();
  seedPoisonDeadLetter(db, {
    dl_id: "poison:resolve",
    ts: 88,
    bindings: { raw: "bad", file: "/events/44.ndjson" },
  });
  expect(
    resolvePoisonDeadLetter(
      db,
      "poison:resolve",
      "operator-session",
      "  inspected and accepted  ",
      true,
      1_700_000_500,
    ),
  ).toBe("resolved");
  const resolved = db
    .query(
      "SELECT status, recovered_at, replayed_event_id, bindings FROM dead_letters WHERE dl_id = 'poison:resolve'",
    )
    .get() as {
    status: string;
    recovered_at: number;
    replayed_event_id: number | null;
    bindings: string;
  };
  expect(resolved.status).toBe("resolved");
  expect(resolved.recovered_at).toBe(1_700_000_500);
  expect(resolved.replayed_event_id).toBeNull();
  expect(JSON.parse(resolved.bindings)).toEqual({
    raw: "bad",
    file: "/events/44.ndjson",
    resolved_by: "operator-session",
    resolve_reason: "inspected and accepted",
    resolved_force: true,
    resolved_at: 1_700_000_500,
  });

  expect(
    resolvePoisonDeadLetter(
      db,
      "poison:resolve",
      "other-operator",
      "replace audit",
      true,
      1_800_000_000,
    ),
  ).toBe("refused_already_resolved");
  expect(
    db
      .query(
        "SELECT status, recovered_at, replayed_event_id, bindings FROM dead_letters WHERE dl_id = 'poison:resolve'",
      )
      .get(),
  ).toEqual(resolved);
  db.close();
});

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
  __resetEpicIndexMemoForTest(db);
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
 * and terminal seeds the retention prune consumes. `bindings` is irrelevant to
 * the prune, so a fixed `'{}'` suffices.
 */
function seedDlRow(
  db: ReturnType<typeof openDb>["db"],
  opts: {
    dl_id: string;
    status:
      | "waiting"
      | "recovered"
      | "poison"
      | "resolved"
      | typeof BIRTH_STUCK_STATUS;
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

test("pruneRecoveredDeadLetters: unresolved poison is retained; resolved rows age on resolution time without unlinking events logs", () => {
  const { db } = freshMemDb();
  const dlDir = mkdtempSync(join(tmpDir, "dl-"));
  const eventsLogDir = mkdtempSync(join(tmpDir, "el-"));
  const eventsLogFile = join(eventsLogDir, "777.ndjson");
  writeFileSync(eventsLogFile, "poison-bytes\n");
  seedDlRow(db, {
    dl_id: "p-unresolved",
    status: "poison",
    dl_written_at: DL_AGED_SEC,
    recovered_at: null,
    source_file: eventsLogFile,
    pid: 777,
  });
  seedDlRow(db, {
    dl_id: "r-old",
    status: "resolved",
    dl_written_at: DL_AGED_SEC - 100,
    recovered_at: DL_AGED_SEC,
    source_file: eventsLogFile,
    pid: 777,
  });
  seedDlRow(db, {
    dl_id: "r-new",
    status: "resolved",
    dl_written_at: DL_AGED_SEC - 100,
    recovered_at: DL_FRESH_SEC,
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
  const remaining = db
    .query("SELECT dl_id FROM dead_letters ORDER BY dl_id")
    .all() as { dl_id: string }[];
  expect(remaining.map((row) => row.dl_id)).toEqual(["p-unresolved", "r-new"]);
  db.close();
});

test("pruneRecoveredDeadLetters: birth-stuck rows age on dl_written_at without unlinking source files", () => {
  const { db } = freshMemDb();
  const dlDir = mkdtempSync(join(tmpDir, "dl-"));
  const birthSourceDir = mkdtempSync(join(tmpDir, "births-"));
  const birthFile = join(birthSourceDir, "9876543.json");
  writeFileSync(birthFile, "birth-record\n");
  seedDlRow(db, {
    dl_id: "bs-old",
    status: BIRTH_STUCK_STATUS,
    dl_written_at: DL_AGED_SEC,
    recovered_at: null,
    source_file: birthFile,
    pid: 9_876_543,
  });
  seedDlRow(db, {
    dl_id: "bs-new",
    status: BIRTH_STUCK_STATUS,
    dl_written_at: DL_FRESH_SEC,
    recovered_at: null,
    source_file: birthFile,
    pid: 9_876_543,
  });

  const res = pruneRecoveredDeadLetters(db, dlDir, {
    now: DL_NOW_MS,
    isPidAlive: PROBE_DEAD,
  });

  expect(res.prunedRows).toBe(1);
  expect(res.prunedFiles).toBe(0);
  expect(existsSync(birthFile)).toBe(true);
  const remaining = db.query("SELECT dl_id FROM dead_letters").all() as {
    dl_id: string;
  }[];
  expect(remaining.map((r) => r.dl_id)).toEqual(["bs-new"]);
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
// Archive eligibility is a pure decision: runtime file movement is the lint-like
// entrypoint concern, while the gate itself must not fork Bun in the fast tier.
// ---------------------------------------------------------------------------

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

test("archive eligibility leaves a file with a waiting record in place", () => {
  const decision = archiveEligibility(
    dlLine("dl-ok", "sess-ok") + dlLine("dl-wait", "sess-wait"),
    new Set(["dl-ok"]),
  );
  expect(decision).toEqual({ eligible: false, records: 2 });
});

test("archive eligibility excludes recovered records without a landed event", () => {
  expect(archiveEligibility(dlLine("dl-noid", "sess-noid"), new Set())).toEqual(
    {
      eligible: false,
      records: 1,
    },
  );
});

test("archive eligibility leaves an all-torn file untouched", () => {
  expect(archiveEligibility("not json\n{bad\n", new Set())).toEqual({
    eligible: false,
    records: 0,
  });
});

test("archive eligibility accepts every confirmed parseable record", () => {
  expect(
    archiveEligibility(
      dlLine("dl-a", "sess-a") + dlLine("dl-b", "sess-b"),
      new Set(["dl-a", "dl-b"]),
    ),
  ).toEqual({ eligible: true, records: 2 });
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

test("Fable-focus Projection publication rehydrates the exact policy identity on restart", () => {
  const { db } = openDb(":memory:");
  const root = mkdtempSync(join(tmpdir(), "keeper-fable-daemon-"));
  const policy = materializeFableFocusPolicy(
    {
      target_route: "claude-swap:2",
      lifetime: {
        kind: "absolute",
        deadline_at: "2026-07-20T23:59:59.000Z",
      },
    },
    7,
    1_752_840_000,
  );
  if (policy === null) throw new Error("expected policy");
  db.run(
    `INSERT INTO autopilot_state
       (id, paused, last_event_id, created_at, updated_at, fable_focus)
     VALUES (1, 1, 7, 1, 1, ?)`,
    [serializeFableFocusPolicy(policy)],
  );
  try {
    expect(publishFableFocusProjection(db, root)).toEqual({
      schema_version: 1,
      policy,
    });
    expect(() =>
      publishFableFocusProjection(db, root, {
        publish: () => {},
        read: () => ({ available: true, policy: null }),
      }),
    ).toThrow("Fable-focus launch leaf does not match the Projection");
    const path = join(root, "fable-focus-policy.json");
    writeFileSync(path, "corrupt");
    // A restart republishes from SQLite; it does not recompute the approved time.
    expect(publishFableFocusProjection(db, root).policy).toEqual(policy);
    expect(readFableFocusLeaf(path)).toEqual({ available: true, policy });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Non-Fable-focus Projection publication verifies identity independently", () => {
  const { db } = openDb(":memory:");
  const root = mkdtempSync(join(tmpdir(), "keeper-non-fable-daemon-"));
  const policy = materializeNonFableFocusPolicy(
    { target_route: "claude-swap:3", lifetime: { kind: "permanent" } },
    8,
    1_752_840_060,
  );
  if (policy === null) throw new Error("expected policy");
  db.run(
    `INSERT INTO autopilot_state
       (id, paused, last_event_id, created_at, updated_at, non_fable_focus)
     VALUES (1, 1, 8, 1, 1, ?)`,
    [serializeNonFableFocusPolicy(policy)],
  );
  try {
    expect(publishNonFableFocusProjection(db, root)).toEqual({
      schema_version: 1,
      policy,
    });
    expect(
      readNonFableFocusLeaf(join(root, "non-fable-focus-policy.json")),
    ).toEqual({
      available: true,
      policy,
    });
    expect(() =>
      publishNonFableFocusProjection(db, root, {
        publish: () => {},
        read: () => ({ available: true, policy: null }),
      }),
    ).toThrow("Non-Fable-focus launch leaf does not match the Projection");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("one Account-focus publication failure leaves the sibling leaf untouched", () => {
  const { db } = openDb(":memory:");
  const root = mkdtempSync(join(tmpdir(), "keeper-focus-isolation-"));
  const fable = materializeFableFocusPolicy(
    { target_route: "claude-swap:2", lifetime: { kind: "permanent" } },
    7,
    1_752_840_000,
  );
  const nonFable = materializeNonFableFocusPolicy(
    { target_route: "claude-swap:3", lifetime: { kind: "permanent" } },
    8,
    1_752_840_060,
  );
  if (fable === null || nonFable === null) throw new Error("expected policies");
  db.run(
    `INSERT INTO autopilot_state
       (id, paused, last_event_id, created_at, updated_at, fable_focus, non_fable_focus)
     VALUES (1, 1, 8, 1, 1, ?, ?)`,
    [serializeFableFocusPolicy(fable), serializeNonFableFocusPolicy(nonFable)],
  );
  try {
    publishFableFocusProjection(db, root);
    publishNonFableFocusProjection(db, root);
    const siblingPath = join(root, "fable-focus-policy.json");
    const siblingBefore = readFileSync(siblingPath, "utf8");
    expect(() =>
      publishNonFableFocusProjection(db, root, {
        publish: () => {
          throw new Error("injected Non-Fable write failure");
        },
      }),
    ).toThrow("injected Non-Fable write failure");
    expect(readFileSync(siblingPath, "utf8")).toBe(siblingBefore);
    expect(readFableFocusLeaf(siblingPath)).toEqual({
      available: true,
      policy: fable,
    });

    const reverseSiblingPath = join(root, "non-fable-focus-policy.json");
    const reverseSiblingBefore = readFileSync(reverseSiblingPath, "utf8");
    expect(() =>
      publishFableFocusProjection(db, root, {
        publish: () => {
          throw new Error("injected Fable write failure");
        },
      }),
    ).toThrow("injected Fable write failure");
    expect(readFileSync(reverseSiblingPath, "utf8")).toBe(reverseSiblingBefore);
    expect(readNonFableFocusLeaf(reverseSiblingPath)).toEqual({
      available: true,
      policy: nonFable,
    });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Fable-focus mutation acknowledgement fails closed on leaf publication failure", () => {
  const { db } = openDb(":memory:");
  const root = mkdtempSync(join(tmpdir(), "keeper-fable-daemon-"));
  try {
    expect(() =>
      publishFableFocusProjection(db, root, {
        publish: () => {
          throw new Error("injected atomic write failure");
        },
      }),
    ).toThrow("injected atomic write failure");
    expect(readFableFocusLeaf(join(root, "fable-focus-policy.json"))).toEqual({
      available: false,
      diagnostic: "delivery-missing",
    });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
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
  // ALTERs, NO cursor rewind. v127 adds package-attribution indexes, v128 adds
  // the Git attribution observation watermark, and v129 rebuilds
  // `autopilot_state` without its retired rollout-only adoption column while
  // preserving every surviving setting. v133 adds the fn-1311
  // `boot_catchup_stats` OPERATIONAL singleton (main's durable record of the
  // most recent boot's catch-up window) — a new standalone table, never
  // fold-touched, so NO cursor rewind. v134 appends the nullable
  // `boot_catchup_stats.fold_work_ms` column (fn-1313, the full-replay
  // projection's pace-free rate) — an additive ALTER on that same operational
  // singleton, never fold-touched, so NO cursor rewind.
  expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(138);
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

test("fenced DispatchCleared append: matching authority clears only its exact gate; stale, claimless, and failed appends preserve newer ownership", () => {
  const { db } = freshMemDb();
  const verb = "close";
  const id = "fn-1-foo";
  const key = `${verb}::${id}`;
  db.query(
    `INSERT INTO dispatch_failures
       (verb, id, reason, dir, ts, last_event_id, created_at, updated_at,
        attempt_id, instance_event_id)
     VALUES (?, ?, 'failure', '/repo', 1, 51, 1, 1, 41, 51)`,
  ).run(verb, id);
  upsertDispatchMintGate(db, key, 1, 41);

  let appends = 0;
  expect(
    appendFencedDispatchClear({
      db,
      verb,
      id,
      fences: {
        expected_attempt_id: 41,
        expected_instance_event_id: 51,
      },
      append: () => {
        appends++;
      },
    }),
  ).toBe(true);
  expect(appends).toBe(1);
  expect(readDispatchMintGate(db, key)).toBeNull();

  // A delayed worker message cannot rebind itself to the newer attempt.
  upsertDispatchMintGate(db, key, 2, 61);
  const notes: string[] = [];
  expect(
    appendFencedDispatchClear({
      db,
      verb,
      id,
      fences: {
        expected_attempt_id: 41,
        expected_instance_event_id: 51,
      },
      append: () => {
        appends++;
      },
      noteLine: (line) => notes.push(line),
    }),
  ).toBe(false);
  expect(appends).toBe(1);
  expect(readDispatchMintGate(db, key)).toBe(2);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain(`key=${key} attempt=41 incident=51`);
  expect(notes[0]).not.toContain("61");

  // A claimless incident clear carries no attempt authority and cannot release
  // the unrelated exact gate even though its incident fence is current.
  expect(
    appendFencedDispatchClear({
      db,
      verb,
      id,
      fences: {
        expected_attempt_id: null,
        expected_instance_event_id: 51,
      },
      append: () => {
        appends++;
      },
    }),
  ).toBe(true);
  expect(appends).toBe(2);
  expect(readDispatchMintGate(db, key)).toBe(2);

  // Append failure propagates but never consumes the newer durable gate.
  expect(() =>
    appendFencedDispatchClear({
      db,
      verb,
      id,
      fences: {
        expected_attempt_id: 61,
        expected_instance_event_id: 51,
      },
      append: () => {
        throw new Error("event insert failed");
      },
    }),
  ).toThrow("event insert failed");
  expect(readDispatchMintGate(db, key)).toBe(2);
  db.close();
});

test("retry_dispatch append-point snapshot binds the current incident and newest exact attempt without changing its id-only wire", () => {
  const { db } = freshMemDb();
  db.query(
    `INSERT INTO dispatch_failures
       (verb, id, reason, dir, ts, last_event_id, created_at, updated_at,
        attempt_id, instance_event_id)
     VALUES ('work', 'fn-1-foo.1', 'failure', '/repo', 1, 71, 1, 1, 61, 71)`,
  ).run();
  upsertDispatchMintGate(db, "work::fn-1-foo.1", 2, 81);
  expect(dispatchClearFencesAtAppend(db, "work", "fn-1-foo.1")).toEqual({
    expected_attempt_id: 81,
    expected_instance_event_id: 71,
  });
  db.close();
});

// ---------------------------------------------------------------------------
// decideDispatchClearLiveness — the operator dispatch-clear liveness fence.
// Pure decision, driven with seeded claim rows + a pid probe seam (PROBE
// verdicts mirror `recordedProcessIdentity`).
// ---------------------------------------------------------------------------

const BOUND_CLAIM = { state: "bound", bound_at: 123 } as const;
// A probe that fails the test if it is ever consulted — proves the lazy
// short-circuit (unbound / forced paths never spawn a process probe).
const PROBE_NEVER = (): RecordedProcessIdentityVerdict => {
  throw new Error("liveness probe must not be consulted on this path");
};

test("decideDispatchClearLiveness: an absent / released / unbound claim clears without probing", () => {
  // No claim at all.
  expect(decideDispatchClearLiveness(undefined, false, PROBE_NEVER)).toEqual({
    kind: "clear",
  });
  // A released claim protects nothing live.
  expect(
    decideDispatchClearLiveness(
      { state: "released", bound_at: 123 },
      false,
      PROBE_NEVER,
    ),
  ).toEqual({ kind: "clear" });
  // Acquired-but-not-yet-bound: no worker occupies it.
  expect(
    decideDispatchClearLiveness(
      { state: "acquired", bound_at: null },
      false,
      PROBE_NEVER,
    ),
  ).toEqual({ kind: "clear" });
});

test("decideDispatchClearLiveness: a bound claim refuses on a live OR uncertain probe (over-refusal is the safe side)", () => {
  expect(
    decideDispatchClearLiveness(BOUND_CLAIM, false, () => "matching"),
  ).toEqual({ kind: "refuse-live" });
  // Uncertain (reused pid / unreadable identity / missing witness) refuses too.
  expect(
    decideDispatchClearLiveness(BOUND_CLAIM, false, () => "inconclusive"),
  ).toEqual({ kind: "refuse-live" });
});

test("decideDispatchClearLiveness: a bound claim clears ONLY when the claimant probes provably gone", () => {
  expect(decideDispatchClearLiveness(BOUND_CLAIM, false, () => "gone")).toEqual(
    { kind: "clear" },
  );
});

test("decideDispatchClearLiveness: --force lifts the liveness gate before any probe runs", () => {
  // Force short-circuits ahead of the probe — a live bound claim clears, and
  // the probe is never consulted.
  expect(decideDispatchClearLiveness(BOUND_CLAIM, true, PROBE_NEVER)).toEqual({
    kind: "clear",
  });
});

test("probeDispatchClearClaimLiveness: missing claimant evidence refuses live and a gone witness clears", () => {
  const boundClaim = { state: "bound", bound_at: 123 };
  const cases: Array<{
    claim: { session_id: string | null };
    job: { pid: number | null; start_time: string | null } | null;
    probe: RecordedProcessIdentityVerdict;
    decision: "refuse-live" | "clear";
    recorded?: () => RecordedProcessIdentityVerdict;
  }> = [
    {
      claim: { session_id: null },
      job: null,
      probe: "inconclusive",
      decision: "refuse-live",
    },
    {
      claim: { session_id: "" },
      job: { pid: 11, start_time: "linux:1" },
      probe: "inconclusive",
      decision: "refuse-live",
    },
    {
      claim: { session_id: "sess-absent" },
      job: null,
      probe: "inconclusive",
      decision: "refuse-live",
    },
    {
      claim: { session_id: "sess-pid" },
      job: { pid: null, start_time: "linux:1" },
      probe: "inconclusive",
      decision: "refuse-live",
    },
    {
      claim: { session_id: "sess-start" },
      job: { pid: 42, start_time: "" },
      probe: "inconclusive",
      decision: "refuse-live",
    },
    {
      claim: { session_id: "sess-gone" },
      job: { pid: 42, start_time: "linux:1" },
      probe: "gone",
      decision: "clear",
      recorded: () => "gone",
    },
  ];
  for (const testCase of cases) {
    const probe = probeDispatchClearClaimLiveness(
      testCase.claim,
      testCase.job,
      testCase.recorded ??
        (() => "inconclusive" as RecordedProcessIdentityVerdict),
    );
    expect(probe).toBe(testCase.probe);
    expect(decideDispatchClearLiveness(boundClaim, false, () => probe)).toEqual(
      { kind: testCase.decision },
    );
  }
});

// ---------------------------------------------------------------------------
// terminalSessionClaimIsReleaseable — the recycle-safe liveness fence on the
// orphan/GC claim-release sweep. A terminal jobs state alone must not release a
// claim: a serve-liveness watchdog recycle's seed sweep can fold a still-live
// worker to `killed`, and releasing here would let the reconciler dispatch a
// second live worker (the double-mint). The release re-probes the owning
// session's recorded (pid, start_time) and holds a live-or-inconclusive owner.
// ---------------------------------------------------------------------------

function seedTerminalSessionClaim(
  db: ReturnType<typeof freshMemDb>["db"],
  opts: {
    id: string;
    attemptId: number;
    sessionId: string;
    jobState: "killed" | "ended" | "stopped";
    pid: number | null;
    startTime: string | null;
    claimState?: "bound" | "resume_requested";
  },
): void {
  db.run(
    `INSERT INTO jobs (job_id, created_at, cwd, pid, state, last_event_id,
                       updated_at, title, title_source, transcript_path,
                       plan_verb, plan_ref, start_time)
       VALUES (?, 1, NULL, ?, ?, ?, 2, NULL, NULL, NULL, 'work', ?, ?)`,
    [
      opts.sessionId,
      opts.pid,
      opts.jobState,
      opts.attemptId,
      opts.id,
      opts.startTime,
    ],
  );
  db.run(
    `INSERT INTO dispatch_claims (verb, id, attempt_id, state, session_id, dir,
                                  legacy_unfenced, acquired_at, bound_at,
                                  last_event_id, updated_at)
       VALUES ('work', ?, ?, ?, ?, '/repo', 0, 1, 1, ?, 2)`,
    [
      opts.id,
      opts.attemptId,
      opts.claimState ?? "bound",
      opts.sessionId,
      opts.attemptId,
    ],
  );
}

test("terminalSessionClaimIsReleaseable: a pid-bearing terminal owner releases ONLY when it probes provably gone", () => {
  const { db } = freshMemDb();
  seedTerminalSessionClaim(db, {
    id: "live.1",
    attemptId: 301,
    sessionId: "sess-live",
    jobState: "killed",
    pid: 4242,
    startTime: "linux:100",
  });
  const row = {
    verb: "work",
    id: "live.1",
    attempt_id: 301,
    session_id: "sess-live",
  };
  // A live worker whose row was wrongly reaped to `killed` (the recycle
  // collateral) HOLDS its claim — releasing it would redispatch a second worker.
  expect(terminalSessionClaimIsReleaseable(db, row, () => "matching")).toBe(
    false,
  );
  // An uncertain identity (reused pid, unreadable witness) also holds — fail-closed.
  expect(terminalSessionClaimIsReleaseable(db, row, () => "inconclusive")).toBe(
    false,
  );
  // Only positive death evidence releases (the sanctioned reap).
  expect(terminalSessionClaimIsReleaseable(db, row, () => "gone")).toBe(true);
  db.close();
});

test("terminalSessionClaimIsReleaseable: a witnessless (NULL pid) terminal owner falls back to terminal-state trust without probing", () => {
  const { db } = freshMemDb();
  seedTerminalSessionClaim(db, {
    id: "nowitness.1",
    attemptId: 302,
    sessionId: "sess-nowitness",
    jobState: "killed",
    pid: null,
    startTime: null,
  });
  // No (pid, start_time) witness: the seed sweep already proved this row
  // unwatchable/terminal by construction, so the release proceeds and the
  // process probe is NEVER consulted.
  expect(
    terminalSessionClaimIsReleaseable(
      db,
      {
        verb: "work",
        id: "nowitness.1",
        attempt_id: 302,
        session_id: "sess-nowitness",
      },
      PROBE_NEVER,
    ),
  ).toBe(true);
  db.close();
});

test("double-mint structurally prevented: the planner surfaces a reaped-but-live owner, the release re-check HOLDS its claim", () => {
  const { db } = freshMemDb();
  // A live swap-routed worker (fresh start-time witness) whose jobs row a
  // watchdog recycle folded to `killed`. The terminal-state SQL predicate makes
  // it a release CANDIDATE, but the liveness re-check must hold the claim so the
  // redispatch path still sees the surviving claim/session — no double-mint.
  seedTerminalSessionClaim(db, {
    id: "reaped-live.1",
    attemptId: 303,
    sessionId: "sess-reaped-live",
    jobState: "killed",
    pid: 5150,
    startTime: "linux:200",
  });
  const planned = planTerminalSessionClaimReleases(db);
  expect(planned.map((row) => row.id)).toEqual(["reaped-live.1"]);
  const candidate = planned[0];
  if (candidate === undefined) throw new Error("expected a planned candidate");
  // Live owner → HELD (the claim is never released, so the reconciler cannot
  // dispatch a second worker onto the lane).
  expect(
    terminalSessionClaimIsReleaseable(db, candidate, () => "matching"),
  ).toBe(false);
  // The same candidate, once its owner is provably gone, releases (the genuine
  // reap the sweep is for).
  expect(terminalSessionClaimIsReleaseable(db, candidate, () => "gone")).toBe(
    true,
  );
  db.close();
});

test("buildRetryDispatchResultMessage: refused_live, refused_identity, and cleared replies are explicit", () => {
  expect(
    buildRetryDispatchResultMessage({
      id: "req-live",
      verb: "work",
      dispatchId: "fn-1-foo.3",
      claimSessionId: "sess-live",
      decision: { kind: "refuse-live" },
      applied: false,
    }),
  ).toMatchObject({
    type: "retry-dispatch-result",
    id: "req-live",
    ok: false,
    outcome: "refused_live",
    error: expect.stringContaining("session sess-live"),
  });
  expect(
    buildRetryDispatchResultMessage({
      id: "req-identity",
      verb: "work",
      dispatchId: "fn-1-foo.3",
      claimSessionId: "sess-live",
      decision: { kind: "clear" },
      applied: false,
    }),
  ).toMatchObject({
    type: "retry-dispatch-result",
    id: "req-identity",
    ok: false,
    outcome: "refused_identity",
    error: expect.stringContaining("changed at the write site"),
  });
  expect(
    buildRetryDispatchResultMessage({
      id: "req-clear",
      verb: "work",
      dispatchId: "fn-1-foo.3",
      claimSessionId: null,
      decision: { kind: "clear" },
      applied: true,
    }),
  ).toEqual({
    type: "retry-dispatch-result",
    id: "req-clear",
    ok: true,
    outcome: "cleared",
  });
});

// ---------------------------------------------------------------------------
// buildDispatchClearedData — audit trail in the DispatchCleared event data,
// stored byte-identically for re-fold.
// ---------------------------------------------------------------------------

test("buildDispatchClearedData: internal sweeps keep the historical shape; an operator clear stamps the audit trail", () => {
  const fences = { expected_attempt_id: 41, expected_instance_event_id: 51 };
  // No audit → the pre-fence shape, unchanged byte-for-byte.
  expect(
    JSON.parse(buildDispatchClearedData("work", "fn-1-foo.1", fences)),
  ).toEqual({
    verb: "work",
    id: "fn-1-foo.1",
    expected_attempt_id: 41,
    expected_instance_event_id: 51,
  });
  // Operator clear → the acting identity + forced flag ride alongside.
  expect(
    JSON.parse(
      buildDispatchClearedData("work", "fn-1-foo.1", fences, {
        forced: true,
        caller_session: "work",
      }),
    ),
  ).toEqual({
    verb: "work",
    id: "fn-1-foo.1",
    expected_attempt_id: 41,
    expected_instance_event_id: 51,
    forced: true,
    caller_session: "work",
  });
});

test("audit-carrying DispatchCleared folds byte-identically to a plain one (audit fields are re-fold-inert)", () => {
  const fences = { expected_attempt_id: 41, expected_instance_event_id: 51 };
  // Two DBs, identical seeded failure rows; one clear carries the operator audit
  // trail, the other the internal-sweep shape. The fold reads only verb/id/fence
  // fields, so both must delete the row identically — the audit never perturbs
  // the deterministic-replayed projection.
  const seedFailure = (db: ReturnType<typeof freshMemDb>["db"]): void => {
    db.query(
      `INSERT INTO dispatch_failures
         (verb, id, reason, dir, ts, last_event_id, created_at, updated_at,
          attempt_id, instance_event_id)
       VALUES ('work', 'fn-1-foo.1', 'failure', '/repo', 1, 51, 1, 1, 41, 51)`,
    ).run();
  };
  const seedClear = (
    db: ReturnType<typeof freshMemDb>["db"],
    data: string,
  ): void => {
    db.run(
      `INSERT INTO events (ts, session_id, pid, hook_event, event_type, data)
         VALUES (1, 'work::fn-1-foo.1', NULL, 'DispatchCleared', 'dispatch_failures', ?)`,
      [data],
    );
  };
  const failuresLeft = (db: ReturnType<typeof freshMemDb>["db"]): number =>
    (
      db.query("SELECT COUNT(*) AS n FROM dispatch_failures").get() as {
        n: number;
      }
    ).n;

  const withAudit = freshMemDb().db;
  seedFailure(withAudit);
  const auditData = buildDispatchClearedData("work", "fn-1-foo.1", fences, {
    forced: true,
    caller_session: "work",
  });
  seedClear(withAudit, auditData);
  drainToCompletion(withAudit);

  const plain = freshMemDb().db;
  seedFailure(plain);
  seedClear(plain, buildDispatchClearedData("work", "fn-1-foo.1", fences));
  drainToCompletion(plain);

  // Both clears deleted the row; the audit shape changed nothing.
  expect(failuresLeft(withAudit)).toBe(0);
  expect(failuresLeft(plain)).toBe(0);
  // The audit event's data survives verbatim in the log — re-fold reads the same
  // bytes, so the audit trail replays byte-identically.
  const storedData = (
    withAudit
      .query(
        "SELECT data FROM events WHERE hook_event = 'DispatchCleared' LIMIT 1",
      )
      .get() as { data: string }
  ).data;
  expect(storedData).toBe(auditData);
  withAudit.close();
  plain.close();
});

test("regression: an internal orphan sweep clearing a stale failure row never deletes a live bound attempt's mint gate", () => {
  const { db } = freshMemDb();
  const verb = "work";
  // A leading-dot / path token is un-retryable by the wire validator, so the
  // orphan sweep is the ONLY producer that can clear it — an internal sweep, not
  // the operator surface. It matches no distress-key skip, so it IS swept.
  const id = "../evil";
  const key = `${verb}::${id}`;
  // The stale failure row records the OLD attempt (41).
  db.query(
    `INSERT INTO dispatch_failures
       (verb, id, reason, dir, ts, last_event_id, created_at, updated_at,
        attempt_id, instance_event_id)
     VALUES (?, ?, 'orphaned', NULL, 1, 51, 1, 1, 41, 51)`,
  ).run(verb, id);
  // A LIVE newer attempt (99) has re-bound the same key and owns the mint gate.
  db.query(
    `INSERT INTO dispatch_claims
       (verb, id, attempt_id, state, session_id, acquired_at, bound_at,
        last_event_id, updated_at)
     VALUES (?, ?, 99, 'bound', 'sess-live', 1, 2, 61, 2)`,
  ).run(verb, id);
  upsertDispatchMintGate(db, key, 99, 61);

  // Drive the REAL orphan sweep through the exact fenced-append CAS every clear
  // (operator + internal) routes through. The append is a no-op stand-in for the
  // folded DispatchCleared event.
  let appends = 0;
  const swept = gcUnretryableDispatchFailures(db, (v, i, fences) => {
    appendFencedDispatchClear({
      db,
      verb: v,
      id: i,
      fences,
      append: () => {
        appends++;
      },
    });
  });

  // The sweep processed the stale row (fences pinned the OLD attempt 41)...
  expect(swept).toBe(1);
  // ...but the CAS re-snapshot saw the live attempt 99 own the key, so it
  // refused: no event appended, and the live mint gate is intact. No
  // double-dispatch window opens behind the live worker.
  expect(appends).toBe(0);
  expect(readDispatchMintGate(db, key)).toBe(99);
  db.close();
});

// ---------------------------------------------------------------------------
// internalIncidentClearFences — the recover/reconciler auto-clear's attempt-fence
// gate. An incident-resolution level-clear names the CURRENTLY bound attempt (it
// reads it from live projection state), so the attempt fence is admitted ONLY
// behind positive terminal proof of the claimant; a live or uncertain probe
// degrades to an incident-only clear that drops the sticky row WITHOUT releasing
// attempt-owned state. Composed end-to-end through the REAL fold: seed a fully-
// armed live attempt (failure row + bound claim + pending lease + mint gate),
// compute the fences the producer would emit, fold the `DispatchCleared`, and
// assert the survivor set.
// ---------------------------------------------------------------------------

const INCIDENT_CLEAR_ATTEMPT_ID = 41;
const INCIDENT_CLEAR_EVENT_ID = 51;

function seedArmedLiveAttempt(
  db: ReturnType<typeof freshMemDb>["db"],
  verb: string,
  id: string,
): void {
  db.query(
    `INSERT INTO dispatch_failures
       (verb, id, reason, dir, ts, last_event_id, created_at, updated_at,
        attempt_id, instance_event_id)
     VALUES (?, ?, 'worktree-recover:e', '/repo', 1, ?, 1, 1, ?, ?)`,
  ).run(
    verb,
    id,
    INCIDENT_CLEAR_EVENT_ID,
    INCIDENT_CLEAR_ATTEMPT_ID,
    INCIDENT_CLEAR_EVENT_ID,
  );
  db.query(
    `INSERT INTO dispatch_claims
       (verb, id, attempt_id, state, session_id, acquired_at, bound_at,
        last_event_id, updated_at)
     VALUES (?, ?, ?, 'bound', 'sess-live', 1, 2, ?, 2)`,
  ).run(verb, id, INCIDENT_CLEAR_ATTEMPT_ID, INCIDENT_CLEAR_EVENT_ID);
  db.query(
    `INSERT INTO pending_dispatches
       (verb, id, dir, dispatched_at, last_event_id, attempt_id)
     VALUES (?, ?, '/repo', 2, ?, ?)`,
  ).run(verb, id, INCIDENT_CLEAR_EVENT_ID, INCIDENT_CLEAR_ATTEMPT_ID);
  upsertDispatchMintGate(db, `${verb}::${id}`, 2, INCIDENT_CLEAR_ATTEMPT_ID);
}

function foldIncidentClear(
  db: ReturnType<typeof freshMemDb>["db"],
  verb: string,
  id: string,
  probe: RecordedProcessIdentityVerdict,
): void {
  // The producer names the CURRENTLY bound attempt in the payload; the gate
  // decides whether the fold may act on it, given the claimant liveness verdict.
  const fences = internalIncidentClearFences(
    {
      expected_attempt_id: INCIDENT_CLEAR_ATTEMPT_ID,
      expected_instance_event_id: INCIDENT_CLEAR_EVENT_ID,
    },
    () => probe,
  );
  db.run(
    `INSERT INTO events (ts, session_id, pid, hook_event, event_type, data)
       VALUES (1, ?, NULL, 'DispatchCleared', 'dispatch_failures', ?)`,
    [`${verb}::${id}`, buildDispatchClearedData(verb, id, fences)],
  );
  drainToCompletion(db);
}

const incidentRowsLeft = (
  db: ReturnType<typeof freshMemDb>["db"],
  verb: string,
  id: string,
): number =>
  (
    db
      .query(
        "SELECT COUNT(*) AS n FROM dispatch_failures WHERE verb = ? AND id = ?",
      )
      .get(verb, id) as { n: number }
  ).n;
const pendingRowsLeft = (
  db: ReturnType<typeof freshMemDb>["db"],
  verb: string,
  id: string,
): number =>
  (
    db
      .query(
        "SELECT COUNT(*) AS n FROM pending_dispatches WHERE verb = ? AND id = ?",
      )
      .get(verb, id) as { n: number }
  ).n;
const claimStateOf = (
  db: ReturnType<typeof freshMemDb>["db"],
  verb: string,
  id: string,
): string | null =>
  (
    db
      .query("SELECT state FROM dispatch_claims WHERE verb = ? AND id = ?")
      .get(verb, id) as { state: string } | null
  )?.state ?? null;

test("internalIncidentClearFences: a LIVE matching attempt — the incident row drops but the claim, pending lease, and mint gate ALL survive", () => {
  const { db } = freshMemDb();
  const verb = "close";
  const id = "fn-1-foo";
  const key = `${verb}::${id}`;
  seedArmedLiveAttempt(db, verb, id);

  foldIncidentClear(db, verb, id, "matching");

  // The sticky incident row is gone (its condition resolved this cycle)...
  expect(incidentRowsLeft(db, verb, id)).toBe(0);
  // ...but nothing attempt-owned was touched: a healthy live worker keeps its
  // claim, its pending lease, and its mint gate. No double-dispatch window opens.
  expect(claimStateOf(db, verb, id)).toBe("bound");
  expect(pendingRowsLeft(db, verb, id)).toBe(1);
  expect(readDispatchMintGate(db, key)).toBe(2);
  db.close();
});

test("internalIncidentClearFences: a terminal-proven (gone) attempt — the authorized clear releases claim, pending lease, and mint gate fully", () => {
  const { db } = freshMemDb();
  const verb = "close";
  const id = "fn-1-foo";
  const key = `${verb}::${id}`;
  seedArmedLiveAttempt(db, verb, id);

  foldIncidentClear(db, verb, id, "gone");

  // Positive terminal proof of the bound session admits the attempt fence, so the
  // orphaned attempt's state releases fully alongside the incident row.
  expect(incidentRowsLeft(db, verb, id)).toBe(0);
  expect(claimStateOf(db, verb, id)).toBe("released");
  expect(pendingRowsLeft(db, verb, id)).toBe(0);
  expect(readDispatchMintGate(db, key)).toBeNull();
  db.close();
});

test("internalIncidentClearFences: an inconclusive liveness verdict — no attempt-owned effect (safe over-preservation)", () => {
  const { db } = freshMemDb();
  const verb = "close";
  const id = "fn-1-foo";
  const key = `${verb}::${id}`;
  seedArmedLiveAttempt(db, verb, id);

  foldIncidentClear(db, verb, id, "inconclusive");

  // Uncertain claimant identity refuses the attempt fence exactly like a live one:
  // the incident drops, the attempt survives untouched.
  expect(incidentRowsLeft(db, verb, id)).toBe(0);
  expect(claimStateOf(db, verb, id)).toBe("bound");
  expect(pendingRowsLeft(db, verb, id)).toBe(1);
  expect(readDispatchMintGate(db, key)).toBe(2);
  db.close();
});

test("internalIncidentClearFences: a payload with no attempt fence is already incident-only and NEVER probes", () => {
  // The lazy short-circuit — an attempt-less clear touches no attempt-owned state
  // and must not spend a claimant probe deciding that.
  expect(
    internalIncidentClearFences(
      { expected_attempt_id: null, expected_instance_event_id: 51 },
      PROBE_NEVER,
    ),
  ).toEqual({ expected_attempt_id: null, expected_instance_event_id: 51 });
});

test("a merge-escalation incident clear composes through the incident-only fence: a LIVE matching attempt's sticky drops while its claim, pending lease, and mint gate survive", () => {
  const { db } = freshMemDb();
  const verb = "close";
  const id = "fn-1-foo";
  const key = `${verb}::${id}`;
  // A bare `close::<epic>` MERGE-ESCALATION sticky — the class the reconcile loop's
  // positive-evidence (merged-landed) level-clear targets — armed with a fully-live
  // bound attempt. The clear routes through the SAME emit → handleDispatchClearedMint
  // gate as the recover/lane clears, so a live claimant's attempt-owned state must
  // survive exactly as the generic recover case above.
  db.query(
    `INSERT INTO dispatch_failures
       (verb, id, reason, dir, ts, last_event_id, created_at, updated_at,
        attempt_id, instance_event_id)
     VALUES (?, ?,
       'worktree-merge-conflict: merging keeper/epic/fn-1-foo--fn-1-foo.1 into keeper/epic/fn-1-foo',
       '/repo', 1, ?, 1, 1, ?, ?)`,
  ).run(
    verb,
    id,
    INCIDENT_CLEAR_EVENT_ID,
    INCIDENT_CLEAR_ATTEMPT_ID,
    INCIDENT_CLEAR_EVENT_ID,
  );
  db.query(
    `INSERT INTO dispatch_claims
       (verb, id, attempt_id, state, session_id, acquired_at, bound_at,
        last_event_id, updated_at)
     VALUES (?, ?, ?, 'bound', 'sess-live', 1, 2, ?, 2)`,
  ).run(verb, id, INCIDENT_CLEAR_ATTEMPT_ID, INCIDENT_CLEAR_EVENT_ID);
  db.query(
    `INSERT INTO pending_dispatches
       (verb, id, dir, dispatched_at, last_event_id, attempt_id)
     VALUES (?, ?, '/repo', 2, ?, ?)`,
  ).run(verb, id, INCIDENT_CLEAR_EVENT_ID, INCIDENT_CLEAR_ATTEMPT_ID);
  upsertDispatchMintGate(db, key, 2, INCIDENT_CLEAR_ATTEMPT_ID);

  // The producer names the currently-bound attempt; a LIVE claimant degrades it to an
  // incident-only clear.
  foldIncidentClear(db, verb, id, "matching");

  expect(incidentRowsLeft(db, verb, id)).toBe(0);
  expect(claimStateOf(db, verb, id)).toBe("bound");
  expect(pendingRowsLeft(db, verb, id)).toBe(1);
  expect(readDispatchMintGate(db, key)).toBe(2);
  db.close();
});

test("clearDispatchMintGate: the low-level key-wide helper still removes its target row", () => {
  const { db } = freshMemDb();
  const key = "close::fn-1-foo";
  const t0 = 1_700_000_000_000;

  runDispatchMintGate(db, key, t0, DISPATCH_MINT_GATE_WINDOW_MS, () => {});
  // Production fenced clears use appendFencedDispatchClear; this low-level DB
  // helper remains pinned independently for callers that intentionally own a key.
  clearDispatchMintGate(db, key);
  expect(readDispatchMintGate(db, key)).toBeNull();
  // A subsequent mint inside the old window is no longer suppressed.
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
// Incident claim producer
// ---------------------------------------------------------------------------

type IncidentSpoolEntry = ReturnType<
  IncidentClaimSweepDeps["readRequests"]
>[number];

function incidentSpoolEntry(
  action: "claim" | "release" | "rotate",
  overrides: Partial<IncidentSpoolEntry["request"]> = {},
): IncidentSpoolEntry {
  return {
    path: `/spool/${action}-${overrides.id ?? "fn-3-incident.1"}.json`,
    request: {
      schema_version: 1,
      action,
      verb: "work",
      id: "fn-3-incident.1",
      instance_event_id: 41,
      claimant_session_id: "session-new",
      requested_at: 1_700_000_000_000,
      ...overrides,
    },
  };
}

function incidentSweepDeps(
  overrides: Partial<IncidentClaimSweepDeps> = {},
): IncidentClaimSweepDeps {
  return {
    readRequests: () => [],
    removeRequest: () => {},
    lookupIncident: () => ({
      instanceEventId: 41,
      claimSessionId: null,
      claimPid: null,
      claimStartTime: null,
    }),
    verifyClaimant: () => ({
      pid: 4242,
      startTime: "proc:4242:1",
      live: true,
    }),
    probeClaimantLive: () => true,
    mintClaimed: () => {},
    mintReleased: () => {},
    selectClaimed: () => [],
    now: () => 1_700_000_001,
    ...overrides,
  };
}

test("incident claim sweep mints one claim for a live verified claimant and removes the request", () => {
  const entry = incidentSpoolEntry("claim");
  const removed: string[] = [];
  const minted: unknown[] = [];
  const result = runIncidentClaimSweep(
    incidentSweepDeps({
      readRequests: () => [entry],
      removeRequest: (path) => removed.push(path),
      mintClaimed: (payload) => {
        minted.push(payload);
      },
    }),
  );

  expect(result).toEqual({
    claimed: 1,
    released: 0,
    refused: 0,
    stale: 0,
    expired: 0,
    rotated: 0,
  });
  expect(removed).toEqual([entry.path]);
  expect(minted).toEqual([
    {
      verb: "work",
      id: "fn-3-incident.1",
      instanceEventId: 41,
      claimSessionId: "session-new",
      claimPid: 4242,
      claimStartTime: "proc:4242:1",
      ts: 1_700_000_001,
    },
  ]);
});

test("incident claim sweep refuses dead and unverifiable claimants", () => {
  for (const verification of [
    null,
    { pid: 4242, startTime: "proc:4242:1", live: false },
  ]) {
    const entry = incidentSpoolEntry("claim");
    const removed: string[] = [];
    let mints = 0;
    const result = runIncidentClaimSweep(
      incidentSweepDeps({
        readRequests: () => [entry],
        removeRequest: (path) => removed.push(path),
        verifyClaimant: () => verification,
        mintClaimed: () => {
          mints += 1;
        },
      }),
    );
    expect(result.refused).toBe(1);
    expect(result.claimed).toBe(0);
    expect(mints).toBe(0);
    expect(removed).toEqual([entry.path]);
  }
});

test("incident claim sweep verifies the claimant against the owning verb and id", () => {
  const entry = incidentSpoolEntry("claim");
  const seen: string[][] = [];
  const result = runIncidentClaimSweep(
    incidentSweepDeps({
      readRequests: () => [entry],
      verifyClaimant: (sessionId, verb, id) => {
        seen.push([sessionId, verb, id]);
        return null;
      },
    }),
  );

  expect(result.refused).toBe(1);
  expect(seen).toEqual([["session-new", "work", "fn-3-incident.1"]]);
});

test("incident claim sweep discards missing and mismatched incident fences as stale", () => {
  for (const incident of [
    null,
    {
      instanceEventId: 42,
      claimSessionId: null,
      claimPid: null,
      claimStartTime: null,
    },
  ]) {
    const entry = incidentSpoolEntry("claim");
    const removed: string[] = [];
    let mints = 0;
    const result = runIncidentClaimSweep(
      incidentSweepDeps({
        readRequests: () => [entry],
        removeRequest: (path) => removed.push(path),
        lookupIncident: () => incident,
        mintClaimed: () => {
          mints += 1;
        },
      }),
    );
    expect(result.stale).toBe(1);
    expect(result.claimed).toBe(0);
    expect(mints).toBe(0);
    expect(removed).toEqual([entry.path]);
  }
});

test("incident claim sweep refuses takeover while a different claimant is still live", () => {
  const entry = incidentSpoolEntry("claim");
  let mints = 0;
  const result = runIncidentClaimSweep(
    incidentSweepDeps({
      readRequests: () => [entry],
      lookupIncident: () => ({
        instanceEventId: 41,
        claimSessionId: "session-current",
        claimPid: 3131,
        claimStartTime: "proc:3131:1",
      }),
      probeClaimantLive: () => true,
      mintClaimed: () => {
        mints += 1;
      },
    }),
  );

  expect(result.refused).toBe(1);
  expect(result.claimed).toBe(0);
  expect(mints).toBe(0);
});

test("incident claim sweep permits takeover after positive evidence that the prior claimant died", () => {
  const entry = incidentSpoolEntry("claim");
  const minted: unknown[] = [];
  const result = runIncidentClaimSweep(
    incidentSweepDeps({
      readRequests: () => [entry],
      lookupIncident: () => ({
        instanceEventId: 41,
        claimSessionId: "session-dead",
        claimPid: 3131,
        claimStartTime: "proc:3131:1",
      }),
      probeClaimantLive: (pid) => pid !== 3131,
      mintClaimed: (payload) => {
        minted.push(payload);
      },
    }),
  );

  expect(result.claimed).toBe(1);
  expect(result.refused).toBe(0);
  expect(minted).toHaveLength(1);
});

test("incident claim sweep mints one fenced release and removes the request", () => {
  const entry = incidentSpoolEntry("release", {
    verb: "close",
    id: "fn-3-incident-close",
    claimant_session_id: "session-owner",
  });
  const removed: string[] = [];
  const minted: unknown[] = [];
  const result = runIncidentClaimSweep(
    incidentSweepDeps({
      readRequests: () => [entry],
      removeRequest: (path) => removed.push(path),
      lookupIncident: () => ({
        instanceEventId: 41,
        claimSessionId: "session-owner",
        claimPid: 4242,
        claimStartTime: "proc:4242:1",
      }),
      mintReleased: (payload) => {
        minted.push(payload);
      },
    }),
  );

  expect(result.released).toBe(1);
  expect(removed).toEqual([entry.path]);
  expect(minted).toEqual([
    {
      verb: "close",
      id: "fn-3-incident-close",
      instanceEventId: 41,
      claimSessionId: "session-owner",
      claimPid: 4242,
      claimStartTime: "proc:4242:1",
    },
  ]);
});

test("pending fan-in incident claim and release round-trip keeps the same fence", () => {
  let incident = {
    instanceEventId: 41,
    claimSessionId: null as string | null,
    claimPid: null as number | null,
    claimStartTime: null as string | null,
  };
  const claim = incidentSpoolEntry("claim");
  const claimed = runIncidentClaimSweep(
    incidentSweepDeps({
      readRequests: () => [claim],
      lookupIncident: () => incident,
      mintClaimed: (payload) => {
        incident = {
          instanceEventId: payload.instanceEventId,
          claimSessionId: payload.claimSessionId,
          claimPid: payload.claimPid,
          claimStartTime: payload.claimStartTime,
        };
      },
    }),
  );

  expect(claimed.claimed).toBe(1);
  expect(incident).toEqual({
    instanceEventId: 41,
    claimSessionId: "session-new",
    claimPid: 4242,
    claimStartTime: "proc:4242:1",
  });

  const release = incidentSpoolEntry("release");
  const released = runIncidentClaimSweep(
    incidentSweepDeps({
      readRequests: () => [release],
      lookupIncident: () => incident,
      mintReleased: (payload) => {
        expect(payload.instanceEventId).toBe(41);
        incident = {
          instanceEventId: 41,
          claimSessionId: null,
          claimPid: null,
          claimStartTime: null,
        };
      },
    }),
  );

  expect(released.released).toBe(1);
  expect(incident.claimSessionId).toBeNull();
});

test("incident release refuses a dead or non-owning claimant", () => {
  const entry = incidentSpoolEntry("release", {
    claimant_session_id: "session-owner",
  });
  let mints = 0;
  const result = runIncidentClaimSweep(
    incidentSweepDeps({
      readRequests: () => [entry],
      lookupIncident: () => ({
        instanceEventId: 41,
        claimSessionId: "session-owner",
        claimPid: 4242,
        claimStartTime: "proc:4242:1",
      }),
      verifyClaimant: () => null,
      mintReleased: () => {
        mints += 1;
      },
    }),
  );

  expect(result.refused).toBe(1);
  expect(result.released).toBe(0);
  expect(mints).toBe(0);
});

test("incident claim sweep consumes duplicate claims without growing the event log", () => {
  const entry = incidentSpoolEntry("claim");
  const removed: string[] = [];
  let mints = 0;
  const result = runIncidentClaimSweep(
    incidentSweepDeps({
      readRequests: () => [entry],
      removeRequest: (path) => removed.push(path),
      lookupIncident: () => ({
        instanceEventId: 41,
        claimSessionId: "session-new",
        claimPid: 4242,
        claimStartTime: "proc:4242:1",
      }),
      mintClaimed: () => {
        mints += 1;
      },
    }),
  );

  expect(result.stale).toBe(1);
  expect(result.claimed).toBe(0);
  expect(mints).toBe(0);
  expect(removed).toEqual([entry.path]);
});

test("incident claim sweep coalesces duplicate spooled tuples before projection refresh", () => {
  const first = incidentSpoolEntry("claim");
  const second = {
    ...incidentSpoolEntry("claim"),
    path: "/spool/duplicate.json",
  };
  const removed: string[] = [];
  let mints = 0;
  const result = runIncidentClaimSweep(
    incidentSweepDeps({
      readRequests: () => [first, second],
      removeRequest: (path) => removed.push(path),
      mintClaimed: () => {
        mints += 1;
      },
    }),
  );

  expect(result.claimed).toBe(1);
  expect(result.stale).toBe(1);
  expect(mints).toBe(1);
  expect(removed).toEqual([first.path, second.path]);
});

test("incident claim sweep refreshes a resumed claimant's process generation", () => {
  const entry = incidentSpoolEntry("claim");
  const minted: unknown[] = [];
  const result = runIncidentClaimSweep(
    incidentSweepDeps({
      readRequests: () => [entry],
      lookupIncident: () => ({
        instanceEventId: 41,
        claimSessionId: "session-new",
        claimPid: 3131,
        claimStartTime: "proc:3131:1",
      }),
      mintClaimed: (payload) => {
        minted.push(payload);
      },
    }),
  );

  expect(result.claimed).toBe(1);
  expect(minted).toEqual([
    expect.objectContaining({
      claimSessionId: "session-new",
      claimPid: 4242,
      claimStartTime: "proc:4242:1",
    }),
  ]);
});

test("incident claim sweep preserves requests when the synthetic mint fails", () => {
  const entry = incidentSpoolEntry("claim");
  const removed: string[] = [];
  const result = runIncidentClaimSweep(
    incidentSweepDeps({
      readRequests: () => [entry],
      removeRequest: (path) => removed.push(path),
      mintClaimed: () => false,
    }),
  );

  expect(result.claimed).toBe(0);
  expect(removed).toEqual([]);
});

test("incident claim sweep refuses takeover when the recorded holder generation is unverifiable", () => {
  const entry = incidentSpoolEntry("claim");
  let mints = 0;
  const result = runIncidentClaimSweep(
    incidentSweepDeps({
      readRequests: () => [entry],
      lookupIncident: () => ({
        instanceEventId: 41,
        claimSessionId: "session-current",
        claimPid: null,
        claimStartTime: null,
      }),
      mintClaimed: () => {
        mints += 1;
      },
    }),
  );

  expect(result.refused).toBe(1);
  expect(mints).toBe(0);
});

test("incident claim expiry releases dead claimants and leaves live claimants alone", () => {
  const released: unknown[] = [];
  const result = runIncidentClaimSweep(
    incidentSweepDeps({
      selectClaimed: () => [
        {
          verb: "work",
          id: "fn-4-dead.1",
          instanceEventId: 50,
          claimSessionId: "session-dead",
          claimPid: 5000,
          claimStartTime: "proc:5000:1",
        },
        {
          verb: "close",
          id: "fn-5-live",
          instanceEventId: 60,
          claimSessionId: "session-live",
          claimPid: 6000,
          claimStartTime: "proc:6000:1",
        },
      ],
      probeClaimantLive: (pid) => pid === 6000,
      mintReleased: (payload) => {
        released.push(payload);
      },
    }),
  );

  expect(result.expired).toBe(1);
  expect(released).toEqual([
    {
      verb: "work",
      id: "fn-4-dead.1",
      instanceEventId: 50,
      claimSessionId: "session-dead",
      claimPid: 5000,
      claimStartTime: "proc:5000:1",
    },
  ]);
});

test("incident claim sweep isolates a throwing request and continues processing siblings", () => {
  const broken = incidentSpoolEntry("claim", { id: "fn-6-broken.1" });
  const healthy = incidentSpoolEntry("claim", { id: "fn-7-healthy.1" });
  const removed: string[] = [];
  const minted: string[] = [];
  const results: ReturnType<typeof runIncidentClaimSweep>[] = [];

  expect(() => {
    results.push(
      runIncidentClaimSweep(
        incidentSweepDeps({
          readRequests: () => [broken, healthy],
          removeRequest: (path) => removed.push(path),
          lookupIncident: (_verb, id) => {
            if (id === "fn-6-broken.1") throw new Error("fixture failure");
            return {
              instanceEventId: 41,
              claimSessionId: null,
              claimPid: null,
              claimStartTime: null,
            };
          },
          mintClaimed: (payload) => {
            minted.push(payload.id);
          },
        }),
      ),
    );
  }).not.toThrow();

  expect(results[0]?.claimed).toBe(1);
  expect(minted).toEqual(["fn-7-healthy.1"]);
  expect(removed).toEqual([healthy.path]);
});

test("INCIDENT_CLAIM_SWEEP_INTERVAL_MS is a prompt positive cadence", () => {
  expect(INCIDENT_CLAIM_SWEEP_INTERVAL_MS).toBe(3_000);
  expect(INCIDENT_CLAIM_SWEEP_INTERVAL_MS).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Incident escalation grants — publish-on-claim, staged resolve→deconflict
// rotation, expire-on-release, and the resolved positive-evidence clear.
// ---------------------------------------------------------------------------

function withGrantsDir(body: (grantsDir: string, root: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "keeper-incident-grant-"));
  try {
    // `root` is the incident's own lane/checkout; canonicalize it so it matches
    // the writable_root `writeGrantLeaf` publishes (which realpaths its input).
    body(join(dir, "grants"), realpathSync(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function incidentGrantDepsFor(
  grantsDir: string,
  root: string,
  now: () => number,
): IncidentGrantDeps {
  return { grantsDir, rowFacts: () => ({ dir: root, attemptId: "7" }), now };
}

test("buildIncidentGrant pins the resolve tuple to the incident's own lane and the grant guard authorizes only that lane", () => {
  withGrantsDir((grantsDir, root) => {
    const grant = buildIncidentGrant("resolve", {
      verb: "work",
      id: "fn-9-fan.2",
      instanceEventId: 55,
      parentJobId: "sess-owner",
      writableRoot: root,
      attemptId: "13",
      fencingToken: 4,
      nowMs: 1_000,
    });
    expect(grant).toMatchObject({
      schema_version: 1,
      parent_job_id: "sess-owner",
      agent_type: INCIDENT_RESOLVE_AGENT_TYPE,
      incident_id: "work::fn-9-fan.2",
      attempt_id: "13",
      instance_event_id: 55,
      writable_root: root,
      role: "resolve",
      fencing_token: 4,
    });
    expect(grant.expires_at).toBe(1_000 + INCIDENT_GRANT_TTL_MS);

    // Guard-validate the tuple through the grant-leaf seam: the in-session
    // merge-resolver env (KEEPER_JOB_ID = the claiming session) may write inside
    // the lane, but never outside it, on a protected path, or past the TTL.
    expect(writeGrantLeaf(grantsDir, grant)).toBe(true);
    const env = { KEEPER_GRANT_DIR: grantsDir, KEEPER_JOB_ID: "sess-owner" };
    expect(
      grantCoversWrite(
        env,
        INCIDENT_RESOLVE_AGENT_TYPE,
        join(root, "src/x.ts"),
        2_000,
      ),
    ).toBe(true);
    expect(
      grantCoversWrite(
        env,
        INCIDENT_RESOLVE_AGENT_TYPE,
        "/elsewhere/x.ts",
        2_000,
      ),
    ).toBe(false);
    expect(
      grantCoversWrite(
        env,
        INCIDENT_RESOLVE_AGENT_TYPE,
        join(root, ".git/config"),
        2_000,
      ),
    ).toBe(false);
    expect(
      grantCoversWrite(
        env,
        INCIDENT_RESOLVE_AGENT_TYPE,
        join(root, "src/x.ts"),
        grant.expires_at + 1,
      ),
    ).toBe(false);
  });
});

test("a live owner's DUPLICATE claim is an idempotent no-op and NEVER rotates the grant", () => {
  const entry = incidentSpoolEntry("claim", {
    claimant_session_id: "session-owner",
  });
  let rotations = 0;
  let mints = 0;
  const result = runIncidentClaimSweep(
    incidentSweepDeps({
      readRequests: () => [entry],
      // The incident is already held by THIS live claimant at THIS generation — a
      // duplicate claim delivery / CLI retry, consumed idempotently. An ordinary
      // claim is NEVER the decline-receipt transport, so the grant never rotates.
      lookupIncident: () => ({
        instanceEventId: 41,
        claimSessionId: "session-owner",
        claimPid: 4242,
        claimStartTime: "proc:4242:1",
      }),
      mintClaimed: () => {
        mints += 1;
      },
      rotateGrant: () => {
        rotations += 1;
        return "rotated";
      },
    }),
  );
  expect(mints).toBe(0);
  expect(rotations).toBe(0);
  expect(result.stale).toBe(1);
  expect(result.rotated).toBe(0);
});

test("an explicit rotate request routes to the grant-rotation seam, fenced to the live owner, with no claim event", () => {
  const entry = incidentSpoolEntry("rotate", {
    claimant_session_id: "session-owner",
  });
  const rotated: Array<[string, string, number, string]> = [];
  let mints = 0;
  const result = runIncidentClaimSweep(
    incidentSweepDeps({
      readRequests: () => [entry],
      // The incident is held by THIS live owner — the validated decline receipt.
      lookupIncident: () => ({
        instanceEventId: 41,
        claimSessionId: "session-owner",
        claimPid: 4242,
        claimStartTime: "proc:4242:1",
      }),
      mintClaimed: () => {
        mints += 1;
      },
      rotateGrant: (verb, id, instanceEventId, claimSessionId) => {
        rotated.push([verb, id, instanceEventId, claimSessionId]);
        return "rotated";
      },
    }),
  );
  expect(mints).toBe(0);
  expect(result.rotated).toBe(1);
  expect(rotated).toEqual([["work", "fn-3-incident.1", 41, "session-owner"]]);
});

test("a rotation that returns retry leaves the request spooled and is not counted as rotated", () => {
  const entry = incidentSpoolEntry("rotate", {
    claimant_session_id: "session-owner",
  });
  const removed: string[] = [];
  let attempts = 0;
  const result = runIncidentClaimSweep(
    incidentSweepDeps({
      readRequests: () => [entry],
      removeRequest: (path) => removed.push(path),
      lookupIncident: () => ({
        instanceEventId: 41,
        claimSessionId: "session-owner",
        claimPid: 4242,
        claimStartTime: "proc:4242:1",
      }),
      // A failed retirement/publish — the rotation could not complete this pass.
      rotateGrant: () => {
        attempts += 1;
        return "retry";
      },
    }),
  );
  expect(attempts).toBe(1);
  // The request stays spooled (never removed) so recovery does not wait for a
  // fresh explicit intent, and it is not counted a rotation.
  expect(removed).toEqual([]);
  expect(result.rotated).toBe(0);
});

test("a rotation that returns no-target consumes the request without counting a rotation retry", () => {
  const entry = incidentSpoolEntry("rotate", {
    claimant_session_id: "session-owner",
  });
  const removed: string[] = [];
  const result = runIncidentClaimSweep(
    incidentSweepDeps({
      readRequests: () => [entry],
      removeRequest: (path) => removed.push(path),
      lookupIncident: () => ({
        instanceEventId: 41,
        claimSessionId: "session-owner",
        claimPid: 4242,
        claimStartTime: "proc:4242:1",
      }),
      // Nothing to grant against — a re-intent would find the same absence, so
      // the request is consumed rather than retried forever.
      rotateGrant: () => "no-target",
    }),
  );
  expect(removed).toEqual([entry.path]);
  expect(result.rotated).toBe(1);
});

test("a rotate request from a session that is NOT the current holder is stale and never rotates", () => {
  const entry = incidentSpoolEntry("rotate", {
    claimant_session_id: "session-owner",
  });
  let rotations = 0;
  const result = runIncidentClaimSweep(
    incidentSweepDeps({
      readRequests: () => [entry],
      // The incident is held by a DIFFERENT session, so this owner cannot rotate it.
      lookupIncident: () => ({
        instanceEventId: 41,
        claimSessionId: "session-other",
        claimPid: 4242,
        claimStartTime: "proc:4242:1",
      }),
      rotateGrant: () => {
        rotations += 1;
        return "rotated";
      },
    }),
  );
  expect(rotations).toBe(0);
  expect(result.rotated).toBe(0);
  expect(result.stale).toBe(1);
});

test("a stale-fenced rotate publishes no grant: the rotation seam never fires", () => {
  const entry = incidentSpoolEntry("rotate", {
    claimant_session_id: "session-owner",
  });
  let rotations = 0;
  const result = runIncidentClaimSweep(
    incidentSweepDeps({
      readRequests: () => [entry],
      // The live incident carries a DIFFERENT instance than the request's fence.
      lookupIncident: () => ({
        instanceEventId: 999,
        claimSessionId: "session-owner",
        claimPid: 4242,
        claimStartTime: "proc:4242:1",
      }),
      rotateGrant: () => {
        rotations += 1;
        return "rotated";
      },
    }),
  );
  expect(result.stale).toBe(1);
  expect(result.rotated).toBe(0);
  expect(rotations).toBe(0);
});

test("incident grant publish then rotate: resolve retired, deconflict published, never two live", () => {
  withGrantsDir((grantsDir, root) => {
    let now = 10_000;
    const deps = incidentGrantDepsFor(grantsDir, root, () => now);
    publishIncidentResolveGrant(deps, "close", "fn-2-x", 88, "sess-c");

    const liveFor = (t: number) =>
      listGrantLeaves(grantsDir).filter(
        (l) =>
          l.incident_id === "close::fn-2-x" &&
          l.instance_event_id === 88 &&
          t < l.expires_at,
      );
    const stage1 = liveFor(now);
    expect(stage1).toHaveLength(1);
    expect(stage1[0]?.role).toBe("resolve");
    expect(stage1[0]?.agent_type).toBe(INCIDENT_RESOLVE_AGENT_TYPE);
    expect(stage1[0]?.writable_root).toBe(root);

    now += 1;
    expect(
      rotateIncidentGrantToDeconflict(deps, "close", "fn-2-x", 88, "sess-c"),
    ).toBe("rotated");
    const stage2 = liveFor(now);
    expect(stage2).toHaveLength(1);
    expect(stage2[0]?.role).toBe("deconflict");
    expect(stage2[0]?.agent_type).toBe(INCIDENT_DECONFLICT_AGENT_TYPE);
    expect(stage2[0]?.writable_root).toBe(root);

    // The resolve leaf is retired (expired), so the brief's SINGULAR advertiser
    // never sees two live leaves for the incident.
    const resolveLeaf = readGrantLeaf(
      grantsDir,
      {
        parentJobId: "sess-c",
        agentType: INCIDENT_RESOLVE_AGENT_TYPE,
        incidentId: "close::fn-2-x",
        fencingToken: stage1[0]?.fencing_token ?? 0,
      },
      now,
    );
    expect(resolveLeaf.kind).toBe("expired");
    expect(stage2[0]?.fencing_token ?? 0).toBeGreaterThan(
      stage1[0]?.fencing_token ?? 0,
    );
  });
});

test("rotateIncidentGrantToDeconflict returns no-target when there is no merge-escalation row", () => {
  withGrantsDir((grantsDir) => {
    let now = 10_000;
    const deps: IncidentGrantDeps = {
      grantsDir,
      // No merge-escalation row/dir to grant against.
      rowFacts: () => null,
      now: () => now,
    };
    publishIncidentResolveGrant(deps, "close", "fn-6-nt", 5, "sess-nt");
    now += 1;
    expect(
      rotateIncidentGrantToDeconflict(deps, "close", "fn-6-nt", 5, "sess-nt"),
    ).toBe("no-target");
  });
});

test("rotateIncidentGrantToDeconflict returns retry when the deconflict publish fails", () => {
  withGrantsDir((grantsDir, root) => {
    let now = 10_000;
    // A live resolve leaf whose retire confirms, but the deconflict publish fails:
    // the transition could not complete, so the request must stay retryable.
    const realDeps = incidentGrantDepsFor(grantsDir, root, () => now);
    publishIncidentResolveGrant(realDeps, "close", "fn-7-rt", 9, "sess-rt");
    now += 1;
    let calls = 0;
    const failingPublish: IncidentGrantDeps = {
      ...realDeps,
      now: () => now,
      // Retire (first calls) confirm true; the deconflict publish (last call) fails.
      writeLeaf: (dir, leaf) => {
        calls += 1;
        return leaf.role === "deconflict" ? false : writeGrantLeaf(dir, leaf);
      },
    };
    expect(
      rotateIncidentGrantToDeconflict(
        failingPublish,
        "close",
        "fn-7-rt",
        9,
        "sess-rt",
      ),
    ).toBe("retry");
    expect(calls).toBeGreaterThan(0);
  });
});

test("incident grant rotation is idempotent — a second rotate keeps one live deconflict leaf", () => {
  withGrantsDir((grantsDir, root) => {
    let now = 500;
    const deps = incidentGrantDepsFor(grantsDir, root, () => now);
    publishIncidentResolveGrant(deps, "work", "fn-4-y.1", 12, "sess-w");
    now += 1;
    rotateIncidentGrantToDeconflict(deps, "work", "fn-4-y.1", 12, "sess-w");
    const firstToken =
      listGrantLeaves(grantsDir).find((l) => l.role === "deconflict")
        ?.fencing_token ?? -1;
    expect(firstToken).toBeGreaterThan(0);
    now += 1;
    rotateIncidentGrantToDeconflict(deps, "work", "fn-4-y.1", 12, "sess-w");
    const live = listGrantLeaves(grantsDir).filter(
      (l) => l.incident_id === "work::fn-4-y.1" && now < l.expires_at,
    );
    expect(live).toHaveLength(1);
    expect(live[0]?.role).toBe("deconflict");
    expect(live[0]?.fencing_token).toBe(firstToken);
  });
});

test("expireIncidentGrants retires every leg for the incident on release", () => {
  withGrantsDir((grantsDir, root) => {
    let now = 1_000;
    const deps = incidentGrantDepsFor(grantsDir, root, () => now);
    publishIncidentResolveGrant(deps, "close", "fn-5-z", 3, "sess-z");
    now += 1;
    rotateIncidentGrantToDeconflict(deps, "close", "fn-5-z", 3, "sess-z");
    now += 1;
    expireIncidentGrants(deps, "close", "fn-5-z", "sess-z");
    const live = listGrantLeaves(grantsDir).filter(
      (l) => l.incident_id === "close::fn-5-z" && now < l.expires_at,
    );
    expect(live).toHaveLength(0);
  });
});

test("rotate with a FAILING retire leaves resolve-only: deconflict is NOT published and one bounded reason line is emitted", () => {
  withGrantsDir((grantsDir, root) => {
    let now = 2_000;
    const base = incidentGrantDepsFor(grantsDir, root, () => now);
    publishIncidentResolveGrant(base, "close", "fn-8-r", 21, "sess-r");
    const liveResolve = () =>
      listGrantLeaves(grantsDir).filter(
        (l) => l.role === "resolve" && now < l.expires_at,
      );
    expect(liveResolve()).toHaveLength(1);

    now += 1;
    const notes: string[] = [];
    // Force the retire write to return false WITHOUT persisting — the positive-
    // retirement invariant must NOT proceed to publish deconflict while a live
    // resolve leaf remains un-retired (else the brief's singular advertiser breaks).
    rotateIncidentGrantToDeconflict(
      { ...base, writeLeaf: () => false, noteLine: (l) => notes.push(l) },
      "close",
      "fn-8-r",
      21,
      "sess-r",
    );
    expect(
      listGrantLeaves(grantsDir).some(
        (l) => l.role === "deconflict" && now < l.expires_at,
      ),
    ).toBe(false);
    expect(liveResolve()).toHaveLength(1);
    expect(
      notes.some((n) => n.includes("could not retire the live resolve leaf")),
    ).toBe(true);

    // A later fenced rotation intent (real writer) retries and completes.
    now += 1;
    rotateIncidentGrantToDeconflict(base, "close", "fn-8-r", 21, "sess-r");
    const live = listGrantLeaves(grantsDir).filter(
      (l) => l.incident_id === "close::fn-8-r" && now < l.expires_at,
    );
    expect(live).toHaveLength(1);
    expect(live[0]?.role).toBe("deconflict");
  });
});

test("rotate with NO live resolve leaf publishes deconflict directly — the fenced intent is authority", () => {
  withGrantsDir((grantsDir, root) => {
    const now = 3_000;
    const deps = incidentGrantDepsFor(grantsDir, root, () => now);
    // No resolve leaf was ever published (or it already expired). An explicit
    // rotation intent still transitions straight to deconflict.
    rotateIncidentGrantToDeconflict(deps, "work", "fn-9-r.2", 33, "sess-x");
    const live = listGrantLeaves(grantsDir).filter(
      (l) => l.incident_id === "work::fn-9-r.2" && now < l.expires_at,
    );
    expect(live).toHaveLength(1);
    expect(live[0]?.role).toBe("deconflict");
  });
});

test("a duplicate rotate request in one sweep fires the rotation seam exactly once", () => {
  const a = incidentSpoolEntry("rotate", {
    claimant_session_id: "session-owner",
  });
  const b = incidentSpoolEntry("rotate", {
    claimant_session_id: "session-owner",
  });
  // Distinct spool files, byte-identical request content — an idempotent redelivery.
  b.path = "/spool/rotate-dup.json";
  let rotations = 0;
  const result = runIncidentClaimSweep(
    incidentSweepDeps({
      readRequests: () => [a, b],
      lookupIncident: () => ({
        instanceEventId: 41,
        claimSessionId: "session-owner",
        claimPid: 4242,
        claimStartTime: "proc:4242:1",
      }),
      rotateGrant: () => {
        rotations += 1;
        return "rotated";
      },
    }),
  );
  expect(rotations).toBe(1);
  expect(result.rotated).toBe(1);
  expect(result.stale).toBe(1);
});

test("incident grant publish leaves a sibling repair leaf untouched and publishes nothing without a merge row", () => {
  withGrantsDir((grantsDir, root) => {
    const repairLeaf: GrantLeaf = {
      schema_version: 1,
      parent_job_id: "sess-owner",
      agent_type: "plan:repairer",
      incident_id: "repair::keeper-abcdef",
      owner_task_id: "fn-6-r.1",
      attempt_id: "0:fp",
      instance_event_id: 9,
      writable_root: root,
      role: "repair",
      expires_at: 9_999_999_999,
      fencing_token: 2,
    };
    expect(writeGrantLeaf(grantsDir, repairLeaf)).toBe(true);
    const notes: string[] = [];
    publishIncidentResolveGrant(
      {
        grantsDir,
        rowFacts: () => null,
        now: () => 1,
        noteLine: (l) => notes.push(l),
      },
      "work",
      "fn-6-r.1",
      41,
      "sess-owner",
    );
    const leaves = listGrantLeaves(grantsDir);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.role).toBe("repair");
    expect(leaves[0]?.fencing_token).toBe(2);
    expect(notes.some((n) => n.includes("no-publisher-for-class"))).toBe(true);
  });
});

test("the pending-owner-integration fan-in reason is the same merge-escalation class that receives a grant", () => {
  const reason = `${MERGE_ESCALATION_REASON_TOKEN}: merging keeper/epic/fn-7--fn-7.1 into keeper/epic/fn-7 — pending owner integration`;
  expect(isMergeEscalationReason(reason)).toBe(true);
  // The deconflict-brief advertiser derives the grant leaf path from parent +
  // agent type; the resolve leg's path never collides with the deconflict leg's.
  expect(
    deriveGrantLeafPath("/g", "sess", INCIDENT_RESOLVE_AGENT_TYPE),
  ).not.toBe(deriveGrantLeafPath("/g", "sess", INCIDENT_DECONFLICT_AGENT_TYPE));
});

// ---------------------------------------------------------------------------
// Trunk-integration lease producer
// ---------------------------------------------------------------------------

function trunkRequest(
  action: "acquire" | "release",
  repoRoot: string,
  token: number | null = null,
): SpooledTrunkLeaseRequest {
  return {
    path: `/spool/${action}-${repoRoot.slice(1)}.json`,
    request: {
      schema_version: TRUNK_LEASE_REQUEST_SCHEMA_VERSION,
      action,
      epic_id: "fn-1350-owner",
      repo_root: repoRoot,
      source_branch: "keeper/epic/fn-1350-owner",
      claimant_session_id: "close-session",
      request_id: "11111111111111111111111111111111",
      fencing_token: token,
      requested_at: 1_700_000_000_000,
    },
  };
}

function trunkLeaseSweepHarness(initialRequests: SpooledTrunkLeaseRequest[]) {
  const requests = [...initialRequests];
  const leases = new Map<string, TrunkLeaseLeaf>();
  const removed: string[] = [];
  const residues: Array<{ repo: string; detail: string }> = [];
  const deps: TrunkLeaseSweepDeps = {
    readRequests: () => [...requests],
    removeRequest: (path) => {
      removed.push(path);
      const index = requests.findIndex((entry) => entry.path === path);
      if (index >= 0) requests.splice(index, 1);
    },
    readLeases: () => [...leases.values()],
    readLease: (repoRoot) => leases.get(repoRoot) ?? null,
    verifyClaimant: () => ({
      pid: 4242,
      startTime: "proc:4242:1",
      live: true,
    }),
    probeClaimantLive: () => true,
    observeRepo: (request) => ({
      repoRoot: request.repo_root,
      defaultBranch: "main",
      defaultTip:
        request.repo_root === "/repo-a"
          ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }),
    publishLease: (leaf) => {
      leases.set(leaf.repo_root, { ...leaf });
      return true;
    },
    probeResidue: () => null,
    recordResidue: (leaf, detail) =>
      residues.push({ repo: leaf.repo_root, detail }),
    now: () => 1_700_000_001_000,
    ttlMs: 60_000,
    residueState: new Map(),
  };
  return { requests, leases, removed, residues, deps };
}

test("trunk lease round-trip preserves per-repo monotonic fencing tokens", () => {
  const h = trunkLeaseSweepHarness([trunkRequest("acquire", "/repo-a")]);
  expect(runTrunkLeaseSweep(h.deps).acquired).toBe(1);
  const first = h.leases.get("/repo-a");
  expect(first).toMatchObject({
    schema_version: TRUNK_LEASE_SCHEMA_VERSION,
    active: true,
    fencing_token: 1,
    writable_root: "/repo-a",
    observed_default_tip: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });

  h.requests.push(trunkRequest("release", "/repo-a", 1));
  expect(runTrunkLeaseSweep(h.deps).released).toBe(1);
  expect(h.leases.get("/repo-a")?.active).toBe(false);

  h.requests.push(trunkRequest("acquire", "/repo-a"));
  expect(runTrunkLeaseSweep(h.deps).acquired).toBe(1);
  expect(h.leases.get("/repo-a")?.fencing_token).toBe(2);
});

test("trunk leases fence multi-repo groups independently", () => {
  const h = trunkLeaseSweepHarness([
    trunkRequest("acquire", "/repo-a"),
    trunkRequest("acquire", "/repo-b"),
  ]);
  expect(runTrunkLeaseSweep(h.deps).acquired).toBe(2);
  expect(h.leases.get("/repo-a")?.fencing_token).toBe(1);
  expect(h.leases.get("/repo-b")?.fencing_token).toBe(2);
  expect(h.leases.get("/repo-a")?.fencing_token).not.toBe(
    h.leases.get("/repo-b")?.fencing_token,
  );
  expect(h.leases.get("/repo-a")?.observed_default_tip).not.toBe(
    h.leases.get("/repo-b")?.observed_default_tip,
  );
});

test("trunk integration fence defers inconclusive ancestry and tip drift", () => {
  expect(
    decideTrunkIntegrationFence({
      leaseValid: true,
      ancestry: "inconclusive",
      observedDefaultTip: "aaaaaaaa",
      liveDefaultTip: "aaaaaaaa",
    }),
  ).toEqual({ kind: "defer", reason: "ancestry-inconclusive" });
  expect(
    decideTrunkIntegrationFence({
      leaseValid: true,
      ancestry: "not-ancestor",
      observedDefaultTip: "aaaaaaaa",
      liveDefaultTip: "bbbbbbbb",
    }),
  ).toEqual({ kind: "defer", reason: "tip-drift" });
  expect(
    decideTrunkIntegrationFence({
      leaseValid: true,
      ancestry: "not-ancestor",
      observedDefaultTip: "aaaaaaaa",
      liveDefaultTip: "aaaaaaaa",
    }),
  ).toEqual({ kind: "merge" });
});

test("an expired live trunk lease remains authoritative and renews through a fresh fencing token", () => {
  const h = trunkLeaseSweepHarness([trunkRequest("acquire", "/repo-a")]);
  runTrunkLeaseSweep(h.deps);
  const first = h.leases.get("/repo-a");
  if (first === undefined) throw new Error("expected acquired lease");
  h.leases.set("/repo-a", { ...first, expires_at: 1 });

  const expired = runTrunkLeaseSweep(h.deps);
  expect(expired).toMatchObject({ dead: 0, released: 0 });
  expect(h.leases.get("/repo-a")).toMatchObject({
    active: true,
    fencing_token: 1,
    expires_at: 1,
  });

  h.requests.push(trunkRequest("acquire", "/repo-a"));
  expect(runTrunkLeaseSweep(h.deps).acquired).toBe(1);
  expect(h.leases.get("/repo-a")).toMatchObject({
    active: true,
    fencing_token: 2,
    expires_at: 1_700_000_061_000,
  });
});

test("an expired live holder cannot be replaced by another claimant", () => {
  const h = trunkLeaseSweepHarness([trunkRequest("acquire", "/repo-a")]);
  runTrunkLeaseSweep(h.deps);
  const first = h.leases.get("/repo-a");
  if (first === undefined) throw new Error("expected acquired lease");
  h.leases.set("/repo-a", { ...first, expires_at: 1 });
  const rival = trunkRequest("acquire", "/repo-a");
  rival.request.claimant_session_id = "rival-close-session";
  h.requests.push(rival);

  const result = runTrunkLeaseSweep(h.deps);
  expect(result.deferred).toBe(1);
  expect(h.leases.get("/repo-a")).toMatchObject({
    active: true,
    claimant_session_id: "close-session",
    fencing_token: 1,
  });
});

test("a live trunk owner retains its lease while merge residue becomes an incident", () => {
  const h = trunkLeaseSweepHarness([trunkRequest("acquire", "/repo-a")]);
  runTrunkLeaseSweep(h.deps);
  h.deps.probeResidue = () => "MERGE_HEAD=feedface";

  const result = runTrunkLeaseSweep(h.deps);
  expect(result).toMatchObject({ residues: 1, dead: 0, released: 0 });
  expect(h.leases.get("/repo-a")).toMatchObject({
    active: true,
    fencing_token: 1,
  });
  expect(h.residues).toEqual([
    { repo: "/repo-a", detail: "MERGE_HEAD=feedface" },
  ]);
});

test("a persisting merge residue mints exactly once across successive sweep ticks", () => {
  const h = trunkLeaseSweepHarness([trunkRequest("acquire", "/repo-a")]);
  runTrunkLeaseSweep(h.deps);
  h.deps.probeResidue = () => "MERGE_HEAD=feedface";

  const first = runTrunkLeaseSweep(h.deps);
  expect(first.residues).toBe(1);
  expect(h.residues).toEqual([
    { repo: "/repo-a", detail: "MERGE_HEAD=feedface" },
  ]);

  const second = runTrunkLeaseSweep(h.deps);
  const third = runTrunkLeaseSweep(h.deps);
  expect(second.residues).toBe(0);
  expect(third.residues).toBe(0);
  expect(h.residues).toEqual([
    { repo: "/repo-a", detail: "MERGE_HEAD=feedface" },
  ]);

  h.deps.probeResidue = () => null;
  runTrunkLeaseSweep(h.deps);
  h.deps.probeResidue = () => "MERGE_HEAD=feedface";
  const reappeared = runTrunkLeaseSweep(h.deps);
  expect(reappeared.residues).toBe(1);
  expect(h.residues).toEqual([
    { repo: "/repo-a", detail: "MERGE_HEAD=feedface" },
    { repo: "/repo-a", detail: "MERGE_HEAD=feedface" },
  ]);
});

test("dead trunk lease holder releases and records merge residue", () => {
  const h = trunkLeaseSweepHarness([trunkRequest("acquire", "/repo-a")]);
  runTrunkLeaseSweep(h.deps);
  h.deps.probeClaimantLive = () => false;
  h.deps.probeResidue = () => "MERGE_HEAD=deadbeef";

  const result = runTrunkLeaseSweep(h.deps);
  expect(result.dead).toBe(1);
  expect(result.residues).toBe(1);
  expect(h.leases.get("/repo-a")?.active).toBe(false);
  expect(h.residues).toEqual([
    { repo: "/repo-a", detail: "MERGE_HEAD=deadbeef" },
  ]);
});

test("fenced release with residue routes one conflict receipt and stale release cannot clear a successor", () => {
  const h = trunkLeaseSweepHarness([trunkRequest("acquire", "/repo-a")]);
  runTrunkLeaseSweep(h.deps);
  h.deps.probeResidue = () => "MERGE_HEAD=cafebabe";
  h.requests.push(trunkRequest("release", "/repo-a", 1));
  const released = runTrunkLeaseSweep(h.deps);
  expect(released).toMatchObject({ released: 1, residues: 1 });

  h.requests.push(trunkRequest("acquire", "/repo-a"));
  runTrunkLeaseSweep(h.deps);
  expect(h.leases.get("/repo-a")?.fencing_token).toBe(2);
  h.requests.push(trunkRequest("release", "/repo-a", 1));
  const stale = runTrunkLeaseSweep(h.deps);
  expect(stale.stale).toBe(1);
  expect(h.leases.get("/repo-a")).toMatchObject({
    active: true,
    fencing_token: 2,
  });
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
    model?: string | null;
    tier?: string | null;
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
  _epicId: string,
  taskId: string,
  status = "pending",
  outcome: string | null = null,
  ownerRedispatchAttempts = 0,
): void {
  // A block incident is the `dispatch_failures` `verb='block'` subset, keyed on the
  // task id (`id`); the epic id is derived from its prefix by the reader. The block-arm
  // fold sets `instance_event_id = blocked_since = event.id`; mirror that here (both 1).
  db.run(
    `INSERT INTO dispatch_failures (verb, id, reason, ts, last_event_id, created_at, updated_at, instance_event_id, blocked_since, block_status, block_outcome, owner_redispatch_attempts)
       VALUES ('block', ?, 'block-incident', 1, 1, 1, 1, 1, 1, ?, ?, ?)`,
    [taskId, status, outcome, ownerRedispatchAttempts],
  );
}

test("selectPendingBlockEscalations: joins pending latch to epic project_dir + embedded task runtime_status/target_repo", () => {
  const { db } = freshMemDb();
  seedEpicWithTasks(db, "fn-1-foo", "/proj/foo", [
    {
      task_id: "fn-1-foo.1",
      runtime_status: "blocked",
      target_repo: "/repo/x",
      model: "opus",
      tier: "xhigh",
    },
    { task_id: "fn-1-foo.2", runtime_status: "todo", target_repo: null },
  ]);
  seedBlockLatch(db, "fn-1-foo", "fn-1-foo.1");
  // An attempted latch without the re-armable category outcome is NOT returned.
  seedBlockLatch(db, "fn-1-foo", "fn-1-foo.2", "attempted");

  const rows = selectPendingBlockEscalations(db);
  expect(rows.length).toBe(1);
  expect(rows[0]).toEqual({
    epic_id: "fn-1-foo",
    task_id: "fn-1-foo.1",
    status: "pending",
    outcome: null,
    owner_redispatch_attempts: 0,
    updated_at: 1,
    instance_event_id: 1,
    project_dir: "/proj/foo",
    runtime_status: "blocked",
    target_repo: "/repo/x",
    model: "opus",
    tier: "xhigh",
  });
  db.close();
});

test("selectPendingBlockEscalations: attempted skipped_category remains eligible, other terminals do not", () => {
  const { db } = freshMemDb();
  seedEpicWithTasks(db, "fn-1-rearm", "/proj/rearm", [
    { task_id: "fn-1-rearm.1", runtime_status: "blocked" },
    { task_id: "fn-1-rearm.2", runtime_status: "blocked" },
  ]);
  seedBlockLatch(
    db,
    "fn-1-rearm",
    "fn-1-rearm.1",
    "attempted",
    "skipped_category",
  );
  seedBlockLatch(db, "fn-1-rearm", "fn-1-rearm.2", "attempted", "dispatched");

  expect(selectPendingBlockEscalations(db)).toEqual([
    {
      epic_id: "fn-1-rearm",
      task_id: "fn-1-rearm.1",
      status: "attempted",
      outcome: "skipped_category",
      owner_redispatch_attempts: 0,
      updated_at: 1,
      instance_event_id: 1,
      project_dir: "/proj/rearm",
      runtime_status: "blocked",
      target_repo: null,
      model: null,
      tier: null,
    },
  ]);
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
    status: "pending",
    outcome: null,
    owner_redispatch_attempts: 0,
    updated_at: 1,
    instance_event_id: 1,
    project_dir: null,
    runtime_status: null,
    target_repo: null,
    model: null,
    tier: null,
  });
  const missingEl = rows.find((r) => r.task_id === "fn-3-bar.1");
  expect(missingEl).toEqual({
    epic_id: "fn-3-bar",
    task_id: "fn-3-bar.1",
    status: "pending",
    outcome: null,
    owner_redispatch_attempts: 0,
    updated_at: 1,
    instance_event_id: 1,
    project_dir: "/proj/bar",
    runtime_status: null,
    target_repo: null,
    model: null,
    tier: null,
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

/** One FRESH blocked pending row (zero owner-redispatch attempts consumed) — the
 * bounded owner-fenced ladder's starting rung. Exhaustion/ladder-progression tests
 * override `owner_redispatch_attempts` explicitly. */
function blockedRow(
  epicId: string,
  taskId: string,
  overrides: Partial<PendingBlockEscalation> = {},
): PendingBlockEscalation {
  return {
    epic_id: epicId,
    task_id: taskId,
    status: "pending",
    outcome: null,
    owner_redispatch_attempts: 0,
    // Block-arrival anchor for the EXTERNAL_BLOCKED re-check cadence; ignored by every
    // other category. Zero = "blocked at epoch", so an external fixture with the default
    // `nowMs` reads the cadence as elapsed unless a test overrides one of the two.
    updated_at: 0,
    // The block instance token threaded through every mint's fence.
    instance_event_id: 1000,
    project_dir: "/proj",
    runtime_status: "blocked",
    target_repo: null,
    model: null,
    tier: null,
    ...overrides,
  };
}

/** Build injectable deps over a synthetic pending set + a reason map + a dispatch
 *  stub, recording every mint + dispatch call for assertion. The `dispatches`
 *  array is retained (always empty) for tests pinning the no-legacy-unblock-arm
 *  invariant — `runBlockEscalationSweep` only ever calls `dispatchOwner` now. */
function fakeSweepDeps(opts: {
  pending: PendingBlockEscalation[];
  reasons?: Record<string, string | null>;
  /** Task ids whose `work::<id>` already has an open `dispatch_failures` row —
   *  drives the once-only guard for the durable re-dispatch suppression. */
  alreadyFailed?: Set<string>;
  /** Epic ids for which an `unblock::<task>` session is already LIVE — drives the
   *  per-epic serialization (across-sweep) guard. */
  epicLive?: Set<string>;
  /** Owning-work liveness keyed by task id — drives the ordinary attachment gate.
   *  A task with no entry reads witnessed-dead past grace for legacy-path fixtures. */
  owner?: Record<string, BlockOwnerLiveness>;
  /** Optional dynamic owner probe for dispatch-boundary race fixtures. */
  ownerProbe?: (row: PendingBlockEscalation) => BlockOwnerLiveness;
  /** Owning-orchestrator liveness keyed by task id — drives the AUDIT_READY gate.
   *  A task with no entry reads `absent`. */
  orchestrator?: Record<string, AuditOrchestratorLiveness>;
  /** Fixed wall-clock (ms) for both owner-death grace comparisons. */
  nowMs?: number;
  dispatchOwner?: (
    row: PendingBlockEscalation,
  ) => Promise<EscalationDispatchOutcome>;
}): {
  deps: BlockEscalationSweepDeps;
  mints: MintCall[];
  mintInstances: (number | null)[];
  dispatches: { epicId: string; taskId: string }[];
  ownerDispatches: { epicId: string; taskId: string }[];
  suppressions: { taskId: string; reason: string; dir: string | null }[];
  notes: string[];
} {
  const mints: MintCall[] = [];
  // Every mint's threaded instance token (both Requested and Attempted), captured apart
  // from `MintCall` so existing exact-match assertions stay untouched.
  const mintInstances: (number | null)[] = [];
  const dispatches: { epicId: string; taskId: string }[] = [];
  const ownerDispatches: { epicId: string; taskId: string }[] = [];
  const suppressions: { taskId: string; reason: string; dir: string | null }[] =
    [];
  const notes: string[] = [];
  const deps: BlockEscalationSweepDeps = {
    selectPending: () => opts.pending,
    readBlockedReason: (_projectDir, taskId) => opts.reasons?.[taskId] ?? null,
    mintAttempted: (epicId, taskId, outcome, instanceEventId) => {
      mints.push({ kind: "attempted", epicId, taskId, outcome });
      mintInstances.push(instanceEventId);
    },
    dispatchOwner: async (row) => {
      ownerDispatches.push({ epicId: row.epic_id, taskId: row.task_id });
      return (await opts.dispatchOwner?.(row)) ?? "dispatched";
    },
    isEpicBlockHandlingLive: (epicId) => opts.epicLive?.has(epicId) ?? false,
    ownerLiveness: (row) =>
      opts.ownerProbe?.(row) ??
      opts.owner?.[row.task_id] ?? { state: "dead", diedAtMs: 0 },
    auditOrchestratorLiveness: (row) =>
      opts.orchestrator?.[row.task_id] ?? { state: "absent" },
    now: () => opts.nowMs ?? 1_000_000,
    hasOpenWorkFailure: (taskId) => opts.alreadyFailed?.has(taskId) ?? false,
    suppressRedispatch: (args) => suppressions.push(args),
    noteLine: (line) => notes.push(line),
  };
  return {
    deps,
    mints,
    mintInstances,
    dispatches,
    ownerDispatches,
    suppressions,
    notes,
  };
}

test("runBlockEscalationSweep: an escalatable block DISPATCHES one owner redispatch and mints Requested→Attempted{owner_redispatched} (no planner@ send)", async () => {
  const { deps, mints, dispatches, ownerDispatches } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1")],
    reasons: { "fn-1-foo.1": "SPEC_UNCLEAR: ambiguous acceptance" },
  });
  await runBlockEscalationSweep(deps);

  // Exactly one owner-work redispatch for the task (the bounded owner-fenced ladder
  // is the ONLY escalation path now) — and no planner@ bus message (the deps
  // surface has no notify path at all now).
  expect(dispatches).toEqual([]);
  expect(ownerDispatches).toEqual([
    { epicId: "fn-1-foo", taskId: "fn-1-foo.1" },
  ]);
  // Requested STRICTLY before Attempted; the terminal outcome is `owner_redispatched`.
  expect(mints).toEqual([
    {
      kind: "attempted",
      epicId: "fn-1-foo",
      taskId: "fn-1-foo.1",
      outcome: "owner_redispatched",
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

test("runBlockEscalationSweep: a skipped category re-arms under AUDIT_READY and dispatches once after grace", async () => {
  const taskId = "fn-1-rearm.1";
  const row = blockedRow("fn-1-rearm", taskId, {
    owner_redispatch_attempts: 0,
  });
  const reasons: Record<string, string | null> = {
    [taskId]: "TOOLING_FAILURE: runner unavailable",
  };
  const orchestrator: Record<string, AuditOrchestratorLiveness> = {};
  const diedAtMs = 1_000_000;
  const options: {
    pending: PendingBlockEscalation[];
    reasons: Record<string, string | null>;
    orchestrator: Record<string, AuditOrchestratorLiveness>;
    nowMs: number;
  } = {
    pending: [row],
    reasons,
    orchestrator,
    nowMs: diedAtMs,
  };
  const { deps, mints, dispatches, ownerDispatches } = fakeSweepDeps(options);

  await runBlockEscalationSweep(deps);
  expect(dispatches).toEqual([]);
  expect(ownerDispatches).toEqual([]);
  expect(mints.at(-1)).toEqual({
    kind: "attempted",
    epicId: "fn-1-rearm",
    taskId,
    outcome: "skipped_category",
  });

  // The fold has settled the first cycle. A later worker park rewrites the parsed
  // category while the task remains blocked, so the same row becomes re-armable.
  row.status = "attempted";
  row.outcome = "skipped_category";
  reasons[taskId] = AUDIT_READY_REASON;
  orchestrator[taskId] = { state: "dead", diedAtMs };
  options.nowMs = diedAtMs + AUDIT_READY_ORCHESTRATOR_GRACE_MS - 1;
  await runBlockEscalationSweep(deps);
  expect(dispatches).toEqual([]);

  options.nowMs = diedAtMs + AUDIT_READY_ORCHESTRATOR_GRACE_MS;
  await runBlockEscalationSweep(deps);
  expect(dispatches).toEqual([]);
  expect(ownerDispatches).toEqual([
    { epicId: "fn-1-rearm", taskId: "fn-1-rearm.1" },
  ]);
  expect(mints.slice(-1)).toEqual([
    {
      kind: "attempted",
      epicId: "fn-1-rearm",
      taskId,
      outcome: "owner_redispatched",
    },
  ]);

  // A folded replacement owner keeps the still-parked latch pending while its
  // live jobs row makes the audit gate defer.
  row.outcome = "owner_redispatched";
  orchestrator[taskId] = { state: "live" };
  await runBlockEscalationSweep(deps);
  expect(ownerDispatches).toHaveLength(1);
});

test("runBlockEscalationSweep: repeat surface-and-stop reason classes stay terminal without re-emitting", async () => {
  const { deps, mints, dispatches, suppressions, notes } = fakeSweepDeps({
    pending: [
      blockedRow("fn-1-repeat", "fn-1-repeat.1", {
        status: "attempted",
        outcome: "skipped_category",
      }),
      blockedRow("fn-1-repeat", "fn-1-repeat.2", {
        status: "attempted",
        outcome: "skipped_category",
      }),
    ],
    reasons: {
      "fn-1-repeat.1": "TOOLING_FAILURE: differently worded failure",
      "fn-1-repeat.2": "free text remains unparseable",
    },
  });

  await runBlockEscalationSweep(deps);
  expect(dispatches).toEqual([]);
  expect(mints).toEqual([]);
  expect(suppressions).toEqual([]);
  expect(notes).toEqual([]);
});

test("runBlockEscalationSweep: a re-armable category change still defers to a live unblock", async () => {
  const { deps, mints, dispatches, notes } = fakeSweepDeps({
    pending: [
      blockedRow("fn-1-rearm", "fn-1-rearm.1", {
        status: "attempted",
        outcome: "skipped_category",
      }),
    ],
    reasons: { "fn-1-rearm.1": "DESIGN_CONFLICT: incompatible contracts" },
    epicLive: new Set(["fn-1-rearm"]),
  });

  await runBlockEscalationSweep(deps);
  expect(dispatches).toEqual([]);
  expect(mints).toEqual([]);
  expect(notes).toEqual([
    "# block-escalation-skip epic=fn-1-rearm task=fn-1-rearm.1 class=epic_serialized",
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
    {
      kind: "attempted",
      epicId: "fn-1-foo",
      taskId: "fn-1-foo.1",
      outcome: "skipped_category",
    },
  ]);
});

test("runBlockEscalationSweep: an escalatable block does NOT durably suppress (only surface-and-stop categories do)", async () => {
  const { deps, suppressions, ownerDispatches } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1")],
    reasons: { "fn-1-foo.1": "SPEC_UNCLEAR: ambiguous acceptance" },
  });
  await runBlockEscalationSweep(deps);

  // SPEC_UNCLEAR redispatches the owning work session; the autopilot re-dispatch
  // path stays open, so NO durable failure is minted.
  expect(ownerDispatches).toEqual([
    { epicId: "fn-1-foo", taskId: "fn-1-foo.1" },
  ]);
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
  const { deps, mints, ownerDispatches } = fakeSweepDeps({
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

  // Exactly ONE owner redispatch for the epic (the first row wins the claim).
  expect(ownerDispatches).toEqual([
    { epicId: "fn-1-foo", taskId: "fn-1-foo.1" },
  ]);
  // The winner mints owner_redispatched; the same-epic sibling mints NOTHING (stays
  // pending, re-sweeps once the live session goes terminal — no starvation, no
  // collision).
  expect(mints).toEqual([
    {
      kind: "attempted",
      epicId: "fn-1-foo",
      taskId: "fn-1-foo.1",
      outcome: "owner_redispatched",
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
  const { deps, mints, ownerDispatches } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.2")],
    reasons: { "fn-1-foo.2": "SPEC_UNCLEAR: still blocked" },
    // The prior session went terminal → the epic is no longer live.
    epicLive: new Set(),
  });
  await runBlockEscalationSweep(deps);

  expect(ownerDispatches).toEqual([
    { epicId: "fn-1-foo", taskId: "fn-1-foo.2" },
  ]);
  expect(mints).toEqual([
    {
      kind: "attempted",
      epicId: "fn-1-foo",
      taskId: "fn-1-foo.2",
      outcome: "owner_redispatched",
    },
  ]);
});

test("runBlockEscalationSweep: two DIFFERENT epics each get their own dispatch (serialization is per-epic)", async () => {
  const { deps, ownerDispatches } = fakeSweepDeps({
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

  expect(ownerDispatches).toEqual([
    { epicId: "fn-1-foo", taskId: "fn-1-foo.1" },
    { epicId: "fn-2-bar", taskId: "fn-2-bar.1" },
  ]);
});

test("runBlockEscalationSweep: an at_cap skip mints NOTHING (row stays pending, re-sweeps)", async () => {
  const { deps, mints, ownerDispatches, notes } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1")],
    reasons: { "fn-1-foo.1": "SPEC_UNCLEAR: a" },
    dispatchOwner: async () => "at_cap",
  });
  await runBlockEscalationSweep(deps);

  // The dispatcher was consulted, but the cap skip mints no marker — the row re-sweeps.
  expect(ownerDispatches.length).toBe(1);
  expect(mints).toEqual([]);
  expect(notes).toEqual([
    "# block-escalation-skip epic=fn-1-foo task=fn-1-foo.1 class=owner_at_cap",
  ]);
});

test("runBlockEscalationSweep: an already_live skip (occupancy guard) mints NOTHING", async () => {
  const { deps, mints, notes } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1")],
    reasons: { "fn-1-foo.1": "SPEC_UNCLEAR: a" },
    dispatchOwner: async () => "already_live",
  });
  await runBlockEscalationSweep(deps);
  expect(mints).toEqual([]);
  expect(notes).toEqual([
    "# block-escalation-skip epic=fn-1-foo task=fn-1-foo.1 class=owner_already_live",
  ]);
});

test("runBlockEscalationSweep: a dispatch_failed outcome mints Requested→Attempted{owner_redispatch_failed} (re-sweepable)", async () => {
  const { deps, mints } = fakeSweepDeps({
    // A non-external category so the default (owner-dead-past-grace) fixture reaches the
    // dispatch — EXTERNAL rides the time cadence and would defer here.
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1")],
    reasons: { "fn-1-foo.1": "DEPENDENCY_BLOCKED: upstream down" },
    dispatchOwner: async () => "dispatch_failed",
  });
  await runBlockEscalationSweep(deps);

  // dispatch_failed mints attempted{owner_redispatch_failed} — the fold resets the
  // latch to pending, so the next sweep retries.
  expect(mints).toEqual([
    {
      kind: "attempted",
      epicId: "fn-1-foo",
      taskId: "fn-1-foo.1",
      outcome: "owner_redispatch_failed",
    },
  ]);
});

test("runBlockEscalationSweep: a THROWING dispatcher never aborts the sweep (records owner_redispatch_failed)", async () => {
  const { deps, mints } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1")],
    reasons: { "fn-1-foo.1": "DESIGN_CONFLICT: clash" },
    dispatchOwner: async () => {
      throw new Error("boom");
    },
  });
  // MUST resolve (never throw) and record a non-terminal outcome.
  await runBlockEscalationSweep(deps);
  expect(mints).toContainEqual({
    kind: "attempted",
    epicId: "fn-1-foo",
    taskId: "fn-1-foo.1",
    outcome: "owner_redispatch_failed",
  });
});

test("runBlockEscalationSweep: an empty pending set is a no-op (no mints, no dispatches)", async () => {
  const { deps, mints, dispatches } = fakeSweepDeps({ pending: [] });
  await runBlockEscalationSweep(deps);
  expect(mints).toEqual([]);
  expect(dispatches).toEqual([]);
});

// The owner-death-gated escalatable categories — every category whose owner ladder
// keys on witnessed owner LIVENESS. EXTERNAL_BLOCKED is deliberately EXCLUDED: it rides
// the same ladder but through the time-driven re-check gate (it ignores owner liveness),
// so its behavior is pinned by the dedicated cadence tests below, not this liveness one.
const IN_SESSION_BLOCK_CATEGORIES = [
  "SPEC_UNCLEAR",
  "DEPENDENCY_BLOCKED",
  "DESIGN_CONFLICT",
  "SCOPE_EXCEEDED",
  "RESUME_EXHAUSTED",
] as const;

test("runBlockEscalationSweep: every ordinary escalatable category defers while its owning work orchestrator is live", async () => {
  const pending = IN_SESSION_BLOCK_CATEGORIES.map((category, index) =>
    blockedRow(
      `fn-${index + 20}-${category.toLowerCase()}`,
      `fn-${index + 20}-${category.toLowerCase()}.1`,
      {
        owner_redispatch_attempts: 0,
      },
    ),
  );
  const reasons = Object.fromEntries(
    pending.map((row, index) => [
      row.task_id,
      `${IN_SESSION_BLOCK_CATEGORIES[index]}: fixture`,
    ]),
  );
  const owner = Object.fromEntries(
    pending.map((row) => [row.task_id, { state: "live" as const }]),
  );
  const { deps, mints, dispatches, ownerDispatches } = fakeSweepDeps({
    pending,
    reasons,
    owner,
  });

  await runBlockEscalationSweep(deps);

  expect(ownerDispatches).toEqual([]);
  expect(dispatches).toEqual([]);
  expect(mints).toEqual([]);
});

test("runBlockEscalationSweep: witnessed owner deaths consume two durable attachment attempts, then the exhausted lease mints owner_exhausted (which stage-3 pages on)", async () => {
  const taskId = "fn-30-lease.1";
  const row = blockedRow("fn-30-lease", taskId, {
    owner_redispatch_attempts: 0,
  });
  const owner: Record<string, BlockOwnerLiveness> = {
    [taskId]: { state: "dead", diedAtMs: 0 },
  };
  const options = {
    pending: [row],
    reasons: { [taskId]: "SPEC_UNCLEAR: fixture" },
    owner,
    nowMs: BLOCK_OWNER_GRACE_MS,
  };
  const { deps, mints, dispatches, ownerDispatches } = fakeSweepDeps(options);

  await runBlockEscalationSweep(deps);
  expect(ownerDispatches).toEqual([{ epicId: "fn-30-lease", taskId }]);
  expect(dispatches).toEqual([]);
  expect(mints.slice(-2)).toEqual([
    {
      kind: "attempted",
      epicId: "fn-30-lease",
      taskId,
      outcome: "owner_redispatched",
    },
  ]);

  // Simulate the deterministic fold surviving a daemon restart.
  row.owner_redispatch_attempts = 1;
  row.outcome = "owner_redispatched";
  await runBlockEscalationSweep(deps);
  expect(ownerDispatches).toHaveLength(2);
  expect(dispatches).toEqual([]);

  // The lease is now exhausted: `blockOwnerEscalationDecision` returns
  // `surface_exhausted`, and the sweep mints the TERMINAL `owner_exhausted` as ONE
  // Attempted (NO Requested pair — a no-launch terminal must never strand at `requested`)
  // — NO dispatch of any kind — so the row leaves `pending` and feeds the stage-3
  // human-notify sweep, which pages the operator ONCE.
  const mintsBefore = mints.length;
  row.owner_redispatch_attempts = BLOCK_OWNER_REDISPATCH_LIMIT;
  await runBlockEscalationSweep(deps);
  expect(ownerDispatches).toHaveLength(2);
  expect(dispatches).toEqual([]);
  expect(mints.slice(mintsBefore)).toEqual([
    {
      kind: "attempted",
      epicId: "fn-30-lease",
      taskId,
      outcome: "owner_exhausted",
    },
  ]);

  // Once minted, the row is `attempted/owner_exhausted` — it leaves the block-sweep
  // working set (the production selector admits only `pending` / `skipped_category`),
  // so a synthetic re-sweep of the same row (were it still selected) never re-mints.
  const afterExhaustMint = mints.length;
  row.status = "attempted";
  row.outcome = "owner_exhausted";
  await runBlockEscalationSweep(deps);
  expect(mints).toHaveLength(afterExhaustMint);
  expect(ownerDispatches).toHaveLength(2);
});

test("runBlockEscalationSweep: every mint threads the row's block instance token (fenced fold)", async () => {
  const taskId = "fn-30b-fence.1";
  const { deps, mints, mintInstances } = fakeSweepDeps({
    pending: [
      blockedRow("fn-30b-fence", taskId, {
        owner_redispatch_attempts: 0,
        instance_event_id: 9090,
      }),
    ],
    reasons: { [taskId]: "SPEC_UNCLEAR: fixture" },
    owner: { [taskId]: { state: "dead", diedAtMs: 0 } },
    nowMs: BLOCK_OWNER_GRACE_MS,
  });

  await runBlockEscalationSweep(deps);

  // One owner re-dispatch → ONE Attempted (no Requested pair), fenced to the exact instance.
  expect(mints).toEqual([
    {
      kind: "attempted",
      epicId: "fn-30b-fence",
      taskId,
      outcome: "owner_redispatched",
    },
  ]);
  expect(mintInstances).toEqual([9090]);
});

test("runBlockEscalationSweep: HOLDS a row with a null/untrusted instance token — no dispatch, no mint (never an unfenced event)", async () => {
  for (const badInstance of [null, 0, -3] as (number | null)[]) {
    const taskId = "fn-30c-null.1";
    const { deps, mints, dispatches, ownerDispatches, notes } = fakeSweepDeps({
      pending: [
        blockedRow("fn-30c-null", taskId, {
          owner_redispatch_attempts: 0,
          instance_event_id: badInstance,
        }),
      ],
      reasons: { [taskId]: "SPEC_UNCLEAR: fixture" },
      owner: { [taskId]: { state: "dead", diedAtMs: 0 } },
      nowMs: BLOCK_OWNER_GRACE_MS,
    });

    await runBlockEscalationSweep(deps);

    // A row we cannot fence is HELD: no dispatch, no mint — never an unfenced event.
    expect(dispatches).toEqual([]);
    expect(ownerDispatches).toEqual([]);
    expect(mints).toEqual([]);
    expect(notes.some((n) => n.includes("class=untrusted_instance"))).toBe(
      true,
    );
  }
});

test("runBlockEscalationSweep: an owner launch failure consumes a bounded attachment attempt", async () => {
  const taskId = "fn-31-failed-owner.1";
  const { deps, mints, dispatches } = fakeSweepDeps({
    pending: [
      blockedRow("fn-31-failed-owner", taskId, {
        owner_redispatch_attempts: 0,
      }),
    ],
    // A non-external category so this pins the owner-DEATH ladder's failed-launch
    // accounting (EXTERNAL rides the time cadence — its own tests below).
    reasons: { [taskId]: "DESIGN_CONFLICT: fixture" },
    owner: { [taskId]: { state: "dead", diedAtMs: 0 } },
    nowMs: BLOCK_OWNER_GRACE_MS,
    dispatchOwner: async () => "dispatch_failed",
  });

  await runBlockEscalationSweep(deps);

  expect(dispatches).toEqual([]);
  expect(mints.at(-1)).toEqual({
    kind: "attempted",
    epicId: "fn-31-failed-owner",
    taskId,
    outcome: "owner_redispatch_failed",
  });
});

test("runBlockEscalationSweep: an exhausted attachment lease still defers every dispatch while the owner is live", async () => {
  const taskId = "fn-32-live-owner.1";
  const { deps, mints, dispatches, ownerDispatches } = fakeSweepDeps({
    pending: [blockedRow("fn-32-live-owner", taskId)],
    reasons: { [taskId]: "DESIGN_CONFLICT: fixture" },
    owner: { [taskId]: { state: "live" } },
  });

  await runBlockEscalationSweep(deps);

  expect(ownerDispatches).toEqual([]);
  expect(dispatches).toEqual([]);
  expect(mints).toEqual([]);
});

// ---- EXTERNAL_BLOCKED time-driven re-check cadence ---------------------------

// A blocked-at anchor of 1000s → 1_000_000ms; the cadence gate compares against this.
const EXTERNAL_BLOCKED_AT_S = 1_000;
const EXTERNAL_BLOCKED_AT_MS = EXTERNAL_BLOCKED_AT_S * 1000;

test("runBlockEscalationSweep: EXTERNAL_BLOCKED defers BEFORE its re-check interval elapses — even with a dead owner past grace (cadence, not liveness)", async () => {
  const taskId = "fn-40-quota.1";
  const { deps, mints, ownerDispatches } = fakeSweepDeps({
    pending: [
      blockedRow("fn-40-quota", taskId, {
        owner_redispatch_attempts: 0,
        updated_at: EXTERNAL_BLOCKED_AT_S,
      }),
    ],
    reasons: { [taskId]: "EXTERNAL_BLOCKED: provider quota exhausted" },
    // A dead-past-grace owner would fire the ORDINARY ladder immediately; EXTERNAL must
    // still wait for its interval, so this proves the gate ignores owner liveness.
    owner: { [taskId]: { state: "dead", diedAtMs: 0 } },
    nowMs: EXTERNAL_BLOCKED_AT_MS + EXTERNAL_BLOCK_RECHECK_INTERVAL_MS - 1,
  });

  await runBlockEscalationSweep(deps);

  expect(ownerDispatches).toEqual([]);
  expect(mints).toEqual([]);
});

test("runBlockEscalationSweep: EXTERNAL_BLOCKED re-dispatches the owning work verb once the interval elapses (quiescent DB: pure clock edge, owner liveness ignored)", async () => {
  const taskId = "fn-41-quota.1";
  const { deps, mints, dispatches, ownerDispatches } = fakeSweepDeps({
    pending: [
      blockedRow("fn-41-quota", taskId, {
        owner_redispatch_attempts: 0,
        updated_at: EXTERNAL_BLOCKED_AT_S,
      }),
    ],
    reasons: { [taskId]: "EXTERNAL_BLOCKED: provider quota exhausted" },
    // A LIVE owner would make the ordinary ladder defer forever; EXTERNAL ignores it and
    // re-dispatches on the clock (the production `already_live` guard handles the race).
    owner: { [taskId]: { state: "live" } },
    nowMs: EXTERNAL_BLOCKED_AT_MS + EXTERNAL_BLOCK_RECHECK_INTERVAL_MS,
  });

  await runBlockEscalationSweep(deps);

  // A re-dispatch of the OWNING work verb (never an escalation verb), and the durable
  // attempt is consumed via owner_redispatched.
  expect(dispatches).toEqual([]);
  expect(ownerDispatches).toEqual([{ epicId: "fn-41-quota", taskId }]);
  expect(mints).toEqual([
    {
      kind: "attempted",
      epicId: "fn-41-quota",
      taskId,
      outcome: "owner_redispatched",
    },
  ]);
});

test("runBlockEscalationSweep: EXTERNAL_BLOCKED converges over the bounded budget, HOLDS the terminal while the final owner is live, then PAGES exactly once on a witnessed death", async () => {
  const taskId = "fn-42-quota.1";
  const row = blockedRow("fn-42-quota", taskId, {
    owner_redispatch_attempts: 0,
    updated_at: EXTERNAL_BLOCKED_AT_S,
  });
  // Mutable owner liveness — the re-check cadence ignores it, but the TERMINAL page
  // requires positive owner-gone evidence.
  const owner: Record<string, BlockOwnerLiveness> = {
    [taskId]: { state: "dead", diedAtMs: 0 },
  };
  const options = {
    pending: [row],
    reasons: { [taskId]: "EXTERNAL_BLOCKED: provider quota exhausted" },
    owner,
    nowMs: EXTERNAL_BLOCKED_AT_MS + EXTERNAL_BLOCK_RECHECK_INTERVAL_MS,
  };
  const { deps, mints, ownerDispatches } = fakeSweepDeps(options);

  // Burn each bounded re-check attempt, one per elapsed interval (simulate the fold
  // resetting to pending + bumping the attempt count and the updated_at anchor).
  for (let attempt = 0; attempt < BLOCK_OWNER_REDISPATCH_LIMIT; attempt += 1) {
    await runBlockEscalationSweep(deps);
    expect(ownerDispatches).toHaveLength(attempt + 1);
    row.owner_redispatch_attempts += 1;
    row.outcome = "owner_redispatched";
    // The attempt bumped updated_at; the next re-check waits another full interval.
    row.updated_at = Math.floor(options.nowMs / 1000);
    options.nowMs += EXTERNAL_BLOCK_RECHECK_INTERVAL_MS;
  }

  // Budget spent, but the just-re-dispatched final owner is LIVE (actively resolving the
  // quota retry) → HOLD: no terminal, no page. Time authorizes rechecking, never a
  // terminal page over a positively-live owner.
  owner[taskId] = { state: "live" };
  const mintsBeforeHold = mints.length;
  await runBlockEscalationSweep(deps);
  expect(ownerDispatches).toHaveLength(BLOCK_OWNER_REDISPATCH_LIMIT);
  expect(mints).toHaveLength(mintsBeforeHold);

  // Positive owner-gone evidence (a witnessed death) → exactly ONE owner_exhausted
  // Attempted (no dispatch, no Requested pair), which the stage-3 sweep pages on.
  owner[taskId] = { state: "dead", diedAtMs: 0 };
  const mintsBefore = mints.length;
  await runBlockEscalationSweep(deps);
  expect(ownerDispatches).toHaveLength(BLOCK_OWNER_REDISPATCH_LIMIT);
  expect(mints.slice(mintsBefore)).toEqual([
    {
      kind: "attempted",
      epicId: "fn-42-quota",
      taskId,
      outcome: "owner_exhausted",
    },
  ]);
});

test("runBlockEscalationSweep: a newly-live owner closes the fallback dispatch race", async () => {
  const taskId = "fn-33-race.1";
  let probes = 0;
  const { deps, mints, dispatches, ownerDispatches } = fakeSweepDeps({
    pending: [blockedRow("fn-33-race", taskId)],
    reasons: { [taskId]: "SPEC_UNCLEAR: fixture" },
    ownerProbe: () =>
      ++probes === 1 ? { state: "dead", diedAtMs: 0 } : { state: "live" },
  });

  await runBlockEscalationSweep(deps);

  expect(probes).toBe(2);
  expect(ownerDispatches).toEqual([]);
  expect(dispatches).toEqual([]);
  expect(mints).toEqual([]);
});

test("runBlockEscalationSweep: owner attachment attempts remain serialized per epic", async () => {
  const pending = [
    blockedRow("fn-33-serialized", "fn-33-serialized.1", {
      owner_redispatch_attempts: 0,
    }),
    blockedRow("fn-33-serialized", "fn-33-serialized.2", {
      owner_redispatch_attempts: 0,
    }),
  ];
  const { deps, ownerDispatches } = fakeSweepDeps({
    pending,
    reasons: {
      "fn-33-serialized.1": "SPEC_UNCLEAR: first",
      "fn-33-serialized.2": "DEPENDENCY_BLOCKED: second",
    },
  });

  await runBlockEscalationSweep(deps);

  expect(ownerDispatches).toEqual([
    { epicId: "fn-33-serialized", taskId: "fn-33-serialized.1" },
  ]);
});

// ---- AUDIT_READY / AUDIT_SEVERE gate (the variable-depth per-task audit) -----

const AUDIT_READY_REASON = "AUDIT_READY: per-task audit parked this task";
const AUDIT_SEVERE_REASON =
  "AUDIT_SEVERE: verified-severe finding survived refute";

test("runBlockEscalationSweep: AUDIT_READY with a LIVE orchestrator defers — no dispatch, no mint (self-handled)", async () => {
  const { deps, mints, dispatches, ownerDispatches } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1")],
    reasons: { "fn-1-foo.1": AUDIT_READY_REASON },
    orchestrator: { "fn-1-foo.1": { state: "live" } },
    nowMs: 1_000_000,
  });
  await runBlockEscalationSweep(deps);

  // A live orchestrator owns the audit — the producer pages no one and mints
  // nothing, so the latch stays pending and re-sweeps.
  expect(dispatches).toEqual([]);
  expect(ownerDispatches).toEqual([]);
  expect(mints).toEqual([]);
});

test("runBlockEscalationSweep: AUDIT_READY with a DEAD orchestrator PAST grace dispatches one work resume", async () => {
  const { deps, mints, dispatches, ownerDispatches } = fakeSweepDeps({
    pending: [
      blockedRow("fn-1-foo", "fn-1-foo.1", {
        owner_redispatch_attempts: 0,
      }),
    ],
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

  // The work dispatcher is the owner-fenced autopilot path; the unblock dispatcher
  // must remain untouched because an unblocker cannot advance the audit handoff.
  expect(dispatches).toEqual([]);
  expect(ownerDispatches).toEqual([
    { epicId: "fn-1-foo", taskId: "fn-1-foo.1" },
  ]);
  expect(mints).toEqual([
    {
      kind: "attempted",
      epicId: "fn-1-foo",
      taskId: "fn-1-foo.1",
      outcome: "owner_redispatched",
    },
  ]);
});

test("runBlockEscalationSweep: an AUDIT_READY work resume at cap stays pending", async () => {
  const { deps, mints, dispatches, ownerDispatches } = fakeSweepDeps({
    pending: [
      blockedRow("fn-1-foo", "fn-1-foo.1", {
        owner_redispatch_attempts: 0,
      }),
    ],
    reasons: { "fn-1-foo.1": AUDIT_READY_REASON },
    orchestrator: { "fn-1-foo.1": { state: "dead", diedAtMs: 800_000 } },
    nowMs: 1_000_000,
    dispatchOwner: async () => "at_cap",
  });

  await runBlockEscalationSweep(deps);

  expect(dispatches).toEqual([]);
  expect(ownerDispatches).toEqual([
    { epicId: "fn-1-foo", taskId: "fn-1-foo.1" },
  ]);
  expect(mints).toEqual([]);
});

test("runBlockEscalationSweep: repeated AUDIT_READY replacement deaths exhaust the owner bound, mint owner_exhausted, and the stage-3 sweep pages on it exactly once", async () => {
  const epicId = "fn-1-audit-loop";
  const taskId = `${epicId}.1`;
  const row = blockedRow(epicId, taskId, {
    owner_redispatch_attempts: 0,
  });
  const orchestrator: Record<string, AuditOrchestratorLiveness> = {
    [taskId]: { state: "dead", diedAtMs: 0 },
  };
  const options = {
    pending: [row],
    reasons: { [taskId]: AUDIT_READY_REASON },
    orchestrator,
    nowMs: AUDIT_READY_ORCHESTRATOR_GRACE_MS,
  };
  const { deps, mints, dispatches, ownerDispatches } = fakeSweepDeps(options);

  for (let attempt = 0; attempt < BLOCK_OWNER_REDISPATCH_LIMIT; attempt += 1) {
    await runBlockEscalationSweep(deps);
    expect(ownerDispatches).toHaveLength(attempt + 1);
    expect(dispatches).toEqual([]);

    row.owner_redispatch_attempts += 1;
    row.outcome = "owner_redispatched";
    orchestrator[taskId] = { state: "live" };
    await runBlockEscalationSweep(deps);
    expect(ownerDispatches).toHaveLength(attempt + 1);

    const replacementDiedAtMs = options.nowMs + 1;
    orchestrator[taskId] = {
      state: "dead",
      diedAtMs: replacementDiedAtMs,
    };
    options.nowMs = replacementDiedAtMs + AUDIT_READY_ORCHESTRATOR_GRACE_MS - 1;
    await runBlockEscalationSweep(deps);
    expect(ownerDispatches).toHaveLength(attempt + 1);
    options.nowMs += 1;
  }

  // The lease is now exhausted: `surface_exhausted` mints the TERMINAL `owner_exhausted`
  // (Requested→Attempted) — no dispatch of any kind — so the row leaves `pending` and
  // becomes an `attempted/owner_exhausted` incident the stage-3 sweep pages on.
  const mintsBefore = mints.length;
  await runBlockEscalationSweep(deps);
  expect(ownerDispatches).toHaveLength(BLOCK_OWNER_REDISPATCH_LIMIT);
  expect(dispatches).toEqual([]);
  // A no-launch terminal mints ONE Attempted (no Requested pair — never strands at
  // `requested`).
  expect(mints.slice(mintsBefore)).toEqual([
    { kind: "attempted", epicId, taskId, outcome: "owner_exhausted" },
  ]);

  // The exhausted lease now feeds `runBlockHumanNotifySweep` in production: the
  // production selector admits `owner_exhausted`, and an `owner_exhausted` row is
  // ALREADY terminal (the block sweep only mints it once the lease is spent), so it
  // pages DIRECTLY with the `exhausted` verdict — no `unblockOutcome` sequencing — and
  // exactly once. A second sweep after the notify latch is stamped selects nothing.
  const pages: { taskId: string; verdict: BlockNotifyVerdict }[] = [];
  const notifyMints: BlockHumanNotifyMintCall[] = [];
  let notified = false;
  await runBlockHumanNotifySweep({
    selectPending: () =>
      notified
        ? []
        : [
            {
              epic_id: epicId,
              task_id: taskId,
              outcome: "owner_exhausted",
              instance_event_id: 1,
            },
          ],
    stillPending: () => true,
    // An owner_exhausted row must NOT consult the unblock classifier at all.
    unblockOutcome: () => {
      throw new Error("owner_exhausted must page directly, never sequence");
    },
    notifyHuman: async (pending, verdict) => {
      pages.push({ taskId: pending.task_id, verdict });
      return "notified";
    },
    mintAttempted: (notifiedEpicId, notifiedTaskId, outcome) => {
      notifyMints.push({
        epicId: notifiedEpicId,
        taskId: notifiedTaskId,
        outcome,
      });
      notified = true;
    },
  });
  expect(pages).toEqual([{ taskId, verdict: "exhausted" }]);
  expect(notifyMints).toEqual([{ epicId, taskId, outcome: "notified" }]);
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
  const { deps, mints, dispatches, ownerDispatches } = fakeSweepDeps({
    pending: [blockedRow("fn-1-foo", "fn-1-foo.1")],
    reasons: { "fn-1-foo.1": AUDIT_SEVERE_REASON },
    // A live orchestrator MUST NOT suppress a severe finding — the deny gate
    // never consults liveness for AUDIT_SEVERE.
    orchestrator: { "fn-1-foo.1": { state: "live" } },
    nowMs: 1_000_000,
  });
  await runBlockEscalationSweep(deps);

  expect(dispatches).toEqual([]);
  expect(ownerDispatches).toEqual([
    { epicId: "fn-1-foo", taskId: "fn-1-foo.1" },
  ]);
  expect(mints).toEqual([
    {
      kind: "attempted",
      epicId: "fn-1-foo",
      taskId: "fn-1-foo.1",
      outcome: "owner_redispatched",
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
    job_id: `${planVerb}-${planRef}-${updatedAt}`,
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

test("probeAuditOrchestrator: canonical quiescent stopped owner reads dead while unknown holds", () => {
  const jobs: Job[] = [orchJob("work", "fn-1-foo.1", "stopped", 100)];
  const id = jobs[0]?.job_id ?? "";
  expect(
    probeAuditOrchestrator(
      jobs,
      "fn-1-foo",
      "fn-1-foo.1",
      new Map([
        [
          id,
          {
            status: "quiescent",
            reason: "ambient-resource",
            reservation: null,
          },
        ],
      ]),
    ),
  ).toEqual({ state: "dead", diedAtMs: 100_000 });
  expect(
    probeAuditOrchestrator(
      jobs,
      "fn-1-foo",
      "fn-1-foo.1",
      new Map([
        [
          id,
          {
            status: "unknown",
            reason: "child-evidence-stale",
            reservation: null,
          },
        ],
      ]),
    ),
  ).toEqual({ state: "live" });
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

test("probeBlockOwner: only the exact work::<task> orchestrator owns an ordinary blocked task", () => {
  const jobs = [
    orchJob("close", "fn-1-foo", "working", 100),
    orchJob("work", "fn-1-foo.2", "working", 200),
    orchJob("work", "fn-1-foo.1", "ended", 300),
  ];
  expect(probeBlockOwner(jobs, "fn-1-foo", "fn-1-foo.1")).toEqual({
    state: "dead",
    diedAtMs: 300_000,
  });
  jobs.push(orchJob("work", "fn-1-foo.1", "working", 400));
  expect(probeBlockOwner(jobs, "fn-1-foo", "fn-1-foo.1")).toEqual({
    state: "live",
  });
});

test("blockOwnerEscalationDecision: witnessed death advances attachment attempts then surfaces exhausted; every uncertain/live state defers", () => {
  const dead: BlockOwnerLiveness = { state: "dead", diedAtMs: 0 };
  expect(blockOwnerEscalationDecision(dead, 0, BLOCK_OWNER_GRACE_MS)).toBe(
    "redispatch_owner",
  );
  expect(blockOwnerEscalationDecision(dead, 1, BLOCK_OWNER_GRACE_MS)).toBe(
    "redispatch_owner",
  );
  expect(
    blockOwnerEscalationDecision(
      dead,
      BLOCK_OWNER_REDISPATCH_LIMIT,
      BLOCK_OWNER_GRACE_MS,
    ),
  ).toBe("surface_exhausted");
  expect(blockOwnerEscalationDecision(dead, 0, BLOCK_OWNER_GRACE_MS - 1)).toBe(
    "defer",
  );
  expect(
    blockOwnerEscalationDecision(
      { state: "live" },
      BLOCK_OWNER_REDISPATCH_LIMIT,
      10 * BLOCK_OWNER_GRACE_MS,
    ),
  ).toBe("defer");
  expect(
    blockOwnerEscalationDecision(
      { state: "absent" },
      BLOCK_OWNER_REDISPATCH_LIMIT,
      10 * BLOCK_OWNER_GRACE_MS,
    ),
  ).toBe("defer");
});

test("externalBlockRecheckDecision: the RE-CHECK trigger ignores owner liveness on the cadence, but the TERMINAL holds for a live/inconclusive owner and pages only on a witnessed death", () => {
  const interval = EXTERNAL_BLOCK_RECHECK_INTERVAL_MS;
  const blockedAt = 1_000_000;
  const dead: BlockOwnerLiveness = { state: "dead", diedAtMs: 0 };
  const live: BlockOwnerLiveness = { state: "live" };
  const absent: BlockOwnerLiveness = { state: "absent" };

  // RE-CHECK phase (budget remaining): the cadence gate ignores owner liveness entirely —
  // `dispatchOwner`'s own `already_live` guard drops a redundant launch.
  // Before the interval elapses → defer (do not hammer a still-closed window).
  expect(
    externalBlockRecheckDecision(live, blockedAt, 0, blockedAt + interval - 1),
  ).toBe("defer");
  // Exactly at the interval → re-dispatch (>=), even with a LIVE owner.
  expect(
    externalBlockRecheckDecision(live, blockedAt, 0, blockedAt + interval),
  ).toBe("redispatch_owner");
  expect(
    externalBlockRecheckDecision(dead, blockedAt, 1, blockedAt + 10 * interval),
  ).toBe("redispatch_owner");
  // Clock skew (anchor in the future) never premature-dispatches.
  expect(externalBlockRecheckDecision(dead, blockedAt, 0, blockedAt - 1)).toBe(
    "defer",
  );

  // TERMINAL phase (budget spent): PAGE only on positive owner-gone evidence.
  // A witnessed death → surface exhausted (pages), even far past an interval.
  expect(
    externalBlockRecheckDecision(
      dead,
      blockedAt,
      BLOCK_OWNER_REDISPATCH_LIMIT,
      blockedAt + 100 * interval,
    ),
  ).toBe("surface_exhausted");
  // A LIVE owner at exhaustion HOLDS — the final recheck may still be resolving; time
  // never terminal-pages over a positively-live owner (this replaces the prior
  // "exhaustion wins the interval unconditionally" blessing).
  expect(
    externalBlockRecheckDecision(
      live,
      blockedAt,
      BLOCK_OWNER_REDISPATCH_LIMIT,
      blockedAt + 100 * interval,
    ),
  ).toBe("defer");
  // An ABSENT / inconclusive owner also HOLDS (no positive gone evidence).
  expect(
    externalBlockRecheckDecision(
      absent,
      blockedAt,
      BLOCK_OWNER_REDISPATCH_LIMIT,
      blockedAt + 100 * interval,
    ),
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

test("routeBlockedCategory: the four routes are keyed by category", () => {
  // AUDIT_READY resumes work; SHARED_BASE_BROKEN repairs; TOOLING_FAILURE / null
  // surface-and-stop; every other escalatable category unblocks.
  expect(routeBlockedCategory("AUDIT_READY")).toBe("work");
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
    attempt_id: 41,
    instance_event_id: 51,
    ...overrides,
  };
}

function repairGrant(overrides: Partial<GrantLeaf> = {}): GrantLeaf {
  return {
    schema_version: 1,
    parent_job_id: "job-fn-1-foo.2",
    agent_type: "plan:repairer",
    incident_id: "repair::repo-abc",
    owner_task_id: "fn-1-foo.2",
    attempt_id: "41:fp1",
    instance_event_id: 51,
    writable_root: "/repo",
    role: "repair",
    expires_at: 2_000_000,
    fencing_token: 7,
    ...overrides,
  };
}

function fakeRepairSweepDeps(opts: {
  candidates?: RepairCandidate[];
  rows?: PendingRepairRow[];
  grants?: GrantLeaf[];
  dirty?: Set<string>;
  activeDirty?: Map<string, string>;
  green?: Set<string>;
  ownerTask?: string | null;
  holderLiveness?: "live" | "dead" | "inconclusive";
  ownerOutcome?: ResolverOutcome;
  nowMs?: number;
  publish?: (grant: GrantLeaf) => boolean;
  notify?: (
    row: PendingRepairRow,
    verdict: RepairNotifyVerdict,
  ) => Promise<RepairHumanNotifiedOutcome>;
  candidatesThrow?: boolean;
  rowsThrow?: boolean;
  maintenanceOpen?: boolean;
  maintenanceOutcome?: MaintenanceMintOutcome;
  maintenanceThrows?: boolean;
}): {
  deps: RepairEscalationSweepDeps;
  mints: RepairMint[];
  grants: GrantLeaf[];
  published: GrantLeaf[];
  expired: GrantLeaf[];
  unblocked: string[];
  notifies: { token: string; verdict: RepairNotifyVerdict }[];
  notes: string[];
  maintenanceProbed: string[];
  maintenanceMinted: string[];
} {
  const mints: RepairMint[] = [];
  const grants = [...(opts.grants ?? [])];
  const published: GrantLeaf[] = [];
  const expired: GrantLeaf[] = [];
  const unblocked: string[] = [];
  const notifies: { token: string; verdict: RepairNotifyVerdict }[] = [];
  const notes: string[] = [];
  const maintenanceProbed: string[] = [];
  const maintenanceMinted: string[] = [];
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
    selectGrants: () => grants,
    selectOwner: (_group, candidates) => {
      if (opts.ownerTask === null) return null;
      const taskId =
        opts.ownerTask ??
        candidates.find((candidate) => candidate.epic_id !== "")?.task_id;
      const candidate = candidates.find((entry) => entry.task_id === taskId);
      return candidate == null
        ? null
        : {
            epic_id: candidate.epic_id,
            task_id: candidate.task_id,
            parent_job_id: `job-${candidate.task_id}`,
          };
    },
    grantHolderLiveness: () => opts.holderLiveness ?? "live",
    grantOwnerOutcome: () => opts.ownerOutcome ?? { terminal: false },
    isDirtyCheckout: (dir) => opts.dirty?.has(dir) ?? false,
    activeDirtyDistressId: (dir) => opts.activeDirty?.get(dir) ?? null,
    isBaseGreen: (dir) => opts.green?.has(dir) ?? false,
    nowMs: () => opts.nowMs ?? 1_000_000,
    publishGrant: (grant) => {
      const ok = opts.publish?.(grant) ?? true;
      if (ok) {
        grants.push(grant);
        published.push(grant);
      }
      return ok;
    },
    expireGrant: (grant, nowMs) => {
      grant.expires_at = Math.min(grant.expires_at, nowMs);
      expired.push(grant);
    },
    unblockTask: async (candidate) => {
      unblocked.push(candidate.task_id);
      return true;
    },
    notifyHuman: async (row, verdict) => {
      notifies.push({ token: row.id, verdict });
      return (await opts.notify?.(row, verdict)) ?? "notified";
    },
    mintRow: (group) =>
      mints.push({
        kind: "row",
        token: group.repo_token,
        reason: repairReasonFor(group.fingerprint, group.baseline_diagnosis),
        dir: group.repo_dir,
      }),
    mintDispatched: (token, outcome) =>
      mints.push({ kind: "dispatched", token, outcome }),
    mintNotified: (token, outcome) =>
      mints.push({ kind: "notified", token, outcome }),
    clearRow: (row) => mints.push({ kind: "clear", token: row.id }),
    hasOpenMaintenanceTask: (group) => {
      maintenanceProbed.push(group.repo_token);
      return opts.maintenanceOpen ?? false;
    },
    mintMaintenanceTask: async (group) => {
      maintenanceMinted.push(group.repo_token);
      if (opts.maintenanceThrows) throw new Error("maintenance mint boom");
      return opts.maintenanceOutcome ?? "minted";
    },
  };
  return {
    deps,
    mints,
    grants,
    published,
    expired,
    unblocked,
    notifies,
    notes,
    maintenanceProbed,
    maintenanceMinted,
  };
}

test("runRepairEscalationSweep: coalesced blocked owners mint one row before grant election", async () => {
  const { deps, mints, published } = fakeRepairSweepDeps({
    candidates: [
      repairCandidate("fn-1-foo", "fn-1-foo.2"),
      repairCandidate("fn-1-foo", "fn-1-foo.3"),
      repairCandidate("fn-2-bar", "fn-2-bar.1"),
    ],
  });
  await runRepairEscalationSweep(deps);
  expect(published).toEqual([]);
  expect(mints).toEqual([
    {
      kind: "row",
      token: "repo-abc",
      reason: "shared-base-broken:fp1",
      dir: "/repo",
    },
  ]);
});

test("runRepairEscalationSweep: concurrent affected owners receive exactly one grant and no session dispatch", async () => {
  const { deps, mints, published } = fakeRepairSweepDeps({
    candidates: [
      repairCandidate("fn-1-foo", "fn-1-foo.2"),
      repairCandidate("fn-1-foo", "fn-1-foo.3"),
      repairCandidate("fn-2-bar", "fn-2-bar.1"),
    ],
    rows: [repairRow()],
  });
  await runRepairEscalationSweep(deps);
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({
    parent_job_id: "job-fn-1-foo.2",
    owner_task_id: "fn-1-foo.2",
    incident_id: "repair::repo-abc",
    writable_root: "/repo",
    role: "repair",
    fencing_token: 1,
  });
  expect(mints).toEqual([
    { kind: "dispatched", token: "repo-abc", outcome: "dispatched" },
  ]);
});

test("runRepairEscalationSweep: distinct repos elect independent grants", async () => {
  const { deps, published } = fakeRepairSweepDeps({
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
    rows: [
      repairRow({ id: "a-111", dir: "/a", instance_event_id: 61 }),
      repairRow({ id: "b-222", dir: "/b", instance_event_id: 62 }),
    ],
  });
  await runRepairEscalationSweep(deps);
  expect(published.map((grant) => grant.incident_id).sort()).toEqual([
    "repair::a-111",
    "repair::b-222",
  ]);
});

test("runRepairEscalationSweep: a dirty shared checkout defers grant publication with an observable trace", async () => {
  const { deps, mints, published, notes } = fakeRepairSweepDeps({
    candidates: [repairCandidate("fn-1-foo", "fn-1-foo.2")],
    rows: [repairRow()],
    dirty: new Set(["/repo"]),
  });
  await runRepairEscalationSweep(deps);
  expect(published).toEqual([]);
  expect(mints).toEqual([]);
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
  const { deps, mints, published, notes } = fakeRepairSweepDeps({
    candidates: [repairCandidate("fn-1-foo", "fn-1-foo.2")],
    rows: [repairRow()],
    dirty: new Set(["/repo"]),
    activeDirty: new Map([["/repo", distressId]]),
  });
  await runRepairEscalationSweep(deps);
  expect(published).toEqual([]);
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

test("runRepairEscalationSweep: a grant publication failure records a retryable failed attempt", async () => {
  const { deps, mints, published } = fakeRepairSweepDeps({
    candidates: [repairCandidate("fn-1-foo", "fn-1-foo.2")],
    rows: [repairRow()],
    publish: () => false,
  });
  await runRepairEscalationSweep(deps);
  expect(published).toEqual([]);
  expect(mints).toEqual([
    { kind: "dispatched", token: "repo-abc", outcome: "dispatch_failed" },
  ]);
});

test("runRepairEscalationSweep: an unexpired grant prevents every sibling election", async () => {
  const { deps, mints, published, notifies } = fakeRepairSweepDeps({
    candidates: [
      repairCandidate("fn-1-foo", "fn-1-foo.2"),
      repairCandidate("fn-1-foo", "fn-1-foo.3"),
    ],
    rows: [repairRow({ repair_dispatched_at: 100 })],
    grants: [repairGrant()],
  });
  await runRepairEscalationSweep(deps);
  expect(published).toEqual([]);
  expect(notifies).toEqual([]);
  expect(mints).toEqual([]);
});

test("runRepairEscalationSweep: expiry without positive holder death never re-elects", async () => {
  for (const liveness of ["live", "inconclusive"] as const) {
    const fixture = fakeRepairSweepDeps({
      candidates: [repairCandidate("fn-1-foo", "fn-1-foo.3")],
      rows: [repairRow()],
      grants: [repairGrant({ expires_at: 900_000 })],
      holderLiveness: liveness,
    });
    await runRepairEscalationSweep(fixture.deps);
    expect(fixture.published).toEqual([]);
    expect(fixture.notes).toEqual([
      `# repair-grant-hold token=repo-abc class=holder_${liveness}`,
    ]);
  }
});

test("runRepairEscalationSweep: an expired positively-dead holder is fenced before re-election", async () => {
  const { deps, published, expired, mints } = fakeRepairSweepDeps({
    candidates: [repairCandidate("fn-1-foo", "fn-1-foo.3")],
    rows: [repairRow()],
    grants: [repairGrant({ expires_at: 900_000, fencing_token: 7 })],
    holderLiveness: "dead",
    ownerTask: "fn-1-foo.3",
  });
  await runRepairEscalationSweep(deps);
  expect(expired).toHaveLength(1);
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({
    parent_job_id: "job-fn-1-foo.3",
    owner_task_id: "fn-1-foo.3",
    fencing_token: 8,
  });
  expect(mints).toContainEqual({
    kind: "dispatched",
    token: "repo-abc",
    outcome: "dispatched",
  });
});

test("runRepairEscalationSweep: a terminal granted owner pages once without launching repair", async () => {
  const { deps, mints, published, notifies } = fakeRepairSweepDeps({
    candidates: [repairCandidate("fn-1-foo", "fn-1-foo.2")],
    rows: [repairRow({ repair_dispatched_at: 100 })],
    grants: [repairGrant()],
    ownerOutcome: { terminal: true, verdict: "declined" },
  });
  await runRepairEscalationSweep(deps);
  expect(published).toEqual([]);
  expect(notifies).toEqual([{ token: "repo-abc", verdict: "declined" }]);
  expect(mints).toEqual([
    { kind: "notified", token: "repo-abc", outcome: "notified" },
  ]);
});

test("runRepairEscalationSweep: a stamped page marker suppresses repeat owner pages", async () => {
  const { deps, mints, notifies } = fakeRepairSweepDeps({
    candidates: [repairCandidate("fn-1-foo", "fn-1-foo.2")],
    rows: [repairRow({ repair_dispatched_at: 100, human_notified_at: 200 })],
    grants: [repairGrant()],
    ownerOutcome: { terminal: true, verdict: "died" },
  });
  await runRepairEscalationSweep(deps);
  expect(notifies).toEqual([]);
  expect(mints).toEqual([]);
});

test("runRepairEscalationSweep: a failed owner page remains re-sweepable", async () => {
  const { deps, mints } = fakeRepairSweepDeps({
    candidates: [repairCandidate("fn-1-foo", "fn-1-foo.2")],
    rows: [repairRow({ repair_dispatched_at: 100 })],
    grants: [repairGrant()],
    ownerOutcome: { terminal: true, verdict: "died" },
    notify: async () => "notify_failed",
  });
  await runRepairEscalationSweep(deps);
  expect(mints).toEqual([
    { kind: "notified", token: "repo-abc", outcome: "notify_failed" },
  ]);
});

test("runRepairEscalationSweep: a candidate-free green baseline clears the incident", async () => {
  const { deps, mints } = fakeRepairSweepDeps({
    candidates: [],
    rows: [repairRow({ repair_dispatched_at: 100 })],
    green: new Set(["/repo"]),
  });
  await runRepairEscalationSweep(deps);
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

test("runRepairEscalationSweep: objective green unblocks every parked owner and expires the grant", async () => {
  const { deps, mints, unblocked, expired } = fakeRepairSweepDeps({
    candidates: [
      repairCandidate("fn-1-foo", "fn-1-foo.2"),
      repairCandidate("fn-2-bar", "fn-2-bar.1"),
    ],
    rows: [repairRow({ repair_dispatched_at: 100 })],
    grants: [repairGrant()],
    green: new Set(["/repo"]),
  });
  await runRepairEscalationSweep(deps);
  expect(unblocked).toEqual(["fn-1-foo.2", "fn-2-bar.1"]);
  expect(expired).toHaveLength(1);
  expect(mints.find((mint) => mint.kind === "clear")).toBeUndefined();
});

test("runRepairEscalationSweep: owners without a shared-checkout session park visibly and never receive a grant", async () => {
  const { deps, published, notes } = fakeRepairSweepDeps({
    candidates: [
      repairCandidate("fn-1-foo", "fn-1-foo.2"),
      repairCandidate("fn-2-bar", "fn-2-bar.1"),
    ],
    rows: [repairRow()],
    ownerTask: null,
  });
  await runRepairEscalationSweep(deps);
  expect(published).toEqual([]);
  expect(notes).toEqual([
    "# repair-park task=fn-1-foo.2 token=repo-abc class=shared_checkout_owner_unavailable",
    "# repair-park task=fn-2-bar.1 token=repo-abc class=shared_checkout_owner_unavailable",
  ]);
});

test("runRepairEscalationSweep: trunk red with NO blocked consumer mints a maintenance task instead of parking", async () => {
  const { deps, maintenanceProbed, maintenanceMinted, notes, published } =
    fakeRepairSweepDeps({
      candidates: [repairCandidate("", "baseline-tip::repo-abc")],
      rows: [repairRow()],
    });
  await runRepairEscalationSweep(deps);
  expect(maintenanceProbed).toEqual(["repo-abc"]);
  expect(maintenanceMinted).toEqual(["repo-abc"]);
  expect(published).toEqual([]);
  expect(notes.some((line) => line.startsWith("# repair-park"))).toBe(false);
});

test("runRepairEscalationSweep: an already-open maintenance task suppresses re-mint", async () => {
  const { deps, maintenanceProbed, maintenanceMinted } = fakeRepairSweepDeps({
    candidates: [repairCandidate("", "baseline-tip::repo-abc")],
    rows: [repairRow()],
    maintenanceOpen: true,
  });
  await runRepairEscalationSweep(deps);
  expect(maintenanceProbed).toEqual(["repo-abc"]);
  expect(maintenanceMinted).toEqual([]);
});

test("maintenance mint gate suppresses a second sweep before the minted epic folds", async () => {
  const fixture = fakeRepairSweepDeps({
    candidates: [repairCandidate("", "baseline-tip::repo-abc")],
    rows: [repairRow()],
  });
  const gate = createMaintenanceMintGate();
  const projectionProbe = fixture.deps.hasOpenMaintenanceTask;
  const mint = fixture.deps.mintMaintenanceTask;
  const deps: RepairEscalationSweepDeps = {
    ...fixture.deps,
    hasOpenMaintenanceTask: (group) =>
      gate.hasOpen(
        group,
        projectionProbe(group)
          ? [{ epicId: "existing-maintenance", open: true }]
          : [],
      ),
    mintMaintenanceTask: (group) =>
      gate.mint(group, async (recordEpicId) => {
        recordEpicId("minted-maintenance");
        return mint(group);
      }),
  };

  await runRepairEscalationSweep(deps);
  await runRepairEscalationSweep(deps);

  expect(fixture.maintenanceProbed).toEqual(["repo-abc", "repo-abc"]);
  expect(fixture.maintenanceMinted).toEqual(["repo-abc"]);
});

test("maintenance mint gate ignores historical done epics while a new mint is pending", async () => {
  const gate = createMaintenanceMintGate();
  const group = repairCandidate("", "baseline-tip::repo-abc");
  const historical = [{ epicId: "old-maintenance", open: false }];
  let attempts = 0;

  expect(gate.hasOpen(group, historical)).toBe(false);
  expect(
    await gate.mint(group, async (recordEpicId) => {
      attempts += 1;
      recordEpicId("new-maintenance");
      return "minted";
    }),
  ).toBe("minted");
  expect(gate.hasOpen(group, historical)).toBe(true);
  expect(
    await gate.mint(group, async () => {
      attempts += 1;
      return "minted";
    }),
  ).toBe("minted");
  expect(attempts).toBe(1);
  expect(
    gate.hasOpen(group, [
      ...historical,
      { epicId: "new-maintenance", open: true },
    ]),
  ).toBe(true);
  expect(
    gate.hasOpen(group, [
      ...historical,
      { epicId: "new-maintenance", open: false },
    ]),
  ).toBe(false);
});

test("repair escalation sweep tick is non-reentrant", async () => {
  let calls = 0;
  let releaseFirst = () => {};
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const tick = createNonReentrantRepairSweepTick(async () => {
    calls += 1;
    if (calls === 1) await firstBlocked;
  });

  const first = tick();
  await tick();
  expect(calls).toBe(1);

  releaseFirst();
  await first;
  await tick();
  expect(calls).toBe(2);
});

test("maintenance mint gate releases a failed mint for fail-open retry", async () => {
  const gate = createMaintenanceMintGate();
  const group = repairCandidate("", "baseline-tip::repo-abc");
  let attempts = 0;
  const mint = () => {
    attempts += 1;
    return Promise.resolve("mint_failed" as const);
  };

  expect(await gate.mint(group, mint)).toBe("mint_failed");
  expect(gate.hasOpen(group, [])).toBe(false);
  expect(await gate.mint(group, mint)).toBe("mint_failed");
  expect(attempts).toBe(2);
});

test("runRepairEscalationSweep: a failed maintenance mint pages exactly once", async () => {
  const { deps, mints, notifies } = fakeRepairSweepDeps({
    candidates: [repairCandidate("", "baseline-tip::repo-abc")],
    rows: [repairRow()],
    maintenanceOutcome: "mint_failed",
  });
  await runRepairEscalationSweep(deps);
  expect(notifies).toEqual([{ token: "repo-abc", verdict: "mint_failed" }]);
  expect(mints).toContainEqual({
    kind: "notified",
    token: "repo-abc",
    outcome: "notified",
  });

  // A second sweep against the marker the fold would have stamped never re-pages.
  const resweep = fakeRepairSweepDeps({
    candidates: [repairCandidate("", "baseline-tip::repo-abc")],
    rows: [repairRow({ human_notified_at: 100 })],
    maintenanceOutcome: "mint_failed",
  });
  await runRepairEscalationSweep(resweep.deps);
  expect(resweep.notifies).toEqual([]);
  // The mint keeps retrying silently — only the PAGE is once.
  expect(resweep.maintenanceMinted).toEqual(["repo-abc"]);
});

test("runRepairEscalationSweep: a throwing maintenance mint degrades to mint_failed (non-fatal)", async () => {
  const { deps, notifies } = fakeRepairSweepDeps({
    candidates: [repairCandidate("", "baseline-tip::repo-abc")],
    rows: [repairRow()],
    maintenanceThrows: true,
  });
  await runRepairEscalationSweep(deps);
  expect(notifies).toEqual([{ token: "repo-abc", verdict: "mint_failed" }]);
});

test("runRepairEscalationSweep: a MIXED group (a real candidate plus a task-less one) still parks — has a live task row to elect from", async () => {
  const { deps, maintenanceProbed, maintenanceMinted, notes } =
    fakeRepairSweepDeps({
      candidates: [
        repairCandidate("fn-1-foo", "fn-1-foo.2"),
        repairCandidate("", "baseline-tip::repo-abc"),
      ],
      rows: [repairRow()],
      ownerTask: null,
    });
  await runRepairEscalationSweep(deps);
  expect(maintenanceProbed).toEqual([]);
  expect(maintenanceMinted).toEqual([]);
  expect(notes).toEqual([
    "# repair-park task=fn-1-foo.2 token=repo-abc class=shared_checkout_owner_unavailable",
  ]);
});

test("maintenanceEpicTitle: deterministic per (repo, fingerprint) — the daemon's own re-probe key", () => {
  const group = {
    repo_token: "repo-abc",
    repo_dir: "/repo",
    fingerprint: "fp1",
  };
  expect(maintenanceEpicTitle(group)).toBe(
    `${MAINTENANCE_TASK_TITLE_PREFIX}: repo-abc fp1`,
  );
  // A different fingerprint (a distinct defect) yields a distinct title.
  expect(maintenanceEpicTitle({ ...group, fingerprint: "fp2" })).not.toBe(
    maintenanceEpicTitle(group),
  );
});

test("buildMaintenanceScaffoldYaml: carries the failing-tests digest and baseline leaf key in the task spec", () => {
  const group = {
    repo_token: "repo-abc",
    repo_dir: "/repo",
    fingerprint: "fp1",
    baseline_diagnosis: {
      baseline_leaf_key: "k-deadbee",
      failing_tests_digest: "alpha_fail; beta_fail",
    },
  };
  const yamlDoc = buildMaintenanceScaffoldYaml(group);
  expect(yamlDoc).toContain(JSON.stringify(maintenanceEpicTitle(group)));
  expect(yamlDoc).toContain("k-deadbee");
  expect(yamlDoc).toContain("alpha_fail; beta_fail");
  expect(yamlDoc).toContain("tier: xhigh");
  expect(yamlDoc).toContain("model: opus");
  expect(yamlDoc).toContain("## Description");
  expect(yamlDoc).toContain("## Acceptance");
  expect(yamlDoc).toContain("## Done summary");
  expect(yamlDoc).toContain("## Evidence");
});

test("runRepairEscalationSweep: empty candidates + empty rows is a no-op", async () => {
  const { deps, mints, published } = fakeRepairSweepDeps({});
  await runRepairEscalationSweep(deps);
  expect(mints).toEqual([]);
  expect(published).toEqual([]);
});

test("runRepairEscalationSweep: a throwing candidate read degrades to a no-op", async () => {
  const { deps, mints, published } = fakeRepairSweepDeps({
    candidatesThrow: true,
    rows: [repairRow()],
  });
  await runRepairEscalationSweep(deps);
  expect(mints).toEqual([]);
  expect(published).toEqual([]);
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
 * re-sweeps). No real daemon / agentbot / DB.
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
  // Tick 1: the agentbot send FAILS → non-terminal, marker stays NULL.
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
      throw new Error("agentbot spawn boom");
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

  const monitorSlot = buildSharedCheckoutPageBody({
    id: "monitor-slot-wedge:job-1",
    dir: "/repo",
    reason: "monitor-slot-wedge: stale",
  });
  expect(monitorSlot).toContain("dispatch root /repo");
  expect(monitorSlot).toContain("will not release or kill");

  const busDegraded = buildSharedCheckoutPageBody({
    id: BUS_DEGRADED_DISTRESS_ID,
    dir: null,
    reason: BUS_DEGRADED_DISTRESS_REASON,
  });
  expect(busDegraded).toContain("Agent Bus accept path");
  expect(busDegraded).toContain("daemon is staying up");

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
  expect(candidates[0]?.repo_dir).toBe(realpathSync(proj));
  // A produced candidate drops nothing → no diagnostic.
  expect(notes).toEqual([]);
  db.close();
});

test("selectRepairCandidates: the real round-trip feeds one owner grant election", async () => {
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

  const candidates = selectRepairCandidates(db, readTaskBlockedReason);
  const candidate = candidates[0] as RepairCandidate;
  const fixture = fakeRepairSweepDeps({
    candidates,
    rows: [
      repairRow({
        id: candidate.repo_token,
        dir: candidate.repo_dir,
        instance_event_id: 71,
      }),
    ],
  });
  await runRepairEscalationSweep(fixture.deps);
  expect(fixture.published).toHaveLength(1);
  expect(fixture.published[0]).toMatchObject({
    owner_task_id: "fn-1-foo.1",
    writable_root: realpathSync(proj),
  });
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

test("buildBaselineRepairCandidates: confirmed-red diagnosis carries leaf key and first 8 failing names plus remainder", () => {
  const hard = Array.from({ length: 10 }, (_, i) => `failure_${i + 1}`);
  const leaf = suiteRedLeaf({ runs: 2, hard, sha: "deadbee" });
  const out = buildBaselineRepairCandidates([{ repoDir: "/repo", leaf }]);
  const c = out[0] as RepairCandidate;
  expect(c.baseline_diagnosis).toEqual({
    baseline_leaf_key: "k-deadbee",
    failing_tests_digest:
      "failure_1; failure_2; failure_3; failure_4; failure_5; failure_6; " +
      "failure_7; failure_8 (+2 more)",
  });
  expect(c.baseline_diagnosis).toBeDefined();
  expect(baselineRepairFailingTestsDigest(leaf)).toBe(
    c.baseline_diagnosis?.failing_tests_digest ?? "",
  );

  const { deps, mints } = fakeRepairSweepDeps({ candidates: out });
  return runRepairEscalationSweep(deps).then(() => {
    const reason = mints.find((m) => m.kind === "row")?.reason ?? "";
    expect(reason).toContain('baseline_leaf="k-deadbee"');
    expect(reason).toContain(
      'failing_tests="failure_1; failure_2; failure_3; failure_4; failure_5; failure_6; failure_7; failure_8 (+2 more)"',
    );
    expect(reason).not.toContain("failure_9");
    expect(reason).not.toContain("failure_10");
  });
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

test("runRepairEscalationSweep: baseline red with no blocked consumer mints only the incident row", async () => {
  const baseline = buildBaselineRepairCandidates([
    { repoDir: "/repo", leaf: suiteRedLeaf({ runs: 2, hard: ["alpha_fail"] }) },
  ]);
  const { deps, mints, published } = fakeRepairSweepDeps({
    candidates: baseline,
  });
  await runRepairEscalationSweep(deps);
  expect(published).toEqual([]);
  expect(mints.filter((mint) => mint.kind === "row")).toHaveLength(1);
  expect(mints.filter((mint) => mint.kind === "dispatched")).toHaveLength(0);
});

test("runRepairEscalationSweep: a worker block coalesces with baseline evidence into one owner grant", async () => {
  const baseline = buildBaselineRepairCandidates([
    { repoDir: "/repo", leaf: suiteRedLeaf({ runs: 2, hard: ["alpha_fail"] }) },
  ]);
  const bc = baseline[0] as RepairCandidate;
  const worker: RepairCandidate = {
    epic_id: "fn-9-x",
    task_id: "fn-9-x.1",
    repo_dir: bc.repo_dir,
    repo_token: bc.repo_token,
    fingerprint: bc.fingerprint,
  };
  const { deps, published } = fakeRepairSweepDeps({
    candidates: [worker, bc],
    rows: [
      repairRow({ id: bc.repo_token, dir: bc.repo_dir, instance_event_id: 81 }),
    ],
  });
  await runRepairEscalationSweep(deps);
  expect(published).toHaveLength(1);
  expect(published[0]?.owner_task_id).toBe("fn-9-x.1");
  expect(published[0]?.incident_id).toBe(`repair::${bc.repo_token}`);
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

test("buildBlockHumanNotifyBody: an exhausted verdict names the spent re-attach lease and the unblock command", () => {
  const body = buildBlockHumanNotifyBody({
    epicId: "fn-9-foo",
    taskId: "fn-9-foo.2",
    verdict: "exhausted",
  });
  expect(body).toContain("fn-9-foo.2");
  expect(body).toContain("fn-9-foo");
  expect(body).toContain("NOT auto-retry");
  expect(body).toContain("keeper plan unblock fn-9-foo.2");
});

// ---- selectPendingBlockHumanNotifications (the stage-3 working-set read) ------

/** Seed one block incident (the `dispatch_failures` `verb='block'` subset) with the
 *  full stage-3 column set. */
function seedFullBlockLatch(
  db: ReturnType<typeof openDb>["db"],
  _epicId: string,
  taskId: string,
  status: string,
  outcome: string | null,
  humanNotifiedAt: number | null,
  instanceEventId = 1,
): void {
  db.run(
    `INSERT INTO dispatch_failures (verb, id, reason, ts, last_event_id, created_at, updated_at, instance_event_id, blocked_since, block_status, block_outcome, human_notified_at)
       VALUES ('block', ?, 'block-incident', 1, 1, 1, 1, ?, 1, ?, ?, ?)`,
    [taskId, instanceEventId, status, outcome, humanNotifiedAt],
  );
}

test("selectPendingBlockHumanNotifications: picks only terminal (dispatched | owner_exhausted)-but-not-notified latches, carrying the outcome", () => {
  const { db } = freshMemDb();
  // Legacy dispatched, human not yet notified → SELECTED (the stage-3 working set).
  seedFullBlockLatch(
    db,
    "fn-1-foo",
    "fn-1-foo.1",
    "attempted",
    "dispatched",
    null,
  );
  // The modern exhausted-lease terminal, not yet notified → SELECTED: this is exactly
  // the outcome the owner-fenced ladder mints when its bounded lease is spent.
  seedFullBlockLatch(
    db,
    "fn-5-exh",
    "fn-5-exh.1",
    "attempted",
    "owner_exhausted",
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
  // A non-terminal owner rung (still converging) → dropped.
  seedFullBlockLatch(
    db,
    "fn-6-rung",
    "fn-6-rung.1",
    "pending",
    "owner_redispatched",
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
  expect(rows).toEqual([
    {
      epic_id: "fn-1-foo",
      task_id: "fn-1-foo.1",
      outcome: "dispatched",
      instance_event_id: 1,
    },
    {
      epic_id: "fn-5-exh",
      task_id: "fn-5-exh.1",
      outcome: "owner_exhausted",
      instance_event_id: 1,
    },
  ]);
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
  stillPending?: (
    epicId: string,
    taskId: string,
    instanceEventId: number | null,
    outcome: string,
  ) => boolean;
  unblockOutcome?: (taskId: string) => ResolverOutcome;
  notify?: (
    row: PendingBlockHumanNotify,
    verdict: BlockNotifyVerdict,
  ) => Promise<BlockHumanNotifiedOutcome>;
  selectThrows?: boolean;
}): {
  deps: BlockHumanNotifySweepDeps;
  mints: BlockHumanNotifyMintCall[];
  notifies: { taskId: string; verdict: BlockNotifyVerdict }[];
} {
  const mints: BlockHumanNotifyMintCall[] = [];
  const notifies: { taskId: string; verdict: BlockNotifyVerdict }[] = [];
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

/** A legacy `dispatched` stage-3 row — sequences behind the unblock classifier. */
function blockNotifyPending(): PendingBlockHumanNotify[] {
  return [
    {
      epic_id: "fn-1-foo",
      task_id: "fn-1-foo.1",
      outcome: "dispatched",
      instance_event_id: 1,
    },
  ];
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
      throw new Error("agentbot boom");
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

test("runBlockHumanNotifySweep: an owner_exhausted row PAGES DIRECTLY with the exhausted verdict and NEVER consults the unblock classifier", async () => {
  const { deps, mints, notifies } = fakeBlockHumanNotifySweepDeps({
    pending: [
      {
        epic_id: "fn-7-exh",
        task_id: "fn-7-exh.1",
        outcome: "owner_exhausted",
        instance_event_id: 1,
      },
    ],
    // Exhaustion is already terminal — the sweep must not sequence behind any unblock
    // session. A throw here proves the classifier is never touched for this row.
    unblockOutcome: () => {
      throw new Error("owner_exhausted must page directly");
    },
  });
  await runBlockHumanNotifySweep(deps);
  expect(notifies).toEqual([{ taskId: "fn-7-exh.1", verdict: "exhausted" }]);
  expect(mints).toEqual([
    { epicId: "fn-7-exh", taskId: "fn-7-exh.1", outcome: "notified" },
  ]);
});

test("runBlockHumanNotifySweep: an owner_exhausted notify_failed leaves the marker unset (re-sweepable, never silent)", async () => {
  const { deps, mints } = fakeBlockHumanNotifySweepDeps({
    pending: [
      {
        epic_id: "fn-7-exh",
        task_id: "fn-7-exh.1",
        outcome: "owner_exhausted",
        instance_event_id: 1,
      },
    ],
    unblockOutcome: () => {
      throw new Error("owner_exhausted must page directly");
    },
    notify: async () => "notify_failed",
  });
  await runBlockHumanNotifySweep(deps);
  expect(mints).toEqual([
    { epicId: "fn-7-exh", taskId: "fn-7-exh.1", outcome: "notify_failed" },
  ]);
});

test("runBlockHumanNotifySweep: an owner_exhausted row cleared mid-sweep (stillPending false) is skipped — no page", async () => {
  const { deps, mints, notifies } = fakeBlockHumanNotifySweepDeps({
    pending: [
      {
        epic_id: "fn-7-exh",
        task_id: "fn-7-exh.1",
        outcome: "owner_exhausted",
        instance_event_id: 1,
      },
    ],
    stillPending: () => false,
    unblockOutcome: () => {
      throw new Error("owner_exhausted must page directly");
    },
  });
  await runBlockHumanNotifySweep(deps);
  expect(notifies).toEqual([]);
  expect(mints).toEqual([]);
});

test("runBlockHumanNotifySweep: RE-FENCES after the async notify — a clear + re-block during the send (stillPending true then false) sends the page but mints NOTHING for the replaced instance", async () => {
  // stillPending: true on the pre-await gate, false on the post-await re-check — the exact
  // clear + re-block-during-notify race the fence guards.
  const stillPendingReturns = [true, false];
  const notifies: {
    taskId: string;
    verdict: BlockNotifyVerdict;
    instance: number | null;
  }[] = [];
  const stillPendingCalls: (number | null)[] = [];
  const mints: {
    taskId: string;
    outcome: BlockHumanNotifiedOutcome;
    instance: number | null;
  }[] = [];
  await runBlockHumanNotifySweep({
    selectPending: () => [
      {
        epic_id: "fn-8-race",
        task_id: "fn-8-race.1",
        outcome: "owner_exhausted",
        instance_event_id: 42,
      },
    ],
    stillPending: (_epicId, _taskId, instanceEventId) => {
      stillPendingCalls.push(instanceEventId);
      return stillPendingReturns.shift() ?? false;
    },
    unblockOutcome: () => {
      throw new Error("owner_exhausted must page directly");
    },
    notifyHuman: async (row, verdict) => {
      notifies.push({
        taskId: row.task_id,
        verdict,
        instance: row.instance_event_id,
      });
      return "notified";
    },
    mintAttempted: (_epicId, taskId, outcome, instanceEventId) =>
      mints.push({ taskId, outcome, instance: instanceEventId }),
  });
  // The page was sent (the pre-await gate passed), but the POST-await re-fence saw the
  // instance was replaced, so NOTHING is minted — the replacement instance keeps its page.
  expect(notifies).toEqual([
    { taskId: "fn-8-race.1", verdict: "exhausted", instance: 42 },
  ]);
  expect(mints).toEqual([]);
  // Both the pre-await gate and the post-await re-check fenced on the exact instance.
  expect(stillPendingCalls).toEqual([42, 42]);
});

test("runBlockHumanNotifySweep: the terminal mint carries the exact instance token AND block-outcome (both fences threaded)", async () => {
  const mints: {
    taskId: string;
    outcome: BlockHumanNotifiedOutcome;
    instance: number | null;
    blockOutcome: string;
  }[] = [];
  await runBlockHumanNotifySweep({
    selectPending: () => [
      {
        epic_id: "fn-9-mint",
        task_id: "fn-9-mint.1",
        outcome: "owner_exhausted",
        instance_event_id: 77,
      },
    ],
    stillPending: () => true,
    unblockOutcome: () => {
      throw new Error("owner_exhausted must page directly");
    },
    notifyHuman: async () => "notified",
    mintAttempted: (_epicId, taskId, outcome, instanceEventId, blockOutcome) =>
      mints.push({ taskId, outcome, instance: instanceEventId, blockOutcome }),
  });
  expect(mints).toEqual([
    {
      taskId: "fn-9-mint.1",
      outcome: "notified",
      instance: 77,
      blockOutcome: "owner_exhausted",
    },
  ]);
});

test("runBlockHumanNotifySweep: HOLDS a row with a null/untrusted instance token — no page, no mint", async () => {
  for (const badInstance of [null, 0, -1] as (number | null)[]) {
    const { deps, mints, notifies } = fakeBlockHumanNotifySweepDeps({
      pending: [
        {
          epic_id: "fn-10-null",
          task_id: "fn-10-null.1",
          outcome: "owner_exhausted",
          instance_event_id: badInstance,
        },
      ],
      stillPending: () => {
        throw new Error("must HOLD before stillPending on an untrusted token");
      },
    });
    await runBlockHumanNotifySweep(deps);
    expect(notifies).toEqual([]);
    expect(mints).toEqual([]);
  }
});

test("runBlockHumanNotifySweep: stillPending receives the EXACT selected outcome and re-checks it after the await (outcome fence)", async () => {
  const stillPendingCalls: { instance: number | null; outcome: string }[] = [];
  const notifies: string[] = [];
  const mints: string[] = [];
  await runBlockHumanNotifySweep({
    selectPending: () => [
      {
        epic_id: "fn-11-of",
        task_id: "fn-11-of.1",
        outcome: "owner_exhausted",
        instance_event_id: 55,
      },
    ],
    stillPending: (_epicId, _taskId, instanceEventId, outcome) => {
      stillPendingCalls.push({ instance: instanceEventId, outcome });
      return true;
    },
    unblockOutcome: () => {
      throw new Error("owner_exhausted must page directly");
    },
    notifyHuman: async () => {
      notifies.push("sent");
      return "notified";
    },
    mintAttempted: (_epicId, _taskId, _o, _i, blockOutcome) =>
      mints.push(blockOutcome),
  });
  // Both the pre-await gate and the post-await re-fence carried the exact instance+outcome.
  expect(stillPendingCalls).toEqual([
    { instance: 55, outcome: "owner_exhausted" },
    { instance: 55, outcome: "owner_exhausted" },
  ]);
  expect(notifies).toEqual(["sent"]);
  expect(mints).toEqual(["owner_exhausted"]);
});

test("runBlockHumanNotifySweep: a same-instance outcome transition during the send (stillPending true then false) sends the page but mints NOTHING for the transitioned row", async () => {
  const stillPendingReturns = [true, false];
  const notifies: string[] = [];
  const mints: string[] = [];
  await runBlockHumanNotifySweep({
    selectPending: () => [
      {
        epic_id: "fn-12-tx",
        task_id: "fn-12-tx.1",
        outcome: "owner_exhausted",
        instance_event_id: 61,
      },
    ],
    stillPending: () => stillPendingReturns.shift() ?? false,
    unblockOutcome: () => {
      throw new Error("owner_exhausted must page directly");
    },
    notifyHuman: async () => {
      notifies.push("sent");
      return "notified";
    },
    mintAttempted: (_epicId, _taskId, _o, _i, blockOutcome) =>
      mints.push(blockOutcome),
  });
  expect(notifies).toEqual(["sent"]);
  expect(mints).toEqual([]);
});

test("runBlockHumanNotifySweep: wrapped in the non-reentrant tick, an overlapping send fires the page exactly ONCE (page-once under a hung/slow send)", async () => {
  let sends = 0;
  let releaseSend = () => {};
  const sendBlocked = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  const runOnce = () =>
    runBlockHumanNotifySweep({
      selectPending: () => [
        {
          epic_id: "fn-13-re",
          task_id: "fn-13-re.1",
          outcome: "owner_exhausted",
          instance_event_id: 88,
        },
      ],
      stillPending: () => true,
      unblockOutcome: () => {
        throw new Error("owner_exhausted must page directly");
      },
      notifyHuman: async () => {
        sends += 1;
        if (sends === 1) await sendBlocked; // simulate a slow / hung send
        return "notified";
      },
      mintAttempted: () => {},
    });
  // Same wrapper the production tick uses.
  const tick = createNonReentrantRepairSweepTick(runOnce);

  const first = tick(); // enters the send and blocks
  await tick(); // overlapping heartbeat → no-op, no second send
  expect(sends).toBe(1);

  releaseSend();
  await first;
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

function seedMergeFailureRow(
  db: ReturnType<typeof openDb>["db"],
  args: {
    verb: string;
    id: string;
    reason: string;
    dir?: string | null;
    /** The collapsed owner-attachment count (0/1/2) — the retired two once-marker
     *  slots. */
    ownerRedispatchAttempts?: number;
  },
): void {
  db.run(
    `INSERT INTO dispatch_failures
       (verb, id, reason, dir, ts, last_event_id, created_at, updated_at, owner_redispatch_attempts)
       VALUES (?, ?, ?, ?, 1, 1, 1, 1, ?)`,
    [
      args.verb,
      args.id,
      args.reason,
      args.dir ?? null,
      args.ownerRedispatchAttempts ?? 0,
    ],
  );
}

function ownerIncidentPage(
  overrides: Partial<PendingIncidentOwnerPage> = {},
): PendingIncidentOwnerPage {
  return {
    verb: "work",
    id: "fn-1350-owner.1",
    reason: mergeConflictReason(
      "keeper/epic/fn-1350-owner--fn-1350-owner.2",
      "keeper/epic/fn-1350-owner",
    ),
    dir: "/repo/lane",
    claimSessionId: null,
    instanceEventId: 50,
    ownerRedispatchAttempts: 2,
    humanNotifiedAt: null,
    ...overrides,
  };
}

function routerTask(overrides: Partial<Task> = {}): Task {
  return {
    task_id: "fn-1350-owner.1",
    epic_id: "fn-1350-owner",
    task_number: 1,
    title: "integrate",
    target_repo: null,
    tier: null,
    model: null,
    worker_phase: "open",
    runtime_status: "todo",
    depends_on: [],
    jobs: [],
    ...overrides,
  };
}

function routerEpic(overrides: Partial<Epic> = {}): Epic {
  return {
    epic_id: "fn-1350-owner",
    epic_number: 1350,
    title: "owner router",
    project_dir: "/repo",
    status: "open",
    last_event_id: 1,
    updated_at: 1,
    depends_on_epics: [],
    tasks: [routerTask()],
    jobs: [],
    job_links: [],
    resolved_epic_deps: null,
    last_validated_at: "2026-07-19T00:00:00Z",
    question: null,
    blocks_closing_of: null,
    ...overrides,
  };
}

function routerSnapshot(
  epics: Epic[],
  incidentOwnerKeys: Set<string>,
  failedKeys: Set<string> = new Set(incidentOwnerKeys),
): ReconcileSnapshot {
  return {
    readinessDegraded: false,
    epics,
    jobs: new Map(),
    subagentInvocations: [],
    gitStatusByProjectDir: new Map(),
    failedKeys,
    incidentOwnerKeys,
    claimedIncidentKeys: new Set(),
    recoverFailureIds: new Set(),
    finalizeFailureIds: new Set(),
    slotOccupancyFailures: [],
    liveTabKeys: new Set(),
    dispatchClaims: new Map(),
    harnessActivityByJobId: new Map(),
    livePaneIds: new Set(),
    paneCommandById: new Map(),
    provenDeadJobIds: new Set(),
    pendingDispatches: [],
    mode: "yolo",
    armedIds: new Set(),
    unseededRoots: new Set(),
    workModel: WORKER_MODEL,
    workEffort: WORKER_EFFORT,
    closeModel: WORKER_MODEL,
    closeEffort: WORKER_EFFORT,
    hostMatrix: {
      ok: true,
      models: ["opus", "sonnet"],
      effortsByModel: new Map(),
      efforts: ["low", "medium", "high", "xhigh", "max"],
      driverByModel: new Map([
        ["opus", "native"],
        ["sonnet", "native"],
      ]),
    },
    maxConcurrentJobs: null,
    maxConcurrentPerRoot: 1,
    worktreeMode: false,
    worktreeRepoByEpicId: new Map(),
  };
}

function routerState(paused = false): ReconcileState {
  return {
    paused,
    inFlight: new Set(),
    redispatchCooldown: new Map(),
    finalizerGuard: new Map(),
    maxConcurrentJobs: null,
    maxConcurrentPerRoot: 1,
    fatalAuditFenceMemo: new Map(),
  };
}

test("owner incident attachment slots are classified by typed row route and bounded durably", () => {
  const first = ownerIncidentPage({ ownerRedispatchAttempts: 0 });
  expect(nextIncidentOwnerAttachmentMarker(first)).toBe("resolver");
  expect(
    nextIncidentOwnerAttachmentMarker({
      ...first,
      ownerRedispatchAttempts: 1,
    }),
  ).toBe("merge");
  // The default page (2 attachments) is exhausted → no further slot.
  expect(nextIncidentOwnerAttachmentMarker(ownerIncidentPage())).toBeNull();
  expect(
    nextIncidentOwnerAttachmentMarker({
      ...first,
      reason: "tooling-failure: surface and stop",
    }),
  ).toBeNull();
  expect(
    nextIncidentOwnerAttachmentMarker({
      ...first,
      claimSessionId: "live-owner",
    }),
  ).toBeNull();
  expect(INCIDENT_OWNER_ATTACHMENT_LIMIT).toBe(2);
});

test("reconcile routes only exact owner incidents through ordinary work/close dispatch and pause holds both", () => {
  const workKey = "work::fn-1350-owner.1";
  const work = reconcile(
    routerSnapshot([routerEpic()], new Set([workKey])),
    routerState(),
    100,
  );
  expect(work.launches.map((launch) => launch.key)).toEqual([workKey]);
  expect(work.launches[0]?.verb).toBe("work");

  const paused = reconcile(
    routerSnapshot([routerEpic()], new Set([workKey])),
    routerState(true),
    100,
  );
  expect(paused.launches).toEqual([]);
  expect(paused.withholds.get("fn-1350-owner.1")?.code).toBe(
    "autopilot-paused",
  );

  const suppressed = reconcile(
    routerSnapshot([routerEpic()], new Set(), new Set([workKey])),
    routerState(),
    100,
  );
  expect(suppressed.launches).toEqual([]);
  expect(suppressed.withholds.get("fn-1350-owner.1")?.code).toBe("failed-key");

  const closeKey = "close::fn-1350-owner";
  const done = routerEpic({
    status: "done",
    tasks: [
      routerTask({
        worker_phase: "done",
        runtime_status: "done",
      }),
    ],
  });
  const close = reconcile(
    routerSnapshot([done], new Set([closeKey])),
    routerState(),
    100,
  );
  expect(close.launches.map((launch) => launch.key)).toEqual([closeKey]);
  expect(close.launches[0]?.verb).toBe("close");
});

test("exhausted incident attachments page once after the owner yields and never dispatch an escalation verb", async () => {
  const row = ownerIncidentPage();
  const paged = new Set<string>();
  const notified: string[] = [];
  const minted: string[] = [];
  const deps: IncidentOwnerPageSweepDeps = {
    selectPending: () => (paged.has(`${row.verb}::${row.id}`) ? [] : [row]),
    stillPending: () => true,
    ownerActive: () => false,
    notifyHuman: async (candidate) => {
      notified.push(buildIncidentOwnerPageBody(candidate));
      return "notified";
    },
    mintNotified: (candidate, outcome) => {
      minted.push(`${candidate.verb}::${candidate.id}:${outcome}`);
      if (outcome === "notified") {
        paged.add(`${candidate.verb}::${candidate.id}`);
      }
    },
  };
  await runIncidentOwnerPageSweep(deps);
  await runIncidentOwnerPageSweep(deps);
  expect(minted).toEqual(["work::fn-1350-owner.1:notified"]);
  expect(notified).toHaveLength(1);
  expect(notified[0]).toContain("No escalation session was launched");
  expect(notified[0]).not.toContain("resolve::");
  expect(notified[0]).not.toContain("deconflict::");
});

test("incident owner page selector excludes claims, non-incidents, and unexhausted attachments", () => {
  const { db } = freshMemDb();
  // Exhausted (both slots consumed → count at the limit), unclaimed incident.
  seedMergeFailureRow(db, {
    verb: "work",
    id: "fn-1350-owner.1",
    reason: ownerIncidentPage().reason,
    dir: "/repo/lane",
    ownerRedispatchAttempts: 2,
  });
  // Unexhausted (one slot) — excluded from the page selector.
  seedMergeFailureRow(db, {
    verb: "close",
    id: "fn-1350-owner",
    reason: ownerIncidentPage({ verb: "close" }).reason,
    ownerRedispatchAttempts: 1,
  });
  // Exhausted count but NOT an incident reason — excluded.
  seedMergeFailureRow(db, {
    verb: "work",
    id: "fn-1350-other.1",
    reason: "launch_failed: not an incident",
    ownerRedispatchAttempts: 2,
  });
  db.run(
    "UPDATE dispatch_failures SET claim_session_id = 'owner' WHERE verb = 'work' AND id = 'fn-1350-owner.1'",
  );
  expect(selectPendingIncidentOwnerPages(db)).toEqual([]);
  db.run(
    "UPDATE dispatch_failures SET claim_session_id = NULL WHERE verb = 'work' AND id = 'fn-1350-owner.1'",
  );
  expect(selectPendingIncidentOwnerPages(db).map((row) => row.id)).toEqual([
    "fn-1350-owner.1",
  ]);
  db.close();
});

test("incident owner page sweep defers while the final ordinary owner is active", async () => {
  const notified: string[] = [];
  await runIncidentOwnerPageSweep({
    selectPending: () => [ownerIncidentPage()],
    stillPending: () => true,
    ownerActive: () => true,
    notifyHuman: async () => {
      notified.push("unexpected");
      return "notified";
    },
    mintNotified: () => notified.push("unexpected-mint"),
  });
  expect(notified).toEqual([]);
});

// ---- duplicate-spawn-name pair coexistence (autoclose off) -------------------
// fn-1171.6 second audit strand — a re-block while an old idle `unblock::<task>`
// session still lingers (autoclose off) launches a SECOND session with the SAME spawn
// name. Task .2 already proves the jobs fold stamps two rows with distinct job_ids +
// escalation_instances (test/reducer-projections.test.ts). This proves the CONSUMERS
// this task touches — turn-active occupancy guards + instance-scoped stage-3 — stay
// correct with the pair coexisting: no starvation, no double-count, no cross-adoption.

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

// ---- fn-1129 escalation cap/occupancy/classify (pure helpers over a jobs set) --

function escJob(planVerb: string, planRef: string, state: string): Job {
  return {
    plan_verb: planVerb,
    plan_ref: planRef,
    state,
    backend_exec_pane_id: null,
  } as unknown as Job;
}

function _escJobCwd(
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

// ---------------------------------------------------------------------------
// Worker selection is a pure boot decision. The actual worker constructors are
// production wiring and are deliberately not booted by the fast suite.
// ---------------------------------------------------------------------------

test("worker selection defaults to the complete ordered worker set", () => {
  expect(selectWorkerNames()).toEqual([...ALL_WORKERS]);
  expect(selectWorkerNames()).toHaveLength(21);
});

test("worker selection retains only requested workers in production order", () => {
  expect(selectWorkerNames(["plan", "wake", "server"])).toEqual([
    "wake",
    "server",
    "plan",
  ]);
  expect(selectWorkerNames(["wake", "server"])).toEqual(["wake", "server"]);
});

test("spill documents reject escapes, empty content, and oversized content without daemon boot", () => {
  const paths: Record<string, string> = {
    "/spill": "/spill",
    "/spill/../escape.md": "/escape.md",
    "/spill/empty.md": "/spill/empty.md",
    "/spill/big.md": "/spill/big.md",
  };
  const canonicalize = (path: string): string => paths[path] ?? path;
  const read = (path: string): string =>
    path.endsWith("empty.md") ? "" : path.endsWith("big.md") ? "12345" : "ok";
  expect(
    readSpillDocument("await", "/spill", "/spill/../escape.md", 4, {
      canonicalize,
      read,
    }),
  ).toMatchObject({
    ok: false,
    error: expect.stringContaining("outside the spill dir"),
  });
  expect(
    readSpillDocument("await", "/spill", "/spill/empty.md", 4, {
      canonicalize,
      read,
    }),
  ).toMatchObject({
    ok: false,
    error: expect.stringContaining("is empty"),
  });
  expect(
    readSpillDocument("await", "/spill", "/spill/big.md", 4, {
      canonicalize,
      read,
    }),
  ).toMatchObject({
    ok: false,
    error: expect.stringContaining("over the 4-byte cap"),
  });
  expect(
    readSpillDocument("await", "/spill", "/spill/ok.md", 4, {
      canonicalize,
      read,
    }),
  ).toEqual({
    ok: true,
    text: "ok",
  });
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

// ---- 13c: origin-containment-stuck daemon lifecycle wiring ----

test("gcUnretryableDispatchFailures: the origin-containment-stuck row survives boot GC (producer-owned)", () => {
  const { db } = freshMemDb();
  const insert = db.prepare(
    `INSERT INTO dispatch_failures (verb, id, reason, dir, ts, last_event_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 100, ?, 100, 100)`,
  );
  const originId = `${ORIGIN_CONTAINMENT_DISTRESS_ID_PREFIX}abc123`;
  insert.run(
    ORIGIN_CONTAINMENT_DISTRESS_VERB,
    originId,
    `${ORIGIN_CONTAINMENT_DISTRESS_REASON}: /repo origin is behind local main`,
    "/repo",
    30,
  );
  const cleared: { verb: string; id: string }[] = [];
  const swept = gcUnretryableDispatchFailures(db, (verb, id) =>
    cleared.push({ verb, id }),
  );
  // A LIVE producer (the containment sweep + its waker) owns the clear — boot GC must not
  // reap it out from under the level-trigger.
  expect(swept).toBe(0);
  expect(cleared.some((c) => c.id === originId)).toBe(false);
  db.close();
});

test("buildSharedCheckoutPageBody: an origin-containment row pages ORIGIN wording, never dirty/desync", () => {
  const body = buildSharedCheckoutPageBody({
    id: `${ORIGIN_CONTAINMENT_DISTRESS_ID_PREFIX}abc123`,
    dir: "/repo",
    reason: `${ORIGIN_CONTAINMENT_DISTRESS_REASON}: /repo local main leads origin`,
  });
  expect(body).toContain("/repo");
  expect(body).toContain("origin");
  expect(body.toLowerCase()).toContain("publish");
  // NOT the shared-checkout dirty/desync hazard wording (the false-page hazard this arm avoids).
  expect(body).not.toContain("DIRTY");
  expect(body).not.toContain("DESYNCED");
  expect(body).not.toContain("sweep landed work back");
});

test("runSharedCheckoutPageSweep: an origin-containment-stuck row pages EXACTLY once, notify-failure retries, positive clear re-arms", async () => {
  let attempt = 0;
  const { deps, mints, pages, live } = fakeSharedCheckoutPageDeps({
    rows: [sharedCheckoutRow(`${ORIGIN_CONTAINMENT_DISTRESS_ID_PREFIX}abc`)],
    notify: async () => (++attempt === 1 ? "notify_failed" : "notified"),
  });
  const id = `${ORIGIN_CONTAINMENT_DISTRESS_ID_PREFIX}abc`;
  // Tick 1: the agentbot send FAILS → non-terminal, the row stays unpaged.
  await runSharedCheckoutPageSweep(deps);
  expect(pages).toEqual([id]);
  expect(mints).toEqual([{ id, outcome: "notify_failed" }]);
  // Tick 2: still unpaged → pages AGAIN, succeeds, stamped → drops out.
  await runSharedCheckoutPageSweep(deps);
  expect(pages).toEqual([id, id]);
  expect(mints[1]).toEqual({ id, outcome: "notified" });
  // Tick 3: stamped → silent (page-once per row instance).
  await runSharedCheckoutPageSweep(deps);
  expect(pages).toHaveLength(2);
  // The producer's positive-containment level-clear DELETEs the row; a fresh episode re-mints
  // at human_notified_at NULL → pages ANEW.
  live.set(id, sharedCheckoutRow(id));
  await runSharedCheckoutPageSweep(deps);
  expect(pages).toEqual([id, id, id]);
});

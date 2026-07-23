/**
 * Autopilot reconciler worker — the IMPURE remainder around the pure verdict core
 * (`src/reconcile-core.ts`, which owns `reconcile` + the lane geometry + the pure
 * predicates). Runs as a Bun Worker thread and drives the level-triggered dispatch
 * loop server-side: each `data_version` pulse builds a `ReconcileSnapshot`
 * (`loadReconcileSnapshot` — the git / DB / liveness reads), hands it to the pure
 * `reconcile`, then `runReconcileCycle` + `confirmRunning` provision worktree
 * lanes, launch each planned worker, and confirm it bound.
 *
 * `confirmRunning` captures the `events.id` watermark BEFORE the launch (so a
 * stale/resumed `jobs` row for the same `(plan_verb, plan_ref)` is excluded —
 * only a post-watermark SessionStart proves THIS dispatch landed), mints a
 * durable `Dispatched` intent and BLOCKS on its ack BEFORE launching (outbox
 * ordering closes the SessionStart-drains-before-`Dispatched` race), then polls
 * `findJob` until a bind lands or the ceiling elapses. See `ConfirmOutcome` for
 * the result set.
 *
 * Correlation: the reducer derives `(plan_verb, plan_ref)` from the `--name
 * verb::id` baked into the worker argv at SessionStart. There is NO
 * `jobs.spawn_name` column — the pair IS the correlation, so confirm/dedup gates
 * on `plan_verb` too (not just `plan_ref`).
 *
 * Determinism: the reconciler NEVER writes a projection — it mints synthetic
 * events (via deps that bridge to main, the sole events-log writer); the reducer
 * folds them. The producer-side `ts` (`deps.now()`) is stamped at reconcile time
 * so a re-fold reproduces the projection byte-identically. Wall-clock, git, and
 * liveness probes live ONLY here in the producer paths — the pure core reads none
 * of them.
 *
 * Worker contract: `isMainThread`-guarded body; own read-only `openDb`; typed
 * messages `{ kind }` worker→main, `{ type }` main→worker; supervisor-owned
 * lifecycle (the shutdown handler aborts in-flight confirms and the poll loop
 * exits); no in-process self-heal.
 *
 * Boots from `workerData.paused`, which main seeds from the durable
 * `autopilot_state.paused` column — so the reconciler resumes the last durable
 * state across a daemon restart (an intentional `play` survives), and a fresh
 * board boots PAUSED. The worker's own copy of the flag is in-memory only;
 * main is the durable owner and flips the worker via `set-paused` on a steady-
 * state pause/play.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { clearDeadSessionMarker } from "../plugins/plan/src/session_markers.ts";
import {
  buildRouteByModel,
  loadMatrixV2,
  MatrixConfigError,
} from "./agent/matrix";
import { computeEligibleEpics } from "./armed-closure";
import { epicStarted } from "./await-conditions";
import {
  BackstopCounters,
  type BackstopMessage,
  buildTimeoutRecord,
} from "./backstop-telemetry";
import {
  type BaselineRequest,
  buildRequest,
  currentToolchain,
  isValidSha,
  newRequestId,
  requestPath,
  type ToolchainFingerprint,
  writeRequest,
} from "./baseline-store";
import {
  classifyRun,
  parseGateOutput,
  readTestGateCommand,
  runDetached,
  type SpawnFn,
} from "./baseline-worker";
import { CommitWorkLock } from "./commit-work/flock";
import {
  GIT_LOCAL_TIMEOUT_MS,
  GIT_PUSH_TIMEOUT_MS,
  GIT_SPAWN_TIMEOUT_CODE,
  gitExec,
  type GitRunner as WorktreeGitRunner,
} from "./commit-work/git-exec";
import {
  describePushNotReady,
  type PushNotReadyReason,
  remotePushTurnKey,
} from "./commit-work/push";
import {
  DEFAULT_MAX_CONCURRENT_JOBS,
  DEFAULT_MAX_CONCURRENT_PER_ROOT,
  openDb,
} from "./db";
import { parsePlanRef } from "./derivers";
import {
  assertNever,
  buildPendingIntegrationTail,
  classifyPendingIntegration,
  DUP_EPIC_NUMBER_DISTRESS_ID_PREFIX,
  DUP_EPIC_NUMBER_DISTRESS_REASON,
  epicIdFromFatalAuditId,
  FATAL_AUDIT_REASON_TOKEN,
  fatalAuditDispatchId,
  isDupEpicNumberDistressKey,
  isFullObjectId,
  isLaneTeardownDistressKey,
  isLaneWedgeDistressKey,
  isMonitorSlotWedgeDistressKey,
  isOriginContainmentDistressKey,
  isSharedDesyncDistressKey,
  isSharedDirtyDistressKey,
  isSharedWedgeDistressKey,
  isSlotOccupancyReason,
  isStaleBaseDistressKey,
  isStuckSentinelDistressKey,
  isWorktreeLanePremergeReason,
  isZombieSessionDistressKey,
  LANE_BACKUP_DISTRESS_ID_PREFIX,
  LANE_BACKUP_DISTRESS_REASON,
  LANE_TEARDOWN_DISTRESS_ID_PREFIX,
  LANE_TEARDOWN_DISTRESS_REASON,
  LANE_WEDGE_DISTRESS_ID_PREFIX,
  LANE_WEDGE_DISTRESS_REASON,
  MERGE_ESCALATION_REASON_TOKEN,
  MONITOR_SLOT_WEDGE_DISTRESS_ID_PREFIX,
  MONITOR_SLOT_WEDGE_DISTRESS_REASON,
  monitorSlotWedgeJobId,
  ORIGIN_CONTAINMENT_DISTRESS_ID_PREFIX,
  ORIGIN_CONTAINMENT_DISTRESS_REASON,
  parseMergeConflictReason,
  parsePendingIntegrationHeads,
  routeDispatchFailure,
  SHARED_DESYNC_DISTRESS_ID_PREFIX,
  SHARED_DESYNC_DISTRESS_REASON,
  SHARED_DIRTY_DISTRESS_ID_PREFIX,
  SHARED_DIRTY_DISTRESS_REASON,
  SHARED_WEDGE_DISTRESS_ID_PREFIX,
  SHARED_WEDGE_DISTRESS_REASON,
  STALE_BASE_DISTRESS_ID_PREFIX,
  STALE_BASE_DISTRESS_REASON,
  STUCK_SENTINEL_DISTRESS_VERB,
  stuckSentinelJobId,
  WORKTREE_FINALIZE_ID_PREFIX,
  WORKTREE_FINALIZE_SUITE_RED_REASON,
  WORKTREE_LANE_PREMERGE_REASON_PREFIX,
  WORKTREE_PRECLOSE_ID_PREFIX,
  WORKTREE_RECOVER_KEY_PREFIX,
  ZOMBIE_SESSION_DISTRESS_ID_PREFIX,
  ZOMBIE_SESSION_DISTRESS_REASON,
  zombieSessionJobId,
} from "./dispatch-failure-key";
import { resolveDispatchLaunchConfig } from "./dispatch-launch-config";
import {
  classifyProcessIdentity,
  compareCanonicalGeneration,
  createTmuxPaneOps,
  keeperAgentLaunch,
  type LaunchSpec,
  MANAGED_EXEC_SESSION,
  type PaneInfo,
  type TmuxPaneOps,
} from "./exec-backend";
import { localBranchState, memoizedNullableGitToplevel } from "./git-toplevel";
import { readTrunkLeaseLeaf } from "./grant-leaf";
import { keeperStateDir } from "./keeper-state-dir";
import {
  classifyProviderPin,
  loadProviderEquivalenceSnapshot,
} from "./provider-equivalence";
import {
  findLongUnknownMonitorOccupants,
  type LongUnknownMonitorOccupant,
} from "./readiness";
import {
  type DispatchClaim,
  loadReadinessInputs,
  type ReadinessQuery,
} from "./readiness-inputs";
import {
  type BaseDriftEntry,
  boundedFields,
  boundFatalAuditExcerpt,
  buildPlannedLaunchSpec,
  buildWorkerCommand,
  type CloseReceipt,
  closerJobFinished,
  type DispatchKey,
  dispatchKey,
  type EpicRecoverVerdict,
  epicHasOccupyingJob,
  epicResourceTeardownBlocked,
  type FatalAuditFenceMemoEntry,
  FINALIZER_GUARD_S,
  fatalHaltReceiptIsCurrent,
  type HostMatrixSnapshot,
  isBareShellCommand,
  isFinalizerVerb,
  isOwnerRoutableIncident,
  isStoppedJobLive,
  isWrappedCell,
  KEEPER_ROOT,
  type LaneMergedEntry,
  nextIncidentOwnerAttachmentMarker,
  type PlannedLaunch,
  parentBranchFor,
  prepareWorktreeGeometry,
  REDISPATCH_COOLDOWN_S,
  type ReconcileDecision,
  type ReconcileSnapshot,
  type ReconcileState,
  type ResourceHoldObservation,
  reconcile,
  recoverFailureDispatchId,
  SLOT_RECLAIM_GRACE_SEC,
  SLOT_RECLAIM_MAX_PER_SWEEP,
  type StaleBaseLaneEntry,
  type Verb,
  type WithholdReason,
  type WithholdReasonCode,
  WORKER_EFFORT,
  WORKER_MODEL,
  type WorktreeLaunchInfo,
  type WorktreeRecoveryEscalation,
  type WorktreeRecoveryFailure,
  type WorktreeRecoveryOutcome,
  type WorktreeRecoveryResolution,
  type WorktreeRepoGroup,
  type WorktreeRepoResolution,
  type WorktreeRepoStatusEntry,
  withDispatchAttempt,
  withhold,
  worktreeRecoverDispatchId,
  worktreeRecoverEpicDispatchId,
  wrappedEnvelopePath,
} from "./reconcile-core";
import { readOsStartTime } from "./seed-sweep";
import { isPidAlive, runQuery } from "./server-worker";
import type { HarnessActivity } from "./session-activity";
import type { Epic, Job, Task } from "./types";
import { watchLoop } from "./wake-worker";
import {
  createWorkPluginShadowProbe,
  defaultWorkPluginManifestInventory,
  findShadowingWorkManifest,
  inventoryLaunchCwdWorkPluginManifests,
  physicalPluginDir,
  providerPinUnknownReason,
  providerRejectReason,
  providerUnlaunchableReason,
  resolveWorkerCell,
  selectedWorkerCellFreshness,
  verifyWorkerCellCohort,
  WORKER_CELL_COMPILE_COMMAND,
  type WorkerCellCohortVerification,
  type WorkPluginManifestInventory,
} from "./worker-cell";
import {
  ELIGIBLE_REASON,
  memoizedAssessRepo,
  NO_MANIFEST_REASON,
  type WorktreeEligibility,
} from "./worktree-eligibility";
import {
  baselineScratchPathFor,
  type EpicLaneBranchSet,
  epicIdFromKeeperLaneEntry,
  type GitReadOutcome,
  abortInterruptedMerge as gitAbortInterruptedMerge,
  backupThenForceRemoveWorktree as gitBackupThenForceRemoveWorktree,
  baseMergeLockPath as gitBaseMergeLockPath,
  branchExists as gitBranchExists,
  classifyLaneOwnership as gitClassifyLaneOwnership,
  classifyLinkedWorktree as gitClassifyLinkedWorktree,
  commitWorkLockPath as gitCommitWorkLockPath,
  currentBranch as gitCurrentBranch,
  currentBranchResult as gitCurrentBranchResult,
  deleteBranch as gitDeleteBranch,
  ensureWorktree as gitEnsureWorktree,
  ensureWorktreeDepLink as gitEnsureWorktreeDepLink,
  ensureWorktreeResult as gitEnsureWorktreeResult,
  enumerateEpicLaneBranches as gitEnumerateEpicLaneBranches,
  isAncestorOf as gitIsAncestorOf,
  laneDirtSnapshotId as gitLaneDirtSnapshotId,
  listEpicBaseBranches as gitListEpicBaseBranches,
  listEpicLaneBranches as gitListEpicLaneBranches,
  listWorktrees as gitListWorktrees,
  listWorktreesResult as gitListWorktreesResult,
  losslessPremergeClean as gitLosslessPremergeClean,
  measureBaseDrift as gitMeasureBaseDrift,
  mergeBranchInto as gitMergeBranchInto,
  mergePinnedObjectFenced as gitMergePinnedObjectFenced,
  mergeReadiness as gitMergeReadiness,
  parseWorktreeList as gitParseWorktreeList,
  probeLaneMergeHead as gitProbeLaneMergeHead,
  probeLosslesslyCleanableUntracked as gitProbeLosslesslyCleanableUntracked,
  pruneWorktreeHusk as gitPruneWorktreeHusk,
  pruneWorktrees as gitPruneWorktrees,
  remotePushFastForwardable as gitRemotePushFastForwardable,
  removeWorktree as gitRemoveWorktree,
  resolveDefaultBranch as gitResolveDefaultBranch,
  supportsMergeTreeWriteTree as gitSupportsMergeTreeWriteTree,
  isKeeperLaneEntry,
  keeperLaneIdentity,
  type LockAcquirer,
  type MergeReadiness,
  provisionScratchWorktree,
  removeScratchWorktree,
  shortBranchName,
  type WorktreeEntry,
} from "./worktree-git";
import {
  baseBranchFor,
  repoDirHash,
  ribBranchFor,
  type WorktreeAssignment,
  type WorktreePlan,
  worktreePathFor,
  worktreePrecloseDispatchId,
} from "./worktree-plan";

// The dispatch-failure vocabulary + typed row router live in the dep-free
// `./dispatch-failure-key` leaf; re-exported here so every existing
// `from "./autopilot-worker"` import (tests, daemon) keeps resolving. The snapshot
// loader routes recover/finalize failure rows through `routeDispatchFailure`.
export {
  DUP_EPIC_NUMBER_DISTRESS_ID_PREFIX,
  DUP_EPIC_NUMBER_DISTRESS_REASON,
  DUP_EPIC_NUMBER_DISTRESS_VERB,
  isDupEpicNumberDistressKey,
  isLaneTeardownDistressKey,
  isLaneWedgeDistressKey,
  isMonitorSlotWedgeDistressKey,
  isOriginContainmentDistressKey,
  isSharedDesyncDistressKey,
  isSharedDirtyDistressKey,
  isSharedWedgeDistressKey,
  isSlotOccupancyReason,
  isStaleBaseDistressKey,
  isStuckSentinelDistressKey,
  isWorktreeLanePremergeReason,
  isWorktreeRecoverReason,
  isZombieSessionDistressKey,
  LANE_BACKUP_DISTRESS_ID_PREFIX,
  LANE_BACKUP_DISTRESS_REASON,
  LANE_TEARDOWN_DISTRESS_ID_PREFIX,
  LANE_TEARDOWN_DISTRESS_REASON,
  LANE_TEARDOWN_DISTRESS_VERB,
  LANE_WEDGE_DISTRESS_ID_PREFIX,
  LANE_WEDGE_DISTRESS_REASON,
  LANE_WEDGE_DISTRESS_VERB,
  MONITOR_SLOT_WEDGE_DISTRESS_ID_PREFIX,
  MONITOR_SLOT_WEDGE_DISTRESS_REASON,
  MONITOR_SLOT_WEDGE_DISTRESS_VERB,
  ORIGIN_CONTAINMENT_DISTRESS_ID_PREFIX,
  ORIGIN_CONTAINMENT_DISTRESS_REASON,
  ORIGIN_CONTAINMENT_DISTRESS_VERB,
  SHARED_DESYNC_DISTRESS_ID_PREFIX,
  SHARED_DESYNC_DISTRESS_REASON,
  SHARED_DESYNC_DISTRESS_VERB,
  SHARED_DIRTY_DISTRESS_ID_PREFIX,
  SHARED_DIRTY_DISTRESS_REASON,
  SHARED_DIRTY_DISTRESS_VERB,
  SHARED_WEDGE_DISTRESS_ID_PREFIX,
  SHARED_WEDGE_DISTRESS_REASON,
  SHARED_WEDGE_DISTRESS_VERB,
  STALE_BASE_DISTRESS_ID_PREFIX,
  STALE_BASE_DISTRESS_REASON,
  STALE_BASE_DISTRESS_VERB,
  STUCK_SENTINEL_DISTRESS_ID_PREFIX,
  STUCK_SENTINEL_DISTRESS_VERB,
  stuckSentinelJobId,
  WORKTREE_FINALIZE_ID_PREFIX,
  WORKTREE_FINALIZE_SUITE_RED_REASON,
  WORKTREE_PRECLOSE_ID_PREFIX,
  WORKTREE_RECOVER_REASON_PREFIX,
  ZOMBIE_SESSION_DISTRESS_ID_PREFIX,
  ZOMBIE_SESSION_DISTRESS_REASON,
  ZOMBIE_SESSION_DISTRESS_VERB,
  zombieSessionJobId,
} from "./dispatch-failure-key";
export type {
  BaseDriftEntry,
  CloseReceipt,
  DispatchKey,
  EpicRecoverVerdict,
  HostMatrixSnapshot,
  LaneMergedEntry,
  PlannedLaunch,
  ReconcileDecision,
  ReconcileSnapshot,
  ReconcileState,
  ResolverOutcome,
  SlotOccupancyDecision,
  SlotOccupancyInput,
  SlotOccupancySignal,
  StaleBaseLaneEntry,
  Verb,
  WithholdReason,
  WithholdReasonCode,
  WorktreeLaunchInfo,
  WorktreeRecoveryEscalation,
  WorktreeRecoveryFailure,
  WorktreeRecoveryOutcome,
  WorktreeRecoveryResolution,
  WorktreeReject,
  WorktreeRepoGroup,
  WorktreeRepoResolution,
  WorktreeRepoStatusEntry,
} from "./reconcile-core";
// The pure verdict core lives in `./reconcile-core`; re-exported here so every
// existing `from "./autopilot-worker"` import (tests, daemon, CLI) keeps resolving
// after the extraction. The impure remainder — snapshot loading, the git drivers,
// recover/finalize, the message pump — stays in this module.
export {
  boundFatalAuditExcerpt,
  buildPlannedLaunchSpec,
  buildWorkerCommand,
  classifyResolverOutcome,
  closerJobFinished,
  computeSlotOccupancy,
  dispatchKey,
  epicHasOccupyingJob,
  epicResourceTeardownBlocked,
  FINALIZER_GUARD_S,
  fatalHaltReceiptIsCurrent,
  isBareShellCommand,
  isEpicInFlight,
  isFatalAuditHeld,
  isFinalizerGuarded,
  isFinalizerVerb,
  isInCooldown,
  isOccupyingJob,
  isWrappedCell,
  KEEPER_ROOT,
  prepareWorktreeGeometry,
  REDISPATCH_COOLDOWN_S,
  reconcile,
  recoverFailureDispatchId,
  SLOT_RECLAIM_GRACE_SEC,
  SLOT_RECLAIM_MAX_PER_SWEEP,
  SLOT_RECLAIM_UNCONTENDED_GRACE_SEC,
  verbForVerdict,
  WORKER_EFFORT,
  WORKER_MODEL,
  workerCellPluginDir,
  worktreeRecoverDispatchId,
  worktreeRecoverEpicDispatchId,
} from "./reconcile-core";
// The producer-side worker-cell resolution seam lives in the filesystem-probing
// `./worker-cell` leaf (shared with the dispatch CLI). Re-export inventory helpers
// so existing producer-focused tests can import them from this module.
export { inventoryWorkPluginManifests } from "./worker-cell";
export { findShadowingWorkManifest };

/**
 * Prune finalizer-guard entries older than the guard window (mirror
 * {@link sweepRedispatchCooldown}). Run once per cycle so the Map stays bounded.
 * Mutates in place — called ONLY from `driveCycle`, never inside the pure
 * `reconcile`; the caller wraps it in try/catch (no self-heal).
 */
export function sweepFinalizerGuard(
  guard: Map<string, number>,
  now: number,
): void {
  for (const [epicId, stampedAt] of guard) {
    if (now - stampedAt >= FINALIZER_GUARD_S) {
      guard.delete(epicId);
    }
  }
}

/** Minimum seconds before the same target/reason pair may log again. */
export const WITHHOLD_LOG_RATE_LIMIT_S = 5 * 60;

/**
 * Producer-owned memory for the current machine frame and its stderr change gate.
 * Both maps are pruned to targets in the latest frame; each nested rate map is
 * bounded by the finite {@link WithholdReasonCode} vocabulary.
 */
export interface WithholdFrameState {
  current: Map<string, WithholdReason>;
  lastReasonByTarget: Map<string, WithholdReasonCode>;
  lastEmittedAtByTarget: Map<string, Map<WithholdReasonCode, number>>;
}

export function createWithholdFrameState(): WithholdFrameState {
  return {
    current: new Map(),
    lastReasonByTarget: new Map(),
    lastEmittedAtByTarget: new Map(),
  };
}

/**
 * Replace-merge one reconciler withhold frame and emit only reason transitions.
 * A fast A→B→A oscillation updates the current frame but the second A is
 * coalesced until its per-target/per-code rate window elapses.
 */
export function updateWithholdFrameState(
  state: WithholdFrameState,
  next: ReadonlyMap<string, WithholdReason>,
  nowSec: number,
  emit: (line: string) => void = (line) => console.error(line),
): void {
  const activeTargets = new Set(next.keys());
  for (const target of state.lastReasonByTarget.keys()) {
    if (!activeTargets.has(target)) state.lastReasonByTarget.delete(target);
  }
  for (const target of state.lastEmittedAtByTarget.keys()) {
    if (!activeTargets.has(target)) state.lastEmittedAtByTarget.delete(target);
  }

  state.current.clear();
  for (const [target, reason] of [...next.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    state.current.set(target, reason);
    if (state.lastReasonByTarget.get(target) === reason.code) continue;

    let emittedByCode = state.lastEmittedAtByTarget.get(target);
    if (emittedByCode === undefined) {
      emittedByCode = new Map();
      state.lastEmittedAtByTarget.set(target, emittedByCode);
    }
    const lastEmittedAt = emittedByCode.get(reason.code);
    if (
      lastEmittedAt === undefined ||
      nowSec - lastEmittedAt >= WITHHOLD_LOG_RATE_LIMIT_S
    ) {
      const detail = reason.detail === null ? "" : ` detail=${reason.detail}`;
      emit(
        `[autopilot-worker] withhold target=${target} reason=${reason.code} severity=${reason.severity}${detail}`,
      );
      emittedByCode.set(reason.code, nowSec);
    }
    state.lastReasonByTarget.set(target, reason.code);
  }
}

/**
 * Re-anchor the cooldown + per-epic finalizer guard to the DURABLE
 * `pending_dispatches` lifetime — the slow-cold-boot fix.
 *
 * The 2026-06-10 dup-close fired because a `close::<epic>` worker took 317s to
 * emit its first SessionStart (a far-tail `claude` cold boot under conn-cap
 * saturation). Its `pending_dispatches` row TTL-expired at ~120s (so `liveTabKeys`
 * lost the key), no `jobs` row had landed yet, and the cooldown — stamped at
 * dispatch and refreshed ONCE at the indoubt resolution (cover-end dispatch+260s)
 * — lapsed 1s before the re-dispatch at dispatch+261s. Every suppression arm was
 * legitimately clear; the single non-compounding indoubt re-stamp was the sole
 * cover and it was too short for the tail.
 *
 * The fix: each cycle, while a key still has an OPEN `pending_dispatches` row
 * (`openKeys`, sourced from `snapshot.liveTabKeys`), refresh its cooldown stamp to
 * `now` (and the finalizer guard for a `close::<epic>` key). Suppression then
 * tracks the phantom's ACTUAL durable lifetime instead of a fixed window measured
 * from dispatch. The last refresh lands on the final cycle before the producer-side
 * TTL sweep mints `DispatchExpired`, so cover extends `REDISPATCH_COOLDOWN_S` past
 * that point — covering the observed tail with margin.
 *
 * This is NOT the perpetual-suppression trap: the re-stamp is gated on a DURABLE
 * row the TTL sweep DETERMINISTICALLY discharges (bounded by
 * `PENDING_DISPATCH_TTL_MS` + the sweep granularity). Once the row is gone the key
 * drops out of `openKeys`, refreshing STOPS, and the final cooldown window runs
 * out — total bounded suppression is TTL + sweep + cooldown, never unbounded.
 *
 * Mutates both Maps in place — called ONLY from `driveCycle` (the cycle glue),
 * AFTER the sweeps and BEFORE the pure `reconcile` reads the Maps, never inside
 * `reconcile`; the caller wraps it in try/catch (no self-heal). `now` is
 * unix-SECONDS throughout, matching the cooldown/guard timestamps.
 */
export function refreshSuppressionForOpenPending(
  cooldown: Map<DispatchKey, number>,
  guard: Map<string, number>,
  openKeys: Set<DispatchKey>,
  now: number,
): void {
  for (const key of openKeys) {
    cooldown.set(key, now);
    // A `close::<epic>` key also re-anchors the per-epic finalizer guard (keyed by
    // epic id — everything after the first `::`). Other verbs touch only the
    // cooldown; `isFinalizerVerb` is the single source of truth for which verb is
    // an epic finalizer.
    const sep = key.indexOf("::");
    if (sep < 0) {
      continue;
    }
    const verb = key.slice(0, sep);
    if (isFinalizerVerb(verb as Verb)) {
      guard.set(key.slice(sep + 2), now);
    }
  }
}

/**
 * `~/code/arthack` root (kept for any non-plugin-dir callers and for tests
 * that pin the legacy variable). Env-overridable via `ARTHACK_ROOT`. `~`
 * is expanded eagerly at module load so the assembled string carries an
 * absolute path the launcher's cwd doesn't break.
 */
export const ARTHACK_ROOT: string = ((): string => {
  const raw = process.env.ARTHACK_ROOT;
  const v = raw != null && raw !== "" ? raw : "~/code/arthack";
  if (v === "~" || v.startsWith("~/")) {
    return v === "~" ? homedir() : join(homedir(), v.slice(2));
  }
  return v;
})();

/**
 * POSITIVE-EVIDENCE auto-clear set: given the OPEN recover-originated dispatch ids
 * (`snapshot.recoverFailureIds`), THIS cycle's fresh recover failures, and THIS
 * cycle's positive resolution observations, return the open ids the producer should
 * `DispatchCleared`. An open row clears ONLY when it appears in the `resolved` set
 * (the base merged, was already an ancestor of default, the epic read
 * authoritatively absent, or its repo swept clean of path-tied failures) AND is NOT
 * in the fresh-failure set (the never-clear-what-still-fails guard). Absence from
 * BOTH sets RETAINS the row: a cycle that produced no report for it never dismisses
 * it — the incident defect was an absence-based clear turning a silently-skipped
 * cycle into a clean-looking board. Content conflicts are structurally outside this
 * predicate (they escalate on the bare `close::<epic>` merge-escalation key, leaving
 * the recover scope), matching finalize's never-auto-dismissed close-sink. All three
 * keys route through {@link recoverFailureDispatchId} (the lockstep rule). Pure: a
 * function of the three inputs, no git, no clock.
 */
export function recoverFailuresToClear(
  openRecoverIds: ReadonlySet<string>,
  freshFailures: readonly WorktreeRecoveryFailure[],
  resolved: readonly WorktreeRecoveryResolution[],
): string[] {
  const stillFailing = new Set<string>();
  for (const f of freshFailures) {
    stillFailing.add(recoverFailureDispatchId(f));
  }
  const resolvedIds = new Set<string>();
  for (const r of resolved) {
    resolvedIds.add(recoverFailureDispatchId(r));
  }
  const cleared: string[] = [];
  for (const id of openRecoverIds) {
    if (resolvedIds.has(id) && !stillFailing.has(id)) {
      cleared.push(id);
    }
  }
  return cleared;
}

export function openRecoverRowFromFailure(
  id: string,
  dir: string,
): { id: string; epicId: string | null; dir: string } | null {
  if (dir === "") return null;
  if (id === worktreeRecoverDispatchId(dir)) {
    return { id, epicId: null, dir };
  }
  if (!id.startsWith(WORKTREE_RECOVER_KEY_PREFIX)) return null;
  const keyed = id.slice(WORKTREE_RECOVER_KEY_PREFIX.length);
  const hashSep = keyed.lastIndexOf("-");
  if (hashSep <= 0) return null;
  const epicId = keyed.slice(0, hashSep);
  return worktreeRecoverEpicDispatchId(epicId, dir) === id
    ? { id, epicId, dir }
    : null;
}

/**
 * POSITIVE-EVIDENCE verb-agnostic reason-scoped auto-clear for the fan-in LANE
 * pre-merge `work::<taskId>` rows — the exact discipline {@link
 * recoverFailuresToClear} enforces, keyed by the lane worktree PATH (a row's `dir`)
 * instead of a recover dispatch id. Given the OPEN lane-failure rows
 * (`snapshot.laneFailures`, collected off the {@link
 * WORKTREE_LANE_PREMERGE_REASON_PREFIX} reason so the scope stays disjoint from a
 * genuine merge conflict on the same key), this cycle's `wedged` lane paths (still
 * not-mergeable), and this cycle's `resolved` lane paths (ready or torn down),
 * return the `(verb, id)`s to `DispatchCleared`. A row clears ONLY when its normalized
 * `dir` is in `resolved` AND NOT in `wedged` — a cycle with no observation for it
 * RETAINS the row (absence is never resolution), so a paused / un-swept cycle never
 * dismisses a live block. Bypasses the router's `verb==="work"→work-task`
 * short-circuit entirely (it clears by REASON+path, never by route), so a lane row is
 * self-clearing without touching {@link routeDispatchFailure}. Pure — a function of
 * the three inputs, no git, no clock.
 */
export function laneFailuresToClear(
  openLaneFailures: readonly { verb: Verb; id: string; dir: string }[],
  wedgedLanePaths: ReadonlySet<string>,
  resolvedLanePaths: ReadonlySet<string>,
): { verb: Verb; id: string }[] {
  const cleared: { verb: Verb; id: string }[] = [];
  for (const row of openLaneFailures) {
    const key = normalizeLanePath(row.dir);
    if (resolvedLanePaths.has(key) && !wedgedLanePaths.has(key)) {
      cleared.push({ verb: row.verb, id: row.id });
    }
  }
  return cleared;
}

/**
 * A per-`work::`-row merge-incident resolution verdict from {@link
 * probeWorkMergeIncidentResolutions}:
 *   - `merged`        — the row's parsed SOURCE rib is an ancestor of its TARGET base
 *                       AND the target checkout is clean of merge residue.
 *   - `source-absent` — the source rib branch does not exist (proof only when
 *                       corroborated by lane-merged / task-terminal evidence).
 *   - `defer`         — every other state (not-yet-ancestor, dirty / mid-merge target,
 *                       unparseable reason, missing dir, or an inconclusive git read).
 */
export type WorkMergeIncidentVerdict = "merged" | "source-absent" | "defer";

/**
 * POSITIVE-EVIDENCE level-clear for the MERGE-ESCALATION stickies — a bare
 * `close::<epic>` conflict (recover pass-2 escalation / close-sink genuine conflict) or
 * a `work::<taskId>` fan-in `worktree-merge-conflict` row, the pre-minted `pending
 * owner integration` class included. NEVER on task/epic terminal status: done != merged
 * is the incident defect this replaces. Two-tier by verb:
 *
 *   - `close::<epic>` clears on EPIC-LANDED evidence (`landedEpicIds` —
 *     {@link computeMergedLaneEntries}: the epic base is an ancestor of local default,
 *     or absent-and-torn-down with its work done; unioned with this cycle's recover
 *     pass-2 base→default resolutions; conservative-degrades to NOT-merged on an
 *     inconclusive probe). This is deliberately conservative: a resolved close sticky
 *     lingers until the epic base actually LANDS, not at the earliest per-fan-in merge —
 *     bounded by the existing attachment/page-once machinery, strictly safer than the
 *     entity-terminal clear it replaces. Do NOT "optimize" this back to lane evidence.
 *
 *   - `work::<taskId>` clears on INCIDENT-SPECIFIC evidence FIRST — `workIncidentVerdicts`
 *     `merged` (its own source rib landed in its target base + a clean target checkout),
 *     so a resolved fan-in clears the SAME cycle even while its epic is still open. A
 *     `source-absent` verdict clears ONLY when corroborated (epic-landed OR the task is
 *     terminal in `taskTerminalIds`) — the source branch is the evidence carrier, so
 *     bare absence is not proof. EPIC-LANDED remains the straggler FALLBACK (a row the
 *     incident probe could only `defer`). A bare `defer` RETAINS.
 *
 * `blockedEpicIds` (a fresh conflict/degrade for the epic this cycle) blocks either
 * verb's clear — never clear what still conflicts; the level-trigger re-mints stay
 * legal. A `close::<epic>` id IS the epic; a `work::<taskId>` id resolves through
 * {@link parsePlanRef}; an unparseable id is skipped. Emitted through the same
 * `emitDispatchCleared` gate as the recover/lane clears, so `handleDispatchClearedMint`'s
 * incident-only fence leaves a live claimant's attempt-owned state untouched. Pure — a
 * function of the inputs, no git, no clock.
 */
export function mergeEscalationFailuresToClear(
  openRows: readonly { verb: Verb; id: string }[],
  landedEpicIds: ReadonlySet<string>,
  blockedEpicIds: ReadonlySet<string>,
  workIncidentVerdicts: ReadonlyMap<
    string,
    WorkMergeIncidentVerdict
  > = new Map(),
  taskTerminalIds: ReadonlySet<string> = new Set(),
): { verb: Verb; id: string }[] {
  const cleared: { verb: Verb; id: string }[] = [];
  for (const row of openRows) {
    const epicId = parsePlanRef(row.id)?.epic_id ?? null;
    if (epicId === null) continue;
    if (blockedEpicIds.has(epicId)) continue; // never clear what still conflicts
    const landed = landedEpicIds.has(epicId);
    if (row.verb === "work") {
      const verdict = workIncidentVerdicts.get(row.id) ?? "defer";
      if (
        verdict === "merged" ||
        landed ||
        (verdict === "source-absent" && taskTerminalIds.has(row.id))
      ) {
        cleared.push({ verb: row.verb, id: row.id });
      }
      continue;
    }
    if (landed) cleared.push({ verb: row.verb, id: row.id });
  }
  return cleared;
}

/**
 * Probe each OPEN `work::<taskId>` merge-escalation row for INCIDENT-SPECIFIC positive
 * resolution — the primary clear evidence per {@link mergeEscalationFailuresToClear},
 * bounded to the open merge-incident rows. Routes by the row's fence CLASS:
 *   - PINNED (a valid fence) — clears from the DURABLE OBJECTS only ({@link
 *     probePinnedMergeResolution}), never the movable source ref or branch absence.
 *   - MALFORMED / legacy pre-fence pending (pending class, no valid fence) — `defer`
 *     ALWAYS: a fence-less request has no authority to grade its own integration, so
 *     it clears only on epic-landed evidence (the caller's fallback) or an operator
 *     clear / re-mint, NEVER movable-branch or source-absence evidence.
 *   - UNPINNED genuine conflict — the legacy branch-name grading, reusing the ONE fan-in
 *     reason parser {@link parseMergeConflictReason}: (a) the parsed SOURCE rib is an
 *     ancestor of the TARGET base (`gitIsAncestorOf`; `false` covers not-ancestor AND an
 *     errored probe → `defer`), AND (b) the TARGET checkout (`dir`) is clean, on the base
 *     branch, no merge residue (`gitMergeReadiness` === `ready`) → `merged`; a missing
 *     SOURCE branch → `source-absent` (the caller corroborates); everything else → `defer`.
 * Producer-only live git READS, never a fold; NEVER throws past here.
 */
export async function probeWorkMergeIncidentResolutions(
  rows: readonly { id: string; reason: string; dir: string | null }[],
  run: WorktreeGitRunner = gitExec,
): Promise<Map<string, WorkMergeIncidentVerdict>> {
  const out = new Map<string, WorkMergeIncidentVerdict>();
  for (const row of rows) {
    // CLASSIFY FIRST — the tri-state fence class decides the routing before any
    // source probe. A MALFORMED / legacy pre-fence pending row (pending class, no
    // valid fence) produces its `defer` verdict with ZERO git calls: it is EXCLUDED
    // from movable-branch and source-absence evidence (a fence-less request has no
    // authority to grade its own integration), clearing only on independently
    // positive epic-landed evidence (the caller's straggler fallback) or an explicit
    // operator clear / re-mint — never here, preserving the fail-closed distinction.
    if (classifyPendingIntegration(row.reason) === "malformed") {
      out.set(row.id, "defer");
      continue;
    }
    const parsed = parseMergeConflictReason(row.reason);
    if (parsed === null || row.dir === null || row.dir === "") {
      out.set(row.id, "defer");
      continue;
    }
    const { source, base } = parsed;
    const pins = parsePendingIntegrationHeads(row.reason);
    try {
      if (pins !== null) {
        // PINNED row: clear authority comes from the DURABLE OBJECTS only. Branch
        // ABSENCE and the current source REF are never positive evidence here — a
        // post-mint source advance would wedge a landed pin, and a force-move /
        // delete could misgrade the obligation.
        out.set(
          row.id,
          await probePinnedMergeResolution(row.dir, base, pins, run),
        );
        continue;
      }
      // UNPINNED genuine content conflict → the legacy branch-name grading.
      const srcRef = await run(
        [
          "rev-parse",
          "--verify",
          "--quiet",
          "--end-of-options",
          `refs/heads/${source}^{commit}`,
        ],
        { cwd: row.dir, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
      );
      if (srcRef.code === 1) {
        out.set(row.id, "source-absent");
        continue;
      }
      if (srcRef.code !== 0) {
        out.set(row.id, "defer"); // inconclusive existence probe
        continue;
      }
      if (!(await gitIsAncestorOf(row.dir, source, base, run))) {
        out.set(row.id, "defer"); // not-yet-ancestor OR inconclusive
        continue;
      }
      const ready = await gitMergeReadiness(
        row.dir,
        shortBranchName(base),
        run,
      );
      out.set(row.id, ready.kind === "ready" ? "merged" : "defer");
    } catch {
      out.set(row.id, "defer"); // a git failure is never positive merged evidence
    }
  }
  return out;
}

/**
 * Positive-clear evidence for a PINNED pending-integration row, race-free against
 * TARGET movement. The exact sequence (gap-5):
 *   1. take ONE full current target base OID snapshot;
 *   2. test BOTH durable pins' ancestry against that OBJECT (never a per-command
 *      re-resolved branch) — either not-ancestor / unresolvable / errored → defer;
 *   3. require the target checkout clean, on the parsed base, no merge residue;
 *   4. re-probe checkout HEAD + base ref and require BOTH still equal the snapshot.
 * Any movement or probe error between (1) and (4) → defer, the row retained. Only
 * both pins contained + a still-stable clean target → `merged`. NEVER `source-absent`
 * (absence is not evidence for the pinned class). Throwing is the caller's `defer`.
 */
async function probePinnedMergeResolution(
  dir: string,
  base: string,
  pins: { sourceHead: string; baseHead: string },
  run: WorktreeGitRunner,
): Promise<WorkMergeIncidentVerdict> {
  const baseCommit = `refs/heads/${base}^{commit}`;
  const snap = await run(
    ["rev-parse", "--verify", "--quiet", "--end-of-options", baseCommit],
    { cwd: dir, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  const baseOid = snap.stdout.trim();
  if (snap.code !== 0 || !isFullObjectId(baseOid)) {
    return "defer";
  }
  for (const pin of [pins.sourceHead, pins.baseHead]) {
    const anc = await run(["merge-base", "--is-ancestor", pin, baseOid], {
      cwd: dir,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    if (anc.code !== 0) {
      return "defer"; // not-ancestor, unresolvable, or errored — never positive
    }
  }
  const ready = await gitMergeReadiness(dir, shortBranchName(base), run);
  if (ready.kind !== "ready") {
    return "defer";
  }
  const headAgain = await run(
    ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"],
    { cwd: dir, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  const baseAgain = await run(
    ["rev-parse", "--verify", "--quiet", "--end-of-options", baseCommit],
    { cwd: dir, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  if (
    headAgain.code !== 0 ||
    baseAgain.code !== 0 ||
    headAgain.stdout.trim() !== baseOid ||
    baseAgain.stdout.trim() !== baseOid
  ) {
    return "defer"; // target moved (or a probe errored) between snapshot and recheck
  }
  return "merged";
}

/**
 * ADR-0013 amendment (fn-1200.2) — the stuck-sentinel ORPHAN reconciliation.
 * Given the OPEN `stuck-sentinel:<jobId>` distress ids (`snapshot`-independent —
 * callers scope the input set via {@link isStuckSentinelDistressKey}) and the
 * set of job ids the LIVE `jobs` table actually carries (every state — a
 * terminal `ended`/`killed` row still COUNTS as live here; only a genuinely
 * ABSENT row is an orphan), return the ids whose evidentiary value is gone: the
 * referenced job no longer exists at all, so there is nothing left an operator
 * could inspect by acking it. A row whose job id still resolves — in ANY state —
 * is untouched: it stays under the unchanged operator-ack-only discipline
 * (`retry_dispatch` is its only other clear), preserving the ADR's "never
 * silently self-tidy a live signal" rule. Pure — a function of the two input
 * sets, no git, no clock; the caller logs a trace line per cleared id BEFORE
 * emitting `DispatchCleared` so the evidence trail survives the GC.
 */
export function stuckSentinelOrphansToClear(
  openSentinelIds: ReadonlySet<string>,
  liveJobIds: ReadonlySet<string>,
): string[] {
  const cleared: string[] = [];
  for (const id of openSentinelIds) {
    const jobId = stuckSentinelJobId(id);
    if (jobId !== null && !liveJobIds.has(jobId)) {
      cleared.push(id);
    }
  }
  return cleared;
}

/**
 * Normalize a lane worktree path to the key the lane-wedge tracker + the reason-scoped
 * clear match on: realpath (so the macOS `/tmp`→`/private/tmp` + `/var`→`/private/var`
 * symlinks collapse to ONE form on both the provision-mint side and the recover-probe
 * side), then strip a trailing slash. A realpath failure keeps the raw input and
 * distinguishes confirmed absence (`ENOENT`/`ENOTDIR`) from an unknown probe error.
 * Mirrors {@link normalizeWorktreeAttributionKey} so the two lane keyings never drift.
 */
export type LanePathPresence = "present" | "absent" | "unknown";

export interface NormalizedLanePath {
  path: string;
  presence: LanePathPresence;
}

export type LanePathNormalizer = (path: string) => NormalizedLanePath;

function normalizeLanePathState(p: string): NormalizedLanePath {
  try {
    return {
      path: stripTrailingSlashPath(realpathSync.native(p)),
      presence: "present",
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return {
      path: stripTrailingSlashPath(p),
      presence: code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unknown",
    };
  }
}

function normalizeLanePath(p: string): string {
  return normalizeLanePathState(p).path;
}

export interface LaneMaintenanceTarget {
  path: string;
  epicId: string;
  taskId: string | null;
}

export type LaneMaintenanceProbeResult =
  | { kind: "clear" }
  | { kind: "defer"; reason: string };

export type LaneMaintenanceProbe = (
  target: LaneMaintenanceTarget,
) => LaneMaintenanceProbeResult;

const LANE_MAINTENANCE_REASON_MAX = 512;

function boundedLaneMaintenanceReason(reason: string): string {
  return reason.length <= LANE_MAINTENANCE_REASON_MAX
    ? reason
    : `${reason.slice(0, LANE_MAINTENANCE_REASON_MAX - 1)}…`;
}

export function createLaneMaintenanceProbe(
  jobs: ReadonlyMap<string, Job>,
  dispatchClaims: ReadonlyMap<DispatchKey, DispatchClaim> | undefined,
  livePaneIds: ReadonlySet<string> | null,
  claimedIncidentKeys: ReadonlySet<DispatchKey> = new Set(),
): LaneMaintenanceProbe {
  return (target) => {
    const lanePath = normalizeLanePath(target.path);
    for (const key of claimedIncidentKeys) {
      const split = key.indexOf("::");
      if (split < 1) continue;
      const verb = key.slice(0, split);
      const id = key.slice(split + 2);
      const holdsTarget =
        (verb === "close" && id === target.epicId) ||
        (verb === "work" &&
          (target.taskId !== null
            ? id === target.taskId
            : id.startsWith(`${target.epicId}.`)));
      if (holdsTarget) {
        return {
          kind: "defer",
          reason: boundedLaneMaintenanceReason(
            `live incident claim ${key} holds ${lanePath}`,
          ),
        };
      }
    }
    for (const claim of dispatchClaims?.values() ?? []) {
      if (claim.state === "released") continue;
      const claimsPath =
        claim.dir !== null && normalizeLanePath(claim.dir) === lanePath;
      const claimsTask =
        claim.verb === "work" &&
        (target.taskId !== null
          ? claim.id === target.taskId
          : claim.id.startsWith(`${target.epicId}.`));
      if (claimsPath || claimsTask) {
        return {
          kind: "defer",
          reason: boundedLaneMaintenanceReason(
            `live dispatch claim ${claim.verb}::${claim.id} holds ${lanePath}`,
          ),
        };
      }
    }
    for (const job of jobs.values()) {
      if (job.state === "ended" || job.state === "killed") continue;
      const ownsPath =
        job.cwd !== null && normalizeLanePath(job.cwd) === lanePath;
      const ownsTask =
        target.taskId !== null
          ? job.plan_ref === target.taskId
          : job.plan_ref === target.epicId ||
            job.plan_ref?.startsWith(`${target.epicId}.`) === true;
      if (!ownsPath && !ownsTask) continue;
      const label = `${job.plan_verb ?? "job"}::${job.plan_ref ?? job.job_id}`;
      if (job.state === "working") {
        return {
          kind: "defer",
          reason: boundedLaneMaintenanceReason(
            `live claimed session ${label} holds ${lanePath}`,
          ),
        };
      }
      if (job.state === "stopped") {
        // The ONE centralized stopped-job liveness rule (`null` panes → assume
        // live), shared with the occupancy gate and the dirty-attribution pass
        // rather than forked here. `null` panes stay a DISTINCT reason: the hold
        // is fail-closed on an unavailable probe, not a witnessed live owner.
        //
        // A positively-live pane HOLDS the lane regardless of stop-age: grace only
        // makes the session reap-ELIGIBLE for the bounded occupancy reaper, and the
        // lane must not be reset out from under a target still inside that ladder
        // (over the blast cap, mid TERM→KILL, or failing act-time identity). The
        // hold lifts only on a later positive gone here — a reaped-away pane trips
        // `!isStoppedJobLive` above and clears (the positive-gone / live-lane-no-reset
        // invariant).
        if (!isStoppedJobLive(job, livePaneIds)) continue;
        return {
          kind: "defer",
          reason: boundedLaneMaintenanceReason(
            livePaneIds === null
              ? `liveness probe inconclusive for claimed session ${label} on ${lanePath}`
              : `live claimed session ${label} holds ${lanePath}`,
          ),
        };
      }
      return {
        kind: "defer",
        reason: boundedLaneMaintenanceReason(
          `liveness probe inconclusive for claimed session ${label} on ${lanePath}`,
        ),
      };
    }
    return { kind: "clear" };
  };
}

function probeLaneMaintenance(
  probe: LaneMaintenanceProbe | undefined,
  target: LaneMaintenanceTarget,
): LaneMaintenanceProbeResult {
  if (probe === undefined) return { kind: "clear" };
  try {
    return probe(target);
  } catch (err) {
    return {
      kind: "defer",
      reason: boundedLaneMaintenanceReason(
        `liveness probe inconclusive for ${normalizeLanePath(target.path)}: ${errMsg(err)}`,
      ),
    };
  }
}

/**
 * Injected timer primitives for the coalesced stopped-job expiry wake — real
 * wall-clock `setTimeout` in `main()`, a fake scheduler in tests. `now()` is unix
 * SECONDS (the same domain as `reconcile`'s `now`); `setTimer`/`clearTimer` model a
 * SINGLE coalesced timer (never a per-job timer). `unref` is left to the production
 * adapter so the timer never keeps the worker thread alive.
 */
export interface ExpiryWakeClock {
  now: () => number;
  setTimer: (delayMs: number, fire: () => void) => unknown;
  clearTimer: (handle: unknown) => void;
}

/** Default bounded re-probe (seconds) a waker arms when a cycle's decision is UNTRUSTWORTHY
 *  and NO timer is currently held — so a fired-then-unknown boundary re-probes rather than
 *  freezing forever on a quiescent DB. */
export const EXPIRY_WAKE_UNKNOWN_RETRY_SEC = 60;

/** The coalesced stopped-job expiry waker: one re-armable, generation-fenced timer. */
export interface StoppedExpiryWaker {
  /** Re-arm the single timer for the earliest expiry (unix seconds). `null` DISARMS — the
   *  positively-nothing-pending case (paused / no candidate); `play` delivers the explicit
   *  re-kick. Distinct from {@link armUnknown}, which never disarms a live edge. */
  arm: (nextExpiryAt: number | null) => void;
  /** UNTRUSTWORTHY decision (a cycle error, a degraded/inconclusive probe): PRESERVE the
   *  prior timer if one is armed, else arm ONE bounded retry — never erase a live clock edge,
   *  so a transient unknown that fired the boundary cycle re-probes instead of freezing. */
  armUnknown: () => void;
  /** Cancel the timer outright (shutdown). */
  disarm: () => void;
}

/**
 * Build the coalesced expiry waker. autopilot's `watchLoop` wakes ONLY on a `data_version`
 * change, so a deadline sitting in a quiescent DB would never be re-evaluated. This arms ONE
 * re-armable timer at the earliest durable expiry the last cycle computed and fires a fresh
 * cycle when it elapses, closing that clock edge WITHOUT a DB write. Coalesced by
 * construction: every {@link StoppedExpiryWaker.arm} clears the prior timer before setting the
 * next, so there is only ever one timer (never per-job), re-derived from the durable
 * projection (restart-safe — the boot cycle re-arms it).
 *
 * TWO liveness invariants:
 *  - THREE-STATE arming: a definite `arm(expiry)` sets the edge; `arm(null)` DISARMS (a
 *    positive no-candidate / paused, re-kicked by `play`); {@link armUnknown} for an
 *    untrustworthy decision (a cycle error, a degraded/inconclusive probe) PRESERVES the prior
 *    timer or, if none, arms one bounded retry — so a single transient null that fired the
 *    boundary cycle can never erase the clock edge forever.
 *  - GENERATION FENCING: every arm/disarm bumps a monotonic generation the armed callback
 *    captures; a callback ALREADY QUEUED when a newer arm supersedes it checks its generation
 *    first and no-ops, so a stale expiry callback can neither run a cycle nor orphan the newer
 *    timer (the two-live-timers coalescing violation).
 */
export function createStoppedExpiryWaker(
  clock: ExpiryWakeClock,
  runCycle: () => void,
  isShutdown: () => boolean,
  unknownRetrySec: number = EXPIRY_WAKE_UNKNOWN_RETRY_SEC,
): StoppedExpiryWaker {
  let handle: unknown = null;
  // Monotonic generation. Bumped on EVERY arm/disarm; the armed callback captures the
  // generation of ITS timer and runs only while it is still current — a callback queued
  // before a superseding arm sees a stale generation and no-ops.
  let generation = 0;
  const clearHandle = (): void => {
    if (handle !== null) {
      clock.clearTimer(handle);
      handle = null;
    }
  };
  const disarm = (): void => {
    generation += 1;
    clearHandle();
  };
  const armDelay = (delayMs: number): void => {
    // Supersede any queued stale callback, then replace the single timer.
    generation += 1;
    clearHandle();
    if (isShutdown()) return;
    const myGen = generation;
    handle = clock.setTimer(delayMs, () => {
      if (myGen !== generation) return; // superseded — a newer arm/disarm invalidated us
      handle = null;
      if (!isShutdown()) runCycle();
    });
  };
  return {
    disarm,
    arm: (nextExpiryAt): void => {
      if (nextExpiryAt === null || isShutdown()) {
        disarm();
        return;
      }
      armDelay(Math.max(0, (nextExpiryAt - clock.now()) * 1000));
    },
    armUnknown: (): void => {
      if (isShutdown()) {
        disarm();
        return;
      }
      // PRESERVE a live edge: a still-armed timer is the last trustworthy deadline; an
      // untrustworthy cycle must not erase it. Only when NO timer is held (e.g. the boundary
      // cycle fired then came back unknown) arm ONE bounded retry so a probe re-runs.
      if (handle !== null) return;
      armDelay(Math.max(0, unknownRetrySec) * 1000);
    },
  };
}

/** A cycle's THREE-STATE wake intent: a definite deadline (`{ at }`, unix seconds), a positive
 *  no-candidate (`idle` → disarm), or an UNTRUSTWORTHY cycle (`unknown` → preserve the prior
 *  timer / bounded retry, never erase a live edge). */
export type WakeArm = { at: number } | "idle" | "unknown";

/** Apply a {@link WakeArm} to a waker — the one mapping the driveCycle `finally` uses so both
 *  the stopped-expiry and origin-containment edges share identical liveness semantics. */
export function applyWakeArm(waker: StoppedExpiryWaker, arm: WakeArm): void {
  if (arm === "unknown") {
    waker.armUnknown();
  } else if (arm === "idle") {
    waker.arm(null);
  } else {
    waker.arm(arm.at);
  }
}

/**
 * Map a slot-occupancy cycle's evidence to a THREE-STATE {@link WakeArm} — the SINGLE seam
 * that decides the stopped-job wake, so a pane-probe-degraded cycle no longer collapses to a
 * false disarm. Precedence:
 *  - `paused` → `idle` (a positively-known no-candidate; `play` re-kicks) — WINS over degraded,
 *    since the pause flag is independently known even when DB / pane reads degrade.
 *  - `degraded` (readinessDegraded — the DB read) OR NOT `expiryTrusted` (the pane liveness
 *    probe was null, so the scan could not run) → `unknown` (preserve the prior wake / bounded
 *    retry — a fired boundary + transient null-probe must never freeze the clock edge).
 *  - a trusted probe with an expiry → `{ at }`; a trusted probe with none → `idle`. Pure.
 */
export function slotWakeArm(input: {
  paused: boolean;
  degraded: boolean;
  expiryAt: number | null;
  expiryTrusted: boolean;
}): WakeArm {
  if (input.paused) return "idle";
  if (input.degraded || !input.expiryTrusted) return "unknown";
  return input.expiryAt !== null ? { at: input.expiryAt } : "idle";
}

/**
 * The SLOT and CONTAINMENT wake arms for a readiness-DEGRADED (a DB collection read errored)
 * cycle — which derives no trustworthy decision. The two surfaces DIFFER on pause:
 *  - SLOT: `paused → idle` (via {@link slotWakeArm}); no reap is PERMITTED while paused, so a
 *    disarm is correct (`play` re-kicks). Otherwise `unknown` (preserve / bounded retry).
 *  - CONTAINMENT: ALWAYS `unknown`, EVEN paused. Mode-off row RETIREMENT *is* permitted while
 *    paused (the pause-independent disable), so a degraded snapshot that could neither read nor
 *    retire the open rows must keep the wake alive (bounded retry) until a COMPLETE snapshot can
 *    retire (mode false) or positively idle (mode true) — never disarm and strand the obsolete
 *    non-retryable row on a quiescent paused board. This is bounded recovery from UNKNOWN, not a
 *    wake-driven push while paused (the sweep stays `!paused`-gated, so no push fires).
 */
export function readinessDegradedWakeArms(paused: boolean): {
  slot: WakeArm;
  containment: WakeArm;
} {
  return {
    slot: slotWakeArm({
      paused,
      degraded: true,
      expiryAt: null,
      expiryTrusted: false,
    }),
    containment: "unknown",
  };
}

/**
 * Per-(pass, lane) latch for lane-maintenance deferral logging, keyed
 * `<pass>\0<normalized lane path>` → the last reason logged. A held lane rides a
 * `data_version`-level-triggered loop the live owner's OWN job updates keep
 * ticking, so an unlatched line would repeat per pass per cycle for the whole
 * hold. One line per EPISODE instead: {@link logLaneMaintenanceDeferralOnce}
 * emits only when the reason is new or changed, and
 * {@link pruneLaneMaintenanceDeferralLatch} ends the episode by dropping the keys
 * a sweep did not re-defer, so a later hold reports afresh. Live-only process
 * state — never a fold read, never persisted.
 */
const laneMaintenanceDeferralLatch = new Map<string, string>();

function laneMaintenanceDeferralKey(pass: string, path: string): string {
  return `${pass}\0${normalizeLanePath(path)}`;
}

function logLaneMaintenanceDeferralOnce(
  pass: string,
  path: string,
  reason: string,
  seen?: Set<string>,
  // The recover sweep's reasons already carry their own `<pass>: <path> — ` head;
  // pass the formed line so it is not prefixed twice.
  message?: string,
): void {
  const key = laneMaintenanceDeferralKey(pass, path);
  seen?.add(key);
  if (laneMaintenanceDeferralLatch.get(key) === reason) return;
  laneMaintenanceDeferralLatch.set(key, reason);
  console.error(
    `[autopilot-worker] ${boundedLaneMaintenanceReason(message ?? `${pass}: ${reason}`)}`,
  );
}

/** The reconcile-cycle passes that hold a lane; the recover sweep owns its own. */
const CYCLE_LANE_DEFERRAL_PASSES = [
  "worktree-base-refresh-deferred",
  "worktree-provision-deferred",
  "worktree-preclose-provision-deferred",
  "worktree-sink-provision-deferred",
  "worktree-finalize-deferred",
] as const;

/** The recover sweep's single deferral pass namespace. */
const RECOVER_LANE_DEFERRAL_PASS = "worktree-maintenance-deferred";

/**
 * End every episode in `passes` whose (pass, lane) key was NOT re-deferred this
 * sweep, so the next hold on that lane logs once again.
 */
function pruneLaneMaintenanceDeferralLatch(
  passes: readonly string[],
  seen: ReadonlySet<string>,
): void {
  for (const key of [...laneMaintenanceDeferralLatch.keys()]) {
    const pass = key.slice(0, key.indexOf("\0"));
    if (passes.includes(pass) && !seen.has(key)) {
      laneMaintenanceDeferralLatch.delete(key);
    }
  }
}

/**
 * The `dispatch_failures` id a PER-REPO worktree-finalize failure keys on —
 * `worktree-finalize:<epicId>-<repoHash>` (composed
 * `close::worktree-finalize:<epicId>-<repoHash>`). The N per-repo finalizes of ONE
 * clustered multi-repo epic each land on a DISTINCT row instead of colliding on the
 * single `close::<epicId>` key, and never collide with a recover row. Slugs nothing
 * — the epic id is already dispatch-safe and {@link repoDirHash} is base36 — so the
 * composite passes `parseDispatchKey` (verb `close`, single `::`), exactly like
 * {@link worktreeRecoverDispatchId}. `repoHash` reuses the lane-path dir-hash so the
 * producer level-clear targets the SAME row it minted across cycles.
 */
export function worktreeFinalizeDispatchId(
  epicId: string,
  repoDir: string,
): string {
  return `${WORKTREE_FINALIZE_ID_PREFIX}${epicId}-${repoDirHash(repoDir)}`;
}

/**
 * Prune cooldown entries older than the cooldown window. Run once per cycle so
 * the Map stays bounded. Mutates in place — called ONLY from `driveCycle`, never
 * inside the pure `reconcile`; the caller wraps it in try/catch (no self-heal).
 */
export function sweepRedispatchCooldown(
  cooldown: Map<DispatchKey, number>,
  now: number,
): void {
  for (const [key, stampedAt] of cooldown) {
    if (now - stampedAt >= REDISPATCH_COOLDOWN_S) {
      cooldown.delete(key);
    }
  }
}

/**
 * The RESOLVED git toplevels where an epic cuts a WORKTREE LANE (`keeper/epic/<id>`
 * forked off that repo's base) — the ONLY groups the cross-epic merge-gate governs.
 * An `ok` epic cuts one lane in its single toplevel; a `clustered` epic cuts one per
 * `worktree` group (a `serial` group works directly on the shared-checkout default,
 * forking no lane — so it can never invert merge order and is never gated, mirroring
 * the disabled-upstream skip). A `disabled` / reject resolution cuts no lane at all.
 * Empty ⇒ nothing to gate for this epic.
 */
function worktreeLaneRepoDirs(resolution: WorktreeRepoResolution): string[] {
  if (resolution.kind === "ok") {
    return [resolution.repoDir];
  }
  if (resolution.kind === "clustered") {
    return resolution.groups
      .filter((g) => g.mode === "worktree")
      .map((g) => g.repoDir);
  }
  return [];
}

/**
 * Whether an epic cut a WORKTREE lane (`keeper/epic/<id>`) in `repoDir` — the
 * same-resolved-repo test the merge-gate applies to an UPSTREAM (decided by the
 * classification's resolved `repoDir`, NEVER `dep.cross_project`). True iff the epic
 * is `ok` on `repoDir`, or `clustered` with a `worktree` group there; a `serial`
 * group / other repo / non-lane resolution never gates.
 */
function hasWorktreeLaneInRepo(
  resolution: WorktreeRepoResolution,
  repoDir: string,
): boolean {
  if (resolution.kind === "ok") {
    return resolution.repoDir === repoDir;
  }
  if (resolution.kind === "clustered") {
    return resolution.groups.some(
      (g) => g.repoDir === repoDir && g.mode === "worktree",
    );
  }
  return false;
}

/**
 * A live in-flight dispatch this reconciler still has confirm work for.
 * Tracked on the in-memory `liveDispatches` map keyed by `${verb}::${id}`
 * so a single dispatch's confirm can be targeted. The `controller`
 * aborts the confirm's internal sleeps on shutdown.
 */
export interface LiveDispatch {
  verb: Verb;
  id: string;
  key: DispatchKey;
  cwd: string;
  controller: AbortController;
}

/**
 * Side-effect deps for the reconcile + confirm cycle. All injected so
 * the core stays pure (the test suite drives the same paths with fakes
 * — no real worker spawn).
 */
export const CLOSE_RECOVERY_MARKER =
  "autopilot-close-recovery: prior closer finished after lane merged";
export const CLOSE_RECOVERY_TIMEOUT_MS = 60_000;

export type CloseRecoveryStampResult =
  | { ok: true; alreadyClosed: boolean }
  | { ok: false; detail: string };

export interface ConfirmRunningDeps {
  /** Spawn the worker in a managed window keyed by `name`. keeper agent is the sole
   *  launch transport: it builds its invocation from `spec` (the unwrapped
   *  structured launch) and owns the tmux window, IGNORING the pre-wrapped
   *  `argv`. `name` feeds the warn/log lines and is the autopilot dedup key only.
   *  `argv` is retained at the seam so the shell-wrapped `buildLaunchArgv` shape
   *  (whose flag choices {@link buildPlannedLaunchSpec} mirrors as a drift guard)
   *  stays computed at the call site; the launch impl reads `spec`, not `argv`. */
  launch(
    argv: string[],
    name: string,
    cwd: string,
    spec: LaunchSpec,
  ): Promise<LaunchResult>;
  /**
   * Emit a synthetic `DispatchFailed` event onto the writable connection
   * (via the parent thread — workers never write the DB). Carries the
   * reconcile-time `ts` so a re-fold reproduces the projection row
   * byte-identically.
   */
  emitDispatchFailed(payload: DispatchFailedPayload): void;
  /**
   * Emit a synthetic `DispatchCleared` event (via the parent thread — workers
   * never write the DB), symmetric with {@link emitDispatchFailed}. Reuses the
   * SAME `mintDispatchClearedEvent` path `retry_dispatch` drives. The recover
   * glue calls this to level-triggered-clear a sticky recover failure once its
   * underlying git is resolved, so no operator `retry_dispatch` is needed.
   */
  emitDispatchCleared(payload: DispatchClearedPayload): void;
  /**
   * Mint the synthetic per-repo shared-checkout-wedge distress row (via main —
   * workers never write the DB). Main routes it through a thin closure keyed on the
   * synthetic `daemon` verb (the crash-loop distress idiom), so the row surfaces in
   * `needs_human` and the boot orphan-GC exempts it. OPTIONAL — a no-op when absent
   * (a fake-deps test never needs the escalation), so the dispatch path is
   * byte-identical without it. Producer-stamped `ts` for re-fold determinism.
   */
  emitSharedWedgeDistress?(payload: {
    id: string;
    dir: string;
    reason: string;
    ts: number;
  }): void;
  /**
   * Level-clear a shared-checkout-wedge distress row once its checkout recovers
   * (via main). Reuses the SAME `mintDispatchClearedEvent` path `retry_dispatch`
   * drives, but the ONLY caller is the recover pass's level-trigger — the distress
   * is never operator-clearable. OPTIONAL — a no-op when absent.
   */
  clearSharedWedgeDistress?(payload: {
    id: string;
    dir: string;
    expected_attempt_id: null;
    expected_instance_event_id: number | null;
  }): void;
  /**
   * Nudge the git-worker (via main) to run an IMMEDIATE vanished-worktree sweep
   * after a lane teardown's removals COMPLETE (finalize / recover pass-3), so the
   * sweep retires a torn-down lane's `git_status` row promptly instead of at the
   * next full sweep. Payload-free — the sweep keys on the canonical `git_status`
   * rows and re-verifies each with an ENOENT gate, so it introduces NO second
   * retire path. OPTIONAL — a no-op when absent (a fake-deps test never needs the
   * relay), so the teardown path is byte-identical without it. NEVER fires on a
   * deferred/failed removal — the sweep must not drop a still-present path.
   */
  nudgeVanishedSweep?(): void;
  /**
   * Arm an IMMEDIATE reconcile re-tick after the parts-6 progress actor made external git
   * progress (a rib integrated into a held lane). That progress bumps NO PRAGMA
   * data_version, so the level-triggered `watchLoop` would not re-evaluate the sibling-
   * source gate until an unrelated future event — this re-arms the coalesced waker so the
   * next cycle runs promptly and the now-cleared dependent dispatches. Payload-free;
   * OPTIONAL — a no-op when absent (a fake-deps test never needs the arm), so the dispatch
   * path is byte-identical without it.
   */
  nudgeReconcileSoon?(): void;
  /**
   * Emit the FULL current worktree-disabled set to main (fn-1013) for the
   * LIVE-ONLY `worktree_repo_status` operator surface. Main is the sole writer of
   * the synthetic `WorktreeRepoStatus` event. Called once per cycle with the
   * complete set; the impl dedupes by a stable serialization so a stable board
   * mints no event (mirrors `git_status`'s semantic-dedupe emit). OPTIONAL — a
   * no-op when absent (a fake-deps test never needs the operator surface), so the
   * dispatch path is byte-identical without it.
   */
  emitWorktreeRepoStatus?(entries: WorktreeRepoStatusEntry[]): void;
  /**
   * Emit the FULL current merge-landed set to main (fn-1016) for the LIVE-ONLY
   * `lane_merged` observable. Main is the sole writer of the synthetic `LaneMerged`
   * event. Called once per cycle with the complete set; the impl dedupes by a
   * stable serialization so a stable board mints no event (mirrors
   * {@link emitWorktreeRepoStatus}). OPTIONAL — a no-op when absent (a fake-deps
   * test never needs the observable), so the dispatch path is byte-identical
   * without it.
   */
  emitLaneMerged?(entries: readonly LaneMergedEntry[]): void;
  /**
   * Emit a synthetic `Dispatched` event (via main — workers never write the DB)
   * AND AWAIT a durable ack. Outbox-ordered intent: the reconciler mints this
   * BEFORE `launch()` and AWAITS the ack before launching — a fire-and-forget
   * post let main drain a worker's `SessionStart` BEFORE the mint landed, so the
   * row was never written and the slot double-dispatched. A `{ok:false}` (insert
   * threw) or a rejected wait (ack-timeout / shutdown) ABORTS without launching;
   * a phantom row from a slow-but-eventual insert is cleared by the TTL sweep.
   * Carries the reconcile-time `ts` so the fold lands `dispatched_at`
   * byte-identically.
   */
  emitDispatched(payload: DispatchedPayload): Promise<DispatchedAck>;
  /**
   * `SELECT MAX(id) FROM events` against the reconciler's own read-only
   * connection. Captured BEFORE `launch` so the post-launch poll can
   * filter out any stale `jobs` row carrying the same `(plan_verb,
   * plan_ref)` whose `last_event_id` was minted before this dispatch.
   */
  maxEventId(): number;
  /**
   * `SELECT job_id, last_event_id FROM jobs WHERE plan_verb=? AND
   *   plan_ref=? AND state IN ('working','stopped') AND
   *   last_event_id > ? LIMIT 1`. Returns the matching row when one
   * exists (the confirm GOOD path), else null. `state` filter is the
   * non-terminal partition (the schema default is `'stopped'`, set by
   * SessionStart-INSERT; `working` is the post-`UserPromptSubmit`
   * lifecycle state). `'ended'` / `'killed'` are terminal and
   * deliberately excluded — those are dead rows even if their
   * `last_event_id > watermark`, the post-watermark transition must be
   * a re-open, not a confirm.
   */
  findJob(
    plan_verb: Verb,
    plan_ref: string,
    last_event_id_gt: number,
  ): FoundJob | null;
  /**
   * Read-side claim-acquire observation against the reconciler's OWN read-only
   * connection: the reducer cursor (`reducer_state.last_event_id`) plus the
   * folded `dispatch_claims` + `pending_dispatches` rows for `(verb, id)`.
   * `confirmRunning` calls this AFTER the durable mint ack and BEFORE `launch`,
   * so it crosses the launch side-effect ONLY once THIS attempt's acquired claim
   * (and its pending row) is POSITIVELY observed — an `INSERT OR IGNORE` no-op
   * (a predecessor's un-released claim still holds the pair) folds with no row
   * for this attempt and must never read as launch success, or the wrapper
   * launches ungrantable (perpetual-`wait` provider legs, three burned legs).
   * The cursor read distinguishes FOLD-LAG (cursor still behind the mint event —
   * transient, keep polling) from a real LOSS (cursor past the mint, claim owned
   * by another attempt). A PRODUCER read by contract — never a fold.
   */
  observeClaimAcquire(verb: Verb, id: string): ClaimAcquireObservation;
  /** Producer-side wall-clock for the reconcile-time `ts` stamp. */
  now(): number;
  /**
   * Producer-side on-disk existence probe for a launch cwd (defaults to
   * `existsSync` in `runReconcileCycle` when absent). A resolved cwd that no
   * longer exists — typically a renamed-away repo dir — mints a sticky
   * `cwd-missing: <path>` `DispatchFailed` instead of launching into a stale
   * path that silently never runs (remediation: `keeper plan mv-repo`). This is
   * a PRODUCER read by contract — it lives in `runReconcileCycle`, never in a
   * `reconcile`/fold arm, so re-fold determinism holds.
   */
  dirExists?(dir: string): boolean;
  /**
   * Realpath-normalize a worktree lane path before it rides the launch as the
   * `KEEPER_PLAN_WORKTREE` env, so it equals the worker's eventual
   * `process.cwd()` (macOS resolves `/var`→`/private/var`). A PRODUCER-side fs
   * read by contract — lives in `runReconcileCycle`, never a fold arm. Defaults
   * to a `realpathSync` wrapper that falls back to the input on any error (a
   * not-yet-materialized path stays usable). Injected so tests assert the
   * normalization seam without a real dir.
   */
  realpath?(p: string): string;
  /** Read-only compiler cohort verifier. Lazily called at most once per cycle,
   * only after a selected cell manifest exists. Tests may inject `{ok:true}`. */
  verifyWorkerCellCohort?(): WorkerCellCohortVerification;
  /** Effective automated-work launcher-config `work` inventory. Lazily scanned
   * at most once per cycle after freshness succeeds. */
  inventoryWorkPluginManifests?(): WorkPluginManifestInventory;
  /** Launch-cwd `work` inventory using the launcher's cwd auto-plugin predicate.
   * Results are cached by bounded physical cwd within one cycle. */
  inventoryLaunchCwdWorkPluginManifests?(
    cwd: string,
  ): WorkPluginManifestInventory;
  /** Physical identity seam used for exact cell and cwd cache comparisons. */
  physicalPluginDir?(pluginDir: string): string;
  /**
   * Sleep `ms`, abortable via the worker's shutdown signal. Resolves
   * early when `signal.aborted` flips; the caller checks the flag and
   * treats an early resolve as "shutdown — stop polling".
   */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /**
   * Report the `confirmRunning` ceiling backstop fire (`timeout` class). Called
   * once per confirm: a pre-ceiling SessionStart as `rescued:false,
   * stalenessMs:null` (the denominator); a ceiling-hit as `rescued:true,
   * stalenessMs:elapsedMs` (the rescue). Optional (a no-op when absent). STRICTLY
   * ADDITIVE — never perturbs the `DispatchFailed` emit or the dispatch gates.
   */
  recordTimeoutBackstop?(args: {
    rescued: boolean;
    stalenessMs: number | null;
  }): void;
  /**
   * The producer git driver for worktree mode. ABSENT whenever the
   * reconciler runs without worktree support (then every `worktree`/`worktreeReject`
   * launch field is inert and dispatch is byte-identical to today). PRESENT in
   * worktree mode: `runReconcileCycle` calls it to provision a lane worktree,
   * prepare any pending fan-in integration, assert HEAD, and — after a closer
   * reaches done — verify owner integration, push, and tear the lanes down.
   * Every method shells git
   * on the target repo (a producer side effect); none touches keeper.db or a fold.
   * Injected so the fast tier drives the same code paths with a fake.
   */
  worktree?: WorktreeDriver;
  /**
   * The MAIN-projection done-ness probe ({@link isEpicDoneById} bound to
   * the reconciler's read-only connection), threaded into `worktree.finalizeEpic`
   * so finalize pushes and retires a lane ONLY when its epic is done in the projection. The
   * closer writes `done` to the PRIMARY repo, so the projection — not a lane-read —
   * is the authority; this rejects a crashed closer that finished without `done`.
   * Mirrors the same probe the recover glue passes into `worktree.recover`.
   */
  isEpicDone(epicId: string): Promise<boolean>;
  /**
   * Land the recovery-only terminal epic stamp through the plan CLI. The pure
   * decision emits this action only after a positive lane-ancestry fact and prior
   * finished closer; failures remain level-triggered and retry next cycle.
   */
  stampEpicCloseRecovery?(
    epicId: string,
    projectDir: string,
  ): Promise<CloseRecoveryStampResult>;
  /**
   * The merge-suite gate probe threaded into `worktree.finalizeEpic` (the {@link
   * isEpicDone} precedent): given the owner-integrated local-default commit, run the
   * fast suite against it in a scratch worktree and return green / pass-with-note /
   * red / load-suspect / cannot-run. OPTIONAL — omitted makes finalize skip the
   * gate. Production wires {@link runMergeSuiteGate}; tests inject a fake purely.
   */
  runMergeSuite?: MergeSuiteProbe;
  /**
   * Tuning knobs — exposed as deps so tests can drive a 5ms / 50ms
   * cadence instead of seconds. Defaults applied in `runConfirmCycle`
   * when undefined.
   */
  pollIntervalMs?: number;
  ceilingMs?: number;
  /**
   * Tuning knobs for the pre-launch claim-acquire verification poll. Default to
   * {@link CLAIM_VERIFY_POLL_MS} / {@link CLAIM_VERIFY_CEILING_MS} when undefined
   * so tests drive a tight cadence.
   */
  claimVerifyPollMs?: number;
  claimVerifyCeilingMs?: number;
}

/**
 * The verdict of running the fast suite against a PROSPECTIVE lane→default merge
 * result. `green` and `pass-with-note` clear the merge to advance local default;
 * the latter records that the package has no configured suite. `red` is a named
 * suite failure that parks the epic on a visible sticky; `load-suspect` is a
 * deadline kill or empty-digest crash, retried once per row/commit before it parks;
 * `cannot-run` is a configured gate that could not produce a verdict (scratch
 * provision / frozen-lockfile install failure) and degrades to a retry-skip.
 */
export type MergeSuiteVerdict =
  | { kind: "green" }
  | { kind: "pass-with-note"; detail: string }
  | { kind: "red"; detail: string }
  | { kind: "load-suspect"; detail: string }
  | { kind: "cannot-run"; detail: string };

export type MergeSuiteLoadRetryAction = "none" | "retry" | "park";

export interface MergeSuiteLoadRetryTracker {
  step(args: {
    rowKey: string;
    mergedCommit: string;
    verdict: MergeSuiteVerdict;
  }): MergeSuiteLoadRetryAction;
  pendingCount(): number;
}

const MERGE_SUITE_LOAD_RETRY_MAX_KEYS = 256;

/**
 * Producer-only, bounded retry state. One entry per row key retains the current
 * merged commit and whether its single load-suspect retry was consumed. A new
 * commit starts a fresh episode; green/pass-with-note/named-red ends it. The
 * fixed-cap insertion order bounds abandoned keys without involving a fold.
 */
export function createMergeSuiteLoadRetryTracker(
  maxKeys = MERGE_SUITE_LOAD_RETRY_MAX_KEYS,
): MergeSuiteLoadRetryTracker {
  const capacity =
    Number.isFinite(maxKeys) && maxKeys > 0 ? Math.floor(maxKeys) : 1;
  const pending = new Map<string, string>();
  return {
    step({ rowKey, mergedCommit, verdict }) {
      if (
        verdict.kind === "green" ||
        verdict.kind === "pass-with-note" ||
        verdict.kind === "red"
      ) {
        pending.delete(rowKey);
        return "none";
      }
      if (verdict.kind !== "load-suspect") return "none";

      if (pending.get(rowKey) === mergedCommit) {
        pending.delete(rowKey);
        pending.set(rowKey, mergedCommit);
        return "park";
      }

      pending.delete(rowKey);
      pending.set(rowKey, mergedCommit);
      while (pending.size > capacity) {
        const oldest = pending.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }
      return "retry";
    },
    pendingCount() {
      return pending.size;
    },
  };
}

/**
 * Run the fast suite against the prospective merged commit `mergedCommit` checked
 * out in a scratch worktree of `repoDir`. `runsPlanSuite` is true when the merge
 * introduces changes under `plugins/plan` (the merged packages the gate must cover:
 * the root fast suite always, plus the plan suite when the plan plugin is touched).
 * `runsSmokeGate` (ADR 0073, fn-1309) is true when the merge touches the daemon Load
 * surface (per `scripts/daemon-load-roots.txt`) — the named `test:slow-daemon` gate
 * then runs, chained after a green root suite and before any plan suite, so its
 * failure surfaces through the SAME {@link WORKTREE_FINALIZE_SUITE_RED_REASON} path.
 * Optional and defaulted `false` so an existing caller/fake omitting it is
 * unaffected. Injected so the fast tier drives the verdicts purely; production
 * wires the real scratch-provision-plus-suite-run ({@link runMergeSuiteGate}).
 */
export type MergeSuiteProbe = (args: {
  repoDir: string;
  mergedCommit: string;
  runsPlanSuite: boolean;
  runsSmokeGate?: boolean;
}) => Promise<MergeSuiteVerdict>;

/**
 * The producer git driver for worktree mode — the side-effect seam
 * `runReconcileCycle` calls before `confirmRunning` (provision) and after a
 * closer reaches done (finalize). Every method runs real git on the target repo
 * and NEVER writes keeper.db / runs in a fold. Injected so tests fake it; the
 * default impl wraps `src/worktree-git.ts`.
 */
export interface PendingIntegrationManifest {
  sourceBranch: string;
  baseBranch: string;
  laneDir: string;
  /** The source rib's branch-tip SHA the producer pinned at mint — the durable
   *  head fence the resolver rechecks so the requested clean fast-forward is
   *  distinguishable from a moved head. */
  sourceHead: string;
  /** The target base's branch-tip SHA the producer pinned at mint. */
  baseHead: string;
}

export function pendingIntegrationReason(
  manifest: PendingIntegrationManifest,
): string {
  return (
    `${MERGE_ESCALATION_REASON_TOKEN}: merging ${manifest.sourceBranch} into ` +
    `${manifest.baseBranch} — ${buildPendingIntegrationTail(
      manifest.sourceHead,
      manifest.baseHead,
    )}`
  );
}

/**
 * The outcome of a PRODUCER-side pre-close base assembly ({@link
 * WorktreeDriver.assembleBase}) — an ACTUAL fan-in, distinct from the
 * owner-mediated {@link WorktreeDriver.provision} readiness prep:
 *   - `assembled` — every clean source rib is merged into the group base AND a
 *      positive re-probe confirms each is an ancestor; the close may launch.
 *   - `conflict`  — a source rib hit a genuine content conflict (aborted). The
 *      producer routes it through the EXISTING `worktree-merge-conflict` incident
 *      machinery on the bare `close::<epic>` key (owner re-dispatch + claim chain),
 *      never a silent retry.
 *   - `defer`     — a transient / not-ready state (lock or local timeout, a
 *      not-quiescent base, an inconclusive re-probe). Sticky-free retry next cycle.
 *   - `failed`    — a STRUCTURAL provision failure (the worktree could not be
 *      ensured / a HEAD mismatch / a guarded merge-abort wedge). A visible sticky.
 */
export type AssembleBaseResult =
  | { kind: "assembled" }
  | {
      kind: "conflict";
      sourceBranch: string;
      baseBranch: string;
      laneDir: string;
      conflictedFiles: string[];
      stderr: string;
    }
  | { kind: "defer"; reason: string }
  | { kind: "failed"; reason: string };

export interface WorktreeDriver {
  /**
   * Refresh one drifted, quiescent epic base by merging the local default branch
   * into the base branch in the base's own linked worktree. Every unsuccessful
   * refresh, including content conflict, is a non-sticky defer: drift remains
   * observable and the next owning fan-in integration handles it.
   */
  refreshBase(
    entry: BaseDriftEntry,
    nowSeconds: number,
  ): Promise<{ ok: true } | { ok: false; reason: string; retry?: boolean }>;
  /**
   * Provision the lane for one launch: ensure the worktree exists (lazily, off
   * the parent lane's committed tip), prepare the first unresolved fan-in source,
   * then assert the worktree HEAD equals the derived branch. A prepared source is
   * returned as `pendingIntegration`; the producer records that manifest on the
   * owning dispatch key before launching into the bare base.
   *
   * Preparation preserves the lane pre-merge safety boundary without performing
   * the merge. A dirty base is losslessly cleaned only when its dirt is a
   * provably-redundant leak of the incoming rib and none is in
   * `liveAttributedDirty`; every other not-ready state returns the existing
   * self-clearing {@link WORKTREE_LANE_PREMERGE_REASON_PREFIX} failure keyed by
   * the lane path. The driver never reads attribution itself.
   */
  provision(
    info: WorktreeLaunchInfo,
    liveAttributedDirty: ReadonlySet<string> | null,
  ): Promise<
    | {
        ok: true;
        cwd: string;
        pendingIntegration?: PendingIntegrationManifest;
      }
    | {
        ok: false;
        reason: string;
        retry?: boolean;
        dir?: string;
        conflictedFiles?: string[];
      }
  >;
  /**
   * PRE-CLOSE fan-in for a NON-close-host worktree group of a clustered epic:
   * ensure the sink base worktree, INTEGRATE every clean source rib into the base
   * under the same commit-work lock + readiness discipline {@link provision} preps
   * but never performs, then POSITIVELY re-probe that every source is an ancestor of
   * the base. A serial-primary close hosts NO worker in these lanes, so the PRODUCER
   * assembles the base here (reusing the shared pairwise merge routine, never a
   * second merge path) before authorizing the close launch. See {@link
   * AssembleBaseResult} for the four outcomes and their routing.
   */
  assembleBase(
    info: WorktreeLaunchInfo,
    liveAttributedDirty: ReadonlySet<string> | null,
  ): Promise<AssembleBaseResult>;
  /**
   * After the epic closer reaches done: prove the epic base is contained in the
   * resolved local default, verify the shared checkout, push once, then tear the
   * lane worktrees down. Returns `{ ok: true }` on clean verified teardown.
   *
   * `isEpicDone` is the MAIN-projection done-ness probe ({@link isEpicDoneById}),
   * threaded in the same way recover takes it: finalize tears down ONLY when the epic
   * is done in the projection (the closer wrote `done` to the PRIMARY repo, never
   * the lane), which rejects a crashed closer that finished but never committed
   * `done`. The lane-ahead half of the gate is the shared merge routine's
   * `not-ahead` check.
   *
   * `runMergeSuite` is the merge-suite gate probe: before origin advances, the
   * integrated local-default commit's fast suite runs on a scratch worktree. Green
   * and pass-with-note proceed to push; red parks a VISIBLE sticky with nothing
   * pushed; a configured gate that cannot run degrades to a retry-skip. OMITTED skips
   * the gate.
   *
   * A failure is one of two kinds, distinguished by `retry`:
   *  - `{ ok: false, reason }` (no `retry`) — a GENUINE block (a content merge
   *    conflict, a dirty-LANE teardown refusal, an origin-ahead non-fast-forward, OR
   *    a red merge-suite gate) needing an operator. The producer mints a STICKY
   *    `close::<epic>` DispatchFailed a human clears with `retry_dispatch`.
   *  - `{ ok: false, retry: true, reason }` — a transient environment state on the
   *    SHARED main checkout (dirty / off-branch / mid-rebase / merge-suite gate
   *    unavailable). The producer STOPS this epic's finalize but mints NO sticky
   *    failure; the next cycle retries once the tree settles. NEVER an un-clearable
   *    close, and NEVER the divergent-content, origin-ahead non-ff, or red-suite case
   *    (those stay loud sticky blocks).
   */
  finalizeEpic(
    info: WorktreeLaunchInfo,
    isEpicDone: (epicId: string) => Promise<boolean>,
    runMergeSuite?: MergeSuiteProbe,
    // Called EXACTLY ONCE after this finalize actually removes a lane worktree (a
    // completed-removal teardown), so the caller nudges the git vanished sweep to
    // retire the torn-down lane's row promptly. NEVER called when teardown is
    // deferred/failed, or is a no-op. A callback (mirroring recover's
    // `onResyncSkipped`) so the `{ ok: true }` result shape is unchanged.
    onLaneTornDown?: () => void,
  ): Promise<
    | { ok: true }
    | {
        ok: false;
        reason: string;
        retry?: boolean;
        conflictedFiles?: string[];
      }
  >;
  /**
   * OFF-mode assertion: confirm `cwd` is on the repo's resolved default branch.
   * Returns `{ ok: true }` when it is, else `{ ok: false, reason }` (a sticky
   * `not-on-default-branch` DispatchFailed). This is the ONLY behavioral change
   * worktree-OFF mode adds over today's dispatch.
   */
  assertOnDefaultBranch(
    cwd: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Producer-only crash/restart recovery, run BEFORE each reconcile
   * cycle (so it also covers the boot drain — the first cycle is the post-restart
   * sweep). Two idempotent passes over LIVE git, never a window-bounded projection
   * read, so a restart between an epic-done and its merge-to-default cannot orphan
   * the work:
   *  1. INTERRUPTED MERGE, TRI-STATE: every registered linked lane is probed for a
   *     live claim. A LIVE (or inconclusive) claim HOLDS the lane — its `MERGE_HEAD`
   *     is the owner's own merge, so maintenance defers with a bounded reason and
   *     mutates nothing, and the hold also excludes every later maintenance mutation
   *     in that worktree. A DEAD or absent claim leaves crash residue instead:
   *     `git merge --abort` → `git worktree prune --expire now`, so the next cycle
   *     re-runs the merge from a clean state (level-triggered retry, no in-process
   *     self-heal). An abort that FAILS records `worktree-recover-abort-failed` and
   *     its surviving `MERGE_HEAD` surfaces as an IMMEDIATE lane wedge — a hold
   *     never suppresses that escalation.
   *  2. CLOSED-BASE BACKSTOP: enumerate `keeper/epic/<id>` base branches from
   *     git. Owner-mediated mode first verifies owner integration and leaves an
   *     unintegrated base to a dispatchable closer; only a closed/tombstoned epic
   *     with no dispatchable closer falls back to daemon merge + push. An already-
   *     integrated base is only verified/pushed. DECOUPLED from the recent-done
   *     window.
   *
   *  3. ORPHAN-LANE PRUNE: tear down each `keeper/epic/<id>` lane (base AND rib)
   *     whose epic `epicPresentAndNotDone` reports inactive (ABSENT or done),
   *     gated by a SECONDARY is-ancestor-of-default safety. A live epic's lanes
   *     are PRESERVED (an omitted probe defaults to preserve — fail-safe). ALSO
   *     PRESERVED: a lane whose epic has an OCCUPYING close or work job
   *     (`epicHasOccupyingJob`) — a done epic's closer is still mid-turn INSIDE the
   *     lane, so tearing it down would delete its cwd (ADR 0031). A plain skip (a
   *     live occupant self-resolves when its pane dies), never a failure row.
   *
   * Returns a {@link WorktreeRecoveryOutcome} — transient `failures` (auto-clear
   * scope), terminal `escalations` (the bare `close::<epic>` merge-escalation scope),
   * and positive `resolved` observations (the clear predicate's evidence set) — for
   * the caller to mint / clear; a recovery failure NEVER throws past the driver (a
   * producer git error must not wedge the cycle). `isEpicDone` is pass-2's tri-state
   * probe: it MAY return the legacy boolean (`true`→done, `false`→open) so existing
   * callers are byte-identical, or the full {@link EpicRecoverVerdict} so pass-2 can
   * distinguish authoritatively-absent (clear) from inconclusive (defer).
   */
  recover(
    repos: readonly string[],
    isEpicDone: (epicId: string) => Promise<boolean | EpicRecoverVerdict>,
    epicPresentAndNotDone: (epicId: string) => Promise<boolean>,
    hasActiveResolver: (epicId: string) => boolean,
    epicHasOccupyingJob: (epicId: string) => boolean,
    laneTeardown?: LaneTeardownRecoveryOptions,
    laneMaintenanceProbe?: LaneMaintenanceProbe,
    hasDispatchableCloser?: (epicId: string) => boolean,
    openRecoverRows?: readonly {
      id: string;
      epicId: string | null;
      dir: string;
    }[],
  ): Promise<WorktreeRecoveryOutcome>;
  /**
   * PERIODIC ORIGIN-CONTAINMENT reconcile (producer-only, once per cycle): for each
   * repo, push local default to origin ONLY on positive evidence (local default STRICTLY
   * ahead of origin AND non-diverged), so a finalize push that never landed no longer
   * leaves origin frozen while local leads. Defers on any inconclusive probe and on a
   * repo already pushed this cycle; a diverged / origin-ahead repo keeps its existing
   * visible sticky path (never auto-reconciled, never a force). Reuses the SAME
   * {@link reconcileOriginContainment} probe + {@link pushDefaultToOrigin} path per repo,
   * never a fold. Returns the resolved `defaultBranch` per repo so the caller builds the
   * fallback distress reason via {@link classifyOriginContainment}. Optional so existing
   * driver fakes stay byte-compatible.
   */
  reconcileOrigin?(repos: readonly string[]): Promise<
    {
      dir: string;
      defaultBranch: string;
      result: OriginContainmentResult;
    }[]
  >;
  /**
   * The parts-6 PROGRESS ACTOR (producer-only, once per cycle): integrate a blocking done
   * sibling's rib into each sibling-source-gate HELD dependent's EXISTING stale lane so the
   * gate clears — the deadlock the target-selection seam introduces. Runs the shared
   * {@link runProgressActor} with the driver's own `run` + commit-work lock. Optional so
   * existing driver fakes stay byte-compatible.
   */
  progressActor?(
    heldTaskIds: ReadonlySet<string>,
    epics: readonly Epic[],
    worktreeRepoByEpicId: ReadonlyMap<string, WorktreeRepoResolution>,
    worktreesRoot: string | undefined,
    laneLiveness: LaneMaintenanceProbe | undefined,
    hasActiveResolver: (epicId: string) => boolean,
  ): Promise<ProgressActorOutcome>;
}

/** Reuse the backend's launch envelope shape. The `retryable` discriminant on a
 *  failure routes a TRANSIENT launch fail (keeper agent exit 4 / timeout-kill /
 *  bad-path) to `"indoubt"` (keep the pending row → TTL→`DispatchExpired`
 *  re-dispatch) instead of a sticky `"failed"` — kept byte-identical to
 *  `exec-backend.ts`'s `LaunchResult`. */
export type LaunchResult =
  | { ok: true }
  | { ok: false; error: string; retryable?: boolean };

/** Found-job payload from `findJob`. */
export interface FoundJob {
  job_id: string;
  last_event_id: number;
}

/**
 * Payload shape the reconciler hands to `emitDispatchFailed`. Mirrors
 * the `DispatchFailedPayload` interface in `src/reducer.ts` exactly —
 * the producer-side stamp (`ts`) is preserved through the fold so
 * `dispatch_failures.ts` is byte-identical across a re-fold.
 */
export interface DispatchFailedPayload {
  verb: Verb;
  id: string;
  reason: string;
  dir: string | null;
  conflictedFiles: string[] | null;
  ts: number;
  /** Exact admitted attempt when the failure happened after admission. */
  attempt_id?: number;
}

/**
 * Payload the reconciler hands to `emitDispatchCleared` — the `(verb, id)` whose
 * sticky `dispatch_failures` row to DELETE. No `ts`: the clear is an idempotent
 * fold-arm DELETE, so re-fold determinism needs no producer stamp (unlike a
 * failure's `created_at`).
 */
export interface DispatchClearedPayload {
  verb: Verb;
  id: string;
  expected_attempt_id: number | null;
  expected_instance_event_id: number | null;
}

export interface DispatchFailureFence {
  attempt_id: number | null;
  instance_event_id: number | null;
}

export type DispatchFailureFenceMap = ReadonlyMap<
  DispatchKey,
  DispatchFailureFence
>;

function dispatchClearedPayload(
  fences: DispatchFailureFenceMap | undefined,
  verb: Verb,
  id: string,
  claimless = false,
): DispatchClearedPayload {
  const fence = fences?.get(dispatchKey(verb, id));
  return {
    verb,
    id,
    expected_attempt_id: claimless ? null : (fence?.attempt_id ?? null),
    expected_instance_event_id: fence?.instance_event_id ?? null,
  };
}

function claimlessDistressClear(
  fences: DispatchFailureFenceMap,
  id: string,
  dir: string,
): {
  id: string;
  dir: string;
  expected_attempt_id: null;
  expected_instance_event_id: number | null;
} {
  const fence = fences.get(`daemon::${id}` as DispatchKey);
  return {
    id,
    dir,
    expected_attempt_id: null,
    expected_instance_event_id: fence?.instance_event_id ?? null,
  };
}

/**
 * Interval (in producer-`ts` seconds) after which a still-unchanged
 * `DispatchFailed` condition re-announces once as a liveness watermark, so its
 * row's last-seen stays fresh instead of going silent forever. Sparse enough to
 * kill the per-cycle storm, frequent enough to prove the condition is still live.
 */
export const DISPATCH_FAILED_WATERMARK_SEC = 15 * 60;

/**
 * Producer-side change-gate for `DispatchFailed` emission. The reconciler
 * re-derives every failure from live git each cycle, so an unconditional emit
 * mints ONE event per cycle for a persistently-stuck condition — a storm. This
 * collapses identical re-emits, keyed per `(verb, id)`:
 *  - FIRST appearance of a `(verb, id)` → emit.
 *  - A REASON CHANGE for the same `(verb, id)` → emit immediately (dirty→conflict
 *    is new, actionable information the gate must never swallow).
 *  - An identical re-emit while the condition persists → suppress, EXCEPT
 *  - a still-unchanged condition re-announces at most once per
 *    {@link DISPATCH_FAILED_WATERMARK_SEC} (the producer `ts` is the clock) as a
 *    bounded liveness watermark.
 * A DispatchCleared resets the gate only after a later projection acknowledges
 * that exact incident disappeared, so a dropped or stale clear cannot re-arm it.
 *
 * In-worker memory only, mirroring the `lastWorktreeStatusKey` change-gate. Two
 * ACCEPTED, BOUNDED degradations: (1) a daemon restart empties the gate and
 * re-emits once per still-present condition — a bounded boot burst; a crash-
 * looping daemon regresses toward the old per-cycle behavior, which is its own
 * louder alarm. (2) An operator `retry_dispatch` clears a row via the reducer
 * (not through `noteClear`), so a still-stuck condition re-surfaces within one
 * watermark interval rather than instantly.
 */
export interface DispatchFailedGate {
  /** True → post this event; false → suppress an identical re-emit. */
  shouldEmit(payload: DispatchFailedPayload): boolean;
  /** Remember a posted clear; projection acknowledgement performs the reset. */
  noteClear(payload: DispatchClearedPayload): void;
  /** Reset only after the exact observed incident disappears; a replacement is stale. */
  observeProjection(fences: DispatchFailureFenceMap): void;
  /** Immediately forget a `(verb, id)`'s last-emitted memory — the EXTERNAL-clear reset for
   *  a row an operator cleared through the reducer (`retry_dispatch`), which never rode
   *  `noteClear`. The producer calls it on a positive observed-then-gone lift so the
   *  identical re-mint after a same-finding re-halt is NOT suppressed to the watermark. */
  forget(verb: string, id: string): void;
}

/**
 * Build a {@link DispatchFailedGate}. Pure of keeper.db / IO / the wall clock —
 * the producer `ts` threaded through each payload is the only clock — so the fast
 * tier drives first-emit / suppress / reason-change / clear-reset / watermark
 * cadence directly. `watermarkSec` is injectable for the cadence test.
 */
export function createDispatchFailedGate(
  watermarkSec: number = DISPATCH_FAILED_WATERMARK_SEC,
): DispatchFailedGate {
  // `${verb}\u0000${id}`: a NUL join is collision-free (neither field carries a
  // NUL), the same composite-key discipline the provision fan-in set uses.
  const keyOf = (verb: string, id: string): string => `${verb}\u0000${id}`;
  const lastEmitted = new Map<string, { reason: string; ts: number }>();
  const pendingClear = new Map<
    string,
    { verb: Verb; id: string; instanceEventId: number }
  >();
  return {
    shouldEmit(payload) {
      const key = keyOf(payload.verb, payload.id);
      const prev = lastEmitted.get(key);
      if (prev === undefined || prev.reason !== payload.reason) {
        lastEmitted.set(key, { reason: payload.reason, ts: payload.ts });
        return true;
      }
      if (payload.ts - prev.ts >= watermarkSec) {
        // Still-stuck liveness watermark — re-announce and re-anchor the clock so
        // the next watermark is one interval out (a steady cadence, not a burst).
        prev.ts = payload.ts;
        return true;
      }
      return false;
    },
    noteClear(payload) {
      if (payload.expected_instance_event_id == null) return;
      pendingClear.set(keyOf(payload.verb, payload.id), {
        verb: payload.verb,
        id: payload.id,
        instanceEventId: payload.expected_instance_event_id,
      });
    },
    observeProjection(fences) {
      for (const [key, pending] of pendingClear) {
        const current = fences.get(dispatchKey(pending.verb, pending.id));
        if (current?.instance_event_id === pending.instanceEventId) continue;
        pendingClear.delete(key);
        if (current === undefined) lastEmitted.delete(key);
      }
    },
    forget(verb, id) {
      const key = keyOf(verb, id);
      lastEmitted.delete(key);
      pendingClear.delete(key);
    },
  };
}

/**
 * Grace window (in producer-`ts` seconds) a shared MAIN checkout may stay
 * mid-merge before the recover pass escalates the wedge into a visible per-repo
 * distress row. The immediate per-epic `worktree-recover-*` reason fires the FIRST
 * cycle regardless; the distress is the sustained-wedge layer ON TOP. ~5 minutes —
 * long enough that a keeper-owned residue self-heals (its guarded abort fires the
 * next cycle) and a transient lock frees inside the window, short enough that a
 * genuine wedge (foreign residue, or an abort that keeps failing) surfaces fast.
 * Injectable so the fast tier drives the grace-crossing without a real clock.
 */
export const SHARED_CHECKOUT_WEDGE_GRACE_SEC = 5 * 60;

/**
 * The SIBLING grace window (producer-`ts` seconds) a shared MAIN checkout may stay
 * plain-DIRTY (a non-clean working tree, no MERGE_HEAD) before the recover pass
 * escalates the sustained dirt into a visible per-repo distress row — the same short
 * ~5min watermark the mid-merge wedge uses: long enough that a transient in-flight
 * commit-work settles inside the window, short enough that persistent operator dirt
 * surfaces fast. Injectable so the fast tier drives the grace-crossing without a
 * real clock. Kept a DISTINCT const from the wedge grace so the two can diverge.
 */
export const SHARED_CHECKOUT_DIRTY_GRACE_SEC = 5 * 60;

/**
 * The `dispatch_failures` id a per-repo shared-checkout-wedge distress row keys on
 * — `shared-checkout-wedge:<repoDirHash(repoDir)>`. Reuses the base36 {@link
 * repoDirHash} so the mint and the level-clear target the SAME row across cycles,
 * and two checkouts on a multi-repo board get DISTINCT rows. The composite
 * `daemon::shared-checkout-wedge:<hash>` deliberately fails the `retry_dispatch`
 * wire validator (the synthetic `daemon` verb), so only the level-trigger clears it.
 */
export function sharedWedgeDistressId(repoDir: string): string {
  return `${SHARED_WEDGE_DISTRESS_ID_PREFIX}${repoDirHash(repoDir)}`;
}

/**
 * Consecutive same-repo finalize push-timeout skips tolerated before the silent
 * retry loop escalates into a VISIBLE sticky failure. Three cycles separates a
 * transient network stall (which resolves inside the window) from a wedged
 * push, where every silent retry lets origin fall further behind unbounded.
 */
export const STUCK_PUSH_STICKY_THRESHOLD = 3;

/** In-memory per-repo consecutive push-timeout streak. Boots empty on restart
 * — a genuinely stuck push re-accumulates within three cycles. */
const pushTimeoutStreakByRepo = new Map<string, number>();

/** Bump `repoDir`'s consecutive push-timeout streak, returning true once it
 * crosses {@link STUCK_PUSH_STICKY_THRESHOLD}. Pure counter — the caller owns
 * the escalation. */
export function recordPushTimeout(repoDir: string): boolean {
  const n = (pushTimeoutStreakByRepo.get(repoDir) ?? 0) + 1;
  pushTimeoutStreakByRepo.set(repoDir, n);
  return n >= STUCK_PUSH_STICKY_THRESHOLD;
}

/** Reset `repoDir`'s push-timeout streak on any healthy push-surface outcome
 * (pushed, or nothing to push). */
export function clearPushTimeoutStreak(repoDir: string): void {
  pushTimeoutStreakByRepo.delete(repoDir);
}

/**
 * Repos that already had an origin-push ATTEMPT in the CURRENT reconcile cycle —
 * stamped inside {@link pushDefaultToOrigin} (the ONE finalize / recover / containment
 * push chokepoint) and reset once per cycle by {@link beginContainmentCycle}. The
 * periodic origin-containment probe skips a repo already attempted this cycle so a
 * timed-out finalize / recover push is never IMMEDIATELY re-attempted, stacking a
 * second scaled deadline into the same cycle ("no push in flight"). In-memory only;
 * boots empty on restart.
 */
const pushAttemptedThisCycleByRepo = new Set<string>();

/** Clear the per-cycle push-attempt guard at the TOP of a reconcile cycle so the
 * containment probe sees only THIS cycle's finalize / recover push attempts. */
export function beginContainmentCycle(): void {
  pushAttemptedThisCycleByRepo.clear();
}

/**
 * Deadline scaling for the finalize / recover origin push. The push (see
 * {@link pushDefaultToOrigin}) uploads the WHOLE local-default backlog to origin in ONE
 * shot; once that backlog outgrows the fixed {@link GIT_PUSH_TIMEOUT_MS} the push
 * re-times-out every retry and re-pushes the same (still-growing) backlog forever — the
 * spiral. So the deadline SCALES with the commits-ahead count: `base +
 * FINALIZE_PUSH_PER_COMMIT_MS × min(ahead, cap)`. The cap keeps a pathological backlog
 * from producing an UNBOUNDED deadline, which would defeat the push-stuck wedge
 * detection (three consecutive timeouts). `commit-work`'s own push path keeps the fixed
 * {@link GIT_PUSH_TIMEOUT_MS} — only finalize scales.
 */
export const FINALIZE_PUSH_PER_COMMIT_MS = 6_000;
export const FINALIZE_PUSH_AHEAD_CAP = 40;

/** The scaled finalize-push wall-clock deadline (ms) for a backlog of `ahead` commits —
 *  `GIT_PUSH_TIMEOUT_MS` for a small push, growing linearly and capped. Pure. */
export function finalizePushDeadlineMs(ahead: number): number {
  const bounded = Math.min(
    Math.max(Number.isFinite(ahead) ? Math.trunc(ahead) : 0, 0),
    FINALIZE_PUSH_AHEAD_CAP,
  );
  return GIT_PUSH_TIMEOUT_MS + FINALIZE_PUSH_PER_COMMIT_MS * bounded;
}

/**
 * The `dispatch_failures` id a per-repo shared-checkout-DIRTY distress row keys on —
 * `shared-checkout-dirty:<repoDirHash(repoDir)>`. The SIBLING of {@link
 * sharedWedgeDistressId} on a DISTINCT prefix, so a mid-merge wedge row and a
 * plain-dirt row for the SAME repo are two independent rows that never cross-clear,
 * yet each is per-repo stable across cycles (the mint and the level-clear hit the
 * same row) and distinct across repos on a multi-repo board. The composite
 * `daemon::shared-checkout-dirty:<hash>` fails the `retry_dispatch` wire validator
 * (synthetic `daemon` verb), so only the level-trigger clears it.
 */
export function sharedDirtyDistressId(repoDir: string): string {
  return `${SHARED_DIRTY_DISTRESS_ID_PREFIX}${repoDirHash(repoDir)}`;
}

/**
 * The `dispatch_failures` id a PER-(EPIC,REPO) stale-base-lane distress row keys on —
 * `stale-base-lane:<epicId>-<repoDirHash(repoDir)>` (composed
 * `daemon::stale-base-lane:<epicId>-<hash>`). Mirrors {@link
 * worktreeFinalizeDispatchId}'s per-(epic,repo) shape so an epic whose lane is cut
 * stale in two repos of a clustered epic keys two DISTINCT rows, and the mint + the
 * level-clear target the SAME row across cycles (the epic id is dispatch-safe and
 * {@link repoDirHash} is base36). The synthetic `daemon` verb fails the
 * `retry_dispatch` wire validator, so only the probe's level-trigger clears it.
 */
export function staleBaseLaneDistressId(
  epicId: string,
  repoDir: string,
): string {
  return `${STALE_BASE_DISTRESS_ID_PREFIX}${epicId}-${repoDirHash(repoDir)}`;
}

/**
 * The `dispatch_failures` id a PER-(PROJECT,NUMBER) duplicate-epic-number distress row keys
 * on — `dup-epic-number:<repoDirHash(projectDir)>-<number>` (composed
 * `daemon::dup-epic-number:<hash>-<number>`). Mirrors {@link staleBaseLaneDistressId}'s
 * composed-key shape so one duplicated number keys ONE stable row (the mint + the
 * level-clear target the same row across cycles), and two distinct duplicated numbers, or
 * the same number in two projects, key DISTINCT rows ({@link repoDirHash} is base36, so the
 * `-<number>` suffix never ambiguates the hash). The synthetic `daemon` verb fails the
 * `retry_dispatch` wire validator, so only the probe's level-trigger clears it.
 */
export function dupEpicNumberDistressId(
  projectDir: string,
  epicNumber: number,
): string {
  return `${DUP_EPIC_NUMBER_DISTRESS_ID_PREFIX}${repoDirHash(
    projectDir,
  )}-${epicNumber}`;
}

/**
 * The `dispatch_failures` id a per-repo shared-checkout-DESYNC distress row keys on —
 * `shared-checkout-desync:<repoDirHash(repoDir)>`. A SIBLING of {@link
 * sharedWedgeDistressId} / {@link sharedDirtyDistressId} on a DISTINCT prefix, so a
 * desync row and a wedge/dirty row for the SAME repo are independent rows that never
 * cross-clear, yet each is per-repo stable across cycles (the mint and the level-clear
 * hit the same row) and distinct across repos on a multi-repo board. The composite
 * `daemon::shared-checkout-desync:<hash>` fails the `retry_dispatch` wire validator
 * (synthetic `daemon` verb), so only the per-cycle content probe's level-trigger clears
 * it.
 */
export function sharedDesyncDistressId(repoDir: string): string {
  return `${SHARED_DESYNC_DISTRESS_ID_PREFIX}${repoDirHash(repoDir)}`;
}

/**
 * The `dispatch_failures` id a per-repo ORIGIN-CONTAINMENT-STUCK distress row keys on —
 * `origin-containment-stuck:<repoDirHash(repoDir)>`. A SIBLING of the shared-checkout
 * distress ids on a DISTINCT prefix, so it never cross-classifies / cross-clears them nor
 * the epic-scoped `worktree-finalize-*` push-stuck rows. Per-repo stable across cycles (the
 * grace mint and the positive-evidence level-clear hit the same row) and distinct across
 * repos. The composite `daemon::origin-containment-stuck:<hash>` fails the `retry_dispatch`
 * wire validator (synthetic `daemon` verb), so only the per-cycle containment probe's
 * level-trigger clears it.
 */
export function originContainmentDistressId(repoDir: string): string {
  return `${ORIGIN_CONTAINMENT_DISTRESS_ID_PREFIX}${repoDirHash(repoDir)}`;
}

// ── Terminal autopilot pane teardown ───────────────────────────────────────

/** Board verbs whose autopilot-dispatched terminal panes Keeper owns. */
export const TERMINAL_PANE_TEARDOWN_VERBS: ReadonlySet<string> = new Set([
  "work",
  "close",
  "resolve",
  "deconflict",
  "repair",
  "unblock",
]);

/** Maximum exact windows one terminal-pane sweep may tear down. */
export const TERMINAL_PANE_TEARDOWN_MAX_PER_SWEEP = 5;

/** Maximum pane-owner records one periodic pass admits to its DB join. */
export const TERMINAL_PANE_TEARDOWN_SCAN_MAX = 256;

/** Idle cadence for restart recovery when no DB commit wakes the worker. */
export const TERMINAL_PANE_TEARDOWN_IDLE_MS = 5_000;

export type TerminalPaneProcessIdentity =
  | "alive"
  | "dead"
  | "recycled"
  | "unknown";

/** Terminal row joined to the immutable lifecycle event's pre-clear pane id. */
export interface TerminalPaneTeardownJob {
  job_id: string;
  state: string;
  pid: number | null;
  start_time: string | null;
  dispatch_origin: string | null;
  plan_verb: string | null;
  plan_ref: string | null;
  adopted: number | null;
  backend_exec_type: string | null;
  terminal_pane_id: string | null;
}

export interface TerminalPaneTeardownDecision {
  jobId: string;
  paneId: string;
}

export interface TerminalPaneOwnerScan {
  jobIds: string[];
  nextCursor: string | null;
}

/**
 * Select one bounded page of exact pane owners. The caller retains
 * `nextCursor` across periodic passes, so a stable prefix of manual/live owners
 * cannot starve terminal candidates later in the tmux server snapshot.
 */
export function selectTerminalPaneOwnerScan(
  panes: readonly PaneInfo[] | null,
  afterJobId: string | null = null,
  limit: number = TERMINAL_PANE_TEARDOWN_SCAN_MAX,
): TerminalPaneOwnerScan {
  if (panes === null) return { jobIds: [], nextCursor: null };
  const allOwnerIds = [
    ...new Set(
      panes
        .filter(
          (pane) =>
            pane.sessionName === MANAGED_EXEC_SESSION &&
            typeof pane.keeperJobId === "string" &&
            pane.keeperJobId !== "",
        )
        .map((pane) => pane.keeperJobId as string),
    ),
  ].sort();
  if (allOwnerIds.length === 0) return { jobIds: [], nextCursor: null };

  const boundedLimit = Math.max(
    1,
    Math.min(TERMINAL_PANE_TEARDOWN_SCAN_MAX, Math.floor(limit)),
  );
  const firstAfter =
    afterJobId === null
      ? 0
      : allOwnerIds.findIndex((jobId) => jobId > afterJobId);
  const start = firstAfter < 0 ? 0 : firstAfter;
  const jobIds = allOwnerIds.slice(start, start + boundedLimit);
  const reachedEnd = start + jobIds.length >= allOwnerIds.length;
  return {
    jobIds,
    nextCursor: reachedEnd ? null : (jobIds.at(-1) ?? null),
  };
}

/**
 * Pure fail-closed boundary for terminal pane teardown. Positive authority is
 * the full conjunction: terminal state, literal autopilot provenance, a board
 * verb/ref, non-adopted tmux job, exact lifecycle pane id, matching pane-local
 * owner record, and proof that the recorded agent process is gone. A live
 * foreground agent command also vetoes teardown, closing the resume-before-bind
 * window even when the prior process identity is dead.
 */
export function decideTerminalPaneTeardowns(input: {
  jobs: readonly TerminalPaneTeardownJob[];
  panes: readonly PaneInfo[] | null;
  processIdentityByJobId: ReadonlyMap<
    string,
    TerminalPaneProcessIdentity
  > | null;
  maxPerSweep?: number;
  afterJobId?: string | null;
}): TerminalPaneTeardownDecision[] {
  if (input.panes === null || input.processIdentityByJobId === null) return [];
  const paneById = new Map(input.panes.map((pane) => [pane.paneId, pane]));
  const paneCountByWindow = new Map<string, number>();
  for (const pane of input.panes) {
    paneCountByWindow.set(
      pane.windowId,
      (paneCountByWindow.get(pane.windowId) ?? 0) + 1,
    );
  }
  const decisions: TerminalPaneTeardownDecision[] = [];
  const seenPanes = new Set<string>();

  for (const job of input.jobs) {
    if (
      job.state !== "ended" &&
      job.state !== "killed" &&
      job.state !== "autoclosed"
    ) {
      continue;
    }
    if (job.dispatch_origin !== "autopilot") continue;
    if (
      job.plan_verb == null ||
      !TERMINAL_PANE_TEARDOWN_VERBS.has(job.plan_verb) ||
      job.plan_ref == null ||
      job.plan_ref === ""
    ) {
      continue;
    }
    if (job.adopted === 1 || job.backend_exec_type !== "tmux") continue;
    const paneId = job.terminal_pane_id;
    if (paneId == null || paneId === "" || seenPanes.has(paneId)) continue;
    const pane = paneById.get(paneId);
    if (
      pane == null ||
      pane.keeperJobId !== job.job_id ||
      pane.sessionName !== MANAGED_EXEC_SESSION ||
      paneCountByWindow.get(pane.windowId) !== 1
    ) {
      continue;
    }
    const identity = input.processIdentityByJobId.get(job.job_id);
    if (identity !== "dead" && identity !== "recycled") continue;
    if (pane.paneDead !== "1" && !isBareShellCommand(pane.currentCommand)) {
      continue;
    }
    seenPanes.add(paneId);
    decisions.push({ jobId: job.job_id, paneId });
  }

  decisions.sort((a, b) => {
    const byJob = a.jobId.localeCompare(b.jobId);
    return byJob === 0 ? a.paneId.localeCompare(b.paneId) : byJob;
  });
  const afterJobId = input.afterJobId;
  const firstAfter =
    afterJobId == null
      ? 0
      : decisions.findIndex((decision) => decision.jobId > afterJobId);
  const ordered =
    firstAfter > 0
      ? [...decisions.slice(firstAfter), ...decisions.slice(0, firstAfter)]
      : decisions;
  const cap = Math.max(
    0,
    Math.min(
      TERMINAL_PANE_TEARDOWN_MAX_PER_SWEEP,
      Math.floor(input.maxPerSweep ?? TERMINAL_PANE_TEARDOWN_MAX_PER_SWEEP),
    ),
  );
  return ordered.slice(0, cap);
}

/**
 * Read terminal rows only for pane-local owners in the current healthy tmux
 * observation. The lifecycle event retains the pane id that the terminal jobs
 * fold deliberately clears, and the pure seam requires it to match the current
 * pane before authorizing any action.
 */
export function loadTerminalPaneTeardownJobs(
  db: Parameters<typeof runQuery>[0],
  panes: readonly PaneInfo[] | null,
  scannedOwnerJobIds?: readonly string[],
): TerminalPaneTeardownJob[] {
  if (panes === null) return [];
  const ownerIds = [
    ...new Set(scannedOwnerJobIds ?? selectTerminalPaneOwnerScan(panes).jobIds),
  ]
    .sort()
    .slice(0, TERMINAL_PANE_TEARDOWN_SCAN_MAX);
  if (ownerIds.length === 0) return [];
  const placeholders = ownerIds.map(() => "?").join(",");
  return db
    .query(
      `SELECT j.job_id, j.state, j.pid, j.start_time, j.dispatch_origin,
              j.plan_verb, j.plan_ref, j.adopted, j.backend_exec_type,
              e.backend_exec_pane_id AS terminal_pane_id
         FROM jobs j
         JOIN events e ON e.id = (
           SELECT e2.id
             FROM events e2
            WHERE e2.session_id = j.job_id
              AND e2.id <= j.last_event_id
              AND e2.hook_event IN ('SessionEnd', 'Killed')
            ORDER BY e2.id DESC
            LIMIT 1
         )
        WHERE j.job_id IN (${placeholders})
          AND j.state IN ('ended', 'killed', 'autoclosed')
          AND j.dispatch_origin = 'autopilot'
          AND j.plan_verb IN ('work', 'close', 'resolve', 'deconflict', 'repair', 'unblock')
          AND j.plan_ref IS NOT NULL AND j.plan_ref != ''
          AND COALESCE(j.adopted, 0) != 1
          AND j.backend_exec_type = 'tmux'
          AND e.backend_exec_pane_id IS NOT NULL
          AND e.backend_exec_pane_id != ''
        ORDER BY e.id, j.job_id`,
    )
    .all(...ownerIds) as TerminalPaneTeardownJob[];
}

function terminalPaneProcessIdentities(
  jobs: readonly TerminalPaneTeardownJob[],
  deps: {
    isPidAlive: (pid: number) => boolean;
    readStartTime: (pid: number) => string | null;
  },
): Map<string, TerminalPaneProcessIdentity> {
  const out = new Map<string, TerminalPaneProcessIdentity>();
  for (const job of jobs) {
    try {
      out.set(
        job.job_id,
        classifyProcessIdentity(job.pid, job.start_time, deps),
      );
    } catch {
      out.set(job.job_id, "unknown");
    }
  }
  return out;
}

/**
 * Run one periodic/transition-driven teardown pass. The second pane sweep, jobs
 * read, and process-identity probe are adjacent to the kill and repeat every
 * authority predicate; a stale plan can therefore only degrade to no action.
 */
export async function runTerminalPaneTeardownSweep(
  db: Parameters<typeof runQuery>[0],
  backend: Pick<TmuxPaneOps, "listPanes" | "killWindow">,
  initialPanes: readonly PaneInfo[] | null,
  deps: {
    isPidAlive?: (pid: number) => boolean;
    readStartTime?: (pid: number) => string | null;
    noteLine?: (line: string) => void;
    scannedOwnerJobIds?: readonly string[];
    afterJobId?: string | null;
  } = {},
): Promise<TerminalPaneTeardownDecision[]> {
  const probes = {
    isPidAlive: deps.isPidAlive ?? isPidAlive,
    readStartTime: deps.readStartTime ?? readOsStartTime,
  };
  const initialJobs = loadTerminalPaneTeardownJobs(
    db,
    initialPanes,
    deps.scannedOwnerJobIds,
  );
  const planned = decideTerminalPaneTeardowns({
    jobs: initialJobs,
    panes: initialPanes,
    processIdentityByJobId: terminalPaneProcessIdentities(initialJobs, probes),
    afterJobId: deps.afterJobId,
  });
  if (planned.length === 0) return [];

  const decided: TerminalPaneTeardownDecision[] = [];
  for (const candidate of planned) {
    let actPanes: readonly PaneInfo[] | null;
    try {
      actPanes = await backend.listPanes();
    } catch {
      break;
    }
    if (actPanes === null) break;
    const actJobs = loadTerminalPaneTeardownJobs(db, actPanes, [
      candidate.jobId,
    ]).filter(
      (job) =>
        job.job_id === candidate.jobId &&
        job.terminal_pane_id === candidate.paneId,
    );
    const revalidated = decideTerminalPaneTeardowns({
      jobs: actJobs,
      panes: actPanes,
      processIdentityByJobId: terminalPaneProcessIdentities(actJobs, probes),
      maxPerSweep: 1,
    });
    const decision = revalidated[0];
    if (
      decision == null ||
      decision.jobId !== candidate.jobId ||
      decision.paneId !== candidate.paneId
    ) {
      continue;
    }
    decided.push(decision);
    try {
      const result = await backend.killWindow(decision.paneId);
      if (!result.ok && result.error != null) {
        deps.noteLine?.(
          `terminal pane teardown deferred job=${decision.jobId} pane=${decision.paneId}: ${result.error}`,
        );
      }
    } catch (err) {
      deps.noteLine?.(
        `terminal pane teardown threw job=${decision.jobId} pane=${decision.paneId}: ${errMsg(err)}`,
      );
    }
  }
  return decided;
}

/** A long-unknown live monitor pages after this horizon; it never releases. */
export const MONITOR_SLOT_WEDGE_PAGE_SEC = 30 * 60;

export function monitorSlotWedgeDistressId(jobId: string): string {
  return `${MONITOR_SLOT_WEDGE_DISTRESS_ID_PREFIX}${jobId}`;
}

export interface OpenMonitorSlotWedge {
  id: string;
  jobId: string;
  dir: string;
}

export interface MonitorSlotWedgeDecision {
  mint: { id: string; dir: string; reason: string }[];
  clear: { id: string; dir: string }[];
}

export interface ZombieSessionCandidate {
  jobId: string;
  dir: string;
  updatedAt: number;
}

interface ReapCandidate extends ZombieSessionCandidate {
  reapClass: "monitor" | "occupancy";
  immediate: boolean;
  paneId: string | null;
}

interface PendingReapTerm {
  sentAt: number;
  stoppedAt: number;
  candidate: ReapCandidate;
}

export interface OpenZombieSessionDistress {
  id: string;
  jobId: string;
  dir: string;
  scope: "monitor" | "occupancy";
}

export interface ZombieReaperSnapshot {
  zombieSessionCandidates: ZombieSessionCandidate[];
  openZombieSessionDistresses: Map<string, OpenZombieSessionDistress>;
  zombieSessionClearActions: { id: string; dir: string }[];
}

/** Positive evidence that a monitor-slot incident ended; uncertainty retains it. */
export function monitorSlotHasPositiveClearEvidence(input: {
  activity: HarnessActivity | undefined;
  pidAlive: boolean | null;
  jobState: "present" | "terminal" | "absent";
}): boolean {
  return (
    input.activity?.status === "active" ||
    input.activity?.status === "quiescent" ||
    input.pidAlive === false ||
    input.jobState === "terminal" ||
    input.jobState === "absent"
  );
}

/**
 * Decide the page-once distress delta for long-unknown monitor occupants.
 * Presence of an open row suppresses re-minting (and therefore re-paging);
 * only producer-proven settle/exit/fact-clear evidence can clear one. A later
 * stale episode sees no open row and mints again. There is deliberately no
 * release/kill action in this contract.
 */
export function decideMonitorSlotWedgeDistress(input: {
  occupants: readonly LongUnknownMonitorOccupant[];
  open: ReadonlyMap<string, OpenMonitorSlotWedge>;
  positivelyClearedJobIds: ReadonlySet<string>;
  thresholdSec?: number;
}): MonitorSlotWedgeDecision {
  const thresholdSec = input.thresholdSec ?? MONITOR_SLOT_WEDGE_PAGE_SEC;
  const thresholdMin = Math.round(thresholdSec / 60);
  const decision: MonitorSlotWedgeDecision = { mint: [], clear: [] };
  for (const occupant of input.occupants) {
    const id = monitorSlotWedgeDistressId(occupant.jobId);
    if (input.open.has(id)) continue;
    const root = occupant.root === "" ? "?" : occupant.root;
    decision.mint.push({
      id,
      dir: occupant.root,
      reason:
        `${MONITOR_SLOT_WEDGE_DISTRESS_REASON}: dispatch root ${root} remains ` +
        `occupied by stopped pid-alive session ${occupant.jobId} after its ` +
        `worker-monitor evidence stayed resource-evidence-stale past the ` +
        `${thresholdMin}min paging horizon — inspect the session; keeper will ` +
        `not release or kill it based on age`,
    });
  }
  for (const row of input.open.values()) {
    if (input.positivelyClearedJobIds.has(row.jobId)) {
      decision.clear.push({ id: row.id, dir: row.dir });
    }
  }
  decision.mint.sort((a, b) => a.id.localeCompare(b.id));
  decision.clear.sort((a, b) => a.id.localeCompare(b.id));
  return decision;
}

export const ZOMBIE_SESSION_REAPER_GRACE_SEC = MONITOR_SLOT_WEDGE_PAGE_SEC;
export const ZOMBIE_SESSION_TERM_GRACE_SEC = 10;

export interface ZombieProcessEvidence {
  alive: boolean | null;
  startTime: string | null;
  commandOwned: boolean;
  defunct: boolean;
}

export type ZombieSessionReaperDecision =
  | {
      action: "none";
      reason: "outside-scope" | "activity" | "pid-dead" | "term-grace";
    }
  | { action: "backstop"; reason: "task-not-done" }
  | {
      action: "page";
      reason:
        | "pid-unproven"
        | "identity-unproven"
        | "identity-mismatch"
        | "command-unowned"
        | "defunct"
        | "signal-failed";
    }
  | { action: "signal"; signal: "SIGTERM" | "SIGKILL" };

/** Pure kill/page boundary for a long-stale monitor occupant. */
export function decideZombieSessionReaper(input: {
  jobState: string;
  taskDone: boolean;
  pid: number | null;
  storedStartTime: string | null;
  updatedAt: number;
  nowSec: number;
  activity: HarnessActivity | undefined;
  process: ZombieProcessEvidence;
  termSentAt?: number;
  thresholdSec?: number;
  termGraceSec?: number;
  reapClass?: "monitor" | "occupancy";
  immediate?: boolean;
}): ZombieSessionReaperDecision {
  const thresholdSec = input.thresholdSec ?? ZOMBIE_SESSION_REAPER_GRACE_SEC;
  const occupancyReap = input.reapClass === "occupancy";
  const stale = occupancyReap
    ? input.immediate === true ||
      (Number.isFinite(input.updatedAt) &&
        input.nowSec - input.updatedAt >= thresholdSec)
    : input.activity?.status === "unknown" &&
      input.activity.reason === "resource-evidence-stale" &&
      Number.isFinite(input.updatedAt) &&
      input.nowSec - input.updatedAt > thresholdSec;
  if (input.jobState !== "stopped" || !stale) {
    return {
      action: "none",
      reason: input.jobState === "stopped" ? "activity" : "outside-scope",
    };
  }
  if (!occupancyReap && !input.taskDone) {
    return { action: "backstop", reason: "task-not-done" };
  }
  if (
    input.pid == null ||
    !Number.isInteger(input.pid) ||
    input.pid <= 0 ||
    input.process.alive == null
  ) {
    return { action: "page", reason: "pid-unproven" };
  }
  if (input.process.alive === false) {
    return { action: "none", reason: "pid-dead" };
  }
  if (input.process.defunct) {
    return { action: "page", reason: "defunct" };
  }
  if (input.storedStartTime == null || input.process.startTime == null) {
    return { action: "page", reason: "identity-unproven" };
  }
  if (input.process.startTime !== input.storedStartTime) {
    return { action: "page", reason: "identity-mismatch" };
  }
  if (!input.process.commandOwned) {
    return { action: "page", reason: "command-unowned" };
  }
  if (input.termSentAt === undefined) {
    return { action: "signal", signal: "SIGTERM" };
  }
  if (
    input.nowSec - input.termSentAt <
    (input.termGraceSec ?? ZOMBIE_SESSION_TERM_GRACE_SEC)
  ) {
    return { action: "none", reason: "term-grace" };
  }
  return { action: "signal", signal: "SIGKILL" };
}

export function isKeeperLaunchedZombieCommand(
  command: string,
  planVerb: string | null,
  planRef: string | null,
): boolean {
  if (
    (planVerb !== "work" && planVerb !== "close") ||
    planRef == null ||
    planRef === ""
  ) {
    return false;
  }
  const expected = `${planVerb}::${planRef}`;
  const tokens = command.trim().split(/\s+/);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if ((token === "--name" || token === "-n") && tokens[i + 1] === expected) {
      return true;
    }
    if (token === `--name=${expected}`) return true;
  }
  return false;
}

/** Read the live process evidence used immediately before either signal. */
export function probeZombieProcess(
  pid: number,
  planVerb: string | null,
  planRef: string | null,
): ZombieProcessEvidence {
  if (!Number.isInteger(pid) || pid <= 0) {
    return {
      alive: null,
      startTime: null,
      commandOwned: false,
      defunct: false,
    };
  }
  if (!isPidAlive(pid)) {
    return {
      alive: false,
      startTime: null,
      commandOwned: false,
      defunct: false,
    };
  }
  try {
    const startTime = readOsStartTime(pid);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const state =
        close >= 0 ? stat.slice(close + 1).trimStart()[0] : undefined;
      const command = readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .replace(/\0/g, " ")
        .trim();
      return {
        alive: true,
        startTime,
        commandOwned: isKeeperLaunchedZombieCommand(command, planVerb, planRef),
        defunct: state === "Z",
      };
    }
    if (process.platform === "darwin") {
      const result = Bun.spawnSync(
        ["ps", "-ww", "-p", String(pid), "-o", "state=,args="],
        { timeout: 500 },
      );
      if (!result.success || result.exitCode !== 0) {
        return { alive: null, startTime, commandOwned: false, defunct: false };
      }
      const line = result.stdout?.toString().trim() ?? "";
      const match = /^(\S+)\s+(.*)$/.exec(line);
      return {
        alive: true,
        startTime,
        commandOwned: isKeeperLaunchedZombieCommand(
          match?.[2] ?? "",
          planVerb,
          planRef,
        ),
        defunct: match?.[1]?.startsWith("Z") ?? false,
      };
    }
    return { alive: null, startTime, commandOwned: false, defunct: false };
  } catch {
    return {
      alive: null,
      startTime: null,
      commandOwned: false,
      defunct: false,
    };
  }
}

/** Re-probe identity, then send at most one signal. */
export function runZombieSessionReaperStep(
  input: Omit<Parameters<typeof decideZombieSessionReaper>[0], "process">,
  deps: {
    probe(
      pid: number,
      planVerb: string | null,
      planRef: string | null,
    ): ZombieProcessEvidence;
    signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  },
  planVerb: string | null,
  planRef: string | null,
): ZombieSessionReaperDecision {
  const processEvidence =
    input.pid == null || !Number.isInteger(input.pid) || input.pid <= 0
      ? { alive: null, startTime: null, commandOwned: false, defunct: false }
      : deps.probe(input.pid, planVerb, planRef);
  const decision = decideZombieSessionReaper({
    ...input,
    process: processEvidence,
  });
  if (decision.action !== "signal" || input.pid == null) return decision;
  try {
    deps.signal(input.pid, decision.signal);
    return decision;
  } catch {
    return { action: "page", reason: "signal-failed" };
  }
}

export function clearDeadZombieSessionMarker(
  sessionId: string,
  decision: ZombieSessionReaperDecision,
): void {
  if (decision.action === "none" && decision.reason === "pid-dead") {
    clearDeadSessionMarker(sessionId);
  }
}

export function zombieSessionDistressId(jobId: string): string {
  return `${ZOMBIE_SESSION_DISTRESS_ID_PREFIX}${jobId}`;
}

/** A shared-checkout-wedge distress row to mint (past grace) or clear (recovered). */
export interface SharedWedgeDistressAction {
  id: string;
  dir: string;
  /** The `reason` string (mint only) — starts with {@link SHARED_WEDGE_DISTRESS_REASON}. */
  reason?: string;
}

/** The mints + clears one {@link SharedCheckoutWedgeTracker.step} decides. */
export interface SharedWedgeDistressDecision {
  mint: SharedWedgeDistressAction[];
  clear: SharedWedgeDistressAction[];
}

/**
 * Per-repo grace tracker for the shared-checkout mid-merge wedge distress. Pure of
 * keeper.db / IO / the wall clock — the producer `ts` (`nowSec`) is the only clock,
 * so the fast tier drives the grace-crossing, the exactly-once mint, and the
 * level-clear directly.
 *
 * Two independent layers keep the signal O(1) per wedge episode AND robust across a
 * daemon restart:
 *  - MINT is in-memory grace + a per-repo minted-latch: a repo wedged CONTINUOUSLY
 *    past `graceSec` mints exactly ONCE; a per-cycle re-derivation never re-mints
 *    (no storm). A restart empties the tracker, so a still-present wedge re-arms and
 *    re-mints once more after the grace re-elapses — the accepted bounded burst.
 *  - CLEAR is projection-driven (the OPEN distress rows this cycle carry, from the
 *    snapshot): any open distress row whose repo is NOT wedged this cycle clears.
 *    Driven off durable state, not the in-memory latch, so a row minted before a
 *    restart still level-clears the moment the checkout recovers.
 */
export interface SharedCheckoutWedgeTracker {
  step(input: {
    /** This cycle's wedged shared checkouts: `repoDir` → the recover-wedge reason. */
    wedged: ReadonlyMap<string, string>;
    /** `repoDir`s that currently have an OPEN distress row (from the projection). */
    openDistressDirs: ReadonlySet<string>;
    nowSec: number;
  }): SharedWedgeDistressDecision;
}

/**
 * Build a {@link SharedCheckoutWedgeTracker}. `graceSec` is injectable for the
 * cadence test.
 */
export function createSharedCheckoutWedgeTracker(
  graceSec: number = SHARED_CHECKOUT_WEDGE_GRACE_SEC,
): SharedCheckoutWedgeTracker {
  // repoDir → the first cycle-ts it was seen wedged + whether we have minted the
  // distress for THIS continuous wedge episode. In-worker memory only.
  const firstWedged = new Map<string, { sinceSec: number; minted: boolean }>();
  const graceMin = Math.round(graceSec / 60);
  return {
    step({ wedged, openDistressDirs, nowSec }) {
      const decision: SharedWedgeDistressDecision = { mint: [], clear: [] };
      // MINT layer: track each wedged repo's grace clock; cross the watermark once.
      for (const [dir, reason] of wedged) {
        let entry = firstWedged.get(dir);
        if (entry === undefined) {
          entry = { sinceSec: nowSec, minted: false };
          firstWedged.set(dir, entry);
        }
        if (!entry.minted && nowSec - entry.sinceSec >= graceSec) {
          entry.minted = true;
          decision.mint.push({
            id: sharedWedgeDistressId(dir),
            dir,
            reason:
              `${SHARED_WEDGE_DISTRESS_REASON}: ${dir} has stayed mid-merge past ` +
              `the ${graceMin}min recovery grace — the shared checkout will not ` +
              `self-heal and every plan-state commit there fails until it is ` +
              `hand-resolved (git merge --abort or resolve + commit). Last recover ` +
              `verdict: ${reason}`,
          });
        }
      }
      // Re-arm any repo no longer wedged this cycle so a future re-wedge waits the
      // full grace again (the in-memory episode is closed).
      for (const dir of firstWedged.keys()) {
        if (!wedged.has(dir)) {
          firstWedged.delete(dir);
        }
      }
      // CLEAR layer: level-trigger off the durable open-distress set — any open row
      // whose checkout is clean this cycle clears (robust across a restart).
      for (const dir of openDistressDirs) {
        if (!wedged.has(dir)) {
          decision.clear.push({ id: sharedWedgeDistressId(dir), dir });
        }
      }
      return decision;
    },
  };
}

/**
 * Per-repo grace tracker for the shared-checkout plain-DIRTY distress — the SIBLING
 * of {@link SharedCheckoutWedgeTracker} on its own id/reason, never a widening of the
 * mid-merge machinery. Identical contract (pure of keeper.db / IO / the wall clock —
 * the producer `ts` is the only clock; in-memory grace + minted-latch for an
 * exactly-once mint per dirt episode; projection-driven level-clear robust across a
 * restart), threaded off the plain-dirty `worktree-recover-dirty-checkout` recover
 * reason instead of the mid-merge wedge reasons. Reuses the verb-neutral {@link
 * SharedWedgeDistressAction} / {@link SharedWedgeDistressDecision} shapes.
 */
export interface SharedCheckoutDirtyTracker {
  step(input: {
    /** This cycle's plain-dirty shared checkouts: `repoDir` → the recover-dirty reason. */
    dirty: ReadonlyMap<string, string>;
    /** `repoDir`s that currently have an OPEN dirt distress row (from the projection). */
    openDistressDirs: ReadonlySet<string>;
    nowSec: number;
  }): SharedWedgeDistressDecision;
}

/**
 * Build a {@link SharedCheckoutDirtyTracker}. `graceSec` is injectable for the
 * cadence test. A near-verbatim sibling of {@link createSharedCheckoutWedgeTracker}
 * keyed on {@link sharedDirtyDistressId} + the dirt reason, so the mid-merge path
 * stays byte-untouched and the two distress surfaces never share a row.
 */
export const SHARED_CHECKOUT_WRITER_GRACE_SEC = SHARED_CHECKOUT_DIRTY_GRACE_SEC;

export interface SharedCheckoutWriter {
  job_id: string;
  state: string;
  pid: number | null;
  start_time: string | null;
  updated_at: number;
}

export type WriterIdentityLiveness = "dead" | "live" | "inconclusive";

export interface DeadWriterCheckoutRow {
  id: string;
  dir: string;
}

export type DeadWriterCheckoutSweepOutcome =
  | { id: string; dir: string; kind: "cleaned"; snapshotDir: string }
  | { id: string; dir: string; kind: "refused"; detail: string }
  | { id: string; dir: string; kind: "failed"; detail: string };

export interface DeadWriterCheckoutSweepDeps {
  rows: readonly DeadWriterCheckoutRow[];
  nowSec: () => number;
  graceSec?: number;
  selectWriters: (
    dir: string,
  ) =>
    | readonly SharedCheckoutWriter[]
    | Promise<readonly SharedCheckoutWriter[]>;
  identityLiveness: (
    writer: SharedCheckoutWriter,
  ) => WriterIdentityLiveness | Promise<WriterIdentityLiveness>;
  probeMergeHead: (
    dir: string,
  ) =>
    | "absent"
    | "present"
    | "inconclusive"
    | Promise<"absent" | "present" | "inconclusive">;
  backupThenClean: (
    dir: string,
  ) => Promise<
    | { kind: "cleaned"; snapshotDir: string }
    | { kind: "backup-failed" | "clean-failed"; detail: string }
  >;
  noteLine?: (line: string) => void;
}

export async function runDeadWriterCheckoutSweep(
  deps: DeadWriterCheckoutSweepDeps,
): Promise<DeadWriterCheckoutSweepOutcome[]> {
  const outcomes: DeadWriterCheckoutSweepOutcome[] = [];
  const graceSec = deps.graceSec ?? SHARED_CHECKOUT_WRITER_GRACE_SEC;
  const nowSec = deps.nowSec();
  const note = deps.noteLine ?? (() => {});
  const refuse = (row: DeadWriterCheckoutRow, detail: string): void => {
    outcomes.push({ ...row, kind: "refused", detail });
    note(`# shared-checkout clean refused for ${row.dir}: ${detail}`);
  };

  for (const row of deps.rows) {
    if (row.dir === "") {
      refuse(row, "checkout dir is missing");
      continue;
    }
    let writers: readonly SharedCheckoutWriter[];
    try {
      writers = await deps.selectWriters(row.dir);
    } catch (err) {
      refuse(
        row,
        `writer enumeration was inconclusive: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (writers.length === 0) {
      refuse(row, "no cwd-matched writer identity exists");
      continue;
    }
    if (writers.some((writer) => writer.state === "working")) {
      refuse(row, "a cwd-matched writer is working");
      continue;
    }
    if (
      writers.some(
        (writer) =>
          !Number.isFinite(writer.updated_at) ||
          nowSec - writer.updated_at < graceSec,
      )
    ) {
      refuse(row, "a cwd-matched writer is not grace-stale");
      continue;
    }

    let writerRefusal: string | null = null;
    for (const writer of writers) {
      if (writer.pid == null || writer.start_time == null) {
        writerRefusal = `writer ${writer.job_id} has no provable process identity`;
        break;
      }
      let liveness: WriterIdentityLiveness;
      try {
        liveness = await deps.identityLiveness(writer);
      } catch {
        liveness = "inconclusive";
      }
      if (liveness !== "dead") {
        writerRefusal =
          liveness === "live"
            ? `writer ${writer.job_id} is live`
            : `writer ${writer.job_id} liveness is inconclusive`;
        break;
      }
    }
    if (writerRefusal !== null) {
      refuse(row, writerRefusal);
      continue;
    }

    let mergeHead: "absent" | "present" | "inconclusive";
    try {
      mergeHead = await deps.probeMergeHead(row.dir);
    } catch {
      mergeHead = "inconclusive";
    }
    if (mergeHead !== "absent") {
      refuse(
        row,
        mergeHead === "present"
          ? "MERGE_HEAD is present"
          : "MERGE_HEAD probe was inconclusive",
      );
      continue;
    }

    try {
      const cleaned = await deps.backupThenClean(row.dir);
      if (cleaned.kind === "cleaned") {
        outcomes.push({
          ...row,
          kind: "cleaned",
          snapshotDir: cleaned.snapshotDir,
        });
      } else {
        outcomes.push({ ...row, kind: "failed", detail: cleaned.detail });
        note(
          `# shared-checkout clean failed for ${row.dir}: ${cleaned.detail}`,
        );
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      outcomes.push({ ...row, kind: "failed", detail });
      note(`# shared-checkout clean failed for ${row.dir}: ${detail}`);
    }
  }
  return outcomes;
}

export function createSharedCheckoutDirtyTracker(
  graceSec: number = SHARED_CHECKOUT_DIRTY_GRACE_SEC,
): SharedCheckoutDirtyTracker {
  // repoDir → the first cycle-ts it was seen dirty + whether we have minted the
  // distress for THIS continuous dirt episode. In-worker memory only.
  const firstDirty = new Map<string, { sinceSec: number; minted: boolean }>();
  const graceMin = Math.round(graceSec / 60);
  return {
    step({ dirty, openDistressDirs, nowSec }) {
      const decision: SharedWedgeDistressDecision = { mint: [], clear: [] };
      // MINT layer: track each dirty repo's grace clock; cross the watermark once.
      for (const [dir, reason] of dirty) {
        let entry = firstDirty.get(dir);
        if (entry === undefined) {
          entry = { sinceSec: nowSec, minted: false };
          firstDirty.set(dir, entry);
        }
        if (!entry.minted && nowSec - entry.sinceSec >= graceSec) {
          entry.minted = true;
          decision.mint.push({
            id: sharedDirtyDistressId(dir),
            dir,
            reason:
              `${SHARED_DIRTY_DISTRESS_REASON}: ${dir} has stayed dirty past ` +
              `the ${graceMin}min recovery grace — the shared checkout's working ` +
              `tree is not clean (no merge in flight) and every epic finalize ` +
              `there skip-retries invisibly until it is hand-cleaned (commit, ` +
              `stash, or discard the changes). Last recover verdict: ${reason}`,
          });
        }
      }
      // Re-arm any repo no longer dirty this cycle so a future re-dirty waits the
      // full grace again (the in-memory episode is closed).
      for (const dir of firstDirty.keys()) {
        if (!dirty.has(dir)) {
          firstDirty.delete(dir);
        }
      }
      // CLEAR layer: level-trigger off the durable open-distress set — any open row
      // whose checkout is clean this cycle clears (robust across a restart).
      for (const dir of openDistressDirs) {
        if (!dirty.has(dir)) {
          decision.clear.push({ id: sharedDirtyDistressId(dir), dir });
        }
      }
      return decision;
    },
  };
}

/**
 * The shared-checkout mid-merge / plain-dirty distress observations the recover cycle
 * feeds its {@link SharedCheckoutWedgeTracker} / {@link SharedCheckoutDirtyTracker} —
 * the SINGLE documented neuter point post base-merge decouple.
 *
 * A dirty or mid-merge SHARED checkout no longer blocks the working-tree-free base
 * merge (it lands via the plumbing merge-tree/commit-tree/update-ref-CAS/push pipeline
 * regardless), so a `worktree-recover-mid-merge` / `worktree-recover-dirty-checkout`
 * observation is a FALSE POSITIVE for a block that no longer exists. Yields EMPTY maps
 * by construction: the trackers can only DRAIN (their level-clear off the OPEN distress
 * set releases any row already open), never mint. Pure; NEVER throws. (The trackers +
 * this seam are torn down in the sequenced follow-up; kept now so the neuter lives in
 * exactly one place rather than scattered across the recover loop.)
 */
export function sharedCheckoutDistressObservations(): {
  wedged: Map<string, string>;
  dirty: Map<string, string>;
} {
  return { wedged: new Map(), dirty: new Map() };
}

/** Recover-pass grace for an un-tearable closed/tombstoned lane. */
export const LANE_TEARDOWN_GRACE_SEC = 30 * 60;

export interface LaneTeardownGraceTracker {
  consider(input: {
    path: string;
    state: "destroyable" | "blocked";
    detail: string;
    nowSec: number;
  }): { destroy: boolean; mint?: SharedWedgeDistressAction };
  noteBackupFailure(input: {
    path: string;
    detail: string;
    nowSec: number;
  }): SharedWedgeDistressAction | null;
  finishCycle(input: {
    presentPaths: ReadonlySet<string>;
    candidatePaths: ReadonlySet<string>;
    backupFailedPaths: ReadonlySet<string>;
    openTeardownPaths: ReadonlySet<string>;
    openBackupPaths: ReadonlySet<string>;
    laneEnumerationComplete?: boolean;
  }): SharedWedgeDistressAction[];
}

function laneTeardownDistressIdForKey(path: string): string {
  return `${LANE_TEARDOWN_DISTRESS_ID_PREFIX}${repoDirHash(path)}`;
}

function laneBackupDistressIdForKey(path: string): string {
  return `${LANE_BACKUP_DISTRESS_ID_PREFIX}${repoDirHash(path)}`;
}

export function laneTeardownDistressId(path: string): string {
  return laneTeardownDistressIdForKey(normalizeLanePath(path));
}

export function laneBackupDistressId(path: string): string {
  return laneBackupDistressIdForKey(normalizeLanePath(path));
}

/** Pure in-memory grace/page-once tracker; the producer supplies the only clock. */
export function createLaneTeardownGraceTracker(
  graceSec: number = LANE_TEARDOWN_GRACE_SEC,
  normalizePath: LanePathNormalizer = normalizeLanePathState,
): LaneTeardownGraceTracker {
  const firstSeen = new Map<string, { sinceSec: number; minted: boolean }>();
  const firstBackupFailure = new Map<
    string,
    { sinceSec: number; minted: boolean }
  >();
  const graceMin = Math.round(graceSec / 60);
  return {
    consider({ path, state, detail, nowSec }) {
      const key = normalizePath(path).path;
      let episode = firstSeen.get(key);
      if (episode === undefined) {
        episode = { sinceSec: nowSec, minted: false };
        firstSeen.set(key, episode);
      }
      if (nowSec - episode.sinceSec < graceSec) return { destroy: false };
      if (state === "destroyable") return { destroy: true };
      if (episode.minted) return { destroy: false };
      episode.minted = true;
      return {
        destroy: false,
        mint: {
          id: laneTeardownDistressIdForKey(key),
          dir: key,
          reason:
            `${LANE_TEARDOWN_DISTRESS_REASON}: ${key} stayed un-tearable past ` +
            `the ${graceMin}min recover-pass grace and will never be destroyed ` +
            `automatically (${detail})`,
        },
      };
    },
    noteBackupFailure({ path, detail, nowSec }) {
      const key = normalizePath(path).path;
      let episode = firstBackupFailure.get(key);
      if (episode === undefined) {
        episode = { sinceSec: nowSec, minted: false };
        firstBackupFailure.set(key, episode);
      }
      if (episode.minted || nowSec - episode.sinceSec < graceSec) return null;
      episode.minted = true;
      return {
        id: laneBackupDistressIdForKey(key),
        dir: key,
        reason:
          `${LANE_BACKUP_DISTRESS_REASON}: the lane dirt spool snapshot for ${key} ` +
          `has failed throughout the ${graceMin}min recover-pass grace; the lane ` +
          `was not destroyed (${detail})`,
      };
    },
    finishCycle({
      presentPaths,
      candidatePaths,
      backupFailedPaths,
      openTeardownPaths,
      openBackupPaths,
      laneEnumerationComplete = true,
    }) {
      for (const path of firstSeen.keys()) {
        if (!candidatePaths.has(path)) firstSeen.delete(path);
      }
      for (const path of firstBackupFailure.keys()) {
        if (!backupFailedPaths.has(path)) firstBackupFailure.delete(path);
      }
      const clear: SharedWedgeDistressAction[] = [];
      const confirmedAbsent = ({ path, presence }: NormalizedLanePath) =>
        !presentPaths.has(path) &&
        (laneEnumerationComplete || presence === "absent");
      for (const path of openTeardownPaths) {
        const normalized = normalizePath(path);
        if (confirmedAbsent(normalized)) {
          clear.push({
            id: laneTeardownDistressIdForKey(normalized.path),
            dir: normalized.path,
          });
        }
      }
      for (const path of openBackupPaths) {
        const normalized = normalizePath(path);
        if (confirmedAbsent(normalized)) {
          clear.push({
            id: laneBackupDistressIdForKey(normalized.path),
            dir: normalized.path,
          });
        }
      }
      return clear;
    },
  };
}

export interface LaneTeardownRecoveryOptions {
  tracker: LaneTeardownGraceTracker;
  nowSec: number;
  spoolDir?: string;
  openTeardownPaths?: ReadonlySet<string>;
  openBackupPaths?: ReadonlySet<string>;
}

/**
 * Grace window (producer-`ts` seconds) a fan-in base LANE worktree may stay
 * not-losslessly-mergeable (a persistent divergent-dirty / off-branch / would-clobber
 * base) before the recover pass escalates the wedge into a visible per-lane distress
 * row. The per-cycle self-clearing `work::<taskId>` row fires the FIRST dispatch
 * attempt regardless; the distress is the sustained-wedge layer ON TOP. ~5min — long
 * enough that a transient not-ready base settles inside the window, short enough that
 * a genuine wedge (a base a human must hand-resolve) surfaces fast. Injectable so the
 * fast tier drives the grace-crossing without a real clock. Kept a DISTINCT const
 * from the shared-checkout grace so the two can diverge.
 */
export const LANE_WEDGE_GRACE_SEC = 5 * 60;

/**
 * The `dispatch_failures` id a per-lane wedge distress row keys on —
 * `worktree-lane-wedge:<repoDirHash(lanePath)>`. Reuses the base36 {@link
 * repoDirHash} of the LANE worktree path so the mint and the level-clear target the
 * SAME row across cycles, and two wedged lanes get DISTINCT rows. The composite
 * `daemon::worktree-lane-wedge:<hash>` deliberately fails the `retry_dispatch` wire
 * validator (the synthetic `daemon` verb), so only the recover-pass level-trigger
 * clears it. Keyed on the lane path — a DISTINCT surface from {@link
 * sharedWedgeDistressId} (which hashes a default-branch checkout dir).
 */
export function laneWedgeDistressId(lanePath: string): string {
  return `${LANE_WEDGE_DISTRESS_ID_PREFIX}${repoDirHash(
    normalizeLanePath(lanePath),
  )}`;
}

/** One wedged base LANE observation the recover pass hands the tracker. */
export interface LaneWedgeObservation {
  /** The lane worktree path — the per-lane distress surface key. */
  path: string;
  /** The recover-pass reason (mint attribution). */
  reason: string;
  /** `true` for a hard `abort-failed` mid-merge lane → mint distress IMMEDIATELY
   *  (not graced), matching `finalizeEpic`'s precedent; `false` → graced. */
  immediate: boolean;
}

/**
 * Per-LANE grace tracker for the fan-in base-lane wedge distress — the SIBLING of
 * {@link createSharedCheckoutWedgeTracker} on its own id/reason/surface (keyed by
 * lane worktree PATH, never a default-branch checkout dir), so the shared-checkout
 * escalation stays byte-untouched and the two distress surfaces never share a row.
 * Identical contract: pure of keeper.db / IO / the wall clock (the producer `ts` is
 * the only clock); in-memory grace + per-path minted-latch for an exactly-once mint
 * per wedge episode; projection-driven level-clear robust across a restart. A lane
 * marked `immediate` (a hard `abort-failed`) skips the grace and mints AT ONCE.
 * Reuses the verb-neutral {@link SharedWedgeDistressAction} / {@link
 * SharedWedgeDistressDecision} shapes.
 */
export interface LaneWedgeTracker {
  step(input: {
    /** This cycle's wedged base lanes, keyed by normalized lane PATH. */
    wedged: ReadonlyMap<string, LaneWedgeObservation>;
    /** Lane PATHS with an OPEN distress row (from the projection). */
    openDistressDirs: ReadonlySet<string>;
    nowSec: number;
  }): SharedWedgeDistressDecision;
}

/**
 * Build a {@link LaneWedgeTracker}. `graceSec` is injectable for the cadence test. A
 * near-verbatim sibling of {@link createSharedCheckoutWedgeTracker} keyed on {@link
 * laneWedgeDistressId} + the lane path, with the extra `immediate` short-circuit for
 * an `abort-failed` hard wedge.
 */
export function createLaneWedgeTracker(
  graceSec: number = LANE_WEDGE_GRACE_SEC,
): LaneWedgeTracker {
  // lanePath → the first cycle-ts it was seen wedged + whether we have minted the
  // distress for THIS continuous wedge episode. In-worker memory only.
  const firstWedged = new Map<string, { sinceSec: number; minted: boolean }>();
  const graceMin = Math.round(graceSec / 60);
  return {
    step({ wedged, openDistressDirs, nowSec }) {
      const decision: SharedWedgeDistressDecision = { mint: [], clear: [] };
      // MINT layer: track each wedged lane's grace clock; cross the watermark once.
      // An `immediate` (abort-failed) lane mints at once, regardless of grace.
      for (const [path, obs] of wedged) {
        let entry = firstWedged.get(path);
        if (entry === undefined) {
          entry = { sinceSec: nowSec, minted: false };
          firstWedged.set(path, entry);
        }
        const graced = nowSec - entry.sinceSec >= graceSec;
        if (!entry.minted && (obs.immediate || graced)) {
          entry.minted = true;
          decision.mint.push({
            id: laneWedgeDistressId(path),
            dir: path,
            reason: obs.immediate
              ? `${LANE_WEDGE_DISTRESS_REASON}: the fan-in base lane ${path} is ` +
                `hard-wedged — git could not clear it and the dependent task cannot ` +
                `merge until it is hand-resolved (git merge --abort or resolve + ` +
                `commit in that worktree). Last recover verdict: ${obs.reason}`
              : `${LANE_WEDGE_DISTRESS_REASON}: the fan-in base lane ${path} has ` +
                `stayed not-losslessly-cleanable past the ${graceMin}min recovery ` +
                `grace — the dependent task's fan-in keeps deferring and will not ` +
                `self-heal until the base is hand-cleaned (commit, discard, or ` +
                `switch it back to its lane branch). Last recover verdict: ${obs.reason}`,
          });
        }
      }
      // Re-arm any lane no longer wedged this cycle so a future re-wedge waits the
      // full grace again (the in-memory episode is closed).
      for (const path of firstWedged.keys()) {
        if (!wedged.has(path)) {
          firstWedged.delete(path);
        }
      }
      // CLEAR layer: level-trigger off the durable open-distress set — any open row
      // whose lane is ready/gone this cycle clears (robust across a restart).
      for (const dir of openDistressDirs) {
        if (!wedged.has(dir)) {
          decision.clear.push({ id: laneWedgeDistressId(dir), dir });
        }
      }
      return decision;
    },
  };
}

/**
 * Grace (producer-`ts` seconds) a LIVE lane owner may go without folding a fresh event
 * before the lane-wedge liveness gate treats it as STALLED. A worker actively running
 * its task folds events continuously, so its `updated_at` (the reducer's last-fold
 * instant) stays recent; a live pane whose fold has frozen past this window is stuck on
 * a human, not making the progress that would self-heal the dirty base. Mirrors the
 * slot-reclaim reaper's `now - updated_at >= grace` dead-vs-alive idiom
 * ({@link SLOT_RECLAIM_GRACE_SEC}). Kept a DISTINCT const from {@link
 * LANE_WEDGE_GRACE_SEC} so the wedge grace and the owner-stall grace can diverge.
 */
export const LANE_OWNER_STALL_GRACE_SEC = 5 * 60;

/**
 * Is the worker OWNING a wedged fan-in base lane (the session checked out in that lane
 * worktree) ALIVE and PROGRESSING — so the lane's dirtiness is transient uncommitted
 * WIP that self-heals the instant it commits, never a human-actionable wedge? The
 * producer-side liveness gate on the GRACED lane-wedge escalation (fn-1144): a healthy
 * running worker's base is naturally dirty, so escalating it pages the operator for a
 * false positive.
 *
 * The owning worker is joined by lane PATH — a `work` job whose `cwd` normalizes to the
 * lane worktree — the only lane→worker key available producer-side (the recover pass's
 * lane observations carry a path, not a branch, and the whole lane-wedge surface is
 * already keyed by lane path). Liveness reuses the reconciler's SHARED rule rather than
 * re-inventing it: `working`, or `stopped` with a live backend pane via
 * {@link isStoppedJobLive} (the exact stopped-arm {@link isOccupyingJob} uses), then
 * the STALL check layered on top — an occupying worker counts as progressing ONLY while
 * its last-fold `updated_at` is within `stallGraceSec`.
 *
 *  - `true`  → some owning `work` worker is occupying AND progressing → the caller
 *              WITHHOLDS the lane from the wedge tracker (it stays the quiet self-
 *              clearing premerge/recover note; no needs_human page).
 *  - `false` → every owning worker is DEAD (none occupying the lane) or STALLED
 *              (occupying but its fold froze past the grace) → escalate exactly as
 *              before the gate.
 *
 * DEGRADED probe (`livePaneIds === null`, tmux unavailable) → `false`: with no
 * trustworthy liveness picture the gate FALLS BACK to the pre-gate behavior (escalate
 * past grace), never SUPPRESSING a genuine distress signal on an unprobeable cycle —
 * strictly no regression, mirroring {@link computeSlotOccupancy}'s inert-when-degraded
 * conservatism. Pure + re-fold-safe: reads only the passed jobs + live-pane set +
 * `nowSec` (a producer read; never a fold).
 */
export function laneOwnerAliveAndProgressing(
  lanePath: string,
  jobs: Map<string, Job>,
  livePaneIds: ReadonlySet<string> | null,
  nowSec: number,
  stallGraceSec: number = LANE_OWNER_STALL_GRACE_SEC,
): boolean {
  if (livePaneIds === null) {
    return false;
  }
  const laneKey = normalizeLanePath(lanePath);
  for (const job of jobs.values()) {
    if (job.plan_verb !== "work" || job.cwd === null) {
      continue;
    }
    if (normalizeLanePath(job.cwd) !== laneKey) {
      continue;
    }
    const occupying =
      job.state === "working" ||
      (job.state === "stopped" && isStoppedJobLive(job, livePaneIds));
    if (occupying && nowSec - job.updated_at < stallGraceSec) {
      return true;
    }
  }
  return false;
}

/**
 * Assemble the lane-wedge tracker's `wedged` input from the recover pass's raw lane
 * observations, applying the fn-1144 liveness gate. A GRACED (`immediate:false`) lane
 * whose owning worker is alive AND progressing ({@link laneOwnerAliveAndProgressing})
 * is WITHHELD — omitted from the returned map so the tracker never mints a
 * needs_human page for transient WIP. A hard `immediate` (abort-failed) lane is NEVER
 * gated: an abort git could not clear is a real wedge even under a live worker, so it
 * escalates at once as before. Preserves the pre-gate dedup (first observation per lane
 * wins; an immediate beats a graced entry for the same lane). Producer-side, pure of
 * the wall clock (`nowSec` is the only clock) — never a fold.
 */
export function gateWedgedLanesByLiveness(
  laneWedged: readonly { path: string; reason: string; immediate: boolean }[],
  jobs: Map<string, Job>,
  livePaneIds: ReadonlySet<string> | null,
  nowSec: number,
  stallGraceSec: number = LANE_OWNER_STALL_GRACE_SEC,
): Map<string, LaneWedgeObservation> {
  const wedgedLanes = new Map<string, LaneWedgeObservation>();
  for (const w of laneWedged) {
    const key = normalizeLanePath(w.path);
    // A graced lane under a live+progressing owner is transient WIP that self-heals on
    // commit — withhold it (the quiet self-clearing note). An `immediate` lane bypasses
    // the gate and always escalates.
    if (
      !w.immediate &&
      laneOwnerAliveAndProgressing(
        key,
        jobs,
        livePaneIds,
        nowSec,
        stallGraceSec,
      )
    ) {
      continue;
    }
    // First observation per lane wins (an immediate abort-failed beats a later graced
    // entry for the same lane).
    const prev = wedgedLanes.get(key);
    if (prev === undefined || (w.immediate && !prev.immediate)) {
      wedgedLanes.set(key, {
        path: key,
        reason: w.reason,
        immediate: w.immediate,
      });
    }
  }
  return wedgedLanes;
}

/**
 * Grace window (producer-`ts` seconds) an already-cut lane may read STALE-BASE before
 * the probe escalates it into a visible per-(epic,repo) distress row. ~5min — long
 * enough that a transient mid-finalize window (an upstream landing while its lane is
 * briefly not-yet-ancestor) settles, short enough that a genuine stale fork surfaces
 * fast. Injectable so the fast tier drives the grace-crossing without a real clock.
 * Kept a DISTINCT const from the shared-checkout / lane grace so the two can diverge.
 */
export const STALE_BASE_LANE_GRACE_SEC = 5 * 60;

/** One flagged stale-base lane the probe hands the tracker (its `id` context). */
export interface StaleBaseLaneObservation {
  /** The epic whose lane is stale — mint attribution. */
  epicId: string;
  /** The RESOLVED lane repo — the row's `dir` column + mint attribution. */
  repoDir: string;
}

/**
 * Per-(epic,repo) grace tracker for the stale-base lane distress — a CLONE of {@link
 * createSharedCheckoutWedgeTracker} on its own id/reason/surface, so the shared-
 * checkout and lane escalations stay byte-untouched and the surfaces never share a
 * row. Identical contract: pure of keeper.db / IO / the wall clock (the producer `ts`
 * is the only clock); in-memory grace + per-key minted-latch for an exactly-once mint
 * per continuous stale episode; projection-driven level-clear robust across a restart.
 * KEYED ON THE DISTRESS ID directly (`stale-base-lane:<epicId>-<repoHash>`), unlike the
 * shared-checkout tracker's dir key: the per-(epic,repo) hash is one-way, so the OPEN
 * set carries the ids, and the level-clear compares ids without recomputing a hash.
 */
export interface StaleBaseLaneTracker {
  step(input: {
    /** This cycle's stale lanes, keyed by distress id → its (epic, repo) context. */
    stale: ReadonlyMap<string, StaleBaseLaneObservation>;
    /** The distress IDS with an OPEN row (from the projection). */
    openDistressIds: ReadonlySet<string>;
    nowSec: number;
  }): SharedWedgeDistressDecision;
}

/**
 * Build a {@link StaleBaseLaneTracker}. `graceSec` is injectable for the cadence test.
 * A near-verbatim sibling of {@link createSharedCheckoutWedgeTracker} keyed on the
 * per-(epic,repo) distress id (never a dir), so the mid-merge path stays byte-untouched
 * and the two distress surfaces never share a row.
 */
export function createStaleBaseLaneTracker(
  graceSec: number = STALE_BASE_LANE_GRACE_SEC,
): StaleBaseLaneTracker {
  // distress id → the first cycle-ts it was seen stale + whether we have minted the
  // distress for THIS continuous stale episode. In-worker memory only.
  const firstStale = new Map<string, { sinceSec: number; minted: boolean }>();
  const graceMin = Math.round(graceSec / 60);
  return {
    step({ stale, openDistressIds, nowSec }) {
      const decision: SharedWedgeDistressDecision = { mint: [], clear: [] };
      // MINT layer: track each stale lane's grace clock; cross the watermark once.
      for (const [id, obs] of stale) {
        let entry = firstStale.get(id);
        if (entry === undefined) {
          entry = { sinceSec: nowSec, minted: false };
          firstStale.set(id, entry);
        }
        if (!entry.minted && nowSec - entry.sinceSec >= graceSec) {
          entry.minted = true;
          decision.mint.push({
            id,
            dir: obs.repoDir,
            reason:
              `${STALE_BASE_DISTRESS_REASON}: epic ${obs.epicId}'s worktree lane in ` +
              `${obs.repoDir} has stayed forked off a STALE base past the ${graceMin}min ` +
              `grace — the lane was cut before a landed same-repo upstream merged, so its ` +
              `base is missing that upstream's work and its workers hit DEPENDENCY_BLOCKED ` +
              `with nothing naming the cause. The autopilot will NOT auto-rebase it: tear ` +
              `the stale lane down (keeper autopilot retry / force-close the epic) so it ` +
              `re-provisions off fresh default, or hand-rebase the base.`,
          });
        }
      }
      // Re-arm any lane no longer stale this cycle so a future re-stale waits the full
      // grace again (the in-memory episode is closed).
      for (const id of firstStale.keys()) {
        if (!stale.has(id)) {
          firstStale.delete(id);
        }
      }
      // CLEAR layer: level-trigger off the durable open-distress set — any open row no
      // longer reported stale this cycle (re-based past the upstream or torn down)
      // clears (robust across a restart).
      for (const id of openDistressIds) {
        if (!stale.has(id)) {
          decision.clear.push({ id, dir: "" });
        }
      }
      return decision;
    },
  };
}

/**
 * One flagged duplicate-epic-number group — two-or-more NON-DONE epics in the SAME project
 * sharing one `epic_number`. The producer probe emits one per (project, number) collision;
 * the tracker keys its distress row on {@link dupEpicNumberDistressId}.
 */
export interface DuplicateEpicNumberGroup {
  /** The colliding `epic_number`. */
  epicNumber: number;
  /** The shared project dir (the distress row's `dir` + locator). */
  projectDir: string;
  /** Every colliding epic's full id, SORTED for a stable reason string / re-fold. */
  epicIds: string[];
}

/**
 * Detect landed duplicate plan numbers: two-or-more NON-DONE epics in the SAME project
 * sharing one `epic_number`. A PURE O(open epics) read over the live `epics` projection —
 * NEVER a fold, NEVER per-event, NEVER a DB scan (the reconciler already holds the epics
 * snapshot). Scoped to non-done pairs because a duplicate involving a DONE epic is history,
 * not a jam — closed history must never mint eternal distress. An epic with a null
 * `epic_number` or a null/empty `project_dir` is un-keyable and skipped (it cannot collide
 * on a (project, number) pair). Groups are returned SORTED by (projectDir, epicNumber) and
 * each group's `epicIds` SORTED, so the probe → tracker handoff is deterministic. Pure;
 * NEVER throws.
 */
export function computeDuplicateEpicNumberGroups(
  epics: readonly Epic[],
): DuplicateEpicNumberGroup[] {
  // (projectDir \0 number) → the colliding epic ids. The NUL joiner never appears in a
  // path or a number, so the composite key is unambiguous.
  const byKey = new Map<
    string,
    { projectDir: string; epicNumber: number; epicIds: string[] }
  >();
  for (const e of epics) {
    if (e.epic_number === null || e.status === "done") {
      continue;
    }
    const projectDir = e.project_dir ?? "";
    if (projectDir === "") {
      continue;
    }
    const key = `${projectDir}\0${e.epic_number}`;
    let group = byKey.get(key);
    if (group === undefined) {
      group = { projectDir, epicNumber: e.epic_number, epicIds: [] };
      byKey.set(key, group);
    }
    group.epicIds.push(e.epic_id);
  }
  const out: DuplicateEpicNumberGroup[] = [];
  for (const group of byKey.values()) {
    if (group.epicIds.length < 2) {
      continue;
    }
    out.push({
      epicNumber: group.epicNumber,
      projectDir: group.projectDir,
      epicIds: [...group.epicIds].sort(),
    });
  }
  out.sort(
    (a, b) =>
      a.projectDir.localeCompare(b.projectDir) || a.epicNumber - b.epicNumber,
  );
  return out;
}

/** One flagged duplicate-epic-number group the probe hands the tracker (its `id` context). */
export interface DupEpicNumberObservation {
  /** The shared project dir — the row's `dir` column + mint attribution. */
  projectDir: string;
  /** The colliding `epic_number`. */
  epicNumber: number;
  /** Every colliding epic's full id (SORTED) — mint attribution. */
  epicIds: string[];
}

/**
 * Per-(project,number) grace tracker for the duplicate-epic-number distress — a CLONE of
 * {@link createStaleBaseLaneTracker} on its own id/reason/surface, so the surfaces never
 * share a row. Identical contract: pure of keeper.db / IO / the wall clock (the producer
 * `ts` is the only clock); in-memory grace + per-key minted-latch for an exactly-once mint
 * per continuous duplicate episode; projection-driven level-clear robust across a restart.
 * KEYED ON THE DISTRESS ID directly (`dup-epic-number:<projectHash>-<number>`): the
 * per-(project,number) hash is one-way, so the OPEN set carries the ids and the level-clear
 * compares ids without recomputing a hash.
 */
export interface DupEpicNumberTracker {
  step(input: {
    /** This cycle's duplicate groups, keyed by distress id → its (project, number) context. */
    duplicates: ReadonlyMap<string, DupEpicNumberObservation>;
    /** The distress IDS with an OPEN row (from the projection). */
    openDistressIds: ReadonlySet<string>;
    nowSec: number;
  }): SharedWedgeDistressDecision;
}

/**
 * Build a {@link DupEpicNumberTracker}. `graceSec` DEFAULTS to 0 — a duplicate plan number
 * is a hard data-integrity violation that will not self-resolve transiently, so it mints on
 * the FIRST observation (the minted-latch still guarantees exactly-once per episode; the
 * projection-driven clear still fires the cycle the duplicate resolves). Injectable so a
 * cadence test may drive a non-zero grace. A near-verbatim sibling of {@link
 * createStaleBaseLaneTracker} keyed on the per-(project,number) distress id.
 */
export function createDupEpicNumberTracker(graceSec = 0): DupEpicNumberTracker {
  // distress id → the first cycle-ts it was seen duplicated + whether we have minted the
  // distress for THIS continuous duplicate episode. In-worker memory only.
  const firstSeen = new Map<string, { sinceSec: number; minted: boolean }>();
  return {
    step({ duplicates, openDistressIds, nowSec }) {
      const decision: SharedWedgeDistressDecision = { mint: [], clear: [] };
      // MINT layer: track each duplicate's grace clock; cross the watermark once.
      for (const [id, obs] of duplicates) {
        let entry = firstSeen.get(id);
        if (entry === undefined) {
          entry = { sinceSec: nowSec, minted: false };
          firstSeen.set(id, entry);
        }
        if (!entry.minted && nowSec - entry.sinceSec >= graceSec) {
          entry.minted = true;
          decision.mint.push({
            id,
            dir: obs.projectDir,
            reason:
              `${DUP_EPIC_NUMBER_DISTRESS_REASON}: plan number ${obs.epicNumber} in ` +
              `${obs.projectDir} is held by ${obs.epicIds.length} live epics ` +
              `(${obs.epicIds.join(", ")}) — a bare fn-${obs.epicNumber} reference now ` +
              `resolves ambiguously. Renumber or remove all but one (keeper plan renumber) ` +
              `so the number is unique again.`,
          });
        }
      }
      // Re-arm any group no longer duplicated this cycle so a future re-duplication waits
      // the full grace again (the in-memory episode is closed).
      for (const id of firstSeen.keys()) {
        if (!duplicates.has(id)) {
          firstSeen.delete(id);
        }
      }
      // CLEAR layer: level-trigger off the durable open-distress set — any open row no
      // longer reported duplicated this cycle (renumbered, removed, or gone done) clears
      // (robust across a restart).
      for (const id of openDistressIds) {
        if (!duplicates.has(id)) {
          decision.clear.push({ id, dir: "" });
        }
      }
      return decision;
    },
  };
}

/**
 * Grace window (producer-`ts` seconds) a shared MAIN checkout may stay DESYNCED — its
 * ref advanced past a base→default merge whose resync was skipped/aborted, so the working
 * tree trails the default tip — before the per-cycle probe escalates it into a visible
 * per-repo distress row. TUNED SMALL (~5min, minutes not tens): long enough that a
 * transient in-flight `commit-work` (which re-syncs the tree the next cycle) or an
 * `index.lock` blip settles inside the window, short enough that a genuine stuck desync
 * surfaces fast. Injectable so the fast tier drives the grace-crossing without a real
 * clock. Kept a DISTINCT const from the wedge/dirty/lane/stale grace so the two can
 * diverge.
 */
export const SHARED_CHECKOUT_DESYNC_GRACE_SEC = 5 * 60;

/**
 * The per-cycle content-level verdict for a watched shared-checkout dir — the SOLE clear
 * evidence for the desync distress. `desynced:false` iff the checkout is ON the default
 * branch, has NO merge in flight, and its index AND worktree both match HEAD (tracked
 * content carries the default tip); otherwise `desynced:true` with a short `blocker`
 * naming why (off-default / mid-merge / content-trailing / an inconclusive git probe).
 * NEVER a single index-vs-HEAD orientation: both a fresh desync (index behind HEAD) and
 * the steady state (index==HEAD, worktree stale) read as `desynced:true`.
 */
export type CheckoutDesyncProbe =
  | { desynced: false }
  | { desynced: true; blocker: string };

/**
 * Probe whether a shared MAIN checkout content-carries its default tip (the desync clear
 * evidence). Pure of keeper.db / the wall clock — reads ONLY live git through the injected
 * runner, so the fast tier scripts every decision. POSITIVE-EVIDENCE ONLY: any
 * inconclusive git result (an unresolved branch, a failed status) is reported
 * `desynced:true` so a probe blip RETAINS an open row rather than false-clearing a real
 * signal. NEVER throws (a thrown runner degrades to `desynced:true`).
 *
 * A checkout is SYNCED iff, in order: it is on the default branch, has no `MERGE_HEAD`,
 * and `git status --porcelain -uno` is empty — the exact "index AND worktree both match
 * HEAD" contract (empty porcelain ⟺ no staged AND no unstaged tracked delta ⟺
 * index==worktree==HEAD). Untracked scratch files are IGNORED (`-uno`): they never mean
 * the tracked default tip is missing.
 */
export async function probeSharedCheckoutDesync(
  repoDir: string,
  run: WorktreeGitRunner,
): Promise<CheckoutDesyncProbe> {
  try {
    const defaultBranch = await gitResolveDefaultBranch(repoDir, run);
    const branch = await gitCurrentBranch(repoDir, run);
    if (branch.length === 0) {
      return {
        desynced: true,
        blocker: "branch-unresolved (detached or git error)",
      };
    }
    if (branch !== defaultBranch) {
      return {
        desynced: true,
        blocker: `off-default (on ${branch}, expected ${defaultBranch})`,
      };
    }
    const mergeHead = await run(
      ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
      {
        cwd: repoDir,
        timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      },
    );
    if (mergeHead.code === 0) {
      return { desynced: true, blocker: "mid-merge (MERGE_HEAD present)" };
    }
    const status = await run(
      ["status", "--porcelain", "--untracked-files=no"],
      { cwd: repoDir, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
    );
    if (status.code !== 0) {
      return { desynced: true, blocker: "status-probe-failed" };
    }
    if (status.stdout.trim().length === 0) {
      return { desynced: false };
    }
    return {
      desynced: true,
      blocker: "content-trailing (index/worktree differ from the default tip)",
    };
  } catch {
    return { desynced: true, blocker: "probe-threw" };
  }
}

/**
 * Per-repo grace tracker for the shared-checkout DESYNC distress — a CLONE of {@link
 * createSharedCheckoutWedgeTracker} on its OWN id/reason/surface, so the wedge/dirty/lane
 * escalations stay byte-untouched and the surfaces never share a row. Identical contract:
 * pure of keeper.db / IO / the wall clock (the producer `ts` is the only clock); in-memory
 * grace + per-repo minted-latch for an exactly-once mint per continuous desync episode;
 * projection-driven level-clear robust across a restart. Keyed on the checkout DIR (like
 * the wedge tracker), computing {@link sharedDesyncDistressId} internally. The `desynced`
 * map's value is the probe blocker detail (mint attribution).
 *
 * The one architectural divergence from the wedge tracker: the `desynced` map is NOT
 * re-derived from a recover observation each cycle — it is the per-cycle {@link
 * probeSharedCheckoutDesync} verdict over the WATCHED dirs (the event-seeded latch UNION
 * the open-row set), so a fresh desync mints and a caught-up checkout clears purely off
 * content evidence.
 */
export interface SharedCheckoutDesyncTracker {
  step(input: {
    /** This cycle's still-desynced shared checkouts: `repoDir` → the probe blocker. */
    desynced: ReadonlyMap<string, string>;
    /** `repoDir`s that currently have an OPEN desync distress row (from the projection). */
    openDistressDirs: ReadonlySet<string>;
    nowSec: number;
  }): SharedWedgeDistressDecision;
}

/**
 * Build a {@link SharedCheckoutDesyncTracker}. `graceSec` is injectable for the cadence
 * test. A near-verbatim sibling of {@link createSharedCheckoutWedgeTracker} keyed on
 * {@link sharedDesyncDistressId} + the desync reason, so the wedge/dirty paths stay
 * byte-untouched and the distress surfaces never share a row.
 */
export function createSharedCheckoutDesyncTracker(
  graceSec: number = SHARED_CHECKOUT_DESYNC_GRACE_SEC,
): SharedCheckoutDesyncTracker {
  // repoDir → the first cycle-ts it was seen desynced + whether we have minted the
  // distress for THIS continuous desync episode. In-worker memory only.
  const firstDesynced = new Map<
    string,
    { sinceSec: number; minted: boolean }
  >();
  const graceMin = Math.round(graceSec / 60);
  return {
    step({ desynced, openDistressDirs, nowSec }) {
      const decision: SharedWedgeDistressDecision = { mint: [], clear: [] };
      // MINT layer: track each desynced repo's grace clock; cross the watermark once.
      for (const [dir, blocker] of desynced) {
        let entry = firstDesynced.get(dir);
        if (entry === undefined) {
          entry = { sinceSec: nowSec, minted: false };
          firstDesynced.set(dir, entry);
        }
        if (!entry.minted && nowSec - entry.sinceSec >= graceSec) {
          entry.minted = true;
          decision.mint.push({
            id: sharedDesyncDistressId(dir),
            dir,
            reason:
              `${SHARED_DESYNC_DISTRESS_REASON}: ${dir} has stayed DESYNCED past the ` +
              `${graceMin}min grace — a base→default merge advanced refs/heads onto the ` +
              `merged commit but the shared checkout's post-merge resync was skipped or ` +
              `aborted, so the working tree (and everything served off it — selector ` +
              `policy, skills, worker templates, daemon source at next boot) silently ` +
              `trails landed history. Return the checkout to the default branch and let ` +
              `it catch up (commit/stash any work first) so it carries the default tip. ` +
              `Blocker: ${blocker}`,
          });
        }
      }
      // Re-arm any repo no longer desynced this cycle so a future re-desync waits the
      // full grace again (the in-memory episode is closed).
      for (const dir of firstDesynced.keys()) {
        if (!desynced.has(dir)) {
          firstDesynced.delete(dir);
        }
      }
      // CLEAR layer: level-trigger off the durable open-distress set — any open row whose
      // checkout content-carries the default tip this cycle clears (robust across a
      // restart, since the open set re-seeds the probe's watched dirs).
      for (const dir of openDistressDirs) {
        if (!desynced.has(dir)) {
          decision.clear.push({ id: sharedDesyncDistressId(dir), dir });
        }
      }
      return decision;
    },
  };
}

/** Grace (producer-`ts` seconds) a repo may stay origin-containment-UNHEALTHY before the
 *  fallback pages. Bounded so a transient network stall / brief divergence resolves inside
 *  the window; sustained past it, origin is genuinely stuck falling behind and needs a human. */
export const ORIGIN_CONTAINMENT_STUCK_GRACE_SEC = 10 * 60;

/** Bounded re-probe cadence (producer-`ts` seconds) for a repo with a live episode or an OPEN
 *  origin-containment row: the coalesced waker arms this so a quiescent DB (no data_version
 *  edge) still re-probes to clear a landed row or confirm a persistent jam — never busier. */
export const ORIGIN_CONTAINMENT_RETRY_INTERVAL_SEC = 60;

/**
 * Grace tracker escalating a repo whose periodic origin-containment reconcile cannot make
 * origin reflect local default — a push that keeps timing out / failing while local leads
 * (the silent-lag jam), or a TRUE divergence keeper cannot reconcile (no fetch/rebase/force)
 * — past the grace into its OWN per-repo distress row. The fallback for the no-owner-left
 * case: with lanes gone and no finalize to re-trigger, this is the only surface that pages a
 * repo whose origin is silently frozen. A near-sibling of {@link
 * createSharedCheckoutDesyncTracker} on its OWN id/reason ({@link originContainmentDistressId}
 * + {@link ORIGIN_CONTAINMENT_DISTRESS_REASON}), never cross-clearing the shared-checkout or
 * finalize push-stuck rows. Pure of keeper.db / IO / the wall clock (the producer `ts` is the
 * only clock); in-memory grace + per-repo minted-latch; projection-driven clear robust across
 * a restart.
 *
 * ONE divergence from the desync tracker's clear: it clears ONLY on POSITIVE evidence
 * (`healthy` — pushed / already-contained / remote-ahead), NEVER on "not unhealthy" — an
 * INCONCLUSIVE (`deferred`) cycle must not reset the jam clock nor dismiss a live row.
 */
/** A {@link SharedWedgeDistressDecision} plus the earliest producer-`ts` second a FUTURE
 *  cycle would change containment state — the coalesced waker's arm target (`null` ⇒ nothing
 *  pending ⇒ disarm). It is the clock edge a quiescent, data_version-only DB otherwise misses. */
export type OriginContainmentDecision = SharedWedgeDistressDecision & {
  nextWakeAt: number | null;
};

export interface OriginContainmentStuckTracker {
  step(input: {
    /** This cycle's still-stuck repos: `repoDir` → the actionable reason (mint attribution). */
    unhealthy: ReadonlyMap<string, string>;
    /** This cycle's repos with POSITIVE containment evidence (pushed / already-contained /
     *  remote-ahead) — re-arms the grace latch and level-clears any open row. */
    healthy: ReadonlySet<string>;
    /** This cycle's repos observed NEUTRAL-and-retryable (a `deferred` inconclusive probe,
     *  NOT the owner-attempt guard). They start no episode and mint nothing, but they DO arm a
     *  bounded retry so a FIRST-cycle unknown on a quiescent DB still gets a clock edge to
     *  re-probe. Optional (absent ⇒ empty) for call-site back-compat. */
    neutralRetry?: ReadonlySet<string>;
    /** `repoDir`s that currently have an OPEN origin-containment distress row. */
    openDistressDirs: ReadonlySet<string>;
    nowSec: number;
  }): OriginContainmentDecision;
  /** Drop ALL in-memory episode accounting (the `firstStuck` latch). Called on a POSITIVE
   *  worktree-mode disable alongside the durable row clears, so a re-enable starts every repo
   *  on a FRESH full grace — never minting from stale disabled-time accounting, and never
   *  leaving a minted-then-cleared episode permanently latched. */
  reset(): void;
}

export function createOriginContainmentStuckTracker(
  graceSec: number = ORIGIN_CONTAINMENT_STUCK_GRACE_SEC,
  retryIntervalSec: number = ORIGIN_CONTAINMENT_RETRY_INTERVAL_SEC,
): OriginContainmentStuckTracker {
  // repoDir → the first cycle-ts it was seen stuck + whether we minted for THIS continuous
  // stuck episode. In-worker memory only; a restart re-seeds the clear off the open-row set.
  const firstStuck = new Map<string, { sinceSec: number; minted: boolean }>();
  return {
    reset() {
      firstStuck.clear();
    },
    step({ unhealthy, healthy, neutralRetry, openDistressDirs, nowSec }) {
      const decision: OriginContainmentDecision = {
        mint: [],
        clear: [],
        nextWakeAt: null,
      };
      // MINT layer: advance each stuck repo's grace clock; cross the watermark once.
      for (const [dir, reason] of unhealthy) {
        let entry = firstStuck.get(dir);
        if (entry === undefined) {
          entry = { sinceSec: nowSec, minted: false };
          firstStuck.set(dir, entry);
        }
        if (!entry.minted && nowSec - entry.sinceSec >= graceSec) {
          entry.minted = true;
          decision.mint.push({
            id: originContainmentDistressId(dir),
            dir,
            reason,
          });
        }
      }
      // Re-arm ONLY on POSITIVE evidence: a repo healthy this cycle closes its episode. An
      // inconclusive (deferred) cycle is left untouched so the grace clock persists.
      for (const dir of healthy) {
        firstStuck.delete(dir);
      }
      // CLEAR layer: level-trigger off the durable open set — an open row whose repo shows
      // POSITIVE containment this cycle clears (robust across a restart).
      for (const dir of openDistressDirs) {
        if (healthy.has(dir)) {
          decision.clear.push({ id: originContainmentDistressId(dir), dir });
        }
      }
      // WAKE layer: the earliest producer-ts a future cycle changes state, so a quiescent DB
      // still crosses the grace and re-probes an open row. An UN-minted episode wakes at its
      // exact grace deadline (fire → re-probe → mint). Any still-open row (a minted episode,
      // OR a durable open row after a restart with an empty latch, minus those cleared this
      // cycle) wakes at the bounded retry cadence (fire → re-probe → clear or confirm).
      const cleared = new Set(decision.clear.map((c) => c.dir));
      const candidates: number[] = [];
      let hasOpenAfterClear = false;
      for (const [, entry] of firstStuck) {
        if (!entry.minted) {
          // Enqueue an un-minted grace deadline ONLY while it is STRICTLY FUTURE. An at/past
          // deadline that did NOT mint this cycle (the repo came back deferred/neutral rather
          // than actionable, so the mint layer never saw it) must NOT arm a delay-0 timer — that
          // tight-loops git. It relies solely on the bounded `neutralRetry` cadence below; a
          // LATER actionable result mints immediately off the preserved episode (the mint layer
          // already fires an at/past-deadline unhealthy).
          if (entry.sinceSec + graceSec > nowSec) {
            candidates.push(entry.sinceSec + graceSec);
          }
        } else {
          hasOpenAfterClear = true;
        }
      }
      for (const dir of openDistressDirs) {
        if (!cleared.has(dir)) hasOpenAfterClear = true;
      }
      // A NEUTRAL-retryable probe this cycle (a first-cycle unknown that started no episode and
      // opened no row) still needs a clock edge — otherwise a quiescent DB never re-probes it.
      const hasNeutralRetry = (neutralRetry?.size ?? 0) > 0;
      if (hasOpenAfterClear || hasNeutralRetry) {
        candidates.push(nowSec + retryIntervalSec);
      }
      decision.nextWakeAt =
        candidates.length > 0 ? Math.min(...candidates) : null;
      return decision;
    },
  };
}

/**
 * Payload shape the reconciler hands to `emitDispatched` (schema v50).
 * Mirrors the `DispatchedPayload` interface in
 * `src/reducer.ts` exactly — the producer-side stamp (`ts`) is the
 * unix-seconds wall-clock at mint time and flows through the fold as
 * `pending_dispatches.dispatched_at`, so a re-fold reproduces the row
 * byte-identically (the reducer never reads `Date.now()`). The
 * producer-side TTL sweep in main compares `ts` against `Date.now()`
 * IN MAIN (never in a fold) to decide whether to mint
 * `DispatchExpired`.
 */
export interface DispatchedPayload {
  verb: Verb;
  id: string;
  dir: string | null;
  ts: number;
  launch: {
    session: string;
    window: string;
    pane: string | null;
  };
  /**
   * The dispatched-cell translation forensics (ADR 0047), present ONLY for a
   * cell-bearing `work` launch: the ASSIGNED cell, the EFFECTIVE cell that
   * launched (equal to assigned when the `worker_provider` pin did not translate),
   * and the CONSTRAINT (the pin that forced translation, else null). Recorded on
   * the event `data` blob for event-log forensics; the reducer fold reads only
   * `(verb, id, dir, ts)` and ignores this, so re-fold stays byte-identical.
   */
  cell?: {
    assigned: { model: string; tier: string };
    effective: { model: string; tier: string };
    constraint: string | null;
  };
}

/**
 * Durable-ack reply shape for {@link ConfirmRunningDeps.emitDispatched}
 * `ok:true` means main DURABLY inserted the `Dispatched` event
 * onto the writable connection before replying; `ok:false` means the
 * insert threw (a writer-lock contention or DB failure) OR the durable
 * mint gate SUPPRESSED a re-mint of the same `verb::id` inside the gate
 * window. The reconciler launches ONLY on `ok:true`; an `ok:false` (or a
 * rejected ack-wait — timeout / shutdown) aborts WITHOUT launching, so the
 * SessionStart-drains-before-`Dispatched` race that would re-open the
 * double-dispatch window is closed.
 *
 * `suppressed` splits the two `ok:false` flavors: `suppressed:true` is a
 * benign mint-gate dedup (a live attempt is presumed in flight / freshly
 * minted, so `confirmRunning` returns `"suppressed-dup"` and the cycle glue
 * RE-STAMPS the cooldown instead of clearing it); absent/`false` is a real
 * insert failure (`"aborted-prelaunch"`, cooldown CLEARED).
 */
export interface DispatchedAck {
  ok: boolean;
  suppressed?: boolean;
  /** Immutable Event id used as the exact Dispatch-attempt fence on success. */
  attemptId?: number;
}

/**
 * Read-side claim-acquire observation {@link ConfirmRunningDeps.observeClaimAcquire}
 * returns — the folded projection state `confirmRunning` needs to POSITIVELY
 * confirm a mint won its `(verb, id)` claim before launching. The mint event id
 * IS the attempt fence, so `cursor >= attemptId` means the mint has folded; the
 * claim/pending rows read on the SAME connection are then guaranteed post-fold
 * (SQLite single-connection reads are monotonic forward).
 */
export interface ClaimAcquireObservation {
  /** `reducer_state.last_event_id` — the fold cursor. Once it passes the attempt
   *  id (== the immutable mint event id) the mint is folded. */
  cursor: number;
  /** The current folded `dispatch_claims` row for `(verb, id)`, or null when
   *  none has folded yet. `attemptId` names the HOLDER on a loss. */
  claim: {
    attemptId: number | null;
    state: string;
    sessionId: string | null;
    legacyUnfenced: number;
  } | null;
  /** `pending_dispatches.attempt_id` for `(verb, id)`, or null when no pending
   *  row exists — the second half of the acquired-AND-bound-pending gate. */
  pendingAttemptId: number | null;
}

/**
 * Payload shape for the producer-side TTL sweep's `DispatchExpired`
 * mint (schema v50). Mirrors `src/reducer.ts`'s
 * `DispatchExpiredPayload` shape — the discharge arm is keyed-by-pk
 * only (`(verb, id)`), no `ts` carried (the fold is a DELETE; no row
 * field to populate). `verb` + `id` mirror `DispatchClearedPayload`'s
 * minimal shape; `reason` is optional attribution telemetry (WHY the
 * mint fired — today always the TTL-sweep `dispatch_expiry_timeout`),
 * carried on the event blob for event-log forensics. The reducer fold
 * reads only `(verb, id)` and ignores `reason` — it discharges a row,
 * with no jobs projection to surface it on.
 */
export interface DispatchExpiredPayload {
  verb: Verb;
  id: string;
  reason?: string;
  attempt_id?: number;
}

/**
 * Confirm outcome — internal to `runReconcileCycle`. Six-way:
 *  - `"ok"` — the SessionStart `jobs` row landed before the ceiling; promoted to
 *    `liveDispatches`.
 *  - `"failed"` — `launch()` returned `{ok:false}` (or threw); mints a STICKY
 *    `DispatchFailed` (cleared only by a human `retry_dispatch`).
 *  - `"indoubt"` — the launch SUCCEEDED but the ceiling elapsed with NO `jobs`
 *    row. UNKNOWN, not failed (the backend execs `claude` cold past the ceiling). NO
 *    `DispatchFailed`; the `pending_dispatches` row is KEPT so the TTL sweep
 *    mints `DispatchExpired` if the bind never arrives.
 *  - `"aborted-prelaunch"` — an abort BEFORE `launch()` (ack `{ok:false}` insert
 *    failure / ack-wait reject / shutdown racing the ack). The launch never
 *    happened; the cycle glue CLEARS the cooldown + finalizer stamps (`failedKeys`
 *    owns stickiness).
 *  - `"aborted-postlaunch"` — an abort AFTER `launch()` fired (mid-poll
 *    shutdown). The launch DID happen, so the cycle glue KEEPS the stamps so a
 *    fold-lag-blind re-dispatch can't double-launch the worktree. No
 *    `DispatchFailed` either way (shutdown is clean teardown).
 *  - `"suppressed-dup"` — the durable mint gate SUPPRESSED this re-mint (ack
 *    `{ok:false, suppressed:true}`): NO event row landed and a live attempt is
 *    presumed in flight / freshly minted. The launch never happened, but unlike
 *    `"aborted-prelaunch"` this is a benign dedup — the cycle glue RE-STAMPS the
 *    cooldown (damp, do NOT re-arm) and does NOT set `failedKeys` (the work is
 *    not failed). No `DispatchFailed`.
 *  - `"no-claim"` — the mint's `Dispatched` FOLDED but its claim acquire LOST to
 *    a predecessor's un-released `(verb, id)` claim (cursor past the mint, claim
 *    owned by another attempt). Terminal for this attempt — the launch never
 *    happened. Producer-visible (a loud log naming the holder). Like
 *    `"suppressed-dup"` the cycle glue RE-STAMPS the cooldown (damp, no blind
 *    relaunch loop; the level-triggered reconciler re-derives next cycle, the
 *    claim reaper clears a genuinely-dead holder) and does NOT set `failedKeys`
 *    (contention, not failure). No `DispatchFailed`.
 */
export type ConfirmOutcome =
  | "ok"
  | "failed"
  | "indoubt"
  | "aborted-prelaunch"
  | "aborted-postlaunch"
  | "suppressed-dup"
  | "no-claim";

/**
 * Default poll cadence — every 1s. Spec says ~1-2s; we pick 1000ms so a
 * post-Spawn SessionStart hook (~50-200ms typical) is observed within
 * one tick of the kernel scheduling the new process.
 */
export const DEFAULT_POLL_INTERVAL_MS = 1000;

/**
 * Default confirm ceiling. The early-resolve returns `"ok"` the instant a `jobs`
 * row is visible, so the ceiling rarely matters in the happy path — it just
 * bounds active polling on a launch that produces no row. Generous because a
 * `claude` cold boot can take 24-33s; the standing `liveTabKeys` dedup arm
 * covers the long tail, so this is defense-in-depth, not the dedup signal.
 */
export const DEFAULT_CEILING_MS = 60_000;

/**
 * Floor for the durable `dispatched-ack` wait. The floor MUST exceed
 * `busy_timeout` (5s) plus a boot-drain so a dispatch fired during the boot
 * drain (writable connection blocked a full `busy_timeout` on the WAL writer
 * lock) does NOT false-abort. A phantom row from a timeout after a slow insert
 * self-clears via the TTL sweep.
 */
export const DISPATCHED_ACK_TIMEOUT_MS = 10_000;

/**
 * Bounded poll budget for the pre-launch claim-acquire verification. The mint
 * ack means only "Dispatched event durably inserted"; the fold that acquires the
 * claim runs on main right after (its pump is triggered on the same ack), so the
 * cursor normally passes the mint within a drain tick and the very first poll
 * confirms the acquire. The ceiling bounds the wait so a genuinely wedged
 * reducer degrades to `indoubt` (keep the slot, TTL sweep + re-derive) instead
 * of blocking the dispatch loop; it is comfortably under `DISPATCHED_ACK_TIMEOUT_MS`.
 */
export const CLAIM_VERIFY_CEILING_MS = 3_000;

/** Poll cadence for the claim-acquire verification. Short so a same-tick fold is
 *  observed almost immediately; the happy path breaks on poll 0 with no sleep. */
export const CLAIM_VERIFY_POLL_MS = 50;

/**
 * Worker shell wrapping. Mirrors the CLI autopilot's launch body so the
 * argv shape is identical: `[$SHELL, "-l", "-i", "-c", <body>]` where
 * `<body>` is `<workerCommand> ; exec $SHELL -l -i`. The trailing exec
 * leaves a usable login+interactive shell after `claude` exits so the
 * window stays open for inspection until it is closed by hand. The argv
 * shape is the safe quoting seam at the OS argv boundary — tmux forwards
 * it verbatim after `--`.
 *
 * `shell` is injected (the worker resolves `process.env.SHELL` once
 * with a safe default fallback at boot; the pure function never reads
 * env directly).
 */
export function buildLaunchArgv(
  shell: string,
  workerCommand: string,
): string[] {
  const body = `${workerCommand} ; exec ${shell} -l -i`;
  return [shell, "-l", "-i", "-c", body];
}

/**
 * Classify each epic's repos to a single git toplevel for the worktree
 * lane geometry. The PRODUCER's one resolution pass (mirrors the injectable
 * resolver of `unseededGatedRoots`): `loadReconcileSnapshot` calls this with
 * {@link memoizedNullableGitToplevel}; tests inject a synthetic resolver so the
 * fast tier stays real-git-free. The pure `reconcile` / {@link prepareWorktreeGeometry}
 * layer then compares + places lanes by the RESOLVED toplevel and never shells git.
 *
 * Per epic: collect each task's RAW effective root (`target_repo || project_dir`;
 * an epic with no tasks falls back to its own `project_dir`). An empty root, or a
 * root the resolver maps to `null`, makes the epic `unresolved` (every required
 * root must resolve). Otherwise the distinct resolved toplevels decide: >1 →
 * `multi-repo`; exactly 1 → a single base toplevel, which the second injected
 * probe {@link assessRepo} either keeps `ok` or downgrades to `disabled` (a
 * not-worktree-friendly repo dispatches sequentially on the shared checkout — a
 * non-error fallback, never a sticky reject). `assessRepo` defaults to
 * always-eligible so a caller that passes only `resolve` is byte-identical to the
 * pre-heuristic behavior. The resolver / probe MAY touch git/fs, so this is NEVER
 * called from a fold.
 *
 * `isGrandfathered` is a SEPARATE per-epic input (`assessRepo` is memoized by
 * toplevel and never sees the epic id, so grandfather CANNOT live inside it):
 * an epic that ALREADY has a live worktree lane stays `ok` even when its toplevel
 * assesses `disabled` — so a mid-flight marker change OR (the likelier trigger) a
 * TRANSIENT probe error does NOT strand its `~/worktrees` lanes or lose the
 * merge-to-default finalize. Producer-only (fs/git); defaults to never-grandfather
 * so a pre-grandfather caller is byte-identical.
 */
export function classifyWorktreeRepos(
  epics: readonly Epic[],
  resolve: (root: string) => string | null,
  assessRepo: (toplevel: string) => WorktreeEligibility = () => ({
    eligible: true,
    reason: ELIGIBLE_REASON,
  }),
  laneProbe: (epicId: string, repoDir: string) => LaneProbeResult = () => ({
    epoch: "inconclusive",
    priorLane: false,
  }),
  multiRepoEnabled = false,
): Map<string, WorktreeRepoResolution> {
  // MEMOIZE the lane probe per (epic, repoDir) for THIS classification pass — a
  // foreign-primary epic's eligible arm probes its repo once in `classifyEpicRepo`
  // and again per group in `clusterEpicRepos`, so a bare probe fires the same
  // (epic, repo) git/db read twice. The memo is FRESH per call (GC'd when the pass
  // returns), so it never outlives one snapshot/derivation cycle and a later cycle
  // re-probes. Keyed on the NUL-joined pair (neither component can contain NUL).
  const probeMemo = new Map<string, LaneProbeResult>();
  const memoizedProbe = (epicId: string, repoDir: string): LaneProbeResult => {
    const key = `${epicId}\u0000${repoDir}`;
    let cached = probeMemo.get(key);
    if (cached === undefined) {
      cached = laneProbe(epicId, repoDir);
      probeMemo.set(key, cached);
    }
    return cached;
  };
  const out = new Map<string, WorktreeRepoResolution>();
  for (const epic of epics) {
    out.set(
      epic.epic_id,
      classifyEpicRepo(
        epic,
        resolve,
        assessRepo,
        memoizedProbe,
        multiRepoEnabled,
      ),
    );
  }
  return out;
}

/**
 * PURE projection of the per-cycle {@link WorktreeRepoResolution} map to the
 * operator-surface entry set (fn-1013) — one entry per epic the heuristic marked
 * `disabled` (a not-worktree-friendly repo → serial shared-checkout dispatch), PLUS
 * EVERY CLUSTERED epic's intentional reopened-serial degrade group (a group that ran
 * a worktree lane before but re-cuts serial on an unsafe repo — the `reopenDegrade`
 * groups). The `worktree_repo_status` PK is the composite `(epic_id, repo_dir)`, so a
 * clustered epic with MORE than one degraded group surfaces one row PER group (no
 * per-epic dedup). `ok` epics get worktree lanes (the normal path), and the
 * `multi-repo` / `unresolved` / `no-primary-repo` rejects already show in the red
 * `dispatch_failures` block — the neutral worktree surface is DISTINCT from that.
 * Sorted by `(epic_id, repo_dir)` for a stable serialization so the change-gate
 * (semantic dedupe) never fires on map-iteration-order churn. Exported for tests.
 */
export function buildWorktreeStatusEntries(
  byEpicId: ReadonlyMap<string, WorktreeRepoResolution>,
): WorktreeRepoStatusEntry[] {
  const out: WorktreeRepoStatusEntry[] = [];
  for (const [epicId, resolution] of byEpicId) {
    if (resolution.kind === "disabled") {
      out.push({
        epic_id: epicId,
        repo_dir: resolution.repoDir,
        mode: "serial",
        reason: resolution.reason,
      });
      continue;
    }
    // A CLUSTERED epic surfaces EVERY intentional reopened-serial degrade group — a
    // group that ran a worktree lane before but re-cuts serial on an unsafe repo. The
    // composite `(epic_id, repo_dir)` PK keys each independently, so all siblings
    // surface (no first-group dedup).
    if (resolution.kind === "clustered") {
      for (const g of resolution.groups) {
        if (g.reopenDegrade !== undefined) {
          out.push({
            epic_id: epicId,
            repo_dir: g.repoDir,
            mode: "serial",
            reason: g.reopenDegrade,
          });
        }
      }
    }
  }
  out.sort(
    (a, b) =>
      a.epic_id.localeCompare(b.epic_id) ||
      a.repo_dir.localeCompare(b.repo_dir),
  );
  return out;
}

/** Coalesce window for {@link logMergeGateDeferral}: within it, a repeat for the
 * same key increments a suppressed count instead of logging; the first call past
 * it flushes the message with a "+N suppressed" suffix and re-arms. */
const MERGE_GATE_DEFER_LOG_COALESCE_MS = 60_000;

interface MergeGateDeferLogEntry {
  loggedAt: number;
  suppressed: number;
}

/** Per-key coalesce state for {@link logMergeGateDeferral}, module-scoped so it
 * persists across the per-cycle `computeDeferredEpicIds` calls a fresh reconcile
 * cycle would otherwise reset. */
const mergeGateDeferLogState = new Map<string, MergeGateDeferLogEntry>();

/**
 * Per-key coalesced `console.error` for a merge-gate deferral: a key's first call
 * logs immediately; a repeat within {@link MERGE_GATE_DEFER_LOG_COALESCE_MS}
 * increments a suppressed count instead of logging; the next call past the window
 * flushes the message with a "+N suppressed" suffix and re-arms. A steadily-
 * deferred pair re-fires every reconcile cycle, so this bounds boot-log volume
 * without ever permanently dropping the diagnostic — the pair stays visible at
 * the coalesce cadence for as long as it stays deferred.
 */
export function logMergeGateDeferral(
  key: string,
  message: string,
  now: number = Date.now(),
  state: Map<string, MergeGateDeferLogEntry> = mergeGateDeferLogState,
): void {
  const prior = state.get(key);
  if (
    prior === undefined ||
    now - prior.loggedAt >= MERGE_GATE_DEFER_LOG_COALESCE_MS
  ) {
    const suffix =
      prior !== undefined && prior.suppressed > 0
        ? ` (+${prior.suppressed} suppressed)`
        : "";
    console.error(`${message}${suffix}`);
    state.set(key, { loggedAt: now, suppressed: 0 });
  } else {
    prior.suppressed++;
  }
}

/** One DONE wrapped-cell task whose provider-leg result envelope never appeared —
 *  advisory evidence the wrapper implemented natively instead of delegating
 *  (task .1 mints the marker at launch, this is its backstop). */
export interface WrappedDelegationSkip {
  taskId: string;
  envelopePath: string;
}

/**
 * Producer probe (not a fold): scan every DONE task whose EFFECTIVE cell is
 * wrapped and flag the ones whose provider-leg result envelope ({@link
 * wrappedEnvelopePath}) is absent on disk. Models the `stuck-sentinel:
 * cwd-missing` precedent — the fs stat lives HERE in the producer, never inside
 * a fold, so re-fold determinism is untouched (this reads nothing the
 * readiness/reconcile fold consumes). DETECT-ONLY: the caller only logs: it
 * never blocks a dispatch and mints no `dispatch_failures` row (no operator
 * jam). A thrown `envelopeExists` probe is treated as INCONCLUSIVE, never a
 * false flag — mirrors the shared-checkout desync probe's error handling. An
 * unloadable host matrix can't classify wrappedness either, so it yields no
 * flags rather than a guess. Pure over its injected probe; `envelopeExists`
 * defaults to a real `existsSync` stat.
 */
export function findWrappedDelegationSkips(
  snapshot: Pick<ReconcileSnapshot, "epics" | "hostMatrix">,
  envelopeExists: (path: string) => boolean = existsSync,
): WrappedDelegationSkip[] {
  if (!snapshot.hostMatrix.ok) {
    return [];
  }
  const hostMatrix = snapshot.hostMatrix;
  const out: WrappedDelegationSkip[] = [];
  for (const epic of snapshot.epics) {
    const projectDir = epic.project_dir ?? "";
    for (const task of epic.tasks) {
      if (task.runtime_status !== "done") {
        continue;
      }
      if (task.model == null || task.tier == null) {
        continue;
      }
      if (!isWrappedCell(hostMatrix, task.model)) {
        continue;
      }
      const cwd =
        task.target_repo != null && task.target_repo !== ""
          ? task.target_repo
          : projectDir;
      if (cwd === "") {
        continue;
      }
      const envelopePath = wrappedEnvelopePath(cwd, task.task_id);
      let exists: boolean;
      try {
        exists = envelopeExists(envelopePath);
      } catch {
        continue; // probe error -> inconclusive, never a false flag
      }
      if (!exists) {
        out.push({ taskId: task.task_id, envelopePath });
      }
    }
  }
  return out;
}

/** Per-task coalesce state for {@link logWrappedDelegationSkip}, module-scoped
 *  so it persists across reconcile cycles (mirrors {@link mergeGateDeferLogState}). */
const wrappedDelegationSkipLogState = new Map<string, MergeGateDeferLogEntry>();

/**
 * Per-task coalesced advisory `console.error` for {@link findWrappedDelegationSkips}
 * — reuses {@link logMergeGateDeferral}'s coalescing engine on its own state map so a
 * steadily-flagged task re-fires at the same bounded cadence without ever permanently
 * dropping the diagnostic. Clears itself the cycle the envelope appears (or the task
 * stops matching) simply by no longer being called — no sticky row to retry-clear.
 */
export function logWrappedDelegationSkip(
  skip: WrappedDelegationSkip,
  now: number = Date.now(),
  state: Map<string, MergeGateDeferLogEntry> = wrappedDelegationSkipLogState,
): void {
  logMergeGateDeferral(
    skip.taskId,
    `[autopilot-worker] wrapped-delegation-skipped: ${skip.taskId} done-stamped ` +
      `with no provider-leg result envelope at ${skip.envelopePath} — advisory, ` +
      `evidence the wrapper implemented natively instead of delegating`,
    now,
    state,
  );
}

/**
 * Compute the EPHEMERAL cross-epic merge-gate defer map, keyed PER (epic, repoDir):
 * epic id → the set of its lane repos whose lane MUST NOT be cut this cycle because a
 * same-resolved-repo upstream GROUP is not yet contained in that repo's LOCAL default
 * branch — either a SATISFIED upstream whose lane is not yet an ancestor of default,
 * or a BLOCKED-INCOMPLETE (still-open) upstream that cut a same-repo lane (trivially
 * not-yet-contained, deferred probe-free). Cutting the lane off such a base would
 * fork it off a stale base, inverting merge order. Producer-side + git-touching —
 * probed ONCE per cycle in
 * {@link loadReconcileSnapshot}, read back by the pure `reconcile` as plain
 * {@link ReconcileSnapshot.deferredEpicIds} data. NEVER a fold input; mints NO
 * sticky / `dispatch_failures` row — a deferred group re-evaluates every cycle and
 * provisions the cycle after its upstream's finalize merge lands.
 *
 * PER-GROUP: a downstream B is gated at the granularity of each repo where B cuts a
 * WORKTREE lane ({@link worktreeLaneRepoDirs} — an `ok` epic's lone repo, or a
 * `clustered` epic's `worktree` groups; a `serial` group / reject cuts no lane and is
 * never gated). For each such `repoR`, walk B's DIRECT {@link Epic.resolved_epic_deps}
 * ONLY — never the transitive closure: coverage is INDUCTIVE (an unmerged
 * grand-upstream defers the upstream, which defers B). For each `satisfied` dep whose
 * resolved upstream A cut a worktree lane in that SAME `repoR`
 * ({@link hasWorktreeLaneInRepo}; same-resolved-repo is decided by the RESOLVED git
 * toplevel from {@link classifyWorktreeRepos} — the shared per-cycle memo — NEVER
 * `dep.cross_project`: two epics can share a repo across project basenames), probe A's
 * `keeper/epic/A` merge state in `repoR`. A `blocked-incomplete` dep whose resolved
 * upstream cut a same-repo lane defers `repoR` IMMEDIATELY — probe-free — because a
 * still-open upstream is definitionally not yet an ancestor of default. UNION
 * semantics — B defers `repoR` if ANY such upstream group is unmerged, still open, OR
 * its probe is inconclusive. A downstream group whose repo has NO matching upstream
 * group is absent from the map and proceeds; a cross-repo upstream (a lane in a
 * DIFFERENT repo) never gates `repoR`.
 *  - lane `keeper/epic/A` PRESENT ∧ an ancestor of LOCAL default → merged;
 *  - PRESENT ∧ NOT an ancestor (or the ancestry probe errored/timed out — both
 *    collapse to `isAncestorOf`→`false`) → DEFER;
 *  - DEFINITIVELY ABSENT (a SUCCESSFUL enumeration that omits it) → merged-and-
 *    torn-down (keeper deletes a base only once it is an ancestor of default), so
 *    satisfied;
 *  - enumeration FAILED/timed out → DEFER every dependent group in that repo (a
 *    failed enumeration is NEVER read as absent → no false-satisfied stale fork).
 *
 * Conservative-degrade: in this level-triggered reconciler an inconclusive VCS probe
 * DEFERS (self-heals next cycle) — a stale fork would be permanent. A dangling /
 * null / cross-repo / non-lane / reaped upstream folds to "skip this upstream"
 * (not-gating) whether it is satisfied OR blocked-incomplete — a blocked upstream
 * gates ONLY when it cut a lane in `repoR`, mirroring {@link computeEligibleEpics};
 * the probe NEVER throws out of
 * the snapshot build (a thrown git probe degrades THAT (epic, repo) group to DEFER).
 * The LOCAL default is the same {@link gitResolveDefaultBranch} the provision
 * fork-source uses (NOT `origin/<default>`) so the ancestry ref matches the base a
 * lane is cut from. A `disabled` / `serial` upstream group is intentionally NOT gated
 * on: it never cut a lane (its work landed straight on the shared-checkout default),
 * so a satisfied one is already contained. The per-repo default-branch +
 * lane-enumeration probes are memoized so N upstreams sharing one repo spawn git once;
 * A's toplevel reuses the classification map, so no toplevel is re-resolved here.
 */
export async function computeDeferredEpicIds(
  epics: readonly Epic[],
  worktreeRepoByEpicId: ReadonlyMap<string, WorktreeRepoResolution>,
  run: WorktreeGitRunner = gitExec,
): Promise<Map<string, Set<string>>> {
  const deferred = new Map<string, Set<string>>();
  // Record (epicId, repoDir) as deferred, lazily minting the epic's repo set.
  const markDeferred = (epicId: string, repoDir: string): void => {
    let repos = deferred.get(epicId);
    if (repos === undefined) {
      repos = new Set<string>();
      deferred.set(epicId, repos);
    }
    repos.add(repoDir);
  };

  // Per-repo memos so N same-repo upstreams resolve the default branch + enumerate
  // lanes ONCE. A throwing probe degrades to the conservative value (null default /
  // `{ ok: false }` enumeration → DEFER), never out of the snapshot build.
  const defaultBranchByRepo = new Map<string, string | null>();
  const resolveLocalDefault = async (
    repoDir: string,
  ): Promise<string | null> => {
    const hit = defaultBranchByRepo.get(repoDir);
    if (hit !== undefined) {
      return hit;
    }
    let value: string | null;
    try {
      value = await gitResolveDefaultBranch(repoDir, run);
    } catch {
      value = null; // unresolvable default → DEFER (never proceed off an unknown base)
    }
    defaultBranchByRepo.set(repoDir, value);
    return value;
  };
  const laneSetByRepo = new Map<string, EpicLaneBranchSet>();
  const enumerateLanes = async (
    repoDir: string,
  ): Promise<EpicLaneBranchSet> => {
    const hit = laneSetByRepo.get(repoDir);
    if (hit !== undefined) {
      return hit;
    }
    let value: EpicLaneBranchSet;
    try {
      value = await gitEnumerateEpicLaneBranches(repoDir, run);
    } catch {
      value = { ok: false }; // enumeration error → DEFER every dependent in this repo
    }
    laneSetByRepo.set(repoDir, value);
    return value;
  };

  for (const epic of epics) {
    const resolution = worktreeRepoByEpicId.get(epic.epic_id);
    // The repos where B cuts a WORKTREE lane forked off a base — the only groups a
    // stale-base fork can invert. A serial group / multi-repo / unresolved /
    // no-primary reject cuts no lane (handled elsewhere) → nothing to gate.
    if (resolution === undefined) {
      continue;
    }
    const laneRepos = worktreeLaneRepoDirs(resolution);
    if (laneRepos.length === 0) {
      continue;
    }
    const deps = epic.resolved_epic_deps;
    if (deps === null) {
      continue;
    }
    // Per LANE REPO independently: a downstream group in `repoR` is deferred by its
    // OWN same-repo upstreams; a sibling group in a clean repo proceeds.
    for (const repoR of laneRepos) {
      try {
        for (const dep of deps) {
          // A BLOCKED-INCOMPLETE upstream that cut a same-resolved-repo worktree lane
          // is trivially not-yet-contained in LOCAL default (its `keeper/epic/A` lane
          // is still open), so cutting B's lane off that base forks it off a stale
          // base and inverts merge order exactly as an unmerged satisfied upstream
          // would — defer probe-free (an open epic is definitionally unmerged; no
          // enumeration/ancestry needed). Dangling (null id), reaped (absent from the
          // map), disabled/serial, cross-repo, and no-lane-in-`repoR` blocked
          // upstreams fold to skip, identically to a satisfied one in the same shape.
          if (dep.state === "blocked-incomplete") {
            const blockedUpstreamId = dep.resolved_epic_id;
            if (blockedUpstreamId === null) {
              continue; // dangling-shaped blocked edge — not-gating
            }
            const blockedUpstreamRes =
              worktreeRepoByEpicId.get(blockedUpstreamId);
            if (
              blockedUpstreamRes !== undefined &&
              hasWorktreeLaneInRepo(blockedUpstreamRes, repoR)
            ) {
              logMergeGateDeferral(
                `${epic.epic_id}@${repoR}#blocked-incomplete`,
                `[autopilot-worker] cross-epic merge-gate: deferring ${epic.epic_id}@${repoR} — upstream ${blockedUpstreamId} still open (blocked-incomplete lane not yet merged into LOCAL default)`,
              );
              markDeferred(epic.epic_id, repoR);
              break;
            }
            continue;
          }
          // Only a SATISFIED (done) upstream reaches the merge probe below; a
          // `dangling` dep (blocked-incomplete is handled just above) blocks B
          // through the normal readiness gate, never here.
          if (dep.state !== "satisfied") {
            continue;
          }
          const upstreamId = dep.resolved_epic_id;
          if (upstreamId === null) {
            continue; // dangling/ambiguous — not-gating (mirrors computeEligibleEpics)
          }
          const upstreamRes = worktreeRepoByEpicId.get(upstreamId);
          // Same-resolved-repo gate: the upstream must have cut a WORKTREE lane in
          // B's exact `repoR` (its `ok` toplevel, or a `clustered` `worktree` group
          // there). A reaped (absent), non-lane, serial, or cross-repo upstream never
          // gates this group (cross-repo finalize is independent per repo).
          if (
            upstreamRes === undefined ||
            !hasWorktreeLaneInRepo(upstreamRes, repoR)
          ) {
            continue;
          }
          // UNION: one unmerged/inconclusive same-repo upstream defers this group.
          // Enumerate first (cheaper than ancestry) — a definitively-absent lane is
          // satisfied without an ancestry probe.
          const lanes = await enumerateLanes(repoR);
          if (!lanes.ok) {
            logMergeGateDeferral(
              `${epic.epic_id}@${repoR}#enum-inconclusive`,
              `[autopilot-worker] cross-epic merge-gate: deferring ${epic.epic_id}@${repoR} — could not enumerate ${repoR} lane branches (probe inconclusive)`,
            );
            markDeferred(epic.epic_id, repoR);
            break;
          }
          const laneBranch = baseBranchFor(upstreamId);
          if (!lanes.branches.has(laneBranch)) {
            continue; // DEFINITIVELY absent → merged-and-torn-down → satisfied
          }
          // Present: merged IFF an ancestor of LOCAL default. `gitIsAncestorOf`→`false`
          // covers BOTH not-ancestor AND an errored/timed-out probe → DEFER (the
          // three-way exit-0/exit-1/timeout distinction matters only for diagnostics:
          // not-ancestor and inconclusive both defer; only exit 0 proceeds).
          const localDefault = await resolveLocalDefault(repoR);
          if (localDefault === null) {
            logMergeGateDeferral(
              `${epic.epic_id}@${repoR}#default-branch-inconclusive`,
              `[autopilot-worker] cross-epic merge-gate: deferring ${epic.epic_id}@${repoR} — could not resolve ${repoR} default branch (probe inconclusive)`,
            );
            markDeferred(epic.epic_id, repoR);
            break;
          }
          if (!(await gitIsAncestorOf(repoR, laneBranch, localDefault, run))) {
            logMergeGateDeferral(
              `${epic.epic_id}@${repoR}#not-ancestor`,
              `[autopilot-worker] cross-epic merge-gate: deferring ${epic.epic_id}@${repoR} — upstream ${upstreamId} (${laneBranch}) not yet merged into ${localDefault}`,
            );
            markDeferred(epic.epic_id, repoR);
            break;
          }
        }
      } catch (err) {
        // A git probe threw — DEFER this (epic, repo) group conservatively (an
        // inconclusive probe must never proceed: a stale fork is permanent). The
        // snapshot build never sees the throw.
        logMergeGateDeferral(
          `${epic.epic_id}@${repoR}#probe-threw`,
          `[autopilot-worker] cross-epic merge-gate: deferring ${epic.epic_id}@${repoR} — probe threw: ${errMsg(err)}`,
        );
        markDeferred(epic.epic_id, repoR);
      }
    }
  }
  return deferred;
}

/** The readiness verdict for a dependent's EXISTING assignment worktree — the second
 *  half (beside rib ancestry) of the sibling-source clear test for an already-cut lane.
 *  `ready` = present, on the assignment branch, clean, no MERGE_HEAD, tree synced with
 *  the ref; `not-ready` = a POSITIVELY-observed stale/dirty/off-branch/mid-merge state
 *  (repairable by the progress actor); `unknown` = a missing worktree or an inconclusive
 *  probe (also held, never cleared on branch evidence alone). */
export type AssignmentWorktreeReadiness =
  | { kind: "ready" }
  | { kind: "not-ready"; detail: string }
  | { kind: "unknown"; detail: string };

/**
 * Probe one dependent's EXISTING assignment worktree for dispatch readiness in TWO
 * bounded steps. FIRST, REGISTRATION: the dir must be a REGISTERED linked worktree
 * (`git worktree list --porcelain`, via the shared tri-state {@link listWorktreesResult})
 * whose exact normalized path is checked out on `branch` — a ready-LOOKING directory that
 * is not a registered worktree, or is registered on a different branch, must NEVER pass,
 * because the B-sharpened daemon redispatch probe bypasses provision, so nothing
 * downstream catches an unregistered / mis-branched dir. A timed-out / inconclusive list
 * is `unknown` (transient, held); a successful list omitting this path, or carrying it on
 * another branch, is a POSITIVELY-observed `not-ready` (the actor may recreate the lane).
 * SECOND, TREE STATE: reuse the shared {@link mergeReadiness} primitive (so a symbolic-ref
 * advance that left the index/worktree trailing surfaces as `dirty`, never a false ready).
 * An ABSENT worktree dir or an inconclusive/thrown probe is `unknown` (held, deferred to
 * the actor — never cleared on branch content alone); a positively dirty / off-branch /
 * mid-merge tree is `not-ready`. Producer-only reads; NEVER throws. Shared by the gate and
 * the parts-6 progress actor so both apply the identical (registration ∧ ancestry ∧
 * readiness) test.
 */
export async function assignmentWorktreeReadiness(
  worktreePath: string,
  branch: string,
  run: WorktreeGitRunner = gitExec,
  worktreeExists: (p: string) => boolean = existsSync,
  // OBSERVATIONAL-tier memo (rider 2): a tri-state `git worktree list` snapshot taken
  // ONCE per repo per cycle and injected, so N dependents in one repo spawn ONE list —
  // never a per-readiness-call spawn (this host's busy-lag watchdog kills on subprocess
  // fan-out). Omitted → a fresh per-call list (the actor/launch MUTATION tier passes its
  // OWN fresh snapshot; it never reuses a possibly-stale cycle memo before an effect).
  worktreeList?: GitReadOutcome<WorktreeEntry[]>,
): Promise<AssignmentWorktreeReadiness> {
  let present: boolean;
  try {
    present = worktreeExists(worktreePath);
  } catch (err) {
    return { kind: "unknown", detail: `presence probe threw: ${errMsg(err)}` };
  }
  if (!present) {
    return { kind: "unknown", detail: "assignment worktree absent" };
  }
  // Registration gate — a present dir is not enough; it must be a REGISTERED linked
  // worktree on `branch`. Absent/mismatch → `not-ready` (positively observed); a
  // timeout / inconclusive list → `unknown` (transient). Both route to the caller's
  // defer, so a ready-looking-but-unregistered lane is never dispatched into.
  const listed =
    worktreeList ?? (await gitListWorktreesResult(worktreePath, run));
  if (listed.kind !== "ok") {
    const detail =
      listed.kind === "timeout" ? "git worktree list timed out" : listed.detail;
    return {
      kind: "unknown",
      detail: `worktree registration probe ${listed.kind}: ${detail}`,
    };
  }
  const entry = listed.value.find(
    (e) =>
      stripTrailingSlashPath(e.path) === stripTrailingSlashPath(worktreePath),
  );
  if (entry === undefined) {
    return {
      kind: "not-ready",
      detail: `unregistered: ${worktreePath} is not a registered linked worktree`,
    };
  }
  if (entry.branch === null || shortBranchName(entry.branch) !== branch) {
    return {
      kind: "not-ready",
      detail: `registration branch mismatch: registered on ${entry.branch ?? "detached"}, expected ${branch}`,
    };
  }
  try {
    const r = await gitMergeReadiness(worktreePath, branch, run);
    switch (r.kind) {
      case "ready":
        return { kind: "ready" };
      case "dirty":
        return { kind: "not-ready", detail: `dirty: ${r.detail}` };
      case "mid-merge":
        return {
          kind: "not-ready",
          detail: `mid-merge (MERGE_HEAD=${r.mergeHead})`,
        };
      case "off-branch":
        return { kind: "not-ready", detail: `off-branch (HEAD=${r.head})` };
      case "would-clobber":
        return { kind: "not-ready", detail: "would-clobber" };
      default:
        return { kind: "unknown", detail: "unclassified readiness" };
    }
  } catch (err) {
    return { kind: "unknown", detail: `readiness probe threw: ${errMsg(err)}` };
  }
}

/** The ACTUAL target base a dependent's lane resolves against — the SHARED gate↔actor
 *  seam ({@link resolveTaskTarget}). `defer` is a PURE hold with NO target identity
 *  (enumeration unknown, pre-cut absent). `repair-needed` is an EXISTING lane whose
 *  worktree failed readiness — it carries the FULL target identity (branch + path +
 *  readiness verdict) so the GATE renders its hold AND the ACTOR consumes the SAME value
 *  as its repair/recreate work item, one probe two consumers, zero re-derivation and zero
 *  reason-string parsing. `target` is a dispatch-ready lane (existing + ready, or pre-cut). */
export type TaskTargetResolution =
  | { kind: "defer"; reason: string }
  | {
      kind: "repair-needed";
      targetBranch: string;
      worktreePath: string;
      existing: true;
      readiness: { kind: "not-ready" | "unknown"; detail: string };
    }
  | {
      kind: "target";
      targetBranch: string;
      existing: boolean;
      worktreePath: string;
    };

/**
 * Resolve the ACTUAL base a dependent task's lane will be measured against — the seam
 * BOTH the sibling-source gate and the parts-6 progress actor consume, so neither reads
 * a proxy (epic base or task status). Target selection is by POSITIVE ENUMERATION:
 *  - assignment branch POSITIVELY ENUMERATED (the lane is ALREADY CUT) → the base it
 *    SEES is its OWN branch, never the fork source. The done rib must be an ancestor of
 *    THAT branch AND the worktree must be READY ({@link assignmentWorktreeReadiness}) —
 *    an existing lane whose worktree is stale/dirty/off-branch/mid-merge/absent DEFERS
 *    (repaired by the actor), never cleared on branch content alone.
 *  - assignment branch DEFINITIVELY ABSENT (a successful enumeration omitting it — the
 *    lane is NOT yet cut) → the base it WILL fork off is the {@link parentBranchFor}
 *    fork source (the pre-cut path; normal provision creates the lane off it).
 *  - enumeration UNKNOWN/failed → DEFER (never read a failed enumeration as absent).
 * Producer-only; NEVER throws (a thrown probe is the caller's DEFER).
 */
export async function resolveTaskTarget(
  assignment: WorktreeAssignment,
  plan: WorktreePlan,
  tasks: Task[],
  laneSet: EpicLaneBranchSet,
  run: WorktreeGitRunner = gitExec,
  readiness: (
    worktreePath: string,
    branch: string,
  ) => Promise<AssignmentWorktreeReadiness> = (worktreePath, branch) =>
    assignmentWorktreeReadiness(worktreePath, branch, run),
): Promise<TaskTargetResolution> {
  if (!laneSet.ok) {
    return { kind: "defer", reason: "lane-enumeration-unknown" };
  }
  if (laneSet.branches.has(assignment.branch)) {
    // The lane is ALREADY CUT: the base it sees is its OWN branch. Require the worktree
    // ready before any branch-content evidence counts (a stale/dirty/off-branch existing
    // lane must NOT clear on ancestry alone). A not-ready/unknown existing lane is
    // `repair-needed`, carrying its FULL identity so the actor repairs THIS exact lane.
    const verdict = await readiness(assignment.worktreePath, assignment.branch);
    if (verdict.kind !== "ready") {
      return {
        kind: "repair-needed",
        targetBranch: assignment.branch,
        worktreePath: assignment.worktreePath,
        existing: true,
        readiness: { kind: verdict.kind, detail: verdict.detail },
      };
    }
    return {
      kind: "target",
      targetBranch: assignment.branch,
      existing: true,
      worktreePath: assignment.worktreePath,
    };
  }
  // DEFINITIVELY ABSENT — the lane is not yet cut, so the base it WILL fork off is the
  // primary-parent fork source (the SAME parentBranchFor dispatch derives).
  return {
    kind: "target",
    targetBranch: parentBranchFor(assignment, plan, tasks),
    existing: false,
    worktreePath: assignment.worktreePath,
  };
}

/**
 * Compute the EPHEMERAL intra-epic sibling-source defer map, keyed PER task id: a
 * NON-DONE dependent task → the blocking reason. That reason ALWAYS names a DONE
 * dependency-sibling rib `keeper/epic/<id>--<sib>`: a not-yet-ancestor rib names itself
 * bare; a target-readiness / enumeration defer names the first done rib WITH the readiness
 * reason appended (`<rib> (<reason>)`), so the operator rail always names the unmet source
 * edge even when the immediate blocker is the target worktree. A dependent's lane must not
 * be cut — nor an already-cut lane dispatched into
 * — until every DONE dependency-sibling's rib is an ancestor of the base its lane
 * ACTUALLY SEES ({@link resolveTaskTarget}: its own already-cut branch, else the
 * {@link parentBranchFor} fork source) AND that base's worktree is ready. Else the lane
 * forks off — or already sits on — a base missing the sibling's landed work (a stale-base
 * fork that inverts merge order). Producer-side + git-touching — probed ONCE per cycle in
 * {@link loadReconcileSnapshot} (gated on {@link worktreeMode}), read back by the pure
 * `reconcile` as plain {@link ReconcileSnapshot.deferredSiblingSources} data. NEVER a
 * fold input; mints NO sticky / `dispatch_failures` row. The hold is released ONLY by the
 * rib actually reaching the derived target (via the existing pending-integration owner,
 * or the progress actor) — NEVER by a timeout, retry count, or task status.
 *
 * The plan every dependent's base resolves against is the SAME
 * {@link prepareWorktreeGeometry} geometry dispatch consumes (freshEpoch-aware, across
 * both `ok` and `clustered` `worktree` groups) — NEVER a fresh non-done-filtered
 * derivation. Per non-close-sink assignment T with ≥1 DONE dependency-sibling, resolve
 * its target, then for each DONE parent P (P ∈ `T.depends_on`, `worker_phase === "done"`)
 * probe P's rib against that target:
 *  - rib DEFINITIVELY ABSENT (a SUCCESSFUL enumeration that omits it) → merged-and-torn-
 *    down, or P sat on the base (never a rib) → CONTAINED, no defer;
 *  - rib PRESENT ∧ an ancestor of the target → CONTAINED, no defer;
 *  - rib PRESENT ∧ NOT an ancestor (or the ancestry probe errored/timed out — both
 *    collapse to `isAncestorOf`→`false`) → DEFER T naming that rib;
 *  - enumeration FAILED / target-worktree not ready / any probe threw → DEFER.
 * The FIRST blocking rib wins. The per-repo lane enumeration is memoized so N dependents
 * sharing one repo spawn git once; a dependent with NO done sibling touches no git.
 * Conservative-degrade throughout: an inconclusive VCS probe DEFERS (a stale fork would
 * be permanent). NEVER throws out of the snapshot build.
 */
export async function computeDeferredSiblingSources(
  epics: readonly Epic[],
  worktreeRepoByEpicId: ReadonlyMap<string, WorktreeRepoResolution>,
  run: WorktreeGitRunner = gitExec,
  worktreesRoot?: string,
  // Injected readiness (tests). When omitted, a per-repo-memoized default is built inside
  // (rider 2): ONE `git worktree list` per repo per cycle, threaded into the shared probe.
  readiness?: (
    worktreePath: string,
    branch: string,
  ) => Promise<AssignmentWorktreeReadiness>,
): Promise<Map<string, string>> {
  const deferred = new Map<string, string>();

  // Per-repo memo so N dependents in one repo enumerate lanes ONCE. A throwing probe
  // degrades to the conservative value (`{ ok: false }` enumeration → DEFER), never out
  // of the snapshot build.
  const laneSetByRepo = new Map<string, EpicLaneBranchSet>();
  const enumerateLanes = async (
    repoDir: string,
  ): Promise<EpicLaneBranchSet> => {
    const hit = laneSetByRepo.get(repoDir);
    if (hit !== undefined) {
      return hit;
    }
    let value: EpicLaneBranchSet;
    try {
      value = await gitEnumerateEpicLaneBranches(repoDir, run);
    } catch {
      value = { ok: false }; // enumeration error → DEFER every dependent in this repo
    }
    laneSetByRepo.set(repoDir, value);
    return value;
  };

  // Rider 2 OBSERVATIONAL tier: memoize the tri-state `git worktree list` ONCE per repo
  // per cycle (git always lists at least the main worktree, so one spawn covers every
  // dependent in the repo), then thread it into the shared readiness probe.
  const worktreeListByRepo = new Map<string, GitReadOutcome<WorktreeEntry[]>>();
  const memoWorktreeList = async (
    repoDir: string,
  ): Promise<GitReadOutcome<WorktreeEntry[]>> => {
    const hit = worktreeListByRepo.get(repoDir);
    if (hit !== undefined) {
      return hit;
    }
    let value: GitReadOutcome<WorktreeEntry[]>;
    try {
      value = await gitListWorktreesResult(repoDir, run);
    } catch (err) {
      value = { kind: "inconclusive", detail: `list threw: ${errMsg(err)}` };
    }
    worktreeListByRepo.set(repoDir, value);
    return value;
  };

  // Rider (ancestry twin of the once/repo registration list): memoize the epic-base →
  // target-branch ancestry verdict ONCE per resolved target per cycle. Several absent done
  // parents of the same dependent repeat the IDENTICAL epicBase→targetBranch probe when the
  // base IS contained (the loop does not break). `gitIsAncestorOf` collapses an UNKNOWN /
  // errored probe to `false`, so a cached miss stays a HOLD for the whole cycle.
  const epicBaseAncestryMemo = new Map<string, boolean>();
  const epicBaseAncestorOfTarget = async (
    repoDir: string,
    epicBaseBranch: string,
    targetBranch: string,
  ): Promise<boolean> => {
    const key = JSON.stringify([repoDir, epicBaseBranch, targetBranch]);
    const hit = epicBaseAncestryMemo.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const value = await gitIsAncestorOf(
      repoDir,
      epicBaseBranch,
      targetBranch,
      run,
    );
    epicBaseAncestryMemo.set(key, value);
    return value;
  };

  // The SAME geometry dispatch consumes — one derivation, no drift. Pure (no git/fs):
  // resolution already happened in `worktreeRepoByEpicId`.
  const { byEpicId } = prepareWorktreeGeometry(
    epics,
    worktreeRepoByEpicId,
    worktreesRoot,
  );

  for (const epic of epics) {
    const geom = byEpicId.get(epic.epic_id);
    if (geom === undefined) {
      continue;
    }
    // Only rib-bearing worktree lanes can fork off a base missing a sibling's work. A
    // `disabled` / `reject` / `cycle` epic (and a `serial` clustered group) cuts no rib.
    const lanes: Array<{ repoDir: string; plan: WorktreePlan }> = [];
    if (geom.kind === "ok") {
      lanes.push({ repoDir: geom.repoDir, plan: geom.plan });
    } else if (geom.kind === "clustered") {
      for (const g of geom.groups) {
        if (g.mode === "worktree" && g.plan !== undefined) {
          lanes.push({ repoDir: g.repoDir, plan: g.plan });
        }
      }
    } else {
      continue;
    }

    const taskById = new Map(epic.tasks.map((t) => [t.task_id, t]));
    const epicBase = baseBranchFor(epic.epic_id);
    for (const { repoDir, plan } of lanes) {
      // Rider 2: the default readiness fetches the ONE per-repo worktree-list snapshot
      // LAZILY through the memo, so a repo whose dependents never need a readiness probe
      // (no done sibling) spawns ZERO `git worktree list`. A test-injected `readiness`
      // bypasses it entirely (touches no worktree list).
      const effectiveReadiness =
        readiness ??
        (async (wp: string, b: string) =>
          assignmentWorktreeReadiness(
            wp,
            b,
            run,
            existsSync,
            await memoWorktreeList(repoDir),
          ));
      for (const assignment of plan.assignments) {
        if (assignment.isCloseSink) {
          continue;
        }
        const dependent = taskById.get(assignment.nodeId);
        if (dependent === undefined) {
          continue;
        }
        // Only a dependent with ≥1 DONE dependency-sibling can be gated — resolved
        // BEFORE any git so a done-sibling-free task spawns zero probes.
        const doneParents = dependent.depends_on
          .map((depId) => taskById.get(depId))
          .filter(
            (p): p is Task => p !== undefined && p.worker_phase === "done",
          );
        if (doneParents.length === 0) {
          continue;
        }
        const firstRib = () =>
          ribBranchFor(epic.epic_id, doneParents[0]?.task_id ?? "");
        try {
          const laneSet = await enumerateLanes(repoDir);
          const target = await resolveTaskTarget(
            assignment,
            plan,
            epic.tasks,
            laneSet,
            run,
            effectiveReadiness,
          );
          if (target.kind === "defer") {
            // Pure defer (enumeration unknown): name the first done rib + reason.
            deferred.set(dependent.task_id, `${firstRib()} (${target.reason})`);
            continue;
          }
          if (target.kind === "repair-needed") {
            // An existing lane whose worktree failed readiness — HOLD naming the rib +
            // readiness reason (the actor consumes the SAME repair-needed value; the gate
            // never clears on branch content while the worktree is not ready).
            deferred.set(
              dependent.task_id,
              `${firstRib()} (assignment-worktree-${target.readiness.kind}: ${target.readiness.detail})`,
            );
            continue;
          }
          for (const parent of doneParents) {
            const rib = ribBranchFor(epic.epic_id, parent.task_id);
            let contained: boolean;
            if (!laneSet.ok) {
              contained = false; // defensive — resolveTaskTarget already deferred
            } else if (!laneSet.branches.has(rib)) {
              // P0-A: an ABSENT rib is contained-by-teardown ONLY relative to the CANONICAL
              // fan-in sink (the epic base), NEVER an arbitrary already-cut dependent branch.
              // For an EXISTING lane require POSITIVE evidence: the epic base (which absorbed
              // the torn-down rib) must be PRESENT AND an ancestor of THAT lane. A present base
              // not-ancestor/errored → HOLD; and the epic base ALSO ABSENT is NOT proof the
              // surviving lane contains the source (it may be a fresh-epoch transition, a
              // partial teardown, or inconsistent state) → HOLD until a fresh base is
              // provisioned and integrated. A PRE-CUT lane forks off the canonical base
              // region, so the teardown proof stands (absent → contained).
              if (target.existing) {
                contained =
                  laneSet.branches.has(epicBase) &&
                  (await epicBaseAncestorOfTarget(
                    repoDir,
                    epicBase,
                    target.targetBranch,
                  ));
              } else {
                contained = true;
              }
            } else {
              // Present: contained IFF an ancestor of the RESOLVED target base.
              // `gitIsAncestorOf` → false covers not-ancestor AND an errored probe.
              contained = await gitIsAncestorOf(
                repoDir,
                rib,
                target.targetBranch,
                run,
              );
            }
            if (!contained) {
              deferred.set(dependent.task_id, rib);
              break; // first blocking rib wins — the dependent is held regardless of rest
            }
          }
        } catch {
          // A probe threw — DEFER this dependent conservatively (an inconclusive probe
          // must never proceed: a stale fork is permanent). Names the first done rib.
          deferred.set(dependent.task_id, firstRib());
        }
      }
    }
  }
  return deferred;
}

/**
 * Compute the durable MERGE-LANDED set: every lane-capable epic whose worktree
 * lane branch (`keeper/epic/<id>`) is provably merged into the LOCAL default
 * branch, plus a done `disabled` serial fallback whose work landed directly on
 * that branch. Producer-side — git is probed ONCE per lane-bearing repo per cycle in
 * {@link loadReconcileSnapshot} (gated on {@link worktreeMode}), then emitted as a
 * synthetic `LaneMerged` event main folds into the LIVE-ONLY `lane_merged`
 * projection. NEVER a fold input; mints no `dispatch_failures` row. Returns the
 * entries sorted by `epic_id` for a stable serialization so the change-gate
 * (semantic dedupe) never fires on map-iteration-order churn. Exported for tests.
 *
 * The per-epic merge verdict mirrors {@link computeDeferredEpicIds}'s per-upstream
 * probe, applied to the epic's OWN lane — UNION-free (one lane per epic):
 *  - lane `keeper/epic/<id>` PRESENT ∧ an ancestor of LOCAL default → MERGED;
 *  - DEFINITIVELY ABSENT (a SUCCESSFUL enumeration that omits it) ∧ the epic's
 *    work is terminally done → merged-and-torn-down (keeper deletes a base only
 *    once it is an ancestor of default) → MERGED; absent while the work is still
 *    running (a serial-checkout epic that never cut a lane) → NOT merged;
 *  - PRESENT ∧ NOT an ancestor (or the ancestry probe errored/timed out — both
 *    collapse to `isAncestorOf`→`false`) → NOT merged;
 *  - enumeration FAILED/timed out → NOT merged (conservative: never CLAIM merged
 *    off an inconclusive probe — the inverse degrade of the merge-gate, which
 *    defers off inconclusive; here the safe default is to UNDER-report, so a
 *    `landed` waiter blocks one more cycle rather than fire early).
 *
 * A `clustered` multi-repo epic (rollout flag ON) emits its SINGLE `epic_id`-keyed
 * row (no schema change) ONLY once EVERY group has landed — never early on the
 * first group merging. "Landed" per group: a `worktree` group's lane merged into
 * its repo's local default AND its own tasks done (the same lane-merge + done-evidence
 * probe as `ok`, applied per group, so a fresh/empty group lane never false-fires);
 * a `serial` group (cuts no lane, lands incrementally on the shared checkout) when
 * ALL its tasks are administratively done (`worker_phase === "done"`). The producer holds the full
 * classification, so it knows the group denominator; the consumer
 * ({@link computeLandedEpicIds}, pure/non-git) keeps its unchanged "row → landed"
 * logic. Per-repo lane observability continues to ride `worktree_repo_status` — the
 * `lane_merged` row is NOT overloaded for per-repo display.
 *
 * An explicit whole-epic `disabled` resolution cuts no lane and emits only when
 * the epic itself is done, without a git probe. Multi-repo rejects, unresolved or
 * no-primary resolutions, and missing classifications remain absent. A throwing
 * git probe degrades that epic to NOT merged; the function NEVER throws out of the
 * snapshot build. The per-repo default-branch + lane-enumeration probes are
 * memoized so N epics/groups sharing one repo spawn git once.
 */
export async function computeMergedLaneEntries(
  epics: readonly Epic[],
  worktreeRepoByEpicId: ReadonlyMap<string, WorktreeRepoResolution>,
  run: WorktreeGitRunner = gitExec,
): Promise<LaneMergedEntry[]> {
  // Per-repo memos so N same-repo epics resolve the default branch + enumerate
  // lanes ONCE. A throwing probe degrades to the conservative value (null default
  // / `{ ok: false }` enumeration → NOT merged), never out of the snapshot build.
  const defaultBranchByRepo = new Map<string, string | null>();
  const resolveLocalDefault = async (
    repoDir: string,
  ): Promise<string | null> => {
    const hit = defaultBranchByRepo.get(repoDir);
    if (hit !== undefined) {
      return hit;
    }
    let value: string | null;
    try {
      value = await gitResolveDefaultBranch(repoDir, run);
    } catch {
      value = null; // unresolvable default → NOT merged (never claim off an unknown base)
    }
    defaultBranchByRepo.set(repoDir, value);
    return value;
  };
  const laneSetByRepo = new Map<string, EpicLaneBranchSet>();
  const enumerateLanes = async (
    repoDir: string,
  ): Promise<EpicLaneBranchSet> => {
    const hit = laneSetByRepo.get(repoDir);
    if (hit !== undefined) {
      return hit;
    }
    let value: EpicLaneBranchSet;
    try {
      value = await gitEnumerateEpicLaneBranches(repoDir, run);
    } catch {
      value = { ok: false }; // enumeration error → NOT merged for this repo's epics
    }
    laneSetByRepo.set(repoDir, value);
    return value;
  };

  // Probe ONE repo's `keeper/epic/<id>` lane for merged-into-default, reusing the
  // memoized enumeration + ancestry probes. The `ok` verdict verbatim, factored so
  // a `clustered` epic's per-`worktree`-group probe shares it:
  //  - enumeration inconclusive → NOT merged (never claim off a failed probe);
  //  - lane DEFINITIVELY ABSENT ∧ the epic started ∧ `laneCarriesLandedWork` →
  //    merged-and-torn-down → MERGED (no ancestry probe); DEFINITIVELY ABSENT ∧
  //    (never started OR work not yet done) → NOT merged (a never-started epic
  //    never cut a lane; a started-but-still-running serial-checkout epic also
  //    reads absent, so it takes the same done-evidence the present arm requires
  //    to tell a finished epic from a mid-flight one — inferring merged off bare
  //    "started" fires `landed` spuriously on a fresh or in-flight epic);
  //  - PRESENT ∧ NOT `laneCarriesLandedWork` → NOT merged (a zero-commit lane sits
  //    AT its fork point, a VACUOUS ancestor of default — git alone cannot tell it
  //    from a merged lane, so the caller must prove non-emptiness, e.g. an `ok`
  //    epic's tasks all done);
  //  - PRESENT ∧ `laneCarriesLandedWork` ∧ ancestor of LOCAL default → MERGED; else
  //    (not-ancestor / errored / timed-out / unresolvable default) → NOT merged.
  const laneMergedInRepo = async (
    repoDir: string,
    laneBranch: string,
    epicHasStarted: boolean,
    laneCarriesLandedWork: boolean,
  ): Promise<boolean> => {
    const lanes = await enumerateLanes(repoDir);
    if (!lanes.ok) {
      return false; // enumeration inconclusive → NOT merged
    }
    if (!lanes.branches.has(laneBranch)) {
      // DEFINITIVELY absent → merged-and-torn-down → MERGED, but ONLY once the
      // epic both started AND carries landed work. A started-but-still-running
      // serial-checkout epic (tasks landing incrementally on the shared checkout,
      // no lane ever cut) reads absent too, so "started" alone cannot tell it from
      // a finished-and-torn-down epic — require the same done-evidence the present
      // arm does. A never-started epic never cut a lane, so absence proves nothing
      // about merge either way (keep `landed` waiting).
      return epicHasStarted && laneCarriesLandedWork;
    }
    // PRESENT lane. A freshly-cut lane sits AT its fork point, so it is a VACUOUS
    // ancestor of default (default is at or past the fork) — git alone cannot tell
    // an empty lane from a merged one. Require external evidence the lane carries
    // real mergeable work before trusting the ancestry verdict; otherwise a
    // started-but-unworked epic's empty lane false-fires `landed` the instant it is
    // armed. A truly-merged lane awaiting teardown still carries this evidence (its
    // work is done), so the guard does NOT regress the merged-not-yet-torn-down
    // window.
    if (!laneCarriesLandedWork) {
      return false;
    }
    const localDefault = await resolveLocalDefault(repoDir);
    if (localDefault === null) {
      return false; // unresolvable default → NOT merged
    }
    // `gitIsAncestorOf`→`false` covers not-ancestor AND an errored/timed-out probe.
    return gitIsAncestorOf(repoDir, laneBranch, localDefault, run);
  };

  const out: LaneMergedEntry[] = [];
  for (const epic of epics) {
    const resolution = worktreeRepoByEpicId.get(epic.epic_id);
    // A whole-epic serial fallback lands directly on the shared default checkout.
    // Only its explicit `disabled` classification plus the epic's absorbing done
    // state proves that path complete; task phases or a missing classification do
    // not. This arm must remain before every git-touching lane path.
    if (resolution?.kind === "disabled") {
      if (epic.status === "done") {
        out.push({ epic_id: epic.epic_id, repo_dir: resolution.repoDir });
      }
      continue;
    }
    if (
      resolution === undefined ||
      (resolution.kind !== "ok" && resolution.kind !== "clustered")
    ) {
      continue;
    }
    const laneBranch = baseBranchFor(epic.epic_id);
    // Whether the epic ever started — necessary-but-not-sufficient for the absent
    // arm to read merged-and-torn-down (it must ALSO carry landed work; see
    // `laneMergedInRepo`). `status === "done"` is a belt-and-suspenders disjunct
    // (a done epic must have started) so a force-closed epic always counts started.
    const started = epicStarted(epic) || epic.status === "done";
    try {
      if (resolution.kind === "ok") {
        // Shared done-evidence for BOTH the present and absent arms: this epic's
        // work carries landed value only once ALL its tasks are administratively
        // done (`worker_phase` — the terminal-completed signal the clustered
        // serial-group arm keys), OR the epic is force-closed / legacy-imported
        // `status: "done"` (its per-task `worker_phase` is never stamped, so a raw
        // phase-only predicate would permanently false-negative it — mirror
        // readiness's "a done epic is ABSORBING" rule). The present arm's empty-lane
        // guard and the absent arm's torn-down check both key on this: a started-
        // but-unworked epic's lane sits empty at its fork point (present) or was
        // never cut (absent), and neither must false-fire `landed`. A task-less epic
        // is vacuously done (a present + merged lane still reads landed unchanged).
        const tasksDone =
          epic.status === "done" ||
          epic.tasks.every((t) => t.worker_phase === "done");
        if (
          await laneMergedInRepo(
            resolution.repoDir,
            laneBranch,
            started,
            tasksDone,
          )
        ) {
          out.push({ epic_id: epic.epic_id, repo_dir: resolution.repoDir });
        }
        continue;
      }
      // CLUSTERED: aggregate ALL groups before emitting the epic's single row (no
      // early emit on the first group merging). Each group takes the SAME per-group
      // done-evidence the `ok` arm applies epic-wide (`worker_phase`, or the absorbing
      // force-closed `status === "done"` disjunct): a `worktree` group is landed only
      // when its lane merged into its repo's default AND its own tasks are done, a
      // `serial` group when its tasks are done. Passing that evidence as
      // `laneCarriesLandedWork` subjects the worktree arm to the empty-lane guard, so
      // an absent/empty base lane on a started-but-unworked group no longer reads a
      // VACUOUS merge (the absent arm off bare `started`, the present-empty arm off a
      // fork-point ancestor) and false-fires `landed` at epic start. The row's
      // `repo_dir` carries `primaryRepoDir` (observational — the projection keys on
      // epic_id).
      const taskById = new Map(epic.tasks.map((t) => [t.task_id, t]));
      let allLanded = true;
      for (const group of resolution.groups) {
        const groupTasksDone =
          epic.status === "done" ||
          group.taskIds.every(
            (id) => taskById.get(id)?.worker_phase === "done",
          );
        const groupLanded =
          group.mode === "worktree"
            ? await laneMergedInRepo(
                group.repoDir,
                laneBranch,
                started,
                groupTasksDone,
              )
            : groupTasksDone;
        if (!groupLanded) {
          allLanded = false;
          break;
        }
      }
      if (allLanded) {
        out.push({
          epic_id: epic.epic_id,
          repo_dir: resolution.primaryRepoDir,
        });
      }
    } catch (err) {
      // A git probe threw — treat this epic as NOT merged (conservative: never
      // claim merged off an inconclusive probe). The snapshot build never sees it.
      console.error(
        `[autopilot-worker] merge-landed: skipping ${epic.epic_id} — probe threw:`,
        err,
      );
    }
  }
  out.sort(
    (a, b) =>
      a.epic_id.localeCompare(b.epic_id) ||
      a.repo_dir.localeCompare(b.repo_dir),
  );
  return out.filter(
    (entry, index) => index === 0 || out[index - 1]?.epic_id !== entry.epic_id,
  );
}

/**
 * Prove the narrow close-recovery condition from live producer observations.
 * A candidate must still be open, have every task administratively done, have a
 * finished prior closer, and have every lane-cutting repo positively report the
 * still-present epic branch as an ancestor of local default. A missing branch,
 * failed default lookup, ancestry error, or throwing probe yields no fact.
 */
export async function computeCloseRecoveryEligibleIds(
  epics: readonly Epic[],
  jobs: Map<string, Job>,
  livePaneIds: ReadonlySet<string> | null,
  worktreeRepoByEpicId: ReadonlyMap<string, WorktreeRepoResolution>,
  run: WorktreeGitRunner = gitExec,
): Promise<Set<string>> {
  const eligible = new Set<string>();
  const defaultBranchByRepo = new Map<string, string | null>();
  const localDefault = async (repoDir: string): Promise<string | null> => {
    if (defaultBranchByRepo.has(repoDir)) {
      return defaultBranchByRepo.get(repoDir) ?? null;
    }
    let branch: string | null;
    try {
      branch = await gitResolveDefaultBranch(repoDir, run);
    } catch {
      branch = null;
    }
    defaultBranchByRepo.set(repoDir, branch);
    return branch;
  };

  for (const epic of epics) {
    if (
      epic.status === "done" ||
      !epic.tasks.every((task) => task.worker_phase === "done") ||
      !closerJobFinished(jobs, epic.epic_id, livePaneIds)
    ) {
      continue;
    }
    const resolution = worktreeRepoByEpicId.get(epic.epic_id);
    if (resolution === undefined) {
      continue;
    }
    const repos = worktreeLaneRepoDirs(resolution);
    if (repos.length === 0) {
      continue;
    }
    const lane = baseBranchFor(epic.epic_id);
    let allMerged = true;
    try {
      for (const repoDir of repos) {
        const defaultBranch = await localDefault(repoDir);
        if (
          defaultBranch === null ||
          !(await gitIsAncestorOf(repoDir, lane, defaultBranch, run))
        ) {
          allMerged = false;
          break;
        }
      }
    } catch {
      allMerged = false;
    }
    if (allMerged) {
      eligible.add(epic.epic_id);
    }
  }
  return eligible;
}

/** Defaults until durable autopilot config supplies these producer inputs. */
export const DEFAULT_BASE_DRIFT_THRESHOLDS = {
  behindCount: 15,
  mergeBaseAgeSeconds: 24 * 60 * 60,
} as const;

export interface BaseDriftThresholds {
  behindCount: number;
  mergeBaseAgeSeconds: number;
}

/** Injectable producer inputs so durable config can replace only the values. */
export interface BaseDriftProbeOptions {
  thresholds?: Readonly<BaseDriftThresholds>;
  nowSeconds?: number;
}

/**
 * Compute the bases that have genuinely drifted from their local default branch.
 * A lane must be both sufficiently behind and old enough: a fresh/empty lane at
 * its fork point has zero behind commits, so the ancestry-vacuity case cannot
 * manufacture a drift entry. Any inconclusive measurement defers to no entry.
 */
export async function computeBaseDriftEntries(
  epics: readonly Epic[],
  worktreeRepoByEpicId: ReadonlyMap<string, WorktreeRepoResolution>,
  run: WorktreeGitRunner = gitExec,
  options: BaseDriftProbeOptions = {},
): Promise<BaseDriftEntry[]> {
  const supplied = options.thresholds;
  const thresholds: BaseDriftThresholds = {
    behindCount:
      supplied !== undefined &&
      Number.isFinite(supplied.behindCount) &&
      supplied.behindCount >= 0
        ? supplied.behindCount
        : DEFAULT_BASE_DRIFT_THRESHOLDS.behindCount,
    mergeBaseAgeSeconds:
      supplied !== undefined &&
      Number.isFinite(supplied.mergeBaseAgeSeconds) &&
      supplied.mergeBaseAgeSeconds >= 0
        ? supplied.mergeBaseAgeSeconds
        : DEFAULT_BASE_DRIFT_THRESHOLDS.mergeBaseAgeSeconds,
  };
  const nowSeconds =
    options.nowSeconds !== undefined && Number.isFinite(options.nowSeconds)
      ? options.nowSeconds
      : Math.floor(Date.now() / 1000);

  // Every lane in one repo shares its local default; resolve it at most once.
  const defaultBranchByRepo = new Map<string, string | null>();
  const resolveLocalDefault = async (
    repoDir: string,
  ): Promise<string | null> => {
    const hit = defaultBranchByRepo.get(repoDir);
    if (hit !== undefined) return hit;
    let branch: string | null;
    try {
      branch = await gitResolveDefaultBranch(repoDir, run);
    } catch {
      branch = null;
    }
    defaultBranchByRepo.set(repoDir, branch);
    return branch;
  };

  const out: BaseDriftEntry[] = [];
  for (const epic of epics) {
    const resolution = worktreeRepoByEpicId.get(epic.epic_id);
    if (resolution === undefined) continue;
    const laneRepos = worktreeLaneRepoDirs(resolution);
    const base = baseBranchFor(epic.epic_id);
    for (const repoDir of laneRepos) {
      try {
        const defaultBranch = await resolveLocalDefault(repoDir);
        if (defaultBranch === null) continue;
        const measurement = await gitMeasureBaseDrift(
          repoDir,
          base,
          defaultBranch,
          run,
        );
        if (measurement.kind !== "measured") continue;
        const mergeBaseAgeSeconds = Math.max(
          0,
          nowSeconds - measurement.mergeBaseEpochSeconds,
        );
        if (
          measurement.behindCount >= thresholds.behindCount &&
          mergeBaseAgeSeconds >= thresholds.mergeBaseAgeSeconds
        ) {
          out.push({
            epic_id: epic.epic_id,
            repo_dir: repoDir,
            behind_count: measurement.behindCount,
            merge_base_age_seconds: mergeBaseAgeSeconds,
          });
        }
      } catch {
        // A producer probe is advisory; defer this lane rather than fail a cycle.
      }
    }
  }
  out.sort((a, b) =>
    a.epic_id === b.epic_id
      ? a.repo_dir.localeCompare(b.repo_dir)
      : a.epic_id.localeCompare(b.epic_id),
  );
  return out;
}

/**
 * Compute the EPHEMERAL STALE-BASE lane set (fn-1127): every epic whose ALREADY-CUT
 * worktree lane `keeper/epic/<id>` was forked off a base DEFINITIVELY MISSING a
 * satisfied same-resolved-repo upstream's landed work. The merge-gate ({@link
 * computeDeferredEpicIds}) only DEFERS a cut; by construction it can never see a lane
 * ALREADY cut stale (a race, a lane that predates the upstream's landing), so its
 * workers hit DEPENDENCY_BLOCKED with nothing on the board naming the cause. This
 * producer probe — a SIBLING to the merge-gate probes, NEVER modifying them — surfaces
 * it. Producer-side + git-touching, probed ONCE per cycle in {@link
 * loadReconcileSnapshot} (gated on {@link worktreeMode}); read back by the stale-base
 * grace tracker as plain {@link ReconcileSnapshot.staleBaseLaneEntries} data. NEVER a
 * fold input; mints NO `dispatch_failures` row itself (the tracker escalates it).
 * DETECTION + LOUD SURFACING ONLY — never auto-remediation, never touching the
 * cut-deferral, never enriching the worker-authored DEPENDENCY_BLOCKED prose.
 *
 * Per epic B with a PRESENT lane in `repoR`, walk its DIRECT satisfied same-resolved-
 * repo upstreams A and verdict whether A's landed work is present in B's base. THE REF
 * TEST IS THE DESIGN CORE, chosen deliberately AGAINST the {@link
 * computeMergedLaneEntries} vacuous-ancestor precedent: `isAncestorOf(A_lane, B_base)`
 * puts A's lane as the maybeANCESTOR and B's base as the ref. A freshly-cut / empty
 * lane is a vacuous ancestor of everything DOWNSTREAM of its fork, so this direction
 * resolves the vacuous case to `ancestor` → NOT stale (the SAFE outcome — an empty A
 * contributes nothing) rather than a false stale; the INVERSE direction
 * (`isAncestorOf(B_base, A_lane)`) would vacuously pass a fresh B and MISS a real
 * stale. Only a DEFINITIVE not-ancestor (git exit 1 — A's real commits are absent from
 * B's base) flags stale. Every inconclusive arm DEFERS to no-flag (a false distress is
 * worse than a late one):
 *  - enumeration FAILED / timed out → no flag (never read as "the lane is absent");
 *  - B's lane DEFINITIVELY ABSENT (a successful enumeration that omits it) → torn-down
 *    / serial B, no stale base to surface → skip;
 *  - upstream A's lane DEFINITIVELY ABSENT → merged-and-torn-down (its ref is gone, so
 *    the ancestry test is unrunnable) → inconclusive → skip this upstream;
 *  - ancestry TIMEOUT (124) / ambiguous-ref error (128) → inconclusive → skip;
 *  - a thrown git probe degrades THAT (epic, repo) to no-flag; NEVER throws out of the
 *    snapshot build.
 * UNION over upstreams: B's `repoR` lane is flagged stale IFF ANY direct satisfied
 * same-repo upstream is DEFINITIVELY missing. A dangling / null / cross-repo / non-lane
 * / reaped / disabled / serial upstream folds to skip (mirroring {@link
 * computeDeferredEpicIds}). The per-repo lane-enumeration is memoized so N epics
 * sharing one repo enumerate once; A's toplevel reuses the classification map.
 */
export async function computeStaleBaseLaneEntries(
  epics: readonly Epic[],
  worktreeRepoByEpicId: ReadonlyMap<string, WorktreeRepoResolution>,
  run: WorktreeGitRunner = gitExec,
): Promise<StaleBaseLaneEntry[]> {
  // Per-repo lane-enumeration memo — N same-repo epics enumerate ONCE. A throwing
  // probe degrades to `{ ok: false }` (→ no flag for this repo), never out of build.
  const laneSetByRepo = new Map<string, EpicLaneBranchSet>();
  const enumerateLanes = async (
    repoDir: string,
  ): Promise<EpicLaneBranchSet> => {
    const hit = laneSetByRepo.get(repoDir);
    if (hit !== undefined) {
      return hit;
    }
    let value: EpicLaneBranchSet;
    try {
      value = await gitEnumerateEpicLaneBranches(repoDir, run);
    } catch {
      value = { ok: false }; // enumeration error → no flag for this repo's epics
    }
    laneSetByRepo.set(repoDir, value);
    return value;
  };

  // TRI-STATE containment probe: is `maybeAncestor` DEFINITIVELY contained in `ref`?
  //  - exit 0 → `contained` (A's landed work is in B's base → NOT stale);
  //  - exit 1 → `missing` (A's real commits are DEFINITIVELY absent → STALE);
  //  - any other exit (124 timeout / 128 ambiguous ref / spawn fail / throw) →
  //    `inconclusive` → DEFER to no-flag. The boolean {@link gitIsAncestorOf} collapses
  //    exit-1 and timeout to the same `false`, which would turn an inconclusive probe
  //    into a false stale — so the flag arm needs this three-way distinction directly.
  const containment = async (
    cwd: string,
    maybeAncestor: string,
    ref: string,
  ): Promise<"contained" | "missing" | "inconclusive"> => {
    let code: number;
    try {
      const r = await run(["merge-base", "--is-ancestor", maybeAncestor, ref], {
        cwd,
        timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      });
      code = r.code;
    } catch {
      return "inconclusive";
    }
    if (code === 0) {
      return "contained";
    }
    if (code === 1) {
      return "missing";
    }
    return "inconclusive";
  };

  const out: StaleBaseLaneEntry[] = [];
  for (const epic of epics) {
    const resolution = worktreeRepoByEpicId.get(epic.epic_id);
    if (resolution === undefined) {
      continue;
    }
    // The repos where B cuts a WORKTREE lane forked off a base — the only lanes a
    // stale base can afflict. A serial / multi-repo / unresolved / reject cuts none.
    const laneRepos = worktreeLaneRepoDirs(resolution);
    if (laneRepos.length === 0) {
      continue;
    }
    const deps = epic.resolved_epic_deps;
    if (deps === null) {
      continue;
    }
    const bBase = baseBranchFor(epic.epic_id);
    for (const repoR of laneRepos) {
      try {
        const lanes = await enumerateLanes(repoR);
        if (!lanes.ok) {
          continue; // enumeration inconclusive → never claim stale off a failed probe
        }
        // B's OWN lane must be PRESENT to be stale: a torn-down / never-cut base
        // carries no stale workers to surface. (A definitive absence, distinct from a
        // failed enumeration handled above.)
        if (!lanes.branches.has(bBase)) {
          continue;
        }
        let stale = false;
        for (const dep of deps) {
          // Only a SATISFIED (landed) upstream can leave a stale base — the bug is
          // "cut before the upstream LANDED". A blocked-incomplete / dangling dep is
          // the readiness gate's / merge-gate's concern, never a stale-base source.
          if (dep.state !== "satisfied") {
            continue;
          }
          const upstreamId = dep.resolved_epic_id;
          if (upstreamId === null) {
            continue; // dangling/ambiguous — skip (mirrors computeDeferredEpicIds)
          }
          const upstreamRes = worktreeRepoByEpicId.get(upstreamId);
          // Same-resolved-repo gate: A must have cut a WORKTREE lane in B's exact
          // `repoR` (decided by the RESOLVED toplevel, NEVER `dep.cross_project`). A
          // reaped / non-lane / serial / cross-repo upstream never affects B's base.
          if (
            upstreamRes === undefined ||
            !hasWorktreeLaneInRepo(upstreamRes, repoR)
          ) {
            continue;
          }
          const aLane = baseBranchFor(upstreamId);
          if (!lanes.branches.has(aLane)) {
            // A's lane is DEFINITIVELY absent (merged-and-torn-down): its ref is gone,
            // so `isAncestorOf(A_lane, B_base)` is unrunnable → inconclusive → skip
            // this upstream (never flag off an absent ref — an ambiguous-ref defer).
            continue;
          }
          const verdict = await containment(repoR, aLane, bBase);
          if (verdict === "missing") {
            // A's real landed commits are DEFINITIVELY absent from B's base → the lane
            // was cut off a stale base. UNION: one missing upstream flags the lane.
            console.error(
              `[autopilot-worker] stale-base probe: flagging ${epic.epic_id}@${repoR} — lane base (${bBase}) is missing landed upstream ${upstreamId} (${aLane})`,
            );
            stale = true;
            break;
          }
          // `contained` (A in B's base) or `inconclusive` (timeout/ambiguous) → this
          // upstream contributes no flag; a sibling upstream may still flag.
        }
        if (stale) {
          out.push({ epic_id: epic.epic_id, repo_dir: repoR });
        }
      } catch (err) {
        // A git probe threw — NO flag for this (epic, repo) (a false distress is worse
        // than a late one). The snapshot build never sees the throw.
        console.error(
          `[autopilot-worker] stale-base probe: skipping ${epic.epic_id}@${repoR} — probe threw:`,
          err,
        );
      }
    }
  }
  out.sort((a, b) =>
    a.epic_id === b.epic_id
      ? a.repo_dir.localeCompare(b.repo_dir)
      : a.epic_id.localeCompare(b.epic_id),
  );
  return out;
}

/** Classify ONE epic's repos — see {@link classifyWorktreeRepos}. */
function classifyEpicRepo(
  epic: Epic,
  resolve: (root: string) => string | null,
  assessRepo: (toplevel: string) => WorktreeEligibility,
  laneProbe: (epicId: string, repoDir: string) => LaneProbeResult,
  multiRepoEnabled: boolean,
): WorktreeRepoResolution {
  const projectDir = epic.project_dir ?? "";
  // The required RAW roots: each task's effective root (`target_repo` when set,
  // else the epic `project_dir`). An epic with no tasks still has a close lane, so
  // resolve its own `project_dir`. Capture the per-task RESOLVED toplevel too so a
  // clustered epic can partition tasks by toplevel WITHOUT re-resolving.
  const rawByTask: Array<{ taskId: string; raw: string }> =
    epic.tasks.length > 0
      ? epic.tasks.map((t) => ({
          taskId: t.task_id,
          raw:
            t.target_repo != null && t.target_repo !== ""
              ? t.target_repo
              : projectDir,
        }))
      : [{ taskId: "", raw: projectDir }];
  const resolved = new Set<string>();
  const topByTask: Array<{ taskId: string; top: string }> = [];
  for (const { taskId, raw } of rawByTask) {
    // Short-circuit empties BEFORE the resolver (a `git -C ""` resolves against the
    // daemon's own cwd; the nullable resolver guards this too, belt-and-suspenders).
    if (raw === "") {
      return {
        kind: "unresolved",
        reason: `worktree-repo-unresolved: epic ${epic.epic_id} has a task with no repo root (no target_repo and no project_dir)`,
      };
    }
    const top = resolve(raw);
    if (top === null) {
      return {
        kind: "unresolved",
        reason: `worktree-repo-unresolved: epic ${epic.epic_id} root ${raw} is not inside a git worktree`,
      };
    }
    resolved.add(top);
    if (taskId !== "") {
      topByTask.push({ taskId, top });
    }
  }
  // >1 distinct toplevel with the rollout flag OFF → the whole-epic reject. The
  // reason names the spanned toplevels (sorted) AND the flag+command that unjams
  // it, since a healthy multi-repo epic is otherwise indistinguishable from an
  // unresolved-root failure. Flag ON drops through to the clustered partition
  // below.
  if (resolved.size > 1 && !multiRepoEnabled) {
    return {
      kind: "multi-repo",
      reason: `worktree-multi-repo: epic ${epic.epic_id} spans ${resolved.size} repos (${[...resolved].sort().join(", ")}); worktree mode rejects a multi-repo epic while worktree_multi_repo is off. Cluster it into per-repo lane groups with \`keeper autopilot config worktree_multi_repo on\``,
    };
  }
  if (resolved.size > 1) {
    // Flag ON, multi-toplevel epic → CLUSTERED. Precedence is preserved: the
    // `unresolved` short-circuit already fired above; `no-primary-repo` is still a
    // WHOLE-EPIC reject (a lane on ANY group would let plan state degrade to a lane
    // checkout, since the single plan-close writes to `primary_repo`). Only once
    // every root resolved and a primary_repo exists do we partition.
    if (projectDir === "") {
      return {
        kind: "no-primary-repo",
        reason: `worktree-no-primary-repo: epic ${epic.epic_id} has no primary_repo — refusing to provision a lane (plan state would degrade to the lane checkout; set epic.primary_repo and retry)`,
      };
    }
    return clusterEpicRepos(
      epic,
      resolve,
      assessRepo,
      laneProbe,
      projectDir,
      topByTask,
    );
  }
  // Exactly one toplevel — `rawByTask` is always non-empty and every element either
  // returned early or added to `resolved`, so `resolved.size === 1` here. The guard
  // keeps the type checker honest for the empty-iterator case it cannot prove away.
  const repoDir = [...resolved][0];
  if (repoDir === undefined) {
    return {
      kind: "unresolved",
      reason: `worktree-repo-unresolved: epic ${epic.epic_id} resolved no repo root`,
    };
  }
  // One resolved toplevel is necessary but not sufficient. The central plan-state
  // resolver roots `done`/`claim`/close state at `epic.primary_repo` (mirrored
  // onto `project_dir`); a null/empty value degrades it to the locate dir — from a
  // lane cwd that IS the lane — so state lands on the lane branch, `isEpicDone`
  // never flips, and `finalizeEpic` defers forever (a silent worktree deadlock).
  // Reject LOUD before any lane is provisioned, keyed OUTSIDE the
  // `worktree-recover` auto-clear prefix (a missing primary_repo is an operator
  // epic-def fix, not a transient).
  if (projectDir === "") {
    return {
      kind: "no-primary-repo",
      reason: `worktree-no-primary-repo: epic ${epic.epic_id} has no primary_repo — refusing to provision a lane (plan state would degrade to the lane checkout; set epic.primary_repo and retry)`,
    };
  }
  // A would-be-`ok` (worktree-LANE) epic whose ONE task toplevel is NOT the resolved
  // primary would anchor its close to that FOREIGN task repo's base lane — where the
  // epic's plan state does not exist — dying EPIC_NOT_FOUND at preflight (the
  // single-repo sibling of the clustered close-anchor bug). Resolve the primary FIRST
  // and fail CLOSED on both anchor hazards before any `ok` return:
  //  - primary_repo does not resolve to a git toplevel → typed `unresolved` reject;
  //    NEVER anchor the close to the task repo on a guess. (`primaryResolved` is null
  //    here only when EVERY task carries a foreign `target_repo`, so a genuinely
  //    single-repo epic — a task root == primary — already resolved it in the loop.)
  //  - primary_repo resolves to a DIFFERENT toplevel (foreign primary): with the
  //    multi-repo flag ON, reroute through the clustered path so the primary becomes
  //    a task-less serial close-sink anchor (the close runs on the primary shared
  //    checkout) while the foreign task repo keeps its worktree lane + finalize;
  //    with the flag OFF, REJECT with the enable-flag sticky (the same class the
  //    >1-toplevel flag-OFF path mints) — never knowingly dispatch a closer into
  //    EPIC_NOT_FOUND. A `disabled` foreign repo already runs its close on
  //    `project_dir` (primary) worktree-less, so its `disabled` return below is
  //    untouched; only a would-be-`ok` repo reroutes/rejects.
  const primaryResolved = resolve(projectDir);
  if (primaryResolved === null) {
    return {
      kind: "unresolved",
      reason: `worktree-repo-unresolved: epic ${epic.epic_id} primary_repo ${projectDir} is not inside a git worktree — refusing to anchor the close on a guess`,
    };
  }
  const foreignPrimary = primaryResolved !== repoDir;
  const okOrForeignAnchor = (freshEpoch: boolean): WorktreeRepoResolution => {
    if (!foreignPrimary) {
      // A FRESH epoch (torn-down base + ref) re-cuts the single-repo lane over its
      // NON-DONE tasks only; `freshEpoch` rides the `ok` resolution so the derivation
      // excludes already-finalized tasks (whose branches are gone) instead of forking
      // a new task off a missing ref.
      return freshEpoch
        ? { kind: "ok", repoDir, freshEpoch: true }
        : { kind: "ok", repoDir };
    }
    if (multiRepoEnabled) {
      return clusterEpicRepos(
        epic,
        resolve,
        assessRepo,
        laneProbe,
        projectDir,
        topByTask,
      );
    }
    return {
      kind: "multi-repo",
      reason: `worktree-multi-repo: epic ${epic.epic_id} tasks resolve to ${repoDir} but its primary_repo resolves to ${primaryResolved} — a foreign-primary epic needs per-repo lane groups so the single close anchors to primary_repo. Enable with \`keeper autopilot config worktree_multi_repo on\``,
    };
  };
  // A would-be-`ok` epic resolving to ONE primary-backed toplevel: the LAST gate
  // is repo eligibility. A not-worktree-friendly toplevel (workspace marker /
  // submodule / no manifest / probe error) downgrades to `disabled` — a NORMAL,
  // NON-error sequential-on-shared-checkout fallback, never a sticky reject. Only
  // ever downgrades `ok`; the loud rejects above already returned.
  const eligibility = assessRepo(repoDir);
  // A fresh-epoch re-cut is a TRUE reopen ONLY: at least one DONE task (the epoch
  // that finalized + tore its base down) AND at least one NON-DONE task (the newly
  // added work the fresh plan is cut for). An ALL-DONE positively-absent epic must
  // NOT mint an empty fresh plan (which would re-provision an empty base merely to
  // finalize + tear it down again), and a brand-new ALL-TODO epic derives identically
  // fresh or full — so an ELIGIBLE non-reopen epic skips the lane probe entirely (no
  // git/db read for every pending epic every cycle). A `disabled` epic still probes
  // unconditionally — the grandfather decides its very mode.
  const hasDoneTask = epic.tasks.some((t) => t.worker_phase === "done");
  const hasNonDoneTask = epic.tasks.some((t) => t.worker_phase !== "done");
  // The SINGLE true-reopen predicate BOTH single-repo fresh-epoch arms (eligible AND
  // no-manifest re-cut) share, so they cannot drift: a fresh epoch is minted ONLY
  // when a done task (the finalized epoch) AND a non-done task (the newly added work)
  // coexist. It gates the eligible re-cut AND the no-manifest re-cut identically.
  const trueReopen = hasDoneTask && hasNonDoneTask;
  if (eligibility.eligible) {
    const freshEpoch =
      trueReopen && laneProbe(epic.epic_id, repoDir).epoch === "absent";
    return okOrForeignAnchor(freshEpoch);
  }
  const lane = laneProbe(epic.epic_id, repoDir);
  // GRANDFATHER: a live lane epoch (`present`) keeps a `disabled` repo on worktree —
  // flipping it mid-flight would strand work on its `~/worktrees` lanes and lose the
  // merge-to-default finalize. `present` is the ONLY grandfather; an `inconclusive`
  // probe (ref timeout/error, dir absent) is NOT-present → serial, byte-identical to
  // the prior fail-closed `localBranchExists` — never a spurious worktree promotion.
  if (lane.epoch === "present") {
    return okOrForeignAnchor(false);
  }
  // NO-MANIFEST RE-CUT: a torn-down (positively-absent) epoch with a restart-safe,
  // repo-bound prior-lane proof bootstraps a FRESH worktree epoch — but ONLY for a
  // TRUE reopen (a done AND a non-done task) on the EXACT `no-manifest` disable
  // (equality, never a fragile `.includes`). An ALL-DONE no-manifest epoch must NOT
  // re-cut (that would filter to zero active tasks yet retain the base/close sink — an
  // empty base re-provisioned only to finalize + tear down). A workspace-marker /
  // submodule / probe-error repo STAYS serial regardless. `trueReopen` AND the reason
  // check BOTH gate BEFORE `.priorLane`, so the lazy proof db read fires only for a
  // no-manifest absent epoch that is genuinely re-openable — never an all-done one.
  if (
    lane.epoch === "absent" &&
    trueReopen &&
    eligibility.reason === NO_MANIFEST_REASON &&
    lane.priorLane
  ) {
    return okOrForeignAnchor(true);
  }
  return { kind: "disabled", repoDir, reason: eligibility.reason };
}

/**
 * Partition a resolved-clean, primary-backed, MULTI-toplevel epic into ordered
 * per-repo lane {@link WorktreeRepoGroup}s (the `clustered` arm). Reached ONLY
 * from {@link classifyEpicRepo} once every root resolved, the rollout flag is ON,
 * and a `primary_repo` exists — so the loud `unresolved` / `no-primary-repo`
 * precedence is already honored.
 *
 * Groups are ordered by first-appearance in `epic.tasks`; each is assessed for
 * worktree-eligibility INDEPENDENTLY (its own `assessRepo` verdict, with the
 * per-(epic, repoDir) grandfather), so one group can be `worktree` while a sibling
 * is `serial`. `primaryRepoDir` is the resolved toplevel of `project_dir` — the
 * anchor for the single plan-close. When the primary hosts no tasks it is absent
 * from the task groups, so it is appended as a TASK-LESS `serial` close-sink group
 * (the close then runs on the primary shared checkout, where the plan state lives,
 * never in a task-group lane). A primary_repo that fails to resolve FAILS CLOSED with
 * a typed `unresolved` reject — never an arbitrary `groups[0]` guess. Pure: no fs/git
 * beyond the injected `resolve` / `assessRepo` / grandfather probes (all memoized
 * producer-side).
 */
function clusterEpicRepos(
  epic: Epic,
  resolve: (root: string) => string | null,
  assessRepo: (toplevel: string) => WorktreeEligibility,
  laneProbe: (epicId: string, repoDir: string) => LaneProbeResult,
  projectDir: string,
  topByTask: ReadonlyArray<{ taskId: string; top: string }>,
): WorktreeRepoResolution {
  // Partition task ids by resolved toplevel, preserving first-appearance order.
  const taskIdsByRepo = new Map<string, string[]>();
  const order: string[] = [];
  for (const { taskId, top } of topByTask) {
    let bucket = taskIdsByRepo.get(top);
    if (bucket === undefined) {
      bucket = [];
      taskIdsByRepo.set(top, bucket);
      order.push(top);
    }
    bucket.push(taskId);
  }
  const donePhaseById = new Map(
    epic.tasks.map((t) => [t.task_id, t.worker_phase === "done"]),
  );
  const groups: WorktreeRepoGroup[] = order.map((repoDir) => {
    // Per-group worktree-eligibility, mirroring the single-repo arm: an eligible repo
    // is `worktree`; a `disabled` repo grandfathers to `worktree` on a live (`present`)
    // lane epoch; a `no-manifest` `disabled` repo with a POSITIVELY-absent epoch AND a
    // restart-safe repo-bound prior-lane proof re-cuts a fresh worktree epoch; else
    // `serial`. An `inconclusive` epoch never re-cuts (it grandfathers only if a live
    // dir/ref already makes it `present`).
    const eligibility = assessRepo(repoDir);
    const groupTaskIds = taskIdsByRepo.get(repoDir) ?? [];
    const groupHasDone = groupTaskIds.some(
      (id) => donePhaseById.get(id) === true,
    );
    const groupHasNonDone = groupTaskIds.some(
      (id) => donePhaseById.get(id) === false,
    );
    // A TRUE reopen candidate has BOTH a done task (the finalized epoch) and a
    // non-done task (the newly added work) — the only case a fresh epoch re-cut can
    // matter. An ELIGIBLE non-candidate group derives identically fresh or full, so
    // it skips the lane probe (no git/db read per pending group per cycle); a
    // `disabled` group probes unconditionally — the grandfather decides its very mode.
    const groupReopenCandidate = groupHasDone && groupHasNonDone;
    const lane =
      eligibility.eligible && !groupReopenCandidate
        ? ({ epoch: "inconclusive", priorLane: false } as LaneProbeResult)
        : laneProbe(epic.epic_id, repoDir);
    // The no-manifest re-cut keys on EXACT reason equality (never `.includes`), and
    // the reason check gates BEFORE `.priorLane` so the lazy proof db read fires only
    // for a no-manifest absent group, never an unsafe one on the re-cut path.
    const worktree =
      eligibility.eligible ||
      lane.epoch === "present" ||
      (lane.epoch === "absent" &&
        eligibility.reason === NO_MANIFEST_REASON &&
        lane.priorLane);
    const group: WorktreeRepoGroup = {
      repoDir,
      taskIds: groupTaskIds,
      mode: worktree ? "worktree" : "serial",
    };
    // A worktree group whose base epoch is positively ABSENT (torn down) re-cuts a
    // FRESH epoch over its NON-DONE tasks only — but ONLY a TRUE reopen (a done AND a
    // non-done task). An all-done absent group must NOT mint an empty fresh plan (it
    // would re-provision an empty base merely to finalize + tear it down again);
    // `present` / `inconclusive` → full graph.
    if (worktree && lane.epoch === "absent" && groupReopenCandidate) {
      group.freshEpoch = true;
    }
    // A SERIAL group that positively RAN a worktree lane here before (absent epoch +
    // restart-safe prior-lane proof) and GAINED a task, yet cannot re-cut because the
    // repo is an UNSAFE dep-tree hazard (a `no-manifest` group with proof already
    // re-cut to worktree above; an eligible group is never serial) → an intentional
    // reopened-serial degrade. Stamped from ACTUAL state (absent + proof + gained
    // task), NOT a done+pending heuristic, so it surfaces on the live worktree-status
    // projection rather than a console latch.
    if (
      !worktree &&
      lane.epoch === "absent" &&
      groupHasNonDone &&
      lane.priorLane
    ) {
      group.reopenDegrade = `worktree-reopen-serial: ${repoDir} ran a worktree lane before but re-cuts serial on the shared checkout — ${eligibility.reason}`;
    }
    return group;
  });
  // The PRIMARY group hosts the single plan-close, which reads the epic's plan
  // state from `primary_repo` (mirrored onto `project_dir`). When the primary
  // hosts tasks it is ALREADY one of the task groups above. When it hosts NONE —
  // every task carries an explicit non-primary `target_repo` — it is absent from
  // the task-derived groups, so ANCHOR it explicitly as a TASK-LESS `serial`
  // close-sink group. A serial group runs the close worktree-less on the primary
  // shared checkout (`project_dir`, where the live plan state lives), never in a
  // task-group lane whose `.keeper` is stale/absent (a closer booted there dies
  // EPIC_NOT_FOUND at preflight). The task groups' own lanes/finalize are
  // untouched — only the close anchor moves. The primary base carries no task
  // work, so a lane there would be an empty branch to provision + tear down for
  // nothing; the shared-checkout close is the existing serial-primary contract.
  const primaryResolved = resolve(projectDir);
  // FAIL CLOSED when primary_repo does not resolve to a git toplevel: the close must
  // anchor to primary_repo, so an unresolvable primary has no real repo to anchor to.
  // Reject typed `unresolved` — NEVER guess `groups[0]` (an arbitrary task repo where
  // the epic's plan state does not exist → a closer dying EPIC_NOT_FOUND).
  if (primaryResolved === null) {
    return {
      kind: "unresolved",
      reason: `worktree-repo-unresolved: epic ${epic.epic_id} primary_repo ${projectDir} is not inside a git worktree — refusing to anchor the close on a guess`,
    };
  }
  if (!groups.some((g) => g.repoDir === primaryResolved)) {
    groups.push({ repoDir: primaryResolved, taskIds: [], mode: "serial" });
  }
  return { kind: "clustered", groups, primaryRepoDir: primaryResolved };
}

/**
 * PRODUCER: the per-(epic, repoDir) LANE PROBE threaded into
 * {@link classifyWorktreeRepos}. Its TRI-STATE base-lane epoch (never conflating a
 * timeout/error with positive absence — an inconclusive probe defers to the full
 * graph + prior mode, NEVER a fresh epoch) decides both the `disabled` grandfather
 * and the re-cut derivation:
 *  - PRESENT — the base worktree dir OR the `keeper/epic/<id>` ref exists (a live
 *    lane epoch): a `disabled` verdict is GRANDFATHERED to `worktree`, derived over
 *    the FULL DAG (a mid-flight marker change / transient probe error never strands
 *    the live `~/worktrees` lanes or loses the merge-to-default finalize).
 *  - ABSENT — base dir absent AND the ref DEFINITIVELY gone (`rev-parse` exit 1): a
 *    torn-down epoch. A worktree group re-cuts a FRESH epoch over its NON-DONE tasks
 *    only (deps on already-done tasks collapse to a fresh base cut from current
 *    default). Additionally reads {@link readPriorWorktreeLaneProof} so a serial
 *    `no-manifest` group may re-cut ONLY when a restart-safe repo-bound worktree lane
 *    is PROVEN.
 *  - INCONCLUSIVE — a probe timeout/error: retains the full graph + prior mode.
 * Producer-only (fs + git + a bounded db read), NEVER read inside the pure classify
 * layer or a fold.
 */
export type LaneEpochState = "present" | "absent" | "inconclusive";
export interface LaneProbeResult {
  epoch: LaneEpochState;
  /** Only meaningful when `epoch === "absent"`: a restart-safe repo-bound proof that
   *  a prior worktree lane ran here (gates the `no-manifest` fresh-epoch re-cut). */
  priorLane: boolean;
}

function worktreeEpicLaneProbe(
  db: Parameters<typeof runQuery>[0],
  epicId: string,
  repoDir: string,
  candidatePlanRefs: readonly string[],
): LaneProbeResult {
  const baseBranch = baseBranchFor(epicId);
  if (existsSync(worktreePathFor(repoDir, baseBranch))) {
    return { epoch: "present", priorLane: false };
  }
  const refState = localBranchState(repoDir, baseBranch);
  if (refState === "present") {
    return { epoch: "present", priorLane: false };
  }
  if (refState === "inconclusive") {
    return { epoch: "inconclusive", priorLane: false };
  }
  // Positively absent (dir absent + ref exit-1). The prior-lane proof is read LAZILY
  // through a memoized getter: ONLY the disabled `no-manifest` re-cut arm and the
  // reopened-serial degrade actually read `.priorLane`, so an eligible-absent group
  // (which re-cuts regardless) and a present/inconclusive epoch NEVER fire the bounded
  // db read. Memoized so the clustered arm's up-to-two reads hit the db at most once.
  let proofCache: boolean | undefined;
  return {
    epoch: "absent",
    get priorLane(): boolean {
      if (proofCache === undefined) {
        proofCache = readPriorWorktreeLaneProof(
          db,
          epicId,
          repoDir,
          candidatePlanRefs,
        );
      }
      return proofCache;
    },
  };
}

/**
 * PRODUCER read: a RESTART-SAFE, repo-bound, epic-bound proof that a prior worktree
 * lane ran for `epicId` in `repoDir`. Reads the durable `worktree` lane marker of
 * TERMINAL (ended / killed) jobs — the default `jobs` collection hides terminal rows,
 * so a direct query is required, and the marker survives a daemon restart (unlike an
 * in-memory latch).
 *
 * SELECTIVE SEAM: `plan_ref IN (candidatePlanRefs)` (the epic's own id + task ids)
 * routes through the partial `idx_jobs_plan_ref`, so the read seeks the epic's OWN
 * jobs (a board-bounded handful) — never the unbounded `created_at DESC` walk-to-EOF
 * the old `idx_jobs_created_state` scan suffered on a no-match.
 *
 * EPIC-OR-RIB BOUNDARY (the `cwd` / `worktree` predicates bind the repo AND re-confirm
 * the epic, so a MOVED repo — a different dir → a different {@link repoToken} hash →
 * a different lane path — can never inherit another repo's history, and a prefix
 * NEIGHBOR epic can never cross-match):
 *  - `cwd = <laneBase>` OR `cwd LIKE <laneBase>--% ` — the exact base lane OR any rib
 *    lane (`<laneBase>--<task>`), the `--` boundary keeping `fn-1` off `fn-10`.
 *  - `worktree = keeper/epic/<id>` OR `worktree LIKE keeper/epic/<id>--% ` —
 *    corroborates the durable branch marker (a SERIAL job carries a NULL worktree +
 *    a shared-checkout cwd, so it never counts).
 * A PRODUCER read; never a fold. Exported for the query-shape tests.
 */
export function readPriorWorktreeLaneProof(
  db: Parameters<typeof runQuery>[0],
  epicId: string,
  repoDir: string,
  candidatePlanRefs: readonly string[],
): boolean {
  if (candidatePlanRefs.length === 0) return false;
  const baseBranch = baseBranchFor(epicId);
  const laneBase = worktreePathFor(repoDir, baseBranch);
  const escapeLike = (s: string): string => s.replace(/[\\%_]/g, "\\$&");
  // The rib lane path / rib branch both extend the base with a literal `--` boundary
  // ({@link ribBranchFor} / {@link worktreePathFor}), so the boundary-anchored LIKE
  // excludes a prefix-neighbor epic (`fn-10`'s `...keeper-epic-fn-10` never matches
  // `...keeper-epic-fn-1--%`).
  const cwdRib = `${escapeLike(laneBase)}--%`;
  const worktreeRib = `${escapeLike(baseBranch)}--%`;
  const placeholders = candidatePlanRefs.map(() => "?").join(", ");
  const row = db
    .query(
      `SELECT 1 FROM jobs
         WHERE plan_ref IN (${placeholders})
           AND state IN ('ended', 'killed')
           AND worktree IS NOT NULL
           AND (worktree = ? OR worktree LIKE ? ESCAPE '\\')
           AND (cwd = ? OR cwd LIKE ? ESCAPE '\\')
         LIMIT 1`,
    )
    .get(...candidatePlanRefs, baseBranch, worktreeRib, laneBase, cwdRib);
  return row != null;
}

/**
 * PRODUCER read-side {@link ClaimAcquireObservation} loader — the concrete query
 * behind {@link ConfirmRunningDeps.observeClaimAcquire}. Reads the reducer cursor
 * FIRST, then the folded `dispatch_claims` + `pending_dispatches` rows for
 * `(verb, id)` on the SAME read-only connection. Ordering is load-bearing: a
 * single SQLite connection's reads move only forward in time, so once the cursor
 * read observes `cursor >= attemptId` (the mint event folded), the later claim /
 * pending reads see at-least-that-committed state — a not-yet-folded mint can
 * never masquerade as a lost claim. A PRODUCER read; never called from a fold.
 */
export function readClaimAcquireObservation(
  db: Parameters<typeof runQuery>[0],
  verb: Verb,
  id: string,
): ClaimAcquireObservation {
  const cursorRow = db
    .query("SELECT last_event_id FROM reducer_state WHERE id = 1")
    .get() as { last_event_id: number } | null;
  const cursor = cursorRow?.last_event_id ?? 0;
  const claimRow = db
    .query(
      "SELECT attempt_id, state, session_id, legacy_unfenced FROM dispatch_claims WHERE verb = ? AND id = ?",
    )
    .get(verb, id) as {
    attempt_id: number | null;
    state: string;
    session_id: string | null;
    legacy_unfenced: number;
  } | null;
  const pendingRow = db
    .query(
      "SELECT attempt_id FROM pending_dispatches WHERE verb = ? AND id = ?",
    )
    .get(verb, id) as { attempt_id: number | null } | null;
  return {
    cursor,
    claim:
      claimRow === null
        ? null
        : {
            attemptId: claimRow.attempt_id,
            state: claimRow.state,
            sessionId: claimRow.session_id,
            legacyUnfenced: claimRow.legacy_unfenced,
          },
    pendingAttemptId: pendingRow?.attempt_id ?? null,
  };
}

/**
 * The confirm-runner. Captures the `events.id` watermark, mints a `Dispatched`
 * event (outbox-ordered intent), fires `launch`, then polls `deps.findJob` until
 * it resolves truthy (`"ok"`) or `ceilingMs` elapses. Launch failure
 * short-circuits to `"failed"`. Launch-window dedup is served by the durable
 * `pending_dispatches` projection the `Dispatched` event populates, so a
 * still-booting worker keeps its slot until `SessionStart` discharges the row.
 *
 * Abort handling: an abort BEFORE `launch()` → `"aborted-prelaunch"`; AFTER →
 * `"aborted-postlaunch"`. Neither emits `DispatchFailed`; the split lets the
 * cycle glue CLEAR the cooldown pre-launch (nothing launched) and KEEP it
 * post-launch (a ghost worker may exist). Pure with-injected-deps.
 */
export async function confirmRunning(
  verb: Verb,
  id: string,
  cwd: string,
  argv: string[],
  spec: LaunchSpec,
  signal: AbortSignal,
  deps: ConfirmRunningDeps,
  // The dispatched-cell translation forensics (ADR 0047) recorded on the
  // pre-launch `Dispatched` event data — present only for a cell-bearing `work`
  // launch. Optional trailing arg so existing call sites are unaffected.
  launchCell?: DispatchedPayload["cell"],
  // EXACT positive launch-side-effect signal: fired ONCE, immediately after `launch()`
  // returns ok — i.e. the closer process/window was spawned — REGARDLESS of whether the
  // SessionStart binds before the ceiling. So it fires for `ok`, `aborted-postlaunch`, AND
  // the POST-launch-ceiling `indoubt` (the late-binding cold worker), but NEVER for a
  // pre-launch abort / claim-fold timeout / retryable-or-permanent launch failure (those
  // ran no closer). The fatal-audit lift consume rides this, so UNKNOWN post-launch HOLDS
  // (the token is spent) instead of re-arming into a second launch under one retry. Optional
  // — existing call sites (tests) omit it and are unaffected.
  onLaunchFired?: () => void,
): Promise<ConfirmOutcome> {
  const key = dispatchKey(verb, id);
  const launchWindow = spec.claudeName ?? key;
  // Watermark BEFORE launch: a re-open of a stale terminal row carries
  // `last_event_id <= watermark` (excluded), while the SessionStart that PROVES
  // this dispatch carries `> watermark`.
  const watermark = deps.maxEventId();
  // Mint intent BEFORE launch (outbox ordering) AND AWAIT a durable ack: a
  // fire-and-forget post let main drain a worker's `SessionStart` before the
  // mint landed, so the row was never written and the slot double-dispatched.
  // Await guarantees the durable row exists before the side-effect. Both abort
  // flavors don't-launch: ack `{ok:false}` (no row landed) and an ack-wait
  // reject (the row may have landed on a slow insert — the TTL sweep clears the
  // phantom). Either returns `"aborted-prelaunch"` (no `DispatchFailed`).
  let ack: DispatchedAck;
  try {
    ack = await deps.emitDispatched({
      verb,
      id,
      dir: cwd === "" ? null : cwd,
      ts: deps.now(),
      launch: {
        session: MANAGED_EXEC_SESSION,
        window: launchWindow,
        pane: null,
      },
      ...(launchCell !== undefined ? { cell: launchCell } : {}),
    });
  } catch {
    // Ack-wait rejected (timeout or shutdown). Abort without launching.
    return "aborted-prelaunch";
  }
  if (!ack.ok) {
    if (ack.suppressed === true) {
      // Durable mint gate SUPPRESSED this re-mint (same `verb::id` inside the
      // gate window): NO row landed and a live attempt is presumed in flight (or
      // freshly minted by the winning mint). This is a benign dedup, not a
      // failure — return the distinct `"suppressed-dup"` outcome so the cycle
      // glue RE-STAMPS the cooldown (damp, do NOT re-arm) instead of CLEARING it.
      // Clearing here is the in-lifetime amplifier: suppress→clear→re-dispatch.
      return "suppressed-dup";
    }
    // Durable insert failed on main. Abort without launching — no row
    // landed, so no TTL cleanup needed; the next reconcile cycle re-attempts.
    return "aborted-prelaunch";
  }
  if (signal.aborted) {
    // Shutdown raced the ack. Abort before the side-effect.
    return "aborted-prelaunch";
  }
  if (
    ack.attemptId === undefined ||
    !Number.isSafeInteger(ack.attemptId) ||
    ack.attemptId <= 0
  ) {
    // A successful admission without its exact fence cannot launch safely: the
    // resulting SessionStart would be indistinguishable from unfenced evidence.
    return "aborted-prelaunch";
  }
  // 2b. VERIFY the acquired claim before crossing the launch side-effect. The
  // durable ack proves only "Dispatched event inserted" — the claim acquisition
  // is the FOLD of that event (`acquireDispatchClaim`'s `INSERT OR IGNORE`),
  // which no-ops when a predecessor's bound-never-released claim still holds
  // `(verb, id)`. Launching then would strand an ungrantable wrapper: no
  // `dispatch_claims` row for this attempt → `providerLegGrantStatus` returns a
  // perpetual silent `wait` → every provider leg dies at the fixed grant hold.
  // So poll the folded projection for THIS attempt's acquired claim + pending
  // row. The cursor separates fold-lag (keep polling) from a real loss (loud,
  // terminal). Bounded — a wedged reducer degrades to `indoubt`, never a hang.
  const attemptId = ack.attemptId;
  const verifyPollMs = deps.claimVerifyPollMs ?? CLAIM_VERIFY_POLL_MS;
  const verifyCeilingMs = deps.claimVerifyCeilingMs ?? CLAIM_VERIFY_CEILING_MS;
  let verifyElapsedMs = 0;
  for (;;) {
    if (signal.aborted) {
      // Shutdown raced the verify — nothing launched, so pre-launch abort.
      return "aborted-prelaunch";
    }
    const obs = deps.observeClaimAcquire(verb, id);
    const ownsClaim =
      obs.claim != null &&
      obs.claim.attemptId === attemptId &&
      obs.claim.state === "acquired" &&
      obs.claim.legacyUnfenced === 0;
    if (ownsClaim && obs.pendingAttemptId === attemptId) {
      // POSITIVELY observed the acquired claim AND its pending row — fall
      // through to launch. Both move together in the one fold, so this is the
      // exact "won the claim" signal.
      break;
    }
    if (obs.cursor >= attemptId) {
      // The mint event is folded (cursor passed it) yet THIS attempt does NOT
      // own the claim: a predecessor's un-released claim won the acquire. This
      // is a STRUCTURAL loss — terminal for this attempt, loud + producer-
      // visible naming the holder. No launch, no blind relaunch loop: the
      // level-triggered reconciler re-derives next cycle and the claim reaper
      // clears a genuinely-dead holder.
      console.warn(
        `[autopilot-worker] dispatch ${verb}::${id} lost the claim acquire ` +
          `(attempt ${attemptId}); claim held by attempt=${
            obs.claim?.attemptId ?? "none"
          } session=${obs.claim?.sessionId ?? "none"} state=${
            obs.claim?.state ?? "none"
          } — not launching`,
      );
      return "no-claim";
    }
    if (verifyElapsedMs >= verifyCeilingMs) {
      // Cursor never passed the mint within the bound — a TRANSIENT reducer lag,
      // NOT a loss (never positively observed either way). Don't launch; keep
      // the durable mint for the TTL sweep + next-cycle re-derive. Same
      // operational contract as the ceiling `indoubt` (KEEP the slot, no sticky
      // failure) — but no `recordTimeoutBackstop` (this is fold-lag, not a
      // ceiling rescue of a launched worker).
      return "indoubt";
    }
    const sleepMs = Math.min(verifyPollMs, verifyCeilingMs - verifyElapsedMs);
    await deps.sleep(sleepMs, signal);
    verifyElapsedMs += sleepMs;
  }
  // 3. Launch — ONLY after the durable ack returned the admitted attempt AND the
  // acquired claim was positively observed. The generic metadata rides the
  // structured spec; prompts, names, cells, and the pre-wrapped command remain
  // unchanged.
  const admittedSpec = withDispatchAttempt(
    { ...spec, claudeName: launchWindow },
    attemptId,
  );
  const launchResult: LaunchResult = await deps
    .launch(argv, key, cwd, admittedSpec)
    .catch((err) => ({
      ok: false as const,
      // A thrown launch is a PERMANENT (sticky) fail — `retryable` absent.
      error: `launch threw: ${err instanceof Error ? err.message : String(err)}`,
    }));
  if (launchResult.ok === false) {
    if (launchResult.retryable === true) {
      // TRANSIENT launch fail (keeper agent exit 4 / timeout-kill / bad-path). Do
      // NOT mint a sticky `DispatchFailed` — KEEP the `pending_dispatches` row
      // so the TTL sweep mints `DispatchExpired` and the normal expire path
      // re-dispatches. This routes EXACTLY like the ceiling `"indoubt"` outcome:
      // a transient that never binds feeds the K=3 never-bound breaker (bounded
      // retry → sticky), while a PERMANENT fail below skips the counter entirely.
      deps.recordTimeoutBackstop?.({ rescued: true, stalenessMs: 0 });
      return "indoubt";
    }
    // PERMANENT launch fail (keeper agent exit 3/1/2, a tmux backend failure, or a
    // thrown launch): a sticky `DispatchFailed`, cleared only by a human
    // `retry_dispatch`. Must NOT feed the never-bound counter as a transient
    // would.
    deps.emitDispatchFailed({
      verb,
      id,
      reason: launchResult.error,
      dir: cwd === "" ? null : cwd,
      conflictedFiles: null,
      ts: deps.now(),
      attempt_id: attemptId,
    });
    return "failed";
  }
  // `launch()` returned ok — the side effect POSITIVELY fired (the closer was spawned). Fire
  // the launch-fired signal ONCE here, so every subsequent return (ok / aborted-postlaunch /
  // post-launch ceiling indoubt) counts as a real launch. NEVER reached for any pre-launch
  // return above.
  onLaunchFired?.();
  if (signal.aborted) {
    // Shutdown observed right after a SUCCESSFUL launch — the worker is live
    // (or booting). Post-launch: keep the stamps so a fold-lag re-dispatch
    // can't double-launch this worktree.
    return "aborted-postlaunch";
  }
  // Poll loop — wait for the SessionStart jobs row. The `pending_dispatches` row
  // minted above keeps the `liveTabKeys` arm fired every cycle, so a slow-booting
  // worker holds its slot without a live backend probe.
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const ceilingMs = deps.ceilingMs ?? DEFAULT_CEILING_MS;
  let elapsedMs = 0;
  while (elapsedMs < ceilingMs) {
    const remainingMs = ceilingMs - elapsedMs;
    const sleepMs = Math.min(pollIntervalMs, remainingMs);
    await deps.sleep(sleepMs, signal);
    if (signal.aborted) {
      // Mid-poll shutdown — launch already fired. Post-launch (keep stamps).
      return "aborted-postlaunch";
    }
    elapsedMs += sleepMs;
    const hit = deps.findJob(verb, id, watermark);
    if (hit != null) {
      // The ceiling did NOT rescue this dispatch — counted as the `rescued:false`
      // denominator so the rescue rate is honest (the rollup carries it).
      deps.recordTimeoutBackstop?.({ rescued: false, stalenessMs: null });
      return "ok";
    }
    if (signal.aborted) {
      // Mid-poll shutdown — launch already fired. Post-launch (keep stamps).
      return "aborted-postlaunch";
    }
  }
  // Ceiling elapsed with no jobs row. The launch SUCCEEDED (we're past the
  // `launch.ok===false` guard), so the outcome is IN-DOUBT, not failed — the
  // backend execs `claude` cold occasionally past the ceiling, so a SessionStart may
  // still be coming, and a sticky `DispatchFailed` would wrongly write off a
  // ghost worker. So: SUPPRESS the emit and KEEP the `pending_dispatches` row —
  // it holds the slot, and the TTL sweep mints `DispatchExpired` if the bind
  // never arrives. The full ordering chain is load-bearing:
  //   ceilingMs (60s) < parked grace (90s) < pending TTL (120s) < cooldown (200s).
  // ceiling < TTL: a sweep < ceiling would clear the row mid-confirm and re-open
  // the dispatch. The producer keeps the parked-launch grace between the ceiling
  // and TTL, and TTL < cooldown: the cooldown must outlast the worst-case
  // round-trip (the row surviving a full TTL plus the sweep tick) so suppression
  // never lapses while a phantom is in flight. NOTE: this chain bounds the
  // FOLD-LAG round-trip, but NOT an arbitrary `claude` cold-boot tail —
  // the 2026-06-10 dup-close booted 317s late, so the fixed dispatch-anchored
  // cooldown (cover-end dispatch+260s with one indoubt re-stamp) lapsed before the
  // bind. `refreshSuppressionForOpenPending` now re-anchors the cooldown each cycle
  // the `pending_dispatches` row is still OPEN, extending cover to the phantom's
  // durable lifetime. The parked-launch sweep suppresses the row at its grace
  // before the TTL can release it for a second launch. Telemetry rides alongside: the
  // ceiling RESCUED a stuck dispatch, so `rescued:true` with the elapsed
  // `stalenessMs`.
  deps.recordTimeoutBackstop?.({ rescued: true, stalenessMs: elapsedMs });
  return "indoubt";
}

/** Shared empty set — the `liveAttrFor` fallback when a base worktree has no live-job
 *  attribution, so a present map missing the key allocates nothing per launch. */
const EMPTY_STRING_SET: ReadonlySet<string> = new Set<string>();

/**
 * Build the producer LIVE-JOB dirty-attribution map the fan-in pre-merge clean reads
 * — `Map<laneWorktreePath, Set<repoRelPath>>` — so a running worker's uncommitted work
 * is NEVER discarded as a "redundant leak". Reads undischarged `file_attributions`
 * rows (`last_commit_at IS NULL OR last_commit_at < last_mutation_at`) whose
 * `session_id` (== a job's `job_id`) belongs to a LIVE job — `working`, or `stopped`
 * with a live backend pane (the SAME {@link isStoppedJobLive} rule the occupancy gate
 * uses) — grouped by `project_dir` (the git toplevel a linked worktree resolves to ==
 * the lane path), realpath + trailing-slash normalized to match the lookup key.
 * Returns `null` on ANY read failure — the caller threads that as do-not-discard
 * (assume live-attributed). A producer read (never a fold); the no-live-job fast path
 * skips the SQL entirely.
 */
function computeLiveAttributedDirtyByWorktree(
  db: Parameters<typeof runQuery>[0],
  jobs: Map<string, Job>,
  livePaneIds: ReadonlySet<string> | null,
): Map<string, ReadonlySet<string>> | null {
  try {
    const liveSessions = new Set<string>();
    const byWorktree = new Map<string, Set<string>>();
    for (const job of jobs.values()) {
      const live =
        job.state === "working" ||
        (job.state === "stopped" && isStoppedJobLive(job, livePaneIds));
      if (live) {
        liveSessions.add(job.job_id);
        // Preserve an empty keyed entry for a clean live lane. The refresh producer
        // uses key presence as its no-live-worker quiescence gate, while provision
        // still consumes the value as the dirty-path attribution set.
        if (job.worktree !== null && job.cwd !== null) {
          byWorktree.set(normalizeWorktreeAttributionKey(job.cwd), new Set());
        }
      }
    }
    if (liveSessions.size === 0) {
      return byWorktree;
    }
    const rows = db
      .query(
        "SELECT project_dir, session_id, file_path FROM file_attributions " +
          "WHERE last_commit_at IS NULL OR last_commit_at < last_mutation_at",
      )
      .all() as Array<{
      project_dir: string;
      session_id: string;
      file_path: string;
    }>;
    for (const r of rows) {
      if (
        typeof r.project_dir !== "string" ||
        typeof r.session_id !== "string" ||
        typeof r.file_path !== "string" ||
        !liveSessions.has(r.session_id)
      ) {
        continue;
      }
      const key = normalizeWorktreeAttributionKey(r.project_dir);
      let set = byWorktree.get(key);
      if (set === undefined) {
        set = new Set<string>();
        byWorktree.set(key, set);
      }
      set.add(r.file_path);
    }
    return byWorktree;
  } catch (err) {
    console.error(
      "[autopilot-worker] live-attributed dirty read threw (do-not-discard):",
      err,
    );
    return null;
  }
}

/**
 * Normalize a worktree path to the pre-merge attribution map's key: realpath (so the
 * macOS `/tmp`→`/private/tmp` + `/var`→`/private/var` symlinks collapse to the same
 * form the lane-path lookup in `runReconcileCycle` produces), then strip a trailing
 * slash. A realpath failure (a path already torn down) keeps the raw input, still
 * trailing-slash-stripped.
 */
function normalizeWorktreeAttributionKey(p: string): string {
  let resolved = p;
  try {
    resolved = realpathSync.native(p);
  } catch {
    // A torn-down worktree that no longer resolves — key on the raw path.
  }
  return stripTrailingSlashPath(resolved);
}

/**
 * Run one reconcile + dispatch cycle. Pure-glue — chains the decision's launches
 * one at a time through `confirmRunning` (the one-at-a-time stagger). Each launch
 * flips its `key` into `state.inFlight` BEFORE the await and removes it on
 * resolution. Returns when every launch has resolved OR the abort signal fired.
 */
export const BASE_REFRESH_COOLDOWN_SEC = 15 * 60;

async function readBoundedProcessText(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes = 16 * 1024,
): Promise<string> {
  if (stream === null) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - size;
      const chunk = value.byteLength <= room ? value : value.subarray(0, room);
      chunks.push(chunk);
      size += chunk.byteLength;
    }
  } finally {
    if (size >= maxBytes) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export function buildCloseRecoveryStampArgv(
  epicId: string,
  projectDir: string,
  execPath = process.execPath,
  keeperRoot = KEEPER_ROOT,
): string[] {
  return [
    execPath,
    join(keeperRoot, "cli", "keeper.ts"),
    "plan",
    "epic",
    "close",
    epicId,
    "--reason",
    CLOSE_RECOVERY_MARKER,
    "--project",
    projectDir,
  ];
}

export function classifyCloseRecoveryStampExit(
  epicId: string,
  exitCode: number,
  stdout: string,
  stderr: string,
): CloseRecoveryStampResult {
  if (exitCode === 0) return { ok: true, alreadyClosed: false };
  const output = `${stdout}\n${stderr}`;
  if (output.includes(`Epic ${epicId} is already done`)) {
    return { ok: true, alreadyClosed: true };
  }
  return {
    ok: false,
    detail: `exit ${exitCode}: ${output.trim().slice(0, 2_000) || "no output"}`,
  };
}

/** Run the plan-owned epic-close mutation with an exact argv and hard deadline. */
export async function stampEpicCloseRecovery(
  epicId: string,
  projectDir: string,
  timeoutMs = CLOSE_RECOVERY_TIMEOUT_MS,
): Promise<CloseRecoveryStampResult> {
  try {
    const proc = Bun.spawn(buildCloseRecoveryStampArgv(epicId, projectDir), {
      cwd: projectDir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = readBoundedProcessText(proc.stdout);
    const stderr = readBoundedProcessText(proc.stderr);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol("close-recovery-timeout");
    const deadline = new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), timeoutMs);
    });
    const exit = await Promise.race([proc.exited, deadline]);
    if (timer !== undefined) clearTimeout(timer);
    if (exit === timedOut) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // The process may have exited at the deadline edge.
      }
      await proc.exited.catch(() => {});
      await Promise.all([stdout, stderr]);
      return { ok: false, detail: `timed out after ${timeoutMs}ms` };
    }
    const [out, err] = await Promise.all([stdout, stderr]);
    return classifyCloseRecoveryStampExit(epicId, exit, out, err);
  } catch (err) {
    return { ok: false, detail: errMsg(err) };
  }
}

function providerCellContext(plan: PlannedLaunch): string {
  const contract = plan.providerLaunchContract;
  return contract === undefined
    ? ""
    : ` (worker_provider=${contract.provider}, effective cell ${contract.model}/${contract.tier})`;
}

export async function runReconcileCycle(
  decision: ReconcileDecision,
  state: ReconcileState,
  liveDispatches: Map<DispatchKey, LiveDispatch>,
  shell: string,
  signal: AbortSignal,
  deps: ConfirmRunningDeps,
  // The producer LIVE-JOB dirty attribution from `loadReconcileSnapshot`, keyed by
  // lane worktree path — threaded into every `provision` so the fan-in pre-merge
  // clean never discards dirt a running worker owns. `null` (or omitted) = the read
  // failed / no info → every base is treated do-not-discard.
  liveAttributedDirtyByWorktree: ReadonlyMap<
    string,
    ReadonlySet<string>
  > | null = null,
  dispatchFailureFences?: DispatchFailureFenceMap,
  laneMaintenanceProbe?: LaneMaintenanceProbe,
  // The withhold-rail publication seam. When present, the frame is replace-merged
  // from the fully-classified `decision.withholds` at the classification-completion
  // point below (after the launch pass, BEFORE the finalize tail) — NEVER from the
  // caller's `finally`. A pre-completion abort/throw thus PRESERVES the prior frame
  // unchanged (no partial map ever replace-merges a standing producer hold to a
  // phantom clear); a finalize-tail throw AFTER completion keeps the published frame.
  // `state` is the persistent per-worker frame memory; `emit` overrides the default
  // console.error sink (tests capture the transition lines).
  withholdFramePublish?: {
    state: WithholdFrameState;
    emit?: (line: string) => void;
  },
): Promise<void> {
  // Realpath-normalize the worktree lane before it rides the launch as the
  // KEEPER_PLAN_WORKTREE env (macOS /var→/private/var) — a PRODUCER fs read,
  // never a fold. Falls back to the input on any error so a not-yet-materialized
  // path stays usable. Injectable for tests.
  const realpath =
    deps.realpath ??
    ((p: string): string => {
      try {
        return realpathSync.native(p);
      } catch {
        return p;
      }
    });
  // (pass, lane) keys this cycle deferred — the episode-latch's seen set, pruned
  // once the cycle's mutating passes settle.
  const laneDeferralsSeen = new Set<string>();
  // The live-attributed dirty set for a launch's base lane worktree, keyed the SAME
  // way the snapshot built the map (realpath + trailing-slash normalized). `null` ⇒
  // do-not-discard (an OFF-mode launch with no geometry, or a failed attribution
  // read); a present map missing the key ⇒ the empty set (nothing attributed there,
  // so a provably-redundant leak is cleanable).
  const liveAttrFor = (
    info: WorktreeLaunchInfo | undefined,
  ): ReadonlySet<string> | null => {
    if (info === undefined || liveAttributedDirtyByWorktree === null) {
      return null;
    }
    const key = stripTrailingSlashPath(realpath(info.assignment.worktreePath));
    return liveAttributedDirtyByWorktree.get(key) ?? EMPTY_STRING_SET;
  };
  // Compiler verification and launcher inventories are producer reads, lazy and
  // memoized independently for this cycle. No selected cell means no read;
  // missing/stale cells never trigger the later inventory scans. Configured
  // inputs scan once; launch cwd inputs use a hard-bounded physical-path cache.
  const verifyCohort = deps.verifyWorkerCellCohort ?? verifyWorkerCellCohort;
  let cohortVerification: WorkerCellCohortVerification | undefined;
  const physicalize = deps.physicalPluginDir ?? physicalPluginDir;
  const probeFreshnessMemoized = (pluginDir: string) => {
    cohortVerification ??= verifyCohort();
    return selectedWorkerCellFreshness(
      pluginDir,
      cohortVerification,
      physicalize,
    );
  };
  const probeShadowMemoized = createWorkPluginShadowProbe({
    inventoryConfigured:
      deps.inventoryWorkPluginManifests ?? defaultWorkPluginManifestInventory,
    inventoryCwd:
      deps.inventoryLaunchCwdWorkPluginManifests ??
      inventoryLaunchCwdWorkPluginManifests,
    physicalize,
  });
  // ── Slot-occupancy visibility + auto-reclaim ───────────────────────────────
  // Surface every wedged slot through the change-gate. The worker drive consumes
  // each exact `reapTarget` through the identity-rechecking TERM→KILL ladder before
  // this producer runs; this seam owns only the reason-scoped failure/clear events.
  for (const sig of decision.slotOccupancy) {
    if (signal.aborted) {
      return;
    }
    deps.emitDispatchFailed({
      verb: sig.verb,
      id: sig.id,
      reason: sig.reason,
      dir: sig.dir,
      conflictedFiles: null,
      ts: deps.now(),
    });
  }
  for (const clr of decision.slotOccupancyClears) {
    if (signal.aborted) {
      return;
    }
    deps.emitDispatchCleared(
      dispatchClearedPayload(dispatchFailureFences, clr.verb, clr.id),
    );
  }
  // Fatal-audit fence: mint one durable needs-human row per still-current fatal verdict on
  // the TYPED synthetic id `close::fatal-audit:<epic>` — reason-disjoint from the bare
  // `close::<epic>` key, so a standing merge/finalize/launch failure is never overwritten
  // and the withhold derives from the receipt (not this row's existence). A commit-set
  // drift positive-clears the row so the re-dispatched closer re-audits the fresh tree. The
  // change-gate + reducer UPSERT make a re-emit of a standing row idempotent.
  for (const mint of decision.fatalAuditMints) {
    if (signal.aborted) {
      return;
    }
    deps.emitDispatchFailed({
      verb: "close",
      id: fatalAuditDispatchId(mint.id),
      reason: `${FATAL_AUDIT_REASON_TOKEN}: ${mint.excerpt}`,
      dir: null,
      conflictedFiles: null,
      ts: deps.now(),
    });
  }
  for (const clr of decision.fatalAuditClears) {
    if (signal.aborted) {
      return;
    }
    deps.emitDispatchCleared(
      dispatchClearedPayload(
        dispatchFailureFences,
        "close",
        fatalAuditDispatchId(clr.id),
      ),
    );
  }
  // Refresh drifted bases before dispatching new work. This is a producer sibling
  // of recover/finalize: it mutates only the lane's own linked worktree and never
  // runs from the observational snapshot probe. A null attribution snapshot is
  // inconclusive; a keyed lane has a live worker mutation and is not quiescent.
  // epicId → the base-refresh failure reason that blocks this epic's launches this
  // cycle. A Map (not a Set) so the ready-launch withhold below names WHY the base is
  // blocked; a genuine failure also mints a sticky on `close::<epic>`, but a WORK task
  // in the same epic carries no sticky of its own — the rail frame is its only signal.
  const refreshBlockedEpics = new Map<string, string>();
  if (deps.worktree !== undefined && !state.paused) {
    for (const entry of decision.baseDriftEntries) {
      if (signal.aborted) return;
      if (liveAttributedDirtyByWorktree === null) continue;
      const baseBranch = baseBranchFor(entry.epic_id);
      const basePath = stripTrailingSlashPath(
        realpath(worktreePathFor(entry.repo_dir, baseBranch)),
      );
      if (liveAttributedDirtyByWorktree.has(basePath)) continue;
      const hold = probeLaneMaintenance(laneMaintenanceProbe, {
        path: basePath,
        epicId: entry.epic_id,
        taskId: null,
      });
      if (hold.kind === "defer") {
        logLaneMaintenanceDeferralOnce(
          "worktree-base-refresh-deferred",
          basePath,
          hold.reason,
          laneDeferralsSeen,
        );
        continue;
      }
      const refreshed = await deps.worktree.refreshBase(entry, deps.now());
      if (!refreshed.ok) {
        if (refreshed.retry === true) {
          console.error(
            `[autopilot-worker] base refresh ${entry.epic_id} (${entry.repo_dir}): ${refreshed.reason}`,
          );
          continue;
        }
        refreshBlockedEpics.set(entry.epic_id, refreshed.reason);
        deps.emitDispatchFailed({
          verb: "close",
          id: entry.epic_id,
          reason: refreshed.reason,
          dir: basePath,
          conflictedFiles: null,
          ts: deps.now(),
        });
      }
    }
  }
  // Start the bounded plan mutation without holding the reconcile cycle open.
  // The shared close key remains in-flight until settlement, so a later cycle
  // cannot launch a closer or a second stamp over the same epic.
  for (const stamp of decision.closeRecoveryStamps) {
    if (signal.aborted) return;
    if (state.inFlight.has(stamp.key)) continue;
    state.inFlight.add(stamp.key);
    const attempt = deps.stampEpicCloseRecovery
      ? deps.stampEpicCloseRecovery(stamp.epicId, stamp.projectDir)
      : Promise.resolve({
          ok: false as const,
          detail: "close recovery stamp dependency absent",
        });
    void attempt
      .then((result) => {
        if (result.ok) {
          const stampedAt = deps.now();
          state.redispatchCooldown.set(stamp.key, stampedAt);
          state.finalizerGuard.set(stamp.epicId, stampedAt);
        } else {
          console.error(
            `[autopilot-worker] close recovery stamp ${stamp.epicId}: ${result.detail}`,
          );
        }
      })
      .catch((err) => {
        console.error(
          `[autopilot-worker] close recovery stamp ${stamp.epicId} threw (retrying next cycle):`,
          err,
        );
      })
      .finally(() => {
        state.inFlight.delete(stamp.key);
      });
  }

  // Pre-close fan-in — a REAL producer-side assembly, not provision readiness alone.
  // A serial-primary close hosts NO worker in the non-close-host groups' lanes, so the
  // PRODUCER integrates every clean rib into each group's base HERE (under the shared
  // lock/readiness discipline), then positively re-probes ancestry BEFORE the close may
  // land. Aggregated PER EPIC over ALL its groups (a conflict/defer in one group must
  // NOT stop assembling a later group — every clean group still fans in). The suppression
  // is OUTCOME-AWARE, since `preCloseIncidentOwnerEpicIds` denotes an UNCLAIMED next
  // attachment, not a live mutator: only a POSITIVELY-CURRENT content `conflict` forces
  // the resolver launch (an owner launches to resolve THIS rib, then the producer
  // re-enters for the next; a non-owner waits one cycle for the incident to route it); a
  // transient/inconclusive `defer` retries next cycle WITHOUT consuming an attachment
  // (suppress, no row); a STRUCTURAL `failed` mints a DURABLE per-(epic, repo) fence on a
  // DISTINCT key (never the bare incident key it must not masquerade as) and suppresses.
  // The fence LEVEL-CLEARS on the SAME (epic, repo)'s clean assembly (or content
  // conflict — proof the structural preflight passed) this cycle, so a self-healed
  // failure never leaves a durable row jamming the close's final drain. The `conflict`
  // incident re-mints each cycle onto the bare `close::<epic>` key (the fold preserves
  // its attach/paging markers). Gated not-paused like refreshBase/finalize.
  // epicId → the bounded detail naming WHY the epic's close is held (structural
  // assembly failure, an inconclusive/transient fan-in defer, or a non-owner waiting
  // on a merge conflict). A Map so the ready-close withhold below names the blocker.
  const preCloseProvisionBlocked = new Map<string, string>();
  if (deps.worktree !== undefined && !state.paused) {
    interface PreCloseOutcome {
      conflict?: {
        sourceBranch: string;
        baseBranch: string;
        laneDir: string;
        conflictedFiles: string[];
        stderr: string;
      };
      hasFailure?: boolean;
      /** The FIRST structural assembly reason across this epic's groups (deterministic
       *  first-group-wins) — carried so the launch withhold names the POSITIVELY-known
       *  blocker rather than a placeholder. */
      failureReason?: string;
      /** The per-(epic, repo) fence id of that first structural failure. */
      failureFenceId?: string;
      deferred?: boolean;
      /** The most recent transient/inconclusive defer reason across this epic's
       *  groups — carried so the launch withhold names the fan-in blocker. */
      deferReason?: string;
    }
    const epicOutcomes = new Map<string, PreCloseOutcome>();
    const outcomeFor = (epicId: string): PreCloseOutcome => {
      let o = epicOutcomes.get(epicId);
      if (o === undefined) {
        o = {};
        epicOutcomes.set(epicId, o);
      }
      return o;
    };
    // Assemble EVERY group (never short-circuit a later group on an earlier conflict).
    for (const sink of decision.worktreePreCloseProvision) {
      if (signal.aborted) {
        return;
      }
      const epicId = closeKeyEpicId(sink);
      const o = outcomeFor(epicId);
      const fenceId = worktreePrecloseDispatchId(epicId, sink.repoDir);
      // Positive-evidence level-clear of a self-healed structural fence (scoped to an
      // OPEN fence for THIS (epic, repo) — never dismisses another cycle's live block).
      const clearFenceIfOpen = (): void => {
        if (decision.preCloseFenceFailureIds.has(fenceId)) {
          deps.emitDispatchCleared(
            dispatchClearedPayload(dispatchFailureFences, "close", fenceId),
          );
        }
      };
      const hold = probeLaneMaintenance(laneMaintenanceProbe, {
        path: sink.assignment.worktreePath,
        epicId,
        taskId: null,
      });
      if (hold.kind === "defer") {
        o.deferred = true;
        o.deferReason = hold.reason;
        logLaneMaintenanceDeferralOnce(
          "worktree-preclose-provision-deferred",
          sink.assignment.worktreePath,
          hold.reason,
          laneDeferralsSeen,
        );
        continue;
      }
      const assembled = await deps.worktree.assembleBase(
        sink,
        liveAttrFor(sink),
      );
      switch (assembled.kind) {
        case "assembled":
          clearFenceIfOpen(); // the base is structurally sound now
          break;
        case "defer":
          o.deferred = true;
          o.deferReason = assembled.reason;
          logLaneMaintenanceDeferralOnce(
            "worktree-preclose-provision-deferred",
            sink.assignment.worktreePath,
            assembled.reason,
            laneDeferralsSeen,
          );
          break;
        case "conflict":
          if (o.conflict === undefined) {
            o.conflict = {
              sourceBranch: assembled.sourceBranch,
              baseBranch: assembled.baseBranch,
              laneDir: assembled.laneDir,
              conflictedFiles: assembled.conflictedFiles,
              stderr: assembled.stderr,
            };
          }
          clearFenceIfOpen(); // reaching a content conflict PROVES the preflight passed
          break;
        case "failed":
          o.hasFailure = true;
          // Carry the FIRST structural reason + its fence (first group wins) so the
          // launch withhold names the POSITIVELY-known blocker, not a placeholder.
          if (o.failureReason === undefined) {
            o.failureReason = assembled.reason;
            o.failureFenceId = fenceId;
          }
          // Mint/re-mint the DURABLE per-(epic, repo) fence (routes close-plain).
          deps.emitDispatchFailed({
            verb: "close",
            id: fenceId,
            reason: assembled.reason,
            dir: sink.repoDir,
            conflictedFiles: null,
            ts: deps.now(),
          });
          break;
        default:
          assertNever(assembled);
      }
    }
    // Route the conflict incident + decide suppression, per epic.
    for (const [epicId, o] of epicOutcomes) {
      const isIncidentOwner = decision.preCloseIncidentOwnerEpicIds.has(epicId);
      // A positively-current conflict → mint/re-point the resolver incident on the
      // bare close::<epic> key (leading-token → merge-escalation routing).
      if (o.conflict !== undefined) {
        deps.emitDispatchFailed({
          verb: "close",
          id: epicId,
          reason: `${MERGE_ESCALATION_REASON_TOKEN}: merging ${o.conflict.sourceBranch} into ${o.conflict.baseBranch} — ${o.conflict.stderr}`,
          dir: o.conflict.laneDir,
          conflictedFiles: o.conflict.conflictedFiles,
          ts: deps.now(),
        });
      }
      // Suppress the launch UNLESS the base is a clean positively-current conflict state
      // owned by an incident: a structural failure or a transient/inconclusive defer
      // suppresses regardless of owner (no attachment burned on a non-conflict); a
      // conflict alone forces the launch only for the incident owner.
      // Name the block by a STABLE precedence (hardest-blocking first) so the same
      // outcome always yields the same withhold detail: a structural assembly failure
      // (fenced) outranks a transient defer, which outranks a non-owner waiting on the
      // routed merge conflict.
      if (o.hasFailure === true) {
        const fenceRef =
          o.failureFenceId ?? worktreePrecloseDispatchId(epicId, "");
        preCloseProvisionBlocked.set(
          epicId,
          boundedFields([
            "pre-close base assembly failed (fenced on ",
            { bounded: fenceRef },
            "): ",
            { bounded: o.failureReason ?? "structural preflight failure" },
          ]),
        );
      } else if (o.deferred === true) {
        preCloseProvisionBlocked.set(
          epicId,
          o.deferReason ?? "pre-close fan-in base not ready",
        );
      } else if (o.conflict !== undefined && !isIncidentOwner) {
        preCloseProvisionBlocked.set(
          epicId,
          boundedFields([
            "pre-close merge conflict awaiting owner resolution: merging ",
            { bounded: o.conflict.sourceBranch },
            " into ",
            { bounded: o.conflict.baseBranch },
            " (lane ",
            { bounded: o.conflict.laneDir },
            ")",
          ]),
        );
      }
    }
    // ABSENT-SINK fence retirement: reconcile positively proved these fences' (epic,
    // repo) sinks are gone (landed / reaped / worktree-off / regrouped), so retire the
    // stale rows the same-cycle level-clear could never reach (no present sink to
    // assemble). Fenced through the SAME emitDispatchCleared path as the level-clear.
    for (const fenceId of decision.preCloseFenceClears) {
      deps.emitDispatchCleared(
        dispatchClearedPayload(dispatchFailureFences, "close", fenceId),
      );
    }
  }

  // One-at-a-time: each await covers the full confirm window for that dispatch
  // before the next launch starts (which IS the stagger).
  for (const plan of decision.launches) {
    // Every producer-side ready-launch skip below routes the withheld target through
    // the SAME ephemeral `decision.withholds` rail the pure core populates, so a lane
    // that cannot provision this cycle is explainable from the withhold surface rather
    // than a lone lane-path stderr line. These targets are DISJOINT from the core holds
    // (a target the core held never reached `decision.launches`), so no key collides;
    // the SKIP ORDER here (refresh-blocked → pre-close-blocked → provision-defer) is the
    // documented producer precedence, mirroring the core's first-failing-arm precedence.
    if (plan.worktree !== undefined) {
      const refreshReason = refreshBlockedEpics.get(
        closeKeyEpicId(plan.worktree),
      );
      if (refreshReason !== undefined) {
        decision.withholds.set(
          plan.id,
          withhold("lane-provision", `base-refresh-blocked: ${refreshReason}`),
        );
        continue;
      }
    }
    // Suppress a close whose non-close-host worktree groups are not yet fanned in —
    // the pre-close provision above blocked it; retry next cycle (no sticky).
    if (plan.verb === "close") {
      const preCloseReason = preCloseProvisionBlocked.get(plan.id);
      if (preCloseReason !== undefined) {
        decision.withholds.set(
          plan.id,
          withhold("lane-provision", preCloseReason),
        );
        continue;
      }
    }
    if (signal.aborted) {
      return;
    }
    if (state.inFlight.has(plan.key)) {
      // Defensive: reconcile already filters this, but a re-entrant call could
      // double-queue. Skip to keep one-at-a-time honest.
      continue;
    }
    // A worktree-mode reject (multi-repo / unresolved) is evaluated AHEAD
    // of the cwd-missing stat: an unresolved epic's `plan.cwd` is the RAW
    // (un-normalized) effective root, which may not exist on disk, so the generic
    // `cwd-missing` would mask the distinct `worktree-repo-unresolved` reason. Mint
    // the sticky reject (cleared by `retry_dispatch`) and skip — per-key, so a
    // sibling launch keeps dispatching.
    if (plan.worktreeReject !== undefined) {
      deps.emitDispatchFailed({
        verb: plan.verb,
        id: plan.id,
        reason: plan.worktreeReject.reason,
        dir: plan.cwd,
        conflictedFiles: null,
        ts: deps.now(),
      });
      continue;
    }
    if (plan.worktree !== undefined) {
      const hold = probeLaneMaintenance(laneMaintenanceProbe, {
        path: plan.worktree.assignment.worktreePath,
        epicId: closeKeyEpicId(plan.worktree),
        taskId: plan.verb === "work" ? plan.id : null,
      });
      if (hold.kind === "defer") {
        logLaneMaintenanceDeferralOnce(
          "worktree-provision-deferred",
          plan.worktree.assignment.worktreePath,
          hold.reason,
          laneDeferralsSeen,
        );
        // The probe reason NAMES the live holder (a claim / working-or-stopped session)
        // from POSITIVE evidence this cycle, or honestly says the pane probe was
        // inconclusive (a degraded cycle) — never a guessed or cached identity. The rail
        // frame is target-keyed; the lane-path line above stays for the maintenance view.
        decision.withholds.set(
          plan.id,
          withhold("lane-provision", hold.reason),
        );
        continue;
      }
    }
    // Fail-loud on a stale (renamed-away) launch cwd. The resolved cwd is
    // stamped into `plan.cwd` by the pure `reconcile`; the on-disk stat lives
    // HERE in the producer (never in a fold) so re-fold determinism holds. A
    // missing dir mints a sticky `cwd-missing: <path>` `DispatchFailed` via the
    // EXISTING dispatch-failure surface (no new projection column) — the key is
    // suppressed until a `retry_dispatch` clears it, and unrelated launches in
    // this same loop keep dispatching (per-key block, not a queue stall).
    // Remediation: `keeper plan mv-repo <old> <new>`.
    const dirExists = deps.dirExists ?? existsSync;
    if (!dirExists(plan.cwd)) {
      deps.emitDispatchFailed({
        verb: plan.verb,
        id: plan.id,
        reason: `cwd-missing: ${plan.cwd}`,
        dir: plan.cwd,
        conflictedFiles: null,
        ts: deps.now(),
      });
      continue;
    }
    // Per-cell worker-plugin guards, BEFORE any launch side effect (mirrors the
    // `worktreeReject` / `cwd-missing` per-key skip shape). The shared
    // `resolveWorkerCell` seam applies the bad-matrix → invalid → missing →
    // stale → shadowed precedence over the pure compose result the launch carries
    // (`plan.pluginDir` / `plan.pluginDirReject` / `plan.matrixReject` — the last
    // built from the cycle's ONE host-matrix snapshot); this producer re-composes
    // the EXACT sticky reason strings from the machine kind, so a doomed launch
    // mints a sticky `DispatchFailed` (cleared by `retry_dispatch`) and skips
    // per-key without burning a cold boot, and a sibling launch keeps
    // dispatching. The switch is closed by `assertNever` — a new reject kind
    // fails compilation here.
    const prospectiveLaunchCwd =
      deps.worktree !== undefined && plan.worktree !== undefined
        ? plan.worktree.assignment.worktreePath
        : plan.cwd;
    const cell = resolveWorkerCell(
      {
        pluginDir: plan.pluginDir,
        // The EFFECTIVE cell (the `worker_provider`-translated one when the pin
        // fired, else the assigned cell) so a missing/invalid reject names the cell
        // that actually launches — `plan.pluginDir` already composes over it.
        model: plan.dispatchedCellModel ?? plan.cellModel,
        tier: plan.dispatchedCellTier ?? plan.tier,
        ...(plan.pluginDirReject !== undefined
          ? { reject: plan.pluginDirReject }
          : {}),
        ...(plan.matrixReject !== undefined
          ? { matrixReject: plan.matrixReject }
          : {}),
        ...(plan.providerReject !== undefined
          ? { providerReject: plan.providerReject }
          : {}),
        ...(plan.providerPinReject !== undefined
          ? { providerPinReject: plan.providerPinReject }
          : {}),
        ...(plan.providerLaunchContract !== undefined
          ? { providerLaunchContract: plan.providerLaunchContract }
          : {}),
      },
      {
        dirExists,
        probeFreshness: probeFreshnessMemoized,
        probeShadow: (pluginDir) =>
          probeShadowMemoized(pluginDir, prospectiveLaunchCwd),
      },
    );
    if (!cell.ok) {
      let reason: string;
      switch (cell.kind) {
        // (1) the cycle's host matrix failed to load — the four-state discriminator
        //     (ADR 0036). No matrix ⇒ no cell to compose, so this ranks first; the
        //     reason NAMES the state and carries the copy-the-example remediation
        //     the MatrixConfigError message already bakes in.
        case "bad-matrix":
          reason =
            `worker-cell-bad-matrix: ${cell.state} — ${cell.detail} ` +
            "Then 'keeper retry-dispatch'.";
          break;
        // (1a) the durable `worker_provider` pin AUTHORITY read UNKNOWN (a present-
        //      but-invalid value, ADR 0047) — refuse this cell-bearing launch
        //      VISIBLY rather than dispatch the unpinned assigned cell. Ranks right
        //      after bad-matrix (matrix-first), the authority parity the manual +
        //      block-owner paths hold.
        case "provider-pin-unknown":
          reason = providerPinUnknownReason(cell.detail);
          break;
        // (1b) the `worker_provider` pin could not translate the assigned cell
        //      into the pinned family (ADR 0047) — fail-closed, NEVER a fallback to
        //      the assigned provider. Distinct reason per the three totality gaps a
        //      stale map leaves at runtime; each names the cells + direction.
        case "provider-reject":
          reason = providerRejectReason(cell);
          break;
        // (2) an out-of-matrix {model, effort} the pure compose flagged.
        case "out-of-matrix":
          reason = `worker-cell-invalid: ${cell.message}`;
          break;
        // (2b) the effective cell's route/driver/marker cannot jointly satisfy
        //      the active provider constraint. This producer-only admission gate
        //      catches a valid-looking cell path before its wrapper guard can park
        //      a native worker, and names the constraint + effective pair.
        case "provider-unlaunchable":
          reason = providerUnlaunchableReason(cell);
          break;
        // (3) selected manifest absent: compile the complete owned cohort.
        case "missing":
          reason =
            `worker-cell-missing: ${cell.pluginDir}${providerCellContext(plan)} — regenerate via ` +
            `'${WORKER_CELL_COMPILE_COMMAND}' (without the cell manifest ` +
            `claude --plugin-dir falls back to the dir basename and '/plan:work' ` +
            `cannot resolve 'work:worker')`;
          break;
        // (4) verifier failure or selected dir absent from its exact output set.
        case "stale":
          reason =
            `worker-cell-stale: ${cell.detail}${providerCellContext(plan)} — regenerate via ` +
            `'${WORKER_CELL_COMPILE_COMMAND}'`;
          break;
        // (5) any other preloaded `work` manifest, including a generated sibling.
        case "shadowed":
          reason =
            `work-plugin-shadowed: ${cell.shadowManifest} — another preloaded ` +
            `'work'-named plugin would steal 'work:worker' from the exact ` +
            `'${cell.pluginDir}' cell at launch (silent wrong-worker spawn); ` +
            "remove or rename it, then 'keeper retry-dispatch'";
          break;
        default:
          assertNever(cell);
      }
      deps.emitDispatchFailed({
        verb: plan.verb,
        id: plan.id,
        reason,
        dir: plan.cwd,
        conflictedFiles: null,
        ts: deps.now(),
      });
      continue;
    }
    // The resolved cell dir off the ok-result — equal to `plan.pluginDir` for any
    // in-matrix cell (native or wrapped alike compose their dir in the pure core
    // from the injected axes), and `null` for a cell-less launch. Threaded into both
    // launch shapes below.
    const resolvedPluginDir = cell.pluginDir;
    // Worktree-mode producer step, BEFORE `confirmRunning` mints the
    // durable Dispatched. `launchCwd` is the cwd `confirmRunning` actually launches
    // into; it starts as the pure `plan.cwd` and is OVERRIDDEN to the lane worktree
    // path when worktree mode provisions one. Every git side effect lives here in
    // the producer (never a fold). All three branches mint sticky `DispatchFailed`
    // on a loud failure (cleared by `retry_dispatch`) and skip — per-key, so a
    // sibling launch keeps dispatching.
    let launchCwd = plan.cwd;
    // The realpath-normalized lane carried as KEEPER_PLAN_WORKTREE — set ONLY for
    // a worktree-GEOMETRY launch (`plan.worktree` present). OFF-mode launches (no
    // geometry, just the on-default-branch assertion) leave it undefined so their
    // launch argv stays byte-identical to today.
    let worktreeLane: string | undefined;
    // The pure per-node lane BRANCH (NOT derived from the realpath'd cwd) — the
    // durable `jobs.worktree` marker the hook captures. Set alongside the lane
    // path so a serial/OFF launch leaves it undefined and stays byte-identical.
    let worktreeBranch: string | undefined;
    if (deps.worktree !== undefined) {
      const wt = await runWorktreeProducerStep(
        plan,
        launchCwd,
        deps.worktree,
        liveAttrFor(plan.worktree),
      );
      if (!wt.ok) {
        if (wt.retry === true) {
          // A transient not-ready base lane the fan-in pre-merge would blind-conflict
          // on — retry-skip: mint NO sticky, and because this `continue` PRECEDES the
          // inFlight / cooldown / pending-dispatch mint below, consume NO slot,
          // cooldown, or pending row. Route the skip through the SAME ephemeral
          // `lane-provision` rail every other producer ready-launch hold rides, so it
          // is explainable from the withhold surface rather than a lone stderr line.
          // The rail's transition-only emission is the spam bound, so NO parallel
          // per-cycle console.error remains; `withhold()` bounds the reason detail.
          decision.withholds.set(
            plan.id,
            withhold("lane-provision", wt.reason),
          );
          continue;
        }
        deps.emitDispatchFailed({
          verb: plan.verb,
          id: plan.id,
          reason: wt.reason,
          dir: wt.dir,
          conflictedFiles: wt.conflictedFiles ?? null,
          ts: deps.now(),
        });
        continue;
      }
      launchCwd = wt.cwd;
      if (wt.pendingIntegration !== undefined) {
        deps.emitDispatchFailed({
          verb: plan.verb,
          id: plan.id,
          reason: pendingIntegrationReason(wt.pendingIntegration),
          dir: wt.pendingIntegration.laneDir,
          conflictedFiles: null,
          ts: deps.now(),
        });
      }
      // A provisioned lane runs in its worktree, not the shared main checkout.
      // Carry the realpath-normalized lane so the worker's `keeper plan`
      // subprocesses resolve target/primary/state repo to it (and its
      // pwd==TARGET_REPO check matches process.cwd()). Producer-only signal,
      // never a fold input.
      if (plan.worktree !== undefined) {
        worktreeLane = realpath(launchCwd);
        // The pure per-node branch (base / inheriting / closer → base lane;
        // rib → `<base>--<task>`), NOT anything derived from the realpath'd cwd.
        worktreeBranch = plan.worktree.assignment.branch;
      }
    }
    // Provisioning can materialize the prospective lane after the first cwd
    // inventory was empty. Re-probe a worktree geometry's FINAL actual launch
    // cwd, replacing that bounded cache entry, before minting Dispatched or
    // launching. Non-worktree launches reuse the already-checked cached cwd.
    if (resolvedPluginDir !== null) {
      const finalShadow = probeShadowMemoized(resolvedPluginDir, launchCwd, {
        refreshCwd: plan.worktree !== undefined,
      });
      if (finalShadow !== null) {
        deps.emitDispatchFailed({
          verb: plan.verb,
          id: plan.id,
          reason:
            `work-plugin-shadowed: ${finalShadow} — another preloaded ` +
            `'work'-named plugin would steal 'work:worker' from the exact ` +
            `'${resolvedPluginDir}' cell at launch (silent wrong-worker spawn); ` +
            "remove or rename it, then 'keeper retry-dispatch'",
          dir: launchCwd,
          conflictedFiles: null,
          ts: deps.now(),
        });
        continue;
      }
    }
    state.inFlight.add(plan.key);
    // STAMP the cooldown at the SAME point as `inFlight.add`, BEFORE the confirm
    // await, so it covers BOTH the `ok` AND the `indoubt` outcomes — gating on
    // `outcome==="ok"` would leave the slow cold-boot `indoubt` launches
    // re-dispatchable, which IS the headline bug. unit-SECONDS.
    state.redispatchCooldown.set(plan.key, deps.now());
    // STAMP the per-epic finalizer guard at the same point for an epic-level
    // finalizer launch. `isEpicFinalizer` is set ONLY at the close-row push, so
    // a task launch never reaches the guard — explicit flag, not an id heuristic.
    if (plan.isEpicFinalizer) {
      state.finalizerGuard.set(plan.id, deps.now());
    }
    // Rebuild the shell command body when worktree mode re-pointed the cwd, so the
    // drift-guarded `cd <path>` prefix matches the actual launch cwd. (keeper agent
    // reads `spec` + the `cwd` arg, not this string — but keeping them consistent
    // preserves the parity the builders intend.)
    // Rebuild the shell twin when worktree mode re-pointed the cwd OR the seam
    // late-resolved a dir the pure `plan.workerCommand` did not bake (a wrapped
    // candidate: `plan.pluginDir` null, `resolvedPluginDir` the host cell). A
    // native / cell-less launch keeps `plan.workerCommand` byte-identical.
    const workerCommand =
      launchCwd === plan.cwd && resolvedPluginDir === plan.pluginDir
        ? plan.workerCommand
        : buildWorkerCommand(
            plan.verb,
            plan.id,
            launchCwd,
            plan.model,
            plan.effort,
            resolvedPluginDir,
          );
    const argv = buildLaunchArgv(shell, workerCommand);
    const spec = buildPlannedLaunchSpec(
      plan.verb,
      plan.id,
      plan.model,
      plan.effort,
      worktreeLane,
      worktreeBranch,
      resolvedPluginDir,
      // The `worker_provider`-translated dispatched cell + the pin (ADR 0047),
      // null when unconstrained — the always-emitted KEEPER_PLAN_DISPATCHED_* env
      // carriers ride the spec (empty on a byte-identical unconstrained launch).
      plan.dispatchedCellModel ?? null,
      plan.dispatchedCellTier ?? null,
      plan.dispatchConstraint ?? null,
      // The wrapped-cell guard marker (task .1) — present only for a wrapped
      // effective cell, so the KEEPER_WRAPPED_* carriers ride the spec (empty on a
      // native launch, overwriting any stale session-env marker).
      plan.wrappedCell ?? null,
      plan.wrappedEnvelope ?? null,
    );
    // The dispatched-cell forensics recorded on the `Dispatched` event (ADR
    // 0047) — {assigned, effective, constraint} for a cell-bearing `work` launch,
    // effective === assigned when the pin did not translate. Cell-less launches
    // (a `close` row, a task with no cell) carry none.
    const launchCell: DispatchedPayload["cell"] =
      plan.verb === "work" && plan.cellModel != null && plan.tier != null
        ? {
            assigned: { model: plan.cellModel, tier: plan.tier },
            effective: {
              model: plan.dispatchedCellModel ?? plan.cellModel,
              tier: plan.dispatchedCellTier ?? plan.tier,
            },
            constraint: plan.dispatchConstraint ?? null,
          }
        : undefined;
    try {
      const outcome = await confirmRunning(
        plan.verb,
        plan.id,
        launchCwd,
        argv,
        spec,
        signal,
        deps,
        launchCell,
        // CONSUME the fatal-audit one-shot lift at the EXACT launch side effect — the
        // callback fires iff `launch()` ran the closer (ok / aborted-postlaunch / late-bind
        // post-launch indoubt), never on a pre-launch skip. A `work` launch is a no-op here.
        plan.verb === "close"
          ? () => consumeFatalAuditLift(state.fatalAuditFenceMemo, [plan.id])
          : undefined,
      );
      // CLEAR the cooldown only when nothing actually launched: a definitive
      // launch failure (`"failed"`) or a pre-launch abort
      // (`"aborted-prelaunch"`). `failedKeys` then owns stickiness for `failed`,
      // and `retry_dispatch` (which clears `failedKeys`, not worker memory)
      // re-dispatches without waiting out the cooldown. `ok` / `indoubt` /
      // `aborted-postlaunch` KEEP the stamp — the launch DID fire, so a
      // fold-lag-blind re-dispatch could double-launch the worktree.
      if (outcome === "failed" || outcome === "aborted-prelaunch") {
        state.redispatchCooldown.delete(plan.key);
        // The finalizer never ran, so release the per-epic guard too (don't make
        // the sibling finalizer wait out the window for a launch that didn't
        // happen). Lockstep with the cooldown clear.
        if (plan.isEpicFinalizer) {
          state.finalizerGuard.delete(plan.id);
        }
      } else if (outcome === "indoubt") {
        // Re-stamp ONCE at the indoubt resolution: the original stamp (set
        // before the confirm await) is now up to `ceilingMs` stale, so it would
        // expire early relative to the in-doubt launch it must suppress. A SINGLE
        // refresh — never compounding across cycles (re-stamping on every retry
        // is the perpetual-suppression trap). Lockstep with the finalizer guard.
        state.redispatchCooldown.set(plan.key, deps.now());
        if (plan.isEpicFinalizer) {
          state.finalizerGuard.set(plan.id, deps.now());
        }
      } else if (outcome === "suppressed-dup" || outcome === "no-claim") {
        // Both DAMP rather than CLEAR the cooldown (a live attempt already holds
        // the slot): `suppressed-dup` is the durable mint gate suppressing a
        // re-mint of a live/freshly-minted attempt; `no-claim` is this mint's
        // acquire losing to a predecessor's un-released claim. A pre-launch abort
        // clears (nothing launched, so re-dispatch freely), but here re-dispatch
        // must NOT re-arm — clearing re-arms the very loop the damp exists to
        // break (contend→clear→re-dispatch→contend…). `failedKeys` is left
        // untouched (contention, not failure) and no live entry is recorded
        // (this attempt did not launch). Keep the finalizer guard lockstep with
        // the cooldown, as the indoubt arm does.
        state.redispatchCooldown.set(plan.key, deps.now());
        if (plan.isEpicFinalizer) {
          state.finalizerGuard.set(plan.id, deps.now());
        }
      }
      if (outcome === "ok") {
        // Promote to liveDispatches so the reap pass can find it. The per-dispatch
        // `controller` is retained so a future "kill this one" RPC can target a
        // single dispatch without touching siblings.
        liveDispatches.set(plan.key, {
          verb: plan.verb,
          id: plan.id,
          key: plan.key,
          cwd: launchCwd,
          controller: new AbortController(),
        });
      }
      // (The fatal-audit lift consume rides the `onLaunchFired` callback passed to
      // `confirmRunning` above — the exact post-`launch()` side-effect seam, so a late-binding
      // post-launch `indoubt` still consumes while every pre-launch skip does not.)
      // Other outcomes (failed / indoubt / aborted-*) record no live entry; see
      // the ConfirmOutcome doc and the stamp handling above. `inFlight` is
      // released for all in the `finally`.
    } finally {
      state.inFlight.delete(plan.key);
    }
  }

  // CLASSIFICATION-COMPLETION point: the launch pass has now populated every
  // producer-side ready-launch hold (lane provisioning) into `decision.withholds`,
  // joining the pure core's holds. PUBLISH the withhold rail HERE — never the
  // caller's `finally` — so the replace-merge only ever runs against a fully
  // classified frame. A pre-completion abort (`signal.aborted` early return) or a
  // throw from refresh/assemble/provision never reaches this line, so the prior
  // frame is PRESERVED intact: a partial map's absent producer keys can no longer be
  // mistaken for authoritative clears (which would drop a standing hold silently and
  // re-emit it as a phantom transition next complete cycle). Placed BEFORE the
  // finalize tail so a finalize-tail throw cannot discard this completed frame.
  if (withholdFramePublish !== undefined) {
    updateWithholdFrameState(
      withholdFramePublish.state,
      decision.withholds,
      deps.now(),
      withholdFramePublish.emit,
    );
  }

  // Worktree-finalize pass. For each epic whose closer reached done this
  // cycle, verify the owner-integrated local default, push once, and tear the lanes down. Runs AFTER the launch loop (the closer that landed the
  // close commit on `keeper/epic/<id>` is already gone — the cap-1 lane + the
  // readiness gate guarantee no agent is live in the base when this fires). Driven
  // from THIS producer step (not the recent-done reap window) so it never depends
  // on `DONE_EPICS_REAP_WINDOW_SEC`. A GENUINE block (a content merge conflict /
  // dirty-LANE teardown refusal) mints a sticky `worktree-finalize` DispatchFailed
  // keyed on the close row (cleared by `retry_dispatch`) and STOPS that epic's
  // finalize. A transient shared-checkout state (dirty/off-branch main checkout)
  // instead returns `retry` → STOP with NO sticky row, retried next cycle — but a
  // genuine origin-ahead non-ff is NOT a retry-skip: it mints a VISIBLE sticky
  // `worktree-finalize-non-fast-forward` block needing an operator. Idempotent:
  // `finalizeEpic` skips an already-merged base + resumes a partial teardown
  // (already-gone worktrees no-op).
  if (deps.worktree !== undefined) {
    // A CLUSTERED epic's NON-PRIMARY worktree groups have no close worker to
    // provision their sink. Prepare those sinks here; a pending integration is
    // recorded on `close::<epic>` and prevents finalize from treating the base as
    // assembled. EMPTY for single-repo epics.
    const provisionFailed = new Set<string>();
    for (const sink of decision.worktreeSinkProvision) {
      if (signal.aborted) {
        return;
      }
      const sinkHold = probeLaneMaintenance(laneMaintenanceProbe, {
        path: sink.assignment.worktreePath,
        epicId: closeKeyEpicId(sink),
        taskId: null,
      });
      if (sinkHold.kind === "defer") {
        provisionFailed.add(`${closeKeyEpicId(sink)}\0${sink.repoDir}`);
        logLaneMaintenanceDeferralOnce(
          "worktree-sink-provision-deferred",
          sink.assignment.worktreePath,
          sinkHold.reason,
          laneDeferralsSeen,
        );
        continue;
      }
      const provisioned = await deps.worktree.provision(
        sink,
        liveAttrFor(sink),
      );
      // A provision failure — genuine OR a transient retry-skip — ADDS to
      // `provisionFailed` below so this group's finalize is skipped either way (its
      // base is not assembled). Only a GENUINE block mints the sticky `close::<epic>`.
      if (!provisioned.ok) {
        provisionFailed.add(`${closeKeyEpicId(sink)}\0${sink.repoDir}`);
        if (provisioned.retry === true) {
          // A transient not-ready base lane — retry-skip: mint NO sticky
          // `close::<epic>` row; the next cycle retries once the base settles.
          console.error(
            `[autopilot-worker] provision close::${closeKeyEpicId(sink)} (${sink.repoDir}): ${provisioned.reason}`,
          );
        } else {
          // `provisioned.dir` carries the sink's LANE worktree path for a fan-in
          // pre-merge failure, so this `close::<epic>` row keys on the lane path the
          // recover pass's reason-scoped level-clear matches on (a self-clearing
          // `worktree-lane-premerge` row, mirroring the work-cell twin). A genuine
          // conflict carries no `dir` → the repo toplevel, an operator-cleared sticky.
          deps.emitDispatchFailed({
            verb: "close",
            id: closeKeyEpicId(sink),
            reason: provisioned.reason,
            dir: provisioned.dir ?? sink.repoDir,
            conflictedFiles: provisioned.conflictedFiles ?? null,
            ts: deps.now(),
          });
        }
      } else if (provisioned.pendingIntegration !== undefined) {
        provisionFailed.add(`${closeKeyEpicId(sink)}\0${sink.repoDir}`);
        deps.emitDispatchFailed({
          verb: "close",
          id: closeKeyEpicId(sink),
          reason: pendingIntegrationReason(provisioned.pendingIntegration),
          dir: provisioned.pendingIntegration.laneDir,
          conflictedFiles: null,
          ts: deps.now(),
        });
      }
    }
    // Track the per-repo finalize keys that finalized CLEAN this cycle so the
    // level-clear after the loop drops their open row. Per-repo keys
    // (`close::worktree-finalize:<epic>-<repoHash>`) keep the N finalizes of one
    // clustered epic on DISTINCT rows — never colliding on the single `close::<epic>`
    // key or on a recover row (a distinct token).
    const finalizedClean = new Set<string>();
    for (const info of decision.worktreeFinalize) {
      if (signal.aborted) {
        return;
      }
      // A group whose fan-in provision failed above must NOT finalize — its base is
      // not assembled, so merging it would push incomplete work to default.
      if (provisionFailed.has(`${closeKeyEpicId(info)}\0${info.repoDir}`)) {
        continue;
      }
      const finalizeKey = worktreeFinalizeDispatchId(
        closeKeyEpicId(info),
        info.repoDir,
      );
      const finalizeHold = probeLaneMaintenance(laneMaintenanceProbe, {
        path: info.assignment.worktreePath,
        epicId: closeKeyEpicId(info),
        taskId: null,
      });
      if (finalizeHold.kind === "defer") {
        logLaneMaintenanceDeferralOnce(
          "worktree-finalize-deferred",
          info.assignment.worktreePath,
          finalizeHold.reason,
          laneDeferralsSeen,
        );
        continue;
      }
      const result = await deps.worktree.finalizeEpic(
        info,
        deps.isEpicDone,
        deps.runMergeSuite,
        // A COMPLETED lane teardown nudges the git vanished sweep so it retires
        // the lane's git_status row promptly, not at the next full sweep. Fired
        // only on an actual removal — never on a hold-deferred/failed teardown.
        () => deps.nudgeVanishedSweep?.(),
      );
      if (result.ok) {
        // Clean finalize (base merged + torn down) OR the lane is already gone —
        // eligible to level-clear this repo's synthetic row below.
        finalizedClean.add(finalizeKey);
      } else if (result.retry !== true) {
        // A GENUINE block (a content conflict, a dirty-lane refusal, OR an
        // origin-ahead non-ff) becomes this repo's sticky finalize row. A `retry`
        // failure is a transient environment skip (dirty/off-branch main checkout):
        // STOP this group's finalize but mint NO sticky DispatchFailed — the next
        // cycle retries once the tree settles, and it must never clear a pre-existing
        // operator block it could not re-observe this cycle.
        deps.emitDispatchFailed({
          verb: "close",
          id: finalizeKey,
          reason: result.reason,
          dir: info.repoDir,
          conflictedFiles: result.conflictedFiles ?? null,
          ts: deps.now(),
        });
      }
    }
    // Producer level-triggered auto-clear, mirroring `recoverFailuresToClear`: an
    // OPEN per-repo finalize row whose repo finalized clean this cycle self-clears, so
    // an operator who reconciles origin never needs `retry_dispatch`. Scoped to OPEN
    // `worktree-finalize:*` ids AND gated on an actual clean finalize this cycle, so a
    // transient skip or a paused cycle (empty `finalizedClean`) never dismisses a live
    // block, and a still-failing group's sticky row is preserved.
    for (const id of decision.finalizeFailureIds) {
      if (finalizedClean.has(id)) {
        deps.emitDispatchCleared(
          dispatchClearedPayload(dispatchFailureFences, "close", id),
        );
      }
    }
  }
  // A lane this cycle stopped deferring ends its episode, so a LATER hold on the
  // same lane reports afresh instead of staying silent behind the latch.
  pruneLaneMaintenanceDeferralLatch(
    CYCLE_LANE_DEFERRAL_PASSES,
    laneDeferralsSeen,
  );
}

/**
 * The epic id a worktree-finalize `WorktreeLaunchInfo` belongs to. It always carries
 * the synthetic close-sink assignment, whose branch is `keeper/epic/<epicId>`; strip
 * the `keeper/epic/` prefix back to the epic id. A finalize block feeds this into
 * {@link worktreeFinalizeDispatchId} for the PER-REPO row key; a non-primary group's
 * fan-in provision failure still keys on this bare epic id (`close::<epicId>`) so the
 * daemon merge-escalation sweep's `planner@<epicId>` resolves.
 */
function closeKeyEpicId(info: WorktreeLaunchInfo): string {
  const prefix = "keeper/epic/";
  return info.baseBranch.startsWith(prefix)
    ? info.baseBranch.slice(prefix.length)
    : info.baseBranch;
}

/**
 * The producer's per-launch worktree step (the side-effect seam between
 * the pure plan and `confirmRunning`). Returns the cwd to launch into on success,
 * or a `{ ok:false, reason, dir }` the caller mints as a sticky `DispatchFailed`.
 * Two branches, mutually exclusive per the geometry the pure post-pass stamped
 * (a `worktreeReject` launch never reaches here — the caller short-circuits it
 * AHEAD of the cwd-missing stat):
 *  - `worktree` → provision the lane, record any pending fan-in integration, and
 *    launch into the worktree path.
 *  - neither → OFF mode: assert the launch cwd is on the resolved default branch.
 */
async function runWorktreeProducerStep(
  plan: PlannedLaunch,
  launchCwd: string,
  driver: WorktreeDriver,
  liveAttributedDirty: ReadonlySet<string> | null,
): Promise<
  | {
      ok: true;
      cwd: string;
      pendingIntegration?: PendingIntegrationManifest;
    }
  | {
      ok: false;
      reason: string;
      dir: string;
      retry?: boolean;
      conflictedFiles?: string[];
    }
> {
  if (plan.worktree !== undefined) {
    const provisioned = await driver.provision(
      plan.worktree,
      liveAttributedDirty,
    );
    if (!provisioned.ok) {
      // `retry` propagates a transient finalize/close-sink retry-skip so the caller
      // mints NO sticky; a genuine block carries no `retry`. `dir` propagates the LANE
      // worktree path for a fan-in pre-merge failure (a `worktree-lane-premerge` row),
      // so the minted `work::<taskId>` row keys its `dir` on the lane path the recover
      // pass's reason-scoped level-clear matches on; else the launch cwd.
      return {
        ok: false,
        reason: provisioned.reason,
        dir: provisioned.dir ?? launchCwd,
        retry: provisioned.retry,
        conflictedFiles: provisioned.conflictedFiles,
      };
    }
    return {
      ok: true,
      cwd: provisioned.cwd,
      pendingIntegration: provisioned.pendingIntegration,
    };
  }
  // OFF mode (driver present, no worktree geometry): on-default-branch assertion.
  const onDefault = await driver.assertOnDefaultBranch(launchCwd);
  if (!onDefault.ok) {
    return { ok: false, reason: onDefault.reason, dir: launchCwd };
  }
  return { ok: true, cwd: launchCwd };
}

/**
 * Build the production {@link WorktreeDriver} wrapping `worktree-git.ts`.
 * Every method shells real git on the target repo (a producer side effect, never
 * a fold). The `run` GitRunner is injectable so the slow real-git test drives the
 * lifecycle and the fast tier fakes it; production passes the default `gitExec`.
 *
 * Provision: ensure the node's worktree exists off its deterministic parent tip,
 * preserve the lossless-clean/readiness guard for the first pending fan-in, and
 * return its manifest without merging. Finalize verifies owner integration in the
 * shared checkout, pushes once, and tears the lanes down. assertOnDefaultBranch:
 * `currentBranch(cwd) === resolveDefaultBranch`.
 */
type FanInAssemblyProbe =
  | { kind: "assembled" }
  | { kind: "pending"; sourceBranch: string }
  | { kind: "inconclusive"; sourceBranch: string; detail: string };

async function probeFanInAssembly(
  info: WorktreeLaunchInfo,
  run: WorktreeGitRunner,
): Promise<FanInAssemblyProbe> {
  const seen = new Set<string>();
  for (const lane of info.laneOrder) {
    const source = lane.branch;
    if (source === info.baseBranch || seen.has(source)) continue;
    seen.add(source);
    const present = await run(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${source}`],
      { cwd: info.repoDir, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
    );
    if (present.code === 1) continue;
    if (present.code !== 0) {
      return {
        kind: "inconclusive",
        sourceBranch: source,
        detail: `branch probe exited ${present.code}`,
      };
    }
    const ancestor = await run(
      ["merge-base", "--is-ancestor", source, info.baseBranch],
      { cwd: info.repoDir, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
    );
    if (ancestor.code === 0) continue;
    if (ancestor.code === 1) {
      return { kind: "pending", sourceBranch: source };
    }
    return {
      kind: "inconclusive",
      sourceBranch: source,
      detail: `ancestry probe exited ${ancestor.code}`,
    };
  }
  return { kind: "assembled" };
}

export function createWorktreeDriver(
  run: WorktreeGitRunner = gitExec,
  // Optional commit-work flock acquirer for the base merge's ref advance + resync
  // (the finalize sibling of the acquirer the recover pass threads). Omitted in
  // production → the default deadline-bounded FFI flock; the fast tier injects a
  // stub so the plumbing merge never touches the real flock.
  acquireLock?: LockAcquirer,
  // Optional desync seed sink — called with the shared checkout's repo dir whenever a
  // base→default merge (finalize OR the recover pass's pass-2 backstop) advanced the ref
  // but the checkout's resync was skipped/aborted, so it trails the default tip. The loop
  // records the dir into its in-memory latch, which the per-cycle probe then watches +
  // escalates. Omitted (fake-deps / direct-call tests) → a no-op, byte-identical merge.
  onResyncSkipped?: (repoDir: string) => void,
  ownerMediatedFinalize = false,
  recoverMergeSuite?: MergeSuiteProbe,
  scheduleSuiteRetry?: () => void,
): WorktreeDriver {
  // Terminal verdicts are cached by merged commit so retries never recompute an
  // unchanged merge. Transient and load-suspect verdicts always recompute.
  const mergeSuiteMemo = new Map<string, MergeSuiteVerdict>();
  const mergeSuiteLoadRetries = createMergeSuiteLoadRetryTracker();
  return {
    async refreshBase(entry, nowSeconds) {
      const baseBranch = baseBranchFor(entry.epic_id);
      const baseWorktreePath = worktreePathFor(entry.repo_dir, baseBranch);
      const retry = (
        reason: string,
      ): { ok: false; reason: string; retry: true } => ({
        ok: false,
        retry: true,
        reason,
      });
      try {
        const defaultBranch = await gitResolveDefaultBranch(
          entry.repo_dir,
          run,
        );
        const ready = await gitMergeReadiness(
          baseWorktreePath,
          baseBranch,
          run,
          defaultBranch,
          undefined,
          entry.repo_dir,
        );
        if (ready.kind !== "ready") {
          return retry(
            `worktree-base-refresh-not-quiescent: ${baseWorktreePath} is ${ready.kind} — deferring the default-into-base merge`,
          );
        }

        const marker = `Merge branch '${defaultBranch}'`;
        const lastRefresh = await run(
          [
            "log",
            "-1",
            "--format=%ct",
            "--first-parent",
            "--merges",
            "--fixed-strings",
            `--grep=${marker}`,
            baseBranch,
          ],
          { cwd: baseWorktreePath, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
        );
        if (lastRefresh.code !== 0) {
          return retry(
            `worktree-base-refresh-cooldown-inconclusive: could not read the last refresh merge for ${baseBranch}`,
          );
        }
        const lastRefreshAt = Number.parseInt(lastRefresh.stdout.trim(), 10);
        if (
          Number.isFinite(lastRefreshAt) &&
          nowSeconds - lastRefreshAt < BASE_REFRESH_COOLDOWN_SEC
        ) {
          return { ok: true };
        }

        const merge = await gitMergeBranchInto(
          baseWorktreePath,
          defaultBranch,
          run,
          acquireLock,
        );
        switch (merge.kind) {
          case "merged":
          case "already-merged":
            return { ok: true };
          case "conflict":
          case "abort-failed":
          case "merge-failed":
          case "merge-inconclusive":
            return retry(
              `worktree-base-refresh-${merge.kind}: default drift into ${baseBranch} deferred — ${merge.stderr}`,
            );
          case "lock-timeout":
          case "local-timeout":
          case "missing-source":
            return retry(
              `worktree-base-refresh-${merge.kind}: deferring the merge of ${defaultBranch} into ${baseBranch}`,
            );
          default:
            assertNever(merge);
        }
      } catch (err) {
        return retry(
          `worktree-base-refresh-inconclusive: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    async provision(info, liveAttributedDirty) {
      const { assignment, repoDir, parentBranch } = info;
      const { branch, worktreePath, preMerges } = assignment;
      try {
        // Fork the lane off the PRIMARY parent's branch tip. A rib forks off its
        // (already-committed) parent lane. The BASE lane's "parent" is its own
        // branch — which does NOT exist yet, since THIS add is what creates it —
        // so fork off the repo's resolved default branch instead. An inheriting
        // node's lane already exists, so `ensureWorktree` no-ops and the source is
        // unused. `ensureWorktree` is idempotent + crash-recoverable.
        const forkSource =
          parentBranch === branch
            ? await gitResolveDefaultBranch(repoDir, run)
            : parentBranch;
        await gitEnsureWorktree(repoDir, worktreePath, branch, forkSource, run);
        // `isResidueOnlyDir` vetoes husk sweeping on any symlink, so these lanes
        // rely on bounded-teardown force removal. Sharing this mutable store is
        // deliberate: source and lane are on one host and filesystem.
        await gitEnsureWorktreeDepLink(repoDir, worktreePath);
        let pendingIntegration: PendingIntegrationManifest | undefined;
        for (const source of preMerges) {
          const srcRef = await run(
            [
              "rev-parse",
              "--quiet",
              "--verify",
              "--end-of-options",
              `refs/heads/${source}^{commit}`,
            ],
            { cwd: worktreePath, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
          );
          if (srcRef.code === 1) {
            continue;
          }
          if (srcRef.code !== 0) {
            return {
              ok: false,
              dir: worktreePath,
              reason: `${WORKTREE_LANE_PREMERGE_REASON_PREFIX}-not-ready: source probe for ${source} exited ${srcRef.code} before merging into ${branch} — deferring the fan-in`,
            };
          }
          const ancestor = await run(
            ["merge-base", "--is-ancestor", source, "HEAD"],
            {
              cwd: worktreePath,
              timeoutMs: GIT_LOCAL_TIMEOUT_MS,
            },
          );
          if (ancestor.code === 0) {
            continue;
          }
          if (ancestor.code !== 1) {
            return {
              ok: false,
              dir: worktreePath,
              reason: `${WORKTREE_LANE_PREMERGE_REASON_PREFIX}-not-ready: ancestry probe for ${source} into ${branch} exited ${ancestor.code} — deferring the fan-in`,
            };
          }

          const ready = await gitMergeReadiness(
            worktreePath,
            branch,
            run,
            source,
            undefined,
            repoDir,
          );
          if (ready.kind === "dirty") {
            const cleaned = await gitLosslessPremergeClean(
              worktreePath,
              branch,
              source,
              liveAttributedDirty,
              run,
            );
            if (cleaned.kind === "retry") {
              return {
                ok: false,
                dir: worktreePath,
                reason: `${WORKTREE_LANE_PREMERGE_REASON_PREFIX}-dirty-base: deferring the fan-in merge of ${source} into ${branch} — ${cleaned.reason}`,
              };
            }
          } else if (ready.kind !== "ready") {
            return {
              ok: false,
              dir: worktreePath,
              reason: `${WORKTREE_LANE_PREMERGE_REASON_PREFIX}-not-ready: base ${worktreePath} is ${ready.kind} before merging ${source} into ${branch} — deferring the fan-in`,
            };
          }

          // Pin the durable head fence at mint: the source rib tip (already
          // resolved by `srcRef` above) and the target base tip, both by their
          // shared-object-store refs as FULL object ids. VALIDATE both as full ids
          // (an inconclusive probe or an abbreviated id DEFERS a self-clearing
          // lane-premerge retry rather than minting a fence-less or partial-pin
          // incident), then PROVE the fast-forward precondition — the base must be
          // an ancestor of the source — before minting the pinned-pending class. A
          // diverged or inconclusive pair DEFERS: a genuine divergence is NOT the
          // requested clean fast-forward and needs its own separately minted
          // genuine-conflict instance, so the pinned class is only ever a real FF.
          const sourceHead = srcRef.stdout.trim();
          const baseRef = await run(
            [
              "rev-parse",
              "--quiet",
              "--verify",
              "--end-of-options",
              `refs/heads/${branch}^{commit}`,
            ],
            { cwd: worktreePath, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
          );
          const baseHead = baseRef.stdout.trim();
          if (
            baseRef.code !== 0 ||
            !isFullObjectId(sourceHead) ||
            !isFullObjectId(baseHead)
          ) {
            return {
              ok: false,
              dir: worktreePath,
              reason: `${WORKTREE_LANE_PREMERGE_REASON_PREFIX}-not-ready: head fence probe for ${source} into ${branch} exited ${baseRef.code} — deferring the fan-in`,
            };
          }
          const ffPrecondition = await run(
            ["merge-base", "--is-ancestor", baseHead, sourceHead],
            { cwd: worktreePath, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
          );
          if (ffPrecondition.code !== 0) {
            return {
              ok: false,
              dir: worktreePath,
              reason: `${WORKTREE_LANE_PREMERGE_REASON_PREFIX}-not-ready: fast-forward precondition (${branch} not contained in ${source}) exited ${ffPrecondition.code} — deferring the fan-in`,
            };
          }
          pendingIntegration = {
            sourceBranch: source,
            baseBranch: branch,
            laneDir: worktreePath,
            sourceHead,
            baseHead,
          };
          break;
        }
        // Assert HEAD == derived branch AND the worktree is registered.
        const registered = await gitListWorktrees(repoDir, run);
        const entry = registered.find(
          (e) =>
            stripTrailingSlashPath(e.path) ===
            stripTrailingSlashPath(worktreePath),
        );
        if (entry === undefined) {
          return {
            ok: false,
            reason: `worktree-unregistered: ${worktreePath} is not a registered worktree`,
          };
        }
        const head = await gitCurrentBranch(worktreePath, run);
        if (head !== branch) {
          return {
            ok: false,
            reason: `worktree-head-mismatch: ${worktreePath} HEAD is ${head}, expected ${branch}`,
          };
        }
        return pendingIntegration === undefined
          ? { ok: true, cwd: worktreePath }
          : { ok: true, cwd: worktreePath, pendingIntegration };
      } catch (err) {
        return {
          ok: false,
          reason: `worktree-provision-failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
    async assembleBase(info, liveAttributedDirty) {
      const { assignment, repoDir, parentBranch } = info;
      const { branch, worktreePath, preMerges } = assignment;
      try {
        // Ensure the sink base worktree exists off the resolved default (a base
        // lane's "parent" is its own not-yet-existing branch → fork off default),
        // mirroring provision's ensure discipline exactly.
        const forkSource =
          parentBranch === branch
            ? await gitResolveDefaultBranch(repoDir, run)
            : parentBranch;
        // Structural preflight, FOUR-STATED: a transient wedge (a 124 SIGKILL) OR an
        // UNKNOWN read (an empty/malformed list, a nonzero prune, a branch-probe 128)
        // DEFERS with no row; only a POSITIVELY-OBSERVED structural fact (a path on the
        // WRONG branch, a failed `worktree add`) is a VISIBLE `failed`. `ensure`
        // guarantees the worktree is registered on `branch`, so no separate list-and-
        // find registration check is needed (the plain list collapses UNKNOWN to a
        // false `unregistered` sticky).
        const ensured = await gitEnsureWorktreeResult(
          repoDir,
          worktreePath,
          branch,
          forkSource,
          run,
        );
        if (ensured.kind === "timeout" || ensured.kind === "inconclusive") {
          return {
            kind: "defer",
            reason: `worktree-preclose-ensure-${ensured.kind}: could not confirm ${worktreePath} on ${branch}${ensured.kind === "inconclusive" ? ` — ${ensured.detail}` : ""} — deferring the pre-close fan-in`,
          };
        }
        if (ensured.kind === "error") {
          return {
            kind: "failed",
            reason: `worktree-assemble-failed: ${ensured.detail}`,
          };
        }
        await gitEnsureWorktreeDepLink(repoDir, worktreePath);
        // Belt-and-suspenders positive HEAD confirmation. Only a POSITIVELY-OBSERVED
        // wrong branch is structural; a timeout / UNKNOWN read defers.
        const headRes = await gitCurrentBranchResult(worktreePath, run);
        if (headRes.kind === "timeout" || headRes.kind === "inconclusive") {
          return {
            kind: "defer",
            reason: `worktree-preclose-head-${headRes.kind}: could not read ${worktreePath} HEAD${headRes.kind === "inconclusive" ? ` — ${headRes.detail}` : ""} — deferring the pre-close fan-in`,
          };
        }
        if (headRes.kind === "error") {
          return {
            kind: "failed",
            reason: `worktree-head-read-failed: ${worktreePath} — ${headRes.detail}`,
          };
        }
        if (headRes.value !== branch) {
          return {
            kind: "failed",
            reason: `worktree-head-mismatch: ${worktreePath} HEAD is ${headRes.value}, expected ${branch}`,
          };
        }
        // INTEGRATE every clean rib into the base under the commit-work lock — the
        // SAME pairwise, lock-guarded routine refreshBase/finalize reuse, never a
        // second merge path. A CLEAN content-conflict abort is RECORDED and the scan
        // CONTINUES, so a conflicting rib never strands the CLEAN ribs after it (their
        // absence would wedge the close's ancestry gate). But a later clean merge
        // MONOTONICALLY advances the base, which can make an earlier-recorded conflict
        // now mergeable — so the FULL source scan iterates to a FIXED POINT: while any
        // clean merge happened AND conflicts remain, re-scan against the advanced base
        // (already-merged sources skip, so each source merges at most once — termination
        // is bounded by the source count). A `conflict` is returned ONLY from a
        // NO-PROGRESS pass, so it is positively current on the final unchanged base and
        // never burns a scarce incident attachment on stale evidence. A structural
        // failure / defer short-circuits (precedence unchanged); a dirty base losslessly
        // cleans only a provably-redundant rib leak; a not-ready base defers.
        let conflicts: {
          source: string;
          conflictedFiles: string[];
          stderr: string;
        }[] = [];
        // Bounded by the source count: at most one clean merge per source can make
        // progress, so a no-progress pass (the loop's natural exit) always precedes this.
        for (let scan = 0; scan <= preMerges.length; scan++) {
          conflicts = [];
          let progress = false;
          for (const source of preMerges) {
            const ready = await gitMergeReadiness(
              worktreePath,
              branch,
              run,
              source,
              undefined,
              repoDir,
            );
            if (ready.kind === "dirty") {
              const cleaned = await gitLosslessPremergeClean(
                worktreePath,
                branch,
                source,
                liveAttributedDirty,
                run,
              );
              if (cleaned.kind === "retry") {
                return {
                  kind: "defer",
                  reason: `${WORKTREE_LANE_PREMERGE_REASON_PREFIX}-dirty-base: deferring the pre-close fan-in of ${source} into ${branch} — ${cleaned.reason}`,
                };
              }
            } else if (ready.kind !== "ready") {
              return {
                kind: "defer",
                reason: `${WORKTREE_LANE_PREMERGE_REASON_PREFIX}-not-ready: base ${worktreePath} is ${ready.kind} before merging ${source} into ${branch} — deferring the pre-close fan-in`,
              };
            }
            const merge = await gitMergeBranchInto(
              worktreePath,
              source,
              run,
              acquireLock,
            );
            switch (merge.kind) {
              case "merged":
                progress = true; // a monotonic ancestry advance — re-scan afterward
                continue;
              case "already-merged":
              case "missing-source":
                continue;
              case "conflict":
                // RECORD the (cleanly-aborted) conflict and CONTINUE the scan so the
                // clean suffix is still assembled — do NOT return early.
                conflicts.push({
                  source,
                  conflictedFiles: merge.conflictedFiles,
                  stderr: merge.stderr,
                });
                continue;
              case "abort-failed":
                return {
                  kind: "failed",
                  reason: `worktree-preclose-abort-failed: the guarded git merge --abort left ${worktreePath} mid-merge while merging ${source} into ${branch} — ${merge.stderr}`,
                };
              case "merge-failed":
                // A non-content STRUCTURAL merge failure — a visible failure, NOT the
                // content-conflict resolver path.
                return {
                  kind: "failed",
                  reason: `worktree-preclose-merge-failed: merging ${source} into ${branch} in ${worktreePath} is a non-content structural failure — ${merge.stderr}`,
                };
              case "merge-inconclusive":
                // The merge's class could not be positively determined (an inconclusive
                // merge-state probe or a signal disagreement) — retry next cycle; never a
                // false structural sticky or a resolver route.
                return {
                  kind: "defer",
                  reason: `worktree-preclose-merge-inconclusive: could not classify merging ${source} into ${branch} in ${worktreePath} — retrying — ${merge.stderr}`,
                };
              case "lock-timeout":
              case "local-timeout":
                return {
                  kind: "defer",
                  reason: `worktree-preclose-${merge.kind}: deferring the pre-close fan-in of ${source} into ${branch}`,
                };
              default:
                assertNever(merge);
            }
          }
          // Fixed point: no conflicts (done), or no clean merge this pass (the conflicts
          // are stuck on the final base → positively current). Only a pass that made
          // progress AND still has conflicts re-scans against the advanced base.
          if (conflicts.length === 0 || !progress) {
            break;
          }
        }
        if (conflicts.length > 0) {
          // Route the FIRST conflict — from a NO-PROGRESS pass, so it is positively
          // current on the final base; later conflicts surface as the producer re-enters
          // once this one is resolved.
          const first = conflicts[0];
          if (first !== undefined) {
            return {
              kind: "conflict",
              sourceBranch: first.source,
              baseBranch: branch,
              laneDir: worktreePath,
              conflictedFiles: first.conflictedFiles,
              stderr: first.stderr,
            };
          }
        }
        // (c) POSITIVELY re-probe that EVERY source is an ancestor of the base before
        // authorizing the close — the SAME assembly gate finalize verifies.
        const assembly = await probeFanInAssembly(info, run);
        if (assembly.kind === "assembled") {
          return { kind: "assembled" };
        }
        if (assembly.kind === "pending") {
          return {
            kind: "defer",
            reason: `worktree-preclose-pending-integration: ${assembly.sourceBranch} is not an ancestor of ${branch} after the fan-in`,
          };
        }
        return {
          kind: "defer",
          reason: `worktree-preclose-pending-integration: could not prove ${assembly.sourceBranch} is integrated into ${branch} — ${assembly.detail}`,
        };
      } catch (err) {
        return {
          kind: "failed",
          reason: `worktree-assemble-failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
    async finalizeEpic(info, isEpicDone, runMergeSuite, onLaneTornDown) {
      const { repoDir, baseBranch, baseWorktreePath, laneOrder } = info;
      try {
        // A never-forked epic (a `done` epic that completed before worktree mode,
        // or one whose work landed straight on the default branch) has no
        // `keeper/epic/<id>` base branch — nothing to merge or tear down, so skip
        // cleanly. Mirrors recover pass-2, which is naturally safe by sourcing its
        // candidates from live branches; the finalize set comes from `completedRowIds`
        // (every done epic) instead, so it must guard the branch itself.
        if (!(await gitBranchExists(repoDir, baseBranch, run))) {
          return { ok: true };
        }
        // The producer-observable finalize trigger (`closerFinishedIds`)
        // flags this epic for ANY finished closer job, even a CRASHED one that
        // committed code-but-not-`done`; merging that lane would push incomplete
        // work to the default branch. Confirm the epic is DONE in the MAIN
        // projection first: the closer writes `done` to the PRIMARY repo (plan
        // state always = primary, never the lane), so the projection — not a
        // lane-read — is the authority on real completion. Not done → no-op
        // cleanly; the readiness gate re-dispatches the closer and a later cycle
        // retries once the done commit lands. Mirrors recover pass-2's `isEpicDone`
        // guard (the lane-ahead half is the shared routine's `not-ahead` check).
        const epicId = closeKeyEpicId(info);
        if (!(await isEpicDone(epicId))) {
          // Diagnose the silent no-op: a finished closer that has NOT yet folded
          // `done` into the main projection (the merge defers to a later cycle).
          console.error(
            `[autopilot-worker] finalize ${epicId}: done-guard miss — closer finished but epic not yet done in the main projection; deferring the base merge`,
          );
          return { ok: true };
        }
        const defaultBranch = await gitResolveDefaultBranch(repoDir, run);
        // A degrade that mints NO sticky DispatchFailed (retry:true) is otherwise
        // invisible; log it so the silent finalize skip paths stay diagnosable.
        const retrySkip = (
          reason: string,
        ): { ok: false; reason: string; retry: true } => {
          console.error(`[autopilot-worker] finalize ${epicId}: ${reason}`);
          return { ok: false, retry: true, reason };
        };
        const assembly = await probeFanInAssembly(info, run);
        if (assembly.kind === "pending") {
          return retrySkip(
            `worktree-finalize-pending-integration: ${assembly.sourceBranch} is not an ancestor of ${baseBranch}`,
          );
        }
        if (assembly.kind === "inconclusive") {
          return retrySkip(
            `worktree-finalize-pending-integration: could not prove ${assembly.sourceBranch} is integrated into ${baseBranch} — ${assembly.detail}`,
          );
        }
        if (!ownerMediatedFinalize) {
          if (
            runMergeSuite !== undefined &&
            !(await gitIsAncestorOf(repoDir, baseBranch, defaultBranch, run))
          ) {
            const prospect = await computeProspectiveMerge(
              repoDir,
              baseBranch,
              defaultBranch,
              run,
            );
            if (prospect.kind === "computed") {
              let verdict = mergeSuiteMemo.get(prospect.newValue);
              if (verdict === undefined) {
                const runsPlanSuite = await mergeIntroducesPlanChange(
                  repoDir,
                  prospect.defaultTip,
                  prospect.newValue,
                  run,
                );
                const runsSmokeGate = await mergeIntroducesLoadSurfaceChange(
                  repoDir,
                  prospect.defaultTip,
                  prospect.newValue,
                  run,
                );
                verdict = await runMergeSuite({
                  repoDir,
                  mergedCommit: prospect.newValue,
                  runsPlanSuite,
                  runsSmokeGate,
                });
                if (
                  verdict.kind !== "cannot-run" &&
                  verdict.kind !== "load-suspect"
                ) {
                  mergeSuiteMemo.set(prospect.newValue, verdict);
                }
              }
              const suiteRowKey = dispatchKey(
                "close",
                worktreeFinalizeDispatchId(epicId, repoDir),
              );
              const loadAction = mergeSuiteLoadRetries.step({
                rowKey: suiteRowKey,
                mergedCommit: prospect.newValue,
                verdict,
              });
              if (verdict.kind === "red") {
                return {
                  ok: false,
                  reason: `${WORKTREE_FINALIZE_SUITE_RED_REASON}: the fast suite failed against the prospective merge of ${baseBranch} into ${defaultBranch} in ${repoDir} (merged commit ${prospect.newValue}) — ${verdict.detail}`,
                };
              }
              if (verdict.kind === "load-suspect") {
                if (loadAction === "retry") {
                  scheduleSuiteRetry?.();
                  return retrySkip(
                    `worktree-finalize-suite-gate-load-suspect: the merge-suite gate for ${baseBranch} into ${defaultBranch} in ${repoDir} was load-suspect (${verdict.detail}) — retrying once on the next producer cycle`,
                  );
                }
                return {
                  ok: false,
                  reason: `${WORKTREE_FINALIZE_SUITE_RED_REASON}: the fast suite failed against the prospective merge of ${baseBranch} into ${defaultBranch} in ${repoDir} (merged commit ${prospect.newValue}) — ${verdict.detail}`,
                };
              }
              if (verdict.kind === "cannot-run") {
                return retrySkip(
                  `worktree-finalize-suite-gate-unavailable: the merge-suite gate for ${baseBranch} into ${defaultBranch} in ${repoDir} could not run (${verdict.detail}) — deferring the base merge until the gate can run`,
                );
              }
            }
          }
          const merge = await mergeLaneBaseIntoDefault(
            repoDir,
            baseBranch,
            defaultBranch,
            run,
            acquireLock,
            () => onResyncSkipped?.(repoDir),
          );
          switch (merge.kind) {
            case "off-branch":
              return retrySkip(
                `worktree-finalize-off-branch: ${repoDir} HEAD is ${merge.head}, expected ${defaultBranch} — skipping the base merge until the checkout returns to the default branch`,
              );
            case "dirty":
              return retrySkip(
                `worktree-finalize-dirty-checkout: ${repoDir} has a dirty working tree — skipping the base merge until it is clean — ${merge.detail}`,
              );
            case "mid-merge":
              return retrySkip(
                `worktree-finalize-mid-merge: ${repoDir} is mid-merge (owner=${merge.owner}, autostash=${merge.autostash}, MERGE_HEAD=${merge.mergeHead}) — skipping the base merge of ${baseBranch} until the checkout is clean (${merge.owner === "keeper" ? "the recover pass aborts keeper-owned residue" : "foreign/ambiguous residue is never auto-aborted"})`,
              );
            case "abort-failed":
              return {
                ok: false,
                reason: `worktree-finalize-abort-failed: the guarded git merge --abort left ${repoDir} mid-merge while merging ${baseBranch} into ${defaultBranch} — ${merge.stderr}`,
              };
            case "would-clobber":
              return retrySkip(
                `worktree-finalize-would-clobber: merging ${baseBranch} into ${defaultBranch} would overwrite untracked file(s) in ${repoDir} — ${merge.paths.join(", ")} — skipping the base merge until the path(s) are cleared`,
              );
            case "non-ff":
              return {
                ok: false,
                reason: `worktree-finalize-non-fast-forward: origin/${defaultBranch} is ahead of ${defaultBranch} — the shared checkout cannot fast-forward (no fetch/rebase/force); needs an operator to reconcile origin/${defaultBranch}`,
              };
            case "not-turn-key":
              return retrySkip(
                `worktree-finalize-push-not-turn-key: ${describePushNotReady(merge.reason)} — skipping the base merge + push until the push is turn-key (no fetch/rebase/force)`,
              );
            case "push-timeout":
              if (recordPushTimeout(repoDir)) {
                return {
                  ok: false,
                  reason: `worktree-finalize-push-stuck: pushing ${defaultBranch} to origin has timed out ${STUCK_PUSH_STICKY_THRESHOLD}+ consecutive cycles in ${repoDir} (no fetch/rebase/force) — origin is silently falling behind; needs an operator to probe (git push --dry-run origin HEAD:${defaultBranch}) and reconcile`,
                };
              }
              return retrySkip(
                `worktree-finalize-push-timeout: pushing ${defaultBranch} to origin timed out (a transient stall, no fetch/rebase/force) — retrying the push next cycle`,
              );
            case "push-unconfirmed":
              return retrySkip(
                `worktree-finalize-push-unconfirmed: pushed ${defaultBranch} but origin/${defaultBranch} still does not contain ${baseBranch} (no fetch/rebase/force) — deferring teardown until origin settles`,
              );
            case "lock-timeout":
              return retrySkip(
                `worktree-finalize-lock-timeout: could not acquire the commit-work lock for ${repoDir} within the deadline (a concurrent holder, no fetch/rebase/force) — deferring the base merge until the lock frees`,
              );
            case "local-timeout":
              return retrySkip(
                `worktree-finalize-local-timeout: a local git op merging ${baseBranch} into ${defaultBranch} in ${repoDir} timed out (a blocking git hook, no fetch/rebase/force) — retrying the base merge next cycle`,
              );
            case "conflict":
              return {
                ok: false,
                reason: `worktree-finalize-conflict: merging ${baseBranch} into ${defaultBranch} — ${merge.stderr}`,
                conflictedFiles: merge.conflictedFiles,
              };
            case "push-failed":
              return {
                ok: false,
                reason: `worktree-finalize-push-failed: ${merge.detail}`,
              };
            case "cas-stale":
              return retrySkip(
                `worktree-finalize-cas-stale: refs/heads/${defaultBranch} advanced concurrently while merging ${baseBranch} (update-ref CAS mismatch, no fetch/rebase/force) — retrying the base merge next cycle`,
              );
            case "merge-tree-unsupported":
              return retrySkip(
                `worktree-finalize-merge-tree-unsupported: git < 2.38 has no \`merge-tree --write-tree\` for the working-tree-free base merge of ${baseBranch} into ${defaultBranch} in ${repoDir} — retrying next cycle`,
              );
            case "plumbing-failed":
              return {
                ok: false,
                reason: `worktree-finalize-plumbing-failed: merging ${baseBranch} into ${defaultBranch} in ${repoDir} — ${merge.detail}`,
              };
            case "not-ahead":
            case "merged":
              clearPushTimeoutStreak(repoDir);
              break;
            default:
              assertNever(merge);
          }
        } else {
          const integrated = await verifyAndPushOwnerIntegration(
            repoDir,
            baseBranch,
            defaultBranch,
            run,
            acquireLock,
            runMergeSuite,
            mergeSuiteMemo,
            dispatchKey("close", worktreeFinalizeDispatchId(epicId, repoDir)),
            mergeSuiteLoadRetries,
            scheduleSuiteRetry,
          );
          switch (integrated.kind) {
            case "ready":
              clearPushTimeoutStreak(repoDir);
              break;
            case "not-integrated":
              return retrySkip(
                `worktree-finalize-awaiting-owner-integration: ${baseBranch} is not an ancestor of ${defaultBranch}; a live closer must integrate it under the per-repo trunk lease`,
              );
            case "integration-inconclusive":
              return retrySkip(
                `worktree-finalize-integration-inconclusive: could not prove ${baseBranch} is an ancestor of ${defaultBranch} (exit ${integrated.exitCode}); refusing push and teardown`,
              );
            case "off-branch":
              return retrySkip(
                `worktree-finalize-off-branch: ${repoDir} HEAD is ${integrated.head}, expected ${defaultBranch} — skipping push and teardown until the checkout returns to the default branch`,
              );
            case "dirty":
              return retrySkip(
                `worktree-finalize-dirty-checkout: ${repoDir} has a dirty working tree — skipping push and teardown until it is clean — ${integrated.detail}`,
              );
            case "mid-merge":
              return retrySkip(
                `worktree-finalize-mid-merge: ${repoDir} is mid-merge (owner=${integrated.owner}, autostash=${integrated.autostash}, MERGE_HEAD=${integrated.mergeHead}) — skipping push and teardown until the checkout is clean (${integrated.owner === "keeper" ? "the recover pass aborts keeper-owned residue" : "foreign/ambiguous residue is never auto-aborted"})`,
              );
            case "would-clobber":
              return retrySkip(
                `worktree-finalize-would-clobber: ${repoDir} has untracked path collisions — ${integrated.paths.join(", ")} — skipping push and teardown`,
              );
            case "tip-drift":
              return retrySkip(
                `worktree-finalize-cas-stale: refs/heads/${defaultBranch} advanced after the merge-suite verdict — re-grading before any push`,
              );
            case "lock-timeout":
              return retrySkip(
                `worktree-finalize-lock-timeout: could not acquire the commit-work lock for ${repoDir} within the deadline — deferring push and teardown`,
              );
            case "suite-red":
              return {
                ok: false,
                reason: `${WORKTREE_FINALIZE_SUITE_RED_REASON}: the fast suite failed against the integrated ${defaultBranch} in ${repoDir} (merged commit ${integrated.mergedCommit}) — ${integrated.detail}`,
              };
            case "suite-retry":
              return retrySkip(
                `worktree-finalize-suite-gate-load-suspect: the merge-suite gate for integrated ${defaultBranch} in ${repoDir} was load-suspect (${integrated.detail}) — retrying once on the next producer cycle`,
              );
            case "suite-unavailable":
              return retrySkip(
                `worktree-finalize-suite-gate-unavailable: the merge-suite gate for integrated ${defaultBranch} in ${repoDir} could not run (${integrated.detail}) — deferring the push until the gate can run`,
              );
            case "non-ff":
              return {
                ok: false,
                reason: `worktree-finalize-non-fast-forward: origin/${defaultBranch} is ahead of ${defaultBranch} — the shared checkout cannot fast-forward (no fetch/rebase/force); needs an operator to reconcile origin/${defaultBranch}`,
              };
            case "not-turn-key":
              return retrySkip(
                `worktree-finalize-push-not-turn-key: ${describePushNotReady(integrated.reason)} — skipping push and teardown until the push is turn-key (no fetch/rebase/force)`,
              );
            case "push-timeout":
              if (recordPushTimeout(repoDir)) {
                return {
                  ok: false,
                  reason: `worktree-finalize-push-stuck: pushing ${defaultBranch} to origin has timed out ${STUCK_PUSH_STICKY_THRESHOLD}+ consecutive cycles in ${repoDir} (no fetch/rebase/force) — origin is silently falling behind; needs an operator to probe (git push --dry-run origin HEAD:${defaultBranch}) and reconcile`,
                };
              }
              return retrySkip(
                `worktree-finalize-push-timeout: pushing ${defaultBranch} to origin timed out (a transient stall, no fetch/rebase/force) — retrying next cycle`,
              );
            case "push-failed":
              return {
                ok: false,
                reason: `worktree-finalize-push-failed: ${integrated.detail}`,
              };
            case "push-unconfirmed":
              return retrySkip(
                `worktree-finalize-push-unconfirmed: pushed ${defaultBranch} but origin/${defaultBranch} still does not contain ${baseBranch} (no fetch/rebase/force) — deferring teardown until origin settles`,
              );
            default:
              assertNever(integrated);
          }
        }
        // Logical merge is independent of resource destruction. A live or
        // unprobeable exact hold leaves the now-merged lane in place; the
        // level-triggered finalize/recover pass retries teardown after the hold
        // positively clears.
        if (info.teardownAllowed === false) {
          console.error(
            `[autopilot-worker] finalize ${epicId}: resource hold still protects the lane; merge landed, teardown deferred`,
          );
          return { ok: true };
        }

        // Enumerate EVERY rib of this epic — the snapshot's `laneOrder` ribs UNIONED
        // with EVERY live-git `keeper/epic/<id>--*` ref, so a rib forked in a cycle
        // the snapshot never saw (or one a crash orphaned) is torn down rather than
        // leaked into a recover-able rib ref, while a known laneOrder rib is still
        // pruned even if the for-each-ref enumeration comes back empty.
        const ribBranches = new Set<string>();
        for (const lane of laneOrder) {
          if (lane.branch !== baseBranch) {
            ribBranches.add(lane.branch);
          }
        }
        for (const lane of await gitListEpicLaneBranches(repoDir, run)) {
          if (lane.epicId === epicId && lane.isRib) {
            ribBranches.add(lane.branch);
          }
        }
        // Tear down every lane worktree (base + ribs). NEVER blind-`--force`; a
        // dirty lane refuses and surfaces so the human drains it manually. The
        // path set unions the snapshot's known lane paths with EVERY registered
        // worktree checked out on one of this epic's lane branches (a rib worktree
        // `laneOrder` omitted), so no orphan worktree survives teardown.
        const laneBranchShorts = new Set<string>([baseBranch, ...ribBranches]);
        const paths = new Set<string>([baseWorktreePath]);
        const expectedBranchByPath = new Map<string, string>([
          [normalizeLanePath(baseWorktreePath), baseBranch],
        ]);
        for (const lane of laneOrder) {
          paths.add(lane.worktreePath);
          expectedBranchByPath.set(
            normalizeLanePath(lane.worktreePath),
            lane.branch,
          );
        }
        const registered = await gitListWorktrees(repoDir, run);
        const registeredByPath = new Map(
          registered.map((entry) => [normalizeLanePath(entry.path), entry]),
        );
        for (const entry of registered) {
          if (entry.branch === null) {
            continue;
          }
          const short = shortBranchName(entry.branch);
          if (laneBranchShorts.has(short)) {
            paths.add(entry.path);
            expectedBranchByPath.set(normalizeLanePath(entry.path), short);
          }
        }
        // Set once a lane worktree is actually removed below, so the caller nudges
        // the git vanished sweep ONLY on a completed removal — never on a
        // retry-skip (dirty / cleanup-conflict) exit that left the path present.
        let tornDownLane = false;
        for (const p of paths) {
          const key = normalizeLanePath(p);
          const current = registeredByPath.get(key);
          const expectedBranch = expectedBranchByPath.get(key);
          if (current !== undefined) {
            const currentBranch =
              current.branch == null ? null : shortBranchName(current.branch);
            if (expectedBranch == null || currentBranch !== expectedBranch) {
              return retrySkip(
                `worktree-finalize-cleanup-conflict: ${p} is now registered on ${currentBranch ?? "a detached HEAD"}, expected ${expectedBranch ?? "the recorded epic lane"} — refusing to remove a reused lane path`,
              );
            }
          }
          const removed = await gitRemoveWorktree(repoDir, p, run);
          if (removed.kind === "dirty") {
            return retrySkip(
              `worktree-finalize-teardown-deferred: ${p} has uncommitted changes — the recover pass owns backup-then-force teardown after its grace (${removed.stderr})`,
            );
          }
          tornDownLane = true;
          // Removed clean (THIS path's own result): sweep a residue-only `.claude`
          // husk dir git may have left behind. Swallow-and-log — a husk-prune throw
          // must NEVER become a teardown failure row (teardown already succeeded).
          try {
            await gitPruneWorktreeHusk(repoDir, p, run);
          } catch (err) {
            console.error(
              `[autopilot-worker] worktree husk prune ${p}: ${errMsg(err)}`,
            );
          }
        }
        // Prune the worktree admin entries BEFORE deleting branches: a checked-out
        // branch blocks its delete, and a crash-orphaned admin entry (its dir
        // already gone) would block the next `ensureWorktree` re-add.
        await gitPruneWorktrees(repoDir, run);
        // Delete the now-merged lane branches (ribs THEN base) so a DONE epic never
        // leaves a recover-able `keeper/epic/<id>...` ref or rib branch behind (the
        // pileup + the rib leak). Each gated on is-ancestor-of-default: the
        // merge+push above placed every lane's work in default, so an is-ancestor
        // branch is the fully-merged path ONLY — an unmerged/diverged ref is NEVER
        // deleted (that would lose work; the base goes through the merge→conflict→
        // fail-loud path instead, and an orphan rib is simply left for a human).
        // NEVER `git branch --contains` (it force-deletes siblings). Best-effort: a
        // delete refusal is a no-op (the recover pass skips the already-merged
        // leftover as a backstop), never a failure.
        for (const rib of ribBranches) {
          if (await gitIsAncestorOf(repoDir, rib, defaultBranch, run)) {
            await gitDeleteBranch(repoDir, rib, run);
          }
        }
        if (await gitIsAncestorOf(repoDir, baseBranch, defaultBranch, run)) {
          await gitDeleteBranch(repoDir, baseBranch, run);
        }
        // Completed teardown: nudge the vanished sweep ONLY if a lane was actually
        // removed (never on a hold-deferred teardown, which never enters the loop).
        if (tornDownLane) onLaneTornDown?.();
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          reason: `worktree-finalize-failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
    async assertOnDefaultBranch(cwd) {
      try {
        const defaultBranch = await gitResolveDefaultBranch(cwd, run);
        const head = await gitCurrentBranch(cwd, run);
        if (head !== defaultBranch) {
          return {
            ok: false,
            reason: `not-on-default-branch: ${cwd} HEAD is ${head}, expected ${defaultBranch}`,
          };
        }
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          reason: `default-branch-assert-failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
    recover(
      repos,
      isEpicDone,
      epicPresentAndNotDone,
      hasActiveResolver,
      epicHasOccupyingJob,
      laneTeardown,
      laneMaintenanceProbe,
      hasDispatchableCloser,
      openRecoverRows,
    ) {
      return recoverWorktrees(
        repos,
        isEpicDone,
        run,
        undefined,
        epicPresentAndNotDone,
        hasActiveResolver,
        onResyncSkipped,
        epicHasOccupyingJob,
        laneTeardown,
        laneMaintenanceProbe,
        ownerMediatedFinalize,
        recoverMergeSuite,
        mergeSuiteMemo,
        hasDispatchableCloser,
        openRecoverRows,
        mergeSuiteLoadRetries,
        scheduleSuiteRetry,
      );
    },
    progressActor(
      heldTaskIds,
      epics,
      worktreeRepoByEpicId,
      worktreesRoot,
      laneLiveness,
      hasActiveResolver,
    ) {
      return runProgressActor(
        heldTaskIds,
        epics,
        worktreeRepoByEpicId,
        worktreesRoot,
        laneLiveness,
        hasActiveResolver,
        run,
        acquireLock,
      );
    },
    async reconcileOrigin(repos) {
      const outcomes: {
        dir: string;
        defaultBranch: string;
        result: OriginContainmentResult;
      }[] = [];
      for (const repo of repos) {
        try {
          const defaultBranch = await gitResolveDefaultBranch(repo, run);
          const result = await reconcileOriginContainment(
            repo,
            defaultBranch,
            run,
            pushAttemptedThisCycleByRepo.has(repo),
          );
          outcomes.push({ dir: repo, defaultBranch, result });
        } catch (err) {
          // A producer git error must not wedge the cycle; degrade this repo to a defer.
          outcomes.push({
            dir: repo,
            defaultBranch: "",
            result: {
              kind: "deferred",
              reason: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
      return outcomes;
    },
  };
}

/**
 * The structured result of {@link mergeLaneBaseIntoDefault}. A pure
 * DISCRIMINANT carrying NO reason strings: each caller maps it to its own reason
 * family ({@link finalizeEpic} → `worktree-finalize-*`, OUTSIDE the recover
 * auto-clear prefix; {@link recoverWorktrees} pass-2 → `worktree-recover-*`,
 * INSIDE it) so the {@link isWorktreeRecoverReason} boundary stays caller-owned.
 */
export type MergeLaneResult =
  | { kind: "not-ahead" }
  | { kind: "off-branch"; head: string }
  | { kind: "dirty"; detail: string }
  // A merge is IN FLIGHT on the shared checkout (`MERGE_HEAD` present) — the wedge
  // classification, NO LONGER folded into `dirty`. Carries the incoming `mergeHead`
  // sha, the repo-state-only sole-ownership `owner`, and whether a MERGE_AUTOSTASH
  // is set, so each caller names it distinctly (recover pass-1 self-heals a
  // keeper-owned one via a guarded abort; both merge switches name it rather than
  // degrading to a generic dirty-checkout skip — the incident's core regression).
  | {
      kind: "mid-merge";
      mergeHead: string;
      owner: "keeper" | "foreign";
      autostash: boolean;
    }
  | { kind: "would-clobber"; paths: string[] }
  | { kind: "non-ff" }
  | { kind: "not-turn-key"; reason: PushNotReadyReason }
  | { kind: "conflict"; stderr: string; conflictedFiles: string[] }
  // The conflict/timeout guarded `git merge --abort` ITSELF failed, leaving the
  // shared checkout mid-merge (MERGE_HEAD + unresolved paths) — DISTINCT from
  // `conflict` (which aborted cleanly): the residue did NOT clear, so the caller
  // ESCALATES the un-cleared wedge instead of mislabeling it a content conflict.
  | { kind: "abort-failed"; stderr: string }
  | { kind: "push-timeout" }
  | { kind: "push-failed"; detail: string }
  | { kind: "push-unconfirmed" }
  // The bounded flock acquirer timed out / a local merge git op (a blocking hook)
  // timed out — TRANSIENT retry-skips the caller maps to its own reason family
  // (`worktree-finalize-*` / `worktree-recover-*`), never a freeze, never a sticky.
  | { kind: "lock-timeout" }
  | { kind: "local-timeout" }
  // The compare-and-swap `update-ref refs/heads/<default> <new> <old>` found a
  // stale `<old>` — a CONCURRENT local advance of default (an agent commit) moved
  // the ref out from under the plumbing merge, or the ref lock was contended. A
  // TRANSIENT retry-skip modeled like `lock-timeout`: NO strand, NEVER a sticky
  // conflict — next cycle re-derives the merge off the advanced default tip.
  | { kind: "cas-stale" }
  // `git merge-tree --write-tree` is unsupported (git < 2.38) — the working-tree-
  // free base merge cannot run. A DISTINCT transient skip (worktree mode is
  // default-off, so NEVER a boot fatalExit); the caller retries in case git is
  // upgraded, never a sticky conflict or a strand.
  | { kind: "merge-tree-unsupported" }
  // An UNEXPECTED plumbing git failure — a merge-tree hard error (exit > 1), a
  // commit-tree failure, an unparseable tree/commit OID, or an invalid ref name.
  // NOT a content conflict (exit 1) and NOT a transient stall: a genuine error the
  // caller surfaces as a VISIBLE block for an operator rather than a silent skip.
  | { kind: "plumbing-failed"; detail: string }
  | { kind: "merged" };

/**
 * The push-only analogue of {@link MergeLaneResult}: the verdict of
 * {@link pushDefaultToOrigin}. Its non-`pushed` members are STRUCTURALLY the
 * push-side {@link MergeLaneResult} arms, so a caller threading an already-merged
 * (not-ahead) base through a re-push can return them straight as a
 * {@link MergeLaneResult} without a remap.
 */
export type PushDefaultResult =
  | { kind: "pushed" }
  | { kind: "off-branch"; head: string }
  | { kind: "not-turn-key"; reason: PushNotReadyReason }
  | { kind: "non-ff" }
  | { kind: "push-timeout" }
  | { kind: "push-failed"; detail: string };

/**
 * The CACHED remote-tracking ref for `origin/<defaultBranch>` — resolved from the
 * local ref store ONLY (never a fetch), honoring the shared-checkout no-network
 * invariant. An unresolved ref (a never-pushed default) makes
 * {@link gitIsAncestorOf} return `false` ("origin lacks the lane"), which routes
 * the lane through the turn-key first-push path rather than minting a false
 * "already on origin" that would strand the merge.
 */
export function originDefaultRef(defaultBranch: string): string {
  return `refs/remotes/origin/${defaultBranch}`;
}

/**
 * Commits LOCAL `defaultBranch` carries that `origin/<defaultBranch>` lacks — the
 * backlog the finalize push must upload, via a CACHED `rev-list --count` (NO fetch,
 * honoring the shared-checkout no-network invariant). Returns `null` on any
 * INCONCLUSIVE read (origin ref unresolved / non-zero exit / unparseable count) so the
 * caller provisions the GENEROUS capped deadline rather than under-budgeting a push
 * whose backlog it could not measure. Pure git via the runner.
 */
export async function commitsAheadOfOrigin(
  repo: string,
  defaultBranch: string,
  run: WorktreeGitRunner,
): Promise<number | null> {
  const r = await run(
    [
      "rev-list",
      "--count",
      `${originDefaultRef(defaultBranch)}..refs/heads/${defaultBranch}`,
    ],
    { cwd: repo, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  if (r.code !== 0) return null;
  // STRICT parse: `rev-list --count` emits an EXACT nonnegative decimal. Number.parseInt
  // would silently accept `7junk` (→7) or `3.5` (→3), fabricating a count from garbage —
  // so validate the trimmed output as pure digits FIRST; anything else is null (→ the
  // capped-generous deadline), never a bogus measured backlog.
  const trimmed = r.stdout.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * Push local `defaultBranch` to `origin/<defaultBranch>` — a PUSH-ONLY path (no
 * merge, so NO {@link mergeReadiness}: a push touches refs, not the working tree)
 * that REUSES the fn-990 push gating rather than duplicating it: the authoritative
 * {@link remotePushTurnKey} probe FIRST (it admits a legitimate first push to a
 * never-pushed default via its dry-run), THEN the cached-ref non-ff precheck which
 * blocks ONLY a PROVEN non-fast-forward — an `"unknown"` unresolved origin ref
 * defers to the turn-key verdict, never a false permanent skip. Shared by the two
 * teardown seams (the {@link mergeLaneBaseIntoDefault} not-ahead short-circuit and
 * {@link recoverWorktrees} pass-3) so a base merged into LOCAL default whose push
 * timed out is re-pushed before its lane is torn down (no silently-stranded
 * merge). Pure git side effects — never a fetch / rebase / force.
 */
export async function pushDefaultToOrigin(
  repo: string,
  defaultBranch: string,
  run: WorktreeGitRunner,
  expectedTip?: string,
): Promise<PushDefaultResult> {
  // HEAD-safety FIRST. Under `push.default=simple` a no-refspec push targets the
  // CURRENT HEAD's upstream, not `defaultBranch`; off-default it would push the
  // wrong ref (or "Everything up-to-date", exit 0) while `origin/<default>` never
  // advances, then the caller tears down on a false `pushed` and strands the
  // merge. Assert HEAD==default so the turn-key probe (`@{push}` of HEAD), the
  // branch-explicit FF precheck (on `<default>`), and the push all resolve the
  // SAME ref; off-default DEGRADE with NO push.
  const head = await gitCurrentBranch(repo, run);
  if (head !== defaultBranch) {
    return { kind: "off-branch", head };
  }
  // Authoritative turn-key probe FIRST — admits a legitimate first push to a
  // never-pushed default and carries the accurate not-ready reason.
  const pushReady = await remotePushTurnKey(repo, run);
  if (!pushReady.ready) {
    return { kind: "not-turn-key", reason: pushReady.reason };
  }
  // Cached-ref non-ff precheck second: block ONLY a PROVEN non-fast-forward; an
  // `"unknown"` unresolved origin/<default> defers to the turn-key verdict above.
  if (expectedTip === undefined) {
    if (
      (await gitRemotePushFastForwardable(repo, defaultBranch, run)) ===
      "non-fast-forwardable"
    ) {
      return { kind: "non-ff" };
    }
  } else {
    const remoteRef = originDefaultRef(defaultBranch);
    const exists = await run(["rev-parse", "--verify", "--quiet", remoteRef], {
      cwd: repo,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    if (
      exists.code === 0 &&
      !(await gitIsAncestorOf(repo, remoteRef, expectedTip, run))
    ) {
      return { kind: "non-ff" };
    }
  }
  // An owner-verified push names the tested OID explicitly, so even a non-cooperating
  // local ref writer in the final probe→push window cannot publish untested content.
  const refspec =
    expectedTip === undefined
      ? defaultBranch
      : `${expectedTip}:refs/heads/${defaultBranch}`;
  // SCALE the wall-clock deadline by the backlog size: a push whose backlog outgrows
  // the fixed GIT_PUSH_TIMEOUT_MS would re-time-out every retry forever (the spiral).
  // An inconclusive count (`null`) provisions the GENEROUS capped deadline — the safe
  // direction, since over-budgeting a deadline never kills a legitimately-progressing
  // push, while a bounded cap still surfaces a genuine wedge to the push-stuck streak.
  const ahead = await commitsAheadOfOrigin(repo, defaultBranch, run);
  // Stamp the per-cycle guard BEFORE issuing the push so the periodic containment probe
  // never re-attempts a push this finalize / recover leg already tried this cycle.
  pushAttemptedThisCycleByRepo.add(repo);
  const push = await run(["push", "origin", refspec], {
    cwd: repo,
    env: {
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10",
    },
    timeoutMs: finalizePushDeadlineMs(ahead ?? FINALIZE_PUSH_AHEAD_CAP),
  });
  if (push.code === GIT_SPAWN_TIMEOUT_CODE) {
    return { kind: "push-timeout" };
  }
  if (push.code !== 0) {
    return { kind: "push-failed", detail: (push.stdout + push.stderr).trim() };
  }
  return { kind: "pushed" };
}

/**
 * The verdict of {@link reconcileOriginContainment}, classified for the fallback
 * distress tracker into HEALTHY (positive evidence — clears a distress row),
 * ACTIONABLE (needs an operator — advances the grace clock), and NEUTRAL
 * (inconclusive — neither). Every non-`pushed` {@link PushDefaultResult} degrade is
 * returned straight (the containment push reuses {@link pushDefaultToOrigin} verbatim).
 */
export type OriginContainmentResult =
  // HEALTHY: the push landed this cycle.
  | { kind: "pushed" }
  // HEALTHY: origin already contains local default (nothing to push) — steady state.
  | { kind: "already-contained" }
  // HEALTHY-NOT-OURS: origin is STRICTLY AHEAD of local default (local is an ancestor of
  // origin) — someone else advanced origin; keeper never fetches, so it is not keeper's to
  // reconcile and is NOT an actionable jam. NO push, NO page.
  | { kind: "remote-ahead" }
  // ACTIONABLE: origin and local default have TRULY DIVERGED (neither is an ancestor of
  // the other) — keeper cannot reconcile without a human (no fetch/rebase/force). NO push;
  // sustained past the grace it pages the operator. `ahead` is the local lead for context.
  | { kind: "diverged"; ahead: number }
  // ACTIONABLE: origin/<default> was NEVER pushed (the git ref-probe DEFINITIVELY absent, exit
  // 1) and no owner (finalize/recover) exists to make the first push, so it can never
  // self-resolve — sustained past the grace it pages a FIRST-PUSH-NEEDED row. NEVER auto-pushed
  // (no cached positive-lead evidence exists).
  | { kind: "first-push-needed" }
  // NEUTRAL-RETRY: a genuinely INCONCLUSIVE probe (a 124/128 git read, an unparseable count, an
  // UNKNOWN ref-probe error) — DEFER, no push, no page, but a bounded retry re-probes so a
  // first-cycle unknown on a quiescent DB still gets a clock edge.
  | { kind: "deferred"; reason: string }
  // NEUTRAL-GUARDED: a push already attempted this cycle by an OWNER (finalize/recover) — DEFER
  // with NO retry wake: the owner already has an event/clock path, so re-probing here is waste.
  | { kind: "owner-attempt" }
  // The push-side degrades. ALL are ACTIONABLE in the ownerless containment context (no
  // finalize owner exists to surface them): `push-timeout`/`push-failed` (local leads but
  // the push will not land — silent-lag), `off-branch` (checkout off default), `not-turn-key`
  // (auth/remote/target), `non-ff` (origin moved after the positive-lead probe).
  | Exclude<PushDefaultResult, { kind: "pushed" }>;

/**
 * PERIODIC ORIGIN-CONTAINMENT reconcile for ONE repo (producer-only, run once per
 * cycle by {@link WorktreeDriver.reconcileOrigin}). Today an origin push happens ONLY
 * as a finalize / recover side effect, so a push that never lands leaves origin FROZEN
 * while local default leads and no lane remains to re-trigger it. This fires the SAME
 * {@link pushDefaultToOrigin} path ONLY on POSITIVE EVIDENCE — local default STRICTLY
 * ahead of origin AND non-diverged — and DEFERS on every inconclusive probe:
 *  1. `pushInFlight` (a finalize / recover push already ran this cycle for this repo) →
 *     defer, so a timed-out push is not re-attempted, stacking a second deadline.
 *  2. origin/<default> must RESOLVE locally (cached, NO fetch); a never-pushed default
 *     is the finalize FIRST-push case, not a containment re-push → defer.
 *  3. TRI-STATE non-divergence via `merge-base --is-ancestor origin/<default> <default>`:
 *     exit 0 → non-diverged (a push is a pure fast-forward); exit 1 → origin is not an
 *     ancestor of local, so DISTINGUISH `remote-ahead` (local IS an ancestor of origin →
 *     origin strictly ahead, healthy-not-ours) from true `diverged` (neither) via a
 *     SECOND `merge-base --is-ancestor <default> origin/<default>`; any other exit →
 *     inconclusive → defer.
 *  4. STRICTLY-ahead via {@link commitsAheadOfOrigin}: `null` → inconclusive → defer;
 *     0 → `already-contained`; > 0 → positive evidence → {@link pushDefaultToOrigin}
 *     (which re-verifies HEAD-safety + turn-key + non-ff before it touches origin).
 * Pure git side effects — never a fetch / rebase / force. The existing push-stuck
 * streak / sticky semantics are UNTOUCHED: this is a best-effort re-push that owns its
 * OWN per-repo visible fallback (via the caller's distress tracker), never the finalize /
 * recover streak or the `worktree-finalize-push-stuck` escalation.
 */
export async function reconcileOriginContainment(
  repo: string,
  defaultBranch: string,
  run: WorktreeGitRunner,
  pushInFlight = false,
): Promise<OriginContainmentResult> {
  if (pushInFlight) {
    return { kind: "owner-attempt" };
  }
  const remoteRef = originDefaultRef(defaultBranch);
  const localRef = `refs/heads/${defaultBranch}`;
  const exists = await run(["rev-parse", "--verify", "--quiet", remoteRef], {
    cwd: repo,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  // FAIL-OPEN on the ref probe: exit 1 is git's DEFINITIVE "ref does not exist" — only that
  // mints first-push-needed. A 124 timeout / 128 error / 127 spawn-fail is UNKNOWN, never a
  // positive absence, so it DEFERS (a bounded retry re-probes) — never a false first-push page.
  if (exists.code === 1) {
    // origin/<default> was never pushed and no owner exists to make the first push, so it can
    // never self-resolve — ACTIONABLE (a first-push-needed row past the grace), NOT auto-pushed.
    return { kind: "first-push-needed" };
  }
  if (exists.code !== 0) {
    return {
      kind: "deferred",
      reason: `could not resolve origin/${defaultBranch} (rev-parse exit ${exists.code})`,
    };
  }
  const contains = await run(
    ["merge-base", "--is-ancestor", remoteRef, localRef],
    { cwd: repo, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  if (contains.code === 1) {
    // Origin is NOT an ancestor of local. Distinguish a healthy origin-strictly-ahead
    // (local IS an ancestor of origin — not keeper's to reconcile) from a TRUE divergence
    // (neither is an ancestor — needs a human) before any paging.
    const behind = await run(
      ["merge-base", "--is-ancestor", localRef, remoteRef],
      { cwd: repo, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
    );
    if (behind.code === 0) {
      return { kind: "remote-ahead" };
    }
    if (behind.code !== 1) {
      return {
        kind: "deferred",
        reason: `could not classify origin/${defaultBranch} divergence (exit ${behind.code})`,
      };
    }
    const ahead = await commitsAheadOfOrigin(repo, defaultBranch, run);
    return { kind: "diverged", ahead: ahead ?? 0 };
  }
  if (contains.code !== 0) {
    return {
      kind: "deferred",
      reason: `could not prove origin/${defaultBranch} is contained in local ${defaultBranch} (exit ${contains.code})`,
    };
  }
  const ahead = await commitsAheadOfOrigin(repo, defaultBranch, run);
  if (ahead === null) {
    return {
      kind: "deferred",
      reason: `could not count commits ahead of origin/${defaultBranch}`,
    };
  }
  if (ahead === 0) {
    return { kind: "already-contained" };
  }
  const pushed = await pushDefaultToOrigin(repo, defaultBranch, run);
  return pushed.kind === "pushed" ? { kind: "pushed" } : pushed;
}

/**
 * Classify a containment outcome for the fallback distress tracker:
 *  - `healthy` — POSITIVE evidence origin reflects (or is ahead of) local: `pushed`,
 *    `already-contained`, `remote-ahead`. Clears any open distress row.
 *  - `actionable` — a PUBLICATION BLOCKER an operator must clear (in the ownerless
 *    containment context no finalize exists to surface it): a `push-timeout`/`push-failed`
 *    while local leads (silent-lag), a true `diverged`, an `off-branch` checkout, a
 *    `not-turn-key` push (auth/remote/target), a `non-ff` after the positive-lead probe, or
 *    a `first-push-needed` never-pushed origin. Advances the grace clock, carrying the reason.
 *  - `neutral` — neither clears nor advances (tri-state — an unknown state never pages OR
 *    dismisses a live row): a `deferred` INCONCLUSIVE probe (a 124/128 read, an unparseable
 *    count, an unknown ref-probe) OR the `owner-attempt` guard. The GLUE re-probes a `deferred`
 *    dir on a bounded retry (a first-cycle unknown still gets a clock edge) but NOT an
 *    `owner-attempt` (the owner already has an event path). Pure.
 */
export function classifyOriginContainment(
  repo: string,
  defaultBranch: string,
  result: OriginContainmentResult,
  graceSec: number = ORIGIN_CONTAINMENT_STUCK_GRACE_SEC,
):
  | { class: "healthy" }
  | { class: "actionable"; reason: string }
  | { class: "neutral" } {
  const graceMin = Math.round(graceSec / 60);
  const prefix = `${ORIGIN_CONTAINMENT_DISTRESS_REASON}: ${repo} `;
  const tail = `(no fetch/rebase/force); probe with git push --dry-run origin HEAD:${defaultBranch}`;
  switch (result.kind) {
    case "pushed":
    case "already-contained":
    case "remote-ahead":
      return { class: "healthy" };
    case "push-timeout":
    case "push-failed":
      return {
        class: "actionable",
        reason: `${prefix}local ${defaultBranch} leads origin/${defaultBranch} but the containment push has not landed past the ${graceMin}min grace (${result.kind}) — origin is silently falling behind ${tail}`,
      };
    case "diverged":
      return {
        class: "actionable",
        reason: `${prefix}local ${defaultBranch} and origin/${defaultBranch} have DIVERGED past the ${graceMin}min grace (local leads by ${result.ahead}) — keeper cannot reconcile without a human ${tail}`,
      };
    case "off-branch":
      return {
        class: "actionable",
        reason: `${prefix}the shared checkout is on ${result.head}, not ${defaultBranch}, past the ${graceMin}min grace — publication is blocked until it returns to ${defaultBranch} ${tail}`,
      };
    case "not-turn-key":
      return {
        class: "actionable",
        reason: `${prefix}the push to origin/${defaultBranch} is not turn-key past the ${graceMin}min grace (${describePushNotReady(result.reason)}) — publication is blocked ${tail}`,
      };
    case "non-ff":
      return {
        class: "actionable",
        reason: `${prefix}origin/${defaultBranch} rejected the push non-fast-forward past the ${graceMin}min grace — origin moved and keeper never reconciles it ${tail}`,
      };
    case "first-push-needed":
      return {
        class: "actionable",
        reason: `${prefix}origin/${defaultBranch} has never been pushed and no owner exists to make the first push past the ${graceMin}min grace — push ${defaultBranch} to origin once ${tail}`,
      };
    case "deferred":
    case "owner-attempt":
      return { class: "neutral" };
    default:
      return assertNever(result);
  }
}

/**
 * Whether the periodic origin-containment sweep runs THIS cycle — the SINGLE source of the
 * gate the driveCycle glue applies (an exported pure seam so the boundary is testable
 * without booting the cycle). SCOPE: the sweep is worktree-finalize PUBLICATION HARDENING
 * only, so it is gated on worktree mode — a mode-OFF board commits directly on the shared
 * default with no keeper push path at all (a pre-existing design boundary, reported
 * separately), so the sweep must be inert there. Also gated on not-paused (a push is a
 * suppressed side effect while paused) and a driver that implements the sweep. Pure.
 */
export function originContainmentSweepEnabled(
  worktreeMode: boolean | undefined,
  paused: boolean,
  driverImplementsSweep: boolean,
): boolean {
  return worktreeMode === true && !paused && driverImplementsSweep;
}

/**
 * The origin-containment rows a POSITIVE worktree-mode disable retires. A deliberately-disabled
 * feature must not strand its own paging jam, so when `worktreeMode` is EXPLICITLY `false`
 * (never an unknown / degraded read, which must not dismiss a live jam) every OPEN row
 * level-clears — REGARDLESS of paused: the disable is explicit, independently-known config, and
 * retiring an obsolete feature-owned row is observational hygiene (pause suppresses PUSHES, not
 * this). NEVER clears for pause alone while mode stays on. Pure — the caller emits the clears;
 * the sweep itself never runs mode-off, so this is its ONLY retire path.
 */
export function originContainmentModeOffClears(
  worktreeMode: boolean | undefined,
  openDistressDirs: ReadonlySet<string>,
): { id: string; dir: string }[] {
  if (worktreeMode !== false) return [];
  return [...openDistressDirs].map((dir) => ({
    id: originContainmentDistressId(dir),
    dir,
  }));
}

type OwnerIntegratedTeardownResult =
  | { kind: "ready"; mergedCommit: string }
  | { kind: "not-integrated" }
  | { kind: "integration-inconclusive"; exitCode: number }
  | Exclude<MergeReadiness, { kind: "ready" }>
  | { kind: "tip-drift" }
  | { kind: "lock-timeout" }
  | { kind: "suite-red"; mergedCommit: string; detail: string }
  | { kind: "suite-retry"; detail: string }
  | { kind: "suite-unavailable"; detail: string }
  | Exclude<PushDefaultResult, { kind: "pushed" }>
  | { kind: "push-unconfirmed" };

async function verifyAndPushOwnerIntegration(
  repo: string,
  baseBranch: string,
  defaultBranch: string,
  run: WorktreeGitRunner,
  acquireLock: LockAcquirer | undefined,
  runMergeSuite: MergeSuiteProbe | undefined,
  mergeSuiteMemo: Map<string, MergeSuiteVerdict> | undefined,
  suiteRowKey: string,
  loadRetries: MergeSuiteLoadRetryTracker,
  scheduleSuiteRetry?: () => void,
): Promise<OwnerIntegratedTeardownResult> {
  const ancestry = await run(
    ["merge-base", "--is-ancestor", baseBranch, defaultBranch],
    { cwd: repo, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  if (ancestry.code === 1) return { kind: "not-integrated" };
  if (ancestry.code !== 0) {
    return { kind: "integration-inconclusive", exitCode: ancestry.code };
  }
  const ready = await gitMergeReadiness(repo, defaultBranch, run);
  if (ready.kind !== "ready") return ready;
  const mergedCommit = await revParseCommit(repo, defaultBranch, run);
  if (mergedCommit === null) {
    return {
      kind: "suite-unavailable",
      detail: `could not resolve the integrated ${defaultBranch} tip in ${repo}`,
    };
  }
  if (runMergeSuite !== undefined) {
    let verdict = mergeSuiteMemo?.get(mergedCommit);
    if (verdict === undefined) {
      verdict = await runMergeSuite({
        repoDir: repo,
        mergedCommit,
        runsPlanSuite: await mergeIntroducesPlanChange(
          repo,
          originDefaultRef(defaultBranch),
          mergedCommit,
          run,
        ),
        runsSmokeGate: await mergeIntroducesLoadSurfaceChange(
          repo,
          originDefaultRef(defaultBranch),
          mergedCommit,
          run,
        ),
      });
      if (verdict.kind !== "cannot-run" && verdict.kind !== "load-suspect") {
        mergeSuiteMemo?.set(mergedCommit, verdict);
      }
    }
    const loadAction = loadRetries.step({
      rowKey: suiteRowKey,
      mergedCommit,
      verdict,
    });
    if (verdict.kind === "red") {
      return {
        kind: "suite-red",
        mergedCommit,
        detail: verdict.detail,
      };
    }
    if (verdict.kind === "load-suspect") {
      if (loadAction === "retry") {
        scheduleSuiteRetry?.();
        return { kind: "suite-retry", detail: verdict.detail };
      }
      return {
        kind: "suite-red",
        mergedCommit,
        detail: verdict.detail,
      };
    }
    if (verdict.kind === "cannot-run") {
      return { kind: "suite-unavailable", detail: verdict.detail };
    }
  }
  const acquire = acquireLock ?? defaultCommitWorkLockAcquirer;
  const lock = await acquire(await gitBaseMergeLockPath(repo, run));
  if (lock === null) return { kind: "lock-timeout" };
  try {
    const lockedReady = await gitMergeReadiness(repo, defaultBranch, run);
    if (lockedReady.kind !== "ready") return lockedReady;
    const liveTip = await revParseCommit(repo, defaultBranch, run);
    if (liveTip !== mergedCommit) return { kind: "tip-drift" };
    const reprobe = await run(
      ["merge-base", "--is-ancestor", baseBranch, defaultBranch],
      { cwd: repo, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
    );
    if (reprobe.code === 1) return { kind: "not-integrated" };
    if (reprobe.code !== 0) {
      return { kind: "integration-inconclusive", exitCode: reprobe.code };
    }
    const pushed = await pushDefaultToOrigin(
      repo,
      defaultBranch,
      run,
      mergedCommit,
    );
    if (pushed.kind !== "pushed") return pushed;
  } finally {
    lock.release();
  }
  const confirmed = await run(
    [
      "merge-base",
      "--is-ancestor",
      baseBranch,
      originDefaultRef(defaultBranch),
    ],
    { cwd: repo, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  return confirmed.code === 0
    ? { kind: "ready", mergedCommit }
    : { kind: "push-unconfirmed" };
}

/**
 * The pinned identity keeper stamps on a plumbing base-merge commit. A
 * `commit-tree` merge commit is minted with NO working tree, so all four
 * GIT_AUTHOR/COMMITTER NAME+EMAIL are pinned here (rather than inherited from the
 * ambient repo config) and the commit DATES are pinned to the base tip's own
 * committer date (never wall-clock) — together making the merge commit OID a pure
 * function of its two parents + tree, so a crash-retry re-derives the SAME OID and
 * the update-ref CAS is a clean no-op rather than minting a divergent duplicate.
 */
const BASE_MERGE_COMMIT_NAME = "keeper";
const BASE_MERGE_COMMIT_EMAIL = "keeper@localhost";

/**
 * Parse a single git object id off the FIRST line of plumbing stdout
 * (`merge-tree --write-tree`, `commit-tree`), hex-validated. Returns `null` on
 * anything that is not a 7–64 char lowercase-hex OID so an unparseable / empty /
 * garbage line degrades to a `plumbing-failed` rather than feeding a bogus value
 * into `commit-tree` / `update-ref`.
 */
function parseGitOid(stdout: string): string | null {
  const line = stdout.split("\n", 1)[0]?.trim() ?? "";
  return /^[0-9a-f]{7,64}$/.test(line) ? line : null;
}

/**
 * Resolve `refs/heads/<branch>` to its peeled commit OID (`^{commit}`), bounded and
 * hex-validated. `null` on any non-zero exit / timeout / unparseable output so the
 * plumbing merge degrades to `plumbing-failed` rather than shelling a bogus OID
 * into `commit-tree`/`update-ref`. `--end-of-options` guards a `-`-leading name.
 */
async function revParseCommit(
  repo: string,
  branch: string,
  run: WorktreeGitRunner,
): Promise<string | null> {
  const r = await run(
    [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `refs/heads/${branch}^{commit}`,
    ],
    { cwd: repo, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  if (r.code !== 0) {
    return null;
  }
  return parseGitOid(r.stdout);
}

/**
 * Conservative pure ref-name validation for the plumbing `update-ref` arg
 * (`refs/heads/<default>`). The default branch is producer-resolved (origin/HEAD
 * or the fallback chain), not attacker-supplied, but the plumbing shells it into
 * a ref WRITE — so belt-and-suspenders reject a name carrying whitespace / a
 * control char, a leading `-` or `/`, a trailing `/`, a `..` / `@{` / `.lock`
 * sequence, or any git ref metacharacter (`~^:?*[\`). An invalid name is a
 * `plumbing-failed`, never a silent bad ref write.
 */
function isPlausibleBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 255) {
    return false;
  }
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      return false; // control char
    }
  }
  if (/[\s~^:?*[\\]/.test(name)) {
    return false;
  }
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) {
    return false;
  }
  if (name.includes("..") || name.includes("@{") || name.endsWith(".lock")) {
    return false;
  }
  return true;
}

/**
 * The prospective lane→default merged commit, computed WITHOUT advancing any ref —
 * the shared front-half of {@link mergeLaneBaseIntoDefault} that the finalize
 * merge-suite gate ({@link runMergeSuiteGate}) also runs so both derive the IDENTICAL
 * `newValue` OID (the suite runs on exactly the tree that will land). `computed`
 * carries the resolved `defaultTip` (the CAS `<old>`) plus `newValue` (a pure
 * fast-forward's base tip, or a real 3-way `merge-tree`/`commit-tree` merge commit
 * with the pinned identity + base-tip date, so the OID is deterministic across a
 * crash-retry). Every other arm is a {@link MergeLaneResult} member the caller returns
 * straight; the base-already-ancestor short-circuit is the CALLER's concern (it needs
 * the origin-containment re-push), so this is only reached for a base AHEAD of default.
 */
type ProspectiveMerge =
  | { kind: "computed"; defaultTip: string; newValue: string }
  | { kind: "conflict"; stderr: string; conflictedFiles: string[] }
  | { kind: "local-timeout" }
  | { kind: "merge-tree-unsupported" }
  | { kind: "plumbing-failed"; detail: string };

async function computeProspectiveMerge(
  repo: string,
  baseBranch: string,
  defaultBranch: string,
  run: WorktreeGitRunner,
): Promise<ProspectiveMerge> {
  // Resolve both tips to explicit OIDs: the CAS `<old>` needs the exact current
  // default tip, and pinning the commit-tree parents to OIDs (not branch names)
  // keeps the merge commit OID deterministic across a crash-retry.
  const defaultTip = await revParseCommit(repo, defaultBranch, run);
  if (defaultTip === null) {
    return {
      kind: "plumbing-failed",
      detail: `cannot resolve the default tip refs/heads/${defaultBranch}`,
    };
  }
  const baseTip = await revParseCommit(repo, baseBranch, run);
  if (baseTip === null) {
    return {
      kind: "plumbing-failed",
      detail: `cannot resolve the base tip refs/heads/${baseBranch}`,
    };
  }
  // A pure fast-forward (default is an ancestor of base) resolves straight to the base
  // tip — NO commit-tree, since feeding an FF tree to commit-tree mints a bogus
  // 2-parent merge. A DIVERGENT base takes the real 3-way plumbing merge.
  if (await gitIsAncestorOf(repo, defaultBranch, baseBranch, run)) {
    return { kind: "computed", defaultTip, newValue: baseTip };
  }
  // git >= 2.38's `merge-tree --write-tree`; an older git degrades to a DISTINCT
  // transient skip rather than a hard error (worktree mode is default-off, so never a
  // boot fatalExit).
  if (!(await gitSupportsMergeTreeWriteTree(repo, run))) {
    return { kind: "merge-tree-unsupported" };
  }
  const mt = await run(
    ["merge-tree", "--write-tree", "--end-of-options", defaultTip, baseTip],
    { cwd: repo, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  if (mt.code === GIT_SPAWN_TIMEOUT_CODE) {
    return { kind: "local-timeout" };
  }
  // Drive conflict off the EXIT CODE: 0 clean, 1 conflict → the EXISTING sticky
  // conflict escalation, > 1 a hard error → the failure arm. merge-tree is tree-vs-tree,
  // so it detects content conflicts equivalently to a porcelain merge without ever
  // touching (or seeing) the working tree.
  if (mt.code === 1) {
    // `merge-tree --write-tree` reports one stage record per conflicted side as
    // `<mode> <oid> <stage>\t<path>`. Collect and de-duplicate those paths from
    // the plumbing output; unlike a porcelain merge there is no live index to
    // query because this path deliberately never touches the shared checkout.
    const conflictedFiles = [
      ...new Set(
        mt.stdout
          .split("\n")
          .map((line) =>
            line.match(/^\d{6} [0-9a-f]{7,64} [123]\t(.+)$/)?.[1]?.trim(),
          )
          .filter(
            (path): path is string => path !== undefined && path.length > 0,
          ),
      ),
    ];
    return {
      kind: "conflict",
      stderr: (mt.stdout + mt.stderr).trim(),
      conflictedFiles,
    };
  }
  if (mt.code !== 0) {
    return {
      kind: "plumbing-failed",
      detail: `git merge-tree --write-tree exited ${mt.code}: ${(mt.stdout + mt.stderr).trim()}`,
    };
  }
  const tree = parseGitOid(mt.stdout); // OID is stdout line 1 in --write-tree mode
  if (tree === null) {
    return {
      kind: "plumbing-failed",
      detail: `git merge-tree --write-tree returned an unparseable tree oid: ${JSON.stringify(mt.stdout.slice(0, 200))}`,
    };
  }
  // Pin the commit dates to the base tip's OWN committer date (never wall-clock) so
  // the merge commit OID is deterministic across a crash-retry.
  const dateRes = await run(
    ["show", "-s", "--format=%cI", "--end-of-options", baseTip],
    { cwd: repo, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  if (dateRes.code === GIT_SPAWN_TIMEOUT_CODE) {
    return { kind: "local-timeout" };
  }
  const pinnedDate = dateRes.stdout.trim();
  if (dateRes.code !== 0 || pinnedDate.length === 0) {
    return {
      kind: "plumbing-failed",
      detail: `cannot read the base-tip committer date for ${baseTip}: exit ${dateRes.code}`,
    };
  }
  const ct = await run(
    [
      "commit-tree",
      tree,
      "-p",
      defaultTip,
      "-p",
      baseTip,
      "-m",
      `Merge branch '${baseBranch}' into ${defaultBranch}`,
    ],
    {
      cwd: repo,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      env: {
        GIT_AUTHOR_NAME: BASE_MERGE_COMMIT_NAME,
        GIT_AUTHOR_EMAIL: BASE_MERGE_COMMIT_EMAIL,
        GIT_COMMITTER_NAME: BASE_MERGE_COMMIT_NAME,
        GIT_COMMITTER_EMAIL: BASE_MERGE_COMMIT_EMAIL,
        GIT_AUTHOR_DATE: pinnedDate,
        GIT_COMMITTER_DATE: pinnedDate,
      },
    },
  );
  if (ct.code === GIT_SPAWN_TIMEOUT_CODE) {
    return { kind: "local-timeout" };
  }
  if (ct.code !== 0) {
    return {
      kind: "plumbing-failed",
      detail: `git commit-tree exited ${ct.code}: ${(ct.stdout + ct.stderr).trim()}`,
    };
  }
  const newCommit = parseGitOid(ct.stdout);
  if (newCommit === null) {
    return {
      kind: "plumbing-failed",
      detail: `git commit-tree returned an unparseable commit oid: ${JSON.stringify(ct.stdout.slice(0, 200))}`,
    };
  }
  return { kind: "computed", defaultTip, newValue: newCommit };
}

/**
 * The one package the finalize merge-suite gate conditionally covers BEYOND the root
 * fast suite — the plan plugin, whose own suite the root `bun test` does not run and
 * whose semantic merge conflicts git's `merge-tree` cannot see.
 */
const MERGE_GATE_PLAN_PKG_DIR = "plugins/plan";

/**
 * Does the prospective merge INTRODUCE any change under `plugins/plan` (relative to
 * the current default tip)? Decides whether the merge-suite gate also runs the plan
 * suite. A non-zero / timed-out diff is treated as "yes" — conservatively cover the
 * plan suite rather than skip it on an unclear diff. Pure git via the runner.
 */
async function mergeIntroducesPlanChange(
  repo: string,
  defaultTip: string,
  mergedCommit: string,
  run: WorktreeGitRunner,
): Promise<boolean> {
  const diff = await run(
    [
      "diff",
      "--name-only",
      "--end-of-options",
      defaultTip,
      mergedCommit,
      "--",
      MERGE_GATE_PLAN_PKG_DIR,
    ],
    { cwd: repo, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  if (diff.code !== 0) {
    return true; // unclear → cover the plan suite
  }
  return diff.stdout.trim().length > 0;
}

/**
 * The daemon Load-surface roots manifest (ADR 0073, fn-1309) — the SAME checked-in
 * file `scripts/daemon-fingerprint.ts` hashes for the install reload gate, read
 * directly rather than imported: `scripts/` sits OUTSIDE the declared Load surface
 * (see `scripts/daemon-load-roots.txt`), so a relative import from this module would
 * pull `scripts/daemon-fingerprint.ts` into the daemon's own transitive closure and
 * trip `test/daemon-load-surface.test.ts`'s boundary check. The manifest FILE — not
 * the parser — is the one seam shared by the hashed and the gated boundary; the
 * parse below mirrors `parseRootsManifest` exactly (one path per line, `#`
 * full-line comments and blanks skipped, trimmed).
 */
const DAEMON_LOAD_ROOTS_MANIFEST_REL = "scripts/daemon-load-roots.txt";

function loadDaemonLoadRoots(repoDir: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(repoDir, DAEMON_LOAD_ROOTS_MANIFEST_REL), "utf8");
  } catch {
    return []; // no manifest in this repo — no Load-surface concept here
  }
  const roots: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    roots.push(line);
  }
  return roots;
}

/**
 * Does the prospective merge INTRODUCE any change under a declared daemon Load-
 * surface root (relative to the current default tip)? Decides whether the
 * finalize merge-suite gate also runs the named `test:slow-daemon` smoke gate
 * (ADR 0073, fn-1309). A repo carrying no roots manifest has no Load-surface
 * concept and never gates (`false`); once the manifest exists, a non-zero / timed-
 * out diff is treated as "yes" — conservatively cover the smoke gate rather than
 * skip it on an unclear diff, mirroring {@link mergeIntroducesPlanChange}. Pure
 * git via the runner (the manifest read is the only fs access).
 */
async function mergeIntroducesLoadSurfaceChange(
  repo: string,
  defaultTip: string,
  mergedCommit: string,
  run: WorktreeGitRunner,
): Promise<boolean> {
  const roots = loadDaemonLoadRoots(repo);
  if (roots.length === 0) {
    return false;
  }
  const diff = await run(
    [
      "diff",
      "--name-only",
      "--end-of-options",
      defaultTip,
      mergedCommit,
      "--",
      ...roots,
    ],
    { cwd: repo, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  if (diff.code !== 0) {
    return true; // manifest exists but the diff is unclear → cover the smoke gate
  }
  return diff.stdout.trim().length > 0;
}

/** Deadlines for the finalize merge-suite gate's inline scratch suite run — a hung
 *  install/suite is group-killed at the deadline and degrades to `cannot-run`. */
const MERGE_GATE_INSTALL_TIMEOUT_MS = 10 * 60_000;
const MERGE_GATE_SUITE_DEADLINE_MS = 15 * 60_000;
/** Cap on the failing-test names carried in a red verdict's detail. */
const MERGE_GATE_MAX_FAILING_NAMES = 8;
const MERGE_GATE_MAX_NOTE_LEN = 512;

/**
 * Run ONE package's fast gate suite in `pkgDir` (a scratch-worktree subdir): resolve
 * its configured gate, then run a frozen-lockfile install and the gate command.
 * Classifies via the SAME pure baseline-runner core so a compile-error/bail
 * (`crashed`) is never folded to green:
 *  - no gate script → `pass-with-note` (there is no configured suite to run).
 *  - install fail/timeout → `cannot-run` (a configured gate that could not start).
 *  - the suite ran clean → `green`.
 *  - the suite reported failing tests → `red`.
 *  - a suite deadline kill or non-zero exit with no failing-test signal →
 *    `load-suspect`; the row/commit producer decides retry-once versus visible park.
 *
 * `opts.spawnFn` and `opts.killGraceMs` are injectable seams so tests can replace
 * subprocesses and settle timeout paths without the production kill grace.
 * `opts.command` overrides the `test:gate` package-script lookup with an explicit
 * shell command — the finalize smoke gate (ADR 0073, fn-1309) reuses this runner to
 * invoke the named `test:slow-daemon` gate rather than the fast `test:gate` script.
 * `opts.skipInstall` skips the frozen-lockfile install — the smoke gate shares
 * `pkgDir` with the root fast-suite pass that already installed it there.
 */
export async function runPackageSuiteGate(
  pkgDir: string,
  opts: {
    installTimeoutMs: number;
    suiteDeadlineMs: number;
    spawnFn?: SpawnFn;
    killGraceMs?: number;
    command?: string;
    skipInstall?: boolean;
  },
): Promise<MergeSuiteVerdict> {
  const gateCmd = opts.command ?? readTestGateCommand(pkgDir);
  if (gateCmd === null) {
    return {
      kind: "pass-with-note",
      detail: `no test-gate script configured in ${pkgDir}/package.json`.slice(
        0,
        MERGE_GATE_MAX_NOTE_LEN,
      ),
    };
  }
  if (!opts.skipInstall) {
    const install = await runDetached(
      "bun",
      ["install", "--frozen-lockfile"],
      pkgDir,
      opts.installTimeoutMs,
      { spawnFn: opts.spawnFn, killGraceMs: opts.killGraceMs },
    );
    if (install.timedOut) {
      return {
        kind: "cannot-run",
        detail: `frozen-lockfile install timed out in ${pkgDir}`,
      };
    }
    if (install.exitCode !== 0) {
      return {
        kind: "cannot-run",
        detail: `frozen-lockfile install failed in ${pkgDir} (exit ${install.exitCode})`,
      };
    }
  }
  const raw = await runDetached(
    "/bin/sh",
    ["-c", gateCmd],
    pkgDir,
    opts.suiteDeadlineMs,
    { spawnFn: opts.spawnFn, killGraceMs: opts.killGraceMs },
  );
  const parsed = parseGateOutput(raw.output);
  const cls = classifyRun(raw.exitCode, parsed, raw.timedOut);
  if (cls === "clean") {
    return { kind: "green" };
  }
  if (cls === "failed") {
    const names = parsed.failingTests.slice(0, MERGE_GATE_MAX_FAILING_NAMES);
    const more =
      parsed.failingTests.length > names.length
        ? ` (+${parsed.failingTests.length - names.length} more)`
        : "";
    const detail =
      names.length > 0
        ? `${names.join("; ")}${more}`
        : `${parsed.failCount ?? 1} failing test(s)`;
    return {
      kind: "red",
      detail: `${pkgDir}: ${detail}`,
    };
  }
  return {
    kind: "load-suspect",
    detail: raw.timedOut
      ? `suite timed out in ${pkgDir}`
      : `${pkgDir}: suite crashed (non-zero exit, no failing-test output)`,
  };
}

/** The named smoke gate (ADR 0073, fn-1309) the finalize merge-suite gate chains in
 *  after a green root suite when the merge touches the daemon Load surface. Runs in
 *  the SAME scratch checkout as the root suite (`skipInstall`), never a second
 *  frozen-lockfile install. */
const MERGE_GATE_SMOKE_COMMAND = "bun run test:slow-daemon";

/**
 * The production {@link MergeSuiteProbe}: provision a detached scratch worktree at the
 * prospective merged commit, run the root fast suite there (plus the named daemon
 * smoke gate when the merge touches the daemon Load surface, plus the plan suite
 * when the merge touches `plugins/plan`), and classify green / pass-with-note / red /
 * cannot-run. Runs INLINE on the single-flight reconcile drive (a producer git+suite side
 * effect, never a fold) — an accepted, bounded tradeoff for a default-OFF feature,
 * with the full rationale at the `runMergeSuite` dep wiring (the
 * `ConfirmRunningDeps` object). The scratch worktree is reaped on EVERY path.
 * NEVER throws — any unexpected error folds to `cannot-run` (a retry-skip), never a
 * silent push. `run`/`worktreesRoot`/`spawnFn`/`killGraceMs` are injectable seams;
 * production passes `gitExec`, the default root, the real `spawn`, and the bounded
 * default kill grace.
 */
export async function runMergeSuiteGate(
  args: {
    repoDir: string;
    mergedCommit: string;
    runsPlanSuite: boolean;
    runsSmokeGate?: boolean;
  },
  opts: {
    run?: WorktreeGitRunner;
    worktreesRoot?: string;
    installTimeoutMs?: number;
    suiteDeadlineMs?: number;
    spawnFn?: SpawnFn;
    killGraceMs?: number;
  } = {},
): Promise<MergeSuiteVerdict> {
  const run = opts.run ?? gitExec;
  const installTimeoutMs =
    opts.installTimeoutMs ?? MERGE_GATE_INSTALL_TIMEOUT_MS;
  const suiteDeadlineMs = opts.suiteDeadlineMs ?? MERGE_GATE_SUITE_DEADLINE_MS;
  const scratchPath = baselineScratchPathFor(
    args.repoDir,
    args.mergedCommit,
    opts.worktreesRoot,
  );
  try {
    const prov = await provisionScratchWorktree(
      args.repoDir,
      scratchPath,
      args.mergedCommit,
      run,
    );
    if (prov.kind !== "ready") {
      return {
        kind: "cannot-run",
        detail: `scratch checkout of ${args.mergedCommit} failed: ${prov.detail}`,
      };
    }
    const notes: string[] = [];
    // Universal provisioning (docs/adr/0074): share the source checkout's
    // installed stores — root AND nested package dirs — before any gate runs.
    // Without the nested links, every test file importing a sub-package crashes
    // at module resolution and the gate reads as an empty-digest red.
    await gitEnsureWorktreeDepLink(args.repoDir, scratchPath);
    const rootVerdict = await runPackageSuiteGate(scratchPath, {
      installTimeoutMs,
      suiteDeadlineMs,
      spawnFn: opts.spawnFn,
      killGraceMs: opts.killGraceMs,
    });
    if (
      rootVerdict.kind === "red" ||
      rootVerdict.kind === "load-suspect" ||
      rootVerdict.kind === "cannot-run"
    ) {
      return rootVerdict;
    }
    if (rootVerdict.kind === "pass-with-note") {
      notes.push(rootVerdict.detail);
    }
    if (args.runsSmokeGate) {
      // The merge touched the daemon Load surface — chain the named smoke gate
      // BEFORE the plan suite, in the SAME scratch checkout (no re-install). Its
      // red/cannot-run short-circuits exactly like the root suite's own verdict.
      const smokeVerdict = await runPackageSuiteGate(scratchPath, {
        installTimeoutMs,
        suiteDeadlineMs,
        spawnFn: opts.spawnFn,
        killGraceMs: opts.killGraceMs,
        command: MERGE_GATE_SMOKE_COMMAND,
        skipInstall: true,
      });
      if (
        smokeVerdict.kind === "red" ||
        smokeVerdict.kind === "load-suspect" ||
        smokeVerdict.kind === "cannot-run"
      ) {
        return smokeVerdict;
      }
      if (smokeVerdict.kind === "pass-with-note") {
        notes.push(smokeVerdict.detail);
      }
    }
    if (args.runsPlanSuite) {
      // The merge touched plugins/plan — cover its own suite too (git's merge-tree
      // cannot see a semantic conflict there any more than in the root).
      const planVerdict = await runPackageSuiteGate(
        join(scratchPath, MERGE_GATE_PLAN_PKG_DIR),
        {
          installTimeoutMs,
          suiteDeadlineMs,
          spawnFn: opts.spawnFn,
          killGraceMs: opts.killGraceMs,
        },
      );
      if (
        planVerdict.kind === "red" ||
        planVerdict.kind === "load-suspect" ||
        planVerdict.kind === "cannot-run"
      ) {
        return planVerdict;
      }
      if (planVerdict.kind === "pass-with-note") {
        notes.push(planVerdict.detail);
      }
    }
    return notes.length === 0
      ? { kind: "green" }
      : {
          kind: "pass-with-note",
          detail: notes.join("; ").slice(0, MERGE_GATE_MAX_NOTE_LEN),
        };
  } catch (err) {
    return {
      kind: "cannot-run",
      detail: `merge-suite gate error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    try {
      await removeScratchWorktree(args.repoDir, scratchPath, run);
    } catch (err) {
      console.error(
        `[autopilot-worker] merge-suite gate scratch reap failed for ${scratchPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * The ONE guarded lane-base→default merge sequence shared by
 * {@link WorktreeDriver.finalizeEpic} and {@link recoverWorktrees} pass-2. Runs IN
 * the main checkout (`repo`) and never stamps a reason string — it returns a
 * {@link MergeLaneResult} discriminant the caller maps to its own reason family.
 *
 * The merge is WORKING-TREE-FREE — a `merge-tree`/`commit-tree`/`update-ref`-CAS/
 * push plumbing pipeline that never runs `git merge` in the shared checkout, so it
 * lands even while the human's checkout is dirty or on a non-default branch (the
 * incident this decouples). Ordered ahead-check → turn-key-push precheck → non-ff
 * precheck → (fast-forward | plumbing merge) → CAS ref advance → push:
 *  - ahead-check: the base must carry real commits (NOT already an ancestor of
 *    default) → `not-ahead` is the idempotent already-merged no-op (and re-pushes a
 *    merge stranded off origin by a prior push timeout).
 *  - the AUTHORITATIVE turn-key probe runs FIRST (it admits a legitimate first push
 *    to a never-pushed default via its dry-run); the cached-ref non-ff precheck then
 *    blocks ONLY a PROVEN non-fast-forward — an `"unknown"` unresolved
 *    `origin/<default>` defers to turn-key. Both gate BEFORE the ref advance so a
 *    push that cannot land never advances local default into an advance-then-die.
 *  - a PURE fast-forward (default is an ancestor of base) advances the ref straight
 *    to the base tip via CAS — NO `commit-tree` (feeding an FF tree to commit-tree
 *    would mint a bogus 2-parent merge). A DIVERGENT base takes the real 3-way
 *    plumbing merge: `merge-tree --write-tree` (exit 1 → `conflict`, > 1 →
 *    `plumbing-failed`) → `commit-tree` with a pinned identity + base-tip date.
 *  - the ref advance is a compare-and-swap `update-ref <ref> <new> <old>` under the
 *    common-dir commit-work flock — a stale `<old>` (a concurrent local advance) is
 *    the transient `cas-stale` retry-skip, never a strand or a sticky conflict.
 *  - decision-B: after the ref lands, an idle-clean-on-default shared checkout is
 *    best-effort fast-forwarded to carry the merged commit; a dirty / off-branch /
 *    errored resync is skipped SILENTLY (cosmetic — the merge already landed).
 *  - the push runs with ssh `BatchMode`/`ConnectTimeout` + a spawn timeout; a
 *    timeout is a TRANSIENT `push-timeout`, distinct from a hard `push-failed`.
 * `acquireLock` is optional (recover passes the fast-tier-stubbable lock; finalize
 * omits it for the default flock). Pure git side effects — never a fetch / rebase /
 * force on the shared checkout.
 */
export async function mergeLaneBaseIntoDefault(
  repo: string,
  baseBranch: string,
  defaultBranch: string,
  run: WorktreeGitRunner,
  acquireLock?: LockAcquirer,
  // Fired (once) when the ref advanced but the post-merge catch-up did NOT bring the
  // shared checkout current — either SKIPPED (off-default or mid-merge, so ineligible)
  // or ABORTED (a path both upstream-changed and locally-edited failed the all-or-nothing
  // read-tree) — so the shared checkout now TRAILS the default tip. This is the event that
  // seeds the shared-checkout-desync distress latch. A no-op default keeps every existing
  // caller + direct-call test byte-identical (the `merged` result shape is UNCHANGED).
  onResyncSkipped: () => void = () => {},
): Promise<MergeLaneResult> {
  if (await gitIsAncestorOf(repo, baseBranch, defaultBranch, run)) {
    // The base is already an ancestor of LOCAL default — but a base merged into
    // local default whose push then TIMED OUT is, next cycle, exactly this: an
    // ancestor of local default yet ABSENT from origin. Returning `not-ahead`
    // straight to teardown would strand the merge (origin/<default> never
    // advances). Verify origin contains it via the cached remote-tracking ref (NO
    // fetch); if origin lacks it, RE-PUSH local default and signal teardown-safe
    // (`not-ahead`) ONLY once the push lands. A push-side degrade returns its own
    // discriminant so the caller defers (retry-skip), never tears down.
    if (
      await gitIsAncestorOf(
        repo,
        baseBranch,
        originDefaultRef(defaultBranch),
        run,
      )
    ) {
      return { kind: "not-ahead" };
    }
    const pushed = await pushDefaultToOrigin(repo, defaultBranch, run);
    if (pushed.kind !== "pushed") {
      return pushed; // off-branch / non-ff / timeout / failed / not-turn-key → caller defers
    }
    // Post-push origin-containment recheck: a push can exit 0 yet leave
    // origin/<default> un-advanced (e.g. "Everything up-to-date" on a stale ref).
    // Signal teardown-safe (`not-ahead`) ONLY once origin PROVABLY contains the
    // merge (cached remote-tracking ref, NO fetch); otherwise degrade transiently
    // so the caller defers, never tears the base down off a false `pushed`.
    if (
      await gitIsAncestorOf(
        repo,
        baseBranch,
        originDefaultRef(defaultBranch),
        run,
      )
    ) {
      return { kind: "not-ahead" };
    }
    return { kind: "push-unconfirmed" };
  }
  // Working-tree-free base merge — mergeReadiness is INTENTIONALLY not consulted
  // here: a dirty / off-branch / mid-merge shared checkout no longer blocks the base
  // merge, because the plumbing below never runs `git merge` in the working tree, so
  // it lands regardless (the incident this decouples). (mergeReadiness stays live for
  // the fan-in lane pre-merge, which DOES run a working-tree merge in a lane.)
  //
  // Authoritative turn-key probe FIRST — it admits a legitimate first push to a
  // never-pushed default via its dry-run and carries the accurate reason.
  const pushReady = await remotePushTurnKey(repo, run);
  if (!pushReady.ready) {
    return { kind: "not-turn-key", reason: pushReady.reason };
  }
  // Cached-ref non-ff precheck second: block ONLY a PROVEN non-fast-forward. An
  // `"unknown"` unresolved origin/<default> (never-pushed default) defers to the
  // turn-key verdict above rather than minting a false permanent non-FF skip. Both
  // prechecks gate BEFORE the ref advance so a push that cannot land never advances
  // local default into an advance-then-die state.
  if (
    (await gitRemotePushFastForwardable(repo, defaultBranch, run)) ===
    "non-fast-forwardable"
  ) {
    return { kind: "non-ff" };
  }
  // Belt-and-suspenders ref-name validation before the plumbing WRITES the ref.
  if (!isPlausibleBranchName(defaultBranch)) {
    return {
      kind: "plumbing-failed",
      detail: `refusing to advance an implausible default ref name: ${JSON.stringify(defaultBranch)}`,
    };
  }
  // Compute the prospective merged commit (the ONE shared routine the finalize
  // merge-suite gate also runs, so both derive the IDENTICAL OID). A degrade arm
  // (conflict / local-timeout / merge-tree-unsupported / plumbing-failed) is a
  // MergeLaneResult member — return it straight; a `computed` result carries the
  // exact `defaultTip` (the CAS `<old>`) and `newValue` (the CAS `<new>`).
  const merged = await computeProspectiveMerge(
    repo,
    baseBranch,
    defaultBranch,
    run,
  );
  if (merged.kind !== "computed") {
    return merged;
  }
  const { defaultTip, newValue } = merged;
  // The ref advance + best-effort resync run under the COMMON-dir commit-work flock:
  // the merge no longer sits IN the shared checkout, but it still advances the shared
  // refs/heads/<default> and may resync the shared working tree, so it must not race
  // a concurrent `keeper commit-work` in the main checkout. A bounded acquirer
  // returning null → a transient lock-timeout skip, never a frozen cycle.
  const acquire = acquireLock ?? defaultCommitWorkLockAcquirer;
  const lock = await acquire(await gitBaseMergeLockPath(repo, run));
  if (lock === null) {
    return { kind: "lock-timeout" };
  }
  // Whether the ref advanced but the checkout did NOT catch up (resync skipped/aborted) —
  // the desync seed, fired to `onResyncSkipped` AFTER the lock releases (a plain in-memory
  // record, never held under the flock). Stays `false` on every not-advanced early return.
  let resyncSkipped = false;
  try {
    // Decision-B eligibility, re-checked UNDER the lock so a concurrent commit-work
    // cannot flip the checkout's branch / mid-merge state between this probe and the
    // catch-up below. The catch-up is a STALE-AWARE plumbing merge, NOT a clean-gate:
    // an on-default checkout with no `MERGE_HEAD` is eligible even when it carries
    // uncommitted edits — read-tree advances the stale paths and preserves those edits,
    // aborting all-or-nothing only on a path both upstream-changed AND locally-edited.
    const onDefault = (await gitCurrentBranch(repo, run)) === defaultBranch;
    const mergeHeadProbe = await run(
      ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
      { cwd: repo, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
    );
    const midMerge =
      mergeHeadProbe.code === 0 && mergeHeadProbe.stdout.trim().length > 0;
    const catchUpEligible = onDefault && !midMerge;
    // Compare-and-swap the default ref: a stale `<old>` (a concurrent local advance
    // moved default, or the ref lock was contended) is a TRANSIENT cas-stale skip,
    // never a strand — next cycle re-derives off the advanced tip. `--end-of-options`
    // guards the ref arg; `<new>`/`<old>` are hex OIDs.
    const upd = await run(
      [
        "update-ref",
        "--end-of-options",
        `refs/heads/${defaultBranch}`,
        newValue,
        defaultTip,
      ],
      { cwd: repo, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
    );
    if (upd.code === GIT_SPAWN_TIMEOUT_CODE) {
      return { kind: "local-timeout" };
    }
    if (upd.code !== 0) {
      return { kind: "cas-stale" };
    }
    // Decision-B (stale-aware): the ref just advanced out from under the shared checkout,
    // so the working tree now TRAILS the new tip. Catch it up with a two-tree plumbing
    // merge — the plumbing form of `pull --ff-only`'s twoway_merge — passing BOTH trees
    // EXPLICITLY: `<preMergeTip>` is the CAS `<old>` (`defaultTip`), `<newTip>` the merged
    // value, since post-CAS HEAD already names the new tip and would be the wrong `$H`.
    // Stale (unmodified) paths advance to the new tip, locally-edited untouched paths
    // carry forward byte-identical, and a single path both upstream-changed AND
    // locally-edited aborts the ENTIRE op with NO writes (two-tree cases 16/17/21) — that
    // non-zero abort is the normal safe outcome, leaving the checkout trailing so task 1's
    // desync row stands as the honest signal. `git update-index --really-refresh`
    // immediately before settles the stat cache, closing the racy-clean window (a full
    // second on APFS) so a same-second human edit trips the safe abort rather than being
    // silently clobbered. Gated on on-default + no MERGE_HEAD, held under the common-dir
    // flock, and SILENTLY swallowed on any non-zero exit — the ref advance already landed
    // and the catch-up is best-effort, so the `merged` result is UNCONDITIONAL. Never
    // `checkout <tree> -- <paths>`, `checkout -f`, `--reset`, or hand-written blobs:
    // read-tree keeps git's symlink / path-traversal protections intact and leaves sparse
    // skip-worktree paths untouched.
    if (catchUpEligible) {
      await run(["update-index", "-q", "--really-refresh"], {
        cwd: repo,
        timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      });
      const readTree = await run(
        ["read-tree", "-m", "-u", defaultTip, newValue],
        { cwd: repo, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
      );
      resyncSkipped = readTree.code !== 0;
    } else {
      resyncSkipped = true;
    }
  } finally {
    lock.release();
  }
  // Seed the desync latch (in-memory, lock-free) BEFORE the push: the ref already
  // advanced, so the checkout trails regardless of the push outcome below.
  if (resyncSkipped) {
    onResyncSkipped();
  }
  // Branch-explicit push (pushDefaultToOrigin asserts HEAD==default, uses BatchMode +
  // ConnectTimeout, maps a spawn timeout to the TRANSIENT push-timeout) THEN a
  // post-push origin-containment recheck: a push can exit 0 yet leave origin
  // un-advanced ("Everything up-to-date" on a stale ref), so confirm `merged` ONLY
  // once origin PROVABLY contains the base (cached remote-tracking ref, NO fetch);
  // otherwise degrade to push-unconfirmed so the caller defers teardown.
  const pushed = await pushDefaultToOrigin(repo, defaultBranch, run);
  if (pushed.kind !== "pushed") {
    return pushed; // off-branch / non-ff / timeout / failed / not-turn-key → caller defers
  }
  if (
    await gitIsAncestorOf(
      repo,
      baseBranch,
      originDefaultRef(defaultBranch),
      run,
    )
  ) {
    return { kind: "merged" };
  }
  return { kind: "push-unconfirmed" };
}

/**
 * The default bounded commit-work flock acquirer for the shared main-checkout git
 * writes that must serialize against a concurrent `keeper commit-work` — the
 * {@link mergeLaneBaseIntoDefault} plumbing ref advance + resync and the shared
 * checkout's mid-merge recovery. Used when the caller injects no
 * `acquireLock` (production); a bounded deadline degrades a stuck holder to a defer,
 * never a frozen cycle. The fast tier injects a stub instead.
 */
const defaultCommitWorkLockAcquirer: LockAcquirer = (lockPath) =>
  CommitWorkLock.acquireWithDeadline(lockPath);

/**
 * Probe the shared checkout `repo` (mid-merge, MERGE_HEAD=`mergeHead`) for FOREIGN
 * staged paths — staged work OUTSIDE the merge's own change set that a
 * `git merge --abort` would destroy (the id-reservation incident: a concurrent
 * `keeper plan` mint stages its pathspec files, cannot commit them mid-merge, and the
 * abort wipes them). The merge's OWN set is `git diff HEAD MERGE_HEAD` (auto-merged
 * AND conflicted), so a resolved-then-staged conflict file never reads foreign; every
 * staged path outside it is a concurrent commit's. Returns a `worktree-recover-*` DEFER
 * failure when foreign paths are present OR either probe is inconclusive (fail-safe —
 * an unknown staged state is never a licence to abort), else `null` (no foreign work →
 * the caller aborts). Caller holds the commit-work flock.
 */
async function deferOnForeignStaged(
  repo: string,
  mergeHead: string,
  run: WorktreeGitRunner,
): Promise<WorktreeRecoveryFailure | null> {
  const staged = await run(["diff", "--cached", "--name-only", "-z"], {
    cwd: repo,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (staged.code !== 0) {
    const how =
      staged.code === GIT_SPAWN_TIMEOUT_CODE
        ? "timed out"
        : `failed exit ${staged.code}`;
    return {
      epicId: null,
      reason: `worktree-recover-staged-probe: could not read the staged set for ${repo} (git diff --cached ${how}) mid-merge (MERGE_HEAD=${mergeHead}) — deferring the abort until the staged state is knowable`,
      dir: repo,
    };
  }
  const stagedPaths = staged.stdout.split("\0").filter((p) => p.length > 0);
  if (stagedPaths.length === 0) {
    return null; // nothing staged → the abort destroys no concurrent work
  }
  const touched = await run(
    ["diff", "--name-only", "-z", "HEAD", "MERGE_HEAD"],
    {
      cwd: repo,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    },
  );
  if (touched.code !== 0) {
    const how =
      touched.code === GIT_SPAWN_TIMEOUT_CODE
        ? "timed out"
        : `failed exit ${touched.code}`;
    return {
      epicId: null,
      reason: `worktree-recover-staged-probe: could not read the merge-touched set for ${repo} (git diff HEAD MERGE_HEAD ${how}) — cannot tell foreign staged work from the merge's own, deferring the abort`,
      dir: repo,
    };
  }
  const mergeTouched = new Set(
    touched.stdout.split("\0").filter((p) => p.length > 0),
  );
  const foreign = stagedPaths.filter((p) => !mergeTouched.has(p));
  if (foreign.length === 0) {
    return null; // every staged path is the merge's own → safe to abort
  }
  const shown = foreign.slice(0, 5).join(", ");
  const more = foreign.length > 5 ? `, +${foreign.length - 5} more` : "";
  return {
    epicId: null,
    reason: `worktree-recover-staged-foreign: ${repo} is mid-merge with ${foreign.length} path(s) staged OUTSIDE the merge (${shown}${more}) — a concurrent commit's staged work a git merge --abort would destroy; deferring the abort until it is committed or unstaged`,
    dir: repo,
  };
}

/**
 * Recover a mid-merge in the SHARED MAIN checkout (`repo`, a standalone checkout) —
 * the wedge pass-1's lane loop cannot see (that loop filters to `keeper/epic/*`
 * linked lanes, and the main worktree is on the default branch). A keeper-initiated
 * base→default merge that conflicted can leave the human's shared checkout mid-merge
 * (MERGE_HEAD + unresolved paths); today that folds into a generic dirty-checkout
 * skip the finalize/recover pass retries forever while every board-wide plan-state
 * commit fails "cannot do a partial commit during a merge" — the incident this heals.
 *
 * Consumes the {@link mergeReadiness} classification: only a `mid-merge` verdict
 * acts. A `owner: "keeper"` residue (the branch-set at MERGE_HEAD is non-empty and
 * ENTIRELY `keeper/epic/*`, no MERGE_AUTOSTASH, every probe resolved) is self-healed
 * with a bounded `MERGE_HEAD`-guarded `git merge --abort` UNDER the commit-work flock
 * — so the next cycle (or pass-2 this cycle) re-derives the merge from a clean tree.
 * A `owner: "foreign"` residue (any foreign branch, an empty set, a probe failure, or
 * a present autostash) is NEVER auto-aborted: it defers with a reason NAMING what was
 * found (owner + MERGE_HEAD), inside the `worktree-recover-*` prefix so the level-clear
 * releases it once the checkout recovers. Guards, in order: a live `resolve::<epic>`
 * worker for ANY epic owning the MERGE_HEAD base excludes the abort (its in-progress
 * merge must never be raced — the same per-epic exclusion pass-1's lane loop honors);
 * a lock-timeout degrades to a defer, never a blind abort; foreign staged work OUTSIDE
 * the merge's own set defers (`worktree-recover-staged-foreign`, via
 * {@link deferOnForeignStaged}) so the abort never destroys a concurrent commit's
 * staged files; a failed abort surfaces its own `worktree-recover-abort-failed` reason
 * (the un-cleared wedge). Only ever reached while the board is PLAYING — the caller
 * gates the whole recover sweep on `!paused`.
 * Returns a {@link WorktreeRecoveryFailure} to record, or `null` (clean, self-healed,
 * or resolver-excluded — nothing to escalate).
 */
async function recoverSharedCheckoutMidMerge(
  repo: string,
  defaultBranch: string,
  run: WorktreeGitRunner,
  acquireLock: LockAcquirer | undefined,
  hasActiveResolver: (epicId: string) => boolean,
): Promise<WorktreeRecoveryFailure | null> {
  // Cheap MERGE_HEAD pre-probe (per-worktree pseudo-ref, never a `.git/` stat) — the
  // common clean checkout exits in ONE git read rather than the full readiness ladder.
  const headProbe = await run(
    ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
    { cwd: repo, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  if (headProbe.code !== 0 || headProbe.stdout.trim().length === 0) {
    return null; // not mid-merge (or an inconclusive probe → defer to next cycle)
  }
  // Mid-merge — consume the full classification (ownership + autostash + sha).
  const readiness = await gitMergeReadiness(repo, defaultBranch, run);
  if (readiness.kind !== "mid-merge") {
    return null; // raced clean between the pre-probe and here → nothing to do
  }
  const { mergeHead, owner, autostash } = readiness;
  if (owner !== "keeper") {
    // Foreign / ambiguous residue — NEVER auto-aborted (a human's own merge, a
    // present MERGE_AUTOSTASH `git merge --abort` could fail to reconstruct, or a
    // probe that could not resolve ownership). Defer with a reason that NAMES it.
    return {
      epicId: null,
      reason: `worktree-recover-mid-merge: ${repo} is mid-merge (owner=foreign, autostash=${autostash}, MERGE_HEAD=${mergeHead}) — foreign/ambiguous residue is never auto-aborted; waiting for the checkout to clear`,
      dir: repo,
    };
  }
  // Keeper-owned. Honor the per-epic resolver exclusion: derive the owning epic(s)
  // from the branch-set at MERGE_HEAD and skip the abort while ANY has a live
  // `resolve::<epic>` worker — its in-progress merge is set BY DESIGN, not a crash,
  // and racing an abort under it would destroy the resolution. Auto-lifts when the
  // resolver reaps (the scoped replacement for the resolver's old global pause).
  const refsAt = await run(
    [
      "for-each-ref",
      "--format=%(refname)",
      `--points-at=${mergeHead}`,
      "refs/heads/keeper/epic/",
    ],
    { cwd: repo, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  if (refsAt.code !== 0) {
    // Inconclusive owning-epic probe (a spawn failure or a 124 timeout) — we
    // CANNOT tell whether a live `resolve::<epic>` worker owns this merge, so the
    // resolver-exclusion guard would pass vacuously and the abort would race (and
    // destroy) an in-progress resolution. Defer instead: an unknown resolver state
    // is never a licence to abort. A genuine resolver-free wedge (code 0, empty
    // set) still self-heals below. Named inside the `worktree-recover-*` prefix so
    // the level-clear releases it once the probe resolves next cycle.
    const timedOut = refsAt.code === GIT_SPAWN_TIMEOUT_CODE;
    return {
      epicId: null,
      reason: `worktree-recover-mid-merge: inconclusive owning-epic probe for ${repo} (for-each-ref --points-at=${mergeHead} ${timedOut ? "timed out" : `failed exit ${refsAt.code}`}) — cannot rule out a live resolver, deferring the abort to the next cycle`,
      dir: repo,
    };
  }
  const owningEpics = refsAt.stdout
    .split("\n")
    .map((ref) =>
      epicIdFromKeeperLaneEntry({
        path: repo,
        branch: ref.trim(),
        head: null,
        bare: false,
      }),
    )
    .filter((e): e is string => e !== null);
  if (owningEpics.some((e) => hasActiveResolver(e))) {
    return null; // a live resolver owns this merge — leave it; the exclusion auto-lifts
  }
  // Abort under the commit-work flock so it never races a concurrent agent commit in
  // the SAME shared checkout (the incident's hazard). A lock-timeout degrades to a
  // defer — NEVER a blind abort.
  const acquire = acquireLock ?? defaultCommitWorkLockAcquirer;
  const lockPath = await gitCommitWorkLockPath(repo, run);
  const lock = await acquire(lockPath);
  if (lock === null) {
    return {
      epicId: null,
      reason: `worktree-recover-lock-timeout: could not acquire the commit-work lock for ${repo} within the deadline (a concurrent holder) to abort the mid-merge (MERGE_HEAD=${mergeHead}) — retrying next cycle`,
      dir: repo,
    };
  }
  try {
    // Foreign-staged DEFER — held UNDER the flock so a concurrent commit-work cannot
    // stage/unstage between this probe and the abort. A concurrent `keeper plan` mint
    // stages its pathspec files in this shared checkout and, mid-merge, cannot commit
    // them ("cannot do a partial commit during a merge"), so they sit STAGED; a
    // `git merge --abort` would DESTROY that staged work (the id-reservation incident).
    // Before aborting, list the staged paths and subtract the ones the merge itself
    // owns (`git diff HEAD MERGE_HEAD` — auto-merged AND conflicted, so a
    // resolved-then-staged conflict file is NEVER counted foreign). Any residue is a
    // concurrent commit's staged work: DEFER exactly like the inconclusive arms until
    // it is committed or unstaged — never abort over it. A probe that fails/times out
    // DEFERS too (an unknown staged state is never a licence to abort).
    const foreignDefer = await deferOnForeignStaged(repo, mergeHead, run);
    if (foreignDefer !== null) {
      return foreignDefer;
    }
    const abort = await run(["merge", "--abort"], {
      cwd: repo,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    if (abort.code === 0) {
      return null; // self-healed — the merge re-derives from a clean tree next
    }
    // The abort ITSELF failed / timed out — the wedge did NOT clear. Surface it as
    // its own recover reason (the un-cleared wedge) instead of silently skip-retrying.
    const out = (abort.stdout + abort.stderr).trim();
    const detail =
      abort.code === GIT_SPAWN_TIMEOUT_CODE
        ? `git merge --abort timed out${out.length > 0 ? `: ${out}` : ""}`
        : out.length > 0
          ? out
          : `git merge --abort failed (exit ${abort.code})`;
    return {
      epicId: null,
      reason: `worktree-recover-abort-failed: the guarded git merge --abort left ${repo} mid-merge (MERGE_HEAD=${mergeHead}) — ${detail}`,
      dir: repo,
    };
  } finally {
    lock.release();
  }
}

/**
 * The producer-only crash/restart recovery sweep wrapped by
 * {@link WorktreeDriver.recover}. Exported so the fast tier drives both passes
 * with a fake {@link WorktreeGitRunner}; the real-git lifecycle lives in the slow
 * test. Pure of keeper.db / folds / the wall clock — it reads ONLY live git plus
 * the injected `isEpicDone` done-ness probe.
 *
 * Pass 1 (interrupted-merge, tri-state): every linked lane under each repo is
 * probed for a live claim. A LIVE or inconclusive claim holds the lane — reported
 * and left untouched. A DEAD or absent claim takes the crash self-heal: abort the
 * merge, then prune the repo's worktree admin entries; an abort failure is recorded
 * and re-surfaces below as an IMMEDIATE wedge. The SHARED MAIN checkout — not a
 * lane — keeps its separate {@link recoverSharedCheckoutMidMerge} policy.
 *
 * Pass 2 (closed-base backstop): every `keeper/epic/<id>` base branch is graded
 * against a closed/tombstoned epic. In owner-mediated mode an unintegrated base
 * waits while a closer remains dispatchable; otherwise recover performs the
 * idempotent merge + push backstop. An owner-integrated base is only verified and
 * pushed. Git remains the authority outside the recent-done window.
 *
 * Pass 3 (orphan-lane prune): tri-state on epic activity — every `keeper/epic/<id>`
 * lane (base AND rib) whose epic is ABSENT (reaped / EpicDeleted) OR done, gated
 * by a SECONDARY is-ancestor-of-default safety, is torn down. The injected
 * `epicPresentAndNotDone` probe PRESERVES a live epic's lanes (an omitted probe
 * defaults to preserve — fail-safe).
 *
 * Every git error is caught and returned as a {@link WorktreeRecoveryFailure}; a
 * recovery error NEVER throws past here so a producer git failure can't wedge the
 * cycle.
 */
export async function recoverWorktrees(
  repos: readonly string[],
  isEpicDone: (epicId: string) => Promise<boolean | EpicRecoverVerdict>,
  run: WorktreeGitRunner = gitExec,
  acquireLock?: LockAcquirer,
  epicPresentAndNotDone: (epicId: string) => Promise<boolean> = () =>
    Promise.resolve(true),
  // Per-epic exclusion: true while an autonomous merge-resolver (`resolve::<epic>`)
  // is LIVE for the lane's epic. Holds pass-1's lane abort (that MERGE_HEAD is the
  // resolver's deliberate in-progress merge, not crash residue) and gates
  // shared-checkout recovery plus pass-2's base→default merge, so maintenance never
  // races that resolver. It AUTO-LIFTS the instant the resolver job reaps (clean exit
  // OR crash) — a dead resolver strands nothing, and the lane recovers next cycle.
  // Defaults to "no resolver" so every existing caller (and the OFF path) is
  // byte-identical. A
  // retargeted content conflict now dispatches a resolver for a DONE epic, so pass-2
  // must skip re-attempting the same merge while that resolver is live.
  hasActiveResolver: (epicId: string) => boolean = () => false,
  // Desync seed sink (see {@link createWorktreeDriver}): called with a repo dir when
  // pass-2's base→default merge advanced the ref but the shared checkout's resync was
  // skipped/aborted, so it trails the default tip. Omitted (direct-call tests) → a no-op.
  onResyncSkipped?: (repoDir: string) => void,
  // Per-epic occupancy gate: true while a `close::<epic>` OR `work::<task>` job still
  // OCCUPIES the epic's slot (`epicHasOccupyingJob` off the SAME snapshot the cycle
  // reconciled). Pass-3's orphan-lane teardown SKIPS such a lane — a done epic's
  // closer is still mid-turn INSIDE it, so removing its cwd would create Phantom-working
  // (ADR 0031). Defaults to "never occupying" so every existing caller (and the OFF
  // path) is byte-identical. A pure projection read (jobs + read-time liveness).
  epicHasOccupyingJob: (epicId: string) => boolean = () => false,
  laneTeardown?: LaneTeardownRecoveryOptions,
  laneMaintenanceProbe?: LaneMaintenanceProbe,
  ownerMediatedIntegration = false,
  runMergeSuite?: MergeSuiteProbe,
  mergeSuiteMemo: Map<string, MergeSuiteVerdict> = new Map(),
  hasDispatchableCloser: (epicId: string) => boolean = () => false,
  openRecoverRows: readonly {
    id: string;
    epicId: string | null;
    dir: string;
  }[] = [],
  mergeSuiteLoadRetries: MergeSuiteLoadRetryTracker = createMergeSuiteLoadRetryTracker(),
  scheduleSuiteRetry?: () => void,
): Promise<WorktreeRecoveryOutcome> {
  const failures: WorktreeRecoveryFailure[] = [];
  // TERMINAL content conflicts (routed to the bare `close::<epic>` merge-escalation
  // scope) and POSITIVE resolution observations (the clear predicate's evidence set)
  // flow out alongside the transient `failures`. The recover worker still writes
  // nothing to keeper.db — all three funnel through the emit deps to main.
  const escalations: WorktreeRecoveryEscalation[] = [];
  const resolved: WorktreeRecoveryResolution[] = [];
  // Per-cycle fan-in LANE base-readiness observations (keyed by lane path) — the
  // evidence the lane-wedge grace tracker + the verb-agnostic reason-scoped clear
  // consume. Filled by the per-repo lane-readiness probe below (after the mutating
  // passes settle the tree) and by pass-3's teardown (a torn-down lane resolves).
  const laneWedged: { path: string; reason: string; immediate: boolean }[] = [];
  const laneResolved: string[] = [];
  // Set once pass-3 actually removes a lane worktree (any completed-removal exit),
  // so the caller nudges the git vanished sweep. A deferred/failed teardown
  // (retry-skip / backup-failed / remove-failed) leaves it false — the sweep must
  // not drop a still-present lane. Distinct from `laneResolved`, which ALSO
  // carries lanes found merely READY by the readiness probe (no removal).
  let tornDownLane = false;
  const laneTeardownDistress: NonNullable<
    WorktreeRecoveryOutcome["laneTeardownDistress"]
  > = [];
  const teardownTracker =
    laneTeardown?.tracker ?? createLaneTeardownGraceTracker();
  const teardownNowSec = laneTeardown?.nowSec ?? 0;
  const presentLanePaths = new Set<string>();
  const teardownCandidatePaths = new Set<string>();
  const backupFailedPaths = new Set<string>();
  const laneHoldByPath = new Map<string, string>();
  const maintenanceDeferralByPath = new Map<string, string>();
  const noteMaintenanceDeferral = (path: string, reason: string): void => {
    const key = normalizeLanePath(path);
    if (!maintenanceDeferralByPath.has(key)) {
      maintenanceDeferralByPath.set(
        key,
        boundedLaneMaintenanceReason(
          `worktree-maintenance-deferred: ${key} — ${reason}`,
        ),
      );
    }
  };
  let laneEnumerationComplete = true;
  // De-dupe repos (multiple epics often share one repo dir) so each repo is swept
  // once. A repo whose main worktree is the same path is collapsed by the set.
  const seen = new Set<string>();
  const uniqueRepos: string[] = [];
  for (const r of repos) {
    const key = stripTrailingSlashPath(r.trim());
    if (key.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueRepos.push(r);
  }
  const openRecoverByRepo = new Map<
    string,
    { id: string; epicId: string | null; dir: string }[]
  >();
  for (const row of openRecoverRows) {
    const key = stripTrailingSlashPath(row.dir.trim());
    if (key === "") continue;
    const prior = openRecoverByRepo.get(key);
    if (prior === undefined) {
      openRecoverByRepo.set(key, [row]);
    } else {
      prior.push(row);
    }
  }
  laneEnumerationComplete = uniqueRepos.length > 0;

  for (const repo of uniqueRepos) {
    // A linked-worktree lane is NOT a repo to sweep. `git rev-parse
    // --show-toplevel` inside a lane returns the lane itself, so a lane registers
    // as its own git-projection root and leaks into the sweep set, where pass-2
    // would fail `off-branch` by construction (a lane's HEAD is its `keeper/epic/*`
    // branch, never the default). Classify and skip a linked lane; a probe ERROR
    // DEFERS the repo this cycle (never fail-open into the off-branch path) —
    // level-triggered retry re-sweeps next cycle.
    const laneState = await gitClassifyLinkedWorktree(repo, run);
    if (laneState !== "standalone") {
      laneEnumerationComplete = false;
      continue;
    }
    // POSITIVE observation for the PATH-TIED (null-epic) recover row of this dir: the
    // repo classified standalone, so it IS being swept this cycle — a genuine "the
    // dir is reachable" signal, not mere absence. Combined with the clear predicate's
    // never-clear-what-still-fails guard, an old path-tied `worktree-recover:<slug>`
    // row clears iff this sweep produces NO fresh path-tied failure for the dir; a
    // SKIPPED cycle (paused / dir not in the sweep set) records nothing, so the row is
    // retained — the incident's silent-skip defect, closed for path-tied rows too.
    resolved.push({ epicId: null, dir: repo });

    // --- Pass 1: abort any interrupted merge in a live linked worktree. ---
    let entries: WorktreeEntry[];
    try {
      const listed = await run(["worktree", "list", "--porcelain"], {
        cwd: repo,
        timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      });
      if (listed.code !== 0) {
        laneEnumerationComplete = false;
        failures.push({
          epicId: null,
          reason: `worktree-recover-list-failed: git worktree list exited ${listed.code}`,
          dir: repo,
        });
        continue;
      }
      entries = gitParseWorktreeList(listed.stdout);
    } catch (err) {
      laneEnumerationComplete = false;
      failures.push({
        epicId: null,
        reason: `worktree-recover-list-failed: ${errMsg(err)}`,
        dir: repo,
      });
      continue;
    }
    let prunedThisRepo = false;
    // Lane worktree paths pass-3 tears down this repo — the lane pre-merge readiness
    // probe below SKIPS them (they are already recorded `resolved`), so a torn-down
    // lane is never re-probed on a vanished path and mis-classified wedged.
    const prunedLanePaths = new Set<string>();
    for (const entry of entries) {
      if (entry.bare || entry.branch === null) {
        continue; // a bare/detached entry carries no lane merge to recover
      }
      // Only KEEPER-managed lanes (`keeper/epic/*`). A foreign
      // linked worktree (e.g. a `.claude/worktrees/<name>` lane another tool
      // registered) is never keeper's to probe or prune. Classify on the branch
      // (a keeper lane IS its `keeper/epic/*` branch), not the path.
      if (!isKeeperLaneEntry(entry)) {
        continue;
      }
      const identity = keeperLaneIdentity(entry);
      if (identity === null) continue;
      const target: LaneMaintenanceTarget = {
        path: entry.path,
        epicId: identity.epicId,
        taskId: identity.taskId,
      };
      let hold = probeLaneMaintenance(laneMaintenanceProbe, target);
      if (hold.kind === "clear" && hasActiveResolver(identity.epicId)) {
        hold = {
          kind: "defer",
          reason: `live resolver resolve::${identity.epicId} holds ${normalizeLanePath(entry.path)}`,
        };
      }
      // TRI-STATE, never a blanket hold on MERGE_HEAD.
      //  (1) LIVE (or inconclusive) claim → HOLD. That MERGE_HEAD is the owner's
      //      own in-progress merge; aborting it races the owner out from under
      //      itself. Defer visibly and mutate nothing.
      //  (2) DEAD or absent claim → the residue is a crash, not work in flight:
      //      take the pre-existing sole-owned abort self-heal (keeper lanes only,
      //      already filtered above) so the next cycle re-merges from a clean tree.
      //  (3) The abort FAILING → a `worktree-recover-abort-failed` failure here,
      //      and the surviving MERGE_HEAD surfaces below as the IMMEDIATE
      //      `worktree-lane-wedge` escalation. A hold NEVER suppresses that.
      if (hold.kind === "defer") {
        laneHoldByPath.set(normalizeLanePath(entry.path), hold.reason);
        const mergeHead = await gitProbeLaneMergeHead(entry.path, run);
        noteMaintenanceDeferral(
          entry.path,
          mergeHead === "absent"
            ? hold.reason
            : `${hold.reason}; ${
                mergeHead === "present"
                  ? "MERGE_HEAD is present; maintenance never aborts a live owner's in-progress lane merge"
                  : "MERGE_HEAD probe was inconclusive; maintenance defers fail-closed"
              }`,
        );
        continue;
      }
      try {
        const aborted = await gitAbortInterruptedMerge(entry.path, run);
        if (aborted) {
          // Prune ONCE per repo after the first abort — a `merge --abort` can
          // leave the admin entry healthy, but pruning clears any stale orphan a
          // crash left so the next `ensureWorktree` re-adds cleanly.
          if (!prunedThisRepo) {
            await gitPruneWorktrees(repo, run);
            prunedThisRepo = true;
          }
        }
      } catch (err) {
        failures.push({
          epicId: null,
          reason: `worktree-recover-abort-failed: ${entry.path} — ${errMsg(err)}`,
          dir: repo,
        });
      }
    }

    // Resolve the default branch ONCE per repo — both the pass-2 base merge and
    // the pass-3 rib prune need it, and pass-3 must run even when there is no base
    // to merge (an orphan rib whose base is already gone).
    let defaultBranch: string;
    try {
      defaultBranch = await gitResolveDefaultBranch(repo, run);
    } catch (err) {
      failures.push({
        epicId: null,
        reason: `worktree-recover-default-branch-failed: ${errMsg(err)}`,
        dir: repo,
      });
      continue;
    }

    let trunkLease: ReturnType<typeof readTrunkLeaseLeaf> = null;
    try {
      trunkLease = readTrunkLeaseLeaf(keeperStateDir(), repo);
    } catch {
      trunkLease = null;
    }
    const ownerActive = (epicId: string): boolean =>
      hasActiveResolver(epicId) ||
      (ownerMediatedIntegration &&
        trunkLease?.active === true &&
        trunkLease.epic_id === epicId);

    // Self-heal a mid-merge WEDGE in the shared MAIN checkout BEFORE pass-2 attempts
    // the base merge — a keeper-owned residue is aborted (flock-guarded) so pass-2
    // re-derives from a clean tree this very cycle; a foreign/ambiguous one is named
    // and left alone. Wrapped so a producer git error can't wedge the cycle.
    try {
      const midMerge = await recoverSharedCheckoutMidMerge(
        repo,
        defaultBranch,
        run,
        acquireLock,
        ownerActive,
      );
      if (midMerge !== null) {
        failures.push(midMerge);
      }
    } catch (err) {
      failures.push({
        epicId: null,
        reason: `worktree-recover-mid-merge-failed: ${repo} — ${errMsg(err)}`,
        dir: repo,
      });
    }

    // --- Pass 2: finish push recovery for owner-integrated done bases. ---
    let bases: { branch: string; epicId: string }[];
    try {
      bases = await gitListEpicBaseBranches(repo, run);
    } catch (err) {
      failures.push({
        epicId: null,
        reason: `worktree-recover-base-list-failed: ${errMsg(err)}`,
        dir: repo,
      });
      continue;
    }
    const baseEpicIds = new Set(bases.map((base) => base.epicId));
    for (const open of openRecoverByRepo.get(
      stripTrailingSlashPath(repo.trim()),
    ) ?? []) {
      if (open.epicId !== null && !baseEpicIds.has(open.epicId)) {
        resolved.push({ epicId: open.epicId, dir: open.dir });
      }
    }
    for (const base of bases) {
      try {
        // TRI-STATE done-probe: pass-2 consumes the full verdict, not a boolean.
        //   open         → finalize owns the base merge; skip, no observation.
        //   inconclusive → a non-result (error) read frame; DEFER — no merge, no
        //                  observation, so an open recover row for (epic,repo) is
        //                  RETAINED (absence of a read is never resolution).
        //   absent       → authoritatively tombstoned; owner-mediated mode may
        //                  still land its surviving base through this backstop.
        //   done         → verify owner integration, then finish push recovery.
        const verdict = normalizeEpicVerdict(await isEpicDone(base.epicId));
        if (verdict === "open" || verdict === "inconclusive") {
          continue;
        }
        const tombstoned = verdict === "absent";
        if (tombstoned && !ownerMediatedIntegration) {
          resolved.push({ epicId: base.epicId, dir: repo });
          continue;
        }
        // A live claim or owner owns this base→default merge. Skip so pass-2 never
        // races it; absence of an observation retains any open recover row.
        if (ownerActive(base.epicId)) {
          continue;
        }
        if (ownerMediatedIntegration && epicHasOccupyingJob(base.epicId)) {
          continue;
        }
        if (ownerMediatedIntegration && !tombstoned) {
          const integrated = await verifyAndPushOwnerIntegration(
            repo,
            base.branch,
            defaultBranch,
            run,
            acquireLock,
            runMergeSuite,
            mergeSuiteMemo,
            dispatchKey(
              "close",
              worktreeRecoverEpicDispatchId(base.epicId, repo),
            ),
            mergeSuiteLoadRetries,
            scheduleSuiteRetry,
          );
          if (integrated.kind === "ready") {
            resolved.push({ epicId: base.epicId, dir: repo });
            continue;
          }
          if (integrated.kind === "not-integrated") {
            // An ownerless incident with a remaining attachment slot belongs to
            // the closer. Only after no closer is dispatchable does recover take
            // the merge-and-push backstop below.
            if (hasDispatchableCloser(base.epicId)) continue;
          } else {
            let reason: string;
            switch (integrated.kind) {
              case "integration-inconclusive":
                reason = `worktree-recover-integration-inconclusive: could not prove ${base.branch} is an ancestor of ${defaultBranch} (exit ${integrated.exitCode}); refusing push and teardown`;
                break;
              case "off-branch":
                reason = `worktree-recover-not-on-default: ${repo} HEAD is ${integrated.head}, expected ${defaultBranch} — deferring push and teardown`;
                break;
              case "dirty":
                reason = `worktree-recover-dirty-checkout: ${repo} has a dirty working tree — deferring push and teardown — ${integrated.detail}`;
                break;
              case "mid-merge":
                reason = `worktree-recover-mid-merge: ${repo} is mid-merge (owner=${integrated.owner}, autostash=${integrated.autostash}, MERGE_HEAD=${integrated.mergeHead}) — deferring push and teardown`;
                break;
              case "would-clobber":
                reason = `worktree-recover-would-clobber: ${repo} has untracked path collisions — ${integrated.paths.join(", ")} — deferring push and teardown`;
                break;
              case "tip-drift":
                reason = `worktree-recover-cas-stale: refs/heads/${defaultBranch} advanced after the merge-suite verdict — re-grading before any push`;
                break;
              case "lock-timeout":
                reason = `worktree-recover-lock-timeout: could not acquire the commit-work lock for ${repo} — deferring push and teardown`;
                break;
              case "suite-red":
                reason = `${WORKTREE_FINALIZE_SUITE_RED_REASON}: the fast suite failed against the integrated ${defaultBranch} in ${repo} (merged commit ${integrated.mergedCommit}) — ${integrated.detail}`;
                break;
              case "suite-retry":
                continue;
              case "suite-unavailable":
                reason = `worktree-recover-suite-gate-unavailable: the merge-suite gate for integrated ${defaultBranch} in ${repo} could not run (${integrated.detail}) — deferring push and teardown`;
                break;
              case "non-ff":
                reason = `worktree-finalize-non-fast-forward: origin/${defaultBranch} is ahead of ${defaultBranch} — the shared checkout cannot fast-forward (no fetch/rebase/force); needs an operator to reconcile origin/${defaultBranch}`;
                break;
              case "not-turn-key":
                reason = `worktree-recover-push-not-turn-key: ${describePushNotReady(integrated.reason)} — deferring push and teardown`;
                break;
              case "push-timeout":
                reason = `worktree-recover-push-timeout: pushing ${defaultBranch} to origin timed out — deferring teardown`;
                break;
              case "push-failed":
                reason = `worktree-recover-push-failed: ${integrated.detail}`;
                break;
              case "push-unconfirmed":
                reason = `worktree-recover-push-unconfirmed: pushed ${defaultBranch} but origin/${defaultBranch} still does not contain ${base.branch} — deferring teardown`;
                break;
              default:
                assertNever(integrated);
            }
            failures.push({ epicId: base.epicId, reason, dir: repo });
            continue;
          }
        }

        // Legacy mode and owner-mediated backstop share the merge-and-push routine.
        // `not-ahead` is the idempotency skip (an already-merged base is an ancestor
        // of default). Every transient degrade maps to a `worktree-recover-*` reason.
        // A legacy content conflict still opens the bare close incident; the demoted
        // owner-mediated backstop keeps its conflict in the recover-scoped surface
        // because no dispatchable closer remains.
        const merge = await mergeLaneBaseIntoDefault(
          repo,
          base.branch,
          defaultBranch,
          run,
          acquireLock,
          () => onResyncSkipped?.(repo),
        );
        switch (merge.kind) {
          case "not-ahead":
          case "merged":
            // The base merged this cycle (or was already an ancestor of default) — a
            // POSITIVE resolution observation that clears an open recover row.
            resolved.push({ epicId: base.epicId, dir: repo });
            break;
          case "off-branch":
            failures.push({
              epicId: base.epicId,
              reason: `worktree-recover-not-on-default: ${repo} HEAD is ${merge.head}, expected ${defaultBranch} to merge ${base.branch} — switch ${repo} back to ${defaultBranch} (commit or stash any work on ${merge.head} first) so recover can merge it`,
              dir: repo,
            });
            continue;
          case "dirty":
            failures.push({
              epicId: base.epicId,
              reason: `worktree-recover-dirty-checkout: ${repo} has a dirty working tree — skipping the merge of ${base.branch} until it is clean — ${merge.detail}`,
              dir: repo,
            });
            continue;
          case "mid-merge":
            // A merge is IN FLIGHT on the shared checkout (the wedge). Named
            // distinctly — NOT the generic dirty-checkout the incident degraded to.
            // Inside the `worktree-recover-*` prefix so the level-clear releases it
            // once the checkout recovers; a keeper-owned residue is self-healed by
            // this pass's own main-checkout guarded abort (above), a foreign one waits.
            failures.push({
              epicId: base.epicId,
              reason: `worktree-recover-mid-merge: ${repo} is mid-merge (owner=${merge.owner}, autostash=${merge.autostash}, MERGE_HEAD=${merge.mergeHead}) — skipping the merge of ${base.branch} until the checkout is clean (${merge.owner === "keeper" ? "keeper-owned residue self-heals via the guarded abort" : "foreign/ambiguous residue is never auto-aborted"})`,
              dir: repo,
            });
            continue;
          case "abort-failed":
            // The guarded `git merge --abort` ITSELF failed, leaving the checkout
            // mid-merge — the un-cleared wedge, named as its own recover reason
            // (inside the level-clear prefix) instead of vanishing into a conflict.
            failures.push({
              epicId: base.epicId,
              reason: `worktree-recover-abort-failed: the guarded git merge --abort left ${repo} mid-merge while merging ${base.branch} into ${defaultBranch} — ${merge.stderr}`,
              dir: repo,
            });
            continue;
          case "would-clobber":
            failures.push({
              epicId: base.epicId,
              reason: `worktree-recover-would-clobber: merging ${base.branch} into ${defaultBranch} would overwrite untracked file(s) in ${repo} — ${merge.paths.join(", ")} — skipping until the path(s) are cleared`,
              dir: repo,
            });
            continue;
          case "non-ff":
            failures.push({
              epicId: base.epicId,
              reason: `worktree-recover-non-fast-forward: origin/${defaultBranch} is ahead of ${defaultBranch} — skipping the merge of ${base.branch} (no fetch/rebase/force)`,
              dir: repo,
            });
            continue;
          case "not-turn-key":
            failures.push({
              epicId: base.epicId,
              reason: `worktree-recover-push-not-turn-key: ${describePushNotReady(merge.reason)} — skipping the merge of ${base.branch} until the push is turn-key`,
              dir: repo,
            });
            continue;
          case "conflict":
            if (ownerMediatedIntegration) {
              failures.push({
                epicId: base.epicId,
                reason: `worktree-recover-backstop-conflict: merging ${base.branch} into ${defaultBranch} — ${merge.stderr}`,
                dir: repo,
              });
            } else {
              escalations.push({
                epicId: base.epicId,
                reason: `worktree-merge-conflict: merging ${base.branch} into ${defaultBranch} — ${merge.stderr}`,
                dir: repo,
              });
            }
            continue;
          case "push-timeout":
            failures.push({
              epicId: base.epicId,
              reason: `worktree-recover-push-timeout: pushing ${defaultBranch} to origin timed out (a transient stall) merging ${base.branch} — retrying next cycle`,
              dir: repo,
            });
            continue;
          case "push-failed":
            failures.push({
              epicId: base.epicId,
              reason: `worktree-recover-push-failed: ${merge.detail}`,
              dir: repo,
            });
            continue;
          case "lock-timeout":
            // The bounded commit-work flock could not be taken within its deadline.
            // A TRANSIENT defer INSIDE the `worktree-recover-*` auto-clear prefix —
            // the block lifts the moment the lock frees (no `retry_dispatch`).
            failures.push({
              epicId: base.epicId,
              reason: `worktree-recover-lock-timeout: could not acquire the commit-work lock for ${repo} within the deadline (a concurrent holder) merging ${base.branch} — retrying next cycle`,
              dir: repo,
            });
            continue;
          case "local-timeout":
            // A local merge git op timed out (a blocking hook) — a TRANSIENT defer,
            // never a content conflict.
            failures.push({
              epicId: base.epicId,
              reason: `worktree-recover-local-timeout: a local git op merging ${base.branch} into ${defaultBranch} in ${repo} timed out (a blocking git hook) — retrying next cycle`,
              dir: repo,
            });
            continue;
          case "push-unconfirmed":
            // The base merge pushed but origin/<default> does not yet PROVABLY
            // contain it (a settle lag) — a TRANSIENT defer INSIDE the
            // `worktree-recover-*` auto-clear prefix; pass-3's post-push
            // containment recheck re-confirms and tears down once origin settles
            // (no fetch/rebase/force).
            failures.push({
              epicId: base.epicId,
              reason: `worktree-recover-push-unconfirmed: pushed ${defaultBranch} but origin/${defaultBranch} still does not contain ${base.branch} (no fetch/rebase/force) — deferring teardown until origin settles`,
              dir: repo,
            });
            continue;
          case "cas-stale":
            // A CONCURRENT local advance of default moved the ref out from under the
            // plumbing merge's compare-and-swap. A TRANSIENT defer INSIDE the
            // `worktree-recover-*` auto-clear prefix — next cycle re-derives off the
            // advanced tip (no `retry_dispatch`).
            failures.push({
              epicId: base.epicId,
              reason: `worktree-recover-cas-stale: refs/heads/${defaultBranch} advanced concurrently merging ${base.branch} (update-ref CAS mismatch, no fetch/rebase/force) — retrying next cycle`,
              dir: repo,
            });
            continue;
          case "merge-tree-unsupported":
            // git < 2.38 has no `merge-tree --write-tree` for the working-tree-free
            // merge. A TRANSIENT defer inside the auto-clear prefix (never a boot
            // fatal — worktree mode is default-off) in case git is upgraded.
            failures.push({
              epicId: base.epicId,
              reason: `worktree-recover-merge-tree-unsupported: git < 2.38 has no \`merge-tree --write-tree\` for the working-tree-free merge of ${base.branch} into ${defaultBranch} in ${repo} — retrying next cycle`,
              dir: repo,
            });
            continue;
          case "plumbing-failed":
            // An UNEXPECTED plumbing git failure (a merge-tree hard error > 1, a
            // commit-tree failure, an unparseable OID, an invalid ref name) — NOT a
            // content conflict. Surfaced as its own recover reason (inside the
            // level-clear prefix) rather than vanishing into a conflict.
            failures.push({
              epicId: base.epicId,
              reason: `worktree-recover-plumbing-failed: merging ${base.branch} into ${defaultBranch} in ${repo} — ${merge.detail}`,
              dir: repo,
            });
            continue;
          default: {
            // Compile-time exhaustiveness guard so a future MergeLaneResult kind can
            // never fall through pass-2 unhandled (the silent-swallow class). The
            // runtime arm is unreachable while the union is fully handled; if a new
            // kind ever reaches here it surfaces as a recover-side failure rather
            // than vanishing.
            const _exhaustive: never = merge;
            failures.push({
              epicId: base.epicId,
              reason: `worktree-recover-unhandled-merge-kind: ${(_exhaustive as MergeLaneResult).kind} merging ${base.branch} into ${defaultBranch} in ${repo}`,
              dir: repo,
            });
            continue;
          }
        }
      } catch (err) {
        failures.push({
          epicId: base.epicId,
          reason: `worktree-recover-failed: ${base.branch} — ${errMsg(err)}`,
          dir: repo,
        });
      }
    }

    // --- Pass 3: prune orphan lanes (`keeper/epic/<id>` bases AND ribs) whose
    // epic is no longer active. --- TRI-STATE on epic activity: a lane is
    // PRESERVED while its epic is PRESENT-in-projection AND NOT done, and SWEPT
    // only once its epic is ABSENT (reaped / EpicDeleted) OR done — AND its epic
    // has no OCCUPYING close/work job (`epicHasOccupyingJob`, ADR 0031: a done
    // epic's closer mid-turn INSIDE the lane must never have its cwd deleted). A
    // lane is BORN
    // at the default tip (provision forks off it) and is-ancestor is REFLEXIVE, so
    // an OPEN epic's base — and a clean freshly-provisioned rib before its first
    // commit — IS an ancestor of default; an ancestry-ONLY sweep destroyed it
    // mid-flight. is-ancestor is KEPT as a SECONDARY safety BELOW the activity gate
    // so an UNMERGED lane is never force-deleted (also covering a pass-2 open→done
    // flip mid-cycle, and never deleting work whose merge hasn't landed). Teardown
    // is prune-before-delete, NEVER `git branch --contains` (which force-deletes
    // siblings). The candidate set is enumerated from LIVE git (no laneOrder
    // snapshot — recover has none). Mirrors the finalize-teardown sweep for the
    // crash/restart path; a done epic reaped past the recent-done window (which
    // `finalizeEpic` never swept) is still reclaimed here on the next cycle.
    let laneBranches: { branch: string; epicId: string; isRib: boolean }[];
    try {
      laneBranches = await gitListEpicLaneBranches(repo, run);
    } catch (err) {
      failures.push({
        epicId: null,
        reason: `worktree-recover-lane-list-failed: ${errMsg(err)}`,
        dir: repo,
      });
      continue;
    }
    const wtByShortBranch = new Map<string, WorktreeEntry>();
    for (const entry of entries) {
      if (entry.branch === null) {
        continue;
      }
      const short = shortBranchName(entry.branch);
      wtByShortBranch.set(short, entry);
      if (isKeeperLaneEntry(entry)) {
        const key = normalizeLanePath(entry.path);
        presentLanePaths.add(key);
        if (epicIdFromKeeperLaneEntry(entry) === null) {
          teardownCandidatePaths.add(key);
          const decision = teardownTracker.consider({
            path: key,
            state: "blocked",
            detail: "ambiguous: unparseable keeper lane branch",
            nowSec: teardownNowSec,
          });
          if (decision.mint) {
            laneTeardownDistress.push({ action: "mint", ...decision.mint });
          }
        }
      }
    }
    for (const lane of laneBranches) {
      const kind = lane.isRib ? "rib" : "base";
      try {
        if (await epicPresentAndNotDone(lane.epicId)) continue;
        const rawEpicVerdict = await isEpicDone(lane.epicId);
        const epicVerdict = normalizeEpicVerdict(rawEpicVerdict);
        if (
          epicVerdict === "inconclusive" ||
          (epicVerdict === "open" && rawEpicVerdict !== false)
        ) {
          continue;
        }
        const tombstoned = epicVerdict === "absent";
        const wt = wtByShortBranch.get(lane.branch);
        if (epicHasOccupyingJob(lane.epicId)) {
          if (wt !== undefined) {
            noteMaintenanceDeferral(
              wt.path,
              `live occupying job holds epic ${lane.epicId}`,
            );
          }
          continue;
        }

        const merged = await gitIsAncestorOf(
          repo,
          lane.branch,
          defaultBranch,
          run,
        );
        if (wt === undefined) {
          if (merged || tombstoned)
            await gitDeleteBranch(repo, lane.branch, run);
          continue;
        }
        const wtKey = normalizeLanePath(wt.path);
        const heldReason = laneHoldByPath.get(wtKey);
        if (heldReason !== undefined) {
          noteMaintenanceDeferral(wt.path, heldReason);
          continue;
        }
        const ownership = await gitClassifyLaneOwnership(repo, wt, run);
        if (ownership.kind !== "owned") {
          teardownCandidatePaths.add(wtKey);
          const decision = teardownTracker.consider({
            path: wtKey,
            state: "blocked",
            detail: `${ownership.kind}: ${ownership.detail}`,
            nowSec: teardownNowSec,
          });
          if (decision.mint) {
            laneTeardownDistress.push({ action: "mint", ...decision.mint });
          }
          continue;
        }
        if (!merged && !tombstoned) {
          teardownCandidatePaths.add(wtKey);
          const decision = teardownTracker.consider({
            path: wtKey,
            state: "blocked",
            detail: "closed-but-unmerged",
            nowSec: teardownNowSec,
          });
          if (decision.mint) {
            laneTeardownDistress.push({ action: "mint", ...decision.mint });
          }
          continue;
        }
        const mergeHeadBeforeRemove = await gitProbeLaneMergeHead(wt.path, run);
        if (mergeHeadBeforeRemove !== "absent") {
          noteMaintenanceDeferral(
            wt.path,
            mergeHeadBeforeRemove === "present"
              ? "MERGE_HEAD is present; teardown will not reset or remove an in-progress lane"
              : "MERGE_HEAD probe was inconclusive; teardown defers fail-closed",
          );
          continue;
        }

        if (
          !tombstoned &&
          !(await gitIsAncestorOf(
            repo,
            lane.branch,
            originDefaultRef(defaultBranch),
            run,
          ))
        ) {
          if (ownerMediatedIntegration) {
            continue;
          }
          const pushed = await pushDefaultToOrigin(repo, defaultBranch, run);
          if (pushed.kind !== "pushed") {
            failures.push({
              epicId: lane.epicId,
              reason: pushDefaultRecoverReason(
                pushed,
                kind,
                lane.branch,
                defaultBranch,
              ),
              dir: repo,
            });
            continue;
          }
          if (
            !(await gitIsAncestorOf(
              repo,
              lane.branch,
              originDefaultRef(defaultBranch),
              run,
            ))
          ) {
            failures.push({
              epicId: lane.epicId,
              reason: `worktree-recover-${kind}-push-unconfirmed: pushed ${defaultBranch} but origin/${defaultBranch} still does not contain ${lane.branch} (no fetch/rebase/force) — deferring teardown until origin settles`,
              dir: repo,
            });
            continue;
          }
        }

        const removed = await gitRemoveWorktree(repo, wt.path, run);
        if (removed.kind === "dirty") {
          teardownCandidatePaths.add(wtKey);
          const decision = teardownTracker.consider({
            path: wtKey,
            state: "destroyable",
            detail: removed.stderr,
            nowSec: teardownNowSec,
          });
          if (!decision.destroy) continue;

          const freshList = await run(["worktree", "list", "--porcelain"], {
            cwd: repo,
            timeoutMs: GIT_LOCAL_TIMEOUT_MS,
          });
          if (freshList.code !== 0) continue;
          const fresh = gitParseWorktreeList(freshList.stdout).find(
            (entry) => normalizeLanePath(entry.path) === wtKey,
          );
          if (fresh === undefined) {
            // The worktree is already gone (removed between the two list reads):
            // a completed removal — nudge the vanished sweep to retire its row.
            presentLanePaths.delete(wtKey);
            laneResolved.push(wt.path);
            prunedLanePaths.add(wt.path);
            tornDownLane = true;
            continue;
          }
          if (await epicPresentAndNotDone(lane.epicId)) continue;
          const rawFreshVerdict = await isEpicDone(lane.epicId);
          const freshVerdict = normalizeEpicVerdict(rawFreshVerdict);
          const freshTombstoned = freshVerdict === "absent";
          const freshClosed =
            freshVerdict === "done" || rawFreshVerdict === false;
          if (
            (!freshClosed && !freshTombstoned) ||
            epicHasOccupyingJob(lane.epicId)
          ) {
            continue;
          }
          const freshIdentity = keeperLaneIdentity(fresh);
          const freshHold = probeLaneMaintenance(laneMaintenanceProbe, {
            path: fresh.path,
            epicId: freshIdentity?.epicId ?? lane.epicId,
            taskId: freshIdentity?.taskId ?? null,
          });
          if (freshHold.kind === "defer") {
            noteMaintenanceDeferral(fresh.path, freshHold.reason);
            continue;
          }
          const freshMergeHead = await gitProbeLaneMergeHead(fresh.path, run);
          if (freshMergeHead !== "absent") {
            noteMaintenanceDeferral(
              fresh.path,
              freshMergeHead === "present"
                ? "MERGE_HEAD is present; forced teardown will not reset or remove an in-progress lane"
                : "MERGE_HEAD probe was inconclusive; forced teardown defers fail-closed",
            );
            continue;
          }
          const freshOwnership = await gitClassifyLaneOwnership(
            repo,
            fresh,
            run,
          );
          if (freshOwnership.kind !== "owned") continue;
          if (
            !freshTombstoned &&
            !(await gitIsAncestorOf(repo, lane.branch, defaultBranch, run))
          ) {
            continue;
          }
          const cleanliness = await gitRemoveWorktree(repo, fresh.path, run);
          if (cleanliness.kind === "removed") {
            presentLanePaths.delete(wtKey);
          } else {
            const forced = await gitBackupThenForceRemoveWorktree(
              repo,
              fresh,
              run,
              {
                snapshotId: () => gitLaneDirtSnapshotId(wtKey),
                ...(laneTeardown?.spoolDir
                  ? { spoolDir: laneTeardown.spoolDir }
                  : {}),
              },
            );
            if (forced.kind === "backup-failed") {
              backupFailedPaths.add(wtKey);
              const mint = teardownTracker.noteBackupFailure({
                path: wtKey,
                detail: forced.detail,
                nowSec: teardownNowSec,
              });
              if (mint) laneTeardownDistress.push({ action: "mint", ...mint });
              continue;
            }
            if (forced.kind === "remove-failed") {
              const retry = teardownTracker.consider({
                path: wtKey,
                state: "blocked",
                detail: `force-remove-failed: ${forced.detail}`,
                nowSec: teardownNowSec,
              });
              if (retry.mint) {
                laneTeardownDistress.push({ action: "mint", ...retry.mint });
              }
              continue;
            }
            presentLanePaths.delete(wtKey);
          }
        } else {
          presentLanePaths.delete(wtKey);
        }

        // Reached only on a COMPLETED removal (every deferred/failed sub-case
        // `continue`d above), so mark the teardown for the vanished-sweep nudge.
        tornDownLane = true;
        laneResolved.push(wt.path);
        prunedLanePaths.add(wt.path);
        try {
          await gitPruneWorktreeHusk(repo, wt.path, run);
        } catch (err) {
          console.error(
            `[autopilot-worker] worktree husk prune ${wt.path}: ${errMsg(err)}`,
          );
        }
        await gitPruneWorktrees(repo, run);
        await gitDeleteBranch(repo, lane.branch, run);
      } catch (err) {
        failures.push({
          epicId: lane.epicId,
          reason: `worktree-recover-${kind}-prune-failed: ${lane.branch} — ${errMsg(err)}`,
          dir: repo,
        });
      }
    }

    // --- Lane pre-merge base-readiness probe (fn-1123.2). --------------------
    // AFTER the mutating passes settle, re-classify each SURVIVING keeper lane's
    // base readiness so a persistent not-losslessly-mergeable base surfaces + a
    // resolved one clears — the level-clear that rides the recover pass rather than the
    // next dispatch, so a wedge self-clears even while the owning task is cap-gated /
    // cooled / paused. Reuses pass-1's `entries` (no extra list spawn) and skips the
    // lanes pass-3 tore down. Wrapped so a producer git error never wedges the cycle.
    try {
      // ONLY a live-owner hold suppresses the re-classify — a held lane's open row
      // persists unchanged until the hold lifts. Every UNHELD surface keeps both
      // the mint and the positive-evidence clear, so an abort-failed residue or a
      // teardown-skipped lane still surfaces its wedge instead of going quiet.
      const maintenanceHeldPaths = new Set(laneHoldByPath.keys());
      const probe = await probeLaneBaseReadiness(
        repo,
        entries,
        prunedLanePaths,
        maintenanceHeldPaths,
        run,
        hasActiveResolver,
      );
      for (const w of probe.wedged) {
        laneWedged.push(w);
      }
      for (const r of probe.resolved) {
        laneResolved.push(r);
      }
    } catch (err) {
      console.error(
        `[autopilot-worker] lane pre-merge readiness probe threw for ${repo} (non-fatal): ${errMsg(err)}`,
      );
    }
  }
  for (const clear of teardownTracker.finishCycle({
    presentPaths: presentLanePaths,
    candidatePaths: teardownCandidatePaths,
    backupFailedPaths,
    openTeardownPaths: laneTeardown?.openTeardownPaths ?? new Set(),
    openBackupPaths: laneTeardown?.openBackupPaths ?? new Set(),
    laneEnumerationComplete,
  })) {
    laneTeardownDistress.push({ action: "clear", ...clear });
  }
  const maintenanceDeferrals = [...maintenanceDeferralByPath].map(
    ([path, reason]) => ({ path, reason }),
  );
  const recoverDeferralsSeen = new Set<string>();
  for (const deferral of maintenanceDeferrals) {
    logLaneMaintenanceDeferralOnce(
      RECOVER_LANE_DEFERRAL_PASS,
      deferral.path,
      deferral.reason,
      recoverDeferralsSeen,
      deferral.reason,
    );
  }
  pruneLaneMaintenanceDeferralLatch(
    [RECOVER_LANE_DEFERRAL_PASS],
    recoverDeferralsSeen,
  );
  return {
    failures,
    escalations,
    resolved,
    laneWedged,
    laneResolved,
    maintenanceDeferrals,
    laneTeardownDistress,
    tornDownLane,
  };
}

/**
 * Probe every SURVIVING keeper lane worktree for fan-in base readiness, returning
 * per-lane `wedged` (still not losslessly-mergeable) + `resolved` (ready) observations
 * keyed by lane PATH — the recover-pass feed for the lane-wedge grace tracker + the
 * verb-agnostic reason-scoped clear. Reuses pass-1's already-fetched `entries` (no
 * second `git worktree list` spawn — the readiness of each lane is re-read LIVE per
 * path, so a lane pass-1 aborted reads clean here) and SKIPS `prunedLanePaths` (a
 * pass-3 teardown already recorded them `resolved`) plus `maintenanceHeldPaths` (a
 * LIVE owner holds the lane; its open row persists unchanged until the hold lifts).
 * Every UNHELD lane is still classified, so neither the mint nor the clear is
 * suppressed. Producer-only live-git READS, never a fold; NEVER throws past here (a
 * spawn error DEFERS the repo's lanes).
 *
 * Classification per keeper lane (a live-owner-held or active-resolver lane is
 * skipped — its MERGE_HEAD is a deliberate in-progress merge, not a wedge):
 *  - `mid-merge` surviving pass-1's abort → `immediate` wedge (a hard `abort-failed`:
 *    git could not clear it), mints distress AT ONCE (matching finalize's precedent).
 *  - tracked-`dirty` / `off-branch` → graced wedge (a base a human must hand-resolve).
 *  - clean+on-branch but carrying UNTRACKED work product → graced wedge: the
 *    would-clobber class {@link mergeReadiness} ignores (`--untracked-files=no`),
 *    probed here so a would-clobber lane row is CLEARED only once the work product
 *    is gone. A byte-identical dependency plant is losslessly cleanable residue;
 *    replaced residue at that path remains work product.
 *  - fully clean + on-branch + no untracked work product → `resolved`.
 */
async function probeLaneBaseReadiness(
  depLinkSource: string,
  entries: readonly WorktreeEntry[],
  prunedLanePaths: ReadonlySet<string>,
  maintenanceHeldPaths: ReadonlySet<string>,
  run: WorktreeGitRunner,
  hasActiveResolver: (epicId: string) => boolean,
): Promise<{
  wedged: { path: string; reason: string; immediate: boolean }[];
  resolved: string[];
}> {
  const wedged: { path: string; reason: string; immediate: boolean }[] = [];
  const resolved: string[] = [];
  for (const entry of entries) {
    if (
      entry.bare ||
      entry.branch === null ||
      !isKeeperLaneEntry(entry) ||
      prunedLanePaths.has(entry.path) ||
      maintenanceHeldPaths.has(normalizeLanePath(entry.path))
    ) {
      continue;
    }
    const laneEpicId = epicIdFromKeeperLaneEntry(entry);
    if (laneEpicId !== null && hasActiveResolver(laneEpicId)) {
      continue; // a resolver's deliberate in-progress merge is never a wedge
    }
    const expectedShort = shortBranchName(entry.branch);
    const ready = await gitMergeReadiness(entry.path, expectedShort, run);
    if (ready.kind === "ready") {
      const untracked = await gitProbeLosslesslyCleanableUntracked(
        entry.path,
        depLinkSource,
        run,
      );
      if (untracked.kind === "cleanable") {
        resolved.push(entry.path);
      } else if (untracked.kind === "would-clobber") {
        wedged.push({
          path: entry.path,
          reason: `would-clobber: ${entry.path} carries untracked work product a fan-in merge could overwrite — ${untracked.paths.join(", ")}`,
          immediate: false,
        });
      }
      // An inconclusive untracked probe DEFERS this lane — neither wedged nor
      // resolved (absence retains any open row), never a false clear.
      continue;
    }
    if (ready.kind === "mid-merge") {
      // Survived pass-1's guarded abort → git could not clear it: a hard wedge. A
      // lane a LIVE owner holds never reaches here (it is skipped above), so this
      // is crash residue no one is working, never a healthy in-progress merge.
      wedged.push({
        path: entry.path,
        reason: `abort-failed: ${entry.path} is mid-merge (MERGE_HEAD=${ready.mergeHead}) and could not be cleared`,
        immediate: true,
      });
      continue;
    }
    // `dirty` / `off-branch` / `would-clobber` — a graced wedge (a base a human must
    // hand-resolve; it settles inside the grace or escalates to distress).
    const detail =
      ready.kind === "dirty"
        ? ready.detail
        : ready.kind === "off-branch"
          ? `HEAD is ${ready.head}`
          : `would clobber ${ready.paths.join(", ")}`;
    wedged.push({
      path: entry.path,
      reason: `${ready.kind}: ${entry.path} — ${detail}`,
      immediate: false,
    });
  }
  return { wedged, resolved };
}

/**
 * Normalize a pass-2 done-probe result to the full {@link EpicRecoverVerdict}. The
 * legacy boolean probe collapses onto the two states old callers meant: `true`→done
 * (attempt the merge), `false`→open (skip, no observation). A verdict string passes
 * through, so the production probe surfaces authoritatively-absent and inconclusive.
 */
function normalizeEpicVerdict(
  v: boolean | EpicRecoverVerdict,
): EpicRecoverVerdict {
  if (v === true) {
    return "done";
  }
  if (v === false) {
    return "open";
  }
  return v;
}

/** Compact an unknown thrown value to its message string. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Map a non-`pushed` {@link PushDefaultResult} to pass-3's recover-side reason for
 * the origin-containment re-push degrade. Every variant carries the
 * `worktree-recover-*` prefix so {@link isWorktreeRecoverReason} keeps it INSIDE
 * the level-triggered auto-clear scope — a transient defer that lifts the moment
 * origin settles, never a sticky jam, never a teardown-on-failure.
 */
function pushDefaultRecoverReason(
  result: Exclude<PushDefaultResult, { kind: "pushed" }>,
  laneKind: string,
  branch: string,
  defaultBranch: string,
): string {
  switch (result.kind) {
    case "off-branch":
      return `worktree-recover-${laneKind}-off-branch: the main checkout HEAD is ${result.head}, expected ${defaultBranch} — deferring ${branch} teardown until the checkout returns to the default branch (no push off-default)`;
    case "not-turn-key":
      return `worktree-recover-${laneKind}-push-not-turn-key: ${describePushNotReady(result.reason)} — deferring ${branch} teardown until the ${defaultBranch} push to origin is turn-key (no fetch/rebase/force)`;
    case "non-ff":
      return `worktree-recover-${laneKind}-non-fast-forward: origin/${defaultBranch} is ahead of ${defaultBranch} — deferring ${branch} teardown until the checkout is updated (no fetch/rebase/force)`;
    case "push-timeout":
      return `worktree-recover-${laneKind}-push-timeout: pushing ${defaultBranch} to origin timed out (a transient stall) — deferring ${branch} teardown next cycle`;
    case "push-failed":
      return `worktree-recover-${laneKind}-push-failed: ${branch} — ${result.detail}`;
  }
}

/**
 * The deduped, non-empty repo dirs to sweep in the worktree
 * recovery pass: each epic's RESOLVED git toplevel (the main worktree its lanes
 * fork off), sourced from the snapshot's {@link WorktreeRepoResolution} so it keys
 * on the SAME toplevel the lane geometry provisioned — never a raw `project_dir`.
 * A multi-repo / unresolved epic is SKIPPED: no lane was ever provisioned for it,
 * so there is nothing to recover. `knownRoots` unions in extra RESOLVED toplevels
 * that carry NO current epic (a done epic reaped from the projection beyond the
 * recent-done window) so its lingering `keeper/epic/<id>` base is still swept —
 * the recovery scan enumerates `keeper/epic/*` per repo from live git, so a repo
 * with no visible epic still surfaces its orphan bases once the dir is in the
 * sweep set. The recovery scan itself enumerates the bases, so this only decides
 * WHICH repos autopilot sweeps.
 */
export function reposForRecovery(
  epics: readonly Epic[],
  worktreeRepoByEpicId: ReadonlyMap<string, WorktreeRepoResolution>,
  knownRoots: readonly string[] = [],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (dir: string): void => {
    if (dir === "" || seen.has(dir)) {
      return;
    }
    seen.add(dir);
    out.push(dir);
  };
  for (const epic of epics) {
    const resolution = worktreeRepoByEpicId.get(epic.epic_id);
    if (resolution === undefined) {
      continue;
    }
    if (resolution.kind === "ok") {
      push(resolution.repoDir);
    } else if (resolution.kind === "clustered") {
      // A clustered multi-repo epic provisions a lane per WORKTREE group — sweep
      // each such repo. A serial group cut no lane, so it contributes nothing.
      for (const group of resolution.groups) {
        if (group.mode === "worktree") {
          push(group.repoDir);
        }
      }
    }
  }
  for (const root of knownRoots) {
    push(root);
  }
  return out;
}

/**
 * The ONE pure frame→verdict mapping the recover epic probes share, so
 * {@link isEpicDoneById}, {@link epicRecoverVerdictById}, and
 * {@link epicPresentAndNotDone} can never diverge on what a given read frame means.
 * A RESULT frame with a `status === "done"` row → `"done"`; a result frame with a
 * not-done row → `"open"`; a result frame with NO row → `"absent"` (AUTHORITATIVE —
 * the pk-lookup bypasses the OPEN scope and every recency floor); a NON-result
 * (error) frame → `"inconclusive"` (a read that did not complete is never a
 * verdict). Pure, so an error frame is testable without engineering a live query
 * failure.
 */
export function epicFrameVerdict(
  res: ReturnType<typeof runQuery>,
): EpicRecoverVerdict {
  if (res.type !== "result") {
    return "inconclusive";
  }
  const row = res.rows[0] as { status?: unknown } | undefined;
  if (row === undefined) {
    return "absent";
  }
  return row.status === "done" ? "done" : "open";
}

/** The pk-bypass `epics` query frame the recover probes share (OPEN-scope + recency
 * floor bypassed via `runQuery(db, 0, …)`), tagged with `label` for trace ids. */
function recoverEpicQueryFrame(label: string, epicId: string) {
  return {
    type: "query" as const,
    collection: "epics",
    id: `autopilot-recover-epic-${label}${epicId}`,
    filter: { epic_id: epicId },
    limit: 1,
  };
}

/**
 * The done-ness probe finalize threads into the driver.
 * A pk-lookup read of the `epics` projection by `epic_id` (which bypasses the
 * default OPEN scope AND any recency floor in `resolveFilter`), so a DONE epic is
 * resolved UNBOUNDED by `DONE_EPICS_REAP_WINDOW_SEC` — the whole point of the
 * decoupled backstop. Returns `true` IFF the epic exists and `status === "done"`
 * (i.e. the shared {@link epicFrameVerdict} is `"done"`). A read-time producer probe
 * (never a fold).
 */
export function isEpicDoneById(
  db: Parameters<typeof runQuery>[0],
  epicId: string,
): Promise<boolean> {
  const verdict = epicFrameVerdict(
    runQuery(db, 0, recoverEpicQueryFrame("", epicId)),
  );
  return Promise.resolve(verdict === "done");
}

/**
 * The pass-2 TRI-STATE done-probe the recover glue threads into `worktree.recover`.
 * The SAME pk-bypass frame + {@link epicFrameVerdict} as {@link isEpicDoneById}, but
 * surfaces the full {@link EpicRecoverVerdict} so pass-2 distinguishes done (merge)
 * from authoritatively-absent (skip + record a positive resolution) from
 * inconclusive (defer — retain open rows). A read-time producer probe (never a fold).
 */
export function epicRecoverVerdictById(
  db: Parameters<typeof runQuery>[0],
  epicId: string,
): Promise<EpicRecoverVerdict> {
  return Promise.resolve(
    epicFrameVerdict(runQuery(db, 0, recoverEpicQueryFrame("", epicId))),
  );
}

/**
 * The present-and-not-done probe pass-3 teardown threads in to PRESERVE a lane.
 * Shares {@link isEpicDoneById}'s pk-bypass frame + {@link epicFrameVerdict}, so a
 * live in_progress/blocked epic resolves PRESENT, never absent. Returns `true` (=
 * PRESERVE the lane) IFF the verdict is `"open"` OR `"inconclusive"` — the fail-safe:
 * a scoped/recency-bounded read, OR a non-result (error) frame, must NEVER coerce to
 * sweep-eligible and FALSELY tear down a base mid-flight (the probe's own most-
 * dangerous misread). A `"done"` or authoritatively-`"absent"` epic → `false`
 * (eligible to sweep). A read-time producer probe (never a fold).
 */
export function epicPresentAndNotDone(
  db: Parameters<typeof runQuery>[0],
  epicId: string,
): Promise<boolean> {
  const verdict = epicFrameVerdict(
    runQuery(db, 0, recoverEpicQueryFrame("present-", epicId)),
  );
  return Promise.resolve(verdict === "open" || verdict === "inconclusive");
}

/** Trailing-slash-tolerant path compare helper for worktree-path equality. */
function stripTrailingSlashPath(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.replace(/\/+$/, "") : p;
}

// ===========================================================================
// Parts-6 progress actor — fenced primitives.
//
// These integrate a DONE sibling's rib into a HELD target (an existing stale
// dependent lane, or the epic base) so the sibling-source gate clears, removing
// the existing-stale-lane deadlock the target-selection seam introduces — nothing
// else integrates a rib into an existing lane (provision's pre-merge is gate-
// suppressed, the pending-integration owner integrates the BASE, base-freshness
// merges default). They are PRODUCER-ONLY git side effects (a pinned-object merge
// under the commit-work flock, or a non-destructive lane recreate) and write NO DB
// / fold. Every primitive is fully fenced and NEVER throws; the orchestrator wires
// the no-owner / no-resolver / claim-release-folded liveness gates around them.
// ===========================================================================

/** A `rev-parse` object resolution — a full oid, a POSITIVELY-absent ref, or UNKNOWN
 *  (a timeout / non-1 error / non-oid output that must DEFER, never be read as absent). */
type RevParseOutcome =
  | { kind: "oid"; oid: string }
  | { kind: "absent" }
  | { kind: "unknown"; detail: string };

/** Resolve `rev` to a full object id in `dir`, tri-stated: exit 1 is POSITIVELY absent
 *  (a torn-down / never-cut ref), exit 0 + a full oid is present, everything else (124
 *  timeout, other error, a non-oid abbreviation) is UNKNOWN. `--end-of-options` guards a
 *  `-`-leading name; `^{commit}` peels tags. */
async function revParseOid(
  dir: string,
  rev: string,
  run: WorktreeGitRunner,
): Promise<RevParseOutcome> {
  const r = await run(
    ["rev-parse", "--verify", "--quiet", "--end-of-options", rev],
    { cwd: dir, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  if (r.code === 1) {
    return { kind: "absent" };
  }
  if (r.code !== 0) {
    return {
      kind: "unknown",
      detail: r.code === GIT_SPAWN_TIMEOUT_CODE ? "timeout" : `exit ${r.code}`,
    };
  }
  const oid = r.stdout.trim();
  return isFullObjectId(oid)
    ? { kind: "oid", oid }
    : { kind: "unknown", detail: "non-oid output" };
}

/** `git merge-base --is-ancestor`, tri-stated: exit 0 = yes, exit 1 = no, everything
 *  else (a 124 SIGKILL or a git error) = UNKNOWN (the caller DEFERS — never reads an
 *  inconclusive probe as a negative). */
async function isAncestorTri(
  dir: string,
  ancestor: string,
  descendant: string,
  run: WorktreeGitRunner,
): Promise<"yes" | "no" | "unknown"> {
  const r = await run(["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: dir,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (r.code === 0) {
    return "yes";
  }
  if (r.code === 1) {
    return "no";
  }
  return "unknown";
}

/** The outcome of integrating a pinned rib object into a target checkout. */
export type RibIntegrationOutcome =
  /** The pinned source is now provably an ancestor of the target HEAD (a merge or FF
   *  landed and the tree is clean). */
  | { kind: "integrated" }
  /** The pinned source is ALREADY contained in the target HEAD — proven UNDER the lock
   *  at the effect boundary, never on a pre-lock read: a positive no-op. */
  | { kind: "already-integrated" }
  /** A GENUINE content conflict — the merge was aborted cleanly (the target's exact
   *  arrival state + its committed WIP restored); route it to a fan-in incident. */
  | { kind: "conflict"; conflictedFiles: string[]; stderr: string }
  /** Inconclusive / raced / locked / structural — retry next cycle, no mutation stuck. */
  | { kind: "defer"; reason: string };

/**
 * Integrate a DONE sibling's rib into a target checkout by its EXACT PINNED OBJECT,
 * race-free against ref movement. This is the SOURCE-SELECTOR + STRATEGY-CLASSIFIER half;
 * the destructive effect boundary (flock, CAS, fresh registration, readiness, the
 * under-lock no-op arm, the pinned merge, the post-checks) is owned by
 * {@link gitMergePinnedObjectFenced}. Both no-op arms go THROUGH the fence — the actor
 * never certifies containment on a pre-lock read.
 *
 * SOURCE-OID SELECTION at the effect boundary (the rib can be torn down between the actor's
 * enumeration and here, so re-resolve it):
 *  - rib PRESENT on a successful enumeration → the rib OID;
 *  - rib DEFINITIVELY ABSENT (exit 1) → the EPIC BASE OID: teardown merged the rib into the
 *    base, so proving the base is contained in the target proves the rib is too — re-pin the
 *    base at the boundary (it can move between observation and effect) and merge THAT through
 *    the fence, NEVER a blind `already-integrated` (an off-branch / path-replaced / drifted
 *    target must never read as integrated);
 *  - rib enumeration UNKNOWN, or the base unresolved when the rib is absent → defer (an
 *    absence on a FAILED enumeration proves nothing).
 * STRATEGY from the PINNED oids (never a re-resolved branch): source ⊆ target → `ff` (the
 * fence's under-lock no-op arm resolves it to `already-integrated`); target ⊆ source → an
 * exact-object FAST-FORWARD; TRUE DIVERGENCE → a two-parent merge; an inconclusive ancestry
 * probe → defer (never read as a negative). Producer-only; NEVER throws.
 */
export async function integratePinnedRib(
  dir: string,
  targetBranch: string,
  sourceBranch: string,
  epicBaseBranch: string,
  run: WorktreeGitRunner = gitExec,
  acquireLock?: LockAcquirer,
): Promise<RibIntegrationOutcome> {
  try {
    // (0) Snapshot the pinned fence: the target HEAD object.
    const targetHead = await revParseOid(dir, "HEAD^{commit}", run);
    if (targetHead.kind !== "oid") {
      return {
        kind: "defer",
        reason: `target head unresolved (${targetHead.kind === "absent" ? "absent" : targetHead.detail})`,
      };
    }
    const targetOid = targetHead.oid;

    // (1) Source-OID selection: the rib, else the epic base (rib torn down), else defer.
    const rib = await revParseOid(
      dir,
      `refs/heads/${sourceBranch}^{commit}`,
      run,
    );
    let sourceOid: string;
    if (rib.kind === "oid") {
      sourceOid = rib.oid;
    } else if (rib.kind === "absent") {
      const base = await revParseOid(
        dir,
        `refs/heads/${epicBaseBranch}^{commit}`,
        run,
      );
      if (base.kind !== "oid") {
        return {
          kind: "defer",
          reason: `rib torn down but epic base unresolved (${base.kind === "absent" ? "absent" : base.detail})`,
        };
      }
      sourceOid = base.oid;
    } else {
      return { kind: "defer", reason: `source ref unresolved (${rib.detail})` };
    }

    // (2) Classify the strategy from the PINNED oids. An inconclusive probe never reads as
    //     a negative; the source ⊆ target no-op is resolved UNDER the lock by the fence, so
    //     it too routes through the fence (strategy is moot there).
    const srcInTarget = await isAncestorTri(dir, sourceOid, targetOid, run);
    if (srcInTarget === "unknown") {
      return {
        kind: "defer",
        reason: "source-in-target ancestry inconclusive",
      };
    }
    let strategy: "ff" | "diverged" = "ff";
    if (srcInTarget === "no") {
      const targetInSrc = await isAncestorTri(dir, targetOid, sourceOid, run);
      if (targetInSrc === "unknown") {
        return {
          kind: "defer",
          reason: "target-in-source ancestry inconclusive",
        };
      }
      strategy = targetInSrc === "yes" ? "ff" : "diverged";
    }

    // (3) Effect boundary — the fence owns the flock, the CAS, the fresh worktree-list
    //     registration, the readiness, the under-lock no-op arm, the pinned merge, and the
    //     positive post-checks.
    return gitMergePinnedObjectFenced(dir, {
      sourceOid,
      expectedHeadOid: targetOid,
      targetBranch,
      strategy,
      run,
      acquireLock,
    });
  } catch (err) {
    return { kind: "defer", reason: `integration probe threw: ${errMsg(err)}` };
  }
}

/** The regime a held dependent LANE is in for integrating a rib — the destructive-edge
 *  gate keyed on COMMITTED WIP vs UNCOMMITTED dirt (the two are different regimes). */
export type LaneIntegrationRegime =
  /** Clean tracked tree, on-branch, no residue, AND unique committed WIP → the rib may be
   *  MERGED into the lane (the only mutation path for a WIP lane); benign untracked files
   *  are permitted only when proven disjoint from the incoming object. */
  | { kind: "merge" }
  /** No unique commits AND fully clean (tracked + NO untracked) + residue-free + on-branch
   *  → the lane may be RECREATED off the fresh base (removal destroys nothing). */
  | { kind: "recreate" }
  /** Any uncommitted/staged/untracked-overlapping/in-progress residue, or an inconclusive
   *  probe → DEFER to the dead-writer sweep / dirt-recovery ownership; never mutate. */
  | { kind: "defer"; reason: string };

/**
 * Classify a held dependent LANE's integration regime, honoring the committed-WIP vs
 * uncommitted-dirt split (they are DIFFERENT regimes, and only committed WIP earns the
 * merge path). `mergeReadiness` (which reads `--untracked-files=no`) establishes tracked
 * cleanliness + on-branch + residue-freedom; a positive `dirty`/`mid-merge`/`off-branch`
 * DEFERS to dirt/recovery ownership. Then:
 *  - unique COMMITS present (rev-list `base..lane` non-empty) → `merge`, but benign
 *    UNTRACKED files are allowed ONLY when the incoming object's path set is provably
 *    DISJOINT from them (the established would-clobber probe); overlap or UNKNOWN clobber
 *    evidence DEFERS (never risk overwriting untracked work);
 *  - NO unique commits → `recreate`, but ANY untracked file blocks it UNCONDITIONALLY
 *    (removal could destroy untracked data);
 *  - any inconclusive probe → DEFER.
 * Producer-only reads; NEVER throws. The no-owner/no-resolver/no-claim gate is the
 * orchestrator's, NOT this probe's.
 */
export async function probeLaneIntegrationRegime(
  laneDir: string,
  laneBranch: string,
  forkBaseBranch: string,
  incomingSourceOid: string,
  run: WorktreeGitRunner = gitExec,
): Promise<LaneIntegrationRegime> {
  try {
    const ready = await gitMergeReadiness(laneDir, laneBranch, run);
    if (ready.kind === "mid-merge") {
      return {
        kind: "defer",
        reason: `mid-merge residue (MERGE_HEAD=${ready.mergeHead}) — dirt/recovery owns it`,
      };
    }
    if (ready.kind === "off-branch") {
      return { kind: "defer", reason: `off-branch (HEAD=${ready.head})` };
    }
    if (ready.kind === "dirty") {
      return {
        kind: "defer",
        reason: `tracked dirt / in-progress residue: ${ready.detail}`,
      };
    }
    if (ready.kind !== "ready") {
      return { kind: "defer", reason: `lane not ready: ${ready.kind}` };
    }
    // Unique committed WIP: commits on the lane not in its fork base.
    const wip = await run(
      [
        "rev-list",
        "--count",
        `refs/heads/${forkBaseBranch}..refs/heads/${laneBranch}`,
      ],
      { cwd: laneDir, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
    );
    if (wip.code !== 0) {
      return {
        kind: "defer",
        reason: `unique-commit probe inconclusive (${wip.code === GIT_SPAWN_TIMEOUT_CODE ? "timeout" : `exit ${wip.code}`})`,
      };
    }
    // STRICT whole-output parse: `Number.parseInt` would read "0garbage" as 0 (→ the
    // DESTRUCTIVE recreate arm) and "-5" as a negative; only an exact non-negative integer
    // is a count, anything else DEFERS.
    const wipStr = wip.stdout.trim();
    if (!/^(0|[1-9][0-9]*)$/.test(wipStr)) {
      return {
        kind: "defer",
        reason: `unique-commit probe returned a non-count (${JSON.stringify(wipStr.slice(0, 40))})`,
      };
    }
    const wipCount = Number.parseInt(wipStr, 10);
    // Untracked set (mergeReadiness ignored these; they gate BOTH arms differently).
    const untrackedR = await run(
      ["ls-files", "--others", "--exclude-standard"],
      {
        cwd: laneDir,
        timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      },
    );
    if (untrackedR.code !== 0) {
      return {
        kind: "defer",
        reason: `untracked probe inconclusive (${untrackedR.code === GIT_SPAWN_TIMEOUT_CODE ? "timeout" : `exit ${untrackedR.code}`})`,
      };
    }
    const untracked = untrackedR.stdout
      .split("\n")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    if (wipCount > 0) {
      // COMMITTED WIP → the MERGE arm.
      if (untracked.length === 0) {
        return { kind: "merge" };
      }
      // Benign untracked files are permitted ONLY when PROVABLY disjoint from the incoming
      // object's tree. A STRICT direct probe (`ls-tree` of the pinned incoming oid): a
      // failed / timed-out read fail-CLOSES to defer — it cannot prove disjointness, so it
      // must never fall through to a merge that could clobber untracked work.
      const incomingR = await run(
        ["ls-tree", "-r", "--name-only", incomingSourceOid],
        { cwd: laneDir, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
      );
      if (incomingR.code !== 0) {
        return {
          kind: "defer",
          reason: `incoming-tree read ${incomingR.code === GIT_SPAWN_TIMEOUT_CODE ? "timed out" : `failed (exit ${incomingR.code})`} — cannot prove untracked-disjoint`,
        };
      }
      const incomingSet = new Set(
        incomingR.stdout
          .split("\n")
          .map((p) => p.trim())
          .filter((p) => p.length > 0),
      );
      const overlap = untracked.filter((p) => incomingSet.has(p));
      if (overlap.length > 0) {
        return {
          kind: "defer",
          reason: `untracked would be clobbered by the merge: ${overlap.join(", ").slice(0, 160)}`,
        };
      }
      return { kind: "merge" };
    }
    // NO committed WIP → the RECREATE arm — any untracked file blocks it unconditionally.
    if (untracked.length > 0) {
      return {
        kind: "defer",
        reason: `untracked files present — recreate would destroy them: ${untracked.join(", ").slice(0, 160)}`,
      };
    }
    return { kind: "recreate" };
  } catch (err) {
    return { kind: "defer", reason: `regime probe threw: ${errMsg(err)}` };
  }
}

/** The outcome of recreating a clean, no-WIP dependent lane off its fresh base. */
export type LaneRecreateOutcome =
  | { kind: "recreated" }
  | { kind: "defer"; reason: string }
  | { kind: "failed"; reason: string };

/**
 * Recreate a clean, no-committed-WIP dependent lane off its FRESH base — the non-
 * destructive path for a stale lane that carries nothing to preserve. The caller's
 * {@link probeLaneIntegrationRegime} → `recreate` verdict is PRE-lock evidence; this
 * re-proves the FULL eligibility set UNDER the commit-work flock, IMMEDIATELY before the
 * destructive removal, so a commit / dirt / registration swap that arrived after the pre-
 * probe ABORTS with ZERO mutation:
 *  1. flock (a timeout → defer, never a freeze);
 *  2. FRESH registration — the exact path is a registered worktree on `laneBranch`;
 *  3. {@link gitMergeReadiness} clean + on-branch + residue-free;
 *  4. STRICT unique-commit re-count == 0 (a commit that arrived after the pre-probe → defer,
 *     NEVER recreate over WIP) and untracked ABSENT (recreate would destroy them);
 *  5. capture the lane HEAD oid, remove the worktree WITHOUT force (a raced dirty tree
 *     REFUSES → defer), content-gated `.claude`-husk sweep of the leftover dir;
 *  6. CAS branch delete (`git update-ref -d refs/heads/<lane> <capturedOid>`) — a branch
 *     that moved between capture and delete REFUSES → defer, NEVER a `-D` that loses commits;
 *  7. re-cut the lane off the FRESH base (`ensureWorktree` creates the branch AT the base)
 *     and restore its dep link; the ok registration is the POSTCONDITION proof.
 * Producer-only; NEVER throws.
 */
export async function recreateLaneOffBase(
  repoDir: string,
  laneDir: string,
  laneBranch: string,
  freshBaseBranch: string,
  run: WorktreeGitRunner = gitExec,
  ensureDepLink: (
    sourceCheckout: string,
    worktreePath: string,
  ) => Promise<void> = gitEnsureWorktreeDepLink,
  acquireLock?: LockAcquirer,
): Promise<LaneRecreateOutcome> {
  try {
    const acquire = acquireLock ?? defaultCommitWorkLockAcquirer;
    const lockPath = await gitCommitWorkLockPath(laneDir, run);
    const lock = await acquire(lockPath);
    if (lock === null) {
      return { kind: "defer", reason: "commit-work lock timeout" };
    }
    try {
      // (2) FRESH registration re-prove — the exact path is a registered worktree on the
      //     lane branch (a swap / re-registration between the pre-probe and here → defer).
      const listed = await gitListWorktreesResult(laneDir, run);
      if (listed.kind !== "ok") {
        return {
          kind: "defer",
          reason: `worktree registration probe ${listed.kind} under lock`,
        };
      }
      const entry = listed.value.find(
        (e) =>
          stripTrailingSlashPath(e.path) === stripTrailingSlashPath(laneDir),
      );
      if (entry === undefined || entry.branch !== `refs/heads/${laneBranch}`) {
        return {
          kind: "defer",
          reason:
            entry === undefined
              ? "lane registration absent under lock"
              : `lane registered on ${entry.branch ?? "(detached)"}, expected ${laneBranch}`,
        };
      }
      // (3) Clean, on-branch, residue-free.
      const ready = await gitMergeReadiness(laneDir, laneBranch, run);
      if (ready.kind !== "ready") {
        return {
          kind: "defer",
          reason: `lane not clean under lock: ${ready.kind}`,
        };
      }
      // (4) STRICT unique-commit re-count — a commit arrived after the pre-probe → defer,
      //     NEVER recreate over committed WIP.
      const wip = await run(
        [
          "rev-list",
          "--count",
          `refs/heads/${freshBaseBranch}..refs/heads/${laneBranch}`,
        ],
        { cwd: laneDir, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
      );
      if (wip.code !== 0) {
        return {
          kind: "defer",
          reason: `unique-commit re-probe inconclusive under lock (${wip.code === GIT_SPAWN_TIMEOUT_CODE ? "timeout" : `exit ${wip.code}`})`,
        };
      }
      const wipStr = wip.stdout.trim();
      if (!/^(0|[1-9][0-9]*)$/.test(wipStr)) {
        return {
          kind: "defer",
          reason: `unique-commit re-probe returned a non-count (${JSON.stringify(wipStr.slice(0, 40))})`,
        };
      }
      if (wipStr !== "0") {
        return {
          kind: "defer",
          reason: `commit arrived after the pre-probe (${wipStr} unique) — never recreate over WIP`,
        };
      }
      // Untracked ABSENT — a recreate removes the tree, so any untracked file would be lost.
      const untracked = await run(
        ["ls-files", "--others", "--exclude-standard"],
        { cwd: laneDir, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
      );
      if (untracked.code !== 0) {
        return {
          kind: "defer",
          reason: `untracked re-probe inconclusive under lock (${untracked.code === GIT_SPAWN_TIMEOUT_CODE ? "timeout" : `exit ${untracked.code}`})`,
        };
      }
      if (untracked.stdout.split("\n").some((l) => l.trim().length > 0)) {
        return {
          kind: "defer",
          reason:
            "untracked files arrived after the pre-probe — never recreate over them",
        };
      }
      // (5) Capture the lane HEAD for the CAS delete, then remove WITHOUT force.
      const laneHead = await revParseOid(laneDir, "HEAD^{commit}", run);
      if (laneHead.kind !== "oid") {
        return {
          kind: "defer",
          reason: `lane head unresolved under lock (${laneHead.kind === "absent" ? "absent" : laneHead.detail})`,
        };
      }
      const laneHeadOid = laneHead.oid;
      const removed = await gitRemoveWorktree(repoDir, laneDir, run);
      if (removed.kind === "dirty") {
        return {
          kind: "defer",
          reason: `worktree remove refused (raced dirty): ${removed.stderr.slice(0, 160)}`,
        };
      }
      // Content-gated husk sweep — a residue-only `.claude` dir git can leave behind.
      // Best-effort: teardown already succeeded, so a sweep hiccup is not a failure.
      try {
        await gitPruneWorktreeHusk(repoDir, laneDir, run);
      } catch {
        // swallow — the husk sweep never gates the recreate.
      }
      // (6) CAS branch delete — refuse (defer) if the branch moved after the capture, so a
      //     racing commit can never be force-deleted.
      const del = await run(
        ["update-ref", "-d", `refs/heads/${laneBranch}`, laneHeadOid],
        { cwd: repoDir, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
      );
      if (del.code !== 0) {
        return {
          kind: "defer",
          reason: `lane branch moved after removal (CAS delete refused): ${(del.stdout + del.stderr).trim().slice(0, 160)}`,
        };
      }
      // (7) Re-cut off the FRESH base and restore the dep link.
      const ensured = await gitEnsureWorktreeResult(
        repoDir,
        laneDir,
        laneBranch,
        freshBaseBranch,
        run,
      );
      if (ensured.kind === "timeout" || ensured.kind === "inconclusive") {
        return {
          kind: "defer",
          reason: `could not re-cut ${laneBranch} off ${freshBaseBranch}${ensured.kind === "inconclusive" ? ` — ${ensured.detail}` : " (timeout)"}`,
        };
      }
      if (ensured.kind === "error") {
        return {
          kind: "failed",
          reason: `lane recreate failed: ${ensured.detail}`,
        };
      }
      await ensureDepLink(repoDir, laneDir);
      return { kind: "recreated" };
    } finally {
      lock.release();
    }
  } catch (err) {
    return { kind: "failed", reason: `lane recreate threw: ${errMsg(err)}` };
  }
}

/** A transient progress-actor failure (a positively-failed recreate) surfaced as a
 *  visible `work::<taskId>` `dispatch_failures` row — distinct from the SILENT defers. */
export interface ProgressActorFailure {
  taskId: string;
  reason: string;
  dir: string | null;
}

/** A genuine content conflict integrating a rib into a held lane — routed to a
 *  `work::<taskId>` `worktree-merge-conflict` fan-in incident (no destruction). */
export interface ProgressActorEscalation {
  taskId: string;
  reason: string;
  dir: string | null;
  conflictedFiles: string[];
}

/** The parts-6 progress actor's per-cycle result — fed the SAME resolved / failures /
 *  escalations rails recover uses, plus `integratedAny` so the caller arms the liveness
 *  nudge (external git progress may not bump PRAGMA data_version). */
export interface ProgressActorOutcome {
  resolved: string[];
  failures: ProgressActorFailure[];
  escalations: ProgressActorEscalation[];
  integratedAny: boolean;
}

/**
 * The parts-6 PROGRESS ACTOR: scan the sibling-source-gate's HELD dependents INDEPENDENTLY
 * of the launch list and integrate a blocking DONE sibling's rib into the dependent's
 * EXISTING stale lane — the deadlock the target-selection seam introduces, since nothing
 * else integrates a rib into an existing lane. Producer-only git side effects under the
 * commit-work flock; NEVER throws.
 *
 * Per held dependent, on the SAME {@link prepareWorktreeGeometry} the gate + dispatch
 * consume: a LIVE resolver / owner / claim (incl. a stopped-but-unreleased claim, via the
 * shared {@link LaneMaintenanceProbe}) leaves the target UNTOUCHED. Only an EXISTING lane
 * (positively enumerated) whose branch is missing a done rib is acted on — a pre-cut lane
 * is the pending-integration owner's / provision's, never the actor's. The strategy, keyed
 * on {@link probeLaneIntegrationRegime}:
 *  - COMMITTED WIP → {@link integratePinnedRib} merges the rib into the lane (a conflict
 *    aborts cleanly and escalates a `work::<taskId>` incident, the branch + WIP retained);
 *  - NO WIP + fully clean → {@link recreateLaneOffBase} re-cuts the lane off its fresh
 *    fork base, but ONLY when that base ALREADY contains the rib (else a recreate would be
 *    futile churn or drop the rib — defer to the base's own integration first);
 *  - any dirt / residue / inconclusive probe → DEFER silently (retry next cycle).
 * A successful integration sets `integratedAny` so the caller nudges the reconciler to
 * re-evaluate the gate immediately (the git progress bumps no `data_version`).
 */
export async function runProgressActor(
  heldTaskIds: ReadonlySet<string>,
  epics: readonly Epic[],
  worktreeRepoByEpicId: ReadonlyMap<string, WorktreeRepoResolution>,
  worktreesRoot: string | undefined,
  laneLiveness: LaneMaintenanceProbe | undefined,
  hasActiveResolver: (epicId: string) => boolean,
  run: WorktreeGitRunner = gitExec,
  acquireLock?: LockAcquirer,
  ensureDepLink: (
    sourceCheckout: string,
    worktreePath: string,
  ) => Promise<void> = gitEnsureWorktreeDepLink,
): Promise<ProgressActorOutcome> {
  const resolved: string[] = [];
  const failures: ProgressActorFailure[] = [];
  const escalations: ProgressActorEscalation[] = [];
  let integratedAny = false;
  if (heldTaskIds.size === 0) {
    return { resolved, failures, escalations, integratedAny };
  }

  const laneSetByRepo = new Map<string, EpicLaneBranchSet>();
  const enumerateLanes = async (
    repoDir: string,
  ): Promise<EpicLaneBranchSet> => {
    const hit = laneSetByRepo.get(repoDir);
    if (hit !== undefined) {
      return hit;
    }
    let value: EpicLaneBranchSet;
    try {
      value = await gitEnumerateEpicLaneBranches(repoDir, run);
    } catch {
      value = { ok: false };
    }
    laneSetByRepo.set(repoDir, value);
    return value;
  };

  const { byEpicId } = prepareWorktreeGeometry(
    epics,
    worktreeRepoByEpicId,
    worktreesRoot,
  );
  for (const epic of epics) {
    const geom = byEpicId.get(epic.epic_id);
    if (geom === undefined) {
      continue;
    }
    const lanes: Array<{ repoDir: string; plan: WorktreePlan }> = [];
    if (geom.kind === "ok") {
      lanes.push({ repoDir: geom.repoDir, plan: geom.plan });
    } else if (geom.kind === "clustered") {
      for (const g of geom.groups) {
        if (g.mode === "worktree" && g.plan !== undefined) {
          lanes.push({ repoDir: g.repoDir, plan: g.plan });
        }
      }
    } else {
      continue;
    }

    const taskById = new Map(epic.tasks.map((t) => [t.task_id, t]));
    for (const { repoDir, plan } of lanes) {
      for (const assignment of plan.assignments) {
        if (assignment.isCloseSink || !heldTaskIds.has(assignment.nodeId)) {
          continue;
        }
        const dependent = taskById.get(assignment.nodeId);
        if (dependent === undefined) {
          continue;
        }
        const doneParents = dependent.depends_on
          .map((depId) => taskById.get(depId))
          .filter(
            (p): p is Task => p !== undefined && p.worker_phase === "done",
          );
        if (doneParents.length === 0) {
          continue;
        }
        // LIVENESS GATES — a live resolver, owner, or claim (incl. a stopped-but-
        // unreleased dispatch claim, which the shared lane-liveness probe DEFERS on until
        // its release is folded) leaves the target UNTOUCHED.
        if (hasActiveResolver(epic.epic_id)) {
          continue;
        }
        if (
          laneLiveness !== undefined &&
          laneLiveness({
            path: assignment.worktreePath,
            epicId: epic.epic_id,
            taskId: assignment.nodeId,
          }).kind === "defer"
        ) {
          continue;
        }
        try {
          const laneSet = await enumerateLanes(repoDir);
          if (!laneSet.ok || !laneSet.branches.has(assignment.branch)) {
            // Enumeration unknown, or a pre-cut lane (owned by the pending-integration
            // owner / provision, never the actor) → leave held.
            continue;
          }
          const forkBase = parentBranchFor(assignment, plan, epic.tasks);
          // The FIRST done rib the lane branch does not yet contain — the edge to integrate.
          let blockingRib: string | null = null;
          for (const parent of doneParents) {
            const rib = ribBranchFor(epic.epic_id, parent.task_id);
            if (!laneSet.branches.has(rib)) {
              continue; // definitively absent → merged-and-torn-down (contained)
            }
            if (
              !(await gitIsAncestorOf(repoDir, rib, assignment.branch, run))
            ) {
              blockingRib = rib;
              break;
            }
          }
          if (blockingRib === null) {
            // Every done rib is already in the lane branch; the hold is on worktree
            // readiness (dirt / registration), owned by the dead-writer / dirt-recovery
            // sweep — recreating off the base could DROP a rib the branch already carries.
            continue;
          }
          const regime = await probeLaneIntegrationRegime(
            assignment.worktreePath,
            assignment.branch,
            forkBase,
            blockingRib,
            run,
          );
          if (regime.kind === "merge") {
            const out = await integratePinnedRib(
              assignment.worktreePath,
              assignment.branch,
              blockingRib,
              baseBranchFor(epic.epic_id),
              run,
              acquireLock,
            );
            if (
              out.kind === "integrated" ||
              out.kind === "already-integrated"
            ) {
              resolved.push(assignment.nodeId);
              integratedAny = true;
            } else if (out.kind === "conflict") {
              escalations.push({
                taskId: assignment.nodeId,
                reason: `worktree-merge-conflict: integrating ${blockingRib} into ${assignment.branch} — ${out.stderr.slice(0, 200)}`,
                dir: assignment.worktreePath,
                conflictedFiles: out.conflictedFiles,
              });
            }
            // out.kind === "defer" → silent retry next cycle.
          } else if (regime.kind === "recreate") {
            // Recreate re-cuts the lane off its fork base, so that base MUST already
            // contain the rib — else a recreate is futile churn (or would drop the rib).
            if (!(await gitIsAncestorOf(repoDir, blockingRib, forkBase, run))) {
              continue;
            }
            const out = await recreateLaneOffBase(
              repoDir,
              assignment.worktreePath,
              assignment.branch,
              forkBase,
              run,
              ensureDepLink,
              acquireLock,
            );
            if (out.kind === "recreated") {
              resolved.push(assignment.nodeId);
              integratedAny = true;
            } else if (out.kind === "failed") {
              failures.push({
                taskId: assignment.nodeId,
                reason: out.reason,
                dir: assignment.worktreePath,
              });
            }
            // out.kind === "defer" → silent retry next cycle.
          }
          // regime.kind === "defer" → silent retry next cycle.
        } catch {
          // A probe threw — leave the dependent held; the gate re-evaluates next cycle.
        }
      }
    }
  }
  return { resolved, failures, escalations, integratedAny };
}

// ---------------------------------------------------------------------------
// Tip-triggered baseline producer (fn-1203)
// ---------------------------------------------------------------------------

/**
 * One open-epic repo's current default-branch tip — the producer's unit of
 * observation: a `git_status.project_dir` carrying an open epic, paired with that
 * projection row's `head_oid`. The autopilot's primary checkout stays on the
 * default branch (worktree lanes are separate checkouts; a non-worktree epic
 * commits directly on default), so this head IS the default-branch tip.
 */
export interface TipObservation {
  /** The repo's `git_status` project dir (== the epic's `project_dir`). */
  repoDir: string;
  /** The projection's current `head_oid` for that repo. */
  tipSha: string;
}

/**
 * Gather the tip observations for the baseline producer: each repo carrying an
 * OPEN epic (`status !== "done"`), paired with its current `git_status` head oid,
 * deduped per repo (many epics in one repo share the one tip). A done epic, an
 * epic with no `project_dir`, or a repo with no head-carrying git row (an
 * initial-commit repo) yields nothing. PURE — reads the passed projections only,
 * never git or a fold.
 */
export function gatherTipObservations(
  epics: readonly Epic[],
  gitHeadByProjectDir: ReadonlyMap<string, string>,
): TipObservation[] {
  const out: TipObservation[] = [];
  const seen = new Set<string>();
  for (const epic of epics) {
    if (epic.status === "done") continue;
    const dir = epic.project_dir;
    if (dir === null || dir.length === 0 || seen.has(dir)) continue;
    seen.add(dir);
    const tip = gitHeadByProjectDir.get(dir);
    if (tip !== undefined && tip.length > 0) {
      out.push({ repoDir: dir, tipSha: tip });
    }
  }
  return out;
}

/**
 * The pure tip-change → baseline-spool plan. Given the current open-epic tip
 * observations and the last tip this reconciler already spooled per repo, emit
 * ONE baseline request per repo whose tip CHANGED and return the next per-repo
 * tip map.
 *
 * Coalescing is by SAMPLING: each cycle observes only the repo's CURRENT tip, so
 * a rapid push train collapses to the latest sha (intermediate tips between
 * cycles are never observed) and the store's key-dedup makes any duplicate
 * request idempotent. An unchanged tip emits nothing (the "exactly one request
 * per change, idempotent across cycles" bar); a fresh boot (`prevTip` empty)
 * re-spools the current tip once, harmless by compute-once-per-key. `nextTip`
 * carries every observed repo's current tip (changed or not) so the caller can
 * adopt it as the new baseline; it is bounded to the current open-epic repo set.
 * An empty/invalid sha observation is dropped. PURE — the toolchain and clock
 * ride in as data so key composition never reads the environment.
 */
export function planTipBaselineRequests(params: {
  observations: readonly TipObservation[];
  prevTip: ReadonlyMap<string, string>;
  toolchain: ToolchainFingerprint;
  now: number;
}): { requests: BaselineRequest[]; nextTip: Map<string, string> } {
  const { observations, prevTip, toolchain, now } = params;
  const requests: BaselineRequest[] = [];
  const nextTip = new Map<string, string>();
  for (const { repoDir, tipSha } of observations) {
    if (repoDir.length === 0 || !isValidSha(tipSha) || nextTip.has(repoDir)) {
      continue;
    }
    nextTip.set(repoDir, tipSha);
    if (prevTip.get(repoDir) === tipSha) continue; // unchanged — no spool
    requests.push(buildRequest({ repoDir, sha: tipSha, toolchain }, now));
  }
  return { requests, nextTip };
}

/**
 * Read `project_dir → head_oid` from the `git_status` projection (the git-worker's
 * feed) via the reconciler's read-only connection — the producer-side tip source
 * for {@link gatherTipObservations}. A null/absent head (an initial-commit repo)
 * is dropped. Producer read only, NEVER a fold.
 */
export function readGitHeadByProjectDir(
  db: Parameters<typeof runQuery>[0],
): Map<string, string> {
  const out = new Map<string, string>();
  const res = runQuery(db, 0, {
    type: "query" as const,
    collection: "git",
    id: "autopilot-baseline-git",
    limit: 0,
  });
  if (res.type !== "result") return out;
  for (const row of res.rows as Record<string, unknown>[]) {
    const dir = row.project_dir;
    const head = row.head_oid;
    if (
      typeof dir === "string" &&
      dir.length > 0 &&
      typeof head === "string" &&
      head.length > 0
    ) {
      out.set(dir, head);
    }
  }
  return out;
}

/**
 * The per-cycle tip-triggered baseline producer: observe each open-epic repo's
 * current default-branch tip off the `git_status` projection, spool ONE baseline
 * request per repo whose tip changed since this reconciler last spooled it, and
 * advance the in-memory per-repo tip map. The reconciler is a SANCTIONED second
 * writer of the request spool (alongside the `keeper baseline` CLI) — a direct
 * dep-light atomic write, no subprocess. Idempotent across cycles (unchanged tip
 * → no write) and boots (`baselineTipByRepo` boots empty; the first observation
 * re-spools the current tip, harmless by compute-once-per-key). A spool-write
 * failure is logged and its tip is NOT recorded, so the next cycle retries it.
 * Producer-side only; never a fold. NEVER throws (the caller wraps it too).
 */
function runBaselineTipProducer(
  epics: readonly Epic[],
  gitHeadByProjectDir: ReadonlyMap<string, string>,
  baselineTipByRepo: Map<string, string>,
  deps: {
    now: () => number;
    toolchain: ToolchainFingerprint;
    writeSpoolRequest: (request: BaselineRequest) => void;
  },
): void {
  const observations = gatherTipObservations(epics, gitHeadByProjectDir);
  const { requests, nextTip } = planTipBaselineRequests({
    observations,
    prevTip: baselineTipByRepo,
    toolchain: deps.toolchain,
    now: deps.now(),
  });
  // Adopt the observed current tips, then revert any repo whose spool write
  // failed back to its prior tip (or drop it) so the change re-fires next cycle.
  const nextMap = new Map(nextTip);
  for (const request of requests) {
    try {
      deps.writeSpoolRequest(request);
    } catch (err) {
      console.error(
        `[autopilot-worker] baseline spool write failed for ${request.repoDir}: ${errMsg(err)}`,
      );
      const prev = baselineTipByRepo.get(request.repoDir);
      if (prev === undefined) nextMap.delete(request.repoDir);
      else nextMap.set(request.repoDir, prev);
    }
  }
  baselineTipByRepo.clear();
  for (const [dir, tip] of nextMap) baselineTipByRepo.set(dir, tip);
}

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------

/** workerData payload. */
export interface AutopilotWorkerData {
  dbPath: string;
  /**
   * Initial paused flag. The supervisor seeds this from the durable
   * `autopilot_state.paused` column it read after the boot drain — so the worker
   * resumes the last durable state (PLAYING if a `play` was the last durable
   * intent) and a fresh board boots PAUSED. Absent → `?? true` in `main()`
   * (boots-paused safety default for a degraded boot). Steady-state pause/play
   * arrives via `set-paused`. Exposed so tests can override.
   */
  paused?: boolean;
  /** Poll cadence for the data_version wake loop (ms). */
  pollMs?: number;
  /**
   * The launcher argv PREFIX (`[<abs bun>, <abs cli/keeper.ts>, "agent"]`) the
   * reconciler spawns to reach the folded `keeper agent` launcher — keeper's sole
   * launch transport. Resolved once on main (`process.execPath` +
   * `resolveKeeperAgentPath()`: env override + config + `~`-expansion) and frozen
   * in here (restart-to-apply: a config flip lags until the next restart). The
   * in-worker reconciler dispatches DIRECTLY through `keeper agent` into the
   * hardcoded `MANAGED_EXEC_SESSION` (not configurable).
   */
  launcherArgvPrefix?: string[];
  /**
   * Worker-role discriminator. The bottom-of-file entrypoint runs `main()`
   * ONLY when this is `"autopilot"`. Any other worker module that imports this
   * module for its `loadReconcileSnapshot` export runs as `!isMainThread`
   * itself — the gate stops that import from booting a stowaway reconciler
   * (racing dispatch decisions against the real one) in that worker's
   * thread.
   */
  role?: "autopilot";
}

/** Main → worker: paused-flag flip. */
export interface SetPausedMessage {
  type: "set-paused";
  paused: boolean;
}

/** Main → worker: shutdown. */
export interface ShutdownMessage {
  type: "shutdown";
}

/**
 * Worker → main: DispatchFailed mint request. Main is the sole writer of the
 * synthetic event; the worker only describes what to mint.
 */
export interface DispatchFailedMessage {
  kind: "dispatch-failed";
  payload: DispatchFailedPayload;
}

/**
 * Worker → main: DispatchCleared mint request, symmetric with
 * {@link DispatchFailedMessage}. Main is the sole writer of the synthetic event;
 * the worker only describes the `(verb, id)` to clear. Drives the SAME
 * `mintDispatchClearedEvent` path as the `retry_dispatch` RPC.
 */
export interface DispatchClearedMessage {
  kind: "dispatch-cleared";
  payload: DispatchClearedPayload;
}

/**
 * Worker → main: mint or clear the synthetic PER-REPO shared-checkout-wedge
 * distress row. Main is the sole writer; the worker (the grace tracker) describes
 * the `(id, dir)` and, on a mint, the producer-stamped `reason` + `ts`. Rides its
 * own message (not `dispatch-failed`) because the distress `verb` is the synthetic
 * `daemon`, outside the strict `DispatchFailedPayload` union — the same reason the
 * crash-loop distress mints through a main-side thin closure.
 */
export type SharedWedgeDistressMessage =
  | {
      kind: "shared-wedge-distress";
      action: "mint";
      id: string;
      dir: string;
      reason: string;
      ts: number;
    }
  | {
      kind: "shared-wedge-distress";
      action: "clear";
      id: string;
      dir: string;
      expected_attempt_id: null;
      expected_instance_event_id: number | null;
    };

/**
 * Worker → main: Dispatched mint request (id-correlated + durable-acked). Main
 * is the sole writer; the worker describes what to mint. Outbox-ordered intent —
 * posted BEFORE `launch()` so a crash between mint and the tab spawn leaves a
 * phantom `pending_dispatches` row the TTL sweep discharges. The worker AWAITS
 * the durable ack before launching; `id` is a per-request correlation token main
 * echoes on the {@link DispatchedAckMessage} reply.
 */
export interface DispatchedMessage {
  kind: "dispatched-request";
  id: number;
  payload: DispatchedPayload;
}

/**
 * Main → worker: durable-ack reply paired with {@link DispatchedMessage}. Sent
 * ONLY after main has resolved the `Dispatched` mint. `ok` is `true` on a
 * successful insert; `confirmRunning` launches only on `ok:true`.
 *
 * `suppressed` distinguishes the durable-gate SUPPRESSED outcome (`ok:false,
 * suppressed:true`) — a re-mint of the same `verb::id` inside the mint-gate window,
 * which inserts NO event row — from an insert FAILURE (`ok:false` with `suppressed`
 * absent/`false`). Both abort the launch, but the consumer treats them differently:
 * a suppressed mint is a benign dedup (do NOT clear the redispatch cooldown), an
 * insert failure is a real error. Absent ⇒ not suppressed.
 */
export interface DispatchedAckMessage {
  type: "dispatched-ack";
  id: number;
  ok: boolean;
  suppressed?: boolean;
  attemptId?: number;
}

/**
 * Worker → main: DispatchExpired mint request. Reserved for future worker-side
 * use — today the producer-side TTL sweep in `daemon.ts` mints directly on the
 * writable connection. Kept for parity with the other mint messages.
 */
export interface DispatchExpiredMessage {
  kind: "dispatch-expired";
  payload: DispatchExpiredPayload;
}

/**
 * Worker → main: WorktreeRepoStatus mint request (fn-1013). Main is the sole
 * writer of the synthetic event; the worker describes the FULL current disabled
 * set (one entry per epic whose repo the eligibility heuristic downgraded to
 * `disabled` → serial shared-checkout dispatch). Posted only when the set CHANGES
 * (the worker dedupes by a stable serialization), mirroring `git_status`'s
 * semantic-dedupe emit so a stable board never floods the event log.
 */
export interface WorktreeRepoStatusMessage {
  kind: "worktree-repo-status";
  entries: WorktreeRepoStatusEntry[];
}

/**
 * Worker → main: LaneMerged mint request (fn-1016). Main is the sole writer of the
 * synthetic event; the worker describes the FULL current merged-lane set (one entry
 * per `ok` epic whose lane is merged into LOCAL default). Posted only when the set
 * CHANGES (the worker dedupes by a stable serialization), mirroring
 * {@link WorktreeRepoStatusMessage} so a stable board never floods the event log.
 */
export interface LaneMergedMessage {
  kind: "lane-merged";
  entries: readonly LaneMergedEntry[];
}

/**
 * Worker → main: run an immediate git vanished-worktree sweep. Posted after a lane
 * teardown's removals COMPLETE (finalize / recover pass-3); main relays it to the
 * git-worker (mirroring the plan-worker nudge-discovery relay) so the sweep retires
 * a torn-down lane's `git_status` row promptly instead of at the next full sweep.
 * Payload-free — the sweep keys on the canonical git_status rows, not a path.
 */
export interface VanishedSweepNudgeMessage {
  kind: "nudge-vanished-sweep";
}

/** Main→worker notice that an operator `retry_dispatch` cleared
 * `${verb}::${id}` — the worker drops the key's in-memory redispatch cooldown
 * (and, for `close`, the epic's finalizer guard) so a deliberate operator
 * re-arm re-mints on the next cycle instead of waiting out the anti-churn
 * window. The cooldown exists to suppress automatic hot loops; an explicit
 * human clear is the opposite signal. */
interface RetryArmedMessage {
  type: "retry-armed";
  verb: string;
  id: string;
}

type IncomingMessage =
  | SetPausedMessage
  | ShutdownMessage
  | DispatchedAckMessage
  | RetryArmedMessage;
// `DispatchFailedMessage` / `DispatchedMessage` / `DispatchExpiredMessage` are
// the outgoing wire shapes main consumes; `DispatchedAckMessage` is the reply
// the worker keys against its pending-ack map.

/**
 * The two durable base-drift thresholds resolved off the `autopilot_state`
 * singleton row — `null` on an axis means that axis is OFF (not configured).
 */
export interface DriftThresholds {
  /** The lane-base behind-count threshold vs the local default, or `null`
   *  when this axis is OFF. */
  behindThreshold: number | null;
  /** The merge-base age threshold in days, or `null` when this axis is OFF. */
  ageThresholdDays: number | null;
}

/**
 * Resolve the durable base-drift thresholds off the `autopilot_state`
 * singleton row — the producer-side counterpart of the `worktreeMode`/
 * `worktreeMultiRepo` `?? OFF` resolution pattern in {@link loadReconcileSnapshot}.
 * An absent/never-set row, NULL, or a non-positive/non-integer value on either
 * column resolves that axis to `null` (OFF), mirroring the
 * `set_autopilot_config` sentinel/0-disables discipline
 * (`extractAutopilotConfigSetPayload` in `reducer.ts`). Both axes `null` is the
 * base-freshness gate's byte-identical no-detection default: `.2`'s drift probe
 * and `.4`'s refresh pass both stay inert until a positive threshold is set.
 * Pure — exported so a future drift-probe pass can resolve the same row this
 * function reads without re-deriving the coercion rule.
 */
export function resolveDriftThresholds(
  autopilotRow: Record<string, unknown> | undefined,
): DriftThresholds {
  const behindRaw = (
    autopilotRow as { drift_behind_threshold?: unknown } | undefined
  )?.drift_behind_threshold;
  const behindThreshold =
    typeof behindRaw === "number" &&
    Number.isInteger(behindRaw) &&
    behindRaw > 0
      ? behindRaw
      : null;
  const ageRaw = (
    autopilotRow as { drift_age_threshold_days?: unknown } | undefined
  )?.drift_age_threshold_days;
  const ageThresholdDays =
    typeof ageRaw === "number" && Number.isInteger(ageRaw) && ageRaw > 0
      ? ageRaw
      : null;
  return { behindThreshold, ageThresholdDays };
}

/**
 * Resolve each plan job's exact terminal resource incarnation from one complete
 * tmux sweep. An absent pane clears only when the sweep contains the same
 * canonical server generation; malformed, empty, or conflicting observations
 * stay unknown/conflict and therefore fail closed at teardown.
 */
export function deriveResourceHoldObservations(
  jobs: ReadonlyMap<string, Job>,
  panes: readonly PaneInfo[] | null,
): Map<string, ResourceHoldObservation> {
  const out = new Map<string, ResourceHoldObservation>();
  if (panes == null || panes.length === 0) {
    for (const job of jobs.values()) {
      if (job.plan_verb === "work" || job.plan_verb === "close") {
        out.set(job.job_id, {
          status: "unknown",
          reason: "resource-probe-unavailable",
        });
      }
    }
    return out;
  }
  const byPane = new Map(panes.map((pane) => [pane.paneId, pane]));
  for (const job of jobs.values()) {
    if (job.plan_verb !== "work" && job.plan_verb !== "close") continue;
    if (job.state === "ended" || job.state === "killed") {
      out.set(job.job_id, { status: "clear" });
      continue;
    }
    const paneId = job.backend_exec_pane_id;
    const generationId = job.backend_exec_generation_id;
    if (paneId == null || paneId === "" || generationId == null) {
      out.set(job.job_id, {
        status: "unknown",
        reason: "resource-identity-incomplete",
      });
      continue;
    }
    const pane = byPane.get(paneId);
    if (pane !== undefined) {
      const generation = compareCanonicalGeneration(
        generationId,
        pane.tmuxGenerationId,
      );
      out.set(
        job.job_id,
        generation === "match"
          ? { status: "held", paneId, generationId }
          : {
              status: generation === "mismatch" ? "conflict" : "unknown",
              reason: `resource-generation-${generation}`,
            },
      );
      continue;
    }
    const sameGenerationObserved = panes.some(
      (candidate) =>
        compareCanonicalGeneration(generationId, candidate.tmuxGenerationId) ===
        "match",
    );
    out.set(
      job.job_id,
      sameGenerationObserved
        ? { status: "clear" }
        : { status: "unknown", reason: "resource-generation-unobserved" },
    );
  }
  return out;
}

/** The EXACT plan close-finalize outcome vocabulary — the five `CloseOutcome` members
 *  (`plugins/plan/src/verbs/close_finalize.ts::CLOSE_OUTCOMES`). Mirrored here as a local
 *  const because `src/` must not import the plan plugin; a parity test pins it. ONLY these
 *  values are a VALID receipt: an unknown / future / typo outcome is UNKNOWN (the durable scan
 *  passes it, holds if nothing valid is found), never an automatic resolution of a prior
 *  fatal. */
export const KNOWN_CLOSE_OUTCOMES: ReadonlySet<string> = new Set([
  "closed_clean",
  "closed_with_followup",
  "fatal_halt",
  "partial_followup",
  "followup_blocks_close",
]);

/** Parse one durable close-finalize tool receipt without trusting its shape. Returns a
 *  receipt ONLY for an outcome in the exact {@link KNOWN_CLOSE_OUTCOMES} vocabulary — an
 *  unknown/typo outcome yields null (UNKNOWN → the durable scan advances past it). The
 *  `eventId` (the receipt's own `events.id`) is the monotone watermark the fatal-audit
 *  staleness grade compares against the epic's newest commit-trailer fact; a `fatal_halt`
 *  receipt additionally yields its BOUNDED `fatal_reason` excerpt + `commit_set_hash`. */
export function extractCloseFinalizeReceipt(
  data: string | null,
  ts: number,
  eventId?: number,
): CloseReceipt | null {
  if (data == null || data.length === 0 || !Number.isFinite(ts)) return null;
  try {
    const outer = JSON.parse(data) as unknown;
    if (outer == null || typeof outer !== "object") return null;
    const record = outer as Record<string, unknown>;
    let receipt: unknown = record;
    const toolResponse = record.tool_response;
    if (toolResponse != null && typeof toolResponse === "object") {
      const stdout = (toolResponse as Record<string, unknown>).stdout;
      if (typeof stdout !== "string" || stdout.length === 0) return null;
      receipt = JSON.parse(stdout);
    }
    if (receipt == null || typeof receipt !== "object") return null;
    const body = receipt as Record<string, unknown>;
    const outcome = body.outcome;
    // VALID only for the exact plan vocabulary — an unknown/future/typo outcome is UNKNOWN,
    // never accepted as a nonfatal result that would erase a prior fatal.
    if (typeof outcome !== "string" || !KNOWN_CLOSE_OUTCOMES.has(outcome)) {
      return null;
    }
    const out: CloseReceipt = { outcome, ts };
    if (typeof eventId === "number" && Number.isSafeInteger(eventId)) {
      out.eventId = eventId;
    }
    if (outcome === "fatal_halt") {
      out.fatalReason = boundFatalAuditExcerpt(
        typeof body.fatal_reason === "string" ? body.fatal_reason : null,
      );
      out.commitSetHash =
        typeof body.commit_set_hash === "string" ? body.commit_set_hash : null;
    }
    return out;
  } catch {
    return null;
  }
}

/** A fatal-audit fence read plus its grades. `trusted` is false ONLY when a query THREW / could
 *  not be PREPARED (a transient read error) — the caller arms a bounded degraded wake.
 *  `unknownEpicIds` is the EXHAUSTED grade: an epic that HAS close-finalize events but yielded NO
 *  valid receipt (all unreadable / non-vocabulary, or the scan cap truncated), distinguished
 *  from a CLEAN ABSENCE (no close-finalize events at all). An unknown epic is fenced
 *  conservatively (a corrupt fatal history must never fail-open into a relaunch). */
export interface CloseReceiptRead {
  receipts: Map<string, CloseReceipt>;
  trusted: boolean;
  unknownEpicIds: Set<string>;
}

/** Chunk size for the durable receipt scan (most epics resolve on the first row) + a large
 *  pathological-safety cap. The scan runs to HISTORY END for any realistic epic (a handful of
 *  close attempts), so the LOCKED cold case — a fatal beyond hundreds of unreadable newer
 *  events — is FOUND, not lost; only a genuinely unbounded corrupt history hits the cap, which
 *  resolves to UNKNOWN (conservative HOLD), NEVER clean absence. */
const DURABLE_RECEIPT_SCAN_CHUNK = 16;
const DURABLE_RECEIPT_SCAN_CAP = 4096;

/**
 * Join each close target to its most-recent VALID close-finalize receipt — DURABLE. The scan
 * advances DESC past ANY event that does NOT yield a valid parsed receipt (a KNOWN-vocabulary
 * `outcome`): a relocated/null blob, a JSON parse error, a missing/empty `stdout`, a
 * `{success:false}` failed attempt, a missing outcome, or an unknown/typo outcome are ALL
 * UNKNOWN and NEVER erase a prior standing fatal. It stops ONLY on a valid receipt — a
 * `fatal_halt` fences the epic, a real non-fatal outcome supersedes. Runs to HISTORY END (a
 * hard cap only bounds a pathologically corrupt history). An epic with events but NO valid
 * receipt (exhausted / cap-truncated) is graded UNKNOWN (`unknownEpicIds`) for a conservative
 * HOLD — never clean absence. A THROW (query or PREPARE) marks the read UNTRUSTED.
 */
export function loadLatestCloseReceipts(
  db: Parameters<typeof runQuery>[0],
  jobs: ReadonlyMap<string, Job>,
  additionalEpicIds?: Iterable<string>,
): CloseReceiptRead {
  const epicIds = new Set<string>();
  for (const job of jobs.values()) {
    if (
      job.plan_verb === "close" &&
      job.plan_ref != null &&
      job.plan_ref !== "" &&
      (job.state === "working" || job.state === "stopped")
    ) {
      epicIds.add(job.plan_ref);
    }
  }
  // The fatal-audit fence must engage even after the halting closer stopped and was
  // slot-reaped (no live close job), so the caller widens the scan to every OPEN epic.
  if (additionalEpicIds !== undefined) {
    for (const epicId of additionalEpicIds) {
      if (epicId != null && epicId !== "") epicIds.add(epicId);
    }
  }
  const receipts = new Map<string, CloseReceipt>();
  const unknownEpicIds = new Set<string>();
  // RIDER: the PREPARE rides the trust catch too — a construction throw must return
  // UNTRUSTED (arming the degraded wake), never escape the reconciler.
  let stmt: ReturnType<typeof db.query>;
  try {
    stmt = db.query(
      `SELECT id, ts, data
         FROM events
        WHERE plan_target = ? AND plan_op = 'close-finalize'
        ORDER BY id DESC LIMIT ? OFFSET ?`,
    );
  } catch {
    return { receipts, trusted: false, unknownEpicIds };
  }
  let trusted = true;
  for (const epicId of [...epicIds].sort()) {
    try {
      let offset = 0;
      let found = false;
      let sawEvent = false;
      while (offset < DURABLE_RECEIPT_SCAN_CAP && !found) {
        const rows = stmt.all(epicId, DURABLE_RECEIPT_SCAN_CHUNK, offset) as {
          id: number;
          ts: number;
          data: string | null;
        }[];
        if (rows.length === 0) break; // history end (no more events)
        for (const row of rows) {
          sawEvent = true;
          const receipt = extractCloseFinalizeReceipt(row.data, row.ts, row.id);
          if (receipt != null) {
            receipts.set(epicId, receipt); // first VALID receipt → definitive, stop
            found = true;
            break;
          }
          // else advance PAST this invalid event (unparseable / no or unknown outcome / failed)
        }
        if (found || rows.length < DURABLE_RECEIPT_SCAN_CHUNK) break; // history end
        offset += DURABLE_RECEIPT_SCAN_CHUNK;
      }
      // Events existed but NONE yielded a valid receipt (all unreadable, or the cap truncated a
      // pathological history) → EXHAUSTED/UNKNOWN, NOT clean absence → conservative HOLD.
      if (!found && sawEvent) unknownEpicIds.add(epicId);
    } catch {
      // A transient read error is UNTRUSTED (not a known-absence) → arm a retry.
      trusted = false;
    }
  }
  return { receipts, trusted, unknownEpicIds };
}

/**
 * The per-epic max `commit_trailer_facts.event_id` for a TASK-DONE plan fact
 * (`plan_op = 'done'`) — the newest "a task under this epic was marked done" event, the
 * monotone watermark {@link fatalHaltReceiptIsCurrent} compares against a fatal-audit
 * receipt's own event id: a task-done LANDING AFTER the receipt is a follow-up acting on
 * the epic (the positive, NARROWED drift trigger). Deliberately NOT the full
 * `commit_trailer_facts` watermark — that channel churns on any plan-metadata commit
 * (validate/title/scaffold) and MISSES a bare `Task:`-trailer source commit, so it is
 * neither a superset nor an equivalent of the `commit_set_hash`. ONE bounded aggregate per
 * epic; a null aggregate is a clean known-no-done (`trusted`), a QUERY THROW is UNTRUSTED
 * (arms a retry). Producer-side read, NEVER a fold.
 */
export interface TaskDoneWatermarkRead {
  watermarks: Map<string, number>;
  trusted: boolean;
}

export function loadEpicTaskDoneWatermarks(
  db: Parameters<typeof runQuery>[0],
  epicIds: Iterable<string>,
): TaskDoneWatermarkRead {
  const watermarks = new Map<string, number>();
  let trusted = true;
  for (const epicId of epicIds) {
    if (epicId == null || epicId === "") continue;
    try {
      const row = db
        .query(
          "SELECT MAX(event_id) AS m FROM commit_trailer_facts WHERE plan_epic_id = ? AND plan_op = 'done'",
        )
        .get(epicId) as { m: number | null } | null;
      if (row != null && typeof row.m === "number" && Number.isFinite(row.m)) {
        watermarks.set(epicId, row.m);
      }
    } catch {
      // A transient read error is UNTRUSTED (not a known-no-done) → arm a retry.
      trusted = false;
    }
  }
  return { watermarks, trusted };
}

/**
 * Step the fatal-audit lift STATE MACHINE forward one cycle, keyed to the SYNTHETIC ROW
 * INSTANCE (not receipt parseability), and return `{ lifted, toForget }`:
 *   - `lifted` — epics whose lift token is ARMED (the close withhold releases for one re-run).
 *   - `toForget` — epics that armed THIS cycle (the observed open→gone transition); the
 *     producer resets the change-gate for exactly these, ONCE, so a same-finding fresh re-halt
 *     is not watermark-suppressed.
 * Transitions per epic over `openInstanceByEpic` (epic → its OPEN synthetic row instance):
 *   - Row OPEN with a NEW instance → observe it (`lift:"none"`), ending any prior lift episode
 *     (a fresh mint / re-mint re-establishes the hold); SAME instance still open keeps state.
 *   - Row GONE while last observed OPEN and `lift:"none"` → ARM one token + `toForget` (an
 *     operator `retry_dispatch` cleared it — observable even under a malformed latest receipt).
 *   - Row GONE, `lift:"armed"` → stay armed (a cap/occupancy withhold consumed no launch yet).
 *   - Row GONE, `lift:"consumed"` → NOT lifted (the one launch was used; awaits re-hold).
 * The consume ({@link consumeFatalAuditLift}) and resolution GC run in the producer glue.
 * Pure over its inputs + the mutated memo; NEVER throws.
 */
export function stepFatalAuditFenceMemo(
  openInstanceByEpic: ReadonlyMap<string, number>,
  memo: Map<string, FatalAuditFenceMemoEntry>,
): { lifted: Set<string>; toForget: Set<string> } {
  const lifted = new Set<string>();
  const toForget = new Set<string>();
  const epics = new Set<string>([...memo.keys(), ...openInstanceByEpic.keys()]);
  for (const epicId of epics) {
    const openInstance = openInstanceByEpic.get(epicId);
    const entry = memo.get(epicId);
    if (openInstance !== undefined) {
      if (entry === undefined || entry.observedInstance !== openInstance) {
        memo.set(epicId, { observedInstance: openInstance, lift: "none" });
      }
      continue;
    }
    if (entry === undefined || entry.observedInstance === null) {
      continue; // never observed a row → mint→fold lag / already GC'd, not a lift
    }
    if (entry.lift === "none") {
      entry.lift = "armed";
      lifted.add(epicId);
      toForget.add(epicId);
    } else if (entry.lift === "armed") {
      lifted.add(epicId);
    }
  }
  return { lifted, toForget };
}

/**
 * CONSUME the one-shot lift token for each epic whose close was actually LAUNCHED this cycle:
 * `armed → consumed`. A launch is the only consume trigger — a cap/occupancy/in-flight
 * withhold before launch leaves the token armed, so the operator's single retry is honored
 * exactly once. Producer glue; mutates the memo. NEVER throws.
 */
export function consumeFatalAuditLift(
  memo: Map<string, FatalAuditFenceMemoEntry>,
  launchedCloseEpicIds: Iterable<string>,
): void {
  for (const epicId of launchedCloseEpicIds) {
    const entry = memo.get(epicId);
    if (entry !== undefined && entry.lift === "armed") {
      entry.lift = "consumed";
    }
  }
}

/**
 * Load a fresh {@link ReconcileSnapshot} from the worker's read-only connection.
 * Every collection is read through the SAME `runQuery` the server-worker answers
 * client subscriptions with, so the reconciler's view matches the board's
 * byte-for-byte. Each read carries NO wire filter, so each descriptor's DEFAULT
 * scope applies (epics: open; jobs: live-only) — the live work set the
 * reconciler acts on.
 *
 * ONE deliberate exception: the `epics_recent_done` collection — a SECOND read
 * scoped to `status='done'` and TIME-bounded to `updated_at >= now -
 * DONE_EPICS_REAP_WINDOW_SEC` (its descriptor's `recencyBound`) — is MERGED in
 * (dedup by `epic_id`, open rows win) so a done epic stays visible long enough
 * for the close-row COMPLETION reap to observe its `{tag:"completed"}` verdict.
 * The bound is a DURATION (it tracks the close-row wind-down), not a count. Done
 * rows produce ONLY completed verdicts, so no dispatch arm or mutex occupancy is
 * perturbed.
 *
 * Mirrors the readiness client's assembly: sub-agents collapsed same-name →
 * most-recent (orphaned `running` rows must not false-block predicate 6); git
 * rows projected through {@link projectGitStatusByProjectDir}; `failedKeys` the
 * open `dispatch_failures` set (sticky until a `retry_dispatch` clears it).
 */
export type FencedReconcileSnapshot = ReconcileSnapshot &
  ZombieReaperSnapshot & {
    dispatchFailureFences: Map<DispatchKey, DispatchFailureFence>;
  };

export async function loadReconcileSnapshot(
  db: Parameters<typeof runQuery>[0],
  // Read-time tmux liveness probe (the pane-ops `listPanes` seam) — assembles
  // the `livePaneIds` set that gates {@link isOccupyingJob}'s stopped arm. Threaded
  // in (not imported) so this stays a pure read over `db` + the probe and tests
  // inject a fake. ABSENT or a `null`/throwing probe yields `livePaneIds = null`
  // (the conservative fallback: every stopped row occupies). NEVER read in a
  // fold — liveness lives only on this read-time path.
  listPanes?: () => Promise<PaneInfo[] | null>,
  // Producer-side process-liveness probe (`process.kill(pid, 0)` — a cheap
  // syscall, NEVER a per-job spawn) mirroring the exit-watcher's own pid-death
  // reprobe. Re-proves a stopped-but-live-pane occupant's recorded claude pid so
  // the slot reaper can reclaim a session the daemon has PROVEN dead even when its
  // pane shows a lingering wrapper/launcher command. Injectable so tests drive the
  // dead/live matrix without a real process; defaults to {@link isPidAlive}.
  pidAlive: (pid: number) => boolean = isPidAlive,
  readinessQuery: ReadinessQuery = runQuery,
  nowSec: number = Math.floor(Date.now() / 1000),
  // The CONSUMED fatal-audit memo episodes (epic ids) — threaded from producer state so their
  // resolution is graded even WITHOUT an open synthetic row: after a retry-clear + launch, a
  // valid nonfatal receipt / task-done drift can land BEFORE the ordinary fatal row re-mints,
  // so `fatalAuditResolvedEpicIds` must cover them or the memo never releases and the fence
  // holds forever. Empty/absent in tests that don't exercise the consumed lifecycle.
  reholdEpicIds?: Iterable<string>,
): Promise<FencedReconcileSnapshot> {
  const read = (collection: string): Record<string, unknown>[] => {
    const frame = {
      type: "query" as const,
      collection,
      id: `autopilot-${collection}`,
      limit: 0,
    };
    const res = runQuery(db, 0, frame);
    return res.type === "result" ? (res.rows as Record<string, unknown>[]) : [];
  };

  // The DB-sourced readiness inputs (`epics` — open MERGED with the recently-DONE
  // window, deduped + scheduling-ordered — `jobs`, `subagentInvocations`,
  // `gitStatusByProjectDir`, `pendingDispatches`, `unseededRoots`, and the per-root
  // cap) are loaded through the shared `loadReadinessInputs` module so the
  // reconciler and the autoclose worker can NEVER diverge on what "done" means.
  // MOVED (not copied) — the epics merge/dedup, the pending-dispatch builder, and
  // the git-seed gate all live in that ONE place now.
  const {
    readinessDegraded: readinessDegradedBase,
    epics,
    jobs,
    subagentInvocations,
    gitStatusByProjectDir,
    pendingDispatches,
    providerLegActivityByWrapperJobId,
    dispatchClaims,
    harnessActivityByJobId,
    unseededRoots,
    maxConcurrentPerRoot,
  } = loadReadinessInputs(db, readinessQuery, nowSec);
  // Widen the receipt scan to every OPEN epic (not just live-close-job epics) PLUS the
  // consumed-memo rehold episodes (so their reclassification is graded without an open row):
  // the fatal-audit fence must engage after the halting closer stopped / was slot-reaped.
  const openEpicIds = epics
    .filter((e) => e.status !== "done")
    .map((e) => e.epic_id);
  const reholdEpicIdSet = new Set<string>(reholdEpicIds ?? []);
  const closeReceiptRead = loadLatestCloseReceipts(db, jobs, [
    ...openEpicIds,
    ...reholdEpicIdSet,
  ]);
  const latestCloseReceiptByEpicId = closeReceiptRead.receipts;

  // The shared jobs descriptor intentionally omits the live-only generation
  // column; exact Resource holds require it, so enrich the producer snapshot
  // directly without changing the public collection shape.
  try {
    const generations = db
      .query(
        "SELECT job_id, backend_exec_generation_id FROM jobs WHERE plan_verb IN ('work', 'close')",
      )
      .all() as {
      job_id: string;
      backend_exec_generation_id: string | null;
    }[];
    for (const row of generations) {
      const job = jobs.get(row.job_id);
      if (job !== undefined) {
        job.backend_exec_generation_id = row.backend_exec_generation_id;
      }
    }
  } catch {
    // Missing/inconclusive enrichment leaves identities incomplete; teardown
    // fails closed through deriveResourceHoldObservations.
  }

  const failedKeys = new Set<DispatchKey>();
  const incidentOwnerKeys = new Set<DispatchKey>();
  const claimedIncidentKeys = new Set<DispatchKey>();
  const incidentClaimByKey = new Map<DispatchKey, string>();
  let incidentClaimsReadable = true;
  try {
    const claims = db
      .query(
        `SELECT verb, id, claim_session_id FROM dispatch_failures
          WHERE verb IN ('work', 'close') AND claim_session_id IS NOT NULL`,
      )
      .all() as {
      verb: "work" | "close";
      id: string;
      claim_session_id: string;
    }[];
    for (const claim of claims) {
      incidentClaimByKey.set(
        dispatchKey(claim.verb, claim.id),
        claim.claim_session_id,
      );
    }
  } catch {
    incidentClaimsReadable = false;
  }
  const dispatchFailureFences = new Map<DispatchKey, DispatchFailureFence>();
  const recoverFailureIds = new Set<string>();
  const openRecoverRows: NonNullable<ReconcileSnapshot["openRecoverRows"]> = [];
  const finalizeFailureIds = new Set<string>();
  const preCloseFenceFailureIds = new Set<string>();
  // The epic ids with an OPEN `fatal-audit` `close::fatal-audit:<epic>` row — the
  // mint-idempotency + positive-drift-clear set. Paired with the per-epic OPEN-row
  // `instance_event_id` the lift state machine observes (an operator retry clearing this
  // exact instance is the observable open→gone transition, even under a malformed receipt).
  const openFatalAuditIds = new Set<string>();
  const openFatalAuditInstanceByEpic = new Map<string, number>();
  const slotOccupancyFailures: { verb: Verb; id: string }[] = [];
  // The `repoDir`s with an OPEN shared-checkout-wedge distress row — the level-clear
  // set the recover pass's grace tracker clears against (a row whose checkout is
  // clean this cycle). Off the row's `dir` so a restarted worker still clears a
  // distress it minted before the restart.
  const sharedWedgeDistressDirs = new Set<string>();
  // The SIBLING set for the plain-dirty distress rows — kept DISJOINT from the wedge
  // set (each keys on its own `daemon` id prefix) so a mid-merge wedge clear and a
  // dirt clear never target each other's row.
  const sharedDirtyDistressDirs = new Set<string>();
  // The `repoDir`s with an OPEN per-repo shared-checkout-DESYNC distress row — a LIVE
  // producer sibling (never drained like the wedge/dirty sets), on its own
  // `shared-checkout-desync:` id prefix. Re-seeds the per-cycle content probe's watched
  // set + the desync grace tracker's clear set, so a restarted worker still probes +
  // clears a distress it minted before the restart.
  const sharedDesyncDistressDirs = new Set<string>();
  // The `repoDir`s with an OPEN per-repo origin-containment-stuck distress row — a LIVE
  // producer sibling on its own `origin-containment-stuck:` id prefix. Re-seeds the
  // containment tracker's clear set so a restarted worker still clears (on positive
  // containment) a distress it minted before the restart.
  const originContainmentDistressDirs = new Set<string>();
  // OPEN per-occupant monitor-slot paging rows. Keyed by id so the producer can
  // suppress re-mint/page and level-clear the exact durable row after positive
  // settle/exit/fact-clear evidence.
  const openMonitorSlotWedges = new Map<string, OpenMonitorSlotWedge>();
  const openZombieSessionDistresses = new Map<
    string,
    OpenZombieSessionDistress
  >();
  // The `(verb, id, dir)` of every OPEN fan-in LANE pre-merge row (reason carries
  // WORKTREE_LANE_PREMERGE_REASON_PREFIX), collected VERB-AGNOSTICALLY off the REASON
  // so the recover pass's level-clear reaches a `work::<taskId>` row the typed router
  // would short-circuit to `work-task` — cleared by lane path, never the dead arm.
  const laneFailures: { verb: Verb; id: string; dir: string }[] = [];
  // Every OPEN merge-escalation row — a bare `close::<epic>` conflict or a
  // `work::<taskId>` fan-in `worktree-merge-conflict` (pre-minted `pending owner
  // integration` included). `reason` + `dir` ride along so the reconcile loop can probe
  // each `work::` row's own incident (source rib merged into its target base + clean
  // target checkout); the level-clear then drops it on that evidence, epic-landed as a
  // straggler fallback.
  const mergeEscalationFailures: {
    verb: Verb;
    id: string;
    reason: string;
    dir: string | null;
  }[] = [];
  // The lane PATHS with an OPEN per-lane wedge distress row — the level-clear set the
  // recover pass's lane grace tracker clears against (a lane ready/gone this cycle).
  const laneWedgeDistressDirs = new Set<string>();
  const laneTeardownDistressDirs = new Set<string>();
  const laneBackupDistressDirs = new Set<string>();
  // The distress IDS with an OPEN per-(epic,repo) stale-base-lane distress row — the
  // level-clear set the stale-base grace tracker clears against (a lane re-based past
  // its upstream or torn down this cycle). Collected off the row's ID (the
  // per-(epic,repo) hash is one-way), so a restarted worker still clears a stale-base
  // distress it minted before the restart.
  const staleBaseDistressIds = new Set<string>();
  // The distress IDS with an OPEN per-(project,number) duplicate-epic-number distress row —
  // the level-clear set the duplicate-number grace tracker clears against (a duplicate that
  // no longer holds this cycle). Collected off the row's ID (the per-(project,number) hash
  // is one-way), so a restarted worker still clears a distress it minted before the restart.
  const dupEpicNumberDistressIds = new Set<string>();
  for (const row of read("dispatch_failures")) {
    const verb = (row as { verb?: unknown }).verb;
    const id = (row as { id?: unknown }).id;
    if (typeof verb === "string" && typeof id === "string") {
      const key = dispatchKey(verb as Verb, id);
      failedKeys.add(key);
      const rawAttempt = (row as { attempt_id?: unknown }).attempt_id;
      const rawInstance = (row as { instance_event_id?: unknown })
        .instance_event_id;
      dispatchFailureFences.set(key, {
        attempt_id:
          typeof rawAttempt === "number" && Number.isSafeInteger(rawAttempt)
            ? rawAttempt
            : null,
        instance_event_id:
          typeof rawInstance === "number" && Number.isSafeInteger(rawInstance)
            ? rawInstance
            : null,
      });
      const reason = (row as { reason?: unknown }).reason;
      const reasonStr = typeof reason === "string" ? reason : "";
      if (isSharedWedgeDistressKey(verb, id)) {
        const dir = (row as { dir?: unknown }).dir;
        if (typeof dir === "string" && dir.length > 0) {
          sharedWedgeDistressDirs.add(dir);
        }
      }
      if (isSharedDirtyDistressKey(verb, id)) {
        const dir = (row as { dir?: unknown }).dir;
        if (typeof dir === "string" && dir.length > 0) {
          sharedDirtyDistressDirs.add(dir);
        }
      }
      if (isSharedDesyncDistressKey(verb, id)) {
        // Off the row's `dir` (the probe + clear compare dirs); disjoint from the
        // wedge/dirty sets above by the `shared-checkout-desync:` id prefix.
        const dir = (row as { dir?: unknown }).dir;
        if (typeof dir === "string" && dir.length > 0) {
          sharedDesyncDistressDirs.add(dir);
        }
      }
      if (isOriginContainmentDistressKey(verb, id)) {
        // Off the row's `dir`; disjoint from every sibling set by the
        // `origin-containment-stuck:` id prefix.
        const dir = (row as { dir?: unknown }).dir;
        if (typeof dir === "string" && dir.length > 0) {
          originContainmentDistressDirs.add(dir);
        }
      }
      if (isMonitorSlotWedgeDistressKey(verb, id)) {
        const jobId = monitorSlotWedgeJobId(id);
        const dir = (row as { dir?: unknown }).dir;
        if (jobId != null && jobId !== "") {
          openMonitorSlotWedges.set(id, {
            id,
            jobId,
            dir: typeof dir === "string" ? dir : "",
          });
        }
      }
      if (isZombieSessionDistressKey(verb, id)) {
        const jobId = zombieSessionJobId(id);
        const dir = (row as { dir?: unknown }).dir;
        if (jobId != null && jobId !== "") {
          openZombieSessionDistresses.set(id, {
            id,
            jobId,
            dir: typeof dir === "string" ? dir : "",
            scope: reasonStr.includes("stopped occupancy-holding session")
              ? "occupancy"
              : "monitor",
          });
        }
      }
      if (isLaneWedgeDistressKey(verb, id)) {
        const dir = (row as { dir?: unknown }).dir;
        if (typeof dir === "string" && dir.length > 0) {
          laneWedgeDistressDirs.add(dir);
        }
      }
      if (isLaneTeardownDistressKey(verb, id)) {
        const dir = (row as { dir?: unknown }).dir;
        if (typeof dir === "string" && dir.length > 0) {
          if (id.startsWith(LANE_BACKUP_DISTRESS_ID_PREFIX)) {
            laneBackupDistressDirs.add(dir);
          } else {
            laneTeardownDistressDirs.add(dir);
          }
        }
      }
      if (isStaleBaseDistressKey(verb, id)) {
        // Collected off the ID (the level-clear compares ids, not a recomputed hash);
        // disjoint from every dir-keyed distress set above by the `stale-base-lane:`
        // id prefix, so the four distress surfaces never cross-classify.
        staleBaseDistressIds.add(id);
      }
      if (isDupEpicNumberDistressKey(verb, id)) {
        // Collected off the ID (the level-clear compares ids); disjoint from every other
        // distress set by the `dup-epic-number:` id prefix.
        dupEpicNumberDistressIds.add(id);
      }
      // A fan-in LANE pre-merge row (its REASON, verb-agnostic — the `daemon`-verb
      // lane WEDGE distress reason is excluded by `isLaneWedgeDistressKey` above and by
      // the distinct `worktree-lane-wedge` prefix, so only a provision `work`/`close`
      // premerge row lands here). Fed into the reason-scoped level-clear by lane path.
      if (
        (verb === "work" || verb === "close") &&
        isWorktreeLanePremergeReason(reasonStr)
      ) {
        const dir = (row as { dir?: unknown }).dir;
        laneFailures.push({
          verb,
          id,
          dir: typeof dir === "string" ? dir : "",
        });
      }
      // Slot-occupancy rows (`slot-reclaimed` / `slot-occupied`, on the NATURAL key)
      // feed the slot pass's level-clear. Collected off the REASON — verb-agnostic
      // (a `work` OR `close` slot row) — because the typed router short-circuits a
      // `work` row to `work-task`; the reason scope is the clobber guard that keeps a
      // genuine `close::<epic>` conflict sharing the key out of the clear set.
      if (
        (verb === "work" || verb === "close") &&
        isSlotOccupancyReason(reasonStr)
      ) {
        slotOccupancyFailures.push({ verb, id });
      }
      // Route each row through the typed classifier for its auto-clear scope. A
      // `worktree-recover` row (reason marker — a non-recover close sharing the key
      // is excluded, the clobber guard) is eligible for the recover glue's clear; a
      // `worktree-finalize` row (id prefix — the epic-keyed provision
      // `worktree-merge-conflict` kept on `close::<epic>` for the merge-escalation
      // sweep is excluded) is eligible for the finalize driver's clear. The two
      // scopes stay DISJOINT.
      const route = routeDispatchFailure({
        verb,
        id,
        reason: reasonStr,
        dir: "",
      });
      if (
        isOwnerRoutableIncident({
          verb,
          id,
          reason: reasonStr,
          dir:
            typeof (row as { dir?: unknown }).dir === "string"
              ? ((row as { dir: string }).dir ?? "")
              : "",
        })
      ) {
        const claimSessionId = incidentClaimByKey.get(key) ?? null;
        const ownerRedispatchAttempts = (
          row as { owner_redispatch_attempts?: unknown }
        ).owner_redispatch_attempts;
        const humanNotifiedAt = (row as { human_notified_at?: unknown })
          .human_notified_at;
        const facts = {
          verb,
          id,
          reason: reasonStr,
          dir:
            typeof (row as { dir?: unknown }).dir === "string"
              ? (row as { dir: string }).dir
              : null,
          claimSessionId,
          ownerRedispatchAttempts:
            typeof ownerRedispatchAttempts === "number"
              ? ownerRedispatchAttempts
              : 0,
          humanNotifiedAt:
            typeof humanNotifiedAt === "number" ? humanNotifiedAt : null,
        };
        if (!incidentClaimsReadable || facts.claimSessionId != null) {
          claimedIncidentKeys.add(key);
        }
        if (
          incidentClaimsReadable &&
          nextIncidentOwnerAttachmentMarker(facts) != null
        ) {
          incidentOwnerKeys.add(key);
        }
      }
      // An OPEN per-(epic, repo) pre-close structural fence (id-prefixed; routes
      // `close-plain`, so the typed switch never touches it) — fed to the pre-close
      // positive-evidence level-clear so a self-healed structural failure never leaves
      // a durable row jamming the close's final drain.
      if (verb === "close" && id.startsWith(WORKTREE_PRECLOSE_ID_PREFIX)) {
        preCloseFenceFailureIds.add(id);
      }
      // An OPEN fatal-audit row on the TYPED synthetic id `close::fatal-audit:<epic>` —
      // collected by ID PREFIX and mapped BACK to the epic (the mint/clear/memo all key on
      // epic). Reason-disjoint from the bare `close::<epic>` key by construction, so it
      // never aliases an ordinary close failure. Routes `close-plain` (inert).
      if (verb === "close") {
        const fatalEpic = epicIdFromFatalAuditId(id);
        if (fatalEpic !== null && fatalEpic !== "") {
          openFatalAuditIds.add(fatalEpic);
          const inst = (row as { instance_event_id?: unknown })
            .instance_event_id;
          // Positive-safe-token contract (mirrors the reducer's validInstanceToken): a
          // zero/negative/non-safe instance is never a valid lift-observation anchor.
          if (
            typeof inst === "number" &&
            Number.isSafeInteger(inst) &&
            inst > 0
          ) {
            openFatalAuditInstanceByEpic.set(fatalEpic, inst);
          }
        }
      }
      switch (route.kind) {
        case "worktree-recover": {
          recoverFailureIds.add(id);
          const dir = (row as { dir?: unknown }).dir;
          if (typeof dir === "string") {
            const open = openRecoverRowFromFailure(id, dir);
            if (open !== null) openRecoverRows.push(open);
          }
          break;
        }
        case "worktree-finalize":
          finalizeFailureIds.add(id);
          break;
        case "work-task":
          break;
        // A work-verb fan-in `worktree-merge-conflict` row and its close-path
        // `merge-escalation` sibling are NEITHER recover- nor finalize-scoped, so the
        // typed switch never touches them. Collected here (VERB-carrying) for the
        // reconcile loop's positive-evidence level-clear: each drops when its epic's
        // fan-in genuinely LANDS (merged into local default / torn down), never on
        // task/epic terminal status. A `retry_dispatch` still drops one early.
        case "work-merge-conflict":
        case "merge-escalation": {
          const dir = (row as { dir?: unknown }).dir;
          mergeEscalationFailures.push({
            verb: verb as Verb,
            id,
            reason: reasonStr,
            dir: typeof dir === "string" ? dir : null,
          });
          break;
        }
        case "close-plain":
        case "unknown":
          break;
        default:
          assertNever(route);
      }
    }
  }

  // Read `pending_dispatches` for the reconciler-only `liveTabKeys` arm (the
  // same-`(verb,id)` re-dispatch dedup — NOT a readiness input). Each row is a
  // dispatched-but-not-yet-bound worker. The cross-sibling `dispatch-pending`
  // occupant set (`pendingDispatches`, fed into `computeReadiness`) is loaded by
  // `loadReadinessInputs` above through the SAME `projectPendingDispatches`
  // builder, so the readiness paths never diverge.
  const liveTabKeys = new Set<DispatchKey>();
  for (const row of read("pending_dispatches")) {
    const verb = (row as { verb?: unknown }).verb;
    const id = (row as { id?: unknown }).id;
    if (typeof verb === "string" && typeof id === "string") {
      liveTabKeys.add(dispatchKey(verb as Verb, id));
    }
  }

  const dispatchClaimsByKey = new Map(
    dispatchClaims.map((claim) => [
      dispatchKey(claim.verb as Verb, claim.id),
      claim,
    ]),
  );

  // Read the autopilot `mode` and the armed id set — PROJECTION-PULL only (no
  // `workerData`, no cache) so the gate survives a restart with one source of
  // truth. A missing/malformed `mode` defaults to `'yolo'`.
  const autopilotRows = read("autopilot_state");
  const modeRaw = (autopilotRows[0] as { mode?: unknown } | undefined)?.mode;
  const mode: "yolo" | "armed" = modeRaw === "armed" ? "armed" : "yolo";

  // The global concurrency cap rides the SAME singleton row — resolve
  // `max_concurrent_jobs ?? DEFAULT` (the in-memory default, NOT config). An
  // absent/never-set row OR a non-positive / non-integer value → DEFAULT
  // (`null` = unlimited); only a positive integer is a real cap. Projection-pull
  // only so a runtime `set_autopilot_config` lands the very next cycle.
  const capRaw = (
    autopilotRows[0] as { max_concurrent_jobs?: unknown } | undefined
  )?.max_concurrent_jobs;
  const maxConcurrentJobs: number | null =
    typeof capRaw === "number" && Number.isInteger(capRaw) && capRaw > 0
      ? capRaw
      : DEFAULT_MAX_CONCURRENT_JOBS;

  // The per-root dispatch concurrency count N (`max_concurrent_per_root`) is
  // resolved off the SAME `autopilot_state` row by `loadReadinessInputs` above —
  // one source of truth shared with the readiness client so both consumers
  // compute identical demotions.

  // The durable worktree-mode toggle rides the SAME singleton row —
  // resolve `worktree_mode truthy` (an absent/never-set row, NULL, or 0 = OFF,
  // the no-worktree dispatch; only a stored 1 = ON). Projection-pull only so a
  // runtime `set_autopilot_config` lands the very next cycle. ON → `reconcile`
  // stamps each launch with the pure worktree geometry; OFF → no geometry (the
  // producer adds only the on-default-branch assertion).
  const worktreeRaw = (
    autopilotRows[0] as { worktree_mode?: unknown } | undefined
  )?.worktree_mode;
  const worktreeMode: boolean = worktreeRaw === 1;

  // The durable multi-repo worktree ROLLOUT flag rides the SAME singleton row —
  // resolve `worktree_multi_repo truthy` (an absent/never-set row, NULL, or 0 =
  // OFF, today's whole-epic `>1`-toplevel reject; only a stored 1 = ON). Read only
  // to feed the producer-side `classifyWorktreeRepos` partition below; the pure
  // `reconcile` layer never sees it (it reads the already-clustered resolutions).
  // Projection-pull only so a runtime `set_autopilot_config` lands the next cycle.
  const worktreeMultiRepoRaw = (
    autopilotRows[0] as { worktree_multi_repo?: unknown } | undefined
  )?.worktree_multi_repo;
  const worktreeMultiRepo: boolean = worktreeMultiRepoRaw === 1;

  // The durable work-dispatch provider pin (`worker_provider`, ADR 0047) rides the
  // SAME singleton row, TRI-STATED through the shared `classifyProviderPin` so this
  // AUTHORITY path agrees byte-for-byte with the manual dispatch + daemon block-
  // owner consumers: ONLY a successful null/absent read is unconstrained; a present-
  // but-invalid value is UNKNOWN (rides `workerProviderPinUnknown`, refusing every
  // cell-bearing launch VISIBLY — never the unpinned assigned cell). A read/query
  // THROW aborts the whole snapshot upstream, so it never reaches here. Projection-
  // pull only so a runtime `set_autopilot_config` lands the next cycle. The
  // equivalence map is loaded + reduced ONCE per cycle ONLY when a pin VALUE is
  // active — an unconstrained OR unknown cycle reads no map (zero fs). Fail-closed:
  // a stale/broken map becomes a per-cell `map-malformed` reject, never a crash.
  const pinRead = classifyProviderPin(
    (autopilotRows[0] as { worker_provider?: unknown } | undefined)
      ?.worker_provider,
  );
  const workerProvider: "claude" | "gpt" | null =
    pinRead.kind === "value" ? pinRead.provider : null;
  const workerProviderPinUnknown =
    pinRead.kind === "unknown" ? { detail: pinRead.detail } : undefined;
  const providerEquivalence =
    workerProvider !== null ? loadProviderEquivalenceSnapshot() : undefined;

  const armedIds = new Set<string>();
  for (const row of read("armed_epics")) {
    const epicId = (row as { epic_id?: unknown }).epic_id;
    if (typeof epicId === "string") {
      armedIds.add(epicId);
    }
  }

  // Liveness probe — `null` whenever the probe is absent, returns `null`
  // (degraded tmux), or throws (NEVER let a probe failure crash the cycle); the
  // null fallback keeps every stopped row occupying, so an un-probeable cycle
  // can only over-suppress, never double-dispatch.
  let livePaneIds: ReadonlySet<string> | null = null;
  let observedPanes: readonly PaneInfo[] | null = null;
  // Live pane id → foreground command, from the SAME sweep — the slot-occupancy gate
  // reads it to tell a live/parked `claude` from the dead `exec $SHELL -l -i` tail.
  // Null in lockstep with `livePaneIds` (degraded/absent probe), so the slot gate
  // stays inert on an un-probeable cycle.
  let paneCommandById: ReadonlyMap<string, string> | null = null;
  if (listPanes !== undefined) {
    try {
      const panes = await listPanes();
      if (panes !== null) {
        observedPanes = panes;
        livePaneIds = new Set(panes.map((pane) => pane.paneId));
        paneCommandById = new Map(
          panes.map((pane) => [pane.paneId, pane.currentCommand]),
        );
      }
    } catch (err) {
      console.error(
        "[autopilot-worker] listPanes probe threw (non-fatal):",
        err,
      );
    }
  }

  const resourceHoldByJobId = deriveResourceHoldObservations(
    jobs,
    observedPanes,
  );

  // Slot authority from the job LIFECYCLE, not pane cosmetics: re-prove dead the
  // recorded claude pid of every STOPPED job still holding a LIVE pane, mirroring
  // the exit-watcher's own pid-death reprobe. A dead pid is the same kernel-truth
  // verdict the exit-watcher folds `Killed` on — but claude's exit leaves the tmux
  // pane held alive by the launch wrapper's trailing shell or a lingering launcher
  // process, and the `Killed` fold NULLS the pane, so `kill_reason` alone leaves no
  // pane for the reaper to reap. Probing here catches the session while the stopped
  // row still carries its pane, so the reaper can reclaim that residual pane
  // regardless of the (wrapper) foreground command. Scoped to the narrow
  // stopped-AND-live-pane candidate set (never every job) so the syscall cost stays
  // bounded; producer-side only (NEVER a fold input — re-fold stays deterministic).
  // May be non-empty when the pane probe is degraded (`livePaneIds === null`):
  // the backstop occupant loop can still add dead-pid job ids, but
  // `computeSlotOccupancy` returns early on a degraded probe, so this set is
  // never consumed in that case.
  const provenDeadJobIds = new Set<string>();
  const pidLivenessByJobId = new Map<string, boolean | null>();
  const probeJobPid = (job: Job): boolean | null => {
    const prior = pidLivenessByJobId.get(job.job_id);
    if (prior !== undefined) return prior;
    if (job.pid == null) {
      pidLivenessByJobId.set(job.job_id, null);
      return null;
    }
    try {
      const alive = pidAlive(job.pid);
      pidLivenessByJobId.set(job.job_id, alive);
      return alive;
    } catch {
      pidLivenessByJobId.set(job.job_id, null);
      return null;
    }
  };
  if (livePaneIds !== null) {
    for (const job of jobs.values()) {
      if (job.state !== "stopped" || job.pid == null) {
        continue;
      }
      const paneId = job.backend_exec_pane_id;
      if (paneId == null || paneId === "" || !livePaneIds.has(paneId)) {
        continue;
      }
      if (probeJobPid(job) === false) {
        provenDeadJobIds.add(job.job_id);
      }
    }
  }

  // Done-stamped monitor occupants belong exclusively to the zombie reaper;
  // every other long-unknown occupant stays with the page-only backstop.
  const doneTaskIds = new Set<string>();
  for (const epic of epics) {
    for (const task of epic.tasks) {
      if (task.worker_phase === "done") doneTaskIds.add(task.task_id);
    }
  }
  const confirmedLongUnknownMonitorOccupants: LongUnknownMonitorOccupant[] = [];
  const zombieSessionCandidates: ZombieSessionCandidate[] = [];
  for (const occupant of findLongUnknownMonitorOccupants(
    epics,
    harnessActivityByJobId,
    nowSec,
    MONITOR_SLOT_WEDGE_PAGE_SEC,
  )) {
    const job = jobs.get(occupant.jobId);
    if (job == null || job.state !== "stopped") continue;
    const taskDone =
      job.plan_verb === "work" &&
      job.plan_ref != null &&
      doneTaskIds.has(job.plan_ref);
    const alive = probeJobPid(job);
    if (alive === false) {
      provenDeadJobIds.add(job.job_id);
      continue;
    }
    if (taskDone) {
      zombieSessionCandidates.push({
        jobId: occupant.jobId,
        dir: occupant.root,
        updatedAt: occupant.updatedAt,
      });
    } else if (alive === true) {
      confirmedLongUnknownMonitorOccupants.push(occupant);
    }
  }
  zombieSessionCandidates.sort((a, b) => a.jobId.localeCompare(b.jobId));

  const positivelyClearedMonitorJobIds = new Set<string>();
  for (const row of openMonitorSlotWedges.values()) {
    const job = jobs.get(row.jobId);
    const activity = harnessActivityByJobId.get(row.jobId);
    let jobState: "present" | "terminal" | "absent" = "present";
    if (job == null) {
      const raw = db
        .query("SELECT state FROM jobs WHERE job_id = ?")
        .get(row.jobId) as { state: string } | null;
      jobState =
        raw == null
          ? "absent"
          : raw.state === "ended" || raw.state === "killed"
            ? "terminal"
            : "present";
    }
    if (
      monitorSlotHasPositiveClearEvidence({
        activity,
        pidAlive: job == null ? null : probeJobPid(job),
        jobState,
      })
    ) {
      positivelyClearedMonitorJobIds.add(row.jobId);
    }
  }
  const monitorSlotWedgeActions = decideMonitorSlotWedgeDistress({
    occupants: confirmedLongUnknownMonitorOccupants,
    open: openMonitorSlotWedges,
    positivelyClearedJobIds: positivelyClearedMonitorJobIds,
  });

  const zombieSessionClearActions: { id: string; dir: string }[] = [];
  for (const row of openZombieSessionDistresses.values()) {
    const job = jobs.get(row.jobId);
    const activity = harnessActivityByJobId.get(row.jobId);
    let terminalOrAbsent = false;
    if (job == null) {
      const raw = db
        .query("SELECT state FROM jobs WHERE job_id = ?")
        .get(row.jobId) as { state: string } | null;
      terminalOrAbsent =
        raw == null || raw.state === "ended" || raw.state === "killed";
    }
    const taskStillDone =
      job?.plan_verb === "work" &&
      job.plan_ref != null &&
      doneTaskIds.has(job.plan_ref);
    const occupancySettled =
      row.scope === "occupancy" &&
      (job == null ||
        job.state !== "stopped" ||
        !isStoppedJobLive(job, livePaneIds));
    const monitorSettled =
      row.scope === "monitor" &&
      (job?.state === "working" ||
        activity?.status === "active" ||
        activity?.status === "quiescent" ||
        !taskStillDone);
    if (
      terminalOrAbsent ||
      occupancySettled ||
      monitorSettled ||
      (job != null && probeJobPid(job) === false)
    ) {
      zombieSessionClearActions.push({ id: row.id, dir: row.dir });
    }
  }
  zombieSessionClearActions.sort((a, b) => a.id.localeCompare(b.id));

  // The PER-ROOT unseeded set (`reconcile` forces UNKNOWN only for rows whose
  // `effectiveRoot` is unseeded, so a stale/failed root never darks the whole
  // board) is resolved by `loadReadinessInputs` above off the autopilot's own read
  // connection — bounded to the `seed_required`-set window, EMPTY while the flag is
  // clear.

  // Resolve the `work` and `close` dispatch rows per cycle (cheap single-file
  // parse, fail-safe to the WORKER_* constants) — producer-side launch config,
  // never a fold input. `close` is settable INDEPENDENTLY of `work` (ADR 0040):
  // two separate `dispatch:` rows, resolved here so the pure `reconcile` stays
  // config-blind. Both floor to WORKER_* when their row is absent/malformed, so a
  // `dispatch:`-less catalog yields byte-identical launch argv to the prior default.
  const workLaunch = resolveDispatchLaunchConfig("work");
  const closeLaunch = resolveDispatchLaunchConfig("close");
  const workModel = workLaunch.model ?? WORKER_MODEL;
  const workEffort = workLaunch.effort ?? WORKER_EFFORT;
  const closeModel = closeLaunch.model ?? WORKER_MODEL;
  const closeEffort = closeLaunch.effort ?? WORKER_EFFORT;

  // Load the host worker matrix (ADR 0036) ONCE per cycle and attach it as a
  // serializable four-state discriminated field — the parsed cell axes when good,
  // else the typed failure the pure `reconcile` threads onto every `work` launch as
  // a distress sticky (dispatch parks, the daemon loop NEVER `fatalExit`s — a
  // LaunchAgent respawn would crash-loop a bad config). This single read is why one
  // reconcile cycle sees exactly one matrix verdict: a mid-cycle edit cannot flip
  // it. A non-typed throw is a real bug (loadMatrixV2 wraps every load failure as a
  // MatrixConfigError) — let it propagate to `driveCycle`'s backstop, which logs and
  // re-drives on the next pulse, never launching against an unknown matrix state.
  let hostMatrix: HostMatrixSnapshot;
  try {
    const matrix = loadMatrixV2();
    hostMatrix = {
      ok: true,
      models: matrix.subagentModels,
      effortsByModel: matrix.effortsByModel,
      efforts: matrix.efforts,
      driverByModel: matrix.driverByModel,
      routeByModel: buildRouteByModel(matrix),
    };
  } catch (err) {
    if (err instanceof MatrixConfigError) {
      hostMatrix = { ok: false, state: err.state, detail: err.message };
    } else {
      throw err;
    }
  }

  // Resolve every epic's repos to a single git toplevel for the worktree
  // lane geometry — the ONE git-resolution pass (mirrors `unseededRoots`), gated on
  // `worktreeMode` so an OFF cycle adds ZERO git spawns (empty map). A FRESH
  // per-cycle nullable memo so a transient resolve failure re-resolves next cycle
  // rather than permanently darkening an epic. The pure `reconcile` layer then
  // compares + places lanes by the RESOLVED toplevel and never shells git.
  // ONE resolver (shared memo) for BOTH the per-epic classification and the
  // known-roots resolution below, so a root resolved once is never re-spawned. A
  // SECOND per-cycle memo {@link memoizedAssessRepo} probes each RESOLVED toplevel's
  // worktree-eligibility (fail-closed fs/path peek), so a not-worktree-friendly repo
  // downgrades `ok` → `disabled` (sequential shared-checkout dispatch). Both memos
  // are FRESH per cycle (GC'd at cycle end), so a transient probe failure re-probes
  // next cycle rather than permanently darkening a repo. Gated on `worktreeMode`, so
  // an OFF cycle adds ZERO probes.
  const toplevelResolver = memoizedNullableGitToplevel();
  const assessResolver = memoizedAssessRepo();
  // The exact candidate `plan_ref` values the lane-probe proof seeks per epic — the
  // epic's own id (its close job's ref) plus every task id (each work job's ref) — so
  // `readPriorWorktreeLaneProof` routes through `idx_jobs_plan_ref` (a bounded seek of
  // the epic's own jobs) instead of a `created_at DESC` walk-to-EOF on a no-match.
  const epicForProbe = new Map(epics.map((e) => [e.epic_id, e]));
  const worktreeRepoByEpicId = worktreeMode
    ? classifyWorktreeRepos(
        epics,
        toplevelResolver,
        assessResolver,
        (epicId, repoDir) => {
          const ep = epicForProbe.get(epicId);
          const candidatePlanRefs = ep
            ? [epicId, ...ep.tasks.map((t) => t.task_id)]
            : [epicId];
          return worktreeEpicLaneProbe(db, epicId, repoDir, candidatePlanRefs);
        },
        worktreeMultiRepo,
      )
    : new Map<string, WorktreeRepoResolution>();
  // The recover sweep's KNOWN-ROOTS set — every git-tracked project dir
  // (from the git-status projection) RESOLVED to its toplevel, so a repo carrying
  // a done-but-unmerged base whose epic was already reaped from the projection is
  // still swept (it has no current epic to source its root from). Gated on
  // `worktreeMode` so an OFF cycle adds ZERO git spawns; the shared memo dedups
  // roots already resolved for `worktreeRepoByEpicId`.
  const worktreeKnownRoots = worktreeMode
    ? Array.from(
        new Set(
          Array.from(gitStatusByProjectDir.keys())
            .map((dir) => toplevelResolver(dir))
            .filter((top): top is string => top !== null && top.length > 0),
        ),
      )
    : [];

  // The EPHEMERAL cross-epic merge-gate defer map (epic id → its deferred lane
  // repos) — the ONE place this git pass is probed (it reuses
  // `worktreeRepoByEpicId`'s already-resolved toplevels, so it adds NO extra toplevel
  // spawns — only per-repo lane-enumeration + default-branch reads, memoized inside).
  // Gated on `worktreeMode` so an OFF cycle adds ZERO git spawns (empty map = a
  // byte-identical no-op). NEVER throws (every probe degrades to DEFER), so the
  // snapshot build stays crash-free.
  const deferredEpicIds = worktreeMode
    ? await computeDeferredEpicIds(epics, worktreeRepoByEpicId)
    : new Map<string, Set<string>>();

  // The EPHEMERAL intra-epic sibling-source defer map (dependent task id → the DONE
  // sibling rib not yet contained in the dependent's ACTUAL fork base) — probed here so
  // a dependent lane is never cut off a base missing a done sibling's landed work (a
  // stale-base fork). Reuses the already-resolved toplevels + the same geometry
  // dispatch derives, adding only per-repo lane-enumeration + ancestry reads (memoized
  // inside). The gate reads only BRANCH names (never a lane path), so it needs no
  // `worktreesRoot` — like its sibling producers here. Gated on `worktreeMode` so an OFF
  // cycle adds ZERO git spawns (empty map = a byte-identical no-op). NEVER throws (every
  // probe degrades to DEFER).
  const deferredSiblingSources = worktreeMode
    ? await computeDeferredSiblingSources(epics, worktreeRepoByEpicId)
    : new Map<string, string>();

  // The durable MERGE-LANDED set — purely observational (drives no dispatch arm),
  // computed here so the worker can emit the `lane_merged` projection each cycle.
  // Lane-capable paths reuse the already-resolved toplevels and memoized git probes;
  // explicit serial fallbacks use only the done state. Gated on `worktreeMode` so an
  // OFF cycle adds ZERO git spawns + emits an empty set (the consumer degrades
  // `landed` → `done`). NEVER throws.
  const landedLaneEntries = worktreeMode
    ? await computeMergedLaneEntries(epics, worktreeRepoByEpicId)
    : [];

  const closeRecoveryEligibleIds = worktreeMode
    ? await computeCloseRecoveryEligibleIds(
        epics,
        jobs,
        livePaneIds,
        worktreeRepoByEpicId,
      )
    : new Set<string>();

  // Base drift is a separate producer observation. It reuses the resolved lane
  // repos, resolves each local default once, and remains inert (including all git
  // reads) while worktree mode is OFF.
  const baseDriftEntries = worktreeMode
    ? await computeBaseDriftEntries(epics, worktreeRepoByEpicId)
    : [];

  // The STALE-BASE lane set (fn-1127) — every already-cut lane forked off a base
  // missing a landed same-repo upstream's work. A SIBLING probe to the merge-gate /
  // merge-landed passes (never modifying them), reusing `worktreeRepoByEpicId`'s
  // already-resolved toplevels (no extra toplevel spawns — only per-repo
  // lane-enumeration + ancestry reads, memoized inside). Gated on `worktreeMode` so an
  // OFF cycle adds ZERO git spawns + emits an empty set. Detection + surfacing ONLY:
  // the merge-gate's cut-deferral is untouched. NEVER throws (every arm degrades to
  // no-flag).
  const staleBaseLaneEntries = worktreeMode
    ? await computeStaleBaseLaneEntries(epics, worktreeRepoByEpicId)
    : [];

  // The producer LIVE-JOB dirty attribution the fan-in pre-merge clean consults so it
  // never discards dirt a running worker owns — keyed by lane worktree path. A raw
  // read of undischarged `file_attributions` filtered to LIVE sessions. `null` on ANY
  // read failure → every base is treated do-not-discard. Gated on `worktreeMode` (an
  // OFF cycle provisions no lanes). NEVER a fold input, NEVER read by pure `reconcile`.
  const liveAttributedDirtyByWorktree = worktreeMode
    ? computeLiveAttributedDirtyByWorktree(db, jobs, livePaneIds)
    : new Map<string, ReadonlySet<string>>();

  // The worktrees root the pure lane geometry derives every lane path under —
  // resolved HERE (producer side) so the pure `reconcile` / `prepareWorktreeGeometry`
  // / `deriveWorktreePlan` chain reaches no `homedir()` on the verdict path (re-fold
  // determinism). Gated on `worktreeMode` since the geometry pass runs only then; an
  // OFF cycle threads `undefined` (the geometry pass is skipped anyway) and stays
  // byte-identical.
  const worktreesRoot = worktreeMode ? `${homedir()}/worktrees` : undefined;

  // Fatal-audit fence inputs. `fatalHaltReceiptIsCurrent` grades a fatal receipt against
  // the epic's newest TASK-DONE fact (a follow-up acting on the epic). The fence + mint set
  // is INTERSECTED with positively-OPEN epics so a recently-done / deleted epic carrying a
  // stale stopped close job + old fatal receipt never mints a phantom row; the clear set is
  // POSITIVE-EVIDENCE only (a non-fatal receipt, a drift, or a positively done/absent
  // epic) so a transient receipt read failure RETAINS the open row rather than fail-open
  // clearing it. `fatalAuditFenceLifted` is stepped in the drive loop (persistent memo).
  const openEpicIdSet = new Set(openEpicIds);
  const doneEpicIdSet = new Set(
    epics.filter((e) => e.status === "done").map((e) => e.epic_id),
  );
  const fatalHaltEpicIds = [...latestCloseReceiptByEpicId.entries()]
    .filter(([, r]) => r.outcome === "fatal_halt")
    .map(([id]) => id);
  // Grade drift over the fatal-receipt epics, the OPEN fatal-audit ROW epics, AND the
  // consumed-memo rehold episodes (a consumed epic with NO open row still needs its drift /
  // nonfatal reclassification graded so the memo can release).
  const fatalAuditGradeEpicIds = new Set<string>([
    ...fatalHaltEpicIds,
    ...openFatalAuditIds,
    ...reholdEpicIdSet,
  ]);
  const taskDoneRead = loadEpicTaskDoneWatermarks(db, fatalAuditGradeEpicIds);
  const fatalAuditTaskDoneWatermarks = taskDoneRead.watermarks;
  // Fold the fatal-audit read TRUST into the cycle's degraded verdict: a transient receipt
  // or task-done read error arms the waker's bounded retry (three-state arming), so the
  // operator-free drift unjam re-reads even on a quiescent DB — never stranded on the one
  // data_version edge that coincided with a read error.
  const readinessDegraded =
    readinessDegradedBase || !closeReceiptRead.trusted || !taskDoneRead.trusted;
  const currentFatalAuditEpicIds = new Map<string, string>();
  for (const epicId of fatalHaltEpicIds) {
    if (!openEpicIdSet.has(epicId)) continue; // scope the fence/mint to OPEN epics only
    const receipt = latestCloseReceiptByEpicId.get(epicId);
    if (
      fatalHaltReceiptIsCurrent(
        receipt,
        fatalAuditTaskDoneWatermarks.get(epicId) ?? null,
      )
    ) {
      currentFatalAuditEpicIds.set(
        epicId,
        receipt?.fatalReason ?? boundFatalAuditExcerpt(null),
      );
    }
  }
  // EXHAUSTED-UNKNOWN grade (defect: scan exhaustion must NEVER be clean absence): an OPEN epic
  // whose close-finalize history exists but yielded no valid receipt is fenced conservatively —
  // folded into the current-fatal set (only if not already there and NOT positively done) with
  // a distinct excerpt, so it HOLDS + mints a VISIBLE, retry_dispatch-clearable row instead of
  // fail-opening into a relaunch. A later valid receipt or the operator's retry reclassifies it.
  for (const epicId of closeReceiptRead.unknownEpicIds) {
    if (!openEpicIdSet.has(epicId)) continue;
    if (currentFatalAuditEpicIds.has(epicId)) continue;
    currentFatalAuditEpicIds.set(
      epicId,
      "close-audit history unreadable — the fatal verdict cannot be confirmed; retry_dispatch to re-audit",
    );
  }
  // Positive resolution evidence for each OPEN fatal-audit row OR consumed-memo rehold episode
  // (graded even WITHOUT an open row, so a consumed episode can release). UNKNOWN (receipt read
  // failed, or a still-fatal-current verdict) is NOT added → retained.
  const fatalAuditResolvedEpicIds = new Set<string>();
  for (const epicId of new Set<string>([
    ...openFatalAuditIds,
    ...reholdEpicIdSet,
  ])) {
    const receipt = latestCloseReceiptByEpicId.get(epicId);
    const resolved =
      // positively done (the close landed elsewhere)
      doneEpicIdSet.has(epicId) ||
      // a KNOWN non-fatal latest receipt (a real close outcome superseded the halt)
      (receipt !== undefined && receipt.outcome !== "fatal_halt") ||
      // a follow-up task-done drifted the fatal verdict off the current tree
      (receipt !== undefined &&
        receipt.outcome === "fatal_halt" &&
        !fatalHaltReceiptIsCurrent(
          receipt,
          fatalAuditTaskDoneWatermarks.get(epicId) ?? null,
        )) ||
      // positively absent (a healthy read that no longer lists the epic → deleted/aged-out)
      (!readinessDegraded &&
        !openEpicIdSet.has(epicId) &&
        !doneEpicIdSet.has(epicId));
    if (resolved) fatalAuditResolvedEpicIds.add(epicId);
  }

  return {
    readinessDegraded,
    epics,
    jobs,
    subagentInvocations,
    gitStatusByProjectDir,
    failedKeys,
    incidentOwnerKeys,
    claimedIncidentKeys,
    dispatchFailureFences,
    recoverFailureIds,
    openRecoverRows,
    finalizeFailureIds,
    preCloseFenceFailureIds,
    slotOccupancyFailures,
    sharedWedgeDistressDirs,
    sharedDirtyDistressDirs,
    sharedDesyncDistressDirs,
    originContainmentDistressDirs,
    monitorSlotWedgeActions,
    zombieSessionCandidates,
    openZombieSessionDistresses,
    zombieSessionClearActions,
    laneFailures,
    mergeEscalationFailures,
    laneWedgeDistressDirs,
    laneTeardownDistressDirs,
    laneBackupDistressDirs,
    staleBaseDistressIds,
    dupEpicNumberDistressIds,
    liveTabKeys,
    dispatchClaims: dispatchClaimsByKey,
    harnessActivityByJobId,
    resourceHoldByJobId,
    livePaneIds,
    paneCommandById,
    provenDeadJobIds,
    latestCloseReceiptByEpicId,
    currentFatalAuditEpicIds,
    openFatalAuditIds,
    openFatalAuditInstanceByEpic,
    fatalAuditResolvedEpicIds,
    pendingDispatches,
    providerLegActivityByWrapperJobId,
    mode,
    armedIds,
    unseededRoots,
    workModel,
    workEffort,
    closeModel,
    closeEffort,
    hostMatrix,
    workerProvider,
    ...(workerProviderPinUnknown !== undefined
      ? { workerProviderPinUnknown }
      : {}),
    ...(providerEquivalence !== undefined ? { providerEquivalence } : {}),
    maxConcurrentJobs,
    maxConcurrentPerRoot,
    worktreeMode,
    worktreeRepoByEpicId,
    worktreeKnownRoots,
    deferredEpicIds,
    deferredSiblingSources,
    landedLaneEntries,
    closeRecoveryEligibleIds,
    baseDriftEntries,
    staleBaseLaneEntries,
    liveAttributedDirtyByWorktree,
    worktreesRoot,
  };
}

/** Resolve `ms` later, or early if `signal` aborts (treated as shutdown). */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Wire the worker. Spawned by `src/daemon.ts` after the boot drain. */
function main(): void {
  if (!parentPort) {
    console.error("[autopilot-worker] no parentPort — not running as a Worker");
    process.exit(1);
  }
  const data = workerData as AutopilotWorkerData | undefined;
  if (!data || typeof data.dbPath !== "string") {
    console.error("[autopilot-worker] missing dbPath in workerData");
    process.exit(1);
  }

  const { db } = openDb(data.dbPath, {
    readonly: true,
    prepareStmts: false,
    bootRetry: true,
  });
  const state: ReconcileState = {
    // Seeded from `workerData.paused` (main resumes the durable
    // `autopilot_state.paused`); `?? true` defends a degraded boot with no flag.
    paused: data.paused ?? true,
    inFlight: new Set(),
    // Boot EMPTY (safe: the first cycle rebuilds suppression from the live
    // projection regardless of paused/playing). In-memory only.
    redispatchCooldown: new Map(),
    finalizerGuard: new Map(),
    // Seed the in-memory DEFAULT; the FIRST `driveCycle` refreshes it from the
    // `autopilot_state` projection (`?? DEFAULT`) before `reconcile` reads it, so
    // a runtime-set cap takes effect immediately and survives a restart.
    maxConcurrentJobs: DEFAULT_MAX_CONCURRENT_JOBS,
    // Seed the in-memory per-root DEFAULT (= 1); the FIRST `driveCycle`
    // refreshes it from the projection before `reconcile` reads it.
    maxConcurrentPerRoot: DEFAULT_MAX_CONCURRENT_PER_ROOT,
    // The fatal-audit fence memo boots EMPTY (in-memory only); the first cycle
    // rebuilds it from the live projection + receipts.
    fatalAuditFenceMemo: new Map(),
  };
  // In-flight surfaces this reconciler owns confirm/reap work for. Boots EMPTY:
  // a cold restart re-derives "already running" from the durable `jobs`
  // projection (the occupying-job gate suppresses re-dispatch of survivors), so
  // no surface is double-launched.
  const shutdownController = new AbortController();
  // Pause-scoped abort: `driveCycle` passes THIS signal (not the shutdown one)
  // to `runReconcileCycle`, so a `set-paused {paused:true}` aborts every
  // in-flight confirm WITHOUT marking the worker shut down (a surviving confirm
  // would keep polling a pane the reap just closed). REPLACED after each
  // pause-abort (an aborted signal stays aborted) so the next play cycle is
  // fresh. Shutdown aborts this one too.
  let cycleController = new AbortController();
  const liveDispatches = new Map<DispatchKey, LiveDispatch>();
  // fn-1203 tip-triggered baseline producer state: `repoDir → last tip spooled`.
  // In-memory only, boots EMPTY — the first cycle re-spools each open-epic repo's
  // current tip (harmless by compute-once-per-key), and thereafter one request is
  // spooled per repo whose default-branch tip changes. Bounded to the current
  // open-epic repo set each cycle.
  const baselineTipByRepo = new Map<string, string>();
  // The live toolchain fingerprint half of the baseline key — read once here
  // (env), never per cycle or in a fold; threaded into the producer as data.
  const baselineToolchain = currentToolchain();
  let shutdown = false;
  // Durable `dispatched-ack` correlation. `emitDispatched` posts a
  // `dispatched-request{id}` and parks a resolver keyed by the monotonic `id`;
  // main replies `dispatched-ack{id,ok}`. The Promise also races the
  // `DISPATCHED_ACK_TIMEOUT_MS` timer and the shutdown signal — both REJECT so
  // `confirmRunning` aborts without launching. On shutdown every parked resolver
  // is rejected so no confirm hangs the teardown.
  let nextDispatchedAckId = 1;
  const pendingDispatchAcks = new Map<
    number,
    { resolve: (ack: DispatchedAck) => void; reject: (err: Error) => void }
  >();
  // fn-1013 change-gate for the LIVE-ONLY worktree-disabled operator surface:
  // the serialized last-emitted disabled set. `null` re-emits once on the first
  // post-(re)boot cycle; thereafter a stable set mints no `WorktreeRepoStatus`
  // event. In-worker memory only — persists across cycles in this closure.
  let lastWorktreeStatusKey: string | null = null;
  // fn-1016 change-gate for the LIVE-ONLY merge-landed observable: the serialized
  // last-emitted merged-lane set. `null` re-emits once on the first post-(re)boot
  // cycle; thereafter a stable set mints no `LaneMerged` event. In-worker memory
  // only — persists across cycles in this closure. Twin of `lastWorktreeStatusKey`.
  let lastLaneMergedKey: string | null = null;
  // Producer-side change-gate collapsing the DispatchFailed storm: the reconcile
  // re-derives every failure from live git each cycle, so an unconditional emit
  // mints one event per cycle for a persistently-stuck condition. Emits on first
  // appearance + reason-change + a bounded still-stuck watermark, suppresses
  // identical re-emits; an acknowledged DispatchCleared resets it. In-worker memory only.
  const dispatchFailedGate = createDispatchFailedGate();
  const withholdFrameState = createWithholdFrameState();
  // Per-repo grace tracker escalating a SHARED-checkout mid-merge wedge that
  // outlives the recover pass's self-heal window into a visible distress row. In-
  // worker memory only, mirroring `dispatchFailedGate` — a restart re-arms it.
  const sharedWedgeTracker = createSharedCheckoutWedgeTracker();
  // NOTE: the plain-DIRTY shared-checkout distress family is produced by the daemon's
  // repair-escalation sweep, NOT here — a dirty checkout no longer blocks the recover
  // pass's own base merge, so the recover cycle has no live dirt signal to feed. The
  // sweep is the surface that genuinely still starves on the dirt (a write-capable
  // repair session cannot launch into a dirty tree), so it owns the tracker + the
  // level-clear (`createSharedCheckoutDirtyTracker` stays exported for it). This worker
  // no longer touches the `shared-checkout-dirty` rows, so it never drains the sweep's.
  // Per-LANE grace tracker escalating a fan-in base lane that stays not-losslessly-
  // mergeable past the grace (or IMMEDIATELY for a hard `abort-failed`) into its own
  // per-lane distress row. In-worker memory only; a restart re-arms it. Distinct
  // surface from the shared-checkout trackers so the rows never cross-clear.
  const laneWedgeTracker = createLaneWedgeTracker();
  const laneTeardownTracker = createLaneTeardownGraceTracker();
  // Per-(epic,repo) grace tracker escalating an already-cut lane whose base is STALE
  // (forked before a landed same-repo upstream merged) past the grace into its own
  // per-(epic,repo) distress row. Fed off the producer probe on the snapshot (NOT the
  // recover pass), so it runs independent of `deps.worktree`. In-worker memory only; a
  // restart re-arms it. Distinct surface so the rows never cross-clear.
  const staleBaseLaneTracker = createStaleBaseLaneTracker();
  // Per-repo grace tracker escalating a shared MAIN checkout left DESYNCED by a base→
  // default merge whose resync was skipped/aborted (the ref advanced but the working tree
  // trails the default tip) past the grace into its own per-repo distress row. A LIVE
  // producer (UNLIKE the neutered wedge/dirty trackers): the mint is EVENT-SEEDED via
  // `desyncSeedDirs` below and the clear is a per-cycle content probe. In-worker memory
  // only; a restart re-seeds it from the open-row set. Distinct surface, never
  // cross-clears the siblings.
  const sharedDesyncTracker = createSharedCheckoutDesyncTracker();
  // Per-(project,number) tracker escalating a landed DUPLICATE plan number (two non-done
  // epics in one project sharing an `epic_number`) into its own sticky distress row. Fed off
  // a pure per-cycle probe over the snapshot's epics (NOT git, NOT worktree mode), so it runs
  // every cycle. In-worker memory only; a restart re-arms it. Distinct surface so the rows
  // never cross-clear the shared-checkout / lane / stale-base siblings.
  const dupEpicNumberTracker = createDupEpicNumberTracker();
  // Per-repo grace tracker for the periodic origin-containment fallback: escalates a repo
  // whose local default silently leads a frozen origin — a containment push that keeps
  // timing out/failing, or a true divergence — into its own per-repo distress row, the
  // ONLY paging surface once no owner (finalize/recover) remains to re-trigger the push.
  // In-worker memory only; a restart re-seeds the clear from the open-row set. Distinct
  // surface so the rows never cross-clear the shared-checkout / lane / finalize siblings.
  const originContainmentStuckTracker = createOriginContainmentStuckTracker();
  const pendingReapTerms = new Map<string, PendingReapTerm>();
  const zombieKillSent = new Set<string>();
  // The EVENT-SEEDED desync latch: repo dirs a base→default merge (finalize / recover
  // pass-2) advanced-then-left-trailing this run, fed by `createWorktreeDriver`'s
  // onResyncSkipped sink below. UNIONED each cycle with the OPEN desync row set (which
  // re-seeds it across a restart), probed for content-carries-HEAD evidence, and pruned
  // of any dir the probe finds synced. In-worker memory only.
  const desyncSeedDirs = new Set<string>();
  // Late-bound reconcile kick. The reconciler is level-triggered on
  // `data_version`, but two edges have no DB write to ride: `play` (set-paused →
  // false) flips an in-memory flag only, and a boot into an already-unpaused
  // state. Without an explicit kick, a quiescent DB leaves ready work
  // undispatched. Assigned once `driveCycle` exists; a no-op until then.
  let requestCycle: () => void = () => {};

  parentPort.on("message", (msg: IncomingMessage | undefined) => {
    if (!msg) return;
    if (msg.type === "shutdown") {
      shutdown = true;
      shutdownController.abort();
      // Abort the pause-scoped signal too so any in-flight confirm using
      // it stops polling on teardown (it would otherwise wait on the
      // ceiling before noticing shutdown).
      cycleController.abort();
      // Reject every parked ack-wait so an in-flight `confirmRunning` resolves
      // promptly (as `"aborted-prelaunch"`) instead of hanging until its timeout.
      for (const [id, pending] of pendingDispatchAcks) {
        pendingDispatchAcks.delete(id);
        pending.reject(new Error("autopilot worker shutting down"));
      }
      return;
    }
    if (msg.type === "dispatched-ack") {
      // Resolve the parked `emitDispatched` Promise keyed by the correlation
      // `id`. A late/duplicate ack whose id already discharged is a no-op.
      const pending = pendingDispatchAcks.get(msg.id);
      if (pending) {
        pendingDispatchAcks.delete(msg.id);
        pending.resolve({
          ok: msg.ok,
          suppressed: msg.suppressed,
          attemptId: msg.attemptId,
        });
      }
      return;
    }
    if (msg.type === "retry-armed") {
      state.redispatchCooldown.delete(`${msg.verb}::${msg.id}`);
      if (msg.verb === "close") {
        state.finalizerGuard.delete(msg.id);
      }
      requestCycle();
      return;
    }
    if (msg.type === "set-paused") {
      const wasPaused = state.paused;
      state.paused = msg.paused;
      // Unpause edge (play): kick a cycle so ready work dispatches now
      // instead of waiting for the next incidental `data_version` pulse.
      if (wasPaused && !msg.paused) {
        requestCycle();
      }
      // Pause edge (covers boot-pause too — the boot-append re-arm relays
      // `set-paused {paused:true}` here). Abort every in-flight confirm and swap
      // in a fresh pause-scoped controller for the next play cycle. Idempotent
      // on a redundant pause re-issue.
      if (msg.paused) {
        cycleController.abort();
        cycleController = new AbortController();
      }
      return;
    }
  });

  const closeDb = (): void => {
    try {
      db.close();
    } catch {
      // best-effort; we're exiting either way
    }
  };

  // The worker has no lifecycle sidecar, so launch/probe warnings funnel to
  // stderr.
  const noteLine = (line: string): void => {
    console.error(line);
  };
  // Launch is DIRECT via `keeper agent` (keeper's sole launch transport) into the
  // hardcoded `MANAGED_EXEC_SESSION`. `data.launcherArgvPrefix` (resolved on main)
  // is `[bun, cli/keeper.ts, "agent"]`; absent → an empty prefix that fails
  // LOUDLY per launch (the daemon boot self-check is the primary guard).
  const launcherArgvPrefix = data.launcherArgvPrefix ?? [];
  // The read-time liveness probe (`listPanes`) is a direct tmux pane-ops seam —
  // it targets server-global tmux ids the hook stamps, independent of the launch
  // transport.
  const paneOps = createTmuxPaneOps({ noteLine });
  let terminalPaneSweepRunning = false;
  let terminalPaneSweepPending = false;
  let terminalPaneOwnerScanCursor: string | null = null;
  let terminalPaneDecisionCursor: string | null = null;
  const driveTerminalPaneSweep = async (
    initialPanes?: readonly PaneInfo[] | null,
  ): Promise<void> => {
    if (terminalPaneSweepRunning) {
      terminalPaneSweepPending = true;
      return;
    }
    terminalPaneSweepRunning = true;
    let panes = initialPanes;
    try {
      do {
        terminalPaneSweepPending = false;
        if (panes === undefined) {
          try {
            panes = await paneOps.listPanes();
          } catch (err) {
            noteLine(`terminal pane observation failed: ${errMsg(err)}`);
            panes = null;
          }
        }
        const ownerScan = selectTerminalPaneOwnerScan(
          panes,
          terminalPaneOwnerScanCursor,
        );
        terminalPaneOwnerScanCursor = ownerScan.nextCursor;
        const decisions = await runTerminalPaneTeardownSweep(
          db,
          paneOps,
          panes,
          {
            noteLine,
            scannedOwnerJobIds: ownerScan.jobIds,
            afterJobId: terminalPaneDecisionCursor,
          },
        );
        terminalPaneDecisionCursor = decisions.at(-1)?.jobId ?? null;
        panes = undefined;
      } while (terminalPaneSweepPending && !shutdown);
    } catch (err) {
      noteLine(`terminal pane teardown sweep failed: ${errMsg(err)}`);
    } finally {
      terminalPaneSweepRunning = false;
    }
  };
  // `$SHELL` for the launch argv (`buildLaunchArgv`). Resolved once.
  const shell = process.env.SHELL ?? "/bin/sh";

  // ── backstop telemetry (timeout class) ─────────────────────────────────────
  // The `confirmRunning` ceiling is a timeout-class backstop. This adds the
  // uniform telemetry record alongside the dispatch logic: every confirm bumps
  // the counter (pre-ceiling `rescued:false`, ceiling-hit `rescued:true`), and a
  // rescue posts a record up to main (the sole sidecar writer). A periodic +
  // on-shutdown rollup flushes the denominator without a line per no-op confirm.
  const BACKSTOP_ROLLUP_FLUSH_MS = 5 * 60_000;
  const backstopCounters = new BackstopCounters();
  const flushBackstopRollups = (): void => {
    for (const rollup of backstopCounters.snapshot(Date.now())) {
      parentPort?.postMessage({
        kind: "backstop",
        record: rollup,
      } satisfies BackstopMessage);
    }
  };
  const recordTimeoutBackstop = (args: {
    rescued: boolean;
    stalenessMs: number | null;
  }): void => {
    backstopCounters.bump("autopilot-ceiling", "timeout", args.rescued);
    if (args.rescued) {
      parentPort?.postMessage({
        kind: "backstop",
        record: buildTimeoutRecord({
          backstop: "autopilot-ceiling",
          worker: "autopilot-worker",
          rescued: true,
          now: Date.now(),
          stalenessMs: args.stalenessMs,
        }),
      } satisfies BackstopMessage);
    }
  };

  // Set by the parts-6 progress actor's `nudgeReconcileSoon` when it integrated a rib
  // (external git progress that bumps NO data_version) — the driveCycle finally arms an
  // immediate re-tick so the now-cleared sibling-source gate is re-evaluated at once.
  let progressActorNudged = false;

  // Side-effect deps for the reconcile + confirm cycle. Reads run on the
  // worker's OWN read-only connection; the worker NEVER writes the DB —
  // a DispatchFailed is described to main via `postMessage` (main is the
  // sole writer of the synthetic event, mirroring the git-worker mint).
  const deps: ConfirmRunningDeps = {
    // Direct `keeper agent` launch into the managed session. The pre-wrapped
    // `argv` is ignored — the launcher builds its invocation from the structured
    // `spec` and owns the tmux window; `name` is the warn/log label + dedup key.
    launch: (_argv, name, cwd, spec) =>
      keeperAgentLaunch({
        noteLine,
        launcherArgvPrefix,
        session: MANAGED_EXEC_SESSION,
        cwd,
        label: name,
        spec,
      }),
    emitDispatchFailed: (payload) => {
      // Change-gate: suppress an identical per-cycle re-emit; a first appearance,
      // a reason change, or a bounded still-stuck watermark passes through.
      if (!dispatchFailedGate.shouldEmit(payload)) {
        return;
      }
      parentPort?.postMessage({
        kind: "dispatch-failed",
        payload,
      } satisfies DispatchFailedMessage);
    },
    emitDispatchCleared: (payload) => {
      // Keep suppression armed until a later projection proves this exact
      // incident disappeared. A dropped or stale message must not re-arm it.
      dispatchFailedGate.noteClear(payload);
      parentPort?.postMessage({
        kind: "dispatch-cleared",
        payload,
      } satisfies DispatchClearedMessage);
    },
    emitSharedWedgeDistress: (payload) => {
      // Grace-tracker already enforced exactly-once per wedge episode; main mints
      // the synthetic `daemon`-verb row (idempotent UPSERT on the per-repo key).
      parentPort?.postMessage({
        kind: "shared-wedge-distress",
        action: "mint",
        id: payload.id,
        dir: payload.dir,
        reason: payload.reason,
        ts: payload.ts,
      } satisfies SharedWedgeDistressMessage);
    },
    clearSharedWedgeDistress: (payload) => {
      parentPort?.postMessage({
        kind: "shared-wedge-distress",
        action: "clear",
        id: payload.id,
        dir: payload.dir,
        expected_attempt_id: null,
        expected_instance_event_id: payload.expected_instance_event_id,
      } satisfies SharedWedgeDistressMessage);
    },
    nudgeVanishedSweep: () => {
      // Payload-free relay to main → git-worker (mirrors the nudge-discovery
      // relay). Fired only from a completed lane teardown, so the immediate
      // vanished sweep it triggers acts on a genuinely-gone lane.
      parentPort?.postMessage({
        kind: "nudge-vanished-sweep",
      } satisfies VanishedSweepNudgeMessage);
    },
    nudgeReconcileSoon: () => {
      // The progress actor made external git progress (a rib integrated into a held
      // lane) that bumps NO data_version, so `watchLoop` would not re-evaluate the
      // sibling-source gate on its own. Flag an immediate re-tick; the driveCycle finally
      // arms the coalesced waker at `now` so the next cycle runs promptly.
      progressActorNudged = true;
    },
    // Semantic-dedupe emit (mirrors `git_status`): only post when the disabled set
    // changes, so a stable board mints zero `WorktreeRepoStatus` events. The
    // serialized key is the change-gate; `null` seed re-emits once on the first
    // cycle after each (re)boot. In-worker memory only — `lastWorktreeStatusKey`
    // persists across cycles in this `main()` closure.
    emitWorktreeRepoStatus: (entries) => {
      const key = JSON.stringify(entries);
      if (key === lastWorktreeStatusKey) {
        return;
      }
      lastWorktreeStatusKey = key;
      parentPort?.postMessage({
        kind: "worktree-repo-status",
        entries,
      } satisfies WorktreeRepoStatusMessage);
    },
    // fn-1016 — semantic-dedupe emit of the merge-landed set (mirrors
    // `emitWorktreeRepoStatus`): only post when the merged-lane set changes, so a
    // stable board mints zero `LaneMerged` events. `null` seed re-emits once on the
    // first cycle after each (re)boot. In-worker memory only.
    emitLaneMerged: (entries) => {
      const key = JSON.stringify(entries);
      if (key === lastLaneMergedKey) {
        return;
      }
      lastLaneMergedKey = key;
      parentPort?.postMessage({
        kind: "lane-merged",
        entries,
      } satisfies LaneMergedMessage);
    },
    emitDispatched: (payload) =>
      new Promise<DispatchedAck>((resolve, reject) => {
        // Post an id-correlated request and AWAIT main's durable insert ack.
        // Reject (→ `confirmRunning` aborts without launching) if the ack never
        // arrives within DISPATCHED_ACK_TIMEOUT_MS, or on an already-aborted
        // shutdown signal.
        if (shutdownController.signal.aborted) {
          reject(new Error("autopilot worker shutting down"));
          return;
        }
        const id = nextDispatchedAckId++;
        const timer = setTimeout(() => {
          if (pendingDispatchAcks.delete(id)) {
            reject(
              new Error(
                `dispatched-ack timeout after ${DISPATCHED_ACK_TIMEOUT_MS}ms (verb=${payload.verb} id=${payload.id})`,
              ),
            );
          }
        }, DISPATCHED_ACK_TIMEOUT_MS);
        pendingDispatchAcks.set(id, {
          resolve: (ack) => {
            clearTimeout(timer);
            resolve(ack);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
        parentPort?.postMessage({
          kind: "dispatched-request",
          id,
          payload,
        } satisfies DispatchedMessage);
      }),
    maxEventId: () => {
      const row = db.query("SELECT MAX(id) AS m FROM events").get() as
        | { m: number | null }
        | undefined;
      return row?.m ?? 0;
    },
    findJob: (plan_verb, plan_ref, last_event_id_gt) => {
      const row = db
        .query(
          `SELECT job_id, last_event_id FROM jobs
              WHERE plan_verb = ? AND plan_ref = ?
                AND state IN ('working', 'stopped')
                AND last_event_id > ?
              LIMIT 1`,
        )
        .get(plan_verb, plan_ref, last_event_id_gt) as
        | { job_id: string; last_event_id: number }
        | undefined;
      return row ?? null;
    },
    // Read-side claim-acquire verification against the reconciler's own
    // read-only connection — the `confirmRunning` launch gate. Reads the cursor
    // + folded claim/pending rows; never a fold.
    observeClaimAcquire: (verb, id) =>
      readClaimAcquireObservation(db, verb, id),
    now: () => Math.floor(Date.now() / 1000),
    // Producer-side cwd existence probe — fail-loud on a renamed-away launch
    // dir (`cwd-missing` DispatchFailed) instead of a silent skip. Runs on the
    // worker but only on the reconcile/confirm path, never in a fold.
    dirExists: (dir) => existsSync(dir),
    sleep: (ms, signal) => abortableSleep(ms, signal),
    recordTimeoutBackstop,
    // The producer git driver. Wired unconditionally: when worktree mode
    // is ON `reconcile` stamps each launch with geometry the driver provisions;
    // when OFF the driver runs only the on-default-branch assertion. The branch-
    // guard hook does NOT fire here — this is the daemon producer shelling git
    // directly, not a plan-worker subagent's Bash. The desync seed sink records each
    // resync-skipped base merge into the in-memory latch the per-cycle probe watches.
    worktree: createWorktreeDriver(
      gitExec,
      undefined,
      (repoDir) => {
        desyncSeedDirs.add(repoDir);
      },
      true,
      (a) => runMergeSuiteGate(a),
      () => requestCycle(),
    ),
    // The MAIN-projection done-ness probe finalize gates on (the closer
    // writes `done` to the PRIMARY repo, so the projection is the authority). The
    // same `isEpicDoneById` the recover glue threads into `worktree.recover`.
    isEpicDone: (epicId) => isEpicDoneById(db, epicId),
    stampEpicCloseRecovery: (epicId, projectDir) =>
      stampEpicCloseRecovery(epicId, projectDir),
    // The merge-suite gate probe: before local default advances, finalize runs the
    // fast suite against the prospective merged commit on a detached scratch worktree.
    // Real git + a real suite run (a producer side effect, never a fold).
    //
    // This runs INLINE on the single-flight reconcile drive: a green worktree-mode
    // close pauses board-wide dispatch/recover/escalation for the suite's whole
    // duration (the root suite, plus the plan suite on a plugins/plan merge). That
    // inline block is an ACCEPTED, bounded tradeoff, not an oversight:
    //   - worktree mode is default-OFF and opt-in, so only an operator who enabled it
    //     ever pays this; the default single-checkout autopilot never runs the gate.
    //   - the cost is paid at most once per successful close — the verdict is memoized
    //     per prospective-merged OID (`mergeSuiteMemo`), so a parked/retried finalize
    //     reuses it and never re-runs the suite.
    //   - it is a board-progress PAUSE, never a liveness/crash risk: the await sits in
    //     the autopilot WORKER thread over async git subprocesses, stalling neither the
    //     serve sockets nor the main event loop, so no watchdog fatalExit fires.
    //   - the correctness isolation is already in place — the suite runs OUTSIDE the
    //     commit-work flock, on exactly the deterministic OID `mergeLaneBaseIntoDefault`
    //     advances to; only the drive-occupancy cost is inline.
    // Revisit if worktree mode goes default-ON or concurrent multi-epic closes become
    // common: move the run off the drive behind a result-leaf store keyed on the
    // prospective-merged OID (the baseline runner's idiom, whose scratch worktrees this
    // gate already shares) and have finalize read the leaf instead of awaiting inline.
    runMergeSuite: (a) => runMergeSuiteGate(a),
  };

  // Single-flight reconcile drive. `watchLoop` fires this on every
  // `data_version` pulse; a wake while a cycle runs sets `wakePending` and the
  // running cycle loops once more after it finishes — coalescing a burst into one
  // trailing re-run. Re-entrant-safe: `reconcile` is pure over a fresh snapshot
  // and `runReconcileCycle` owns the one-at-a-time stagger.
  let cycleRunning = false;
  let wakePending = false;
  // Coalesced stopped-job expiry wake — closing the quiescent-DB clock edge: one
  // re-armable wall-clock timer fired at the earliest stopped-job reap expiry so the
  // age-driven reap runs even when no `data_version` change wakes `watchLoop`.
  // `unref`'d so it never keeps the worker thread alive.
  // One real wall-clock adapter shared by both coalesced wakers (stopped-job expiry and
  // origin-containment episode/retry). `unref` keeps neither timer alive on shutdown.
  const wakeClock: ExpiryWakeClock = {
    now: () => deps.now(),
    setTimer: (delayMs, fire) => {
      const timer = setTimeout(fire, delayMs);
      (timer as { unref?: () => void }).unref?.();
      return timer;
    },
    clearTimer: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const stoppedExpiryWaker = createStoppedExpiryWaker(
    wakeClock,
    () => {
      if (!shutdown) void driveCycle();
    },
    () => shutdown,
  );
  // PARALLEL coalesced waker for the origin-containment fallback (BLOCKER 2): watchLoop is
  // data_version-only, so a repo whose containment sweep failed sits in a quiescent DB and
  // never re-crosses its grace / re-probes an open row. This arms ONE re-armable timer at the
  // earliest containment episode deadline (or the bounded retry cadence) the sweep computes,
  // firing a fresh cycle with ZERO DB writes. Same idiom as {@link createStoppedExpiryWaker},
  // a distinct instance so the two clock edges never clobber each other's timer.
  const containmentExpiryWaker = createStoppedExpiryWaker(
    wakeClock,
    () => {
      if (!shutdown) void driveCycle();
    },
    () => shutdown,
  );
  const driveCycle = async (): Promise<void> => {
    if (cycleRunning) {
      wakePending = true;
      return;
    }
    cycleRunning = true;
    // THREE-STATE wake targets, applied in `finally`. `{ at }` is a definite deadline; `idle`
    // is a positive no-candidate (disarm); `unknown` is an UNTRUSTWORTHY cycle (a throw, or a
    // degraded/inconclusive probe) that must NOT erase a live clock edge — the waker preserves
    // its prior timer or arms one bounded retry. Each is INITIALIZED to `unknown` and RE-SET to
    // unknown at the TOP of every loop iteration, so a cycle that throws before deriving a
    // trustworthy value leaves the prior edge intact (the transient-null clock-edge race).
    let latestSlotArm: WakeArm = "unknown";
    let latestContainmentArm: WakeArm = "unknown";
    try {
      do {
        wakePending = false;
        latestSlotArm = "unknown";
        latestContainmentArm = "unknown";
        if (shutdown) {
          return;
        }
        // Reset the per-cycle origin-push guard FIRST — before recover and finalize push
        // (both stamp it), so the periodic origin-containment sweep (which runs LAST, after
        // runReconcileCycle) skips every repo an owner push already attempted this cycle.
        beginContainmentCycle();
        // Share one whole-server pane observation between the occupancy snapshot
        // and terminal-pane planner. A second observation happens only adjacent
        // to an authorized teardown action.
        let observedPanes: PaneInfo[] | null = null;
        try {
          observedPanes = await paneOps.listPanes();
        } catch (err) {
          console.error(
            "[autopilot-worker] terminal pane observation threw (non-fatal):",
            err,
          );
        }
        await driveTerminalPaneSweep(observedPanes);
        // The CONSUMED memo episodes — threaded in so their reclassification is graded even
        // without an open synthetic row (a fresh nonfatal receipt / task-done drift landing
        // after the retry-launch must release the memo, else the fence holds forever).
        const reholdEpicIds: string[] = [];
        for (const [epicId, entry] of state.fatalAuditFenceMemo) {
          if (entry.lift === "consumed") reholdEpicIds.push(epicId);
        }
        const snapshot = await loadReconcileSnapshot(
          db,
          async () => observedPanes,
          undefined,
          undefined,
          undefined,
          reholdEpicIds,
        );
        if (snapshot.readinessDegraded) {
          // A DB-degraded cycle derives no trustworthy decision. The SLOT arm may disarm while
          // paused (no reap is permitted paused); the CONTAINMENT arm stays `unknown` EVEN paused,
          // because mode-off row retirement IS permitted paused — disarming would strand an
          // obsolete non-retryable row on a quiescent paused board. Both preserve / bounded-retry
          // rather than freeze a live clock edge on a transient DB read.
          const degradedArms = readinessDegradedWakeArms(state.paused);
          latestSlotArm = degradedArms.slot;
          latestContainmentArm = degradedArms.containment;
          continue;
        }
        const laneMaintenanceProbe = createLaneMaintenanceProbe(
          snapshot.jobs,
          snapshot.dispatchClaims,
          snapshot.livePaneIds,
          snapshot.claimedIncidentKeys,
        );
        dispatchFailedGate.observeProjection(snapshot.dispatchFailureFences);
        // fn-1013 — surface the FULL current worktree-disabled set to the LIVE-ONLY
        // operator projection. Once per cycle, regardless of paused/playing (the
        // verdict is observational, not a dispatch action); the dep dedupes so a
        // stable set mints no event, and an empty set (worktree mode OFF, or no
        // disabled epics) clears the table. Wrapped — a post failure must not wedge
        // the wake loop.
        try {
          deps.emitWorktreeRepoStatus?.(
            buildWorktreeStatusEntries(snapshot.worktreeRepoByEpicId),
          );
        } catch (err) {
          console.error(
            "[autopilot-worker] worktree-status emit threw (non-fatal):",
            err,
          );
        }
        // Surface the FULL current merge-landed set to the LIVE-ONLY `lane_merged`
        // observable. Once per cycle, regardless of paused/playing (the verdict is
        // observational, not a dispatch action); the dep dedupes so a stable set
        // mints no event, and an empty set (worktree mode OFF, or no landed work)
        // clears the table. Wrapped — a post failure must not wedge the wake loop.
        try {
          deps.emitLaneMerged?.(snapshot.landedLaneEntries ?? []);
        } catch (err) {
          console.error(
            "[autopilot-worker] lane-merged emit threw (non-fatal):",
            err,
          );
        }
        // fn-1203 — the tip-triggered baseline producer. Once per cycle,
        // regardless of paused/playing (detection, not a dispatch action): spool
        // a fresh trunk baseline for each open-epic repo whose default-branch tip
        // moved since the last spool. Wrapped — a spool failure must not wedge the
        // wake loop.
        try {
          runBaselineTipProducer(
            snapshot.epics,
            readGitHeadByProjectDir(db),
            baselineTipByRepo,
            {
              now: deps.now,
              toolchain: baselineToolchain,
              writeSpoolRequest: (request) =>
                writeRequest(requestPath(newRequestId()), request),
            },
          );
        } catch (err) {
          console.error(
            "[autopilot-worker] baseline tip producer threw (non-fatal):",
            err,
          );
        }
        // Prune expired cooldown entries each cycle, BEFORE `reconcile` reads the
        // Map so a just-expired key is re-dispatchable this cycle. Wrapped
        // (no-self-heal: a sweep throw must not crash the worker).
        try {
          sweepRedispatchCooldown(state.redispatchCooldown, deps.now());
        } catch (err) {
          console.error(
            "[autopilot-worker] cooldown sweep threw (non-fatal):",
            err,
          );
        }
        // Prune expired finalizer-guard entries each cycle, same rationale.
        try {
          sweepFinalizerGuard(state.finalizerGuard, deps.now());
        } catch (err) {
          console.error(
            "[autopilot-worker] finalizer-guard sweep threw (non-fatal):",
            err,
          );
        }
        // Re-anchor the cooldown + finalizer guard to any key still
        // backed by an OPEN `pending_dispatches` row (`snapshot.liveTabKeys`), so
        // suppression tracks a slow-cold-boot worker's DURABLE phantom lifetime
        // instead of lapsing at the fixed dispatch-anchored window. AFTER the
        // sweeps (a key about to expire is refreshed while its phantom is live)
        // and BEFORE `reconcile` reads the Maps. Bounded by the TTL sweep that
        // discharges the row — never perpetual. Wrapped (no self-heal).
        try {
          refreshSuppressionForOpenPending(
            state.redispatchCooldown,
            state.finalizerGuard,
            snapshot.liveTabKeys,
            deps.now(),
          );
        } catch (err) {
          console.error(
            "[autopilot-worker] suppression refresh threw (non-fatal):",
            err,
          );
        }
        // Refresh the cap from the projection BEFORE `reconcile` reads it off
        // `state` — so a runtime `set_autopilot_config` (folded into
        // `autopilot_state.max_concurrent_jobs`) takes effect this very cycle.
        // Snapshot already resolved `column ?? DEFAULT`.
        state.maxConcurrentJobs = snapshot.maxConcurrentJobs;
        // Refresh N the same way so a runtime `set_autopilot_config`
        // {max_concurrent_per_root} takes effect this cycle. Snapshot already
        // resolved `column ?? DEFAULT` (= 1).
        state.maxConcurrentPerRoot = snapshot.maxConcurrentPerRoot;
        // Long-unknown worker-monitor slot backstop. This is a paging producer,
        // never a reaper: mints one daemon distress for each stopped pid-alive
        // occupant past the horizon and level-clears only after positive
        // settle/exit/fact-clear evidence. Paused boards defer synthetic writes.
        if (!state.paused) {
          try {
            for (const action of snapshot.monitorSlotWedgeActions?.mint ?? []) {
              deps.emitSharedWedgeDistress?.({
                id: action.id,
                dir: action.dir,
                reason: action.reason,
                ts: deps.now(),
              });
            }
            for (const action of snapshot.monitorSlotWedgeActions?.clear ??
              []) {
              deps.clearSharedWedgeDistress?.(
                claimlessDistressClear(
                  snapshot.dispatchFailureFences,
                  action.id,
                  action.dir,
                ),
              );
            }
          } catch (err) {
            console.error(
              "[autopilot-worker] monitor-slot wedge distress step threw (non-fatal):",
              err,
            );
          }
        }
        // Producer-only worktree crash/restart recovery, BEFORE the
        // dispatch decision (so the first boot cycle is the post-restart sweep).
        // Gated on worktree mode ON AND not-paused (recovery does git merges +
        // pushes, the same side-effect class the dispatch loop suppresses while
        // paused). Reads ONLY live git + the durable done-ness probe; never a fold.
        // Wrapped so a producer git failure can't wedge the wake loop.
        if (snapshot.worktreeMode && !state.paused && deps.worktree) {
          try {
            const openRecoverRows = snapshot.openRecoverRows ?? [];
            const repos = reposForRecovery(
              snapshot.epics,
              snapshot.worktreeRepoByEpicId,
              [
                ...(snapshot.worktreeKnownRoots ?? []),
                ...openRecoverRows.map((row) => row.dir),
              ],
            );
            // The SAME snapshot the cycle reconciled, indexed by epic id so the
            // pass-3 occupancy gate can enumerate an epic's tasks for the work-arm.
            const epicById = new Map(snapshot.epics.map((e) => [e.epic_id, e]));
            const {
              failures,
              escalations,
              resolved,
              laneWedged,
              laneResolved,
              laneTeardownDistress,
              tornDownLane,
            } = await deps.worktree.recover(
              repos,
              // Pass-2's TRI-STATE done-probe — surfaces authoritatively-absent and
              // inconclusive so pass-2 clears vs defers correctly (NOT the boolean
              // `isEpicDoneById`, which collapses both to skip).
              (epicId) => epicRecoverVerdictById(db, epicId),
              (epicId) => epicPresentAndNotDone(db, epicId),
              // Per-epic integration exclusion from the SAME snapshot: recovery
              // skips any active work/close incident claim. Pure projection data,
              // never a fold.
              (epicId) => {
                for (const key of snapshot.claimedIncidentKeys ?? []) {
                  if (
                    key === dispatchKey("close", epicId) ||
                    key.startsWith(`work::${epicId}.`)
                  ) {
                    return true;
                  }
                }
                return false;
              },
              // Per-epic occupancy gate (ADR 0031): pass-3 preserves a lane whose
              // epic has an OCCUPYING close/work job so a done epic's mid-turn closer
              // never has its cwd torn down. An absent epic (no snapshot row) has no
              // live job → not occupying → its genuinely-orphaned base is still swept.
              (epicId) => {
                const epic = epicById.get(epicId);
                return (
                  epic !== undefined &&
                  (snapshot.resourceHoldByJobId === undefined
                    ? epicHasOccupyingJob(
                        epic,
                        snapshot.jobs,
                        snapshot.livePaneIds,
                      )
                    : epicResourceTeardownBlocked(
                        epic,
                        snapshot.jobs,
                        snapshot.resourceHoldByJobId,
                      ))
                );
              },
              {
                tracker: laneTeardownTracker,
                nowSec: deps.now(),
                openTeardownPaths:
                  snapshot.laneTeardownDistressDirs ?? new Set(),
                openBackupPaths: snapshot.laneBackupDistressDirs ?? new Set(),
              },
              laneMaintenanceProbe,
              (epicId) =>
                snapshot.epics.some((epic) => epic.epic_id === epicId) &&
                snapshot.incidentOwnerKeys?.has(
                  dispatchKey("close", epicId),
                ) === true,
              openRecoverRows,
            );
            // A COMPLETED pass-3 lane teardown: nudge the git vanished sweep so it
            // retires the torn-down lane's git_status row promptly, not at the next
            // full sweep. Deferred/failed teardowns leave `tornDownLane` false.
            if (tornDownLane) {
              deps.nudgeVanishedSweep?.();
            }
            for (const action of laneTeardownDistress ?? []) {
              if (action.action === "mint") {
                deps.emitSharedWedgeDistress?.({
                  id: action.id,
                  dir: action.dir,
                  reason: action.reason ?? LANE_TEARDOWN_DISTRESS_REASON,
                  ts: deps.now(),
                });
              } else {
                deps.clearSharedWedgeDistress?.(
                  claimlessDistressClear(
                    snapshot.dispatchFailureFences,
                    action.id,
                    action.dir,
                  ),
                );
              }
            }
            for (const f of failures) {
              deps.emitDispatchFailed({
                verb: "close",
                // Per-(epic,repo) for an epic-tied failure so a main checkout and its
                // multi-repo dirs never collide on `close::<epic>` and mask each
                // other's reason; a path-tied failure (no epic) keeps the dir slug.
                // MUST equal recoverFailuresToClear's key — both call the one helper.
                id: recoverFailureDispatchId(f),
                reason: f.reason,
                dir: f.dir,
                conflictedFiles: null,
                ts: deps.now(),
              });
            }
            // TERMINAL content-conflict escalations mint on the BARE `close::<epic>`
            // id (verb close): routing classifies them merge-escalation (OUTSIDE both
            // auto-clear scopes), the resolver-dispatch + merge-escalation sweeps
            // select them, `keeper autopilot retry close::<epic>` (hardcoded in the
            // resolver brief + human escalation) drops them, and a same-epic finalize
            // close-sink row UPSERT-converges on the shared key rather than double-
            // minting.
            for (const e of escalations) {
              deps.emitDispatchFailed({
                verb: "close",
                id: e.epicId,
                reason: e.reason,
                dir: e.dir,
                conflictedFiles: null,
                ts: deps.now(),
              });
            }
            // POSITIVE-EVIDENCE level-triggered auto-clear: an OPEN recover row clears
            // ONLY when this cycle produced a positive resolution observation for it
            // (base merged, ancestor-of-default, epic authoritatively absent, or repo
            // swept clean of path-tied failures) AND it is not still failing. Absence
            // of any report RETAINS the row — a silently-skipped cycle (a sibling's
            // conflict re-reported while this epic's probe was inconclusive, or the
            // whole pass paused) never dismisses a live block. Scoped to recover-reason
            // rows (`recoverFailureIds`) so a close-sink conflict sharing the key is
            // never clobbered.
            for (const id of recoverFailuresToClear(
              snapshot.recoverFailureIds,
              failures,
              resolved,
            )) {
              deps.emitDispatchCleared(
                dispatchClearedPayload(
                  snapshot.dispatchFailureFences,
                  "close",
                  id,
                ),
              );
            }
            // Sustained mid-merge WEDGE escalation NEUTERED: a mid-merge SHARED checkout
            // no longer blocks the base merge — it lands via the working-tree-free
            // plumbing pipeline regardless — so a `worktree-recover-mid-merge` observation
            // is a FALSE POSITIVE for a block that no longer exists (a foreign in-flight
            // merge in the human's checkout is now harmless). Feed the tracker NO
            // observations: the mint never fires, and the level-clear (fed the OPEN
            // distress set below) DRAINS any shared-checkout-wedge row already open so an
            // operator is never left with an un-clearable daemon-verb row. (The SIBLING
            // plain-DIRTY family is NOT drained here — it now has a LIVE producer in the
            // daemon's repair-escalation sweep, which owns its mint AND level-clear.)
            const { wedged: wedgedRepos } =
              sharedCheckoutDistressObservations();
            const wedgeDecision = sharedWedgeTracker.step({
              wedged: wedgedRepos,
              openDistressDirs: snapshot.sharedWedgeDistressDirs ?? new Set(),
              nowSec: deps.now(),
            });
            for (const m of wedgeDecision.mint) {
              deps.emitSharedWedgeDistress?.({
                id: m.id,
                dir: m.dir,
                reason: m.reason ?? SHARED_WEDGE_DISTRESS_REASON,
                ts: deps.now(),
              });
            }
            for (const c of wedgeDecision.clear) {
              deps.clearSharedWedgeDistress?.(
                claimlessDistressClear(
                  snapshot.dispatchFailureFences,
                  c.id,
                  c.dir,
                ),
              );
            }
            // Fan-in LANE pre-merge arm (fn-1123.2): the recover pass re-probed each
            // surviving keeper lane's base readiness. Normalize both sides to the ONE
            // lane-path key (realpath + trailing-slash strip), then:
            //  1. verb-agnostic reason-scoped level-clear — a `work::<taskId>` lane row
            //     whose base is READY/gone this cycle (and not still wedged) clears,
            //     bypassing the router's dead `work-task` arm. Rides the recover pass,
            //     so it clears even while the owning task is cap-gated / cooled / paused.
            //  2. grace tracker — a lane wedged past the grace (or IMMEDIATELY for a
            //     hard `abort-failed`) mints a per-lane distress; the level-clear off the
            //     OPEN distress set fires the cycle the lane goes ready/gone.
            // The wedge tracker's input is gated on owning-worker liveness+progress
            // (fn-1144): a graced lane whose worker is alive and progressing is withheld
            // so a healthy running worker's naturally-dirty base never pages a human;
            // only a dead/stalled worker's lane (or a hard immediate abort-failed) feeds
            // the tracker. Producer-side read of snapshot jobs + live panes, never a fold.
            const wedgedLanes = gateWedgedLanesByLiveness(
              laneWedged ?? [],
              snapshot.jobs,
              snapshot.livePaneIds,
              deps.now(),
            );
            const resolvedLanes = new Set(
              (laneResolved ?? []).map((p) => normalizeLanePath(p)),
            );
            const wedgedLaneKeys = new Set(wedgedLanes.keys());
            for (const c of laneFailuresToClear(
              snapshot.laneFailures ?? [],
              wedgedLaneKeys,
              resolvedLanes,
            )) {
              deps.emitDispatchCleared(
                dispatchClearedPayload(
                  snapshot.dispatchFailureFences,
                  c.verb,
                  c.id,
                ),
              );
            }
            // POSITIVE-EVIDENCE level-clear for the MERGE-ESCALATION stickies (bare
            // `close::<epic>` conflicts + `work::<taskId>` fan-in
            // `worktree-merge-conflict` rows, the pre-minted `pending owner integration`
            // class included). NEVER on task/epic terminal status — done != merged is the
            // incident-defect this replaces. Two tiers:
            //  - EPIC-LANDED evidence (`landedEpicIds`): the epic base is an ancestor of
            //    local default or was torn down after merging (`landedLaneEntries`,
            //    conservative-degrading to NOT-merged on inconclusive), UNIONED with this
            //    cycle's recover pass-2 base→default resolutions. This is the `close::`
            //    clear and the `work::` straggler FALLBACK; a close sticky deliberately
            //    lingers until the base LANDS, not at the earliest per-fan-in merge —
            //    bounded by attachment/page-once, and never re-optimized to lane evidence.
            //  - INCIDENT-SPECIFIC evidence (`workVerdicts`, PRIMARY for `work::`): the
            //    row's own source rib merged into its target base + a clean target
            //    checkout, so a resolved fan-in clears the SAME cycle while its epic is
            //    still open. Bounded to the OPEN work merge rows (the same probe class the
            //    recover/lane passes run). A `source-absent` verdict needs the epic-landed
            //    or task-terminal corroboration the helper applies.
            // A fresh conflict/degrade for the epic this cycle blocks either verb's clear.
            // Routed through the SAME `emitDispatchCleared` gate, so
            // `handleDispatchClearedMint`'s incident-only fence leaves a live claimant's
            // attempt-owned state untouched.
            const landedEpicIds = new Set<string>(
              (snapshot.landedLaneEntries ?? []).map((e) => e.epic_id),
            );
            for (const r of resolved) {
              if (r.epicId !== null) landedEpicIds.add(r.epicId);
            }
            const blockedEpicIds = new Set<string>();
            for (const e of escalations) blockedEpicIds.add(e.epicId);
            for (const f of failures) {
              if (f.epicId !== null) blockedEpicIds.add(f.epicId);
            }
            // Task-terminal corroboration for a `source-absent` verdict — the task's own
            // administrative completion (`worker_phase === "done"`, or its epic done).
            const taskTerminalIds = new Set<string>();
            for (const epic of snapshot.epics) {
              const epicDone = epic.status === "done";
              for (const task of epic.tasks) {
                if (epicDone || task.worker_phase === "done") {
                  taskTerminalIds.add(task.task_id);
                }
              }
            }
            const mergeRows = snapshot.mergeEscalationFailures ?? [];
            const workVerdicts = await probeWorkMergeIncidentResolutions(
              mergeRows.filter((r) => r.verb === "work"),
            );
            for (const c of mergeEscalationFailuresToClear(
              mergeRows,
              landedEpicIds,
              blockedEpicIds,
              workVerdicts,
              taskTerminalIds,
            )) {
              deps.emitDispatchCleared(
                dispatchClearedPayload(
                  snapshot.dispatchFailureFences,
                  c.verb,
                  c.id,
                ),
              );
            }
            const laneDecision = laneWedgeTracker.step({
              wedged: wedgedLanes,
              openDistressDirs: new Set(
                [...(snapshot.laneWedgeDistressDirs ?? new Set<string>())].map(
                  (d) => normalizeLanePath(d),
                ),
              ),
              nowSec: deps.now(),
            });
            for (const m of laneDecision.mint) {
              deps.emitSharedWedgeDistress?.({
                id: m.id,
                dir: m.dir,
                reason: m.reason ?? LANE_WEDGE_DISTRESS_REASON,
                ts: deps.now(),
              });
            }
            for (const c of laneDecision.clear) {
              deps.clearSharedWedgeDistress?.(
                claimlessDistressClear(
                  snapshot.dispatchFailureFences,
                  c.id,
                  c.dir,
                ),
              );
            }
            // Parts-6 progress actor: integrate a blocking done rib into each sibling-
            // source-gate HELD dependent's EXISTING stale lane so the gate clears — the
            // deadlock the target-selection seam introduces. Producer-only git under the
            // commit-work flock; a live resolver / owner / claim (via the shared lane-
            // liveness probe) leaves the target UNTOUCHED. Failures + conflicts feed the
            // SAME dispatch_failures rail recover uses (transient `work::<taskId>` rows /
            // `worktree-merge-conflict` incidents); a successful integration arms the
            // reconcile nudge, since its external git progress bumps no data_version.
            if (
              deps.worktree.progressActor !== undefined &&
              (snapshot.deferredSiblingSources?.size ?? 0) > 0
            ) {
              const actor = await deps.worktree.progressActor(
                new Set(snapshot.deferredSiblingSources?.keys() ?? []),
                snapshot.epics,
                snapshot.worktreeRepoByEpicId,
                snapshot.worktreesRoot,
                laneMaintenanceProbe,
                (epicId) => {
                  for (const key of snapshot.claimedIncidentKeys ?? []) {
                    if (
                      key === dispatchKey("close", epicId) ||
                      key.startsWith(`work::${epicId}.`)
                    ) {
                      return true;
                    }
                  }
                  return false;
                },
              );
              for (const f of actor.failures) {
                deps.emitDispatchFailed({
                  verb: "work",
                  id: f.taskId,
                  reason: f.reason,
                  dir: f.dir,
                  conflictedFiles: null,
                  ts: deps.now(),
                });
              }
              for (const e of actor.escalations) {
                deps.emitDispatchFailed({
                  verb: "work",
                  id: e.taskId,
                  reason: e.reason,
                  dir: e.dir,
                  conflictedFiles: e.conflictedFiles,
                  ts: deps.now(),
                });
              }
              if (actor.integratedAny) {
                deps.nudgeReconcileSoon?.();
              }
            }
          } catch (err) {
            console.error(
              "[autopilot-worker] worktree recovery threw (non-fatal):",
              err,
            );
          }
        }
        // Stale-base lane distress escalation (fn-1127): the producer probe (gated on
        // worktree mode, on the snapshot) flagged each already-cut lane whose satisfied
        // same-repo upstream's landed work is DEFINITIVELY missing from its base.
        // DETECTION-ONLY — never touches the merge-gate cut-deferral, never enriches the
        // worker-authored DEPENDENCY_BLOCKED prose. A lane stale past the grace mints a
        // per-(epic,repo) distress row; the level-clear off the OPEN distress ids fires
        // the cycle the probe stops reporting it stale (re-based past the upstream or
        // torn down). Runs OUTSIDE the recover-pass block (its input is the snapshot,
        // not `deps.worktree`), gated on worktree mode + not-paused (a synthetic write,
        // mirroring the recover escalations); the level-trigger resumes on unpause. The
        // SAME verb-neutral distress channel as the shared-checkout / lane rows — the
        // `id` carries the `stale-base-lane` prefix, so main mints/clears the right
        // synthetic-verb row. No-op when the escalation deps are absent (fake-deps).
        if (snapshot.worktreeMode && !state.paused) {
          try {
            const staleObs = new Map<string, StaleBaseLaneObservation>();
            const refreshing = new Set(
              (snapshot.baseDriftEntries ?? []).map(
                (e) => `${e.epic_id}\0${e.repo_dir}`,
              ),
            );
            for (const e of snapshot.staleBaseLaneEntries ?? []) {
              // Base drift is actively remediated by the refresh producer; do not
              // also age the detection-only stale-base distress in this cycle.
              if (refreshing.has(`${e.epic_id}\0${e.repo_dir}`)) continue;
              const id = staleBaseLaneDistressId(e.epic_id, e.repo_dir);
              // First entry per id wins (the probe already dedupes per (epic,repo)).
              if (!staleObs.has(id)) {
                staleObs.set(id, { epicId: e.epic_id, repoDir: e.repo_dir });
              }
            }
            const staleDecision = staleBaseLaneTracker.step({
              stale: staleObs,
              openDistressIds: snapshot.staleBaseDistressIds ?? new Set(),
              nowSec: deps.now(),
            });
            for (const m of staleDecision.mint) {
              deps.emitSharedWedgeDistress?.({
                id: m.id,
                dir: m.dir,
                reason: m.reason ?? STALE_BASE_DISTRESS_REASON,
                ts: deps.now(),
              });
            }
            for (const c of staleDecision.clear) {
              deps.clearSharedWedgeDistress?.(
                claimlessDistressClear(
                  snapshot.dispatchFailureFences,
                  c.id,
                  c.dir,
                ),
              );
            }
          } catch (err) {
            console.error(
              "[autopilot-worker] stale-base lane distress step threw (non-fatal):",
              err,
            );
          }
        }
        // Duplicate-epic-number distress escalation (fn-1193): a PURE per-cycle probe over the
        // snapshot's epics detects two non-done epics in one project sharing an `epic_number`
        // (a number that slipped past the mint guard). O(open epics), no git, no fold, no new
        // schema — runs every cycle (NOT gated on worktree mode), gated on !paused (a synthetic
        // write, mirroring the sibling escalations; the level-trigger resumes on unpause). A
        // duplicate past the grace mints a per-(project,number) distress row; the level-clear
        // off the OPEN distress ids fires the cycle the probe stops reporting it (renumbered,
        // removed, or gone done). The SAME verb-neutral distress channel — the `id` carries the
        // `dup-epic-number` prefix, so main mints/clears the right synthetic-verb row.
        if (!state.paused) {
          try {
            const dupObs = new Map<string, DupEpicNumberObservation>();
            for (const g of computeDuplicateEpicNumberGroups(snapshot.epics)) {
              const id = dupEpicNumberDistressId(g.projectDir, g.epicNumber);
              if (!dupObs.has(id)) {
                dupObs.set(id, {
                  projectDir: g.projectDir,
                  epicNumber: g.epicNumber,
                  epicIds: g.epicIds,
                });
              }
            }
            const dupDecision = dupEpicNumberTracker.step({
              duplicates: dupObs,
              openDistressIds: snapshot.dupEpicNumberDistressIds ?? new Set(),
              nowSec: deps.now(),
            });
            for (const m of dupDecision.mint) {
              deps.emitSharedWedgeDistress?.({
                id: m.id,
                dir: m.dir,
                reason: m.reason ?? DUP_EPIC_NUMBER_DISTRESS_REASON,
                ts: deps.now(),
              });
            }
            for (const c of dupDecision.clear) {
              deps.clearSharedWedgeDistress?.(
                claimlessDistressClear(
                  snapshot.dispatchFailureFences,
                  c.id,
                  c.dir,
                ),
              );
            }
          } catch (err) {
            console.error(
              "[autopilot-worker] duplicate-epic-number distress step threw (non-fatal):",
              err,
            );
          }
        }
        // Shared-checkout DESYNC distress escalation (fn-1169): a base→default merge
        // (finalize / recover pass-2) that advanced the ref but left the shared checkout
        // trailing seeds `desyncSeedDirs` via the driver's onResyncSkipped sink. Each
        // cycle, UNION the in-memory seeds with the OPEN desync row set (which re-seeds the
        // latch across a restart) and probe each WATCHED dir for content-carries-HEAD
        // evidence: a still-desynced dir feeds the grace tracker (mint after grace, blocker
        // named), a synced dir is pruned from the seed set + level-clears any open row.
        // EVENT-SEEDED mint + per-cycle content clear — a human's ordinary edit (no skip
        // event) never enters `watched`, so it never mints. A synthetic write, so gated on
        // !paused (the level-trigger resumes on unpause); the probe runs only over the
        // bounded watched set, so a healthy board adds ZERO git spawns. The SAME
        // verb-neutral distress channel as the shared-checkout / lane / stale rows.
        if (!state.paused) {
          try {
            const openDesyncDirs =
              snapshot.sharedDesyncDistressDirs ?? new Set<string>();
            const watched = new Set<string>([
              ...desyncSeedDirs,
              ...openDesyncDirs,
            ]);
            if (watched.size > 0) {
              const desynced = new Map<string, string>();
              for (const dir of watched) {
                const verdict = await probeSharedCheckoutDesync(dir, gitExec);
                if (verdict.desynced) {
                  desynced.set(dir, verdict.blocker);
                } else {
                  // Content-carries HEAD → episode closed: drop the seed so a future
                  // re-skip waits a fresh grace; any open row level-clears below.
                  desyncSeedDirs.delete(dir);
                }
              }
              const desyncDecision = sharedDesyncTracker.step({
                desynced,
                openDistressDirs: openDesyncDirs,
                nowSec: deps.now(),
              });
              for (const m of desyncDecision.mint) {
                deps.emitSharedWedgeDistress?.({
                  id: m.id,
                  dir: m.dir,
                  reason: m.reason ?? SHARED_DESYNC_DISTRESS_REASON,
                  ts: deps.now(),
                });
              }
              for (const c of desyncDecision.clear) {
                deps.clearSharedWedgeDistress?.(
                  claimlessDistressClear(
                    snapshot.dispatchFailureFences,
                    c.id,
                    c.dir,
                  ),
                );
              }
            }
          } catch (err) {
            console.error(
              "[autopilot-worker] shared-checkout desync distress step threw (non-fatal):",
              err,
            );
          }
        }
        // Stuck-sentinel ORPHAN reconciliation (fn-1200.2, ADR-0013 amendment): an
        // ack-only sentinel row (layer 3) whose referenced job is genuinely ABSENT
        // from the `jobs` table has lost its evidentiary value — the fn-1200
        // incident found five of seven open sentinel rows pointing at exactly this.
        // Read RAW off the writable connection's own tables (never the default-
        // filtered `jobs` collection `snapshot.jobs` draws from, which hides
        // terminal rows and would misclassify a job that finished NORMALLY as
        // "absent" — a live-job row in ANY state, including `ended`/`killed`, stays
        // untouched under the unchanged operator-ack-only discipline). A synthetic
        // write (`DispatchCleared`), so gated on !paused like the sibling distress
        // sweeps; a trace line precedes every clear so the evidence trail the
        // ack-only discipline exists to preserve survives the GC.
        if (!state.paused) {
          try {
            const openSentinelIds = new Set<string>();
            const sentinelFences = new Map<string, DispatchFailureFence>();
            for (const row of db
              .query(
                "SELECT id, attempt_id, instance_event_id FROM dispatch_failures WHERE verb = ?",
              )
              .all(STUCK_SENTINEL_DISTRESS_VERB) as {
              id: string;
              attempt_id: number | null;
              instance_event_id: number | null;
            }[]) {
              if (
                isStuckSentinelDistressKey(STUCK_SENTINEL_DISTRESS_VERB, row.id)
              ) {
                openSentinelIds.add(row.id);
                sentinelFences.set(row.id, row);
              }
            }
            if (openSentinelIds.size > 0) {
              const liveJobIds = new Set<string>();
              for (const row of db.query("SELECT job_id FROM jobs").all() as {
                job_id: string;
              }[]) {
                liveJobIds.add(row.job_id);
              }
              for (const id of stuckSentinelOrphansToClear(
                openSentinelIds,
                liveJobIds,
              )) {
                console.error(
                  `[autopilot-worker] stuck-sentinel orphan GC: ${STUCK_SENTINEL_DISTRESS_VERB}::${id} — job_id=${
                    stuckSentinelJobId(id) ?? id
                  } absent from the jobs table (evidence preserved in this trace line)`,
                );
                const fence = sentinelFences.get(id);
                deps.emitDispatchCleared({
                  verb: STUCK_SENTINEL_DISTRESS_VERB,
                  id,
                  expected_attempt_id: null,
                  expected_instance_event_id: fence?.instance_event_id ?? null,
                });
              }
            }
          } catch (err) {
            console.error(
              "[autopilot-worker] stuck-sentinel orphan reconciliation threw (non-fatal):",
              err,
            );
          }
        }
        // Wrapped-delegation advisory (task .4): a producer-side, fs-touching
        // probe — never a fold — flagging a DONE wrapped-cell task whose
        // provider-leg result envelope never appeared. DETECT-ONLY: logs a
        // coalesced advisory line, mints no sticky / dispatch_failures row, and
        // never blocks a dispatch. Runs every cycle regardless of paused — it
        // reads, never writes.
        try {
          for (const skip of findWrappedDelegationSkips(snapshot)) {
            logWrappedDelegationSkip(skip);
          }
        } catch (err) {
          console.error(
            "[autopilot-worker] wrapped-delegation-skip probe threw (non-fatal):",
            err,
          );
        }
        // Step the fatal-audit lift STATE MACHINE (persistent producer state), keyed to the
        // OPEN synthetic-row instance — so an operator `retry_dispatch` (open→gone) is
        // realized even when the LATEST receipt is malformed/unreadable, and the lift is a
        // ONE-SHOT (armed → consumed on launch), never a per-cycle level-trigger.
        const fatalAuditStep = stepFatalAuditFenceMemo(
          snapshot.openFatalAuditInstanceByEpic ?? new Map<string, number>(),
          state.fatalAuditFenceMemo,
        );
        snapshot.fatalAuditFenceLifted = fatalAuditStep.lifted;
        // The CONSUMED set (the one retry-launch already fired) is a close WITHHOLD arm — so
        // reconcile withholds a consumed epic instead of planning a SECOND close, even when
        // the durable receipt momentarily reads UNKNOWN. Derived from the memo state at cycle
        // start (a prior cycle's launch-seam consume).
        const fatalAuditConsumed = new Set<string>();
        for (const [epicId, entry] of state.fatalAuditFenceMemo) {
          if (entry.lift === "consumed") fatalAuditConsumed.add(epicId);
        }
        snapshot.fatalAuditConsumedEpicIds = fatalAuditConsumed;
        // An operator `retry_dispatch` clears the row through the reducer, NOT
        // `emitDispatchCleared` → the change-gate never saw the clear and would suppress an
        // identical same-finding re-mint to the watermark (~15m). Reset the gate ONCE, on the
        // observed open→gone transition, so the fresh re-halt re-mint is emitted immediately.
        for (const epicId of fatalAuditStep.toForget) {
          dispatchFailedGate.forget("close", fatalAuditDispatchId(epicId));
        }
        const decision = reconcile(snapshot, state, deps.now());
        // The one-shot lift is CONSUMED at the exact launch side-effect seam inside
        // `runReconcileCycle` (`ok` / `aborted-postlaunch` only) — NEVER here on the
        // pre-launch `decision.launches`, which every runtime skip (preclose/provision defer,
        // abort, in-flight, cwd/cell reject, no-claim, …) would falsely consume. GC the memo
        // for positively-resolved epics (the fatal episode is over). Visible fatal state after
        // a lift is restored by the ordinary `currentFatalAuditEpicIds` mint path (durable
        // receipt fence), not a pre-launch "attempt ended" fabrication.
        for (const epicId of snapshot.fatalAuditResolvedEpicIds ?? []) {
          state.fatalAuditFenceMemo.delete(epicId);
        }
        // Map the slot evidence through the ONE tri-state seam: a trusted expiry arms the edge;
        // a trusted no-candidate (or paused) disarms; a DEGRADED PANE probe (untrusted null,
        // distinct from readinessDegraded's DB path above) preserves the wake / bounded retry
        // instead of a false disarm. `readinessDegraded` is false here — it `continue`d above.
        latestSlotArm = slotWakeArm({
          paused: state.paused,
          degraded: false,
          expiryAt: decision.slotNextExpiryAt,
          expiryTrusted: decision.slotNextExpiryTrusted,
        });
        // Reap the union of the done-monitor candidates and this cycle's
        // exact occupancy targets. Slot targets take precedence for a shared job
        // because their stopped proof needs no monitor-staleness inference. The
        // act-time jobs read plus the process probe adjacent to each signal prevent
        // a later working transition or recycled pid from inheriting authority.
        if (!state.paused) {
          try {
            const reapCandidates = new Map<string, ReapCandidate>();
            for (const candidate of snapshot.zombieSessionCandidates) {
              reapCandidates.set(candidate.jobId, {
                ...candidate,
                reapClass: "monitor",
                immediate: false,
                paneId: null,
              });
            }
            for (const signal of decision.slotOccupancy) {
              const target = signal.reapTarget;
              if (target == null) continue;
              const job = snapshot.jobs.get(target.jobId);
              if (job == null) continue;
              reapCandidates.set(target.jobId, {
                jobId: target.jobId,
                dir: signal.dir ?? "",
                updatedAt: job.updated_at,
                reapClass: "occupancy",
                immediate: target.immediate,
                paneId: target.paneId,
              });
            }

            // Once TERM is sent, retain that exact ladder until current evidence
            // proves the stopped episode ended. A transient degraded pane probe may
            // pause the occupancy pass, but it must not erase the queued KILL.
            for (const [jobId, pending] of pendingReapTerms) {
              const job = snapshot.jobs.get(jobId);
              if (job == null || job.state !== "stopped") {
                pendingReapTerms.delete(jobId);
                zombieKillSent.delete(jobId);
                continue;
              }
              if (
                !reapCandidates.has(jobId) &&
                (pending.candidate.reapClass !== "occupancy" ||
                  (snapshot.livePaneIds !== null &&
                    snapshot.paneCommandById !== null))
              ) {
                reapCandidates.set(jobId, pending.candidate);
              }
            }
            for (const jobId of zombieKillSent) {
              const job = snapshot.jobs.get(jobId);
              if (job == null || job.state !== "stopped") {
                zombieKillSent.delete(jobId);
                pendingReapTerms.delete(jobId);
              }
            }
            for (const action of snapshot.zombieSessionClearActions) {
              deps.clearSharedWedgeDistress?.(
                claimlessDistressClear(
                  snapshot.dispatchFailureFences,
                  action.id,
                  action.dir,
                ),
              );
            }

            const ordered = [...reapCandidates.values()].sort((a, b) => {
              const aPending = pendingReapTerms.has(a.jobId);
              const bPending = pendingReapTerms.has(b.jobId);
              if (aPending !== bPending) return aPending ? -1 : 1;
              if (a.reapClass !== b.reapClass) {
                return a.reapClass === "occupancy" ? -1 : 1;
              }
              return a.jobId.localeCompare(b.jobId);
            });
            for (const candidate of ordered.slice(
              0,
              SLOT_RECLAIM_MAX_PER_SWEEP,
            )) {
              const job = db
                .query(
                  `SELECT job_id, state, pid, start_time, plan_verb, plan_ref,
                          backend_exec_pane_id, updated_at
                     FROM jobs WHERE job_id = ?`,
                )
                .get(candidate.jobId) as {
                job_id: string;
                state: string;
                pid: number | null;
                start_time: string | null;
                plan_verb: string | null;
                plan_ref: string | null;
                backend_exec_pane_id: string | null;
                updated_at: number;
              } | null;
              if (job == null) continue;
              if (
                candidate.paneId != null &&
                job.backend_exec_pane_id !== candidate.paneId
              ) {
                pendingReapTerms.delete(job.job_id);
                zombieKillSent.delete(job.job_id);
                continue;
              }

              let pendingTerm = pendingReapTerms.get(job.job_id);
              if (
                pendingTerm !== undefined &&
                job.updated_at > pendingTerm.stoppedAt
              ) {
                // A newer fold may include a working→stopped episode. Restart the
                // ladder rather than inheriting kill authority.
                pendingReapTerms.delete(job.job_id);
                zombieKillSent.delete(job.job_id);
                pendingTerm = undefined;
              }

              let reapDecision: ZombieSessionReaperDecision;
              if (zombieKillSent.has(candidate.jobId)) {
                reapDecision = { action: "page", reason: "signal-failed" };
              } else {
                reapDecision = runZombieSessionReaperStep(
                  {
                    jobState: job.state,
                    taskDone: candidate.reapClass === "monitor",
                    pid: job.pid,
                    storedStartTime: job.start_time,
                    updatedAt:
                      candidate.reapClass === "occupancy"
                        ? job.updated_at
                        : candidate.updatedAt,
                    nowSec: deps.now(),
                    activity: snapshot.harnessActivityByJobId?.get(job.job_id),
                    termSentAt: pendingTerm?.sentAt,
                    thresholdSec:
                      candidate.reapClass === "occupancy"
                        ? SLOT_RECLAIM_GRACE_SEC
                        : undefined,
                    reapClass: candidate.reapClass,
                    immediate: candidate.immediate,
                  },
                  {
                    probe: probeZombieProcess,
                    signal: (pid, signal) => process.kill(pid, signal),
                  },
                  job.plan_verb,
                  job.plan_ref,
                );
              }
              if (reapDecision.action === "signal") {
                if (reapDecision.signal === "SIGTERM") {
                  pendingReapTerms.set(job.job_id, {
                    sentAt: deps.now(),
                    stoppedAt: job.updated_at,
                    candidate,
                  });
                  const timer = setTimeout(
                    () => requestCycle(),
                    ZOMBIE_SESSION_TERM_GRACE_SEC * 1000,
                  );
                  timer.unref();
                } else {
                  zombieKillSent.add(job.job_id);
                  const timer = setTimeout(() => requestCycle(), 1_000);
                  timer.unref();
                }
                continue;
              }
              clearDeadZombieSessionMarker(job.job_id, reapDecision);
              const paneId = candidate.paneId;
              const paneOnlyReap =
                candidate.reapClass === "occupancy" &&
                paneId !== null &&
                ((reapDecision.action === "none" &&
                  reapDecision.reason === "pid-dead") ||
                  (reapDecision.action === "page" &&
                    reapDecision.reason === "pid-unproven" &&
                    isBareShellCommand(snapshot.paneCommandById?.get(paneId))));
              if (paneOnlyReap && paneId !== null) {
                const result = await paneOps.killWindow(paneId);
                if (!result.ok && result.error) {
                  noteLine(
                    `[autopilot-worker] slot residual-pane reap: ${result.error}`,
                  );
                }
                pendingReapTerms.delete(job.job_id);
                zombieKillSent.delete(job.job_id);
                continue;
              }
              if (
                reapDecision.action === "none" &&
                reapDecision.reason === "outside-scope"
              ) {
                pendingReapTerms.delete(job.job_id);
                zombieKillSent.delete(job.job_id);
              }
              if (
                reapDecision.action === "page" &&
                !snapshot.openZombieSessionDistresses.has(
                  zombieSessionDistressId(job.job_id),
                )
              ) {
                const source =
                  candidate.reapClass === "occupancy"
                    ? "occupancy-holding"
                    : "done-stamped";
                deps.emitSharedWedgeDistress?.({
                  id: zombieSessionDistressId(job.job_id),
                  dir: candidate.dir,
                  reason:
                    `${ZOMBIE_SESSION_DISTRESS_REASON}: stopped ${source} ` +
                    `session ${job.job_id} could not be safely reaped ` +
                    `(${reapDecision.reason}) — inspect the process identity`,
                  ts: deps.now(),
                });
              }
            }
          } catch (err) {
            console.error(
              "[autopilot-worker] zombie-session reaper step threw (non-fatal):",
              err,
            );
          }
        }
        // The withhold rail publishes INSIDE `runReconcileCycle`, at the
        // classification-completion point (after the launch pass populated the
        // producer-side ready-launch holds into `decision.withholds`, joining the pure
        // core's holds), NOT here. That placement is load-bearing: a cycle that aborts
        // or throws BEFORE completing classification leaves a PARTIAL `decision.withholds`
        // whose absent producer keys must NOT be replace-merged as authoritative clears
        // — publishing only on positive completion preserves the prior frame unchanged,
        // so a standing lane-provision hold never silently drops and re-emits as a
        // phantom transition next cycle.
        await runReconcileCycle(
          decision,
          state,
          liveDispatches,
          shell,
          // The pause-scoped signal — captured per-cycle so a mid-cycle
          // pause-abort + fresh controller doesn't retroactively un-abort this run.
          cycleController.signal,
          deps,
          // The producer live-job dirty attribution (worktree mode only) — threaded
          // into every `provision` so the fan-in pre-merge clean never discards dirt a
          // running worker owns; `null` (a failed read) → do-not-discard.
          snapshot.liveAttributedDirtyByWorktree ?? null,
          snapshot.dispatchFailureFences,
          laneMaintenanceProbe,
          { state: withholdFrameState },
        );
        // PERIODIC ORIGIN-CONTAINMENT reconcile — runs LAST, AFTER recover + finalize have
        // pushed for their epics this cycle (owner-priority: their pushes stamped the
        // per-cycle guard, so a repo an owner already pushed is skipped here — exactly ONE
        // push attempt per repo per cycle, finalize/recover keeping streak/sticky
        // ownership). Fires the same push path ONLY on positive evidence for a repo NO
        // owner touched — the no-owner-left gap where origin silently freezes. Its OWN
        // per-repo distress fallback pages a repo sustained-stuck (repeated push
        // timeout/failure, or a true divergence keeper cannot reconcile without a human),
        // cleared on positive containment. SCOPE: worktree-finalize publication hardening
        // ONLY — gated on `snapshot.worktreeMode`; a mode-OFF board commits directly on the
        // shared default with no keeper push path at all (a pre-existing design boundary,
        // reported separately to the human), so the sweep is inert there. Producer-only; a
        // git error degrades to a defer and never wedges the cycle.
        const openContainmentDirs =
          snapshot.originContainmentDistressDirs ?? new Set<string>();
        if (
          deps.worktree?.reconcileOrigin &&
          originContainmentSweepEnabled(
            snapshot.worktreeMode,
            state.paused,
            true,
          )
        ) {
          try {
            const openRows = snapshot.openRecoverRows ?? [];
            // BLOCKER 3a: UNION the durable open-row dirs into the sweep set so a repo whose
            // row outlived its epic/git-status roots is still re-probed (else it is never
            // cleared). reposForRecovery de-dupes; the open dirs re-seed after a restart.
            const containmentRepos = reposForRecovery(
              snapshot.epics,
              snapshot.worktreeRepoByEpicId,
              [
                ...(snapshot.worktreeKnownRoots ?? []),
                ...openRows.map((row) => row.dir),
                ...openContainmentDirs,
              ],
            );
            const unhealthy = new Map<string, string>();
            const healthy = new Set<string>();
            // NEUTRAL-retryable dirs (a `deferred` inconclusive probe, NEVER the `owner-attempt`
            // guard): they mint nothing but still need a bounded retry wake so a FIRST-cycle
            // unknown on a quiescent DB re-probes rather than going dark.
            const neutralRetry = new Set<string>();
            for (const {
              dir,
              defaultBranch,
              result,
            } of await deps.worktree.reconcileOrigin(containmentRepos)) {
              if (result.kind === "pushed") {
                console.error(
                  `[autopilot-worker] origin-containment: re-pushed ${dir} — origin was behind local default`,
                );
              }
              const health = classifyOriginContainment(
                dir,
                defaultBranch,
                result,
              );
              if (health.class === "healthy") {
                healthy.add(dir);
              } else if (health.class === "actionable") {
                unhealthy.set(dir, health.reason);
              } else if (result.kind === "deferred") {
                neutralRetry.add(dir);
              }
            }
            const containmentDecision = originContainmentStuckTracker.step({
              unhealthy,
              healthy,
              neutralRetry,
              openDistressDirs: openContainmentDirs,
              nowSec: deps.now(),
            });
            for (const m of containmentDecision.mint) {
              deps.emitSharedWedgeDistress?.({
                id: m.id,
                dir: m.dir,
                reason: m.reason ?? ORIGIN_CONTAINMENT_DISTRESS_REASON,
                ts: deps.now(),
              });
            }
            for (const c of containmentDecision.clear) {
              deps.clearSharedWedgeDistress?.(
                claimlessDistressClear(
                  snapshot.dispatchFailureFences,
                  c.id,
                  c.dir,
                ),
              );
            }
            // BLOCKER 2: a TRUSTWORTHY sweep — hand the earliest episode/retry deadline to the
            // coalesced waker (`{ at }`), or `idle` when nothing is stuck/open, so a quiescent DB
            // still crosses the grace + re-probes an open row (armed in finally). A sweep that
            // THREW leaves the per-iteration `unknown` (the catch below) so the prior edge stands.
            latestContainmentArm =
              containmentDecision.nextWakeAt !== null
                ? { at: containmentDecision.nextWakeAt }
                : "idle";
          } catch (err) {
            console.error(
              "[autopilot-worker] origin-containment sweep threw (non-fatal):",
              err,
            );
          }
        } else {
          // The sweep is disabled this cycle. A POSITIVE worktree-mode disable retires the
          // feature's own rows (a deliberately-disabled feature must not strand a paging jam) —
          // level-clear every OPEN row, keyed straight off the durable open set (the in-memory
          // latch is irrelevant). Fires on an explicit `false` REGARDLESS of paused (retiring an
          // obsolete feature-owned row is observational hygiene — pause suppresses pushes, not
          // this); empty on an unknown/degraded mode read, so a live jam is never dismissed.
          const modeOffClears = originContainmentModeOffClears(
            snapshot.worktreeMode,
            openContainmentDirs,
          );
          for (const { id, dir } of modeOffClears) {
            deps.clearSharedWedgeDistress?.(
              claimlessDistressClear(snapshot.dispatchFailureFences, id, dir),
            );
          }
          // A POSITIVE disable (mode explicitly false, paused or not) must RESET the in-memory
          // episode latch alongside the durable row clears — else a re-enable mints immediately
          // from stale disabled-time accounting, or a minted-then-cleared episode never mints
          // again.
          if (snapshot.worktreeMode === false) {
            originContainmentStuckTracker.reset();
          }
          // A DISABLED sweep (mode-off / paused / no driver) is a positive no-candidate — disarm
          // the containment edge; `play` / a mode flip delivers the explicit re-kick.
          latestContainmentArm = "idle";
        }
      } while (wakePending && !shutdown);
    } catch (err) {
      // A reconcile/dispatch throw must not wedge the wake loop — log and let
      // the next pulse re-drive (per-launch failures are funnelled to
      // DispatchFailed inside `confirmRunning`; this is the snapshot-load /
      // unexpected-throw backstop).
      console.error("[autopilot-worker] reconcile cycle threw:", err);
    } finally {
      cycleRunning = false;
      // A parts-6 progress-actor integration this cycle made external git progress that
      // bumps NO data_version — force an IMMEDIATE re-tick so the now-cleared sibling-
      // source gate re-evaluates at once (the next cycle re-derives the real slot edge).
      if (progressActorNudged) {
        progressActorNudged = false;
        latestSlotArm = { at: wakeClock.now() };
      }
      // Re-arm both coalesced wakes from THIS cycle's THREE-STATE intent: a definite deadline
      // arms the edge, a positive no-candidate disarms, and an UNTRUSTWORTHY cycle (a throw
      // leaves the per-iteration `unknown`, a degraded probe `continue`d to it) preserves the
      // prior edge / arms one bounded retry — never erasing a live clock edge on a transient
      // null. Restart-safe: the boot cycle re-derives both from the durable projections.
      applyWakeArm(stoppedExpiryWaker, latestSlotArm);
      applyWakeArm(containmentExpiryWaker, latestContainmentArm);
    }
  };

  // Periodic backstop-rollup flush — checkpoint the denominator so the metric
  // survives a crash without a line per no-op confirm. Final-flushed on
  // watch-loop exit below.
  const rollupTimer = setInterval(() => {
    if (shutdown) return;
    try {
      flushBackstopRollups();
    } catch (err) {
      console.error("[autopilot-worker] backstop rollup flush failed:", err);
    }
  }, BACKSTOP_ROLLUP_FLUSH_MS);
  const terminalPaneGcTimer = setInterval(() => {
    if (!shutdown) void driveTerminalPaneSweep();
  }, TERMINAL_PANE_TEARDOWN_IDLE_MS);

  // Bind the unpause/boot kick now that `driveCycle` exists, then run one cycle.
  // The boot cycle is a no-op for launches while paused; the play-edge kick
  // dispatches ready work the instant the human unpauses.
  requestCycle = () => {
    void driveCycle();
  };
  requestCycle();

  watchLoop(
    db,
    () => {
      void driveCycle();
    },
    () => shutdown,
    data.pollMs,
  )
    .then(() => {
      clearInterval(rollupTimer);
      clearInterval(terminalPaneGcTimer);
      stoppedExpiryWaker.disarm();
      containmentExpiryWaker.disarm();
      // Final rollup flush so the on-shutdown denominator lands before exit.
      flushBackstopRollups();
      closeDb();
      process.exit(0);
    })
    .catch((err) => {
      console.error("[autopilot-worker] watch loop crashed:", err);
      clearInterval(rollupTimer);
      clearInterval(terminalPaneGcTimer);
      stoppedExpiryWaker.disarm();
      containmentExpiryWaker.disarm();
      flushBackstopRollups();
      closeDb();
      process.exit(1);
    });
}

// Only run inside a real Worker spawned AS the autopilot (`role: "autopilot"`).
// A plain import on the main thread is inert; an import from ANOTHER worker
// module that pulls `loadReconcileSnapshot` from here must NOT boot a
// stowaway reconciler in that thread — the role gate enforces that.
if (
  !isMainThread &&
  (workerData as AutopilotWorkerData | undefined)?.role === "autopilot"
) {
  main();
}

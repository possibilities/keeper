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

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { ConfigError, loadPresetCatalog, type Preset } from "./agent/config";
import { matrixConfigPath } from "./agent/matrix";
import { computeEligibleEpics } from "./armed-closure";
import { epicStarted } from "./await-conditions";
import {
  BackstopCounters,
  type BackstopMessage,
  buildTimeoutRecord,
} from "./backstop-telemetry";
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
import {
  assertNever,
  DUP_EPIC_NUMBER_DISTRESS_ID_PREFIX,
  DUP_EPIC_NUMBER_DISTRESS_REASON,
  isDupEpicNumberDistressKey,
  isLaneWedgeDistressKey,
  isSharedDesyncDistressKey,
  isSharedDirtyDistressKey,
  isSharedWedgeDistressKey,
  isSlotOccupancyReason,
  isStaleBaseDistressKey,
  isStuckSentinelDistressKey,
  isWorktreeLanePremergeReason,
  LANE_WEDGE_DISTRESS_ID_PREFIX,
  LANE_WEDGE_DISTRESS_REASON,
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
  WORKTREE_LANE_PREMERGE_REASON_PREFIX,
} from "./dispatch-failure-key";
import {
  createTmuxPaneOps,
  keeperAgentLaunch,
  type LaunchSpec,
  MANAGED_EXEC_SESSION,
  type PaneInfo,
} from "./exec-backend";
import { localBranchExists, memoizedNullableGitToplevel } from "./git-toplevel";
import { loadReadinessInputs } from "./readiness-inputs";
import {
  buildPlannedLaunchSpec,
  buildWorkerCommand,
  type DispatchKey,
  dispatchKey,
  type EpicRecoverVerdict,
  epicHasActiveResolver,
  FINALIZER_GUARD_S,
  isFinalizerVerb,
  isStoppedJobLive,
  KEEPER_ROOT,
  type LaneMergedEntry,
  type PlannedLaunch,
  prepareWorktreeGeometry,
  REDISPATCH_COOLDOWN_S,
  type ReconcileDecision,
  type ReconcileSnapshot,
  type ReconcileState,
  reconcile,
  recoverFailureDispatchId,
  type StaleBaseLaneEntry,
  type Verb,
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
  worktreeRecoverDispatchId,
} from "./reconcile-core";
import { isPidAlive, runQuery } from "./server-worker";
import type { Epic, Job } from "./types";
import { watchLoop } from "./wake-worker";
import {
  defaultRouteProbe,
  defaultShadowingWorkProbe,
  resolveWorkerCell,
} from "./worker-cell";
import {
  ELIGIBLE_REASON,
  memoizedAssessRepo,
  type WorktreeEligibility,
} from "./worktree-eligibility";
import {
  type EpicLaneBranchSet,
  epicIdFromKeeperLaneEntry,
  abortInterruptedMerge as gitAbortInterruptedMerge,
  baseMergeLockPath as gitBaseMergeLockPath,
  branchExists as gitBranchExists,
  classifyLinkedWorktree as gitClassifyLinkedWorktree,
  commitWorkLockPath as gitCommitWorkLockPath,
  currentBranch as gitCurrentBranch,
  deleteBranch as gitDeleteBranch,
  ensureWorktree as gitEnsureWorktree,
  enumerateEpicLaneBranches as gitEnumerateEpicLaneBranches,
  isAncestorOf as gitIsAncestorOf,
  listEpicBaseBranches as gitListEpicBaseBranches,
  listEpicLaneBranches as gitListEpicLaneBranches,
  listWorktrees as gitListWorktrees,
  losslessPremergeClean as gitLosslessPremergeClean,
  mergeBranchInto as gitMergeBranchInto,
  mergeReadiness as gitMergeReadiness,
  pruneWorktreeHusk as gitPruneWorktreeHusk,
  pruneWorktrees as gitPruneWorktrees,
  remotePushFastForwardable as gitRemotePushFastForwardable,
  removeWorktree as gitRemoveWorktree,
  resolveDefaultBranch as gitResolveDefaultBranch,
  supportsMergeTreeWriteTree as gitSupportsMergeTreeWriteTree,
  isKeeperLaneEntry,
  type LockAcquirer,
  type MergeResult,
  shortBranchName,
  type WorktreeEntry,
} from "./worktree-git";
import { baseBranchFor, repoDirHash, worktreePathFor } from "./worktree-plan";

// The dispatch-failure vocabulary + typed row router live in the dep-free
// `./dispatch-failure-key` leaf; re-exported here so every existing
// `from "./autopilot-worker"` import (tests, daemon) keeps resolving. The snapshot
// loader routes recover/finalize failure rows through `routeDispatchFailure`.
export {
  DUP_EPIC_NUMBER_DISTRESS_ID_PREFIX,
  DUP_EPIC_NUMBER_DISTRESS_REASON,
  DUP_EPIC_NUMBER_DISTRESS_VERB,
  isDupEpicNumberDistressKey,
  isLaneWedgeDistressKey,
  isSharedDesyncDistressKey,
  isSharedDirtyDistressKey,
  isSharedWedgeDistressKey,
  isSlotOccupancyReason,
  isStaleBaseDistressKey,
  isStuckSentinelDistressKey,
  isWorktreeLanePremergeReason,
  isWorktreeRecoverReason,
  LANE_WEDGE_DISTRESS_ID_PREFIX,
  LANE_WEDGE_DISTRESS_REASON,
  LANE_WEDGE_DISTRESS_VERB,
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
  WORKTREE_RECOVER_REASON_PREFIX,
} from "./dispatch-failure-key";
export type {
  DispatchKey,
  EpicRecoverVerdict,
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
  buildPlannedLaunchSpec,
  buildWorkerCommand,
  classifyResolverOutcome,
  closerJobFinished,
  computeSlotOccupancy,
  dispatchKey,
  epicHasActiveResolver,
  FINALIZER_GUARD_S,
  isBareShellCommand,
  isEpicInFlight,
  isFinalizerGuarded,
  isFinalizerVerb,
  isInCooldown,
  isOccupyingJob,
  KEEPER_ROOT,
  prepareWorktreeGeometry,
  REDISPATCH_COOLDOWN_S,
  reconcile,
  recoverFailureDispatchId,
  SLOT_RECLAIM_GRACE_SEC,
  verbForVerdict,
  WORKER_EFFORT,
  WORKER_MODEL,
  workerCellPluginDir,
  worktreeRecoverDispatchId,
  worktreeRecoverEpicDispatchId,
} from "./reconcile-core";
// The producer-side worker-cell resolution seam lives in the filesystem-probing
// `./worker-cell` leaf (shared with the dispatch CLI). `findShadowingWorkManifest`
// moved there with it; re-exported so every existing `from "./autopilot-worker"`
// import keeps resolving.
export { findShadowingWorkManifest } from "./worker-cell";

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
 * Resolve the autopilot worker's `{model, effort}` from the `worker` preset in
 * `presets.yaml`, COALESCING onto the {@link WORKER_MODEL}/{@link WORKER_EFFORT}
 * constants per-field so behavior is byte-identical when no registry/preset
 * exists. Read PRODUCER-SIDE (per dispatch, not a fold input) — the resolved
 * model never enters `events` as a fold key, so re-fold stays byte-identical.
 *
 * Fail-SAFE — the SOLE fail-open carve-out to the required-catalog posture: a
 * missing OR malformed catalog throws a `ConfigError` that is SWALLOWED-to-
 * constants here, so the daemon never crashes on bad config. Re-resolved per
 * cycle (cheap single-file parse) so a preset edit lands without a daemon bounce;
 * never file-watched.
 *
 * A non-claude `preset.harness` is IGNORED (autopilot dispatch is claude-only
 * until harness dispatch lands) but WARNED once per distinct offending value via
 * `warned` — the reconcile cycle re-calls this per tick, so the memo keeps the
 * drop from becoming per-cycle log spam. Never throws on the drop.
 */
/**
 * Distinct non-claude `worker`-preset harness values already warned about, so
 * {@link resolveWorkerLaunchConfig} logs the drop ONCE per offending value
 * rather than every reconcile cycle. Producer-side process memo (never a fold
 * input); tests inject a fresh set to observe the once-per-value contract.
 */
const droppedWorkerHarnessWarned = new Set<string>();

export function resolveWorkerLaunchConfig(
  configPath?: string,
  warned: Set<string> = droppedWorkerHarnessWarned,
): {
  model: string;
  effort: string;
} {
  let preset: Preset | undefined;
  try {
    const catalog = loadPresetCatalog(
      ...(configPath === undefined ? [] : ([configPath] as const)),
    );
    preset = catalog.presets.worker;
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(
        "[autopilot-worker] preset catalog missing or invalid — using worker defaults:",
        err.message,
      );
    } else {
      throw err;
    }
  }
  if (
    preset !== undefined &&
    preset.harness !== "claude" &&
    !warned.has(preset.harness)
  ) {
    warned.add(preset.harness);
    console.error(
      `[autopilot-worker] worker preset pins harness '${preset.harness}', but ` +
        `autopilot dispatch ignores non-claude harness values until harness ` +
        `dispatch lands — launching on claude.`,
    );
  }
  return {
    model: preset?.model ?? WORKER_MODEL,
    effort: preset?.effort ?? WORKER_EFFORT,
  };
}

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
 * side), then strip a trailing slash. A realpath failure (a torn-down lane) keeps the
 * raw input, still trailing-slash-stripped. Mirrors {@link
 * normalizeWorktreeAttributionKey} so the two lane keyings never drift.
 */
function normalizeLanePath(p: string): string {
  let resolved = p;
  try {
    resolved = realpathSync.native(p);
  } catch {
    // A torn-down lane that no longer resolves — key on the raw path.
  }
  return stripTrailingSlashPath(resolved);
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
  clearSharedWedgeDistress?(payload: { id: string; dir: string }): void;
  /**
   * Kill the tmux window holding a provably-dead slot occupant's pane, releasing the
   * wedged dispatch slot. Wired to `paneOps.killWindow`; the ONLY producer side
   * effect the slot-occupancy reclaim takes, gated behind the strict
   * bare-shell-past-grace criterion in the pure decision. Optional — a partial
   * test deps stays visibility-only. NEVER throws (killWindow degrades to a logged
   * `{ ok: false }` on a TOCTOU window-already-gone, itself the desired end state).
   */
  reclaimSlotPane?(paneId: string): Promise<void>;
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
  /**
   * Producer-side scan-dir probe for a non-cell `work`-named plugin that would
   * shadow the launch-time `work:worker` cell (see {@link
   * findShadowingWorkManifest}). Returns the offending manifest path — the
   * producer mints a sticky `work-plugin-shadowed` `DispatchFailed` (per-key,
   * cleared by `retry_dispatch`) instead of spawning the wrong worker — or null
   * when clean. Defaults to a real-config scan ({@link defaultShadowingWorkProbe})
   * in `runReconcileCycle` when absent. A PRODUCER read by contract — lives in
   * `runReconcileCycle`, never a fold arm, so re-fold determinism holds. Injected
   * so tests assert the guard against a real scan-dir position without live config.
   */
  probeShadowingWorkManifest?(): string | null;
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
   * worktree mode: `runReconcileCycle` calls it to provision a lane worktree, run
   * fan-in pre-merges, assert HEAD, and — after a closer reaches done — merge the
   * epic base into the default branch + push + tear down. Every method shells git
   * on the target repo (a producer side effect); none touches keeper.db or a fold.
   * Injected so the fast tier drives the same code paths with a fake.
   */
  worktree?: WorktreeDriver;
  /**
   * The MAIN-projection done-ness probe ({@link isEpicDoneById} bound to
   * the reconciler's read-only connection), threaded into `worktree.finalizeEpic`
   * so finalize merges a lane ONLY when its epic is done in the projection. The
   * closer writes `done` to the PRIMARY repo, so the projection — not a lane-read —
   * is the authority; this rejects a crashed closer that finished without `done`.
   * Mirrors the same probe the recover glue passes into `worktree.recover`.
   */
  isEpicDone(epicId: string): Promise<boolean>;
  /**
   * Tuning knobs — exposed as deps so tests can drive a 5ms / 50ms
   * cadence instead of seconds. Defaults applied in `runConfirmCycle`
   * when undefined.
   */
  pollIntervalMs?: number;
  ceilingMs?: number;
}

/**
 * The producer git driver for worktree mode — the side-effect seam
 * `runReconcileCycle` calls before `confirmRunning` (provision) and after a
 * closer reaches done (finalize). Every method runs real git on the target repo
 * and NEVER writes keeper.db / runs in a fold. Injected so tests fake it; the
 * default impl wraps `src/worktree-git.ts`.
 */
export interface WorktreeDriver {
  /**
   * Provision the lane for one launch: ensure the worktree exists (lazily, off
   * the parent lane's committed tip), run the assignment's fan-in pre-merges in
   * order, then assert the worktree HEAD equals the derived branch. Returns the
   * resolved worktree path on success (the producer overrides the launch cwd with it).
   *
   * A failure carries a `reason` and, for a fan-in pre-merge failure, the base lane
   * `dir` (so the producer keys the row on the lane path the recover pass matches on):
   *  - `{ ok: false, reason }` — a GENUINE terminal block (a fan-in content merge
   *    conflict, an unregistered/HEAD-mismatch worktree). The producer mints a STICKY
   *    `DispatchFailed` a human clears with `retry_dispatch`.
   *  - `{ ok: false, reason, dir }` with a {@link WORKTREE_LANE_PREMERGE_REASON_PREFIX}
   *    reason — a not-losslessly-mergeable base lane (dirty-but-not-cleanable /
   *    off-branch / mid-merge / would-clobber / lock-timeout). NEVER a blind merge: the
   *    producer mints a SELF-CLEARING `work::<taskId>` row the recover pass's
   *    verb-agnostic reason-scoped level-clear drops once the base is ready (and a
   *    persistent one escalates to a per-lane distress) — never the dead `work-task`
   *    dead end. Consumes NO slot/cooldown (the mint precedes them).
   *  - `{ ok: false, retry: true, reason }` — a transient the producer skips minting a
   *    sticky for (used by finalize/close-sink; the pre-merge arm no longer emits it).
   *
   * Before each fan-in merge the driver probes {@link mergeReadiness}: a `ready` base
   * merges unchanged; a DIRTY base is losslessly cleaned ONLY when the dirt is a
   * provably-redundant leak of the incoming rib AND none of it is in
   * `liveAttributedDirty` (the reconciler-supplied set of repo-relative paths a LIVE
   * job holds an undischarged mutation for in this base worktree; `null` ⇒ the
   * attribution read failed ⇒ do-not-discard). The driver never reads attribution
   * itself.
   */
  provision(
    info: WorktreeLaunchInfo,
    liveAttributedDirty: ReadonlySet<string> | null,
  ): Promise<
    | { ok: true; cwd: string }
    | { ok: false; reason: string; retry?: boolean; dir?: string }
  >;
  /**
   * After the epic closer reaches done: merge the epic base branch into the repo's
   * resolved default branch (sequential pairwise, pushed once), then tear the lane
   * worktrees down. Returns `{ ok: true }` on a clean merge-and-teardown.
   *
   * `isEpicDone` is the MAIN-projection done-ness probe ({@link isEpicDoneById}),
   * threaded in the same way recover takes it: finalize merges ONLY when the epic
   * is done in the projection (the closer wrote `done` to the PRIMARY repo, never
   * the lane), which rejects a crashed closer that finished but never committed
   * `done`. The lane-ahead half of the gate is the shared merge routine's
   * `not-ahead` check.
   *
   * A failure is one of two kinds, distinguished by `retry`:
   *  - `{ ok: false, reason }` (no `retry`) — a GENUINE block (a content merge
   *    conflict, a dirty-LANE teardown refusal, OR an origin-ahead non-fast-forward
   *    needing an operator). The producer mints a STICKY `close::<epic>`
   *    DispatchFailed a human clears with `retry_dispatch`.
   *  - `{ ok: false, retry: true, reason }` — a transient environment state on the
   *    SHARED main checkout (dirty / off-branch / mid-rebase). The producer STOPS
   *    this epic's finalize but mints NO sticky failure; the next cycle retries
   *    once the tree settles. NEVER an un-clearable close, and NEVER the
   *    divergent-content or origin-ahead non-ff case (those stay loud sticky blocks).
   */
  finalizeEpic(
    info: WorktreeLaunchInfo,
    isEpicDone: (epicId: string) => Promise<boolean>,
  ): Promise<{ ok: true } | { ok: false; reason: string; retry?: boolean }>;
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
   *  1. INTERRUPTED MERGE: for every registered linked worktree across `repos`,
   *     detect a stale `MERGE_HEAD` (a crash mid-merge) → `git merge --abort` →
   *     `git worktree prune --expire now`. The next cycle re-runs the merge from a
   *     clean state (level-triggered retry, no in-process self-heal). SKIPPED for a
   *     lane whose epic has a LIVE autonomous merge-resolver (`hasActiveResolver`):
   *     that MERGE_HEAD is the resolver's deliberate in-progress merge, not crash
   *     residue — the scoped per-epic exclusion that replaced the resolver's global
   *     `keeper autopilot pause`.
   *  2. DONE-BUT-UNMERGED BACKSTOP: enumerate `keeper/epic/<id>` base branches
   *     from git; for each whose epic `isEpicDone` reports done but whose base is
   *     NOT yet an ancestor of the resolved default branch, merge it to default +
   *     push (idempotent: an already-merged base is skipped). DECOUPLED from
   *     `DONE_EPICS_REAP_WINDOW_SEC`.
   *
   *  3. ORPHAN-LANE PRUNE: tear down each `keeper/epic/<id>` lane (base AND rib)
   *     whose epic `epicPresentAndNotDone` reports inactive (ABSENT or done),
   *     gated by a SECONDARY is-ancestor-of-default safety. A live epic's lanes
   *     are PRESERVED (an omitted probe defaults to preserve — fail-safe).
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
  ): Promise<WorktreeRecoveryOutcome>;
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
  ts: number;
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
 * A DispatchCleared resets the gate (via {@link DispatchFailedGate.noteClear}) so
 * the next failure of that `(verb, id)` re-emits immediately.
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
  /** Reset the `(verb, id)` gate on its DispatchCleared, so a re-failure re-emits. */
  noteClear(verb: Verb, id: string): void;
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
    noteClear(verb, id) {
      lastEmitted.delete(keyOf(verb, id));
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
  // (projectDir   number) → the colliding epic ids. The NUL joiner never appears in a
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
    const key = `${projectDir} ${e.epic_number}`;
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
 */
export type ConfirmOutcome =
  | "ok"
  | "failed"
  | "indoubt"
  | "aborted-prelaunch"
  | "aborted-postlaunch"
  | "suppressed-dup";

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
  isGrandfathered: (epicId: string, repoDir: string) => boolean = () => false,
  multiRepoEnabled = false,
): Map<string, WorktreeRepoResolution> {
  const out = new Map<string, WorktreeRepoResolution>();
  for (const epic of epics) {
    out.set(
      epic.epic_id,
      classifyEpicRepo(
        epic,
        resolve,
        assessRepo,
        isGrandfathered,
        multiRepoEnabled,
      ),
    );
  }
  return out;
}

/**
 * PURE projection of the per-cycle {@link WorktreeRepoResolution} map to the
 * operator-surface entry set (fn-1013) — one entry per epic the heuristic marked
 * `disabled` (a not-worktree-friendly repo → serial shared-checkout dispatch).
 * Only `disabled` resolutions surface: `ok` epics get worktree lanes (the normal
 * path), and the `multi-repo` / `unresolved` / `no-primary-repo` rejects already
 * show in the red `dispatch_failures` block — the neutral worktree surface is
 * DISTINCT from that. Sorted by `epic_id` for a stable serialization so the
 * change-gate (semantic dedupe) never fires on map-iteration-order churn.
 * Exported for tests.
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
    }
  }
  out.sort((a, b) => a.epic_id.localeCompare(b.epic_id));
  return out;
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
              console.error(
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
            console.error(
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
            console.error(
              `[autopilot-worker] cross-epic merge-gate: deferring ${epic.epic_id}@${repoR} — could not resolve ${repoR} default branch (probe inconclusive)`,
            );
            markDeferred(epic.epic_id, repoR);
            break;
          }
          if (!(await gitIsAncestorOf(repoR, laneBranch, localDefault, run))) {
            console.error(
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
        console.error(
          `[autopilot-worker] cross-epic merge-gate: deferring ${epic.epic_id}@${repoR} — probe threw:`,
          err,
        );
        markDeferred(epic.epic_id, repoR);
      }
    }
  }
  return deferred;
}

/**
 * Compute the durable MERGE-LANDED set (fn-1016): every `ok`-classified epic whose
 * worktree lane branch (`keeper/epic/<id>`) is provably merged into the LOCAL
 * default branch. Producer-side + git-touching — probed ONCE per cycle in
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
 * A `disabled` (serial, no lane) / multi-repo / unresolved / no-primary epic is
 * skipped here — the no-lane "merged ⇔ done" degradation lives in the consumer
 * (the snapshot's `landedEpicIds`, and worktree mode OFF). A throwing git probe
 * degrades that epic to NOT merged; the function NEVER throws out of the snapshot
 * build. The per-repo default-branch + lane-enumeration probes are memoized so N
 * epics/groups sharing one repo spawn git once.
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
    // Only a lane-cutting resolution can land a merge: an `ok` epic (one lane) or a
    // `clustered` multi-repo epic (one lane per `worktree` group + serial groups).
    // A `disabled` / multi-repo / unresolved / no-primary epic cuts no lane — the
    // no-lane degradation is the consumer's concern.
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
  out.sort((a, b) => a.epic_id.localeCompare(b.epic_id));
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
  isGrandfathered: (epicId: string, repoDir: string) => boolean,
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
      isGrandfathered,
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
  // A would-be-`ok` epic resolving to ONE primary-backed toplevel: the LAST gate
  // is repo eligibility. A not-worktree-friendly toplevel (workspace marker /
  // submodule / no manifest / probe error) downgrades to `disabled` — a NORMAL,
  // NON-error sequential-on-shared-checkout fallback, never a sticky reject. Only
  // ever downgrades `ok`; the loud rejects above already returned.
  const eligibility = assessRepo(repoDir);
  if (!eligibility.eligible) {
    // GRANDFATHER: an epic that ALREADY has live worktree lanes keeps `ok` even on
    // a `disabled` verdict — flipping it mid-flight would strand work on its
    // `~/worktrees` lanes while new tasks dispatch on the shared checkout AND lose
    // the merge-to-default finalize (`attachWorktreeGeometry` builds
    // `worktreeFinalize` only for `ok`). The likelier flip is a TRANSIENT probe
    // error (fail-closed) on a healthy in-flight epic, not a marker appearing
    // mid-epic. The predicate is producer-side fs/git (base worktree dir OR
    // `keeper/epic/<id>` branch exists) — never read here in the pure layer.
    if (isGrandfathered(epic.epic_id, repoDir)) {
      return { kind: "ok", repoDir };
    }
    return { kind: "disabled", repoDir, reason: eligibility.reason };
  }
  return { kind: "ok", repoDir };
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
 * is `serial`. `primaryRepoDir` is the resolved toplevel of `project_dir` when it
 * is one of the group repos (the group that hosts the single plan-close worker),
 * else the first group's repo — a deterministic fallback that keeps the close
 * anchored to a real group. Pure: no fs/git beyond the injected `resolve` /
 * `assessRepo` / grandfather probes (all memoized producer-side).
 */
function clusterEpicRepos(
  epic: Epic,
  resolve: (root: string) => string | null,
  assessRepo: (toplevel: string) => WorktreeEligibility,
  isGrandfathered: (epicId: string, repoDir: string) => boolean,
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
  const groups: WorktreeRepoGroup[] = order.map((repoDir) => {
    // Per-group worktree-eligibility, mirroring the single-repo `disabled`
    // downgrade + grandfather: an ineligible repo whose epic has no live lane runs
    // `serial` (shared checkout); a grandfathered one stays `worktree`.
    const eligibility = assessRepo(repoDir);
    const mode: "worktree" | "serial" =
      eligibility.eligible || isGrandfathered(epic.epic_id, repoDir)
        ? "worktree"
        : "serial";
    return { repoDir, taskIds: taskIdsByRepo.get(repoDir) ?? [], mode };
  });
  // The PRIMARY group hosts the single plan-close. Prefer the group whose repo IS
  // the resolved primary; fall back to the first group so the close always anchors
  // to a real group's base.
  const primaryResolved = resolve(projectDir);
  const primaryRepoDir =
    primaryResolved !== null &&
    groups.some((g) => g.repoDir === primaryResolved)
      ? primaryResolved
      : (groups[0]?.repoDir ?? "");
  return { kind: "clustered", groups, primaryRepoDir };
}

/**
 * PRODUCER: the per-epic grandfather predicate threaded into
 * {@link classifyWorktreeRepos} — true IFF epic `epicId` ALREADY has a live
 * worktree lane on `repoDir`, so a `disabled` verdict must NOT flip it (see the
 * grandfather note in {@link classifyEpicRepo}). Two robust signals OR'd, so the
 * costly false NEGATIVE (an in-flight epic missed → split-brain / lost work) needs
 * BOTH to miss:
 *  - the deterministic base worktree dir exists (`existsSync` — pure fs), or
 *  - the `keeper/epic/<id>` base branch exists (a fail-closed `git` ref peek;
 *    only spawned when the cheap dir check misses).
 * Both mirror the recover scan's notion of a live lane. A stale leftover dir/branch
 * is a BOUNDED false POSITIVE — it keeps ONE now-disabled epic on worktree mode
 * until the recover sweep reaps its dead lane; acceptable. Producer-only (fs+git),
 * NEVER read inside the pure classify layer or a fold.
 */
function worktreeEpicGrandfathered(epicId: string, repoDir: string): boolean {
  const baseBranch = baseBranchFor(epicId);
  return (
    existsSync(worktreePathFor(repoDir, baseBranch)) ||
    localBranchExists(repoDir, baseBranch)
  );
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
): Promise<ConfirmOutcome> {
  const key = dispatchKey(verb, id);
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
  // 3. Launch — ONLY after the durable `dispatched-ack{ok:true}`. `spec` is the
  // structured input keeper agent (keeper's sole launch transport) builds its
  // invocation from; the pre-wrapped `argv` is ignored by the launch impl.
  const launchResult: LaunchResult = await deps
    .launch(argv, key, cwd, spec)
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
      ts: deps.now(),
    });
    return "failed";
  }
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
  //   ceilingMs (60s) < PENDING_DISPATCH_TTL_MS (120s) < REDISPATCH_COOLDOWN_S (200s).
  // ceiling < TTL: a sweep < ceiling would clear the row mid-confirm and re-open
  // the dispatch. TTL < cooldown: the cooldown must outlast the worst-case
  // round-trip (the row surviving a full TTL plus the sweep tick) so suppression
  // never lapses while a phantom is in flight. NOTE: this chain bounds the
  // FOLD-LAG round-trip, but NOT an arbitrary `claude` cold-boot tail —
  // the 2026-06-10 dup-close booted 317s late, so the fixed dispatch-anchored
  // cooldown (cover-end dispatch+260s with one indoubt re-stamp) lapsed before the
  // bind. `refreshSuppressionForOpenPending` now re-anchors the cooldown each cycle
  // the `pending_dispatches` row is still OPEN, extending cover to the phantom's
  // durable lifetime (still TTL-sweep-bounded). Telemetry rides alongside: the
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
    for (const job of jobs.values()) {
      const live =
        job.state === "working" ||
        (job.state === "stopped" && isStoppedJobLive(job, livePaneIds));
      if (live) {
        liveSessions.add(job.job_id);
      }
    }
    if (liveSessions.size === 0) {
      return new Map();
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
    const byWorktree = new Map<string, Set<string>>();
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
  // Scan-dir shadow probe — resolved once, memoized across the loop (the scan dirs
  // are cycle-invariant). `undefined` = not yet probed; a first `work`-cell launch
  // triggers the single on-disk scan, so a cycle with no cell launches never reads
  // the plugin config. Producer read (never a fold).
  const probeShadow =
    deps.probeShadowingWorkManifest ?? defaultShadowingWorkProbe;
  let shadowManifest: string | null | undefined;
  // Per-cycle memoized shadow probe handed to `resolveWorkerCell` — the on-disk
  // scan fires at most once (first cell launch that reaches the shadow check),
  // then serves the memo. Keeps the hot loop off a readdir-per-launch.
  const probeShadowMemoized = (): string | null => {
    if (shadowManifest === undefined) {
      shadowManifest = probeShadow();
    }
    return shadowManifest;
  };
  // ── Slot-occupancy visibility + auto-reclaim ───────────────────────────────
  // Surface every wedged slot (a stopped-but-live session blocking a wanted mint)
  // as a visible `DispatchFailed` through the change-gate, and KILL the pane of a
  // provably-dead occupant (`reclaimPaneId`) to free its slot. The kill re-issues
  // every cycle the condition persists (until the pane is gone) INDEPENDENT of the
  // gate's emit-suppression, so a first-cycle TOCTOU miss self-heals. Clears fire
  // symmetrically off the pure decision. All reason-scoped upstream, so a genuine
  // `close::<epic>` conflict on the shared key is never touched.
  for (const sig of decision.slotOccupancy) {
    if (signal.aborted) {
      return;
    }
    deps.emitDispatchFailed({
      verb: sig.verb,
      id: sig.id,
      reason: sig.reason,
      dir: sig.dir,
      ts: deps.now(),
    });
    if (sig.reclaimPaneId !== null) {
      await deps.reclaimSlotPane?.(sig.reclaimPaneId);
    }
  }
  for (const clr of decision.slotOccupancyClears) {
    if (signal.aborted) {
      return;
    }
    deps.emitDispatchCleared({ verb: clr.verb, id: clr.id });
  }
  // One-at-a-time: each await covers the full confirm window for that dispatch
  // before the next launch starts (which IS the stagger).
  for (const plan of decision.launches) {
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
        ts: deps.now(),
      });
      continue;
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
        ts: deps.now(),
      });
      continue;
    }
    // Per-cell worker-plugin guards, BEFORE any launch side effect (mirrors the
    // `worktreeReject` / `cwd-missing` per-key skip shape). The shared
    // `resolveWorkerCell` seam applies the invalid → missing → shadowed
    // precedence over the pure compose result the launch already carries
    // (`plan.pluginDir` / `plan.pluginDirReject`); this producer re-composes the
    // EXACT sticky reason strings from the machine kind, so a doomed launch
    // mints a sticky `DispatchFailed` (cleared by `retry_dispatch`) and skips
    // per-key without burning a cold boot, and a sibling launch keeps
    // dispatching. The switch is closed by `assertNever` — a new reject kind
    // fails compilation here.
    const cell = resolveWorkerCell(
      {
        pluginDir: plan.pluginDir,
        ...(plan.pluginDirReject !== undefined
          ? { reject: plan.pluginDirReject }
          : {}),
      },
      {
        dirExists,
        probeShadow: probeShadowMemoized,
        probeRoute: () => defaultRouteProbe(plan.model),
      },
    );
    if (!cell.ok) {
      let reason: string;
      switch (cell.kind) {
        // (1) an out-of-matrix {model, effort} the pure compose flagged.
        case "out-of-matrix":
          reason = `worker-cell-invalid: ${cell.message}`;
          break;
        // (2) a cell whose generated plugin manifest is absent — `claude
        //     --plugin-dir` would fall back to the dir basename and `/plan:work`
        //     could not resolve `work:worker`. Remediation: regenerate the tree.
        case "missing":
          reason =
            `worker-cell-missing: ${cell.pluginDir} — regenerate via ` +
            `'keeper prompt render-plugin-templates --project-root ` +
            `${join(KEEPER_ROOT, "plugins", "plan")}' (without the cell manifest ` +
            `claude --plugin-dir falls back to the dir basename and '/plan:work' ` +
            `cannot resolve 'work:worker')`;
          break;
        // (3) a non-cell `work`-named plugin sitting in a claude `plugin_scan_dir`
        //     re-claims the `work:worker` constant at launch and silently shadows
        //     the `--plugin-dir`-selected cell (silent wrong-worker spawn).
        case "shadowed":
          reason =
            `work-plugin-shadowed: ${cell.shadowManifest} — a non-cell 'work'-named ` +
            `plugin in a claude plugin_scan_dir would steal 'work:worker' from ` +
            `the '${cell.pluginDir}' cell at launch (silent wrong-worker spawn); ` +
            "remove or rename it, then 'keeper retry-dispatch'";
          break;
        // (4) a wrapped capability model the host matrix routes to zero
        //     configured providers (or a malformed matrix.yaml).
        case "no-route":
          reason =
            `worker-cell-no-route: '${cell.model}' is a wrapped model with no ` +
            `configured provider in ${matrixConfigPath()} — add a provider serving ` +
            "it to the roster (or correct the task's model), then 'keeper retry-dispatch'";
          break;
        default:
          assertNever(cell);
      }
      deps.emitDispatchFailed({
        verb: plan.verb,
        id: plan.id,
        reason,
        dir: plan.cwd,
        ts: deps.now(),
      });
      continue;
    }
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
          // cooldown, or pending row. Log so the silent skip stays diagnosable.
          console.error(
            `[autopilot-worker] provision ${plan.verb}::${plan.id}: ${wt.reason}`,
          );
          continue;
        }
        deps.emitDispatchFailed({
          verb: plan.verb,
          id: plan.id,
          reason: wt.reason,
          dir: wt.dir,
          ts: deps.now(),
        });
        continue;
      }
      launchCwd = wt.cwd;
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
    const workerCommand =
      launchCwd === plan.cwd
        ? plan.workerCommand
        : buildWorkerCommand(
            plan.verb,
            plan.id,
            launchCwd,
            plan.model,
            plan.effort,
            plan.pluginDir,
          );
    const argv = buildLaunchArgv(shell, workerCommand);
    const spec = buildPlannedLaunchSpec(
      plan.verb,
      plan.id,
      plan.model,
      plan.effort,
      worktreeLane,
      worktreeBranch,
      plan.pluginDir,
    );
    try {
      const outcome = await confirmRunning(
        plan.verb,
        plan.id,
        launchCwd,
        argv,
        spec,
        signal,
        deps,
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
      } else if (outcome === "suppressed-dup") {
        // The durable mint gate suppressed this re-mint (a live attempt is in
        // flight / freshly minted). RE-STAMP the cooldown rather than CLEAR it:
        // a pre-launch abort clears (nothing launched, so re-dispatch freely),
        // but suppression must DAMP — clearing here re-arms the very loop the
        // gate exists to break (suppress→clear→re-dispatch→suppress…). `failedKeys`
        // is left untouched (the work is not failed) and no live entry is
        // recorded (this attempt did not launch). Keep the finalizer guard
        // lockstep with the cooldown, as the indoubt arm does.
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
      // Other outcomes (failed / indoubt / aborted-*) record no live entry; see
      // the ConfirmOutcome doc and the stamp handling above. `inFlight` is
      // released for all in the `finally`.
    } finally {
      state.inFlight.delete(plan.key);
    }
  }

  // Worktree-finalize pass. For each epic whose closer reached done this
  // cycle, merge the epic base into the resolved default branch (pushing once) and
  // tear the lanes down. Runs AFTER the launch loop (the closer that landed the
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
    // trigger their rib→base fan-in, so assemble those bases HERE (via `provision`,
    // idempotent + crash-recoverable) BEFORE their finalize merges an unassembled
    // base to default. A fan-in failure (a content conflict merging a rib) mints
    // the same sticky `close::<epic>` DispatchFailed a finalize block would, and
    // SKIPS that group's finalize — never merges a half-assembled base. EMPTY for
    // single-repo epics, so this is a byte-identical no-op there.
    const provisionFailed = new Set<string>();
    for (const sink of decision.worktreeSinkProvision) {
      if (signal.aborted) {
        return;
      }
      const provisioned = await deps.worktree.provision(
        sink,
        liveAttrFor(sink),
      );
      // A provision failure — genuine OR a transient retry-skip — ADDS to
      // `provisionFailed` below so this group's finalize is skipped either way (its
      // base is not assembled). Only a GENUINE block mints the sticky `close::<epic>`.
      if (!provisioned.ok) {
        provisionFailed.add(`${closeKeyEpicId(sink)} ${sink.repoDir}`);
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
            ts: deps.now(),
          });
        }
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
      if (provisionFailed.has(`${closeKeyEpicId(info)} ${info.repoDir}`)) {
        continue;
      }
      const finalizeKey = worktreeFinalizeDispatchId(
        closeKeyEpicId(info),
        info.repoDir,
      );
      const result = await deps.worktree.finalizeEpic(info, deps.isEpicDone);
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
        deps.emitDispatchCleared({ verb: "close", id });
      }
    }
  }
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
 *  - `worktree` → provision the lane (ensure + pre-merges + assert HEAD), launch
 *    into the worktree path.
 *  - neither → OFF mode: assert the launch cwd is on the resolved default branch.
 */
async function runWorktreeProducerStep(
  plan: PlannedLaunch,
  launchCwd: string,
  driver: WorktreeDriver,
  liveAttributedDirty: ReadonlySet<string> | null,
): Promise<
  | { ok: true; cwd: string }
  | { ok: false; reason: string; dir: string; retry?: boolean }
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
      };
    }
    return { ok: true, cwd: provisioned.cwd };
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
 * Provision: assert the parent lane's worktree HEAD is on its branch (the fork
 * source must be the deterministic branch), ensure the node's worktree exists off
 * that parent's committed tip, run the fan-in pre-merges in order, then assert the
 * node's worktree HEAD equals the derived branch. Finalize: merge the epic base
 * into the resolved default branch (in the MAIN worktree), push once, tear the
 * lanes down. assertOnDefaultBranch: `currentBranch(cwd) === resolveDefaultBranch`.
 */
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
): WorktreeDriver {
  return {
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
        // Run the fan-in pre-merges in order — sequential pairwise, each taking the
        // shared commit-work flock. A content conflict aborts + fails loud + stops;
        // a `missing-source` phantom lane (a branch never created because its task's
        // work landed on the default branch) is a lossless no-op we skip.
        for (const source of preMerges) {
          // Probe the base worktree BEFORE merging the rib in (as finalize/recover
          // already do), but ONLY for a source that will ACTUALLY merge — a phantom
          // (unresolvable) or already-merged (ancestor) source folds nothing, so
          // probing the base for it would both add cost AND, on a dirty base, wrongly
          // retry-skip against a no-op. These guards mirror gitMergeBranchInto's own
          // (idempotent — it re-runs them); a probe TIMEOUT falls through to it, which
          // surfaces the transient degrade. `resolves &&` short-circuits the ancestry
          // probe for a phantom so it stays a single-read cheap skip.
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
          const resolves = srcRef.code === 0;
          const alreadyMerged =
            resolves &&
            (
              await run(["merge-base", "--is-ancestor", source, "HEAD"], {
                cwd: worktreePath,
                timeoutMs: GIT_LOCAL_TIMEOUT_MS,
              })
            ).code === 0;
          if (resolves && !alreadyMerged) {
            // A `ready` base merges unchanged (byte-identical clean path). A DIRTY base
            // is LOSSLESSLY cleaned ONLY when its dirt is a provably-redundant leak of
            // THIS rib and none is attributed to a live job — else every not-ready
            // state degrades to a SELF-CLEARING (non-sticky) `worktree-lane-premerge`
            // row so a dirty base never blind-conflicts (the wedge this arm fixes) yet
            // is never the dead no-clear `work-task` dead end: the recover pass's
            // verb-agnostic reason-scoped level-clear clears it by lane path once the
            // base is ready, and a persistent one escalates to a per-lane distress.
            // Genuine-conflict escalation of the merge ITSELF stays today's sticky.
            const ready = await gitMergeReadiness(
              worktreePath,
              branch,
              run,
              source,
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
              // cleaned.kind === "ready" → the redundant leak was restored to HEAD; the
              // merge below re-applies exactly that content, a true no-op on it.
            } else if (ready.kind !== "ready") {
              // A not-ready base lane (off-branch / mid-merge / would-clobber) the merge
              // would abort on — a self-clearing lane row, NEVER a blind merge.
              return {
                ok: false,
                dir: worktreePath,
                reason: `${WORKTREE_LANE_PREMERGE_REASON_PREFIX}-not-ready: base ${worktreePath} is ${ready.kind} before merging ${source} into ${branch} — deferring the fan-in`,
              };
            }
          }
          const merge: MergeResult = await gitMergeBranchInto(
            worktreePath,
            source,
            run,
          );
          if (merge.kind === "missing-source") {
            continue; // phantom lane: nothing to merge, never created
          }
          // `abort-failed` (the conflict/timeout abort itself failed, leaving the
          // lane worktree mid-merge) folds into today's conflict fail-loud; task 2
          // specializes it into the distinct wedge-escalation reason.
          if (merge.kind === "conflict" || merge.kind === "abort-failed") {
            return {
              ok: false,
              reason: `worktree-merge-conflict: merging ${source} into ${branch} — ${merge.stderr}`,
            };
          }
          // A bounded-lock / local-op (blocking hook) timeout means the pre-merge
          // did NOT land — surface it rather than fall through as if merged (which
          // would launch the lane off an incomplete fan-in). Provision carries no
          // retry flag, so this is a sticky `work::` block a human clears once the
          // lock/hook frees; `worktree-merge-*` (NOT a recover/finalize reason).
          if (merge.kind === "lock-timeout") {
            return {
              ok: false,
              reason: `worktree-merge-lock-timeout: could not acquire the commit-work lock for ${worktreePath} within the deadline (a concurrent holder) merging ${source} into ${branch} — retry once the lock frees`,
            };
          }
          if (merge.kind === "local-timeout") {
            return {
              ok: false,
              reason: `worktree-merge-local-timeout: a local git op merging ${source} into ${branch} timed out (a blocking git hook) — retry once the hook clears`,
            };
          }
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
        return { ok: true, cwd: worktreePath };
      } catch (err) {
        return {
          ok: false,
          reason: `worktree-provision-failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
    async finalizeEpic(info, isEpicDone) {
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
        // The base merge lands IN THE MAIN worktree (the repo dir is the human's
        // shared checkout) via the ONE shared {@link mergeLaneBaseIntoDefault}
        // routine. It degrades — NEVER stomps WIP or fights an in-flight
        // merge/rebase: a dirty / off-branch / would-clobber / non-turn-key
        // shared checkout is a clean SKIP-AND-RETRY (a DISTINCT, non-`worktree-recover*`
        // reason so the recover auto-clear never touches it, AND `retry: true` so no
        // sticky DispatchFailed — never an un-clearable close). A genuine
        // divergent-content conflict, a push failure, OR an origin-ahead non-ff
        // stays a loud VISIBLE sticky block (an operator reconciles origin).
        // `not-ahead`/`merged` fall through to teardown (an already-merged base
        // still tears its lanes down — the idempotent resume).
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
            // A merge is IN FLIGHT on the shared checkout (the wedge, no longer folded
            // into dirty). A retry-skip (no sticky) that NAMES the residue (owner +
            // MERGE_HEAD): the recover pass self-heals a keeper-owned one via its
            // guarded abort next cycle, and a foreign/ambiguous one waits for the human
            // — either way finalize retries once the checkout is clean.
            return retrySkip(
              `worktree-finalize-mid-merge: ${repoDir} is mid-merge (owner=${merge.owner}, autostash=${merge.autostash}, MERGE_HEAD=${merge.mergeHead}) — skipping the base merge of ${baseBranch} until the checkout is clean (${merge.owner === "keeper" ? "the recover pass aborts keeper-owned residue" : "foreign/ambiguous residue is never auto-aborted"})`,
            );
          case "abort-failed":
            // The guarded `git merge --abort` ITSELF failed, leaving the checkout
            // mid-merge — a real wedge that will NOT self-clear, so a VISIBLE sticky
            // (no `retry: true`) an operator resolves, mirroring the conflict arm.
            return {
              ok: false,
              reason: `worktree-finalize-abort-failed: the guarded git merge --abort left ${repoDir} mid-merge while merging ${baseBranch} into ${defaultBranch} — ${merge.stderr}`,
            };
          case "would-clobber":
            return retrySkip(
              `worktree-finalize-would-clobber: merging ${baseBranch} into ${defaultBranch} would overwrite untracked file(s) in ${repoDir} — ${merge.paths.join(", ")} — skipping the base merge until the path(s) are cleared`,
            );
          case "non-ff":
            // Origin is AHEAD of local default (a genuine non-fast-forward) — the
            // shared checkout cannot land the merge without a human reconciling
            // origin (no fetch/rebase/force on the shared tree). UNLIKE the transient
            // environment skips above, this needs operator attention, so mint a
            // VISIBLE sticky DispatchFailed (no `retry: true`). The reason stays
            // `worktree-finalize-*` (OUTSIDE the `worktree-recover` auto-clear prefix)
            // so the level-triggered clear never silently dismisses an origin-ahead
            // block.
            return {
              ok: false,
              reason: `worktree-finalize-non-fast-forward: origin/${defaultBranch} is ahead of ${defaultBranch} — the shared checkout cannot fast-forward (no fetch/rebase/force); needs an operator to reconcile origin/${defaultBranch}`,
            };
          case "not-turn-key":
            return retrySkip(
              `worktree-finalize-push-not-turn-key: ${describePushNotReady(merge.reason)} — skipping the base merge + push until the push is turn-key (no fetch/rebase/force)`,
            );
          case "push-timeout":
            return retrySkip(
              `worktree-finalize-push-timeout: pushing ${defaultBranch} to origin timed out (a transient stall, no fetch/rebase/force) — retrying the push next cycle`,
            );
          case "push-unconfirmed":
            return retrySkip(
              `worktree-finalize-push-unconfirmed: pushed ${defaultBranch} but origin/${defaultBranch} still does not contain ${baseBranch} (no fetch/rebase/force) — deferring teardown until origin settles`,
            );
          case "lock-timeout":
            // The bounded commit-work flock could not be taken within its deadline
            // (a concurrent holder). A TRANSIENT skip — retry next cycle, never a
            // freeze, never a teardown on an un-merged base. `worktree-finalize-*`
            // (OUTSIDE the recover auto-clear prefix), `retry: true` so no sticky.
            return retrySkip(
              `worktree-finalize-lock-timeout: could not acquire the commit-work lock for ${repoDir} within the deadline (a concurrent holder, no fetch/rebase/force) — deferring the base merge until the lock frees`,
            );
          case "local-timeout":
            // A local merge git op timed out — almost always a blocking git hook.
            // TRANSIENT skip-retry, NEVER mistaken for a content conflict.
            return retrySkip(
              `worktree-finalize-local-timeout: a local git op merging ${baseBranch} into ${defaultBranch} in ${repoDir} timed out (a blocking git hook, no fetch/rebase/force) — retrying the base merge next cycle`,
            );
          case "conflict":
            return {
              ok: false,
              reason: `worktree-finalize-conflict: merging ${baseBranch} into ${defaultBranch} — ${merge.stderr}`,
            };
          case "push-failed":
            return {
              ok: false,
              reason: `worktree-finalize-push-failed: ${merge.detail}`,
            };
          case "cas-stale":
            // The compare-and-swap ref advance found a stale `<old>` — a CONCURRENT
            // local advance of default moved the ref (or the ref lock was contended).
            // A TRANSIENT retry-skip (no sticky) OUTSIDE the recover auto-clear prefix;
            // next cycle re-derives the merge off the advanced default tip.
            return retrySkip(
              `worktree-finalize-cas-stale: refs/heads/${defaultBranch} advanced concurrently while merging ${baseBranch} (update-ref CAS mismatch, no fetch/rebase/force) — retrying the base merge next cycle`,
            );
          case "merge-tree-unsupported":
            // `git merge-tree --write-tree` needs git >= 2.38; an older git cannot run
            // the working-tree-free merge. A TRANSIENT retry-skip (never a boot fatal —
            // worktree mode is default-off) in case git is upgraded.
            return retrySkip(
              `worktree-finalize-merge-tree-unsupported: git < 2.38 has no \`merge-tree --write-tree\` for the working-tree-free base merge of ${baseBranch} into ${defaultBranch} in ${repoDir} — retrying next cycle`,
            );
          case "plumbing-failed":
            // An UNEXPECTED plumbing git failure (a merge-tree hard error > 1, a
            // commit-tree failure, an unparseable OID, an invalid ref name) — NOT a
            // content conflict and NOT transient. A VISIBLE sticky (no `retry: true`)
            // an operator reconciles, mirroring the conflict / push-failed arms.
            return {
              ok: false,
              reason: `worktree-finalize-plumbing-failed: merging ${baseBranch} into ${defaultBranch} in ${repoDir} — ${merge.detail}`,
            };
          case "not-ahead":
          case "merged":
            break; // already merged / just merged → fall through to teardown below
          default: {
            // Compile-time exhaustiveness guard so a future MergeLaneResult kind can
            // NEVER silently fall through to lane teardown on an un-merged base (the
            // silent-strand class). The runtime arm is unreachable while the union is
            // fully handled; a new kind surfaces as a VISIBLE sticky rather than a
            // stranded teardown.
            const _exhaustive: never = merge;
            return {
              ok: false,
              reason: `worktree-finalize-unhandled-merge-kind: ${(_exhaustive as MergeLaneResult).kind} merging ${baseBranch} into ${defaultBranch} in ${repoDir}`,
            };
          }
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
        for (const lane of laneOrder) {
          paths.add(lane.worktreePath);
        }
        for (const entry of await gitListWorktrees(repoDir, run)) {
          if (entry.branch === null) {
            continue;
          }
          const short = shortBranchName(entry.branch);
          if (laneBranchShorts.has(short)) {
            paths.add(entry.path);
          }
        }
        for (const p of paths) {
          const removed = await gitRemoveWorktree(repoDir, p, run);
          if (removed.kind === "dirty") {
            return {
              ok: false,
              reason: `worktree-teardown-dirty: ${p} has uncommitted changes — ${removed.stderr}`,
            };
          }
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
    recover(repos, isEpicDone, epicPresentAndNotDone, hasActiveResolver) {
      return recoverWorktrees(
        repos,
        isEpicDone,
        run,
        undefined,
        epicPresentAndNotDone,
        hasActiveResolver,
        onResyncSkipped,
      );
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
  | { kind: "conflict"; stderr: string }
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
  if (
    (await gitRemotePushFastForwardable(repo, defaultBranch, run)) ===
    "non-fast-forwardable"
  ) {
    return { kind: "non-ff" };
  }
  // Branch-explicit refspec (belt-and-suspenders with the HEAD assertion): push
  // `<default>` to origin regardless of `push.default`.
  const push = await run(["push", "origin", defaultBranch], {
    cwd: repo,
    env: {
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10",
    },
    timeoutMs: GIT_PUSH_TIMEOUT_MS,
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
  // The value the default ref will CAS to: a pure fast-forward (default is an
  // ancestor of base) advances straight to the base tip — NO commit-tree, since
  // feeding an FF tree to commit-tree mints a bogus 2-parent merge. A DIVERGENT base
  // takes the real 3-way plumbing merge.
  let newValue: string;
  if (await gitIsAncestorOf(repo, defaultBranch, baseBranch, run)) {
    newValue = baseTip; // pure fast-forward
  } else {
    // git >= 2.38's `merge-tree --write-tree`; an older git degrades to a DISTINCT
    // transient skip rather than a hard error (worktree mode is default-off, so
    // never a boot fatalExit).
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
    // conflict escalation, > 1 a hard error → the failure arm. merge-tree is
    // tree-vs-tree, so it detects content conflicts equivalently to a porcelain
    // merge without ever touching (or seeing) the working tree.
    if (mt.code === 1) {
      return { kind: "conflict", stderr: (mt.stdout + mt.stderr).trim() };
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
    // Pin the commit dates to the base tip's OWN committer date (never wall-clock)
    // so the merge commit OID is deterministic across a crash-retry.
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
    newValue = newCommit;
  }
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
 * {@link mergeLaneBaseIntoDefault} plumbing ref advance + resync and the
 * {@link recoverWorktrees} pass-1 mid-merge abort. Used when the caller injects no
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
 * Pass 1 (interrupted-merge abort): every linked worktree under each repo (the
 * registered base + ribs) is checked for a stale `MERGE_HEAD`; when present, abort
 * the merge then prune the repo's worktree admin entries. The next reconcile cycle
 * re-runs the merge from a clean tree (level-triggered retry). The SHARED MAIN
 * checkout — invisible to that lane loop (it is on the default branch, not a
 * `keeper/epic/*` lane) — gets its own {@link recoverSharedCheckoutMidMerge} probe:
 * a keeper-owned mid-merge there is self-healed with a flock-guarded abort, a
 * foreign/ambiguous one is named and left alone.
 *
 * Pass 2 (done-but-unmerged backstop): every `keeper/epic/<id>` base branch in
 * each repo whose epic `isEpicDone` reports done but whose base is NOT yet an
 * ancestor of the resolved default branch is merged into default (in the MAIN
 * worktree, on the default branch) + pushed once. Idempotent: an already-merged
 * base is skipped via `merge-base --is-ancestor`. DECOUPLED from the 1800s
 * recent-done window — git is the authority for which bases still need merging.
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
  // is LIVE for the lane's epic. Gates pass-1's interrupted-merge abort AND pass-2's
  // base→default merge — the two actions that would race a resolver mid-`git merge`
  // — so the resolver no longer needs a GLOBAL `keeper autopilot pause`. Defaults to
  // "no resolver" so every existing caller (and the OFF path) is byte-identical. A
  // retargeted content conflict now dispatches a resolver for a DONE epic, so pass-2
  // must skip re-attempting the same merge while that resolver is live.
  hasActiveResolver: (epicId: string) => boolean = () => false,
  // Desync seed sink (see {@link createWorktreeDriver}): called with a repo dir when
  // pass-2's base→default merge advanced the ref but the shared checkout's resync was
  // skipped/aborted, so it trails the default tip. Omitted (direct-call tests) → a no-op.
  onResyncSkipped?: (repoDir: string) => void,
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
      entries = await gitListWorktrees(repo, run);
    } catch (err) {
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
      // registered) is never keeper's to abort-merge or prune, and if its dir was
      // removed out from under git the abort-merge `git` spawn ENOENTs against the
      // vanished cwd — minting a spurious recovery failure. Classify on the branch
      // (a keeper lane IS its `keeper/epic/*` branch), not the path.
      if (!isKeeperLaneEntry(entry)) {
        continue;
      }
      // A LIVE autonomous merge-resolver for this lane's epic is mid-`git merge`
      // (MERGE_HEAD is set by design, not by a crash) — its resolution IS the
      // work. Skip the abort so recover never races it out from under the
      // resolver. The scoped per-epic exclusion that replaced the resolver's old
      // global pause: it auto-lifts the instant that resolver job reaps (clean
      // exit OR crash), and touches no OTHER epic's lane.
      const laneEpicId = epicIdFromKeeperLaneEntry(entry);
      if (laneEpicId !== null && hasActiveResolver(laneEpicId)) {
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
        hasActiveResolver,
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

    // --- Pass 2: merge any done-but-unmerged epic base into the default branch. ---
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
    for (const base of bases) {
      try {
        // TRI-STATE done-probe: pass-2 consumes the full verdict, not a boolean.
        //   open         → finalize owns the base merge; skip, no observation.
        //   inconclusive → a non-result (error) read frame; DEFER — no merge, no
        //                  observation, so an open recover row for (epic,repo) is
        //                  RETAINED (absence of a read is never resolution).
        //   absent       → authoritatively reaped (the pk-lookup bypasses every scope
        //                  / recency floor); the base no longer needs merging — record
        //                  a POSITIVE resolved observation and skip.
        //   done         → attempt the merge (below).
        const verdict = normalizeEpicVerdict(await isEpicDone(base.epicId));
        if (verdict === "open" || verdict === "inconclusive") {
          continue;
        }
        if (verdict === "absent") {
          resolved.push({ epicId: base.epicId, dir: repo });
          continue;
        }
        // A LIVE autonomous merge-resolver owns this base→default merge (a retargeted
        // conflict dispatched it for this now-done epic). Skip so pass-2 never races it
        // mid-`git merge` — mirrors pass-1's abort gate. The gated skip yields no
        // observation, so an open row is retained for free.
        if (hasActiveResolver(base.epicId)) {
          continue;
        }
        // The ONE shared {@link mergeLaneBaseIntoDefault} routine, the same
        // finalize drives. The merge runs in the MAIN worktree (the repo dir).
        // `not-ahead` is the idempotency skip (an already-merged base is an ancestor
        // of default). Every TRANSIENT degrade maps to a `worktree-recover-*` reason:
        // the recover prefix keeps the level-triggered auto-clear scope, so the block
        // lifts the moment the underlying git settles (no `retry_dispatch` needed) —
        // the recover-side analogue of finalize's `retry` skip. A CONTENT CONFLICT is
        // terminal instead: it escalates (below). The shared core stamps NO reason
        // strings; recover owns the `worktree-recover-*` mapping exactly as finalize
        // owns `worktree-finalize-*`.
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
            // TERMINAL. A content conflict leaves the recover auto-clear scope
            // entirely: it escalates on the BARE `close::<epic>` id with finalize's
            // EXACT close-sink reason (`worktree-merge-conflict: …`), so routing
            // classifies it merge-escalation, the resolver-dispatch + merge-escalation
            // sweeps engage, a same-epic finalize close-sink row UPSERT-converges, and
            // only `retry_dispatch` drops it. NOT a `worktree-recover-*` reason — the
            // absence-based auto-clear must never silently dismiss a real conflict.
            escalations.push({
              epicId: base.epicId,
              reason: `worktree-merge-conflict: merging ${base.branch} into ${defaultBranch} — ${merge.stderr}`,
              dir: repo,
            });
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
    // only once its epic is ABSENT (reaped / EpicDeleted) OR done. A lane is BORN
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
    const wtByShortBranch = new Map<string, string>();
    for (const entry of entries) {
      if (entry.branch === null) {
        continue;
      }
      const short = shortBranchName(entry.branch);
      wtByShortBranch.set(short, entry.path);
    }
    for (const lane of laneBranches) {
      // Bases AND ribs share ONE sweep. On a dirty teardown recover ACCUMULATES a
      // failure and continues (never throws) — the recover contract; finalize's
      // inline sweep returns a hard result instead. `kind` labels the reason so a
      // base and a rib stay distinguishable in the failure feed.
      const kind = lane.isRib ? "rib" : "base";
      try {
        if (await epicPresentAndNotDone(lane.epicId)) {
          continue; // epic still active — preserve its lane (finalize reclaims it)
        }
        if (!(await gitIsAncestorOf(repo, lane.branch, defaultBranch, run))) {
          continue; // unmerged lane — leave it for a human, never force-delete
        }
        // Origin-containment guard — the SECOND teardown seam. Pass-3 sweeps
        // WITHOUT mergeLaneBaseIntoDefault, so it runs its own check: a lane merged
        // into LOCAL default whose push timed out is an ancestor of local default
        // yet absent from origin, and deleting it strands the merge
        // (origin/<default> never advances, yet autopilot reports the epic
        // finalized). Verify origin contains it via the cached remote-tracking ref
        // (NO fetch); if origin lacks it, RE-PUSH default (the shared push-only
        // gating) and tear down ONLY after origin provably contains the lane. A
        // push-side degrade DEFERS — a transient `worktree-recover-*` retry-skip
        // INSIDE the auto-clear prefix (no sticky, no teardown), never a delete.
        if (
          !(await gitIsAncestorOf(
            repo,
            lane.branch,
            originDefaultRef(defaultBranch),
            run,
          ))
        ) {
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
          // Post-push origin-containment recheck (the second teardown seam): a
          // push can exit 0 yet leave origin/<default> un-advanced — tear down
          // ONLY once origin PROVABLY contains the lane (cached ref, NO fetch).
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
        const wt = wtByShortBranch.get(lane.branch);
        if (wt !== undefined) {
          const removed = await gitRemoveWorktree(repo, wt, run);
          if (removed.kind === "dirty") {
            failures.push({
              epicId: lane.epicId,
              reason: `worktree-recover-${kind}-teardown-dirty: ${wt} has uncommitted changes — ${removed.stderr}`,
              dir: repo,
            });
            continue;
          }
          // A torn-down lane is a POSITIVE resolution for any open lane pre-merge row
          // / distress keyed on it — the wedge condition is gone, so the self-clearing
          // `work::<taskId>` row clears rather than stranding on a lane that no longer
          // exists (the probe below skips a pruned path, never re-observing it wedged).
          laneResolved.push(wt);
          prunedLanePaths.add(wt);
          // Removed clean (THIS lane's own result): sweep a residue-only `.claude`
          // husk dir git may have left behind. Swallow-and-log — a husk-prune throw
          // must NEVER mint a recover failure row (teardown already succeeded).
          try {
            await gitPruneWorktreeHusk(repo, wt, run);
          } catch (err) {
            console.error(
              `[autopilot-worker] worktree husk prune ${wt}: ${errMsg(err)}`,
            );
          }
          await gitPruneWorktrees(repo, run);
        }
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
    // AFTER the mutating passes settle the tree (pass-1 aborted keeper-owned lane
    // mid-merges; pass-3 tore orphans down), re-classify each SURVIVING keeper lane's
    // base readiness so a persistent not-losslessly-mergeable base surfaces + a
    // resolved one clears — the level-clear that rides the recover pass rather than the
    // next dispatch, so a wedge self-clears even while the owning task is cap-gated /
    // cooled / paused. Reuses pass-1's `entries` (no extra list spawn) and skips the
    // lanes pass-3 tore down. Wrapped so a producer git error never wedges the cycle.
    try {
      const probe = await probeLaneBaseReadiness(
        entries,
        prunedLanePaths,
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
  return { failures, escalations, resolved, laneWedged, laneResolved };
}

/**
 * Probe every SURVIVING keeper lane worktree for fan-in base readiness, returning
 * per-lane `wedged` (still not losslessly-mergeable) + `resolved` (ready) observations
 * keyed by lane PATH — the recover-pass feed for the lane-wedge grace tracker + the
 * verb-agnostic reason-scoped clear. Reuses pass-1's already-fetched `entries` (no
 * second `git worktree list` spawn — the readiness of each lane is re-read LIVE per
 * path, so a lane pass-1 aborted reads clean here) and SKIPS `prunedLanePaths` (a
 * pass-3 teardown already recorded them `resolved`). Producer-only live-git READS,
 * never a fold; NEVER throws past here (a spawn error DEFERS the repo's lanes).
 *
 * Classification per keeper lane (an active-resolver lane is skipped — its MERGE_HEAD
 * is the resolver's deliberate in-progress merge, not a wedge):
 *  - `mid-merge` surviving pass-1's abort → `immediate` wedge (a hard `abort-failed`:
 *    git could not clear it), mints distress AT ONCE (matching finalize's precedent).
 *  - tracked-`dirty` / `off-branch` → graced wedge (a base a human must hand-resolve).
 *  - clean+on-branch but carrying UNTRACKED files → graced wedge: the would-clobber
 *    class {@link mergeReadiness} ignores (`--untracked-files=no`), probed here so a
 *    would-clobber lane row is CLEARED only once the untracked files are gone, never
 *    flap-cleared against a source-agnostic "ready".
 *  - fully clean + on-branch + no untracked → `resolved`.
 */
async function probeLaneBaseReadiness(
  entries: readonly WorktreeEntry[],
  prunedLanePaths: ReadonlySet<string>,
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
      prunedLanePaths.has(entry.path)
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
      // Clean tracked tree on-branch — but a lingering UNTRACKED file is the
      // would-clobber hazard `mergeReadiness` skips. One extra untracked probe so a
      // would-clobber lane stays wedged until it is cleaned (no source needed here).
      const untracked = await run(
        ["status", "--porcelain", "--untracked-files=all"],
        { cwd: entry.path, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
      );
      const hasUntracked =
        untracked.code === 0 &&
        untracked.stdout.split("\n").some((l) => l.startsWith("?? "));
      if (untracked.code === 0 && !hasUntracked) {
        resolved.push(entry.path);
      } else if (hasUntracked) {
        wedged.push({
          path: entry.path,
          reason: `would-clobber: ${entry.path} carries untracked files a fan-in merge could overwrite`,
          immediate: false,
        });
      }
      // A non-zero untracked probe (code !== 0) DEFERS this lane — neither wedged nor
      // resolved (absence retains any open row), never a false clear.
      continue;
    }
    if (ready.kind === "mid-merge") {
      // Survived pass-1's guarded abort → git could not clear it: a hard wedge.
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
export interface SharedWedgeDistressMessage {
  kind: "shared-wedge-distress";
  action: "mint" | "clear";
  id: string;
  dir: string;
  /** Present on `mint` only — starts with the shared-wedge display prefix. */
  reason?: string;
  /** Present on `mint` only — the producer-stamped seconds for re-fold determinism. */
  ts?: number;
}

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

type IncomingMessage =
  | SetPausedMessage
  | ShutdownMessage
  | DispatchedAckMessage;
// `DispatchFailedMessage` / `DispatchedMessage` / `DispatchExpiredMessage` are
// the outgoing wire shapes main consumes; `DispatchedAckMessage` is the reply
// the worker keys against its pending-ack map.

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
): Promise<ReconcileSnapshot> {
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
    epics,
    jobs,
    subagentInvocations,
    gitStatusByProjectDir,
    pendingDispatches,
    unseededRoots,
    maxConcurrentPerRoot,
  } = loadReadinessInputs(db);

  const failedKeys = new Set<DispatchKey>();
  const recoverFailureIds = new Set<string>();
  const finalizeFailureIds = new Set<string>();
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
  // The `(verb, id, dir)` of every OPEN fan-in LANE pre-merge row (reason carries
  // WORKTREE_LANE_PREMERGE_REASON_PREFIX), collected VERB-AGNOSTICALLY off the REASON
  // so the recover pass's level-clear reaches a `work::<taskId>` row the typed router
  // would short-circuit to `work-task` — cleared by lane path, never the dead arm.
  const laneFailures: { verb: Verb; id: string; dir: string }[] = [];
  // The lane PATHS with an OPEN per-lane wedge distress row — the level-clear set the
  // recover pass's lane grace tracker clears against (a lane ready/gone this cycle).
  const laneWedgeDistressDirs = new Set<string>();
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
      failedKeys.add(dispatchKey(verb as Verb, id));
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
      if (isLaneWedgeDistressKey(verb, id)) {
        const dir = (row as { dir?: unknown }).dir;
        if (typeof dir === "string" && dir.length > 0) {
          laneWedgeDistressDirs.add(dir);
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
      switch (route.kind) {
        case "worktree-recover":
          recoverFailureIds.add(id);
          break;
        case "worktree-finalize":
          finalizeFailureIds.add(id);
          break;
        case "work-task":
        case "merge-escalation":
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
  // Live pane id → foreground command, from the SAME sweep — the slot-occupancy gate
  // reads it to tell a live/parked `claude` from the dead `exec $SHELL -l -i` tail.
  // Null in lockstep with `livePaneIds` (degraded/absent probe), so the slot gate
  // stays inert on an un-probeable cycle.
  let paneCommandById: ReadonlyMap<string, string> | null = null;
  if (listPanes !== undefined) {
    try {
      const panes = await listPanes();
      if (panes !== null) {
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
  // Empty whenever the pane probe is degraded (`livePaneIds === null`): with no
  // live-pane set there is nothing to reclaim, so the slot pass stays inert.
  const provenDeadJobIds = new Set<string>();
  if (livePaneIds !== null) {
    for (const job of jobs.values()) {
      if (job.state !== "stopped" || job.pid == null) {
        continue;
      }
      const paneId = job.backend_exec_pane_id;
      if (paneId == null || paneId === "" || !livePaneIds.has(paneId)) {
        continue;
      }
      if (!pidAlive(job.pid)) {
        provenDeadJobIds.add(job.job_id);
      }
    }
  }

  // The PER-ROOT unseeded set (`reconcile` forces UNKNOWN only for rows whose
  // `effectiveRoot` is unseeded, so a stale/failed root never darks the whole
  // board) is resolved by `loadReadinessInputs` above off the autopilot's own read
  // connection — bounded to the `seed_required`-set window, EMPTY while the flag is
  // clear.

  // Resolve the `worker` preset per cycle (cheap single-file parse, fail-safe to
  // the WORKER_* constants) — producer-side launch config, never a fold input.
  const { model: workerModel, effort: workerEffort } =
    resolveWorkerLaunchConfig();

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
  const worktreeRepoByEpicId = worktreeMode
    ? classifyWorktreeRepos(
        epics,
        toplevelResolver,
        assessResolver,
        worktreeEpicGrandfathered,
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

  // The durable MERGE-LANDED set (fn-1016) — purely observational (drives no
  // dispatch arm), probed here so the worker can emit the `lane_merged` projection
  // each cycle. Reuses `worktreeRepoByEpicId`'s already-resolved toplevels (no extra
  // toplevel spawns — only per-repo lane-enumeration + ancestry reads, memoized
  // inside). Gated on `worktreeMode` so an OFF cycle adds ZERO git spawns + emits an
  // empty set (the consumer degrades `landed` → `done`). NEVER throws.
  const landedLaneEntries = worktreeMode
    ? await computeMergedLaneEntries(epics, worktreeRepoByEpicId)
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

  return {
    epics,
    jobs,
    subagentInvocations,
    gitStatusByProjectDir,
    failedKeys,
    recoverFailureIds,
    finalizeFailureIds,
    slotOccupancyFailures,
    sharedWedgeDistressDirs,
    sharedDirtyDistressDirs,
    sharedDesyncDistressDirs,
    laneFailures,
    laneWedgeDistressDirs,
    staleBaseDistressIds,
    dupEpicNumberDistressIds,
    liveTabKeys,
    livePaneIds,
    paneCommandById,
    provenDeadJobIds,
    pendingDispatches,
    mode,
    armedIds,
    unseededRoots,
    workerModel,
    workerEffort,
    maxConcurrentJobs,
    maxConcurrentPerRoot,
    worktreeMode,
    worktreeRepoByEpicId,
    worktreeKnownRoots,
    deferredEpicIds,
    landedLaneEntries,
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
  // identical re-emits; a DispatchCleared resets it. In-worker memory only.
  const dispatchFailedGate = createDispatchFailedGate();
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
        pending.resolve({ ok: msg.ok, suppressed: msg.suppressed });
      }
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
      // Resolution resets the gate so a re-failure of this `(verb, id)` re-emits
      // immediately rather than being folded into a stale suppression window.
      dispatchFailedGate.noteClear(payload.verb, payload.id);
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
      } satisfies SharedWedgeDistressMessage);
    },
    reclaimSlotPane: async (paneId) => {
      // Kill the dead session's window to free its slot. Fire-and-log: killWindow
      // never throws, and a nonzero exit is the benign TOCTOU (the window already
      // died — the outcome we wanted). The visible `slot-reclaimed` failure carries
      // the operator signal regardless.
      const res = await paneOps.killWindow(paneId);
      if (!res.ok && res.error) {
        noteLine(`[autopilot-worker] slot reclaim kill-window: ${res.error}`);
      }
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
    worktree: createWorktreeDriver(gitExec, undefined, (repoDir) => {
      desyncSeedDirs.add(repoDir);
    }),
    // The MAIN-projection done-ness probe finalize gates on (the closer
    // writes `done` to the PRIMARY repo, so the projection is the authority). The
    // same `isEpicDoneById` the recover glue threads into `worktree.recover`.
    isEpicDone: (epicId) => isEpicDoneById(db, epicId),
  };

  // Single-flight reconcile drive. `watchLoop` fires this on every
  // `data_version` pulse; a wake while a cycle runs sets `wakePending` and the
  // running cycle loops once more after it finishes — coalescing a burst into one
  // trailing re-run. Re-entrant-safe: `reconcile` is pure over a fresh snapshot
  // and `runReconcileCycle` owns the one-at-a-time stagger.
  let cycleRunning = false;
  let wakePending = false;
  const driveCycle = async (): Promise<void> => {
    if (cycleRunning) {
      wakePending = true;
      return;
    }
    cycleRunning = true;
    try {
      do {
        wakePending = false;
        if (shutdown) {
          return;
        }
        // Pass the backend's `listPanes` as the read-time liveness probe so the
        // stopped-arm occupancy gate (`isOccupyingJob`) sees which sessions are
        // actually live — a stopped-dead pane no longer wedges its slot.
        const snapshot = await loadReconcileSnapshot(db, () =>
          paneOps.listPanes(),
        );
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
        // fn-1016 — surface the FULL current merge-landed set to the LIVE-ONLY
        // `lane_merged` observable. Once per cycle, regardless of paused/playing
        // (the verdict is observational, not a dispatch action); the dep dedupes so
        // a stable set mints no event, and an empty set (worktree mode OFF, or no
        // merged lanes) clears the table. Wrapped — a post failure must not wedge
        // the wake loop.
        try {
          deps.emitLaneMerged?.(snapshot.landedLaneEntries ?? []);
        } catch (err) {
          console.error(
            "[autopilot-worker] lane-merged emit threw (non-fatal):",
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
        // Producer-only worktree crash/restart recovery, BEFORE the
        // dispatch decision (so the first boot cycle is the post-restart sweep).
        // Gated on worktree mode ON AND not-paused (recovery does git merges +
        // pushes, the same side-effect class the dispatch loop suppresses while
        // paused). Reads ONLY live git + the durable done-ness probe; never a fold.
        // Wrapped so a producer git failure can't wedge the wake loop.
        if (snapshot.worktreeMode && !state.paused && deps.worktree) {
          try {
            const repos = reposForRecovery(
              snapshot.epics,
              snapshot.worktreeRepoByEpicId,
              snapshot.worktreeKnownRoots ?? [],
            );
            const {
              failures,
              escalations,
              resolved,
              laneWedged,
              laneResolved,
            } = await deps.worktree.recover(
              repos,
              // Pass-2's TRI-STATE done-probe — surfaces authoritatively-absent and
              // inconclusive so pass-2 clears vs defers correctly (NOT the boolean
              // `isEpicDoneById`, which collapses both to skip).
              (epicId) => epicRecoverVerdictById(db, epicId),
              (epicId) => epicPresentAndNotDone(db, epicId),
              // Per-epic resolver exclusion (from the SAME snapshot the cycle
              // reconciled): passes 1 AND 2 skip a lane whose epic has a live
              // `resolve::<epic>` worker so its in-progress merge is never raced.
              // A pure projection read (jobs + read-time liveness) — never a fold.
              (epicId) =>
                epicHasActiveResolver(
                  snapshot.jobs,
                  epicId,
                  snapshot.livePaneIds,
                ),
            );
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
              deps.emitDispatchCleared({ verb: "close", id });
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
              deps.clearSharedWedgeDistress?.({ id: c.id, dir: c.dir });
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
              deps.emitDispatchCleared({ verb: c.verb, id: c.id });
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
              deps.clearSharedWedgeDistress?.({ id: c.id, dir: c.dir });
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
            for (const e of snapshot.staleBaseLaneEntries ?? []) {
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
              deps.clearSharedWedgeDistress?.({ id: c.id, dir: c.dir });
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
              deps.clearSharedWedgeDistress?.({ id: c.id, dir: c.dir });
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
                deps.clearSharedWedgeDistress?.({ id: c.id, dir: c.dir });
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
            for (const row of db
              .query("SELECT id FROM dispatch_failures WHERE verb = ?")
              .all(STUCK_SENTINEL_DISTRESS_VERB) as { id: string }[]) {
              if (
                isStuckSentinelDistressKey(STUCK_SENTINEL_DISTRESS_VERB, row.id)
              ) {
                openSentinelIds.add(row.id);
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
                deps.emitDispatchCleared({
                  verb: STUCK_SENTINEL_DISTRESS_VERB,
                  id,
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
        const decision = reconcile(snapshot, state, deps.now());
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
        );
      } while (wakePending && !shutdown);
    } catch (err) {
      // A reconcile/dispatch throw must not wedge the wake loop — log and let
      // the next pulse re-drive (per-launch failures are funnelled to
      // DispatchFailed inside `confirmRunning`; this is the snapshot-load /
      // unexpected-throw backstop).
      console.error("[autopilot-worker] reconcile cycle threw:", err);
    } finally {
      cycleRunning = false;
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
      // Final rollup flush so the on-shutdown denominator lands before exit.
      flushBackstopRollups();
      closeDb();
      process.exit(0);
    })
    .catch((err) => {
      console.error("[autopilot-worker] watch loop crashed:", err);
      clearInterval(rollupTimer);
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

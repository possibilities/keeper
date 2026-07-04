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

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { WORKERS_BASE } from "../plugins/plan/src/subagents_config.ts";
import {
  ConfigError,
  loadPluginSources,
  loadPresetCatalog,
  type Preset,
} from "./agent/config";
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
  isSlotOccupancyReason,
  routeDispatchFailure,
  WORKTREE_FINALIZE_ID_PREFIX,
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
  epicHasActiveResolver,
  FINALIZER_GUARD_S,
  isFinalizerVerb,
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
  type Verb,
  WORKER_EFFORT,
  WORKER_MODEL,
  type WorktreeLaunchInfo,
  type WorktreeRecoveryFailure,
  type WorktreeRepoGroup,
  type WorktreeRepoResolution,
  type WorktreeRepoStatusEntry,
  worktreeRecoverDispatchId,
} from "./reconcile-core";
import { runQuery } from "./server-worker";
import type { Epic } from "./types";
import { watchLoop } from "./wake-worker";
import {
  ELIGIBLE_REASON,
  memoizedAssessRepo,
  type WorktreeEligibility,
} from "./worktree-eligibility";
import {
  type EpicLaneBranchSet,
  epicIdFromKeeperLaneEntry,
  abortInterruptedMerge as gitAbortInterruptedMerge,
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
  mergeBranchInto as gitMergeBranchInto,
  mergeReadiness as gitMergeReadiness,
  pruneWorktreeHusk as gitPruneWorktreeHusk,
  pruneWorktrees as gitPruneWorktrees,
  remotePushFastForwardable as gitRemotePushFastForwardable,
  removeWorktree as gitRemoveWorktree,
  resolveDefaultBranch as gitResolveDefaultBranch,
  isKeeperLaneEntry,
  type LockAcquirer,
  type MergeResult,
  type WorktreeEntry,
} from "./worktree-git";
import { baseBranchFor, repoDirHash, worktreePathFor } from "./worktree-plan";

// The dispatch-failure vocabulary + typed row router live in the dep-free
// `./dispatch-failure-key` leaf; re-exported here so every existing
// `from "./autopilot-worker"` import (tests, daemon) keeps resolving. The snapshot
// loader routes recover/finalize failure rows through `routeDispatchFailure`.
export {
  isSlotOccupancyReason,
  isWorktreeRecoverReason,
  WORKTREE_FINALIZE_ID_PREFIX,
  WORKTREE_RECOVER_REASON_PREFIX,
} from "./dispatch-failure-key";
export type {
  DispatchKey,
  LaneMergedEntry,
  PlannedLaunch,
  ReconcileDecision,
  ReconcileSnapshot,
  ReconcileState,
  ResolverOutcome,
  SlotOccupancyDecision,
  SlotOccupancyInput,
  SlotOccupancySignal,
  Verb,
  WorktreeLaunchInfo,
  WorktreeRecoveryFailure,
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
 * The ABSOLUTE base of the generated per-cell `work`-plugin tree
 * (`${KEEPER_ROOT}/plugins/plan/workers`). Every `--plugin-dir`-selected
 * `work:worker` cell lives UNDER this base; a `work`-named manifest found OUTSIDE
 * it while scanning a claude `plugin_scan_dir` is a shadowing collision that would
 * silently steal the `work:worker` constant from the selected cell.
 */
export const WORKER_CELL_BASE: string = join(
  KEEPER_ROOT,
  "plugins",
  "plan",
  WORKERS_BASE,
);

/**
 * Producer-side scan-dir probe for a non-cell `work`-named plugin that would
 * shadow the launch-time `work:worker` cell. Mirrors the launcher's scan-dir
 * discovery (`discoverPlugins` step 2b — the IMMEDIATE children of each
 * `plugin_scan_dir`) and returns the first child whose
 * `.claude-plugin/plugin.json` is `name: "work"` yet sits OUTSIDE {@link
 * WORKER_CELL_BASE} — such a manifest re-claims the `work:worker` name at launch
 * and shadows the selected cell. Returns the offending manifest path, else null.
 *
 * On-disk I/O by contract — called ONLY from `runReconcileCycle` (the producer),
 * NEVER a `reconcile`/fold arm, so re-fold determinism holds. Fail-safe: an
 * unreadable scan dir / missing or malformed manifest is skipped (not a `work`
 * collision), so a transient fs error never wedges dispatch. Exported for tests.
 */
export function findShadowingWorkManifest(
  scanDirs: readonly string[],
  cellBase: string = WORKER_CELL_BASE,
): string | null {
  const base = resolve(cellBase);
  for (const scanDir of scanDirs) {
    let entries: string[];
    try {
      entries = readdirSync(scanDir).sort();
    } catch {
      // Missing/unreadable scan dir — skipped, mirroring `discoverPlugins`.
      continue;
    }
    for (const name of entries) {
      const pluginDir = join(scanDir, name);
      const manifest = join(pluginDir, ".claude-plugin", "plugin.json");
      let data: { name?: string };
      try {
        if (!statSync(pluginDir).isDirectory()) {
          continue;
        }
        data = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      } catch {
        // No manifest / malformed JSON — not a `work` collision.
        continue;
      }
      if (data.name !== "work") {
        continue;
      }
      // A cell manifest under the generated base IS the legitimate `work:worker`
      // source (a scan dir may point straight at the workers tree) — never a shadow.
      if (resolve(pluginDir).startsWith(base + sep)) {
        continue;
      }
      return manifest;
    }
  }
  return null;
}

/**
 * Default {@link ConfirmRunningDeps.probeShadowingWorkManifest} impl: read the
 * launcher plugin config and scan its real `plugin_scan_dirs` for a shadowing
 * non-cell `work` manifest. Fail-safe on a missing/invalid config (mirrors
 * `resolveWorkerLaunchConfig`'s swallow-to-constants posture) — no scan dirs
 * means nothing to shadow. Producer-only; runs on the worker's reconcile path.
 */
function defaultShadowingWorkProbe(): string | null {
  let scanDirs: readonly string[];
  try {
    scanDirs = loadPluginSources().pluginScanDirs;
  } catch (err) {
    if (err instanceof ConfigError) {
      return null;
    }
    throw err;
  }
  return findShadowingWorkManifest(scanDirs);
}

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
 * Level-triggered auto-clear set: given the OPEN recover-originated dispatch ids
 * (`snapshot.recoverFailureIds`) and THIS cycle's fresh recover failures, return
 * the ids whose underlying git has since resolved (the junk branch was deleted,
 * the conflict was merged, or the epic was reaped) — i.e. an open recover row
 * with NO matching fresh failure this cycle. The caller mints a `DispatchCleared`
 * for each so a human just fixes the git and the next cycle clears the block, no
 * `retry_dispatch`. Pure: a function of the two inputs, no git, no clock.
 */
export function recoverFailuresToClear(
  openRecoverIds: ReadonlySet<string>,
  freshFailures: readonly WorktreeRecoveryFailure[],
): string[] {
  const stillFailing = new Set<string>();
  for (const f of freshFailures) {
    stillFailing.add(recoverFailureDispatchId(f));
  }
  const cleared: string[] = [];
  for (const id of openRecoverIds) {
    if (!stillFailing.has(id)) {
      cleared.push(id);
    }
  }
  return cleared;
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
   * resolved worktree path on success (the producer overrides the launch cwd with
   * it) or a `{ failed: <reason> }` the producer mints as a sticky DispatchFailed.
   */
  provision(
    info: WorktreeLaunchInfo,
  ): Promise<{ ok: true; cwd: string } | { ok: false; reason: string }>;
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
   * Returns the failures (if any) for the caller to mint as sticky DispatchFailed;
   * a recovery failure NEVER throws past the driver (a producer git error must not
   * wedge the cycle).
   */
  recover(
    repos: readonly string[],
    isEpicDone: (epicId: string) => Promise<boolean>,
    epicPresentAndNotDone: (epicId: string) => Promise<boolean>,
    hasActiveResolver: (epicId: string) => boolean,
  ): Promise<WorktreeRecoveryFailure[]>;
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
 * SATISFIED same-resolved-repo upstream GROUP is not yet contained in that repo's
 * LOCAL default branch (so cutting the lane would fork it off a stale base, inverting
 * merge order). Producer-side + git-touching — probed ONCE per cycle in
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
 * `keeper/epic/A` merge state in `repoR`. UNION semantics — B defers `repoR` if ANY
 * such upstream group is unmerged OR its probe is inconclusive. A downstream group
 * whose repo has NO matching upstream group is absent from the map and proceeds; a
 * cross-repo upstream (a lane in a DIFFERENT repo) never gates `repoR`.
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
 * (not-gating), mirroring {@link computeEligibleEpics}; the probe NEVER throws out of
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
          // Only a SATISFIED (done) upstream can already carry a lane to merge; a
          // blocked-incomplete / dangling dep blocks B through the normal readiness
          // gate, never here.
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
 *  - DEFINITIVELY ABSENT (a SUCCESSFUL enumeration that omits it) → merged-and-
 *    torn-down (keeper deletes a base only once it is an ancestor of default) →
 *    MERGED;
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
 * its repo's local default (the same per-group probe as `ok`); a `serial` group
 * (cuts no lane, lands incrementally on the shared checkout) when ALL its tasks are
 * administratively done (`worker_phase === "done"`). The producer holds the full
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
  //  - lane DEFINITIVELY ABSENT ∧ the epic ever started → merged-and-torn-down →
  //    MERGED (no ancestry probe); DEFINITIVELY ABSENT ∧ never started → NOT
  //    merged (the lane was never cut, not torn down after a merge — inferring
  //    merged here fires `landed` spuriously on a fresh dep-blocked epic);
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
      // DEFINITIVELY absent → merged-and-torn-down → MERGED, but ONLY if the epic
      // ever started. A never-started epic's lane is absent because it was never
      // cut, so absence proves nothing about merge (keep `landed` waiting).
      return epicHasStarted;
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
    // A never-started epic never cut a lane, so an absent lane must NOT read as
    // merged-and-torn-down. `status === "done"` is a belt-and-suspenders disjunct
    // (a done epic must have started) so a done epic always reports landed.
    const started = epicStarted(epic) || epic.status === "done";
    try {
      if (resolution.kind === "ok") {
        // Present-arm emptiness guard: this single lane carries landed work only
        // once ALL the epic's tasks are administratively done (`worker_phase` — the
        // terminal-completed signal the clustered serial-group arm keys). A started-
        // but-unworked epic's lane sits empty at its fork point, so without this its
        // vacuous ancestry would false-fire `landed`. A task-less epic is vacuously
        // done (a present + merged lane still reads landed unchanged).
        const tasksDone = epic.tasks.every((t) => t.worker_phase === "done");
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
      // early emit on the first group merging). `worktree` group → its lane merged;
      // `serial` group → all its tasks administratively done (`worker_phase` — the
      // signal readiness's terminal-completed keys on; liveness is irrelevant to a
      // landed milestone). The row's `repo_dir` carries `primaryRepoDir`
      // (observational only — the projection is keyed on epic_id).
      const taskById = new Map(epic.tasks.map((t) => [t.task_id, t]));
      let allLanded = true;
      for (const group of resolution.groups) {
        const groupLanded =
          group.mode === "worktree"
            ? // A `worktree` group's landed verdict rides the lane-merge signal per
              // the clustered aggregation contract (`laneCarriesLandedWork: true`);
              // the empty-lane guard is scoped to the single-lane `ok` waiter, and
              // shifting the clustered per-group contract is out of scope here.
              await laneMergedInRepo(group.repoDir, laneBranch, started, true)
            : group.taskIds.every(
                (id) => taskById.get(id)?.worker_phase === "done",
              );
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
  // Scan-dir shadow probe — resolved once, memoized across the loop (the scan dirs
  // are cycle-invariant). `undefined` = not yet probed; a first `work`-cell launch
  // triggers the single on-disk scan, so a cycle with no cell launches never reads
  // the plugin config. Producer read (never a fold).
  const probeShadow =
    deps.probeShadowingWorkManifest ?? defaultShadowingWorkProbe;
  let shadowManifest: string | null | undefined;
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
    // `worktreeReject` / `cwd-missing` per-key skip shape). Both mint a sticky
    // `DispatchFailed` (cleared by `retry_dispatch`) so a doomed launch never
    // burns a cold boot, and a sibling launch keeps dispatching.
    //   (1) an out-of-matrix {model, effort} the pure compose flagged, and
    //   (2) a cell whose generated plugin manifest is absent — `claude
    //       --plugin-dir` would fall back to the dir basename and `/plan:work`
    //       could not resolve `work:worker`. Remediation: regenerate the tree.
    if (plan.pluginDirReject !== undefined) {
      deps.emitDispatchFailed({
        verb: plan.verb,
        id: plan.id,
        reason: `worker-cell-invalid: ${plan.pluginDirReject}`,
        dir: plan.cwd,
        ts: deps.now(),
      });
      continue;
    }
    if (plan.pluginDir != null) {
      const manifest = join(plan.pluginDir, ".claude-plugin", "plugin.json");
      if (!dirExists(manifest)) {
        deps.emitDispatchFailed({
          verb: plan.verb,
          id: plan.id,
          reason:
            `worker-cell-missing: ${plan.pluginDir} — regenerate via ` +
            `'keeper prompt render-plugin-templates --project-root ` +
            `${join(KEEPER_ROOT, "plugins", "plan")}' (without the cell manifest ` +
            `claude --plugin-dir falls back to the dir basename and '/plan:work' ` +
            `cannot resolve 'work:worker')`,
          dir: plan.cwd,
          ts: deps.now(),
        });
        continue;
      }
      // (3) a non-cell `work`-named plugin sitting in a claude `plugin_scan_dir`
      // re-claims the `work:worker` constant at launch and silently shadows
      // the `--plugin-dir`-selected cell. Probe the REAL scan dirs (not just the repo) and mint a
      // sticky `work-plugin-shadowed` `DispatchFailed` (per-key, cleared by
      // `retry_dispatch`) rather than spawn the wrong worker. On-disk read here in
      // the producer, memoized once per cycle — never a fold.
      if (shadowManifest === undefined) {
        shadowManifest = probeShadow();
      }
      if (shadowManifest != null) {
        deps.emitDispatchFailed({
          verb: plan.verb,
          id: plan.id,
          reason:
            `work-plugin-shadowed: ${shadowManifest} — a non-cell 'work'-named ` +
            `plugin in a claude plugin_scan_dir would steal 'work:worker' from ` +
            `the '${plan.pluginDir}' cell at launch (silent wrong-worker spawn); ` +
            "remove or rename it, then 'keeper retry-dispatch'",
          dir: plan.cwd,
          ts: deps.now(),
        });
        continue;
      }
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
      const wt = await runWorktreeProducerStep(plan, launchCwd, deps.worktree);
      if (!wt.ok) {
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
      const provisioned = await deps.worktree.provision(sink);
      if (!provisioned.ok) {
        provisionFailed.add(`${closeKeyEpicId(sink)} ${sink.repoDir}`);
        deps.emitDispatchFailed({
          verb: "close",
          id: closeKeyEpicId(sink),
          reason: provisioned.reason,
          dir: sink.repoDir,
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
): Promise<
  { ok: true; cwd: string } | { ok: false; reason: string; dir: string }
> {
  if (plan.worktree !== undefined) {
    const provisioned = await driver.provision(plan.worktree);
    if (!provisioned.ok) {
      return { ok: false, reason: provisioned.reason, dir: launchCwd };
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
): WorktreeDriver {
  return {
    async provision(info) {
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
          // not-ahead (already merged) / merged → proceed to teardown.
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
          const short = entry.branch.startsWith("refs/heads/")
            ? entry.branch.slice("refs/heads/".length)
            : entry.branch;
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
 * The ONE guarded lane-base→default merge sequence shared by
 * {@link WorktreeDriver.finalizeEpic} and {@link recoverWorktrees} pass-2. Runs IN
 * the main checkout (`repo`, already resolved to be on `defaultBranch`) and never
 * stamps a reason string — it returns a {@link MergeLaneResult} discriminant the
 * caller maps to its own reason family. Ordered ahead-check → mergeReadiness →
 * turn-key-push precheck → non-ff precheck → merge → push:
 *  - ahead-check: the base must carry real commits (NOT already an ancestor of
 *    default) → `not-ahead` is the idempotent already-merged no-op.
 *  - mergeReadiness degrades a dirty / off-branch / would-clobber shared checkout.
 *  - the AUTHORITATIVE turn-key probe runs FIRST (it admits a legitimate first
 *    push to a never-pushed default via its dry-run); the cached-ref non-ff
 *    precheck then blocks ONLY a PROVEN non-fast-forward (`"non-fast-forwardable"`)
 *    — an `"unknown"` unresolved `origin/<default>` defers to turn-key, never a
 *    permanent skip. Both gate BEFORE the local merge so a push that cannot land
 *    never advances local default into a merge-then-die state.
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
  const ready = await gitMergeReadiness(repo, defaultBranch, run, baseBranch);
  if (ready.kind === "off-branch") {
    return { kind: "off-branch", head: ready.head };
  }
  if (ready.kind === "dirty") {
    return { kind: "dirty", detail: ready.detail };
  }
  // A mid-merge shared checkout is not-ready — surface the DISTINCT classification
  // (mergeHead + ownership + autostash) so recover/finalize name it and recover
  // pass-1 self-heals a keeper-owned one. NO LONGER folded into `dirty`: that fold
  // was the incident's core regression — the wedge read as a generic dirty-checkout
  // skip the recover/finalize pass retried forever without ever escalating.
  if (ready.kind === "mid-merge") {
    return {
      kind: "mid-merge",
      mergeHead: ready.mergeHead,
      owner: ready.owner,
      autostash: ready.autostash,
    };
  }
  if (ready.kind === "would-clobber") {
    return { kind: "would-clobber", paths: ready.paths };
  }
  // Authoritative turn-key probe FIRST — it admits a legitimate first push to a
  // never-pushed default via its dry-run and carries the accurate reason.
  const pushReady = await remotePushTurnKey(repo, run);
  if (!pushReady.ready) {
    return { kind: "not-turn-key", reason: pushReady.reason };
  }
  // Cached-ref non-ff precheck second: block ONLY a PROVEN non-fast-forward. An
  // `"unknown"` unresolved origin/<default> (never-pushed default) defers to the
  // turn-key verdict above rather than minting a false permanent non-FF skip.
  if (
    (await gitRemotePushFastForwardable(repo, defaultBranch, run)) ===
    "non-fast-forwardable"
  ) {
    return { kind: "non-ff" };
  }
  const merge: MergeResult = acquireLock
    ? await gitMergeBranchInto(repo, baseBranch, run, acquireLock)
    : await gitMergeBranchInto(repo, baseBranch, run);
  if (merge.kind === "conflict") {
    return { kind: "conflict", stderr: merge.stderr };
  }
  // The guarded `git merge --abort` after a conflict/timeout ITSELF failed — the
  // shared checkout is left mid-merge (MERGE_HEAD + unresolved paths), DISTINCT
  // from a cleanly-aborted `conflict`. Surface it so the caller escalates the
  // un-cleared wedge with its own reason rather than mislabeling it a conflict.
  if (merge.kind === "abort-failed") {
    return { kind: "abort-failed", stderr: merge.stderr };
  }
  // A bounded-lock or local-op (blocking hook) timeout means NO merge landed —
  // surface the transient degrade so the caller skip-retries; NEVER fall through
  // to the push (which would advance origin past an un-merged base).
  if (merge.kind === "lock-timeout") {
    return { kind: "lock-timeout" };
  }
  if (merge.kind === "local-timeout") {
    return { kind: "local-timeout" };
  }
  // Branch-explicit push, NOT a bare `push`: under `push.default=simple` a
  // no-refspec push targets the CURRENT HEAD's upstream, so off-default it would
  // push the wrong ref (or "Everything up-to-date", exit 0) while origin/<default>
  // never advances — then the caller tears down on a false `pushed` and strands the
  // merge. pushDefaultToOrigin asserts HEAD==default, fails fast on a credential /
  // connect stall (BatchMode + ConnectTimeout), and surfaces a timeout as the
  // TRANSIENT push-timeout, never the sticky push-failed.
  const pushed = await pushDefaultToOrigin(repo, defaultBranch, run);
  if (pushed.kind !== "pushed") {
    return pushed; // off-branch / non-ff / timeout / failed / not-turn-key → caller defers
  }
  // Post-push origin-containment recheck — the SAME guard the not-ahead arm runs: a
  // push can exit 0 yet leave origin/<default> un-advanced (e.g. "Everything
  // up-to-date" on a stale ref). Confirm `merged` (teardown-safe) ONLY once origin
  // PROVABLY contains the just-merged base (cached remote-tracking ref, NO fetch);
  // otherwise degrade to the EXISTING push-unconfirmed retry-skip so the caller
  // defers teardown, never tears the base down off a false `pushed`.
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
 * The default bounded commit-work flock acquirer for the recover pass's shared
 * main-checkout abort — the {@link recoverWorktrees} sibling of the acquirer
 * {@link mergeBranchInto} bakes in. Used when the caller injects no `acquireLock`
 * (production), so the abort ALWAYS serializes against a concurrent `keeper
 * commit-work` in the SAME checkout; a bounded deadline degrades a stuck holder to
 * a defer, never a frozen cycle. The fast tier injects a stub instead.
 */
const defaultRecoverLockAcquirer: LockAcquirer = (lockPath) =>
  CommitWorkLock.acquireWithDeadline(lockPath);

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
 * a lock-timeout degrades to a defer, never a blind abort; a failed abort surfaces its
 * own `worktree-recover-abort-failed` reason (the un-cleared wedge). Only ever reached
 * while the board is PLAYING — the caller gates the whole recover sweep on `!paused`.
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
  const owningEpics =
    refsAt.code === 0
      ? refsAt.stdout
          .split("\n")
          .map((ref) =>
            epicIdFromKeeperLaneEntry({
              path: repo,
              branch: ref.trim(),
              head: null,
              bare: false,
            }),
          )
          .filter((e): e is string => e !== null)
      : [];
  if (owningEpics.some((e) => hasActiveResolver(e))) {
    return null; // a live resolver owns this merge — leave it; the exclusion auto-lifts
  }
  // Abort under the commit-work flock so it never races a concurrent agent commit in
  // the SAME shared checkout (the incident's hazard). A lock-timeout degrades to a
  // defer — NEVER a blind abort.
  const acquire = acquireLock ?? defaultRecoverLockAcquirer;
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
  isEpicDone: (epicId: string) => Promise<boolean>,
  run: WorktreeGitRunner = gitExec,
  acquireLock?: LockAcquirer,
  epicPresentAndNotDone: (epicId: string) => Promise<boolean> = () =>
    Promise.resolve(true),
  // Per-epic exclusion: true while an autonomous merge-resolver (`resolve::<epic>`)
  // is LIVE for the lane's epic. Gates ONLY pass-1's interrupted-merge abort — the
  // one action that would race a resolver mid-`git merge` — so the resolver no
  // longer needs a GLOBAL `keeper autopilot pause`. Defaults to "no resolver" so
  // every existing caller (and the OFF path) is byte-identical. Passes 2/3 need no
  // gate: both act only on a done/absent epic, but a resolver runs while its epic
  // is still open (resolution precedes the close→finalize→done that marks it done).
  hasActiveResolver: (epicId: string) => boolean = () => false,
): Promise<WorktreeRecoveryFailure[]> {
  const failures: WorktreeRecoveryFailure[] = [];
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
        if (!(await isEpicDone(base.epicId))) {
          continue; // epic still open — its base is merged by `finalizeEpic`, not here
        }
        // The ONE shared {@link mergeLaneBaseIntoDefault} routine, the same
        // finalize drives. The merge runs in the MAIN worktree (the repo dir).
        // `not-ahead` is the idempotency skip (an already-merged base is an ancestor
        // of default). Every degrade maps to a `worktree-recover-*` reason: the
        // recover prefix keeps the level-triggered auto-clear scope, so the block
        // lifts the moment the underlying git settles (no `retry_dispatch` needed) —
        // the recover-side analogue of finalize's `retry` skip. The shared core
        // stamps NO reason strings; recover owns the `worktree-recover-*` mapping
        // exactly as finalize owns `worktree-finalize-*`.
        const merge = await mergeLaneBaseIntoDefault(
          repo,
          base.branch,
          defaultBranch,
          run,
          acquireLock,
        );
        switch (merge.kind) {
          case "not-ahead":
          case "merged":
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
            failures.push({
              epicId: base.epicId,
              reason: `worktree-recover-conflict: merging ${base.branch} into ${defaultBranch} — ${merge.stderr}`,
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
      const short = entry.branch.startsWith("refs/heads/")
        ? entry.branch.slice("refs/heads/".length)
        : entry.branch;
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
  }
  return failures;
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
 * The done-ness probe the recovery backstop threads into the driver.
 * A pk-lookup read of the `epics` projection by `epic_id` (which bypasses the
 * default OPEN scope AND any recency floor in `resolveFilter`), so a DONE epic is
 * resolved UNBOUNDED by `DONE_EPICS_REAP_WINDOW_SEC` — the whole point of the
 * decoupled backstop. Returns `true` IFF the epic exists and `status === "done"`.
 * A read-time producer probe (never a fold).
 */
export function isEpicDoneById(
  db: Parameters<typeof runQuery>[0],
  epicId: string,
): Promise<boolean> {
  const frame = {
    type: "query" as const,
    collection: "epics",
    id: `autopilot-recover-epic-${epicId}`,
    filter: { epic_id: epicId },
    limit: 1,
  };
  const res = runQuery(db, 0, frame);
  const rows = res.type === "result" ? res.rows : [];
  const status = (rows[0] as { status?: unknown } | undefined)?.status;
  return Promise.resolve(status === "done");
}

/**
 * The present-and-not-done probe pass-3 teardown threads in to PRESERVE an active
 * epic's lanes. CLONES {@link isEpicDoneById}'s pk-bypass query frame (collection
 * `epics`, `filter:{epic_id}`, `runQuery(db, 0, …)`) so it bypasses the default
 * OPEN scope AND any recency floor in `resolveFilter` — a live in_progress/blocked
 * epic resolves PRESENT here, never absent. That bypass is load-bearing: a scoped
 * or `DONE_EPICS_REAP_WINDOW_SEC`-bounded read would read a live epic as ABSENT and
 * FALSELY sweep its base mid-flight (the most dangerous misread). Returns `true`
 * IFF the epic row exists AND `status !== "done"`; an ABSENT (reaped / EpicDeleted)
 * OR a done epic → `false` (eligible to sweep). A read-time producer probe (never a
 * fold).
 */
export function epicPresentAndNotDone(
  db: Parameters<typeof runQuery>[0],
  epicId: string,
): Promise<boolean> {
  const frame = {
    type: "query" as const,
    collection: "epics",
    id: `autopilot-recover-epic-present-${epicId}`,
    filter: { epic_id: epicId },
    limit: 1,
  };
  const res = runQuery(db, 0, frame);
  const rows = res.type === "result" ? res.rows : [];
  const row = rows[0] as { status?: unknown } | undefined;
  return Promise.resolve(row !== undefined && row.status !== "done");
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
  for (const row of read("dispatch_failures")) {
    const verb = (row as { verb?: unknown }).verb;
    const id = (row as { id?: unknown }).id;
    if (typeof verb === "string" && typeof id === "string") {
      failedKeys.add(dispatchKey(verb as Verb, id));
      const reason = (row as { reason?: unknown }).reason;
      const reasonStr = typeof reason === "string" ? reason : "";
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
    liveTabKeys,
    livePaneIds,
    paneCommandById,
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
    // directly, not a plan-worker subagent's Bash.
    worktree: createWorktreeDriver(),
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
            const failures = await deps.worktree.recover(
              repos,
              (epicId) => isEpicDoneById(db, epicId),
              (epicId) => epicPresentAndNotDone(db, epicId),
              // Per-epic resolver exclusion (from the SAME snapshot the cycle
              // reconciled): pass-1 skips a lane whose epic has a live
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
            // Level-triggered auto-clear: a recover failure is a permanent state
            // for the current refs — fail LOUD and block the lane, but the moment
            // the git is resolved (junk branch deleted / conflict merged / epic
            // reaped) the next cycle observes NO matching failure and clears the
            // sticky row, so a human never needs `retry_dispatch`. Scoped to
            // recover-reason rows (recoverFailureIds) so a normal close-sink
            // failure sharing the `close::<id>` key is never clobbered. Runs ONLY
            // inside this not-paused worktree-mode block — i.e. only when the
            // recover pass actually ran — so a pause never clears a live block.
            for (const id of recoverFailuresToClear(
              snapshot.recoverFailureIds,
              failures,
            )) {
              deps.emitDispatchCleared({ verb: "close", id });
            }
          } catch (err) {
            console.error(
              "[autopilot-worker] worktree recovery threw (non-fatal):",
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

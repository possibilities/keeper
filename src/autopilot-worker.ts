/**
 * Autopilot reconciler worker. Runs as a Bun Worker thread; drives the
 * level-triggered dispatch loop server-side: a `data_version` pulse wakes
 * `reconcile(snapshot, state)`, which for each row whose verdict wants a verb
 * emits a `PlannedLaunch` unless a suppression arm fires (see `reconcile`), then
 * `confirmRunning` launches and confirms each one.
 *
 * `confirmRunning` captures the `events.id` watermark BEFORE the launch (so a
 * stale/resumed `jobs` row for the same `(plan_verb, plan_ref)` is excluded —
 * only a post-watermark SessionStart proves THIS dispatch landed), mints a
 * durable `Dispatched` intent and BLOCKS on its ack BEFORE launching (outbox
 * ordering closes the SessionStart-drains-before-`Dispatched` race), then polls
 * `findJob` until a bind lands or the ceiling elapses. See `ConfirmOutcome` for
 * the five-way result.
 *
 * Correlation: the reducer derives `(plan_verb, plan_ref)` from the `--name
 * verb::id` baked into the worker argv at SessionStart. There is NO
 * `jobs.spawn_name` column — the pair IS the correlation, so confirm/dedup gates
 * on `plan_verb` too (not just `plan_ref`).
 *
 * Determinism: the reconciler NEVER writes a projection — it mints synthetic
 * events (via deps that bridge to main, the sole events-log writer); the reducer
 * folds them. The producer-side `ts` (`deps.now()`) is stamped at reconcile time
 * so a re-fold reproduces the projection byte-identically. Wall-clock and
 * liveness probes are confined to the reconcile/confirm paths — NOTHING that
 * feeds a fold reads them.
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
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
// Shared with the plan plugin's renderer so the launch-time `--plugin-dir` cell
// selection and the generated `plugins/plan/workers/<model>-<effort>` tree can't
// drift: `workerAgentFor` supplies the matrix-validated throw + null-either-axis
// stop; `workerCellDir` supplies the SINGLE cell-path convention.
import { workerAgentFor } from "../plugins/plan/src/models.ts";
import {
  WORKERS_BASE,
  workerCellDir,
} from "../plugins/plan/src/subagents_config.ts";
import {
  ConfigError,
  loadPluginSources,
  loadPresetCatalog,
  type Preset,
} from "./agent/config";
import { computeEligibleEpics } from "./armed-closure";
import {
  BackstopCounters,
  type BackstopMessage,
  buildTimeoutRecord,
} from "./backstop-telemetry";
import {
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
  readGitProjectionFloor,
  readGitProjectionSeedRequired,
} from "./db";
import { defaultPlanPrompt } from "./dispatch-command";
import {
  createTmuxPaneOps,
  keeperAgentLaunch,
  type LaunchSpec,
  MANAGED_EXEC_SESSION,
  type PaneInfo,
} from "./exec-backend";
import { unseededGatedRoots } from "./gated-roots";
import {
  localBranchExists,
  memoizedGitToplevel,
  memoizedNullableGitToplevel,
} from "./git-toplevel";
import {
  computeReadiness,
  isRootOccupant,
  orderEpicsForScheduling,
  type PendingDispatch,
  type Verdict,
} from "./readiness";
import {
  collapseSubagentsByName,
  projectGitStatusByProjectDir,
  projectPendingDispatches,
} from "./readiness-client";
import type { LaneMergedEntry, WorktreeRepoStatusEntry } from "./reducer";
import { runQuery } from "./server-worker";
import type { Epic, GitStatus, Job, SubagentInvocation, Task } from "./types";
import { watchLoop } from "./wake-worker";
import {
  ELIGIBLE_REASON,
  memoizedAssessRepo,
  type WorktreeEligibility,
} from "./worktree-eligibility";
import {
  type EpicLaneBranchSet,
  abortInterruptedMerge as gitAbortInterruptedMerge,
  branchExists as gitBranchExists,
  classifyLinkedWorktree as gitClassifyLinkedWorktree,
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
  pruneWorktrees as gitPruneWorktrees,
  remotePushFastForwardable as gitRemotePushFastForwardable,
  removeWorktree as gitRemoveWorktree,
  resolveDefaultBranch as gitResolveDefaultBranch,
  isKeeperLaneEntry,
  type LockAcquirer,
  type MergeResult,
  type WorktreeEntry,
} from "./worktree-git";
import {
  baseBranchFor,
  CLOSE_SINK_ID,
  deriveWorktreePlan,
  repoDirHash,
  type WorktreeAssignment,
  WorktreeCycleError,
  type WorktreePlan,
  worktreePathFor,
} from "./worktree-plan";

/**
 * The two `keeper plan` verbs the reconciler dispatches: `work` for a `ready` task
 * row, `close` for a `ready` close row. The argv shape's single source of truth
 * is `cli/autopilot.ts`.
 */
export type Verb = "work" | "close";

/**
 * The dedup / in-flight key — exactly `${verb}::${id}`, matching the `--name`
 * baked into the worker argv (also the tmux window name).
 */
export type DispatchKey = string;

/**
 * The in-process re-dispatch cooldown window, in SECONDS — the fold-lag-immune
 * suppression arm. The projection-backed dedup arms (`failedKeys`,
 * `isOccupyingJob`, `liveTabKeys`) all read PROJECTIONS; when the reducer lags
 * behind reality every one is blind to a dispatch that already fired and the
 * same key re-launches. The cooldown holds a just-dispatched key suppressed for
 * this window regardless of projection lag, until the durable arms catch up. It
 * is ADDITIVE, never the sole suppressor.
 *
 * Set STRICTLY GREATER than `PENDING_DISPATCH_TTL_MS / 1000` (120) + the sweep
 * granularity (60): the window must outlast the WHOLE round-trip (the pending
 * row surviving a full TTL, then the sweep tick that mints `DispatchExpired`).
 * A window shorter than the lag re-introduces over-dispatch at expiry.
 *
 * UNIT TRAP (a 1000x bug if mixed up): `reconcile`'s `now` is unix SECONDS
 * (`deps.now` = `Math.floor(Date.now()/1000)`). This constant and the cooldown
 * Map's timestamps are ALL in seconds. NEVER compare them against the ms-valued
 * `*_TTL_MS` constants directly.
 */
export const REDISPATCH_COOLDOWN_S = 200;

/**
 * The in-process per-epic FINALIZER guard window, in SECONDS — keyed by EPIC ID,
 * a fold-lag-immune backstop against a `close` re-dispatch (also covered by the
 * same-key cooldown; retained against any future second finalizer verb). Stamps
 * BEFORE the confirm await, read in the pure `reconcile`, swept in `driveCycle`.
 * Tracks `REDISPATCH_COOLDOWN_S` for the same round-trip-headroom reason. UNIT:
 * SECONDS throughout.
 */
export const FINALIZER_GUARD_S = REDISPATCH_COOLDOWN_S;

/** The sole epic-level finalizer verb the per-epic guard serializes. */
const FINALIZER_VERBS: ReadonlySet<Verb> = new Set<Verb>(["close"]);

/**
 * `true` IFF the epic-level finalizer for `epicId` is `close` (the sole
 * finalizer verb). A close-row verdict mapping to `null` is not a finalizer and
 * is never stamped or gated.
 */
export function isFinalizerVerb(verb: Verb | null): verb is Verb {
  return verb !== null && FINALIZER_VERBS.has(verb);
}

/**
 * Pure per-epic finalizer-guard predicate. `true` IFF a finalizer (`close`) for
 * `epicId` was dispatched within the last `FINALIZER_GUARD_S` seconds. An absent
 * entry is NOT guarded. Mirrors {@link isInCooldown}: read inside the pure
 * `reconcile`; the Map is mutated only in the cycle glue.
 */
export function isFinalizerGuarded(
  guard: Map<string, number>,
  epicId: string,
  now: number,
): boolean {
  const stampedAt = guard.get(epicId);
  return stampedAt !== undefined && now - stampedAt < FINALIZER_GUARD_S;
}

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
 * The keeper repo root — the checkout that owns the generated
 * `plugins/plan/workers/<model>-<effort>` cell tree. A worktree / cross-repo
 * worker runs with its cwd in ANOTHER repo, so the `--plugin-dir` cell path the
 * autopilot bakes into a launch must be ABSOLUTE and cwd-independent (a relative
 * `plugins/plan/workers/...` would resolve against the worker's target repo, not
 * keeper's). Derived from THIS module's location (`src/…` → `..`) and
 * `realpath`'d so the daemon's own cwd/PATH can't break it; env-overridable via
 * `KEEPER_ROOT` (for tests + a non-default checkout), tilde-expanded eagerly at
 * module load. Mirrors the `resolveKeeperAgentPathDepFree` derive-from-module
 * shape.
 */
export const KEEPER_ROOT: string = ((): string => {
  const raw = process.env.KEEPER_ROOT;
  if (raw != null && raw !== "") {
    const v =
      raw === "~"
        ? homedir()
        : raw.startsWith("~/")
          ? join(homedir(), raw.slice(2))
          : raw;
    return v;
  }
  const derived = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    return realpathSync(derived);
  } catch {
    return derived;
  }
})();

/**
 * Resolve the ABSOLUTE per-cell worker plugin dir for a task's {model, effort}
 * pair — `${KEEPER_ROOT}/plugins/plan/workers/<model>-<effort>`. The launcher
 * points `claude --plugin-dir` here so the worker session loads exactly the one
 * `work` plugin matching the task.
 *
 * Returns `null` when EITHER axis is null (a task carrying no tier or no model,
 * or a `close` row) — the null return is load-bearing: it preserves the
 * null-either-axis stop and leaves the launch with no `--plugin-dir` (falling
 * back to the always-loaded `plan` plugin). THROWS for a non-null value outside
 * the configured matrix (reusing {@link workerAgentFor}'s corrupt-on-disk guard)
 * rather than blind-joining a bogus cell path — the caller catches the throw and
 * turns it into a visible sticky `DispatchFailed`, never an opaque
 * agent-not-found inside a spawned session. Pure: `subagentsMatrix()` is a
 * memoized embed parse (no I/O) and `KEEPER_ROOT` is resolved once at load.
 */
export function workerCellPluginDir(
  model: string | null,
  tier: string | null,
): string | null {
  // Validate the pair against the matrix (throws on out-of-matrix) and reuse the
  // null-either-axis stop — the composed agent name itself is discarded here.
  if (workerAgentFor(tier, model) === null) {
    return null;
  }
  // Non-null here ⇒ both axes are non-null and in-matrix.
  return join(
    KEEPER_ROOT,
    "plugins",
    "plan",
    workerCellDir(model as string, tier as string),
  );
}

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
 * Build the `claude` worker shell command for a `(verb, id, cwd)`, pinned
 * byte-for-byte by `test/autopilot-worker.test.ts`. Lives here rather than
 * re-exported to keep this worker's import graph narrow. The session `--model` /
 * `--effort` are the content-blind orchestrator flags (NOT the task cell); a
 * `work` task's {model, effort} cell rides the SEPARATE `--plugin-dir <pluginDir>`
 * (the launch-time `work` plugin `/plan:work` spawns from), emitted right after
 * `--name` so the reap/classify `--name verb::id` adjacency is preserved.
 * `--x-no-confirm` is an extended launcher flag (parsed and stripped before the
 * real claude binary) that suppresses the cwd confirmation prompt so automated
 * dispatch never hangs on a keystroke. Pure — exported for tests.
 */
export function buildWorkerCommand(
  verb: Verb,
  id: string,
  projectDir: string,
  model: string = WORKER_MODEL,
  effort: string = WORKER_EFFORT,
  pluginDir: string | null = null,
): string {
  const cdPrefix = projectDir === "" ? "" : `cd ${projectDir} && `;
  const flags: string[] = [];
  // Model/effort default to the `WORKER_*` constants; the `worker` preset (when
  // present in `presets.yaml`) overrides them, resolved producer-side per cycle.
  flags.push("--model", model, "--effort", effort);
  flags.push("--x-no-confirm");
  // `--name <key>` adjacency is load-bearing for reap/classify parsing.
  flags.push("--name", `${verb}::${id}`);
  // Per-cell worker plugin dir — AFTER `--name` so the dispatch-key peel is
  // unaffected. Present only for a `work` row whose task resolves a cell.
  if (pluginDir != null && pluginDir !== "") {
    flags.push("--plugin-dir", pluginDir);
  }
  return `${cdPrefix}claude ${flags.join(" ")} '/plan:${verb} ${id}'`;
}

/** Worker `--model` / `--effort` — the single source of truth shared by the
 *  shell-wrapped {@link buildWorkerCommand} and the structured
 *  {@link buildPlannedLaunchSpec} so the worker flags stay identical across both
 *  shapes. */
export const WORKER_MODEL = "sonnet" as const;
export const WORKER_EFFORT = "max" as const;

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
 */
export function resolveWorkerLaunchConfig(configPath?: string): {
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
  return {
    model: preset?.model ?? WORKER_MODEL,
    effort: preset?.effort ?? WORKER_EFFORT,
  };
}

/**
 * Build the structured {@link LaunchSpec} for a planned launch — the unwrapped
 * inputs {@link keeperAgentLaunch} builds its invocation from. Mirrors
 * {@link buildWorkerCommand}'s flag choices EXACTLY (same model/effort/name/
 * prompt) — that parity is a drift guard kept alongside the shell-wrapped
 * `buildLaunchArgv` shape even though keeper agent reads only this spec. A
 * non-empty `worktreePath` rides the spec as the `KEEPER_PLAN_WORKTREE` lane
 * env (worktree-mode launches only); absent/empty leaves it off so non-worktree
 * launches stay byte-identical. A non-empty `worktreeBranch` rides as the
 * sibling `KEEPER_PLAN_WORKTREE_BRANCH` env — the durable per-job lane marker
 * (the pure per-node branch, never derived from the path). A non-null
 * `pluginDir` rides as the `--plugin-dir` cell (the task's resolved
 * {model, effort} `work` plugin); null/absent leaves it off (the byte-unchanged
 * cell-less default). Pure — exported for tests.
 */
export function buildPlannedLaunchSpec(
  verb: Verb,
  id: string,
  model: string = WORKER_MODEL,
  effort: string = WORKER_EFFORT,
  worktreePath?: string,
  worktreeBranch?: string,
  pluginDir?: string | null,
): LaunchSpec {
  return {
    prompt: defaultPlanPrompt(verb, id),
    claudeName: dispatchKey(verb, id),
    model,
    effort,
    ...(pluginDir != null && pluginDir !== "" ? { pluginDir } : {}),
    ...(worktreePath !== undefined && worktreePath !== ""
      ? { worktreePath }
      : {}),
    ...(worktreeBranch !== undefined && worktreeBranch !== ""
      ? { worktreeBranch }
      : {}),
  };
}

/** Compose the canonical `${verb}::${id}` key. */
export function dispatchKey(verb: Verb, id: string): DispatchKey {
  return `${verb}::${id}`;
}

/**
 * The `dispatch_failures` id for a path-tied worktree recovery failure (one with no
 * epic). Slugs the dir — path separators → `-`, no leading `-` — so the composite
 * `close::worktree-recover:<slug>` passes the `retry_dispatch` wire validator and the
 * operator can clear it via `keeper autopilot retry` (a raw path embeds `/`, which the
 * validator rejects, stranding the row).
 */
export function worktreeRecoverDispatchId(dir: string): string {
  return `worktree-recover:${dir.replace(/[/\\]+/g, "-").replace(/^-+/, "")}`;
}

/**
 * The `dispatch_failures` id an EPIC-TIED recover failure keys on —
 * `worktree-recover:<epicId>-<repoDirHash(repoDir)>` (composed
 * `close::worktree-recover:<epicId>-<repoHash>`). The recover sibling of {@link
 * worktreeFinalizeDispatchId}: the concurrent recover failures of ONE epic's main
 * checkout and its multi-repo dirs each land on a DISTINCT row instead of colliding
 * (last-writer-wins UPSERT) on the single `close::<epicId>` key and masking each
 * other's actionable reason. Slugs nothing — the epic id is dispatch-safe and {@link
 * repoDirHash} is base36 — so the composite passes `parseDispatchKey` exactly like the
 * finalize key. `repoHash` reuses the lane-path dir-hash so the producer level-clear
 * targets the SAME row it minted across cycles.
 */
export function worktreeRecoverEpicDispatchId(
  epicId: string,
  repoDir: string,
): string {
  return `worktree-recover:${epicId}-${repoDirHash(repoDir)}`;
}

/**
 * The `dispatch_failures` id a {@link recoverWorktrees} failure keys on. Epic-tied →
 * the per-(epic,repo) {@link worktreeRecoverEpicDispatchId}; a path-tied failure (no
 * epic — the pass-1 list/abort/default-branch/base-list failures) → the per-dir
 * {@link worktreeRecoverDispatchId} slug. The mint and {@link recoverFailuresToClear}
 * BOTH route through this one helper so their keys never drift out of lockstep — a
 * one-sided change would strand rows un-clearable.
 */
export function recoverFailureDispatchId(f: WorktreeRecoveryFailure): string {
  return f.epicId != null
    ? worktreeRecoverEpicDispatchId(f.epicId, f.dir)
    : worktreeRecoverDispatchId(f.dir);
}

/**
 * The `reason` prefix every {@link recoverWorktrees} failure carries
 * (`worktree-recover-conflict`, `-push-failed`, `-not-on-default`, …). The
 * level-triggered auto-clear keys on it to scope clearing to RECOVER-originated
 * `dispatch_failures` rows ONLY: a normal close-sink failure (`finalizeEpic`'s
 * `worktree-finalize-*`) can share the same `close::<epicId>` key, and clearing
 * that one would silently dismiss a legitimate block.
 */
export const WORKTREE_RECOVER_REASON_PREFIX = "worktree-recover";

/** Whether a `dispatch_failures.reason` originated in {@link recoverWorktrees}. */
export function isWorktreeRecoverReason(reason: string): boolean {
  return reason.startsWith(WORKTREE_RECOVER_REASON_PREFIX);
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
 * The id prefix every {@link worktreeFinalizeDispatchId} carries. The producer's
 * finalize level-clear scopes the OPEN finalize-failure set on it (distinct from the
 * `worktree-recover:` path-tied slug and the bare `close::<epic>` a provision fan-in
 * conflict still uses), so a clear never dismisses a recover or escalation row.
 */
export const WORKTREE_FINALIZE_ID_PREFIX = "worktree-finalize:";

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
 * Pure cooldown predicate. `true` IFF `key` was dispatched within the last
 * `REDISPATCH_COOLDOWN_S` seconds. An absent entry is NOT in cooldown. Read
 * inside the pure `reconcile`; the Map is mutated only in the cycle glue.
 */
export function isInCooldown(
  cooldown: Map<DispatchKey, number>,
  key: DispatchKey,
  now: number,
): boolean {
  const stampedAt = cooldown.get(key);
  return stampedAt !== undefined && now - stampedAt < REDISPATCH_COOLDOWN_S;
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
 * Snapshot the reconciler folds into a desired-vs-observed decision.
 * Mirrors the wire snapshot the readiness client emits (`epics` +
 * `jobs` + `subagentInvocations` + the projected `gitStatusByProjectDir`
 * map), plus the live `dispatch_failures` projection for the sticky-
 * failure dedup gate.
 *
 * Pure — the reconciler reads it but never mutates it. The fixed-point
 * comparator (`prevSig` in the worker `main()`) is the only memo that
 * decides "did anything actually change this wake".
 */
export interface ReconcileSnapshot {
  epics: Epic[];
  jobs: Map<string, Job>;
  subagentInvocations: SubagentInvocation[];
  gitStatusByProjectDir: Map<
    string,
    { dirty_count: number; unattributed_to_live_count: number }
  >;
  /**
   * `(verb, id)` keys with an open sticky-failure row. The reconciler
   * suppresses any dispatch whose key matches one of these — failures
   * are sticky until a human `retry_dispatch` mints a `DispatchCleared`.
   */
  failedKeys: Set<DispatchKey>;
  /**
   * The `id`s of every OPEN `close::<id>` dispatch-failure row minted by the
   * worktree RECOVER pass (its `reason` carries the {@link
   * WORKTREE_RECOVER_REASON_PREFIX} marker). The recover glue level-clears any of
   * these absent from the current cycle's fresh recover failures (the underlying
   * git resolved). SCOPED to the recover reason so a normal close-sink failure
   * (`finalizeEpic`) sharing the `close::<id>` key is NEVER auto-dismissed.
   */
  recoverFailureIds: Set<string>;
  /**
   * The `id`s of every OPEN per-repo worktree-FINALIZE dispatch-failure row (its id
   * carries the {@link WORKTREE_FINALIZE_ID_PREFIX} marker — one row per (epic, repo)
   * group). The finalize driver level-clears any of these whose repo finalizes clean
   * this cycle (or whose lane is gone), so an operator who reconciles origin never
   * needs `retry_dispatch`. SCOPED to the finalize id prefix so a recover row or the
   * epic-keyed provision fan-in conflict is NEVER auto-dismissed.
   */
  finalizeFailureIds: Set<string>;
  /**
   * `(verb, id)` keys with an open `pending_dispatches` row — the SAME-`(verb,id)`
   * re-dispatch dedup arm. A row's presence means a `Dispatched` event was minted
   * BEFORE `launch()` and the discharging `SessionStart` has not folded yet (the
   * launch → SessionStart blind window). Distinct from `pendingDispatches` below
   * (same-key dedup vs cross-sibling demotion — both needed).
   */
  liveTabKeys: Set<DispatchKey>;
  /**
   * The LIVE backend pane ids from the read-time `listPanes()` probe, used to
   * gate the `stopped` arm of {@link isOccupyingJob}: a stopped job whose
   * `backend_exec_pane_id` is absent from this set is a dead-session row that
   * no longer occupies its slot (the wedge fix), while a stopped row WITH a
   * live pane and every `working` row still occupy. `null` when the probe is
   * unavailable (degraded / missing tmux) — the conservative pre-liveness
   * fallback where every stopped row occupies. Assembled in
   * {@link loadReconcileSnapshot}; NEVER read in a fold.
   */
  livePaneIds: ReadonlySet<string> | null;
  /**
   * The open `pending_dispatches` rows projected into the {@link PendingDispatch}[]
   * shape `computeReadiness` consumes for the cross-sibling `dispatch-pending`
   * occupant. Built by the SAME `projectPendingDispatches` helper the board/CLI
   * path uses, so the two readiness paths agree byte-for-byte.
   */
  pendingDispatches: PendingDispatch[];
  /**
   * The autopilot mode enum, read fresh from the `autopilot_state` singleton each
   * cycle (the projection is the single source of truth, surviving restart for
   * free). `'yolo'` (the default) works every ready epic; `'armed'` gates `work`
   * to {@link armedIds} plus their transitive upstream dep-closure.
   */
  mode: "yolo" | "armed";
  /**
   * The explicitly-armed epic ids, read fresh from the `armed_epics` projection
   * each cycle. Empty in `yolo` mode and whenever nothing is armed. In `armed`
   * mode `reconcile` expands this into the eligible set (armed ∪ transitive
   * upstreams) via {@link computeEligibleEpics} and suppresses `work` outside it.
   */
  armedIds: Set<string>;
  /**
   * The PER-ROOT unseeded-git set. While `git_projection_state.seed_required`
   * is set (post-restart, before the boot-seed establishes every gated root), this
   * holds each `effectiveRoot` lacking a `git_status` row above the floor — so
   * `reconcile` forces UNKNOWN (via `computeReadiness`) and dispatches NOTHING into
   * THOSE roots, while a seeded sibling root still dispatches. While `seed_required`
   * is CLEAR the set is EMPTY (the gate is fully off — byte-identical to a normal
   * boot, where the autopilot worker spawns AFTER the boot-seed). Bounding the set
   * to the `seed_required`-set window keeps a clean root that `retractGitStatus`
   * later DELETEd from re-wedging.
   */
  unseededRoots: Set<string>;
  /**
   * The autopilot worker `--model` / `--effort`, resolved producer-side per
   * cycle from the `worker` preset in `presets.yaml` (COALESCING onto
   * {@link WORKER_MODEL}/{@link WORKER_EFFORT} when absent/malformed). Assembled
   * read-time in {@link loadReconcileSnapshot} so the pure `reconcile` stays
   * fs-free; threaded onto each {@link PlannedLaunch} so both worker-command
   * builders read the SAME resolved values. NEVER a fold input — re-fold stays
   * byte-identical regardless of which model runs.
   */
  workerModel: string;
  workerEffort: string;
  /**
   * The global concurrency cap, read FRESH from the `autopilot_state` singleton's
   * `max_concurrent_jobs` column each cycle (resolved `column ?? DEFAULT` — an
   * absent/never-set row or NULL = the in-memory {@link DEFAULT_MAX_CONCURRENT_JOBS}
   * default, `null` = unlimited). Projection-pull only (no `workerData`, no config)
   * so a runtime `set_autopilot_config` lands on the very next cycle and the cap
   * survives a restart for free. Refreshed onto {@link ReconcileState.maxConcurrentJobs}
   * in the cycle glue before `reconcile` reads it.
   */
  maxConcurrentJobs: number | null;
  /**
   * The PER-ROOT dispatch concurrency count N, read FRESH from the
   * `autopilot_state` singleton's `max_concurrent_per_root` column each cycle
   * (resolved `column ?? DEFAULT_MAX_CONCURRENT_PER_ROOT` = 1 — an absent/never-set
   * row, NULL, or a non-positive value = the in-memory default, byte-identical to
   * today's one-task-per-root mutex). Projection-pull only (no `workerData`, no
   * config) so a runtime `set_autopilot_config` lands the next cycle and N survives
   * a restart. Refreshed onto {@link ReconcileState.maxConcurrentPerRoot} in the
   * cycle glue. RESERVED for task .2's round-robin allocator; until .2 lands it is
   * carried but unconsumed (the hardcoded N=1 mutex still runs).
   */
  maxConcurrentPerRoot: number;
  /**
   * The durable worktree-mode toggle, read FRESH from the `autopilot_state`
   * singleton's `worktree_mode` column each cycle (resolved `column truthy?` — an
   * absent/never-set row, NULL, or 0 = OFF, the byte-identical no-worktree
   * dispatch; only a stored `1` = ON). Projection-pull only (no `workerData`, no
   * config) so a runtime `set_autopilot_config` lands the very next cycle and the
   * toggle survives a restart for free. RESERVED for the downstream worktree tasks
   * (.2+); until they land it is carried but unconsumed (dispatch is unchanged).
   */
  worktreeMode: boolean;
  /**
   * Each epic's repos RESOLVED to a single git toplevel — the producer
   * snapshot-build's one git-resolution pass for the worktree lane geometry,
   * mirroring {@link unseededRoots}. Built in {@link loadReconcileSnapshot} via
   * {@link classifyWorktreeRepos} + {@link memoizedNullableGitToplevel}, gated on
   * {@link worktreeMode} so an OFF-mode cycle adds ZERO git spawns (an EMPTY map).
   * Threaded into the pure {@link prepareWorktreeGeometry} so both the gate
   * (`computeReadiness` lane keys) and dispatch (`attachWorktreeGeometry`) compare
   * and place lanes by RESOLVED toplevel — never raw `target_repo`/`project_dir`
   * strings — and the pure layer never shells git. Each epic resolves to exactly
   * one of: `ok` (one toplevel, the lane base), `clustered` (>1 toplevel with the
   * multi-repo rollout flag ON — per-repo lane groups), `disabled` (not
   * worktree-friendly), `multi-repo` (>1 toplevel, flag OFF), `no-primary-repo`, or
   * `unresolved` (a required root resolved null). NEVER a fold input.
   */
  worktreeRepoByEpicId: Map<string, WorktreeRepoResolution>;
  /**
   * Every git-tracked project dir (the git-status projection's roots)
   * RESOLVED to its toplevel — the recover sweep's extra KNOWN-ROOTS set, unioned
   * into {@link reposForRecovery} so a repo whose only worktree epic was already
   * reaped from the projection still gets its lingering `keeper/epic/*` bases +
   * orphan ribs swept. EMPTY when worktree mode is OFF (zero extra git spawns).
   * Optional so a test snapshot may omit it (defaults to no extra roots).
   */
  worktreeKnownRoots?: readonly string[];
  /**
   * The EPHEMERAL cross-epic merge-gate defer map, keyed PER (epic, repoDir): each
   * entry maps an epic id to the set of its RESOLVED lane repos whose lane MUST NOT
   * be cut this cycle because a SATISFIED, SAME-RESOLVED-REPO upstream group is not
   * yet contained in that repo's LOCAL default branch (cutting the lane would fork it
   * off a stale base, inverting merge order). A single-repo (`ok`) epic keys its lone
   * repo; a `clustered` multi-repo epic keys ONLY the deferred group's repos — a
   * sibling group whose repo has no unmerged same-repo upstream is absent and
   * proceeds. `has(epicId)` ⇒ AT LEAST ONE group is deferred (the close-row gate);
   * `get(epicId)?.has(repoDir)` ⇒ that specific group's lane is deferred (the
   * work-row gate). Probed ONCE per cycle in {@link loadReconcileSnapshot} (gated on
   * {@link worktreeMode}) via {@link computeDeferredEpicIds}, then read back here as
   * PLAIN DATA by the pure `reconcile` — which shells git nowhere. NEVER a fold
   * input; mints NO sticky / `dispatch_failures` row (a deferred group re-evaluates
   * every cycle and provisions the cycle after its upstream's finalize merge lands).
   * EMPTY whenever worktree mode is OFF (a byte-identical no-op for OFF / yolo).
   * Optional so a test snapshot may omit it (defaults to no deferral).
   */
  deferredEpicIds?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * The durable MERGE-LANDED set (fn-1016) — every `ok`-classified epic whose lane
   * `keeper/epic/<id>` is merged into LOCAL default (ancestor-of-default, or
   * torn-down after the merge). Probed ONCE per cycle in
   * {@link loadReconcileSnapshot} (gated on {@link worktreeMode}) via
   * {@link computeMergedLaneEntries}, then emitted as a synthetic `LaneMerged`
   * event main folds into the LIVE-ONLY `lane_merged` projection. NEVER a fold
   * input, NEVER read by the pure `reconcile` (purely observational — it drives no
   * dispatch arm). EMPTY whenever worktree mode is OFF (no lanes exist; the
   * consumer degrades `landed` to `done`). Optional so a test snapshot may omit it.
   */
  landedLaneEntries?: readonly LaneMergedEntry[];
}

/**
 * An epic's worktree-mode repo classification — the result of resolving
 * every task's effective root (`target_repo || project_dir`) to a git toplevel in
 * the producer snapshot-build. Drives the pure lane geometry:
 *  - `ok` — every required root resolved to ONE toplevel; `repoDir` is that
 *    toplevel, the base every lane forks off (and the close lane merges into).
 *  - `multi-repo` — the required roots resolved to >1 distinct toplevel; the epic
 *    is rejected for v1 with a sticky `worktree-multi-repo` reject.
 *  - `unresolved` — a required root resolved `null` (empty, non-repo, or a
 *    transient git failure); the epic is rejected with a distinct sticky
 *    `worktree-repo-unresolved` reject (re-resolves next cycle via the per-cycle
 *    memo). The `reason` is a free-form `<prefix>: <detail>` literal.
 *  - `no-primary-repo` — one toplevel resolved, but the epic carries no
 *    `primary_repo` (mirrored onto `project_dir`). Provisioning a lane would let
 *    the central plan-state resolver degrade state writes to the LANE checkout
 *    (`done`/`claim`/close land on the lane branch, `isEpicDone` never flips,
 *    `finalizeEpic` deadlocks). Rejected with a sticky `worktree-no-primary-repo`
 *    — operator-required (OUTSIDE the `worktree-recover` auto-clear prefix; a
 *    missing primary_repo is an epic-def fix, not a transient).
 *  - `disabled` — a would-be-`ok` epic whose RESOLVED toplevel is not
 *    worktree-friendly (a workspace-orchestration marker, a submodule repo, no
 *    root language manifest, or a probe error — see `worktree-eligibility.ts`).
 *    A NORMAL, NON-error fallback: the epic dispatches SEQUENTIALLY on the shared
 *    checkout (one task per root, cap-1) — NEVER a sticky `DispatchFailed`. Carries
 *    the resolved `repoDir` (like `ok`) so the geometry can key every lane on the
 *    bare toplevel. Only ever downgrades a would-be-`ok` epic (after the
 *    multi-repo / unresolved / no-primary-repo rejects).
 */
export type WorktreeRepoResolution =
  | { kind: "ok"; repoDir: string }
  | {
      kind: "clustered";
      groups: WorktreeRepoGroup[];
      primaryRepoDir: string;
    }
  | { kind: "disabled"; repoDir: string; reason: string }
  | { kind: "multi-repo"; reason: string }
  | { kind: "unresolved"; reason: string }
  | { kind: "no-primary-repo"; reason: string };

/**
 * One per-repo lane GROUP of a `clustered` multi-repo epic resolution. The epic's
 * tasks are partitioned by their RESOLVED git toplevel into an ordered list of
 * these; each group derives its OWN worktree geometry INDEPENDENTLY (its own base
 * + ribs + `__close__` sink in its own git), and cross-repo `depends_on` edges are
 * auto-dropped from each group's lane geometry (surviving only as readiness
 * serialization barriers). A single-repo epic never clusters — it stays the `ok`
 * (or `disabled`) arm; `clustered` is minted ONLY when the multi-repo rollout flag
 * is ON and the epic resolves to >1 toplevel.
 */
export interface WorktreeRepoGroup {
  /** This group's RESOLVED git toplevel — the lane base every group task forks off. */
  repoDir: string;
  /** The epic task ids resolving to `repoDir`, in `epic.tasks` order. */
  taskIds: string[];
  /**
   * `worktree` — a worktree-friendly repo: provision lanes (base + ribs + sink).
   * `serial` — a not-worktree-friendly repo (the per-group analogue of the
   * whole-epic `disabled` fallback): dispatch its tasks sequentially on the shared
   * checkout (cap-1 on the bare `repoDir`), provisioning no lane. Assessed per
   * group via `assessRepo` (+ the per-(epic, repoDir) grandfather), so one group
   * can be `worktree` while a sibling is `serial`.
   */
  mode: "worktree" | "serial";
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
 * The RESOLVED git toplevel a task's lane lives in — how the per-(epic, repoDir)
 * merge-gate maps a work row back to its group. An `ok` / `disabled` epic keys every
 * task to its single `repoDir`; a `clustered` epic keys each task to the group that
 * owns it. `null` for a task outside any lane group (a reject resolution, or an
 * absent classification) — the caller then applies no per-group deferral.
 */
function laneRepoForTask(
  resolution: WorktreeRepoResolution | undefined,
  taskId: string,
): string | null {
  if (resolution === undefined) {
    return null;
  }
  if (resolution.kind === "ok" || resolution.kind === "disabled") {
    return resolution.repoDir;
  }
  if (resolution.kind === "clustered") {
    for (const group of resolution.groups) {
      if (group.taskIds.includes(taskId)) {
        return group.repoDir;
      }
    }
  }
  return null;
}

/**
 * In-memory reconciler state — the paused flag plus the set of
 * `${verb}::${id}` dispatches currently in-flight on this reconciler.
 * "In-flight" spans the moment `reconcile` decides to dispatch (set on
 * the key) through the `confirmRunning` resolution path (clear on
 * either success OR failure). NEVER persisted — the reconciler restarts
 * cold; the durable signal is the `jobs` projection itself PLUS the
 * per-cycle `liveTabKeys` probe, which re-derives the launch →
 * SessionStart occupation against the exec backend on every wake so a daemon
 * restart never double-dispatches a slot already claimed by a live
 * worker tab.
 */
export interface ReconcileState {
  paused: boolean;
  inFlight: Set<DispatchKey>;
  /**
   * The in-process re-dispatch cooldown (`${verb}::${id}` → unix-SECONDS of last
   * dispatch) — the fold-lag-immune suppression arm. `inFlight` is released the
   * moment `confirmRunning` resolves, but the projection-backed `liveTabKeys` may
   * not have folded yet; the cooldown bridges that gap for
   * `REDISPATCH_COOLDOWN_S` seconds. Held here so `reconcile()` can READ it and
   * stay pure — MUTATED only in the cycle glue. IN-MEMORY ONLY; boots EMPTY on
   * restart (safe — the first cycle rebuilds suppression from the live `jobs` /
   * `pending_dispatches` projection, even when the daemon resumes PLAYING).
   */
  redispatchCooldown: Map<DispatchKey, number>;
  /**
   * The in-process per-epic FINALIZER guard (EPIC ID → unix-SECONDS of last
   * `close` dispatch) — an epic-id-keyed fold-lag-immune backstop against a
   * `close` re-dispatch. Same shape/lifecycle as `redispatchCooldown`: read in
   * the pure `reconcile`, mutated only in the cycle glue. IN-MEMORY ONLY; boots
   * EMPTY.
   */
  finalizerGuard: Map<string, number>;
  /**
   * Global ceiling on root-occupants this reconciler dispatches at once across
   * ALL epics/roots. `null` = unlimited. REFRESHED each cycle from
   * {@link ReconcileSnapshot.maxConcurrentJobs} (the `autopilot_state` projection
   * `?? DEFAULT`) in the cycle glue BEFORE `reconcile()` reads it — so a runtime
   * `set_autopilot_config` lands on the next cycle. Held on `state` (not read
   * straight off the snapshot in `reconcile`) so the pure `reconcile()` keeps its
   * existing `state`-sourced cap signature.
   */
  maxConcurrentJobs: number | null;
  /**
   * Per-root dispatch concurrency count N this reconciler grants per root.
   * REFRESHED each cycle from {@link ReconcileSnapshot.maxConcurrentPerRoot}
   * (`autopilot_state.max_concurrent_per_root ?? DEFAULT` = 1) in the cycle glue
   * BEFORE `reconcile()` reads it — so a runtime `set_autopilot_config` lands on
   * the next cycle. Held on `state` (not read straight off the snapshot) for the
   * same reason as `maxConcurrentJobs`. RESERVED for task .2's round-robin
   * allocator; until .2 lands the hardcoded N=1 mutex still runs.
   */
  maxConcurrentPerRoot: number;
}

/**
 * Per-launch decision the reconciler emits. Carries everything the
 * caller (`runReconcileCycle`) needs to call `confirmRunning`: the
 * `(verb, id)` pair, the `cwd` for the launch, and the constructed
 * worker shell command body. The `key` is denormalized for in-flight
 * tracking.
 */
export interface PlannedLaunch {
  verb: Verb;
  id: string;
  /** `${verb}::${id}` — the `--name`, the tab name, and the dedup key. */
  key: DispatchKey;
  /** Effective cwd: `task.target_repo ?? epic.project_dir`, never empty. */
  cwd: string;
  /** `claude --model ... --name <key> '/plan:<verb> <id>'`. */
  workerCommand: string;
  /**
   * The resolved worker `--model` / `--effort` for this launch (the `worker`
   * preset or the {@link WORKER_MODEL}/{@link WORKER_EFFORT} fallback). Carried
   * onto the launch so the cycle glue feeds {@link buildPlannedLaunchSpec} the
   * SAME values {@link buildWorkerCommand} baked into `workerCommand` — the
   * drift-guard parity across the shell + structured shapes.
   */
  model: string;
  effort: string;
  /** Task `tier`, only set for `work` rows. */
  tier: string | null;
  /**
   * The resolved ABSOLUTE per-cell worker plugin dir for a `work` row whose task
   * carries an in-matrix {model, effort} pair
   * (`${KEEPER_ROOT}/plugins/plan/workers/<model>-<effort>`), else `null` (a
   * `close` row, a cell-less task, or a row whose compose threw — see
   * {@link pluginDirReject}). Threaded onto the launch so `runReconcileCycle`
   * emits it via BOTH the shell twin (`workerCommand`) and the structured spec
   * ({@link buildPlannedLaunchSpec}) without re-composing.
   */
  pluginDir: string | null;
  /**
   * Set IFF composing the cell path for this `work` row THREW — an out-of-matrix
   * `(model, effort)` (corrupt-on-disk task). Carries the throw's message; the
   * producer mints a sticky `DispatchFailed` (cleared by `retry_dispatch`) and
   * launches nothing, per-key, so a sibling launch keeps dispatching. Mutually
   * exclusive with a non-null {@link pluginDir}. Mirrors the `worktreeReject`
   * pure-reject-carried-to-producer shape so the pure `reconcile` never throws
   * (a deterministic throw would silently wedge the whole cycle).
   */
  pluginDirReject?: string;
  /**
   * `true` IFF this is an EPIC-level finalizer (`close` at the close-row site,
   * keyed by epic id). The cycle glue stamps `state.finalizerGuard[id]` for these
   * only. Set at the close-row push; absent/false on every task launch.
   */
  isEpicFinalizer?: boolean;
  /**
   * The pure worktree geometry for this launch, computed in `reconcile`
   * (the topology is a total function of the DAG, so it stays in the pure layer).
   * ABSENT whenever worktree mode is OFF (then dispatch is byte-identical to
   * today, save the producer-side on-default-branch assertion). PRESENT in
   * worktree mode: the producer (`runReconcileCycle`) consumes it to provision
   * the lane worktree, run fan-in pre-merges, assert HEAD, and OVERRIDE `cwd`
   * with the worktree path — all BEFORE `confirmRunning` mints the durable
   * Dispatched. Never a fold input.
   */
  worktree?: WorktreeLaunchInfo;
  /**
   * Set IFF this launch belongs to a multi-repo epic that worktree mode
   * rejects for v1. The producer mints a sticky `worktree-multi-repo`
   * `DispatchFailed` (cleared by `retry_dispatch`) and launches nothing. Mutually
   * exclusive with {@link worktree}.
   */
  worktreeReject?: WorktreeReject;
}

/**
 * The worktree geometry the producer needs for one launch. Carries the
 * pure topology {@link WorktreeAssignment} plus the epic-level context the
 * producer's git side effects require. Computed in `reconcile`; consumed ONLY in
 * `runReconcileCycle` (every git op lives there, never in a fold).
 */
export interface WorktreeLaunchInfo {
  /** The pure per-node topology assignment (branch / path / pre-merges). */
  assignment: WorktreeAssignment;
  /** The epic base branch — `keeper/epic/<epic_id>`. */
  baseBranch: string;
  /** The epic base worktree path (the lane the closer + first root run on). */
  baseWorktreePath: string;
  /**
   * The repo dir whose git the producer drives for this epic — the epic's
   * `project_dir`. The worktree `add`/`list`/`merge`/`prune` commands run with
   * this as cwd (it is the main worktree of the repo every lane forks off), and
   * the default branch the epic base merges into at close is resolved here.
   */
  repoDir: string;
  /**
   * The deterministic ordered list of EVERY node's branch ↔ worktree-path pair
   * for this epic, in toposort order. The producer walks it to resolve a
   * pre-merge SOURCE branch's committed tip (the parent lane a rib forks off)
   * without re-deriving the plan. Shared by reference across an epic's launches.
   */
  laneOrder: { nodeId: string; branch: string; worktreePath: string }[];
  /**
   * The PRIMARY parent's branch — the lane this node forked-off or inherited.
   * For a rib, the producer forks the new worktree off THIS branch's committed
   * tip; for an inheriting node (or a root) it is the node's own branch (or the
   * base) and no fresh worktree is forked. Empty only for the synthetic close
   * sink (always base).
   */
  parentBranch: string;
}

/**
 * A loud worktree-mode rejection for one epic — a launch the producer
 * must NOT run but instead surface as a sticky `DispatchFailed`. The epic's repos
 * are RESOLVED to git toplevels ONCE in the producer snapshot-build, so
 * two distinct kinds reach here, each a distinct `reason` literal (both cleared by
 * `retry_dispatch`):
 *  - `worktree-multi-repo: <detail>` — the tasks resolve to MORE THAN ONE distinct
 *    toplevel (unsupported in worktree mode for v1).
 *  - `worktree-repo-unresolved: <detail>` — a required root resolved `null` (empty,
 *    not inside a git worktree, or a transient resolve failure). Re-resolves on the
 *    next cycle via the snapshot's per-cycle memo, so a transient failure self-heals.
 * Every launch the rejected epic would emit is replaced by this marker; the
 * producer launches nothing for that key.
 */
export interface WorktreeReject {
  reason: string;
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
 * The output of `reconcile`: the launches to fire PLUS the row ids whose verdict
 * is `{tag:"completed"}` this cycle. `completedRowIds` is harvested from the SAME
 * `computeReadiness` pass `reconcile` makes (single source of truth — `driveCycle`
 * must NOT recompute readiness) and holds task ids + epic ids; the completion-reap
 * predicate keys off `<id>` only.
 */
export interface ReconcileDecision {
  launches: PlannedLaunch[];
  completedRowIds: Set<string>;
  /**
   * The per-epic worktree-finalize requests for this cycle: one entry
   * per epic whose close-row verdict is `{tag:"completed"}` AND worktree mode is
   * ON. The producer (`runReconcileCycle`) runs `worktree.finalizeEpic` for each
   * AFTER the launch loop — merging the epic base into the default branch (once
   * the closer that landed the close commit on `keeper/epic/<id>` has finished)
   * and tearing the lanes down. EMPTY whenever worktree mode is OFF. The merge is
   * driven from THIS producer step (not the recent-done reap window) so it never
   * depends on the 1800s `DONE_EPICS_REAP_WINDOW_SEC`; the restart backstop that
   * survives a daemon bounce between epic-done and merge-to-default is a separate
   * recovery task. Idempotent: `finalizeEpic` skips an already-merged base.
   */
  worktreeFinalize: WorktreeLaunchInfo[];
  /**
   * The NON-PRIMARY worktree-group close sinks a CLUSTERED multi-repo epic must
   * fan-in (rib→base) via the producer's `provision` path BEFORE finalize. Only
   * the PRIMARY group dispatches a close worker (which provisions + assembles its
   * base as a side effect of that launch); a non-primary group has no worker to
   * trigger the fan-in, so the producer runs it here just ahead of merging its
   * base into default. EMPTY for single-repo (`ok`) epics and whenever worktree
   * mode is OFF — a byte-identical no-op. Gated on the same `needsFinalize` signal
   * as {@link worktreeFinalize}, so a group is fanned-in only when the epic is done.
   */
  worktreeSinkProvision: WorktreeLaunchInfo[];
  /**
   * The OPEN per-repo worktree-finalize dispatch-failure ids (mirrored straight off
   * `snapshot.finalizeFailureIds`). The finalize driver clears any whose repo
   * finalizes clean this cycle — the level-triggered auto-clear, so an operator who
   * reconciles a `worktree-finalize-non-fast-forward` block never needs
   * `retry_dispatch`. EMPTY of consequence when paused (the clear only fires for a
   * repo that actually finalized this cycle, and `worktreeFinalize` is empty then).
   */
  finalizeFailureIds: Set<string>;
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
   *     clean state (level-triggered retry, no in-process self-heal).
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
  ): Promise<WorktreeRecoveryFailure[]>;
}

/**
 * One recovery-pass failure surfaced by {@link WorktreeDriver.recover}.
 * `epicId` is set for a done-but-unmerged backstop failure (keyed onto the
 * `close::<epicId>` sticky DispatchFailed); `null` for a merge-abort/prune failure
 * tied to a worktree path rather than an epic. `dir` is the repo the failure
 * occurred in.
 */
export interface WorktreeRecoveryFailure {
  epicId: string | null;
  reason: string;
  dir: string;
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
 * insert threw (a writer-lock contention or DB failure). The reconciler
 * launches ONLY on `ok:true`; an `ok:false` (or a rejected ack-wait —
 * timeout / shutdown) aborts WITHOUT launching, so the SessionStart-
 * drains-before-`Dispatched` race that would re-open the double-
 * dispatch window is closed.
 */
export interface DispatchedAck {
  ok: boolean;
}

/**
 * Payload shape for the producer-side TTL sweep's `DispatchExpired`
 * mint (schema v50). Mirrors `src/reducer.ts`'s
 * `DispatchExpiredPayload` shape — the discharge arm is keyed-by-pk
 * only (`(verb, id)`), no `ts` carried (the fold is a DELETE; no row
 * field to populate). Strictly `verb` + `id`, mirroring
 * `DispatchClearedPayload`'s minimal shape.
 */
export interface DispatchExpiredPayload {
  verb: Verb;
  id: string;
}

/**
 * Confirm outcome — internal to `runReconcileCycle`. Five-way:
 *  - `"ok"` — the SessionStart `jobs` row landed before the ceiling; promoted to
 *    `liveDispatches`.
 *  - `"failed"` — `launch()` returned `{ok:false}` (or threw); mints a STICKY
 *    `DispatchFailed` (cleared only by a human `retry_dispatch`).
 *  - `"indoubt"` — the launch SUCCEEDED but the ceiling elapsed with NO `jobs`
 *    row. UNKNOWN, not failed (the backend execs `claude` cold past the ceiling). NO
 *    `DispatchFailed`; the `pending_dispatches` row is KEPT so the TTL sweep
 *    mints `DispatchExpired` if the bind never arrives.
 *  - `"aborted-prelaunch"` — an abort BEFORE `launch()` (ack `{ok:false}` /
 *    ack-wait reject / shutdown racing the ack). The launch never happened; the
 *    cycle glue CLEARS the cooldown + finalizer stamps (`failedKeys` owns
 *    stickiness).
 *  - `"aborted-postlaunch"` — an abort AFTER `launch()` fired (mid-poll
 *    shutdown). The launch DID happen, so the cycle glue KEEPS the stamps so a
 *    fold-lag-blind re-dispatch can't double-launch the worktree. No
 *    `DispatchFailed` either way (shutdown is clean teardown).
 */
export type ConfirmOutcome =
  | "ok"
  | "failed"
  | "indoubt"
  | "aborted-prelaunch"
  | "aborted-postlaunch";

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
 * Translate a single readiness verdict on a row into the verb the
 * reconciler would dispatch for it, or `null` to dispatch nothing.
 *
 *   - `{ tag: "ready" }` on a task → `"work"`; on a close row → `"close"`.
 *   - Everything else → `null` (running / blocked / completed / undefined
 *     verdict).
 *
 * The `blocked:job-pending → "approve"` arm is gone — there is no
 * approval window and no `job-pending` verdict to dispatch against.
 *
 * Pure — exported for tests. Mirrors the dispatch table in
 * `cli/autopilot.ts` (`gateAndDispatch` branches at :2778-2851) so the
 * reconciler and the legacy CLI agree byte-for-byte on what verb each
 * verdict implies.
 */
export function verbForVerdict(
  kind: "task" | "close",
  verdict: Verdict | undefined,
): Verb | null {
  if (verdict === undefined) {
    return null;
  }
  if (verdict.tag === "ready") {
    return kind === "task" ? "work" : "close";
  }
  return null;
}

/**
 * Inspect a `jobs` map for an OCCUPYING row keyed by `(plan_verb, plan_ref)`.
 * A `working` row ALWAYS occupies. A `stopped` row occupies ONLY while its
 * backend session is still LIVE — its `backend_exec_pane_id` appears in
 * `livePaneIds`, the read-time `listPanes()` probe threaded through the
 * snapshot. `stopped` is the schema default for BOTH a parked-alive session
 * (still live, still occupies) AND a worker that ended its turn without
 * completing its task (crashed / blocked-on-deps mid-task) whose pane is now
 * GONE; gating on liveness lets the latter be re-dispatched instead of wedging
 * the slot forever, while readiness already classifies it as ready (it reads
 * `working` for predicate 5, never `stopped`). Aligns with `readiness.ts`
 * `isLiveWorkOccupant` — a stopped-dead session holds no mutex slot.
 *
 * `livePaneIds === null` means the liveness probe was UNAVAILABLE (degraded /
 * missing tmux) — fall back to the pre-liveness behavior where every stopped
 * row occupies, never trading a double-dispatch for an un-probeable cycle. A
 * stopped row with a NULL/empty `backend_exec_pane_id` (the SessionStart-
 * INSERTed row not yet bound to a pane) is NOT live-provable here and does not
 * occupy via this gate — the launch → SessionStart window is guarded by the
 * `liveTabKeys` / cooldown arms instead, which this fix leaves untouched.
 *
 * The liveness facts are assembled READ-TIME in `loadReconcileSnapshot`; this
 * predicate never probes the backend itself (and folds never read liveness —
 * re-fold determinism is sacrosanct). Returns on first match.
 */
export function isOccupyingJob(
  jobs: Map<string, Job>,
  verb: Verb,
  id: string,
  livePaneIds: ReadonlySet<string> | null,
): boolean {
  for (const job of jobs.values()) {
    if (job.plan_verb !== verb || job.plan_ref !== id) {
      continue;
    }
    if (job.state === "working") {
      return true;
    }
    if (job.state === "stopped" && isStoppedJobLive(job, livePaneIds)) {
      return true;
    }
  }
  return false;
}

/**
 * Is a `stopped` job's backend session still LIVE? `null` `livePaneIds` (probe
 * unavailable) → assume live (the conservative pre-liveness fallback). A row
 * with no `backend_exec_pane_id` is not live-provable → not live here.
 */
function isStoppedJobLive(
  job: Job,
  livePaneIds: ReadonlySet<string> | null,
): boolean {
  if (livePaneIds === null) {
    return true;
  }
  const paneId = job.backend_exec_pane_id;
  if (paneId == null || paneId === "") {
    return false;
  }
  return livePaneIds.has(paneId);
}

/**
 * Is an epic IN-FLIGHT — did autopilot already touch it (a live worker or
 * surface) so its `close` finalizer must still run even after a mid-flight
 * disarm? `true` IFF an occupying `close::<epic>` / `work::<task>` job OR a live
 * `close::<epic>` / `work::<task>` surface in `liveTabKeys` holds. The
 * disarmed-mid-flight finish signal, ORTHOGONAL to armed dep-closure membership
 * (checked separately at the close-dispatch gate); a COLD never-touched,
 * never-armed candidate has none of these and is suppressed in `armed` mode.
 * Pure — reads the snapshot fields only.
 */
export function isEpicInFlight(
  epic: Epic,
  jobs: Map<string, Job>,
  liveTabKeys: Set<DispatchKey>,
  livePaneIds: ReadonlySet<string> | null,
): boolean {
  if (
    isOccupyingJob(jobs, "close", epic.epic_id, livePaneIds) ||
    liveTabKeys.has(dispatchKey("close", epic.epic_id))
  ) {
    return true;
  }
  for (const task of epic.tasks) {
    if (
      isOccupyingJob(jobs, "work", task.task_id, livePaneIds) ||
      liveTabKeys.has(dispatchKey("work", task.task_id))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Has an epic's CLOSER worker RUN AND FINISHED — a `close::<epic_id>` job row
 * exists in the projection but no longer OCCUPIES its slot (not `working`, not a
 * live-`stopped` session)? The producer-observable finalize trigger: it fires for
 * ANY finished closer job off the durable `jobs` projection, BROADER than
 * `completedRowIds` (which waits on the main `epics` projection folding the epic
 * `done`). Finalize then confirms real completion via the MAIN projection
 * (`isEpicDone` — the closer writes `done` to the PRIMARY repo, never the lane, so
 * the projection is the authority) before it merges.
 *
 * Producer-only + re-fold-safe (jobs is a deterministic-replayed projection,
 * read here in the producer, never in a fold). Crash/restart-safe: the close job
 * row survives a daemon bounce, and after restart no panes are live so the
 * finished closer reads as non-occupying — the trigger re-fires. A crashed or
 * still-running closer is handled safely: a still-running one occupies (so this
 * is `false`); a crashed one that finished without committing `done` trips this
 * but finalize's projection-done gate no-ops the merge until the done commit
 * lands. Pure — reads the snapshot fields only.
 */
export function closerJobFinished(
  jobs: Map<string, Job>,
  epicId: string,
  livePaneIds: ReadonlySet<string> | null,
): boolean {
  let sawCloseJob = false;
  for (const job of jobs.values()) {
    if (job.plan_verb === "close" && job.plan_ref === epicId) {
      sawCloseJob = true;
      break;
    }
  }
  return sawCloseJob && !isOccupyingJob(jobs, "close", epicId, livePaneIds);
}

/** Shared empty defer map — the `snapshot.deferredEpicIds ?? …` fallback so the
 * inert (OFF / nothing-deferred) reconcile path allocates no per-cycle Map. */
const EMPTY_DEFERRED_EPIC_IDS: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map<string, ReadonlySet<string>>();

/**
 * The pure reconcile decision. Walks every epic / task / close-row, computes the
 * verb each verdict wants, and emits a `PlannedLaunch` IFF no suppression rule
 * fires: `state.paused`, `state.inFlight.has(key)` (one-at-a-time stagger),
 * `snapshot.failedKeys.has(key)` (sticky failure), `isOccupyingJob` (a
 * non-terminal jobs row already exists), or `snapshot.liveTabKeys.has(key)` (a
 * launch occupies the slot before its SessionStart folds). Pure — exported for
 * testing; side effects live in `runReconcileCycle`.
 */
export function reconcile(
  snapshot: ReconcileSnapshot,
  state: ReconcileState,
  now: number,
): ReconcileDecision {
  const launches: PlannedLaunch[] = [];

  // The EPHEMERAL cross-epic merge-gate defer map (epic id → its deferred lane
  // repos), probed git-side ONCE per cycle in `loadReconcileSnapshot` and read here
  // as PLAIN DATA (the pure layer shells git nowhere). EMPTY whenever worktree mode
  // is OFF / nothing is deferred — then both gate arms below are inert and dispatch
  // stays byte-identical. Read once.
  const deferredEpicIds: ReadonlyMap<
    string,
    ReadonlySet<string>
  > = snapshot.deferredEpicIds ?? EMPTY_DEFERRED_EPIC_IDS;

  // The armed-mode eligibility set: in `armed` mode `work` is dispatched ONLY
  // for armed epics PLUS their transitive upstream dep-closure. Computed ONCE
  // per cycle (recomputed every cycle — caching would restale when the DAG
  // shifts) and reused at BOTH the per-root mutex (via `computeReadiness`) AND
  // the per-row gate. `undefined` in yolo — selects the legacy single-pass mutex
  // and makes the per-row gate a no-op; an empty set (armed-but-nothing-armed)
  // is still PROVIDED so the mutex suppresses every task row. Also narrows
  // `close` launches (a close is eligible iff the epic is in the closure OR
  // in-flight); completion-reap and the per-root mutex layer stay mode-exempt.
  const armedMode = snapshot.mode === "armed";
  const eligible: Set<string> | undefined = armedMode
    ? computeEligibleEpics(
        snapshot.armedIds,
        new Map(snapshot.epics.map((e) => [e.epic_id, e])),
      )
    : undefined;

  // The worktree lane geometry, derived ONCE per cycle off the
  // snapshot's RESOLVED `worktreeRepoByEpicId` classification (toplevels resolved
  // git-side in `loadReconcileSnapshot`; the pure layer never shells git). EMPTY
  // (the default) whenever worktree mode is OFF — then `computeReadiness` keys on
  // `effectiveRoot`, byte-identical to today. ON: `laneKeyById` re-keys each row on
  // its derived lane worktree path so every worktree is a CAP-1 lane (two agents in
  // one index = corruption) while parallel sibling lanes run concurrently, and
  // `byEpicId` feeds the dispatch-side `attachWorktreeGeometry` post-pass — both
  // consuming the SAME plan, so the gate and dispatch never diverge.
  const worktreeGeometry: PreparedWorktreeGeometry = snapshot.worktreeMode
    ? prepareWorktreeGeometry(snapshot.epics, snapshot.worktreeRepoByEpicId)
    : {
        laneKeyById: new Map<string, string>(),
        byEpicId: new Map<string, EpicWorktreeGeometry>(),
      };
  const laneKeyById = worktreeGeometry.laneKeyById;

  // Use `Number.NEGATIVE_INFINITY` for the sub-agent staleness `now`
  // when the caller didn't bother (matches `computeReadiness`'s default
  // — keeps the staleness branch inert if undefined).
  const readiness = computeReadiness(
    snapshot.epics,
    snapshot.jobs,
    snapshot.subagentInvocations,
    snapshot.gitStatusByProjectDir,
    now,
    // The launch-window occupancy set — feeds the cross-sibling
    // `dispatch-pending` occupant so a same-epic/same-root sibling is demoted
    // while a dispatch is in flight (orthogonal to the same-key `liveTabKeys`
    // arms below).
    snapshot.pendingDispatches,
    // The armed-mode eligible set (`undefined` in yolo) — drives the per-root
    // mutex's pass-2 tiebreak so an armed epic claims a free root over an
    // earlier-sorted unarmed sibling.
    eligible,
    // The per-root unseeded-git set → force UNKNOWN only for rows whose
    // `effectiveRoot` is unseeded (dispatch nothing into an unseeded root, while a
    // seeded sibling root still dispatches). Empty whenever `seed_required` is clear.
    snapshot.unseededRoots,
    // The per-root dispatch concurrency count N (refreshed each cycle from
    // `autopilot_state.max_concurrent_per_root`) — drives the round-robin
    // allocator so up to N tasks dispatch concurrently into one root, spread
    // across its epics. The board latches the SAME N off `BootStatus`, so both
    // consumers compute identical demotions. Default 1 = one-task-per-root.
    state.maxConcurrentPerRoot,
    // The worktree-mode lane re-key (empty when OFF). Re-keys the allocator
    // onto lane paths (cap-1 per lane) without diverging from the dispatch-side
    // worktree geometry, which derives the SAME plan in `attachWorktreeGeometry`.
    laneKeyById,
  );

  // Harvest the completion set from the ONE readiness pass above (never a second
  // `computeReadiness`). Both maps feed the same id set (task ids and epic ids
  // never collide — `fn-N-slug.M` vs `fn-N-slug`).
  const completedRowIds = new Set<string>();
  for (const [taskId, verdict] of readiness.perTask) {
    if (verdict.tag === "completed") {
      completedRowIds.add(taskId);
    }
  }
  for (const [epicId, verdict] of readiness.perCloseRow) {
    if (verdict.tag === "completed") {
      completedRowIds.add(epicId);
    }
  }

  // Global concurrency cap. Count root-occupants ONCE over the POST-mutex
  // verdicts of BOTH perTask AND perCloseRow — `isRootOccupant` is
  // planner-exempt, matching the per-root mutex predicate so the counts never
  // drift. `budget` is the remaining admittance for NEWLY-planned launches; a
  // `null` cap is a fast-path bypass. Strict `budget > 0`: cap=1 occupied=1 →
  // admit nothing.
  let occupied = 0;
  for (const verdict of readiness.perTask.values()) {
    if (isRootOccupant(verdict)) {
      occupied++;
    }
  }
  for (const verdict of readiness.perCloseRow.values()) {
    if (isRootOccupant(verdict)) {
      occupied++;
    }
  }
  const cap = state.maxConcurrentJobs;
  let budget =
    cap === null ? Number.POSITIVE_INFINITY : Math.max(0, cap - occupied);

  // Walk every row. For each (kind, id), compute the wanted verb and
  // record whichever launches survive suppression.
  for (const epic of snapshot.epics) {
    const projectDir = epic.project_dir ?? "";
    // Cross-epic merge-gate (worktree mode): the set of THIS epic's lane repos
    // deferred this cycle (`undefined` ⇒ none — the common / OFF path skips every
    // per-group lookup below). `worktreeResForEpic` is the epic's resolved
    // classification, fetched ONLY when a group is deferred so it can map a work row
    // to its group repo. Both stay `undefined` on the byte-identical OFF path.
    const deferredReposForEpic = deferredEpicIds.get(epic.epic_id);
    const worktreeResForEpic =
      deferredReposForEpic !== undefined
        ? snapshot.worktreeRepoByEpicId.get(epic.epic_id)
        : undefined;
    for (const task of epic.tasks) {
      const taskId = task.task_id;
      const verdict = readiness.perTask.get(taskId);
      const verb = verbForVerdict("task", verdict);
      if (verb === null) {
        continue;
      }
      const key = dispatchKey(verb, taskId);
      if (state.paused) {
        continue;
      }
      // Armed-mode gate: suppress a `work` launch for an epic NOT in the
      // eligible set (armed ∪ transitive upstreams). ABOVE the budget gate so a
      // non-eligible epic never consumes budget. RETAINED even with the
      // eligibility-aware mutex: pass-2b can still surface an ineligible task as
      // `ready` when it wins a root with no eligible contender, and this gate is
      // the only thing that stops that winner launching. No-op in `yolo`.
      if (armedMode && verb === "work" && !eligible?.has(epic.epic_id)) {
        continue;
      }
      // Cross-epic merge-gate (worktree mode): suppress a `work` launch whose GROUP
      // lane must NOT be cut yet — a satisfied same-repo upstream group is not yet
      // contained in that repo's local default, so forking the lane now would build
      // on a stale base (merge-order inversion). Per (epic, repoDir): only the task
      // whose lane repo is deferred is held; a sibling group's task in a clean repo
      // proceeds. EPHEMERAL + producer-probed; mints NO sticky row and re-evaluates
      // every cycle. ABOVE the budget gate so a deferred group consumes no global
      // budget. Inert (empty map ⇒ `deferredReposForEpic` undefined) in OFF / yolo.
      if (deferredReposForEpic !== undefined) {
        const taskRepoDir = laneRepoForTask(worktreeResForEpic, taskId);
        if (taskRepoDir !== null && deferredReposForEpic.has(taskRepoDir)) {
          continue;
        }
      }
      if (state.inFlight.has(key)) {
        continue;
      }
      if (snapshot.failedKeys.has(key)) {
        continue;
      }
      if (isOccupyingJob(snapshot.jobs, verb, taskId, snapshot.livePaneIds)) {
        continue;
      }
      if (snapshot.liveTabKeys.has(key)) {
        // A tab named verb::id is live in the managed session — a launched
        // worker occupies the slot before its jobs row binds. Complements
        // `isOccupyingJob` by covering the pre-SessionStart gap.
        continue;
      }
      // Fold-lag-immune cooldown arm: suppress re-dispatch of a key dispatched
      // within the last `REDISPATCH_COOLDOWN_S` seconds even when every
      // projection arm above is blind to it. READ-ONLY; stamp/clear in
      // `runReconcileCycle`, sweep in `driveCycle`. ABOVE the budget gate.
      if (isInCooldown(state.redispatchCooldown, key, now)) {
        continue;
      }
      const cwd =
        task.target_repo != null && task.target_repo !== ""
          ? task.target_repo
          : projectDir;
      if (cwd === "") {
        // No effective cwd — skip rather than dispatch a malformed command
        // (a missing project_dir is a data bug, not a runtime decision).
        continue;
      }
      // Cap — LAST gate, after every verdict is computed. A budget skip does NOT
      // hold a slot; it defers this launch to a later cycle.
      if (budget <= 0) {
        continue;
      }
      // Resolve the launch-time worker-plugin cell from the TASK's {model, tier}
      // (NOT the orchestrator's session model/effort). Compose in a try/catch so
      // a corrupt out-of-matrix pair becomes a per-launch reject the producer
      // mints as a sticky `DispatchFailed` — a raw throw here would deterministically
      // wedge the whole reconcile cycle (`driveCycle`'s backstop logs and re-drives).
      let pluginDir: string | null = null;
      let pluginDirReject: string | undefined;
      if (verb === "work") {
        try {
          pluginDir = workerCellPluginDir(
            task.model ?? null,
            task.tier ?? null,
          );
        } catch (err) {
          pluginDirReject = err instanceof Error ? err.message : String(err);
        }
      }
      launches.push({
        verb,
        id: taskId,
        key,
        cwd,
        workerCommand: buildWorkerCommand(
          verb,
          taskId,
          cwd,
          snapshot.workerModel,
          snapshot.workerEffort,
          pluginDir,
        ),
        model: snapshot.workerModel,
        effort: snapshot.workerEffort,
        tier: verb === "work" ? task.tier : null,
        pluginDir,
        ...(pluginDirReject !== undefined ? { pluginDirReject } : {}),
      });
      budget--;
    }
    // Close row.
    const epicId = epic.epic_id;
    const closeVerdict = readiness.perCloseRow.get(epicId);
    const closeVerb = verbForVerdict("close", closeVerdict);
    if (closeVerb !== null) {
      const closeKey = dispatchKey(closeVerb, epicId);
      const okToPlan =
        !state.paused &&
        !state.inFlight.has(closeKey) &&
        !snapshot.failedKeys.has(closeKey) &&
        !isOccupyingJob(
          snapshot.jobs,
          closeVerb,
          epicId,
          snapshot.livePaneIds,
        ) &&
        // Standing dedup arm: a live `close::<epic>` tab proves a launched closer
        // occupies the slot before its SessionStart binds.
        !snapshot.liveTabKeys.has(closeKey) &&
        // Fold-lag-immune cooldown arm at the close-row site too (miss it and
        // close rows still DUP-DISPATCH). READ-ONLY; ABOVE the budget gate.
        !isInCooldown(state.redispatchCooldown, closeKey, now) &&
        // Per-epic FINALIZER guard — an epic-id-keyed fold-lag-immune backstop
        // against a `close` re-dispatch. READ-ONLY; stamp/clear in
        // `runReconcileCycle`, sweep in `driveCycle`.
        !(
          isFinalizerVerb(closeVerb) &&
          isFinalizerGuarded(state.finalizerGuard, epicId, now)
        ) &&
        // Narrowed armed-mode close gate. In `armed` mode a close dispatch is
        // eligible ONLY for an epic in the armed dep-closure (`eligible.has`) OR
        // in-flight (`isEpicInFlight`). A COLD never-touched, never-armed
        // candidate is suppressed (no repeated closers on an unarmed sibling); a
        // disarmed-MID-FLIGHT epic still finishes. No-op in `yolo`. ABOVE the
        // budget gate. The per-root mutex and completion-reap stay mode-EXEMPT —
        // this is the ONLY close-dispatch narrowing.
        !(
          armedMode &&
          !eligible?.has(epicId) &&
          !isEpicInFlight(
            epic,
            snapshot.jobs,
            snapshot.liveTabKeys,
            snapshot.livePaneIds,
          )
        ) &&
        // Cross-epic merge-gate: suppress the single plan-close while ANY of the
        // epic's groups is deferred (`Map.has(epicId)` ⇒ ≥1 deferred lane repo) — the
        // close gates every group's finalize, so an epic with an un-cut lane is not
        // yet ready to audit + finalize. EPHEMERAL, no sticky; ABOVE the budget gate
        // (the `budget > 0` term below is last). Inert (empty map) in OFF / yolo.
        !deferredEpicIds.has(epicId) &&
        // Cap — the close-row push shares the SAME decrementing budget as the
        // task push, so a closer can't blow the cap.
        budget > 0;
      if (okToPlan && projectDir !== "") {
        launches.push({
          verb: closeVerb,
          id: epicId,
          key: closeKey,
          cwd: projectDir,
          workerCommand: buildWorkerCommand(
            closeVerb,
            epicId,
            projectDir,
            snapshot.workerModel,
            snapshot.workerEffort,
          ),
          model: snapshot.workerModel,
          effort: snapshot.workerEffort,
          tier: null,
          // A `close` row is cell-less — it loads no per-cell worker plugin.
          pluginDir: null,
          // Every close-row launch is an epic finalizer (`close`);
          // the cycle glue stamps the per-epic guard for these.
          isEpicFinalizer: true,
        });
        budget--;
      }
    }
  }

  // Worktree-mode post-pass. OFF (the default): no worktree code runs,
  // `worktreeFinalize` is empty, and every launch stays byte-identical to today
  // (the producer adds only the on-default-branch assertion). ON: attach the pure
  // topology geometry to each launch (or a multi-repo reject marker), and collect
  // the per-epic finalize requests for the closers that reached done this cycle.
  // Kept as a SEPARATE pass over the assembled launches so the OFF path is
  // untouched and the worktree logic is isolated.
  const worktreeFinalize: WorktreeLaunchInfo[] = [];
  const worktreeSinkProvision: WorktreeLaunchInfo[] = [];
  // Gate ALL worktree producer work on not-paused, matching recover() (`:3126`):
  // finalize merges the epic base into the default branch and pushes, which a
  // paused autopilot must not do. Launches are already suppressed while paused, so
  // the geometry attach has nothing to decorate either.
  if (snapshot.worktreeMode && !state.paused) {
    // The producer-observable finalize trigger. Collect the epics whose
    // CLOSER JOB finished (the durable jobs projection, re-fold-safe + restart-safe)
    // — a BROADER trigger than `completedRowIds` (the close-row's `completed`
    // verdict, gated on the main `epics` projection folding `done`). `finalizeEpic`
    // then confirms real completion via the MAIN projection (`isEpicDone`) before
    // merging — a finished-but-not-done crashed closer is rejected there. Union'd
    // with `completedRowIds` so the pre-worktree done-on-main path is unchanged.
    const closerFinishedIds = new Set<string>();
    for (const epic of snapshot.epics) {
      if (
        closerJobFinished(snapshot.jobs, epic.epic_id, snapshot.livePaneIds)
      ) {
        closerFinishedIds.add(epic.epic_id);
      }
    }
    attachWorktreeGeometry(
      snapshot.epics,
      launches,
      completedRowIds,
      closerFinishedIds,
      worktreeFinalize,
      worktreeSinkProvision,
      worktreeGeometry.byEpicId,
    );
  }

  return {
    launches,
    completedRowIds,
    worktreeFinalize,
    worktreeSinkProvision,
    finalizeFailureIds: snapshot.finalizeFailureIds,
  };
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
  //  - lane DEFINITIVELY ABSENT → merged-and-torn-down → MERGED (no ancestry probe);
  //  - PRESENT ∧ ancestor of LOCAL default → MERGED; else (not-ancestor / errored /
  //    timed-out / unresolvable default) → NOT merged.
  const laneMergedInRepo = async (
    repoDir: string,
    laneBranch: string,
  ): Promise<boolean> => {
    const lanes = await enumerateLanes(repoDir);
    if (!lanes.ok) {
      return false; // enumeration inconclusive → NOT merged
    }
    if (!lanes.branches.has(laneBranch)) {
      return true; // DEFINITIVELY absent → merged-and-torn-down → MERGED
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
    try {
      if (resolution.kind === "ok") {
        if (await laneMergedInRepo(resolution.repoDir, laneBranch)) {
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
            ? await laneMergedInRepo(group.repoDir, laneBranch)
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
  // >1 distinct toplevel with the rollout flag OFF → today's whole-epic reject,
  // byte-identical (reason + sort). Flag ON drops through to the clustered
  // partition below.
  if (resolved.size > 1 && !multiRepoEnabled) {
    return {
      kind: "multi-repo",
      reason: `worktree-multi-repo: epic ${epic.epic_id} spans ${resolved.size} repos (${[...resolved].sort().join(", ")})`,
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
 * The per-epic worktree geometry {@link prepareWorktreeGeometry} resolves
 * to, consumed by the dispatch-side {@link attachWorktreeGeometry}:
 *  - `ok` — the derived plan + the RESOLVED repo dir (the lane base).
 *  - `disabled` — a not-worktree-friendly repo: dispatch sequentially on the shared
 *    checkout (one task per `repoDir`, cap-1), provisioning NO lane and minting NO
 *    sticky. A NORMAL, NON-error fallback — distinct from `reject`.
 *  - `reject` — a loud multi-repo / unresolved epic; the `reason` is minted as a
 *    sticky `DispatchFailed`. No lane was provisioned, so the epic never finalizes.
 *  - `cycle` — a cyclic `depends_on` DAG; the gate already skipped lane-keying, and
 *    dispatch re-throws the carried error to `driveCycle`'s backstop.
 *  - `clustered` — a multi-repo epic (rollout flag ON): one {@link GroupGeometry}
 *    per resolved toplevel, each independently a `worktree` plan or a `serial`
 *    shared-checkout group, plus the `primaryRepoDir` the single plan-close anchors
 *    to. A single-repo epic never clusters (it stays `ok`/`disabled`).
 */
type EpicWorktreeGeometry =
  | { kind: "ok"; plan: WorktreePlan; repoDir: string }
  | {
      kind: "clustered";
      groups: GroupGeometry[];
      primaryRepoDir: string;
    }
  | { kind: "disabled"; reason: string; repoDir: string }
  | { kind: "reject"; reason: string }
  | { kind: "cycle"; error: WorktreeCycleError };

/**
 * One per-repo lane group's derived geometry within a `clustered` epic. A
 * `worktree` group carries its derived {@link WorktreePlan} (base + ribs + sink);
 * a `serial` group carries none (its tasks dispatch on the shared checkout, keyed
 * cap-1 on the bare `repoDir`, exactly like the whole-epic `disabled` fallback).
 */
interface GroupGeometry {
  repoDir: string;
  mode: "worktree" | "serial";
  /** The derived lane plan — present IFF `mode === "worktree"`. */
  plan?: WorktreePlan;
}

/** The gate + dispatch geometry from ONE {@link prepareWorktreeGeometry} pass. */
interface PreparedWorktreeGeometry {
  /** Each `task_id` / `epic_id` → its lane worktree path (the gate's cap-1 re-key). */
  laneKeyById: Map<string, string>;
  /** Each `epic_id` → its resolved geometry (`ok` plan / `reject` / `cycle`). */
  byEpicId: Map<string, EpicWorktreeGeometry>;
}

/**
 * The SINGLE pure worktree-geometry derivation, consumed by BOTH
 * the gate (`computeReadiness` lane keys, via `laneKeyById`) AND dispatch
 * ({@link attachWorktreeGeometry}, via `byEpicId`), so the two never re-derive
 * lanes from raw strings and never diverge. Off the snapshot's RESOLVED
 * {@link WorktreeRepoResolution} classification:
 *  - `ok` → derive the deterministic {@link WorktreePlan} off the RESOLVED toplevel;
 *    emit lane keys (task → its lane path, epic id → the base lane) + an `ok` geometry.
 *  - `disabled` → key EVERY task id AND the epic id (close row) to the bare RESOLVED
 *    `repoDir` (NOT a per-lane path) + a `disabled` geometry. The shared toplevel key
 *    is what forces the allocator's cap-1 mutex so an all-`disabled` cycle serializes
 *    one worker per repo on the shared checkout. NEVER the `reject` branch (mints no
 *    sticky); the dispatch pass no-ops, so launches run worktree-less on the toplevel.
 *  - `multi-repo` / `unresolved` → a `reject` geometry carrying the sticky reason
 *    and NO lane keys (the gate keys those rows on `effectiveRoot`; the dispatch
 *    pass stamps the reject).
 *  - a cyclic `depends_on` DAG → `deriveWorktreePlan` throws {@link WorktreeCycleError};
 *    caught HERE as a `cycle` geometry (NO lane keys — the gate skips) and RE-THROWN
 *    by `attachWorktreeGeometry` so `driveCycle`'s cycle backstop fires. Catching it
 *    here (not at the call site) keeps one bad DAG from aborting the lane-key build
 *    for every OTHER epic.
 *
 * Pure: no fs/git (resolution already happened in the snapshot build). Exported for
 * the readiness/dispatch symmetry unit tests.
 */
export function prepareWorktreeGeometry(
  epics: readonly Epic[],
  worktreeRepoByEpicId: ReadonlyMap<string, WorktreeRepoResolution>,
): PreparedWorktreeGeometry {
  const laneKeyById = new Map<string, string>();
  const byEpicId = new Map<string, EpicWorktreeGeometry>();
  for (const epic of epics) {
    const resolution = worktreeRepoByEpicId.get(epic.epic_id);
    if (resolution !== undefined && resolution.kind === "disabled") {
      // A worktree-DISABLED repo: dispatch SEQUENTIALLY on the shared checkout,
      // never a lane. Key EVERY task id AND the epic id (close row) to the bare
      // resolved toplevel (NOT a per-lane path) so the allocator's lane-keyed cap-1
      // mutex serializes one worker per repo — the load-bearing safety invariant
      // (a non-empty `laneKeyById` is what forces cap-1 even under
      // `max_concurrent_per_root>1`). Record the `disabled` geometry, NOT a reject.
      const repoDir = resolution.repoDir;
      byEpicId.set(epic.epic_id, {
        kind: "disabled",
        reason: resolution.reason,
        repoDir,
      });
      laneKeyById.set(epic.epic_id, repoDir);
      for (const t of epic.tasks) {
        laneKeyById.set(t.task_id, repoDir);
      }
      continue;
    }
    if (resolution !== undefined && resolution.kind === "clustered") {
      // A CLUSTERED multi-repo epic: derive geometry per group INDEPENDENTLY. Each
      // group keys its own lanes — a `serial` group keys its tasks (and, if it is
      // the primary group, the close row) to the bare `repoDir` (the cap-1
      // shared-checkout mutex); a `worktree` group keys each rib to its lane path.
      // The single close row keys to the PRIMARY group only. A per-group
      // `deriveWorktreePlan` drops cross-repo `depends_on` edges (in-group parent
      // filter), so lanes never fork across a repo boundary. A cyclic in-group DAG
      // → whole-epic `cycle` geometry (dispatch re-throws to the backstop).
      const { groups, primaryRepoDir } = resolution;
      const taskById = new Map(epic.tasks.map((t) => [t.task_id, t]));
      const groupGeoms: GroupGeometry[] = [];
      let cycle: WorktreeCycleError | undefined;
      for (const group of groups) {
        const isPrimary = group.repoDir === primaryRepoDir;
        if (group.mode === "serial") {
          groupGeoms.push({ repoDir: group.repoDir, mode: "serial" });
          for (const taskId of group.taskIds) {
            laneKeyById.set(taskId, group.repoDir);
          }
          if (isPrimary) {
            laneKeyById.set(epic.epic_id, group.repoDir);
          }
          continue;
        }
        const groupTasks = group.taskIds
          .map((id) => taskById.get(id))
          .filter((t): t is Task => t !== undefined);
        let plan: WorktreePlan;
        try {
          plan = deriveWorktreePlan(epic.epic_id, group.repoDir, groupTasks);
        } catch (err) {
          if (err instanceof WorktreeCycleError) {
            cycle = err;
            break;
          }
          throw err;
        }
        groupGeoms.push({ repoDir: group.repoDir, mode: "worktree", plan });
        for (const a of plan.assignments) {
          if (a.isCloseSink) {
            continue;
          }
          laneKeyById.set(a.nodeId, a.worktreePath);
        }
        if (isPrimary) {
          laneKeyById.set(epic.epic_id, plan.baseWorktreePath);
        }
      }
      if (cycle !== undefined) {
        byEpicId.set(epic.epic_id, { kind: "cycle", error: cycle });
        continue;
      }
      byEpicId.set(epic.epic_id, {
        kind: "clustered",
        groups: groupGeoms,
        primaryRepoDir,
      });
      continue;
    }
    if (resolution === undefined || resolution.kind !== "ok") {
      // Unclassified (a producer bug — every epic IS classified when worktree mode
      // is ON) or a loud reject: stamp a `reject` geometry, NO lane keys. Never fall
      // back to a raw-string lane.
      const reason =
        resolution === undefined
          ? `worktree-repo-unresolved: epic ${epic.epic_id} was not classified`
          : resolution.reason;
      byEpicId.set(epic.epic_id, { kind: "reject", reason });
      continue;
    }
    const repoDir = resolution.repoDir;
    let plan: WorktreePlan;
    try {
      plan = deriveWorktreePlan(epic.epic_id, repoDir, epic.tasks);
    } catch (err) {
      if (err instanceof WorktreeCycleError) {
        byEpicId.set(epic.epic_id, { kind: "cycle", error: err });
        continue;
      }
      throw err;
    }
    byEpicId.set(epic.epic_id, { kind: "ok", plan, repoDir });
    // The close sink's lane (the epic BASE) is keyed under the epic id, since the
    // close row is keyed `close::<epic_id>` and resolves to `epic_id` at the gate.
    laneKeyById.set(epic.epic_id, plan.baseWorktreePath);
    for (const a of plan.assignments) {
      if (a.isCloseSink) {
        continue;
      }
      laneKeyById.set(a.nodeId, a.worktreePath);
    }
  }
  return { laneKeyById, byEpicId };
}

/**
 * The pure worktree post-pass over `reconcile`'s assembled
 * launches, consuming the SAME {@link prepareWorktreeGeometry} `byEpicId` the gate
 * keyed off (so dispatch never re-derives from raw `target_repo`/`project_dir`).
 * For each epic with launches or a pending finalize (when worktree mode is ON):
 *  - `disabled` → NO-OP: leave every launch worktree-less (no `worktree`, no
 *    `worktreeReject`) and collect no finalize. `plan.worktree === undefined` routes
 *    the producer through `assertOnDefaultBranch` on the shared checkout — byte-
 *    identical to worktree-mode-OFF. The gate already serialized these launches via
 *    the shared-toplevel lane key. NEVER a sticky reject.
 *  - `reject` (multi-repo / unresolved) → stamp `worktreeReject` on every launch so
 *    the producer mints the sticky `worktree-multi-repo` / `worktree-repo-unresolved`
 *    DispatchFailed and runs no git. No lane was provisioned, so no finalize.
 *  - `cycle` → RE-THROW the carried {@link WorktreeCycleError} so `driveCycle`'s
 *    cycle backstop fires (the gate already skipped lane-keying); no launch is ever
 *    emitted for the cyclic epic, which is the safe outcome.
 *  - `ok` → stamp each launch's {@link PlannedLaunch.worktree} with its node's
 *    assignment + the shared epic context (base branch/path, the RESOLVED repo dir,
 *    the lane order, the primary-parent branch). The close-row launch maps to the
 *    synthetic {@link CLOSE_SINK_ID} sink (pinned to base).
 *  - Collect a {@link WorktreeLaunchInfo} into `worktreeFinalize` for every `ok`
 *    epic that needs finalizing — its close-row id is in `completedRowIds` (the MAIN
 *    projection folded `status:done`) OR `closerFinishedIds` (the closer JOB
 *    finished, the BROADER producer-observable signal off the durable `jobs`
 *    projection). The producer merges that base into the default branch + tears
 *    down, confirming real completion via the MAIN projection (`isEpicDone`) first
 *    (`finalizeEpic`) — the closer writes `done` to the PRIMARY repo, not the lane.
 *  - `clustered` (multi-repo) → stamp each task launch with ITS group's assignment
 *    (a `serial` group's tasks stay worktree-less on the shared checkout); the
 *    single close launch maps to the PRIMARY group's sink (worktree-less if the
 *    primary group is serial). Push ONE `worktreeFinalize` entry per WORKTREE group
 *    (the single close gates ALL groups' finalizes); a non-primary group's sink
 *    additionally lands in `worktreeSinkProvision` — no close worker dispatches into
 *    it, so the producer runs its rib→base fan-in before finalize via `provision`.
 *
 * Pure: a total function of the epics + launches + id sets + the resolved geometry.
 */
function attachWorktreeGeometry(
  epics: Epic[],
  launches: PlannedLaunch[],
  completedRowIds: Set<string>,
  closerFinishedIds: Set<string>,
  worktreeFinalize: WorktreeLaunchInfo[],
  worktreeSinkProvision: WorktreeLaunchInfo[],
  byEpicId: ReadonlyMap<string, EpicWorktreeGeometry>,
): void {
  // Index launches by epic. A task launch belongs to the epic owning the task; a
  // close launch's id IS the epic id.
  const taskToEpic = new Map<string, string>();
  for (const epic of epics) {
    for (const t of epic.tasks) {
      taskToEpic.set(t.task_id, epic.epic_id);
    }
  }
  const epicOf = (l: PlannedLaunch): string | undefined =>
    l.verb === "close" ? l.id : taskToEpic.get(l.id);

  for (const epic of epics) {
    const epicId = epic.epic_id;
    const epicLaunches = launches.filter((l) => epicOf(l) === epicId);
    const needsFinalize =
      completedRowIds.has(epicId) || closerFinishedIds.has(epicId);
    if (epicLaunches.length === 0 && !needsFinalize) {
      continue;
    }

    const geom = byEpicId.get(epicId);
    if (geom === undefined || geom.kind === "reject") {
      // A multi-repo / unresolved (or — defensively — unclassified) epic: stamp the
      // sticky reject on every launch; never provision or finalize a lane (none
      // exists). Mirrors the gate, which left these rows un-keyed.
      const reason =
        geom?.kind === "reject"
          ? geom.reason
          : `worktree-repo-unresolved: epic ${epicId} was not classified`;
      for (const l of epicLaunches) {
        l.worktreeReject = { reason };
      }
      continue;
    }
    if (geom.kind === "cycle") {
      // A cyclic DAG — re-throw to `driveCycle`'s backstop; no launch is emitted.
      throw geom.error;
    }
    if (geom.kind === "disabled") {
      // A worktree-DISABLED epic: dispatch on the SHARED checkout, exactly like
      // worktree-mode-OFF. NO `worktree` geometry (so runWorktreeProducerStep takes
      // the `assertOnDefaultBranch` branch, unmodified cwd), NO `worktreeReject`
      // (mints no sticky), NO finalize (no lane was ever provisioned). The gate
      // already serialized these launches via the shared-toplevel lane key.
      continue;
    }
    if (geom.kind === "clustered") {
      // A CLUSTERED multi-repo epic: stamp each launch with ITS group's geometry.
      // Build a per-worktree-group stamp (assignment index + shared lane context),
      // an id→group map, and the primary group (the one hosting the close).
      const groupInfoFor = (
        plan: WorktreePlan,
        repoDir: string,
      ): ((a: WorktreeAssignment) => WorktreeLaunchInfo) => {
        const laneOrder = plan.assignments.map((a) => ({
          nodeId: a.nodeId,
          branch: a.branch,
          worktreePath: a.worktreePath,
        }));
        return (assignment) => ({
          assignment,
          baseBranch: plan.baseBranch,
          baseWorktreePath: plan.baseWorktreePath,
          repoDir,
          laneOrder,
          parentBranch: parentBranchFor(assignment, plan, epic.tasks),
        });
      };
      interface GroupStamp {
        repoDir: string;
        byNode: Map<string, WorktreeAssignment>;
        infoFor: (a: WorktreeAssignment) => WorktreeLaunchInfo;
      }
      const worktreeGroups: GroupStamp[] = [];
      const groupByTaskId = new Map<string, GroupStamp>();
      let primaryGroup: GroupStamp | undefined;
      for (const g of geom.groups) {
        if (g.mode !== "worktree" || g.plan === undefined) {
          continue; // serial group → shared checkout, no lane stamping
        }
        const stamp: GroupStamp = {
          repoDir: g.repoDir,
          byNode: new Map(g.plan.assignments.map((a) => [a.nodeId, a])),
          infoFor: groupInfoFor(g.plan, g.repoDir),
        };
        worktreeGroups.push(stamp);
        for (const a of g.plan.assignments) {
          if (!a.isCloseSink) {
            groupByTaskId.set(a.nodeId, stamp);
          }
        }
        if (g.repoDir === geom.primaryRepoDir) {
          primaryGroup = stamp;
        }
      }
      for (const l of epicLaunches) {
        if (l.verb === "close") {
          // The single close maps to the PRIMARY group's sink; a serial primary
          // (no plan) leaves it worktree-less (runs on the shared checkout).
          const sink = primaryGroup?.byNode.get(CLOSE_SINK_ID);
          if (primaryGroup !== undefined && sink !== undefined) {
            l.worktree = primaryGroup.infoFor(sink);
          }
          continue;
        }
        const stamp = groupByTaskId.get(l.id);
        const assignment = stamp?.byNode.get(l.id);
        if (stamp !== undefined && assignment !== undefined) {
          l.worktree = stamp.infoFor(assignment);
        }
        // A serial-group task (or a shell-element with no node) stays worktree-less.
      }
      if (needsFinalize) {
        // One finalize per WORKTREE group — the single close gates them all. A
        // NON-primary group's sink also needs a producer-side fan-in provision (no
        // close worker dispatched into it to assemble its base).
        for (const stamp of worktreeGroups) {
          const sink = stamp.byNode.get(CLOSE_SINK_ID);
          if (sink === undefined) {
            continue;
          }
          const sinkInfo = stamp.infoFor(sink);
          worktreeFinalize.push(sinkInfo);
          if (stamp.repoDir !== geom.primaryRepoDir) {
            worktreeSinkProvision.push(sinkInfo);
          }
        }
      }
      continue;
    }

    const { plan, repoDir } = geom;
    const byNode = new Map<string, WorktreeAssignment>();
    for (const a of plan.assignments) {
      byNode.set(a.nodeId, a);
    }
    const laneOrder = plan.assignments.map((a) => ({
      nodeId: a.nodeId,
      branch: a.branch,
      worktreePath: a.worktreePath,
    }));
    const infoFor = (assignment: WorktreeAssignment): WorktreeLaunchInfo => ({
      assignment,
      baseBranch: plan.baseBranch,
      baseWorktreePath: plan.baseWorktreePath,
      repoDir,
      laneOrder,
      parentBranch: parentBranchFor(assignment, plan, epic.tasks),
    });

    for (const l of epicLaunches) {
      const nodeId = l.verb === "close" ? CLOSE_SINK_ID : l.id;
      const assignment = byNode.get(nodeId);
      if (assignment === undefined) {
        // No topology node for this launch's id — a shell-element task with no
        // DAG presence, or a close launch on an epic with no tasks. Leave the
        // launch worktree-less; the producer's missing-worktree path mints a
        // sticky failure rather than launching into an unprovisioned lane.
        continue;
      }
      l.worktree = infoFor(assignment);
    }

    if (needsFinalize) {
      const sink = byNode.get(CLOSE_SINK_ID);
      if (sink !== undefined) {
        worktreeFinalize.push(infoFor(sink));
      }
    }
  }
}

/**
 * Resolve the PRIMARY-parent branch for a node's assignment: the lane a
 * rib forks off (or the node's own branch for an inheriting node / the base for a
 * root or the close sink). A rib's `inherited` is false and its primary parent is
 * the earliest-in-toposort in-DAG parent on a DIFFERENT branch (the
 * `worktree add ... <commitish>` source). Pure — re-derives the same fork source
 * the topology module used.
 */
function parentBranchFor(
  assignment: WorktreeAssignment,
  plan: WorktreePlan,
  tasks: Task[],
): string {
  if (assignment.inherited || assignment.isCloseSink) {
    // Inherits its own lane (or base) — no fresh fork; the "parent" branch is the
    // node's own branch (the producer skips the fork for an already-present lane).
    return assignment.branch;
  }
  // A rib: find the in-DAG parent whose branch differs from the rib's branch and
  // sorts earliest in the plan's toposort (the topology's primary-parent rule).
  const task = tasks.find((t) => t.task_id === assignment.nodeId);
  if (task === undefined) {
    return plan.baseBranch;
  }
  const branchByNode = new Map<string, string>();
  const orderIndex = new Map<string, number>();
  plan.assignments.forEach((a, i) => {
    branchByNode.set(a.nodeId, a.branch);
    orderIndex.set(a.nodeId, i);
  });
  let best: string | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const dep of task.depends_on) {
    const depBranch = branchByNode.get(dep);
    if (depBranch === undefined) {
      continue;
    }
    const rank = orderIndex.get(dep) ?? 0;
    if (rank < bestRank) {
      bestRank = rank;
      best = depBranch;
    }
  }
  return best ?? plan.baseBranch;
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
          if (merge.kind === "conflict") {
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
    recover(repos, isEpicDone, epicPresentAndNotDone) {
      return recoverWorktrees(
        repos,
        isEpicDone,
        run,
        undefined,
        epicPresentAndNotDone,
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
  | { kind: "would-clobber"; paths: string[] }
  | { kind: "non-ff" }
  | { kind: "not-turn-key"; reason: PushNotReadyReason }
  | { kind: "conflict"; stderr: string }
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
 * The producer-only crash/restart recovery sweep wrapped by
 * {@link WorktreeDriver.recover}. Exported so the fast tier drives both passes
 * with a fake {@link WorktreeGitRunner}; the real-git lifecycle lives in the slow
 * test. Pure of keeper.db / folds / the wall clock — it reads ONLY live git plus
 * the injected `isEpicDone` done-ness probe.
 *
 * Pass 1 (interrupted-merge abort): every linked worktree under each repo (the
 * registered base + ribs) is checked for a stale `MERGE_HEAD`; when present, abort
 * the merge then prune the repo's worktree admin entries. The next reconcile cycle
 * re-runs the merge from a clean tree (level-triggered retry).
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
 * ONLY after main has inserted (or failed to insert) the `Dispatched` event.
 * `ok` is `true` on a successful insert; `confirmRunning` launches only on
 * `ok:true`.
 */
export interface DispatchedAckMessage {
  type: "dispatched-ack";
  id: number;
  ok: boolean;
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

  // The default-scope (open) epics — the live work set — MERGED with the
  // recently-DONE window (`epics_recent_done`, time-bounded by its descriptor's
  // `recencyBound` on `updated_at`) so the close-row completion reap is
  // reachable. The `read()` helper passes no `nowSec`, so `runQuery` defaults the
  // recency cutoff to live `Date.now()/1000`. Dedup keys on `epic_id` with the
  // OPEN row winning (a collision is only a fold-lag transient; preferring the
  // live row keeps dispatch arms on the freshest view).
  const openEpics = read("epics") as unknown as Epic[];
  const doneEpics = read("epics_recent_done") as unknown as Epic[];
  const seenEpicIds = new Set<string>();
  const dedupedEpics: Epic[] = [];
  for (const epic of openEpics) {
    if (seenEpicIds.has(epic.epic_id)) {
      continue;
    }
    seenEpicIds.add(epic.epic_id);
    dedupedEpics.push(epic);
  }
  for (const epic of doneEpics) {
    if (seenEpicIds.has(epic.epic_id)) {
      continue;
    }
    seenEpicIds.add(epic.epic_id);
    dedupedEpics.push(epic);
  }
  // Route the creation-order seed through the single scheduling-order seam:
  // started epics sort first (Rule #1) so the reconciler finishes in-progress
  // epics before opening new ones, then `epic_number` within each tier.
  const epics = orderEpicsForScheduling(dedupedEpics);

  const jobs = new Map<string, Job>();
  for (const row of read("jobs") as unknown as Job[]) {
    jobs.set(row.job_id, row);
  }

  const subagentInvocations = collapseSubagentsByName(
    read("subagent_invocations") as unknown as SubagentInvocation[],
  ).map((g) => g.row);

  const gitStatusByProjectDir = projectGitStatusByProjectDir(
    read("git") as unknown as GitStatus[],
  );

  const failedKeys = new Set<DispatchKey>();
  const recoverFailureIds = new Set<string>();
  const finalizeFailureIds = new Set<string>();
  for (const row of read("dispatch_failures")) {
    const verb = (row as { verb?: unknown }).verb;
    const id = (row as { id?: unknown }).id;
    if (typeof verb === "string" && typeof id === "string") {
      failedKeys.add(dispatchKey(verb as Verb, id));
      // A recover-originated `close::<id>` row is eligible for the glue's
      // level-triggered auto-clear. Scope on the reason marker so a non-recover
      // close failure sharing the key is excluded (the clobber guard).
      const reason = (row as { reason?: unknown }).reason;
      if (
        verb === "close" &&
        typeof reason === "string" &&
        isWorktreeRecoverReason(reason)
      ) {
        recoverFailureIds.add(id);
      }
      // A per-repo finalize row (`finalizeEpic`'s `worktree-finalize-*` block) is
      // eligible for the finalize driver's level-clear. Scope on the id prefix so a
      // recover row and the epic-keyed provision `worktree-merge-conflict` (kept on
      // `close::<epic>` for the merge-escalation sweep's `planner@<epic>`) are both
      // excluded.
      if (verb === "close" && id.startsWith(WORKTREE_FINALIZE_ID_PREFIX)) {
        finalizeFailureIds.add(id);
      }
    }
  }

  // Read `pending_dispatches` ONCE for its TWO orthogonal uses (each row is a
  // dispatched-but-not-yet-bound worker): `liveTabKeys` (the same-`(verb,id)`
  // re-dispatch dedup arm) and `pendingDispatches` (the cross-sibling
  // `dispatch-pending` occupant fed into `computeReadiness`, via the shared
  // `projectPendingDispatches` helper so the readiness paths agree).
  const pendingRows = read("pending_dispatches");
  const liveTabKeys = new Set<DispatchKey>();
  for (const row of pendingRows) {
    const verb = (row as { verb?: unknown }).verb;
    const id = (row as { id?: unknown }).id;
    if (typeof verb === "string" && typeof id === "string") {
      liveTabKeys.add(dispatchKey(verb as Verb, id));
    }
  }
  const pendingDispatches = projectPendingDispatches(pendingRows);

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

  // The per-root dispatch concurrency count N rides the SAME singleton
  // row — resolve `max_concurrent_per_root ?? DEFAULT` (= 1, the one-task-per-root
  // mutex). An absent/never-set row, NULL, or a non-positive / non-integer value
  // → DEFAULT. Projection-pull only so a runtime `set_autopilot_config` lands the
  // very next cycle. RESERVED for task .2's allocator (carried but unconsumed now).
  const perRootRaw = (
    autopilotRows[0] as { max_concurrent_per_root?: unknown } | undefined
  )?.max_concurrent_per_root;
  const maxConcurrentPerRoot: number =
    typeof perRootRaw === "number" &&
    Number.isInteger(perRootRaw) &&
    perRootRaw > 0
      ? perRootRaw
      : DEFAULT_MAX_CONCURRENT_PER_ROOT;

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
  if (listPanes !== undefined) {
    try {
      const panes = await listPanes();
      if (panes !== null) {
        livePaneIds = new Set(panes.map((pane) => pane.paneId));
      }
    } catch (err) {
      console.error(
        "[autopilot-worker] listPanes probe threw (non-fatal):",
        err,
      );
    }
  }

  // Compute the PER-ROOT unseeded set so `reconcile` forces UNKNOWN only
  // for rows whose `effectiveRoot` is unseeded (a stale/failed root never darks
  // the whole board). The read connection is the autopilot's own. The gate is
  // bounded to the `seed_required`-set window: while the flag is CLEAR the set is
  // EMPTY (the gate is fully off), so a clean root that `retractGitStatus` later
  // DELETEd never re-wedges. While SET, a root is unseeded iff it has no
  // `git_status` row with `last_event_id > floor`. The seed-read helper degrades
  // a missing control row to `true` (treat unknown as unseeded).
  const unseededRoots = readGitProjectionSeedRequired(db)
    ? // normalize the gated read key to the toplevel write key (memoized)
      // so a subdir/symlink `target_repo` un-darks once its toplevel-keyed row
      // lands.
      unseededGatedRoots(db, readGitProjectionFloor(db), memoizedGitToplevel())
    : new Set<string>();

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

  return {
    epics,
    jobs,
    subagentInvocations,
    gitStatusByProjectDir,
    failedKeys,
    recoverFailureIds,
    finalizeFailureIds,
    liveTabKeys,
    livePaneIds,
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
        pending.resolve({ ok: msg.ok });
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
      parentPort?.postMessage({
        kind: "dispatch-failed",
        payload,
      } satisfies DispatchFailedMessage);
    },
    emitDispatchCleared: (payload) => {
      parentPort?.postMessage({
        kind: "dispatch-cleared",
        payload,
      } satisfies DispatchClearedMessage);
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

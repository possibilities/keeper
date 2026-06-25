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

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { ConfigError, loadPresetRegistry, type Preset } from "./agent/config";
import { computeEligibleEpics } from "./armed-closure";
import {
  BackstopCounters,
  type BackstopMessage,
  buildTimeoutRecord,
} from "./backstop-telemetry";
import {
  gitExec,
  type GitRunner as WorktreeGitRunner,
} from "./commit-work/git-exec";
import {
  DEFAULT_MAX_CONCURRENT_JOBS,
  DEFAULT_MAX_CONCURRENT_PER_ROOT,
  openDb,
  readGitProjectionFloor,
  readGitProjectionSeedRequired,
} from "./db";
import { defaultPlanPrompt } from "./dispatch-command";
import {
  agentwrapLaunch,
  createTmuxPaneOps,
  type LaunchSpec,
  MANAGED_EXEC_SESSION,
  type PaneInfo,
} from "./exec-backend";
import { unseededGatedRoots } from "./gated-roots";
import { memoizedGitToplevel } from "./git-toplevel";
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
import { runQuery } from "./server-worker";
import type { Epic, GitStatus, Job, SubagentInvocation, Task } from "./types";
import { watchLoop } from "./wake-worker";
import {
  abortInterruptedMerge as gitAbortInterruptedMerge,
  branchExists as gitBranchExists,
  currentBranch as gitCurrentBranch,
  ensureWorktree as gitEnsureWorktree,
  isAncestorOf as gitIsAncestorOf,
  listEpicBaseBranches as gitListEpicBaseBranches,
  listWorktrees as gitListWorktrees,
  mergeBranchInto as gitMergeBranchInto,
  pruneWorktrees as gitPruneWorktrees,
  removeWorktree as gitRemoveWorktree,
  resolveDefaultBranch as gitResolveDefaultBranch,
  type LockAcquirer,
  type MergeResult,
  type WorktreeEntry,
} from "./worktree-git";
import {
  CLOSE_SINK_ID,
  deriveWorktreePlan,
  type WorktreeAssignment,
  type WorktreePlan,
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
 * `pending_dispatches` lifetime — the fn-778 slow-cold-boot fix.
 *
 * The 2026-06-10 dup-close fired because a `close::<epic>` worker took 317s to
 * emit its first SessionStart (a far-tail `claude` cold boot under conn-cap
 * saturation). Its `pending_dispatches` row TTL-expired at ~120s (so `liveTabKeys`
 * lost the key), no `jobs` row had landed yet, and the cooldown — stamped at
 * dispatch and refreshed ONCE at the indoubt resolution (cover-end dispatch+260s)
 * — lapsed 1s before the re-dispatch at dispatch+261s. Every suppression arm was
 * legitimately clear; the single non-compounding indoubt re-stamp was the sole
 * cover and it was too short for the tail. (See the Evidence in the fn-778.2 spec
 * for the event-log timeline.)
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
 * Build the `claude` worker shell command for a `(verb, id, cwd)`, pinned
 * byte-for-byte by `test/autopilot-worker.test.ts`. Lives here rather than
 * re-exported to keep this worker's import graph narrow. The launcher carries
 * no tier flag — the `plan` plugin is always loaded and `/plan:work` spawns the
 * tier worker_agent. `--arthack-no-confirm` is an arthack-launcher flag (parsed
 * and stripped before the real claude binary) that suppresses the cwd
 * confirmation prompt so automated dispatch never hangs on a keystroke.
 * Pure — exported for tests.
 */
export function buildWorkerCommand(
  verb: Verb,
  id: string,
  projectDir: string,
  model: string = WORKER_MODEL,
  effort: string = WORKER_EFFORT,
): string {
  const cdPrefix = projectDir === "" ? "" : `cd ${projectDir} && `;
  const flags: string[] = [];
  // Model/effort default to the `WORKER_*` constants; the `worker` preset (when
  // present in `presets.yaml`) overrides them, resolved producer-side per cycle.
  flags.push("--model", model, "--effort", effort);
  flags.push("--agentwrap-no-confirm");
  // `--name <key>` adjacency is load-bearing for reap/classify parsing.
  flags.push("--name", `${verb}::${id}`);
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
 * Fail-SAFE: a missing registry yields an empty registry (constants), and a
 * malformed registry's `ConfigError` is SWALLOWED-to-constants here — the daemon
 * must never crash on a bad `presets.yaml`. Re-resolved per cycle (cheap
 * single-file parse) so a preset edit lands without a daemon bounce; never
 * file-watched.
 */
export function resolveWorkerLaunchConfig(configPath?: string): {
  model: string;
  effort: string;
} {
  let preset: Preset | undefined;
  try {
    const registry = loadPresetRegistry(
      ...(configPath === undefined ? [] : ([configPath] as const)),
    );
    preset = registry.presets.worker;
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(
        "[autopilot-worker] malformed presets.yaml — falling back to worker defaults:",
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
 * inputs {@link agentwrapLaunch} builds its invocation from. Mirrors
 * {@link buildWorkerCommand}'s flag choices EXACTLY (same model/effort/name/
 * prompt) — that parity is a drift guard kept alongside the shell-wrapped
 * `buildLaunchArgv` shape even though agentwrap reads only this spec. Pure —
 * exported for tests.
 */
export function buildPlannedLaunchSpec(
  verb: Verb,
  id: string,
  model: string = WORKER_MODEL,
  effort: string = WORKER_EFFORT,
): LaunchSpec {
  return {
    prompt: defaultPlanPrompt(verb, id),
    claudeName: dispatchKey(verb, id),
    model,
    effort,
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
   * fn-905: the PER-ROOT unseeded-git set. While `git_projection_state.seed_required`
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
}

/**
 * In-memory reconciler state — the paused flag plus the set of
 * `${verb}::${id}` dispatches currently in-flight on this reconciler.
 * "In-flight" spans the moment `reconcile` decides to dispatch (set on
 * the key) through the `confirmRunning` resolution path (clear on
 * either success OR failure). NEVER persisted — the reconciler restarts
 * cold; the durable signal is the `jobs` projection itself PLUS the
 * fn-674 per-cycle `liveTabKeys` probe, which re-derives the launch →
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
   * `true` IFF this is an EPIC-level finalizer (`close` at the close-row site,
   * keyed by epic id). The cycle glue stamps `state.finalizerGuard[id]` for these
   * only. Set at the close-row push; absent/false on every task launch.
   */
  isEpicFinalizer?: boolean;
  /**
   * fn-959 — the pure worktree geometry for this launch, computed in `reconcile`
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
   * fn-959 — set IFF this launch belongs to a multi-repo epic that worktree mode
   * rejects for v1. The producer mints a sticky `worktree-multi-repo`
   * `DispatchFailed` (cleared by `retry_dispatch`) and launches nothing. Mutually
   * exclusive with {@link worktree}.
   */
  worktreeReject?: WorktreeReject;
}

/**
 * The worktree geometry the producer needs for one launch (fn-959). Carries the
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
 * A loud worktree-mode rejection for one epic (fn-959) — a launch the producer
 * must NOT run but instead surface as a sticky `DispatchFailed`. Multi-repo
 * epics (per-task `target_repo` spanning more than one resolved repo dir) are
 * unsupported in worktree mode for v1, so every launch they would emit is
 * replaced by this marker; the producer mints `worktree-multi-repo: <reason>`
 * (cleared by `retry_dispatch`) and launches nothing for that key.
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
   * fn-959 — the per-epic worktree-finalize requests for this cycle: one entry
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
}

/**
 * Side-effect deps for the reconcile + confirm cycle. All injected so
 * the core stays pure (the test suite drives the same paths with fakes
 * — no real worker spawn).
 */
export interface ConfirmRunningDeps {
  /** Spawn the worker in a managed window keyed by `name`. agentwrap is the sole
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
   * fn-959 — the producer git driver for worktree mode. ABSENT whenever the
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
   * Tuning knobs — exposed as deps so tests can drive a 5ms / 50ms
   * cadence instead of seconds. Defaults applied in `runConfirmCycle`
   * when undefined.
   */
  pollIntervalMs?: number;
  ceilingMs?: number;
}

/**
 * The producer git driver for worktree mode (fn-959) — the side-effect seam
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
   * worktrees down. Returns `{ ok: true }` on a clean merge-and-teardown, or
   * `{ ok: false, reason }` on a merge conflict / dirty-teardown refusal (the
   * producer stops — no further merge, no teardown — and surfaces the reason).
   */
  finalizeEpic(
    info: WorktreeLaunchInfo,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
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
   * fn-959.7 — producer-only crash/restart recovery, run BEFORE each reconcile
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
   * Returns the failures (if any) for the caller to mint as sticky DispatchFailed;
   * a recovery failure NEVER throws past the driver (a producer git error must not
   * wedge the cycle).
   */
  recover(
    repos: readonly string[],
    isEpicDone: (epicId: string) => Promise<boolean>,
  ): Promise<WorktreeRecoveryFailure[]>;
}

/**
 * fn-959.7 — one recovery-pass failure surfaced by {@link WorktreeDriver.recover}.
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
 *  failure routes a TRANSIENT launch fail (agentwrap exit 4 / timeout-kill /
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
 * Payload shape the reconciler hands to `emitDispatched` (fn-678,
 * schema v50). Mirrors the `DispatchedPayload` interface in
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
 * (fn-724). `ok:true` means main DURABLY inserted the `Dispatched` event
 * onto the writable connection before replying; `ok:false` means the
 * insert threw (a writer-lock contention or DB failure). The reconciler
 * launches ONLY on `ok:true`; an `ok:false` (or a rejected ack-wait —
 * timeout / shutdown) aborts WITHOUT launching, so the SessionStart-
 * drains-before-`Dispatched` race that re-opened the fn-627 double-
 * dispatch window is closed.
 */
export interface DispatchedAck {
  ok: boolean;
}

/**
 * Payload shape for the producer-side TTL sweep's `DispatchExpired`
 * mint (fn-678, schema v50). Mirrors `src/reducer.ts`'s
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
 * leaves a usable login+interactive shell after `claude` exits (vim
 * fallback for the rare auto-close miss). The argv shape is the safe
 * quoting seam at the OS argv boundary — tmux forwards it verbatim
 * after `--`.
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
 * fn-756: the `blocked:job-pending → "approve"` arm is gone — there is no
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

  // fn-959: the worktree-mode LANE re-key for the allocator. EMPTY (the default)
  // whenever worktree mode is OFF — then `computeReadiness` keys on `effectiveRoot`,
  // byte-identical to today. ON: each row keys on its derived lane worktree path so
  // every worktree is a CAP-1 lane (two agents in one index = corruption) while
  // parallel sibling lanes run concurrently. Built off the SAME `deriveWorktreePlan`
  // the dispatch-side `attachWorktreeGeometry` post-pass uses, so the gate and the
  // dispatch never diverge.
  const laneKeyById = snapshot.worktreeMode
    ? buildLaneKeys(snapshot.epics)
    : new Map<string, string>();

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
    // fn-905: the per-root unseeded-git set → force UNKNOWN only for rows whose
    // `effectiveRoot` is unseeded (dispatch nothing into an unseeded root, while a
    // seeded sibling root still dispatches). Empty whenever `seed_required` is clear.
    snapshot.unseededRoots,
    // fn-954: the per-root dispatch concurrency count N (refreshed each cycle from
    // `autopilot_state.max_concurrent_per_root`) — drives the round-robin
    // allocator so up to N tasks dispatch concurrently into one root, spread
    // across its epics. The board latches the SAME N off `BootStatus`, so both
    // consumers compute identical demotions. Default 1 = one-task-per-root.
    state.maxConcurrentPerRoot,
    // fn-959: the worktree-mode lane re-key (empty when OFF). Re-keys the allocator
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
        ),
        model: snapshot.workerModel,
        effort: snapshot.workerEffort,
        tier: verb === "work" ? task.tier : null,
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
          // fn-742 — every close-row launch is an epic finalizer (`close`);
          // the cycle glue stamps the per-epic guard for these.
          isEpicFinalizer: true,
        });
        budget--;
      }
    }
  }

  // fn-959 — worktree-mode post-pass. OFF (the default): no worktree code runs,
  // `worktreeFinalize` is empty, and every launch stays byte-identical to today
  // (the producer adds only the on-default-branch assertion). ON: attach the pure
  // topology geometry to each launch (or a multi-repo reject marker), and collect
  // the per-epic finalize requests for the closers that reached done this cycle.
  // Kept as a SEPARATE pass over the assembled launches so the OFF path is
  // untouched and the worktree logic is isolated.
  const worktreeFinalize: WorktreeLaunchInfo[] = [];
  // Gate ALL worktree producer work on not-paused, matching recover() (`:3126`):
  // finalize merges the epic base into the default branch and pushes, which a
  // paused autopilot must not do. Launches are already suppressed while paused, so
  // the geometry attach has nothing to decorate either.
  if (snapshot.worktreeMode && !state.paused) {
    attachWorktreeGeometry(
      snapshot.epics,
      launches,
      completedRowIds,
      worktreeFinalize,
    );
  }

  return { launches, completedRowIds, worktreeFinalize };
}

/**
 * fn-959 — the pure worktree post-pass over `reconcile`'s assembled launches.
 * For each epic (when worktree mode is ON):
 *  - A MULTI-REPO epic (its tasks resolve to more than one distinct repo dir —
 *    `target_repo ?? project_dir` spanning toplevels) is unsupported in worktree
 *    mode for v1: every launch it produced is stamped `worktreeReject` so the
 *    producer mints a sticky `worktree-multi-repo` DispatchFailed and runs no git.
 *  - Else derive the deterministic {@link WorktreePlan} from the epic's task DAG
 *    and stamp each launch's {@link PlannedLaunch.worktree} with its node's
 *    assignment + the shared epic context (base branch/path, repo dir, the lane
 *    order, the primary-parent branch). The close-row launch maps to the synthetic
 *    {@link CLOSE_SINK_ID} sink (pinned to base).
 *  - Collect a {@link WorktreeLaunchInfo} into `worktreeFinalize` for every epic
 *    whose close-row id is in `completedRowIds` (the closer reached done) — the
 *    producer merges that base into the default branch + tears down.
 *
 * Pure: a total function of the epics + launches (the topology module touches no
 * fs/git). A `WorktreeCycleError` from a bad DAG is left to surface — a cyclic
 * `depends_on` is a data bug the topology module fails loud on, and that throw is
 * caught by `driveCycle`'s cycle-level backstop (no launch is fired for a cyclic
 * epic, which is the safe outcome).
 */
function attachWorktreeGeometry(
  epics: Epic[],
  launches: PlannedLaunch[],
  completedRowIds: Set<string>,
  worktreeFinalize: WorktreeLaunchInfo[],
): void {
  // Index launches by epic so each epic's plan is derived ONCE. A task launch
  // belongs to the epic owning the task; a close launch's id IS the epic id.
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
    const repoDir = epic.project_dir ?? "";
    const epicLaunches = launches.filter((l) => epicOf(l) === epicId);
    const needsFinalize = completedRowIds.has(epicId);
    if (epicLaunches.length === 0 && !needsFinalize) {
      continue;
    }

    // Multi-repo guard: distinct resolved repo dirs across the epic's tasks (the
    // pure "spanning toplevels" v1 heuristic). A single distinct dir (the common
    // case) is fine; >1 rejects loudly. An empty `project_dir` with no per-task
    // override still resolves to one empty dir (a data bug caught elsewhere).
    const repoDirs = new Set<string>();
    for (const t of epic.tasks) {
      repoDirs.add(
        t.target_repo != null && t.target_repo !== "" ? t.target_repo : repoDir,
      );
    }
    if (repoDirs.size > 1) {
      const reason = `worktree-multi-repo: epic ${epicId} spans ${repoDirs.size} repos (${[...repoDirs].sort().join(", ")})`;
      for (const l of epicLaunches) {
        l.worktreeReject = { reason };
      }
      // A multi-repo epic never finalizes a worktree (none was provisioned).
      continue;
    }

    const plan = deriveWorktreePlan(epicId, repoDir, epic.tasks);
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
 * fn-959 — the worktree-mode LANE re-key map fed to `computeReadiness`'s
 * allocator (the GATE side of the symmetric re-key; `attachWorktreeGeometry` is
 * the dispatch side). Maps each `task_id` → its lane worktree path and each
 * `epic_id` → the epic BASE worktree path (the close sink's lane), so the
 * allocator caps each worktree at one concurrent agent while parallel sibling
 * lanes run concurrently.
 *
 * Derives from the SAME `deriveWorktreePlan` + the SAME multi-repo guard as the
 * dispatch-side geometry pass, so the gate never diverges from dispatch:
 *  - A MULTI-REPO epic (its tasks span >1 resolved repo dir) is REJECTED for v1 in
 *    worktree mode — its rows are deliberately left UN-keyed so they fall through
 *    to `effectiveRoot` at the gate; the dispatch-side pass stamps the sticky
 *    `worktree-multi-repo` reject. No lane is provisioned, so no lane key exists.
 *  - A cyclic `depends_on` DAG makes `deriveWorktreePlan` throw; the epic is
 *    skipped here (rows fall through to `effectiveRoot`), and the dispatch-side
 *    geometry pass re-throws so `driveCycle`'s cycle backstop fires — no launch is
 *    ever emitted for a cyclic epic, so the gate verdict is moot.
 *
 * Pure: no fs/git (the topology module is a total function of the DAG). Exported
 * for the readiness/dispatch symmetry unit tests.
 */
export function buildLaneKeys(epics: Epic[]): Map<string, string> {
  const laneKeyById = new Map<string, string>();
  for (const epic of epics) {
    const repoDir = epic.project_dir ?? "";
    // Multi-repo guard — IDENTICAL to `attachWorktreeGeometry`: distinct resolved
    // repo dirs across the epic's tasks. >1 → rejected in worktree mode, leave the
    // rows un-keyed (they key on `effectiveRoot` and the dispatch pass rejects).
    const repoDirs = new Set<string>();
    for (const t of epic.tasks) {
      repoDirs.add(
        t.target_repo != null && t.target_repo !== "" ? t.target_repo : repoDir,
      );
    }
    if (repoDirs.size > 1) {
      continue;
    }
    let plan: WorktreePlan;
    try {
      plan = deriveWorktreePlan(epic.epic_id, repoDir, epic.tasks);
    } catch {
      // A cyclic DAG — skip lane-keying (rows fall through to `effectiveRoot`).
      // The dispatch-side geometry pass re-throws for the cycle backstop.
      continue;
    }
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
  return laneKeyById;
}

/**
 * fn-959 — resolve the PRIMARY-parent branch for a node's assignment: the lane a
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
  // structured input agentwrap (keeper's sole launch transport) builds its
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
      // TRANSIENT launch fail (agentwrap exit 4 / timeout-kill / bad-path). Do
      // NOT mint a sticky `DispatchFailed` — KEEP the `pending_dispatches` row
      // so the TTL sweep mints `DispatchExpired` and the normal expire path
      // re-dispatches. This routes EXACTLY like the ceiling `"indoubt"` outcome:
      // a transient that never binds feeds the K=3 never-bound breaker (bounded
      // retry → sticky), while a PERMANENT fail below skips the counter entirely.
      deps.recordTimeoutBackstop?.({ rescued: true, stalenessMs: 0 });
      return "indoubt";
    }
    // PERMANENT launch fail (agentwrap exit 3/1/2, a tmux backend failure, or a
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
  // never lapses while a phantom is in flight. fn-778 CORRECTION: this chain
  // bounds the FOLD-LAG round-trip, but NOT an arbitrary `claude` cold-boot tail —
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
    // fn-959 — worktree-mode producer step, BEFORE `confirmRunning` mints the
    // durable Dispatched. `launchCwd` is the cwd `confirmRunning` actually launches
    // into; it starts as the pure `plan.cwd` and is OVERRIDDEN to the lane worktree
    // path when worktree mode provisions one. Every git side effect lives here in
    // the producer (never a fold). All three branches mint sticky `DispatchFailed`
    // on a loud failure (cleared by `retry_dispatch`) and skip — per-key, so a
    // sibling launch keeps dispatching.
    let launchCwd = plan.cwd;
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
    // drift-guarded `cd <path>` prefix matches the actual launch cwd. (agentwrap
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
          );
    const argv = buildLaunchArgv(shell, workerCommand);
    const spec = buildPlannedLaunchSpec(
      plan.verb,
      plan.id,
      plan.model,
      plan.effort,
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

  // fn-959 — worktree-finalize pass. For each epic whose closer reached done this
  // cycle, merge the epic base into the resolved default branch (pushing once) and
  // tear the lanes down. Runs AFTER the launch loop (the closer that landed the
  // close commit on `keeper/epic/<id>` is already gone — the cap-1 lane + the
  // readiness gate guarantee no agent is live in the base when this fires). Driven
  // from THIS producer step (not the recent-done reap window) so it never depends
  // on `DONE_EPICS_REAP_WINDOW_SEC`. A merge conflict / dirty-teardown failure
  // mints a sticky `worktree-finalize` DispatchFailed keyed on the close row
  // (cleared by `retry_dispatch`) and STOPS that epic's finalize — no merge-to-
  // default, no teardown. Idempotent: `finalizeEpic` skips an already-merged base.
  if (deps.worktree !== undefined) {
    for (const info of decision.worktreeFinalize) {
      if (signal.aborted) {
        return;
      }
      const result = await deps.worktree.finalizeEpic(info);
      if (!result.ok) {
        deps.emitDispatchFailed({
          verb: "close",
          id: closeKeyEpicId(info),
          reason: result.reason,
          dir: info.repoDir,
          ts: deps.now(),
        });
      }
    }
  }
}

/**
 * fn-959 — the epic id a worktree-finalize failure is keyed on. The finalize
 * `WorktreeLaunchInfo` always carries the synthetic close-sink assignment, whose
 * branch is `keeper/epic/<epicId>`; strip the `keeper/epic/` prefix back to the
 * epic id so the sticky `DispatchFailed` lands on the SAME `close::<epicId>` key a
 * `retry_dispatch` clears.
 */
function closeKeyEpicId(info: WorktreeLaunchInfo): string {
  const prefix = "keeper/epic/";
  return info.baseBranch.startsWith(prefix)
    ? info.baseBranch.slice(prefix.length)
    : info.baseBranch;
}

/**
 * fn-959 — the producer's per-launch worktree step (the side-effect seam between
 * the pure plan and `confirmRunning`). Returns the cwd to launch into on success,
 * or a `{ ok:false, reason, dir }` the caller mints as a sticky `DispatchFailed`.
 * Three branches, mutually exclusive per the geometry the pure post-pass stamped:
 *  - `worktreeReject` → multi-repo epic, rejected loudly.
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
  if (plan.worktreeReject !== undefined) {
    return { ok: false, reason: plan.worktreeReject.reason, dir: launchCwd };
  }
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
 * fn-959 — build the production {@link WorktreeDriver} wrapping `worktree-git.ts`.
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
        // Fork the lane off the PRIMARY parent's branch tip (its own branch for an
        // inheriting node / a root — then `ensureWorktree` is a no-op or a base
        // checkout). `ensureWorktree` is idempotent + crash-recoverable.
        await gitEnsureWorktree(
          repoDir,
          worktreePath,
          branch,
          parentBranch,
          run,
        );
        // Run the fan-in pre-merges in order — sequential pairwise, each taking the
        // shared commit-work flock. A conflict aborts + fails loud + stops.
        for (const source of preMerges) {
          const merge: MergeResult = await gitMergeBranchInto(
            worktreePath,
            source,
            run,
          );
          if (merge.kind === "conflict") {
            return {
              ok: false,
              reason: `worktree-merge-conflict: merging ${source} into ${branch} — ${merge.stderr}`,
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
    async finalizeEpic(info) {
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
        const defaultBranch = await gitResolveDefaultBranch(repoDir, run);
        // Merge the epic base into the default branch IN THE MAIN worktree (the
        // repo dir is the main worktree, checked out on the default branch). This
        // is the single push to origin (commit-work skipped per-lane pushes).
        const onDefault = await gitCurrentBranch(repoDir, run);
        if (onDefault !== defaultBranch) {
          return {
            ok: false,
            reason: `worktree-finalize-not-on-default: ${repoDir} HEAD is ${onDefault}, expected ${defaultBranch} for the base merge`,
          };
        }
        const merge: MergeResult = await gitMergeBranchInto(
          repoDir,
          baseBranch,
          run,
        );
        if (merge.kind === "conflict") {
          return {
            ok: false,
            reason: `worktree-finalize-conflict: merging ${baseBranch} into ${defaultBranch} — ${merge.stderr}`,
          };
        }
        // Push the single merge-to-default. A push failure stops finalize (no
        // teardown) so the lanes survive for a retry.
        const push = await run(["push"], {
          cwd: repoDir,
          env: { GIT_TERMINAL_PROMPT: "0" },
        });
        if (push.code !== 0) {
          return {
            ok: false,
            reason: `worktree-finalize-push-failed: ${(push.stdout + push.stderr).trim()}`,
          };
        }
        // Tear down every lane worktree (base + ribs). NEVER blind-`--force`; a
        // dirty lane refuses and surfaces so the human drains it manually.
        const paths = new Set<string>([baseWorktreePath]);
        for (const lane of laneOrder) {
          paths.add(lane.worktreePath);
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
    recover(repos, isEpicDone) {
      return recoverWorktrees(repos, isEpicDone, run);
    },
  };
}

/**
 * fn-959.7 — the producer-only crash/restart recovery sweep wrapped by
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
 * Every git error is caught and returned as a {@link WorktreeRecoveryFailure}; a
 * recovery error NEVER throws past here so a producer git failure can't wedge the
 * cycle.
 */
export async function recoverWorktrees(
  repos: readonly string[],
  isEpicDone: (epicId: string) => Promise<boolean>,
  run: WorktreeGitRunner = gitExec,
  acquireLock?: LockAcquirer,
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
    if (bases.length === 0) {
      continue;
    }
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
    for (const base of bases) {
      try {
        if (!(await isEpicDone(base.epicId))) {
          continue; // epic still open — its base is merged by `finalizeEpic`, not here
        }
        // Idempotency guard: an already-merged base is an ancestor of default.
        if (await gitIsAncestorOf(repo, base.branch, defaultBranch, run)) {
          continue;
        }
        // The merge runs in the MAIN worktree (the repo dir), which must be on the
        // default branch for the base to land there. A non-default HEAD means a
        // human (or another lane) is mid-checkout — fail loud, retry next cycle.
        const head = await gitCurrentBranch(repo, run);
        if (head !== defaultBranch) {
          failures.push({
            epicId: base.epicId,
            reason: `worktree-recover-not-on-default: ${repo} HEAD is ${head}, expected ${defaultBranch} to merge ${base.branch}`,
            dir: repo,
          });
          continue;
        }
        const merge: MergeResult = acquireLock
          ? await gitMergeBranchInto(repo, base.branch, run, acquireLock)
          : await gitMergeBranchInto(repo, base.branch, run);
        if (merge.kind === "conflict") {
          failures.push({
            epicId: base.epicId,
            reason: `worktree-recover-conflict: merging ${base.branch} into ${defaultBranch} — ${merge.stderr}`,
            dir: repo,
          });
          continue;
        }
        // Push the recovered merge once (the per-lane pushes were skipped).
        const push = await run(["push"], {
          cwd: repo,
          env: { GIT_TERMINAL_PROMPT: "0" },
        });
        if (push.code !== 0) {
          failures.push({
            epicId: base.epicId,
            reason: `worktree-recover-push-failed: ${(push.stdout + push.stderr).trim()}`,
            dir: repo,
          });
        }
      } catch (err) {
        failures.push({
          epicId: base.epicId,
          reason: `worktree-recover-failed: ${base.branch} — ${errMsg(err)}`,
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
 * fn-959.7 — the deduped, non-empty repo dirs to sweep in the worktree recovery
 * pass: every snapshot epic's `project_dir` (the main worktree each epic's lanes
 * fork off). The recovery scan itself enumerates `keeper/epic/*` bases per repo
 * from live git, so this only narrows the sweep to repos autopilot actually
 * tracks (an empty/absent `project_dir` contributes nothing).
 */
export function reposForRecovery(epics: readonly Epic[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const epic of epics) {
    const dir = epic.project_dir;
    if (dir == null || dir === "" || seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    out.push(dir);
  }
  return out;
}

/**
 * fn-959.7 — the done-ness probe the recovery backstop threads into the driver.
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
   * ONLY when this is `"autopilot"`. The reaper worker imports this module
   * for its `loadReconcileSnapshot` export and runs as `!isMainThread`
   * itself — the gate stops that import from booting a stowaway reconciler
   * (racing dispatch decisions against the real one) inside the reaper
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
  for (const row of read("dispatch_failures")) {
    const verb = (row as { verb?: unknown }).verb;
    const id = (row as { id?: unknown }).id;
    if (typeof verb === "string" && typeof id === "string") {
      failedKeys.add(dispatchKey(verb as Verb, id));
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

  // fn-954: the per-root dispatch concurrency count N rides the SAME singleton
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

  // fn-959: the durable worktree-mode toggle rides the SAME singleton row —
  // resolve `worktree_mode truthy` (an absent/never-set row, NULL, or 0 = OFF,
  // the no-worktree dispatch; only a stored 1 = ON). Projection-pull only so a
  // runtime `set_autopilot_config` lands the very next cycle. ON → `reconcile`
  // stamps each launch with the pure worktree geometry; OFF → no geometry (the
  // producer adds only the on-default-branch assertion).
  const worktreeRaw = (
    autopilotRows[0] as { worktree_mode?: unknown } | undefined
  )?.worktree_mode;
  const worktreeMode: boolean = worktreeRaw === 1;

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

  // fn-905: compute the PER-ROOT unseeded set so `reconcile` forces UNKNOWN only
  // for rows whose `effectiveRoot` is unseeded (a stale/failed root never darks
  // the whole board). The read connection is the autopilot's own. The gate is
  // bounded to the `seed_required`-set window: while the flag is CLEAR the set is
  // EMPTY (the gate is fully off), so a clean root that `retractGitStatus` later
  // DELETEd never re-wedges. While SET, a root is unseeded iff it has no
  // `git_status` row with `last_event_id > floor`. The seed-read helper degrades
  // a missing control row to `true` (treat unknown as unseeded).
  const unseededRoots = readGitProjectionSeedRequired(db)
    ? // fn-921: normalize the gated read key to the toplevel write key (memoized)
      // so a subdir/symlink `target_repo` un-darks once its toplevel-keyed row
      // lands.
      unseededGatedRoots(db, readGitProjectionFloor(db), memoizedGitToplevel())
    : new Set<string>();

  // Resolve the `worker` preset per cycle (cheap single-file parse, fail-safe to
  // the WORKER_* constants) — producer-side launch config, never a fold input.
  const { model: workerModel, effort: workerEffort } =
    resolveWorkerLaunchConfig();

  return {
    epics,
    jobs,
    subagentInvocations,
    gitStatusByProjectDir,
    failedKeys,
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
    // fn-954: seed the in-memory per-root DEFAULT (= 1); the FIRST `driveCycle`
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
      agentwrapLaunch({
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
    // fn-959 — the producer git driver. Wired unconditionally: when worktree mode
    // is ON `reconcile` stamps each launch with geometry the driver provisions;
    // when OFF the driver runs only the on-default-branch assertion. The branch-
    // guard hook does NOT fire here — this is the daemon producer shelling git
    // directly, not a plan-worker subagent's Bash.
    worktree: createWorktreeDriver(),
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
        // fn-778: re-anchor the cooldown + finalizer guard to any key still
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
        // fn-954: refresh N the same way so a runtime `set_autopilot_config`
        // {max_concurrent_per_root} takes effect this cycle. Snapshot already
        // resolved `column ?? DEFAULT` (= 1).
        state.maxConcurrentPerRoot = snapshot.maxConcurrentPerRoot;
        // fn-959.7 — producer-only worktree crash/restart recovery, BEFORE the
        // dispatch decision (so the first boot cycle is the post-restart sweep).
        // Gated on worktree mode ON AND not-paused (recovery does git merges +
        // pushes, the same side-effect class the dispatch loop suppresses while
        // paused). Reads ONLY live git + the durable done-ness probe; never a fold.
        // Wrapped so a producer git failure can't wedge the wake loop.
        if (snapshot.worktreeMode && !state.paused && deps.worktree) {
          try {
            const repos = reposForRecovery(snapshot.epics);
            const failures = await deps.worktree.recover(repos, (epicId) =>
              isEpicDoneById(db, epicId),
            );
            for (const f of failures) {
              deps.emitDispatchFailed({
                verb: "close",
                // A path-tied recovery failure (no epic) keys on a slug of the dir so
                // the operator can clear the row — see worktreeRecoverDispatchId.
                id: f.epicId ?? worktreeRecoverDispatchId(f.dir),
                reason: f.reason,
                dir: f.dir,
                ts: deps.now(),
              });
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
// module (the reaper pulls `loadReconcileSnapshot` from here) must NOT boot a
// stowaway reconciler in that thread — the role gate enforces that.
if (
  !isMainThread &&
  (workerData as AutopilotWorkerData | undefined)?.role === "autopilot"
) {
  main();
}

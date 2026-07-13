/**
 * Pure verdict core for the autopilot reconciler.
 *
 * Holds the re-fold-safe verdict engine the reconciler wakes on each
 * `data_version` pulse: `reconcile(snapshot, state, now)` walks every epic / task
 * / close-row, decides the verb each readiness verdict wants, and emits a
 * `PlannedLaunch` for each unless a suppression arm fires. Alongside it live the
 * pure worktree lane geometry (`prepareWorktreeGeometry` / `attachWorktreeGeometry`),
 * the failure-key helpers (`recoverFailureDispatchId` and friends), and the small
 * pure predicates the walk pulls (`verbForVerdict`, `isOccupyingJob`,
 * `isInCooldown`, `isFinalizerGuarded`, `closerJobFinished`, …).
 *
 * This module is a total function of its inputs on the verdict path: it shells no
 * git, opens no DB, reads no wall-clock, and reaches no `homedir()` while
 * reconciling — the worktree root is injected through the snapshot. Every side
 * effect (snapshot loading, the git drivers, recover/finalize, the message pump)
 * stays in `src/autopilot-worker.ts`, which re-exports every symbol here so
 * existing imports keep resolving. `KEEPER_ROOT` is a module-load constant
 * (resolved once, never re-read on the verdict path), so the per-cycle cell-path
 * derivation stays fs-free at reconcile time.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  composeWorkerAgent,
  workerCellDir,
} from "../plugins/plan/src/worker_cells.ts";
import { computeEligibleEpics } from "./armed-closure";
import { defaultPlanPrompt } from "./dispatch-command";
import {
  SLOT_OCCUPIED_REASON_PREFIX,
  SLOT_RECLAIMED_REASON_PREFIX,
  WORKTREE_RECOVER_KEY_PREFIX,
} from "./dispatch-failure-key";
import type { LaunchSpec } from "./exec-backend";
// TYPE-ONLY — the fs-touching provider-equivalence loader is a launcher island the
// reconcile-core depgraph pin forbids the pure core from value-importing (the map is
// parsed PRODUCER-SIDE and rides the snapshot as data). These are the reduced runtime
// types the pure `applyProviderConstraint` reads; the walker drops type-only edges.
import type {
  EquivalenceCell,
  EquivalenceDirection,
  ProviderConstraintRejectReason,
  ProviderConstraintResult,
  ProviderEquivalenceSnapshot,
  WorkerProvider,
} from "./provider-equivalence";
import {
  computeReadiness,
  isRootOccupant,
  type PendingDispatch,
  type Verdict,
} from "./readiness";
import type { Epic, Job, SubagentInvocation, Task } from "./types";
import {
  CLOSE_SINK_ID,
  deriveWorktreePlan,
  repoDirHash,
  type WorktreeAssignment,
  WorktreeCycleError,
  type WorktreePlan,
} from "./worktree-plan";

/**
 * One entry of a synthetic `WorktreeRepoStatus` event — the worktree-eligibility
 * verdict for ONE epic the autopilot reconciler marked `disabled` (a
 * not-worktree-friendly repo → serial shared-checkout dispatch). `mode` is the
 * dispatch shape (`serial`); `reason` names the disabling signal (a
 * `worktree-disabled:*` string). The producer here and the reducer's
 * `WorktreeRepoStatus` fold share this one contract; `reducer.ts` re-exports it.
 */
export interface WorktreeRepoStatusEntry {
  epic_id: string;
  repo_dir: string;
  mode: string;
  reason: string;
}

/**
 * One entry of a synthetic `LaneMerged` event — ONE epic whose worktree lane
 * branch (`keeper/epic/<id>`) the autopilot reconciler probed as merged into the
 * LOCAL default branch (an ancestor of default, OR torn-down after a merge —
 * keeper deletes a base only once it is an ancestor of default). The durable
 * "merge-landed" observable the planning daisy-chain needs, which `complete`
 * (done-AND-idle) does not guarantee in worktree mode (a dependent lane is cut
 * before the upstream's finalize merge lands). The producer here and the reducer's
 * `LaneMerged` fold share this one contract; `reducer.ts` re-exports it.
 */
export interface LaneMergedEntry {
  epic_id: string;
  repo_dir: string;
}

/**
 * One flagged STALE-BASE lane — an epic whose ALREADY-CUT worktree lane
 * (`keeper/epic/<id>`) in `repo_dir` was forked off a base MISSING the landed work of
 * a satisfied same-resolved-repo upstream (the lane was cut before the upstream
 * landed, so its workers hit DEPENDENCY_BLOCKED with nothing naming the cause). The
 * producer probe here and the per-(epic,repo) distress escalation share this one
 * contract. Purely observational — drives NO dispatch arm and mints no `dispatch_
 * failures` row itself (the grace tracker escalates it to the `stale-base-lane`
 * distress family).
 */
export interface StaleBaseLaneEntry {
  epic_id: string;
  repo_dir: string;
}

/** One worktree lane whose base has drifted beyond the producer thresholds. */
export interface BaseDriftEntry {
  epic_id: string;
  repo_dir: string;
  behind_count: number;
  merge_base_age_seconds: number;
}

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

/** The four discriminated host-matrix load-failure states (ADR 0036) — the same
 *  vocabulary the launcher island's `MatrixConfigError` carries, restated inline so
 *  the pure verdict core never imports the fs-touching matrix loader. Structurally
 *  identical, so a producer maps `MatrixConfigError.state` onto it directly. */
export type MatrixFailureState =
  | "absent"
  | "unparseable"
  | "schema-invalid"
  | "valid-but-empty";

/** A worker cell's driver: `native` iff claude serves the model, else `wrapped`
 *  (a value copy of `agent/matrix`'s `Driver` — kept local so the pure verdict
 *  core never value-imports the fs-touching matrix loader). */
export type CellDriver = "native" | "wrapped";

/** The parsed host-matrix cell axes the pure core composes worker cells over —
 *  `subagent_models` (the worker-cell model axis, native + wrapped), each model's
 *  effective effort list, and the top-level effort fallback. */
export interface HostMatrixAxes {
  /** `subagent_models` — the worker-cell eligibility axis, declaration order. */
  models: string[];
  /** capability → its effective effort list (canonical ascending). A model absent
   *  here inherits {@link efforts}. */
  effortsByModel: Map<string, string[]>;
  /** the top-level effort axis — the fallback a model no entry narrows inherits. */
  efforts: string[];
  /** capability → its driver (native iff claude serves it, else wrapped), the
   *  producer-side copy of the matrix's `driverByModel`. The SINGLE source the
   *  shared {@link isWrappedCell} predicate reads so the autopilot producer, the
   *  manual dispatch path, and the template renderer's `current_driver` notion
   *  never drift. A model absent from the map is treated as wrapped (mirrors the
   *  renderer's `driverByModel.get(model) ?? "wrapped"`). */
  driverByModel: ReadonlyMap<string, CellDriver>;
}

/**
 * The ONE wrappedness predicate — is the EFFECTIVE cell's model wrapped (not
 * natively served by claude)? Keyed on the cell driver, NOT on whether the
 * `worker_provider` pin translated the cell: a pre-assigned gpt/codex cell is
 * wrapped with a null constraint, so a constraint check would silently miss it.
 * An absent driver reads as wrapped, mirroring the template renderer's
 * `driverByModel.get(model) ?? "wrapped"` so the guard-marker and the rendered
 * worker contract agree. Pure — the axes carry the driver map producer-side.
 */
export function isWrappedCell(axes: HostMatrixAxes, model: string): boolean {
  return (axes.driverByModel.get(model) ?? "wrapped") === "wrapped";
}

/**
 * The standardized, per-task provider-leg result-envelope path — an ABSOLUTE
 * path under the repo's gitignored `.keeper/state/`. It is the `--output` target
 * the wrapped worker's provider leg writes its result envelope to, and the file
 * task .4's detection surface probes to flag a wrapped-cell task done-stamped
 * with no leg result. Absolute so the leg (running in the worker cwd) and the
 * producer (reading it back) resolve the SAME location regardless of cwd. Pure.
 */
export function wrappedEnvelopePath(repoDir: string, taskId: string): string {
  return join(
    repoDir,
    ".keeper",
    "state",
    "wrapped-envelopes",
    `${taskId}.json`,
  );
}

/**
 * The serializable host-matrix field carried on the reconcile snapshot: the parsed
 * cell axes when `matrix.yaml` loaded clean, or a four-state failure discriminator
 * when it did not. Built PRODUCER-SIDE once per cycle in `loadReconcileSnapshot`
 * (never re-read on the verdict path), so one reconcile cycle sees exactly one
 * matrix verdict — a mid-cycle edit cannot flip it. A failure parks every `work`
 * dispatch behind a visible distress sticky naming the state, never a `fatalExit`.
 */
export type HostMatrixSnapshot =
  | ({ ok: true } & HostMatrixAxes)
  | { ok: false; state: MatrixFailureState; detail: string };

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
 * the injected matrix axes (reusing {@link composeWorkerAgent}'s corrupt-on-disk
 * guard) rather than blind-joining a bogus cell path — the caller catches the throw
 * and turns it into a visible sticky `DispatchFailed`, never an opaque
 * agent-not-found inside a spawned session. Pure: the axes arrive as injected
 * snapshot data (`loadReconcileSnapshot` reads `matrix.yaml` producer-side) and
 * `KEEPER_ROOT` is resolved once at load, so the verdict path reaches no filesystem.
 */
export function workerCellPluginDir(
  model: string | null,
  tier: string | null,
  axes: HostMatrixAxes,
): string | null {
  // Validate the pair against the injected axes (throws on out-of-matrix) and reuse
  // the null-either-axis stop — the composed agent name itself is discarded here.
  // The per-model effort resolver honors a ragged host roster (a provider/model that
  // narrowed its effort list); an unknown model falls back to the top-level axis and
  // is named by composeWorkerAgent's separate model-membership throw.
  const effortsFor = (m: string): readonly string[] =>
    axes.effortsByModel.get(m) ?? axes.efforts;
  if (composeWorkerAgent(effortsFor, axes.models, tier, model) === null) {
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

/** A model's effective effort list off the injected axes — a per-model narrowing
 *  when present, else the top-level axis (mirrors {@link workerCellPluginDir}'s
 *  resolver so target-on-host validation honors a ragged host roster). */
function axesEffortsFor(
  axes: HostMatrixAxes,
  model: string,
): readonly string[] {
  return axes.effortsByModel.get(model) ?? axes.efforts;
}

/** The equivalence direction that translates a CROSS-family assigned cell INTO
 *  the pinned family: pinning to gpt reads `claude_to_gpt`, pinning to claude
 *  reads `gpt_to_claude`. */
function directionForProvider(provider: WorkerProvider): EquivalenceDirection {
  return provider === "gpt" ? "claude_to_gpt" : "gpt_to_claude";
}

/**
 * The pure translation seam — the ONE helper the reconcile cell-compose site AND
 * manual `keeper dispatch` both apply, so a task under a given pin resolves the
 * SAME dispatch cell either way (`.4` acceptance: identical translation decisions).
 * Given the task's ASSIGNED cell, the durable `worker_provider` pin, the cycle's
 * ONE parsed map snapshot, and the live host-matrix axes, it returns:
 *  - `unchanged` — the assigned cell is ALREADY in the pinned family (host-blind:
 *    its model is a source model of the pinned direction), a byte-identical no-op;
 *  - `translated` — the cross-family assigned cell's mapped equivalent, validated
 *    dispatchable on the live host matrix;
 *  - `reject` — fail-closed, NEVER a silent fallback: `map-malformed` (the snapshot
 *    failed to load), `no-map-entry` (no mapping for this cross-family cell), or
 *    `target-not-on-host` (the mapped target is not a live dispatchable cell).
 * Pure: the map + axes arrive as injected snapshot data, so the verdict path
 * reaches no filesystem (the depgraph pin holds).
 */
export function applyProviderConstraint(
  assigned: EquivalenceCell,
  provider: WorkerProvider,
  snapshot: ProviderEquivalenceSnapshot,
  axes: HostMatrixAxes,
): ProviderConstraintResult {
  const direction = directionForProvider(provider);
  if (!snapshot.ok) {
    return {
      kind: "reject",
      reason: "map-malformed",
      provider,
      direction,
      assigned,
      target: null,
      detail: snapshot.detail,
    };
  }
  const map = snapshot.map;
  const inPinnedFamily =
    provider === "gpt"
      ? map.gptFamilyModels.has(assigned.model)
      : map.claudeFamilyModels.has(assigned.model);
  if (inPinnedFamily) {
    return { kind: "unchanged" };
  }
  const table = provider === "gpt" ? map.claudeToGpt : map.gptToClaude;
  const target = table.get(assigned.model)?.get(assigned.effort);
  if (target === undefined) {
    return {
      kind: "reject",
      reason: "no-map-entry",
      provider,
      direction,
      assigned,
      target: null,
    };
  }
  if (
    !axes.models.includes(target.model) ||
    !axesEffortsFor(axes, target.model).includes(target.effort)
  ) {
    return {
      kind: "reject",
      reason: "target-not-on-host",
      provider,
      direction,
      assigned,
      target,
    };
  }
  return { kind: "translated", cell: target };
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
 * Escalation-session `--model` / `--effort` — the launch defaults for the two
 * autonomous escalation dispatches (`unblock::<task>`, `deconflict::<epic>`).
 * DELIBERATELY independent of the `WORKER_*` worker knobs: an escalation session
 * boots a purpose-built plan skill on a fresh sonnet/high context, so its defaults
 * never track the worker cell's. These are pure constants (the re-fold-safe core
 * may host them); the config-reading resolver that coalesces an `escalation`
 * preset over them lives in `src/escalation-config.ts`, kept OUT of this pure
 * verdict core — which never value-imports the `presets.yaml` reader (the
 * `reconcile-core` depgraph pin bans the `node:fs` edge that would drag on). */
export const ESCALATION_MODEL = "sonnet" as const;
export const ESCALATION_EFFORT = "high" as const;
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
  dispatchedModel?: string | null,
  dispatchedTier?: string | null,
  dispatchConstraint?: WorkerProvider | null,
  wrappedCell?: string | null,
  wrappedEnvelope?: string | null,
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
    // The dispatched-cell carriers (ADR 0047) — set ONLY when the pin translated
    // the assigned cell, so an unconstrained / same-family launch leaves them off
    // and stays byte-identical (the exec builder always emits them empty).
    ...(dispatchedModel != null && dispatchedModel !== ""
      ? { dispatchedModel }
      : {}),
    ...(dispatchedTier != null && dispatchedTier !== ""
      ? { dispatchedTier }
      : {}),
    ...(dispatchConstraint != null ? { dispatchConstraint } : {}),
    // The wrapped-cell guard carriers (task .1) — set ONLY for a wrapped effective
    // cell, so a native launch leaves them off and stays byte-identical (the exec
    // builder always emits both empty).
    ...(wrappedCell != null && wrappedCell !== "" ? { wrappedCell } : {}),
    ...(wrappedEnvelope != null && wrappedEnvelope !== ""
      ? { wrappedEnvelope }
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
  return `${WORKTREE_RECOVER_KEY_PREFIX}${dir
    .replace(/[/\\]+/g, "-")
    .replace(/^-+/, "")}`;
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
  return `${WORKTREE_RECOVER_KEY_PREFIX}${epicId}-${repoDirHash(repoDir)}`;
}

/**
 * The `dispatch_failures` id a {@link recoverWorktrees} failure keys on. Epic-tied →
 * the per-(epic,repo) {@link worktreeRecoverEpicDispatchId}; a path-tied failure (no
 * epic — the pass-1 list/abort/default-branch/base-list failures) → the per-dir
 * {@link worktreeRecoverDispatchId} slug. The mint, the positive-evidence clear in
 * {@link recoverFailuresToClear}, AND the {@link WorktreeRecoveryResolution}
 * observation set ALL route through this one helper so their keys never drift out of
 * lockstep — a one-sided change would strand rows un-clearable. Takes the `(epicId,
 * dir)` pair structurally so both a failure and a resolution key identically.
 */
export function recoverFailureDispatchId(f: {
  epicId: string | null;
  dir: string;
}): string {
  return f.epicId != null
    ? worktreeRecoverEpicDispatchId(f.epicId, f.dir)
    : worktreeRecoverDispatchId(f.dir);
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
  /** The shared readiness-input read returned an ERROR frame. This is an
   *  absence of observation, so dispatch and reap decisions defer this cycle. */
  readinessDegraded: boolean;
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
   * The `(verb, id)` of every OPEN slot-occupancy `dispatch_failures` row (its
   * `reason` carries a {@link isSlotOccupancyReason} prefix — `slot-reclaimed` /
   * `slot-occupied`). The slot pass level-clears any whose key no longer has a
   * wanted stopped-live occupant this cycle. SCOPED to the slot REASON (collected
   * at read time) so a genuine `close::<epic>` conflict sharing the natural key is
   * NEVER auto-dismissed — the reason-scope discipline the recover clear uses.
   */
  slotOccupancyFailures: { verb: Verb; id: string }[];
  /**
   * The `repoDir`s that currently have an OPEN per-repo shared-checkout-wedge
   * distress row (synthetic `daemon::shared-checkout-wedge:<repoHash>`, collected off
   * the row's `dir`). PRODUCER-ONLY: read by the recover pass's grace tracker to
   * level-clear a distress row whose checkout has since recovered — NOT by the pure
   * `reconcile`. Off the durable projection (not in-memory) so a restarted worker
   * still clears a distress it minted before the restart. Optional for call-site
   * back-compat; an absent field is an empty set (no open distress).
   */
  sharedWedgeDistressDirs?: Set<string>;
  /**
   * The `repoDir`s that currently have an OPEN per-repo shared-checkout-DIRTY
   * distress row (synthetic `daemon::shared-checkout-dirty:<repoHash>`, collected off
   * the row's `dir`). The SIBLING of {@link sharedWedgeDistressDirs} on a distinct id
   * prefix — PRODUCER-ONLY, read by the recover pass's dirt grace tracker to
   * level-clear a dirt distress row whose checkout has since gone clean, NOT by the
   * pure `reconcile`. Off the durable projection so a restarted worker still clears a
   * distress it minted before the restart. Optional for call-site back-compat; an
   * absent field is an empty set (no open dirt distress).
   */
  sharedDirtyDistressDirs?: Set<string>;
  /**
   * The `repoDir`s that currently have an OPEN per-repo shared-checkout-DESYNC distress
   * row (synthetic `daemon::shared-checkout-desync:<repoHash>`, collected off the row's
   * `dir`). PRODUCER-ONLY: the per-cycle desync content probe re-seeds its in-memory
   * latch from THIS durable set (so a restarted worker still probes + clears a distress
   * it minted before the restart) and level-clears any row whose checkout has since
   * caught up to the default tip. A LIVE-producer sibling — never drained like {@link
   * sharedWedgeDistressDirs} / {@link sharedDirtyDistressDirs} — on its own id prefix so
   * the surfaces never cross-clear. Optional for call-site back-compat; an absent field
   * is an empty set (no open desync distress).
   */
  sharedDesyncDistressDirs?: Set<string>;
  /**
   * The `(verb, id, dir)` of every OPEN fan-in LANE pre-merge `dispatch_failures`
   * row (its `reason` carries {@link WORKTREE_LANE_PREMERGE_REASON_PREFIX}; minted by
   * `provision()` on the NATURAL `work::<taskId>` key with the lane worktree path as
   * `dir`). The recover pass's verb-agnostic reason-scoped level-clear clears any
   * whose lane path is READY/gone this cycle, bypassing the router's `work-task`
   * short-circuit — so the row is SELF-CLEARING. Collected off the REASON (verb-
   * agnostic) so the clear scope stays disjoint from a genuine merge conflict on the
   * same key. Optional for call-site back-compat; an absent field is empty.
   */
  laneFailures?: { verb: Verb; id: string; dir: string }[];
  /**
   * The lane worktree PATHS that currently have an OPEN per-lane wedge distress row
   * (synthetic `daemon::worktree-lane-wedge:<laneHash>`, collected off the row's
   * `dir`). PRODUCER-ONLY: read by the recover pass's lane grace tracker to
   * level-clear a distress row whose lane has since gone ready/away — NOT by the pure
   * `reconcile`. Off the durable projection so a restarted worker still clears a
   * distress it minted before the restart. DISTINCT surface from {@link
   * sharedWedgeDistressDirs} (default-branch checkout dirs). Optional for call-site
   * back-compat; an absent field is an empty set (no open lane distress).
   */
  laneWedgeDistressDirs?: Set<string>;
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
   * Live pane id → its tmux `pane_current_command` (foreground process), from the
   * SAME read-time `listPanes()` sweep as {@link livePaneIds}. The slot-occupancy
   * gate reads it to tell a live/parked `claude` from the dead `exec $SHELL -l -i`
   * shell tail holding a stopped session's pane. `null` on the same degraded/absent
   * probe as `livePaneIds` (then the slot gate stays inert — no reclaim, no signal).
   * Assembled in {@link loadReconcileSnapshot}; NEVER read in a fold.
   */
  paneCommandById: ReadonlyMap<string, string> | null;
  /**
   * Job ids whose owning session the daemon has PROVEN dead — the recorded claude
   * pid re-proved gone by a producer-side `isPidAlive` probe at snapshot load,
   * mirroring the exit-watcher's own pid-death reprobe. The slot-occupancy reaper
   * ({@link computeSlotOccupancy}) reclaims a proven-dead occupant regardless of
   * its pane's foreground command, reaping the residual pane a lingering wrapper
   * shell or launcher process holds alive after claude exits — the gap the
   * pane-command heuristic and the pane-nulling `Killed` fold both miss. EMPTY on
   * a degraded probe. Assembled in {@link loadReconcileSnapshot}; NEVER read in a
   * fold (producer-side liveness only, so re-fold stays deterministic).
   */
  provenDeadJobIds: ReadonlySet<string>;
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
   * The `work`- and `close`-row `--model` / `--effort`, resolved producer-side
   * per cycle from the `dispatch:` table in `presets.yaml` (each verb COALESCING
   * onto {@link WORKER_MODEL}/{@link WORKER_EFFORT} when its row is
   * absent/malformed, ADR 0040). `close` is settable INDEPENDENTLY of `work` —
   * two separate `dispatch:` rows — so a close row may run a different model than
   * a work row. Assembled read-time in {@link loadReconcileSnapshot} so the pure
   * `reconcile` stays config-blind; threaded onto each {@link PlannedLaunch} so
   * both worker-command builders read the SAME resolved values. NEVER a fold input
   * — re-fold stays byte-identical regardless of which model runs.
   */
  workModel: string;
  workEffort: string;
  closeModel: string;
  closeEffort: string;
  /**
   * The host worker matrix (`~/.config/keeper/matrix.yaml`, ADR 0036), loaded ONCE
   * per cycle in {@link loadReconcileSnapshot} and attached as a serializable
   * discriminated field: the parsed cell axes when the file is good, or a
   * four-state {@link MatrixFailureState} failure when it is not. The pure
   * `reconcile` composes each `work` row's cell from the good axes, or threads the
   * failure onto the launch as a {@link PlannedLaunch.matrixReject} the producer
   * mints as a distress sticky — so one cycle sees exactly one matrix verdict and a
   * bad matrix parks dispatch without a `fatalExit`. NEVER a fold input.
   */
  hostMatrix: HostMatrixSnapshot;
  /**
   * The durable work-dispatch provider pin (`autopilot_state.worker_provider`,
   * ADR 0047), read FRESH from the singleton each cycle: NULL/absent (the
   * byte-identical unconstrained default) or a family (`"claude"`/`"gpt"`) every
   * cell-bearing `work` launch is translated into via {@link applyProviderConstraint}.
   * A `close` row is cell-less and untouched. Projection-pull only so a runtime
   * `set_autopilot_config` lands the next cycle; NEVER a fold input. Optional for
   * call-site back-compat — an absent field is unconstrained (no translation).
   */
  workerProvider?: WorkerProvider | null;
  /**
   * The parsed cross-provider equivalence map (`plugins/plan/provider-equivalence.yaml`),
   * loaded + reduced PRODUCER-SIDE in {@link loadReconcileSnapshot} ONCE per cycle
   * — but ONLY when {@link workerProvider} is set (an unconstrained cycle reads no
   * map). A discriminated field mirroring {@link hostMatrix}: the reduced runtime
   * map on a clean parse, or a typed failure the pure translation turns into a
   * per-cell `map-malformed` reject (fail-closed — a stale map never crashes the
   * cycle). Consulted ONLY under an active pin; an absent field with a pin set
   * fails closed as `map-malformed`. NEVER a fold input.
   */
  providerEquivalence?: ProviderEquivalenceSnapshot;
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
   * `autopilot_state` singleton's effective per-root cap each cycle. Projection-pull
   * only (no `workerData`, no config) so a runtime `set_autopilot_config` lands
   * the next cycle and N survives a restart. Refreshed onto
   * {@link ReconcileState.maxConcurrentPerRoot} in the cycle glue.
   */
  maxConcurrentPerRoot: number;
  /**
   * The durable worktree-mode toggle, read FRESH from the `autopilot_state`
   * singleton's `worktree_mode` column each cycle (resolved `column truthy?` — an
   * absent/never-set row, NULL, or 0 = OFF, the byte-identical no-worktree
   * dispatch; only a stored `1` = ON). Projection-pull only (no `workerData`, no
   * config) so a runtime `set_autopilot_config` lands the very next cycle and the
   * toggle survives a restart for free.
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
   * The durable MERGE-LANDED set — every `ok`-classified epic whose lane
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
  /**
   * Epic ids whose producer-side live-git probe proved the recovery-only close
   * conditions: every task is done, the still-present epic lane is an ancestor of
   * local default, and a prior closer finished while the epic remains open. The
   * pure reconciler reads only this plain fact; it never probes git itself.
   */
  closeRecoveryEligibleIds?: ReadonlySet<string>;
  /**
   * The STALE-BASE lane set (fn-1127) — every epic whose already-cut worktree lane
   * `keeper/epic/<id>` was forked off a base DEFINITIVELY MISSING a satisfied
   * same-resolved-repo upstream's landed work (probed via
   * {@link computeStaleBaseLaneEntries}). Producer-only, gated on {@link
   * worktreeMode}, read by the stale-base grace tracker to escalate a lane stale past
   * the grace into a per-(epic,repo) distress row — NEVER by the pure `reconcile`,
   * NEVER a fold input. Detection + surfacing ONLY: the merge-gate's cut-deferral is
   * untouched. Every inconclusive probe arm (enum failure, ancestry timeout, absent
   * refs) DEFERS to no-flag — a false distress is worse than a late one. EMPTY
   * whenever worktree mode is OFF. Optional so a test snapshot may omit it.
   */
  staleBaseLaneEntries?: readonly StaleBaseLaneEntry[];
  /**
   * The worktree lanes whose bases exceed the producer's behind-count and
   * merge-base-age thresholds. This is producer-probed plain data only; the pure
   * core carries it forward for the refresh producer and never probes git itself.
   * Empty whenever worktree mode is OFF. Optional for call-site back-compat.
   */
  baseDriftEntries?: readonly BaseDriftEntry[];
  /**
   * The `dispatch_failures.id`s that currently have an OPEN per-(epic,repo)
   * stale-base-lane distress row (synthetic `daemon::stale-base-lane:<epicId>-
   * <repoHash>`, collected off the row's `id`). PRODUCER-ONLY: read by the stale-base
   * grace tracker to level-clear a distress row whose lane has since been re-based
   * past the upstream or torn down (the probe stops reporting it stale) — NOT by the
   * pure `reconcile`. Off the durable projection (not in-memory) so a restarted worker
   * still clears a distress it minted before the restart. Keyed on the ID directly
   * (the per-(epic,repo) hash is one-way, unlike the shared-checkout dir sets).
   * Optional for call-site back-compat; an absent field is an empty set.
   */
  staleBaseDistressIds?: Set<string>;
  /**
   * The `dispatch_failures.id`s that currently have an OPEN per-(project,number)
   * duplicate-epic-number distress row (synthetic `daemon::dup-epic-number:<projectHash>-
   * <number>`, collected off the row's `id`). PRODUCER-ONLY: read by the duplicate-number
   * probe to level-clear a distress row whose duplicate no longer holds (a conflicting
   * epic renumbered, deleted, or gone done) — NOT by the pure `reconcile`. Off the durable
   * projection (not in-memory) so a restarted worker still clears a distress it minted
   * before the restart. Keyed on the ID directly (the per-(project,number) hash is
   * one-way). Optional for call-site back-compat; an absent field is an empty set.
   */
  dupEpicNumberDistressIds?: Set<string>;
  /**
   * Producer-side LIVE-JOB dirty attribution for the worktree pre-merge clean —
   * keyed by lane worktree path (== `file_attributions.project_dir`, realpath +
   * trailing-slash normalized), each value the repo-relative paths a currently-LIVE
   * job holds an undischarged mutation for there. The fan-in pre-merge clean consults
   * it to NEVER discard dirt a running worker owns. Computed ONCE per cycle in
   * {@link loadReconcileSnapshot} (gated on {@link worktreeMode}); read PRODUCER-SIDE
   * in `runReconcileCycle` and threaded into `provision`, NEVER by the pure
   * `reconcile` and NEVER a fold input. `null` = the read FAILED → do-not-discard
   * (every provision treats its base as live-attributed). Absent key = no live job
   * attributed dirt there. Optional so a test snapshot may omit it (→ do-not-discard).
   */
  liveAttributedDirtyByWorktree?: ReadonlyMap<
    string,
    ReadonlySet<string>
  > | null;
  /**
   * The worktrees root the pure lane geometry derives every lane path under —
   * `${homedir()}/worktrees`, resolved PRODUCER-SIDE in
   * {@link loadReconcileSnapshot} and threaded through so `reconcile` /
   * {@link prepareWorktreeGeometry} / `deriveWorktreePlan` reach no `homedir()` on
   * the verdict path (re-fold determinism: the pure layer reads no env). Optional —
   * when absent the worktree-plan helpers fall back to reading `homedir()`
   * themselves, which yields the byte-identical path, so a test snapshot may omit
   * it. Populated on every real cycle so the runtime verdict path stays env-free.
   */
  worktreesRoot?: string;
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
   * REFRESHED each cycle from {@link ReconcileSnapshot.maxConcurrentPerRoot} in
   * the cycle glue BEFORE `reconcile()` reads it — so a runtime
   * `set_autopilot_config` lands on the next cycle. Held on `state` (not read
   * straight off the snapshot) for the same reason as `maxConcurrentJobs`.
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
   * The task's CAPABILITY model — the model axis the cell names, distinct from
   * the orchestrator session {@link model}. Set for a `work` row (`task.model`),
   * null for a `close` row or a cell-less task. Threaded so the producer's
   * worker-cell resolution names the model the cell actually runs (not the session
   * model) in a reject reason; the pure compose validates it against the injected
   * matrix axes and the producer applies the filesystem probes.
   */
  cellModel: string | null;
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
   * Set IFF the cycle's host matrix (`snapshot.hostMatrix`) FAILED to load — the
   * four-state discriminator (ADR 0036). Carried on EVERY `work` row of a bad-matrix
   * cycle: with no matrix there is no cell to compose, so the producer mints a
   * visible per-state distress `DispatchFailed` (cleared by `retry_dispatch`) and
   * launches nothing, per-key, and the daemon loop continues (never a `fatalExit`).
   * Mutually exclusive with {@link pluginDir} / {@link pluginDirReject}.
   */
  matrixReject?: { state: MatrixFailureState; detail: string };
  /**
   * The DISPATCHED cell's model/tier when the `worker_provider` pin TRANSLATED the
   * assigned cell into the other family (ADR 0047) — the cell {@link pluginDir}
   * actually composes over, distinct from {@link cellModel}/{@link tier} (which
   * stay the untouched ASSIGNED cell for the selection record). BOTH null when no
   * translation happened (same-family or NULL-pin), so the launch is byte-identical
   * to today. The producer emits them as the always-present `KEEPER_PLAN_DISPATCHED_*`
   * env carriers (empty when null) and records them on the launch event.
   */
  dispatchedCellModel?: string | null;
  dispatchedCellTier?: string | null;
  /**
   * The `worker_provider` value that FORCED the translation (`"claude"`/`"gpt"`),
   * set ONLY when {@link dispatchedCellModel} is — the `KEEPER_PLAN_DISPATCH_CONSTRAINT`
   * carrier. Null/absent when unconstrained (empty carrier). `.5`'s claim-time
   * capture keys the selection cohort exclusion on this being present.
   */
  dispatchConstraint?: WorkerProvider | null;
  /**
   * The wrapped-cell guard marker for a `work` row whose EFFECTIVE cell is wrapped
   * (its model not natively served by claude — {@link isWrappedCell}). {@link
   * wrappedCell} is the effective `<model>::<effort>`; {@link wrappedEnvelope} is the
   * per-task provider-leg result-envelope path ({@link wrappedEnvelopePath}). BOTH
   * absent for a native cell / non-`work` row (the producer then emits the two
   * `KEEPER_WRAPPED_*` carriers EMPTY, overwriting any stale session-env marker).
   * Keyed on effective-cell wrappedness, never the pin — a pre-assigned gpt cell
   * with a null constraint is still marked. The guard (task .2) reads the emitted
   * env; this layer only ensures the signal is present and correct.
   */
  wrappedCell?: string;
  wrappedEnvelope?: string;
  /**
   * Set IFF the `worker_provider` pin could not translate this `work` row's assigned
   * cell — the fail-closed reject (ADR 0047), parallel to {@link matrixReject} /
   * {@link pluginDirReject}. Carries the machine fields the producer composes its
   * sticky `DispatchFailed` reason from (naming the cells + direction); NEVER a
   * fallback to the assigned provider. Mutually exclusive with a non-null
   * {@link pluginDir}. Ranks AFTER {@link matrixReject} (no host matrix ⇒ no target
   * to validate), BEFORE the cell compose.
   */
  providerReject?: {
    reason: ProviderConstraintRejectReason;
    provider: WorkerProvider;
    direction: EquivalenceDirection;
    assigned: EquivalenceCell;
    target: EquivalenceCell | null;
    detail?: string;
  };
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
 * The output of `reconcile`: the launches to fire PLUS the row ids whose verdict
 * is `{tag:"completed"}` this cycle. `completedRowIds` is harvested from the SAME
 * `computeReadiness` pass `reconcile` makes (single source of truth — `driveCycle`
 * must NOT recompute readiness) and holds task ids + epic ids; the completion-reap
 * predicate keys off `<id>` only.
 */
export interface CloseRecoveryStamp {
  epicId: string;
  key: DispatchKey;
  projectDir: string;
}

export interface ReconcileDecision {
  launches: PlannedLaunch[];
  closeRecoveryStamps: CloseRecoveryStamp[];
  completedRowIds: Set<string>;
  /** Plain producer-probed base-drift data, carried without any git/clock reads. */
  baseDriftEntries: readonly BaseDriftEntry[];
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
  /**
   * The slot-occupancy signals this cycle: one per wanted `(verb, id)` key whose
   * mint is blocked by a stopped-but-LIVE occupant. Each is a visible `DispatchFailed`
   * the producer routes through the change-gate; a non-null `reclaimPaneId` also
   * tells the producer to KILL that pane (a provably-dead session — bare shell tail
   * past its grace). EMPTY when paused or the liveness probe is degraded.
   */
  slotOccupancy: SlotOccupancySignal[];
  /**
   * The OPEN slot-occupancy failure keys whose occupant is GONE this cycle (pane
   * died, resumed to `working`, or the row's verdict completed) — the producer emits
   * a `DispatchCleared` for each. Mirrors `finalizeFailureIds`'s level-clear;
   * reason-scoped upstream so it never touches a genuine `close::<epic>` conflict.
   */
  slotOccupancyClears: { verb: Verb; id: string }[];
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
/**
 * The tri-state verdict a recover-pass epic probe resolves to. A content-status
 * condition, not a boolean: absence of an observation is NEVER resolution.
 *   - `done`         — the epic row is present and `status === "done"`.
 *   - `open`         — the epic row is present and not done (finalize owns its base).
 *   - `absent`       — no epic row (reaped / EpicDeleted); AUTHORITATIVE, since the
 *                      pk-lookup bypasses the OPEN scope and every recency floor.
 *   - `inconclusive` — a non-result (error) read frame; DEFER, never coerce.
 */
export type EpicRecoverVerdict = "done" | "open" | "absent" | "inconclusive";
/**
 * A TERMINAL pass-2 content-conflict escalation, distinct from a transient {@link
 * WorktreeRecoveryFailure}. The emit glue mints it as a `DispatchFailed` on the BARE
 * `close::<epicId>` id with a `worktree-merge-conflict` leading reason, so routing
 * classifies it merge-escalation (OUTSIDE both auto-clear scopes), the resolver-
 * dispatch and merge-escalation sweeps select it, and only `retry_dispatch` drops it
 * — matching finalize's close-sink conflict, never a `worktree-recover-*` degrade.
 */
export interface WorktreeRecoveryEscalation {
  epicId: string;
  reason: string;
  dir: string;
}
/**
 * A POSITIVE same-cycle resolution observation for a `(epicId, dir)` — the base
 * merged, was already an ancestor of default, the epic read authoritatively absent,
 * or a repo swept clean of path-tied failures. The positive-evidence clear
 * ({@link recoverFailuresToClear}) keys it through the SAME {@link
 * recoverFailureDispatchId} the mint uses (the lockstep rule), so an open recover row
 * clears ONLY on a matching observation — a cycle that produces no report retains it.
 */
export interface WorktreeRecoveryResolution {
  epicId: string | null;
  dir: string;
}
/**
 * The widened {@link WorktreeDriver.recover} outcome: transient `failures` (the
 * per-(epic,repo) `worktree-recover-*` auto-clear scope), terminal `escalations` (the
 * bare `close::<epic>` merge-escalation scope), and positive `resolved` observations
 * (the clear predicate's evidence set). Replaces the former bare failure list.
 */
export interface WorktreeRecoveryOutcome {
  failures: WorktreeRecoveryFailure[];
  escalations: WorktreeRecoveryEscalation[];
  resolved: WorktreeRecoveryResolution[];
  /**
   * Per-cycle fan-in LANE base-readiness observations, keyed by the lane worktree
   * PATH — the evidence the lane-wedge grace tracker + the verb-agnostic reason-scoped
   * clear consume. A keeper lane the recover sweep found NOT losslessly-mergeable
   * (dirty / off-branch / would-clobber, or a hard mid-merge `abort-failed` git could
   * not clear) is a `wedged` entry carrying its distress `reason` + whether it is
   * `immediate` (an `abort-failed` mints distress at once, not graced); a lane found
   * READY or torn down this cycle is a `resolved` path (the positive evidence that
   * clears its self-clearing `work::<taskId>` row + any open distress). Empty on the
   * OFF / no-lane path. Optional so a fake driver may omit them (→ no lane arm).
   */
  laneWedged?: { path: string; reason: string; immediate: boolean }[];
  laneResolved?: string[];
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
  // `Verb | "resolve"`: the reconciler's own dispatch verbs PLUS the daemon's
  // autonomous merge-resolver (`resolve::<epic>`), whose liveness the recover
  // pass reads through {@link epicHasActiveResolver}. The check is verb-agnostic
  // — a `plan_verb` string compare — so admitting `resolve` costs nothing.
  verb: Verb | "resolve",
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
 * Whether an autonomous merge-resolver worker (`resolve::<epicId>`) is currently
 * LIVE for `epicId` — the SCOPED, per-epic exclusion that replaces the resolver
 * brief's former GLOBAL `keeper autopilot pause`. The recover sweep's pass-1
 * interrupted-merge abort skips a lane whose epic has a live resolver, so the
 * resolver's own in-progress `git merge` (MERGE_HEAD set) is never raced and
 * aborted out from under it. The exclusion auto-lifts the instant the resolver
 * job reaps — a CLEAN exit OR a CRASH — so a dead resolver strands NOTHING (no
 * durable board-wide pause halting unrelated epics) and concurrent stuck fan-ins
 * stay independent (each epic gated on its OWN resolver job, never a shared
 * global flag one resolver's `play` could flip while another is mid-merge).
 * Reuses {@link isOccupyingJob}'s liveness arms.
 */
export function epicHasActiveResolver(
  jobs: Map<string, Job>,
  epicId: string,
  livePaneIds: ReadonlySet<string> | null,
): boolean {
  return isOccupyingJob(jobs, "resolve", epicId, livePaneIds);
}

/**
 * Does `epic` have an OCCUPYING close OR work job — the recover-pass teardown gate
 * that keeps a lane whose closer (or a mid-task worker) is still LIVE inside it from
 * being merged/torn out from under the session (ADR 0031: a deleted cwd →
 * posix_spawn ENOENT → a `working` zombie ghost-holding the slot). A thin
 * composition of the shared {@link isOccupyingJob} seam (close by epic id, work by
 * each task id) — no new liveness predicate, no cwd matching — so the reconciler and
 * board can never drift on what "occupies" means. Distinct from {@link isEpicInFlight}:
 * NO `liveTabKeys` arm — the recover producer gates on durable + live-pane occupancy
 * only, never the pre-SessionStart launch window. Returns on first occupant.
 */
export function epicHasOccupyingJob(
  epic: Epic,
  jobs: Map<string, Job>,
  livePaneIds: ReadonlySet<string> | null,
): boolean {
  if (isOccupyingJob(jobs, "close", epic.epic_id, livePaneIds)) {
    return true;
  }
  for (const task of epic.tasks) {
    if (isOccupyingJob(jobs, "work", task.task_id, livePaneIds)) {
      return true;
    }
  }
  return false;
}

/**
 * The terminal-outcome verdict of the autonomous `resolve::<epic>` merge-resolver,
 * or the not-yet-terminal signal — the gate the daemon deconflict-dispatch sweep reads
 * so it SEQUENCES the `deconflict::<epic>` session behind the resolver (the resolver,
 * tier 1, owns a mechanically-clear conflict; the deconflict is the judgment fallback).
 *
 * TURN-ACTIVE occupancy, mirroring {@link classifyEscalationOutcome}'s
 * `escalationJobLive`: a `resolve::<epic>` session is a one-shot interactive
 * `/plan:resolve` session that idles forever after its turn ends, so pane/pid liveness
 * (the {@link epicHasActiveResolver} rule) would count a FINISHED-but-idling resolver as
 * live and STARVE the deconflict dispatch indefinitely — the ghost-worker pitfall
 * (liveness is not progress). A resolver occupies only while `state === 'working'` (a
 * live turn); a `stopped` resolver has yielded its turn and reads TERMINAL. A mid-turn
 * permission prompt stamps `last_permission_prompt_at` but never flips `state` off
 * `working`, so a parked resolver stays turn-active here without a marker arm.
 * {@link epicHasActiveResolver} is left untouched — the recover pass's MERGE_HEAD-race
 * guard keeps the pane-liveness rule (a mid-merge resolver may not be re-`git merge`d
 * out from under, a distinct concern from terminal-outcome sequencing).
 *
 *  - `{ terminal: false }` — a resolver is still turn-active (`working`) OR no
 *    `resolve::<epic>` row has folded yet (the launch → SessionStart window). The
 *    deconflict WAITS.
 *  - `{ terminal: true, verdict }` — a resolver row folded AND none is turn-active, so
 *    the resolver reached a terminal outcome WITHOUT clearing the sticky (a CLEAR
 *    resolution retries the close, deleting the row, so this sweep never sees it).
 *    `verdict` is `"died"` when any matching row is `killed`/`ended` (the CLI process
 *    terminated — a one-shot session should idle `stopped` after its turn, never exit),
 *    else `"declined"` (it ran its turn, ended `stopped`, and the sticky survives — it
 *    attempted and gave up). Coarse by design and DIAGNOSTIC only: the deconflict-
 *    dispatch gate reads `.terminal`, never the verdict. Pure: reads only the passed
 *    jobs (never wall-clock / fs / a liveness re-probe), so it stays re-fold-safe.
 */
export type ResolverOutcome =
  | { terminal: false }
  | { terminal: true; verdict: "declined" | "died" };

export function classifyResolverOutcome(
  jobs: Map<string, Job>,
  epicId: string,
): ResolverOutcome {
  let live = false;
  let sawRow = false;
  let sawDead = false;
  for (const job of jobs.values()) {
    if (job.plan_verb !== "resolve" || job.plan_ref !== epicId) {
      continue;
    }
    sawRow = true;
    if (job.state === "working") {
      live = true;
    }
    if (job.state === "killed" || job.state === "ended") {
      sawDead = true;
    }
  }
  if (live || !sawRow) {
    return { terminal: false };
  }
  return { terminal: true, verdict: sawDead ? "died" : "declined" };
}

/**
 * Is a `stopped` job's backend session still LIVE? `null` `livePaneIds` (probe
 * unavailable) → assume live (the conservative pre-liveness fallback). A row
 * with no `backend_exec_pane_id` is not live-provable → not live here. Exported so
 * the producer live-job dirty-attribution pass (`loadReconcileSnapshot`) shares the
 * ONE liveness rule instead of forking it.
 */
export function isStoppedJobLive(
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

// ── Slot-occupancy visibility + auto-reclaim ───────────────────────────────

/**
 * Producer-`ts` seconds a `stopped` job's dead shell-tail pane must persist before
 * the reconciler AUTO-RECLAIMS its slot. The bare-shell foreground command already
 * proves claude exited (a live/parked claude reads `claude`/`node`/`bun`); the grace
 * is the secondary guard against a transient teardown/startup frame where the pane
 * momentarily shows the shell. Anchored on `job.updated_at` (the last fold instant —
 * frozen once the session stopped), compared to the reconcile `now`.
 */
export const SLOT_RECLAIM_GRACE_SEC = 120;

/**
 * Blast-radius bound on pane KILLS a single occupancy sweep may issue — mirrors
 * autoclose's {@link AUTOCLOSE_MAX_KILLS_PER_PULSE} so one bad projection frame
 * cannot cascade into a mass window close. Over-cap dead candidates DOWNGRADE to
 * visibility-only `slot-occupied` (never dropped) and are reconsidered next cycle,
 * since their `updated_at`/`state` persist — no local grace map is needed. The
 * kept set is chosen deterministically (lowest `(verb, id)` slot key wins) so it is
 * stable across cycles, never flaky.
 */
export const SLOT_RECLAIM_MAX_PER_SWEEP = 5;

/**
 * The idle-shell foreground command names the launch wrapper's trailing
 * `exec $SHELL -l -i` tail reports via tmux `pane_current_command` once the hosted
 * claude exits. CONSERVATIVE by construction — every entry is unambiguously a shell,
 * never a claude worker (`claude`/`node`/`bun`) — so a probe missing a shell name
 * UNDER-matches (ambiguous → visibility only), never the catastrophic over-match
 * that would kill a live session.
 */
const BARE_SHELL_COMMANDS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "tcsh",
  "csh",
]);

/**
 * Is a tmux `pane_current_command` the bare `exec $SHELL -l -i` tail — i.e. claude
 * has exited and only the trailing login shell holds the pane? A leading `-` (the
 * login-shell argv0 convention) is stripped first. `undefined` (pane absent from the
 * command map — probe degraded, or pane gone) is NOT a bare shell: the conservative
 * answer is "cannot prove dead." Pure — exported for the dead/live/ambiguous matrix.
 */
export function isBareShellCommand(command: string | undefined): boolean {
  if (command === undefined) {
    return false;
  }
  const bare = command.startsWith("-") ? command.slice(1) : command;
  return BARE_SHELL_COMMANDS.has(bare);
}

/** One slot-occupancy signal — a visible `DispatchFailed` on a wedged `(verb, id)`,
 *  plus (when provably dead) the pane to kill. `reclaimPaneId === null` is
 *  visibility-only (a possibly-resumable occupant). */
export interface SlotOccupancySignal {
  verb: Verb;
  id: string;
  reason: string;
  dir: string | null;
  reclaimPaneId: string | null;
}

/** The pure inputs the slot-occupancy pass reads — all liveness enters via the
 *  snapshot fields, so the decision stays a total function (re-fold safe). */
export interface SlotOccupancyInput {
  jobs: Map<string, Job>;
  livePaneIds: ReadonlySet<string> | null;
  paneCommandById: ReadonlyMap<string, string> | null;
  /**
   * Job ids whose owning session the daemon has PROVEN dead — the exit-watcher's
   * kernel-truth verdict (its recorded claude pid no longer exists), re-proved
   * producer-side at snapshot load. A proven-dead occupant is reclaimable
   * REGARDLESS of its pane's foreground command: after claude exits, a lingering
   * launch-wrapper shell or launcher process can keep the pane alive showing a
   * command that is neither `claude` nor the bare `exec $SHELL` tail, which the
   * pane-command heuristic ({@link isBareShellCommand}) cannot classify dead.
   * Keying reclaim on the lifecycle verdict — not pane cosmetics — reaps that
   * residual pane. EMPTY/absent (the degraded-probe default) falls back to the
   * bare-shell-only proof, never a mere stopped read.
   */
  provenDeadJobIds?: ReadonlySet<string>;
  /** OPEN slot-reason `dispatch_failures` keys (reason-scoped at read time). */
  openSlotFailures: readonly { verb: Verb; id: string }[];
  /** True IFF `reconcile` would dispatch `(verb, id)` if the slot were free (the
   *  readiness verdict maps to a verb) — the "mint is blocked / slot is needed" gate
   *  that leaves a completed row's inspection window untouched. */
  wantsDispatch: (verb: Verb, id: string) => boolean;
  paused: boolean;
  now: number;
  graceSec?: number;
}

/** The slot-occupancy pass output: the failures to surface (+ optional reclaim) and
 *  the open rows to clear. */
export interface SlotOccupancyDecision {
  failures: SlotOccupancySignal[];
  clears: { verb: Verb; id: string }[];
}

const slotKey = (verb: Verb, id: string): string => `${verb}\x00${id}`;

/**
 * Surface — and, when dead, reclaim — a slot held by a stopped-but-LIVE session, so
 * a wedged dispatch slot is never silent. For each `stopped` job whose pane is still
 * live AND whose key `reconcile` still wants to dispatch (the mint is blocked), a
 * pane past its grace is DEAD → kill it and mint `slot-reclaimed` when ANY of three
 * proofs hold: the daemon's proven-dead pid verdict, a bare-shell tail command, or
 * DERIVED IDLE — a session that went `working` (`active_since` non-null) and ended
 * its turn but stays resident. A NEVER-started row (`active_since` null) is not
 * derived-idle: it never ran a turn, so the derived arm never reclaims it (the
 * proven-dead / bare-shell arms still fire on their own evidence). Anything else (a
 * live/parked `claude` still mid-turn, or any candidate still in grace) is
 * `slot-occupied` visibility-only. Every OPEN slot row whose key got no fresh signal
 * (occupant gone / resumed to `working` / verdict completed) is cleared.
 *
 * Reclaims are blast-capped at {@link SLOT_RECLAIM_MAX_PER_SWEEP} per sweep, chosen
 * by lowest `(verb, id)` key; over-cap dead candidates downgrade to `slot-occupied`
 * (never dropped) and are reconsidered next cycle.
 *
 * Pure + re-fold-safe: reads only the snapshot's liveness fields and the readiness-
 * derived `wantsDispatch` gate. INERT (empty) when paused or the probe is degraded
 * (`livePaneIds`/`paneCommandById` null) — the conservative silent-occupy fallback.
 * A killed session mid-turn is the catastrophic failure, so a `working` row is never
 * a candidate and every DEAD criterion is grace-aged; when in doubt it surfaces only.
 */
export function computeSlotOccupancy(
  input: SlotOccupancyInput,
): SlotOccupancyDecision {
  const failures: SlotOccupancySignal[] = [];
  const clears: { verb: Verb; id: string }[] = [];
  const { livePaneIds, paneCommandById } = input;
  // Paused or degraded probe → no slot side effects at all.
  if (input.paused || livePaneIds === null || paneCommandById === null) {
    return { failures, clears };
  }
  const graceSec = input.graceSec ?? SLOT_RECLAIM_GRACE_SEC;
  const activeKeys = new Set<string>();
  // Per-key candidates collected before any signal is pushed, so the reclaim blast
  // cap selects deterministically across the WHOLE sweep, not per iteration.
  const candidates: {
    key: string;
    verb: Verb;
    id: string;
    paneId: string;
    command: string | undefined;
    dir: string | null;
    dead: boolean;
  }[] = [];
  for (const job of input.jobs.values()) {
    if (job.state !== "stopped") {
      continue;
    }
    const verb = job.plan_verb;
    const id = job.plan_ref;
    if ((verb !== "work" && verb !== "close") || id == null || id === "") {
      continue;
    }
    const paneId = job.backend_exec_pane_id;
    // The stopped arm of `isOccupyingJob`, inlined so a definite live pane id is in
    // hand: no pane / a pane gone from the sweep is not a live-provable occupant.
    if (paneId == null || paneId === "" || !livePaneIds.has(paneId)) {
      continue;
    }
    // Slot not needed → leave it. A completed row keeps its post-run inspection
    // window (the trailing shell); an unarmed / not-ready row holds nothing worth
    // reclaiming this cycle.
    if (!input.wantsDispatch(verb, id)) {
      continue;
    }
    const key = slotKey(verb, id);
    if (activeKeys.has(key)) {
      continue; // one signal per key even if two stopped rows share it
    }
    activeKeys.add(key);
    const command = paneCommandById.get(paneId);
    // Slot authority is the JOB LIFECYCLE, not pane cosmetics: a session the
    // daemon has PROVEN dead (its recorded claude pid gone) is reclaimable
    // whatever its pane's foreground command shows — a lingering launch-wrapper
    // shell or launcher process holding the pane never masks the verdict. The
    // bare-shell tail stays a SECONDARY proof for the degraded-probe cycle that
    // carries no pid verdict. Grace-aged every way (never immediate): the kill
    // waits `graceSec` past the last fold so a transient teardown frame is never
    // reaped, and the `wantsDispatch` gate already scopes it to a slot in demand.
    const provenDead = input.provenDeadJobIds?.has(job.job_id) ?? false;
    const graceElapsed = input.now - job.updated_at >= graceSec;
    // Derived idle: a session that went `working` (`active_since` non-null) and
    // ended its turn but stays resident — the residual, once the pid verdict and
    // bare-shell tail are excluded. A NEVER-started row (`active_since` null) never
    // ran a turn (a still-binding launch, not a finished one), so it is NOT
    // derived-idle; only the pid/bare-shell arms may reclaim it. `active_since` is
    // held across turn end (never cleared / backfilled), so it reads solely as a
    // never-started gate here, never as a turn-activity signal.
    const neverStarted = job.active_since == null;
    const derivedIdle =
      !neverStarted && !provenDead && !isBareShellCommand(command);
    const dead =
      graceElapsed &&
      (provenDead || isBareShellCommand(command) || derivedIdle);
    candidates.push({ key, verb, id, paneId, command, dir: job.cwd, dead });
  }
  // Blast cap: at most SLOT_RECLAIM_MAX_PER_SWEEP dead candidates become real kills
  // this sweep (lowest `(verb, id)` key wins, deterministic); the rest downgrade to
  // visibility-only `slot-occupied`, retried next cycle.
  const reclaimKeys = new Set(
    candidates
      .filter((c) => c.dead)
      .map((c) => c.key)
      .sort()
      .slice(0, SLOT_RECLAIM_MAX_PER_SWEEP),
  );
  for (const c of candidates) {
    // Reason text is STABLE across cycles (pane id + command only, never the growing
    // idle age) so the producer change-gate suppresses re-emits — one event per
    // condition, not one per cycle. The row's `ts` carries the age. The
    // occupied→dead transition IS a reason change, so it re-emits (actionable).
    if (c.dead && reclaimKeys.has(c.key)) {
      failures.push({
        verb: c.verb,
        id: c.id,
        reason: `${SLOT_RECLAIMED_REASON_PREFIX}: reaped dead ${c.verb} session (pane ${c.paneId} ${c.command ?? "?"})`,
        dir: c.dir,
        reclaimPaneId: c.paneId,
      });
    } else {
      failures.push({
        verb: c.verb,
        id: c.id,
        reason: `${SLOT_OCCUPIED_REASON_PREFIX}: stopped ${c.verb} session holds the slot (pane ${c.paneId} ${c.command ?? "?"})`,
        dir: c.dir,
        reclaimPaneId: null,
      });
    }
  }
  // Level-triggered auto-clear: an OPEN slot row whose key got NO signal this cycle
  // self-clears. `openSlotFailures` is reason-scoped at snapshot read time, so a
  // genuine `close::<epic>` conflict sharing the key is never in it → never cleared.
  for (const open of input.openSlotFailures) {
    if (!activeKeys.has(slotKey(open.verb, open.id))) {
      clears.push({ verb: open.verb, id: open.id });
    }
  }
  return { failures, clears };
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
const EMPTY_BASE_DRIFT_ENTRIES: readonly BaseDriftEntry[] = [];

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
  if (snapshot.readinessDegraded) {
    return {
      launches: [],
      closeRecoveryStamps: [],
      completedRowIds: new Set(),
      baseDriftEntries: [],
      worktreeFinalize: [],
      worktreeSinkProvision: [],
      finalizeFailureIds: new Set(),
      slotOccupancy: [],
      slotOccupancyClears: [],
    };
  }

  const launches: PlannedLaunch[] = [];
  const closeRecoveryStamps: CloseRecoveryStamp[] = [];

  // The EPHEMERAL cross-epic merge-gate defer map (epic id → its deferred lane
  // repos), probed git-side ONCE per cycle in `loadReconcileSnapshot` and read here
  // as PLAIN DATA (the pure layer shells git nowhere). EMPTY whenever worktree mode
  // is OFF / nothing is deferred — then both gate arms below are inert and dispatch
  // stays byte-identical. Read once.
  const deferredEpicIds: ReadonlyMap<
    string,
    ReadonlySet<string>
  > = snapshot.deferredEpicIds ?? EMPTY_DEFERRED_EPIC_IDS;
  // Producer data only: the refresh producer consumes this on a later pass; the
  // verdict core carries it without deriving anything from git or a clock.
  const baseDriftEntries =
    snapshot.baseDriftEntries ?? EMPTY_BASE_DRIFT_ENTRIES;

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
  // one index = corruption); the allocator then applies the per-root cap over true
  // roots. `byEpicId` feeds the dispatch-side `attachWorktreeGeometry` post-pass — both
  // consuming the SAME plan, so the gate and dispatch never diverge.
  const worktreeGeometry: PreparedWorktreeGeometry = snapshot.worktreeMode
    ? prepareWorktreeGeometry(
        snapshot.epics,
        snapshot.worktreeRepoByEpicId,
        snapshot.worktreesRoot,
      )
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
    // The worktree-mode lane re-key (empty when OFF). Enforces cap-1 per lane
    // before the per-root fill without diverging from the dispatch-side worktree
    // geometry, which derives the SAME plan in `attachWorktreeGeometry`.
    laneKeyById,
    // The proven-dead owning-worker set (recorded pid re-proved gone at snapshot
    // load — the SAME lifecycle verdict `computeSlotOccupancy` reclaims a slot
    // on). Stabilizes a done task's `completed` verdict: once its worker is proven
    // dead, that job's lingering ghost subagent / monitor rows no longer oscillate
    // the verdict back to `running` against unrelated sibling churn. Empty on a
    // degraded pane probe, so the terminal gate then falls back to the
    // conservative liveness hold.
    snapshot.provenDeadJobIds,
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
      // (NOT the orchestrator's session model/effort) against the cycle's ONE host
      // matrix snapshot. A cell-BEARING row (both axes set) consults the matrix: a
      // bad matrix threads the four-state reject onto the launch; a good matrix
      // composes in a try/catch so a corrupt out-of-matrix pair becomes a per-launch
      // reject the producer mints as a sticky `DispatchFailed` (a raw throw here
      // would deterministically wedge the whole cycle — `driveCycle`'s backstop logs
      // and re-drives). A cell-LESS row (null EITHER axis) is matrix-independent — it
      // launches the always-loaded base `plan` plugin with no `--plugin-dir`.
      let pluginDir: string | null = null;
      let pluginDirReject: string | undefined;
      let matrixReject:
        | { state: MatrixFailureState; detail: string }
        | undefined;
      // The DISPATCHED cell — the ASSIGNED cell unless the `worker_provider` pin
      // translated it into the other family (ADR 0047). Both stay null on the
      // byte-identical unconstrained / same-family path; the compose below runs
      // over the EFFECTIVE cell so `pluginDir` points at the cell that launches.
      let dispatchedCellModel: string | null = null;
      let dispatchedCellTier: string | null = null;
      let dispatchConstraint: WorkerProvider | null = null;
      let providerReject: PlannedLaunch["providerReject"];
      // The wrapped-cell guard marker (task .1) — computed off the EFFECTIVE cell
      // (`composeModel`/`composeTier` below, the pin-translated cell when the pin
      // fired) so a native worker is never marked and a wrapped worker never
      // escapes, independent of the `worker_provider` pin. Emitted EMPTY when
      // absent (a native cell / cell-less / non-`work` row).
      let wrappedCell: string | undefined;
      let wrappedEnvelope: string | undefined;
      if (verb === "work") {
        const cellModel = task.model ?? null;
        const cellTier = task.tier ?? null;
        if (cellModel !== null && cellTier !== null) {
          if (!snapshot.hostMatrix.ok) {
            // No matrix ⇒ no cell to compose AND no target to validate — the
            // bad-matrix reject ranks first, ahead of any provider translation.
            matrixReject = {
              state: snapshot.hostMatrix.state,
              detail: snapshot.hostMatrix.detail,
            };
          } else {
            // Apply the pin FIRST (translate assigned → effective), then compose
            // the effective cell. The pin refuses fail-closed rather than falling
            // back to the assigned provider; the reject rides `providerReject`.
            let composeModel = cellModel;
            let composeTier = cellTier;
            const provider = snapshot.workerProvider ?? null;
            if (provider !== null) {
              const result = applyProviderConstraint(
                { model: cellModel, effort: cellTier },
                provider,
                snapshot.providerEquivalence ?? {
                  ok: false,
                  detail: "provider-equivalence map not loaded",
                },
                snapshot.hostMatrix,
              );
              if (result.kind === "reject") {
                providerReject = {
                  reason: result.reason,
                  provider: result.provider,
                  direction: result.direction,
                  assigned: result.assigned,
                  target: result.target,
                  ...(result.detail !== undefined
                    ? { detail: result.detail }
                    : {}),
                };
              } else if (result.kind === "translated") {
                composeModel = result.cell.model;
                composeTier = result.cell.effort;
                dispatchedCellModel = result.cell.model;
                dispatchedCellTier = result.cell.effort;
                dispatchConstraint = provider;
              }
            }
            if (providerReject === undefined) {
              try {
                pluginDir = workerCellPluginDir(
                  composeModel,
                  composeTier,
                  snapshot.hostMatrix,
                );
              } catch (err) {
                pluginDirReject =
                  err instanceof Error ? err.message : String(err);
              }
              // Wrapped-cell guard marker off the EFFECTIVE cell — present only when
              // the model claude does not serve natively, so a native worker is
              // never marked (independent of the pin). `cwd` is the launch repo the
              // absolute envelope path anchors on.
              if (isWrappedCell(snapshot.hostMatrix, composeModel)) {
                wrappedCell = `${composeModel}::${composeTier}`;
                wrappedEnvelope = wrappedEnvelopePath(cwd, taskId);
              }
            }
          }
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
          snapshot.workModel,
          snapshot.workEffort,
          pluginDir,
        ),
        model: snapshot.workModel,
        effort: snapshot.workEffort,
        tier: verb === "work" ? task.tier : null,
        cellModel: verb === "work" ? (task.model ?? null) : null,
        pluginDir,
        dispatchedCellModel,
        dispatchedCellTier,
        dispatchConstraint,
        ...(wrappedCell !== undefined ? { wrappedCell } : {}),
        ...(wrappedEnvelope !== undefined ? { wrappedEnvelope } : {}),
        ...(pluginDirReject !== undefined ? { pluginDirReject } : {}),
        ...(matrixReject !== undefined ? { matrixReject } : {}),
        ...(providerReject !== undefined ? { providerReject } : {}),
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
        const recoverDirectly =
          snapshot.worktreeMode &&
          snapshot.closeRecoveryEligibleIds?.has(epicId) === true &&
          epic.tasks.every((task) => task.worker_phase === "done") &&
          closerJobFinished(snapshot.jobs, epicId, snapshot.livePaneIds);
        if (recoverDirectly) {
          if (!epicHasOccupyingJob(epic, snapshot.jobs, snapshot.livePaneIds)) {
            closeRecoveryStamps.push({ epicId, key: closeKey, projectDir });
            budget--;
          }
        } else {
          launches.push({
            verb: closeVerb,
            id: epicId,
            key: closeKey,
            cwd: projectDir,
            workerCommand: buildWorkerCommand(
              closeVerb,
              epicId,
              projectDir,
              snapshot.closeModel,
              snapshot.closeEffort,
            ),
            model: snapshot.closeModel,
            effort: snapshot.closeEffort,
            tier: null,
            // A `close` row is cell-less — it loads no per-cell worker plugin, and
            // names no capability model.
            cellModel: null,
            pluginDir: null,
            // Every close-row launch is an epic finalizer (`close`);
            // the cycle glue stamps the per-epic guard for these.
            isEpicFinalizer: true,
          });
          budget--;
        }
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
    // The finalize collection — every epic whose lane should merge-to-default and
    // tear down THIS cycle. Two arms, BOTH gated on CLOSE occupancy (ADR 0031):
    //  - projection-done (`completedRowIds`): the epic folded `done`, so its close
    //    row read `completed` in the ONE readiness pass above.
    //  - closer-finished (`closerJobFinished`): a `close::<epic>` job row exists AND
    //    no longer occupies — a BROADER, producer-observable trigger off the durable
    //    `jobs` projection (fires even before the main `epics` projection folds
    //    `done`; `finalizeEpic` re-confirms real completion via `isEpicDone` before
    //    it merges, so a finished-but-not-done crashed closer is rejected there —
    //    projection-done crash robustness is unchanged).
    // The CLOSE-OCCUPANCY GATE: an epic whose close job still OCCUPIES its slot
    // (`working`; `stopped` with a live pane; or a degraded pane probe — the shared
    // `isOccupyingJob` semantics) is a live closer mid-turn INSIDE its lane.
    // Collecting it would merge + tear the lane out from under the session, deleting
    // its cwd (posix_spawn ENOENT → Stop hooks die → a `working` zombie ghost-holds
    // the slot). Defer to a later cycle: a self-resolving deferral minting no row —
    // the closer's pane dies (normally via autoclose's reap) and the next cycle
    // finalizes. The closer-finished arm ALREADY encodes this gate; routing the
    // projection-done arm through the SAME shared seam keeps the reconciler and board
    // from drifting on what "occupies" means. A done epic with NO close job
    // (never-forked / done-before-worktree) never occupies → finalizes as before.
    // The deferral ends at "no longer occupying," never "process dead" — an idle
    // closer occupies until its pane dies (ADR 0031). Symmetric with the
    // closer-finished arm's own long-standing silent defer; the `finalizeEpic`-side
    // retry-skip / done-guard diagnostics stay the observable defer surface.
    const finalizeEpicIds = new Set<string>();
    for (const epic of snapshot.epics) {
      const epicId = epic.epic_id;
      if (
        isOccupyingJob(snapshot.jobs, "close", epicId, snapshot.livePaneIds)
      ) {
        continue;
      }
      if (
        completedRowIds.has(epicId) ||
        closerJobFinished(snapshot.jobs, epicId, snapshot.livePaneIds)
      ) {
        finalizeEpicIds.add(epicId);
      }
    }
    attachWorktreeGeometry(
      snapshot.epics,
      launches,
      finalizeEpicIds,
      worktreeFinalize,
      worktreeSinkProvision,
      worktreeGeometry.byEpicId,
    );
  }

  // Slot-occupancy visibility + auto-reclaim: surface (and, when provably dead,
  // reclaim) a stopped-but-live session wedging a slot `reconcile` still wants. The
  // `wantsDispatch` gate reuses the SAME readiness pass (a verdict that maps to a
  // verb = the mint is blocked), so a completed row's inspection window is left
  // alone. Inert when paused / probe degraded.
  const slot = computeSlotOccupancy({
    jobs: snapshot.jobs,
    livePaneIds: snapshot.livePaneIds,
    paneCommandById: snapshot.paneCommandById,
    provenDeadJobIds: snapshot.provenDeadJobIds,
    openSlotFailures: snapshot.slotOccupancyFailures,
    wantsDispatch: (verb, id) =>
      verb === "work"
        ? verbForVerdict("task", readiness.perTask.get(id)) !== null
        : verbForVerdict("close", readiness.perCloseRow.get(id)) !== null,
    paused: state.paused,
    now,
  });

  return {
    launches,
    closeRecoveryStamps,
    completedRowIds,
    baseDriftEntries,
    worktreeFinalize,
    worktreeSinkProvision,
    finalizeFailureIds: snapshot.finalizeFailureIds,
    slotOccupancy: slot.failures,
    slotOccupancyClears: slot.clears,
  };
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
  worktreesRoot?: string,
): PreparedWorktreeGeometry {
  const laneKeyById = new Map<string, string>();
  const byEpicId = new Map<string, EpicWorktreeGeometry>();
  for (const epic of epics) {
    const resolution = worktreeRepoByEpicId.get(epic.epic_id);
    if (resolution !== undefined && resolution.kind === "disabled") {
      // A worktree-DISABLED repo: dispatch SEQUENTIALLY on the shared checkout,
      // never a lane. Key EVERY task id AND the epic id (close row) to the bare
      // resolved toplevel (NOT a per-lane path) so the allocator's lane-keyed
      // cap-1 pass serializes one worker per repo before the root-cap fill. Record
      // the `disabled` geometry, NOT a reject.
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
          plan = deriveWorktreePlan(
            epic.epic_id,
            group.repoDir,
            groupTasks,
            worktreesRoot,
          );
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
      plan = deriveWorktreePlan(
        epic.epic_id,
        repoDir,
        epic.tasks,
        worktreesRoot,
      );
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
 *    epic in `finalizeEpicIds` — the CLOSE-OCCUPANCY-GATED finalize set the caller
 *    assembled (an epic folded `status:done` OR its closer JOB finished, AND no
 *    close job still occupies its lane; ADR 0031). The producer merges that base
 *    into the default branch + tears down, re-confirming real completion via the
 *    MAIN projection (`isEpicDone`) first (`finalizeEpic`) — the closer writes
 *    `done` to the PRIMARY repo, not the lane.
 *  - `clustered` (multi-repo) → stamp each task launch with ITS group's assignment
 *    (a `serial` group's tasks stay worktree-less on the shared checkout); the
 *    single close launch maps to the PRIMARY group's sink (worktree-less if the
 *    primary group is serial). Push ONE `worktreeFinalize` entry per WORKTREE group
 *    (the single close gates ALL groups' finalizes); a non-primary group's sink
 *    additionally lands in `worktreeSinkProvision` — no close worker dispatches into
 *    it, so the producer runs its rib→base fan-in before finalize via `provision`.
 *
 * Pure: a total function of the epics + launches + the finalize set + the resolved
 * geometry.
 */
function attachWorktreeGeometry(
  epics: Epic[],
  launches: PlannedLaunch[],
  finalizeEpicIds: Set<string>,
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
    const needsFinalize = finalizeEpicIds.has(epicId);
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

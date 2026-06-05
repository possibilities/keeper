/**
 * Autopilot reconciler worker (fn-661). Runs as a Bun Worker thread spawned
 * by the daemon. Drives the level-triggered dispatch loop server-side:
 *
 *   wake (data_version pulse) → reconcile(snapshot, state, deps)
 *     → for each row whose verdict wants a verb V:
 *         - skip if an OCCUPYING `jobs` row exists for `(plan_verb=V,
 *           plan_ref=id)` whose `state IN ('working','stopped')` (the
 *           non-terminal partition — see `src/reducer.ts` state-machine
 *           doc :14-53; the schema default `state='stopped'` covers
 *           SessionStart-INSERTed rows that haven't reached `working` yet).
 *         - skip if an open `dispatch_failures` row exists for `(V, id)`.
 *         - skip if a dispatch for `(V, id)` is already in-flight on this
 *           reconciler (one-at-a-time stagger preserved, fn-644).
 *         - skip if the snapshot's `liveTabKeys` set carries `${V}::${id}`
 *           (fn-674): a zellij tab labeled exactly `verb::id` exists in
 *           the managed session — proof a launched worker is occupying
 *           the slot in the launch → SessionStart blind window before
 *           its `jobs` row lands. The set is probed ONCE per cycle at
 *           snapshot load via `ExecBackend.tabExistsByName`; the reduce
 *           stays pure.
 *         - else dispatch via `confirmRunning(verb, id, deps)`.
 *     → symmetric reap: when the autoclose config flag is on, for each
 *       live dispatch whose role is no longer needed (occupying job
 *       reached a terminal state OR the readiness verdict no longer wants
 *       the verb on that row), call `deps.closeByName(name)` and forget
 *       the in-flight record.
 *
 * `confirmRunning(verb, id, deps)`:
 *   1. `watermark = deps.maxEventId()` BEFORE the launch (the watermark
 *      excludes any stale terminal or resumed `jobs` row for the same
 *      `(plan_verb, plan_ref)` — a SessionStart that lands AFTER the
 *      watermark is the one that proves THIS dispatch made it).
 *   2. `res = await deps.launch(argv, name)`. `{ok:false}` → emit
 *      `DispatchFailed` immediately with the surfaced reason and return.
 *   3. Poll BOTH `deps.findJob(plan_verb, plan_ref, last_event_id >
 *      watermark)` AND `deps.tabExistsByName(name)` every
 *      `pollIntervalMs` (~1-2s) until EITHER returns truthy — the
 *      named tab is visible OR the jobs row appears, whichever fires
 *      first — and resolve `"ok"` (fn-674 early-resolve). Releases
 *      the fn-644 one-at-a-time stagger in ~zellij latency rather
 *      than the full ceiling.
 *   4. Ceiling (`ceilingMs`, default 60s) elapses with NEITHER signal
 *      → emit `DispatchFailed reason="confirm timeout"` and resolve
 *      `"failed"`. A timeout while the tab DOES exist mints NOTHING
 *      and resolves `"ok"` instead (the launch succeeded; the slot
 *      stays held by the standing `liveTabKeys` dedup arm until the
 *      tab disappears OR a `jobs` row binds). The last tick uses
 *      `Math.min(interval, remaining)` so the ceiling is honored.
 *   5. The polled rows are NEVER mutated; reads only — the reducer is the
 *      sole writer of `jobs` (per the event-sourcing invariants).
 *
 * Correlation: the reducer derives `(plan_verb, plan_ref)` from the
 * `--name verb::id` baked into the worker argv at SessionStart, via
 * `planVerbRefFromSpawnName` in `src/derivers.ts`. There is NO
 * `jobs.spawn_name` column — the pair IS the correlation. `approve::id`
 * and `work::id` share `plan_ref`, so confirm/dedup MUST gate on
 * `plan_verb` too (not just `plan_ref`).
 *
 * Determinism / event-sourcing invariants:
 *  - The reconciler NEVER writes a projection directly. It mints
 *    `DispatchFailed` / `DispatchCleared` synthetic events (via the
 *    `emitDispatchFailed` dep that bridges to main on the writable
 *    connection); the reducer folds them into `dispatch_failures` inside
 *    the existing `BEGIN IMMEDIATE` transaction. From-scratch re-fold
 *    reproduces `dispatch_failures` byte-identically.
 *  - The `ts` field stamped onto a `DispatchFailed` payload is captured
 *    at reconcile time (the producer-side clock, `deps.now()`), NOT at
 *    re-fold time — so a future re-fold reproduces the same
 *    `dispatch_failures.ts` column value.
 *  - Wall-clock reads (`deps.now`) and liveness probes are confined to
 *    the worker's reconcile / confirm paths. NOTHING that feeds a fold
 *    reads them.
 *
 * Worker contract (mirrors wake-worker / exit-watcher / etc):
 *  - `isMainThread` guard — a plain `import` from a test is inert; the
 *    pure `reconcile` / `confirmRunning` symbols are exercised directly.
 *  - Own read-only `openDb` connection — never shares main's writable
 *    handle. `applyPragmas` runs inside `openDb` so `busy_timeout` is
 *    set on this connection.
 *  - Typed messages: `{ kind: "dispatch-failed", ... }` worker→main;
 *    `{ type: "shutdown" }` and `{ type: "set-paused", paused }`
 *    main→worker.
 *  - Supervisor-owned lifecycle. The worker's `data_version` poll loop
 *    + any in-flight `confirmRunning` are released in the shutdown
 *    handler: the `AbortController` aborts the confirm's sleeps and the
 *    next poll iteration sees `shutdown=true` and exits.
 *  - No in-process self-heal — any unrecoverable error exits non-zero;
 *    the daemon's `error`/`close` listeners escalate via `fatalExit`.
 *
 * Boots PAUSED (`paused = true` in the worker's initial state). Main
 * flips it via `{ type: "set-paused", paused: false }` once the human
 * (or the viewer) plays. The paused flag is in-memory only and NEVER
 * persisted — boots-paused is the safety default (rollout: "first run
 * after deploy dispatches nothing until the human plays"). Persisting
 * it would survive a restart in a way that contradicts the safety
 * invariant.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { openDb } from "./db";
import { resolveExecBackend } from "./exec-backend";
import { computeReadiness, type Verdict } from "./readiness";
import {
  collapseSubagentsByName,
  projectGitStatusByProjectDir,
} from "./readiness-client";
import { runQuery } from "./server-worker";
import type { Epic, GitStatus, Job, SubagentInvocation } from "./types";
import { watchLoop } from "./wake-worker";

/**
 * The three planctl verbs the reconciler dispatches. Mirrors the
 * `buildWorkerCommand` verb union in `cli/autopilot.ts` (single source of
 * truth for the argv shape lives there; we only need the type alias
 * here). `approve` runs for `blocked:job-pending` rows; `work` /
 * `close` run for `ready` rows.
 */
export type Verb = "work" | "close" | "approve";

/**
 * The dedup / in-flight key shape — exactly `${verb}::${id}`, matching
 * the `--name` baked into the worker argv. This is also the zellij tab
 * name (so `closeByName(name)` can reap the surface).
 */
export type DispatchKey = string;

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
 * `~/code/planctl` root for the `--plugin-dir <root>/work-plugins/<tier>`
 * flag. Env-overridable via `PLANCTL_ROOT` (for tests and a future
 * non-default workspace). `~` is expanded eagerly at module load so the
 * assembled string carries an absolute path the launcher's cwd doesn't
 * break. Mirrors the `ARTHACK_ROOT` IIFE shape — planctl moved out of
 * `apps/planctl/` into a standalone sibling repo (epic fn-635), so the
 * tier plugin tree now lives under planctl's own root with no `claude/`
 * segment.
 */
export const PLANCTL_ROOT: string = ((): string => {
  const raw = process.env.PLANCTL_ROOT;
  const v = raw != null && raw !== "" ? raw : "~/code/planctl";
  if (v === "~" || v.startsWith("~/")) {
    return v === "~" ? homedir() : join(homedir(), v.slice(2));
  }
  return v;
})();

/**
 * The tier work-plugins directory autopilot launches a `work` worker under:
 * `${PLANCTL_ROOT}/work-plugins/<tier>`. Factored out so both the
 * dispatch command ({@link buildWorkerCommand}) and the resume-command
 * renderer (`scripts/resume.ts`) build the identical path from one formula.
 * Pure — exported for the resume script and tests.
 */
export function workPluginDir(tier: string): string {
  return `${PLANCTL_ROOT}/work-plugins/${tier}`;
}

/** Result of validating a tier's work-plugin manifest before launch. */
export type WorkPluginCheck = { ok: true } | { ok: false; reason: string };

/**
 * Validate that the tier's work-plugin manifest exists and registers the
 * plugin under the name `work` BEFORE the autopilot launches a worker
 * against `workPluginDir(tier)`.
 *
 * The per-tier `.claude-plugin/plugin.json` is a GENERATED + gitignored
 * artifact (planctl fn-637 — rendered from `agent-templates/worker*.tmpl`
 * by `promptctl render-plugin-templates`, wired through
 * `scripts/install.sh`). When that file is absent, `claude --plugin-dir
 * <root>/work-plugins/<tier>` falls back to the DIRECTORY BASENAME as the
 * plugin name (e.g. `high`), so the agent registers as `high:worker`.
 * `/plan:work` hardcodes `Task(subagent_type="work:worker")`, which then
 * fails with `Agent type 'work:worker' not found` AFTER the worker has
 * burned a ~30s cold boot. Validating here turns that silent token-burn
 * into a visible sticky `DispatchFailed` carrying a remediation hint —
 * the autopilot never launches a doomed worker.
 *
 * Producer-side fs read — lives in the impure dispatch path
 * (`runReconcileCycle`), NEVER a fold. Pure of wall-clock/env. Exported
 * for tests.
 */
export function checkWorkPluginManifest(tier: string): WorkPluginCheck {
  const manifestPath = join(
    workPluginDir(tier),
    ".claude-plugin",
    "plugin.json",
  );
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    return {
      ok: false,
      reason:
        `work-plugin manifest missing for tier '${tier}' at ${manifestPath} — ` +
        `regenerate with 'promptctl render-plugin-templates --project-root ${PLANCTL_ROOT}' ` +
        `(or rerun scripts/install.sh); without it claude --plugin-dir falls back to ` +
        `the dir basename and '/plan:work' cannot resolve 'work:worker'`,
    };
  }
  let name: unknown;
  try {
    name = (JSON.parse(raw) as { name?: unknown }).name;
  } catch (err) {
    return {
      ok: false,
      reason: `work-plugin manifest at ${manifestPath} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (name !== "work") {
    return {
      ok: false,
      reason:
        `work-plugin manifest at ${manifestPath} has name='${String(name)}' ` +
        `(expected 'work') — '/plan:work' would resolve '${String(name)}:worker', ` +
        `not 'work:worker'`,
    };
  }
  return { ok: true };
}

/**
 * Build the `claude` worker shell command for a `(verb, id, cwd, tier)`
 * combination — mirrors `buildWorkerCommand` in `cli/autopilot.ts:502`
 * byte-for-byte (same flag ordering, same tier `--plugin-dir` rule, same
 * `--name verb::id` correlator). Lives here rather than re-exported from
 * the cli module to keep this worker's Worker-boundary import graph
 * narrow (the cli file pulls in clipboard/live-shell/etc.). The two
 * implementations are pinned together by `test/autopilot-worker.test.ts`
 * which asserts the exact same argv shape against the cli's frozen
 * snapshot.
 *
 * Pure — exported for tests.
 */
export function buildWorkerCommand(
  verb: Verb,
  id: string,
  projectDir: string,
  tier?: string | null,
): string {
  const cdPrefix = projectDir === "" ? "" : `cd ${projectDir} && `;
  const flags: string[] = [];
  if (verb === "approve") {
    flags.push("--model", "sonnet", "--effort", "low");
  } else {
    flags.push("--model", "sonnet", "--effort", "max");
  }
  flags.push("--name", `${verb}::${id}`);
  if (verb === "work" && tier != null && tier !== "") {
    flags.push("--plugin-dir", workPluginDir(tier));
  }
  return `${cdPrefix}claude ${flags.join(" ")} '/plan:${verb} ${id}'`;
}

/** Compose the canonical `${verb}::${id}` key. */
export function dispatchKey(verb: Verb, id: string): DispatchKey {
  return `${verb}::${id}`;
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
   * `(verb, id)` keys with an open `pending_dispatches` row (fn-678).
   * Populated once per cycle from the durable projection; `reconcile()`
   * is pure and reads this synchronous set, never the backend. A row's
   * presence means a `Dispatched` event was minted BEFORE `launch()` and
   * the corresponding `SessionStart` (which deletes the row) has not
   * folded yet — i.e., the launch → SessionStart blind window is occupied.
   */
  liveTabKeys: Set<DispatchKey>;
}

/**
 * In-memory reconciler state — the paused flag plus the set of
 * `${verb}::${id}` dispatches currently in-flight on this reconciler.
 * "In-flight" spans the moment `reconcile` decides to dispatch (set on
 * the key) through the `confirmRunning` resolution path (clear on
 * either success OR failure). NEVER persisted — the reconciler restarts
 * cold; the durable signal is the `jobs` projection itself PLUS the
 * fn-674 per-cycle `liveTabKeys` probe, which re-derives the launch →
 * SessionStart occupation against zellij on every wake so a daemon
 * restart never double-dispatches a slot already claimed by a live
 * worker tab.
 */
export interface ReconcileState {
  paused: boolean;
  inFlight: Set<DispatchKey>;
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
  /** Task `tier`, only set for `work` rows. */
  tier: string | null;
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
 * The output of `reconcile(snapshot, state)`: the launches to fire.
 * Pure data — `runReconcileCycle` walks the array and chains the
 * side-effect deps. (Window-reap was retired with the zellij feed in
 * fn-710; the decision carries launches only.)
 */
export interface ReconcileDecision {
  launches: PlannedLaunch[];
}

/**
 * Side-effect deps for the reconcile + confirm cycle. All injected so
 * the core stays pure (the test suite drives the same paths with fakes
 * — no real worker spawn).
 */
export interface ConfirmRunningDeps {
  /** Spawn the worker argv in a zellij tab named `name`. */
  launch(argv: string[], name: string, cwd: string): Promise<LaunchResult>;
  /**
   * Emit a synthetic `DispatchFailed` event onto the writable connection
   * (via the parent thread — workers never write the DB). Carries the
   * reconcile-time `ts` so a re-fold reproduces the projection row
   * byte-identically.
   */
  emitDispatchFailed(payload: DispatchFailedPayload): void;
  /**
   * Emit a synthetic `Dispatched` event onto the writable connection (via
   * the parent thread — workers never write the DB). Outbox-ordered intent
   * (fn-678): the reconciler mints this BEFORE `launch()` so a crash
   * between mint and the side-effect leaves a phantom `pending_dispatches`
   * row the producer-side TTL sweep clears via `DispatchExpired`. Strictly
   * preferable to double-dispatch in the launch→SessionStart blind window
   * the fn-674 live-tab probe used to cover.
   *
   * Carries the reconcile-time `ts` so the reducer's `Dispatched` fold
   * lands `pending_dispatches.dispatched_at` byte-identically across a
   * re-fold (all wallclock lives in the producer; the fold never reads
   * `Date.now()`).
   */
  emitDispatched(payload: DispatchedPayload): void;
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
   * Sleep `ms`, abortable via the worker's shutdown signal. Resolves
   * early when `signal.aborted` flips; the caller checks the flag and
   * treats an early resolve as "shutdown — stop polling".
   */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /**
   * Validate the tier's work-plugin manifest before a `work` launch.
   * Optional: when absent the guard is a no-op (tests that don't exercise
   * the manifest path skip wiring it). The live worker always injects the
   * real {@link checkWorkPluginManifest}. A `{ok:false, reason}` result
   * blocks the launch with a sticky `DispatchFailed` rather than spawning
   * a worker that registers under the wrong plugin name and dies.
   */
  checkWorkPlugin?(tier: string): WorkPluginCheck;
  /**
   * Tuning knobs — exposed as deps so tests can drive a 5ms / 50ms
   * cadence instead of seconds. Defaults applied in `runConfirmCycle`
   * when undefined.
   */
  pollIntervalMs?: number;
  ceilingMs?: number;
}

/** Reuse the backend's launch envelope shape. */
export type LaunchResult = { ok: true } | { ok: false; error: string };

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
 * Confirm outcome — internal to `runConfirmCycle`. The worker calls
 * `deps.emitDispatchFailed` on `"failed"`; `"ok"` is the noop happy
 * path; `"aborted"` means shutdown — drop the in-flight entry and exit
 * without emitting (no DispatchFailed for a worker shutdown).
 */
export type ConfirmOutcome = "ok" | "failed" | "aborted";

/**
 * Default poll cadence — every 1s. Spec says ~1-2s; we pick 1000ms so a
 * post-Spawn SessionStart hook (~50-200ms typical) is observed within
 * one tick of the kernel scheduling the new process.
 */
export const DEFAULT_POLL_INTERVAL_MS = 1000;

/**
 * Default ceiling — 60s (bumped from 18s in fn-674). With the
 * fn-674 early-resolve, `confirmRunning` returns `"ok"` the instant
 * EITHER the named zellij tab OR the `jobs` row is visible, so the
 * ceiling rarely matters in the happy path — it just bounds active
 * polling on a launch that produces no tab AND no jobs row (genuine
 * spawn failure). Bumped because the 18s ceiling raced ~24-33s
 * `claude` cold boots (~60 plugin dirs on the work tier), false-
 * timing-out the confirm WHILE the worker was still booting; the
 * standing `liveTabKeys` dedup arm now covers the long tail, so a
 * generous ceiling here is defense-in-depth, not the load-bearing
 * dedup signal.
 */
export const DEFAULT_CEILING_MS = 60_000;

/**
 * Worker shell wrapping. Mirrors the CLI autopilot's launch body so the
 * argv shape is identical: `[$SHELL, "-l", "-i", "-c", <body>]` where
 * `<body>` is `<workerCommand> ; exec $SHELL -l -i`. The trailing exec
 * leaves a usable login+interactive shell after `claude` exits (vim
 * fallback for the rare auto-close miss). The argv shape is the safe
 * quoting seam at the OS argv boundary — zellij forwards it verbatim
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
 *   - `{ tag: "blocked", reason: { kind: "job-pending" } }` → `"approve"`.
 *   - Everything else → `null` (running / blocked-on-other-reasons /
 *     completed / undefined verdict).
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
  if (verdict.tag === "blocked" && verdict.reason.kind === "job-pending") {
    return "approve";
  }
  return null;
}

/**
 * Inspect a `jobs` map for an OCCUPYING row keyed by `(plan_verb,
 * plan_ref)` whose `state` is in the non-terminal partition
 * `{working, stopped}`. The schema default is `state='stopped'`, so a
 * SessionStart-INSERTed row that hasn't reached `working` yet is
 * already occupying — this is the same partition the readiness pass
 * uses for `git_status` and that the reducer documents at
 * `src/reducer.ts:1933`.
 *
 * "Occupying" semantically replaces the old transient-surface probe
 * (`isSurfaceLive`): if keeperd already has a non-terminal `jobs` row
 * for `(verb, id)`, a dispatch would land a SECOND worker on the same
 * task — the exact thing fn-652 was a hotfix for. Reading the
 * projection instead of probing zellij makes the dedup structurally
 * race-free across restart.
 *
 * Pure — iterates the map values once, returns on first match.
 */
export function isOccupyingJob(
  jobs: Map<string, Job>,
  verb: Verb,
  id: string,
): boolean {
  for (const job of jobs.values()) {
    if (
      job.plan_verb === verb &&
      job.plan_ref === id &&
      (job.state === "working" || job.state === "stopped")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The pure reconcile decision. Walks every epic / task / close-row,
 * computes the verb each verdict wants, and emits a `PlannedLaunch`
 * IFF none of the five suppression rules fires:
 *
 *   1. `state.paused` (boots-paused safety default; never auto-cleared).
 *   2. `state.inFlight.has(key)` (one-at-a-time stagger preserved).
 *   3. `snapshot.failedKeys.has(key)` (sticky failure — only cleared
 *      by a human `retry_dispatch` minting `DispatchCleared`).
 *   4. `isOccupyingJob(jobs, verb, id)` (a non-terminal jobs row for
 *      the same `(plan_verb, plan_ref)` already exists — dedup).
 *   5. `snapshot.liveTabKeys.has(key)` (fn-674: a zellij tab named
 *      exactly `verb::id` already lives in the managed session,
 *      i.e. a worker has been launched into the slot but its
 *      SessionStart hook hasn't reached `jobs` yet — the launch →
 *      SessionStart blind window the legacy `isOccupyingJob` arm
 *      could not see).
 *
 * Pure — exported for testing. Side effects (launch, emitDispatchFailed)
 * live in `runReconcileCycle`. (Window-reap was retired with the zellij
 * feed in fn-710 — the durable `pending_dispatches` projection serves
 * launch-window dedup and no tab close-out runs.)
 */
export function reconcile(
  snapshot: ReconcileSnapshot,
  state: ReconcileState,
  now: number,
): ReconcileDecision {
  const launches: PlannedLaunch[] = [];

  // Use `Number.NEGATIVE_INFINITY` for the sub-agent staleness `now`
  // when the caller didn't bother (matches `computeReadiness`'s default
  // — keeps the staleness branch inert if undefined).
  const readiness = computeReadiness(
    snapshot.epics,
    snapshot.jobs,
    snapshot.subagentInvocations,
    snapshot.gitStatusByProjectDir,
    now,
  );

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
      if (state.inFlight.has(key)) {
        continue;
      }
      if (snapshot.failedKeys.has(key)) {
        continue;
      }
      if (isOccupyingJob(snapshot.jobs, verb, taskId)) {
        continue;
      }
      if (snapshot.liveTabKeys.has(key)) {
        // fn-674: a tab named verb::id is live in the managed session;
        // a launched worker is occupying the slot in the launch →
        // SessionStart window, before its jobs row binds. Suppress
        // the dispatch — the standing arm complements `isOccupyingJob`
        // by covering the pre-SessionStart gap.
        continue;
      }
      const cwd =
        task.target_repo != null && task.target_repo !== ""
          ? task.target_repo
          : projectDir;
      if (cwd === "") {
        // No effective cwd — the launch can't `cd` anywhere. Skip
        // rather than dispatch a malformed command; a missing
        // project_dir is a data bug, not a runtime decision.
        continue;
      }
      launches.push({
        verb,
        id: taskId,
        key,
        cwd,
        workerCommand: buildWorkerCommand(verb, taskId, cwd, task.tier),
        tier: verb === "work" ? task.tier : null,
      });
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
        !isOccupyingJob(snapshot.jobs, closeVerb, epicId) &&
        // fn-674 standing dedup arm: a live `close::<epic>` tab in the
        // session is proof a launched closer occupies the slot before
        // its SessionStart binds. Same shape as the task arm above.
        !snapshot.liveTabKeys.has(closeKey);
      if (okToPlan && projectDir !== "") {
        launches.push({
          verb: closeVerb,
          id: epicId,
          key: closeKey,
          cwd: projectDir,
          workerCommand: buildWorkerCommand(closeVerb, epicId, projectDir),
          tier: null,
        });
      }
    }
  }

  return { launches };
}

/**
 * The confirm-runner. Captures the `events.id` watermark, mints a
 * `Dispatched` event (outbox-ordered intent, fn-678), fires `launch`,
 * then polls `deps.findJob` until it resolves truthy (GOOD; resolve
 * `"ok"`) or `ceilingMs` elapses. Launch failure (`ok: false`) SHORT-
 * CIRCUITS to `"failed"` with the surfaced error string.
 *
 * Launch-window dedup is served by the durable `pending_dispatches`
 * projection (populated by the `Dispatched` event minted here) rather
 * than the fn-674 live zellij tab probe. The standing `liveTabKeys` arm
 * in `reconcile()` reads the projection on each cycle and suppresses
 * re-dispatch for any key with an open row — so a worker that is still
 * booting (24-33s cold `claude` start) keeps its slot held until
 * `SessionStart` folds and discharges the row.
 *
 * Abort handling: `signal.aborted` after any internal sleep resolves
 * `"aborted"` without emitting `DispatchFailed`. Shutdown is a clean
 * teardown, not a sticky failure.
 *
 * Pure with-injected-deps — tests pass fake `launch` / `findJob` /
 * `now` / `sleep` to drive every branch deterministically.
 */
export async function confirmRunning(
  verb: Verb,
  id: string,
  cwd: string,
  argv: string[],
  signal: AbortSignal,
  deps: ConfirmRunningDeps,
): Promise<ConfirmOutcome> {
  const key = dispatchKey(verb, id);
  // 1. Watermark BEFORE launch. A re-open of a stale terminal row for
  //    the same (verb, id) would carry `last_event_id <= watermark` so
  //    the post-watermark filter excludes it; the post-watermark
  //    SessionStart that PROVES this dispatch lit up will carry
  //    `last_event_id > watermark`.
  const watermark = deps.maxEventId();
  // 2. Mint intent BEFORE launch (outbox ordering, fn-678). A crash
  //    between this mint and the actual `launch()` call leaves a phantom
  //    `pending_dispatches` row; the producer-side TTL sweep clears it via
  //    `DispatchExpired`. A phantom row delaying a real dispatch by up to
  //    120s is strictly preferable to double-dispatch.
  deps.emitDispatched({
    verb,
    id,
    dir: cwd === "" ? null : cwd,
    ts: deps.now(),
  });
  // 3. Launch.
  const launchResult: LaunchResult | { ok: false; error: string } = await deps
    .launch(argv, key, cwd)
    .catch((err) => ({
      ok: false as const,
      error: `launch threw: ${err instanceof Error ? err.message : String(err)}`,
    }));
  if (launchResult.ok === false) {
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
    return "aborted";
  }
  // 4. Poll loop — wait for the SessionStart jobs row. The
  //    `pending_dispatches` row (minted above) keeps the `liveTabKeys`
  //    arm of `reconcile()` fired on every subsequent cycle, so
  //    a slow-booting worker (24-33s cold `claude` start) holds its slot
  //    without a live zellij probe.
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const ceilingMs = deps.ceilingMs ?? DEFAULT_CEILING_MS;
  let elapsedMs = 0;
  while (elapsedMs < ceilingMs) {
    const remainingMs = ceilingMs - elapsedMs;
    const sleepMs = Math.min(pollIntervalMs, remainingMs);
    await deps.sleep(sleepMs, signal);
    if (signal.aborted) {
      return "aborted";
    }
    elapsedMs += sleepMs;
    const hit = deps.findJob(verb, id, watermark);
    if (hit != null) {
      return "ok";
    }
    if (signal.aborted) {
      return "aborted";
    }
  }
  // Ceiling elapsed with no jobs row — the launch is dead.
  deps.emitDispatchFailed({
    verb,
    id,
    reason: `confirm timeout after ${ceilingMs}ms (verb=${verb} id=${id})`,
    dir: cwd === "" ? null : cwd,
    ts: deps.now(),
  });
  return "failed";
}

/**
 * Run one reconcile + dispatch cycle. Pure-glue — drives the decision
 * from `reconcile`, then chains launches one at a time through
 * `confirmRunning` (preserving the fn-644 one-at-a-time stagger). Each
 * launch flips its `key` into `state.inFlight` BEFORE the await and
 * removes it on resolution.
 *
 * Returns when every queued launch has resolved (success or failure)
 * OR the abort signal fired. The caller (worker `main()`) wakes again
 * on the next data_version pulse — a wake mid-cycle is coalesced via
 * the supervisor's `wakePending` flag (same shape as
 * `src/daemon.ts` keeps).
 */
export async function runReconcileCycle(
  decision: ReconcileDecision,
  state: ReconcileState,
  liveDispatches: Map<DispatchKey, LiveDispatch>,
  shell: string,
  signal: AbortSignal,
  deps: ConfirmRunningDeps,
): Promise<void> {
  // Launches: one-at-a-time. Each await covers the full confirm window
  // for that dispatch before the next launch even starts (~ up to
  // ceilingMs each, which IS the stagger).
  for (const plan of decision.launches) {
    if (signal.aborted) {
      return;
    }
    if (state.inFlight.has(plan.key)) {
      // Defensive: reconcile already filters this, but a re-entrant
      // call could double-queue. Skip to keep one-at-a-time honest.
      continue;
    }
    // Pre-launch work-plugin manifest guard. A `work` launch points
    // `claude --plugin-dir` at workPluginDir(tier); if that tier's
    // generated `.claude-plugin/plugin.json` is missing/misnamed, claude
    // falls back to the dir basename as the plugin name and `/plan:work`
    // can't resolve `work:worker` — the worker dies after a cold boot.
    // Block with a visible sticky DispatchFailed instead of burning it.
    if (plan.verb === "work" && plan.tier != null && plan.tier !== "") {
      const check = deps.checkWorkPlugin?.(plan.tier) ?? { ok: true };
      if (!check.ok) {
        deps.emitDispatchFailed({
          verb: plan.verb,
          id: plan.id,
          reason: check.reason,
          dir: plan.cwd === "" ? null : plan.cwd,
          ts: deps.now(),
        });
        continue;
      }
    }
    state.inFlight.add(plan.key);
    const argv = buildLaunchArgv(shell, plan.workerCommand);
    try {
      const outcome = await confirmRunning(
        plan.verb,
        plan.id,
        plan.cwd,
        argv,
        signal,
        deps,
      );
      if (outcome === "ok") {
        // Promote to liveDispatches so the reap pass can find it. The
        // `controller` is the per-dispatch abort handle (shutdown
        // aborts every in-flight confirm via the worker's signal; the
        // per-dispatch handle is retained so a future "kill this one"
        // RPC can target a single dispatch without touching siblings).
        liveDispatches.set(plan.key, {
          verb: plan.verb,
          id: plan.id,
          key: plan.key,
          cwd: plan.cwd,
          controller: new AbortController(),
        });
      }
      // outcome === "failed" → DispatchFailed already emitted by
      // confirmRunning; no live entry recorded.
      // outcome === "aborted" → shutdown, no emission, no live entry.
    } finally {
      state.inFlight.delete(plan.key);
    }
  }
}

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------

/** workerData payload. */
export interface AutopilotWorkerData {
  dbPath: string;
  /**
   * Initial paused flag. Boots-paused is the safety default; the
   * supervisor passes `paused: true` always (and flips it later via
   * `{ type: "set-paused", paused: false }`). Exposed in the payload
   * so a future flag-via-env path can override for hermetic tests.
   */
  paused?: boolean;
  /** Poll cadence for the data_version wake loop (ms). */
  pollMs?: number;
  /**
   * Zellij session name the in-worker `ExecBackend` lazily ensures
   * before its first `new-tab`. Threaded in from
   * `resolveConfig().zellijSession` so the worker doesn't read
   * `~/.config/keeper/config.yaml` itself — config I/O happens once on
   * main, every worker receives the resolved value.
   */
  zellijSession?: string;
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
 * Worker → main: DispatchFailed mint request. Main is the sole writer
 * of the synthetic event onto the events log; the worker only describes
 * what to mint.
 */
export interface DispatchFailedMessage {
  kind: "dispatch-failed";
  payload: DispatchFailedPayload;
}

/**
 * Worker → main: Dispatched mint request (fn-678, schema v50). Main is
 * the sole writer of the synthetic event onto the events log; the worker
 * only describes what to mint. Outbox-ordered intent — the reconciler
 * posts this BEFORE invoking `launch()` so a crash between mint and the
 * tab-spawn side-effect leaves a phantom `pending_dispatches` row the
 * producer-side TTL sweep discharges via `DispatchExpired` (strictly
 * preferable to double-dispatch in the launch→SessionStart blind window
 * the fn-674 live-tab probe used to cover).
 */
export interface DispatchedMessage {
  kind: "dispatched";
  payload: DispatchedPayload;
}

/**
 * Worker → main: DispatchExpired mint request (fn-678, schema v50).
 * Reserved for future worker-side use — the producer-side TTL sweep in
 * `daemon.ts` is the live caller and mints directly on the writable
 * connection (no Worker round-trip). The wire shape exists for parity
 * with `DispatchedMessage` / `DispatchFailedMessage` and for any future
 * worker-side discharge path.
 */
export interface DispatchExpiredMessage {
  kind: "dispatch-expired";
  payload: DispatchExpiredPayload;
}

type IncomingMessage = SetPausedMessage | ShutdownMessage;
// `DispatchFailedMessage`, `DispatchedMessage`, and `DispatchExpiredMessage`
// are the outgoing wire shapes main consumes when the reconcile + dispatch
// loop is wired; the supervisor's message handler types against the same
// records.

/**
 * Load a fresh {@link ReconcileSnapshot} from the worker's read-only
 * connection. Every collection is read through the SAME `runQuery` the
 * server-worker answers client subscriptions with, so the reconciler's
 * desired-vs-observed view matches the wire snapshot the readiness client
 * (board / viewer) sees byte-for-byte — no second decode path to drift.
 *
 * Each collection is read with NO wire filter, so each descriptor's
 * DEFAULT scope applies (epics: open-OR-not-approved; jobs: live-only
 * `working`/`stopped`) — exactly the live work set the reconciler acts on.
 * `limit: 0` is the "all rows" sentinel.
 *
 * Mirrors the readiness client's assembly (`src/readiness-client.ts`):
 *  - sub-agents are collapsed same-name → most-recent before readiness
 *    sees them (orphaned `running` rows whose `SubagentStop` never landed
 *    must not false-block predicate 6);
 *  - git rows are projected through the shared
 *    {@link projectGitStatusByProjectDir} helper (identical attribution
 *    math);
 *  - `failedKeys` is the set of `(verb, id)` with an open `dispatch_failures`
 *    row — sticky until a human `retry_dispatch` mints a `DispatchCleared`
 *    (cleared failures are deleted from the projection, so every row present
 *    is an open failure).
 */
async function loadReconcileSnapshot(
  db: Parameters<typeof runQuery>[0],
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

  const epics = read("epics") as unknown as Epic[];

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

  // fn-678: read `pending_dispatches` for the launch-window occupancy
  // signal. Each row represents a dispatched-but-not-yet-bound worker;
  // a row's presence (minted via `Dispatched` BEFORE `launch()`) keeps
  // the `liveTabKeys` arm of `reconcile()` fired until `SessionStart`
  // folds and discharges the row. No backend probe needed.
  const liveTabKeys = new Set<DispatchKey>();
  for (const row of read("pending_dispatches")) {
    const verb = (row as { verb?: unknown }).verb;
    const id = (row as { id?: unknown }).id;
    if (typeof verb === "string" && typeof id === "string") {
      liveTabKeys.add(dispatchKey(verb as Verb, id));
    }
  }

  return {
    epics,
    jobs,
    subagentInvocations,
    gitStatusByProjectDir,
    failedKeys,
    liveTabKeys,
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

  const { db } = openDb(data.dbPath, { readonly: true });
  const state: ReconcileState = {
    paused: data.paused ?? true,
    inFlight: new Set(),
  };
  // `liveDispatches` tracks the in-flight surfaces this reconciler still
  // owns confirm/reap work for (keyed `${verb}::${id}`). Boots EMPTY: a
  // cold restart re-derives "already running" from the durable `jobs`
  // projection (the snapshot's occupying-job gate suppresses re-dispatch
  // of survivors), so no surface is double-launched even though
  // liveDispatches starts cold. The worker-scoped abort controller aborts
  // every in-flight confirm sleep on shutdown.
  const shutdownController = new AbortController();
  const liveDispatches = new Map<DispatchKey, LiveDispatch>();
  let shutdown = false;
  // Late-bound reconcile kick. The reconciler is level-triggered on
  // `data_version` (the `watchLoop` below), but two edges have no DB write
  // to ride: (1) `play` (set-paused → false) flips an in-memory flag only,
  // and (2) a boot into an already-unpaused state. Without an explicit
  // kick, a quiescent DB leaves ready work undispatched until some
  // unrelated event happens to pulse `data_version`. `requestCycle` is
  // assigned once `driveCycle` is constructed below; it stays a no-op until
  // then (no message can arrive before `main()` finishes synchronous setup).
  let requestCycle: () => void = () => {};

  parentPort.on("message", (msg: IncomingMessage | undefined) => {
    if (!msg) return;
    if (msg.type === "shutdown") {
      shutdown = true;
      shutdownController.abort();
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

  // The terminal-surface backend (zellij). `noteLine` funnels the
  // backend's forensic warnings to stderr — the worker has no lifecycle
  // sidecar, so stderr is the visibility seam.
  const backend = resolveExecBackend({
    noteLine: (line: string) => {
      console.error(line);
    },
    session: data.zellijSession,
  });
  // `$SHELL` for the launch argv (`buildLaunchArgv`). Resolved once.
  const shell = process.env.SHELL ?? "/bin/sh";

  // Side-effect deps for the reconcile + confirm cycle. Reads run on the
  // worker's OWN read-only connection; the worker NEVER writes the DB —
  // a DispatchFailed is described to main via `postMessage` (main is the
  // sole writer of the synthetic event, mirroring the git-worker mint).
  const deps: ConfirmRunningDeps = {
    launch: (argv, name, cwd) => backend.launch(argv, name, cwd),
    emitDispatchFailed: (payload) => {
      parentPort?.postMessage({
        kind: "dispatch-failed",
        payload,
      } satisfies DispatchFailedMessage);
    },
    emitDispatched: (payload) => {
      parentPort?.postMessage({
        kind: "dispatched",
        payload,
      } satisfies DispatchedMessage);
    },
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
    sleep: (ms, signal) => abortableSleep(ms, signal),
    checkWorkPlugin: (tier) => checkWorkPluginManifest(tier),
  };

  // Single-flight reconcile drive. `watchLoop` fires this callback on
  // every `data_version` pulse; if a cycle is already running we set
  // `wakePending` and the running cycle loops once more after it finishes
  // — coalescing a burst of wakes into one trailing re-run (the same
  // shape `src/daemon.ts` keeps for the reducer pump). The cycle is fully
  // re-entrant-safe: `reconcile` is pure over a freshly-loaded snapshot,
  // and `runReconcileCycle` owns the one-at-a-time `inFlight` stagger.
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
        const snapshot = await loadReconcileSnapshot(db);
        const decision = reconcile(snapshot, state, deps.now());
        await runReconcileCycle(
          decision,
          state,
          liveDispatches,
          shell,
          shutdownController.signal,
          deps,
        );
      } while (wakePending && !shutdown);
    } catch (err) {
      // A reconcile/dispatch throw must not wedge the wake loop — log and
      // let the next pulse re-drive. (Per-launch failures are already
      // funnelled to DispatchFailed inside `confirmRunning`; this catch is
      // the snapshot-load / unexpected-throw backstop.)
      console.error("[autopilot-worker] reconcile cycle threw:", err);
    } finally {
      cycleRunning = false;
    }
  };

  // Bind the unpause/boot kick now that `driveCycle` exists, then run one
  // cycle immediately. The boot cycle is a no-op for launches while paused
  // (the safety default); the play-edge kick (above) is what dispatches
  // ready work the instant the human unpauses.
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
      closeDb();
      process.exit(0);
    })
    .catch((err) => {
      console.error("[autopilot-worker] watch loop crashed:", err);
      closeDb();
      process.exit(1);
    });
}

// Only run the loop when actually executing inside a Worker. A plain
// `import` from a test runs on the main thread, where `main()` must
// not fire — the pure `reconcile` / `confirmRunning` symbols are
// driven directly by the test suite.
if (!isMainThread) {
  main();
}

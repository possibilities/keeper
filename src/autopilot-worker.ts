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
 * Boots PAUSED. Main flips it via `set-paused` once the human plays. The flag is
 * in-memory only and NEVER persisted — boots-paused is the safety default;
 * persisting it would survive a restart in a way that contradicts the invariant.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { computeEligibleEpics } from "./armed-closure";
import {
  BackstopCounters,
  type BackstopMessage,
  buildTimeoutRecord,
} from "./backstop-telemetry";
import { openDb } from "./db";
import { resolveExecBackend } from "./exec-backend";
import {
  computeReadiness,
  isRootOccupant,
  type PendingDispatch,
  type Verdict,
} from "./readiness";
import {
  collapseSubagentsByName,
  projectGitStatusByProjectDir,
  projectPendingDispatches,
} from "./readiness-client";
import { runQuery } from "./server-worker";
import type { Epic, GitStatus, Job, SubagentInvocation } from "./types";
import { watchLoop } from "./wake-worker";

/**
 * The two planctl verbs the reconciler dispatches: `work` for a `ready` task
 * row, `close` for a `ready` close row. The argv shape's single source of truth
 * is `cli/autopilot.ts`.
 */
export type Verb = "work" | "close";

/**
 * The dedup / in-flight key — exactly `${verb}::${id}`, matching the `--name`
 * baked into the worker argv (also the zellij tab name).
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
 * The bounded recently-done epics window merged into the reconcile snapshot so
 * the close-row COMPLETION reap is reachable. The default epics read scopes to
 * `status='open'`, so a DONE epic would fall off the snapshot before its
 * close-row's done arm emits `{tag:"completed"}` — that arm now gates on
 * close-scope liveness, so the epic must stay observable through the whole
 * done→idle wind-down, not just the instant it flips done. A SECOND read with an
 * explicit `filter:{status:"done"}`, sorted `updated_at` DESC and LIMITed to
 * this window, is merged in (dedup by `epic_id`, open rows win). The bound keeps
 * the snapshot O(limit), never O(all done history). The limit is generous versus
 * a closer's wind-down. Over-observing is free (the reap is idempotent); only
 * UNDER-observing leaks, so the window has headroom over (fold-lag + reconcile
 * cadence + closer wind-down).
 */
export const DONE_EPICS_REAP_LIMIT = 32;

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
): string {
  const cdPrefix = projectDir === "" ? "" : `cd ${projectDir} && `;
  const flags: string[] = [];
  // Both verbs launch at max effort.
  flags.push("--model", "sonnet", "--effort", "max");
  flags.push("--arthack-no-confirm");
  // `--name <key>` adjacency is load-bearing for reap/classify parsing.
  flags.push("--name", `${verb}::${id}`);
  return `${cdPrefix}claude ${flags.join(" ")} '/plan:${verb} ${id}'`;
}

/** Compose the canonical `${verb}::${id}` key. */
export function dispatchKey(verb: Verb, id: string): DispatchKey {
  return `${verb}::${id}`;
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
  /**
   * The in-process re-dispatch cooldown (`${verb}::${id}` → unix-SECONDS of last
   * dispatch) — the fold-lag-immune suppression arm. `inFlight` is released the
   * moment `confirmRunning` resolves, but the projection-backed `liveTabKeys` may
   * not have folded yet; the cooldown bridges that gap for
   * `REDISPATCH_COOLDOWN_S` seconds. Held here so `reconcile()` can READ it and
   * stay pure — MUTATED only in the cycle glue. IN-MEMORY ONLY; boots EMPTY on
   * restart (safe — autopilot boots paused).
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
   * ALL epics/roots. `null` = unlimited. Threaded daemon → workerData → here so
   * the cap rides `state` and `reconcile()` stays pure.
   */
  maxConcurrentJobs: number | null;
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
  /**
   * `true` IFF this is an EPIC-level finalizer (`close` at the close-row site,
   * keyed by epic id). The cycle glue stamps `state.finalizerGuard[id]` for these
   * only. Set at the close-row push; absent/false on every task launch.
   */
  isEpicFinalizer?: boolean;
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
 *    row. UNKNOWN, not failed (zellij execs `claude` cold past the ceiling). NO
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
 * Inspect a `jobs` map for an OCCUPYING row keyed by `(plan_verb, plan_ref)`
 * whose `state` is in the non-terminal partition `{working, stopped}` (the
 * schema default is `stopped`, so a SessionStart-INSERTed row not yet at
 * `working` already occupies). Reading the projection instead of probing zellij
 * makes the dedup structurally race-free across restart — a non-terminal row for
 * `(verb, id)` means a dispatch would land a SECOND worker on the same task.
 * Pure — returns on first match.
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
): boolean {
  if (
    isOccupyingJob(jobs, "close", epic.epic_id) ||
    liveTabKeys.has(dispatchKey("close", epic.epic_id))
  ) {
    return true;
  }
  for (const task of epic.tasks) {
    if (
      isOccupyingJob(jobs, "work", task.task_id) ||
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
      if (isOccupyingJob(snapshot.jobs, verb, taskId)) {
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
        workerCommand: buildWorkerCommand(verb, taskId, cwd),
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
        !isOccupyingJob(snapshot.jobs, closeVerb, epicId) &&
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
          !isEpicInFlight(epic, snapshot.jobs, snapshot.liveTabKeys)
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
          workerCommand: buildWorkerCommand(closeVerb, epicId, projectDir),
          tier: null,
          // fn-742 — every close-row launch is an epic finalizer (`close`);
          // the cycle glue stamps the per-epic guard for these.
          isEpicFinalizer: true,
        });
        budget--;
      }
    }
  }

  return { launches, completedRowIds };
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
  // 3. Launch — ONLY after the durable `dispatched-ack{ok:true}`.
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
    // Shutdown observed right after a SUCCESSFUL launch — the worker is live
    // (or booting). Post-launch: keep the stamps so a fold-lag re-dispatch
    // can't double-launch this worktree.
    return "aborted-postlaunch";
  }
  // Poll loop — wait for the SessionStart jobs row. The `pending_dispatches` row
  // minted above keeps the `liveTabKeys` arm fired every cycle, so a slow-booting
  // worker holds its slot without a live zellij probe.
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
  // `launch.ok===false` guard), so the outcome is IN-DOUBT, not failed — zellij
  // execs `claude` cold occasionally past the ceiling, so a SessionStart may
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
          cwd: plan.cwd,
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
}

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------

/** workerData payload. */
export interface AutopilotWorkerData {
  dbPath: string;
  /**
   * Initial paused flag. Boots-paused is the safety default; the supervisor
   * passes `true` always and flips it later via `set-paused`. Exposed so tests
   * can override.
   */
  paused?: boolean;
  /** Poll cadence for the data_version wake loop (ms). */
  pollMs?: number;
  /**
   * Exec backend the in-worker reconciler dispatches into — `zellij` (default)
   * or `tmux`. Threaded in from `resolveConfig()` so config I/O happens once on
   * main and every worker receives the resolved value. The managed session name
   * is the hardcoded `MANAGED_EXEC_SESSION`, not configurable.
   */
  execBackend?: string;
  /**
   * Global root-occupant cap across ALL epics/roots. `null`/absent = unlimited.
   * Threaded in from `resolveConfig()`.
   */
  maxConcurrentJobs?: number | null;
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
 * ONE deliberate exception: a SECOND epics read with `filter:{status:"done"}`,
 * sorted `updated_at` DESC and LIMITed to {@link DONE_EPICS_REAP_LIMIT}, is
 * MERGED in (dedup by `epic_id`, open rows win) so a done epic stays visible
 * long enough for the close-row COMPLETION reap to observe its
 * `{tag:"completed"}` verdict. Done rows produce ONLY completed verdicts, so no
 * dispatch arm or mutex occupancy is perturbed.
 *
 * Mirrors the readiness client's assembly: sub-agents collapsed same-name →
 * most-recent (orphaned `running` rows must not false-block predicate 6); git
 * rows projected through {@link projectGitStatusByProjectDir}; `failedKeys` the
 * open `dispatch_failures` set (sticky until a `retry_dispatch` clears it).
 */
export async function loadReconcileSnapshot(
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

  // The default-scope (open) epics — the live work set — MERGED with a bounded
  // recently-DONE window so the close-row completion reap is reachable. Dedup
  // keys on `epic_id` with the OPEN row winning (a collision is only a fold-lag
  // transient; preferring the live row keeps dispatch arms on the freshest view).
  const openEpics = read("epics") as unknown as Epic[];
  const doneFrame = {
    type: "query" as const,
    collection: "epics",
    id: "autopilot-epics-done",
    filter: { status: "done" },
    sort: { column: "updated_at", dir: "desc" as const },
    limit: DONE_EPICS_REAP_LIMIT,
  };
  const doneRes = runQuery(db, 0, doneFrame);
  const doneEpics =
    doneRes.type === "result"
      ? (doneRes.rows as unknown as Epic[])
      : ([] as Epic[]);
  const seenEpicIds = new Set<string>();
  const epics: Epic[] = [];
  for (const epic of openEpics) {
    if (seenEpicIds.has(epic.epic_id)) {
      continue;
    }
    seenEpicIds.add(epic.epic_id);
    epics.push(epic);
  }
  for (const epic of doneEpics) {
    if (seenEpicIds.has(epic.epic_id)) {
      continue;
    }
    seenEpicIds.add(epic.epic_id);
    epics.push(epic);
  }

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

  const armedIds = new Set<string>();
  for (const row of read("armed_epics")) {
    const epicId = (row as { epic_id?: unknown }).epic_id;
    if (typeof epicId === "string") {
      armedIds.add(epicId);
    }
  }

  return {
    epics,
    jobs,
    subagentInvocations,
    gitStatusByProjectDir,
    failedKeys,
    liveTabKeys,
    pendingDispatches,
    mode,
    armedIds,
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
    paused: data.paused ?? true,
    inFlight: new Set(),
    // Boot EMPTY (safe: autopilot boots paused; the first cycle rebuilds
    // suppression from the live projection). In-memory only.
    redispatchCooldown: new Map(),
    finalizerGuard: new Map(),
    maxConcurrentJobs: data.maxConcurrentJobs ?? null,
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

  // The terminal-surface backend (zellij today; `data.execBackend` selects the
  // impl once task 2's switch lands). Dispatches into the hardcoded
  // `MANAGED_EXEC_SESSION` — `resolveExecBackend` fills that default, so no
  // session is threaded here. `noteLine` funnels its warnings to stderr — the
  // worker has no lifecycle sidecar.
  const backend = resolveExecBackend({
    noteLine: (line: string) => {
      console.error(line);
    },
  });
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
    launch: (argv, name, cwd) => backend.launch(argv, name, cwd),
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
    sleep: (ms, signal) => abortableSleep(ms, signal),
    recordTimeoutBackstop,
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
        const snapshot = await loadReconcileSnapshot(db);
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

// Only run inside a real Worker. A plain `import` from a test runs on the main
// thread, where `main()` must not fire — the pure symbols are driven directly.
if (!isMainThread) {
  main();
}

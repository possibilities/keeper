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
 *   2a. Durable ack-before-launch gate (fn-678/fn-724): `ack = await
 *      deps.emitDispatched({verb, id, ...})` posts a `Dispatched` intent
 *      to main for durable insert and BLOCKS on the id-correlated
 *      `dispatched-ack{id, ok}` reply. `{ok:false}` from the ack OR an
 *      ack-wait timeout → ABORT without launching (resolve
 *      `"aborted-prelaunch"`, no emit; a phantom `pending_dispatches` row, if
 *      one landed, is cleared by the TTL sweep). Outbox ordering — intent
 *      committed BEFORE the launch side-effect — is load-bearing (closes the
 *      SessionStart-drains-before-`dispatched` race, fn-627 class).
 *   2b. `res = await deps.launch(argv, name)`, ONLY after the durable
 *      `dispatched-ack{ok:true}`. `{ok:false}` (or throw) → emit
 *      `DispatchFailed` immediately with the surfaced reason and resolve
 *      `"failed"`.
 *   3. Poll BOTH `deps.findJob(plan_verb, plan_ref, last_event_id >
 *      watermark)` AND `deps.tabExistsByName(name)` every
 *      `pollIntervalMs` (~1-2s) until EITHER returns truthy — the
 *      named tab is visible OR the jobs row appears, whichever fires
 *      first — and resolve `"ok"` (fn-674 early-resolve). Releases
 *      the fn-644 one-at-a-time stagger in ~zellij latency rather
 *      than the full ceiling.
 *   4. Three-way ceiling outcome (`ceilingMs`, default 60s) — matches the
 *      `ConfirmOutcome` type doc:
 *        - `launch.ok===false` → `"failed"` (emit `DispatchFailed`, per 2b).
 *        - SessionStart bound (jobs row OR named tab visible) before the
 *          ceiling → `"ok"`.
 *        - Ceiling elapses with `launch.ok===true` and NO bind → `"indoubt"`
 *          (fn-724): NO `DispatchFailed` is emitted (the launch SUCCEEDED;
 *          zellij execs `claude` cold 24-33s later, occasionally past the
 *          ceiling, so a timeout is UNKNOWN, not failed). The
 *          `pending_dispatches` row is KEPT (it still holds the slot via the
 *          fifth suppression arm) so the producer-side TTL sweep
 *          (`PENDING_DISPATCH_TTL_MS`, 120s) mints `DispatchExpired` only if
 *          the bind truly never lands; `inFlight` is released.
 *      The last tick uses `Math.min(interval, remaining)` so the ceiling is
 *      honored. The `ceilingMs (60s) < PENDING_DISPATCH_TTL_MS (120s)`
 *      invariant is load-bearing (a sweep < ceiling would clear the row
 *      mid-confirm and re-open the dispatch).
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
import {
  dispatchKeyForPane,
  resolveExecBackend,
  type ZellijPane,
} from "./exec-backend";
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
 * The two planctl verbs the reconciler dispatches. Mirrors the
 * `buildWorkerCommand` verb union in `cli/autopilot.ts` (single source of
 * truth for the argv shape lives there; we only need the type alias here).
 * `work` runs for a `ready` task row; `close` for a `ready` close row.
 * fn-756 removed `approve` along with the approval window — no verb maps to
 * the (now-deleted) `job-pending` verdict.
 */
export type Verb = "work" | "close";

/**
 * The dedup / in-flight key shape — exactly `${verb}::${id}`, matching
 * the `--name` baked into the worker argv. This is also the zellij tab
 * name (so `closeByName(name)` can reap the surface).
 */
export type DispatchKey = string;

/**
 * fn-735 — the in-process re-dispatch cooldown window, in SECONDS.
 *
 * This is the fold-lag-immune suppression arm. The projection-backed dedup
 * arms (`failedKeys`, `isOccupyingJob`, `liveTabKeys`) all read PROJECTIONS;
 * when the reducer lags 15-60s+ behind reality every one of them is blind to
 * a dispatch that already fired, and the same `${verb}::${id}` is re-launched
 * (the observed two-`close::fn-651`-workers / infinite-re-approve class). The
 * cooldown holds a just-dispatched key suppressed for this many seconds —
 * regardless of projection lag — until the durable arms catch up and own
 * suppression again. The cooldown is ADDITIVE, never the sole suppressor.
 *
 * fn-762 — set to 200 s, STRICTLY GREATER than
 * `PENDING_DISPATCH_TTL_MS / 1000` (120 s) + the `PENDING_DISPATCH_SWEEP`
 * granularity (60 s). The 2026-06-09 incident triple-dispatched one worktree
 * because the cooldown co-EXPIRED with the 120 s pending-dispatch TTL while
 * fold lag still outlived both — at the shared 120 s boundary the suppression
 * lapsed in the very window the TTL sweep was still clearing the phantom row,
 * re-opening the dispatch. The window must outlast the WHOLE round-trip: the
 * pending row can survive up to TTL, then the producer-side sweep takes up to
 * one more sweep-granularity tick to mint `DispatchExpired`; the cooldown
 * therefore has to cover TTL + sweep + headroom (k8s ExpectationsTimeout —
 * suppression must outlast worst-case delivery delay; #129795 — a window
 * shorter than the lag re-introduces over-dispatch at expiry).
 *
 * UNIT TRAP (a 1000x bug if mixed up): `reconcile`'s `now` is unix SECONDS
 * (`deps.now` = `Math.floor(Date.now()/1000)`). This constant and the
 * cooldown Map's timestamps are ALL in seconds. NEVER compare them against
 * the ms-valued `*_TTL_MS` constants directly.
 */
export const REDISPATCH_COOLDOWN_S = 200;

/**
 * Floor between completion-reap `list-panes` probes (fn-765). Post-fn-764,
 * `completedRowIds` is non-empty on nearly every reconcile pulse (the
 * done-epics merge keeps freshly-done rows visible), so an unfloored reap
 * spawned `zellij list-panes -a -j` every cycle. A single-timestamp floor
 * (the simple variant of the fn-735 stamp/sweep pattern) collapses a burst
 * of pulses into one probe per window. Reap semantics are otherwise
 * unchanged: the helper is idempotent, and the fn-764 done-window keeps
 * rows visible long enough that a floored probe still fires within it.
 *
 * UNIT: SECONDS (matches `deps.now()` = `Math.floor(Date.now()/1000)`).
 * NEVER mix with the ms-valued `*_TTL_MS` constants.
 */
export const MIN_REAP_INTERVAL_S = 15;

/**
 * fn-742 — the in-process per-epic FINALIZER guard window, in SECONDS.
 *
 * Originally closed the fn-740 close↔approve race: for a single epic the
 * close-row verdict flipped between `ready` → `close` and
 * `blocked:job-pending` → `approve` across adjacent cycles, and those were
 * DIFFERENT `redispatchCooldown` keys so the fn-735 same-key cooldown did NOT
 * serialize them. fn-756 deleted the `approve` verb, so the close↔approve race
 * is structurally gone; `close` is now the SOLE epic finalizer. The guard is
 * retained (keyed by EPIC ID) as a fold-lag-immune backstop against any future
 * second finalizer verb and against a `close` re-dispatch the same-key fn-735
 * cooldown would already suppress — it stamps BEFORE the confirm await, reads
 * in the pure `reconcile`, sweeps in `driveCycle`.
 *
 * Tracks `REDISPATCH_COOLDOWN_S` (fn-762: now 200 s, strictly > the 120 s
 * pending-dispatch TTL + 60 s sweep granularity): conservatively longer than
 * any plausible fold-lag round-trip, same headroom rationale as fn-735.
 *
 * UNIT TRAP: unit-SECONDS throughout (`reconcile`'s `now`). NEVER compare
 * against the ms-valued `*_TTL_MS` constants.
 */
export const FINALIZER_GUARD_S = REDISPATCH_COOLDOWN_S;

/** The epic-level finalizer verb the per-epic guard serializes (fn-742). fn-756: `close`-only. */
const FINALIZER_VERBS: ReadonlySet<Verb> = new Set<Verb>(["close"]);

/**
 * fn-764 — the bounded recently-done epics window merged into the reconcile
 * snapshot so the fn-727 close-row COMPLETION reap is reachable.
 *
 * THE BUG IT FIXES: `loadReconcileSnapshot`'s epics read carries NO wire filter,
 * so the descriptor's `default_visible = 1` defaultClause applies — and after
 * fn-756 (schema v63) `default_visible` is `status='open'`, so a DONE epic falls
 * off the snapshot at the exact flip `evaluateCloseRow`'s `status==='done'` arm
 * needs to emit a `{tag:"completed"}` close-row verdict. The completed id never
 * reaches `completedRowIds`, the `close::<id>` pane is never reaped on the
 * completion path, and the pause-edge launch-window reap silently covered for it.
 *
 * THE FIX: a SECOND epics read with an explicit `filter:{status:"done"}` (which
 * drops the defaultClause — see `resolveFilter`), sorted `updated_at` DESC and
 * LIMITed to this window, merged (dedup by `epic_id`, open rows win) into
 * `snapshot.epics`. The bound keeps the snapshot O(limit), never O(all done
 * epics) — the fn-748 all-history anti-pattern.
 *
 * WHY 32: the window must comfortably exceed the worst-case (fold-lag +
 * reconcile cadence) so a freshly-done epic is observed at least once
 * post-flip; `reapSurfaces` is idempotent (a re-observation within the window
 * re-reaps an already-gone pane as a best-effort no-op), so over-observing is
 * free and only UNDER-observing leaks. 32 is the k8s TTL-after-finished
 * "bounded recently-completed window" sizing — generous headroom over a handful
 * of epics completing per cadence, still a tiny constant page.
 */
export const DONE_EPICS_REAP_LIMIT = 32;

/**
 * fn-742 — `true` IFF the epic-level finalizer for `epicId` is `close` (the
 * sole finalizer verb after fn-756). A close-row verdict mapping to `null`
 * (running / blocked-on-other / completed) is not a finalizer and is never
 * stamped or gated.
 */
export function isFinalizerVerb(verb: Verb | null): verb is Verb {
  return verb !== null && FINALIZER_VERBS.has(verb);
}

/**
 * fn-742 — pure per-epic finalizer-guard predicate. `true` IFF a finalizer
 * (`close`) for `epicId` was dispatched within the last
 * `FINALIZER_GUARD_S` seconds. `now` and the stored stamp are BOTH
 * unit-SECONDS. An absent entry (cleared on launch failure, swept on expiry, or
 * never stamped) is NOT guarded. Mirrors {@link isInCooldown}: read inside the
 * pure `reconcile`; the Map is mutated only in the cycle glue.
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
 * fn-742 — prune finalizer-guard entries older than the guard window. Mirrors
 * {@link sweepRedispatchCooldown}: walk the Map, DELETE every epic id whose
 * stamp is past `FINALIZER_GUARD_S` (it can no longer suppress, so it's pure
 * leak). Run once per cycle so the Map stays bounded over daemon uptime. `now`
 * is unit-SECONDS. Mutates in place — called ONLY from `driveCycle`, never
 * inside the pure `reconcile`. The caller wraps it in try/catch (no self-heal).
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
 * Build the `claude` worker shell command for a `(verb, id, cwd)`
 * combination — mirrors `buildWorkerCommand` in `cli/autopilot.ts:502`
 * byte-for-byte (same flag ordering, same `--name verb::id` correlator).
 * Lives here rather than re-exported from the cli module to keep this
 * worker's Worker-boundary import graph narrow (the cli file pulls in
 * clipboard/live-shell/etc.). The two implementations are pinned together
 * by `test/autopilot-worker.test.ts` which asserts the exact same argv
 * shape against the cli's frozen snapshot.
 *
 * fn-10 inverted tier routing: the worker no longer selects a tier-plugin
 * via `--plugin-dir`. The `plan` plugin is always loaded and `/plan:work`
 * spawns the emitted `worker_agent` (`plan:worker-<tier>`), so the
 * launcher carries no tier flag.
 *
 * Pure — exported for tests.
 */
export function buildWorkerCommand(
  verb: Verb,
  id: string,
  projectDir: string,
): string {
  const cdPrefix = projectDir === "" ? "" : `cd ${projectDir} && `;
  const flags: string[] = [];
  // fn-756: the `approve`-verb low-effort branch is gone with the verb; both
  // surviving verbs (`work`/`close`) launch at max effort.
  flags.push("--model", "sonnet", "--effort", "max");
  flags.push("--name", `${verb}::${id}`);
  return `${cdPrefix}claude ${flags.join(" ")} '/plan:${verb} ${id}'`;
}

/** Compose the canonical `${verb}::${id}` key. */
export function dispatchKey(verb: Verb, id: string): DispatchKey {
  return `${verb}::${id}`;
}

/**
 * fn-735 — pure cooldown predicate. `true` IFF `key` was dispatched within
 * the last `REDISPATCH_COOLDOWN_S` seconds. `now` and the stored stamp are
 * BOTH unit-SECONDS (matching `reconcile`'s `now` = `Math.floor(Date.now()
 * /1000)`); never mix with the ms-valued `*_TTL_MS` constants. An absent
 * entry (cleared on launch failure, swept on expiry, or never stamped) is
 * NOT in cooldown. Read inside the pure `reconcile`; the Map is mutated only
 * in the cycle glue.
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
 * fn-765 — has the completion-reap floor elapsed? True when `now` is at
 * least `MIN_REAP_INTERVAL_S` past `lastReapAt` (the last fired probe's
 * unix-seconds stamp), so the next `list-panes` probe is allowed. Boots
 * eligible: callers seed `lastReapAt` at `-Infinity` so the first cycle
 * always probes. The single-timestamp variant of `isInCooldown` — same
 * unit-SECONDS contract; never compared against `*_TTL_MS`.
 */
export function reapFloorElapsed(lastReapAt: number, now: number): boolean {
  return now - lastReapAt >= MIN_REAP_INTERVAL_S;
}

/**
 * fn-735 — prune cooldown entries older than the cooldown window. Mirrors
 * `server-worker.ts`'s `reapStuckPending` Map-reaper: walk the Map, DELETE
 * every key whose stamp is past `REDISPATCH_COOLDOWN_S` (an entry that can
 * no longer suppress, so it's pure leak). Run once per cycle so the Map
 * stays bounded over daemon uptime. `now` is unit-SECONDS. Mutates the Map
 * in place — called ONLY from the cycle glue (`driveCycle`), never inside
 * the pure `reconcile`. The caller wraps this in try/catch (no self-heal: a
 * sweep throw must not crash the worker and bounce the daemon).
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
 * fn-724 — pure reap-candidate predicate for `ExecBackend.reapSurfaces`.
 * Exported so the worker's pause handler and the test suite share the
 * EXACT safety gate (the highest-blast-radius decision in this epic).
 *
 * A pane is a reap candidate IFF it carries a `(work|close)::<id>`
 * dispatch key (lifted from `tab_name` / `terminal_command` by
 * `dispatchKeyForPane`) AND that key is in `openPendingKeys` — the set of
 * `${verb}::${id}` for every row still present in `pending_dispatches`.
 *
 * SAFETY: `pending_dispatches` rows discharge on `SessionStart` (the
 * reducer DELETEs the row when the worker binds), so a key MISSING from
 * `openPendingKeys` means a LIVE worker — its pane is NEVER reaped. The
 * name match alone never authorizes a close; `list-panes` lags zellij
 * reality and a name-only reap would kill live workers. A pane with no
 * dispatch key (a human's ad-hoc tab) is also never touched.
 *
 * fn-741 LIVE-VETO: a pane with `exited === false` is demonstrably live and
 * is NEVER a reap candidate, regardless of its `pending_dispatches`
 * membership. The `openPendingKeys` intersect is fold-latency-dependent —
 * during the 2026-06-08 fn-736 hook freeze, `SessionStart` never folded, so
 * keys never discharged and the pause reap killed LIVE workers mid-task.
 * This veto removes the fold-latency dependency from the highest-blast-radius
 * close decision, making the reap strictly MORE conservative. Treat ONLY an
 * explicit `false` as live — `undefined` is unknown (zellij omits the field)
 * and MUST fall through so true ghosts still reap.
 */
export function isReapCandidate(
  openPendingKeys: Set<DispatchKey>,
  pane: ZellijPane,
): boolean {
  if (pane.exited === false) {
    return false;
  }
  const key = dispatchKeyForPane(pane);
  return key != null && openPendingKeys.has(key);
}

/**
 * fn-727 — pure completion-reap predicate for `ExecBackend.reapSurfaces`.
 * A SIBLING of `isReapCandidate`, NOT an overload: the two gate on
 * OPPOSITE sets. `isReapCandidate` reaps the pause-window ghost — a pane
 * whose key is still OPEN in `pending_dispatches` (not-yet-bound launch).
 * This predicate reaps the COMPLETED row's surface — a pane whose key's
 * `<id>` reached the durable `{tag:"completed"}` readiness verdict this
 * cycle.
 *
 * A pane is a completion-reap candidate IFF its `(work|close)::<id>`
 * dispatch key (lifted by `dispatchKeyForPane`) has its `<id>` in
 * `completedRowIds` — the set of task ids / epic ids whose readiness
 * verdict is `{tag:"completed"}` this cycle. fn-756: a completed task reaps
 * `work::<id>` and a completed close row reaps `close::<id>` (the
 * `approve::<id>` surface no longer exists — the approve verb is gone).
 *
 * SAFETY — DELIBERATE DIVERGENCE from practice-scout's universal "match
 * name AND `is_exited==true`" rule: `is_exited` (the pane's `exited`
 * field) is INTENTIONALLY NOT gated. fn-756: the reap now fires the instant
 * the worker exits (worker-done completion, no approval delay), and the
 * worker pane may still be live on the cycle the verdict flips to
 * `completed`, so an `is_exited` gate could miss it. The durable
 * `{tag:"completed"}` verdict is the SOLE authorization; the name match
 * only LOCATES the pane. A completed row cannot have a concurrent live
 * worker for the same id (a re-dispatch would flip the row OFF `completed`).
 * Do NOT "fix" this back to the `is_exited` default. A pane with no dispatch
 * key (a human's ad-hoc tab) is never touched.
 *
 * fn-741 LIVE-VETO: the same `exited === false` safety net the pause reap
 * carries is layered here too. This does NOT reinstate the rejected
 * "match name AND is_exited==true" rule — that gated on `exited === true`,
 * which would never reap a still-live-at-completion worker. The veto is the
 * INVERSE polarity: it blocks ONLY a demonstrably-live (`exited === false`)
 * pane, while `true` AND `undefined` still fall through to the
 * `{tag:"completed"}` authorization. So a worker pane that has wound down
 * (`exited` undefined or true on the next list-panes) still reaps normally;
 * only a pane zellij explicitly reports as still-running is spared one cycle.
 * Defense-in-depth against any fold-latency edge where a still-live worker's
 * id transiently appears in `completedRowIds`.
 *
 * IDEMPOTENCY (fn-756): the reap fires immediately on worker exit, and a
 * `data_version` double-fire can re-select an already-closed pane.
 * `ExecBackend.reapSurfaces` treats a failed `close-pane` (already-gone
 * pane) as a best-effort no-op (`failed++` + warn + continue), NEVER a
 * throw — so a double-reap can't crash the worker path into `fatalExit`.
 */
export function isCompletionReapCandidate(
  completedRowIds: Set<string>,
  pane: ZellijPane,
): boolean {
  if (pane.exited === false) {
    return false;
  }
  const key = dispatchKeyForPane(pane);
  if (key == null) {
    return false;
  }
  // Key is `${verb}::${id}`; `<id>` is everything after the first `::`.
  // Ids never contain `::` (verb-prefixed keys are `verb::id` with the
  // verb being one of work|close), so a single split is exact.
  const sep = key.indexOf("::");
  if (sep < 0) {
    return false;
  }
  const id = key.slice(sep + 2);
  return completedRowIds.has(id);
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
   *
   * This is the SAME-`(verb,id)` re-dispatch dedup arm. fn-721 ADDS a
   * separate, orthogonal use of the same projection — the
   * `pendingDispatches` field below feeds `computeReadiness`'s
   * cross-sibling `dispatch-pending` occupant. The two are deliberately
   * kept distinct (this set suppresses re-dispatch of the SAME key; the
   * occupant demotes a DIFFERENT sibling on the same epic/root); both are
   * needed.
   */
  liveTabKeys: Set<DispatchKey>;
  /**
   * The open `pending_dispatches` rows (fn-721) projected into the plain
   * {@link PendingDispatch}[] shape `computeReadiness` consumes for the
   * cross-sibling `dispatch-pending` occupant. Built by the SAME shared
   * helper (`projectPendingDispatches`) the board/CLI path uses, so the
   * autopilot reconciler and `subscribeReadiness` compute identical
   * verdicts for the same pending set. Distinct from `liveTabKeys` above
   * (same-key dedup vs cross-sibling demotion — see that field's doc).
   */
  pendingDispatches: PendingDispatch[];
  /**
   * fn-751 — the autopilot mode enum, read fresh from the `autopilot_state`
   * singleton each cycle (NOT threaded through `workerData`, NOT cached on
   * `ReconcileState` — the projection is the single source of truth and
   * survives a daemon restart for free). `'yolo'` (the default on a
   * zero-event / pre-existing row) works every ready epic — byte-for-byte the
   * pre-fn-751 behavior; `'armed'` gates `work` to {@link armedIds} plus their
   * transitive upstream dep-closure.
   */
  mode: "yolo" | "armed";
  /**
   * fn-751 — the explicitly-armed epic ids, read fresh from the `armed_epics`
   * presence projection each cycle. Empty in `yolo` mode (the arm is a no-op
   * there) and whenever no epic is armed. In `armed` mode `reconcile` expands
   * this into the eligible set (armed ∪ transitive upstreams) via
   * {@link computeEligibleEpics} and suppresses `work` for any epic outside it.
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
   * fn-735 — the in-process re-dispatch cooldown. Maps `${verb}::${id}` →
   * the unix-SECONDS timestamp at which the key was last dispatched. Same
   * shape/lifecycle as `inFlight` above and `server-worker.ts`'s
   * `lastSent`/`reapStuckPending` Map-reaper: held on `ReconcileState` so
   * `reconcile()` can READ it (like `inFlight`) and stay pure — it is
   * MUTATED only in the cycle glue (`runReconcileCycle` stamps/clears,
   * `driveCycle` sweeps), NEVER inside `reconcile`.
   *
   * The fold-lag-immune suppression arm: `inFlight` is released in the
   * `finally` the moment `confirmRunning` resolves, but the
   * projection-backed `liveTabKeys` (from `pending_dispatches`) may not
   * have folded yet — so the next cycle would re-dispatch the same key.
   * The cooldown bridges that gap for `REDISPATCH_COOLDOWN_S` seconds.
   *
   * IN-MEMORY ONLY — never written to the event log, projections, reducer,
   * or RPC surface. Boots EMPTY on restart (safe: autopilot boots paused,
   * and the first cycle rebuilds suppression from the live projection). The
   * timestamps are unit-SECONDS, matching `reconcile`'s `now`.
   */
  redispatchCooldown: Map<DispatchKey, number>;
  /**
   * fn-742 — the in-process per-epic FINALIZER guard. Maps an EPIC ID →
   * the unix-SECONDS timestamp at which a finalizer (`close`) for that epic was
   * last dispatched. Same shape/lifecycle as `redispatchCooldown` above: held
   * on `ReconcileState` so `reconcile()` can READ it and stay pure; MUTATED
   * only in the cycle glue (`runReconcileCycle` stamps/clears, `driveCycle`
   * sweeps), NEVER inside `reconcile`.
   *
   * fn-756: originally serialized the fn-740 close↔approve race (distinct
   * `redispatchCooldown` keys for `close::<epic>` vs `approve::<epic>`). With
   * `approve` deleted, `close` is the sole finalizer — the guard is retained as
   * an epic-id-keyed fold-lag-immune backstop against a `close` re-dispatch.
   *
   * IN-MEMORY ONLY — never the event log / projections / reducer / RPC surface.
   * Boots EMPTY on restart (safe: autopilot boots paused; the first cycle
   * rebuilds suppression from the live projection). Timestamps are unit-SECONDS.
   */
  finalizerGuard: Map<string, number>;
  /**
   * Global ceiling on how many root-occupants this reconciler dispatches
   * at once across ALL epics/roots (fn-725). `null` = unlimited (today's
   * behavior — no cap). Threaded daemon → workerData → here so the cap
   * rides `state` and `reconcile()` stays pure (never a module global).
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
   * fn-742 — `true` IFF this is an EPIC-level finalizer (`close` or `approve`
   * emitted at the close-row site, keyed by epic id). The cycle glue stamps
   * `state.finalizerGuard[id]` for these and only these, so a task-level
   * `approve::<task>` (never set here) stays out of the per-epic guard. Set
   * once at the close-row push; absent/false on every task launch.
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
 * The output of `reconcile(snapshot, state)`: the launches to fire PLUS
 * (fn-727) the set of row ids whose readiness verdict is
 * `{tag:"completed"}` this cycle. Pure data — `runReconcileCycle` walks
 * `launches`; the completion-reap pass in `driveCycle` reads
 * `completedRowIds`.
 *
 * `completedRowIds` is harvested from the SAME `computeReadiness` pass
 * `reconcile` already makes (single source of truth) — `driveCycle` must
 * NOT recompute readiness to derive it. It holds task ids (from
 * `readiness.perTask`) and epic ids (from `readiness.perCloseRow`) whose
 * verdict tag is `completed`. The completion-reap predicate keys off
 * `<id>` only, so a completed task authorizes reaping `work::<id>` and a
 * completed close row authorizes `close::<id>` (fn-756: no `approve::<id>`
 * surface is ever dispatched, so none is reaped).
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
   * Emit a synthetic `Dispatched` event onto the writable connection (via
   * the parent thread — workers never write the DB) AND AWAIT a durable
   * ack (fn-724). Outbox-ordered intent (fn-678): the reconciler mints
   * this BEFORE `launch()` so a crash between mint and the side-effect
   * leaves a phantom `pending_dispatches` row the producer-side TTL sweep
   * clears via `DispatchExpired`. Strictly preferable to double-dispatch
   * in the launch→SessionStart blind window the fn-674 live-tab probe
   * used to cover.
   *
   * fn-724 — DURABLE before launch. Returns a Promise that resolves only
   * once main has DURABLY inserted the `Dispatched` event onto the
   * writable connection and replied `dispatched-ack{ok}`. `confirmRunning`
   * AWAITS it BEFORE `launch()`: the fire-and-forget `postMessage` it
   * replaced let main drain a worker's `SessionStart` BEFORE the queued
   * mint landed, so the `pending_dispatches` row was never written, the
   * launch-window occupancy arm never fired, and the slot double-dispatched
   * (the fn-627 class). A `{ok:false}` resolution (insert threw) — OR an
   * ack-timeout / shutdown surfaced via the rejected Promise — ABORTS the
   * dispatch without launching: no double-dispatch; if the row DID land
   * (timeout after a slow insert) the TTL sweep clears the phantom.
   *
   * Carries the reconcile-time `ts` so the reducer's `Dispatched` fold
   * lands `pending_dispatches.dispatched_at` byte-identically across a
   * re-fold (all wallclock lives in the producer; the fold never reads
   * `Date.now()`).
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
   * Report the autopilot `confirmRunning` ceiling backstop fire (epic
   * fn-720, `timeout` class). Called exactly once per confirm: on a
   * SessionStart that lands BEFORE the ceiling with `rescued:false`,
   * `stalenessMs:null` (the denominator — a healthy fast path) and on a
   * ceiling-hit with `rescued:true`, `stalenessMs:elapsedMs` (the
   * rescue — SessionStart never arrived, so the ceiling failed the
   * dispatch). The live worker bumps its {@link BackstopCounters} and, on
   * a rescue, posts the {@link buildTimeoutRecord} `timeout` record up to
   * main (the sole sidecar writer); the record carries `fast_path:null` /
   * `last_fast_path_at:null` (timeout has no fast-path notion).
   *
   * Optional: when absent the call is a no-op (tests that don't exercise
   * telemetry skip wiring it). STRICTLY ADDITIVE — it never perturbs the
   * existing `DispatchFailed` emit or the dispatch gates.
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
 * Confirm outcome — internal to `runReconcileCycle`. Four-way (fn-724):
 *  - `"ok"` — the SessionStart `jobs` row landed before the ceiling. Noop
 *    happy path; the dispatch is promoted to `liveDispatches`.
 *  - `"failed"` — `launch()` returned `{ok:false}` (or threw). The worker
 *    never materialized, so `deps.emitDispatchFailed` mints a STICKY
 *    `DispatchFailed` (cleared only by a human `retry_dispatch`).
 *  - `"indoubt"` (fn-724) — the launch SUCCEEDED (`launch.ok===true`) but
 *    the ceiling elapsed with NO `jobs` row. The launch outcome is
 *    UNKNOWN, not failed (zellij accepts `new-tab` and execs `claude` cold
 *    24-33s later, occasionally past the ceiling). NO `DispatchFailed` is
 *    minted (that would be a sticky ghost-worker write-off); the
 *    `pending_dispatches` row is KEPT so the producer-side TTL sweep
 *    eventually mints `DispatchExpired` if the bind truly never arrives.
 *    `inFlight` is released (same as `ok`/`failed`).
 *  - `"aborted-prelaunch"` (fn-762) — an abort that fired BEFORE `launch()`
 *    ran: a durable-ack `{ok:false}`, an ack-wait reject (timeout/shutdown),
 *    or a shutdown signal racing the ack. The launch NEVER happened, so there
 *    is no worker to write off and nothing to clean up beyond a possible
 *    phantom `pending_dispatches` row (cleared by the TTL sweep). The cycle
 *    glue CLEARS the cooldown + finalizer-guard stamps on this outcome —
 *    `failedKeys` owns stickiness and `retry_dispatch` re-dispatches without
 *    waiting the window out.
 *  - `"aborted-postlaunch"` (fn-762) — an abort observed AFTER `launch()`
 *    fired (a shutdown signal seen mid-poll). The launch DID happen, so a
 *    ghost worker may exist and the pause-reap projection may lag behind it;
 *    the cycle glue KEEPS the cooldown + finalizer-guard stamps (same as
 *    `ok`/`indoubt`) so a fold-lag-blind re-dispatch can't double-launch the
 *    same worktree. No DispatchFailed either way (shutdown is a clean
 *    teardown, not a sticky failure).
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
 * Floor for the durable `dispatched-ack` wait (fn-724). `confirmRunning`
 * awaits main's `Dispatched` insert before `launch()`; if the ack never
 * arrives within this window the dispatch ABORTS (no launch). The floor
 * MUST exceed `busy_timeout` (5s, `src/db.ts`) plus a boot-drain so a
 * dispatch fired during the boot drain — when the writable connection may
 * be blocked on the WAL writer lock for a full `busy_timeout` — does NOT
 * false-abort. 10s gives 2x the `busy_timeout` of margin. An ack-timeout
 * is the rare crash/wedge case (the insert is a single prepared-statement
 * run in steady state, replying in sub-ms); a phantom row from a timeout
 * AFTER a slow insert self-clears via the TTL sweep.
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
    // fn-721: the launch-window occupancy set — feeds the cross-sibling
    // `dispatch-pending` occupant so a same-epic / same-root sibling is
    // demoted while a dispatch is in flight. The same-key `liveTabKeys`
    // dedup arms below are orthogonal and stay untouched.
    snapshot.pendingDispatches,
  );

  // fn-727: harvest the completion set from the ONE readiness pass above
  // (never a second `computeReadiness`). A `{tag:"completed"}` task verdict
  // authorizes reaping `work::<id>`; a completed close-row verdict authorizes
  // `close::<id>` — the completion-reap predicate keys off `<id>` only (fn-756:
  // no `approve::<id>` surface to pair). Both maps feed the same id set (task
  // ids and epic ids never collide — `fn-N-slug.M` vs `fn-N-slug`).
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

  // fn-756: the fn-742.2 rejected-epic auto-clear is REMOVED. It harvested
  // close-row `{kind:"job-rejected"}` verdicts and requested a one-shot
  // `set_epic_approval` sidecar write back to `pending`. With the approval
  // enum no longer gating, no close row is ever `job-rejected`, so there is
  // nothing to recover.

  // fn-725 global concurrency cap. Count root-occupants ONCE over the
  // POST-mutex verdicts of BOTH perTask AND perCloseRow — `isRootOccupant`
  // is planner-exempt, matching the per-root mutex predicate so the two
  // counts never drift. This snapshot baseline includes a `dispatch-pending`
  // row (it occupies), but that row is already suppressed from re-push by
  // the `liveTabKeys`/`isOccupyingJob` arms below, so it never
  // double-consumes. `budget` is the remaining admittance for NEWLY-planned
  // launches this cycle; `null` cap is a fast-path bypass (POSITIVE_INFINITY)
  // rather than `Infinity` at rest. Strict `budget > 0` (CWE-193): cap=1
  // occupied=1 → budget=0 → admit nothing.
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

  // fn-751 — the armed-mode eligibility gate. In `armed` mode `work` is
  // dispatched ONLY for explicitly-armed epics PLUS their transitive upstream
  // dep-closure; everything else is suppressed. Compute the eligible set ONCE
  // per cycle here (recomputed every cycle — caching would reintroduce
  // staleness when the DAG shifts) by expanding `snapshot.armedIds` over the
  // reversed dep edges. In `yolo` mode the arm is a no-op and we skip the
  // closure entirely. `armedMode` gates the per-row checks below; `eligible`
  // is consulted only when it is true.
  //
  // WORK-ONLY: the arm gates `work` launches alone. `approve` / `close`
  // finalizers and completion-reap stay mode-exempt (mirroring how `approve`
  // is already budget-exempt) so disarming an epic mid-flight still finishes
  // and reaps cleanly rather than orphaning a live worker or leaking surfaces.
  const armedMode = snapshot.mode === "armed";
  const eligible: Set<string> = armedMode
    ? computeEligibleEpics(
        snapshot.armedIds,
        new Map(snapshot.epics.map((e) => [e.epic_id, e])),
      )
    : new Set<string>();

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
      // fn-751 — armed-mode gate. Suppress a `work` launch for an epic NOT in
      // the eligible set (armed ∪ transitive upstreams). Placed ABOVE the
      // budget gate so a non-eligible epic never consumes `max_concurrent_jobs`
      // budget. A task verdict only ever maps to `work` (fn-756), so this gate
      // covers every task launch. No-op in `yolo` mode (`armedMode === false`).
      if (armedMode && verb === "work" && !eligible.has(epic.epic_id)) {
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
      // fn-735 — fold-lag-immune cooldown arm. Suppress re-dispatch of a
      // key dispatched within the last `REDISPATCH_COOLDOWN_S` seconds even
      // when EVERY projection arm above is blind to it (the reducer lagged
      // the prior dispatch's fold). READ-ONLY here — purity is sacred; the
      // stamp/clear live in `runReconcileCycle`, the sweep in `driveCycle`.
      // Placed ABOVE the budget gate.
      if (isInCooldown(state.redispatchCooldown, key, now)) {
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
      // fn-725 cap — LAST gate, after every per-task/per-epic/per-root
      // verdict is computed (so debug verdicts aren't masked). A budget
      // skip does NOT hold a slot; it just defers this launch to a later
      // cycle once an occupant frees up. fn-756: the fn-728 `approve`
      // cap-exemption is gone with the `approve` verb — every task launch is
      // `work` and counts against the budget.
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
        // fn-674 standing dedup arm: a live `close::<epic>` tab in the
        // session is proof a launched closer occupies the slot before
        // its SessionStart binds. Same shape as the task arm above.
        !snapshot.liveTabKeys.has(closeKey) &&
        // fn-735 — the fold-lag-immune cooldown arm at the close-row site
        // too (miss it and close rows still DUP-DISPATCH). READ-ONLY; same
        // unit-seconds `now`. ABOVE the budget gate.
        !isInCooldown(state.redispatchCooldown, closeKey, now) &&
        // fn-742 — the per-epic FINALIZER guard. fn-756: `close` is now the
        // sole finalizer verb, so this guards a `close` re-dispatch (also
        // covered by the same-key fn-735 cooldown — kept as a fold-lag-immune
        // backstop keyed by epic id). READ-ONLY here; the stamp/clear live in
        // `runReconcileCycle`, the sweep in `driveCycle`.
        !(
          isFinalizerVerb(closeVerb) &&
          isFinalizerGuarded(state.finalizerGuard, epicId, now)
        ) &&
        // fn-725 cap — the close-row push shares the SAME decrementing
        // budget as the task push above, so a closer can't blow the cap.
        // fn-756: the fn-728 `approve` cap-exemption is gone — every close-row
        // launch is `close` and counts against the budget.
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
 * Abort handling (fn-762): an abort BEFORE `launch()` resolves
 * `"aborted-prelaunch"` (ack reject / `{ok:false}` / shutdown racing the
 * ack); an abort observed AFTER `launch()` fired resolves
 * `"aborted-postlaunch"`. Neither emits `DispatchFailed` — shutdown is a
 * clean teardown, not a sticky failure — but the two split so the cycle glue
 * can CLEAR the cooldown on the pre-launch case (nothing launched) and KEEP
 * it on the post-launch case (a ghost worker may exist).
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
  // 2. Mint intent BEFORE launch (outbox ordering, fn-678) AND AWAIT a
  //    DURABLE ack (fn-724). The pre-fn-724 mint was a fire-and-forget
  //    `postMessage` NOT awaited before `launch()`, so main could drain a
  //    worker's `SessionStart` BEFORE the queued `Dispatched` mint landed —
  //    the `pending_dispatches` row was never written, the launch-window
  //    occupancy arm never fired, and the slot double-dispatched (fn-627).
  //    Now `await`-ing the ack guarantees the durable row exists BEFORE the
  //    side-effect. Two abort flavors, BOTH don't-launch:
  //      (a) ack `{ok:false}` (insert threw) — NO row landed; nothing to
  //          clean up. Abort cleanly.
  //      (b) ack-wait REJECTED (timeout ≥ busy_timeout+drain, or shutdown)
  //          — the row MAY have landed (a slow insert that replied after the
  //          wait gave up); the producer-side TTL sweep clears any such
  //          phantom via `DispatchExpired`. Abort cleanly.
  //    Either way we return `"aborted-prelaunch"` (no `DispatchFailed` — the
  //    launch never happened, so there is no worker to write off). A phantom
  //    row delaying a real re-dispatch by up to one TTL window is strictly
  //    preferable to double-dispatch.
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
      // Mid-poll shutdown — launch already fired. Post-launch (keep stamps).
      return "aborted-postlaunch";
    }
    elapsedMs += sleepMs;
    const hit = deps.findJob(verb, id, watermark);
    if (hit != null) {
      // fn-720: the ceiling did NOT have to rescue this dispatch — the
      // SessionStart jobs row landed before the ceiling. Counted as the
      // `rescued:false` denominator so the rescue RATE is honest; no record
      // line is written for the no-op (the counter rollup carries it).
      deps.recordTimeoutBackstop?.({ rescued: false, stalenessMs: null });
      return "ok";
    }
    if (signal.aborted) {
      // Mid-poll shutdown — launch already fired. Post-launch (keep stamps).
      return "aborted-postlaunch";
    }
  }
  // Ceiling elapsed with no jobs row. fn-724: the launch SUCCEEDED
  // (`launch.ok===true` — we only reach here past the `launch.ok===false`
  // guard above), so the outcome is IN-DOUBT, not failed. zellij accepts
  // `new-tab` and execs `claude` cold 24-33s later — occasionally past the
  // ceiling — so a SessionStart may still be coming. Treating it as a
  // sticky `DispatchFailed` produced ghost workers the system wrongly wrote
  // off (the findings.md §7c incident). Instead:
  //   - SUPPRESS the `DispatchFailed` emit (no sticky write-off).
  //   - KEEP the `pending_dispatches` row (minted + ack'd above). It holds
  //     the launch-window slot AND, if the bind truly never arrives, the
  //     producer-side TTL sweep (120s, > this 60s ceiling) mints
  //     `DispatchExpired` to clear it. The full ordering chain is load-bearing
  //     (fn-762): `ceilingMs (60s) < PENDING_DISPATCH_TTL_MS (120s) <
  //     REDISPATCH_COOLDOWN_S (200s)`. ceiling < TTL: were the sweep < ceiling
  //     it would clear the row mid-confirm and re-open the dispatch. TTL <
  //     cooldown: the cooldown must outlast the worst-case round-trip (the
  //     pending row surviving a full TTL plus the sweep tick that clears it)
  //     so suppression never lapses while a phantom is still in flight.
  // The reducer is UNCHANGED — `foldDispatchExpired` already DELETEs the
  // row idempotently; the coupling break is entirely producer-side
  // suppression of the emit.
  //
  // fn-720 telemetry rides ALONGSIDE unchanged: the ceiling still RESCUED a
  // stuck dispatch (the fast path — SessionStart before ceiling — did not
  // fire), so `rescued:true` with the elapsed-since-dispatch `stalenessMs`.
  // (The fn-720 epic's noted follow-on re-label of a ceiling→indoubt
  // outcome is out of scope for this task — left as-is here.)
  deps.recordTimeoutBackstop?.({ rescued: true, stalenessMs: elapsedMs });
  return "indoubt";
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
    // fn-10: the per-tier work-plugin manifest pre-flight guard is gone —
    // the `plan` plugin is always loaded and `/plan:work` spawns the emitted
    // `worker_agent` (`plan:worker-<tier>`), so there is no `--plugin-dir`
    // tier-plugin to validate. The planctl check-generated guard on
    // `agents/worker-<tier>.md` now turns a missing tier agent into a visible
    // failure upstream.
    state.inFlight.add(plan.key);
    // fn-735 — STAMP the cooldown at the SAME point as `inFlight.add`,
    // BEFORE the confirm await, so it covers BOTH the `ok` AND the
    // `indoubt` outcomes. The slow cold-boot `indoubt` case (worker live,
    // `pending_dispatches` real, `jobs` row not yet bound, the `Dispatched`
    // fold still lagging) IS the headline bug — gating the stamp on
    // `outcome==="ok"` would leave exactly those slow launches
    // re-dispatchable. unit-SECONDS, matching `reconcile`'s `now`.
    state.redispatchCooldown.set(plan.key, deps.now());
    // fn-742 — STAMP the per-epic finalizer guard at the SAME point (before
    // the confirm await) for an epic-level finalizer launch. `isEpicFinalizer`
    // is set ONLY at the close-row push in `reconcile` (the sole emitter of a
    // `close`/`approve` keyed by an epic id), so a task-level `approve::<task>`
    // never reaches the guard — explicit flag, not an id-shape heuristic. Same
    // indoubt-covering rationale as the cooldown stamp above; unit-SECONDS,
    // keyed by epic id (= `plan.id`).
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
      // fn-735/fn-762 — CLEAR the cooldown only when nothing actually
      // launched: a DEFINITIVE launch failure (`launch.ok===false` →
      // `DispatchFailed`, surfaced here as `outcome==="failed"`) or an abort
      // BEFORE `launch()` fired (`outcome==="aborted-prelaunch"`: a
      // durable-ack reject / `{ok:false}` / shutdown racing the ack — the
      // launch never happened). `failedKeys` then owns stickiness for
      // `failed`, and the human's `retry_dispatch` (which clears
      // `failedKeys`, not worker memory) re-dispatches without first having
      // to wait out the cooldown in this process.
      //
      // `ok` / `indoubt` / `aborted-postlaunch` KEEP the stamp — the launch
      // DID fire in all three, so a fold-lag-blind re-dispatch could
      // double-launch the same worktree (the 2026-06-09 incident class).
      // `aborted-postlaunch` is the fn-762 split that makes a mid-poll
      // shutdown keep the stamp: the ghost worker may outlive the pause-reap
      // projection lag, so suppression must hold.
      if (outcome === "failed" || outcome === "aborted-prelaunch") {
        state.redispatchCooldown.delete(plan.key);
        // fn-742 — on a definitive launch failure / pre-launch abort, the
        // finalizer never actually ran, so release the per-epic guard too
        // (same rationale as the cooldown clear: don't make the sibling
        // finalizer wait out the window for a launch that didn't happen).
        // Kept in lockstep with the cooldown clear above (fn-742 parity).
        // `ok` / `indoubt` / `aborted-postlaunch` KEEP the stamp.
        if (plan.isEpicFinalizer) {
          state.finalizerGuard.delete(plan.id);
        }
      } else if (outcome === "indoubt") {
        // fn-762 — re-stamp ONCE at the indoubt resolution. The original
        // stamp (set at dispatch, before the confirm await) is now up to
        // `ceilingMs` (60s) stale by the time the ceiling elapses, so it
        // would expire 60s early relative to the in-doubt launch it must
        // suppress. Refreshing it here restarts the full window from the
        // resolution instant. This is a SINGLE refresh at resolution — never
        // compounding across cycles: the next cycle's dispatch path re-stamps
        // normally only if it actually re-dispatches (the openclaw#23516
        // perpetual-suppression trap is re-stamping on EVERY retry). Kept in
        // lockstep with the finalizer guard (fn-742 parity). unit-SECONDS.
        state.redispatchCooldown.set(plan.key, deps.now());
        if (plan.isEpicFinalizer) {
          state.finalizerGuard.set(plan.id, deps.now());
        }
      }
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
      //   confirmRunning; no live entry recorded.
      // outcome === "indoubt" (fn-724) → launch succeeded but the ceiling
      //   elapsed with no jobs row; NO DispatchFailed, the pending row is
      //   kept (TTL sweep clears it if the bind never lands). No live entry
      //   recorded (we never observed the confirm), but inFlight IS released
      //   (the `finally` below) — same as ok/failed. Stamps re-stamped above.
      // outcome === "aborted-prelaunch" (fn-762) → a durable-ack abort
      //   (emitDispatched {ok:false} / ack-wait reject) or a shutdown racing
      //   the ack; no emission, no live entry, the launch never happened —
      //   stamps cleared above.
      // outcome === "aborted-postlaunch" (fn-762) → a mid-poll shutdown after
      //   `launch()` fired; no emission, no live entry, but the launch DID
      //   happen — stamps KEPT above (a ghost worker may exist).
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
  /**
   * Global concurrent-job cap (fn-725) — the configured ceiling on
   * root-occupants autopilot dispatches at once across ALL epics/roots.
   * `null`/absent = unlimited. Threaded in from
   * `resolveConfig().maxConcurrentJobs`; like `zellijSession`, config I/O
   * happens once on main and the resolved value rides workerData.
   */
  maxConcurrentJobs?: number | null;
  /**
   * fn-727 — completion-reap toggle. When `true` (the default), the
   * reconcile cycle reaps the zellij surface of a completed row (`work::<id>`
   * for a task, `close::<id>` for an epic — fn-756 dropped the `approve`
   * pane along with the verb). `false` makes the reap
   * pass a no-op AND skips the `list-panes` spawn. Threaded in from
   * `resolveConfig().autocloseWindows`; like `zellijSession`, config I/O
   * happens once on main and the resolved value rides workerData.
   * Restart-to-apply — a config flip lags until the next daemon restart,
   * the contract every keeper config key shares. Exposed in the payload
   * (default `true`) so hermetic tests can override it.
   */
  autocloseWindows?: boolean;
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
 * Worker → main: Dispatched mint request (fn-678, schema v50; made
 * id-correlated + durable-acked in fn-724). Main is the sole writer of
 * the synthetic event onto the events log; the worker only describes what
 * to mint. Outbox-ordered intent — the reconciler posts this BEFORE
 * invoking `launch()` so a crash between mint and the tab-spawn
 * side-effect leaves a phantom `pending_dispatches` row the producer-side
 * TTL sweep discharges via `DispatchExpired` (strictly preferable to
 * double-dispatch in the launch→SessionStart blind window the fn-674
 * live-tab probe used to cover).
 *
 * fn-724: the worker now AWAITS a durable ack BEFORE `launch()`. The
 * `id` is a per-request correlation token (a monotonic worker-local
 * counter) main echoes back on the {@link DispatchedAckMessage} reply so
 * the worker resolves the matching pending-promise. Mirrors the
 * server-worker↔main `SetAutopilotPausedRequest`/`Result` id-correlated
 * pattern (`src/server-worker.ts`).
 */
export interface DispatchedMessage {
  kind: "dispatched-request";
  id: number;
  payload: DispatchedPayload;
}

/**
 * Main → worker: durable-ack reply paired with {@link DispatchedMessage}
 * (fn-724). Sent ONLY after main has inserted (or failed to insert) the
 * `Dispatched` synthetic event on its writable connection. The `id`
 * echoes the request's correlation token; `ok` is `true` on a successful
 * insert, `false` when the insert threw. The worker's `emitDispatched`
 * Promise resolves with `{ok}` — `confirmRunning` launches only on
 * `ok:true`.
 */
export interface DispatchedAckMessage {
  type: "dispatched-ack";
  id: number;
  ok: boolean;
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

// fn-756: the `ClearRejectedApprovalMessage` worker→main wire shape (fn-742.2's
// one-shot rejected-epic auto-clear) is gone — the rejected-epic auto-clear was
// deleted along with the approval window in `.1`, and the now-unreached daemon
// RPC handler that consumed it is removed in this task (`.2`).

type IncomingMessage =
  | SetPausedMessage
  | ShutdownMessage
  | DispatchedAckMessage;
// `DispatchFailedMessage`, `DispatchedMessage`, and `DispatchExpiredMessage`
// are the outgoing wire shapes main consumes when the reconcile + dispatch
// loop is wired; the supervisor's message handler types against the same
// records. `DispatchedAckMessage` is the main→worker reply the worker keys
// against its pending-ack map (fn-724).

/**
 * Load a fresh {@link ReconcileSnapshot} from the worker's read-only
 * connection. Every collection is read through the SAME `runQuery` the
 * server-worker answers client subscriptions with, so the reconciler's
 * desired-vs-observed view matches the wire snapshot the readiness client
 * (board / viewer) sees byte-for-byte — no second decode path to drift.
 *
 * Each collection is read with NO wire filter, so each descriptor's
 * DEFAULT scope applies (epics: `status='open'` via the `default_visible = 1`
 * defaultClause; jobs: live-only `working`/`stopped`) — exactly the live work
 * set the reconciler acts on. `limit: 0` is the "all rows" sentinel.
 *
 * fn-764 — ONE deliberate exception: a SECOND epics read with an explicit
 * `filter:{status:"done"}` (which drops the defaultClause), sorted `updated_at`
 * DESC and LIMITed to {@link DONE_EPICS_REAP_LIMIT}, is MERGED into the epics
 * list (dedup by `epic_id`, the open-scope row winning on collision). Without
 * it a done epic falls off the snapshot before the fn-727 close-row COMPLETION
 * reap can observe its `{tag:"completed"}` verdict — the reap was structurally
 * unreachable. The bound keeps the merge O(limit), never O(all done history)
 * (the fn-748 anti-pattern). The merged done rows produce ONLY `completed`
 * verdicts (`evaluateCloseRow`'s `status==='done'` arm), so no dispatch arm or
 * mutex occupancy is perturbed (test-pinned).
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

  // The default-scope (open) epics — the live work set the reconciler dispatches
  // against. fn-764: MERGE in a bounded recently-DONE window so the close-row
  // completion reap is reachable (see `DONE_EPICS_REAP_LIMIT`). The done read
  // carries an explicit `filter:{status:"done"}` (drops the `default_visible = 1`
  // defaultClause), sorts `updated_at` DESC, and LIMITs to the window — O(limit),
  // never O(all done history). Dedup keys on `epic_id` with the OPEN row winning:
  // an epic can't be both open and done, so a collision is only a fold-lag/race
  // transient, and preferring the live-scope row keeps dispatch arms reading the
  // freshest open view. Done rows feed ONLY the completed close-row verdict.
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

  // fn-678 / fn-721: read `pending_dispatches` ONCE for its TWO orthogonal
  // uses. Each row represents a dispatched-but-not-yet-bound worker (minted
  // via `Dispatched` BEFORE `launch()`, discharged when `SessionStart` folds).
  //   1. `liveTabKeys` — the SAME-`(verb,id)` re-dispatch dedup arm of
  //      `reconcile()` (fn-678): suppress re-launching the same slot.
  //   2. `pendingDispatches` — the CROSS-sibling `dispatch-pending` occupant
  //      fed into `computeReadiness` (fn-721): demote a DIFFERENT ready
  //      sibling on the same epic/root. Built via the SAME shared
  //      `projectPendingDispatches` helper the board/CLI path uses, so the
  //      two readiness paths agree byte-for-byte.
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

  // fn-751 — read the autopilot `mode` from the `autopilot_state` singleton
  // and the explicitly-armed id set from the `armed_epics` presence
  // projection. PROJECTION-PULL only (no `workerData`, no `ReconcileState`
  // cache) so the gate survives a daemon restart and there is one source of
  // truth. A missing / malformed `mode` scalar defaults to `'yolo'` (the
  // work-everything baseline, matching the column's `DEFAULT 'yolo'`).
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

  const { db } = openDb(data.dbPath, { readonly: true });
  const state: ReconcileState = {
    paused: data.paused ?? true,
    inFlight: new Set(),
    // fn-735 — boots EMPTY (safe: autopilot boots paused; the first cycle
    // rebuilds suppression from the live projection). In-memory only.
    redispatchCooldown: new Map(),
    // fn-742 — per-epic finalizer guard; boots EMPTY for the same reason.
    finalizerGuard: new Map(),
    maxConcurrentJobs: data.maxConcurrentJobs ?? null,
  };
  // fn-727 — completion-reap toggle. Default `true` (reap) when the
  // supervisor didn't thread the resolved flag (e.g. a hermetic test that
  // omits it), matching `DEFAULT_AUTOCLOSE_WINDOWS`. Read once here; the
  // reap pass in `driveCycle` early-returns when it's false (no
  // `list-panes` spawn). Lives on the worker scope, NOT `ReconcileState`
  // (that struct is the pure-`reconcile` input; the reap is a side-effect
  // the cycle drives).
  const autocloseWindows = data.autocloseWindows ?? true;
  // fn-765 — completion-reap probe floor. Single mutable unix-seconds
  // stamp (the simple variant of the fn-735 cooldown): `reapCompletionSurfaces`
  // skips its `list-panes` spawn until `MIN_REAP_INTERVAL_S` has elapsed
  // since the last fired probe. Worker-scoped (a side-effect timer, NOT a
  // `reconcile` input) for the same reason `autocloseWindows` is. Boots at
  // `-Infinity` so the first eligible cycle always probes.
  let lastReapAt = Number.NEGATIVE_INFINITY;
  // `liveDispatches` tracks the in-flight surfaces this reconciler still
  // owns confirm/reap work for (keyed `${verb}::${id}`). Boots EMPTY: a
  // cold restart re-derives "already running" from the durable `jobs`
  // projection (the snapshot's occupying-job gate suppresses re-dispatch
  // of survivors), so no surface is double-launched even though
  // liveDispatches starts cold. The worker-scoped abort controller aborts
  // every in-flight confirm sleep on shutdown.
  const shutdownController = new AbortController();
  // fn-724 — pause-scoped abort. `driveCycle` passes THIS signal (not
  // `shutdownController.signal` directly) to `runReconcileCycle`, so a
  // `set-paused {paused:true}` can abort every in-flight `confirmRunning`
  // poll WITHOUT marking the worker shut down — a confirm that survived
  // the pause would keep polling a pane the reap below just closed. The
  // controller is REPLACED after each pause-abort (an aborted signal stays
  // aborted forever) so the next play-edge cycle runs against a fresh,
  // un-aborted signal. Shutdown aborts this one too (see the shutdown arm).
  let cycleController = new AbortController();
  const liveDispatches = new Map<DispatchKey, LiveDispatch>();
  let shutdown = false;
  // fn-724 — durable `dispatched-ack` correlation. `emitDispatched` posts a
  // `dispatched-request{id}` and parks a resolver in `pendingDispatchAcks`
  // keyed by the monotonic `id`; main replies `dispatched-ack{id,ok}` which
  // the message handler below resolves. The Promise also races a
  // `DISPATCHED_ACK_TIMEOUT_MS` timer and the `shutdownController` signal —
  // both REJECT the wait so `confirmRunning` aborts WITHOUT launching (a
  // phantom row from a slow-but-eventual insert is cleared by the TTL
  // sweep). On shutdown every parked resolver is rejected so no confirm
  // hangs the teardown. Mirrors the server-worker↔main `SetAutopilotPaused`
  // Request/Result id-correlated pattern.
  let nextDispatchedAckId = 1;
  const pendingDispatchAcks = new Map<
    number,
    { resolve: (ack: DispatchedAck) => void; reject: (err: Error) => void }
  >();
  // Late-bound reconcile kick. The reconciler is level-triggered on
  // `data_version` (the `watchLoop` below), but two edges have no DB write
  // to ride: (1) `play` (set-paused → false) flips an in-memory flag only,
  // and (2) a boot into an already-unpaused state. Without an explicit
  // kick, a quiescent DB leaves ready work undispatched until some
  // unrelated event happens to pulse `data_version`. `requestCycle` is
  // assigned once `driveCycle` is constructed below; it stays a no-op until
  // then (no message can arrive before `main()` finishes synchronous setup).
  let requestCycle: () => void = () => {};
  // fn-724 — late-bound pause reap. Assigned once `backend` exists below;
  // stays a no-op until then (no message can arrive before `main()`
  // finishes synchronous setup). On a `set-paused {paused:true}` the
  // handler aborts in-flight confirms then fires this to close any
  // launch-window ghost surface still parked in the managed session.
  let reapLaunchWindowSurfaces: () => void = () => {};

  parentPort.on("message", (msg: IncomingMessage | undefined) => {
    if (!msg) return;
    if (msg.type === "shutdown") {
      shutdown = true;
      shutdownController.abort();
      // Abort the pause-scoped signal too so any in-flight confirm using
      // it stops polling on teardown (it would otherwise wait on the
      // ceiling before noticing shutdown).
      cycleController.abort();
      // Reject every parked ack-wait so an in-flight `confirmRunning` that
      // launched its `emitDispatched` request before shutdown resolves
      // promptly (as `"aborted-prelaunch"`) instead of hanging until its
      // timeout.
      for (const [id, pending] of pendingDispatchAcks) {
        pendingDispatchAcks.delete(id);
        pending.reject(new Error("autopilot worker shutting down"));
      }
      return;
    }
    if (msg.type === "dispatched-ack") {
      // fn-724: durable-ack reply from main. Resolve the parked
      // `emitDispatched` Promise keyed by the correlation `id`. A
      // late/duplicate ack whose id already discharged (timeout fired
      // first) is a harmless no-op.
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
      // Pause edge (fn-724) — covers boot-pause too: the daemon's
      // boot-append re-arm relays `set-paused {paused:true}` through this
      // same handler. Abort every in-flight confirm (so a confirm doesn't
      // keep polling a surface we're about to close), swap in a fresh
      // pause-scoped controller for the next play cycle, then reap any
      // launch-window ghost surface still parked in the managed session.
      // Guarded on `paused === true` regardless of prior state (a
      // redundant pause re-issue is harmless: the abort/reap are
      // idempotent no-ops when nothing is in flight / no ghost exists).
      if (msg.paused) {
        cycleController.abort();
        cycleController = new AbortController();
        reapLaunchWindowSurfaces();
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

  // ── fn-720 backstop telemetry (timeout class) ──────────────────────────────
  // The autopilot `confirmRunning` ceiling is a `timeout`-class backstop — it
  // measures elapsed-since-dispatch, has NO fast-path notion (so the record
  // carries `fast_path:null` / `last_fast_path_at:null`), and already emits a
  // `DispatchFailed` on ceiling-hit. This adds the uniform telemetry record
  // ALONGSIDE that emit without changing dispatch behavior: every confirm bumps
  // the counter (a pre-ceiling confirm as `rescued:false`, the denominator; a
  // ceiling-hit as `rescued:true`, the numerator), and a rescue ALSO posts the
  // `buildTimeoutRecord` line up to main (the SOLE sidecar writer). A periodic
  // + on-shutdown rollup flushes the denominator so a slow worker's metric
  // survives without a line per no-op confirm.
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
    // fn-756: the fn-742.2 `emitClearRejectedApproval` sender is removed — no
    // close row is ever `job-rejected`, so the worker never requests an
    // auto-clear. The daemon-side handler stays (removed in task `.2`).
    emitDispatched: (payload) =>
      new Promise<DispatchedAck>((resolve, reject) => {
        // fn-724: post an id-correlated request and AWAIT main's durable
        // insert ack. Reject (→ `confirmRunning` aborts without launching)
        // if the ack never arrives within DISPATCHED_ACK_TIMEOUT_MS — a
        // floor chosen ABOVE busy_timeout (5s) + a boot drain so a dispatch
        // fired during the boot drain (when main's writable connection may
        // block a full busy_timeout on the WAL writer lock) does NOT
        // false-abort. Also reject on an already-aborted shutdown signal.
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

  // fn-724 — pause/boot-pause launch-window reap. Close zellij surfaces
  // for a pre-pause dispatch intent (zellij execs the queued `new-tab`
  // seconds-to-minutes late) so it can't escape the pause boundary as a
  // ghost worker. SAFETY (highest blast radius): the candidate predicate
  // intersects the verb-prefixed pane name with the OPEN
  // `pending_dispatches` set — a row already discharged by SessionStart =
  // a LIVE worker = NEVER reaped. The name match alone never authorizes a
  // close (list-panes lags zellij reality). Bound here now that `backend`
  // exists; the message handler above calls it on the pause edge AFTER
  // aborting in-flight confirms.
  //
  // The whole body is try/caught — a reap throw must NOT propagate (it
  // would crash the worker and bounce the daemon, per no-self-heal).
  // `backend.reapSurfaces` is itself never-throw; this catch is the
  // belt-and-suspenders backstop for the snapshot query / predicate.
  reapLaunchWindowSurfaces = (): void => {
    void (async (): Promise<void> => {
      try {
        // Open-pending set: every row currently in `pending_dispatches`
        // (SessionStart DELETEs a row on bind, so a present row is an
        // OPEN, not-yet-bound dispatch). Keyed `${verb}::${id}` to match
        // `dispatchKeyForPane`.
        const openKeys = new Set<DispatchKey>();
        for (const row of db
          .query("SELECT verb, id FROM pending_dispatches")
          .all() as Array<{ verb: unknown; id: unknown }>) {
          if (typeof row.verb === "string" && typeof row.id === "string") {
            openKeys.add(dispatchKey(row.verb as Verb, row.id));
          }
        }
        // Nothing pending → no launch-window ghost to reap; skip the
        // list-panes spawn entirely.
        if (openKeys.size === 0) {
          return;
        }
        // CANDIDATE = verb-prefixed name AND an OPEN pending row. A
        // discharged (missing) row means SessionStart bound a live worker
        // — never reap it. The predicate is the shared pure
        // `isReapCandidate` so the worker + tests pin the same gate.
        const result = await backend.reapSurfaces((pane) =>
          isReapCandidate(openKeys, pane),
        );
        if (result.reaped > 0 || result.failed > 0) {
          console.error(
            `[autopilot-worker] pause reap: examined=${result.examined} reaped=${result.reaped} failed=${result.failed}`,
          );
        }
      } catch (err) {
        console.error("[autopilot-worker] pause reap threw (non-fatal):", err);
      }
    })();
  };

  // fn-727 — completion reap. Distinct from the pause/boot reap above:
  // that one gates on the OPEN `pending_dispatches` intersect (a
  // not-yet-bound launch-window ghost); THIS one gates on the durable
  // completion verdict surfaced by `reconcile` this cycle. When a row
  // reaches `{tag:"completed"}` (fn-756: worker_phase done for a task,
  // status done for an epic, + idle), every live surface sharing that row's
  // id is reaped: a task completion reaps `work::<id>`; an epic close-row
  // completion reaps `close::<id>` (no `approve::<id>` surface exists — the
  // approve verb is gone). Not-yet-completed and just-worker-ended surfaces
  // stay open — they never reach `{tag:"completed"}`, so their ids are never
  // in `completedRowIds`.
  //
  // Built on the SURVIVING live-probe path (`reapSurfaces` +
  // `buildZellijClosePaneArgs`), NOT the torn-out fn-710 jobs-row
  // tab-coord path. The reap re-probes live `list-panes` every cycle
  // (level-triggered on `data_version`); it persists no pane ids and
  // survives a daemon restart — the verdict, not a cold-boot
  // `liveDispatches`, drives it. SAFETY divergence (no `is_exited` gate)
  // documented on `isCompletionReapCandidate`.
  //
  // Structurally mirrors `reapLaunchWindowSurfaces`: early-return (skip the
  // `list-panes` spawn) when `autocloseWindows` is false OR the completed
  // set is empty; else `reapSurfaces` with the completion predicate; log
  // examined/reaped/failed; the whole body is try/caught so a throw never
  // propagates (a throw would crash the worker and bounce the daemon, per
  // no-self-heal). `backend.reapSurfaces` is itself never-throw; this catch
  // is the belt-and-suspenders backstop for the predicate.
  const reapCompletionSurfaces = (completedRowIds: Set<string>): void => {
    // Flag off → no-op AND no `list-panes` spawn (restart-to-apply: the
    // flag is frozen at spawn). Empty completed set → no ghost to reap.
    if (!autocloseWindows || completedRowIds.size === 0) {
      return;
    }
    // fn-765 — floor the probe: skip the `list-panes` spawn until the
    // min interval has elapsed since the last fired probe. Stamp BEFORE
    // the async spawn so a burst of pulses inside one cycle's microtask
    // queue still collapses to a single probe. Reap stays idempotent and
    // the fn-764 done-window outlasts this floor, so nothing is missed.
    const nowS = deps.now();
    if (!reapFloorElapsed(lastReapAt, nowS)) {
      return;
    }
    lastReapAt = nowS;
    void (async (): Promise<void> => {
      try {
        const result = await backend.reapSurfaces((pane) =>
          isCompletionReapCandidate(completedRowIds, pane),
        );
        if (result.reaped > 0 || result.failed > 0) {
          console.error(
            `[autopilot-worker] completion reap: examined=${result.examined} reaped=${result.reaped} failed=${result.failed}`,
          );
        }
      } catch (err) {
        console.error(
          "[autopilot-worker] completion reap threw (non-fatal):",
          err,
        );
      }
    })();
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
        // fn-735 — prune expired cooldown entries each cycle (mirror
        // `reapStuckPending`). Wrapped so a sweep throw can't crash the
        // worker and bounce the daemon (no self-heal). Runs BEFORE
        // `reconcile` reads the Map so a just-expired key is re-dispatchable
        // this very cycle.
        try {
          sweepRedispatchCooldown(state.redispatchCooldown, deps.now());
        } catch (err) {
          console.error(
            "[autopilot-worker] cooldown sweep threw (non-fatal):",
            err,
          );
        }
        // fn-742 — prune expired per-epic finalizer-guard entries each cycle
        // (mirror the cooldown sweep). Wrapped: a sweep throw must not crash
        // the worker and bounce the daemon (no self-heal). Runs BEFORE
        // `reconcile` reads the Map so a just-expired epic is re-dispatchable
        // this very cycle.
        try {
          sweepFinalizerGuard(state.finalizerGuard, deps.now());
        } catch (err) {
          console.error(
            "[autopilot-worker] finalizer-guard sweep threw (non-fatal):",
            err,
          );
        }
        const decision = reconcile(snapshot, state, deps.now());
        // fn-727 — fire the completion reap with THIS cycle's approved-
        // completion set (recomputed every cycle from the one readiness
        // pass `reconcile` made — no second `computeReadiness`). Fire-and-
        // forget: it owns its own try/catch and never throws past itself,
        // so it never blocks or wedges the dispatch stagger below.
        reapCompletionSurfaces(decision.completedRowIds);
        // fn-756: the fn-742.2 rejected-epic auto-clear recovery is removed —
        // no close row is ever `job-rejected`, so there is nothing to recover.
        await runReconcileCycle(
          decision,
          state,
          liveDispatches,
          shell,
          // fn-724: the pause-scoped signal — a `set-paused {paused:true}`
          // aborts every in-flight confirm here (and shutdown aborts it
          // too). Captured per-cycle so a mid-cycle pause-abort + fresh
          // controller doesn't retroactively un-abort this run.
          cycleController.signal,
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

  // fn-720: periodic backstop-rollup flush — checkpoint the denominator
  // (fires_total / rescues_total) so the metric survives a crash without a
  // line per no-op confirm. Final-flushed on either watch-loop exit below.
  const rollupTimer = setInterval(() => {
    if (shutdown) return;
    try {
      flushBackstopRollups();
    } catch (err) {
      console.error("[autopilot-worker] backstop rollup flush failed:", err);
    }
  }, BACKSTOP_ROLLUP_FLUSH_MS);

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

// Only run the loop when actually executing inside a Worker. A plain
// `import` from a test runs on the main thread, where `main()` must
// not fire — the pure `reconcile` / `confirmRunning` symbols are
// driven directly by the test suite.
if (!isMainThread) {
  main();
}

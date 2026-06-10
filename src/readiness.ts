/**
 * Pure readiness pipeline — given a snapshot of the `epics`, `jobs`, and
 * `subagent_invocations` projections, returns a per-row verdict map for the
 * board UI's `[ready]` / `[completed]` / `[blocked:<reason>]` pill.
 *
 * Why a separate module: the same pure function is the contract for both the
 * board UI render path AND a future autopilot dispatch path. Keeping it pure
 * (no I/O, no `Date.now()`, no closure over external state) lets a test
 * fixture pin a verdict for a given snapshot, and lets autopilot consume the
 * verdict's discriminated-union tag without parsing strings.
 *
 * Predicate pipeline — first-match-wins, ordered checks per row. fn-756
 * removed the approval-gated checks (old predicates 4 own-approval-rejected,
 * 6.5 git-cleanliness, 7 own-approval-pending); completion is now a single
 * signal — worker-done for tasks, status-done for epics:
 *   1. terminal-completed          — task (fn-756): worker_phase==="done"
 *                                    AND no embedded job is `working` AND no
 *                                    running sub-agent under any embedded job.
 *                                    The two liveness clauses hold the verdict
 *                                    at `running:*` (predicate 5/6) until the
 *                                    Claude session is genuinely idle, so the
 *                                    per-epic and per-root mutexes stay held
 *                                    while the worker is still alive.
 *                                    close: epic.status==="done"
 *   2. epic-not-validated          — parent epic.last_validated_at == null
 *   3. planner-running             — any epic.job_links entry whose job is `working`
 *   4. own-approval-rejected       — REMOVED (fn-756). The approval enum no
 *                                    longer gates; the field is still present
 *                                    on the projection but read by no gate.
 *   5. own-progress-main           — task: any embedded jobs[] entry on this row state==="working"
 *                                    close: any embedded jobs[] entry on the epic OR on any ALREADY-COMPLETED
 *                                    task state==="working" (completed-scoped fan-in — see `evaluateCloseRow`)
 *   6. own-progress-sub            — task: any subagentInvocations row job_id===<this row's worker.session_id>
 *                                    && status==="running"
 *                                    close: same predicate but joined against worker session ids from
 *                                    epic-level AND every ALREADY-COMPLETED task's embedded jobs[]
 *   6.5. git-uncommitted / git-orphans
 *                                  — REMOVED (fn-756). This was the fn-703
 *                                    git-cleanliness lift that gated the now-
 *                                    deleted `/plan:approve` dispatch on a clean
 *                                    worktree. With the approval window gone the
 *                                    lift is dead; the worker commits its own
 *                                    work before yielding (`keeper commit-work`).
 *   7. own-approval-pending        — REMOVED (fn-756). Predicate 1 marks the
 *                                    row `completed` on the worker-/status-done
 *                                    signal alone, so there is no `job-pending`
 *                                    window and no approval-pending notify.
 *   8. dep-on-task                 — any depends_on upstream NOT { tag:"completed" }
 *   9. dep-on-epic                 — any depends_on_epics upstream's close NOT completed
 *  10. dep-on-task-synthetic-close — for the synthetic close row: any non-completed task
 *  11. single-task-per-epic        — post-pass: one non-completed slot per epic
 *                                    Occupancy keys on `isLiveWorkOccupant`, which
 *                                    INCLUDES `planner-running` — a planner blocks its
 *                                    OWN epic from dispatching sibling tasks — and
 *                                    `dispatch-pending` (a launched-but-unbound
 *                                    worker). fn-756 dropped the approval-pending
 *                                    occupancy arm (`job-pending` + the fn-703 git
 *                                    verdicts) along with the approval window.
 *  12. single-task-per-root        — post-pass: one non-completed slot per project root
 *                                    Occupancy keys on `isRootOccupant`, which EXCLUDES
 *                                    `planner-running` (fn-663) — a planner does NOT
 *                                    claim the root, so a sibling epic's ready task on
 *                                    the same root may dispatch concurrently with a
 *                                    planner. Real workers (job-running,
 *                                    sub-agent-running, sub-agent-stale) and
 *                                    `dispatch-pending` still claim.
 *                                    Per-epic and per-root therefore diverge on
 *                                    `planner-running`: blocking inside the planner's
 *                                    own epic, exempt across the rest of the root.
 *
 * The two post-passes (11, 12) run in that order — per-epic FIRST so its
 * tighter scope wins the reason when both would apply. Both share one
 * algorithmic shape: walk in board traversal order, the FIRST non-completed
 * row claims the slot, every LATER row whose verdict is `ready` in that
 * same slot gets mutated to the corresponding blocked reason. Rows already
 * blocked by reasons 1–10 stay with their (more specific) reason; only
 * `ready` rows are mutated. The "occupant" check counts ANY non-completed
 * verdict (working, blocked-by-anything, ready) — so a sibling task that
 * is actively `job-running` or `sub-agent-running` in the same epic/root
 * still blocks later ready rows. Iteration order is the only determinism
 * gate.
 *
 * Epic header rollup (after per-row + both post-passes):
 *   - `[completed]`         if close row verdict is `{ tag: "completed" }`.
 *   - `[ready]`             if any task or close row verdict is `{ tag: "ready" }`.
 *   - `[running:<kind>]`    if any task or close row verdict is `{ tag: "running" }`
 *                           (priority slots between `ready` and `blocked`).
 *   - Otherwise `[blocked:<first non-completed row's reason in traversal order>]`.
 */

import {
  type EpicDepResolution,
  resolveEpicDep as resolveEpicDepLeaf,
} from "./epic-deps";
import type { ResolutionDiagnostic } from "./readiness-diagnostics";
import type { Epic, Job, SubagentInvocation, Task } from "./types";

// Re-export so existing import sites (`scripts/board.ts` and any other
// consumer that pulled `EpicDepResolution` / `resolveEpicDep` from
// `readiness.ts`) keep working without a rename rippling outside this
// extraction. The canonical home is `./epic-deps`; this is a thin
// compat surface.
export type { EpicDepResolution };

/**
 * Wall-clock-bound wrapper around the fold-safe `resolveEpicDep` in
 * `./epic-deps`. Existing readiness/board callers expected the resolver
 * to stamp diagnostics with the current wall-clock time; preserve that
 * exact behavior by passing `new Date().toISOString()` here. The reducer
 * caller (fn-637.3) goes straight to `./epic-deps#resolveEpicDep` with
 * an event-derived timestamp so its fold stays deterministic.
 */
export function resolveEpicDep(
  rawDep: string,
  consumer: Epic,
  epicById: Map<string, Epic>,
  epicsByNumber: Map<number, Epic[]>,
  diagnostics: ResolutionDiagnostic[],
): EpicDepResolution {
  return resolveEpicDepLeaf(
    rawDep,
    consumer,
    epicById,
    epicsByNumber,
    diagnostics,
    new Date().toISOString(),
  );
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Structured block reason — discriminated union with structured payloads so
 * consumers can branch on `kind` without parsing strings.
 *
 * - `job-rejected` / `job-pending`     — RETAINED-BUT-UNPRODUCED (fn-756). These were this row's own
 *                                        approval state (predicates 4 and 7); the approval window is
 *                                        gone, so no predicate emits them. The kinds stay in the union
 *                                        (label/pill plumbing — removed in the schema-drop task `.2`).
 * - `epic-not-validated`               — parent epic has no `last_validated_at`.
 * - `git-uncommitted` / `git-orphans`  — RETAINED-BUT-UNPRODUCED (fn-756). These were the fn-703
 *                                        git-cleanliness gate at rank 6.5 that blocked the now-deleted
 *                                        `/plan:approve` dispatch on a dirty worktree. With the
 *                                        approval window gone, predicate 6.5 is deleted and no path
 *                                        emits these kinds. They stay in the union for label/pill
 *                                        plumbing — removed in the schema-drop task `.2`.
 * - `dep-on-task`                      — an upstream task is not completed (carries the upstream id).
 * - `dep-on-epic`                      — an upstream epic's close is not completed. Carries the
 *                                        resolved full epic id as `upstream`. When the upstream's
 *                                        `project_dir` basename differs from the consumer's, the
 *                                        optional `cross_project` field carries the upstream's
 *                                        project basename so the renderer can prefix the pill
 *                                        `dep-on-epic <project>::<id>`; `null` for intra-project
 *                                        deps. The `upstream` field stays a literal id so
 *                                        consumers can use it for lookup without re-parsing.
 * - `dep-on-epic-dangling`             — a `depends_on_epics` entry could not be resolved against
 *                                        the input snapshot. Three sources: a full-id miss
 *                                        (`fn-100-foo` not in `epicById`), a bare-id miss
 *                                        (`fn-100` matched no epic in `epicsByNumber`), or a
 *                                        bare-id ambiguity (2+ matches, no same-project match
 *                                        disambiguates) — the ambiguity case ALSO emits a
 *                                        {@link ResolutionDiagnostic} so the human sees which
 *                                        candidates collided. Red pill (autopilot's structural
 *                                        problem signal), distinct from the amber `dep-on-epic`.
 * - `single-task-per-epic`             — lost the per-epic mutex (a sibling row in the same epic is non-completed).
 * - `single-task-per-root`             — lost the per-root mutex (a row in another epic in the same project root is non-completed).
 * - `epic-no-tasks`                    — close-row only: the epic has ZERO tasks (the partial-projection
 *                                        window between an `EpicSnapshot` and its first `TaskSnapshot`
 *                                        fold). Predicate 10's `for…of epic.tasks` loop is vacuously
 *                                        true over an empty list, so the close row would otherwise fall
 *                                        through to `ready` and the autopilot would dispatch a closer
 *                                        against an epic with no work (the fn-698 incident). Placed at
 *                                        rank 9.5 (after every more-specific verdict, before predicate
 *                                        10) so it catches ONLY that vacuous fall-through. Payload-less.
 * - `epic-not-materialized`            — the epic's `status` is NULL ⇔ no `EpicSnapshot` has folded yet
 *                                        (the shell row a scaffold commit mints before its real
 *                                        snapshot lands; status is set non-null at exactly ONE reducer
 *                                        site — the EpicSnapshot UPSERT). The EARLIEST predicate on both
 *                                        the per-task and per-close-row paths (ranks above
 *                                        `epic-not-validated`), so a freshly-scaffolded epic is
 *                                        non-dispatchable (worker AND closer) until it materializes. The
 *                                        same `status IS NOT NULL` notion that the board's
 *                                        `default_visible` column uses to hide the shell row (fn-712) —
 *                                        one shared predicate, both surfaces wait for the same state.
 *                                        Payload-less.
 * - `dispatch-pending`                 — a worker autopilot LAUNCHED against this row but whose
 *                                        `SessionStart` has not folded yet — i.e. an open
 *                                        `pending_dispatches` row (schema v50, fn-678) keyed
 *                                        `work::<task_id>` / `approve::<task_id>` (task path) or
 *                                        `close::<epic_id>` (close-row path) exists. The launch →
 *                                        SessionStart blind window has no `jobs` row yet, so the only
 *                                        durable signal that the slot is taken is this projection.
 *                                        Set at a LATE per-row rank (after every real `running` /
 *                                        structural-not-ready / dep verdict — those still win — but
 *                                        BEFORE the post-pass mutexes) so it occupies BOTH the per-epic
 *                                        and per-root mutex via `isLiveWorkOccupant` (→ auto-covers
 *                                        `isRootOccupant`), demoting a same-epic OR same-root ready
 *                                        sibling to `single-task-per-*`. Non-dispatchable
 *                                        (`verbForVerdict → null`) and self-resolving (the row
 *                                        discharges on SessionStart bind / DispatchFailed /
 *                                        DispatchExpired), so it is `waiting`, NOT stuck (fn-721).
 *                                        Payload-less.
 * - `unknown`                          — defensive default for verdict/renderer mismatch.
 */
export type BlockReason =
  | { kind: "job-rejected" }
  | { kind: "job-pending" }
  | { kind: "epic-not-materialized" }
  | { kind: "epic-not-validated" }
  | { kind: "git-uncommitted" }
  | { kind: "git-orphans" }
  | { kind: "dep-on-task"; upstream: string }
  | { kind: "dep-on-epic"; upstream: string; cross_project: string | null }
  | { kind: "dep-on-epic-dangling"; upstream: string }
  | { kind: "single-task-per-epic" }
  | { kind: "single-task-per-root" }
  | { kind: "epic-no-tasks" }
  | { kind: "dispatch-pending" }
  | { kind: "unknown" };

/**
 * The four "in-motion" reasons split out of `BlockReason` into the
 * sibling `running` Verdict tag. A `running` verdict means the row has a
 * live worker / sub-agent / planner session actively in motion — distinct
 * from a `blocked` verdict, which means the row is stuck waiting on a
 * dependency, approval, repo state, or mutex.
 *
 * `sub-agent-stale` (fn-638.4) is the visibility affordance for a
 * still-`running` sub-agent invocation whose start age exceeds
 * `SUBAGENT_STALENESS_SEC` relative to the caller-injected `now`. It is a
 * SUPPLEMENT to the reducer's bounded Stop guard (fn-638.1), not a
 * replacement: the reducer releases the worker's `working` state once the
 * Stop event's `ts` is past the same window, which clears predicate 5; a
 * sub-agent that survives that release because Stop never fired
 * (autopilot-spawned `claude` exited without a Stop hook, or the
 * sub-agent's parent session is orphaned) keeps predicate 6 firing
 * `sub-agent-running` indefinitely. This variant makes the
 * possibly-stuck condition visible on the board so a human can see WHAT
 * is holding a gate instead of seeing a wedged autopilot. The threshold
 * mirrors `MAX_STOP_YIELD_GAP_SEC` (120s) so the two definitions stay
 * aligned — once the bounded Stop guard would have considered the
 * sub-agent old enough to bypass, this predicate surfaces the same row
 * as stale. Aligns with `collapseSubagentsByName`'s client-side
 * "stuck-orphan" notion in convergent intent: the client labels the
 * structurally-stuck rows (older turn_seq superseded but still running),
 * this predicate labels them temporally (older than the freshness
 * window) — both flag the same orphaned-running rows in practice.
 */
export type RunningReason =
  | { kind: "job-running" }
  | { kind: "sub-agent-running" }
  | { kind: "sub-agent-stale" }
  | { kind: "monitor-running" }
  | { kind: "monitor-stale" }
  | { kind: "planner-running" };

/**
 * Staleness threshold for the `sub-agent-stale` `RunningReason` variant
 * (fn-638.4). A still-`running` sub-agent whose `ts` is older than the
 * caller-injected `now` by strictly more than this many seconds renders
 * as `sub-agent-stale` instead of `sub-agent-running`. Value mirrors
 * `MAX_STOP_YIELD_GAP_SEC` in `src/reducer.ts` (the bounded Stop guard
 * window): once the reducer would have considered the sub-agent old
 * enough to bypass on a Stop event, this predicate surfaces the same row
 * as stale so the board pill and the autopilot release-window agree on
 * the same row population. Held as a local constant (not imported from
 * `reducer.ts`) so the readiness module stays leaf-ish — both
 * definitions live as bare numeric constants with cross-refs in their
 * docstrings, drifting one without the other surfaces in
 * `test/reducer.test.ts` + `test/readiness.test.ts` together.
 *
 * Determinism: the comparison `now - inv.ts > SUBAGENT_STALENESS_SEC` is
 * a pure function of the injected `now` and the projection's `ts` field
 * — no `Date.now()` here, just like the reducer's bounded Stop guard.
 * Callers in the live path (`subscribeReadiness` → `computeReadiness`)
 * supply `Math.floor(Date.now()/1000)` per snapshot; the autopilot
 * simulator and tests that don't care pass `Number.NEGATIVE_INFINITY`
 * (the parameter's default) so the staleness branch never fires for
 * them. Re-fold determinism does not apply here — this is a CLIENT
 * computation over the live projection, not a reducer fold. The two
 * worlds are deliberately separate: the reducer's bounded Stop guard
 * (fold-time, event-`ts`-driven) does the WORK of releasing the worker;
 * this predicate does the VISIBILITY work of telling a human why a
 * surviving sub-agent is suspect.
 */
export const SUBAGENT_STALENESS_SEC = 120;

/**
 * Soft staleness lease for the `monitor-running` → `monitor-stale`
 * `RunningReason` split (fn-719 task 2). A task whose embedded work job
 * carries the task-1 `has_live_worker_monitor` fact occupies the per-epic /
 * per-root mutex; once the freshest occupying embedded job's `updated_at` is
 * older than the caller-injected `now` by strictly more than this many
 * seconds, the verdict surfaces `monitor-stale` instead of `monitor-running`
 * — STILL occupying (a human-visible "this slot's monitor may be abandoned"
 * affordance), but flagged.
 *
 * Lease, NOT heartbeat (the Temporal `HeartbeatTimeout` discipline): the
 * anchor is the embedded job's `updated_at`, which bumps on every job-tick /
 * turn-end seam — NOT the backgrounded suite's own runtime. A multi-hour
 * suite still re-stamps `updated_at` once per agent turn-end, so this lease
 * is calibrated to the gap between turn-ends (a few minutes), with a 3–5×
 * safety factor — 600s (10 min) ≈ a generous turn-end cadence × ~5. Too
 * short would false-kill a legitimately long, quietly-running suite; the
 * hard ceiling {@link MONITOR_RELEASE_SEC} below catches the genuinely
 * abandoned case.
 *
 * Determinism: the comparison `now - updated_at > MONITOR_STALENESS_SEC` is a
 * pure function of the injected `now` and the embedded element's `updated_at`
 * — read-time, NEVER folded (the sanctioned re-fold-determinism exception,
 * mirroring {@link SUBAGENT_STALENESS_SEC}). Live callers pass
 * `Math.floor(Date.now()/1000)`; the autopilot simulator and don't-care tests
 * pass `Number.NEGATIVE_INFINITY` (the parameter default) so the staleness /
 * release branches never fire for them.
 */
export const MONITOR_STALENESS_SEC = 600;

/**
 * Hard release ceiling for a live-worker-monitor occupant (fn-719 task 2).
 * The second of the two lease knobs ("whichever fires first"): once the
 * freshest occupying embedded job's `updated_at` is older than the injected
 * `now` by strictly more than this many seconds, the monitor fact NO LONGER
 * occupies the mutex at all — the slot is released so a stopped-but-abandoned
 * session can't wedge it forever (a single long "to-be-safe" TTL becomes a
 * dead resource lock; the soft TTL above gives visibility, this ceiling
 * guarantees liveness). 1800s (30 min) ≫ MONITOR_STALENESS_SEC so the
 * `monitor-stale` window is wide enough to be seen before the slot frees.
 *
 * Terminal `ended`/`killed` already clears the fact for free (task 1 forces
 * `has_live_worker_monitor=false` on SessionEnd/Killed), so this ceiling only
 * matters for a session that Stopped, was approved, but whose Stop snapshot
 * still listed a live monitor that then never updated — the genuinely-
 * abandoned slot. Same read-time / never-folded determinism as
 * {@link MONITOR_STALENESS_SEC}.
 */
export const MONITOR_RELEASE_SEC = 1800;

export type Verdict =
  | { tag: "ready" }
  | { tag: "completed" }
  | { tag: "blocked"; reason: BlockReason }
  | { tag: "running"; reason: RunningReason };

/**
 * The full readiness snapshot — per-task, per-close-row (keyed by epic_id),
 * and per-epic-header (also keyed by epic_id). Renderer-side lookups that
 * miss should render `[blocked:unknown]` — visible (bug indicator) and inert
 * (autopilot won't dispatch on `unknown`).
 *
 * `diagnostics` carries structured side-band output from the resolver — today
 * just `ambiguous-dep-resolution` rows for bare `fn-N` epic deps that matched
 * 2+ epics with no same-project disambiguator. Side-effecting consumers
 * (`scripts/board.ts`, `scripts/autopilot.ts`) drain this array per snapshot
 * and append each entry to `~/.local/state/keeper/readiness-diagnostics.jsonl`
 * via {@link appendDiagnostic}. Pure-function consumers (tests, the autopilot
 * simulator) read it for assertions or ignore it. `computeReadiness` itself
 * never performs I/O.
 */
export interface ReadinessSnapshot {
  perTask: Map<string, Verdict>;
  perCloseRow: Map<string, Verdict>;
  perEpic: Map<string, Verdict>;
  diagnostics: ResolutionDiagnostic[];
}

/**
 * A single open `pending_dispatches` row (schema v50, fn-678) projected into
 * the plain shape `computeReadiness` consumes for the `dispatch-pending`
 * occupant (fn-721). Deliberately a STRUCTURAL type, NOT autopilot's
 * `DispatchKey` / `Verb` — `src/readiness.ts` is the import LEAF
 * (`readiness-client.ts` and `autopilot-worker.ts` import it, never the
 * reverse), so it cannot reference autopilot's vocabulary. `computeReadiness`
 * constructs the canonical `verb::id` key locally.
 *
 * - `verb` / `id`     — the `(verb, id)` composite pk of the row. Matched
 *                       against `work::<task_id>` / `approve::<task_id>` per
 *                       task and `close::<epic_id>` per close row.
 * - `dir`             — the row's launch directory (the `pending_dispatches.dir`
 *                       column, nullable). Used ONLY for the root-fallback: a
 *                       pending row matching no snapshot row occupies this `dir`
 *                       as a per-root mutex slot. A null `dir` contributes no
 *                       root occupant (degrades safely — the row's TTL/discharge
 *                       still clears it).
 *
 * A shared projection helper at/below the client layer
 * (`projectPendingDispatches` in `src/readiness-client.ts`, mirroring
 * `projectGitStatusByProjectDir`) is the SOLE builder of this shape, imported
 * by BOTH consumers (the autopilot reconciler and `subscribeReadiness`) so the
 * two paths never diverge.
 */
export type PendingDispatch = { verb: string; id: string; dir: string | null };

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Pure entry. Walks `epics` in iteration order (the caller is responsible
 * for handing in a deterministically-ordered map — typically the board's
 * `epics.order`-indexed `byId`). For each epic, builds per-task verdicts
 * via the 11-predicate pipeline (first-match-wins), then the synthetic
 * close-row verdict, then the epic header rollup. After the per-row pass,
 * `applySingleTaskPerEpicMutex` and `applySingleTaskPerRootMutex` mutate
 * the verdict maps for the two post-pass mutex predicates (in that order
 * — tighter scope reported first when both would apply).
 *
 * Inputs are keyed by id; both maps and arrays are accepted (an iterable
 * with stable order suffices). The function never mutates its inputs.
 */
export function computeReadiness(
  epics: Iterable<Epic>,
  jobs: Map<string, Job>,
  subagentInvocations: Iterable<SubagentInvocation>,
  // Project-wide git status keyed by `project_dir`. The task arm of
  // predicate 6.5 looks up `task.target_repo ?? epic.project_dir` (same
  // root-resolution shape `effectiveRoot` uses for the per-root mutex);
  // the close-row arm looks up `epic.project_dir` directly. Defaults to an
  // empty map so callers that don't subscribe to `git_status` (today: the
  // autopilot simulator, hand-rolled test fixtures) preserve the pre-fix
  // "predicate 6.5 doesn't fire" semantics. Replaces the schema-v21
  // per-job `git_dirty_count`/`git_orphan_count` read off the freshest
  // embedded worker job — those columns only refresh while the job is in
  // `state IN ('working','stopped')` and freeze on terminal transition,
  // so the live `git_status` row is the honest source of truth.
  //
  // Schema-v31 column-name-vs-reason-kind divergence: the field
  // `unattributed_to_live_count` on this map sources the schema-v31
  // `jobs.git_unattributed_to_live_count` column (renamed from the
  // legacy v28 `git_orphan_count`; same value, more honest name — "dirty
  // files no LIVE session is on the hook for"). The block-reason kind is
  // STILL `git-orphans` because autopilot's reason enumeration
  // (`scripts/autopilot.ts:230,238,449`) consumes the literal string
  // `"git-orphans"`; flipping the kind would ripple through every
  // consumer without semantic benefit. The new strict-mystery
  // `git_orphan_count` column (files with ZERO active attribution from
  // any session past or present) is informational only at v31 — not
  // projected into this map, not consulted by any predicate. If
  // strict-mystery ever needs to block, that's a separate refinement.
  gitStatusByProjectDir: Map<
    string,
    { dirty_count: number; unattributed_to_live_count: number }
  > = new Map(),
  // fn-638.4: caller-injected reference timestamp (unix seconds) for the
  // `sub-agent-stale` `RunningReason` variant — a still-`running` sub-agent
  // invocation whose `ts` is older than `now - SUBAGENT_STALENESS_SEC`
  // surfaces as `sub-agent-stale` instead of `sub-agent-running`. Mirrors
  // the injected-timestamp pattern fn-637.1 established in `epic-deps.ts`
  // for `resolveEpicDep`: the pure readiness pass never reads `Date.now()`;
  // the live client (`subscribeReadiness`) supplies
  // `Math.floor(Date.now()/1000)` per snapshot. The autopilot simulator and
  // hand-rolled tests that don't model running sub-agents pass the default
  // `Number.NEGATIVE_INFINITY` so the staleness branch can never fire for
  // them (`-Infinity - inv.ts > threshold` is always false). This is a
  // CLIENT computation distinct from the reducer fold (the bounded Stop
  // guard at `src/reducer.ts:MAX_STOP_YIELD_GAP_SEC` does the WORK of
  // releasing the worker; this predicate does the VISIBILITY work of
  // surfacing a sub-agent that survives that release).
  now: number = Number.NEGATIVE_INFINITY,
  // fn-721: the open `pending_dispatches` rows (schema v50, fn-678) — workers
  // autopilot LAUNCHED but whose `SessionStart` has not folded yet. Appended
  // AFTER `now` (low blast radius — the 9+ call sites that rely on defaults
  // stay valid; the simulator/preview paths in `cli/autopilot.ts` pass `[]`,
  // correctly modelling "no launch-window occupancy in a what-if"). Each row
  // is matched to a task (`work::<id>` / `approve::<id>`) or close row
  // (`close::<id>`) and sets the `dispatch-pending` occupant verdict on THAT
  // row at a LATE per-row rank (below every real `running` / structural /
  // dep verdict, above the post-pass mutexes), so the launch → SessionStart
  // blind window holds BOTH the per-epic and per-root mutex via
  // `isLiveWorkOccupant` (→ auto-covers `isRootOccupant`). A row matching NO
  // snapshot row falls back to occupying its own `dir` root (decision b) —
  // seeded into `applySingleTaskPerRootMutex` outside the per-row walk so the
  // launch→materialize lag + deleted-target window stays covered. Built by
  // the SOLE shared helper `projectPendingDispatches` so both consumers (the
  // autopilot reconciler and `subscribeReadiness`) build it identically.
  // Default `[]` so the pre-fn-721 "no launch-window occupancy" semantics
  // hold for callers that don't subscribe to `pending_dispatches`.
  pendingDispatches: PendingDispatch[] = [],
  // fn-770: autopilot `armed`-mode eligibility, threaded verbatim into the
  // per-root mutex's discretionary pass-2 ready-tiebreak (see
  // `applySingleTaskPerRootMutex`). ABSENT (`undefined`) — what every
  // yolo-mode / test / simulator caller gets by omitting it — preserves the
  // byte-identical legacy single-pass. PROVIDED (even EMPTY) selects the
  // eligible-priority two-pass: an armed (eligible) epic wins a free root over
  // an earlier-sorted unarmed sibling, fixing the armed-mode deadlock where an
  // ineligible epic captured the root slot and the reconcile gate then
  // suppressed the eligible epic's `work` launch. The caller (the reconciler)
  // computes the closure once per cycle via `computeEligibleEpics` and passes
  // the SAME set here and to its own armed gate; readiness stays an import
  // LEAF and never derives the closure itself. Appended LAST so the existing
  // default-reliant call sites stay valid.
  eligibleEpicIds?: Set<string>,
): ReadinessSnapshot {
  // fn-721: index the pending dispatches by their canonical `verb::id` key
  // (the SAME `${verb}::${id}` shape `dispatchKey` builds in autopilot, but
  // constructed locally — readiness is the import LEAF and must not reference
  // autopilot's vocabulary). The per-row evaluators consume `pendingKeys` and
  // record every key they MATCH into `matchedPendingKeys`, so the unmatched
  // remainder drives the root-fallback after the per-row walk.
  const pendingKeys = new Set<string>();
  for (const pd of pendingDispatches) {
    pendingKeys.add(`${pd.verb}::${pd.id}`);
  }
  const matchedPendingKeys = new Set<string>();

  // Build a job_id → SubagentInvocation[] index so predicate 6 is O(1) per row.
  // Filtered to `status === "running"` at index time — the only status that
  // can block; ok/error rows pass silently.
  const subRunningByJobId = new Map<string, SubagentInvocation[]>();
  for (const inv of subagentInvocations) {
    if (inv.status !== "running") {
      continue;
    }
    const arr = subRunningByJobId.get(inv.job_id);
    if (arr === undefined) {
      subRunningByJobId.set(inv.job_id, [inv]);
    } else {
      arr.push(inv);
    }
  }

  // Build a tasks-by-id index spanning every epic, so cross-epic
  // `depends_on` lookups (rare but possible per spec) hit O(1).
  //
  // fn-637.4: the parallel `epicById` + `epicsByNumber` indexes are gone.
  // Predicate 9 now reads `epic.resolved_epic_deps` (schema-v34 projection,
  // maintained by the reducer's forward-stamp + reverse fan-out), so the
  // readiness pass no longer resolves cross-epic deps live.
  const taskById = new Map<string, Task>();
  const epicsArr: Epic[] = [];
  for (const epic of epics) {
    epicsArr.push(epic);
    for (const task of epic.tasks) {
      taskById.set(task.task_id, task);
    }
  }

  const perTask = new Map<string, Verdict>();
  const perCloseRow = new Map<string, Verdict>();
  const perEpic = new Map<string, Verdict>();
  // fn-637.4: the readiness pass no longer resolves cross-epic deps live, so
  // there's no ambiguity-diagnostic surface here anymore. The reducer's
  // fold-time `enrichEpicDep` invocation owns ambiguity emission; this slot
  // remains in the snapshot for the public `ReadinessSnapshot` contract
  // (`scripts/board.ts` / `scripts/autopilot.ts` drain `diagnostics` per
  // snapshot via `appendDiagnostic`) and stays empty under the projection
  // cutover.
  const diagnostics: ResolutionDiagnostic[] = [];

  for (const epic of epicsArr) {
    // Per-task pass — depends_on is intra-epic, and the pre-sorted tasks
    // array (planctl invariant) is in dependency-safe order for the typical
    // case. For robustness against unusual orderings we still look up the
    // upstream from `taskById` (built above), so a forward-reference in
    // depends_on works as long as both ends live in the input.
    for (const task of epic.tasks) {
      const verdict = evaluateTask(
        task,
        epic,
        jobs,
        subRunningByJobId,
        perTask,
        perCloseRow,
        gitStatusByProjectDir,
        now,
        pendingKeys,
        matchedPendingKeys,
      );
      perTask.set(task.task_id, verdict);
    }

    // Synthetic close-row verdict.
    const closeVerdict = evaluateCloseRow(
      epic,
      jobs,
      subRunningByJobId,
      perTask,
      gitStatusByProjectDir,
      now,
      pendingKeys,
      matchedPendingKeys,
    );
    perCloseRow.set(epic.epic_id, closeVerdict);
  }

  // fn-721 root-fallback (decision b): a pending dispatch whose `verb::id`
  // matched NO task or close row in the per-row walk above — the
  // launch→materialize lag (a worker launched before its `.planctl` snapshot
  // folded into `epics`) or a deleted-target window. Its slot must still be
  // held so a sibling on the same root can't double-dispatch into it, but
  // there's no per-row verdict to set, so we seed the row's own `dir` into
  // the per-root mutex's occupied set. A null `dir` contributes nothing
  // (degrades safely — the row's own TTL/discharge still clears it; it just
  // can't claim a root without a path). Built outside the per-row walk
  // because, by definition, these rows have no row to attach to.
  const fallbackRoots = new Set<string>();
  for (const pd of pendingDispatches) {
    const key = `${pd.verb}::${pd.id}`;
    if (matchedPendingKeys.has(key)) {
      continue;
    }
    if (pd.dir != null && pd.dir !== "") {
      fallbackRoots.add(pd.dir);
    }
  }

  // Post-pass mutexes — mutate `perTask` / `perCloseRow` in board traversal
  // order. Per-epic FIRST so its tighter scope reports the reason when both
  // would apply; per-root SECOND over the same maps (seeded with the
  // root-fallback occupants above).
  applySingleTaskPerEpicMutex(epicsArr, perTask);
  applySingleTaskPerRootMutex(
    epicsArr,
    perTask,
    perCloseRow,
    subRunningByJobId,
    fallbackRoots,
    eligibleEpicIds,
  );

  // Epic header rollup.
  for (const epic of epicsArr) {
    perEpic.set(epic.epic_id, rollupEpicHeader(epic, perTask, perCloseRow));
  }

  return { perTask, perCloseRow, perEpic, diagnostics };
}

// ---------------------------------------------------------------------------
// Predicate pipeline — per-row
// ---------------------------------------------------------------------------

function evaluateTask(
  task: Task,
  epic: Epic,
  // Schema v21 dropped the live-jobs join from `anyJobLinkRunning` — the
  // embedded `JobLinkEntry.state` carries the linked session's last-known
  // lifecycle off the projection. The arg stays in the signature so
  // `computeReadiness`'s public surface is unchanged for external
  // callers; the underscore signals it's intentionally unused here.
  _jobs: Map<string, Job>,
  subRunningByJobId: Map<string, SubagentInvocation[]>,
  perTask: Map<string, Verdict>,
  // perCloseRow used to be consulted by predicate 9's tolerant
  // forward-ref evaluator. fn-637.4 replaced the live resolve with a
  // read off `epic.resolved_epic_deps`, so predicate 9 no longer
  // touches `perCloseRow` — the param remains in the signature for
  // call-site symmetry with `evaluateCloseRow` and the
  // post-pass mutex helpers.
  _perCloseRow: Map<string, Verdict>,
  // fn-756: the fn-703 git-cleanliness lift (predicate 6.5) was the sole
  // reader of this map at the task layer; with the approval window gone it
  // is no longer consulted here. Retained in the signature (underscored) for
  // call-site symmetry with `computeReadiness`'s public surface.
  _gitStatusByProjectDir: Map<
    string,
    { dirty_count: number; unattributed_to_live_count: number }
  >,
  // fn-638.4: caller-injected reference timestamp (unix seconds) for the
  // sub-agent staleness check at predicate 6. See `computeReadiness`'s
  // `now` doc for the determinism rationale.
  now: number,
  // fn-721: the canonical `verb::id` keys of every open `pending_dispatches`
  // row, and the running set of keys MATCHED so far. The task arm matches
  // `work::<task_id>`; a match records the key into `matchedPendingKeys` (so
  // it does NOT also drive the root-fallback) and sets the late-rank
  // `dispatch-pending` occupant verdict below.
  pendingKeys: Set<string>,
  matchedPendingKeys: Set<string>,
): Verdict {
  // fn-721: a pending dispatch keyed on THIS task's `work::` or `approve::`
  // verb MATCHED a real snapshot row — record it so the post-pass
  // root-fallback does NOT also synthesize a root occupant for it (the
  // late-rank `dispatch-pending` verdict below, or the earlier-winning
  // `running` / `job-pending` predicate, already holds the slot via the
  // per-row pass). Computed once, BEFORE the predicate pipeline returns, so
  // the match is recorded even when a higher-rank verdict (e.g. a live
  // `running`) wins and the late-rank dispatch-pending branch never runs.
  const taskHasPending =
    pendingKeys.size > 0 &&
    (pendingKeys.has(`work::${task.task_id}`) ||
      pendingKeys.has(`approve::${task.task_id}`));
  if (taskHasPending) {
    if (pendingKeys.has(`work::${task.task_id}`)) {
      matchedPendingKeys.add(`work::${task.task_id}`);
    }
    if (pendingKeys.has(`approve::${task.task_id}`)) {
      matchedPendingKeys.add(`approve::${task.task_id}`);
    }
  }

  // 1. terminal-completed. Schema v19: read the derived worker-phase binary
  // under its new key — the legacy `status` was renamed to `worker_phase`
  // to free up `runtime_status` for the planctl-native enum. Semantics:
  // `worker_done_at` present → `worker_phase === "done"`.
  //
  // fn-671: the administrative completion signals (worker_phase + approval)
  // are orthogonal to PROCESS liveness — `worker_phase` flips to "done" when
  // planctl stamps `worker_done_at`, which can race ahead of the Claude
  // session's Stop/SessionEnd, and the human can approve before the session
  // exits. The pre-fn-671 guard collapsed to `completed` the instant both
  // administrative signals landed, which made `isLiveWorkOccupant` /
  // `isRootOccupant` release the per-epic and per-root mutexes while the
  // worker session was still alive → the autopilot dispatched a sibling
  // task into the same root before the prior worker had wound down. Adding
  // the two liveness clauses below holds the verdict at `running:*` (falls
  // through to predicate 5 → `job-running`, or predicate 6 →
  // `sub-agent-running` / `sub-agent-stale`) until the session is genuinely
  // idle, mirroring how predicate 7 (own-approval-pending) is deliberately
  // ordered below 5/6 for the same race.
  //
  // Crash robustness: a main-job wedge is unblocked by the reducer's
  // `Killed` arm (driven by the exit-watcher worker — `src/exit-watcher.ts`
  // + the boot `seedKilledSweep`), which transitions a dead worker's
  // embedded job out of `working` on a unilateral OS-level exit signal so
  // this guard cannot wedge permanently. A sub-agent that dies silently
  // without emitting SubagentStop has no `Killed`-equivalent backstop,
  // so the `sub-agent-stale` verdict (predicate 6) keeps occupying the
  // per-root mutex by design — correctness over throughput; cleared by
  // autopilot pause + manual replay rather than auto-reaped.
  //
  // fn-719: the THIRD liveness clause — `!anyEmbeddedJobHasLiveMonitor`. A
  // work session that backgrounded a test suite and yielded its turn flips
  // its embedded job to `stopped` (so `anyEmbeddedJobWorking` is false) with
  // no sub-agent in flight (so `anyEmbeddedJobHasRunningSubagent` is false),
  // yet the suite is STILL RUNNING — the exact gate that collapsed
  // `approve::fn-715.2` to `completed` while its suite ran, freeing the mutex
  // and letting approve dispatch ~7s after the Stop. ANDing the task-1
  // monitor fact holds the task at `running:monitor-running` (predicate 6.6
  // below) until the monitor clears or its lease ages out, the same way the
  // first two clauses hold it at `job-running` / `sub-agent-running`.
  if (
    task.worker_phase === "done" &&
    !anyEmbeddedJobWorking(task.jobs) &&
    !anyEmbeddedJobHasRunningSubagent(task.jobs, subRunningByJobId) &&
    !embeddedMonitorOccupies(task.jobs, now)
  ) {
    return { tag: "completed" };
  }

  // 1.5. epic-not-materialized (fn-712). `epic.status === null` ⇔ no
  // `EpicSnapshot` has folded yet — the shell row a scaffold commit mints
  // before its real snapshot lands (status is set non-null at exactly one
  // reducer site, the EpicSnapshot UPSERT). Ranked the EARLIEST blocked
  // predicate (above epic-not-validated) so a not-yet-materialized epic is
  // non-dispatchable until its snapshot folds — the same `status IS NOT
  // NULL` notion the board's `default_visible` column uses to hide the
  // shell row, so both surfaces wait for the same state. Above the terminal
  // `completed` predicate 1 a NULL-status epic can't be done+approved
  // anyway (both require the snapshot), so the ordering is safe.
  if (epic.status == null) {
    return { tag: "blocked", reason: { kind: "epic-not-materialized" } };
  }

  // 2. epic-not-validated.
  if (epic.last_validated_at == null) {
    return { tag: "blocked", reason: { kind: "epic-not-validated" } };
  }

  // 3. planner-running. Discharges once real work has landed on the epic
  //    (`epicWorkStarted`) — so a planner restarted for followup in the same
  //    session can't re-block an epic it already released to a worker.
  if (!epicWorkStarted(epic) && anyJobLinkRunning(epic)) {
    return { tag: "running", reason: { kind: "planner-running" } };
  }

  // 4. own-approval-rejected — REMOVED (fn-756). The approval enum no longer
  // gates completion; a task completes on `worker_phase==="done"` alone
  // (predicate 1 above). `task.approval` was dropped from the projection in
  // fn-756 .2 (schema v63).

  // 5. own-progress-main — embedded jobs[] state vocabulary, no verb check
  // (the embedded array's verb is implied by where it lives — task-level
  // here means verb `work`).
  if (anyEmbeddedJobWorking(task.jobs)) {
    return { tag: "running", reason: { kind: "job-running" } };
  }

  // 6. own-progress-sub — sub-agent invocation under THIS row's worker
  // session. The worker session id is the embedded job's `job_id`; a task
  // may have zero or more workers. A single `running` invocation on any
  // worker blocks.
  //
  // fn-638.4: split the verdict on `now - inv.ts > SUBAGENT_STALENESS_SEC`:
  // if EVERY surviving running sub-agent under this row is stale, render
  // `sub-agent-stale` (visibility affordance for a possibly-stuck
  // orphan); otherwise render `sub-agent-running` (fresh work in
  // flight). The reducer's bounded Stop guard (fn-638.1) releases the
  // worker's `working` state under the same window; this predicate runs
  // AFTER that release surfaces — predicate 5 has already cleared by
  // then, so this branch sees only the sub-agents that survived. Reads
  // the same threshold the reducer uses so the two definitions stay
  // aligned with `collapseSubagentsByName`'s structural stuck-orphan
  // notion (the client labels turn_seq-superseded rows; this predicate
  // labels temporally-old rows — both converge on the same orphaned
  // running rows).
  if (anyEmbeddedJobHasRunningSubagent(task.jobs, subRunningByJobId)) {
    if (
      allRunningSubagentsAreStale(
        task.jobs,
        subRunningByJobId,
        now,
        SUBAGENT_STALENESS_SEC,
      )
    ) {
      return { tag: "running", reason: { kind: "sub-agent-stale" } };
    }
    return { tag: "running", reason: { kind: "sub-agent-running" } };
  }

  // 6.6. monitor-running / monitor-stale (fn-719). A work session that
  // backgrounded a test suite (`pnpm test` via Bash `run_in_background`) and
  // then yielded its turn flips the embedded job to `stopped`, so predicates 5
  // and 6 have both cleared — but the suite is STILL RUNNING. Task 1 carries
  // the provenance-filtered `has_live_worker_monitor` fact (true only for
  // worker-launched `monitor`/`bash-bg` monitors; `ambient` watchers never
  // count) onto the embedded element; this predicate consumes it as an
  // occupant verdict that holds the per-epic AND per-root mutex but is
  // non-dispatchable (`verbForVerdict → null`). Without it the closer/approve
  // dispatches into a not-actually-idle session — the live fn-715.2 incident
  // (approve dispatched ~7s after the work Stop whose snapshot still listed a
  // running suite).
  //
  // Placed AFTER predicate 6 (sub-agent) and BEFORE the git-6.5 predicate, the
  // same race-window slot the sub-agent / git verdicts occupy: a more-specific
  // running verdict (a still-`working` main job, a running sub-agent) wins, and
  // a not-yet-validated / not-yet-materialized epic or an in-flight planner
  // still outranks it (predicates 1.5/2/3 are above predicate 5).
  //
  // Lease/TTL staleness floor (`occupying = monitor-present AND snapshot-fresh`,
  // two knobs, whichever fires first): the freshness anchor is the embedded
  // job's `updated_at`, which re-stamps per agent turn-end (NOT the suite's own
  // runtime). Past the soft `MONITOR_STALENESS_SEC` lease → `monitor-stale`
  // (still occupying, human-visible "may be abandoned"); past the hard
  // `MONITOR_RELEASE_SEC` ceiling → NO LONGER occupies (the slot frees so an
  // abandoned session can't wedge it forever). Read-time, `now`-injected,
  // never folded — same sanctioned determinism exception as the sub-agent
  // split. Terminal SessionEnd/Killed already clears the fact for free at
  // task 1, so the ceiling only matters for the Stop-then-never-updated case.
  if (embeddedMonitorOccupies(task.jobs, now)) {
    // Occupying (monitor present, within the hard ceiling). Split on the
    // soft lease: past it → `monitor-stale` (still occupies, flagged);
    // within it → `monitor-running`. The past-hard-ceiling release case is
    // already excluded by `embeddedMonitorOccupies` — it falls through here.
    if (allLiveMonitorsAreStale(task.jobs, now, MONITOR_STALENESS_SEC)) {
      return { tag: "running", reason: { kind: "monitor-stale" } };
    }
    return { tag: "running", reason: { kind: "monitor-running" } };
  }

  // 6.5. git-uncommitted / git-orphans — REMOVED (fn-756). This was the
  // fn-703 git-cleanliness lift tied to the approval window: it blocked the
  // autopilot's `/plan:approve` dispatch when the worktree was dirty. With
  // the approval window gone (a task completes on `worker_phase==="done"`
  // alone — predicate 1), there is no approve dispatch to gate, so the lift
  // is dead. The worker commits its own work before yielding (`keeper
  // commit-work`), so a clean tree is the worker's responsibility, not a
  // completion gate.

  // 7. own-approval-pending — REMOVED (fn-756). The approval enum no longer
  // gates completion; predicate 1 marks the task `completed` on
  // `worker_phase==="done"` alone, so there is no `job-pending` window. The
  // `task.approval` field was dropped from the projection in fn-756 .2
  // (schema v63).

  // 8. dep-on-task — any upstream NOT `{ tag: "completed" }`. The pre-sorted
  // tasks order means typical intra-epic deps already have their upstream
  // verdict in `perTask`; an upstream absent from `perTask` (cross-epic dep
  // not yet folded, malformed id) counts as NOT completed → blocks.
  for (const upstream of task.depends_on) {
    const upstreamVerdict = perTask.get(upstream);
    if (upstreamVerdict === undefined || upstreamVerdict.tag !== "completed") {
      return {
        tag: "blocked",
        reason: { kind: "dep-on-task", upstream },
      };
    }
  }

  // 9. dep-on-epic — task-side rollup of the parent epic's dep list.
  // Reads `epic.resolved_epic_deps` (the schema-v34 projection
  // maintained by the reducer's fn-637.3 forward stamp + reverse
  // fan-out). Each entry is a {@link ResolvedEpicDep} carrying the
  // resolved upstream + a tri-state `state` field:
  //
  //   - `satisfied` — upstream is `status==="done"` (fn-756: no approval gate);
  //     dependency met. Skip.
  //   - `blocked-incomplete` — upstream resolved but NOT done.
  //     Emit `dep-on-epic` (amber), carrying the resolved upstream id and the
  //     cross-project basename when `cross_project === true`. Same payload
  //     shape autopilot's BlockReason consumer reads byte-for-byte.
  //   - `dangling` — no resolution possible (full-id miss, bare-id miss, or
  //     2+ matches with no same-project disambiguator). Emit
  //     `dep-on-epic-dangling` (red pill) carrying the raw `dep_token`.
  //
  // `null` short-circuits the loop — a fresh-row "not yet computed" state
  // (see {@link Epic.resolved_epic_deps}). The reducer stamps the column
  // synchronously inside the same fold as the EpicSnapshot write, so the
  // null window only spans a single in-flight migration; production reads
  // always see `[]` or a populated array.
  //
  // The fn-637 cutover deleted the prior live-resolve loop (and its
  // `epicById`/`epicsByNumber` indexes, ambiguity diagnostics, tolerant
  // forward-ref handling). Diagnostics still flow off the reducer's
  // fold-time resolver invocation, surfaced via the side-band JSONL log
  // (`~/.local/state/keeper/readiness-diagnostics.jsonl`).
  if (epic.resolved_epic_deps !== null) {
    for (const dep of epic.resolved_epic_deps) {
      if (dep.state === "satisfied") {
        continue;
      }
      if (dep.state === "dangling") {
        return {
          tag: "blocked",
          reason: { kind: "dep-on-epic-dangling", upstream: dep.dep_token },
        };
      }
      // blocked-incomplete: emit `dep-on-epic`. Carry the resolved
      // upstream id (non-null when state is `blocked-incomplete`) and
      // reconstruct the readiness-side `cross_project: string | null`
      // shape from the projection's boolean + basename pair: when
      // cross-project, the basename is non-null and is carried as the
      // prefix; same-project deps carry `null`.
      return {
        tag: "blocked",
        reason: {
          kind: "dep-on-epic",
          upstream: dep.resolved_epic_id ?? dep.dep_token,
          cross_project: dep.cross_project ? dep.project_basename : null,
        },
      };
    }
  }

  // 10. dep-on-task-synthetic-close — not applicable to a real task.

  // 10.5. dispatch-pending (fn-721) — a worker autopilot LAUNCHED against this
  // task (a `work::` / `approve::` row in `pending_dispatches`) but whose
  // SessionStart has not folded yet, so no `jobs` row exists to make the slot
  // visible as a real `running` occupant. Set the occupant verdict at this
  // LATE per-row rank — AFTER every real `running` verdict (predicates 1–7,
  // which return earlier), the structural-not-ready verdicts
  // (epic-not-materialized / epic-not-validated / planner-running), AND the
  // dep verdicts (8/9): each of those still WINS so a truer state is never
  // masked (the fn-700 anti-pattern). It runs BEFORE the post-pass mutexes,
  // so pass-1 of both `applySingleTaskPerEpicMutex` and
  // `applySingleTaskPerRootMutex` sees it as an occupant via
  // `isLiveWorkOccupant`, demoting a same-epic OR same-root ready sibling.
  // Non-dispatchable (`verbForVerdict → null`) and self-resolving (the row
  // discharges on SessionStart bind / DispatchFailed / DispatchExpired). The
  // match was already recorded into `matchedPendingKeys` at the top of this
  // function so the root-fallback never double-counts a matched row.
  //
  // Note: an `approve` dispatch's row is normally already `job-pending`
  // (predicate 7, an occupant + `verbForVerdict → approve`) and wins above,
  // with the same-key `liveTabKeys` arm suppressing its re-dispatch — so this
  // branch typically fires for a `work` dispatch whose row would otherwise
  // read `ready`. Either way the dispatched row occupies its mutex.
  if (taskHasPending) {
    return { tag: "blocked", reason: { kind: "dispatch-pending" } };
  }

  // 11. single-task-per-epic — deferred to applySingleTaskPerEpicMutex.
  // 12. single-task-per-root — deferred to applySingleTaskPerRootMutex.

  return { tag: "ready" };
}

/**
 * Close-row verdict pipeline. Predicates 5 (own-progress-main) and 6
 * (own-progress-sub) pool TWO scopes:
 *   - EPIC-LEVEL: `epic.jobs` (close-verb embedded jobs) and `epic.job_links`
 *     (planner-running, predicate 3) — this is the PRIMARY close-row source.
 *   - TASK-LEVEL: the `task.jobs` sub-array (and sub-agents under those task
 *     workers) of every ALREADY-COMPLETED task — kept as a backstop. After
 *     fn-671 the per-task predicate 1 (`evaluateTask`) ALSO checks worker
 *     liveness, so a `completed` task can no longer have a `working` embedded
 *     job or a running sub-agent, which makes this task-level close-row scan
 *     PROVABLY UNREACHABLE under the current rules. Retained verbatim as a
 *     re-fold-determinism backstop in case a future change ever lets the
 *     two states coexist again — the close row is the second line of
 *     defense against the completed-but-still-alive race the per-task
 *     guard now catches first.
 *
 * Historical context (pre-fn-671): the task-level fan-in WAS load-bearing
 * because predicate 1 marked a task `completed` the instant `worker_phase
 * === "done" && approval === "approved"`, racing ahead of the worker
 * session's Stop/SessionEnd. Without the fan-in, the close row would flip
 * to `ready` while that worker was still alive. fn-671 moved the gate to
 * the per-task predicate so the per-epic AND per-root mutexes hold from
 * the first task-level read — but keeping the close-row fan-in costs
 * nothing and preserves a sane verdict if the per-task gate ever
 * regresses.
 *
 * The verdict alone therefore still does NOT carry attribution: a close row
 * marked `running:job-running` or `running:sub-agent-running` is normally
 * owned by an epic-level source (the task-level branch is unreachable
 * after fn-671). That matters for `applySingleTaskPerRootMutex` — see its
 * JSDoc for the scoped close-row claim (fn-655). The per-root mutex
 * re-derives epic-level running-ness from `epic.jobs`/`job_links` plus the
 * sub-agent index so a purely task-derived running close row no longer
 * phantoms a `project_dir` lock that starves unrelated epics. (That gate
 * stays load-bearing: the per-task guard now holds the contributing task
 * at `running:*` and that task claims its own root via pass-1; the close
 * row only legitimately occupies `project_dir` for epic-level running
 * work.)
 */
function evaluateCloseRow(
  epic: Epic,
  // See `evaluateTask` for why this is `_jobs` — schema v21's embedded
  // `JobLinkEntry.state` removed the live-jobs join, and the public
  // `computeReadiness` surface stays unchanged.
  _jobs: Map<string, Job>,
  subRunningByJobId: Map<string, SubagentInvocation[]>,
  perTask: Map<string, Verdict>,
  // fn-756: the fn-703 close-row git-cleanliness lift (predicate 6.5) was
  // the sole reader of this map at the close-row layer; removed with the
  // approval window. Retained (underscored) for call-site symmetry.
  _gitStatusByProjectDir: Map<
    string,
    { dirty_count: number; unattributed_to_live_count: number }
  >,
  // fn-638.4: caller-injected reference timestamp (unix seconds) for the
  // sub-agent staleness check at predicate 6. See `computeReadiness`'s
  // `now` doc for the determinism rationale.
  now: number,
  // fn-721: the canonical `verb::id` keys of every open `pending_dispatches`
  // row, and the running matched-key set. The close-row arm matches
  // `close::<epic_id>`; a match records the key (so it does NOT drive the
  // root-fallback) and sets the late-rank `dispatch-pending` verdict below.
  pendingKeys: Set<string>,
  matchedPendingKeys: Set<string>,
): Verdict {
  // fn-721: a pending `close::<epic_id>` dispatch MATCHED this close row —
  // record it (computed before the pipeline returns, so the match is logged
  // even when a higher-rank verdict wins and the late-rank branch never
  // runs) so the root-fallback never double-synthesizes a root occupant for
  // it.
  const closeHasPending =
    pendingKeys.size > 0 && pendingKeys.has(`close::${epic.epic_id}`);
  if (closeHasPending) {
    matchedPendingKeys.add(`close::${epic.epic_id}`);
  }

  // 1. terminal-completed (close-row variant). fn-756: completes on
  // `epic.status==="done"` alone; the approval enum no longer gates.
  if (epic.status === "done") {
    return { tag: "completed" };
  }

  // 1.5. epic-not-materialized (fn-712). `epic.status === null` ⇔ no
  // `EpicSnapshot` has folded yet — a scaffold commit's shell row before
  // its real snapshot lands. Ranked the EARLIEST blocked predicate (above
  // epic-not-validated) so the autopilot refuses to dispatch a CLOSER
  // against a not-yet-materialized epic. Mirror of the per-task gate and of
  // the board's `status IS NOT NULL` `default_visible` predicate — one
  // shared notion of "this epic is real yet" across both surfaces.
  // Below the terminal predicate 1 (a NULL-status epic can't be
  // done+approved — both require the snapshot — so the ordering is safe).
  if (epic.status == null) {
    return { tag: "blocked", reason: { kind: "epic-not-materialized" } };
  }

  // 2. epic-not-validated.
  if (epic.last_validated_at == null) {
    return { tag: "blocked", reason: { kind: "epic-not-validated" } };
  }

  // 3. planner-running. Discharges once real work has landed on the epic
  //    (`epicWorkStarted`) — so a planner restarted for followup in the same
  //    session can't re-block an epic it already released to a worker.
  if (!epicWorkStarted(epic) && anyJobLinkRunning(epic)) {
    return { tag: "running", reason: { kind: "planner-running" } };
  }

  // 4. own-approval-rejected — REMOVED (fn-756). The approval enum no longer
  // gates completion; the close row completes on `epic.status==="done"`
  // alone (predicate 1 above). `epic.approval` was dropped from the projection
  // in fn-756 .2 (schema v63).

  // 5. own-progress-main — close-row blocks on a running worker session at
  // EITHER scope: epic-level (close-verb) embedded jobs (the primary source),
  // OR a task-level (work-verb) embedded job on an ALREADY-COMPLETED task
  // (a backstop — normally unreachable after fn-671).
  //
  // After fn-671 the per-task predicate 1 holds a `done+approved` task at
  // `running:job-running` whenever its embedded job is still `working`, so a
  // task whose `perTask.get(...).tag === "completed"` can no longer have a
  // working embedded job — the inner loop's `&&` is provably false on
  // current code. The loop is retained as a re-fold-determinism backstop
  // in case a future change ever lets the two states coexist again; if it
  // ever fires, the verdict is the same one the per-task guard would have
  // produced.
  //
  // A task that is NOT yet completed (genuinely in-flight) is deliberately
  // EXCLUDED here: predicate 10 below already blocks the close row on it with
  // the accurate `dep-on-task` reason, and fanning its running-ness onto the
  // close row would mislabel a dependency-blocked close as `running:job-running`
  // (it outranks predicate 10) — the close row isn't running its own work, it's
  // waiting on an incomplete task.
  if (anyEmbeddedJobWorking(epic.jobs)) {
    return { tag: "running", reason: { kind: "job-running" } };
  }
  // fn-671: normally unreachable after the per-task guard; retained as a
  // backstop if a future change ever lets a `completed` task coexist with
  // a `working` embedded job.
  for (const task of epic.tasks) {
    if (
      perTask.get(task.task_id)?.tag === "completed" &&
      anyEmbeddedJobWorking(task.jobs)
    ) {
      return { tag: "running", reason: { kind: "job-running" } };
    }
  }

  // 6. own-progress-sub — sub-agent invocation under a worker session bound
  // to this epic. PRIMARY source: a close-verb at epic level. BACKSTOP
  // source: a work-verb on an ALREADY-COMPLETED task — normally unreachable
  // after fn-671 (the per-task predicate 1 holds a `done+approved` task at
  // `running:sub-agent-running`/`sub-agent-stale` while any sub-agent is
  // running under its embedded jobs, so no task with running sub-agents
  // can carry the `completed` tag any more). Helpers retain the
  // `completed`-scoping inside `closeRowHasRunningSubagent` /
  // `allCloseRowRunningSubagentsAreStale` as a re-fold-determinism backstop.
  // A not-yet-completed task is still deliberately excluded here and falls
  // through to predicate 10's `dep-on-task` block.
  //
  // fn-638.4: same stale split as the task path's predicate 6 — render
  // `sub-agent-stale` iff every surviving running sub-agent across the
  // checked scopes (epic-level close jobs + every completed task's work job)
  // is past `SUBAGENT_STALENESS_SEC` relative to `now`; otherwise
  // `sub-agent-running`. The check pools every in-scope source so a single
  // fresh sub-agent on any of them keeps the close row at `sub-agent-running`
  // (the close row is genuinely blocked on live work somewhere); the
  // close row only flips to `sub-agent-stale` once every surviving
  // sub-agent across every contributing scope is suspect.
  if (closeRowHasRunningSubagent(epic, perTask, subRunningByJobId)) {
    if (
      allCloseRowRunningSubagentsAreStale(epic, perTask, subRunningByJobId, now)
    ) {
      return { tag: "running", reason: { kind: "sub-agent-stale" } };
    }
    return { tag: "running", reason: { kind: "sub-agent-running" } };
  }

  // 6.6. monitor-running / monitor-stale (fn-719) — close-row twin of the
  // task-path predicate 6.6. Holds the close row at `running:monitor-*`
  // while a live worker-launched monitor occupies any pooled scope (epic-
  // level close-verb jobs — the PRIMARY case — or a completed task's work
  // jobs, the backstop), so the closer/approve cannot dispatch into a
  // not-actually-idle close session. Same soft-TTL → `monitor-stale` /
  // hard-ceiling → release lease as the task path; the release boundary is
  // shared via `closeRowMonitorOccupies` → `embeddedMonitorOccupies`.
  if (closeRowMonitorOccupies(epic, perTask, now)) {
    if (allCloseRowMonitorsAreStale(epic, perTask, now)) {
      return { tag: "running", reason: { kind: "monitor-stale" } };
    }
    return { tag: "running", reason: { kind: "monitor-running" } };
  }

  // 6.5. git-uncommitted / git-orphans — REMOVED (fn-756). The close-row
  // variant of the fn-703 git-cleanliness lift was gated on
  // `epic.status==="done"` — exactly what predicate 1 now treats as
  // `completed`, so this branch became unreachable AND its purpose (gating
  // the approve dispatch) is gone with the approval window. Deleted.

  // 7. own-approval-pending — REMOVED (fn-756). Predicate 1 marks the close
  // row `completed` on `epic.status==="done"` alone, so there is no
  // `job-pending` window. `epic.approval` was dropped from the projection in
  // fn-756 .2 (schema v63).

  // 8. dep-on-task — not applicable to the close row (it has no direct
  // task deps; predicate 10 below synthesizes those from the epic's tasks).

  // 9. dep-on-epic — also not applicable to the close row (the spec
  // assigns cross-epic deps to the task rows; the close row's deps
  // cascade transitively through tasks).

  // 9.5. epic-no-tasks — the epic has ZERO tasks. Predicate 10's
  // `for…of epic.tasks` loop below is vacuously true over an empty list,
  // so the close row would fall through to the `ready` return at the
  // bottom and the autopilot would dispatch a closer against an epic with
  // no work (the fn-698 incident: an `EpicSnapshot` folds before its first
  // `TaskSnapshot`, and a reconcile that lands in that partial-projection
  // window saw the vacuous `ready`). Block it explicitly.
  //
  // DELIBERATELY ranked LATE (here, after predicates 1–7, immediately
  // before predicate 10) — NOT first. First-placement would mask
  // `epic-not-validated` on a pre-`EpicSnapshot` stub and `planner-running`
  // during active scaffolding, and perturb the predicate-2-precedence
  // tests. This rank catches EXACTLY the vacuous fall-through and nothing
  // else: every more-specific verdict above (completed, epic-not-validated,
  // planner-running, job-running / sub-agent-running) still wins.
  if (epic.tasks.length === 0) {
    return { tag: "blocked", reason: { kind: "epic-no-tasks" } };
  }

  // 10. dep-on-task-synthetic-close — every real task in the epic must be
  // completed. Reason carries the first non-completed task id in
  // traversal (pre-sorted tasks) order.
  for (const task of epic.tasks) {
    const v = perTask.get(task.task_id);
    if (v === undefined || v.tag !== "completed") {
      return {
        tag: "blocked",
        reason: { kind: "dep-on-task", upstream: task.task_id },
      };
    }
  }

  // 10.5. dispatch-pending (fn-721) — close-row twin of the task-path
  // predicate. A `close::<epic_id>` worker was LAUNCHED but its SessionStart
  // has not folded yet. Set at this LATE rank — after the close row's own
  // terminal/structural/dep verdicts (which still win), before the post-pass
  // mutexes — so it occupies BOTH the per-epic and per-root mutex while the
  // launch → SessionStart window is open. Non-dispatchable and self-resolving,
  // same as the task path. The match was recorded at the top of this function
  // so the root-fallback never double-counts it.
  if (closeHasPending) {
    return { tag: "blocked", reason: { kind: "dispatch-pending" } };
  }

  // 11. single-task-per-epic — deferred to applySingleTaskPerEpicMutex.
  // 12. single-task-per-root — deferred to applySingleTaskPerRootMutex.

  return { tag: "ready" };
}

// ---------------------------------------------------------------------------
// Post-pass mutexes
// ---------------------------------------------------------------------------

/**
 * Per-epic mutex (predicate 11). Two-pass walk over each epic's tasks in
 * pre-sorted order.
 *
 * Pass 1 — live-work claim: scan every task; if any task's verdict satisfies
 * `isLiveWorkOccupant` (i.e. one of `job-running`, `sub-agent-running`,
 * `planner-running`, `job-pending`), that task claims the epic's slot
 * regardless of iteration order. Dependency-style blocks (`dep-on-task`,
 * `dep-on-epic`), admin blocks, repo-state blocks, mutex-synthesized blocks,
 * and `unknown` do NOT claim in pass-1 — they represent waiting, not
 * concurrent worker activity.
 *
 * Pass 2 — ready tiebreak: walk the same tasks again. If pass-1 already
 * claimed the slot, every `{ tag: "ready" }` row is mutated to
 * `{ kind: "single-task-per-epic" }`. Otherwise the FIRST ready row wins the
 * slot and every LATER ready row is demoted. Rows already blocked keep their
 * more-specific reason (only `{ tag: "ready" }` is mutated).
 *
 * The close row is never considered here: predicate 10 already forces close
 * to wait until every task is completed, so close can only be `ready` when
 * no real task in the epic is non-completed → no competitor.
 *
 * Exported separately so the test suite can drive it with a hand-rolled
 * verdict map.
 */
/**
 * "Live work" predicate. A row whose verdict claims a mutex slot in pass-1
 * regardless of iteration order. The set is the running/queued states that
 * represent ACTUAL ongoing worker activity on a target — the states where
 * dispatching another job to the same scope would land us with two live
 * workers on one target.
 *
 * Occupants:
 *   - every `running` verdict (job-running, sub-agent-running,
 *     sub-agent-stale, planner-running);
 *   - fn-756: the approval-pending occupants (`job-pending` and the fn-703
 *     `git-uncommitted`/`git-orphans` verdicts) are REMOVED along with the
 *     approval window — those verdicts are no longer produced;
 *   - `dispatch-pending` — fn-721. A worker autopilot LAUNCHED but whose
 *     SessionStart has not folded yet (an open `pending_dispatches` row). No
 *     `jobs` row exists in the launch → SessionStart blind window, so this is
 *     the ONLY signal the slot is taken. Holding the mutex demotes a same-epic
 *     OR same-root ready sibling, closing the launch→SessionStart safety gap
 *     so the next epic (step 3) can drop the serial `confirmRunning` wait
 *     without reopening the fn-627 double-dispatch class. Non-dispatchable
 *     (`verbForVerdict → null`); the row self-resolves on bind / DispatchFailed
 *     / DispatchExpired. Per-EPIC AND per-root (no planner exemption — a
 *     pending dispatch is a real launched worker holding a working tree,
 *     unlike a planner), so `isRootOccupant`'s delegation auto-covers it.
 *
 * Excluded: dependency blocks (`dep-on-task`, `dep-on-epic`), admin blocks
 * (`epic-not-validated`, `job-rejected`), mutex-synthesized blocks
 * (`single-task-per-epic`, `single-task-per-root`), and `unknown` — none of
 * those represent a live worker or an open approval window that would conflict
 * with a freshly-dispatched sibling.
 *
 * Per-EPIC mutex (`applySingleTaskPerEpicMutex`) keys on this predicate as-is
 * — a `planner-running` verdict still occupies the epic slot so the epic
 * cannot dispatch a sibling task while its own planner is in-flight. The
 * per-ROOT mutex narrows this set further via `isRootOccupant` to exempt
 * planners from claiming the root (fn-663).
 */
function isLiveWorkOccupant(verdict: Verdict): boolean {
  return (
    verdict.tag === "running" ||
    // fn-756: the approval-pending occupancy arm (`job-pending` + the fn-703
    // `git-uncommitted`/`git-orphans` approval-window verdicts) is REMOVED
    // along with the approval window itself — none of those verdicts are
    // produced any more. The sole remaining blocked-but-occupying signal is
    // `dispatch-pending`.
    (verdict.tag === "blocked" &&
      // fn-721: a launched-but-not-yet-bound worker (open `pending_dispatches`
      // row) holds the mutex through the launch → SessionStart blind window
      // — the ONE signal the slot is taken before a `jobs` row exists.
      verdict.reason.kind === "dispatch-pending")
  );
}

/**
 * Per-root occupancy predicate (fn-663). Narrower than `isLiveWorkOccupant`:
 * a `running` + `planner-running` verdict does NOT occupy the root, because a
 * planner has no dispatched worker holding the working tree — letting a
 * sibling epic's ready task dispatch concurrently in the same root is safe
 * (git `index.lock` contention is absorbed by the git worker's
 * `busy_timeout`, and dirty-file multi-attribution mid-flight is resolved
 * after-the-fact by the mtime attribution pass). Real workers
 * (`job-running`, `sub-agent-running`, `sub-agent-stale`) and
 * `dispatch-pending` still occupy via the `isLiveWorkOccupant` delegate
 * (fn-756 dropped the approval-pending occupants).
 *
 * The per-EPIC mutex deliberately stays on `isLiveWorkOccupant` — a planner
 * still blocks its OWN epic from dispatching sibling tasks (predicate 3
 * still fires at the per-task verdict layer, so the planner's own tasks
 * never read `ready` until the planner finishes).
 */
export function isRootOccupant(verdict: Verdict): boolean {
  if (verdict.tag === "running" && verdict.reason.kind === "planner-running") {
    return false;
  }
  return isLiveWorkOccupant(verdict);
}

export function applySingleTaskPerEpicMutex(
  epicsArr: Epic[],
  perTask: Map<string, Verdict>,
): void {
  for (const epic of epicsArr) {
    // Pass 1: any "live work" verdict (running/queued worker activity)
    // claims the epic slot regardless of iteration order relative to
    // ready siblings. Dependency-style blocks (dep-on-task, etc.) do
    // NOT claim — they represent waiting, not concurrent work.
    let occupied = false;
    for (const task of epic.tasks) {
      const verdict = perTask.get(task.task_id);
      if (verdict === undefined) {
        continue;
      }
      if (isLiveWorkOccupant(verdict)) {
        occupied = true;
        break;
      }
    }

    // Pass 2: walk ready rows. If the slot is already claimed by Pass 1,
    // every ready row is demoted. Otherwise, the first ready row wins
    // and later ready rows are demoted (preserving prior behavior).
    for (const task of epic.tasks) {
      const verdict = perTask.get(task.task_id);
      if (verdict === undefined || verdict.tag !== "ready") {
        continue;
      }
      if (!occupied) {
        occupied = true;
        continue;
      }
      perTask.set(task.task_id, {
        tag: "blocked",
        reason: { kind: "single-task-per-epic" },
      });
    }
  }
}

/**
 * Per-root mutex (predicate 12). Two-pass walk over every per-row verdict in
 * board traversal order (epics in input iteration order; per epic: pre-sorted
 * tasks then the synthetic close row). Key on the effective root:
 * `task.target_repo ?? epic.project_dir` (BOTH null AND empty-string fall
 * through to the next fallback — mirroring `scripts/autopilot.ts:206-210`
 * exactly).
 *
 * Pass 1 — root-occupant claim: scan every task and close row; any verdict
 * satisfying `isRootOccupant` (one of `job-running`, `sub-agent-running`,
 * `sub-agent-stale`, `job-pending`) claims its effective root regardless of
 * iteration order relative to ready siblings in other epics on the same
 * root. Planners are root-exempt (fn-663): a `planner-running` verdict does
 * NOT claim the root, so a sibling epic's ready task on the same root may
 * dispatch concurrently with a planner. Per-EPIC mutex still holds — a
 * planner's own epic cannot dispatch sibling tasks while the planner is
 * in-flight (predicate 3 keeps its tasks at `running:planner-running`).
 * Dependency / admin / repo-state / mutex-synthesized blocks and `unknown`
 * also do NOT claim in pass-1 — they don't represent a live worker that
 * would conflict with a freshly-dispatched sibling.
 *
 * Per-task pass-1 IS the primary lock path (fn-671). The per-task predicate
 * 1 holds a `done+approved` task at `running:job-running`/
 * `sub-agent-running`/`sub-agent-stale` whenever its embedded job is still
 * `working` or a sub-agent under it is running, so the contributing task
 * already shows up here as a root occupant via
 * `effectiveRoot(task.target_repo, project_dir)` — no close-row fan-in is
 * needed to hold the mutex. The close-row scoped attribution below is the
 * second line of defense, primarily protecting the EPIC-LEVEL close-verb
 * running-ness case and acting as a backstop for the (now-unreachable)
 * completed-but-still-alive task race.
 *
 * Close-row scoped attribution (fn-655, narrowed by fn-663): a running
 * close-row's verdict can be INHERITED from a task-level worker in a
 * different `target_repo` — `evaluateCloseRow` predicates 5/6 pool
 * `epic.jobs` AND every `task.jobs`. After fn-671 the per-task branch of
 * that pool is unreachable in practice (a `completed` task can no longer
 * have a `working` job or running sub-agent), but the close-row claim's
 * gating logic remains because a purely task-derived running close row,
 * if it ever existed, would already have its OWN root claimed by the
 * contributing task's pass-1 entry above — making an unconditional
 * `epic.project_dir` claim redundant when same-root AND harmful when
 * cross-root (a phantom lock that starves unrelated epics on
 * `project_dir`). The close-row claim is therefore gated on whether at
 * least one EPIC-LEVEL non-planner source is live:
 * `anyEmbeddedJobWorking(epic.jobs)` (predicate 5 epic-level close-verb
 * job) or `anyEmbeddedJobHasRunningSubagent(epic.jobs, subRunningByJobId)`
 * (predicate 6 epic-level sub-agent — staleness ignored: a
 * `sub-agent-stale` close row still legitimately occupies `project_dir`).
 * `anyJobLinkRunning(epic)` (predicate 3 planner-running — `JobLinkEntry.kind`
 * is `creator | refiner`, epic-scoped by construction) is intentionally NOT
 * a disjunct here: the outer `isRootOccupant(closeVerdict)` guard already
 * filters out a purely planner-derived close row, so a `planner-running`
 * close row never reaches this gate.
 *
 * fn-756: the fn-703 close-row git-verdict mirror is REMOVED. With the
 * approval window gone, predicate 1 marks the close row `completed` on
 * `epic.status === "done"` alone and predicate 6.5 is deleted, so a close
 * verdict no longer carries `git-uncommitted`/`git-orphans` — the only
 * non-running occupant the close-row gate now claims on is `dispatch-pending`
 * (fn-721, below).
 *
 * fn-721 close-row mirror: same shape again for a `close::<epic_id>` launched
 * but not-yet-bound closer — the close row renders `dispatch-pending` with NO
 * live epic-level job, so `epicLevelRunning` is false yet the launch-window
 * occupancy is the epic's OWN project_dir fact and must hold the epic's own
 * root. The gate also claims on the `dispatch-pending` close kind, strictly
 * scoped to `effectiveRoot(null, epic.project_dir)` — the same cross-root
 * phantom-lock narrowing as the git case.
 *
 * Pass 2 — ready tiebreak: walk tasks and close rows in iteration order. If
 * the root is already claimed by pass-1, every `{ tag: "ready" }` row on
 * that root is mutated to `{ kind: "single-task-per-root" }`. Otherwise the
 * FIRST ready row per root wins the slot and every LATER ready row on the
 * same root is demoted.
 *
 * Exported separately so the test suite can drive it with a hand-rolled
 * verdict map.
 */
export function applySingleTaskPerRootMutex(
  epicsArr: Epic[],
  perTask: Map<string, Verdict>,
  perCloseRow: Map<string, Verdict>,
  subRunningByJobId: Map<string, SubagentInvocation[]> = new Map(),
  // fn-721 root-fallback (decision b): roots claimed by an open
  // `pending_dispatches` row whose `verb::id` matched NO task or close row in
  // the per-row walk (launch→materialize lag or deleted target). Seeded into
  // `occupiedRoots` BEFORE pass-1 so a sibling ready task on the same root is
  // demoted to `single-task-per-root` even though the dispatched target has no
  // row to carry a per-row `dispatch-pending` verdict. Each entry is a non-
  // empty `dir`; null/empty dirs were dropped by the caller (degrade safely).
  // Default empty so callers that don't model launch-window occupancy (tests,
  // the simulator) keep the pre-fn-721 behaviour.
  fallbackRoots: Set<string> = new Set(),
  // fn-770: autopilot `armed`-mode eligibility for the discretionary pass-2
  // ready-tiebreak. ABSENT (`undefined`) selects the legacy single-pass —
  // byte-identical to pre-fn-770 and what every yolo-mode / test / simulator
  // caller gets, since they omit it. PROVIDED (even an EMPTY set) selects the
  // two-pass eligible-priority split below: pass-2a awards a free root to an
  // eligible epic's ready task BEFORE any ineligible sibling can claim it,
  // pass-2b lets ineligible rows take only the leftover roots. The
  // discriminator is `!== undefined`, NEVER `.size === 0` — an empty set means
  // "armed but nothing armed", which must suppress every TASK row (none is
  // eligible), not silently fall back to yolo. Injected by the caller (the
  // reconciler runs `computeEligibleEpics` once per cycle); readiness stays an
  // import LEAF and never derives the closure itself. Close rows are
  // eligibility-BLIND (always-eligible / mode-exempt) so a finalizer is never
  // starved by the mutex layer; pass-1 physical occupancy is untouched.
  eligibleEpicIds?: Set<string>,
): void {
  // Seed the root-fallback occupants first — a pending dispatch with no
  // matching snapshot row still holds its `dir` root.
  const occupiedRoots = new Set<string>(fallbackRoots);

  // Pass 1: every root-occupant verdict (task OR close row) claims its
  // root regardless of iteration order relative to ready siblings in
  // other epics on the same root. See `isRootOccupant` — only real
  // worker activity counts; planners are root-exempt (fn-663) and
  // dependency / mutex-synthesized blocks do not claim either, since
  // they don't represent a live worker that would conflict with a
  // freshly-dispatched sibling.
  for (const epic of epicsArr) {
    const projectDir = stringOrNull(epic.project_dir);

    for (const task of epic.tasks) {
      const verdict = perTask.get(task.task_id);
      if (verdict === undefined || !isRootOccupant(verdict)) {
        continue;
      }
      const root = effectiveRoot(stringOrNull(task.target_repo), projectDir);
      occupiedRoots.add(root);
    }

    // Close-row claim is scoped (fn-655, narrowed by fn-663): fires when at
    // least one EPIC-LEVEL non-planner source is live, OR (fn-703) when the
    // close verdict is a predicate-6.5 git kind (a quiescent done+pending
    // epic on a dirty repo, which holds NO live epic-level job). See the
    // JSDoc above for the full rule — a purely task-derived running close
    // row leaves the project_dir claim to the contributing task's own
    // pass-1 entry above, and a purely planner-derived close row is
    // filtered out by the outer `isRootOccupant` guard.
    const closeVerdict = perCloseRow.get(epic.epic_id);
    if (closeVerdict !== undefined && isRootOccupant(closeVerdict)) {
      const epicLevelRunning =
        anyEmbeddedJobWorking(epic.jobs) ||
        anyEmbeddedJobHasRunningSubagent(epic.jobs, subRunningByJobId);
      // fn-756: the fn-703 close-row git-verdict disjunct is REMOVED — the
      // close row no longer produces `git-uncommitted`/`git-orphans` (predicate
      // 6.5 deleted), so the only non-running occupant a close verdict can
      // carry past `isRootOccupant` is `dispatch-pending`.
      // fn-721: a `close::<epic_id>` closer was LAUNCHED but not yet bound, so
      // the close row renders `dispatch-pending` with NO live epic-level job —
      // `epicLevelRunning` is false. The launch-window occupancy is the epic's
      // OWN project_dir fact (the closer was launched against THIS epic), so it
      // must hold the epic's own root. Strictly scoped to
      // `effectiveRoot(null, projectDir)` — preserving the fn-655/fn-663
      // no-cross-root-phantom-lock narrowing.
      const closeRowDispatchPending =
        closeVerdict.tag === "blocked" &&
        closeVerdict.reason.kind === "dispatch-pending";
      if (epicLevelRunning || closeRowDispatchPending) {
        const root = effectiveRoot(null, projectDir);
        occupiedRoots.add(root);
      }
    }
  }

  // Demote a ready task to `single-task-per-root` (extracted so the legacy
  // single-pass and the fn-770 two-pass share one mutation site).
  const demoteTask = (taskId: string): void => {
    perTask.set(taskId, {
      tag: "blocked",
      reason: { kind: "single-task-per-root" },
    });
  };

  // Settle one ready TASK row against `occupiedRoots`: claim the (still-free)
  // root or demote. Shared by every pass-2 walk.
  const settleTask = (task: Task, projectDir: string | null): void => {
    const verdict = perTask.get(task.task_id);
    if (verdict === undefined || verdict.tag !== "ready") {
      return;
    }
    const root = effectiveRoot(stringOrNull(task.target_repo), projectDir);
    if (!occupiedRoots.has(root)) {
      occupiedRoots.add(root);
      return;
    }
    demoteTask(task.task_id);
  };

  // Settle the synthetic CLOSE row against `occupiedRoots`. Close uses the
  // epic's project_dir directly (no per-row `target_repo`) and is
  // eligibility-BLIND — a finalizer is never starved by the mutex layer.
  const settleCloseRow = (epic: Epic, projectDir: string | null): void => {
    const closeVerdict = perCloseRow.get(epic.epic_id);
    if (closeVerdict === undefined || closeVerdict.tag !== "ready") {
      return;
    }
    const root = effectiveRoot(null, projectDir);
    if (!occupiedRoots.has(root)) {
      occupiedRoots.add(root);
    } else {
      perCloseRow.set(epic.epic_id, {
        tag: "blocked",
        reason: { kind: "single-task-per-root" },
      });
    }
  };

  if (eligibleEpicIds === undefined) {
    // Pass 2 (legacy single-pass — yolo / tests / simulator): walk ready rows
    // in iteration order. First ready row per root wins the (still-unclaimed)
    // slot; subsequent ready rows are demoted. Byte-identical to pre-fn-770.
    for (const epic of epicsArr) {
      const projectDir = stringOrNull(epic.project_dir);
      for (const task of epic.tasks) {
        settleTask(task, projectDir);
      }
      settleCloseRow(epic, projectDir);
    }
    return;
  }

  // fn-770: Pass 2 — eligible-priority two-pass (armed mode). Pass-1's
  // `occupiedRoots` seed (live workers + `fallbackRoots`) is shared by both
  // sub-passes exactly as in the single-pass; only the discretionary ready
  // tiebreak becomes eligibility-aware. Physical occupancy is never
  // eligibility-conditional (pass-1 above is untouched), so an eligible task
  // never preempts a live worker — even an unarmed one.
  //
  // Pass-2a (priority): walk epics in iteration order. For each ELIGIBLE epic,
  // settle its ready TASK rows so they claim free roots before any ineligible
  // sibling. ALWAYS settle the ready CLOSE row here regardless of epic
  // eligibility — close is mode-exempt (always-eligible), so a finalizer beats
  // a same-root eligible task only when it sorts first, never loses to mode.
  for (const epic of epicsArr) {
    const projectDir = stringOrNull(epic.project_dir);
    if (eligibleEpicIds.has(epic.epic_id)) {
      for (const task of epic.tasks) {
        settleTask(task, projectDir);
      }
    }
    settleCloseRow(epic, projectDir);
  }

  // Pass-2b (residual): walk epics again; for INELIGIBLE epics settle their
  // ready TASK rows — they claim a root only if it's STILL unclaimed after
  // every eligible task + every close row took theirs, else demote. Close rows
  // are already settled in 2a; eligible epics' tasks are already settled in 2a.
  for (const epic of epicsArr) {
    if (eligibleEpicIds.has(epic.epic_id)) {
      continue;
    }
    const projectDir = stringOrNull(epic.project_dir);
    for (const task of epic.tasks) {
      settleTask(task, projectDir);
    }
  }
}

/**
 * Single-root key. `target_repo` wins when non-null AND non-empty; otherwise
 * we fall through to `project_dir`. Both null/empty produces `""` — the
 * "unknown root" bucket, which collapses every rootless row into one
 * per-root slot (the safe behavior — at most one rootless row gets
 * `ready`, the rest block).
 *
 * MUST mirror the reconciler's per-row root resolver in
 * `src/autopilot-worker.ts` (the `task.target_repo != null && ... !== ""`
 * branch near the dispatch walk) exactly:
 *
 *     t.target_repo != null && seg(t.target_repo) !== "" ? seg(t.target_repo) : projectDir
 */
function effectiveRoot(
  targetRepo: string | null,
  projectDir: string | null,
): string {
  if (targetRepo != null && targetRepo !== "") {
    return targetRepo;
  }
  return projectDir ?? "";
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

// ---------------------------------------------------------------------------
// Predicate 9 helper: cwd-then-global epic-dep resolver
// ---------------------------------------------------------------------------
//
// As of fn-637.1 the resolver, its supporting helpers (`projectBasename`,
// `epicIsCompleted`, `BARE_FN_PATTERN`), and the `EpicDepResolution` type
// live in `./epic-deps` so the SAME code path is shared with the reducer
// fold (fn-637.3) without an import cycle. The `resolveEpicDep` wall-clock
// wrapper near the top of this file preserves the legacy
// `new Date().toISOString()` behavior for readiness/board callers; the
// reducer goes straight to the leaf module with an event-derived
// timestamp.

// ---------------------------------------------------------------------------
// Epic header rollup
// ---------------------------------------------------------------------------

function rollupEpicHeader(
  epic: Epic,
  perTask: Map<string, Verdict>,
  perCloseRow: Map<string, Verdict>,
): Verdict {
  const closeVerdict = perCloseRow.get(epic.epic_id);

  // `[completed]` iff close-row is completed.
  if (closeVerdict !== undefined && closeVerdict.tag === "completed") {
    return { tag: "completed" };
  }

  // `[ready]` iff any task or close-row is ready.
  for (const task of epic.tasks) {
    const v = perTask.get(task.task_id);
    if (v !== undefined && v.tag === "ready") {
      return { tag: "ready" };
    }
  }
  if (closeVerdict !== undefined && closeVerdict.tag === "ready") {
    return { tag: "ready" };
  }

  // `[running]` iff any task or close-row is running — priority slots
  // between `ready` and `blocked`. Reason is the first running row's
  // reason in traversal order (pre-sorted tasks then close row).
  for (const task of epic.tasks) {
    const v = perTask.get(task.task_id);
    if (v !== undefined && v.tag === "running") {
      return { tag: "running", reason: v.reason };
    }
  }
  if (closeVerdict !== undefined && closeVerdict.tag === "running") {
    return { tag: "running", reason: closeVerdict.reason };
  }

  // Otherwise blocked — reason is the first non-completed row in traversal
  // order (pre-sorted tasks then close row).
  for (const task of epic.tasks) {
    const v = perTask.get(task.task_id);
    if (v === undefined) {
      return { tag: "blocked", reason: { kind: "unknown" } };
    }
    if (v.tag === "completed") {
      continue;
    }
    if (v.tag === "blocked") {
      return { tag: "blocked", reason: v.reason };
    }
    // Defensive: ready / running slipped past the early-returns — re-emit.
    return v;
  }

  if (closeVerdict === undefined) {
    return { tag: "blocked", reason: { kind: "unknown" } };
  }
  if (closeVerdict.tag === "blocked") {
    return { tag: "blocked", reason: closeVerdict.reason };
  }
  // Close-row is "ready" / "running" / "completed" — all caught above.
  // Defensive fall-through.
  return closeVerdict;
}

// ---------------------------------------------------------------------------
// Predicate helpers
// ---------------------------------------------------------------------------

/**
 * Predicate 3 (`planner-running`). Reads each link's `state` directly off
 * the embedded `JobLinkEntry` — schema v24 denormalized
 * `(title, state, last_api_error_at, last_api_error_kind)` off the linked
 * `jobs` row at the reducer's write boundary so this predicate no longer
 * needs to join against the live `jobs` page. Terminal sessions and
 * off-page live sessions used to fall through the join and silently
 * false-negative here (link.state was effectively unknown); now the
 * embedded `state` IS the projection's last-known reading and
 * `"working"` is dispositive.
 */
function anyJobLinkRunning(epic: Epic): boolean {
  for (const link of epic.job_links) {
    if (link.state === "working") {
      return true;
    }
  }
  return false;
}

/**
 * Discharge condition for the `planner-running` gate (predicate 3 at both
 * the task-row and close-row sites). Returns `true` once real work has
 * landed on the epic — any embedded worker job under a task, or an embedded
 * closer job at epic level.
 *
 * Rationale: `anyJobLinkRunning` reads the LIVE denormalized state of the
 * planner's creator/refiner `job_links` entry, which the reducer re-stamps
 * on every job-state write. A planner session that is restarted for followup
 * work (a different plan, or just chatting in the same session) flips back to
 * `working`, which would otherwise re-fire `planner-running` on every epic it
 * ever created — re-blocking an epic the planner already finished. Once a
 * worker (or closer) has been dispatched against the epic, the plan is
 * committed-to and the planner no longer gates it. Embedded jobs persist
 * across the worker's lifetime (they stay as `ended`/`killed`), so this latch
 * is sticky once set.
 *
 * The planner itself is a creator/refiner edge in `job_links`, never an
 * embedded `jobs[]` element, so a working planner never trips this check.
 * Pure over the projection — `epic.jobs` / `task.jobs` are folded facts, so
 * no schema or reducer change is involved.
 */
function epicWorkStarted(epic: Epic): boolean {
  if (epic.jobs !== undefined && epic.jobs.length > 0) {
    return true;
  }
  for (const task of epic.tasks) {
    if (task.jobs !== undefined && task.jobs.length > 0) {
      return true;
    }
  }
  return false;
}

function anyEmbeddedJobWorking(
  embedded: { state: string }[] | undefined,
): boolean {
  if (embedded === undefined) {
    return false;
  }
  for (const job of embedded) {
    if (job.state === "working") {
      return true;
    }
  }
  return false;
}

function anyEmbeddedJobHasRunningSubagent(
  embedded: { job_id: string }[] | undefined,
  subRunningByJobId: Map<string, SubagentInvocation[]>,
): boolean {
  if (embedded === undefined) {
    return false;
  }
  for (const job of embedded) {
    const hits = subRunningByJobId.get(job.job_id);
    if (hits !== undefined && hits.length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * fn-638.4: predicate 6 staleness companion to
 * {@link anyEmbeddedJobHasRunningSubagent}. Returns `true` iff every
 * surviving `running` `subagent_invocation` under the given embedded
 * jobs has `now - inv.ts > threshold`. Vacuous-truth on no running
 * sub-agents (the predicate-6 entry already excluded that case via
 * {@link anyEmbeddedJobHasRunningSubagent}; callers MUST gate on it
 * first). Threshold semantics match the reducer's bounded Stop guard:
 * strict `>` so the boundary tick (`now - inv.ts === threshold`)
 * doesn't yet flip the pill.
 *
 * "Every" (not "any") so a single fresh sub-agent on the same row keeps
 * the verdict at `sub-agent-running`. The point of `sub-agent-stale` is
 * "the only live work is suspect" — if even one sub-agent is fresh, the
 * row genuinely is making progress somewhere and the human shouldn't
 * see a stuck-orphan pill.
 */
function allRunningSubagentsAreStale(
  embedded: { job_id: string }[] | undefined,
  subRunningByJobId: Map<string, SubagentInvocation[]>,
  now: number,
  threshold: number,
): boolean {
  if (embedded === undefined) {
    return false;
  }
  for (const job of embedded) {
    const hits = subRunningByJobId.get(job.job_id);
    if (hits === undefined) {
      continue;
    }
    for (const inv of hits) {
      if (now - inv.ts <= threshold) {
        return false;
      }
    }
  }
  return true;
}

/**
 * fn-719 (task 2): predicate-6.6 entry — does any embedded job carry the
 * task-1 `has_live_worker_monitor` occupancy fact? `true` iff at least one
 * element has a TRUE (non-`undefined`, non-`false`) flag. A pre-v59 stored
 * element decodes the field as `undefined` → nullish-coalesced `false`, so
 * the historical log reads "no live monitor" exactly as a steady-state v59
 * install would before the session's next Stop re-stamps it.
 *
 * Provenance is already filtered at task 1: the reducer only stamps the flag
 * `true` for worker-launched `monitor`/`bash-bg` monitors — an `ambient`
 * session-watcher (e.g. the chatctl bus) NEVER sets it, so an ambient-only
 * job reads `false` here and stays dispatchable. Mirrors
 * {@link anyEmbeddedJobHasRunningSubagent} structurally.
 */
function anyEmbeddedJobHasLiveMonitor(
  embedded: { has_live_worker_monitor?: boolean }[] | undefined,
): boolean {
  if (embedded === undefined) {
    return false;
  }
  for (const job of embedded) {
    if (job.has_live_worker_monitor === true) {
      return true;
    }
  }
  return false;
}

/**
 * fn-719 (task 2): the soft-TTL staleness companion to
 * {@link anyEmbeddedJobHasLiveMonitor}. Returns `true` iff EVERY embedded job
 * carrying a live monitor has `now - updated_at > threshold` — i.e. the only
 * occupying monitors are all past the soft lease. A single fresh live-monitor
 * job keeps the verdict at `monitor-running` (the same "every, not any"
 * discipline as {@link allRunningSubagentsAreStale}: if any monitor's session
 * is still re-stamping `updated_at` per turn-end, the slot is genuinely live
 * somewhere). Vacuous-truth on no live-monitor jobs — callers MUST gate on
 * {@link anyEmbeddedJobHasLiveMonitor} first. Strict `>` so the boundary tick
 * doesn't yet flip the pill, matching the sub-agent split.
 *
 * Read-time, never folded: `now` is caller-injected and compared against the
 * embedded element's own `updated_at`; no `Date.now()` here.
 */
function allLiveMonitorsAreStale(
  embedded:
    | { has_live_worker_monitor?: boolean; updated_at: number }[]
    | undefined,
  now: number,
  threshold: number,
): boolean {
  if (embedded === undefined) {
    return false;
  }
  for (const job of embedded) {
    if (job.has_live_worker_monitor !== true) {
      continue;
    }
    if (now - job.updated_at <= threshold) {
      return false;
    }
  }
  return true;
}

/**
 * fn-719 (task 2): the load-bearing OCCUPANCY predicate for a live worker
 * monitor — `occupying = (monitor present) AND (snapshot not past the hard
 * ceiling)`. Returns `true` iff some embedded job carries the task-1
 * `has_live_worker_monitor` fact AND those monitors have NOT all aged past
 * {@link MONITOR_RELEASE_SEC} (the hard release ceiling). A `monitor-stale`
 * occupant (past the SOFT lease but within the ceiling) STILL occupies — the
 * staleness split is a visibility affordance, not a release.
 *
 * Used in BOTH seams so the predicate-1 terminal-completed gate and the
 * predicate-6.6 verdict release on the SAME boundary: if this returns false
 * (no monitor, or every monitor past the hard ceiling), predicate 1 is free
 * to collapse `done+approved` → `completed` and predicate 6.6 falls through —
 * a single notion of "this slot is held by a live monitor". Threading the
 * raw `anyEmbeddedJobHasLiveMonitor` into predicate 1 instead would wedge a
 * past-ceiling abandoned monitor at `job-pending` forever (still an
 * occupant), defeating the hard ceiling for the done+approved case.
 */
function embeddedMonitorOccupies(
  embedded:
    | { has_live_worker_monitor?: boolean; updated_at: number }[]
    | undefined,
  now: number,
): boolean {
  return (
    anyEmbeddedJobHasLiveMonitor(embedded) &&
    !allLiveMonitorsAreStale(embedded, now, MONITOR_RELEASE_SEC)
  );
}

/**
 * fn-638.4: close-row variant of
 * {@link anyEmbeddedJobHasRunningSubagent}, pooling the
 * epic-level jobs AND every ALREADY-COMPLETED task-level jobs sub-array.
 * Used by `evaluateCloseRow`'s predicate 6 so the close row stalls on any
 * surviving running sub-agent across either scope (mirroring the
 * existing close-row scan that was inlined as two separate calls before
 * the fn-638.4 stale-split). Returns `true` iff at least one running
 * sub-agent is present in any scope.
 *
 * fn-671: the task-level branch is normally unreachable — the per-task
 * predicate 1 holds a `done+approved` task at `running:sub-agent-running`/
 * `sub-agent-stale` whenever any sub-agent under its embedded jobs is
 * running, so a `completed` task can no longer carry a running sub-agent.
 * The completed-task scan is retained verbatim as a re-fold-determinism
 * backstop if the two states ever coexist again.
 *
 * The task-level scan is scoped to `completed` tasks via `perTask` for the
 * same reason as predicate 5's main scan: a not-yet-completed task is
 * already blocked-on by predicate 10's `dep-on-task`, so fanning its running
 * sub-agent onto the close row would mislabel a dependency-blocked close as
 * `running:sub-agent-running`.
 */
function closeRowHasRunningSubagent(
  epic: Epic,
  perTask: Map<string, Verdict>,
  subRunningByJobId: Map<string, SubagentInvocation[]>,
): boolean {
  if (anyEmbeddedJobHasRunningSubagent(epic.jobs, subRunningByJobId)) {
    return true;
  }
  for (const task of epic.tasks) {
    if (perTask.get(task.task_id)?.tag !== "completed") {
      continue;
    }
    if (anyEmbeddedJobHasRunningSubagent(task.jobs, subRunningByJobId)) {
      return true;
    }
  }
  return false;
}

/**
 * fn-638.4: close-row variant of {@link allRunningSubagentsAreStale},
 * pooling every contributing scope (epic-level close jobs + every
 * ALREADY-COMPLETED task's work jobs). Returns `true` iff EVERY surviving
 * running sub-agent across every scope is past `SUBAGENT_STALENESS_SEC` — one
 * fresh sub-agent anywhere keeps the verdict at `sub-agent-running`.
 * Callers MUST gate on `closeRowHasRunningSubagent` first; vacuous-
 * truth otherwise. The task-level scan is scoped to `completed` tasks via
 * `perTask` to mirror `closeRowHasRunningSubagent`'s scope exactly.
 */
function allCloseRowRunningSubagentsAreStale(
  epic: Epic,
  perTask: Map<string, Verdict>,
  subRunningByJobId: Map<string, SubagentInvocation[]>,
  now: number,
): boolean {
  if (
    !allRunningSubagentsAreStale(
      epic.jobs,
      subRunningByJobId,
      now,
      SUBAGENT_STALENESS_SEC,
    )
  ) {
    return false;
  }
  for (const task of epic.tasks) {
    if (perTask.get(task.task_id)?.tag !== "completed") {
      continue;
    }
    if (
      !allRunningSubagentsAreStale(
        task.jobs,
        subRunningByJobId,
        now,
        SUBAGENT_STALENESS_SEC,
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * fn-719 (task 2): close-row variant of {@link embeddedMonitorOccupies},
 * pooling every contributing scope (epic-level close jobs + every
 * ALREADY-COMPLETED task's work jobs) — the same scopes
 * {@link closeRowHasRunningSubagent} pools. Returns `true` iff SOME job in
 * any pooled scope carries a live monitor that is NOT past the hard
 * {@link MONITOR_RELEASE_SEC} ceiling. The task-level scan is scoped to
 * `completed` tasks via `perTask` so it mirrors the sub-agent close-row
 * scope exactly (a not-yet-completed task is already blocked-on by predicate
 * 10's `dep-on-task`).
 *
 * After fn-719's per-task predicate 1 + 6.6, a `done+approved` task with a
 * live monitor stays `running:monitor-*` (not `completed`), so the
 * completed-task scan here is normally unreachable — the PRIMARY value is
 * the epic-level close-verb monitor case (a `close` session that
 * backgrounded its own suite). The completed-task scan is retained as a
 * re-fold-determinism backstop, exactly like the sub-agent twin.
 */
function closeRowMonitorOccupies(
  epic: Epic,
  perTask: Map<string, Verdict>,
  now: number,
): boolean {
  if (embeddedMonitorOccupies(epic.jobs, now)) {
    return true;
  }
  for (const task of epic.tasks) {
    if (perTask.get(task.task_id)?.tag !== "completed") {
      continue;
    }
    if (embeddedMonitorOccupies(task.jobs, now)) {
      return true;
    }
  }
  return false;
}

/**
 * fn-719 (task 2): close-row variant of {@link allLiveMonitorsAreStale},
 * pooling every contributing scope (epic-level close jobs + every
 * ALREADY-COMPLETED task's work jobs). Returns `true` iff EVERY live monitor
 * across every pooled scope is past `MONITOR_STALENESS_SEC` — one fresh
 * monitor anywhere keeps the close row at `monitor-running`. Callers MUST
 * gate on {@link closeRowMonitorOccupies} first; vacuous-truth otherwise.
 * Same `completed`-scoped task scan as {@link closeRowMonitorOccupies}.
 */
function allCloseRowMonitorsAreStale(
  epic: Epic,
  perTask: Map<string, Verdict>,
  now: number,
): boolean {
  if (!allLiveMonitorsAreStale(epic.jobs, now, MONITOR_STALENESS_SEC)) {
    return false;
  }
  for (const task of epic.tasks) {
    if (perTask.get(task.task_id)?.tag !== "completed") {
      continue;
    }
    if (!allLiveMonitorsAreStale(task.jobs, now, MONITOR_STALENESS_SEC)) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Format helper
// ---------------------------------------------------------------------------

/**
 * Render the bracket pill for a verdict — `[ready]`, `[completed]`,
 * `[running:<kind>]`, or `[blocked:<reason>]`. String concerns isolated
 * here so the predicate pipeline never touches strings.
 */
export function formatPill(verdict: Verdict): string {
  if (verdict.tag === "ready") {
    return "[ready]";
  }
  if (verdict.tag === "completed") {
    return "[completed]";
  }
  if (verdict.tag === "running") {
    return `[running:${verdict.reason.kind}]`;
  }
  return `[blocked:${formatReasonShort(verdict.reason)}]`;
}

/**
 * The short form rendered inside the bracket pill. The `default` arm
 * narrows `reason` to `never` via the assertNever pattern — a future
 * `BlockReason` variant addition that forgets to add a case here is a
 * compile-time error, not a silent `unknown` fallback.
 */
function formatReasonShort(reason: BlockReason): string {
  switch (reason.kind) {
    case "job-rejected":
      return "job-rejected";
    case "job-pending":
      return "job-pending";
    case "epic-not-materialized":
      return "epic-not-materialized";
    case "epic-not-validated":
      return "epic-not-validated";
    case "git-uncommitted":
      return "git-uncommitted";
    case "git-orphans":
      return "git-orphans";
    case "dep-on-task":
      return `dep-on-task ${reason.upstream}`;
    case "dep-on-epic":
      // Cross-project provenance lives at the render layer — the
      // `cross_project` payload field carries the upstream's project
      // basename when it differs from the consumer's; renderer prefixes
      // the id with `<project>::`. Intra-project deps (`cross_project ==
      // null`) keep the bare-id render.
      return reason.cross_project === null
        ? `dep-on-epic ${reason.upstream}`
        : `dep-on-epic ${reason.cross_project}::${reason.upstream}`;
    case "dep-on-epic-dangling":
      return `dep-on-epic-dangling ${reason.upstream}`;
    case "single-task-per-epic":
      return "single-task-per-epic";
    case "single-task-per-root":
      return "single-task-per-root";
    case "epic-no-tasks":
      return "epic-no-tasks";
    case "dispatch-pending":
      return "dispatch-pending";
    case "unknown":
      return "unknown";
    default: {
      // Exhaustiveness guard. If a new BlockReason variant lands without
      // a case above, TypeScript will surface `reason` as the new variant
      // here (not narrowed to `never`), failing the type-check at build
      // time. Keeps a future fn-N addition from silently rendering
      // `unknown`.
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

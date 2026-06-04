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
 * Predicate pipeline — first-match-wins, fourteen ordered checks per row:
 *   1. terminal-completed          — task (fn-671): worker_phase==="done" && approval==="approved"
 *                                    AND no embedded job is `working` AND no
 *                                    running sub-agent under any embedded job.
 *                                    The two liveness clauses hold the verdict
 *                                    at `running:*` (predicate 5/6) until the
 *                                    Claude session is genuinely idle, so the
 *                                    per-epic and per-root mutexes stay held
 *                                    while the worker is still alive — mirrors
 *                                    predicate 7's race rationale.
 *                                    close: epic.status==="done" && epic.approval==="approved"
 *   2. epic-not-validated          — parent epic.last_validated_at == null
 *   3. planner-running             — any epic.job_links entry whose job is `working`
 *   4. own-approval-rejected       — task.approval==="rejected" → job-rejected
 *                                    (rejection is permanent regardless of session state, so it
 *                                    ranks ABOVE the session-running checks; pending is split off
 *                                    to predicate 7 so it cannot fire while a worker is still alive)
 *   5. own-progress-main           — task: any embedded jobs[] entry on this row state==="working"
 *                                    close: any embedded jobs[] entry on the epic OR on any ALREADY-COMPLETED
 *                                    task state==="working" (completed-scoped fan-in — see `evaluateCloseRow`)
 *   6. own-progress-sub            — task: any subagentInvocations row job_id===<this row's worker.session_id>
 *                                    && status==="running"
 *                                    close: same predicate but joined against worker session ids from
 *                                    epic-level AND every ALREADY-COMPLETED task's embedded jobs[]
 *   6.5. git-uncommitted / git-orphans
 *                                  — task (gated worker_phase==="done"): look up the live `git_status`
 *                                    row for `task.target_repo ?? epic.project_dir` via
 *                                    `gitStatusByProjectDir`; if its dirty_count > 0 → git-uncommitted,
 *                                    else if unattributed_to_live_count > 0 → git-orphans. Skipped
 *                                    when no entry exists for the root (no snapshot yet, or
 *                                    simulator's empty map) or worker_phase !== "done".
 *                                    close (gated epic.status==="done"): same idea keyed by
 *                                    `epic.project_dir`. Mechanical gate that lifts the inferred git
 *                                    cleanliness check out of /plan:approve's LLM cascade into
 *                                    keeper's deterministic readiness pipeline. Placed AFTER
 *                                    session-running (5/6) and BEFORE approval-pending (7) for the
 *                                    same race rationale as predicate 7: the gate must wait until
 *                                    every worker session and sub-agent is actually idle before
 *                                    sampling git state, otherwise mid-yield Stops produce stale
 *                                    dirty-tree readings that flap the pill. Reads off the live
 *                                    project-wide `git_status` row (not the embedded per-job count
 *                                    columns) — those columns freeze on terminal worker transition
 *                                    while the project's git state may have moved on.
 *                                    The block-reason `kind` is `git-orphans` (preserved for
 *                                    backward compatibility with autopilot's reason enumeration —
 *                                    `scripts/autopilot.ts:230,238,449` consume the literal
 *                                    string), but the underlying signal is the schema-v31
 *                                    `git_unattributed_to_live_count` column (the legacy v28
 *                                    "orphan" semantic preserved under its new name — dirty files
 *                                    no live session is on the hook for). The new strict-mystery
 *                                    `git_orphan_count` column (files with ZERO active
 *                                    attribution from any tracked session) is INFORMATIONAL ONLY
 *                                    at v31 — not a block reason, not a predicate; it surfaces in
 *                                    `scripts/git.ts` for human inspection. See the
 *                                    `gitStatusByProjectDir` doc on `computeReadiness` below for
 *                                    the column-name-vs-reason-kind divergence rationale.
 *   7. own-approval-pending        — task.approval==="pending" && status==="done" → job-pending
 *                                    close: epic.approval==="pending" && epic.status==="done" → job-pending
 *                                    Deliberately ranks BELOW 5/6: `worker_phase==="done"` is stamped
 *                                    by `planctl done` and can race ahead of the Claude session's
 *                                    Stop/SessionEnd, so `job-pending` must wait for the session
 *                                    (and any sub-agent) to actually be idle. Otherwise consumers
 *                                    (autopilot's approval-pending notify) fire prematurely while
 *                                    the worker is still in-flight.
 *   8. dep-on-task                 — any depends_on upstream NOT { tag:"completed" }
 *   9. dep-on-epic                 — any depends_on_epics upstream's close NOT completed
 *  10. dep-on-task-synthetic-close — for the synthetic close row: any non-completed task
 *  11. single-task-per-epic        — post-pass: one non-completed slot per epic
 *                                    Occupancy keys on `isLiveWorkOccupant`, which
 *                                    INCLUDES `planner-running` — a planner blocks its
 *                                    OWN epic from dispatching sibling tasks — AND the
 *                                    approval-pending git verdicts (git-uncommitted,
 *                                    git-orphans), so the whole done+pending window
 *                                    holds the slot (fn-703).
 *  12. single-task-per-root        — post-pass: one non-completed slot per project root
 *                                    Occupancy keys on `isRootOccupant`, which EXCLUDES
 *                                    `planner-running` (fn-663) — a planner does NOT
 *                                    claim the root, so a sibling epic's ready task on
 *                                    the same root may dispatch concurrently with a
 *                                    planner. Real workers (job-running,
 *                                    sub-agent-running, sub-agent-stale, job-pending)
 *                                    and the approval-pending git verdicts
 *                                    (git-uncommitted, git-orphans, fn-703) still claim.
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
 * - `job-rejected` / `job-pending`     — this row's own approval state.
 * - `epic-not-validated`               — parent epic has no `last_validated_at`.
 * - `git-uncommitted`                  — the live `git_status` row for this row's project root has
 *                                        `dirty_count > 0` (mechanical gate inserted at rank 6.5;
 *                                        payload-less by design — see the predicate-pipeline docstring
 *                                        for the rationale on placement).
 * - `git-orphans`                      — the live `git_status` row for this row's project root has
 *                                        `unattributed_to_live_count > 0` (mechanical gate inserted
 *                                        at rank 6.5; payload-less by design — complements
 *                                        `git-uncommitted` and fires when dirty count is zero but
 *                                        the project has dirty files no LIVE session is on the hook
 *                                        for). The reason kind string stays `git-orphans` for
 *                                        backward compatibility with autopilot's literal
 *                                        comparisons (`scripts/autopilot.ts:230,238,449`); the
 *                                        underlying column is the schema-v31 rename
 *                                        `git_unattributed_to_live_count` (legacy v28 "orphan"
 *                                        semantic preserved). The new strict-mystery
 *                                        `git_orphan_count` (zero-attribution from any session)
 *                                        is informational only at v31 and does not feed this kind.
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
 * - `unknown`                          — defensive default for verdict/renderer mismatch.
 */
export type BlockReason =
  | { kind: "job-rejected" }
  | { kind: "job-pending" }
  | { kind: "epic-not-validated" }
  | { kind: "git-uncommitted" }
  | { kind: "git-orphans" }
  | { kind: "dep-on-task"; upstream: string }
  | { kind: "dep-on-epic"; upstream: string; cross_project: string | null }
  | { kind: "dep-on-epic-dangling"; upstream: string }
  | { kind: "single-task-per-epic" }
  | { kind: "single-task-per-root" }
  | { kind: "epic-no-tasks" }
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
): ReadinessSnapshot {
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
    );
    perCloseRow.set(epic.epic_id, closeVerdict);
  }

  // Post-pass mutexes — mutate `perTask` / `perCloseRow` in board traversal
  // order. Per-epic FIRST so its tighter scope reports the reason when both
  // would apply; per-root SECOND over the same maps.
  applySingleTaskPerEpicMutex(epicsArr, perTask);
  applySingleTaskPerRootMutex(
    epicsArr,
    perTask,
    perCloseRow,
    subRunningByJobId,
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
  gitStatusByProjectDir: Map<
    string,
    { dirty_count: number; unattributed_to_live_count: number }
  >,
  // fn-638.4: caller-injected reference timestamp (unix seconds) for the
  // sub-agent staleness check at predicate 6. See `computeReadiness`'s
  // `now` doc for the determinism rationale.
  now: number,
): Verdict {
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
  if (
    task.worker_phase === "done" &&
    task.approval === "approved" &&
    !anyEmbeddedJobWorking(task.jobs) &&
    !anyEmbeddedJobHasRunningSubagent(task.jobs, subRunningByJobId)
  ) {
    return { tag: "completed" };
  }

  // 2. epic-not-validated.
  if (epic.last_validated_at == null) {
    return { tag: "blocked", reason: { kind: "epic-not-validated" } };
  }

  // 3. planner-running.
  if (anyJobLinkRunning(epic)) {
    return { tag: "running", reason: { kind: "planner-running" } };
  }

  // 4. own-approval-rejected — rejection is permanent regardless of session
  // state, so it ranks ABOVE the session-running checks. The `pending` half
  // of own-approval is split off to predicate 7 (below 5/6) so it cannot
  // fire while a worker session is still alive — see predicate 7's comment.
  if (task.approval === "rejected") {
    return { tag: "blocked", reason: { kind: "job-rejected" } };
  }

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

  // 6.5. git-uncommitted / git-orphans — mechanical gate that blocks autopilot's
  // /plan:approve dispatch when the worker's worktree has uncommitted dirty
  // files or the project has dirty files no live session is on the hook for.
  // Lifted from the /plan:approve skill's inferred LLM-as-judge cascade into
  // this deterministic predicate.
  //
  // Gated on `worker_phase==="done"` (planctl stamped `worker_done_at`): the
  // task hasn't reached the approval window before that, so the git state
  // can't matter yet. Placed between 6 and 7 for the same race rationale as
  // predicate 7: until every worker session AND every sub-agent is actually
  // idle, the git read could capture a mid-yield Stop's stale dirty-tree
  // reading and flap the pill.
  //
  // Source of counts: the live, project-wide `git_status` row keyed by
  // `task.target_repo ?? epic.project_dir` (mirrors `effectiveRoot`'s
  // task-row resolution). The per-job `git_dirty_count` /
  // `git_unattributed_to_live_count` columns on the embedded jobs[] are a
  // historical record of what each job's last live tick saw and freeze on
  // terminal transition — reading them here would produce false
  // `git-orphans` blocks against a since-clean tree. A missing map entry
  // (no `git_status` snapshot for this root yet, or the autopilot
  // simulator's deliberately-empty map) → skip the predicate and fall
  // through to 7.
  //
  // Schema-v31 rename: the `unattributed_to_live_count` field on the
  // readiness map sources the renamed `git_unattributed_to_live_count`
  // column (legacy v28 "orphan" semantic, preserved under the new
  // vocabulary — dirty files no LIVE session is on the hook for). The
  // block-reason kind is `git-orphans` (NOT renamed) for backward
  // compatibility with autopilot consumers — see `gitStatusByProjectDir`'s
  // doc on `computeReadiness` for the column-name-vs-reason-kind
  // divergence rationale.
  if (task.worker_phase === "done") {
    const root = task.target_repo ?? epic.project_dir;
    const gs = root === null ? undefined : gitStatusByProjectDir.get(root);
    if (gs !== undefined) {
      if (gs.dirty_count > 0) {
        return { tag: "blocked", reason: { kind: "git-uncommitted" } };
      }
      if (gs.unattributed_to_live_count > 0) {
        return { tag: "blocked", reason: { kind: "git-orphans" } };
      }
    }
  }

  // 7. own-approval-pending — deliberately ranks BELOW 5/6. `worker_phase`
  // flips to "done" when planctl stamps `worker_done_at`, which can race
  // ahead of the Claude session's Stop/SessionEnd (planctl `done` returns
  // before the session exits). If `job-pending` fired here without 5/6
  // clearing first, autopilot's approval-pending notify would page the
  // human while the worker is still in-flight — exactly the bug this
  // ordering exists to prevent. Once the session's embedded job state
  // leaves `working` AND every sub-agent invocation finishes, this
  // predicate fires and the notify lands at the right moment. The reducer's
  // Stop arm carries a sub-running guard that keeps `state='working'` across
  // a parent's mid-yield Stop while a sub-agent runs — without it the
  // sequence (Stop while sub running → SubagentStop → UPS-resume → Stop)
  // would dup-clear this predicate twice (see `src/reducer.ts` Stop arm).
  if (task.approval === "pending" && task.worker_phase === "done") {
    return { tag: "blocked", reason: { kind: "job-pending" } };
  }

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
  //   - `satisfied` — upstream is `status==="done" && approval==="approved"`;
  //     dependency met. Skip.
  //   - `blocked-incomplete` — upstream resolved but NOT done-and-approved.
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
  gitStatusByProjectDir: Map<
    string,
    { dirty_count: number; unattributed_to_live_count: number }
  >,
  // fn-638.4: caller-injected reference timestamp (unix seconds) for the
  // sub-agent staleness check at predicate 6. See `computeReadiness`'s
  // `now` doc for the determinism rationale.
  now: number,
): Verdict {
  // 1. terminal-completed (close-row variant).
  if (epic.status === "done" && epic.approval === "approved") {
    return { tag: "completed" };
  }

  // 2. epic-not-validated.
  if (epic.last_validated_at == null) {
    return { tag: "blocked", reason: { kind: "epic-not-validated" } };
  }

  // 3. planner-running.
  if (anyJobLinkRunning(epic)) {
    return { tag: "running", reason: { kind: "planner-running" } };
  }

  // 4. own-approval-rejected — the close row's own approval lives on the
  // EPIC. Rejection is permanent regardless of session state and stays at
  // rank 4; the `pending` half is split off to predicate 7 below the
  // session-running checks.
  if (epic.approval === "rejected") {
    return { tag: "blocked", reason: { kind: "job-rejected" } };
  }

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

  // 6.5. git-uncommitted / git-orphans — close-row variant. Gated on
  // `epic.status === "done"` (planctl stamped the epic-level done status):
  // the close row hasn't reached the approval window before that, so the
  // git state can't matter yet. Same placement rationale as the task path
  // (between 6 and 7 to avoid mid-yield Stop's stale dirty-tree readings).
  //
  // Source of counts: the live, project-wide `git_status` row keyed by
  // `epic.project_dir` (no per-row override on the synthetic close row).
  // Same rationale as the task path — the per-job `git_dirty_count` /
  // `git_unattributed_to_live_count` columns freeze on terminal transition;
  // the live `git_status` row is the honest source of truth.
  //
  // Schema-v31 rename: same column-name-vs-reason-kind divergence as the
  // task path — read `unattributed_to_live_count` (the renamed legacy v28
  // "orphan" column under its honest new name) but emit the unchanged
  // `git-orphans` reason kind for autopilot backward compatibility. See
  // the task path's predicate 6.5 comment and the `gitStatusByProjectDir`
  // doc on `computeReadiness` for the full rationale.
  if (epic.status === "done") {
    const gs =
      epic.project_dir === null
        ? undefined
        : gitStatusByProjectDir.get(epic.project_dir);
    if (gs !== undefined) {
      if (gs.dirty_count > 0) {
        return { tag: "blocked", reason: { kind: "git-uncommitted" } };
      }
      if (gs.unattributed_to_live_count > 0) {
        return { tag: "blocked", reason: { kind: "git-orphans" } };
      }
    }
  }

  // 7. own-approval-pending — close-row variant, mirrors the task path's
  // rationale: `epic.status` flips to "done" via the planctl close-verb
  // synthesis, which can race ahead of the close session's Stop/SessionEnd.
  // Placing this below 5/6 ensures `job-pending` only fires once every
  // close-verb AND work-verb session (and any sub-agent) is actually idle,
  // so autopilot's approval notify lands at the right moment.
  if (epic.approval === "pending" && epic.status === "done") {
    return { tag: "blocked", reason: { kind: "job-pending" } };
  }

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
  // planner-running, job-rejected, job-running / sub-agent-running,
  // git-uncommitted, job-pending) still wins.
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
 * regardless of iteration order. The set is the running/queued/approval-pending
 * states that represent ACTUAL ongoing worker activity OR an open
 * approval-pending window on a target — the states where dispatching another
 * job to the same scope would land us with two live workers on one target, or
 * jump a sibling ahead of an in-flight approval.
 *
 * Occupants:
 *   - every `running` verdict (job-running, sub-agent-running,
 *     sub-agent-stale, planner-running);
 *   - `job-pending` — the approval-pending notify window, ranked below the
 *     session-liveness checks (predicate 7);
 *   - `git-uncommitted` / `git-orphans` — the two predicate-6.5 git verdicts.
 *     These are sound occupants because predicate 6.5 is `worker_phase==="done"`-
 *     gated (:638) and ranks below predicate 1 (`completed`, requires approved)
 *     and predicate 4 (`job-rejected`), so a git verdict STRICTLY IMPLIES the
 *     done + approval-pending window — same administrative-state-vs-mutex race
 *     class as fn-671, one rank lower. Holding the slot keeps a depless ready
 *     sibling from jumping the queue while the dirty repo blocks the approve
 *     dispatch (fn-703).
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
    (verdict.tag === "blocked" &&
      (verdict.reason.kind === "job-pending" ||
        // fn-703: a git verdict ⟹ done + approval-pending window (predicate
        // 6.5 is done-gated and ranks below `completed`/`job-rejected`), so
        // the whole approval-pending window — not just the bare `job-pending`
        // pill — holds the mutex. Additive, placed AFTER `job-pending`; never
        // outranks `running`.
        verdict.reason.kind === "git-uncommitted" ||
        verdict.reason.kind === "git-orphans"))
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
 * (`job-running`, `sub-agent-running`, `sub-agent-stale`, `job-pending`) and
 * the approval-pending git verdicts (`git-uncommitted`, `git-orphans`) still
 * occupy via the `isLiveWorkOccupant` delegate (fn-703).
 *
 * The per-EPIC mutex deliberately stays on `isLiveWorkOccupant` — a planner
 * still blocks its OWN epic from dispatching sibling tasks (predicate 3
 * still fires at the per-task verdict layer, so the planner's own tasks
 * never read `ready` until the planner finishes).
 */
function isRootOccupant(verdict: Verdict): boolean {
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
 * fn-703 close-row mirror: the epic-level-running gate above does NOT cover a
 * quiescent done-but-unapproved epic on a dirty repo — predicate 6.5 renders
 * its close row `git-uncommitted` / `git-orphans` (gated on `epic.status ===
 * "done"`) with ZERO live epic-level job/sub-agent, so `epicLevelRunning` is
 * false yet the approval-pending window must still hold the epic's OWN root.
 * So the gate also claims when the close verdict is one of those two
 * predicate-6.5 git kinds. This stays strictly scoped to
 * `effectiveRoot(null, epic.project_dir)` — a git close row NEVER claims any
 * other root, so the fn-655/fn-663 cross-root phantom-lock narrowing is
 * preserved (the git state is the epic's own project_dir fact). Mirrors the
 * task-level fn-703 widening of `isLiveWorkOccupant`.
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
): void {
  const occupiedRoots = new Set<string>();

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
      // fn-703: a quiescent done-but-unapproved epic on a dirty repo renders
      // a close-row git verdict (predicate 6.5, gated on `epic.status ===
      // "done"`) with NO live epic-level job/sub-agent — so `epicLevelRunning`
      // is false and the running-derived claim above never fires, yet the
      // approval-pending window must still hold the epic's OWN root (the
      // close-row mirror of the task-level fn-703 fix). The git-verdict
      // disjunct claims on either of the two predicate-6.5 reason kinds.
      // Strictly scoped to `effectiveRoot(null, projectDir)` (the epic's own
      // project_dir) — it does NOT broaden to any other root, preserving the
      // fn-655/fn-663 narrowing that prevents cross-root phantom locks.
      const closeRowGitVerdict =
        closeVerdict.tag === "blocked" &&
        (closeVerdict.reason.kind === "git-uncommitted" ||
          closeVerdict.reason.kind === "git-orphans");
      if (epicLevelRunning || closeRowGitVerdict) {
        const root = effectiveRoot(null, projectDir);
        occupiedRoots.add(root);
      }
    }
  }

  // Pass 2: walk ready rows in iteration order. First ready row per root
  // wins the (still-unclaimed) slot; subsequent ready rows are demoted.
  for (const epic of epicsArr) {
    const projectDir = stringOrNull(epic.project_dir);

    for (const task of epic.tasks) {
      const verdict = perTask.get(task.task_id);
      if (verdict === undefined || verdict.tag !== "ready") {
        continue;
      }
      const root = effectiveRoot(stringOrNull(task.target_repo), projectDir);
      if (!occupiedRoots.has(root)) {
        occupiedRoots.add(root);
        continue;
      }
      perTask.set(task.task_id, {
        tag: "blocked",
        reason: { kind: "single-task-per-root" },
      });
    }

    // Close row uses the epic's project_dir directly (no per-row
    // `target_repo` on a synthetic close).
    const closeVerdict = perCloseRow.get(epic.epic_id);
    if (closeVerdict !== undefined && closeVerdict.tag === "ready") {
      const root = effectiveRoot(null, projectDir);
      if (!occupiedRoots.has(root)) {
        occupiedRoots.add(root);
      } else {
        perCloseRow.set(epic.epic_id, {
          tag: "blocked",
          reason: { kind: "single-task-per-root" },
        });
      }
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
 * MUST mirror `scripts/autopilot.ts:206-210` predicate exactly:
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

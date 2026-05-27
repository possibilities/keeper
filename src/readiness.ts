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
 *   1. terminal-completed          — task: status==="done" && approval==="approved"
 *                                    close: epic.status==="done" && epic.approval==="approved"
 *   2. epic-not-validated          — parent epic.last_validated_at == null
 *   3. planner-running             — any epic.job_links entry whose job is `working`
 *   4. own-approval-rejected       — task.approval==="rejected" → job-rejected
 *                                    (rejection is permanent regardless of session state, so it
 *                                    ranks ABOVE the session-running checks; pending is split off
 *                                    to predicate 7 so it cannot fire while a worker is still alive)
 *   5. own-progress-main           — task: any embedded jobs[] entry on this row state==="working"
 *                                    close: any embedded jobs[] entry on the epic OR on ANY of its
 *                                    tasks state==="working" (fan-out — see `evaluateCloseRow` for why)
 *   6. own-progress-sub            — task: any subagentInvocations row job_id===<this row's worker.session_id>
 *                                    && status==="running"
 *                                    close: same predicate but joined against worker session ids from
 *                                    epic-level AND every task-level embedded jobs[]
 *   6.5. git-uncommitted / git-orphans
 *                                  — task (gated worker_phase==="done"): look up the live `git_status`
 *                                    row for `task.target_repo ?? epic.project_dir` via
 *                                    `gitStatusByProjectDir`; if its dirty_count > 0 → git-uncommitted,
 *                                    else if orphan_count > 0 → git-orphans. Skipped when no entry
 *                                    exists for the root (no snapshot yet, or simulator's empty map)
 *                                    or worker_phase !== "done".
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
 *  12. single-task-per-root        — post-pass: one non-completed slot per project root
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
 *   - `[completed]` if close row verdict is `{ tag: "completed" }`.
 *   - `[ready]`     if any task or close row verdict is `{ tag: "ready" }`.
 *   - Otherwise `[blocked:<first non-completed row's reason in traversal order>]`.
 */

import type { Epic, Job, SubagentInvocation, Task } from "./types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Structured block reason — discriminated union with structured payloads so
 * consumers can branch on `kind` without parsing strings.
 *
 * - `job-rejected` / `job-pending`     — this row's own approval state.
 * - `epic-not-validated`               — parent epic has no `last_validated_at`.
 * - `planner-running`                  — a creator/refiner job for this epic is `working`.
 * - `job-running`                      — an embedded `jobs[]` entry on this row is `working`.
 * - `sub-agent-running`                — a sub-agent invocation for this row's worker is `running`.
 * - `git-uncommitted`                  — the live `git_status` row for this row's project root has
 *                                        `dirty_count > 0` (mechanical gate inserted at rank 6.5;
 *                                        payload-less by design — see the predicate-pipeline docstring
 *                                        for the rationale on placement).
 * - `git-orphans`                      — the live `git_status` row for this row's project root has
 *                                        `orphan_count > 0` (mechanical gate inserted at rank 6.5;
 *                                        payload-less by design — complements `git-uncommitted` and
 *                                        fires when dirty count is zero but the project has orphan
 *                                        files).
 * - `dep-on-task`                      — an upstream task is not completed (carries the upstream id).
 * - `dep-on-epic`                      — an upstream epic's close is not completed.
 * - `single-task-per-epic`             — lost the per-epic mutex (a sibling row in the same epic is non-completed).
 * - `single-task-per-root`             — lost the per-root mutex (a row in another epic in the same project root is non-completed).
 * - `unknown`                          — defensive default for verdict/renderer mismatch.
 */
export type BlockReason =
  | { kind: "job-rejected" }
  | { kind: "job-pending" }
  | { kind: "epic-not-validated" }
  | { kind: "planner-running" }
  | { kind: "job-running" }
  | { kind: "sub-agent-running" }
  | { kind: "git-uncommitted" }
  | { kind: "git-orphans" }
  | { kind: "dep-on-task"; upstream: string }
  | { kind: "dep-on-epic"; upstream: string }
  | { kind: "single-task-per-epic" }
  | { kind: "single-task-per-root" }
  | { kind: "unknown" };

export type Verdict =
  | { tag: "ready" }
  | { tag: "completed" }
  | { tag: "blocked"; reason: BlockReason };

/**
 * The full readiness snapshot — per-task, per-close-row (keyed by epic_id),
 * and per-epic-header (also keyed by epic_id). Renderer-side lookups that
 * miss should render `[blocked:unknown]` — visible (bug indicator) and inert
 * (autopilot won't dispatch on `unknown`).
 */
export interface ReadinessSnapshot {
  perTask: Map<string, Verdict>;
  perCloseRow: Map<string, Verdict>;
  perEpic: Map<string, Verdict>;
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
  gitStatusByProjectDir: Map<
    string,
    { dirty_count: number; orphan_count: number }
  > = new Map(),
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
    );
    perCloseRow.set(epic.epic_id, closeVerdict);
  }

  // Post-pass mutexes — mutate `perTask` / `perCloseRow` in board traversal
  // order. Per-epic FIRST so its tighter scope reports the reason when both
  // would apply; per-root SECOND over the same maps.
  applySingleTaskPerEpicMutex(epicsArr, perTask);
  applySingleTaskPerRootMutex(epicsArr, perTask, perCloseRow);

  // Epic header rollup.
  for (const epic of epicsArr) {
    perEpic.set(epic.epic_id, rollupEpicHeader(epic, perTask, perCloseRow));
  }

  return { perTask, perCloseRow, perEpic };
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
  // perCloseRow is unused for the task path but kept in the signature for
  // symmetry with `evaluateCloseRow`'s shape — both predicates take the
  // same "already-computed verdicts" handles.
  _perCloseRow: Map<string, Verdict>,
  gitStatusByProjectDir: Map<
    string,
    { dirty_count: number; orphan_count: number }
  >,
): Verdict {
  // 1. terminal-completed. Schema v19: read the derived worker-phase binary
  // under its new key — the legacy `status` was renamed to `worker_phase`
  // to free up `runtime_status` for the planctl-native enum. Semantics are
  // unchanged: `worker_done_at` present → `worker_phase === "done"`.
  if (task.worker_phase === "done" && task.approval === "approved") {
    return { tag: "completed" };
  }

  // 2. epic-not-validated.
  if (epic.last_validated_at == null) {
    return { tag: "blocked", reason: { kind: "epic-not-validated" } };
  }

  // 3. planner-running.
  if (anyJobLinkRunning(epic)) {
    return { tag: "blocked", reason: { kind: "planner-running" } };
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
    return { tag: "blocked", reason: { kind: "job-running" } };
  }

  // 6. own-progress-sub — sub-agent invocation under THIS row's worker
  // session. The worker session id is the embedded job's `job_id`; a task
  // may have zero or more workers. A single `running` invocation on any
  // worker blocks.
  if (anyEmbeddedJobHasRunningSubagent(task.jobs, subRunningByJobId)) {
    return { tag: "blocked", reason: { kind: "sub-agent-running" } };
  }

  // 6.5. git-uncommitted / git-orphans — mechanical gate that blocks autopilot's
  // /plan:approve dispatch when the worker's worktree has uncommitted dirty
  // files or the project has orphan files. Lifted from the /plan:approve
  // skill's inferred LLM-as-judge cascade into this deterministic predicate.
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
  // task-row resolution). The per-job `git_dirty_count`/`git_orphan_count`
  // columns are a historical record of what each job's last live tick saw
  // and freeze on terminal transition — reading them here would produce
  // false `git-orphans` blocks against a since-clean tree. A missing map
  // entry (no `git_status` snapshot for this root yet, or the autopilot
  // simulator's deliberately-empty map) → skip the predicate and fall
  // through to 7.
  if (task.worker_phase === "done") {
    const root = task.target_repo ?? epic.project_dir;
    const gs = root === null ? undefined : gitStatusByProjectDir.get(root);
    if (gs !== undefined) {
      if (gs.dirty_count > 0) {
        return { tag: "blocked", reason: { kind: "git-uncommitted" } };
      }
      if (gs.orphan_count > 0) {
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

  // 9. dep-on-epic — task-side rollup of the parent epic's dep list. An
  // absent-from-input upstream counts as SATISFIED (mirrors board.ts:296-297
  // convention: done+approved off the board). We re-evaluate against
  // perCloseRow inside applySingleRootMutex? No — close-row verdicts are
  // already computed for prior epics in iteration order, and a forward
  // dep (epic depends on a later epic) is rare; treat absent as satisfied.
  for (const upstreamEpic of epic.depends_on_epics) {
    const upstreamClose = _perCloseRow.get(upstreamEpic);
    if (upstreamClose === undefined) {
      continue; // satisfied — off the board
    }
    if (upstreamClose.tag !== "completed") {
      return {
        tag: "blocked",
        reason: { kind: "dep-on-epic", upstream: upstreamEpic },
      };
    }
  }

  // 10. dep-on-task-synthetic-close — not applicable to a real task.

  // 11. single-task-per-epic — deferred to applySingleTaskPerEpicMutex.
  // 12. single-task-per-root — deferred to applySingleTaskPerRootMutex.

  return { tag: "ready" };
}

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
    { dirty_count: number; orphan_count: number }
  >,
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
    return { tag: "blocked", reason: { kind: "planner-running" } };
  }

  // 4. own-approval-rejected — the close row's own approval lives on the
  // EPIC. Rejection is permanent regardless of session state and stays at
  // rank 4; the `pending` half is split off to predicate 7 below the
  // session-running checks.
  if (epic.approval === "rejected") {
    return { tag: "blocked", reason: { kind: "job-rejected" } };
  }

  // 5. own-progress-main — close-row blocks on a running worker session at
  // EITHER scope: epic-level (close-verb) embedded jobs, OR any task-level
  // (work-verb) embedded job on a task in this epic. The task-level scan
  // matters because predicate 1 (`evaluateTask`) marks a task `completed`
  // as soon as `worker_phase==="done" && approval==="approved"` — which
  // can race ahead of the worker session's Stop/SessionEnd (planctl can
  // record `worker_done_at` and the human can approve before the session
  // exits). Without this fan-out, predicate 10 sees every task `completed`
  // and the close row flips to `ready` while a worker is still alive.
  if (anyEmbeddedJobWorking(epic.jobs)) {
    return { tag: "blocked", reason: { kind: "job-running" } };
  }
  for (const task of epic.tasks) {
    if (anyEmbeddedJobWorking(task.jobs)) {
      return { tag: "blocked", reason: { kind: "job-running" } };
    }
  }

  // 6. own-progress-sub — sub-agent invocation under ANY worker session
  // bound to this epic (close-verb at epic level, work-verb at task level).
  // Same race as predicate 5: a task's worker can still be running a
  // sub-agent after planctl/human have driven the task to completed.
  if (anyEmbeddedJobHasRunningSubagent(epic.jobs, subRunningByJobId)) {
    return { tag: "blocked", reason: { kind: "sub-agent-running" } };
  }
  for (const task of epic.tasks) {
    if (anyEmbeddedJobHasRunningSubagent(task.jobs, subRunningByJobId)) {
      return { tag: "blocked", reason: { kind: "sub-agent-running" } };
    }
  }

  // 6.5. git-uncommitted / git-orphans — close-row variant. Gated on
  // `epic.status === "done"` (planctl stamped the epic-level done status):
  // the close row hasn't reached the approval window before that, so the
  // git state can't matter yet. Same placement rationale as the task path
  // (between 6 and 7 to avoid mid-yield Stop's stale dirty-tree readings).
  //
  // Source of counts: the live, project-wide `git_status` row keyed by
  // `epic.project_dir` (no per-row override on the synthetic close row).
  // Same rationale as the task path — the per-job `git_dirty_count`
  // /`git_orphan_count` columns freeze on terminal transition; the live
  // `git_status` row is the honest source of truth.
  if (epic.status === "done") {
    const gs =
      epic.project_dir === null
        ? undefined
        : gitStatusByProjectDir.get(epic.project_dir);
    if (gs !== undefined) {
      if (gs.dirty_count > 0) {
        return { tag: "blocked", reason: { kind: "git-uncommitted" } };
      }
      if (gs.orphan_count > 0) {
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
 * Per-epic mutex (predicate 11). Walk each epic's tasks in pre-sorted order.
 * The FIRST task whose verdict is non-completed claims the epic's slot;
 * every LATER task in the same epic with verdict `{ tag: "ready" }` is
 * mutated to `{ kind: "single-task-per-epic" }`. Rows already blocked
 * (dep-on-task, job-running, etc.) keep their more-specific reason.
 *
 * The "occupant" check counts ANY non-completed verdict (ready, working,
 * blocked-by-anything) — so a sibling task that is actively `job-running`
 * or `sub-agent-running` blocks later ready siblings within the same epic.
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
 * represent ACTUAL ongoing or imminent worker activity on a target — the
 * states where dispatching another job to the same scope would land us with
 * two live workers on the same target.
 *
 * Excluded: dependency blocks (`dep-on-task`, `dep-on-epic`), admin blocks
 * (`epic-not-validated`, `job-rejected`), repo-state blocks (`git-uncommitted`,
 * `git-orphans`), mutex-synthesized blocks (`single-task-per-epic`,
 * `single-task-per-root`), and `unknown` — none of those represent a live
 * worker that would conflict with a freshly-dispatched sibling.
 */
function isLiveWorkOccupant(verdict: Verdict): boolean {
  if (verdict.tag !== "blocked") {
    return false;
  }
  const kind = verdict.reason.kind;
  return (
    kind === "job-running" ||
    kind === "sub-agent-running" ||
    kind === "planner-running" ||
    kind === "job-pending"
  );
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
 * Per-root mutex (predicate 12). Walk every per-row verdict in board
 * traversal order (epics in input iteration order; per epic: pre-sorted
 * tasks then the synthetic close row). Key on the effective root:
 * `task.target_repo ?? epic.project_dir` (BOTH null AND empty-string fall
 * through to the next fallback — mirroring `scripts/autopilot.ts:206-210`
 * exactly). The FIRST non-completed row per root claims the slot; every
 * LATER row in the same root with verdict `{ tag: "ready" }` is mutated to
 * `{ kind: "single-task-per-root" }`. Same "any non-completed occupant"
 * rule as the per-epic pass — a sibling task in the same root that is
 * actively `job-running` (or any non-completed state) still blocks later
 * ready rows.
 *
 * Exported separately so the test suite can drive it with a hand-rolled
 * verdict map.
 */
export function applySingleTaskPerRootMutex(
  epicsArr: Epic[],
  perTask: Map<string, Verdict>,
  perCloseRow: Map<string, Verdict>,
): void {
  const occupiedRoots = new Set<string>();

  // Pass 1: every "live work" verdict (task OR close row) claims its
  // root regardless of iteration order relative to ready siblings in
  // other epics on the same root. See `isLiveWorkOccupant` — only
  // running/queued worker activity counts; dependency / mutex-synthesized
  // blocks do not, since they don't represent a live worker that would
  // conflict with a freshly-dispatched sibling.
  for (const epic of epicsArr) {
    const projectDir = stringOrNull(epic.project_dir);

    for (const task of epic.tasks) {
      const verdict = perTask.get(task.task_id);
      if (verdict === undefined || !isLiveWorkOccupant(verdict)) {
        continue;
      }
      const root = effectiveRoot(stringOrNull(task.target_repo), projectDir);
      occupiedRoots.add(root);
    }

    const closeVerdict = perCloseRow.get(epic.epic_id);
    if (closeVerdict !== undefined && isLiveWorkOccupant(closeVerdict)) {
      const root = effectiveRoot(null, projectDir);
      occupiedRoots.add(root);
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
    // Defensive: ready slipped past the early-return — re-emit.
    return { tag: "ready" };
  }

  if (closeVerdict === undefined) {
    return { tag: "blocked", reason: { kind: "unknown" } };
  }
  if (closeVerdict.tag === "blocked") {
    return { tag: "blocked", reason: closeVerdict.reason };
  }
  // Close-row is "ready" — already caught above; or "completed" — already
  // caught above. Defensive fall-through.
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

// ---------------------------------------------------------------------------
// Format helper
// ---------------------------------------------------------------------------

/**
 * Render the bracket pill for a verdict — `[ready]`, `[completed]`, or
 * `[blocked:<reason>]`. String concerns isolated here so the predicate
 * pipeline never touches strings.
 */
export function formatPill(verdict: Verdict): string {
  if (verdict.tag === "ready") {
    return "[ready]";
  }
  if (verdict.tag === "completed") {
    return "[completed]";
  }
  return `[blocked:${formatReasonShort(verdict.reason)}]`;
}

/** The short form rendered inside the bracket pill. */
function formatReasonShort(reason: BlockReason): string {
  switch (reason.kind) {
    case "job-rejected":
      return "job-rejected";
    case "job-pending":
      return "job-pending";
    case "epic-not-validated":
      return "epic-not-validated";
    case "planner-running":
      return "planner-running";
    case "job-running":
      return "job-running";
    case "sub-agent-running":
      return "sub-agent-running";
    case "git-uncommitted":
      return "git-uncommitted";
    case "git-orphans":
      return "git-orphans";
    case "dep-on-task":
      return `dep-on-task ${reason.upstream}`;
    case "dep-on-epic":
      return `dep-on-epic ${reason.upstream}`;
    case "single-task-per-epic":
      return "single-task-per-epic";
    case "single-task-per-root":
      return "single-task-per-root";
    case "unknown":
      return "unknown";
  }
}

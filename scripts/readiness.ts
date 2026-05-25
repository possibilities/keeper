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
 * Predicate pipeline — first-match-wins, ten ordered checks per row:
 *   1. terminal-completed          — task: status==="done" && approval==="approved"
 *                                    close: epic.status==="done" && epic.approval==="approved"
 *   2. epic-not-validated          — parent epic.last_validated_at == null
 *   3. planner-running             — any epic.job_links entry whose job is `working`
 *   4. own-approval                — task.approval==="rejected" → job-rejected
 *                                    task.approval==="pending" && status==="done" → job-pending
 *   5. own-progress-main           — any embedded jobs[] entry on this row state==="working"
 *   6. own-progress-sub            — any subagentInvocations row job_id===<worker.session_id>
 *                                    && status==="running"
 *   7. dep-on-task                 — any depends_on upstream NOT { tag:"completed" }
 *   8. dep-on-epic                 — any depends_on_epics upstream's close NOT completed
 *   9. dep-on-task-synthetic-close — for the synthetic close row: any non-completed task
 *  10. single-root                 — post-pass: only one row per project root may be `ready`
 *
 * Single-root runs as a separate pass (`applySingleRootMutex`) over the
 * per-row verdicts in board traversal order — never folded into per-row
 * evaluation, so iteration order is the only determinism gate.
 *
 * Epic header rollup (after per-row + single-root):
 *   - `[completed]` if close row verdict is `{ tag: "completed" }`.
 *   - `[ready]`     if any task or close row verdict is `{ tag: "ready" }`.
 *   - Otherwise `[blocked:<first non-completed row's reason in traversal order>]`.
 */

import type { Epic, Job, SubagentInvocation, Task } from "../src/types";

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
 * - `dep-on-task`                      — an upstream task is not completed (carries the upstream id).
 * - `dep-on-epic`                      — an upstream epic's close is not completed.
 * - `single-root`                      — lost the single-root post-pass mutex.
 * - `unknown`                          — defensive default for verdict/renderer mismatch.
 */
export type BlockReason =
  | { kind: "job-rejected" }
  | { kind: "job-pending" }
  | { kind: "epic-not-validated" }
  | { kind: "planner-running" }
  | { kind: "job-running" }
  | { kind: "sub-agent-running" }
  | { kind: "dep-on-task"; upstream: string }
  | { kind: "dep-on-epic"; upstream: string }
  | { kind: "single-root" }
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
 * via the 10-predicate pipeline (first-match-wins), then the synthetic
 * close-row verdict, then the epic header rollup. After the per-row pass,
 * `applySingleRootMutex` mutates the verdict maps for the single-root
 * predicate.
 *
 * Inputs are keyed by id; both maps and arrays are accepted (an iterable
 * with stable order suffices). The function never mutates its inputs.
 */
export function computeReadiness(
  epics: Iterable<Epic>,
  jobs: Map<string, Job>,
  subagentInvocations: Iterable<SubagentInvocation>,
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
      );
      perTask.set(task.task_id, verdict);
    }

    // Synthetic close-row verdict.
    const closeVerdict = evaluateCloseRow(
      epic,
      jobs,
      subRunningByJobId,
      perTask,
    );
    perCloseRow.set(epic.epic_id, closeVerdict);
  }

  // Single-root post-pass — mutates `perTask` / `perCloseRow` in board
  // traversal order, then we recompute the epic header rollup using the
  // post-mutex state.
  applySingleRootMutex(epicsArr, perTask, perCloseRow);

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
  jobs: Map<string, Job>,
  subRunningByJobId: Map<string, SubagentInvocation[]>,
  perTask: Map<string, Verdict>,
  // perCloseRow is unused for the task path but kept in the signature for
  // symmetry with `evaluateCloseRow`'s shape — both predicates take the
  // same "already-computed verdicts" handles.
  _perCloseRow: Map<string, Verdict>,
): Verdict {
  // 1. terminal-completed.
  if (task.status === "done" && task.approval === "approved") {
    return { tag: "completed" };
  }

  // 2. epic-not-validated.
  if (epic.last_validated_at == null) {
    return { tag: "blocked", reason: { kind: "epic-not-validated" } };
  }

  // 3. planner-running.
  if (anyJobLinkRunning(epic, jobs)) {
    return { tag: "blocked", reason: { kind: "planner-running" } };
  }

  // 4. own-approval — rejected ranks ABOVE pending.
  if (task.approval === "rejected") {
    return { tag: "blocked", reason: { kind: "job-rejected" } };
  }
  if (task.approval === "pending" && task.status === "done") {
    return { tag: "blocked", reason: { kind: "job-pending" } };
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

  // 7. dep-on-task — any upstream NOT `{ tag: "completed" }`. The pre-sorted
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

  // 8. dep-on-epic — task-side rollup of the parent epic's dep list. An
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

  // 9. dep-on-task-synthetic-close — not applicable to a real task.

  // 10. single-root — deferred to applySingleRootMutex.

  return { tag: "ready" };
}

function evaluateCloseRow(
  epic: Epic,
  jobs: Map<string, Job>,
  subRunningByJobId: Map<string, SubagentInvocation[]>,
  perTask: Map<string, Verdict>,
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
  if (anyJobLinkRunning(epic, jobs)) {
    return { tag: "blocked", reason: { kind: "planner-running" } };
  }

  // 4. own-approval — the close row's own approval lives on the EPIC.
  if (epic.approval === "rejected") {
    return { tag: "blocked", reason: { kind: "job-rejected" } };
  }
  if (epic.approval === "pending" && epic.status === "done") {
    return { tag: "blocked", reason: { kind: "job-pending" } };
  }

  // 5. own-progress-main — close-row uses epic-level embedded jobs (close
  // verb).
  if (anyEmbeddedJobWorking(epic.jobs)) {
    return { tag: "blocked", reason: { kind: "job-running" } };
  }

  // 6. own-progress-sub — sub-agent invocation under the close worker's
  // session id.
  if (anyEmbeddedJobHasRunningSubagent(epic.jobs, subRunningByJobId)) {
    return { tag: "blocked", reason: { kind: "sub-agent-running" } };
  }

  // 7. dep-on-task — not applicable to the close row (it has no direct
  // task deps; predicate 9 below synthesizes those from the epic's tasks).

  // 8. dep-on-epic — also not applicable to the close row (the spec
  // assigns cross-epic deps to the task rows; the close row's deps
  // cascade transitively through tasks).

  // 9. dep-on-task-synthetic-close — every real task in the epic must be
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

  // 10. single-root — deferred.

  return { tag: "ready" };
}

// ---------------------------------------------------------------------------
// Single-root post-pass
// ---------------------------------------------------------------------------

/**
 * Walk every per-row verdict in board traversal order (epics in input
 * iteration order; per epic: pre-sorted tasks then the synthetic close
 * row). For each row that is currently `{ tag: "ready" }`, key on the
 * effective root: `task.target_repo ?? epic.project_dir` (BOTH null AND
 * empty-string fall through to the next fallback — mirroring
 * `scripts/autopilot.ts:206-210` exactly). The first row per root keeps
 * `ready`; every later row in the same root becomes
 * `{ tag: "blocked", reason: { kind: "single-root" } }`.
 *
 * Exported separately so the test suite can drive it with a hand-rolled
 * verdict map.
 */
export function applySingleRootMutex(
  epicsArr: Epic[],
  perTask: Map<string, Verdict>,
  perCloseRow: Map<string, Verdict>,
): void {
  const seenRoots = new Set<string>();

  for (const epic of epicsArr) {
    const projectDir = stringOrNull(epic.project_dir);

    for (const task of epic.tasks) {
      const verdict = perTask.get(task.task_id);
      if (verdict === undefined || verdict.tag !== "ready") {
        continue;
      }
      const root = effectiveRoot(stringOrNull(task.target_repo), projectDir);
      if (seenRoots.has(root)) {
        perTask.set(task.task_id, {
          tag: "blocked",
          reason: { kind: "single-root" },
        });
      } else {
        seenRoots.add(root);
      }
    }

    // Close row uses the epic's project_dir directly (no per-row
    // `target_repo` on a synthetic close).
    const closeVerdict = perCloseRow.get(epic.epic_id);
    if (closeVerdict !== undefined && closeVerdict.tag === "ready") {
      const root = effectiveRoot(null, projectDir);
      if (seenRoots.has(root)) {
        perCloseRow.set(epic.epic_id, {
          tag: "blocked",
          reason: { kind: "single-root" },
        });
      } else {
        seenRoots.add(root);
      }
    }
  }
}

/**
 * Single-root key. `target_repo` wins when non-null AND non-empty; otherwise
 * we fall through to `project_dir`. Both null/empty produces `""` — the
 * "unknown root" bucket, which collapses every rootless row into one
 * single-root slot (the safe behavior — at most one rootless row gets
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

function anyJobLinkRunning(epic: Epic, jobs: Map<string, Job>): boolean {
  for (const link of epic.job_links) {
    const job = jobs.get(link.job_id);
    if (job !== undefined && job.state === "working") {
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
    case "dep-on-task":
      return `dep-on-task ${reason.upstream}`;
    case "dep-on-epic":
      return `dep-on-epic ${reason.upstream}`;
    case "single-root":
      return "single-root";
    case "unknown":
      return "unknown";
  }
}


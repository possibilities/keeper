/**
 * Pure-function tests for `src/readiness.ts` — exercises the 11-predicate
 * pipeline + two post-pass mutexes (per-epic, per-root) + epic header rollup
 * directly. No DB, no reducer, no migration: build `Epic[]` / `Job` map /
 * `SubagentInvocation[]` fixtures inline and assert verdict map equality.
 *
 * Coverage tracks `task.spec` Test notes:
 *   - Predicate-ordering matrix (every ordering edge that matters).
 *   - Per-epic mutex (multi-task-in-epic, non-completed occupant rule).
 *   - Per-root mutex (multi-root, single-root collapse, empty-string
 *     fallback, non-completed occupant rule, cross-epic same-root collision).
 *   - Ordering between the two post-passes (tighter scope wins).
 *   - Epic header rollup edge cases (zero-task, all-completed-except-close,
 *     mixed states).
 *   - Missing-input defensive defaults (verdict lookup miss).
 *   - Dep-absent-from-collection semantics.
 *   - subagent_invocations status filter (running blocks, anything else doesn't).
 */

import { expect, test } from "bun:test";
import {
  applySingleTaskPerEpicMutex,
  applySingleTaskPerRootMutex,
  type BlockReason,
  computeReadiness,
  formatPill,
  type Verdict,
} from "../src/readiness";
import type {
  EmbeddedJob,
  Epic,
  Job,
  JobLinkEntry,
  SubagentInvocation,
  Task,
} from "../src/types";

// ---------------------------------------------------------------------------
// Fixture builders — minimal, no defaults pollution
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task>): Task {
  return {
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    task_number: 1,
    title: "task",
    target_repo: null,
    // Schema v19: `status` renamed to `worker_phase` (derived binary —
    // open|done) and `runtime_status` added (planctl-native enum, default
    // "todo"). Both ride inside the embedded element on the parent epic's
    // `tasks` array.
    worker_phase: "open",
    runtime_status: "todo",
    approval: "pending",
    depends_on: [],
    jobs: [],
    ...overrides,
  };
}

function makeEpic(overrides: Partial<Epic>): Epic {
  return {
    epic_id: "fn-1-foo",
    epic_number: 1,
    title: "epic",
    project_dir: "/repo",
    status: "open",
    approval: "pending",
    last_event_id: 0,
    updated_at: 0,
    depends_on_epics: [],
    tasks: [],
    jobs: [],
    job_links: [],
    last_validated_at: "2026-05-24T00:00:00Z",
    ...overrides,
  };
}

// `makeJob` (formerly built `Job` fixture rows for the planner-running
// predicate's live-jobs Map join) is gone with schema v21 — the
// `JobLinkEntry.state` field carries the linked session's last-known
// lifecycle directly off the projection, so the predicate no longer
// reads from a `jobs` Map. See `makeLink` below for the v21 fixture
// shape.

function makeEmbeddedJob(overrides: Partial<EmbeddedJob>): EmbeddedJob {
  return {
    job_id: "session-1",
    plan_verb: "work",
    state: "working",
    title: null,
    created_at: 0,
    updated_at: 0,
    last_event_id: 0,
    last_api_error_at: null,
    last_api_error_kind: null,
    last_input_request_at: null,
    last_input_request_kind: null,
    ...overrides,
  };
}

function makeSub(overrides: Partial<SubagentInvocation>): SubagentInvocation {
  return {
    job_id: "session-1",
    agent_id: "agent-1",
    turn_seq: 0,
    ts: 0,
    tool_use_id: null,
    subagent_type: null,
    description: null,
    prompt_chars: 0,
    status: "running",
    duration_ms: null,
    last_event_id: 0,
    updated_at: 0,
    ...overrides,
  };
}

/**
 * Build a `JobLinkEntry` with the schema-v25 widened shape
 * `{kind, job_id, title, state, last_api_error_at, last_api_error_kind,
 * last_input_request_at, last_input_request_kind}` — defaults match the
 * reducer's `enrichJobLink` orphan-row defaults (`title: null,
 * state: "stopped", last_api_error_at: null, last_api_error_kind: null,
 * last_input_request_at: null, last_input_request_kind: null`) so a
 * caller that overrides only `kind` + `job_id` exercises the common
 * "session not running" path.
 */
function makeLink(overrides: Partial<JobLinkEntry>): JobLinkEntry {
  return {
    kind: "refiner",
    job_id: "session-1",
    title: null,
    state: "stopped",
    last_api_error_at: null,
    last_api_error_kind: null,
    last_input_request_at: null,
    last_input_request_kind: null,
    ...overrides,
  };
}

function blocked(reason: BlockReason): Verdict {
  return { tag: "blocked", reason };
}

function run(
  epics: Epic[],
  jobs: Map<string, Job> = new Map(),
  subs: SubagentInvocation[] = [],
) {
  return computeReadiness(epics, jobs, subs);
}

// ---------------------------------------------------------------------------
// Predicate-ordering matrix
// ---------------------------------------------------------------------------

test("predicate 1 (terminal-completed) wins over 5 (own-progress-main)", () => {
  // A completed task whose embedded job hasn't transitioned to `stopped` yet.
  const task = makeTask({
    worker_phase: "done",
    approval: "approved",
    jobs: [makeEmbeddedJob({ state: "working" })],
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual({ tag: "completed" });
});

test("predicate 1 wins over 2 (epic-not-validated)", () => {
  const task = makeTask({ worker_phase: "done", approval: "approved" });
  const epic = makeEpic({ tasks: [task], last_validated_at: null });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual({ tag: "completed" });
});

test("predicate 2 (epic-not-validated) wins over 3 (planner-running)", () => {
  const task = makeTask({});
  const epic = makeEpic({
    tasks: [task],
    last_validated_at: null,
    // Schema v21: state lives on the embedded JobLinkEntry — no
    // separate `jobs` Map join. Set state=working to exercise the
    // planner-running candidate, then assert the higher-priority
    // epic-not-validated predicate still wins.
    job_links: [makeLink({ job_id: "planner-job", state: "working" })],
  });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual(
    blocked({ kind: "epic-not-validated" }),
  );
});

test("predicate 3 (planner-running) wins over 4 (own-approval-rejected)", () => {
  // Even an approved+done task blocks when a planner is working on the epic.
  // (Predicate 1 doesn't fire because approval is `pending`, not `approved`.)
  const task = makeTask({ worker_phase: "open", approval: "approved" });
  const epic = makeEpic({
    tasks: [task],
    job_links: [
      makeLink({ kind: "creator", job_id: "planner-job", state: "working" }),
    ],
  });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual(
    blocked({ kind: "planner-running" }),
  );
});

test("predicate 4 own-approval-rejected: job-rejected fires for a done+rejected task", () => {
  // Rejection is permanent regardless of session state, so rejected ranks
  // above 5/6/7. The `pending` half lives at predicate 7 and is exercised
  // separately below.
  const task = makeTask({ worker_phase: "done", approval: "rejected" });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual(
    blocked({ kind: "job-rejected" }),
  );
});

test("predicate 4 (own-approval-rejected) wins over 5 (own-progress-main)", () => {
  // A rejected task whose worker is still running shows `job-rejected` —
  // rejection is the terminal verdict on this row regardless of session
  // state.
  const task = makeTask({
    worker_phase: "open",
    approval: "rejected",
    jobs: [makeEmbeddedJob({ state: "working" })],
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual(
    blocked({ kind: "job-rejected" }),
  );
});

test("predicate 5 (own-progress-main) wins over 7 (own-approval-pending)", () => {
  // The regression this guards: `worker_phase` flips to "done" when
  // planctl stamps `worker_done_at`, which can race ahead of the Claude
  // session's Stop/SessionEnd. If `job-pending` fired at the old rank-4
  // position, autopilot's approval notify would page the human while the
  // worker is still in-flight. The worker-still-running row reports
  // `job-running`, NOT `job-pending`.
  const task = makeTask({
    worker_phase: "done",
    approval: "pending",
    jobs: [makeEmbeddedJob({ state: "working" })],
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual(
    blocked({ kind: "job-running" }),
  );
});

test("predicate 6 (own-progress-sub) wins over 7 (own-approval-pending)", () => {
  // Same race as predicate 5 above, but the live work is a sub-agent
  // invocation rather than the worker session itself. Until every
  // sub-agent finishes, `job-pending` is held back.
  const task = makeTask({
    worker_phase: "done",
    approval: "pending",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [task] });
  const subs = [makeSub({ job_id: "worker-1", status: "running" })];
  const snap = run([epic], new Map(), subs);
  expect(snap.perTask.get(task.task_id)).toEqual(
    blocked({ kind: "sub-agent-running" }),
  );
});

test("predicate 7 (own-approval-pending) fires once the worker session is idle", () => {
  // Worker has stopped (embedded job state="stopped"), no sub-agents
  // running, approval still pending — this is the moment autopilot is
  // allowed to page the human.
  const task = makeTask({
    worker_phase: "done",
    approval: "pending",
    jobs: [makeEmbeddedJob({ state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual(
    blocked({ kind: "job-pending" }),
  );
});

test("close row: predicate 5 (own-progress-main) wins over 7 (own-approval-pending)", () => {
  // Close-row variant of the same race. Epic.status==="done" can be
  // synthesized while the close-verb session is still alive; the close
  // row must not flip to `job-pending` until that session is idle.
  const epic = makeEpic({
    status: "done",
    approval: "pending",
    jobs: [makeEmbeddedJob({ state: "working" })],
  });
  const snap = run([epic]);
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    blocked({ kind: "job-running" }),
  );
});

test("predicate 5 (own-progress-main) wins over 6 (own-progress-sub)", () => {
  // Main + sub both running — predicate 5 listed first.
  const task = makeTask({
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "working" })],
  });
  const epic = makeEpic({ tasks: [task] });
  const subs = [makeSub({ job_id: "worker-1", status: "running" })];
  const snap = run([epic], new Map(), subs);
  expect(snap.perTask.get(task.task_id)).toEqual(
    blocked({ kind: "job-running" }),
  );
});

test("predicate 6 (own-progress-sub) wins over 8 (dep-on-task)", () => {
  // This row's sub-agent running. Upstream completed. Sub still blocks.
  const upstream = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
  });
  const dependent = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    depends_on: ["fn-1-foo.1"],
    jobs: [makeEmbeddedJob({ job_id: "worker-2", state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [upstream, dependent] });
  const subs = [makeSub({ job_id: "worker-2", status: "running" })];
  const snap = run([epic], new Map(), subs);
  expect(snap.perTask.get(dependent.task_id)).toEqual(
    blocked({ kind: "sub-agent-running" }),
  );
});

test("predicate 8 (dep-on-task) wins over 9 (dep-on-epic)", () => {
  // Task depends on a non-completed sibling; the EPIC also has a non-completed
  // upstream epic. Task-dep should win.
  const upstreamEpic = makeEpic({
    epic_id: "fn-0-bar",
    epic_number: 0,
    title: "bar",
    project_dir: "/other",
    status: "open",
    approval: "pending",
    tasks: [],
  });
  const upstreamTask = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "open",
  });
  const dependent = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    depends_on: ["fn-1-foo.1"],
  });
  const epic = makeEpic({
    tasks: [upstreamTask, dependent],
    depends_on_epics: ["fn-0-bar"],
  });
  const snap = run([upstreamEpic, epic]);
  expect(snap.perTask.get(dependent.task_id)).toEqual(
    blocked({ kind: "dep-on-task", upstream: "fn-1-foo.1" }),
  );
});

test("predicate 9 (dep-on-epic) wins over 12 (single-task-per-root)", () => {
  // The dependent epic's task would otherwise compete for per-root with
  // the upstream epic's task; dep-on-epic should win.
  const upstreamEpic = makeEpic({
    epic_id: "fn-0-bar",
    epic_number: 0,
    title: "bar",
    project_dir: "/repo",
    status: "open",
    approval: "pending",
    tasks: [makeTask({ task_id: "fn-0-bar.1", epic_id: "fn-0-bar" })],
  });
  const dependent = makeTask({
    task_id: "fn-1-foo.1",
    depends_on: [],
  });
  const epic = makeEpic({
    tasks: [dependent],
    depends_on_epics: ["fn-0-bar"],
    project_dir: "/repo",
  });
  const snap = run([upstreamEpic, epic]);
  // Upstream task is ready; dependent task should be dep-on-epic blocked.
  expect(snap.perTask.get("fn-0-bar.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get(dependent.task_id)).toEqual(
    blocked({ kind: "dep-on-epic", upstream: "fn-0-bar" }),
  );
});

// ---------------------------------------------------------------------------
// Per-epic post-pass (predicate 11)
// ---------------------------------------------------------------------------

test("per-epic: two ready tasks in same epic → first wins, second blocks single-task-per-epic", () => {
  const t1 = makeTask({ task_id: "fn-1-foo.1", target_repo: "/r" });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    target_repo: "/r",
  });
  const epic = makeEpic({ tasks: [t1, t2] });
  const snap = run([epic]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-1-foo.2")).toEqual(
    blocked({ kind: "single-task-per-epic" }),
  );
});

test("per-epic: two ready tasks in same epic with DIFFERENT roots → second still blocks per-epic", () => {
  // Per-epic doesn't care about roots — it's intra-epic only.
  const t1 = makeTask({ task_id: "fn-1-foo.1", target_repo: "/r1" });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    target_repo: "/r2",
  });
  const epic = makeEpic({ tasks: [t1, t2] });
  const snap = run([epic]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-1-foo.2")).toEqual(
    blocked({ kind: "single-task-per-epic" }),
  );
});

test("per-epic: working task in epic occupies the slot → sibling ready task blocks", () => {
  // The broader "non-completed occupant" rule: an actively job-running task
  // is non-completed, so it claims the epic's slot ahead of a later ready
  // sibling.
  const working = makeTask({
    task_id: "fn-1-foo.1",
    jobs: [makeEmbeddedJob({ state: "working" })],
  });
  const ready = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
  });
  const epic = makeEpic({ tasks: [working, ready] });
  const snap = run([epic]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual(
    blocked({ kind: "job-running" }),
  );
  expect(snap.perTask.get("fn-1-foo.2")).toEqual(
    blocked({ kind: "single-task-per-epic" }),
  );
});

test("per-epic: doesn't fire when only one non-completed task exists", () => {
  // Completed siblings don't occupy the slot — they're off the board.
  const done = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
  });
  const ready = makeTask({ task_id: "fn-1-foo.2", task_number: 2 });
  const epic = makeEpic({ tasks: [done, ready] });
  const snap = run([epic]);
  expect(snap.perTask.get("fn-1-foo.2")).toEqual({ tag: "ready" });
});

// ---------------------------------------------------------------------------
// Per-root post-pass (predicate 12)
// ---------------------------------------------------------------------------

test("per-root: same-root tasks in DIFFERENT epics → first wins, second blocks single-task-per-root", () => {
  // Cross-epic competition — per-epic doesn't apply (different epics), so
  // per-root is the only mutex that fires.
  const e1t1 = makeTask({ task_id: "fn-1-foo.1", target_repo: "/r" });
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/r",
    tasks: [e1t1],
  });
  const e2t1 = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
    target_repo: "/r",
  });
  const e2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/r",
    tasks: [e2t1],
  });
  const snap = run([e1, e2]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-2-bar.1")).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

test("per-root: different roots in different epics → both ready", () => {
  const e1t1 = makeTask({ task_id: "fn-1-foo.1", target_repo: "/r1" });
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/r1",
    tasks: [e1t1],
  });
  const e2t1 = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
    target_repo: "/r2",
  });
  const e2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/r2",
    tasks: [e2t1],
  });
  const snap = run([e1, e2]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-2-bar.1")).toEqual({ tag: "ready" });
});

test("per-root: target_repo === null falls back to project_dir (cross-epic)", () => {
  const e1t1 = makeTask({ task_id: "fn-1-foo.1", target_repo: null });
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo",
    tasks: [e1t1],
  });
  const e2t1 = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
    target_repo: null,
  });
  const e2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/repo",
    tasks: [e2t1],
  });
  const snap = run([e1, e2]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-2-bar.1")).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

test("per-root: empty-string target_repo + empty-string project_dir collapse (cross-epic)", () => {
  // Both rows fall through to "" — the unknown-root bucket; only one survives.
  const e1t1 = makeTask({ task_id: "fn-1-foo.1", target_repo: "" });
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "",
    tasks: [e1t1],
  });
  const e2t1 = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
    target_repo: "",
  });
  const e2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "",
    tasks: [e2t1],
  });
  const snap = run([e1, e2]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-2-bar.1")).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

test("per-root: working task in epic A occupies root → ready task in epic B blocks", () => {
  // The broader "non-completed occupant" rule applied across epics: a
  // job-running task in epic A claims its root, so a ready task in epic B
  // sharing that root blocks single-task-per-root.
  const working = makeTask({
    task_id: "fn-1-foo.1",
    target_repo: "/r",
    jobs: [makeEmbeddedJob({ state: "working" })],
  });
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/r",
    tasks: [working],
  });
  const ready = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
    target_repo: "/r",
  });
  const e2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/r",
    tasks: [ready],
  });
  const snap = run([e1, e2]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual(
    blocked({ kind: "job-running" }),
  );
  expect(snap.perTask.get("fn-2-bar.1")).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

// ---------------------------------------------------------------------------
// Post-pass ordering — tighter scope (per-epic) wins when both apply
// ---------------------------------------------------------------------------

test("ordering: same-epic same-root collision → reported as single-task-per-epic, not per-root", () => {
  // Two ready tasks in the same epic AND same root. Both mutexes would fire,
  // but per-epic runs first and claims the row — per-root never sees a still-
  // ready competitor to mutate.
  const t1 = makeTask({ task_id: "fn-1-foo.1", target_repo: "/r" });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    target_repo: "/r",
  });
  const epic = makeEpic({ tasks: [t1, t2], project_dir: "/r" });
  const snap = run([epic]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-1-foo.2")).toEqual(
    blocked({ kind: "single-task-per-epic" }),
  );
});

// ---------------------------------------------------------------------------
// Epic header rollup
// ---------------------------------------------------------------------------

test("epic header rollup: zero-task epic — header = close-row verdict (ready)", () => {
  // No tasks, so close-row's synthetic dep-on-task-synthetic-close passes
  // vacuously → close is ready → header is ready.
  const epic = makeEpic({ tasks: [] });
  const snap = run([epic]);
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual({ tag: "ready" });
  expect(snap.perEpic.get(epic.epic_id)).toEqual({ tag: "ready" });
});

test("epic header rollup: all tasks done+approved + close blocked → header inherits close reason", () => {
  // Close row is pending → predicate 7 fires job-pending, but only when
  // epic.status === "done". With status=open the close row is just `ready`
  // (after dep-on-task-synthetic-close passes). To get a non-ready close
  // we set status=open + pending approval (no own-approval fire) — close
  // is ready. To produce a blocked close, mark epic.approval=rejected.
  const t = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
  });
  const epic = makeEpic({ tasks: [t], approval: "rejected" });
  const snap = run([epic]);
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    blocked({ kind: "job-rejected" }),
  );
  expect(snap.perEpic.get(epic.epic_id)).toEqual(
    blocked({ kind: "job-rejected" }),
  );
});

test("epic header rollup: completed close → completed header", () => {
  const t = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
  });
  const epic = makeEpic({
    tasks: [t],
    status: "done",
    approval: "approved",
  });
  const snap = run([epic]);
  expect(snap.perEpic.get(epic.epic_id)).toEqual({ tag: "completed" });
});

test("epic header rollup: mixed states — reason from FIRST non-completed in traversal", () => {
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
  });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    worker_phase: "done",
    approval: "rejected", // first non-completed in traversal
  });
  const t3 = makeTask({
    task_id: "fn-1-foo.3",
    task_number: 3,
    worker_phase: "done",
    approval: "pending", // would fire job-pending if reached first
  });
  const epic = makeEpic({ tasks: [t1, t2, t3] });
  const snap = run([epic]);
  expect(snap.perEpic.get(epic.epic_id)).toEqual(
    blocked({ kind: "job-rejected" }),
  );
});

test("epic header rollup: any task ready → header ready (close blocked doesn't matter)", () => {
  const ready = makeTask({ task_id: "fn-1-foo.1" });
  const epic = makeEpic({ tasks: [ready] });
  const snap = run([epic]);
  expect(snap.perTask.get(ready.task_id)).toEqual({ tag: "ready" });
  expect(snap.perEpic.get(epic.epic_id)).toEqual({ tag: "ready" });
});

// ---------------------------------------------------------------------------
// Missing-input defensives
// ---------------------------------------------------------------------------

test("missing-input: a task with depends_on referencing a non-existent task → dep-on-task", () => {
  // The upstream id has no entry in any epic.tasks[], so the perTask lookup
  // misses → blocks with the upstream id verbatim.
  const dependent = makeTask({
    task_id: "fn-1-foo.1",
    depends_on: ["fn-1-foo.99"], // not in tasks[]
  });
  const epic = makeEpic({ tasks: [dependent] });
  const snap = run([epic]);
  expect(snap.perTask.get(dependent.task_id)).toEqual(
    blocked({ kind: "dep-on-task", upstream: "fn-1-foo.99" }),
  );
});

test("dep-on-epic absent-from-collection counts as SATISFIED", () => {
  // Upstream epic not in the input — treat as off-the-board (done+approved).
  const t = makeTask({ task_id: "fn-1-foo.1" });
  const epic = makeEpic({ tasks: [t], depends_on_epics: ["fn-99-ghost"] });
  const snap = run([epic]);
  expect(snap.perTask.get(t.task_id)).toEqual({ tag: "ready" });
});

test("formatPill defaults to [blocked:unknown] for the unknown reason", () => {
  expect(formatPill(blocked({ kind: "unknown" }))).toBe("[blocked:unknown]");
});

// ---------------------------------------------------------------------------
// Subagent_invocations status filter
// ---------------------------------------------------------------------------

test("subagent_invocations: matching job_id but status !== 'running' → ignored", () => {
  const t = makeTask({
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [t] });
  const subs = [makeSub({ job_id: "worker-1", status: "ok" })];
  const snap = run([epic], new Map(), subs);
  expect(snap.perTask.get(t.task_id)).toEqual({ tag: "ready" });
});

test("subagent_invocations: failed status → ignored", () => {
  const t = makeTask({
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [t] });
  const subs = [makeSub({ job_id: "worker-1", status: "failed" })];
  const snap = run([epic], new Map(), subs);
  expect(snap.perTask.get(t.task_id)).toEqual({ tag: "ready" });
});

test("subagent_invocations: running on different job_id → ignored", () => {
  const t = makeTask({
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [t] });
  const subs = [makeSub({ job_id: "other-worker", status: "running" })];
  const snap = run([epic], new Map(), subs);
  expect(snap.perTask.get(t.task_id)).toEqual({ tag: "ready" });
});

// ---------------------------------------------------------------------------
// planner-running predicate — absent-from-jobs collection is NOT working
// ---------------------------------------------------------------------------

test("planner-running: job_links entry whose embedded state defaults to 'stopped' → not running", () => {
  // Schema v21: the link carries its own `state` field (denormalized off
  // the linked jobs row at the reducer's write boundary). For an orphan
  // entry (job_id with no `jobs` row at enrichment time), `enrichJobLink`
  // defaults `state` to `"stopped"` — the same zero-event reading that
  // used to surface as "absent from the jobs map" pre-v21. Either way:
  // the task is ready because no link is `"working"`.
  const t = makeTask({ task_id: "fn-1-foo.1" });
  const linkEntry: JobLinkEntry = makeLink({ job_id: "missing-job" });
  const epic = makeEpic({ tasks: [t], job_links: [linkEntry] });
  const snap = run([epic]);
  expect(snap.perTask.get(t.task_id)).toEqual({ tag: "ready" });
});

test("planner-running: job_links entry on a stopped job → not running", () => {
  // Schema v21 reads state straight off the embedded entry — no live
  // `jobs` Map join, so this test no longer threads a jobs map at all.
  const t = makeTask({ task_id: "fn-1-foo.1" });
  const epic = makeEpic({
    tasks: [t],
    job_links: [makeLink({ job_id: "planner-job", state: "stopped" })],
  });
  const snap = run([epic]);
  expect(snap.perTask.get(t.task_id)).toEqual({ tag: "ready" });
});

// ---------------------------------------------------------------------------
// Post-pass mutex direct tests
// ---------------------------------------------------------------------------

test("applySingleTaskPerEpicMutex: standalone invocation mutates verdict map in place", () => {
  const t1 = makeTask({ task_id: "fn-1-foo.1" });
  const t2 = makeTask({ task_id: "fn-1-foo.2", task_number: 2 });
  const epic = makeEpic({ tasks: [t1, t2] });
  const perTask = new Map<string, Verdict>([
    ["fn-1-foo.1", { tag: "ready" }],
    ["fn-1-foo.2", { tag: "ready" }],
  ]);
  applySingleTaskPerEpicMutex([epic], perTask);
  expect(perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
  expect(perTask.get("fn-1-foo.2")).toEqual(
    blocked({ kind: "single-task-per-epic" }),
  );
});

test("applySingleTaskPerEpicMutex: non-completed non-ready row STILL claims the epic slot", () => {
  // The new semantics: any non-completed verdict (not just `ready`) claims
  // the slot. A blocked-but-non-completed row occupies the epic, so the
  // later ready row gets mutated.
  const t1 = makeTask({ task_id: "fn-1-foo.1" });
  const t2 = makeTask({ task_id: "fn-1-foo.2", task_number: 2 });
  const epic = makeEpic({ tasks: [t1, t2] });
  const perTask = new Map<string, Verdict>([
    ["fn-1-foo.1", blocked({ kind: "job-pending" })],
    ["fn-1-foo.2", { tag: "ready" }],
  ]);
  applySingleTaskPerEpicMutex([epic], perTask);
  expect(perTask.get("fn-1-foo.1")).toEqual(blocked({ kind: "job-pending" }));
  expect(perTask.get("fn-1-foo.2")).toEqual(
    blocked({ kind: "single-task-per-epic" }),
  );
});

test("applySingleTaskPerEpicMutex: only ready rows are mutated (already-blocked sibling keeps its reason)", () => {
  // First row ready → claims slot. Second row already dep-on-task blocked →
  // stays put. Third row ready → mutated to single-task-per-epic.
  const t1 = makeTask({ task_id: "fn-1-foo.1" });
  const t2 = makeTask({ task_id: "fn-1-foo.2", task_number: 2 });
  const t3 = makeTask({ task_id: "fn-1-foo.3", task_number: 3 });
  const epic = makeEpic({ tasks: [t1, t2, t3] });
  const perTask = new Map<string, Verdict>([
    ["fn-1-foo.1", { tag: "ready" }],
    ["fn-1-foo.2", blocked({ kind: "dep-on-task", upstream: "fn-1-foo.1" })],
    ["fn-1-foo.3", { tag: "ready" }],
  ]);
  applySingleTaskPerEpicMutex([epic], perTask);
  expect(perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
  expect(perTask.get("fn-1-foo.2")).toEqual(
    blocked({ kind: "dep-on-task", upstream: "fn-1-foo.1" }),
  );
  expect(perTask.get("fn-1-foo.3")).toEqual(
    blocked({ kind: "single-task-per-epic" }),
  );
});

test("applySingleTaskPerRootMutex: standalone invocation mutates verdict maps in place", () => {
  const e1t1 = makeTask({ task_id: "fn-1-foo.1", target_repo: "/r" });
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/r",
    tasks: [e1t1],
  });
  const e2t1 = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
    target_repo: "/r",
  });
  const e2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/r",
    tasks: [e2t1],
  });
  const perTask = new Map<string, Verdict>([
    ["fn-1-foo.1", { tag: "ready" }],
    ["fn-2-bar.1", { tag: "ready" }],
  ]);
  applySingleTaskPerRootMutex([e1, e2], perTask, new Map());
  expect(perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
  expect(perTask.get("fn-2-bar.1")).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

test("applySingleTaskPerRootMutex: non-completed non-ready row STILL claims the root", () => {
  // Cross-epic version of the same broader rule: an actively blocked row in
  // epic A occupies root /r so a later ready row in epic B gets mutated.
  const e1t1 = makeTask({ task_id: "fn-1-foo.1", target_repo: "/r" });
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/r",
    tasks: [e1t1],
  });
  const e2t1 = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
    target_repo: "/r",
  });
  const e2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/r",
    tasks: [e2t1],
  });
  const perTask = new Map<string, Verdict>([
    ["fn-1-foo.1", blocked({ kind: "job-running" })],
    ["fn-2-bar.1", { tag: "ready" }],
  ]);
  applySingleTaskPerRootMutex([e1, e2], perTask, new Map());
  expect(perTask.get("fn-1-foo.1")).toEqual(blocked({ kind: "job-running" }));
  expect(perTask.get("fn-2-bar.1")).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

// ---------------------------------------------------------------------------
// formatPill
// ---------------------------------------------------------------------------

test("formatPill renders the three tags + every reason kind", () => {
  expect(formatPill({ tag: "ready" })).toBe("[ready]");
  expect(formatPill({ tag: "completed" })).toBe("[completed]");
  expect(formatPill(blocked({ kind: "job-rejected" }))).toBe(
    "[blocked:job-rejected]",
  );
  expect(formatPill(blocked({ kind: "job-pending" }))).toBe(
    "[blocked:job-pending]",
  );
  expect(formatPill(blocked({ kind: "epic-not-validated" }))).toBe(
    "[blocked:epic-not-validated]",
  );
  expect(formatPill(blocked({ kind: "planner-running" }))).toBe(
    "[blocked:planner-running]",
  );
  expect(formatPill(blocked({ kind: "job-running" }))).toBe(
    "[blocked:job-running]",
  );
  expect(formatPill(blocked({ kind: "sub-agent-running" }))).toBe(
    "[blocked:sub-agent-running]",
  );
  expect(
    formatPill(blocked({ kind: "dep-on-task", upstream: "fn-1-foo.2" })),
  ).toBe("[blocked:dep-on-task fn-1-foo.2]");
  expect(
    formatPill(blocked({ kind: "dep-on-epic", upstream: "fn-0-bar" })),
  ).toBe("[blocked:dep-on-epic fn-0-bar]");
  expect(formatPill(blocked({ kind: "single-task-per-epic" }))).toBe(
    "[blocked:single-task-per-epic]",
  );
  expect(formatPill(blocked({ kind: "single-task-per-root" }))).toBe(
    "[blocked:single-task-per-root]",
  );
  expect(formatPill(blocked({ kind: "unknown" }))).toBe("[blocked:unknown]");
});

// ---------------------------------------------------------------------------
// Close-row predicate 10 (dep-on-task-synthetic-close)
// ---------------------------------------------------------------------------

test("close row: every real task completed → close ready (then dep-on-task-synthetic-close passes)", () => {
  const t = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
  });
  const epic = makeEpic({ tasks: [t] });
  const snap = run([epic]);
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual({ tag: "ready" });
});

test("close row: any non-completed task → dep-on-task with FIRST non-completed id", () => {
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
  });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    worker_phase: "open",
  });
  const t3 = makeTask({
    task_id: "fn-1-foo.3",
    task_number: 3,
    worker_phase: "open",
  });
  const epic = makeEpic({ tasks: [t1, t2, t3] });
  const snap = run([epic]);
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    blocked({ kind: "dep-on-task", upstream: "fn-1-foo.2" }),
  );
});

// ---------------------------------------------------------------------------
// Close-row predicate 5/6 fan-out across task-level embedded jobs
// ---------------------------------------------------------------------------

test("close row: task-level worker still working → job-running (even with task completed)", () => {
  // Task verdict goes to `completed` via predicate 1 (worker_phase done +
  // approval approved), but its embedded work-verb job is still `working`
  // because Stop/SessionEnd hasn't fired yet. The close row must block on
  // `job-running`, not flip to `ready`.
  const t = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "working" })],
  });
  const epic = makeEpic({ tasks: [t] });
  const snap = run([epic]);
  expect(snap.perTask.get(t.task_id)).toEqual({ tag: "completed" });
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    blocked({ kind: "job-running" }),
  );
});

test("close row: task-level worker has running sub-agent → sub-agent-running", () => {
  // Task completed, worker job stopped, but a sub-agent invocation under
  // that worker session id is still `running`. Close row must block.
  const t = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [t] });
  const sub = makeSub({ job_id: "worker-1", status: "running" });
  const snap = run([epic], new Map(), [sub]);
  expect(snap.perTask.get(t.task_id)).toEqual({ tag: "completed" });
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    blocked({ kind: "sub-agent-running" }),
  );
});

test("close row: all task workers stopped, no sub-agents running → ready", () => {
  // Same shape as the regression cases but with a `stopped` worker and no
  // running sub-agents. Close row should flip to `ready` as before.
  const t = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [t] });
  const snap = run([epic]);
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual({ tag: "ready" });
});

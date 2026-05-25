/**
 * Pure-function tests for `scripts/readiness.ts` — exercises the 10-predicate
 * pipeline + single-root post-pass + epic header rollup directly. No DB, no
 * reducer, no migration: build `Epic[]` / `Job` map / `SubagentInvocation[]`
 * fixtures inline and assert verdict map equality.
 *
 * Coverage tracks `task.spec` Test notes:
 *   - Predicate-ordering matrix (every ordering edge that matters).
 *   - Single-root post-pass (multi-root, single-root, empty-string fallback).
 *   - Epic header rollup edge cases (zero-task, all-completed-except-close,
 *     mixed states).
 *   - Missing-input defensive defaults (verdict lookup miss).
 *   - Dep-absent-from-collection semantics.
 *   - subagent_invocations status filter (running blocks, anything else doesn't).
 */

import { expect, test } from "bun:test";
import {
  applySingleRootMutex,
  type BlockReason,
  computeReadiness,
  formatPill,
  formatReasonLine,
  type Verdict,
} from "../scripts/readiness";
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
    status: "open",
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

function makeJob(overrides: Partial<Job>): Job {
  return {
    job_id: "session-1",
    created_at: 0,
    cwd: null,
    pid: null,
    state: "working",
    last_event_id: 0,
    updated_at: 0,
    title: null,
    title_source: null,
    transcript_path: null,
    start_time: null,
    plan_verb: null,
    plan_ref: null,
    epic_links: [],
    rate_limited_at: null,
    ...overrides,
  };
}

function makeEmbeddedJob(overrides: Partial<EmbeddedJob>): EmbeddedJob {
  return {
    job_id: "session-1",
    plan_verb: "work",
    state: "working",
    title: null,
    created_at: 0,
    updated_at: 0,
    last_event_id: 0,
    rate_limited_at: null,
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
    status: "done",
    approval: "approved",
    jobs: [makeEmbeddedJob({ state: "working" })],
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual({ tag: "completed" });
});

test("predicate 1 wins over 2 (epic-not-validated)", () => {
  const task = makeTask({ status: "done", approval: "approved" });
  const epic = makeEpic({ tasks: [task], last_validated_at: null });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual({ tag: "completed" });
});

test("predicate 2 (epic-not-validated) wins over 3 (planner-running)", () => {
  const task = makeTask({});
  const epic = makeEpic({
    tasks: [task],
    last_validated_at: null,
    job_links: [{ kind: "refiner", job_id: "planner-job" }],
  });
  const jobs = new Map<string, Job>([
    ["planner-job", makeJob({ job_id: "planner-job", state: "working" })],
  ]);
  const snap = run([epic], jobs);
  expect(snap.perTask.get(task.task_id)).toEqual(
    blocked({ kind: "epic-not-validated" }),
  );
});

test("predicate 3 (planner-running) wins over 4 (own-approval)", () => {
  // Even an approved+done task blocks when a planner is working on the epic.
  // (Predicate 1 doesn't fire because approval is `pending`, not `approved`.)
  const task = makeTask({ status: "open", approval: "approved" });
  const epic = makeEpic({
    tasks: [task],
    job_links: [{ kind: "creator", job_id: "planner-job" }],
  });
  const jobs = new Map<string, Job>([
    ["planner-job", makeJob({ job_id: "planner-job", state: "working" })],
  ]);
  const snap = run([epic], jobs);
  expect(snap.perTask.get(task.task_id)).toEqual(
    blocked({ kind: "planner-running" }),
  );
});

test("predicate 4 own-approval: job-rejected wins over job-pending", () => {
  // Rejected ABOVE pending — the spec invariant.
  const task = makeTask({ status: "done", approval: "rejected" });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual(
    blocked({ kind: "job-rejected" }),
  );
});

test("predicate 4 wins over 5 (own-progress-main)", () => {
  // A rejected task whose worker is still running shows `job-rejected`.
  const task = makeTask({
    status: "open",
    approval: "rejected",
    jobs: [makeEmbeddedJob({ state: "working" })],
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual(
    blocked({ kind: "job-rejected" }),
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

test("predicate 6 (own-progress-sub) wins over 7 (dep-on-task)", () => {
  // This row's sub-agent running. Upstream completed. Sub still blocks.
  const upstream = makeTask({
    task_id: "fn-1-foo.1",
    status: "done",
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

test("predicate 7 (dep-on-task) wins over 8 (dep-on-epic)", () => {
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
    status: "open",
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

test("predicate 8 (dep-on-epic) wins over 10 (single-root)", () => {
  // The dependent epic's task would otherwise compete for single-root with
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
// Single-root post-pass
// ---------------------------------------------------------------------------

test("single-root: two ready tasks in same target_repo → first wins, second blocks", () => {
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
    blocked({ kind: "single-root" }),
  );
});

test("single-root: target_repo === null falls back to project_dir", () => {
  const t1 = makeTask({ task_id: "fn-1-foo.1", target_repo: null });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    target_repo: null,
  });
  const epic = makeEpic({ tasks: [t1, t2], project_dir: "/repo" });
  const snap = run([epic]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-1-foo.2")).toEqual(
    blocked({ kind: "single-root" }),
  );
});

test("single-root: different roots → both ready", () => {
  const t1 = makeTask({ task_id: "fn-1-foo.1", target_repo: "/r1" });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    target_repo: "/r2",
  });
  const epic = makeEpic({ tasks: [t1, t2] });
  const snap = run([epic]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-1-foo.2")).toEqual({ tag: "ready" });
});

test("single-root: empty-string target_repo + empty-string project_dir collapse", () => {
  // Both rows fall through to "" — the unknown-root bucket; only one survives.
  const t1 = makeTask({ task_id: "fn-1-foo.1", target_repo: "" });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    target_repo: "",
  });
  const epic = makeEpic({ tasks: [t1, t2], project_dir: "" });
  const snap = run([epic]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-1-foo.2")).toEqual(
    blocked({ kind: "single-root" }),
  );
});

test("single-root: traversal order = epics input × pre-sorted tasks × close last", () => {
  // Two epics in the same root; first epic's first task wins, every other
  // would-be-ready row blocks.
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
    blocked({ kind: "single-root" }),
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
  // Close row is pending → predicate 4 fires job-pending, but only when
  // epic.status === "done". With status=open the close row is just `ready`
  // (after dep-on-task-synthetic-close passes). To get a non-ready close
  // we set status=open + pending approval (no own-approval fire) — close
  // is ready. To produce a blocked close, mark epic.approval=rejected.
  const t = makeTask({
    task_id: "fn-1-foo.1",
    status: "done",
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
    status: "done",
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
    status: "done",
    approval: "approved",
  });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    status: "done",
    approval: "rejected", // first non-completed in traversal
  });
  const t3 = makeTask({
    task_id: "fn-1-foo.3",
    task_number: 3,
    status: "done",
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

test("planner-running: job_links entry whose job_id is missing → not running", () => {
  // job_links names a session_id that's not in the jobs map (the planner job
  // is done + off the board, or hasn't loaded yet). Absent ≠ working, so the
  // task is ready.
  const t = makeTask({ task_id: "fn-1-foo.1" });
  const linkEntry: JobLinkEntry = { kind: "refiner", job_id: "missing-job" };
  const epic = makeEpic({ tasks: [t], job_links: [linkEntry] });
  const snap = run([epic]);
  expect(snap.perTask.get(t.task_id)).toEqual({ tag: "ready" });
});

test("planner-running: job_links entry on a stopped job → not running", () => {
  const t = makeTask({ task_id: "fn-1-foo.1" });
  const epic = makeEpic({
    tasks: [t],
    job_links: [{ kind: "refiner", job_id: "planner-job" }],
  });
  const jobs = new Map<string, Job>([
    ["planner-job", makeJob({ job_id: "planner-job", state: "stopped" })],
  ]);
  const snap = run([epic], jobs);
  expect(snap.perTask.get(t.task_id)).toEqual({ tag: "ready" });
});

// ---------------------------------------------------------------------------
// applySingleRootMutex (direct test)
// ---------------------------------------------------------------------------

test("applySingleRootMutex: standalone invocation mutates verdict maps in place", () => {
  const t1 = makeTask({ task_id: "fn-1-foo.1", target_repo: "/r" });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    target_repo: "/r",
  });
  const epic = makeEpic({ tasks: [t1, t2] });
  const perTask = new Map<string, Verdict>([
    ["fn-1-foo.1", { tag: "ready" }],
    ["fn-1-foo.2", { tag: "ready" }],
  ]);
  const perCloseRow = new Map<string, Verdict>();
  applySingleRootMutex([epic], perTask, perCloseRow);
  expect(perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
  expect(perTask.get("fn-1-foo.2")).toEqual(blocked({ kind: "single-root" }));
});

test("applySingleRootMutex: only ready rows are touched (blocked/completed stay put)", () => {
  const t1 = makeTask({ task_id: "fn-1-foo.1", target_repo: "/r" });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    target_repo: "/r",
  });
  const epic = makeEpic({ tasks: [t1, t2] });
  const perTask = new Map<string, Verdict>([
    ["fn-1-foo.1", blocked({ kind: "job-pending" })],
    ["fn-1-foo.2", { tag: "ready" }],
  ]);
  applySingleRootMutex([epic], perTask, new Map());
  // First row stays blocked; second row "wins" the root because no prior ready.
  expect(perTask.get("fn-1-foo.1")).toEqual(blocked({ kind: "job-pending" }));
  expect(perTask.get("fn-1-foo.2")).toEqual({ tag: "ready" });
});

// ---------------------------------------------------------------------------
// formatPill / formatReasonLine
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
  expect(formatPill(blocked({ kind: "single-root" }))).toBe(
    "[blocked:single-root]",
  );
  expect(formatPill(blocked({ kind: "unknown" }))).toBe("[blocked:unknown]");
});

test("formatReasonLine: null for non-blocked, plain reason for blocked", () => {
  expect(formatReasonLine({ tag: "ready" })).toBeNull();
  expect(formatReasonLine({ tag: "completed" })).toBeNull();
  expect(formatReasonLine(blocked({ kind: "single-root" }))).toBe(
    "single-root",
  );
  expect(
    formatReasonLine(blocked({ kind: "dep-on-task", upstream: "fn-1-foo.1" })),
  ).toBe("dep-on-task fn-1-foo.1");
});

// ---------------------------------------------------------------------------
// Close-row predicate 9 (dep-on-task-synthetic-close)
// ---------------------------------------------------------------------------

test("close row: every real task completed → close ready (then dep-on-task-synthetic-close passes)", () => {
  const t = makeTask({
    task_id: "fn-1-foo.1",
    status: "done",
    approval: "approved",
  });
  const epic = makeEpic({ tasks: [t] });
  const snap = run([epic]);
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual({ tag: "ready" });
});

test("close row: any non-completed task → dep-on-task with FIRST non-completed id", () => {
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    status: "done",
    approval: "approved",
  });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    status: "open",
  });
  const t3 = makeTask({
    task_id: "fn-1-foo.3",
    task_number: 3,
    status: "open",
  });
  const epic = makeEpic({ tasks: [t1, t2, t3] });
  const snap = run([epic]);
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    blocked({ kind: "dep-on-task", upstream: "fn-1-foo.2" }),
  );
});

/**
 * Pure-function tests for `src/await-conditions.ts` — exercises the
 * predicate module that backs `keeper await` (fn-647). No daemon, no
 * subscribe stream: build `Epic[]` fixtures inline, run the readiness
 * pass to get a `ReadinessSnapshot`, then feed snapshot + target into
 * `evaluateAwaitCondition` and assert on the returned `AwaitState`.
 *
 * Coverage tracks the task spec's Test notes:
 *   - `classifyTargetId` epic-vs-task split incl. bare `fn-N`.
 *   - `workable` carve-out: only the two `single-task-per-*` block
 *     reasons count as workable; everything else (running, completed,
 *     other blocked kinds) does not.
 *   - task-complete: true / false (worker_phase, approval edges).
 *   - epic-complete: present-on-board → waiting (never met on the
 *     present branch); absent + priorPresence + re-query hit → met
 *     ("popped off the board"); absent + priorPresence + re-query miss
 *     → deleted; absent + no priorPresence → not-found.
 *   - task-unblocked: ready → met; mutex-demoted → met (the carve-out);
 *     genuinely blocked → waiting; stuck reasons → stuck.
 *   - epic-unblocked: read off perTask/perCloseRow, NOT perEpic — the
 *     load-bearing fixture is an epic whose sole ready task got mutex-
 *     demoted, which the `perEpic` rollup paints as blocked but the
 *     per-row map still has workable in it.
 *   - stuck: job-rejected, dep-on-epic-dangling.
 *   - not-found: target absent from inputs and never seen before.
 */

import { expect, test } from "bun:test";
import {
  type AwaitState,
  classifyTargetId,
  evaluateAwaitCondition,
  workable,
} from "../src/await-conditions";
import { computeReadiness, type Verdict } from "../src/readiness";
import type {
  EmbeddedJob,
  Epic,
  Job,
  JobLinkEntry,
  ResolvedEpicDep,
  SubagentInvocation,
  Task,
} from "../src/types";

// ---------------------------------------------------------------------------
// Fixture builders — mirror test/readiness.test.ts so the readiness pass
// behaves identically (same defaults, same coercions, same "ready" zero
// state).
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task>): Task {
  return {
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    task_number: 1,
    title: "task",
    target_repo: null,
    tier: null,
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
    created_by_closer_of: null,
    sort_path: "000001",
    queue_jump: 0,
    resolved_epic_deps: null,
    last_validated_at: "2026-05-24T00:00:00Z",
    ...overrides,
  };
}

function makeResolvedDep(
  overrides: Partial<ResolvedEpicDep> & { dep_token: string },
): ResolvedEpicDep {
  return {
    resolved_epic_id: null,
    epic_number: null,
    project_basename: null,
    cross_project: false,
    state: "dangling",
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
    last_api_error_at: null,
    last_api_error_kind: null,
    last_input_request_at: null,
    last_input_request_kind: null,
    git_dirty_count: 0,
    git_unattributed_to_live_count: 0,
    git_orphan_count: 0,
    ...overrides,
  };
}

function _makeLink(overrides: Partial<JobLinkEntry>): JobLinkEntry {
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

function run(
  epics: Epic[],
  jobs: Map<string, Job> = new Map(),
  subs: SubagentInvocation[] = [],
) {
  return computeReadiness(epics, jobs, subs, new Map());
}

// ---------------------------------------------------------------------------
// classifyTargetId — the .N split mirrors scripts/approve.ts and
// cli/board.ts:taskNumFromId.
// ---------------------------------------------------------------------------

test("classifyTargetId: trailing .<digits> → task", () => {
  expect(classifyTargetId("fn-643-foo.4")).toBe("task");
  expect(classifyTargetId("fn-1-x.1")).toBe("task");
  expect(classifyTargetId("fn-1000-multi-word-slug.12")).toBe("task");
});

test("classifyTargetId: full epic id (no trailing .<digits>) → epic", () => {
  expect(classifyTargetId("fn-643-foo")).toBe("epic");
  expect(classifyTargetId("fn-1-bar-baz")).toBe("epic");
});

test("classifyTargetId: bare fn-N (no slug) → epic", () => {
  // Mirrors the bare-id form supported by `cli/board.ts:epicNumFromIdOrBare`
  // and the resolver — `fn-99` is an epic reference.
  expect(classifyTargetId("fn-99")).toBe("epic");
  expect(classifyTargetId("fn-1")).toBe("epic");
});

test("classifyTargetId: empty → null (usage error)", () => {
  expect(classifyTargetId("")).toBeNull();
});

test("classifyTargetId: weird-but-non-task strings still classify as epic", () => {
  // The split is purely shape-based: trailing `.<digits>` is the only
  // signal for "task". Anything else (including the bare form) is an
  // epic; the daemon's presence check is what rejects gibberish ids.
  expect(classifyTargetId("not-an-id")).toBe("epic");
  expect(classifyTargetId("fn-foo")).toBe("epic");
});

// ---------------------------------------------------------------------------
// workable — only the two single-task-per-* block reasons are workable;
// everything else (ready being the obvious exception) is not.
// ---------------------------------------------------------------------------

test("workable: ready is workable", () => {
  expect(workable({ tag: "ready" })).toBe(true);
});

test("workable: completed is NOT workable", () => {
  expect(workable({ tag: "completed" })).toBe(false);
});

test("workable: blocked:single-task-per-epic IS workable (concurrency carve-out)", () => {
  expect(
    workable({ tag: "blocked", reason: { kind: "single-task-per-epic" } }),
  ).toBe(true);
});

test("workable: blocked:single-task-per-root IS workable (concurrency carve-out)", () => {
  expect(
    workable({ tag: "blocked", reason: { kind: "single-task-per-root" } }),
  ).toBe(true);
});

test("workable: other blocked kinds are NOT workable", () => {
  const others: Verdict[] = [
    { tag: "blocked", reason: { kind: "job-rejected" } },
    { tag: "blocked", reason: { kind: "job-pending" } },
    { tag: "blocked", reason: { kind: "epic-not-validated" } },
    { tag: "blocked", reason: { kind: "git-uncommitted" } },
    { tag: "blocked", reason: { kind: "git-orphans" } },
    { tag: "blocked", reason: { kind: "dep-on-task", upstream: "fn-1-x.2" } },
    {
      tag: "blocked",
      reason: { kind: "dep-on-epic", upstream: "fn-2", cross_project: null },
    },
    {
      tag: "blocked",
      reason: { kind: "dep-on-epic-dangling", upstream: "fn-99" },
    },
    { tag: "blocked", reason: { kind: "unknown" } },
  ];
  for (const v of others) {
    expect(workable(v)).toBe(false);
  }
});

test("workable: running verdicts are NOT workable (row already in motion)", () => {
  const runningVerdicts: Verdict[] = [
    { tag: "running", reason: { kind: "job-running" } },
    { tag: "running", reason: { kind: "sub-agent-running" } },
    { tag: "running", reason: { kind: "sub-agent-stale" } },
    { tag: "running", reason: { kind: "planner-running" } },
  ];
  for (const v of runningVerdicts) {
    expect(workable(v)).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// Task-complete: raw worker_phase + approval read off the embedded task.
// ---------------------------------------------------------------------------

test("task-complete: done + approved → met", () => {
  const task = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: task.task_id, kind: "task", condition: "complete" },
  );
  expect(state.kind).toBe("met");
});

test("task-complete: done + pending → waiting", () => {
  const task = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "pending",
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: task.task_id, kind: "task", condition: "complete" },
  );
  expect(state.kind).toBe("waiting");
});

test("task-complete: open + approved → waiting (worker hasn't finished)", () => {
  const task = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "open",
    approval: "approved",
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: task.task_id, kind: "task", condition: "complete" },
  );
  expect(state.kind).toBe("waiting");
});

test("task-complete: done + rejected → waiting (rejection is not completion)", () => {
  const task = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "rejected",
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: task.task_id, kind: "task", condition: "complete" },
  );
  // The task is not complete (approval !== "approved"); the command's
  // `--fail-on-stuck` flag is what would surface rejected-as-terminal,
  // and that flag operates on the `unblocked` condition, not `complete`.
  expect(state.kind).toBe("waiting");
});

// ---------------------------------------------------------------------------
// Epic-complete: present-on-board → waiting; absent + priorPresence +
// reQueryHit → met; absent + priorPresence + re-query miss → deleted;
// absent + no priorPresence → not-found.
// ---------------------------------------------------------------------------

test("epic-complete: epic still on board → waiting (never met on the present branch)", () => {
  const task = makeTask({ worker_phase: "done", approval: "approved" });
  const epic = makeEpic({ tasks: [task], approval: "pending" });
  const snap = run([epic]);
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: epic.epic_id, kind: "epic", condition: "complete" },
  );
  // Even though the only task is done+approved, the epic itself is
  // still on the board (its approval hasn't flipped yet) — `met` only
  // fires when it pops off scope.
  expect(state.kind).toBe("waiting");
});

test("epic-complete: epic absent + priorPresence + re-query hit → met", () => {
  // The "popped off the board" positive: the epic was visible in an
  // earlier subscribe tick, isn't visible now, and the scope-exempt
  // re-query confirms it still exists (i.e. it transitioned to
  // approved+closed, not deleted).
  const snap = run([]);
  const state = evaluateAwaitCondition(
    {
      epics: [],
      snapshot: snap,
      priorPresence: true,
      reQueryHit: true,
    },
    { id: "fn-1-foo", kind: "epic", condition: "complete" },
  );
  expect(state.kind).toBe("met");
});

test("epic-complete: epic absent + priorPresence + re-query MISS → deleted", () => {
  const snap = run([]);
  const state = evaluateAwaitCondition(
    {
      epics: [],
      snapshot: snap,
      priorPresence: true,
      reQueryHit: false,
    },
    { id: "fn-1-foo", kind: "epic", condition: "complete" },
  );
  expect(state.kind).toBe("deleted");
});

test("epic-complete: absent + no priorPresence → not-found", () => {
  // Never seen this id in the subscribe stream — distinct from `deleted`
  // (which is a present-then-vanished transition). The command surfaces
  // this as exit 1 reason=not-found.
  const snap = run([]);
  const state = evaluateAwaitCondition(
    { epics: [], snapshot: snap, priorPresence: false },
    { id: "fn-1-foo", kind: "epic", condition: "complete" },
  );
  expect(state.kind).toBe("not-found");
});

test("epic-complete: absent + priorPresence + reQueryHit omitted defaults to deleted", () => {
  // `reQueryHit` is optional in the AwaitInputs shape; omitting it is
  // equivalent to a miss. Command code that hasn't (yet) wired the
  // re-query falls back to the deleted branch — safe default.
  const snap = run([]);
  const state = evaluateAwaitCondition(
    { epics: [], snapshot: snap, priorPresence: true },
    { id: "fn-1-foo", kind: "epic", condition: "complete" },
  );
  expect(state.kind).toBe("deleted");
});

test("epic-complete: bare fn-N form looks up by epic_number", () => {
  // Bare ids match by `epic_number`, mirroring the resolver's bare-id
  // arm. An epic on the board with epic_number=7 should be found via
  // `fn-7`.
  const task = makeTask({
    task_id: "fn-7-x.1",
    epic_id: "fn-7-x",
    worker_phase: "done",
    approval: "approved",
  });
  const epic = makeEpic({
    epic_id: "fn-7-x",
    epic_number: 7,
    tasks: [task],
  });
  const snap = run([epic]);
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: "fn-7", kind: "epic", condition: "complete" },
  );
  // Epic is on the board → waiting (same present-branch rule as the
  // full-id version above).
  expect(state.kind).toBe("waiting");
});

// ---------------------------------------------------------------------------
// Task-unblocked
// ---------------------------------------------------------------------------

test("task-unblocked: genuinely ready task → met", () => {
  const task = makeTask({});
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual({ tag: "ready" });
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: task.task_id, kind: "task", condition: "unblocked" },
  );
  expect(state.kind).toBe("met");
});

test("task-unblocked: mutex-demoted single-task-per-epic → met (carve-out)", () => {
  // Two ready tasks in the same epic — the per-epic mutex demotes the
  // second to `blocked:single-task-per-epic`. Per the await carve-out,
  // that demoted row IS workable (it would be ready if it had the slot).
  const t1 = makeTask({ task_id: "fn-1-foo.1", target_repo: "/r" });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    target_repo: "/r",
  });
  const epic = makeEpic({ tasks: [t1, t2] });
  const snap = run([epic]);
  expect(snap.perTask.get(t2.task_id)).toEqual({
    tag: "blocked",
    reason: { kind: "single-task-per-epic" },
  });
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: t2.task_id, kind: "task", condition: "unblocked" },
  );
  expect(state.kind).toBe("met");
});

test("task-unblocked: mutex-demoted single-task-per-root → met (carve-out)", () => {
  // Same shape as the per-epic case but across two epics sharing a root.
  // The second epic's task is demoted to single-task-per-root, which the
  // await carve-out also treats as workable.
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    target_repo: "/r",
  });
  const t2 = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
    target_repo: "/r",
  });
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    tasks: [t1],
    sort_path: "000001",
  });
  const e2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    tasks: [t2],
    sort_path: "000002",
  });
  const snap = run([e1, e2]);
  expect(snap.perTask.get(t2.task_id)).toEqual({
    tag: "blocked",
    reason: { kind: "single-task-per-root" },
  });
  const state = evaluateAwaitCondition(
    {
      epics: [e1, e2],
      snapshot: snap,
      priorPresence: true,
    },
    { id: t2.task_id, kind: "task", condition: "unblocked" },
  );
  expect(state.kind).toBe("met");
});

test("task-unblocked: genuinely blocked task → waiting (e.g. epic-not-validated)", () => {
  const task = makeTask({});
  const epic = makeEpic({ tasks: [task], last_validated_at: null });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual({
    tag: "blocked",
    reason: { kind: "epic-not-validated" },
  });
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: task.task_id, kind: "task", condition: "unblocked" },
  );
  expect(state.kind).toBe("waiting");
});

test("task-unblocked: completed task is NOT workable → waiting", () => {
  // `completed` is the terminal positive for `complete` checks; it is
  // not "available to start" so `unblocked` reads it as `waiting`. The
  // command's `complete` condition is the right tool for this row.
  const task = makeTask({ worker_phase: "done", approval: "approved" });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual({ tag: "completed" });
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: task.task_id, kind: "task", condition: "unblocked" },
  );
  expect(state.kind).toBe("waiting");
});

test("task-unblocked: running task → waiting (already in motion)", () => {
  const task = makeTask({
    jobs: [makeEmbeddedJob({ state: "working" })],
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual({
    tag: "running",
    reason: { kind: "job-running" },
  });
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: task.task_id, kind: "task", condition: "unblocked" },
  );
  expect(state.kind).toBe("waiting");
});

// ---------------------------------------------------------------------------
// Epic-unblocked: read off perTask + perCloseRow, NOT perEpic. The
// load-bearing fixture is the mutex-demoted-but-workable case.
// ---------------------------------------------------------------------------

test("epic-unblocked: ANY task workable → met, even when perEpic rollup is blocked", () => {
  // Two ready tasks in the same epic: t1 stays ready, t2 gets mutex-
  // demoted to single-task-per-epic. The `perEpic` rollup would paint
  // this epic as `ready` (because t1 is ready), but the load-bearing
  // shape is the OTHER direction — see the next test.
  const t1 = makeTask({ task_id: "fn-1-foo.1", target_repo: "/r" });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    target_repo: "/r",
  });
  const epic = makeEpic({ tasks: [t1, t2] });
  const snap = run([epic]);
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: epic.epic_id, kind: "epic", condition: "unblocked" },
  );
  expect(state.kind).toBe("met");
});

test("epic-unblocked: SOLE ready task got mutex-demoted → still met (perTask carve-out, not perEpic)", () => {
  // The load-bearing risk from the task spec: a `perEpic` rollup shortcut
  // would lie here. We construct an epic whose only would-be-ready task
  // got demoted to single-task-per-root because a sibling epic in the
  // same root has the slot. The perEpic rollup over THIS epic reads as
  // blocked (no ready row), but the carve-out says the demoted task is
  // workable — so epic-unblocked must read off perTask, not perEpic.
  const sibling = makeTask({
    task_id: "fn-9-busy.1",
    epic_id: "fn-9-busy",
    target_repo: "/r",
  });
  const siblingEpic = makeEpic({
    epic_id: "fn-9-busy",
    epic_number: 9,
    tasks: [sibling],
    sort_path: "000009",
  });
  const target = makeTask({
    task_id: "fn-10-target.1",
    epic_id: "fn-10-target",
    target_repo: "/r",
  });
  const targetEpic = makeEpic({
    epic_id: "fn-10-target",
    epic_number: 10,
    tasks: [target],
    sort_path: "000010",
  });
  const snap = run([siblingEpic, targetEpic]);
  // Sanity-check the demotion landed and the perEpic rollup is blocked.
  expect(snap.perTask.get(target.task_id)).toEqual({
    tag: "blocked",
    reason: { kind: "single-task-per-root" },
  });
  const perEpic = snap.perEpic.get(targetEpic.epic_id);
  expect(perEpic?.tag).toBe("blocked");
  // The await predicate, reading perTask/perCloseRow correctly, says met.
  const state = evaluateAwaitCondition(
    {
      epics: [siblingEpic, targetEpic],
      snapshot: snap,
      priorPresence: true,
    },
    {
      id: targetEpic.epic_id,
      kind: "epic",
      condition: "unblocked",
    },
  );
  expect(state.kind).toBe("met");
});

test("epic-unblocked: every row genuinely blocked → waiting", () => {
  // The whole epic is held by `epic-not-validated` (predicate 2 fires on
  // every row). No row is workable, no row is in the stuck set, so the
  // verdict is waiting.
  const task = makeTask({});
  const epic = makeEpic({ tasks: [task], last_validated_at: null });
  const snap = run([epic]);
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: epic.epic_id, kind: "epic", condition: "unblocked" },
  );
  expect(state.kind).toBe("waiting");
});

// ---------------------------------------------------------------------------
// Stuck — only `job-rejected` and `dep-on-epic-dangling` qualify.
// ---------------------------------------------------------------------------

test("stuck (task): approval=rejected → stuck", () => {
  const task = makeTask({ worker_phase: "done", approval: "rejected" });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual({
    tag: "blocked",
    reason: { kind: "job-rejected" },
  });
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: task.task_id, kind: "task", condition: "unblocked" },
  );
  expect(state.kind).toBe("stuck");
});

test("stuck (task): dep-on-epic-dangling → stuck", () => {
  const t = makeTask({ task_id: "fn-1-foo.1" });
  const epic = makeEpic({
    tasks: [t],
    depends_on_epics: ["fn-99-ghost"],
    resolved_epic_deps: [makeResolvedDep({ dep_token: "fn-99-ghost" })],
  });
  const snap = run([epic]);
  expect(snap.perTask.get(t.task_id)).toEqual({
    tag: "blocked",
    reason: { kind: "dep-on-epic-dangling", upstream: "fn-99-ghost" },
  });
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: t.task_id, kind: "task", condition: "unblocked" },
  );
  expect(state.kind).toBe("stuck");
});

test("stuck (epic): every row in the epic is rejected → stuck", () => {
  // Single rejected task whose epic has no other workable rows. The
  // epic-level unblocked check elevates this to stuck (no workable row
  // AND at least one row is human-only-blocked).
  const task = makeTask({ worker_phase: "done", approval: "rejected" });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: epic.epic_id, kind: "epic", condition: "unblocked" },
  );
  expect(state.kind).toBe("stuck");
});

test("stuck (epic): dep-on-epic-dangling on the only task → stuck", () => {
  const t = makeTask({ task_id: "fn-1-foo.1" });
  const epic = makeEpic({
    tasks: [t],
    depends_on_epics: ["fn-99-ghost"],
    resolved_epic_deps: [makeResolvedDep({ dep_token: "fn-99-ghost" })],
  });
  const snap = run([epic]);
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: epic.epic_id, kind: "epic", condition: "unblocked" },
  );
  expect(state.kind).toBe("stuck");
});

test("not-stuck (epic): one rejected sibling + one ready task → met (not stuck)", () => {
  // The `unblocked` condition asks "is there ANY workable row" — a
  // single rejected sibling doesn't override a genuinely-ready peer.
  // Stuck is reserved for "no workable row AND human-only-blocked".
  const rejected = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "rejected",
  });
  const ready = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
  });
  const epic = makeEpic({ tasks: [rejected, ready] });
  const snap = run([epic]);
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: epic.epic_id, kind: "epic", condition: "unblocked" },
  );
  expect(state.kind).toBe("met");
});

// ---------------------------------------------------------------------------
// not-found
// ---------------------------------------------------------------------------

test("not-found (task): absent from inputs and never seen → not-found", () => {
  const snap = run([]);
  const state = evaluateAwaitCondition(
    { epics: [], snapshot: snap, priorPresence: false },
    {
      id: "fn-999-ghost.7",
      kind: "task",
      condition: "complete",
    },
  );
  expect(state.kind).toBe("not-found");
});

test("not-found (epic): absent from inputs and never seen → not-found", () => {
  const snap = run([]);
  const state = evaluateAwaitCondition(
    { epics: [], snapshot: snap, priorPresence: false },
    { id: "fn-999-ghost", kind: "epic", condition: "unblocked" },
  );
  expect(state.kind).toBe("not-found");
});

test("not-found (task): the parent epic is on board but the task id is not in its tasks[]", () => {
  const epic = makeEpic({
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = run([epic]);
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: false },
    { id: "fn-1-foo.99", kind: "task", condition: "complete" },
  );
  expect(state.kind).toBe("not-found");
});

test("not-found→deleted: task present-then-absent + priorPresence flips to deleted", () => {
  // The task disappeared between subscribe ticks AND the command had
  // observed it earlier. With no re-query hit (default), this lands on
  // `deleted` so the command can exit 4 — the task isn't completed
  // because we didn't see its terminal state transition.
  const snap = run([]);
  const state: AwaitState = evaluateAwaitCondition(
    { epics: [], snapshot: snap, priorPresence: true },
    { id: "fn-1-foo.1", kind: "task", condition: "complete" },
  );
  expect(state.kind).toBe("deleted");
});

test("not-found→met: task present-then-absent + priorPresence + reQueryHit → met", () => {
  // The task popped off the default-visible board scope (its parent
  // epic went approved+closed), AND the scope-exempt re-query confirms
  // the row still exists in the daemon. That's the positive completion
  // signal for tasks that vanish with their epic.
  const snap = run([]);
  const state = evaluateAwaitCondition(
    {
      epics: [],
      snapshot: snap,
      priorPresence: true,
      reQueryHit: true,
    },
    { id: "fn-1-foo.1", kind: "task", condition: "complete" },
  );
  expect(state.kind).toBe("met");
});

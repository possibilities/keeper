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
  advanceCompleteStability,
  agentsIdleState,
  COMPLETE_CONFIRMATIONS,
  changedSignature,
  classifyTargetId,
  completeWatermark,
  drainedState,
  epicAddedMet,
  epicRemovedMet,
  evaluateAwaitCondition,
  findEpicByIdOrBare,
  gitCleanState,
  initCompleteStability,
  isJamReason,
  landedState,
  monitorRunningState,
  type NeedsHumanSignal,
  needsHumanSignalNeedsFold,
  needsHumanState,
  verdictKey,
  workable,
} from "../src/await-conditions";
import {
  INSTANT_DEATH_BREAKER_REASON,
  MERGE_ESCALATION_REASON_TOKEN,
  WORKTREE_FINALIZE_NON_FF_REASON,
  WORKTREE_RECOVER_REASON_PREFIX,
} from "../src/dispatch-failure-key";
import {
  INSTANT_DEATH_WALL_KEYS,
  type NeedsHumanInputs,
  type NeedsHumanProjection,
  projectNeedsHuman,
} from "../src/needs-human";
import { computeReadiness, type Verdict } from "../src/readiness";
import { computeLandedEpicIds } from "../src/readiness-client";
import type {
  EmbeddedJob,
  Epic,
  GitStatus,
  Job,
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
    model: null,
    worker_phase: "open",
    runtime_status: "todo",
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
    last_event_id: 0,
    updated_at: 0,
    depends_on_epics: [],
    tasks: [],
    jobs: [],
    job_links: [],
    resolved_epic_deps: null,
    last_validated_at: "2026-05-24T00:00:00Z",
    question: null,
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
    last_permission_prompt_at: null,
    last_permission_prompt_kind: null,
    git_dirty_count: 0,
    git_unattributed_to_live_count: 0,
    git_orphan_count: 0,
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
    // fn-721: a launched-but-not-yet-bound worker's own row is NOT workable —
    // it self-resolves (the row is effectively in motion), so it's `waiting`,
    // not actionable.
    { tag: "blocked", reason: { kind: "dispatch-pending" } },
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
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: task.task_id, kind: "task", condition: "complete" },
  );
  expect(state.kind).toBe("met");
});

test("fn-756 task-complete: done + pending → met (worker-done alone is complete)", () => {
  const task = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: task.task_id, kind: "task", condition: "complete" },
  );
  // fn-756: the approval enum no longer gates completion — worker-done is met.
  expect(state.kind).toBe("met");
});

test("task-complete: open + approved → waiting (worker hasn't finished)", () => {
  const task = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "open",
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: task.task_id, kind: "task", condition: "complete" },
  );
  expect(state.kind).toBe("waiting");
});

test("fn-756 task-complete: done + (ignored) rejected → met (approval no longer gates)", () => {
  const task = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: task.task_id, kind: "task", condition: "complete" },
  );
  // fn-756: a worker-done task is complete; the (now-ignored) `approval` field
  // does not hold it back.
  expect(state.kind).toBe("met");
});

test("fn-1015 task-complete: done AND idle (no live work) → met (completed verdict)", () => {
  // A bare done task with no embedded jobs / sub-agents / monitors folds to the
  // readiness `completed` verdict — the done-AND-idle moment.
  const task = makeTask({ task_id: "fn-1-foo.1", worker_phase: "done" });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual({ tag: "completed" });
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: task.task_id, kind: "task", condition: "complete" },
  );
  expect(state.kind).toBe("met");
});

test("fn-1015 task-complete: done BUT embedded job still working → waiting (not idle)", () => {
  // `worker_phase==="done"` raced ahead of the session winding down — an
  // embedded job is still `working`, so readiness holds the verdict at
  // `running:*`, NOT `completed`. `complete` must report `waiting` (the fn-1015
  // done-AND-idle change) instead of the old raw-`worker_phase` `met`.
  const task = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    jobs: [makeEmbeddedJob({ state: "working" })],
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)?.tag).not.toBe("completed");
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: task.task_id, kind: "task", condition: "complete" },
  );
  expect(state.kind).toBe("waiting");
});

// ---------------------------------------------------------------------------
// Complete-condition stability confirmation (done-unwind debounce).
//
// The done-AND-idle `completed` verdict can still flap back to `running` when a
// done task's owning worker re-activates during close-out reconciliation: the
// terminal-completed gate latches only the proven-dead ghost-liveness path,
// never the owning job's own working clause. `keeper await complete` fires on
// the FIRST completed snapshot, so the command-side stability gate withholds
// `met` until the completion HOLDS across COMPLETE_CONFIRMATIONS consecutive
// snapshots (target-row watermark non-regressing).
// ---------------------------------------------------------------------------

test("complete-stability window: computeReadiness flaps completed→running→completed when a done task's owning job re-activates, and the await surface fires met on the transient", () => {
  // The observed unwind shape, replayed against the real verdict pipeline: a
  // done task whose owning job goes idle (completed), re-activates to working
  // (running), then re-idles (completed). Each snapshot is a fresh
  // computeReadiness — the producer, not a hand-stamped verdict.
  const doneIdle = makeEpic({
    last_event_id: 10,
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        worker_phase: "done",
        jobs: [makeEmbeddedJob({ job_id: "w1", state: "stopped" })],
      }),
    ],
  });
  const reactivated = makeEpic({
    last_event_id: 11,
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        worker_phase: "done",
        jobs: [makeEmbeddedJob({ job_id: "w1", state: "working" })],
      }),
    ],
  });
  const s1 = run([doneIdle]);
  const s2 = run([reactivated]);
  const s3 = run([doneIdle]);
  expect(s1.perTask.get("fn-1-foo.1")).toEqual({ tag: "completed" });
  expect(s2.perTask.get("fn-1-foo.1")?.tag).toBe("running");
  expect(s3.perTask.get("fn-1-foo.1")).toEqual({ tag: "completed" });

  // The pure single-snapshot await evaluator fires `met` on the TRANSIENT s1 —
  // the window the command-side stability gate debounces.
  expect(
    evaluateAwaitCondition(
      { epics: [doneIdle], snapshot: s1, priorPresence: true },
      { id: "fn-1-foo.1", kind: "task", condition: "complete" },
    ).kind,
  ).toBe("met");
});

test("complete-stability: a transient completed→running→completed sequence never confirms", () => {
  let st = initCompleteStability();
  let step = advanceCompleteStability(st, true, 10); // s1 completed
  st = step.next;
  expect(step.confirmed).toBe(false);
  expect(st.streak).toBe(1);

  step = advanceCompleteStability(st, false, 11); // s2 running → reset
  st = step.next;
  expect(step.confirmed).toBe(false);
  expect(st.streak).toBe(0);

  step = advanceCompleteStability(st, true, 12); // s3 completed → back to one
  st = step.next;
  expect(step.confirmed).toBe(false);
  expect(st.streak).toBe(1);
});

test("complete-stability: a stable completed sequence confirms after COMPLETE_CONFIRMATIONS snapshots", () => {
  let st = initCompleteStability();
  const seen: boolean[] = [];
  for (let i = 0; i < COMPLETE_CONFIRMATIONS; i++) {
    const step = advanceCompleteStability(st, true, 10);
    st = step.next;
    seen.push(step.confirmed);
  }
  // Only the final (Nth) observation confirms; every earlier one holds.
  expect(seen.slice(0, -1).every((c) => c === false)).toBe(true);
  expect(seen.at(-1)).toBe(true);
  expect(st.streak).toBe(COMPLETE_CONFIRMATIONS);
});

test("complete-stability: never fires earlier than a single snapshot — the first completed observation is withheld", () => {
  // The bar only tightens: the first completed snapshot (today's fire point) is
  // never confirmed, so `met` can never fire earlier than the pre-debounce path.
  const step = advanceCompleteStability(initCompleteStability(), true, 10);
  expect(step.confirmed).toBe(false);
});

test("complete-stability: a watermark regression during confirmation resets the streak", () => {
  let st = initCompleteStability();
  let step = advanceCompleteStability(st, true, 20); // streak 1, basis 20
  st = step.next;
  expect(step.confirmed).toBe(false);

  // A rewound / stale re-delivered snapshot: still completed, but the row
  // version regressed below the basis → restart at one, do NOT confirm.
  step = advanceCompleteStability(st, true, 12);
  st = step.next;
  expect(step.confirmed).toBe(false);
  expect(st.streak).toBe(1);
  expect(st.watermark).toBe(12);

  // Holding steady from the new basis confirms.
  step = advanceCompleteStability(st, true, 12);
  expect(step.confirmed).toBe(true);
});

test("complete-stability: an ADVANCING watermark is normal churn — it still confirms; only a regression resets", () => {
  let st = initCompleteStability();
  let step = advanceCompleteStability(st, true, 10);
  st = step.next;
  step = advanceCompleteStability(st, true, 15); // advanced, not a regression
  expect(step.confirmed).toBe(true);
});

test("complete-stability: a null watermark degrades to the pure consecutive count (no false reset)", () => {
  let st = initCompleteStability();
  let step = advanceCompleteStability(st, true, null);
  st = step.next;
  expect(step.confirmed).toBe(false);
  step = advanceCompleteStability(st, true, null);
  expect(step.confirmed).toBe(true);
});

test("completeWatermark: a task target reads its parent epic's last_event_id, an epic target its own, absent → null", () => {
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    last_event_id: 42,
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  expect(
    completeWatermark([epic], {
      id: "fn-1-foo.1",
      kind: "task",
      condition: "complete",
    }),
  ).toBe(42);
  expect(
    completeWatermark([epic], {
      id: "fn-1-foo",
      kind: "epic",
      condition: "complete",
    }),
  ).toBe(42);
  expect(
    completeWatermark([epic], {
      id: "fn-9-absent.1",
      kind: "task",
      condition: "complete",
    }),
  ).toBeNull();
  expect(
    completeWatermark([], {
      id: "fn-1-foo",
      kind: "epic",
      condition: "complete",
    }),
  ).toBeNull();
});

// ---------------------------------------------------------------------------
// Task-started: the monotonic "work has begun at least once" milestone.
// True via any of {jobs non-empty, runtime_status in {in_progress, done},
// worker_phase=done}; never `stuck`, even on a blocked-but-ran row.
// ---------------------------------------------------------------------------

function startedTaskState(task: Task): AwaitState {
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  return evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: task.task_id, kind: "task", condition: "started" },
  );
}

test("task-started: embedded job present → met", () => {
  const task = makeTask({ jobs: [makeEmbeddedJob({})] });
  expect(startedTaskState(task).kind).toBe("met");
});

test("task-started: runtime_status=in_progress → met", () => {
  const task = makeTask({ runtime_status: "in_progress" });
  expect(startedTaskState(task).kind).toBe("met");
});

test("task-started: runtime_status=done → met", () => {
  const task = makeTask({ runtime_status: "done" });
  expect(startedTaskState(task).kind).toBe("met");
});

test("task-started: worker_phase=done → met (even with default runtime_status)", () => {
  const task = makeTask({ worker_phase: "done" });
  expect(startedTaskState(task).kind).toBe("met");
});

test("task-started: all defaults (no job, todo, open) → waiting", () => {
  const task = makeTask({});
  expect(startedTaskState(task).kind).toBe("waiting");
});

test("task-started: runtime_status=blocked alone (never ran) → waiting", () => {
  // An unrecognized/blocked status with no job and no worker-done is NOT
  // started — set membership, never `!== "todo"`.
  const task = makeTask({ runtime_status: "blocked" });
  expect(startedTaskState(task).kind).toBe("waiting");
});

test("task-started: blocked-but-ran (job present + runtime_status=blocked) → met, never stuck", () => {
  // A task that already ran a worker and then got blocked reads `met` — the
  // started predicate is evaluated BEFORE any stuck/blocked branch.
  const task = makeTask({
    jobs: [makeEmbeddedJob({})],
    runtime_status: "blocked",
  });
  expect(startedTaskState(task).kind).toBe("met");
});

test("task-started: absent + priorPresence → met (popped off ⇒ was started)", () => {
  // Monotonic: a started target that popped off the board fires `met` off
  // the absentBranch, NOT `deleted` — and needs no re-query.
  const snap = run([]);
  const state = evaluateAwaitCondition(
    { epics: [], snapshot: snap, priorPresence: true },
    { id: "fn-1-foo.1", kind: "task", condition: "started" },
  );
  expect(state.kind).toBe("met");
});

test("task-started: absent + no priorPresence → not-found", () => {
  const snap = run([]);
  const state = evaluateAwaitCondition(
    { epics: [], snapshot: snap, priorPresence: false },
    { id: "fn-1-foo.1", kind: "task", condition: "started" },
  );
  expect(state.kind).toBe("not-found");
});

// ---------------------------------------------------------------------------
// Epic-started: any task started OR an epic-level job present → met.
// ---------------------------------------------------------------------------

function startedEpicState(epic: Epic): AwaitState {
  const snap = run([epic]);
  return evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: epic.epic_id, kind: "epic", condition: "started" },
  );
}

test("epic-started: a task is started → met", () => {
  const task = makeTask({ runtime_status: "in_progress" });
  const epic = makeEpic({ tasks: [task] });
  expect(startedEpicState(epic).kind).toBe("met");
});

test("epic-started: epic-level job present, all tasks todo → met", () => {
  const task = makeTask({});
  const epic = makeEpic({ tasks: [task], jobs: [makeEmbeddedJob({})] });
  expect(startedEpicState(epic).kind).toBe("met");
});

test("epic-started: all tasks todo + no epic job → waiting", () => {
  const epic = makeEpic({ tasks: [makeTask({})] });
  expect(startedEpicState(epic).kind).toBe("waiting");
});

test("epic-started: absent + priorPresence → met (popped off ⇒ was started)", () => {
  const snap = run([]);
  const state = evaluateAwaitCondition(
    { epics: [], snapshot: snap, priorPresence: true },
    { id: "fn-1-foo", kind: "epic", condition: "started" },
  );
  expect(state.kind).toBe("met");
});

// ---------------------------------------------------------------------------
// Epic-complete: present-on-board → waiting; absent + priorPresence +
// reQueryHit → met; absent + priorPresence + re-query miss → deleted;
// absent + no priorPresence → not-found.
// ---------------------------------------------------------------------------

test("epic-complete: epic still on board → waiting (never met on the present branch)", () => {
  const task = makeTask({ worker_phase: "done" });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: epic.epic_id, kind: "epic", condition: "complete" },
  );
  // Even though the only task is done, the epic itself is still on the
  // board (its status hasn't flipped to done yet) — `met` only fires
  // when it pops off scope.
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
// fn-1193 — bare-id resolution refuses ambiguity (findEpicByIdOrBare + the
// epic-await surface). A bare `fn-N` matching 2+ live epics names every
// candidate instead of coin-flipping the first match; full-id resolution is
// unchanged.
// ---------------------------------------------------------------------------

test("fn-1193 findEpicByIdOrBare: unique bare fn-N resolves", () => {
  const a = makeEpic({ epic_id: "fn-7-a", epic_number: 7 });
  const b = makeEpic({ epic_id: "fn-8-b", epic_number: 8 });
  const r = findEpicByIdOrBare([a, b], "fn-7");
  expect(r.kind).toBe("found");
  expect(r.kind === "found" && r.epic.epic_id).toBe("fn-7-a");
});

test("fn-1193 findEpicByIdOrBare: no match → none", () => {
  const a = makeEpic({ epic_id: "fn-7-a", epic_number: 7 });
  expect(findEpicByIdOrBare([a], "fn-99").kind).toBe("none");
});

test("fn-1193 findEpicByIdOrBare: duplicate bare fn-N → ambiguous naming BOTH ids (sorted)", () => {
  // Two live epics share epic_number=7 — the resolver must refuse and name every
  // candidate rather than return the first by iteration order.
  const a = makeEpic({ epic_id: "fn-7-zeta", epic_number: 7 });
  const b = makeEpic({ epic_id: "fn-7-alpha", epic_number: 7 });
  const r = findEpicByIdOrBare([a, b], "fn-7");
  expect(r.kind).toBe("ambiguous");
  // Sorted, so the refusal is deterministic regardless of board order.
  expect(r.kind === "ambiguous" && r.matches).toEqual([
    "fn-7-alpha",
    "fn-7-zeta",
  ]);
});

test("fn-1193 findEpicByIdOrBare: full id always resolves, never ambiguous", () => {
  // Two epics share a number, but a FULL id addresses exactly one — unchanged.
  const a = makeEpic({ epic_id: "fn-7-zeta", epic_number: 7 });
  const b = makeEpic({ epic_id: "fn-7-alpha", epic_number: 7 });
  const r = findEpicByIdOrBare([a, b], "fn-7-alpha");
  expect(r.kind).toBe("found");
  expect(r.kind === "found" && r.epic.epic_id).toBe("fn-7-alpha");
});

test("fn-1193 epic-await: a bare fn-N matching two live epics → ambiguous terminal naming both", () => {
  const a = makeEpic({ epic_id: "fn-7-zeta", epic_number: 7 });
  const b = makeEpic({ epic_id: "fn-7-alpha", epic_number: 7 });
  const snap = run([a, b]);
  const state = evaluateAwaitCondition(
    { epics: [a, b], snapshot: snap, priorPresence: true },
    { id: "fn-7", kind: "epic", condition: "complete" },
  );
  expect(state.kind).toBe("ambiguous");
  // The detail carries every candidate id so the command can print the refusal.
  expect(state.detail).toContain("fn-7-alpha");
  expect(state.detail).toContain("fn-7-zeta");
});

// ---------------------------------------------------------------------------
// fn-1015 epic-complete: the present-branch close-row verdict state machine.
// present+open → waiting; present+done+idle-close-row → met; present+done+
// closer-live → waiting. The await-complete recent-done merge keeps a done epic
// present here; aged-out / deleted fall through to the absent branch (above).
// ---------------------------------------------------------------------------

test("fn-1015 epic-complete: present + open → waiting (close-row not completed)", () => {
  const epic = makeEpic({
    status: "open",
    tasks: [makeTask({ worker_phase: "done" })],
  });
  const snap = run([epic]);
  expect(snap.perCloseRow.get(epic.epic_id)?.tag).not.toBe("completed");
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: epic.epic_id, kind: "epic", condition: "complete" },
  );
  expect(state.kind).toBe("waiting");
});

test("fn-1015 epic-complete: present + done + idle close-row → met (completed verdict)", () => {
  // A done epic with no live close-scope work (no working epic job, no running
  // sub-agent, no held monitor) folds to the close-row `completed` verdict. With
  // the recent-done merge this epic stays present, so `complete` reads `met`
  // directly off `perCloseRow` — no board pop-off / re-query needed.
  const epic = makeEpic({
    status: "done",
    tasks: [makeTask({ worker_phase: "done" })],
  });
  const snap = run([epic]);
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual({ tag: "completed" });
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: epic.epic_id, kind: "epic", condition: "complete" },
  );
  expect(state.kind).toBe("met");
});

test("fn-1015 epic-complete: present + done + closer still live → waiting (close-row not idle)", () => {
  // `status==="done"` raced ahead of the closer — an epic-level `close` job is
  // still `working`, so the close-row holds at `running:*`, NOT `completed`.
  // `complete` must hold `waiting` until the closer winds down (the mutex stays
  // held), even though the epic is administratively done.
  const epic = makeEpic({
    status: "done",
    jobs: [makeEmbeddedJob({ plan_verb: "close", state: "working" })],
    tasks: [makeTask({ worker_phase: "done" })],
  });
  const snap = run([epic]);
  expect(snap.perCloseRow.get(epic.epic_id)?.tag).not.toBe("completed");
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: epic.epic_id, kind: "epic", condition: "complete" },
  );
  expect(state.kind).toBe("waiting");
});

test("fn-1015 epic-complete: aged out of recent-done window → absent → re-query hit → met", () => {
  // After the 1800s window a completion ages out: the epic drops from BOTH the
  // open AND recent-done scopes, so it lands on the absent branch. The
  // scope-exempt re-query still hits (the row lives on in the projection) → the
  // existing machinery resolves `met`. An agent arming long after completion
  // gets the right answer.
  const snap = run([]);
  const state = evaluateAwaitCondition(
    { epics: [], snapshot: snap, priorPresence: true, reQueryHit: true },
    { id: "fn-1-foo", kind: "epic", condition: "complete" },
  );
  expect(state.kind).toBe("met");
});

test("fn-1015 epic-complete: truly deleted → absent → re-query miss → deleted", () => {
  // Absent from both scopes AND the scope-exempt re-query misses → genuine
  // deletion, NOT completion. The TRUE-deletion path is retained unchanged.
  const snap = run([]);
  const state = evaluateAwaitCondition(
    { epics: [], snapshot: snap, priorPresence: true, reQueryHit: false },
    { id: "fn-1-foo", kind: "epic", condition: "complete" },
  );
  expect(state.kind).toBe("deleted");
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
  });
  const e2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    tasks: [t2],
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
  const task = makeTask({ worker_phase: "done" });
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
// fn-941: escalated-but-paused softening. A `runtime-blocked` task whose
// `block_escalations` latch is present reports `waiting` (escalation in flight)
// — NOT `stuck` — while the autopilot is paused, so an armed `--fail-on-stuck`
// await holds for the planner instead of surrendering. Unpaused (cold
// re-dispatch can fire) OR non-escalated stays `stuck`.
// ---------------------------------------------------------------------------

function runtimeBlockedSnap(taskId = "fn-1-foo.1") {
  const task = makeTask({ task_id: taskId, runtime_status: "blocked" });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  // Sanity: the verdict is the stamped runtime-blocked kind (stuck by default).
  expect(snap.perTask.get(taskId)).toEqual({
    tag: "blocked",
    reason: { kind: "runtime-blocked" },
  });
  return { task, epic, snap };
}

test("task-unblocked: runtime-blocked + escalated + paused → waiting (escalation in flight)", () => {
  const { task, epic, snap } = runtimeBlockedSnap();
  const state = evaluateAwaitCondition(
    {
      epics: [epic],
      snapshot: snap,
      priorPresence: true,
      escalatedTaskIds: new Set([task.task_id]),
      autopilotPaused: true,
    },
    { id: task.task_id, kind: "task", condition: "unblocked" },
  );
  expect(state.kind).toBe("waiting");
});

test("task-unblocked: runtime-blocked + escalated + UNPAUSED → stuck (cold re-dispatch can fire)", () => {
  const { task, epic, snap } = runtimeBlockedSnap();
  const state = evaluateAwaitCondition(
    {
      epics: [epic],
      snapshot: snap,
      priorPresence: true,
      escalatedTaskIds: new Set([task.task_id]),
      autopilotPaused: false,
    },
    { id: task.task_id, kind: "task", condition: "unblocked" },
  );
  expect(state.kind).toBe("stuck");
});

test("task-unblocked: runtime-blocked + NOT escalated + paused → stuck (no latch to soften)", () => {
  const { task, epic, snap } = runtimeBlockedSnap();
  const state = evaluateAwaitCondition(
    {
      epics: [epic],
      snapshot: snap,
      priorPresence: true,
      escalatedTaskIds: new Set<string>(),
      autopilotPaused: true,
    },
    { id: task.task_id, kind: "task", condition: "unblocked" },
  );
  expect(state.kind).toBe("stuck");
});

test("task-unblocked: runtime-blocked with no escalation inputs → stuck (backward-compat default)", () => {
  const { task, epic, snap } = runtimeBlockedSnap();
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: task.task_id, kind: "task", condition: "unblocked" },
  );
  expect(state.kind).toBe("stuck");
});

test("epic-unblocked: sole stuck row is escalated-but-paused → waiting (softened, not stuck)", () => {
  // An epic whose only task is a runtime-blocked + escalated row, autopilot
  // paused. The row's stuck-ness is softened, so the epic holds `waiting`
  // instead of surfacing `stuck`.
  const task = makeTask({ task_id: "fn-1-foo.1", runtime_status: "blocked" });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  const state = evaluateAwaitCondition(
    {
      epics: [epic],
      snapshot: snap,
      priorPresence: true,
      escalatedTaskIds: new Set([task.task_id]),
      autopilotPaused: true,
    },
    { id: epic.epic_id, kind: "epic", condition: "unblocked" },
  );
  expect(state.kind).toBe("waiting");
});

test("epic-unblocked: sole stuck row escalated but UNPAUSED → stuck (not softened)", () => {
  const task = makeTask({ task_id: "fn-1-foo.1", runtime_status: "blocked" });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  const state = evaluateAwaitCondition(
    {
      epics: [epic],
      snapshot: snap,
      priorPresence: true,
      escalatedTaskIds: new Set([task.task_id]),
      autopilotPaused: false,
    },
    { id: epic.epic_id, kind: "epic", condition: "unblocked" },
  );
  expect(state.kind).toBe("stuck");
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

// fn-756: the `approval=rejected → job-rejected → stuck` task path is REMOVED.
// The approval enum no longer gates, so a worker-done task is `completed`
// regardless of any (now-ignored) `approval` value — there is no `job-rejected`
// verdict to render `stuck`. The `dep-on-epic-dangling → stuck` path below is
// the surviving human-only-recoverable terminal blocker.

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

test("fn-721 (task): dispatch-pending row → waiting, NOT stuck (self-resolves)", () => {
  // A worker was launched against this task (an open `pending_dispatches`
  // row) but its SessionStart hasn't bound yet. The row renders
  // `dispatch-pending`, which is NOT workable and NOT in STUCK_REASON_KINDS,
  // so an `unblocked` await on it returns `waiting` — it self-resolves on the
  // bind / DispatchFailed / DispatchExpired discharge, no human action needed.
  const t = makeTask({ task_id: "fn-1-foo.1" });
  const epic = makeEpic({ tasks: [t] });
  const snap = computeReadiness(
    [epic],
    new Map(),
    [],
    new Map(),
    Number.NEGATIVE_INFINITY,
    [{ verb: "work", id: "fn-1-foo.1", dir: "/repo", dispatched_at: 0 }],
  );
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({
    tag: "blocked",
    reason: { kind: "dispatch-pending" },
  });
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: "fn-1-foo.1", kind: "task", condition: "unblocked" },
  );
  expect(state.kind).toBe("waiting");
});

test("fn-721 (task): a sibling demoted by a dispatch-pending occupant stays workable → met", () => {
  // The dispatched task 1 renders `dispatch-pending` (occupant); the
  // same-epic ready sibling task 2 is demoted to `single-task-per-epic`,
  // which IS workable (held back ONLY by the concurrency mutex). An
  // `unblocked` await on task 2 therefore returns `met`.
  const t1 = makeTask({ task_id: "fn-1-foo.1" });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
  });
  const epic = makeEpic({ tasks: [t1, t2] });
  const snap = computeReadiness(
    [epic],
    new Map(),
    [],
    new Map(),
    Number.NEGATIVE_INFINITY,
    [{ verb: "work", id: "fn-1-foo.1", dir: "/repo", dispatched_at: 0 }],
  );
  expect(snap.perTask.get("fn-1-foo.2")).toEqual({
    tag: "blocked",
    reason: { kind: "single-task-per-epic" },
  });
  const state = evaluateAwaitCondition(
    { epics: [epic], snapshot: snap, priorPresence: true },
    { id: "fn-1-foo.2", kind: "task", condition: "unblocked" },
  );
  expect(state.kind).toBe("met");
});

// fn-756: the epic-level "every row rejected → stuck" test is REMOVED — a
// worker-done task no longer renders `job-rejected` (it's `completed`), so the
// rejected-row stuck path is unreachable. `dep-on-epic-dangling` (below) is the
// surviving epic-level human-only-recoverable terminal blocker.

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

// ---------------------------------------------------------------------------
// git-clean / agents-idle pure predicates (fn-713)
// ---------------------------------------------------------------------------

function makeGitStatus(overrides: Partial<GitStatus>): GitStatus {
  return {
    project_dir: "/repo",
    branch: "main",
    head_oid: null,
    upstream: null,
    ahead: null,
    behind: null,
    dirty_count: 0,
    orphaned_count: 0,
    dirty_files: [],
    orphaned_files: [],
    jobs: [],
    last_event_id: 0,
    updated_at: 0,
    ...overrides,
  };
}

function makeJob(overrides: Partial<Job>): Job {
  return {
    job_id: "j-1",
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
    last_api_error_at: null,
    last_api_error_kind: null,
    last_input_request_at: null,
    last_input_request_kind: null,
    last_permission_prompt_at: null,
    last_permission_prompt_kind: null,
    git_dirty_count: 0,
    git_unattributed_to_live_count: 0,
    git_orphan_count: 0,
    monitors: null,
    ...overrides,
  } as Job;
}

test("git-clean: dirty=0 orphaned=0 → met", () => {
  const rows = [makeGitStatus({ project_dir: "/repo" })];
  expect(gitCleanState("/repo", rows).kind).toBe("met");
});

test("git-clean: no row for root → met (clean)", () => {
  const rows = [makeGitStatus({ project_dir: "/other" })];
  expect(gitCleanState("/repo", rows).kind).toBe("met");
});

test("git-clean: empty rows → met (clean)", () => {
  expect(gitCleanState("/repo", []).kind).toBe("met");
});

test("fn-897 B1: git-clean with seedRequired=true → waiting (unseeded, never clean)", () => {
  // Empty rows would normally read MET (clean); an unseeded surface (the boot
  // window) reads UNKNOWN instead, so it must hold `waiting`.
  expect(gitCleanState("/repo", [], true).kind).toBe("waiting");
  // Even a row that LOOKS clean is held while the surface is unseeded — the
  // seed flag overrides the row inspection entirely.
  const cleanRows = [makeGitStatus({ project_dir: "/repo" })];
  expect(gitCleanState("/repo", cleanRows, true).kind).toBe("waiting");
});

test("fn-897 B1: git-clean with seedRequired=false → unchanged (seeded clean is met)", () => {
  // The seeded path (explicit false) is byte-identical to the legacy two-arg form.
  const cleanRows = [makeGitStatus({ project_dir: "/repo" })];
  expect(gitCleanState("/repo", cleanRows, false).kind).toBe("met");
  expect(gitCleanState("/repo", [], false).kind).toBe("met");
});

test("git-clean: dirty>0 → waiting", () => {
  const rows = [makeGitStatus({ project_dir: "/repo", dirty_count: 3 })];
  expect(gitCleanState("/repo", rows).kind).toBe("waiting");
});

test("git-clean: orphaned>0 → waiting", () => {
  const rows = [makeGitStatus({ project_dir: "/repo", orphaned_count: 1 })];
  expect(gitCleanState("/repo", rows).kind).toBe("waiting");
});

test("git-clean: uses STRICT orphaned_count (not unattributed-to-live)", () => {
  // A row clean on dirty + strict orphaned is met even if it had dirty
  // files under another session — the predicate never reads dirty_files
  // attributions (that's the swap-point for the autopilot-gate variant).
  const rows = [
    makeGitStatus({
      project_dir: "/repo",
      dirty_count: 0,
      orphaned_count: 0,
      dirty_files: [{ path: "x" }],
    }),
  ];
  expect(gitCleanState("/repo", rows).kind).toBe("met");
});

test("git-clean: trailing-slash root normalizes against row project_dir", () => {
  const rows = [makeGitStatus({ project_dir: "/repo", dirty_count: 2 })];
  expect(gitCleanState("/repo/", rows).kind).toBe("waiting");
});

test("git-clean: sibling-dir root does NOT match (no false clean/dirty)", () => {
  // `/repo-sibling` must not match the `/repo` row — it has no row, so
  // it's met (clean) regardless of the /repo row being dirty.
  const rows = [makeGitStatus({ project_dir: "/repo", dirty_count: 9 })];
  expect(gitCleanState("/repo-sibling", rows).kind).toBe("met");
});

test("agents-idle: zero jobs → met", () => {
  expect(agentsIdleState("/repo", null, []).kind).toBe("met");
});

test("agents-idle: another working job in root → waiting", () => {
  const jobs = [makeJob({ job_id: "other", state: "working", cwd: "/repo" })];
  expect(agentsIdleState("/repo", "me", jobs).kind).toBe("waiting");
});

test("agents-idle: excludes own session id (self → idle)", () => {
  const jobs = [makeJob({ job_id: "me", state: "working", cwd: "/repo" })];
  expect(agentsIdleState("/repo", "me", jobs).kind).toBe("met");
});

test("agents-idle: ownSessionId null → no self-exclusion (own job counts)", () => {
  const jobs = [makeJob({ job_id: "me", state: "working", cwd: "/repo" })];
  expect(agentsIdleState("/repo", null, jobs).kind).toBe("waiting");
});

test("agents-idle: non-working job in root → met (only working counts)", () => {
  const jobs = [makeJob({ job_id: "other", state: "ended", cwd: "/repo" })];
  expect(agentsIdleState("/repo", "me", jobs).kind).toBe("met");
});

test("agents-idle: cwd inside root (prefix descendant) → waiting", () => {
  const jobs = [
    makeJob({ job_id: "other", state: "working", cwd: "/repo/sub/dir" }),
  ];
  expect(agentsIdleState("/repo", "me", jobs).kind).toBe("waiting");
});

test("agents-idle: cwd in a SIBLING dir does NOT false-match the root", () => {
  // `/repo-sibling` is NOT inside `/repo` — the prefix guard requires a
  // `/` boundary, so this is idle.
  const jobs = [
    makeJob({ job_id: "other", state: "working", cwd: "/repo-sibling" }),
  ];
  expect(agentsIdleState("/repo", "me", jobs).kind).toBe("met");
});

test("agents-idle: cwd === root exactly → waiting", () => {
  const jobs = [makeJob({ job_id: "other", state: "working", cwd: "/repo" })];
  expect(agentsIdleState("/repo", "me", jobs).kind).toBe("waiting");
});

test("agents-idle: null cwd job is skipped (never inside root)", () => {
  const jobs = [makeJob({ job_id: "other", state: "working", cwd: null })];
  expect(agentsIdleState("/repo", "me", jobs).kind).toBe("met");
});

test("agents-idle: working job OUTSIDE root → met", () => {
  const jobs = [
    makeJob({ job_id: "other", state: "working", cwd: "/elsewhere" }),
  ];
  expect(agentsIdleState("/repo", "me", jobs).kind).toBe("met");
});

// ---------------------------------------------------------------------------
// monitor-running pure predicate (fn-718) — own-session liveness, EXACT match
// ---------------------------------------------------------------------------

test("monitor-running: own-session matching monitor present → waiting", () => {
  const jobs = [
    makeJob({
      job_id: "me",
      monitors: JSON.stringify([
        { id: "m1", kind: "bash-bg", command: "watch.sh" },
      ]),
    }),
  ];
  expect(monitorRunningState("me", { command: "watch.sh" }, jobs).kind).toBe(
    "waiting",
  );
});

test("monitor-running: own-session no matching monitor → met (done)", () => {
  const jobs = [
    makeJob({
      job_id: "me",
      monitors: JSON.stringify([
        { id: "m1", kind: "bash-bg", command: "other.sh" },
      ]),
    }),
  ];
  expect(monitorRunningState("me", { command: "watch.sh" }, jobs).kind).toBe(
    "met",
  );
});

test("monitor-running: kind-match present → waiting (works without command)", () => {
  const jobs = [
    makeJob({
      job_id: "me",
      monitors: JSON.stringify([{ id: "m1", kind: "monitor" }]),
    }),
  ];
  expect(monitorRunningState("me", { kind: "monitor" }, jobs).kind).toBe(
    "waiting",
  );
});

test("monitor-running: kind-match absent → met (done)", () => {
  const jobs = [
    makeJob({
      job_id: "me",
      monitors: JSON.stringify([{ id: "m1", kind: "bash-bg" }]),
    }),
  ];
  expect(monitorRunningState("me", { kind: "monitor" }, jobs).kind).toBe("met");
});

test("monitor-running: both kind AND command must match (AND) → waiting", () => {
  const jobs = [
    makeJob({
      job_id: "me",
      monitors: JSON.stringify([
        { id: "m1", kind: "bash-bg", command: "watch.sh" },
      ]),
    }),
  ];
  expect(
    monitorRunningState("me", { kind: "bash-bg", command: "watch.sh" }, jobs)
      .kind,
  ).toBe("waiting");
  // Same command, WRONG kind → no match → met.
  expect(
    monitorRunningState("me", { kind: "monitor", command: "watch.sh" }, jobs)
      .kind,
  ).toBe("met");
});

test("monitor-running: prefix collision does NOT match (exact command only)", () => {
  // selector `my-script` must NOT match the running `my-script-v2`.
  const jobs = [
    makeJob({
      job_id: "me",
      monitors: JSON.stringify([
        { id: "m1", kind: "bash-bg", command: "my-script-v2" },
      ]),
    }),
  ];
  expect(monitorRunningState("me", { command: "my-script" }, jobs).kind).toBe(
    "met",
  );
});

test("monitor-running: a DIFFERENT session's matching monitor is ignored (own-session scope)", () => {
  const jobs = [
    makeJob({
      job_id: "other",
      monitors: JSON.stringify([
        { id: "m1", kind: "bash-bg", command: "watch.sh" },
      ]),
    }),
    makeJob({ job_id: "me", monitors: JSON.stringify([]) }),
  ];
  expect(monitorRunningState("me", { command: "watch.sh" }, jobs).kind).toBe(
    "met",
  );
});

test("monitor-running: terminal own job with monitors='[]' → met", () => {
  const jobs = [
    makeJob({ job_id: "me", state: "ended", monitors: JSON.stringify([]) }),
  ];
  expect(monitorRunningState("me", { command: "watch.sh" }, jobs).kind).toBe(
    "met",
  );
});

test("monitor-running: malformed monitors JSON → met (safe, no throw)", () => {
  const jobs = [makeJob({ job_id: "me", monitors: "{not valid json" })];
  expect(() =>
    monitorRunningState("me", { command: "watch.sh" }, jobs),
  ).not.toThrow();
  expect(monitorRunningState("me", { command: "watch.sh" }, jobs).kind).toBe(
    "met",
  );
});

test("monitor-running: monitors JSON not an array → met (safe)", () => {
  const jobs = [makeJob({ job_id: "me", monitors: JSON.stringify({ x: 1 }) })];
  expect(monitorRunningState("me", { command: "watch.sh" }, jobs).kind).toBe(
    "met",
  );
});

test("monitor-running: own job's monitors null → met (done)", () => {
  const jobs = [makeJob({ job_id: "me", monitors: null })];
  expect(monitorRunningState("me", { command: "watch.sh" }, jobs).kind).toBe(
    "met",
  );
});

test("monitor-running: own job absent from rows → met (vacuously done)", () => {
  const jobs = [
    makeJob({
      job_id: "other",
      monitors: JSON.stringify([
        { id: "m1", kind: "bash-bg", command: "watch.sh" },
      ]),
    }),
  ];
  expect(monitorRunningState("me", { command: "watch.sh" }, jobs).kind).toBe(
    "met",
  );
});

test("monitor-running: ownSessionId null → met (no own row, vacuously done)", () => {
  const jobs = [
    makeJob({
      job_id: "me",
      monitors: JSON.stringify([
        { id: "m1", kind: "bash-bg", command: "watch.sh" },
      ]),
    }),
  ];
  expect(monitorRunningState(null, { command: "watch.sh" }, jobs).kind).toBe(
    "met",
  );
});

// ---------------------------------------------------------------------------
// fn-1015 board predicates: drained / isJamReason
// ---------------------------------------------------------------------------

const READY: Verdict = { tag: "ready" };
const DONE: Verdict = { tag: "completed" };

test("isJamReason: finalize-non-ff + merge-conflict are jams; recover* is NOT", () => {
  expect(isJamReason("worktree-finalize-non-fast-forward")).toBe(true);
  expect(
    isJamReason("worktree-merge-conflict: merging X into Y — conflict"),
  ).toBe(true);
  // The auto-clear prefix is excluded even though it shares the namespace.
  expect(isJamReason("worktree-recover-conflict")).toBe(false);
  expect(isJamReason("worktree-recover-push-failed")).toBe(false);
  // Unrelated reasons never count.
  expect(isJamReason("job-rejected")).toBe(false);
  expect(isJamReason("worktree-merge-local-timeout")).toBe(false);
});

test("drained: empty open board → met", () => {
  const r = drainedState({
    perTask: new Map(),
    perCloseRow: new Map(),
    openEpicCount: 0,
    pendingDispatchCount: 0,
    runningJobCount: 0,
    catchingUp: false,
  });
  expect(r.kind).toBe("met");
});

test("drained: all verdicts completed → met", () => {
  const r = drainedState({
    perTask: new Map([["fn-1-a.1", DONE]]),
    perCloseRow: new Map([["fn-1-a", DONE]]),
    openEpicCount: 1,
    pendingDispatchCount: 0,
    runningJobCount: 0,
    catchingUp: false,
  });
  expect(r.kind).toBe("met");
});

test("drained: a ready (deferred-style) verdict → waiting (not drained)", () => {
  const r = drainedState({
    perTask: new Map([["fn-1-a.1", READY]]),
    perCloseRow: new Map(),
    openEpicCount: 1,
    pendingDispatchCount: 0,
    runningJobCount: 0,
    catchingUp: false,
  });
  expect(r.kind).toBe("waiting");
});

test("drained: a running job → waiting", () => {
  const r = drainedState({
    perTask: new Map([["fn-1-a.1", DONE]]),
    perCloseRow: new Map(),
    openEpicCount: 1,
    pendingDispatchCount: 0,
    runningJobCount: 1,
    catchingUp: false,
  });
  expect(r.kind).toBe("waiting");
});

test("drained: a pending dispatch → waiting", () => {
  const r = drainedState({
    perTask: new Map(),
    perCloseRow: new Map(),
    openEpicCount: 0,
    pendingDispatchCount: 1,
    runningJobCount: 0,
    catchingUp: false,
  });
  expect(r.kind).toBe("waiting");
});

test("drained: catching_up → waiting even when otherwise drained", () => {
  const r = drainedState({
    perTask: new Map(),
    perCloseRow: new Map(),
    openEpicCount: 0,
    pendingDispatchCount: 0,
    runningJobCount: 0,
    catchingUp: true,
  });
  expect(r.kind).toBe("waiting");
});

test("drained: jam sticky + --fail-on-stuck → stuck", () => {
  const r = drainedState({
    perTask: new Map(),
    perCloseRow: new Map(),
    openEpicCount: 0,
    pendingDispatchCount: 0,
    runningJobCount: 0,
    catchingUp: false,
    dispatchFailureReasons: ["worktree-finalize-non-fast-forward"],
    failOnStuck: true,
  });
  expect(r.kind).toBe("stuck");
});

test("drained: recover* sticky + --fail-on-stuck → NOT stuck (met when at rest)", () => {
  const r = drainedState({
    perTask: new Map(),
    perCloseRow: new Map(),
    openEpicCount: 0,
    pendingDispatchCount: 0,
    runningJobCount: 0,
    catchingUp: false,
    dispatchFailureReasons: ["worktree-recover-conflict"],
    failOnStuck: true,
  });
  expect(r.kind).toBe("met");
});

test("drained: jam sticky WITHOUT --fail-on-stuck → not escalated (met at rest)", () => {
  const r = drainedState({
    perTask: new Map(),
    perCloseRow: new Map(),
    openEpicCount: 0,
    pendingDispatchCount: 0,
    runningJobCount: 0,
    catchingUp: false,
    dispatchFailureReasons: ["worktree-merge-conflict: x"],
    failOnStuck: false,
  });
  expect(r.kind).toBe("met");
});

// ---------------------------------------------------------------------------
// fn-1015 edge predicates: epic-added / epic-removed
// ---------------------------------------------------------------------------

test("epicAddedMet: baseline === current → false (never on first paint)", () => {
  expect(epicAddedMet(["fn-1-a"], ["fn-1-a"])).toBe(false);
});

test("epicAddedMet: a new id appears → true; narrowed by target", () => {
  expect(epicAddedMet(["fn-1-a"], ["fn-1-a", "fn-2-b"])).toBe(true);
  expect(epicAddedMet(["fn-1-a"], ["fn-1-a", "fn-2-b"], "fn-2-b")).toBe(true);
  // a different new id does not satisfy a specific target
  expect(epicAddedMet(["fn-1-a"], ["fn-1-a", "fn-3-c"], "fn-2-b")).toBe(false);
  // bare-id target matches the full id
  expect(epicAddedMet(["fn-1-a"], ["fn-1-a", "fn-2-b"], "fn-2")).toBe(true);
});

test("epicRemovedMet: present-then-absent → true; absent-at-baseline → false", () => {
  expect(epicRemovedMet(["fn-1-a", "fn-2-b"], ["fn-1-a"], "fn-2-b")).toBe(true);
  expect(epicRemovedMet(["fn-1-a", "fn-2-b"], ["fn-1-a"], "fn-2")).toBe(true);
  // never saw it → can't observe removal
  expect(epicRemovedMet(["fn-1-a"], ["fn-1-a"], "fn-9-z")).toBe(false);
  // still present → waiting
  expect(epicRemovedMet(["fn-1-a"], ["fn-1-a"], "fn-1-a")).toBe(false);
});

// ---------------------------------------------------------------------------
// fn-1016 landed (merge-landed milestone)
// ---------------------------------------------------------------------------

test("landedState: met when the epic is in the merge-landed set (full + bare)", () => {
  expect(landedState("fn-2-b", ["fn-1-a", "fn-2-b"])).toEqual({
    kind: "met",
    detail: "lane merged to default (fn-2-b)",
  });
  // bare-id target resolves against the full id in the set
  expect(landedState("fn-2", ["fn-1-a", "fn-2-b"]).kind).toBe("met");
});

test("landedState: waiting when done-but-unmerged (not yet in the set)", () => {
  // worktree mode ON: the epic finished (done) but its lane hasn't merged to
  // default, so it is absent from `landedEpicIds` → waiting, not met.
  expect(landedState("fn-2-b", ["fn-1-a"])).toEqual({
    kind: "waiting",
    detail: "lane not yet merged to default",
  });
  expect(landedState("fn-2-b", []).kind).toBe("waiting");
});

test("landedState: undefined set (not opted in / unpainted) → waiting, never met", () => {
  expect(landedState("fn-2-b", undefined)).toEqual({
    kind: "waiting",
    detail: "merge-landed signal not yet available",
  });
});

test("landedState: degrades to complete semantics when worktree mode is OFF", () => {
  // OFF → no lanes; `computeLandedEpicIds` bakes merged ⇔ done into the set,
  // so a done epic reads `met` and an open one stays `waiting`.
  const epics = [
    makeEpic({ epic_id: "fn-2-b", epic_number: 2, status: "done" }),
    makeEpic({ epic_id: "fn-3-c", epic_number: 3, status: "open" }),
  ];
  const landedOff = computeLandedEpicIds(false, [], epics);
  expect(landedState("fn-2-b", landedOff).kind).toBe("met");
  expect(landedState("fn-3-c", landedOff).kind).toBe("waiting");
  // worktree ON ignores `status`, reading only the projection ids.
  const landedOn = computeLandedEpicIds(true, ["fn-3-c"], epics);
  expect(landedState("fn-3-c", landedOn).kind).toBe("met");
  expect(landedState("fn-2-b", landedOn).kind).toBe("waiting");
});

// ---------------------------------------------------------------------------
// fn-1015 changed signature
// ---------------------------------------------------------------------------

test("verdictKey: stable per tag + reason", () => {
  expect(verdictKey({ tag: "ready" })).toBe("ready");
  expect(verdictKey({ tag: "completed" })).toBe("completed");
  expect(verdictKey({ tag: "blocked", reason: { kind: "job-rejected" } })).toBe(
    "blocked:job-rejected",
  );
});

test("changedSignature: identical boards hash identically; a verdict move differs", () => {
  const base = {
    epics: [{ epic_id: "fn-1-a", status: "open" as string | null }],
    perTask: new Map<string, Verdict>([["fn-1-a.1", READY]]),
    perCloseRow: new Map<string, Verdict>(),
    perEpic: new Map<string, Verdict>([["fn-1-a", READY]]),
    autopilot: {
      mode: "yolo",
      paused: false,
      worktreeMode: false,
      maxConcurrentJobs: null,
      maxConcurrentPerRootStored: 1,
    },
  };
  const same = changedSignature(base);
  expect(changedSignature(base)).toBe(same);
  // map-iteration-order churn does not perturb the signature
  const reordered = {
    ...base,
    perTask: new Map<string, Verdict>([["fn-1-a.1", READY]]),
  };
  expect(changedSignature(reordered)).toBe(same);
  // a verdict change moves the hash
  const moved = {
    ...base,
    perTask: new Map<string, Verdict>([["fn-1-a.1", DONE]]),
  };
  expect(changedSignature(moved)).not.toBe(same);
  // an autopilot pause toggle moves the hash
  const paused = { ...base, autopilot: { ...base.autopilot, paused: true } };
  expect(changedSignature(paused)).not.toBe(same);
});

test("changedSignature: keys on STORED per-root — a stored change fires even while worktree is off; a reconnect re-paint stays stable", () => {
  const base = {
    epics: [{ epic_id: "fn-1-a", status: "open" as string | null }],
    perTask: new Map<string, Verdict>([["fn-1-a.1", READY]]),
    perCloseRow: new Map<string, Verdict>(),
    perEpic: new Map<string, Verdict>([["fn-1-a", READY]]),
    autopilot: {
      mode: "yolo",
      paused: false,
      worktreeMode: false,
      maxConcurrentJobs: null,
      maxConcurrentPerRootStored: 1,
    },
  };
  const same = changedSignature(base);
  // Re-paint of the identical (unchanged) board hashes identically — no edge.
  expect(changedSignature({ ...base })).toBe(same);
  // Setting the stored cap 1→3 while worktree is OFF (effective stays 1) still
  // moves the hash — a visible board move.
  const storedBumped = {
    ...base,
    autopilot: { ...base.autopilot, maxConcurrentPerRootStored: 3 },
  };
  expect(changedSignature(storedBumped)).not.toBe(same);
});

// ---------------------------------------------------------------------------
// fn-1150 needs-human await predicates: presence per family, jam-class
// filtering, subset non-double-count, signature anchoring, reconnect baseline
// retention, and the derived dispatch-failures opt-in (+ its wiring invariant).
// ---------------------------------------------------------------------------

/** Build a needs-human projection from a partial input set (all families zero
 *  by default). `dispatchFailures` rows carry only reason (verb/id fill in a
 *  stable key); target resolution never touches the counts we assert on. */
function projectFrom(
  overrides: Partial<NeedsHumanInputs>,
): NeedsHumanProjection {
  return projectNeedsHuman({
    dispatchFailures: [],
    deadLetters: 0,
    blockEscalations: 0,
    parkedQuestionEpicIds: [],
    epicIds: [],
    ...overrides,
  });
}

/** One sticky `dispatch_failures` row with a given reason. */
function stickyRow(reason: string, id = "fn-1-a.1") {
  return { verb: "work", id, reason, dir: "" };
}

const FOLD_OPEN = { dispatchFoldOpened: true } as const;

test("needsHumanSignalNeedsFold: the dispatch trio + umbrella need the fold; the other three do not", () => {
  // Dispatch-derived (read the jam class / wall verdict off `dispatch_failures`).
  expect(needsHumanSignalNeedsFold("stuck-dispatch")).toBe(true);
  expect(needsHumanSignalNeedsFold("finalize-non-ff")).toBe(true);
  expect(needsHumanSignalNeedsFold("instant-death-wall")).toBe(true);
  expect(needsHumanSignalNeedsFold("needs-human")).toBe(true);
  // Always-folded snapshot members — must NOT open the dispatch-failures fold.
  expect(needsHumanSignalNeedsFold("dead-letter")).toBe(false);
  expect(needsHumanSignalNeedsFold("block-escalation")).toBe(false);
  expect(needsHumanSignalNeedsFold("parked-question")).toBe(false);
});

test("needs-human presence: dead-letter fires on a parked dead letter, else waits", () => {
  expect(needsHumanState("dead-letter", projectFrom({}), FOLD_OPEN).kind).toBe(
    "waiting",
  );
  const p = projectFrom({ deadLetters: 2 });
  expect(needsHumanState("dead-letter", p, FOLD_OPEN).kind).toBe("met");
  // A different family present does NOT satisfy dead-letter.
  expect(
    needsHumanState(
      "dead-letter",
      projectFrom({ blockEscalations: 1 }),
      FOLD_OPEN,
    ).kind,
  ).toBe("waiting");
});

test("needs-human presence: block-escalation fires on an escalation latch", () => {
  expect(
    needsHumanState("block-escalation", projectFrom({}), FOLD_OPEN).kind,
  ).toBe("waiting");
  expect(
    needsHumanState(
      "block-escalation",
      projectFrom({ blockEscalations: 1 }),
      FOLD_OPEN,
    ).kind,
  ).toBe("met");
});

test("needs-human presence: parked-question fires on an epic carrying a question", () => {
  expect(
    needsHumanState("parked-question", projectFrom({}), FOLD_OPEN).kind,
  ).toBe("waiting");
  expect(
    needsHumanState(
      "parked-question",
      projectFrom({ parkedQuestionEpicIds: ["fn-1-a"] }),
      FOLD_OPEN,
    ).kind,
  ).toBe("met");
});

test("needs-human jam filtering: an occupancy / self-clearing sticky never satisfies stuck-dispatch", () => {
  // A `worktree-recover*` row self-clears (isJamReason false) — broad
  // stuckDispatches counts it, but the alarm predicate reads the jam class only.
  const recover = projectFrom({
    dispatchFailures: [stickyRow(`${WORKTREE_RECOVER_REASON_PREFIX}-conflict`)],
  });
  expect(recover.counts.stuckDispatches).toBe(1);
  expect(recover.jamCount).toBe(0);
  expect(needsHumanState("stuck-dispatch", recover, FOLD_OPEN).kind).toBe(
    "waiting",
  );
  // A genuine jam (merge-conflict close-sink) trips it.
  const jam = projectFrom({
    dispatchFailures: [stickyRow(`${MERGE_ESCALATION_REASON_TOKEN}: x into y`)],
  });
  expect(jam.jamCount).toBe(1);
  expect(needsHumanState("stuck-dispatch", jam, FOLD_OPEN).kind).toBe("met");
});

test("needs-human presence: finalize-non-ff fires on the origin-ahead non-ff jam", () => {
  const p = projectFrom({
    dispatchFailures: [stickyRow(WORKTREE_FINALIZE_NON_FF_REASON)],
  });
  expect(needsHumanState("finalize-non-ff", p, FOLD_OPEN).kind).toBe("met");
  // A non-finalize jam does NOT satisfy the finalize-non-ff subset token.
  const otherJam = projectFrom({
    dispatchFailures: [stickyRow(`${MERGE_ESCALATION_REASON_TOKEN}: x`)],
  });
  expect(needsHumanState("finalize-non-ff", otherJam, FOLD_OPEN).kind).toBe(
    "waiting",
  );
});

test("needs-human presence: instant-death-wall fires only at/above the wall threshold", () => {
  // One breaker sticky is below the wall — a single breaker doing its job.
  const one = projectFrom({
    dispatchFailures: [stickyRow(INSTANT_DEATH_BREAKER_REASON, "fn-1-a.1")],
  });
  expect(one.counts.instantDeathWall).toBe(1);
  expect(one.instantDeathWallTripped).toBe(false);
  expect(needsHumanState("instant-death-wall", one, FOLD_OPEN).kind).toBe(
    "waiting",
  );
  // Enough distinct keys to read as an account/quota wall.
  const rows = [];
  for (let i = 0; i < INSTANT_DEATH_WALL_KEYS; i++) {
    rows.push(stickyRow(INSTANT_DEATH_BREAKER_REASON, `fn-1-a.${i + 1}`));
  }
  const wall = projectFrom({ dispatchFailures: rows });
  expect(wall.instantDeathWallTripped).toBe(true);
  expect(needsHumanState("instant-death-wall", wall, FOLD_OPEN).kind).toBe(
    "met",
  );
  // A breaker sticky is NOT a jam, so it never satisfies stuck-dispatch.
  expect(needsHumanState("stuck-dispatch", wall, FOLD_OPEN).kind).toBe(
    "waiting",
  );
});

test("needs-human umbrella: fires on ANY family (dispatch part = the jam class)", () => {
  expect(needsHumanState("needs-human", projectFrom({}), FOLD_OPEN).kind).toBe(
    "waiting",
  );
  for (const p of [
    projectFrom({ deadLetters: 1 }),
    projectFrom({ blockEscalations: 1 }),
    projectFrom({ parkedQuestionEpicIds: ["fn-1-a"] }),
    projectFrom({
      dispatchFailures: [stickyRow(WORKTREE_FINALIZE_NON_FF_REASON)],
    }),
  ]) {
    expect(needsHumanState("needs-human", p, FOLD_OPEN).kind).toBe("met");
  }
  // An occupancy sticky alone (non-jam) does NOT trip the umbrella — the
  // dispatch contribution is the operator-jam class, not the broad count.
  const occupancy = projectFrom({
    dispatchFailures: [
      stickyRow(`${WORKTREE_RECOVER_REASON_PREFIX}-push-failed`),
    ],
  });
  expect(occupancy.counts.stuckDispatches).toBe(1);
  expect(needsHumanState("needs-human", occupancy, FOLD_OPEN).kind).toBe(
    "waiting",
  );
});

test("needs-human umbrella: a lone finalize-non-ff row is ONE signal, never double-counted", () => {
  // stuckDispatches counts it once (via the broad member); finalizeNonFf is a
  // SUBSET surfaced separately and never re-added into the total.
  const p = projectFrom({
    dispatchFailures: [stickyRow(WORKTREE_FINALIZE_NON_FF_REASON)],
  });
  expect(p.counts.stuckDispatches).toBe(1);
  expect(p.counts.finalizeNonFf).toBe(1);
  expect(p.counts.total).toBe(1);
  expect(needsHumanState("needs-human", p, FOLD_OPEN).kind).toBe("met");
});

test("needs-human every state carries the current signature", () => {
  const p = projectFrom({ deadLetters: 1 });
  const met = needsHumanState("dead-letter", p, FOLD_OPEN);
  expect(met.kind).toBe("met");
  expect(met.signature).toBe(p.signature);
  const waiting = needsHumanState("stuck-dispatch", p, FOLD_OPEN);
  expect(waiting.kind).toBe("waiting");
  expect(waiting.signature).toBe(p.signature);
});

test("needs-human anchor: a present-at-arm signal whose signature MATCHES the anchor holds (anti-spin)", () => {
  const p = projectFrom({
    dispatchFailures: [stickyRow(WORKTREE_FINALIZE_NON_FF_REASON)],
  });
  // No anchor → fires immediately (level-triggered presence).
  expect(needsHumanState("stuck-dispatch", p, FOLD_OPEN).kind).toBe("met");
  // Anchored on the SAME signature → still-present, already-triaged → waiting.
  const held = needsHumanState("stuck-dispatch", p, {
    dispatchFoldOpened: true,
    since: p.signature,
  });
  expect(held.kind).toBe("waiting");
  expect(held.signature).toBe(p.signature);
});

test("needs-human anchor: a NEW signal landing beside a persisting one fires", () => {
  const before = projectFrom({
    dispatchFailures: [stickyRow(WORKTREE_FINALIZE_NON_FF_REASON)],
  });
  // A dead letter lands beside the persisting jam — signature moves.
  const after = projectFrom({
    dispatchFailures: [stickyRow(WORKTREE_FINALIZE_NON_FF_REASON)],
    deadLetters: 1,
  });
  expect(after.signature).not.toBe(before.signature);
  const fired = needsHumanState("stuck-dispatch", after, {
    dispatchFoldOpened: true,
    since: before.signature,
  });
  expect(fired.kind).toBe("met");
  expect(fired.signature).toBe(after.signature);
});

test("needs-human anchor: a reconnect re-paint of the UNCHANGED board keeps the anchor held", () => {
  // Baseline retention: the signature is a pure function of the signal set, so a
  // re-paint of the same board recomputes the SAME signature — an anchor captured
  // once still holds across the re-paint (never re-anchors, never spuriously fires).
  const inputs: NeedsHumanInputs = {
    dispatchFailures: [stickyRow(`${MERGE_ESCALATION_REASON_TOKEN}: x`)],
    deadLetters: 0,
    blockEscalations: 0,
    parkedQuestionEpicIds: [],
    epicIds: [],
  };
  const first = projectNeedsHuman(inputs);
  // Re-paint: same signal set, rows rebuilt fresh (a new array, same content).
  const repaint = projectNeedsHuman({
    ...inputs,
    dispatchFailures: [...inputs.dispatchFailures],
  });
  expect(repaint.signature).toBe(first.signature);
  const held = needsHumanState("stuck-dispatch", repaint, {
    dispatchFoldOpened: true,
    since: first.signature,
  });
  expect(held.kind).toBe("waiting");
});

test("needs-human invariant: a dispatch-derived signal with the fold CLOSED throws (wiring bug, never a silent wait)", () => {
  const p = projectFrom({});
  for (const signal of [
    "stuck-dispatch",
    "finalize-non-ff",
    "instant-death-wall",
    "needs-human",
  ] satisfies NeedsHumanSignal[]) {
    expect(() =>
      needsHumanState(signal, p, { dispatchFoldOpened: false }),
    ).toThrow();
  }
  // The always-folded signals never require the fold — evaluate cleanly.
  for (const signal of [
    "dead-letter",
    "block-escalation",
    "parked-question",
  ] satisfies NeedsHumanSignal[]) {
    expect(needsHumanState(signal, p, { dispatchFoldOpened: false }).kind).toBe(
      "waiting",
    );
  }
});

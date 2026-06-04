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
  type RunningReason,
  type Verdict,
} from "../src/readiness";
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
// Fixture builders — minimal, no defaults pollution
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task>): Task {
  return {
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    task_number: 1,
    title: "task",
    target_repo: null,
    tier: null,
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
    created_by_closer_of: null,
    sort_path: "000001",
    queue_jump: 0,
    resolved_epic_deps: null,
    last_validated_at: "2026-05-24T00:00:00Z",
    ...overrides,
  };
}

/**
 * fn-637.4: build a `ResolvedEpicDep` projection entry — the shape the
 * reducer's `enrichEpicDep` would emit for a single token in a consumer
 * epic's `depends_on_epics` array. Predicate 9 now reads off this projection
 * instead of calling the resolver live, so test fixtures construct epics
 * with a populated `resolved_epic_deps` and assert on the same surface the
 * reducer produces.
 */
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
    last_permission_prompt_at: null,
    last_permission_prompt_kind: null,
    git_dirty_count: 0,
    git_unattributed_to_live_count: 0,
    git_orphan_count: 0,
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
    last_permission_prompt_at: null,
    last_permission_prompt_kind: null,
    ...overrides,
  };
}

function blocked(reason: BlockReason): Verdict {
  return { tag: "blocked", reason };
}

function running(reason: RunningReason): Verdict {
  return { tag: "running", reason };
}

function run(
  epics: Epic[],
  jobs: Map<string, Job> = new Map(),
  subs: SubagentInvocation[] = [],
  gitStatusByProjectDir: Map<
    string,
    { dirty_count: number; unattributed_to_live_count: number }
  > = new Map(),
) {
  return computeReadiness(epics, jobs, subs, gitStatusByProjectDir);
}

// fn-638.4: variant that threads an explicit `now` (unix seconds) into
// `computeReadiness` for the staleness-sensitive sub-agent predicate.
// fn-637.4: the `completedEpics` slot is gone — predicate 9 now reads the
// projected `epic.resolved_epic_deps` tri-state, no resolver-only sub
// remains.
function runWithNow(
  epics: Epic[],
  subs: SubagentInvocation[],
  now: number,
  jobs: Map<string, Job> = new Map(),
) {
  return computeReadiness(epics, jobs, subs, new Map(), now);
}

// ---------------------------------------------------------------------------
// Predicate-ordering matrix
// ---------------------------------------------------------------------------

test("predicate 5 (own-progress-main) wins over 1 (terminal-completed): done+approved with working job → job-running (fn-671)", () => {
  // fn-671: the per-task predicate 1 now guards on worker liveness — a
  // `done+approved` task whose embedded session is still `working`
  // (planctl stamped `worker_done_at` and the human approved before the
  // Claude Stop/SessionEnd landed) must NOT collapse to `completed`,
  // because that would free both the per-epic and per-root mutex while
  // the worker is still alive and let the autopilot dispatch a sibling
  // into the same root. The verdict falls through to predicate 5
  // (`job-running`), which IS a mutex occupant via `isLiveWorkOccupant`.
  // Pre-fn-671 this test asserted the OLD inversion ("predicate 1 wins
  // over 5") — the autopilot incident that motivated the rename.
  const task = makeTask({
    worker_phase: "done",
    approval: "approved",
    jobs: [makeEmbeddedJob({ state: "working" })],
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual(
    running({ kind: "job-running" }),
  );
});

// ---------------------------------------------------------------------------
// fn-671: per-task worker-liveness guard on predicate 1. The five tests
// below mirror the close-row race tests further down (where the
// completed-but-still-alive race used to be caught) — but now assert on
// `perTask` directly, because the per-task predicate is the primary lock
// path after fn-671. The close-row fan-in remains as a backstop but is
// normally unreachable.
// ---------------------------------------------------------------------------

test("fn-671: done+approved task with working embedded job → running:job-running, occupies per-root mutex AND blocks sibling on same root", () => {
  // The exact incident: T1 is administratively complete (planctl done +
  // human approved) but the Claude session hasn't Stopped yet. T2 lives
  // on the same project root and would otherwise be `ready`. The
  // per-task guard holds T1 at `running:job-running`, which is a root
  // occupant via `isRootOccupant`, so the per-root mutex demotes T2 to
  // `single-task-per-root` — preventing the autopilot from dispatching
  // T2 while T1's worker is still alive.
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "working" })],
  });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    // T2 is fully ready in isolation (no deps, validated epic).
  });
  const epic = makeEpic({ tasks: [t1, t2] });
  const snap = run([epic]);
  expect(snap.perTask.get(t1.task_id)).toEqual(
    running({ kind: "job-running" }),
  );
  // T2 is demoted by the per-EPIC mutex (T1 occupies the slot). The
  // per-epic check runs first; per-root would also have demoted it.
  expect(snap.perTask.get(t2.task_id)).toEqual(
    blocked({ kind: "single-task-per-epic" }),
  );
});

test("fn-671: done+approved task with stopped job + running sub-agent → running:sub-agent-running", () => {
  // Main job has Stopped but a sub-agent under that worker session is
  // still running. The per-task guard's second clause (sub-agent
  // liveness via `anyEmbeddedJobHasRunningSubagent`) holds the task at
  // `running:sub-agent-running` — same mutex implications as above.
  // makeEmbeddedJob and makeSub both default `job_id: "session-1"`, so
  // an unkeyed pair already lines up for `subRunningByJobId`.
  const task = makeTask({
    worker_phase: "done",
    approval: "approved",
    jobs: [makeEmbeddedJob({ state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [task] });
  const subs = [makeSub({ status: "running" })];
  const snap = run([epic], new Map(), subs);
  expect(snap.perTask.get(task.task_id)).toEqual(
    running({ kind: "sub-agent-running" }),
  );
});

test("fn-671: done+approved task with stale running sub-agent → running:sub-agent-stale (asserted via runWithNow)", () => {
  // The sub-agent died silently — still in `running` status, ts beyond
  // SUBAGENT_STALENESS_SEC=120s. The verdict surfaces `sub-agent-stale`
  // for human visibility but STILL occupies the per-root mutex (no
  // auto-reaper; correctness over throughput, cleared by autopilot
  // pause + manual replay).
  const task = makeTask({
    worker_phase: "done",
    approval: "approved",
    jobs: [makeEmbeddedJob({ state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [task] });
  const subs = [makeSub({ status: "running", ts: 1000 })];
  // now=1200: age=200, threshold=120 → stale.
  const snap = runWithNow([epic], subs, 1200);
  expect(snap.perTask.get(task.task_id)).toEqual(
    running({ kind: "sub-agent-stale" }),
  );
});

test("fn-671: done+approved task with idle session → completed (clean collapse, mutex frees, sibling dispatches)", () => {
  // The clean-collapse path: every liveness clause is false. T1
  // genuinely completes, its mutex slot frees, and a ready sibling T2
  // on the same root may dispatch.
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
  });
  const epic = makeEpic({ tasks: [t1, t2] });
  const snap = run([epic]);
  expect(snap.perTask.get(t1.task_id)).toEqual({ tag: "completed" });
  // T2 wins the slot — completed T1 doesn't occupy.
  expect(snap.perTask.get(t2.task_id)).toEqual({ tag: "ready" });
});

test("fn-671 regression: T1 done+approved with session-still-working; T2 depends_on T1 → T2 NOT ready", () => {
  // The exact incident reproduced. Pre-fn-671: T1 collapsed to
  // `completed` while its session was still alive; T2's dep was
  // satisfied; T2 read `ready`; autopilot dispatched T2 into the same
  // root before T1's worker had wound down. Post-fn-671: T1 stays at
  // `running:job-running` (the per-task guard), T2's dep on T1 is NOT
  // satisfied (predicate 8 requires `tag === "completed"`), T2 stays
  // blocked on `dep-on-task`.
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "working" })],
  });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    depends_on: ["fn-1-foo.1"],
  });
  const epic = makeEpic({ tasks: [t1, t2] });
  const snap = run([epic]);
  expect(snap.perTask.get(t1.task_id)).toEqual(
    running({ kind: "job-running" }),
  );
  expect(snap.perTask.get(t2.task_id)).toEqual(
    blocked({ kind: "dep-on-task", upstream: "fn-1-foo.1" }),
  );
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
    running({ kind: "planner-running" }),
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
    running({ kind: "job-running" }),
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
    running({ kind: "sub-agent-running" }),
  );
});

// fn-638.4: predicate 6 splits its running-sub-agent verdict on age.
// A still-`running` sub-agent whose `ts` is older than the caller-
// injected `now` by strictly more than `SUBAGENT_STALENESS_SEC` (120s,
// mirroring the reducer's bounded Stop guard window) surfaces as
// `sub-agent-stale` instead of `sub-agent-running`. Both directions
// driven with an explicit `now` so the test is deterministic — no
// `Date.now()` in either the test or the pure pass.
test("predicate 6: running sub-agent within freshness window → sub-agent-running", () => {
  const task = makeTask({
    worker_phase: "done",
    approval: "pending",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [task] });
  // Started 60s before `now` — well within the 120s window. Verdict
  // stays `sub-agent-running` (fresh work in flight).
  const subs = [makeSub({ job_id: "worker-1", status: "running", ts: 1000 })];
  const snap = runWithNow([epic], subs, 1060);
  expect(snap.perTask.get(task.task_id)).toEqual(
    running({ kind: "sub-agent-running" }),
  );
});

test("predicate 6: running sub-agent past staleness window → sub-agent-stale", () => {
  const task = makeTask({
    worker_phase: "done",
    approval: "pending",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [task] });
  // Started 200s before `now` — strictly past the 120s window. Verdict
  // flips to `sub-agent-stale` (possibly-stuck orphan, visibility
  // affordance so a human can see WHAT is holding the gate).
  const subs = [makeSub({ job_id: "worker-1", status: "running", ts: 1000 })];
  const snap = runWithNow([epic], subs, 1200);
  expect(snap.perTask.get(task.task_id)).toEqual(
    running({ kind: "sub-agent-stale" }),
  );
});

test("predicate 6: a mix of stale + fresh running sub-agents stays at sub-agent-running", () => {
  // The point of `sub-agent-stale` is "the only live work is suspect".
  // If even one sub-agent on the row is fresh, the row genuinely is
  // making progress somewhere and shouldn't render as stale.
  const task = makeTask({
    worker_phase: "done",
    approval: "pending",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [task] });
  const subs = [
    makeSub({
      job_id: "worker-1",
      agent_id: "agent-old",
      status: "running",
      ts: 1000,
    }),
    makeSub({
      job_id: "worker-1",
      agent_id: "agent-fresh",
      status: "running",
      ts: 1150,
    }),
  ];
  // `now=1200`: agent-old is 200s back (stale), agent-fresh is 50s back
  // (fresh). The "all stale" predicate is false, so the verdict stays
  // at `sub-agent-running`.
  const snap = runWithNow([epic], subs, 1200);
  expect(snap.perTask.get(task.task_id)).toEqual(
    running({ kind: "sub-agent-running" }),
  );
});

test("predicate 6: exact boundary tick (now - ts === threshold) is not yet stale", () => {
  // Strict `>` boundary mirrors the reducer's bounded Stop guard
  // (`age > MAX_STOP_YIELD_GAP_SEC`). At the boundary tick, the row
  // stays at `sub-agent-running`; the next-tick comparison would flip.
  const task = makeTask({
    worker_phase: "done",
    approval: "pending",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [task] });
  const subs = [makeSub({ job_id: "worker-1", status: "running", ts: 1000 })];
  const snap = runWithNow([epic], subs, 1120);
  expect(snap.perTask.get(task.task_id)).toEqual(
    running({ kind: "sub-agent-running" }),
  );
});

test("predicate 6: default `now` (NEGATIVE_INFINITY) never flips to sub-agent-stale", () => {
  // Callers that omit `now` (autopilot simulator, hand-rolled fixtures)
  // get `Number.NEGATIVE_INFINITY` as the default — `-Infinity - ts >
  // threshold` is always false, so the staleness branch can never fire.
  // Pre-fn-638.4 callers preserve their old `sub-agent-running` verdict
  // bit-for-bit.
  const task = makeTask({
    worker_phase: "done",
    approval: "pending",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [task] });
  // ts far in the past relative to a wall-clock `now`, but `run` omits
  // the param — default kicks in and the verdict stays fresh.
  const subs = [makeSub({ job_id: "worker-1", status: "running", ts: 0 })];
  const snap = run([epic], new Map(), subs);
  expect(snap.perTask.get(task.task_id)).toEqual(
    running({ kind: "sub-agent-running" }),
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

// ---------------------------------------------------------------------------
// Predicate 6.5 (git-uncommitted / git-orphans) — fn-620 mechanical
// git-cleanliness gate. Insertion-point race rationale mirrors predicate 7:
// the gate must wait until every worker session and sub-agent is actually
// idle before sampling git state, otherwise mid-yield Stops produce stale
// dirty-tree readings.
// ---------------------------------------------------------------------------

test("predicate 6.5 git-uncommitted wins over 7 (own-approval-pending)", () => {
  // Worker idle, approval pending, and the live `git_status` map for the
  // epic's project_dir reports dirty_count > 0 — the mechanical gate
  // fires and blocks autopilot's approve dispatch before predicate 7 ever
  // gets a look. fn-626: predicate 6.5 now reads off the live project-wide
  // `git_status` row, not the embedded per-job count columns.
  const task = makeTask({
    worker_phase: "done",
    approval: "pending",
  });
  const epic = makeEpic({ tasks: [task] });
  const gitMap = new Map([
    ["/repo", { dirty_count: 3, unattributed_to_live_count: 0 }],
  ]);
  const snap = run([epic], new Map(), [], gitMap);
  expect(snap.perTask.get(task.task_id)).toEqual(
    blocked({ kind: "git-uncommitted" }),
  );
});

test("predicate 6.5 git-orphans fires when dirty count is zero but orphan count > 0", () => {
  // git-uncommitted takes priority over git-orphans; with dirty=0 and
  // orphans>0, the predicate reports git-orphans.
  const task = makeTask({
    worker_phase: "done",
    approval: "pending",
  });
  const epic = makeEpic({ tasks: [task] });
  const gitMap = new Map([
    ["/repo", { dirty_count: 0, unattributed_to_live_count: 2 }],
  ]);
  const snap = run([epic], new Map(), [], gitMap);
  expect(snap.perTask.get(task.task_id)).toEqual(
    blocked({ kind: "git-orphans" }),
  );
});

test("predicate 5 (own-progress-main) wins over 6.5 git-uncommitted", () => {
  // The worker is still running AND the live tree is dirty. Predicate 5
  // fires first — git state is captured opportunistically and might be
  // stale mid-yield; the gate must wait for session idle.
  const task = makeTask({
    worker_phase: "done",
    approval: "pending",
    jobs: [makeEmbeddedJob({ plan_verb: "work", state: "working" })],
  });
  const epic = makeEpic({ tasks: [task] });
  const gitMap = new Map([
    ["/repo", { dirty_count: 5, unattributed_to_live_count: 0 }],
  ]);
  const snap = run([epic], new Map(), [], gitMap);
  expect(snap.perTask.get(task.task_id)).toEqual(
    running({ kind: "job-running" }),
  );
});

test("predicate 6 (own-progress-sub) wins over 6.5 git-uncommitted", () => {
  // Worker stopped but a sub-agent is still running. Same race as 5/6.5:
  // git state could be stale while the sub-agent is mid-edit; the gate
  // must wait for sub-agent idle.
  const task = makeTask({
    worker_phase: "done",
    approval: "pending",
    jobs: [
      makeEmbeddedJob({
        job_id: "worker-1",
        plan_verb: "work",
        state: "stopped",
      }),
    ],
  });
  const epic = makeEpic({ tasks: [task] });
  const subs = [makeSub({ job_id: "worker-1", status: "running" })];
  const gitMap = new Map([
    ["/repo", { dirty_count: 3, unattributed_to_live_count: 0 }],
  ]);
  const snap = run([epic], new Map(), subs, gitMap);
  expect(snap.perTask.get(task.task_id)).toEqual(
    running({ kind: "sub-agent-running" }),
  );
});

test("predicate 6.5 skipped when worker_phase !== 'done' (task path)", () => {
  // Gate is gated on worker_phase==="done". A worker still mid-flight with
  // worker_phase="open" never reaches the approval window, so git state
  // doesn't matter yet — the gate is skipped and the row falls through.
  // Here predicate 7 also fails (worker_phase != "done") so the row is
  // ready (then per-epic/per-root mutexes apply, but with a single task,
  // ready stands).
  const task = makeTask({
    worker_phase: "open",
    approval: "pending",
  });
  const epic = makeEpic({ tasks: [task] });
  const gitMap = new Map([
    ["/repo", { dirty_count: 5, unattributed_to_live_count: 0 }],
  ]);
  const snap = run([epic], new Map(), [], gitMap);
  expect(snap.perTask.get(task.task_id)).toEqual({ tag: "ready" });
});

test("predicate 6.5 skipped when no git_status entry for the project root (task path)", () => {
  // fn-626: the predicate looks up `task.target_repo ?? epic.project_dir`
  // in the `gitStatusByProjectDir` map. A missing entry (no live snapshot
  // for the root yet, or the autopilot simulator's deliberately-empty map)
  // → skip and fall through to 7, which fires.
  const task = makeTask({
    worker_phase: "done",
    approval: "pending",
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]); // empty git map by default
  expect(snap.perTask.get(task.task_id)).toEqual(
    blocked({ kind: "job-pending" }),
  );
});

test("predicate 6.5 uses task.target_repo when set, falling back to epic.project_dir otherwise", () => {
  // Cross-repo task: target_repo points to a different worktree than the
  // epic. The predicate must look up the live `git_status` for the task's
  // target_repo, NOT the epic's project_dir. Same root-resolution shape
  // `effectiveRoot` uses for the per-root mutex.
  const task = makeTask({
    worker_phase: "done",
    approval: "pending",
    target_repo: "/other-repo",
  });
  const epic = makeEpic({ tasks: [task], project_dir: "/repo" });
  const gitMap = new Map([
    ["/repo", { dirty_count: 0, unattributed_to_live_count: 0 }],
    ["/other-repo", { dirty_count: 0, unattributed_to_live_count: 7 }],
  ]);
  const snap = run([epic], new Map(), [], gitMap);
  expect(snap.perTask.get(task.task_id)).toEqual(
    blocked({ kind: "git-orphans" }),
  );
});

test("fn-690 scoping: an incidental watched non-target repo does not affect dispatch", () => {
  // The fn-690 dynamic watch-membership gate (src/git-worker.ts) widens
  // the watched set to ANY dirty / ahead-of-upstream repo, including
  // ones that are not a `task.target_repo` or `epic.project_dir`. The
  // load-bearing invariant is that predicate 6.5 ONLY consults the
  // git_status row keyed by `task.target_repo ?? epic.project_dir`, so
  // an incidental watched repo (no plan ties) cannot affect dispatch.
  //
  // Scenario: the task targets `/repo` (clean). The gitMap ALSO carries
  // a `/other` row (the incidental watched repo) with dirty_count=5 +
  // unattributed=5. Predicate 6.5 must read /repo (clean → skip the
  // gate) and ignore /other entirely.
  const task = makeTask({
    worker_phase: "done",
    approval: "pending",
    target_repo: "/repo",
  });
  const epic = makeEpic({ tasks: [task], project_dir: "/repo" });
  const gitMap = new Map([
    ["/repo", { dirty_count: 0, unattributed_to_live_count: 0 }],
    // Incidental watched non-target repo — dirty + orphaned but it's NOT
    // this task's target. Predicate 6.5 must not key on it.
    ["/other", { dirty_count: 5, unattributed_to_live_count: 5 }],
  ]);
  const snap = run([epic], new Map(), [], gitMap);
  // Falls through to predicate 7 (approval pending → job-pending).
  // Specifically NOT blocked on git-uncommitted / git-orphans — the
  // incidental watched repo is invisible to the task's gate.
  const verdict = snap.perTask.get(task.task_id);
  expect(verdict).toEqual(blocked({ kind: "job-pending" }));
  expect(verdict).not.toEqual(blocked({ kind: "git-uncommitted" }));
  expect(verdict).not.toEqual(blocked({ kind: "git-orphans" }));
});

test("predicate 6.5 fires for evaluateCloseRow keyed by epic.project_dir", () => {
  // Close-row variant — the gate reads the live `git_status` row for
  // `epic.project_dir` (no per-row override on the synthetic close row).
  // Epic.status === "done" gates the predicate; the live row's
  // dirty_count > 0 fires the block.
  const task = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
  });
  const epic = makeEpic({
    tasks: [task],
    status: "done",
    approval: "pending",
  });
  const gitMap = new Map([
    ["/repo", { dirty_count: 4, unattributed_to_live_count: 0 }],
  ]);
  const snap = run([epic], new Map(), [], gitMap);
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    blocked({ kind: "git-uncommitted" }),
  );
});

test("predicate 6.5 skipped when epic.status !== 'done' (close-row path)", () => {
  // Gate is gated on epic.status==="done". An epic still mid-flight never
  // reaches the close-approval window, so git state doesn't matter yet —
  // the gate is skipped. Predicate 10 (dep-on-task-synthetic-close) then
  // blocks the close row because the only task is not completed.
  const task = makeTask({ task_id: "fn-1-foo.1", worker_phase: "open" });
  const epic = makeEpic({
    tasks: [task],
    status: "open",
    approval: "pending",
  });
  const gitMap = new Map([
    ["/repo", { dirty_count: 5, unattributed_to_live_count: 0 }],
  ]);
  const snap = run([epic], new Map(), [], gitMap);
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    blocked({ kind: "dep-on-task", upstream: "fn-1-foo.1" }),
  );
});

test("predicate 6.5 skipped when no git_status entry for epic.project_dir (close-row path)", () => {
  // Close row with epic.status==="done" but no live git_status entry —
  // the predicate falls through to 7 which fires.
  const task = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
  });
  const epic = makeEpic({
    tasks: [task],
    status: "done",
    approval: "pending",
  });
  const snap = run([epic]); // empty git map
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    blocked({ kind: "job-pending" }),
  );
});

// ---------------------------------------------------------------------------
// fn-700: epic-no-tasks close-row guard. An epic and its tasks fold as two
// separate single-event transactions (EpicSnapshot, then TaskSnapshot);
// between them the epic exists with ZERO tasks. Predicate 10's
// `for…of epic.tasks` loop is vacuously true over an empty list, so the
// close row would otherwise fall through to `ready` and the autopilot would
// dispatch a closer against an epic with no work (the fn-698 incident). The
// guard at rank 9.5 (before predicate 10) blocks it explicitly while every
// more-specific verdict above still wins.
// ---------------------------------------------------------------------------

test("fn-700 close-row: validated open zero-task epic → blocked:epic-no-tasks (not ready)", () => {
  // makeEpic defaults `tasks: []` and a non-null `last_validated_at`, so this
  // is the canonical partial-projection window: validated, open, no tasks.
  // Without the guard predicate 10's vacuous loop falls through to `ready`.
  const epic = makeEpic({});
  const snap = run([epic]);
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    blocked({ kind: "epic-no-tasks" }),
  );
  // Explicitly NOT ready — the hole this epic closes.
  expect(snap.perCloseRow.get(epic.epic_id)).not.toEqual({ tag: "ready" });
});

test("fn-700 precedence: UNvalidated zero-task epic still reports epic-not-validated", () => {
  // Predicate 2 (epic-not-validated) ranks above the rank-9.5 guard, so a
  // pre-EpicSnapshot stub is NOT masked. This is why the guard is placed
  // late, not first.
  const epic = makeEpic({ last_validated_at: null });
  const snap = run([epic]);
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    blocked({ kind: "epic-not-validated" }),
  );
});

test("fn-700 rollup: zero-task epic header surfaces blocked:epic-no-tasks (no rollup code change)", () => {
  // rollupEpicHeader inherits the close-row verdict for a zero-task epic
  // (its per-task loops are empty), so the epic header pill reads
  // `epic-no-tasks` for free.
  const epic = makeEpic({});
  const snap = run([epic]);
  expect(snap.perEpic.get(epic.epic_id)).toEqual(
    blocked({ kind: "epic-no-tasks" }),
  );
});

// ---------------------------------------------------------------------------
// fn-626 regression: terminal worker carries a stale per-job count, but the
// live `git_status` row says zero. The fix moved predicate 6.5 off the
// embedded per-job columns (which freeze on terminal worker transition)
// and onto the live project-wide `git_status` map. A re-running predicate
// MUST read the live count and verdict `ready`, not block on `git-orphans`.
// ---------------------------------------------------------------------------

test("fn-626 task arm: terminal worker with stale git_orphan_count > 0 but fresh git_status unattributed_to_live_count == 0 → does not block on git-orphans", () => {
  // The witnessed bug: epic 623 task 1's worker (state=ended) carried
  // git_orphan_count=2 frozen on terminal transition, but the live
  // git_status row for /Users/mike/code/keeper correctly says 0. Predicate
  // 6.5 must read the live row (the map), not the stale per-job column,
  // so the task verdict no longer reports `git-orphans`.
  //
  // Approval is pending here so the row reaches predicate 6.5 (predicate 1
  // would short-circuit a done+approved task to `completed`); the
  // load-bearing assertion is that the stale per-job count cannot resurrect
  // a `git-orphans` block when the live count is 0 — instead the row falls
  // through to predicate 7 (`job-pending`).
  const task = makeTask({
    worker_phase: "done",
    approval: "pending",
    jobs: [
      makeEmbeddedJob({
        job_id: "worker-1",
        plan_verb: "work",
        state: "ended", // terminal — per-job counts are now frozen
        git_dirty_count: 0,
        git_orphan_count: 2, // stale snapshot from when the worker was live
      }),
    ],
  });
  const epic = makeEpic({ tasks: [task] });
  // Live `git_status` row for /repo reports clean — the project-wide
  // state has moved on since the worker froze its per-job counts.
  const gitMap = new Map([
    ["/repo", { dirty_count: 0, unattributed_to_live_count: 0 }],
  ]);
  const snap = run([epic], new Map(), [], gitMap);
  const verdict = snap.perTask.get(task.task_id);
  expect(verdict).toEqual(blocked({ kind: "job-pending" }));
  expect(verdict).not.toEqual(blocked({ kind: "git-orphans" }));
});

test("fn-626 close-row arm: stale embedded close-verb git_orphan_count > 0 but fresh git_status unattributed_to_live_count == 0 → does not block on git-orphans", () => {
  // Mirror of the task-arm regression for the close row. Epic.status="done"
  // with a terminal close-verb embedded job carrying frozen
  // git_orphan_count=2, but the live `git_status` for the epic's
  // project_dir reports 0 — the close row must not block on `git-orphans`.
  const task = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
  });
  const epic = makeEpic({
    tasks: [task],
    status: "done",
    approval: "pending",
    jobs: [
      makeEmbeddedJob({
        job_id: "closer-1",
        plan_verb: "close",
        state: "ended", // terminal — counts frozen
        git_dirty_count: 0,
        git_orphan_count: 2, // stale frozen snapshot
      }),
    ],
  });
  const gitMap = new Map([
    ["/repo", { dirty_count: 0, unattributed_to_live_count: 0 }],
  ]);
  const snap = run([epic], new Map(), [], gitMap);
  const verdict = snap.perCloseRow.get(epic.epic_id);
  // Live count is 0 → predicate 6.5 doesn't fire. Falls through to 7
  // (epic.approval="pending", epic.status="done") → job-pending. The
  // load-bearing assertion is that `git-orphans` does NOT fire on the
  // stale per-job count.
  expect(verdict).toEqual(blocked({ kind: "job-pending" }));
  expect(verdict).not.toEqual(blocked({ kind: "git-orphans" }));
});

// ---------------------------------------------------------------------------
// fn-633.7 acceptance: predicate 6.5 sources from `unattributed_to_live_count`
// (the renamed legacy v28 "orphan" column under its honest new name), not
// from the new strict-mystery `git_orphan_count`. The strict-mystery column
// is informational only at v31 — it captures truly orphan files (no
// attribution from ANY session past or present) and surfaces in
// `scripts/git.ts` for human inspection, but does NOT block readiness.
// ---------------------------------------------------------------------------

test("fn-633.7 task arm: strict-mystery orphan_count > 0 with unattributed_to_live_count == 0 does NOT block predicate 6.5", () => {
  // The readiness map only carries `unattributed_to_live_count` (the
  // legacy v28 "orphan" semantic). The new schema-v31 strict-mystery
  // `git_orphan_count` on the wire is not projected into the map by
  // design — it's informational only. So a project with strict-mystery
  // orphans but zero unattributed-to-live files must NOT trigger
  // predicate 6.5; the row falls through to predicate 7.
  //
  // Concretely: the readiness map is the only signal predicate 6.5
  // reads, and it carries `unattributed_to_live_count: 0`. The test
  // asserts the predicate does not block — that's the v31 contract:
  // strict-mystery is informational, only unattributed-to-live blocks.
  const task = makeTask({
    worker_phase: "done",
    approval: "pending",
  });
  const epic = makeEpic({ tasks: [task] });
  const gitMap = new Map([
    ["/repo", { dirty_count: 0, unattributed_to_live_count: 0 }],
  ]);
  const snap = run([epic], new Map(), [], gitMap);
  const verdict = snap.perTask.get(task.task_id);
  // Predicate 6.5 does not fire; falls through to 7 (`job-pending`)
  // because `worker_phase==="done"` and `approval==="pending"`.
  expect(verdict).toEqual(blocked({ kind: "job-pending" }));
  expect(verdict).not.toEqual(blocked({ kind: "git-orphans" }));
});

test("fn-633.7 close-row arm: strict-mystery orphan_count > 0 with unattributed_to_live_count == 0 does NOT block predicate 6.5", () => {
  // Close-row mirror of the task-arm test. Same v31 contract: only
  // `unattributed_to_live_count > 0` triggers `git-orphans`; the
  // strict-mystery column on the wire is informational only.
  const task = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
  });
  const epic = makeEpic({
    tasks: [task],
    status: "done",
    approval: "pending",
  });
  const gitMap = new Map([
    ["/repo", { dirty_count: 0, unattributed_to_live_count: 0 }],
  ]);
  const snap = run([epic], new Map(), [], gitMap);
  const verdict = snap.perCloseRow.get(epic.epic_id);
  expect(verdict).toEqual(blocked({ kind: "job-pending" }));
  expect(verdict).not.toEqual(blocked({ kind: "git-orphans" }));
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
    running({ kind: "job-running" }),
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
    running({ kind: "job-running" }),
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
    running({ kind: "sub-agent-running" }),
  );
});

test("predicate 8 (dep-on-task) wins over 9 (dep-on-epic)", () => {
  // Task depends on a non-completed sibling; the EPIC also has a non-completed
  // upstream epic (projected as `blocked-incomplete`). Task-dep should win.
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
    resolved_epic_deps: [
      makeResolvedDep({
        dep_token: "fn-0-bar",
        resolved_epic_id: "fn-0-bar",
        epic_number: 0,
        project_basename: "other",
        cross_project: true,
        state: "blocked-incomplete",
      }),
    ],
  });
  const snap = run([upstreamEpic, epic]);
  expect(snap.perTask.get(dependent.task_id)).toEqual(
    blocked({ kind: "dep-on-task", upstream: "fn-1-foo.1" }),
  );
});

test("predicate 9 (dep-on-epic) wins over 12 (single-task-per-root)", () => {
  // The dependent epic's task would otherwise compete for per-root with
  // the upstream epic's task; dep-on-epic should win. Same-project upstream
  // → projection entry has `cross_project: false`, predicate 9 reconstructs
  // the BlockReason's `cross_project: null` from the boolean + basename pair.
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
    resolved_epic_deps: [
      makeResolvedDep({
        dep_token: "fn-0-bar",
        resolved_epic_id: "fn-0-bar",
        epic_number: 0,
        project_basename: "repo",
        cross_project: false,
        state: "blocked-incomplete",
      }),
    ],
  });
  const snap = run([upstreamEpic, epic]);
  // Upstream task is ready; dependent task should be dep-on-epic blocked.
  expect(snap.perTask.get("fn-0-bar.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get(dependent.task_id)).toEqual(
    blocked({
      kind: "dep-on-epic",
      upstream: "fn-0-bar",
      cross_project: null,
    }),
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
    running({ kind: "job-running" }),
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

// fn-703: a done-but-unapproved task whose target repo is dirty renders a
// predicate-6.5 git verdict. That verdict now occupies the mutex slot for the
// whole approval-pending window, so a depless ready sibling is held instead of
// jumping the queue (the observed "task 3 running before task 2" bug).
test("per-epic: git-uncommitted (done+pending+dirty) occupies → depless ready sibling blocks", () => {
  const blocked6_5 = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "pending",
    target_repo: "/r",
  });
  const ready = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    target_repo: "/r",
  });
  const epic = makeEpic({ tasks: [blocked6_5, ready], project_dir: "/r" });
  const gitMap = new Map([
    ["/r", { dirty_count: 2, unattributed_to_live_count: 0 }],
  ]);
  const snap = run([epic], new Map(), [], gitMap);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual(
    blocked({ kind: "git-uncommitted" }),
  );
  expect(snap.perTask.get("fn-1-foo.2")).toEqual(
    blocked({ kind: "single-task-per-epic" }),
  );
});

test("per-epic: git-orphans variant (done+pending, orphans>0) occupies identically", () => {
  const blocked6_5 = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "pending",
    target_repo: "/r",
  });
  const ready = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    target_repo: "/r",
  });
  const epic = makeEpic({ tasks: [blocked6_5, ready], project_dir: "/r" });
  const gitMap = new Map([
    ["/r", { dirty_count: 0, unattributed_to_live_count: 1 }],
  ]);
  const snap = run([epic], new Map(), [], gitMap);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual(
    blocked({ kind: "git-orphans" }),
  );
  expect(snap.perTask.get("fn-1-foo.2")).toEqual(
    blocked({ kind: "single-task-per-epic" }),
  );
});

// Guard (fn-703): occupancy here relies on predicate 6.5's done-gate, which
// makes the git verdict strictly imply the done+approval-pending window. Pin
// that gate so a future ladder reorder fails loudly instead of silently
// over-claiming. A NOT-done task in a dirty repo must NOT render a git verdict.
test("guard: a not-done task in a dirty repo does NOT get a git verdict (pins 6.5 done-gate)", () => {
  const notDone = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "open",
    approval: "pending",
    target_repo: "/r",
  });
  const epic = makeEpic({ tasks: [notDone], project_dir: "/r" });
  const gitMap = new Map([
    ["/r", { dirty_count: 9, unattributed_to_live_count: 9 }],
  ]);
  const snap = run([epic], new Map(), [], gitMap);
  // worker_phase !== "done" → predicate 6.5 is skipped → falls through to
  // ready (no blocking predicate above it applies).
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
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

// fn-703: a done+pending+dirty task (git verdict) in epic 1 claims its root,
// so a ready task in epic 2 on the SAME root is demoted to single-task-per-root
// — the cross-epic mirror of the per-epic occupancy fix.
test("per-root: git-uncommitted (done+pending+dirty) in one epic occupies the root → cross-epic ready task blocks", () => {
  const e1t1 = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "pending",
    target_repo: "/r",
  });
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
  const gitMap = new Map([
    ["/r", { dirty_count: 1, unattributed_to_live_count: 0 }],
  ]);
  const snap = run([e1, e2], new Map(), [], gitMap);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual(
    blocked({ kind: "git-uncommitted" }),
  );
  expect(snap.perTask.get("fn-2-bar.1")).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

// fn-703 (task .2): a QUIESCENT done-but-unapproved epic on a dirty repo —
// all tasks completed, NO live epic-level job/sub-agent — renders a close-row
// git verdict (predicate 6.5). That close row claims the epic's OWN root, so a
// sibling epic's ready task on the SAME root is demoted single-task-per-root.
// This is the close-row mirror of the task-level fn-703 occupancy fix; it FAILS
// with only task .1's change (the close-row claim gate was epicLevelRunning-only
// and never fired on a quiescent git close verdict) and passes with the gate
// edit adding the git-verdict disjunct.
test("per-root: quiescent done+pending epic with close-row git-uncommitted claims its root → cross-epic ready task blocks", () => {
  // epic 1: status=done, approval=pending, all tasks completed
  // (done+approved → per-task predicate 1 collapses to `completed`, NOT an
  // occupant), NO jobs/subs. Close row hits predicate 6.5 → git-uncommitted.
  const e1t1 = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
    target_repo: "/r",
  });
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/r",
    status: "done",
    approval: "pending",
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
  const gitMap = new Map([
    ["/r", { dirty_count: 3, unattributed_to_live_count: 0 }],
  ]);
  const snap = run([e1, e2], new Map(), [], gitMap);
  // sanity: the quiescent epic's completed task is NOT a root occupant, and
  // the close row carries the git verdict.
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "completed" });
  expect(snap.perCloseRow.get("fn-1-foo")).toEqual(
    blocked({ kind: "git-uncommitted" }),
  );
  // the close-row git verdict claims /r → epic 2's ready task demoted.
  expect(snap.perTask.get("fn-2-bar.1")).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

// fn-703 (task .2): the git-verdict disjunct stays STRICTLY scoped to the
// epic's OWN project_dir — a quiescent git close row in epic 1 (root /r1)
// must NOT phantom-lock an UNRELATED root /r2 where a sibling epic's ready
// task lives. Pins the fn-655/fn-663 narrowing against regression.
test("per-root: quiescent close-row git verdict does NOT claim a different root (no phantom lock)", () => {
  const e1t1 = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
    target_repo: "/r1",
  });
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/r1",
    status: "done",
    approval: "pending",
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
  const gitMap = new Map([
    ["/r1", { dirty_count: 3, unattributed_to_live_count: 0 }],
  ]);
  const snap = run([e1, e2], new Map(), [], gitMap);
  expect(snap.perCloseRow.get("fn-1-foo")).toEqual(
    blocked({ kind: "git-uncommitted" }),
  );
  // epic 2 is on /r2 — untouched by the /r1 close-row claim.
  expect(snap.perTask.get("fn-2-bar.1")).toEqual({ tag: "ready" });
});

// fn-703 (task .2) regression: the NON-git close-row path is unchanged. A
// quiescent done+pending epic on a CLEAN repo with no live epic-level work
// renders its close row `job-pending` (predicate 7) — NOT a git verdict and
// NOT epicLevelRunning — so it does NOT claim the root, and a sibling epic's
// ready task on the same root stays ready. Confirms the git-verdict disjunct
// did not widen the claim beyond the two predicate-6.5 kinds.
test("per-root: quiescent non-git close row (clean repo, job-pending) does NOT claim the root", () => {
  const e1t1 = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
    target_repo: "/r",
  });
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/r",
    status: "done",
    approval: "pending",
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
  // clean repo (no git map entry / zero counts) → predicate 6.5 skipped →
  // close row falls through to job-pending (predicate 7), NOT a root occupant.
  const snap = run([e1, e2]);
  expect(snap.perCloseRow.get("fn-1-foo")).toEqual(
    blocked({ kind: "job-pending" }),
  );
  expect(snap.perTask.get("fn-2-bar.1")).toEqual({ tag: "ready" });
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
    running({ kind: "job-running" }),
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

test("epic header rollup: zero-task epic — header = close-row verdict (blocked:epic-no-tasks)", () => {
  // fn-700: a zero-task epic is the partial-projection window between an
  // EpicSnapshot and its first TaskSnapshot fold. Predicate 10's
  // `for…of epic.tasks` loop is vacuously true over an empty list, so the
  // close row would historically fall through to `ready` (the fn-698
  // dispatch-a-closer-against-an-empty-epic hole). The rank-9.5 guard now
  // blocks it `epic-no-tasks`, and the rollup inherits that verdict for the
  // header (its per-task loops are empty).
  const epic = makeEpic({ tasks: [] });
  const snap = run([epic]);
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    blocked({ kind: "epic-no-tasks" }),
  );
  expect(snap.perEpic.get(epic.epic_id)).toEqual(
    blocked({ kind: "epic-no-tasks" }),
  );
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

test("dep-on-epic null resolved_epic_deps: predicate 9 short-circuits, no-block (defensive)", () => {
  // fn-637.4: `resolved_epic_deps === null` is the "not-yet-computed" sentinel
  // (a fresh epics row that the reducer hasn't stamped yet). Predicate 9 skips
  // the dep evaluation entirely so a row never false-blocks during the
  // migration window before the reducer's first fold lands. Production reads
  // see `[]` or a populated array; this guard is the safe-default fallback.
  const consumer = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
    depends_on_epics: ["fn-2-bar"],
    resolved_epic_deps: null,
  });
  const snap = run([consumer]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
});

test("dep-on-epic full-id projection dangling → dep-on-epic-dangling", () => {
  // The reducer projected the dep as `state === "dangling"` — no upstream
  // resolved (full-id miss). Predicate 9 emits `dep-on-epic-dangling`
  // carrying the raw `dep_token`.
  const t = makeTask({ task_id: "fn-1-foo.1" });
  const epic = makeEpic({
    tasks: [t],
    depends_on_epics: ["fn-99-ghost"],
    resolved_epic_deps: [makeResolvedDep({ dep_token: "fn-99-ghost" })],
  });
  const snap = run([epic]);
  expect(snap.perTask.get(t.task_id)).toEqual(
    blocked({ kind: "dep-on-epic-dangling", upstream: "fn-99-ghost" }),
  );
});

// ---------------------------------------------------------------------------
// fn-637.4 predicate-9 projection matrix — the four tri-state outcomes
// (`satisfied`, `blocked-incomplete` intra/cross, `dangling`) read off
// `epic.resolved_epic_deps`. The resolver itself is tested in
// `test/epic-deps.test.ts`; the reducer's forward stamp + reverse fan-out
// in `test/reducer.test.ts:1690`. Here we exercise predicate 9's pure
// projection-consuming branches.
// ---------------------------------------------------------------------------

test("predicate 9: projection state=satisfied → consumer ready", () => {
  // The reducer projected the upstream as `satisfied` (done+approved). The
  // consumer's task path skips the entry and falls through to `ready`. The
  // upstream itself need not be in the live `epics` list — it could be
  // off-page completed; the projection already settled the verdict.
  const consumer = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/Users/mike/code/keeper",
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
    depends_on_epics: ["fn-2-bar"],
    resolved_epic_deps: [
      makeResolvedDep({
        dep_token: "fn-2-bar",
        resolved_epic_id: "fn-2-bar",
        epic_number: 2,
        project_basename: "keeper",
        cross_project: false,
        state: "satisfied",
      }),
    ],
  });
  const snap = run([consumer]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
});

test("predicate 9: projection state=blocked-incomplete + cross_project=true → dep-on-epic with basename prefix", () => {
  // Cross-project upstream is open+pending. The projection carries
  // `cross_project: true` + `project_basename: "arthack"`; predicate 9
  // reconstructs the readiness-side `cross_project: string | null`
  // BlockReason payload from the boolean + basename pair.
  const consumer = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/Users/mike/code/keeper",
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
    depends_on_epics: ["fn-2-bar"],
    resolved_epic_deps: [
      makeResolvedDep({
        dep_token: "fn-2-bar",
        resolved_epic_id: "fn-2-bar",
        epic_number: 2,
        project_basename: "arthack",
        cross_project: true,
        state: "blocked-incomplete",
      }),
    ],
  });
  const snap = run([consumer]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual(
    blocked({
      kind: "dep-on-epic",
      upstream: "fn-2-bar",
      cross_project: "arthack",
    }),
  );
});

test("predicate 9: projection state=satisfied via bare-id resolution → ready", () => {
  // The dep_token is the bare form `fn-2`; the reducer resolved it to
  // `fn-2-bar` via the cwd-then-global lookup and projected `satisfied`.
  // Predicate 9 doesn't care about the resolution mechanism — it just
  // consumes the tri-state.
  const consumer = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
    depends_on_epics: ["fn-2"],
    resolved_epic_deps: [
      makeResolvedDep({
        dep_token: "fn-2",
        resolved_epic_id: "fn-2-bar",
        epic_number: 2,
        project_basename: "repo",
        cross_project: false,
        state: "satisfied",
      }),
    ],
  });
  const snap = run([consumer]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
});

test("predicate 9: projection state=dangling → dep-on-epic-dangling carries raw dep_token", () => {
  // Bare-id miss / full-id miss / ambiguity all surface as
  // `state === "dangling"` on the projection. Predicate 9 emits the
  // `dep-on-epic-dangling` BlockReason carrying the raw `dep_token`
  // verbatim (so the renderer's `[?#N]` extraction works on the same
  // string the planctl file carries).
  const t = makeTask({ task_id: "fn-1-foo.1" });
  const epic = makeEpic({
    tasks: [t],
    depends_on_epics: ["fn-99"],
    resolved_epic_deps: [makeResolvedDep({ dep_token: "fn-99" })],
  });
  const snap = run([epic]);
  expect(snap.perTask.get(t.task_id)).toEqual(
    blocked({ kind: "dep-on-epic-dangling", upstream: "fn-99" }),
  );
});

test("predicate 9: empty resolved_epic_deps array → ready (no deps)", () => {
  // `[]` is the computed-no-deps state. Predicate 9 walks zero entries
  // and falls through to `ready`.
  const consumer = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
    depends_on_epics: [],
    resolved_epic_deps: [],
  });
  const snap = run([consumer]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
});

test("predicate 9: first non-satisfied entry wins (source-order traversal)", () => {
  // Two deps: the first `satisfied`, the second `blocked-incomplete`.
  // Predicate 9 walks in projection source order and reports the FIRST
  // non-satisfied entry — second one wins.
  const consumer = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
    depends_on_epics: ["fn-2-bar", "fn-3-baz"],
    resolved_epic_deps: [
      makeResolvedDep({
        dep_token: "fn-2-bar",
        resolved_epic_id: "fn-2-bar",
        epic_number: 2,
        project_basename: "repo",
        cross_project: false,
        state: "satisfied",
      }),
      makeResolvedDep({
        dep_token: "fn-3-baz",
        resolved_epic_id: "fn-3-baz",
        epic_number: 3,
        project_basename: "repo",
        cross_project: false,
        state: "blocked-incomplete",
      }),
    ],
  });
  const snap = run([consumer]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual(
    blocked({
      kind: "dep-on-epic",
      upstream: "fn-3-baz",
      cross_project: null,
    }),
  );
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

test("applySingleTaskPerEpicMutex: live-work blocked row claims the epic slot", () => {
  // Pass-1 semantics: a verdict from the `isLiveWorkOccupant` whitelist —
  // one of `job-running`, `sub-agent-running`, `planner-running`,
  // `job-pending` — claims the epic slot regardless of iteration order, so
  // the later ready row gets demoted. Dependency / admin / repo-state /
  // mutex-synthesized blocks do NOT claim in pass-1 (see the negative-
  // control test below for `dep-on-task`).
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

test("applySingleTaskPerEpicMutex: dep-on-task row does NOT claim the epic slot (negative control)", () => {
  // Negative control for the pass-1 whitelist. A `dep-on-task` block is
  // NOT one of the four `isLiveWorkOccupant` kinds (`job-running`,
  // `sub-agent-running`, `planner-running`, `job-pending`) — it represents
  // waiting, not concurrent worker activity. So a later ready sibling must
  // win the slot rather than be demoted to single-task-per-epic. Locks in
  // the narrowed whitelist against future regression that would silently
  // re-broaden to "any non-completed verdict".
  const t1 = makeTask({ task_id: "fn-1-foo.1" });
  const t2 = makeTask({ task_id: "fn-1-foo.2", task_number: 2 });
  const epic = makeEpic({ tasks: [t1, t2] });
  const perTask = new Map<string, Verdict>([
    ["fn-1-foo.1", blocked({ kind: "dep-on-task", upstream: "fn-0-x.1" })],
    ["fn-1-foo.2", { tag: "ready" }],
  ]);
  applySingleTaskPerEpicMutex([epic], perTask);
  expect(perTask.get("fn-1-foo.1")).toEqual(
    blocked({ kind: "dep-on-task", upstream: "fn-0-x.1" }),
  );
  expect(perTask.get("fn-1-foo.2")).toEqual({ tag: "ready" });
});

test("applySingleTaskPerEpicMutex: ready row before job-running row in same epic still gets demoted to single-task-per-epic", () => {
  // Iteration-order regression: a `ready` task in position N is demoted
  // when a `job-running` task occupies position N+1 in the SAME epic.
  // The one-pass algorithm let the ready row win the slot first; the
  // two-pass fix claims the slot for the actively-running row in pass 1.
  const t1 = makeTask({ task_id: "fn-1-foo.1" });
  const t2 = makeTask({ task_id: "fn-1-foo.2", task_number: 2 });
  const epic = makeEpic({ tasks: [t1, t2] });
  const perTask = new Map<string, Verdict>([
    ["fn-1-foo.1", { tag: "ready" }],
    ["fn-1-foo.2", running({ kind: "job-running" })],
  ]);
  applySingleTaskPerEpicMutex([epic], perTask);
  expect(perTask.get("fn-1-foo.1")).toEqual(
    blocked({ kind: "single-task-per-epic" }),
  );
  expect(perTask.get("fn-1-foo.2")).toEqual(running({ kind: "job-running" }));
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

test("applySingleTaskPerRootMutex: live-work blocked row claims the root", () => {
  // Cross-epic pass-1 semantics: a verdict from the `isRootOccupant`
  // whitelist — one of `job-running`, `sub-agent-running`, `sub-agent-stale`,
  // `job-pending` — in epic A occupies root /r so a later ready row in
  // epic B gets demoted. Planners are root-exempt (fn-663) — see the
  // dedicated planner-exemption tests below. Dependency / admin /
  // repo-state / mutex-synthesized blocks also do NOT claim in pass-1
  // (see the negative-control test below for `dep-on-task`).
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
    ["fn-1-foo.1", running({ kind: "job-running" })],
    ["fn-2-bar.1", { tag: "ready" }],
  ]);
  applySingleTaskPerRootMutex([e1, e2], perTask, new Map());
  expect(perTask.get("fn-1-foo.1")).toEqual(running({ kind: "job-running" }));
  expect(perTask.get("fn-2-bar.1")).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

test("applySingleTaskPerRootMutex: dep-on-task row does NOT claim the root (negative control)", () => {
  // Cross-epic negative control for the pass-1 whitelist. A `dep-on-task`
  // block in epic A is NOT one of the four `isLiveWorkOccupant` kinds, so
  // it must NOT claim root /r. The ready row in epic B on the same root
  // must remain ready rather than be demoted to single-task-per-root.
  // Locks in the narrowed whitelist against a future regression that would
  // silently re-broaden to "any non-completed verdict".
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
    ["fn-1-foo.1", blocked({ kind: "dep-on-task", upstream: "fn-0-x.1" })],
    ["fn-2-bar.1", { tag: "ready" }],
  ]);
  applySingleTaskPerRootMutex([e1, e2], perTask, new Map());
  expect(perTask.get("fn-1-foo.1")).toEqual(
    blocked({ kind: "dep-on-task", upstream: "fn-0-x.1" }),
  );
  expect(perTask.get("fn-2-bar.1")).toEqual({ tag: "ready" });
});

test("applySingleTaskPerRootMutex: ready row in earlier-iterating epic blocked by job-running row in later-iterating epic (same root)", () => {
  // Iteration-order regression (the bug witnessed in production):
  // fn-624.1 was `ready` in epic A, fn-626.1 was `job-running` in epic B,
  // both on root /r. With the one-pass algorithm the ready row won the
  // root slot first and autopilot dispatched it concurrently with the
  // already-working sibling. The two-pass fix lets pass-1 claim the
  // root for the job-running row so the ready row is demoted.
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
    ["fn-2-bar.1", running({ kind: "job-running" })],
  ]);
  applySingleTaskPerRootMutex([e1, e2], perTask, new Map());
  expect(perTask.get("fn-1-foo.1")).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
  expect(perTask.get("fn-2-bar.1")).toEqual(running({ kind: "job-running" }));
});

test("applySingleTaskPerRootMutex: ready close row in earlier epic blocked by job-running task in later epic (same root)", () => {
  // Mirror coverage for the close-row branch: a ready close in epic A
  // must yield the root to a job-running task in epic B regardless of
  // iteration order.
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/r",
    tasks: [],
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
    ["fn-2-bar.1", running({ kind: "job-running" })],
  ]);
  const perCloseRow = new Map<string, Verdict>([
    ["fn-1-foo", { tag: "ready" }],
  ]);
  applySingleTaskPerRootMutex([e1, e2], perTask, perCloseRow);
  expect(perCloseRow.get("fn-1-foo")).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
  expect(perTask.get("fn-2-bar.1")).toEqual(running({ kind: "job-running" }));
});

// fn-655: scoped close-row attribution — a close row whose `running:*`
// verdict was INHERITED from a task-level worker in a different
// `target_repo` must NOT claim `epic.project_dir`. The contributing task
// already locks its own correct root via its `target_repo` entry in the
// same pass-1 loop. These tests pin the gate down both job-running and
// sub-agent paths (the fn-651 regression had both shapes), plus three
// negative controls so a future cleanup can't silently drop one of the
// three epic-level OR sources.
test("applySingleTaskPerRootMutex (fn-655): close row running from a cross-target_repo task job does NOT claim project_dir", () => {
  // Regression for the fn-651 shape: epic A's close row pools task A.1's
  // worker job (running on /other-repo) and inherits a `running:job-running`
  // verdict. With the legacy unconditional claim, epic A's project_dir
  // (/keeper) would be locked and a ready sibling task in epic B on /keeper
  // would be demoted to single-task-per-root. The fn-655 gate sees no
  // epic-level running source (epic A's `jobs` is empty and `job_links`
  // carries no `working` link) and skips the close-row claim — sibling
  // epic B's task stays ready. Task A.1 still locks /other-repo correctly
  // via its own pass-1 entry.
  const e1t1 = makeTask({
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    target_repo: "/other-repo",
  });
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/keeper",
    tasks: [e1t1],
  });
  const e2t1 = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
    target_repo: "/keeper",
  });
  const e2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/keeper",
    tasks: [e2t1],
  });
  const perTask = new Map<string, Verdict>([
    ["fn-1-foo.1", running({ kind: "job-running" })],
    ["fn-2-bar.1", { tag: "ready" }],
  ]);
  const perCloseRow = new Map<string, Verdict>([
    ["fn-1-foo", running({ kind: "job-running" })],
  ]);
  applySingleTaskPerRootMutex([e1, e2], perTask, perCloseRow);
  // Sibling task on /keeper stays ready — close row did NOT phantom-lock
  // the unrelated project_dir.
  expect(perTask.get("fn-2-bar.1")).toEqual({ tag: "ready" });
  // Cross-repo task still locks its own root (negative side of the gate).
  expect(perTask.get("fn-1-foo.1")).toEqual(running({ kind: "job-running" }));
});

test("applySingleTaskPerRootMutex (fn-655): close row running from a cross-target_repo task sub-agent does NOT claim project_dir", () => {
  // Sub-agent variant of the fn-651 shape: task A.1 has a stopped worker
  // job but a still-running sub-agent under that job (cross-repo at
  // /other-repo). evaluateCloseRow's predicate 6 pools task-level
  // sub-agents and surfaces `running:sub-agent-running` on the close row.
  // The fn-655 gate's third disjunct
  // (`anyEmbeddedJobHasRunningSubagent(epic.jobs, ...)`) checks ONLY
  // epic-level jobs, so it correctly returns false and the close row does
  // not claim /keeper.
  const e1t1 = makeTask({
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    target_repo: "/other-repo",
    jobs: [makeEmbeddedJob({ job_id: "worker-A1", state: "stopped" })],
  });
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/keeper",
    tasks: [e1t1],
  });
  const e2t1 = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
    target_repo: "/keeper",
  });
  const e2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/keeper",
    tasks: [e2t1],
  });
  const perTask = new Map<string, Verdict>([
    ["fn-1-foo.1", running({ kind: "sub-agent-running" })],
    ["fn-2-bar.1", { tag: "ready" }],
  ]);
  const perCloseRow = new Map<string, Verdict>([
    ["fn-1-foo", running({ kind: "sub-agent-running" })],
  ]);
  // Sub-agent index carries the running sub-agent under task A.1's worker.
  // The epic-level jobs array on epic A is empty, so the gate's third
  // disjunct returns false even though the index has an entry for a
  // task-level worker job_id.
  const subRunningByJobId = new Map<string, SubagentInvocation[]>([
    ["worker-A1", [makeSub({ job_id: "worker-A1", status: "running" })]],
  ]);
  applySingleTaskPerRootMutex(
    [e1, e2],
    perTask,
    perCloseRow,
    subRunningByJobId,
  );
  expect(perTask.get("fn-2-bar.1")).toEqual({ tag: "ready" });
  expect(perTask.get("fn-1-foo.1")).toEqual(
    running({ kind: "sub-agent-running" }),
  );
});

test("applySingleTaskPerRootMutex (fn-655) negative control: close row running from an epic-level close-verb job STILL claims project_dir", () => {
  // Predicate 5 epic-level path. `epic.jobs` carries a working close-verb
  // embedded job — the gate's `anyEmbeddedJobWorking(epic.jobs)` disjunct
  // fires, the close row legitimately occupies /keeper, and a ready
  // sibling task in epic B on /keeper must be demoted.
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/keeper",
    tasks: [],
    jobs: [
      makeEmbeddedJob({
        job_id: "closer-A",
        plan_verb: "close",
        state: "working",
      }),
    ],
  });
  const e2t1 = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
    target_repo: "/keeper",
  });
  const e2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/keeper",
    tasks: [e2t1],
  });
  const perTask = new Map<string, Verdict>([["fn-2-bar.1", { tag: "ready" }]]);
  const perCloseRow = new Map<string, Verdict>([
    ["fn-1-foo", running({ kind: "job-running" })],
  ]);
  applySingleTaskPerRootMutex([e1, e2], perTask, perCloseRow);
  expect(perTask.get("fn-2-bar.1")).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

test("applySingleTaskPerRootMutex (fn-663): planner-running close row does NOT claim project_dir", () => {
  // Planner exemption (fn-663). `epic.job_links` carries a working
  // creator/refiner link — `JobLinkEntry.kind` is `creator | refiner` so
  // planners are epic-scoped by construction. The close row's verdict is
  // `running:planner-running`; `isRootOccupant` returns false for that
  // kind, so the outer pass-1 guard skips the close row entirely. A
  // sibling epic's ready task on /keeper stays ready and is dispatchable
  // concurrently with the planner. The planner still blocks its OWN epic
  // (predicate 3 + per-EPIC mutex remain unchanged).
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/keeper",
    tasks: [],
    job_links: [
      makeLink({ kind: "creator", job_id: "planner-A", state: "working" }),
    ],
  });
  const e2t1 = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
    target_repo: "/keeper",
  });
  const e2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/keeper",
    tasks: [e2t1],
  });
  const perTask = new Map<string, Verdict>([["fn-2-bar.1", { tag: "ready" }]]);
  const perCloseRow = new Map<string, Verdict>([
    ["fn-1-foo", running({ kind: "planner-running" })],
  ]);
  applySingleTaskPerRootMutex([e1, e2], perTask, perCloseRow);
  expect(perTask.get("fn-2-bar.1")).toEqual({ tag: "ready" });
});

test("applySingleTaskPerRootMutex (fn-663): planner-running task verdict does NOT claim the root", () => {
  // Per-task analog of the close-row exemption. A `running:planner-running`
  // verdict on a TASK in epic A does NOT occupy root /keeper, so a ready
  // sibling task in epic B on the same root stays ready. (In practice
  // task-level verdicts read `planner-running` via predicate 3 when the
  // task's parent epic has a working `job_links` planner.) Regression
  // guard: if a future refactor swaps `isRootOccupant` back to
  // `isLiveWorkOccupant` at the per-task pass-1 check, this test fires.
  const e1t1 = makeTask({
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    target_repo: "/keeper",
  });
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/keeper",
    tasks: [e1t1],
  });
  const e2t1 = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
    target_repo: "/keeper",
  });
  const e2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/keeper",
    tasks: [e2t1],
  });
  const perTask = new Map<string, Verdict>([
    ["fn-1-foo.1", running({ kind: "planner-running" })],
    ["fn-2-bar.1", { tag: "ready" }],
  ]);
  applySingleTaskPerRootMutex([e1, e2], perTask, new Map());
  expect(perTask.get("fn-1-foo.1")).toEqual(
    running({ kind: "planner-running" }),
  );
  expect(perTask.get("fn-2-bar.1")).toEqual({ tag: "ready" });
});

test("applySingleTaskPerRootMutex (fn-655) negative control: same-root task worker keeps root locked via the task's OWN claim", () => {
  // Over-correction guard: when the contributing task IS on the same root
  // (`target_repo === project_dir` or null) the root MUST still be locked
  // — by the TASK's pass-1 entry, not the close row. The close row's
  // skipped claim doesn't open a slot because the task's claim already
  // closed it. A ready sibling task in epic B on the same root is still
  // demoted to single-task-per-root.
  const e1t1 = makeTask({
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    target_repo: null, // falls through to epic A's project_dir == /keeper
  });
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/keeper",
    tasks: [e1t1],
  });
  const e2t1 = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
    target_repo: "/keeper",
  });
  const e2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/keeper",
    tasks: [e2t1],
  });
  const perTask = new Map<string, Verdict>([
    ["fn-1-foo.1", running({ kind: "job-running" })],
    ["fn-2-bar.1", { tag: "ready" }],
  ]);
  const perCloseRow = new Map<string, Verdict>([
    ["fn-1-foo", running({ kind: "job-running" })],
  ]);
  applySingleTaskPerRootMutex([e1, e2], perTask, perCloseRow);
  // Sibling task is still demoted — the task's own pass-1 claim locked
  // /keeper, so skipping the close-row claim didn't open a slot.
  expect(perTask.get("fn-2-bar.1")).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
  expect(perTask.get("fn-1-foo.1")).toEqual(running({ kind: "job-running" }));
});

test("applySingleTaskPerRootMutex (fn-655) boundary: close row running from BOTH an epic-level source AND a cross-repo task worker STILL claims project_dir", () => {
  // Mixed-source boundary: the close row's `running:*` verdict has BOTH a
  // legitimate epic-level source (a working close-verb job on epic A) AND
  // an inherited task-level source (task A.1's worker on /other-repo).
  // The OR gate fires (epic-level disjunct true) and the close row claims
  // /keeper — sibling task on /keeper is demoted. Locks in that the gate
  // is "ANY epic-level source", not "EXCLUSIVELY task-derived".
  const e1t1 = makeTask({
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    target_repo: "/other-repo",
  });
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/keeper",
    tasks: [e1t1],
    jobs: [
      makeEmbeddedJob({
        job_id: "closer-A",
        plan_verb: "close",
        state: "working",
      }),
    ],
  });
  const e2t1 = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
    target_repo: "/keeper",
  });
  const e2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/keeper",
    tasks: [e2t1],
  });
  const perTask = new Map<string, Verdict>([
    ["fn-1-foo.1", running({ kind: "job-running" })],
    ["fn-2-bar.1", { tag: "ready" }],
  ]);
  const perCloseRow = new Map<string, Verdict>([
    ["fn-1-foo", running({ kind: "job-running" })],
  ]);
  applySingleTaskPerRootMutex([e1, e2], perTask, perCloseRow);
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
  expect(formatPill(running({ kind: "planner-running" }))).toBe(
    "[running:planner-running]",
  );
  expect(formatPill(running({ kind: "job-running" }))).toBe(
    "[running:job-running]",
  );
  expect(formatPill(running({ kind: "sub-agent-running" }))).toBe(
    "[running:sub-agent-running]",
  );
  expect(formatPill(running({ kind: "sub-agent-stale" }))).toBe(
    "[running:sub-agent-stale]",
  );
  expect(formatPill(blocked({ kind: "git-uncommitted" }))).toBe(
    "[blocked:git-uncommitted]",
  );
  expect(formatPill(blocked({ kind: "git-orphans" }))).toBe(
    "[blocked:git-orphans]",
  );
  expect(
    formatPill(blocked({ kind: "dep-on-task", upstream: "fn-1-foo.2" })),
  ).toBe("[blocked:dep-on-task fn-1-foo.2]");
  expect(
    formatPill(
      blocked({
        kind: "dep-on-epic",
        upstream: "fn-0-bar",
        cross_project: null,
      }),
    ),
  ).toBe("[blocked:dep-on-epic fn-0-bar]");
  expect(
    formatPill(
      blocked({
        kind: "dep-on-epic",
        upstream: "fn-0-bar",
        cross_project: "arthack",
      }),
    ),
  ).toBe("[blocked:dep-on-epic arthack::fn-0-bar]");
  expect(
    formatPill(
      blocked({ kind: "dep-on-epic-dangling", upstream: "fn-99-ghost" }),
    ),
  ).toBe("[blocked:dep-on-epic-dangling fn-99-ghost]");
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

// fn-671: the four tests below previously documented the close-row fan-in's
// completed-task scan as the load-bearing anti-collapse path. After fn-671
// the per-task predicate 1 catches the same race FIRST (the task verdict
// reads `running:*`, not `completed`), so the close-row fan-in is normally
// unreachable — the close row's predicate 10 (dep-on-task) blocks on the
// now-non-completed task instead. Code at `src/readiness.ts:790-799` and
// `closeRowHasRunningSubagent` is retained as a re-fold-determinism
// backstop (see their JSDoc) but the assertion shape moves from
// "close row stays running" to "task stays running, close row blocks on
// dep-on-task". These tests therefore now verify the post-fn-671 contract
// at both layers.

test("fn-671: task-level worker still working — task stays at job-running, close row blocks on dep-on-task", () => {
  // Pre-fn-671: task collapsed to `completed`, close-row fan-in fired to
  // surface `job-running` on the close row. Post-fn-671: per-task
  // predicate 1's liveness guard keeps the task at `running:job-running`,
  // so the close row's predicate 10 finds a non-completed task and
  // blocks on `dep-on-task`. Net effect on the autopilot: identical
  // (both rows occupy the per-root mutex via `isLiveWorkOccupant`
  // / dep-on-task is a blocked verdict; the per-task running row is the
  // primary lock).
  const t = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "working" })],
  });
  const epic = makeEpic({ tasks: [t] });
  const snap = run([epic]);
  expect(snap.perTask.get(t.task_id)).toEqual(running({ kind: "job-running" }));
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    blocked({ kind: "dep-on-task", upstream: "fn-1-foo.1" }),
  );
});

test("fn-671: task-level worker has running sub-agent — task stays at sub-agent-running, close row blocks on dep-on-task", () => {
  // Sub-agent variant of the above. Per-task predicate 1's second
  // liveness clause holds the task at `running:sub-agent-running`; close
  // row falls through to predicate 10's `dep-on-task` block.
  const t = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [t] });
  const sub = makeSub({ job_id: "worker-1", status: "running" });
  const snap = run([epic], new Map(), [sub]);
  expect(snap.perTask.get(t.task_id)).toEqual(
    running({ kind: "sub-agent-running" }),
  );
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    blocked({ kind: "dep-on-task", upstream: "fn-1-foo.1" }),
  );
});

// fn-638.4 / fn-671: staleness split surfaces at the per-task verdict.
// The close row is blocked on the (non-completed) task via predicate 10.
test("fn-671: task-level running sub-agent past staleness window — task is sub-agent-stale, close row blocks on dep-on-task", () => {
  const t = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [t] });
  const sub = makeSub({ job_id: "worker-1", status: "running", ts: 1000 });
  // `now=1200`: age=200, threshold=120 → stale.
  const snap = runWithNow([epic], [sub], 1200);
  expect(snap.perTask.get(t.task_id)).toEqual(
    running({ kind: "sub-agent-stale" }),
  );
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    blocked({ kind: "dep-on-task", upstream: "fn-1-foo.1" }),
  );
});

test("fn-671: a fresh sub-agent on one task keeps that task at sub-agent-running, close row blocks on dep-on-task with FIRST non-completed id", () => {
  // Two tasks, both done+approved with stopped main jobs but running
  // sub-agents (one stale, one fresh). Per-task: t1 has only a stale
  // sub-agent → `sub-agent-stale`; t2 has a fresh sub-agent →
  // `sub-agent-running`. Close row picks up the FIRST non-completed task
  // (t1) for the dep-on-task upstream id (predicate 10 traversal order).
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    worker_phase: "done",
    approval: "approved",
    jobs: [makeEmbeddedJob({ job_id: "worker-2", state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [t1, t2] });
  const subs = [
    makeSub({ job_id: "worker-1", status: "running", ts: 1000 }), // stale
    makeSub({ job_id: "worker-2", status: "running", ts: 1150 }), // fresh
  ];
  const snap = runWithNow([epic], subs, 1200);
  expect(snap.perTask.get(t1.task_id)).toEqual(
    running({ kind: "sub-agent-stale" }),
  );
  expect(snap.perTask.get(t2.task_id)).toEqual(
    running({ kind: "sub-agent-running" }),
  );
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    blocked({ kind: "dep-on-task", upstream: "fn-1-foo.1" }),
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

// ---------------------------------------------------------------------------
// Close-row predicate 5/6 fan-in is scoped to COMPLETED tasks: an in-flight
// (not-yet-completed) task's running worker must NOT mislabel the close row
// as `running:*`. The close row is blocked on that task via predicate 10
// (`dep-on-task`), not running its own work.
// ---------------------------------------------------------------------------

test("close row: in-flight (non-completed) task working → dep-on-task, NOT job-running", () => {
  // The reported bug: a task genuinely in flight (worker_phase still open,
  // embedded job `working`) made the close row read `running:job-running`.
  // The task is not `completed`, so predicate 5's fan-in must skip it and the
  // close row falls through to predicate 10's accurate `dep-on-task` block.
  const t = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "open",
    approval: "pending",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "working" })],
  });
  const epic = makeEpic({ tasks: [t] });
  const snap = run([epic]);
  // The task row itself still reads its own running state.
  expect(snap.perTask.get(t.task_id)).toEqual(running({ kind: "job-running" }));
  // The close row is blocked on the incomplete task, not running.
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    blocked({ kind: "dep-on-task", upstream: "fn-1-foo.1" }),
  );
});

test("close row: in-flight task with running sub-agent → dep-on-task, NOT sub-agent-running", () => {
  // Sub-agent variant of the same bug: a not-yet-completed task carrying a
  // running sub-agent must not fan its running-ness onto the close row.
  const t = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "open",
    approval: "pending",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "working" })],
  });
  const epic = makeEpic({ tasks: [t] });
  const sub = makeSub({ job_id: "worker-1", status: "running" });
  const snap = run([epic], new Map(), [sub]);
  // The close row blocks on the incomplete task (predicate 5's job scan
  // already short-circuits to dep-on-task before predicate 6 is reached).
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    blocked({ kind: "dep-on-task", upstream: "fn-1-foo.1" }),
  );
});

test("fn-671: completed-racing worker holds per-task running, close row blocks on dep-on-task upstream first non-completed", () => {
  // Mirrors the reported epic's shape: task-1 done+approved, task-2 in
  // flight. Two scenarios:
  //
  // (a) task-1 worker stopped (clean collapse): t1 = `completed`, close row
  //     blocks on t2 via predicate 10 → upstream `fn-1-foo.2`.
  // (b) task-1 worker still working (racing): per-fn-671 the per-task
  //     guard holds t1 at `running:job-running`. Close row's predicate 10
  //     finds the FIRST non-completed task (t1, traversal order) → upstream
  //     `fn-1-foo.1`. Pre-fn-671 the close-row fan-in would have surfaced
  //     `running:job-running` on the close row instead; the autopilot
  //     consequence is unchanged (t1's per-task running verdict now claims
  //     the root via pass-1).
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    worker_phase: "open",
    approval: "pending",
    jobs: [makeEmbeddedJob({ job_id: "worker-2", state: "working" })],
  });
  const epic = makeEpic({ tasks: [t1, t2] });
  const snap = run([epic]);
  expect(snap.perTask.get(t1.task_id)).toEqual({ tag: "completed" });
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    blocked({ kind: "dep-on-task", upstream: "fn-1-foo.2" }),
  );

  // (b) Racing case — t1's worker still alive.
  const t1Racing = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    approval: "approved",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "working" })],
  });
  const epicRacing = makeEpic({ tasks: [t1Racing, t2] });
  const snapRacing = run([epicRacing]);
  expect(snapRacing.perTask.get(t1Racing.task_id)).toEqual(
    running({ kind: "job-running" }),
  );
  expect(snapRacing.perCloseRow.get(epicRacing.epic_id)).toEqual(
    blocked({ kind: "dep-on-task", upstream: "fn-1-foo.1" }),
  );
});

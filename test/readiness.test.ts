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
  classifyWorktreeRepos,
  prepareWorktreeGeometry,
} from "../src/autopilot-worker";
import {
  applyPerRootRoundRobinAllocator,
  applySingleTaskPerEpicMutex,
  applySingleTaskPerRootMutex,
  type BlockReason,
  computeReadiness,
  formatPill,
  isEpicStarted,
  isRootOccupant,
  orderEpicsForScheduling,
  PENDING_DISPATCH_STALE_CEILING_SEC,
  type PendingDispatch,
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
import { deriveWorktreePlan, worktreePathFor } from "../src/worktree-plan";

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
    model: null,
    // Schema v19: `status` renamed to `worker_phase` (derived binary —
    // open|done) and `runtime_status` added (plan-native enum, default
    // "todo"). Both ride inside the embedded element on the parent epic's
    // `tasks` array.
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

/**
 * fn-978 — the gate-side lane-key map for a set of epics, the way `reconcile`
 * builds it: classify repos (IDENTITY resolution — each raw root is its own
 * toplevel, byte-identical to the pre-fn-978 raw geometry), then run the SINGLE
 * pure `prepareWorktreeGeometry` derivation the gate + dispatch both consume.
 */
function laneKeysFor(epics: Epic[]): Map<string, string> {
  return prepareWorktreeGeometry(
    epics,
    classifyWorktreeRepos(epics, (r) => r),
  ).laneKeyById;
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

// `makeLink` (below) builds the `JobLinkEntry` projection shape: the
// `state` field carries the linked session's last-known lifecycle directly
// off the projection (denormalized at the reducer's write boundary), so no
// fixture ever threads a separate `jobs` Map.

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
    // fn-924: default a NON-null `active_since` so the default fixture models a
    // job that HAS been active (the default `state: "working"` always carries
    // it set, and a stopped-after-working job does too). Only the freshly-bound
    // `bound-pending` cases override it to `null` to model "bound but never yet
    // active". Keeps every pre-fn-924 `state: "stopped"` fixture inert (it does
    // NOT trigger the `bound-pending` occupancy predicate).
    active_since: 1,
    // fn-719 (task 2): the task-1 live-worker-monitor occupancy fact.
    // Default `false` (no backgrounded worker suite) so existing fixtures
    // keep their pre-fn-719 verdicts; the monitor-occupancy tests below
    // override it to `true`.
    has_live_worker_monitor: false,
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
// isRootOccupant — direct unit calls (fn-725 exported the predicate)
// ---------------------------------------------------------------------------
//
// Previously these contracts were only asserted indirectly via the per-root
// mutex integration tests' prose. Now that `isRootOccupant` is exported (so
// the fn-725 reconcile budget can count root-occupants with the SAME
// predicate the mutex uses), pin its per-verdict contract directly.

test("isRootOccupant: real running workers occupy the root", () => {
  expect(isRootOccupant(running({ kind: "job-running" }))).toBe(true);
  expect(isRootOccupant(running({ kind: "sub-agent-running" }))).toBe(true);
  expect(isRootOccupant(running({ kind: "sub-agent-stale" }))).toBe(true);
  expect(isRootOccupant(running({ kind: "monitor-running" }))).toBe(true);
  expect(isRootOccupant(running({ kind: "monitor-stale" }))).toBe(true);
});

test("fn-756: the approval-pending occupants (job-pending / git verdicts) NO LONGER occupy", () => {
  // fn-756 dropped the approval window: `isLiveWorkOccupant` no longer treats
  // `job-pending` or the fn-703 `git-uncommitted`/`git-orphans` verdicts as
  // occupants (none of those verdicts is even produced any more). Only `running`
  // and `dispatch-pending` claim a slot.
  expect(isRootOccupant(blocked({ kind: "job-pending" }))).toBe(false);
  expect(isRootOccupant(blocked({ kind: "git-uncommitted" }))).toBe(false);
  expect(isRootOccupant(blocked({ kind: "git-orphans" }))).toBe(false);
});

test("isRootOccupant: a launch-window dispatch-pending row occupies (fn-721)", () => {
  expect(isRootOccupant(blocked({ kind: "dispatch-pending" }))).toBe(true);
});

test("isRootOccupant: a bound-but-not-yet-active worker occupies (fn-924)", () => {
  // The post-bind continuation of dispatch-pending — a worker whose SessionStart
  // folded a `state='stopped'`, `plan_verb`-bearing jobs row (and DELETEd the
  // pending_dispatches row in the SAME fold) but hasn't yet flipped to working.
  // It MUST hold the root across the bind → first-activity handoff so a same-root
  // sibling can't slip through the gap (the 2026-06-23 launch-window leak).
  expect(isRootOccupant(blocked({ kind: "bound-pending" }))).toBe(true);
});

test("isRootOccupant: non-occupying verdicts do NOT claim the root", () => {
  // Ready / completed / dependency-style blocks represent no live worker.
  expect(isRootOccupant({ tag: "ready" })).toBe(false);
  expect(isRootOccupant({ tag: "completed" })).toBe(false);
  expect(isRootOccupant(blocked({ kind: "dep-on-task", upstream: "x" }))).toBe(
    false,
  );
  expect(isRootOccupant(blocked({ kind: "job-rejected" }))).toBe(false);
  expect(isRootOccupant(blocked({ kind: "single-task-per-root" }))).toBe(false);
});

// ---------------------------------------------------------------------------
// Predicate-ordering matrix
// ---------------------------------------------------------------------------

test("predicate 5 (own-progress-main) wins over 1 (terminal-completed): done+approved with working job → job-running (fn-671)", () => {
  // fn-671: the per-task predicate 1 now guards on worker liveness — a
  // `done+approved` task whose embedded session is still `working`
  // (plan stamped `worker_done_at` and the human approved before the
  // Claude Stop/SessionEnd landed) must NOT collapse to `completed`,
  // because that would free both the per-epic and per-root mutex while
  // the worker is still alive and let the autopilot dispatch a sibling
  // into the same root. The verdict falls through to predicate 5
  // (`job-running`), which IS a mutex occupant via `isLiveWorkOccupant`.
  // Pre-fn-671 this test asserted the OLD inversion ("predicate 1 wins
  // over 5") — the autopilot incident that motivated the rename.
  const task = makeTask({
    worker_phase: "done",
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
  // The exact incident: T1 is administratively complete (plan done +
  // human approved) but the Claude session hasn't Stopped yet. T2 lives
  // on the same project root and would otherwise be `ready`. The
  // per-task guard holds T1 at `running:job-running`, which is a root
  // occupant via `isRootOccupant`, so the per-root mutex demotes T2 to
  // `single-task-per-root` — preventing the autopilot from dispatching
  // T2 while T1's worker is still alive.
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
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

// ---------------------------------------------------------------------------
// fn-1200: proven-dead owning-worker latch for the terminal-completed gate.
//
// A done task's `completed` verdict must not oscillate with sibling-session
// liveness churn. In the incident a completed task flapped completed↔running
// while its OWN worker job sat `stopped` (never terminalized to killed/ended,
// so its orphaned open-turn subagent rows were never swept), and that lingering
// GHOST subagent — re-read on every projection tick a sibling worker on the
// shared lane produced — held the verdict off `completed`. Once the owning
// worker is PROVEN dead (recorded pid re-proved gone — `provenDeadJobIds`, the
// SAME lifecycle verdict the slot reaper reclaims on), its ghost subagent /
// monitor liveness no longer un-completes the task. A mere `stopped` (NOT
// proven-dead) owning job still holds (conservative, never earlier-firing), and
// a genuinely re-activated owning job re-surfaces (no permanent task-id latch).
// ---------------------------------------------------------------------------

// Threads the fn-1200 `provenDeadJobIds` set (computeReadiness's 11th param)
// with everything between defaulted, so a test asserts the terminal-gate latch
// in isolation.
function runProvenDead(
  epics: Epic[],
  subs: SubagentInvocation[],
  provenDeadJobIds: ReadonlySet<string>,
  now: number = Number.NEGATIVE_INFINITY,
) {
  return computeReadiness(
    epics,
    new Map(),
    subs,
    new Map(),
    now,
    [],
    undefined,
    new Set<string>(),
    1,
    new Map(),
    provenDeadJobIds,
  );
}

test("fn-1200: done task, proven-dead owning worker + ghost running sub-agent → completed (ghost no longer holds)", () => {
  // The incident shape: worker-1 did the work, is `stopped`, and left an
  // orphaned `running` sub-agent whose SubagentStop never landed (a stopped
  // row's open-turn subs are not swept). Pre-fn-1200 this read
  // `running:sub-agent-running` forever; once worker-1 is proven dead the ghost
  // is ignored and the task collapses to `completed`.
  const task = makeTask({
    worker_phase: "done",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [task] });
  const ghostSub = [makeSub({ job_id: "worker-1", status: "running" })];
  const snap = runProvenDead([epic], ghostSub, new Set(["worker-1"]));
  expect(snap.perTask.get(task.task_id)).toEqual({ tag: "completed" });
});

test("fn-1200: the completed verdict is STABLE across repeated derivations with churning sibling liveness", () => {
  // The oscillation guard. Same done + proven-dead worker, but each derivation
  // sees a DIFFERENT sibling-liveness slice (a sibling worker on the shared lane
  // spawning/finishing sub-agents) AND the owning worker's own ghost sub toggles
  // running↔unknown. The owning task's verdict must stay `completed` every time —
  // sibling churn never re-attributes to the proven-dead owner.
  const task = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [task] });
  const provenDead = new Set(["worker-1"]);
  // Each element is one projection tick's sub-agent slice: churning sibling
  // ("sibling-2") activity, plus the owner's own ghost row flipping status.
  const churn: SubagentInvocation[][] = [
    [makeSub({ job_id: "worker-1", status: "running" })],
    [
      makeSub({ job_id: "worker-1", status: "running" }),
      makeSub({ job_id: "sibling-2", status: "running" }),
    ],
    [makeSub({ job_id: "worker-1", status: "unknown" })],
    [
      makeSub({ job_id: "sibling-2", status: "running", turn_seq: 3 }),
      makeSub({ job_id: "worker-1", status: "running", turn_seq: 4 }),
    ],
    [],
  ];
  for (const subs of churn) {
    const snap = runProvenDead([epic], subs, provenDead);
    expect(snap.perTask.get(task.task_id)).toEqual({ tag: "completed" });
  }
});

test("fn-1200 control: a merely-stopped (NOT proven-dead) owning worker still holds at sub-agent-running", () => {
  // The done-AND-idle bar is not weakened: absent a proven-dead verdict, a
  // stopped worker's running sub-agent keeps holding exactly as pre-fn-1200 (the
  // fn-671 hold), so `completed` never fires EARLIER than today. Asserted with an
  // EMPTY set AND with a set naming only an UNRELATED sibling job — the latch is
  // scoped to the OWNING job, never a global toggle.
  const task = makeTask({
    worker_phase: "done",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [task] });
  const sub = [makeSub({ job_id: "worker-1", status: "running" })];
  expect(
    runProvenDead([epic], sub, new Set()).perTask.get(task.task_id),
  ).toEqual(running({ kind: "sub-agent-running" }));
  expect(
    runProvenDead([epic], sub, new Set(["sibling-9"])).perTask.get(
      task.task_id,
    ),
  ).toEqual(running({ kind: "sub-agent-running" }));
});

test("fn-1200: a genuinely re-activated owning job surfaces running even while listed proven-dead (no permanent latch)", () => {
  // Terminality is a one-way latch on the OWNING JOB, never on the task id: a
  // still-`working` owning job holds the verdict off `completed` regardless of a
  // stale `provenDeadJobIds` membership, because the working clause reads the
  // FULL job set (a proven-dead set is stopped-only, so this is defence-in-depth).
  const task = makeTask({
    worker_phase: "done",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "working" })],
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = runProvenDead([epic], [], new Set(["worker-1"]));
  expect(snap.perTask.get(task.task_id)).toEqual(
    running({ kind: "job-running" }),
  );
});

test("fn-1200: proven-dead owning worker's live worker-monitor no longer holds a done task", () => {
  // The monitor-wake-churn arm of the same fix: a backgrounded worker monitor
  // fact on a proven-dead owning job is a ghost lease and must not hold the done
  // task at `running:monitor-running`. Control (empty set) keeps the fn-719 hold.
  const task = makeTask({
    worker_phase: "done",
    jobs: [
      makeEmbeddedJob({
        job_id: "worker-1",
        state: "stopped",
        has_live_worker_monitor: true,
      }),
    ],
  });
  const epic = makeEpic({ tasks: [task] });
  expect(
    runProvenDead([epic], [], new Set()).perTask.get(task.task_id),
  ).toEqual(running({ kind: "monitor-running" }));
  expect(
    runProvenDead([epic], [], new Set(["worker-1"])).perTask.get(task.task_id),
  ).toEqual({ tag: "completed" });
});

test("fn-1200: only the proven-dead job's liveness is dropped — a live sibling worker on the SAME task still holds", () => {
  // Selective exclusion: a re-dispatched task carries two work jobs. The first
  // (dead-1) is proven dead with a ghost sub; the second (live-2) is stopped but
  // NOT proven dead and carries a real running sub. The live job's sub-agent
  // still holds the task, so it stays `running` — the fix drops ONLY the ghost.
  const task = makeTask({
    worker_phase: "done",
    jobs: [
      makeEmbeddedJob({ job_id: "dead-1", state: "stopped" }),
      makeEmbeddedJob({ job_id: "live-2", state: "stopped" }),
    ],
  });
  const epic = makeEpic({ tasks: [task] });
  const subs = [
    makeSub({ job_id: "dead-1", status: "running" }),
    makeSub({ job_id: "live-2", status: "running" }),
  ];
  const snap = runProvenDead([epic], subs, new Set(["dead-1"]));
  expect(snap.perTask.get(task.task_id)).toEqual(
    running({ kind: "sub-agent-running" }),
  );
});

test("fn-1200: a proven-dead upstream done task reads terminal, so a dependent unblocks (predicate 8)", () => {
  // The fix propagates through the dep resolver: predicate 8 asks each upstream's
  // OWN terminal-completed state, which now honors the proven-dead latch. So a
  // downstream depending on a done+proven-dead task (ghost sub and all) reads
  // `ready`, not `blocked:dep-on-task`.
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    depends_on: ["fn-1-foo.1"],
  });
  const epic = makeEpic({ tasks: [t1, t2] });
  const ghostSub = [makeSub({ job_id: "worker-1", status: "running" })];
  const snap = runProvenDead([epic], ghostSub, new Set(["worker-1"]));
  expect(snap.perTask.get(t1.task_id)).toEqual({ tag: "completed" });
  expect(snap.perTask.get(t2.task_id)).toEqual({ tag: "ready" });
});

test("fn-889 regression: forward depends_on (upstream evaluated later) resolves order-independently", () => {
  // The fn-889 incident: a refined epic where tasks 2/3/4 `depends_on` the
  // HIGHER-numbered tasks 6/7/8 (all done). Pre-fix, predicate 8 read the
  // upstream's in-progress `perTask` verdict, which is `undefined` while
  // walking tasks in ascending `task_number` order (6/7/8 not yet evaluated
  // when 2 is) → tasks 2/3/4 falsely `blocked:dep-on-task ...6`, the epic had
  // zero `ready` rows, and autopilot skipped it. Post-fix, predicate 8 reads
  // each upstream's OWN terminal-completed state from `taskById`, so the deps
  // resolve regardless of traversal order: task 2 (first unblocked) reads
  // `ready`; tasks 3/4 are demoted by the per-epic mutex to
  // `single-task-per-epic` (NOT `dep-on-task`), the proof the dep resolved.
  const upstreams = [6, 7, 8].map((n) =>
    makeTask({
      task_id: `fn-1-foo.${n}`,
      task_number: n,
      worker_phase: "done",
    }),
  );
  const downstream = [2, 3, 4].map((n) =>
    makeTask({
      task_id: `fn-1-foo.${n}`,
      task_number: n,
      depends_on: ["fn-1-foo.6", "fn-1-foo.7", "fn-1-foo.8"],
    }),
  );
  // Iteration order is ascending task_number (the reducer/db fold sort), so the
  // downstream tasks are visited BEFORE their upstreams — the exact hazard.
  const epic = makeEpic({ tasks: [...downstream, ...upstreams] });
  const snap = run([epic]);

  expect(snap.perTask.get("fn-1-foo.2")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-1-foo.3")).toEqual(
    blocked({ kind: "single-task-per-epic" }),
  );
  expect(snap.perTask.get("fn-1-foo.4")).toEqual(
    blocked({ kind: "single-task-per-epic" }),
  );
  for (const n of [6, 7, 8]) {
    expect(snap.perTask.get(`fn-1-foo.${n}`)).toEqual({ tag: "completed" });
  }
});

// ---------------------------------------------------------------------------
// fn-1048: a `status:done` epic is ABSORBING in the readiness pipeline. Any
// task under it resolves `completed` regardless of the per-task `worker_phase`
// flag — an epic closed WITHOUT stamping that flag (legacy import, `keeper plan
// epic close --force`) must not re-feed the reconcile snapshot and re-dispatch
// `work::`. The terminal gate still honors the three task-scope liveness
// clauses (fn-671 invariant), and the epic is resolved per-task via `epicsById`
// so predicate 8's cross-epic `dep-on-task` judges each upstream by its OWN
// epic.
// ---------------------------------------------------------------------------

test("fn-1048: task under a status:done epic reads completed even with worker_phase=open", () => {
  // The core guard: the per-task flag was never stamped (open), but the parent
  // epic is `status:done`. Pre-fn-1048 this read `ready` and the reconciler
  // re-dispatched `work::` in a loop; post-fn-1048 the done epic is absorbing.
  const task = makeTask({ worker_phase: "open" });
  const epic = makeEpic({ status: "done", tasks: [task] });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual({ tag: "completed" });
});

test("fn-1048: done epic still honors liveness — task with a working embedded job stays running:job-running (fn-671 preserved)", () => {
  // Absorbing at the ADMIN signal only: a still-live worker on a done-epic task
  // must keep holding the per-root mutex, so the terminal gate falls through to
  // predicate 5 (`job-running`) exactly as the fn-671 clauses require.
  const task = makeTask({
    worker_phase: "open",
    jobs: [makeEmbeddedJob({ state: "working" })],
  });
  const epic = makeEpic({ status: "done", tasks: [task] });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual(
    running({ kind: "job-running" }),
  );
});

test("fn-1048: cross-epic dep-on-task judges the upstream by ITS OWN done epic (epicsById, not the ambient epic)", () => {
  // A kept `status:open` epic whose task depends on a task living in a
  // `status:done` epic. The upstream (`worker_phase:open`, never stamped) is
  // terminal by ITS OWN epic, so the dependent is unblocked. Resolving the
  // epic from the ambient param instead of `epicsById` would misjudge the
  // cross-epic upstream and falsely block the dependent.
  const upstream = makeTask({
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    worker_phase: "open",
  });
  const doneEpic = makeEpic({
    epic_id: "fn-1-foo",
    status: "done",
    tasks: [upstream],
  });
  const dependent = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
    depends_on: ["fn-1-foo.1"],
  });
  const openEpic = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    status: "open",
    tasks: [dependent],
  });
  const snap = run([openEpic, doneEpic]);
  // Upstream reads completed by its own done epic; the dependent is unblocked.
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "completed" });
  expect(snap.perTask.get("fn-2-bar.1")).toEqual({ tag: "ready" });
});

test("fn-1048: task with null epic_id in a done epic falls back to worker_phase-only (no throw)", () => {
  // A shell task element with `epic_id: null` (no plan-snapshot fold landed)
  // can't resolve its epic, so the gate degrades to `worker_phase`-only —
  // worker_phase=open stays NOT terminal, and the lookup never throws.
  const task = makeTask({ epic_id: null, worker_phase: "open" });
  const epic = makeEpic({ status: "done", tasks: [task] });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual({ tag: "ready" });
});

// ---------------------------------------------------------------------------
// fn-719: live-worker-monitor occupancy. A work session that backgrounded a
// test suite and yielded its turn flips its embedded job to `stopped` (so
// predicates 5/6 clear) while the suite is STILL RUNNING. Task 1 carries the
// provenance-filtered `has_live_worker_monitor` fact; predicate 1 ANDs in the
// live-monitor check (so it can't collapse to `completed`) and predicate 6.6
// surfaces `running:monitor-running` (a mutex occupant that NEVER dispatches).
// MONITOR_STALENESS_SEC=600 (soft → `monitor-stale`), MONITOR_RELEASE_SEC=1800
// (hard → release). The direct fn-715.2 repro is the first test.
// ---------------------------------------------------------------------------

test("fn-719: done+approved task with live worker monitor → running:monitor-running, NOT completed (fn-715.2 repro+fix)", () => {
  // The exact fn-715.2 incident: the work session Stopped (embedded job
  // `stopped`, no running sub-agent), plan `done` + human approved, but
  // the backgrounded `bash-bg` suite is still running. Pre-fn-719 predicate
  // 1 collapsed this to `completed`, freeing the mutex; approve dispatched
  // ~7s later while the suite ran. Post-fn-719 predicate 1's third liveness
  // clause holds it at `running:monitor-running` via predicate 6.6.
  const task = makeTask({
    worker_phase: "done",
    jobs: [
      makeEmbeddedJob({ state: "stopped", has_live_worker_monitor: true }),
    ],
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual(
    running({ kind: "monitor-running" }),
  );
});

test("fn-719: ambient-only monitor (has_live_worker_monitor=false) → completed (dispatchable, defense-in-depth)", () => {
  // Provenance is filtered at task 1: an `ambient` session-watcher (chatctl
  // bus) NEVER sets `has_live_worker_monitor`, so the embedded fact reads
  // `false`. This task is a clean done+approved with no live work — it MUST
  // collapse to `completed` and free the mutex. Pins that an ambient-only
  // job never occupies (the load-bearing distinction from the test above —
  // identical shape, only the flag flips).
  const task = makeTask({
    worker_phase: "done",
    jobs: [
      makeEmbeddedJob({ state: "stopped", has_live_worker_monitor: false }),
    ],
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual({ tag: "completed" });
});

test("fn-719: live worker monitor occupies BOTH per-epic and per-root mutex (blocks sibling on same root)", () => {
  // T1 done+approved with a live `bash-bg` monitor holds `monitor-running`,
  // which is a `running` verdict → occupant via `isLiveWorkOccupant`
  // (per-epic) AND `isRootOccupant` (per-root). A ready sibling T2 on the same
  // root is demoted, exactly like the fn-671 job-running case.
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    jobs: [
      makeEmbeddedJob({
        job_id: "worker-1",
        state: "stopped",
        has_live_worker_monitor: true,
      }),
    ],
  });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
  });
  const epic = makeEpic({ tasks: [t1, t2] });
  const snap = run([epic]);
  expect(snap.perTask.get(t1.task_id)).toEqual(
    running({ kind: "monitor-running" }),
  );
  // Per-epic mutex demotes the ready sibling (same epic).
  expect(snap.perTask.get(t2.task_id)).toEqual(
    blocked({ kind: "single-task-per-epic" }),
  );
});

test("fn-719: live worker monitor in epic A occupies the root, demotes a same-root ready task in epic B (per-root mutex)", () => {
  // Cross-epic same-root collision — the per-root mutex keys on
  // `isRootOccupant`. `monitor-running` is a `running` verdict, so it claims
  // the root and a ready task in a different epic on the same project_dir is
  // demoted to `single-task-per-root`.
  const a1 = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    jobs: [
      makeEmbeddedJob({
        job_id: "worker-a",
        state: "stopped",
        has_live_worker_monitor: true,
      }),
    ],
  });
  const epicA = makeEpic({ epic_id: "fn-1-foo", tasks: [a1] });
  const b1 = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
  });
  const epicB = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    // Same project_dir as epic A → same root.
    project_dir: "/repo",
    tasks: [b1],
  });
  const snap = run([epicA, epicB]);
  expect(snap.perTask.get(a1.task_id)).toEqual(
    running({ kind: "monitor-running" }),
  );
  expect(snap.perTask.get(b1.task_id)).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

// ---------------------------------------------------------------------------
// fn-924: bound-pending — the launch-window occupancy gap. A worker's per-root
// hold is dropped the instant it BINDS (its SessionStart DELETEs the
// pending_dispatches row that fed `dispatch-pending`), but the `running` hold
// only engages at FIRST ACTIVITY (state flips → working). The
// `bound-pending` predicate spans that gap: a `state='stopped'`,
// `plan_verb`-bearing job with `active_since IS NULL` (never yet active) holds
// the root, and the `active_since` gate keeps a stopped-after-working / dead
// worker from over-holding.
// ---------------------------------------------------------------------------

test("fn-924: a freshly-bound (stopped + plan_verb + active_since NULL) job → bound-pending", () => {
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    jobs: [
      makeEmbeddedJob({
        job_id: "worker-1",
        plan_verb: "work",
        state: "stopped",
        active_since: null,
      }),
    ],
  });
  const epic = makeEpic({ epic_id: "fn-1-foo", tasks: [t1] });
  const snap = run([epic]);
  expect(snap.perTask.get(t1.task_id)).toEqual(
    blocked({ kind: "bound-pending" }),
  );
});

test("fn-924 over-hold guard: a stopped-AFTER-working job (active_since set) does NOT bound-pending — stays ready", () => {
  // A worker that ran then stopped (or was killed) carries a non-null
  // `active_since`, so it must NOT hold the root indefinitely. With no other
  // occupancy signal it falls through to `ready`.
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    jobs: [
      makeEmbeddedJob({
        job_id: "worker-1",
        plan_verb: "work",
        state: "stopped",
        active_since: 1700,
      }),
    ],
  });
  const epic = makeEpic({ epic_id: "fn-1-foo", tasks: [t1] });
  const snap = run([epic]);
  expect(snap.perTask.get(t1.task_id)).toEqual({ tag: "ready" });
});

test("fn-924: a stopped job with NO plan_verb (not a dispatched worker) does NOT bound-pending", () => {
  // A non-plan session (empty plan_verb) is not a dispatched worker, so it must
  // not hold the root. Falls through to ready.
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    jobs: [
      makeEmbeddedJob({
        job_id: "worker-1",
        plan_verb: "",
        state: "stopped",
        active_since: null,
      }),
    ],
  });
  const epic = makeEpic({ epic_id: "fn-1-foo", tasks: [t1] });
  const snap = run([epic]);
  expect(snap.perTask.get(t1.task_id)).toEqual({ tag: "ready" });
});

test("fn-924 handoff window: a bound-but-stopped, plan_verb-bearing job occupies its root and demotes a same-root ready sibling (the leak)", () => {
  // The pinned 2026-06-23 leak: fn-919.2 binds (state → stopped, pending_dispatches
  // discharged) but hasn't hit first activity yet; fn-923.1 (SAME root) was about
  // to co-dispatch. With bound-pending, T1 holds /repo and T2 is demoted to
  // `single-task-per-root` — the gap is closed.
  const a1 = makeTask({
    task_id: "fn-1-foo.1",
    jobs: [
      makeEmbeddedJob({
        job_id: "worker-a",
        plan_verb: "work",
        state: "stopped",
        active_since: null,
      }),
    ],
  });
  const epicA = makeEpic({ epic_id: "fn-1-foo", tasks: [a1] });
  const b1 = makeTask({ task_id: "fn-2-bar.1", epic_id: "fn-2-bar" });
  const epicB = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    // Same project_dir → same root.
    project_dir: "/repo",
    tasks: [b1],
  });
  const snap = run([epicA, epicB]);
  expect(snap.perTask.get(a1.task_id)).toEqual(
    blocked({ kind: "bound-pending" }),
  );
  expect(snap.perTask.get(b1.task_id)).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

test("fn-924: bound-pending holds the root in ARMED two-pass too (eligible same-root sibling still demoted)", () => {
  // The pass-1 occupancy seed is shared by the legacy single-pass (yolo) and the
  // armed two-pass — a bound-pending occupant claims the root before pass-2 runs,
  // so even an ELIGIBLE same-root task is demoted.
  const a1 = makeTask({
    task_id: "fn-1-foo.1",
    jobs: [
      makeEmbeddedJob({
        job_id: "worker-a",
        plan_verb: "work",
        state: "stopped",
        active_since: null,
      }),
    ],
  });
  const epicA = makeEpic({ epic_id: "fn-1-foo", tasks: [a1] });
  const b1 = makeTask({ task_id: "fn-2-bar.1", epic_id: "fn-2-bar" });
  const epicB = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/repo",
    tasks: [b1],
  });
  const perTask = new Map<string, Verdict>([
    [a1.task_id, blocked({ kind: "bound-pending" })],
    [b1.task_id, { tag: "ready" }],
  ]);
  const perCloseRow = new Map<string, Verdict>();
  applySingleTaskPerRootMutex(
    [epicA, epicB],
    perTask,
    perCloseRow,
    new Map(),
    new Set(),
    // Armed mode: epic B is eligible — still demoted by the pass-1 occupant.
    new Set(["fn-2-bar"]),
  );
  expect(perTask.get(a1.task_id)).toEqual(blocked({ kind: "bound-pending" }));
  expect(perTask.get(b1.task_id)).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

test("fn-924 close-row twin: a bound-but-stopped closer (epic.jobs plan_verb=close, active_since NULL) renders bound-pending", () => {
  // A `close::<epic_id>` closer that BOUND but hasn't hit first activity. All
  // tasks completed so the close row reads through to the late-rank predicates.
  const t1 = makeTask({ task_id: "fn-1-foo.1", worker_phase: "done" });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    status: "open",
    tasks: [t1],
    jobs: [
      makeEmbeddedJob({
        job_id: "closer-1",
        plan_verb: "close",
        state: "stopped",
        active_since: null,
      }),
    ],
  });
  const snap = run([epic]);
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    blocked({ kind: "bound-pending" }),
  );
});

// ---------------------------------------------------------------------------
// fn-779: close-row terminal-completed liveness gate. A `status:done` close row
// only collapses to `completed` once its closer is idle — same three
// close-scope clauses the task path uses (working epic-level close job, running
// sub-agent, live monitor lease). A done-but-live close row falls through to
// predicate 5/6/6.6's `running:*`, so it keeps occupying the per-epic AND
// per-root mutexes while the closer winds down. Close-row twins of the fn-671 /
// fn-719 task-path liveness tests, built with `plan_verb:"close"` epic-level
// jobs and asserted via `snap.perCloseRow`.
// ---------------------------------------------------------------------------

test("fn-779 close-row: status:done + working close job → running:job-running (not completed)", () => {
  const epic = makeEpic({
    status: "done",
    tasks: [makeTask({ task_id: "fn-1-foo.1", worker_phase: "done" })],
    jobs: [
      makeEmbeddedJob({
        job_id: "closer-1",
        plan_verb: "close",
        state: "working",
      }),
    ],
  });
  const snap = run([epic]);
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    running({ kind: "job-running" }),
  );
});

test("fn-779 close-row: status:done + stopped close job + running sub-agent → running:sub-agent-running", () => {
  const epic = makeEpic({
    status: "done",
    tasks: [makeTask({ task_id: "fn-1-foo.1", worker_phase: "done" })],
    jobs: [
      makeEmbeddedJob({
        job_id: "closer-1",
        plan_verb: "close",
        state: "stopped",
      }),
    ],
  });
  const subs = [makeSub({ job_id: "closer-1", status: "running" })];
  const snap = run([epic], new Map(), subs);
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    running({ kind: "sub-agent-running" }),
  );
});

test("fn-779 close-row: status:done + stale running sub-agent → running:sub-agent-stale (runWithNow)", () => {
  const epic = makeEpic({
    status: "done",
    tasks: [makeTask({ task_id: "fn-1-foo.1", worker_phase: "done" })],
    jobs: [
      makeEmbeddedJob({
        job_id: "closer-1",
        plan_verb: "close",
        state: "stopped",
      }),
    ],
  });
  const subs = [makeSub({ job_id: "closer-1", status: "running", ts: 1000 })];
  // now=1200: age=200 > SUBAGENT_STALENESS_SEC=120 → stale, still occupying.
  const snap = runWithNow([epic], subs, 1200);
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    running({ kind: "sub-agent-stale" }),
  );
});

test("fn-779 close-row: status:done + live worker monitor → running:monitor-running (runWithNow)", () => {
  const epic = makeEpic({
    status: "done",
    tasks: [makeTask({ task_id: "fn-1-foo.1", worker_phase: "done" })],
    jobs: [
      makeEmbeddedJob({
        job_id: "closer-1",
        plan_verb: "close",
        state: "stopped",
        has_live_worker_monitor: true,
        updated_at: 1000,
      }),
    ],
  });
  // now=1100: age=100 < MONITOR_STALENESS_SEC=600 → fresh, monitor-running.
  const snap = runWithNow([epic], [], 1100);
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    running({ kind: "monitor-running" }),
  );
});

test("fn-779 close-row: status:done + idle closer → completed (clean collapse)", () => {
  const epic = makeEpic({
    status: "done",
    tasks: [makeTask({ task_id: "fn-1-foo.1", worker_phase: "done" })],
    jobs: [
      makeEmbeddedJob({
        job_id: "closer-1",
        plan_verb: "close",
        state: "stopped",
      }),
    ],
  });
  const snap = run([epic]);
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual({ tag: "completed" });
});

test("fn-779 close-row: status:done + working close job occupies the per-root mutex (demotes same-root sibling epic's ready task)", () => {
  // The done-but-live close row is a `running` verdict → root occupant. A
  // sibling epic's ready task on the same project_dir is demoted, proving the
  // mutex stays held while the closer winds down.
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo",
    status: "done",
    tasks: [makeTask({ task_id: "fn-1-foo.1", worker_phase: "done" })],
    jobs: [
      makeEmbeddedJob({
        job_id: "closer-1",
        plan_verb: "close",
        state: "working",
      }),
    ],
  });
  const e2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-2-bar.1", epic_id: "fn-2-bar" })],
  });
  const snap = run([e1, e2]);
  expect(snap.perCloseRow.get("fn-1-foo")).toEqual(
    running({ kind: "job-running" }),
  );
  expect(snap.perTask.get("fn-2-bar.1")).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

// ---------------------------------------------------------------------------
// fn-779: predicate-9 `satisfied` liveness gate. A downstream task whose
// `resolved_epic_deps` entry reads `satisfied` stays `blocked:dep-on-epic`
// while the IN-SNAPSHOT upstream still has live close-scope work. Out-of-
// snapshot / cross-project / null-resolution upstreams keep today's skip. The
// helper pools RAW upstream state, so the answer is independent of where the
// upstream sorts relative to the consumer in the input array.
// ---------------------------------------------------------------------------

test("fn-779 predicate 9: satisfied dep on an in-snapshot, live-closing upstream → blocked:dep-on-epic", () => {
  const upstream = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    status: "done",
    tasks: [makeTask({ task_id: "fn-2-bar.1", worker_phase: "done" })],
    jobs: [
      makeEmbeddedJob({
        job_id: "closer-2",
        plan_verb: "close",
        state: "working",
      }),
    ],
  });
  const consumer = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
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
  const snap = run([upstream, consumer]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual(
    blocked({ kind: "dep-on-epic", upstream: "fn-2-bar", cross_project: null }),
  );
});

test("fn-779 predicate 9: satisfied dep on an in-snapshot, IDLE upstream → ready", () => {
  const upstream = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    status: "done",
    tasks: [makeTask({ task_id: "fn-2-bar.1", worker_phase: "done" })],
    jobs: [
      makeEmbeddedJob({
        job_id: "closer-2",
        plan_verb: "close",
        state: "stopped",
      }),
    ],
  });
  const consumer = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
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
  const snap = run([upstream, consumer]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
});

test("fn-779 predicate 9: satisfied dep, live work on the upstream's TASK-level job → blocked:dep-on-epic (pools task scope)", () => {
  // The closer's wind-down work landed as a task-level job (not epic-level).
  // The helper pools `task.jobs` too, so the dependent still holds.
  const upstream = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    status: "done",
    tasks: [
      makeTask({
        task_id: "fn-2-bar.1",
        worker_phase: "done",
        jobs: [makeEmbeddedJob({ job_id: "worker-2", state: "working" })],
      }),
    ],
  });
  const consumer = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
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
  const snap = run([upstream, consumer]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual(
    blocked({ kind: "dep-on-epic", upstream: "fn-2-bar", cross_project: null }),
  );
});

test("fn-779 predicate 9: multiple satisfied deps, a LATER one is live → blocked (checks every entry)", () => {
  const idle = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    status: "done",
    tasks: [makeTask({ task_id: "fn-2-bar.1", worker_phase: "done" })],
  });
  const live = makeEpic({
    epic_id: "fn-3-baz",
    epic_number: 3,
    status: "done",
    tasks: [makeTask({ task_id: "fn-3-baz.1", worker_phase: "done" })],
    jobs: [
      makeEmbeddedJob({
        job_id: "closer-3",
        plan_verb: "close",
        state: "working",
      }),
    ],
  });
  const consumer = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
    depends_on_epics: ["fn-2-bar", "fn-3-baz"],
    resolved_epic_deps: [
      makeResolvedDep({
        dep_token: "fn-2-bar",
        resolved_epic_id: "fn-2-bar",
        epic_number: 2,
        project_basename: "keeper",
        cross_project: false,
        state: "satisfied",
      }),
      makeResolvedDep({
        dep_token: "fn-3-baz",
        resolved_epic_id: "fn-3-baz",
        epic_number: 3,
        project_basename: "keeper",
        cross_project: false,
        state: "satisfied",
      }),
    ],
  });
  const snap = run([idle, live, consumer]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual(
    blocked({ kind: "dep-on-epic", upstream: "fn-3-baz", cross_project: null }),
  );
});

test("fn-779 predicate 9: forward-reference order (consumer BEFORE live upstream in the input array) → still blocked (order-independent)", () => {
  // The consumer epic sorts FIRST in the input array, so when its task path
  // runs the upstream's verdict isn't computed yet. The gate reads RAW upstream
  // state, not a verdict, so the answer is identical regardless of order.
  const upstream = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    status: "done",
    tasks: [makeTask({ task_id: "fn-2-bar.1", worker_phase: "done" })],
    jobs: [
      makeEmbeddedJob({
        job_id: "closer-2",
        plan_verb: "close",
        state: "working",
      }),
    ],
  });
  const consumer = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
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
  // Consumer first — proves the gate doesn't depend on the upstream's verdict.
  const snap = run([consumer, upstream]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual(
    blocked({ kind: "dep-on-epic", upstream: "fn-2-bar", cross_project: null }),
  );
});

// ---------------------------------------------------------------------------
// fn-835 (a): runtime_status="blocked" is never dispatched
// ---------------------------------------------------------------------------
//
// `computeReadiness` now consults plan `runtime_status` as the LAST per-row
// predicate (rank 10.6): a `runtime_status="blocked"` task converts from the
// erroneous `ready` to `blocked:runtime-blocked`. Placed last so terminal-
// completed / running / dispatch-pending still WIN — a done-but-stale-blocked
// task still completes, a live worker's mutex is not released, a just-launched
// worker is not raced. Only literal `"blocked"` is nondispatchable.

test("fn-835 (a): runtime_status='blocked' + worker_phase='open' → blocked:runtime-blocked (not dispatched)", () => {
  const task = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "open",
    runtime_status: "blocked",
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual(
    blocked({ kind: "runtime-blocked" }),
  );
});

test("fn-835 (a): runtime_status='blocked' does NOT hold the per-root mutex (occupancy unaffected, sibling on same root stays ready)", () => {
  // A blocked task in fn-1 must not occupy `/repo`; a ready task in fn-2 on the
  // same root still dispatches. `isLiveWorkOccupant` excludes runtime-blocked.
  const blockedTask = makeTask({
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    runtime_status: "blocked",
  });
  const epic1 = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo",
    tasks: [blockedTask],
  });
  const readyTask = makeTask({ task_id: "fn-2-bar.1", epic_id: "fn-2-bar" });
  const epic2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/repo",
    tasks: [readyTask],
  });
  const snap = run([epic1, epic2]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual(
    blocked({ kind: "runtime-blocked" }),
  );
  expect(snap.perTask.get("fn-2-bar.1")).toEqual({ tag: "ready" });
  expect(isRootOccupant(blocked({ kind: "runtime-blocked" }))).toBe(false);
});

test("fn-835 (a): worker_phase='done' BEATS a stale runtime_status='blocked' → terminal-completed (gate is last)", () => {
  // A done task with an idle session terminal-completes (predicate 1) despite a
  // stale blocked flag — runtime-blocked is ranked AFTER terminal-completed, so
  // it converts ONLY the erroneous `ready`, never masking the truer verdict.
  const task = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    runtime_status: "blocked",
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "completed" });
});

test("fn-835 (a): a live worker (worker_phase='done' + working job) BEATS a stale runtime_status='blocked' → running (mutex not released)", () => {
  // A still-working embedded job holds the task at running:job-running
  // (predicate 5) even with a stale blocked flag — the runtime-blocked gate
  // never releases a live worker's mutex.
  const task = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    runtime_status: "blocked",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "working" })],
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual(
    running({ kind: "job-running" }),
  );
});

test("fn-835 (a): runtime_status='in_progress'/'todo' are dispatchable (only literal 'blocked' is gated)", () => {
  const todoTask = makeTask({
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    runtime_status: "todo",
  });
  const inProgressTask = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
    runtime_status: "in_progress",
  });
  const epic1 = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo-a",
    tasks: [todoTask],
  });
  const epic2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/repo-b",
    tasks: [inProgressTask],
  });
  const snap = run([epic1, epic2]);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-2-bar.1")).toEqual({ tag: "ready" });
});

test("fn-835 (a): formatPill renders [blocked:runtime-blocked]", () => {
  expect(formatPill(blocked({ kind: "runtime-blocked" }))).toBe(
    "[blocked:runtime-blocked]",
  );
});

// ---------------------------------------------------------------------------
// fn-770: armed-aware per-root mutex (eligible-priority pass-2)
// ---------------------------------------------------------------------------
//
// The per-root mutex's discretionary pass-2 ready-tiebreak became
// eligibility-aware: when `computeReadiness` (or `applySingleTaskPerRootMutex`
// directly) is handed an `eligibleEpicIds` Set, an ELIGIBLE epic's ready task
// claims a free root BEFORE any earlier-sorted INELIGIBLE sibling can. ABSENT
// (`undefined`) the legacy single-pass holds (yolo byte-identical). In armed
// mode a ready close row's root-claim is gated on eligibility too (fn-835 (c) —
// mirroring the launcher's close gate so an ineligible closer can't starve an
// eligible same-root task); yolo keeps close rows eligibility-blind. Pass-1
// physical occupancy (an in-flight closer / live worker) is never
// eligibility-conditional.

// Thread an explicit eligible set through `computeReadiness` (yolo passes
// `undefined`, armed passes a Set). All the prior `pendingDispatches`-default
// callers stay valid; this just exercises the trailing fn-770 param.
function runWithEligible(epics: Epic[], eligible: Set<string> | undefined) {
  return computeReadiness(
    epics,
    new Map(),
    [],
    new Map(),
    Number.NEGATIVE_INFINITY,
    [],
    eligible,
  );
}

// Two open epics sharing `/repo`; the lower-sort one (`fn-1`) sorts first.
// Both have a single ready task. Helper keeps the eight cases terse.
function sharedRootPair() {
  const t1 = makeTask({ task_id: "fn-1-foo.1", epic_id: "fn-1-foo" });
  const epic1 = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo",
    tasks: [t1],
  });
  const t2 = makeTask({ task_id: "fn-2-bar.1", epic_id: "fn-2-bar" });
  const epic2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/repo",
    tasks: [t2],
  });
  return { epic1, epic2, t1, t2 };
}

test("fn-770 (a): eligible ready beats an earlier-sorted ineligible ready on a shared root", () => {
  // THE DEADLOCK REPRO. fn-1 (lower epic_number, ready, INELIGIBLE) would win the
  // single per-root slot under the legacy single-pass; the armed gate would
  // then suppress fn-2's `work` launch → net deadlock. With fn-2 eligible, the
  // two-pass pass-2a awards `/repo` to fn-2 FIRST; fn-1 is demoted.
  const { epic1, epic2, t1, t2 } = sharedRootPair();
  const snap = runWithEligible([epic1, epic2], new Set(["fn-2-bar"]));
  expect(snap.perTask.get(t2.task_id)).toEqual({ tag: "ready" });
  expect(snap.perTask.get(t1.task_id)).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

test("fn-770 (b): eligible-vs-eligible → first in iteration order wins, loser demoted", () => {
  // Both epics eligible → pass-2a walks iteration order; the first-walked
  // (fn-1) claims `/repo`, fn-2 is demoted. Deterministic, sort-order tiebreak.
  const { epic1, epic2, t1, t2 } = sharedRootPair();
  const snap = runWithEligible(
    [epic1, epic2],
    new Set(["fn-1-foo", "fn-2-bar"]),
  );
  expect(snap.perTask.get(t1.task_id)).toEqual({ tag: "ready" });
  expect(snap.perTask.get(t2.task_id)).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

test('fn-770 (c): `""` rootless bucket — ineligible never wins over an eligible row', () => {
  // Both rows are rootless (project_dir null, no target_repo) → both collapse
  // into the `""` bucket. fn-1 sorts first but is ineligible; the eligible fn-2
  // must still take the single rootless slot, fn-1 demoted.
  const t1 = makeTask({ task_id: "fn-1-foo.1", epic_id: "fn-1-foo" });
  const epic1 = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: null,
    tasks: [t1],
  });
  const t2 = makeTask({ task_id: "fn-2-bar.1", epic_id: "fn-2-bar" });
  const epic2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: null,
    tasks: [t2],
  });
  const snap = runWithEligible([epic1, epic2], new Set(["fn-2-bar"]));
  expect(snap.perTask.get(t2.task_id)).toEqual({ tag: "ready" });
  expect(snap.perTask.get(t1.task_id)).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

test("fn-770 (d): `undefined` param → byte-identical legacy single-pass (yolo regression guard)", () => {
  // No eligible set → single-pass. fn-1 sorts first and wins; fn-2 demoted —
  // exactly the pre-fn-770 behavior. Asserted against the SAME `run` helper
  // (which omits the param) to prove identity.
  const { epic1, epic2, t1, t2 } = sharedRootPair();
  const explicitUndefined = runWithEligible([epic1, epic2], undefined);
  expect(explicitUndefined.perTask.get(t1.task_id)).toEqual({ tag: "ready" });
  expect(explicitUndefined.perTask.get(t2.task_id)).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
  // And identical to the default-param `run` (no trailing arg at all): an
  // explicit `undefined` must produce the same per-task map as omitting it.
  const legacy = run([epic1, epic2]);
  expect(explicitUndefined.perTask.get(t1.task_id)).toEqual(
    legacy.perTask.get(t1.task_id),
  );
  expect(explicitUndefined.perTask.get(t2.task_id)).toEqual(
    legacy.perTask.get(t2.task_id),
  );
});

test("fn-770 (e): empty-set param → two-pass, every task row suppressed (armed-nothing-armed)", () => {
  // An EMPTY set is PROVIDED (not `undefined`), so the two-pass runs but NO
  // epic is eligible: pass-2a settles no task, pass-2b sees both as ineligible.
  // fn-1 (first iteration) claims `/repo`, fn-2 demoted — but neither is
  // eligible, so the reconcile gate suppresses BOTH launches. The mutex here
  // just must NOT silently behave like yolo (i.e. must still run two-pass);
  // the observable mutex effect is the same single-slot collapse. Crucially it
  // must NOT branch on `.size === 0`.
  const { epic1, epic2, t1, t2 } = sharedRootPair();
  const snap = runWithEligible([epic1, epic2], new Set());
  // Both task rows settle (one wins the slot in 2b, one demoted) — neither is
  // promoted past what the single-pass would do, and no throw on empty set.
  const v1 = snap.perTask.get(t1.task_id);
  const v2 = snap.perTask.get(t2.task_id);
  expect(v1).toEqual({ tag: "ready" });
  expect(v2).toEqual(blocked({ kind: "single-task-per-root" }));
});

test("fn-770 (f): pass-1 live occupant demotes an eligible ready row (no preemption)", () => {
  // fn-1 has a LIVE worker monitor → `monitor-running`, a pass-1 root occupant
  // claiming `/repo` UNCONDITIONALLY (eligibility-blind). fn-2's task is
  // eligible+ready but the root is already physically held → demoted. An
  // eligible task NEVER preempts a live worker, even an unarmed one.
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    worker_phase: "done",
    jobs: [
      makeEmbeddedJob({
        job_id: "worker-1",
        state: "stopped",
        has_live_worker_monitor: true,
      }),
    ],
  });
  const epic1 = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo",
    tasks: [t1],
  });
  const t2 = makeTask({ task_id: "fn-2-bar.1", epic_id: "fn-2-bar" });
  const epic2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/repo",
    tasks: [t2],
  });
  const snap = runWithEligible([epic1, epic2], new Set(["fn-2-bar"]));
  expect(snap.perTask.get(t1.task_id)).toEqual(
    running({ kind: "monitor-running" }),
  );
  expect(snap.perTask.get(t2.task_id)).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

test("fn-770 (g): ineligible `fallbackRoots` entry demotes an eligible sibling", () => {
  // Direct-mutex call: `/repo` is held by a launch-window `fallbackRoots`
  // entry (a pending dispatch with no matching row). Pass-1 seeds it into
  // `occupiedRoots` before any pass-2 walk, so even an eligible fn-2 ready task
  // is demoted — the launch-window occupancy is physical, eligibility-blind.
  const { epic1, epic2, t1, t2 } = sharedRootPair();
  const perTask = new Map<string, Verdict>([
    [t1.task_id, { tag: "ready" }],
    [t2.task_id, { tag: "ready" }],
  ]);
  const perCloseRow = new Map<string, Verdict>();
  applySingleTaskPerRootMutex(
    [epic1, epic2],
    perTask,
    perCloseRow,
    new Map(),
    new Set(["/repo"]),
    new Set(["fn-2-bar"]),
  );
  expect(perTask.get(t2.task_id)).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
  expect(perTask.get(t1.task_id)).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

test("fn-835 (c): armed mode — an INELIGIBLE ready close row does NOT claim the root, eligible same-root task dispatches", () => {
  // THE BUG-2 REPRO (fn-830 done-but-open close row + fn-832 armed task, shared
  // keeper root). fn-1 is UNARMED and done with a ready close row on `/repo`; an
  // eligible fn-2 ready TASK shares the root. Pre-fix, pass-2a settled fn-1's
  // close eligibility-BLIND, claiming `/repo` and demoting fn-2 to
  // `single-task-per-root` — while the launcher SUPPRESSED the unarmed close
  // launch. Net: armed mode dispatched nothing. Post-fix, `settleCloseRow` gates
  // the root-claim on eligibility (mirroring the launcher's close gate): the
  // ineligible close neither claims nor demotes, leaving `/repo` free for the
  // eligible fn-2 task.
  const closeTask = makeTask({
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    worker_phase: "done",
    runtime_status: "done",
  });
  const epic1 = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo",
    status: "open",
    tasks: [closeTask],
  });
  const t2 = makeTask({ task_id: "fn-2-bar.1", epic_id: "fn-2-bar" });
  const epic2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/repo",
    tasks: [t2],
  });
  // Direct mutex call to pin the close-vs-task ordering deterministically.
  const perTask = new Map<string, Verdict>([
    [closeTask.task_id, { tag: "completed" }],
    [t2.task_id, { tag: "ready" }],
  ]);
  const perCloseRow = new Map<string, Verdict>([
    ["fn-1-foo", { tag: "ready" }],
    // fn-2's close is not ready (epic still has open work) — any non-ready
    // verdict; it must stay untouched by the mutex.
    ["fn-2-bar", blocked({ kind: "dep-on-task", upstream: "fn-2-bar.1" })],
  ]);
  applySingleTaskPerRootMutex(
    [epic1, epic2],
    perTask,
    perCloseRow,
    new Map(),
    new Set(),
    new Set(["fn-2-bar"]),
  );
  // The ineligible close left `/repo` free → eligible fn-2 task claims it and
  // stays ready. The close row neither claimed nor demoted (still ready; the
  // launcher's own close gate suppresses its launch).
  expect(perTask.get(t2.task_id)).toEqual({ tag: "ready" });
  expect(perCloseRow.get("fn-1-foo")).toEqual({ tag: "ready" });
});

test("fn-835 (c): armed mode — an ELIGIBLE epic's ready close row STILL claims the root (eligible close not starved)", () => {
  // Eligibility gate is eligible-OR-in-flight; here fn-1 is ELIGIBLE so its
  // ready close row claims `/repo` in pass-2a, demoting the same-root eligible
  // fn-2 task — the close finalizer beats the task when it sorts first and the
  // epic is in the closure.
  const closeTask = makeTask({
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    worker_phase: "done",
    runtime_status: "done",
  });
  const epic1 = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo",
    status: "open",
    tasks: [closeTask],
  });
  const t2 = makeTask({ task_id: "fn-2-bar.1", epic_id: "fn-2-bar" });
  const epic2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/repo",
    tasks: [t2],
  });
  const perTask = new Map<string, Verdict>([
    [closeTask.task_id, { tag: "completed" }],
    [t2.task_id, { tag: "ready" }],
  ]);
  const perCloseRow = new Map<string, Verdict>([
    ["fn-1-foo", { tag: "ready" }],
    ["fn-2-bar", blocked({ kind: "dep-on-task", upstream: "fn-2-bar.1" })],
  ]);
  applySingleTaskPerRootMutex(
    [epic1, epic2],
    perTask,
    perCloseRow,
    new Map(),
    new Set(),
    new Set(["fn-1-foo", "fn-2-bar"]),
  );
  expect(perCloseRow.get("fn-1-foo")).toEqual({ tag: "ready" });
  expect(perTask.get(t2.task_id)).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

test("fn-835 (c): YOLO — a ready close row STILL claims the root (mode-exempt, no eligibility gate)", () => {
  // `eligibleEpicIds === undefined` (yolo) keeps the legacy single-pass: the
  // close row is eligibility-blind and claims `/repo` regardless, demoting the
  // same-root task. yolo launches closers, so no starvation. Regression guard
  // against the eligibility gate leaking into yolo.
  const closeTask = makeTask({
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    worker_phase: "done",
    runtime_status: "done",
  });
  const epic1 = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo",
    status: "open",
    tasks: [closeTask],
  });
  const t2 = makeTask({ task_id: "fn-2-bar.1", epic_id: "fn-2-bar" });
  const epic2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/repo",
    tasks: [t2],
  });
  const perTask = new Map<string, Verdict>([
    [closeTask.task_id, { tag: "completed" }],
    [t2.task_id, { tag: "ready" }],
  ]);
  const perCloseRow = new Map<string, Verdict>([
    ["fn-1-foo", { tag: "ready" }],
    ["fn-2-bar", blocked({ kind: "dep-on-task", upstream: "fn-2-bar.1" })],
  ]);
  // No trailing eligible arg → yolo single-pass.
  applySingleTaskPerRootMutex([epic1, epic2], perTask, perCloseRow);
  expect(perCloseRow.get("fn-1-foo")).toEqual({ tag: "ready" });
  expect(perTask.get(t2.task_id)).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

// ---------------------------------------------------------------------------
// fn-954: per-root N-slot round-robin allocator (predicates 11+12)
// ---------------------------------------------------------------------------
//
// `applyPerRootRoundRobinAllocator` REPLACES the two legacy mutexes. N=1 is
// byte-identical (it delegates verbatim to per-epic-then-per-root); N>1 fills
// up to N concurrent slots per root, spread fairly across the root's epics via
// round-robin (a 2nd task per epic only after every sibling epic with ready
// work has its first; a lone epic takes multiple). Occupancy (running/pending)
// is pre-consumed so an in-flight epic isn't over-allocated. The armed two-pass
// + close-row eligibility gate carry through both paths.

// Thread N through `computeReadiness`'s trailing param (eligible defaults to
// `undefined` = yolo). All prior default-reliant callers stay valid.
function runWithN(
  epics: Epic[],
  n: number,
  eligible: Set<string> | undefined = undefined,
) {
  return computeReadiness(
    epics,
    new Map(),
    [],
    new Map(),
    Number.NEGATIVE_INFINITY,
    [],
    eligible,
    new Set<string>(),
    n,
  );
}

// N ready tasks in one epic on a shared root, traversal order t.1..t.N.
function makeStackEpic(
  epicId: string,
  epicNumber: number,
  root: string,
  readyCount: number,
  extra: Partial<Epic> = {},
): { epic: Epic; tasks: Task[] } {
  const tasks: Task[] = [];
  for (let i = 1; i <= readyCount; i++) {
    tasks.push(
      makeTask({
        task_id: `${epicId}.${i}`,
        epic_id: epicId,
        task_number: i,
        target_repo: root,
      }),
    );
  }
  const epic = makeEpic({
    epic_id: epicId,
    epic_number: epicNumber,
    project_dir: root,
    tasks,
    ...extra,
  });
  return { epic, tasks };
}

test("fn-954 N=1 equivalence: cross-epic same-root → byte-identical to the legacy mutex (first wins, rest per-root)", () => {
  // THE EQUIVALENCE GATE. Same fixture as the legacy per-root suite. N=1 MUST
  // produce identical demotions: fn-1 (seam-first) keeps its slot, fn-2 demotes
  // to `single-task-per-root` — exactly today's two-pass result.
  const a = makeTask({ task_id: "fn-1-foo.1", target_repo: "/r" });
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/r",
    tasks: [a],
  });
  const b = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
    target_repo: "/r",
  });
  const e2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/r",
    tasks: [b],
  });
  const snap = runWithN([e1, e2], 1);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-2-bar.1")).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

test("fn-954 N=1 equivalence: intra-epic same-root → second demotes single-task-per-epic (per-epic-first attribution)", () => {
  // Per-epic-first reason attribution must survive: a same-epic same-root
  // collision reports `single-task-per-epic`, NOT per-root.
  const { epic } = makeStackEpic("fn-1-foo", 1, "/r", 2);
  const snap = runWithN([epic], 1);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-1-foo.2")).toEqual(
    blocked({ kind: "single-task-per-epic" }),
  );
});

test("fn-954 N=3 round-robin spread: 4 epics, 1 ready each on a shared root → first 3 (seam order) win, 4th demotes per-root", () => {
  const e1 = makeStackEpic("fn-1-a", 1, "/r", 1).epic;
  const e2 = makeStackEpic("fn-2-b", 2, "/r", 1).epic;
  const e3 = makeStackEpic("fn-3-c", 3, "/r", 1).epic;
  const e4 = makeStackEpic("fn-4-d", 4, "/r", 1).epic;
  const snap = runWithN([e1, e2, e3, e4], 3);
  // Seam order (all unstarted → epic_number asc): fn-1, fn-2, fn-3 each take a
  // slot; fn-4 got ZERO slots because the root saturated → single-task-per-root.
  expect(snap.perTask.get("fn-1-a.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-2-b.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-3-c.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-4-d.1")).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

test("fn-954 N=3 intra-epic stacking: lone epic with 3 ready tasks → all 3 dispatch", () => {
  const { epic } = makeStackEpic("fn-1-foo", 1, "/r", 3);
  const snap = runWithN([epic], 3);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-1-foo.2")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-1-foo.3")).toEqual({ tag: "ready" });
});

test("fn-954 N=3 fairness: a 2nd task per epic only after every sibling epic with ready work has its first", () => {
  // Two epics on /r, each with 2 ready tasks, N=3. Round 1: fn-1.1, fn-2.1.
  // Round 2: one more slot → goes to the least-loaded epic, tie broken by seam
  // order → fn-1.2. fn-2.2 loses to fn-1's fair-share win and the now-full root.
  const a = makeStackEpic("fn-1-a", 1, "/r", 2);
  const b = makeStackEpic("fn-2-b", 2, "/r", 2);
  const snap = runWithN([a.epic, b.epic], 3);
  expect(snap.perTask.get("fn-1-a.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-2-b.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-1-a.2")).toEqual({ tag: "ready" });
  // fn-2.2: fn-2 did receive a grant (fn-2.1) → its extra loses to its own
  // fair share → single-task-per-epic.
  expect(snap.perTask.get("fn-2-b.2")).toEqual(
    blocked({ kind: "single-task-per-epic" }),
  );
});

test("fn-954 occupancy seeding: epic with 1 running + N=2 gets 1 MORE, not 2 (no bonus-round over-allocation)", () => {
  // fn-1 has a running worker on /r (pre-consumes a root slot AND an epic slot)
  // plus 2 ready tasks. N=2 → only 1 free slot remains → exactly 1 ready task
  // is kept; the other demotes. The running task must NOT be offered 2 more.
  const runningT = makeTask({
    task_id: "fn-1-foo.1",
    target_repo: "/r",
    jobs: [makeEmbeddedJob({ state: "working" })],
  });
  const r1 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    target_repo: "/r",
  });
  const r2 = makeTask({
    task_id: "fn-1-foo.3",
    task_number: 3,
    target_repo: "/r",
  });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/r",
    tasks: [runningT, r1, r2],
  });
  const snap = runWithN([epic], 2);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual(
    running({ kind: "job-running" }),
  );
  expect(snap.perTask.get("fn-1-foo.2")).toEqual({ tag: "ready" });
  // Only 1 free slot (N=2 − 1 running) → the 3rd is denied; the epic already had
  // representation (running + a grant) → single-task-per-epic.
  expect(snap.perTask.get("fn-1-foo.3")).toEqual(
    blocked({ kind: "single-task-per-epic" }),
  );
});

test("fn-954 occupancy seeding: running occupant on a sibling epic pre-consumes a root slot (N=2, 1 free)", () => {
  // fn-1 has a running worker on /r (no ready tasks). fn-2 has 2 ready tasks on
  // /r. N=2 → fn-1's running consumes 1 slot, leaving 1 → fn-2.1 wins, fn-2.2
  // demotes. fn-2 got a grant → its extra is single-task-per-epic.
  const runningT = makeTask({
    task_id: "fn-1-foo.1",
    target_repo: "/r",
    worker_phase: "done",
    jobs: [makeEmbeddedJob({ state: "working" })],
  });
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/r",
    tasks: [runningT],
  });
  const e2 = makeStackEpic("fn-2-bar", 2, "/r", 2).epic;
  const snap = runWithN([e1, e2], 2);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual(
    running({ kind: "job-running" }),
  );
  expect(snap.perTask.get("fn-2-bar.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-2-bar.2")).toEqual(
    blocked({ kind: "single-task-per-epic" }),
  );
});

test("fn-954 N>1 independent roots: each root fills its own N slots (no cross-root coupling)", () => {
  // fn-1 on /r1 (2 ready), fn-2 on /r2 (2 ready), N=1. Each root has its OWN
  // single slot → each epic keeps exactly its first task.
  const a = makeStackEpic("fn-1-a", 1, "/r1", 2);
  const b = makeStackEpic("fn-2-b", 2, "/r2", 2);
  const snap = runWithN([a.epic, b.epic], 2);
  // N=2 per root, each epic has 2 ready on its own root → both dispatch on each.
  expect(snap.perTask.get("fn-1-a.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-1-a.2")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-2-b.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-2-b.2")).toEqual({ tag: "ready" });
});

test("fn-954 N>1 armed composition: an eligible epic claims free slots before an earlier-sorted ineligible sibling", () => {
  // /r, N=2. fn-1 (seam-first, INELIGIBLE) has 2 ready; fn-2 (ELIGIBLE) has 1
  // ready. Pass-2a fills eligible first → fn-2.1 takes a slot; pass-2b fills the
  // 1 remaining slot with the ineligible fn-1 → fn-1.1 keeps, fn-1.2 demotes.
  const a = makeStackEpic("fn-1-a", 1, "/r", 2);
  const b = makeStackEpic("fn-2-b", 2, "/r", 1);
  const snap = runWithN([a.epic, b.epic], 2, new Set(["fn-2-b"]));
  expect(snap.perTask.get("fn-2-b.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-1-a.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-1-a.2")).toEqual(
    blocked({ kind: "single-task-per-epic" }),
  );
});

test("fn-954 N>1 close-row eligibility gate intact (fn-835): ineligible ready close neither claims nor demotes", () => {
  // Direct allocator call, N=2. fn-1 (UNARMED) has a ready close row on /repo;
  // fn-2 (ELIGIBLE) has 1 ready task. The ineligible close must NOT consume a
  // slot — fn-2's task dispatches and the close stays ready (launcher suppresses
  // its actual launch).
  const closeTask = makeTask({
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    worker_phase: "done",
    runtime_status: "done",
  });
  const epic1 = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo",
    status: "open",
    tasks: [closeTask],
  });
  const t2 = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
    target_repo: "/repo",
  });
  const epic2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/repo",
    tasks: [t2],
  });
  const perTask = new Map<string, Verdict>([
    [closeTask.task_id, { tag: "completed" }],
    [t2.task_id, { tag: "ready" }],
  ]);
  const perCloseRow = new Map<string, Verdict>([
    ["fn-1-foo", { tag: "ready" }],
    ["fn-2-bar", blocked({ kind: "dep-on-task", upstream: "fn-2-bar.1" })],
  ]);
  applyPerRootRoundRobinAllocator(
    [epic1, epic2],
    perTask,
    perCloseRow,
    new Map(),
    new Set(),
    2,
    new Set(["fn-2-bar"]),
  );
  expect(perTask.get(t2.task_id)).toEqual({ tag: "ready" });
  expect(perCloseRow.get("fn-1-foo")).toEqual({ tag: "ready" });
});

test("fn-954 N>1 close-row consumes a slot: an eligible ready close + a same-root ready task share an N=2 root", () => {
  // /repo, N=2. fn-1 (ELIGIBLE) ready close row + fn-2 (ELIGIBLE) 1 ready task.
  // 2 slots → close takes one, task takes the other; both dispatch.
  const closeTask = makeTask({
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    worker_phase: "done",
    runtime_status: "done",
  });
  const epic1 = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo",
    status: "open",
    tasks: [closeTask],
  });
  const t2 = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
    target_repo: "/repo",
  });
  const epic2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/repo",
    tasks: [t2],
  });
  const perTask = new Map<string, Verdict>([
    [closeTask.task_id, { tag: "completed" }],
    [t2.task_id, { tag: "ready" }],
  ]);
  const perCloseRow = new Map<string, Verdict>([
    ["fn-1-foo", { tag: "ready" }],
    ["fn-2-bar", blocked({ kind: "dep-on-task", upstream: "fn-2-bar.1" })],
  ]);
  applyPerRootRoundRobinAllocator(
    [epic1, epic2],
    perTask,
    perCloseRow,
    new Map(),
    new Set(),
    2,
    new Set(["fn-1-foo", "fn-2-bar"]),
  );
  expect(perCloseRow.get("fn-1-foo")).toEqual({ tag: "ready" });
  expect(perTask.get(t2.task_id)).toEqual({ tag: "ready" });
});

test("fn-954 N>1 fallbackRoots seeding: a launch-window root entry pre-consumes a slot", () => {
  // /repo, N=2, with /repo in fallbackRoots (a pending dispatch with no matching
  // row). One epic with 2 ready tasks → the fallback consumes 1 slot, leaving 1
  // → only the first task is kept.
  const { epic } = makeStackEpic("fn-1-foo", 1, "/repo", 2);
  const perTask = new Map<string, Verdict>([
    ["fn-1-foo.1", { tag: "ready" }],
    ["fn-1-foo.2", { tag: "ready" }],
  ]);
  applyPerRootRoundRobinAllocator(
    [epic],
    perTask,
    new Map(),
    new Map(),
    new Set(["/repo"]),
    2,
  );
  expect(perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
  // The epic got 1 grant → its extra is single-task-per-epic.
  expect(perTask.get("fn-1-foo.2")).toEqual(
    blocked({ kind: "single-task-per-epic" }),
  );
});

test("fn-954 N>1 global-cap AND: the allocator grants ≤ N per root, but the global budget further caps total launches", () => {
  // This pins the COMPOSITION contract: the allocator is per-root; the global
  // `maxConcurrentJobs` budget in the reconciler is a SEPARATE AND. Here we
  // verify the allocator alone grants up to N (the budget gate lives in
  // autopilot-worker and only counts `isRootOccupant` rows, which a `ready`
  // grant is NOT — so granted-ready rows don't inflate the occupied count).
  const { epic } = makeStackEpic("fn-1-foo", 1, "/r", 3);
  const snap = runWithN([epic], 3);
  // All 3 ready (allocator ceiling). None is an occupant, so the global budget
  // (computed downstream over occupants) sees 0 occupied — the budget then caps
  // how many of these 3 actually launch. Allocator + budget = AND.
  for (const v of snap.perTask.values()) {
    expect(v).toEqual({ tag: "ready" });
    expect(isRootOccupant(v)).toBe(false);
  }
});

test("fn-954 alloc terminates on exhausted ready work (N greater than ready count)", () => {
  // N=5 but only 2 ready tasks across 2 epics on /r → both kept, no spin, no
  // throw. Guards the fill-loop termination on exhausted queues.
  const e1 = makeStackEpic("fn-1-a", 1, "/r", 1).epic;
  const e2 = makeStackEpic("fn-2-b", 2, "/r", 1).epic;
  const snap = runWithN([e1, e2], 5);
  expect(snap.perTask.get("fn-1-a.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-2-b.1")).toEqual({ tag: "ready" });
});

// ---------------------------------------------------------------------------
// fn-959 — worktree-mode LANE re-key of the allocator (task .5). The allocator
// keys on the derived lane worktree path instead of `effectiveRoot`, so each
// worktree is a CAP-1 lane (regardless of max_concurrent_per_root) and parallel
// sibling lanes in ONE repo (even ONE epic) dispatch concurrently. OFF mode (an
// empty lane map) is byte-identical to today.
// ---------------------------------------------------------------------------

// Run `computeReadiness` with the trailing worktree lane-key map.
function runWithLanes(
  epics: Epic[],
  n: number,
  laneKeyById: ReadonlyMap<string, string>,
  eligible: Set<string> | undefined = undefined,
) {
  return computeReadiness(
    epics,
    new Map(),
    [],
    new Map(),
    Number.NEGATIVE_INFINITY,
    [],
    eligible,
    new Set<string>(),
    n,
    laneKeyById,
  );
}

test("fn-959 OFF byte-identical: an EMPTY lane map keys exactly as today (no behavior change)", () => {
  // Same fixture as the N=1 equivalence gate. An explicit empty lane map MUST be
  // indistinguishable from passing no lane arg at all — proves OFF mode is
  // byte-identical (the whole rollout-safety contract).
  const a = makeTask({ task_id: "fn-1-foo.1", target_repo: "/r" });
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/r",
    tasks: [a],
  });
  const b = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
    target_repo: "/r",
  });
  const e2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/r",
    tasks: [b],
  });
  const off = runWithN([e1, e2], 1);
  const empty = runWithLanes([e1, e2], 1, new Map());
  expect([...empty.perTask]).toEqual([...off.perTask]);
  // Even at N=3 (round-robin path) the empty map changes nothing.
  const off3 = runWithN([e1, e2], 3);
  const empty3 = runWithLanes([e1, e2], 3, new Map());
  expect([...empty3.perTask]).toEqual([...off3.perTask]);
});

test("fn-959 cap-1 per lane: two ready tasks on the SAME lane → only the first stays ready (even at N=5)", () => {
  // Two tasks keyed to the SAME lane path. A worktree index holds one agent; the
  // second MUST be demoted regardless of max_concurrent_per_root. (In real DAGs a
  // shared lane is a linear chain where the downstream isn't ready until the
  // upstream is done — this drives the invariant directly.)
  const t1 = makeTask({ task_id: "fn-1-foo.1", task_number: 1 });
  const t2 = makeTask({ task_id: "fn-1-foo.2", task_number: 2 });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo",
    tasks: [t1, t2],
  });
  const lane = worktreePathFor("/repo", "keeper/epic/fn-1-foo");
  const laneKeyById = new Map<string, string>([
    ["fn-1-foo.1", lane],
    ["fn-1-foo.2", lane],
  ]);
  const snap = runWithLanes([epic], 5, laneKeyById);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-1-foo.2")?.tag).toBe("blocked");
});

test("fn-959 parallel sibling lanes in ONE epic run concurrently (the whole point)", () => {
  // Fan-out P(done) → {A, B}. A inherits the base lane, B forks a rib → DISTINCT
  // lane paths. Both are ready (P done). Under today's effectiveRoot keying they
  // share the epic's one root and the per-epic mutex would keep only ONE; under
  // the lane re-key they are distinct cap-1 lanes → BOTH dispatch, even at N=1.
  const p = makeTask({
    task_id: "P",
    epic_id: "fn-1-foo",
    task_number: 1,
    worker_phase: "done",
    runtime_status: "done",
  });
  const a = makeTask({
    task_id: "A",
    epic_id: "fn-1-foo",
    task_number: 2,
    depends_on: ["P"],
  });
  const b = makeTask({
    task_id: "B",
    epic_id: "fn-1-foo",
    task_number: 3,
    depends_on: ["P"],
  });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo",
    tasks: [p, a, b],
  });
  // Sanity: under today's keying (N=1, no lanes) the per-epic mutex keeps only
  // one of A/B ready.
  const off = runWithN([epic], 1);
  const offReady = ["A", "B"].filter(
    (id) => off.perTask.get(id)?.tag === "ready",
  );
  expect(offReady.length).toBe(1);
  // With the lane re-key (gate-built off the real plan), A and B are distinct
  // lanes → both ready at N=1.
  const laneKeyById = laneKeysFor([epic]);
  const snap = runWithLanes([epic], 1, laneKeyById);
  expect(snap.perTask.get("A")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("B")).toEqual({ tag: "ready" });
});

test("fn-959 gate↔dispatch symmetry: prepareWorktreeGeometry maps each task to its plan's worktree path + epic to base", () => {
  // The gate and the dispatch-side geometry pass MUST derive the SAME lanes — they
  // now share ONE `prepareWorktreeGeometry` pass. Pin its `laneKeyById` to
  // `deriveWorktreePlan` directly so a future drift in either is caught.
  const p = makeTask({ task_id: "P", epic_id: "fn-1-foo", task_number: 1 });
  const a = makeTask({
    task_id: "A",
    epic_id: "fn-1-foo",
    task_number: 2,
    depends_on: ["P"],
  });
  const b = makeTask({
    task_id: "B",
    epic_id: "fn-1-foo",
    task_number: 3,
    depends_on: ["P"],
  });
  const j = makeTask({
    task_id: "J",
    epic_id: "fn-1-foo",
    task_number: 4,
    depends_on: ["A", "B"],
  });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo",
    tasks: [p, a, b, j],
  });
  const lanes = laneKeysFor([epic]);
  const plan = deriveWorktreePlan("fn-1-foo", "/repo", epic.tasks);
  const byNode = new Map(plan.assignments.map((x) => [x.nodeId, x]));
  for (const id of ["P", "A", "B", "J"]) {
    expect(lanes.get(id)).toBe(byNode.get(id)?.worktreePath);
  }
  // The close row (keyed by epic id at the gate) pins to the BASE lane.
  expect(lanes.get("fn-1-foo")).toBe(plan.baseWorktreePath);
  // P/A/J share the base lane; B is its own rib — distinct keys.
  expect(lanes.get("A")).toBe(lanes.get("P"));
  expect(lanes.get("J")).toBe(lanes.get("P"));
  expect(lanes.get("B")).not.toBe(lanes.get("P"));
});

test("fn-959/fn-978 prepareWorktreeGeometry: a MULTI-REPO epic is left un-keyed (rejected at dispatch, never lane-keyed)", () => {
  // Two tasks resolving to different repos → worktree mode rejects the epic for
  // v1. The gate `laneKeyById` must emit NO entries for it (the rows fall through
  // to effectiveRoot at the gate; the dispatch pass stamps the sticky reject).
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    task_number: 1,
    target_repo: "/repo-a",
  });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    epic_id: "fn-1-foo",
    task_number: 2,
    target_repo: "/repo-b",
  });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo-a",
    tasks: [t1, t2],
  });
  const lanes = laneKeysFor([epic]);
  expect(lanes.size).toBe(0);
});

test("fn-959 prepareWorktreeGeometry: a cyclic DAG is skipped (no throw at the gate; rows fall through)", () => {
  // A depends_on cycle makes deriveWorktreePlan throw. The gate-side `laneKeyById`
  // must swallow it and leave the epic un-keyed (the dispatch geometry pass
  // re-throws for the cycle backstop; no launch is ever emitted, so the gate
  // verdict is moot). The build MUST NOT throw and abort the whole cycle's gate.
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    task_number: 1,
    depends_on: ["fn-1-foo.2"],
  });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    epic_id: "fn-1-foo",
    task_number: 2,
    depends_on: ["fn-1-foo.1"],
  });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo",
    tasks: [t1, t2],
  });
  expect(() => laneKeysFor([epic])).not.toThrow();
  expect(laneKeysFor([epic]).size).toBe(0);
});

test("fn-959 distinct sibling lanes both cap-1 at N=5 (parallel, not stacked)", () => {
  // Two independent roots in one epic on /repo: R1 inherits base, R2 forks a rib.
  // Both ready, N=5. Under the lane re-key each is its OWN cap-1 lane → BOTH
  // dispatch (parallelism), and neither lane could ever stack a 2nd (cap-1).
  const r1 = makeTask({ task_id: "R1", epic_id: "fn-1-foo", task_number: 1 });
  const r2 = makeTask({ task_id: "R2", epic_id: "fn-1-foo", task_number: 2 });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo",
    tasks: [r1, r2],
  });
  const lanes = laneKeysFor([epic]);
  // Distinct lanes.
  expect(lanes.get("R1")).not.toBe(lanes.get("R2"));
  const snap = runWithLanes([epic], 5, lanes);
  expect(snap.perTask.get("R1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("R2")).toEqual({ tag: "ready" });
});

// ---------------------------------------------------------------------------
// fn-1013 — worktree-DISABLED repos. The producer keys EVERY task id + the epic
// id to the BARE resolved toplevel (one shared key, NOT per-lane paths), so an
// all-disabled cycle serializes one worker per repo on the shared checkout. This
// is THE load-bearing safety invariant: an empty laneKeyById would fall through
// to the N>1 round-robin and run multiple workers in ONE shared checkout.
// ---------------------------------------------------------------------------

test("fn-1013 all-disabled cycle: two ready tasks keyed on the BARE toplevel → cap-1 per repo even at max_concurrent_per_root=5", () => {
  // The disabled-repo geometry: both tasks (and the epic/close id) map to the
  // SAME bare toplevel. At N=5 the lane-keyed cap-1 mutex MUST keep only ONE
  // ready — never the N>1 round-robin (two workers in one shared checkout).
  const t1 = makeTask({ task_id: "fn-1-foo.1", task_number: 1 });
  const t2 = makeTask({ task_id: "fn-1-foo.2", task_number: 2 });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo",
    tasks: [t1, t2],
  });
  const laneKeyById = new Map<string, string>([
    ["fn-1-foo.1", "/repo"],
    ["fn-1-foo.2", "/repo"],
    ["fn-1-foo", "/repo"], // the close row keys on the toplevel too
  ]);
  const snap = runWithLanes([epic], 5, laneKeyById);
  const ready = ["fn-1-foo.1", "fn-1-foo.2"].filter(
    (id) => snap.perTask.get(id)?.tag === "ready",
  );
  expect(ready.length).toBe(1);
});

test("fn-1013 all-disabled cycle: two DIFFERING raw roots resolving to ONE toplevel collapse to a single cap-1 key (never parallelized)", () => {
  // Two tasks with DISTINCT raw effective roots that the disabled geometry keys
  // to the same toplevel. Without lane keys the differing raw roots are distinct
  // effectiveRoots → at N=5 the round-robin would let BOTH dispatch (the
  // corruption path). The bare-toplevel lane key collapses them to ONE cap-1 key.
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    task_number: 1,
    target_repo: "/repo/a",
  });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    target_repo: "/repo/b",
  });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo",
    tasks: [t1, t2],
  });
  // Sanity: WITHOUT lane keys, the differing raw roots parallelize at N=5.
  const off = runWithN([epic], 5);
  const offReady = ["fn-1-foo.1", "fn-1-foo.2"].filter(
    (id) => off.perTask.get(id)?.tag === "ready",
  );
  expect(offReady.length).toBe(2);
  // With the bare-toplevel lane key, the two raw roots collapse to ONE cap-1 key.
  const laneKeyById = new Map<string, string>([
    ["fn-1-foo.1", "/repo"],
    ["fn-1-foo.2", "/repo"],
    ["fn-1-foo", "/repo"],
  ]);
  const snap = runWithLanes([epic], 5, laneKeyById);
  const ready = ["fn-1-foo.1", "fn-1-foo.2"].filter(
    (id) => snap.perTask.get(id)?.tag === "ready",
  );
  expect(ready.length).toBe(1);
});

test("fn-719: live worker monitor past soft TTL (within hard ceiling) → running:monitor-stale, still occupies", () => {
  // updated_at=1000, now=1700 → age=700 > MONITOR_STALENESS_SEC(600), and
  // 700 < MONITOR_RELEASE_SEC(1800). Surfaces `monitor-stale` for human
  // visibility but STILL occupies the mutex (no auto-release until the hard
  // ceiling) — same correctness-over-throughput stance as `sub-agent-stale`.
  const task = makeTask({
    worker_phase: "done",
    jobs: [
      makeEmbeddedJob({
        state: "stopped",
        has_live_worker_monitor: true,
        updated_at: 1000,
      }),
    ],
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = runWithNow([epic], [], 1700);
  expect(snap.perTask.get(task.task_id)).toEqual(
    running({ kind: "monitor-stale" }),
  );
});

test("fn-719: live worker monitor past hard ceiling → slot RELEASED (collapses to completed)", () => {
  // updated_at=1000, now=3000 → age=2000 > MONITOR_RELEASE_SEC(1800). The
  // hard ceiling fires: the monitor fact NO LONGER occupies, so predicate 1
  // is free to collapse the done+approved task to `completed` and free the
  // mutex. An abandoned session can't wedge the slot forever.
  const task = makeTask({
    worker_phase: "done",
    jobs: [
      makeEmbeddedJob({
        state: "stopped",
        has_live_worker_monitor: true,
        updated_at: 1000,
      }),
    ],
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = runWithNow([epic], [], 3000);
  expect(snap.perTask.get(task.task_id)).toEqual({ tag: "completed" });
});

test("fn-719: a fresh live monitor alongside a stale one keeps the task at monitor-running (every, not any)", () => {
  // Two embedded work jobs both carrying the monitor fact: one stale
  // (updated_at=1000, age=700 > soft TTL), one fresh (updated_at=1690,
  // age=10). `allLiveMonitorsAreStale` is "every", so a single fresh
  // monitor keeps the verdict at `monitor-running` — the slot is genuinely
  // live somewhere.
  const task = makeTask({
    worker_phase: "done",
    jobs: [
      makeEmbeddedJob({
        job_id: "worker-stale",
        state: "stopped",
        has_live_worker_monitor: true,
        updated_at: 1000,
      }),
      makeEmbeddedJob({
        job_id: "worker-fresh",
        state: "stopped",
        has_live_worker_monitor: true,
        updated_at: 1690,
      }),
    ],
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = runWithNow([epic], [], 1700);
  expect(snap.perTask.get(task.task_id)).toEqual(
    running({ kind: "monitor-running" }),
  );
});

test("fn-719: a still-working job outranks the monitor fact (predicate 5 wins over 6.6)", () => {
  // A genuinely-`working` embedded job already holds `job-running` at
  // predicate 5 (above 6.6). The monitor fact only matters once the main
  // job has Stopped — this pins the predicate ordering.
  const task = makeTask({
    worker_phase: "done",
    jobs: [
      makeEmbeddedJob({ state: "working", has_live_worker_monitor: true }),
    ],
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual(
    running({ kind: "job-running" }),
  );
});

// fn-756: the close-row predicate-6.6 live-monitor case for a `status:done`
// epic is REMOVED. The old test relied on the `status:done + approval:pending`
// window bypassing close-row predicate 1 to reach the 6.6 liveness check. With
// the approval gate gone, a `status:done` close row is `completed` at predicate
// 1 — a still-live closer pane is spared by the completion-reap's `exited ===
// false` live-veto, so no mutex-holding monitor verdict is needed.

test("predicate 1 wins over 2 (epic-not-validated)", () => {
  const task = makeTask({ worker_phase: "done" });
  const epic = makeEpic({ tasks: [task], last_validated_at: null });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual({ tag: "completed" });
});

// ---------------------------------------------------------------------------
// fn-712: epic-not-materialized — the EARLIEST blocked predicate on both
// the per-task and per-close-row paths. `epic.status === null` ⇔ no
// EpicSnapshot has folded yet (the scaffold-commit shell row). Mirrors the
// board's `status IS NOT NULL` `default_visible` gate — one shared notion of
// "this epic is real yet" across both surfaces.
// ---------------------------------------------------------------------------

test("fn-712 perTask: status:null epic → blocked:epic-not-materialized", () => {
  const task = makeTask({});
  const epic = makeEpic({ tasks: [task], status: null });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual(
    blocked({ kind: "epic-not-materialized" }),
  );
});

test("fn-712 perCloseRow: status:null epic → blocked:epic-not-materialized", () => {
  const epic = makeEpic({ status: null });
  const snap = run([epic]);
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    blocked({ kind: "epic-not-materialized" }),
  );
});

test("fn-712 perTask: status:'open' unblocks the materialized gate (falls through)", () => {
  // A materialized but UNvalidated epic falls past epic-not-materialized to
  // the next predicate — epic-not-validated — proving the materialized gate
  // only fires on status:null, not on every not-yet-ready epic.
  const task = makeTask({});
  const epic = makeEpic({
    tasks: [task],
    status: "open",
    last_validated_at: null,
  });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual(
    blocked({ kind: "epic-not-validated" }),
  );
});

test("fn-712 perTask: epic-not-materialized ranks ABOVE epic-not-validated", () => {
  // Both predicates would fire (status null AND unvalidated); the earlier
  // materialized gate wins — a not-yet-materialized epic reports the more
  // specific "not real yet" reason, not the validation reason.
  const task = makeTask({});
  const epic = makeEpic({
    tasks: [task],
    status: null,
    last_validated_at: null,
  });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual(
    blocked({ kind: "epic-not-materialized" }),
  );
});

test("fn-712 perCloseRow: epic-not-materialized ranks ABOVE epic-not-validated", () => {
  const epic = makeEpic({ status: null, last_validated_at: null });
  const snap = run([epic]);
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    blocked({ kind: "epic-not-materialized" }),
  );
});

// fn-756: predicate 4 (own-approval-rejected → job-rejected) is REMOVED. The
// approval enum no longer gates completion, so a `done` task is `completed`
// regardless of any (now-ignored) `approval` value. The two former predicate-4
// tests are deleted.

test("fn-756: predicate 5 (own-progress-main) still holds a worker-done task at job-running", () => {
  // A worker-done task whose embedded job is still `working` must NOT collapse
  // to `completed` (predicate 1 ANDs in the no-live-work clauses); it reports
  // `job-running` until the session winds down. This is the race guard that
  // keeps the per-epic/per-root mutexes held while the worker is alive.
  const task = makeTask({
    worker_phase: "done",
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

test("fn-756: a worker-done task with an idle session is COMPLETED (no approval gate)", () => {
  // Pre-fn-756 this row (worker done, embedded job stopped, no sub-agents,
  // approval pending) fired predicate 7 → `job-pending`. fn-756 collapsed
  // predicate 1 to `worker_phase === "done"` alone, so the idle worker-done
  // row is now terminal `completed` — the approval enum is ignored.
  const task = makeTask({
    worker_phase: "done",
    jobs: [makeEmbeddedJob({ state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [task] });
  const snap = run([epic]);
  expect(snap.perTask.get(task.task_id)).toEqual({ tag: "completed" });
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
// fn-756: the per-epic git-occupancy tests are REMOVED. They relied on a
// `done+pending+dirty` task rendering predicate 6.5 (`git-uncommitted`/
// `git-orphans`) and holding the per-epic mutex. With predicate 6.5 gone, a
// worker-done task is `completed` (which does NOT occupy), so a ready sibling
// simply wins the slot — no git-derived occupancy remains.

// fn-756: a not-done task in a dirty repo is `ready` (the git lift is gone, so
// git state never produces a verdict on any row).
test("a not-done task in a dirty repo is ready (no git lift)", () => {
  const notDone = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "open",
    target_repo: "/r",
  });
  const epic = makeEpic({ tasks: [notDone], project_dir: "/r" });
  const gitMap = new Map([
    ["/r", { dirty_count: 9, unattributed_to_live_count: 9 }],
  ]);
  const snap = run([epic], new Map(), [], gitMap);
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
// fn-756: the per-root git-occupancy tests are REMOVED. They relied on a
// `done+pending+dirty` task (predicate 6.5 `git-uncommitted`/`git-orphans`) or a
// quiescent done-but-unapproved epic's close-row git verdict claiming the root.
// With predicate 6.5 gone and a `status:done` epic collapsing to `completed`,
// neither verdict exists — a completed row never claims a root.

// fn-756: a COMPLETED close row (status=done) does NOT claim the root — a
// sibling epic's ready task on the same root stays ready. (Was: a quiescent
// done+pending close row rendered `job-pending`, also a non-occupant.)
test("per-root: a completed close row does NOT claim the root → cross-epic ready task stays ready", () => {
  const e1t1 = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    target_repo: "/r",
  });
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/r",
    status: "done",
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
  // epic 1's close row is `completed` (status=done) → NOT a root occupant.
  expect(snap.perCloseRow.get("fn-1-foo")).toEqual({ tag: "completed" });
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

test("epic header rollup: a blocked close (epic-not-validated) → header inherits it", () => {
  // fn-756: with the approval enum gone there's no `job-rejected`/`job-pending`
  // close-row block. A non-validated epic blocks BOTH its task and its close
  // row with `epic-not-validated`; the header inherits that reason.
  const t = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
  });
  const epic = makeEpic({ tasks: [t], last_validated_at: null });
  const snap = run([epic]);
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual(
    blocked({ kind: "epic-not-validated" }),
  );
  expect(snap.perEpic.get(epic.epic_id)).toEqual(
    blocked({ kind: "epic-not-validated" }),
  );
});

test("epic header rollup: completed close → completed header", () => {
  const t = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
  });
  const epic = makeEpic({
    tasks: [t],
    status: "done",
  });
  const snap = run([epic]);
  expect(snap.perEpic.get(epic.epic_id)).toEqual({ tag: "completed" });
});

test("epic header rollup: mixed states — reason from FIRST non-completed in traversal", () => {
  // fn-756: the FIRST non-completed (and non-ready) task in traversal drives
  // the header. Task 1 is completed (worker-done); task 2 is blocked on a
  // dangling epic dep; task 3 is also blocked on the same dangling dep (no
  // ready row exists to elevate the header to `ready`). The rollup picks task
  // 2's `dep-on-epic-dangling` — the first non-completed in traversal order.
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
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
  const epic = makeEpic({
    tasks: [t1, t2, t3],
    depends_on_epics: ["fn-99-ghost"],
    resolved_epic_deps: [makeResolvedDep({ dep_token: "fn-99-ghost" })],
  });
  const snap = run([epic]);
  expect(snap.perEpic.get(epic.epic_id)).toEqual(
    blocked({ kind: "dep-on-epic-dangling", upstream: "fn-99-ghost" }),
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
  // string the plan file carries).
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

test("subagent_invocations: FINISHED ok (non-null duration_ms) → ignored", () => {
  // fn-1008: predicate 6 now keys on the canonical open-turn predicate
  // (`isOpenTurnRow`), so the discriminator is `duration_ms`, NOT a bare status
  // check. A CLOSED `ok` sub (non-null `duration_ms`) is done — ignored — even
  // though its status is `ok`. (The open-`ok` case is covered separately below.)
  const t = makeTask({
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [t] });
  const subs = [
    makeSub({ job_id: "worker-1", status: "ok", duration_ms: 5000 }),
  ];
  const snap = run([epic], new Map(), subs);
  expect(snap.perTask.get(t.task_id)).toEqual({ tag: "ready" });
});

test("subagent_invocations: OPEN ok (NULL duration_ms) counts as in-flight, no time bound", () => {
  // fn-1008: PostToolUse:Agent flips a still-open turn to `ok` BEFORE its
  // SubagentStop lands, so an `ok` row with NULL `duration_ms` is a backgrounded
  // sub still in flight — predicate 6 MUST fire (else readiness re-dispatches a
  // live worker). No `now` is threaded: the readiness layer is deliberately
  // UNBOUNDED, so even an ancient open `ok` (ts far in the past) still blocks.
  const t = makeTask({
    worker_phase: "done",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [t] });
  const subs = [
    makeSub({ job_id: "worker-1", status: "ok", duration_ms: null, ts: 1 }),
  ];
  const snap = run([epic], new Map(), subs);
  expect(snap.perTask.get(t.task_id)).toEqual(
    running({ kind: "sub-agent-running" }),
  );
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
// no planner serialization gate — a working planner/refiner link does NOT
// hold the epic's tasks or close row off `ready`. The validation gate
// (predicate 2) is the sole guard; once an epic is validated its rows read
// through even while the planner session is still `working`.
// ---------------------------------------------------------------------------

test("a working planner/refiner link does NOT block a validated epic's task — it reads ready", () => {
  const t = makeTask({ task_id: "fn-1-foo.1", jobs: [] });
  const epic = makeEpic({
    tasks: [t],
    job_links: [
      makeLink({ kind: "creator", job_id: "planner-job", state: "working" }),
    ],
  });
  const snap = run([epic]);
  expect(snap.perTask.get(t.task_id)).toEqual({ tag: "ready" });
});

test("a working planner/refiner link does NOT block a validated epic's close row — it reads ready", () => {
  // One completed task (so the close row passes the epic-no-tasks /
  // dep-on-task-synth-close gates) and a still-working planner link. The
  // close row reads `ready` — the planner no longer holds it at `running`.
  const t = makeTask({ task_id: "fn-1-foo.1", worker_phase: "done" });
  const epic = makeEpic({
    tasks: [t],
    jobs: [],
    job_links: [
      makeLink({ kind: "creator", job_id: "planner-job", state: "working" }),
    ],
  });
  const snap = run([epic]);
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual({ tag: "ready" });
});

test("a working planner link on an UNvalidated epic still blocks — via the validation gate, not a planner gate", () => {
  const t = makeTask({ task_id: "fn-1-foo.1", jobs: [] });
  const epic = makeEpic({
    tasks: [t],
    last_validated_at: null,
    job_links: [
      makeLink({ kind: "creator", job_id: "planner-job", state: "working" }),
    ],
  });
  const snap = run([epic]);
  expect(snap.perTask.get(t.task_id)).toEqual(
    blocked({ kind: "epic-not-validated" }),
  );
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
  // a `running` kind or (fn-756) the sole blocked occupant `dispatch-pending`
  // — claims the epic slot regardless of iteration order, so the later ready
  // row gets demoted. Dependency / admin / repo-state / mutex-synthesized
  // blocks do NOT claim in pass-1 (see the negative-control test below for
  // `dep-on-task`).
  const t1 = makeTask({ task_id: "fn-1-foo.1" });
  const t2 = makeTask({ task_id: "fn-1-foo.2", task_number: 2 });
  const epic = makeEpic({ tasks: [t1, t2] });
  const perTask = new Map<string, Verdict>([
    ["fn-1-foo.1", blocked({ kind: "dispatch-pending" })],
    ["fn-1-foo.2", { tag: "ready" }],
  ]);
  applySingleTaskPerEpicMutex([epic], perTask);
  expect(perTask.get("fn-1-foo.1")).toEqual(
    blocked({ kind: "dispatch-pending" }),
  );
  expect(perTask.get("fn-1-foo.2")).toEqual(
    blocked({ kind: "single-task-per-epic" }),
  );
});

test("applySingleTaskPerEpicMutex: dep-on-task row does NOT claim the epic slot (negative control)", () => {
  // Negative control for the pass-1 whitelist. A `dep-on-task` block is
  // NOT an `isLiveWorkOccupant` kind (the `running` kinds + fn-756's sole
  // blocked occupant `dispatch-pending`) — it represents waiting, not
  // concurrent worker activity. So a later ready sibling must
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
  // epic B gets demoted. Dependency / admin / repo-state / mutex-synthesized
  // blocks do NOT claim in pass-1 (see the negative-control test below for
  // `dep-on-task`).
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
  });
  const epic = makeEpic({ tasks: [t] });
  const snap = run([epic]);
  expect(snap.perCloseRow.get(epic.epic_id)).toEqual({ tag: "ready" });
});

test("close row: any non-completed task → dep-on-task with FIRST non-completed id", () => {
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
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
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    worker_phase: "done",
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
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const t2 = makeTask({
    task_id: "fn-1-foo.2",
    task_number: 2,
    worker_phase: "open",
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

// ---------------------------------------------------------------------------
// fn-721 — dispatch-pending occupant (launch → SessionStart blind window)
// ---------------------------------------------------------------------------

// Variant that threads the new `pendingDispatches` param into
// `computeReadiness` (appended after `now`). The other inputs default. Each
// literal may omit `dispatched_at`; it defaults to `0` here, which under the
// `-Infinity` `now` below is never stale, so the staleness backstop stays inert
// and these occupancy proofs are unaffected by it.
function runWithPending(
  epics: Epic[],
  pendingDispatches: Array<
    Omit<PendingDispatch, "dispatched_at"> &
      Partial<Pick<PendingDispatch, "dispatched_at">>
  >,
) {
  return computeReadiness(
    epics,
    new Map(),
    [],
    new Map(),
    Number.NEGATIVE_INFINITY,
    pendingDispatches.map((pd) => ({ dispatched_at: 0, ...pd })),
  );
}

test("dispatch-pending: a work:: pending row demotes a same-epic ready sibling", () => {
  // The core occupancy proof. A `work::fn-1-foo.1` pending dispatch (a worker
  // launched but not yet SessionStart-bound) sets `dispatch-pending` on task
  // 1; that occupant claims the per-epic mutex via `isLiveWorkOccupant`, so
  // the same-epic ready sibling task 2 is demoted to single-task-per-epic.
  const t1 = makeTask({ task_id: "fn-1-foo.1" });
  const t2 = makeTask({ task_id: "fn-1-foo.2", task_number: 2 });
  const epic = makeEpic({ tasks: [t1, t2] });
  const snap = runWithPending(
    [epic],
    [{ verb: "work", id: "fn-1-foo.1", dir: "/repo" }],
  );
  expect(snap.perTask.get("fn-1-foo.1")).toEqual(
    blocked({ kind: "dispatch-pending" }),
  );
  expect(snap.perTask.get("fn-1-foo.2")).toEqual(
    blocked({ kind: "single-task-per-epic" }),
  );
});

test("dispatch-pending: a work:: pending row demotes a same-ROOT sibling in another epic", () => {
  // Per-root occupancy proof. The pending row's task occupies root /r via the
  // per-row `dispatch-pending` verdict (auto-covered by `isRootOccupant`'s
  // delegation to `isLiveWorkOccupant`), so a ready sibling in a DIFFERENT
  // epic on the same root is demoted to single-task-per-root.
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
  const snap = runWithPending(
    [e1, e2],
    [{ verb: "work", id: "fn-1-foo.1", dir: "/r" }],
  );
  expect(snap.perTask.get("fn-1-foo.1")).toEqual(
    blocked({ kind: "dispatch-pending" }),
  );
  expect(snap.perTask.get("fn-2-bar.1")).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

test("dispatch-pending: demotion lifts when the pending row discharges (empty set)", () => {
  // Discharge proof: with the same fixtures but NO pending row (the
  // `SessionStart` bind / DispatchFailed / DispatchExpired discharged it),
  // task 1 is the first ready row and wins, task 2 loses the per-epic slot
  // the ORDINARY way — neither carries `dispatch-pending`.
  const t1 = makeTask({ task_id: "fn-1-foo.1" });
  const t2 = makeTask({ task_id: "fn-1-foo.2", task_number: 2 });
  const epic = makeEpic({ tasks: [t1, t2] });
  const snap = runWithPending([epic], []);
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
  expect(snap.perTask.get("fn-1-foo.2")).toEqual(
    blocked({ kind: "single-task-per-epic" }),
  );
});

test("dispatch-pending: a close:: pending row demotes a same-root ready task in another epic", () => {
  // Close-row arm: a `close::fn-1-foo` pending dispatch sets `dispatch-pending`
  // on the close row (every task already completed so the close row would be
  // ready), occupying root /r so a ready task in a different epic on the same
  // root is demoted.
  const e1t1 = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    jobs: [makeEmbeddedJob({ job_id: "w1", state: "ended" })],
  });
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
  const snap = runWithPending(
    [e1, e2],
    [{ verb: "close", id: "fn-1-foo", dir: "/r" }],
  );
  expect(snap.perCloseRow.get("fn-1-foo")).toEqual(
    blocked({ kind: "dispatch-pending" }),
  );
  expect(snap.perTask.get("fn-2-bar.1")).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

test("dispatch-pending: a real running verdict still WINS over dispatch-pending (rank check)", () => {
  // Rank guard (the fn-700 anti-pattern): dispatch-pending is set at a LATE
  // per-row rank, so a row that is genuinely `running` (a working embedded
  // job) keeps `job-running` even when a pending row also names it. The truer
  // state is never masked.
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    jobs: [makeEmbeddedJob({ job_id: "w1", state: "working" })],
  });
  const epic = makeEpic({ tasks: [t1] });
  const snap = runWithPending(
    [epic],
    [{ verb: "work", id: "fn-1-foo.1", dir: "/repo" }],
  );
  expect(snap.perTask.get("fn-1-foo.1")).toEqual(
    running({ kind: "job-running" }),
  );
});

test("dispatch-pending: epic-not-materialized still WINS over dispatch-pending (rank check)", () => {
  // A NULL-status epic (no EpicSnapshot folded yet) must keep
  // `epic-not-materialized` even when a pending row names its task — the
  // structural-not-ready verdict outranks the late dispatch-pending rank.
  const t1 = makeTask({ task_id: "fn-1-foo.1" });
  const epic = makeEpic({ tasks: [t1], status: null });
  const snap = runWithPending(
    [epic],
    [{ verb: "work", id: "fn-1-foo.1", dir: "/repo" }],
  );
  expect(snap.perTask.get("fn-1-foo.1")).toEqual(
    blocked({ kind: "epic-not-materialized" }),
  );
});

test("dispatch-pending root-fallback: an UNMATCHED pending row occupies its dir root", () => {
  // Decision-b proof: a pending row whose `verb::id` matches NO task or close
  // row (launch→materialize lag or deleted target) still occupies its own
  // `dir` root, so a ready sibling in an existing epic on that root is demoted
  // — without any per-row verdict to attach to.
  const t1 = makeTask({ task_id: "fn-1-foo.1", target_repo: "/r" });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/r",
    tasks: [t1],
  });
  const snap = runWithPending(
    [epic],
    // No `fn-9-ghost.1` task exists in the snapshot.
    [{ verb: "work", id: "fn-9-ghost.1", dir: "/r" }],
  );
  expect(snap.perTask.get("fn-1-foo.1")).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

test("dispatch-pending root-fallback: a null-dir unmatched row degrades without crash", () => {
  // The unmatched row has a null `dir`, so it contributes NO root occupant —
  // the existing ready task is unaffected and nothing throws.
  const t1 = makeTask({ task_id: "fn-1-foo.1", target_repo: "/r" });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/r",
    tasks: [t1],
  });
  const snap = runWithPending(
    [epic],
    [{ verb: "work", id: "fn-9-ghost.1", dir: null }],
  );
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
});

test("dispatch-pending root-fallback: a MATCHED row does not double-count into the root-fallback", () => {
  // A pending row that DID match a task carries its occupancy via the per-row
  // `dispatch-pending` verdict; it must NOT also feed the root-fallback. The
  // dir column on a matched row is irrelevant — point it at an unrelated root
  // and assert a ready task on THAT other root is NOT demoted.
  const e1t1 = makeTask({ task_id: "fn-1-foo.1", target_repo: "/r" });
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/r",
    tasks: [e1t1],
  });
  const e2t1 = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
    target_repo: "/other",
  });
  const e2 = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/other",
    tasks: [e2t1],
  });
  const snap = runWithPending(
    [e1, e2],
    // Matched row for fn-1-foo.1 but with a stale `dir` of /other. Since it
    // matched, the root-fallback must NOT seed /other, so fn-2-bar.1 stays
    // ready.
    [{ verb: "work", id: "fn-1-foo.1", dir: "/other" }],
  );
  expect(snap.perTask.get("fn-1-foo.1")).toEqual(
    blocked({ kind: "dispatch-pending" }),
  );
  expect(snap.perTask.get("fn-2-bar.1")).toEqual({ tag: "ready" });
});

test("dispatch-pending: a dep-on-task row does NOT claim via the occupant (negative control)", () => {
  // Negative control: a task that is dep-blocked is NOT made an occupant by a
  // pending row — the dep verdict wins at its earlier rank, so the late
  // dispatch-pending branch never runs and the dep block (which is NOT an
  // `isLiveWorkOccupant`) does not claim the epic slot. A ready sibling stays
  // ready. (Autopilot would never launch against a dep-blocked row anyway;
  // this pins that the occupant is verdict-driven, not key-driven.)
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    depends_on: ["fn-1-foo.2"],
  });
  const t2 = makeTask({ task_id: "fn-1-foo.2", task_number: 2 });
  // Order tasks so t1 (dep-blocked) is evaluated; t2 is ready and should win
  // the slot. Place t2 first so it claims the slot in pass-2.
  const epic = makeEpic({ tasks: [t2, t1] });
  const snap = runWithPending(
    [epic],
    [{ verb: "work", id: "fn-1-foo.1", dir: "/repo" }],
  );
  expect(snap.perTask.get("fn-1-foo.1")).toEqual(
    blocked({ kind: "dep-on-task", upstream: "fn-1-foo.2" }),
  );
  expect(snap.perTask.get("fn-1-foo.2")).toEqual({ tag: "ready" });
});

test("dispatch-pending: formatPill renders the bracket pill", () => {
  expect(formatPill(blocked({ kind: "dispatch-pending" }))).toBe(
    "[blocked:dispatch-pending]",
  );
});

// Variant of `runWithPending` that injects an explicit `now` (unix seconds) so
// the stale-pending backstop (`PENDING_DISPATCH_STALE_CEILING_SEC`) can fire.
function runWithPendingAt(
  epics: Epic[],
  pendingDispatches: PendingDispatch[],
  now: number,
) {
  return computeReadiness(
    epics,
    new Map(),
    [],
    new Map(),
    now,
    pendingDispatches,
  );
}

test("dispatch-pending: a FRESH pending (within the hard ceiling) still occupies", () => {
  // now - dispatched_at = 100 < ceiling(240): the pending counts toward the
  // per-epic mutex, so the same-epic ready sibling is demoted — identical to
  // the default `-Infinity` behavior.
  const t1 = makeTask({ task_id: "fn-1-foo.1" });
  const t2 = makeTask({ task_id: "fn-1-foo.2", task_number: 2 });
  const epic = makeEpic({ tasks: [t1, t2] });
  const snap = runWithPendingAt(
    [epic],
    [{ verb: "work", id: "fn-1-foo.1", dir: "/repo", dispatched_at: 1000 }],
    1100,
  );
  expect(snap.perTask.get("fn-1-foo.1")).toEqual(
    blocked({ kind: "dispatch-pending" }),
  );
  expect(snap.perTask.get("fn-1-foo.2")).toEqual(
    blocked({ kind: "single-task-per-epic" }),
  );
});

test("dispatch-pending: a STALE pending (past the hard ceiling) does NOT occupy", () => {
  // now - dispatched_at = ceiling+1 > ceiling: the stale pending is excluded
  // from the verdict AND the mutex, so the task is NOT dispatch-pending and the
  // same-epic sibling is free to be picked by the base mutex (first ready wins).
  const t1 = makeTask({ task_id: "fn-1-foo.1" });
  const t2 = makeTask({ task_id: "fn-1-foo.2", task_number: 2 });
  const epic = makeEpic({ tasks: [t1, t2] });
  const dispatchedAt = 1000;
  const snap = runWithPendingAt(
    [epic],
    [
      {
        verb: "work",
        id: "fn-1-foo.1",
        dir: "/repo",
        dispatched_at: dispatchedAt,
      },
    ],
    dispatchedAt + PENDING_DISPATCH_STALE_CEILING_SEC + 1,
  );
  expect(snap.perTask.get("fn-1-foo.1")).not.toEqual(
    blocked({ kind: "dispatch-pending" }),
  );
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
});

test("dispatch-pending: a STALE unmatched pending does NOT seed the per-root mutex", () => {
  // The root-fallback backstop: an unmatched pending past the ceiling must not
  // hold its `dir` root, so a sibling epic on that same root stays ready.
  const e1t1 = makeTask({ task_id: "fn-1-foo.1" });
  const e1 = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [e1t1],
  });
  const dispatchedAt = 1000;
  const snap = runWithPendingAt(
    [e1],
    // Matches no snapshot row (a ghost id), so it would normally seed /repo as
    // a fallback root — but it's past the ceiling, so it's dropped entirely.
    [
      {
        verb: "work",
        id: "fn-9-ghost.1",
        dir: "/repo",
        dispatched_at: dispatchedAt,
      },
    ],
    dispatchedAt + PENDING_DISPATCH_STALE_CEILING_SEC + 1,
  );
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({ tag: "ready" });
});

test("PENDING_DISPATCH_STALE_CEILING_SEC is 2× the TTL (240s) — pure backstop, never a double-dispatch window", () => {
  // The ceiling must be distinctly longer than the 120s TTL + ~60s sweep
  // cadence so the 60s sweep always DELETEs the row before this exclusion fires.
  expect(PENDING_DISPATCH_STALE_CEILING_SEC).toBe(240);
});

// ---------------------------------------------------------------------------
// fn-905: PER-ROOT unseeded-git gate → force UNKNOWN only on the unseeded root's
// own rows; a seeded sibling root still dispatches.
// ---------------------------------------------------------------------------

test("fn-905: empty unseededRoots (default) → no gating (re-fold byte-identical)", () => {
  const t1 = makeTask({ task_id: "fn-1-foo.1", worker_phase: "open" });
  const t2 = makeTask({ task_id: "fn-1-foo.2", worker_phase: "open" });
  const epic = makeEpic({ project_dir: "/repo", tasks: [t1, t2] });
  // No trailing arg ⇔ empty set ⇔ today's "seeded" path: normal verdicts (at
  // least one ready).
  const seeded = computeReadiness(
    [epic],
    new Map(),
    [],
    new Map(),
    Number.NEGATIVE_INFINITY,
    [],
    undefined,
  );
  expect(seeded.perTask.get("fn-1-foo.1")).not.toEqual({
    tag: "blocked",
    reason: { kind: "unknown" },
  });
  // An explicit empty set is the same as omitting it.
  const seededExplicit = computeReadiness(
    [epic],
    new Map(),
    [],
    new Map(),
    Number.NEGATIVE_INFINITY,
    [],
    undefined,
    new Set<string>(),
  );
  expect(seededExplicit.perTask.get("fn-1-foo.1")).toEqual(
    seeded.perTask.get("fn-1-foo.1"),
  );
});

test("fn-905: an unseeded root forces UNKNOWN on its own task + close rows", () => {
  const t1 = makeTask({ task_id: "fn-1-foo.1", worker_phase: "open" });
  const t2 = makeTask({ task_id: "fn-1-foo.2", worker_phase: "open" });
  const epic = makeEpic({ project_dir: "/repo", tasks: [t1, t2] });
  const gated = computeReadiness(
    [epic],
    new Map(),
    [],
    new Map(),
    Number.NEGATIVE_INFINITY,
    [],
    undefined,
    new Set(["/repo"]),
  );
  expect(gated.perTask.get("fn-1-foo.1")).toEqual({
    tag: "blocked",
    reason: { kind: "unknown" },
  });
  expect(gated.perTask.get("fn-1-foo.2")).toEqual({
    tag: "blocked",
    reason: { kind: "unknown" },
  });
  expect(gated.perCloseRow.get("fn-1-foo")).toEqual({
    tag: "blocked",
    reason: { kind: "unknown" },
  });
  // The epic header rolls up to blocked too (no ready/running row left).
  expect(gated.perEpic.get("fn-1-foo")?.tag).toBe("blocked");
});

test("fn-905: an unseeded root blocks ONLY its own rows; a seeded sibling stays ready", () => {
  const epicA = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo-a",
    tasks: [makeTask({ task_id: "fn-1-foo.1", epic_id: "fn-1-foo" })],
  });
  const epicB = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/repo-b",
    tasks: [makeTask({ task_id: "fn-2-bar.1", epic_id: "fn-2-bar" })],
  });
  // Only /repo-a is unseeded → only its task is UNKNOWN; /repo-b stays ready.
  const snap = computeReadiness(
    [epicA, epicB],
    new Map(),
    [],
    new Map(),
    Number.NEGATIVE_INFINITY,
    [],
    undefined,
    new Set(["/repo-a"]),
  );
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({
    tag: "blocked",
    reason: { kind: "unknown" },
  });
  expect(snap.perTask.get("fn-2-bar.1")).toEqual({ tag: "ready" });
});

test("fn-905: a task's target_repo override is gated by its OWN root, not the epic's", () => {
  // Task overrides into /repo-task; the epic's own project_dir (/repo-epic) is
  // seeded but /repo-task is not → the task is gated, the close row is not.
  const epic = makeEpic({
    project_dir: "/repo-epic",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        worker_phase: "open",
        target_repo: "/repo-task",
      }),
    ],
  });
  const snap = computeReadiness(
    [epic],
    new Map(),
    [],
    new Map(),
    Number.NEGATIVE_INFINITY,
    [],
    undefined,
    new Set(["/repo-task"]),
  );
  expect(snap.perTask.get("fn-1-foo.1")).toEqual({
    tag: "blocked",
    reason: { kind: "unknown" },
  });
  // The close row keys on the epic's /repo-epic (seeded) → NOT gated.
  expect(snap.perCloseRow.get("fn-1-foo")).not.toEqual({
    tag: "blocked",
    reason: { kind: "unknown" },
  });
});

test("fn-905: a rootless row (no target_repo, no project_dir) is never gated", () => {
  const epic = makeEpic({
    project_dir: null,
    tasks: [makeTask({ task_id: "fn-1-foo.1", worker_phase: "open" })],
  });
  // A non-empty unseeded set must not touch the `""` rootless bucket.
  const snap = computeReadiness(
    [epic],
    new Map(),
    [],
    new Map(),
    Number.NEGATIVE_INFINITY,
    [],
    undefined,
    new Set(["/some-other-root"]),
  );
  expect(snap.perTask.get("fn-1-foo.1")).not.toEqual({
    tag: "blocked",
    reason: { kind: "unknown" },
  });
});

// ---------------------------------------------------------------------------
// fn-949: isEpicStarted — pure "has real worker activity touched this epic?"
// predicate behind Rule #1 (prefer the started epic).
// ---------------------------------------------------------------------------

test("isEpicStarted: fresh epic (no jobs, all-todo) is NOT started", () => {
  const epic = makeEpic({
    jobs: [],
    job_links: [],
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", runtime_status: "todo" }),
      makeTask({ task_id: "fn-1-foo.2", runtime_status: "todo" }),
    ],
  });
  expect(isEpicStarted(epic)).toBe(false);
});

test("isEpicStarted: resting worker_phase 'open' alone does NOT mark started", () => {
  // The resting `worker_phase` on a never-worked task shell is "open" (not
  // null) — counting it would mark every epic started and collapse the tiering.
  const epic = makeEpic({
    tasks: [makeTask({ task_id: "fn-1-foo.1", worker_phase: "open" })],
  });
  expect(isEpicStarted(epic)).toBe(false);
});

test("isEpicStarted: a plan-only epic-form job (no other activity) is NOT started", () => {
  // fn-957: every planned epic carries a stopped `plan::<ref>` planner job in
  // `epics.jobs[]` (a bare epic ref folds as kind=epic). Counting it collapsed
  // the started tier to a no-op, so a `plan`-verb-only epic must read unstarted.
  const epic = makeEpic({
    jobs: [makeEmbeddedJob({ plan_verb: "plan" })],
    job_links: [],
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", runtime_status: "todo" }),
      makeTask({ task_id: "fn-1-foo.2", runtime_status: "todo" }),
    ],
  });
  expect(isEpicStarted(epic)).toBe(false);
});

test("isEpicStarted: any non-plan epic-form job (close/approve) marks started", () => {
  for (const verb of ["close", "approve"]) {
    const epic = makeEpic({
      jobs: [makeEmbeddedJob({ plan_verb: verb })],
      tasks: [makeTask({ task_id: "fn-1-foo.1" })],
    });
    expect(isEpicStarted(epic)).toBe(true);
  }
});

test("isEpicStarted: a plan job alongside genuine activity still marks started", () => {
  // A planned-then-worked epic carries the planner job AND a real signal; the
  // plan-verb skip must not mask the close/task-job/runtime_status signals.
  const epic = makeEpic({
    jobs: [
      makeEmbeddedJob({ plan_verb: "plan" }),
      makeEmbeddedJob({ plan_verb: "close" }),
    ],
    tasks: [makeTask({ task_id: "fn-1-foo.1", runtime_status: "todo" })],
  });
  expect(isEpicStarted(epic)).toBe(true);
});

test("isEpicStarted: a job_links provenance entry alone does NOT mark started", () => {
  // `creator`/`refiner` links are plan-authoring provenance (the symmetric view
  // of the `plan` sessions the plan-verb skip already excludes), not worker
  // activity — a freshly planned, all-todo epic carries one yet is NOT started.
  for (const kind of ["creator", "refiner"] as const) {
    const epic = makeEpic({
      job_links: [makeLink({ kind, job_id: "planner-job" })],
      tasks: [makeTask({ task_id: "fn-1-foo.1", runtime_status: "todo" })],
    });
    expect(isEpicStarted(epic)).toBe(false);
  }
});

test("isEpicStarted: any task-form job marks started", () => {
  const epic = makeEpic({
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        jobs: [makeEmbeddedJob({ plan_verb: "work" })],
      }),
    ],
  });
  expect(isEpicStarted(epic)).toBe(true);
});

test("isEpicStarted: any task runtime_status off 'todo' marks started", () => {
  for (const rt of ["in_progress", "done", "blocked"]) {
    const epic = makeEpic({
      tasks: [
        makeTask({ task_id: "fn-1-foo.1", runtime_status: "todo" }),
        makeTask({ task_id: "fn-1-foo.2", runtime_status: rt }),
      ],
    });
    expect(isEpicStarted(epic)).toBe(true);
  }
});

test("isEpicStarted: null/malformed fields do NOT throw (null-safe)", () => {
  // The board feeds the seam an untyped `snap.epics as Epic[]` cast — a `.length`
  // on `undefined` in the predicate would crash the render path.
  const malformed = {
    epic_id: "fn-1-foo",
    epic_number: null,
    // jobs / job_links / tasks all absent.
  } as unknown as Epic;
  expect(() => isEpicStarted(malformed)).not.toThrow();
  expect(isEpicStarted(malformed)).toBe(false);

  const malformedTask = makeEpic({
    jobs: undefined as unknown as Epic["jobs"],
    job_links: undefined as unknown as Epic["job_links"],
    tasks: [
      {
        task_id: "fn-1-foo.1",
        // jobs / runtime_status absent.
      } as unknown as Task,
    ],
  });
  expect(() => isEpicStarted(malformedTask)).not.toThrow();
  expect(isEpicStarted(malformedTask)).toBe(false);
});

// ---------------------------------------------------------------------------
// fn-949: orderEpicsForScheduling — stable total-order sort (started-first,
// epic_number ASC null-last, epic_id tiebreak); pure; fresh array.
// ---------------------------------------------------------------------------

function startedEpic(overrides: Partial<Epic>): Epic {
  // A minimally-started epic: one task with a work job.
  return makeEpic({
    tasks: [
      makeTask({
        task_id: `${overrides.epic_id ?? "fn-1-foo"}.1`,
        epic_id: overrides.epic_id ?? "fn-1-foo",
        runtime_status: "in_progress",
      }),
    ],
    ...overrides,
  });
}

function unstartedEpic(overrides: Partial<Epic>): Epic {
  return makeEpic({
    jobs: [],
    job_links: [],
    tasks: [
      makeTask({
        task_id: `${overrides.epic_id ?? "fn-1-foo"}.1`,
        epic_id: overrides.epic_id ?? "fn-1-foo",
        runtime_status: "todo",
      }),
    ],
    ...overrides,
  });
}

test("orderEpicsForScheduling: started epics sort ahead of unstarted ones", () => {
  const e1 = unstartedEpic({ epic_id: "fn-1-foo", epic_number: 1 });
  const e2 = startedEpic({ epic_id: "fn-2-bar", epic_number: 2 });
  const ordered = orderEpicsForScheduling([e1, e2]);
  expect(ordered.map((e) => e.epic_id)).toEqual(["fn-2-bar", "fn-1-foo"]);
});

test("orderEpicsForScheduling: a plan-only epic tiers BEHIND a genuinely started one", () => {
  // fn-957: the lower-numbered epic carries only a stopped `plan` planner job
  // (unstarted); the higher-numbered one is genuinely in-progress. Started-first
  // must reorder the in-progress epic ahead despite its later creation number.
  const planOnly = unstartedEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    jobs: [makeEmbeddedJob({ plan_verb: "plan" })],
  });
  const inProgress = startedEpic({ epic_id: "fn-2-bar", epic_number: 2 });
  const ordered = orderEpicsForScheduling([planOnly, inProgress]);
  expect(ordered.map((e) => e.epic_id)).toEqual(["fn-2-bar", "fn-1-foo"]);
});

test("orderEpicsForScheduling: creation order (epic_number ASC) within a tier", () => {
  const e3 = unstartedEpic({ epic_id: "fn-3-c", epic_number: 3 });
  const e1 = unstartedEpic({ epic_id: "fn-1-a", epic_number: 1 });
  const e2 = unstartedEpic({ epic_id: "fn-2-b", epic_number: 2 });
  const ordered = orderEpicsForScheduling([e3, e1, e2]);
  expect(ordered.map((e) => e.epic_id)).toEqual(["fn-1-a", "fn-2-b", "fn-3-c"]);
});

test("orderEpicsForScheduling: null epic_number sorts LAST within its tier", () => {
  const e1 = unstartedEpic({ epic_id: "fn-1-a", epic_number: 1 });
  const eNull = unstartedEpic({ epic_id: "fn-z-null", epic_number: null });
  const e2 = unstartedEpic({ epic_id: "fn-2-b", epic_number: 2 });
  const ordered = orderEpicsForScheduling([eNull, e2, e1]);
  expect(ordered.map((e) => e.epic_id)).toEqual([
    "fn-1-a",
    "fn-2-b",
    "fn-z-null",
  ]);
});

test("orderEpicsForScheduling: epic_id breaks a same-tier same-number tie", () => {
  const eb = unstartedEpic({ epic_id: "fn-9-bbb", epic_number: 9 });
  const ea = unstartedEpic({ epic_id: "fn-9-aaa", epic_number: 9 });
  const ordered = orderEpicsForScheduling([eb, ea]);
  expect(ordered.map((e) => e.epic_id)).toEqual(["fn-9-aaa", "fn-9-bbb"]);
});

test("orderEpicsForScheduling: same output on a shuffled input (cycle-invariance)", () => {
  const epics = [
    startedEpic({ epic_id: "fn-2-started", epic_number: 2 }),
    unstartedEpic({ epic_id: "fn-1-unstarted", epic_number: 1 }),
    startedEpic({ epic_id: "fn-4-started", epic_number: 4 }),
    unstartedEpic({ epic_id: "fn-3-unstarted", epic_number: 3 }),
    unstartedEpic({ epic_id: "fn-x-null", epic_number: null }),
  ];
  const expected = [
    "fn-2-started",
    "fn-4-started",
    "fn-1-unstarted",
    "fn-3-unstarted",
    "fn-x-null",
  ];
  expect(orderEpicsForScheduling(epics).map((e) => e.epic_id)).toEqual(
    expected,
  );
  // Reverse + rotate the input — the unique tiebreak makes output invariant.
  const shuffled = [epics[3], epics[0], epics[4], epics[1], epics[2]];
  expect(orderEpicsForScheduling(shuffled).map((e) => e.epic_id)).toEqual(
    expected,
  );
});

test("orderEpicsForScheduling: pure — returns a fresh array, never mutates input", () => {
  const e1 = startedEpic({ epic_id: "fn-2-bar", epic_number: 2 });
  const e2 = unstartedEpic({ epic_id: "fn-1-foo", epic_number: 1 });
  const input = [e2, e1];
  const ordered = orderEpicsForScheduling(input);
  expect(ordered).not.toBe(input);
  // Input order untouched.
  expect(input.map((e) => e.epic_id)).toEqual(["fn-1-foo", "fn-2-bar"]);
  // Same Epic object references (reorder, not clone).
  expect(ordered[0]).toBe(e1);
  expect(ordered[1]).toBe(e2);
});

// ---------------------------------------------------------------------------
// fn-949: composed reorder→mutex — the load-bearing integration. A started
// epic's ready task must win a shared root over an unstarted same-root sibling
// once the seam reorder feeds the per-root mutex's "first ready row wins" walk.
// ---------------------------------------------------------------------------

test("composed reorder→mutex: started epic beats a LOWER-epic_number unstarted same-root sibling for the shared root", () => {
  // fn-1 is the lower epic_number but UNSTARTED; fn-2 is STARTED. Both ready on
  // /repo. Without the reorder, fn-1 (iterating first in creation order) would
  // claim the root and demote fn-2. The seam reorders started-first, so fn-2
  // claims /repo and fn-1 demotes to single-task-per-root.
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    target_repo: "/repo",
    runtime_status: "todo",
  });
  const e1 = unstartedEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo",
    tasks: [t1],
  });
  const t2 = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
    target_repo: "/repo",
    runtime_status: "in_progress",
  });
  const e2 = startedEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/repo",
    tasks: [t2],
  });
  // Feed the mutex the SAME array the production path would: seam-ordered.
  const ordered = orderEpicsForScheduling([e1, e2]);
  expect(ordered.map((e) => e.epic_id)).toEqual(["fn-2-bar", "fn-1-foo"]);
  const perTask = new Map<string, Verdict>([
    [t1.task_id, { tag: "ready" }],
    [t2.task_id, { tag: "ready" }],
  ]);
  applySingleTaskPerRootMutex(ordered, perTask, new Map());
  expect(perTask.get("fn-2-bar.1")).toEqual({ tag: "ready" });
  expect(perTask.get("fn-1-foo.1")).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

test("composed reorder→mutex: armed eligibility composes INNER to the started-first order (eligible+unstarted beats ineligible+started)", () => {
  // Started-first is the SEED order; armed-mode eligibility is the inner
  // tiebreak in the per-root mutex's pass-2a. An ELIGIBLE-but-unstarted epic's
  // task still claims the shared root over an INELIGIBLE-but-started sibling —
  // armed precedence dominates the reorder.
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    target_repo: "/repo",
    runtime_status: "in_progress",
  });
  const e1 = startedEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo",
    tasks: [t1],
  });
  const t2 = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
    target_repo: "/repo",
    runtime_status: "todo",
  });
  const e2 = unstartedEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/repo",
    tasks: [t2],
  });
  // Seam order puts the STARTED fn-1 first.
  const ordered = orderEpicsForScheduling([e1, e2]);
  expect(ordered.map((e) => e.epic_id)).toEqual(["fn-1-foo", "fn-2-bar"]);
  const perTask = new Map<string, Verdict>([
    [t1.task_id, { tag: "ready" }],
    [t2.task_id, { tag: "ready" }],
  ]);
  // Only fn-2 is eligible (armed). Pass-2a awards the root to the eligible task
  // FIRST, regardless of its later seam position.
  applySingleTaskPerRootMutex(
    ordered,
    perTask,
    new Map(),
    new Map(),
    new Set(),
    new Set(["fn-2-bar"]),
  );
  expect(perTask.get("fn-2-bar.1")).toEqual({ tag: "ready" });
  expect(perTask.get("fn-1-foo.1")).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

test("composed reorder→mutex: a pass-1 live occupant is NOT preempted by a started sibling", () => {
  // fn-1 holds /repo via a live worker (job-running, a pass-1 root occupant).
  // fn-2 is STARTED with a ready task on the same root and sorts first after the
  // reorder — but pass-1's eligibility-blind occupancy claim wins, so the
  // started sibling's ready task demotes; the live worker is never preempted.
  const t1 = makeTask({
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    target_repo: "/repo",
    runtime_status: "in_progress",
  });
  const e1 = startedEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo",
    tasks: [t1],
  });
  const t2 = makeTask({
    task_id: "fn-2-bar.1",
    epic_id: "fn-2-bar",
    target_repo: "/repo",
    runtime_status: "in_progress",
  });
  const e2 = startedEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/repo",
    tasks: [t2],
  });
  const ordered = orderEpicsForScheduling([e1, e2]);
  const perTask = new Map<string, Verdict>([
    [t1.task_id, running({ kind: "job-running" })],
    [t2.task_id, { tag: "ready" }],
  ]);
  applySingleTaskPerRootMutex(ordered, perTask, new Map());
  expect(perTask.get("fn-1-foo.1")).toEqual(running({ kind: "job-running" }));
  expect(perTask.get("fn-2-bar.1")).toEqual(
    blocked({ kind: "single-task-per-root" }),
  );
});

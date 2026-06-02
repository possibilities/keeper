/**
 * Tests for the server-side autopilot reconciler worker (`src/autopilot-worker.ts`).
 *
 * Coverage (per the epic fn-661 acceptance bar):
 *
 *   - `reconcile()` decides launches for `ready` (work/close) and
 *     `blocked:job-pending` (approve) verdicts, suppressing on the
 *     four rules (paused / in-flight / failed-keys / occupying-job).
 *   - `confirmRunning()` GOOD: job appears before ceiling → "ok".
 *   - `confirmRunning()` BAD: ceiling elapses → DispatchFailed emitted
 *     with the surfaced reason; no auto-retry.
 *   - Dedup suppression: occupying job (working/stopped) / open
 *     dispatch_failures row / in-flight set all block re-dispatch.
 *   - No-op fast path: nothing ready → empty decision.
 *   - Reap path: autoclose flag on + role discharged → closeByName
 *     fires for the live dispatch.
 *   - `git_status` fed to computeReadiness (predicate 6.5 fires) —
 *     a dirty project_dir on a `done` close row blocks with
 *     `git-uncommitted` and stops the dispatch.
 *   - Watermark excludes a stale terminal/resumed jobs row carrying a
 *     pre-watermark `last_event_id` for the same (verb, id).
 *   - Launches serialized one-at-a-time (fn-644 stagger) — a
 *     two-launch reconcile awaits the first confirm before starting
 *     the second.
 *
 * No real worker spawn anywhere. The `isMainThread` guard in the
 * worker module makes a plain `import` inert; we drive the pure
 * `reconcile` / `confirmRunning` / `runReconcileCycle` symbols
 * directly with fake `launch` / `findJob` / `now` / `sleep` / `closeByName`.
 */

import { expect, test } from "bun:test";
import {
  buildLaunchArgv,
  buildWorkerCommand,
  type ConfirmRunningDeps,
  confirmRunning,
  type DispatchedPayload,
  type DispatchFailedPayload,
  type FoundJob,
  isOccupyingJob,
  type LaunchResult,
  type LiveDispatch,
  type ReconcileConfig,
  type ReconcileSnapshot,
  type ReconcileState,
  reconcile,
  runReconcileCycle,
  verbForVerdict,
} from "../src/autopilot-worker";
import type { Verdict } from "../src/readiness";
import type { Epic, Job, Task } from "../src/types";

// ---------------------------------------------------------------------------
// Fixture helpers (same shape as test/autopilot.test.ts)
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
    approval: "approved",
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
    approval: "approved",
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

function makeJob(overrides: Partial<Job>): Job {
  return {
    job_id: "j-1",
    created_at: 0,
    cwd: null,
    pid: null,
    state: "stopped",
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
    config_dir: null,
    git_dirty_count: 0,
    git_unattributed_to_live_count: 0,
    git_orphan_count: 0,
    ...overrides,
  } as Job;
}

function makeSnapshot(
  overrides: Partial<ReconcileSnapshot>,
): ReconcileSnapshot {
  return {
    epics: [],
    jobs: new Map(),
    subagentInvocations: [],
    gitStatusByProjectDir: new Map(),
    failedKeys: new Set(),
    liveTabKeys: new Set(),
    ...overrides,
  };
}

function makeState(overrides: Partial<ReconcileState> = {}): ReconcileState {
  return {
    paused: false,
    inFlight: new Set(),
    ...overrides,
  };
}

const NO_AUTOCLOSE: ReconcileConfig = { autocloseWindows: false };
const AUTOCLOSE: ReconcileConfig = { autocloseWindows: true };

// A simple deps factory that records all interactions.
interface FakeDepsLog {
  launches: Array<{ argv: string[]; name: string; cwd: string }>;
  emissions: DispatchFailedPayload[];
  /**
   * fn-678 task .3 plumbing: every `Dispatched` mint the reconciler hands
   * to `deps.emitDispatched`. The autopilot collapse in task .5 is the
   * sole caller in production; today the log just records the plumbing
   * is wired (this task's contract is "plumbed into ConfirmRunningDeps,"
   * not "called from reconcile").
   */
  dispatchedEmissions: DispatchedPayload[];
  findJobCalls: Array<{ verb: string; id: string; watermark: number }>;
  maxEventIdCalls: number;
  closeByNameCalls: string[];
  /** fn-674 tab-probe calls: every `verb::id` name confirmRunning queried. */
  tabProbeCalls: string[];
}

interface FakeDepsOptions {
  launch?: (argv: string[], name: string, cwd: string) => Promise<LaunchResult>;
  /**
   * Map of `${verb}::${id}` → FoundJob | null. Returned only when the
   * call's `last_event_id_gt < hit.last_event_id` (so the watermark
   * filter is honored by the fake too).
   */
  jobsByKey?: Map<string, FoundJob>;
  /**
   * fn-674 tab probe — initial set of live `verb::id` tab names. The
   * fake `tabExistsByName` returns `true` iff the polled name is in
   * this set; tests can mutate the set live via `setLiveTab` to drive
   * the early-resolve branch deterministically (tab flips alive on
   * the second poll tick, etc.).
   */
  liveTabs?: Set<string>;
  maxEventId?: number;
  now?: number | (() => number);
  pollIntervalMs?: number;
  ceilingMs?: number;
}

function makeFakeDeps(opts: FakeDepsOptions = {}): {
  deps: ConfirmRunningDeps & { closeByName(name: string): Promise<void> };
  log: FakeDepsLog;
  advanceMaxEventId(n: number): void;
  setJobByKey(verb: string, id: string, job: FoundJob): void;
  setLiveTab(name: string, alive: boolean): void;
} {
  const log: FakeDepsLog = {
    launches: [],
    emissions: [],
    dispatchedEmissions: [],
    findJobCalls: [],
    maxEventIdCalls: 0,
    closeByNameCalls: [],
    tabProbeCalls: [],
  };
  let maxEventId = opts.maxEventId ?? 100;
  const jobsByKey = new Map<string, FoundJob>(opts.jobsByKey ?? []);
  const liveTabs = new Set<string>(opts.liveTabs ?? []);
  const nowFn: () => number =
    typeof opts.now === "function"
      ? opts.now
      : ((): (() => number) => {
          const v = typeof opts.now === "number" ? opts.now : 1700000000;
          return () => v;
        })();

  const deps: ConfirmRunningDeps & {
    closeByName(name: string): Promise<void>;
  } = {
    async launch(argv, name, cwd) {
      log.launches.push({ argv: [...argv], name, cwd });
      if (opts.launch) {
        return opts.launch(argv, name, cwd);
      }
      return { ok: true };
    },
    emitDispatchFailed(payload) {
      log.emissions.push({ ...payload });
    },
    emitDispatched(payload) {
      log.dispatchedEmissions.push({ ...payload });
    },
    maxEventId() {
      log.maxEventIdCalls += 1;
      return maxEventId;
    },
    findJob(verb, id, watermark) {
      log.findJobCalls.push({ verb, id, watermark });
      const hit = jobsByKey.get(`${verb}::${id}`);
      if (hit && hit.last_event_id > watermark) {
        return hit;
      }
      return null;
    },
    async tabExistsByName(name) {
      log.tabProbeCalls.push(name);
      return liveTabs.has(name);
    },
    now: nowFn,
    async sleep(ms, signal) {
      // Synchronous-ish microtask sleep so tests don't spin real time.
      // Honor abort: a pre-aborted signal resolves immediately.
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(ms, 10));
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
    },
    pollIntervalMs: opts.pollIntervalMs ?? 5,
    ceilingMs: opts.ceilingMs ?? 50,
    async closeByName(name) {
      log.closeByNameCalls.push(name);
    },
  };

  return {
    deps,
    log,
    advanceMaxEventId(n: number) {
      maxEventId = n;
    },
    setJobByKey(verb: string, id: string, job: FoundJob) {
      jobsByKey.set(`${verb}::${id}`, job);
    },
    setLiveTab(name: string, alive: boolean) {
      if (alive) {
        liveTabs.add(name);
      } else {
        liveTabs.delete(name);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// verbForVerdict
// ---------------------------------------------------------------------------

test("verbForVerdict: ready task → work, ready close → close", () => {
  const ready: Verdict = { tag: "ready" };
  expect(verbForVerdict("task", ready)).toBe("work");
  expect(verbForVerdict("close", ready)).toBe("close");
});

test("verbForVerdict: blocked job-pending → approve (both kinds)", () => {
  const jp: Verdict = { tag: "blocked", reason: { kind: "job-pending" } };
  expect(verbForVerdict("task", jp)).toBe("approve");
  expect(verbForVerdict("close", jp)).toBe("approve");
});

test("verbForVerdict: other blocked / running / completed / undefined → null", () => {
  expect(
    verbForVerdict("task", {
      tag: "blocked",
      reason: { kind: "job-rejected" },
    }),
  ).toBeNull();
  expect(
    verbForVerdict("task", {
      tag: "running",
      reason: { kind: "job-running" },
    }),
  ).toBeNull();
  expect(verbForVerdict("task", { tag: "completed" })).toBeNull();
  expect(verbForVerdict("task", undefined)).toBeNull();
});

// ---------------------------------------------------------------------------
// isOccupyingJob
// ---------------------------------------------------------------------------

test("isOccupyingJob: working state with matching (verb, id) → true", () => {
  const jobs = new Map<string, Job>();
  jobs.set(
    "j-1",
    makeJob({
      job_id: "j-1",
      plan_verb: "work",
      plan_ref: "fn-1-foo.1",
      state: "working",
    }),
  );
  expect(isOccupyingJob(jobs, "work", "fn-1-foo.1")).toBe(true);
});

test("isOccupyingJob: stopped state still occupies (the schema default)", () => {
  const jobs = new Map<string, Job>();
  jobs.set(
    "j-1",
    makeJob({
      job_id: "j-1",
      plan_verb: "work",
      plan_ref: "fn-1-foo.1",
      state: "stopped",
    }),
  );
  expect(isOccupyingJob(jobs, "work", "fn-1-foo.1")).toBe(true);
});

test("isOccupyingJob: ended / killed terminal rows do not occupy", () => {
  const jobs = new Map<string, Job>();
  jobs.set(
    "j-1",
    makeJob({
      job_id: "j-1",
      plan_verb: "work",
      plan_ref: "fn-1-foo.1",
      state: "ended",
    }),
  );
  jobs.set(
    "j-2",
    makeJob({
      job_id: "j-2",
      plan_verb: "work",
      plan_ref: "fn-1-foo.1",
      state: "killed",
    }),
  );
  expect(isOccupyingJob(jobs, "work", "fn-1-foo.1")).toBe(false);
});

test("isOccupyingJob: plan_verb mismatch (approve vs work share plan_ref) → no false match", () => {
  // The `approve::id` and `work::id` share `plan_ref` — dedup MUST gate
  // on `plan_verb` too. An `approve` row in 'working' must not block a
  // `work` dispatch on the same task id.
  const jobs = new Map<string, Job>();
  jobs.set(
    "j-1",
    makeJob({
      job_id: "j-1",
      plan_verb: "approve",
      plan_ref: "fn-1-foo.1",
      state: "working",
    }),
  );
  expect(isOccupyingJob(jobs, "work", "fn-1-foo.1")).toBe(false);
  expect(isOccupyingJob(jobs, "approve", "fn-1-foo.1")).toBe(true);
});

// ---------------------------------------------------------------------------
// reconcile — no-op fast path
// ---------------------------------------------------------------------------

test("reconcile: empty snapshot → empty decision (no-op fast path)", () => {
  const snap = makeSnapshot({});
  const state = makeState();
  const decision = reconcile(snap, state, new Map(), NO_AUTOCLOSE, 0);
  expect(decision.launches).toEqual([]);
  expect(decision.reaps).toEqual([]);
});

test("reconcile: paused state suppresses every launch (boots-paused safety)", () => {
  const epic = makeEpic({
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = makeSnapshot({ epics: [epic] });
  const state = makeState({ paused: true });
  const decision = reconcile(snap, state, new Map(), NO_AUTOCLOSE, 0);
  expect(decision.launches).toEqual([]);
});

// ---------------------------------------------------------------------------
// reconcile — happy path
// ---------------------------------------------------------------------------

test("reconcile: ready task → planned `work` launch with correct argv shape", () => {
  const epic = makeEpic({
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = makeSnapshot({ epics: [epic] });
  const decision = reconcile(snap, makeState(), new Map(), NO_AUTOCLOSE, 0);
  expect(decision.launches.length).toBe(1);
  const plan = decision.launches[0];
  expect(plan).not.toBeUndefined();
  expect(plan?.verb).toBe("work");
  expect(plan?.id).toBe("fn-1-foo.1");
  expect(plan?.key).toBe("work::fn-1-foo.1");
  expect(plan?.cwd).toBe("/repo");
  expect(plan?.workerCommand).toBe(
    "cd /repo && claude --model sonnet --effort max --name work::fn-1-foo.1 '/plan:work fn-1-foo.1'",
  );
});

test("reconcile: ready close row → planned `close` launch", () => {
  // A close row is ready when status=done + approval=approved is NOT
  // the case; instead with no tasks the close row will be ready right
  // away (passes predicates 1, 2, 3, 4, 5, 6.5, 7-10). Make an epic
  // with all-completed tasks so the close row is ready.
  const completedTask: Task = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    runtime_status: "done",
  });
  const epic = makeEpic({ tasks: [completedTask] });
  // The task verdict will be `completed`; the close row's verdict is
  // ready when every task completed and the epic isn't yet done. The
  // predicate set for the close row reflects this. Force the case by
  // marking status="open" and the task `completed`-ready.
  const snap = makeSnapshot({ epics: [epic] });
  const decision = reconcile(snap, makeState(), new Map(), NO_AUTOCLOSE, 0);
  // Close row should plan a `close` launch.
  const closePlan = decision.launches.find((p) => p.verb === "close");
  expect(closePlan).not.toBeUndefined();
  expect(closePlan?.id).toBe("fn-1-foo");
  expect(closePlan?.cwd).toBe("/repo");
});

test("reconcile: task target_repo override wins over epic project_dir for cwd", () => {
  const epic = makeEpic({
    project_dir: "/repo-epic",
    tasks: [makeTask({ task_id: "fn-1-foo.1", target_repo: "/repo-task" })],
  });
  const snap = makeSnapshot({ epics: [epic] });
  const decision = reconcile(snap, makeState(), new Map(), NO_AUTOCLOSE, 0);
  expect(decision.launches[0]?.cwd).toBe("/repo-task");
  // Tier null → no plugin-dir flag.
  expect(decision.launches[0]?.workerCommand).not.toContain("--plugin-dir");
});

test("reconcile: tier on a `work` row threads --plugin-dir into the command", () => {
  const epic = makeEpic({
    tasks: [makeTask({ task_id: "fn-1-foo.1", tier: "max" })],
  });
  const snap = makeSnapshot({ epics: [epic] });
  const decision = reconcile(snap, makeState(), new Map(), NO_AUTOCLOSE, 0);
  expect(decision.launches[0]?.tier).toBe("max");
  expect(decision.launches[0]?.workerCommand).toContain(
    "/claude/work-plugins/max",
  );
});

// ---------------------------------------------------------------------------
// reconcile — dedup
// ---------------------------------------------------------------------------

test("reconcile dedup: in-flight set blocks re-dispatch", () => {
  const epic = makeEpic({
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = makeSnapshot({ epics: [epic] });
  const state = makeState({ inFlight: new Set(["work::fn-1-foo.1"]) });
  const decision = reconcile(snap, state, new Map(), NO_AUTOCLOSE, 0);
  expect(decision.launches).toEqual([]);
});

test("reconcile dedup: occupying job (working) blocks re-dispatch", () => {
  const epic = makeEpic({
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const jobs = new Map<string, Job>();
  jobs.set(
    "j-1",
    makeJob({
      job_id: "j-1",
      plan_verb: "work",
      plan_ref: "fn-1-foo.1",
      state: "working",
    }),
  );
  const snap = makeSnapshot({ epics: [epic], jobs });
  const decision = reconcile(snap, makeState(), new Map(), NO_AUTOCLOSE, 0);
  expect(decision.launches).toEqual([]);
});

test("reconcile dedup: open dispatch_failures row blocks re-dispatch (sticky failure)", () => {
  const epic = makeEpic({
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = makeSnapshot({
    epics: [epic],
    failedKeys: new Set(["work::fn-1-foo.1"]),
  });
  const decision = reconcile(snap, makeState(), new Map(), NO_AUTOCLOSE, 0);
  expect(decision.launches).toEqual([]);
});

test("reconcile dedup (fn-674): liveTabKeys.has(key) blocks re-dispatch in the launch → SessionStart window", () => {
  // The launch → SessionStart blind window: the autopilot launched
  // a worker into a verb::id-named tab, the tab is live, but the
  // worker's SessionStart hook hasn't folded a jobs row yet. The
  // legacy `isOccupyingJob` arm sees nothing (empty jobs map, empty
  // inFlight, empty failedKeys). The fn-674 standing arm fires.
  const epic = makeEpic({
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = makeSnapshot({
    epics: [epic],
    liveTabKeys: new Set(["work::fn-1-foo.1"]),
  });
  const decision = reconcile(snap, makeState(), new Map(), NO_AUTOCLOSE, 0);
  expect(decision.launches).toEqual([]);
});

test("reconcile dedup (fn-674): liveTabKeys on close::<epic> blocks the close-row dispatch", () => {
  // Same shape as the task arm but for the close row — proves the
  // standing arm covers the (verb='close', id=epic_id) shape too.
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    status: "done",
    approval: "pending",
  });
  const snap = makeSnapshot({
    epics: [epic],
    liveTabKeys: new Set(["approve::fn-1-foo"]),
  });
  const decision = reconcile(snap, makeState(), new Map(), NO_AUTOCLOSE, 0);
  // The `approve` verb dispatches for status=done + approval=pending,
  // and the liveTabKeys arm gates it identically to the task path.
  expect(decision.launches.find((p) => p.verb === "approve")).toBeUndefined();
});

// ---------------------------------------------------------------------------
// reconcile — git_status feed (fn-638 predicate 6.5)
// ---------------------------------------------------------------------------

test("reconcile: live git_status feeds computeReadiness (predicate 6.5 gates close-row)", () => {
  // An epic at `status="done"` with dirty files in its project_dir
  // hits predicate 6.5 on the close row: `git-uncommitted`. The
  // reconciler must NOT dispatch close in that case.
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    status: "done",
    approval: "pending",
  });
  const gitStatus = new Map<
    string,
    { dirty_count: number; unattributed_to_live_count: number }
  >();
  gitStatus.set("/repo", {
    dirty_count: 3,
    unattributed_to_live_count: 0,
  });
  const snap = makeSnapshot({
    epics: [epic],
    gitStatusByProjectDir: gitStatus,
  });
  const decision = reconcile(snap, makeState(), new Map(), NO_AUTOCLOSE, 0);
  // No close launch — git-uncommitted blocks it.
  const closeLaunch = decision.launches.find((p) => p.verb === "close");
  expect(closeLaunch).toBeUndefined();
});

test("reconcile: empty git_status map → predicate 6.5 stays inert (default semantics)", () => {
  // No git_status row for the project → predicate 6.5 cannot fire, so
  // a done+pending close row can reach the approve dispatch path.
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    status: "done",
    approval: "pending",
  });
  const snap = makeSnapshot({ epics: [epic] });
  const decision = reconcile(snap, makeState(), new Map(), NO_AUTOCLOSE, 0);
  // Approve close should fire (status=done && approval=pending →
  // job-pending verdict → `approve` verb).
  const approveLaunch = decision.launches.find((p) => p.verb === "approve");
  expect(approveLaunch).not.toBeUndefined();
  expect(approveLaunch?.id).toBe("fn-1-foo");
});

// ---------------------------------------------------------------------------
// confirmRunning — GOOD / BAD / aborted
// ---------------------------------------------------------------------------

test("confirmRunning GOOD: job appears before ceiling → ok, no emission", async () => {
  const { deps, log, setJobByKey } = makeFakeDeps({
    maxEventId: 100,
    pollIntervalMs: 5,
    ceilingMs: 100,
  });
  setJobByKey("work", "fn-1-foo.1", {
    job_id: "j-1",
    last_event_id: 150, // > watermark 100
  });
  const ctrl = new AbortController();
  const outcome = await confirmRunning(
    "work",
    "fn-1-foo.1",
    "/repo",
    ["sh", "-c", "true"],
    ctrl.signal,
    deps,
  );
  expect(outcome).toBe("ok");
  expect(log.launches.length).toBe(1);
  expect(log.launches[0]?.name).toBe("work::fn-1-foo.1");
  expect(log.emissions).toEqual([]); // no DispatchFailed
});

test("confirmRunning BAD (fn-674 dead launch): ceiling elapses, NO tab and NO jobs row → failed + DispatchFailed", async () => {
  // The post-fn-674 BAD case is narrower: a timeout MINTS DispatchFailed
  // only when the zellij tab never appeared AND the jobs row never
  // appeared — the launch genuinely failed to materialize a worker.
  // The fake's default `liveTabs` set is empty, mirroring "no tab".
  const { deps, log } = makeFakeDeps({
    maxEventId: 100,
    pollIntervalMs: 5,
    ceilingMs: 20, // very tight — a few ticks then timeout
  });
  const ctrl = new AbortController();
  const outcome = await confirmRunning(
    "work",
    "fn-1-foo.1",
    "/repo",
    ["sh", "-c", "true"],
    ctrl.signal,
    deps,
  );
  expect(outcome).toBe("failed");
  expect(log.emissions.length).toBe(1);
  const emission = log.emissions[0];
  expect(emission?.verb).toBe("work");
  expect(emission?.id).toBe("fn-1-foo.1");
  expect(emission?.reason).toContain("confirm timeout");
  expect(emission?.dir).toBe("/repo");
});

test("confirmRunning fn-674 alive-at-ceiling: tab exists but no jobs row → ok, NO emit, slot held by liveTabKeys arm", async () => {
  // The pre-fn-674 BAD test asserted a timeout always mints
  // DispatchFailed. That's the load-bearing bug fn-674 fixes: when
  // the launch succeeded but the worker is still booting (e.g. a
  // 24-33s `claude` cold start), the named tab is live in the
  // session even though the jobs row hasn't folded yet. The confirm
  // must resolve `"ok"` (the launch DID succeed), mint NOTHING (the
  // slot remains held by the standing liveTabKeys dedup arm on the
  // next reconcile), and free no slot for a spurious re-dispatch.
  const { deps, log } = makeFakeDeps({
    maxEventId: 100,
    pollIntervalMs: 5,
    ceilingMs: 20,
    liveTabs: new Set(["work::fn-1-foo.1"]), // tab present, jobs row absent
  });
  const ctrl = new AbortController();
  const outcome = await confirmRunning(
    "work",
    "fn-1-foo.1",
    "/repo",
    ["sh", "-c", "true"],
    ctrl.signal,
    deps,
  );
  // Either the in-loop early-resolve OR the ceiling-elapsed final
  // probe resolves "ok"; both code paths converge on the same
  // outcome — no emit, slot held.
  expect(outcome).toBe("ok");
  expect(log.emissions).toEqual([]);
});

test("confirmRunning fn-674 early-resolve: tab appears before jobs row → ok, no emit", async () => {
  // The first poll tick sees an empty liveTabs set; mid-flight we
  // flip the tab alive. The confirm must resolve "ok" on the next
  // tick from the tab probe alone — without waiting for the jobs
  // row to fold (the launch → SessionStart blind window the
  // fn-674 dedup arm closes).
  const fake = makeFakeDeps({
    maxEventId: 100,
    pollIntervalMs: 5,
    ceilingMs: 200,
  });
  const ctrl = new AbortController();
  const promise = confirmRunning(
    "work",
    "fn-1-foo.1",
    "/repo",
    ["sh", "-c", "true"],
    ctrl.signal,
    fake.deps,
  );
  // Give the launch + first poll tick a moment, then flip the tab live.
  await Bun.sleep(15);
  fake.setLiveTab("work::fn-1-foo.1", true);
  const outcome = await promise;
  expect(outcome).toBe("ok");
  expect(fake.log.emissions).toEqual([]);
  // Tab probe was queried — confirms the new dep is wired.
  expect(fake.log.tabProbeCalls.length).toBeGreaterThan(0);
});

test("confirmRunning BAD: launch returns {ok:false} → failed immediately with surfaced reason", async () => {
  const { deps, log } = makeFakeDeps({
    launch: async () => ({ ok: false, error: "zellij ENOENT" }),
  });
  const ctrl = new AbortController();
  const outcome = await confirmRunning(
    "work",
    "fn-1-foo.1",
    "/repo",
    ["sh"],
    ctrl.signal,
    deps,
  );
  expect(outcome).toBe("failed");
  expect(log.emissions.length).toBe(1);
  expect(log.emissions[0]?.reason).toBe("zellij ENOENT");
  // No poll loop touched.
  expect(log.findJobCalls.length).toBe(0);
});

test("confirmRunning: watermark captured BEFORE launch (excludes stale terminal rows)", async () => {
  // The fake's findJob filters on `last_event_id > watermark`. A stale
  // jobs row for `(work, fn-1-foo.1)` with last_event_id=80 must NOT
  // satisfy a confirm whose watermark is 100. We seed exactly that
  // and assert the confirm times out — proving the watermark math
  // gates the false-positive.
  const { deps, log, setJobByKey } = makeFakeDeps({
    maxEventId: 100,
    pollIntervalMs: 5,
    ceilingMs: 20,
  });
  setJobByKey("work", "fn-1-foo.1", {
    job_id: "j-1",
    last_event_id: 80, // ≤ watermark 100 → must be filtered out
  });
  const ctrl = new AbortController();
  const outcome = await confirmRunning(
    "work",
    "fn-1-foo.1",
    "/repo",
    ["sh"],
    ctrl.signal,
    deps,
  );
  expect(outcome).toBe("failed");
  expect(log.emissions[0]?.reason).toContain("confirm timeout");
});

test("confirmRunning ABORTED: shutdown signal during poll → aborted, no emission", async () => {
  const { deps, log } = makeFakeDeps({
    pollIntervalMs: 50,
    ceilingMs: 500,
  });
  const ctrl = new AbortController();
  const promise = confirmRunning(
    "work",
    "fn-1-foo.1",
    "/repo",
    ["sh"],
    ctrl.signal,
    deps,
  );
  // Abort after first launch lands but before the first poll resolves.
  await Bun.sleep(20);
  ctrl.abort();
  const outcome = await promise;
  expect(outcome).toBe("aborted");
  expect(log.emissions).toEqual([]); // a shutdown is NOT a sticky failure
});

// ---------------------------------------------------------------------------
// runReconcileCycle — serialization + reap
// ---------------------------------------------------------------------------

test("runReconcileCycle: two launches serialize one-at-a-time (fn-644 stagger)", async () => {
  // Stage two ready tasks → reconcile emits two launches. We hook
  // `launch` so the FIRST call blocks until we resolve a deferred; if
  // the cycle is parallel, the second launch would start before we
  // unblock the first. Assert sequential order via call-time ordering.
  const order: string[] = [];
  const firstGate = Promise.withResolvers<void>();
  const launchImpl = async (
    _argv: string[],
    name: string,
    _cwd: string,
  ): Promise<LaunchResult> => {
    order.push(`launch-start:${name}`);
    if (name === "work::fn-1-foo.1") {
      await firstGate.promise;
    }
    order.push(`launch-end:${name}`);
    return { ok: true };
  };

  const { deps, setJobByKey } = makeFakeDeps({
    launch: launchImpl,
    maxEventId: 100,
    pollIntervalMs: 5,
    ceilingMs: 100,
  });
  // Pre-seed both jobs so the confirm GOOD-path fires fast on each.
  setJobByKey("work", "fn-1-foo.1", { job_id: "j-1", last_event_id: 200 });
  setJobByKey("work", "fn-2-bar.1", { job_id: "j-2", last_event_id: 201 });

  // Two SEPARATE epics in two SEPARATE project_dirs — single-task-per-epic
  // and single-task-per-root would otherwise collapse one of the launches
  // (the test is about the reconciler's launch serialization, not about
  // the per-epic/per-root mutex).
  const epicA = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo-a",
    tasks: [makeTask({ task_id: "fn-1-foo.1", epic_id: "fn-1-foo" })],
    sort_path: "000001",
  });
  const epicB = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/repo-b",
    tasks: [
      makeTask({
        task_id: "fn-2-bar.1",
        epic_id: "fn-2-bar",
        task_number: 1,
      }),
    ],
    sort_path: "000002",
  });
  const snap = makeSnapshot({ epics: [epicA, epicB] });
  const state = makeState();
  const liveDispatches = new Map<string, LiveDispatch>();
  const decision = reconcile(snap, state, liveDispatches, NO_AUTOCLOSE, 0);
  expect(decision.launches.length).toBe(2);

  const ctrl = new AbortController();
  const cycle = runReconcileCycle(
    decision,
    state,
    liveDispatches,
    "/bin/zsh",
    ctrl.signal,
    deps,
  );

  // Let the first launch get to its gate. The second must NOT have
  // started yet — that's the stagger.
  await Bun.sleep(20);
  expect(order.filter((s) => s.startsWith("launch-start:"))).toEqual([
    "launch-start:work::fn-1-foo.1",
  ]);

  firstGate.resolve();
  await cycle;
  // Both finished, second started AFTER first ended.
  const startEvents = order.filter((s) => s.startsWith("launch-start:"));
  expect(startEvents).toEqual([
    "launch-start:work::fn-1-foo.1",
    "launch-start:work::fn-2-bar.1",
  ]);
  // Both promoted to live.
  expect(liveDispatches.size).toBe(2);
});

test("runReconcileCycle reap: autoclose=on + role discharged → closeByName called, live entry forgotten", async () => {
  // Pre-stage a live dispatch. The snapshot has NO matching epic/task
  // anymore (the row was completed, dropped from default scope) — so
  // the reconcile pass marks it role-discharged.
  const liveDispatches = new Map<string, LiveDispatch>();
  liveDispatches.set("work::fn-1-foo.1", {
    verb: "work",
    id: "fn-1-foo.1",
    key: "work::fn-1-foo.1",
    cwd: "/repo",
    controller: new AbortController(),
  });
  const snap = makeSnapshot({ epics: [] });
  const decision = reconcile(snap, makeState(), liveDispatches, AUTOCLOSE, 0);
  expect(decision.reaps.length).toBe(1);
  expect(decision.reaps[0]?.key).toBe("work::fn-1-foo.1");
  expect(decision.reaps[0]?.reason).toBe("role-discharged");

  const { deps, log } = makeFakeDeps();
  const ctrl = new AbortController();
  await runReconcileCycle(
    decision,
    makeState(),
    liveDispatches,
    "/bin/zsh",
    ctrl.signal,
    deps,
  );
  expect(log.closeByNameCalls).toEqual(["work::fn-1-foo.1"]);
  expect(liveDispatches.has("work::fn-1-foo.1")).toBe(false);
});

test("runReconcileCycle reap: autoclose=on + job terminal → reap fires with job-terminal reason", async () => {
  // Live dispatch exists; the matching job has reached `ended`.
  const liveDispatches = new Map<string, LiveDispatch>();
  liveDispatches.set("work::fn-1-foo.1", {
    verb: "work",
    id: "fn-1-foo.1",
    key: "work::fn-1-foo.1",
    cwd: "/repo",
    controller: new AbortController(),
  });
  const jobs = new Map<string, Job>();
  jobs.set(
    "j-1",
    makeJob({
      job_id: "j-1",
      plan_verb: "work",
      plan_ref: "fn-1-foo.1",
      state: "ended",
      last_event_id: 999,
    }),
  );
  // Keep the row in the snapshot so it's not also role-discharged —
  // the more specific job-terminal branch should win.
  const epic = makeEpic({
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = makeSnapshot({ epics: [epic], jobs });
  const decision = reconcile(snap, makeState(), liveDispatches, AUTOCLOSE, 0);
  // The single reap reflects job-terminal.
  const r = decision.reaps.find((x) => x.key === "work::fn-1-foo.1");
  expect(r?.reason).toBe("job-terminal");
});

test("runReconcileCycle reap: autoclose=off → no reap even when role discharged", () => {
  const liveDispatches = new Map<string, LiveDispatch>();
  liveDispatches.set("work::fn-1-foo.1", {
    verb: "work",
    id: "fn-1-foo.1",
    key: "work::fn-1-foo.1",
    cwd: "/repo",
    controller: new AbortController(),
  });
  const snap = makeSnapshot({ epics: [] });
  const decision = reconcile(
    snap,
    makeState(),
    liveDispatches,
    NO_AUTOCLOSE,
    0,
  );
  expect(decision.reaps).toEqual([]);
});

// ---------------------------------------------------------------------------
// buildWorkerCommand parity with cli/autopilot.ts shape
// ---------------------------------------------------------------------------

test("buildWorkerCommand mirrors cli/autopilot.ts: work / close / approve flag shapes", () => {
  expect(buildWorkerCommand("work", "fn-1-foo.1", "/repo")).toBe(
    "cd /repo && claude --model sonnet --effort max --name work::fn-1-foo.1 '/plan:work fn-1-foo.1'",
  );
  expect(buildWorkerCommand("close", "fn-1-foo", "/repo")).toBe(
    "cd /repo && claude --model sonnet --effort max --name close::fn-1-foo '/plan:close fn-1-foo'",
  );
  expect(buildWorkerCommand("approve", "fn-1-foo.1", "/repo")).toBe(
    "cd /repo && claude --model sonnet --effort low --name approve::fn-1-foo.1 '/plan:approve fn-1-foo.1'",
  );
  // Empty projectDir → no `cd` prefix (degenerate test path).
  expect(buildWorkerCommand("work", "fn-1-foo.1", "")).toBe(
    "claude --model sonnet --effort max --name work::fn-1-foo.1 '/plan:work fn-1-foo.1'",
  );
});

test("buildLaunchArgv wraps the worker command in [shell, -l, -i, -c, body]", () => {
  const argv = buildLaunchArgv(
    "/bin/zsh",
    "claude --name work::x '/plan:work x'",
  );
  expect(argv.length).toBe(5);
  expect(argv[0]).toBe("/bin/zsh");
  expect(argv[1]).toBe("-l");
  expect(argv[2]).toBe("-i");
  expect(argv[3]).toBe("-c");
  expect(argv[4]).toContain("claude --name work::x");
  expect(argv[4]).toContain("; exec /bin/zsh -l -i");
});

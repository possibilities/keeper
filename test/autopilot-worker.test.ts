/**
 * Tests for the server-side autopilot reconciler worker (`src/autopilot-worker.ts`).
 *
 * Coverage (per the epic fn-661 acceptance bar):
 *
 *   - `reconcile()` decides launches for `ready` (work/close) verdicts
 *     (fn-756 — the approve verb is gone; no blocked verdict dispatches),
 *     suppressing on the four rules (paused / in-flight / failed-keys /
 *     occupying-job).
 *   - `confirmRunning()` GOOD: job appears before ceiling → "ok".
 *   - `confirmRunning()` BAD: ceiling elapses → DispatchFailed emitted
 *     with the surfaced reason; no auto-retry.
 *   - Dedup suppression: occupying job (working/stopped) / open
 *     dispatch_failures row / in-flight set all block re-dispatch.
 *   - No-op fast path: nothing ready → empty decision.
 *   - fn-756: a `done` epic is `completed` (predicate 1) regardless of the
 *     `git_status` feed — the predicate-6.5 git lift is gone.
 *   - Watermark excludes a stale terminal/resumed jobs row carrying a
 *     pre-watermark `last_event_id` for the same (verb, id).
 *   - Launches serialized one-at-a-time (fn-644 stagger) — a
 *     two-launch reconcile awaits the first confirm before starting
 *     the second.
 *
 * No real worker spawn anywhere. The `isMainThread` guard in the
 * worker module makes a plain `import` inert; we drive the pure
 * `reconcile` / `confirmRunning` / `runReconcileCycle` symbols
 * directly with fake `launch` / `findJob` / `now` / `sleep`.
 */

import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeEligibleEpics } from "../src/armed-closure";
import {
  buildLaunchArgv,
  buildWorkerCommand,
  type ConfirmRunningDeps,
  confirmRunning,
  DEFAULT_CEILING_MS,
  type DispatchedAck,
  type DispatchedPayload,
  type DispatchFailedPayload,
  DONE_EPICS_REAP_LIMIT,
  FINALIZER_GUARD_S,
  type FoundJob,
  isCompletionReapCandidate,
  isEpicInFlight,
  isFinalizerGuarded,
  isFinalizerVerb,
  isInCooldown,
  isOccupyingJob,
  isReapCandidate,
  type LaunchResult,
  type LiveDispatch,
  loadReconcileSnapshot,
  MIN_REAP_INTERVAL_S,
  REDISPATCH_COOLDOWN_S,
  type ReconcileSnapshot,
  type ReconcileState,
  reapFloorElapsed,
  reconcile,
  runReconcileCycle,
  sweepFinalizerGuard,
  sweepRedispatchCooldown,
  verbForVerdict,
} from "../src/autopilot-worker";
import {
  PENDING_DISPATCH_SWEEP_INTERVAL_MS,
  PENDING_DISPATCH_TTL_MS,
} from "../src/daemon";
import { openDb } from "../src/db";
import type { ZellijPane } from "../src/exec-backend";
import {
  computeReadiness,
  type PendingDispatch,
  type Verdict,
} from "../src/readiness";
import { projectPendingDispatches } from "../src/readiness-client";
import type {
  EmbeddedJob,
  Epic,
  Job,
  ResolvedEpicDep,
  Task,
} from "../src/types";

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
    // fn-721: the launch-window occupancy set feeding the cross-sibling
    // `dispatch-pending` occupant. Default empty; tests that exercise the
    // occupant override it.
    pendingDispatches: [],
    // fn-751: autopilot mode + armed set. Default `yolo` / empty so every
    // pre-fn-751 test sees byte-for-byte identical dispatch behavior; the
    // armed-mode tests override these.
    mode: "yolo",
    armedIds: new Set(),
    ...overrides,
  };
}

function makeState(overrides: Partial<ReconcileState> = {}): ReconcileState {
  return {
    paused: false,
    inFlight: new Set(),
    // fn-735 — boots empty; cooldown tests override it.
    redispatchCooldown: new Map(),
    // fn-742 — per-epic finalizer guard; boots empty, guard tests override it.
    finalizerGuard: new Map(),
    // Default unlimited — every pre-fn-725 test that omits this must see
    // identical dispatch behavior.
    maxConcurrentJobs: null,
    ...overrides,
  };
}

// A simple deps factory that records all interactions.
interface FakeDepsLog {
  launches: Array<{ argv: string[]; name: string; cwd: string }>;
  emissions: DispatchFailedPayload[];
  dispatchedEmissions: DispatchedPayload[];
  findJobCalls: Array<{ verb: string; id: string; watermark: number }>;
  maxEventIdCalls: number;
  // fn-720: every `recordTimeoutBackstop` call from confirmRunning — a
  // pre-ceiling confirm posts `{rescued:false, stalenessMs:null}`, a
  // ceiling-hit posts `{rescued:true, stalenessMs:<elapsedMs>}`.
  timeoutBackstops: Array<{ rescued: boolean; stalenessMs: number | null }>;
}

interface FakeDepsOptions {
  launch?: (argv: string[], name: string, cwd: string) => Promise<LaunchResult>;
  /**
   * Map of `${verb}::${id}` → FoundJob | null. Returned only when the
   * call's `last_event_id_gt < hit.last_event_id` (so the watermark
   * filter is honored by the fake too).
   */
  jobsByKey?: Map<string, FoundJob>;
  maxEventId?: number;
  now?: number | (() => number);
  pollIntervalMs?: number;
  ceilingMs?: number;
  /**
   * fn-724: control the durable `dispatched-ack` `emitDispatched` returns.
   * - omitted → resolves `{ok:true}` (the happy durable-mint path).
   * - `{ok:false}` (or any `DispatchedAck`) → resolves that ack (insert
   *   failed on main → confirmRunning aborts without launching).
   * - a function → called per emission; return a Promise to model a
   *   never-resolving ack (the ack-timeout abort) or a deferred resolve.
   */
  dispatchedAck?: DispatchedAck | (() => Promise<DispatchedAck>);
}

function makeFakeDeps(opts: FakeDepsOptions = {}): {
  deps: ConfirmRunningDeps;
  log: FakeDepsLog;
  advanceMaxEventId(n: number): void;
  setJobByKey(verb: string, id: string, job: FoundJob): void;
} {
  const log: FakeDepsLog = {
    launches: [],
    emissions: [],
    dispatchedEmissions: [],
    findJobCalls: [],
    maxEventIdCalls: 0,
    timeoutBackstops: [],
  };
  let maxEventId = opts.maxEventId ?? 100;
  const jobsByKey = new Map<string, FoundJob>(opts.jobsByKey ?? []);
  const nowFn: () => number =
    typeof opts.now === "function"
      ? opts.now
      : ((): (() => number) => {
          const v = typeof opts.now === "number" ? opts.now : 1700000000;
          return () => v;
        })();

  const deps: ConfirmRunningDeps = {
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
    async emitDispatched(payload) {
      log.dispatchedEmissions.push({ ...payload });
      // fn-724: model main's durable ack. Default resolves {ok:true}; a
      // function override can return a never-resolving Promise (ack-timeout)
      // or a {ok:false} ack (insert-failed).
      if (typeof opts.dispatchedAck === "function") {
        return opts.dispatchedAck();
      }
      return opts.dispatchedAck ?? { ok: true };
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
    recordTimeoutBackstop(args) {
      log.timeoutBackstops.push({ ...args });
    },
    pollIntervalMs: opts.pollIntervalMs ?? 5,
    ceilingMs: opts.ceilingMs ?? 50,
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

test("fn-756: verbForVerdict never maps to approve — no blocked reason is dispatchable", () => {
  // The approve verb is gone; `verbForVerdict` maps ONLY `ready` → work/close.
  // Every blocked reason (including the now-unproduced job-pending) → null.
  const jp: Verdict = { tag: "blocked", reason: { kind: "job-pending" } };
  expect(verbForVerdict("task", jp)).toBeNull();
  expect(verbForVerdict("close", jp)).toBeNull();
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

// fn-756: the predicate-6.5 git verdicts are no longer produced, but they
// remain in the BlockReason type — `verbForVerdict` returns null for them (as
// for every blocked reason), so even a stale/hand-built git verdict is never
// handed a dispatch.
test("verbForVerdict: git-uncommitted / git-orphans → null (held slot stays undispatchable)", () => {
  const gu: Verdict = { tag: "blocked", reason: { kind: "git-uncommitted" } };
  const go: Verdict = { tag: "blocked", reason: { kind: "git-orphans" } };
  expect(verbForVerdict("task", gu)).toBeNull();
  expect(verbForVerdict("close", gu)).toBeNull();
  expect(verbForVerdict("task", go)).toBeNull();
  expect(verbForVerdict("close", go)).toBeNull();
});

test("fn-700: verbForVerdict('close', blocked:epic-no-tasks) → null (autopilot lock)", () => {
  // Locks the autopilot side to the fn-700 readiness fix: a zero-task epic's
  // close verdict is `blocked:epic-no-tasks`, and (fn-756) NO blocked reason
  // maps to a verb. This guards against a future verdict refactor silently
  // re-opening the dispatch-a-closer-against-an-empty-epic hole — even if a
  // regression made the close row `ready` again, this assertion pins the
  // contract that the closer must NOT be dispatched for an epic-no-tasks
  // verdict.
  const v: Verdict = { tag: "blocked", reason: { kind: "epic-no-tasks" } };
  expect(verbForVerdict("close", v)).toBeNull();
});

test("fn-712: verbForVerdict('task'|'close', blocked:epic-not-materialized) → null (autopilot lock)", () => {
  // Locks the autopilot side to the fn-712 readiness fix: a not-yet-
  // materialized epic (status:null, no EpicSnapshot folded) reports
  // `blocked:epic-not-materialized` on BOTH the per-task and per-close-row
  // paths, and (fn-756) NO blocked reason maps to a verb. So neither a worker
  // NOR a closer can be dispatched against the shell row — the autopilot
  // waits for the same `status IS NOT NULL` materialized state the board uses
  // to surface the epic. This pins the contract against a future verdict
  // refactor.
  const v: Verdict = {
    tag: "blocked",
    reason: { kind: "epic-not-materialized" },
  };
  expect(verbForVerdict("task", v)).toBeNull();
  expect(verbForVerdict("close", v)).toBeNull();
});

test("fn-719: verbForVerdict(monitor-running | monitor-stale) → null (held slot stays undispatchable)", () => {
  // Locks the autopilot side to the fn-719 readiness occupant: a task whose
  // embedded work job carries a live worker-launched monitor renders
  // `running:monitor-running` (or `running:monitor-stale` past the soft TTL).
  // Both are `running` verdicts, so `verbForVerdict` returns null (fn-756: it
  // maps ONLY `ready` → work/close) — the occupied root holds the mutex but
  // is NEVER handed a work/close dispatch. This pins that occupancy never
  // leaks into a dispatch, guarding against a future refactor that might map a
  // `running` verdict to a verb.
  const mr: Verdict = { tag: "running", reason: { kind: "monitor-running" } };
  const ms: Verdict = { tag: "running", reason: { kind: "monitor-stale" } };
  expect(verbForVerdict("task", mr)).toBeNull();
  expect(verbForVerdict("close", mr)).toBeNull();
  expect(verbForVerdict("task", ms)).toBeNull();
  expect(verbForVerdict("close", ms)).toBeNull();
});

test("fn-721: verbForVerdict(dispatch-pending) → null (launch-window slot stays undispatchable)", () => {
  // Locks the autopilot side to the fn-721 readiness occupant: a launched-
  // but-not-yet-bound worker renders `blocked:dispatch-pending` on its row.
  // fn-756: NO blocked reason maps to a verb, so dispatch-pending returns null
  // on BOTH paths — the held mutex slot is never handed a work/close dispatch
  // (occupancy must never leak into a dispatch; the fn-700/fn-719 precedent).
  // This pins the contract against a future verdict-refactor regression.
  const v: Verdict = { tag: "blocked", reason: { kind: "dispatch-pending" } };
  expect(verbForVerdict("task", v)).toBeNull();
  expect(verbForVerdict("close", v)).toBeNull();
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

test("isOccupyingJob: plan_verb mismatch (stale non-work verb shares plan_ref) → no false match", () => {
  // dedup MUST gate on `plan_verb` too — a foreign-verb row (e.g. a stale
  // `approve::id` left in the projection from before fn-756 dropped the verb)
  // that happens to share `plan_ref` with a `work::id` must NOT block the
  // `work` dispatch on the same task id. `plan_verb` is a free `string`
  // column, so a stale verb still loads; the gate is the verb equality, not a
  // whitelist.
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
});

// ---------------------------------------------------------------------------
// reconcile — no-op fast path
// ---------------------------------------------------------------------------

test("reconcile: empty snapshot → empty decision (no-op fast path)", () => {
  const snap = makeSnapshot({});
  const state = makeState();
  const decision = reconcile(snap, state, 0);
  expect(decision.launches).toEqual([]);
});

test("reconcile: paused state suppresses every launch (boots-paused safety)", () => {
  const epic = makeEpic({
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = makeSnapshot({ epics: [epic] });
  const state = makeState({ paused: true });
  const decision = reconcile(snap, state, 0);
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
  const decision = reconcile(snap, makeState(), 0);
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
  const decision = reconcile(snap, makeState(), 0);
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
  const decision = reconcile(snap, makeState(), 0);
  expect(decision.launches[0]?.cwd).toBe("/repo-task");
  // fn-10: no tier-plugin flag ever — the worker command carries no
  // `--plugin-dir`, regardless of tier.
  expect(decision.launches[0]?.workerCommand).not.toContain("--plugin-dir");
});

test("reconcile: tier on a `work` row still rides `plan.tier` but never enters the command (fn-10)", () => {
  const epic = makeEpic({
    tasks: [makeTask({ task_id: "fn-1-foo.1", tier: "max" })],
  });
  const snap = makeSnapshot({ epics: [epic] });
  const decision = reconcile(snap, makeState(), 0);
  // The tier is preserved on the launch plan (board/projection read)…
  expect(decision.launches[0]?.tier).toBe("max");
  // …but no longer threads a `--plugin-dir work-plugins/<tier>` flag into the
  // spawned command — tier routing moved to the `plan:worker-<tier>` agent.
  expect(decision.launches[0]?.workerCommand).not.toContain("--plugin-dir");
  expect(decision.launches[0]?.workerCommand).not.toContain("work-plugins");
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
  const decision = reconcile(snap, state, 0);
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
  const decision = reconcile(snap, makeState(), 0);
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
  const decision = reconcile(snap, makeState(), 0);
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
  const decision = reconcile(snap, makeState(), 0);
  expect(decision.launches).toEqual([]);
});

test("reconcile dedup (fn-674): liveTabKeys on close::<epic> blocks the close-row dispatch", () => {
  // Same shape as the task arm but for the close row — proves the
  // standing arm covers the (verb='close', id=epic_id) shape too. A
  // status:open epic whose single task is worker-done has a `ready` close
  // row; a live `close::<epic>` tab must suppress its dispatch.
  const completedTask: Task = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    runtime_status: "done",
  });
  const epic = makeEpic({ epic_id: "fn-1-foo", tasks: [completedTask] });
  const snap = makeSnapshot({
    epics: [epic],
    liveTabKeys: new Set(["close::fn-1-foo"]),
  });
  const decision = reconcile(snap, makeState(), 0);
  expect(decision.launches.find((p) => p.verb === "close")).toBeUndefined();
});

// ---------------------------------------------------------------------------
// fn-735 — fold-lag-immune re-dispatch cooldown
// ---------------------------------------------------------------------------

test("fn-735 cooldown (work): a fresh stamp suppresses re-dispatch; an expired stamp re-dispatches", () => {
  // The cooldown is the ONLY suppressor here — every projection arm is
  // empty (no jobs, no failedKeys, no liveTabKeys). Stamp `work::id` at
  // t=1000; reconcile at t < 1000+COOLDOWN sees it suppressed, at
  // t >= 1000+COOLDOWN sees it re-dispatchable. Proves the arm bridges the
  // fold-lag gap the projection arms can't see.
  const epic = makeEpic({
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = makeSnapshot({ epics: [epic] });
  const stampedAt = 1000;
  const state = makeState({
    redispatchCooldown: new Map([["work::fn-1-foo.1", stampedAt]]),
  });

  // Inside the window → suppressed.
  expect(
    reconcile(snap, state, stampedAt + REDISPATCH_COOLDOWN_S - 1).launches,
  ).toEqual([]);
  // At/past the window → re-dispatchable.
  const reopened = reconcile(snap, state, stampedAt + REDISPATCH_COOLDOWN_S);
  expect(reopened.launches.map((p) => p.key)).toEqual(["work::fn-1-foo.1"]);
});

test("fn-735 cooldown (close): a fresh stamp suppresses the close-row dispatch", () => {
  // The close-row dispatch site must honor the cooldown too (miss it and
  // close rows DUP-DISPATCH). A ready close row whose `close::<epic>` key is
  // freshly stamped produces no launch.
  const completedTask: Task = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    runtime_status: "done",
  });
  const epic = makeEpic({ tasks: [completedTask] });
  const snap = makeSnapshot({ epics: [epic] });
  const stampedAt = 1000;
  const state = makeState({
    redispatchCooldown: new Map([["close::fn-1-foo", stampedAt]]),
  });

  // Inside the window → no close launch.
  const suppressed = reconcile(snap, state, stampedAt + 1);
  expect(suppressed.launches.find((p) => p.verb === "close")).toBeUndefined();
  // Past the window → close re-dispatches.
  const reopened = reconcile(snap, state, stampedAt + REDISPATCH_COOLDOWN_S);
  const closePlan = reopened.launches.find((p) => p.verb === "close");
  expect(closePlan?.key).toBe("close::fn-1-foo");
});

test("fn-735 cooldown: reconcile NEVER mutates the cooldown Map (purity)", () => {
  // `reconcile` reads the cooldown via `state` but must not write it — the
  // stamp/clear/sweep live entirely in the cycle glue. After a read,
  // the Map is byte-identical.
  const epic = makeEpic({
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = makeSnapshot({ epics: [epic] });
  const state = makeState();
  // A reconcile that DOES dispatch must not stamp the cooldown itself.
  const decision = reconcile(snap, state, 5000);
  expect(decision.launches.map((p) => p.key)).toEqual(["work::fn-1-foo.1"]);
  expect(state.redispatchCooldown.size).toBe(0);
});

test("fn-735 isInCooldown: unit-seconds predicate edge cases", () => {
  const cooldown = new Map<string, number>([["work::x", 1000]]);
  // Absent key → not in cooldown.
  expect(isInCooldown(cooldown, "work::missing", 1000)).toBe(false);
  // Exactly at stamp → in cooldown (0 < COOLDOWN).
  expect(isInCooldown(cooldown, "work::x", 1000)).toBe(true);
  // One second before expiry → still in cooldown.
  expect(
    isInCooldown(cooldown, "work::x", 1000 + REDISPATCH_COOLDOWN_S - 1),
  ).toBe(true);
  // Exactly at expiry → NOT in cooldown (strict `<`).
  expect(isInCooldown(cooldown, "work::x", 1000 + REDISPATCH_COOLDOWN_S)).toBe(
    false,
  );
});

test("fn-765 reapFloorElapsed: unit-seconds floor; first probe always eligible, back-to-back cycles collapse to one", () => {
  // Boots eligible: the closure seeds lastReapAt at -Infinity so the first
  // cycle always probes.
  expect(reapFloorElapsed(Number.NEGATIVE_INFINITY, 1000)).toBe(true);
  // Simulate the closure: stamp at the fired probe, then a back-to-back
  // cycle (same second) is floored OUT — one list-panes for the burst.
  const firedAt = 1000;
  expect(reapFloorElapsed(firedAt, firedAt)).toBe(false);
  // One second before the floor elapses → still floored.
  expect(reapFloorElapsed(firedAt, firedAt + MIN_REAP_INTERVAL_S - 1)).toBe(
    false,
  );
  // Exactly at the floor → eligible again (the next cycle probes).
  expect(reapFloorElapsed(firedAt, firedAt + MIN_REAP_INTERVAL_S)).toBe(true);
});

test("fn-762 cooldown is STRICTLY GREATER than TTL + sweep (unit-seconds; the headroom rationale)", () => {
  // The documented unit trap: a 1000x bug if seconds get compared to ms. The
  // cooldown is unit-SECONDS; the TTL + sweep are unit-MS — divide by 1000
  // before comparing. fn-762: the 2026-06-09 incident triple-dispatched
  // because the cooldown CO-EXPIRED with the 120s TTL while fold lag still
  // outlived both. The window must outlast the WHOLE round-trip: a pending row
  // can survive up to TTL, then the producer-side sweep takes up to one more
  // sweep-granularity tick to clear the phantom. So cooldown > TTL/1000 +
  // sweep/1000 (= 120 + 60 = 180), with headroom.
  const ttlS = PENDING_DISPATCH_TTL_MS / 1000;
  const sweepS = PENDING_DISPATCH_SWEEP_INTERVAL_MS / 1000;
  expect(REDISPATCH_COOLDOWN_S).toBeGreaterThan(ttlS + sweepS);
  // Pin the chosen value so a future TTL/sweep bump that erodes the headroom
  // trips this test.
  expect(REDISPATCH_COOLDOWN_S).toBe(200);
});

test("fn-735 sweep: prunes entries past the window, keeps fresh ones (no unbounded growth)", () => {
  const cooldown = new Map<string, number>([
    ["work::fresh", 1000],
    ["work::stale", 1000],
    ["work::edge", 1000],
  ]);
  // now = 1000 + COOLDOWN → `stale`/`edge` are exactly at/over expiry; only
  // a strictly-fresher entry survives. Sweep at now where `fresh` is still
  // inside the window and `stale` is well past it.
  cooldown.set("work::fresh", 1000 + REDISPATCH_COOLDOWN_S - 1);
  cooldown.set("work::stale", 0);
  cooldown.set("work::edge", 1000);
  sweepRedispatchCooldown(cooldown, 1000 + REDISPATCH_COOLDOWN_S);
  // `fresh` (stamped at 1000+COOLDOWN-1) → age 1 < COOLDOWN → kept.
  expect(cooldown.has("work::fresh")).toBe(true);
  // `stale` (stamped at 0) → age way past COOLDOWN → pruned.
  expect(cooldown.has("work::stale")).toBe(false);
  // `edge` (stamped at 1000) → age exactly COOLDOWN → pruned (>= window).
  expect(cooldown.has("work::edge")).toBe(false);
});

test("fn-735 sweep: empty map is a no-op (no throw)", () => {
  const cooldown = new Map<string, number>();
  expect(() => sweepRedispatchCooldown(cooldown, 99999)).not.toThrow();
  expect(cooldown.size).toBe(0);
});

test("fn-735 runReconcileCycle: stamps the cooldown at dispatch and KEEPS it on the indoubt outcome", async () => {
  // The headline bug: a slow cold-boot `indoubt` (launch.ok but the jobs
  // row never bound inside the ceiling) MUST leave the cooldown stamped, or
  // the next cycle re-dispatches the same slow launch. The stamp is set
  // BEFORE the confirm await, so it survives an `indoubt` resolution.
  const stampNow = 1700000000;
  const { deps, log } = makeFakeDeps({
    // No jobsByKey hit → confirmRunning's poll never finds a job → ceiling
    // elapses → `indoubt`.
    ceilingMs: 5,
    pollIntervalMs: 1,
    now: stampNow,
  });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = makeSnapshot({ epics: [epic] });
  const state = makeState();
  const liveDispatches = new Map<string, LiveDispatch>();
  const decision = reconcile(snap, state, stampNow);
  expect(decision.launches.length).toBe(1);

  await runReconcileCycle(
    decision,
    state,
    liveDispatches,
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );

  // Launch fired, no DispatchFailed (indoubt suppresses it), inFlight
  // released — but the cooldown stamp PERSISTS.
  expect(log.launches.length).toBe(1);
  expect(log.emissions).toEqual([]);
  expect(state.inFlight.size).toBe(0);
  expect(state.redispatchCooldown.get("work::fn-1-foo.1")).toBe(stampNow);
});

test("fn-735 runReconcileCycle: a definitive launch failure CLEARS the cooldown (retry_dispatch path)", async () => {
  // On `launch.ok===false` → DispatchFailed → outcome `failed`, the cooldown
  // entry is deleted so `failedKeys` owns stickiness and a human's
  // retry_dispatch re-dispatches without first waiting out the cooldown.
  const { deps, log } = makeFakeDeps({
    launch: async () => ({ ok: false, error: "zellij ENOENT" }),
  });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = makeSnapshot({ epics: [epic] });
  const state = makeState();
  const liveDispatches = new Map<string, LiveDispatch>();
  const decision = reconcile(snap, state, 0);

  await runReconcileCycle(
    decision,
    state,
    liveDispatches,
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );

  expect(log.emissions.length).toBe(1); // sticky DispatchFailed
  // Cooldown cleared → the key is re-dispatchable (failedKeys, not the
  // cooldown, holds it now).
  expect(state.redispatchCooldown.has("work::fn-1-foo.1")).toBe(false);
});

test("fn-762 runReconcileCycle: a POST-LAUNCH abort KEEPS the cooldown stamp (ghost-worker suppression)", async () => {
  // The launch FIRED, then a mid-poll shutdown aborted the confirm →
  // outcome `aborted-postlaunch`. Unlike a pre-launch abort, the launch
  // happened, so a ghost worker may exist; the stamp MUST persist so a
  // fold-lag-blind re-dispatch can't double-launch the same worktree.
  const stampNow = 1700000000;
  const ctrl = new AbortController();
  const { deps, log } = makeFakeDeps({
    ceilingMs: 50,
    pollIntervalMs: 5,
    now: stampNow,
    // Abort AFTER launch resolves but before the poll loop confirms — the
    // post-launch `signal.aborted` check (or the in-loop one) then fires.
    launch: async () => {
      ctrl.abort();
      return { ok: true };
    },
  });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = makeSnapshot({ epics: [epic] });
  const state = makeState();
  const liveDispatches = new Map<string, LiveDispatch>();
  const decision = reconcile(snap, state, stampNow);
  expect(decision.launches.length).toBe(1);

  await runReconcileCycle(
    decision,
    state,
    liveDispatches,
    "/bin/zsh",
    ctrl.signal,
    deps,
  );

  // Launch fired, no DispatchFailed, no live entry (we never confirmed) — but
  // the stamp PERSISTS (post-launch abort keeps it).
  expect(log.launches.length).toBe(1);
  expect(log.emissions).toEqual([]);
  expect(liveDispatches.has("work::fn-1-foo.1")).toBe(false);
  expect(state.redispatchCooldown.get("work::fn-1-foo.1")).toBe(stampNow);
});

test("fn-762 runReconcileCycle: a PRE-LAUNCH abort CLEARS the cooldown stamp (nothing launched)", async () => {
  // Main's durable insert failed (ack {ok:false}) → confirmRunning aborts
  // WITHOUT launching → outcome `aborted-prelaunch`. The launch never
  // happened, so the stamp is CLEARED (failedKeys/retry_dispatch own the
  // re-dispatch; no ghost to suppress).
  const stampNow = 1700000000;
  const { deps, log } = makeFakeDeps({
    ceilingMs: 50,
    pollIntervalMs: 5,
    now: stampNow,
    dispatchedAck: { ok: false },
  });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = makeSnapshot({ epics: [epic] });
  const state = makeState();
  const liveDispatches = new Map<string, LiveDispatch>();
  const decision = reconcile(snap, state, stampNow);

  await runReconcileCycle(
    decision,
    state,
    liveDispatches,
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );

  // Never launched, no DispatchFailed, stamp CLEARED.
  expect(log.launches.length).toBe(0);
  expect(log.emissions).toEqual([]);
  expect(state.redispatchCooldown.has("work::fn-1-foo.1")).toBe(false);
});

test("fn-762 runReconcileCycle: indoubt RE-STAMPS the cooldown ONCE at resolution (moving timestamp)", async () => {
  // The fn-762 headroom fix: the dispatch-time stamp is up to `ceilingMs`
  // stale by the time an `indoubt` resolves, so it would expire early. The
  // resolution re-stamps it ONCE to the current clock — never compounding.
  // An advancing `now` proves the stamp MOVED (a fixed clock can't tell a
  // re-stamp from a no-op). The clock ticks 1s per call: stamp #1 at dispatch
  // (1000), the emitDispatched ts (1001), then the indoubt re-stamp at
  // resolution (a strictly later tick).
  let clock = 1000;
  const { deps, log } = makeFakeDeps({
    // No jobs row → poll never confirms → ceiling elapses → `indoubt`.
    ceilingMs: 5,
    pollIntervalMs: 1,
    now: () => clock++,
  });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = makeSnapshot({ epics: [epic] });
  const state = makeState();
  const liveDispatches = new Map<string, LiveDispatch>();
  const decision = reconcile(snap, state, 1000);
  expect(decision.launches.length).toBe(1);

  await runReconcileCycle(
    decision,
    state,
    liveDispatches,
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );

  expect(log.launches.length).toBe(1);
  expect(log.emissions).toEqual([]);
  // The stamp MOVED past the dispatch-time value (1000) — re-stamped at the
  // later indoubt-resolution tick.
  const restamped = state.redispatchCooldown.get("work::fn-1-foo.1");
  expect(restamped).toBeDefined();
  expect(restamped).toBeGreaterThan(1000);
});

// ---------------------------------------------------------------------------
// fn-742 — per-epic finalizer guard (close re-dispatch serialization)
// ---------------------------------------------------------------------------
//
// fn-756: `close` is the SOLE finalizer verb (the approve verb is gone), so
// the original close↔approve race is structurally impossible. The guard is
// retained, keyed by epic id, as a fold-lag-immune backstop against a `close`
// re-dispatch (also covered by the same-key fn-735 cooldown).

// A close-row → `close` (ready): a completed task on an epic that is NOT itself
// done → close-row verdict `ready` → verb `close`.
function readyCloseEpic(epicId: string, projectDir: string): Epic {
  return makeEpic({
    epic_id: epicId,
    epic_number: Number(epicId.match(/fn-(\d+)/)?.[1] ?? 1),
    project_dir: projectDir,
    sort_path: epicId,
    tasks: [
      makeTask({
        task_id: `${epicId}.1`,
        epic_id: epicId,
        worker_phase: "done",
        runtime_status: "done",
      }),
    ],
  });
}

test("fn-742/fn-756 isFinalizerVerb: close is the sole finalizer; work + null are not", () => {
  expect(isFinalizerVerb("close")).toBe(true);
  expect(isFinalizerVerb("work")).toBe(false);
  expect(isFinalizerVerb(null)).toBe(false);
});

test("fn-742 isFinalizerGuarded: unit-seconds predicate edge cases", () => {
  const guard = new Map<string, number>([["fn-1-foo", 1000]]);
  // Absent epic → not guarded.
  expect(isFinalizerGuarded(guard, "fn-2-bar", 1000)).toBe(false);
  // Exactly at stamp → guarded (0 < GUARD).
  expect(isFinalizerGuarded(guard, "fn-1-foo", 1000)).toBe(true);
  // One second before expiry → still guarded.
  expect(
    isFinalizerGuarded(guard, "fn-1-foo", 1000 + FINALIZER_GUARD_S - 1),
  ).toBe(true);
  // Exactly at expiry → NOT guarded (strict `<`).
  expect(isFinalizerGuarded(guard, "fn-1-foo", 1000 + FINALIZER_GUARD_S)).toBe(
    false,
  );
});

test("fn-742 guard constant aligns with the fold-lag window (REDISPATCH_COOLDOWN_S)", () => {
  expect(FINALIZER_GUARD_S).toBe(REDISPATCH_COOLDOWN_S);
});

test("fn-742 guard: a stamped close::<epic> suppresses the close re-dispatch for the SAME epic", () => {
  // A ready close-row whose epic id is freshly stamped is suppressed until the
  // window expires (the fold-lag-immune backstop against a `close` re-dispatch).
  const epic = readyCloseEpic("fn-1-foo", "/repo");
  const snap = makeSnapshot({ epics: [epic] });
  const stampedAt = 1000;
  const state = makeState({
    finalizerGuard: new Map([["fn-1-foo", stampedAt]]),
  });

  const suppressed = reconcile(snap, state, stampedAt + 1);
  expect(
    suppressed.launches.find((p) => p.key === "close::fn-1-foo"),
  ).toBeUndefined();
  const reopened = reconcile(snap, state, stampedAt + FINALIZER_GUARD_S);
  expect(reopened.launches.map((p) => p.key)).toEqual(["close::fn-1-foo"]);
});

test("fn-742 guard scope: a stamp for ONE epic does NOT suppress a DIFFERENT epic's finalizer", () => {
  // The guard is per-epic. fn-1-foo's stamp must not bleed into fn-2-bar's
  // close-row — each epic serializes independently.
  const foo = readyCloseEpic("fn-1-foo", "/repo-a");
  const bar = readyCloseEpic("fn-2-bar", "/repo-b");
  const snap = makeSnapshot({ epics: [foo, bar] });
  const stampedAt = 1000;
  const state = makeState({
    finalizerGuard: new Map([["fn-1-foo", stampedAt]]),
  });
  const decision = reconcile(snap, state, stampedAt + 1);
  // fn-1-foo suppressed; fn-2-bar still launches.
  expect(decision.launches.map((p) => p.key)).toEqual(["close::fn-2-bar"]);
});

test("fn-742 guard: reconcile NEVER mutates the finalizer guard (purity)", () => {
  // `reconcile` reads the guard via `state` but must not write it — the
  // stamp/clear/sweep live entirely in the cycle glue.
  const epic = readyCloseEpic("fn-1-foo", "/repo");
  const snap = makeSnapshot({ epics: [epic] });
  const state = makeState();
  const decision = reconcile(snap, state, 5000);
  expect(decision.launches.map((p) => p.key)).toEqual(["close::fn-1-foo"]);
  expect(state.finalizerGuard.size).toBe(0);
});

test("fn-742 sweep: prunes entries past the window, keeps fresh ones (no unbounded growth)", () => {
  const guard = new Map<string, number>([
    ["fn-1-fresh", 1000 + FINALIZER_GUARD_S - 1],
    ["fn-2-stale", 0],
    ["fn-3-edge", 1000],
  ]);
  sweepFinalizerGuard(guard, 1000 + FINALIZER_GUARD_S);
  expect(guard.has("fn-1-fresh")).toBe(true); // age 1 < GUARD → kept
  expect(guard.has("fn-2-stale")).toBe(false); // way past → pruned
  expect(guard.has("fn-3-edge")).toBe(false); // age exactly GUARD → pruned
});

test("fn-742 sweep: empty map is a no-op (no throw)", () => {
  const guard = new Map<string, number>();
  expect(() => sweepFinalizerGuard(guard, 99999)).not.toThrow();
  expect(guard.size).toBe(0);
});

test("fn-742 runReconcileCycle: an epic-finalizer launch STAMPS the guard (keyed by epic id) and KEEPS it on indoubt", async () => {
  // The fold-lag-immune stamp: a close-row finalizer launch stamps the guard
  // BEFORE the confirm await, keyed by EPIC id (not the ${verb}::${id} key), so
  // a slow cold-boot `indoubt` resolution leaves the re-dispatch suppressed.
  const stampNow = 1700000000;
  const { deps, log } = makeFakeDeps({
    ceilingMs: 5,
    pollIntervalMs: 1,
    now: stampNow,
  });
  const epic = readyCloseEpic("fn-1-foo", "/repo");
  const snap = makeSnapshot({ epics: [epic] });
  const state = makeState();
  const liveDispatches = new Map<string, LiveDispatch>();
  const decision = reconcile(snap, state, stampNow);
  expect(decision.launches.map((p) => p.key)).toEqual(["close::fn-1-foo"]);

  await runReconcileCycle(
    decision,
    state,
    liveDispatches,
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );

  expect(log.launches.length).toBe(1);
  expect(state.inFlight.size).toBe(0);
  // Stamp keyed by the EPIC id, persists through indoubt.
  expect(state.finalizerGuard.get("fn-1-foo")).toBe(stampNow);
});

test("fn-742 runReconcileCycle: a task-level work launch does NOT stamp the finalizer guard", async () => {
  // A task-level work launch is not an epic finalizer (isEpicFinalizer unset),
  // so it must leave the guard untouched — otherwise a task launch would lock
  // its epic's close-row.
  const { deps } = makeFakeDeps({
    ceilingMs: 5,
    pollIntervalMs: 1,
    now: 1700000000,
  });
  const epic = makeEpic({
    epic_id: "fn-1-a",
    project_dir: "/repo-a",
    tasks: [makeTask({ task_id: "fn-1-a.1", epic_id: "fn-1-a" })],
  });
  const snap = makeSnapshot({ epics: [epic] });
  const state = makeState();
  const liveDispatches = new Map<string, LiveDispatch>();
  const decision = reconcile(snap, state, 1700000000);
  expect(decision.launches.map((p) => p.key)).toEqual(["work::fn-1-a.1"]);

  await runReconcileCycle(
    decision,
    state,
    liveDispatches,
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );

  // Guard stays empty — no epic finalizer fired.
  expect(state.finalizerGuard.size).toBe(0);
});

test("fn-742 runReconcileCycle: a definitive launch failure CLEARS the finalizer guard (retry path)", async () => {
  // On `launch.ok===false` the finalizer never ran, so the guard entry is
  // deleted — the re-dispatch (and retry_dispatch) need not wait it out.
  const { deps } = makeFakeDeps({
    launch: async () => ({ ok: false, error: "zellij ENOENT" }),
  });
  const epic = readyCloseEpic("fn-1-foo", "/repo");
  const snap = makeSnapshot({ epics: [epic] });
  const state = makeState();
  const liveDispatches = new Map<string, LiveDispatch>();
  const decision = reconcile(snap, state, 0);

  await runReconcileCycle(
    decision,
    state,
    liveDispatches,
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );

  expect(state.finalizerGuard.has("fn-1-foo")).toBe(false);
});

// ---------------------------------------------------------------------------
// fn-721 — pending_dispatches as a cross-sibling readiness occupant
// ---------------------------------------------------------------------------

test("fn-721 reconcile: a pending dispatch demotes a same-epic ready sibling (no double-dispatch)", () => {
  // The cross-sibling occupant fed through `reconcile`'s computeReadiness
  // call. Task 1 has an open `pending_dispatches` row (a worker launched but
  // not yet SessionStart-bound). The new `pendingDispatches` field demotes
  // the same-epic ready sibling task 2 to `dispatch-pending` →
  // single-task-per-epic, so reconcile launches NOTHING for task 2. (Task 1's
  // own key is also suppressed by the same-key `liveTabKeys` arm — set here
  // too, matching how the real loader populates BOTH from one read — so the
  // whole epic produces zero launches while the dispatch is in flight.)
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [
      makeTask({ task_id: "fn-1-foo.1" }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
      }),
    ],
  });
  const pending: PendingDispatch[] = [
    { verb: "work", id: "fn-1-foo.1", dir: "/repo" },
  ];
  const snap = makeSnapshot({
    epics: [epic],
    pendingDispatches: pending,
    liveTabKeys: new Set(["work::fn-1-foo.1"]),
  });
  const decision = reconcile(snap, makeState(), 0);
  expect(decision.launches).toEqual([]);
});

test("fn-721 reconcile: without the pending row the sibling is NOT demoted (control)", () => {
  // Control for the test above: with an empty `pendingDispatches`, the
  // ordinary per-epic mutex lets the FIRST ready task launch. Proves the
  // demotion above is driven by the pending occupant, not the base mutex.
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [
      makeTask({ task_id: "fn-1-foo.1" }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
      }),
    ],
  });
  const snap = makeSnapshot({ epics: [epic], pendingDispatches: [] });
  const decision = reconcile(snap, makeState(), 0);
  expect(decision.launches.map((l) => l.key)).toEqual(["work::fn-1-foo.1"]);
});

// ---------------------------------------------------------------------------
// fn-725 — global max_concurrent_jobs budget gate
// ---------------------------------------------------------------------------
//
// The cap counts `isRootOccupant` verdicts over perTask ∪ perCloseRow ONCE
// per cycle (the baseline) and admits at most `cap - occupied` NEW launches,
// shared across the task + close-row push sites by one decrementing budget.
// Occupants and ready tasks are placed in DISTINCT roots so the per-root
// mutex doesn't pre-empt the budget under test (an occupant + ready task on
// the SAME root would be demoted by the mutex before the budget sees it).

// A `working` job → its done+approved task renders `running:job-running`, a
// real root-occupant that consumes one budget slot.
function occupantEpic(epicId: string, projectDir: string): Epic {
  const taskId = `${epicId}.1`;
  return makeEpic({
    epic_id: epicId,
    epic_number: Number(epicId.match(/fn-(\d+)/)?.[1] ?? 1),
    project_dir: projectDir,
    sort_path: epicId,
    tasks: [
      makeTask({
        task_id: taskId,
        epic_id: epicId,
        worker_phase: "done",
        runtime_status: "done",
        jobs: [
          // Embedded working job → predicate 1 holds the task at
          // `running:job-running`, an `isRootOccupant`.
          {
            job_id: `j-${epicId}`,
            state: "working",
          } as unknown as EmbeddedJob,
        ],
      }),
    ],
  });
}

// A ready `work` task in its own epic+root (so no mutex collision with
// other epics' occupants or ready tasks).
function readyEpic(epicId: string, projectDir: string): Epic {
  return makeEpic({
    epic_id: epicId,
    epic_number: Number(epicId.match(/fn-(\d+)/)?.[1] ?? 1),
    project_dir: projectDir,
    sort_path: epicId,
    tasks: [makeTask({ task_id: `${epicId}.1`, epic_id: epicId })],
  });
}

test("fn-725 cap: cap=2 with 2 root-occupants → zero launches (budget exhausted)", () => {
  // occupied = 2 (both job-running), budget = max(0, 2-2) = 0. A third ready
  // task in its own root is admitted only if budget > 0 — it is not.
  const occA = occupantEpic("fn-1-a", "/repo-a");
  const occB = occupantEpic("fn-2-b", "/repo-b");
  const ready = readyEpic("fn-3-c", "/repo-c");
  const snap = makeSnapshot({ epics: [occA, occB, ready] });
  const decision = reconcile(snap, makeState({ maxConcurrentJobs: 2 }), 0);
  expect(decision.launches).toEqual([]);
});

test("fn-725 cap: cap=2 with 1 occupant + 2 ready → exactly 1 launch", () => {
  // occupied = 1, budget = max(0, 2-1) = 1. Two ready tasks (distinct roots,
  // each first-on-root so the mutex leaves them ready) compete for one slot.
  const occ = occupantEpic("fn-1-a", "/repo-a");
  const ready1 = readyEpic("fn-2-b", "/repo-b");
  const ready2 = readyEpic("fn-3-c", "/repo-c");
  const snap = makeSnapshot({ epics: [occ, ready1, ready2] });
  const decision = reconcile(snap, makeState({ maxConcurrentJobs: 2 }), 0);
  expect(decision.launches.length).toBe(1);
  // The first ready row in board order wins the single slot.
  expect(decision.launches[0]?.key).toBe("work::fn-2-b.1");
});

test("fn-725 cap: a planner-running occupant does NOT consume budget (planner-exempt)", () => {
  // The planner epic renders `running:planner-running` — NOT an
  // `isRootOccupant`, so it must not charge the cap. With cap=1 and one
  // planner + one ready task in another root, the ready task launches.
  const plannerEpic = makeEpic({
    epic_id: "fn-1-plan",
    epic_number: 1,
    project_dir: "/repo-plan",
    sort_path: "fn-1-plan",
    // A working job_link with no embedded work started → planner-running.
    job_links: [
      {
        kind: "creator",
        job_id: "planner-job",
        state: "working",
      } as unknown as Epic["job_links"][number],
    ],
    tasks: [makeTask({ task_id: "fn-1-plan.1", epic_id: "fn-1-plan" })],
  });
  const ready = readyEpic("fn-2-go", "/repo-go");
  const snap = makeSnapshot({ epics: [plannerEpic, ready] });
  const decision = reconcile(snap, makeState({ maxConcurrentJobs: 1 }), 0);
  // The planner's OWN task is held by the per-epic mutex (planner-running),
  // so only the other root's ready task can launch — and it does, proving
  // the planner didn't eat the single budget slot.
  expect(decision.launches.map((l) => l.key)).toEqual(["work::fn-2-go.1"]);
});

test("fn-725 cap: cap=null reproduces pre-change dispatch exactly", () => {
  // No cap → every ready task in its own root launches (the pre-fn-725
  // behavior). Two ready epics, two distinct roots, both launch.
  const ready1 = readyEpic("fn-1-a", "/repo-a");
  const ready2 = readyEpic("fn-2-b", "/repo-b");
  const snap = makeSnapshot({ epics: [ready1, ready2] });
  const decision = reconcile(snap, makeState({ maxConcurrentJobs: null }), 0);
  expect(decision.launches.map((l) => l.key).sort()).toEqual([
    "work::fn-1-a.1",
    "work::fn-2-b.1",
  ]);
});

test("fn-725 cap: the budget is shared across task + close-row push sites (a closer can't blow the cap)", () => {
  // cap=1, one job-running occupant (budget=0). A second epic is fully
  // complete → its close row is ready (a would-be `close` launch). The
  // close-row push is gated by the SAME exhausted budget, so nothing
  // dispatches — the closer can't sneak past the cap.
  const occ = occupantEpic("fn-1-a", "/repo-a");
  const completedTask = makeTask({
    task_id: "fn-2-b.1",
    epic_id: "fn-2-b",
    worker_phase: "done",
    runtime_status: "done",
  });
  const closeEpic = makeEpic({
    epic_id: "fn-2-b",
    epic_number: 2,
    project_dir: "/repo-b",
    sort_path: "fn-2-b",
    tasks: [completedTask],
  });
  const snap = makeSnapshot({ epics: [occ, closeEpic] });
  const decision = reconcile(snap, makeState({ maxConcurrentJobs: 1 }), 0);
  expect(decision.launches.find((p) => p.verb === "close")).toBeUndefined();
  expect(decision.launches).toEqual([]);
});

// ---------------------------------------------------------------------------
// fn-728/fn-756 — the budget cap governs BOTH `work` and `close` (no exemption)
// ---------------------------------------------------------------------------
//
// The fn-728 `approve` cap-exemption is gone with the approve verb (fn-756).
// The fn-725 cap now governs every launch — `work` and `close` both count
// against the budget and both are skipped at `budget <= 0`. There is no longer
// any verb the cap exempts.

test("fn-756 budget: a work and a close row both respect budget<=0 (no exemption)", () => {
  // cap=1, one job-running occupant → budget=0. A ready work row (distinct
  // root) and a ready close row (distinct root) are BOTH budget-gated and
  // neither launches.
  const occ = occupantEpic("fn-1-a", "/repo-a");
  const ready = readyEpic("fn-2-b", "/repo-b");
  const completedTask = makeTask({
    task_id: "fn-3-c.1",
    epic_id: "fn-3-c",
    worker_phase: "done",
    runtime_status: "done",
  });
  const closeEpic = makeEpic({
    epic_id: "fn-3-c",
    epic_number: 3,
    project_dir: "/repo-c",
    sort_path: "fn-3-c",
    tasks: [completedTask],
  });
  const snap = makeSnapshot({ epics: [occ, ready, closeEpic] });
  const decision = reconcile(snap, makeState({ maxConcurrentJobs: 1 }), 0);
  expect(decision.launches).toEqual([]);
});

test("fn-756 budget: with one free slot, the close row launches and consumes it (no work after)", () => {
  // cap=2, one occupant → budget=1. A ready close row launches and decrements
  // the budget to 0; a ready work row in a third root is then budget-gated.
  const occ = occupantEpic("fn-1-a", "/repo-a");
  const completedTask = makeTask({
    task_id: "fn-2-b.1",
    epic_id: "fn-2-b",
    worker_phase: "done",
    runtime_status: "done",
  });
  const closeEpic = makeEpic({
    epic_id: "fn-2-b",
    epic_number: 2,
    project_dir: "/repo-b",
    sort_path: "fn-2-b",
    tasks: [completedTask],
  });
  const ready = readyEpic("fn-3-c", "/repo-c");
  const snap = makeSnapshot({ epics: [occ, closeEpic, ready] });
  const decision = reconcile(snap, makeState({ maxConcurrentJobs: 2 }), 0);
  // The close consumed the one free slot; the work is budget-gated.
  expect(decision.launches.map((l) => l.key)).toEqual(["close::fn-2-b"]);
});

test("fn-721 parity: autopilot reconcile path and the board/CLI computeReadiness path agree", () => {
  // BOTH paths must compute identical verdicts for the same pending set. The
  // autopilot path projects via `projectPendingDispatches` in
  // `loadReconcileSnapshot` then calls `computeReadiness`; the board/CLI path
  // (`subscribeReadiness`) projects via the SAME helper then calls the SAME
  // function. Here we drive both ends through the shared helper from one set
  // of raw wire rows and assert the resulting verdict maps are equal.
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [
      makeTask({ task_id: "fn-1-foo.1" }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
      }),
    ],
  });
  // Raw wire rows as both consumers receive them from the
  // `pending_dispatches` collection.
  const wireRows: Record<string, unknown>[] = [
    {
      verb: "work",
      id: "fn-1-foo.1",
      dir: "/repo",
      dispatched_at: 0,
      last_event_id: 1,
    },
  ];
  const projected = projectPendingDispatches(wireRows);

  // Autopilot reconcile path: the ReconcileSnapshot carries the projected
  // rows; reconcile() forwards them into computeReadiness.
  const snap = makeSnapshot({ epics: [epic], pendingDispatches: projected });
  const autopilotReadiness = computeReadiness(
    snap.epics,
    snap.jobs,
    snap.subagentInvocations,
    snap.gitStatusByProjectDir,
    Number.NEGATIVE_INFINITY,
    snap.pendingDispatches,
  );

  // Board/CLI path: subscribeReadiness builds the same projected set and
  // calls computeReadiness with the same args (modulo the live `now`, which
  // doesn't affect dispatch-pending). Use the same fixed `now` for an exact
  // map comparison.
  const boardReadiness = computeReadiness(
    [epic],
    new Map(),
    [],
    new Map(),
    Number.NEGATIVE_INFINITY,
    projected,
  );

  expect([...autopilotReadiness.perTask.entries()]).toEqual([
    ...boardReadiness.perTask.entries(),
  ]);
  expect([...autopilotReadiness.perCloseRow.entries()]).toEqual([
    ...boardReadiness.perCloseRow.entries(),
  ]);
  // And the verdict is the expected dispatch-pending + demoted sibling.
  expect(autopilotReadiness.perTask.get("fn-1-foo.1")).toEqual({
    tag: "blocked",
    reason: { kind: "dispatch-pending" },
  });
  expect(autopilotReadiness.perTask.get("fn-1-foo.2")).toEqual({
    tag: "blocked",
    reason: { kind: "single-task-per-epic" },
  });
});

// ---------------------------------------------------------------------------
// reconcile — git_status feed no longer gates completion (fn-756 removed 6.5)
// ---------------------------------------------------------------------------

test("fn-756: a status=done epic with a dirty repo is COMPLETED (the git lift no longer gates)", () => {
  // Pre-fn-756 a `status=done` epic with dirty files hit predicate 6.5 on the
  // close row (`git-uncommitted`) and held it open. fn-756 deleted that lift:
  // a `status=done` epic now reaches predicate 1 → `completed`, so its close
  // row produces NO dispatch regardless of the dirty git_status feed.
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    status: "done",
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
  const decision = reconcile(snap, makeState(), 0);
  // No launch at all — the close row is `completed`, not git-blocked.
  expect(decision.launches).toEqual([]);
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

test("confirmRunning IN-DOUBT (fn-724): launch.ok + ceiling elapses, NO jobs row → indoubt, NO DispatchFailed, pending row kept", async () => {
  // fn-724 reclassifies the ceiling-hit-with-successful-launch case. The
  // launch SUCCEEDED (default fake launch returns {ok:true}) but the
  // SessionStart jobs row never landed inside the ceiling. The outcome is
  // UNKNOWN, not failed (zellij execs `claude` cold 24-33s later — maybe
  // past the ceiling), so confirmRunning returns "indoubt" and SUPPRESSES
  // the DispatchFailed emit. The `pending_dispatches` row (emitted + ack'd
  // before launch) is KEPT — the TTL sweep clears it if the bind never
  // arrives. The dispatched mint (emission) still happened exactly once.
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
  expect(outcome).toBe("indoubt");
  // No sticky DispatchFailed — the launch outcome is in-doubt, not failed.
  expect(log.emissions).toEqual([]);
  // The durable Dispatched mint happened once (the pending row that the TTL
  // sweep later clears).
  expect(log.dispatchedEmissions.length).toBe(1);
  expect(log.dispatchedEmissions[0]?.verb).toBe("work");
  expect(log.dispatchedEmissions[0]?.id).toBe("fn-1-foo.1");
});

// ---------------------------------------------------------------------------
// fn-720: confirmRunning timeout-class backstop telemetry
// ---------------------------------------------------------------------------

test("confirmRunning ceiling-hit: posts a timeout rescue with elapsedMs staleness; outcome indoubt, NO DispatchFailed (fn-724)", async () => {
  // Ceiling elapses with NO jobs row → the `timeout`-class backstop RESCUED a
  // stuck dispatch. The telemetry record carries rescued:true and
  // stalenessMs = the elapsed-since-dispatch poll duration (= ceilingMs, since
  // the loop runs full pollIntervalMs ticks up to the ceiling). fn-724: the
  // telemetry rescue record is UNCHANGED, but the outcome is now "indoubt"
  // (launch.ok + no jobs row) and NO DispatchFailed is emitted.
  const { deps, log } = makeFakeDeps({
    maxEventId: 100,
    pollIntervalMs: 5,
    ceilingMs: 20,
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
  expect(outcome).toBe("indoubt");
  // fn-724: NO DispatchFailed on the in-doubt ceiling path.
  expect(log.emissions).toEqual([]);
  // The timeout-backstop telemetry rescue record is unchanged.
  expect(log.timeoutBackstops.length).toBe(1);
  const rec = log.timeoutBackstops[0];
  expect(rec?.rescued).toBe(true);
  // elapsedMs accumulates pollIntervalMs ticks to the ceiling → 20ms.
  expect(rec?.stalenessMs).toBe(20);
});

test("confirmRunning pre-ceiling confirm: bumps the rescued:false denominator (no DispatchFailed)", async () => {
  // The jobs row lands before the ceiling → the ceiling did NOT have to
  // rescue. confirmRunning still calls recordTimeoutBackstop, but with
  // rescued:false and stalenessMs:null — the denominator the rescue RATE
  // divides into. No DispatchFailed emit on the happy path.
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
  expect(log.emissions).toEqual([]); // no DispatchFailed
  expect(log.timeoutBackstops.length).toBe(1);
  const rec = log.timeoutBackstops[0];
  expect(rec?.rescued).toBe(false);
  expect(rec?.stalenessMs).toBeNull();
});

test("confirmRunning aborted: no timeout-backstop record (shutdown is not a rescue)", async () => {
  // A shutdown during the poll resolves "aborted-postlaunch" WITHOUT emitting
  // DispatchFailed — and likewise must NOT post a timeout rescue (the
  // dispatch was never confirmed nor genuinely failed). The abort lands
  // mid-poll, AFTER launch() fired → fn-762 post-launch flavor.
  const { deps, log } = makeFakeDeps({
    maxEventId: 100,
    pollIntervalMs: 5,
    ceilingMs: 1000,
  });
  const ctrl = new AbortController();
  const promise = confirmRunning(
    "work",
    "fn-1-foo.1",
    "/repo",
    ["sh", "-c", "true"],
    ctrl.signal,
    deps,
  );
  // Abort mid-poll.
  setTimeout(() => ctrl.abort(), 8);
  const outcome = await promise;
  expect(outcome).toBe("aborted-postlaunch");
  expect(log.emissions).toEqual([]);
  expect(log.timeoutBackstops).toEqual([]);
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
  // fn-724: the stale row is filtered, the ceiling elapses with launch.ok →
  // "indoubt" (not "failed"); no DispatchFailed. The watermark gate still
  // prevents the stale terminal row from false-confirming as "ok".
  expect(outcome).toBe("indoubt");
  expect(log.emissions).toEqual([]);
});

test("confirmRunning ABORTED: shutdown signal during poll → aborted-postlaunch, no emission", async () => {
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
  // fn-762: the launch fired, then a mid-poll shutdown → post-launch flavor.
  expect(outcome).toBe("aborted-postlaunch");
  expect(log.emissions).toEqual([]); // a shutdown is NOT a sticky failure
});

// ---------------------------------------------------------------------------
// fn-724: durable mint-before-launch (dispatched-ack)
// ---------------------------------------------------------------------------

test("confirmRunning (fn-724): launch() is NOT called until the dispatched-ack resolves", async () => {
  // The keystone race fix. emitDispatched returns a deferred ack that we
  // hold open; the launch MUST NOT fire until we resolve it. This proves
  // the durable mint-before-launch ordering (the fire-and-forget version
  // could launch before the pending_dispatches row was written → fn-627
  // double-dispatch).
  const ackGate = Promise.withResolvers<DispatchedAck>();
  let ackRequested = false;
  const { deps, log, setJobByKey } = makeFakeDeps({
    maxEventId: 100,
    pollIntervalMs: 5,
    ceilingMs: 200,
    dispatchedAck: () => {
      ackRequested = true;
      return ackGate.promise;
    },
  });
  setJobByKey("work", "fn-1-foo.1", { job_id: "j-1", last_event_id: 150 });
  const ctrl = new AbortController();
  const promise = confirmRunning(
    "work",
    "fn-1-foo.1",
    "/repo",
    ["sh", "-c", "true"],
    ctrl.signal,
    deps,
  );
  // Give the microtask queue room to run up to (but not past) the ack await.
  await Bun.sleep(20);
  expect(ackRequested).toBe(true);
  // CRITICAL: launch must NOT have fired while the ack is unresolved.
  expect(log.launches.length).toBe(0);
  // Resolve the durable ack → the launch may now proceed.
  ackGate.resolve({ ok: true });
  const outcome = await promise;
  expect(outcome).toBe("ok");
  expect(log.launches.length).toBe(1);
});

test("confirmRunning (fn-724): ack {ok:false} → no launch, aborted-prelaunch, NO DispatchFailed", async () => {
  // Main's durable insert failed → the dispatch aborts WITHOUT launching.
  // No row landed, so no DispatchFailed (a real worker never spawned). The
  // next reconcile cycle re-attempts. fn-762: nothing launched → pre-launch.
  const { deps, log } = makeFakeDeps({
    maxEventId: 100,
    pollIntervalMs: 5,
    ceilingMs: 200,
    dispatchedAck: { ok: false },
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
  expect(outcome).toBe("aborted-prelaunch");
  expect(log.launches.length).toBe(0); // never launched
  expect(log.emissions).toEqual([]); // no DispatchFailed
  // The mint request was still issued (it's what got rejected by main).
  expect(log.dispatchedEmissions.length).toBe(1);
});

test("confirmRunning (fn-724): ack-wait that never resolves → aborted on signal, no launch", async () => {
  // Models the ack-timeout abort flavor via the shutdown signal: the ack
  // never resolves and the worker aborts. confirmRunning must NOT launch.
  // (The live deps' real DISPATCHED_ACK_TIMEOUT_MS timer is exercised in
  // the worker; here the fake's never-resolving ack is rejected when the
  // confirm is abandoned — we assert launch never fired.)
  const neverGate = Promise.withResolvers<DispatchedAck>();
  const { deps, log } = makeFakeDeps({
    maxEventId: 100,
    pollIntervalMs: 5,
    ceilingMs: 200,
    dispatchedAck: () => neverGate.promise,
  });
  const ctrl = new AbortController();
  const promise = confirmRunning(
    "work",
    "fn-1-foo.1",
    "/repo",
    ["sh", "-c", "true"],
    ctrl.signal,
    deps,
  );
  await Bun.sleep(20);
  // Still parked on the ack — no launch yet.
  expect(log.launches.length).toBe(0);
  // Reject the ack-wait (the timeout/shutdown flavor) → confirm aborts.
  neverGate.reject(new Error("dispatched-ack timeout"));
  const outcome = await promise;
  // fn-762: the ack-wait rejected before launch() → pre-launch flavor.
  expect(outcome).toBe("aborted-prelaunch");
  expect(log.launches.length).toBe(0); // never launched
  expect(log.emissions).toEqual([]); // no DispatchFailed
});

test("ceiling invariant (fn-724): DEFAULT_CEILING_MS < PENDING_DISPATCH_TTL_MS", () => {
  // Load-bearing for the in-doubt path: the producer-side TTL sweep MUST
  // fire AFTER the confirm ceiling, never during it. Were the sweep ≤ the
  // ceiling, it would clear the pending_dispatches row mid-confirm and the
  // slot would re-dispatch (the fn-627 hazard the row exists to prevent).
  expect(DEFAULT_CEILING_MS).toBeLessThan(PENDING_DISPATCH_TTL_MS);
});

// ---------------------------------------------------------------------------
// runReconcileCycle — serialization
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
  const decision = reconcile(snap, state, 0);
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

test("runReconcileCycle: a tiered `work` task launches directly — no work-plugin manifest gate (fn-10)", async () => {
  // fn-10 dropped the pre-launch work-plugin manifest guard along with the
  // `--plugin-dir` flag: tier routing moved to the `plan:worker-<tier>` agent
  // the `/plan:work` skill spawns. A ready `work` task on tier `high` now
  // launches straight through — no DispatchFailed, no manifest probe — and
  // the spawned command carries no `--plugin-dir`.
  const { deps, log, setJobByKey } = makeFakeDeps();
  setJobByKey("work", "fn-1-foo.1", { job_id: "j-1", last_event_id: 200 });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-1-foo.1", tier: "high" })],
    sort_path: "000001",
  });
  const snap = makeSnapshot({ epics: [epic] });
  const state = makeState();
  const liveDispatches = new Map<string, LiveDispatch>();
  const decision = reconcile(snap, state, 0);
  expect(decision.launches.length).toBe(1);

  await runReconcileCycle(
    decision,
    state,
    liveDispatches,
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );

  expect(log.launches.length).toBe(1); // launched, no gate
  expect(log.emissions).toEqual([]); // no DispatchFailed
  expect(liveDispatches.size).toBe(1);
  // The spawned argv carries no tier-plugin flag.
  const body = log.launches[0]?.argv.join(" ") ?? "";
  expect(body).not.toContain("--plugin-dir");
  expect(body).not.toContain("work-plugins");
});

// ---------------------------------------------------------------------------
// buildWorkerCommand parity with cli/autopilot.ts shape
// ---------------------------------------------------------------------------

test("buildWorkerCommand: work / close flag shapes (fn-756: approve verb gone)", () => {
  expect(buildWorkerCommand("work", "fn-1-foo.1", "/repo")).toBe(
    "cd /repo && claude --model sonnet --effort max --name work::fn-1-foo.1 '/plan:work fn-1-foo.1'",
  );
  expect(buildWorkerCommand("close", "fn-1-foo", "/repo")).toBe(
    "cd /repo && claude --model sonnet --effort max --name close::fn-1-foo '/plan:close fn-1-foo'",
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

// ---------------------------------------------------------------------------
// fn-724 — isReapCandidate (pause/boot-pause launch-window reap safety gate)
// ---------------------------------------------------------------------------

function pane(overrides: Partial<ZellijPane> & { id: string }): ZellijPane {
  return { tab_name: "Tab #1", ...overrides };
}

test("isReapCandidate: verb-prefixed name AND an OPEN pending row → reap", () => {
  // work::A still has an open pending_dispatches row (launch-window ghost
  // the autopilot intended pre-pause); its surface IS a reap candidate.
  const open = new Set(["work::fn-724-x.2"]);
  expect(
    isReapCandidate(
      open,
      pane({
        id: "3",
        tab_name: "Tab #4",
        terminal_command: "claude --name work::fn-724-x.2 '/plan:work ...'",
      }),
    ),
  ).toBe(true);
});

test("isReapCandidate: LIVE worker (discharged row) is NEVER a candidate — safety pin", () => {
  // SessionStart already discharged work::B's pending row (it bound a live
  // worker), so work::B is NOT in the open set. Even though its pane is
  // live in list-panes and carries a verb-prefixed name, it must NEVER be
  // reaped. This is the highest-blast-radius guard in the epic.
  const open = new Set(["work::A"]); // work::B discharged → live
  const liveWorkerPane = pane({
    id: "5",
    tab_name: "Tab #5",
    exited: false,
    terminal_command: "claude --name work::B '/plan:work B'",
  });
  expect(isReapCandidate(open, liveWorkerPane)).toBe(false);
  // The still-open sibling IS a candidate, proving the set membership —
  // not pane state — is what gates the close.
  expect(
    isReapCandidate(
      open,
      pane({ id: "3", terminal_command: "claude --name work::A" }),
    ),
  ).toBe(true);
});

test("isReapCandidate: empty open set never reaps (nothing pending → no ghost)", () => {
  const open = new Set<string>();
  expect(
    isReapCandidate(
      open,
      pane({ id: "3", terminal_command: "claude --name work::A" }),
    ),
  ).toBe(false);
});

test("isReapCandidate: pane with no verb-prefixed key (human tab) is never a candidate", () => {
  // A non-worker pane carries no work::/close:: token — even with a non-empty
  // open set it must never match.
  const open = new Set(["work::A"]);
  expect(
    isReapCandidate(
      open,
      pane({ id: "9", tab_name: "Tab #9", terminal_command: "/bin/zsh -l -i" }),
    ),
  ).toBe(false);
});

test("isReapCandidate: work:: and close:: surfaces match when open", () => {
  const open = new Set(["work::fn-1-foo.3", "close::fn-2-bar"]);
  expect(
    isReapCandidate(open, pane({ id: "1", tab_name: "work::fn-1-foo.3" })),
  ).toBe(true);
  expect(
    isReapCandidate(
      open,
      pane({ id: "2", terminal_command: "claude --name close::fn-2-bar" }),
    ),
  ).toBe(true);
});

test("fn-756: an approve:: pane is no longer a dispatch key — never reaped by name", () => {
  // The approve verb is gone; `DISPATCH_KEY_RE` no longer matches `approve::`,
  // so a stale approve pane (left from before the deploy) yields a null key and
  // is never name-matched for reap — the human cleans it up.
  const open = new Set(["approve::fn-1-foo.3"]);
  expect(
    isReapCandidate(open, pane({ id: "1", tab_name: "approve::fn-1-foo.3" })),
  ).toBe(false);
});

test("isReapCandidate: fn-741 live-veto — exited:false pane with an OPEN key is NOT reaped", () => {
  // The 2026-06-08 regression: during the fn-736 hook freeze SessionStart
  // never folded, so work::A's pending row never discharged — its key stays
  // in the open set even though the worker is LIVE (exited:false). The
  // fold-latency-immune veto spares it regardless of set membership.
  const open = new Set(["work::fn-741-x.1"]);
  expect(
    isReapCandidate(
      open,
      pane({
        id: "7",
        exited: false,
        terminal_command: "claude --name work::fn-741-x.1 '/plan:work ...'",
      }),
    ),
  ).toBe(false);
});

test("isReapCandidate: fn-741 — exited true/undefined with an OPEN key still reap (no ghost regression)", () => {
  // Only an explicit `false` vetoes. A true ghost AND an unknown-state pane
  // (zellij omits the field) both still reap when their key is open — the
  // launch-window ghost behavior is preserved.
  const open = new Set(["work::fn-741-x.1"]);
  expect(
    isReapCandidate(
      open,
      pane({
        id: "8",
        exited: true,
        terminal_command: "claude --name work::fn-741-x.1",
      }),
    ),
  ).toBe(true);
  expect(
    isReapCandidate(
      open,
      pane({ id: "9", terminal_command: "claude --name work::fn-741-x.1" }), // exited undefined
    ),
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// fn-727 — isCompletionReapCandidate (completion reap gate)
//
// A SIBLING of isReapCandidate, NOT an overload: this one gates on the
// completed-row-id SET (the `{tag:"completed"}` verdict), keying off the
// `<id>` of a `(work|close)::<id>` pane name — fn-756: a completed task
// authorizes reaping its `work::<id>` pane, a completed epic its `close::<id>`
// pane (the `approve::<id>` surface no longer exists). Pane liveness is NOT the
// authorization (the `{tag:"completed"}` verdict is), but fn-741 layers an
// `exited === false` VETO: a demonstrably-live pane is spared even on a
// completed id. `exited` true/undefined still reap.
// ---------------------------------------------------------------------------

test("isCompletionReapCandidate: a completed task id reaps work::<id>", () => {
  const completed = new Set(["fn-1-foo.3"]);
  expect(
    isCompletionReapCandidate(
      completed,
      pane({ id: "1", tab_name: "work::fn-1-foo.3" }),
    ),
  ).toBe(true);
});

test("isCompletionReapCandidate: a completed epic id reaps close::<id>", () => {
  const completed = new Set(["fn-2-bar"]);
  expect(
    isCompletionReapCandidate(
      completed,
      pane({ id: "1", tab_name: "close::fn-2-bar" }),
    ),
  ).toBe(true);
});

test("fn-756: a completed id does NOT reap an approve:: pane (no such key any more)", () => {
  // A stale `approve::<id>` pane yields a null key (the verb is gone from the
  // regex), so even a completed id never name-matches it.
  const completed = new Set(["fn-1-foo.3"]);
  expect(
    isCompletionReapCandidate(
      completed,
      pane({
        id: "2",
        tab_name: "Tab #2",
        terminal_command:
          "claude --name approve::fn-1-foo.3 '/plan:approve ...'",
      }),
    ),
  ).toBe(false);
});

test("isCompletionReapCandidate: a NON-completed id is never a candidate (not-yet-completed/worker-ended stay open)", () => {
  // The id is not in the completed set — its surface is NOT reaped, regardless
  // of pane state. This is the not-yet-completed / worker-ended hold-open guard.
  const completed = new Set(["fn-1-foo.3"]);
  expect(
    isCompletionReapCandidate(
      completed,
      pane({ id: "5", tab_name: "work::fn-9-other.1" }),
    ),
  ).toBe(false);
  expect(
    isCompletionReapCandidate(
      completed,
      pane({ id: "6", tab_name: "close::fn-9-other" }),
    ),
  ).toBe(false);
});

test("isCompletionReapCandidate: human ad-hoc tab (no dispatch key) is never a candidate", () => {
  const completed = new Set(["fn-1-foo.3"]);
  expect(
    isCompletionReapCandidate(
      completed,
      pane({ id: "9", tab_name: "Tab #9", terminal_command: "/bin/zsh -l -i" }),
    ),
  ).toBe(false);
});

test("isCompletionReapCandidate: empty completed set never reaps", () => {
  const completed = new Set<string>();
  expect(
    isCompletionReapCandidate(
      completed,
      pane({ id: "3", tab_name: "work::fn-1-foo.3" }),
    ),
  ).toBe(false);
});

test("isCompletionReapCandidate: fn-741 live-veto — exited:false pane on a completed id is NOT reaped", () => {
  // fn-741 defense-in-depth: a demonstrably-live pane (zellij reports
  // exited:false) is spared even when its id is in the completed set. This
  // does NOT reinstate the rejected `is_exited==true` rule (inverse
  // polarity) — it blocks ONLY explicit liveness, sparing the pane one
  // extra cycle until it exits.
  const completed = new Set(["fn-1-foo.3"]);
  expect(
    isCompletionReapCandidate(
      completed,
      pane({ id: "2", tab_name: "work::fn-1-foo.3", exited: false }),
    ),
  ).toBe(false);
});

test("isCompletionReapCandidate: exited true/undefined on a completed id still reap (no regression)", () => {
  // Only an explicit `false` vetoes. An exited ghost and an unknown-state
  // pane (zellij omits the field) both still reap on the completed verdict —
  // a worker pane that has wound down reaps on a later list-panes.
  const completed = new Set(["fn-1-foo.3"]);
  expect(
    isCompletionReapCandidate(
      completed,
      pane({ id: "2", tab_name: "work::fn-1-foo.3", exited: true }),
    ),
  ).toBe(true);
  expect(
    isCompletionReapCandidate(
      completed,
      pane({ id: "3", tab_name: "work::fn-1-foo.3" }), // exited undefined
    ),
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// fn-727 — reconcile surfaces completedRowIds (no second computeReadiness)
// ---------------------------------------------------------------------------

test("reconcile: completedRowIds carries worker-done task ids and status-done close-row epic ids", () => {
  // fn-756: a worker-done task → `{tag:"completed"}` perTask verdict → its id
  // in the set. A status-done epic → close-row `{tag:"completed"}` → epic id in
  // the set too. The approval enum no longer participates.
  const completedTask = makeTask({
    task_id: "fn-1-foo.1",
    worker_phase: "done",
    runtime_status: "done",
  });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    status: "done",
    tasks: [completedTask],
  });
  const snap = makeSnapshot({ epics: [epic] });
  const decision = reconcile(snap, makeState(), 0);
  expect(decision.completedRowIds.has("fn-1-foo.1")).toBe(true);
  expect(decision.completedRowIds.has("fn-1-foo")).toBe(true);
});

test("reconcile: a non-completed task id is NOT in completedRowIds", () => {
  // An open task (worker_phase open) is `ready`, never `completed`.
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    status: "open",
    tasks: [makeTask({ task_id: "fn-1-foo.1", worker_phase: "open" })],
  });
  const snap = makeSnapshot({ epics: [epic] });
  const decision = reconcile(snap, makeState(), 0);
  expect(decision.completedRowIds.has("fn-1-foo.1")).toBe(false);
});

// ---------------------------------------------------------------------------
// fn-764 — done epics reach completedRowIds through the REAL
// loadReconcileSnapshot query path.
//
// The fn-727 close-row completion reap was structurally UNREACHABLE: the
// snapshot's epics read carries no wire filter, so the descriptor's
// `default_visible = 1` defaultClause (post-fn-756: `status='open'`) hid a DONE
// epic at the exact flip `evaluateCloseRow`'s `status==='done'` arm needs. These
// tests drive the REAL query path against a seeded sandbox DB (the
// test/collections.test.ts shape — `openDb` + INSERT INTO epics +
// `loadReconcileSnapshot` from the live worker), NOT a hand-rolled snapshot.
// ---------------------------------------------------------------------------

/**
 * Seed one `epics` row directly (mirrors test/collections.test.ts `seedEpic`):
 * only the schema-required columns are populated; `sort_path` defaults to the
 * zero-padded epic_number so the default `sort_path ASC` order is stable.
 */
function seedEpicRow(
  db: Database,
  epic_id: string,
  opts: {
    epic_number: number;
    status: string;
    updated_at?: number;
    last_validated_at?: string | null;
  },
): void {
  db.query(
    `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at, tasks, depends_on_epics, jobs, job_links, sort_path, created_by_closer_of, last_validated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    epic_id,
    opts.epic_number,
    `epic ${epic_id}`,
    "/repo",
    opts.status,
    0,
    opts.updated_at ?? 1,
    "[]",
    "[]",
    "[]",
    "[]",
    String(opts.epic_number).padStart(6, "0"),
    null,
    opts.last_validated_at ?? "2026-05-24T00:00:00Z",
  );
}

/** Run `body` against a fresh sandbox DB, always closing + removing the tmpdir. */
async function withSeededDb(
  body: (db: Database) => Promise<void> | void,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "keeper-autopilot-reap-test-"));
  const dbPath = join(dir, "keeper.db");
  // Migrate the schema, then reopen writable for the test body.
  openDb(dbPath).db.close();
  const { db } = openDb(dbPath, { readonly: false });
  try {
    await body(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("fn-764: a done epic reaches completedRowIds through the REAL loadReconcileSnapshot path", async () => {
  await withSeededDb(async (db) => {
    // A done epic: the default open scope would normally hide it, but the
    // bounded done-epics merge pulls it back into the snapshot.
    seedEpicRow(db, "fn-9-done", { epic_number: 9, status: "done" });
    const snap = await loadReconcileSnapshot(db);
    // The done epic landed in the merged epics list.
    expect(snap.epics.map((e) => e.epic_id)).toContain("fn-9-done");
    // Driven through the REAL reconcile: its close-row `{tag:"completed"}`
    // verdict puts the epic id in completedRowIds — the reap candidate set.
    const decision = reconcile(snap, makeState(), 0);
    expect(decision.completedRowIds.has("fn-9-done")).toBe(true);
  });
});

test("fn-764: done epics in the snapshot yield ZERO dispatches and no mutex occupancy", async () => {
  await withSeededDb(async (db) => {
    // A pile of done epics — every one must produce ONLY a completed close-row
    // verdict. None may dispatch (a launch) or occupy a root-mutex slot. If any
    // dispatch verdict perturbs, this is the FALLBACK trigger named in the spec.
    for (let i = 1; i <= 5; i++) {
      seedEpicRow(db, `fn-${i}-done`, { epic_number: i, status: "done" });
    }
    const snap = await loadReconcileSnapshot(db);
    expect(snap.epics.length).toBe(5);
    const decision = reconcile(snap, makeState(), 0);
    // Zero launches: done epics never dispatch.
    expect(decision.launches).toEqual([]);
    // Every done epic id is a completed close-row (the only verdict they yield).
    for (let i = 1; i <= 5; i++) {
      expect(decision.completedRowIds.has(`fn-${i}-done`)).toBe(true);
    }
  });
});

test("fn-764: the done-epics read is BOUNDED — exactly DONE_EPICS_REAP_LIMIT, most-recently-updated", async () => {
  await withSeededDb(async (db) => {
    // Seed strictly MORE done epics than the limit, with monotonically rising
    // updated_at so the sort order is unambiguous. The merge must carry exactly
    // the limit, and exactly the most-recently-updated ones (fn-748 anti-pattern
    // guard: never O(all done history)).
    const total = DONE_EPICS_REAP_LIMIT + 8;
    for (let i = 1; i <= total; i++) {
      seedEpicRow(db, `fn-${i}-done`, {
        epic_number: i,
        status: "done",
        updated_at: i, // higher i = more recently updated
      });
    }
    const snap = await loadReconcileSnapshot(db);
    // Bounded: exactly the window, never the full done set.
    expect(snap.epics.length).toBe(DONE_EPICS_REAP_LIMIT);
    // The carried set is the most-recently-updated tail (updated_at desc).
    const carried = new Set(snap.epics.map((e) => e.epic_id));
    for (let i = total; i > total - DONE_EPICS_REAP_LIMIT; i--) {
      expect(carried.has(`fn-${i}-done`)).toBe(true);
    }
    // The oldest are dropped (e.g. fn-1, fn-8 are below the cutoff).
    expect(carried.has("fn-1-done")).toBe(false);
    expect(carried.has(`fn-${total - DONE_EPICS_REAP_LIMIT}-done`)).toBe(false);
  });
});

test("fn-764: open epics still resolve and dedup against the done merge (open wins)", async () => {
  await withSeededDb(async (db) => {
    // An open epic resolves via the default scope; a done epic via the merge.
    // Both appear exactly once; the open one is unperturbed by the merge.
    seedEpicRow(db, "fn-1-open", { epic_number: 1, status: "open" });
    seedEpicRow(db, "fn-2-done", { epic_number: 2, status: "done" });
    const snap = await loadReconcileSnapshot(db);
    const ids = snap.epics.map((e) => e.epic_id);
    expect(ids).toContain("fn-1-open");
    expect(ids).toContain("fn-2-done");
    // No duplicate of either id.
    expect(ids.length).toBe(new Set(ids).size);
  });
});

// ---------------------------------------------------------------------------
// fn-751 — computeEligibleEpics (armed-mode transitive upstream closure)
// ---------------------------------------------------------------------------

/** Build a `resolved_epic_deps` entry pointing at `resolvedId` (null=dangling). */
function makeDep(resolvedId: string | null): ResolvedEpicDep {
  return {
    dep_token: resolvedId ?? "dangling-token",
    resolved_epic_id: resolvedId,
    epic_number: null,
    project_basename: null,
    cross_project: false,
    state: resolvedId === null ? "dangling" : "blocked-incomplete",
  };
}

/** Index a list of epics by `epic_id` (the snapshot lookup the helper takes). */
function indexEpics(epics: Epic[]): Map<string, Epic> {
  return new Map(epics.map((e) => [e.epic_id, e]));
}

test("computeEligibleEpics: single armed epic with no deps → {itself}", () => {
  const a = makeEpic({ epic_id: "fn-1-a", resolved_epic_deps: [] });
  const eligible = computeEligibleEpics(new Set(["fn-1-a"]), indexEpics([a]));
  expect([...eligible].sort()).toEqual(["fn-1-a"]);
});

test("computeEligibleEpics: armed B depends on unarmed A → {A, B}", () => {
  const a = makeEpic({ epic_id: "fn-1-a", resolved_epic_deps: [] });
  const b = makeEpic({
    epic_id: "fn-2-b",
    resolved_epic_deps: [makeDep("fn-1-a")],
  });
  const eligible = computeEligibleEpics(
    new Set(["fn-2-b"]),
    indexEpics([a, b]),
  );
  expect([...eligible].sort()).toEqual(["fn-1-a", "fn-2-b"]);
});

test("computeEligibleEpics: deep chain C→B→A pulls the whole upstream", () => {
  const a = makeEpic({ epic_id: "fn-1-a", resolved_epic_deps: [] });
  const b = makeEpic({
    epic_id: "fn-2-b",
    resolved_epic_deps: [makeDep("fn-1-a")],
  });
  const c = makeEpic({
    epic_id: "fn-3-c",
    resolved_epic_deps: [makeDep("fn-2-b")],
  });
  const eligible = computeEligibleEpics(
    new Set(["fn-3-c"]),
    indexEpics([a, b, c]),
  );
  expect([...eligible].sort()).toEqual(["fn-1-a", "fn-2-b", "fn-3-c"]);
});

test("computeEligibleEpics: cyclic deps terminate with the cycle members", () => {
  // A ↔ B (each depends on the other) — a user-authored cycle must not hang.
  const a = makeEpic({
    epic_id: "fn-1-a",
    resolved_epic_deps: [makeDep("fn-2-b")],
  });
  const b = makeEpic({
    epic_id: "fn-2-b",
    resolved_epic_deps: [makeDep("fn-1-a")],
  });
  const eligible = computeEligibleEpics(
    new Set(["fn-1-a"]),
    indexEpics([a, b]),
  );
  expect([...eligible].sort()).toEqual(["fn-1-a", "fn-2-b"]);
});

test("computeEligibleEpics: dangling (null) upstream is skipped, no throw", () => {
  const b = makeEpic({
    epic_id: "fn-2-b",
    resolved_epic_deps: [makeDep(null)],
  });
  const eligible = computeEligibleEpics(new Set(["fn-2-b"]), indexEpics([b]));
  expect([...eligible].sort()).toEqual(["fn-2-b"]);
});

test("computeEligibleEpics: absent (unfolded) upstream id is skipped, no throw", () => {
  // B depends on fn-9-x, which is NOT in the lookup (stale/unfolded).
  const b = makeEpic({
    epic_id: "fn-2-b",
    resolved_epic_deps: [makeDep("fn-9-x")],
  });
  const eligible = computeEligibleEpics(new Set(["fn-2-b"]), indexEpics([b]));
  expect([...eligible].sort()).toEqual(["fn-2-b"]);
});

test("computeEligibleEpics: null resolved_epic_deps array → no edges, no throw", () => {
  const a = makeEpic({ epic_id: "fn-1-a", resolved_epic_deps: null });
  const eligible = computeEligibleEpics(new Set(["fn-1-a"]), indexEpics([a]));
  expect([...eligible].sort()).toEqual(["fn-1-a"]);
});

test("computeEligibleEpics: cross-project upstream is included (no special-casing)", () => {
  const upstream = makeEpic({
    epic_id: "fn-1-other",
    project_dir: "/other-repo",
    resolved_epic_deps: [],
  });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [{ ...makeDep("fn-1-other"), cross_project: true }],
  });
  const eligible = computeEligibleEpics(
    new Set(["fn-2-b"]),
    indexEpics([upstream, b]),
  );
  expect([...eligible].sort()).toEqual(["fn-1-other", "fn-2-b"]);
});

test("computeEligibleEpics: empty armed set → empty result", () => {
  const a = makeEpic({ epic_id: "fn-1-a", resolved_epic_deps: [] });
  const eligible = computeEligibleEpics(new Set(), indexEpics([a]));
  expect(eligible.size).toBe(0);
});

test("computeEligibleEpics: armed id absent from lookup is still in the set", () => {
  // An armed id whose epic hasn't folded yet is eligible via its own
  // membership (we just can't walk its deps).
  const eligible = computeEligibleEpics(new Set(["fn-9-ghost"]), new Map());
  expect([...eligible]).toEqual(["fn-9-ghost"]);
});

// ---------------------------------------------------------------------------
// fn-751 — reconcile armed-mode dispatch gating
// ---------------------------------------------------------------------------

test("reconcile armed: dispatches work only for the eligible set", () => {
  // Armed B (depends on A); C is unarmed and not in B's closure. Distinct
  // project dirs so the single-task-per-root mutex doesn't collapse them.
  const a = makeEpic({
    epic_id: "fn-1-a",
    project_dir: "/repo-a",
    resolved_epic_deps: [],
    tasks: [makeTask({ task_id: "fn-1-a.1", epic_id: "fn-1-a" })],
  });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo-b",
    resolved_epic_deps: [makeDep("fn-1-a")],
    tasks: [makeTask({ task_id: "fn-2-b.1", epic_id: "fn-2-b" })],
  });
  const c = makeEpic({
    epic_id: "fn-3-c",
    project_dir: "/repo-c",
    resolved_epic_deps: [],
    tasks: [makeTask({ task_id: "fn-3-c.1", epic_id: "fn-3-c" })],
  });
  const snap = makeSnapshot({
    epics: [a, b, c],
    mode: "armed",
    armedIds: new Set(["fn-2-b"]),
  });
  const decision = reconcile(snap, makeState(), 0);
  const workIds = decision.launches
    .filter((p) => p.verb === "work")
    .map((p) => p.id)
    .sort();
  // A (B's upstream) is eligible and ready → worked. B is eligible too but
  // readiness dep-blocks it until A is done+approved (the closure's whole
  // point — pull the prerequisite in so it CAN be worked). C (non-eligible)
  // is suppressed by the MODE arm, not readiness.
  expect(workIds).toEqual(["fn-1-a.1"]);
  // Prove C's absence is the MODE arm, not readiness: the SAME fixture in
  // yolo mode works both A and C (C has no deps, so it's ready).
  const yoloIds = reconcile(
    makeSnapshot({ epics: [a, b, c], mode: "yolo", armedIds: new Set() }),
    makeState(),
    0,
  )
    .launches.filter((p) => p.verb === "work")
    .map((p) => p.id)
    .sort();
  expect(yoloIds).toEqual(["fn-1-a.1", "fn-3-c.1"]);
});

test("reconcile armed: an armed epic's unarmed upstream still gets worked", () => {
  const a = makeEpic({
    epic_id: "fn-1-a",
    project_dir: "/repo-a",
    resolved_epic_deps: [],
    tasks: [makeTask({ task_id: "fn-1-a.1", epic_id: "fn-1-a" })],
  });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo-b",
    resolved_epic_deps: [makeDep("fn-1-a")],
    tasks: [makeTask({ task_id: "fn-2-b.1", epic_id: "fn-2-b" })],
  });
  const snap = makeSnapshot({
    epics: [a, b],
    mode: "armed",
    armedIds: new Set(["fn-2-b"]),
  });
  const decision = reconcile(snap, makeState(), 0);
  const workA = decision.launches.find((p) => p.id === "fn-1-a.1");
  expect(workA?.verb).toBe("work");
});

test("reconcile armed: non-eligible epic does NOT decrement budget", () => {
  // cap=1; an armed eligible epic and a non-eligible epic both have a ready
  // task. The non-eligible task must be suppressed ABOVE the budget gate, so
  // the eligible task still gets the single slot.
  const armed = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo-b",
    resolved_epic_deps: [],
    tasks: [makeTask({ task_id: "fn-2-b.1", epic_id: "fn-2-b" })],
  });
  const other = makeEpic({
    epic_id: "fn-1-a",
    project_dir: "/repo-a",
    resolved_epic_deps: [],
    tasks: [makeTask({ task_id: "fn-1-a.1", epic_id: "fn-1-a" })],
  });
  // `other` sorts first in the epic list — if the suppression were BELOW the
  // budget gate it would consume the single slot and starve the armed epic.
  const snap = makeSnapshot({
    epics: [other, armed],
    mode: "armed",
    armedIds: new Set(["fn-2-b"]),
  });
  const decision = reconcile(snap, makeState({ maxConcurrentJobs: 1 }), 0);
  const workIds = decision.launches
    .filter((p) => p.verb === "work")
    .map((p) => p.id);
  expect(workIds).toEqual(["fn-2-b.1"]);
});

test("fn-773 armed: close fires for a disarmed-but-in-flight epic (live work surface)", () => {
  // All tasks completed + epic not yet done → close-row is ready and maps to
  // `close`. The epic is NOT armed (not eligible), but it is IN-FLIGHT: a live
  // `work::<task>` surface (the just-finished worker's tab) is still in the
  // session. `isEpicInFlight` sees that signal, so the close still fires — a
  // disarmed-mid-flight epic finishes cleanly.
  const completedTask = makeTask({
    task_id: "fn-5-disarmed.1",
    epic_id: "fn-5-disarmed",
    worker_phase: "done",
    runtime_status: "done",
  });
  const epic = makeEpic({
    epic_id: "fn-5-disarmed",
    resolved_epic_deps: [],
    tasks: [completedTask],
  });
  const snap = makeSnapshot({
    epics: [epic],
    mode: "armed",
    armedIds: new Set(), // not eligible
    // The just-completed task worker's surface is still live → in-flight.
    liveTabKeys: new Set(["work::fn-5-disarmed.1"]),
  });
  const decision = reconcile(snap, makeState(), 0);
  const closePlan = decision.launches.find((p) => p.verb === "close");
  expect(closePlan).not.toBeUndefined();
  expect(closePlan?.id).toBe("fn-5-disarmed");
});

test("fn-773 armed: close fires for a disarmed-but-in-flight epic (occupying work job)", () => {
  // Same disarmed close-ready epic, in-flight via an OCCUPYING `work::<task>`
  // job (the worker reached `working`/`stopped` but its tab probe is empty).
  // The job-signal arm of `isEpicInFlight` keeps the close firing.
  const completedTask = makeTask({
    task_id: "fn-5-disarmed.1",
    epic_id: "fn-5-disarmed",
    worker_phase: "done",
    runtime_status: "done",
  });
  const epic = makeEpic({
    epic_id: "fn-5-disarmed",
    resolved_epic_deps: [],
    tasks: [completedTask],
  });
  const snap = makeSnapshot({
    epics: [epic],
    mode: "armed",
    armedIds: new Set(),
    jobs: new Map([
      [
        "j-work",
        makeJob({
          job_id: "j-work",
          state: "working",
          plan_verb: "work",
          plan_ref: "fn-5-disarmed.1",
        }),
      ],
    ]),
  });
  const decision = reconcile(snap, makeState(), 0);
  const closePlan = decision.launches.find((p) => p.verb === "close");
  expect(closePlan).not.toBeUndefined();
  expect(closePlan?.id).toBe("fn-5-disarmed");
});

test("fn-773 armed: close fires for an epic in the armed dep-closure", () => {
  // The epic itself is armed (in `eligible`) even with NO live job/surface —
  // the closure-membership arm authorizes its close. Proves the eligible-set
  // signal is independent of the in-flight signals.
  const epic = readyCloseEpic("fn-5-armed", "/repo");
  const snap = makeSnapshot({
    epics: [epic],
    mode: "armed",
    armedIds: new Set(["fn-5-armed"]),
  });
  const decision = reconcile(snap, makeState(), 0);
  const closePlan = decision.launches.find((p) => p.verb === "close");
  expect(closePlan?.id).toBe("fn-5-armed");
});

test("fn-773 armed: a cold close-candidate (never armed, no live job/surface) is suppressed", () => {
  // THE FIX. A close-ready epic that autopilot never touched — not armed, not
  // in any armed epic's dep-closure, no occupying job, no live surface — must
  // NOT get a `close::` dispatch in armed mode (pre-fn-773 the unconditional
  // close exemption burned repeated closers on exactly this row).
  const epic = readyCloseEpic("fn-12-cold", "/repo");
  const snap = makeSnapshot({
    epics: [epic],
    mode: "armed",
    armedIds: new Set(), // never armed, no closure membership
    // No jobs, no liveTabKeys → cold.
  });
  const decision = reconcile(snap, makeState(), 0);
  expect(decision.launches.find((p) => p.verb === "close")).toBeUndefined();
});

test("fn-773 yolo: a cold close-candidate still closes (gate is armed-only)", () => {
  // Byte-for-byte yolo: `eligible` is `undefined`, `armedMode === false`, so
  // the fn-773 arm short-circuits and the same cold epic closes as before.
  const epic = readyCloseEpic("fn-12-cold", "/repo");
  const snap = makeSnapshot({
    epics: [epic],
    mode: "yolo",
    armedIds: new Set(),
  });
  const decision = reconcile(snap, makeState(), 0);
  const closePlan = decision.launches.find((p) => p.verb === "close");
  expect(closePlan?.id).toBe("fn-12-cold");
});

test("fn-773 isEpicInFlight: each in-flight signal flips it true; a cold epic is false", () => {
  const epic = readyCloseEpic("fn-1-foo", "/repo"); // single task fn-1-foo.1
  const noJobs = new Map<string, Job>();
  const noTabs = new Set<string>();

  // Cold — no signal.
  expect(isEpicInFlight(epic, noJobs, noTabs)).toBe(false);

  // Occupying close job.
  const closeJob = new Map([
    [
      "j-c",
      makeJob({ state: "working", plan_verb: "close", plan_ref: "fn-1-foo" }),
    ],
  ]);
  expect(isEpicInFlight(epic, closeJob, noTabs)).toBe(true);

  // Occupying work job on a task.
  const workJob = new Map([
    [
      "j-w",
      makeJob({
        state: "stopped",
        plan_verb: "work",
        plan_ref: "fn-1-foo.1",
      }),
    ],
  ]);
  expect(isEpicInFlight(epic, workJob, noTabs)).toBe(true);

  // Live close surface.
  expect(isEpicInFlight(epic, noJobs, new Set(["close::fn-1-foo"]))).toBe(true);

  // Live work surface on a task.
  expect(isEpicInFlight(epic, noJobs, new Set(["work::fn-1-foo.1"]))).toBe(
    true,
  );

  // A job/surface for a DIFFERENT epic's task does not flip it.
  expect(isEpicInFlight(epic, noJobs, new Set(["work::fn-2-bar.1"]))).toBe(
    false,
  );
});

test("fn-770: armed epic on a SHARED root beats an earlier-sorted unarmed sibling and dispatches", () => {
  // THE DEADLOCK FIX. Two open epics share `/repo`; the earlier-sorted (lower
  // sort_path) `fn-1-unarmed` is NOT armed, `fn-2-armed` is. Pre-fn-770 the
  // armed-blind per-root mutex awarded `/repo` to fn-1 (first ready in sort
  // order), the armed gate then suppressed fn-1's launch (ineligible) AND fn-2
  // was already mutex-demoted → net deadlock, fn-2 never dispatched. With the
  // eligible-priority pass-2, fn-2 (eligible) wins `/repo`, fn-1 is demoted,
  // and exactly one `work` launches for fn-2.
  const unarmed = makeEpic({
    epic_id: "fn-1-unarmed",
    epic_number: 1,
    sort_path: "000001",
    project_dir: "/repo",
    resolved_epic_deps: [],
    tasks: [makeTask({ task_id: "fn-1-unarmed.1", epic_id: "fn-1-unarmed" })],
  });
  const armed = makeEpic({
    epic_id: "fn-2-armed",
    epic_number: 2,
    sort_path: "000002",
    project_dir: "/repo",
    resolved_epic_deps: [],
    tasks: [makeTask({ task_id: "fn-2-armed.1", epic_id: "fn-2-armed" })],
  });
  const snap = makeSnapshot({
    epics: [unarmed, armed],
    mode: "armed",
    armedIds: new Set(["fn-2-armed"]),
  });
  const decision = reconcile(snap, makeState(), 0);
  const workIds = decision.launches
    .filter((p) => p.verb === "work")
    .map((p) => p.id);
  // Exactly the armed epic launches — no double-dispatch, no unarmed launch.
  expect(workIds).toEqual(["fn-2-armed.1"]);
});

test("fn-770: yolo on a shared root is unchanged — earlier-sorted wins the single slot", () => {
  // Same shared-root fixture in yolo mode: `eligible` is `undefined`, so the
  // legacy single-pass mutex runs and the earlier-sorted fn-1 wins `/repo`.
  // fn-2 is mutex-demoted. Exactly one `work` launches, for fn-1 — byte-for-
  // byte pre-fn-770 yolo behaviour (no eligibility reorder).
  const first = makeEpic({
    epic_id: "fn-1-unarmed",
    epic_number: 1,
    sort_path: "000001",
    project_dir: "/repo",
    resolved_epic_deps: [],
    tasks: [makeTask({ task_id: "fn-1-unarmed.1", epic_id: "fn-1-unarmed" })],
  });
  const second = makeEpic({
    epic_id: "fn-2-armed",
    epic_number: 2,
    sort_path: "000002",
    project_dir: "/repo",
    resolved_epic_deps: [],
    tasks: [makeTask({ task_id: "fn-2-armed.1", epic_id: "fn-2-armed" })],
  });
  const snap = makeSnapshot({
    epics: [first, second],
    mode: "yolo",
    armedIds: new Set(),
  });
  const decision = reconcile(snap, makeState(), 0);
  const workIds = decision.launches
    .filter((p) => p.verb === "work")
    .map((p) => p.id);
  expect(workIds).toEqual(["fn-1-unarmed.1"]);
});

test("reconcile yolo: dispatch is unchanged (mode arm is a no-op)", () => {
  // Identical fixture to the armed test, but mode=yolo (default). Even though
  // nothing is armed, EVERY ready task is worked — byte-for-byte pre-fn-751.
  const a = makeEpic({
    epic_id: "fn-1-a",
    project_dir: "/repo-a",
    resolved_epic_deps: [],
    tasks: [makeTask({ task_id: "fn-1-a.1", epic_id: "fn-1-a" })],
  });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo-b",
    resolved_epic_deps: [],
    tasks: [makeTask({ task_id: "fn-2-b.1", epic_id: "fn-2-b" })],
  });
  const snap = makeSnapshot({
    epics: [a, b],
    mode: "yolo",
    armedIds: new Set(), // ignored in yolo
  });
  const decision = reconcile(snap, makeState(), 0);
  const workIds = decision.launches
    .filter((p) => p.verb === "work")
    .map((p) => p.id)
    .sort();
  expect(workIds).toEqual(["fn-1-a.1", "fn-2-b.1"]);
});

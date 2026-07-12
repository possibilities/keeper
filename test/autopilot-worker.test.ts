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
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { computeEligibleEpics } from "../src/armed-closure";
import {
  buildLaunchArgv,
  buildPlannedLaunchSpec,
  buildWorkerCommand,
  buildWorktreeStatusEntries,
  type CheckoutDesyncProbe,
  type ConfirmRunningDeps,
  classifyResolverOutcome,
  classifyWorktreeRepos,
  closerJobFinished,
  computeDeferredEpicIds,
  computeDuplicateEpicNumberGroups,
  computeMergedLaneEntries,
  computeSlotOccupancy,
  computeStaleBaseLaneEntries,
  confirmRunning,
  createDispatchFailedGate,
  createDupEpicNumberTracker,
  createLaneWedgeTracker,
  createSharedCheckoutDesyncTracker,
  createSharedCheckoutDirtyTracker,
  createSharedCheckoutWedgeTracker,
  createStaleBaseLaneTracker,
  createWorktreeDriver,
  DEFAULT_CEILING_MS,
  DISPATCH_FAILED_WATERMARK_SEC,
  type DispatchClearedPayload,
  type DispatchedAck,
  type DispatchedPayload,
  type DispatchFailedPayload,
  type DispatchKey,
  DUP_EPIC_NUMBER_DISTRESS_REASON,
  type DupEpicNumberObservation,
  dupEpicNumberDistressId,
  epicFrameVerdict,
  epicHasActiveResolver,
  epicPresentAndNotDone,
  epicRecoverVerdictById,
  FINALIZER_GUARD_S,
  type FoundJob,
  findShadowingWorkManifest,
  gateWedgedLanesByLiveness,
  gatherTipObservations,
  isBareShellCommand,
  isEpicDoneById,
  isEpicInFlight,
  isFinalizerGuarded,
  isFinalizerVerb,
  isInCooldown,
  isLaneWedgeDistressKey,
  isOccupyingJob,
  isStuckSentinelDistressKey,
  isWorktreeLanePremergeReason,
  isWorktreeRecoverReason,
  LANE_OWNER_STALL_GRACE_SEC,
  LANE_WEDGE_DISTRESS_ID_PREFIX,
  LANE_WEDGE_DISTRESS_REASON,
  LANE_WEDGE_GRACE_SEC,
  type LaneWedgeObservation,
  type LaunchResult,
  type LiveDispatch,
  laneFailuresToClear,
  laneOwnerAliveAndProgressing,
  laneWedgeDistressId,
  loadReconcileSnapshot,
  logMergeGateDeferral,
  type MergeSuiteProbe,
  type MergeSuiteVerdict,
  mergeLaneBaseIntoDefault,
  planTipBaselineRequests,
  prepareWorktreeGeometry,
  probeSharedCheckoutDesync,
  REDISPATCH_COOLDOWN_S,
  type ReconcileSnapshot,
  type ReconcileState,
  readPkgGateCommand,
  reconcile,
  recoverFailureDispatchId,
  recoverFailuresToClear,
  recoverWorktrees,
  refreshSuppressionForOpenPending,
  reposForRecovery,
  runMergeSuiteGate,
  runPackageSuiteGate,
  runReconcileCycle,
  SHARED_CHECKOUT_DESYNC_GRACE_SEC,
  SHARED_CHECKOUT_DIRTY_GRACE_SEC,
  SHARED_CHECKOUT_WEDGE_GRACE_SEC,
  SHARED_DESYNC_DISTRESS_ID_PREFIX,
  SHARED_DESYNC_DISTRESS_REASON,
  SHARED_DIRTY_DISTRESS_ID_PREFIX,
  SHARED_DIRTY_DISTRESS_REASON,
  SHARED_WEDGE_DISTRESS_ID_PREFIX,
  SHARED_WEDGE_DISTRESS_REASON,
  SLOT_RECLAIM_GRACE_SEC,
  type SlotOccupancySignal,
  STALE_BASE_DISTRESS_REASON,
  STALE_BASE_LANE_GRACE_SEC,
  STUCK_SENTINEL_DISTRESS_ID_PREFIX,
  STUCK_SENTINEL_DISTRESS_VERB,
  type StaleBaseLaneObservation,
  sharedCheckoutDistressObservations,
  sharedDesyncDistressId,
  sharedDirtyDistressId,
  sharedWedgeDistressId,
  staleBaseLaneDistressId,
  stuckSentinelJobId,
  stuckSentinelOrphansToClear,
  sweepFinalizerGuard,
  sweepRedispatchCooldown,
  type TipObservation,
  verbForVerdict,
  WORKER_EFFORT,
  WORKER_MODEL,
  WORKTREE_FINALIZE_ID_PREFIX,
  WORKTREE_FINALIZE_SUITE_RED_REASON,
  type WorktreeDriver,
  type WorktreeLaunchInfo,
  type WorktreeRecoveryEscalation,
  type WorktreeRecoveryFailure,
  type WorktreeRecoveryResolution,
  type WorktreeRepoResolution,
  worktreeFinalizeDispatchId,
  worktreeRecoverDispatchId,
  worktreeRecoverEpicDispatchId,
} from "../src/autopilot-worker";
import type { SpawnFn } from "../src/baseline-worker";
import { DONE_EPICS_REAP_WINDOW_SEC } from "../src/collections";
import {
  GIT_SPAWN_TIMEOUT_CODE,
  type GitExecOptions,
  type GitRunner,
} from "../src/commit-work/git-exec";
import {
  MERGE_ESCALATION_REASON_TOKEN,
  PENDING_DISPATCH_SWEEP_INTERVAL_MS,
  PENDING_DISPATCH_TTL_MS,
  shouldEscalateMergeConflict,
} from "../src/daemon";
import { DEFAULT_MAX_CONCURRENT_JOBS, openDb } from "../src/db";
import {
  isRetryableDispatchKey,
  parseDispatchKey,
} from "../src/dispatch-command";
import type { LaunchSpec, PaneInfo } from "../src/exec-backend";
import {
  computeReadiness,
  type PendingDispatch,
  type Verdict,
} from "../src/readiness";
import {
  computeLandedEpicIds,
  projectPendingDispatches,
} from "../src/readiness-client";
import { loadReadinessInputs } from "../src/readiness-inputs";
import { readBootStatus } from "../src/server-worker";
import type {
  EmbeddedJob,
  Epic,
  Job,
  ResolvedEpicDep,
  Task,
} from "../src/types";
import { worktreePathFor } from "../src/worktree-plan";
import {
  argvHas,
  argvStartsWith,
  type FakeGitRule,
  fakeAsyncGit,
} from "./helpers/fake-git";

// A clean shared checkout has NO in-progress pseudo-ref present. mergeReadiness
// now probes these via `rev-parse --verify --quiet <REF>`; real git exits 1 on
// each for a settled tree, so the finalize/merge fakes below (whose broad
// `rev-parse --verify → exists` catch-all would otherwise answer "present") must
// report them absent or mergeReadiness would misread a clean checkout as
// mid-merge / in-progress.
const IN_PROGRESS_PSEUDO_REFS = [
  "MERGE_HEAD",
  "MERGE_AUTOSTASH",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
];
const isInProgressPseudoRefProbe = (args: string[]): boolean =>
  args[0] === "rev-parse" &&
  args.includes("--verify") &&
  IN_PROGRESS_PSEUDO_REFS.some((r) => args.includes(r));

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
    blocks_closing_of: null,
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
  const snapshot: ReconcileSnapshot = {
    epics: [],
    jobs: new Map(),
    subagentInvocations: [],
    gitStatusByProjectDir: new Map(),
    failedKeys: new Set(),
    recoverFailureIds: new Set(),
    finalizeFailureIds: new Set(),
    // Slot-occupancy: default no OPEN slot rows so the slot pass mints no clears in
    // pre-existing tests; the slot tests override it to drive the level-clear.
    slotOccupancyFailures: [],
    liveTabKeys: new Set(),
    // fn-811: read-time backend liveness. Default `null` (probe unavailable) so
    // every pre-fn-811 test keeps the old stopped-always-occupies behavior; the
    // liveness-gated tests override it with a live-pane set.
    livePaneIds: null,
    // Slot-occupancy foreground-command map, null in lockstep with `livePaneIds`
    // (degraded probe) so the slot pass stays inert; the slot tests override both.
    paneCommandById: null,
    // fn-1200: the producer-proved dead-session set. Default EMPTY so every
    // pre-fn-1200 test keeps the bare-shell-only reclaim behavior; the
    // proven-dead slot tests override it.
    provenDeadJobIds: new Set<string>(),
    // fn-721: the launch-window occupancy set feeding the cross-sibling
    // `dispatch-pending` occupant. Default empty; tests that exercise the
    // occupant override it.
    pendingDispatches: [],
    // fn-751: autopilot mode + armed set. Default `yolo` / empty so every
    // pre-fn-751 test sees byte-for-byte identical dispatch behavior; the
    // armed-mode tests override these.
    mode: "yolo",
    armedIds: new Set(),
    // fn-905: the per-root unseeded-git set. Default EMPTY (every root seeded)
    // so every pre-fn-905 test sees the normal dispatch behavior; the
    // unseeded-gate tests override it with the roots to gate.
    unseededRoots: new Set<string>(),
    // fn-937 / ADR 0040: the `work`- and `close`-row `--model`/`--effort` resolved
    // producer-side from the `dispatch:` table, COALESCING onto the WORKER_*
    // constants. `close` is settable independently of `work`. Default both pairs to
    // the constants so every pre-existing test sees byte-for-byte identical dispatch;
    // the dispatch-override tests set these explicitly.
    workModel: WORKER_MODEL,
    workEffort: WORKER_EFFORT,
    closeModel: WORKER_MODEL,
    closeEffort: WORKER_EFFORT,
    // The cycle's host-matrix snapshot. Default to a valid claude-only axis set
    // (opus/sonnet × the five-rung effort axis) so every pre-existing dispatch test
    // composes the same `workers/<model>-<effort>` cells; the bad-matrix and ragged
    // tests override it with a four-state failure or a per-model effort map.
    hostMatrix: {
      ok: true,
      models: ["opus", "sonnet"],
      effortsByModel: new Map(),
      efforts: ["low", "medium", "high", "xhigh", "max"],
    },
    // fn-953: the runtime-settable cap, resolved snapshot-time `column ?? DEFAULT`.
    // Default unlimited (`null`) so a snapshot-driven reconcile sees the same
    // behavior as the pre-fn-953 unlimited default; the cap tests drive it via
    // `makeState({ maxConcurrentJobs })` (the cap rides `state` in `reconcile`).
    maxConcurrentJobs: null,
    // fn-954: the per-root dispatch concurrency count, resolved snapshot-time
    // `column ?? DEFAULT` (= 1 = the one-task-per-root mutex). RESERVED for task
    // .2's allocator; carried but unconsumed here.
    maxConcurrentPerRoot: 1,
    // fn-959: the durable worktree-mode toggle, resolved snapshot-time
    // `worktree_mode truthy`. Default OFF (`false`) so every pre-fn-959 test sees
    // byte-for-byte identical dispatch; RESERVED for the downstream worktree tasks.
    worktreeMode: false,
    // fn-978: the per-epic resolved-repo classification. Filled in below (post
    // `...overrides`) via IDENTITY resolution over the final epics — each raw root
    // is its own toplevel, byte-identical to the pre-fn-978 raw-string geometry —
    // unless a test pins it explicitly (to drive subdir/symlink/unresolved cases).
    worktreeRepoByEpicId: new Map(),
    ...overrides,
  };
  if (overrides.worktreeRepoByEpicId === undefined) {
    snapshot.worktreeRepoByEpicId = classifyWorktreeRepos(
      snapshot.epics,
      (r) => r,
    );
  }
  return snapshot;
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
    // fn-954: per-root count N. Default 1 = the one-task-per-root mutex.
    maxConcurrentPerRoot: 1,
    ...overrides,
  };
}

// A simple deps factory that records all interactions.
interface FakeDepsLog {
  launches: Array<{
    argv: string[];
    name: string;
    cwd: string;
    spec?: LaunchSpec;
  }>;
  emissions: DispatchFailedPayload[];
  clears: DispatchClearedPayload[];
  dispatchedEmissions: DispatchedPayload[];
  findJobCalls: Array<{ verb: string; id: string; watermark: number }>;
  maxEventIdCalls: number;
  // fn-720: every `recordTimeoutBackstop` call from confirmRunning — a
  // pre-ceiling confirm posts `{rescued:false, stalenessMs:null}`, a
  // ceiling-hit posts `{rescued:true, stalenessMs:<elapsedMs>}`.
  timeoutBackstops: Array<{ rescued: boolean; stalenessMs: number | null }>;
}

interface FakeDepsOptions {
  launch?: (
    argv: string[],
    name: string,
    cwd: string,
    spec?: LaunchSpec,
  ) => Promise<LaunchResult>;
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
  /**
   * Producer-side cwd existence probe. Tests use fixture paths like `/epic/dir`
   * that never exist on disk, so the default is `() => true` (every cwd present)
   * — pass `() => false` (or a per-path predicate) to drive the `cwd-missing`
   * block-with-reason branch in `runReconcileCycle`.
   */
  dirExists?: (dir: string) => boolean;
  /**
   * fn-959 — the injected worktree driver. ABSENT (the default) leaves the
   * worktree producer step OFF so every pre-fn-959 test is byte-identical; pass a
   * fake (see `makeFakeWorktreeDriver`) to drive the provision / finalize /
   * on-default-branch assertion paths.
   */
  worktree?: WorktreeDriver;
  /**
   * Realpath-normalizer for the worktree lane env. Defaults to identity so
   * fixture paths stay byte-stable (no real-FS stat in the fast tier); pass a
   * mapper (e.g. `/var/`→`/private/var/`) to assert the normalization seam.
   */
  realpath?: (p: string) => string;
  /**
   * fn-990 — the MAIN-projection done-ness probe threaded into
   * `worktree.finalizeEpic`. Defaults to `() => true` (the fake worktree driver
   * ignores it anyway); override to drive a crashed-closer (false) gate path.
   */
  isEpicDone?: (epicId: string) => Promise<boolean>;
  /**
   * Scan-dir shadow probe. Defaults to `() => null` (no shadowing `work` plugin)
   * so the fast tier never reads the real launcher plugin config; return a
   * manifest path to drive the `work-plugin-shadowed` DispatchFailed branch.
   */
  probeShadowingWorkManifest?: () => string | null;
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
    clears: [],
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
    async launch(argv, name, cwd, spec) {
      log.launches.push({ argv: [...argv], name, cwd, spec });
      if (opts.launch) {
        return opts.launch(argv, name, cwd, spec);
      }
      return { ok: true };
    },
    emitDispatchFailed(payload) {
      log.emissions.push({ ...payload });
    },
    emitDispatchCleared(payload) {
      log.clears.push({ ...payload });
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
    dirExists: opts.dirExists ?? (() => true),
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
    worktree: opts.worktree,
    realpath: opts.realpath ?? ((p: string) => p),
    probeShadowingWorkManifest: opts.probeShadowingWorkManifest ?? (() => null),
    isEpicDone: opts.isEpicDone ?? (async () => true),
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

test("isOccupyingJob: working state occupies regardless of pane liveness", () => {
  const jobs = new Map<string, Job>();
  jobs.set(
    "j-1",
    makeJob({
      job_id: "j-1",
      plan_verb: "work",
      plan_ref: "fn-1-foo.1",
      state: "working",
      backend_exec_pane_id: "%1",
    }),
  );
  // A `working` row occupies whether or not its pane shows in the probe — the
  // liveness gate only narrows the `stopped` arm.
  expect(isOccupyingJob(jobs, "work", "fn-1-foo.1", new Set())).toBe(true);
  expect(isOccupyingJob(jobs, "work", "fn-1-foo.1", null)).toBe(true);
});

test("fn-811 isOccupyingJob: stopped-with-LIVE-pane still occupies", () => {
  const jobs = new Map<string, Job>();
  jobs.set(
    "j-1",
    makeJob({
      job_id: "j-1",
      plan_verb: "work",
      plan_ref: "fn-1-foo.1",
      state: "stopped",
      backend_exec_pane_id: "%7",
    }),
  );
  // A parked-but-alive session (its pane is in the live set) keeps occupying —
  // dispatching here would land a SECOND worker on the same task.
  expect(isOccupyingJob(jobs, "work", "fn-1-foo.1", new Set(["%7"]))).toBe(
    true,
  );
});

test("fn-811 isOccupyingJob: stopped-with-DEAD-pane no longer occupies (the wedge fix)", () => {
  const jobs = new Map<string, Job>();
  jobs.set(
    "j-1",
    makeJob({
      job_id: "j-1",
      plan_verb: "work",
      plan_ref: "fn-1-foo.1",
      state: "stopped",
      backend_exec_pane_id: "%7",
    }),
  );
  // The worker ended its turn without completing the task and its pane is gone
  // (absent from the live set) — the slot must free for re-dispatch instead of
  // wedging forever.
  expect(isOccupyingJob(jobs, "work", "fn-1-foo.1", new Set(["%99"]))).toBe(
    false,
  );
  // No pane id at all is likewise not live-provable here.
  expect(isOccupyingJob(jobs, "work", "fn-1-foo.1", new Set())).toBe(false);
});

test("fn-1095 epicHasActiveResolver: true only for a LIVE `resolve::<epic>` job, keyed per-epic", () => {
  const jobs = new Map<string, Job>();
  jobs.set(
    "j-1",
    makeJob({
      job_id: "j-1",
      plan_verb: "resolve",
      plan_ref: "fn-1-foo",
      state: "working",
      backend_exec_pane_id: "%1",
    }),
  );
  // A live resolver for fn-1-foo → excluded; an unrelated epic is untouched (the
  // per-epic scope, not a global flag).
  expect(epicHasActiveResolver(jobs, "fn-1-foo", null)).toBe(true);
  expect(epicHasActiveResolver(jobs, "fn-2-bar", null)).toBe(false);
});

test("fn-1095 epicHasActiveResolver: a reaped/terminal resolver no longer excludes (auto-lift on crash/exit)", () => {
  const jobs = new Map<string, Job>();
  // The resolver's pane is DEAD (absent from the live set) and the job is stopped —
  // a crashed/exited resolver. The exclusion must lift so recover reclaims the lane.
  jobs.set(
    "j-1",
    makeJob({
      job_id: "j-1",
      plan_verb: "resolve",
      plan_ref: "fn-1-foo",
      state: "stopped",
      backend_exec_pane_id: "%7",
    }),
  );
  expect(epicHasActiveResolver(jobs, "fn-1-foo", new Set(["%99"]))).toBe(false);
  // A `work`/`close` job for the same id is NOT a resolver — never excludes recover.
  const other = new Map<string, Job>();
  other.set(
    "j-2",
    makeJob({
      job_id: "j-2",
      plan_verb: "close",
      plan_ref: "fn-1-foo",
      state: "working",
      backend_exec_pane_id: "%2",
    }),
  );
  expect(epicHasActiveResolver(other, "fn-1-foo", null)).toBe(false);
});

test("classifyResolverOutcome: no resolve job row is not terminal (launch window — the escalation waits)", () => {
  const jobs = new Map<string, Job>();
  // A close job for the epic is NOT a resolver — never a terminal resolver verdict.
  jobs.set(
    "j-1",
    makeJob({
      job_id: "j-1",
      plan_verb: "close",
      plan_ref: "fn-1-foo",
      state: "ended",
    }),
  );
  expect(classifyResolverOutcome(jobs, "fn-1-foo")).toEqual({
    terminal: false,
  });
});

test("classifyResolverOutcome: a working (turn-active) resolver is not terminal — the deconflict defers", () => {
  const working = new Map<string, Job>();
  working.set(
    "j-1",
    makeJob({
      job_id: "j-1",
      plan_verb: "resolve",
      plan_ref: "fn-1-foo",
      state: "working",
      backend_exec_pane_id: "%1",
    }),
  );
  expect(classifyResolverOutcome(working, "fn-1-foo")).toEqual({
    terminal: false,
  });
});

test("classifyResolverOutcome: a stopped-idle resolver reads terminal/declined — turn-active occupancy, not pane-liveness (the epic bug fix)", () => {
  // A one-shot `/plan:resolve` session idles `stopped` after its turn. Under the OLD
  // pane-liveness rule a stopped resolver with a live/unprobeable pane counted as LIVE
  // and never read terminal, STARVING the deconflict dispatch forever. Turn-active
  // occupancy reads the yielded turn as terminal so the deconflict can follow.
  const stopped = new Map<string, Job>();
  stopped.set(
    "j-1",
    makeJob({
      job_id: "j-1",
      plan_verb: "resolve",
      plan_ref: "fn-1-foo",
      state: "stopped",
      backend_exec_pane_id: "%7",
    }),
  );
  expect(classifyResolverOutcome(stopped, "fn-1-foo")).toEqual({
    terminal: true,
    verdict: "declined",
  });
});

test("classifyResolverOutcome: a killed or ended resolver is terminal/died (abnormal CLI exit — a one-shot session should idle stopped)", () => {
  const killed = new Map<string, Job>();
  killed.set(
    "j-1",
    makeJob({
      job_id: "j-1",
      plan_verb: "resolve",
      plan_ref: "fn-1-foo",
      state: "killed",
    }),
  );
  expect(classifyResolverOutcome(killed, "fn-1-foo")).toEqual({
    terminal: true,
    verdict: "died",
  });
  const ended = new Map<string, Job>();
  ended.set(
    "j-1",
    makeJob({
      job_id: "j-1",
      plan_verb: "resolve",
      plan_ref: "fn-1-foo",
      state: "ended",
    }),
  );
  expect(classifyResolverOutcome(ended, "fn-1-foo")).toEqual({
    terminal: true,
    verdict: "died",
  });
});

test("classifyResolverOutcome: a working resolver defers even beside a stopped sibling (live wins)", () => {
  // A stale stopped resolver row from a prior turn plus a fresh working one → the live
  // turn wins, so the deconflict still defers. Instance scoping (daemon side) narrows
  // the row set per incident; here the classifier's live-wins invariant is proven.
  const jobs = new Map<string, Job>();
  jobs.set(
    "j-old",
    makeJob({
      job_id: "j-old",
      plan_verb: "resolve",
      plan_ref: "fn-1-foo",
      state: "stopped",
      backend_exec_pane_id: "%7",
    }),
  );
  jobs.set(
    "j-new",
    makeJob({
      job_id: "j-new",
      plan_verb: "resolve",
      plan_ref: "fn-1-foo",
      state: "working",
      backend_exec_pane_id: "%8",
    }),
  );
  expect(classifyResolverOutcome(jobs, "fn-1-foo")).toEqual({
    terminal: false,
  });
});

test("classifyResolverOutcome: keyed per-epic — a terminal resolver for another epic never speaks for this one", () => {
  const jobs = new Map<string, Job>();
  jobs.set(
    "j-1",
    makeJob({
      job_id: "j-1",
      plan_verb: "resolve",
      plan_ref: "fn-2-bar",
      state: "ended",
    }),
  );
  // No resolve row for fn-1-foo → not terminal (its escalation still waits).
  expect(classifyResolverOutcome(jobs, "fn-1-foo")).toEqual({
    terminal: false,
  });
});

test("fn-811 isOccupyingJob: null livePaneIds (degraded probe) keeps stopped occupying", () => {
  const jobs = new Map<string, Job>();
  jobs.set(
    "j-1",
    makeJob({
      job_id: "j-1",
      plan_verb: "work",
      plan_ref: "fn-1-foo.1",
      state: "stopped",
      backend_exec_pane_id: "%7",
    }),
  );
  // Probe unavailable — fall back to the conservative pre-liveness behavior so
  // an un-probeable cycle never double-dispatches.
  expect(isOccupyingJob(jobs, "work", "fn-1-foo.1", null)).toBe(true);
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
  expect(isOccupyingJob(jobs, "work", "fn-1-foo.1", null)).toBe(false);
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
  expect(isOccupyingJob(jobs, "work", "fn-1-foo.1", null)).toBe(false);
});

// ---------------------------------------------------------------------------
// isBareShellCommand — the dead-claude shell-tail signature
// ---------------------------------------------------------------------------

test("isBareShellCommand: known shells (incl. login `-` forms) are bare shells", () => {
  for (const cmd of [
    "sh",
    "bash",
    "zsh",
    "fish",
    "dash",
    "ksh",
    "tcsh",
    "csh",
  ]) {
    expect(isBareShellCommand(cmd)).toBe(true);
    // The login-shell argv0 `-` prefix is stripped before the lookup.
    expect(isBareShellCommand(`-${cmd}`)).toBe(true);
  }
});

test("isBareShellCommand: a live claude worker is NOT a bare shell (never reclaim)", () => {
  // The catastrophic over-match guard: a running claude reads as its own process,
  // never a shell, so the criterion can never classify a live session as dead.
  for (const cmd of [
    "claude",
    "node",
    "bun",
    "vim",
    "git",
    "",
    "unknown-cmd",
  ]) {
    expect(isBareShellCommand(cmd)).toBe(false);
  }
  // A missing command entry (probe degraded / pane gone) is "cannot prove dead".
  expect(isBareShellCommand(undefined)).toBe(false);
});

// ---------------------------------------------------------------------------
// computeSlotOccupancy — visibility + provable-dead reclaim + level-clear
// ---------------------------------------------------------------------------

/** One stopped occupant holding `(verb, id)`'s slot, with an overridable pane
 *  command / age. Returns the three snapshot liveness fields the pass reads. */
function oneOccupant(over: {
  verb?: "work" | "close";
  id?: string;
  state?: string;
  pane?: string;
  command?: string;
  updated_at?: number;
}): {
  jobs: Map<string, Job>;
  livePaneIds: Set<string>;
  paneCommandById: Map<string, string>;
} {
  const pane = over.pane ?? "%7";
  const jobs = new Map<string, Job>([
    [
      "j",
      makeJob({
        job_id: "j",
        plan_verb: over.verb ?? "close",
        plan_ref: over.id ?? "fn-1-foo",
        state: over.state ?? "stopped",
        backend_exec_pane_id: pane,
        updated_at: over.updated_at ?? 800,
      }),
    ],
  ]);
  return {
    jobs,
    livePaneIds: new Set([pane]),
    paneCommandById: new Map([[pane, over.command ?? "zsh"]]),
  };
}

/** The pass input with sane defaults (now=1000, wanted, playing, no open rows). */
function slotInput(
  over: Partial<Parameters<typeof computeSlotOccupancy>[0]>,
): Parameters<typeof computeSlotOccupancy>[0] {
  return {
    jobs: new Map(),
    livePaneIds: new Set<string>(),
    paneCommandById: new Map<string, string>(),
    openSlotFailures: [],
    wantsDispatch: () => true,
    paused: false,
    now: 1000,
    ...over,
  };
}

test("computeSlotOccupancy: dead (stopped + bare shell + grace elapsed) → reclaim + slot-reclaimed", () => {
  // idle 200s ≥ the 120s default grace, pane foreground is the bare shell tail.
  const occ = oneOccupant({ command: "zsh", updated_at: 800 });
  const out = computeSlotOccupancy(slotInput(occ));
  expect(out.failures).toHaveLength(1);
  const sig: SlotOccupancySignal = out.failures[0];
  expect(sig.verb).toBe("close");
  expect(sig.id).toBe("fn-1-foo");
  expect(sig.reclaimPaneId).toBe("%7"); // the kill is issued
  expect(sig.reason.startsWith("slot-reclaimed")).toBe(true);
  expect(out.clears).toEqual([]);
});

test("computeSlotOccupancy: bare shell but WITHIN grace → slot-occupied, NO kill", () => {
  // idle 50s < 120s grace — a bare shell that JUST appeared could be a teardown
  // frame, so surface only; never kill inside the grace window.
  const occ = oneOccupant({ command: "zsh", updated_at: 950 });
  const out = computeSlotOccupancy(slotInput(occ));
  expect(out.failures).toHaveLength(1);
  expect(out.failures[0].reclaimPaneId).toBeNull();
  expect(out.failures[0].reason.startsWith("slot-occupied")).toBe(true);
});

test("computeSlotOccupancy: a live/parked claude pane → slot-occupied, NEVER killed (even past grace)", () => {
  // The resumable session: its pane still runs `claude`, so it is NOT provably dead
  // regardless of age — killing it would be the catastrophic failure.
  const occ = oneOccupant({ command: "claude", updated_at: 0 });
  const out = computeSlotOccupancy(slotInput(occ));
  expect(out.failures).toHaveLength(1);
  expect(out.failures[0].reclaimPaneId).toBeNull();
  expect(out.failures[0].reason.startsWith("slot-occupied")).toBe(true);
});

test("computeSlotOccupancy: login `-zsh` past grace is still reclaimed (dash stripped)", () => {
  const occ = oneOccupant({ command: "-zsh", updated_at: 800 });
  const out = computeSlotOccupancy(slotInput(occ));
  expect(out.failures[0].reclaimPaneId).toBe("%7");
});

test("computeSlotOccupancy: grace boundary — idle === grace reclaims, idle < grace occupies", () => {
  const atBoundary = computeSlotOccupancy(
    slotInput({
      ...oneOccupant({ command: "zsh", updated_at: 880 }),
      now: 1000,
    }),
  );
  expect(atBoundary.failures[0].reclaimPaneId).toBe("%7"); // 120 ≥ 120
  const justUnder = computeSlotOccupancy(
    slotInput({
      ...oneOccupant({ command: "zsh", updated_at: 881 }),
      now: 1000,
    }),
  );
  expect(justUnder.failures[0].reclaimPaneId).toBeNull(); // 119 < 120
});

test("computeSlotOccupancy: a dead work-task slot reclaims on (work, task)", () => {
  const occ = oneOccupant({
    verb: "work",
    id: "fn-1-foo.2",
    command: "bash",
    pane: "%3",
    updated_at: 800,
  });
  const out = computeSlotOccupancy(slotInput(occ));
  expect(out.failures[0].verb).toBe("work");
  expect(out.failures[0].id).toBe("fn-1-foo.2");
  expect(out.failures[0].reclaimPaneId).toBe("%3");
});

test("computeSlotOccupancy: pane gone (absent from the sweep) → not occupying → no signal", () => {
  const occ = oneOccupant({ command: "zsh", updated_at: 800 });
  const out = computeSlotOccupancy(
    slotInput({
      ...occ,
      livePaneIds: new Set(["%99"]), // the job's %7 is gone
      paneCommandById: new Map([["%99", "zsh"]]),
    }),
  );
  expect(out.failures).toEqual([]);
});

test("computeSlotOccupancy: a WORKING job is healthy occupancy → no slot signal", () => {
  const occ = oneOccupant({
    state: "working",
    command: "zsh",
    updated_at: 800,
  });
  expect(computeSlotOccupancy(slotInput(occ)).failures).toEqual([]);
});

test("computeSlotOccupancy: not-wanted key (completed / unarmed) leaves the inspection window", () => {
  // A stopped session whose row `reconcile` no longer wants to dispatch keeps its
  // post-run inspection window — never surfaced, never killed.
  const occ = oneOccupant({ command: "zsh", updated_at: 800 });
  const out = computeSlotOccupancy(
    slotInput({ ...occ, wantsDispatch: () => false }),
  );
  expect(out.failures).toEqual([]);
});

test("computeSlotOccupancy: paused → fully inert (no failures, no clears)", () => {
  const occ = oneOccupant({ command: "zsh", updated_at: 800 });
  const out = computeSlotOccupancy(
    slotInput({
      ...occ,
      paused: true,
      openSlotFailures: [{ verb: "close", id: "fn-1-foo" }],
    }),
  );
  expect(out.failures).toEqual([]);
  expect(out.clears).toEqual([]);
});

test("computeSlotOccupancy: degraded probe (null livePaneIds / paneCommandById) → inert", () => {
  const occ = oneOccupant({ command: "zsh", updated_at: 800 });
  expect(
    computeSlotOccupancy(slotInput({ ...occ, livePaneIds: null })).failures,
  ).toEqual([]);
  expect(
    computeSlotOccupancy(slotInput({ ...occ, paneCommandById: null })).failures,
  ).toEqual([]);
});

test("computeSlotOccupancy: level-clear — an OPEN slot row with no occupant this cycle clears", () => {
  // Occupant gone (empty jobs): the open slot failure self-clears, no retry_dispatch.
  const out = computeSlotOccupancy(
    slotInput({ openSlotFailures: [{ verb: "close", id: "fn-1-foo" }] }),
  );
  expect(out.failures).toEqual([]);
  expect(out.clears).toEqual([{ verb: "close", id: "fn-1-foo" }]);
});

test("computeSlotOccupancy: an OPEN slot row whose occupant is STILL active is NOT cleared", () => {
  // The key is re-signaled (active) this cycle, so it is never in the clear set —
  // failure and clear are disjoint by construction.
  const occ = oneOccupant({ command: "claude", updated_at: 0 }); // occupied, live
  const out = computeSlotOccupancy(
    slotInput({
      ...occ,
      openSlotFailures: [{ verb: "close", id: "fn-1-foo" }],
    }),
  );
  expect(out.failures).toHaveLength(1);
  expect(out.clears).toEqual([]);
});

test("computeSlotOccupancy: clears only the open key whose occupant left, keeps the active one", () => {
  // Two open slot rows: fn-1-foo still occupied (live claude), fn-2-bar's occupant
  // gone. Only the vacated one clears; the live one keeps its visible row.
  const occ = oneOccupant({ id: "fn-1-foo", command: "claude", updated_at: 0 });
  const out = computeSlotOccupancy(
    slotInput({
      ...occ,
      openSlotFailures: [
        { verb: "close", id: "fn-1-foo" },
        { verb: "close", id: "fn-2-bar" },
      ],
    }),
  );
  expect(out.clears).toEqual([{ verb: "close", id: "fn-2-bar" }]);
});

test("computeSlotOccupancy: SLOT_RECLAIM_GRACE_SEC is the default grace, overridable per call", () => {
  expect(SLOT_RECLAIM_GRACE_SEC).toBe(120);
  // With a tiny injected grace, a just-stopped bare shell reclaims immediately.
  const occ = oneOccupant({ command: "zsh", updated_at: 999 }); // idle 1s
  const out = computeSlotOccupancy(slotInput({ ...occ, graceSec: 1 }));
  expect(out.failures[0].reclaimPaneId).toBe("%7");
});

// ---------------------------------------------------------------------------
// fn-1200 computeSlotOccupancy — slot authority from the JOB LIFECYCLE
// (proven-dead verdict), not pane cosmetics
// ---------------------------------------------------------------------------

test("fn-1200 computeSlotOccupancy: proven-dead job + live WRAPPER pane past grace → reclaim (pane command is NOT a bare shell)", () => {
  // The wedge fix: claude exited but the launch-wrapper shell / a lingering
  // launcher process holds the pane, so its foreground command is `bun` — neither
  // `claude` nor the bare `exec $SHELL` tail. `isBareShellCommand` cannot classify
  // it dead, so the pre-fn-1200 reaper left the slot wedged forever. With the
  // exit-watcher's proven-dead verdict in hand (`provenDeadJobIds`), the reaper
  // reclaims it regardless of the pane command.
  const occ = oneOccupant({ command: "bun", updated_at: 800 }); // idle 200s ≥ 120
  expect(isBareShellCommand("bun")).toBe(false); // pin: NOT reclaimable by cosmetics
  const out = computeSlotOccupancy(
    slotInput({ ...occ, provenDeadJobIds: new Set(["j"]) }),
  );
  expect(out.failures).toHaveLength(1);
  const sig: SlotOccupancySignal = out.failures[0];
  expect(sig.reclaimPaneId).toBe("%7"); // the reaper targets the residual pane
  expect(sig.reason.startsWith("slot-reclaimed")).toBe(true);
});

test("fn-1200 computeSlotOccupancy: a live-session job with the SAME wrapper pane shape → NO reclaim (reaper never targets a job lacking a proven-dead verdict)", () => {
  // The catastrophic-failure guard: identical pane shape (live pane, `bun`
  // foreground, past grace) but the job is NOT proven dead — a live worker whose
  // pane momentarily foregrounds a child process. It must surface only, never be
  // killed, so a false-dead read can never destroy a live session.
  const occ = oneOccupant({ command: "bun", updated_at: 800 });
  const out = computeSlotOccupancy(
    slotInput({ ...occ, provenDeadJobIds: new Set<string>() }),
  );
  expect(out.failures).toHaveLength(1);
  expect(out.failures[0].reclaimPaneId).toBeNull();
  expect(out.failures[0].reason.startsWith("slot-occupied")).toBe(true);
});

test("fn-1200 computeSlotOccupancy: proven-dead but WITHIN grace → slot-occupied, NO kill (reclaim is grace-aged, never immediate)", () => {
  // The kill is grace-aged even for a proven-dead verdict: a pane that JUST went
  // idle could be a teardown frame, so the reaper waits `graceSec` past the last
  // fold before issuing the kill.
  const occ = oneOccupant({ command: "bun", updated_at: 950 }); // idle 50s < 120
  const out = computeSlotOccupancy(
    slotInput({ ...occ, provenDeadJobIds: new Set(["j"]) }),
  );
  expect(out.failures).toHaveLength(1);
  expect(out.failures[0].reclaimPaneId).toBeNull();
  expect(out.failures[0].reason.startsWith("slot-occupied")).toBe(true);
});

test("fn-1200 computeSlotOccupancy: proven-dead work-task with a launcher pane reclaims on (work, task)", () => {
  const occ = oneOccupant({
    verb: "work",
    id: "fn-1-foo.2",
    command: "node", // a lingering launcher, not a bare shell
    pane: "%3",
    updated_at: 800,
  });
  const out = computeSlotOccupancy(
    slotInput({ ...occ, provenDeadJobIds: new Set(["j"]) }),
  );
  expect(out.failures[0].verb).toBe("work");
  expect(out.failures[0].id).toBe("fn-1-foo.2");
  expect(out.failures[0].reclaimPaneId).toBe("%3");
  expect(out.failures[0].reason.startsWith("slot-reclaimed")).toBe(true);
});

test("fn-1200 computeSlotOccupancy: proven-dead flag on a pane-GONE job → no signal (nothing to reclaim)", () => {
  // The job's pane left the live sweep — no live-provable occupant, so even a
  // proven-dead verdict yields no reclaim (the pane is already gone).
  const occ = oneOccupant({ command: "bun", updated_at: 800 });
  const out = computeSlotOccupancy(
    slotInput({
      ...occ,
      provenDeadJobIds: new Set(["j"]),
      livePaneIds: new Set(["%99"]), // the job's %7 is gone
      paneCommandById: new Map([["%99", "bun"]]),
    }),
  );
  expect(out.failures).toEqual([]);
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

test("fn-778 boot-pause determinism: an absent workerData.paused boots PAUSED (the `?? true` default)", () => {
  // The worker boots from `workerData.paused`, which the daemon seeds from the
  // durable `autopilot_state.paused` column — so a normal boot resumes the last
  // durable state. This test pins the worker-side DEGRADED-boot half: when
  // `workerData.paused` is absent, `main()`'s `state.paused = data.paused ?? true`
  // must resolve `undefined`/absent to a PAUSED state that launches nothing, so a
  // future refactor can't silently flip the no-flag boot default to unpaused.
  // Model `main()`'s `state.paused = data.paused ?? true` against an absent field.
  const data: { paused?: boolean } = {};
  const paused = data.paused ?? true;
  expect(paused).toBe(true);
  const epic = makeEpic({ tasks: [makeTask({ task_id: "fn-1-foo.1" })] });
  const snap = makeSnapshot({ epics: [epic] });
  const decision = reconcile(snap, makeState({ paused }), 0);
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
    "cd /repo && claude --model sonnet --effort max --x-no-confirm --name work::fn-1-foo.1 '/plan:work fn-1-foo.1'",
  );
});

test("fn-937: a snapshot's resolved work dispatch row flows into the launch's command AND the launch model/effort", () => {
  const epic = makeEpic({
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = makeSnapshot({
    epics: [epic],
    workModel: "opus",
    workEffort: "high",
  });
  const decision = reconcile(snap, makeState(), 0);
  const plan = decision.launches[0];
  expect(plan?.workerCommand).toBe(
    "cd /repo && claude --model opus --effort high --x-no-confirm --name work::fn-1-foo.1 '/plan:work fn-1-foo.1'",
  );
  // The same resolved values ride on the launch so the cycle glue feeds
  // buildPlannedLaunchSpec identically (drift-guard parity).
  expect(plan?.model).toBe("opus");
  expect(plan?.effort).toBe("high");
});

test("ADR 0040: the close dispatch row is settable INDEPENDENTLY of the work row", () => {
  // One cycle with a work-driving epic (a ready todo task) AND a close-driving epic
  // (all tasks complete), plus divergent work/close pairs, proves each launch reads
  // its OWN resolved pair — a close row never tracks the work row's model.
  const workEpic = makeEpic({
    epic_id: "fn-1-work",
    epic_number: 1,
    project_dir: "/repo-work",
    tasks: [makeTask({ task_id: "fn-1-work.1", epic_id: "fn-1-work" })],
  });
  const closeEpic = makeEpic({
    epic_id: "fn-2-close",
    epic_number: 2,
    project_dir: "/repo-close",
    tasks: [
      makeTask({
        task_id: "fn-2-close.1",
        epic_id: "fn-2-close",
        worker_phase: "done",
        runtime_status: "done",
      }),
    ],
  });
  const snap = makeSnapshot({
    epics: [workEpic, closeEpic],
    workModel: "opus",
    workEffort: "high",
    closeModel: "haiku",
    closeEffort: "low",
  });
  const decision = reconcile(snap, makeState(), 0);
  const workLaunch = decision.launches.find((l) => l.verb === "work");
  const closeLaunch = decision.launches.find((l) => l.verb === "close");
  expect(workLaunch?.model).toBe("opus");
  expect(workLaunch?.effort).toBe("high");
  // The close launch reads the SEPARATE close pair, never the work one.
  expect(closeLaunch?.model).toBe("haiku");
  expect(closeLaunch?.effort).toBe("low");
});

test("fn-905: reconcile dispatches NOTHING into an unseeded root", () => {
  const epic = makeEpic({
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  // The ready epic's root is unseeded (post-restart, pre-seed): its readiness
  // row is forced UNKNOWN, so no `work` is dispatched into it.
  const snap = makeSnapshot({
    epics: [epic],
    unseededRoots: new Set(["/repo"]),
  });
  const decision = reconcile(snap, makeState(), 0);
  expect(decision.launches).toEqual([]);
});

test("fn-905: an unseeded root blocks only its own rows; a seeded sibling dispatches", () => {
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
  // Only /repo-a is unseeded → only its task is gated UNKNOWN; the seeded
  // /repo-b sibling still dispatches (the coupling is gone).
  const snap = makeSnapshot({
    epics: [epicA, epicB],
    unseededRoots: new Set(["/repo-a"]),
  });
  const decision = reconcile(snap, makeState(), 0);
  const ids = decision.launches.map((l) => l.id);
  expect(ids).toContain("fn-2-bar.1");
  expect(ids).not.toContain("fn-1-foo.1");
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
  // A task with neither model nor tier resolves no cell — no `--plugin-dir`.
  expect(decision.launches[0]?.workerCommand).not.toContain("--plugin-dir");
  expect(decision.launches[0]?.pluginDir).toBeNull();
});

test("reconcile: a `work` row with a tier but NO model resolves no cell (null-either-axis stop)", () => {
  const epic = makeEpic({
    tasks: [makeTask({ task_id: "fn-1-foo.1", tier: "max" })],
  });
  const snap = makeSnapshot({ epics: [epic] });
  const decision = reconcile(snap, makeState(), 0);
  // The tier still rides the launch plan (board/projection read)…
  expect(decision.launches[0]?.tier).toBe("max");
  // …but a null model means no {model, effort} cell, so no `--plugin-dir` and a
  // null pluginDir — the launch falls back to the always-loaded `plan` plugin.
  expect(decision.launches[0]?.pluginDir).toBeNull();
  expect(decision.launches[0]?.pluginDirReject).toBeUndefined();
  expect(decision.launches[0]?.workerCommand).not.toContain("--plugin-dir");
});

test("reconcile: a `work` row with an in-matrix (model, tier) threads the absolute cell --plugin-dir", () => {
  const epic = makeEpic({
    tasks: [makeTask({ task_id: "fn-1-foo.1", tier: "max", model: "opus" })],
  });
  const snap = makeSnapshot({ epics: [epic] });
  const decision = reconcile(snap, makeState(), 0);
  const plan = decision.launches[0];
  // The resolved cell is an ABSOLUTE path under keeper's plugins/plan/workers,
  // so a worktree/cross-repo worker launched from another cwd still finds it.
  expect(plan?.pluginDir).not.toBeNull();
  expect(plan?.pluginDir?.startsWith("/")).toBe(true);
  expect(plan?.pluginDir).toContain("plugins/plan/workers/opus-max");
  expect(plan?.pluginDirReject).toBeUndefined();
  // The shell-twin command mirrors it after `--name` (the byte drift-guard).
  expect(plan?.workerCommand).toContain(
    `--name work::fn-1-foo.1 --plugin-dir ${plan?.pluginDir}`,
  );
});

test("reconcile: an out-of-matrix (model, tier) fails at compose — a reject, never a thrown cycle", () => {
  const epic = makeEpic({
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", tier: "ludicrous", model: "opus" }),
    ],
  });
  const snap = makeSnapshot({ epics: [epic] });
  // reconcile must NOT throw (a deterministic throw would wedge the whole cycle);
  // the bad pair is carried as a pluginDirReject the producer mints as sticky.
  const decision = reconcile(snap, makeState(), 0);
  const plan = decision.launches[0];
  expect(plan?.pluginDir).toBeNull();
  expect(plan?.pluginDirReject).toBeDefined();
  expect(plan?.pluginDirReject).toContain("unknown tier");
  expect(plan?.workerCommand).not.toContain("--plugin-dir");
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

test("fn-811 reconcile dedup: stopped job whose pane is DEAD no longer blocks re-dispatch", () => {
  // The wedge: a worker ended its turn without completing the task (its jobs
  // row is `stopped`, the schema default) and its tmux pane is gone. The task
  // is ready-and-unclaimed, so the dispatch gate must free the slot — with the
  // live-pane set absent its `%9` pane, `isOccupyingJob` returns false and the
  // task re-dispatches.
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
      state: "stopped",
      backend_exec_pane_id: "%9",
    }),
  );
  const snap = makeSnapshot({
    epics: [epic],
    jobs,
    livePaneIds: new Set(["%1"]), // %9 absent → dead pane
  });
  const decision = reconcile(snap, makeState(), 0);
  expect(decision.launches.map((l) => l.key)).toContain("work::fn-1-foo.1");
});

test("fn-811 reconcile dedup: stopped job whose pane is LIVE still blocks re-dispatch", () => {
  // A parked-but-alive session (stopped row, pane still present) keeps its slot
  // — re-dispatching would land a second worker on the same task.
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
      state: "stopped",
      backend_exec_pane_id: "%9",
    }),
  );
  const snap = makeSnapshot({
    epics: [epic],
    jobs,
    livePaneIds: new Set(["%9"]), // %9 present → live pane
  });
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

test("reconcile: an instant-death-breaker sticky pauses the key's re-dispatch until retry (fn-1086)", () => {
  // The reducer mints dispatch_failures(reason='instant-death-breaker') at K
  // consecutive instant deaths, keyed on work::<task>. loadReconcileSnapshot puts
  // every dispatch_failures row's (verb,id) into failedKeys regardless of reason,
  // so the tripped key stops re-dispatching — breaking the bind→die→re-dispatch
  // burn — until retry_dispatch (DispatchCleared) drops the row.
  const epic = makeEpic({ tasks: [makeTask({ task_id: "fn-1-foo.1" })] });
  const suppressed = reconcile(
    makeSnapshot({
      epics: [epic],
      failedKeys: new Set(["work::fn-1-foo.1"]),
    }),
    makeState(),
    0,
  );
  expect(suppressed.launches).toEqual([]);

  // retry_dispatch cleared the sticky → failedKeys empty → the key re-dispatches.
  const cleared = reconcile(
    makeSnapshot({ epics: [epic], failedKeys: new Set() }),
    makeState(),
    0,
  );
  expect(cleared.launches.map((p) => p.key)).toEqual(["work::fn-1-foo.1"]);
});

test("fn-976 durable re-dispatch guard: a TOOLING_FAILURE block's sticky DispatchFailed holds the task out even while the projection still shows in_progress; retry_dispatch clears it", () => {
  // The daemon block-escalation sweep mints a sticky DispatchFailed on
  // work::<task> when a worker blocks TOOLING_FAILURE, so failedKeys holds the
  // key. The task is otherwise ready (no live occupant) and the projection's
  // runtime_status still reads `in_progress` — the transient blocked status lags
  // the block / the long-running worker just ended — yet reconcile must NOT
  // cold-re-dispatch it. This is the durable arm outliving the transient
  // runtime-blocked gate.
  const epic = makeEpic({
    tasks: [makeTask({ task_id: "fn-1-foo.1", runtime_status: "in_progress" })],
  });
  const suppressed = reconcile(
    makeSnapshot({
      epics: [epic],
      failedKeys: new Set(["work::fn-1-foo.1"]),
    }),
    makeState(),
    0,
  );
  expect(suppressed.launches).toEqual([]);

  // retry_dispatch mints DispatchCleared → the sticky row leaves dispatch_failures
  // → failedKeys empty → the resolved task re-dispatches.
  const cleared = reconcile(
    makeSnapshot({ epics: [epic], failedKeys: new Set() }),
    makeState(),
    0,
  );
  expect(cleared.launches.map((p) => p.key)).toEqual(["work::fn-1-foo.1"]);
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
    launch: async () => ({ ok: false, error: "tmux ENOENT" }),
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

test("fn-1061 runReconcileCycle: a SUPPRESSED-DUP RE-STAMPS the cooldown (damp, not clear); no launch, no DispatchFailed, failedKeys untouched", async () => {
  // The durable mint gate suppressed this re-mint (ack {ok:false,
  // suppressed:true}) → outcome `suppressed-dup`. Unlike a pre-launch abort
  // (which CLEARS the cooldown so re-dispatch is free), suppression must DAMP:
  // the cooldown is RE-STAMPED so the next reconcile holds the key back. An
  // advancing clock proves the stamp MOVED (re-stamped, not a stale no-op).
  let clock = 1000;
  const { deps, log } = makeFakeDeps({
    ceilingMs: 50,
    pollIntervalMs: 5,
    now: () => clock++,
    dispatchedAck: { ok: false, suppressed: true },
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

  // Never launched, no DispatchFailed, no live entry (nothing confirmed).
  expect(log.launches.length).toBe(0);
  expect(log.emissions).toEqual([]);
  expect(liveDispatches.has("work::fn-1-foo.1")).toBe(false);
  // The mint request WAS issued (it's what the gate suppressed).
  expect(log.dispatchedEmissions.length).toBe(1);
  // Cooldown RE-STAMPED — moved past the dispatch-time value (1000), NOT cleared.
  const restamped = state.redispatchCooldown.get("work::fn-1-foo.1");
  expect(restamped).toBeDefined();
  expect(restamped).toBeGreaterThan(1000);
  // failedKeys is a projection-derived snapshot input; suppression mints no
  // DispatchFailed, so it stays untouched — the snapshot's set is unchanged.
  expect(snap.failedKeys.size).toBe(0);
});

test("fn-1061 runReconcileCycle: a PERSISTENT pre-launch suppression does NOT hot-loop (cycle 2 is damped by the re-stamped cooldown)", async () => {
  // Contrast fn-762's aborted-prelaunch, which CLEARS the cooldown so cycle 2
  // re-dispatches immediately (a suppress→clear→re-dispatch hot loop). A
  // suppressed-dup RE-STAMPS the cooldown, so the very next reconcile within
  // REDISPATCH_COOLDOWN_S (200s) produces NO launch — exactly one mint attempt
  // ever fires across the two cycles.
  let clock = 1000;
  const { deps, log } = makeFakeDeps({
    ceilingMs: 50,
    pollIntervalMs: 5,
    now: () => clock++,
    dispatchedAck: { ok: false, suppressed: true },
  });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = makeSnapshot({ epics: [epic] });
  const state = makeState();
  const liveDispatches = new Map<string, LiveDispatch>();

  // Cycle 1: reconcile produces the launch; the gate suppresses it → re-stamp.
  const d1 = reconcile(snap, state, clock);
  expect(d1.launches.length).toBe(1);
  await runReconcileCycle(
    d1,
    state,
    liveDispatches,
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );
  expect(state.redispatchCooldown.get("work::fn-1-foo.1")).toBeDefined();

  // Cycle 2: the re-stamped cooldown (well inside the 200s window) makes
  // reconcile SUPPRESS the launch — no second dispatch attempt fires.
  const d2 = reconcile(snap, state, clock);
  expect(d2.launches.length).toBe(0);
  await runReconcileCycle(
    d2,
    state,
    liveDispatches,
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );

  // Exactly ONE suppressed mint attempt across both cycles — no hot loop, no
  // DispatchFailed, no live entry.
  expect(log.dispatchedEmissions.length).toBe(1);
  expect(log.launches.length).toBe(0);
  expect(log.emissions).toEqual([]);
  expect(liveDispatches.size).toBe(0);
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
    launch: async () => ({ ok: false, error: "tmux ENOENT" }),
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
// fn-778 — slow-cold-boot over-dispatch (the dup-close fix)
//
// Incident (2026-06-10, UTC): a `close::fn-608…` worker took 317s to emit its
// first SessionStart (far-tail `claude` cold boot under conn-cap saturation). Its
// `pending_dispatches` row TTL-expired at ~120s, no `jobs` row had bound, and the
// cooldown (stamped at dispatch, re-stamped ONCE at the 60s indoubt ceiling →
// cover-end dispatch+260s) lapsed 2s before the re-dispatch at dispatch+261s. The
// fix re-anchors the cooldown + finalizer guard each cycle a key still has an OPEN
// pending row, so suppression tracks the phantom's durable lifetime.
// ---------------------------------------------------------------------------

test("fn-778 refreshSuppressionForOpenPending: re-stamps the cooldown for an open key", () => {
  // A key with an open pending row gets its cooldown refreshed to `now` — even
  // when it was stamped long ago (about to expire under the sweep).
  const cooldown = new Map<DispatchKey, number>([["work::fn-1-foo.1", 1000]]);
  const guard = new Map<string, number>();
  const openKeys = new Set<DispatchKey>(["work::fn-1-foo.1"]);
  refreshSuppressionForOpenPending(cooldown, guard, openKeys, 5000);
  expect(cooldown.get("work::fn-1-foo.1")).toBe(5000);
  // A work key is NOT an epic finalizer — the guard stays empty.
  expect(guard.size).toBe(0);
});

test("fn-778 refreshSuppressionForOpenPending: a close key ALSO re-anchors the per-epic finalizer guard", () => {
  // The `close::<epic>` key (the headline dup-close surface) re-stamps BOTH the
  // cooldown (keyed by the full key) and the finalizer guard (keyed by epic id).
  const cooldown = new Map<DispatchKey, number>();
  const guard = new Map<string, number>();
  const openKeys = new Set<DispatchKey>(["close::fn-1-foo"]);
  refreshSuppressionForOpenPending(cooldown, guard, openKeys, 7000);
  expect(cooldown.get("close::fn-1-foo")).toBe(7000);
  expect(guard.get("fn-1-foo")).toBe(7000);
});

test("fn-778 refreshSuppressionForOpenPending: a key with NO open pending row is left untouched", () => {
  // Only keys present in `openKeys` are refreshed; a stale cooldown entry whose
  // pending row already expired (DispatchExpired) is NOT re-anchored, so it ages
  // out normally — this is what bounds the suppression (never perpetual).
  const cooldown = new Map<DispatchKey, number>([
    ["work::fn-1-foo.1", 1000],
    ["close::fn-2-bar", 1000],
  ]);
  const guard = new Map<string, number>([["fn-2-bar", 1000]]);
  // Only fn-1-foo.1 still has an open pending row.
  const openKeys = new Set<DispatchKey>(["work::fn-1-foo.1"]);
  refreshSuppressionForOpenPending(cooldown, guard, openKeys, 5000);
  expect(cooldown.get("work::fn-1-foo.1")).toBe(5000); // refreshed
  expect(cooldown.get("close::fn-2-bar")).toBe(1000); // untouched → ages out
  expect(guard.get("fn-2-bar")).toBe(1000); // untouched
});

test("fn-778 refreshSuppressionForOpenPending: empty open set is a no-op (no throw)", () => {
  const cooldown = new Map<DispatchKey, number>([["work::x", 1000]]);
  const guard = new Map<string, number>([["fn-1-foo", 1000]]);
  expect(() =>
    refreshSuppressionForOpenPending(cooldown, guard, new Set(), 9999),
  ).not.toThrow();
  // Nothing open → nothing refreshed.
  expect(cooldown.get("work::x")).toBe(1000);
  expect(guard.get("fn-1-foo")).toBe(1000);
});

test("fn-778 slow-cold-boot reproduction: an open pending close row keeps the close suppressed PAST the original cooldown window (no dup-close)", () => {
  // The exact incident shape, time-collapsed. A ready close row whose
  // `close::<epic>` was dispatched at t0 and whose worker is still cold-booting:
  // the `pending_dispatches` row stays OPEN across cycles. WITHOUT the refresh the
  // cooldown would lapse at t0+COOLDOWN and the close would re-dispatch (the bug).
  // WITH the refresh, each cycle re-anchors the stamp, so the close stays
  // suppressed even at t0 + 2*COOLDOWN — exactly one launch ever fires.
  const epic = readyCloseEpic("fn-608-squeegee", "/repo");
  const t0 = 1000;
  // State as it stood right after dispatch #1: cooldown + finalizer guard stamped.
  const state = makeState({
    redispatchCooldown: new Map([["close::fn-608-squeegee", t0]]),
    finalizerGuard: new Map([["fn-608-squeegee", t0]]),
  });
  // The pending row is still OPEN (worker booting) — the loader would surface it
  // in liveTabKeys. But to prove the COOLDOWN arm (not liveTabKeys) is what the
  // refresh keeps alive, drive reconcile with liveTabKeys EMPTY after refreshing.
  const openKeys = new Set<DispatchKey>(["close::fn-608-squeegee"]);

  // Simulate cycles across the boot window: each cycle sweeps then refreshes while
  // the pending row is open. Walk well past the original single-window expiry.
  for (
    let now = t0 + 10;
    now <= t0 + 2 * REDISPATCH_COOLDOWN_S;
    now += REDISPATCH_COOLDOWN_S - 5
  ) {
    sweepRedispatchCooldown(state.redispatchCooldown, now);
    sweepFinalizerGuard(state.finalizerGuard, now);
    refreshSuppressionForOpenPending(
      state.redispatchCooldown,
      state.finalizerGuard,
      openKeys,
      now,
    );
    // The close stays suppressed every cycle (cooldown + guard both re-anchored).
    const snap = makeSnapshot({ epics: [epic] });
    const decision = reconcile(snap, state, now);
    expect(decision.launches.find((p) => p.verb === "close")).toBeUndefined();
  }
});

test("fn-778 bound check: once the pending row CLOSES (DispatchExpired), the refreshed cooldown finally ages out and the close re-dispatches", () => {
  // The other half of the contract: suppression is NOT perpetual. After the
  // pending row is discharged (key drops out of openKeys), the next sweep prunes
  // the now-stale stamp once COOLDOWN has elapsed since the LAST refresh, and the
  // close becomes re-dispatchable — exactly the bounded behavior.
  const epic = readyCloseEpic("fn-1-foo", "/repo");
  const lastRefresh = 1000;
  const state = makeState({
    redispatchCooldown: new Map([["close::fn-1-foo", lastRefresh]]),
    finalizerGuard: new Map([["fn-1-foo", lastRefresh]]),
  });
  // Pending row now CLOSED — nothing open to refresh.
  const openKeys = new Set<DispatchKey>();
  const now = lastRefresh + REDISPATCH_COOLDOWN_S; // exactly at expiry
  sweepRedispatchCooldown(state.redispatchCooldown, now);
  sweepFinalizerGuard(state.finalizerGuard, now);
  refreshSuppressionForOpenPending(
    state.redispatchCooldown,
    state.finalizerGuard,
    openKeys,
    now,
  );
  expect(state.redispatchCooldown.has("close::fn-1-foo")).toBe(false);
  expect(state.finalizerGuard.has("fn-1-foo")).toBe(false);
  const snap = makeSnapshot({ epics: [epic] });
  const decision = reconcile(snap, state, now);
  expect(decision.launches.find((p) => p.verb === "close")?.key).toBe(
    "close::fn-1-foo",
  );
});

test("fn-778 same-second shape: two ready close verdicts racing → the fresh-cooldown one yields exactly one launch", () => {
  // The spec's reproduction: two ready close rows in one snapshot. One epic's
  // close was JUST dispatched (fresh cooldown) — it must NOT re-launch; the other
  // is cold and launches. Proves the close-row site consults the (refreshed)
  // cooldown so a same-second re-evaluation never double-fires the in-flight one.
  const justDispatched = readyCloseEpic("fn-1-foo", "/repo");
  const coldEpic = readyCloseEpic("fn-2-bar", "/repo2");
  const now = 5000;
  const state = makeState({
    // fn-1-foo's close was refreshed THIS instant (open pending row) → suppressed.
    redispatchCooldown: new Map([["close::fn-1-foo", now]]),
    finalizerGuard: new Map([["fn-1-foo", now]]),
  });
  const snap = makeSnapshot({ epics: [justDispatched, coldEpic] });
  const decision = reconcile(snap, state, now);
  const closeLaunches = decision.launches.filter((p) => p.verb === "close");
  // Exactly one close launch — the cold epic. The in-flight one is suppressed.
  expect(closeLaunches.map((p) => p.key)).toEqual(["close::fn-2-bar"]);
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
    { verb: "work", id: "fn-1-foo.1", dir: "/repo", dispatched_at: 0 },
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
// fn-924 — bound-pending: the post-bind launch-window occupant. A worker BOUND
// (SessionStart folded a stopped + plan_verb jobs row, discharging the pending
// row) but not yet ACTIVE holds its root across the bind → first-activity
// handoff, so reconcile never co-dispatches a same-root sibling into the gap.
// ---------------------------------------------------------------------------

test("fn-924 reconcile: a bound-but-not-yet-active worker (stopped+plan_verb, active_since NULL) demotes a same-root ready sibling — no co-dispatch", () => {
  // The pinned 2026-06-23 leak through the full reconcile path: epic A's task is
  // bound (its pending row already discharged on SessionStart, so NO
  // `pendingDispatches` entry) but its embedded job is still `stopped`,
  // `active_since: null` — bound-pending. Epic B's same-root ready task must be
  // demoted to `single-task-per-root`, so reconcile launches NOTHING for it.
  const epicA = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        epic_id: "fn-1-foo",
        jobs: [
          {
            job_id: "worker-a",
            plan_verb: "work",
            state: "stopped",
            active_since: null,
          } as unknown as EmbeddedJob,
        ],
      }),
    ],
  });
  const epicB = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-2-bar.1", epic_id: "fn-2-bar" })],
  });
  const snap = makeSnapshot({ epics: [epicA, epicB], pendingDispatches: [] });
  const decision = reconcile(snap, makeState(), 0);
  // The bound worker's own row is non-dispatchable (bound-pending → no verb),
  // and the same-root sibling is demoted — zero launches.
  expect(decision.launches).toEqual([]);
});

test("fn-924 control: a stopped-AFTER-working worker (active_since set) does NOT over-hold — the root frees and a task on it launches", () => {
  // Over-hold guard: epic A's worker ran then stopped (`active_since` set), so its
  // open task is NOT bound-pending — it falls through to `ready` and the root is
  // free. Proves the demotion in the test above is driven by bound-pending (the
  // `active_since IS NULL` gate), not the bare presence of a stopped job: with
  // `active_since` set the first-on-root task (epic A, sorts first) launches.
  const epicA = makeEpic({
    epic_id: "fn-1-foo",
    epic_number: 1,
    project_dir: "/repo",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        epic_id: "fn-1-foo",
        jobs: [
          {
            job_id: "worker-a",
            plan_verb: "work",
            state: "stopped",
            active_since: 1700,
          } as unknown as EmbeddedJob,
        ],
      }),
    ],
  });
  const epicB = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-2-bar.1", epic_id: "fn-2-bar" })],
  });
  const snap = makeSnapshot({ epics: [epicA, epicB], pendingDispatches: [] });
  const decision = reconcile(snap, makeState(), 0);
  // Root NOT held by bound-pending → the first-on-root ready task launches.
  expect(decision.launches.map((l) => l.key)).toEqual(["work::fn-1-foo.1"]);
});

test("fn-924 cap: a bound-pending worker counts as ONE occupant (cap not double-counted, not starved)", () => {
  // The cap counts `isRootOccupant` over perTask ∪ perCloseRow. A bound-pending
  // worker is a real in-flight worker consuming exactly ONE slot — counted once,
  // not double-counted (it is not also a pendingDispatches entry, since the row
  // discharged on bind). With cap=2 and one bound-pending occupant in its own
  // root, a ready task in a DISTINCT root still gets the remaining slot.
  const boundEpic = makeEpic({
    epic_id: "fn-1-a",
    epic_number: 1,
    project_dir: "/repo-a",
    tasks: [
      makeTask({
        task_id: "fn-1-a.1",
        epic_id: "fn-1-a",
        jobs: [
          {
            job_id: "worker-a",
            plan_verb: "work",
            state: "stopped",
            active_since: null,
          } as unknown as EmbeddedJob,
        ],
      }),
    ],
  });
  const ready = readyEpic("fn-2-b", "/repo-b");
  const snap = makeSnapshot({ epics: [boundEpic, ready] });
  const decision = reconcile(snap, makeState({ maxConcurrentJobs: 2 }), 0);
  // occupied = 1 (the bound-pending worker), budget = 1 → the distinct-root
  // ready task launches.
  expect(decision.launches.map((l) => l.key)).toEqual(["work::fn-2-b.1"]);
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

test("fn-867 cap: a validated epic with a working planner link competes for budget like any worker", () => {
  // The planner-running readiness gate is gone: a validated epic whose
  // creator/refiner link is still `working` reads its dep-satisfied task as
  // `ready`, so that task competes for the cap exactly like a worker task in
  // any other epic. With cap=1 and the planner epic's ready task sorting
  // FIRST (epic_number 1), it wins the single budget slot.
  const plannerEpic = makeEpic({
    epic_id: "fn-1-plan",
    epic_number: 1,
    project_dir: "/repo-plan",
    // A working job_link no longer holds the epic's tasks off `ready`.
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
  // Both tasks are ready; the planner epic's task sorts first and takes the
  // single slot — it is no longer exempt from the cap.
  expect(decision.launches.map((l) => l.key)).toEqual(["work::fn-1-plan.1"]);
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

test("projectPendingDispatches: parses dispatched_at; non-finite normalises to Infinity (fresh)", () => {
  const projected = projectPendingDispatches([
    {
      verb: "work",
      id: "a.1",
      dir: "/r",
      dispatched_at: 1700,
      last_event_id: 1,
    },
    // missing dispatched_at → Infinity (treated as fresh, never excluded)
    { verb: "work", id: "b.1", dir: "/r", last_event_id: 2 },
    // non-number dispatched_at → Infinity
    {
      verb: "work",
      id: "c.1",
      dir: "/r",
      dispatched_at: "soon",
      last_event_id: 3,
    },
    // NaN dispatched_at → Infinity (Number.isFinite guard)
    {
      verb: "work",
      id: "d.1",
      dir: "/r",
      dispatched_at: NaN,
      last_event_id: 4,
    },
  ]);
  expect(projected).toEqual([
    { verb: "work", id: "a.1", dir: "/r", dispatched_at: 1700 },
    {
      verb: "work",
      id: "b.1",
      dir: "/r",
      dispatched_at: Number.POSITIVE_INFINITY,
    },
    {
      verb: "work",
      id: "c.1",
      dir: "/r",
      dispatched_at: Number.POSITIVE_INFINITY,
    },
    {
      verb: "work",
      id: "d.1",
      dir: "/r",
      dispatched_at: Number.POSITIVE_INFINITY,
    },
  ]);
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
    { prompt: "/plan:work fn-1-foo.1", claudeName: "work::fn-1-foo.1" },
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
  // UNKNOWN, not failed (the backend execs `claude` cold 24-33s later — maybe
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
    { prompt: "/plan:work fn-1-foo.1", claudeName: "work::fn-1-foo.1" },
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
    { prompt: "/plan:work fn-1-foo.1", claudeName: "work::fn-1-foo.1" },
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
    { prompt: "/plan:work fn-1-foo.1", claudeName: "work::fn-1-foo.1" },
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
    { prompt: "/plan:work fn-1-foo.1", claudeName: "work::fn-1-foo.1" },
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
    launch: async () => ({ ok: false, error: "tmux ENOENT" }),
  });
  const ctrl = new AbortController();
  const outcome = await confirmRunning(
    "work",
    "fn-1-foo.1",
    "/repo",
    ["sh"],
    { prompt: "/plan:work fn-1-foo.1", claudeName: "work::fn-1-foo.1" },
    ctrl.signal,
    deps,
  );
  expect(outcome).toBe("failed");
  expect(log.emissions.length).toBe(1);
  expect(log.emissions[0]?.reason).toBe("tmux ENOENT");
  // No poll loop touched.
  expect(log.findJobCalls.length).toBe(0);
});

test("confirmRunning TRANSIENT (keeper agent): launch {ok:false, retryable:true} → indoubt, NO DispatchFailed, pending row kept", async () => {
  // The keeper agent exit-4 / timeout-kill / bad-path class. A transient launch
  // fail must NOT mint a sticky DispatchFailed (that writes off a recoverable
  // launch) and must NOT route as "failed" (which would clear the cooldown +
  // never feed the TTL→DispatchExpired→never-bound machinery). It routes EXACTLY
  // like the ceiling "indoubt": keep the pending_dispatches row, emit nothing.
  const { deps, log } = makeFakeDeps({
    launch: async () => ({
      ok: false,
      error: "keeper agent launch transient (exit 4 RETRYABLE)",
      retryable: true,
    }),
  });
  const ctrl = new AbortController();
  const outcome = await confirmRunning(
    "work",
    "fn-1-foo.1",
    "/repo",
    ["sh"],
    { prompt: "/plan:work fn-1-foo.1", claudeName: "work::fn-1-foo.1" },
    ctrl.signal,
    deps,
  );
  expect(outcome).toBe("indoubt");
  // NO sticky DispatchFailed — the pending row survives to the TTL sweep.
  expect(log.emissions).toEqual([]);
  // The dispatched mint still happened exactly once (intent before launch).
  expect(log.dispatchedEmissions.length).toBe(1);
  // No poll loop — the transient short-circuits before the ceiling poll.
  expect(log.findJobCalls.length).toBe(0);
});

test("buildPlannedLaunchSpec: mirrors buildWorkerCommand's model/effort/name/prompt", () => {
  const spec = buildPlannedLaunchSpec("work", "fn-1-foo.1");
  expect(spec).toEqual({
    prompt: "/plan:work fn-1-foo.1",
    claudeName: "work::fn-1-foo.1",
    model: WORKER_MODEL,
    effort: WORKER_EFFORT,
  });
  // The shell-wrapped worker command carries the SAME pieces (lockstep guard).
  const cmd = buildWorkerCommand("work", "fn-1-foo.1", "/repo");
  expect(cmd).toContain(`--model ${WORKER_MODEL}`);
  expect(cmd).toContain(`--effort ${WORKER_EFFORT}`);
  expect(cmd).toContain("--name work::fn-1-foo.1");
  expect(cmd).toContain("/plan:work fn-1-foo.1");
});

test("buildPlannedLaunchSpec + buildWorkerCommand thread a non-null pluginDir in lockstep", () => {
  const cell = "/abs/keeper/plugins/plan/workers/opus-max";
  const spec = buildPlannedLaunchSpec(
    "work",
    "fn-1-foo.1",
    WORKER_MODEL,
    WORKER_EFFORT,
    undefined,
    undefined,
    cell,
  );
  expect(spec.pluginDir).toBe(cell);
  // The shell twin emits `--plugin-dir <cell>` right after `--name`.
  const cmd = buildWorkerCommand(
    "work",
    "fn-1-foo.1",
    "/repo",
    WORKER_MODEL,
    WORKER_EFFORT,
    cell,
  );
  expect(cmd).toContain(`--name work::fn-1-foo.1 --plugin-dir ${cell}`);
  // A null pluginDir leaves both byte-unchanged (no cell key, no flag).
  const bare = buildPlannedLaunchSpec("work", "fn-1-foo.1");
  expect("pluginDir" in bare).toBe(false);
  expect(buildWorkerCommand("work", "fn-1-foo.1", "/repo")).not.toContain(
    "--plugin-dir",
  );
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
    { prompt: "/plan:work fn-1-foo.1", claudeName: "work::fn-1-foo.1" },
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
    { prompt: "/plan:work fn-1-foo.1", claudeName: "work::fn-1-foo.1" },
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
    { prompt: "/plan:work fn-1-foo.1", claudeName: "work::fn-1-foo.1" },
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
    { prompt: "/plan:work fn-1-foo.1", claudeName: "work::fn-1-foo.1" },
    ctrl.signal,
    deps,
  );
  expect(outcome).toBe("aborted-prelaunch");
  expect(log.launches.length).toBe(0); // never launched
  expect(log.emissions).toEqual([]); // no DispatchFailed
  // The mint request was still issued (it's what got rejected by main).
  expect(log.dispatchedEmissions.length).toBe(1);
});

test("confirmRunning (fn-1061): suppressed ack {ok:false, suppressed:true} → suppressed-dup, no launch, NO DispatchFailed", async () => {
  // The durable mint gate suppressed this re-mint (same verb::id inside the
  // gate window). Distinct from an insert failure: the ack carries
  // `suppressed:true`, so confirmRunning returns the benign `suppressed-dup`
  // outcome (a live attempt is presumed in flight / freshly minted) rather
  // than `aborted-prelaunch`. No launch, no DispatchFailed either way.
  const { deps, log } = makeFakeDeps({
    maxEventId: 100,
    pollIntervalMs: 5,
    ceilingMs: 200,
    dispatchedAck: { ok: false, suppressed: true },
  });
  const ctrl = new AbortController();
  const outcome = await confirmRunning(
    "work",
    "fn-1-foo.1",
    "/repo",
    ["sh", "-c", "true"],
    { prompt: "/plan:work fn-1-foo.1", claudeName: "work::fn-1-foo.1" },
    ctrl.signal,
    deps,
  );
  expect(outcome).toBe("suppressed-dup");
  expect(log.launches.length).toBe(0); // never launched
  expect(log.emissions).toEqual([]); // no DispatchFailed
  // The mint request was still issued (it's what the gate suppressed).
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
    { prompt: "/plan:work fn-1-foo.1", claudeName: "work::fn-1-foo.1" },
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

test("fn-887 runReconcileCycle: a missing launch cwd is blocked-with-reason (cwd-missing) and NOT launched, while a sibling epic with a valid cwd still dispatches", async () => {
  // A renamed-away repo dir must fail LOUD via the existing dispatch-failure
  // surface (sticky `cwd-missing: <path>` DispatchFailed) instead of silently
  // never running — and the block is per-task, so an unrelated sibling epic in
  // a present dir keeps dispatching.
  const present = "/repo-present";
  const missing = "/repo-renamed-away";
  const { deps, log, setJobByKey } = makeFakeDeps({
    dirExists: (dir) => dir === present,
  });
  setJobByKey("work", "fn-2-bar.1", { job_id: "j-2", last_event_id: 201 });

  const epicMissing = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: missing,
    tasks: [makeTask({ task_id: "fn-1-foo.1", epic_id: "fn-1-foo" })],
  });
  const epicPresent = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    project_dir: present,
    tasks: [
      makeTask({ task_id: "fn-2-bar.1", epic_id: "fn-2-bar", task_number: 1 }),
    ],
  });
  const snap = makeSnapshot({ epics: [epicMissing, epicPresent] });
  const state = makeState();
  const liveDispatches = new Map<string, LiveDispatch>();
  const decision = reconcile(snap, state, 0);
  expect(decision.launches.length).toBe(2);

  const ctrl = new AbortController();
  await runReconcileCycle(
    decision,
    state,
    liveDispatches,
    "/bin/zsh",
    ctrl.signal,
    deps,
  );

  // The missing-cwd task minted a sticky cwd-missing DispatchFailed and never
  // launched; the present sibling dispatched and promoted to live.
  expect(log.emissions).toHaveLength(1);
  expect(log.emissions[0]).toMatchObject({
    verb: "work",
    id: "fn-1-foo.1",
    reason: `cwd-missing: ${missing}`,
    dir: missing,
  });
  expect(log.launches.map((l) => l.name)).toEqual(["work::fn-2-bar.1"]);
  expect(liveDispatches.has("work::fn-1-foo.1")).toBe(false);
  expect(liveDispatches.has("work::fn-2-bar.1")).toBe(true);
  // The blocked key never entered the in-flight set (no slot held).
  expect(state.inFlight.has("work::fn-1-foo.1")).toBe(false);
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

test("runReconcileCycle: a missing worker-cell manifest blocks the launch with a sticky DispatchFailed", async () => {
  // The task resolves an in-matrix cell (`opus-max`), but the cell's generated
  // `.claude-plugin/plugin.json` is absent — `claude --plugin-dir` would fall
  // back to the dir basename and `/plan:work` could not resolve `work:worker`.
  // The pre-launch guard must short-circuit BEFORE any spawn: one DispatchFailed
  // carrying a regenerate hint, no launch, no in-flight slot held.
  const { deps, log } = makeFakeDeps({
    // cwd exists; the `.claude-plugin/…` manifest under the cell does not.
    dirExists: (p) => !p.includes(".claude-plugin"),
  });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-1-foo.1", tier: "max", model: "opus" })],
  });
  const snap = makeSnapshot({ epics: [epic] });
  const state = makeState();
  const liveDispatches = new Map<string, LiveDispatch>();
  const decision = reconcile(snap, state, 0);
  expect(decision.launches[0]?.pluginDir).toContain(
    "plugins/plan/workers/opus-max",
  );

  await runReconcileCycle(
    decision,
    state,
    liveDispatches,
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );

  expect(log.launches).toEqual([]); // never spawned
  expect(liveDispatches.size).toBe(0);
  expect(log.emissions.length).toBe(1);
  expect(log.emissions[0]).toMatchObject({ verb: "work", id: "fn-1-foo.1" });
  expect(log.emissions[0]?.reason).toContain("worker-cell-missing");
  expect(log.emissions[0]?.reason).toContain("render-plugin-templates");
  expect(state.inFlight.size).toBe(0);
});

test("runReconcileCycle: an out-of-matrix worker cell blocks the launch with a sticky DispatchFailed", async () => {
  // A corrupt-on-disk task carrying an effort outside the matrix. reconcile
  // carries it as a `pluginDirReject` (never a throw); the producer mints the
  // sticky failure and launches nothing.
  const { deps, log } = makeFakeDeps();
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", tier: "ludicrous", model: "opus" }),
    ],
  });
  const snap = makeSnapshot({ epics: [epic] });
  const state = makeState();
  const liveDispatches = new Map<string, LiveDispatch>();
  const decision = reconcile(snap, state, 0);
  expect(decision.launches[0]?.pluginDirReject).toBeDefined();

  await runReconcileCycle(
    decision,
    state,
    liveDispatches,
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );

  expect(log.launches).toEqual([]);
  expect(log.emissions.length).toBe(1);
  expect(log.emissions[0]?.reason).toContain("worker-cell-invalid");
  expect(state.inFlight.size).toBe(0);
});

test("runReconcileCycle: a WRAPPED-model work row composes + dispatches its cell dir from the snapshot axes (spec + argv)", async () => {
  // In v2 the host matrix IS the one cell axis (ADR 0036): a wrapped capability model
  // listed in subagent_models composes its `workers/<model>-<effort>` cell in the PURE
  // reconcile from the injected snapshot axes, exactly like a native cell — the driver
  // (native vs wrapped) is baked into the rendered cell, not the dispatch path. A
  // per-provider narrowed effort list makes the cube ragged: gpt-5.5 serves only `high`.
  const { deps, log, setJobByKey } = makeFakeDeps({
    dirExists: () => true,
    probeShadowingWorkManifest: () => null,
  });
  // A bound job so `confirmRunning` records the durable dispatch (mirrors the
  // clean-launch happy path); without it the launch fires but nothing confirms.
  setJobByKey("work", "fn-1-foo.1", { job_id: "j-1", last_event_id: 200 });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", tier: "high", model: "gpt-5.5" }),
    ],
  });
  const snap = makeSnapshot({
    epics: [epic],
    hostMatrix: {
      ok: true,
      models: ["opus", "sonnet", "gpt-5.5"],
      effortsByModel: new Map([["gpt-5.5", ["high"]]]),
      efforts: ["low", "medium", "high", "xhigh", "max"],
    },
  });
  const state = makeState();
  const liveDispatches = new Map<string, LiveDispatch>();
  const decision = reconcile(snap, state, 0);
  // The pure reconcile resolves the wrapped cell DIRECTLY from the injected axes —
  // no reject, no route probe: a real cell dir + the capability model threaded on.
  expect(decision.launches[0]?.pluginDir).toContain(
    "plugins/plan/workers/gpt-5.5-high",
  );
  expect(decision.launches[0]?.pluginDirReject).toBeUndefined();
  expect(decision.launches[0]?.matrixReject).toBeUndefined();
  expect(decision.launches[0]?.cellModel).toBe("gpt-5.5");

  await runReconcileCycle(
    decision,
    state,
    liveDispatches,
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );

  // Launched, no sticky — the cell resolved.
  expect(log.emissions).toEqual([]);
  expect(log.launches.length).toBe(1);
  const launch = log.launches[0];
  // The structured spec carries the resolved cell dir…
  expect(launch?.spec?.pluginDir).toContain(
    "plugins/plan/workers/gpt-5.5-high",
  );
  // …and so does the byte-pinned argv: `--plugin-dir <dir>` right after `--name`.
  const argvStr = (launch?.argv ?? []).join(" ");
  expect(argvStr).toContain("--name work::fn-1-foo.1 --plugin-dir ");
  expect(argvStr).toContain("plugins/plan/workers/gpt-5.5-high");
  expect(liveDispatches.size).toBe(1);
});

test("reconcile: a ragged host roster rejects a tier the model's narrowed effort list omits", () => {
  // gpt-5.5 serves only `high`; a `max` task is out-of-matrix against the MODEL's own
  // effort list (not the top-level axis) — a pluginDirReject the producer minted as
  // worker-cell-invalid, never a resolved cell.
  const epic = makeEpic({
    tasks: [makeTask({ task_id: "fn-1-foo.1", tier: "max", model: "gpt-5.5" })],
  });
  const snap = makeSnapshot({
    epics: [epic],
    hostMatrix: {
      ok: true,
      models: ["opus", "sonnet", "gpt-5.5"],
      effortsByModel: new Map([["gpt-5.5", ["high"]]]),
      efforts: ["low", "medium", "high", "xhigh", "max"],
    },
  });
  const plan = reconcile(snap, makeState(), 0).launches[0];
  expect(plan?.pluginDir).toBeNull();
  expect(plan?.pluginDirReject).toContain("unknown tier");
  // Named against the model's OWN (narrowed) list — `high`, not the top-level `max`.
  expect(plan?.pluginDirReject).toContain("high");
});

// ---------------------------------------------------------------------------
// Four-state bad-matrix dispatch parking (ADR 0036) — a matrix that failed to
// load parks EVERY work dispatch behind a visible distress sticky NAMING the
// state, launches nothing, and the daemon loop continues (never a fatalExit).
// ---------------------------------------------------------------------------

const BAD_MATRIX_STATES = [
  "absent",
  "unparseable",
  "schema-invalid",
  "valid-but-empty",
] as const;

for (const stateName of BAD_MATRIX_STATES) {
  test(`runReconcileCycle: a ${stateName} host matrix parks the work dispatch behind a distress sticky naming the state`, async () => {
    const { deps, log } = makeFakeDeps({ dirExists: () => true });
    const epic = makeEpic({
      epic_id: "fn-1-foo",
      project_dir: "/repo",
      tasks: [makeTask({ task_id: "fn-1-foo.1", tier: "max", model: "opus" })],
    });
    const snap = makeSnapshot({
      epics: [epic],
      hostMatrix: {
        ok: false,
        state: stateName,
        detail: `matrix ${stateName} detail (looked at /cfg/matrix.yaml).`,
      },
    });
    const state = makeState();
    const liveDispatches = new Map<string, LiveDispatch>();
    const decision = reconcile(snap, state, 0);
    // The pure reconcile threads the four-state reject onto the launch — no cell.
    expect(decision.launches[0]?.matrixReject?.state).toBe(stateName);
    expect(decision.launches[0]?.pluginDir).toBeNull();
    expect(decision.launches[0]?.pluginDirReject).toBeUndefined();

    await runReconcileCycle(
      decision,
      state,
      liveDispatches,
      "/bin/zsh",
      new AbortController().signal,
      deps,
    );

    // No worker launched; ONE distress sticky whose reason NAMES the state; the
    // producer returned normally (the loop continues — never a fatalExit).
    expect(log.launches).toEqual([]);
    expect(liveDispatches.size).toBe(0);
    expect(state.inFlight.size).toBe(0);
    expect(log.emissions.length).toBe(1);
    expect(log.emissions[0]).toMatchObject({ verb: "work", id: "fn-1-foo.1" });
    expect(log.emissions[0]?.reason).toContain("worker-cell-bad-matrix");
    expect(log.emissions[0]?.reason).toContain(stateName);
  });
}

test("runReconcileCycle: the producer mints the bad-matrix sticky from the SNAPSHOT's verdict, never a fresh re-load (one cycle, one verdict)", async () => {
  // The producer reads plan.matrixReject (from the cycle snapshot), NOT a fresh
  // matrix.yaml load — so a mid-cycle edit cannot flip the verdict a launch was
  // planned under. Pin it with a snapshot-only marker detail no on-disk matrix
  // carries: the sticky reflects the snapshot, proving no producer-side re-load.
  const { deps, log } = makeFakeDeps({ dirExists: () => true });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-1-foo.1", tier: "max", model: "opus" })],
  });
  const snap = makeSnapshot({
    epics: [epic],
    hostMatrix: {
      ok: false,
      state: "schema-invalid",
      detail: "SNAPSHOT-ONLY-MARKER verdict",
    },
  });
  const state = makeState();
  const decision = reconcile(snap, state, 0);
  await runReconcileCycle(
    decision,
    state,
    new Map(),
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );
  expect(log.launches).toEqual([]);
  expect(log.emissions.length).toBe(1);
  expect(log.emissions[0]?.reason).toContain("schema-invalid");
  expect(log.emissions[0]?.reason).toContain("SNAPSHOT-ONLY-MARKER verdict");
});

// ---------------------------------------------------------------------------
// findShadowingWorkManifest — scan-dir probe for a `work`-plugin collision (fn-1042)
// ---------------------------------------------------------------------------

/** Drop a `<scanDir>/<plugin>/.claude-plugin/plugin.json` in the real claude
 *  scan-dir layout (a plugin dir is an IMMEDIATE child of the scan dir). */
function dropScanPlugin(scanDir: string, plugin: string, name: string): string {
  const manifestDir = join(scanDir, plugin, ".claude-plugin");
  mkdirSync(manifestDir, { recursive: true });
  const manifest = join(manifestDir, "plugin.json");
  writeFileSync(manifest, JSON.stringify({ name }));
  return manifest;
}

test("findShadowingWorkManifest: flags a `work` plugin in a real scan-dir position (F4)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ap-scan-shadow-")));
  try {
    const scanDir = join(root, "claude-plugins");
    const manifest = dropScanPlugin(scanDir, "arthack-work", "work");
    // A sibling non-`work` plugin in the same scan dir is ignored.
    dropScanPlugin(scanDir, "some-other", "notes");
    const cellBase = join(root, "keeper", "plugins", "plan", "workers");
    expect(findShadowingWorkManifest([scanDir], cellBase)).toBe(manifest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findShadowingWorkManifest: a `work` cell UNDER the cell base is not a shadow", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ap-scan-cell-")));
  try {
    // A scan dir pointing straight at the generated workers tree enumerates the
    // cells (all `work`-named) as children — those are the legitimate source.
    const cellBase = join(root, "plugins", "plan", "workers");
    dropScanPlugin(cellBase, "opus-max", "work");
    dropScanPlugin(cellBase, "sonnet-max", "work");
    expect(findShadowingWorkManifest([cellBase], cellBase)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findShadowingWorkManifest: clean scan dir (no `work` plugin) → null; missing scan dir skipped", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ap-scan-clean-")));
  try {
    const scanDir = join(root, "claude-plugins");
    dropScanPlugin(scanDir, "keeper", "keeper");
    dropScanPlugin(scanDir, "plan", "plan");
    const cellBase = join(root, "workers");
    expect(
      findShadowingWorkManifest(
        [scanDir, join(root, "does-not-exist")],
        cellBase,
      ),
    ).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runReconcileCycle: a shadowing `work` plugin in a scan dir blocks the launch with a sticky DispatchFailed (fn-1042)", async () => {
  // A non-cell `work` plugin sitting in a real claude scan-dir position would
  // re-claim `work:worker` at launch and silently spawn the wrong worker. The
  // producer probes the scan dirs and mints a sticky `work-plugin-shadowed`
  // DispatchFailed (per-key, retry-clearable) BEFORE any spawn.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ap-shadow-cycle-")));
  try {
    const scanDir = join(root, "claude-plugins");
    const manifest = dropScanPlugin(scanDir, "arthack-work", "work");
    const cellBase = join(root, "keeper", "plugins", "plan", "workers");
    const { deps, log } = makeFakeDeps({
      probeShadowingWorkManifest: () =>
        findShadowingWorkManifest([scanDir], cellBase),
    });
    const epic = makeEpic({
      epic_id: "fn-1-foo",
      project_dir: "/repo",
      tasks: [makeTask({ task_id: "fn-1-foo.1", tier: "max", model: "opus" })],
    });
    const snap = makeSnapshot({ epics: [epic] });
    const state = makeState();
    const liveDispatches = new Map<string, LiveDispatch>();
    const decision = reconcile(snap, state, 0);
    expect(decision.launches[0]?.pluginDir).toContain(
      "plugins/plan/workers/opus-max",
    );

    await runReconcileCycle(
      decision,
      state,
      liveDispatches,
      "/bin/zsh",
      new AbortController().signal,
      deps,
    );

    expect(log.launches).toEqual([]); // never spawned
    expect(liveDispatches.size).toBe(0);
    expect(state.inFlight.size).toBe(0);
    expect(log.emissions.length).toBe(1);
    expect(log.emissions[0]).toMatchObject({ verb: "work", id: "fn-1-foo.1" });
    expect(log.emissions[0]?.reason).toContain("work-plugin-shadowed");
    expect(log.emissions[0]?.reason).toContain(manifest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runReconcileCycle: a clean scan dir (no shadow) launches the cell normally (fn-1042)", async () => {
  // The no-collision path: the scan dir carries no `work` plugin, so the probe
  // returns null and the `work`-cell launch proceeds — no DispatchFailed.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ap-shadow-clean-")));
  try {
    const scanDir = join(root, "claude-plugins");
    dropScanPlugin(scanDir, "keeper", "keeper");
    const cellBase = join(root, "keeper", "plugins", "plan", "workers");
    const { deps, log, setJobByKey } = makeFakeDeps({
      probeShadowingWorkManifest: () =>
        findShadowingWorkManifest([scanDir], cellBase),
    });
    setJobByKey("work", "fn-1-foo.1", { job_id: "j-1", last_event_id: 200 });
    const epic = makeEpic({
      epic_id: "fn-1-foo",
      project_dir: "/repo",
      tasks: [makeTask({ task_id: "fn-1-foo.1", tier: "max", model: "opus" })],
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

    expect(log.launches.length).toBe(1); // launched, no shadow gate
    expect(log.emissions).toEqual([]); // no DispatchFailed
    expect(liveDispatches.size).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// buildWorkerCommand parity with cli/autopilot.ts shape
// ---------------------------------------------------------------------------

test("buildWorkerCommand: work / close flag shapes (fn-756: approve verb gone)", () => {
  expect(buildWorkerCommand("work", "fn-1-foo.1", "/repo")).toBe(
    "cd /repo && claude --model sonnet --effort max --x-no-confirm --name work::fn-1-foo.1 '/plan:work fn-1-foo.1'",
  );
  expect(buildWorkerCommand("close", "fn-1-foo", "/repo")).toBe(
    "cd /repo && claude --model sonnet --effort max --x-no-confirm --name close::fn-1-foo '/plan:close fn-1-foo'",
  );
  // Empty projectDir → no `cd` prefix (degenerate test path).
  expect(buildWorkerCommand("work", "fn-1-foo.1", "")).toBe(
    "claude --model sonnet --effort max --x-no-confirm --name work::fn-1-foo.1 '/plan:work fn-1-foo.1'",
  );
});

// ---------------------------------------------------------------------------
// fn-937 — `worker` preset resolution (defaults to sonnet/max, fail-safe)
// ---------------------------------------------------------------------------

test("buildWorkerCommand / buildPlannedLaunchSpec: a resolved preset overrides BOTH builders in lockstep", () => {
  const cmd = buildWorkerCommand("work", "fn-1-foo.1", "/repo", "opus", "high");
  expect(cmd).toBe(
    "cd /repo && claude --model opus --effort high --x-no-confirm --name work::fn-1-foo.1 '/plan:work fn-1-foo.1'",
  );
  const spec = buildPlannedLaunchSpec("work", "fn-1-foo.1", "opus", "high");
  expect(spec).toEqual({
    prompt: "/plan:work fn-1-foo.1",
    claudeName: "work::fn-1-foo.1",
    model: "opus",
    effort: "high",
  });
});

test("buildWorkerCommand / buildPlannedLaunchSpec: omitted model/effort default to WORKER_* (byte-identical to no-preset)", () => {
  expect(buildWorkerCommand("work", "fn-1-foo.1", "/repo")).toContain(
    `--model ${WORKER_MODEL} --effort ${WORKER_EFFORT}`,
  );
  expect(buildPlannedLaunchSpec("work", "fn-1-foo.1")).toEqual({
    prompt: "/plan:work fn-1-foo.1",
    claudeName: "work::fn-1-foo.1",
    model: WORKER_MODEL,
    effort: WORKER_EFFORT,
  });
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
 * only the schema-required columns are populated. The default board order is
 * `epic_number ASC`, so the seeded `epic_number` makes that order stable.
 *
 * `updated_at` defaults to a RECENT epoch-seconds value (within the
 * `epics_recent_done` window) so a seeded done epic lands inside the
 * `loadReconcileSnapshot` time bound by default; tests probing the window
 * boundary pass an explicit `updated_at`.
 */
function seedEpicRow(
  db: Database,
  epic_id: string,
  opts: {
    epic_number: number;
    status: string;
    updated_at?: number;
    last_validated_at?: string | null;
    /** Epic-level (close-scope) embedded jobs, JSON-serialized. */
    jobs?: EmbeddedJob[];
  },
): void {
  db.query(
    `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at, tasks, depends_on_epics, jobs, job_links, last_validated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    epic_id,
    opts.epic_number,
    `epic ${epic_id}`,
    "/repo",
    opts.status,
    0,
    opts.updated_at ?? Math.floor(Date.now() / 1000),
    "[]",
    "[]",
    JSON.stringify(opts.jobs ?? []),
    "[]",
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
  // fn-897 B1: these tests model the RUNNING daemon — by the time the autopilot
  // calls `loadReconcileSnapshot`, the boot-seed has already cleared
  // `seed_required`. A freshly-migrated DB defaults `seed_required = 1`, which
  // would (correctly, by the new gate) force every readiness verdict to UNKNOWN
  // and suppress the completed-epic verdicts these tests assert. Clear it to
  // reflect the seeded runtime state.
  db.run("UPDATE git_projection_state SET seed_required = 0 WHERE id = 1");
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

test("fn-1200: loadReconcileSnapshot re-proves the stopped-live-pane occupant's pid, keying provenDeadJobIds on the DEAD-pid verdict", async () => {
  await withSeededDb(async (db) => {
    // Two stopped closers, each holding a LIVE pane: one whose recorded claude pid
    // is proven dead (its pane held by a lingering wrapper), one still alive.
    db.run(
      `INSERT INTO jobs (job_id, created_at, updated_at, state, pid, plan_verb, plan_ref, backend_exec_pane_id)
       VALUES ('j-dead', 0, 0, 'stopped', 4242, 'close', 'fn-1-dead', '%7'),
              ('j-live', 0, 0, 'stopped', 5252, 'close', 'fn-2-live', '%8')`,
    );
    const panes: PaneInfo[] = [
      {
        tmuxGenerationId: "1:1",
        paneId: "%7",
        windowId: "@1",
        currentCommand: "bun", // a lingering launcher, NOT a bare shell
        paneDead: "0",
        sessionName: "autopilot",
        windowName: "close::fn-1-dead",
      },
      {
        tmuxGenerationId: "1:1",
        paneId: "%8",
        windowId: "@2",
        currentCommand: "bun",
        paneDead: "0",
        sessionName: "autopilot",
        windowName: "close::fn-2-live",
      },
    ];
    // The injected pid probe: 4242 (j-dead) is gone, 5252 (j-live) still runs.
    const snap = await loadReconcileSnapshot(
      db,
      async () => panes,
      (pid) => pid !== 4242,
    );
    expect(snap.provenDeadJobIds.has("j-dead")).toBe(true);
    expect(snap.provenDeadJobIds.has("j-live")).toBe(false);
  });
});

test("fn-1200: loadReconcileSnapshot leaves provenDeadJobIds empty when the pane probe is degraded (null livePaneIds)", async () => {
  await withSeededDb(async (db) => {
    db.run(
      `INSERT INTO jobs (job_id, created_at, updated_at, state, pid, plan_verb, plan_ref, backend_exec_pane_id)
       VALUES ('j-dead', 0, 0, 'stopped', 4242, 'close', 'fn-1-dead', '%7')`,
    );
    // No listPanes probe → livePaneIds is null → no live-pane candidate set → the
    // pid probe is never consulted and provenDeadJobIds stays empty (the slot pass
    // is inert on a degraded cycle, never a double-dispatch).
    let probed = false;
    const snap = await loadReconcileSnapshot(db, undefined, () => {
      probed = true;
      return false;
    });
    expect(snap.provenDeadJobIds.size).toBe(0);
    expect(probed).toBe(false);
  });
});

test("fn-1107: loadReadinessInputs and loadReconcileSnapshot produce identical readiness inputs over the same seeded db", async () => {
  await withSeededDb(async (db) => {
    // Seed a spread: an open epic, a done epic (pulled back via the recent-done
    // window), and a non-default per-root cap — the read paths must agree on all.
    seedEpicRow(db, "fn-1-open", { epic_number: 1, status: "open" });
    seedEpicRow(db, "fn-2-done", { epic_number: 2, status: "done" });
    // Worktree ON so the stored per-root 3 derives to an effective 3 (worktree off
    // would floor the effective cap to 1 — see effectivePerRootCap); both read
    // paths must agree on the derived value.
    db.run(
      `INSERT OR REPLACE INTO autopilot_state
         (id, paused, last_event_id, created_at, updated_at, max_concurrent_per_root, worktree_mode)
       VALUES (1, 0, 0, 0, 0, 3, 1)`,
    );

    // The MOVED loader and the reconciler's snapshot both read off the same db;
    // every readiness input must be byte-for-byte identical (the anti-drift
    // guarantee this factoring exists to enforce).
    const inputs = loadReadinessInputs(db);
    const snap = await loadReconcileSnapshot(db);

    expect(inputs.epics).toEqual(snap.epics);
    expect([...inputs.jobs.entries()]).toEqual([...snap.jobs.entries()]);
    expect(inputs.subagentInvocations).toEqual(snap.subagentInvocations);
    expect([...inputs.gitStatusByProjectDir.entries()]).toEqual([
      ...snap.gitStatusByProjectDir.entries(),
    ]);
    expect(inputs.pendingDispatches).toEqual(snap.pendingDispatches);
    expect([...inputs.unseededRoots].sort()).toEqual(
      [...snap.unseededRoots].sort(),
    );
    // The per-root cap is read off the SAME autopilot_state row by both paths.
    expect(inputs.maxConcurrentPerRoot).toBe(3);
    expect(snap.maxConcurrentPerRoot).toBe(3);
  });
});

test("fn-1134: loadReadinessInputs derives the EFFECTIVE per-root cap through worktree mode (toggle round-trip)", async () => {
  await withSeededDb((db) => {
    // Stored intent 3 with worktree OFF (the default) → the effective cap floors
    // to 1: the reconciler + autoclose (both read through this seam) never
    // over-dispatch a shared checkout.
    db.run(
      `INSERT OR REPLACE INTO autopilot_state
         (id, paused, last_event_id, created_at, updated_at, max_concurrent_per_root, worktree_mode)
       VALUES (1, 0, 0, 0, 0, 3, 0)`,
    );
    expect(loadReadinessInputs(db).maxConcurrentPerRoot).toBe(1);
    // Flip worktree ON — the stored intent (untouched) is now honored: effective 3.
    db.run("UPDATE autopilot_state SET worktree_mode = 1 WHERE id = 1");
    expect(loadReadinessInputs(db).maxConcurrentPerRoot).toBe(3);
    // Flip back OFF — the derivation re-floors to 1, but the STORED column is
    // preserved (no re-set): a subsequent ON flip restores 3 with no re-write.
    db.run("UPDATE autopilot_state SET worktree_mode = 0 WHERE id = 1");
    expect(loadReadinessInputs(db).maxConcurrentPerRoot).toBe(1);
    const stored = db
      .query(
        "SELECT max_concurrent_per_root AS v FROM autopilot_state WHERE id = 1",
      )
      .get() as { v: number };
    expect(stored.v).toBe(3);
  });
});

test("fn-1134: readBootStatus publishes the EFFECTIVE per-root cap; the SELECT reads worktree_mode (worktree off + stored 3 → 1)", async () => {
  await withSeededDb((db) => {
    db.run(
      `INSERT OR REPLACE INTO autopilot_state
         (id, paused, last_event_id, created_at, updated_at, max_concurrent_per_root, worktree_mode)
       VALUES (1, 0, 0, 0, 0, 3, 0)`,
    );
    // Worktree OFF → the wire field carries the effective 1, NOT the stored 3.
    // This is the guard that catches a SELECT omitting `worktree_mode` (which
    // would see an absent column and silently publish the stored 3).
    expect(readBootStatus(db, { ready: true }).max_concurrent_per_root).toBe(1);
    // Worktree ON → the wire field carries the stored 3.
    db.run("UPDATE autopilot_state SET worktree_mode = 1 WHERE id = 1");
    expect(readBootStatus(db, { ready: true }).max_concurrent_per_root).toBe(3);
  });
});

test("fn-811: loadReconcileSnapshot maps a listPanes probe into livePaneIds", async () => {
  await withSeededDb(async (db) => {
    const snap = await loadReconcileSnapshot(db, async () => [
      {
        tmuxGenerationId: "gen",
        paneId: "%1",
        windowId: "@1",
        currentCommand: "claude",
        paneDead: "0",
        sessionName: "autopilot",
        windowName: "w1",
      },
      {
        tmuxGenerationId: "gen",
        paneId: "%2",
        windowId: "@2",
        currentCommand: "zsh",
        paneDead: "0",
        sessionName: "autopilot",
        windowName: "w2",
      },
    ]);
    expect(snap.livePaneIds).not.toBeNull();
    expect([...(snap.livePaneIds ?? [])].sort()).toEqual(["%1", "%2"]);
  });
});

test("fn-811: loadReconcileSnapshot yields null livePaneIds with no probe, a null probe, or a throwing probe", async () => {
  await withSeededDb(async (db) => {
    // No probe injected — the conservative fallback.
    expect((await loadReconcileSnapshot(db)).livePaneIds).toBeNull();
    // Probe present but degraded tmux returns null.
    expect(
      (await loadReconcileSnapshot(db, async () => null)).livePaneIds,
    ).toBeNull();
    // A throwing probe must not crash the cycle — it falls back to null.
    expect(
      (
        await loadReconcileSnapshot(db, async () => {
          throw new Error("tmux blew up");
        })
      ).livePaneIds,
    ).toBeNull();
  });
});

test("fn-953: loadReconcileSnapshot resolves maxConcurrentJobs from the autopilot_state column", async () => {
  await withSeededDb(async (db) => {
    // A folded `autopilot_state` row carrying a positive cap → the snapshot reads
    // it (the runtime-set value is reflected on the next cycle).
    db.run(
      `INSERT INTO autopilot_state (id, paused, last_event_id, created_at, updated_at, max_concurrent_jobs, mode)
       VALUES (1, 1, 1, 0, 0, 5, 'yolo')`,
    );
    const snap = await loadReconcileSnapshot(db);
    expect(snap.maxConcurrentJobs).toBe(5);
  });
});

test("fn-953: loadReconcileSnapshot resolves maxConcurrentJobs to DEFAULT on a fresh (no-row) DB", async () => {
  await withSeededDb(async (db) => {
    // No `autopilot_state` row at all (the boot-append is gone) → the snapshot
    // resolves `column ?? DEFAULT` = the unlimited (`null`) in-memory default,
    // byte-identical to the pre-fn-953 unlimited behavior.
    const snap = await loadReconcileSnapshot(db);
    expect(snap.maxConcurrentJobs).toBe(DEFAULT_MAX_CONCURRENT_JOBS);
    expect(snap.maxConcurrentJobs).toBeNull();
  });
});

test("fn-953: loadReconcileSnapshot resolves a NULL/non-positive cap column to DEFAULT (unlimited)", async () => {
  await withSeededDb(async (db) => {
    // A row whose cap is SQL NULL (cleared to unlimited) resolves to DEFAULT.
    db.run(
      `INSERT INTO autopilot_state (id, paused, last_event_id, created_at, updated_at, max_concurrent_jobs, mode)
       VALUES (1, 0, 1, 0, 0, NULL, 'armed')`,
    );
    const snap = await loadReconcileSnapshot(db);
    expect(snap.maxConcurrentJobs).toBe(DEFAULT_MAX_CONCURRENT_JOBS);
    // Sibling columns still read correctly from the same row.
    expect(snap.mode).toBe("armed");
  });
});

test("fn-953: a snapshot-resolved cap drives the reconcile budget once refreshed onto state", async () => {
  await withSeededDb(async (db) => {
    // End-to-end: a runtime cap in the projection → snapshot → state → reconcile
    // budget. Two ready sibling tasks under a cap of 1 admit exactly one launch.
    db.run(
      `INSERT INTO autopilot_state (id, paused, last_event_id, created_at, updated_at, max_concurrent_jobs, mode)
       VALUES (1, 0, 1, 0, 0, 1, 'yolo')`,
    );
    const snap = await loadReconcileSnapshot(db);
    expect(snap.maxConcurrentJobs).toBe(1);
    // The cycle glue refreshes `state.maxConcurrentJobs` from the snapshot before
    // `reconcile` reads it — model that here.
    const state = makeState();
    state.maxConcurrentJobs = snap.maxConcurrentJobs;
    expect(state.maxConcurrentJobs).toBe(1);
  });
});

test("fn-779: a done epic with LIVE close-scope work never enters completedRowIds (liveness-gated completion)", async () => {
  await withSeededDb(async (db) => {
    // A done epic whose closer is still winding down — an epic-level (close-verb)
    // job is `working`. evaluateCloseRow's predicate 1 holds the verdict off
    // `completed` (it falls through to running:*), so the id is absent from
    // completedRowIds.
    seedEpicRow(db, "fn-9-done", {
      epic_number: 9,
      status: "done",
      jobs: [{ job_id: "j-close", state: "working" } as unknown as EmbeddedJob],
    });
    const snap = await loadReconcileSnapshot(db);
    expect(snap.epics.map((e) => e.epic_id)).toContain("fn-9-done");
    const decision = reconcile(snap, makeState(), 0);
    // Done-but-live: NOT a completed row.
    expect(decision.completedRowIds.has("fn-9-done")).toBe(false);
  });
});

test("fn-779: the SAME done epic, once its closer is idle, enters completedRowIds", async () => {
  await withSeededDb(async (db) => {
    // Identical epic, but the close job is no longer `working` (closer idle) —
    // the only difference from the suppressed case above. Predicate 1 now emits
    // `{tag:"completed"}`, so the id reaches completedRowIds.
    seedEpicRow(db, "fn-9-done", {
      epic_number: 9,
      status: "done",
      jobs: [{ job_id: "j-close", state: "done" } as unknown as EmbeddedJob],
    });
    const snap = await loadReconcileSnapshot(db);
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

test("fn-950: the done-epics read is TIME-bounded — in-window done epics carried, stale ones dropped", async () => {
  await withSeededDb(async (db) => {
    // The bound is a DURATION, not a count: `updated_at >= now - WINDOW`.
    // `loadReconcileSnapshot` reads with live `Date.now()`, so anchor the seed
    // epochs to it. `updated_at` is Unix SECONDS (folds from `event.ts`), the
    // same unit as the cutoff — the seconds-vs-ms trap the spec flags.
    const now = Math.floor(Date.now() / 1000);
    // INSIDE the window: comfortably inside, and at the inclusive boundary
    // (`>=` cutoff). The cutoff is `now - WINDOW`; a row AT it is carried.
    seedEpicRow(db, "fn-1-fresh", {
      epic_number: 1,
      status: "done",
      updated_at: now,
    });
    seedEpicRow(db, "fn-2-midwindow", {
      epic_number: 2,
      status: "done",
      updated_at: now - Math.floor(DONE_EPICS_REAP_WINDOW_SEC / 2),
    });
    seedEpicRow(db, "fn-3-boundary", {
      epic_number: 3,
      status: "done",
      updated_at: now - DONE_EPICS_REAP_WINDOW_SEC,
    });
    // OUTSIDE the window: one second past the floor, and far past it. Both must
    // drop — the time bound, not a count, is the sole guard against O(all done).
    seedEpicRow(db, "fn-4-juststale", {
      epic_number: 4,
      status: "done",
      updated_at: now - DONE_EPICS_REAP_WINDOW_SEC - 1,
    });
    seedEpicRow(db, "fn-5-ancient", {
      epic_number: 5,
      status: "done",
      updated_at: now - DONE_EPICS_REAP_WINDOW_SEC * 10,
    });
    const snap = await loadReconcileSnapshot(db);
    const carried = new Set(snap.epics.map((e) => e.epic_id));
    // In-window (including the inclusive boundary) carried.
    expect(carried.has("fn-1-fresh")).toBe(true);
    expect(carried.has("fn-2-midwindow")).toBe(true);
    expect(carried.has("fn-3-boundary")).toBe(true);
    // Stale dropped — no count LIMIT, the duration floor is the only bound.
    expect(carried.has("fn-4-juststale")).toBe(false);
    expect(carried.has("fn-5-ancient")).toBe(false);
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
  expect(isEpicInFlight(epic, noJobs, noTabs, null)).toBe(false);

  // Occupying close job.
  const closeJob = new Map([
    [
      "j-c",
      makeJob({ state: "working", plan_verb: "close", plan_ref: "fn-1-foo" }),
    ],
  ]);
  expect(isEpicInFlight(epic, closeJob, noTabs, null)).toBe(true);

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
  // `null` liveness (degraded probe) keeps the stopped work job occupying.
  expect(isEpicInFlight(epic, workJob, noTabs, null)).toBe(true);

  // Live close surface.
  expect(isEpicInFlight(epic, noJobs, new Set(["close::fn-1-foo"]), null)).toBe(
    true,
  );

  // Live work surface on a task.
  expect(
    isEpicInFlight(epic, noJobs, new Set(["work::fn-1-foo.1"]), null),
  ).toBe(true);

  // A job/surface for a DIFFERENT epic's task does not flip it.
  expect(
    isEpicInFlight(epic, noJobs, new Set(["work::fn-2-bar.1"]), null),
  ).toBe(false);
});

test("fn-770: armed epic on a SHARED root beats an earlier-sorted unarmed sibling and dispatches", () => {
  // THE DEADLOCK FIX. Two open epics share `/repo`; the earlier-sorted (lower
  // epic_number) `fn-1-unarmed` is NOT armed, `fn-2-armed` is. Pre-fn-770 the
  // armed-blind per-root mutex awarded `/repo` to fn-1 (first ready in sort
  // order), the armed gate then suppressed fn-1's launch (ineligible) AND fn-2
  // was already mutex-demoted → net deadlock, fn-2 never dispatched. With the
  // eligible-priority pass-2, fn-2 (eligible) wins `/repo`, fn-1 is demoted,
  // and exactly one `work` launches for fn-2.
  const unarmed = makeEpic({
    epic_id: "fn-1-unarmed",
    epic_number: 1,
    project_dir: "/repo",
    resolved_epic_deps: [],
    tasks: [makeTask({ task_id: "fn-1-unarmed.1", epic_id: "fn-1-unarmed" })],
  });
  const armed = makeEpic({
    epic_id: "fn-2-armed",
    epic_number: 2,
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
    project_dir: "/repo",
    resolved_epic_deps: [],
    tasks: [makeTask({ task_id: "fn-1-unarmed.1", epic_id: "fn-1-unarmed" })],
  });
  const second = makeEpic({
    epic_id: "fn-2-armed",
    epic_number: 2,
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

// ---------------------------------------------------------------------------
// fn-959 — worktree-mode wiring into reconcile + runReconcileCycle
// ---------------------------------------------------------------------------

// A recording fake WorktreeDriver — captures the ordered method calls + lets a
// test force a failure on any leg (the sticky-DispatchFailed paths).
interface FakeWorktreeLog {
  calls: string[];
  provisions: WorktreeLaunchInfo[];
  provisionAttributions: (ReadonlySet<string> | null)[];
  finalizes: WorktreeLaunchInfo[];
  assertCwds: string[];
  recoverRepos: string[][];
}
function makeFakeWorktreeDriver(opts?: {
  provisionFail?: (info: WorktreeLaunchInfo) => string | null;
  provisionRetry?: (info: WorktreeLaunchInfo) => string | null;
  // A fan-in LANE pre-merge failure — the self-clearing shape `{ ok:false, reason,
  // dir }` (a `worktree-lane-premerge` reason + the base lane worktree path), NEVER
  // `retry:true`. The real driver returns `dir: worktreePath` for it.
  provisionPremerge?: (
    info: WorktreeLaunchInfo,
  ) => { reason: string; dir: string } | null;
  finalizeFail?: (info: WorktreeLaunchInfo) => string | null;
  finalizeRetry?: (info: WorktreeLaunchInfo) => string | null;
  assertFail?: (cwd: string) => string | null;
  recoverFailures?: WorktreeRecoveryFailure[];
  recoverEscalations?: WorktreeRecoveryEscalation[];
  recoverResolved?: WorktreeRecoveryResolution[];
  recoverLaneResolved?: string[];
  recoverLaneWedged?: { path: string; reason: string; immediate: boolean }[];
}): { driver: WorktreeDriver; log: FakeWorktreeLog } {
  const log: FakeWorktreeLog = {
    calls: [],
    provisions: [],
    provisionAttributions: [],
    finalizes: [],
    assertCwds: [],
    recoverRepos: [],
  };
  const driver: WorktreeDriver = {
    async provision(info, liveAttributedDirty) {
      log.calls.push(`provision:${info.assignment.nodeId}`);
      log.provisions.push(info);
      log.provisionAttributions.push(liveAttributedDirty);
      // `provisionRetry` wins first (a transient not-ready base → retry-skip, no
      // sticky), mirroring `finalizeRetry`; `provisionPremerge` is a self-clearing
      // lane row (carries a `dir`); `provisionFail` is a genuine block (no `dir`).
      const retry = opts?.provisionRetry?.(info) ?? null;
      if (retry !== null) {
        return { ok: false, retry: true, reason: retry };
      }
      const premerge = opts?.provisionPremerge?.(info) ?? null;
      if (premerge !== null) {
        return { ok: false, reason: premerge.reason, dir: premerge.dir };
      }
      const reason = opts?.provisionFail?.(info) ?? null;
      if (reason !== null) {
        return { ok: false, reason };
      }
      return { ok: true, cwd: info.assignment.worktreePath };
    },
    async finalizeEpic(info) {
      log.calls.push(`finalize:${info.baseBranch}`);
      log.finalizes.push(info);
      const retry = opts?.finalizeRetry?.(info) ?? null;
      if (retry !== null) {
        return { ok: false, retry: true, reason: retry };
      }
      const reason = opts?.finalizeFail?.(info) ?? null;
      if (reason !== null) {
        return { ok: false, reason };
      }
      return { ok: true };
    },
    async assertOnDefaultBranch(cwd) {
      log.calls.push(`assert:${cwd}`);
      log.assertCwds.push(cwd);
      const reason = opts?.assertFail?.(cwd) ?? null;
      if (reason !== null) {
        return { ok: false, reason };
      }
      return { ok: true };
    },
    async recover(repos) {
      log.calls.push(`recover:${[...repos].join(",")}`);
      log.recoverRepos.push([...repos]);
      return {
        failures: opts?.recoverFailures ?? [],
        escalations: opts?.recoverEscalations ?? [],
        resolved: opts?.recoverResolved ?? [],
        laneResolved: opts?.recoverLaneResolved ?? [],
        laneWedged: opts?.recoverLaneWedged ?? [],
      };
    },
  };
  return { driver, log };
}

test("fn-959 reconcile: worktree OFF → no geometry on launches, empty finalize set (byte-identical except producer assertion)", () => {
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = makeSnapshot({ epics: [epic], worktreeMode: false });
  const decision = reconcile(snap, makeState(), 0);
  expect(decision.launches.length).toBe(1);
  expect(decision.launches[0]?.worktree).toBeUndefined();
  expect(decision.launches[0]?.worktreeReject).toBeUndefined();
  expect(decision.worktreeFinalize).toEqual([]);
});

test("fn-959 reconcile: worktree ON → a linear chain shares the base lane, deterministic branch + path", () => {
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/home/me/repo",
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1, depends_on: [] }),
    ],
  });
  const snap = makeSnapshot({ epics: [epic], worktreeMode: true });
  const decision = reconcile(snap, makeState(), 0);
  const wt = decision.launches[0]?.worktree;
  expect(wt).toBeDefined();
  expect(wt?.assignment.branch).toBe("keeper/epic/fn-1-foo");
  expect(wt?.baseBranch).toBe("keeper/epic/fn-1-foo");
  // ~/worktrees/<repoName>-<hash>--<branch-slug>, slug = branch with `/` → `-`.
  expect(wt?.assignment.worktreePath).toBe(
    worktreePathFor("/home/me/repo", "keeper/epic/fn-1-foo"),
  );
  expect(wt?.assignment.inherited).toBe(true);
  expect(wt?.assignment.preMerges).toEqual([]);
});

test("fn-959 reconcile: worktree ON diamond → the non-primary child forks a rib, fan-in pre-merges its lane", () => {
  // P → {A, B} → J. A inherits base (first child), B forks a rib; J inherits A's
  // lane (base) and pre-merges B's rib branch before it runs.
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [
      makeTask({ task_id: "fn-1-foo.P", task_number: 1, depends_on: [] }),
      makeTask({
        task_id: "fn-1-foo.A",
        task_number: 2,
        depends_on: ["fn-1-foo.P"],
      }),
      makeTask({
        task_id: "fn-1-foo.B",
        task_number: 3,
        depends_on: ["fn-1-foo.P"],
      }),
      makeTask({
        task_id: "fn-1-foo.J",
        task_number: 4,
        depends_on: ["fn-1-foo.A", "fn-1-foo.B"],
      }),
    ],
  });
  const snap = makeSnapshot({ epics: [epic], worktreeMode: true });
  const decision = reconcile(snap, makeState(), 0);
  const byId = new Map(
    decision.launches.map((l) => [l.id, l.worktree] as const),
  );
  // P + A on base; B on a rib; J on base, pre-merging B's rib branch.
  expect(byId.get("fn-1-foo.P")?.assignment.branch).toBe(
    "keeper/epic/fn-1-foo",
  );
  // Only P is ready this cycle (A/B/J are blocked on deps), so only P launches —
  // assert P's geometry; the topology for B/J is covered by worktree-plan.test.ts.
  expect(decision.launches.map((l) => l.id)).toEqual(["fn-1-foo.P"]);
});

test("fn-959 reconcile: worktree ON multi-repo epic → every launch stamped worktreeReject", () => {
  // Two tasks resolving to distinct repo dirs (per-task target_repo spanning
  // toplevels) — rejected loudly in worktree mode for v1.
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo-a",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        target_repo: "/repo-a",
      }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        target_repo: "/repo-b",
      }),
    ],
  });
  const snap = makeSnapshot({ epics: [epic], worktreeMode: true });
  const decision = reconcile(snap, makeState(), 0);
  expect(decision.launches.length).toBeGreaterThan(0);
  for (const l of decision.launches) {
    expect(l.worktreeReject).toBeDefined();
    expect(l.worktreeReject?.reason).toContain("worktree-multi-repo");
    expect(l.worktree).toBeUndefined();
  }
});

// ---------------------------------------------------------------------------
// fn-978 — lane geometry resolves RAW target_repo/project_dir to git toplevels
// ONCE in the producer snapshot-build, so the pure gate + dispatch compare and
// place lanes by RESOLVED toplevel. All resolution is fed by an INJECTED
// synthetic resolver (no real git in the fast tier).
// ---------------------------------------------------------------------------

/** A worktree-ON snapshot whose repo classification uses a synthetic resolver
 *  (and an optional synthetic eligibility probe — defaults to always-eligible —
 *  plus an optional synthetic grandfather predicate, defaults to never). */
function worktreeSnap(
  epics: Epic[],
  resolve: (root: string) => string | null,
  assessRepo?: (toplevel: string) => { eligible: boolean; reason: string },
  isGrandfathered?: (epicId: string, repoDir: string) => boolean,
): ReconcileSnapshot {
  return makeSnapshot({
    epics,
    worktreeMode: true,
    worktreeRepoByEpicId: classifyWorktreeRepos(
      epics,
      resolve,
      assessRepo,
      isGrandfathered,
    ),
  });
}

test("fn-978 classifyWorktreeRepos: subdir + trailing-slash roots resolving to ONE toplevel → ok on that toplevel", () => {
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1 }), // → project_dir /repo
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        target_repo: "/repo/packages/app", // a subdir
      }),
      makeTask({
        task_id: "fn-1-foo.3",
        task_number: 3,
        target_repo: "/repo/", // trailing slash
      }),
    ],
  });
  const map = classifyWorktreeRepos([epic], (r) =>
    r.startsWith("/repo") ? "/repo" : null,
  );
  expect(map.get("fn-1-foo")).toEqual({ kind: "ok", repoDir: "/repo" });
});

test("fn-978 classifyWorktreeRepos: >1 distinct resolved toplevel → multi-repo (reason names the toplevels)", () => {
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo-a",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        target_repo: "/repo-a/x",
      }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        target_repo: "/repo-b/y",
      }),
    ],
  });
  const map = classifyWorktreeRepos([epic], (r) =>
    r.startsWith("/repo-a")
      ? "/repo-a"
      : r.startsWith("/repo-b")
        ? "/repo-b"
        : null,
  );
  const res = map.get("fn-1-foo");
  expect(res?.kind).toBe("multi-repo");
  // The stable routing prefix is preserved (sticky-row dispatch-failure keying).
  expect(res?.kind === "multi-repo" && res.reason).toContain(
    "worktree-multi-repo",
  );
  // The RESOLVED toplevels, not the raw subdir strings.
  expect(res?.kind === "multi-repo" && res.reason).toContain("/repo-a");
  expect(res?.kind === "multi-repo" && res.reason).toContain("/repo-b");
  // fn-1071: the reason names the actual condition (the off flag) AND the exact
  // command that unjams it, not a misleading "not inside a git worktree".
  expect(res?.kind === "multi-repo" && res.reason).toContain(
    "worktree_multi_repo",
  );
  expect(res?.kind === "multi-repo" && res.reason).toContain(
    "keeper autopilot config worktree_multi_repo on",
  );
  expect(res?.kind === "multi-repo" && res.reason).not.toContain(
    "not inside a git worktree",
  );
});

test("fn-978 classifyWorktreeRepos: a required root resolving null → unresolved (distinct from multi-repo)", () => {
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        target_repo: "/not/a/repo",
      }),
    ],
  });
  const res = classifyWorktreeRepos([epic], (r) =>
    r === "/repo" ? "/repo" : null,
  ).get("fn-1-foo");
  expect(res?.kind).toBe("unresolved");
  expect(res?.kind === "unresolved" && res.reason).toContain(
    "worktree-repo-unresolved",
  );
});

test("fn-1013 buildWorktreeStatusEntries: only `disabled` resolutions surface, sorted by epic_id with repo_dir + reason", () => {
  const map = classifyWorktreeRepos(
    [
      // ok → worktree lane (NOT surfaced).
      makeEpic({
        epic_id: "fn-1-ok",
        project_dir: "/code/keeper",
        tasks: [makeTask({ task_id: "fn-1-ok.1", task_number: 1 })],
      }),
      // disabled (a workspace marker) → serial (surfaced).
      makeEpic({
        epic_id: "fn-3-mono",
        project_dir: "/code/arthack",
        tasks: [makeTask({ task_id: "fn-3-mono.1", task_number: 1 })],
      }),
      makeEpic({
        epic_id: "fn-2-cargo",
        project_dir: "/code/zellijsub",
        tasks: [makeTask({ task_id: "fn-2-cargo.1", task_number: 1 })],
      }),
    ],
    (r) => r, // identity resolver — each project_dir IS its toplevel
    (toplevel) =>
      toplevel === "/code/keeper"
        ? { eligible: true, reason: "worktree-eligible" }
        : {
            eligible: false,
            reason: `worktree-disabled:workspace-marker:${
              toplevel === "/code/arthack"
                ? "pnpm-workspace"
                : "cargo-workspace"
            }`,
          },
  );

  expect(buildWorktreeStatusEntries(map)).toEqual([
    {
      epic_id: "fn-2-cargo",
      repo_dir: "/code/zellijsub",
      mode: "serial",
      reason: "worktree-disabled:workspace-marker:cargo-workspace",
    },
    {
      epic_id: "fn-3-mono",
      repo_dir: "/code/arthack",
      mode: "serial",
      reason: "worktree-disabled:workspace-marker:pnpm-workspace",
    },
  ]);
});

test("fn-1013 buildWorktreeStatusEntries: an all-eligible board surfaces NO entries (empty set clears the projection)", () => {
  const map = classifyWorktreeRepos(
    [
      makeEpic({
        epic_id: "fn-1-ok",
        project_dir: "/code/keeper",
        tasks: [makeTask({ task_id: "fn-1-ok.1", task_number: 1 })],
      }),
    ],
    (r) => r,
    () => ({ eligible: true, reason: "worktree-eligible" }),
  );
  expect(buildWorktreeStatusEntries(map)).toEqual([]);
});

test("fn-978 classifyWorktreeRepos: an empty root → unresolved WITHOUT calling the resolver", () => {
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "", // empty → empty effective root
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1, target_repo: null }),
    ],
  });
  let calls = 0;
  const map = classifyWorktreeRepos([epic], (r) => {
    calls++;
    return r;
  });
  expect(map.get("fn-1-foo")?.kind).toBe("unresolved");
  expect(calls).toBe(0); // empty short-circuited BEFORE the resolver (no spawn)
});

test("fn-978 classifyWorktreeRepos: a no-task epic resolves its own project_dir", () => {
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo/sub",
    tasks: [],
  });
  const res = classifyWorktreeRepos([epic], (r) =>
    r.startsWith("/repo") ? "/repo" : null,
  ).get("fn-1-foo");
  expect(res).toEqual({ kind: "ok", repoDir: "/repo" });
});

test("fn-978 reconcile: raw roots differing but resolving to ONE toplevel are NOT multi-repo — lane on the resolved toplevel", () => {
  // The false-rejection bug: under raw-string comparison the three distinct roots
  // would be rejected `worktree-multi-repo`; resolving them to one toplevel un-darks
  // the epic and provisions its lane on the resolved toplevel.
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1 }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        target_repo: "/repo/packages/app",
        depends_on: ["fn-1-foo.1"],
      }),
      makeTask({
        task_id: "fn-1-foo.3",
        task_number: 3,
        target_repo: "/repo/",
        depends_on: ["fn-1-foo.1"],
      }),
    ],
  });
  const snap = worktreeSnap([epic], (r) =>
    r.startsWith("/repo") ? "/repo" : null,
  );
  const decision = reconcile(snap, makeState(), 0);
  // No launch is rejected, and the ready root's lane is on the RESOLVED toplevel.
  expect(decision.launches.every((l) => l.worktreeReject === undefined)).toBe(
    true,
  );
  const root = decision.launches.find((l) => l.id === "fn-1-foo.1");
  expect(root?.worktree?.repoDir).toBe("/repo");
  expect(root?.worktree?.assignment.worktreePath).toBe(
    worktreePathFor("/repo", "keeper/epic/fn-1-foo"),
  );
});

test("fn-978 reconcile: tasks sharing a target_repo != project_dir derive the lane base from the RESOLVED target", () => {
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/created-here", // where the epic was created — NOT a task root
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        target_repo: "/target/sub",
      }),
    ],
  });
  const snap = worktreeSnap([epic], (r) =>
    r.startsWith("/target")
      ? "/target"
      : r === "/created-here"
        ? "/created-here"
        : null,
  );
  const decision = reconcile(snap, makeState(), 0);
  const launch = decision.launches.find((l) => l.id === "fn-1-foo.1");
  expect(launch?.worktreeReject).toBeUndefined();
  // repoDir + the lane base use the RESOLVED target "/target", never raw project_dir.
  expect(launch?.worktree?.repoDir).toBe("/target");
  expect(launch?.worktree?.baseWorktreePath).toBe(
    worktreePathFor("/target", "keeper/epic/fn-1-foo"),
  );
});

test("fn-978 reconcile: tasks resolving to >1 distinct toplevel are still rejected worktree-multi-repo", () => {
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo-a",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        target_repo: "/repo-a/x",
      }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        target_repo: "/repo-b/y",
      }),
    ],
  });
  const snap = worktreeSnap([epic], (r) =>
    r.startsWith("/repo-a")
      ? "/repo-a"
      : r.startsWith("/repo-b")
        ? "/repo-b"
        : null,
  );
  const decision = reconcile(snap, makeState(), 0);
  expect(decision.launches.length).toBeGreaterThan(0);
  for (const l of decision.launches) {
    expect(l.worktreeReject?.reason).toContain("worktree-multi-repo");
    expect(l.worktree).toBeUndefined();
  }
});

test("fn-978 reconcile: a required root resolving null → distinct sticky worktree-repo-unresolved (not multi-repo)", () => {
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        target_repo: "/not/a/repo",
      }),
    ],
  });
  const snap = worktreeSnap([epic], (r) => (r === "/repo" ? "/repo" : null));
  const decision = reconcile(snap, makeState(), 0);
  expect(decision.launches.length).toBeGreaterThan(0);
  for (const l of decision.launches) {
    expect(l.worktreeReject?.reason).toContain("worktree-repo-unresolved");
    expect(l.worktreeReject?.reason).not.toContain("worktree-multi-repo");
    expect(l.worktree).toBeUndefined();
  }
});

test("fn-1001 classifyWorktreeRepos: one toplevel but empty primary_repo → no-primary-repo (operator-required, NOT ok)", () => {
  // The landmine: tasks all carry a target_repo (single toplevel) so the epic
  // WOULD classify `ok`, but the epic has no primary_repo (project_dir) — so plan
  // state would degrade to the lane checkout. Reject before any lane is keyed.
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "", // no primary_repo
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1, target_repo: "/repo" }),
    ],
  });
  const res = classifyWorktreeRepos([epic], (r) =>
    r === "/repo" ? "/repo" : null,
  ).get("fn-1-foo");
  expect(res?.kind).toBe("no-primary-repo");
  expect(res?.kind === "no-primary-repo" && res.reason).toContain(
    "worktree-no-primary-repo",
  );
  // Operator-required: OUTSIDE the worktree-recover auto-clear prefix.
  expect(
    res?.kind === "no-primary-repo" && isWorktreeRecoverReason(res.reason),
  ).toBe(false);
});

test("fn-1001 classifyWorktreeRepos: one toplevel WITH primary_repo set → ok (byte-identical, even when base != primary_repo)", () => {
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/created-here", // a non-empty primary_repo, distinct from the base
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1, target_repo: "/repo" }),
    ],
  });
  const res = classifyWorktreeRepos([epic], (r) =>
    r === "/repo" ? "/repo" : r === "/created-here" ? "/created-here" : null,
  ).get("fn-1-foo");
  expect(res).toEqual({ kind: "ok", repoDir: "/repo" });
});

test("fn-1001 reconcile: worktree ON, single-toplevel epic with empty primary_repo → every launch stamped worktree-no-primary-repo, no lane", () => {
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "", // no primary_repo
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1, target_repo: "/repo" }),
    ],
  });
  const snap = worktreeSnap([epic], (r) => (r === "/repo" ? "/repo" : null));
  const decision = reconcile(snap, makeState(), 0);
  expect(decision.launches.length).toBeGreaterThan(0);
  for (const l of decision.launches) {
    expect(l.worktreeReject?.reason).toContain("worktree-no-primary-repo");
    expect(l.worktreeReject?.reason).not.toContain("worktree-multi-repo");
    expect(l.worktreeReject?.reason).not.toContain("worktree-repo-unresolved");
    // No lane geometry was attached — nothing was provisioned.
    expect(l.worktree).toBeUndefined();
  }
});

test("fn-1001 reconcile: worktree ON, single-toplevel epic WITH primary_repo set → provisions a lane unchanged (no reject)", () => {
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo", // primary_repo present
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1, target_repo: "/repo" }),
    ],
  });
  const snap = worktreeSnap([epic], (r) => (r === "/repo" ? "/repo" : null));
  const decision = reconcile(snap, makeState(), 0);
  const launch = decision.launches.find((l) => l.id === "fn-1-foo.1");
  expect(launch?.worktreeReject).toBeUndefined();
  expect(launch?.worktree?.repoDir).toBe("/repo");
});

test("fn-978 runReconcileCycle: an unresolved epic surfaces worktree-repo-unresolved AHEAD of cwd-missing (raw cwd never stat'd)", async () => {
  const { driver, log } = makeFakeWorktreeDriver();
  const { deps, log: depsLog } = makeFakeDeps({
    worktree: driver,
    // Even if the raw root's dir were "missing", the reject is evaluated first.
    dirExists: () => false,
  });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        target_repo: "/not/a/repo",
      }),
    ],
  });
  const snap = worktreeSnap([epic], (r) => (r === "/repo" ? "/repo" : null));

  await runReconcileCycle(
    reconcile(snap, makeState(), 0),
    makeState(),
    new Map<string, LiveDispatch>(),
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );

  // No git driver ran; every emission is the distinct unresolved reject, NOT a
  // generic cwd-missing.
  expect(log.calls).toEqual([]);
  expect(depsLog.launches).toEqual([]);
  expect(depsLog.emissions.length).toBeGreaterThan(0);
  for (const e of depsLog.emissions) {
    expect(e.reason).toContain("worktree-repo-unresolved");
    expect(e.reason).not.toContain("cwd-missing");
  }
});

test("fn-978 prepareWorktreeGeometry: gate laneKeyById ↔ dispatch byEpicId derive from the SAME resolved map", () => {
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [
      makeTask({ task_id: "P", task_number: 1 }),
      makeTask({ task_id: "A", task_number: 2, depends_on: ["P"] }),
      makeTask({ task_id: "B", task_number: 3, depends_on: ["P"] }),
    ],
  });
  // A subdir effective root resolves to /repo, so BOTH the gate keys and the
  // dispatch plan place lanes on /repo (not the raw root).
  const repoMap = classifyWorktreeRepos([epic], (r) =>
    r.startsWith("/repo") ? "/repo" : null,
  );
  const prepared = prepareWorktreeGeometry([epic], repoMap);
  const geom = prepared.byEpicId.get("fn-1-foo");
  expect(geom?.kind).toBe("ok");
  if (geom?.kind !== "ok") throw new Error("expected ok geometry");
  expect(geom.repoDir).toBe("/repo");
  const byNode = new Map(geom.plan.assignments.map((a) => [a.nodeId, a]));
  for (const id of ["P", "A", "B"]) {
    expect(prepared.laneKeyById.get(id)).toBe(byNode.get(id)?.worktreePath);
  }
  // The close row (epic id) keys on the base lane.
  expect(prepared.laneKeyById.get("fn-1-foo")).toBe(geom.plan.baseWorktreePath);
});

// ---------------------------------------------------------------------------
// fn-1013 — the per-repo worktree-eligibility downgrade. A would-be-`ok` epic
// whose RESOLVED toplevel is NOT worktree-friendly (the injected `assessRepo`
// probe returns ineligible) becomes `disabled`: a NORMAL, NON-error sequential-
// on-shared-checkout fallback (one task per toplevel, cap-1) — never a sticky
// reject. The fast tier injects a synthetic `assessRepo`; no real fs/git.
// ---------------------------------------------------------------------------

test("fn-1013 classifyWorktreeRepos: an injected ineligible assessRepo downgrades a would-be-ok epic → disabled (repoDir + reason)", () => {
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1, target_repo: "/repo" }),
    ],
  });
  const res = classifyWorktreeRepos(
    [epic],
    (r) => (r === "/repo" ? "/repo" : null),
    (top) => ({
      eligible: false,
      reason: `worktree-disabled:workspace-marker:turbo (${top})`,
    }),
  ).get("fn-1-foo");
  expect(res?.kind).toBe("disabled");
  expect(res?.kind === "disabled" && res.repoDir).toBe("/repo");
  expect(res?.kind === "disabled" && res.reason).toContain(
    "workspace-marker:turbo",
  );
  // The probe saw the RESOLVED toplevel, not a raw subdir.
  expect(res?.kind === "disabled" && res.reason).toContain("/repo");
});

test("fn-1013 classifyWorktreeRepos: assessRepo only downgrades a would-be-ok epic — a reject (multi-repo / no-primary-repo) is NEVER probed", () => {
  let probed = 0;
  const assess = (top: string) => {
    probed++;
    return {
      eligible: false,
      reason: `worktree-disabled:no-manifest (${top})`,
    };
  };
  // multi-repo: two distinct toplevels — reject returns BEFORE eligibility.
  const multi = makeEpic({
    epic_id: "fn-1-multi",
    project_dir: "/repo-a",
    tasks: [
      makeTask({
        task_id: "fn-1-multi.1",
        task_number: 1,
        target_repo: "/repo-a",
      }),
      makeTask({
        task_id: "fn-1-multi.2",
        task_number: 2,
        target_repo: "/repo-b",
      }),
    ],
  });
  // no-primary-repo: single toplevel but empty project_dir — reject returns first.
  const noPrimary = makeEpic({
    epic_id: "fn-1-noprimary",
    project_dir: "",
    tasks: [
      makeTask({
        task_id: "fn-1-noprimary.1",
        task_number: 1,
        target_repo: "/repo",
      }),
    ],
  });
  const map = classifyWorktreeRepos(
    [multi, noPrimary],
    (r) =>
      r.startsWith("/repo-a")
        ? "/repo-a"
        : r.startsWith("/repo-b")
          ? "/repo-b"
          : r === "/repo"
            ? "/repo"
            : null,
    assess,
  );
  expect(map.get("fn-1-multi")?.kind).toBe("multi-repo");
  expect(map.get("fn-1-noprimary")?.kind).toBe("no-primary-repo");
  // Neither reject consulted the eligibility probe.
  expect(probed).toBe(0);
});

test("fn-1013 classifyWorktreeRepos: default assessRepo (no 3rd arg) keeps a single-toplevel epic ok — existing callers byte-identical", () => {
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1, target_repo: "/repo" }),
    ],
  });
  expect(
    classifyWorktreeRepos([epic], (r) => (r === "/repo" ? "/repo" : null)).get(
      "fn-1-foo",
    ),
  ).toEqual({ kind: "ok", repoDir: "/repo" });
});

test("fn-1013 prepareWorktreeGeometry: a disabled epic → every task id + epic id key the BARE toplevel, byEpicId disabled, NO reject", () => {
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [
      makeTask({ task_id: "P", task_number: 1 }),
      makeTask({ task_id: "A", task_number: 2, depends_on: ["P"] }),
      makeTask({ task_id: "B", task_number: 3, depends_on: ["P"] }),
    ],
  });
  const repoMap = classifyWorktreeRepos(
    [epic],
    (r) => (r.startsWith("/repo") ? "/repo" : null),
    () => ({ eligible: false, reason: "worktree-disabled:submodules" }),
  );
  const prepared = prepareWorktreeGeometry([epic], repoMap);
  const geom = prepared.byEpicId.get("fn-1-foo");
  expect(geom?.kind).toBe("disabled");
  expect(geom?.kind === "disabled" && geom.repoDir).toBe("/repo");
  expect(geom?.kind === "disabled" && geom.reason).toContain("submodules");
  // Every task id AND the epic id (close row) key the BARE toplevel — never a
  // per-lane worktree path. 3 tasks + 1 epic id = 4 keys, all the toplevel.
  for (const id of ["P", "A", "B", "fn-1-foo"]) {
    expect(prepared.laneKeyById.get(id)).toBe("/repo");
  }
  expect(prepared.laneKeyById.size).toBe(4);
});

test("fn-1013 reconcile: worktree ON, a disabled epic → launches dispatch on the SHARED checkout (no worktree, no worktreeReject)", () => {
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1, target_repo: "/repo" }),
    ],
  });
  const snap = worktreeSnap(
    [epic],
    (r) => (r === "/repo" ? "/repo" : null),
    () => ({
      eligible: false,
      reason: "worktree-disabled:no-manifest",
    }),
  );
  const decision = reconcile(snap, makeState(), 0);
  expect(decision.launches.length).toBeGreaterThan(0);
  for (const l of decision.launches) {
    // No lane geometry, no sticky reject — byte-identical to worktree-mode-OFF.
    expect(l.worktree).toBeUndefined();
    expect(l.worktreeReject).toBeUndefined();
    // The launch cwd is the shared checkout (the resolved toplevel), unmodified.
    expect(l.cwd).toBe("/repo");
  }
});

// ---------------------------------------------------------------------------
// fn-1013.3 — GRANDFATHER: an epic with live worktree evidence (base worktree dir
// OR `keeper/epic/<id>` branch) keeps `ok` even when its toplevel assesses
// `disabled` (INCLUDING on a transient probe error) — so its `~/worktrees` lanes
// finalize normally rather than stranding mid-flight. The predicate is a SEPARATE
// per-epic producer input (never inside the toplevel-memoized `assessRepo` nor a
// fold); the fast tier injects a synthetic predicate (no real fs/git).
// ---------------------------------------------------------------------------

test("fn-1013.3 classifyWorktreeRepos: assessRepo=disabled + grandfather TRUE → ok (lanes preserved, finalize intact)", () => {
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1, target_repo: "/repo" }),
    ],
  });
  const seen: Array<[string, string]> = [];
  const res = classifyWorktreeRepos(
    [epic],
    (r) => (r === "/repo" ? "/repo" : null),
    () => ({ eligible: false, reason: "worktree-disabled:workspace-marker" }),
    (epicId, repoDir) => {
      seen.push([epicId, repoDir]);
      return true; // a live lane exists for this epic
    },
  ).get("fn-1-foo");
  expect(res).toEqual({ kind: "ok", repoDir: "/repo" });
  // The predicate is consulted with the EPIC id + the RESOLVED toplevel.
  expect(seen).toEqual([["fn-1-foo", "/repo"]]);
});

test("fn-1013.3 classifyWorktreeRepos: a TRANSIENT probe error on a grandfathered epic → still ok (no split-brain)", () => {
  // A fail-closed probe error is the LIKELIER mid-flight flip — the predicate does
  // not care WHY the toplevel assessed disabled, only that a live lane exists.
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1, target_repo: "/repo" }),
    ],
  });
  const res = classifyWorktreeRepos(
    [epic],
    (r) => (r === "/repo" ? "/repo" : null),
    () => ({ eligible: false, reason: "worktree-disabled:probe-error" }),
    () => true,
  ).get("fn-1-foo");
  expect(res).toEqual({ kind: "ok", repoDir: "/repo" });
});

test("fn-1013.3 classifyWorktreeRepos: assessRepo=disabled + grandfather FALSE → disabled (stays serial)", () => {
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1, target_repo: "/repo" }),
    ],
  });
  const res = classifyWorktreeRepos(
    [epic],
    (r) => (r === "/repo" ? "/repo" : null),
    () => ({ eligible: false, reason: "worktree-disabled:no-manifest" }),
    () => false, // no live lane
  ).get("fn-1-foo");
  expect(res?.kind).toBe("disabled");
  expect(res?.kind === "disabled" && res.repoDir).toBe("/repo");
  expect(res?.kind === "disabled" && res.reason).toContain("no-manifest");
});

test("fn-1013.3 classifyWorktreeRepos: grandfather is consulted ONLY on a would-be-disabled epic — never on an eligible one, never on a reject", () => {
  let consulted = 0;
  const grandfather = (): boolean => {
    consulted++;
    return true;
  };
  // (a) eligible epic — grandfather is irrelevant, never consulted.
  const eligible = makeEpic({
    epic_id: "fn-1-ok",
    project_dir: "/repo",
    tasks: [
      makeTask({ task_id: "fn-1-ok.1", task_number: 1, target_repo: "/repo" }),
    ],
  });
  // (b) multi-repo reject — returns BEFORE the eligibility/grandfather gate.
  const multi = makeEpic({
    epic_id: "fn-1-multi",
    project_dir: "/repo-a",
    tasks: [
      makeTask({
        task_id: "fn-1-multi.1",
        task_number: 1,
        target_repo: "/repo-a",
      }),
      makeTask({
        task_id: "fn-1-multi.2",
        task_number: 2,
        target_repo: "/repo-b",
      }),
    ],
  });
  const map = classifyWorktreeRepos(
    [eligible, multi],
    (r) =>
      r.startsWith("/repo-a")
        ? "/repo-a"
        : r.startsWith("/repo-b")
          ? "/repo-b"
          : r === "/repo"
            ? "/repo"
            : null,
    (top) => ({ eligible: top === "/repo", reason: "x" }),
    grandfather,
  );
  expect(map.get("fn-1-ok")).toEqual({ kind: "ok", repoDir: "/repo" });
  expect(map.get("fn-1-multi")?.kind).toBe("multi-repo");
  expect(consulted).toBe(0);
});

test("fn-1013.3 classifyWorktreeRepos: default grandfather (no 4th arg) leaves a disabled epic disabled — existing callers byte-identical", () => {
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1, target_repo: "/repo" }),
    ],
  });
  const res = classifyWorktreeRepos(
    [epic],
    (r) => (r === "/repo" ? "/repo" : null),
    () => ({ eligible: false, reason: "worktree-disabled:no-manifest" }),
  ).get("fn-1-foo");
  expect(res?.kind).toBe("disabled");
});

test("fn-1013.3 reposForRecovery: a grandfathered (ok) epic IS swept; a disabled sibling contributes NO lane", () => {
  const grand = makeEpic({ epic_id: "fn-1-grand", project_dir: "/repo-grand" });
  const disabled = makeEpic({ epic_id: "fn-2-dis", project_dir: "/repo-dis" });
  const repoMap = classifyWorktreeRepos(
    [grand, disabled],
    (r) => r,
    (top) => ({ eligible: false, reason: `worktree-disabled (${top})` }),
    (epicId) => epicId === "fn-1-grand", // only the grandfathered epic has a lane
  );
  // The grandfathered epic stayed `ok` → swept; the disabled epic provisioned no
  // lane → skipped (nothing to recover).
  expect(repoMap.get("fn-1-grand")?.kind).toBe("ok");
  expect(repoMap.get("fn-2-dis")?.kind).toBe("disabled");
  expect(reposForRecovery([grand, disabled], repoMap)).toEqual(["/repo-grand"]);
});

test("fn-1013.3 reconcile: a grandfathered disabled-toplevel epic dispatches IN A LANE (worktree geometry), not the shared checkout", () => {
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1, target_repo: "/repo" }),
    ],
  });
  const snap = worktreeSnap(
    [epic],
    (r) => (r === "/repo" ? "/repo" : null),
    () => ({ eligible: false, reason: "worktree-disabled:no-manifest" }),
    () => true, // live lane → grandfathered → stays ok
  );
  const decision = reconcile(snap, makeState(), 0);
  expect(decision.launches.length).toBeGreaterThan(0);
  for (const l of decision.launches) {
    // Grandfathered → `ok` geometry → a worktree lane, NOT the bare shared checkout.
    expect(l.worktree).toBeDefined();
    expect(l.worktreeReject).toBeUndefined();
  }
});

// ---------------------------------------------------------------------------
// fn-1034 — MULTI-REPO worktree epics behind the `worktree_multi_repo` rollout
// flag. With the flag ON, an epic whose tasks span >1 git toplevel PARTITIONS
// into per-repo lane groups (each independently worktree/serial) instead of the
// whole-epic `worktree-multi-repo` reject. Flag OFF (the default 5th arg) keeps
// the reject byte-identical. The fast tier injects a synthetic resolver /
// eligibility probe / grandfather predicate — no real git.
// ---------------------------------------------------------------------------

/** A resolver that maps `/repo-a*`→`/repo-a`, `/repo-b*`→`/repo-b`, else null. */
const abResolve = (r: string): string | null =>
  r.startsWith("/repo-a")
    ? "/repo-a"
    : r.startsWith("/repo-b")
      ? "/repo-b"
      : null;

/** A two-repo epic: task .1 → /repo-a, task .2 → /repo-b, primary /repo-a. */
function twoRepoEpic(): Epic {
  return makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo-a",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        target_repo: "/repo-a",
      }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        target_repo: "/repo-b",
      }),
    ],
  });
}

/** A worktree-ON snapshot with the multi-repo rollout flag ON. */
function multiRepoSnap(
  epics: Epic[],
  resolve: (root: string) => string | null,
  assessRepo?: (toplevel: string) => { eligible: boolean; reason: string },
  isGrandfathered?: (epicId: string, repoDir: string) => boolean,
): ReconcileSnapshot {
  return makeSnapshot({
    epics,
    worktreeMode: true,
    worktreeRepoByEpicId: classifyWorktreeRepos(
      epics,
      resolve,
      assessRepo,
      isGrandfathered,
      true,
    ),
  });
}

test("fn-1034 classifyWorktreeRepos: flag OFF keeps the >1 reject; flag ON partitions into ordered per-repo groups", () => {
  const epic = twoRepoEpic();
  // Flag OFF (default 5th arg) — byte-identical multi-repo reject.
  const off = classifyWorktreeRepos([epic], abResolve).get("fn-1-foo");
  expect(off?.kind).toBe("multi-repo");
  // Flag ON — clustered per-repo groups.
  const on = classifyWorktreeRepos(
    [epic],
    abResolve,
    undefined,
    undefined,
    true,
  ).get("fn-1-foo");
  expect(on?.kind).toBe("clustered");
  if (on?.kind !== "clustered") throw new Error("expected clustered");
  expect(on.groups).toEqual([
    { repoDir: "/repo-a", taskIds: ["fn-1-foo.1"], mode: "worktree" },
    { repoDir: "/repo-b", taskIds: ["fn-1-foo.2"], mode: "worktree" },
  ]);
  // The primary group hosts the single plan-close: resolve(project_dir=/repo-a).
  expect(on.primaryRepoDir).toBe("/repo-a");
});

test("fn-1034 classifyWorktreeRepos: a single-repo epic NEVER clusters (stays `ok`, byte-identical) even with the flag ON", () => {
  const epic = makeEpic({
    epic_id: "fn-1-solo",
    project_dir: "/repo-a",
    tasks: [
      makeTask({
        task_id: "fn-1-solo.1",
        task_number: 1,
        target_repo: "/repo-a",
      }),
    ],
  });
  const res = classifyWorktreeRepos(
    [epic],
    abResolve,
    undefined,
    undefined,
    true,
  ).get("fn-1-solo");
  expect(res).toEqual({ kind: "ok", repoDir: "/repo-a" });
});

test("fn-1034 classifyWorktreeRepos: precedence preserved — a null root → whole-epic `unresolved`, empty project_dir → whole-epic `no-primary-repo`, even with the flag ON", () => {
  // (a) A task resolving null → the WHOLE epic is `unresolved`, never a partial cluster.
  const unresolvable = makeEpic({
    epic_id: "fn-1-unres",
    project_dir: "/repo-a",
    tasks: [
      makeTask({
        task_id: "fn-1-unres.1",
        task_number: 1,
        target_repo: "/repo-a",
      }),
      makeTask({
        task_id: "fn-1-unres.2",
        task_number: 2,
        target_repo: "/nope",
      }),
    ],
  });
  // (b) A resolved-clean multi-repo epic with NO primary_repo → whole-epic reject.
  const noPrimary = makeEpic({
    epic_id: "fn-1-nopri",
    project_dir: "",
    tasks: [
      makeTask({
        task_id: "fn-1-nopri.1",
        task_number: 1,
        target_repo: "/repo-a",
      }),
      makeTask({
        task_id: "fn-1-nopri.2",
        task_number: 2,
        target_repo: "/repo-b",
      }),
    ],
  });
  const map = classifyWorktreeRepos(
    [unresolvable, noPrimary],
    abResolve,
    undefined,
    undefined,
    true,
  );
  expect(map.get("fn-1-unres")?.kind).toBe("unresolved");
  expect(map.get("fn-1-nopri")?.kind).toBe("no-primary-repo");
});

test("fn-1034 classifyWorktreeRepos: per-group eligibility → one group `worktree`, an ineligible sibling `serial`", () => {
  const epic = twoRepoEpic();
  const res = classifyWorktreeRepos(
    [epic],
    abResolve,
    (top) => ({
      eligible: top === "/repo-a",
      reason: `worktree-disabled:no-manifest (${top})`,
    }),
    undefined,
    true,
  ).get("fn-1-foo");
  expect(res?.kind).toBe("clustered");
  if (res?.kind !== "clustered") throw new Error("expected clustered");
  expect(res.groups).toEqual([
    { repoDir: "/repo-a", taskIds: ["fn-1-foo.1"], mode: "worktree" },
    { repoDir: "/repo-b", taskIds: ["fn-1-foo.2"], mode: "serial" },
  ]);
});

test("fn-1034 classifyWorktreeRepos: grandfather runs per (epic, repoDir) — only the grandfathered repo's group stays `worktree`", () => {
  const epic = twoRepoEpic();
  const seen: Array<[string, string]> = [];
  const res = classifyWorktreeRepos(
    [epic],
    abResolve,
    () => ({ eligible: false, reason: "worktree-disabled:probe-error" }),
    (epicId, repoDir) => {
      seen.push([epicId, repoDir]);
      return repoDir === "/repo-a"; // only /repo-a has a live lane
    },
    true,
  ).get("fn-1-foo");
  expect(res?.kind).toBe("clustered");
  if (res?.kind !== "clustered") throw new Error("expected clustered");
  // /repo-a grandfathered → worktree; /repo-b not → serial.
  expect(res.groups.map((g) => [g.repoDir, g.mode])).toEqual([
    ["/repo-a", "worktree"],
    ["/repo-b", "serial"],
  ]);
  // The predicate saw the EPIC id + EACH group's resolved toplevel.
  expect(seen).toEqual([
    ["fn-1-foo", "/repo-a"],
    ["fn-1-foo", "/repo-b"],
  ]);
});

test("fn-1034 prepareWorktreeGeometry: clustered epic keys each group's lanes independently; the close row keys the PRIMARY group base", () => {
  const epic = twoRepoEpic();
  const repoMap = classifyWorktreeRepos(
    [epic],
    abResolve,
    undefined,
    undefined,
    true,
  );
  const prepared = prepareWorktreeGeometry([epic], repoMap);
  const geom = prepared.byEpicId.get("fn-1-foo");
  expect(geom?.kind).toBe("clustered");
  const baseA = worktreePathFor("/repo-a", "keeper/epic/fn-1-foo");
  const baseB = worktreePathFor("/repo-b", "keeper/epic/fn-1-foo");
  // Each single-task group inherits its OWN repo's base lane.
  expect(prepared.laneKeyById.get("fn-1-foo.1")).toBe(baseA);
  expect(prepared.laneKeyById.get("fn-1-foo.2")).toBe(baseB);
  // The single close row (epic id) keys ONLY the PRIMARY group's base.
  expect(prepared.laneKeyById.get("fn-1-foo")).toBe(baseA);
});

test("fn-1034 prepareWorktreeGeometry: a mixed worktree+serial epic keys each group WITHOUT a cap-1 collision", () => {
  const epic = twoRepoEpic();
  const repoMap = classifyWorktreeRepos(
    [epic],
    abResolve,
    (top) => ({ eligible: top === "/repo-a", reason: "x" }),
    undefined,
    true,
  );
  const prepared = prepareWorktreeGeometry([epic], repoMap);
  const geom = prepared.byEpicId.get("fn-1-foo");
  expect(geom?.kind).toBe("clustered");
  if (geom?.kind !== "clustered") throw new Error("expected clustered");
  expect(geom.groups.map((g) => [g.repoDir, g.mode])).toEqual([
    ["/repo-a", "worktree"],
    ["/repo-b", "serial"],
  ]);
  const baseA = worktreePathFor("/repo-a", "keeper/epic/fn-1-foo");
  // Worktree group task → its lane path; serial group task → the BARE repoDir;
  // close row → the primary (worktree) base. All three are DISTINCT keys — no
  // collision between the serial bare key, the worktree lane path, and the close.
  expect(prepared.laneKeyById.get("fn-1-foo.1")).toBe(baseA);
  expect(prepared.laneKeyById.get("fn-1-foo.2")).toBe("/repo-b");
  expect(prepared.laneKeyById.get("fn-1-foo")).toBe(baseA);
  expect(baseA).not.toBe("/repo-b");
});

test("fn-1034 reconcile: a clustered epic stamps each task launch with ITS group's geometry (no worktreeReject)", () => {
  const epic = twoRepoEpic();
  const snap = multiRepoSnap([epic], abResolve);
  const decision = reconcile(snap, makeState(), 0);
  const work = decision.launches.filter((l) => l.verb === "work");
  expect(work.length).toBeGreaterThan(0);
  for (const l of work) {
    expect(l.worktreeReject).toBeUndefined();
    expect(l.worktree).toBeDefined();
    // Each task's lane lives in ITS OWN group's repo.
    const expectedRepo = l.id === "fn-1-foo.1" ? "/repo-a" : "/repo-b";
    expect(l.worktree?.repoDir).toBe(expectedRepo);
  }
});

test("fn-1034 reconcile: gate laneKeyById ↔ dispatch worktree paths agree per group for a clustered epic", () => {
  const epic = twoRepoEpic();
  const repoMap = classifyWorktreeRepos(
    [epic],
    abResolve,
    undefined,
    undefined,
    true,
  );
  const prepared = prepareWorktreeGeometry([epic], repoMap);
  const snap = makeSnapshot({
    epics: [epic],
    worktreeMode: true,
    worktreeRepoByEpicId: repoMap,
  });
  const decision = reconcile(snap, makeState(), 0);
  for (const l of decision.launches.filter((x) => x.verb === "work")) {
    // The dispatch-side worktree path equals the gate's lane key for the same id.
    expect(l.worktree?.assignment.worktreePath).toBe(
      prepared.laneKeyById.get(l.id),
    );
  }
});

test("fn-1034 reconcile: a done clustered epic collects ONE finalize per WORKTREE group + a non-primary sink provision request", () => {
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo-a",
    status: "done",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        target_repo: "/repo-a",
        runtime_status: "done",
        worker_phase: "done",
      }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        target_repo: "/repo-b",
        runtime_status: "done",
        worker_phase: "done",
      }),
    ],
  });
  const snap = multiRepoSnap([epic], abResolve);
  const decision = reconcile(snap, makeState(), 0);
  // One finalize per worktree group (the single close gates them ALL).
  expect(decision.worktreeFinalize.map((f) => f.repoDir).sort()).toEqual([
    "/repo-a",
    "/repo-b",
  ]);
  // Only the NON-primary group needs a producer-side fan-in provision (the primary
  // group's base is assembled by its close worker); /repo-a is primary.
  expect(decision.worktreeSinkProvision.map((s) => s.repoDir)).toEqual([
    "/repo-b",
  ]);
});

test("fn-1034 runReconcileCycle: a clustered finalize provisions the non-primary group's sink (fan-in) BEFORE finalizing every group", async () => {
  const { driver, log } = makeFakeWorktreeDriver();
  const { deps } = makeFakeDeps({ worktree: driver });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo-a",
    status: "done",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        target_repo: "/repo-a",
        runtime_status: "done",
        worker_phase: "done",
      }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        target_repo: "/repo-b",
        runtime_status: "done",
        worker_phase: "done",
      }),
    ],
  });
  const snap = multiRepoSnap([epic], abResolve);
  await runReconcileCycle(
    reconcile(snap, makeState(), 0),
    makeState(),
    new Map<string, LiveDispatch>(),
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );
  // The non-primary (/repo-b) sink was provisioned (its rib→base fan-in), since no
  // close worker dispatches into it.
  expect(log.provisions).toHaveLength(1);
  expect(log.provisions[0]?.repoDir).toBe("/repo-b");
  expect(log.provisions[0]?.assignment.nodeId).toBe("__close__");
  // Both groups finalized (the single close gated both merges).
  expect(log.finalizes.map((f) => f.repoDir).sort()).toEqual([
    "/repo-a",
    "/repo-b",
  ]);
  // Provision ran BEFORE the finalizes (the base must be assembled first).
  expect(log.calls[0]).toBe("provision:__close__");
});

test("fn-1034 runReconcileCycle: a non-primary sink fan-in FAILURE mints a sticky close row and SKIPS that group's finalize (never merges an unassembled base)", async () => {
  const { driver, log } = makeFakeWorktreeDriver({
    provisionFail: (info) =>
      info.repoDir === "/repo-b"
        ? "worktree-merge-conflict: merging a rib into keeper/epic/fn-1-foo"
        : null,
  });
  const { deps, log: depsLog } = makeFakeDeps({ worktree: driver });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo-a",
    status: "done",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        target_repo: "/repo-a",
        runtime_status: "done",
        worker_phase: "done",
      }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        target_repo: "/repo-b",
        runtime_status: "done",
        worker_phase: "done",
      }),
    ],
  });
  const snap = multiRepoSnap([epic], abResolve);
  await runReconcileCycle(
    reconcile(snap, makeState(), 0),
    makeState(),
    new Map<string, LiveDispatch>(),
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );
  // The fan-in failure minted a sticky close-row DispatchFailed for /repo-b.
  expect(depsLog.emissions).toHaveLength(1);
  expect(depsLog.emissions[0]).toMatchObject({
    verb: "close",
    id: "fn-1-foo",
    dir: "/repo-b",
  });
  // ONLY the primary group finalized — the /repo-b base was never assembled.
  expect(log.finalizes.map((f) => f.repoDir)).toEqual(["/repo-a"]);
});

test("fn-1123 runReconcileCycle: a non-primary sink fan-in RETRY mints NO sticky close row but still SKIPS that group's finalize", async () => {
  const { driver, log } = makeFakeWorktreeDriver({
    provisionRetry: (info) =>
      info.repoDir === "/repo-b"
        ? "worktree-premerge-dirty-base: base not losslessly cleanable"
        : null,
  });
  const { deps, log: depsLog } = makeFakeDeps({ worktree: driver });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo-a",
    status: "done",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        target_repo: "/repo-a",
        runtime_status: "done",
        worker_phase: "done",
      }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        target_repo: "/repo-b",
        runtime_status: "done",
        worker_phase: "done",
      }),
    ],
  });
  const snap = multiRepoSnap([epic], abResolve);
  await runReconcileCycle(
    reconcile(snap, makeState(), 0),
    makeState(),
    new Map<string, LiveDispatch>(),
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );
  // The transient retry-skip minted NO sticky (unlike the conflict case above).
  expect(depsLog.emissions).toEqual([]);
  // But the /repo-b base is un-assembled, so ONLY the primary group finalizes.
  expect(log.finalizes.map((f) => f.repoDir)).toEqual(["/repo-a"]);
});

test("fn-1137 runReconcileCycle: a non-primary sink fan-in PRE-MERGE failure mints a SELF-CLEARING close row keyed on the sink LANE path (not the repo toplevel), so it clears once the lane resolves", async () => {
  // The sink's own LANE worktree path — the real driver returns it as
  // `provisioned.dir` for a fan-in pre-merge deferral. Deliberately distinct from the
  // /repo-b toplevel so a repo-keyed row (the pre-fix bug) is observably different.
  const sinkLane = "/repo-b/.worktrees/keeper-epic-fn-1-foo";
  const { driver } = makeFakeWorktreeDriver({
    provisionPremerge: (info) =>
      info.repoDir === "/repo-b"
        ? {
            reason: `worktree-lane-premerge-not-ready: base ${sinkLane} is behind before merging a rib into keeper/epic/fn-1-foo — deferring the fan-in`,
            dir: sinkLane,
          }
        : null,
  });
  const { deps, log: depsLog } = makeFakeDeps({ worktree: driver });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo-a",
    status: "done",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        target_repo: "/repo-a",
        runtime_status: "done",
        worker_phase: "done",
      }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        target_repo: "/repo-b",
        runtime_status: "done",
        worker_phase: "done",
      }),
    ],
  });
  const snap = multiRepoSnap([epic], abResolve);
  await runReconcileCycle(
    reconcile(snap, makeState(), 0),
    makeState(),
    new Map<string, LiveDispatch>(),
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );
  // MINT: the close-sink pre-merge row keys on the sink LANE path (the fix), NOT the
  // /repo-b toplevel — the exact key `laneFailuresToClear` matches on. A row keyed on
  // the repo toplevel (the bug) is never in the resolved-lane set, so it never clears.
  expect(depsLog.emissions).toHaveLength(1);
  const minted = depsLog.emissions[0];
  expect(minted).toMatchObject({
    verb: "close",
    id: "fn-1-foo",
    dir: sinkLane,
  });
  // Its reason qualifies it for the reason-scoped lane-failure collection.
  expect(isWorktreeLanePremergeReason(minted?.reason ?? "")).toBe(true);
  // SELF-CLEAR: fed the ACTUAL minted row, the reason-scoped level-clear drops it the
  // cycle the recover pass reports the lane resolved (ready/gone) — no operator
  // retry_dispatch. The clear keys on the SAME lane path the emit minted.
  expect(
    laneFailuresToClear(
      depsLog.emissions.map((e) => ({
        verb: e.verb,
        id: e.id,
        dir: e.dir ?? "",
      })),
      new Set(),
      new Set([sinkLane]),
    ),
  ).toEqual([{ verb: "close", id: "fn-1-foo" }]);
});

// ---------------------------------------------------------------------------
// fn-1034.2 — per-repo finalize failure rows + producer level-clear
// ---------------------------------------------------------------------------

/** A DONE clustered two-repo epic (task .1 → /repo-a primary, task .2 → /repo-b). */
function doneClusteredEpic(): Epic {
  return makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo-a",
    status: "done",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        target_repo: "/repo-a",
        runtime_status: "done",
        worker_phase: "done",
      }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        target_repo: "/repo-b",
        runtime_status: "done",
        worker_phase: "done",
      }),
    ],
  });
}

/** A worktree-ON snapshot for a clustered epic with a pre-seeded open finalize set. */
function clusteredSnapWithOpenFinalize(
  epic: Epic,
  finalizeFailureIds: Set<string>,
): ReconcileSnapshot {
  return makeSnapshot({
    epics: [epic],
    worktreeMode: true,
    worktreeRepoByEpicId: classifyWorktreeRepos(
      [epic],
      abResolve,
      undefined,
      undefined,
      true,
    ),
    finalizeFailureIds,
  });
}

test("fn-1034 runReconcileCycle: two-repo finalize — one clean, one non-ff → DISTINCT per-repo rows, the clean repo mints nothing, the failed key is retry_dispatch-able", async () => {
  const { driver } = makeFakeWorktreeDriver({
    finalizeFail: (info) =>
      info.repoDir === "/repo-b"
        ? "worktree-finalize-non-fast-forward: origin/main is ahead of main"
        : null,
  });
  const { deps, log: depsLog } = makeFakeDeps({ worktree: driver });
  const snap = multiRepoSnap([doneClusteredEpic()], abResolve);
  await runReconcileCycle(
    reconcile(snap, makeState(), 0),
    makeState(),
    new Map<string, LiveDispatch>(),
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );
  const bKey = worktreeFinalizeDispatchId("fn-1-foo", "/repo-b");
  const aKey = worktreeFinalizeDispatchId("fn-1-foo", "/repo-a");
  // The two repos' keys are DISTINCT — no collision on the single `close::<epic>`.
  expect(bKey).not.toBe(aKey);
  expect(bKey.startsWith(WORKTREE_FINALIZE_ID_PREFIX)).toBe(true);
  // Only /repo-b's finalize failed → exactly one sticky row on ITS per-repo key; the
  // clean /repo-a mints nothing.
  expect(depsLog.emissions).toHaveLength(1);
  expect(depsLog.emissions[0]).toMatchObject({
    verb: "close",
    id: bKey,
    dir: "/repo-b",
  });
  // The failed repo's row is retry_dispatch-able: `close::<key>` passes the wire
  // validator (verb close, single `::`, safe token) exactly like a recover key.
  expect(parseDispatchKey(`close::${bKey}`)).toEqual({
    ok: true,
    verb: "close",
    id: bKey,
  });
});

test("fn-1034 runReconcileCycle: a repo whose OPEN finalize row finalizes CLEAN this cycle → producer level-clear (no retry_dispatch needed); a clean sibling with no row is not spuriously cleared", async () => {
  const bKey = worktreeFinalizeDispatchId("fn-1-foo", "/repo-b");
  const { driver } = makeFakeWorktreeDriver(); // both groups finalize clean
  const { deps, log: depsLog } = makeFakeDeps({ worktree: driver });
  const snap = clusteredSnapWithOpenFinalize(
    doneClusteredEpic(),
    new Set([bKey]),
  );
  await runReconcileCycle(
    reconcile(snap, makeState(), 0),
    makeState(),
    new Map<string, LiveDispatch>(),
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );
  // /repo-b finalized clean → its OPEN row auto-clears. /repo-a also finalized clean
  // but never had a row (not in the open set), so it is NOT spuriously cleared.
  expect(depsLog.clears).toEqual([{ verb: "close", id: bKey }]);
  expect(depsLog.emissions).toEqual([]);
});

test("fn-1034 runReconcileCycle: a repo whose finalize STILL fails is NOT level-cleared (fail-loud preserved) and re-mints its per-repo row", async () => {
  const bKey = worktreeFinalizeDispatchId("fn-1-foo", "/repo-b");
  const { driver } = makeFakeWorktreeDriver({
    finalizeFail: (info) =>
      info.repoDir === "/repo-b"
        ? "worktree-finalize-non-fast-forward: origin/main is ahead of main"
        : null,
  });
  const { deps, log: depsLog } = makeFakeDeps({ worktree: driver });
  const snap = clusteredSnapWithOpenFinalize(
    doneClusteredEpic(),
    new Set([bKey]),
  );
  await runReconcileCycle(
    reconcile(snap, makeState(), 0),
    makeState(),
    new Map<string, LiveDispatch>(),
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );
  // /repo-b still non-ff → row re-minted, NEVER cleared.
  expect(depsLog.clears).toEqual([]);
  expect(depsLog.emissions).toHaveLength(1);
  expect(depsLog.emissions[0]).toMatchObject({ verb: "close", id: bKey });
});

test("fn-1034 runReconcileCycle: a TRANSIENT finalize skip neither mints nor level-clears the repo's pre-existing block (could not re-observe it)", async () => {
  const bKey = worktreeFinalizeDispatchId("fn-1-foo", "/repo-b");
  const { driver } = makeFakeWorktreeDriver({
    finalizeRetry: (info) =>
      info.repoDir === "/repo-b"
        ? "worktree-finalize-dirty-checkout: /repo-b has a dirty working tree"
        : null,
  });
  const { deps, log: depsLog } = makeFakeDeps({ worktree: driver });
  const snap = clusteredSnapWithOpenFinalize(
    doneClusteredEpic(),
    new Set([bKey]),
  );
  await runReconcileCycle(
    reconcile(snap, makeState(), 0),
    makeState(),
    new Map<string, LiveDispatch>(),
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );
  // A transient skip mints no sticky row (never an un-clearable close) AND must not
  // dismiss the pre-existing operator block it could not re-observe this cycle.
  expect(depsLog.emissions).toEqual([]);
  expect(depsLog.clears).toEqual([]);
});

test("fn-1034 loadReconcileSnapshot: recover rows and per-repo finalize rows load into DISJOINT auto-clear sets — a recover row for repo A cannot dismiss a finalize block on repo B", async () => {
  await withSeededDb(async (db) => {
    const insert = (id: string, reason: string, dir: string): void => {
      db.run(
        `INSERT INTO dispatch_failures
           (verb, id, reason, dir, ts, last_event_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["close", id, reason, dir, 1, 1, 1, 1],
      );
    };
    // Repo A: a recover-originated close failure (eligible for the RECOVER clear).
    insert("fn-1-foo", "worktree-recover-conflict: merging …", "/repo-a");
    // Repo B: a per-repo FINALIZE block (eligible for the FINALIZE clear only).
    const bKey = worktreeFinalizeDispatchId("fn-1-foo", "/repo-b");
    insert(bKey, "worktree-finalize-non-fast-forward: origin ahead", "/repo-b");

    const snap = await loadReconcileSnapshot(db);
    // The two auto-clear scopes are DISJOINT: the recover clear only sees the recover
    // key, the finalize clear only sees the finalize key. Neither can dismiss the
    // other's row.
    expect([...snap.recoverFailureIds]).toEqual(["fn-1-foo"]);
    expect([...snap.finalizeFailureIds]).toEqual([bKey]);
    expect(snap.recoverFailureIds.has(bKey)).toBe(false);
    expect(snap.finalizeFailureIds.has("fn-1-foo")).toBe(false);
    // Both rows still gate dispatch via failedKeys (scoping is orthogonal).
    expect(snap.failedKeys.has("close::fn-1-foo")).toBe(true);
    expect(snap.failedKeys.has(`close::${bKey}`)).toBe(true);
  });
});

test("fn-1034 reposForRecovery: a clustered epic contributes EACH worktree group's repo; a serial group contributes none", () => {
  const epic = twoRepoEpic();
  const repoMap = classifyWorktreeRepos(
    [epic],
    abResolve,
    (top) => ({ eligible: top === "/repo-a", reason: "x" }),
    undefined,
    true,
  );
  // /repo-a is a worktree group (swept); /repo-b is serial (no lane → skipped).
  expect(reposForRecovery([epic], repoMap)).toEqual(["/repo-a"]);
});

test("fn-978 cyclic-DAG asymmetry: the gate skips (no key, no throw); reconcile (dispatch) re-throws", () => {
  // A ready root R plus a separate {C1↔C2} cycle: the toposort fails for the whole
  // epic, so the gate leaves it un-keyed (no throw) while the dispatch geometry pass
  // re-throws — and reconcile only re-throws BECAUSE the ready root produced a launch.
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [
      makeTask({ task_id: "fn-1-foo.R", task_number: 1, depends_on: [] }),
      makeTask({
        task_id: "fn-1-foo.C1",
        task_number: 2,
        depends_on: ["fn-1-foo.C2"],
      }),
      makeTask({
        task_id: "fn-1-foo.C2",
        task_number: 3,
        depends_on: ["fn-1-foo.C1"],
      }),
    ],
  });
  const repoMap = classifyWorktreeRepos([epic], (r) => r);
  const prepared = prepareWorktreeGeometry([epic], repoMap);
  // Gate: no lane key, no throw, recorded as a cycle.
  expect(prepared.laneKeyById.size).toBe(0);
  expect(prepared.byEpicId.get("fn-1-foo")?.kind).toBe("cycle");
  // Dispatch: reconcile re-throws the cycle to driveCycle's backstop.
  const snap = worktreeSnap([epic], (r) => r);
  expect(() => reconcile(snap, makeState(), 0)).toThrow(/cycle/);
});

test("fn-959 runReconcileCycle: worktree ON → provision runs BEFORE Dispatched, launch cwd is the worktree path", async () => {
  const { driver, log } = makeFakeWorktreeDriver();
  const {
    deps,
    log: depsLog,
    setJobByKey,
  } = makeFakeDeps({ worktree: driver });
  setJobByKey("work", "fn-1-foo.1", { job_id: "j-1", last_event_id: 200 });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/home/me/repo",
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = makeSnapshot({ epics: [epic], worktreeMode: true });
  const state = makeState();
  const decision = reconcile(snap, makeState(), 0);
  const wtPath = worktreePathFor("/home/me/repo", "keeper/epic/fn-1-foo");
  expect(decision.launches[0]?.worktree?.assignment.worktreePath).toBe(wtPath);

  await runReconcileCycle(
    decision,
    state,
    new Map<string, LiveDispatch>(),
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );

  // The driver provisioned the lane (BEFORE the emitDispatched mint), and the
  // launch fired into the worktree path — not the project_dir.
  expect(log.calls).toEqual(["provision:fn-1-foo.1"]);
  expect(depsLog.dispatchedEmissions).toHaveLength(1);
  expect(depsLog.launches[0]?.cwd).toBe(wtPath);
  // The (drift-guarded) shell command rebuilt with the worktree cwd.
  expect(depsLog.launches[0]?.argv.join(" ")).toContain(`cd ${wtPath} `);
  expect(depsLog.emissions).toEqual([]); // no DispatchFailed
});

test("fn-976 runReconcileCycle: a worktree-mode launch carries the realpath-normalized lane on the LaunchSpec (KEEPER_PLAN_WORKTREE)", async () => {
  const { driver } = makeFakeWorktreeDriver();
  const {
    deps,
    log: depsLog,
    setJobByKey,
  } = makeFakeDeps({
    worktree: driver,
    // Model the macOS /var → /private/var normalization the producer applies so
    // the lane env equals the worker's eventual process.cwd().
    realpath: (p) => p.replace(`${homedir()}/`, "/private/normalized/"),
  });
  setJobByKey("work", "fn-1-foo.1", { job_id: "j-1", last_event_id: 200 });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/home/me/repo",
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = makeSnapshot({ epics: [epic], worktreeMode: true });

  await runReconcileCycle(
    reconcile(snap, makeState(), 0),
    makeState(),
    new Map<string, LiveDispatch>(),
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );

  // The spec carries the REALPATH-NORMALIZED lane (not the raw worktree path).
  expect(depsLog.launches).toHaveLength(1);
  expect(depsLog.launches[0]?.spec?.worktreePath).toBe(
    worktreePathFor("/home/me/repo", "keeper/epic/fn-1-foo").replace(
      `${homedir()}/`,
      "/private/normalized/",
    ),
  );
  // ...AND the durable lane BRANCH — the PURE per-node assignment branch (NOT
  // derived from the realpath'd path), the value the hook captures as the
  // durable `jobs.worktree` marker.
  expect(depsLog.launches[0]?.spec?.worktreeBranch).toBe(
    "keeper/epic/fn-1-foo",
  );
});

test("fn-976 runReconcileCycle: a worktree-OFF launch carries NO lane on the LaunchSpec (byte-identical spec)", async () => {
  const { driver } = makeFakeWorktreeDriver(); // assertion passes, no geometry
  const {
    deps,
    log: depsLog,
    setJobByKey,
  } = makeFakeDeps({ worktree: driver });
  setJobByKey("work", "fn-1-foo.1", { job_id: "j-1", last_event_id: 200 });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = makeSnapshot({ epics: [epic], worktreeMode: false });

  await runReconcileCycle(
    reconcile(snap, makeState(), 0),
    makeState(),
    new Map<string, LiveDispatch>(),
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );

  expect(depsLog.launches).toHaveLength(1);
  expect(depsLog.launches[0]?.spec?.worktreePath).toBeUndefined();
  // A worktree-OFF launch carries NO branch either — the spec stays byte-identical.
  expect(depsLog.launches[0]?.spec?.worktreeBranch).toBeUndefined();
});

test("fn-959 runReconcileCycle: worktree ON provision failure → sticky DispatchFailed, no launch", async () => {
  const { driver, log } = makeFakeWorktreeDriver({
    provisionFail: () =>
      "worktree-head-mismatch: HEAD is feature, expected keeper/epic/fn-1-foo",
  });
  const { deps, log: depsLog } = makeFakeDeps({ worktree: driver });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = makeSnapshot({ epics: [epic], worktreeMode: true });
  const state = makeState();

  await runReconcileCycle(
    reconcile(snap, makeState(), 0),
    state,
    new Map<string, LiveDispatch>(),
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );

  expect(log.calls).toEqual(["provision:fn-1-foo.1"]);
  expect(depsLog.launches).toEqual([]); // never launched
  expect(depsLog.dispatchedEmissions).toEqual([]); // no Dispatched mint
  expect(depsLog.emissions).toHaveLength(1);
  expect(depsLog.emissions[0]).toMatchObject({
    verb: "work",
    id: "fn-1-foo.1",
    reason:
      "worktree-head-mismatch: HEAD is feature, expected keeper/epic/fn-1-foo",
  });
  // Slot was never held (failed before inFlight.add).
  expect(state.inFlight.has("work::fn-1-foo.1")).toBe(false);
});

test("fn-1123 runReconcileCycle: a provision RETRY (transient dirty base) mints NO sticky and consumes no slot / cooldown", async () => {
  const { driver, log } = makeFakeWorktreeDriver({
    provisionRetry: () =>
      "worktree-premerge-dirty-base: deferring the fan-in merge — base not losslessly cleanable",
  });
  const { deps, log: depsLog } = makeFakeDeps({ worktree: driver });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = makeSnapshot({ epics: [epic], worktreeMode: true });
  const state = makeState();

  await runReconcileCycle(
    reconcile(snap, makeState(), 0),
    state,
    new Map<string, LiveDispatch>(),
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );

  expect(log.calls).toEqual(["provision:fn-1-foo.1"]);
  expect(depsLog.launches).toEqual([]); // never launched
  expect(depsLog.emissions).toEqual([]); // NO sticky — the retry-skip is invisible
  // No slot, cooldown, or pending consumed → re-dispatchable next cycle.
  expect(state.inFlight.has("work::fn-1-foo.1")).toBe(false);
  expect(state.redispatchCooldown.has("work::fn-1-foo.1")).toBe(false);
});

test("fn-1123 runReconcileCycle: the live-attributed dirty set threads to provision (present map → set, omitted → null do-not-discard)", async () => {
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = makeSnapshot({ epics: [epic], worktreeMode: true });

  // Omitted param → the driver receives `null` (do-not-discard).
  {
    const { driver, log } = makeFakeWorktreeDriver();
    const { deps } = makeFakeDeps({ worktree: driver });
    await runReconcileCycle(
      reconcile(snap, makeState(), 0),
      makeState(),
      new Map<string, LiveDispatch>(),
      "/bin/zsh",
      new AbortController().signal,
      deps,
    );
    expect(log.provisionAttributions).toEqual([null]);
  }

  // A present (even empty) map → the driver receives a non-null set (nothing
  // attributed to this lane, so a provably-redundant leak is cleanable).
  {
    const { driver, log } = makeFakeWorktreeDriver();
    const { deps } = makeFakeDeps({ worktree: driver });
    await runReconcileCycle(
      reconcile(snap, makeState(), 0),
      makeState(),
      new Map<string, LiveDispatch>(),
      "/bin/zsh",
      new AbortController().signal,
      deps,
      new Map<string, ReadonlySet<string>>(),
    );
    expect(log.provisionAttributions).toHaveLength(1);
    expect(log.provisionAttributions[0]).not.toBeNull();
    expect([...(log.provisionAttributions[0] ?? [])]).toEqual([]);
  }
});

test("fn-959 runReconcileCycle: worktree OFF → on-default-branch assertion runs; a mismatch is sticky DispatchFailed", async () => {
  const { driver, log } = makeFakeWorktreeDriver({
    assertFail: (cwd) =>
      `not-on-default-branch: ${cwd} HEAD is feature, expected main`,
  });
  const { deps, log: depsLog } = makeFakeDeps({ worktree: driver });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = makeSnapshot({ epics: [epic], worktreeMode: false });
  const state = makeState();

  await runReconcileCycle(
    reconcile(snap, makeState(), 0),
    state,
    new Map<string, LiveDispatch>(),
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );

  // OFF mode asserts on default branch (never provisions a worktree).
  expect(log.calls).toEqual(["assert:/repo"]);
  expect(depsLog.launches).toEqual([]);
  expect(depsLog.emissions).toHaveLength(1);
  expect(depsLog.emissions[0]).toMatchObject({
    verb: "work",
    id: "fn-1-foo.1",
    reason: "not-on-default-branch: /repo HEAD is feature, expected main",
    dir: "/repo",
  });
});

test("fn-959 runReconcileCycle: worktree OFF on-default-branch holds → launches normally into project_dir", async () => {
  const { driver, log } = makeFakeWorktreeDriver(); // assertion passes
  const {
    deps,
    log: depsLog,
    setJobByKey,
  } = makeFakeDeps({ worktree: driver });
  setJobByKey("work", "fn-1-foo.1", { job_id: "j-1", last_event_id: 200 });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-1-foo.1" })],
  });
  const snap = makeSnapshot({ epics: [epic], worktreeMode: false });

  await runReconcileCycle(
    reconcile(snap, makeState(), 0),
    makeState(),
    new Map<string, LiveDispatch>(),
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );

  expect(log.calls).toEqual(["assert:/repo"]);
  expect(depsLog.launches).toHaveLength(1);
  expect(depsLog.launches[0]?.cwd).toBe("/repo"); // unchanged
  expect(depsLog.emissions).toEqual([]);
});

test("fn-959 runReconcileCycle: worktree ON multi-repo reject → sticky DispatchFailed, no git, no launch", async () => {
  const { driver, log } = makeFakeWorktreeDriver();
  const { deps, log: depsLog } = makeFakeDeps({ worktree: driver });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo-a",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        target_repo: "/repo-a",
      }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        target_repo: "/repo-b",
      }),
    ],
  });
  const snap = makeSnapshot({ epics: [epic], worktreeMode: true });

  await runReconcileCycle(
    reconcile(snap, makeState(), 0),
    makeState(),
    new Map<string, LiveDispatch>(),
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );

  // No git driver method ran for a rejected epic; every launch became a sticky
  // worktree-multi-repo DispatchFailed.
  expect(log.calls).toEqual([]);
  expect(depsLog.launches).toEqual([]);
  expect(depsLog.emissions.length).toBeGreaterThan(0);
  for (const e of depsLog.emissions) {
    expect(e.reason).toContain("worktree-multi-repo");
  }
});

test("fn-959 runReconcileCycle: closer-done epic → finalizeEpic runs AFTER the launch loop, merges base into default", async () => {
  // An epic whose close-row verdict is `completed` this cycle: no launch fires
  // (the closer already ran), but the producer's finalize pass merges its base.
  const { driver, log } = makeFakeWorktreeDriver();
  const { deps } = makeFakeDeps({ worktree: driver });
  // A done epic produces a `completed` close-row verdict and no launches.
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    status: "done",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        runtime_status: "done",
        worker_phase: "done",
      }),
    ],
  });
  const snap = makeSnapshot({ epics: [epic], worktreeMode: true });
  const decision = reconcile(snap, makeState(), 0);
  expect(decision.worktreeFinalize.length).toBe(1);
  expect(decision.worktreeFinalize[0]?.baseBranch).toBe("keeper/epic/fn-1-foo");

  await runReconcileCycle(
    decision,
    makeState(),
    new Map<string, LiveDispatch>(),
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );

  // finalize ran for the base lane.
  expect(log.calls).toContain("finalize:keeper/epic/fn-1-foo");
  expect(log.finalizes).toHaveLength(1);
});

test("fn-959 runReconcileCycle: finalizeEpic conflict → sticky DispatchFailed on the per-repo finalize key, stops (no teardown observable to caller)", async () => {
  const { driver } = makeFakeWorktreeDriver({
    finalizeFail: () =>
      "worktree-finalize-conflict: merging keeper/epic/fn-1-foo into main — CONFLICT",
  });
  const { deps, log: depsLog } = makeFakeDeps({ worktree: driver });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    status: "done",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        runtime_status: "done",
        worker_phase: "done",
      }),
    ],
  });
  const snap = makeSnapshot({ epics: [epic], worktreeMode: true });

  await runReconcileCycle(
    reconcile(snap, makeState(), 0),
    makeState(),
    new Map<string, LiveDispatch>(),
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );

  expect(depsLog.emissions).toHaveLength(1);
  expect(depsLog.emissions[0]).toMatchObject({
    verb: "close",
    // The per-repo finalize key (epic id + repo-dir hash), NOT the bare `close::<epic>`.
    id: worktreeFinalizeDispatchId("fn-1-foo", "/repo"),
    reason:
      "worktree-finalize-conflict: merging keeper/epic/fn-1-foo into main — CONFLICT",
  });
});

test("fn-985 runReconcileCycle: a finalize RETRY result (dirty/off-branch/non-ff main checkout) mints NO sticky DispatchFailed", async () => {
  // The transient skip path: finalizeEpic returns `retry:true`, so the producer
  // STOPS the epic's finalize cleanly but never mints a sticky close-row failure —
  // never an un-clearable close; the next cycle retries once the tree settles.
  const { driver } = makeFakeWorktreeDriver({
    finalizeRetry: () =>
      "worktree-finalize-dirty-checkout: /repo has a dirty working tree",
  });
  const { deps, log: depsLog } = makeFakeDeps({ worktree: driver });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    status: "done",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        runtime_status: "done",
        worker_phase: "done",
      }),
    ],
  });
  const snap = makeSnapshot({ epics: [epic], worktreeMode: true });

  await runReconcileCycle(
    reconcile(snap, makeState(), 0),
    makeState(),
    new Map<string, LiveDispatch>(),
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );

  // No DispatchFailed emission — the retry skip is invisible to the close row.
  expect(depsLog.emissions).toHaveLength(0);
});

test("worktree finalize is gated on not-paused — a paused board collects no finalize", () => {
  // Same done epic that finalizes when playing, but PAUSED: the base merge + push
  // is producer git work that must not run while paused (matching recover()).
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    status: "done",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        runtime_status: "done",
        worker_phase: "done",
      }),
    ],
  });
  const snap = makeSnapshot({ epics: [epic], worktreeMode: true });
  expect(
    reconcile(snap, makeState({ paused: true }), 0).worktreeFinalize,
  ).toEqual([]);
  // Control: unpaused, the SAME board collects the finalize request.
  expect(reconcile(snap, makeState(), 0).worktreeFinalize.length).toBe(1);
});

// ---------------------------------------------------------------------------
// fn-972 BUG 3 — finalize triggers off the closer-FINISHED signal (the
// producer-observable, projection-decoupled chicken-and-egg fix) + the git
// confirm that the lane base carries the epic-done state before merging.
// ---------------------------------------------------------------------------

/** A close-sink {@link WorktreeLaunchInfo} for finalize tests (laneOrder empty:
 *  teardown is the base lane only). */
function makeFinalizeInfo(epicId = "fn-1-foo"): WorktreeLaunchInfo {
  const branch = `keeper/epic/${epicId}`;
  const baseWorktreePath = `/repo.worktrees/keeper-epic-${epicId}`;
  return {
    assignment: {
      nodeId: "__close__",
      isCloseSink: true,
      branch,
      worktreePath: baseWorktreePath,
      inherited: true,
      preMerges: [],
      assertBranch: branch,
    },
    baseBranch: branch,
    baseWorktreePath,
    repoDir: "/repo",
    laneOrder: [],
    parentBranch: branch,
  };
}

test("fn-972 BUG 3 closerJobFinished: finished close job (dead pane) → true; running / live-stopped / wrong-verb / absent → false", () => {
  const epicId = "fn-1-foo";
  const close = (extra: Partial<Job>): Map<string, Job> =>
    new Map([
      [
        "j-c",
        makeJob({
          job_id: "j-c",
          plan_verb: "close",
          plan_ref: epicId,
          ...extra,
        }),
      ],
    ]);
  // A finished closer: a `close::<epic>` job, stopped, no live pane.
  expect(
    closerJobFinished(close({ state: "stopped" }), epicId, new Set()),
  ).toBe(true);
  // Still working → occupies → not finished.
  expect(
    closerJobFinished(close({ state: "working" }), epicId, new Set()),
  ).toBe(false);
  // Stopped but its pane is LIVE (parked-alive) → still occupies → not finished.
  expect(
    closerJobFinished(
      close({ state: "stopped", backend_exec_pane_id: "%7" }),
      epicId,
      new Set(["%7"]),
    ),
  ).toBe(false);
  // A `work` job sharing the epic id is NOT a closer.
  const workJob = new Map<string, Job>([
    [
      "j-w",
      makeJob({
        job_id: "j-w",
        plan_verb: "work",
        plan_ref: epicId,
        state: "stopped",
      }),
    ],
  ]);
  expect(closerJobFinished(workJob, epicId, new Set())).toBe(false);
  // No close job at all → false.
  expect(closerJobFinished(new Map(), epicId, new Set())).toBe(false);
});

test("fn-972 BUG 3 reconcile: a finished closer JOB collects the finalize WITHOUT the main projection seeing done", () => {
  // The closer committed `status:done` on the LANE, so the main-worktree `epics`
  // projection still reads the epic as open — yet the closer JOB finished. The
  // producer-observable signal must collect the finalize anyway (the chicken-and-
  // egg fix); finalizeEpic confirms the lane carries done via git before merging.
  const epicId = "fn-1-foo";
  const epic = makeEpic({
    epic_id: epicId,
    project_dir: "/repo",
    status: "open", // NOT done in the main projection
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        runtime_status: "done",
        worker_phase: "done",
      }),
    ],
  });
  const closeJob = makeJob({
    job_id: "j-close",
    plan_verb: "close",
    plan_ref: epicId,
    state: "stopped",
  });
  const snap = makeSnapshot({
    epics: [epic],
    worktreeMode: true,
    jobs: new Map([[closeJob.job_id, closeJob]]),
    // Probe available, no live panes → the stopped closer reads as finished.
    livePaneIds: new Set(),
  });
  // The finalizer guard (stamped when the closer was dispatched) suppresses a
  // close RE-dispatch this cycle, so the only producer action is the finalize.
  const state = makeState({ finalizerGuard: new Map([[epicId, 0]]) });
  const decision = reconcile(snap, state, 0);
  expect(epic.status).not.toBe("done");
  expect(decision.launches.some((l) => l.verb === "close")).toBe(false);
  expect(decision.worktreeFinalize.length).toBe(1);
  expect(decision.worktreeFinalize[0]?.baseBranch).toBe("keeper/epic/fn-1-foo");

  // Control: WITHOUT the finished close job, an open epic collects NO finalize —
  // proving the trigger is the closer-finished signal, not merely worktree mode.
  const noJob = makeSnapshot({ epics: [epic], worktreeMode: true });
  expect(reconcile(noJob, makeState(), 0).worktreeFinalize).toEqual([]);
});

test("fn-1227.1 reconcile: a DONE epic whose close job still OCCUPIES defers finalize; a crashed/finished/absent closer collects it (ADR 0031)", () => {
  // The incident ordering, reproduced end-to-end through the reconcile seam: the
  // epic folds `done` (its close row reads `completed`, so the projection-done
  // finalize arm fires) WHILE the closer session is still mid-turn inside the lane.
  // Collecting finalize would merge + tear the lane out from under the live closer,
  // deleting its cwd → posix_spawn ENOENT → a `working` zombie ghost-holding the
  // slot. The close-occupancy gate must DEFER finalize until the closer exits — the
  // SAME shared `isOccupyingJob` seam the closer-finished arm already encodes.
  const epicId = "fn-1-foo";
  const doneEpic = (): Epic =>
    makeEpic({
      epic_id: epicId,
      project_dir: "/repo",
      status: "done", // folded done → completedRowIds contains the epic
      tasks: [
        makeTask({
          task_id: "fn-1-foo.1",
          runtime_status: "done",
          worker_phase: "done",
        }),
      ],
    });
  const closeJob = (state: "working" | "stopped", paneId?: string): Job =>
    makeJob({
      job_id: "j-close",
      plan_verb: "close",
      plan_ref: epicId,
      state,
      backend_exec_pane_id: paneId ?? null,
    });
  const finalizeBranches = (snap: ReconcileSnapshot): string[] =>
    reconcile(snap, makeState(), 0).worktreeFinalize.map((f) => f.baseBranch);
  const withJob = (
    job: Job | null,
    livePaneIds: ReadonlySet<string> | null,
  ): ReconcileSnapshot =>
    makeSnapshot({
      epics: [doneEpic()],
      worktreeMode: true,
      jobs: job === null ? new Map() : new Map([[job.job_id, job]]),
      livePaneIds,
    });

  // 1. `working` close job ALWAYS occupies → finalize DEFERRED (not collected).
  //    This is the incident: before the gate, `completedRowIds` collected it anyway.
  expect(finalizeBranches(withJob(closeJob("working"), new Set()))).toEqual([]);
  // 2. `stopped` closer whose pane is LIVE (parked-alive, mid-turn) → DEFERRED.
  expect(
    finalizeBranches(withJob(closeJob("stopped", "%42"), new Set(["%42"]))),
  ).toEqual([]);
  // 3. DEGRADED pane probe (`livePaneIds === null`, tmux unavailable) → every
  //    stopped row occupies → DEFERRED (fail-closed under an un-probeable cycle).
  expect(finalizeBranches(withJob(closeJob("stopped", "%42"), null))).toEqual(
    [],
  );
  // 4. CRASHED / finished closer — `stopped`, its pane GONE (probe available) →
  //    does NOT occupy → finalize COLLECTED. Projection-done crash robustness kept.
  expect(
    finalizeBranches(withJob(closeJob("stopped", "%42"), new Set())),
  ).toEqual(["keeper/epic/fn-1-foo"]);
  // 5. A done epic with NO close job (never-forked / done-before-worktree) never
  //    occupies → finalizes exactly as before the gate.
  expect(finalizeBranches(withJob(null, new Set()))).toEqual([
    "keeper/epic/fn-1-foo",
  ]);
});

test("fn-990 finalizeEpic: a crashed closer (NOT done in the main projection) → no-op, never merges (incomplete lane is not pushed to default)", async () => {
  const cmds: string[] = [];
  const fakeRun: Parameters<typeof createWorktreeDriver>[0] = async (args) => {
    const joined = args.join(" ");
    cmds.push(joined);
    if (isInProgressPseudoRefProbe(args)) {
      return { code: 1, stdout: "", stderr: "" }; // clean: in-progress pseudo-ref absent
    }
    if (args[0] === "rev-parse" && args.includes("--verify")) {
      return { code: 0, stdout: "abc\n", stderr: "" }; // base branch EXISTS
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  // The closer JOB finished (the trigger fired) but the epic is NOT done in the
  // main projection — a crashed closer that committed code-but-not-`done`.
  const res = await createWorktreeDriver(fakeRun).finalizeEpic(
    makeFinalizeInfo(),
    async () => false,
  );
  expect(res).toEqual({ ok: true });
  // The projection-done gate rejected it — no default resolve, no merge, no teardown.
  expect(cmds.some((c) => c.startsWith("symbolic-ref"))).toBe(false);
  expect(cmds.some((c) => c.startsWith("merge"))).toBe(false);
  expect(cmds.some((c) => c.startsWith("worktree remove"))).toBe(false);
});

test("fn-990 finalizeEpic: done in the projection but the lane is NOT ahead of default → proceeds to teardown, never merges/pushes", async () => {
  // The lane base is already an ancestor of default (already merged, or no real
  // lane commits) — the shared routine's `not-ahead` skip. Finalize merges
  // nothing and pushes nothing, but still tears the lane down (the idempotent
  // resume). No commit-work flock is taken (no `merge --no-edit`).
  const cmds: string[] = [];
  const fakeRun: Parameters<typeof createWorktreeDriver>[0] = async (args) => {
    const joined = args.join(" ");
    cmds.push(joined);
    if (isInProgressPseudoRefProbe(args)) {
      return { code: 1, stdout: "", stderr: "" }; // clean: in-progress pseudo-ref absent
    }
    if (args[0] === "rev-parse" && args.includes("--verify")) {
      return { code: 0, stdout: "abc\n", stderr: "" }; // base branch exists
    }
    if (joined.startsWith("symbolic-ref")) {
      return { code: 0, stdout: "origin/main\n", stderr: "" };
    }
    if (joined === "rev-parse --abbrev-ref HEAD") {
      return { code: 0, stdout: "main\n", stderr: "" };
    }
    if (joined.startsWith("merge-base --is-ancestor")) {
      return { code: 0, stdout: "", stderr: "" }; // base already an ancestor → not-ahead
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const res = await createWorktreeDriver(fakeRun).finalizeEpic(
    makeFinalizeInfo(),
    async () => true,
  );
  expect(res).toEqual({ ok: true });
  // not-ahead short-circuited the merge sequence — no merge, no push.
  expect(cmds.some((c) => c.startsWith("merge --no-edit"))).toBe(false);
  expect(cmds.some((c) => c === "push")).toBe(false);
});

test("fn-992 finalizeEpic: a stranded base (absent from origin) while HEAD is OFF-default → worktree-finalize-off-branch retry-skip (NOT a recover reason), NO push, NO teardown", async () => {
  // The not-ahead re-push seam reached with the shared checkout off the default
  // branch: pushDefaultToOrigin's HEAD-safety arm degrades, finalize maps it to a
  // FINALIZE-side reason (OUTSIDE the recover auto-clear prefix) and tears nothing
  // down behind a wrong-ref push.
  const cmds: string[] = [];
  const fakeRun: Parameters<typeof createWorktreeDriver>[0] = async (args) => {
    const joined = args.join(" ");
    cmds.push(joined);
    if (isInProgressPseudoRefProbe(args)) {
      return { code: 1, stdout: "", stderr: "" }; // clean: in-progress pseudo-ref absent
    }
    if (args[0] === "rev-parse" && args.includes("--verify")) {
      return { code: 0, stdout: "abc\n", stderr: "" }; // base branch exists
    }
    if (joined.startsWith("symbolic-ref")) {
      return { code: 0, stdout: "origin/main\n", stderr: "" };
    }
    if (joined === "merge-base --is-ancestor keeper/epic/fn-1-foo main") {
      return { code: 0, stdout: "", stderr: "" }; // ancestor of LOCAL default
    }
    if (
      joined ===
      "merge-base --is-ancestor keeper/epic/fn-1-foo refs/remotes/origin/main"
    ) {
      return { code: 1, stdout: "", stderr: "" }; // origin LACKS the merge → re-push seam
    }
    if (joined === "rev-parse --abbrev-ref HEAD") {
      return { code: 0, stdout: "feature\n", stderr: "" }; // HEAD OFF the default branch
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const res = await createWorktreeDriver(fakeRun).finalizeEpic(
    makeFinalizeInfo(),
    async () => true,
  );
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.reason).toMatch(/^worktree-finalize-off-branch:/);
    // A FINALIZE reason must stay OUTSIDE the recover auto-clear prefix, or the
    // level-triggered clear would silently dismiss a legitimate finalize block.
    expect(isWorktreeRecoverReason(res.reason)).toBe(false);
  }
  // No wrong-ref push, no teardown — the merge was never stranded behind it.
  expect(cmds.some((c) => c === "push")).toBe(false);
  expect(cmds.some((c) => c.startsWith("push origin"))).toBe(false);
  expect(cmds.some((c) => c.startsWith("worktree remove"))).toBe(false);
  expect(cmds.some((c) => c.startsWith("branch -D"))).toBe(false);
});

// --- fn-1140 shared fake-git for the working-tree-free plumbing base merge.
// Models the `merge-tree --write-tree` → `commit-tree` → `update-ref` CAS → push
// pipeline with per-scenario knobs; the default path is a clean DIVERGENT merge
// that lands and pushes. Distinct OIDs for the two tips + tree + merge commit make
// the CAS + determinism observable, and every call's env is captured so a test can
// assert the pinned commit-tree identity/date.
const MG_DEFAULT_TIP = "1111111111111111111111111111111111111111";
const MG_BASE_TIP = "2222222222222222222222222222222222222222";
const MG_TREE_OID = "3333333333333333333333333333333333333333";
const MG_MERGE_COMMIT = "4444444444444444444444444444444444444444";
const MG_MERGE_HEAD = "5555555555555555555555555555555555555555";
const MG_BASE_TIP_DATE = "2026-01-02T03:04:05+00:00";

interface MergeGitOpts {
  base?: string;
  defaultBranch?: string;
  baseAncestorOfDefault?: boolean; // ahead-check hit → the not-ahead path
  defaultAncestorOfBase?: boolean; // pure fast-forward (no commit-tree)
  originContainsBase?: boolean; // post-push origin-containment recheck (default true)
  originContainsBaseBeforePush?: boolean; // not-ahead pre-push origin check (default false)
  originUnresolved?: boolean; // origin/<default> ref unresolved → FF precheck "unknown"
  remoteAhead?: boolean; // origin ahead of local default → non-ff
  noRemote?: boolean;
  noPushTarget?: boolean;
  dryRunReject?: boolean;
  gitVersion?: string; // `git version` stdout (set old to model unsupported)
  mergeTreeExit?: number; // override merge-tree exit (1 conflict, > 1 hard error)
  mergeTreeTimeout?: boolean;
  commitTreeExit?: number;
  commitTreeTimeout?: boolean;
  updateRefExit?: number; // non-zero → cas-stale
  updateRefTimeout?: boolean;
  head?: string; // rev-parse --abbrev-ref HEAD (default = defaultBranch)
  mergeHead?: boolean; // MERGE_HEAD present → catch-up ineligible (mid-merge)
  readTreeAbort?: boolean; // read-tree -m -u aborts (a colliding edit) → resync skipped
  pushExit?: number;
  pushTimeout?: boolean;
  pushStdout?: string;
  // finalize teardown support (inert for the direct merge tests)
  worktreeList?: string; // `worktree list --porcelain` stdout
  epicLaneBranches?: string; // `for-each-ref refs/heads/keeper/epic` stdout
  pruneNotAncestor?: boolean; // keep finalize's prune gate FALSE even post-merge
  // fn-1204 merge-suite gate: `git diff --name-only <defaultTip> <merged> -- plugins/plan`
  // stdout — non-empty drives the gate's runsPlanSuite=true. Default "" (root only).
  planDiff?: string;
}

function makeMergeGit(opts: MergeGitOpts = {}): {
  run: Parameters<typeof mergeLaneBaseIntoDefault>[3];
  cmds: string[];
  calls: { args: string; env?: Record<string, string> }[];
} {
  const def = opts.defaultBranch ?? "main";
  const base = opts.base ?? "keeper/epic/fn-1-foo";
  const cmds: string[] = [];
  const calls: { args: string; env?: Record<string, string> }[] = [];
  let pushed = false;
  let refAdvanced = false;
  const run: Parameters<typeof mergeLaneBaseIntoDefault>[3] = async (
    args,
    o,
  ) => {
    const joined = args.join(" ");
    cmds.push(joined);
    calls.push({ args: joined, env: o?.env });
    if (joined === `merge-base --is-ancestor ${base} ${def}`) {
      // ahead-check (pre-merge) is the base an ancestor of LOCAL default? After the
      // ref advance the SAME probe backs finalize's prune gate — the merged base is
      // now an ancestor (deletable) unless a test pins it not-ancestor.
      const ancestor =
        opts.baseAncestorOfDefault || (refAdvanced && !opts.pruneNotAncestor);
      return { code: ancestor ? 0 : 1, stdout: "", stderr: "" };
    }
    if (
      joined === `merge-base --is-ancestor ${base} refs/remotes/origin/${def}`
    ) {
      // origin-containment (not-ahead pre-push + the post-push recheck).
      const contains = pushed
        ? (opts.originContainsBase ?? true)
        : (opts.originContainsBaseBeforePush ?? false);
      return { code: contains ? 0 : 1, stdout: "", stderr: "" };
    }
    if (
      joined === `merge-base --is-ancestor refs/remotes/origin/${def} ${def}`
    ) {
      // non-ff precheck: origin/<default> ancestor of local default unless remoteAhead.
      return { code: opts.remoteAhead ? 1 : 0, stdout: "", stderr: "" };
    }
    if (joined === `merge-base --is-ancestor ${def} ${base}`) {
      // FF-case check: is default an ancestor of base? → pure fast-forward.
      return {
        code: opts.defaultAncestorOfBase ? 0 : 1,
        stdout: "",
        stderr: "",
      };
    }
    if (joined === "remote get-url origin") {
      return opts.noRemote
        ? { code: 1, stdout: "", stderr: "no origin" }
        : { code: 0, stdout: "git@host:repo.git\n", stderr: "" };
    }
    if (
      joined.startsWith("rev-parse --abbrev-ref --symbolic-full-name @{push}")
    ) {
      return opts.noPushTarget
        ? { code: 1, stdout: "", stderr: "no push target" }
        : { code: 0, stdout: `origin/${def}\n`, stderr: "" };
    }
    if (joined.startsWith("push --dry-run")) {
      return opts.dryRunReject
        ? { code: 1, stdout: "", stderr: "dry-run rejected" }
        : { code: 0, stdout: "", stderr: "" };
    }
    if (joined === `rev-parse --verify --quiet refs/remotes/origin/${def}`) {
      return opts.originUnresolved
        ? { code: 1, stdout: "", stderr: "" }
        : { code: 0, stdout: "deadbeef\n", stderr: "" };
    }
    if (
      joined ===
      `rev-parse --verify --quiet --end-of-options refs/heads/${def}^{commit}`
    ) {
      return { code: 0, stdout: `${MG_DEFAULT_TIP}\n`, stderr: "" };
    }
    if (
      joined ===
      `rev-parse --verify --quiet --end-of-options refs/heads/${base}^{commit}`
    ) {
      return { code: 0, stdout: `${MG_BASE_TIP}\n`, stderr: "" };
    }
    if (
      joined.startsWith("rev-parse --path-format=absolute --git-common-dir")
    ) {
      return { code: 0, stdout: `${o?.cwd ?? ""}/.git\n`, stderr: "" };
    }
    if (joined === "version") {
      return {
        code: 0,
        stdout: `${opts.gitVersion ?? "git version 2.50.1 (Apple Git-155)"}\n`,
        stderr: "",
      };
    }
    if (args[0] === "merge-tree") {
      if (opts.mergeTreeTimeout) {
        return { code: GIT_SPAWN_TIMEOUT_CODE, stdout: "", stderr: "" };
      }
      const exit = opts.mergeTreeExit ?? 0;
      if (exit === 1) {
        return {
          code: 1,
          stdout: `${MG_TREE_OID}\nCONFLICT (content): foo.ts\n`,
          stderr: "",
        };
      }
      if (exit !== 0) {
        return { code: exit, stdout: "", stderr: "fatal: merge-tree boom" };
      }
      return { code: 0, stdout: `${MG_TREE_OID}\n`, stderr: "" };
    }
    if (args[0] === "show") {
      return { code: 0, stdout: `${MG_BASE_TIP_DATE}\n`, stderr: "" };
    }
    if (args[0] === "commit-tree") {
      if (opts.commitTreeTimeout) {
        return { code: GIT_SPAWN_TIMEOUT_CODE, stdout: "", stderr: "" };
      }
      const exit = opts.commitTreeExit ?? 0;
      if (exit !== 0) {
        return { code: exit, stdout: "", stderr: "fatal: commit-tree boom" };
      }
      return { code: 0, stdout: `${MG_MERGE_COMMIT}\n`, stderr: "" };
    }
    if (joined === "rev-parse --verify --quiet MERGE_HEAD") {
      // The catch-up gate: a present MERGE_HEAD makes the checkout mid-merge → ineligible.
      return opts.mergeHead
        ? { code: 0, stdout: `${MG_MERGE_HEAD}\n`, stderr: "" }
        : { code: 1, stdout: "", stderr: "" };
    }
    if (joined.startsWith("status --porcelain")) {
      // Inert for the catch-up gate (no longer clean-gated); kept for finalize teardown.
      return { code: 0, stdout: "", stderr: "" };
    }
    if (joined === "rev-parse --abbrev-ref HEAD") {
      return { code: 0, stdout: `${opts.head ?? def}\n`, stderr: "" };
    }
    if (args[0] === "update-ref") {
      if (opts.updateRefTimeout) {
        return { code: GIT_SPAWN_TIMEOUT_CODE, stdout: "", stderr: "" };
      }
      const exit = opts.updateRefExit ?? 0;
      if (exit !== 0) {
        return {
          code: exit,
          stdout: "",
          stderr: "cannot lock ref: is at X but expected Y",
        };
      }
      refAdvanced = true; // local default now contains the base
      return { code: 0, stdout: "", stderr: "" };
    }
    if (joined === "update-index -q --really-refresh") {
      // The stat-cache settle immediately before read-tree — always exits 0 in the fake.
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "read-tree") {
      // Two-tree catch-up merge; a colliding local edit aborts all-or-nothing (case 16/17/21).
      return opts.readTreeAbort
        ? {
            code: 128,
            stdout: "",
            stderr: "error: Entry 'foo.ts' not uptodate. Cannot merge.",
          }
        : { code: 0, stdout: "", stderr: "" };
    }
    if (joined === `push origin ${def}`) {
      pushed = true;
      if (opts.pushTimeout) {
        return { code: GIT_SPAWN_TIMEOUT_CODE, stdout: "", stderr: "" };
      }
      const exit = opts.pushExit ?? 0;
      if (exit !== 0) {
        return { code: exit, stdout: "", stderr: "remote rejected" };
      }
      return { code: 0, stdout: opts.pushStdout ?? "", stderr: "" };
    }
    // --- finalize teardown support (inert for the direct merge tests) ---
    if (joined.startsWith("symbolic-ref")) {
      return { code: 0, stdout: `origin/${def}\n`, stderr: "" };
    }
    if (args[0] === "diff") {
      // fn-1204 merge-suite gate's plan-touch probe (`diff --name-only … -- plugins/plan`).
      return { code: 0, stdout: opts.planDiff ?? "", stderr: "" };
    }
    if (joined.startsWith("for-each-ref") && joined.includes("keeper/epic")) {
      return { code: 0, stdout: opts.epicLaneBranches ?? "", stderr: "" };
    }
    if (joined.startsWith("worktree list")) {
      return { code: 0, stdout: opts.worktreeList ?? "", stderr: "" };
    }
    if (
      joined.startsWith("worktree remove") ||
      joined.startsWith("worktree prune") ||
      joined.startsWith("branch -D")
    ) {
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, cmds, calls };
}

test("fn-1140 mergeLaneBaseIntoDefault: a lock-timeout acquirer (null) → lock-timeout AFTER the merge is computed, NO ref advance, NO push", async () => {
  // The bounded flock acquirer times out (a null-returning acquirer). The plumbing
  // merge commit is computed first (idempotent, no side effects), then the lock is
  // taken for the ref advance — a null lock degrades to `lock-timeout` with NO
  // update-ref and NO push, never a freeze, never a raw recover reason.
  const { run, cmds } = makeMergeGit();
  const res = await mergeLaneBaseIntoDefault(
    "/repo",
    "keeper/epic/fn-1-foo",
    "main",
    run,
    () => null,
  );
  expect(res).toEqual({ kind: "lock-timeout" });
  expect(isWorktreeRecoverReason((res as { kind: string }).kind)).toBe(false);
  expect(cmds.some((c) => c.startsWith("commit-tree"))).toBe(true);
  expect(cmds.some((c) => c.startsWith("update-ref"))).toBe(false);
  expect(cmds.some((c) => c === "push origin main")).toBe(false);
  // NEVER a working-tree `git merge` in the shared checkout.
  expect(cmds.some((c) => c.startsWith("merge --no-edit"))).toBe(false);
});

test("fn-1140 mergeLaneBaseIntoDefault: a plumbing `merge-tree` TIMEOUT (124) → { kind: 'local-timeout' }, NOT conflict, NO push", async () => {
  // A blocking git hook makes the local merge-tree spawn exceed its timeout → the
  // GNU-timeout sentinel. It must degrade to a TRANSIENT local-timeout, NEVER be
  // mistaken for a content conflict (which would be a sticky operator block).
  const { run, cmds } = makeMergeGit({ mergeTreeTimeout: true });
  const res = await mergeLaneBaseIntoDefault(
    "/repo",
    "keeper/epic/fn-1-foo",
    "main",
    run,
    () => ({ release() {} }),
  );
  expect(res).toEqual({ kind: "local-timeout" });
  expect(res.kind).not.toBe("conflict");
  // A timed-out merge computation never advances the ref or pushes.
  expect(cmds.some((c) => c.startsWith("update-ref"))).toBe(false);
  expect(cmds.some((c) => c === "push origin main")).toBe(false);
});

test("fn-1140 finalizeEpic: a plumbing merge-tree timeout → worktree-finalize-local-timeout retry-skip (NOT a recover reason), NO ref advance, NO teardown", async () => {
  // The finalize caller maps the shared core's local-timeout to a FINALIZE-side
  // reason (OUTSIDE the recover auto-clear prefix) with `retry: true` — a clean
  // skip-and-retry, never a teardown behind an un-landed merge. merge-tree runs
  // BEFORE the ref-advance lock, so the timeout never even reaches update-ref.
  const cmds: string[] = [];
  const fakeRun: Parameters<typeof createWorktreeDriver>[0] = async (args) => {
    const joined = args.join(" ");
    cmds.push(joined);
    if (joined.startsWith("symbolic-ref")) {
      return { code: 0, stdout: "origin/main\n", stderr: "" };
    }
    if (joined === "merge-base --is-ancestor keeper/epic/fn-1-foo main") {
      return { code: 1, stdout: "", stderr: "" }; // base AHEAD → merge it
    }
    if (joined === "merge-base --is-ancestor refs/remotes/origin/main main") {
      return { code: 0, stdout: "", stderr: "" }; // non-ff precheck: ff-able
    }
    if (joined === "merge-base --is-ancestor main keeper/epic/fn-1-foo") {
      return { code: 1, stdout: "", stderr: "" }; // divergent → real merge
    }
    if (joined === "remote get-url origin") {
      return { code: 0, stdout: "git@host:repo.git\n", stderr: "" };
    }
    if (
      joined.startsWith("rev-parse --abbrev-ref --symbolic-full-name @{push}")
    ) {
      return { code: 0, stdout: "origin/main\n", stderr: "" };
    }
    if (joined.startsWith("push --dry-run")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "rev-parse" && args.includes("--verify")) {
      // Valid hex OID (origin ref existence + the plumbing tip resolution).
      return {
        code: 0,
        stdout: "0123456789abcdef0123456789abcdef01234567\n",
        stderr: "",
      };
    }
    if (joined === "version") {
      return { code: 0, stdout: "git version 2.50.1\n", stderr: "" };
    }
    if (args[0] === "merge-tree") {
      return { code: GIT_SPAWN_TIMEOUT_CODE, stdout: "", stderr: "" }; // blocking hook
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const res = await createWorktreeDriver(fakeRun, () => ({
    release() {},
  })).finalizeEpic(makeFinalizeInfo(), async () => true);
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.reason).toMatch(/^worktree-finalize-local-timeout:/);
    expect(res.retry).toBe(true);
    // A finalize reason must NEVER satisfy the recover auto-clear prefix.
    expect(isWorktreeRecoverReason(res.reason)).toBe(false);
  }
  // No ref advance, no push, no teardown behind the un-landed merge — and NEVER a
  // working-tree `git merge` in the shared checkout.
  expect(cmds.some((c) => c.startsWith("update-ref"))).toBe(false);
  expect(cmds.some((c) => c.startsWith("push origin"))).toBe(false);
  expect(cmds.some((c) => c.startsWith("worktree remove"))).toBe(false);
  expect(cmds.some((c) => c.startsWith("branch -D"))).toBe(false);
  expect(cmds.some((c) => c.startsWith("merge --no-edit"))).toBe(false);
});

test("fn-1140 mergeLaneBaseIntoDefault: a DIVERGENT lane merges via merge-tree/commit-tree/update-ref-CAS + pushes → merged, NO working-tree git merge", async () => {
  // A lane base that is NOT an ancestor of default and NOT a fast-forward → a real
  // 3-way merge: merge-tree → commit-tree → update-ref CAS → push, all working-tree-
  // free (never `git merge` in the shared checkout).
  const { run, cmds } = makeMergeGit();
  const res = await mergeLaneBaseIntoDefault(
    "/repo",
    "keeper/epic/fn-1-foo",
    "main",
    run,
    () => ({ release() {} }),
  );
  expect(res).toEqual({ kind: "merged" });
  // The full plumbing pipeline ran, in order, with the ref advanced via a CAS whose
  // `<old>` is the pre-merge default tip and `<new>` is the commit-tree merge commit.
  expect(cmds.some((c) => c.startsWith("merge-tree --write-tree"))).toBe(true);
  expect(
    cmds.some((c) =>
      c.startsWith(
        `commit-tree ${MG_TREE_OID} -p ${MG_DEFAULT_TIP} -p ${MG_BASE_TIP} -m `,
      ),
    ),
  ).toBe(true);
  expect(
    cmds.some(
      (c) =>
        c ===
        `update-ref --end-of-options refs/heads/main ${MG_MERGE_COMMIT} ${MG_DEFAULT_TIP}`,
    ),
  ).toBe(true);
  // The push is branch-explicit (`push origin <default>`), NOT a bare `push`.
  expect(cmds.some((c) => c === "push origin main")).toBe(true);
  expect(cmds.some((c) => c === "push")).toBe(false);
  // NEVER a working-tree `git merge` in the shared checkout — the whole thesis.
  expect(cmds.some((c) => c.startsWith("merge --no-edit"))).toBe(false);
  expect(cmds.some((c) => c.startsWith("merge "))).toBe(false);
});

test("fn-1140 mergeLaneBaseIntoDefault: a PURE fast-forward advances default straight to the base tip via CAS — NO commit-tree, no 2-parent merge", async () => {
  // default IS an ancestor of base → a fast-forward. The ref advances straight to
  // the base tip via update-ref CAS; feeding an FF tree to commit-tree would mint a
  // bogus 2-parent merge, so commit-tree (and merge-tree) MUST NOT run.
  const { run, cmds } = makeMergeGit({ defaultAncestorOfBase: true });
  const res = await mergeLaneBaseIntoDefault(
    "/repo",
    "keeper/epic/fn-1-foo",
    "main",
    run,
    () => ({ release() {} }),
  );
  expect(res).toEqual({ kind: "merged" });
  expect(cmds.some((c) => c.startsWith("merge-tree"))).toBe(false);
  expect(cmds.some((c) => c.startsWith("commit-tree"))).toBe(false);
  // update-ref advances straight to the BASE tip (not a new merge commit).
  expect(
    cmds.some(
      (c) =>
        c ===
        `update-ref --end-of-options refs/heads/main ${MG_BASE_TIP} ${MG_DEFAULT_TIP}`,
    ),
  ).toBe(true);
  expect(cmds.some((c) => c === "push origin main")).toBe(true);
});

test("fn-1140 mergeLaneBaseIntoDefault: the merge LANDS while a colliding local edit ABORTS the catch-up — the regression this decouples — pushes, checkout left trailing", async () => {
  // The incident: a dirty shared checkout silently retry-skipped the base merge,
  // stranding a done epic unmerged. The plumbing merge never touches the working tree,
  // so it lands + pushes regardless; a path both upstream-changed AND locally-edited
  // aborts the stale-aware catch-up all-or-nothing, leaving the checkout trailing.
  const { run, cmds } = makeMergeGit({ readTreeAbort: true });
  const res = await mergeLaneBaseIntoDefault(
    "/repo",
    "keeper/epic/fn-1-foo",
    "main",
    run,
    () => ({ release() {} }),
  );
  expect(res).toEqual({ kind: "merged" });
  expect(cmds.some((c) => c.startsWith("update-ref"))).toBe(true);
  expect(cmds.some((c) => c === "push origin main")).toBe(true);
  // The catch-up IS attempted (refresh + read-tree) and aborts all-or-nothing on the
  // colliding edit — never a `reset --hard` / working-tree `git merge` that would
  // clobber the human's WIP.
  expect(cmds.some((c) => c === "update-index -q --really-refresh")).toBe(true);
  expect(
    cmds.some(
      (c) => c === `read-tree -m -u ${MG_DEFAULT_TIP} ${MG_MERGE_COMMIT}`,
    ),
  ).toBe(true);
  expect(cmds.some((c) => c.startsWith("reset --hard"))).toBe(false);
  expect(cmds.some((c) => c.startsWith("merge --no-edit"))).toBe(false);
});

test("fn-1140 mergeLaneBaseIntoDefault: the merge advances LOCAL default while the shared checkout is OFF-default — the ref lands, the push defers off-branch, no working-tree merge", async () => {
  // On a non-default branch the plumbing still advances refs/heads/<default> locally
  // (the decoupling), but pushDefaultToOrigin's HEAD-safety refuses to push off the
  // default branch (a no-refspec push would target the wrong upstream), so the push
  // defers until the human returns to default. The merge is NOT stranded — the ref
  // advanced, and next cycle's not-ahead re-push seam lands it once back on default.
  const { run, cmds } = makeMergeGit({ head: "feature" });
  const res = await mergeLaneBaseIntoDefault(
    "/repo",
    "keeper/epic/fn-1-foo",
    "main",
    run,
    () => ({ release() {} }),
  );
  expect(res).toEqual({ kind: "off-branch", head: "feature" });
  // The LOCAL ref DID advance (the merge landed) even though HEAD is off-default.
  expect(cmds.some((c) => c.startsWith("update-ref"))).toBe(true);
  // No wrong-ref push, no catch-up onto a checkout that isn't on default, no `git merge`.
  expect(cmds.some((c) => c === "push origin main")).toBe(false);
  expect(cmds.some((c) => c.startsWith("read-tree"))).toBe(false);
  expect(cmds.some((c) => c === "update-index -q --really-refresh")).toBe(
    false,
  );
  expect(cmds.some((c) => c.startsWith("reset --hard"))).toBe(false);
  expect(cmds.some((c) => c.startsWith("merge --no-edit"))).toBe(false);
});

test("fn-1140 mergeLaneBaseIntoDefault: an on-default shared checkout is caught up onto the merged commit via refresh + two-tree read-tree (decision B)", async () => {
  // On default with no MERGE_HEAD → the stale-aware catch-up settles the stat cache
  // (`update-index --really-refresh`) then advances the tree with an explicit two-tree
  // `read-tree -m -u <preMergeTip> <newTip>` (under the lock, after the ref advance) —
  // never a `reset --hard` that would clobber a concurrent local edit.
  const { run, cmds } = makeMergeGit();
  const res = await mergeLaneBaseIntoDefault(
    "/repo",
    "keeper/epic/fn-1-foo",
    "main",
    run,
    () => ({ release() {} }),
  );
  expect(res).toEqual({ kind: "merged" });
  const readTreeArgv = `read-tree -m -u ${MG_DEFAULT_TIP} ${MG_MERGE_COMMIT}`;
  expect(cmds).toContain("update-index -q --really-refresh");
  expect(cmds).toContain(readTreeArgv);
  // The refresh runs IMMEDIATELY before read-tree — the racy-clean window is closed.
  const refreshIdx = cmds.indexOf("update-index -q --really-refresh");
  expect(cmds.indexOf(readTreeArgv)).toBe(refreshIdx + 1);
  expect(cmds.some((c) => c.startsWith("reset --hard"))).toBe(false);
});

test("fn-1169 mergeLaneBaseIntoDefault: an on-default checkout whose catch-up APPLIES does NOT fire the desync seed", async () => {
  // The happy path: on default, no MERGE_HEAD, read-tree succeeds → the checkout carries
  // the merged tip, so there is no desync to seed. The `merged` result shape is UNCHANGED.
  const { run } = makeMergeGit();
  let seeded = 0;
  const res = await mergeLaneBaseIntoDefault(
    "/repo",
    "keeper/epic/fn-1-foo",
    "main",
    run,
    () => ({ release() {} }),
    () => {
      seeded++;
    },
  );
  expect(res).toEqual({ kind: "merged" });
  expect(seeded).toBe(0);
});

test("fn-1169 mergeLaneBaseIntoDefault: a colliding local edit that ABORTS the catch-up fires the desync seed (still merged)", async () => {
  // The incident shape: the ref advances but a path both upstream-changed and locally-
  // edited aborts the catch-up all-or-nothing, so the tree trails the merged tip → the
  // seed fires, while the merge still returns merged (best-effort, swallowed-on-error).
  const { run, cmds } = makeMergeGit({ readTreeAbort: true });
  let seeded = 0;
  const res = await mergeLaneBaseIntoDefault(
    "/repo",
    "keeper/epic/fn-1-foo",
    "main",
    run,
    () => ({ release() {} }),
    () => {
      seeded++;
    },
  );
  expect(res).toEqual({ kind: "merged" });
  // The ref advanced and the catch-up was ATTEMPTED (refresh + read-tree) but aborted —
  // no reset --hard ever runs (WIP never clobbered) → exactly one seed.
  expect(cmds.some((c) => c.startsWith("update-ref"))).toBe(true);
  expect(cmds.some((c) => c === "update-index -q --really-refresh")).toBe(true);
  expect(cmds.some((c) => c.startsWith("read-tree"))).toBe(true);
  expect(cmds.some((c) => c.startsWith("reset --hard"))).toBe(false);
  expect(seeded).toBe(1);
});

test("fn-1169 mergeLaneBaseIntoDefault: a mid-merge checkout (MERGE_HEAD present) SKIPS the catch-up and fires the desync seed (still merged)", async () => {
  // On default but mid-merge → the catch-up is ineligible (never read-tree over a
  // half-merged tree), so the ref advances, the checkout trails, and the seed fires.
  const { run, cmds } = makeMergeGit({ mergeHead: true });
  let seeded = 0;
  const res = await mergeLaneBaseIntoDefault(
    "/repo",
    "keeper/epic/fn-1-foo",
    "main",
    run,
    () => ({ release() {} }),
    () => {
      seeded++;
    },
  );
  expect(res).toEqual({ kind: "merged" });
  expect(cmds.some((c) => c.startsWith("update-ref"))).toBe(true);
  // The catch-up never touched the tree while mid-merge.
  expect(cmds.some((c) => c.startsWith("read-tree"))).toBe(false);
  expect(cmds.some((c) => c === "update-index -q --really-refresh")).toBe(
    false,
  );
  expect(seeded).toBe(1);
});

test("fn-1169 mergeLaneBaseIntoDefault: an off-default checkout fires the desync seed (ref advanced, resync skipped) even as the push defers off-branch", async () => {
  // The ref advances locally but the resync is skipped (HEAD is off default), so the
  // checkout trails → the seed fires BEFORE the push defers off-branch (the seed is about
  // the local ref advance, independent of the push verdict).
  const { run } = makeMergeGit({ head: "feature" });
  let seeded = 0;
  const res = await mergeLaneBaseIntoDefault(
    "/repo",
    "keeper/epic/fn-1-foo",
    "main",
    run,
    () => ({ release() {} }),
    () => {
      seeded++;
    },
  );
  expect(res).toEqual({ kind: "off-branch", head: "feature" });
  expect(seeded).toBe(1);
});

test("fn-1169 mergeLaneBaseIntoDefault: a CAS-stale ref (no advance) does NOT fire the desync seed", async () => {
  // The compare-and-swap failed, so the ref never advanced and the checkout is not
  // desynced — the seed must stay silent on every not-advanced early return.
  const { run } = makeMergeGit({ updateRefExit: 1 });
  let seeded = 0;
  const res = await mergeLaneBaseIntoDefault(
    "/repo",
    "keeper/epic/fn-1-foo",
    "main",
    run,
    () => ({ release() {} }),
    () => {
      seeded++;
    },
  );
  expect(res).toEqual({ kind: "cas-stale" });
  expect(seeded).toBe(0);
});

test("fn-1140 mergeLaneBaseIntoDefault: a CONCURRENT default advance (update-ref CAS mismatch) → { kind: 'cas-stale' }, a transient retry-skip, never a strand", async () => {
  // The compare-and-swap `<old>` is stale — an agent commit advanced default out
  // from under the merge. A DISTINCT transient retry-skip (modeled like lock-timeout),
  // never a sticky conflict, never a teardown on an unmerged base.
  const { run, cmds } = makeMergeGit({ updateRefExit: 1 });
  const res = await mergeLaneBaseIntoDefault(
    "/repo",
    "keeper/epic/fn-1-foo",
    "main",
    run,
    () => ({ release() {} }),
  );
  expect(res).toEqual({ kind: "cas-stale" });
  expect(isWorktreeRecoverReason((res as { kind: string }).kind)).toBe(false);
  // The CAS failed, so nothing was pushed and the catch-up never ran.
  expect(cmds.some((c) => c === "push origin main")).toBe(false);
  expect(cmds.some((c) => c.startsWith("read-tree"))).toBe(false);
  expect(cmds.some((c) => c === "update-index -q --really-refresh")).toBe(
    false,
  );
});

test("fn-1140 mergeLaneBaseIntoDefault: git < 2.38 (no `merge-tree --write-tree`) → { kind: 'merge-tree-unsupported' }, a transient skip, never a merge/push", async () => {
  const { run, cmds } = makeMergeGit({ gitVersion: "git version 2.30.2" });
  const res = await mergeLaneBaseIntoDefault(
    "/repo",
    "keeper/epic/fn-1-foo",
    "main",
    run,
    () => ({ release() {} }),
  );
  expect(res).toEqual({ kind: "merge-tree-unsupported" });
  expect(cmds.some((c) => c.startsWith("merge-tree"))).toBe(false);
  expect(cmds.some((c) => c.startsWith("update-ref"))).toBe(false);
  expect(cmds.some((c) => c === "push origin main")).toBe(false);
});

test("fn-1140 mergeLaneBaseIntoDefault: a merge-tree HARD error (exit > 1) → { kind: 'plumbing-failed' }, NOT a conflict, no ref advance", async () => {
  const { run, cmds } = makeMergeGit({ mergeTreeExit: 128 });
  const res = await mergeLaneBaseIntoDefault(
    "/repo",
    "keeper/epic/fn-1-foo",
    "main",
    run,
    () => ({ release() {} }),
  );
  expect(res.kind).toBe("plumbing-failed");
  expect(cmds.some((c) => c.startsWith("update-ref"))).toBe(false);
  expect(cmds.some((c) => c === "push origin main")).toBe(false);
});

test("fn-1140 mergeLaneBaseIntoDefault: the commit-tree merge commit is minted with a PINNED identity + base-tip date (deterministic OID across a crash-retry)", async () => {
  // All four GIT_AUTHOR/COMMITTER NAME+EMAIL are pinned + both dates are pinned to
  // the base-tip committer date, so a crash-retry re-derives the SAME commit OID and
  // the update-ref CAS is a clean no-op instead of minting a divergent duplicate.
  const { run, calls } = makeMergeGit();
  await mergeLaneBaseIntoDefault(
    "/repo",
    "keeper/epic/fn-1-foo",
    "main",
    run,
    () => ({ release() {} }),
  );
  const ct = calls.find((c) => c.args.startsWith("commit-tree"));
  expect(ct).toBeDefined();
  expect(ct?.env).toMatchObject({
    GIT_AUTHOR_NAME: "keeper",
    GIT_AUTHOR_EMAIL: "keeper@localhost",
    GIT_COMMITTER_NAME: "keeper",
    GIT_COMMITTER_EMAIL: "keeper@localhost",
    GIT_AUTHOR_DATE: MG_BASE_TIP_DATE,
    GIT_COMMITTER_DATE: MG_BASE_TIP_DATE,
  });
});

test("fn-1140 mergeLaneBaseIntoDefault: a crash-retry after the ref already landed → the ahead-check short-circuits to not-ahead (idempotent no-op)", async () => {
  // A prior run advanced default (so base is now an ancestor of local default) AND
  // pushed (origin already contains it). The re-run's ahead-check sees not-ahead and
  // NEVER re-merges — no merge-tree, no commit-tree, no second update-ref.
  const { run, cmds } = makeMergeGit({
    baseAncestorOfDefault: true,
    originContainsBaseBeforePush: true,
  });
  const res = await mergeLaneBaseIntoDefault(
    "/repo",
    "keeper/epic/fn-1-foo",
    "main",
    run,
    () => ({ release() {} }),
  );
  expect(res).toEqual({ kind: "not-ahead" });
  expect(cmds.some((c) => c.startsWith("merge-tree"))).toBe(false);
  expect(cmds.some((c) => c.startsWith("commit-tree"))).toBe(false);
  expect(cmds.some((c) => c.startsWith("update-ref"))).toBe(false);
});

test("fn-1140 mergeLaneBaseIntoDefault: a merge-tree CONFLICT (exit 1) → { kind: 'conflict' }, no ref advance, no push (the existing sticky escalation path)", async () => {
  const { run, cmds } = makeMergeGit({ mergeTreeExit: 1 });
  const res = await mergeLaneBaseIntoDefault(
    "/repo",
    "keeper/epic/fn-1-foo",
    "main",
    run,
    () => ({ release() {} }),
  );
  expect(res.kind).toBe("conflict");
  if (res.kind === "conflict") {
    // A raw discriminant — never a reason string. The CALLER maps it (finalize →
    // `worktree-finalize-conflict`, recover → `worktree-merge-conflict`), so the core
    // can carry no `worktree-recover*` reason that would auto-clear a finalize.
    expect(isWorktreeRecoverReason(res.stderr)).toBe(false);
    expect(res.stderr).toContain("CONFLICT");
  }
  // A conflict never advances the ref, never commits, never pushes.
  expect(cmds.some((c) => c.startsWith("commit-tree"))).toBe(false);
  expect(cmds.some((c) => c.startsWith("update-ref"))).toBe(false);
  expect(cmds.some((c) => c === "push origin main")).toBe(false);
});

test("fn-1140 mergeLaneBaseIntoDefault: a push failure after the ref advance → { kind: 'push-failed' }", async () => {
  const { run } = makeMergeGit({ pushExit: 1 });
  const res = await mergeLaneBaseIntoDefault(
    "/repo",
    "keeper/epic/fn-1-foo",
    "main",
    run,
    () => ({ release() {} }),
  );
  expect(res).toEqual({ kind: "push-failed", detail: "remote rejected" });
});

test("fn-1140 mergeLaneBaseIntoDefault: a push TIMEOUT (spawn-timeout sentinel) → { kind: 'push-timeout' }, not push-failed", async () => {
  const { run } = makeMergeGit({ pushTimeout: true });
  const res = await mergeLaneBaseIntoDefault(
    "/repo",
    "keeper/epic/fn-1-foo",
    "main",
    run,
    () => ({ release() {} }),
  );
  expect(res).toEqual({ kind: "push-timeout" });
});

test("fn-1140 mergeLaneBaseIntoDefault: turn-key probe runs BEFORE the FF precheck, and an UNRESOLVED origin/<default> (never-pushed) is admitted, not deadlocked", async () => {
  // The never-pushed-default scenario: origin/<default> does not resolve, so the
  // cached-ref FF precheck is "unknown". With turn-key FIRST + admitting (its
  // dry-run passes), the merge proceeds rather than dead-locking.
  const { run, cmds } = makeMergeGit({ originUnresolved: true });
  const res = await mergeLaneBaseIntoDefault(
    "/repo",
    "keeper/epic/fn-1-foo",
    "main",
    run,
    () => ({ release() {} }),
  );
  expect(res).toEqual({ kind: "merged" });
  // Ordering: the turn-key dry-run precedes the cached-ref FF (origin-ref) probe.
  const dryIdx = cmds.findIndex((c) => c.startsWith("push --dry-run"));
  const ffIdx = cmds.indexOf(
    "rev-parse --verify --quiet refs/remotes/origin/main",
  );
  expect(dryIdx).toBeGreaterThanOrEqual(0);
  expect(ffIdx).toBeGreaterThanOrEqual(0);
  expect(dryIdx).toBeLessThan(ffIdx);
});

test("fn-991 mergeLaneBaseIntoDefault: a base merged into LOCAL default but ABSENT from origin → RE-PUSH before the not-ahead teardown signal", async () => {
  // The push-timeout-stranded-merge class: the base is an ancestor of LOCAL
  // default (already merged) but a prior push timed out, so origin/<default> never
  // got it. Returning `not-ahead` straight to teardown would strand the merge.
  const base = "keeper/epic/fn-1-foo";
  const cmds: string[] = [];
  let pushed = false;
  const fakeRun: Parameters<typeof mergeLaneBaseIntoDefault>[3] = async (
    args,
  ) => {
    const joined = args.join(" ");
    cmds.push(joined);
    if (joined === `merge-base --is-ancestor ${base} main`) {
      return { code: 0, stdout: "", stderr: "" }; // ancestor of LOCAL default
    }
    if (
      joined === `merge-base --is-ancestor ${base} refs/remotes/origin/main`
    ) {
      // origin LACKS the merge until the re-push lands (the post-push recheck then
      // sees it contained → teardown-safe `not-ahead`).
      return { code: pushed ? 0 : 1, stdout: "", stderr: "" };
    }
    if (joined === "rev-parse --abbrev-ref HEAD") {
      return { code: 0, stdout: "main\n", stderr: "" }; // HEAD on default → push allowed
    }
    if (joined === "remote get-url origin") {
      return { code: 0, stdout: "git@host:repo.git\n", stderr: "" };
    }
    if (
      joined.startsWith("rev-parse --abbrev-ref --symbolic-full-name @{push}")
    ) {
      return { code: 0, stdout: "origin/main\n", stderr: "" };
    }
    if (joined.startsWith("push --dry-run")) {
      return { code: 0, stdout: "", stderr: "" }; // turn-key green
    }
    if (joined === "merge-base --is-ancestor refs/remotes/origin/main main") {
      return { code: 0, stdout: "", stderr: "" }; // FF precheck: ff-able
    }
    if (joined === "push origin main") {
      pushed = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" }; // rev-parse --verify --quiet
  };
  const res = await mergeLaneBaseIntoDefault("/repo", base, "main", fakeRun);
  expect(res).toEqual({ kind: "not-ahead" });
  // The stranded merge was RE-PUSHED (branch-explicit) before signaling teardown-safe...
  expect(cmds.some((c) => c === "push origin main")).toBe(true);
  // ...with NO merge and NO mergeReadiness (a push touches refs, not the tree).
  expect(cmds.some((c) => c.startsWith("merge --no-edit"))).toBe(false);
  expect(cmds.some((c) => c.startsWith("status --porcelain"))).toBe(false);
});

test("fn-991 mergeLaneBaseIntoDefault: a base absent from origin whose RE-PUSH times out → `push-timeout` (the caller defers, never tears down)", async () => {
  const base = "keeper/epic/fn-1-foo";
  const fakeRun: Parameters<typeof mergeLaneBaseIntoDefault>[3] = async (
    args,
  ) => {
    const joined = args.join(" ");
    if (joined === `merge-base --is-ancestor ${base} main`) {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (
      joined === `merge-base --is-ancestor ${base} refs/remotes/origin/main`
    ) {
      return { code: 1, stdout: "", stderr: "" }; // origin lacks it
    }
    if (joined === "rev-parse --abbrev-ref HEAD") {
      return { code: 0, stdout: "main\n", stderr: "" }; // HEAD on default → push allowed
    }
    if (joined === "remote get-url origin") {
      return { code: 0, stdout: "git@host:repo.git\n", stderr: "" };
    }
    if (
      joined.startsWith("rev-parse --abbrev-ref --symbolic-full-name @{push}")
    ) {
      return { code: 0, stdout: "origin/main\n", stderr: "" };
    }
    if (joined.startsWith("push --dry-run")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (joined === "merge-base --is-ancestor refs/remotes/origin/main main") {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (joined === "push origin main") {
      return { code: GIT_SPAWN_TIMEOUT_CODE, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const res = await mergeLaneBaseIntoDefault("/repo", base, "main", fakeRun);
  expect(res).toEqual({ kind: "push-timeout" });
});

test("fn-992 mergeLaneBaseIntoDefault: a base absent from origin while HEAD is OFF-default → `off-branch`, NO push (a no-refspec push would target the wrong ref)", async () => {
  // The push.default=simple footgun: a base merged into LOCAL default but absent
  // from origin would trigger the not-ahead re-push — but if the shared checkout
  // HEAD is off the default branch, a no-refspec push targets the WRONG upstream.
  // The HEAD-safety arm degrades (off-branch, NO push) instead of stranding the
  // merge behind a false `pushed`.
  const base = "keeper/epic/fn-1-foo";
  const cmds: string[] = [];
  const fakeRun: Parameters<typeof mergeLaneBaseIntoDefault>[3] = async (
    args,
  ) => {
    const joined = args.join(" ");
    cmds.push(joined);
    if (joined === `merge-base --is-ancestor ${base} main`) {
      return { code: 0, stdout: "", stderr: "" }; // ancestor of LOCAL default
    }
    if (
      joined === `merge-base --is-ancestor ${base} refs/remotes/origin/main`
    ) {
      return { code: 1, stdout: "", stderr: "" }; // origin LACKS the merge
    }
    if (joined === "rev-parse --abbrev-ref HEAD") {
      return { code: 0, stdout: "feature\n", stderr: "" }; // HEAD OFF the default branch
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const res = await mergeLaneBaseIntoDefault("/repo", base, "main", fakeRun);
  expect(res).toEqual({ kind: "off-branch", head: "feature" });
  // NO push of ANY form ran — not a bare push, not the wrong-ref push.
  expect(cmds.some((c) => c === "push")).toBe(false);
  expect(cmds.some((c) => c.startsWith("push origin"))).toBe(false);
});

test("fn-992 mergeLaneBaseIntoDefault: a re-push that exits 0 but leaves origin un-advanced → `push-unconfirmed` (the caller defers, never tears down)", async () => {
  // "Exit 0 but origin didn't move": the post-push origin-containment recheck must
  // refuse to signal teardown-safe until origin PROVABLY carries the merge.
  const base = "keeper/epic/fn-1-foo";
  const cmds: string[] = [];
  const fakeRun: Parameters<typeof mergeLaneBaseIntoDefault>[3] = async (
    args,
  ) => {
    const joined = args.join(" ");
    cmds.push(joined);
    if (joined === `merge-base --is-ancestor ${base} main`) {
      return { code: 0, stdout: "", stderr: "" }; // ancestor of LOCAL default
    }
    if (
      joined === `merge-base --is-ancestor ${base} refs/remotes/origin/main`
    ) {
      return { code: 1, stdout: "", stderr: "" }; // origin LACKS it — before AND after the push
    }
    if (joined === "rev-parse --abbrev-ref HEAD") {
      return { code: 0, stdout: "main\n", stderr: "" }; // HEAD on default → push allowed
    }
    if (joined === "remote get-url origin") {
      return { code: 0, stdout: "git@host:repo.git\n", stderr: "" };
    }
    if (
      joined.startsWith("rev-parse --abbrev-ref --symbolic-full-name @{push}")
    ) {
      return { code: 0, stdout: "origin/main\n", stderr: "" };
    }
    if (joined.startsWith("push --dry-run")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (joined === "merge-base --is-ancestor refs/remotes/origin/main main") {
      return { code: 0, stdout: "", stderr: "" }; // FF ff-able
    }
    if (joined === "push origin main") {
      return { code: 0, stdout: "Everything up-to-date\n", stderr: "" }; // exit 0, no advance
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const res = await mergeLaneBaseIntoDefault("/repo", base, "main", fakeRun);
  expect(res).toEqual({ kind: "push-unconfirmed" });
  // The push DID run (branch-explicit) but the recheck refused teardown-safe.
  expect(cmds.some((c) => c === "push origin main")).toBe(true);
});

test("fn-1140 mergeLaneBaseIntoDefault: the real-merge arm re-checks origin post-push — ref advanced + pushed (exit 0) but origin un-advanced → push-unconfirmed, never merged", async () => {
  // The real-merge arm (base NOT yet an ancestor of local default) must mirror the
  // not-ahead arm — a branch-explicit push THEN a post-push origin-containment
  // recheck. A push that exits 0 yet leaves origin/<default> un-advanced degrades to
  // `push-unconfirmed` (the existing retry-skip), so the caller defers teardown
  // rather than stranding the merge behind a false `pushed`.
  const { run, cmds } = makeMergeGit({
    originContainsBase: false, // origin still LACKS it even after the push
    pushStdout: "Everything up-to-date\n",
  });
  const res = await mergeLaneBaseIntoDefault(
    "/repo",
    "keeper/epic/fn-1-foo",
    "main",
    run,
    () => ({ release() {} }),
  );
  expect(res).toEqual({ kind: "push-unconfirmed" });
  // The merge landed (ref advanced) and the push was branch-explicit — never a bare `push`.
  expect(cmds.some((c) => c.startsWith("update-ref"))).toBe(true);
  expect(cmds.some((c) => c === "push origin main")).toBe(true);
  expect(cmds.some((c) => c === "push")).toBe(false);
});

test("worktreeRecoverDispatchId: slugs the dir so the recover key is retry-clearable", () => {
  // The raw dir embeds `/`, which the retry_dispatch validator rejects (stranding
  // the row); the slug strips separators and any leading dash.
  expect(worktreeRecoverDispatchId("/Users/mike/code/arthack")).toBe(
    "worktree-recover:Users-mike-code-arthack",
  );
  const id = worktreeRecoverDispatchId("/a/b/c");
  expect(id.includes("/")).toBe(false);
  expect(id.startsWith("worktree-recover:")).toBe(true);
});

test("fn-959 createWorktreeDriver: finalizeEpic skips a never-forked epic (no base branch) — no merge attempted", async () => {
  // A `done` epic from before worktree mode has no `keeper/epic/<id>` base branch.
  // finalize must be a clean no-op, NOT a phantom-merge "not something we can merge".
  const cmds: string[] = [];
  const fakeRun: Parameters<typeof createWorktreeDriver>[0] = async (args) => {
    cmds.push(args.join(" "));
    // The base branch does not exist → rev-parse --verify returns non-zero.
    if (isInProgressPseudoRefProbe(args)) {
      return { code: 1, stdout: "", stderr: "" }; // clean: in-progress pseudo-ref absent
    }
    if (args[0] === "rev-parse" && args.includes("--verify")) {
      return { code: 1, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const driver = createWorktreeDriver(fakeRun);
  const info: WorktreeLaunchInfo = {
    assignment: {
      // nodeId is inert for finalize (which keys off baseBranch); the close sink.
      nodeId: "__close__",
      isCloseSink: true,
      branch: "keeper/epic/fn-1-foo",
      worktreePath: "/repo.worktrees/keeper-epic-fn-1-foo",
      inherited: true,
      preMerges: [],
      assertBranch: "keeper/epic/fn-1-foo",
    },
    baseBranch: "keeper/epic/fn-1-foo",
    baseWorktreePath: "/repo.worktrees/keeper-epic-fn-1-foo",
    repoDir: "/repo",
    laneOrder: [],
    parentBranch: "keeper/epic/fn-1-foo",
  };
  const res = await driver.finalizeEpic(info, async () => true);
  expect(res).toEqual({ ok: true });
  // It checked the base branch and then stopped — no merge, no teardown.
  expect(cmds.some((c) => c.startsWith("merge"))).toBe(false);
  expect(cmds.some((c) => c.startsWith("worktree remove"))).toBe(false);
});

test("fn-959 createWorktreeDriver: provision ensures the worktree off the parent tip, then asserts HEAD == branch", async () => {
  // Drive the real driver against a fake GitRunner — no real git. The driver must
  // ensure (add), list (registered check), and rev-parse HEAD against the branch.
  const cmds: string[] = [];
  let added = false;
  const fakeRun: Parameters<typeof createWorktreeDriver>[0] = async (
    args,
    _o,
  ) => {
    cmds.push(args.join(" "));
    const joined = args.join(" ");
    if (joined.startsWith("worktree add")) {
      added = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (joined.startsWith("worktree list")) {
      // Empty until the add lands, then report the worktree on its branch (so
      // ensureWorktree actually adds, and the post-add registered check passes).
      if (!added) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return {
        code: 0,
        stdout:
          "worktree /repo.worktrees/keeper-epic-fn-1-foo\nHEAD abc\nbranch refs/heads/keeper/epic/fn-1-foo\n\n",
        stderr: "",
      };
    }
    if (joined.startsWith("rev-parse --abbrev-ref HEAD")) {
      return { code: 0, stdout: "keeper/epic/fn-1-foo\n", stderr: "" };
    }
    if (joined.startsWith("rev-parse --verify --quiet refs/heads")) {
      return { code: 1, stdout: "", stderr: "" }; // branch does not yet exist
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const driver = createWorktreeDriver(fakeRun);
  const info: WorktreeLaunchInfo = {
    assignment: {
      nodeId: "fn-1-foo.1",
      isCloseSink: false,
      branch: "keeper/epic/fn-1-foo",
      worktreePath: "/repo.worktrees/keeper-epic-fn-1-foo",
      inherited: true,
      preMerges: [],
      assertBranch: "keeper/epic/fn-1-foo",
    },
    baseBranch: "keeper/epic/fn-1-foo",
    baseWorktreePath: "/repo.worktrees/keeper-epic-fn-1-foo",
    repoDir: "/repo",
    laneOrder: [],
    parentBranch: "keeper/epic/fn-1-foo",
  };
  const res = await driver.provision(info, null);
  expect(res).toEqual({
    ok: true,
    cwd: "/repo.worktrees/keeper-epic-fn-1-foo",
  });
  // A worktree add ran, and HEAD was asserted against the branch.
  expect(cmds.some((c) => c.startsWith("worktree add"))).toBe(true);
  expect(cmds).toContain("rev-parse --abbrev-ref HEAD");
});

test("fn-959 createWorktreeDriver: provision forks the BASE lane off the resolved default branch, not its own (uncreated) branch", async () => {
  // Regression: the base branch does not exist yet (this add CREATES it), so
  // forking off `parentBranch === branch` was `git worktree add -b X <path> X`
  // → "invalid reference". The fork source must be the repo's default branch.
  const cmds: string[] = [];
  let added = false;
  const fakeRun: Parameters<typeof createWorktreeDriver>[0] = async (args) => {
    cmds.push(args.join(" "));
    const joined = args.join(" ");
    if (joined.startsWith("symbolic-ref")) {
      return { code: 0, stdout: "origin/main\n", stderr: "" }; // default = main
    }
    if (joined.startsWith("worktree add")) {
      added = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (joined.startsWith("worktree list")) {
      return added
        ? {
            code: 0,
            stdout:
              "worktree /repo.worktrees/keeper-epic-fn-1-foo\nHEAD abc\nbranch refs/heads/keeper/epic/fn-1-foo\n\n",
            stderr: "",
          }
        : { code: 0, stdout: "", stderr: "" };
    }
    if (joined.startsWith("rev-parse --abbrev-ref HEAD")) {
      return { code: 0, stdout: "keeper/epic/fn-1-foo\n", stderr: "" };
    }
    if (joined.startsWith("rev-parse --verify --quiet refs/heads")) {
      return { code: 1, stdout: "", stderr: "" }; // base branch not created yet
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const driver = createWorktreeDriver(fakeRun);
  const info: WorktreeLaunchInfo = {
    assignment: {
      nodeId: "fn-1-foo.1",
      isCloseSink: false,
      branch: "keeper/epic/fn-1-foo",
      worktreePath: "/repo.worktrees/keeper-epic-fn-1-foo",
      inherited: true,
      preMerges: [],
      assertBranch: "keeper/epic/fn-1-foo",
    },
    baseBranch: "keeper/epic/fn-1-foo",
    baseWorktreePath: "/repo.worktrees/keeper-epic-fn-1-foo",
    repoDir: "/repo",
    laneOrder: [],
    parentBranch: "keeper/epic/fn-1-foo", // === branch: the base lane
  };
  const res = await driver.provision(info, null);
  expect(res.ok).toBe(true);
  // Forks off `main` (resolved default), NOT the uncreated base branch.
  expect(cmds).toContain(
    "worktree add -b keeper/epic/fn-1-foo /repo.worktrees/keeper-epic-fn-1-foo main",
  );
});

test("fn-959 createWorktreeDriver: provision forks a RIB off its parent lane (default branch not consulted)", async () => {
  const cmds: string[] = [];
  let added = false;
  const fakeRun: Parameters<typeof createWorktreeDriver>[0] = async (args) => {
    cmds.push(args.join(" "));
    const joined = args.join(" ");
    if (joined.startsWith("worktree add")) {
      added = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (joined.startsWith("worktree list")) {
      return added
        ? {
            code: 0,
            stdout:
              "worktree /repo.worktrees/keeper-epic-fn-1-foo-fn-1-foo.2\nHEAD abc\nbranch refs/heads/keeper/epic/fn-1-foo--fn-1-foo.2\n\n",
            stderr: "",
          }
        : { code: 0, stdout: "", stderr: "" };
    }
    if (joined.startsWith("rev-parse --abbrev-ref HEAD")) {
      return {
        code: 0,
        stdout: "keeper/epic/fn-1-foo--fn-1-foo.2\n",
        stderr: "",
      };
    }
    if (joined.startsWith("rev-parse --verify --quiet refs/heads")) {
      return { code: 1, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const driver = createWorktreeDriver(fakeRun);
  const info: WorktreeLaunchInfo = {
    assignment: {
      nodeId: "fn-1-foo.2",
      isCloseSink: false,
      branch: "keeper/epic/fn-1-foo--fn-1-foo.2",
      worktreePath: "/repo.worktrees/keeper-epic-fn-1-foo-fn-1-foo.2",
      inherited: false,
      preMerges: [],
      assertBranch: "keeper/epic/fn-1-foo--fn-1-foo.2",
    },
    baseBranch: "keeper/epic/fn-1-foo",
    baseWorktreePath: "/repo.worktrees/keeper-epic-fn-1-foo",
    repoDir: "/repo",
    laneOrder: [],
    parentBranch: "keeper/epic/fn-1-foo", // the parent lane (!== branch)
  };
  const res = await driver.provision(info, null);
  expect(res.ok).toBe(true);
  // Forks off the parent lane; the default-branch resolution is never consulted.
  expect(cmds).toContain(
    "worktree add -b keeper/epic/fn-1-foo--fn-1-foo.2 /repo.worktrees/keeper-epic-fn-1-foo-fn-1-foo.2 keeper/epic/fn-1-foo",
  );
  expect(cmds.some((c) => c.startsWith("symbolic-ref"))).toBe(false);
});

// ---------------------------------------------------------------------------
// fn-979 — the fan-in pre-merge loop tolerates a PHANTOM lane source (a branch
// never created because its task's work landed on the default branch) as a
// lossless `missing-source` no-op, while a genuine conflict still fails loud.
// ---------------------------------------------------------------------------

/**
 * A fake GitRunner for `createWorktreeDriver.provision` tests exercising the
 * fan-in pre-merge loop. `phantomSources` resolve their `^{commit}` probe to
 * non-zero (the lane was never created → `missing-source`); `conflictSources`
 * resolve but their `merge --no-edit` conflicts (a MERGE_HEAD is present so the
 * abort runs). Any other source merges cleanly. `lockDir` (a real temp dir)
 * backs the per-worktree flock the conflict path acquires via the real
 * `defaultLockAcquirer`. Records each joined argv for assertion.
 */
function makePhantomFanInRun(opts: {
  phantomSources: string[];
  conflictSources?: string[];
  lockDir?: string;
}): { run: Parameters<typeof createWorktreeDriver>[0]; cmds: string[] } {
  const cmds: string[] = [];
  let added = false;
  // Stateful MERGE_HEAD: absent until a `merge --no-edit` conflicts, so the pre-merge
  // readiness probe sees a CLEAN base and only the guarded post-conflict abort finds
  // the in-flight merge. Cleared by `merge --abort`.
  let midMerge = false;
  const conflicts = new Set(opts.conflictSources ?? []);
  const phantoms = opts.phantomSources;
  const run: Parameters<typeof createWorktreeDriver>[0] = async (args) => {
    const joined = args.join(" ");
    cmds.push(joined);
    if (joined.startsWith("symbolic-ref")) {
      return { code: 0, stdout: "origin/main\n", stderr: "" };
    }
    if (joined.includes("^{commit}")) {
      // The pre-merge ref probe (`rev-parse --quiet --verify --end-of-options
      // refs/heads/<src>^{commit}`). A phantom lane does not resolve → exit 1.
      const ref = args[args.length - 1] ?? "";
      const isPhantom = phantoms.some((p) => ref.includes(p));
      return { code: isPhantom ? 1 : 0, stdout: "", stderr: "" };
    }
    if (joined.startsWith("merge-base --is-ancestor")) {
      return { code: 1, stdout: "", stderr: "" }; // not an ancestor → must merge
    }
    if (joined.startsWith("rev-parse --path-format=absolute --git-dir")) {
      return {
        code: 0,
        stdout: `${opts.lockDir ?? "/repo/.git"}\n`,
        stderr: "",
      };
    }
    if (joined.startsWith("merge --no-edit")) {
      const source = args[2] ?? "";
      if (conflicts.has(source)) {
        midMerge = true; // a conflict leaves MERGE_HEAD for the guarded abort
        return { code: 1, stdout: "CONFLICT (content)\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (joined === "rev-parse --verify --quiet MERGE_HEAD") {
      return midMerge
        ? { code: 0, stdout: "head\n", stderr: "" } // in-flight → abort runs
        : { code: 1, stdout: "", stderr: "" }; // clean base → readiness sees no merge
    }
    if (joined.startsWith("merge --abort")) {
      midMerge = false;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (joined.startsWith("worktree add")) {
      added = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (joined.startsWith("worktree list")) {
      return added
        ? {
            code: 0,
            stdout:
              "worktree /repo.worktrees/keeper-epic-fn-1-foo\nHEAD abc\nbranch refs/heads/keeper/epic/fn-1-foo\n\n",
            stderr: "",
          }
        : { code: 0, stdout: "", stderr: "" };
    }
    if (joined.startsWith("rev-parse --abbrev-ref HEAD")) {
      return { code: 0, stdout: "keeper/epic/fn-1-foo\n", stderr: "" };
    }
    if (joined.startsWith("rev-parse --verify --quiet refs/heads")) {
      return { code: 1, stdout: "", stderr: "" }; // lane branch not yet created
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, cmds };
}

/** A close-sink fan-in provision with `preMerges` as its rib sources. */
function makeFanInInfo(preMerges: string[]): WorktreeLaunchInfo {
  return {
    assignment: {
      nodeId: "fn-1-foo.close",
      isCloseSink: true,
      branch: "keeper/epic/fn-1-foo",
      worktreePath: "/repo.worktrees/keeper-epic-fn-1-foo",
      inherited: true,
      preMerges,
      assertBranch: "keeper/epic/fn-1-foo",
    },
    baseBranch: "keeper/epic/fn-1-foo",
    baseWorktreePath: "/repo.worktrees/keeper-epic-fn-1-foo",
    repoDir: "/repo",
    laneOrder: [],
    parentBranch: "keeper/epic/fn-1-foo",
  };
}

test("fn-979 createWorktreeDriver: provision skips a phantom pre-merge (missing-source) and still succeeds", async () => {
  const phantom = "keeper/epic/fn-1-foo--fn-1-foo.2";
  const { run, cmds } = makePhantomFanInRun({ phantomSources: [phantom] });
  const driver = createWorktreeDriver(run);
  const res = await driver.provision(makeFanInInfo([phantom]), null);
  expect(res).toEqual({
    ok: true,
    cwd: "/repo.worktrees/keeper-epic-fn-1-foo",
  });
  // The phantom short-circuited at the probe — no merge-base, no merge, no lock.
  expect(cmds.some((c) => c.startsWith("merge-base --is-ancestor"))).toBe(
    false,
  );
  expect(cmds.some((c) => c.startsWith("merge --no-edit"))).toBe(false);
  expect(
    cmds.some((c) =>
      c.startsWith("rev-parse --path-format=absolute --git-dir"),
    ),
  ).toBe(false);
});

test("fn-979 createWorktreeDriver: provision skips a phantom but a LATER real conflict still fails loud (phantom-then-conflict)", async () => {
  const phantom = "keeper/epic/fn-1-foo--fn-1-foo.2";
  const conflict = "keeper/epic/fn-1-foo--fn-1-foo.3";
  const lockDir = mkdtempSync(join(tmpdir(), "kpr-wt-phantom-"));
  try {
    const { run, cmds } = makePhantomFanInRun({
      phantomSources: [phantom],
      conflictSources: [conflict],
      lockDir,
    });
    const driver = createWorktreeDriver(run);
    const res = await driver.provision(
      makeFanInInfo([phantom, conflict]),
      null,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("worktree-merge-conflict");
      expect(res.reason).toContain(conflict);
    }
    // The phantom never attempted a merge; the real conflict did, then aborted.
    expect(cmds).not.toContain(`merge --no-edit ${phantom}`);
    expect(cmds).toContain(`merge --no-edit ${conflict}`);
    expect(cmds.some((c) => c.startsWith("merge --abort"))).toBe(true);
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("fn-979 createWorktreeDriver: a real conflict BEFORE a phantom fails loud immediately (conflict-then-phantom)", async () => {
  const conflict = "keeper/epic/fn-1-foo--fn-1-foo.2";
  const phantom = "keeper/epic/fn-1-foo--fn-1-foo.3";
  const lockDir = mkdtempSync(join(tmpdir(), "kpr-wt-phantom-"));
  try {
    const { run, cmds } = makePhantomFanInRun({
      phantomSources: [phantom],
      conflictSources: [conflict],
      lockDir,
    });
    const driver = createWorktreeDriver(run);
    const res = await driver.provision(
      makeFanInInfo([conflict, phantom]),
      null,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("worktree-merge-conflict");
      expect(res.reason).toContain(conflict);
    }
    // The conflict short-circuits the loop — the phantom source is never probed.
    expect(cmds.some((c) => c.includes(`${phantom}^{commit}`))).toBe(false);
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("fn-959 createWorktreeDriver: assertOnDefaultBranch fails loud off the default branch", async () => {
  const fakeRun: Parameters<typeof createWorktreeDriver>[0] = async (args) => {
    const joined = args.join(" ");
    if (joined.startsWith("symbolic-ref")) {
      return { code: 0, stdout: "origin/main\n", stderr: "" };
    }
    if (joined.startsWith("rev-parse --abbrev-ref HEAD")) {
      return { code: 0, stdout: "feature-x\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const driver = createWorktreeDriver(fakeRun);
  const res = await driver.assertOnDefaultBranch("/repo");
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.reason).toContain("not-on-default-branch");
    expect(res.reason).toContain("expected main");
  }
});

// ---------------------------------------------------------------------------
// fn-959.7 — producer-only worktree crash/restart recovery (recoverWorktrees,
// reposForRecovery, isEpicDoneById). Fast tier drives the two passes with a
// hand-built fake GitRunner; the real-git lifecycle lives in the slow test.
// ---------------------------------------------------------------------------

test("fn-959.7/fn-978 reposForRecovery: deduped, RESOLVED toplevels; multi-repo/unresolved skipped", () => {
  const epics = [
    makeEpic({ epic_id: "fn-1-a", project_dir: "/repo-a" }),
    makeEpic({ epic_id: "fn-2-b", project_dir: "/repo-a" }), // shares /repo-a
    makeEpic({ epic_id: "fn-3-c", project_dir: "/repo-c" }),
    makeEpic({ epic_id: "fn-4-d", project_dir: null }), // unresolved → skipped
    makeEpic({ epic_id: "fn-5-e", project_dir: "" }), // unresolved → skipped
  ];
  // Identity resolution (raw root = its own toplevel); empty/null project_dir
  // classifies `unresolved`, so those epics are skipped (no lane was provisioned).
  const repoMap = classifyWorktreeRepos(epics, (r) => r);
  expect(reposForRecovery(epics, repoMap)).toEqual(["/repo-a", "/repo-c"]);
});

test("fn-988 reposForRecovery: knownRoots union in repos with no current epic (out-of-snapshot sweep), deduped", () => {
  const epics = [makeEpic({ epic_id: "fn-1-a", project_dir: "/repo-a" })];
  const repoMap = classifyWorktreeRepos(epics, (r) => r);
  // /repo-b carries a done-but-unmerged base but its epic was already reaped from
  // the snapshot — knownRoots brings it into the sweep. /repo-a (already sourced
  // from its epic) is NOT duplicated, and an empty root is dropped.
  expect(reposForRecovery(epics, repoMap, ["/repo-a", "/repo-b", ""])).toEqual([
    "/repo-a",
    "/repo-b",
  ]);
});

/**
 * A stateful fake GitRunner for the recovery passes. Models a per-cwd MERGE_HEAD
 * flag, a registered worktree list, the `keeper/epic/*` base set, the default
 * branch, each base's already-merged (ancestor) status, the main worktree's HEAD,
 * and whether a `merge`/`push` succeeds — enough to drive both recovery passes
 * without real git. Records the issued argv per cwd so a test asserts the
 * abort/prune/merge/push sequence.
 */
function makeRecoveryGit(state: {
  worktreeList?: string; // git worktree list --porcelain stdout
  mergeHeadAt?: Set<string>; // cwds with a stale MERGE_HEAD
  pointsAtBranches?: Map<string, string[]>; // cwd → `refs/heads/...` refs pointing at its MERGE_HEAD (ownership + owning-epic derivation)
  autostashAt?: Set<string>; // cwds whose mid-merge carries a MERGE_AUTOSTASH (refuses keeper ownership)
  abortFailsAt?: Set<string>; // cwds whose `merge --abort` returns non-zero (the un-cleared wedge)
  owningEpicProbeFailAt?: Map<string, number>; // cwd → non-zero exit for the owning-epic derivation `for-each-ref ... refs/heads/keeper/epic/` (an inconclusive resolver-ownership probe)
  epicBases?: string[]; // keeper/epic/<id> short refs (for-each-ref output)
  defaultBranch?: string; // resolved via symbolic-ref
  ancestors?: Set<string>; // branches already an ancestor of LOCAL default
  originAncestors?: Set<string>; // branches already an ancestor of origin/<default> (defaults to `ancestors`: merged locally ⇒ on origin unless a test strands it)
  originUnresolved?: boolean; // the cached origin/<default> ref does not resolve (never-pushed default) → FF precheck "unknown"
  repoHead?: string; // main worktree current branch
  headAt?: Map<string, string>; // cwd → that worktree's abbrev-ref HEAD (falls back to repoHead/defaultBranch)
  readTreeAbortAt?: Set<string>; // cwds whose two-tree catch-up read-tree aborts (a colliding edit)
  dirtyStatus?: string; // git status --porcelain stdout on the main checkout
  remoteAhead?: boolean; // cached origin ref NOT an ancestor of local → non-ff
  noRemote?: boolean; // `remote get-url origin` fails → not turn-key
  noPushTarget?: boolean; // `@{push}` does not resolve → not turn-key
  dryRunReject?: string; // `push --dry-run` stderr → not turn-key
  mergeConflict?: boolean; // the plumbing `merge-tree --write-tree` reports a conflict (exit 1)
  mergeTimeout?: boolean; // the plumbing `merge-tree --write-tree` spawn times out (a blocking hook)
  mergeTreeError?: boolean; // `merge-tree --write-tree` hard-errors (exit > 1) → plumbing-failed
  oldGit?: boolean; // `git version` < 2.38 → merge-tree-unsupported
  casStale?: boolean; // `update-ref` CAS finds a stale `<old>` (concurrent advance) → cas-stale
  pushFails?: boolean;
  pushTimeout?: boolean; // the push spawn times out (GNU-timeout sentinel)
  pushUnconfirmed?: boolean; // push exits 0 but origin/<default> never advances ("up-to-date" on the wrong ref)
  dirtyRemoveAt?: Set<string>; // worktree paths whose `worktree remove` refuses (dirty)
  linkedWorktreeAt?: Set<string>; // cwds whose git-dir ≠ common-dir → a linked lane (skipped by the sweep filter)
  probeErrorAt?: Set<string>; // cwds whose git-dir/common-dir probe exits nonzero → defer the repo this cycle
  stagedPaths?: Map<string, string[]>; // cwd → `git diff --cached --name-only -z` paths (mid-merge staged set the abort would touch)
  mergeTouchedPaths?: Map<string, string[]>; // cwd → `git diff --name-only -z HEAD MERGE_HEAD` paths (the merge's OWN set — auto-merged + resolved conflicts)
  stagedProbeFailAt?: Map<string, number>; // cwd → non-zero exit for the `git diff --cached` staged-set probe (an inconclusive foreign-staged probe)
}): {
  run: Parameters<typeof recoverWorktrees>[2];
  calls: { cwd: string; args: string; env?: Record<string, string> }[];
  lock: NonNullable<Parameters<typeof recoverWorktrees>[3]>;
} {
  const calls: { cwd: string; args: string; env?: Record<string, string> }[] =
    [];
  // Branches a successful pass-2 `merge --no-edit` landed into LOCAL default this
  // run. A subsequent successful push advances origin to contain them (origin
  // containment is distinct from the pre-merge local-ancestor `state.ancestors`),
  // so the post-push recheck confirms `merged` rather than a false push-unconfirmed
  // — while the LOCAL is-ancestor check (which pass-3 reads) stays `state.ancestors`
  // only, so a just-merged base is not double-swept by pass-3 in the same cycle.
  const mergedLocally = new Set<string>();
  // The base branch the plumbing merge is CURRENTLY landing (captured at its base-
  // tip rev-parse), so a successful `update-ref` can mark it merged-into-local-
  // default without the ref-advance argv carrying the branch name.
  let mergingBase: string | null = null;
  // A no-op lock acquirer so the merge path never touches the real FFI flock
  // (the slow real-git test covers the actual flock-around-merge contract).
  const lock: NonNullable<Parameters<typeof recoverWorktrees>[3]> = () => ({
    release() {},
  });
  const run: Parameters<typeof recoverWorktrees>[2] = async (args, o) => {
    const cwd = o?.cwd ?? "";
    const joined = args.join(" ");
    calls.push({ cwd, args: joined, env: o?.env });
    if (joined.startsWith("worktree list")) {
      return { code: 0, stdout: state.worktreeList ?? "", stderr: "" };
    }
    if (joined === "rev-parse --verify --quiet MERGE_HEAD") {
      const present = state.mergeHeadAt?.has(cwd) ?? false;
      return {
        code: present ? 0 : 1,
        stdout: present ? "head\n" : "",
        stderr: "",
      };
    }
    if (joined === "merge --abort") {
      if (state.abortFailsAt?.has(cwd)) {
        // The guarded abort ITSELF fails — the mid-merge residue does NOT clear.
        return { code: 1, stdout: "", stderr: "error: could not abort merge" };
      }
      state.mergeHeadAt?.delete(cwd);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (joined === "diff --cached --name-only -z") {
      // The foreign-staged probe's staged-set read (held under the abort flock). A
      // pinned non-zero exit models an inconclusive probe → the abort defers fail-safe.
      const fail = state.stagedProbeFailAt?.get(cwd);
      if (fail !== undefined && fail !== 0) {
        return { code: fail, stdout: "", stderr: "" };
      }
      return {
        code: 0,
        stdout: (state.stagedPaths?.get(cwd) ?? []).join("\0"),
        stderr: "",
      };
    }
    if (joined === "diff --name-only -z HEAD MERGE_HEAD") {
      // The merge's OWN set (auto-merged + resolved conflicts): any staged path outside
      // it is FOREIGN. Only read when the staged set is non-empty.
      return {
        code: 0,
        stdout: (state.mergeTouchedPaths?.get(cwd) ?? []).join("\0"),
        stderr: "",
      };
    }
    if (joined === "rev-parse --verify --quiet MERGE_AUTOSTASH") {
      const present = state.autostashAt?.has(cwd) ?? false;
      return {
        code: present ? 0 : 1,
        stdout: present ? "stash\n" : "",
        stderr: "",
      };
    }
    if (joined.startsWith("for-each-ref") && joined.includes("--points-at")) {
      // The branch-set at a cwd's MERGE_HEAD — shared by the mergeReadiness ownership
      // probe (`refs/heads/`) and the recover pass's owning-epic derivation
      // (`refs/heads/keeper/epic/`). MUST precede the `keeper/epic` catch-all below.
      // Only the OWNING-EPIC derivation (keeper/epic prefix) is pinnable to fail — the
      // readiness ownership probe (`refs/heads/`) still succeeds, so ownership resolves
      // keeper and the code reaches the resolver-exclusion guard on an inconclusive probe.
      const owningEpicFailCode = joined.includes("keeper/epic")
        ? state.owningEpicProbeFailAt?.get(cwd)
        : undefined;
      if (owningEpicFailCode !== undefined && owningEpicFailCode !== 0) {
        return { code: owningEpicFailCode, stdout: "", stderr: "" };
      }
      return {
        code: 0,
        stdout: (state.pointsAtBranches?.get(cwd) ?? []).join("\n"),
        stderr: "",
      };
    }
    if (joined.startsWith("worktree prune")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (joined.startsWith("worktree remove ")) {
      const path = args[2] ?? "";
      return state.dirtyRemoveAt?.has(path)
        ? {
            code: 1,
            stdout: "",
            stderr: "contains modified or untracked files",
          }
        : { code: 0, stdout: "", stderr: "" };
    }
    if (joined.startsWith("for-each-ref") && joined.includes("keeper/epic")) {
      return {
        code: 0,
        stdout: (state.epicBases ?? []).join("\n"),
        stderr: "",
      };
    }
    if (joined.startsWith("symbolic-ref")) {
      return {
        code: 0,
        stdout: `origin/${state.defaultBranch ?? "main"}\n`,
        stderr: "",
      };
    }
    if (joined.startsWith("for-each-ref")) {
      // local-branch enumeration for resolveDefaultBranch fallback
      return {
        code: 0,
        stdout: `${state.defaultBranch ?? "main"}\n`,
        stderr: "",
      };
    }
    if (joined.startsWith("status --porcelain")) {
      return { code: 0, stdout: state.dirtyStatus ?? "", stderr: "" };
    }
    if (
      joined.startsWith("merge-base --is-ancestor") &&
      args[2]?.startsWith("refs/remotes/origin/")
    ) {
      // Non-fast-forward precheck (`origin/<default>` as the ancestor candidate vs
      // local default): ff-able (origin is an ancestor) unless remoteAhead.
      return { code: state.remoteAhead ? 1 : 0, stdout: "", stderr: "" };
    }
    if (
      joined.startsWith("merge-base --is-ancestor") &&
      args[3]?.startsWith("refs/remotes/origin/")
    ) {
      // Origin-containment guard (a lane vs the cached `origin/<default>` ref):
      // does origin already carry this lane's merge? An UNRESOLVED origin ref makes
      // git's merge-base error → not-ancestor ("origin lacks the lane"). Otherwise
      // default to the LOCAL-default view (a base merged locally is normally on
      // origin too) unless a test pins a distinct `originAncestors` to model a
      // merge stranded off origin.
      if (state.originUnresolved) {
        return { code: 1, stdout: "", stderr: "" };
      }
      const set = state.originAncestors ?? state.ancestors;
      return { code: set?.has(args[2]) ? 0 : 1, stdout: "", stderr: "" };
    }
    if (joined.startsWith("merge-base --is-ancestor")) {
      const branch = args[2];
      return {
        code: state.ancestors?.has(branch) ? 0 : 1,
        stdout: "",
        stderr: "",
      };
    }
    if (joined.startsWith("rev-parse --abbrev-ref HEAD")) {
      return {
        code: 0,
        stdout: `${state.headAt?.get(cwd) ?? state.repoHead ?? state.defaultBranch ?? "main"}\n`,
        stderr: "",
      };
    }
    if (
      joined.startsWith("rev-parse --path-format=absolute --git-common-dir")
    ) {
      if (state.probeErrorAt?.has(cwd)) {
        return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
      }
      // A linked worktree's common-dir points at the SHARED parent .git (≠ its
      // per-worktree git-dir); a main/standalone checkout's common-dir EQUALS its
      // git-dir. `classifyLinkedWorktree` keys the linked verdict on the inequality.
      return {
        code: 0,
        stdout: state.linkedWorktreeAt?.has(cwd)
          ? "/shared/.git\n"
          : `${cwd}/.git\n`,
        stderr: "",
      };
    }
    if (joined.startsWith("rev-parse --path-format=absolute --git-dir")) {
      if (state.probeErrorAt?.has(cwd)) {
        return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
      }
      return { code: 0, stdout: `${cwd}/.git\n`, stderr: "" };
    }
    if (joined.startsWith("rev-parse --verify --quiet refs/remotes/origin/")) {
      // The cached remote-tracking ref resolution (FF precheck + the origin-
      // containment guard). Unresolved (never-pushed default) → "unknown", which
      // defers to turn-key rather than minting a false permanent non-FF skip.
      return state.originUnresolved
        ? { code: 1, stdout: "", stderr: "" }
        : { code: 0, stdout: "deadbeef\n", stderr: "" };
    }
    if (joined === "remote get-url origin") {
      return state.noRemote
        ? { code: 1, stdout: "", stderr: "error: No such remote 'origin'" }
        : { code: 0, stdout: "git@host:repo.git\n", stderr: "" };
    }
    if (
      joined.startsWith("rev-parse --abbrev-ref --symbolic-full-name @{push}")
    ) {
      return state.noPushTarget
        ? { code: 1, stdout: "", stderr: "fatal: no push destination" }
        : { code: 0, stdout: "origin/main\n", stderr: "" };
    }
    if (joined.startsWith("push --dry-run")) {
      return state.dryRunReject !== undefined
        ? { code: 1, stdout: "", stderr: state.dryRunReject }
        : { code: 0, stdout: "", stderr: "" };
    }
    if (joined === "version") {
      // Feature-detect gate for `merge-tree --write-tree` (git >= 2.38).
      return {
        code: 0,
        stdout: `git version ${state.oldGit ? "2.30.2" : "2.50.1"}\n`,
        stderr: "",
      };
    }
    if (
      joined.startsWith("rev-parse --verify --quiet --end-of-options") &&
      joined.endsWith("^{commit}")
    ) {
      // Plumbing tip resolution (`refs/heads/<branch>^{commit}`). Capture the base
      // being merged (the non-default ref) so a successful update-ref can mark it
      // merged. A constant hex OID satisfies the pipeline's hex-validation.
      const ref = args[4] ?? "";
      const branch = ref
        .replace(/^refs\/heads\//, "")
        .replace(/\^\{commit\}$/, "");
      if (branch !== (state.defaultBranch ?? "main")) {
        mergingBase = branch;
      }
      return {
        code: 0,
        stdout: "0123456789abcdef0123456789abcdef01234567\n",
        stderr: "",
      };
    }
    if (args[0] === "merge-tree") {
      // The working-tree-free 3-way merge. Exit 0 → tree OID on line 1, exit 1 →
      // conflict (the existing sticky escalation), > 1 → a plumbing hard error.
      if (state.mergeTimeout) {
        return { code: GIT_SPAWN_TIMEOUT_CODE, stdout: "", stderr: "" };
      }
      if (state.mergeTreeError) {
        return { code: 128, stdout: "", stderr: "fatal: merge-tree boom" };
      }
      if (state.mergeConflict) {
        return {
          code: 1,
          stdout:
            "0123456789abcdef0123456789abcdef01234567\nCONFLICT (content): foo\n",
          stderr: "",
        };
      }
      return {
        code: 0,
        stdout: "0123456789abcdef0123456789abcdef01234567\n",
        stderr: "",
      };
    }
    if (args[0] === "show") {
      // The pinned base-tip committer date fed to commit-tree's GIT_*_DATE.
      return { code: 0, stdout: "2026-01-02T03:04:05+00:00\n", stderr: "" };
    }
    if (args[0] === "commit-tree") {
      return {
        code: 0,
        stdout: "fedcba9876543210fedcba9876543210fedcba98\n",
        stderr: "",
      };
    }
    if (args[0] === "update-ref") {
      // Compare-and-swap the default ref. A stale `<old>` (concurrent advance) →
      // cas-stale; otherwise it advances local default to contain the merging base.
      if (state.casStale) {
        return {
          code: 1,
          stdout: "",
          stderr: "cannot lock ref: is at X but expected Y",
        };
      }
      if (mergingBase !== null) {
        mergedLocally.add(mergingBase); // now an ancestor of LOCAL default
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (joined === "update-index -q --really-refresh") {
      // The stat-cache settle immediately before the two-tree catch-up read-tree.
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "read-tree") {
      // Decision-B stale-aware catch-up of the on-default shared checkout. Best-effort —
      // a colliding-edit abort (non-zero) never changes the merge outcome.
      return (state.readTreeAbortAt?.has(cwd) ?? false)
        ? {
            code: 128,
            stdout: "",
            stderr: "error: Entry 'foo.ts' not uptodate. Cannot merge.",
          }
        : { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "push") {
      // (`push --dry-run` is matched earlier.) Covers BOTH the bare merge-path
      // push and the branch-explicit re-push (`push origin <default>`).
      if (state.pushTimeout) {
        return { code: GIT_SPAWN_TIMEOUT_CODE, stdout: "", stderr: "" };
      }
      if (state.pushFails) {
        return { code: 1, stdout: "", stderr: "remote rejected\n" };
      }
      // A successful push advances origin/<default> to local default — origin now
      // contains every ancestor of local default — UNLESS the test models the
      // "exit 0 but origin didn't move" pathology, which keeps origin stranded so
      // the post-push containment recheck fires.
      if (!state.pushUnconfirmed) {
        state.originUnresolved = false;
        const origin = state.originAncestors ?? new Set<string>();
        for (const a of state.ancestors ?? []) {
          origin.add(a);
        }
        for (const a of mergedLocally) {
          origin.add(a); // a freshly-merged base the push just advanced onto origin
        }
        state.originAncestors = origin;
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls, lock };
}

test("fn-959.7 recoverWorktrees: interrupted MERGE_HEAD in a lane → abort + prune", async () => {
  const lane = "/repo.worktrees/keeper-epic-fn-1-foo-B";
  const { run, calls } = makeRecoveryGit({
    worktreeList: `worktree /repo\nHEAD x\nbranch refs/heads/main\n\nworktree ${lane}\nHEAD y\nbranch refs/heads/keeper/epic/fn-1-foo--fn-1-foo.2\n\n`,
    mergeHeadAt: new Set([lane]),
    epicBases: [], // no done-but-unmerged work in this scenario
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
  );
  expect(failures).toEqual([]);
  // The lane's stale merge was aborted, and the repo's worktrees pruned once.
  expect(calls.some((c) => c.cwd === lane && c.args === "merge --abort")).toBe(
    true,
  );
  expect(
    calls.some((c) => c.cwd === "/repo" && c.args.startsWith("worktree prune")),
  ).toBe(true);
});

test("fn-959.7 recoverWorktrees: no MERGE_HEAD → no abort, no prune", async () => {
  const lane = "/repo.worktrees/keeper-epic-fn-1-foo-B";
  const { run, calls } = makeRecoveryGit({
    worktreeList: `worktree /repo\nHEAD x\nbranch refs/heads/main\n\nworktree ${lane}\nHEAD y\nbranch refs/heads/keeper/epic/fn-1-foo--fn-1-foo.2\n\n`,
    mergeHeadAt: new Set(), // clean
    epicBases: [],
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
  );
  expect(failures).toEqual([]);
  expect(calls.some((c) => c.args === "merge --abort")).toBe(false);
  expect(calls.some((c) => c.args.startsWith("worktree prune"))).toBe(false);
});

test("fn-1123.2 recoverWorktrees: re-probes each keeper lane's base readiness — a not-ready lane surfaces as a graced wedge, keyed by lane path", async () => {
  // The lane's HEAD is on `main` (the fake's global branch), not its lane branch —
  // an off-branch base a fan-in would abort on. The recover pass re-probes it AFTER
  // the mutating passes and surfaces it as a per-lane WEDGE observation (keyed by the
  // lane PATH), so the escalation/clear rides the recover pass rather than a dispatch.
  const lane = "/repo.worktrees/keeper-epic-fn-1-foo-B";
  const { run } = makeRecoveryGit({
    worktreeList: `worktree /repo\nHEAD x\nbranch refs/heads/main\n\nworktree ${lane}\nHEAD y\nbranch refs/heads/keeper/epic/fn-1-foo--fn-1-foo.2\n\n`,
    mergeHeadAt: new Set(), // clean — the probe classifies off-branch, not mid-merge
    epicBases: [],
  });
  const outcome = await recoverWorktrees(["/repo"], async () => false, run);
  // The outcome now carries the lane arms. The keeper lane is off-branch → a GRACED
  // wedge (not immediate — that is reserved for a hard abort-failed mid-merge).
  expect(outcome.laneWedged?.map((w) => w.path)).toEqual([lane]);
  expect(outcome.laneWedged?.[0]?.immediate).toBe(false);
  expect(outcome.laneWedged?.[0]?.reason.startsWith("off-branch")).toBe(true);
  // The standalone /repo is not a keeper lane → never a lane observation.
  expect(outcome.laneResolved ?? []).not.toContain("/repo");
});

test("recoverWorktrees: a healthy lane ON its own branch classifies resolved, never off-branch — the porcelain branch ref is refs/heads/-prefixed while abbrev-ref HEAD is short", async () => {
  // The worktree-list porcelain carries the FULL ref (refs/heads/keeper/epic/…)
  // while `rev-parse --abbrev-ref HEAD` answers the SHORT name; the readiness
  // probe must compare shorts. A clean lane sitting on its own branch lands in
  // laneResolved (the positive evidence that level-clears an open wedge row).
  const lane = "/repo.worktrees/keeper-epic-fn-1-foo-B";
  const { run } = makeRecoveryGit({
    worktreeList: `worktree /repo\nHEAD x\nbranch refs/heads/main\n\nworktree ${lane}\nHEAD y\nbranch refs/heads/keeper/epic/fn-1-foo--fn-1-foo.2\n\n`,
    mergeHeadAt: new Set(),
    headAt: new Map([[lane, "keeper/epic/fn-1-foo--fn-1-foo.2"]]),
    epicBases: [],
  });
  const outcome = await recoverWorktrees(["/repo"], async () => false, run);
  expect(outcome.laneWedged ?? []).toEqual([]);
  expect(outcome.laneResolved ?? []).toContain(lane);
});

test("fn-1123.2 recoverWorktrees: a hard abort-failed lane mid-merge surfaces as an IMMEDIATE wedge", async () => {
  // The lane is mid-merge AND its guarded abort keeps failing — git cannot clear it.
  // Pass-1 records its own abort failure; the lane readiness re-probe then sees the
  // surviving MERGE_HEAD and surfaces an IMMEDIATE (un-graced) wedge for the distress.
  const lane = "/repo.worktrees/keeper-epic-fn-1-foo-B";
  const { run } = makeRecoveryGit({
    worktreeList: `worktree /repo\nHEAD x\nbranch refs/heads/main\n\nworktree ${lane}\nHEAD y\nbranch refs/heads/keeper/epic/fn-1-foo--fn-1-foo.2\n\n`,
    mergeHeadAt: new Set([lane]),
    abortFailsAt: new Set([lane]), // the guarded abort fails → residue survives
    epicBases: [],
  });
  const outcome = await recoverWorktrees(["/repo"], async () => false, run);
  const laneObs = outcome.laneWedged?.find((w) => w.path === lane);
  expect(laneObs).toBeDefined();
  expect(laneObs?.immediate).toBe(true);
  expect(laneObs?.reason.startsWith("abort-failed")).toBe(true);
});

test("fn-972 BUG 4 recoverWorktrees: pass-1 skips a non-keeper `.claude/worktrees` lane, still recovers the keeper lane", async () => {
  // Pass-1 enumerates ALL registered linked worktrees; a FOREIGN lane (another
  // tool's `.claude/worktrees/<name>` on a non-`keeper/epic/*` branch) is never
  // keeper's to abort-merge, and if its dir vanished the `git` spawn against that
  // cwd would ENOENT. Filter to keeper lanes: touch the keeper lane, never the
  // foreign one.
  const keeperLane = "/repo.worktrees/keeper-epic-fn-1-foo";
  const foreignLane = "/home/me/proj/.claude/worktrees/some-feature";
  const { run, calls } = makeRecoveryGit({
    worktreeList:
      "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
      `worktree ${keeperLane}\nHEAD y\nbranch refs/heads/keeper/epic/fn-1-foo\n\n` +
      `worktree ${foreignLane}\nHEAD z\nbranch refs/heads/some-feature\n\n`,
    mergeHeadAt: new Set([keeperLane, foreignLane]), // both carry a stale MERGE_HEAD
    epicBases: [], // no pass-2 work
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
  );
  expect(failures).toEqual([]);
  // The keeper lane's interrupted merge WAS aborted (keeper lanes still recover).
  expect(
    calls.some((c) => c.cwd === keeperLane && c.args === "merge --abort"),
  ).toBe(true);
  // The foreign lane was NEVER touched — zero git spawns against its cwd, so a
  // vanished foreign dir can't ENOENT the recovery sweep.
  expect(calls.some((c) => c.cwd === foreignLane)).toBe(false);
});

test("fn-1095 recoverWorktrees: pass-1 SKIPS the abort for a lane whose epic has a LIVE resolver (scoped exclusion, no global pause)", async () => {
  // An autonomous merge-resolver (`resolve::fn-1-foo`) is mid-`git merge` in the
  // epic's base worktree — MERGE_HEAD is set BY DESIGN, not by a crash. Recover
  // must NOT abort it (that would race the resolver out from under its own
  // resolution). `hasActiveResolver(epicId)` scopes the exclusion to THIS epic —
  // the per-epic replacement for the resolver's old global `keeper autopilot pause`.
  const resolvingLane = "/repo.worktrees/keeper-epic-fn-1-foo";
  const idleLane = "/repo.worktrees/keeper-epic-fn-2-bar";
  const { run, calls } = makeRecoveryGit({
    worktreeList:
      "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
      `worktree ${resolvingLane}\nHEAD y\nbranch refs/heads/keeper/epic/fn-1-foo\n\n` +
      `worktree ${idleLane}\nHEAD z\nbranch refs/heads/keeper/epic/fn-2-bar\n\n`,
    mergeHeadAt: new Set([resolvingLane, idleLane]), // both carry a MERGE_HEAD
    epicBases: [],
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
    undefined,
    undefined,
    (epicId) => epicId === "fn-1-foo", // ONLY fn-1-foo has a live resolver
  );
  expect(failures).toEqual([]);
  // The resolver's lane was left ALONE — no abort raced its in-progress merge.
  expect(
    calls.some((c) => c.cwd === resolvingLane && c.args === "merge --abort"),
  ).toBe(false);
  // Every OTHER epic still recovers normally — the exclusion is per-epic, not global.
  expect(
    calls.some((c) => c.cwd === idleLane && c.args === "merge --abort"),
  ).toBe(true);
});

test("fn-1095 recoverWorktrees: pass-1 recovers a crashed resolver's lane once its resolver is NO LONGER live (auto-lift, no durable pause)", async () => {
  // The crash edge: a resolver that died mid-merge leaves a real stale MERGE_HEAD.
  // Its `resolve::<epic>` job has reaped, so `hasActiveResolver` reports false and
  // recover reclaims the lane — the exclusion auto-lifts, so a dead resolver
  // strands NOTHING (no durable board-wide pause). Default predicate = no resolver.
  const lane = "/repo.worktrees/keeper-epic-fn-1-foo";
  const { run, calls } = makeRecoveryGit({
    worktreeList:
      "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
      `worktree ${lane}\nHEAD y\nbranch refs/heads/keeper/epic/fn-1-foo\n\n`,
    mergeHeadAt: new Set([lane]),
    epicBases: [],
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
  );
  expect(failures).toEqual([]);
  expect(calls.some((c) => c.cwd === lane && c.args === "merge --abort")).toBe(
    true,
  );
});

test("fn-1114 recoverWorktrees: a keeper-owned mid-merge in the SHARED MAIN checkout is aborted (flock-guarded) EXACTLY ONCE, then pass-2 merges from a clean tree (incident reproduction)", async () => {
  // The incident: a keeper base→default merge conflicted and left the human's
  // shared MAIN checkout mid-merge (MERGE_HEAD + unresolved paths). The lane loop
  // never sees it (the main worktree is on `main`, not a `keeper/epic/*` lane), so
  // it wedged: finalize/recover skip-retried the folded-in "dirty" forever. Now the
  // main checkout gets its own guarded, keeper-owned abort → pass-2 re-derives clean.
  const base = "keeper/epic/fn-1-foo";
  const { run, calls, lock } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(["/repo"]), // the MAIN checkout is wedged mid-merge
    pointsAtBranches: new Map([["/repo", [`refs/heads/${base}`]]]), // MERGE_HEAD is a keeper base → keeper-owned
    epicBases: [base],
    defaultBranch: "main",
    ancestors: new Set(), // base not yet merged
    repoHead: "main",
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async (id) => id === "fn-1-foo", // epic is done
    run,
    lock,
  );
  expect(failures).toEqual([]);
  // The wedge was aborted EXACTLY ONCE in the main checkout...
  const aborts = calls.filter(
    (c) => c.cwd === "/repo" && c.args === "merge --abort",
  );
  expect(aborts).toHaveLength(1);
  // ...under the commit-work flock (the lock path is keyed on the checkout's git dir).
  expect(
    calls.some(
      (c) =>
        c.cwd === "/repo" &&
        c.args === "rev-parse --path-format=absolute --git-dir",
    ),
  ).toBe(true);
  // ...then pass-2 re-derived the base merge from the now-clean tree, via the
  // working-tree-free plumbing (a CAS ref advance), never a `git merge`.
  expect(
    calls.some(
      (c) =>
        c.cwd === "/repo" &&
        c.args.startsWith("update-ref --end-of-options refs/heads/main"),
    ),
  ).toBe(true);
  expect(calls.some((c) => c.args === `merge --no-edit ${base}`)).toBe(false);
});

test("fn-1114 recoverWorktrees: a FOREIGN mid-merge in the main checkout is NEVER aborted; the reason names owner + MERGE_HEAD (not dirty-checkout), inside the recover prefix", async () => {
  const { run, calls } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(["/repo"]),
    pointsAtBranches: new Map([["/repo", ["refs/heads/feature/human-wip"]]]), // a foreign branch at MERGE_HEAD
    epicBases: [],
    defaultBranch: "main",
    repoHead: "main",
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
  );
  // A human's own merge is not keeper's to touch — never aborted.
  expect(calls.some((c) => c.args === "merge --abort")).toBe(false);
  expect(failures).toHaveLength(1);
  expect(failures[0]?.reason).toContain("worktree-recover-mid-merge");
  expect(failures[0]?.reason).toContain("owner=foreign");
  expect(failures[0]?.reason).toContain("MERGE_HEAD=head");
  expect(failures[0]?.reason).not.toContain("dirty-checkout");
  // Inside the recover prefix so the level-triggered clear releases it on recovery.
  expect(isWorktreeRecoverReason(failures[0]?.reason ?? "")).toBe(true);
});

test("fn-1114 recoverWorktrees: a keeper-branch mid-merge WITH a MERGE_AUTOSTASH refuses ownership → never aborted (an abort could lose the stashed work)", async () => {
  const base = "keeper/epic/fn-1-foo";
  const { run, calls } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(["/repo"]),
    pointsAtBranches: new Map([["/repo", [`refs/heads/${base}`]]]), // a keeper base...
    autostashAt: new Set(["/repo"]), // ...but a MERGE_AUTOSTASH is present → foreign-shaped
    epicBases: [],
    defaultBranch: "main",
    repoHead: "main",
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
  );
  expect(calls.some((c) => c.args === "merge --abort")).toBe(false);
  expect(failures).toHaveLength(1);
  expect(failures[0]?.reason).toContain("worktree-recover-mid-merge");
  expect(failures[0]?.reason).toContain("owner=foreign");
  expect(failures[0]?.reason).toContain("autostash=true");
});

test("fn-1114 recoverWorktrees: a keeper-owned main mid-merge is NOT aborted while the owning epic has a LIVE resolver (scoped exclusion, silent skip)", async () => {
  // The main-checkout wedge and a `resolve::<epic>` worker share the epic that owns
  // the MERGE_HEAD base; racing an abort under a live resolver would destroy its
  // in-progress resolution. Derive the owning epic from the branch-set at MERGE_HEAD
  // and honor the SAME per-epic exclusion the lane loop uses — no failure minted.
  const base = "keeper/epic/fn-1-foo";
  const { run, calls, lock } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(["/repo"]),
    pointsAtBranches: new Map([["/repo", [`refs/heads/${base}`]]]),
    epicBases: [],
    defaultBranch: "main",
    repoHead: "main",
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
    lock,
    undefined,
    (epicId) => epicId === "fn-1-foo", // the owning epic's resolver is live
  );
  expect(
    calls.some((c) => c.cwd === "/repo" && c.args === "merge --abort"),
  ).toBe(false);
  expect(failures).toEqual([]); // silent skip — the resolver is actively working it
});

test("fn-1115 recoverWorktrees: an INCONCLUSIVE owning-epic probe (for-each-ref exit 1) defers instead of aborting — an unknown resolver state is never a licence to abort", async () => {
  // The fail-safe gap: a keeper-owned mid-merge whose owning-epic derivation
  // `for-each-ref ... refs/heads/keeper/epic/` fails (spawn failure / timeout). The
  // resolver-exclusion guard cannot see whether a live `resolve::<epic>` worker owns
  // the merge, so aborting would race (and destroy) an in-progress resolution. Defer.
  const base = "keeper/epic/fn-1-foo";
  const { run, calls, lock } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(["/repo"]),
    pointsAtBranches: new Map([["/repo", [`refs/heads/${base}`]]]), // readiness ⇒ keeper-owned
    owningEpicProbeFailAt: new Map([["/repo", 1]]), // ...but the owning-epic derivation fails
    epicBases: [],
    defaultBranch: "main",
    repoHead: "main",
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false, // even with NO known resolver, an inconclusive probe still defers
    run,
    lock,
    undefined,
    () => false,
  );
  // No abort raced a possible live resolver.
  expect(
    calls.some((c) => c.cwd === "/repo" && c.args === "merge --abort"),
  ).toBe(false);
  // A defer failure was minted (epicId null, dir /repo) naming the inconclusive probe,
  // inside the recover prefix so the level-clear releases it once the probe resolves.
  expect(failures).toHaveLength(1);
  expect(failures[0]?.epicId).toBeNull();
  expect(failures[0]?.dir).toBe("/repo");
  expect(failures[0]?.reason).toContain("worktree-recover-mid-merge");
  expect(failures[0]?.reason).toContain("inconclusive owning-epic probe");
  expect(failures[0]?.reason).toContain("failed exit 1");
  expect(isWorktreeRecoverReason(failures[0]?.reason ?? "")).toBe(true);
});

test("fn-1115 recoverWorktrees: a TIMED-OUT owning-epic probe (for-each-ref exit 124) defers with a timeout-worded reason, no abort", async () => {
  const base = "keeper/epic/fn-1-foo";
  const { run, calls, lock } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(["/repo"]),
    pointsAtBranches: new Map([["/repo", [`refs/heads/${base}`]]]),
    owningEpicProbeFailAt: new Map([["/repo", GIT_SPAWN_TIMEOUT_CODE]]), // 124 SIGKILL sentinel
    epicBases: [],
    defaultBranch: "main",
    repoHead: "main",
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
    lock,
    undefined,
    () => false,
  );
  expect(
    calls.some((c) => c.cwd === "/repo" && c.args === "merge --abort"),
  ).toBe(false);
  expect(failures).toHaveLength(1);
  expect(failures[0]?.reason).toContain("inconclusive owning-epic probe");
  expect(failures[0]?.reason).toContain("timed out");
});

test("fn-1115 recoverWorktrees: a resolver-free keeper-owned wedge with a SUCCEEDING empty owning-epic probe still self-heals (no regression to the clean abort path)", async () => {
  // The distinguishing guard: a CLEAN empty result (code 0, no owning epic) is not a
  // deferral — a genuinely resolver-free wedge must still abort-and-recover. Only a
  // NON-zero probe defers. MERGE_HEAD points at a non-keeper-epic branch so the
  // owning-epic derivation is legitimately empty while readiness stays keeper-owned.
  const base = "keeper/epic/fn-1-foo";
  const { run, calls, lock } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(["/repo"]),
    pointsAtBranches: new Map([["/repo", [`refs/heads/${base}`]]]),
    // owningEpicProbeFailAt unset ⇒ the derivation returns code 0; base yields fn-1-foo,
    // which has NO live resolver, so the clean abort path runs.
    epicBases: [base],
    defaultBranch: "main",
    ancestors: new Set(),
    repoHead: "main",
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async (id) => id === "fn-1-foo",
    run,
    lock,
    undefined,
    () => false, // no live resolver
  );
  expect(failures).toEqual([]);
  expect(
    calls.filter((c) => c.cwd === "/repo" && c.args === "merge --abort"),
  ).toHaveLength(1);
});

test("fn-1114 recoverWorktrees: a FAILED guarded abort of the main-checkout wedge surfaces its own worktree-recover-abort-failed reason (telemetry, not vanishing)", async () => {
  const base = "keeper/epic/fn-1-foo";
  const { run, calls, lock } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(["/repo"]),
    pointsAtBranches: new Map([["/repo", [`refs/heads/${base}`]]]),
    abortFailsAt: new Set(["/repo"]), // the guarded abort itself fails → residue not cleared
    epicBases: [],
    defaultBranch: "main",
    repoHead: "main",
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
    lock,
  );
  // The abort WAS attempted (keeper-owned) but did not clear the residue.
  expect(
    calls.some((c) => c.cwd === "/repo" && c.args === "merge --abort"),
  ).toBe(true);
  expect(failures).toHaveLength(1);
  expect(failures[0]?.reason).toContain("worktree-recover-abort-failed");
  expect(failures[0]?.reason).toContain("MERGE_HEAD=head");
  expect(isWorktreeRecoverReason(failures[0]?.reason ?? "")).toBe(true);
});

test("fn-1114 recoverWorktrees: a lock-timeout acquiring the flock for the main-checkout abort degrades to a defer (no blind abort)", async () => {
  const base = "keeper/epic/fn-1-foo";
  const { run, calls } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(["/repo"]),
    pointsAtBranches: new Map([["/repo", [`refs/heads/${base}`]]]),
    epicBases: [],
    defaultBranch: "main",
    repoHead: "main",
  });
  // A bounded acquirer that TIMES OUT (returns null) — the abort must never run.
  const timedOutLock: NonNullable<
    Parameters<typeof recoverWorktrees>[3]
  > = () => null;
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
    timedOutLock,
  );
  expect(calls.some((c) => c.args === "merge --abort")).toBe(false);
  expect(failures).toHaveLength(1);
  expect(failures[0]?.reason).toContain("worktree-recover-lock-timeout");
});

test("fn-1193 recoverWorktrees: a keeper-owned main mid-merge with ONLY the merge's OWN paths staged (auto-merged / resolved-then-staged) still aborts — no foreign work to preserve", async () => {
  // Under the abort flock the pass probes the staged set vs the merge's own set
  // (`git diff HEAD MERGE_HEAD`). Every staged path here IS the merge's own — a
  // resolved-then-staged conflict file and an auto-merged file — so there is no
  // concurrent commit's work to lose: the abort proceeds exactly as before.
  const base = "keeper/epic/fn-1-foo";
  const { run, calls, lock } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(["/repo"]),
    pointsAtBranches: new Map([["/repo", [`refs/heads/${base}`]]]),
    stagedPaths: new Map([["/repo", ["src/resolved.ts", "src/auto.ts"]]]),
    mergeTouchedPaths: new Map([["/repo", ["src/resolved.ts", "src/auto.ts"]]]),
    epicBases: [], // keep pass-2 a no-op; this case is only about the abort gate
    defaultBranch: "main",
    repoHead: "main",
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
    lock,
    undefined,
    () => false,
  );
  expect(failures).toEqual([]);
  expect(
    calls.filter((c) => c.cwd === "/repo" && c.args === "merge --abort"),
  ).toHaveLength(1);
});

test("fn-1193 recoverWorktrees: a keeper-owned main mid-merge with a FOREIGN staged path DEFERS the abort with a distinct worktree-recover-staged-foreign reason (the id-reservation incident: never destroy a concurrent commit's staged work)", async () => {
  const base = "keeper/epic/fn-1-foo";
  const { run, calls, lock } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(["/repo"]),
    pointsAtBranches: new Map([["/repo", [`refs/heads/${base}`]]]),
    // A concurrent `keeper plan` mint staged its pathspec file; the merge itself never
    // touched it, so it is FOREIGN — a git merge --abort would wipe it.
    stagedPaths: new Map([
      ["/repo", ["src/resolved.ts", ".keeper/epics/fn-42-x.json"]],
    ]),
    mergeTouchedPaths: new Map([["/repo", ["src/resolved.ts"]]]),
    epicBases: [],
    defaultBranch: "main",
    repoHead: "main",
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
    lock,
    undefined,
    () => false,
  );
  // The abort was DEFERRED — never run — so the foreign staged file survives.
  expect(
    calls.some((c) => c.cwd === "/repo" && c.args === "merge --abort"),
  ).toBe(false);
  expect(failures).toHaveLength(1);
  expect(failures[0]?.epicId).toBeNull();
  expect(failures[0]?.dir).toBe("/repo");
  expect(failures[0]?.reason).toContain("worktree-recover-staged-foreign");
  expect(failures[0]?.reason).toContain(".keeper/epics/fn-42-x.json");
  // Distinct from the existing mid-merge / lock-timeout / abort-failed defer reasons.
  expect(failures[0]?.reason).not.toContain("worktree-recover-mid-merge");
  expect(failures[0]?.reason).not.toContain("worktree-recover-lock-timeout");
  // Inside the recover prefix so the level-clear releases it once the staged work goes.
  expect(isWorktreeRecoverReason(failures[0]?.reason ?? "")).toBe(true);
});

test("fn-1193 recoverWorktrees: once the FOREIGN staged path is unstaged, the next cycle aborts and the recover row level-clears (positive-evidence, never a stuck wedge)", async () => {
  const base = "keeper/epic/fn-1-foo";
  // ONE mutable state so cycle 1 (foreign present, defer — no abort, MERGE_HEAD stays)
  // and cycle 2 (foreign unstaged, abort proceeds) share the same checkout.
  const state = {
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(["/repo"]),
    pointsAtBranches: new Map([["/repo", [`refs/heads/${base}`]]]),
    stagedPaths: new Map([
      ["/repo", ["src/resolved.ts", ".keeper/epics/fn-42-x.json"]],
    ]),
    mergeTouchedPaths: new Map([["/repo", ["src/resolved.ts"]]]),
    epicBases: [] as string[],
    defaultBranch: "main",
    repoHead: "main",
  };
  const { run, calls, lock } = makeRecoveryGit(state);
  // Cycle 1: foreign staged → defer, no abort.
  const c1 = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
    lock,
    undefined,
    () => false,
  );
  expect(
    calls.filter((c) => c.cwd === "/repo" && c.args === "merge --abort"),
  ).toHaveLength(0);
  const stagedForeign = c1.failures.find((f) =>
    f.reason.includes("worktree-recover-staged-foreign"),
  );
  expect(stagedForeign).toBeDefined();
  const openId = recoverFailureDispatchId(
    stagedForeign as WorktreeRecoveryFailure,
  );
  // The open row does NOT clear while the defer still fires (never-clear-what-fails).
  expect(
    recoverFailuresToClear(new Set([openId]), c1.failures, c1.resolved),
  ).toEqual([]);

  // Cycle 2: the concurrent commit landed / unstaged its file → abort proceeds.
  state.stagedPaths = new Map([["/repo", ["src/resolved.ts"]]]);
  const c2 = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
    lock,
    undefined,
    () => false,
  );
  expect(
    calls.filter((c) => c.cwd === "/repo" && c.args === "merge --abort"),
  ).toHaveLength(1);
  expect(
    c2.failures.some((f) =>
      f.reason.includes("worktree-recover-staged-foreign"),
    ),
  ).toBe(false);
  // Positive evidence emitted for the dir + no fresh failure → the row level-clears.
  expect(
    recoverFailuresToClear(new Set([openId]), c2.failures, c2.resolved),
  ).toEqual([openId]);
});

test("fn-1193 recoverWorktrees: an INCONCLUSIVE foreign-staged probe (git diff --cached fails) DEFERS the abort fail-safe — an unknown staged state is never a licence to destroy", async () => {
  const base = "keeper/epic/fn-1-foo";
  const { run, calls, lock } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(["/repo"]),
    pointsAtBranches: new Map([["/repo", [`refs/heads/${base}`]]]),
    stagedProbeFailAt: new Map([["/repo", 1]]), // the staged-set read fails
    epicBases: [],
    defaultBranch: "main",
    repoHead: "main",
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
    lock,
    undefined,
    () => false,
  );
  expect(
    calls.some((c) => c.cwd === "/repo" && c.args === "merge --abort"),
  ).toBe(false);
  expect(failures).toHaveLength(1);
  expect(failures[0]?.reason).toContain("worktree-recover-staged-probe");
  expect(isWorktreeRecoverReason(failures[0]?.reason ?? "")).toBe(true);
});

test("fn-1140 recoverWorktrees pass-2: a foreign main-checkout wedge NO LONGER blocks the DONE base merge — pass-2 advances it via plumbing (the decoupling), and the foreign wedge is never aborted", async () => {
  // Pre-decoupling, a foreign mid-merge folded into a dirty-checkout skip that
  // stranded the base merge forever. Now pass-2's working-tree-free plumbing advances
  // refs/heads/<default> regardless of the shared checkout's merge state; pass-1 still
  // refuses to touch the human's foreign merge (never aborts it).
  const base = "keeper/epic/fn-2-bar";
  const { run, calls, lock } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(["/repo"]),
    pointsAtBranches: new Map([["/repo", ["refs/heads/feature/human-wip"]]]), // foreign wedge
    epicBases: [base],
    defaultBranch: "main",
    ancestors: new Set(),
    repoHead: "main",
  });
  const { resolved } = await recoverWorktrees(
    ["/repo"],
    async (id) => id === "fn-2-bar", // done → pass-2 attempts the base merge
    run,
    lock,
  );
  // The human's foreign merge is never keeper's to abort.
  expect(calls.some((c) => c.args === "merge --abort")).toBe(false);
  // pass-2 advanced the base merge via plumbing despite the wedge (never a `git merge`).
  expect(
    calls.some((c) => c.args.startsWith("update-ref --end-of-options")),
  ).toBe(true);
  expect(calls.some((c) => c.args.startsWith("merge --no-edit"))).toBe(false);
  // The base merge landed → a positive resolution observation for the epic.
  expect(resolved.some((r) => r.epicId === "fn-2-bar")).toBe(true);
});

test("fn-959.7 recoverWorktrees: done-but-unmerged base → merge into default + push", async () => {
  const { run, calls, lock } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(),
    epicBases: ["keeper/epic/fn-1-foo"],
    defaultBranch: "main",
    ancestors: new Set(), // base is NOT yet merged
    repoHead: "main",
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async (id) => id === "fn-1-foo", // epic is done
    run,
    lock,
  );
  expect(failures).toEqual([]);
  // The base merged into default via the WORKING-TREE-FREE plumbing (a CAS ref
  // advance in the main checkout), never a `git merge` in the shared checkout.
  expect(
    calls.some(
      (c) =>
        c.cwd === "/repo" &&
        c.args.startsWith("update-ref --end-of-options refs/heads/main"),
    ),
  ).toBe(true);
  expect(calls.some((c) => c.args.startsWith("merge --no-edit"))).toBe(false);
  // The single recover push leg is branch-explicit (`push origin <default>`) and
  // fails fast on a credential-needing origin — GIT_TERMINAL_PROMPT=0 keeps git
  // from opening /dev/tty, and ssh BatchMode + ConnectTimeout keep an SSH stall
  // from hanging the reconcile cycle.
  const recoverPush = calls.find(
    (c) => c.cwd === "/repo" && c.args === "push origin main",
  );
  expect(recoverPush?.env).toEqual({
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10",
  });
});

test("fn-959.7 recoverWorktrees: already-merged base → idempotent skip (no merge, no push)", async () => {
  const { run, calls } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(),
    epicBases: ["keeper/epic/fn-1-foo"],
    defaultBranch: "main",
    ancestors: new Set(["keeper/epic/fn-1-foo"]), // already an ancestor of default
    repoHead: "main",
  });
  const { failures } = await recoverWorktrees(["/repo"], async () => true, run);
  expect(failures).toEqual([]);
  expect(calls.some((c) => c.args.startsWith("merge --no-edit"))).toBe(false);
  expect(calls.some((c) => c.args === "push")).toBe(false);
});

test("fn-988 recoverWorktrees pass-3: a merged orphan rib (worktree + branch) is pruned, is-ancestor-gated, bases-only merge", async () => {
  const rib = "keeper/epic/fn-1-foo--fn-1-foo.2";
  const ribPath = "/repo.worktrees/keeper-epic-fn-1-foo--fn-1-foo.2";
  const { run, calls } = makeRecoveryGit({
    worktreeList:
      "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
      `worktree ${ribPath}\nHEAD z\nbranch refs/heads/${rib}\n\n`,
    mergeHeadAt: new Set(),
    epicBases: [rib], // live git sees ONLY the orphan rib (its base already gone)
    defaultBranch: "main",
    ancestors: new Set([rib]), // the rib is fully merged → safe to prune
    repoHead: "main",
  });
  // The probe reports the rib's epic ABSENT (reaped) — eligible to sweep.
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
    undefined,
    async () => false,
  );
  expect(failures).toEqual([]);
  // The merge path is bases-only: a rib is NEVER merged to default.
  expect(calls.some((c) => c.args.startsWith("merge --no-edit"))).toBe(false);
  // Pass-3 tore the merged orphan rib down — worktree removed, then branch deleted,
  // never `git branch --contains`.
  expect(calls.some((c) => c.args === `worktree remove ${ribPath}`)).toBe(true);
  expect(calls.some((c) => c.args === `branch -D ${rib}`)).toBe(true);
  expect(calls.some((c) => c.args.includes("--contains"))).toBe(false);
});

test("fn-988 recoverWorktrees pass-3: an UNMERGED orphan rib is preserved (never force-deleted)", async () => {
  const rib = "keeper/epic/fn-1-foo--fn-1-foo.2";
  const ribPath = "/repo.worktrees/keeper-epic-fn-1-foo--fn-1-foo.2";
  const { run, calls } = makeRecoveryGit({
    worktreeList:
      "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
      `worktree ${ribPath}\nHEAD z\nbranch refs/heads/${rib}\n\n`,
    mergeHeadAt: new Set(),
    epicBases: [rib],
    defaultBranch: "main",
    ancestors: new Set(), // NOT an ancestor of default → unmerged work, leave it
    repoHead: "main",
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
  );
  expect(failures).toEqual([]);
  expect(calls.some((c) => c.args === `worktree remove ${ribPath}`)).toBe(
    false,
  );
  expect(calls.some((c) => c.args === `branch -D ${rib}`)).toBe(false);
});

test("fn-990 recoverWorktrees pass-3: a merged orphan base (worktree + branch) of an absent-or-done epic is torn down, is-ancestor-gated", async () => {
  // The orphan class found on disk this session: a done/reaped epic whose base
  // merged into default but whose base worktree + `keeper/epic/<id>` branch were
  // never swept (finalize no-op'd, recover pass-3 was ribs-only). Pass-3 reclaims
  // it once its epic is inactive (the probe reports ABSENT-or-done) AND it is
  // provably merged (an ancestor of default) — independent of whether THIS run
  // did the merge.
  const base = "keeper/epic/fn-1-foo";
  const basePath = "/repo.worktrees/keeper-epic-fn-1-foo";
  const { run, calls } = makeRecoveryGit({
    worktreeList:
      "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
      `worktree ${basePath}\nHEAD z\nbranch refs/heads/${base}\n\n`,
    mergeHeadAt: new Set(),
    epicBases: [base],
    defaultBranch: "main",
    ancestors: new Set([base]), // already merged → no pass-2 merge, safe to sweep
    repoHead: "main",
  });
  // The probe reports the epic ABSENT-or-done (reaped past the recent-done
  // window, or EpicDeleted); the is-ancestor gate proves the base merged → swept.
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
    undefined,
    async () => false,
  );
  expect(failures).toEqual([]);
  // No pass-2 merge (already an ancestor), but the base worktree + branch ARE
  // torn down: worktree removed, then branch deleted, never `--contains`.
  expect(calls.some((c) => c.args.startsWith("merge --no-edit"))).toBe(false);
  expect(calls.some((c) => c.args === `worktree remove ${basePath}`)).toBe(
    true,
  );
  expect(calls.some((c) => c.args === `branch -D ${base}`)).toBe(true);
  expect(calls.some((c) => c.args.includes("--contains"))).toBe(false);
});

test("fn-1227.1 recoverWorktrees pass-3: an OCCUPYING close/work job preserves its lane; a genuinely orphaned base is still swept (ADR 0031)", async () => {
  // The teardown seam of the incident: pass-3 sweeps a done/absent epic's merged
  // base, but a done epic whose CLOSER is still mid-turn INSIDE its lane must NOT
  // have its cwd torn out from under it (posix_spawn ENOENT → a `working` zombie).
  // The occupancy gate preserves the occupied lane while STILL reclaiming a genuine
  // orphan in the same repo — the same shared occupancy authority finalize gates on.
  const occupied = "keeper/epic/fn-1-live";
  const occupiedPath = "/repo.worktrees/keeper-epic-fn-1-live";
  const orphan = "keeper/epic/fn-2-dead";
  const orphanPath = "/repo.worktrees/keeper-epic-fn-2-dead";
  const { run, calls } = makeRecoveryGit({
    worktreeList:
      "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
      `worktree ${occupiedPath}\nHEAD y\nbranch refs/heads/${occupied}\n\n` +
      `worktree ${orphanPath}\nHEAD z\nbranch refs/heads/${orphan}\n\n`,
    mergeHeadAt: new Set(),
    epicBases: [occupied, orphan],
    defaultBranch: "main",
    ancestors: new Set([occupied, orphan]), // both merged → sweepable absent the gate
    repoHead: "main",
  });
  // Both epics report inactive (done/absent) so pass-3 WOULD sweep both — but the
  // occupancy gate reports fn-1-live still OCCUPIED (its closer is mid-turn).
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false, // pass-2 done-probe: neither base needs merging
    run,
    undefined,
    async () => false, // epicPresentAndNotDone: both inactive → not preserved here
    () => false, // hasActiveResolver: none
    undefined, // onResyncSkipped
    (epicId) => epicId === "fn-1-live", // epicHasOccupyingJob: only the live one
  );
  expect(failures).toEqual([]);
  // The OCCUPIED lane is PRESERVED — neither its worktree removed nor branch deleted.
  expect(calls.some((c) => c.args === `worktree remove ${occupiedPath}`)).toBe(
    false,
  );
  expect(calls.some((c) => c.args === `branch -D ${occupied}`)).toBe(false);
  // The genuinely ORPHANED lane is still SWEPT — worktree removed, then branch -D.
  expect(calls.some((c) => c.args === `worktree remove ${orphanPath}`)).toBe(
    true,
  );
  expect(calls.some((c) => c.args === `branch -D ${orphan}`)).toBe(true);
  // Never `--contains` (force-deletes siblings).
  expect(calls.some((c) => c.args.includes("--contains"))).toBe(false);
});

// fn-1050 — teardown sweeps a residue-only `.claude` husk dir git left behind.
// Real tmpdirs (fs in tests is fine); the git legs go through the fake runner.

test("fn-1050 recoverWorktrees pass-3: a residue-only husk is swept per-lane; a dirty lane's husk is left intact (no cross-lane suppression)", async () => {
  // Two merged, absent-epic base lanes in ONE repo. Lane A tears down clean → its
  // `.claude`-only husk dir is swept. Lane B's `worktree remove` refuses (dirty) →
  // its husk is left byte-untouched and a dirty row minted, WITHOUT suppressing
  // lane A's cleanup.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kpr-husk-recover-")));
  try {
    const huskA = join(dir, "wt-a");
    const huskB = join(dir, "wt-b");
    for (const h of [huskA, huskB]) {
      mkdirSync(join(h, ".claude"), { recursive: true });
      writeFileSync(join(h, ".claude", "settings.json"), "{}");
    }
    const brA = "keeper/epic/fn-a-foo";
    const brB = "keeper/epic/fn-b-bar";
    const { run, calls } = makeRecoveryGit({
      worktreeList:
        "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
        `worktree ${huskA}\nHEAD y\nbranch refs/heads/${brA}\n\n` +
        `worktree ${huskB}\nHEAD z\nbranch refs/heads/${brB}\n\n`,
      mergeHeadAt: new Set(),
      epicBases: [brA, brB],
      defaultBranch: "main",
      ancestors: new Set([brA, brB]), // both merged → safe to sweep
      repoHead: "main",
      dirtyRemoveAt: new Set([huskB]), // lane B refuses removal
    });
    const { failures } = await recoverWorktrees(
      ["/repo"],
      async () => false,
      run,
      undefined,
      async () => false,
    );
    // Lane A's husk was swept; lane B's is left intact (the helper is gated on the
    // clean-remove result, so it is never invoked on B's dirty outcome).
    expect(existsSync(huskA)).toBe(false);
    expect(existsSync(huskB)).toBe(true);
    // Exactly one failure — lane B's dirty teardown — and lane A still deleted.
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toContain(
      "worktree-recover-base-teardown-dirty",
    );
    expect(failures[0]?.reason).toContain(huskB);
    expect(calls.some((c) => c.args === `branch -D ${brA}`)).toBe(true);
    expect(calls.some((c) => c.args === `branch -D ${brB}`)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fn-1050 recoverWorktrees pass-3: a husk-prune throw is swallowed+logged, never minting a recover row (teardown already succeeded)", async () => {
  // The husk sweep hits an unexpected fs error (the lane path resolves THROUGH a
  // file → ENOTDIR on lstat). The call site swallows-and-logs it: NO failure row,
  // and teardown (already done) still deletes the merged branch.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kpr-husk-throw-")));
  try {
    writeFileSync(join(dir, "afile"), "not a dir");
    const badPath = join(dir, "afile", "sub"); // lstat → ENOTDIR (throws)
    const br = "keeper/epic/fn-1-foo";
    const { run, calls } = makeRecoveryGit({
      worktreeList:
        "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
        `worktree ${badPath}\nHEAD z\nbranch refs/heads/${br}\n\n`,
      mergeHeadAt: new Set(),
      epicBases: [br],
      defaultBranch: "main",
      ancestors: new Set([br]),
      repoHead: "main",
    });
    const { failures } = await recoverWorktrees(
      ["/repo"],
      async () => false,
      run,
      undefined,
      async () => false,
    );
    expect(failures).toEqual([]); // the throw minted no row
    expect(calls.some((c) => c.args === `branch -D ${br}`)).toBe(true); // teardown finished
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fn-1050 finalizeEpic teardown: a residue-only base husk is swept after a clean removal", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kpr-husk-finalize-")));
  try {
    const wt = join(dir, "keeper-epic-fn-1-foo");
    mkdirSync(join(wt, ".claude"), { recursive: true });
    writeFileSync(join(wt, ".claude", "settings.json"), "{}");
    const baseInfo = makeFinalizeInfo();
    const info: WorktreeLaunchInfo = {
      ...baseInfo,
      baseWorktreePath: wt,
      assignment: { ...baseInfo.assignment, worktreePath: wt },
    };
    const fakeRun: Parameters<typeof createWorktreeDriver>[0] = async (
      args,
    ) => {
      const joined = args.join(" ");
      if (isInProgressPseudoRefProbe(args)) {
        return { code: 1, stdout: "", stderr: "" }; // clean: in-progress pseudo-ref absent
      }
      if (args[0] === "rev-parse" && args.includes("--verify")) {
        return { code: 0, stdout: "abc\n", stderr: "" }; // base branch exists
      }
      if (joined.startsWith("symbolic-ref")) {
        return { code: 0, stdout: "origin/main\n", stderr: "" };
      }
      if (joined === "rev-parse --abbrev-ref HEAD") {
        return { code: 0, stdout: "main\n", stderr: "" };
      }
      if (joined.startsWith("merge-base --is-ancestor")) {
        return { code: 0, stdout: "", stderr: "" }; // not-ahead → straight to teardown
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const res = await createWorktreeDriver(fakeRun).finalizeEpic(
      info,
      async () => true,
    );
    expect(res).toEqual({ ok: true });
    expect(existsSync(wt)).toBe(false); // the base husk was swept
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // 30s scoped budget: a pure fakeRun git seam with no I/O loop — the ~12s worst case is event-loop starvation under parallel load, not work. Global --timeout=10000 stays the hang detector.
}, 30_000);

test("fn-990 recoverWorktrees pass-3: an UNMERGED orphan base is preserved (never force-deleted)", async () => {
  const base = "keeper/epic/fn-1-foo";
  const basePath = "/repo.worktrees/keeper-epic-fn-1-foo";
  const { run, calls } = makeRecoveryGit({
    worktreeList:
      "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
      `worktree ${basePath}\nHEAD z\nbranch refs/heads/${base}\n\n`,
    mergeHeadAt: new Set(),
    epicBases: [base],
    defaultBranch: "main",
    ancestors: new Set(), // NOT an ancestor → unmerged work, leave it for a human
    repoHead: "main",
  });
  // Open epic, base not merged: pass-2 skips (not done), pass-3 leaves it intact.
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
  );
  expect(failures).toEqual([]);
  expect(calls.some((c) => c.args === `worktree remove ${basePath}`)).toBe(
    false,
  );
  expect(calls.some((c) => c.args === `branch -D ${base}`)).toBe(false);
});

test("fn-993 recoverWorktrees pass-2: a lock-timeout acquirer (null) → worktree-recover-lock-timeout (a recover reason), NO push, NO teardown", async () => {
  // EDGE-2a recover side: a done-but-unmerged base whose bounded flock acquire
  // times out degrades to a TRANSIENT defer INSIDE the `worktree-recover-*` prefix
  // (the level-triggered auto-clear lifts it once the lock frees) — never a freeze,
  // never a teardown behind an un-landed merge.
  const base = "keeper/epic/fn-1-foo";
  const basePath = "/repo.worktrees/keeper-epic-fn-1-foo";
  const { run, calls } = makeRecoveryGit({
    worktreeList:
      "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
      `worktree ${basePath}\nHEAD z\nbranch refs/heads/${base}\n\n`,
    mergeHeadAt: new Set(),
    epicBases: [base],
    defaultBranch: "main",
    ancestors: new Set(), // base AHEAD → pass-2 attempts the merge
    repoHead: "main",
  });
  // Epic DONE → pass-2 merges; the injected acquirer TIMES OUT (null).
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => true,
    run,
    () => null,
  );
  expect(failures).toHaveLength(1);
  expect(failures[0]?.reason).toMatch(/^worktree-recover-lock-timeout:/);
  expect(isWorktreeRecoverReason(failures[0]?.reason ?? "")).toBe(true);
  expect(failures[0]?.epicId).toBe("fn-1-foo");
  // The merge never ran (lock not held), nothing REALLY pushed (the turn-key
  // `push --dry-run` probe is read-only), nothing torn down.
  expect(calls.some((c) => c.args.startsWith("merge --no-edit"))).toBe(false);
  expect(calls.some((c) => c.args.startsWith("push origin"))).toBe(false);
  expect(calls.some((c) => c.args === `worktree remove ${basePath}`)).toBe(
    false,
  );
});

test("fn-993 recoverWorktrees pass-2: a local merge timeout (124) → worktree-recover-local-timeout (a recover reason), NOT conflict, NO push", async () => {
  // EDGE-2b recover side: a blocking git hook times out the local merge spawn →
  // a TRANSIENT recover defer, never mistaken for a content conflict.
  const base = "keeper/epic/fn-1-foo";
  const basePath = "/repo.worktrees/keeper-epic-fn-1-foo";
  const { run, calls, lock } = makeRecoveryGit({
    worktreeList:
      "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
      `worktree ${basePath}\nHEAD z\nbranch refs/heads/${base}\n\n`,
    mergeHeadAt: new Set(),
    epicBases: [base],
    defaultBranch: "main",
    ancestors: new Set(), // base AHEAD → pass-2 attempts the merge
    repoHead: "main",
    mergeTimeout: true, // the `merge --no-edit` spawn times out
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => true,
    run,
    lock,
  );
  expect(failures).toHaveLength(1);
  expect(failures[0]?.reason).toMatch(/^worktree-recover-local-timeout:/);
  expect(isWorktreeRecoverReason(failures[0]?.reason ?? "")).toBe(true);
  expect(failures[0]?.reason).not.toContain("conflict");
  // A timed-out merge never advances origin behind it (read-only `push --dry-run`
  // may run; the real `push origin` must not).
  expect(calls.some((c) => c.args.startsWith("push origin"))).toBe(false);
});

test("fn-995 recoverWorktrees pass-2: a done base whose push exits 0 but origin stays stranded → worktree-recover-push-unconfirmed (a recover reason), NO silent swallow, NO teardown", async () => {
  // B1: pass-2's `switch (merge.kind)` had no `push-unconfirmed` case (the
  // merged + not-ahead arms now return it) and no default — so a stranded
  // post-push containment recheck fell through SILENTLY, recording no failure.
  // It must surface as a recover-side (auto-clearable) retry-skip.
  const base = "keeper/epic/fn-1-foo";
  const basePath = "/repo.worktrees/keeper-epic-fn-1-foo";
  const { run, calls, lock } = makeRecoveryGit({
    worktreeList:
      "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
      `worktree ${basePath}\nHEAD z\nbranch refs/heads/${base}\n\n`,
    mergeHeadAt: new Set(),
    epicBases: [base],
    defaultBranch: "main",
    ancestors: new Set(), // base AHEAD → pass-2 merges + pushes
    repoHead: "main",
    pushUnconfirmed: true, // push exits 0 but origin/<default> never advances
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => true,
    run,
    lock,
  );
  expect(failures).toHaveLength(1);
  expect(failures[0]?.reason).toMatch(/^worktree-recover-push-unconfirmed:/);
  expect(isWorktreeRecoverReason(failures[0]?.reason ?? "")).toBe(true);
  // The base is NOT torn down on an unconfirmed push.
  expect(calls.some((c) => c.args === `worktree remove ${basePath}`)).toBe(
    false,
  );
});

test("fn-990 recoverWorktrees pass-3: a dirty base teardown accumulates a failure and continues (never throws)", async () => {
  const base = "keeper/epic/fn-1-foo";
  const basePath = "/repo.worktrees/keeper-epic-fn-1-foo";
  const { run, calls } = makeRecoveryGit({
    worktreeList:
      "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
      `worktree ${basePath}\nHEAD z\nbranch refs/heads/${base}\n\n`,
    mergeHeadAt: new Set(),
    epicBases: [base],
    defaultBranch: "main",
    ancestors: new Set([base]), // merged → eligible for teardown
    repoHead: "main",
    dirtyRemoveAt: new Set([basePath]), // but the base worktree refuses (dirty)
  });
  // Probe reports the epic absent-or-done → the merged base reaches teardown.
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
    undefined,
    async () => false,
  );
  // Recover ACCUMULATES — a base-keyed failure, OUTSIDE the merge-skip family,
  // and the branch is NEVER deleted while its worktree is dirty.
  expect(failures).toEqual([
    {
      epicId: "fn-1-foo",
      reason: `worktree-recover-base-teardown-dirty: ${basePath} has uncommitted changes — contains modified or untracked files`,
      dir: "/repo",
    },
  ]);
  expect(calls.some((c) => c.args === `branch -D ${base}`)).toBe(false);
});

test("fn-991 recoverWorktrees pass-3: an OPEN epic's reflexive-ancestor base is PRESERVED (born at the default tip, no commits)", async () => {
  // A base is forked off the default tip and is-ancestor is reflexive, so an OPEN
  // epic's base IS an ancestor of default. The ancestry-only sweep destroyed it
  // mid-flight; the tri-state probe (epic present + not done) now preserves it.
  const base = "keeper/epic/fn-1-foo";
  const basePath = "/repo.worktrees/keeper-epic-fn-1-foo";
  const { run, calls } = makeRecoveryGit({
    worktreeList:
      "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
      `worktree ${basePath}\nHEAD z\nbranch refs/heads/${base}\n\n`,
    mergeHeadAt: new Set(),
    epicBases: [base],
    defaultBranch: "main",
    ancestors: new Set([base]), // reflexive ancestor of default (born at the tip)
    repoHead: "main",
  });
  // Probe reports the epic PRESENT and NOT done → its base is preserved despite
  // being a reflexive ancestor.
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
    undefined,
    async () => true,
  );
  expect(failures).toEqual([]);
  expect(calls.some((c) => c.args === `worktree remove ${basePath}`)).toBe(
    false,
  );
  expect(calls.some((c) => c.args === `branch -D ${base}`)).toBe(false);
});

test("fn-991 recoverWorktrees pass-3: an OPEN epic's clean fresh RIB at the default tip is PRESERVED", async () => {
  // The worker-boot window: a rib provisioned off the default tip before its first
  // commit is a reflexive ancestor too. The tri-state probe preserves it (the
  // accepted bounded leak — finalize reclaims it when the epic closes).
  const rib = "keeper/epic/fn-1-foo--fn-1-foo.2";
  const ribPath = "/repo.worktrees/keeper-epic-fn-1-foo--fn-1-foo.2";
  const { run, calls } = makeRecoveryGit({
    worktreeList:
      "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
      `worktree ${ribPath}\nHEAD z\nbranch refs/heads/${rib}\n\n`,
    mergeHeadAt: new Set(),
    epicBases: [rib],
    defaultBranch: "main",
    ancestors: new Set([rib]), // reflexive ancestor (no commits yet)
    repoHead: "main",
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
    undefined,
    async () => true, // epic present + not done
  );
  expect(failures).toEqual([]);
  expect(calls.some((c) => c.args === `worktree remove ${ribPath}`)).toBe(
    false,
  );
  expect(calls.some((c) => c.args === `branch -D ${rib}`)).toBe(false);
});

test("fn-991 recoverWorktrees pass-3: a base merged into LOCAL default but ABSENT from origin → RE-PUSH default, THEN tear down", async () => {
  // The second teardown seam (pass-3 sweeps WITHOUT mergeLaneBaseIntoDefault): a
  // base that is a local-default ancestor whose push timed out must be re-pushed
  // before its lane is reclaimed, or the merge is silently stranded off origin.
  const base = "keeper/epic/fn-1-foo";
  const basePath = "/repo.worktrees/keeper-epic-fn-1-foo";
  const { run, calls } = makeRecoveryGit({
    worktreeList:
      "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
      `worktree ${basePath}\nHEAD z\nbranch refs/heads/${base}\n\n`,
    mergeHeadAt: new Set(),
    epicBases: [base],
    defaultBranch: "main",
    ancestors: new Set([base]), // an ancestor of LOCAL default...
    originAncestors: new Set(), // ...but origin LACKS it (a push timed out last cycle)
    repoHead: "main",
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
    undefined,
    async () => false, // epic absent → eligible to sweep
  );
  expect(failures).toEqual([]);
  // Default re-pushed (branch-explicit) BEFORE teardown, then the lane reclaimed.
  expect(
    calls.some((c) => c.cwd === "/repo" && c.args === "push origin main"),
  ).toBe(true);
  expect(calls.some((c) => c.args === `worktree remove ${basePath}`)).toBe(
    true,
  );
  expect(calls.some((c) => c.args === `branch -D ${base}`)).toBe(true);
});

test("fn-991 recoverWorktrees pass-3: a base absent from origin whose RE-PUSH times out → DEFERRED, base NOT torn down, recover-side auto-clearable reason", async () => {
  const base = "keeper/epic/fn-1-foo";
  const basePath = "/repo.worktrees/keeper-epic-fn-1-foo";
  const { run, calls } = makeRecoveryGit({
    worktreeList:
      "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
      `worktree ${basePath}\nHEAD z\nbranch refs/heads/${base}\n\n`,
    mergeHeadAt: new Set(),
    epicBases: [base],
    defaultBranch: "main",
    ancestors: new Set([base]),
    originAncestors: new Set(), // origin lacks the merge
    repoHead: "main",
    pushTimeout: true, // the re-push spawn times out (a transient stall)
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
    undefined,
    async () => false,
  );
  expect(failures).toHaveLength(1);
  expect(failures[0]?.epicId).toBe("fn-1-foo");
  expect(failures[0]?.reason).toMatch(/^worktree-recover-base-push-timeout:/);
  expect(failures[0]?.dir).toBe("/repo");
  // The reason is INSIDE the level-triggered auto-clear scope → a transient defer,
  // never a sticky jam.
  expect(isWorktreeRecoverReason(failures[0]?.reason)).toBe(true);
  // DEFERRED — never torn down before the merge reaches origin.
  expect(calls.some((c) => c.args === `worktree remove ${basePath}`)).toBe(
    false,
  );
  expect(calls.some((c) => c.args === `branch -D ${base}`)).toBe(false);
});

test("fn-991 recoverWorktrees pass-3: a never-pushed default (UNRESOLVED origin ref) admits a FIRST push via turn-key, then tears down", async () => {
  // Origin/<default> never resolved → the FF precheck is "unknown" (defers to
  // turn-key, NOT a false non-FF skip) and the origin-containment probe reports
  // "origin lacks base" → the first push is admitted, then the lane is reclaimed.
  const base = "keeper/epic/fn-1-foo";
  const basePath = "/repo.worktrees/keeper-epic-fn-1-foo";
  const { run, calls } = makeRecoveryGit({
    worktreeList:
      "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
      `worktree ${basePath}\nHEAD z\nbranch refs/heads/${base}\n\n`,
    mergeHeadAt: new Set(),
    epicBases: [base],
    defaultBranch: "main",
    ancestors: new Set([base]),
    originUnresolved: true, // refs/remotes/origin/main does not resolve
    repoHead: "main",
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
    undefined,
    async () => false,
  );
  expect(failures).toEqual([]);
  // The "unknown" FF tri-state never minted a non-FF skip — the first push landed.
  expect(
    calls.some((c) => c.cwd === "/repo" && c.args === "push origin main"),
  ).toBe(true);
  expect(calls.some((c) => c.args === `worktree remove ${basePath}`)).toBe(
    true,
  );
  expect(calls.some((c) => c.args === `branch -D ${base}`)).toBe(true);
});

test("fn-991 recoverWorktrees pass-3: a base absent from origin with NO push target → DEFERRED (not-turn-key), base NOT torn down", async () => {
  const base = "keeper/epic/fn-1-foo";
  const basePath = "/repo.worktrees/keeper-epic-fn-1-foo";
  const { run, calls } = makeRecoveryGit({
    worktreeList:
      "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
      `worktree ${basePath}\nHEAD z\nbranch refs/heads/${base}\n\n`,
    mergeHeadAt: new Set(),
    epicBases: [base],
    defaultBranch: "main",
    ancestors: new Set([base]),
    originAncestors: new Set(), // origin lacks the merge
    repoHead: "main",
    noPushTarget: true, // @{push} does not resolve → not turn-key
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
    undefined,
    async () => false,
  );
  expect(failures).toHaveLength(1);
  expect(failures[0]?.reason).toMatch(
    /^worktree-recover-base-push-not-turn-key:/,
  );
  expect(isWorktreeRecoverReason(failures[0]?.reason)).toBe(true);
  // DEFERRED — never torn down, and never a sticky teardown-on-failure.
  expect(calls.some((c) => c.args === `worktree remove ${basePath}`)).toBe(
    false,
  );
  expect(calls.some((c) => c.args === `branch -D ${base}`)).toBe(false);
});

test("fn-992 recoverWorktrees pass-3: a base absent from origin while HEAD is OFF-default → DEFERRED (recover-side off-branch), NO push, base NOT torn down", async () => {
  // The second teardown seam reached with the shared checkout off the default
  // branch: pushDefaultToOrigin's HEAD-safety arm degrades to a recover-side
  // off-branch defer (INSIDE the auto-clear prefix) rather than a wrong-ref push.
  const base = "keeper/epic/fn-1-foo";
  const basePath = "/repo.worktrees/keeper-epic-fn-1-foo";
  const { run, calls } = makeRecoveryGit({
    worktreeList:
      "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
      `worktree ${basePath}\nHEAD z\nbranch refs/heads/${base}\n\n`,
    mergeHeadAt: new Set(),
    epicBases: [base],
    defaultBranch: "main",
    ancestors: new Set([base]), // ancestor of LOCAL default...
    originAncestors: new Set(), // ...but origin LACKS it
    repoHead: "feature", // the shared checkout HEAD is OFF the default branch
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
    undefined,
    async () => false,
  );
  expect(failures).toHaveLength(1);
  expect(failures[0]?.epicId).toBe("fn-1-foo");
  expect(failures[0]?.reason).toMatch(/^worktree-recover-base-off-branch:/);
  expect(isWorktreeRecoverReason(failures[0]?.reason)).toBe(true);
  // NO push of ANY form, and NEVER torn down behind a wrong-ref push.
  expect(calls.some((c) => c.cwd === "/repo" && c.args === "push")).toBe(false);
  expect(
    calls.some((c) => c.cwd === "/repo" && c.args.startsWith("push origin")),
  ).toBe(false);
  expect(calls.some((c) => c.args === `worktree remove ${basePath}`)).toBe(
    false,
  );
  expect(calls.some((c) => c.args === `branch -D ${base}`)).toBe(false);
});

test("fn-992 recoverWorktrees pass-3: a re-push that exits 0 but leaves origin un-advanced → DEFERRED (push-unconfirmed), base NOT torn down", async () => {
  // "Exit 0 but origin didn't move": the post-push containment recheck refuses
  // teardown until origin PROVABLY carries the lane — a recover-side defer.
  const base = "keeper/epic/fn-1-foo";
  const basePath = "/repo.worktrees/keeper-epic-fn-1-foo";
  const { run, calls } = makeRecoveryGit({
    worktreeList:
      "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
      `worktree ${basePath}\nHEAD z\nbranch refs/heads/${base}\n\n`,
    mergeHeadAt: new Set(),
    epicBases: [base],
    defaultBranch: "main",
    ancestors: new Set([base]),
    originAncestors: new Set(), // origin lacks the merge before AND after the push
    repoHead: "main",
    pushUnconfirmed: true, // push exits 0 but origin/<default> never advances
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
    undefined,
    async () => false,
  );
  expect(failures).toHaveLength(1);
  expect(failures[0]?.epicId).toBe("fn-1-foo");
  expect(failures[0]?.reason).toMatch(
    /^worktree-recover-base-push-unconfirmed:/,
  );
  expect(isWorktreeRecoverReason(failures[0]?.reason)).toBe(true);
  // The push DID run (branch-explicit) but the recheck refused teardown.
  expect(
    calls.some((c) => c.cwd === "/repo" && c.args === "push origin main"),
  ).toBe(true);
  expect(calls.some((c) => c.args === `worktree remove ${basePath}`)).toBe(
    false,
  );
  expect(calls.some((c) => c.args === `branch -D ${base}`)).toBe(false);
});

test("fn-959.7 recoverWorktrees: open (not-done) epic base → skipped, never merged", async () => {
  const { run, calls } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(),
    epicBases: ["keeper/epic/fn-1-foo"],
    defaultBranch: "main",
    ancestors: new Set(),
    repoHead: "main",
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false, // epic still open
    run,
  );
  expect(failures).toEqual([]);
  expect(calls.some((c) => c.args.startsWith("merge --no-edit"))).toBe(false);
});

test("fn-1119 recoverWorktrees pass-2: a backstop content conflict → an ESCALATION on the bare epic id (worktree-merge-conflict), NOT a transient failure, no push, no resolved observation", async () => {
  const { run, calls, lock } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(),
    epicBases: ["keeper/epic/fn-1-foo"],
    defaultBranch: "main",
    ancestors: new Set(),
    repoHead: "main",
    mergeConflict: true,
  });
  const { failures, escalations, resolved } = await recoverWorktrees(
    ["/repo"],
    async () => "done",
    run,
    lock,
  );
  // A content conflict is TERMINAL: it leaves the transient `failures` channel and
  // routes to `escalations` on the BARE epic id with finalize's close-sink reason.
  expect(failures).toEqual([]);
  expect(escalations).toHaveLength(1);
  expect(escalations[0]?.epicId).toBe("fn-1-foo");
  expect(escalations[0]?.dir).toBe("/repo");
  // The reason carries the EXACT `worktree-merge-conflict` leading token (the merge-
  // escalation gate), never a `worktree-recover-*` prefix (the auto-clear scope).
  expect(escalations[0]?.reason.startsWith("worktree-merge-conflict:")).toBe(
    true,
  );
  expect(escalations[0]?.reason).toContain(
    "merging keeper/epic/fn-1-foo into main",
  );
  expect(isWorktreeRecoverReason(escalations[0]?.reason ?? "")).toBe(false);
  // A conflict is NOT a positive resolution — the epic's per-(epic,repo) row (if any)
  // must NOT be cleared. Only the unconditional per-dir path-tied observation is here.
  expect(
    resolved.some((r) => r.epicId === "fn-1-foo" && r.dir === "/repo"),
  ).toBe(false);
  // No push on a conflict.
  expect(calls.some((c) => c.args === "push")).toBe(false);
});

test("fn-1119 recoverWorktrees pass-2: a done epic with a LIVE merge-resolver is NOT merge-attempted (gated skip, no observation, rows retained)", async () => {
  // A retargeted conflict dispatched a `resolve::fn-1-foo` worker for this now-done
  // epic; it is mid-`git merge`. Pass-2 must skip re-attempting the same base→default
  // merge (mirrors pass-1's abort gate) so it never races the resolver. The gated skip
  // yields no resolved observation, so an open recover row is retained for free.
  const { run, calls, lock } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(),
    epicBases: ["keeper/epic/fn-1-foo"],
    defaultBranch: "main",
    ancestors: new Set(), // base NOT yet merged — pass-2 WOULD merge if ungated
    repoHead: "main",
  });
  const { failures, escalations, resolved } = await recoverWorktrees(
    ["/repo"],
    async () => "done",
    run,
    lock,
    undefined,
    (epicId) => epicId === "fn-1-foo", // a live resolver owns fn-1-foo
  );
  expect(failures).toEqual([]);
  expect(escalations).toEqual([]);
  // No merge attempted for the resolver-owned base.
  expect(calls.some((c) => c.args.startsWith("merge --no-edit"))).toBe(false);
  // No positive resolution recorded for (fn-1-foo, /repo) — the row is retained.
  expect(
    resolved.some((r) => r.epicId === "fn-1-foo" && r.dir === "/repo"),
  ).toBe(false);
});

test("fn-1119 recoverWorktrees pass-2: an authoritatively-ABSENT epic → skip the merge AND record a positive resolved observation (reaped base clears its row)", async () => {
  const { run, calls, lock } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(),
    epicBases: ["keeper/epic/fn-1-foo"],
    defaultBranch: "main",
    ancestors: new Set(),
    repoHead: "main",
  });
  const { failures, escalations, resolved } = await recoverWorktrees(
    ["/repo"],
    async () => "absent", // the epic reads authoritatively absent (reaped)
    run,
    lock,
  );
  expect(failures).toEqual([]);
  expect(escalations).toEqual([]);
  // The absent epic no longer needs its base merged — no merge attempted.
  expect(calls.some((c) => c.args.startsWith("merge --no-edit"))).toBe(false);
  // A POSITIVE resolution observation is recorded so an open recover row clears.
  expect(
    resolved.some((r) => r.epicId === "fn-1-foo" && r.dir === "/repo"),
  ).toBe(true);
});

test("fn-1119 recoverWorktrees pass-2: an INCONCLUSIVE done-probe → DEFER (no merge, no observation, open rows retained)", async () => {
  const { run, calls, lock } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(),
    epicBases: ["keeper/epic/fn-1-foo"],
    defaultBranch: "main",
    ancestors: new Set(),
    repoHead: "main",
  });
  const { failures, escalations, resolved } = await recoverWorktrees(
    ["/repo"],
    async () => "inconclusive", // a non-result (error) read frame → defer
    run,
    lock,
  );
  expect(failures).toEqual([]);
  expect(escalations).toEqual([]);
  // DEFER: no merge attempt this cycle.
  expect(calls.some((c) => c.args.startsWith("merge --no-edit"))).toBe(false);
  // And NO positive observation — an open recover row for (fn-1-foo, /repo) is
  // retained (absence of a completed read is never a resolution).
  expect(
    resolved.some((r) => r.epicId === "fn-1-foo" && r.dir === "/repo"),
  ).toBe(false);
});

test("fn-1119-durable-recover-conflict-escalation incident reproduction: one epic's probe inconclusive while a sibling's conflict is re-reported → the first epic's open row is RETAINED, its base NOT merge-attempted, no clear", async () => {
  // The exact incident shape: a done epic's base conflict is re-reported (a sibling),
  // while THIS epic's done-probe returns a non-result frame the SAME sweep. The bug
  // was an absence-based clear turning the inconclusive epic's silently-skipped cycle
  // into a DispatchCleared. Now: the inconclusive epic defers (no merge, no
  // observation) and its open row is retained; the sibling escalates.
  const inconclusiveEpic = "fn-1119-A";
  const siblingEpic = "fn-1119-B";
  const { run, calls, lock } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(),
    epicBases: [
      `keeper/epic/${inconclusiveEpic}`,
      `keeper/epic/${siblingEpic}`,
    ],
    defaultBranch: "main",
    ancestors: new Set(),
    repoHead: "main",
    mergeConflict: true, // the sibling's base→default merge conflicts
  });
  const { failures, escalations, resolved } = await recoverWorktrees(
    ["/repo"],
    async (id) => (id === inconclusiveEpic ? "inconclusive" : "done"),
    run,
    lock,
  );
  // The sibling's conflict is re-reported as an escalation.
  expect(escalations.map((e) => e.epicId)).toEqual([siblingEpic]);
  expect(failures).toEqual([]);
  // The inconclusive epic's base was NEVER merge-attempted.
  expect(
    calls.some(
      (c) => c.args === `merge --no-edit keeper/epic/${inconclusiveEpic}`,
    ),
  ).toBe(false);
  // No positive resolution for the inconclusive epic — so an OPEN recover row for it
  // is RETAINED by the clear predicate (the fix's core guarantee).
  const inconclusiveKey = worktreeRecoverEpicDispatchId(
    inconclusiveEpic,
    "/repo",
  );
  expect(
    resolved.some((r) => r.epicId === inconclusiveEpic && r.dir === "/repo"),
  ).toBe(false);
  expect(
    recoverFailuresToClear(new Set([inconclusiveKey]), failures, resolved),
  ).toEqual([]);
});

test("fn-1140 recoverWorktrees: an OFF-DEFAULT main checkout still advances the base merge locally, but the off-branch push defers (worktree-recover-not-on-default, auto-clearing)", async () => {
  // The plumbing advances refs/heads/<default> regardless of the checkout branch
  // (the decoupling), but pushDefaultToOrigin refuses to push off the default branch
  // (@{push} would resolve the wrong upstream), so the push defers to a non-sticky
  // worktree-recover-not-on-default that auto-clears once the human returns to default.
  const { run, calls, lock } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/feature-x\n\n",
    mergeHeadAt: new Set(),
    epicBases: ["keeper/epic/fn-1-foo"],
    defaultBranch: "main",
    ancestors: new Set(),
    repoHead: "feature-x", // NOT on default
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => true,
    run,
    lock,
  );
  expect(failures).toHaveLength(1);
  expect(failures[0]?.reason).toContain("worktree-recover-not-on-default");
  expect(isWorktreeRecoverReason(failures[0]?.reason ?? "")).toBe(true);
  // The LOCAL ref advanced (the merge landed) even off-default — NEVER a working-tree merge.
  expect(
    calls.some((c) => c.args.startsWith("update-ref --end-of-options")),
  ).toBe(true);
  expect(calls.some((c) => c.args.startsWith("merge --no-edit"))).toBe(false);
});

test("fn-1140 recoverWorktrees: a DIRTY main checkout NO LONGER blocks the base merge — it lands via plumbing (the regression), catch-up aborts on the colliding edit", async () => {
  // The incident: a dirty shared checkout silently retry-skipped the base merge,
  // stranding a done epic unmerged. The working-tree-free plumbing merge lands
  // regardless of the checkout state; a colliding local edit aborts the stale-aware
  // catch-up all-or-nothing, leaving the checkout trailing but never blocking the merge.
  const { run, calls, lock } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(),
    epicBases: ["keeper/epic/fn-1-foo"],
    defaultBranch: "main",
    ancestors: new Set(),
    repoHead: "main", // on default…
    readTreeAbortAt: new Set(["/repo"]), // …with a colliding local edit → catch-up aborts
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => true,
    run,
    lock,
  );
  expect(failures).toEqual([]); // the merge LANDED — no dirty-checkout skip
  expect(
    calls.some((c) => c.args.startsWith("update-ref --end-of-options")),
  ).toBe(true);
  // The catch-up IS attempted (refresh + read-tree) and aborts all-or-nothing — never a
  // `reset --hard` clobbering WIP, and NEVER a working-tree `git merge`.
  expect(calls.some((c) => c.args === "update-index -q --really-refresh")).toBe(
    true,
  );
  expect(calls.some((c) => c.args.startsWith("read-tree -m -u"))).toBe(true);
  expect(calls.some((c) => c.args.startsWith("reset --hard"))).toBe(false);
  expect(calls.some((c) => c.args.startsWith("merge --no-edit"))).toBe(false);
});

test("fn-985 recoverWorktrees: a NON-FAST-FORWARD remote (origin ahead) → skip-and-retry, no merge/push/fetch", async () => {
  const { run, calls } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(),
    epicBases: ["keeper/epic/fn-1-foo"],
    defaultBranch: "main",
    ancestors: new Set(),
    repoHead: "main",
    remoteAhead: true, // origin moved ahead since the last fetch
  });
  const { failures } = await recoverWorktrees(["/repo"], async () => true, run);
  expect(failures).toHaveLength(1);
  expect(failures[0]?.epicId).toBe("fn-1-foo");
  expect(failures[0]?.reason).toContain("worktree-recover-non-fast-forward");
  expect(isWorktreeRecoverReason(failures[0]?.reason ?? "")).toBe(true);
  // No merge, no push, and emphatically no fetch on a shared checkout.
  expect(calls.some((c) => c.args.startsWith("merge --no-edit"))).toBe(false);
  expect(calls.some((c) => c.args === "push")).toBe(false);
  expect(calls.some((c) => c.args.startsWith("fetch"))).toBe(false);
});

test("fn-988 recoverWorktrees: a non-turn-key push (no @{push} target) → skip-retry, recover-prefixed (auto-clearable), no merge", async () => {
  const { run, calls } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(),
    epicBases: ["keeper/epic/fn-1-foo"],
    defaultBranch: "main",
    ancestors: new Set(),
    repoHead: "main",
    noPushTarget: true,
  });
  const { failures } = await recoverWorktrees(["/repo"], async () => true, run);
  expect(failures).toHaveLength(1);
  expect(failures[0]?.epicId).toBe("fn-1-foo");
  expect(failures[0]?.reason).toContain("worktree-recover-push-not-turn-key");
  // Recover-side KEEPS the prefix so the level-triggered auto-clear lifts it.
  expect(isWorktreeRecoverReason(failures[0]?.reason ?? "")).toBe(true);
  // The merge is skipped — never merge-then-die on the push.
  expect(calls.some((c) => c.args.startsWith("merge --no-edit"))).toBe(false);
  expect(calls.some((c) => c.args === "push")).toBe(false);
});

test("fn-988 recoverWorktrees: a non-turn-key push (dry-run rejected) → skip-retry, recover-prefixed, no merge", async () => {
  const { run, calls } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(),
    epicBases: ["keeper/epic/fn-1-foo"],
    defaultBranch: "main",
    ancestors: new Set(),
    repoHead: "main",
    dryRunReject: "fatal: could not read from remote repository",
  });
  const { failures } = await recoverWorktrees(["/repo"], async () => true, run);
  expect(failures).toHaveLength(1);
  expect(failures[0]?.reason).toContain("worktree-recover-push-not-turn-key");
  expect(failures[0]?.reason).toContain("network"); // classifyPushError reuse
  expect(isWorktreeRecoverReason(failures[0]?.reason ?? "")).toBe(true);
  expect(calls.some((c) => c.args.startsWith("merge --no-edit"))).toBe(false);
});

test("fn-959.7 recoverWorktrees: push failure on a recovered merge → keyed failure", async () => {
  const { run, lock } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(),
    epicBases: ["keeper/epic/fn-1-foo"],
    defaultBranch: "main",
    ancestors: new Set(),
    repoHead: "main",
    pushFails: true,
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => true,
    run,
    lock,
  );
  expect(failures).toHaveLength(1);
  expect(failures[0]?.epicId).toBe("fn-1-foo");
  expect(failures[0]?.reason).toContain("worktree-recover-push-failed");
});

test("fn-990 recoverWorktrees: a push TIMEOUT on a recovered merge → transient worktree-recover-push-timeout (auto-clearable), not push-failed", async () => {
  const { run, lock } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(),
    epicBases: ["keeper/epic/fn-1-foo"],
    defaultBranch: "main",
    ancestors: new Set(),
    repoHead: "main",
    pushTimeout: true,
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => true,
    run,
    lock,
  );
  expect(failures).toHaveLength(1);
  expect(failures[0]?.epicId).toBe("fn-1-foo");
  expect(failures[0]?.reason).toContain("worktree-recover-push-timeout");
  expect(failures[0]?.reason).not.toContain("push-failed");
  // The recover-side timeout stays INSIDE the auto-clear scope (level-triggered).
  expect(isWorktreeRecoverReason(failures[0]?.reason ?? "")).toBe(true);
});

test("fn-959.7 recoverWorktrees: rib branches are excluded from the base backstop", async () => {
  const { run, calls, lock } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(),
    // A rib (`--` separator) plus the base; only the base may merge to default.
    epicBases: ["keeper/epic/fn-1-foo", "keeper/epic/fn-1-foo--fn-1-foo.2"],
    defaultBranch: "main",
    ancestors: new Set(),
    repoHead: "main",
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => true,
    run,
    lock,
  );
  expect(failures).toEqual([]);
  // Only the base reached the merge path — the rib is filtered out before pass-2, so
  // only the BASE tip is resolved (never the rib's) and exactly one ref advance runs.
  expect(
    calls.some(
      (c) =>
        c.args ===
        "rev-parse --verify --quiet --end-of-options refs/heads/keeper/epic/fn-1-foo^{commit}",
    ),
  ).toBe(true);
  expect(
    calls.some((c) =>
      c.args.includes("refs/heads/keeper/epic/fn-1-foo--fn-1-foo.2^{commit}"),
    ),
  ).toBe(false);
  expect(
    calls.filter((c) => c.args.startsWith("update-ref --end-of-options")),
  ).toHaveLength(1);
  expect(calls.some((c) => c.args.startsWith("merge --no-edit"))).toBe(false);
});

test("fn-959.7 recoverWorktrees: repos are deduped — one sweep per distinct repo", async () => {
  const { run, calls } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    mergeHeadAt: new Set(),
    epicBases: [],
  });
  await recoverWorktrees(["/repo", "/repo", "/repo"], async () => false, run);
  // The worktree-list probe (pass 1 entry) ran exactly once despite three repo entries.
  expect(calls.filter((c) => c.args.startsWith("worktree list"))).toHaveLength(
    1,
  );
});

test("fn-1050 recoverWorktrees: a linked-worktree lane in the sweep set is SKIPPED (no off-branch row)", async () => {
  // The bug: a lane's `--show-toplevel` is the lane itself, so it registers as its
  // own git-projection root and leaks into the sweep set; pass-2 then fails
  // `off-branch` by construction (its HEAD is the `keeper/epic/*` branch). The
  // filter classifies the lane linked and skips it BEFORE any pass runs.
  const lane = "/repo.worktrees/keeper-epic-fn-1-foo";
  const { run, calls } = makeRecoveryGit({
    worktreeList: `worktree ${lane}\nHEAD y\nbranch refs/heads/keeper/epic/fn-1-foo\n\n`,
    linkedWorktreeAt: new Set([lane]),
    epicBases: ["keeper/epic/fn-1-foo"], // a done base that WOULD mint off-branch if swept
    defaultBranch: "main",
    repoHead: "keeper/epic/fn-1-foo", // the lane's HEAD is its lane branch, never default
    ancestors: new Set(),
  });
  const { failures } = await recoverWorktrees([lane], async () => true, run);
  expect(failures).toEqual([]);
  // Skipped before pass-1: the lane's worktree list was never even enumerated.
  expect(calls.some((c) => c.args.startsWith("worktree list"))).toBe(false);
});

test("fn-1050 recoverWorktrees: a linked-worktree probe ERROR defers the repo (no row, no sweep)", async () => {
  // Every probe inconclusive/error DEFERS — never fail-open into the off-branch
  // path. Level-triggered retry re-sweeps next cycle.
  const repo = "/repo";
  const { run, calls } = makeRecoveryGit({
    worktreeList: `worktree ${repo}\nHEAD x\nbranch refs/heads/main\n\n`,
    probeErrorAt: new Set([repo]),
    epicBases: ["keeper/epic/fn-1-foo"],
    defaultBranch: "main",
    repoHead: "feature-x", // off default → would mint off-branch if swept
    ancestors: new Set(),
  });
  const { failures } = await recoverWorktrees([repo], async () => true, run);
  expect(failures).toEqual([]);
  expect(calls.some((c) => c.args.startsWith("worktree list"))).toBe(false);
});

test("fn-1050 recoverWorktrees: a main/standalone checkout is still swept (probe → standalone)", async () => {
  // The filter must not skip a real main checkout: its done base still merges.
  const { run, calls, lock } = makeRecoveryGit({
    worktreeList: "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n",
    epicBases: ["keeper/epic/fn-1-foo"],
    defaultBranch: "main",
    repoHead: "main",
    ancestors: new Set(),
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => true,
    run,
    lock,
  );
  expect(failures).toEqual([]);
  expect(
    calls.some(
      (c) =>
        c.cwd === "/repo" &&
        c.args.startsWith("update-ref --end-of-options refs/heads/main"),
    ),
  ).toBe(true);
});

test("fn-959.7 isEpicDoneById: pk-lookup resolves a DONE epic unbounded by the recent-done window", async () => {
  await withSeededDb(async (db) => {
    // A done epic whose `updated_at` is FAR past the 1800s recent-done window —
    // `epics_recent_done` would NOT return it, but the pk-lookup (no recency
    // bound, OPEN-scope bypassed) must, which is the whole point of the decoupled
    // backstop. Plus an open epic and an absent id.
    const nowSec = Math.floor(Date.now() / 1000);
    seedEpicRow(db, "fn-1-done", {
      epic_number: 1,
      status: "done",
      updated_at: nowSec - DONE_EPICS_REAP_WINDOW_SEC - 10_000, // way past the window
    });
    seedEpicRow(db, "fn-2-open", { epic_number: 2, status: "open" });
    expect(await isEpicDoneById(db, "fn-1-done")).toBe(true);
    expect(await isEpicDoneById(db, "fn-2-open")).toBe(false);
    expect(await isEpicDoneById(db, "fn-3-absent")).toBe(false);

    // Sanity: the SAME stale done epic is INVISIBLE to the window-bounded snapshot
    // read, proving the pk-lookup is genuinely decoupled from the 1800s window.
    const snap = await loadReconcileSnapshot(db);
    expect(snap.epics.map((e) => e.epic_id)).not.toContain("fn-1-done");
  });
});

test("fn-991 epicPresentAndNotDone: pk-lookup reads a live epic PRESENT (open → true, done → false, absent → false)", async () => {
  await withSeededDb(async (db) => {
    // The pk-bypass frame must read a live in_progress/blocked epic as PRESENT —
    // NOT absent — so its base is never falsely swept. A done OR absent epic reads
    // false (eligible to sweep). Stale `updated_at` past the recent-done window
    // must not make a live epic read absent (the bypass is the whole point).
    const nowSec = Math.floor(Date.now() / 1000);
    seedEpicRow(db, "fn-1-open", { epic_number: 1, status: "in_progress" });
    seedEpicRow(db, "fn-2-blocked", { epic_number: 2, status: "blocked" });
    seedEpicRow(db, "fn-3-done", {
      epic_number: 3,
      status: "done",
      updated_at: nowSec - DONE_EPICS_REAP_WINDOW_SEC - 10_000, // past the window
    });
    expect(await epicPresentAndNotDone(db, "fn-1-open")).toBe(true);
    expect(await epicPresentAndNotDone(db, "fn-2-blocked")).toBe(true);
    expect(await epicPresentAndNotDone(db, "fn-3-done")).toBe(false);
    expect(await epicPresentAndNotDone(db, "fn-4-absent")).toBe(false);
  });
});

test("fn-1119 epicFrameVerdict: pure frame→verdict — done/open/absent/inconclusive, error frame testable without a live query", () => {
  // The shared verdict core. Expected values are hand-specified against each
  // constructed frame, never re-derived by the function under test.
  const result = (
    rows: Record<string, unknown>[],
  ): Parameters<typeof epicFrameVerdict>[0] => ({
    type: "result",
    collection: "epics",
    rev: 0,
    total: rows.length,
    rows,
  });
  const errorFrame: Parameters<typeof epicFrameVerdict>[0] = {
    type: "error",
    collection: "epics",
    rev: 0,
    code: "boom",
    message: "query failed",
  };
  // A result frame with a done row → done.
  expect(epicFrameVerdict(result([{ status: "done" }]))).toBe("done");
  // A result frame with a not-done row → open (any non-"done" status).
  expect(epicFrameVerdict(result([{ status: "in_progress" }]))).toBe("open");
  expect(epicFrameVerdict(result([{ status: "blocked" }]))).toBe("open");
  // A result frame with NO row → absent (AUTHORITATIVE — the pk-lookup bypasses the
  // OPEN scope and every recency floor, so an empty result is a genuine "no epic").
  expect(epicFrameVerdict(result([]))).toBe("absent");
  // A NON-result (error) frame → inconclusive, provable with a plain constructed
  // frame — no engineered live-query failure needed. This is the incident's
  // done-probe defect: the old code swallowed a non-result frame to `false`.
  expect(epicFrameVerdict(errorFrame)).toBe("inconclusive");
});

test("fn-1119 epicRecoverVerdictById: pk-lookup surfaces the full tri-state (done / open / authoritatively-absent)", async () => {
  await withSeededDb(async (db) => {
    const nowSec = Math.floor(Date.now() / 1000);
    // A stale done epic (past the recent-done window), an open one, and an absent id
    // — the pass-2 probe distinguishes done (merge) from absent (skip + clear), where
    // the boolean `isEpicDoneById` collapses open and absent to the same `false`.
    seedEpicRow(db, "fn-1-done", {
      epic_number: 1,
      status: "done",
      updated_at: nowSec - DONE_EPICS_REAP_WINDOW_SEC - 10_000,
    });
    seedEpicRow(db, "fn-2-open", { epic_number: 2, status: "in_progress" });
    expect(await epicRecoverVerdictById(db, "fn-1-done")).toBe("done");
    expect(await epicRecoverVerdictById(db, "fn-2-open")).toBe("open");
    // No row → authoritatively absent (a positive resolution signal for pass-2).
    expect(await epicRecoverVerdictById(db, "fn-3-absent")).toBe("absent");
  });
});

test("fn-1119 epicPresentAndNotDone: pass-3 preserves a lane on an OPEN epic, and the two probes share the one verdict helper", async () => {
  await withSeededDb(async (db) => {
    // Both recover probes are drawn from epicFrameVerdict, so a live epic reads the
    // SAME verdict class through either: open → done-probe "open" AND present-probe
    // preserve=true; done → done-probe "done" AND present-probe preserve=false.
    seedEpicRow(db, "fn-1-open", { epic_number: 1, status: "in_progress" });
    seedEpicRow(db, "fn-2-done", { epic_number: 2, status: "done" });
    expect(await epicRecoverVerdictById(db, "fn-1-open")).toBe("open");
    expect(await epicPresentAndNotDone(db, "fn-1-open")).toBe(true);
    expect(await epicRecoverVerdictById(db, "fn-2-done")).toBe("done");
    expect(await epicPresentAndNotDone(db, "fn-2-done")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fn-982.1 — recover-failure level-triggered auto-clear + prune-at-close
// ---------------------------------------------------------------------------

test("fn-982 isWorktreeRecoverReason: recover reasons match, finalize/other reasons do not", () => {
  // Every recoverWorktrees failure carries the `worktree-recover` marker.
  expect(isWorktreeRecoverReason("worktree-recover-conflict: …")).toBe(true);
  expect(isWorktreeRecoverReason("worktree-recover-push-failed: …")).toBe(true);
  expect(isWorktreeRecoverReason("worktree-recover-not-on-default: …")).toBe(
    true,
  );
  // A close-sink finalize failure is NOT recover-originated — the recover clear's
  // reason-scope must exclude it (it keys per-repo now, but the reason guard is the
  // belt-and-suspenders that also excludes the epic-keyed provision fan-in conflict).
  expect(isWorktreeRecoverReason("worktree-finalize-conflict: …")).toBe(false);
  expect(isWorktreeRecoverReason("worktree-teardown-dirty: …")).toBe(false);
  expect(isWorktreeRecoverReason("not-on-default-branch: …")).toBe(false);
});

test("fn-1119 recoverFailuresToClear: POSITIVE-EVIDENCE clear — an open recover id clears ONLY when the resolved set names it; NO report retains it", () => {
  const dir = "/repo";
  const fooKey = worktreeRecoverEpicDispatchId("fn-1-foo", dir);
  const barKey = worktreeRecoverEpicDispatchId("fn-2-bar", dir);
  const open = new Set([fooKey, barKey]);
  // fn-1-foo positively resolved this cycle (merged / ancestor-of-default / absent);
  // fn-2-bar got NO report at all — its probe was inconclusive, or the sweep skipped
  // it (the incident shape). Neither is in the fresh-failure set.
  const resolved: WorktreeRecoveryResolution[] = [{ epicId: "fn-1-foo", dir }];
  // Only fn-1-foo clears; fn-2-bar is RETAINED — absence of a report is never a
  // resolution (the absence-based defect this predicate closes).
  expect(recoverFailuresToClear(open, [], resolved)).toEqual([fooKey]);
  // With NO resolved observations at all, NOTHING clears (bias toward retention).
  expect(recoverFailuresToClear(open, [], [])).toEqual([]);
});

test("fn-1119 recoverFailuresToClear: a still-failing recover id is NOT cleared even when a resolved observation names it (never-clear-what-still-fails guard)", () => {
  const dir = "/repo";
  const fooKey = worktreeRecoverEpicDispatchId("fn-1-foo", dir);
  const open = new Set([fooKey]);
  const fresh: WorktreeRecoveryFailure[] = [
    { epicId: "fn-1-foo", reason: "worktree-recover-dirty-checkout: …", dir },
  ];
  // A fresh failure this cycle wins over any resolved observation for the same key —
  // the fail-loud guard preserves the still-blocked row.
  const resolved: WorktreeRecoveryResolution[] = [{ epicId: "fn-1-foo", dir }];
  expect(recoverFailuresToClear(open, fresh, resolved)).toEqual([]);
});

test("fn-1119 recoverFailuresToClear: a path-tied recover id clears on the per-dir swept-clean observation, keyed on the dir slug", () => {
  // A no-epic recovery failure keys on worktreeRecoverDispatchId(dir); the per-dir
  // positive observation (the repo classified standalone this cycle) keys the SAME
  // slug so a swept-clean dir clears its old path-tied row.
  const pathId = worktreeRecoverDispatchId("/repo");
  const open = new Set([pathId]);
  const resolved: WorktreeRecoveryResolution[] = [
    { epicId: null, dir: "/repo" },
  ];
  // The dir STILL fails a path-tied op this cycle → NOT cleared, even with the
  // swept-clean observation present (the still-failing guard).
  const stillFailing: WorktreeRecoveryFailure[] = [
    { epicId: null, reason: "worktree-recover-abort-failed: …", dir: "/repo" },
  ];
  expect(recoverFailuresToClear(open, stillFailing, resolved)).toEqual([]);
  // Swept clean (the per-dir observation, no fresh failure) → the path-tied row clears.
  expect(recoverFailuresToClear(open, [], resolved)).toEqual([pathId]);
  // But WITHOUT the observation (the repo was never swept — paused / not in the set)
  // → retained. A skipped cycle no longer clears a path-tied row either.
  expect(recoverFailuresToClear(open, [], [])).toEqual([]);
});

test("fn-1200.2 stuckSentinelJobId: extracts the job id after the prefix; null on a non-sentinel id", () => {
  const id = `${STUCK_SENTINEL_DISTRESS_ID_PREFIX}job-abc-123`;
  expect(stuckSentinelJobId(id)).toBe("job-abc-123");
  expect(isStuckSentinelDistressKey(STUCK_SENTINEL_DISTRESS_VERB, id)).toBe(
    true,
  );
  // A bare epic id (a real `close::<epic>` row sharing the verb) never parses.
  expect(stuckSentinelJobId("fn-1-foo")).toBe(null);
});

test("fn-1200.2 stuckSentinelOrphansToClear: a sentinel row whose job id resolves in the jobs table stays under ack-only (never auto-cleared)", () => {
  const liveId = `${STUCK_SENTINEL_DISTRESS_ID_PREFIX}live-job`;
  const open = new Set([liveId]);
  // The referenced job is present — ANY state counts as live, including a
  // terminal one (ADR-0013's operator-ack-only discipline is unchanged for it).
  const liveJobIds = new Set(["live-job"]);
  expect(stuckSentinelOrphansToClear(open, liveJobIds)).toEqual([]);
});

test("fn-1200.2 stuckSentinelOrphansToClear: a sentinel row whose job id is ABSENT from the jobs table is the orphan reconciliation's GC candidate", () => {
  const orphanId = `${STUCK_SENTINEL_DISTRESS_ID_PREFIX}pruned-job`;
  const open = new Set([orphanId]);
  // No job row at all for "pruned-job" — the incident shape (five of seven open
  // sentinel rows pointing at already-pruned jobs).
  const liveJobIds = new Set<string>();
  expect(stuckSentinelOrphansToClear(open, liveJobIds)).toEqual([orphanId]);
});

test("fn-1200.2 stuckSentinelOrphansToClear: mixed set — only the orphan clears, the live-job row is retained", () => {
  const liveId = `${STUCK_SENTINEL_DISTRESS_ID_PREFIX}still-here`;
  const orphanId = `${STUCK_SENTINEL_DISTRESS_ID_PREFIX}long-gone`;
  const open = new Set([liveId, orphanId]);
  const liveJobIds = new Set(["still-here"]);
  expect(stuckSentinelOrphansToClear(open, liveJobIds)).toEqual([orphanId]);
});

test("fn-1050 recoverFailureDispatchId: epic-tied → per-(epic,repo); null-epic → dir slug; the two never collide", () => {
  const dir = "/repo";
  // The helper keys on the (epicId, dir) pair structurally, so a failure AND a
  // resolution observation route through it identically (the lockstep rule).
  const epicTied = recoverFailureDispatchId({ epicId: "fn-1-foo", dir });
  const pathTied = recoverFailureDispatchId({ epicId: null, dir });
  // The single helper the mint and the clear BOTH call routes to the two id families,
  // so a one-sided key change can never strand a row un-clearable.
  expect(epicTied).toBe(worktreeRecoverEpicDispatchId("fn-1-foo", dir));
  expect(pathTied).toBe(worktreeRecoverDispatchId(dir));
  // Collision-risk assertion: the epic-keyed base36-hash id never equals the raw dir
  // slug for the SAME dir, so the two families can never cross-clear.
  expect(epicTied).not.toBe(pathTied);
});

test("fn-1050 worktreeRecoverEpicDispatchId: one epic's two repos mint DISTINCT rows (no cross-repo masking)", () => {
  // Mirrors the finalize per-repo family: concurrent recover failures on a main
  // checkout and a multi-repo dir land on separate rows, never one `close::<epic>`.
  const aKey = worktreeRecoverEpicDispatchId("fn-1-foo", "/repo-a");
  const bKey = worktreeRecoverEpicDispatchId("fn-1-foo", "/repo-b");
  expect(aKey).not.toBe(bKey);
  // Never the bare epic id — that collision (last-writer-wins UPSERT) IS the masking bug.
  expect(aKey).not.toBe("fn-1-foo");
});

test("fn-1050 worktreeRecoverEpicDispatchId: composite is retry_dispatch-able, survives boot GC, never intersects the merge-escalation token", () => {
  const key = worktreeRecoverEpicDispatchId(
    "fn-1050-worktree-recover-sweep-correctness",
    "/repo",
  );
  // `close::worktree-recover:<epic>-<hash>` passes the wire validator (verb close,
  // single `::`, safe id token) exactly like the finalize key — so boot GC RETAINS it
  // (gcUnretryableDispatchFailures only sweeps rows this predicate rejects).
  expect(parseDispatchKey(`close::${key}`)).toEqual({
    ok: true,
    verb: "close",
    id: key,
  });
  expect(isRetryableDispatchKey("close", key)).toBe(true);
  // Disjoint from the daemon merge-escalation EXACT reason token: the id never carries
  // it, and a recover REASON (`worktree-recover-*`) never trips the escalate-once sweep
  // meant for provision/finalize `worktree-merge-conflict` blocks.
  expect(key.startsWith(MERGE_ESCALATION_REASON_TOKEN)).toBe(false);
  expect(
    shouldEscalateMergeConflict("worktree-recover-conflict: merging …"),
  ).toBe(false);
});

test("fn-1119 deploy transition: an old-scheme bare-epic recover row is RETAINED under positive-evidence clearing (persists until retry_dispatch); a genuine close-sink conflict is untouched", async () => {
  await withSeededDb(async (db) => {
    const insert = (id: string, reason: string): void => {
      db.run(
        `INSERT INTO dispatch_failures
           (verb, id, reason, dir, ts, last_event_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["close", id, reason, "/repo", 1, 1, 1, 1],
      );
    };
    // A persisted OLD-scheme recover row (keyed on the bare epic id `close::fn-1-foo`)
    // + a GENUINE finalizeEpic close-sink conflict that also shares a `close::<epic>`
    // key but carries a NON-recover reason.
    insert("fn-1-foo", "worktree-recover-conflict: merging …");
    insert("fn-2-bar", "worktree-finalize-conflict: merging …");

    const snap = await loadReconcileSnapshot(db);
    // The old bare recover row loads into the clear-eligible set (reason-scoped); the
    // finalize conflict is EXCLUDED, so the recover auto-clear can never dismiss it.
    expect(snap.recoverFailureIds.has("fn-1-foo")).toBe(true);
    expect(snap.recoverFailureIds.has("fn-2-bar")).toBe(false);
    expect(snap.failedKeys.has("close::fn-1-foo")).toBe(true);

    // Under POSITIVE-EVIDENCE clearing the old bare row does NOT self-heal: a fresh
    // failure AND a positive resolution both mint the NEW per-repo key
    // (worktree-recover:fn-1-foo-<hash>), which never matches the old bare `fn-1-foo`
    // id — so it is retained until `retry_dispatch`. Acceptable per the transition
    // plan (none are live today), and the safe direction: a stale bare row biases
    // toward retention rather than a silent dismissal.
    const fresh: WorktreeRecoveryFailure[] = [
      {
        epicId: "fn-1-foo",
        reason: "worktree-recover-conflict: …",
        dir: "/repo",
      },
    ];
    const resolved: WorktreeRecoveryResolution[] = [
      { epicId: "fn-1-foo", dir: "/repo" },
    ];
    expect(recoverFailuresToClear(snap.recoverFailureIds, fresh, [])).toEqual(
      [],
    );
    expect(
      recoverFailuresToClear(snap.recoverFailureIds, [], resolved),
    ).toEqual([]);
  });
});

test("fn-982 loadReconcileSnapshot.recoverFailureIds: scopes to recover-reason close rows, excludes finalize close rows (clobber guard)", async () => {
  await withSeededDb(async (db) => {
    const insert = (verb: string, id: string, reason: string): void => {
      db.run(
        `INSERT INTO dispatch_failures
           (verb, id, reason, dir, ts, last_event_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [verb, id, reason, "/repo", 1, 1, 1, 1],
      );
    };
    // A recover-originated close failure → eligible for auto-clear.
    insert("close", "fn-1-foo", "worktree-recover-conflict: merging …");
    // A NORMAL close-sink (finalize) failure sharing the close key shape → must
    // be EXCLUDED so the auto-clear never dismisses a legitimate block.
    insert("close", "fn-2-bar", "worktree-finalize-conflict: merging …");
    // A path-tied recover row keys on the slug, verb close → eligible.
    insert(
      "close",
      worktreeRecoverDispatchId("/repo"),
      "worktree-recover-abort-failed: …",
    );
    // A non-close failure even with a recover-ish reason → excluded (verb gate).
    insert("work", "fn-9-baz.1", "worktree-recover-conflict: …");

    const snap = await loadReconcileSnapshot(db);
    expect([...snap.recoverFailureIds].sort()).toEqual(
      ["fn-1-foo", worktreeRecoverDispatchId("/repo")].sort(),
    );
    // Every row still gates dispatch via failedKeys (auto-clear scoping is
    // orthogonal to the suppression arm).
    expect(snap.failedKeys.has("close::fn-2-bar")).toBe(true);
  });
});

test("fn-982 finalizeEpic: a fully-merged lane base is pruned (branch -D) after teardown", async () => {
  const cmds: string[] = [];
  const fakeRun: Parameters<typeof createWorktreeDriver>[0] = async (args) => {
    const joined = args.join(" ");
    cmds.push(joined);
    if (isInProgressPseudoRefProbe(args)) {
      return { code: 1, stdout: "", stderr: "" }; // clean: in-progress pseudo-ref absent
    }
    if (args[0] === "rev-parse" && args.includes("--verify")) {
      return { code: 0, stdout: "abc\n", stderr: "" }; // base exists / source exists
    }
    if (args[0] === "show") {
      return {
        code: 0,
        stdout: JSON.stringify({ id: "fn-1-foo", status: "done" }),
        stderr: "",
      };
    }
    if (joined.startsWith("symbolic-ref")) {
      return { code: 0, stdout: "origin/main\n", stderr: "" };
    }
    if (joined === "rev-parse --abbrev-ref HEAD") {
      return { code: 0, stdout: "main\n", stderr: "" };
    }
    if (joined.startsWith("merge-base --is-ancestor")) {
      return { code: 0, stdout: "", stderr: "" }; // already an ancestor → fully merged
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const res = await createWorktreeDriver(fakeRun).finalizeEpic(
    makeFinalizeInfo(),
    async () => true,
  );
  expect(res).toEqual({ ok: true });
  // The fully-merged base branch was force-deleted so a DONE epic leaves no
  // recover-able `keeper/epic/<id>` branch behind (the fn-973 pileup fix).
  expect(cmds).toContain("branch -D keeper/epic/fn-1-foo");
});

test("fn-982 finalizeEpic: prune is gated on is-ancestor — a base NOT an ancestor of default is never force-deleted", async () => {
  // After the base merges + pushes, teardown re-checks is-ancestor against the
  // resolved DEFAULT BRANCH as the delete gate. Force that gate FALSE — the base is
  // not contained in default — and the branch survives: `branch -D` force-deletes
  // regardless of merge state, so an unmerged/diverged base would lose work.
  const { run, cmds } = makeMergeGit({ pruneNotAncestor: true });
  const res = await createWorktreeDriver(run, () => ({
    release() {},
  })).finalizeEpic(makeFinalizeInfo(), async () => true);
  expect(res).toEqual({ ok: true });
  // The gate said "not an ancestor" → the branch was preserved, never deleted.
  expect(cmds.some((c) => c.startsWith("branch -D"))).toBe(false);
});

test("fn-985 finalizeEpic: fully-merged rib worktrees + branches are pruned alongside the base (no rib leak)", async () => {
  const rib = "keeper/epic/fn-1-foo--fn-1-foo.2";
  const ribPath = "/repo.worktrees/keeper-epic-fn-1-foo--fn-1-foo.2";
  const cmds: string[] = [];
  const fakeRun: Parameters<typeof createWorktreeDriver>[0] = async (args) => {
    const joined = args.join(" ");
    cmds.push(joined);
    if (isInProgressPseudoRefProbe(args)) {
      return { code: 1, stdout: "", stderr: "" }; // clean: in-progress pseudo-ref absent
    }
    if (args[0] === "rev-parse" && args.includes("--verify")) {
      return { code: 0, stdout: "abc\n", stderr: "" };
    }
    if (args[0] === "show") {
      return {
        code: 0,
        stdout: JSON.stringify({ id: "fn-1-foo", status: "done" }),
        stderr: "",
      };
    }
    if (joined.startsWith("symbolic-ref")) {
      return { code: 0, stdout: "origin/main\n", stderr: "" };
    }
    if (joined === "rev-parse --abbrev-ref HEAD") {
      return { code: 0, stdout: "main\n", stderr: "" };
    }
    if (joined.startsWith("worktree list")) {
      return {
        code: 0,
        stdout:
          "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
          "worktree /repo.worktrees/keeper-epic-fn-1-foo\nHEAD y\nbranch refs/heads/keeper/epic/fn-1-foo\n\n" +
          `worktree ${ribPath}\nHEAD z\nbranch refs/heads/${rib}\n\n`,
        stderr: "",
      };
    }
    if (joined.startsWith("merge-base --is-ancestor")) {
      return { code: 0, stdout: "", stderr: "" }; // every lane fully merged
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const info = makeFinalizeInfo();
  info.laneOrder = [
    {
      nodeId: "__close__",
      branch: info.baseBranch,
      worktreePath: info.baseWorktreePath,
    },
    { nodeId: "fn-1-foo.2", branch: rib, worktreePath: ribPath },
  ];
  const res = await createWorktreeDriver(fakeRun).finalizeEpic(
    info,
    async () => true,
  );
  expect(res).toEqual({ ok: true });
  // Both the rib worktree AND the base worktree were torn down — nothing leaks.
  expect(cmds).toContain(`worktree remove ${ribPath}`);
  expect(cmds).toContain(
    "worktree remove /repo.worktrees/keeper-epic-fn-1-foo",
  );
  // Both the rib branch AND the base branch were force-deleted, each is-ancestor-gated.
  expect(cmds).toContain(`branch -D ${rib}`);
  expect(cmds).toContain("branch -D keeper/epic/fn-1-foo");
});

test("fn-988 finalizeEpic teardown: an orphan rib NOT in laneOrder (live-git enumerated) is still torn down", async () => {
  // The snapshot's laneOrder carries only the base, but live git knows of a rib
  // forked in a cycle the snapshot never saw. Teardown must enumerate it from
  // `for-each-ref` and prune both its worktree and its (merged) branch.
  const rib = "keeper/epic/fn-1-foo--fn-1-foo.9";
  const ribPath = "/repo.worktrees/keeper-epic-fn-1-foo--fn-1-foo.9";
  const cmds: string[] = [];
  const fakeRun: Parameters<typeof createWorktreeDriver>[0] = async (args) => {
    const joined = args.join(" ");
    cmds.push(joined);
    if (isInProgressPseudoRefProbe(args)) {
      return { code: 1, stdout: "", stderr: "" }; // clean: in-progress pseudo-ref absent
    }
    if (args[0] === "rev-parse" && args.includes("--verify")) {
      return { code: 0, stdout: "abc\n", stderr: "" };
    }
    if (args[0] === "show") {
      return {
        code: 0,
        stdout: JSON.stringify({ id: "fn-1-foo", status: "done" }),
        stderr: "",
      };
    }
    if (joined.startsWith("symbolic-ref")) {
      return { code: 0, stdout: "origin/main\n", stderr: "" };
    }
    if (joined === "rev-parse --abbrev-ref HEAD") {
      return { code: 0, stdout: "main\n", stderr: "" };
    }
    if (joined.startsWith("for-each-ref") && joined.includes("keeper/epic")) {
      // Live git enumerates the base AND the orphan rib laneOrder never carried.
      return { code: 0, stdout: `keeper/epic/fn-1-foo\n${rib}\n`, stderr: "" };
    }
    if (joined.startsWith("worktree list")) {
      return {
        code: 0,
        stdout:
          "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
          "worktree /repo.worktrees/keeper-epic-fn-1-foo\nHEAD y\nbranch refs/heads/keeper/epic/fn-1-foo\n\n" +
          `worktree ${ribPath}\nHEAD z\nbranch refs/heads/${rib}\n\n`,
        stderr: "",
      };
    }
    if (joined.startsWith("merge-base --is-ancestor")) {
      return { code: 0, stdout: "", stderr: "" }; // every lane fully merged
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  // laneOrder default is base-only (makeFinalizeInfo) — the rib is an orphan.
  const res = await createWorktreeDriver(fakeRun).finalizeEpic(
    makeFinalizeInfo(),
    async () => true,
  );
  expect(res).toEqual({ ok: true });
  // The orphan rib's worktree AND branch were pruned, never `--contains`.
  expect(cmds).toContain(`worktree remove ${ribPath}`);
  expect(cmds).toContain(`branch -D ${rib}`);
  expect(cmds.some((c) => c.includes("--contains"))).toBe(false);
});

test("fn-985 finalizeEpic: a rib NOT an ancestor of default is preserved while the merged base is pruned", async () => {
  const rib = "keeper/epic/fn-1-foo--fn-1-foo.2";
  const ribPath = "/repo.worktrees/keeper-epic-fn-1-foo--fn-1-foo.2";
  const cmds: string[] = [];
  const fakeRun: Parameters<typeof createWorktreeDriver>[0] = async (args) => {
    const joined = args.join(" ");
    cmds.push(joined);
    if (isInProgressPseudoRefProbe(args)) {
      return { code: 1, stdout: "", stderr: "" }; // clean: in-progress pseudo-ref absent
    }
    if (args[0] === "rev-parse" && args.includes("--verify")) {
      return { code: 0, stdout: "abc\n", stderr: "" };
    }
    if (args[0] === "show") {
      return {
        code: 0,
        stdout: JSON.stringify({ id: "fn-1-foo", status: "done" }),
        stderr: "",
      };
    }
    if (joined.startsWith("symbolic-ref")) {
      return { code: 0, stdout: "origin/main\n", stderr: "" };
    }
    if (joined === "rev-parse --abbrev-ref HEAD") {
      return { code: 0, stdout: "main\n", stderr: "" };
    }
    if (joined.startsWith("worktree list")) {
      return {
        code: 0,
        stdout:
          "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
          "worktree /repo.worktrees/keeper-epic-fn-1-foo\nHEAD y\nbranch refs/heads/keeper/epic/fn-1-foo\n\n" +
          `worktree ${ribPath}\nHEAD z\nbranch refs/heads/${rib}\n\n`,
        stderr: "",
      };
    }
    // The rib is NOT contained in default → its prune gate is false (preserve it);
    // every other is-ancestor (merge skip + base prune gate) is true.
    if (joined === `merge-base --is-ancestor ${rib} main`) {
      return { code: 1, stdout: "", stderr: "" };
    }
    if (joined.startsWith("merge-base --is-ancestor")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const info = makeFinalizeInfo();
  info.laneOrder = [
    {
      nodeId: "__close__",
      branch: info.baseBranch,
      worktreePath: info.baseWorktreePath,
    },
    { nodeId: "fn-1-foo.2", branch: rib, worktreePath: ribPath },
  ];
  const res = await createWorktreeDriver(fakeRun).finalizeEpic(
    info,
    async () => true,
  );
  expect(res).toEqual({ ok: true });
  // The unmerged rib survived (force-delete would lose work); the base still pruned.
  expect(cmds.some((c) => c === `branch -D ${rib}`)).toBe(false);
  expect(cmds).toContain("branch -D keeper/epic/fn-1-foo");
});

// ---------------------------------------------------------------------------
// fn-985 — finalize degrades gracefully (skip-and-retry, never a sticky jam) on a
// dirty / off-branch / non-fast-forward SHARED main checkout, and is idempotent.
// ---------------------------------------------------------------------------

/** A finalize fakeRun past the branch-exists guard with the lane base AHEAD of
 *  default (so the shared merge routine reaches the readiness checks), parameterized
 *  on the main checkout's HEAD branch, `git status --porcelain`, and whether the
 *  cached origin ref is an ancestor of local (fast-forwardable). The projection-done
 *  gate is the `isEpicDone` arg the caller passes, not a git read. */
function makeFinalizeReadinessRun(opts: {
  head?: string; // rev-parse --abbrev-ref HEAD
  status?: string; // git status --porcelain stdout
  remoteAhead?: boolean; // origin ref NOT an ancestor of local → non-ff
  noRemote?: boolean; // `remote get-url origin` fails → not turn-key
  noPushTarget?: boolean; // `@{push}` does not resolve → not turn-key
  dryRunReject?: string; // `push --dry-run` stderr → not turn-key
  untracked?: string; // ls-files --others --exclude-standard (main's untracked)
  incomingTracked?: string; // ls-tree -r --name-only <base> (incoming tracked)
  midMergeHead?: string; // MERGE_HEAD present at readiness time (a wedge) → mid-merge verdict
  midMergePointsAt?: string[]; // refs/heads/... at MERGE_HEAD (ownership)
  midMergeAutostash?: boolean; // MERGE_AUTOSTASH present → foreign-shaped
}): { run: Parameters<typeof createWorktreeDriver>[0]; cmds: string[] } {
  const cmds: string[] = [];
  const run: Parameters<typeof createWorktreeDriver>[0] = async (args) => {
    const joined = args.join(" ");
    cmds.push(joined);
    if (joined === "rev-parse --verify --quiet MERGE_HEAD") {
      return opts.midMergeHead !== undefined
        ? { code: 0, stdout: `${opts.midMergeHead}\n`, stderr: "" }
        : { code: 1, stdout: "", stderr: "" };
    }
    if (joined === "rev-parse --verify --quiet MERGE_AUTOSTASH") {
      return opts.midMergeAutostash
        ? { code: 0, stdout: "stash\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "" };
    }
    if (joined.startsWith("for-each-ref") && joined.includes("--points-at")) {
      return {
        code: 0,
        stdout: (opts.midMergePointsAt ?? []).join("\n"),
        stderr: "",
      };
    }
    if (joined === "remote get-url origin") {
      return opts.noRemote
        ? { code: 1, stdout: "", stderr: "error: No such remote 'origin'" }
        : { code: 0, stdout: "git@host:repo.git\n", stderr: "" };
    }
    if (
      joined.startsWith("rev-parse --abbrev-ref --symbolic-full-name @{push}")
    ) {
      return opts.noPushTarget
        ? {
            code: 1,
            stdout: "",
            stderr: "fatal: no push destination configured",
          }
        : { code: 0, stdout: "origin/main\n", stderr: "" };
    }
    if (joined.startsWith("push --dry-run")) {
      return opts.dryRunReject !== undefined
        ? { code: 1, stdout: "", stderr: opts.dryRunReject }
        : { code: 0, stdout: "", stderr: "" };
    }
    if (isInProgressPseudoRefProbe(args)) {
      return { code: 1, stdout: "", stderr: "" }; // clean: in-progress pseudo-ref absent
    }
    if (args[0] === "rev-parse" && args.includes("--verify")) {
      return { code: 0, stdout: "abc\n", stderr: "" }; // base / source / origin ref exists
    }
    if (joined.startsWith("symbolic-ref")) {
      return { code: 0, stdout: "origin/main\n", stderr: "" };
    }
    if (joined === "rev-parse --abbrev-ref HEAD") {
      return { code: 0, stdout: `${opts.head ?? "main"}\n`, stderr: "" };
    }
    if (joined.startsWith("status --porcelain")) {
      return { code: 0, stdout: opts.status ?? "", stderr: "" };
    }
    if (joined.startsWith("ls-files --others --exclude-standard")) {
      return { code: 0, stdout: opts.untracked ?? "", stderr: "" };
    }
    if (joined.startsWith("ls-tree -r --name-only")) {
      return { code: 0, stdout: opts.incomingTracked ?? "", stderr: "" };
    }
    if (joined === "merge-base --is-ancestor refs/remotes/origin/main main") {
      return { code: opts.remoteAhead ? 1 : 0, stdout: "", stderr: "" };
    }
    if (joined === "merge-base --is-ancestor keeper/epic/fn-1-foo main") {
      // The lane base is AHEAD of default (not an ancestor) → the shared routine
      // proceeds past the ahead-check into the readiness/precheck degrades.
      return { code: 1, stdout: "", stderr: "" };
    }
    if (joined.startsWith("merge-base --is-ancestor")) {
      return { code: 0, stdout: "", stderr: "" }; // base vs HEAD: already-merged no-lock skip
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, cmds };
}

test("fn-1140 finalizeEpic: a DIRTY main checkout NO LONGER blocks finalize — the base merge lands via plumbing and teardown proceeds (the regression), catch-up aborts", async () => {
  // The incident: a dirty shared checkout silently retry-skipped the base merge,
  // stranding a done epic unmerged. The working-tree-free plumbing merge lands
  // regardless of the checkout state, so finalize succeeds and tears the lanes down;
  // even a colliding local edit that aborts the stale-aware catch-up never runs a
  // `reset --hard` over WIP and never blocks the merge.
  const { run, cmds } = makeMergeGit({ readTreeAbort: true });
  const res = await createWorktreeDriver(run, () => ({
    release() {},
  })).finalizeEpic(makeFinalizeInfo(), async () => true);
  expect(res).toEqual({ ok: true });
  expect(cmds.some((c) => c.startsWith("update-ref --end-of-options"))).toBe(
    true,
  );
  expect(cmds.some((c) => c === "push origin main")).toBe(true);
  expect(cmds.some((c) => c.startsWith("reset --hard"))).toBe(false);
  expect(cmds.some((c) => c.startsWith("merge --no-edit"))).toBe(false);
});

test("fn-1140 finalizeEpic: an OFF-BRANCH main checkout advances the base merge locally but the off-branch push defers (worktree-finalize-off-branch retry-skip), no teardown", async () => {
  // On a non-default branch the plumbing still advances refs/heads/<default> locally
  // (the decoupling), but pushDefaultToOrigin refuses to push off the default branch,
  // so finalize maps it to a non-sticky worktree-finalize-off-branch retry-skip and
  // tears nothing down behind the deferred push.
  const { run, cmds } = makeMergeGit({ head: "feature-x" });
  const res = await createWorktreeDriver(run, () => ({
    release() {},
  })).finalizeEpic(makeFinalizeInfo(), async () => true);
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.retry).toBe(true);
    expect(res.reason).toContain("worktree-finalize-off-branch");
    expect(isWorktreeRecoverReason(res.reason)).toBe(false);
  }
  // The LOCAL ref advanced (the merge landed) even off-default — never a `git merge`.
  expect(cmds.some((c) => c.startsWith("update-ref --end-of-options"))).toBe(
    true,
  );
  expect(cmds.some((c) => c.startsWith("merge --no-edit"))).toBe(false);
  // No wrong-ref push, no teardown behind the deferred push.
  expect(cmds.some((c) => c === "push origin main")).toBe(false);
  expect(cmds.some((c) => c.startsWith("worktree remove"))).toBe(false);
});

// ── fn-1204 — the finalize merge-suite gate ─────────────────────────────────
// The prospective lane→default merge result's fast suite runs on a scratch worktree
// BEFORE local default advances: green proceeds to the existing merge+push; red parks a
// VISIBLE sticky with local default unmoved and nothing pushed; a gate that cannot run
// degrades to a non-sticky retry-skip. The suite run is an INJECTED probe so these fast
// tests drive the three verdicts + the memo purely (the real scratch+suite run is the
// slow real-git tier's job).

/** A fake merge-suite probe recording its calls and returning a fixed verdict (or a
 *  per-call verdict picked by 1-based call index). */
function makeSuiteProbe(
  verdict: MergeSuiteVerdict | ((call: number) => MergeSuiteVerdict),
): {
  probe: MergeSuiteProbe;
  calls: { repoDir: string; mergedCommit: string; runsPlanSuite: boolean }[];
} {
  const calls: {
    repoDir: string;
    mergedCommit: string;
    runsPlanSuite: boolean;
  }[] = [];
  const probe: MergeSuiteProbe = async (a) => {
    calls.push({
      repoDir: a.repoDir,
      mergedCommit: a.mergedCommit,
      runsPlanSuite: a.runsPlanSuite,
    });
    return typeof verdict === "function" ? verdict(calls.length) : verdict;
  };
  return { probe, calls };
}

test("fn-1204 finalizeEpic gate: a GREEN merge-suite verdict proceeds through the unchanged merge+push path", async () => {
  const { run, cmds } = makeMergeGit();
  const { probe, calls } = makeSuiteProbe({ kind: "green" });
  const res = await createWorktreeDriver(run, () => ({
    release() {},
  })).finalizeEpic(makeFinalizeInfo(), async () => true, probe);
  expect(res).toEqual({ ok: true });
  // The probe saw the EXACT prospective merged commit the merge advances to.
  expect(calls).toEqual([
    { repoDir: "/repo", mergedCommit: MG_MERGE_COMMIT, runsPlanSuite: false },
  ]);
  // Green → the real merge+push ran, unchanged.
  expect(cmds.some((c) => c.startsWith("update-ref --end-of-options"))).toBe(
    true,
  );
  expect(cmds.some((c) => c === "push origin main")).toBe(true);
});

test("fn-1204 finalizeEpic gate: a RED merge-suite verdict parks a VISIBLE sticky (no retry) with local default unmoved and nothing pushed", async () => {
  const { run, cmds } = makeMergeGit();
  const { probe, calls } = makeSuiteProbe({
    kind: "red",
    detail: "3 failing test(s): foo > bar",
  });
  const res = await createWorktreeDriver(run, () => ({
    release() {},
  })).finalizeEpic(makeFinalizeInfo(), async () => true, probe);
  expect(res.ok).toBe(false);
  if (!res.ok) {
    // A VISIBLE sticky (mirrors the non-ff arm) — never a retry-skip, so the operator
    // sees it and clears it with retry_dispatch once the semantic conflict is fixed.
    expect(res.retry).not.toBe(true);
    expect(
      res.reason.startsWith(`${WORKTREE_FINALIZE_SUITE_RED_REASON}:`),
    ).toBe(true);
    expect(res.reason).toContain(MG_MERGE_COMMIT);
    expect(res.reason).toContain("3 failing test(s)");
    // Stays OUTSIDE the recover auto-clear prefix.
    expect(isWorktreeRecoverReason(res.reason)).toBe(false);
  }
  expect(calls.length).toBe(1);
  // Local default NEVER advanced and NOTHING was pushed — so the desync producer sees
  // nothing, and there is no rollback to do.
  expect(cmds.some((c) => c.startsWith("update-ref"))).toBe(false);
  expect(cmds.some((c) => c.startsWith("push origin"))).toBe(false);
  expect(cmds.some((c) => c.startsWith("worktree remove"))).toBe(false);
});

test("fn-1204 finalizeEpic gate: a CANNOT-RUN verdict degrades to a non-sticky retry-skip, never a push, never a permanent silent block", async () => {
  const { run, cmds } = makeMergeGit();
  const { probe } = makeSuiteProbe({
    kind: "cannot-run",
    detail: "scratch checkout failed",
  });
  const res = await createWorktreeDriver(run, () => ({
    release() {},
  })).finalizeEpic(makeFinalizeInfo(), async () => true, probe);
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.retry).toBe(true); // NON-sticky — retries next cycle
    expect(res.reason).toContain("worktree-finalize-suite-gate-unavailable");
    expect(isWorktreeRecoverReason(res.reason)).toBe(false);
  }
  // Never a silent push behind an un-run gate.
  expect(cmds.some((c) => c.startsWith("update-ref"))).toBe(false);
  expect(cmds.some((c) => c.startsWith("push origin"))).toBe(false);
});

test("fn-1204 finalizeEpic gate: the verdict is MEMOIZED by merged-commit key — a parked epic's finalize retry reuses the cached red without re-running the suite", async () => {
  const { run } = makeMergeGit();
  const { probe, calls } = makeSuiteProbe({ kind: "red", detail: "boom" });
  // ONE driver (the memo lives on its closure); two finalize retries of the SAME
  // unchanged merge (the red park never advanced default, so the merged commit is
  // stable across the retry).
  const driver = createWorktreeDriver(run, () => ({ release() {} }));
  const first = await driver.finalizeEpic(
    makeFinalizeInfo(),
    async () => true,
    probe,
  );
  const second = await driver.finalizeEpic(
    makeFinalizeInfo(),
    async () => true,
    probe,
  );
  expect(first.ok).toBe(false);
  expect(second.ok).toBe(false);
  // The suite probe ran ONCE — the second finalize reused the memoized red verdict.
  expect(calls.length).toBe(1);
});

test("fn-1204 finalizeEpic gate: a CANNOT-RUN verdict is NOT memoized — the next finalize retries the suite (a transient scratch hiccup must recompute)", async () => {
  const { run } = makeMergeGit();
  // First call cannot-run, second call green — the memo must NOT latch the cannot-run.
  const { probe, calls } = makeSuiteProbe((call) =>
    call === 1
      ? { kind: "cannot-run", detail: "scratch hiccup" }
      : { kind: "green" },
  );
  const driver = createWorktreeDriver(run, () => ({ release() {} }));
  const first = await driver.finalizeEpic(
    makeFinalizeInfo(),
    async () => true,
    probe,
  );
  const second = await driver.finalizeEpic(
    makeFinalizeInfo(),
    async () => true,
    probe,
  );
  expect(first.ok).toBe(false); // retry-skip
  expect(second).toEqual({ ok: true }); // recomputed → green → merged
  expect(calls.length).toBe(2); // the probe ran BOTH times — no cannot-run latch
});

test("fn-1204 finalizeEpic gate: a merge touching plugins/plan drives runsPlanSuite=true (the plan suite is covered)", async () => {
  const { run } = makeMergeGit({ planDiff: "plugins/plan/src/x.ts\n" });
  const { probe, calls } = makeSuiteProbe({ kind: "green" });
  await createWorktreeDriver(run, () => ({ release() {} })).finalizeEpic(
    makeFinalizeInfo(),
    async () => true,
    probe,
  );
  expect(calls).toEqual([
    { repoDir: "/repo", mergedCommit: MG_MERGE_COMMIT, runsPlanSuite: true },
  ]);
});

test("fn-1204 finalizeEpic gate: an ALREADY-MERGED base (ancestor of default) SKIPS the gate — no suite run, idempotent teardown resumes", async () => {
  // A crash-retry after the merge already landed: the base is an ancestor of default,
  // so there is no new merged tree to gate — the probe must NOT run, and finalize falls
  // straight through to the idempotent not-ahead teardown.
  const { run } = makeMergeGit({ baseAncestorOfDefault: true });
  const { probe, calls } = makeSuiteProbe({ kind: "red", detail: "unused" });
  const res = await createWorktreeDriver(run, () => ({
    release() {},
  })).finalizeEpic(makeFinalizeInfo(), async () => true, probe);
  expect(res).toEqual({ ok: true });
  expect(calls.length).toBe(0); // gate skipped — nothing new to test
});

test("fn-1204 finalizeEpic gate: a merge-tree CONFLICT is NOT gated — it falls through to the shared merge routine's sticky conflict, never a suite-red park", async () => {
  // The gate only vets a COMPUTABLE merged tree; a content conflict has no merged tree
  // to test, so the gate falls through and mergeLaneBaseIntoDefault surfaces its own
  // conflict discriminant unchanged (the probe never runs).
  const { run } = makeMergeGit({ mergeTreeExit: 1 });
  const { probe, calls } = makeSuiteProbe({ kind: "green" });
  const res = await createWorktreeDriver(run, () => ({
    release() {},
  })).finalizeEpic(makeFinalizeInfo(), async () => true, probe);
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.reason).toContain("worktree-finalize-conflict");
    expect(
      res.reason.startsWith(`${WORKTREE_FINALIZE_SUITE_RED_REASON}:`),
    ).toBe(false);
  }
  expect(calls.length).toBe(0); // no computable merged tree → gate skipped
});

test("fn-1204 finalizeEpic gate: OMITTING the probe skips the gate entirely — finalize merges as before (backward-compatible)", async () => {
  const { run, cmds } = makeMergeGit();
  const res = await createWorktreeDriver(run, () => ({
    release() {},
  })).finalizeEpic(makeFinalizeInfo(), async () => true);
  expect(res).toEqual({ ok: true });
  expect(cmds.some((c) => c === "push origin main")).toBe(true);
});

// ── fn-1213 — runMergeSuiteGate / runPackageSuiteGate verdict-mapping coverage ──
// The 8 fn-1204 tests above exercise finalize's REACTION to an injected verdict,
// never how the PRODUCTION probe maps a real install+suite run to one. These
// tests drive `runMergeSuiteGate` itself through its `run`/`worktreesRoot`/
// `installTimeoutMs`/`suiteDeadlineMs`/`spawnFn` seams: a fake `WorktreeGitRunner`
// makes the scratch "checkout" a real tmp directory (so `readPkgGateCommand`
// reads real files) and a fake `spawnFn` replaces the real `bun install` /
// `/bin/sh -c <gate>` subprocess so no real subprocess ever runs.

const MG_SHA = "deadbeefcafefeed00000000000000000000000000".slice(0, 40);

/** A fake `WorktreeGitRunner` that "checks out" the scratch worktree as a real tmp
 *  dir (so package.json reads are real), then answers the rest of provision/reap
 *  cleanly. `pkgJson`/`planPkgJson` control what lands at the scratch root / the
 *  `plugins/plan` subdir; `null` omits the file entirely (no test-gate script).
 *  `throwOnHead` simulates an unexpected git failure to drive the thrown/error path. */
function makeMergeSuiteGit(opts?: {
  pkgJson?: Record<string, unknown> | null;
  planPkgJson?: Record<string, unknown> | null;
  throwOnHead?: boolean;
}): { run: GitRunner; cmds: string[][] } {
  const cmds: string[][] = [];
  const run: GitRunner = async (args) => {
    cmds.push(args);
    const [a0, a1] = args;
    if (a0 === "worktree" && a1 === "add") {
      const path = args[3] as string;
      mkdirSync(path, { recursive: true });
      const pkgJson =
        opts?.pkgJson === undefined
          ? { scripts: { test: "true" } }
          : opts.pkgJson;
      if (pkgJson !== null) {
        writeFileSync(join(path, "package.json"), JSON.stringify(pkgJson));
      }
      if (opts?.planPkgJson !== undefined && opts.planPkgJson !== null) {
        const planDir = join(path, "plugins/plan");
        mkdirSync(planDir, { recursive: true });
        writeFileSync(
          join(planDir, "package.json"),
          JSON.stringify(opts.planPkgJson),
        );
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (a0 === "rev-parse" && a1 === "HEAD") {
      if (opts?.throwOnHead) {
        throw new Error("boom: unexpected git failure");
      }
      return { code: 0, stdout: `${MG_SHA}\n`, stderr: "" };
    }
    if (a0 === "status" && a1 === "--porcelain") {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (a0 === "worktree" && a1 === "list") {
      return { code: 0, stdout: "", stderr: "" };
    }
    // "worktree remove --force …" / "worktree prune …" — both idempotent no-ops.
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, cmds };
}

/** A queued fake child SPEC — built into a real `ChildProcess`-shaped
 *  `EventEmitter` LAZILY, inside `spawnFn` itself (never upfront), so its
 *  `close` microtask is only ever scheduled AFTER `runDetached` has
 *  synchronously attached its listeners in the very same tick. Scheduling it
 *  upfront (before `spawnFn` runs) races the deep `await`-chain inside
 *  `provisionScratchWorktree`: the microtask drains at the FIRST await it
 *  hits, long before `runDetached` ever attaches a listener, so the `close`
 *  event fires on deaf ears and every run reads as a timeout. */
type ChildSpec =
  | { kind: "resolved"; exitCode: number; output?: string }
  | { kind: "never-closes" };

function buildChild(spec: ChildSpec): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    pid: spec.kind === "resolved" ? 4242 : undefined,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  if (spec.kind === "resolved") {
    queueMicrotask(() => {
      if (spec.output && spec.output.length > 0) {
        (child.stdout as EventEmitter).emit("data", Buffer.from(spec.output));
      }
      child.emit("close", spec.exitCode, null);
    });
  }
  return child as unknown as ChildProcess;
}

/** A queued fake `spawnFn` — the Nth `runDetached` call builds+returns the Nth
 *  queued spec's child. Throws if exhausted (a test wired fewer specs than
 *  calls made). */
function makeQueuedSpawn(specs: ChildSpec[]): {
  spawnFn: SpawnFn;
  calls: { file: string; args: string[]; cwd: string }[];
} {
  const calls: { file: string; args: string[]; cwd: string }[] = [];
  let i = 0;
  const spawnFn = ((
    file: string,
    args: string[],
    spawnOpts: { cwd: string },
  ) => {
    calls.push({ file, args, cwd: spawnOpts.cwd });
    const spec = specs[i];
    i += 1;
    if (!spec) {
      throw new Error("makeQueuedSpawn: no more queued specs");
    }
    return buildChild(spec);
  }) as unknown as SpawnFn;
  return { spawnFn, calls };
}

const resolved = (exitCode: number, output?: string): ChildSpec => ({
  kind: "resolved",
  exitCode,
  output,
});
const neverCloses = (): ChildSpec => ({ kind: "never-closes" });

test("fn-1213 runMergeSuiteGate: an install FAILURE (non-zero exit) degrades to cannot-run — the gate command never runs", async () => {
  const { run } = makeMergeSuiteGit();
  const worktreesRoot = mkdtempSync(join(tmpdir(), "keeper-mg-install-fail-"));
  const { spawnFn, calls } = makeQueuedSpawn([resolved(1, "install exploded")]);
  const verdict = await runMergeSuiteGate(
    { repoDir: "/repo", mergedCommit: MG_SHA, runsPlanSuite: false },
    {
      run,
      worktreesRoot,
      installTimeoutMs: 2_000,
      suiteDeadlineMs: 2_000,
      spawnFn,
    },
  );
  expect(verdict.kind).toBe("cannot-run");
  if (verdict.kind === "cannot-run") {
    expect(verdict.detail).toContain("frozen-lockfile install failed");
  }
  expect(calls.length).toBe(1); // the gate command call never fired
  rmSync(worktreesRoot, { recursive: true, force: true });
});

// `runDetached`'s default kill-grace (5s, unexposed through this seam) pushes
// the force-resolve past bun's own default 5s per-test timeout — bump it.
test("fn-1213 runMergeSuiteGate: an install TIMEOUT degrades to cannot-run", async () => {
  const { run } = makeMergeSuiteGit();
  const worktreesRoot = mkdtempSync(join(tmpdir(), "keeper-mg-install-to-"));
  const { spawnFn, calls } = makeQueuedSpawn([neverCloses()]);
  const verdict = await runMergeSuiteGate(
    { repoDir: "/repo", mergedCommit: MG_SHA, runsPlanSuite: false },
    {
      run,
      worktreesRoot,
      installTimeoutMs: 5,
      suiteDeadlineMs: 2_000,
      spawnFn,
    },
  );
  expect(verdict.kind).toBe("cannot-run");
  if (verdict.kind === "cannot-run") {
    expect(verdict.detail).toContain("frozen-lockfile install timed out");
  }
  expect(calls.length).toBe(1);
  rmSync(worktreesRoot, { recursive: true, force: true });
}, 8_000);

test("fn-1213 runMergeSuiteGate: NO test-gate script (readPkgGateCommand -> null) degrades to cannot-run after a clean install", async () => {
  const { run } = makeMergeSuiteGit({ pkgJson: { scripts: {} } });
  const worktreesRoot = mkdtempSync(join(tmpdir(), "keeper-mg-no-gate-"));
  const { spawnFn, calls } = makeQueuedSpawn([resolved(0)]);
  const verdict = await runMergeSuiteGate(
    { repoDir: "/repo", mergedCommit: MG_SHA, runsPlanSuite: false },
    {
      run,
      worktreesRoot,
      installTimeoutMs: 2_000,
      suiteDeadlineMs: 2_000,
      spawnFn,
    },
  );
  expect(verdict.kind).toBe("cannot-run");
  if (verdict.kind === "cannot-run") {
    expect(verdict.detail).toContain("no test-gate script");
  }
  expect(calls.length).toBe(1); // install ran; the gate-run call never fired
  rmSync(worktreesRoot, { recursive: true, force: true });
});

// Same kill-grace note as the install-timeout test above.
test("fn-1213 runMergeSuiteGate: a suite TIMEOUT degrades to cannot-run", async () => {
  const { run } = makeMergeSuiteGit();
  const worktreesRoot = mkdtempSync(join(tmpdir(), "keeper-mg-suite-to-"));
  const { spawnFn, calls } = makeQueuedSpawn([
    resolved(0), // install
    neverCloses(), // gate command
  ]);
  const verdict = await runMergeSuiteGate(
    { repoDir: "/repo", mergedCommit: MG_SHA, runsPlanSuite: false },
    {
      run,
      worktreesRoot,
      installTimeoutMs: 2_000,
      suiteDeadlineMs: 5,
      spawnFn,
    },
  );
  expect(verdict.kind).toBe("cannot-run");
  if (verdict.kind === "cannot-run") {
    expect(verdict.detail).toContain("suite timed out");
  }
  expect(calls.length).toBe(2);
  rmSync(worktreesRoot, { recursive: true, force: true });
}, 8_000);

test("fn-1213 runMergeSuiteGate: classifyRun == crashed (non-zero exit, no failing-test signal) maps to red, never green/cannot-run", async () => {
  const { run } = makeMergeSuiteGit();
  const worktreesRoot = mkdtempSync(join(tmpdir(), "keeper-mg-crash-"));
  const { spawnFn } = makeQueuedSpawn([
    resolved(0), // install
    resolved(1, "TypeError: bail out, no test ran at all"), // gate: crashed
  ]);
  const verdict = await runMergeSuiteGate(
    { repoDir: "/repo", mergedCommit: MG_SHA, runsPlanSuite: false },
    {
      run,
      worktreesRoot,
      installTimeoutMs: 2_000,
      suiteDeadlineMs: 2_000,
      spawnFn,
    },
  );
  expect(verdict.kind).toBe("red");
  if (verdict.kind === "red") {
    expect(verdict.detail).toContain("suite crashed");
  }
  rmSync(worktreesRoot, { recursive: true, force: true });
});

test("fn-1213 runMergeSuiteGate: a passing suite (exit 0) maps to green", async () => {
  const { run } = makeMergeSuiteGit();
  const worktreesRoot = mkdtempSync(join(tmpdir(), "keeper-mg-green-"));
  const { spawnFn } = makeQueuedSpawn([
    resolved(0), // install
    resolved(0, "2 pass\n0 fail\n"), // gate: clean
  ]);
  const verdict = await runMergeSuiteGate(
    { repoDir: "/repo", mergedCommit: MG_SHA, runsPlanSuite: false },
    {
      run,
      worktreesRoot,
      installTimeoutMs: 2_000,
      suiteDeadlineMs: 2_000,
      spawnFn,
    },
  );
  expect(verdict).toEqual({ kind: "green" });
  rmSync(worktreesRoot, { recursive: true, force: true });
});

test("fn-1213 runMergeSuiteGate: root green + runsPlanSuite=true chains the plan-package suite (runPackageSuiteGate runs on plugins/plan)", async () => {
  const { run } = makeMergeSuiteGit({
    planPkgJson: { scripts: { test: "true" } },
  });
  const worktreesRoot = mkdtempSync(join(tmpdir(), "keeper-mg-chain-"));
  const { spawnFn, calls } = makeQueuedSpawn([
    resolved(0), // root install
    resolved(0, "1 pass\n0 fail\n"), // root gate: clean
    resolved(0), // plan install
    resolved(0, "1 pass\n0 fail\n"), // plan gate: clean
  ]);
  const verdict = await runMergeSuiteGate(
    { repoDir: "/repo", mergedCommit: MG_SHA, runsPlanSuite: true },
    {
      run,
      worktreesRoot,
      installTimeoutMs: 2_000,
      suiteDeadlineMs: 2_000,
      spawnFn,
    },
  );
  expect(verdict).toEqual({ kind: "green" });
  expect(calls.length).toBe(4); // root install+gate, THEN plan install+gate
  expect(calls[2]?.cwd.endsWith("plugins/plan")).toBe(true);
  expect(calls[3]?.cwd.endsWith("plugins/plan")).toBe(true);
  rmSync(worktreesRoot, { recursive: true, force: true });
});

test("fn-1213 runMergeSuiteGate: the scratch worktree is reaped on EVERY verdict path — green, red, cannot-run, and a thrown provision error", async () => {
  const worktreesRoot = mkdtempSync(join(tmpdir(), "keeper-mg-reap-"));

  // green
  {
    const { run, cmds } = makeMergeSuiteGit();
    const { spawnFn } = makeQueuedSpawn([
      resolved(0),
      resolved(0, "1 pass\n0 fail\n"),
    ]);
    const verdict = await runMergeSuiteGate(
      { repoDir: "/repo", mergedCommit: MG_SHA, runsPlanSuite: false },
      {
        run,
        worktreesRoot,
        installTimeoutMs: 2_000,
        suiteDeadlineMs: 2_000,
        spawnFn,
      },
    );
    expect(verdict.kind).toBe("green");
    expect(cmds.some((c) => c[0] === "worktree" && c[1] === "prune")).toBe(
      true,
    );
  }

  // red
  {
    const { run, cmds } = makeMergeSuiteGit();
    const { spawnFn } = makeQueuedSpawn([
      resolved(0),
      resolved(1, "no failing-test signal at all"),
    ]);
    const verdict = await runMergeSuiteGate(
      { repoDir: "/repo", mergedCommit: MG_SHA, runsPlanSuite: false },
      {
        run,
        worktreesRoot,
        installTimeoutMs: 2_000,
        suiteDeadlineMs: 2_000,
        spawnFn,
      },
    );
    expect(verdict.kind).toBe("red");
    expect(cmds.some((c) => c[0] === "worktree" && c[1] === "prune")).toBe(
      true,
    );
  }

  // cannot-run
  {
    const { run, cmds } = makeMergeSuiteGit();
    const { spawnFn } = makeQueuedSpawn([resolved(1)]);
    const verdict = await runMergeSuiteGate(
      { repoDir: "/repo", mergedCommit: MG_SHA, runsPlanSuite: false },
      {
        run,
        worktreesRoot,
        installTimeoutMs: 2_000,
        suiteDeadlineMs: 2_000,
        spawnFn,
      },
    );
    expect(verdict.kind).toBe("cannot-run");
    expect(cmds.some((c) => c[0] === "worktree" && c[1] === "prune")).toBe(
      true,
    );
  }

  // thrown — an unexpected git failure inside provisionScratchWorktree
  {
    const { run, cmds } = makeMergeSuiteGit({ throwOnHead: true });
    const { spawnFn } = makeQueuedSpawn([]);
    const verdict = await runMergeSuiteGate(
      { repoDir: "/repo", mergedCommit: MG_SHA, runsPlanSuite: false },
      {
        run,
        worktreesRoot,
        installTimeoutMs: 2_000,
        suiteDeadlineMs: 2_000,
        spawnFn,
      },
    );
    expect(verdict.kind).toBe("cannot-run");
    if (verdict.kind === "cannot-run") {
      expect(verdict.detail).toContain("merge-suite gate error");
    }
    expect(cmds.some((c) => c[0] === "worktree" && c[1] === "prune")).toBe(
      true,
    );
  }

  rmSync(worktreesRoot, { recursive: true, force: true });
});

test("fn-1213 readPkgGateCommand: reads the gate-phase segment of a real package.json's test script, and null for none", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-mg-pkgcmd-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      scripts: { test: "bun scripts/test-gate.ts && bun run test:opentui" },
    }),
  );
  expect(readPkgGateCommand(dir)).toBe("bun scripts/test-gate.ts");

  const emptyDir = mkdtempSync(join(tmpdir(), "keeper-mg-pkgcmd-empty-"));
  writeFileSync(
    join(emptyDir, "package.json"),
    JSON.stringify({ scripts: {} }),
  );
  expect(readPkgGateCommand(emptyDir)).toBeNull();

  const missingDir = mkdtempSync(join(tmpdir(), "keeper-mg-pkgcmd-missing-"));
  expect(readPkgGateCommand(missingDir)).toBeNull();

  rmSync(dir, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
  rmSync(missingDir, { recursive: true, force: true });
});

test("fn-1213 runPackageSuiteGate: driven directly against a real tmp pkgDir through the injected spawnFn seam", async () => {
  const pkgDir = mkdtempSync(join(tmpdir(), "keeper-mg-pkggate-"));
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ scripts: { test: "true" } }),
  );
  const { spawnFn } = makeQueuedSpawn([
    resolved(0), // install
    resolved(0, "1 pass\n0 fail\n"), // gate: clean
  ]);
  const verdict = await runPackageSuiteGate(pkgDir, {
    installTimeoutMs: 2_000,
    suiteDeadlineMs: 2_000,
    spawnFn,
  });
  expect(verdict).toEqual({ kind: "green" });
  rmSync(pkgDir, { recursive: true, force: true });
});

test("fn-993 finalizeEpic: a NON-FAST-FORWARD remote (origin ahead) → operator-visible STICKY block (no retry), no merge/push/fetch", async () => {
  // EDGE-3: an origin-ahead non-ff genuinely needs an operator to reconcile origin
  // (no fetch/rebase/force on the shared checkout). UNLIKE the transient
  // dirty/off-branch/not-turn-key skips, it mints a VISIBLE sticky DispatchFailed
  // (retry !== true) so it is no longer silent. The reason stays
  // `worktree-finalize-*` (outside the recover auto-clear prefix), so the
  // level-triggered clear never dismisses a genuine origin-ahead block.
  const { run, cmds } = makeFinalizeReadinessRun({ remoteAhead: true });
  const res = await createWorktreeDriver(run).finalizeEpic(
    makeFinalizeInfo(),
    async () => true,
  );
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.retry).not.toBe(true); // STICKY — surfaces a close-row failure
    expect(res.reason).toContain("worktree-finalize-non-fast-forward");
    expect(isWorktreeRecoverReason(res.reason)).toBe(false);
  }
  // Never an auto-fetch / rebase / force, and the base merge is skipped entirely.
  expect(cmds.some((c) => c.startsWith("fetch"))).toBe(false);
  expect(cmds.some((c) => c.startsWith("merge --no-edit"))).toBe(false);
  expect(cmds.some((c) => c === "push")).toBe(false);
  expect(cmds.some((c) => c.startsWith("push origin"))).toBe(false);
});

test("fn-993 runReconcileCycle: a non-ff finalize (origin ahead) mints an operator-visible sticky DispatchFailed end-to-end", async () => {
  // EDGE-3 end-to-end: the real finalize routine hits the non-ff degrade and the
  // producer seam turns its non-retry result into a VISIBLE close-row failure — an
  // origin-ahead block is no longer silent. The reason stays worktree-finalize-*.
  const { run } = makeFinalizeReadinessRun({ remoteAhead: true });
  const { deps, log: depsLog } = makeFakeDeps({
    worktree: createWorktreeDriver(run),
  });
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo",
    status: "done",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        runtime_status: "done",
        worker_phase: "done",
      }),
    ],
  });
  const snap = makeSnapshot({ epics: [epic], worktreeMode: true });

  await runReconcileCycle(
    reconcile(snap, makeState(), 0),
    makeState(),
    new Map<string, LiveDispatch>(),
    "/bin/zsh",
    new AbortController().signal,
    deps,
  );

  expect(depsLog.emissions).toHaveLength(1);
  expect(depsLog.emissions[0]).toMatchObject({
    verb: "close",
    id: worktreeFinalizeDispatchId("fn-1-foo", "/repo"),
  });
  expect(depsLog.emissions[0]?.reason).toContain(
    "worktree-finalize-non-fast-forward",
  );
  expect(isWorktreeRecoverReason(depsLog.emissions[0]?.reason ?? "")).toBe(
    false,
  );
});

test("fn-988 finalizeEpic: no origin remote (non-turn-key push) → distinct non-sticky skip-retry, no merge/push", async () => {
  const { run, cmds } = makeFinalizeReadinessRun({ noRemote: true });
  const res = await createWorktreeDriver(run).finalizeEpic(
    makeFinalizeInfo(),
    async () => true,
  );
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.retry).toBe(true); // NON-sticky
    expect(res.reason).toContain("worktree-finalize-push-not-turn-key");
    // Finalize-side reason MUST NOT carry the recover prefix (else auto-cleared).
    expect(res.reason.startsWith("worktree-recover")).toBe(false);
    expect(isWorktreeRecoverReason(res.reason)).toBe(false);
  }
  // The merge is skipped entirely — never merge-then-die on the push.
  expect(cmds.some((c) => c.startsWith("merge --no-edit"))).toBe(false);
  expect(cmds.some((c) => c === "push")).toBe(false);
});

test("fn-988 finalizeEpic: no @{push} target (non-turn-key push) → non-sticky skip-retry, no merge", async () => {
  const { run, cmds } = makeFinalizeReadinessRun({ noPushTarget: true });
  const res = await createWorktreeDriver(run).finalizeEpic(
    makeFinalizeInfo(),
    async () => true,
  );
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.retry).toBe(true);
    expect(res.reason).toContain("worktree-finalize-push-not-turn-key");
    expect(isWorktreeRecoverReason(res.reason)).toBe(false);
  }
  expect(cmds.some((c) => c.startsWith("merge --no-edit"))).toBe(false);
  expect(cmds.some((c) => c === "push")).toBe(false);
});

test("fn-988 finalizeEpic: push --dry-run rejected (would-prompt) → non-sticky skip-retry, no merge", async () => {
  const { run, cmds } = makeFinalizeReadinessRun({
    dryRunReject: "fatal: Authentication failed for 'https://host/repo.git'",
  });
  const res = await createWorktreeDriver(run).finalizeEpic(
    makeFinalizeInfo(),
    async () => true,
  );
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.retry).toBe(true);
    expect(res.reason).toContain("worktree-finalize-push-not-turn-key");
    expect(res.reason).toContain("auth"); // classifyPushError reuse surfaces the class
    expect(isWorktreeRecoverReason(res.reason)).toBe(false);
  }
  expect(cmds.some((c) => c.startsWith("merge --no-edit"))).toBe(false);
  expect(cmds.some((c) => c === "push")).toBe(false);
});

test("fn-1140 finalizeEpic: a push TIMEOUT after the ref advance → transient skip-retry (worktree-finalize-push-timeout), NOT the sticky push-failed, no teardown", async () => {
  // The plumbing merge advances the ref locally but the push spawn times out (the
  // GNU-timeout sentinel). That is a TRANSIENT stall → retry:true + a distinct
  // timeout reason OUTSIDE the recover auto-clear scope, never the sticky push-failed.
  const { run, cmds } = makeMergeGit({ pushTimeout: true });
  const res = await createWorktreeDriver(run, () => ({
    release() {},
  })).finalizeEpic(makeFinalizeInfo(), async () => true);
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.retry).toBe(true); // TRANSIENT, never sticky
    expect(res.reason).toContain("worktree-finalize-push-timeout");
    expect(res.reason).not.toContain("push-failed");
    expect(isWorktreeRecoverReason(res.reason)).toBe(false);
  }
  // No teardown after a failed push — the lanes survive for the retry.
  expect(cmds.some((c) => c.startsWith("worktree remove"))).toBe(false);
});

test("fn-985 finalizeEpic idempotent: a re-run after a post-push partial failure RESUMES teardown (already-merged base, lane still registered)", async () => {
  // The first run merged + pushed but crashed before teardown — so the merge is now
  // an ancestor of default (already-merged no-op) and the working tree is CLEAN, yet
  // the base worktree + branch still linger. The re-run must resume teardown.
  const cmds: string[] = [];
  const run: Parameters<typeof createWorktreeDriver>[0] = async (args) => {
    const joined = args.join(" ");
    cmds.push(joined);
    if (isInProgressPseudoRefProbe(args)) {
      return { code: 1, stdout: "", stderr: "" }; // clean: in-progress pseudo-ref absent
    }
    if (args[0] === "rev-parse" && args.includes("--verify")) {
      return { code: 0, stdout: "abc\n", stderr: "" };
    }
    if (args[0] === "show") {
      return {
        code: 0,
        stdout: JSON.stringify({ id: "fn-1-foo", status: "done" }),
        stderr: "",
      };
    }
    if (joined.startsWith("symbolic-ref")) {
      return { code: 0, stdout: "origin/main\n", stderr: "" };
    }
    if (joined === "rev-parse --abbrev-ref HEAD") {
      return { code: 0, stdout: "main\n", stderr: "" };
    }
    if (joined.startsWith("status --porcelain")) {
      return { code: 0, stdout: "", stderr: "" }; // the prior merge is COMMITTED → clean
    }
    if (joined.startsWith("worktree list")) {
      return {
        code: 0,
        stdout:
          "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
          "worktree /repo.worktrees/keeper-epic-fn-1-foo\nHEAD y\nbranch refs/heads/keeper/epic/fn-1-foo\n\n",
        stderr: "",
      };
    }
    if (joined.startsWith("merge-base --is-ancestor")) {
      return { code: 0, stdout: "", stderr: "" }; // already-merged + ff + prune gates
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const res = await createWorktreeDriver(run).finalizeEpic(
    makeFinalizeInfo(),
    async () => true,
  );
  expect(res).toEqual({ ok: true });
  // The merge was the idempotent no-op (already an ancestor → no `merge --no-edit`),
  // and teardown RESUMED: the lingering base worktree + branch were cleaned up.
  expect(cmds.some((c) => c.startsWith("merge --no-edit"))).toBe(false);
  expect(cmds).toContain(
    "worktree remove /repo.worktrees/keeper-epic-fn-1-foo",
  );
  expect(cmds).toContain("branch -D keeper/epic/fn-1-foo");
});

// ---------------------------------------------------------------------------
// fn-1014 — the EPHEMERAL cross-epic merge-gate (computeDeferredEpicIds + the
// reconcile continue-arms). A dependent epic B's lane MUST NOT be cut until every
// satisfied same-resolved-repo upstream is contained in LOCAL default.
// ---------------------------------------------------------------------------

/** A satisfied (done) resolved-dep on `upstreamId`. */
function satisfiedEpicDep(upstreamId: string): ResolvedEpicDep {
  return {
    dep_token: upstreamId,
    resolved_epic_id: upstreamId,
    epic_number: null,
    project_basename: null,
    cross_project: false,
    state: "satisfied",
  };
}

/** A blocked-incomplete (upstream resolved but still OPEN) resolved-dep on `upstreamId`. */
function blockedEpicDep(upstreamId: string): ResolvedEpicDep {
  return { ...satisfiedEpicDep(upstreamId), state: "blocked-incomplete" };
}

/** Identity-resolved classification (raw root == toplevel) — same as makeSnapshot. */
function classifyIdentity(epics: Epic[]): Map<string, WorktreeRepoResolution> {
  return classifyWorktreeRepos(epics, (r) => r);
}

/**
 * Identity-resolved classification with the multi-repo rollout flag ON — a
 * `>1`-toplevel epic partitions into `clustered` per-repo lane groups (worktree
 * eligible by default) instead of the whole-epic `multi-repo` reject.
 */
function classifyMultiRepo(epics: Epic[]): Map<string, WorktreeRepoResolution> {
  return classifyWorktreeRepos(epics, (r) => r, undefined, undefined, true);
}

/**
 * A rule-driven git runner for the merge-gate probe. `lanes` are the present
 * `keeper/epic/*` short-names (the enumeration); `enumError` fails the enumeration;
 * `ancestors` are the lane branches that are ancestors of LOCAL default (merged);
 * `ancestryTimeout` makes EVERY ancestry probe surface the 124 SIGKILL sentinel.
 */
function gateGit(opts: {
  lanes?: string[];
  enumError?: boolean;
  ancestors?: string[];
  ancestryTimeout?: boolean;
  defaultBranch?: string;
}): ReturnType<typeof fakeAsyncGit> {
  const def = opts.defaultBranch ?? "main";
  const rules: FakeGitRule[] = [];
  // Lane enumeration — MUST precede the resolveDefaultBranch `refs/heads` fallback.
  rules.push({
    when: (a) =>
      argvStartsWith(a, "for-each-ref") && argvHas(a, "refs/heads/keeper/epic"),
    result: opts.enumError
      ? { exitCode: 1 }
      : { exitCode: 0, stdout: (opts.lanes ?? []).join("\n") },
  });
  // Default-branch resolve via origin/HEAD symbolic-ref → origin/<def>.
  rules.push({
    when: (a) => argvStartsWith(a, "symbolic-ref"),
    result: { exitCode: 0, stdout: `origin/${def}\n` },
  });
  // Per-lane ancestry: exit 0 (merged) for a branch in `ancestors`, else exit 1
  // (or the timeout sentinel) — both of the latter DEFER.
  for (const lane of opts.ancestors ?? []) {
    rules.push({
      when: (a) =>
        argvStartsWith(a, "merge-base", "--is-ancestor") && a[2] === lane,
      result: { exitCode: 0 },
    });
  }
  rules.push({
    when: (a) => argvStartsWith(a, "merge-base", "--is-ancestor"),
    result: opts.ancestryTimeout
      ? { exitCode: GIT_SPAWN_TIMEOUT_CODE }
      : { exitCode: 1 },
  });
  return fakeAsyncGit(rules);
}

/**
 * A CWD-AWARE merge-probe git runner: unlike {@link gateGit} (argv-only rules),
 * this keys its enumeration + ancestry verdict on the spawn `cwd` (the repo dir),
 * so a clustered epic's per-group probes across DIFFERENT repos can differ (repo-a
 * merged while repo-b is not). Per-repo config mirrors `gateGit`'s knobs.
 */
function clusterGit(
  perRepo: Record<
    string,
    {
      lanes?: string[];
      ancestors?: string[];
      enumError?: boolean;
      ancestryTimeout?: boolean;
    }
  >,
  defaultBranch = "main",
): { run: GitRunner; calls: Array<{ args: string[]; cwd?: string }> } {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const run: GitRunner = async (
    args: string[],
    options: GitExecOptions = {},
  ) => {
    const cwd = options.cwd ?? "";
    calls.push({ args: [...args], cwd });
    const cfg = perRepo[cwd] ?? {};
    if (
      argvStartsWith(args, "for-each-ref") &&
      argvHas(args, "refs/heads/keeper/epic")
    ) {
      return cfg.enumError
        ? { code: 1, stdout: "", stderr: "" }
        : { code: 0, stdout: (cfg.lanes ?? []).join("\n"), stderr: "" };
    }
    if (argvStartsWith(args, "symbolic-ref")) {
      return { code: 0, stdout: `origin/${defaultBranch}\n`, stderr: "" };
    }
    if (argvStartsWith(args, "merge-base", "--is-ancestor")) {
      if (cfg.ancestryTimeout) {
        return { code: GIT_SPAWN_TIMEOUT_CODE, stdout: "", stderr: "" };
      }
      return {
        code: (cfg.ancestors ?? []).includes(args[2] ?? "") ? 0 : 1,
        stdout: "",
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

test("fn-1014 computeDeferredEpicIds: a same-repo upstream PRESENT ∧ ancestor of local default → NOT deferred", async () => {
  const a = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [satisfiedEpicDep("fn-1-a")],
  });
  const epics = [a, b];
  const { run } = gateGit({
    lanes: ["keeper/epic/fn-1-a"],
    ancestors: ["keeper/epic/fn-1-a"], // merged into local default
  });
  const deferred = await computeDeferredEpicIds(
    epics,
    classifyIdentity(epics),
    run,
  );
  expect(deferred.has("fn-2-b")).toBe(false);
});

test("fn-1014 computeDeferredEpicIds: a same-repo upstream PRESENT ∧ NOT an ancestor → DEFERRED (unmerged)", async () => {
  const a = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [satisfiedEpicDep("fn-1-a")],
  });
  const epics = [a, b];
  const { run } = gateGit({ lanes: ["keeper/epic/fn-1-a"], ancestors: [] });
  const deferred = await computeDeferredEpicIds(
    epics,
    classifyIdentity(epics),
    run,
  );
  expect(deferred.has("fn-2-b")).toBe(true);
});

test("fn-1014 computeDeferredEpicIds: a DEFINITIVELY ABSENT lane (enumeration ok) → NOT deferred (merged-and-torn-down), no ancestry probe", async () => {
  const a = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [satisfiedEpicDep("fn-1-a")],
  });
  const epics = [a, b];
  const { run, calls } = gateGit({ lanes: [] }); // enumeration ok, A's lane gone
  const deferred = await computeDeferredEpicIds(
    epics,
    classifyIdentity(epics),
    run,
  );
  expect(deferred.has("fn-2-b")).toBe(false);
  // A definitively-absent lane short-circuits to satisfied WITHOUT an ancestry probe.
  expect(calls.some((c) => argvStartsWith(c.args, "merge-base"))).toBe(false);
});

test("fn-1014 computeDeferredEpicIds: an enumeration FAILURE → DEFERRED (never read as absent)", async () => {
  const a = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [satisfiedEpicDep("fn-1-a")],
  });
  const epics = [a, b];
  const { run } = gateGit({ enumError: true });
  const deferred = await computeDeferredEpicIds(
    epics,
    classifyIdentity(epics),
    run,
  );
  expect(deferred.has("fn-2-b")).toBe(true);
});

test("fn-1014 computeDeferredEpicIds: an ancestry TIMEOUT (124) on a present lane → DEFERRED (inconclusive ≠ merged)", async () => {
  const a = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [satisfiedEpicDep("fn-1-a")],
  });
  const epics = [a, b];
  const { run } = gateGit({
    lanes: ["keeper/epic/fn-1-a"],
    ancestryTimeout: true,
  });
  const deferred = await computeDeferredEpicIds(
    epics,
    classifyIdentity(epics),
    run,
  );
  expect(deferred.has("fn-2-b")).toBe(true);
});

test("fn-1014 computeDeferredEpicIds: multi-upstream UNION — one unmerged same-repo upstream defers B", async () => {
  const a1 = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const a2 = makeEpic({ epic_id: "fn-1-c", project_dir: "/repo" });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [
      satisfiedEpicDep("fn-1-a"),
      satisfiedEpicDep("fn-1-c"),
    ],
  });
  const epics = [a1, a2, b];
  const { run } = gateGit({
    lanes: ["keeper/epic/fn-1-a", "keeper/epic/fn-1-c"],
    ancestors: ["keeper/epic/fn-1-a"], // a1 merged, a2 NOT → union defers
  });
  const deferred = await computeDeferredEpicIds(
    epics,
    classifyIdentity(epics),
    run,
  );
  expect(deferred.has("fn-2-b")).toBe(true);
});

test("fn-1014 computeDeferredEpicIds: a CROSS-REPO upstream never gates (no enumeration, decided by resolved toplevel not cross_project)", async () => {
  const a = makeEpic({ epic_id: "fn-1-a", project_dir: "/other" }); // a DIFFERENT toplevel
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    // cross_project FALSE on purpose — the gate must decide on the RESOLVED repo,
    // never this flag (two epics can share a repo across project basenames).
    resolved_epic_deps: [satisfiedEpicDep("fn-1-a")],
  });
  const epics = [a, b];
  const { run, calls } = gateGit({
    lanes: ["keeper/epic/fn-1-a"],
    ancestors: [],
  });
  const deferred = await computeDeferredEpicIds(
    epics,
    classifyIdentity(epics),
    run,
  );
  expect(deferred.has("fn-2-b")).toBe(false);
  // The same-repo gate short-circuits BEFORE any per-repo enumeration.
  expect(
    calls.some(
      (c) =>
        argvStartsWith(c.args, "for-each-ref") &&
        argvHas(c.args, "refs/heads/keeper/epic"),
    ),
  ).toBe(false);
});

test("fn-1014 computeDeferredEpicIds: B's OWN repo unresolved → skipped (never deferred, never probed)", async () => {
  const a = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [satisfiedEpicDep("fn-1-a")],
  });
  const epics = [a, b];
  const map = classifyIdentity(epics);
  map.set("fn-2-b", { kind: "unresolved", reason: "test: B unresolved" });
  const { run, calls } = gateGit({
    lanes: ["keeper/epic/fn-1-a"],
    ancestors: [],
  });
  const deferred = await computeDeferredEpicIds(epics, map, run);
  expect(deferred.has("fn-2-b")).toBe(false);
  expect(calls.length).toBe(0); // a non-`ok` B is skipped before any git
});

test("fn-1014 computeDeferredEpicIds: a DISABLED / reaped / dangling / blocked-absent upstream never gates (folds to skip)", async () => {
  // A `disabled` upstream cut no lane (its work landed straight on shared-checkout
  // default → already contained); a reaped (absent) one, a dangling (null) edge, and
  // a still-open dep that cut NO same-repo lane all fold to "skip this upstream"
  // (not-gating). A blocked-incomplete upstream WITH a same-repo lane DOES gate — see
  // the fn-1130 tests below.
  const aDisabled = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [
      satisfiedEpicDep("fn-1-a"), // resolved to a `disabled` upstream below
      { ...satisfiedEpicDep("fn-1-gone"), resolved_epic_id: null }, // dangling
      { ...satisfiedEpicDep("fn-1-reaped") }, // absent from the classification map
      blockedEpicDep("fn-1-wip"), // blocked-incomplete AND absent from the map → no lane
    ],
  });
  const epics = [aDisabled, b];
  const map = classifyIdentity(epics);
  map.set("fn-1-a", { kind: "disabled", repoDir: "/repo", reason: "serial" });
  const { run } = gateGit({ lanes: ["keeper/epic/fn-1-a"], ancestors: [] });
  const deferred = await computeDeferredEpicIds(epics, map, run);
  expect(deferred.has("fn-2-b")).toBe(false);
});

// ---------------------------------------------------------------------------
// fn-1130 — a BLOCKED-INCOMPLETE (still-open) same-resolved-repo-lane upstream also
// defers the dependent's lane cut, probe-free: an open upstream is trivially not yet
// contained in LOCAL default, so cutting off it would fork a stale base. Cross-repo /
// no-lane / dangling blocked upstreams stay not-gating exactly as a satisfied one.
// ---------------------------------------------------------------------------

test("fn-1130 computeDeferredEpicIds: a BLOCKED-INCOMPLETE same-repo-lane upstream DEFERS probe-free (no enumeration/ancestry git)", async () => {
  const a = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [blockedEpicDep("fn-1-a")], // A resolved but still OPEN
  });
  const epics = [a, b];
  const { run, calls } = gateGit({ lanes: ["keeper/epic/fn-1-a"] });
  const deferred = await computeDeferredEpicIds(
    epics,
    classifyIdentity(epics),
    run,
  );
  expect(deferred.get("fn-2-b")?.has("/repo")).toBe(true);
  // Probe-free: an open upstream is definitionally not-yet-merged, so NO git spawns.
  expect(calls.length).toBe(0);
});

test("fn-1130 computeDeferredEpicIds: a BLOCKED-INCOMPLETE CROSS-REPO upstream never gates (lane in a different resolved repo)", async () => {
  const a = makeEpic({ epic_id: "fn-1-a", project_dir: "/other" }); // a DIFFERENT toplevel
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [blockedEpicDep("fn-1-a")],
  });
  const epics = [a, b];
  const { run, calls } = gateGit({ lanes: ["keeper/epic/fn-1-a"] });
  const deferred = await computeDeferredEpicIds(
    epics,
    classifyIdentity(epics),
    run,
  );
  expect(deferred.has("fn-2-b")).toBe(false);
  expect(calls.length).toBe(0);
});

test("fn-1130 computeDeferredEpicIds: a BLOCKED-INCOMPLETE same-repo upstream that cut NO lane (disabled/serial) never gates", async () => {
  const aDisabled = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [blockedEpicDep("fn-1-a")],
  });
  const epics = [aDisabled, b];
  const map = classifyIdentity(epics);
  // A is same-repo but SERIAL (no worktree lane) → never gates, open or done.
  map.set("fn-1-a", { kind: "disabled", repoDir: "/repo", reason: "serial" });
  const { run, calls } = gateGit({ lanes: [] });
  const deferred = await computeDeferredEpicIds(epics, map, run);
  expect(deferred.has("fn-2-b")).toBe(false);
  expect(calls.length).toBe(0);
});

test("fn-1130 computeDeferredEpicIds: a CLUSTERED blocked-incomplete upstream defers ONLY the shared-repo group; the sibling group proceeds", async () => {
  // Upstream A cut a lane only in /r1 and is still OPEN. Downstream B spans {/r1,/r2}:
  // B's /r1 group shares A's open lane → defer probe-free; B's /r2 group has no
  // same-repo upstream → proceed. Mirrors the satisfied-unmerged clustered split.
  const a = makeEpic({
    epic_id: "fn-1-a",
    project_dir: "/r1",
    tasks: [
      makeTask({ task_id: "fn-1-a.1", epic_id: "fn-1-a", target_repo: "/r1" }),
    ],
  });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/r1",
    resolved_epic_deps: [blockedEpicDep("fn-1-a")],
    tasks: [
      makeTask({ task_id: "fn-2-b.1", epic_id: "fn-2-b", target_repo: "/r1" }),
      makeTask({ task_id: "fn-2-b.2", epic_id: "fn-2-b", target_repo: "/r2" }),
    ],
  });
  const epics = [a, b];
  const { run } = gateGit({ lanes: ["keeper/epic/fn-1-a"] });
  const deferred = await computeDeferredEpicIds(
    epics,
    classifyMultiRepo(epics),
    run,
  );
  expect(deferred.get("fn-2-b")?.has("/r1")).toBe(true);
  expect(deferred.get("fn-2-b")?.has("/r2") ?? false).toBe(false);
});

// ---------------------------------------------------------------------------
// fn-1034 — the PER-(epic, repoDir) generalization of the merge-gate: a clustered
// multi-repo downstream defers only the GROUP whose repo has an unmerged same-repo
// upstream; sibling groups (and cross-repo upstreams) proceed independently.
// ---------------------------------------------------------------------------

test("fn-1034 computeDeferredEpicIds: a CLUSTERED downstream defers ONLY the group whose repo has an unmerged same-repo upstream; the sibling group proceeds", async () => {
  // Upstream A cut a lane only in /r1. Downstream B spans {/r1, /r2}: B's /r1 group
  // shares A's repo (unmerged) → defer; B's /r2 group has NO same-repo upstream →
  // proceed.
  const a = makeEpic({
    epic_id: "fn-1-a",
    project_dir: "/r1",
    tasks: [
      makeTask({ task_id: "fn-1-a.1", epic_id: "fn-1-a", target_repo: "/r1" }),
    ],
  });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/r1",
    resolved_epic_deps: [satisfiedEpicDep("fn-1-a")],
    tasks: [
      makeTask({ task_id: "fn-2-b.1", epic_id: "fn-2-b", target_repo: "/r1" }),
      makeTask({ task_id: "fn-2-b.2", epic_id: "fn-2-b", target_repo: "/r2" }),
    ],
  });
  const epics = [a, b];
  const { run } = gateGit({ lanes: ["keeper/epic/fn-1-a"], ancestors: [] });
  const deferred = await computeDeferredEpicIds(
    epics,
    classifyMultiRepo(epics),
    run,
  );
  // The /r1 group defers (A's r1 base is present-but-not-ancestor); /r2 proceeds.
  expect(deferred.get("fn-2-b")?.has("/r1")).toBe(true);
  expect(deferred.get("fn-2-b")?.has("/r2") ?? false).toBe(false);
});

test("fn-1034 computeDeferredEpicIds: a CLUSTERED upstream with unmerged lanes gates EACH of B's matching groups (per-repo union)", async () => {
  // Both A and B span {/r1, /r2}. A cut a lane in BOTH, neither merged → both of B's
  // groups share an unmerged same-repo upstream group → both deferred.
  const a = makeEpic({
    epic_id: "fn-1-a",
    project_dir: "/r1",
    tasks: [
      makeTask({ task_id: "fn-1-a.1", epic_id: "fn-1-a", target_repo: "/r1" }),
      makeTask({ task_id: "fn-1-a.2", epic_id: "fn-1-a", target_repo: "/r2" }),
    ],
  });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/r1",
    resolved_epic_deps: [satisfiedEpicDep("fn-1-a")],
    tasks: [
      makeTask({ task_id: "fn-2-b.1", epic_id: "fn-2-b", target_repo: "/r1" }),
      makeTask({ task_id: "fn-2-b.2", epic_id: "fn-2-b", target_repo: "/r2" }),
    ],
  });
  const epics = [a, b];
  const { run } = gateGit({ lanes: ["keeper/epic/fn-1-a"], ancestors: [] });
  const deferred = await computeDeferredEpicIds(
    epics,
    classifyMultiRepo(epics),
    run,
  );
  expect(deferred.get("fn-2-b")?.has("/r1")).toBe(true);
  expect(deferred.get("fn-2-b")?.has("/r2")).toBe(true);
});

test("fn-1034 computeDeferredEpicIds: a CLUSTERED downstream whose same-repo upstream is MERGED in that repo is NOT deferred (absent-lane sibling proceeds too)", async () => {
  // A merged in /r1 (ancestor of local default); B's /r1 group therefore proceeds,
  // and B's /r2 group (no same-repo upstream) proceeds — B has no deferred group.
  const a = makeEpic({
    epic_id: "fn-1-a",
    project_dir: "/r1",
    tasks: [
      makeTask({ task_id: "fn-1-a.1", epic_id: "fn-1-a", target_repo: "/r1" }),
    ],
  });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/r1",
    resolved_epic_deps: [satisfiedEpicDep("fn-1-a")],
    tasks: [
      makeTask({ task_id: "fn-2-b.1", epic_id: "fn-2-b", target_repo: "/r1" }),
      makeTask({ task_id: "fn-2-b.2", epic_id: "fn-2-b", target_repo: "/r2" }),
    ],
  });
  const epics = [a, b];
  const { run } = gateGit({
    lanes: ["keeper/epic/fn-1-a"],
    ancestors: ["keeper/epic/fn-1-a"], // A's r1 base merged into local default
  });
  const deferred = await computeDeferredEpicIds(
    epics,
    classifyMultiRepo(epics),
    run,
  );
  expect(deferred.has("fn-2-b")).toBe(false);
});

test("fn-1034 reconcile: a CLUSTERED epic defers ONLY the flagged group's work row; the sibling group's task still launches (no whole-epic suppression, no sticky)", () => {
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/r1",
    tasks: [
      makeTask({ task_id: "fn-2-b.1", epic_id: "fn-2-b", target_repo: "/r1" }),
      makeTask({ task_id: "fn-2-b.2", epic_id: "fn-2-b", target_repo: "/r2" }),
    ],
  });
  const snap = makeSnapshot({
    epics: [b],
    // Clustered (rollout flag ON) worktree geometry so each group's rib is its own
    // cap-1 lane key — sibling lanes run concurrently, the whole point of clustering.
    worktreeMode: true,
    worktreeRepoByEpicId: classifyMultiRepo([b]),
    // Only the /r1 group is deferred (its same-repo upstream is unmerged).
    deferredEpicIds: new Map([["fn-2-b", new Set(["/r1"])]]),
  });
  const decision = reconcile(snap, makeState(), 0);
  // The /r1 group's task is held; the /r2 group's task proceeds — targeted, not global.
  expect(
    decision.launches.some((p) => p.verb === "work" && p.id === "fn-2-b.1"),
  ).toBe(false);
  expect(
    decision.launches.some((p) => p.verb === "work" && p.id === "fn-2-b.2"),
  ).toBe(true);
  // A pure `continue` — reconcile mints no sticky / dispatch_failures.
  expect(decision.worktreeFinalize).toEqual([]);
});

// ---------------------------------------------------------------------------
// logMergeGateDeferral — per-key coalesced console.error for a merge-gate
// deferral: a key's first call logs immediately, a repeat within the coalesce
// window is suppressed (counted, not logged), and the first call past the
// window flushes a "+N suppressed" summary and re-arms.
// ---------------------------------------------------------------------------

test("logMergeGateDeferral: first call for a key logs immediately, verbatim", () => {
  const errs: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    errs.push(args.map(String).join(" "));
  };
  try {
    const state = new Map<string, { loggedAt: number; suppressed: number }>();
    logMergeGateDeferral("a@/repo", "hello world", 1_000, state);
    expect(errs).toEqual(["hello world"]);
  } finally {
    console.error = origError;
  }
});

test("logMergeGateDeferral: a repeat within the coalesce window is suppressed, not logged", () => {
  const errs: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    errs.push(args.map(String).join(" "));
  };
  try {
    const state = new Map<string, { loggedAt: number; suppressed: number }>();
    logMergeGateDeferral("a@/repo", "hello world", 1_000, state);
    logMergeGateDeferral("a@/repo", "hello world", 1_500, state);
    logMergeGateDeferral("a@/repo", "hello world", 2_000, state);
    expect(errs).toEqual(["hello world"]);
    expect(state.get("a@/repo")?.suppressed).toBe(2);
  } finally {
    console.error = origError;
  }
});

test("logMergeGateDeferral: the first call past the coalesce window flushes a '+N suppressed' summary and re-arms", () => {
  const errs: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    errs.push(args.map(String).join(" "));
  };
  try {
    const state = new Map<string, { loggedAt: number; suppressed: number }>();
    logMergeGateDeferral("a@/repo", "hello world", 0, state);
    logMergeGateDeferral("a@/repo", "hello world", 10_000, state); // suppressed
    logMergeGateDeferral("a@/repo", "hello world", 20_000, state); // suppressed
    logMergeGateDeferral("a@/repo", "hello world", 61_000, state); // past the 60s window
    expect(errs).toEqual(["hello world", "hello world (+2 suppressed)"]);
    // Re-armed: the flush resets the window start and the suppressed count.
    expect(state.get("a@/repo")).toEqual({ loggedAt: 61_000, suppressed: 0 });
  } finally {
    console.error = origError;
  }
});

test("logMergeGateDeferral: independent keys never suppress each other", () => {
  const errs: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    errs.push(args.map(String).join(" "));
  };
  try {
    const state = new Map<string, { loggedAt: number; suppressed: number }>();
    logMergeGateDeferral("a@/repo", "message a", 0, state);
    logMergeGateDeferral("b@/repo", "message b", 0, state);
    logMergeGateDeferral("a@/repo", "message a", 1_000, state); // suppressed, key a
    logMergeGateDeferral("b@/repo", "message b", 1_000, state); // suppressed, key b
    expect(errs).toEqual(["message a", "message b"]);
  } finally {
    console.error = origError;
  }
});

test("logMergeGateDeferral: an unseen key always logs on first call, even against the default shared state", () => {
  const errs: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    errs.push(args.map(String).join(" "));
  };
  try {
    const key = `unique-key-${Date.now()}-${Math.random()}`;
    logMergeGateDeferral(key, "unseen key logs");
    expect(errs).toEqual(["unseen key logs"]);
  } finally {
    console.error = origError;
  }
});

// ---------------------------------------------------------------------------
// fn-1016 — the durable merge-landed observable (computeMergedLaneEntries). An
// `ok` epic's OWN lane probed merged-into-default → an entry; reuses the SAME
// per-repo lane-enumeration + ancestry probes as the merge-gate.
// ---------------------------------------------------------------------------

test("fn-1016 computeMergedLaneEntries: a lane PRESENT ∧ ancestor of local default → MERGED", async () => {
  const a = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const epics = [a];
  const { run } = gateGit({
    lanes: ["keeper/epic/fn-1-a"],
    ancestors: ["keeper/epic/fn-1-a"], // merged into local default
  });
  const entries = await computeMergedLaneEntries(
    epics,
    classifyIdentity(epics),
    run,
  );
  expect(entries).toEqual([{ epic_id: "fn-1-a", repo_dir: "/repo" }]);
});

test("fn-1016 computeMergedLaneEntries: a lane PRESENT ∧ NOT an ancestor → NOT merged (an unmerged-but-done epic)", async () => {
  const a = makeEpic({
    epic_id: "fn-1-a",
    project_dir: "/repo",
    status: "done",
  });
  const epics = [a];
  const { run } = gateGit({ lanes: ["keeper/epic/fn-1-a"], ancestors: [] });
  const entries = await computeMergedLaneEntries(
    epics,
    classifyIdentity(epics),
    run,
  );
  expect(entries).toEqual([]);
});

test("fn-1120 computeMergedLaneEntries: a DEFINITIVELY ABSENT lane on a STARTED-but-NOT-done epic → NOT merged (work still landing, `landed` waits)", async () => {
  // The absent arm takes the SAME done-evidence as the present arm: a started epic
  // with an absent lane could be a serial-checkout epic still landing tasks
  // incrementally (the fn-1106 shape) — "started" alone cannot tell it from a
  // finished-and-torn-down epic. Its task ran (runtime `done`) but `worker_phase`
  // is still open → work not terminally done → NOT merged.
  const a = makeEpic({
    epic_id: "fn-1-a",
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-1-a.1", runtime_status: "done" })],
  });
  const epics = [a];
  const { run, calls } = gateGit({ lanes: [] }); // enumeration ok, A's lane gone
  const entries = await computeMergedLaneEntries(
    epics,
    classifyIdentity(epics),
    run,
  );
  expect(entries).toEqual([]);
  // A definitively-absent lane short-circuits BEFORE any ancestry probe.
  expect(calls.some((c) => argvStartsWith(c.args, "merge-base"))).toBe(false);
});

test("fn-1057 computeMergedLaneEntries: a DEFINITIVELY ABSENT lane on a NEVER-STARTED epic → NOT merged (the lane was never cut, so `landed` waits)", async () => {
  // A freshly scaffolded dep-blocked epic: no jobs, no started task. Its lane is
  // absent because it was never cut — inferring merged here fires `landed`
  // spuriously the instant the epic is armed.
  const a = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const epics = [a];
  const { run } = gateGit({ lanes: [] }); // enumeration ok, A's lane absent
  const entries = await computeMergedLaneEntries(
    epics,
    classifyIdentity(epics),
    run,
  );
  expect(entries).toEqual([]);
});

// ---------------------------------------------------------------------------
// fn-1097 — the present-arm EMPTINESS guard. A freshly-cut lane sits AT its fork
// point, a VACUOUS ancestor of default, so a started-but-unworked `ok` epic used
// to read `landed` the instant it was armed. The present arm now reads MERGED
// only once the epic's tasks are administratively done (`worker_phase`), while
// the merged-awaiting-teardown and merged-and-torn-down shapes still read landed.
// ---------------------------------------------------------------------------

test("fn-1097 computeMergedLaneEntries: a STARTED epic with a PRESENT zero-commit lane does NOT read merged (the vacuous-ancestor false-fire)", async () => {
  // A just-dispatched epic: its lane branch exists but carries no commits, so its
  // tip IS its fork point and the ancestry probe is vacuously true. Every task is
  // still running (`worker_phase` open) — the lane carries no landed work, so
  // `landed` must HOLD, not insta-meet at arm time.
  const a = makeEpic({
    epic_id: "fn-1-a",
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-1-a.1", runtime_status: "in_progress" })],
  });
  const epics = [a];
  const { run } = gateGit({
    lanes: ["keeper/epic/fn-1-a"],
    ancestors: ["keeper/epic/fn-1-a"], // vacuously an ancestor (empty lane)
  });
  const entries = await computeMergedLaneEntries(
    epics,
    classifyIdentity(epics),
    run,
  );
  expect(entries).toEqual([]);
});

test("fn-1097 computeMergedLaneEntries: a merged lane AWAITING TEARDOWN (PRESENT ∧ ancestor, all tasks done) still reads landed", async () => {
  // The real merge landed but teardown has not yet deleted the lane. All tasks are
  // administratively done, so the lane carries landed work — the ancestry verdict
  // is trustworthy and the epic reads landed (no regression of this window).
  const a = makeEpic({
    epic_id: "fn-1-a",
    project_dir: "/repo",
    tasks: [
      makeTask({
        task_id: "fn-1-a.1",
        worker_phase: "done",
        runtime_status: "done",
      }),
    ],
  });
  const epics = [a];
  const { run } = gateGit({
    lanes: ["keeper/epic/fn-1-a"],
    ancestors: ["keeper/epic/fn-1-a"],
  });
  const entries = await computeMergedLaneEntries(
    epics,
    classifyIdentity(epics),
    run,
  );
  expect(entries).toEqual([{ epic_id: "fn-1-a", repo_dir: "/repo" }]);
});

test("fn-1097 computeMergedLaneEntries: a merged-and-TORN-DOWN lane (ABSENT, tasks done) still reads landed", async () => {
  // Teardown deleted the lane after the merge. The absent arm reads this MERGED —
  // its done-gate is satisfied (all tasks `worker_phase` done) — no ancestry probe.
  const a = makeEpic({
    epic_id: "fn-1-a",
    project_dir: "/repo",
    tasks: [
      makeTask({
        task_id: "fn-1-a.1",
        worker_phase: "done",
        runtime_status: "done",
      }),
    ],
  });
  const epics = [a];
  const { run, calls } = gateGit({ lanes: [] }); // enumeration ok, lane gone
  const entries = await computeMergedLaneEntries(
    epics,
    classifyIdentity(epics),
    run,
  );
  expect(entries).toEqual([{ epic_id: "fn-1-a", repo_dir: "/repo" }]);
  expect(calls.some((c) => argvStartsWith(c.args, "merge-base"))).toBe(false);
});

test("fn-1097 computeMergedLaneEntries: a NEVER-STARTED epic with a PRESENT vacuous-ancestor lane still never reads landed", async () => {
  // Even if a lane branch exists and is a vacuous ancestor, a never-started epic's
  // tasks are not done, so the lane carries no landed work → `landed` waits.
  const a = makeEpic({
    epic_id: "fn-1-a",
    project_dir: "/repo",
    tasks: [makeTask({ task_id: "fn-1-a.1" })], // open, never started
  });
  const epics = [a];
  const { run } = gateGit({
    lanes: ["keeper/epic/fn-1-a"],
    ancestors: ["keeper/epic/fn-1-a"],
  });
  const entries = await computeMergedLaneEntries(
    epics,
    classifyIdentity(epics),
    run,
  );
  expect(entries).toEqual([]);
});

// ---------------------------------------------------------------------------
// fn-1120 — the absent-arm DONE-gate. An epic that lands its tasks serially on
// the shared checkout (worktree mode ON, no `keeper/epic/<id>` lane ever cut)
// reads its lane ABSENT while still mid-flight. "Started" alone cannot tell it
// from a finished-and-torn-down epic, so the absent arm now takes the SAME
// done-evidence the present arm does (the false-positive observed on fn-1106).
// ---------------------------------------------------------------------------

test("fn-1120 computeMergedLaneEntries: a mid-flight serial epic (some tasks done, one still open) with an absent lane → NOT merged (`landed` holds while it runs)", async () => {
  // The fn-1106 shape: a multi-task epic landing serially on the shared checkout.
  // `.2`/`.3` are administratively done but `.1` is still in progress → work not
  // terminally done → NOT merged, even though the epic is plainly started.
  const a = makeEpic({
    epic_id: "fn-1-a",
    project_dir: "/repo",
    tasks: [
      makeTask({
        task_id: "fn-1-a.1",
        epic_id: "fn-1-a",
        worker_phase: "open",
        runtime_status: "in_progress",
      }),
      makeTask({
        task_id: "fn-1-a.2",
        epic_id: "fn-1-a",
        worker_phase: "done",
        runtime_status: "done",
      }),
      makeTask({
        task_id: "fn-1-a.3",
        epic_id: "fn-1-a",
        worker_phase: "done",
        runtime_status: "done",
      }),
    ],
  });
  const epics = [a];
  const { run } = gateGit({ lanes: [] }); // enumeration ok, no lane ever cut
  const entries = await computeMergedLaneEntries(
    epics,
    classifyIdentity(epics),
    run,
  );
  expect(entries).toEqual([]);
});

test("fn-1120 computeMergedLaneEntries: a FORCE-CLOSED epic (status done, per-task worker_phase never stamped) with an absent lane → MERGED (the absorbing disjunct)", async () => {
  // A force-closed / legacy-imported done epic never advances its per-task
  // `worker_phase` latch. A raw phase-only predicate would permanently
  // false-negative it and hang `await landed`; the absorbing `status === "done"`
  // disjunct keeps "a done epic always reports landed".
  const a = makeEpic({
    epic_id: "fn-1-a",
    project_dir: "/repo",
    status: "done",
    tasks: [makeTask({ task_id: "fn-1-a.1", epic_id: "fn-1-a" })], // worker_phase open
  });
  const epics = [a];
  const { run } = gateGit({ lanes: [] }); // enumeration ok, lane absent
  const entries = await computeMergedLaneEntries(
    epics,
    classifyIdentity(epics),
    run,
  );
  expect(entries).toEqual([{ epic_id: "fn-1-a", repo_dir: "/repo" }]);
});

test("fn-1120 computeMergedLaneEntries: a serial epic with ALL tasks worker_phase done and an absent lane → MERGED (`landed` fires AT done, not before)", async () => {
  // The completion edge: the same multi-task serial epic once EVERY task is
  // administratively done and the lane is torn down → merged-and-torn-down →
  // MERGED. Pins that `landed` fires exactly at done — not while mid-flight
  // (above) and not never.
  const a = makeEpic({
    epic_id: "fn-1-a",
    project_dir: "/repo",
    tasks: [
      makeTask({
        task_id: "fn-1-a.1",
        epic_id: "fn-1-a",
        worker_phase: "done",
        runtime_status: "done",
      }),
      makeTask({
        task_id: "fn-1-a.2",
        epic_id: "fn-1-a",
        worker_phase: "done",
        runtime_status: "done",
      }),
    ],
  });
  const epics = [a];
  const { run, calls } = gateGit({ lanes: [] }); // enumeration ok, lane gone
  const entries = await computeMergedLaneEntries(
    epics,
    classifyIdentity(epics),
    run,
  );
  expect(entries).toEqual([{ epic_id: "fn-1-a", repo_dir: "/repo" }]);
  expect(calls.some((c) => argvStartsWith(c.args, "merge-base"))).toBe(false);
});

test("fn-1016 computeMergedLaneEntries: an enumeration FAILURE → NOT merged (never claim merged off an inconclusive probe)", async () => {
  const a = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const epics = [a];
  const { run } = gateGit({ enumError: true });
  const entries = await computeMergedLaneEntries(
    epics,
    classifyIdentity(epics),
    run,
  );
  expect(entries).toEqual([]);
});

test("fn-1016 computeMergedLaneEntries: an ancestry probe TIMEOUT → NOT merged (collapses to not-ancestor)", async () => {
  const a = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const epics = [a];
  const { run } = gateGit({
    lanes: ["keeper/epic/fn-1-a"],
    ancestryTimeout: true,
  });
  const entries = await computeMergedLaneEntries(
    epics,
    classifyIdentity(epics),
    run,
  );
  expect(entries).toEqual([]);
});

test("fn-1016 computeMergedLaneEntries: a DISABLED / non-`ok` epic has no lane → skipped, never probed", async () => {
  const a = makeEpic({
    epic_id: "fn-1-a",
    project_dir: "/repo",
    status: "done",
  });
  const epics = [a];
  const map = classifyIdentity(epics);
  map.set("fn-1-a", { kind: "disabled", repoDir: "/repo", reason: "serial" });
  const { run, calls } = gateGit({ lanes: ["keeper/epic/fn-1-a"] });
  const entries = await computeMergedLaneEntries(epics, map, run);
  expect(entries).toEqual([]);
  expect(calls.length).toBe(0); // a non-`ok` epic is skipped before any git
});

test("fn-1016 computeMergedLaneEntries: entries are sorted by epic_id (stable serialization for the change-gate)", async () => {
  const b = makeEpic({ epic_id: "fn-2-b", project_dir: "/repo" });
  const a = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const epics = [b, a]; // unsorted input
  const { run } = gateGit({
    lanes: ["keeper/epic/fn-1-a", "keeper/epic/fn-2-b"],
    ancestors: ["keeper/epic/fn-1-a", "keeper/epic/fn-2-b"],
  });
  const entries = await computeMergedLaneEntries(
    epics,
    classifyIdentity(epics),
    run,
  );
  expect(entries.map((e) => e.epic_id)).toEqual(["fn-1-a", "fn-2-b"]);
});

// ---------------------------------------------------------------------------
// fn-1034.4 — computeMergedLaneEntries aggregates a CLUSTERED multi-repo epic:
// the single `epic_id`-keyed row is emitted ONLY once EVERY group has landed
// (worktree groups merged to their default; serial groups' tasks all done).
// ---------------------------------------------------------------------------

test("fn-1034.4 computeMergedLaneEntries: two worktree groups — NO row until BOTH bases merged (never early on the first)", async () => {
  // Tasks done so a merged (present ∧ ancestor) lane genuinely carries landed work
  // — else the empty-lane guard withholds the row per the fn-1097/fn-1141 contract.
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo-a",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        target_repo: "/repo-a",
        worker_phase: "done",
        runtime_status: "done",
      }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        target_repo: "/repo-b",
        worker_phase: "done",
        runtime_status: "done",
      }),
    ],
  });
  const epics = [epic];
  const cls = classifyMultiRepo(epics);
  // /repo-a merged; /repo-b PRESENT but not an ancestor → NOT merged. Aggregate
  // must withhold the epic's row on this partial-landed state.
  const partial = clusterGit({
    "/repo-a": {
      lanes: ["keeper/epic/fn-1-foo"],
      ancestors: ["keeper/epic/fn-1-foo"],
    },
    "/repo-b": { lanes: ["keeper/epic/fn-1-foo"], ancestors: [] },
  });
  expect(await computeMergedLaneEntries(epics, cls, partial.run)).toEqual([]);
  // Now /repo-b lands too → the single row appears, keyed epic_id + primaryRepoDir.
  const both = clusterGit({
    "/repo-a": {
      lanes: ["keeper/epic/fn-1-foo"],
      ancestors: ["keeper/epic/fn-1-foo"],
    },
    "/repo-b": {
      lanes: ["keeper/epic/fn-1-foo"],
      ancestors: ["keeper/epic/fn-1-foo"],
    },
  });
  expect(await computeMergedLaneEntries(epics, cls, both.run)).toEqual([
    { epic_id: "fn-1-foo", repo_dir: "/repo-a" },
  ]);
});

test("fn-1034.4 computeMergedLaneEntries: mixed worktree + serial group — landed waits for the serial tasks done AND the worktree lane merged", async () => {
  // task .1 → /repo-a (worktree), task .2 → /repo-b (serial, not worktree-eligible).
  const mixed = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo-a",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        target_repo: "/repo-a",
      }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        target_repo: "/repo-b",
        worker_phase: "open", // serial group NOT yet done
      }),
    ],
  });
  const withSerialOpen = classifyWorktreeRepos(
    [mixed],
    (r) => r,
    (top) => ({
      eligible: top === "/repo-a",
      reason: `worktree-disabled:no-manifest (${top})`,
    }),
    undefined,
    true,
  );
  // /repo-a's lane merged, but the serial group's task .2 is still open → NO row.
  const aMerged = clusterGit({
    "/repo-a": {
      lanes: ["keeper/epic/fn-1-foo"],
      ancestors: ["keeper/epic/fn-1-foo"],
    },
  });
  expect(
    await computeMergedLaneEntries([mixed], withSerialOpen, aMerged.run),
  ).toEqual([]);

  // Flip BOTH groups' tasks done → both groups landed → the row appears. The
  // worktree group's own task must be done too (its merged lane carries landed work
  // only then — the fn-1097/fn-1141 empty-lane guard now scopes the clustered arm).
  const doneEpic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo-a",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        target_repo: "/repo-a",
        worker_phase: "done",
        runtime_status: "done",
      }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        target_repo: "/repo-b",
        worker_phase: "done",
        runtime_status: "done",
      }),
    ],
  });
  const withSerialDone = classifyWorktreeRepos(
    [doneEpic],
    (r) => r,
    (top) => ({
      eligible: top === "/repo-a",
      reason: `worktree-disabled:no-manifest (${top})`,
    }),
    undefined,
    true,
  );
  expect(
    await computeMergedLaneEntries([doneEpic], withSerialDone, aMerged.run),
  ).toEqual([{ epic_id: "fn-1-foo", repo_dir: "/repo-a" }]);

  // And the converse: serial group done but the worktree lane NOT merged → NO row.
  const aUnmerged = clusterGit({
    "/repo-a": { lanes: ["keeper/epic/fn-1-foo"], ancestors: [] },
  });
  expect(
    await computeMergedLaneEntries([doneEpic], withSerialDone, aUnmerged.run),
  ).toEqual([]);
});

test("fn-1034.4 computeMergedLaneEntries: a single-repo epic is byte-identical with the flag ON (stays `ok`, one probe → one row)", async () => {
  const solo = makeEpic({
    epic_id: "fn-1-solo",
    project_dir: "/repo-a",
    tasks: [
      makeTask({
        task_id: "fn-1-solo.1",
        task_number: 1,
        target_repo: "/repo-a",
        // Tasks done so the present lane genuinely carries landed work (else the
        // empty-lane guard withholds the row — see the fn-1097 block).
        worker_phase: "done",
        runtime_status: "done",
      }),
    ],
  });
  const cls = classifyMultiRepo([solo]); // flag ON — single-repo never clusters
  expect(cls.get("fn-1-solo")?.kind).toBe("ok");
  const { run } = gateGit({
    lanes: ["keeper/epic/fn-1-solo"],
    ancestors: ["keeper/epic/fn-1-solo"],
  });
  expect(await computeMergedLaneEntries([solo], cls, run)).toEqual([
    { epic_id: "fn-1-solo", repo_dir: "/repo-a" },
  ]);
});

// ---------------------------------------------------------------------------
// fn-1141 — the CLUSTERED degenerate-fire guard. The per-`worktree`-group probe
// used to pass `laneCarriesLandedWork: true`, bypassing the fn-1097 empty-lane
// guard: a started-but-unworked group's ABSENT base lane (absent arm off bare
// `started`) or PRESENT zero-commit base lane (a fork-point vacuous ancestor) read a
// spurious merge, so `landed` fired the instant a fresh multi-repo epic's first task
// wave dispatched — zero real merged work. The producer now takes the SAME per-group
// done-evidence the `ok` arm does.
// ---------------------------------------------------------------------------

test("fn-1141 computeMergedLaneEntries: DEGENERATE — a just-dispatched clustered epic (started, 0 done, ABSENT base lanes) does NOT fire landed", async () => {
  // The observed fire: an OPEN multi-repo epic, first task wave in flight (started),
  // no task done, neither repo's base lane cut yet. Zero merged work → NO row.
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo-a",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        target_repo: "/repo-a",
        runtime_status: "in_progress",
      }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        target_repo: "/repo-b",
        runtime_status: "in_progress",
      }),
    ],
  });
  const epics = [epic];
  const { run } = clusterGit({
    "/repo-a": { lanes: [] },
    "/repo-b": { lanes: [] },
  });
  expect(
    await computeMergedLaneEntries(epics, classifyMultiRepo(epics), run),
  ).toEqual([]);
});

test("fn-1141 computeMergedLaneEntries: DEGENERATE — a started clustered epic with PRESENT zero-commit base lanes (vacuous ancestors of default) does NOT fire landed", async () => {
  // The branch==default triviality: a freshly-cut base lane sits AT its fork point, a
  // VACUOUS ancestor of default. With no group's tasks done the lanes carry no landed
  // work, so ancestry alone must NOT read merged.
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo-a",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        target_repo: "/repo-a",
        runtime_status: "in_progress",
      }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        target_repo: "/repo-b",
        runtime_status: "in_progress",
      }),
    ],
  });
  const epics = [epic];
  const { run } = clusterGit({
    "/repo-a": {
      lanes: ["keeper/epic/fn-1-foo"],
      ancestors: ["keeper/epic/fn-1-foo"],
    },
    "/repo-b": {
      lanes: ["keeper/epic/fn-1-foo"],
      ancestors: ["keeper/epic/fn-1-foo"],
    },
  });
  expect(
    await computeMergedLaneEntries(epics, classifyMultiRepo(epics), run),
  ).toEqual([]);
});

test("fn-1141 computeMergedLaneEntries: PARTIAL — one group genuinely merged, the other started-but-unworked with an absent lane → does NOT fire", async () => {
  // /repo-a's group finished and merged; /repo-b's group is still in flight with no
  // lane cut. A partial landing must withhold the epic's single row.
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo-a",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        target_repo: "/repo-a",
        worker_phase: "done",
        runtime_status: "done",
      }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        target_repo: "/repo-b",
        runtime_status: "in_progress",
      }),
    ],
  });
  const epics = [epic];
  const { run } = clusterGit({
    "/repo-a": {
      lanes: ["keeper/epic/fn-1-foo"],
      ancestors: ["keeper/epic/fn-1-foo"],
    },
    "/repo-b": { lanes: [] },
  });
  expect(
    await computeMergedLaneEntries(epics, classifyMultiRepo(epics), run),
  ).toEqual([]);
});

test("fn-1141 computeMergedLaneEntries: a fully-done clustered epic with TORN-DOWN base lanes (absent, all tasks done) still fires landed", async () => {
  // The preserved merged-and-torn-down window, per group: every group's tasks are
  // administratively done and its lane was deleted after merging → still landed.
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo-a",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        target_repo: "/repo-a",
        worker_phase: "done",
        runtime_status: "done",
      }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        target_repo: "/repo-b",
        worker_phase: "done",
        runtime_status: "done",
      }),
    ],
  });
  const epics = [epic];
  const { run } = clusterGit({
    "/repo-a": { lanes: [] },
    "/repo-b": { lanes: [] },
  });
  expect(
    await computeMergedLaneEntries(epics, classifyMultiRepo(epics), run),
  ).toEqual([{ epic_id: "fn-1-foo", repo_dir: "/repo-a" }]);
});

test("fn-1141 computeMergedLaneEntries: a NEVER-STARTED clustered epic with absent base lanes keeps waiting (no spurious landed)", async () => {
  // A freshly scaffolded, dep-blocked multi-repo epic: no task started, no lane cut.
  // Absence proves nothing about merge → `landed` waits.
  const epic = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo-a",
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        target_repo: "/repo-a",
      }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        target_repo: "/repo-b",
      }),
    ],
  });
  const epics = [epic];
  const { run } = clusterGit({
    "/repo-a": { lanes: [] },
    "/repo-b": { lanes: [] },
  });
  expect(
    await computeMergedLaneEntries(epics, classifyMultiRepo(epics), run),
  ).toEqual([]);
});

test("fn-1141 computeLandedEpicIds: worktree mode OFF ignores the lane projection — an OPEN epic degrades to `complete` semantics (done-only), never landed", () => {
  const open = makeEpic({
    epic_id: "fn-1-foo",
    project_dir: "/repo-a",
    tasks: [makeTask({ task_id: "fn-1-foo.1", runtime_status: "in_progress" })],
  });
  const done = makeEpic({
    epic_id: "fn-2-bar",
    project_dir: "/repo-a",
    status: "done",
  });
  // Even a stale projection row naming the open epic is IGNORED when worktree is off;
  // the set is merged ⇔ done, so only the done epic lands.
  expect(
    computeLandedEpicIds(false, ["fn-1-foo", "fn-2-bar"], [open, done]),
  ).toEqual(["fn-2-bar"]);
});

// ---------------------------------------------------------------------------
// fn-1127 — the STALE-BASE lane probe (computeStaleBaseLaneEntries). A SIBLING to
// the merge-gate / merge-landed probes (never modifying them): an already-cut lane
// whose satisfied same-repo upstream's landed work is DEFINITIVELY missing from its
// base is flagged. THE REF TEST DIRECTION is chosen against the fn-1097 vacuous-
// ancestor precedent — `isAncestorOf(A_lane, B_base)` — so an empty/fresh lane reads
// NOT stale, never a false stale; only a definitive not-ancestor (exit 1) flags.
// `gateGit`'s ancestry keys on the ANCESTOR arg (a[2] = A's lane), so its
// `ancestors` list reads here as "A-lanes CONTAINED in B's base" (exit 0 → not
// stale). Every inconclusive arm (enum failure, ancestry timeout, absent refs)
// DEFERS to no-flag. All expected values are hand-computed constants.
// ---------------------------------------------------------------------------

test("fn-1127 computeStaleBaseLaneEntries: a satisfied same-repo upstream DEFINITIVELY MISSING from the lane base → FLAGGED stale", async () => {
  const a = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [satisfiedEpicDep("fn-1-a")],
  });
  const epics = [a, b];
  // Both lanes present; A's lane is NOT contained in B's base (ancestors: []) → exit 1.
  const { run } = gateGit({
    lanes: ["keeper/epic/fn-1-a", "keeper/epic/fn-2-b"],
    ancestors: [],
  });
  const stale = await computeStaleBaseLaneEntries(
    epics,
    classifyIdentity(epics),
    run,
  );
  expect(stale).toEqual([{ epic_id: "fn-2-b", repo_dir: "/repo" }]);
});

test("fn-1127 computeStaleBaseLaneEntries: the upstream's work IS contained in the base → NOT stale", async () => {
  const a = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [satisfiedEpicDep("fn-1-a")],
  });
  const epics = [a, b];
  // A's lane IS contained in B's base (exit 0) → B's base has the upstream's work.
  const { run } = gateGit({
    lanes: ["keeper/epic/fn-1-a", "keeper/epic/fn-2-b"],
    ancestors: ["keeper/epic/fn-1-a"],
  });
  const stale = await computeStaleBaseLaneEntries(
    epics,
    classifyIdentity(epics),
    run,
  );
  expect(stale).toEqual([]);
});

test("fn-1127 computeStaleBaseLaneEntries: a freshly-cut lane at its fork point (upstream already in base) is NEVER mis-verdicted stale", async () => {
  // The vacuous-ancestor trap the ref direction defends against: a fresh B whose base
  // already contains A reads CONTAINED (exit 0), never a false stale. (The inverse
  // ancestry direction would vacuously pass and MISS a real stale instead.)
  const a = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [satisfiedEpicDep("fn-1-a")],
  });
  const epics = [a, b];
  const { run } = gateGit({
    lanes: ["keeper/epic/fn-1-a", "keeper/epic/fn-2-b"],
    ancestors: ["keeper/epic/fn-1-a"], // A contained in B's fresh base
  });
  expect(
    await computeStaleBaseLaneEntries(epics, classifyIdentity(epics), run),
  ).toEqual([]);
});

test("fn-1127 computeStaleBaseLaneEntries: the upstream's lane is TORN DOWN (absent) → inconclusive, NO flag, no ancestry probe", async () => {
  // Upstream lanes are deleted after true merge; its ref is gone so the ancestry test
  // is unrunnable → skip this upstream (an absent-ref defer, never a false flag).
  const a = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [satisfiedEpicDep("fn-1-a")],
  });
  const epics = [a, b];
  const { run, calls } = gateGit({ lanes: ["keeper/epic/fn-2-b"] }); // A's lane gone
  expect(
    await computeStaleBaseLaneEntries(epics, classifyIdentity(epics), run),
  ).toEqual([]);
  // No ancestry probe fires for an absent upstream ref.
  expect(calls.some((c) => argvStartsWith(c.args, "merge-base"))).toBe(false);
});

test("fn-1127 computeStaleBaseLaneEntries: B's OWN lane torn-down / never cut (absent) → skipped, never probed", async () => {
  const a = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [satisfiedEpicDep("fn-1-a")],
  });
  const epics = [a, b];
  // A present, B's lane ABSENT → B has no cut lane, so no stale base to surface.
  const { run, calls } = gateGit({ lanes: ["keeper/epic/fn-1-a"] });
  expect(
    await computeStaleBaseLaneEntries(epics, classifyIdentity(epics), run),
  ).toEqual([]);
  expect(calls.some((c) => argvStartsWith(c.args, "merge-base"))).toBe(false);
});

test("fn-1127 computeStaleBaseLaneEntries: an enumeration FAILURE → NO flag (never claim stale off an inconclusive probe)", async () => {
  const a = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [satisfiedEpicDep("fn-1-a")],
  });
  const epics = [a, b];
  const { run } = gateGit({ enumError: true });
  expect(
    await computeStaleBaseLaneEntries(epics, classifyIdentity(epics), run),
  ).toEqual([]);
});

test("fn-1127 computeStaleBaseLaneEntries: an ancestry TIMEOUT (124) on a present pair → inconclusive, NO flag", async () => {
  const a = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [satisfiedEpicDep("fn-1-a")],
  });
  const epics = [a, b];
  const { run } = gateGit({
    lanes: ["keeper/epic/fn-1-a", "keeper/epic/fn-2-b"],
    ancestryTimeout: true, // every ancestry probe surfaces the 124 SIGKILL sentinel
  });
  expect(
    await computeStaleBaseLaneEntries(epics, classifyIdentity(epics), run),
  ).toEqual([]);
});

test("fn-1127 computeStaleBaseLaneEntries: multi-upstream UNION — ONE missing same-repo upstream flags the lane", async () => {
  const a1 = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const a2 = makeEpic({ epic_id: "fn-1-c", project_dir: "/repo" });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [
      satisfiedEpicDep("fn-1-a"),
      satisfiedEpicDep("fn-1-c"),
    ],
  });
  const epics = [a1, a2, b];
  // a1 contained in B's base, a2 NOT → union flags B stale.
  const { run } = gateGit({
    lanes: ["keeper/epic/fn-1-a", "keeper/epic/fn-1-c", "keeper/epic/fn-2-b"],
    ancestors: ["keeper/epic/fn-1-a"],
  });
  expect(
    await computeStaleBaseLaneEntries(epics, classifyIdentity(epics), run),
  ).toEqual([{ epic_id: "fn-2-b", repo_dir: "/repo" }]);
});

test("fn-1127 computeStaleBaseLaneEntries: ALL same-repo upstreams contained → NOT stale", async () => {
  const a1 = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const a2 = makeEpic({ epic_id: "fn-1-c", project_dir: "/repo" });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [
      satisfiedEpicDep("fn-1-a"),
      satisfiedEpicDep("fn-1-c"),
    ],
  });
  const epics = [a1, a2, b];
  const { run } = gateGit({
    lanes: ["keeper/epic/fn-1-a", "keeper/epic/fn-1-c", "keeper/epic/fn-2-b"],
    ancestors: ["keeper/epic/fn-1-a", "keeper/epic/fn-1-c"],
  });
  expect(
    await computeStaleBaseLaneEntries(epics, classifyIdentity(epics), run),
  ).toEqual([]);
});

test("fn-1127 computeStaleBaseLaneEntries: a CROSS-REPO upstream never contributes (decided by resolved toplevel, not cross_project)", async () => {
  const a = makeEpic({ epic_id: "fn-1-a", project_dir: "/other" }); // different toplevel
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [satisfiedEpicDep("fn-1-a")],
  });
  const epics = [a, b];
  const { run, calls } = gateGit({
    lanes: ["keeper/epic/fn-2-b"],
    ancestors: [],
  });
  expect(
    await computeStaleBaseLaneEntries(epics, classifyIdentity(epics), run),
  ).toEqual([]);
  // The same-repo gate skips a cross-repo upstream BEFORE any ancestry probe.
  expect(calls.some((c) => argvStartsWith(c.args, "merge-base"))).toBe(false);
});

test("fn-1127 computeStaleBaseLaneEntries: a BLOCKED-INCOMPLETE / dangling / disabled / reaped upstream never flags (folds to skip)", async () => {
  // A blocked-incomplete (still-open) upstream has NOT landed → never a stale-base
  // source (the readiness gate / merge-gate own it); a dangling (null-resolved) edge,
  // a reaped (absent from the map) upstream, and a satisfied dep whose upstream has no
  // same-repo lane all fold to skip — mirroring computeDeferredEpicIds.
  const blockedA = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [
      blockedEpicDep("fn-1-a"), // still open → not landed → skip
      { ...satisfiedEpicDep("fn-9-x"), resolved_epic_id: null }, // dangling → skip
      satisfiedEpicDep("fn-1-gone"), // reaped (absent from the map) → skip
    ],
  });
  const epics = [blockedA, b];
  const { run } = gateGit({
    lanes: ["keeper/epic/fn-1-a", "keeper/epic/fn-2-b"],
    ancestors: [], // if any of these upstreams reached the probe it would flag — none do
  });
  expect(
    await computeStaleBaseLaneEntries(epics, classifyIdentity(epics), run),
  ).toEqual([]);
});

test("fn-1127 computeStaleBaseLaneEntries: B's OWN repo unresolved / non-lane → skipped, never probed", async () => {
  const a = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [satisfiedEpicDep("fn-1-a")],
  });
  const epics = [a, b];
  const map = classifyIdentity(epics);
  map.set("fn-2-b", { kind: "unresolved", reason: "test: B unresolved" });
  const { run, calls } = gateGit({
    lanes: ["keeper/epic/fn-1-a", "keeper/epic/fn-2-b"],
    ancestors: [],
  });
  expect(await computeStaleBaseLaneEntries(epics, map, run)).toEqual([]);
  // A non-lane B is skipped before any git spawn.
  expect(calls.length).toBe(0);
});

test("fn-1127 computeStaleBaseLaneEntries: entries are sorted by (epic_id, repo_dir) for a stable serialization", async () => {
  const a = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const b1 = makeEpic({
    epic_id: "fn-3-b",
    project_dir: "/repo",
    resolved_epic_deps: [satisfiedEpicDep("fn-1-a")],
  });
  const b2 = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [satisfiedEpicDep("fn-1-a")],
  });
  const epics = [a, b1, b2]; // deliberately NOT epic-id order
  const { run } = gateGit({
    lanes: ["keeper/epic/fn-1-a", "keeper/epic/fn-3-b", "keeper/epic/fn-2-b"],
    ancestors: [], // both B's stale
  });
  expect(
    await computeStaleBaseLaneEntries(epics, classifyIdentity(epics), run),
  ).toEqual([
    { epic_id: "fn-2-b", repo_dir: "/repo" },
    { epic_id: "fn-3-b", repo_dir: "/repo" },
  ]);
});

test("fn-1127 computeStaleBaseLaneEntries: a CLUSTERED epic is flagged PER-REPO — one group stale, its clean sibling proceeds", async () => {
  // B clusters into /repo-a + /repo-b; upstream A cuts a worktree lane in both. A's
  // work is missing from B's base in /repo-a (stale) but contained in /repo-b (clean).
  const twoRepoTasks = (epicId: string) => [
    makeTask({
      task_id: `${epicId}.1`,
      task_number: 1,
      target_repo: "/repo-a",
    }),
    makeTask({
      task_id: `${epicId}.2`,
      task_number: 2,
      target_repo: "/repo-b",
    }),
  ];
  const a = makeEpic({
    epic_id: "fn-1-a",
    project_dir: "/repo-a",
    tasks: twoRepoTasks("fn-1-a"),
  });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo-a",
    tasks: twoRepoTasks("fn-2-b"),
    resolved_epic_deps: [satisfiedEpicDep("fn-1-a")],
  });
  const epics = [a, b];
  const cls = classifyMultiRepo(epics); // flag ON → both cluster into worktree groups
  expect(cls.get("fn-2-b")?.kind).toBe("clustered");
  const { run } = clusterGit({
    "/repo-a": {
      lanes: ["keeper/epic/fn-1-a", "keeper/epic/fn-2-b"],
      ancestors: [], // A missing from B's base in /repo-a → stale
    },
    "/repo-b": {
      lanes: ["keeper/epic/fn-1-a", "keeper/epic/fn-2-b"],
      ancestors: ["keeper/epic/fn-1-a"], // A contained in /repo-b → clean
    },
  });
  expect(await computeStaleBaseLaneEntries(epics, cls, run)).toEqual([
    { epic_id: "fn-2-b", repo_dir: "/repo-a" },
  ]);
});

test("fn-1127 the merge-gate cut-deferral is byte-identical with the stale-base probe (independent passes, orthogonal refs)", async () => {
  // The SAME fixture drives BOTH probes off the SAME git fake: a satisfied same-repo
  // upstream A present + not-ancestor. The merge-gate reads A-vs-DEFAULT (defers B's
  // cut); the stale probe reads A-vs-B's-BASE (flags the already-cut lane). Neither
  // pass touches the other's output — pinned so a stale-probe change can never perturb
  // the cut-deferral.
  const a = makeEpic({ epic_id: "fn-1-a", project_dir: "/repo" });
  const b = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo",
    resolved_epic_deps: [satisfiedEpicDep("fn-1-a")],
  });
  const epics = [a, b];
  const cls = classifyIdentity(epics);
  const { run } = gateGit({
    lanes: ["keeper/epic/fn-1-a", "keeper/epic/fn-2-b"],
    ancestors: [], // A not-ancestor of default AND not-contained in B's base
  });
  const deferredBefore = await computeDeferredEpicIds(epics, cls, run);
  expect(deferredBefore.get("fn-2-b")).toEqual(new Set(["/repo"]));
  // The stale probe flags B, using the SAME git fake…
  expect(await computeStaleBaseLaneEntries(epics, cls, run)).toEqual([
    { epic_id: "fn-2-b", repo_dir: "/repo" },
  ]);
  // …and the merge-gate deferral is byte-identical afterward (independent passes).
  const deferredAfter = await computeDeferredEpicIds(epics, cls, run);
  expect(deferredAfter).toEqual(deferredBefore);
});

// ---------------------------------------------------------------------------
// fn-1127 — the stale-base lane grace tracker (createStaleBaseLaneTracker). A CLONE
// of the shared-checkout-wedge tracker, keyed on the per-(epic,repo) distress ID
// (not a dir): exactly-once mint per continuous stale episode past the grace, the
// projection-driven level-clear robust across a restart. All expected values are
// hand-computed constants, never re-derived from the tracker.
// ---------------------------------------------------------------------------

const STALE_ID_A = staleBaseLaneDistressId("fn-2-b", "/repo");
const STALE_OBS_A: StaleBaseLaneObservation = {
  epicId: "fn-2-b",
  repoDir: "/repo",
};
const STALE_ID_B = staleBaseLaneDistressId("fn-3-c", "/repo");
const STALE_OBS_B: StaleBaseLaneObservation = {
  epicId: "fn-3-c",
  repoDir: "/repo",
};

test("STALE_BASE_LANE_GRACE_SEC is the ~5min grace watermark", () => {
  expect(STALE_BASE_LANE_GRACE_SEC).toBe(5 * 60);
});

test("stale tracker: a lane stale past the grace watermark mints EXACTLY once, keyed per-(epic,repo)", () => {
  const grace = 300;
  const tracker = createStaleBaseLaneTracker(grace);
  const stale = new Map([[STALE_ID_A, STALE_OBS_A]]);
  const empty = new Set<string>();
  // t=1000 first observed stale → no mint (grace clock starts here).
  expect(
    tracker.step({ stale, openDistressIds: empty, nowSec: 1000 }).mint,
  ).toEqual([]);
  // Just short of grace → still no mint.
  expect(
    tracker.step({ stale, openDistressIds: empty, nowSec: 1299 }).mint,
  ).toEqual([]);
  // Exactly grace elapsed → mint once, keyed per-(epic,repo), reason display-mapped.
  const crossed = tracker.step({
    stale,
    openDistressIds: empty,
    nowSec: 1300,
  });
  expect(crossed.mint.length).toBe(1);
  expect(crossed.mint[0]?.id).toBe(STALE_ID_A);
  expect(crossed.mint[0]?.dir).toBe("/repo");
  expect(crossed.mint[0]?.reason?.startsWith(STALE_BASE_DISTRESS_REASON)).toBe(
    true,
  );
  expect(crossed.mint[0]?.reason).toContain("fn-2-b");
  // Subsequent cycles while still stale → NEVER re-mint (O(1) per episode).
  for (const ts of [1301, 1600, 5000]) {
    expect(
      tracker.step({ stale, openDistressIds: empty, nowSec: ts }).mint,
    ).toEqual([]);
  }
});

test("stale tracker: the storm shape — one persistent stale lane over many cycles yields exactly ONE mint", () => {
  const grace = 300;
  const tracker = createStaleBaseLaneTracker(grace);
  const stale = new Map([[STALE_ID_A, STALE_OBS_A]]);
  const empty = new Set<string>();
  let mints = 0;
  for (let ts = 1000; ts < 5000; ts++) {
    mints += tracker.step({ stale, openDistressIds: empty, nowSec: ts }).mint
      .length;
  }
  expect(mints).toBe(1);
});

test("stale tracker: a re-based / torn-down lane level-clears the open distress row EXACTLY once", () => {
  const grace = 300;
  const tracker = createStaleBaseLaneTracker(grace);
  const stale = new Map([[STALE_ID_A, STALE_OBS_A]]);
  const open = new Set([STALE_ID_A]); // the durable open distress row
  // Still stale → no clear (the row belongs, the base is still stale).
  expect(
    tracker.step({ stale, openDistressIds: open, nowSec: 2000 }).clear,
  ).toEqual([]);
  // The probe stops reporting it stale (re-based past the upstream or torn down) but
  // the row is still open → level-clear it once, keyed on the same per-(epic,repo) id.
  const cleared = tracker.step({
    stale: new Map(),
    openDistressIds: open,
    nowSec: 2001,
  });
  expect(cleared.clear.length).toBe(1);
  expect(cleared.clear[0]?.id).toBe(STALE_ID_A);
  // Once main folds the clear the row is gone → no re-clear.
  expect(
    tracker.step({
      stale: new Map(),
      openDistressIds: new Set(),
      nowSec: 2002,
    }).clear,
  ).toEqual([]);
});

test("stale tracker: two (epic,repo) lanes stale independently — distinct rows, no collision", () => {
  const grace = 300;
  const tracker = createStaleBaseLaneTracker(grace);
  const empty = new Set<string>();
  // A stale at t=1000; B stale later at t=1200.
  tracker.step({
    stale: new Map([[STALE_ID_A, STALE_OBS_A]]),
    openDistressIds: empty,
    nowSec: 1000,
  });
  const both = new Map([
    [STALE_ID_A, STALE_OBS_A],
    [STALE_ID_B, STALE_OBS_B],
  ]);
  tracker.step({ stale: both, openDistressIds: empty, nowSec: 1200 });
  // At t=1300, A has crossed its grace (started 1000) but B has not (started 1200).
  const atA = tracker.step({
    stale: both,
    openDistressIds: empty,
    nowSec: 1300,
  });
  expect(atA.mint.map((m) => m.id)).toEqual([STALE_ID_A]);
  // At t=1500, B crosses its own grace — its own distinct row, A does not re-mint.
  const atB = tracker.step({
    stale: both,
    openDistressIds: empty,
    nowSec: 1500,
  });
  expect(atB.mint.map((m) => m.id)).toEqual([STALE_ID_B]);
  expect(STALE_ID_A).not.toBe(STALE_ID_B);
});

test("stale tracker: a lane that recovers then re-goes-stale waits the FULL grace again", () => {
  const grace = 300;
  const tracker = createStaleBaseLaneTracker(grace);
  const stale = new Map([[STALE_ID_A, STALE_OBS_A]]);
  const empty = new Set<string>();
  // First episode: mint at 1300.
  tracker.step({ stale, openDistressIds: empty, nowSec: 1000 });
  expect(
    tracker.step({ stale, openDistressIds: empty, nowSec: 1300 }).mint.length,
  ).toBe(1);
  // Recovers at 1400 (re-arms the in-memory grace clock).
  tracker.step({ stale: new Map(), openDistressIds: empty, nowSec: 1400 });
  // Re-goes-stale at 1500 — a NEW episode: no mint until a fresh full grace elapses.
  expect(
    tracker.step({ stale, openDistressIds: empty, nowSec: 1500 }).mint,
  ).toEqual([]);
  expect(
    tracker.step({ stale, openDistressIds: empty, nowSec: 1799 }).mint,
  ).toEqual([]);
  expect(
    tracker.step({ stale, openDistressIds: empty, nowSec: 1800 }).mint.length,
  ).toBe(1);
});

test("stale tracker: a restart (fresh tracker) still level-clears a row minted before it, and re-mints at most once", () => {
  const grace = 300;
  // Simulate a daemon restart: a brand-new tracker with an empty in-memory clock, but
  // the durable distress row is still open in the projection.
  const fresh = createStaleBaseLaneTracker(grace);
  const open = new Set([STALE_ID_A]);
  // The lane was re-based/torn down during downtime: not stale now, row still open →
  // the projection-driven clear fires even though this instance never minted it.
  const cleared = fresh.step({
    stale: new Map(),
    openDistressIds: open,
    nowSec: 9000,
  });
  expect(cleared.clear.map((c) => c.id)).toEqual([STALE_ID_A]);

  // Alternatively, still stale after the restart: the fresh clock re-arms and re-mints
  // ONCE after a full grace (the accepted bounded per-restart burst).
  const fresh2 = createStaleBaseLaneTracker(grace);
  const stale = new Map([[STALE_ID_A, STALE_OBS_A]]);
  let mints = 0;
  for (let ts = 9000; ts < 9000 + 2 * grace; ts++) {
    mints += fresh2.step({ stale, openDistressIds: open, nowSec: ts }).mint
      .length;
  }
  expect(mints).toBe(1);
});

// ---------------------------------------------------------------------------
// fn-1193 — the duplicate-epic-number producer probe + distress tracker. The
// probe is a PURE O(open epics) read over the epics projection; the tracker is a
// CLONE of the stale-base tracker (grace 0 → mint on first observation), keyed on
// the per-(project,number) distress ID. All expected values are hand-computed
// constants, never re-derived from the probe/tracker.
// ---------------------------------------------------------------------------

test("fn-1193 computeDuplicateEpicNumberGroups: two non-done same-project epics sharing a number → one group naming both (sorted)", () => {
  const groups = computeDuplicateEpicNumberGroups([
    makeEpic({ epic_id: "fn-7-zeta", epic_number: 7, project_dir: "/repo" }),
    makeEpic({ epic_id: "fn-7-alpha", epic_number: 7, project_dir: "/repo" }),
    makeEpic({ epic_id: "fn-8-solo", epic_number: 8, project_dir: "/repo" }),
  ]);
  expect(groups).toEqual([
    {
      epicNumber: 7,
      projectDir: "/repo",
      epicIds: ["fn-7-alpha", "fn-7-zeta"],
    },
  ]);
});

test("fn-1193 computeDuplicateEpicNumberGroups: a DONE epic in the pair is history, not a jam — no group", () => {
  // A duplicate involving a done epic is closed history; scoping to non-done pairs
  // keeps closed history from minting eternal distress.
  expect(
    computeDuplicateEpicNumberGroups([
      makeEpic({ epic_id: "fn-7-live", epic_number: 7, project_dir: "/repo" }),
      makeEpic({
        epic_id: "fn-7-done",
        epic_number: 7,
        project_dir: "/repo",
        status: "done",
      }),
    ]),
  ).toEqual([]);
});

test("fn-1193 computeDuplicateEpicNumberGroups: same number in DIFFERENT projects is NOT a duplicate", () => {
  expect(
    computeDuplicateEpicNumberGroups([
      makeEpic({ epic_id: "fn-7-a", epic_number: 7, project_dir: "/repo-a" }),
      makeEpic({ epic_id: "fn-7-b", epic_number: 7, project_dir: "/repo-b" }),
    ]),
  ).toEqual([]);
});

test("fn-1193 computeDuplicateEpicNumberGroups: null number / null project are un-keyable and skipped", () => {
  expect(
    computeDuplicateEpicNumberGroups([
      makeEpic({ epic_id: "fn-x-1", epic_number: null, project_dir: "/repo" }),
      makeEpic({ epic_id: "fn-x-2", epic_number: null, project_dir: "/repo" }),
      makeEpic({ epic_id: "fn-7-a", epic_number: 7, project_dir: null }),
      makeEpic({ epic_id: "fn-7-b", epic_number: 7, project_dir: null }),
    ]),
  ).toEqual([]);
});

const DUP_ID_7 = dupEpicNumberDistressId("/repo", 7);
const DUP_OBS_7: DupEpicNumberObservation = {
  projectDir: "/repo",
  epicNumber: 7,
  epicIds: ["fn-7-alpha", "fn-7-zeta"],
};

test("fn-1193 dup tracker: a duplicate mints EXACTLY once on first observation (grace 0), keyed per-(project,number)", () => {
  const tracker = createDupEpicNumberTracker(); // grace 0
  const dup = new Map([[DUP_ID_7, DUP_OBS_7]]);
  const empty = new Set<string>();
  const first = tracker.step({
    duplicates: dup,
    openDistressIds: empty,
    nowSec: 1000,
  });
  expect(first.mint.length).toBe(1);
  expect(first.mint[0]?.id).toBe(DUP_ID_7);
  expect(first.mint[0]?.dir).toBe("/repo");
  expect(
    first.mint[0]?.reason?.startsWith(DUP_EPIC_NUMBER_DISTRESS_REASON),
  ).toBe(true);
  expect(first.mint[0]?.reason).toContain("fn-7-alpha");
  expect(first.mint[0]?.reason).toContain("fn-7-zeta");
  // Subsequent cycles while still duplicated → NEVER re-mint (O(1) per episode).
  for (const ts of [1001, 1600, 5000]) {
    expect(
      tracker.step({ duplicates: dup, openDistressIds: empty, nowSec: ts })
        .mint,
    ).toEqual([]);
  }
});

test("fn-1193 dup tracker: the duplicate resolving level-clears the open distress row EXACTLY once", () => {
  const tracker = createDupEpicNumberTracker();
  const dup = new Map([[DUP_ID_7, DUP_OBS_7]]);
  const open = new Set([DUP_ID_7]); // durable open distress row
  // Still duplicated → no clear.
  expect(
    tracker.step({ duplicates: dup, openDistressIds: open, nowSec: 2000 })
      .clear,
  ).toEqual([]);
  // The probe stops reporting the duplicate (renumbered / removed / gone done) but the
  // row is still open → level-clear it once, keyed on the same per-(project,number) id.
  const cleared = tracker.step({
    duplicates: new Map(),
    openDistressIds: open,
    nowSec: 2001,
  });
  expect(cleared.clear.map((c) => c.id)).toEqual([DUP_ID_7]);
  // Once main folds the clear the row is gone → no re-clear.
  expect(
    tracker.step({
      duplicates: new Map(),
      openDistressIds: new Set(),
      nowSec: 2002,
    }).clear,
  ).toEqual([]);
});

test("fn-1193 dup tracker: key is STABLE across cycles and DISTINCT per (project, number)", () => {
  // Same (project, number) → same id across cycles (mint + clear hit one row).
  expect(dupEpicNumberDistressId("/repo", 7)).toBe(DUP_ID_7);
  // Distinct number, or distinct project → distinct rows.
  expect(dupEpicNumberDistressId("/repo", 8)).not.toBe(DUP_ID_7);
  expect(dupEpicNumberDistressId("/repo-b", 7)).not.toBe(DUP_ID_7);
});

test("fn-1193 dup tracker: a restart (fresh tracker) still level-clears a row minted before it", () => {
  // Simulate a daemon restart: brand-new tracker, empty in-memory latch, but the
  // durable distress row is still open in the projection. The duplicate resolved during
  // downtime → the projection-driven clear fires even though this instance never minted.
  const fresh = createDupEpicNumberTracker();
  const open = new Set([DUP_ID_7]);
  const cleared = fresh.step({
    duplicates: new Map(),
    openDistressIds: open,
    nowSec: 9000,
  });
  expect(cleared.clear.map((c) => c.id)).toEqual([DUP_ID_7]);
});

test("fn-1014 reconcile: a deferred epic's WORK and CLOSE launches are BOTH suppressed; a non-deferred sibling still launches (no sticky / dispatch_failures minted)", () => {
  // Distinct roots so each epic owns its own cap-1 lane (no per-root contention
  // masking the gate). bWork would work-launch; cClose would close-launch.
  const bWork = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo-b",
    tasks: [makeTask({ task_id: "fn-2-b.1", epic_id: "fn-2-b" })],
  });
  const cClose = makeEpic({
    epic_id: "fn-3-c",
    project_dir: "/repo-c",
    tasks: [
      makeTask({
        task_id: "fn-3-c.1",
        epic_id: "fn-3-c",
        worker_phase: "done",
        runtime_status: "done",
      }),
    ],
  });
  const control = makeEpic({
    epic_id: "fn-4-d",
    project_dir: "/repo-d",
    tasks: [makeTask({ task_id: "fn-4-d.1", epic_id: "fn-4-d" })],
  });
  const snap = makeSnapshot({
    epics: [bWork, cClose, control],
    deferredEpicIds: new Map([
      ["fn-2-b", new Set(["/repo-b"])],
      ["fn-3-c", new Set(["/repo-c"])],
    ]),
  });
  const decision = reconcile(snap, makeState(), 0);
  // The deferred epics launch NOTHING — neither the work row nor the close row.
  expect(decision.launches.some((p) => p.id === "fn-2-b.1")).toBe(false);
  expect(
    decision.launches.some((p) => p.verb === "close" && p.id === "fn-3-c"),
  ).toBe(false);
  // The non-deferred sibling still launches — the gate is targeted, not global.
  expect(
    decision.launches.some((p) => p.verb === "work" && p.id === "fn-4-d.1"),
  ).toBe(true);
  // A pure `continue` — no failure surface is touched (reconcile mints no sticky).
  expect(decision.worktreeFinalize).toEqual([]);
});

test("fn-1014 reconcile: an empty deferredEpicIds map is a byte-identical no-op (every gate arm inert)", () => {
  const bWork = makeEpic({
    epic_id: "fn-2-b",
    project_dir: "/repo-b",
    tasks: [makeTask({ task_id: "fn-2-b.1", epic_id: "fn-2-b" })],
  });
  const cClose = makeEpic({
    epic_id: "fn-3-c",
    project_dir: "/repo-c",
    tasks: [
      makeTask({
        task_id: "fn-3-c.1",
        epic_id: "fn-3-c",
        worker_phase: "done",
        runtime_status: "done",
      }),
    ],
  });
  const snap = makeSnapshot({
    epics: [bWork, cClose],
    deferredEpicIds: new Map<string, Set<string>>(),
  });
  const decision = reconcile(snap, makeState(), 0);
  // With nothing deferred, BOTH the work row and the close row launch normally.
  expect(
    decision.launches.some((p) => p.verb === "work" && p.id === "fn-2-b.1"),
  ).toBe(true);
  expect(
    decision.launches.some((p) => p.verb === "close" && p.id === "fn-3-c"),
  ).toBe(true);
});

test("fn-1014 regression: a divergent lane base merges via a TRUE 2-parent commit-tree merge (never --squash) — the absent-implies-merged premise", async () => {
  // Locks the merge half of the gate premise: keeper places a base into default via a
  // TRUE merge (a commit-tree merge commit with BOTH parents, so `merge-base
  // --is-ancestor` stays valid afterward). A future switch to `--squash` (which
  // INVALIDATES `--is-ancestor`, so an absent lane could be unmerged) must fail this.
  const { run, cmds } = makeMergeGit();
  const res = await mergeLaneBaseIntoDefault(
    "/repo",
    "keeper/epic/fn-1-foo",
    "main",
    run,
    () => ({ release() {} }),
  );
  expect(res).toEqual({ kind: "merged" });
  // A TRUE 2-parent merge commit (default tip AND base tip as parents) — the merge
  // commit is-ancestor-valid; NEVER a squash (which would break the gate's absent arm).
  expect(
    cmds.some((c) =>
      c.startsWith(
        `commit-tree ${MG_TREE_OID} -p ${MG_DEFAULT_TIP} -p ${MG_BASE_TIP} -m `,
      ),
    ),
  ).toBe(true);
  expect(cmds.some((c) => c.includes("--squash"))).toBe(false);
  expect(cmds.some((c) => c.startsWith("merge --no-edit"))).toBe(false);
});

test("fn-1014 regression: a MERGED keeper/epic base (an ancestor of default) IS deleted, is-ancestor-gated — so a later 'lane absent' reading is provably merged", async () => {
  // The other half of the premise: a base that IS an ancestor of (origin/)default is
  // torn down, so a subsequent cycle's enumeration sees it ABSENT — which the gate
  // treats as merged. This is what makes absent-implies-merged sound.
  const base = "keeper/epic/fn-1-foo";
  const basePath = "/repo.worktrees/keeper-epic-fn-1-foo";
  const { run, calls } = makeRecoveryGit({
    worktreeList:
      "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
      `worktree ${basePath}\nHEAD z\nbranch refs/heads/${base}\n\n`,
    mergeHeadAt: new Set(),
    epicBases: [base],
    defaultBranch: "main",
    ancestors: new Set([base]), // already an ancestor of default → provably merged
    repoHead: "main",
  });
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
    undefined,
    async () => false,
  );
  expect(failures).toEqual([]);
  // Torn down (worktree removed, then branch deleted), never `git branch --contains`.
  expect(calls.some((c) => c.args === `worktree remove ${basePath}`)).toBe(
    true,
  );
  expect(calls.some((c) => c.args === `branch -D ${base}`)).toBe(true);
  expect(calls.some((c) => c.args.includes("--contains"))).toBe(false);
});

test("fn-1014 regression: an UNMERGED keeper/epic base (NOT an ancestor of default) is NEVER deleted — the absent-implies-merged premise holds", async () => {
  // The recover teardown delete gate: a base that is NOT an ancestor of default is
  // unmerged work and MUST be preserved, never force-deleted. This is what makes a
  // LATER "lane absent" reading safe to treat as "merged" by the cross-epic gate.
  const base = "keeper/epic/fn-1-foo";
  const basePath = "/repo.worktrees/keeper-epic-fn-1-foo";
  const { run, calls } = makeRecoveryGit({
    worktreeList:
      "worktree /repo\nHEAD x\nbranch refs/heads/main\n\n" +
      `worktree ${basePath}\nHEAD z\nbranch refs/heads/${base}\n\n`,
    mergeHeadAt: new Set(),
    epicBases: [base],
    defaultBranch: "main",
    ancestors: new Set(), // NOT an ancestor of default → unmerged work
    repoHead: "main",
  });
  // The epic is absent/done (eligible to sweep) — yet the is-ancestor gate refuses.
  const { failures } = await recoverWorktrees(
    ["/repo"],
    async () => false,
    run,
    undefined,
    async () => false,
  );
  expect(failures).toEqual([]);
  expect(calls.some((c) => c.args === `branch -D ${base}`)).toBe(false);
  expect(calls.some((c) => c.args === `worktree remove ${basePath}`)).toBe(
    false,
  );
});

// ---------------------------------------------------------------------------
// fn-1075 — createDispatchFailedGate (producer-side DispatchFailed change-gate)
// The reconcile re-derives every failure from live git each cycle, so an
// unconditional emit storms one event per cycle for a persistently-stuck
// condition. The gate collapses identical re-emits while surfacing new
// conditions, reason changes, and a bounded still-stuck liveness watermark.
// ---------------------------------------------------------------------------

function failedPayload(
  overrides: Partial<DispatchFailedPayload> = {},
): DispatchFailedPayload {
  return {
    verb: "close",
    id: "worktree-recover:fn-1-foo-abc123",
    reason: "worktree-recover-dirty-checkout: /repo has a dirty working tree",
    dir: "/repo",
    ts: 1000,
    ...overrides,
  };
}

test("createDispatchFailedGate: FIRST appearance of a (verb,id) emits", () => {
  const gate = createDispatchFailedGate(900);
  expect(gate.shouldEmit(failedPayload())).toBe(true);
});

test("createDispatchFailedGate: an identical re-emit inside the watermark window is suppressed", () => {
  const gate = createDispatchFailedGate(900);
  expect(gate.shouldEmit(failedPayload({ ts: 1000 }))).toBe(true);
  // Same (verb,id,reason), a later ts still inside the interval → collapse.
  expect(gate.shouldEmit(failedPayload({ ts: 1001 }))).toBe(false);
  expect(gate.shouldEmit(failedPayload({ ts: 1899 }))).toBe(false);
});

test("createDispatchFailedGate: a REASON CHANGE for the same (verb,id) emits immediately", () => {
  const gate = createDispatchFailedGate(900);
  expect(gate.shouldEmit(failedPayload({ ts: 1000 }))).toBe(true);
  // dirty→conflict is new, actionable information — never swallowed, even 1s later.
  expect(
    gate.shouldEmit(
      failedPayload({
        ts: 1001,
        reason: "worktree-recover-conflict: merging base into main — boom",
      }),
    ),
  ).toBe(true);
  // ...and the new reason becomes the baseline: its own re-emit is now suppressed.
  expect(
    gate.shouldEmit(
      failedPayload({
        ts: 1002,
        reason: "worktree-recover-conflict: merging base into main — boom",
      }),
    ),
  ).toBe(false);
});

test("createDispatchFailedGate: a still-unchanged condition re-announces on the watermark, then re-anchors the clock", () => {
  const gate = createDispatchFailedGate(900);
  expect(gate.shouldEmit(failedPayload({ ts: 1000 }))).toBe(true);
  // Just short of the interval → suppressed; exactly one interval later → watermark.
  expect(gate.shouldEmit(failedPayload({ ts: 1899 }))).toBe(false);
  expect(gate.shouldEmit(failedPayload({ ts: 1900 }))).toBe(true);
  // The watermark re-anchored the clock: the next interval is measured from 1900.
  expect(gate.shouldEmit(failedPayload({ ts: 2799 }))).toBe(false);
  expect(gate.shouldEmit(failedPayload({ ts: 2800 }))).toBe(true);
});

test("createDispatchFailedGate: noteClear resets the gate so a re-failure re-emits immediately", () => {
  const gate = createDispatchFailedGate(900);
  expect(gate.shouldEmit(failedPayload({ ts: 1000 }))).toBe(true);
  expect(gate.shouldEmit(failedPayload({ ts: 1001 }))).toBe(false);
  gate.noteClear("close", "worktree-recover:fn-1-foo-abc123");
  // Resolution dropped the row — the very next failure of this (verb,id) is new.
  expect(gate.shouldEmit(failedPayload({ ts: 1002 }))).toBe(true);
});

test("createDispatchFailedGate: a slot occupied→reclaimed reason change emits, then collapses (O(1) per condition)", () => {
  // The slot reasons ride the SAME gate: a stable reason collapses, and the
  // ambiguous→provably-dead escalation (slot-occupied → slot-reclaimed) is a reason
  // change the gate must surface. Clear-on-gone resets so a recurrence re-signals.
  const gate = createDispatchFailedGate(900);
  const occupied = failedPayload({
    verb: "close",
    id: "fn-1-foo",
    reason: "slot-occupied: stopped close session holds the slot (pane %7 zsh)",
    ts: 1000,
  });
  const reclaimed = failedPayload({
    verb: "close",
    id: "fn-1-foo",
    reason: "slot-reclaimed: reaped dead close session (pane %7 zsh)",
    ts: 1001,
  });
  expect(gate.shouldEmit(occupied)).toBe(true); // first appearance
  expect(gate.shouldEmit({ ...occupied, ts: 1002 })).toBe(false); // stable → collapse
  expect(gate.shouldEmit(reclaimed)).toBe(true); // occupied→reclaimed → emit
  expect(gate.shouldEmit({ ...reclaimed, ts: 1003 })).toBe(false); // new baseline
  gate.noteClear("close", "fn-1-foo");
  expect(gate.shouldEmit({ ...occupied, ts: 1004 })).toBe(true); // reset → re-signal
});

test("createDispatchFailedGate: distinct (verb,id) conditions are gated independently", () => {
  const gate = createDispatchFailedGate(900);
  expect(gate.shouldEmit(failedPayload({ id: "a", ts: 1000 }))).toBe(true);
  expect(gate.shouldEmit(failedPayload({ id: "b", ts: 1000 }))).toBe(true);
  // A's suppression does not gate B, and vice versa.
  expect(gate.shouldEmit(failedPayload({ id: "a", ts: 1001 }))).toBe(false);
  expect(gate.shouldEmit(failedPayload({ id: "b", ts: 1001 }))).toBe(false);
  // Same id, different verb is a distinct key (the NUL-joined composite).
  expect(
    gate.shouldEmit(failedPayload({ verb: "work", id: "a", ts: 1001 })),
  ).toBe(true);
});

test("createDispatchFailedGate: the storm shape — one stuck condition over many cycles yields O(watermarks), not one event per cycle", () => {
  const watermark = 900;
  const gate = createDispatchFailedGate(watermark);
  let emitted = 0;
  // 4000 cycles, one per simulated second, an identical persistently-stuck
  // condition re-derived every cycle (the review's single-stuck-worktree shape).
  for (let ts = 1000; ts < 5000; ts++) {
    if (gate.shouldEmit(failedPayload({ ts }))) emitted++;
  }
  // First appearance + one watermark per interval — a handful, never 4000.
  expect(emitted).toBeLessThanOrEqual(Math.ceil(4000 / watermark) + 1);
  expect(emitted).toBeGreaterThan(0);
});

test("DISPATCH_FAILED_WATERMARK_SEC is a bounded, non-trivial liveness interval", () => {
  expect(DISPATCH_FAILED_WATERMARK_SEC).toBe(15 * 60);
});

// ---------------------------------------------------------------------------
// fn-1114.3 — the shared-checkout mid-merge wedge distress escalation.
// The recover pass mints an immediate per-epic reason the first cycle; this
// grace tracker is the escalation layer ON TOP — a per-repo distress row when a
// shared checkout stays wedged past the grace watermark, exactly-once per
// episode, level-cleared off the durable open-distress set (robust across a
// restart). All expected values are hand-computed constants, never re-derived
// from the tracker.
// ---------------------------------------------------------------------------

const WEDGE_REASON =
  "worktree-recover-mid-merge: /repo is mid-merge (owner=foreign) — waiting";
const REPO_A = "/Users/x/code/keeper";
const REPO_B = "/Users/x/code/other";

test("sharedWedgeDistressId is stable per repo, distinct across repos, prefix-tagged", () => {
  const a = sharedWedgeDistressId(REPO_A);
  const b = sharedWedgeDistressId(REPO_B);
  expect(a).toBe(sharedWedgeDistressId(REPO_A)); // deterministic
  expect(a).not.toBe(b); // per-repo distinct
  expect(a.startsWith(SHARED_WEDGE_DISTRESS_ID_PREFIX)).toBe(true);
});

test("SHARED_CHECKOUT_WEDGE_GRACE_SEC is the ~5min grace watermark", () => {
  expect(SHARED_CHECKOUT_WEDGE_GRACE_SEC).toBe(5 * 60);
});

test("wedge tracker: a repo wedged past the grace watermark mints EXACTLY once", () => {
  const grace = 300;
  const tracker = createSharedCheckoutWedgeTracker(grace);
  const wedged = new Map([[REPO_A, WEDGE_REASON]]);
  const empty = new Set<string>();
  // t=1000 first observed wedged → no mint (grace clock starts here).
  expect(
    tracker.step({ wedged, openDistressDirs: empty, nowSec: 1000 }).mint,
  ).toEqual([]);
  // Just short of grace → still no mint.
  expect(
    tracker.step({ wedged, openDistressDirs: empty, nowSec: 1299 }).mint,
  ).toEqual([]);
  // Exactly grace elapsed → mint once, keyed per-repo, reason display-mapped.
  const crossed = tracker.step({
    wedged,
    openDistressDirs: empty,
    nowSec: 1300,
  });
  expect(crossed.mint.length).toBe(1);
  expect(crossed.mint[0]?.id).toBe(sharedWedgeDistressId(REPO_A));
  expect(crossed.mint[0]?.dir).toBe(REPO_A);
  expect(
    crossed.mint[0]?.reason?.startsWith(SHARED_WEDGE_DISTRESS_REASON),
  ).toBe(true);
  expect(crossed.mint[0]?.reason).toContain(REPO_A);
  // Subsequent cycles while still wedged → NEVER re-mint (O(1) per episode).
  for (const ts of [1301, 1600, 5000]) {
    expect(
      tracker.step({ wedged, openDistressDirs: empty, nowSec: ts }).mint,
    ).toEqual([]);
  }
});

test("wedge tracker: the storm shape — one persistent wedge over many cycles yields exactly ONE mint", () => {
  const grace = 300;
  const tracker = createSharedCheckoutWedgeTracker(grace);
  const wedged = new Map([[REPO_A, WEDGE_REASON]]);
  const empty = new Set<string>();
  let mints = 0;
  for (let ts = 1000; ts < 5000; ts++) {
    mints += tracker.step({ wedged, openDistressDirs: empty, nowSec: ts }).mint
      .length;
  }
  expect(mints).toBe(1);
});

test("wedge tracker: a recovered checkout level-clears the open distress row EXACTLY once", () => {
  const grace = 300;
  const tracker = createSharedCheckoutWedgeTracker(grace);
  const wedged = new Map([[REPO_A, WEDGE_REASON]]);
  const open = new Set([REPO_A]); // the durable open distress row for REPO_A
  // Still wedged → no clear (the row belongs, the checkout is dirty).
  expect(
    tracker.step({ wedged, openDistressDirs: open, nowSec: 2000 }).clear,
  ).toEqual([]);
  // Checkout recovers (no fresh wedge this cycle) but the row is still open →
  // level-clear it once, keyed on the same per-repo id.
  const recovered = tracker.step({
    wedged: new Map(),
    openDistressDirs: open,
    nowSec: 2001,
  });
  expect(recovered.clear.length).toBe(1);
  expect(recovered.clear[0]?.id).toBe(sharedWedgeDistressId(REPO_A));
  // Once main folds the clear the row is gone from openDistressDirs → no re-clear.
  expect(
    tracker.step({
      wedged: new Map(),
      openDistressDirs: new Set(),
      nowSec: 2002,
    }).clear,
  ).toEqual([]);
});

test("wedge tracker: two repos on a multi-repo board wedge independently — distinct rows, no collision", () => {
  const grace = 300;
  const tracker = createSharedCheckoutWedgeTracker(grace);
  const empty = new Set<string>();
  // A wedges at t=1000; B wedges later at t=1200.
  tracker.step({
    wedged: new Map([[REPO_A, WEDGE_REASON]]),
    openDistressDirs: empty,
    nowSec: 1000,
  });
  const both = new Map([
    [REPO_A, WEDGE_REASON],
    [REPO_B, WEDGE_REASON],
  ]);
  tracker.step({ wedged: both, openDistressDirs: empty, nowSec: 1200 });
  // At t=1300, A has crossed its grace (started 1000) but B has not (started 1200).
  const atA = tracker.step({
    wedged: both,
    openDistressDirs: empty,
    nowSec: 1300,
  });
  expect(atA.mint.map((m) => m.dir)).toEqual([REPO_A]);
  // At t=1500, B crosses its own grace — its own distinct row, A does not re-mint.
  const atB = tracker.step({
    wedged: both,
    openDistressDirs: empty,
    nowSec: 1500,
  });
  expect(atB.mint.map((m) => m.dir)).toEqual([REPO_B]);
  expect(sharedWedgeDistressId(REPO_A)).not.toBe(sharedWedgeDistressId(REPO_B));
});

test("wedge tracker: a repo that recovers then re-wedges waits the FULL grace again", () => {
  const grace = 300;
  const tracker = createSharedCheckoutWedgeTracker(grace);
  const wedged = new Map([[REPO_A, WEDGE_REASON]]);
  const empty = new Set<string>();
  // First episode: mint at 1300.
  tracker.step({ wedged, openDistressDirs: empty, nowSec: 1000 });
  expect(
    tracker.step({ wedged, openDistressDirs: empty, nowSec: 1300 }).mint.length,
  ).toBe(1);
  // Recovers at 1400 (re-arms the in-memory grace clock).
  tracker.step({ wedged: new Map(), openDistressDirs: empty, nowSec: 1400 });
  // Re-wedges at 1500 — a NEW episode: no mint until a fresh full grace elapses.
  expect(
    tracker.step({ wedged, openDistressDirs: empty, nowSec: 1500 }).mint,
  ).toEqual([]);
  expect(
    tracker.step({ wedged, openDistressDirs: empty, nowSec: 1799 }).mint,
  ).toEqual([]);
  expect(
    tracker.step({ wedged, openDistressDirs: empty, nowSec: 1800 }).mint.length,
  ).toBe(1);
});

test("wedge tracker: a restart (fresh tracker) still level-clears a row minted before it, and re-mints at most once", () => {
  const grace = 300;
  // Simulate a daemon restart: a brand-new tracker with an empty in-memory clock,
  // but the durable distress row for REPO_A is still open in the projection.
  const fresh = createSharedCheckoutWedgeTracker(grace);
  const open = new Set([REPO_A]);
  // The checkout recovered during downtime: not wedged now, row still open →
  // the projection-driven clear fires even though this instance never minted it.
  const cleared = fresh.step({
    wedged: new Map(),
    openDistressDirs: open,
    nowSec: 9000,
  });
  expect(cleared.clear.map((c) => c.id)).toEqual([
    sharedWedgeDistressId(REPO_A),
  ]);

  // Alternatively, still wedged after the restart: the fresh clock re-arms and
  // re-mints ONCE after a full grace (the accepted bounded per-restart burst).
  const fresh2 = createSharedCheckoutWedgeTracker(grace);
  const wedged = new Map([[REPO_A, WEDGE_REASON]]);
  let mints = 0;
  for (let ts = 9000; ts < 9000 + 2 * grace; ts++) {
    mints += fresh2.step({ wedged, openDistressDirs: open, nowSec: ts }).mint
      .length;
  }
  expect(mints).toBe(1);
});

// ---------------------------------------------------------------------------
// fn-1125.1 — the shared-checkout plain-DIRTY distress escalation. The SIBLING of
// the mid-merge wedge tracker: a per-repo distress row when a shared checkout stays
// dirty (a non-clean working tree, NO MERGE_HEAD) past the grace watermark,
// exactly-once per episode, level-cleared off the durable open-distress set (robust
// across a restart), on a DISTINCT id/reason so the two never cross-clear. All
// expected values are hand-computed constants, never re-derived from the tracker.
// ---------------------------------------------------------------------------

const DIRTY_REASON =
  "worktree-recover-dirty-checkout: /repo has a dirty working tree — skipping the merge until it is clean — M src/x.ts";

test("sharedDirtyDistressId is stable per repo, distinct across repos, prefix-tagged + distinct from the wedge id", () => {
  const a = sharedDirtyDistressId(REPO_A);
  const b = sharedDirtyDistressId(REPO_B);
  expect(a).toBe(sharedDirtyDistressId(REPO_A)); // deterministic
  expect(a).not.toBe(b); // per-repo distinct
  expect(a.startsWith(SHARED_DIRTY_DISTRESS_ID_PREFIX)).toBe(true);
  // A dirt row and a wedge row for the SAME repo are DISTINCT ids — never cross-clear.
  expect(sharedDirtyDistressId(REPO_A)).not.toBe(sharedWedgeDistressId(REPO_A));
});

test("SHARED_CHECKOUT_DIRTY_GRACE_SEC is the ~5min grace watermark", () => {
  expect(SHARED_CHECKOUT_DIRTY_GRACE_SEC).toBe(5 * 60);
});

test("dirty tracker: a repo dirty past the grace watermark mints EXACTLY once", () => {
  const grace = 300;
  const tracker = createSharedCheckoutDirtyTracker(grace);
  const dirty = new Map([[REPO_A, DIRTY_REASON]]);
  const empty = new Set<string>();
  // t=1000 first observed dirty → no mint (grace clock starts here).
  expect(
    tracker.step({ dirty, openDistressDirs: empty, nowSec: 1000 }).mint,
  ).toEqual([]);
  // Just short of grace → still no mint (the pre-grace invariant: mints nothing).
  expect(
    tracker.step({ dirty, openDistressDirs: empty, nowSec: 1299 }).mint,
  ).toEqual([]);
  // Exactly grace elapsed → mint once, keyed per-repo, reason display-mapped.
  const crossed = tracker.step({
    dirty,
    openDistressDirs: empty,
    nowSec: 1300,
  });
  expect(crossed.mint.length).toBe(1);
  expect(crossed.mint[0]?.id).toBe(sharedDirtyDistressId(REPO_A));
  expect(crossed.mint[0]?.dir).toBe(REPO_A);
  expect(
    crossed.mint[0]?.reason?.startsWith(SHARED_DIRTY_DISTRESS_REASON),
  ).toBe(true);
  expect(crossed.mint[0]?.reason).toContain(REPO_A);
  // Subsequent cycles while still dirty → NEVER re-mint (O(1) per episode).
  for (const ts of [1301, 1600, 5000]) {
    expect(
      tracker.step({ dirty, openDistressDirs: empty, nowSec: ts }).mint,
    ).toEqual([]);
  }
});

test("dirty tracker: the storm shape — one persistent dirty checkout over many cycles yields exactly ONE mint", () => {
  const grace = 300;
  const tracker = createSharedCheckoutDirtyTracker(grace);
  const dirty = new Map([[REPO_A, DIRTY_REASON]]);
  const empty = new Set<string>();
  let mints = 0;
  for (let ts = 1000; ts < 5000; ts++) {
    mints += tracker.step({ dirty, openDistressDirs: empty, nowSec: ts }).mint
      .length;
  }
  expect(mints).toBe(1);
});

test("dirty tracker: a cleaned checkout level-clears the open distress row EXACTLY once", () => {
  const grace = 300;
  const tracker = createSharedCheckoutDirtyTracker(grace);
  const dirty = new Map([[REPO_A, DIRTY_REASON]]);
  const open = new Set([REPO_A]); // the durable open dirt distress row for REPO_A
  // Still dirty → no clear (the row belongs, the checkout is not clean).
  expect(
    tracker.step({ dirty, openDistressDirs: open, nowSec: 2000 }).clear,
  ).toEqual([]);
  // Checkout goes clean (no fresh dirt this cycle) but the row is still open →
  // level-clear it once, keyed on the same per-repo id.
  const recovered = tracker.step({
    dirty: new Map(),
    openDistressDirs: open,
    nowSec: 2001,
  });
  expect(recovered.clear.length).toBe(1);
  expect(recovered.clear[0]?.id).toBe(sharedDirtyDistressId(REPO_A));
  // Once main folds the clear the row is gone from openDistressDirs → no re-clear.
  expect(
    tracker.step({
      dirty: new Map(),
      openDistressDirs: new Set(),
      nowSec: 2002,
    }).clear,
  ).toEqual([]);
});

test("dirty tracker: two repos on a multi-repo board go dirty independently — distinct rows, no collision", () => {
  const grace = 300;
  const tracker = createSharedCheckoutDirtyTracker(grace);
  const empty = new Set<string>();
  // A goes dirty at t=1000; B goes dirty later at t=1200.
  tracker.step({
    dirty: new Map([[REPO_A, DIRTY_REASON]]),
    openDistressDirs: empty,
    nowSec: 1000,
  });
  const both = new Map([
    [REPO_A, DIRTY_REASON],
    [REPO_B, DIRTY_REASON],
  ]);
  tracker.step({ dirty: both, openDistressDirs: empty, nowSec: 1200 });
  // At t=1300, A has crossed its grace (started 1000) but B has not (started 1200).
  const atA = tracker.step({
    dirty: both,
    openDistressDirs: empty,
    nowSec: 1300,
  });
  expect(atA.mint.map((m) => m.dir)).toEqual([REPO_A]);
  // At t=1500, B crosses its own grace — its own distinct row, A does not re-mint.
  const atB = tracker.step({
    dirty: both,
    openDistressDirs: empty,
    nowSec: 1500,
  });
  expect(atB.mint.map((m) => m.dir)).toEqual([REPO_B]);
  expect(sharedDirtyDistressId(REPO_A)).not.toBe(sharedDirtyDistressId(REPO_B));
});

test("dirty tracker: a repo that cleans then re-dirties waits the FULL grace again", () => {
  const grace = 300;
  const tracker = createSharedCheckoutDirtyTracker(grace);
  const dirty = new Map([[REPO_A, DIRTY_REASON]]);
  const empty = new Set<string>();
  // First episode: mint at 1300.
  tracker.step({ dirty, openDistressDirs: empty, nowSec: 1000 });
  expect(
    tracker.step({ dirty, openDistressDirs: empty, nowSec: 1300 }).mint.length,
  ).toBe(1);
  // Cleans at 1400 (re-arms the in-memory grace clock).
  tracker.step({ dirty: new Map(), openDistressDirs: empty, nowSec: 1400 });
  // Re-dirties at 1500 — a NEW episode: no mint until a fresh full grace elapses.
  expect(
    tracker.step({ dirty, openDistressDirs: empty, nowSec: 1500 }).mint,
  ).toEqual([]);
  expect(
    tracker.step({ dirty, openDistressDirs: empty, nowSec: 1799 }).mint,
  ).toEqual([]);
  expect(
    tracker.step({ dirty, openDistressDirs: empty, nowSec: 1800 }).mint.length,
  ).toBe(1);
});

test("dirty tracker: a restart (fresh tracker) still level-clears a row minted before it, and re-mints at most once", () => {
  const grace = 300;
  // Simulate a daemon restart: a brand-new tracker with an empty in-memory clock,
  // but the durable dirt distress row for REPO_A is still open in the projection.
  const fresh = createSharedCheckoutDirtyTracker(grace);
  const open = new Set([REPO_A]);
  // The checkout was cleaned during downtime: not dirty now, row still open → the
  // projection-driven clear fires even though this instance never minted it.
  const cleared = fresh.step({
    dirty: new Map(),
    openDistressDirs: open,
    nowSec: 9000,
  });
  expect(cleared.clear.map((c) => c.id)).toEqual([
    sharedDirtyDistressId(REPO_A),
  ]);

  // Alternatively, still dirty after the restart: the fresh clock re-arms and
  // re-mints ONCE after a full grace (the accepted bounded per-restart burst).
  const fresh2 = createSharedCheckoutDirtyTracker(grace);
  const dirty = new Map([[REPO_A, DIRTY_REASON]]);
  let mints = 0;
  for (let ts = 9000; ts < 9000 + 2 * grace; ts++) {
    mints += fresh2.step({ dirty, openDistressDirs: open, nowSec: ts }).mint
      .length;
  }
  expect(mints).toBe(1);
});

test("dirty + wedge distress rows for the SAME repo never cross-clear (distinct ids, independent open sets)", () => {
  // The incident shape: a repo can be flagged dirty in one cycle and mid-merge in
  // another. The two trackers key on DISTINCT per-repo ids and each clears against
  // ITS OWN open set only, so a clear from one can never target the other's row.
  const grace = 300;
  const dirtyTracker = createSharedCheckoutDirtyTracker(grace);
  const wedgeTracker = createSharedCheckoutWedgeTracker(grace);
  const openDirty = new Set([REPO_A]);
  const openWedge = new Set([REPO_A]);
  const dirtyClear = dirtyTracker.step({
    dirty: new Map(),
    openDistressDirs: openDirty,
    nowSec: 5000,
  });
  const wedgeClear = wedgeTracker.step({
    wedged: new Map(),
    openDistressDirs: openWedge,
    nowSec: 5000,
  });
  expect(dirtyClear.clear.map((c) => c.id)).toEqual([
    sharedDirtyDistressId(REPO_A),
  ]);
  expect(wedgeClear.clear.map((c) => c.id)).toEqual([
    sharedWedgeDistressId(REPO_A),
  ]);
  // The two ids are distinct — neither clear could ever target the other's row.
  expect(sharedDirtyDistressId(REPO_A)).not.toBe(sharedWedgeDistressId(REPO_A));
});

test("post base-merge decouple: the recover cycle derives NO shared-checkout wedge/dirty observation → the trackers can only drain, never mint", () => {
  // The neuter seam the recover loop feeds its shared-checkout trackers now yields
  // EMPTY maps unconditionally: a dirty/mid-merge shared checkout no longer blocks the
  // working-tree-free base merge, so the mid-merge/dirty observation is a false positive.
  const { wedged, dirty } = sharedCheckoutDistressObservations();
  expect(wedged.size).toBe(0);
  expect(dirty.size).toBe(0);
  // Fed those empty observations — even with an OPEN distress row present for REPO_A —
  // BOTH trackers mint NOTHING (no false positive) and level-clear the open row (the
  // drain path so an operator is never left with an un-clearable daemon-verb row).
  const grace = 300;
  const wedgeTracker = createSharedCheckoutWedgeTracker(grace);
  const dirtyTracker = createSharedCheckoutDirtyTracker(grace);
  const open = new Set([REPO_A]);
  const wedgeDecision = wedgeTracker.step({
    wedged,
    openDistressDirs: open,
    nowSec: 9000,
  });
  const dirtyDecision = dirtyTracker.step({
    dirty,
    openDistressDirs: open,
    nowSec: 9000,
  });
  expect(wedgeDecision.mint).toEqual([]);
  expect(dirtyDecision.mint).toEqual([]);
  expect(wedgeDecision.clear.map((c) => c.id)).toEqual([
    sharedWedgeDistressId(REPO_A),
  ]);
  expect(dirtyDecision.clear.map((c) => c.id)).toEqual([
    sharedDirtyDistressId(REPO_A),
  ]);
});

// ---------------------------------------------------------------------------
// fn-1169 — the shared-checkout DESYNC distress escalation. A LIVE-producer sibling of
// the (neutered) wedge/dirty trackers: a per-repo distress row when a base→default merge
// advanced the ref but the checkout's resync was skipped/aborted, so the working tree
// trails the default tip. Mint is EVENT-SEEDED + graced; clear is a per-cycle CONTENT
// probe. All expected values are hand-computed constants, never re-derived from the
// tracker/probe.
// ---------------------------------------------------------------------------

const DESYNC_BLOCKER =
  "content-trailing (index/worktree differ from the default tip)";

test("sharedDesyncDistressId is stable per repo, distinct across repos, prefix-tagged + distinct from the wedge/dirty ids", () => {
  const a = sharedDesyncDistressId(REPO_A);
  const b = sharedDesyncDistressId(REPO_B);
  expect(a).toBe(sharedDesyncDistressId(REPO_A)); // deterministic
  expect(a).not.toBe(b); // per-repo distinct
  expect(a.startsWith(SHARED_DESYNC_DISTRESS_ID_PREFIX)).toBe(true);
  // A desync row, a wedge row, and a dirt row for the SAME repo are three DISTINCT ids —
  // never cross-clear.
  expect(sharedDesyncDistressId(REPO_A)).not.toBe(
    sharedWedgeDistressId(REPO_A),
  );
  expect(sharedDesyncDistressId(REPO_A)).not.toBe(
    sharedDirtyDistressId(REPO_A),
  );
});

test("SHARED_CHECKOUT_DESYNC_GRACE_SEC is the ~5min grace watermark", () => {
  expect(SHARED_CHECKOUT_DESYNC_GRACE_SEC).toBe(5 * 60);
});

test("desync tracker: a repo desynced past the grace watermark mints EXACTLY once, blocker named", () => {
  const grace = 300;
  const tracker = createSharedCheckoutDesyncTracker(grace);
  const desynced = new Map([[REPO_A, DESYNC_BLOCKER]]);
  const empty = new Set<string>();
  // t=1000 first observed desynced → no mint (grace clock starts here).
  expect(
    tracker.step({ desynced, openDistressDirs: empty, nowSec: 1000 }).mint,
  ).toEqual([]);
  // Just short of grace → still no mint (the index.lock-blip mitigation window).
  expect(
    tracker.step({ desynced, openDistressDirs: empty, nowSec: 1299 }).mint,
  ).toEqual([]);
  // Exactly grace elapsed → mint once, keyed per-repo, reason display-mapped + blocker.
  const crossed = tracker.step({
    desynced,
    openDistressDirs: empty,
    nowSec: 1300,
  });
  expect(crossed.mint.length).toBe(1);
  expect(crossed.mint[0]?.id).toBe(sharedDesyncDistressId(REPO_A));
  expect(crossed.mint[0]?.dir).toBe(REPO_A);
  expect(
    crossed.mint[0]?.reason?.startsWith(SHARED_DESYNC_DISTRESS_REASON),
  ).toBe(true);
  expect(crossed.mint[0]?.reason).toContain(REPO_A);
  expect(crossed.mint[0]?.reason).toContain(DESYNC_BLOCKER);
  // Subsequent cycles while still desynced → NEVER re-mint (O(1) per episode).
  for (const ts of [1301, 1600, 5000]) {
    expect(
      tracker.step({ desynced, openDistressDirs: empty, nowSec: ts }).mint,
    ).toEqual([]);
  }
});

test("desync tracker: the storm shape — one persistent desync over many cycles yields exactly ONE mint", () => {
  const grace = 300;
  const tracker = createSharedCheckoutDesyncTracker(grace);
  const desynced = new Map([[REPO_A, DESYNC_BLOCKER]]);
  const empty = new Set<string>();
  let mints = 0;
  for (let ts = 1000; ts < 5000; ts++) {
    mints += tracker.step({ desynced, openDistressDirs: empty, nowSec: ts })
      .mint.length;
  }
  expect(mints).toBe(1);
});

test("desync tracker: a checkout that catches up level-clears the open row EXACTLY once (carries-HEAD evidence)", () => {
  const grace = 300;
  const tracker = createSharedCheckoutDesyncTracker(grace);
  const desynced = new Map([[REPO_A, DESYNC_BLOCKER]]);
  const open = new Set([REPO_A]); // the durable open desync row for REPO_A
  // Still desynced → no clear (the row belongs; the checkout does not carry HEAD).
  expect(
    tracker.step({ desynced, openDistressDirs: open, nowSec: 2000 }).clear,
  ).toEqual([]);
  // The checkout content-carries the default tip (no longer in `desynced`) but the row is
  // still open → level-clear it once, keyed on the same per-repo id.
  const caughtUp = tracker.step({
    desynced: new Map(),
    openDistressDirs: open,
    nowSec: 2001,
  });
  expect(caughtUp.clear.length).toBe(1);
  expect(caughtUp.clear[0]?.id).toBe(sharedDesyncDistressId(REPO_A));
  // Once main folds the clear the row is gone from openDistressDirs → no re-clear.
  expect(
    tracker.step({
      desynced: new Map(),
      openDistressDirs: new Set(),
      nowSec: 2002,
    }).clear,
  ).toEqual([]);
});

test("desync tracker: an off-default / mid-merge checkout keeps the row open (still in `desynced`), never clears or re-mints", () => {
  const grace = 300;
  const tracker = createSharedCheckoutDesyncTracker(grace);
  const empty = new Set<string>();
  // Mint the row at t=1300 (content-trailing).
  tracker.step({
    desynced: new Map([[REPO_A, DESYNC_BLOCKER]]),
    openDistressDirs: empty,
    nowSec: 1000,
  });
  expect(
    tracker.step({
      desynced: new Map([[REPO_A, DESYNC_BLOCKER]]),
      openDistressDirs: empty,
      nowSec: 1300,
    }).mint.length,
  ).toBe(1);
  const open = new Set([REPO_A]);
  // Now the checkout is off-default (a DIFFERENT blocker, but still desynced) → the row
  // is RETAINED (no clear) and NOT re-minted (already minted this episode).
  const offDefault = tracker.step({
    desynced: new Map([[REPO_A, "off-default (on feature/x, expected main)"]]),
    openDistressDirs: open,
    nowSec: 1600,
  });
  expect(offDefault.clear).toEqual([]);
  expect(offDefault.mint).toEqual([]);
});

test("desync tracker: two repos on a multi-repo board desync independently — distinct rows, no collision", () => {
  const grace = 300;
  const tracker = createSharedCheckoutDesyncTracker(grace);
  const empty = new Set<string>();
  // A desyncs at t=1000; B desyncs later at t=1200.
  tracker.step({
    desynced: new Map([[REPO_A, DESYNC_BLOCKER]]),
    openDistressDirs: empty,
    nowSec: 1000,
  });
  const both = new Map([
    [REPO_A, DESYNC_BLOCKER],
    [REPO_B, DESYNC_BLOCKER],
  ]);
  tracker.step({ desynced: both, openDistressDirs: empty, nowSec: 1200 });
  // At t=1300, A has crossed its grace (started 1000) but B has not (started 1200).
  const atA = tracker.step({
    desynced: both,
    openDistressDirs: empty,
    nowSec: 1300,
  });
  expect(atA.mint.map((m) => m.dir)).toEqual([REPO_A]);
  // At t=1500, B crosses its own grace — its own distinct row, A does not re-mint.
  const atB = tracker.step({
    desynced: both,
    openDistressDirs: empty,
    nowSec: 1500,
  });
  expect(atB.mint.map((m) => m.dir)).toEqual([REPO_B]);
  expect(sharedDesyncDistressId(REPO_A)).not.toBe(
    sharedDesyncDistressId(REPO_B),
  );
});

test("desync tracker: a repo that catches up then re-desyncs waits the FULL grace again", () => {
  const grace = 300;
  const tracker = createSharedCheckoutDesyncTracker(grace);
  const desynced = new Map([[REPO_A, DESYNC_BLOCKER]]);
  const empty = new Set<string>();
  // First episode: mint at 1300.
  tracker.step({ desynced, openDistressDirs: empty, nowSec: 1000 });
  expect(
    tracker.step({ desynced, openDistressDirs: empty, nowSec: 1300 }).mint
      .length,
  ).toBe(1);
  // Catches up at 1400 (re-arms the in-memory grace clock).
  tracker.step({ desynced: new Map(), openDistressDirs: empty, nowSec: 1400 });
  // Re-desyncs at 1500 — a NEW episode: no mint until a fresh full grace elapses.
  expect(
    tracker.step({ desynced, openDistressDirs: empty, nowSec: 1500 }).mint,
  ).toEqual([]);
  expect(
    tracker.step({ desynced, openDistressDirs: empty, nowSec: 1799 }).mint,
  ).toEqual([]);
  expect(
    tracker.step({ desynced, openDistressDirs: empty, nowSec: 1800 }).mint
      .length,
  ).toBe(1);
});

test("desync tracker: a restart (fresh tracker) still level-clears a row minted before it, and re-mints at most once", () => {
  const grace = 300;
  // Simulate a daemon restart: a brand-new tracker with an empty in-memory latch, but the
  // durable desync row for REPO_A is still open in the projection (which re-seeds the
  // probe's watched set → the open-row dir set drives the clear).
  const fresh = createSharedCheckoutDesyncTracker(grace);
  const open = new Set([REPO_A]);
  // The checkout caught up during downtime: not desynced now, row still open → the
  // projection-driven clear fires even though this instance never minted it.
  const cleared = fresh.step({
    desynced: new Map(),
    openDistressDirs: open,
    nowSec: 9000,
  });
  expect(cleared.clear.map((c) => c.id)).toEqual([
    sharedDesyncDistressId(REPO_A),
  ]);

  // Alternatively, still desynced after the restart: the fresh clock re-arms and re-mints
  // ONCE after a full grace (the accepted bounded per-restart burst).
  const fresh2 = createSharedCheckoutDesyncTracker(grace);
  const desynced = new Map([[REPO_A, DESYNC_BLOCKER]]);
  let mints = 0;
  for (let ts = 9000; ts < 9000 + 2 * grace; ts++) {
    mints += fresh2.step({ desynced, openDistressDirs: open, nowSec: ts }).mint
      .length;
  }
  expect(mints).toBe(1);
});

test("desync + wedge + dirty distress rows for the SAME repo never cross-clear (distinct ids, independent open sets)", () => {
  const grace = 300;
  const desyncTracker = createSharedCheckoutDesyncTracker(grace);
  const wedgeTracker = createSharedCheckoutWedgeTracker(grace);
  const dirtyTracker = createSharedCheckoutDirtyTracker(grace);
  const open = new Set([REPO_A]);
  // Each tracker fed NOTHING active but its own open row → each clears ONLY its own id.
  const desyncClear = desyncTracker.step({
    desynced: new Map(),
    openDistressDirs: open,
    nowSec: 5000,
  });
  const wedgeClear = wedgeTracker.step({
    wedged: new Map(),
    openDistressDirs: open,
    nowSec: 5000,
  });
  const dirtyClear = dirtyTracker.step({
    dirty: new Map(),
    openDistressDirs: open,
    nowSec: 5000,
  });
  expect(desyncClear.clear.map((c) => c.id)).toEqual([
    sharedDesyncDistressId(REPO_A),
  ]);
  expect(wedgeClear.clear.map((c) => c.id)).toEqual([
    sharedWedgeDistressId(REPO_A),
  ]);
  expect(dirtyClear.clear.map((c) => c.id)).toEqual([
    sharedDirtyDistressId(REPO_A),
  ]);
  // The three ids are pairwise distinct — no clear could ever target another's row.
  expect(sharedDesyncDistressId(REPO_A)).not.toBe(
    sharedWedgeDistressId(REPO_A),
  );
  expect(sharedDesyncDistressId(REPO_A)).not.toBe(
    sharedDirtyDistressId(REPO_A),
  );
  expect(sharedWedgeDistressId(REPO_A)).not.toBe(sharedDirtyDistressId(REPO_A));
});

// The desync content probe (probeSharedCheckoutDesync) — every git decision through a
// scripted GitRunner fake, no real git. `desynced:false` is the SOLE clear evidence
// (on-default + no MERGE_HEAD + empty `status --porcelain -uno`); every other state (and
// every inconclusive probe) reports `desynced:true` so a real signal is never
// false-cleared.

/** A scripted GitRunner modeling one checkout's state for the desync probe. */
function makeDesyncProbeGit(opts: {
  branch?: string; // current branch (default "main")
  defaultBranch?: string; // resolved default (default "main")
  mergeHead?: boolean; // MERGE_HEAD present
  statusExit?: number; // `git status` exit code (default 0)
  porcelain?: string; // `status --porcelain -uno` stdout (default clean "")
}): GitRunner {
  const def = opts.defaultBranch ?? "main";
  const branch = opts.branch ?? "main";
  return async (args, _o) => {
    const joined = args.join(" ");
    // resolveDefaultBranch: symbolic-ref (origin/HEAD) → `origin/<def>`.
    if (joined === "symbolic-ref --short refs/remotes/origin/HEAD") {
      return { code: 0, stdout: `origin/${def}\n`, stderr: "" };
    }
    if (joined.startsWith("for-each-ref")) {
      return { code: 0, stdout: `${def}\n`, stderr: "" };
    }
    // currentBranch.
    if (joined === "rev-parse --abbrev-ref HEAD") {
      return { code: 0, stdout: `${branch}\n`, stderr: "" };
    }
    if (joined === "rev-parse --verify --quiet MERGE_HEAD") {
      return opts.mergeHead
        ? { code: 0, stdout: "deadbeef\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "" };
    }
    if (joined === "status --porcelain --untracked-files=no") {
      return {
        code: opts.statusExit ?? 0,
        stdout: opts.porcelain ?? "",
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

test("desync probe: on-default + no MERGE_HEAD + clean porcelain → SYNCED (the clear evidence)", async () => {
  const verdict: CheckoutDesyncProbe = await probeSharedCheckoutDesync(
    REPO_A,
    makeDesyncProbeGit({ branch: "main", defaultBranch: "main" }),
  );
  expect(verdict).toEqual({ desynced: false });
});

test("desync probe: off the default branch → desynced, off-default blocker named", async () => {
  const verdict = await probeSharedCheckoutDesync(
    REPO_A,
    makeDesyncProbeGit({ branch: "feature/x", defaultBranch: "main" }),
  );
  expect(verdict.desynced).toBe(true);
  if (verdict.desynced) {
    expect(verdict.blocker).toContain("off-default");
    expect(verdict.blocker).toContain("feature/x");
  }
});

test("desync probe: mid-merge (MERGE_HEAD present) → desynced, mid-merge blocker named", async () => {
  const verdict = await probeSharedCheckoutDesync(
    REPO_A,
    makeDesyncProbeGit({
      branch: "main",
      defaultBranch: "main",
      mergeHead: true,
    }),
  );
  expect(verdict.desynced).toBe(true);
  if (verdict.desynced) {
    expect(verdict.blocker).toContain("mid-merge");
  }
});

test("desync probe: on-default but dirty porcelain (index/worktree ≠ HEAD) → desynced, content-trailing", async () => {
  // Both observed states satisfy the contract: a STAGED delta (index behind HEAD) and an
  // UNSTAGED delta (index==HEAD, worktree stale) each leave porcelain non-empty.
  for (const porcelain of ["M  src/x.ts\n", " M src/x.ts\n"]) {
    const verdict = await probeSharedCheckoutDesync(
      REPO_A,
      makeDesyncProbeGit({ branch: "main", defaultBranch: "main", porcelain }),
    );
    expect(verdict.desynced).toBe(true);
    if (verdict.desynced) {
      expect(verdict.blocker).toContain("content-trailing");
    }
  }
});

test("desync probe: an inconclusive git result (status probe failed) → desynced (never a false clear)", async () => {
  const verdict = await probeSharedCheckoutDesync(
    REPO_A,
    makeDesyncProbeGit({
      branch: "main",
      defaultBranch: "main",
      statusExit: 128,
    }),
  );
  expect(verdict.desynced).toBe(true);
});

test("desync probe: a THROWING runner degrades to desynced, never propagates the throw", async () => {
  const throwing: GitRunner = async () => {
    throw new Error("git spawn boom");
  };
  const verdict = await probeSharedCheckoutDesync(REPO_A, throwing);
  expect(verdict.desynced).toBe(true);
});

// ---------------------------------------------------------------------------
// fn-1123.2 — the fan-in LANE pre-merge wedge escalation + verb-agnostic
// reason-scoped clear. The lane tracker is the per-LANE sibling of the shared-
// checkout wedge tracker (keyed by lane worktree PATH, own id/reason surface), with
// an extra IMMEDIATE short-circuit for a hard `abort-failed` lane. All expected
// values are hand-computed constants, never re-derived from the tracker/helper.
// ---------------------------------------------------------------------------

const LANE_A = "/Users/x/worktrees/lane-a";
const LANE_B = "/Users/x/worktrees/lane-b";
const LANE_DIRTY_OBS: LaneWedgeObservation = {
  path: LANE_A,
  reason: "dirty: /Users/x/worktrees/lane-a — M src/foo.ts",
  immediate: false,
};

test("LANE_WEDGE_GRACE_SEC is the ~5min grace watermark", () => {
  expect(LANE_WEDGE_GRACE_SEC).toBe(5 * 60);
});

test("laneWedgeDistressId is per-lane stable, distinct across lanes + prefix-tagged, and yields a synthetic-verb distress key", () => {
  const a = laneWedgeDistressId(LANE_A);
  expect(a).toBe(laneWedgeDistressId(LANE_A)); // stable across calls
  expect(a).not.toBe(laneWedgeDistressId(LANE_B)); // distinct across lanes
  expect(a.startsWith(LANE_WEDGE_DISTRESS_ID_PREFIX)).toBe(true);
  // The composite is a per-lane distress key the orphan-GC exempts + only a
  // level-trigger clears (the synthetic `daemon` verb).
  expect(isLaneWedgeDistressKey("daemon", a)).toBe(true);
});

test("lane wedge tracker: a divergent-dirty base past the grace mints EXACTLY once (graced)", () => {
  const grace = 300;
  const tracker = createLaneWedgeTracker(grace);
  const wedged = new Map([[LANE_A, LANE_DIRTY_OBS]]);
  const empty = new Set<string>();
  // t=1000 first observed → grace clock starts, no mint.
  expect(
    tracker.step({ wedged, openDistressDirs: empty, nowSec: 1000 }).mint,
  ).toEqual([]);
  // Just short of grace → still no mint (a transient dirt settles inside the window).
  expect(
    tracker.step({ wedged, openDistressDirs: empty, nowSec: 1299 }).mint,
  ).toEqual([]);
  // Exactly grace elapsed → mint once, keyed per-lane, reason display-mapped.
  const crossed = tracker.step({
    wedged,
    openDistressDirs: empty,
    nowSec: 1300,
  });
  expect(crossed.mint.length).toBe(1);
  expect(crossed.mint[0]?.id).toBe(laneWedgeDistressId(LANE_A));
  expect(crossed.mint[0]?.dir).toBe(LANE_A);
  expect(crossed.mint[0]?.reason?.startsWith(LANE_WEDGE_DISTRESS_REASON)).toBe(
    true,
  );
  // O(1): never re-mint while still wedged.
  for (const ts of [1301, 1600, 5000]) {
    expect(
      tracker.step({ wedged, openDistressDirs: empty, nowSec: ts }).mint,
    ).toEqual([]);
  }
});

test("lane wedge tracker: a hard abort-failed lane mints an IMMEDIATE distress (not graced)", () => {
  const grace = 300;
  const tracker = createLaneWedgeTracker(grace);
  const immediateObs: LaneWedgeObservation = {
    path: LANE_A,
    reason:
      "abort-failed: /Users/x/worktrees/lane-a is mid-merge (MERGE_HEAD=deadbeef) and could not be cleared",
    immediate: true,
  };
  // FIRST observation, grace clock just started (sinceSec === nowSec) → an immediate
  // lane mints AT ONCE, matching finalizeEpic's abort-failed precedent.
  const first = tracker.step({
    wedged: new Map([[LANE_A, immediateObs]]),
    openDistressDirs: new Set<string>(),
    nowSec: 1000,
  });
  expect(first.mint.length).toBe(1);
  expect(first.mint[0]?.id).toBe(laneWedgeDistressId(LANE_A));
  expect(first.mint[0]?.reason).toContain("hard-wedged");
  // Still O(1): no re-mint while it stays wedged.
  expect(
    tracker.step({
      wedged: new Map([[LANE_A, immediateObs]]),
      openDistressDirs: new Set<string>(),
      nowSec: 1001,
    }).mint,
  ).toEqual([]);
});

test("lane wedge tracker: a resolved lane level-clears its open distress EXACTLY once", () => {
  const grace = 300;
  const tracker = createLaneWedgeTracker(grace);
  const open = new Set([LANE_A]);
  // Still wedged → no clear.
  expect(
    tracker.step({
      wedged: new Map([[LANE_A, LANE_DIRTY_OBS]]),
      openDistressDirs: open,
      nowSec: 2000,
    }).clear,
  ).toEqual([]);
  // Lane goes ready/gone (no fresh wedge) but the row is open → level-clear once.
  const recovered = tracker.step({
    wedged: new Map(),
    openDistressDirs: open,
    nowSec: 2001,
  });
  expect(recovered.clear.map((c) => c.id)).toEqual([
    laneWedgeDistressId(LANE_A),
  ]);
  // Once folded, the row leaves openDistressDirs → no re-clear.
  expect(
    tracker.step({
      wedged: new Map(),
      openDistressDirs: new Set(),
      nowSec: 2002,
    }).clear,
  ).toEqual([]);
});

test("lane wedge distress is a DISTINCT surface from the shared-checkout wedge — ids never collide", () => {
  // Even for the same underlying string, the lane id prefix differs from the
  // shared-checkout one, so the two distress surfaces never cross-classify/clear.
  expect(laneWedgeDistressId(REPO_A)).not.toBe(sharedWedgeDistressId(REPO_A));
  expect(isLaneWedgeDistressKey("daemon", sharedWedgeDistressId(REPO_A))).toBe(
    false,
  );
});

test("laneFailuresToClear: positive-evidence — clears a resolved-and-not-wedged row, retains on absence, never clears a still-wedged one", () => {
  const workRow = {
    verb: "work" as const,
    id: "fn-1-foo.2",
    dir: LANE_A,
  };
  // Resolved AND not wedged → cleared (bypasses the router's dead work-task arm).
  expect(laneFailuresToClear([workRow], new Set(), new Set([LANE_A]))).toEqual([
    { verb: "work", id: "fn-1-foo.2" },
  ]);
  // Still wedged this cycle → NEVER clear (the never-clear-what-still-fails guard),
  // even if it also appears resolved (a stale/duplicate observation).
  expect(
    laneFailuresToClear([workRow], new Set([LANE_A]), new Set([LANE_A])),
  ).toEqual([]);
  // No observation for it this cycle → RETAINED (absence is never resolution — the
  // silent-skip defect the shared recover clear also closes).
  expect(laneFailuresToClear([workRow], new Set(), new Set())).toEqual([]);
});

test("laneFailuresToClear is verb-agnostic — a work AND a close lane row both clear by lane path", () => {
  const rows = [
    { verb: "work" as const, id: "fn-1-foo.2", dir: LANE_A },
    { verb: "close" as const, id: "fn-1-foo", dir: LANE_B },
  ];
  const cleared = laneFailuresToClear(
    rows,
    new Set(),
    new Set([LANE_A, LANE_B]),
  );
  expect(cleared).toEqual([
    { verb: "work", id: "fn-1-foo.2" },
    { verb: "close", id: "fn-1-foo" },
  ]);
});

// ---------------------------------------------------------------------------
// fn-1144 — the owning-worker liveness gate on the GRACED lane-wedge escalation.
// A healthy running worker's fan-in base is naturally dirty with WIP, so the graced
// wedge must NOT page a human while its owner is alive+progressing; only a dead/stalled
// owner (or a hard `immediate` abort-failed lane) still escalates. Grace / now /
// updated_at are hand-picked constants; idle = now - updated_at reasoned by hand
// against LANE_OWNER_STALL_GRACE (300), never re-derived from the helper.
// ---------------------------------------------------------------------------

const LANE_OWNER_GRACE = 300;
// A live `work` owner in LANE_A, folding events at `updated_at`; `state`/`pane`/`ts`
// per case. Pane "%1" is the live backend pane a stopped-arm owner is probed against.
function laneOwnerJobs(over: Partial<Job>): Map<string, Job> {
  return new Map([
    [
      "j",
      makeJob({
        job_id: "j",
        plan_verb: "work",
        plan_ref: "fn-1-foo.1",
        cwd: LANE_A,
        state: "working",
        backend_exec_pane_id: "%1",
        updated_at: 1000,
        ...over,
      }),
    ],
  ]);
}

test("LANE_OWNER_STALL_GRACE_SEC is the ~5min owner-progress watermark", () => {
  expect(LANE_OWNER_STALL_GRACE_SEC).toBe(5 * 60);
});

test("laneOwnerAliveAndProgressing: a WORKING owner folding within grace → true (withhold)", () => {
  // idle 200 < 300 → progressing. A `working` owner needs no pane probe.
  const jobs = laneOwnerJobs({ state: "working", updated_at: 1000 });
  expect(
    laneOwnerAliveAndProgressing(
      LANE_A,
      jobs,
      new Set(["%1"]),
      1200,
      LANE_OWNER_GRACE,
    ),
  ).toBe(true);
});

test("laneOwnerAliveAndProgressing: a STOPPED-but-live owner folding within grace → true", () => {
  // stopped + its backend pane still live + idle 200 < 300 → progressing (parked-alive).
  const jobs = laneOwnerJobs({
    state: "stopped",
    backend_exec_pane_id: "%1",
    updated_at: 1000,
  });
  expect(
    laneOwnerAliveAndProgressing(
      LANE_A,
      jobs,
      new Set(["%1"]),
      1200,
      LANE_OWNER_GRACE,
    ),
  ).toBe(true);
});

test("laneOwnerAliveAndProgressing: NO owner in the lane → false (dead → escalate)", () => {
  // Empty jobs, and a live work job in a DIFFERENT lane, both read dead for LANE_A.
  expect(
    laneOwnerAliveAndProgressing(
      LANE_A,
      new Map(),
      new Set(["%1"]),
      1200,
      LANE_OWNER_GRACE,
    ),
  ).toBe(false);
  const elsewhere = laneOwnerJobs({
    cwd: LANE_B,
    state: "working",
    updated_at: 1200,
  });
  expect(
    laneOwnerAliveAndProgressing(
      LANE_A,
      elsewhere,
      new Set(["%1"]),
      1200,
      LANE_OWNER_GRACE,
    ),
  ).toBe(false);
});

test("laneOwnerAliveAndProgressing: a STOPPED owner whose pane is GONE → false (dead)", () => {
  // stopped + pane absent from the live set → not a live occupant, even fresh.
  const jobs = laneOwnerJobs({
    state: "stopped",
    backend_exec_pane_id: "%1",
    updated_at: 1150,
  });
  expect(
    laneOwnerAliveAndProgressing(
      LANE_A,
      jobs,
      new Set(["%other"]),
      1200,
      LANE_OWNER_GRACE,
    ),
  ).toBe(false);
});

test("laneOwnerAliveAndProgressing: a terminal (ended) owner → false (dead)", () => {
  const jobs = laneOwnerJobs({ state: "ended", updated_at: 1200 });
  expect(
    laneOwnerAliveAndProgressing(
      LANE_A,
      jobs,
      new Set(["%1"]),
      1200,
      LANE_OWNER_GRACE,
    ),
  ).toBe(false);
});

test("laneOwnerAliveAndProgressing: a live owner STALLED past grace → false (escalate)", () => {
  // idle 400 >= 300 → stalled, whether it is `working` or `stopped`-and-live.
  const working = laneOwnerJobs({ state: "working", updated_at: 800 });
  expect(
    laneOwnerAliveAndProgressing(
      LANE_A,
      working,
      new Set(["%1"]),
      1200,
      LANE_OWNER_GRACE,
    ),
  ).toBe(false);
  const parked = laneOwnerJobs({
    state: "stopped",
    backend_exec_pane_id: "%1",
    updated_at: 800,
  });
  expect(
    laneOwnerAliveAndProgressing(
      LANE_A,
      parked,
      new Set(["%1"]),
      1200,
      LANE_OWNER_GRACE,
    ),
  ).toBe(false);
});

test("laneOwnerAliveAndProgressing: stall grace boundary — idle === grace stalls, idle < grace progresses", () => {
  // now 1300, updated 1000 → idle 300 === grace → stalled (>=) → false.
  expect(
    laneOwnerAliveAndProgressing(
      LANE_A,
      laneOwnerJobs({ state: "working", updated_at: 1000 }),
      new Set(["%1"]),
      1300,
      LANE_OWNER_GRACE,
    ),
  ).toBe(false);
  // now 1299 → idle 299 < grace → progressing → true.
  expect(
    laneOwnerAliveAndProgressing(
      LANE_A,
      laneOwnerJobs({ state: "working", updated_at: 1000 }),
      new Set(["%1"]),
      1299,
      LANE_OWNER_GRACE,
    ),
  ).toBe(true);
});

test("laneOwnerAliveAndProgressing: DEGRADED probe (livePaneIds null) → false even for a fresh working owner", () => {
  // No trustworthy liveness picture → fall back to the pre-gate behavior (escalate),
  // never suppress a genuine distress signal on an unprobeable cycle.
  const jobs = laneOwnerJobs({ state: "working", updated_at: 1200 });
  expect(
    laneOwnerAliveAndProgressing(LANE_A, jobs, null, 1200, LANE_OWNER_GRACE),
  ).toBe(false);
});

test("laneOwnerAliveAndProgressing: only a `work` owner counts — a close/resolve session in the lane does not", () => {
  const closer = laneOwnerJobs({
    plan_verb: "close",
    state: "working",
    updated_at: 1200,
  });
  expect(
    laneOwnerAliveAndProgressing(
      LANE_A,
      closer,
      new Set(["%1"]),
      1200,
      LANE_OWNER_GRACE,
    ),
  ).toBe(false);
});

test("gateWedgedLanesByLiveness: a graced lane under a live+progressing owner is WITHHELD (no mint feed)", () => {
  const jobs = laneOwnerJobs({ state: "working", updated_at: 1000 }); // idle 200 < 300
  const out = gateWedgedLanesByLiveness(
    [LANE_DIRTY_OBS],
    jobs,
    new Set(["%1"]),
    1200,
    LANE_OWNER_GRACE,
  );
  expect(out.size).toBe(0);
});

test("gateWedgedLanesByLiveness: a graced lane under a DEAD owner is INCLUDED (escalates)", () => {
  const out = gateWedgedLanesByLiveness(
    [LANE_DIRTY_OBS],
    new Map(),
    new Set(["%1"]),
    1200,
    LANE_OWNER_GRACE,
  );
  expect(out.get(LANE_A)?.immediate).toBe(false);
  expect(out.get(LANE_A)?.reason).toBe(LANE_DIRTY_OBS.reason);
});

test("gateWedgedLanesByLiveness: a graced lane under a STALLED owner is INCLUDED", () => {
  const jobs = laneOwnerJobs({ state: "working", updated_at: 800 }); // idle 400 >= 300
  const out = gateWedgedLanesByLiveness(
    [LANE_DIRTY_OBS],
    jobs,
    new Set(["%1"]),
    1200,
    LANE_OWNER_GRACE,
  );
  expect(out.has(LANE_A)).toBe(true);
});

test("gateWedgedLanesByLiveness: a hard IMMEDIATE lane bypasses the gate — INCLUDED under a live+progressing owner", () => {
  const immediateObs: LaneWedgeObservation = {
    path: LANE_A,
    reason:
      "abort-failed: /Users/x/worktrees/lane-a is mid-merge (MERGE_HEAD=deadbeef) and could not be cleared",
    immediate: true,
  };
  const jobs = laneOwnerJobs({ state: "working", updated_at: 1000 }); // alive+progressing
  const out = gateWedgedLanesByLiveness(
    [immediateObs],
    jobs,
    new Set(["%1"]),
    1200,
    LANE_OWNER_GRACE,
  );
  expect(out.get(LANE_A)?.immediate).toBe(true);
});

test("gateWedgedLanesByLiveness: DEGRADED probe → graced lane INCLUDED (pre-gate behavior)", () => {
  const jobs = laneOwnerJobs({ state: "working", updated_at: 1200 });
  const out = gateWedgedLanesByLiveness(
    [LANE_DIRTY_OBS],
    jobs,
    null,
    1200,
    LANE_OWNER_GRACE,
  );
  expect(out.has(LANE_A)).toBe(true);
});

test("gateWedgedLanesByLiveness: dedup preserved — an immediate beats a graced entry for the same lane, gate withholds only the graced one", () => {
  const immediateObs: LaneWedgeObservation = {
    path: LANE_A,
    reason: "abort-failed: /Users/x/worktrees/lane-a mid-merge",
    immediate: true,
  };
  // Live+progressing owner: the graced obs is withheld, the immediate obs still lands →
  // exactly one entry, immediate.
  const alive = laneOwnerJobs({ state: "working", updated_at: 1000 });
  const gated = gateWedgedLanesByLiveness(
    [LANE_DIRTY_OBS, immediateObs],
    alive,
    new Set(["%1"]),
    1200,
    LANE_OWNER_GRACE,
  );
  expect(gated.size).toBe(1);
  expect(gated.get(LANE_A)?.immediate).toBe(true);
  // Dead owner: the graced obs lands first, the immediate obs upgrades it → immediate.
  const upgraded = gateWedgedLanesByLiveness(
    [LANE_DIRTY_OBS, immediateObs],
    new Map(),
    new Set(["%1"]),
    1200,
    LANE_OWNER_GRACE,
  );
  expect(upgraded.get(LANE_A)?.immediate).toBe(true);
});

// ── fn-1203 tip-triggered baseline producer ──────────────────────────────────

// A fixed toolchain fingerprint (hand-specified) so key composition is
// deterministic and never reads the environment.
const TIP_TOOLCHAIN = { bunVersion: "1.2.3", platform: "linux-x64" };
// Two full-length hand-specified shas standing in for a repo's trunk tips.
const TIP_SHA_A = "a".repeat(40);
const TIP_SHA_B = "b".repeat(40);

test("gatherTipObservations: one observation per open-epic repo, keyed to its git head", () => {
  const epics = [
    makeEpic({ epic_id: "fn-1-foo", project_dir: "/repo-1", status: "open" }),
    makeEpic({ epic_id: "fn-2-bar", project_dir: "/repo-2", status: "todo" }),
  ];
  const heads = new Map([
    ["/repo-1", TIP_SHA_A],
    ["/repo-2", TIP_SHA_B],
  ]);
  const obs = gatherTipObservations(epics, heads);
  expect(obs).toEqual([
    { repoDir: "/repo-1", tipSha: TIP_SHA_A },
    { repoDir: "/repo-2", tipSha: TIP_SHA_B },
  ]);
});

test("gatherTipObservations: a done epic, a null project_dir, and a repo with no git head all yield nothing", () => {
  const epics = [
    makeEpic({
      epic_id: "fn-1-done",
      project_dir: "/repo-done",
      status: "done",
    }),
    makeEpic({ epic_id: "fn-2-null", project_dir: null, status: "open" }),
    makeEpic({
      epic_id: "fn-3-nohead",
      project_dir: "/repo-fresh",
      status: "open",
    }),
  ];
  // Only `/repo-done` has a head — but its epic is done; `/repo-fresh` (open) has
  // no head (initial-commit repo, dropped by the projection).
  const heads = new Map([["/repo-done", TIP_SHA_A]]);
  expect(gatherTipObservations(epics, heads)).toEqual([]);
});

test("gatherTipObservations: many open epics in one repo collapse to a single observation", () => {
  const epics = [
    makeEpic({ epic_id: "fn-1-a", project_dir: "/repo", status: "open" }),
    makeEpic({ epic_id: "fn-2-b", project_dir: "/repo", status: "todo" }),
    makeEpic({ epic_id: "fn-3-c", project_dir: "/repo", status: "open" }),
  ];
  const heads = new Map([["/repo", TIP_SHA_A]]);
  expect(gatherTipObservations(epics, heads)).toEqual([
    { repoDir: "/repo", tipSha: TIP_SHA_A },
  ]);
});

test("planTipBaselineRequests: a changed tip yields exactly one request for the newest sha", () => {
  const prevTip = new Map([["/repo", TIP_SHA_A]]);
  const { requests, nextTip } = planTipBaselineRequests({
    observations: [{ repoDir: "/repo", tipSha: TIP_SHA_B }],
    prevTip,
    toolchain: TIP_TOOLCHAIN,
    now: 5000,
  });
  expect(requests.length).toBe(1);
  expect(requests[0]?.sha).toBe(TIP_SHA_B);
  expect(requests[0]?.repoDir).toBe("/repo");
  expect(requests[0]?.requestedAt).toBe(5000);
  expect(requests[0]?.toolchain).toEqual(TIP_TOOLCHAIN);
  // nextTip adopts the new tip so the next cycle sees it as unchanged.
  expect(nextTip.get("/repo")).toBe(TIP_SHA_B);
});

test("planTipBaselineRequests: an unchanged tip yields no request but still carries the tip forward", () => {
  const prevTip = new Map([["/repo", TIP_SHA_A]]);
  const { requests, nextTip } = planTipBaselineRequests({
    observations: [{ repoDir: "/repo", tipSha: TIP_SHA_A }],
    prevTip,
    toolchain: TIP_TOOLCHAIN,
    now: 5000,
  });
  expect(requests).toEqual([]);
  expect(nextTip.get("/repo")).toBe(TIP_SHA_A);
});

test("planTipBaselineRequests: a fresh boot (empty prevTip) spools each observed tip once", () => {
  const { requests } = planTipBaselineRequests({
    observations: [
      { repoDir: "/repo-1", tipSha: TIP_SHA_A },
      { repoDir: "/repo-2", tipSha: TIP_SHA_B },
    ],
    prevTip: new Map(),
    toolchain: TIP_TOOLCHAIN,
    now: 1,
  });
  expect(requests.map((r) => [r.repoDir, r.sha])).toEqual([
    ["/repo-1", TIP_SHA_A],
    ["/repo-2", TIP_SHA_B],
  ]);
});

test("planTipBaselineRequests: idempotent across cycles — feeding nextTip back yields no second request", () => {
  const observations: TipObservation[] = [
    { repoDir: "/repo", tipSha: TIP_SHA_A },
  ];
  const first = planTipBaselineRequests({
    observations,
    prevTip: new Map(),
    toolchain: TIP_TOOLCHAIN,
    now: 1,
  });
  expect(first.requests.length).toBe(1);
  const second = planTipBaselineRequests({
    observations,
    prevTip: first.nextTip,
    toolchain: TIP_TOOLCHAIN,
    now: 2,
  });
  expect(second.requests).toEqual([]);
});

test("planTipBaselineRequests: only the changed repo spools; an unchanged sibling stays quiet", () => {
  const prevTip = new Map([
    ["/repo-1", TIP_SHA_A],
    ["/repo-2", TIP_SHA_A],
  ]);
  const { requests } = planTipBaselineRequests({
    observations: [
      { repoDir: "/repo-1", tipSha: TIP_SHA_A }, // unchanged
      { repoDir: "/repo-2", tipSha: TIP_SHA_B }, // moved
    ],
    prevTip,
    toolchain: TIP_TOOLCHAIN,
    now: 9,
  });
  expect(requests.length).toBe(1);
  expect(requests[0]?.repoDir).toBe("/repo-2");
  expect(requests[0]?.sha).toBe(TIP_SHA_B);
});

test("planTipBaselineRequests: an empty/invalid sha observation is dropped, not spooled", () => {
  const { requests, nextTip } = planTipBaselineRequests({
    observations: [
      { repoDir: "/repo", tipSha: "" },
      { repoDir: "/repo-2", tipSha: "not-a-sha" },
    ],
    prevTip: new Map(),
    toolchain: TIP_TOOLCHAIN,
    now: 1,
  });
  expect(requests).toEqual([]);
  expect(nextTip.size).toBe(0);
});

test("planTipBaselineRequests: nextTip is bounded to the observed repo set — a repo that dropped out is forgotten", () => {
  const prevTip = new Map([
    ["/repo-1", TIP_SHA_A],
    ["/repo-gone", TIP_SHA_B],
  ]);
  const { nextTip } = planTipBaselineRequests({
    observations: [{ repoDir: "/repo-1", tipSha: TIP_SHA_A }],
    prevTip,
    toolchain: TIP_TOOLCHAIN,
    now: 1,
  });
  expect([...nextTip.keys()]).toEqual(["/repo-1"]);
});

test("gather + plan: a trunk tip advance on an open-epic repo produces exactly one request for the latest tip", () => {
  const epics = [
    makeEpic({ epic_id: "fn-1-foo", project_dir: "/repo", status: "open" }),
  ];
  // The projection already coalesced a push train to the latest head TIP_SHA_B.
  const heads = new Map([["/repo", TIP_SHA_B]]);
  const observations = gatherTipObservations(epics, heads);
  const { requests } = planTipBaselineRequests({
    observations,
    prevTip: new Map([["/repo", TIP_SHA_A]]),
    toolchain: TIP_TOOLCHAIN,
    now: 42,
  });
  expect(requests.length).toBe(1);
  expect(requests[0]?.sha).toBe(TIP_SHA_B);
});

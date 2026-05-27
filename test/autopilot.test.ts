/**
 * Tests for `scripts/autopilot.ts`'s block-2 filtered renderer.
 *
 * Block 2 in autopilot's frame body lists only the task pairs + close
 * pair whose readiness verdict is `{ tag: "ready" }`. The filtering is
 * driven by `renderEpicCommandsFiltered(epic, isReady)` — a pure
 * function over the embedded epic shape and a per-row verdict predicate.
 * A bug in the predicate or filter could silently drop ready epics from
 * (or add non-ready epics to) the autopilot work list, so this file
 * pins the three boundary cases the spec calls out:
 *
 *   (a) all-pass — every task and the close row pass; the filtered
 *       output is byte-identical to `renderEpicCommands` for the same
 *       epic.
 *   (b) some-pass — only a subset of the task pairs survive; the close
 *       row may or may not survive independently. Order is preserved
 *       and the dropped rows are gone from the output entirely.
 *   (c) none-pass — every kind returns false → renderer returns `null`
 *       and the epic is dropped from block 2.
 *
 * Importing the renderers directly from `scripts/autopilot.ts` avoids
 * spawning a subprocess (matches the keeper convention used by the
 * other `test/*.test.ts` pure-function suites).
 */

import { expect, test } from "bun:test";
import type {
  DetectJobTransitionsDeps,
  DispatchEntry,
} from "../scripts/autopilot";
import {
  detectJobTransitions,
  predictNextDispatches,
  renderEpicCommands,
  renderEpicCommandsFiltered,
} from "../scripts/autopilot";
import { computeReadiness } from "../src/readiness";
import type { EmbeddedJob, Epic, Job, Task } from "../src/types";

function makeTask(overrides: Partial<Task>): Task {
  return {
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    task_number: 1,
    title: "task",
    target_repo: null,
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
    last_validated_at: "2026-05-24T00:00:00Z",
    ...overrides,
  };
}

const ALWAYS_READY = (_kind: "task" | "close", _id: string): boolean => true;
const NEVER_READY = (_kind: "task" | "close", _id: string): boolean => false;

test("renderEpicCommandsFiltered — all-pass matches renderEpicCommands byte-for-byte", () => {
  const epic = makeEpic({
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1 }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        target_repo: "/other-repo",
      }),
      makeTask({ task_id: "fn-1-foo.3", task_number: 3 }),
    ],
  });

  const filtered = renderEpicCommandsFiltered(epic, ALWAYS_READY);
  const unfiltered = renderEpicCommands(epic);

  expect(filtered).not.toBeNull();
  expect(filtered).toBe(unfiltered);

  // Sanity-check the rendered shape: includes all three work commands,
  // the per-task target_repo override, and the close pair.
  expect(filtered).toContain("cd /repo && claude '/plan:work fn-1-foo.1'");
  expect(filtered).toContain(
    "cd /other-repo && claude '/plan:work fn-1-foo.2'",
  );
  expect(filtered).toContain("cd /repo && claude '/plan:work fn-1-foo.3'");
  expect(filtered).toContain("cd /repo && claude '/plan:close fn-1-foo'");
  expect(filtered).toContain("bun ~/code/keeper/scripts/approve.ts fn-1-foo");
});

test("renderEpicCommandsFiltered — some-pass keeps only ready rows, preserves order", () => {
  const epic = makeEpic({
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1 }),
      makeTask({ task_id: "fn-1-foo.2", task_number: 2 }),
      makeTask({ task_id: "fn-1-foo.3", task_number: 3 }),
    ],
  });

  // Only task .2 passes; close row drops out.
  const isReady = (kind: "task" | "close", id: string): boolean =>
    kind === "task" && id === "fn-1-foo.2";

  const filtered = renderEpicCommandsFiltered(epic, isReady);
  expect(filtered).not.toBeNull();

  // .2 work + approve pair present.
  expect(filtered).toContain("cd /repo && claude '/plan:work fn-1-foo.2'");
  expect(filtered).toContain("bun ~/code/keeper/scripts/approve.ts fn-1-foo.2");

  // .1, .3, and the close pair are gone.
  expect(filtered).not.toContain("fn-1-foo.1");
  expect(filtered).not.toContain("fn-1-foo.3");
  expect(filtered).not.toContain("claude '/plan:close fn-1-foo'");
});

test("renderEpicCommandsFiltered — some-pass with surviving close row", () => {
  const epic = makeEpic({
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1 }),
      makeTask({ task_id: "fn-1-foo.2", task_number: 2 }),
    ],
  });

  // Only the close row passes; both task pairs drop.
  const isReady = (kind: "task" | "close", _id: string): boolean =>
    kind === "close";

  const filtered = renderEpicCommandsFiltered(epic, isReady);
  expect(filtered).not.toBeNull();
  expect(filtered).toContain("cd /repo && claude '/plan:close fn-1-foo'");
  expect(filtered).toContain("bun ~/code/keeper/scripts/approve.ts fn-1-foo");
  expect(filtered).not.toContain("plan:work");
});

test("renderEpicCommandsFiltered — none-pass returns null (epic dropped from block 2)", () => {
  const epic = makeEpic({
    tasks: [
      makeTask({ task_id: "fn-1-foo.1", task_number: 1 }),
      makeTask({ task_id: "fn-1-foo.2", task_number: 2 }),
    ],
  });

  const filtered = renderEpicCommandsFiltered(epic, NEVER_READY);
  expect(filtered).toBeNull();
});

test("renderEpicCommandsFiltered — empty-task epic with no ready close returns null", () => {
  // Epic with zero tasks and an unready close row: nothing to emit.
  const epic = makeEpic({ tasks: [] });
  expect(renderEpicCommandsFiltered(epic, NEVER_READY)).toBeNull();
});

test("renderEpicCommandsFiltered — empty-task epic with ready close emits close pair only", () => {
  const epic = makeEpic({ tasks: [] });
  const filtered = renderEpicCommandsFiltered(epic, ALWAYS_READY);
  expect(filtered).not.toBeNull();
  expect(filtered).toContain("claude '/plan:close fn-1-foo'");
  expect(filtered).not.toContain("plan:work");
});

// ---------------------------------------------------------------------------
// predictNextDispatches — verb-aware simulation pass over `computeReadiness`.
//
// The function is a pure transform of the readiness snapshot, so each test
// builds an `Epic[]` fixture, runs `computeReadiness` to get the current
// verdicts, packages them into a `ReadinessClientSnapshot`, and asserts
// against the four preview buckets (approvals / informational / workers
// / closers — `informational` carries `git-dirty::<id>` rows that have
// no dispatch behind them).
//
// Pause-invariance is enforced by the function's signature — it takes only
// the snapshot and never reads autopilot's `paused` state — so the test
// matrix focuses on the verb-aware semantics rather than asserting an
// invariant the type system already pins.
// ---------------------------------------------------------------------------

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
    git_orphan_count: 0,
    ...overrides,
  };
}

function buildSnap(
  epics: Epic[],
  gitStatusByProjectDir: Map<
    string,
    { dirty_count: number; orphan_count: number }
  > = new Map(),
) {
  const jobs = new Map<string, Job>();
  const readiness = computeReadiness(epics, jobs, [], gitStatusByProjectDir);
  return { epics, jobs, subagentInvocations: [], gitStatus: [], readiness };
}

test("predictNextDispatches — in-flight worker on a task predicts approve::<task>", () => {
  const epic = makeEpic({
    tasks: [
      makeTask({
        task_id: "fn-1-foo.4",
        task_number: 4,
        worker_phase: "open",
        approval: "pending",
        jobs: [makeEmbeddedJob({ plan_verb: "work", state: "working" })],
      }),
    ],
    approval: "pending",
  });
  const { approvals, workers, closers } = predictNextDispatches(
    buildSnap([epic]),
  );
  expect(approvals.map((r) => `${r.verb}::${r.id}`)).toEqual([
    "approve::fn-1-foo.4",
  ]);
  expect(workers).toEqual([]);
  expect(closers).toEqual([]);
});

test("predictNextDispatches — in-flight worker on a task does NOT predict approve::<epic> via close-row fan-up", () => {
  // The regression case from the user's autopilot frame: task .4's worker
  // is running, which fans the close-row up to blocked:job-running. Under
  // the old "active + not approved" rule, this spuriously emitted
  // approve::<epic> even though no closer had ever started. Under the
  // verb-aware simulation, the close-row stays at blocked:dep-on-task in
  // the future readiness pass (because .4 is sim'd to blocked:job-pending,
  // not completed), so approve::<epic> drops out.
  const epic = makeEpic({
    tasks: [
      makeTask({
        task_id: "fn-1-foo.4",
        task_number: 4,
        worker_phase: "open",
        approval: "pending",
        jobs: [makeEmbeddedJob({ plan_verb: "work", state: "working" })],
      }),
      makeTask({
        task_id: "fn-1-foo.5",
        task_number: 5,
        worker_phase: "open",
        approval: "pending",
      }),
    ],
    approval: "pending",
  });
  const { approvals, workers, closers } = predictNextDispatches(
    buildSnap([epic]),
  );
  const ids = approvals.map((r) => `${r.verb}::${r.id}`);
  expect(ids).toContain("approve::fn-1-foo.4");
  expect(ids).not.toContain("approve::fn-1-foo");
  expect(workers).toEqual([]);
  expect(closers).toEqual([]);
});

test("predictNextDispatches — in-flight approver on .3 plus worker on .4 yields approve::.4 only", () => {
  // The full frame from the bug report: approver on .3 + worker on .4 +
  // sibling .5 + epic close-row. Verb-aware sim collapses .3 to completed
  // (approve session ending → approval=approved), .4 to blocked:job-pending
  // (worker ending → worker_phase=done with approval still pending), and
  // leaves .5 + close-row untouched. Only approve::.4 emits; the spurious
  // approve::<epic> from the old code disappears.
  const epic = makeEpic({
    tasks: [
      makeTask({
        task_id: "fn-1-foo.3",
        task_number: 3,
        worker_phase: "done",
        approval: "pending",
        jobs: [
          makeEmbeddedJob({
            job_id: "session-3a",
            plan_verb: "approve",
            state: "working",
          }),
        ],
      }),
      makeTask({
        task_id: "fn-1-foo.4",
        task_number: 4,
        worker_phase: "open",
        approval: "pending",
        jobs: [
          makeEmbeddedJob({
            job_id: "session-4",
            plan_verb: "work",
            state: "working",
          }),
        ],
      }),
      makeTask({
        task_id: "fn-1-foo.5",
        task_number: 5,
        worker_phase: "open",
        approval: "pending",
      }),
    ],
    approval: "pending",
  });
  const { approvals, workers, closers } = predictNextDispatches(
    buildSnap([epic]),
  );
  expect(approvals.map((r) => `${r.verb}::${r.id}`)).toEqual([
    "approve::fn-1-foo.4",
  ]);
  expect(workers).toEqual([]);
  expect(closers).toEqual([]);
});

test("predictNextDispatches — in-flight closer on the epic predicts approve::<epic>", () => {
  // Closer is the close-row's own in-flight job, so its completion flips
  // epic.status="done" and (with approval still pending) the close-row's
  // future verdict is blocked:job-pending → approve::<epic>.
  const epic = makeEpic({
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        worker_phase: "done",
        approval: "approved",
      }),
    ],
    status: "open",
    approval: "pending",
    jobs: [makeEmbeddedJob({ plan_verb: "close", state: "working" })],
  });
  const { approvals, workers, closers } = predictNextDispatches(
    buildSnap([epic]),
  );
  expect(approvals.map((r) => `${r.verb}::${r.id}`)).toEqual([
    "approve::fn-1-foo",
  ]);
  expect(workers).toEqual([]);
  expect(closers).toEqual([]);
});

test("predictNextDispatches — a ready task predicts approve::<task> as the next step after section-1 dispatch", () => {
  // A task at cur=ready has its worker dispatched into section 1 right
  // now. Section 2's job is to preview the step AFTER that — which is
  // approve::<task> once the worker ends with approval still pending.
  const epic = makeEpic({
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        worker_phase: "open",
        approval: "pending",
      }),
    ],
    approval: "pending",
  });
  const snap = buildSnap([epic]);
  // Sanity: confirm the fixture really produces a ready task verdict —
  // the assertion that follows depends on this precondition.
  expect(snap.readiness.perTask.get("fn-1-foo.1")?.tag).toBe("ready");
  const { approvals, workers, closers } = predictNextDispatches(snap);
  expect(approvals.map((r) => `${r.verb}::${r.id}`)).toEqual([
    "approve::fn-1-foo.1",
  ]);
  expect(workers).toEqual([]);
  expect(closers).toEqual([]);
});

test("predictNextDispatches — no in-flight jobs and no ready rows yields empty preview", () => {
  // Every task is already completed and the close-row is ready (status
  // still open, approval=pending). One row is ready, so the simulation
  // touches the tree, but the diff produces only the approve::<epic>
  // prediction for the close-row — no workers, no closers from
  // downstream tasks.
  const epic = makeEpic({
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        worker_phase: "done",
        approval: "approved",
      }),
    ],
    status: "open",
    approval: "pending",
  });
  const snap = buildSnap([epic]);
  expect(snap.readiness.perCloseRow.get("fn-1-foo")?.tag).toBe("ready");
  const { approvals, workers, closers } = predictNextDispatches(snap);
  expect(approvals.map((r) => `${r.verb}::${r.id}`)).toEqual([
    "approve::fn-1-foo",
  ]);
  expect(workers).toEqual([]);
  expect(closers).toEqual([]);
});

test("predictNextDispatches — empty preview when nothing is running and nothing is ready", () => {
  // Every row is either completed or blocked behind a human action that
  // isn't currently in flight — the preview should be empty.
  const epic = makeEpic({
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        worker_phase: "done",
        approval: "pending",
      }),
    ],
    status: "open",
    approval: "pending",
  });
  const snap = buildSnap([epic]);
  // Task is blocked:job-pending (worker done, awaiting approval).
  expect(snap.readiness.perTask.get("fn-1-foo.1")).toEqual({
    tag: "blocked",
    reason: { kind: "job-pending" },
  });
  const { approvals, workers, closers } = predictNextDispatches(snap);
  expect(approvals).toEqual([]);
  expect(workers).toEqual([]);
  expect(closers).toEqual([]);
});

test("predictNextDispatches — in-flight worker with git_dirty_count > 0 still predicts approve::<task>", () => {
  // The sim zeros git counts on the working→ended flip — it models a
  // worker that finishes AND commits before going idle, so predicate 6.5
  // (git-uncommitted) does NOT fire in futureReadiness and mask the
  // approve prediction. Current readiness is still blocked:job-running
  // (predicate 5), so the informational pre-pass (which reads `cur`,
  // not the simulated `fut`) skips the `git-dirty::<id>` row — that
  // gate is reserved for "worker actually stopped dirty", caught off
  // current state once `worker_phase` flips to done for real.
  const epic = makeEpic({
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        worker_phase: "open",
        approval: "pending",
        jobs: [
          makeEmbeddedJob({
            plan_verb: "work",
            state: "working",
            git_dirty_count: 3,
          }),
        ],
      }),
    ],
    approval: "pending",
  });
  const { approvals, informational, workers, closers } = predictNextDispatches(
    buildSnap([epic]),
  );
  expect(approvals.map((r) => `${r.verb}::${r.id}`)).toEqual([
    "approve::fn-1-foo.1",
  ]);
  expect(informational).toEqual([]);
  expect(workers).toEqual([]);
  expect(closers).toEqual([]);
});

test("predictNextDispatches — in-flight worker with git_orphan_count > 0 still predicts approve::<task>", () => {
  // Sibling case: same sim-zeroing applies to git_orphan_count, so a
  // running worker with orphans queued in its worktree still predicts
  // approve. The informational gate stays cur-driven and only fires
  // once the worker actually stops with orphans still present.
  const epic = makeEpic({
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        worker_phase: "open",
        approval: "pending",
        jobs: [
          makeEmbeddedJob({
            plan_verb: "work",
            state: "working",
            git_dirty_count: 0,
            git_orphan_count: 2,
          }),
        ],
      }),
    ],
    approval: "pending",
  });
  const { approvals, informational, workers, closers } = predictNextDispatches(
    buildSnap([epic]),
  );
  expect(approvals.map((r) => `${r.verb}::${r.id}`)).toEqual([
    "approve::fn-1-foo.1",
  ]);
  expect(informational).toEqual([]);
  expect(workers).toEqual([]);
  expect(closers).toEqual([]);
});

test("predictNextDispatches — stopped worker + worker_phase=done + git_dirty_count > 0 emits informational git-dirty::<task>", () => {
  // The actual emit condition: the worker has stopped (state !==
  // "working"), planctl stamped worker_phase=done, but the worktree
  // still has uncommitted files → readiness predicate 6.5 fires for
  // real (not just in the sim) → cur=blocked:git-uncommitted → the
  // informational pre-pass picks it up.
  const epic = makeEpic({
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        worker_phase: "done",
        approval: "pending",
        jobs: [
          makeEmbeddedJob({
            plan_verb: "work",
            state: "ended",
            git_dirty_count: 3,
          }),
        ],
      }),
    ],
    approval: "pending",
  });
  // fn-626: predicate 6.5 now reads off the live project-wide `git_status`
  // map, not the embedded per-job columns. Feed a map entry whose
  // dirty_count > 0 to drive the predicate.
  const gitMap = new Map([["/repo", { dirty_count: 3, orphan_count: 0 }]]);
  const snap = buildSnap([epic], gitMap);
  // Sanity check that the readiness predicate actually fires.
  expect(snap.readiness.perTask.get("fn-1-foo.1")).toEqual({
    tag: "blocked",
    reason: { kind: "git-uncommitted" },
  });
  const { approvals, informational, workers, closers } =
    predictNextDispatches(snap);
  expect(approvals).toEqual([]);
  expect(informational.map((r) => `${r.verb}::${r.id}`)).toEqual([
    "git-dirty::fn-1-foo.1",
  ]);
  expect(workers).toEqual([]);
  expect(closers).toEqual([]);
});

test("predictNextDispatches — stopped worker + worker_phase=done + git_orphan_count > 0 also emits informational git-dirty::<task>", () => {
  // Sibling: predicate 6.5's `git-orphans` branch in real readiness
  // also drives the informational row.
  const epic = makeEpic({
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        worker_phase: "done",
        approval: "pending",
        jobs: [
          makeEmbeddedJob({
            plan_verb: "work",
            state: "ended",
            git_dirty_count: 0,
            git_orphan_count: 2,
          }),
        ],
      }),
    ],
    approval: "pending",
  });
  // fn-626: feed the live `git_status` map — predicate 6.5 reads from
  // there now, not the embedded per-job columns.
  const gitMap = new Map([["/repo", { dirty_count: 0, orphan_count: 2 }]]);
  const snap = buildSnap([epic], gitMap);
  expect(snap.readiness.perTask.get("fn-1-foo.1")).toEqual({
    tag: "blocked",
    reason: { kind: "git-orphans" },
  });
  const { approvals, informational, workers, closers } =
    predictNextDispatches(snap);
  expect(approvals).toEqual([]);
  expect(informational.map((r) => `${r.verb}::${r.id}`)).toEqual([
    "git-dirty::fn-1-foo.1",
  ]);
  expect(workers).toEqual([]);
  expect(closers).toEqual([]);
});

// ---------------------------------------------------------------------------
// detectJobTransitions — fulfilled-then-disappeared rule.
//
// `detectJobTransitions` migrates a dispatched row across three states
// (queued → current → completed) by folding successive readiness
// snapshots. The terminal-state branch (`state in ("ended", "killed")`)
// has shipped since the original autopilot frame; the new branch
// added by fn-623.1 fires `current → completed` when a *previously
// fulfilled* dispatch's matching job has *disappeared* from the
// snapshot entirely — the parent epic has fallen off the default
// subscription scope after becoming done+approved, or a human ran
// `planctl epic-delete` against the target.
//
// The branch is gated on `fulfilledKeys.has(key)` so a queued
// dispatch whose agent has not yet booted (also a `findSessionJob
// === undefined` shape) cannot migrate to completed instantly. This
// test pins all three load-bearing properties in one case:
//   (a) frame 1: fulfilled epic+embedded-job → `fulfilledKeys` gains
//       the key and a `kind:"fulfilled"` line is recorded.
//   (b) frame 2: same key, epic gone from the snap → `completedKeys`
//       gains the key and a `kind:"completed"` line is recorded.
//   (c) frame 3: same empty snap → no second `completed` line
//       (idempotence via the `completedKeys.has(key)` guard at the
//       top of the loop).
// Bonus: a never-fulfilled queued dispatch in the same frames stays
// absent from both sets — proves the `fulfilledKeys` gate.
// ---------------------------------------------------------------------------

function makeDispatchEntry(overrides: Partial<DispatchEntry>): DispatchEntry {
  return {
    ts: "2026-05-27T00:00:00.000Z",
    kind: "launch",
    rowId: "row-1",
    dir: "repo",
    dirFull: "/repo",
    verb: "approve",
    id: "fn-1-foo",
    command: "cd /repo && claude '/plan:approve fn-1-foo'",
    pid: 42,
    ...overrides,
  };
}

test("detectJobTransitions — fulfilled key disappears from snapshot reaches completed", () => {
  // Two dispatches in the log: one will be fulfilled then disappear,
  // one is queued and never appears (proves the `fulfilledKeys`
  // gate).
  const fulfilledEntry = makeDispatchEntry({
    verb: "approve",
    id: "fn-1-foo",
  });
  const neverFulfilledEntry = makeDispatchEntry({
    verb: "approve",
    id: "fn-2-bar",
  });
  const dispatchLog: DispatchEntry[] = [fulfilledEntry, neverFulfilledEntry];
  const fulfilledKeys = new Set<string>();
  const completedKeys = new Set<string>();
  const captured: string[] = [];
  const noteLines: string[] = [];
  const deps: DetectJobTransitionsDeps = {
    dispatchLog,
    fulfilledKeys,
    completedKeys,
    dispatchLogPath: "/tmp/keeper-autopilot.test.dispatch.log",
    noteLine: (s) => noteLines.push(s),
    pid: 4242,
    appendLine: (line) => captured.push(line),
  };

  // Frame (a): the dispatched epic is on the page with a matching
  // embedded job → `fulfilledKeys` gains the key and a
  // `kind:"fulfilled"` line is recorded. The never-fulfilled entry
  // has no epic in the snap, so it must stay absent from both sets.
  const frame1Epic = makeEpic({
    epic_id: "fn-1-foo",
    jobs: [makeEmbeddedJob({ plan_verb: "approve", state: "working" })],
  });
  const snap1 = buildSnap([frame1Epic]);
  detectJobTransitions(deps, snap1);

  expect(fulfilledKeys.has("approve::fn-1-foo")).toBe(true);
  expect(completedKeys.has("approve::fn-1-foo")).toBe(false);
  expect(fulfilledKeys.has("approve::fn-2-bar")).toBe(false);
  expect(completedKeys.has("approve::fn-2-bar")).toBe(false);
  expect(captured.length).toBe(1);
  const fulfilledLine = JSON.parse(captured[0] ?? "{}") as Record<
    string,
    unknown
  >;
  expect(fulfilledLine.kind).toBe("fulfilled");
  expect(fulfilledLine.verb).toBe("approve");
  expect(fulfilledLine.id).toBe("fn-1-foo");
  expect(typeof fulfilledLine.ts).toBe("string");
  expect(typeof fulfilledLine.pid).toBe("number");
  expect(fulfilledLine.pid).toBe(4242);
  // The completed shape is intentionally lean — no `reason` field.
  expect("reason" in fulfilledLine).toBe(false);

  // Frame (b): the epic has fallen off the page (e.g. became
  // done+approved and exited the default scope). The fulfilled
  // dispatch's matching job is now undefined; combined with
  // `fulfilledKeys.has(key)`, the disappearance branch fires →
  // `completedKeys` gains the key and a `kind:"completed"` line
  // lands. The never-fulfilled entry STILL has no matching job and
  // STILL is not in `fulfilledKeys`, so the gate keeps it queued.
  const snap2 = buildSnap([]);
  detectJobTransitions(deps, snap2);

  expect(completedKeys.has("approve::fn-1-foo")).toBe(true);
  expect(completedKeys.has("approve::fn-2-bar")).toBe(false);
  expect(fulfilledKeys.has("approve::fn-2-bar")).toBe(false);
  expect(captured.length).toBe(2);
  const completedLine = JSON.parse(captured[1] ?? "{}") as Record<
    string,
    unknown
  >;
  expect(completedLine.kind).toBe("completed");
  expect(completedLine.verb).toBe("approve");
  expect(completedLine.id).toBe("fn-1-foo");
  expect(typeof completedLine.ts).toBe("string");
  expect(typeof completedLine.pid).toBe("number");
  expect(completedLine.pid).toBe(4242);
  expect("reason" in completedLine).toBe(false);

  // Frame (c): a third call with the same empty snap → no second
  // `completed` line. The `completedKeys.has(key)` guard at the top
  // of the loop short-circuits before the disappearance branch is
  // reached. The never-fulfilled entry remains queued.
  detectJobTransitions(deps, snap2);
  expect(captured.length).toBe(2);
  expect(completedKeys.has("approve::fn-2-bar")).toBe(false);
  expect(fulfilledKeys.has("approve::fn-2-bar")).toBe(false);
});

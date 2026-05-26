/**
 * Pure-function tests for `src/readiness-client.ts`'s `projectRows`
 * helper that feeds the readiness handoff. Regression coverage for the
 * `byId`-collapse bug:
 *
 * `SUBAGENT_INVOCATIONS_DESCRIPTOR` exposes `job_id` as the wire pk
 * even though the SQL composite identity is
 * `(job_id, agent_id, turn_seq)`. Re-entrant sub-agents in one
 * session land on distinct rows via the per-job monotone `turn_seq`
 * counter, so multiple rows can share a `job_id`. If the readiness
 * handoff reads from `byId.values()`, those rows collapse
 * last-write-wins and predicate 6 (`own-progress-sub`) false-
 * negatives. The fix routes the readiness handoff through
 * `projectRows`, which reads from `state.rows` — the full wire-
 * order row stream from the most recent `result` frame.
 *
 * These tests assert:
 *   1. `projectRows` returns every row in `state.rows` (no collapse).
 *   2. Two `running` invocations sharing one `job_id` reach
 *      `computeReadiness` and produce `[blocked:sub-agent-running]`.
 *
 * `projectRows` now lives in `src/readiness-client.ts`; this file
 * retains the `test/board.test.ts` name because the regression is
 * board-traceable (the bug surfaced in board's readiness handoff and
 * the assertion still mirrors that exact code path). The same
 * helper is consumed by `scripts/autopilot.ts` post-extraction, so
 * keeping the test name doesn't mislead.
 */

import { expect, test } from "bun:test";
import { renderJobLinkLines } from "../scripts/board";
import { computeReadiness } from "../src/readiness";
import { projectRows } from "../src/readiness-client";
import type {
  EmbeddedJob,
  Epic,
  Job,
  JobLinkEntry,
  SubagentInvocation,
  Task,
} from "../src/types";

// ---------------------------------------------------------------------------
// Fixture builders — minimal, matched to test/readiness.test.ts shape
// ---------------------------------------------------------------------------

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
    last_validated_at: "2026-05-24T00:00:00Z",
    ...overrides,
  };
}

function makeEmbeddedJob(overrides: Partial<EmbeddedJob>): EmbeddedJob {
  return {
    job_id: "worker-1",
    plan_verb: "work",
    state: "stopped",
    title: null,
    created_at: 0,
    updated_at: 0,
    last_event_id: 0,
    rate_limited_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// projectRows — pure helper assertions
// ---------------------------------------------------------------------------

test("projectRows returns every row in state.rows (no byId collapse)", () => {
  const rows = [
    { job_id: "worker-1", agent_id: "agent-1", turn_seq: 0, status: "running" },
    { job_id: "worker-1", agent_id: "agent-2", turn_seq: 1, status: "running" },
    { job_id: "worker-1", agent_id: "agent-3", turn_seq: 2, status: "ok" },
  ];
  const result = projectRows<{ job_id: string; turn_seq: number }>({ rows });
  expect(result).toHaveLength(3);
  expect(result.map((r) => r.turn_seq)).toEqual([0, 1, 2]);
});

test("projectRows preserves wire order", () => {
  const rows = [
    { job_id: "a" },
    { job_id: "b" },
    { job_id: "a" },
    { job_id: "c" },
  ];
  const result = projectRows<{ job_id: string }>({ rows });
  expect(result.map((r) => r.job_id)).toEqual(["a", "b", "a", "c"]);
});

test("projectRows on empty rows yields empty array", () => {
  expect(projectRows({ rows: [] })).toEqual([]);
});

// ---------------------------------------------------------------------------
// End-to-end: two running invocations sharing one job_id reach
// computeReadiness and block the readiness verdict.
// ---------------------------------------------------------------------------

test("two running invocations on one job_id both reach computeReadiness and block", () => {
  // Session has a worker job that has *stopped* (so predicate 5,
  // own-progress-main, doesn't fire), but two re-entrant sub-agents
  // are still running on that same job_id. Predicate 6
  // (own-progress-sub) must fire.
  const task = makeTask({
    worker_phase: "open",
    approval: "approved",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [task] });

  // Two running invocations share one job_id, distinguished by (agent_id, turn_seq).
  // This is exactly the shape `byId.values()` collapsed — both must survive.
  const subRows = [
    makeSub({
      job_id: "worker-1",
      agent_id: "agent-A",
      turn_seq: 0,
      status: "running",
    }),
    makeSub({
      job_id: "worker-1",
      agent_id: "agent-B",
      turn_seq: 1,
      status: "running",
    }),
  ];

  // Simulate the board.ts hand-off: stash rows in a CollectionState-shaped
  // wrapper, project through projectRows<SubagentInvocation>, hand to
  // computeReadiness — the same code path scripts/board.ts uses post-fix.
  const projected = projectRows<SubagentInvocation>({ rows: subRows });
  expect(projected).toHaveLength(2);

  const snap = computeReadiness([epic], new Map<string, Job>(), projected);

  expect(snap.perTask.get(task.task_id)).toEqual({
    tag: "blocked",
    reason: { kind: "sub-agent-running" },
  });
});

// ---------------------------------------------------------------------------
// renderJobLinkLines — schema v21 widened JobLinkEntry, single-branch render
// ---------------------------------------------------------------------------

/**
 * Build a schema-v21 `JobLinkEntry` with defaults matching
 * `enrichJobLink`'s missing-row defaults (`title: null, state: "stopped",
 * rate_limited_at: null`). Callers override per-test.
 */
function makeLink(overrides: Partial<JobLinkEntry>): JobLinkEntry {
  return {
    kind: "refiner",
    job_id: "session-1",
    title: null,
    state: "stopped",
    rate_limited_at: null,
    ...overrides,
  };
}

test("renderJobLinkLines: empty / non-array input → []", () => {
  expect(renderJobLinkLines([])).toEqual([]);
  expect(renderJobLinkLines(undefined)).toEqual([]);
  expect(renderJobLinkLines(null)).toEqual([]);
  expect(renderJobLinkLines("not an array")).toEqual([]);
});

test("renderJobLinkLines: one entry, all fields populated → one line, title + kind + state pills", () => {
  const out = renderJobLinkLines([
    makeLink({
      kind: "creator",
      job_id: "sess-A",
      title: "Plan epic 7",
      state: "working",
    }),
  ]);
  expect(out).toEqual(["   Plan epic 7 [creator] [working]"]);
});

test("renderJobLinkLines: null title falls back to job_id (preserves line shape)", () => {
  // Schema-v21 fallback: when the embedded title is null (e.g. a
  // shell-inserted epic whose linked session has no captured title
  // yet), the renderer subs in `job_id` so the readable label stays
  // present and the bracket pill columns stay aligned.
  const out = renderJobLinkLines([
    makeLink({
      kind: "refiner",
      job_id: "sess-no-title",
      title: null,
      state: "stopped",
    }),
  ]);
  expect(out).toEqual(["   sess-no-title [refiner] [stopped]"]);
});

test("renderJobLinkLines: rate_limited_at non-null appends [limited] pill (same line shape, live + terminal + off-page all)", () => {
  // The [limited] pill is the only render variation; the spec says the
  // entry shape is now uniform across live / terminal / off-page —
  // there's no second branch to test, just the optional pill segment.
  const out = renderJobLinkLines([
    makeLink({
      kind: "creator",
      job_id: "sess-rl",
      title: "Plan epic 8",
      state: "stopped",
      rate_limited_at: 1700000000,
    }),
  ]);
  expect(out).toEqual(["   Plan epic 8 [creator] [stopped] [limited]"]);
});

test("renderJobLinkLines: multiple entries iterate in provided order (projection's own (kind, job_id) ASC sort)", () => {
  const out = renderJobLinkLines([
    makeLink({
      kind: "creator",
      job_id: "sess-A",
      title: "First",
      state: "working",
    }),
    makeLink({
      kind: "refiner",
      job_id: "sess-B",
      title: "Second",
      state: "stopped",
    }),
  ]);
  expect(out).toEqual([
    "   First [creator] [working]",
    "   Second [refiner] [stopped]",
  ]);
});

test("byId-style collapse (legacy bug) would only deliver one row", () => {
  // Reproduce the pre-fix collapse for documentation: a Map keyed on
  // `job_id` keeps only the last row inserted for that key. This test
  // pins the SHAPE of the bug so a future regression is unambiguous.
  const rows = [
    makeSub({ job_id: "worker-1", agent_id: "agent-A", turn_seq: 0 }),
    makeSub({ job_id: "worker-1", agent_id: "agent-B", turn_seq: 1 }),
  ];
  const byId = new Map<string, SubagentInvocation>();
  for (const row of rows) {
    byId.set(row.job_id, row);
  }
  // Only one row survives the collapse — the very loss projectRows fixes.
  expect(Array.from(byId.values())).toHaveLength(1);
  // The fix path delivers both:
  expect(projectRows<SubagentInvocation>({ rows })).toHaveLength(2);
});

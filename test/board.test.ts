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
import { colorizePillsInLine, renderJobLinkLines } from "../scripts/board";
import { computeReadiness } from "../src/readiness";
import { collapseSubagentsByName, projectRows } from "../src/readiness-client";
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
    created_by_closer_of: null,
    sort_path: "000001",
    queue_jump: 0,
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
    last_api_error_at: null,
    last_api_error_kind: null,
    last_input_request_at: null,
    last_input_request_kind: null,
    git_dirty_count: 0,
    git_orphan_count: 0,
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
// collapseSubagentsByName — client-side same-name collapse + stuck-orphan count
// ---------------------------------------------------------------------------

test("collapseSubagentsByName: empty input → []", () => {
  expect(collapseSubagentsByName([])).toEqual([]);
});

test("collapseSubagentsByName: single row → one group, count=1, stuck=0", () => {
  const row = makeSub({
    job_id: "j",
    subagent_type: "plan:worker-high",
    turn_seq: 0,
    status: "running",
  });
  const out = collapseSubagentsByName([row]);
  expect(out).toHaveLength(1);
  expect(out[0]?.row).toBe(row);
  expect(out[0]?.count).toBe(1);
  expect(out[0]?.stuck).toBe(0);
});

test("collapseSubagentsByName: same name keeps max turn_seq, counts all rows", () => {
  // Four rows, none stuck — `running:0 → ok:1 → ok:2 → ok:3` collapses to ok:3.
  // count = 4, stuck = 0 because the only `running` row is non-surviving but
  // there's NO later `running` survivor either, so the "stuck" definition
  // ("non-surviving + status='running'") fires for turn_seq=0 only when a
  // LATER row supersedes it AND that row's status isn't running. Trace:
  // first row sets {row:0, count:1, stuck:0}. Next row (turn 1, ok)
  // supersedes; turn_seq=0 was running → stuck += 1 → {row:1, count:2, stuck:1}.
  // Then turn 2 ok → {row:2, count:3, stuck:1}. Then turn 3 ok → {row:3, count:4, stuck:1}.
  const rows = [
    makeSub({
      job_id: "j",
      subagent_type: "plan:worker-high",
      turn_seq: 0,
      status: "running",
    }),
    makeSub({
      job_id: "j",
      subagent_type: "plan:worker-high",
      turn_seq: 1,
      status: "ok",
    }),
    makeSub({
      job_id: "j",
      subagent_type: "plan:worker-high",
      turn_seq: 2,
      status: "ok",
    }),
    makeSub({
      job_id: "j",
      subagent_type: "plan:worker-high",
      turn_seq: 3,
      status: "ok",
    }),
  ];
  const out = collapseSubagentsByName(rows);
  expect(out).toHaveLength(1);
  expect(out[0]?.row.turn_seq).toBe(3);
  expect(out[0]?.row.status).toBe("ok");
  expect(out[0]?.count).toBe(4);
  expect(out[0]?.stuck).toBe(1);
});

test("collapseSubagentsByName: fn-593.3 shape — running orphan masked, stuck=1", () => {
  // Exact shape from the wedged fn-593.3 session — ok:0, running:1 (orphan),
  // ok:2, ok:3. The surviving row is ok:3; turn_seq=1's `running` is a
  // non-surviving stuck orphan that gets counted but doesn't reach
  // computeReadiness via the subscribe loop.
  const rows = [
    makeSub({
      job_id: "j",
      subagent_type: "plan:worker-high",
      turn_seq: 0,
      status: "ok",
    }),
    makeSub({
      job_id: "j",
      subagent_type: "plan:worker-high",
      turn_seq: 1,
      status: "running",
    }),
    makeSub({
      job_id: "j",
      subagent_type: "plan:worker-high",
      turn_seq: 2,
      status: "ok",
    }),
    makeSub({
      job_id: "j",
      subagent_type: "plan:worker-high",
      turn_seq: 3,
      status: "ok",
    }),
  ];
  const [group] = collapseSubagentsByName(rows);
  expect(group?.row.turn_seq).toBe(3);
  expect(group?.row.status).toBe("ok");
  expect(group?.count).toBe(4);
  expect(group?.stuck).toBe(1);
});

test("collapseSubagentsByName: surviving row running → not stuck (currently running)", () => {
  // Two rows, `ok:0 → running:1`. The surviving row (turn 1) IS running,
  // which is the normal "currently running" case — NOT stuck.
  const rows = [
    makeSub({
      job_id: "j",
      subagent_type: "plan:worker-high",
      turn_seq: 0,
      status: "ok",
    }),
    makeSub({
      job_id: "j",
      subagent_type: "plan:worker-high",
      turn_seq: 1,
      status: "running",
    }),
  ];
  const [g] = collapseSubagentsByName(rows);
  expect(g?.row.status).toBe("running");
  expect(g?.count).toBe(2);
  expect(g?.stuck).toBe(0);
});

test("collapseSubagentsByName: different subagent_types don't collapse", () => {
  const rows = [
    makeSub({
      job_id: "j",
      subagent_type: "plan:worker-high",
      turn_seq: 0,
      status: "ok",
    }),
    makeSub({
      job_id: "j",
      subagent_type: "plan:repo-scout",
      turn_seq: 1,
      status: "running",
    }),
  ];
  const out = collapseSubagentsByName(rows);
  expect(out).toHaveLength(2);
  expect(out.map((g) => g.row.subagent_type)).toEqual([
    "plan:worker-high",
    "plan:repo-scout",
  ]);
});

test("collapseSubagentsByName: different job_ids don't collapse even with same name", () => {
  const rows = [
    makeSub({
      job_id: "j1",
      subagent_type: "plan:worker-high",
      turn_seq: 0,
      status: "ok",
    }),
    makeSub({
      job_id: "j2",
      subagent_type: "plan:worker-high",
      turn_seq: 0,
      status: "ok",
    }),
  ];
  const out = collapseSubagentsByName(rows);
  expect(out).toHaveLength(2);
  expect(out.map((g) => g.row.job_id)).toEqual(["j1", "j2"]);
});

test("collapseSubagentsByName: first-seen order preserved across groups", () => {
  // Rows arrive: A, B, A — output groups should be in [A, B] order (A's
  // FIRST appearance wins, not its last).
  const rows = [
    makeSub({ job_id: "j", subagent_type: "A", turn_seq: 0, status: "ok" }),
    makeSub({ job_id: "j", subagent_type: "B", turn_seq: 1, status: "ok" }),
    makeSub({ job_id: "j", subagent_type: "A", turn_seq: 2, status: "ok" }),
  ];
  const out = collapseSubagentsByName(rows);
  expect(out.map((g) => g.row.subagent_type)).toEqual(["A", "B"]);
});

test("collapseSubagentsByName: out-of-order input still keeps max turn_seq", () => {
  // Rows arrive in non-monotone turn_seq order (the wire stream is sorted
  // ascending today but the helper must not depend on that). Surviving
  // row is still the max turn_seq.
  const rows = [
    makeSub({ job_id: "j", subagent_type: "A", turn_seq: 5, status: "ok" }),
    makeSub({
      job_id: "j",
      subagent_type: "A",
      turn_seq: 3,
      status: "running",
    }),
    makeSub({ job_id: "j", subagent_type: "A", turn_seq: 7, status: "ok" }),
  ];
  const [g] = collapseSubagentsByName(rows);
  expect(g?.row.turn_seq).toBe(7);
  expect(g?.row.status).toBe("ok");
  expect(g?.stuck).toBe(1);
});

test("collapseSubagentsByName: null subagent_type groups together within a job", () => {
  // Two null-subagent_type rows on the same job collapse to one group —
  // null is treated as its own key value, not as "always distinct."
  const rows = [
    makeSub({
      job_id: "j",
      subagent_type: null,
      turn_seq: 0,
      status: "running",
    }),
    makeSub({ job_id: "j", subagent_type: null, turn_seq: 1, status: "ok" }),
  ];
  const out = collapseSubagentsByName(rows);
  expect(out).toHaveLength(1);
  expect(out[0]?.row.turn_seq).toBe(1);
  expect(out[0]?.count).toBe(2);
  expect(out[0]?.stuck).toBe(1);
});

test("collapseSubagentsByName: fn-593.3 collapse → predicate 6 stops blocking", () => {
  // The integration assertion: with the fn-593.3 row shape, the collapsed
  // slice handed to computeReadiness has the surviving row at status='ok'.
  // Predicate 6 (own-progress-sub) no longer fires, so the readiness
  // verdict for the row's owning task isn't `blocked:sub-agent-running`.
  // This is the autopilot-unsticking effect of the client-side collapse.
  const task = makeTask({
    worker_phase: "open",
    approval: "approved",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [task] });
  const subRows = [
    makeSub({
      job_id: "worker-1",
      subagent_type: "plan:worker-high",
      turn_seq: 0,
      status: "ok",
    }),
    makeSub({
      job_id: "worker-1",
      subagent_type: "plan:worker-high",
      turn_seq: 1,
      status: "running",
    }),
    makeSub({
      job_id: "worker-1",
      subagent_type: "plan:worker-high",
      turn_seq: 2,
      status: "ok",
    }),
    makeSub({
      job_id: "worker-1",
      subagent_type: "plan:worker-high",
      turn_seq: 3,
      status: "ok",
    }),
  ];
  const collapsed = collapseSubagentsByName(subRows).map((g) => g.row);
  const snap = computeReadiness([epic], new Map<string, Job>(), collapsed);
  const verdict = snap.perTask.get(task.task_id);
  // Whatever the verdict, it MUST NOT be sub-agent-running — the orphan
  // turn_seq=1 has been masked by the same-name collapse.
  if (verdict?.tag === "blocked") {
    expect(verdict.reason.kind).not.toBe("sub-agent-running");
  }
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
 * Build a schema-v25 `JobLinkEntry` with defaults matching
 * `enrichJobLink`'s missing-row defaults (`title: null, state: "stopped",
 * last_api_error_at: null, last_api_error_kind: null,
 * last_input_request_at: null, last_input_request_kind: null`). Callers
 * override per-test.
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
  expect(out).toEqual(["  Plan epic 7 [creator] [working]"]);
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
  expect(out).toEqual(["  sess-no-title [refiner] [stopped]"]);
});

test("renderJobLinkLines: last_api_error_at non-null appends [failed:<kind>] pill (same line shape, live + terminal + off-page all)", () => {
  // The api-error pill is the only render variation today. The spec
  // says the entry shape is uniform across live / terminal / off-page —
  // there's no second branch to test, just the optional pill segment.
  // The pill text is `[failed:<kind>]` where `<kind>` is taken straight
  // off `last_api_error_kind`, stamped by the reducer's dual-case
  // `RateLimited` / `ApiError` arm (schema v24).
  const out = renderJobLinkLines([
    makeLink({
      kind: "creator",
      job_id: "sess-rl",
      title: "Plan epic 8",
      state: "stopped",
      last_api_error_at: 1700000000,
      last_api_error_kind: "rate_limit",
    }),
  ]);
  expect(out).toEqual([
    "  Plan epic 8 [creator] [stopped] [failed:rate_limit]",
  ]);
});

// One render test per ApiErrorKind. Six positive cases — every kind
// the matcher emits (the openclaude SDK's six terminal kinds;
// `max_output_tokens` is excluded by design as recoverable). Each
// renders as `[failed:<kind>]` straight off `last_api_error_kind`.
test.each([
  "rate_limit",
  "authentication_failed",
  "billing_error",
  "server_error",
  "invalid_request",
  "unknown",
])(
  "renderJobLinkLines: kind=%s renders [failed:<kind>] pill",
  (kind: string) => {
    const out = renderJobLinkLines([
      makeLink({
        kind: "refiner",
        job_id: "sess-x",
        title: "Plan epic 9",
        state: "stopped",
        last_api_error_at: 1700000000,
        last_api_error_kind: kind,
      }),
    ]);
    expect(out).toEqual([`  Plan epic 9 [refiner] [stopped] [failed:${kind}]`]);
  },
);

// Defensive fallback: `at` non-null but `kind` happens to be null
// (should be unreachable per the reducer's paired-NULL invariant). The
// pill collapses to `[failed:unknown]` rather than the empty-inner
// `[failed:]` — keeps the line readable if a future shape-skew bug
// appears.
test("renderJobLinkLines: at non-null, kind null defensively renders [failed:unknown]", () => {
  const out = renderJobLinkLines([
    makeLink({
      kind: "creator",
      job_id: "sess-defensive",
      title: "Plan epic 10",
      state: "stopped",
      last_api_error_at: 1700000000,
      last_api_error_kind: null,
    }),
  ]);
  expect(out).toEqual(["  Plan epic 10 [creator] [stopped] [failed:unknown]"]);
});

// `last_input_request_at` non-null appends the `[awaiting:<kind>]` pill
// (warn/yellow via the colorizer's `awaiting:*` prefix fallback). Stacks
// AFTER `[failed:<kind>]` so a row carrying both annotations reads in
// lifecycle order (state → api-error → awaiting). Schema v25 introduced
// the `(last_input_request_at, last_input_request_kind)` pair on
// `JobLinkEntry` (cloned one-for-one off fn-616's api-error pair); the
// reducer's `InputRequest` fold stamps both columns together and four
// clear arms (UPS, SessionStart unconditional; PreToolUse, PostToolUse
// gated on `last_input_request_at IS NOT NULL`) zero them.
test("renderJobLinkLines: last_input_request_at non-null appends [awaiting:<kind>] pill", () => {
  const out = renderJobLinkLines([
    makeLink({
      kind: "creator",
      job_id: "sess-iq",
      title: "Plan epic 11",
      state: "stopped",
      last_input_request_at: 1700000000,
      last_input_request_kind: "ask_user_question",
    }),
  ]);
  expect(out).toEqual([
    "  Plan epic 11 [creator] [stopped] [awaiting:ask_user_question]",
  ]);
});

// Defensive fallback: `at` non-null but `kind` happens to be null
// (should be unreachable per the reducer's paired-NULL invariant). The
// pill collapses to `[awaiting:unknown]` rather than the empty-inner
// `[awaiting:]` — keeps the line readable if a future shape-skew bug
// appears. Mirrors the api-error defensive case.
test("renderJobLinkLines: input_request_at non-null, kind null defensively renders [awaiting:unknown]", () => {
  const out = renderJobLinkLines([
    makeLink({
      kind: "refiner",
      job_id: "sess-iq-defensive",
      title: "Plan epic 12",
      state: "stopped",
      last_input_request_at: 1700000000,
      last_input_request_kind: null,
    }),
  ]);
  expect(out).toEqual([
    "  Plan epic 12 [refiner] [stopped] [awaiting:unknown]",
  ]);
});

// Stacking-order snapshot — a row carrying BOTH api-error AND
// input-request annotations renders `[state] [failed:<kind>] [awaiting:<kind>]`
// in that order. Pins lifecycle order so a future change reordering pills
// is caught.
test("renderJobLinkLines: failed + awaiting stack in lifecycle order (state → failed → awaiting)", () => {
  const out = renderJobLinkLines([
    makeLink({
      kind: "creator",
      job_id: "sess-both",
      title: "Plan epic 13",
      state: "stopped",
      last_api_error_at: 1700000000,
      last_api_error_kind: "rate_limit",
      last_input_request_at: 1700000001,
      last_input_request_kind: "ask_user_question",
    }),
  ]);
  expect(out).toEqual([
    "  Plan epic 13 [creator] [stopped] [failed:rate_limit] [awaiting:ask_user_question]",
  ]);
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
    "  First [creator] [working]",
    "  Second [refiner] [stopped]",
  ]);
});

// ---------------------------------------------------------------------------
// colorizePillsInLine — pure string→string SGR coloring of bracketed pills
// ---------------------------------------------------------------------------

// SGR bytes mirror the table in scripts/board.ts. Re-declared here (not
// imported) so a regression that flips a bucket's color is caught — the
// test fails until the change is intentional in both places.
const ACTIVE = "\x1b[96m";
const SUCCESS = "\x1b[32m";
const ERROR = "\x1b[31m";
const WARN = "\x1b[33m";
const FADED = "\x1b[2;37m";
const RESET = "\x1b[0m";

test("colorizePillsInLine: unknown tokens pass through verbatim", () => {
  expect(colorizePillsInLine("(dir) 12 Foo [planner] [pending]")).toBe(
    "(dir) 12 Foo [planner] [pending]",
  );
});

test("colorizePillsInLine: each bucket colors its representative tokens", () => {
  expect(colorizePillsInLine("[running]")).toBe(`[${ACTIVE}running${RESET}]`);
  expect(colorizePillsInLine("[in_progress]")).toBe(
    `[${ACTIVE}in_progress${RESET}]`,
  );
  expect(colorizePillsInLine("[working]")).toBe(`[${ACTIVE}working${RESET}]`);
  expect(colorizePillsInLine("[ok]")).toBe(`[${SUCCESS}ok${RESET}]`);
  expect(colorizePillsInLine("[approved]")).toBe(
    `[${SUCCESS}approved${RESET}]`,
  );
  expect(colorizePillsInLine("[validated]")).toBe(
    `[${SUCCESS}validated${RESET}]`,
  );
  expect(colorizePillsInLine("[ready]")).toBe(`[${SUCCESS}ready${RESET}]`);
  expect(colorizePillsInLine("[done]")).toBe(`[${SUCCESS}done${RESET}]`);
  expect(colorizePillsInLine("[failed]")).toBe(`[${ERROR}failed${RESET}]`);
  expect(colorizePillsInLine("[rejected]")).toBe(`[${ERROR}rejected${RESET}]`);
  expect(colorizePillsInLine("[killed]")).toBe(`[${ERROR}killed${RESET}]`);
  expect(colorizePillsInLine("[blocked]")).toBe(`[${WARN}blocked${RESET}]`);
  expect(colorizePillsInLine("[completed]")).toBe(
    `[${FADED}completed${RESET}]`,
  );
  expect(colorizePillsInLine("[superseded]")).toBe(
    `[${FADED}superseded${RESET}]`,
  );
  expect(colorizePillsInLine("[exited]")).toBe(`[${FADED}exited${RESET}]`);
  expect(colorizePillsInLine("[stopped]")).toBe(`[${FADED}stopped${RESET}]`);
});

test("colorizePillsInLine: blocked:<reason> takes the warn bucket via prefix fallback", () => {
  expect(colorizePillsInLine("[blocked:dep-on-task fn-614.2]")).toBe(
    `[${WARN}blocked:dep-on-task fn-614.2${RESET}]`,
  );
  expect(colorizePillsInLine("[blocked:unknown]")).toBe(
    `[${WARN}blocked:unknown${RESET}]`,
  );
});

// `failed:<kind>` prefix fallback — the six ApiErrorKind tokens minted
// by `apiErrorPillSeg` all color the same as the bare `[failed]` exact
// match (error bucket, red SGR). Mirrors the `blocked:*` → warn pattern
// directly above.
test.each([
  "rate_limit",
  "authentication_failed",
  "billing_error",
  "server_error",
  "invalid_request",
  "unknown",
])(
  "colorizePillsInLine: failed:%s takes the error bucket via prefix fallback",
  (kind: string) => {
    expect(colorizePillsInLine(`[failed:${kind}]`)).toBe(
      `[${ERROR}failed:${kind}${RESET}]`,
    );
  },
);

// `awaiting:<kind>` prefix fallback — the input-request pills minted by
// `inputRequestPillSeg` all color the same as the bare `[blocked]` exact
// match (warn bucket, yellow SGR). Mirrors the `failed:*` → error and
// `blocked:*` → warn patterns directly above. The single member rendered
// today is `ask_user_question`; the fallback is open-ended (any future
// `InputRequestKind` lands in warn without a code change).
test("colorizePillsInLine: awaiting:ask_user_question takes the warn bucket via prefix fallback", () => {
  expect(colorizePillsInLine("[awaiting:ask_user_question]")).toBe(
    `[${WARN}awaiting:ask_user_question${RESET}]`,
  );
});

// `task-repo:<basename>` prefix fallback — the divergence pill minted
// by `taskRepoPillSeg` colors the same as `[blocked]` (warn bucket,
// yellow SGR). The basename can carry any path-safe character; the
// fallback is purely string-prefix-driven, so the payload renders
// verbatim inside the brackets.
test("colorizePillsInLine: task-repo:<basename> takes the warn bucket via prefix fallback", () => {
  expect(colorizePillsInLine("[task-repo:arthack]")).toBe(
    `[${WARN}task-repo:arthack${RESET}]`,
  );
  expect(colorizePillsInLine("[task-repo:my-side-repo]")).toBe(
    `[${WARN}task-repo:my-side-repo${RESET}]`,
  );
});

// Stacking-order snapshot rendered through the colorizer — a row
// carrying all three annotations (state + api-error + input-request)
// must color each pill independently in lifecycle order.
test("colorizePillsInLine: stopped + failed + awaiting stack colors independently in lifecycle order", () => {
  expect(
    colorizePillsInLine(
      "Plan epic 13 [creator] [stopped] [failed:rate_limit] [awaiting:ask_user_question]",
    ),
  ).toBe(
    `Plan epic 13 [creator] [${FADED}stopped${RESET}] [${ERROR}failed:rate_limit${RESET}] [${WARN}awaiting:ask_user_question${RESET}]`,
  );
});

test("colorizePillsInLine: multiple pills on one line each color independently", () => {
  expect(
    colorizePillsInLine("1. Foo [#2] [in_progress] [done] [pending]"),
  ).toBe(
    `1. Foo [#2] [${ACTIVE}in_progress${RESET}] [${SUCCESS}done${RESET}] [pending]`,
  );
});

test("colorizePillsInLine: dependency pills like [#2] are not pill tokens, pass through", () => {
  expect(colorizePillsInLine("(repo) 12 Foo [#2,#3] [validated] [ready]")).toBe(
    `(repo) 12 Foo [#2,#3] [${SUCCESS}validated${RESET}] [${SUCCESS}ready${RESET}]`,
  );
});

test("colorizePillsInLine: empty string yields empty string", () => {
  expect(colorizePillsInLine("")).toBe("");
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

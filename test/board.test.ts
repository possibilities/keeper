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
 *      `computeReadiness` and produce `[running:sub-agent-running]`.
 *
 * `projectRows` now lives in `src/readiness-client.ts`; this file
 * retains the `test/board.test.ts` name because the regression is
 * board-traceable (the bug surfaced in board's readiness handoff and
 * the assertion still mirrors that exact code path). The same
 * helper is consumed by `scripts/autopilot.ts` post-extraction, so
 * keeping the test name doesn't mislead.
 */

import { expect, test } from "bun:test";
import {
  boardFrameStateJson,
  boardSummaryLines,
  colorizePillsInLine,
  computeBoardSummary,
  epicNumFromIdOrBare,
  homedBlockedWorkRows,
  needsHumanLines,
  orphanedFailureRows,
  renderDeadLetterPill,
  renderEpicDepPills,
  renderHandoffLinkLines,
  renderJobLinkLines,
  serializeSubagentIndex,
  taskVerdictPill,
} from "../cli/board";
import {
  armedPill,
  epicHeaderLabel,
  iconizePills,
  pill,
  pillOrEmpty,
  renderClosePills,
  renderDispatchFailurePill,
  renderTaskCellPills,
  renderTaskPills,
  startedPill,
  subagentLinesFor,
  validatedPill,
} from "../src/board-render";
import {
  computeReadiness,
  type EpicDepResolution,
  formatPill,
  type Verdict,
} from "../src/readiness";
import { collapseSubagentsByName, projectRows } from "../src/readiness-client";
import type {
  EmbeddedJob,
  Epic,
  HandoffLinkEntry,
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
    // `tier` is a required nullable column on the `Task` shape (the
    // projection writes either a real tier string or NULL). Stamp NULL
    // here so the fixture compiles under `exactOptionalPropertyTypes`;
    // tests that care about a real tier override via `...overrides`.
    tier: null,
    // Plan-native worker model (model axis of the worker matrix); NULL here,
    // real value threaded via `...overrides` where a test cares.
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
    last_permission_prompt_at: null,
    last_permission_prompt_kind: null,
    git_dirty_count: 0,
    git_unattributed_to_live_count: 0,
    git_orphan_count: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// fn-1161: frames state-sidecar enrichment — the subagent index serialized in
// stable (job_id-sorted) order alongside epics, so a frames consumer has
// ground truth for stale-pill truthfulness checks by pointer.
// ---------------------------------------------------------------------------

test("serializeSubagentIndex sorts entries by job_id, preserves per-job order", () => {
  // Insert in job_id order c, a, b (mirrors arbitrary wire arrival) — the
  // serialized order must be a, b, c regardless of the Map's insertion order.
  const index = new Map<string, SubagentInvocation[]>();
  index.set("job-c", [
    makeSub({ job_id: "job-c", subagent_type: "z", turn_seq: 0, status: "ok" }),
  ]);
  index.set("job-a", [
    makeSub({ job_id: "job-a", subagent_type: "x", turn_seq: 0, status: "ok" }),
    makeSub({
      job_id: "job-a",
      subagent_type: "y",
      turn_seq: 1,
      status: "running",
    }),
  ]);
  index.set("job-b", [
    makeSub({ job_id: "job-b", subagent_type: "w", turn_seq: 0, status: "ok" }),
  ]);

  const out = serializeSubagentIndex(index);
  expect(out.map((e) => e.job_id)).toEqual(["job-a", "job-b", "job-c"]);
  // Per-job invocation order is preserved (the board feeds it turn_seq asc).
  expect(out[0]?.invocations.map((i) => i.subagent_type)).toEqual(["x", "y"]);
});

test("serializeSubagentIndex on an empty index yields []", () => {
  expect(serializeSubagentIndex(new Map())).toEqual([]);
});

test("boardFrameStateJson carries epics AND the stable-ordered subagent index", () => {
  const epics = [makeEpic({ epic_id: "fn-2-bar", epic_number: 2 })];
  const index = new Map<string, SubagentInvocation[]>();
  index.set("session-2", [
    makeSub({ job_id: "session-2", turn_seq: 0, status: "ok" }),
  ]);
  index.set("session-1", [
    makeSub({ job_id: "session-1", turn_seq: 0, status: "running" }),
  ]);

  const state = boardFrameStateJson(epics, index);
  // The epics ride through by reference (no copy) alongside the subagents.
  expect(state.epics).toBe(epics);
  expect(state.subagents.map((e) => e.job_id)).toEqual([
    "session-1",
    "session-2",
  ]);
  // The state JSON round-trips through the sidecar serializer with its stable
  // ordering intact (JSON has no Map — the array shape is what survives).
  const round = JSON.parse(JSON.stringify(state)) as typeof state;
  expect(round.subagents.map((e) => e.job_id)).toEqual([
    "session-1",
    "session-2",
  ]);
});

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
  // Four rows `running:0 → ok:1 → ok:2 → ok:3` collapse to ok:3. fn-1008: the
  // "stuck" definition is now the canonical open-turn predicate (`isOpenTurnRow`:
  // NULL `duration_ms` AND status running|ok). makeSub defaults `duration_ms` to
  // NULL, so EVERY demoted row here is an OPEN turn — including the `ok` ones —
  // and each counts as stuck. Trace: first row {row:0, count:1, stuck:0}. turn 1
  // (ok) supersedes; demoted turn_seq=0 is open → stuck+1 → {row:1, count:2,
  // stuck:1}. turn 2 (ok) supersedes; demoted turn_seq=1 open → {row:2, count:3,
  // stuck:2}. turn 3 (ok) supersedes; demoted turn_seq=2 open → {row:3, count:4,
  // stuck:3}.
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
  expect(out[0]?.stuck).toBe(3);
});

test("collapseSubagentsByName: fn-593.3 shape — running orphan masked, stuck=3", () => {
  // Exact shape from the wedged fn-593.3 session — ok:0, running:1 (orphan),
  // ok:2, ok:3. The surviving row is ok:3; the three demoted rows are all
  // non-surviving stuck orphans (fn-1008: every demoted row here is an OPEN
  // turn — makeSub defaults `duration_ms` NULL — so all three count as stuck,
  // not just the bare `running:1`). They get counted but don't reach
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
  expect(group?.stuck).toBe(3);
});

test("collapseSubagentsByName: surviving row running → not stuck (currently running)", () => {
  // Two rows, `ok:0 → running:1`. The surviving row (turn 1) IS running, the
  // normal "currently running" case — never counted as stuck. fn-1008: the
  // DEMOTED turn_seq=0 (`ok`, NULL `duration_ms`) is now itself an OPEN turn, so
  // it counts as one stuck orphan (was 0 under the old bare-`running` rule).
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
  expect(g?.stuck).toBe(1);
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
  // row is still the max turn_seq. fn-1008: both demoted rows (turn_seq 5 `ok`
  // and 3 `running`, each NULL `duration_ms`) are OPEN turns, so stuck=2.
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
  expect(g?.stuck).toBe(2);
});

test("collapseSubagentsByName: fn-697.2 safe-8 narrowed wire shape collapses losslessly", () => {
  // fn-697.2 narrowed SUBAGENT_INVOCATIONS_DESCRIPTOR.columns; fn-1008 re-added
  // `duration_ms` (load-bearing: it is half the canonical open-turn predicate),
  // so the served set is now the safe-8 {job_id, subagent_type, turn_seq, ts,
  // status, duration_ms, description, last_event_id}. The wire decode still does
  // NOT surface agent_id / tool_use_id / prompt_chars / updated_at — those cells
  // arrive `undefined`. This asserts the renderer's collapse (the heaviest
  // consumer: ×N count + stuck-orphan detection + the surviving row's
  // type/desc/status used by `subagentLinesFor`) is byte-identical when fed ONLY
  // the safe-8, proving none of the 4 still-dropped columns is load-bearing.
  // Row shapes mirror a real trace: turn_seq=0 is a FINISHED `ok` (non-null
  // `duration_ms`), turn_seq=1 is the OPEN running orphan (NULL), turn_seq=2 is
  // the surviving close. Only the open orphan counts as stuck.
  const safe8 = (
    over: Pick<
      SubagentInvocation,
      | "job_id"
      | "subagent_type"
      | "turn_seq"
      | "ts"
      | "status"
      | "duration_ms"
      | "description"
      | "last_event_id"
    >,
  ): SubagentInvocation =>
    ({
      // Exactly the columns the narrowed descriptor projects; the dropped
      // four are absent (would be `undefined` off the wire), matching the
      // real narrowed frame rather than the full SQL row.
      ...over,
    }) as unknown as SubagentInvocation;
  const rows: SubagentInvocation[] = [
    safe8({
      job_id: "j",
      subagent_type: "plan:worker-high",
      turn_seq: 0,
      ts: 10,
      status: "ok",
      duration_ms: 5_000,
      description: "first",
      last_event_id: 100,
    }),
    safe8({
      job_id: "j",
      subagent_type: "plan:worker-high",
      turn_seq: 1,
      ts: 11,
      status: "running",
      duration_ms: null,
      description: "orphan",
      last_event_id: 101,
    }),
    safe8({
      job_id: "j",
      subagent_type: "plan:worker-high",
      turn_seq: 2,
      ts: 12,
      status: "ok",
      duration_ms: 6_000,
      description: "surviving",
      last_event_id: 102,
    }),
  ];
  const out = collapseSubagentsByName(rows);
  expect(out).toHaveLength(1);
  // ×N count, stuck-orphan, surviving row's render fields all derive from the
  // safe-8 alone — no dropped column touched.
  expect(out[0]?.count).toBe(3);
  expect(out[0]?.stuck).toBe(1);
  expect(out[0]?.row.turn_seq).toBe(2);
  expect(out[0]?.row.status).toBe("ok");
  expect(out[0]?.row.subagent_type).toBe("plan:worker-high");
  expect(out[0]?.row.description).toBe("surviving");
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
  // verdict for the row's owning task isn't `running:sub-agent-running`.
  // This is the autopilot-unsticking effect of the client-side collapse.
  // fn-1008: the surviving turn_seq=3 is a FINISHED `ok` (non-null
  // `duration_ms`) — an OPEN `ok` survivor would itself be in-flight under the
  // canonical open-turn predicate and keep predicate 6 firing.
  const task = makeTask({
    worker_phase: "open",
    jobs: [makeEmbeddedJob({ job_id: "worker-1", state: "stopped" })],
  });
  const epic = makeEpic({ tasks: [task] });
  const subRows = [
    makeSub({
      job_id: "worker-1",
      subagent_type: "plan:worker-high",
      turn_seq: 0,
      status: "ok",
      duration_ms: 4_000,
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
      duration_ms: 5_000,
    }),
    makeSub({
      job_id: "worker-1",
      subagent_type: "plan:worker-high",
      turn_seq: 3,
      status: "ok",
      duration_ms: 6_000,
    }),
  ];
  const collapsed = collapseSubagentsByName(subRows).map((g) => g.row);
  const snap = computeReadiness([epic], new Map<string, Job>(), collapsed);
  const verdict = snap.perTask.get(task.task_id);
  // Whatever the verdict, it MUST NOT be sub-agent-running — the orphan
  // turn_seq=1 has been masked by the same-name collapse. Post-split,
  // sub-agent-running lives under the `running` tag, not `blocked`.
  if (verdict?.tag === "running") {
    expect(verdict.reason.kind).not.toBe("sub-agent-running");
  }
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
    tag: "running",
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
    last_permission_prompt_at: null,
    last_permission_prompt_kind: null,
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
  expect(out).toEqual([`  Plan epic 7 ${pill("creator")} ${pill("working")}`]);
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
  // fn-713 follow-on (show-default): state='stopped' now renders its pill.
  expect(out).toEqual([
    `  sess-no-title ${pill("refiner")} ${pill("stopped")}`,
  ]);
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
  // fn-713 follow-on: state='stopped' renders; [failed:<kind>] stamps inline.
  expect(out).toEqual([
    `  Plan epic 8 ${pill("creator")} ${pill("stopped")} ${pill("failed:rate_limit")}`,
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
    expect(out).toEqual([
      `  Plan epic 9 ${pill("refiner")} ${pill("stopped")} ${pill(`failed:${kind}`)}`,
    ]);
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
  expect(out).toEqual([
    `  Plan epic 10 ${pill("creator")} ${pill("stopped")} ${pill("failed:unknown")}`,
  ]);
});

// `last_input_request_at` non-null emits the `[awaiting:<kind>]` pill
// (warn/yellow via the colorizer's `awaiting:*` prefix fallback) on its
// OWN continuation line beneath the row (four-space indent), so a long
// interactive stop reads without wrapping; `[state]`/`[failed:<kind>]`
// stay inline above it. Schema v25 introduced
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
    `  Plan epic 11 ${pill("creator")} ${pill("stopped")}`,
    `    ${pill("awaiting:ask_user_question")}`,
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
    `  Plan epic 12 ${pill("refiner")} ${pill("stopped")}`,
    `    ${pill("awaiting:unknown")}`,
  ]);
});

// Stacking snapshot — a row carrying BOTH api-error AND input-request
// annotations renders `[failed:<kind>]` inline (state='stopped' elides per
// fn-708 T1), then drops `[awaiting:<kind>]` onto its own indented
// continuation line beneath the row. Pins the inline-vs-continuation split.
test("renderJobLinkLines: failed stays inline, awaiting drops to its own line", () => {
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
    `  Plan epic 13 ${pill("creator")} ${pill("stopped")} ${pill("failed:rate_limit")}`,
    `    ${pill("awaiting:ask_user_question")}`,
  ]);
});

// Schema v52 / fn-686 — `[awaiting:permission]` and
// `[awaiting:elicitation]` clone the v25 input-request pill onto a
// distinct projection pair fed by the `Notification` hook fold. Same
// "drop on continuation line" discipline; the two pills can co-occur if
// a future fold-shape change ever lands both axes on one row, but
// independently — each fires off its own paired-NULL field.
test("renderJobLinkLines: last_permission_prompt_at non-null with kind='permission' appends [awaiting:permission] pill", () => {
  const out = renderJobLinkLines([
    makeLink({
      kind: "creator",
      job_id: "sess-pp",
      title: "Plan epic 21",
      state: "working",
      last_permission_prompt_at: 1700000000,
      last_permission_prompt_kind: "permission",
    }),
  ]);
  expect(out).toEqual([
    `  Plan epic 21 ${pill("creator")} ${pill("working")}`,
    `    ${pill("awaiting:permission")}`,
  ]);
});

test("renderJobLinkLines: last_permission_prompt_at non-null with kind='elicitation' appends [awaiting:elicitation] pill", () => {
  const out = renderJobLinkLines([
    makeLink({
      kind: "creator",
      job_id: "sess-el",
      title: "Plan epic 22",
      state: "working",
      last_permission_prompt_at: 1700000000,
      last_permission_prompt_kind: "elicitation",
    }),
  ]);
  expect(out).toEqual([
    `  Plan epic 22 ${pill("creator")} ${pill("working")}`,
    `    ${pill("awaiting:elicitation")}`,
  ]);
});

test("renderJobLinkLines: permission_prompt_at non-null, kind null defensively renders [awaiting:unknown]", () => {
  // Same defensive fallback as the v25 input-request pill — should be
  // unreachable per the paired-NULL invariant, but the pill must not
  // collapse to `[awaiting:]` if a future shape-skew bug appears.
  const out = renderJobLinkLines([
    makeLink({
      kind: "refiner",
      job_id: "sess-pp-defensive",
      title: "Plan epic 23",
      state: "working",
      last_permission_prompt_at: 1700000000,
      last_permission_prompt_kind: null,
    }),
  ]);
  expect(out).toEqual([
    `  Plan epic 23 ${pill("refiner")} ${pill("working")}`,
    `    ${pill("awaiting:unknown")}`,
  ]);
});

test("renderJobLinkLines: api-error + input-request + permission all stack on independent lines", () => {
  // Stacking snapshot — a row carrying ALL THREE annotations renders
  // `[state] [failed:<kind>]` inline, then drops both awaiting pills
  // onto their OWN indented continuation lines beneath the row in
  // (input-request, permission) order matching the source rendering
  // order in `renderJobLinkLines`.
  const out = renderJobLinkLines([
    makeLink({
      kind: "creator",
      job_id: "sess-triple",
      title: "Plan epic 24",
      state: "working",
      last_api_error_at: 1700000000,
      last_api_error_kind: "rate_limit",
      last_input_request_at: 1700000001,
      last_input_request_kind: "ask_user_question",
      last_permission_prompt_at: 1700000002,
      last_permission_prompt_kind: "permission",
    }),
  ]);
  expect(out).toEqual([
    `  Plan epic 24 ${pill("creator")} ${pill("working")} ${pill("failed:rate_limit")}`,
    `    ${pill("awaiting:ask_user_question")}`,
    `    ${pill("awaiting:permission")}`,
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
    `  First ${pill("creator")} ${pill("working")}`,
    // fn-713 follow-on: the resting state='stopped' entry now renders its pill.
    `  Second ${pill("refiner")} ${pill("stopped")}`,
  ]);
});

// Epic fn-695 (T4): the durable commit-trailer union (`syncPlanLinks`) can
// land MANY creator + refiner edges on one epic's `job_links` — one entry per
// session whose plan footprint (scrape OR commit trailer) created/refined
// the epic inside a `/plan:plan` window. `renderJobLinkLines` must emit one
// line per entry, unchanged: no field change, no per-source branch. Pins that
// N creator + M refiner edges render N+M lines in projection order.
test("renderJobLinkLines: many creator + refiner edges per epic each render their own line (commit-trailer union, no field change)", () => {
  const out = renderJobLinkLines([
    makeLink({
      kind: "creator",
      job_id: "sess-c1",
      title: "Creator one",
      state: "stopped",
    }),
    makeLink({
      kind: "creator",
      job_id: "sess-c2",
      title: "Creator two",
      state: "working",
    }),
    makeLink({
      kind: "refiner",
      job_id: "sess-r1",
      title: "Refiner one",
      state: "stopped",
    }),
    makeLink({
      kind: "refiner",
      job_id: "sess-r2",
      title: "Refiner two",
      state: "working",
    }),
    makeLink({
      kind: "refiner",
      job_id: "sess-r3",
      title: "Refiner three",
      state: "stopped",
    }),
  ]);
  expect(out).toEqual([
    // fn-713 follow-on: every entry now renders its [state] pill, the resting
    // state='stopped' included.
    `  Creator one ${pill("creator")} ${pill("stopped")}`,
    `  Creator two ${pill("creator")} ${pill("working")}`,
    `  Refiner one ${pill("refiner")} ${pill("stopped")}`,
    `  Refiner two ${pill("refiner")} ${pill("working")}`,
    `  Refiner three ${pill("refiner")} ${pill("stopped")}`,
  ]);
});

// ---------------------------------------------------------------------------
// renderHandoffLinkLines — the job→job handoff edge, sibling of the job-link
// renderer but NOT epic-anchored (renders off the job's own handoff_links).
// ---------------------------------------------------------------------------

/**
 * Build a `HandoffLinkEntry` with the same missing-row defaults `enrichHandoff`
 * uses (`title: null, state: "stopped", all pair fields null`). Callers
 * override per-test.
 */
function makeHandoffLink(
  overrides: Partial<HandoffLinkEntry>,
): HandoffLinkEntry {
  return {
    kind: "handoff-from",
    handoff_id: "h-1",
    peer_job_id: "peer-1",
    status: "dispatched",
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

test("renderHandoffLinkLines: empty / non-array input → []", () => {
  expect(renderHandoffLinkLines([])).toEqual([]);
  expect(renderHandoffLinkLines(undefined)).toEqual([]);
  expect(renderHandoffLinkLines(null)).toEqual([]);
  expect(renderHandoffLinkLines("not an array")).toEqual([]);
});

test("renderHandoffLinkLines: handoff-from entry → peer label + [handoff-from] + state pill", () => {
  const out = renderHandoffLinkLines([
    makeHandoffLink({
      kind: "handoff-from",
      peer_job_id: "callee-7",
      title: "explore X",
      state: "working",
    }),
  ]);
  expect(out).toEqual([
    `  explore X ${pill("handoff-from")} ${pill("working")}`,
  ]);
});

test("renderHandoffLinkLines: handoff-to entry → peer label + [handoff-to] + state pill", () => {
  const out = renderHandoffLinkLines([
    makeHandoffLink({
      kind: "handoff-to",
      peer_job_id: "initiator-3",
      title: "the initiator",
      state: "stopped",
    }),
  ]);
  expect(out).toEqual([
    `  the initiator ${pill("handoff-to")} ${pill("stopped")}`,
  ]);
});

test("renderHandoffLinkLines: null title falls back to peer_job_id (the from-side-unknown / null-initiator case)", () => {
  // A `handoff-to` whose initiator job is unfolded/orphan enriches to
  // `{title: null, state: "stopped"}` — the renderer subs in `peer_job_id`
  // so the line stays readable and the `[handoff-to]` pill still carries its
  // themed glyph (no icon-less / `[null]` render).
  const out = renderHandoffLinkLines([
    makeHandoffLink({
      kind: "handoff-to",
      peer_job_id: "unknown-initiator",
      title: null,
      state: "stopped",
    }),
  ]);
  expect(out).toEqual([
    `  unknown-initiator ${pill("handoff-to")} ${pill("stopped")}`,
  ]);
});

test("renderHandoffLinkLines: api-error stamps inline, awaiting drops to its own continuation line", () => {
  const out = renderHandoffLinkLines([
    makeHandoffLink({
      kind: "handoff-from",
      peer_job_id: "callee-9",
      title: "do the thing",
      state: "stopped",
      last_api_error_at: 1700000000,
      last_api_error_kind: "rate_limit",
      last_input_request_at: 1700000001,
      last_input_request_kind: "ask_user_question",
    }),
  ]);
  expect(out).toEqual([
    `  do the thing ${pill("handoff-from")} ${pill("stopped")} ${pill("failed:rate_limit")}`,
    `    ${pill("awaiting:ask_user_question")}`,
  ]);
});

test("renderHandoffLinkLines: multiple entries iterate in provided (stored) order — render must not re-sort", () => {
  const out = renderHandoffLinkLines([
    makeHandoffLink({
      kind: "handoff-to",
      peer_job_id: "init",
      title: "From initiator",
      state: "stopped",
    }),
    makeHandoffLink({
      kind: "handoff-from",
      peer_job_id: "callee",
      title: "To callee",
      state: "working",
    }),
  ]);
  expect(out).toEqual([
    `  From initiator ${pill("handoff-to")} ${pill("stopped")}`,
    `  To callee ${pill("handoff-from")} ${pill("working")}`,
  ]);
});

// ---------------------------------------------------------------------------
// colorizePillsInLine — pure string→string SGR coloring of bracketed pills
// ---------------------------------------------------------------------------

// SGR bytes mirror the table in scripts/board.ts. Re-declared here (not
// imported) so a regression that flips a bucket's color is caught — the
// test fails until the change is intentional in both places.
const ACTIVE = "\x1b[96m";
const BLUE = "\x1b[94m";
const SUCCESS = "\x1b[32m";
const ERROR = "\x1b[31m";
const WARN = "\x1b[33m";
const FADED = "\x1b[2;37m";
const RESET = "\x1b[0m";

// The colorizer wraps the WHOLE inner of an iconized pill (glyph + `::` +
// token) in the bucket SGR, keying the bucket off the TEXT half. This mirrors
// that: build the iconized pill via `pill(token)`, strip its brackets, and
// re-wrap the inner in `sgr`…`RESET`. Use for asserting the rendered board
// pill (iconized) under color, vs. the plain-pill inputs the legacy colorizer
// contract tests still feed.
function coloredPill(sgr: string, token: string): string {
  const inner = pill(token).slice(1, -1);
  return `[${sgr}${inner}${RESET}]`;
}

test("colorizePillsInLine: unknown tokens pass through verbatim", () => {
  expect(colorizePillsInLine("(dir) 12 Foo [planner] [pending]")).toBe(
    "(dir) 12 Foo [planner] [pending]",
  );
});

test("colorizePillsInLine: each bucket colors its representative tokens", () => {
  expect(colorizePillsInLine("[running]")).toBe(`[${BLUE}running${RESET}]`);
  expect(colorizePillsInLine("[in_progress]")).toBe(
    `[${ACTIVE}in_progress${RESET}]`,
  );
  expect(colorizePillsInLine("[working]")).toBe(`[${BLUE}working${RESET}]`);
  expect(colorizePillsInLine("[ok]")).toBe(`[${SUCCESS}ok${RESET}]`);
  expect(colorizePillsInLine("[approved]")).toBe(
    `[${SUCCESS}approved${RESET}]`,
  );
  expect(colorizePillsInLine("[validated]")).toBe(
    `[${SUCCESS}validated${RESET}]`,
  );
  expect(colorizePillsInLine("[ready]")).toBe(`[${SUCCESS}ready${RESET}]`);
  expect(colorizePillsInLine("[done]")).toBe(`[${SUCCESS}done${RESET}]`);
  // fn-708: the two new disambiguating tokens.
  expect(colorizePillsInLine("[worker-done]")).toBe(
    `[${SUCCESS}worker-done${RESET}]`,
  );
  expect(colorizePillsInLine("[rt:blocked]")).toBe(
    `[${WARN}rt:blocked${RESET}]`,
  );
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

// fn-700.2: `epic-no-tasks` is the close-row reason for a zero-task epic
// (the partial-projection window between the EpicSnapshot and TaskSnapshot
// folds). `formatPill` produces `[blocked:epic-no-tasks]` and
// `colorizePillsInLine` auto-warns it via the generic `blocked:*` → warn
// prefix branch — no render-code change beyond the union member added in
// task .1.
test("formatPill: epic-no-tasks blocked verdict renders [blocked:epic-no-tasks]", () => {
  expect(
    formatPill({ tag: "blocked", reason: { kind: "epic-no-tasks" } }),
  ).toBe("[blocked:epic-no-tasks]");
});

test("colorizePillsInLine: blocked:epic-no-tasks takes the warn bucket", () => {
  expect(colorizePillsInLine("[blocked:epic-no-tasks]")).toBe(
    `[${WARN}blocked:epic-no-tasks${RESET}]`,
  );
});

// fn-941: an escalated runtime-blocked task renders `[blocked:escalated]` —
// distinct from the plain `[blocked:runtime-blocked]` pill — so a human sees
// "escalation pending / planner notified". The flag is read coarsely (a
// `block_escalations` latch row's presence for the task id), and the `blocked:`
// prefix keeps it in the amber warn family.
test("taskVerdictPill: runtime-blocked + escalated → [blocked:escalated] (distinct from plain blocked)", () => {
  const verdict: Verdict = {
    tag: "blocked",
    reason: { kind: "runtime-blocked" },
  };
  const escalated = taskVerdictPill(
    verdict,
    "fn-1-foo.1",
    new Set(["fn-1-foo.1"]),
  );
  const plain = taskVerdictPill(verdict, "fn-1-foo.1", new Set<string>());
  // The escalated pill carries the `blocked:escalated` token; the plain one
  // carries `blocked:runtime-blocked`. Both iconize, so assert on the contained
  // token text and that they differ.
  expect(escalated).toContain("blocked:escalated");
  expect(plain).toContain("blocked:runtime-blocked");
  expect(escalated).not.toBe(plain);
});

test("taskVerdictPill: non-runtime-blocked verdict ignores escalation set (standard formatPill)", () => {
  const ready: Verdict = { tag: "ready" };
  // Even if the id is in the escalated set, only a runtime-blocked verdict
  // gets the escalated pill — a ready row renders the standard pill.
  expect(taskVerdictPill(ready, "fn-1-foo.1", new Set(["fn-1-foo.1"]))).toBe(
    iconizePills(formatPill(ready)),
  );
});

test("taskVerdictPill: runtime-blocked but NOT escalated → standard [blocked:runtime-blocked]", () => {
  const verdict: Verdict = {
    tag: "blocked",
    reason: { kind: "runtime-blocked" },
  };
  expect(taskVerdictPill(verdict, "fn-1-foo.1", new Set<string>())).toBe(
    iconizePills(formatPill(verdict)),
  );
});

test("colorizePillsInLine: blocked:escalated takes the warn bucket via prefix fallback", () => {
  expect(colorizePillsInLine("[blocked:escalated]")).toBe(
    `[${WARN}blocked:escalated${RESET}]`,
  );
});

// fn-700.2: the epic-header label falls back to `epic_id` when both
// `epic_number` and `title` are null (a pre-EpicSnapshot stub row) so the
// header is never the blank `({dir})  [unvalidated]` line. Pure helper —
// asserted directly, mirroring the renderJobLinkLines / subagentLinesFor
// extraction precedent.
test("epicHeaderLabel: both number and title present → '{number} {title}'", () => {
  expect(epicHeaderLabel(12, "Add OAuth", "fn-12-add-oauth")).toBe(
    "12 Add OAuth",
  );
});

test("epicHeaderLabel: title null, number present → bare number", () => {
  expect(epicHeaderLabel(12, null, "fn-12-add-oauth")).toBe("12");
});

test("epicHeaderLabel: number null, title present → bare title", () => {
  expect(epicHeaderLabel(null, "Add OAuth", "fn-12-add-oauth")).toBe(
    "Add OAuth",
  );
});

test("epicHeaderLabel: both null → epic_id fallback (no blank header)", () => {
  const label = epicHeaderLabel(null, null, "fn-12-add-oauth");
  expect(label).toBe("fn-12-add-oauth");
  // The fallback must be non-blank so the assembled header never collapses
  // to '({dir})  [unvalidated]'.
  expect(label.trim().length).toBeGreaterThan(0);
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

// Schema v52 / fn-686 — the two new awaiting pills inherit the SAME
// warn-bucket coloring via the open-ended `awaiting:*` prefix fallback.
// NO colorizer change was needed; pin both pills explicitly so a future
// regression that special-cases one kind without the other is caught.
test("colorizePillsInLine: awaiting:permission takes the warn bucket via the awaiting:* prefix fallback", () => {
  expect(colorizePillsInLine("[awaiting:permission]")).toBe(
    `[${WARN}awaiting:permission${RESET}]`,
  );
});

test("colorizePillsInLine: awaiting:elicitation takes the warn bucket via the awaiting:* prefix fallback", () => {
  expect(colorizePillsInLine("[awaiting:elicitation]")).toBe(
    `[${WARN}awaiting:elicitation${RESET}]`,
  );
});

// Stacking snapshot through the colorizer — a worker row layering
// `[working]` (blue) + `[failed:rate_limit]` (red) + both awaiting pills
// (yellow) — pins independent coloring across all five tokens.
test("colorizePillsInLine: working + failed + input-request + permission stack colors independently", () => {
  expect(
    colorizePillsInLine(
      "Plan epic 25 [creator] [working] [failed:rate_limit] [awaiting:ask_user_question] [awaiting:permission]",
    ),
  ).toBe(
    `Plan epic 25 [creator] [${BLUE}working${RESET}] [${ERROR}failed:rate_limit${RESET}] [${WARN}awaiting:ask_user_question${RESET}] [${WARN}awaiting:permission${RESET}]`,
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

// fn-638.4: the `running:*` prefix fallback colors the "fresh in-flight"
// RunningReason kinds (`job-running`, `sub-agent-running`) as `blue` (bright
// blue) — same bucket as the bare `[running]` exact match — while the
// more-specific `running:sub-agent-stale` branch above the fallback routes the
// possibly-stuck orphan variant to `warn` (yellow). Asserts the
// distinct color so a regression that drops the more-specific branch
// would surface here instead of silently re-collapsing stale into
// blue.
test("colorizePillsInLine: running:<kind> fresh variants take the blue bucket via prefix fallback", () => {
  expect(colorizePillsInLine("[running:job-running]")).toBe(
    `[${BLUE}running:job-running${RESET}]`,
  );
  expect(colorizePillsInLine("[running:sub-agent-running]")).toBe(
    `[${BLUE}running:sub-agent-running${RESET}]`,
  );
});

test("colorizePillsInLine: running:sub-agent-stale takes the warn bucket (more-specific branch)", () => {
  expect(colorizePillsInLine("[running:sub-agent-stale]")).toBe(
    `[${WARN}running:sub-agent-stale${RESET}]`,
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

// ---------------------------------------------------------------------------
// fn-635: epicNumFromIdOrBare — handles BOTH full `name-N-slug` form and the
// bare `fn-N` form plan emits for cross-project epic deps.
// ---------------------------------------------------------------------------

test("epicNumFromIdOrBare: full-id form (`name-N-slug`) returns N", () => {
  expect(epicNumFromIdOrBare("fn-100-foo")).toBe(100);
  expect(epicNumFromIdOrBare("arthack-633-git-attribution")).toBe(633);
});

test("epicNumFromIdOrBare: bare `fn-N` form returns N (no trailing slug)", () => {
  expect(epicNumFromIdOrBare("fn-100")).toBe(100);
  expect(epicNumFromIdOrBare("fn-7")).toBe(7);
});

test("epicNumFromIdOrBare: malformed ids return null", () => {
  expect(epicNumFromIdOrBare("notvalid")).toBeNull();
  expect(epicNumFromIdOrBare("fn-")).toBeNull();
  expect(epicNumFromIdOrBare("fn-abc")).toBeNull();
  expect(epicNumFromIdOrBare("123-foo")).toBeNull();
});

// ---------------------------------------------------------------------------
// fn-635: colorizePillsInLine — `blocked:dep-on-epic-dangling <id>` lands in
// the error bucket (red), distinct from the amber `blocked:*` family. The
// prefix-branch ordering check is load-bearing: without `dep-on-epic-dangling`
// coming BEFORE the generic `blocked:` fallback in `colorizePillsInLine`, the
// dangling pill would render amber and the structural-problem signal would
// be lost.
// ---------------------------------------------------------------------------

test("colorizePillsInLine: blocked:dep-on-epic-dangling lands in error (red) bucket via per-payload branch", () => {
  expect(
    colorizePillsInLine("[blocked:dep-on-epic-dangling fn-99-ghost]"),
  ).toBe(`[${ERROR}blocked:dep-on-epic-dangling fn-99-ghost${RESET}]`);
});

test("colorizePillsInLine: bare [dep-on-epic-dangling] (exact-match) lands in error bucket too", () => {
  // The exact-match entry in PILL_COLORS handles a future direct-pill
  // render path; the prefix branch above handles the wrapped
  // `blocked:dep-on-epic-dangling <id>` payload.
  expect(colorizePillsInLine("[dep-on-epic-dangling]")).toBe(
    `[${ERROR}dep-on-epic-dangling${RESET}]`,
  );
});

test("colorizePillsInLine: ordering — dep-on-epic-dangling wins over the generic blocked:* fallback", () => {
  // Negative control. If a future drive-by reorder moves the
  // `blocked:dep-on-epic-dangling` branch BELOW the generic `blocked:`
  // branch in `colorizePillsInLine`, the dangling payload would fall
  // through to the warn bucket. This test fails until the ordering is
  // restored.
  const out = colorizePillsInLine("[blocked:dep-on-epic-dangling fn-100]");
  expect(out).toContain(ERROR);
  expect(out).not.toContain(WARN);
});

test("colorizePillsInLine: regular blocked:dep-on-epic (amber/warn) stays warn", () => {
  // Mirror control for the non-dangling dep-on-epic payload — it must
  // continue to color amber via the generic `blocked:*` fallback.
  expect(colorizePillsInLine("[blocked:dep-on-epic fn-100-foo]")).toBe(
    `[${WARN}blocked:dep-on-epic fn-100-foo${RESET}]`,
  );
  // The cross-project payload itself contains `::` (arthack::fn-100). On the
  // board this renders iconized as `pill("blocked:dep-on-epic arthack::fn-100")`;
  // the colorizer splits on the FIRST `::` (the icon delimiter), so the text
  // half is the whole `blocked:…` token and still routes to warn.
  expect(colorizePillsInLine(pill("blocked:dep-on-epic arthack::fn-100"))).toBe(
    coloredPill(WARN, "blocked:dep-on-epic arthack::fn-100"),
  );
});

// ---------------------------------------------------------------------------
// fn-635: formatPill renders cross-project + dangling variants
// ---------------------------------------------------------------------------

test("formatPill: dep-on-epic intra-project renders bare id (no provenance prefix)", () => {
  expect(
    formatPill({
      tag: "blocked",
      reason: {
        kind: "dep-on-epic",
        upstream: "fn-100-foo",
        cross_project: null,
      },
    }),
  ).toBe("[blocked:dep-on-epic fn-100-foo]");
});

test("formatPill: dep-on-epic cross-project renders <project>::<id> prefix", () => {
  expect(
    formatPill({
      tag: "blocked",
      reason: {
        kind: "dep-on-epic",
        upstream: "fn-100-foo",
        cross_project: "arthack",
      },
    }),
  ).toBe("[blocked:dep-on-epic arthack::fn-100-foo]");
});

test("formatPill: dep-on-epic-dangling renders the upstream id verbatim", () => {
  expect(
    formatPill({
      tag: "blocked",
      reason: { kind: "dep-on-epic-dangling", upstream: "fn-99-ghost" },
    }),
  ).toBe("[blocked:dep-on-epic-dangling fn-99-ghost]");
  expect(
    formatPill({
      tag: "blocked",
      reason: { kind: "dep-on-epic-dangling", upstream: "fn-7" },
    }),
  ).toBe("[blocked:dep-on-epic-dangling fn-7]");
});

// ---------------------------------------------------------------------------
// fn-636: renderEpicDepPills — the three render shapes produced by the
// board's `[#N,#M]` summary pill assembly. `renderEpicDepPills` is the
// extracted helper lifted out of `renderEpicBlock` so the dangling /
// intra-project / cross-project branches are directly assertable without
// driving a full subscribe-server frame.
// ---------------------------------------------------------------------------

test("renderEpicDepPills: dangling resolution with parseable number → `?#N`", () => {
  const dangling: EpicDepResolution = { kind: "dangling" };
  const out = renderEpicDepPills(["fn-99-ghost"], () => dangling);
  expect(out).toEqual(["?#99"]);
});

test("renderEpicDepPills: intra-project resolution (cross_project === null) → `#N`", () => {
  const upstream = makeEpic({
    epic_id: "fn-100-foo",
    epic_number: 100,
    project_dir: "/repo",
  });
  const found: EpicDepResolution = {
    kind: "found",
    epic: upstream,
    cross_project: null,
    completed: false,
  };
  const out = renderEpicDepPills(["fn-100-foo"], () => found);
  expect(out).toEqual(["#100"]);
});

test("renderEpicDepPills: cross-project resolution (non-null cross_project basename) → `<prefix>::#N`", () => {
  const upstream = makeEpic({
    epic_id: "fn-633-git-attribution",
    epic_number: 633,
    project_dir: "/Users/mike/code/arthack",
  });
  const found: EpicDepResolution = {
    kind: "found",
    epic: upstream,
    cross_project: "arthack",
    completed: false,
  };
  const out = renderEpicDepPills(["fn-633"], () => found);
  expect(out).toEqual(["arthack::#633"]);
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

// ---------------------------------------------------------------------------
// renderDeadLetterPill — board's persistent warn banner for waiting
// dead-letter rows (fn-643.5). Native count surfaces verbatim; the pill
// drops cleanly at zero so the banner reads empty in the happy steady
// state. Defensive against malformed inputs (NaN / negative).
// ---------------------------------------------------------------------------

test("renderDeadLetterPill: positive N renders `[dead-letter:N]` verbatim (native count)", () => {
  expect(renderDeadLetterPill(1)).toBe(pill("dead-letter:1"));
  expect(renderDeadLetterPill(3)).toBe(pill("dead-letter:3"));
  expect(renderDeadLetterPill(42)).toBe(pill("dead-letter:42"));
});

test("renderDeadLetterPill: zero / negative / NaN collapse to empty (banner drops the pill cleanly)", () => {
  expect(renderDeadLetterPill(0)).toBe("");
  expect(renderDeadLetterPill(-1)).toBe("");
  expect(renderDeadLetterPill(Number.NaN)).toBe("");
  // `Infinity` is not finite — also collapses (defensive).
  expect(renderDeadLetterPill(Number.POSITIVE_INFINITY)).toBe("");
});

test("colorizePillsInLine: dead-letter:<N> takes the warn bucket via prefix fallback", () => {
  // fn-643.5: the `[dead-letter:N]` banner pill colors yellow alongside
  // the other warn-bucket prefixes (`blocked:*` / `awaiting:*` /
  // `task-repo:*`). The count payload is opaque to the colorizer.
  expect(colorizePillsInLine("[dead-letter:1]")).toBe(
    `[${WARN}dead-letter:1${RESET}]`,
  );
  expect(colorizePillsInLine("[dead-letter:42]")).toBe(
    `[${WARN}dead-letter:42${RESET}]`,
  );
});

// ---------------------------------------------------------------------------
// fn-708: token-collision matrix — the two relabeled tokens must NOT decode
// to the same color path as the fields they were split away from when both
// co-render on one row.
// ---------------------------------------------------------------------------

test("colorizePillsInLine: fn-708 [worker-done] and runtime [done] color independently on one row", () => {
  // worker_phase survivor + runtime_status=done co-render. Both green, but
  // they are DISTINCT tokens (positional ambiguity is impossible — the
  // label `worker-done` carries the field name).
  expect(colorizePillsInLine("[done] [worker-done]")).toBe(
    `[${SUCCESS}done${RESET}] [${SUCCESS}worker-done${RESET}]`,
  );
});

test("colorizePillsInLine: fn-708 [rt:blocked] does NOT collide with verdict [blocked:*]", () => {
  // The manual runtime block flag and a computed readiness block co-render.
  // `rt:blocked` resolves via exact-match (warn); `blocked:single-task-per-root`
  // resolves via the `blocked:` prefix (also warn) — same color, distinct
  // tokens, no positional ambiguity.
  expect(
    colorizePillsInLine("[rt:blocked] [blocked:single-task-per-root]"),
  ).toBe(
    `[${WARN}rt:blocked${RESET}] [${WARN}blocked:single-task-per-root${RESET}]`,
  );
});

// ---------------------------------------------------------------------------
// fn-708: pillOrEmpty — the omit-default primitive (T1)
// ---------------------------------------------------------------------------

// fn-713 follow-on inverts fn-708 omit-default: the resting/default value now
// renders an explicit pill instead of "".
test("pillOrEmpty: value == default → resting pill now shows", () => {
  expect(pillOrEmpty("todo", "todo")).toBe(` ${pill("todo")}`);
  expect(pillOrEmpty("pending", "pending")).toBe(` ${pill("pending")}`);
  expect(pillOrEmpty("open", "open")).toBe(` ${pill("open")}`);
});

test("pillOrEmpty: value != default → leading-space pill", () => {
  expect(pillOrEmpty("in_progress", "todo")).toBe(` ${pill("in_progress")}`);
  expect(pillOrEmpty("approved", "pending")).toBe(` ${pill("approved")}`);
  expect(pillOrEmpty("done", "open")).toBe(` ${pill("done")}`);
});

test("pillOrEmpty: null / non-string coalesces to the default pill (never [null])", () => {
  expect(pillOrEmpty(null, "todo")).toBe(` ${pill("todo")}`);
  expect(pillOrEmpty(undefined, "todo")).toBe(` ${pill("todo")}`);
  expect(pillOrEmpty(42, "todo")).toBe(` ${pill("todo")}`);
  expect(pillOrEmpty({}, "todo")).toBe(` ${pill("todo")}`);
});

// ---------------------------------------------------------------------------
// fn-708: validatedPill — omit-default behavior (render [validated] only)
// ---------------------------------------------------------------------------

test("validatedPill: non-null last_validated_at → ' [validated]'", () => {
  expect(validatedPill("2026-06-05T00:00:00Z")).toBe(` ${pill("validated")}`);
  expect(validatedPill(1234567890)).toBe(` ${pill("validated")}`);
});

// fn-713 follow-on inverts fn-708 omit-default: the unvalidated state now
// renders an explicit pill instead of "".
test("validatedPill: null / undefined → ' [unvalidated]' (absence now shown)", () => {
  expect(validatedPill(null)).toBe(` ${pill("unvalidated")}`);
  expect(validatedPill(undefined)).toBe(` ${pill("unvalidated")}`);
});

// ---------------------------------------------------------------------------
// fn-751: armedPill — omit-default behavior (render [armed] only when armed)
// ---------------------------------------------------------------------------

test("armedPill: armed epic → ' [armed]'", () => {
  expect(armedPill(true)).toBe(` ${pill("armed")}`);
});

test("armedPill: unarmed epic → '' (omit-default)", () => {
  expect(armedPill(false)).toBe("");
});

// ---------------------------------------------------------------------------
// fn-949: startedPill — omit-default (render [started] only when started),
// mirroring armedPill.
// ---------------------------------------------------------------------------

test("startedPill: started epic → ' [started]'", () => {
  expect(startedPill(true)).toBe(` ${pill("started")}`);
});

test("startedPill: unstarted epic → '' (omit-default)", () => {
  expect(startedPill(false)).toBe("");
});

// ---------------------------------------------------------------------------
// fn-708: renderTaskPills — runtime_status / worker_phase / approval (T1+T3)
// ---------------------------------------------------------------------------

const READY: Verdict = { tag: "ready" };
const COMPLETED: Verdict = { tag: "completed" };
const JOB_RUNNING: Verdict = {
  tag: "running",
  reason: { kind: "job-running" },
};
const SUBAGENT_RUNNING: Verdict = {
  tag: "running",
  reason: { kind: "sub-agent-running" },
};
const SUBAGENT_STALE: Verdict = {
  tag: "running",
  reason: { kind: "sub-agent-stale" },
};
const JOB_PENDING: Verdict = {
  tag: "blocked",
  reason: { kind: "job-pending" },
};
const GIT_UNCOMMITTED: Verdict = {
  tag: "blocked",
  reason: { kind: "git-uncommitted" },
};
const GIT_ORPHANS: Verdict = {
  tag: "blocked",
  reason: { kind: "git-orphans" },
};
const EPIC_NOT_VALIDATED: Verdict = {
  tag: "blocked",
  reason: { kind: "epic-not-validated" },
};

// Board summary counts visible open/running tasks and epics from the same
// readiness verdicts the row renderer consumes.
test("computeBoardSummary: counts open/running tasks and epics, including closing epics", () => {
  const taskRunning = makeTask({ task_id: "fn-1-a.1", epic_id: "fn-1-a" });
  const taskCompleted = makeTask({ task_id: "fn-1-a.2", epic_id: "fn-1-a" });
  const epicFromTask = makeEpic({
    epic_id: "fn-1-a",
    tasks: [taskRunning, taskCompleted],
  });
  const epicCompleted = makeEpic({
    epic_id: "fn-2-b",
    tasks: [makeTask({ task_id: "fn-2-b.1", epic_id: "fn-2-b" })],
  });
  const epicFromClose = makeEpic({
    epic_id: "fn-3-c",
    tasks: [makeTask({ task_id: "fn-3-c.1", epic_id: "fn-3-c" })],
  });

  const counts = computeBoardSummary({
    epics: [epicFromTask, epicCompleted, epicFromClose],
    readiness: {
      perTask: new Map<string, Verdict>([
        [taskRunning.task_id, JOB_RUNNING],
        [taskCompleted.task_id, COMPLETED],
        ["fn-2-b.1", COMPLETED],
        ["fn-3-c.1", COMPLETED],
      ]),
      perCloseRow: new Map<string, Verdict>([
        [epicFromTask.epic_id, EPIC_NOT_VALIDATED],
        [epicCompleted.epic_id, COMPLETED],
        [epicFromClose.epic_id, JOB_RUNNING],
      ]),
    },
  });

  expect(counts).toEqual({
    epicsOpen: 2,
    epicsRunning: 2,
    epicsClosing: 1,
    tasksOpen: 1,
    tasksRunning: 1,
  });
  expect(boardSummaryLines(counts)).toEqual([
    "summary",
    "  tasks: 1 open / 1 running",
    "  epics: 2 open / 2 running / 1 closing",
  ]);
});

// ADR 0018 (fn-1175.2): a pinned epic rides `snap.epics` with a REAL
// `completeReadiness` verdict (plan-closed → its close row reads `completed`),
// so `computeBoardSummary` — which derives every count from the readiness
// verdict maps, never epic membership — must not inflate `epicsOpen` just
// because the pinned epic is now present in the epics array.
test("computeBoardSummary: a pinned plan-closed epic (completed close verdict) never inflates epicsOpen", () => {
  const pinnedEpic = makeEpic({
    epic_id: "fn-9-x",
    status: "done",
    tasks: [],
  });
  const counts = computeBoardSummary({
    epics: [pinnedEpic],
    readiness: {
      perTask: new Map<string, Verdict>(),
      perCloseRow: new Map<string, Verdict>([["fn-9-x", COMPLETED]]),
    },
  });
  expect(counts).toEqual({
    epicsOpen: 0,
    epicsRunning: 0,
    epicsClosing: 0,
    tasksOpen: 0,
    tasksRunning: 0,
  });
});

test("needsHumanLines — a clean board (no distress) renders no block", () => {
  expect(needsHumanLines([])).toEqual([]);
});

test("needsHumanLines — folds each row to KIND · locator — trimmed reason, sorted by locator", () => {
  // Deliberately out of locator order to prove the byte-stable sort.
  const rows = [
    {
      locator: "/Users/mike/code/other",
      reason:
        "worktree-lane-wedge: lane keeper/epic/fn-9 cannot merge its base",
    },
    {
      locator: "/Users/mike/code/keeper",
      reason:
        "shared-checkout-dirty: /Users/mike/code/keeper has stayed dirty\nsecond line dropped",
    },
    {
      // fn-1169 — a shared-checkout-desync row surfaces on the same needs-human board
      // surface, folded to its own `shared-desync` kind (never shadowed by -dirty/-wedge).
      locator: "/Users/mike/code/zeta",
      reason:
        "shared-checkout-desync: /Users/mike/code/zeta has stayed DESYNCED\nsecond line dropped",
    },
  ];
  expect(needsHumanLines(rows)).toEqual([
    "needs human (3)",
    "  shared-dirty · /Users/mike/code/keeper — shared-checkout-dirty: /Users/mike/code/keeper has stayed dirty",
    "  lane-wedge · /Users/mike/code/other — worktree-lane-wedge: lane keeper/epic/fn-9 cannot merge its base",
    "  shared-desync · /Users/mike/code/zeta — shared-checkout-desync: /Users/mike/code/zeta has stayed DESYNCED",
  ]);
});

test("needsHumanLines — trims a reason first line past 120 chars with an ellipsis", () => {
  const long = `shared-checkout-dirty: ${"x".repeat(200)}`;
  const [, line] = needsHumanLines([{ locator: "/repo", reason: long }]);
  // 119 chars kept + a single ellipsis after the ` — ` separator.
  expect(line).toBe(`  shared-dirty · /repo — ${long.slice(0, 119)}…`);
});

test("orphanedFailureRows — surfaces a close failure whose plan-closed epic left the board", () => {
  // fn-1143 has dropped off the board (not in openEpicIds), so its stuck recover
  // row is an orphan — the prefix is stripped for the locator.
  const rows = orphanedFailureRows({
    openEpicIds: ["fn-1142-cli-descriptor-and-grammar-convergence"],
    openTaskIds: new Set<string>(),
    closeFailures: new Map([
      [
        "worktree-recover:fn-1143-excise-dead-shared-checkout-distress-qzvs8i",
        "worktree-recover-dirty-checkout: dirty checkout blocks the merge",
      ],
    ]),
    workFailures: new Map(),
  });
  expect(rows).toEqual([
    {
      locator: "fn-1143-excise-dead-shared-checkout-distress-qzvs8i",
      reason:
        "worktree-recover-dirty-checkout: dirty checkout blocks the merge",
    },
  ]);
});

test("orphanedFailureRows — a close failure homed to an OPEN epic is NOT an orphan (its pill covers it)", () => {
  const rows = orphanedFailureRows({
    openEpicIds: ["fn-1142-cli-descriptor-and-grammar-convergence"],
    openTaskIds: new Set<string>(),
    closeFailures: new Map([
      [
        "fn-1142-cli-descriptor-and-grammar-convergence",
        "worktree-finalize-conflict: merge conflict",
      ],
    ]),
    workFailures: new Map(),
  });
  expect(rows).toEqual([]);
});

// ADR 0018 (fn-1175.2): a plan-closed epic with a live close/work
// dispatch_failures row merges into `snap.epics` open-wins (ReadinessClient
// task .1), so `renderEpicsBody`'s epicIds set — and therefore
// `orphanedFailureRows`' `openEpicIds` here — carries it for free. The pinned
// epic's failure must surface in EXACTLY one place: its own block's
// `[failed:<kind>]` pill, never a duplicate orphan line.
test("orphanedFailureRows — a close failure homed to a PINNED closed epic (merged into openEpicIds) is NOT an orphan, mirroring an open epic", () => {
  const rows = orphanedFailureRows({
    openEpicIds: ["fn-9-x"],
    openTaskIds: new Set<string>(),
    closeFailures: new Map([
      ["fn-9-x", "worktree-merge-conflict: merging fn-9-x hit a conflict"],
    ]),
    workFailures: new Map(),
  });
  expect(rows).toEqual([]);
});

test("orphanedFailureRows — TWO dispatch-failure rows homed to the SAME pinned epic are BOTH covered, never a double orphan line", () => {
  const rows = orphanedFailureRows({
    openEpicIds: ["fn-9-x"],
    openTaskIds: new Set<string>(),
    closeFailures: new Map([
      ["worktree-finalize:fn-9-x-h1", "worktree-finalize-non-fast-forward"],
      [
        "worktree-recover:fn-9-x-h2",
        "worktree-recover-dirty-checkout: dirty checkout blocks the merge",
      ],
    ]),
    workFailures: new Map(),
  });
  expect(rows).toEqual([]);
});

test("orphanedFailureRows — a null-epic path-slug close row is dropped, never surfaced as an epic", () => {
  const rows = orphanedFailureRows({
    openEpicIds: [],
    openTaskIds: new Set<string>(),
    closeFailures: new Map([
      [
        "worktree-recover:/Users/mike/code/keeper",
        "worktree-recover-dirty-checkout: path-slug null-epic form",
      ],
    ]),
    workFailures: new Map(),
  });
  expect(rows).toEqual([]);
});

test("orphanedFailureRows — an off-board work failure surfaces; an on-board task does not", () => {
  const rows = orphanedFailureRows({
    openEpicIds: [],
    openTaskIds: new Set(["fn-1142-cli-descriptor-and-grammar-convergence.1"]),
    closeFailures: new Map(),
    workFailures: new Map([
      [
        "fn-1142-cli-descriptor-and-grammar-convergence.1",
        "on-board — skipped",
      ],
      ["fn-999-gone.2", "instant-death-breaker: worker keeps dying"],
    ]),
  });
  expect(rows).toEqual([
    {
      locator: "fn-999-gone.2",
      reason: "instant-death-breaker: worker keeps dying",
    },
  ]);
});

test("homedBlockedWorkRows — a homed blocked:-prefix work row is promoted; a non-blocked homed row is not", () => {
  const rows = homedBlockedWorkRows({
    openTaskIds: new Set(["fn-1171-a.1", "fn-1171-a.2"]),
    workFailures: new Map([
      ["fn-1171-a.1", "blocked: TOOLING_FAILURE"],
      ["fn-1171-a.2", "worktree-multi-repo"],
    ]),
  });
  expect(rows).toEqual([
    { locator: "fn-1171-a.1", reason: "blocked: TOOLING_FAILURE" },
  ]);
});

test("homedBlockedWorkRows — an off-board blocked:-prefix row is NOT homed (orphanedFailureRows covers it instead)", () => {
  const rows = homedBlockedWorkRows({
    openTaskIds: new Set<string>(),
    workFailures: new Map([["fn-999-gone.1", "blocked: unparseable"]]),
  });
  expect(rows).toEqual([]);
});

test("needsHumanLines — a promoted homed blocked:-prefix work row classifies as `blocked`, not `unknown` (task-id locator, category visible)", () => {
  const rows = homedBlockedWorkRows({
    openTaskIds: new Set(["fn-1171-a.1"]),
    workFailures: new Map([["fn-1171-a.1", "blocked: TOOLING_FAILURE"]]),
  });
  expect(needsHumanLines(rows)).toEqual([
    "needs human (1)",
    "  blocked · fn-1171-a.1 — blocked: TOOLING_FAILURE",
  ]);
});

// fn-713 follow-on: renderTaskPills appends runtime_status + worker_phase at
// their current value — defaults included, no verdict-aware suppression. The
// `_verdict` arg is retained for arity but no longer consulted. (fn-756 dropped
// the third [approval] pill with the rest of the approval surface.)
test("renderTaskCellPills: shows model and effort on every task", () => {
  expect(renderTaskCellPills({ model: "opus", tier: "xhigh" })).toBe(
    ` ${pill("model:opus")} ${pill("effort:xhigh")}`,
  );
});

test("renderTaskCellPills: missing model or effort renders unknown", () => {
  expect(renderTaskCellPills({})).toBe(
    ` ${pill("model:—")} ${pill("effort:—")}`,
  );
});

test("renderTaskPills: all-resting task (todo/open) now shows both defaults", () => {
  expect(
    renderTaskPills({ runtime_status: "todo", worker_phase: "open" }, READY),
  ).toBe(` ${pill("todo")} ${pill("open")}`);
});

test("renderTaskPills: runtime_status renders todo/in_progress/done verbatim", () => {
  expect(renderTaskPills({ runtime_status: "in_progress" }, READY)).toBe(
    ` ${pill("in_progress")} ${pill("open")}`,
  );
  expect(renderTaskPills({ runtime_status: "done" }, READY)).toBe(
    ` ${pill("done")} ${pill("open")}`,
  );
  expect(renderTaskPills({ runtime_status: "todo" }, READY)).toBe(
    ` ${pill("todo")} ${pill("open")}`,
  );
});

test("renderTaskPills: runtime_status=blocked relabels to [rt:blocked]", () => {
  expect(renderTaskPills({ runtime_status: "blocked" }, READY)).toBe(
    ` ${pill("rt:blocked")} ${pill("open")}`,
  );
  // never the bare [blocked] that would collide with the verdict family.
  expect(renderTaskPills({ runtime_status: "blocked" }, READY)).not.toContain(
    pill("blocked"),
  );
});

test("renderTaskPills: worker_phase=open renders [open] (default now shown)", () => {
  expect(renderTaskPills({ worker_phase: "open" }, READY)).toBe(
    ` ${pill("todo")} ${pill("open")}`,
  );
  expect(renderTaskPills({ worker_phase: "open" }, JOB_RUNNING)).toBe(
    ` ${pill("todo")} ${pill("open")}`,
  );
});

test("renderTaskPills: worker_phase=done renders [worker-done] in the previously-UNPINNED verdict classes", () => {
  for (const v of [
    JOB_RUNNING,
    SUBAGENT_RUNNING,
    SUBAGENT_STALE,
    EPIC_NOT_VALIDATED,
    READY,
  ]) {
    expect(renderTaskPills({ worker_phase: "done" }, v)).toBe(
      ` ${pill("todo")} ${pill("worker-done")}`,
    );
  }
});

// fn-713 follow-on INVERTS the old fn-708 T3 behavior: where the verdict used
// to PIN (suppress) [worker-done], the labeled survivor now ALWAYS shows.
test("renderTaskPills: worker_phase=done now SHOWS [worker-done] even where the verdict formerly pinned it", () => {
  for (const v of [COMPLETED, JOB_PENDING, GIT_UNCOMMITTED, GIT_ORPHANS]) {
    expect(renderTaskPills({ worker_phase: "done" }, v)).toBe(
      ` ${pill("todo")} ${pill("worker-done")}`,
    );
  }
});

test("renderTaskPills: never renders a bare [done] for worker_phase (de-ambiguation)", () => {
  // The worker survivor is ALWAYS labeled; a bare [done] only ever comes
  // from runtime_status. With worker_phase=done + runtime_status absent
  // (defaults to todo), the worker slot is [worker-done], not [done].
  const out = renderTaskPills({ worker_phase: "done" }, JOB_RUNNING);
  expect(out).toContain(pill("worker-done"));
  expect(out).not.toContain(pill("done"));
});

test("renderTaskPills: completed task shows both (runtime done + worker-done)", () => {
  // [done][worker-done] — both render their literal value now.
  expect(
    renderTaskPills(
      { runtime_status: "done", worker_phase: "done" },
      COMPLETED,
    ),
  ).toBe(` ${pill("done")} ${pill("worker-done")}`);
});

test("renderTaskPills: stacks fields in fixed order rt → worker", () => {
  // in_progress runtime + worker done.
  expect(
    renderTaskPills(
      {
        runtime_status: "in_progress",
        worker_phase: "done",
      },
      JOB_RUNNING,
    ),
  ).toBe(` ${pill("in_progress")} ${pill("worker-done")}`);
});

// ---------------------------------------------------------------------------
// fn-708: renderClosePills — close-row status (T2). (fn-756 dropped the
// [approval] pill with the rest of the approval surface.)
// ---------------------------------------------------------------------------

// fn-713 follow-on: renderClosePills appends status (default open) at its
// current value — reversing the fn-708 T2 status-drop.
test("renderClosePills: now shows the [status] pill (default open)", () => {
  expect(renderClosePills({ status: "open" }, READY)).toBe(` ${pill("open")}`);
  expect(renderClosePills({ status: "open" }, COMPLETED)).toContain(
    pill("open"),
  );
});

test("renderClosePills: renders a non-open status value verbatim", () => {
  expect(renderClosePills({ status: "closed" }, READY)).toBe(
    ` ${pill("closed")}`,
  );
});

// ---------------------------------------------------------------------------
// renderDispatchFailurePill — the sticky dispatch-failure pill for a task or
// close row. Carries only the short display KIND (via `classifyDispatchFailure`)
// so a multi-line conflict dump stays one scannable pill; the `failed:*`
// colorizer branch routes it red.
// ---------------------------------------------------------------------------

test("renderDispatchFailurePill: empty / undefined reason renders nothing", () => {
  expect(renderDispatchFailurePill(undefined)).toBe("");
  expect(renderDispatchFailurePill("")).toBe("");
});

test("renderDispatchFailurePill: a multi-line conflict reason collapses to merge-conflict", () => {
  // The live shape: `<reason>: <detail…>` where the detail is a multi-line merge
  // conflict dump. Only the short `merge-conflict` KIND survives into the pill.
  const reason =
    "worktree-merge-conflict: merging keeper/epic/fn-1005--…\nCONFLICT (content): README.md";
  expect(renderDispatchFailurePill(reason)).toBe(
    ` ${pill("failed:merge-conflict")}`,
  );
});

test("renderDispatchFailurePill: known reasons map to the short display vocab", () => {
  expect(renderDispatchFailurePill("worktree-multi-repo")).toBe(
    ` ${pill("failed:multi-repo")}`,
  );
  expect(renderDispatchFailurePill("worktree-finalize-non-fast-forward")).toBe(
    ` ${pill("failed:non-ff")}`,
  );
  expect(renderDispatchFailurePill("worktree-recover-dirty-checkout")).toBe(
    ` ${pill("failed:dirty-tree")}`,
  );
});

test("renderDispatchFailurePill: an unknown reason falls back to its leading token", () => {
  expect(renderDispatchFailurePill("some-novel-reason: detail")).toBe(
    ` ${pill("failed:some-novel-reason")}`,
  );
});

test("renderDispatchFailurePill: the pill colorizes red via the failed:* branch", () => {
  // The `failed:*` → error routing is pinned exhaustively above; here just
  // confirm the helper's pill lands in that bucket (red SGR wraps the token).
  const colored = colorizePillsInLine(
    renderDispatchFailurePill("worktree-merge-conflict: …").trimStart(),
  );
  expect(colored).toContain(ERROR);
  expect(colored).toContain("failed:merge-conflict");
  expect(colored).toContain(RESET);
});

// ---------------------------------------------------------------------------
// fn-708: subagentLinesFor — status pill omit-default ({ok, null, empty})
// ---------------------------------------------------------------------------

function subFixture(
  status: string | null,
  over: Partial<SubagentInvocation> = {},
): Map<string, SubagentInvocation[]> {
  return new Map([
    [
      "j",
      [
        {
          job_id: "j",
          subagent_type: "scout",
          turn_seq: 0,
          ts: 1,
          status,
          description: "d",
          last_event_id: 1,
          ...over,
        } as unknown as SubagentInvocation,
      ],
    ],
  ]);
}

// fn-713 follow-on inverts fn-708 omit-default: the status pill now ALWAYS
// renders, `ok` included. Null / empty status coalesces to the resting `ok`.
test("subagentLinesFor: shows the [ok] pill for status=ok (default now shown)", () => {
  expect(subagentLinesFor(subFixture("ok"), "j", "  ")).toEqual([
    `  scout: d ${pill("ok")}`,
  ]);
});

test("subagentLinesFor: null status coalesces to the [ok] pill (no literal [])", () => {
  const lines = subagentLinesFor(subFixture(null), "j", "  ");
  expect(lines).toEqual([`  scout: d ${pill("ok")}`]);
  expect(lines[0]).not.toContain("[]");
});

test("subagentLinesFor: empty-string status coalesces to the [ok] pill", () => {
  expect(subagentLinesFor(subFixture(""), "j", "  ")).toEqual([
    `  scout: d ${pill("ok")}`,
  ]);
});

test("subagentLinesFor: keeps running / failed / unknown / superseded", () => {
  expect(subagentLinesFor(subFixture("running"), "j", "  ")).toEqual([
    `  scout: d ${pill("running")}`,
  ]);
  expect(subagentLinesFor(subFixture("failed"), "j", "  ")).toEqual([
    `  scout: d ${pill("failed")}`,
  ]);
  expect(subagentLinesFor(subFixture("unknown"), "j", "  ")).toEqual([
    `  scout: d ${pill("unknown")}`,
  ]);
  expect(subagentLinesFor(subFixture("superseded"), "j", "  ")).toEqual([
    `  scout: d ${pill("superseded")}`,
  ]);
});

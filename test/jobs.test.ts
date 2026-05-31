/**
 * Pure-function tests for `cli/jobs.ts` — the keeper-jobs view's job-row
 * shape, the ambient-vs-plan-bound partition + empty-side drop rule,
 * the nested per-job sub-agent lines, and the dead-letter banner pill
 * (re-exported from `src/board-render.ts`).
 *
 * No live-shell, no subscribe loop — these helpers are pure module
 * functions, asserted directly. The mock-socket pattern from
 * `test/git.test.ts` is intentionally NOT exercised here: the jobs view
 * composes onto `subscribeReadiness` (already covered by
 * `test/readiness-client.test.ts`) rather than introducing a new wire
 * surface. The pure-function coverage below catches every render-shape
 * regression that the live-shell loop would surface.
 */

import { expect, test } from "bun:test";
import { projectJobRow, renderJobsBody } from "../cli/jobs";
import { colorizePillsInLine, renderDeadLetterPill } from "../src/board-render";
import type { SubagentInvocation } from "../src/types";

// ---------------------------------------------------------------------------
// SubagentInvocation fixture — minimal shape, copied from
// test/board.test.ts:makeSub so the per-job nested-line tests below have
// the same field-set the production code reads. The two callers stay
// in sync via the shared `SubagentInvocation` type import; a future
// shape bump fails both.
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

// ---------------------------------------------------------------------------
// projectJobRow — the per-row line shape: `(cwd) {title} [{role}]? [{state}]`
// with optional `[failed:<kind>]` inline and optional `[awaiting:<kind>]`
// dropped onto a continuation line.
// ---------------------------------------------------------------------------

test("projectJobRow: full shape — cwd basename, title, role pill, state pill", () => {
  const line = projectJobRow({
    job_id: "j1",
    cwd: "/Users/alice/code/keeper",
    title: "do the thing",
    plan_verb: "work",
    state: "working",
  });
  expect(line).toBe("(keeper) do the thing [worker] [working]");
});

test("projectJobRow: null cwd drops the (cwd) prefix entirely", () => {
  const line = projectJobRow({
    title: "ambient session",
    plan_verb: null,
    state: "stopped",
  });
  // No leading "() " — the empty basename suppresses the prefix.
  expect(line).toBe("ambient session [stopped]");
});

test("projectJobRow: null plan_verb suppresses the [role] pill", () => {
  const line = projectJobRow({
    cwd: "/repo/x",
    title: "ad-hoc",
    plan_verb: null,
    state: "working",
  });
  // Inline shape carries no role pill — exactly two pills (no role pill
  // means we go straight from title to state).
  expect(line).toBe("(x) ad-hoc [working]");
});

test("projectJobRow: last_api_error_at appends [failed:<kind>] inline (same line)", () => {
  const line = projectJobRow({
    cwd: "/repo/x",
    title: "rate-limited",
    plan_verb: "plan",
    state: "stopped",
    last_api_error_at: 12345,
    last_api_error_kind: "rate_limit",
  });
  expect(line).toBe("(x) rate-limited [planner] [stopped] [failed:rate_limit]");
});

test("projectJobRow: last_input_request_at drops [awaiting:<kind>] onto its own continuation line", () => {
  const line = projectJobRow({
    cwd: "/repo/x",
    title: "asking",
    plan_verb: "work",
    state: "stopped",
    last_input_request_at: 999,
    last_input_request_kind: "ask_user_question",
  });
  // Continuation line indented two spaces (matches the depth of the
  // row's sub-agent lines, which the caller appends below).
  expect(line).toBe(
    "(x) asking [worker] [stopped]\n  [awaiting:ask_user_question]",
  );
});

// ---------------------------------------------------------------------------
// renderJobsBody — partitions by plan_verb (no-role on top, with-role on
// bottom), separates by `~~~`, drops the divider when either side is empty.
// ---------------------------------------------------------------------------

test("renderJobsBody: empty jobs map → empty string", () => {
  expect(
    renderJobsBody(new Map(), new Map<string, SubagentInvocation[]>()),
  ).toBe("");
});

test("renderJobsBody: only ambient (no plan_verb) → single partition, no `~~~`", () => {
  const jobs = new Map<string, unknown>([
    [
      "j-amb",
      {
        job_id: "j-amb",
        cwd: "/repo/x",
        title: "ambient",
        plan_verb: null,
        state: "working",
      },
    ],
  ]);
  const body = renderJobsBody(jobs, new Map());
  expect(body).toBe("(x) ambient [working]");
  expect(body).not.toContain("~~~");
});

test("renderJobsBody: only plan-bound (plan_verb set) → single partition, no `~~~`", () => {
  const jobs = new Map<string, unknown>([
    [
      "j-work",
      {
        job_id: "j-work",
        cwd: "/repo/y",
        title: "worker",
        plan_verb: "work",
        state: "stopped",
      },
    ],
  ]);
  const body = renderJobsBody(jobs, new Map());
  expect(body).toBe("(y) worker [worker] [stopped]");
  expect(body).not.toContain("~~~");
});

test("renderJobsBody: both partitions present → ambient on top, `~~~` divider, plan-bound below", () => {
  // Insertion order: plan-bound first, ambient second. The partition
  // assignment must be by plan_verb (not iteration order), so ambient
  // still renders on top.
  const jobs = new Map<string, unknown>([
    [
      "j-work",
      {
        job_id: "j-work",
        cwd: "/repo/y",
        title: "worker",
        plan_verb: "work",
        state: "stopped",
      },
    ],
    [
      "j-amb",
      {
        job_id: "j-amb",
        cwd: "/repo/x",
        title: "ambient",
        plan_verb: null,
        state: "working",
      },
    ],
  ]);
  const body = renderJobsBody(jobs, new Map());
  expect(body).toBe(
    ["(x) ambient [working]", "~~~", "(y) worker [worker] [stopped]"].join(
      "\n",
    ),
  );
});

test("renderJobsBody: within-partition order preserves the helper's wire order", () => {
  // Two ambient jobs — the second one inserted should render second.
  const jobs = new Map<string, unknown>([
    [
      "j-first",
      {
        job_id: "j-first",
        cwd: "/repo/a",
        title: "first",
        plan_verb: null,
        state: "working",
      },
    ],
    [
      "j-second",
      {
        job_id: "j-second",
        cwd: "/repo/b",
        title: "second",
        plan_verb: null,
        state: "working",
      },
    ],
  ]);
  const body = renderJobsBody(jobs, new Map());
  expect(body).toBe(["(a) first [working]", "(b) second [working]"].join("\n"));
});

// ---------------------------------------------------------------------------
// renderJobsBody: nested sub-agent lines — each row is followed by its
// `subagentLinesFor(..., "  ")` block (two-space indent). The collapse
// + annotation rules (same-name within one job collapses; `×N` /
// `N stuck` annotations) are unit-tested in test/board.test.ts via
// collapseSubagentsByName; here we cover that the lines actually nest
// under the right job.
// ---------------------------------------------------------------------------

test("renderJobsBody: nested sub-agent line appears immediately under the matching job row", () => {
  const jobs = new Map<string, unknown>([
    [
      "j-amb",
      {
        job_id: "j-amb",
        cwd: "/repo/x",
        title: "ambient",
        plan_verb: null,
        state: "working",
      },
    ],
  ]);
  const subagentIndex = new Map<string, SubagentInvocation[]>([
    [
      "j-amb",
      [
        makeSub({
          job_id: "j-amb",
          subagent_type: "general-purpose",
          description: "investigate",
          status: "running",
        }),
      ],
    ],
  ]);
  const body = renderJobsBody(jobs, subagentIndex);
  expect(body).toBe(
    ["(x) ambient [working]", "  general-purpose: investigate [running]"].join(
      "\n",
    ),
  );
});

test("renderJobsBody: sub-agent lines route to the correct partition (ambient vs plan-bound)", () => {
  // One ambient job + one plan-bound job, each with its own sub-agent.
  // The sub-agent line must appear inside the SAME partition as its
  // parent job — never on the wrong side of the `~~~` divider.
  const jobs = new Map<string, unknown>([
    [
      "j-amb",
      {
        job_id: "j-amb",
        cwd: "/repo/x",
        title: "ambient",
        plan_verb: null,
        state: "working",
      },
    ],
    [
      "j-work",
      {
        job_id: "j-work",
        cwd: "/repo/y",
        title: "worker",
        plan_verb: "work",
        state: "stopped",
      },
    ],
  ]);
  const subagentIndex = new Map<string, SubagentInvocation[]>([
    [
      "j-amb",
      [
        makeSub({
          job_id: "j-amb",
          subagent_type: "scout",
          description: "scout-task",
          status: "ok",
        }),
      ],
    ],
    [
      "j-work",
      [
        makeSub({
          job_id: "j-work",
          subagent_type: "build",
          description: "build-task",
          status: "running",
        }),
      ],
    ],
  ]);
  const body = renderJobsBody(jobs, subagentIndex);
  // Expected:
  //   (x) ambient [working]
  //     scout: scout-task [ok]
  //   ~~~
  //   (y) worker [worker] [stopped]
  //     build: build-task [running]
  expect(body).toBe(
    [
      "(x) ambient [working]",
      "  scout: scout-task [ok]",
      "~~~",
      "(y) worker [worker] [stopped]",
      "  build: build-task [running]",
    ].join("\n"),
  );
});

// ---------------------------------------------------------------------------
// Dead-letter banner pill — re-exercised here (same assertions as
// test/board.test.ts) so jobs.test.ts owns the surface its renderer
// consumes. The pill string + the warn-bucket colorization are both
// reachable from this test file's imports.
// ---------------------------------------------------------------------------

test("renderDeadLetterPill: positive N renders `[dead-letter:N]` verbatim", () => {
  expect(renderDeadLetterPill(1)).toBe("[dead-letter:1]");
  expect(renderDeadLetterPill(7)).toBe("[dead-letter:7]");
});

test("renderDeadLetterPill: zero / negative / NaN collapse to empty (banner drops the pill cleanly)", () => {
  expect(renderDeadLetterPill(0)).toBe("");
  expect(renderDeadLetterPill(-1)).toBe("");
  expect(renderDeadLetterPill(Number.NaN)).toBe("");
});

test("colorizePillsInLine: dead-letter:<N> takes the warn bucket via prefix fallback", () => {
  // Same SGR contract test/board.test.ts asserts — yellow (warn) bucket
  // via the `dead-letter:*` prefix branch in colorizePillsInLine.
  const WARN = "\x1b[33m";
  const RESET = "\x1b[0m";
  expect(colorizePillsInLine("[dead-letter:3]")).toBe(
    `[${WARN}dead-letter:3${RESET}]`,
  );
});

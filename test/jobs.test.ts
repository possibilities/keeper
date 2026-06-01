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
import {
  backendCoordsSeg,
  projectJobRow,
  renderJobsBody,
  selectableJobIds,
} from "../cli/jobs";
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
// backendCoordsSeg + projectJobRow with backend coords — schema v48 /
// fn-668. The optional trailing `· <type> <session>/<tab> p<pane>` segment
// is present-only (renders nothing when `backend_exec_type` is null) and
// gracefully falls back when inner fields are missing.
// ---------------------------------------------------------------------------

test("backendCoordsSeg: all coords present — composes the full ' · <type> <session>/<tab> p<pane>' segment", () => {
  expect(
    backendCoordsSeg({
      backend_exec_type: "zellij",
      backend_exec_session_id: "ada",
      backend_exec_pane_id: "11",
      backend_exec_tab_id: "3",
      backend_exec_tab_name: "main",
    }),
  ).toBe(" · zellij ada/main p11");
});

test("backendCoordsSeg: absent backend_exec_type → empty string (present-only)", () => {
  expect(
    backendCoordsSeg({
      // Type null — every other coord is irrelevant; the segment should
      // never render. Guards against `undefined`/`null` leaking into the
      // composed line.
      backend_exec_type: null,
      backend_exec_session_id: "ada",
      backend_exec_pane_id: "11",
      backend_exec_tab_id: "3",
      backend_exec_tab_name: "main",
    }),
  ).toBe("");
});

test("backendCoordsSeg: tab name missing → falls back to raw tab_id", () => {
  expect(
    backendCoordsSeg({
      backend_exec_type: "zellij",
      backend_exec_session_id: "ada",
      backend_exec_pane_id: "11",
      backend_exec_tab_id: "3",
      backend_exec_tab_name: null,
    }),
  ).toBe(" · zellij ada/3 p11");
});

test("backendCoordsSeg: tab fully missing → bare session, no '/<…>' slot", () => {
  // Typical between hook capture and the tab-resolver worker's first
  // snapshot — `backend_exec_session_id` + `backend_exec_pane_id` land
  // immediately, the tab columns trail by one tick.
  expect(
    backendCoordsSeg({
      backend_exec_type: "zellij",
      backend_exec_session_id: "ada",
      backend_exec_pane_id: "11",
      backend_exec_tab_id: null,
      backend_exec_tab_name: null,
    }),
  ).toBe(" · zellij ada p11");
});

test("backendCoordsSeg: pane missing → drops the ' p<…>' suffix", () => {
  expect(
    backendCoordsSeg({
      backend_exec_type: "zellij",
      backend_exec_session_id: "ada",
      backend_exec_pane_id: null,
      backend_exec_tab_id: "3",
      backend_exec_tab_name: "main",
    }),
  ).toBe(" · zellij ada/main");
});

test("backendCoordsSeg: type only — every other coord null → bare type", () => {
  // Defense-in-depth: ENV-capture stamped `ZELLIJ=1` but somehow no
  // session/pane/tab. Renders the bare backend type rather than
  // collapsing to `· zellij` with trailing-space artifacts.
  expect(
    backendCoordsSeg({
      backend_exec_type: "zellij",
      backend_exec_session_id: null,
      backend_exec_pane_id: null,
      backend_exec_tab_id: null,
      backend_exec_tab_name: null,
    }),
  ).toBe(" · zellij");
});

test("projectJobRow: backend coords append to the row inline (after the state pill)", () => {
  const line = projectJobRow({
    job_id: "j1",
    cwd: "/Users/alice/code/keeper",
    title: "live session",
    plan_verb: null,
    state: "working",
    backend_exec_type: "zellij",
    backend_exec_session_id: "ada",
    backend_exec_pane_id: "11",
    backend_exec_tab_id: "3",
    backend_exec_tab_name: "main",
  });
  expect(line).toBe("(keeper) live session [working] · zellij ada/main p11");
});

test("projectJobRow: absent backend coords render as nothing (no placeholder, no 'undefined')", () => {
  const line = projectJobRow({
    job_id: "j1",
    cwd: "/Users/alice/code/keeper",
    title: "live session",
    plan_verb: null,
    state: "working",
    // No backend_exec_* keys at all — the row predates schema v48 OR
    // the session is running outside a multiplexer.
  });
  expect(line).toBe("(keeper) live session [working]");
  expect(line).not.toContain("undefined");
  expect(line).not.toContain("·");
});

test("projectJobRow: backend coords + awaiting continuation — backend sits on the head line, awaiting drops below", () => {
  const line = projectJobRow({
    cwd: "/repo/x",
    title: "asking",
    plan_verb: "work",
    state: "stopped",
    last_input_request_at: 999,
    last_input_request_kind: "ask_user_question",
    backend_exec_type: "zellij",
    backend_exec_session_id: "ada",
    backend_exec_pane_id: "11",
    backend_exec_tab_name: "main",
  });
  // Backend segment sits on the head line (after the state pill);
  // the awaiting pill keeps its own indented continuation line.
  expect(line).toBe(
    "(x) asking [worker] [stopped] · zellij ada/main p11\n  [awaiting:ask_user_question]",
  );
});

// ---------------------------------------------------------------------------
// renderJobsBody — partitions by plan_verb (no-role on top under
// `--- interactive ---`, with-role on bottom under `--- autopilot ---`),
// drops a heading when its side is empty (autopilot-style).
// ---------------------------------------------------------------------------

test("renderJobsBody: empty jobs map → empty string", () => {
  expect(
    renderJobsBody(new Map(), new Map<string, SubagentInvocation[]>()),
  ).toBe("");
});

test("renderJobsBody: only ambient (no plan_verb) → interactive heading only, no autopilot heading", () => {
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
  expect(body).toBe(
    ["--- interactive ---", "(x) ambient [working]"].join("\n"),
  );
  expect(body).not.toContain("--- autopilot ---");
});

test("renderJobsBody: only plan-bound (plan_verb set) → autopilot heading only, no interactive heading", () => {
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
  expect(body).toBe(
    ["--- autopilot ---", "(y) worker [worker] [stopped]"].join("\n"),
  );
  expect(body).not.toContain("--- interactive ---");
});

test("renderJobsBody: both partitions present → interactive heading + rows on top, autopilot heading + rows below", () => {
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
    [
      "--- interactive ---",
      "(x) ambient [working]",
      "--- autopilot ---",
      "(y) worker [worker] [stopped]",
    ].join("\n"),
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
  expect(body).toBe(
    ["--- interactive ---", "(a) first [working]", "(b) second [working]"].join(
      "\n",
    ),
  );
});

// ---------------------------------------------------------------------------
// renderJobsBody: nested sub-agent lines — COLLAPSE-BY-DEFAULT. A job's
// `subagentLinesFor(..., "  ")` block (two-space indent) renders only
// when the job is in `render.expanded`. The collapse + annotation rules
// (same-name within one job collapses; `×N` / `N stuck` annotations) are
// unit-tested in test/board.test.ts via collapseSubagentsByName; here we
// cover default-hidden + expand-to-show + correct partition nesting.
// ---------------------------------------------------------------------------

const ambWithSub = (): {
  jobs: Map<string, unknown>;
  subagentIndex: Map<string, SubagentInvocation[]>;
} => ({
  jobs: new Map<string, unknown>([
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
  ]),
  subagentIndex: new Map<string, SubagentInvocation[]>([
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
  ]),
});

test("renderJobsBody: sub-agents are collapse-by-default (hidden with no render opts)", () => {
  const { jobs, subagentIndex } = ambWithSub();
  const body = renderJobsBody(jobs, subagentIndex);
  expect(body).toBe(
    ["--- interactive ---", "(x) ambient [working]"].join("\n"),
  );
  expect(body).not.toContain("general-purpose");
});

test("renderJobsBody: expanding a job reveals its nested sub-agent line beneath it", () => {
  const { jobs, subagentIndex } = ambWithSub();
  const body = renderJobsBody(jobs, subagentIndex, {
    insertMode: false,
    selectedIndex: 0,
    expanded: new Set(["j-amb"]),
  });
  expect(body).toBe(
    [
      "--- interactive ---",
      "(x) ambient [working]",
      "  general-purpose: investigate [running]",
    ].join("\n"),
  );
});

test("renderJobsBody: sub-agent lines route to the correct partition (ambient vs plan-bound)", () => {
  // One ambient job + one plan-bound job, each with its own sub-agent.
  // The sub-agent line must appear inside the SAME partition as its
  // parent job — never on the wrong side of the heading boundary.
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
  const body = renderJobsBody(jobs, subagentIndex, {
    insertMode: false,
    selectedIndex: 0,
    expanded: new Set(["j-amb", "j-work"]),
  });
  // Expected:
  //   --- interactive ---
  //   (x) ambient [working]
  //     scout: scout-task [ok]
  //   --- autopilot ---
  //   (y) worker [worker] [stopped]
  //     build: build-task [running]
  expect(body).toBe(
    [
      "--- interactive ---",
      "(x) ambient [working]",
      "  scout: scout-task [ok]",
      "--- autopilot ---",
      "(y) worker [worker] [stopped]",
      "  build: build-task [running]",
    ].join("\n"),
  );
});

// ---------------------------------------------------------------------------
// selectableJobIds — the render-order list insert-mode selection walks
// (interactive partition first, then autopilot). Shared by renderJobsBody
// and the key handler so the two never disagree on ordering.
// ---------------------------------------------------------------------------

test("selectableJobIds: interactive jobs first, then autopilot, preserving wire order", () => {
  // Insertion order interleaves the partitions; the result must still be
  // all-interactive-then-all-autopilot, each in wire order.
  const jobs = new Map<string, unknown>([
    ["w1", { job_id: "w1", plan_verb: "work" }],
    ["a1", { job_id: "a1", plan_verb: null }],
    ["w2", { job_id: "w2", plan_verb: "plan" }],
    ["a2", { job_id: "a2", plan_verb: null }],
  ]);
  expect(selectableJobIds(jobs)).toEqual(["a1", "a2", "w1", "w2"]);
});

// ---------------------------------------------------------------------------
// renderJobsBody insert-mode decoration: 2-space base indent on every
// line, a disclosure triangle on job rows that have children, and a
// `> ` marker on the selected row. Nerd Font glyphs: caret-right
// (collapsed) / caret-down (expanded).
// ---------------------------------------------------------------------------

const TRI_RIGHT = "\uf0da"; // GLYPH_COLLAPSED // GLYPH_COLLAPSED
const TRI_DOWN = "\uf0d7"; // GLYPH_EXPANDED // GLYPH_EXPANDED

test("renderJobsBody insert mode: indent + selection marker + collapsed triangle", () => {
  const jobs = new Map<string, unknown>([
    [
      "j1",
      {
        job_id: "j1",
        cwd: "/repo/a",
        title: "first",
        plan_verb: null,
        state: "working",
      },
    ],
    [
      "j2",
      {
        job_id: "j2",
        cwd: "/repo/b",
        title: "second",
        plan_verb: null,
        state: "working",
      },
    ],
  ]);
  // j1 has a sub-agent (so it gets a triangle); j2 has none (blank gutter).
  const subagentIndex = new Map<string, SubagentInvocation[]>([
    [
      "j1",
      [
        makeSub({
          job_id: "j1",
          subagent_type: "scout",
          description: "d",
          status: "ok",
        }),
      ],
    ],
  ]);
  const body = renderJobsBody(jobs, subagentIndex, {
    insertMode: true,
    selectedIndex: 0,
    expanded: new Set(),
  });
  expect(body).toBe(
    [
      "    --- interactive ---", // heading: 2 base + 2 disclosure pad
      `> ${TRI_RIGHT} (a) first [working]`, // selected, collapsed-with-children
      "    (b) second [working]", // unselected, no children → blank gutter
    ].join("\n"),
  );
});

test("renderJobsBody insert mode: selected + expanded shows down-triangle and reveals child", () => {
  const jobs = new Map<string, unknown>([
    [
      "j1",
      {
        job_id: "j1",
        cwd: "/repo/a",
        title: "first",
        plan_verb: null,
        state: "working",
      },
    ],
  ]);
  const subagentIndex = new Map<string, SubagentInvocation[]>([
    [
      "j1",
      [
        makeSub({
          job_id: "j1",
          subagent_type: "scout",
          description: "d",
          status: "ok",
        }),
      ],
    ],
  ]);
  const body = renderJobsBody(jobs, subagentIndex, {
    insertMode: true,
    selectedIndex: 0,
    expanded: new Set(["j1"]),
  });
  expect(body).toBe(
    [
      "    --- interactive ---",
      `> ${TRI_DOWN} (a) first [working]`, // selected, expanded
      "      scout: d [ok]", // child: 2 base + 2 pad + its own 2
    ].join("\n"),
  );
});

test("renderJobsBody insert mode: out-of-range selectedIndex clamps (no marker leak / no crash)", () => {
  const jobs = new Map<string, unknown>([
    [
      "j1",
      {
        job_id: "j1",
        cwd: "/repo/a",
        title: "first",
        plan_verb: null,
        state: "working",
      },
    ],
  ]);
  // selectedIndex past the end clamps to the last row, which gets the marker.
  const body = renderJobsBody(jobs, new Map(), {
    insertMode: true,
    selectedIndex: 99,
    expanded: new Set(),
  });
  expect(body).toBe(
    // `> ` selection marker + `  ` blank disclosure gutter (no children).
    ["    --- interactive ---", ">   (a) first [working]"].join("\n"),
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

/**
 * Pure-function tests for `cli/jobs.ts` — the keeper-jobs view's job-row
 * shape, the per-session section grouping + empty-section drop rule, the
 * nested per-job sub-agent lines (collapse-controlled), the
 * collapse-controlled backend-coords pill, and the dead-letter banner
 * pill (re-exported from `src/board-render.ts`).
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
  monitorLinesFor,
  projectJobRow,
  renderJobsBody,
  selectableJobIds,
} from "../cli/jobs";
import { colorizePillsInLine, renderDeadLetterPill } from "../src/board-render";
import type { SubagentInvocation } from "../src/types";
import { SELECTED_LINE_PREFIX } from "../src/view-shell";

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

test("projectJobRow: backend coords NEVER appear in the per-row output (collapse-controlled)", () => {
  // The backend-coords pill moved out of `projectJobRow` and into the
  // collapse-controlled region of `renderJobsBody`. Even when every
  // coord is populated, `projectJobRow` returns just the head line
  // (plus an awaiting continuation when applicable) — no backend pill.
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
  expect(line).toBe("(keeper) live session [working]");
  expect(line).not.toContain("·");
  expect(line).not.toContain("[main");
});

test("projectJobRow: awaiting drops to its own continuation line; backend never appears here", () => {
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
  // Head + always-visible awaiting line only. The backend pill is
  // collapse-controlled and lives in `renderJobsBody`'s expanded region.
  expect(line).toBe(
    "(x) asking [worker] [stopped]\n  [awaiting:ask_user_question]",
  );
});

// ---------------------------------------------------------------------------
// backendCoordsSeg — the session-less, type-less pill `[<tab> p<pane>]`.
// Bracketed so `colorizePillsInLine` tints it like other status pills.
// Fallbacks: tab name → tab id → drop; missing pane drops ` p<pane>`;
// tab AND pane both missing → "".
// ---------------------------------------------------------------------------

test("backendCoordsSeg: tab name + pane → '[<tab> p<pane>]'", () => {
  expect(
    backendCoordsSeg({
      backend_exec_type: "zellij",
      backend_exec_session_id: "ada",
      backend_exec_pane_id: "11",
      backend_exec_tab_id: "3",
      backend_exec_tab_name: "main",
    }),
  ).toBe("[main p11]");
});

test("backendCoordsSeg: no `·`, no type, no session id in the pill output", () => {
  // Belt-and-suspenders against the old shape. Confirm the new pill
  // never carries the old free-text segments.
  const out = backendCoordsSeg({
    backend_exec_type: "zellij",
    backend_exec_session_id: "ada",
    backend_exec_pane_id: "11",
    backend_exec_tab_id: "3",
    backend_exec_tab_name: "main",
  });
  expect(out).not.toContain("·");
  expect(out).not.toContain("zellij");
  expect(out).not.toContain("ada");
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
  ).toBe("[3 p11]");
});

test("backendCoordsSeg: tab fully missing → drops the tab slot, pane-only pill", () => {
  expect(
    backendCoordsSeg({
      backend_exec_type: "zellij",
      backend_exec_session_id: "ada",
      backend_exec_pane_id: "11",
      backend_exec_tab_id: null,
      backend_exec_tab_name: null,
    }),
  ).toBe("[p11]");
});

test("backendCoordsSeg: pane missing → drops the ' p<pane>' slot, tab-only pill", () => {
  expect(
    backendCoordsSeg({
      backend_exec_type: "zellij",
      backend_exec_session_id: "ada",
      backend_exec_pane_id: null,
      backend_exec_tab_id: "3",
      backend_exec_tab_name: "main",
    }),
  ).toBe("[main]");
});

test("backendCoordsSeg: tab AND pane both missing → '' (nothing worth showing)", () => {
  expect(
    backendCoordsSeg({
      backend_exec_type: "zellij",
      backend_exec_session_id: "ada",
      backend_exec_pane_id: null,
      backend_exec_tab_id: null,
      backend_exec_tab_name: null,
    }),
  ).toBe("");
});

test("backendCoordsSeg: absent backend_exec_type still composes a pill from tab/pane", () => {
  // The new shape is session-less AND type-less — the row is already
  // grouped under its session heading by `renderJobsBody`, and the only
  // backend keeper knows about is zellij. So a present tab/pane still
  // produces a pill even when `backend_exec_type` is null. (Old shape
  // gated on type; new shape doesn't need to.)
  expect(
    backendCoordsSeg({
      backend_exec_type: null,
      backend_exec_session_id: "ada",
      backend_exec_pane_id: "11",
      backend_exec_tab_id: "3",
      backend_exec_tab_name: "main",
    }),
  ).toBe("[main p11]");
});

test("backendCoordsSeg: pill is bracketed so colorizePillsInLine can route it", () => {
  // The whole point of moving from ` · <type> <session>/<tab> p<pane>` to
  // `[<tab> p<pane>]` is to put the segment inside the pill grid — the
  // colorizer's bracket-scoped regex now sees it as a candidate token.
  // (Whether it actually tints depends on `PILL_COLORS` entries; the
  // shape contract is just that it's bracketed.)
  const pill = backendCoordsSeg({
    backend_exec_type: "zellij",
    backend_exec_session_id: "ada",
    backend_exec_pane_id: "11",
    backend_exec_tab_name: "main",
  });
  expect(pill.startsWith("[")).toBe(true);
  expect(pill.endsWith("]")).toBe(true);
  // And the colorizer's pill regex matches against it (round-trips
  // unchanged because there's no PILL_COLORS bucket yet, but the
  // matcher doesn't crash on the input).
  expect(colorizePillsInLine(pill)).toBe(pill);
});

// ---------------------------------------------------------------------------
// renderJobsBody — sections by `backend_exec_session_id` in first-seen
// order, each introduced by `--- <session> ---` (or `--- (no session) ---`
// for jobs with null/empty session id). A section drops entirely when
// it has no rows. Within a section we preserve wire order.
// ---------------------------------------------------------------------------

test("renderJobsBody: empty jobs map → empty string", () => {
  expect(
    renderJobsBody(new Map(), new Map<string, SubagentInvocation[]>()),
  ).toBe("");
});

test("renderJobsBody: single session with one job → one section, one row", () => {
  const jobs = new Map<string, unknown>([
    [
      "j1",
      {
        job_id: "j1",
        cwd: "/repo/x",
        title: "ambient",
        plan_verb: null,
        state: "working",
        backend_exec_session_id: "ada",
      },
    ],
  ]);
  const body = renderJobsBody(jobs, new Map());
  expect(body).toBe(["--- ada ---", "(x) ambient [working]"].join("\n"));
});

test("renderJobsBody: jobs with null session collect under '--- (no session) ---'", () => {
  const jobs = new Map<string, unknown>([
    [
      "j1",
      {
        job_id: "j1",
        cwd: "/repo/x",
        title: "ambient",
        plan_verb: null,
        state: "working",
        // No backend_exec_session_id at all.
      },
    ],
  ]);
  const body = renderJobsBody(jobs, new Map());
  expect(body).toBe(
    ["--- (no session) ---", "(x) ambient [working]"].join("\n"),
  );
});

test("renderJobsBody: multiple sessions render in first-seen wire order", () => {
  // Wire order: session-b first (one job), then session-a (one job).
  // Sections must appear in that order — first-seen — independent of
  // any alphabetical sort.
  const jobs = new Map<string, unknown>([
    [
      "j-b",
      {
        job_id: "j-b",
        cwd: "/repo/b",
        title: "b-job",
        plan_verb: null,
        state: "working",
        backend_exec_session_id: "session-b",
      },
    ],
    [
      "j-a",
      {
        job_id: "j-a",
        cwd: "/repo/a",
        title: "a-job",
        plan_verb: "work",
        state: "stopped",
        backend_exec_session_id: "session-a",
      },
    ],
  ]);
  const body = renderJobsBody(jobs, new Map());
  expect(body).toBe(
    [
      "--- session-b ---",
      "(b) b-job [working]",
      "--- session-a ---",
      "(a) a-job [worker] [stopped]",
    ].join("\n"),
  );
});

test("renderJobsBody: jobs in the same session group together preserving wire order", () => {
  const jobs = new Map<string, unknown>([
    [
      "j1",
      {
        job_id: "j1",
        cwd: "/repo/a",
        title: "first",
        plan_verb: null,
        state: "working",
        backend_exec_session_id: "ada",
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
        backend_exec_session_id: "ada",
      },
    ],
  ]);
  const body = renderJobsBody(jobs, new Map());
  expect(body).toBe(
    ["--- ada ---", "(a) first [working]", "(b) second [working]"].join("\n"),
  );
});

test("renderJobsBody: interleaved sessions split into per-session sections, in first-seen order", () => {
  // Wire order interleaves session-a / session-b / session-a — sections
  // emit in first-seen order (a, then b) with wire order preserved
  // within each section.
  const jobs = new Map<string, unknown>([
    [
      "ja1",
      {
        job_id: "ja1",
        cwd: "/r/a1",
        title: "a-first",
        plan_verb: null,
        state: "working",
        backend_exec_session_id: "session-a",
      },
    ],
    [
      "jb1",
      {
        job_id: "jb1",
        cwd: "/r/b1",
        title: "b-first",
        plan_verb: "work",
        state: "stopped",
        backend_exec_session_id: "session-b",
      },
    ],
    [
      "ja2",
      {
        job_id: "ja2",
        cwd: "/r/a2",
        title: "a-second",
        plan_verb: null,
        state: "working",
        backend_exec_session_id: "session-a",
      },
    ],
  ]);
  const body = renderJobsBody(jobs, new Map());
  expect(body).toBe(
    [
      "--- session-a ---",
      "(a1) a-first [working]",
      "(a2) a-second [working]",
      "--- session-b ---",
      "(b1) b-first [worker] [stopped]",
    ].join("\n"),
  );
});

// ---------------------------------------------------------------------------
// renderJobsBody: collapse-controlled lines — sub-agent lines AND the
// backend-coords pill. Both render only when the job is in
// `render.expanded`. The pill renders BEFORE sub-agent lines inside the
// expanded region. The `[awaiting:<kind>]` continuation line stays
// always-visible (it's emitted by `projectJobRow`).
// ---------------------------------------------------------------------------

test("renderJobsBody: backend pill is hidden by default (collapse-controlled)", () => {
  const jobs = new Map<string, unknown>([
    [
      "j1",
      {
        job_id: "j1",
        cwd: "/repo/x",
        title: "live",
        plan_verb: null,
        state: "working",
        backend_exec_session_id: "ada",
        backend_exec_pane_id: "11",
        backend_exec_tab_name: "main",
      },
    ],
  ]);
  const body = renderJobsBody(jobs, new Map());
  // No render opts → nothing in `expanded` → the pill stays hidden.
  expect(body).toBe(["--- ada ---", "(x) live [working]"].join("\n"));
  expect(body).not.toContain("[main");
});

test("renderJobsBody: expanding a job reveals the backend pill (no sub-agents present)", () => {
  const jobs = new Map<string, unknown>([
    [
      "j1",
      {
        job_id: "j1",
        cwd: "/repo/x",
        title: "live",
        plan_verb: null,
        state: "working",
        backend_exec_session_id: "ada",
        backend_exec_pane_id: "11",
        backend_exec_tab_name: "main",
      },
    ],
  ]);
  const body = renderJobsBody(jobs, new Map(), {
    insertMode: false,
    selectedIndex: 0,
    expanded: new Set(["j1"]),
  });
  expect(body).toBe(
    ["--- ada ---", "(x) live [working]", "  [main p11]"].join("\n"),
  );
});

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
        backend_exec_session_id: "ada",
        backend_exec_pane_id: "11",
        backend_exec_tab_name: "main",
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
  expect(body).toBe(["--- ada ---", "(x) ambient [working]"].join("\n"));
  expect(body).not.toContain("general-purpose");
});

test("renderJobsBody: expanding shows backend pill BEFORE sub-agent lines", () => {
  const { jobs, subagentIndex } = ambWithSub();
  const body = renderJobsBody(jobs, subagentIndex, {
    insertMode: false,
    selectedIndex: 0,
    expanded: new Set(["j-amb"]),
  });
  expect(body).toBe(
    [
      "--- ada ---",
      "(x) ambient [working]",
      "  [main p11]", // backend pill — rendered before sub-agent lines
      "  general-purpose: investigate [running]",
    ].join("\n"),
  );
});

test("renderJobsBody: awaiting line stays always-visible (NOT collapse-controlled)", () => {
  // A collapsed job still shows its `[awaiting:<kind>]` continuation —
  // it's an attention signal the human needs to see at a glance.
  const jobs = new Map<string, unknown>([
    [
      "j1",
      {
        job_id: "j1",
        cwd: "/repo/x",
        title: "asking",
        plan_verb: "work",
        state: "stopped",
        backend_exec_session_id: "ada",
        backend_exec_pane_id: "11",
        backend_exec_tab_name: "main",
        last_input_request_at: 999,
        last_input_request_kind: "ask_user_question",
      },
    ],
  ]);
  // No expansion → awaiting line visible, backend pill hidden.
  const body = renderJobsBody(jobs, new Map());
  expect(body).toBe(
    [
      "--- ada ---",
      "(x) asking [worker] [stopped]",
      "  [awaiting:ask_user_question]",
    ].join("\n"),
  );
});

// ---------------------------------------------------------------------------
// selectableJobIds — the render-order list insert-mode selection walks.
// Sections concatenated in first-seen `backend_exec_session_id` order,
// each section's jobs in wire order. Shared with `renderJobsBody` so the
// two never disagree on ordering.
// ---------------------------------------------------------------------------

test("selectableJobIds: jobs grouped by session in first-seen order, wire order within each", () => {
  // Wire order interleaves session-a / session-b / session-a / null →
  // the result is [a-jobs..., b-jobs..., null-jobs...] each in wire order.
  const jobs = new Map<string, unknown>([
    ["a1", { job_id: "a1", backend_exec_session_id: "session-a" }],
    ["b1", { job_id: "b1", backend_exec_session_id: "session-b" }],
    ["a2", { job_id: "a2", backend_exec_session_id: "session-a" }],
    ["n1", { job_id: "n1", backend_exec_session_id: null }],
  ]);
  expect(selectableJobIds(jobs)).toEqual(["a1", "a2", "b1", "n1"]);
});

test("selectableJobIds: empty session id collects under (no session) bucket", () => {
  // Empty-string session id is treated the same as null — both land in
  // the (no session) bucket.
  const jobs = new Map<string, unknown>([
    ["e1", { job_id: "e1", backend_exec_session_id: "" }],
    ["a1", { job_id: "a1", backend_exec_session_id: "session-a" }],
  ]);
  // First-seen-section order: the (no session) bucket appears first
  // because it was opened first.
  expect(selectableJobIds(jobs)).toEqual(["e1", "a1"]);
});

// ---------------------------------------------------------------------------
// renderJobsBody insert-mode decoration: a 2-space base indent on
// headings and child/continuation lines, a disclosure triangle on EVERY
// job row (not just rows with children — the backend pill is itself
// collapse-controlled, so every row has something the caret discloses),
// and a full-width selection highlight on the selected row. The selected
// row carries no `> ` marker — instead its HEAD line is prefixed with
// SELECTED_LINE_PREFIX (the view-shell turns that into a background
// highlight). Nerd Font glyphs: caret-right (collapsed) / caret-down
// (expanded).
// ---------------------------------------------------------------------------

const TRI_RIGHT = ""; // GLYPH_COLLAPSED
const TRI_DOWN = ""; // GLYPH_EXPANDED

test("renderJobsBody insert mode: every job row gets a caret (even with no children)", () => {
  // j1 has no sub-agents and no backend pill — but the caret still
  // appears, because the row is collapse-toggleable in principle (any
  // row could have collapse-controlled content). This is the spec
  // change vs. the old `hasChildren` gating.
  const jobs = new Map<string, unknown>([
    [
      "j1",
      {
        job_id: "j1",
        cwd: "/repo/a",
        title: "first",
        plan_verb: null,
        state: "working",
        backend_exec_session_id: "ada",
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
        backend_exec_session_id: "ada",
      },
    ],
  ]);
  const body = renderJobsBody(jobs, new Map(), {
    insertMode: true,
    selectedIndex: 0,
    expanded: new Set(),
  });
  // Both rows get a caret-right (collapsed) — even though neither has
  // children. The selected row also gets SELECTED_LINE_PREFIX.
  expect(body).toBe(
    [
      "  --- ada ---",
      `${SELECTED_LINE_PREFIX}${TRI_RIGHT} (a) first [working]`,
      `${TRI_RIGHT} (b) second [working]`,
    ].join("\n"),
  );
});

test("renderJobsBody insert mode: selected + expanded → down-triangle, backend pill + child revealed", () => {
  const jobs = new Map<string, unknown>([
    [
      "j1",
      {
        job_id: "j1",
        cwd: "/repo/a",
        title: "first",
        plan_verb: null,
        state: "working",
        backend_exec_session_id: "ada",
        backend_exec_pane_id: "11",
        backend_exec_tab_name: "main",
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
      "  --- ada ---",
      `${SELECTED_LINE_PREFIX}${TRI_DOWN} (a) first [working]`,
      "    [main p11]", // backend pill: 2 base + its own 2
      // fn-708: subagent status=ok now omits the pill (absence ≡ ok).
      "    scout: d", // sub-agent line: 2 base + its own 2
    ].join("\n"),
  );
});

test("renderJobsBody insert mode: out-of-range selectedIndex clamps to last row", () => {
  const jobs = new Map<string, unknown>([
    [
      "j1",
      {
        job_id: "j1",
        cwd: "/repo/a",
        title: "first",
        plan_verb: null,
        state: "working",
        backend_exec_session_id: "ada",
      },
    ],
  ]);
  // selectedIndex past the end clamps to the last row, which gets the prefix.
  const body = renderJobsBody(jobs, new Map(), {
    insertMode: true,
    selectedIndex: 99,
    expanded: new Set(),
  });
  expect(body).toBe(
    [
      "  --- ada ---",
      // Caret always present in insert mode now (no `hasChildren` gate).
      `${SELECTED_LINE_PREFIX}${TRI_RIGHT} (a) first [working]`,
    ].join("\n"),
  );
});

test("renderJobsBody insert mode: selectedIndex marks by selectableJobIds order, not raw Map order", () => {
  // Wire-order Map: a1, b1, a2, b2 (interleaved sessions). selectableJobIds
  // groups by session in first-seen order → [a1, a2, b1, b2].
  // selectedIndex 1 picks a2 (the SECOND job in session-a, not the
  // raw-index-1 row b1).
  const mk = (id: string, sessionId: string, title: string) => ({
    job_id: id,
    cwd: `/r/${id.toLowerCase()}`,
    title,
    plan_verb: null,
    state: "working",
    backend_exec_session_id: sessionId,
  });
  const jobs = new Map<string, unknown>([
    ["a1", mk("a1", "session-a", "a-first")],
    ["b1", mk("b1", "session-b", "b-first")],
    ["a2", mk("a2", "session-a", "a-second")],
    ["b2", mk("b2", "session-b", "b-second")],
  ]);
  const body = renderJobsBody(jobs, new Map(), {
    insertMode: true,
    selectedIndex: 1,
    expanded: new Set(),
  });
  const marked = body
    .split("\n")
    .find((l) => l.startsWith(SELECTED_LINE_PREFIX));
  // The highlight must land on a-second (a2), not b-first (the raw-index-1 row).
  expect(marked).toBe(
    `${SELECTED_LINE_PREFIX}${TRI_RIGHT} (a2) a-second [working]`,
  );
  // And exactly one row is selection-prefixed.
  expect(
    body.split("\n").filter((l) => l.startsWith(SELECTED_LINE_PREFIX)).length,
  ).toBe(1);
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

// ---------------------------------------------------------------------------
// monitorLinesFor — schema v51 / fn-682 per-job live-monitors rendering.
// Pure JSON-parse with `[]` fallback; renders `[<kind>] <label>[ [<status>]]`
// per entry. `label` prefers `command`, falls back to `description`, falls
// back to `id`. A multi-line `command` truncates to its first non-empty line.
// Today's task-1 projection ships only `{id, kind}` so most production rows
// render with `id` as the label, but the helper is built to render the
// future enrichment correctly the moment the projection grows.
// ---------------------------------------------------------------------------

test("monitorLinesFor: id-only projection (task-1 shape) renders [kind] <id> per entry", () => {
  const json = JSON.stringify([
    { id: "b5217wols", kind: "ambient" },
    { id: "bnamgymkh", kind: "monitor" },
    { id: "bt25vb1eo", kind: "bash-bg" },
  ]);
  expect(monitorLinesFor(json, "  ")).toEqual([
    "  [ambient] b5217wols",
    "  [monitor] bnamgymkh",
    "  [bash-bg] bt25vb1eo",
  ]);
});

test("monitorLinesFor: empty / missing / malformed JSON → no lines", () => {
  expect(monitorLinesFor("[]", "  ")).toEqual([]);
  expect(monitorLinesFor("", "  ")).toEqual([]);
  expect(monitorLinesFor(null, "  ")).toEqual([]);
  expect(monitorLinesFor(undefined, "  ")).toEqual([]);
  // JSON parse failure does NOT throw.
  expect(monitorLinesFor("{not json", "  ")).toEqual([]);
  // Non-array JSON folds to no lines.
  expect(monitorLinesFor('"a string"', "  ")).toEqual([]);
  expect(monitorLinesFor('{"id":"x","kind":"ambient"}', "  ")).toEqual([]);
});

test("monitorLinesFor: future-enriched entry — command preferred over description over id", () => {
  // Future projection shape: the deriver lifts command/description/status
  // off the raw event payload alongside id+kind. The helper renders the
  // richest available label without needing a separate code path.
  const json = JSON.stringify([
    {
      id: "b1",
      kind: "ambient",
      command: "chatctl watch-chat",
      description: "chatctl bus",
      status: "running",
    },
  ]);
  expect(monitorLinesFor(json, "  ")).toEqual([
    "  [ambient] chatctl watch-chat [running]",
  ]);
});

test("monitorLinesFor: empty command falls back to description (per spec)", () => {
  const json = JSON.stringify([
    {
      id: "b1",
      kind: "monitor",
      command: "",
      description: "chatctl bus",
      status: "running",
    },
  ]);
  expect(monitorLinesFor(json, "  ")).toEqual([
    "  [monitor] chatctl bus [running]",
  ]);
});

test("monitorLinesFor: missing command + missing description falls back to id", () => {
  const json = JSON.stringify([{ id: "abc123", kind: "ambient" }]);
  expect(monitorLinesFor(json, "  ")).toEqual(["  [ambient] abc123"]);
});

test("monitorLinesFor: multi-line command truncates to FIRST non-empty line", () => {
  // The risk: a 1KB+ heredoc would wreck the row. The helper collapses
  // a multi-line command to its first non-empty line so the row stays
  // one terminal-line tall. Leading-blank-line case covered too.
  const heredoc = "\n\n  cat <<'EOF'\nfirst body line\nsecond body line\nEOF";
  const json = JSON.stringify([
    { id: "b1", kind: "bash-bg", command: heredoc, status: "running" },
  ]);
  expect(monitorLinesFor(json, "  ")).toEqual([
    "  [bash-bg]   cat <<'EOF' [running]",
  ]);
});

test("monitorLinesFor: missing / empty status drops the trailing [status] slot", () => {
  const json = JSON.stringify([
    { id: "b1", kind: "ambient", command: "chatctl watch-chat" },
    { id: "b2", kind: "ambient", command: "echo hi", status: "" },
  ]);
  expect(monitorLinesFor(json, "  ")).toEqual([
    "  [ambient] chatctl watch-chat",
    "  [ambient] echo hi",
  ]);
});

test("monitorLinesFor: malformed entries (null / non-object) skip silently", () => {
  const json = JSON.stringify([
    null,
    "string-entry",
    { id: "ok", kind: "ambient" },
  ]);
  expect(monitorLinesFor(json, "  ")).toEqual(["  [ambient] ok"]);
});

test("monitorLinesFor: missing kind defaults to ambient (defensive)", () => {
  const json = JSON.stringify([{ id: "x" }]);
  expect(monitorLinesFor(json, "  ")).toEqual(["  [ambient] x"]);
});

test("renderJobsBody: expanded job renders monitors BETWEEN backend pill and sub-agents", () => {
  // Wire order inside the collapse-controlled region:
  //   backendCoordsSeg → monitors → subagentLinesFor
  const { subagentIndex } = ambWithSub();
  const jobs = new Map<string, unknown>([
    [
      "j-amb",
      {
        job_id: "j-amb",
        cwd: "/repo/x",
        title: "ambient",
        plan_verb: null,
        state: "working",
        backend_exec_session_id: "ada",
        backend_exec_pane_id: "11",
        backend_exec_tab_name: "main",
        monitors: JSON.stringify([
          { id: "b5217wols", kind: "ambient" },
          { id: "bnamgymkh", kind: "monitor" },
        ]),
      },
    ],
  ]);
  const body = renderJobsBody(jobs, subagentIndex, {
    insertMode: false,
    selectedIndex: 0,
    expanded: new Set(["j-amb"]),
  });
  expect(body).toBe(
    [
      "--- ada ---",
      "(x) ambient [working]",
      "  [main p11]",
      "  [ambient] b5217wols",
      "  [monitor] bnamgymkh",
      "  general-purpose: investigate [running]",
    ].join("\n"),
  );
});

test("renderJobsBody: monitors are collapse-by-default (hidden when not expanded)", () => {
  const jobs = new Map<string, unknown>([
    [
      "j1",
      {
        job_id: "j1",
        cwd: "/repo/x",
        title: "ambient",
        plan_verb: null,
        state: "working",
        backend_exec_session_id: "ada",
        monitors: JSON.stringify([{ id: "b1", kind: "ambient" }]),
      },
    ],
  ]);
  const body = renderJobsBody(jobs, new Map());
  expect(body).toBe(["--- ada ---", "(x) ambient [working]"].join("\n"));
  expect(body).not.toContain("[ambient] b1");
});

test("renderJobsBody: empty / missing monitors blob renders no Monitors section", () => {
  // Three flavors — '[]', '', and the column absent entirely — all produce
  // zero monitor lines but the rest of the expanded region renders normally.
  for (const monitors of ["[]", "", undefined]) {
    const jobs = new Map<string, unknown>([
      [
        "j1",
        {
          job_id: "j1",
          cwd: "/repo/x",
          title: "ambient",
          plan_verb: null,
          state: "working",
          backend_exec_session_id: "ada",
          backend_exec_pane_id: "11",
          backend_exec_tab_name: "main",
          monitors,
        },
      ],
    ]);
    const body = renderJobsBody(jobs, new Map(), {
      insertMode: false,
      selectedIndex: 0,
      expanded: new Set(["j1"]),
    });
    expect(body).toBe(
      ["--- ada ---", "(x) ambient [working]", "  [main p11]"].join("\n"),
    );
  }
});

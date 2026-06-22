/**
 * Pure view-model tests for `src/dash/view-model.ts` and `src/dash/theme.ts`.
 * Table-driven over hand-built jobs — no subprocess, no `sandboxEnv`, no
 * `@opentui` import anywhere (the property that keeps this file on the fast
 * tier). Asserts the SETTLED robot-card semantics: the six-rung status ladder
 * (each rung → its dash-local robot codepoint + rail role; annotations outrank
 * base state), band assignment (needs-you/in-motion/idle), stable intra-band
 * `created_at` sort, the `showTerminal` toggle gating,
 * per-field projection (project basename, never-blank label, role label,
 * running-subagent count, age, session coords), ESC sanitization, and the
 * never-throw fold on a malformed `state`. Also asserts the shared `fa-classic`
 * board/jobs glyph map is UNCHANGED (the dash robot map is dash-local).
 */

import { expect, test } from "bun:test";
import {
  colorForRail,
  colorForRole,
  RAIL_COLORS,
  type RailRole,
  ROLE_COLORS,
} from "../src/dash/theme";
import {
  type Band,
  type BandKey,
  buildDashModel,
  type CardVM,
  type DashModel,
  type RobotRung,
  robotGlyph,
  robotRung,
} from "../src/dash/view-model";
import { FA_CLASSIC, glyphForToken } from "../src/icon-theme";
import type { Job, SubagentInvocation } from "../src/types";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    job_id: "session-1",
    created_at: 0,
    cwd: "/repo",
    pid: null,
    state: "working",
    last_event_id: 0,
    updated_at: 0,
    title: null,
    title_source: null,
    transcript_path: null,
    start_time: null,
    plan_verb: "work",
    plan_ref: "fn-1-foo.1",
    epic_links: [],
    last_api_error_at: null,
    last_api_error_kind: null,
    last_input_request_at: null,
    last_input_request_kind: null,
    last_permission_prompt_at: null,
    last_permission_prompt_kind: null,
    active_since: null,
    config_dir: null,
    git_dirty_count: 0,
    git_unattributed_to_live_count: 0,
    git_orphan_count: 0,
    backend_exec_type: null,
    backend_exec_session_id: null,
    backend_exec_pane_id: null,
    monitors: null,
    ...overrides,
  };
}

function makeSub(
  overrides: Partial<SubagentInvocation> = {},
): SubagentInvocation {
  return {
    job_id: "session-1",
    agent_id: "a1",
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
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1000;

function jobsMap(jobs: Job[]): Map<string, Job> {
  return new Map(jobs.map((j) => [j.job_id, j]));
}

function build(
  jobs: Job[],
  opts: {
    subagents?: SubagentInvocation[];
    showTerminal?: boolean;
    nowSec?: number;
  } = {},
): DashModel {
  return buildDashModel(
    jobsMap(jobs),
    opts.subagents ?? [],
    opts.showTerminal ?? false,
    opts.nowSec ?? NOW,
  );
}

function band(model: DashModel, key: BandKey): Band {
  const b = model.bands.find((x) => x.key === key);
  expect(b).toBeDefined();
  return b as Band;
}

function cardKeys(model: DashModel, key: BandKey): string[] {
  return band(model, key).cards.map((c) => c.key);
}

/** The single card in a one-job model (asserts exactly one across all bands). */
function onlyCard(model: DashModel): CardVM {
  const all = model.bands.flatMap((b) => b.cards);
  expect(all).toHaveLength(1);
  return all[0] as CardVM;
}

// The dash-local robot codepoints, materialized the same way the model does.
const ROBOT: Record<RobotRung, string> = {
  error: String.fromCodePoint(0xf169d),
  awaiting: String.fromCodePoint(0xf169f),
  working: String.fromCodePoint(0xf06a9),
  ended: String.fromCodePoint(0xf1719),
  stopped: String.fromCodePoint(0xf167a),
  killed: String.fromCodePoint(0xf16a1),
};

// ---------------------------------------------------------------------------
// theme.ts — rail roles
// ---------------------------------------------------------------------------

test("theme: rail roles map to plain descriptors (index/dim only, no RGBA)", () => {
  const roles = [
    "error",
    "awaiting",
    "working",
    "idle-ended",
    "idle-stopped",
    "idle-killed",
  ] as const;
  for (const role of roles) {
    const d = colorForRail(role);
    for (const k of Object.keys(d)) {
      expect(["index", "dim", "bold"]).toContain(k);
    }
    expect(Number.isInteger(d.index)).toBe(true);
  }
  // The three idle/terminal rungs carry dim; the attention rungs do not. The
  // lightness-distinct attention indices (1/3/12) survive grayscale.
  expect(RAIL_COLORS.error.index).toBe(1);
  expect(RAIL_COLORS.awaiting.index).toBe(3);
  expect(RAIL_COLORS.working.index).toBe(12);
  expect(RAIL_COLORS["idle-ended"]).toEqual({ index: 2, dim: true });
  expect(RAIL_COLORS["idle-stopped"]).toEqual({ index: 7, dim: true });
  expect(RAIL_COLORS["idle-killed"]).toEqual({ index: 1, dim: true });
  expect(RAIL_COLORS.working.dim).toBeUndefined();
});

test("theme: the legacy text ROLE_COLORS map is untouched", () => {
  // The dash card view forks a NEW rail map; the board/jobs text roles stay.
  expect(colorForRole("motion")).toEqual({ index: 12 });
  expect(ROLE_COLORS.terminal).toEqual({ index: 7, dim: true });
  expect(ROLE_COLORS.heading).toEqual({ bold: true });
});

// ---------------------------------------------------------------------------
// Status ladder
// ---------------------------------------------------------------------------

test("ladder: each base state resolves to its robot codepoint + rail role", () => {
  const cases: [Partial<Job>, RobotRung, RailRole][] = [
    [{ state: "working" }, "working", "working"],
    [{ state: "ended" }, "ended", "idle-ended"],
    [{ state: "stopped" }, "stopped", "idle-stopped"],
    [{ state: "killed" }, "killed", "idle-killed"],
  ];
  for (const [override, rung, rail] of cases) {
    const job = makeJob({ job_id: "j", ...override });
    expect(robotRung(job)).toBe(rung);
    const card = onlyCard(build([job], { showTerminal: true }));
    expect(card.robotGlyph).toBe(ROBOT[rung]);
    expect(card.railRole).toBe(rail);
    expect(card.statusWord).toBe(rung);
  }
});

test("ladder: robotGlyph resolver matches the materialized codepoints", () => {
  expect(robotGlyph("error")).toBe(ROBOT.error);
  expect(robotGlyph("awaiting")).toBe(ROBOT.awaiting);
  expect(robotGlyph("working")).toBe(ROBOT.working);
  expect(robotGlyph("ended")).toBe(ROBOT.ended);
  expect(robotGlyph("stopped")).toBe(ROBOT.stopped);
  expect(robotGlyph("killed")).toBe(ROBOT.killed);
});

test("ladder: api-error outranks live base states (priority 1, red rail)", () => {
  // Live (non-terminal) states only — terminal ended/killed now win over a
  // stale annotation stamp (see the terminal-state-wins ladder below).
  for (const state of ["working", "stopped"]) {
    const job = makeJob({ job_id: "j", state, last_api_error_at: 5 });
    expect(robotRung(job)).toBe("error");
    const card = onlyCard(build([job], { showTerminal: true }));
    expect(card.robotGlyph).toBe(ROBOT.error);
    expect(card.railRole).toBe("error");
  }
});

test("ladder: terminal state wins over a stale annotation stamp", () => {
  // The reducer's SessionEnd/Killed transitions never clear last_*_at, so a job
  // that died mid-block keeps its stamp. The dash must still paint it terminal
  // (idle band, hidden unless showTerminal) rather than pin it in needs-you.
  const stamps: Partial<Job>[] = [
    { last_api_error_at: 5 },
    { last_permission_prompt_at: 5 },
    { last_input_request_at: 5 },
  ];
  for (const [state, rung, role] of [
    ["ended", "ended", "idle-ended"],
    ["killed", "killed", "idle-killed"],
  ] as const) {
    for (const stamp of stamps) {
      const job = makeJob({ job_id: "j", state, ...stamp });
      expect(robotRung(job)).toBe(rung);

      // Lands in idle (terminal), not needs-you, when shown.
      const shown = build([job], { showTerminal: true });
      expect(cardKeys(shown, "idle")).toEqual(["job:j"]);
      const card = onlyCard(shown);
      expect(card.robotGlyph).toBe(ROBOT[rung]);
      expect(card.railRole).toBe(role);

      // Hidden entirely when showTerminal is off — a stale stamp no longer
      // keeps a dead job permanently demanding attention.
      const hidden = build([job], { showTerminal: false });
      expect(hidden.bands.flatMap((b) => b.cards)).toHaveLength(0);
    }
  }
});

test("ladder: awaiting (permission OR input) outranks working (priority 2)", () => {
  // working + a permission prompt → confused/yellow, not robot/blue.
  const perm = makeJob({
    job_id: "j",
    state: "working",
    last_permission_prompt_at: 5,
  });
  expect(robotRung(perm)).toBe("awaiting");
  expect(onlyCard(build([perm])).railRole).toBe("awaiting");

  const input = makeJob({
    job_id: "j",
    state: "working",
    last_input_request_at: 5,
  });
  expect(robotRung(input)).toBe("awaiting");
  expect(onlyCard(build([input])).robotGlyph).toBe(ROBOT.awaiting);
});

test("ladder: api-error outranks awaiting (priority 1 over 2)", () => {
  const job = makeJob({
    job_id: "j",
    state: "working",
    last_api_error_at: 9,
    last_permission_prompt_at: 5,
    last_input_request_at: 5,
  });
  expect(robotRung(job)).toBe("error");
});

test("ladder: a malformed/unknown state folds to stopped — never throws", () => {
  for (const state of ["", "garbage", "WORKING", "paused"]) {
    const job = makeJob({ job_id: "j", state });
    expect(() => robotRung(job)).not.toThrow();
    expect(robotRung(job)).toBe("stopped");
    const card = onlyCard(build([job]));
    expect(card.robotGlyph).toBe(ROBOT.stopped);
    expect(card.railRole).toBe("idle-stopped");
  }
});

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

test("bands: model emits the three bands in render order, even when empty", () => {
  const m = build([]);
  expect(m.bands.map((b) => b.key)).toEqual(["needs-you", "in-motion", "idle"]);
  // Every band carries an empty card array — never undefined.
  for (const b of m.bands) {
    expect(b.cards).toEqual([]);
  }
});

test("bands: each rung sorts into its urgency band", () => {
  const jobs = [
    makeJob({ job_id: "err", state: "working", last_api_error_at: 1 }),
    makeJob({ job_id: "ask", state: "stopped", last_input_request_at: 1 }),
    makeJob({ job_id: "work", state: "working" }),
    makeJob({ job_id: "idle", state: "stopped" }),
  ];
  const m = build(jobs);
  expect(cardKeys(m, "needs-you").sort()).toEqual(["job:ask", "job:err"]);
  expect(cardKeys(m, "in-motion")).toEqual(["job:work"]);
  expect(cardKeys(m, "idle")).toEqual(["job:idle"]);
});

test("bands: ended/killed land in the idle band when shown", () => {
  const jobs = [
    makeJob({ job_id: "done", state: "ended" }),
    makeJob({ job_id: "dead", state: "killed" }),
    makeJob({ job_id: "off", state: "stopped" }),
  ];
  const m = build(jobs, { showTerminal: true });
  expect(cardKeys(m, "idle").sort()).toEqual([
    "job:dead",
    "job:done",
    "job:off",
  ]);
});

// ---------------------------------------------------------------------------
// Intra-band sort
// ---------------------------------------------------------------------------

test("sort: stable created_at ASC within a band, job_id ASC tiebreak", () => {
  const jobs = [
    makeJob({ job_id: "c", state: "stopped", created_at: 30 }),
    makeJob({ job_id: "a", state: "stopped", created_at: 10 }),
    // Two equal created_at → job_id ASC (eq-a before eq-b).
    makeJob({ job_id: "eq-b", state: "stopped", created_at: 20 }),
    makeJob({ job_id: "eq-a", state: "stopped", created_at: 20 }),
  ];
  const m = build(jobs);
  expect(cardKeys(m, "idle")).toEqual([
    "job:a",
    "job:eq-a",
    "job:eq-b",
    "job:c",
  ]);
});

test("sort: order is independent of input map insertion order", () => {
  const m = build([
    makeJob({ job_id: "z", state: "working", created_at: 99 }),
    makeJob({ job_id: "y", state: "working", created_at: 1 }),
  ]);
  // created_at ASC → y (1) before z (99) regardless of insertion order.
  expect(cardKeys(m, "in-motion")).toEqual(["job:y", "job:z"]);
});

// ---------------------------------------------------------------------------
// Toggle gating
// ---------------------------------------------------------------------------

test("toggle: showTerminal=false hides ended/killed (default)", () => {
  const jobs = [
    makeJob({ job_id: "done", state: "ended" }),
    makeJob({ job_id: "dead", state: "killed" }),
    makeJob({ job_id: "off", state: "stopped" }),
  ];
  const m = build(jobs, { showTerminal: false });
  // Only the non-terminal stopped card survives.
  expect(m.bands.flatMap((b) => b.cards).map((c) => c.key)).toEqual([
    "job:off",
  ]);
  expect(cardKeys(m, "idle")).toEqual(["job:off"]);
});

test("toggle: showTerminal=true reveals the happy/dead robots", () => {
  const jobs = [
    makeJob({ job_id: "done", state: "ended" }),
    makeJob({ job_id: "dead", state: "killed" }),
  ];
  const m = build(jobs, { showTerminal: true });
  const cards = band(m, "idle").cards;
  const done = cards.find((c) => c.key === "job:done");
  const dead = cards.find((c) => c.key === "job:dead");
  expect(done?.robotGlyph).toBe(ROBOT.ended);
  expect(done?.isTerminal).toBe(true);
  expect(dead?.robotGlyph).toBe(ROBOT.killed);
  expect(dead?.isTerminal).toBe(true);
});

test("toggle: a non-terminal card is never marked isTerminal", () => {
  const m = build([makeJob({ job_id: "j", state: "working" })]);
  expect(onlyCard(m).isTerminal).toBe(false);
});

// ---------------------------------------------------------------------------
// Per-field projection
// ---------------------------------------------------------------------------

test("fields: project is the cwd basename; empty when cwd is blank", () => {
  expect(
    onlyCard(build([makeJob({ job_id: "j", cwd: "/code/keeper" })])).project,
  ).toBe("keeper");
  expect(onlyCard(build([makeJob({ job_id: "j", cwd: "" })])).project).toBe("");
});

test("fields: title coalesces title→plan_ref→job_id (never blank)", () => {
  expect(
    onlyCard(build([makeJob({ job_id: "j", title: "worker A" })])).title,
  ).toBe("worker A");
  expect(
    onlyCard(
      build([makeJob({ job_id: "j", title: null, plan_ref: "fn-3-baz.2" })]),
    ).title,
  ).toBe("fn-3-baz.2");
  expect(
    onlyCard(build([makeJob({ job_id: "j", title: null, plan_ref: null })]))
      .title,
  ).toBe("j");
});

test("fields: roleLabel maps the plan verb to its noun (worker)", () => {
  expect(
    onlyCard(build([makeJob({ job_id: "j", plan_verb: "work" })])).roleLabel,
  ).toBe("worker");
  expect(
    onlyCard(build([makeJob({ job_id: "j", plan_verb: "plan" })])).roleLabel,
  ).toBe("planner");
  // Null plan_verb → empty label, never a crash.
  expect(
    onlyCard(build([makeJob({ job_id: "j", plan_verb: null })])).roleLabel,
  ).toBe("");
});

test("fields: subagentCount groups running subagents per job", () => {
  const jobs = [
    makeJob({ job_id: "a", state: "working" }),
    makeJob({ job_id: "b", state: "working" }),
  ];
  const subs = [
    makeSub({ job_id: "a", agent_id: "a1", status: "running" }),
    makeSub({ job_id: "a", agent_id: "a2", status: "running" }),
    // A non-running invocation does not count.
    makeSub({ job_id: "a", agent_id: "a3", status: "ok" }),
    makeSub({ job_id: "b", agent_id: "b1", status: "running" }),
  ];
  const m = build(jobs, { subagents: subs });
  const a = band(m, "in-motion").cards.find((c) => c.key === "job:a");
  const b = band(m, "in-motion").cards.find((c) => c.key === "job:b");
  expect(a?.subagentCount).toBe(2);
  expect(b?.subagentCount).toBe(1);
});

test("fields: ageLabel from created_at vs nowSec (injected, no Date.now)", () => {
  const at = (created: number) =>
    onlyCard(
      build([makeJob({ job_id: "j", state: "working", created_at: created })], {
        nowSec: 1000,
      }),
    ).ageLabel;
  expect(at(1000)).toBe("0s");
  expect(at(990)).toBe("10s");
  expect(at(1000 - 120)).toBe("2m");
  expect(at(1000 - 7200)).toBe("2h");
  expect(at(1000 - 2 * 86_400)).toBe("2d");
  // A created_at in the future clamps to 0s (never negative).
  expect(at(2000)).toBe("0s");
});

test("fields: sessionLabel from backend coords (session[:pane])", () => {
  expect(
    onlyCard(
      build([
        makeJob({
          job_id: "j",
          backend_exec_session_id: "sess",
          backend_exec_pane_id: "%3",
        }),
      ]),
    ).sessionLabel,
  ).toBe("sess:%3");
  expect(
    onlyCard(
      build([
        makeJob({
          job_id: "j",
          backend_exec_session_id: "sess",
          backend_exec_pane_id: null,
        }),
      ]),
    ).sessionLabel,
  ).toBe("sess");
  expect(
    onlyCard(
      build([
        makeJob({
          job_id: "j",
          backend_exec_session_id: null,
          backend_exec_pane_id: null,
        }),
      ]),
    ).sessionLabel,
  ).toBe("");
});

test("fields: a fresh card is never focused", () => {
  expect(onlyCard(build([makeJob({ job_id: "j" })])).isFocused).toBe(false);
});

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

test("sanitize: ESC stripped from title and project before the model", () => {
  const job = makeJob({
    job_id: "j",
    state: "working",
    title: "good\x1b[31mEVIL",
    cwd: "/code/ke\x1beper",
  });
  const card = onlyCard(build([job]));
  expect(card.title).not.toContain("\x1b");
  expect(card.title).toBe("good[31mEVIL");
  expect(card.project).not.toContain("\x1b");
  expect(card.project).toBe("keeper");
});

// ---------------------------------------------------------------------------
// Never-throw / input shape
// ---------------------------------------------------------------------------

test("input: accepts either a Map or a plain iterable of jobs", () => {
  const arr = [makeJob({ job_id: "j", state: "working" })];
  const fromArray = buildDashModel(arr, [], false, NOW);
  const fromMap = buildDashModel(jobsMap(arr), [], false, NOW);
  expect(fromArray).toEqual(fromMap);
});

test("input: build never throws on an empty / all-malformed job set", () => {
  expect(() => buildDashModel(new Map(), [], false, NOW)).not.toThrow();
  expect(() =>
    buildDashModel([makeJob({ state: "???" })], [], true, NOW),
  ).not.toThrow();
});

// ---------------------------------------------------------------------------
// The dash robot map is dash-local — fa-classic untouched
// ---------------------------------------------------------------------------

test("fa-classic: the shared board/jobs glyph map carries no md-robot codepoints", () => {
  // The dash robots live in a dash-local map; none leaked into FA_CLASSIC.
  const robotGlyphs = new Set(Object.values(ROBOT));
  for (const glyph of Object.values(FA_CLASSIC.exact)) {
    expect(
      robotGlyphs.has(String.fromCodePoint(Number.parseInt(glyph, 16))),
    ).toBe(false);
  }
  // A couple of fa-classic anchors still resolve as before (map unchanged).
  expect(glyphForToken("ready", FA_CLASSIC)).toBeTruthy();
  expect(glyphForToken("running:job-running", FA_CLASSIC)).toBeTruthy();
});

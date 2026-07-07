/**
 * Pure view-model tests for `src/dash/view-model.ts` and `src/dash/theme.ts`.
 * Table-driven over hand-built jobs — no subprocess, no `sandboxEnv`, no
 * `@opentui` import anywhere (the property that keeps this file on the fast
 * tier). Asserts the SETTLED robot-line semantics: the six-rung status ladder
 * (each rung → its dash-local robot codepoint + icon role; annotations outrank
 * base state), band assignment by tmux session (priority order + detached
 * fallback), intra-band sort by live tmux `window_index` (known ASC, unknown to
 * tail, then `created_at`/`job_id`), the `showTerminal` toggle
 * gating, per-field projection (project basename, never-blank label), ESC
 * sanitization, and the never-throw fold on a malformed `state`. Also asserts
 * the shared `fa-classic` board/jobs glyph map is UNCHANGED (the dash robot map
 * is dash-local).
 */

import { expect, test } from "bun:test";
import {
  colorForIcon,
  colorForRole,
  ICON_COLORS,
  type IconRole,
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
import type { Job } from "../src/types";

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
    backend_exec_birth_session_id: null,
    backend_exec_pane_id: null,
    monitors: null,
    window_index: null,
    worktree: null,
    current_model_id: null,
    current_model_display: null,
    current_effort: null,
    context_used_percentage: null,
    context_input_tokens: null,
    context_window_size: null,
    dispatch_origin: null,
    escalation_instance: null,
    harness: null,
    resume_target: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jobsMap(jobs: Job[]): Map<string, Job> {
  return new Map(jobs.map((j) => [j.job_id, j]));
}

function build(jobs: Job[], opts: { showTerminal?: boolean } = {}): DashModel {
  return buildDashModel(jobsMap(jobs), opts.showTerminal ?? false);
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
// theme.ts — icon roles
// ---------------------------------------------------------------------------

test("theme: icon roles map to plain descriptors (index/dim only, no RGBA)", () => {
  const roles = [
    "error",
    "awaiting",
    "working",
    "idle-ended",
    "idle-stopped",
    "idle-killed",
  ] as const;
  for (const role of roles) {
    const d = colorForIcon(role);
    for (const k of Object.keys(d)) {
      expect(["index", "dim", "bold"]).toContain(k);
    }
    expect(Number.isInteger(d.index)).toBe(true);
  }
  // The three idle/terminal rungs carry dim; the attention rungs do not. The
  // lightness-distinct attention indices (1/3/12) survive grayscale.
  expect(ICON_COLORS.error.index).toBe(1);
  expect(ICON_COLORS.awaiting.index).toBe(3);
  expect(ICON_COLORS.working.index).toBe(12);
  expect(ICON_COLORS["idle-ended"]).toEqual({ index: 2, dim: true });
  expect(ICON_COLORS["idle-stopped"]).toEqual({ index: 7, dim: true });
  expect(ICON_COLORS["idle-killed"]).toEqual({ index: 1, dim: true });
  expect(ICON_COLORS.working.dim).toBeUndefined();
});

test("theme: the legacy text ROLE_COLORS map is untouched", () => {
  // The dash view forks a NEW icon map; the board/jobs text roles stay.
  expect(colorForRole("motion")).toEqual({ index: 12 });
  expect(ROLE_COLORS.terminal).toEqual({ index: 7, dim: true });
  expect(ROLE_COLORS.heading).toEqual({ bold: true });
});

// ---------------------------------------------------------------------------
// Status ladder
// ---------------------------------------------------------------------------

test("ladder: each base state resolves to its robot codepoint + icon role", () => {
  const cases: [Partial<Job>, RobotRung, IconRole][] = [
    [{ state: "working" }, "working", "working"],
    [{ state: "ended" }, "ended", "idle-ended"],
    [{ state: "stopped" }, "stopped", "idle-stopped"],
    [{ state: "killed" }, "killed", "idle-killed"],
  ];
  for (const [override, rung, icon] of cases) {
    const job = makeJob({ job_id: "j", ...override });
    expect(robotRung(job)).toBe(rung);
    const card = onlyCard(build([job], { showTerminal: true }));
    expect(card.robotGlyph).toBe(ROBOT[rung]);
    expect(card.iconRole).toBe(icon);
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

// ---------------------------------------------------------------------------
// handoff relation badge — the dash's only relationship surface (greenfield)
// ---------------------------------------------------------------------------

test("handoffBadge: no handoff_links → empty badge", () => {
  expect(onlyCard(build([makeJob({ job_id: "j" })])).handoffBadge).toBe("");
  expect(
    onlyCard(build([makeJob({ job_id: "j", handoff_links: [] })])).handoffBadge,
  ).toBe("");
});

test("handoffBadge: handoff-to surfaces the inbound badge with the peer (initiator) label", () => {
  const job = makeJob({
    job_id: "j",
    handoff_links: [
      {
        kind: "handoff-to",
        handoff_id: "h-1",
        peer_job_id: "initiator-3",
        status: "dispatched",
        title: "the initiator",
        state: "stopped",
        last_api_error_at: null,
        last_api_error_kind: null,
        last_input_request_at: null,
        last_input_request_kind: null,
        last_permission_prompt_at: null,
        last_permission_prompt_kind: null,
      },
    ],
  });
  expect(onlyCard(build([job])).handoffBadge).toBe("↰ from the initiator");
});

test("handoffBadge: handoff-to with null peer title falls back to the bare inbound arm", () => {
  const job = makeJob({
    job_id: "j",
    handoff_links: [
      {
        kind: "handoff-to",
        handoff_id: "h-1",
        peer_job_id: "",
        status: "dispatched",
        title: null,
        state: "stopped",
        last_api_error_at: null,
        last_api_error_kind: null,
        last_input_request_at: null,
        last_input_request_kind: null,
        last_permission_prompt_at: null,
        last_permission_prompt_kind: null,
      },
    ],
  });
  expect(onlyCard(build([job])).handoffBadge).toBe("↰ from");
});

test("handoffBadge: handoff-from surfaces the outbound (handed off) badge", () => {
  const job = makeJob({
    job_id: "j",
    handoff_links: [
      {
        kind: "handoff-from",
        handoff_id: "h-1",
        peer_job_id: "callee-7",
        status: "dispatched",
        title: "explore X",
        state: "working",
        last_api_error_at: null,
        last_api_error_kind: null,
        last_input_request_at: null,
        last_input_request_kind: null,
        last_permission_prompt_at: null,
        last_permission_prompt_kind: null,
      },
    ],
  });
  expect(onlyCard(build([job])).handoffBadge).toBe("↳ handed off");
});

test("ladder: api-error outranks live base states (priority 1, red rail)", () => {
  // Live (non-terminal) states only — terminal ended/killed now win over a
  // stale annotation stamp (see the terminal-state-wins ladder below).
  for (const state of ["working", "stopped"]) {
    const job = makeJob({ job_id: "j", state, last_api_error_at: 5 });
    expect(robotRung(job)).toBe("error");
    const card = onlyCard(build([job], { showTerminal: true }));
    expect(card.robotGlyph).toBe(ROBOT.error);
    expect(card.iconRole).toBe("error");
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

      // Resolves to the terminal rung (a stale annotation stamp does not pin it
      // as error/awaiting); when shown it lands in its session band (detached).
      const shown = build([job], { showTerminal: true });
      expect(cardKeys(shown, "")).toEqual(["job:j"]);
      const card = onlyCard(shown);
      expect(card.robotGlyph).toBe(ROBOT[rung]);
      expect(card.iconRole).toBe(role);

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
  expect(onlyCard(build([perm])).iconRole).toBe("awaiting");

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
    expect(card.iconRole).toBe("idle-stopped");
  }
});

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

test("bands: empty board emits no bands (no empty bands)", () => {
  expect(build([]).bands).toEqual([]);
});

test("bands: jobs group by tmux session (backend_exec_session_id)", () => {
  const jobs = [
    makeJob({ job_id: "fg1", backend_exec_session_id: "work" }),
    makeJob({ job_id: "ap1", backend_exec_session_id: "autopilot" }),
    makeJob({ job_id: "fg2", backend_exec_session_id: "work" }),
  ];
  const m = build(jobs);
  expect(cardKeys(m, "work").sort()).toEqual(["job:fg1", "job:fg2"]);
  expect(cardKeys(m, "autopilot")).toEqual(["job:ap1"]);
});

test("bands: render order — priority sessions first, others alpha, detached last", () => {
  const jobs = [
    makeJob({ job_id: "z", backend_exec_session_id: "zeta" }),
    makeJob({ job_id: "ap", backend_exec_session_id: "autopilot" }),
    makeJob({ job_id: "det", backend_exec_session_id: null }),
    makeJob({ job_id: "fg", backend_exec_session_id: "work" }),
    makeJob({ job_id: "ctl", backend_exec_session_id: "control" }),
    makeJob({ job_id: "bg", backend_exec_session_id: "background" }),
  ];
  const m = build(jobs);
  // work/autopilot (priority order) → other named sessions alphabetically
  // (background, control, zeta — a leftover `background` job now sorts in the
  // alphabetical zone, not a priority slot) → detached last.
  expect(m.bands.map((b) => b.key)).toEqual([
    "work",
    "autopilot",
    "background",
    "control",
    "zeta",
    "",
  ]);
});

test("bands: a NULL live session falls back to the birth session for grouping", () => {
  const jobs = [
    // Live session resolved — groups under the live name, NOT birth.
    makeJob({
      job_id: "live",
      backend_exec_session_id: "work",
      backend_exec_birth_session_id: "autopilot",
    }),
    // Live session unresolved — falls back to the birth session, so it does
    // NOT land in the detached band.
    makeJob({
      job_id: "born",
      backend_exec_session_id: null,
      backend_exec_birth_session_id: "background",
    }),
    // Neither live nor birth — genuinely detached.
    makeJob({
      job_id: "det",
      backend_exec_session_id: null,
      backend_exec_birth_session_id: null,
    }),
  ];
  const m = build(jobs);
  expect(cardKeys(m, "work")).toEqual(["job:live"]);
  expect(cardKeys(m, "background")).toEqual(["job:born"]);
  expect(cardKeys(m, "")).toEqual(["job:det"]);
});

test("bands: title is the session name; the no-session band is titled 'detached'", () => {
  const jobs = [
    makeJob({ job_id: "fg", backend_exec_session_id: "work" }),
    makeJob({ job_id: "det", backend_exec_session_id: null }),
  ];
  const m = build(jobs);
  expect(band(m, "work").title).toBe("work");
  expect(band(m, "").title).toBe("detached");
});

test("bands: a blank/whitespace session folds into detached", () => {
  const jobs = [makeJob({ job_id: "blank", backend_exec_session_id: "   " })];
  const m = build(jobs);
  expect(m.bands.map((b) => b.key)).toEqual([""]);
  expect(cardKeys(m, "")).toEqual(["job:blank"]);
});

test("bands: ended/killed land in their session band when shown", () => {
  const jobs = [
    makeJob({
      job_id: "done",
      state: "ended",
      backend_exec_session_id: "autopilot",
    }),
    makeJob({
      job_id: "dead",
      state: "killed",
      backend_exec_session_id: "autopilot",
    }),
    makeJob({
      job_id: "off",
      state: "stopped",
      backend_exec_session_id: "autopilot",
    }),
  ];
  const m = build(jobs, { showTerminal: true });
  expect(cardKeys(m, "autopilot").sort()).toEqual([
    "job:dead",
    "job:done",
    "job:off",
  ]);
});

// ---------------------------------------------------------------------------
// Intra-band sort
// ---------------------------------------------------------------------------

test("sort: all-null window_index falls through to created_at ASC, job_id tiebreak", () => {
  const s = "work";
  const jobs = [
    makeJob({ job_id: "c", created_at: 30, backend_exec_session_id: s }),
    makeJob({ job_id: "a", created_at: 10, backend_exec_session_id: s }),
    // Two equal created_at → job_id ASC (eq-a before eq-b).
    makeJob({ job_id: "eq-b", created_at: 20, backend_exec_session_id: s }),
    makeJob({ job_id: "eq-a", created_at: 20, backend_exec_session_id: s }),
  ];
  const m = build(jobs);
  expect(cardKeys(m, s)).toEqual(["job:a", "job:eq-a", "job:eq-b", "job:c"]);
});

test("sort: known window_index ASC is the PRIMARY key, beating created_at", () => {
  const s = "work";
  // Reversed: the lowest window_index carries the LATEST created_at, so a
  // stable sort or a created_at-primary comparator would produce the opposite
  // order. Final order MUST track window_index ASC.
  const jobs = [
    makeJob({
      job_id: "late",
      created_at: 300,
      window_index: 0,
      backend_exec_session_id: s,
    }),
    makeJob({
      job_id: "mid",
      created_at: 200,
      window_index: 1,
      backend_exec_session_id: s,
    }),
    makeJob({
      job_id: "early",
      created_at: 100,
      window_index: 2,
      backend_exec_session_id: s,
    }),
  ];
  const m = build(jobs);
  expect(cardKeys(m, s)).toEqual(["job:late", "job:mid", "job:early"]);
});

test("sort: unknown window_index sorts AFTER all known ones, then by created_at", () => {
  const s = "work";
  const jobs = [
    // Two unknown-index jobs tail the band, ordered by created_at ASC between
    // themselves.
    makeJob({
      job_id: "null-late",
      created_at: 50,
      window_index: null,
      backend_exec_session_id: s,
    }),
    makeJob({
      job_id: "null-early",
      created_at: 40,
      window_index: null,
      backend_exec_session_id: s,
    }),
    // A known window 0 — a real leftmost slot — must front-rank, NOT be
    // confused with "unknown" by a `?? 0` coercion.
    makeJob({
      job_id: "win0",
      created_at: 999,
      window_index: 0,
      backend_exec_session_id: s,
    }),
  ];
  const m = build(jobs);
  expect(cardKeys(m, s)).toEqual([
    "job:win0",
    "job:null-early",
    "job:null-late",
  ]);
});

test("sort: non-finite window_index is treated as unknown (NaN sorts to tail)", () => {
  const s = "work";
  const jobs = [
    makeJob({
      job_id: "nan",
      created_at: 1,
      window_index: Number.NaN,
      backend_exec_session_id: s,
    }),
    makeJob({
      job_id: "known",
      created_at: 999,
      window_index: 7,
      backend_exec_session_id: s,
    }),
  ];
  const m = build(jobs);
  // A NaN index must not poison the sort or front-rank — it tails the known one.
  expect(cardKeys(m, s)).toEqual(["job:known", "job:nan"]);
});

test("sort: order is independent of input map insertion order", () => {
  const s = "work";
  const m = build([
    makeJob({ job_id: "z", created_at: 99, backend_exec_session_id: s }),
    makeJob({ job_id: "y", created_at: 1, backend_exec_session_id: s }),
  ]);
  // created_at ASC → y (1) before z (99) regardless of insertion order.
  expect(cardKeys(m, s)).toEqual(["job:y", "job:z"]);
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
});

test("toggle: showTerminal=true reveals the happy/dead robots", () => {
  const jobs = [
    makeJob({ job_id: "done", state: "ended" }),
    makeJob({ job_id: "dead", state: "killed" }),
  ];
  const m = build(jobs, { showTerminal: true });
  const cards = band(m, "").cards;
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
  const fromArray = buildDashModel(arr, false);
  const fromMap = buildDashModel(jobsMap(arr), false);
  expect(fromArray).toEqual(fromMap);
});

test("input: build never throws on an empty / all-malformed job set", () => {
  expect(() => buildDashModel(new Map(), false)).not.toThrow();
  expect(() => buildDashModel([makeJob({ state: "???" })], true)).not.toThrow();
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

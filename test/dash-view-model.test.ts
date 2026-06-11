/**
 * Pure view-model tests for `src/dash/view-model.ts` and `src/dash/theme.ts`.
 * Table-driven over hand-built snapshots — no subprocess, no `sandboxEnv`, no
 * `@opentui` import anywhere (the property that keeps this file on the fast
 * tier). Asserts the SETTLED dash semantics: header permutations, PLAN rows
 * (server order, fallback label, verdict glyph+word incl. map-miss, N/M
 * completed-only with miss=not-done + zero-task hide, armed marker), AGENTS
 * rows (all-non-terminal inclusion + never-drop with label coalescing, the
 * unified COALESCE(active_since, created_at) DESC sort with job_id tiebreak +
 * NULL fallback + needs-you-no-reorder, the per-job rollup glyph matrix,
 * elapsed bands, awaiting/failed annotation), connection states, and the
 * empty-state placeholders.
 */

import { expect, test } from "bun:test";
import { colorForRole, ROLE_COLORS } from "../src/dash/theme";
import {
  buildDashModel,
  type ConnectionState,
  type DashModel,
  type DashModelInput,
  projectArmed,
  projectMode,
  projectPaused,
  type Row,
} from "../src/dash/view-model";
import { FA_CLASSIC, glyphForToken } from "../src/icon-theme";
import type { ReadinessSnapshot } from "../src/readiness";
import type { ReadinessClientSnapshot } from "../src/readiness-client";
import type { Epic, Job, SubagentInvocation, Task } from "../src/types";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    task_number: 1,
    title: "task",
    target_repo: null,
    tier: null,
    worker_phase: "open",
    runtime_status: "todo",
    depends_on: [],
    jobs: [],
    ...overrides,
  };
}

function makeEpic(overrides: Partial<Epic> = {}): Epic {
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
    created_by_closer_of: null,
    sort_path: "000001",
    queue_jump: 0,
    resolved_epic_deps: null,
    last_validated_at: null,
    ...overrides,
  };
}

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

function emptyReadiness(): ReadinessSnapshot {
  return {
    perTask: new Map(),
    perCloseRow: new Map(),
    perEpic: new Map(),
    diagnostics: [],
  };
}

function makeSnap(
  overrides: Partial<ReadinessClientSnapshot> = {},
): ReadinessClientSnapshot {
  return {
    epics: [],
    jobs: new Map(),
    subagentInvocations: [],
    gitStatus: [],
    deadLetters: [],
    pendingDispatches: [],
    readiness: emptyReadiness(),
    ...overrides,
  };
}

/** A `dead_letters`-length stub — only `.length` is read by the header. */
function deadLetters(n: number): ReadinessClientSnapshot["deadLetters"] {
  // The view-model reads only `.length`; an array of `n` placeholder rows
  // suffices without standing up the full `DeadLetter` shape.
  return Array.from({ length: n }) as ReadinessClientSnapshot["deadLetters"];
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/** Concatenated text of every segment in a row. */
function rowText(row: Row): string {
  return row.map((s) => s.text).join("");
}

/** The role attached to the first segment whose text contains `needle`. */
function roleOf(row: Row, needle: string): string | undefined {
  return row.find((s) => s.text.includes(needle))?.role;
}

const BASE_INPUT = {
  snapshot: makeSnap(),
  autopilotRows: [] as Record<string, unknown>[],
  armedRows: [] as Record<string, unknown>[],
  connection: "live" as ConnectionState,
  nowSec: 1000,
};

function build(overrides: Partial<DashModelInput>): DashModel {
  return buildDashModel({ ...BASE_INPUT, ...overrides });
}

// ---------------------------------------------------------------------------
// theme.ts
// ---------------------------------------------------------------------------

test("theme: six roles map to plain ANSI-indexed descriptors (no RGBA)", () => {
  const roles = [
    "motion",
    "ready",
    "attention",
    "failed",
    "terminal",
    "accent",
  ] as const;
  for (const role of roles) {
    const d = colorForRole(role);
    expect(typeof d.index).toBe("number");
    expect(Number.isInteger(d.index)).toBe(true);
    // Plain data only — index plus an optional dim flag.
    for (const k of Object.keys(d)) {
      expect(["index", "dim"]).toContain(k);
    }
  }
  // `terminal` carries the dim flag; the rest do not.
  expect(ROLE_COLORS.terminal.dim).toBe(true);
  expect(ROLE_COLORS.motion.dim).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Forked autopilot projectors
// ---------------------------------------------------------------------------

test("projectors: empty rows return null (keep seed); paused/mode coerce", () => {
  expect(projectPaused([])).toBeNull();
  expect(projectPaused([{ paused: 1 }])).toBe(true);
  expect(projectPaused([{ paused: 0 }])).toBe(false);
  expect(projectPaused([{ paused: "x" }])).toBe(true); // safer side

  expect(projectMode([])).toBeNull();
  expect(projectMode([{ mode: "armed" }])).toBe("armed");
  expect(projectMode([{ mode: "weird" }])).toBe("yolo");

  expect(projectArmed([{ epic_id: "fn-2" }, { epic_id: "fn-1" }])).toEqual([
    "fn-1",
    "fn-2",
  ]);
  expect(projectArmed([{ epic_id: "" }, {}])).toEqual([]);
});

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

test("header: seed (no autopilot edge) is paused · yolo, no armed/dl segment", () => {
  const { header } = build({});
  const text = rowText(header);
  expect(text).toContain("autopilot");
  expect(text).toContain("yolo");
  expect(text).not.toContain("armed");
  expect(text).not.toContain("dead-letter");
});

test("header: playing tags the autopilot segment motion; paused tags terminal", () => {
  const playing = build({ autopilotRows: [{ paused: 0, mode: "yolo" }] });
  expect(roleOf(playing.header, "autopilot")).toBe("motion");

  const paused = build({ autopilotRows: [{ paused: 1, mode: "yolo" }] });
  expect(roleOf(paused.header, "autopilot")).toBe("terminal");
});

test("header: armed mode with N armed renders the count; empty renders nothing armed", () => {
  const two = build({
    autopilotRows: [{ paused: 0, mode: "armed" }],
    armedRows: [{ epic_id: "fn-1" }, { epic_id: "fn-2" }],
  });
  expect(rowText(two.header)).toContain("2 armed");
  expect(rowText(two.header)).not.toContain("nothing armed");

  const none = build({
    autopilotRows: [{ paused: 0, mode: "armed" }],
    armedRows: [],
  });
  expect(rowText(none.header)).toContain("nothing armed");
  expect(roleOf(none.header, "nothing armed")).toBe("attention");
});

test("header: yolo mode never renders an armed segment", () => {
  const yolo = build({
    autopilotRows: [{ paused: 0, mode: "yolo" }],
    armedRows: [{ epic_id: "fn-1" }],
  });
  expect(rowText(yolo.header)).not.toContain("armed");
});

test("header: dead-letter segment only when count > 0", () => {
  const none = build({ snapshot: makeSnap({ deadLetters: deadLetters(0) }) });
  expect(rowText(none.header)).not.toContain("dead-letter");

  const some = build({ snapshot: makeSnap({ deadLetters: deadLetters(3) }) });
  expect(rowText(some.header)).toContain("3 dead-letter");
  expect(roleOf(some.header, "dead-letter")).toBe("attention");
});

test("header: connection marker shows only when not live", () => {
  expect(rowText(build({ connection: "live" }).header)).not.toMatch(/ing…/);
  expect(rowText(build({ connection: "connecting" }).header)).toContain(
    "connecting…",
  );
  expect(rowText(build({ connection: "reconnecting" }).header)).toContain(
    "reconnecting…",
  );
});

// ---------------------------------------------------------------------------
// PLAN
// ---------------------------------------------------------------------------

test("plan: rows keep server order (no client re-sort)", () => {
  // Epics in a deliberately non-sorted-by-id order; the view-model must keep
  // the array order it was handed (server `sort_path`).
  const snapshot = makeSnap({
    epics: [
      makeEpic({ epic_id: "fn-9-z", epic_number: 9, title: "zeta" }),
      makeEpic({ epic_id: "fn-2-a", epic_number: 2, title: "alpha" }),
    ],
  });
  const { plan } = build({ snapshot });
  expect(plan.map((r) => r.epicId)).toEqual(["fn-9-z", "fn-2-a"]);
});

test("plan: label falls back to epic_id when number and title are null", () => {
  const snapshot = makeSnap({
    epics: [makeEpic({ epic_id: "fn-7-x", epic_number: null, title: null })],
  });
  const { plan } = build({ snapshot });
  expect(rowText(plan[0].segments)).toContain("fn-7-x");
});

test("plan: verdict glyph+word; map miss renders the blocked/unknown form", () => {
  const readiness = emptyReadiness();
  readiness.perEpic.set("fn-1-foo", { tag: "ready" });
  const snapshot = makeSnap({ epics: [makeEpic({})], readiness });
  const { plan } = build({ snapshot });
  expect(rowText(plan[0].segments)).toContain("ready");
  expect(roleOf(plan[0].segments, "ready")).toBe("ready");

  // No perEpic entry → the visible blocked:unknown bug indicator.
  const missSnap = makeSnap({ epics: [makeEpic({})] });
  const miss = build({ snapshot: missSnap });
  expect(rowText(miss.plan[0].segments)).toContain("blocked:unknown");
  expect(roleOf(miss.plan[0].segments, "blocked:unknown")).toBe("attention");
});

test("plan: completed verdict renders in the inert terminal role", () => {
  const readiness = emptyReadiness();
  readiness.perEpic.set("fn-1-foo", { tag: "completed" });
  const snapshot = makeSnap({ epics: [makeEpic({})], readiness });
  const { plan } = build({ snapshot });
  expect(roleOf(plan[0].segments, "completed")).toBe("terminal");
});

test("plan: N/M counts completed-only (miss = not done); zero-task hides the segment", () => {
  const readiness = emptyReadiness();
  readiness.perEpic.set("fn-1-foo", {
    tag: "running",
    reason: { kind: "job-running" },
  });
  // Two completed, one ready, one un-mapped (miss) → 2/4.
  readiness.perTask.set("fn-1-foo.1", { tag: "completed" });
  readiness.perTask.set("fn-1-foo.2", { tag: "completed" });
  readiness.perTask.set("fn-1-foo.3", { tag: "ready" });
  // fn-1-foo.4 absent from the map — a miss, must NOT count as done.
  const snapshot = makeSnap({
    epics: [
      makeEpic({
        tasks: [
          makeTask({ task_id: "fn-1-foo.1", task_number: 1 }),
          makeTask({ task_id: "fn-1-foo.2", task_number: 2 }),
          makeTask({ task_id: "fn-1-foo.3", task_number: 3 }),
          makeTask({ task_id: "fn-1-foo.4", task_number: 4 }),
        ],
      }),
    ],
    readiness,
  });
  const { plan } = build({ snapshot });
  expect(rowText(plan[0].segments)).toContain("2/4");

  // Zero-task epic hides the N/M segment entirely.
  const zero = build({
    snapshot: makeSnap({ epics: [makeEpic({ tasks: [] })] }),
  });
  expect(rowText(zero.plan[0].segments)).not.toMatch(/\d+\/\d+/);
});

test("plan: all-complete N/M renders in the ready role", () => {
  const readiness = emptyReadiness();
  readiness.perEpic.set("fn-1-foo", { tag: "completed" });
  readiness.perTask.set("fn-1-foo.1", { tag: "completed" });
  const snapshot = makeSnap({
    epics: [makeEpic({ tasks: [makeTask({ task_id: "fn-1-foo.1" })] })],
    readiness,
  });
  const { plan } = build({ snapshot });
  expect(roleOf(plan[0].segments, "1/1")).toBe("ready");
});

test("plan: armed marker (accent) only when epic_id is in the armed set", () => {
  const snapshot = makeSnap({
    epics: [
      makeEpic({ epic_id: "fn-1-foo", sort_path: "000001" }),
      makeEpic({ epic_id: "fn-2-bar", epic_number: 2, sort_path: "000002" }),
    ],
  });
  const { plan } = build({
    snapshot,
    autopilotRows: [{ paused: 0, mode: "armed" }],
    armedRows: [{ epic_id: "fn-1-foo" }],
  });
  // `armed` has no themed glyph, so the marker uses the `*` text fallback —
  // a leading accent-role segment present only on the armed epic's row.
  expect(plan[0].segments[0].role).toBe("accent");
  expect(plan[0].segments[0].text).toContain("*");
  // The non-armed row leads with the label, not the marker.
  expect(rowText(plan[1].segments)).not.toContain("*");
});

// ---------------------------------------------------------------------------
// AGENTS
// ---------------------------------------------------------------------------

test("agents: includes EVERY non-terminal job — working AND idle stopped", () => {
  const jobs = new Map<string, Job>([
    ["w", makeJob({ job_id: "w", state: "working" })],
    [
      "ny",
      makeJob({
        job_id: "ny",
        state: "stopped",
        last_input_request_at: 5,
      }),
    ],
    // Idle stopped (no needs-you stamp) is now INCLUDED on the unified timeline
    // — the collections defaultFilter already excludes ended/killed.
    ["idle", makeJob({ job_id: "idle", state: "stopped" })],
  ]);
  const { agents } = build({ snapshot: makeSnap({ jobs }) });
  expect(agents.map((a) => a.jobId).sort()).toEqual(["idle", "ny", "w"]);
});

test("agents: never drops a needs-you row; label coalesces title→plan_ref→job_id", () => {
  const jobs = new Map<string, Job>([
    [
      "j1",
      makeJob({
        job_id: "j1",
        state: "stopped",
        title: null,
        plan_ref: null,
        last_permission_prompt_at: 9,
      }),
    ],
  ]);
  const { agents } = build({ snapshot: makeSnap({ jobs }) });
  expect(agents).toHaveLength(1);
  // No title, no plan_ref → falls back to the job_id label.
  expect(rowText(agents[0].segments)).toContain("j1");

  const withRef = build({
    snapshot: makeSnap({
      jobs: new Map([
        [
          "j2",
          makeJob({
            job_id: "j2",
            state: "stopped",
            title: null,
            plan_ref: "fn-3-baz.2",
            last_api_error_at: 1,
          }),
        ],
      ]),
    }),
  });
  expect(rowText(withRef.agents[0].segments)).toContain("fn-3-baz.2");
});

test("agents: per-job rollup glyph matrix (sync/cogs/warn/eye/circleO + ambient→idle)", () => {
  const SYNC = glyphForToken("running:job-running", FA_CLASSIC) as string;
  const COGS = glyphForToken("running:sub-agent-running", FA_CLASSIC) as string;
  const WARN = glyphForToken("running:sub-agent-stale", FA_CLASSIC) as string;
  const EYE = glyphForToken("running:monitor-running", FA_CLASSIC) as string;
  const CIRCLE_O = glyphForToken("stopped", FA_CLASSIC) as string;
  // sub-agent-stale and monitor-stale share the warn triangle.
  expect(glyphForToken("running:monitor-stale", FA_CLASSIC)).toBe(WARN);

  const liveMon = JSON.stringify([{ id: "m1", kind: "monitor" }]);
  const ambientMon = JSON.stringify([{ id: "a1", kind: "ambient" }]);

  // job_id → [job overrides, running subagents for that job, expected glyph].
  const cases: [Partial<Job>, SubagentInvocation[], string][] = [
    // working → sync
    [{ state: "working" }, [], SYNC],
    // stopped + fresh subagent → cogs
    [{ state: "stopped" }, [makeSub({ ts: 990 })], COGS],
    // stopped + only stale subagents → warn
    [{ state: "stopped" }, [makeSub({ ts: 0 })], WARN],
    // stopped + live worker monitor, fresh updated_at → eye
    [{ state: "stopped", monitors: liveMon, updated_at: 1000 }, [], EYE],
    // stopped + live worker monitor, stale updated_at → warn
    [{ state: "stopped", monitors: liveMon, updated_at: 0 }, [], WARN],
    // stopped, idle → circleO
    [{ state: "stopped" }, [], CIRCLE_O],
    // ambient-only monitor → idle (NOT eye): ambient never occupies.
    [{ state: "stopped", monitors: ambientMon }, [], CIRCLE_O],
  ];

  for (const [jobOverride, subs, expectedGlyph] of cases) {
    const job = makeJob({ job_id: "j", ...jobOverride });
    const subagentInvocations = subs.map((s) => ({ ...s, job_id: "j" }));
    const { agents } = build({
      snapshot: makeSnap({
        jobs: new Map([["j", job]]),
        subagentInvocations,
      }),
      nowSec: 1000,
    });
    // The leading glyph is the first segment's text (glyph + trailing space).
    expect(agents[0].segments[0].text).toContain(expectedGlyph);
  }
});

test("agents: read-side never throws on malformed monitors JSON (folds to idle)", () => {
  const CIRCLE_O = glyphForToken("stopped", FA_CLASSIC) as string;
  const jobs = new Map<string, Job>([
    ["j", makeJob({ job_id: "j", state: "stopped", monitors: "{not json" })],
  ]);
  const { agents } = build({ snapshot: makeSnap({ jobs }), nowSec: 1000 });
  expect(agents[0].segments[0].text).toContain(CIRCLE_O);
});

test("agents: unified COALESCE(active_since, created_at) DESC sort, job_id ASC tiebreak", () => {
  const jobs = new Map<string, Job>([
    // stopped, recent active_since → outranks the older-active_since working job
    [
      "stopped-recent",
      makeJob({
        job_id: "stopped-recent",
        state: "stopped",
        active_since: 100,
      }),
    ],
    // working, but older active_since
    [
      "working-old",
      makeJob({ job_id: "working-old", state: "working", active_since: 50 }),
    ],
    // two equal active_since → job_id ASC tiebreak (eq-a before eq-b)
    ["eq-b", makeJob({ job_id: "eq-b", state: "stopped", active_since: 75 })],
    ["eq-a", makeJob({ job_id: "eq-a", state: "stopped", active_since: 75 })],
  ]);
  const { agents } = build({ snapshot: makeSnap({ jobs }) });
  // 100 > 75 (a before b) > 50 — needs-you / state no longer affect order.
  expect(agents.map((a) => a.jobId)).toEqual([
    "stopped-recent",
    "eq-a",
    "eq-b",
    "working-old",
  ]);
});

test("agents: NULL active_since falls back to created_at (never-prompted job)", () => {
  const jobs = new Map<string, Job>([
    // no active_since (never prompted) but newest created_at
    [
      "fresh",
      makeJob({
        job_id: "fresh",
        state: "working",
        active_since: null,
        created_at: 90,
      }),
    ],
    // active_since older than fresh's created_at fallback
    [
      "ran",
      makeJob({
        job_id: "ran",
        state: "stopped",
        active_since: 80,
        created_at: 10,
      }),
    ],
    // no active_since, oldest created_at
    [
      "old",
      makeJob({
        job_id: "old",
        state: "stopped",
        active_since: null,
        created_at: 5,
      }),
    ],
  ]);
  const { agents } = build({ snapshot: makeSnap({ jobs }) });
  // keys: fresh=90, ran=80, old=5 → DESC.
  expect(agents.map((a) => a.jobId)).toEqual(["fresh", "ran", "old"]);
});

test("agents: needs-you does NOT reorder; the awaiting annotation still renders", () => {
  const jobs = new Map<string, Job>([
    // needs-you but OLDER active_since → must NOT float to the top
    [
      "ny",
      makeJob({
        job_id: "ny",
        state: "stopped",
        active_since: 10,
        last_input_request_at: 5,
      }),
    ],
    // no needs-you, newer active_since → sorts first purely on recency
    ["fresh", makeJob({ job_id: "fresh", state: "working", active_since: 50 })],
  ]);
  const { agents } = build({ snapshot: makeSnap({ jobs }) });
  expect(agents.map((a) => a.jobId)).toEqual(["fresh", "ny"]);
  // The needs-you row (now at index 1, not floated up) keeps its `awaiting`
  // annotation — the signal is re-positioned, not lost.
  const nyRow = agents[1];
  expect(nyRow.jobId).toBe("ny");
  expect(rowText(nyRow.segments)).toContain("awaiting");
  expect(roleOf(nyRow.segments, "awaiting")).toBe("attention");
});

test("agents: a wire row delivers active_since as number | null, never undefined", () => {
  // Guards against the collections-columns omission from task .1: a job whose
  // active_since is explicitly null still sorts (by created_at), not via an
  // undefined-coerced-to-0 key.
  const jobs = new Map<string, Job>([
    [
      "a",
      makeJob({
        job_id: "a",
        state: "stopped",
        active_since: null,
        created_at: 30,
      }),
    ],
    [
      "b",
      makeJob({
        job_id: "b",
        state: "stopped",
        active_since: 20,
        created_at: 5,
      }),
    ],
  ]);
  for (const job of jobs.values()) {
    // The wire type is number | null — assert the fixture honors it.
    expect(
      job.active_since === null || typeof job.active_since === "number",
    ).toBe(true);
  }
  const { agents } = build({ snapshot: makeSnap({ jobs }) });
  // a's created_at fallback (30) > b's active_since (20).
  expect(agents.map((a) => a.jobId)).toEqual(["a", "b"]);
});

test("agents: elapsed bands floor to the largest unit, no 'ago'", () => {
  const cases: [number, string][] = [
    [1000 - 5, "5s"],
    [1000 - 4 * 60, "4m"],
    [1000 - 2 * 3600, "2h"],
    [1000 - 1 * 86400, "1d"],
  ];
  for (const [updatedAt, band] of cases) {
    const jobs = new Map<string, Job>([
      ["j", makeJob({ job_id: "j", state: "working", updated_at: updatedAt })],
    ]);
    const { agents } = build({ snapshot: makeSnap({ jobs }), nowSec: 1000 });
    expect(rowText(agents[0].segments)).toContain(band);
  }
});

test("agents: awaiting (attention) / failed (failed) annotation replaces the elapsed band", () => {
  const awaiting = build({
    snapshot: makeSnap({
      jobs: new Map([
        [
          "j",
          makeJob({
            job_id: "j",
            state: "working",
            updated_at: 0,
            last_permission_prompt_at: 1,
          }),
        ],
      ]),
    }),
    nowSec: 1000,
  });
  expect(rowText(awaiting.agents[0].segments)).toContain("awaiting");
  expect(roleOf(awaiting.agents[0].segments, "awaiting")).toBe("attention");
  // The elapsed band is replaced, not appended.
  expect(rowText(awaiting.agents[0].segments)).not.toMatch(/\d+[smhd]\b/);

  const failed = build({
    snapshot: makeSnap({
      jobs: new Map([
        [
          "j",
          makeJob({
            job_id: "j",
            state: "stopped",
            updated_at: 0,
            last_api_error_at: 1,
          }),
        ],
      ]),
    }),
    nowSec: 1000,
  });
  expect(rowText(failed.agents[0].segments)).toContain("failed");
  expect(roleOf(failed.agents[0].segments, "failed")).toBe("failed");
});

// ---------------------------------------------------------------------------
// Connection + placeholders
// ---------------------------------------------------------------------------

test("connection: null snapshot yields empty regions and the waiting body line", () => {
  const m = build({ snapshot: null, connection: "connecting" });
  expect(m.plan).toHaveLength(0);
  expect(m.agents).toHaveLength(0);
  expect(m.placeholders.waiting?.text).toContain("waiting for keeperd");
  // The header still renders off the autopilot seed.
  expect(rowText(m.header)).toContain("autopilot");
});

test("connection: loaded-empty regions render the dim placeholders, no waiting line", () => {
  const m = build({ snapshot: makeSnap(), connection: "live" });
  expect(m.placeholders.waiting).toBeNull();
  expect(m.placeholders.planEmpty.text).toBe("no open epics");
  expect(m.placeholders.planEmpty.role).toBe("terminal");
  expect(m.placeholders.agentsEmpty.text).toBe("no agents");
  expect(m.placeholders.agentsEmpty.role).toBe("terminal");
});

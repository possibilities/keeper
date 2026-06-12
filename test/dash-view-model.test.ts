/**
 * Pure view-model tests for `src/dash/view-model.ts` and `src/dash/theme.ts`.
 * Table-driven over hand-built snapshots — no subprocess, no `sandboxEnv`, no
 * `@opentui` import anywhere (the property that keeps this file on the fast
 * tier). Asserts the SETTLED dash semantics: header permutations, the keyed
 * body row stream (section rules, spacer/divider runs between epic blocks,
 * placeholders), EPIC rows (server order, fallback label, glyph-only verdicts
 * incl. map-miss, the workability axis on titles, armed bolt gating, dep refs,
 * project basename), TASK rows (nesting, sort, per-task glyphs, dep refs), and
 * JOB rows (all-non-terminal inclusion + never-drop with label coalescing, the
 * unified COALESCE(active_since, created_at) DESC sort with job_id tiebreak +
 * NULL fallback + needs-you-no-reorder, the per-job rollup glyph matrix,
 * elapsed bands, glyph-only awaiting/failed annotations).
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
  type SplitRow,
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

/** The body row with this key, asserted to exist and be a split row. */
function splitRow(model: DashModel, key: string): SplitRow {
  const row = model.body.find((r) => r.key === key);
  expect(row).toBeDefined();
  expect(row?.kind).toBe("split");
  return row as SplitRow;
}

/** Ordered keys of every body row matching a prefix. */
function keysWithPrefix(model: DashModel, prefix: string): string[] {
  return model.body.filter((r) => r.key.startsWith(prefix)).map((r) => r.key);
}

const GLYPH = {
  ready: glyphForToken("ready", FA_CLASSIC) as string,
  completed: glyphForToken("completed", FA_CLASSIC) as string,
  ban: glyphForToken("blocked:unknown", FA_CLASSIC) as string,
  sync: glyphForToken("running:job-running", FA_CLASSIC) as string,
  bolt: glyphForToken("armed", FA_CLASSIC) as string,
  times: glyphForToken("failed", FA_CLASSIC) as string,
  hand: glyphForToken("awaiting:permission", FA_CLASSIC) as string,
  comment: glyphForToken("awaiting:ask_user_question", FA_CLASSIC) as string,
};

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

test("theme: roles map to plain descriptors (index/dim/bold only, no RGBA)", () => {
  const roles = [
    "motion",
    "ready",
    "attention",
    "failed",
    "terminal",
    "accent",
    "heading",
    "text",
  ] as const;
  for (const role of roles) {
    const d = colorForRole(role);
    for (const k of Object.keys(d)) {
      expect(["index", "dim", "bold"]).toContain(k);
    }
    if (d.index !== undefined) {
      expect(Number.isInteger(d.index)).toBe(true);
    }
  }
  // `terminal` carries the dim flag; `heading` is bold default-fg; `text` is
  // bare default-fg (no index — the terminal's own foreground).
  expect(ROLE_COLORS.terminal.dim).toBe(true);
  expect(ROLE_COLORS.motion.dim).toBeUndefined();
  expect(ROLE_COLORS.heading.bold).toBe(true);
  expect(ROLE_COLORS.heading.index).toBeUndefined();
  expect(ROLE_COLORS.text.index).toBeUndefined();
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
// Body structure
// ---------------------------------------------------------------------------

test("body: live frame opens EPICS then JOBS section rules, in that order", () => {
  const m = build({});
  const sections = m.body.filter((r) => r.kind === "section");
  expect(sections.map((r) => (r.kind === "section" ? r.title : ""))).toEqual([
    "EPICS",
    "JOBS",
  ]);
  const keys = m.body.map((r) => r.key);
  expect(keys.indexOf("sec:epics")).toBeLessThan(keys.indexOf("sec:jobs"));
});

test("body: spacer-divider-spacer runs separate epic blocks, keyed on the epic above", () => {
  const snapshot = makeSnap({
    epics: [
      makeEpic({ epic_id: "fn-1-a", epic_number: 1, sort_path: "000001" }),
      makeEpic({ epic_id: "fn-2-b", epic_number: 2, sort_path: "000002" }),
    ],
  });
  const m = build({ snapshot });
  const keys = m.body.map((r) => r.key);
  // The run between blocks rides the FIRST epic's id, so appending an epic
  // below never re-keys an existing divider.
  const i = keys.indexOf("epic:fn-1-a");
  expect(keys.slice(i, i + 5)).toEqual([
    "epic:fn-1-a",
    "sp:a:fn-1-a",
    "div:fn-1-a",
    "sp:b:fn-1-a",
    "epic:fn-2-b",
  ]);
  // No divider trails the last block.
  expect(keys).not.toContain("div:fn-2-b");

  // A single epic renders no divider at all.
  const one = build({
    snapshot: makeSnap({ epics: [makeEpic({ epic_id: "fn-1-a" })] }),
  });
  expect(one.body.some((r) => r.kind === "divider")).toBe(false);
});

test("body: null snapshot yields only the waiting line (no sections); header still renders", () => {
  const m = build({ snapshot: null, connection: "connecting" });
  expect(m.body.some((r) => r.kind === "section")).toBe(false);
  const waiting = splitRow(m, "ph:waiting");
  expect(rowText(waiting.left)).toContain("waiting for keeperd");
  expect(roleOf(waiting.left, "waiting")).toBe("terminal");
  // The header still renders off the autopilot seed.
  expect(rowText(m.header)).toContain("autopilot");
});

test("body: loaded-empty regions render dim placeholders under their sections", () => {
  const m = build({ snapshot: makeSnap(), connection: "live" });
  expect(m.body.some((r) => r.key === "ph:waiting")).toBe(false);
  const epics = splitRow(m, "ph:epics");
  expect(rowText(epics.left)).toBe("no open epics");
  expect(roleOf(epics.left, "no open epics")).toBe("terminal");
  const jobs = splitRow(m, "ph:jobs");
  expect(rowText(jobs.left)).toBe("no jobs");
  expect(roleOf(jobs.left, "no jobs")).toBe("terminal");
});

// ---------------------------------------------------------------------------
// EPICS
// ---------------------------------------------------------------------------

test("epics: rows keep server order (no client re-sort)", () => {
  // Epics in a deliberately non-sorted-by-id order; the view-model must keep
  // the array order it was handed (server `sort_path`).
  const snapshot = makeSnap({
    epics: [
      makeEpic({ epic_id: "fn-9-z", epic_number: 9, title: "zeta" }),
      makeEpic({ epic_id: "fn-2-a", epic_number: 2, title: "alpha" }),
    ],
  });
  const m = build({ snapshot });
  expect(keysWithPrefix(m, "epic:")).toEqual(["epic:fn-9-z", "epic:fn-2-a"]);
});

test("epics: label falls back to epic_id when number and title are null", () => {
  const snapshot = makeSnap({
    epics: [makeEpic({ epic_id: "fn-7-x", epic_number: null, title: null })],
  });
  const m = build({ snapshot });
  expect(rowText(splitRow(m, "epic:fn-7-x").left)).toContain("fn-7-x");
});

test("epics: glyph-only verdicts — no pill words anywhere on the row", () => {
  const readiness = emptyReadiness();
  readiness.perEpic.set("fn-1-foo", { tag: "ready" });
  const snapshot = makeSnap({ epics: [makeEpic({})], readiness });
  const row = splitRow(build({ snapshot }), "epic:fn-1-foo");
  expect(row.left[0]?.text).toContain(GLYPH.ready);
  expect(row.left[0]?.role).toBe("ready");
  // The verdict WORD never renders — the glyph + color carry the state.
  expect(rowText(row.left)).not.toContain("ready");

  // No perEpic entry → the visible blocked/unknown glyph in attention.
  const missRow = splitRow(
    build({ snapshot: makeSnap({ epics: [makeEpic({})] }) }),
    "epic:fn-1-foo",
  );
  expect(missRow.left[0]?.text).toContain(GLYPH.ban);
  expect(missRow.left[0]?.role).toBe("attention");
  expect(rowText(missRow.left)).not.toContain("blocked");
});

test("epics: workability axis — workable title is heading, inert title recedes dim", () => {
  const readiness = emptyReadiness();
  readiness.perEpic.set("fn-1-foo", { tag: "ready" });
  const ready = splitRow(
    build({ snapshot: makeSnap({ epics: [makeEpic({})], readiness }) }),
    "epic:fn-1-foo",
  );
  expect(roleOf(ready.left, "epic")).toBe("heading");

  const done = emptyReadiness();
  done.perEpic.set("fn-1-foo", { tag: "completed" });
  const completed = splitRow(
    build({ snapshot: makeSnap({ epics: [makeEpic({})], readiness: done }) }),
    "epic:fn-1-foo",
  );
  expect(completed.left[0]?.role).toBe("terminal"); // glyph
  expect(roleOf(completed.left, "epic")).toBe("terminal"); // title

  const blocked = splitRow(
    build({ snapshot: makeSnap({ epics: [makeEpic({})] }) }),
    "epic:fn-1-foo",
  );
  expect(roleOf(blocked.left, "epic")).toBe("terminal");
});

test("epics: no task-count segment renders", () => {
  const readiness = emptyReadiness();
  readiness.perTask.set("fn-1-foo.1", { tag: "completed" });
  const snapshot = makeSnap({
    epics: [makeEpic({ tasks: [makeTask({})] })],
    readiness,
  });
  const row = splitRow(build({ snapshot }), "epic:fn-1-foo");
  expect(rowText(row.left) + rowText(row.right)).not.toMatch(/\d+\/\d+/);
});

test("epics: armed bolt (accent) only in armed mode AND only on armed epics", () => {
  const snapshot = makeSnap({
    epics: [
      makeEpic({ epic_id: "fn-1-foo", sort_path: "000001" }),
      makeEpic({ epic_id: "fn-2-bar", epic_number: 2, sort_path: "000002" }),
    ],
  });
  const armed = build({
    snapshot,
    autopilotRows: [{ paused: 0, mode: "armed" }],
    armedRows: [{ epic_id: "fn-1-foo" }],
  });
  expect(rowText(splitRow(armed, "epic:fn-1-foo").left)).toContain(GLYPH.bolt);
  expect(roleOf(splitRow(armed, "epic:fn-1-foo").left, GLYPH.bolt)).toBe(
    "accent",
  );
  expect(rowText(splitRow(armed, "epic:fn-2-bar").left)).not.toContain(
    GLYPH.bolt,
  );

  // Yolo mode: the armed set is not dispatch policy — no bolt even when set.
  const yolo = build({
    snapshot,
    autopilotRows: [{ paused: 0, mode: "yolo" }],
    armedRows: [{ epic_id: "fn-1-foo" }],
  });
  expect(rowText(splitRow(yolo, "epic:fn-1-foo").left)).not.toContain(
    GLYPH.bolt,
  );
});

test("epics: project basename right-aligns dim; root-less dir renders as-is", () => {
  const snapshot = makeSnap({
    epics: [makeEpic({ project_dir: "/Users/mike/code/keeper" })],
  });
  const row = splitRow(build({ snapshot }), "epic:fn-1-foo");
  expect(rowText(row.right)).toContain("keeper");
  expect(rowText(row.right)).not.toContain("/Users");
  expect(roleOf(row.right, "keeper")).toBe("terminal");

  const noDir = makeSnap({ epics: [makeEpic({ project_dir: null })] });
  expect(
    rowText(splitRow(build({ snapshot: noDir }), "epic:fn-1-foo").right),
  ).toBe("");
});

test("epics: resolved dep refs — state-colored #N / cross-project / dangling forms", () => {
  const snapshot = makeSnap({
    epics: [
      makeEpic({
        depends_on_epics: ["fn-3", "other-5", "fn-9-gone"],
        resolved_epic_deps: [
          {
            dep_token: "fn-3",
            resolved_epic_id: "fn-3-x",
            epic_number: 3,
            project_basename: null,
            cross_project: false,
            state: "satisfied",
          },
          {
            dep_token: "other-5",
            resolved_epic_id: "other-5-y",
            epic_number: 5,
            project_basename: "otherproj",
            cross_project: true,
            state: "blocked-incomplete",
          },
          {
            dep_token: "fn-9-gone",
            resolved_epic_id: null,
            epic_number: null,
            project_basename: null,
            cross_project: false,
            state: "dangling",
          },
        ],
      }),
    ],
  });
  const row = splitRow(build({ snapshot }), "epic:fn-1-foo");
  const right = rowText(row.right);
  expect(right).toContain("after ");
  expect(right).toContain("#3");
  expect(roleOf(row.right, "#3")).toBe("terminal"); // satisfied → recedes
  expect(right).toContain("otherproj#5");
  expect(roleOf(row.right, "otherproj#5")).toBe("attention"); // live gate
  expect(right).toContain("?fn-9-gone");
  expect(roleOf(row.right, "?fn-9-gone")).toBe("failed"); // dangling
});

test("epics: null dep projection falls back to parsing raw tokens dim", () => {
  const snapshot = makeSnap({
    epics: [
      makeEpic({
        depends_on_epics: ["fn-31-slug", "weird token"],
        resolved_epic_deps: null,
      }),
    ],
  });
  const row = splitRow(build({ snapshot }), "epic:fn-1-foo");
  expect(rowText(row.right)).toContain("#31");
  expect(rowText(row.right)).toContain("?weird token");
  expect(roleOf(row.right, "#31")).toBe("terminal");

  // No deps at all → no `after` lead.
  const none = splitRow(
    build({ snapshot: makeSnap({ epics: [makeEpic({})] }) }),
    "epic:fn-1-foo",
  );
  expect(rowText(none.right)).not.toContain("after");
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

test("tasks: nest under their epic in task_number order, indented", () => {
  const snapshot = makeSnap({
    epics: [
      makeEpic({
        tasks: [
          makeTask({ task_id: "fn-1-foo.3", task_number: 3, title: "three" }),
          makeTask({ task_id: "fn-1-foo.1", task_number: 1, title: "one" }),
          makeTask({ task_id: "fn-1-foo.2", task_number: 2, title: "two" }),
        ],
      }),
    ],
  });
  const m = build({ snapshot });
  expect(keysWithPrefix(m, "epic:fn-1-foo:task:")).toEqual([
    "epic:fn-1-foo:task:fn-1-foo.1",
    "epic:fn-1-foo:task:fn-1-foo.2",
    "epic:fn-1-foo:task:fn-1-foo.3",
  ]);
  const row = splitRow(m, "epic:fn-1-foo:task:fn-1-foo.1");
  expect(row.indent).toBeGreaterThan(0);
  expect(rowText(row.left)).toContain("one");
});

test("tasks: per-task glyph from perTask verdict; miss renders blocked/unknown", () => {
  const readiness = emptyReadiness();
  readiness.perTask.set("fn-1-foo.1", { tag: "completed" });
  readiness.perTask.set("fn-1-foo.2", { tag: "ready" });
  const snapshot = makeSnap({
    epics: [
      makeEpic({
        tasks: [
          makeTask({ task_id: "fn-1-foo.1", task_number: 1, title: "done" }),
          makeTask({ task_id: "fn-1-foo.2", task_number: 2, title: "go" }),
          makeTask({ task_id: "fn-1-foo.3", task_number: 3, title: "miss" }),
        ],
      }),
    ],
    readiness,
  });
  const m = build({ snapshot });

  const done = splitRow(m, "epic:fn-1-foo:task:fn-1-foo.1");
  expect(done.left[0]?.text).toContain(GLYPH.completed);
  expect(done.left[0]?.role).toBe("terminal");
  expect(roleOf(done.left, "done")).toBe("terminal"); // title recedes

  const go = splitRow(m, "epic:fn-1-foo:task:fn-1-foo.2");
  expect(go.left[0]?.text).toContain(GLYPH.ready);
  expect(go.left[0]?.role).toBe("ready");
  expect(roleOf(go.left, "go")).toBe("text"); // workable, task tier

  const miss = splitRow(m, "epic:fn-1-foo:task:fn-1-foo.3");
  expect(miss.left[0]?.text).toContain(GLYPH.ban);
  expect(miss.left[0]?.role).toBe("attention");
});

test("tasks: dep refs render numbers colored by the dep's own verdict", () => {
  const readiness = emptyReadiness();
  readiness.perTask.set("fn-1-foo.1", { tag: "completed" });
  const snapshot = makeSnap({
    epics: [
      makeEpic({
        tasks: [
          makeTask({ task_id: "fn-1-foo.1", task_number: 1 }),
          makeTask({ task_id: "fn-1-foo.2", task_number: 2 }),
          makeTask({
            task_id: "fn-1-foo.3",
            task_number: 3,
            depends_on: ["fn-1-foo.1", "fn-1-foo.2"],
          }),
        ],
      }),
    ],
    readiness,
  });
  const row = splitRow(build({ snapshot }), "epic:fn-1-foo:task:fn-1-foo.3");
  expect(rowText(row.right)).toContain("after ");
  // Dep .1 completed → dim; dep .2 not completed → attention (still gating).
  const one = row.right.find((s) => s.text === "1");
  const two = row.right.find((s) => s.text === "2");
  expect(one?.role).toBe("terminal");
  expect(two?.role).toBe("attention");

  // No deps → empty right side.
  const noDeps = splitRow(build({ snapshot }), "epic:fn-1-foo:task:fn-1-foo.1");
  expect(rowText(noDeps.right)).toBe("");
});

// ---------------------------------------------------------------------------
// JOBS
// ---------------------------------------------------------------------------

test("jobs: includes EVERY non-terminal job — working AND idle stopped", () => {
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
    // Idle stopped (no needs-you stamp) is INCLUDED on the unified timeline
    // — the collections defaultFilter already excludes ended/killed.
    ["idle", makeJob({ job_id: "idle", state: "stopped" })],
  ]);
  const m = build({ snapshot: makeSnap({ jobs }) });
  expect(keysWithPrefix(m, "job:").sort()).toEqual([
    "job:idle",
    "job:ny",
    "job:w",
  ]);
});

test("jobs: never drops a needs-you row; label coalesces title→plan_ref→job_id", () => {
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
  const m = build({ snapshot: makeSnap({ jobs }) });
  // No title, no plan_ref → falls back to the job_id label.
  expect(rowText(splitRow(m, "job:j1").left)).toContain("j1");

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
  expect(rowText(splitRow(withRef, "job:j2").left)).toContain("fn-3-baz.2");
});

test("jobs: per-job rollup glyph matrix (sync/cogs/warn/eye/circleO + ambient→idle)", () => {
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
    const m = build({
      snapshot: makeSnap({
        jobs: new Map([["j", job]]),
        subagentInvocations,
      }),
      nowSec: 1000,
    });
    // The leading glyph is the first left segment's text.
    expect(splitRow(m, "job:j").left[0]?.text).toContain(expectedGlyph);
  }
});

test("jobs: idle label recedes dim; live label rides default fg", () => {
  const jobs = new Map<string, Job>([
    ["live", makeJob({ job_id: "live", state: "working", title: "live one" })],
    ["idle", makeJob({ job_id: "idle", state: "stopped", title: "idle one" })],
  ]);
  const m = build({ snapshot: makeSnap({ jobs }), nowSec: 1000 });
  expect(roleOf(splitRow(m, "job:live").left, "live one")).toBe("text");
  expect(roleOf(splitRow(m, "job:idle").left, "idle one")).toBe("terminal");
});

test("jobs: read-side never throws on malformed monitors JSON (folds to idle)", () => {
  const CIRCLE_O = glyphForToken("stopped", FA_CLASSIC) as string;
  const jobs = new Map<string, Job>([
    ["j", makeJob({ job_id: "j", state: "stopped", monitors: "{not json" })],
  ]);
  const m = build({ snapshot: makeSnap({ jobs }), nowSec: 1000 });
  expect(splitRow(m, "job:j").left[0]?.text).toContain(CIRCLE_O);
});

test("jobs: unified COALESCE(active_since, created_at) DESC sort, job_id ASC tiebreak", () => {
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
  const m = build({ snapshot: makeSnap({ jobs }) });
  // 100 > 75 (a before b) > 50 — needs-you / state never affect order.
  expect(keysWithPrefix(m, "job:")).toEqual([
    "job:stopped-recent",
    "job:eq-a",
    "job:eq-b",
    "job:working-old",
  ]);
});

test("jobs: NULL active_since falls back to created_at (never-prompted job)", () => {
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
  const m = build({ snapshot: makeSnap({ jobs }) });
  // keys: fresh=90, ran=80, old=5 → DESC.
  expect(keysWithPrefix(m, "job:")).toEqual([
    "job:fresh",
    "job:ran",
    "job:old",
  ]);
});

test("jobs: needs-you does NOT reorder; the awaiting glyph still renders", () => {
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
  const m = build({ snapshot: makeSnap({ jobs }) });
  expect(keysWithPrefix(m, "job:")).toEqual(["job:fresh", "job:ny"]);
  // The needs-you row (sorted on recency, not floated) keeps its awaiting
  // glyph — the signal is re-positioned, not lost.
  const nyRow = splitRow(m, "job:ny");
  expect(rowText(nyRow.right)).toContain(GLYPH.comment);
  expect(roleOf(nyRow.right, GLYPH.comment)).toBe("attention");
});

test("jobs: a wire row delivers active_since as number | null, never undefined", () => {
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
  const m = build({ snapshot: makeSnap({ jobs }) });
  // a's created_at fallback (30) > b's active_since (20).
  expect(keysWithPrefix(m, "job:")).toEqual(["job:a", "job:b"]);
});

test("jobs: elapsed bands floor to the largest unit, no 'ago', right-aligned", () => {
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
    const m = build({ snapshot: makeSnap({ jobs }), nowSec: 1000 });
    expect(rowText(splitRow(m, "job:j").right)).toContain(band);
  }
});

test("jobs: failed/awaiting render as glyphs (no words) beside the elapsed band", () => {
  const permission = build({
    snapshot: makeSnap({
      jobs: new Map([
        [
          "j",
          makeJob({
            job_id: "j",
            state: "working",
            updated_at: 940,
            last_permission_prompt_at: 1,
          }),
        ],
      ]),
    }),
    nowSec: 1000,
  });
  const pRow = splitRow(permission, "job:j");
  expect(rowText(pRow.right)).toContain(GLYPH.hand);
  expect(roleOf(pRow.right, GLYPH.hand)).toBe("attention");
  expect(rowText(pRow.right)).toContain("1m"); // elapsed stays
  expect(rowText(pRow.right)).not.toContain("awaiting");

  const input = build({
    snapshot: makeSnap({
      jobs: new Map([
        [
          "j",
          makeJob({
            job_id: "j",
            state: "stopped",
            updated_at: 940,
            last_input_request_at: 1,
          }),
        ],
      ]),
    }),
    nowSec: 1000,
  });
  expect(rowText(splitRow(input, "job:j").right)).toContain(GLYPH.comment);

  const failed = build({
    snapshot: makeSnap({
      jobs: new Map([
        [
          "j",
          makeJob({
            job_id: "j",
            state: "stopped",
            updated_at: 940,
            last_api_error_at: 1,
          }),
        ],
      ]),
    }),
    nowSec: 1000,
  });
  const fRow = splitRow(failed, "job:j");
  expect(rowText(fRow.right)).toContain(GLYPH.times);
  expect(roleOf(fRow.right, GLYPH.times)).toBe("failed");
  expect(rowText(fRow.right)).not.toContain("failed");
});

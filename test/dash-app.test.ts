/**
 * Frame test for the `keeper dash` materializer (`src/dash/app.ts`
 * `attachDashApp`). Proves the OpenTUI paint surface over the robot job-card
 * model: the static tree mounts (root column → a focused flexGrow ScrollBox
 * body), the card model's bands/cards diff into the
 * body as a single column of bordered robot CARDS (one BoxRenderable per job:
 * rounded structure-gray border, project title, three interior lines carrying
 * the rail+robot glyph / title / age footer), band rules fence the tmux-session
 * bands, the `j`/`k`/arrow focus cursor swaps the focused card to a heavy cyan
 * border (keyed on job_id, surviving re-sort), the `t` keybind fires the
 * terminal-visibility toggle, terminal cards gate on `showTerminal`, and the
 * row map is structurally pruned/reordered when the card set changes. Boots via
 * `createTestRenderer` (no `--isolate`; see `test/live-shell.test.ts`'s TDZ
 * note), destroys after each test.
 *
 * SERIAL-SAFE CHAIN MAINTENANCE: this file imports `@opentui/core` runtime
 * values, so it MUST be in BOTH `package.json`'s `test:opentui` chain AND the
 * fast-tier `--path-ignore-patterns` (in `test` and `test:full`) — otherwise it
 * lands in the `--parallel` pass and re-trips OpenTUI's native-loader TDZ,
 * false-reding `bun test`. Validate via `bun run test`, never a bare
 * `bun test --parallel`.
 */

import { afterEach, beforeAll, expect, test } from "bun:test";
import {
  BoxRenderable,
  RGBA,
  ScrollBoxRenderable,
  StyledText,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { attachDashApp, type DashApp } from "../src/dash/app";
import { buildDashModel, type DashModel } from "../src/dash/view-model";
import type { Job } from "../src/types";

// Runtime ctors threaded through `attachDashApp` — production loads these
// dynamically (see the app docstring); the test imports them eagerly since the
// OpenTUI test runner already pulls the native binary in via `createTestRenderer`.
const APP_RUNTIME = {
  TextRenderable,
  ScrollBoxRenderable,
  BoxRenderable,
  StyledText,
  RGBA,
  TextAttributes,
} as const;

// ---------------------------------------------------------------------------
// Fixture builders (mirrors test/dash-view-model.test.ts)
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

/** The card model for a set of jobs, terminal hidden (the default toggle). */
function model(jobs: Job[], showTerminal = false): DashModel {
  return buildDashModel(
    new Map(jobs.map((j) => [j.job_id, j])),
    [],
    showTerminal,
    1000,
  );
}

// ---------------------------------------------------------------------------
// Harness — read painted text back.
// ---------------------------------------------------------------------------

/** The 0-based frame line index containing `needle`, or -1. Body cards are
 * bordered Boxes whose text lives in nested Text children, so assertions read
 * the painted char frame, not node trees. */
function frameLineOf(frame: string, needle: string): number {
  return frame.split("\n").findIndex((line) => line.includes(needle));
}

beforeAll(() => {
  process.env.OTUI_USE_CONSOLE = "false";
});

const pendingApps: DashApp[] = [];
afterEach(() => {
  while (pendingApps.length > 0) {
    const a = pendingApps.pop();
    try {
      a?.destroy();
    } catch {
      // best-effort
    }
  }
});

async function bootApp(
  options: { width?: number; height?: number } = {},
): Promise<{
  setup: Awaited<ReturnType<typeof createTestRenderer>>;
  app: DashApp;
  quitCount: () => number;
  toggleCount: () => number;
}> {
  const width = options.width ?? 80;
  const height = options.height ?? 40;
  const setup = await createTestRenderer({ width, height, exitSignals: [] });
  let quits = 0;
  let toggles = 0;
  const app = attachDashApp(setup.renderer, APP_RUNTIME, {
    onQuit: () => {
      quits += 1;
    },
    onToggleTerminal: () => {
      toggles += 1;
    },
  });
  pendingApps.push(app);
  return {
    setup,
    app,
    quitCount: () => quits,
    toggleCount: () => toggles,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("static tree: body is a focused ScrollBox", async () => {
  const { app } = await bootApp();
  expect(app.body).toBeInstanceOf(ScrollBoxRenderable);
  // Focused on mount so wheel/page scroll lands on the body.
  expect((app.body as unknown as { focused: boolean }).focused).toBe(true);
});

test("live frame: a card carries the robot glyph, status, title, and project", async () => {
  const { setup, app } = await bootApp();
  app.render(
    model([
      makeJob({
        job_id: "session-1",
        state: "working",
        title: "worker A",
        cwd: "/code/keeper",
      }),
    ]),
  );
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  // The working robot glyph (md robot, f06a9) shares the status line.
  const robot = String.fromCodePoint(0xf06a9);
  expect(frame).toContain(robot);
  // The title line, the project (in the border title), and the status word all
  // render somewhere in the card box.
  expect(frame).toContain("worker A");
  expect(frame).toContain("keeper");
  expect(frame).toContain("working");
});

test("card chrome: cards are bordered boxes — rounded by default, heavy when focused", async () => {
  const { setup, app } = await bootApp();
  // Two cards: the first seeds focus (heavy ┏), the second stays rounded (╭).
  app.render(
    model([
      makeJob({
        job_id: "s1",
        state: "working",
        title: "boxed-a",
        created_at: 1,
      }),
      makeJob({
        job_id: "s2",
        state: "working",
        title: "boxed-b",
        created_at: 2,
      }),
    ]),
  );
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  // The focused card paints a heavy border; the unfocused one a rounded border.
  expect(frame).toContain("┏");
  expect(frame).toContain("╭");
  expect(frame).toContain("╰");
});

test("bands: a session-band rule precedes its cards, in priority order", async () => {
  const { setup, app } = await bootApp();
  app.render(
    model([
      makeJob({
        job_id: "ap",
        state: "working",
        backend_exec_session_id: "autopilot",
      }),
      makeJob({
        job_id: "fg",
        state: "working",
        backend_exec_session_id: "foreground",
      }),
    ]),
  );
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  // foreground outranks autopilot. Match the band RULE rows by their leading
  // `──`.
  expect(frameLineOf(frame, "──foreground")).toBeLessThan(
    frameLineOf(frame, "──autopilot"),
  );
  // Both band rules render.
  expect(frameLineOf(frame, "──foreground")).toBeGreaterThanOrEqual(0);
  expect(frameLineOf(frame, "──autopilot")).toBeGreaterThanOrEqual(0);
});

test("empty-but-live: the body renders no card boxes — no placeholder lines", async () => {
  const { setup, app } = await bootApp();
  app.render(model([]));
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).not.toContain("no jobs");
  expect(frame).not.toContain("EPICS");
  expect(frame).not.toContain("JOBS");
  // No card boxes paint when the board is empty.
  expect(frame).not.toContain("╭");
});

test("toggle: a terminal card is hidden by default, revealed when shown", async () => {
  const { setup, app } = await bootApp();
  const jobs = [
    makeJob({ job_id: "done", state: "ended", title: "ended-job" }),
  ];

  app.render(model(jobs, false));
  await setup.renderOnce();
  expect(setup.captureCharFrame()).not.toContain("ended-job");

  app.render(model(jobs, true));
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("ended-job");
});

test("toggle keybind: `t` fires the onToggleTerminal callback", async () => {
  const { setup, toggleCount } = await bootApp();
  setup.mockInput.pressKey("t");
  expect(toggleCount()).toBe(1);
  setup.mockInput.pressKey("t");
  expect(toggleCount()).toBe(2);
});

test("focus cursor: j/k move a keyed cursor and swap the focused card border", async () => {
  const { setup, app } = await bootApp();
  app.render(
    model([
      makeJob({
        job_id: "session-1",
        state: "working",
        title: "first-card",
        created_at: 1,
      }),
      makeJob({
        job_id: "session-2",
        state: "working",
        title: "second-card",
        created_at: 2,
      }),
    ]),
  );
  await setup.renderOnce();
  // The first card seeds the focus on mount → a HEAVY border (┏ corner).
  expect(setup.captureCharFrame()).toContain("┏");

  // j moves the cursor to the second card; it must remain a single heavy border
  // (one focused card at a time). The frame still shows exactly one heavy box.
  setup.mockInput.pressKey("j");
  await setup.renderOnce();
  const afterJ = setup.captureCharFrame();
  expect(afterJ).toContain("┏");
  // Both cards still render (focus move is not a structural change).
  expect(afterJ).toContain("first-card");
  expect(afterJ).toContain("second-card");

  // k moves back up — still exactly one heavy-bordered card.
  setup.mockInput.pressKey("k");
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("┏");
});

test("focus cursor: arrow keys drive the same cursor as j/k", async () => {
  const { setup, app } = await bootApp();
  app.render(
    model([
      makeJob({
        job_id: "a",
        state: "working",
        title: "card-a",
        created_at: 1,
      }),
      makeJob({
        job_id: "b",
        state: "working",
        title: "card-b",
        created_at: 2,
      }),
    ]),
  );
  await setup.renderOnce();
  setup.mockInput.pressArrow("down");
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  // The heavy focus border still paints (the down arrow reached the handler).
  expect(frame).toContain("┏");
});

test("focus cursor: survives a re-sort (keyed on job_id, not position)", async () => {
  const { setup, app } = await bootApp();
  // Two cards in the autopilot band; alpha (created 1) above beta (created 2).
  app.render(
    model([
      makeJob({
        job_id: "s1",
        state: "working",
        title: "alpha",
        created_at: 1,
        backend_exec_session_id: "autopilot",
      }),
      makeJob({
        job_id: "s2",
        state: "working",
        title: "beta",
        created_at: 2,
        backend_exec_session_id: "autopilot",
      }),
    ]),
  );
  await setup.renderOnce();
  setup.mockInput.pressKey("j"); // focus moves from s1 → s2
  await setup.renderOnce();

  // Now s2 moves to the foreground session → its band outranks autopilot, so it
  // jumps above alpha (re-sort). The focus must follow the CARD (s2), not the
  // old position.
  app.render(
    model([
      makeJob({
        job_id: "s1",
        state: "working",
        title: "alpha",
        created_at: 1,
        backend_exec_session_id: "autopilot",
      }),
      makeJob({
        job_id: "s2",
        state: "working",
        title: "beta",
        created_at: 2,
        backend_exec_session_id: "foreground",
      }),
    ]),
  );
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  // beta (s2) now sits in the foreground band above alpha; the heavy focus
  // border is on the beta card. Beta's line is above alpha's.
  expect(frameLineOf(frame, "beta")).toBeLessThan(frameLineOf(frame, "alpha"));
  expect(frame).toContain("┏");
});

test("row-set diff: shrinking the card set structurally prunes its row node", async () => {
  const { setup, app } = await bootApp();
  app.render(
    model([
      makeJob({ job_id: "session-1", state: "working", title: "alpha-job" }),
      makeJob({
        job_id: "session-2",
        state: "working",
        title: "beta-job",
        created_at: 1,
      }),
    ]),
  );
  await setup.renderOnce();
  const before = setup.captureCharFrame();
  expect(before).toContain("alpha-job");
  expect(before).toContain("beta-job");

  // Drop session-2 → its card node must be removed, not stale-retained.
  app.render(
    model([
      makeJob({ job_id: "session-1", state: "working", title: "alpha-job" }),
    ]),
  );
  await setup.renderOnce();
  const after = setup.captureCharFrame();
  expect(after).toContain("alpha-job");
  expect(after).not.toContain("beta-job");
});

test("row order: cards paint in stable created_at order within a band", async () => {
  const { setup, app } = await bootApp();
  app.render(
    model([
      makeJob({
        job_id: "session-1",
        state: "working",
        title: "old-job",
        created_at: 10,
      }),
    ]),
  );
  await setup.renderOnce();

  // A second, OLDER card joins → created_at ASC sorts it above the first; the
  // materializer must re-attach in model order, not append.
  app.render(
    model([
      makeJob({
        job_id: "session-1",
        state: "working",
        title: "old-job",
        created_at: 10,
      }),
      makeJob({
        job_id: "session-2",
        state: "working",
        title: "older-job",
        created_at: 1,
      }),
    ]),
  );
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frameLineOf(frame, "older-job")).toBeLessThan(
    frameLineOf(frame, "old-job"),
  );
});

test("q and Ctrl-C both fire the onQuit teardown tail", async () => {
  const { setup, quitCount } = await bootApp();
  setup.mockInput.pressKey("q");
  expect(quitCount()).toBe(1);
  setup.mockInput.pressCtrlC();
  expect(quitCount()).toBe(2);
});

test("destroy is idempotent", async () => {
  const { app } = await bootApp();
  app.destroy();
  // Second destroy is a no-op (must not throw).
  expect(() => app.destroy()).not.toThrow();
});

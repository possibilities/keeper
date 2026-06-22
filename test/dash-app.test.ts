/**
 * Frame test for the `keeper dash` materializer (`src/dash/app.ts`
 * `attachDashApp`). Proves the OpenTUI paint surface over the robot job model:
 * the static tree mounts (root column → a focused flexGrow ScrollBox body), the
 * model's bands/lines diff into the body as a flat list of one-line jobs
 * (`<caret><icon> <title> · <project>`, no box, no border), band rules fence the
 * tmux-session bands, the `j`/`k`/arrow SELECTION cursor marks the current line
 * with a cyan caret (keyed on job_id, surviving re-sort), the `t` keybind fires
 * the terminal-visibility toggle, terminal lines gate on `showTerminal`, and the
 * row map is structurally pruned/reordered when the line set changes. Boots via
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

/** The dash model for a set of jobs, terminal hidden (the default toggle). */
function model(jobs: Job[], showTerminal = false): DashModel {
  return buildDashModel(new Map(jobs.map((j) => [j.job_id, j])), showTerminal);
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

// The selection caret marks exactly one line. Return that line's text (or "")
// so a test can assert WHICH job is selected by its title.
const SELECT_CARET = "❯";
function selectedLine(frame: string): string {
  return frame.split("\n").find((line) => line.includes(SELECT_CARET)) ?? "";
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

test("live frame: a job line carries the robot icon, job name, and project", async () => {
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
  // The working robot glyph (md robot, f06a9) leads the line.
  const robot = String.fromCodePoint(0xf06a9);
  expect(frame).toContain(robot);
  // The job name and the project both render on the one line.
  expect(frame).toContain("worker A");
  expect(frame).toContain("keeper");
});

test("line chrome: jobs are plain lines — no box borders", async () => {
  const { setup, app } = await bootApp();
  app.render(
    model([
      makeJob({
        job_id: "s1",
        state: "working",
        title: "plain-a",
        created_at: 1,
      }),
      makeJob({
        job_id: "s2",
        state: "working",
        title: "plain-b",
        created_at: 2,
      }),
    ]),
  );
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  // No rounded or heavy box borders anywhere — jobs are bare lines.
  expect(frame).not.toContain("╭");
  expect(frame).not.toContain("┏");
  // The first line seeds the selection caret; exactly one line carries it.
  expect(selectedLine(frame)).toContain("plain-a");
});

test("bands: a session-band rule precedes its job lines, in priority order", async () => {
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

test("empty-but-live: the body renders nothing — no placeholder lines", async () => {
  const { setup, app } = await bootApp();
  app.render(model([]));
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).not.toContain("no jobs");
  expect(frame).not.toContain("EPICS");
  expect(frame).not.toContain("JOBS");
  // Nothing paints when the board is empty — no band rules, no caret.
  expect(frame).not.toContain("──");
  expect(frame).not.toContain(SELECT_CARET);
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

test("selection cursor: j/k move a keyed caret across job lines", async () => {
  const { setup, app } = await bootApp();
  app.render(
    model([
      makeJob({
        job_id: "session-1",
        state: "working",
        title: "first-line",
        created_at: 1,
      }),
      makeJob({
        job_id: "session-2",
        state: "working",
        title: "second-line",
        created_at: 2,
      }),
    ]),
  );
  await setup.renderOnce();
  // The first line seeds the selection on mount → the caret sits on it.
  expect(selectedLine(setup.captureCharFrame())).toContain("first-line");

  // j moves the caret to the second line (one selected line at a time).
  setup.mockInput.pressKey("j");
  await setup.renderOnce();
  const afterJ = setup.captureCharFrame();
  expect(selectedLine(afterJ)).toContain("second-line");
  // Both lines still render (a selection move is not a structural change).
  expect(afterJ).toContain("first-line");
  expect(afterJ).toContain("second-line");

  // k moves the caret back up to the first line.
  setup.mockInput.pressKey("k");
  await setup.renderOnce();
  expect(selectedLine(setup.captureCharFrame())).toContain("first-line");
});

test("selection cursor: arrow keys drive the same caret as j/k", async () => {
  const { setup, app } = await bootApp();
  app.render(
    model([
      makeJob({
        job_id: "a",
        state: "working",
        title: "line-a",
        created_at: 1,
      }),
      makeJob({
        job_id: "b",
        state: "working",
        title: "line-b",
        created_at: 2,
      }),
    ]),
  );
  await setup.renderOnce();
  setup.mockInput.pressArrow("down");
  await setup.renderOnce();
  // The down arrow reached the handler → caret moved to the second line.
  expect(selectedLine(setup.captureCharFrame())).toContain("line-b");
});

test("selection cursor: survives a re-sort (keyed on job_id, not position)", async () => {
  const { setup, app } = await bootApp();
  // Two lines in the autopilot band; alpha (created 1) above beta (created 2).
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
  // beta (s2) now sits in the foreground band above alpha; the caret followed
  // the line (keyed on job_id), and beta's line is above alpha's.
  expect(frameLineOf(frame, "beta")).toBeLessThan(frameLineOf(frame, "alpha"));
  expect(selectedLine(frame)).toContain("beta");
});

test("row-set diff: shrinking the line set structurally prunes its row node", async () => {
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

  // Drop session-2 → its line node must be removed, not stale-retained.
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

test("row order: lines paint in stable created_at order within a band", async () => {
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

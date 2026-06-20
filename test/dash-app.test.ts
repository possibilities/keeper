/**
 * Frame test for the `keeper dash` materializer (`src/dash/app.ts`
 * `attachDashApp`). Proves the OpenTUI paint surface over the robot job-card
 * model: the static tree mounts (root column → fixed census header + flexGrow
 * ScrollBox body, focused), the card model's header/bands/cards diff into the
 * body, a card line carries the robot glyph + title + project, band rules fence
 * the urgency bands, and the row map is structurally pruned/reordered when the
 * card set changes. This file paints task `.1`'s pure model through the thin
 * keyed-row bridge; task `.2` replaces the bridge with real boxed cards (rail
 * borders, focus cursor, the `t`/`j`/`k` keybinds) and broadens these frame
 * assertions. Boots via `createTestRenderer` (no `--isolate`; see
 * `test/live-shell.test.ts`'s TDZ note), destroys after each test.
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

function textContent(node: TextRenderable): string {
  const styled = node.content;
  const chunks = styled?.chunks ?? [];
  return chunks.map((c) => c.text).join("");
}

/** The 0-based frame line index containing `needle`, or -1. Body rows are
 * Boxes whose text lives in nested Text children, so assertions read the
 * painted char frame, not node trees. */
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
}> {
  const width = options.width ?? 80;
  const height = options.height ?? 20;
  const setup = await createTestRenderer({ width, height, exitSignals: [] });
  let quits = 0;
  const app = attachDashApp(setup.renderer, APP_RUNTIME, {
    onQuit: () => {
      quits += 1;
    },
  });
  pendingApps.push(app);
  return { setup, app, quitCount: () => quits };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("static tree: header fixed at row 0, body is a focused ScrollBox", async () => {
  const { app } = await bootApp();
  expect(app.header.height).toBe(1);
  expect(app.body).toBeInstanceOf(ScrollBoxRenderable);
  // Focused on mount so j/k/arrows scroll natively.
  expect((app.body as unknown as { focused: boolean }).focused).toBe(true);
});

test("census header: the census line renders behind the one-column margin", async () => {
  const { app } = await bootApp();
  app.render(model([makeJob({ job_id: "j", state: "working" })]));
  const header = textContent(app.header);
  expect(header.startsWith(" ")).toBe(true);
  expect(header).toContain("1 job");
  expect(header).toContain("in motion");
});

test("live frame: a card line carries the robot glyph, title, and project", async () => {
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
  // The working robot glyph (md robot, f06a9) and the title share a line.
  const robot = String.fromCodePoint(0xf06a9);
  const line = frame.split("\n")[frameLineOf(frame, "worker A")] ?? "";
  expect(line).toContain(robot);
  expect(line).toContain("worker A");
  // The project basename rides the same card line (right side).
  expect(line).toContain("keeper");
});

test("bands: a band rule precedes the cards of a non-empty band", async () => {
  const { setup, app } = await bootApp();
  app.render(
    model([
      makeJob({ job_id: "needy", state: "working", last_api_error_at: 1 }),
      makeJob({ job_id: "busy", state: "working" }),
    ]),
  );
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  // needs-you band (the api-error card) paints above the in-motion band.
  expect(frameLineOf(frame, "needs you")).toBeLessThan(
    frameLineOf(frame, "in motion"),
  );
});

test("empty-but-live: the body renders nothing — no placeholder lines", async () => {
  const { setup, app } = await bootApp();
  app.render(model([]));
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).not.toContain("no jobs");
  expect(frame).not.toContain("EPICS");
  expect(frame).not.toContain("JOBS");
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

  // Drop session-2 → its row node must be removed, not stale-retained.
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

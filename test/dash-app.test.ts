/**
 * Frame test for the `keeper dash` materializer (`src/dash/app.ts`
 * `attachDashApp`). Proves the OpenTUI paint surface: the static tree mounts
 * (root column → fixed header + flexGrow ScrollBox body, focused), the
 * view-model's header/PLAN/AGENTS segment rows diff into the body, the
 * connection-state waiting line replaces the body pre-paint, and the row map is
 * structurally pruned when the row set shrinks. Mirrors `test/live-shell.test.ts`
 * — boots via `createTestRenderer` (no `--isolate`; see that file's TDZ note),
 * destroys after each test.
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
import type { ReadinessSnapshot } from "../src/readiness";
import type { ReadinessClientSnapshot } from "../src/readiness-client";
import type { Epic, Job, Task } from "../src/types";

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

function liveModel(snapshot: ReadinessClientSnapshot): DashModel {
  return buildDashModel({
    snapshot,
    autopilotRows: [{ paused: 0, mode: "yolo" }],
    armedRows: [],
    connection: "live",
    nowSec: 1000,
  });
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
 * Boxes (split/section/divider/spacer) whose text lives in nested Text
 * children, so assertions read the painted char frame, not node trees. */
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

test("connecting: a null snapshot paints the waiting line; header gets its left margin", async () => {
  const { setup, app } = await bootApp();
  app.render(
    buildDashModel({
      snapshot: null,
      autopilotRows: [],
      armedRows: [],
      connection: "connecting",
      nowSec: 1000,
    }),
  );
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("waiting for keeperd…");
  // Header surfaces the connection marker pre-paint, behind the one-column
  // left margin that matches the body rows' padding.
  expect(textContent(app.header)).toContain("connecting…");
  expect(textContent(app.header).startsWith(" ")).toBe(true);
});

test("live frame: epic block with nested task above the job row, no pill words", async () => {
  const { setup, app } = await bootApp();
  const snap = makeSnap({
    epics: [
      makeEpic({
        title: "add oauth",
        project_dir: "/code/keeper",
        tasks: [makeTask({ title: "wire the flow" })],
      }),
    ],
    jobs: new Map([["session-1", makeJob({ title: "worker A" })]]),
    readiness: {
      ...emptyReadiness(),
      perEpic: new Map([["fn-1-foo", { tag: "ready" }]]),
      perTask: new Map([["fn-1-foo.1", { tag: "completed" }]]),
    },
  });
  app.render(liveModel(snap));
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  // The epic line carries number + title with the project basename at right.
  const epicLine = frame.split("\n")[frameLineOf(frame, "add oauth")] ?? "";
  expect(epicLine).toContain("1");
  expect(epicLine).toContain("keeper");
  expect(epicLine).not.toContain("/code");
  // The task nests below the epic; the job region renders below the tasks.
  expect(frameLineOf(frame, "wire the flow")).toBeGreaterThan(
    frameLineOf(frame, "add oauth"),
  );
  expect(frameLineOf(frame, "worker A")).toBeGreaterThan(
    frameLineOf(frame, "wire the flow"),
  );
  // No section labels, no pill words, no task-count fraction.
  expect(frame).not.toContain("EPICS");
  expect(frame).not.toContain("JOBS");
  expect(frame).not.toMatch(/\[\w+/);
  expect(frame).not.toMatch(/\d+\/\d+/);
  expect(frame).not.toContain("ready");
  // Live header carries no connection marker.
  expect(textContent(app.header)).not.toContain("connecting");
  expect(textContent(app.header)).not.toContain("reconnecting");
});

test("empty-but-live: the body renders nothing — no placeholder lines", async () => {
  const { setup, app } = await bootApp();
  app.render(liveModel(makeSnap()));
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).not.toContain("no open epics");
  expect(frame).not.toContain("no jobs");
  expect(frame).not.toContain("EPICS");
  expect(frame).not.toContain("JOBS");
});

test("row-set diff: shrinking the job set structurally prunes its row node", async () => {
  const { setup, app } = await bootApp();
  const two = makeSnap({
    jobs: new Map([
      ["session-1", makeJob({ job_id: "session-1", title: "alpha-job" })],
      [
        "session-2",
        makeJob({ job_id: "session-2", title: "beta-job", created_at: 1 }),
      ],
    ]),
  });
  app.render(liveModel(two));
  await setup.renderOnce();
  const before = setup.captureCharFrame();
  expect(before).toContain("alpha-job");
  expect(before).toContain("beta-job");

  // Drop session-2 → its row node must be removed, not stale-retained.
  const one = makeSnap({
    jobs: new Map([
      ["session-1", makeJob({ job_id: "session-1", title: "alpha-job" })],
    ]),
  });
  app.render(liveModel(one));
  await setup.renderOnce();
  const after = setup.captureCharFrame();
  expect(after).toContain("alpha-job");
  expect(after).not.toContain("beta-job");
});

test("row order: a job arriving with newer recency paints ABOVE existing rows", async () => {
  const { setup, app } = await bootApp();
  const one = makeSnap({
    jobs: new Map([
      [
        "session-1",
        makeJob({ job_id: "session-1", title: "old-job", active_since: 10 }),
      ],
    ]),
  });
  app.render(liveModel(one));
  await setup.renderOnce();

  // A second job lands with newer active_since → the view-model sorts it
  // first; the materializer must re-attach in model order, not append.
  const two = makeSnap({
    jobs: new Map([
      [
        "session-1",
        makeJob({ job_id: "session-1", title: "old-job", active_since: 10 }),
      ],
      [
        "session-2",
        makeJob({ job_id: "session-2", title: "new-job", active_since: 50 }),
      ],
    ]),
  });
  app.render(liveModel(two));
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frameLineOf(frame, "new-job")).toBeLessThan(
    frameLineOf(frame, "old-job"),
  );
});

test("reconnecting: header marker shows while the last-good body stays painted", async () => {
  const { setup, app } = await bootApp();
  const snap = makeSnap({
    epics: [makeEpic({ title: "add oauth" })],
  });
  // First paint live, then a reconnecting frame that retains the snapshot.
  app.render(liveModel(snap));
  await setup.renderOnce();
  app.render(
    buildDashModel({
      snapshot: snap,
      autopilotRows: [{ paused: 0, mode: "yolo" }],
      armedRows: [],
      connection: "reconnecting",
      nowSec: 1000,
    }),
  );
  await setup.renderOnce();
  // Body still shows the epic (frozen at last-good), header shows the marker.
  expect(setup.captureCharFrame()).toContain("add oauth");
  expect(textContent(app.header)).toContain("reconnecting…");
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

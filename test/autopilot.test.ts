/**
 * Tests for `cli/autopilot.ts`'s thin viewer + control surface (fn-661.5).
 *
 * Three concerns, mirroring the task's acceptance:
 *
 *   (1) Render — pure transforms over fixtures:
 *       - `buildCurrentRows` projects the readiness snapshot's `jobs` map
 *         into the `--- current ---` rows the viewer paints.
 *       - `renderDependencyGraph` projects the open tasks into the
 *         `--- dependencies ---` ASCII DAG.
 *       - `projectFailedRows` projects the wire `dispatch_failures` rows
 *         into the `--- failed ---` shape.
 *       - `renderBody` ties them together and emits the body lines in the
 *         documented order (current → stopped → failed → dependencies,
 *         sections only when non-empty).
 *
 *   (2) Control — pause / play / retry emit well-formed RPC frames:
 *       - `buildSetPausedFrame(id, paused)` shape (method, params).
 *       - `buildRetryFrame(id, dispatchKey)` shape (method, params).
 *
 *   (3) No dispatch / dedup logic survives client-side — the legacy
 *       suppression / settling / dispatch.log / surface-probe helpers are
 *       gone from the import surface, so this file imports only the thin
 *       viewer symbols.
 */

import { describe, expect, test } from "bun:test";
import {
  AUTOPILOT_SHOW_SCHEMA_VERSION,
  assertNoMidEpicDispatch,
  autopilotBannerLabel,
  buildAutopilotShowEnvelope,
  buildCurrentRows,
  buildRetryFrame,
  buildSetArmedFrame,
  buildSetConfigFrame,
  buildSetModeFrame,
  buildSetPausedFrame,
  type FailedRow,
  projectArmedEpics,
  projectAutopilotMode,
  projectAutopilotPaused,
  projectFailedRows,
  projectMaxConcurrentJobs,
  projectMaxConcurrentPerRoot,
  projectWorktreeMode,
  projectWorktreeMultiRepo,
  projectWorktreeStatusRows,
  renderBody,
  renderDependencyGraph,
  runAutopilotShow,
} from "../cli/autopilot";
import { computeReadiness } from "../src/readiness";
import type {
  DeadLetter,
  Epic,
  GitStatus,
  Job,
  SubagentInvocation,
  Task,
} from "../src/types";

// ---------------------------------------------------------------------------
// Fixture builders — same shape every test file in this repo uses.
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task>): Task {
  return {
    task_id: "fn-1-foo.1",
    epic_id: "fn-1-foo",
    task_number: 1,
    title: "task",
    target_repo: null,
    tier: null,
    model: null,
    worker_phase: "open",
    runtime_status: "todo",
    depends_on: [],
    jobs: [],
    ...overrides,
  };
}

function makeEpic(overrides: Partial<Epic>): Epic {
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
    resolved_epic_deps: null,
    last_validated_at: "2026-05-24T00:00:00Z",
    question: null,
    ...overrides,
  };
}

function makeJob(overrides: Partial<Job>): Job {
  return {
    job_id: "j-1",
    created_at: 0,
    cwd: null,
    pid: null,
    state: "working",
    last_event_id: 0,
    updated_at: 0,
    title: null,
    title_source: null,
    transcript_path: null,
    start_time: null,
    plan_verb: null,
    plan_ref: null,
    epic_links: [],
    last_api_error_at: null,
    last_api_error_kind: null,
    last_input_request_at: null,
    last_input_request_kind: null,
    last_permission_prompt_at: null,
    last_permission_prompt_kind: null,
    config_dir: null,
    git_dirty_count: 0,
    git_unattributed_to_live_count: 0,
    git_orphan_count: 0,
    ...overrides,
  } as Job;
}

function buildSnap(
  epics: Epic[],
  jobs: Map<string, Job> = new Map(),
  options: {
    subagentInvocations?: SubagentInvocation[];
    gitStatus?: GitStatus[];
    deadLetters?: DeadLetter[];
    gitStatusByProjectDir?: Map<
      string,
      { dirty_count: number; unattributed_to_live_count: number }
    >;
  } = {},
) {
  const readiness = computeReadiness(
    epics,
    jobs,
    options.subagentInvocations ?? [],
    options.gitStatusByProjectDir ?? new Map(),
  );
  return {
    epics,
    completedEpics: [],
    jobs,
    subagentInvocations: options.subagentInvocations ?? [],
    gitStatus: options.gitStatus ?? [],
    deadLetters: options.deadLetters ?? [],
    // fn-721: the 6th collection on `ReadinessClientSnapshot`. Empty default;
    // this CLI-path fixture doesn't exercise the launch-window occupant.
    pendingDispatches: [],
    // fn-813: the scheduled-tasks (cron) collection. Empty default; this
    // CLI-path fixture doesn't exercise the jobs-TUI cron detail section.
    scheduledTasks: [],
    // fn-941: the block-escalation latch collection + autopilot paused flag.
    // Empty / unpaused defaults; this CLI-path fixture doesn't exercise the
    // escalated-but-paused await softening.
    blockEscalations: [],
    autopilotPaused: false,
    // fn-1015: the un-dropped autopilot mode / caps / worktree. Safe-side
    // defaults (yolo · unlimited jobs · per-root 1 · worktree off); this
    // CLI-path fixture doesn't exercise the orient surface built on them.
    autopilotMode: "yolo" as const,
    maxConcurrentJobs: null,
    maxConcurrentPerRoot: 1,
    worktreeMode: false,
    worktreeMultiRepo: false,
    readiness,
  };
}

// ---------------------------------------------------------------------------
// buildCurrentRows — projects the live jobs map into the current section.
// ---------------------------------------------------------------------------

test("buildCurrentRows — surfaces working dispatch jobs (work/close/approve), filters terminal + non-dispatch verbs", () => {
  const jobs = new Map<string, Job>([
    [
      "j-work",
      makeJob({
        job_id: "j-work",
        plan_verb: "work",
        plan_ref: "fn-1-foo.1",
        cwd: "/repo",
        state: "working",
        created_at: 100,
      }),
    ],
    [
      "j-close",
      makeJob({
        job_id: "j-close",
        plan_verb: "close",
        plan_ref: "fn-1-foo",
        cwd: "/repo",
        state: "stopped",
        created_at: 200,
      }),
    ],
    [
      "j-approve",
      makeJob({
        job_id: "j-approve",
        plan_verb: "approve",
        plan_ref: "fn-1-foo.2",
        cwd: "/repo",
        state: "working",
        created_at: 50,
      }),
    ],
    [
      // Terminal — dropped.
      "j-ended",
      makeJob({
        job_id: "j-ended",
        plan_verb: "work",
        plan_ref: "fn-1-foo.3",
        cwd: "/repo",
        state: "ended",
        created_at: 300,
      }),
    ],
    [
      // plan verb — not a dispatch verb; dropped.
      "j-plan",
      makeJob({
        job_id: "j-plan",
        plan_verb: "plan",
        plan_ref: "fn-1-foo",
        cwd: "/repo",
        state: "working",
        created_at: 400,
      }),
    ],
    [
      // No plan_ref — dropped.
      "j-orphan",
      makeJob({
        job_id: "j-orphan",
        plan_verb: "work",
        plan_ref: null,
        cwd: "/repo",
        state: "working",
        created_at: 500,
      }),
    ],
  ]);
  const snap = buildSnap([], jobs);
  const rows = buildCurrentRows(snap);
  expect(rows.map((r) => `${r.verb}::${r.id}`)).toEqual([
    // Sorted oldest-first by created_at.
    "approve::fn-1-foo.2", // 50
    "work::fn-1-foo.1", // 100
    "close::fn-1-foo", // 200
  ]);
  expect(rows.every((r) => r.dir === "repo")).toBe(true);
});

test("buildCurrentRows — empty jobs map yields no rows", () => {
  const snap = buildSnap([], new Map());
  expect(buildCurrentRows(snap)).toEqual([]);
});

test("buildCurrentRows — empty cwd renders as empty dir", () => {
  const jobs = new Map<string, Job>([
    [
      "j-1",
      makeJob({
        job_id: "j-1",
        plan_verb: "work",
        plan_ref: "fn-1-foo.1",
        cwd: null,
        state: "working",
      }),
    ],
  ]);
  const snap = buildSnap([], jobs);
  const rows = buildCurrentRows(snap);
  expect(rows).toHaveLength(1);
  expect(rows[0].dir).toBe("");
});

// ---------------------------------------------------------------------------
// projectFailedRows — typed projection of the dispatch_failures wire rows.
// ---------------------------------------------------------------------------

test("projectFailedRows — projects wire rows into the typed FailedRow shape", () => {
  const wire = [
    {
      verb: "work",
      id: "fn-1-foo.1",
      reason: "confirm timeout",
      dir: "/repo",
      ts: "2026-05-31T12:00:00Z",
      last_event_id: 42,
      created_at: 1,
      updated_at: 1,
    },
    {
      verb: "approve",
      id: "fn-1-foo.2",
      reason: "launch failed: ENOENT",
      dir: "/other",
      ts: "2026-05-31T11:00:00Z",
      last_event_id: 41,
      created_at: 2,
      updated_at: 2,
    },
  ];
  const rows = projectFailedRows(wire);
  expect(rows).toEqual([
    {
      verb: "work",
      id: "fn-1-foo.1",
      reason: "confirm timeout",
      dir: "/repo",
      ts: "2026-05-31T12:00:00Z",
    },
    {
      verb: "approve",
      id: "fn-1-foo.2",
      reason: "launch failed: ENOENT",
      dir: "/other",
      ts: "2026-05-31T11:00:00Z",
    },
  ]);
});

test("projectFailedRows — null / missing fields coerce to empty string (defensive against partial wire rows)", () => {
  const wire = [
    {
      // Missing every column.
    },
  ];
  const rows = projectFailedRows(wire);
  expect(rows).toEqual([{ verb: "", id: "", reason: "", dir: "", ts: "" }]);
});

test("projectFailedRows — empty wire array yields empty output", () => {
  expect(projectFailedRows([])).toEqual([]);
});

// ---------------------------------------------------------------------------
// projectWorktreeStatusRows — typed projection of the worktree_repo_status
// (fn-1013) wire rows (the neutral worktree-disabled operator surface).
// ---------------------------------------------------------------------------

test("projectWorktreeStatusRows — projects + sorts wire rows, basenaming repo_dir", () => {
  const wire = [
    {
      epic_id: "fn-3-cargo",
      repo_dir: "/code/zellijsub",
      mode: "serial",
      reason: "worktree-disabled:workspace-marker:cargo-workspace",
      last_event_id: 9,
      updated_at: 2,
    },
    {
      epic_id: "fn-2-mono",
      repo_dir: "/code/arthack",
      mode: "serial",
      reason: "worktree-disabled:workspace-marker:pnpm-workspace",
      last_event_id: 8,
      updated_at: 1,
    },
  ];
  // Sorted by epic_id ASC; repo_dir → basename.
  expect(projectWorktreeStatusRows(wire)).toEqual([
    {
      epicId: "fn-2-mono",
      dir: "arthack",
      mode: "serial",
      reason: "worktree-disabled:workspace-marker:pnpm-workspace",
    },
    {
      epicId: "fn-3-cargo",
      dir: "zellijsub",
      mode: "serial",
      reason: "worktree-disabled:workspace-marker:cargo-workspace",
    },
  ]);
});

test("projectWorktreeStatusRows — a row missing epic_id is dropped; empty dir stays empty; mode defaults to serial", () => {
  const wire = [
    { repo_dir: "/r", reason: "no-pk" },
    { epic_id: "fn-9-x", repo_dir: "", reason: "no-manifest" },
  ];
  expect(projectWorktreeStatusRows(wire)).toEqual([
    { epicId: "fn-9-x", dir: "", mode: "serial", reason: "no-manifest" },
  ]);
});

test("projectWorktreeStatusRows — empty wire array yields empty output", () => {
  expect(projectWorktreeStatusRows([])).toEqual([]);
});

// ---------------------------------------------------------------------------
// renderBody — five sections, each only emitted when non-empty, in priority
// order: current → stopped → failed → armed → worktree → dependencies.
// ---------------------------------------------------------------------------

test("renderBody — empty input renders no lines", () => {
  expect(
    renderBody({
      current: [],
      failed: [],
      paused: true,
    }),
  ).toEqual([]);
});

test("renderBody — only current populated renders only the current header + rows", () => {
  const lines = renderBody({
    current: [
      {
        verb: "work",
        id: "fn-1-foo.1",
        dir: "repo",
        state: "working",
        created_at: 10,
      },
      {
        verb: "close",
        id: "fn-1-foo",
        dir: "repo",
        state: "working",
        created_at: 20,
      },
    ],
    failed: [],
    paused: false,
  });
  expect(lines).toEqual([
    "--- current ---",
    "(repo) work::fn-1-foo.1",
    "(repo) close::fn-1-foo",
  ]);
});

test("renderBody — only dependencies populated renders only the dependencies block", () => {
  const lines = renderBody({
    current: [],
    dependencies: ["fn-1-foo", "  ○ .1", "  · .2  ← .1"],
    failed: [],
    paused: false,
  });
  expect(lines).toEqual([
    "--- dependencies ---",
    "legend: ✓ done  ▸ running  ○ ready  · blocked   (← waits for)",
    "fn-1-foo",
    "  ○ .1",
    "  · .2  ← .1",
  ]);
});

test("renderBody — only failed populated renders failed header + reason-tagged rows", () => {
  const failed: FailedRow[] = [
    {
      verb: "work",
      id: "fn-1-foo.1",
      reason: "confirm timeout",
      dir: "/repo",
      ts: "2026-05-31T12:00:00Z",
    },
    {
      verb: "approve",
      id: "fn-2-bar.2",
      reason: "launch failed",
      dir: "",
      ts: "2026-05-31T11:00:00Z",
    },
  ];
  const lines = renderBody({
    current: [],
    failed,
    paused: false,
  });
  expect(lines).toEqual([
    "--- failed ---",
    "(/repo) work::fn-1-foo.1 — confirm timeout",
    "approve::fn-2-bar.2 — launch failed",
  ]);
});

test("renderBody — all four sections emit together in current → stopped → failed → dependencies order", () => {
  const lines = renderBody({
    current: [
      {
        verb: "work",
        id: "fn-1-foo.1",
        dir: "repo",
        state: "working",
        created_at: 10,
      },
      {
        verb: "close",
        id: "fn-1-foo",
        dir: "repo",
        state: "stopped",
        created_at: 30,
      },
    ],
    dependencies: ["fn-1-foo", "  ▸ .1"],
    failed: [
      {
        verb: "work",
        id: "fn-1-foo.3",
        reason: "confirm timeout",
        dir: "/repo",
        ts: "2026-05-31T12:00:00Z",
      },
    ],
    paused: false,
  });
  expect(lines).toEqual([
    "--- current ---",
    "(repo) work::fn-1-foo.1",
    "--- stopped ---",
    "(repo) close::fn-1-foo",
    "--- failed ---",
    "(/repo) work::fn-1-foo.3 — confirm timeout",
    "--- dependencies ---",
    "legend: ✓ done  ▸ running  ○ ready  · blocked   (← waits for)",
    "fn-1-foo",
    "  ▸ .1",
  ]);
});

test("renderBody — armed section lists the explicitly-armed epic ids (fn-751)", () => {
  const lines = renderBody({
    current: [],
    failed: [],
    paused: false,
    armed: ["fn-1-foo", "fn-2-bar"],
  });
  expect(lines).toEqual(["--- armed ---", "fn-1-foo", "fn-2-bar"]);
});

test("renderBody — empty/absent armed set renders no armed section (fn-751)", () => {
  // The "nothing armed in armed mode" callout lives on the BANNER, not the
  // body — an empty armed set emits no `--- armed ---` header here.
  expect(
    renderBody({ current: [], failed: [], paused: false, armed: [] }),
  ).toEqual([]);
  expect(renderBody({ current: [], failed: [], paused: false })).toEqual([]);
});

test("renderBody — armed section sits between failed and dependencies (fn-751)", () => {
  const lines = renderBody({
    current: [],
    failed: [
      {
        verb: "work",
        id: "fn-1-foo.3",
        reason: "confirm timeout",
        dir: "/repo",
        ts: "2026-05-31T12:00:00Z",
      },
    ],
    armed: ["fn-7-armed"],
    dependencies: ["fn-1-foo", "  ▸ .1"],
    paused: false,
  });
  expect(lines).toEqual([
    "--- failed ---",
    "(/repo) work::fn-1-foo.3 — confirm timeout",
    "--- armed ---",
    "fn-7-armed",
    "--- dependencies ---",
    "legend: ✓ done  ▸ running  ○ ready  · blocked   (← waits for)",
    "fn-1-foo",
    "  ▸ .1",
  ]);
});

test("renderBody — worktree section lists disabled epics as a neutral mode (reason) line (fn-1013)", () => {
  const lines = renderBody({
    current: [],
    failed: [],
    paused: false,
    worktree: [
      {
        epicId: "fn-2-mono",
        dir: "arthack",
        mode: "serial",
        reason: "worktree-disabled:workspace-marker:pnpm-workspace",
      },
      { epicId: "fn-9-bare", dir: "", mode: "serial", reason: "no-manifest" },
    ],
  });
  expect(lines).toEqual([
    "--- worktree ---",
    "(arthack) fn-2-mono — serial (worktree-disabled:workspace-marker:pnpm-workspace)",
    "fn-9-bare — serial (no-manifest)",
  ]);
});

test("renderBody — empty/absent worktree set renders no worktree section (fn-1013)", () => {
  expect(
    renderBody({ current: [], failed: [], paused: false, worktree: [] }),
  ).toEqual([]);
  expect(renderBody({ current: [], failed: [], paused: false })).toEqual([]);
});

test("renderBody — worktree section sits between armed and dependencies, distinct from failed (fn-1013)", () => {
  const lines = renderBody({
    current: [],
    failed: [
      {
        verb: "close",
        id: "fn-1-foo",
        reason: "worktree-multi-repo",
        dir: "/repo",
        ts: "2026-05-31T12:00:00Z",
      },
    ],
    armed: ["fn-7-armed"],
    worktree: [
      { epicId: "fn-2-mono", dir: "arthack", mode: "serial", reason: "r" },
    ],
    dependencies: ["fn-1-foo", "  ▸ .1"],
    paused: false,
  });
  expect(lines).toEqual([
    "--- failed ---",
    "(/repo) close::fn-1-foo — worktree-multi-repo",
    "--- armed ---",
    "fn-7-armed",
    "--- worktree ---",
    "(arthack) fn-2-mono — serial (r)",
    "--- dependencies ---",
    "legend: ✓ done  ▸ running  ○ ready  · blocked   (← waits for)",
    "fn-1-foo",
    "  ▸ .1",
  ]);
});

test("renderBody — only stopped populated renders only the stopped header + rows", () => {
  const lines = renderBody({
    current: [
      {
        verb: "work",
        id: "fn-1-foo.1",
        dir: "repo",
        state: "stopped",
        created_at: 10,
      },
      {
        verb: "close",
        id: "fn-1-foo",
        dir: "repo",
        state: "stopped",
        created_at: 20,
      },
    ],
    failed: [],
    paused: false,
  });
  expect(lines).toEqual([
    "--- stopped ---",
    "(repo) work::fn-1-foo.1",
    "(repo) close::fn-1-foo",
  ]);
});

// ---------------------------------------------------------------------------
// Control RPC frame builders — well-formed wire shape.
// ---------------------------------------------------------------------------

test("buildSetPausedFrame — pause emits the canonical RPC shape", () => {
  const frame = buildSetPausedFrame("rpc-uuid-1", true);
  expect(frame).toEqual({
    type: "rpc",
    id: "rpc-uuid-1",
    method: "set_autopilot_paused",
    params: { paused: true },
  });
});

test("buildSetPausedFrame — play emits paused:false", () => {
  const frame = buildSetPausedFrame("rpc-uuid-2", false);
  expect(frame).toEqual({
    type: "rpc",
    id: "rpc-uuid-2",
    method: "set_autopilot_paused",
    params: { paused: false },
  });
});

test("buildRetryFrame — emits the canonical retry_dispatch RPC shape", () => {
  const frame = buildRetryFrame("rpc-uuid-3", "work::fn-619-foo.3");
  expect(frame).toEqual({
    type: "rpc",
    id: "rpc-uuid-3",
    method: "retry_dispatch",
    params: { id: "work::fn-619-foo.3" },
  });
});

test("buildRetryFrame — passes the dispatch key verbatim (server validates the shape)", () => {
  // The viewer doesn't validate — the daemon's `parseDispatchKey` is the
  // wire boundary's canonical validator. Pass the malformed shape through
  // unchanged so the server's typed rejection surfaces to the caller.
  const frame = buildRetryFrame("rpc-uuid-4", "garbage");
  expect((frame as unknown as { params: { id: string } }).params.id).toBe(
    "garbage",
  );
});

// ---------------------------------------------------------------------------
// buildSetModeFrame / buildSetArmedFrame — fn-751 control-RPC frame builders.
// ---------------------------------------------------------------------------

test("buildSetModeFrame — armed emits the canonical set_autopilot_mode shape (fn-751)", () => {
  expect(buildSetModeFrame("rpc-uuid-5", "armed")).toEqual({
    type: "rpc",
    id: "rpc-uuid-5",
    method: "set_autopilot_mode",
    params: { mode: "armed" },
  });
});

test("buildSetModeFrame — yolo emits mode:yolo (fn-751)", () => {
  expect(buildSetModeFrame("rpc-uuid-6", "yolo")).toEqual({
    type: "rpc",
    id: "rpc-uuid-6",
    method: "set_autopilot_mode",
    params: { mode: "yolo" },
  });
});

test("buildSetArmedFrame — arm emits set_epic_armed {epic_id, armed:true} (fn-751)", () => {
  expect(buildSetArmedFrame("rpc-uuid-7", "fn-1-foo", true)).toEqual({
    type: "rpc",
    id: "rpc-uuid-7",
    method: "set_epic_armed",
    params: { epic_id: "fn-1-foo", armed: true },
  });
});

test("buildSetArmedFrame — disarm emits armed:false (fn-751)", () => {
  expect(buildSetArmedFrame("rpc-uuid-8", "fn-1-foo", false)).toEqual({
    type: "rpc",
    id: "rpc-uuid-8",
    method: "set_epic_armed",
    params: { epic_id: "fn-1-foo", armed: false },
  });
});

// ---------------------------------------------------------------------------
// buildSetConfigFrame — fn-953 generic config-patch control-RPC frame builder.
// ---------------------------------------------------------------------------

test("buildSetConfigFrame — a cap patch emits set_autopilot_config {max_concurrent_jobs} (fn-953)", () => {
  expect(buildSetConfigFrame("rpc-uuid-9", { max_concurrent_jobs: 8 })).toEqual(
    {
      type: "rpc",
      id: "rpc-uuid-9",
      method: "set_autopilot_config",
      params: { max_concurrent_jobs: 8 },
    },
  );
});

test("buildSetConfigFrame — an explicit null cap (unlimited) rides verbatim (fn-953)", () => {
  expect(
    buildSetConfigFrame("rpc-uuid-10", { max_concurrent_jobs: null }),
  ).toEqual({
    type: "rpc",
    id: "rpc-uuid-10",
    method: "set_autopilot_config",
    params: { max_concurrent_jobs: null },
  });
});

test("buildSetConfigFrame — a per-root patch emits set_autopilot_config {max_concurrent_per_root} (fn-954)", () => {
  expect(
    buildSetConfigFrame("rpc-uuid-11", { max_concurrent_per_root: 3 }),
  ).toEqual({
    type: "rpc",
    id: "rpc-uuid-11",
    method: "set_autopilot_config",
    params: { max_concurrent_per_root: 3 },
  });
});

test("buildSetConfigFrame — an explicit null per-root (reset to default) rides verbatim (fn-954)", () => {
  expect(
    buildSetConfigFrame("rpc-uuid-12", { max_concurrent_per_root: null }),
  ).toEqual({
    type: "rpc",
    id: "rpc-uuid-12",
    method: "set_autopilot_config",
    params: { max_concurrent_per_root: null },
  });
});

test("buildSetConfigFrame — a worktree_mode boolean patch emits set_autopilot_config {worktree_mode} (fn-959)", () => {
  expect(buildSetConfigFrame("rpc-uuid-13", { worktree_mode: true })).toEqual({
    type: "rpc",
    id: "rpc-uuid-13",
    method: "set_autopilot_config",
    params: { worktree_mode: true },
  });
  expect(buildSetConfigFrame("rpc-uuid-14", { worktree_mode: false })).toEqual({
    type: "rpc",
    id: "rpc-uuid-14",
    method: "set_autopilot_config",
    params: { worktree_mode: false },
  });
});

test("buildSetConfigFrame — a worktree_multi_repo boolean patch emits set_autopilot_config {worktree_multi_repo} (fn-1071)", () => {
  expect(
    buildSetConfigFrame("rpc-uuid-15", { worktree_multi_repo: true }),
  ).toEqual({
    type: "rpc",
    id: "rpc-uuid-15",
    method: "set_autopilot_config",
    params: { worktree_multi_repo: true },
  });
  expect(
    buildSetConfigFrame("rpc-uuid-16", { worktree_multi_repo: false }),
  ).toEqual({
    type: "rpc",
    id: "rpc-uuid-16",
    method: "set_autopilot_config",
    params: { worktree_multi_repo: false },
  });
});

// ---------------------------------------------------------------------------
// projectWorktreeMode — fn-959 socket-sourced worktree-toggle projection.
// ---------------------------------------------------------------------------

test("projectWorktreeMode — empty row set → null (singleton not folded yet) (fn-959)", () => {
  expect(projectWorktreeMode([])).toBeNull();
});

test("projectWorktreeMode — worktree_mode=1 row → true (ON) (fn-959)", () => {
  expect(projectWorktreeMode([{ id: 1, worktree_mode: 1 }])).toBe(true);
});

test("projectWorktreeMode — worktree_mode=0 / NULL / missing → false (OFF, the default) (fn-959)", () => {
  // Only a stored `1` is ON; every other value (0, NULL, absent column, non-1)
  // is the byte-identical OFF default.
  expect(projectWorktreeMode([{ id: 1, worktree_mode: 0 }])).toBe(false);
  expect(projectWorktreeMode([{ id: 1, worktree_mode: null }])).toBe(false);
  expect(projectWorktreeMode([{ id: 1 }])).toBe(false);
  expect(projectWorktreeMode([{ id: 1, worktree_mode: 2 }])).toBe(false);
});

// ---------------------------------------------------------------------------
// projectAutopilotMode / projectArmedEpics — fn-751 socket-sourced projections.
// ---------------------------------------------------------------------------

test("projectAutopilotMode — empty row set → null (singleton not folded yet) (fn-751)", () => {
  expect(projectAutopilotMode([])).toBeNull();
});

test("projectAutopilotMode — mode='armed' row → 'armed' (fn-751)", () => {
  expect(projectAutopilotMode([{ id: 1, mode: "armed" }])).toBe("armed");
});

test("projectAutopilotMode — mode='yolo' row → 'yolo' (fn-751)", () => {
  expect(projectAutopilotMode([{ id: 1, mode: "yolo" }])).toBe("yolo");
});

test("projectAutopilotMode — unknown/missing value falls back to 'yolo' (default) (fn-751)", () => {
  // A non-empty row whose `mode` is missing or garbage defaults to the
  // work-everything baseline, never `armed` (the safe-to-render fallback).
  expect(projectAutopilotMode([{ id: 1 }])).toBe("yolo");
  expect(projectAutopilotMode([{ id: 1, mode: "ARMED" }])).toBe("yolo");
  expect(projectAutopilotMode([{ id: 1, mode: 7 }])).toBe("yolo");
});

test("projectArmedEpics — empty rows → [] (fn-751)", () => {
  expect(projectArmedEpics([])).toEqual([]);
});

test("projectArmedEpics — projects + sorts the armed epic ids ascending (fn-751)", () => {
  // Server sends `created_at DESC`; we re-sort by id for a stable render.
  const rows = [
    { epic_id: "fn-9-zed", created_at: 3 },
    { epic_id: "fn-1-foo", created_at: 1 },
    { epic_id: "fn-4-bar", created_at: 2 },
  ];
  expect(projectArmedEpics(rows)).toEqual(["fn-1-foo", "fn-4-bar", "fn-9-zed"]);
});

test("projectArmedEpics — skips rows with an empty/missing epic_id (fn-751)", () => {
  const rows = [
    { epic_id: "fn-1-foo" },
    { epic_id: "" },
    { created_at: 5 },
    { epic_id: "fn-2-bar" },
  ];
  expect(projectArmedEpics(rows)).toEqual(["fn-1-foo", "fn-2-bar"]);
});

// ---------------------------------------------------------------------------
// projectAutopilotPaused — coerce singleton `autopilot_state.paused` rows to
// the banner-facing boolean. fn-667.
// ---------------------------------------------------------------------------

test("projectAutopilotPaused — paused=1 row → true (banner reads [paused])", () => {
  const rows = [
    { id: 1, paused: 1, last_event_id: 42, created_at: 1, updated_at: 1 },
  ];
  expect(projectAutopilotPaused(rows)).toBe(true);
});

test("projectAutopilotPaused — paused=0 row → false (banner reads [playing])", () => {
  const rows = [
    { id: 1, paused: 0, last_event_id: 50, created_at: 1, updated_at: 2 },
  ];
  expect(projectAutopilotPaused(rows)).toBe(false);
});

test("projectAutopilotPaused — empty rows (singleton not folded yet) → null", () => {
  // The boot-append in daemon.ts folds the row BEFORE serverWorker spawns,
  // so this is only ever observed in a sub-ms window between the viewer
  // launching and the first subscribe result. The caller leaves the seed
  // `state.paused` untouched on null.
  expect(projectAutopilotPaused([])).toBeNull();
});

test("projectAutopilotPaused — non-number `paused` falls back to true (safer side)", () => {
  // Defensive against a wire row whose `paused` column got coerced
  // through a JSON layer that stringified it / NULLed it / etc. The
  // safer side is paused — matches the daemon's boot default.
  const rows = [
    { id: 1, paused: "1", last_event_id: 1, created_at: 1, updated_at: 1 },
  ];
  expect(projectAutopilotPaused(rows)).toBe(true);
  const rows2 = [
    {
      id: 1,
      paused: null,
      last_event_id: 1,
      created_at: 1,
      updated_at: 1,
    },
  ];
  expect(projectAutopilotPaused(rows2)).toBe(true);
});

// ---------------------------------------------------------------------------
// projectMaxConcurrentJobs — coerce the singleton `autopilot_state.
// max_concurrent_jobs` column to the banner-facing cap (socket-sourced, never
// config.yaml). Positive integer → that cap; NULL / absent / empty-rows /
// non-positive → null (= unlimited, rendered `∞`). fn-725.
// ---------------------------------------------------------------------------

test("projectMaxConcurrentJobs — positive integer row → that cap (fn-725)", () => {
  const rows = [
    {
      id: 1,
      paused: 0,
      last_event_id: 42,
      created_at: 1,
      updated_at: 1,
      max_concurrent_jobs: 3,
    },
  ];
  expect(projectMaxConcurrentJobs(rows)).toBe(3);
});

test("projectMaxConcurrentJobs — NULL column → null (unlimited) (fn-725)", () => {
  // SQL NULL wire-decodes to JS null = unlimited.
  const rows = [
    {
      id: 1,
      paused: 0,
      last_event_id: 1,
      created_at: 1,
      updated_at: 1,
      max_concurrent_jobs: null,
    },
  ];
  expect(projectMaxConcurrentJobs(rows)).toBeNull();
});

test("projectMaxConcurrentJobs — missing column (pre-v60 wire shape) → null (fn-725)", () => {
  const rows = [
    { id: 1, paused: 0, last_event_id: 1, created_at: 1, updated_at: 1 },
  ];
  expect(projectMaxConcurrentJobs(rows)).toBeNull();
});

test("projectMaxConcurrentJobs — empty rows (singleton not folded yet) → null (fn-725)", () => {
  // Boot-race empty-rows case — the full absent → unlimited path.
  expect(projectMaxConcurrentJobs([])).toBeNull();
});

test("projectMaxConcurrentJobs — non-positive / non-integer values → null (fn-725)", () => {
  const mk = (v: unknown) => [
    {
      id: 1,
      paused: 0,
      last_event_id: 1,
      created_at: 1,
      updated_at: 1,
      max_concurrent_jobs: v,
    },
  ];
  expect(projectMaxConcurrentJobs(mk(0))).toBeNull();
  expect(projectMaxConcurrentJobs(mk(-2))).toBeNull();
  expect(projectMaxConcurrentJobs(mk(2.5))).toBeNull();
  expect(projectMaxConcurrentJobs(mk("3"))).toBeNull();
});

// ---------------------------------------------------------------------------
// autopilotBannerLabel — the persistent banner pill: play/pause pill + mode
// suffix + concurrency-cap suffix (+ armed count in armed mode). fn-725 (cap)
// extended by fn-751 (mode + armed). Sourced from viewer state, never config.
// ---------------------------------------------------------------------------

test("autopilotBannerLabel — yolo mode + finite cap renders `[playing] · yolo · max 3` (fn-725/fn-751)", () => {
  expect(
    autopilotBannerLabel({
      paused: false,
      maxConcurrentJobs: 3,
      maxConcurrentPerRoot: 2,
      mode: "yolo",
      armedCount: 0,
      worktreeMode: false,
    }),
  ).toBe("[playing] · yolo · max 3 · per-root 2 · worktree:off");
});

test("autopilotBannerLabel — yolo mode never shows an armed count even with a nonzero count (fn-751)", () => {
  // yolo dispatches everything — the armed set is irrelevant, so the count is
  // suppressed regardless of what `armed_epics` happens to contain.
  expect(
    autopilotBannerLabel({
      paused: true,
      maxConcurrentJobs: null,
      maxConcurrentPerRoot: 1,
      mode: "yolo",
      armedCount: 4,
      worktreeMode: false,
    }),
  ).toBe("[paused] · yolo · max ∞ · per-root 1 · worktree:off");
});

test("autopilotBannerLabel — armed mode shows the armed count (fn-751)", () => {
  expect(
    autopilotBannerLabel({
      paused: false,
      maxConcurrentJobs: 2,
      maxConcurrentPerRoot: 1,
      mode: "armed",
      armedCount: 2,
      worktreeMode: false,
    }),
  ).toBe("[playing] · armed · 2 armed · max 2 · per-root 1 · worktree:off");
});

test("autopilotBannerLabel — armed mode with NOTHING armed renders distinctly (idle-by-design, not broken) (fn-751)", () => {
  // The empty-armed-set-in-armed-mode case must read as a deliberate state.
  expect(
    autopilotBannerLabel({
      paused: false,
      maxConcurrentJobs: null,
      maxConcurrentPerRoot: 1,
      mode: "armed",
      armedCount: 0,
      worktreeMode: false,
    }),
  ).toBe(
    "[playing] · armed · nothing armed · max ∞ · per-root 1 · worktree:off",
  );
});

test("autopilotBannerLabel — paused flag drives the pill independent of mode/cap (fn-725/fn-751)", () => {
  expect(
    autopilotBannerLabel({
      paused: true,
      maxConcurrentJobs: 5,
      maxConcurrentPerRoot: 3,
      mode: "armed",
      armedCount: 1,
      worktreeMode: false,
    }),
  ).toBe("[paused] · armed · 1 armed · max 5 · per-root 3 · worktree:off");
  expect(
    autopilotBannerLabel({
      paused: false,
      maxConcurrentJobs: null,
      maxConcurrentPerRoot: 1,
      mode: "yolo",
      armedCount: 0,
      worktreeMode: false,
    }),
  ).toBe("[playing] · yolo · max ∞ · per-root 1 · worktree:off");
});

test("autopilotBannerLabel — worktree mode ON renders the `· worktree:on` segment for BOTH yolo and armed (fn-959)", () => {
  // The worktree segment renders for BOTH on and off so the live durable toggle
  // is always scannable; ON is `worktree:on`.
  expect(
    autopilotBannerLabel({
      paused: false,
      maxConcurrentJobs: 3,
      maxConcurrentPerRoot: 2,
      mode: "yolo",
      armedCount: 0,
      worktreeMode: true,
    }),
  ).toBe("[playing] · yolo · max 3 · per-root 2 · worktree:on");
  expect(
    autopilotBannerLabel({
      paused: false,
      maxConcurrentJobs: null,
      maxConcurrentPerRoot: 1,
      mode: "armed",
      armedCount: 2,
      worktreeMode: true,
    }),
  ).toBe("[playing] · armed · 2 armed · max ∞ · per-root 1 · worktree:on");
});

test("autopilotBannerLabel — annotates the STORED intent only when it differs from effective (worktree-off floor)", () => {
  // Worktree off ⇒ effective 1 while the stored intent stays 3: the latent cap
  // is surfaced as `per-root 1 (stored 3)` so it is never invisible.
  expect(
    autopilotBannerLabel({
      paused: false,
      maxConcurrentJobs: null,
      maxConcurrentPerRoot: 1,
      maxConcurrentPerRootStored: 3,
      mode: "yolo",
      armedCount: 0,
      worktreeMode: false,
    }),
  ).toBe("[playing] · yolo · max ∞ · per-root 1 (stored 3) · worktree:off");
  // Stored equal to effective (worktree on) → no annotation.
  expect(
    autopilotBannerLabel({
      paused: false,
      maxConcurrentJobs: null,
      maxConcurrentPerRoot: 3,
      maxConcurrentPerRootStored: 3,
      mode: "yolo",
      armedCount: 0,
      worktreeMode: true,
    }),
  ).toBe("[playing] · yolo · max ∞ · per-root 3 · worktree:on");
});

test("autopilotBannerLabel — needs-human count surfaces a pill right after play/pause; 0 or omitted suppresses it", () => {
  // > 0 ⇒ the `[needs-human:N]` pill sits between the play/pause pill and mode.
  expect(
    autopilotBannerLabel({
      paused: false,
      maxConcurrentJobs: null,
      maxConcurrentPerRoot: 1,
      mode: "yolo",
      armedCount: 0,
      worktreeMode: true,
      needsHumanCount: 3,
    }),
  ).toBe(
    "[playing] · [needs-human:3] · yolo · max ∞ · per-root 1 · worktree:on",
  );
  // Explicit 0 and omitted both render the historical banner byte-for-byte.
  const clean = "[playing] · yolo · max ∞ · per-root 1 · worktree:on";
  expect(
    autopilotBannerLabel({
      paused: false,
      maxConcurrentJobs: null,
      maxConcurrentPerRoot: 1,
      mode: "yolo",
      armedCount: 0,
      worktreeMode: true,
      needsHumanCount: 0,
    }),
  ).toBe(clean);
  expect(
    autopilotBannerLabel({
      paused: false,
      maxConcurrentJobs: null,
      maxConcurrentPerRoot: 1,
      mode: "yolo",
      armedCount: 0,
      worktreeMode: true,
    }),
  ).toBe(clean);
});

// ---------------------------------------------------------------------------
// projectMaxConcurrentPerRoot — coerce the singleton `autopilot_state.
// max_concurrent_per_root` column to the banner's per-root count. Unlike the
// global cap there is NO unlimited sentinel: NULL / empty / non-positive /
// non-integer all resolve to DEFAULT_MAX_CONCURRENT_PER_ROOT (= 1). Always a
// concrete positive integer.
// ---------------------------------------------------------------------------

test("projectMaxConcurrentPerRoot — positive integer row → that value", () => {
  const rows = [{ id: 1, max_concurrent_per_root: 3 }];
  expect(projectMaxConcurrentPerRoot(rows)).toBe(3);
});

test("projectMaxConcurrentPerRoot — empty rows (singleton not folded yet) → 1", () => {
  expect(projectMaxConcurrentPerRoot([])).toBe(1);
});

test("projectMaxConcurrentPerRoot — NULL / missing column → 1 (the default, NOT unlimited)", () => {
  expect(
    projectMaxConcurrentPerRoot([{ id: 1, max_concurrent_per_root: null }]),
  ).toBe(1);
  expect(projectMaxConcurrentPerRoot([{ id: 1 }])).toBe(1);
});

test("projectMaxConcurrentPerRoot — non-positive / non-integer values → 1", () => {
  const mk = (v: unknown) => [{ id: 1, max_concurrent_per_root: v }];
  expect(projectMaxConcurrentPerRoot(mk(0))).toBe(1);
  expect(projectMaxConcurrentPerRoot(mk(-2))).toBe(1);
  expect(projectMaxConcurrentPerRoot(mk(2.5))).toBe(1);
  expect(projectMaxConcurrentPerRoot(mk("3"))).toBe(1);
});

// ---------------------------------------------------------------------------
// assertNoMidEpicDispatch — the worktree-toggle started-epic guard. Dies ONLY
// when a started open epic exists (isEpicStarted); a drained / unstarted-open /
// zero-epic board toggles freely; a transport error fails closed. The injected
// `query` keeps this off the daemon socket (fast tier).
// ---------------------------------------------------------------------------

class GateDie extends Error {}
const gateDie = (msg: string): never => {
  throw new GateDie(msg);
};

test("assertNoMidEpicDispatch — a STARTED open epic dies and enumerates its id", async () => {
  const started = makeEpic({
    epic_id: "fn-7-live",
    tasks: [makeTask({ runtime_status: "in_progress" })],
  });
  const query = async () => [started] as unknown as Record<string, unknown>[];
  let caught: unknown;
  await assertNoMidEpicDispatch("/sock", false, gateDie, query).catch((e) => {
    caught = e;
  });
  expect(caught).toBeInstanceOf(GateDie);
  expect((caught as Error).message).toContain("fn-7-live");
  expect((caught as Error).message).toContain("started open epic");
});

test("assertNoMidEpicDispatch — an UNSTARTED open epic toggles freely (no die)", async () => {
  // All-todo, no jobs / job_links → isEpicStarted false.
  const unstarted = makeEpic({
    epic_id: "fn-8-fresh",
    tasks: [makeTask({ runtime_status: "todo" })],
  });
  const query = async () => [unstarted] as unknown as Record<string, unknown>[];
  await assertNoMidEpicDispatch("/sock", false, gateDie, query);
});

test("assertNoMidEpicDispatch — a ZERO-epic board (drained) toggles freely (no die)", async () => {
  const query = async () => [] as Record<string, unknown>[];
  await assertNoMidEpicDispatch("/sock", false, gateDie, query);
});

test("assertNoMidEpicDispatch — a transport error fails closed (dies, suggests --force)", async () => {
  const query = async () => {
    throw new Error("connection refused");
  };
  let caught: unknown;
  await assertNoMidEpicDispatch("/sock", false, gateDie, query).catch((e) => {
    caught = e;
  });
  expect(caught).toBeInstanceOf(GateDie);
  expect((caught as Error).message).toContain("--force");
});

test("assertNoMidEpicDispatch — --force bypasses the gate without querying", async () => {
  let queried = false;
  const query = async () => {
    queried = true;
    return [] as Record<string, unknown>[];
  };
  await assertNoMidEpicDispatch("/sock", true, gateDie, query);
  expect(queried).toBe(false);
});

// ---------------------------------------------------------------------------
// renderBody — paused field is part of the input contract (the
// `state.paused` driving the banner via `view.liveShell.setStatus`), so
// renderBody itself does NOT emit a `[paused]`/`[playing]` line — the
// banner lives on the live shell, not the body. Pin that contract: the
// rendered body must NOT contain a paused-state line regardless of the
// flag, so the live shell remains the sole banner owner. fn-667.
// ---------------------------------------------------------------------------

test("renderBody — paused=true does NOT emit a banner line into the body (live shell owns banner)", () => {
  const lines = renderBody({
    current: [
      {
        verb: "work",
        id: "fn-1.1",
        dir: "repo",
        state: "working",
        created_at: 1,
      },
    ],
    failed: [],
    paused: true,
  });
  for (const line of lines) {
    expect(line).not.toContain("[paused]");
    expect(line).not.toContain("[playing]");
  }
});

test("renderBody — paused=false does NOT emit a banner line into the body either", () => {
  const lines = renderBody({
    current: [
      {
        verb: "work",
        id: "fn-1.1",
        dir: "repo",
        state: "working",
        created_at: 1,
      },
    ],
    failed: [],
    paused: false,
  });
  for (const line of lines) {
    expect(line).not.toContain("[paused]");
    expect(line).not.toContain("[playing]");
  }
});

// ---------------------------------------------------------------------------
// renderDependencyGraph — ASCII DAG of open tasks.
// ---------------------------------------------------------------------------

test("renderDependencyGraph — emits per-epic blocks with task dep arrows and epic-level annotation", () => {
  const epic = makeEpic({
    depends_on_epics: ["fn-0-base"],
    tasks: [
      makeTask({
        task_id: "fn-1-foo.1",
        task_number: 1,
        worker_phase: "open",
      }),
      makeTask({
        task_id: "fn-1-foo.2",
        task_number: 2,
        worker_phase: "open",
        depends_on: ["fn-1-foo.1"],
      }),
    ],
  });
  const lines = renderDependencyGraph(buildSnap([epic]));
  expect(lines).toEqual([
    "fn-1-foo  ← epic:fn-0-base",
    "  ○ .1",
    "  · .2  ← .1",
  ]);
});

test("renderDependencyGraph — skips epics with no tasks, omits the dep clause when none", () => {
  const epic = makeEpic({
    epic_id: "fn-2-bar",
    epic_number: 2,
    tasks: [
      makeTask({
        task_id: "fn-2-bar.1",
        epic_id: "fn-2-bar",
        task_number: 1,
        worker_phase: "open",
      }),
    ],
  });
  const empty = makeEpic({ epic_id: "fn-3-baz", epic_number: 3, tasks: [] });
  const lines = renderDependencyGraph(buildSnap([epic, empty]));
  expect(lines).toEqual(["fn-2-bar", "  ○ .1"]);
});

// ---------------------------------------------------------------------------
// projectWorktreeMultiRepo — the durable multi-repo rollout flag coercion.
// ---------------------------------------------------------------------------

describe("projectWorktreeMultiRepo", () => {
  test("empty rows → null (leave the seed untouched)", () => {
    expect(projectWorktreeMultiRepo([])).toBeNull();
  });
  test("only a stored 1 is ON; 0 / NULL / non-1 are OFF", () => {
    expect(projectWorktreeMultiRepo([{ worktree_multi_repo: 1 }])).toBe(true);
    expect(projectWorktreeMultiRepo([{ worktree_multi_repo: 0 }])).toBe(false);
    expect(projectWorktreeMultiRepo([{ worktree_multi_repo: null }])).toBe(
      false,
    );
    expect(projectWorktreeMultiRepo([{}])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// keeper autopilot show — durable config as ONE envelope-shaped read.
// ---------------------------------------------------------------------------

describe("buildAutopilotShowEnvelope", () => {
  test("round-trips every durable knob incl. worktree_multi_repo", () => {
    const env = buildAutopilotShowEnvelope(
      [
        {
          paused: 1,
          mode: "armed",
          worktree_mode: 1,
          worktree_multi_repo: 1,
          max_concurrent_jobs: 5,
          max_concurrent_per_root: 3,
        },
      ],
      [{ epic_id: "fn-2-b" }, { epic_id: "fn-1-a" }],
    );
    expect(env.schema_version).toBe(AUTOPILOT_SHOW_SCHEMA_VERSION);
    expect(env.ok).toBe(true);
    expect(env.error).toBeNull();
    expect(env.data).toEqual({
      paused: true,
      mode: "armed",
      worktree_mode: true,
      worktree_multi_repo: true,
      armed: ["fn-1-a", "fn-2-b"],
      max_concurrent_jobs: 5,
      // worktree ON ⇒ effective equals stored.
      max_concurrent_per_root: 3,
      max_concurrent_per_root_stored: 3,
    });
  });

  test("worktree OFF floors effective to 1 while stored keeps the intent", () => {
    const env = buildAutopilotShowEnvelope(
      [
        {
          paused: 0,
          mode: "yolo",
          worktree_mode: 0,
          worktree_multi_repo: 0,
          max_concurrent_jobs: null,
          max_concurrent_per_root: 3,
        },
      ],
      [],
    );
    expect(env.ok).toBe(true);
    expect(env.data?.max_concurrent_per_root).toBe(1);
    expect(env.data?.max_concurrent_per_root_stored).toBe(3);
  });

  test("a never-configured board defaults to the boot-safe singleton", () => {
    const env = buildAutopilotShowEnvelope([], []);
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({
      paused: true,
      mode: "yolo",
      worktree_mode: false,
      worktree_multi_repo: false,
      armed: [],
      max_concurrent_jobs: null,
      max_concurrent_per_root: 1,
      max_concurrent_per_root_stored: 1,
    });
  });
});

describe("runAutopilotShow", () => {
  test("success prints the config envelope and exits 0", async () => {
    const out: string[] = [];
    let code: number | null = null;
    class ExitError extends Error {}
    await runAutopilotShow("/tmp/s", {
      writeStdout: (s) => out.push(s),
      exit: (c: number): never => {
        code = c;
        throw new ExitError();
      },
      query: (_sock, collection) =>
        Promise.resolve(
          collection === "autopilot_state"
            ? [{ paused: 0, mode: "yolo", worktree_multi_repo: 0 }]
            : [],
        ),
    }).catch((e) => {
      if (!(e instanceof ExitError)) throw e;
    });
    expect(code as number | null).toBe(0);
    const env = JSON.parse(out.join(""));
    expect(env.ok).toBe(true);
    expect(env.data.paused).toBe(false);
    expect(env.data.worktree_multi_repo).toBe(false);
  });

  test("a query throw lands an ok:false envelope on stdout, exit 1", async () => {
    const out: string[] = [];
    let code: number | null = null;
    class ExitError extends Error {}
    await runAutopilotShow("/tmp/s", {
      writeStdout: (s) => out.push(s),
      exit: (c: number): never => {
        code = c;
        throw new ExitError();
      },
      query: () => Promise.reject(new Error("unreachable: down")),
    }).catch((e) => {
      if (!(e instanceof ExitError)) throw e;
    });
    expect(code as number | null).toBe(1);
    const env = JSON.parse(out.join(""));
    expect(env.ok).toBe(false);
    expect(env.data).toBeNull();
    expect(env.error.code).toBe("autopilot_show_failed");
    expect(env.error.recovery.length).toBeGreaterThan(0);
  });
});

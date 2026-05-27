/**
 * Reducer tests. Each test opens a fresh writer DB on a tmp path, seeds raw
 * `events` rows, then drives the reducer and asserts the `jobs` projection +
 * cursor. The assertions mirror the task Acceptance list:
 * - one transaction per fold with cursor advance,
 * - drain() batching + idempotency on re-run,
 * - all four lifecycle transitions + ended-as-resting-state / resume re-open,
 * - title updates from session_title on any event,
 * - unknown/no-op event types advance the cursor without touching jobs,
 * - malformed data blob logs to stderr and advances the cursor (no halt),
 * - crash-mid-fold rolls back BOTH the jobs write and the cursor advance.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { applyEvent, DEFAULT_BATCH_SIZE, drain } from "../src/reducer";
import { seedKilledSweep } from "../src/seed-sweep";
import type { Event } from "../src/types";

let tmpDir: string;
let dbPath: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-reducer-test-"));
  dbPath = join(tmpDir, "keeper.db");
  db = openDb(dbPath).db;
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tsCounter = 1_000;

/**
 * Insert one raw event row, mirroring what the hook writes. Returns the
 * auto-assigned event id. `overrides` set any non-default column; ts auto-
 * increments so ordering is stable.
 */
function insertEvent(
  overrides: Partial<Event> & { hook_event: string },
): number {
  const ts = overrides.ts ?? tsCounter++;
  const row = {
    ts,
    session_id: overrides.session_id ?? "sess-a",
    pid: overrides.pid ?? 4242,
    hook_event: overrides.hook_event,
    event_type: overrides.event_type ?? overrides.hook_event,
    tool_name: overrides.tool_name ?? null,
    matcher: overrides.matcher ?? null,
    cwd: overrides.cwd ?? "/tmp/work",
    permission_mode: overrides.permission_mode ?? null,
    agent_id: overrides.agent_id ?? null,
    agent_type: overrides.agent_type ?? null,
    stop_hook_active: overrides.stop_hook_active ?? null,
    data: overrides.data ?? "{}",
    subagent_agent_id: overrides.subagent_agent_id ?? null,
    spawn_name: overrides.spawn_name ?? null,
    start_time: overrides.start_time ?? null,
    slash_command: overrides.slash_command ?? null,
    skill_name: overrides.skill_name ?? null,
    planctl_op: overrides.planctl_op ?? null,
    planctl_target: overrides.planctl_target ?? null,
    planctl_epic_id: overrides.planctl_epic_id ?? null,
    planctl_task_id: overrides.planctl_task_id ?? null,
    planctl_subject_present: overrides.planctl_subject_present ?? null,
    tool_use_id: overrides.tool_use_id ?? null,
    config_dir: overrides.config_dir ?? null,
    // Schema v30: queue-jump sparse column; NULL unless this is a planctl
    // event whose envelope carried `queue_jump: true` (stamped 1) or any
    // other planctl event (stamped 0). The test helper defaults to NULL so
    // every non-planctl event lands NULL — matches the live hook's stamping
    // contract (see `plugin/hooks/events-writer.ts`).
    planctl_queue_jump: overrides.planctl_queue_jump ?? null,
  };
  db.run(
    `INSERT INTO events (
       ts, session_id, pid, hook_event, event_type, tool_name, matcher,
       cwd, permission_mode, agent_id, agent_type, stop_hook_active, data,
       subagent_agent_id, spawn_name, start_time, slash_command, skill_name,
       planctl_op, planctl_target, planctl_epic_id, planctl_task_id,
       planctl_subject_present, tool_use_id, config_dir, planctl_queue_jump
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.ts,
      row.session_id,
      row.pid,
      row.hook_event,
      row.event_type,
      row.tool_name,
      row.matcher,
      row.cwd,
      row.permission_mode,
      row.agent_id,
      row.agent_type,
      row.stop_hook_active,
      row.data,
      row.subagent_agent_id,
      row.spawn_name,
      row.start_time,
      row.slash_command,
      row.skill_name,
      row.planctl_op,
      row.planctl_target,
      row.planctl_epic_id,
      row.planctl_task_id,
      row.planctl_subject_present,
      row.tool_use_id,
      row.config_dir,
      row.planctl_queue_jump,
    ],
  );
  const { id } = db.query("SELECT last_insert_rowid() AS id").get() as {
    id: number;
  };
  return id;
}

function getJob(jobId = "sess-a") {
  return db.query("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as {
    job_id: string;
    created_at: number;
    cwd: string | null;
    pid: number | null;
    state: string;
    last_event_id: number;
    updated_at: number;
    title: string | null;
    title_source: string | null;
    start_time: string | null;
    plan_verb: string | null;
    plan_ref: string | null;
  } | null;
}

/** Insert a synthetic Killed event carrying the (pid, start_time) payload. */
function killedEvent(
  pid: number,
  start_time: string | null,
  session_id = "sess-a",
): number {
  return insertEvent({
    hook_event: "Killed",
    session_id,
    data: JSON.stringify({ pid, start_time }),
  });
}

function getCursor(): number {
  const row = db
    .query("SELECT last_event_id FROM reducer_state WHERE id = 1")
    .get() as { last_event_id: number };
  return row.last_event_id;
}

test("GitSnapshot folds into git_status and advances the cursor", () => {
  const id = insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: "abc123",
      upstream: "origin/main",
      ahead: 1,
      behind: 2,
      dirty_files: [{ path: "src/a.ts", xy: " M" }],
      orphaned_files: [{ path: "src/a.ts", xy: " M" }],
      jobs: [{ job_id: "sess-a", dirty: [] }],
    }),
  });

  expect(drain(db)).toBe(1);
  const row = db
    .query("SELECT * FROM git_status WHERE project_dir = ?")
    .get("/repo") as {
    branch: string;
    head_oid: string;
    upstream: string;
    ahead: number;
    behind: number;
    dirty_count: number;
    orphaned_count: number;
    dirty_files: string;
    orphaned_files: string;
    jobs: string;
    last_event_id: number;
  } | null;

  expect(row).not.toBeNull();
  expect(row?.branch).toBe("main");
  expect(row?.head_oid).toBe("abc123");
  expect(row?.upstream).toBe("origin/main");
  expect(row?.ahead).toBe(1);
  expect(row?.behind).toBe(2);
  expect(row?.dirty_count).toBe(1);
  expect(row?.orphaned_count).toBe(1);
  expect(JSON.parse(row?.dirty_files ?? "[]")).toEqual([
    { path: "src/a.ts", xy: " M" },
  ]);
  expect(JSON.parse(row?.jobs ?? "[]")).toEqual([
    { job_id: "sess-a", dirty: [] },
  ]);
  expect(row?.last_event_id).toBe(id);
  expect(getCursor()).toBe(id);
});

test("GitRootDropped DELETEs the git_status row and advances the cursor", () => {
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: ".planctl/epics/x.json", xy: " D" }],
      orphaned_files: [{ path: ".planctl/epics/x.json", xy: " D" }],
      jobs: [],
    }),
  });
  const dropId = insertEvent({
    hook_event: "GitRootDropped",
    session_id: "/repo",
    cwd: "/repo",
    data: "",
  });

  expect(drainAll()).toBe(2);
  const row = db
    .query("SELECT * FROM git_status WHERE project_dir = ?")
    .get("/repo");
  expect(row).toBeNull();
  expect(getCursor()).toBe(dropId);
});

test("GitRootDropped on an unknown project_dir is a safe no-op", () => {
  const id = insertEvent({
    hook_event: "GitRootDropped",
    session_id: "/never-folded",
    cwd: "/never-folded",
    data: "",
  });
  expect(drainAll()).toBe(1);
  const count = (
    db.query("SELECT COUNT(*) AS n FROM git_status").get() as { n: number }
  ).n;
  expect(count).toBe(0);
  expect(getCursor()).toBe(id);
});

// ---------------------------------------------------------------------------
// Schema-v28 GitSnapshot → jobs fan-out — fn-620 mechanical git-cleanliness gate
// ---------------------------------------------------------------------------

test("GitSnapshot fans out git counts into jobs and the embedded jobs[] array", () => {
  // Seed a worker session with a plan_ref so syncJobIntoEpic fires.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-worker",
    spawn_name: "work::fn-1-foo.1",
  });
  // Seed a task snapshot so the parent epic / task element exists when the
  // fan-out lands. Without it, syncJobIntoEpic would still shell-insert,
  // but the explicit fold makes the test assertion easier to read.
  insertEvent({
    hook_event: "TaskSnapshot",
    session_id: "fn-1-foo.1",
    data: JSON.stringify({
      task_id: "fn-1-foo.1",
      epic_id: "fn-1-foo",
      task_number: 1,
      title: "task",
      target_repo: null,
      worker_phase: "open",
      runtime_status: "todo",
      approval: "pending",
      depends_on: [],
    }),
  });

  const snapshotId = insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: "abc",
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [
        { path: "src/a.ts", xy: " M" },
        { path: "src/b.ts", xy: " M" },
      ],
      orphaned_files: [{ path: "orph.txt", xy: " M" }],
      jobs: [
        {
          job_id: "sess-worker",
          dirty: [
            { path: "src/a.ts", xy: " M" },
            { path: "src/b.ts", xy: " M" },
          ],
        },
      ],
    }),
  });

  expect(drainAll()).toBe(3);

  // jobs row carries per-job dirty count + project-broadcast orphan count.
  const row = db
    .query(
      "SELECT git_dirty_count, git_orphan_count FROM jobs WHERE job_id = ?",
    )
    .get("sess-worker") as {
    git_dirty_count: number;
    git_orphan_count: number;
  } | null;
  expect(row).not.toBeNull();
  expect(row?.git_dirty_count).toBe(2);
  expect(row?.git_orphan_count).toBe(1);

  // Embedded task element's jobs[] carries the same counts.
  const epicRow = db
    .query("SELECT tasks FROM epics WHERE epic_id = ?")
    .get("fn-1-foo") as { tasks: string } | null;
  expect(epicRow).not.toBeNull();
  const tasksArr = JSON.parse(epicRow?.tasks ?? "[]") as Array<{
    task_id: string;
    jobs: Array<{
      job_id: string;
      git_dirty_count: number;
      git_orphan_count: number;
    }>;
  }>;
  const task = tasksArr.find((t) => t.task_id === "fn-1-foo.1");
  expect(task).not.toBeUndefined();
  const embeddedJob = task?.jobs.find((j) => j.job_id === "sess-worker");
  expect(embeddedJob).not.toBeUndefined();
  expect(embeddedJob?.git_dirty_count).toBe(2);
  expect(embeddedJob?.git_orphan_count).toBe(1);

  expect(getCursor()).toBe(snapshotId);
});

test("GitSnapshot UPDATE matches zero rows for a job with no SessionStart yet (safe no-op)", () => {
  // The fan-out enumerates a job that hasn't folded yet — UPDATE matches
  // zero rows, syncIfPlanRef SELECT returns null, no embedded write.
  const snapshotId = insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "src/a.ts", xy: " M" }],
      orphaned_files: [],
      jobs: [
        {
          job_id: "sess-never-started",
          dirty: [{ path: "src/a.ts", xy: " M" }],
        },
      ],
    }),
  });

  expect(drainAll()).toBe(1);
  const count = (
    db.query("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }
  ).n;
  expect(count).toBe(0);
  expect(getCursor()).toBe(snapshotId);
});

test("GitRootDropped zeroes git counts via the canonical attribution; unrelated jobs untouched", () => {
  // Seed two worker sessions in two different projects. A GitSnapshot in
  // project A stamps worker A; a GitSnapshot in project B stamps worker B.
  // GitRootDropped on project A clears worker A only; worker B stays put.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-a",
    spawn_name: "work::fn-1-foo.1",
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-b",
    spawn_name: "work::fn-2-bar.1",
  });

  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo-a",
    cwd: "/repo-a",
    data: JSON.stringify({
      project_dir: "/repo-a",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "x.ts", xy: " M" }],
      orphaned_files: [{ path: "y.ts", xy: " M" }],
      jobs: [{ job_id: "sess-a", dirty: [{ path: "x.ts", xy: " M" }] }],
    }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo-b",
    cwd: "/repo-b",
    data: JSON.stringify({
      project_dir: "/repo-b",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [
        { path: "p.ts", xy: " M" },
        { path: "q.ts", xy: " M" },
      ],
      orphaned_files: [],
      jobs: [
        {
          job_id: "sess-b",
          dirty: [
            { path: "p.ts", xy: " M" },
            { path: "q.ts", xy: " M" },
          ],
        },
      ],
    }),
  });
  const dropId = insertEvent({
    hook_event: "GitRootDropped",
    session_id: "/repo-a",
    cwd: "/repo-a",
    data: "",
  });

  expect(drainAll()).toBe(5);

  // sess-a counts cleared by the symmetric clear.
  const rowA = db
    .query(
      "SELECT git_dirty_count, git_orphan_count FROM jobs WHERE job_id = ?",
    )
    .get("sess-a") as {
    git_dirty_count: number;
    git_orphan_count: number;
  } | null;
  expect(rowA?.git_dirty_count).toBe(0);
  expect(rowA?.git_orphan_count).toBe(0);

  // sess-b in the other project stays untouched.
  const rowB = db
    .query(
      "SELECT git_dirty_count, git_orphan_count FROM jobs WHERE job_id = ?",
    )
    .get("sess-b") as {
    git_dirty_count: number;
    git_orphan_count: number;
  } | null;
  expect(rowB?.git_dirty_count).toBe(2);
  expect(rowB?.git_orphan_count).toBe(0);

  expect(getCursor()).toBe(dropId);
});

test("from-scratch re-fold reproduces the GitSnapshot fan-out byte-identically", () => {
  // Seed a sequence: SessionStart, TaskSnapshot, GitSnapshot (stamps counts),
  // GitSnapshot (refresh — different dirty count), GitRootDropped (clears).
  // After every fold the jobs row + embedded array carry the predictable
  // counts. Rewind cursor + DELETE FROM jobs + DELETE FROM epics + redrain;
  // the post-rewind rows must equal byte-for-byte the pre-rewind rows.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-w",
    spawn_name: "work::fn-1-foo.1",
  });
  insertEvent({
    hook_event: "TaskSnapshot",
    session_id: "fn-1-foo.1",
    data: JSON.stringify({
      task_id: "fn-1-foo.1",
      epic_id: "fn-1-foo",
      task_number: 1,
      title: "task",
      target_repo: null,
      worker_phase: "open",
      runtime_status: "todo",
      approval: "pending",
      depends_on: [],
    }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "src/a.ts", xy: " M" }],
      orphaned_files: [{ path: "orph.txt", xy: " M" }],
      jobs: [{ job_id: "sess-w", dirty: [{ path: "src/a.ts", xy: " M" }] }],
    }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [],
      orphaned_files: [],
      jobs: [{ job_id: "sess-w", dirty: [] }],
    }),
  });
  drainAll();

  const beforeJobs = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  const beforeEpics = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  const beforeGit = db
    .query("SELECT * FROM git_status ORDER BY project_dir")
    .all();

  // Rewind + wipe + re-drain.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  db.run("DELETE FROM git_status");
  drainAll();

  const afterJobs = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  const afterEpics = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  const afterGit = db
    .query("SELECT * FROM git_status ORDER BY project_dir")
    .all();

  expect(afterJobs).toEqual(beforeJobs);
  expect(afterEpics).toEqual(beforeEpics);
  expect(afterGit).toEqual(beforeGit);
});

// ---------------------------------------------------------------------------
// UsageSnapshot / UsageDeleted reducer arms — fn-615-add-agentuse-usage-collection
// ---------------------------------------------------------------------------

test("UsageSnapshot folds into the usage projection and advances the cursor", () => {
  const id = insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "claude-default",
    data: JSON.stringify({
      target: "claude",
      multiplier: 5,
      session_percent: 12.0,
      session_resets_at: "2026-05-26T18:30:00-04:00",
      week_percent: 8.0,
      week_resets_at: "2026-06-01T20:00:00-04:00",
    }),
  });

  expect(drainAll()).toBe(1);
  const row = db
    .query("SELECT * FROM usage WHERE id = ?")
    .get("claude-default") as {
    id: string;
    target: string;
    multiplier: number;
    session_percent: number;
    session_resets_at: string;
    week_percent: number;
    week_resets_at: string;
    last_event_id: number;
    updated_at: number;
  } | null;

  expect(row).not.toBeNull();
  expect(row?.target).toBe("claude");
  expect(row?.multiplier).toBe(5);
  expect(row?.session_percent).toBe(12.0);
  expect(row?.session_resets_at).toBe("2026-05-26T18:30:00-04:00");
  expect(row?.week_percent).toBe(8.0);
  expect(row?.week_resets_at).toBe("2026-06-01T20:00:00-04:00");
  expect(row?.last_event_id).toBe(id);
  expect(getCursor()).toBe(id);
});

test("UsageSnapshot upserts on conflict and bumps last_event_id every write", () => {
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "claude-default",
    data: JSON.stringify({
      target: "claude",
      multiplier: 5,
      session_percent: 12.0,
      session_resets_at: "T1",
      week_percent: 8.0,
      week_resets_at: "T2",
    }),
  });
  const secondId = insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "claude-default",
    data: JSON.stringify({
      target: "claude",
      multiplier: 5,
      session_percent: 30.0,
      session_resets_at: "T1",
      week_percent: 8.0,
      week_resets_at: "T2",
    }),
  });
  expect(drainAll()).toBe(2);
  const row = db
    .query("SELECT session_percent, last_event_id FROM usage WHERE id = ?")
    .get("claude-default") as {
    session_percent: number;
    last_event_id: number;
  };
  expect(row.session_percent).toBe(30.0);
  expect(row.last_event_id).toBe(secondId);
});

test("UsageSnapshot folds missing session/week to NULL (safe-value invariant)", () => {
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "x",
    data: JSON.stringify({
      target: "claude",
      multiplier: 1,
      // session/week fields omitted → fold to NULL.
    }),
  });
  drainAll();
  const row = db
    .query(
      "SELECT session_percent, session_resets_at, week_percent, week_resets_at FROM usage WHERE id = ?",
    )
    .get("x") as {
    session_percent: number | null;
    session_resets_at: string | null;
    week_percent: number | null;
    week_resets_at: string | null;
  };
  expect(row.session_percent).toBeNull();
  expect(row.session_resets_at).toBeNull();
  expect(row.week_percent).toBeNull();
  expect(row.week_resets_at).toBeNull();
});

test("UsageSnapshot with empty pk (session_id) is a safe no-op", () => {
  const id = insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "",
    data: JSON.stringify({ target: "x" }),
  });
  expect(drainAll()).toBe(1);
  const count = (
    db.query("SELECT COUNT(*) AS n FROM usage").get() as { n: number }
  ).n;
  expect(count).toBe(0);
  expect(getCursor()).toBe(id);
});

test("UsageSnapshot with malformed data blob is a safe no-op (cursor still advances)", () => {
  const id = insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "claude-default",
    data: "{ not json",
  });
  expect(drainAll()).toBe(1);
  const count = (
    db.query("SELECT COUNT(*) AS n FROM usage").get() as { n: number }
  ).n;
  expect(count).toBe(0);
  expect(getCursor()).toBe(id);
});

test("UsageDeleted DELETEs the usage row and advances the cursor", () => {
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "claude-default",
    data: JSON.stringify({
      target: "claude",
      multiplier: 5,
      session_percent: 12.0,
      session_resets_at: "T",
      week_percent: 8.0,
      week_resets_at: "T",
    }),
  });
  const dropId = insertEvent({
    hook_event: "UsageDeleted",
    session_id: "claude-default",
    data: "",
  });
  expect(drainAll()).toBe(2);
  const row = db
    .query("SELECT * FROM usage WHERE id = ?")
    .get("claude-default");
  expect(row).toBeNull();
  expect(getCursor()).toBe(dropId);
});

test("UsageDeleted on an unknown id is a safe no-op (cursor still advances)", () => {
  const id = insertEvent({
    hook_event: "UsageDeleted",
    session_id: "ghost",
    data: "",
  });
  expect(drainAll()).toBe(1);
  expect(getCursor()).toBe(id);
});

test("from-scratch re-fold reproduces the usage projection byte-identically", () => {
  // Seed a sequence: snapshot, snapshot (upsert), delete, snapshot of another id.
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "claude-default",
    data: JSON.stringify({
      target: "claude",
      multiplier: 5,
      session_percent: 12.0,
      session_resets_at: "T1",
      week_percent: 8.0,
      week_resets_at: "T2",
    }),
  });
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "claude-default",
    data: JSON.stringify({
      target: "claude",
      multiplier: 5,
      session_percent: 30.0,
      session_resets_at: "T1",
      week_percent: 8.0,
      week_resets_at: "T2",
    }),
  });
  insertEvent({
    hook_event: "UsageDeleted",
    session_id: "claude-default",
    data: "",
  });
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "codex",
    data: JSON.stringify({
      target: "codex",
      multiplier: 1,
      session_percent: 1.0,
      session_resets_at: "T3",
      week_percent: 71.0,
      week_resets_at: "T4",
    }),
  });
  drainAll();
  const before = db.query("SELECT * FROM usage ORDER BY id").all();
  // Rewind + wipe + re-drain. Re-fold determinism: the post-rewind rows
  // must equal byte-for-byte the pre-rewind rows.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM usage");
  drainAll();
  const after = db.query("SELECT * FROM usage ORDER BY id").all();
  expect(after).toEqual(before);
});

function drainAll(): number {
  let total = 0;
  let n: number;
  do {
    n = drain(db);
    total += n;
  } while (n > 0);
  return total;
}

// ---------------------------------------------------------------------------
// Per-transition tests (one per row in the state-machine table)
// ---------------------------------------------------------------------------

test("SessionStart inserts a job with default state", () => {
  insertEvent({ hook_event: "SessionStart" });
  drainAll();
  const job = getJob();
  expect(job).not.toBeNull();
  expect(job?.state).toBe("stopped");
  expect(job?.cwd).toBe("/tmp/work");
  expect(job?.pid).toBe(4242);
});

test("UserPromptSubmit moves state to working", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  drainAll();
  expect(getJob()?.state).toBe("working");
});

test("Stop moves state to stopped", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({ hook_event: "Stop" });
  drainAll();
  expect(getJob()?.state).toBe("stopped");
});

test("Stop is a no-op on state while a sub-agent is running (parent yielded to Task)", () => {
  // When the parent agent dispatches a Task tool, Claude Code emits Stop and
  // yields control to the sub-agent — but conceptually the session is still
  // working until the sub returns AND any post-sub follow-up Stops. Honoring
  // the mid-yield Stop would clear readiness predicate 5 prematurely and let
  // predicate 7 dup-fire (see autopilot's approval-pending notify).
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "sub-1",
    agent_type: "Explore",
  });
  insertEvent({ hook_event: "Stop" });
  drainAll();
  // State stays 'working' — Stop landed during the sub-agent's run.
  expect(getJob()?.state).toBe("working");
});

test("Stop after SubagentStop flips state to stopped (final post-sub Stop)", () => {
  // The honest read of the user's mental model: Stop is a real lifecycle
  // signal only when no sub-agent is still in flight. The exact bug repro
  // sequence: parent yields to sub via Stop, sub finishes, parent resumes
  // via UserPromptSubmit, parent finishes with a real Stop — and ONLY this
  // final Stop drops state to 'stopped'.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "sub-2",
    agent_type: "plan:worker-high",
  });
  // Mid-yield Stop while sub-2 is running — should be a state no-op.
  insertEvent({ hook_event: "Stop" });
  // Sub finishes.
  insertEvent({ hook_event: "SubagentStop", agent_id: "sub-2" });
  // Parent resumes (Claude Code feeds sub results back via UserPromptSubmit).
  insertEvent({ hook_event: "UserPromptSubmit" });
  // Parent's real final Stop — no sub running now, this one applies.
  insertEvent({ hook_event: "Stop" });
  drainAll();
  expect(getJob()?.state).toBe("stopped");
});

test("Stop guard ignores `running` orphan when a later same-name row exists (fn-593.3 shape)", () => {
  // Wedged-projection repro. The existing supersession path (`findOpenRunning
  // InGroup` at PostToolUse:Agent) can miss an orphan in real traces — e.g.
  // when the later same-name spawn reuses agent_id, or the failure-path
  // didn't run supersession. The Stop guard MUST still let the parent
  // close: same-name collapse on (job_id, subagent_type) — any `running`
  // row with a higher-turn_seq sibling under the same name is ignored
  // for the guard. Mirrors the client-side `collapseSubagentsByName` rule.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  // Hand-write the wedged subagent_invocations shape: turn_seq=1 stuck at
  // `running`, turn_seq=2 finished `ok` — both share the same
  // subagent_type. Bypasses the SubagentStart/PostToolUse:Agent path so we
  // can pin the exact state the wedged production trace landed in. The
  // earlier `ok:turn_seq=0` from fn-593.3's trace is irrelevant to the
  // guard (status='ok' never blocks anything); omitted for brevity.
  db.run(
    `INSERT INTO subagent_invocations
       (job_id, agent_id, turn_seq, ts, tool_use_id, subagent_type,
        description, prompt_chars, status, duration_ms, last_event_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "sess-a",
      "agent-orphan",
      1,
      1_000,
      null,
      "plan:worker-high",
      null,
      0,
      "running",
      null,
      0,
      1_000,
    ],
  );
  db.run(
    `INSERT INTO subagent_invocations
       (job_id, agent_id, turn_seq, ts, tool_use_id, subagent_type,
        description, prompt_chars, status, duration_ms, last_event_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "sess-a",
      "agent-newer",
      2,
      2_000,
      null,
      "plan:worker-high",
      null,
      0,
      "ok",
      null,
      0,
      2_000,
    ],
  );
  insertEvent({ hook_event: "Stop" });
  drainAll();
  // Before the collapse-aware guard this stayed 'working' forever; now the
  // orphan is filtered out and Stop's UPDATE writes 'stopped'.
  expect(getJob()?.state).toBe("stopped");
});

test("Stop guard still blocks when the only `running` row is NOT collapse-eligible", () => {
  // Counter-test: an orphan `running` with NO later same-name sibling
  // still blocks Stop — the collapse rule only fires when a higher
  // turn_seq exists for the same (job_id, subagent_type). This is the
  // normal mid-yield case (single in-flight sub-agent of its type),
  // preserved as a guard-rail against an overzealous filter.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  db.run(
    `INSERT INTO subagent_invocations
       (job_id, agent_id, turn_seq, ts, tool_use_id, subagent_type,
        description, prompt_chars, status, duration_ms, last_event_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "sess-a",
      "solo-agent",
      0,
      1_000,
      null,
      "plan:worker-high",
      null,
      0,
      "running",
      null,
      0,
      1_000,
    ],
  );
  insertEvent({ hook_event: "Stop" });
  drainAll();
  expect(getJob()?.state).toBe("working");
});

test("Stop guard handles multiple concurrent sub-agents (releases only when ALL done)", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "sub-a",
    agent_type: "Explore",
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "sub-b",
    agent_type: "Explore",
  });
  // Stop while BOTH subs are running — no-op.
  insertEvent({ hook_event: "Stop" });
  insertEvent({ hook_event: "SubagentStop", agent_id: "sub-a" });
  // Stop while sub-b is still running — still a no-op.
  insertEvent({ hook_event: "Stop" });
  drainAll();
  expect(getJob()?.state).toBe("working");
  // Sub-b finishes, then parent emits its real Stop.
  insertEvent({ hook_event: "SubagentStop", agent_id: "sub-b" });
  insertEvent({ hook_event: "Stop" });
  drainAll();
  expect(getJob()?.state).toBe("stopped");
});

test("ApiError during a sub-agent run stamps annotation without flipping state", () => {
  // Mirror of the Stop guard for the synthetic api-error fold: the (last_
  // api_error_at, last_api_error_kind) pair must stamp honestly even while
  // a sub-agent runs, but the state flip is suppressed so the session keeps
  // reading as 'working' for readiness predicate 5.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "sub-api",
    agent_type: "Explore",
  });
  insertEvent({
    hook_event: "ApiError",
    data: JSON.stringify({ kind: "rate_limit" }),
  });
  drainAll();
  const job = db
    .query(
      "SELECT state, last_api_error_at, last_api_error_kind FROM jobs WHERE job_id = ?",
    )
    .get("sess-a") as {
    state: string;
    last_api_error_at: number | null;
    last_api_error_kind: string | null;
  };
  expect(job.state).toBe("working");
  expect(job.last_api_error_at).not.toBeNull();
  expect(job.last_api_error_kind).toBe("rate_limit");
});

test("from-scratch re-fold of a sub-agent yield sequence is byte-deterministic", () => {
  // The sub-agent-aware Stop guard reads subagent_invocations, but every
  // SubagentStart/Stop was folded with a strictly-lower event id, so the
  // running-check is a pure function of the event log up to the Stop. Re-
  // fold from scratch must reproduce the same final state.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "sub-rf",
    agent_type: "Explore",
  });
  insertEvent({ hook_event: "Stop" });
  insertEvent({ hook_event: "SubagentStop", agent_id: "sub-rf" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({ hook_event: "Stop" });
  drainAll();
  const firstJob = getJob();
  expect(firstJob?.state).toBe("stopped");

  // Rewind cursor + wipe projections, then re-drain the same event log.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM subagent_invocations");
  drainAll();
  const reJob = getJob();
  expect(reJob?.state).toBe("stopped");
  expect(reJob?.last_event_id).toBe(firstJob?.last_event_id);
});

test("SessionEnd moves state to ended", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "SessionEnd" });
  drainAll();
  expect(getJob()?.state).toBe("ended");
});

test("no-op event types advance cursor without touching jobs", () => {
  insertEvent({ hook_event: "SessionStart" });
  const ptId = insertEvent({ hook_event: "PreToolUse", tool_name: "Bash" });
  insertEvent({ hook_event: "PostToolUse", tool_name: "Bash" });
  const lastId = insertEvent({ hook_event: "SubagentStop" });
  drainAll();
  // jobs row stays at the SessionStart projection — state untouched.
  expect(getJob()?.state).toBe("stopped");
  // cursor walked past every no-op row.
  expect(getCursor()).toBe(lastId);
  expect(getCursor()).toBeGreaterThan(ptId);
});

test("unknown forward-compat event type advances cursor, no jobs write", () => {
  insertEvent({ hook_event: "SessionStart" });
  const lastId = insertEvent({ hook_event: "SomeFutureEvent2030" });
  drainAll();
  expect(getJob()?.state).toBe("stopped");
  expect(getCursor()).toBe(lastId);
});

// ---------------------------------------------------------------------------
// Ended-as-resting-state + resume re-open
// ---------------------------------------------------------------------------

test("UserPromptSubmit after SessionEnd re-opens the job to working", () => {
  // A prompt straight after an end (resume into a prompt with no SessionStart,
  // or a spurious mid-session SessionEnd) means the session is alive again.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "SessionEnd" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  drainAll();
  expect(getJob()?.state).toBe("working");
});

test("Stop after SessionEnd stays ended (no stray resurrection)", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "SessionEnd" });
  insertEvent({ hook_event: "Stop" });
  drainAll();
  expect(getJob()?.state).toBe("ended");
});

// ---------------------------------------------------------------------------
// UserPromptSubmit task-notification carve-out
// ---------------------------------------------------------------------------

const TASK_NOTIFICATION_KILLED = [
  "<task-notification>",
  "<task-id>ba82oze4l</task-id>",
  "<output-file>/tmp/ba82oze4l.output</output-file>",
  "<status>killed</status>",
  '<summary>Monitor "chatctl bus" stopped</summary>',
  "</task-notification>",
].join("\n");

test("UserPromptSubmit with a killed task-notification leaves state stopped", () => {
  // Reproduces the closed-terminal flash: a session sitting idle (stopped)
  // receives a shutdown-housekeeping task-notification through the same
  // UserPromptSubmit hook a real prompt uses. The reducer must NOT flip
  // state to 'working' for the `<status>killed</status>` variant — the
  // session is dying, not picking up a new prompt.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "Stop" });
  insertEvent({
    hook_event: "UserPromptSubmit",
    data: JSON.stringify({ prompt: TASK_NOTIFICATION_KILLED }),
  });
  drainAll();
  expect(getJob()?.state).toBe("stopped");
});

test("UserPromptSubmit with a killed task-notification still folds the session_title", () => {
  // Modest carve-out: only the lifecycle write is skipped. A
  // `session_title` on the task-notification still rides through the title
  // precedence rule below the switch so the row's displayed title stays
  // current.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "UserPromptSubmit",
    data: JSON.stringify({
      prompt: TASK_NOTIFICATION_KILLED,
      session_title: "remove-closed-epics",
    }),
  });
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("stopped");
  expect(job?.title).toBe("remove-closed-epics");
  expect(job?.title_source).toBe("payload");
});

test("UserPromptSubmit with a completed task-notification still flips state to working", () => {
  // Modesty check: `<status>completed</status>` is a real signal the model
  // reacts to — the lifecycle write must still fire.
  const completed = TASK_NOTIFICATION_KILLED.replace(
    "<status>killed</status>",
    "<status>completed</status>",
  );
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "Stop" });
  insertEvent({
    hook_event: "UserPromptSubmit",
    data: JSON.stringify({ prompt: completed }),
  });
  drainAll();
  expect(getJob()?.state).toBe("working");
});

test("UserPromptSubmit with a killed task-notification on a terminal row stays terminal", () => {
  // The normal UserPromptSubmit re-opens an `ended` / `killed` row to
  // `working` — but the carve-out skips that branch, so a shutdown
  // notification that arrives after SessionEnd / Killed never resurrects a
  // terminal row.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "SessionEnd" });
  insertEvent({
    hook_event: "UserPromptSubmit",
    data: JSON.stringify({ prompt: TASK_NOTIFICATION_KILLED }),
  });
  drainAll();
  expect(getJob()?.state).toBe("ended");
});

test("SessionEnd re-asserts ended idempotently", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "SessionEnd" });
  insertEvent({ hook_event: "SessionEnd" });
  drainAll();
  expect(getJob()?.state).toBe("ended");
});

test("SessionStart re-opens an ended job (resume): ended -> stopped, pid refreshed", () => {
  // A full lifecycle ending in SessionEnd, then a fresh `claude --resume`
  // process fires SessionStart (new pid) with NO further interaction.
  insertEvent({ hook_event: "SessionStart", pid: 1000, spawn_name: "my-job" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({ hook_event: "Stop" });
  insertEvent({ hook_event: "SessionEnd" });
  drainAll();
  const ended = getJob();
  expect(ended?.state).toBe("ended");
  const createdAt = ended?.created_at;

  // Resume: a second SessionStart for the same session_id, new process pid.
  insertEvent({ hook_event: "SessionStart", pid: 2000, spawn_name: "my-job" });
  drainAll();
  const reopened = getJob();
  // Re-opened to the zero-event resting state (a later prompt flips to working).
  expect(reopened?.state).toBe("stopped");
  // New OS process: pid refreshed off the resume event.
  expect(reopened?.pid).toBe(2000);
  // Identity preserved: created_at unchanged, spawn title not re-seeded/clobbered.
  expect(reopened?.created_at).toBe(createdAt);
  expect(reopened?.title).toBe("my-job");
  expect(reopened?.title_source).toBe("spawn");
});

test("SessionStart on a stopped (non-ended) job leaves state stopped", () => {
  // The CASE only re-opens 'ended'; a resume/compact SessionStart on a stopped
  // row is a state no-op (it still bumps pid/last_event_id).
  insertEvent({ hook_event: "SessionStart", pid: 1000 });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({ hook_event: "Stop" });
  drainAll();
  expect(getJob()?.state).toBe("stopped");
  insertEvent({ hook_event: "SessionStart", pid: 2000 });
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("stopped");
  expect(job?.pid).toBe(2000);
});

test("resume re-open re-folds idempotently: rebuild-from-scratch yields stopped", () => {
  insertEvent({ hook_event: "SessionStart", pid: 1000 });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({ hook_event: "SessionEnd" });
  insertEvent({ hook_event: "SessionStart", pid: 2000 }); // resume
  drainAll();
  expect(getJob()?.state).toBe("stopped");
  expect(getJob()?.pid).toBe(2000);

  // The re-open is driven by the event log, not a direct jobs write, so a
  // rewind-and-redrain must reproduce the identical final (state, pid).
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  expect(getJob()?.state).toBe("stopped");
  expect(getJob()?.pid).toBe(2000);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("terminal event without prior SessionStart creates no row, advances cursor", () => {
  const id = insertEvent({ hook_event: "SessionEnd", session_id: "ghost" });
  drainAll();
  expect(getJob("ghost")).toBeNull();
  expect(getCursor()).toBe(id);
});

test("duplicate SessionStart on a live job leaves state + cwd untouched", () => {
  insertEvent({ hook_event: "SessionStart", cwd: "/first" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  // A duplicate SessionStart (compact/clear) on a NON-ended job: the upsert's
  // CASE leaves a working state as-is, and cwd is set-once identity (not in the
  // ON CONFLICT SET), so neither moves.
  insertEvent({ hook_event: "SessionStart", cwd: "/second" });
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("working");
  expect(job?.cwd).toBe("/first");
});

test("malformed data blob logs to stderr and advances cursor without halting", () => {
  insertEvent({ hook_event: "SessionStart" });
  // A non-JSON data blob hits the title rule's JSON.parse; it must be caught +
  // logged, not thrown.
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  try {
    const badId = insertEvent({
      hook_event: "Notification",
      data: "{not valid json",
    });
    insertEvent({ hook_event: "UserPromptSubmit" });
    drainAll();
    // reducer did not halt — the later event still folded.
    expect(getJob()?.state).toBe("working");
    expect(getCursor()).toBeGreaterThan(badId);
    expect(errors.some((e) => e.includes("failed to parse data blob"))).toBe(
      true,
    );
  } finally {
    console.error = originalError;
  }
});

// ---------------------------------------------------------------------------
// Killed fold (synthetic Killed → state='killed', terminal-but-revivable)
// ---------------------------------------------------------------------------

test("Killed with matching (pid, start_time) folds to killed", () => {
  insertEvent({
    hook_event: "SessionStart",
    pid: 1234,
    start_time: "macos:Wed May 22 10:00:00 2026",
  });
  drainAll();
  expect(getJob()?.state).toBe("stopped");
  expect(getJob()?.start_time).toBe("macos:Wed May 22 10:00:00 2026");

  const killedId = killedEvent(1234, "macos:Wed May 22 10:00:00 2026");
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("killed");
  expect(job?.last_event_id).toBe(killedId);
  expect(getCursor()).toBe(killedId);
});

test("Killed with mismatched start_time is a safe no-op (cursor still advances)", () => {
  insertEvent({
    hook_event: "SessionStart",
    pid: 1234,
    start_time: "macos:Wed May 22 10:00:00 2026",
  });
  drainAll();
  const beforeLastId = getJob()?.last_event_id;

  // Same pid, different start_time — pid was recycled into a different process.
  const killedId = killedEvent(1234, "macos:Fri Nov 13 12:00:00 2026");
  drainAll();
  const job = getJob();
  // Row unchanged: state still 'stopped', last_event_id unchanged (no row write).
  expect(job?.state).toBe("stopped");
  expect(job?.last_event_id).toBe(beforeLastId ?? 0);
  // Cursor STILL advanced past the stale Killed event (safe no-op).
  expect(getCursor()).toBe(killedId);
});

test("Killed with mismatched pid is a safe no-op", () => {
  insertEvent({
    hook_event: "SessionStart",
    pid: 1234,
    start_time: "macos:t1",
  });
  drainAll();
  const beforeLastId = getJob()?.last_event_id;

  const killedId = killedEvent(9999, "macos:t1");
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("stopped");
  expect(job?.last_event_id).toBe(beforeLastId ?? 0);
  expect(getCursor()).toBe(killedId);
});

test("Killed against legacy row (start_time NULL) loose-matches on pid alone", () => {
  // Legacy rows whose SessionStart pre-dated schema v9 carry start_time=NULL.
  // Per Q7, the Killed fold loose-matches on pid alone for these rows.
  insertEvent({ hook_event: "SessionStart", pid: 1234 }); // no start_time
  drainAll();
  expect(getJob()?.start_time).toBeNull();

  const killedId = killedEvent(1234, "macos:any-value-ignored");
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("killed");
  expect(job?.last_event_id).toBe(killedId);
});

test("Killed for a non-existent jobs row is a safe no-op", () => {
  const killedId = killedEvent(1234, "macos:t1", "ghost");
  drainAll();
  expect(getJob("ghost")).toBeNull();
  expect(getCursor()).toBe(killedId);
});

test("Killed with malformed data blob skip-and-logs and advances cursor", () => {
  insertEvent({
    hook_event: "SessionStart",
    pid: 1234,
    start_time: "macos:t1",
  });
  drainAll();
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  try {
    const badId = insertEvent({
      hook_event: "Killed",
      data: "{not valid json",
    });
    drainAll();
    // Row unchanged; cursor advanced past the bad event.
    expect(getJob()?.state).toBe("stopped");
    expect(getCursor()).toBe(badId);
    expect(errors.some((e) => e.includes("Killed payload"))).toBe(true);
  } finally {
    console.error = originalError;
  }
});

test("Killed with missing pid in payload is a safe no-op", () => {
  insertEvent({
    hook_event: "SessionStart",
    pid: 1234,
    start_time: "macos:t1",
  });
  drainAll();
  const beforeLastId = getJob()?.last_event_id;
  const killedId = insertEvent({
    hook_event: "Killed",
    data: JSON.stringify({ start_time: "macos:t1" }), // no pid
  });
  drainAll();
  expect(getJob()?.state).toBe("stopped");
  expect(getJob()?.last_event_id).toBe(beforeLastId ?? 0);
  expect(getCursor()).toBe(killedId);
});

test("SessionStart re-opens a killed row: killed -> stopped, pid+start_time refreshed", () => {
  insertEvent({
    hook_event: "SessionStart",
    pid: 1000,
    start_time: "macos:t1",
  });
  killedEvent(1000, "macos:t1");
  drainAll();
  expect(getJob()?.state).toBe("killed");

  // A fresh `claude --resume` lands a new SessionStart with a new (pid, start_time).
  insertEvent({
    hook_event: "SessionStart",
    pid: 2000,
    start_time: "macos:t2",
  });
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("stopped");
  expect(job?.pid).toBe(2000);
  expect(job?.start_time).toBe("macos:t2");
});

test("UserPromptSubmit re-opens a killed row with new pid: killed -> working, pid refreshed, start_time CLEARED", () => {
  insertEvent({
    hook_event: "SessionStart",
    pid: 1000,
    start_time: "macos:t1",
  });
  killedEvent(1000, "macos:t1");
  drainAll();
  expect(getJob()?.state).toBe("killed");

  // A prompt arriving with a new pid (the live re-attached process). UPS does
  // not carry start_time, but the persisted "macos:t1" now describes a
  // dead/recycled process — leaving it stuck would let the next boot's seed
  // sweep emit a synthetic Killed that the reducer's strict (pid, start_time)
  // match would fold the live row to 'killed'. The fold clears start_time to
  // NULL on pid change so producers fall back to the legacy-loose branch
  // ("pid alive + no stored start_time → cannot prove recycle. Leave alone.")
  // until the next SessionStart refreshes it.
  insertEvent({ hook_event: "UserPromptSubmit", pid: 2000 });
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("working");
  expect(job?.pid).toBe(2000);
  expect(job?.start_time).toBe(null);
});

test("UserPromptSubmit with SAME pid preserves start_time (no-op on identity)", () => {
  // When pid is unchanged, start_time still describes the live process —
  // clearing it would be a regression (we'd lose the recycle-safe identity
  // we already have). The fold's CASE leaves start_time alone in this branch.
  insertEvent({
    hook_event: "SessionStart",
    pid: 1000,
    start_time: "macos:t1",
  });
  insertEvent({ hook_event: "UserPromptSubmit", pid: 1000 });
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("working");
  expect(job?.pid).toBe(1000);
  expect(job?.start_time).toBe("macos:t1");
});

test("UserPromptSubmit with missing pid (legacy hook) preserves persisted pid + start_time", () => {
  // Legacy hook payloads omit pid. The COALESCE leaves pid alone; the CASE's
  // first conjunct (`event.pid IS NOT NULL`) is false, so start_time is also
  // preserved. Behavior unchanged from pre-fix.
  //
  // We insert the UPS event row directly with raw SQL because the test
  // helper's `??` defaults `pid: null` to 4242 — the bypass is the only way
  // to express "event.pid is genuinely NULL" given that helper.
  insertEvent({
    hook_event: "SessionStart",
    pid: 1000,
    start_time: "macos:t1",
  });
  db.run(
    `INSERT INTO events (
       ts, session_id, pid, hook_event, event_type, tool_name, matcher,
       cwd, permission_mode, agent_id, agent_type, stop_hook_active, data,
       subagent_agent_id, spawn_name, start_time
     ) VALUES (?, 'sess-a', NULL, 'UserPromptSubmit', 'UserPromptSubmit',
              NULL, NULL, '/tmp/work', NULL, NULL, NULL, NULL, '{}',
              NULL, NULL, NULL)`,
    [tsCounter++],
  );
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("working");
  expect(job?.pid).toBe(1000);
  expect(job?.start_time).toBe("macos:t1");
});

test("cross-boot: kill -> UPS-resume-new-pid -> daemon restart (seed sweep) keeps row 'working'", () => {
  // The end-to-end regression chain documented in
  // fn-579-fix-stale-start-time-on-ups-resume.1:
  //
  //   1. SessionStart(pid=1000, start_time=X)  → (stopped, 1000, X)
  //   2. Killed(pid=1000, start_time=X)        → (killed,  1000, X)
  //   3. UserPromptSubmit(pid=process.pid)     → (working, process.pid, NULL)
  //          ^ live pid; without the fix, start_time stayed at X.
  //   4. seedKilledSweep against the same DB simulates daemon restart. The
  //      row's pid is alive (we use process.pid). With start_time stuck at X
  //      the sweep would compare osStart != X and emit a synthetic Killed
  //      carrying the stored X — the reducer would strict-match (process.pid,
  //      X) against the row's (process.pid, X) and fold to 'killed', silently
  //      hiding the live resumed session from the default jobs view.
  //
  //   With the fix (start_time cleared to NULL on pid change in the UPS fold),
  //   the sweep takes the legacy-loose branch ("pid alive + no stored
  //   start_time → cannot prove recycle. Leave alone.") and emits NOTHING.
  //   The row stays 'working' across the simulated boot.
  insertEvent({
    hook_event: "SessionStart",
    pid: 1000,
    start_time: "macos:t1",
  });
  killedEvent(1000, "macos:t1");
  drainAll();
  expect(getJob()?.state).toBe("killed");

  // Resume into a live process. process.pid is alive for the duration of the
  // test, so seedKilledSweep's `isPidAlive` probe will return true.
  const livePid = process.pid;
  insertEvent({ hook_event: "UserPromptSubmit", pid: livePid });
  drainAll();
  {
    const job = getJob();
    expect(job?.state).toBe("working");
    expect(job?.pid).toBe(livePid);
    // The fix: start_time cleared, so the row is now in the loose-pid-only
    // identity state until the next SessionStart refreshes it.
    expect(job?.start_time).toBe(null);
  }

  // Snapshot the synthetic Killed event count before the simulated boot.
  const killedBefore = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM events WHERE hook_event = 'Killed' AND session_id = 'sess-a'",
      )
      .get() as { n: number }
  ).n;

  // Simulate daemon restart: run the seed sweep against the same DB and drain.
  seedKilledSweep(db);
  drainAll();

  // The sweep emitted NO new Killed event (legacy-loose branch: pid alive +
  // stored start_time is NULL → leave alone).
  const killedAfter = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM events WHERE hook_event = 'Killed' AND session_id = 'sess-a'",
      )
      .get() as { n: number }
  ).n;
  expect(killedAfter).toBe(killedBefore);

  // And the row is still 'working' — the live resumed session survives the
  // restart.
  const after = getJob();
  expect(after?.state).toBe("working");
  expect(after?.pid).toBe(livePid);
  expect(after?.start_time).toBe(null);
});

test("Stop on a killed row is a no-op (terminal guard)", () => {
  insertEvent({ hook_event: "SessionStart", pid: 1000, start_time: "t1" });
  killedEvent(1000, "t1");
  drainAll();
  const beforeLastId = getJob()?.last_event_id;
  insertEvent({ hook_event: "Stop" });
  drainAll();
  // Row still killed, last_event_id unchanged (the guard skipped the write).
  expect(getJob()?.state).toBe("killed");
  expect(getJob()?.last_event_id).toBe(beforeLastId ?? 0);
});

test("SessionEnd on a killed row is a no-op (terminal guard, killed stays)", () => {
  // killed carries the proven-dead (pid, start_time) evidence — more
  // informative than ended — so a late SessionEnd must not clobber it.
  insertEvent({ hook_event: "SessionStart", pid: 1000, start_time: "t1" });
  killedEvent(1000, "t1");
  drainAll();
  const beforeLastId = getJob()?.last_event_id;
  insertEvent({ hook_event: "SessionEnd" });
  drainAll();
  expect(getJob()?.state).toBe("killed");
  expect(getJob()?.last_event_id).toBe(beforeLastId ?? 0);
});

test("PostToolUse / Notification on a killed row are no-ops (default branch, no state write)", () => {
  insertEvent({ hook_event: "SessionStart", pid: 1000, start_time: "t1" });
  killedEvent(1000, "t1");
  drainAll();
  insertEvent({ hook_event: "PostToolUse", tool_name: "Bash" });
  const lastId = insertEvent({ hook_event: "Notification" });
  drainAll();
  // Default branch writes no state; the row stays killed and the cursor advances.
  expect(getJob()?.state).toBe("killed");
  expect(getCursor()).toBe(lastId);
});

test("Killed -> SessionStart -> Stop -> SessionEnd full revival cycle folds correctly", () => {
  insertEvent({ hook_event: "SessionStart", pid: 1000, start_time: "t1" });
  killedEvent(1000, "t1");
  drainAll();
  expect(getJob()?.state).toBe("killed");

  // Re-attach: new process, new identity.
  insertEvent({ hook_event: "SessionStart", pid: 2000, start_time: "t2" });
  drainAll();
  expect(getJob()?.state).toBe("stopped");

  // Live work + clean end.
  insertEvent({ hook_event: "UserPromptSubmit" });
  drainAll();
  expect(getJob()?.state).toBe("working");

  insertEvent({ hook_event: "Stop" });
  drainAll();
  expect(getJob()?.state).toBe("stopped");

  insertEvent({ hook_event: "SessionEnd" });
  drainAll();
  expect(getJob()?.state).toBe("ended");
});

test("Killed re-folds idempotently: rewind + redrain reproduces killed byte-identically", () => {
  insertEvent({
    hook_event: "SessionStart",
    pid: 1000,
    start_time: "macos:t1",
  });
  killedEvent(1000, "macos:t1");
  drainAll();
  const before = getJob();
  expect(before?.state).toBe("killed");

  // Rewind cursor + projection; the SAME event log must replay to the same row.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  const after = getJob();
  expect(after).toEqual(before);
});

test("Killed re-fold determinism with interleaved revival: SessionStart -> Killed -> SessionStart", () => {
  // A killed row revived by a SessionStart, then killed again by a new Killed
  // event targeting the NEW (pid, start_time) — re-fold from scratch must
  // reproduce the same final state.
  insertEvent({ hook_event: "SessionStart", pid: 1000, start_time: "t1" });
  killedEvent(1000, "t1");
  insertEvent({ hook_event: "SessionStart", pid: 2000, start_time: "t2" });
  killedEvent(2000, "t2");
  drainAll();
  const before = getJob();
  expect(before?.state).toBe("killed");
  expect(before?.pid).toBe(2000);
  expect(before?.start_time).toBe("t2");

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  const after = getJob();
  expect(after).toEqual(before);
});

test("SessionStart seeds jobs.start_time from event.start_time (set-once on first sight)", () => {
  insertEvent({
    hook_event: "SessionStart",
    pid: 1000,
    start_time: "macos:Wed May 22 10:00:00 2026",
  });
  drainAll();
  expect(getJob()?.start_time).toBe("macos:Wed May 22 10:00:00 2026");
});

test("SessionStart with no start_time leaves jobs.start_time NULL (legacy)", () => {
  insertEvent({ hook_event: "SessionStart", pid: 1000 });
  drainAll();
  expect(getJob()?.start_time).toBeNull();
});

test("SessionStart resume COALESCEs start_time: persisted value preserved when new event has none", () => {
  insertEvent({ hook_event: "SessionStart", pid: 1000, start_time: "t1" });
  drainAll();
  expect(getJob()?.start_time).toBe("t1");
  // A resume SessionStart with no captured start_time MUST NOT clobber the
  // persisted value (COALESCE(excluded.start_time, jobs.start_time)).
  insertEvent({ hook_event: "SessionStart", pid: 2000 });
  drainAll();
  const job = getJob();
  expect(job?.pid).toBe(2000);
  expect(job?.start_time).toBe("t1");
});

// ---------------------------------------------------------------------------
// Title fold (session_title → title)
// ---------------------------------------------------------------------------

/** A UserPromptSubmit carrying a session_title in its data blob. */
function titleEvent(title: string, session_id = "sess-a"): number {
  return insertEvent({
    hook_event: "UserPromptSubmit",
    session_id,
    data: JSON.stringify({ session_title: title }),
  });
}

/**
 * A synthetic TranscriptTitle event (priority-3 'transcript' source). Mirrors
 * what keeperd's main thread inserts when the watcher sees a `custom-title`
 * line — title carried in `data.session_title`, same field as `titleEvent`.
 */
function transcriptTitleEvent(title: string, session_id = "sess-a"): number {
  return insertEvent({
    hook_event: "TranscriptTitle",
    session_id,
    data: JSON.stringify({ session_title: title }),
  });
}

test("first session_title seeds title", () => {
  insertEvent({ hook_event: "SessionStart" });
  titleEvent("foo");
  drainAll();
  expect(getJob()?.title).toBe("foo");
});

test("title follows the latest session_title (last-write-wins)", () => {
  insertEvent({ hook_event: "SessionStart" });
  titleEvent("foo");
  titleEvent("bar");
  titleEvent("foo"); // revert — title just follows the latest value
  drainAll();
  expect(getJob()?.title).toBe("foo");
});

test("unchanged title fires no write (last_event_id unchanged by the title rule)", () => {
  insertEvent({ hook_event: "SessionStart" });
  // Carry the title on a non-lifecycle event so ONLY the title rule could write
  // (a UserPromptSubmit would bump last_event_id via its own state-rule).
  insertEvent({
    hook_event: "Notification",
    data: JSON.stringify({ session_title: "foo" }),
  });
  drainAll();
  const afterFirst = getJob();
  const lastId = afterFirst?.last_event_id ?? 0;

  // A second identical title on another non-lifecycle event — the title rule
  // must skip the write (no last_event_id bump).
  const repeatId = insertEvent({
    hook_event: "Notification",
    data: JSON.stringify({ session_title: "foo" }),
  });
  drainAll();
  const afterRepeat = getJob();
  expect(afterRepeat?.last_event_id).toBe(lastId);
  expect(afterRepeat?.last_event_id).toBeLessThan(repeatId);
  expect(afterRepeat?.title).toBe("foo");
  // The cursor still advanced past the no-op title event.
  expect(getCursor()).toBe(repeatId);
});

test("title-bearing event for a non-existent job is a no-op", () => {
  // No SessionStart for "ghost" — the title rule's SELECT finds no row.
  const id = titleEvent("foo", "ghost");
  drainAll();
  expect(getJob("ghost")).toBeNull();
  expect(getCursor()).toBe(id);
});

test("malformed data blob with a session_title still skip-and-logs and advances", () => {
  insertEvent({ hook_event: "SessionStart" });
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  try {
    const badId = insertEvent({
      hook_event: "UserPromptSubmit",
      data: '{"session_title": "foo"', // truncated — invalid JSON
    });
    drainAll();
    // No title written (the parse failed) but the cursor advanced.
    expect(getJob()?.title).toBeNull();
    expect(getCursor()).toBe(badId);
    expect(errors.some((e) => e.includes("failed to parse data blob"))).toBe(
      true,
    );
  } finally {
    console.error = originalError;
  }
});

test("title fold re-folds idempotently: draining from scratch yields identical title", () => {
  insertEvent({ hook_event: "SessionStart" });
  titleEvent("foo");
  titleEvent("bar");
  titleEvent("foo");
  drainAll();
  expect(getJob()?.title).toBe("foo");

  // Rewind the cursor and projection, then re-fold the SAME event stream from
  // scratch — the persisted-title comparison must reproduce the identical title.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  expect(getJob()?.title).toBe("foo");
});

// ---------------------------------------------------------------------------
// plan_verb / plan_ref derivation (spawn_name → jobs columns, v10)
// ---------------------------------------------------------------------------

test("SessionStart with work::<ref> seeds plan_verb='work' / plan_ref=<ref>", () => {
  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "work::fn-575-osc-parser.3",
  });
  drainAll();
  const job = getJob();
  expect(job?.plan_verb).toBe("work");
  expect(job?.plan_ref).toBe("fn-575-osc-parser.3");
});

test("SessionStart with close::<epic> seeds plan_verb='close' / plan_ref=<epic>", () => {
  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "close::fn-575-osc-parser",
  });
  drainAll();
  const job = getJob();
  expect(job?.plan_verb).toBe("close");
  expect(job?.plan_ref).toBe("fn-575-osc-parser");
});

test("SessionStart with plan::<ref> seeds plan_verb='plan' / plan_ref=<ref>", () => {
  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "plan::fn-100-new-thing",
  });
  drainAll();
  const job = getJob();
  expect(job?.plan_verb).toBe("plan");
  expect(job?.plan_ref).toBe("fn-100-new-thing");
});

test("SessionStart with audit::<ref> leaves plan_verb/plan_ref NULL (whitelist excludes audit)", () => {
  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "audit::fn-1-foo",
  });
  drainAll();
  const job = getJob();
  expect(job?.plan_verb).toBeNull();
  expect(job?.plan_ref).toBeNull();
});

test("SessionStart with no spawn_name leaves plan_verb/plan_ref NULL", () => {
  insertEvent({ hook_event: "SessionStart" });
  drainAll();
  const job = getJob();
  expect(job?.plan_verb).toBeNull();
  expect(job?.plan_ref).toBeNull();
});

test("SessionStart with malformed verb::ref::extra leaves both NULL", () => {
  // The `$` anchor rejects extra `::` segments — the spawn name can never
  // partial-match and land wrong data in the projection.
  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "work::fn-1-foo::extra",
  });
  drainAll();
  const job = getJob();
  expect(job?.plan_verb).toBeNull();
  expect(job?.plan_ref).toBeNull();
});

test("SessionStart with non-fn-shaped ref leaves both NULL", () => {
  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "work::not-an-fn-ref",
  });
  drainAll();
  const job = getJob();
  expect(job?.plan_verb).toBeNull();
  expect(job?.plan_ref).toBeNull();
});

test("duplicate SessionStart leaves plan_verb/plan_ref untouched (set-once identity)", () => {
  // First SessionStart seeds (work, fn-575-foo.1). A second SessionStart with
  // a DIFFERENT verb/ref must NOT overwrite — set-once mirrors the title /
  // title_source precedence rule on RESUME.
  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "work::fn-575-foo.1",
    pid: 1000,
  });
  drainAll();
  expect(getJob()?.plan_verb).toBe("work");
  expect(getJob()?.plan_ref).toBe("fn-575-foo.1");

  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "close::fn-999-other",
    pid: 2000,
  });
  drainAll();
  const job = getJob();
  // pid refreshed via RESUME, but plan_verb / plan_ref stay at the first-sight
  // values — even though the new spawn_name parses cleanly.
  expect(job?.pid).toBe(2000);
  expect(job?.plan_verb).toBe("work");
  expect(job?.plan_ref).toBe("fn-575-foo.1");
});

test("duplicate SessionStart that clears spawn_name leaves plan_verb/plan_ref untouched", () => {
  // RESUME with no spawn_name also must not clear the seeded pair — the ON
  // CONFLICT branch never touches these columns, regardless of incoming value.
  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "work::fn-575-foo.1",
  });
  drainAll();
  expect(getJob()?.plan_verb).toBe("work");

  insertEvent({ hook_event: "SessionStart" });
  drainAll();
  const job = getJob();
  expect(job?.plan_verb).toBe("work");
  expect(job?.plan_ref).toBe("fn-575-foo.1");
});

test("plan_verb/plan_ref re-fold idempotently: rewind + redrain reproduces seeded pair", () => {
  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "close::fn-575-osc-parser",
  });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({ hook_event: "Stop" });
  drainAll();
  const before = getJob();
  expect(before?.plan_verb).toBe("close");
  expect(before?.plan_ref).toBe("fn-575-osc-parser");

  // The pair is a pure function of the event log — a rewind + DELETE + redrain
  // must reproduce identical (plan_verb, plan_ref).
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  const after = getJob();
  expect(after?.plan_verb).toBe("close");
  expect(after?.plan_ref).toBe("fn-575-osc-parser");
});

test("plan_verb/plan_ref re-fold idempotency on RESUME: rewind reproduces FIRST spawn (not later)", () => {
  // Two SessionStarts with different spawn_names. The first wins (set-once
  // identity on RESUME). A rewind+redrain must reproduce that same first-wins
  // outcome — the second SessionStart's spawn_name never lands in the row.
  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "work::fn-1-first",
  });
  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "close::fn-2-second",
  });
  drainAll();
  expect(getJob()?.plan_verb).toBe("work");
  expect(getJob()?.plan_ref).toBe("fn-1-first");

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  expect(getJob()?.plan_verb).toBe("work");
  expect(getJob()?.plan_ref).toBe("fn-1-first");
});

// ---------------------------------------------------------------------------
// Title provenance / precedence (spawn_name seed + {spawn:1, payload:2})
// ---------------------------------------------------------------------------

test("SessionStart with spawn_name seeds title + title_source='spawn'", () => {
  insertEvent({ hook_event: "SessionStart", spawn_name: "fix-osc" });
  drainAll();
  const job = getJob();
  expect(job?.title).toBe("fix-osc");
  expect(job?.title_source).toBe("spawn");
});

test("SessionStart without spawn_name leaves title NULL / title_source NULL", () => {
  insertEvent({ hook_event: "SessionStart" });
  drainAll();
  const job = getJob();
  expect(job?.title).toBeNull();
  expect(job?.title_source).toBeNull();
  // Tier 0 still folds: a later payload title seeds at first UserPromptSubmit.
  titleEvent("from-payload");
  drainAll();
  const after = getJob();
  expect(after?.title).toBe("from-payload");
  expect(after?.title_source).toBe("payload");
});

test("payload title promotes a spawn-seeded title even when the value is identical", () => {
  // spawn (priority 1) seeds; a payload (priority 2) whose value EQUALS the
  // spawn name must still write — the priority rose (p > pp), proving the
  // promotion path independent of value change.
  insertEvent({ hook_event: "SessionStart", spawn_name: "same-name" });
  drainAll();
  expect(getJob()?.title_source).toBe("spawn");
  titleEvent("same-name");
  drainAll();
  const job = getJob();
  expect(job?.title).toBe("same-name");
  expect(job?.title_source).toBe("payload");
});

test("payload title with a different value updates both value and source", () => {
  insertEvent({ hook_event: "SessionStart", spawn_name: "spawn-name" });
  drainAll();
  titleEvent("payload-name");
  drainAll();
  const job = getJob();
  expect(job?.title).toBe("payload-name");
  expect(job?.title_source).toBe("payload");
});

test("a spawn-priority source never overwrites a payload title (monotonicity)", () => {
  // Establish a payload title (priority 2), then fire a DUPLICATE SessionStart
  // carrying a spawn_name (priority 1). The resume upsert never touches
  // title/title_source, so the lower-priority spawn name can't clobber payload.
  insertEvent({ hook_event: "SessionStart", spawn_name: "spawn-name" });
  titleEvent("payload-name");
  drainAll();
  expect(getJob()?.title).toBe("payload-name");
  expect(getJob()?.title_source).toBe("payload");

  insertEvent({ hook_event: "SessionStart", spawn_name: "other-spawn" });
  drainAll();
  // Unchanged: spawn (1) cannot beat payload (2).
  expect(getJob()?.title).toBe("payload-name");
  expect(getJob()?.title_source).toBe("payload");
});

test("precedence re-folds idempotently: rebuild-from-scratch yields identical (title, source)", () => {
  insertEvent({ hook_event: "SessionStart", spawn_name: "seed" });
  titleEvent("first");
  titleEvent("second");
  drainAll();
  const before = getJob();
  expect(before?.title).toBe("second");
  expect(before?.title_source).toBe("payload");

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  const after = getJob();
  expect(after?.title).toBe("second");
  expect(after?.title_source).toBe("payload");
});

// ---------------------------------------------------------------------------
// Transcript title source (priority 3) + transcript_path seed
// ---------------------------------------------------------------------------

test("TranscriptTitle folds at priority 3, beating payload and spawn", () => {
  insertEvent({ hook_event: "SessionStart", spawn_name: "spawn-name" });
  titleEvent("payload-name");
  transcriptTitleEvent("transcript-name");
  drainAll();
  const job = getJob();
  expect(job?.title).toBe("transcript-name");
  expect(job?.title_source).toBe("transcript");
  // The TranscriptTitle event triggers no lifecycle write — state stays at the
  // last lifecycle event (UserPromptSubmit → working).
  expect(job?.state).toBe("working");
});

test("a later payload title does NOT clobber a transcript title", () => {
  insertEvent({ hook_event: "SessionStart" });
  transcriptTitleEvent("transcript-name");
  drainAll();
  expect(getJob()?.title_source).toBe("transcript");
  // A payload (priority 2) arriving AFTER the transcript title (priority 3)
  // with a DIFFERENT value must not write — the persisted source outranks it.
  titleEvent("stale-payload");
  drainAll();
  const job = getJob();
  expect(job?.title).toBe("transcript-name");
  expect(job?.title_source).toBe("transcript");
});

test("transcript re-folds idempotently with synthetic + lifecycle events interleaved", () => {
  insertEvent({ hook_event: "SessionStart", spawn_name: "seed" });
  titleEvent("from-prompt");
  transcriptTitleEvent("from-transcript");
  insertEvent({ hook_event: "Stop" });
  drainAll();
  const before = getJob();
  expect(before?.title).toBe("from-transcript");
  expect(before?.title_source).toBe("transcript");
  expect(before?.state).toBe("stopped");

  // Rewind + rebuild from scratch — the title MUST come from the event log, not
  // a direct jobs write, so the rebuild reproduces identical (title, source).
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  const after = getJob();
  expect(after?.title).toBe("from-transcript");
  expect(after?.title_source).toBe("transcript");
  expect(after?.state).toBe("stopped");
});

function getTranscriptPath(jobId = "sess-a"): string | null {
  const row = db
    .query("SELECT transcript_path FROM jobs WHERE job_id = ?")
    .get(jobId) as { transcript_path: string | null } | null;
  return row?.transcript_path ?? null;
}

test("SessionStart seeds transcript_path from event.data", () => {
  insertEvent({
    hook_event: "SessionStart",
    data: JSON.stringify({
      transcript_path: "/home/u/.claude/projects/x.jsonl",
    }),
  });
  drainAll();
  expect(getTranscriptPath()).toBe("/home/u/.claude/projects/x.jsonl");
});

test("SessionStart with no transcript_path leaves it NULL", () => {
  insertEvent({ hook_event: "SessionStart" });
  drainAll();
  expect(getTranscriptPath()).toBeNull();
});

test("SessionStart with malformed data blob leaves transcript_path NULL without throwing", () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  try {
    insertEvent({ hook_event: "SessionStart", data: "{not valid json" });
    drainAll();
    expect(getTranscriptPath()).toBeNull();
    // Row still inserted; reducer did not halt.
    expect(getJob()?.state).toBe("stopped");
    expect(errors.some((e) => e.includes("failed to parse data blob"))).toBe(
      true,
    );
  } finally {
    console.error = originalError;
  }
});

// ---------------------------------------------------------------------------
// Cursor / transaction invariants
// ---------------------------------------------------------------------------

test("applyEvent advances the cursor to the event id in one transaction", () => {
  const id = insertEvent({ hook_event: "SessionStart" });
  const event = db.query("SELECT * FROM events WHERE id = ?").get(id) as Event;
  applyEvent(db, event);
  expect(getCursor()).toBe(id);
  expect(getJob()?.last_event_id).toBe(id);
});

test("crash mid-fold rolls back BOTH the jobs write and the cursor advance", () => {
  const startId = insertEvent({ hook_event: "SessionStart" });
  drainAll();
  expect(getCursor()).toBe(startId);

  const upsId = insertEvent({ hook_event: "UserPromptSubmit" });
  const event = db
    .query("SELECT * FROM events WHERE id = ?")
    .get(upsId) as Event;

  // Inject a throw AFTER the jobs write but BEFORE the cursor advance.
  expect(() => {
    applyEvent(db, event, {
      onBeforeCursorAdvance: () => {
        throw new Error("simulated crash mid-fold");
      },
    });
  }).toThrow("simulated crash mid-fold");

  // Whole transaction rolled back: state never flipped to working...
  expect(getJob()?.state).toBe("stopped");
  // ...and the cursor never advanced past the SessionStart.
  expect(getCursor()).toBe(startId);

  // Re-folding (boot drain) converges idempotently.
  drainAll();
  expect(getJob()?.state).toBe("working");
  expect(getCursor()).toBe(upsId);
});

// ---------------------------------------------------------------------------
// drain() batching + idempotency
// ---------------------------------------------------------------------------

test("drain consumes events id > cursor in batches and returns count", () => {
  insertEvent({ hook_event: "SessionStart" });
  for (let i = 0; i < 5; i++) {
    insertEvent({ hook_event: "PreToolUse", tool_name: "Bash" });
  }
  const lastId = insertEvent({ hook_event: "Stop" });

  // 7 events total (1 + 5 + 1). batchSize 3 -> 3, 3, 1, 0.
  expect(drain(db, 3)).toBe(3);
  expect(drain(db, 3)).toBe(3);
  expect(drain(db, 3)).toBe(1);
  expect(drain(db, 3)).toBe(0);
  expect(getCursor()).toBe(lastId);
});

test("drain default batch size is exported and used", () => {
  expect(DEFAULT_BATCH_SIZE).toBe(200);
  insertEvent({ hook_event: "SessionStart" });
  expect(drain(db)).toBe(1);
  expect(drain(db)).toBe(0);
});

test("drain returns 0 when caught up (no new event rows)", () => {
  insertEvent({ hook_event: "SessionStart" });
  drainAll();
  // A spurious data_version bump with no new rows: drain is a clean no-op.
  expect(drain(db)).toBe(0);
});

test("re-draining after full consumption is idempotent", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({ hook_event: "Stop" });
  insertEvent({ hook_event: "SessionEnd" });
  drainAll();

  const job1 = getJob();
  const cursor1 = getCursor();

  // Drain again: no new events, projection + cursor unchanged.
  const again = drainAll();
  expect(again).toBe(0);

  const job2 = getJob();
  expect(job2).toEqual(job1);
  expect(getCursor()).toBe(cursor1);
});

test("full lifecycle folds to ended", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit", permission_mode: "plan" });
  insertEvent({ hook_event: "PreToolUse", tool_name: "Read" });
  insertEvent({ hook_event: "Stop", permission_mode: "acceptEdits" });
  const endId = insertEvent({ hook_event: "SessionEnd" });
  drainAll();

  const job = getJob();
  expect(job?.state).toBe("ended");
  expect(getCursor()).toBe(endId);
});

// ---------------------------------------------------------------------------
// Plan fold (EpicSnapshot / TaskSnapshot → epics / tasks)
// ---------------------------------------------------------------------------

/**
 * Insert a synthetic EpicSnapshot event. The entity id rides in `session_id`
 * (the generic entity-key overload), the pre-computed snapshot rides in the
 * `data` blob — mirroring what keeperd's main thread inserts on a plan-worker
 * message.
 */
function epicSnapshotEvent(
  epicId: string,
  snapshot: Record<string, unknown>,
): number {
  return insertEvent({
    hook_event: "EpicSnapshot",
    session_id: epicId,
    data: JSON.stringify(snapshot),
  });
}

/** Insert a synthetic TaskSnapshot event (entity id in `session_id`). */
function taskSnapshotEvent(
  taskId: string,
  snapshot: Record<string, unknown>,
): number {
  return insertEvent({
    hook_event: "TaskSnapshot",
    session_id: taskId,
    data: JSON.stringify(snapshot),
  });
}

function getEpic(epicId: string) {
  return db.query("SELECT * FROM epics WHERE epic_id = ?").get(epicId) as {
    epic_id: string;
    epic_number: number | null;
    title: string | null;
    project_dir: string | null;
    status: string | null;
    approval: string;
    last_event_id: number | null;
    updated_at: number;
    tasks: string;
    depends_on_epics: string;
    jobs: string;
    job_links: string;
    last_validated_at: string | null;
    created_by_closer_of: string | null;
    sort_path: string;
    queue_jump: number;
  } | null;
}

/**
 * The element shape stored in `epics.tasks` as of schema v19. Schema v7
 * introduced the embedded array; v13 added `approval`; v19 renamed `status`
 * to `worker_phase` and added the planctl-native `runtime_status` sibling
 * (defaults to `"todo"`).
 */
interface EmbeddedTask {
  task_id: string;
  epic_id: string | null;
  task_number: number | null;
  title: string | null;
  target_repo: string | null;
  worker_phase?: string | null;
  runtime_status?: string;
  approval?: "approved" | "rejected" | "pending";
  depends_on: string[];
  jobs?: unknown[];
}

/** Decode an epic's embedded tasks array (schema v7). NULL/missing → []. */
function getTasks(epicId: string): EmbeddedTask[] {
  const row = db
    .query("SELECT tasks FROM epics WHERE epic_id = ?")
    .get(epicId) as { tasks: string | null } | null;
  if (row == null || row.tasks == null || row.tasks.length === 0) {
    return [];
  }
  return JSON.parse(row.tasks) as EmbeddedTask[];
}

/** Find one embedded task by id across all epics (schema v7). */
function getTask(taskId: string): EmbeddedTask | null {
  const rows = db.query("SELECT tasks FROM epics").all() as {
    tasks: string | null;
  }[];
  for (const r of rows) {
    if (r.tasks == null || r.tasks.length === 0) {
      continue;
    }
    const arr = JSON.parse(r.tasks) as EmbeddedTask[];
    const found = arr.find((t) => t.task_id === taskId);
    if (found != null) {
      return found;
    }
  }
  return null;
}

test("EpicSnapshot folds into an epics row with all columns + monotonic last_event_id", () => {
  const id = epicSnapshotEvent("fn-1-add-oauth", {
    epic_number: 1,
    title: "Add OAuth",
    project_dir: "/Users/mike/code/keeper",
    status: "open",
  });
  drainAll();
  const epic = getEpic("fn-1-add-oauth");
  expect(epic).toEqual({
    epic_id: "fn-1-add-oauth",
    epic_number: 1,
    title: "Add OAuth",
    project_dir: "/Users/mike/code/keeper",
    status: "open",
    // No `approval` in the blob → the fold defaults to "pending" (matches the
    // schema column NOT NULL DEFAULT and the plan-worker's coercion).
    approval: "pending",
    last_event_id: id,
    updated_at: epic?.updated_at ?? 0,
    // A first-sight EpicSnapshot defaults the embedded array to empty.
    tasks: "[]",
    // No depends_on_epics in the blob → the stored column defaults to "[]".
    depends_on_epics: "[]",
    // No `plan_ref`-bearing jobs have folded into this epic yet → defaults to "[]".
    jobs: "[]",
    // No planctl-invocation classifier edges have been folded yet → defaults to "[]".
    job_links: "[]",
    // No `last_validated_at` in the blob → folds to NULL (the schema column is
    // a plain nullable TEXT, no DEFAULT).
    last_validated_at: null,
    // Schema v29: created_by_closer_of stays NULL (no planctl links yet);
    // sort_path is derived immediately when epic_number is known (the
    // EpicSnapshot fold now computes it on first sight so parent chains
    // resolve without requiring a planctl event on the parent epic).
    created_by_closer_of: null,
    sort_path: "000001",
    // Schema v30: queue_jump defaults to 0 — no planctl_invocation envelope
    // with `queue_jump: true` has been observed for this epic.
    queue_jump: 0,
  });
  expect(epic?.last_event_id).toBe(id);
  expect(getCursor()).toBe(id);
});

test("TaskSnapshot folds into the parent epic's tasks array with all element fields + derived worker_phase + runtime_status", () => {
  // Seed the parent epic first so the task folds via the UPDATE path.
  epicSnapshotEvent("fn-1-add-oauth", {
    epic_number: 1,
    title: "Add OAuth",
    status: "open",
  });
  const id = taskSnapshotEvent("fn-1-add-oauth.3", {
    epic_id: "fn-1-add-oauth",
    task_number: 3,
    title: "Wire the callback",
    target_repo: "/Users/mike/code/keeper",
    // Schema v19: the producer (plan-worker → daemon → synthetic event)
    // ships BOTH `worker_phase` (renamed from `status`) and `runtime_status`
    // (planctl-native enum). The legacy `status` is still read defensively
    // (`worker_phase ?? status`) for re-fold determinism across the v18→v19
    // boundary, but new events ship the new key shape.
    worker_phase: "done",
    runtime_status: "in_progress",
  });
  drainAll();
  const task = getTask("fn-1-add-oauth.3");
  expect(task).toEqual({
    task_id: "fn-1-add-oauth.3",
    epic_id: "fn-1-add-oauth",
    task_number: 3,
    title: "Wire the callback",
    target_repo: "/Users/mike/code/keeper",
    worker_phase: "done",
    runtime_status: "in_progress",
    // No `approval` in the blob → the embedded element defaults to "pending"
    // (matches the plan-worker's coercion + the epic-level schema default).
    approval: "pending",
    // No depends_on in the blob → the embedded element defaults to [].
    depends_on: [],
    // First-sight task element with no prior plan_ref-bearing jobs folded
    // into its embedded `jobs` sub-array → defaults to [] (schema v11).
    jobs: [],
  });
  // The fold bumps the parent epic's last_event_id (so it patches).
  expect(getEpic("fn-1-add-oauth")?.last_event_id).toBe(id);
  expect(getCursor()).toBe(id);
});

test("TaskSnapshot before its epic inserts a shell row carrying the task", () => {
  const id = taskSnapshotEvent("fn-1-add-oauth.1", {
    epic_id: "fn-1-add-oauth",
    task_number: 1,
    title: "First",
    target_repo: "/repo",
    status: "open",
  });
  drainAll();
  // A shell epic row exists: epic_id set, scalar columns NULL, tasks carrying
  // the one task.
  const epic = getEpic("fn-1-add-oauth");
  expect(epic).not.toBeNull();
  expect(epic?.epic_number).toBeNull();
  expect(epic?.title).toBeNull();
  expect(epic?.status).toBeNull();
  expect(epic?.last_event_id).toBe(id);
  expect(getTasks("fn-1-add-oauth").map((t) => t.task_id)).toEqual([
    "fn-1-add-oauth.1",
  ]);
});

test("a later EpicSnapshot fills the shell scalars without clobbering the tasks array", () => {
  taskSnapshotEvent("fn-1.1", {
    epic_id: "fn-1",
    task_number: 1,
    title: "T",
    status: "open",
  });
  const epicId = epicSnapshotEvent("fn-1", {
    epic_number: 1,
    title: "Real Title",
    status: "active",
  });
  drainAll();
  const epic = getEpic("fn-1");
  expect(epic?.title).toBe("Real Title");
  expect(epic?.status).toBe("active");
  expect(epic?.last_event_id).toBe(epicId);
  // The array the shell held survives the EpicSnapshot upsert.
  expect(getTasks("fn-1").map((t) => t.task_id)).toEqual(["fn-1.1"]);
});

test("multiple tasks sort deterministically by (task_number, task_id)", () => {
  epicSnapshotEvent("fn-1", { epic_number: 1, title: "E", status: "open" });
  // Inserted out of order; the fold re-sorts on every write.
  taskSnapshotEvent("fn-1.2", { epic_id: "fn-1", task_number: 2, title: "B" });
  taskSnapshotEvent("fn-1.1", { epic_id: "fn-1", task_number: 1, title: "A" });
  taskSnapshotEvent("fn-1.3", { epic_id: "fn-1", task_number: 1, title: "C" });
  drainAll();
  // task_number asc, then task_id asc on the tie (1 < 1 → break on id).
  expect(getTasks("fn-1").map((t) => t.task_id)).toEqual([
    "fn-1.1",
    "fn-1.3",
    "fn-1.2",
  ]);
});

test("a TaskSnapshot for an existing task replaces (not appends) the element", () => {
  epicSnapshotEvent("fn-1", { epic_number: 1, title: "E", status: "open" });
  taskSnapshotEvent("fn-1.1", {
    epic_id: "fn-1",
    task_number: 1,
    title: "old",
  });
  taskSnapshotEvent("fn-1.1", {
    epic_id: "fn-1",
    task_number: 1,
    title: "new",
  });
  drainAll();
  const tasks = getTasks("fn-1");
  expect(tasks.length).toBe(1);
  expect(tasks[0]?.title).toBe("new");
});

test("a TaskSnapshot with no epic_id is skipped-and-logged (orphan), cursor advances", () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  try {
    const orphanId = taskSnapshotEvent("orphan.1", {
      task_number: 1,
      title: "no parent",
    });
    drainAll();
    // No epic row created for the orphan; cursor still advanced past it.
    expect(getTask("orphan.1")).toBeNull();
    expect(getCursor()).toBe(orphanId);
    expect(errors.some((e) => e.includes("no epic_id"))).toBe(true);
  } finally {
    console.error = originalError;
  }
});

test("a malformed stored tasks array folds to [] in-txn (never throws / wedges)", () => {
  // Plant a malformed array directly on an epic row, then fold a task into it.
  epicSnapshotEvent("fn-1", { epic_number: 1, title: "E", status: "open" });
  drainAll();
  db.run("UPDATE epics SET tasks = '{not json' WHERE epic_id = 'fn-1'");
  const id = taskSnapshotEvent("fn-1.1", {
    epic_id: "fn-1",
    task_number: 1,
    title: "T",
  });
  drainAll();
  // The fold treated the malformed array as [] and wrote just the new task —
  // no throw, the cursor advanced.
  expect(getTasks("fn-1").map((t) => t.task_id)).toEqual(["fn-1.1"]);
  expect(getCursor()).toBe(id);
});

test("a later epic snapshot for the same id upserts idempotently (last-write-wins)", () => {
  epicSnapshotEvent("fn-1-add-oauth", {
    epic_number: 1,
    title: "Add OAuth",
    project_dir: "/repo",
    status: "open",
  });
  const id2 = epicSnapshotEvent("fn-1-add-oauth", {
    epic_number: 1,
    title: "Add OAuth (renamed)",
    project_dir: "/repo",
    status: "done",
  });
  drainAll();
  const epic = getEpic("fn-1-add-oauth");
  expect(epic?.title).toBe("Add OAuth (renamed)");
  expect(epic?.status).toBe("done");
  expect(epic?.last_event_id).toBe(id2);
  // Exactly one row — the second snapshot updated, not inserted.
  const count = db.query("SELECT COUNT(*) AS n FROM epics").get() as {
    n: number;
  };
  expect(count.n).toBe(1);
});

test("malformed plan snapshot blob skips-and-logs but advances the cursor", () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  try {
    const badId = insertEvent({
      hook_event: "EpicSnapshot",
      session_id: "fn-bad",
      data: "{not valid json",
    });
    const goodId = epicSnapshotEvent("fn-ok", {
      epic_number: 2,
      title: "Fine",
      project_dir: "/repo",
      status: "open",
    });
    drainAll();
    // The bad blob produced no epics row but did not wedge the reducer.
    expect(getEpic("fn-bad")).toBeNull();
    expect(getEpic("fn-ok")?.title).toBe("Fine");
    expect(getCursor()).toBe(goodId);
    expect(getCursor()).toBeGreaterThan(badId);
    expect(
      errors.some((e) => e.includes("failed to parse plan snapshot blob")),
    ).toBe(true);
  } finally {
    console.error = originalError;
  }
});

test("plan folds do not touch the jobs projection", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  epicSnapshotEvent("fn-1", { epic_number: 1, title: "E", status: "open" });
  taskSnapshotEvent("fn-1.1", { epic_id: "fn-1", task_number: 1, title: "T" });
  drainAll();
  // Jobs folding is unchanged — the session row is still 'working'.
  expect(getJob()?.state).toBe("working");
  expect(getEpic("fn-1")?.title).toBe("E");
  expect(getTask("fn-1.1")?.title).toBe("T");
});

// ---------------------------------------------------------------------------
// Approval folding (schema v13 — fn-592-approval-as-planctl-field)
// ---------------------------------------------------------------------------

test("EpicSnapshot folds `approval` into the epics row (explicit value)", () => {
  epicSnapshotEvent("fn-1-app", {
    epic_number: 1,
    title: "T",
    status: "open",
    approval: "approved",
  });
  drainAll();
  expect(getEpic("fn-1-app")?.approval).toBe("approved");
});

test("EpicSnapshot defaults missing `approval` to 'pending' on the projection", () => {
  // A blob from an older daemon build (no `approval` key) folds to the
  // schema-default "pending" — re-fold determinism preserved.
  epicSnapshotEvent("fn-2-app", {
    epic_number: 2,
    title: "T",
    status: "open",
  });
  drainAll();
  expect(getEpic("fn-2-app")?.approval).toBe("pending");
});

test("EpicSnapshot ON CONFLICT updates `approval` (last-write-wins)", () => {
  epicSnapshotEvent("fn-3-app", {
    epic_number: 3,
    title: "T",
    status: "open",
    approval: "pending",
  });
  drainAll();
  expect(getEpic("fn-3-app")?.approval).toBe("pending");
  epicSnapshotEvent("fn-3-app", {
    epic_number: 3,
    title: "T",
    status: "open",
    approval: "approved",
  });
  drainAll();
  expect(getEpic("fn-3-app")?.approval).toBe("approved");
});

test("TaskSnapshot folds `approval` into the embedded task element", () => {
  epicSnapshotEvent("fn-4-app", { epic_number: 4, title: "E", status: "open" });
  taskSnapshotEvent("fn-4-app.1", {
    epic_id: "fn-4-app",
    task_number: 1,
    title: "T",
    approval: "rejected",
  });
  drainAll();
  expect(getTask("fn-4-app.1")?.approval).toBe("rejected");
});

test("TaskSnapshot defaults missing `approval` to 'pending' on the embedded element", () => {
  epicSnapshotEvent("fn-5-app", { epic_number: 5, title: "E", status: "open" });
  taskSnapshotEvent("fn-5-app.1", {
    epic_id: "fn-5-app",
    task_number: 1,
    title: "T",
  });
  drainAll();
  expect(getTask("fn-5-app.1")?.approval).toBe("pending");
});

test("TaskSnapshot RMW updates `approval` on an existing element without clobbering siblings", () => {
  epicSnapshotEvent("fn-6-app", { epic_number: 6, title: "E", status: "open" });
  taskSnapshotEvent("fn-6-app.1", {
    epic_id: "fn-6-app",
    task_number: 1,
    title: "T",
    approval: "pending",
  });
  taskSnapshotEvent("fn-6-app.2", {
    epic_id: "fn-6-app",
    task_number: 2,
    title: "U",
    approval: "approved",
  });
  drainAll();
  // Re-snapshot task 1 with a flipped approval; task 2 stays untouched.
  taskSnapshotEvent("fn-6-app.1", {
    epic_id: "fn-6-app",
    task_number: 1,
    title: "T",
    approval: "rejected",
  });
  drainAll();
  expect(getTask("fn-6-app.1")?.approval).toBe("rejected");
  expect(getTask("fn-6-app.2")?.approval).toBe("approved");
});

test("from-scratch re-fold reproduces `approval` byte-identically across epic + task", () => {
  // Build a non-trivial history exercising explicit + default approval values
  // on BOTH paths. Rewind + re-drain must reproduce the same row contents.
  epicSnapshotEvent("fn-7-app", {
    epic_number: 7,
    title: "E",
    status: "open",
    approval: "approved",
  });
  taskSnapshotEvent("fn-7-app.1", {
    epic_id: "fn-7-app",
    task_number: 1,
    title: "T1",
    approval: "rejected",
  });
  // A task with no approval — exercises the "pending" default path.
  taskSnapshotEvent("fn-7-app.2", {
    epic_id: "fn-7-app",
    task_number: 2,
    title: "T2",
  });
  // A later TaskSnapshot RMW that does NOT carry approval — preserves the
  // prior value on the element? NO: TaskSnapshot is a FULL snapshot per the
  // plan-worker spec, so absent approval folds to "pending" (last-write-wins
  // on the snapshot). The re-fold test only proves the deterministic shape;
  // semantic "preservation" of approval on an RMW carrying no field is NOT
  // intended (the plan-worker always emits the field).
  epicSnapshotEvent("fn-7-app", {
    epic_number: 7,
    title: "E v2",
    status: "open",
    approval: "approved",
  });
  drainAll();

  const before = db.query("SELECT * FROM epics ORDER BY epic_id").all();

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM epics");
  drainAll();

  const after = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  expect(after).toEqual(before);
});

// ---------------------------------------------------------------------------
// last_validated_at folding (schema v16 — fn-599-epic-validation-pill)
// ---------------------------------------------------------------------------

test("EpicSnapshot folds `last_validated_at` into the epics row (explicit value)", () => {
  epicSnapshotEvent("fn-1-val", {
    epic_number: 1,
    title: "T",
    status: "open",
    last_validated_at: "2026-05-24T00:00:00Z",
  });
  drainAll();
  expect(getEpic("fn-1-val")?.last_validated_at).toBe("2026-05-24T00:00:00Z");
});

test("EpicSnapshot defaults missing `last_validated_at` to NULL on the projection", () => {
  // A blob from an older daemon build (no `last_validated_at` key) folds to
  // NULL — the schema column is plain nullable TEXT with no DEFAULT.
  epicSnapshotEvent("fn-2-val", {
    epic_number: 2,
    title: "T",
    status: "open",
  });
  drainAll();
  expect(getEpic("fn-2-val")?.last_validated_at).toBeNull();
});

test("EpicSnapshot ON CONFLICT updates `last_validated_at` (last-write-wins)", () => {
  epicSnapshotEvent("fn-3-val", {
    epic_number: 3,
    title: "T",
    status: "open",
    last_validated_at: "2026-05-23T00:00:00Z",
  });
  drainAll();
  expect(getEpic("fn-3-val")?.last_validated_at).toBe("2026-05-23T00:00:00Z");
  epicSnapshotEvent("fn-3-val", {
    epic_number: 3,
    title: "T",
    status: "open",
    last_validated_at: "2026-05-24T00:00:00Z",
  });
  drainAll();
  expect(getEpic("fn-3-val")?.last_validated_at).toBe("2026-05-24T00:00:00Z");
});

test("from-scratch re-fold reproduces `last_validated_at` byte-identically", () => {
  // Build a history exercising explicit + missing last_validated_at values.
  // Rewind + re-drain must reproduce the same row contents.
  epicSnapshotEvent("fn-4-val", {
    epic_number: 4,
    title: "E",
    status: "open",
    last_validated_at: "2026-05-24T00:00:00Z",
  });
  // An epic with no last_validated_at — exercises the NULL default path.
  epicSnapshotEvent("fn-5-val", {
    epic_number: 5,
    title: "E",
    status: "open",
  });
  drainAll();

  const before = db.query("SELECT * FROM epics ORDER BY epic_id").all();

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM epics");
  drainAll();

  const after = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  expect(after).toEqual(before);
});

test("from-scratch re-fold reproduces byte-identical epics rows (incl. embedded tasks)", () => {
  // A TaskSnapshot BEFORE its EpicSnapshot exercises the shell-insert path on
  // replay; two tasks out of sort order exercise the deterministic re-sort.
  taskSnapshotEvent("fn-1.2", {
    epic_id: "fn-1",
    task_number: 2,
    title: "Second",
    target_repo: "/repo",
    status: "open",
  });
  epicSnapshotEvent("fn-1", {
    epic_number: 1,
    title: "Add OAuth",
    project_dir: "/repo",
    status: "open",
  });
  taskSnapshotEvent("fn-1.1", {
    epic_id: "fn-1",
    task_number: 1,
    title: "Wire callback",
    target_repo: "/repo",
    status: "done",
  });
  // A later snapshot for the epic (upsert) to exercise the conflict branch —
  // must NOT clobber the embedded tasks array.
  epicSnapshotEvent("fn-1", {
    epic_number: 1,
    title: "Add OAuth v2",
    project_dir: "/repo",
    status: "done",
  });
  drainAll();

  const epicsBefore = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  // Sanity: the embedded array is sorted (task_number, task_id) — same key the
  // migration backfill uses, so a migrated row equals this re-folded one.
  expect(getTasks("fn-1").map((t) => t.task_id)).toEqual(["fn-1.1", "fn-1.2"]);

  // Rewind the cursor + DELETE the projection, then re-drain. drain() replays
  // events in autoincrement-id order (not FS-arrival order), so the fold is a
  // pure function of the persisted log — the rebuilt rows must be byte-identical.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM epics");
  drainAll();

  const epicsAfter = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  expect(epicsAfter).toEqual(epicsBefore);
});

// ---------------------------------------------------------------------------
// Plan retraction (TaskDeleted / EpicDeleted tombstones)
// ---------------------------------------------------------------------------

/** Insert a synthetic TaskDeleted tombstone (entity id in session_id, epic_id in blob). */
function taskDeletedEvent(taskId: string, epicId: string | null): number {
  return insertEvent({
    hook_event: "TaskDeleted",
    session_id: taskId,
    data: JSON.stringify({ epic_id: epicId }),
  });
}

/** Insert a synthetic EpicDeleted tombstone (entity id in session_id, no blob). */
function epicDeletedEvent(epicId: string): number {
  return insertEvent({
    hook_event: "EpicDeleted",
    session_id: epicId,
    data: "",
  });
}

test("TaskDeleted splices the element from the parent epic array and bumps last_event_id", () => {
  epicSnapshotEvent("fn-1", { epic_number: 1, title: "E", status: "open" });
  taskSnapshotEvent("fn-1.1", {
    epic_id: "fn-1",
    task_number: 1,
    title: "One",
  });
  taskSnapshotEvent("fn-1.2", {
    epic_id: "fn-1",
    task_number: 2,
    title: "Two",
  });
  const delId = taskDeletedEvent("fn-1.1", "fn-1");
  drainAll();

  // The deleted element is gone; the surviving one remains, still sorted.
  expect(getTasks("fn-1").map((t) => t.task_id)).toEqual(["fn-1.2"]);
  // The retraction bumps the epic's version so the read surface patches it.
  expect(getEpic("fn-1")?.last_event_id).toBe(delId);
  expect(getCursor()).toBe(delId);
});

test("EpicDeleted removes the epic row (embedded tasks vanish with it)", () => {
  epicSnapshotEvent("fn-1", { epic_number: 1, title: "E", status: "open" });
  taskSnapshotEvent("fn-1.1", {
    epic_id: "fn-1",
    task_number: 1,
    title: "One",
  });
  const delId = epicDeletedEvent("fn-1");
  drainAll();

  expect(getEpic("fn-1")).toBeNull();
  expect(getCursor()).toBe(delId);
});

test("TaskDeleted/EpicDeleted are idempotent no-ops on a missing target, cursor advances", () => {
  // No epic, no task — both tombstones are no-ops but still advance the cursor.
  const t = taskDeletedEvent("fn-9.9", "fn-9");
  drainAll();
  expect(getEpic("fn-9")).toBeNull();
  expect(getCursor()).toBe(t);

  const e = epicDeletedEvent("fn-9");
  drainAll();
  expect(getCursor()).toBe(e);

  // A TaskDeleted whose element is already absent does not bump the epic row.
  epicSnapshotEvent("fn-2", { epic_number: 2, title: "E2", status: "open" });
  drainAll();
  const before = getEpic("fn-2");
  taskDeletedEvent("fn-2.5", "fn-2"); // element never existed
  drainAll();
  expect(getEpic("fn-2")?.last_event_id).toBe(before?.last_event_id);
});

test("TaskDeleted with a null epic_id is a no-op (can't place the splice)", () => {
  epicSnapshotEvent("fn-1", { epic_number: 1, title: "E", status: "open" });
  taskSnapshotEvent("fn-1.1", {
    epic_id: "fn-1",
    task_number: 1,
    title: "One",
  });
  drainAll();
  const before = getEpic("fn-1")?.last_event_id;
  taskDeletedEvent("fn-1.1", null);
  drainAll();
  // The element stays — a null epic_id can't be placed against a parent.
  expect(getTasks("fn-1").map((t) => t.task_id)).toEqual(["fn-1.1"]);
  expect(getEpic("fn-1")?.last_event_id).toBe(before);
});

test("from-scratch re-fold reproduces the spliced state across a create→delete sequence", () => {
  epicSnapshotEvent("fn-1", { epic_number: 1, title: "E", status: "open" });
  taskSnapshotEvent("fn-1.1", {
    epic_id: "fn-1",
    task_number: 1,
    title: "One",
  });
  taskSnapshotEvent("fn-1.2", {
    epic_id: "fn-1",
    task_number: 2,
    title: "Two",
  });
  taskDeletedEvent("fn-1.1", "fn-1");
  // An EpicDeleted followed by a later TaskSnapshot legitimately re-creates a
  // shell (the task still exists on disk) — replayed in id order it lands last.
  epicSnapshotEvent("fn-3", { epic_number: 3, title: "Gone", status: "open" });
  epicDeletedEvent("fn-3");
  taskSnapshotEvent("fn-3.1", {
    epic_id: "fn-3",
    task_number: 1,
    title: "Reborn",
  });
  drainAll();

  const epicsBefore = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  expect(getTasks("fn-1").map((t) => t.task_id)).toEqual(["fn-1.2"]);
  // fn-3 was deleted then a later task re-created it as a shell.
  expect(getTasks("fn-3").map((t) => t.task_id)).toEqual(["fn-3.1"]);

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM epics");
  drainAll();

  const epicsAfter = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  expect(epicsAfter).toEqual(epicsBefore);
});

// ---------------------------------------------------------------------------
// Embedded jobs (syncJobIntoEpic): schema v11
// ---------------------------------------------------------------------------

/** Helper: read an epic's embedded `jobs` array (NULL/missing → []). */
function getEpicJobs(epicId: string): {
  job_id: string;
  plan_verb: string;
  state: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  last_event_id: number;
}[] {
  const row = db
    .query("SELECT jobs FROM epics WHERE epic_id = ?")
    .get(epicId) as { jobs: string | null } | null;
  if (row == null || row.jobs == null || row.jobs.length === 0) {
    return [];
  }
  return JSON.parse(row.jobs);
}

/** Helper: read a task element's embedded `jobs` sub-array (NULL/missing → []). */
function getTaskJobs(taskId: string): {
  job_id: string;
  plan_verb: string;
  state: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  last_event_id: number;
}[] {
  const task = getTask(taskId);
  if (task == null || !Array.isArray(task.jobs)) {
    return [];
  }
  return task.jobs as ReturnType<typeof getTaskJobs>;
}

test("SessionStart with epic-level plan_ref fans into epic.jobs (verb plan)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-plan",
    spawn_name: "plan::fn-575-osc-parser",
  });
  drainAll();
  const jobs = getEpicJobs("fn-575-osc-parser");
  expect(jobs.length).toBe(1);
  expect(jobs[0]?.job_id).toBe("sess-plan");
  expect(jobs[0]?.plan_verb).toBe("plan");
  expect(jobs[0]?.state).toBe("stopped");
  expect(jobs[0]?.title).toBe("plan::fn-575-osc-parser");
  expect(getTasks("fn-575-osc-parser")).toEqual([]);
});

test("SessionStart with epic-level plan_ref fans into epic.jobs (verb close)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-close",
    spawn_name: "close::fn-9-bar",
  });
  drainAll();
  const jobs = getEpicJobs("fn-9-bar");
  expect(jobs.length).toBe(1);
  expect(jobs[0]?.plan_verb).toBe("close");
});

test("SessionStart with task-level plan_ref fans into task.jobs (verb work)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-work",
    spawn_name: "work::fn-575-foo.3",
  });
  drainAll();
  const epic = getEpic("fn-575-foo");
  expect(epic).not.toBeNull();
  expect(epic?.epic_number).toBeNull();
  expect(epic?.title).toBeNull();
  expect(getEpicJobs("fn-575-foo")).toEqual([]);
  const tasks = getTasks("fn-575-foo");
  expect(tasks.length).toBe(1);
  expect(tasks[0]?.task_id).toBe("fn-575-foo.3");
  const taskJobs = getTaskJobs("fn-575-foo.3");
  expect(taskJobs.length).toBe(1);
  expect(taskJobs[0]?.job_id).toBe("sess-work");
  expect(taskJobs[0]?.plan_verb).toBe("work");
  expect(taskJobs[0]?.state).toBe("stopped");
});

test("SessionEnd on a plan_ref job updates the embedded entry's state to ended", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-end",
    spawn_name: "plan::fn-1-foo",
  });
  drainAll();
  expect(getEpicJobs("fn-1-foo")[0]?.state).toBe("stopped");
  insertEvent({ hook_event: "SessionEnd", session_id: "sess-end" });
  drainAll();
  expect(getEpicJobs("fn-1-foo")[0]?.state).toBe("ended");
});

test("UserPromptSubmit on a plan_ref job updates embedded state to working", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-ups",
    spawn_name: "work::fn-1-foo.1",
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ups" });
  drainAll();
  const taskJobs = getTaskJobs("fn-1-foo.1");
  expect(taskJobs[0]?.state).toBe("working");
});

test("title change on a plan_ref job propagates to the embedded entry", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-title",
    spawn_name: "plan::fn-1-bar",
  });
  drainAll();
  expect(getEpicJobs("fn-1-bar")[0]?.title).toBe("plan::fn-1-bar");
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-title",
    data: JSON.stringify({ session_title: "Real Title" }),
  });
  drainAll();
  expect(getEpicJobs("fn-1-bar")[0]?.title).toBe("Real Title");
});

test("Killed-mismatch path does NOT fan into the embedded entry", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-killed",
    pid: 1234,
    start_time: "real-start",
    spawn_name: "close::fn-7-x",
  });
  drainAll();
  const before = getEpicJobs("fn-7-x")[0];
  expect(before?.state).toBe("stopped");
  const beforeEventId = before?.last_event_id;
  // A Killed event with the WRONG (pid, start_time) — stale/recycled.
  insertEvent({
    hook_event: "Killed",
    session_id: "sess-killed",
    data: JSON.stringify({ pid: 9999, start_time: "wrong-start" }),
  });
  drainAll();
  // The jobs row stayed unchanged → no sync fired, embedded entry stayed put.
  const after = getEpicJobs("fn-7-x")[0];
  expect(after?.state).toBe("stopped");
  expect(after?.last_event_id).toBe(beforeEventId ?? 0);
});

test("Killed matching path DOES fan into the embedded entry (state -> killed)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-killed-match",
    pid: 1234,
    start_time: "real-start",
    spawn_name: "close::fn-8-y",
  });
  drainAll();
  insertEvent({
    hook_event: "Killed",
    session_id: "sess-killed-match",
    data: JSON.stringify({ pid: 1234, start_time: "real-start" }),
  });
  drainAll();
  expect(getEpicJobs("fn-8-y")[0]?.state).toBe("killed");
});

test("an invalid plan_ref shape never throws and the cursor still advances", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-bad",
    spawn_name: "work::not_a_ref!",
  });
  drainAll();
  expect(getCursor()).toBeGreaterThan(0);
});

test("Stop on a still-terminal job does NOT fan (no write happened)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-stop-terminal",
    spawn_name: "plan::fn-2-z",
  });
  insertEvent({
    hook_event: "SessionEnd",
    session_id: "sess-stop-terminal",
  });
  drainAll();
  const beforeId = getEpicJobs("fn-2-z")[0]?.last_event_id;
  expect(getEpicJobs("fn-2-z")[0]?.state).toBe("ended");
  insertEvent({ hook_event: "Stop", session_id: "sess-stop-terminal" });
  drainAll();
  expect(getEpicJobs("fn-2-z")[0]?.state).toBe("ended");
  expect(getEpicJobs("fn-2-z")[0]?.last_event_id).toBe(beforeId ?? 0);
});

test("multiple plan_ref jobs sort (created_at desc, job_id asc)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-a-id",
    spawn_name: "plan::fn-1-multi",
    ts: 1000,
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-b-id",
    spawn_name: "plan::fn-1-multi",
    ts: 2000,
  });
  drainAll();
  const jobs = getEpicJobs("fn-1-multi");
  expect(jobs.map((j) => j.job_id)).toEqual(["sess-b-id", "sess-a-id"]);

  insertEvent({
    hook_event: "SessionStart",
    session_id: "alpha",
    spawn_name: "plan::fn-1-tie",
    ts: 5000,
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "beta",
    spawn_name: "plan::fn-1-tie",
    ts: 5000,
  });
  drainAll();
  expect(getEpicJobs("fn-1-tie").map((j) => j.job_id)).toEqual([
    "alpha",
    "beta",
  ]);
});

test("EpicSnapshot ON CONFLICT preserves epic.jobs (carve-out works)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-shell",
    spawn_name: "plan::fn-1-shell",
  });
  drainAll();
  expect(getEpicJobs("fn-1-shell").length).toBe(1);
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-1-shell",
    data: JSON.stringify({
      epic_number: 1,
      title: "Real",
      project_dir: "/repo",
      status: "open",
    }),
  });
  drainAll();
  const epic = getEpic("fn-1-shell");
  expect(epic?.title).toBe("Real");
  expect(epic?.status).toBe("open");
  expect(getEpicJobs("fn-1-shell").length).toBe(1);
  expect(getEpicJobs("fn-1-shell")[0]?.job_id).toBe("sess-shell");
});

test("TaskSnapshot RMW preserves the task element's jobs sub-array", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-pre-task",
    spawn_name: "work::fn-5-pre.2",
  });
  drainAll();
  expect(getTaskJobs("fn-5-pre.2").length).toBe(1);
  insertEvent({
    hook_event: "TaskSnapshot",
    session_id: "fn-5-pre.2",
    data: JSON.stringify({
      epic_id: "fn-5-pre",
      task_number: 2,
      title: "Real Task",
      target_repo: "/repo",
      // Schema v19: ship the new field names; the reducer also reads the
      // legacy `status` defensively (`worker_phase ?? status`) for re-fold
      // determinism across the boundary.
      worker_phase: "open",
      runtime_status: "todo",
    }),
  });
  drainAll();
  const task = getTask("fn-5-pre.2");
  expect(task?.title).toBe("Real Task");
  expect(task?.worker_phase).toBe("open");
  expect(task?.runtime_status).toBe("todo");
  expect(getTaskJobs("fn-5-pre.2").length).toBe(1);
  expect(getTaskJobs("fn-5-pre.2")[0]?.job_id).toBe("sess-pre-task");
});

test("syncJobIntoEpic carve-out preserves worker_phase + runtime_status across a jobs-write fan-out (schema v19)", () => {
  // The OLD-element carve-out at `reducer.ts:syncJobIntoEpic` spreads the
  // prior task element's scalars when re-attaching the freshly-merged jobs
  // sub-array (`{ ...oldTask, jobs: nextTaskJobs }`). Schema v19 added two
  // new scalar fields (`worker_phase` + `runtime_status`); without the spread
  // they'd be stomped to NULL/"todo" on every job tick. This test pins the
  // invariant: fold a TaskSnapshot first (planting both fields), then drive
  // a jobs-write that fans into the same task's embedded `jobs` sub-array,
  // and assert both fields survive verbatim.

  // 1. Plant a TaskSnapshot carrying both new fields. The reducer writes
  // the embedded task element with `worker_phase: "done"` and
  // `runtime_status: "in_progress"`.
  insertEvent({
    hook_event: "TaskSnapshot",
    session_id: "fn-5-carve.3",
    data: JSON.stringify({
      epic_id: "fn-5-carve",
      task_number: 3,
      title: "Carve task",
      target_repo: "/repo",
      worker_phase: "done",
      runtime_status: "in_progress",
    }),
  });
  drainAll();
  // Sanity: the snapshot landed.
  const before = getTask("fn-5-carve.3");
  expect(before?.worker_phase).toBe("done");
  expect(before?.runtime_status).toBe("in_progress");

  // 2. Drive a `work::` SessionStart whose `spawn_name` keys this task —
  // the jobs row inserts with `plan_ref` set, `syncIfPlanRef` fires, and
  // `syncJobIntoEpic` runs the OLD-element spread.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-carve-worker",
    spawn_name: "work::fn-5-carve.3",
  });
  drainAll();

  // 3. The carve-out invariant: BOTH new scalars must survive the fan-out
  // verbatim. A regression here (e.g. an inline rebuild that omits the
  // spread) would stomp them to NULL / "todo".
  const after = getTask("fn-5-carve.3");
  expect(after?.worker_phase).toBe("done");
  expect(after?.runtime_status).toBe("in_progress");
  // And the jobs sub-array picked up the new session.
  expect(getTaskJobs("fn-5-carve.3").length).toBe(1);
  expect(getTaskJobs("fn-5-carve.3")[0]?.job_id).toBe("sess-carve-worker");
});

test("TaskSnapshot reducer defensively folds a legacy `status` blob (no `worker_phase`/`runtime_status`) so pre-v19 events re-fold deterministically", () => {
  // Re-fold determinism across the v18→v19 boundary: the immutable event
  // log carries pre-v19 TaskSnapshot blobs that have `status: "open"` and
  // NO `worker_phase` / `runtime_status` keys. The reducer reads
  // `worker_phase ?? status` (= "open") and defaults `runtime_status` to
  // "todo" per planctl's `merge_task_state` convention. Without those
  // defensive reads, a from-scratch re-fold of an existing DB would either
  // throw or land NULL on the embedded element, breaking the byte-identical
  // re-fold invariant.
  insertEvent({
    hook_event: "TaskSnapshot",
    session_id: "fn-5-legacy.1",
    data: JSON.stringify({
      epic_id: "fn-5-legacy",
      task_number: 1,
      title: "Legacy",
      target_repo: "/repo",
      // Note: legacy `status` key only, no v19 keys.
      status: "open",
    }),
  });
  drainAll();
  const task = getTask("fn-5-legacy.1");
  expect(task?.worker_phase).toBe("open");
  expect(task?.runtime_status).toBe("todo");
});

test("dual-array fan-out: epic.jobs + task.jobs co-populated, survive EpicSnapshot ON CONFLICT", () => {
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-1-dual",
    data: JSON.stringify({ epic_number: 1, title: "Dual", status: "open" }),
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-dual-plan",
    spawn_name: "plan::fn-1-dual",
    ts: 100,
  });
  insertEvent({
    hook_event: "TaskSnapshot",
    session_id: "fn-1-dual.1",
    data: JSON.stringify({
      epic_id: "fn-1-dual",
      task_number: 1,
      title: "Dual T1",
      status: "open",
    }),
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-dual-work",
    spawn_name: "work::fn-1-dual.1",
    ts: 200,
  });
  drainAll();

  const epicJobsBefore = getEpicJobs("fn-1-dual");
  const taskJobsBefore = getTaskJobs("fn-1-dual.1");
  expect(epicJobsBefore.length).toBe(1);
  expect(epicJobsBefore[0]?.job_id).toBe("sess-dual-plan");
  expect(taskJobsBefore.length).toBe(1);
  expect(taskJobsBefore[0]?.job_id).toBe("sess-dual-work");

  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-1-dual",
    data: JSON.stringify({
      epic_number: 1,
      title: "Dual Updated",
      status: "open",
    }),
  });
  drainAll();

  const epic = getEpic("fn-1-dual");
  expect(epic?.title).toBe("Dual Updated");
  const epicJobsAfter = getEpicJobs("fn-1-dual");
  const taskJobsAfter = getTaskJobs("fn-1-dual.1");
  expect(epicJobsAfter).toEqual(epicJobsBefore);
  expect(taskJobsAfter).toEqual(taskJobsBefore);
});

test("malformed stored epic.jobs blob folds to [] in-txn (never wedges)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-seed",
    spawn_name: "plan::fn-99-mal",
  });
  drainAll();
  db.run("UPDATE epics SET jobs = '{not json' WHERE epic_id = 'fn-99-mal'");
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-seed-2",
    spawn_name: "plan::fn-99-mal",
  });
  drainAll();
  const jobs = getEpicJobs("fn-99-mal");
  expect(jobs.length).toBe(1);
  expect(jobs[0]?.job_id).toBe("sess-seed-2");
});

test("from-scratch re-fold reproduces byte-identical embedded jobs arrays", () => {
  // Mixed arrival orderings: epic-first, task-first, job-first.
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-A",
    data: JSON.stringify({ epic_number: 1, title: "A", status: "open" }),
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-A",
    spawn_name: "plan::fn-A",
    ts: 100,
  });
  insertEvent({
    hook_event: "TaskSnapshot",
    session_id: "fn-B.1",
    data: JSON.stringify({
      epic_id: "fn-B",
      task_number: 1,
      title: "B1",
      status: "open",
    }),
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-B",
    spawn_name: "work::fn-B.1",
    ts: 200,
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-C",
    spawn_name: "work::fn-C.5",
    ts: 300,
  });
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-C",
    data: JSON.stringify({ epic_number: 3, title: "C", status: "open" }),
  });
  insertEvent({
    hook_event: "TaskSnapshot",
    session_id: "fn-C.5",
    data: JSON.stringify({
      epic_id: "fn-C",
      task_number: 5,
      title: "C5",
      status: "open",
    }),
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-A" });
  insertEvent({ hook_event: "Stop", session_id: "sess-A" });
  insertEvent({ hook_event: "SessionEnd", session_id: "sess-B" });
  drainAll();

  const epicsBefore = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  const jobsBefore = db.query("SELECT * FROM jobs ORDER BY job_id").all();

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  drainAll();

  const epicsAfter = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  const jobsAfter = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  expect(epicsAfter).toEqual(epicsBefore);
  expect(jobsAfter).toEqual(jobsBefore);
});

test("a job with no plan_ref does not create an epic row (no fan-out)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-plain",
  });
  drainAll();
  expect(getJob("sess-plain")).not.toBeNull();
  const epicCount = db.query("SELECT count(*) AS c FROM epics").get() as {
    c: number;
  };
  expect(epicCount.c).toBe(0);
});

// ---------------------------------------------------------------------------
// syncPlanctlLinks fan-out (schema v14: jobs.epic_links + epics.job_links)
// ---------------------------------------------------------------------------

/**
 * Insert a `PreToolUse:Skill` window-opener event for `/plan:plan`. The
 * classifier's locked gate (`PreToolUse + skill_name='plan:plan'`) is what
 * the reducer's `syncPlanctlLinks` reads to compute window starts; slash-
 * command `UserPromptSubmit` rows are NOT openers (they'd double-fire).
 */
function planPlanOpener(sessionId: string, ts?: number): number {
  return insertEvent({
    hook_event: "PreToolUse",
    session_id: sessionId,
    tool_name: "Skill",
    skill_name: "plan:plan",
    ts,
  });
}

/**
 * Insert a stamped planctl invocation event. Mirrors what the hook +
 * `extractPlanctlInvocation` deriver would write — the test bypasses the
 * Bash-command parser and stamps the derived columns directly so the
 * fan-out test stays independent of the parser's edge cases.
 */
function planctlEvent(args: {
  sessionId: string;
  op: string;
  target: string | null;
  epicId: string | null;
  taskId?: string | null;
  subjectPresent: boolean;
  // Schema v30: optional queue-jump flag. Defaults `false` so existing tests
  // (every one written before v30) keep their old shape; new tests opt in by
  // passing `queueJump: true` to drive the `/plan:queue` projection path.
  queueJump?: boolean;
  ts?: number;
}): number {
  return insertEvent({
    hook_event: "PostToolUse",
    session_id: args.sessionId,
    tool_name: "Bash",
    ts: args.ts,
    planctl_op: args.op,
    planctl_target: args.target,
    planctl_epic_id: args.epicId,
    planctl_task_id: args.taskId ?? null,
    planctl_subject_present: args.subjectPresent ? 1 : 0,
    planctl_queue_jump: args.queueJump ? 1 : 0,
  });
}

/** Read the persisted `jobs.epic_links` as a real array. */
function getEpicLinks(sessionId: string): { kind: string; target: string }[] {
  const row = db
    .query("SELECT epic_links FROM jobs WHERE job_id = ?")
    .get(sessionId) as { epic_links: string | null } | null;
  if (row == null || row.epic_links == null) {
    return [];
  }
  return JSON.parse(row.epic_links);
}

/**
 * Read the persisted `epics.job_links` as a real array of the schema-v25
 * widened JobLinkEntry shape
 * `{kind, job_id, title, state, last_api_error_at, last_api_error_kind,
 * last_input_request_at, last_input_request_kind}`. The reducer's
 * `enrichJobLink` helper denormalizes the last six fields off the linked
 * `jobs` row at write time.
 */
function getJobLinks(epicId: string): {
  kind: string;
  job_id: string;
  title: string | null;
  state: string;
  last_api_error_at: number | null;
  last_api_error_kind: string | null;
  last_input_request_at: number | null;
  last_input_request_kind: string | null;
}[] {
  const row = db
    .query("SELECT job_links FROM epics WHERE epic_id = ?")
    .get(epicId) as { job_links: string | null } | null;
  if (row == null || row.job_links == null) {
    return [];
  }
  return JSON.parse(row.job_links);
}

test("syncPlanctlLinks: single-session single-window one creator emits creator edge in both directions", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-creator" });
  planPlanOpener("sess-creator");
  planctlEvent({
    sessionId: "sess-creator",
    op: "epic-create",
    target: "fn-1-new",
    epicId: "fn-1-new",
    subjectPresent: true,
  });
  drainAll();
  expect(getEpicLinks("sess-creator")).toEqual([
    { kind: "creator", target: "fn-1-new" },
  ]);
  expect(getJobLinks("fn-1-new")).toEqual([
    {
      kind: "creator",
      job_id: "sess-creator",
      title: null,
      state: "stopped",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
    },
  ]);
});

test("syncPlanctlLinks: single-session two windows creator-then-refiner-same-epic emits both edges", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-cr" });
  // Window 1 — creator.
  planPlanOpener("sess-cr");
  planctlEvent({
    sessionId: "sess-cr",
    op: "epic-create",
    target: "fn-2-foo",
    epicId: "fn-2-foo",
    subjectPresent: true,
  });
  // Window 2 — refiner on the same epic.
  planPlanOpener("sess-cr");
  planctlEvent({
    sessionId: "sess-cr",
    op: "epic-set-title",
    target: "fn-2-foo",
    epicId: "fn-2-foo",
    subjectPresent: true,
  });
  drainAll();
  // Both edges emitted; sort is (kind, target) ASC.
  expect(getEpicLinks("sess-cr")).toEqual([
    { kind: "creator", target: "fn-2-foo" },
    { kind: "refiner", target: "fn-2-foo" },
  ]);
  expect(getJobLinks("fn-2-foo")).toEqual([
    {
      kind: "creator",
      job_id: "sess-cr",
      title: null,
      state: "stopped",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
    },
    {
      kind: "refiner",
      job_id: "sess-cr",
      title: null,
      state: "stopped",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
    },
  ]);
});

test("syncPlanctlLinks: read-only verb in a window emits no edges", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-readonly" });
  planPlanOpener("sess-readonly");
  // A `planctl cat` is a read-only verb; `subject_present: false` mirrors the
  // jobctl `subject is None` skip gate.
  planctlEvent({
    sessionId: "sess-readonly",
    op: "cat",
    target: "fn-3-bar",
    epicId: "fn-3-bar",
    subjectPresent: false,
  });
  drainAll();
  expect(getEpicLinks("sess-readonly")).toEqual([]);
  // No epic row created (the read-only invocation produced no edges, so
  // touchedEpics is empty and the per-epic re-derive loop never fired).
  const epicRow = db
    .query("SELECT epic_id FROM epics WHERE epic_id = ?")
    .get("fn-3-bar");
  expect(epicRow).toBeNull();
});

test("syncPlanctlLinks: two sessions touching the same epic both appear in job_links", () => {
  // Session A creates the epic.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a-fan" });
  planPlanOpener("sess-a-fan");
  planctlEvent({
    sessionId: "sess-a-fan",
    op: "epic-create",
    target: "fn-4-multi",
    epicId: "fn-4-multi",
    subjectPresent: true,
  });
  // Session B refines it.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-b-fan" });
  planPlanOpener("sess-b-fan");
  planctlEvent({
    sessionId: "sess-b-fan",
    op: "epic-set-title",
    target: "fn-4-multi",
    epicId: "fn-4-multi",
    subjectPresent: true,
  });
  drainAll();
  expect(getEpicLinks("sess-a-fan")).toEqual([
    { kind: "creator", target: "fn-4-multi" },
  ]);
  expect(getEpicLinks("sess-b-fan")).toEqual([
    { kind: "refiner", target: "fn-4-multi" },
  ]);
  expect(getJobLinks("fn-4-multi")).toEqual([
    {
      kind: "creator",
      job_id: "sess-a-fan",
      title: null,
      state: "stopped",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
    },
    {
      kind: "refiner",
      job_id: "sess-b-fan",
      title: null,
      state: "stopped",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
    },
  ]);
});

test("syncPlanctlLinks: cross-session sweep re-derives a touched epic's job_links across every session that ever touched it", () => {
  // Coverage for the cross-session expansion at `src/reducer.ts:1192` (the
  // `SELECT DISTINCT session_id ... WHERE planctl_op IS NOT NULL AND
  // (planctl_epic_id IN (...) OR planctl_target IN (...))` sweep). Without it
  // a re-classification in session A would re-derive the touched epic's
  // `job_links` against session A's invocations only — silently dropping
  // every other session's edge on that epic. This test fails if the sweep is
  // short-circuited to same-session only.
  //
  // The drop mechanism here is the classifier's per-window
  // creator-suppression rule (see `deriveEpicLinks`): a creator-of-X
  // encountered earlier in a window's ts-ASC order suppresses any later
  // refiner-of-X in the same window. We exercise it by backdating the
  // follow-up `epic-create` (ts 100) so on re-classification it lands BEFORE
  // the existing `epic-set-title` (ts 110) inside window 1. Synthetic
  // ordering — what matters here is the cross-session fan-out behaviour, not
  // the realism of the wall-clock interleave.
  //
  // Scenario:
  //   1. Session A opens a /plan:plan window (t=90) and refines epic X via
  //      `epic-set-title` at t=110. A's epic_links = [refiner:X];
  //      X's job_links = [refiner:A].
  //   2. Session B opens a /plan:plan window (t=200) and refines epic X via
  //      `epic-set-title` at t=210. The cross-session sweep from B's fold
  //      adds B → X's job_links = [refiner:A, refiner:B].
  //   3. Session A folds a backdated `epic-create` on X at t=100 — inside
  //      A's window 1 but BEFORE the refiner. The classifier emits creator-X
  //      first, which suppresses the now-later refiner-X. A's epic_links
  //      collapse to [creator:X] — the refiner edge is dropped.
  //   4. The fan-out's cross-session sweep MUST re-derive X's job_links over
  //      both A and B — yielding [creator:A, refiner:B]. A short-circuited
  //      (same-session-only) sweep would yield [creator:A] only, silently
  //      losing B's refiner edge.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-A-xs",
    ts: 80,
  });
  planPlanOpener("sess-A-xs", 90);
  planctlEvent({
    sessionId: "sess-A-xs",
    op: "epic-set-title",
    target: "fn-7-xs",
    epicId: "fn-7-xs",
    subjectPresent: true,
    ts: 110,
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-B-xs",
    ts: 190,
  });
  planPlanOpener("sess-B-xs", 200);
  planctlEvent({
    sessionId: "sess-B-xs",
    op: "epic-set-title",
    target: "fn-7-xs",
    epicId: "fn-7-xs",
    subjectPresent: true,
    ts: 210,
  });
  drainAll();
  // Pre-state: both sessions refine the epic.
  expect(getEpicLinks("sess-A-xs")).toEqual([
    { kind: "refiner", target: "fn-7-xs" },
  ]);
  expect(getEpicLinks("sess-B-xs")).toEqual([
    { kind: "refiner", target: "fn-7-xs" },
  ]);
  expect(getJobLinks("fn-7-xs")).toEqual([
    {
      kind: "refiner",
      job_id: "sess-A-xs",
      title: null,
      state: "stopped",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
    },
    {
      kind: "refiner",
      job_id: "sess-B-xs",
      title: null,
      state: "stopped",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
    },
  ]);

  // Follow-up in session A — backdated `epic-create` at t=100 lands BEFORE
  // the refiner at t=110, so re-classification emits creator-X first which
  // suppresses the refiner via per-window-creator-of-X rule.
  planctlEvent({
    sessionId: "sess-A-xs",
    op: "epic-create",
    target: "fn-7-xs",
    epicId: "fn-7-xs",
    subjectPresent: true,
    ts: 100,
  });
  drainAll();

  // Session A's epic_links updated by the same-session re-derive (refiner
  // dropped → creator emitted).
  expect(getEpicLinks("sess-A-xs")).toEqual([
    { kind: "creator", target: "fn-7-xs" },
  ]);
  // Session B's epic_links are not directly touched by the fan-out on A —
  // they must still reach the correct post-state (B was never
  // re-classified, so its refiner edge persists verbatim).
  expect(getEpicLinks("sess-B-xs")).toEqual([
    { kind: "refiner", target: "fn-7-xs" },
  ]);
  // The acceptance assertion: epic X's job_links no longer carries the
  // stale session-A refiner edge, AND session B's refiner edge survives the
  // cross-session re-derive. Sort is total-order (kind, job_id) ASC —
  // creator < refiner lexicographically, so creator:A comes first.
  expect(getJobLinks("fn-7-xs")).toEqual([
    {
      kind: "creator",
      job_id: "sess-A-xs",
      title: null,
      state: "stopped",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
    },
    {
      kind: "refiner",
      job_id: "sess-B-xs",
      title: null,
      state: "stopped",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
    },
  ]);
});

test("syncPlanctlLinks: EpicSnapshot ON CONFLICT preserves job_links (carve-out works)", () => {
  // Seed a creator edge via the fan-out → a shell epic with job_links.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-carveout" });
  planPlanOpener("sess-carveout");
  planctlEvent({
    sessionId: "sess-carveout",
    op: "epic-create",
    target: "fn-5-survive",
    epicId: "fn-5-survive",
    subjectPresent: true,
  });
  drainAll();
  expect(getJobLinks("fn-5-survive")).toEqual([
    {
      kind: "creator",
      job_id: "sess-carveout",
      title: null,
      state: "stopped",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
    },
  ]);
  // Now fold an EpicSnapshot for the same epic — the ON CONFLICT clause
  // MUST omit job_links (alongside jobs / tasks) so the carve-out preserves
  // the projection. Without the carve-out an approval RPC → file write →
  // file-watcher → snapshot fold would wipe creator/refiner provenance.
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-5-survive",
    data: JSON.stringify({
      epic_number: 5,
      title: "Survive Carve-out",
      project_dir: "/repo",
      status: "open",
    }),
  });
  drainAll();
  // Scalars filled, job_links preserved.
  const epic = getEpic("fn-5-survive");
  expect(epic?.title).toBe("Survive Carve-out");
  expect(getJobLinks("fn-5-survive")).toEqual([
    {
      kind: "creator",
      job_id: "sess-carveout",
      title: null,
      state: "stopped",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
    },
  ]);
});

// ---------------------------------------------------------------------------
// Schema v29: syncPlanctlLinks computes `created_by_closer_of` + `sort_path`
// + transitive cascade on the epics projection
// ---------------------------------------------------------------------------

/**
 * Read the two new schema-v29 columns. Returns `null` when the epic row is
 * missing.
 */
function getEpicSortFields(
  epicId: string,
): { created_by_closer_of: string | null; sort_path: string } | null {
  return db
    .query(
      "SELECT created_by_closer_of, sort_path FROM epics WHERE epic_id = ?",
    )
    .get(epicId) as {
    created_by_closer_of: string | null;
    sort_path: string;
  } | null;
}

test("syncPlanctlLinks v29: plain epic with no closer ancestry → created_by_closer_of=NULL, sort_path=zeroPad6(epic_number)", () => {
  // Seed: a plain creator session (not a closer) creates fn-1-plain. The
  // creator's plan_verb is null (no spawn_name parsing), so
  // `created_by_closer_of` resolves to NULL and sort_path falls to the
  // zero-padded epic_number.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-plain-v29" });
  planPlanOpener("sess-plain-v29");
  planctlEvent({
    sessionId: "sess-plain-v29",
    op: "epic-create",
    target: "fn-1-plain",
    epicId: "fn-1-plain",
    subjectPresent: true,
  });
  // Land an EpicSnapshot so `epic_number` is populated; without it the
  // own-row read folds to 0 ("000000").
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-1-plain",
    data: JSON.stringify({
      epic_number: 1,
      title: "Plain",
      project_dir: "/repo",
      status: "open",
    }),
  });
  // Trigger one more planctl event so syncPlanctlLinks re-runs with the
  // epic_number now visible.
  planctlEvent({
    sessionId: "sess-plain-v29",
    op: "epic-set-title",
    target: "fn-1-plain",
    epicId: "fn-1-plain",
    subjectPresent: true,
  });
  drainAll();
  expect(getEpicSortFields("fn-1-plain")).toEqual({
    created_by_closer_of: null,
    sort_path: "000001",
  });
});

test("syncPlanctlLinks v29: closer-created epic single level → created_by_closer_of=parent, sort_path=parent.zeroPad6(epic_number)", () => {
  // Closer session for fn-3-foo (plan_verb='close', plan_ref='fn-3-foo')
  // creates fn-7-bar via /plan:plan + epic-create. The derivation
  // resolves `created_by_closer_of` to the closer's plan_ref ('fn-3-foo')
  // and composes sort_path as `<parent.sort_path>.000007`.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-closer-fn3",
    spawn_name: "close::fn-3-foo",
  });
  // Seed parent fn-3-foo so its sort_path resolves first. Use a non-closer
  // session to create the parent so its own `created_by_closer_of` is NULL.
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-3-foo",
    data: JSON.stringify({
      epic_number: 3,
      title: "Parent",
      project_dir: "/repo",
      status: "open",
    }),
  });
  // The closer session now opens a plan window and creates fn-7-bar.
  planPlanOpener("sess-closer-fn3");
  planctlEvent({
    sessionId: "sess-closer-fn3",
    op: "epic-create",
    target: "fn-7-bar",
    epicId: "fn-7-bar",
    subjectPresent: true,
  });
  // EpicSnapshot for fn-7-bar so its epic_number is visible to the
  // syncPlanctlLinks derivation.
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-7-bar",
    data: JSON.stringify({
      epic_number: 7,
      title: "Child",
      project_dir: "/repo",
      status: "open",
    }),
  });
  // One more planctl event in the closer session to re-trigger
  // syncPlanctlLinks with the epic_number now known.
  planctlEvent({
    sessionId: "sess-closer-fn3",
    op: "epic-set-title",
    target: "fn-7-bar",
    epicId: "fn-7-bar",
    subjectPresent: true,
  });
  drainAll();
  expect(getEpicSortFields("fn-7-bar")).toEqual({
    created_by_closer_of: "fn-3-foo",
    sort_path: "000003.000007",
  });
});

test("syncPlanctlLinks v29: chain depth 2 → fn-3 → fn-7 → fn-11 composes 000003.000007.000011", () => {
  // Parent fn-3-foo: a plain planning session creates it. A planctl event
  // targeting an epic is what wakes the derivation — an EpicSnapshot alone
  // does not.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-plan-fn3" });
  planPlanOpener("sess-plan-fn3");
  planctlEvent({
    sessionId: "sess-plan-fn3",
    op: "epic-create",
    target: "fn-3-foo",
    epicId: "fn-3-foo",
    subjectPresent: true,
  });
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-3-foo",
    data: JSON.stringify({
      epic_number: 3,
      title: "P",
      project_dir: "/repo",
      status: "open",
    }),
  });
  planctlEvent({
    sessionId: "sess-plan-fn3",
    op: "epic-set-title",
    target: "fn-3-foo",
    epicId: "fn-3-foo",
    subjectPresent: true,
  });
  // Child fn-7-bar: closer-created from fn-3-foo.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-c3",
    spawn_name: "close::fn-3-foo",
  });
  planPlanOpener("sess-c3");
  planctlEvent({
    sessionId: "sess-c3",
    op: "epic-create",
    target: "fn-7-bar",
    epicId: "fn-7-bar",
    subjectPresent: true,
  });
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-7-bar",
    data: JSON.stringify({
      epic_number: 7,
      title: "C",
      project_dir: "/repo",
      status: "open",
    }),
  });
  planctlEvent({
    sessionId: "sess-c3",
    op: "epic-set-title",
    target: "fn-7-bar",
    epicId: "fn-7-bar",
    subjectPresent: true,
  });
  // Grandchild fn-11-baz: closer-created from fn-7-bar.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-c7",
    spawn_name: "close::fn-7-bar",
  });
  planPlanOpener("sess-c7");
  planctlEvent({
    sessionId: "sess-c7",
    op: "epic-create",
    target: "fn-11-baz",
    epicId: "fn-11-baz",
    subjectPresent: true,
  });
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-11-baz",
    data: JSON.stringify({
      epic_number: 11,
      title: "GC",
      project_dir: "/repo",
      status: "open",
    }),
  });
  planctlEvent({
    sessionId: "sess-c7",
    op: "epic-set-title",
    target: "fn-11-baz",
    epicId: "fn-11-baz",
    subjectPresent: true,
  });
  drainAll();
  expect(getEpicSortFields("fn-3-foo")?.sort_path).toBe("000003");
  expect(getEpicSortFields("fn-7-bar")).toEqual({
    created_by_closer_of: "fn-3-foo",
    sort_path: "000003.000007",
  });
  expect(getEpicSortFields("fn-11-baz")).toEqual({
    created_by_closer_of: "fn-7-bar",
    sort_path: "000003.000007.000011",
  });
});

test("syncPlanctlLinks v29: chain depth 3 has no truncation", () => {
  // fn-2 → fn-4 → fn-8 → fn-16, each level via a closer session.
  const levels: [string, number, string | null][] = [
    ["fn-2-l0", 2, null],
    ["fn-4-l1", 4, "fn-2-l0"],
    ["fn-8-l2", 8, "fn-4-l1"],
    ["fn-16-l3", 16, "fn-8-l2"],
  ];
  for (const [id, num, parent] of levels) {
    if (parent != null) {
      const sess = `sess-${id}`;
      insertEvent({
        hook_event: "SessionStart",
        session_id: sess,
        spawn_name: `close::${parent}`,
      });
      planPlanOpener(sess);
      planctlEvent({
        sessionId: sess,
        op: "epic-create",
        target: id,
        epicId: id,
        subjectPresent: true,
      });
    }
    insertEvent({
      hook_event: "EpicSnapshot",
      session_id: id,
      data: JSON.stringify({
        epic_number: num,
        title: id,
        project_dir: "/repo",
        status: "open",
      }),
    });
    if (parent != null) {
      planctlEvent({
        sessionId: `sess-${id}`,
        op: "epic-set-title",
        target: id,
        epicId: id,
        subjectPresent: true,
      });
    }
  }
  drainAll();
  expect(getEpicSortFields("fn-16-l3")).toEqual({
    created_by_closer_of: "fn-8-l2",
    sort_path: "000002.000004.000008.000016",
  });
});

test("syncPlanctlLinks v29: parent-missing event ordering → child gets placeholder, parent EpicSnapshot triggers cascade re-stamp", () => {
  // Child folds first: its parent fn-3-foo has no EpicSnapshot yet. The
  // derivation falls back to `zeroPad6(child.epic_number)` (placeholder).
  // Then the parent's EpicSnapshot lands AND a follow-up planctl event in
  // the parent's session triggers the cascade re-stamp to the canonical
  // value.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-closer-missing",
    spawn_name: "close::fn-3-missing",
  });
  planPlanOpener("sess-closer-missing");
  planctlEvent({
    sessionId: "sess-closer-missing",
    op: "epic-create",
    target: "fn-7-orphan",
    epicId: "fn-7-orphan",
    subjectPresent: true,
  });
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-7-orphan",
    data: JSON.stringify({
      epic_number: 7,
      title: "Orphan",
      project_dir: "/repo",
      status: "open",
    }),
  });
  // One more planctl event to re-trigger syncPlanctlLinks now that
  // epic_number is visible.
  planctlEvent({
    sessionId: "sess-closer-missing",
    op: "epic-set-title",
    target: "fn-7-orphan",
    epicId: "fn-7-orphan",
    subjectPresent: true,
  });
  drainAll();
  // Intermediate state: created_by_closer_of resolved (we have the closer-
  // creator job's plan_ref), but parent's sort_path is '' (no parent row),
  // so child falls back to zeroPad6(epic_number).
  expect(getEpicSortFields("fn-7-orphan")).toEqual({
    created_by_closer_of: "fn-3-missing",
    sort_path: "000007",
  });

  // Parent EpicSnapshot lands.
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-3-missing",
    data: JSON.stringify({
      epic_number: 3,
      title: "Parent",
      project_dir: "/repo",
      status: "open",
    }),
  });
  drainAll();
  // The parent itself is plain (no closer creator); just inserting the
  // EpicSnapshot doesn't trigger a syncPlanctlLinks pass on the parent
  // (only a planctl event does). Fire a planctl event in some session
  // touching the parent to wake the fan-out — a refiner edit suffices.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-edit-parent" });
  planPlanOpener("sess-edit-parent");
  planctlEvent({
    sessionId: "sess-edit-parent",
    op: "epic-set-title",
    target: "fn-3-missing",
    epicId: "fn-3-missing",
    subjectPresent: true,
  });
  drainAll();

  // Final state: parent's sort_path = '000003'; cascade re-stamped child.
  expect(getEpicSortFields("fn-3-missing")?.sort_path).toBe("000003");
  expect(getEpicSortFields("fn-7-orphan")).toEqual({
    created_by_closer_of: "fn-3-missing",
    sort_path: "000003.000007",
  });
});

test("syncPlanctlLinks v29: creator tie-break picks lowest job_id ASC among multiple closers", () => {
  // Two closer sessions BOTH create the same child epic. (Pathological
  // but possible: two arthack-spawned closers running in parallel against
  // the same `close::fn-2-tie` window before one wins.) The tie-break
  // resolves to the lowest job_id ASC — here `sess-A-tie` < `sess-B-tie`.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-A-tie",
    spawn_name: "close::fn-2-tie",
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-B-tie",
    spawn_name: "close::fn-9-other",
  });
  // Parent for sess-A-tie's closer.
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-2-tie",
    data: JSON.stringify({
      epic_number: 2,
      title: "P-A",
      project_dir: "/repo",
      status: "open",
    }),
  });
  // Parent for sess-B-tie's closer.
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-9-other",
    data: JSON.stringify({
      epic_number: 9,
      title: "P-B",
      project_dir: "/repo",
      status: "open",
    }),
  });
  // Both sessions create the same child.
  planPlanOpener("sess-A-tie");
  planctlEvent({
    sessionId: "sess-A-tie",
    op: "epic-create",
    target: "fn-5-tied-child",
    epicId: "fn-5-tied-child",
    subjectPresent: true,
  });
  planPlanOpener("sess-B-tie");
  planctlEvent({
    sessionId: "sess-B-tie",
    op: "epic-create",
    target: "fn-5-tied-child",
    epicId: "fn-5-tied-child",
    subjectPresent: true,
  });
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-5-tied-child",
    data: JSON.stringify({
      epic_number: 5,
      title: "Child",
      project_dir: "/repo",
      status: "open",
    }),
  });
  // Wake a fresh syncPlanctlLinks pass with the child's epic_number known.
  planctlEvent({
    sessionId: "sess-A-tie",
    op: "epic-set-title",
    target: "fn-5-tied-child",
    epicId: "fn-5-tied-child",
    subjectPresent: true,
  });
  drainAll();
  // Tie-break: sess-A-tie has the lower job_id ASC, so its plan_ref wins.
  expect(getEpicSortFields("fn-5-tied-child")?.created_by_closer_of).toBe(
    "fn-2-tie",
  );
});

test("syncPlanctlLinks v29: EpicSnapshot ON CONFLICT preserves created_by_closer_of + sort_path (carve-out v29)", () => {
  // Closer creates child, sort_path resolves. Then an EpicSnapshot for the
  // child re-folds (e.g. an approval RPC round-trip). Both new columns
  // MUST survive the ON CONFLICT — without the carve-out the
  // approval-flip pipeline would wipe them on every approval change.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-carve29",
    spawn_name: "close::fn-3-c29",
  });
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-3-c29",
    data: JSON.stringify({
      epic_number: 3,
      title: "P",
      project_dir: "/repo",
      status: "open",
    }),
  });
  planPlanOpener("sess-carve29");
  planctlEvent({
    sessionId: "sess-carve29",
    op: "epic-create",
    target: "fn-7-c29",
    epicId: "fn-7-c29",
    subjectPresent: true,
  });
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-7-c29",
    data: JSON.stringify({
      epic_number: 7,
      title: "C",
      project_dir: "/repo",
      status: "open",
    }),
  });
  planctlEvent({
    sessionId: "sess-carve29",
    op: "epic-set-title",
    target: "fn-7-c29",
    epicId: "fn-7-c29",
    subjectPresent: true,
  });
  drainAll();
  expect(getEpicSortFields("fn-7-c29")).toEqual({
    created_by_closer_of: "fn-3-c29",
    sort_path: "000003.000007",
  });

  // Re-fold an EpicSnapshot (mirrors an approval RPC round-trip).
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-7-c29",
    data: JSON.stringify({
      epic_number: 7,
      title: "C (renamed)",
      project_dir: "/repo",
      status: "open",
      approval: "approved",
    }),
  });
  drainAll();

  // The scalar flipped to "approved" / new title; the v29 columns survive.
  const epic = getEpic("fn-7-c29");
  expect(epic?.title).toBe("C (renamed)");
  expect(epic?.approval).toBe("approved");
  expect(getEpicSortFields("fn-7-c29")).toEqual({
    created_by_closer_of: "fn-3-c29",
    sort_path: "000003.000007",
  });
});

test("syncPlanctlLinks v29: epic_number >= 1_000_000 safe-folds to sort_path='' (no throw, cursor advances)", () => {
  // Synthetic event with an absurd epic_number — the documented ceiling
  // is 999,999. Reducer must never throw inside BEGIN IMMEDIATE; the
  // safe-fold writes sort_path=''.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-overflow" });
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-x-overflow",
    data: JSON.stringify({
      epic_number: 1_000_000,
      title: "Overflow",
      project_dir: "/repo",
      status: "open",
    }),
  });
  planPlanOpener("sess-overflow");
  planctlEvent({
    sessionId: "sess-overflow",
    op: "epic-set-title",
    target: "fn-x-overflow",
    epicId: "fn-x-overflow",
    subjectPresent: true,
  });
  // The drain MUST NOT throw.
  expect(() => drainAll()).not.toThrow();
  expect(getEpicSortFields("fn-x-overflow")).toEqual({
    created_by_closer_of: null,
    sort_path: "",
  });
});

test("syncPlanctlLinks v29: re-fold determinism preserves byte-identical (created_by_closer_of, sort_path) on every epic", () => {
  // Build a non-trivial state via a closer-driven chain, capture every
  // epic row, rewind + DELETE + drain, capture again, byte-compare.
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-3-r29",
    data: JSON.stringify({
      epic_number: 3,
      title: "P",
      project_dir: "/repo",
      status: "open",
    }),
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-r29",
    spawn_name: "close::fn-3-r29",
  });
  planPlanOpener("sess-r29");
  planctlEvent({
    sessionId: "sess-r29",
    op: "epic-create",
    target: "fn-7-r29",
    epicId: "fn-7-r29",
    subjectPresent: true,
  });
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-7-r29",
    data: JSON.stringify({
      epic_number: 7,
      title: "C",
      project_dir: "/repo",
      status: "open",
    }),
  });
  planctlEvent({
    sessionId: "sess-r29",
    op: "epic-set-title",
    target: "fn-7-r29",
    epicId: "fn-7-r29",
    subjectPresent: true,
  });
  drainAll();
  const epicsBefore = JSON.stringify(
    db.query("SELECT * FROM epics ORDER BY epic_id").all(),
  );

  // Rewind + clear + redrain.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  drainAll();
  const epicsAfter = JSON.stringify(
    db.query("SELECT * FROM epics ORDER BY epic_id").all(),
  );
  // Byte-identical including the two new schema-v29 columns.
  expect(epicsAfter).toBe(epicsBefore);
});

// ---------------------------------------------------------------------------
// Schema v30: queue_jump projection + `!`-prefix sort_path branch
// ---------------------------------------------------------------------------

/**
 * Read the schema-v30 columns for one epic. Returns NULL when the epic row
 * is missing. Mirrors `getEpicSortFields` (v29) — separate helper so the v30
 * tests stay self-contained.
 */
function getEpicQueueState(
  epicId: string,
): { queue_jump: number; sort_path: string } | null {
  return db
    .query("SELECT queue_jump, sort_path FROM epics WHERE epic_id = ?")
    .get(epicId) as { queue_jump: number; sort_path: string } | null;
}

test("syncPlanctlLinks v30: root epic with queue_jump=true → epics.queue_jump=1, sort_path='!<padded>'", () => {
  // The canonical `/plan:queue` flow: scaffold envelope carries
  // `queue_jump: true`; hook stamps `planctl_queue_jump = 1` on the event;
  // reducer projects `epics.queue_jump = 1` AND prepends `!` to the
  // sort_path (root → `created_by_closer_of IS NULL`).
  insertEvent({ hook_event: "SessionStart", session_id: "sess-queued-root" });
  planPlanOpener("sess-queued-root");
  planctlEvent({
    sessionId: "sess-queued-root",
    op: "scaffold",
    target: "fn-700-queued",
    epicId: "fn-700-queued",
    subjectPresent: true,
    queueJump: true,
  });
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-700-queued",
    data: JSON.stringify({
      epic_number: 700,
      title: "Queued",
      project_dir: "/repo",
      status: "open",
    }),
  });
  // Re-trigger syncPlanctlLinks with the epic_number now visible.
  planctlEvent({
    sessionId: "sess-queued-root",
    op: "epic-set-title",
    target: "fn-700-queued",
    epicId: "fn-700-queued",
    subjectPresent: true,
  });
  drainAll();
  expect(getEpicQueueState("fn-700-queued")).toEqual({
    queue_jump: 1,
    sort_path: "!000700",
  });
});

test("syncPlanctlLinks v30: root epic with queue_jump=false → queue_jump=0, plain padded sort_path", () => {
  // The `/plan:defer` and every other non-queue scaffold path: envelope
  // either omits queue_jump or sets it to `false`. Reducer projects
  // queue_jump=0 and stamps a plain (no `!` prefix) sort_path.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-defer-root" });
  planPlanOpener("sess-defer-root");
  planctlEvent({
    sessionId: "sess-defer-root",
    op: "scaffold",
    target: "fn-701-deferred",
    epicId: "fn-701-deferred",
    subjectPresent: true,
    // queueJump intentionally absent → defaults to false in the helper.
  });
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-701-deferred",
    data: JSON.stringify({
      epic_number: 701,
      title: "Deferred",
      project_dir: "/repo",
      status: "open",
    }),
  });
  planctlEvent({
    sessionId: "sess-defer-root",
    op: "epic-set-title",
    target: "fn-701-deferred",
    epicId: "fn-701-deferred",
    subjectPresent: true,
  });
  drainAll();
  expect(getEpicQueueState("fn-701-deferred")).toEqual({
    queue_jump: 0,
    sort_path: "000701",
  });
});

test("syncPlanctlLinks v30: cascade propagates `!`-prefix to closer-of children via parentPath string concat", () => {
  // A queue-jumped parent's `!`-prefix MUST propagate to every transitive
  // closer-of descendant. The cascade has no separate queue-jump awareness
  // — the prefix is already baked into the parent's sort_path string and
  // gets read into `parentPath` then concat'd as `<parentPath>.<child>`.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-queued-parent",
  });
  planPlanOpener("sess-queued-parent");
  planctlEvent({
    sessionId: "sess-queued-parent",
    op: "scaffold",
    target: "fn-720-queued-parent",
    epicId: "fn-720-queued-parent",
    subjectPresent: true,
    queueJump: true,
  });
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-720-queued-parent",
    data: JSON.stringify({
      epic_number: 720,
      title: "Queued Parent",
      project_dir: "/repo",
      status: "open",
    }),
  });
  planctlEvent({
    sessionId: "sess-queued-parent",
    op: "epic-set-title",
    target: "fn-720-queued-parent",
    epicId: "fn-720-queued-parent",
    subjectPresent: true,
  });
  // Closer-of child of the queue-jumped parent.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-child-of-queued",
    spawn_name: "close::fn-720-queued-parent",
  });
  planPlanOpener("sess-child-of-queued");
  planctlEvent({
    sessionId: "sess-child-of-queued",
    op: "epic-create",
    target: "fn-721-child",
    epicId: "fn-721-child",
    subjectPresent: true,
  });
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-721-child",
    data: JSON.stringify({
      epic_number: 721,
      title: "Child",
      project_dir: "/repo",
      status: "open",
    }),
  });
  planctlEvent({
    sessionId: "sess-child-of-queued",
    op: "epic-set-title",
    target: "fn-721-child",
    epicId: "fn-721-child",
    subjectPresent: true,
  });
  drainAll();
  // Parent: queue_jump=1 + `!`-prefix.
  expect(getEpicQueueState("fn-720-queued-parent")).toEqual({
    queue_jump: 1,
    sort_path: "!000720",
  });
  // Child: queue_jump=0 (its own session never flipped the flag) BUT
  // inherits the `!`-prefix via `<parentPath>.<zeroPad6(child)>`.
  expect(getEpicQueueState("fn-721-child")).toEqual({
    queue_jump: 0,
    sort_path: "!000720.000721",
  });
});

test("syncPlanctlLinks v30: non-root queue-jumped epic inherits parent's path verbatim (no double-prefix)", () => {
  // A queue-jumped epic with `created_by_closer_of` set (non-root) still
  // projects queue_jump=1 for symmetry, but its sort_path follows the
  // standard `<parent.sort_path>.<padded>` derivation — NO extra `!`
  // prefix. The parent (non-queued in this test) supplies a plain path,
  // so the child's path is `<plain>.<padded>`.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-plain-parent-v30",
  });
  planPlanOpener("sess-plain-parent-v30");
  planctlEvent({
    sessionId: "sess-plain-parent-v30",
    op: "epic-create",
    target: "fn-730-plain-parent",
    epicId: "fn-730-plain-parent",
    subjectPresent: true,
  });
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-730-plain-parent",
    data: JSON.stringify({
      epic_number: 730,
      title: "Plain Parent",
      project_dir: "/repo",
      status: "open",
    }),
  });
  planctlEvent({
    sessionId: "sess-plain-parent-v30",
    op: "epic-set-title",
    target: "fn-730-plain-parent",
    epicId: "fn-730-plain-parent",
    subjectPresent: true,
  });
  // Closer of the plain parent runs `/plan:queue` to mint a new child.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-queued-nonroot-child",
    spawn_name: "close::fn-730-plain-parent",
  });
  planPlanOpener("sess-queued-nonroot-child");
  planctlEvent({
    sessionId: "sess-queued-nonroot-child",
    op: "scaffold",
    target: "fn-731-queued-nonroot",
    epicId: "fn-731-queued-nonroot",
    subjectPresent: true,
    queueJump: true,
  });
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-731-queued-nonroot",
    data: JSON.stringify({
      epic_number: 731,
      title: "Queued Non-Root",
      project_dir: "/repo",
      status: "open",
    }),
  });
  planctlEvent({
    sessionId: "sess-queued-nonroot-child",
    op: "epic-set-title",
    target: "fn-731-queued-nonroot",
    epicId: "fn-731-queued-nonroot",
    subjectPresent: true,
  });
  drainAll();
  // Plain root parent.
  expect(getEpicQueueState("fn-730-plain-parent")).toEqual({
    queue_jump: 0,
    sort_path: "000730",
  });
  // Non-root queue-jumped child: queue_jump=1 BUT sort_path inherits
  // parent's plain path. NO `!` prefix (the child is non-root).
  expect(getEpicQueueState("fn-731-queued-nonroot")).toEqual({
    queue_jump: 1,
    sort_path: "000730.000731",
  });
});

test("syncPlanctlLinks v30: EpicSnapshot re-fold preserves queue_jump (ON CONFLICT carve-out)", () => {
  // The mandatory snapshot carve-out: a re-folded EpicSnapshot (e.g. an
  // approval RPC round-trip) MUST NOT wipe `queue_jump` back to 0. Set up
  // a queued root, then re-fold its snapshot with a different status /
  // approval and confirm queue_jump survives.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-carve30",
  });
  planPlanOpener("sess-carve30");
  planctlEvent({
    sessionId: "sess-carve30",
    op: "scaffold",
    target: "fn-740-carve30",
    epicId: "fn-740-carve30",
    subjectPresent: true,
    queueJump: true,
  });
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-740-carve30",
    data: JSON.stringify({
      epic_number: 740,
      title: "Carve30",
      project_dir: "/repo",
      status: "open",
    }),
  });
  planctlEvent({
    sessionId: "sess-carve30",
    op: "epic-set-title",
    target: "fn-740-carve30",
    epicId: "fn-740-carve30",
    subjectPresent: true,
  });
  drainAll();
  expect(getEpicQueueState("fn-740-carve30")).toEqual({
    queue_jump: 1,
    sort_path: "!000740",
  });

  // Re-fold an EpicSnapshot (mirrors an approval RPC round-trip — a fresh
  // atomic file write fires a snapshot event into the reducer).
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-740-carve30",
    data: JSON.stringify({
      epic_number: 740,
      title: "Carve30 (approved)",
      project_dir: "/repo",
      status: "open",
      approval: "approved",
    }),
  });
  drainAll();

  // Scalars flipped; queue_jump + sort_path survive the carve-out.
  const epic = getEpic("fn-740-carve30");
  expect(epic?.title).toBe("Carve30 (approved)");
  expect(epic?.approval).toBe("approved");
  expect(getEpicQueueState("fn-740-carve30")).toEqual({
    queue_jump: 1,
    sort_path: "!000740",
  });
});

test("syncPlanctlLinks v30: re-fold determinism preserves byte-identical queue_jump + sort_path", () => {
  // Drive a queue-jumped state, capture every epic row, rewind + DELETE
  // + drain, capture again, byte-compare. Mirrors the v29 re-fold test.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-queued-r30",
  });
  planPlanOpener("sess-queued-r30");
  planctlEvent({
    sessionId: "sess-queued-r30",
    op: "scaffold",
    target: "fn-750-r30",
    epicId: "fn-750-r30",
    subjectPresent: true,
    queueJump: true,
  });
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-750-r30",
    data: JSON.stringify({
      epic_number: 750,
      title: "R30",
      project_dir: "/repo",
      status: "open",
    }),
  });
  planctlEvent({
    sessionId: "sess-queued-r30",
    op: "epic-set-title",
    target: "fn-750-r30",
    epicId: "fn-750-r30",
    subjectPresent: true,
  });
  // A closer-of child to exercise cascade re-fold too.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-r30-child",
    spawn_name: "close::fn-750-r30",
  });
  planPlanOpener("sess-r30-child");
  planctlEvent({
    sessionId: "sess-r30-child",
    op: "epic-create",
    target: "fn-751-r30-child",
    epicId: "fn-751-r30-child",
    subjectPresent: true,
  });
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-751-r30-child",
    data: JSON.stringify({
      epic_number: 751,
      title: "R30 Child",
      project_dir: "/repo",
      status: "open",
    }),
  });
  planctlEvent({
    sessionId: "sess-r30-child",
    op: "epic-set-title",
    target: "fn-751-r30-child",
    epicId: "fn-751-r30-child",
    subjectPresent: true,
  });
  drainAll();
  const epicsBefore = JSON.stringify(
    db.query("SELECT * FROM epics ORDER BY epic_id").all(),
  );

  // Rewind + clear + redrain.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  drainAll();
  const epicsAfter = JSON.stringify(
    db.query("SELECT * FROM epics ORDER BY epic_id").all(),
  );
  // Byte-identical including queue_jump + the inherited `!`-prefix.
  expect(epicsAfter).toBe(epicsBefore);
});

test("syncPlanctlLinks v30: multiple queue-jumped roots sort FIFO by epic_number under shared `!` prefix", () => {
  // FIFO semantics (chosen design — see epic spec §"Alternatives"): three
  // queue-jumped roots stamped at different epic_numbers should sort in
  // ascending epic_number order. The shared `!` prefix lifts them above
  // every non-queued root; the zero-padded epic_number tail orders them
  // among themselves. No tiebreaker math needed.
  for (const num of [770, 771, 772]) {
    const sess = `sess-fifo-${num}`;
    insertEvent({ hook_event: "SessionStart", session_id: sess });
    planPlanOpener(sess);
    planctlEvent({
      sessionId: sess,
      op: "scaffold",
      target: `fn-${num}-fifo`,
      epicId: `fn-${num}-fifo`,
      subjectPresent: true,
      queueJump: true,
    });
    insertEvent({
      hook_event: "EpicSnapshot",
      session_id: `fn-${num}-fifo`,
      data: JSON.stringify({
        epic_number: num,
        title: `FIFO ${num}`,
        project_dir: "/repo",
        status: "open",
      }),
    });
    planctlEvent({
      sessionId: sess,
      op: "epic-set-title",
      target: `fn-${num}-fifo`,
      epicId: `fn-${num}-fifo`,
      subjectPresent: true,
    });
  }
  // Plus a plain (non-queued) root to confirm it sorts AFTER all
  // queued roots — `!` (0x21) < `0` (0x30) under BINARY collation.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-fifo-plain" });
  planPlanOpener("sess-fifo-plain");
  planctlEvent({
    sessionId: "sess-fifo-plain",
    op: "epic-create",
    target: "fn-769-plain-after",
    epicId: "fn-769-plain-after",
    subjectPresent: true,
  });
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-769-plain-after",
    data: JSON.stringify({
      epic_number: 769,
      title: "Plain Outsider",
      project_dir: "/repo",
      status: "open",
    }),
  });
  planctlEvent({
    sessionId: "sess-fifo-plain",
    op: "epic-set-title",
    target: "fn-769-plain-after",
    epicId: "fn-769-plain-after",
    subjectPresent: true,
  });
  drainAll();

  // Read sort_path for all four; expect FIFO order under shared `!`,
  // then the plain root after.
  const rows = db
    .query(
      "SELECT epic_id, sort_path FROM epics WHERE epic_id LIKE 'fn-7%-fifo' OR epic_id = 'fn-769-plain-after' ORDER BY sort_path ASC",
    )
    .all() as { epic_id: string; sort_path: string }[];
  expect(rows).toEqual([
    { epic_id: "fn-770-fifo", sort_path: "!000770" },
    { epic_id: "fn-771-fifo", sort_path: "!000771" },
    { epic_id: "fn-772-fifo", sort_path: "!000772" },
    { epic_id: "fn-769-plain-after", sort_path: "000769" },
  ]);
});

test("syncPlanctlLinks: re-fold determinism (rewind + DELETE + drain reproduces byte-identical projection)", () => {
  // Drive a full session: two windows, a creator, a refiner, plus a
  // cross-session refiner so both projections accumulate.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-A-det" });
  planPlanOpener("sess-A-det");
  planctlEvent({
    sessionId: "sess-A-det",
    op: "epic-create",
    target: "fn-6-det",
    epicId: "fn-6-det",
    subjectPresent: true,
  });
  planPlanOpener("sess-A-det");
  planctlEvent({
    sessionId: "sess-A-det",
    op: "task-create",
    target: "fn-6-det.1",
    epicId: "fn-6-det",
    taskId: "fn-6-det.1",
    subjectPresent: true,
  });
  insertEvent({ hook_event: "SessionStart", session_id: "sess-B-det" });
  planPlanOpener("sess-B-det");
  planctlEvent({
    sessionId: "sess-B-det",
    op: "epic-set-title",
    target: "fn-6-det",
    epicId: "fn-6-det",
    subjectPresent: true,
  });
  drainAll();

  const epicsBefore = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  const jobsBefore = db.query("SELECT * FROM jobs ORDER BY job_id").all();

  // Rewind + delete + re-drain.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  drainAll();

  const epicsAfter = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  const jobsAfter = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  expect(epicsAfter).toEqual(epicsBefore);
  expect(jobsAfter).toEqual(jobsBefore);
});

// ---------------------------------------------------------------------------
// syncJobLinksOnJobWrite — schema-v21 reverse fan-out from a jobs-write
// into every linked epic's `job_links` enrichment payload.
// ---------------------------------------------------------------------------

test("syncJobLinksOnJobWrite: state flip on UserPromptSubmit re-stamps embedded state on every linked epic", () => {
  // Seed: a planctl creator edge → epic gets a job_links entry whose
  // initial enriched state is "stopped" (the jobs row's default after
  // SessionStart). A subsequent UserPromptSubmit flips state to
  // "working" and the reverse fan-out must re-stamp the entry so the
  // board's planner-running predicate fires.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-flip" });
  planPlanOpener("sess-flip");
  planctlEvent({
    sessionId: "sess-flip",
    op: "epic-create",
    target: "fn-12-flip",
    epicId: "fn-12-flip",
    subjectPresent: true,
  });
  drainAll();
  expect(getJobLinks("fn-12-flip")).toEqual([
    {
      kind: "creator",
      job_id: "sess-flip",
      title: null,
      state: "stopped",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
    },
  ]);

  // UserPromptSubmit flips state to "working" — the jobs-side branch
  // writes the row, then `syncIfPlanRef` → `syncJobLinksOnJobWrite`
  // re-stamps every linked epic's matching entry with fresh enrichment.
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-flip" });
  drainAll();
  expect(getJobLinks("fn-12-flip")).toEqual([
    {
      kind: "creator",
      job_id: "sess-flip",
      title: null,
      state: "working",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
    },
  ]);

  // Stop → state flips back to "stopped"; the reverse fan-out propagates.
  insertEvent({ hook_event: "Stop", session_id: "sess-flip" });
  drainAll();
  expect(getJobLinks("fn-12-flip")[0]?.state).toBe("stopped");
});

test("syncJobLinksOnJobWrite: title update on TranscriptTitle re-stamps embedded title on every linked epic", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-title" });
  planPlanOpener("sess-title");
  planctlEvent({
    sessionId: "sess-title",
    op: "epic-create",
    target: "fn-13-title",
    epicId: "fn-13-title",
    subjectPresent: true,
  });
  drainAll();
  expect(getJobLinks("fn-13-title")[0]?.title).toBeNull();

  // TranscriptTitle event drives the priority-3 title rule, which writes
  // jobs.{title, title_source}; the post-write `syncIfPlanRef` →
  // `syncJobLinksOnJobWrite` reverse-fans the new title into every
  // linked epic's job_links entry.
  insertEvent({
    hook_event: "TranscriptTitle",
    session_id: "sess-title",
    data: JSON.stringify({ session_title: "Live session title" }),
  });
  drainAll();
  expect(getJobLinks("fn-13-title")[0]?.title).toBe("Live session title");
});

test("syncJobLinksOnJobWrite: RateLimited (legacy alias) sets last_api_error_at + kind='rate_limit', revival clears both", () => {
  // Set up a working session linked to an epic.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-rl" });
  planPlanOpener("sess-rl");
  planctlEvent({
    sessionId: "sess-rl",
    op: "epic-create",
    target: "fn-14-rl",
    epicId: "fn-14-rl",
    subjectPresent: true,
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-rl" });
  drainAll();
  expect(getJobLinks("fn-14-rl")[0]?.last_api_error_at).toBeNull();
  expect(getJobLinks("fn-14-rl")[0]?.last_api_error_kind).toBeNull();

  // Schema v24: the `RateLimited` event_type is the legacy alias on the
  // dual-case fold arm — it forces `kind="rate_limit"` so the historical
  // event log re-folds byte-deterministically alongside any new `ApiError`
  // mints. Both columns stamp together (paired-NULL invariant); the
  // reverse fan-out propagates BOTH to the embedded entry.
  const rlId = insertEvent({
    hook_event: "RateLimited",
    session_id: "sess-rl",
  });
  drainAll();
  const limited = getJobLinks("fn-14-rl")[0];
  expect(limited?.state).toBe("stopped");
  expect(limited?.last_api_error_at).not.toBeNull();
  expect(limited?.last_api_error_kind).toBe("rate_limit");

  // A fresh UserPromptSubmit revives the session — clears BOTH new
  // columns (paired-NULL clear) and flips state back to "working". The
  // reverse fan-out propagates the paired clear to the embedded entry.
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-rl" });
  drainAll();
  const revived = getJobLinks("fn-14-rl")[0];
  expect(revived?.state).toBe("working");
  expect(revived?.last_api_error_at).toBeNull();
  expect(revived?.last_api_error_kind).toBeNull();
  // Smoke: the RateLimited event was the trigger that minted the prior
  // stamp; the prior reference is preserved for clarity.
  expect(rlId).toBeGreaterThan(0);
});

test("syncJobLinksOnJobWrite: ApiError (new mint) with data.kind='rate_limit' folds to byte-identical rows as a sibling RateLimited event", () => {
  // Dual-case alias coverage gate (CLAUDE.md "byte-identical re-fold"):
  // an `ApiError` event carrying `data.kind="rate_limit"` MUST produce a
  // post-fold `jobs` row + `epics.job_links` entry that is JSON-equal to
  // the equivalent `RateLimited`-folded state. The only field that may
  // legitimately differ is `last_event_id` (event ids are
  // monotone-per-DB so the two events get distinct ids) — strip that
  // before compare.
  //
  // Build two parallel sessions, each linked to its own epic, each
  // folded through ONE api-error event of the opposite arm.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-rl-legacy" });
  planPlanOpener("sess-rl-legacy");
  planctlEvent({
    sessionId: "sess-rl-legacy",
    op: "epic-create",
    target: "fn-16-rl-legacy",
    epicId: "fn-16-rl-legacy",
    subjectPresent: true,
  });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-rl-legacy",
  });
  insertEvent({
    hook_event: "RateLimited",
    session_id: "sess-rl-legacy",
  });

  insertEvent({ hook_event: "SessionStart", session_id: "sess-rl-new" });
  planPlanOpener("sess-rl-new");
  planctlEvent({
    sessionId: "sess-rl-new",
    op: "epic-create",
    target: "fn-16-rl-new",
    epicId: "fn-16-rl-new",
    subjectPresent: true,
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-rl-new" });
  insertEvent({
    hook_event: "ApiError",
    session_id: "sess-rl-new",
    data: JSON.stringify({ kind: "rate_limit", text: "API quota exceeded" }),
  });

  drainAll();

  // The two embedded entries on their respective epics must match
  // field-for-field on (state, last_api_error_kind, last_api_error_at != null).
  const legacy = getJobLinks("fn-16-rl-legacy")[0];
  const newMint = getJobLinks("fn-16-rl-new")[0];
  expect(legacy?.state).toBe("stopped");
  expect(newMint?.state).toBe("stopped");
  expect(legacy?.last_api_error_kind).toBe("rate_limit");
  expect(newMint?.last_api_error_kind).toBe("rate_limit");
  expect(legacy?.last_api_error_at).not.toBeNull();
  expect(newMint?.last_api_error_at).not.toBeNull();

  // The jobs rows themselves must also carry the same kind value — proves
  // the dual-case alias landed at the jobs projection layer, not just the
  // fan-out side.
  const legacyJob = db
    .query(
      "SELECT state, last_api_error_at, last_api_error_kind FROM jobs WHERE job_id = ?",
    )
    .get("sess-rl-legacy") as {
    state: string;
    last_api_error_at: number | null;
    last_api_error_kind: string | null;
  };
  const newJob = db
    .query(
      "SELECT state, last_api_error_at, last_api_error_kind FROM jobs WHERE job_id = ?",
    )
    .get("sess-rl-new") as {
    state: string;
    last_api_error_at: number | null;
    last_api_error_kind: string | null;
  };
  expect(legacyJob.state).toBe("stopped");
  expect(newJob.state).toBe("stopped");
  expect(legacyJob.last_api_error_kind).toBe("rate_limit");
  expect(newJob.last_api_error_kind).toBe("rate_limit");
  expect(legacyJob.last_api_error_at).not.toBeNull();
  expect(newJob.last_api_error_at).not.toBeNull();
});

test("ApiError fold: data.kind values outside the canonical ApiErrorKind allow-list fold to 'unknown'", () => {
  // Coverage for the unknown-fallback branch of `validateApiErrorKind`:
  // anything not in the canonical six-kind allow-list (including the SDK's
  // own `"unknown"` string AND garbage strings AND missing `kind`) folds
  // to the literal `"unknown"`. Pure function of the event payload — no
  // throw inside the fold transaction (CLAUDE.md "never throw inside the
  // fold tx").
  for (const [variant, payload] of [
    ["sdk-unknown", { kind: "unknown" }],
    ["garbage-string", { kind: "not-a-real-error-type" }],
    ["non-string", { kind: 42 }],
    ["missing", {}],
  ] as const) {
    const sessionId = `sess-ae-${variant}`;
    insertEvent({ hook_event: "SessionStart", session_id: sessionId });
    insertEvent({ hook_event: "UserPromptSubmit", session_id: sessionId });
    insertEvent({
      hook_event: "ApiError",
      session_id: sessionId,
      data: JSON.stringify(payload),
    });
  }
  drainAll();

  for (const variant of [
    "sdk-unknown",
    "garbage-string",
    "non-string",
    "missing",
  ]) {
    const row = db
      .query(
        "SELECT state, last_api_error_kind, last_api_error_at FROM jobs WHERE job_id = ?",
      )
      .get(`sess-ae-${variant}`) as {
      state: string;
      last_api_error_kind: string | null;
      last_api_error_at: number | null;
    };
    expect(row.state).toBe("stopped");
    expect(row.last_api_error_kind).toBe("unknown");
    expect(row.last_api_error_at).not.toBeNull();
  }
});

test("ApiError fold: each canonical ApiErrorKind round-trips + flips state to 'stopped' + stamps last_api_error_at", () => {
  // Sanity gate on the allow-list. The dual-case alias forces "rate_limit"
  // on RateLimited; the ApiError arm validates `data.kind` against the
  // canonical six-value union. Each canonical value must:
  //   (a) round-trip verbatim into `last_api_error_kind`
  //       (no normalization, no lower/upper-case mangling),
  //   (b) flip `jobs.state` from "working" → "stopped" (same terminal
  //       semantics as the legacy RateLimited arm), and
  //   (c) stamp `last_api_error_at` to a non-NULL real (paired-NULL
  //       invariant: both columns move together, both clear together).
  // Excludes "rate_limit" — covered by the legacy-alias test above; this
  // gate is the per-kind fold-arm coverage promised by task .2.
  const kinds = [
    "authentication_failed",
    "billing_error",
    "server_error",
    "invalid_request",
    "unknown",
  ] as const;
  for (const kind of kinds) {
    const sessionId = `sess-ae-canonical-${kind}`;
    insertEvent({ hook_event: "SessionStart", session_id: sessionId });
    insertEvent({ hook_event: "UserPromptSubmit", session_id: sessionId });
    insertEvent({
      hook_event: "ApiError",
      session_id: sessionId,
      data: JSON.stringify({ kind }),
    });
  }
  drainAll();
  for (const kind of kinds) {
    const row = db
      .query(
        "SELECT state, last_api_error_kind, last_api_error_at FROM jobs WHERE job_id = ?",
      )
      .get(`sess-ae-canonical-${kind}`) as {
      state: string;
      last_api_error_kind: string | null;
      last_api_error_at: number | null;
    };
    expect(row.last_api_error_kind).toBe(kind);
    expect(row.state).toBe("stopped");
    expect(row.last_api_error_at).not.toBeNull();
  }
});

test("ApiError fold: terminal-row guard preserved — ApiError on an 'ended' / 'killed' row does NOT resurrect (both new columns stay NULL)", () => {
  // Negative-coverage gate on the terminal guard. The pre-v24 RateLimited
  // arm carried a `state NOT IN ('ended','killed')` predicate to block
  // resurrection of a row whose lifecycle is already terminal for
  // unrelated reasons; the dual-case fold MUST preserve it verbatim.
  // Without this guard, a stray late-arriving api-error event could
  // mid-life-stamp an already-terminal row.

  // 'ended' row.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ended" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ended" });
  insertEvent({ hook_event: "SessionEnd", session_id: "sess-ended" });
  drainAll();
  insertEvent({
    hook_event: "ApiError",
    session_id: "sess-ended",
    data: JSON.stringify({ kind: "rate_limit" }),
  });
  drainAll();
  const ended = db
    .query(
      "SELECT state, last_api_error_at, last_api_error_kind FROM jobs WHERE job_id = ?",
    )
    .get("sess-ended") as {
    state: string;
    last_api_error_at: number | null;
    last_api_error_kind: string | null;
  };
  expect(ended.state).toBe("ended");
  expect(ended.last_api_error_at).toBeNull();
  expect(ended.last_api_error_kind).toBeNull();

  // 'killed' row — direct write via the schema (the live exit-watcher
  // would do this through a Killed event, but for this guard test we just
  // hand-set the state to verify the SQL predicate).
  insertEvent({ hook_event: "SessionStart", session_id: "sess-killed" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-killed" });
  drainAll();
  db.run("UPDATE jobs SET state = 'killed' WHERE job_id = 'sess-killed'");
  insertEvent({
    hook_event: "ApiError",
    session_id: "sess-killed",
    data: JSON.stringify({ kind: "server_error" }),
  });
  drainAll();
  const killed = db
    .query(
      "SELECT state, last_api_error_at, last_api_error_kind FROM jobs WHERE job_id = ?",
    )
    .get("sess-killed") as {
    state: string;
    last_api_error_at: number | null;
    last_api_error_kind: string | null;
  };
  expect(killed.state).toBe("killed");
  expect(killed.last_api_error_at).toBeNull();
  expect(killed.last_api_error_kind).toBeNull();
});

test("syncJobLinksOnJobWrite: short-circuits when jobs.epic_links is '[]' (no fan-out)", () => {
  // A bare SessionStart with no planctl footprint — `jobs.epic_links`
  // is `'[]'` and the reverse fan-out short-circuits on the
  // pre-parse byte-compare. Sanity check: no epic row is created and
  // no error is raised.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-no-links" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-no-links" });
  insertEvent({ hook_event: "Stop", session_id: "sess-no-links" });
  drainAll();
  const epicCount = db.query("SELECT count(*) AS c FROM epics").get() as {
    c: number;
  };
  expect(epicCount.c).toBe(0);
});

test("syncJobLinksOnJobWrite: cross-session OLD-entry carve-out preserves other entries verbatim", () => {
  // Two sessions both refine the same epic. A jobs-write on session A
  // must re-stamp ONLY A's entry on the epic — B's entry must survive
  // verbatim. Regression: a missing carve-out (e.g. an inline rebuild
  // that dropped every other entry instead of filtering by job_id)
  // would silently lose B's edge on every A jobs-write.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-A-carve" });
  planPlanOpener("sess-A-carve");
  planctlEvent({
    sessionId: "sess-A-carve",
    op: "epic-create",
    target: "fn-15-carve",
    epicId: "fn-15-carve",
    subjectPresent: true,
  });
  insertEvent({ hook_event: "SessionStart", session_id: "sess-B-carve" });
  planPlanOpener("sess-B-carve");
  planctlEvent({
    sessionId: "sess-B-carve",
    op: "epic-set-title",
    target: "fn-15-carve",
    epicId: "fn-15-carve",
    subjectPresent: true,
  });
  drainAll();
  const initial = getJobLinks("fn-15-carve");
  expect(initial).toHaveLength(2);
  expect(initial[0]?.kind).toBe("creator");
  expect(initial[0]?.job_id).toBe("sess-A-carve");
  expect(initial[1]?.kind).toBe("refiner");
  expect(initial[1]?.job_id).toBe("sess-B-carve");

  // Drive A to "working" via UserPromptSubmit. B's entry on the epic
  // must survive byte-for-byte; only A's entry's `state` flips.
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-A-carve" });
  drainAll();
  const after = getJobLinks("fn-15-carve");
  expect(after).toHaveLength(2);
  // A: kind=creator preserved, state flipped to working.
  expect(after[0]).toEqual({
    kind: "creator",
    job_id: "sess-A-carve",
    title: null,
    state: "working",
    last_api_error_at: null,
    last_api_error_kind: null,
    last_input_request_at: null,
    last_input_request_kind: null,
  });
  // B: untouched (state still default "stopped").
  expect(after[1]).toEqual({
    kind: "refiner",
    job_id: "sess-B-carve",
    title: null,
    state: "stopped",
    last_api_error_at: null,
    last_api_error_kind: null,
    last_input_request_at: null,
    last_input_request_kind: null,
  });
});

test("syncJobLinksOnJobWrite: Killed state flip propagates to epics.job_links", () => {
  // CLAUDE.md invariant: "a `state` flip on UserPromptSubmit / Stop /
  // SessionEnd / Killed / RateLimited … propagates to every epic that
  // references the session." The Stop / UserPromptSubmit / RateLimited
  // arms are covered above; pin the Killed arm here.
  //
  // Seed: SessionStart with explicit (pid, start_time) so the Killed
  // event's strict-match path fires (the loose pid-only branch is the
  // legacy-row exception, not what we want to exercise). Then drive a
  // planctl creator edge so `jobs.epic_links` is non-empty and the
  // reverse fan-out has a target.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-kill",
    pid: 7777,
    start_time: "macos:Wed May 26 12:00:00 2026",
  });
  planPlanOpener("sess-kill");
  planctlEvent({
    sessionId: "sess-kill",
    op: "epic-create",
    target: "fn-17-kill",
    epicId: "fn-17-kill",
    subjectPresent: true,
  });
  // UserPromptSubmit must carry the same pid as SessionStart — a
  // pid-change clears start_time to NULL (the legacy-loose path) and
  // would defeat the strict-match Killed exercise.
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-kill",
    pid: 7777,
  });
  drainAll();
  expect(getJobLinks("fn-17-kill")[0]?.state).toBe("working");

  // Killed with matching (pid, start_time) → jobs.state flips to
  // "killed"; syncIfPlanRef → syncJobLinksOnJobWrite re-stamps the
  // linked epic's entry.
  killedEvent(7777, "macos:Wed May 26 12:00:00 2026", "sess-kill");
  drainAll();
  expect(getJobLinks("fn-17-kill")[0]?.state).toBe("killed");
});

test("syncPlanctlLinks: missing jobs row at enrichment defaults to safe values (no throw inside fold)", () => {
  // The classifier's deriveJobLinks runs OVER the events log directly
  // and can emit edges for sessions that have NO backing jobs row
  // (planctl invocation without a SessionStart — an orphan). The
  // enrichment helper must fold the missing row to defaults rather
  // than throw; rolling back the cursor would wedge the reducer.
  //
  // Drive an orphan planctl invocation: no SessionStart for the
  // session, just a window opener + a planctl create event. The
  // backing jobs row never gets inserted; the epic's job_links entry
  // for this session must land with `enrichJobLink`'s defaults.
  planPlanOpener("sess-orphan");
  planctlEvent({
    sessionId: "sess-orphan",
    op: "epic-create",
    target: "fn-16-orphan",
    epicId: "fn-16-orphan",
    subjectPresent: true,
  });
  drainAll();
  // The orphan session has no backing jobs row, so enrichment hits
  // the missing-row default branch.
  const orphanJob = db
    .query("SELECT job_id FROM jobs WHERE job_id = ?")
    .get("sess-orphan");
  expect(orphanJob).toBeNull();
  // The epic's job_links carries the entry with defaults.
  expect(getJobLinks("fn-16-orphan")).toEqual([
    {
      kind: "creator",
      job_id: "sess-orphan",
      title: null,
      state: "stopped",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
    },
  ]);
});

test("syncPlanctlLinks: widened-shape EpicSnapshot ON CONFLICT does not blank enriched fields", () => {
  // Mirror the classic carve-out test but assert the WIDENED-shape
  // payload survives. Without the carve-out, an approval RPC → file
  // write → file-watcher → EpicSnapshot fold would wipe the entry's
  // enriched fields back to defaults; this test pins the invariant
  // for the v21 shape.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-wide" });
  planPlanOpener("sess-wide");
  planctlEvent({
    sessionId: "sess-wide",
    op: "epic-create",
    target: "fn-17-wide",
    epicId: "fn-17-wide",
    subjectPresent: true,
  });
  // Drive an enriched payload: state=working + a real title via
  // UserPromptSubmit carrying session_title.
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-wide",
    data: JSON.stringify({ session_title: "Wide enrichment" }),
  });
  drainAll();
  expect(getJobLinks("fn-17-wide")).toEqual([
    {
      kind: "creator",
      job_id: "sess-wide",
      title: "Wide enrichment",
      state: "working",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
    },
  ]);

  // Fold an EpicSnapshot — must preserve the WIDENED enrichment fields.
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-17-wide",
    data: JSON.stringify({
      epic_number: 17,
      title: "Wide Survive Carve-out",
      project_dir: "/repo",
      status: "open",
    }),
  });
  drainAll();
  expect(getJobLinks("fn-17-wide")).toEqual([
    {
      kind: "creator",
      job_id: "sess-wide",
      title: "Wide enrichment",
      state: "working",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
    },
  ]);
});

// ---------------------------------------------------------------------------
// subagent_invocations projection (schema v17, fn-600 task .3)
//
// Reducer arms wire SubagentStart, SubagentStop, PostToolUse:Agent, and
// PostToolUseFailure:Agent into the peer-table projection via the per-event
// helpers from `src/subagent-invocations.ts`. All writes ride the same
// `BEGIN IMMEDIATE` as the cursor advance — re-fold determinism + safe
// no-op fold on every orphan/malformed branch.
// ---------------------------------------------------------------------------

/** Read every subagent_invocations row for a job, sorted (agent_id, turn_seq). */
function getSubagentRows(jobId = "sess-a") {
  return db
    .query(
      `SELECT job_id, agent_id, turn_seq, ts, tool_use_id, subagent_type,
              description, prompt_chars, status, duration_ms,
              last_event_id, updated_at
         FROM subagent_invocations
        WHERE job_id = ?
        ORDER BY agent_id, turn_seq`,
    )
    .all(jobId) as {
    job_id: string;
    agent_id: string;
    turn_seq: number;
    ts: number;
    tool_use_id: string | null;
    subagent_type: string | null;
    description: string | null;
    prompt_chars: number;
    status: string;
    duration_ms: number | null;
    last_event_id: number;
    updated_at: number;
  }[];
}

test("SubagentStart opens a row with status='running' and seeds subagent_type from agent_type", () => {
  insertEvent({ hook_event: "SessionStart" });
  const startId = insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-1",
    agent_type: "Explore",
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    job_id: "sess-a",
    agent_id: "agent-1",
    turn_seq: 0,
    tool_use_id: null,
    subagent_type: "Explore",
    description: null,
    prompt_chars: 0,
    status: "running",
    duration_ms: null,
    last_event_id: startId,
  });
  expect(getCursor()).toBe(startId);
});

test("SubagentStart with a NULL agent_id is a safe no-op (cursor still advances)", () => {
  insertEvent({ hook_event: "SessionStart" });
  const startId = insertEvent({
    hook_event: "SubagentStart",
    agent_id: null,
  });
  drainAll();
  expect(getSubagentRows()).toHaveLength(0);
  expect(getCursor()).toBe(startId);
});

test("SubagentStart with empty agent_type seeds subagent_type as NULL (PreToolUse-wins applies later)", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-2",
    agent_type: "",
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.subagent_type).toBeNull();
});

test("SubagentStart re-entrant on same agent_id increments turn_seq", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-r",
    agent_type: "Explore",
    ts: 1.0,
  });
  insertEvent({
    hook_event: "SubagentStop",
    agent_id: "agent-r",
    ts: 1.5,
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-r",
    agent_type: "Explore",
    ts: 2.0,
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows.map((r) => r.turn_seq)).toEqual([0, 1]);
});

test("SubagentStop closes the latest open turn with duration_ms in ms", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-d",
    agent_type: "Explore",
    ts: 100.0,
  });
  const stopId = insertEvent({
    hook_event: "SubagentStop",
    agent_id: "agent-d",
    ts: 102.5,
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    status: "ok",
    duration_ms: 2500,
    last_event_id: stopId,
  });
});

test("SubagentStop with no open turn is a safe no-op", () => {
  insertEvent({ hook_event: "SessionStart" });
  const stopId = insertEvent({
    hook_event: "SubagentStop",
    agent_id: "ghost",
  });
  drainAll();
  expect(getSubagentRows()).toHaveLength(0);
  expect(getCursor()).toBe(stopId);
});

test("SubagentStop with NULL agent_id is a safe no-op", () => {
  insertEvent({ hook_event: "SessionStart" });
  const stopId = insertEvent({
    hook_event: "SubagentStop",
    agent_id: null,
  });
  drainAll();
  expect(getSubagentRows()).toHaveLength(0);
  expect(getCursor()).toBe(stopId);
});

test("PostToolUse:Agent folds PreToolUse metadata onto the turn-0 row via the bridge", () => {
  insertEvent({ hook_event: "SessionStart" });
  // SubagentStart seeds turn-0 with subagent_type='Explore'.
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-X",
    agent_type: "Explore",
    ts: 10.0,
  });
  // PreToolUse:Agent carries the description + prompt + subagent_type.
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_abc",
    data: JSON.stringify({
      tool_use_id: "toolu_abc",
      tool_input: {
        description: "Explore the codebase for X",
        prompt: "Find every usage of the X function and summarize.",
        subagent_type: "Explore",
      },
    }),
  });
  // PostToolUse:Agent — bridges via subagent_agent_id column.
  const postId = insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_abc",
    subagent_agent_id: "agent-X",
    data: JSON.stringify({
      tool_use_id: "toolu_abc",
      tool_response: { agentId: "agent-X" },
    }),
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    agent_id: "agent-X",
    turn_seq: 0,
    tool_use_id: "toolu_abc",
    subagent_type: "Explore",
    description: "Explore the codebase for X",
    prompt_chars: "Find every usage of the X function and summarize.".length,
    status: "ok",
    last_event_id: postId,
  });
});

test("PostToolUse:Agent PreToolUse-wins precedence: empty PreToolUse subagent_type does not overwrite seeded value", () => {
  insertEvent({ hook_event: "SessionStart" });
  // Seed turn-0 with subagent_type='Explore' from SubagentStart.
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-Y",
    agent_type: "Explore",
  });
  // PreToolUse:Agent payload carries an EMPTY-string subagent_type — must NOT
  // overwrite the SubagentStart-seeded 'Explore'.
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_xyz",
    data: JSON.stringify({
      tool_use_id: "toolu_xyz",
      tool_input: { subagent_type: "" },
    }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_xyz",
    subagent_agent_id: "agent-Y",
    data: JSON.stringify({
      tool_use_id: "toolu_xyz",
      tool_response: { agentId: "agent-Y" },
    }),
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows[0]?.subagent_type).toBe("Explore");
});

test("PostToolUse:Agent uses JSON-fallback bridge when subagent_agent_id column is NULL (pre-fn-390 row)", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-legacy",
    agent_type: "Explore",
  });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_leg",
    data: JSON.stringify({
      tool_use_id: "toolu_leg",
      tool_input: { description: "do work" },
    }),
  });
  // subagent_agent_id NULL — must fall back to data.tool_response.agentId.
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_leg",
    subagent_agent_id: null,
    data: JSON.stringify({
      tool_use_id: "toolu_leg",
      tool_response: { agentId: "agent-legacy" },
    }),
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.description).toBe("do work");
  expect(rows[0]?.status).toBe("ok");
});

test("PostToolUse:Agent with no resolvable bridge is a safe no-op", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-Z",
  });
  // Neither subagent_agent_id nor data.tool_response.agentId resolve.
  const postId = insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_noresolve",
    subagent_agent_id: null,
    data: JSON.stringify({ tool_use_id: "toolu_noresolve" }),
  });
  drainAll();
  // Row stays at SubagentStart's seed — unchanged.
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    status: "running",
    tool_use_id: null,
    description: null,
  });
  expect(getCursor()).toBe(postId);
});

test("PostToolUse:Agent with no turn-0 row (PostToolUse-before-SubagentStart ordering) is a safe no-op", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_early",
    data: JSON.stringify({
      tool_use_id: "toolu_early",
      tool_input: { description: "early" },
    }),
  });
  const postId = insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_early",
    subagent_agent_id: "agent-noseed",
    data: JSON.stringify({
      tool_use_id: "toolu_early",
      tool_response: { agentId: "agent-noseed" },
    }),
  });
  drainAll();
  expect(getSubagentRows()).toHaveLength(0);
  expect(getCursor()).toBe(postId);
});

test("PostToolUseFailure:Agent with no resolvable bridge is a safe no-op (orphan failure)", () => {
  // Bridge column NULL + no data.tool_response.agentId — resolveBridgeAgentId
  // returns null and the arm short-circuits. SubagentStop later lands the row
  // at 'ok' as if nothing happened.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-F",
    agent_type: "Explore",
    ts: 50.0,
  });
  const failId = insertEvent({
    hook_event: "PostToolUseFailure",
    tool_name: "Agent",
    tool_use_id: "toolu_fail",
    data: JSON.stringify({ tool_use_id: "toolu_fail" }),
  });
  insertEvent({
    hook_event: "SubagentStop",
    agent_id: "agent-F",
    ts: 51.0,
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "ok", duration_ms: 1000 });
  // Failure event still advanced the cursor — SubagentStop advanced past it.
  expect(getCursor()).toBeGreaterThanOrEqual(failId);
});

test("PostToolUseFailure:Agent with resolved bridge UPDATEs row to status='failed'", () => {
  // The bridge `subagent_agent_id` column resolves to the matching turn-0
  // row; UPDATE lands `status='failed'` even though a SubagentStop later
  // tries to flip it back. The terminal-status guard in the SubagentStop arm
  // preserves the `'failed'` signal.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-FF",
    agent_type: "Explore",
    ts: 60.0,
  });
  const failId = insertEvent({
    hook_event: "PostToolUseFailure",
    tool_name: "Agent",
    tool_use_id: "toolu_ff",
    subagent_agent_id: "agent-FF",
    data: JSON.stringify({ tool_use_id: "toolu_ff" }),
  });
  insertEvent({
    hook_event: "SubagentStop",
    agent_id: "agent-FF",
    ts: 61.0,
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  // 'failed' wins — SubagentStop's terminal-status guard preserves it.
  // duration_ms is still computed by SubagentStop (the row closes).
  expect(rows[0]).toMatchObject({ status: "failed", duration_ms: 1000 });
  expect(getCursor()).toBeGreaterThanOrEqual(failId);
});

test("PostToolUseFailure:Agent with non-Agent tool_name is a safe no-op", () => {
  // Symmetry with PostToolUse arm — non-Agent rows have no
  // subagent_invocations meaning.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-NA",
    agent_type: "Explore",
    ts: 70.0,
  });
  insertEvent({
    hook_event: "PostToolUseFailure",
    tool_name: "Bash",
    tool_use_id: "toolu_bash_fail",
    subagent_agent_id: "agent-NA",
    data: JSON.stringify({ tool_use_id: "toolu_bash_fail" }),
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  // Untouched — still running.
  expect(rows[0]?.status).toBe("running");
});

test("PostToolUseFailure:Agent orphan (no matching turn-0 row) is a safe no-op", () => {
  // Bridge resolves but no SubagentStart for this agent_id ever fired — the
  // UPDATE matches zero rows. Cursor still advances.
  insertEvent({ hook_event: "SessionStart" });
  const failId = insertEvent({
    hook_event: "PostToolUseFailure",
    tool_name: "Agent",
    tool_use_id: "toolu_orphan",
    subagent_agent_id: "agent-missing",
    data: JSON.stringify({ tool_use_id: "toolu_orphan" }),
  });
  drainAll();
  expect(getSubagentRows()).toHaveLength(0);
  expect(getCursor()).toBe(failId);
});

test("SessionEnd sweeps open status='running' subagent rows to status='unknown'", () => {
  // Two open subagents: one closed cleanly (status='ok'), one still open.
  // SessionEnd's lifecycle write fires the sweep; the still-open row flips
  // to 'unknown'; the closed one is untouched (status='ok' is not 'running').
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-S1",
    agent_type: "Explore",
    ts: 100.0,
  });
  insertEvent({
    hook_event: "SubagentStop",
    agent_id: "agent-S1",
    ts: 101.0,
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-S2",
    agent_type: "Plan",
    ts: 110.0,
  });
  insertEvent({ hook_event: "SessionEnd", ts: 120.0 });
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(2);
  const byAgent = Object.fromEntries(rows.map((r) => [r.agent_id, r]));
  expect(byAgent["agent-S1"]).toMatchObject({
    status: "ok",
    duration_ms: 1000,
  });
  // The orphaned subagent — closed by the SessionEnd sweep, NOT a real
  // SubagentStop, so duration_ms stays NULL.
  expect(byAgent["agent-S2"]).toMatchObject({
    status: "unknown",
    duration_ms: null,
  });
});

test("Killed sweeps open status='running' subagent rows to status='unknown' on the proven write path", () => {
  // Killed fires the sweep ONLY when the (pid, start_time) match lands.
  insertEvent({
    hook_event: "SessionStart",
    pid: 4242,
    start_time: "macos:t1",
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-K",
    agent_type: "Build",
    ts: 200.0,
  });
  killedEvent(4242, "macos:t1");
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "unknown", duration_ms: null });
});

test("Killed mismatch (stale pid) does NOT sweep open subagent rows", () => {
  // (pid, start_time) mismatch — the jobs row write short-circuits, and the
  // sweep MUST NOT fire (no lifecycle write happened).
  insertEvent({
    hook_event: "SessionStart",
    pid: 4242,
    start_time: "macos:t2",
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-K2",
    agent_type: "Build",
    ts: 200.0,
  });
  // Mismatched pid — Killed arm falls through without writing.
  killedEvent(9999, "macos:t2");
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.status).toBe("running");
});

test("Late SubagentStop after SessionEnd sweep preserves status='unknown' (terminal guard)", () => {
  // The sweep lands 'unknown'; a later SubagentStop fires — terminal-status
  // guard preserves the 'unknown' value and refuses to flip to 'ok'.
  // duration_ms IS still computed because the gate is `duration_ms IS NULL`
  // alone (fn-480 invariant).
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-L",
    agent_type: "Explore",
    ts: 300.0,
  });
  insertEvent({ hook_event: "SessionEnd", ts: 310.0 });
  insertEvent({
    hook_event: "SubagentStop",
    agent_id: "agent-L",
    ts: 311.0,
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "unknown", duration_ms: 11000 });
});

test("PostToolUse:Agent marks prior same-type same-job open running row as superseded", () => {
  // Two SubagentStarts with same subagent_type='Explore'; agent-A spawns
  // first, agent-B spawns second. agent-B's PostToolUse:Agent fires while
  // agent-A is still running — the bridged row's spawn ts is 102.0 (agent-B),
  // and the scan finds agent-A's row (ts=101.0 < 102.0, status='running',
  // same job, same subagent_type='Explore') and marks it superseded.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_sup_A",
    data: JSON.stringify({
      tool_use_id: "toolu_sup_A",
      tool_input: { subagent_type: "Explore", description: "A", prompt: "pA" },
    }),
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-supA",
    agent_type: "Explore",
    ts: 101.0,
  });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_sup_B",
    data: JSON.stringify({
      tool_use_id: "toolu_sup_B",
      tool_input: { subagent_type: "Explore", description: "B", prompt: "pB" },
    }),
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-supB",
    agent_type: "Explore",
    ts: 102.0,
  });
  // agent-B's PostToolUse:Agent — this is the supersession trigger. agent-A
  // is still running at this point (no SubagentStop yet).
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_sup_B",
    subagent_agent_id: "agent-supB",
    data: JSON.stringify({
      tool_use_id: "toolu_sup_B",
      tool_response: { agentId: "agent-supB" },
    }),
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(2);
  const byAgent = Object.fromEntries(rows.map((r) => [r.agent_id, r]));
  // agent-A: superseded (it spawned first, still 'running' when agent-B's
  // PostToolUse:Agent bridged).
  expect(byAgent["agent-supA"]?.status).toBe("superseded");
  // agent-B: ok (its own PostToolUse:Agent fold).
  expect(byAgent["agent-supB"]?.status).toBe("ok");
});

test("PostToolUse:Agent does NOT supersede already-closed peers (status='ok'/'failed')", () => {
  // agent-A closes cleanly (status='ok') BEFORE agent-B's PostToolUse:Agent
  // lands. The scan's `status='running'` gate skips agent-A — no supersession.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_closed_A",
    data: JSON.stringify({
      tool_use_id: "toolu_closed_A",
      tool_input: { subagent_type: "Explore", description: "A", prompt: "p" },
    }),
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-closedA",
    agent_type: "Explore",
    ts: 201.0,
  });
  insertEvent({
    hook_event: "SubagentStop",
    agent_id: "agent-closedA",
    ts: 201.5,
  });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_closed_B",
    data: JSON.stringify({
      tool_use_id: "toolu_closed_B",
      tool_input: { subagent_type: "Explore", description: "B", prompt: "p" },
    }),
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-closedB",
    agent_type: "Explore",
    ts: 202.0,
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_closed_B",
    subagent_agent_id: "agent-closedB",
    data: JSON.stringify({
      tool_use_id: "toolu_closed_B",
      tool_response: { agentId: "agent-closedB" },
    }),
  });
  drainAll();
  const rows = getSubagentRows();
  const byAgent = Object.fromEntries(rows.map((r) => [r.agent_id, r]));
  // Both remain 'ok' — supersession scan didn't fire on agent-A because its
  // status was already 'ok' when agent-B's PostToolUse:Agent ran.
  expect(byAgent["agent-closedA"]?.status).toBe("ok");
  expect(byAgent["agent-closedB"]?.status).toBe("ok");
});

test("PostToolUse:Agent only supersedes same subagent_type — different types are independent", () => {
  // agent-A is subagent_type='Explore', agent-B is subagent_type='Plan'. The
  // group scan keys on subagent_type so agent-A is untouched by agent-B's
  // PostToolUse:Agent.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_diffty_A",
    data: JSON.stringify({
      tool_use_id: "toolu_diffty_A",
      tool_input: { subagent_type: "Explore", description: "A", prompt: "p" },
    }),
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-diffA",
    agent_type: "Explore",
    ts: 301.0,
  });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_diffty_B",
    data: JSON.stringify({
      tool_use_id: "toolu_diffty_B",
      tool_input: { subagent_type: "Plan", description: "B", prompt: "p" },
    }),
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-diffB",
    agent_type: "Plan",
    ts: 302.0,
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_diffty_B",
    subagent_agent_id: "agent-diffB",
    data: JSON.stringify({
      tool_use_id: "toolu_diffty_B",
      tool_response: { agentId: "agent-diffB" },
    }),
  });
  drainAll();
  const rows = getSubagentRows();
  const byAgent = Object.fromEntries(rows.map((r) => [r.agent_id, r]));
  // Different subagent_type — agent-A stays running, NOT superseded.
  expect(byAgent["agent-diffA"]?.status).toBe("running");
  expect(byAgent["agent-diffB"]?.status).toBe("ok");
});

test("Late SubagentStop on superseded row preserves status='superseded' (terminal guard)", () => {
  // Reuses the supersession scenario; agent-A is superseded, then its
  // SubagentStop fires later. Terminal guard preserves 'superseded'.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_lateA",
    data: JSON.stringify({
      tool_use_id: "toolu_lateA",
      tool_input: { subagent_type: "Explore", description: "A", prompt: "p" },
    }),
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-lateA",
    agent_type: "Explore",
    ts: 401.0,
  });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_lateB",
    data: JSON.stringify({
      tool_use_id: "toolu_lateB",
      tool_input: { subagent_type: "Explore", description: "B", prompt: "p" },
    }),
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-lateB",
    agent_type: "Explore",
    ts: 402.0,
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_lateB",
    subagent_agent_id: "agent-lateB",
    data: JSON.stringify({
      tool_use_id: "toolu_lateB",
      tool_response: { agentId: "agent-lateB" },
    }),
  });
  // agent-A's SubagentStop lands LATER — must preserve 'superseded'.
  insertEvent({
    hook_event: "SubagentStop",
    agent_id: "agent-lateA",
    ts: 403.0,
  });
  drainAll();
  const rows = getSubagentRows();
  const byAgent = Object.fromEntries(rows.map((r) => [r.agent_id, r]));
  expect(byAgent["agent-lateA"]?.status).toBe("superseded");
  // duration_ms still computes (the row closes; only the status is sticky).
  expect(byAgent["agent-lateA"]?.duration_ms).toBe(2000);
});

test("subagent_invocations re-fold is byte-identical with new arms (failed/unknown/superseded)", () => {
  // Exercise all three new arms in one fold + a clean-close peer, then
  // rewind + DELETE + re-drain and assert byte-identical row set.
  insertEvent({ hook_event: "SessionStart" });
  // Clean close — exercises the unchanged path.
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-cln",
    agent_type: "Build",
    ts: 500.0,
  });
  insertEvent({
    hook_event: "SubagentStop",
    agent_id: "agent-cln",
    ts: 501.0,
  });
  // PostToolUseFailure → 'failed'.
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-fld",
    agent_type: "Explore",
    ts: 510.0,
  });
  insertEvent({
    hook_event: "PostToolUseFailure",
    tool_name: "Agent",
    tool_use_id: "toolu_fld",
    subagent_agent_id: "agent-fld",
    data: JSON.stringify({ tool_use_id: "toolu_fld" }),
  });
  // Supersession pair on subagent_type='Plan'.
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_sup_X",
    data: JSON.stringify({
      tool_use_id: "toolu_sup_X",
      tool_input: { subagent_type: "Plan", description: "X", prompt: "p" },
    }),
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-supX",
    agent_type: "Plan",
    ts: 520.0,
  });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_sup_Y",
    data: JSON.stringify({
      tool_use_id: "toolu_sup_Y",
      tool_input: { subagent_type: "Plan", description: "Y", prompt: "p" },
    }),
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-supY",
    agent_type: "Plan",
    ts: 521.0,
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_sup_Y",
    subagent_agent_id: "agent-supY",
    data: JSON.stringify({
      tool_use_id: "toolu_sup_Y",
      tool_response: { agentId: "agent-supY" },
    }),
  });
  // Lifecycle sweep — open subagent + SessionEnd → 'unknown'.
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-swp",
    agent_type: "Refactor",
    ts: 530.0,
  });
  insertEvent({ hook_event: "SessionEnd", ts: 540.0 });
  drainAll();
  const before = db
    .query(
      `SELECT * FROM subagent_invocations ORDER BY job_id, agent_id, turn_seq`,
    )
    .all();
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  db.run("DELETE FROM subagent_invocations");
  drainAll();
  const after = db
    .query(
      `SELECT * FROM subagent_invocations ORDER BY job_id, agent_id, turn_seq`,
    )
    .all();
  expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  // Spot-check the four expected statuses landed correctly.
  const byAgent = Object.fromEntries(
    (after as Array<{ agent_id: string; status: string }>).map((r) => [
      r.agent_id,
      r.status,
    ]),
  );
  expect(byAgent["agent-cln"]).toBe("ok");
  expect(byAgent["agent-fld"]).toBe("failed");
  expect(byAgent["agent-supX"]).toBe("superseded");
  expect(byAgent["agent-supY"]).toBe("ok");
  expect(byAgent["agent-swp"]).toBe("unknown");
});

test("PostToolUse:Agent fires BEFORE SubagentStop (Task call ordering); SubagentStop still closes the row", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-O",
    agent_type: "Explore",
    ts: 100.0,
  });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_O",
    data: JSON.stringify({
      tool_use_id: "toolu_O",
      tool_input: { description: "ordering test", prompt: "hello world" },
    }),
  });
  // PostToolUse:Agent lands FIRST — flips status to 'ok'.
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_O",
    subagent_agent_id: "agent-O",
    ts: 102.0,
    data: JSON.stringify({
      tool_use_id: "toolu_O",
      tool_response: { agentId: "agent-O" },
    }),
  });
  // SubagentStop lands SECOND — must still close (gate is duration_ms IS
  // NULL, NOT status='running').
  insertEvent({
    hook_event: "SubagentStop",
    agent_id: "agent-O",
    ts: 102.5,
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    status: "ok",
    duration_ms: 2500,
    description: "ordering test",
    prompt_chars: "hello world".length,
  });
});

test("PostToolUse:Agent with malformed JSON data folds to safe no-op (no throw)", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-M",
  });
  // Malformed JSON in data — resolveBridgeAgentId returns null. Reducer must
  // NOT throw; cursor advances.
  const postId = insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_M",
    subagent_agent_id: null,
    data: "{not valid json",
  });
  drainAll();
  expect(getCursor()).toBe(postId);
  // Row stays at SubagentStart seed — unchanged.
  expect(getSubagentRows()[0]?.status).toBe("running");
});

test("Bridge lookup isolates session_id — cross-job tool_use_id collision does not contaminate", () => {
  // Two separate sessions, same tool_use_id. The PreToolUse-payload bridge
  // must scope to session_id, not just tool_use_id.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  insertEvent({ hook_event: "SessionStart", session_id: "sess-b" });
  // sess-a's subagent.
  insertEvent({
    hook_event: "SubagentStart",
    session_id: "sess-a",
    agent_id: "agent-a",
    agent_type: "Explore",
  });
  insertEvent({
    hook_event: "PreToolUse",
    session_id: "sess-a",
    tool_name: "Agent",
    tool_use_id: "toolu_COLLIDE",
    data: JSON.stringify({
      tool_use_id: "toolu_COLLIDE",
      tool_input: { description: "from session a" },
    }),
  });
  // sess-b's subagent — DIFFERENT description, same tool_use_id.
  insertEvent({
    hook_event: "SubagentStart",
    session_id: "sess-b",
    agent_id: "agent-b",
    agent_type: "Explore",
  });
  insertEvent({
    hook_event: "PreToolUse",
    session_id: "sess-b",
    tool_name: "Agent",
    tool_use_id: "toolu_COLLIDE",
    data: JSON.stringify({
      tool_use_id: "toolu_COLLIDE",
      tool_input: { description: "from session b" },
    }),
  });
  // sess-a's PostToolUse — must lift sess-a's description, NOT sess-b's.
  insertEvent({
    hook_event: "PostToolUse",
    session_id: "sess-a",
    tool_name: "Agent",
    tool_use_id: "toolu_COLLIDE",
    subagent_agent_id: "agent-a",
    data: JSON.stringify({
      tool_use_id: "toolu_COLLIDE",
      tool_response: { agentId: "agent-a" },
    }),
  });
  // sess-b's PostToolUse.
  insertEvent({
    hook_event: "PostToolUse",
    session_id: "sess-b",
    tool_name: "Agent",
    tool_use_id: "toolu_COLLIDE",
    subagent_agent_id: "agent-b",
    data: JSON.stringify({
      tool_use_id: "toolu_COLLIDE",
      tool_response: { agentId: "agent-b" },
    }),
  });
  drainAll();
  const sessA = getSubagentRows("sess-a");
  const sessB = getSubagentRows("sess-b");
  expect(sessA[0]?.description).toBe("from session a");
  expect(sessB[0]?.description).toBe("from session b");
});

test("subagent_invocations re-fold is byte-identical (rewind + DELETE + drain)", () => {
  // Seed a full quartet plus a still-open second subagent for variety.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-A",
    agent_type: "Explore",
    ts: 10.0,
  });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_A",
    data: JSON.stringify({
      tool_use_id: "toolu_A",
      tool_input: { description: "AAA", prompt: "p" },
    }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_A",
    subagent_agent_id: "agent-A",
    data: JSON.stringify({
      tool_use_id: "toolu_A",
      tool_response: { agentId: "agent-A" },
    }),
  });
  insertEvent({
    hook_event: "SubagentStop",
    agent_id: "agent-A",
    ts: 12.0,
  });
  // Still-open second agent — must round-trip as status='running'.
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-B",
    agent_type: "Build",
    ts: 20.0,
  });
  drainAll();
  const before = db
    .query(
      `SELECT * FROM subagent_invocations ORDER BY job_id, agent_id, turn_seq`,
    )
    .all();
  // Rewind + DELETE + re-drain.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  db.run("DELETE FROM subagent_invocations");
  drainAll();
  const after = db
    .query(
      `SELECT * FROM subagent_invocations ORDER BY job_id, agent_id, turn_seq`,
    )
    .all();
  expect(after).toEqual(before);
});

test("subagent_invocations coexists with planctl_links fan-out — both projections populate, both deterministic on re-fold", () => {
  // fn-598 + fn-600 coexistence: a session that runs both planctl invocations
  // and Agent calls keeps both projections populated; both reproduce on
  // re-fold.
  insertEvent({ hook_event: "SessionStart" });
  // A planctl invocation (fn-598 fan-out into jobs.epic_links /
  // epics.job_links).
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Bash",
    planctl_op: "epic-create",
    planctl_target: "fn-1-foo",
    planctl_epic_id: "fn-1-foo",
    planctl_subject_present: 1,
  });
  // /plan:plan opener (PreToolUse:Skill) — opens the window for the planctl
  // event above to be classified as a creator edge.
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Skill",
    skill_name: "plan:plan",
  });
  // An Agent subagent invocation (fn-600 projection).
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-C",
    agent_type: "Explore",
    ts: 30.0,
  });
  insertEvent({
    hook_event: "SubagentStop",
    agent_id: "agent-C",
    ts: 31.0,
  });
  drainAll();

  // Both projections populated.
  const subagentBefore = db
    .query(
      `SELECT * FROM subagent_invocations ORDER BY job_id, agent_id, turn_seq`,
    )
    .all();
  const jobsBefore = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  const epicsBefore = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  expect(subagentBefore.length).toBeGreaterThan(0);
  expect(jobsBefore.length).toBeGreaterThan(0);

  // Re-fold from scratch — both projections reproduce byte-identically.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  db.run("DELETE FROM subagent_invocations");
  drainAll();
  const subagentAfter = db
    .query(
      `SELECT * FROM subagent_invocations ORDER BY job_id, agent_id, turn_seq`,
    )
    .all();
  const jobsAfter = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  const epicsAfter = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  expect(subagentAfter).toEqual(subagentBefore);
  expect(jobsAfter).toEqual(jobsBefore);
  expect(epicsAfter).toEqual(epicsBefore);
});

// ---------------------------------------------------------------------------
// config_dir capture (schema v22) — SessionStart fold + COALESCE on resume
// ---------------------------------------------------------------------------

test("SessionStart seeds jobs.config_dir from events.config_dir", () => {
  insertEvent({
    hook_event: "SessionStart",
    config_dir: "/Users/x/.claude-profiles/profile-a",
  });
  drainAll();
  const row = db
    .query("SELECT config_dir FROM jobs WHERE job_id = ?")
    .get("sess-a") as { config_dir: string | null };
  expect(row.config_dir).toBe("/Users/x/.claude-profiles/profile-a");
});

test("SessionStart with NULL config_dir leaves jobs.config_dir NULL (zero-event reading)", () => {
  insertEvent({ hook_event: "SessionStart", config_dir: null });
  drainAll();
  const row = db
    .query("SELECT config_dir FROM jobs WHERE job_id = ?")
    .get("sess-a") as { config_dir: string | null };
  expect(row.config_dir).toBeNull();
});

test("resume SessionStart with NULL config_dir preserves prior non-NULL via COALESCE", () => {
  // The locked design: a second SessionStart on the same session_id that
  // captures NULL (e.g. resume launched without the env var) must NOT
  // clobber the prior non-NULL value. The reducer's ON CONFLICT SET clause
  // wraps the column in `COALESCE(excluded.config_dir, jobs.config_dir)`
  // exactly for this case.
  insertEvent({
    hook_event: "SessionStart",
    config_dir: "/Users/x/.claude-profiles/profile-a",
  });
  drainAll();
  expect(
    (
      db
        .query("SELECT config_dir FROM jobs WHERE job_id = ?")
        .get("sess-a") as {
        config_dir: string | null;
      }
    ).config_dir,
  ).toBe("/Users/x/.claude-profiles/profile-a");

  // Resume — same session_id, NULL config_dir. COALESCE keeps the prior value.
  insertEvent({ hook_event: "SessionStart", config_dir: null });
  drainAll();
  expect(
    (
      db
        .query("SELECT config_dir FROM jobs WHERE job_id = ?")
        .get("sess-a") as {
        config_dir: string | null;
      }
    ).config_dir,
  ).toBe("/Users/x/.claude-profiles/profile-a");
});

test("resume SessionStart with a fresh non-NULL config_dir overwrites the prior value", () => {
  // Latest-non-NULL-wins: COALESCE on excluded means a populated incoming
  // value DOES win (the column is not set-once like title — env attribution
  // tracks the most-recent SessionStart's profile).
  insertEvent({
    hook_event: "SessionStart",
    config_dir: "/Users/x/.claude-profiles/profile-a",
  });
  drainAll();
  insertEvent({
    hook_event: "SessionStart",
    config_dir: "/Users/x/.claude-profiles/profile-b",
  });
  drainAll();
  const row = db
    .query("SELECT config_dir FROM jobs WHERE job_id = ?")
    .get("sess-a") as { config_dir: string | null };
  expect(row.config_dir).toBe("/Users/x/.claude-profiles/profile-b");
});

test("jobs.config_dir is byte-identical on rewind-and-redrain (re-fold determinism)", () => {
  // CLAUDE.md byte-identical re-fold invariant: a from-scratch re-fold of
  // the event log must reproduce jobs.config_dir exactly. Exercises the
  // SessionStart INSERT-side write AND the ON CONFLICT COALESCE branch.
  insertEvent({
    hook_event: "SessionStart",
    config_dir: "/Users/x/.claude-profiles/profile-a",
  });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({ hook_event: "Stop" });
  insertEvent({ hook_event: "SessionStart", config_dir: null }); // resume
  drainAll();
  const before = db.query("SELECT * FROM jobs WHERE job_id = ?").get("sess-a");
  expect(before).not.toBeNull();

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  const after = db.query("SELECT * FROM jobs WHERE job_id = ?").get("sess-a");
  expect(after).toEqual(before);
});

// ---------------------------------------------------------------------------
// InputRequest fold (schema v25, fn-617 task .1)
// ---------------------------------------------------------------------------

/**
 * Read just `state` + the input-request pair off a jobs row by id. Used by
 * the fn-617 task .1 tests to assert the paired-NULL invariant + the
 * terminal guard.
 */
function getInputRequestState(jobId: string): {
  state: string;
  last_input_request_at: number | null;
  last_input_request_kind: string | null;
} | null {
  return db
    .query(
      "SELECT state, last_input_request_at, last_input_request_kind FROM jobs WHERE job_id = ?",
    )
    .get(jobId) as {
    state: string;
    last_input_request_at: number | null;
    last_input_request_kind: string | null;
  } | null;
}

test("InputRequest fold: stamps both columns + flips state to 'stopped'", () => {
  // The keystone bullet of fn-617 task .1: a synthetic `InputRequest`
  // event minted from a transcript-worker `input-request` message flips
  // jobs.state to 'stopped' AND stamps `(last_input_request_at,
  // last_input_request_kind)` to the event ts + the matched kind in a
  // single compound UPDATE.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ir" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ir" });
  drainAll();
  const before = getInputRequestState("sess-ir");
  expect(before?.state).toBe("working");
  expect(before?.last_input_request_at).toBeNull();
  expect(before?.last_input_request_kind).toBeNull();

  insertEvent({
    hook_event: "InputRequest",
    session_id: "sess-ir",
    data: JSON.stringify({ kind: "ask_user_question" }),
  });
  drainAll();
  const after = getInputRequestState("sess-ir");
  expect(after?.state).toBe("stopped");
  expect(after?.last_input_request_at).not.toBeNull();
  expect(after?.last_input_request_kind).toBe("ask_user_question");
});

test("InputRequest on a session with a running subagent_invocations row still flips state to 'stopped' and stamps the (at, kind) pair", () => {
  // Mirror of test/reducer.test.ts:524 ("Stop is a no-op on state while a
  // sub-agent is running"), but for InputRequest — and with the OPPOSITE
  // assertion. Stop and ApiError both skip the state flip when a
  // subagent_invocations row is running (parent yielded to a Task, the
  // session is conceptually still working). InputRequest intentionally
  // omits that guard: a question to a human really blocks forward progress
  // regardless of who's asking — parent OR sub-agent — so the state must
  // flip to 'stopped' and the (last_input_request_at,
  // last_input_request_kind) pair must stamp. This test pins that
  // behavioral asymmetry so a future "consistency" edit that adds the
  // sub-agent guard to InputRequest gets caught.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ir-sub" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ir-sub" });
  insertEvent({
    hook_event: "SubagentStart",
    session_id: "sess-ir-sub",
    agent_id: "sub-ir",
    agent_type: "Explore",
  });
  drainAll();
  // Pre-state: session is 'working', sub-agent is running, pair is NULL.
  const before = getInputRequestState("sess-ir-sub");
  expect(before?.state).toBe("working");
  expect(before?.last_input_request_at).toBeNull();
  expect(before?.last_input_request_kind).toBeNull();

  insertEvent({
    hook_event: "InputRequest",
    session_id: "sess-ir-sub",
    data: JSON.stringify({ kind: "ask_user_question" }),
  });
  drainAll();
  // Post-state: state flipped to 'stopped' (opposite of Stop's no-op), pair
  // stamped — InputRequest does NOT consult the sub-agent guard.
  const after = getInputRequestState("sess-ir-sub");
  expect(after?.state).toBe("stopped");
  expect(after?.last_input_request_at).not.toBeNull();
  expect(after?.last_input_request_kind).toBe("ask_user_question");
});

test("InputRequest fold: terminal-row guard preserved — InputRequest on 'ended' / 'killed' row does NOT resurrect (both columns stay NULL)", () => {
  // Negative-coverage gate on the terminal guard cloned from the v24
  // RateLimited/ApiError arm. A stray late-arriving InputRequest on an
  // already-terminal row must NOT mid-life-stamp it.

  // 'ended' row.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ir-ended" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ir-ended" });
  insertEvent({ hook_event: "SessionEnd", session_id: "sess-ir-ended" });
  drainAll();
  insertEvent({
    hook_event: "InputRequest",
    session_id: "sess-ir-ended",
    data: JSON.stringify({ kind: "ask_user_question" }),
  });
  drainAll();
  const ended = getInputRequestState("sess-ir-ended");
  expect(ended?.state).toBe("ended");
  expect(ended?.last_input_request_at).toBeNull();
  expect(ended?.last_input_request_kind).toBeNull();

  // 'killed' row — hand-set lifecycle to test the SQL predicate directly
  // (mirrors the v24 ApiError terminal-guard test shape).
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ir-killed" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ir-killed" });
  drainAll();
  db.run("UPDATE jobs SET state = 'killed' WHERE job_id = 'sess-ir-killed'");
  insertEvent({
    hook_event: "InputRequest",
    session_id: "sess-ir-killed",
    data: JSON.stringify({ kind: "ask_user_question" }),
  });
  drainAll();
  const killed = getInputRequestState("sess-ir-killed");
  expect(killed?.state).toBe("killed");
  expect(killed?.last_input_request_at).toBeNull();
  expect(killed?.last_input_request_kind).toBeNull();
});

test("InputRequest fold: data.kind outside the canonical allow-list folds to 'ask_user_question'", () => {
  // Single-member union sanity gate. Unlike `ApiErrorKind`, there is no
  // reserved `"unknown"` fallback — every unrecognized value folds to
  // the only member, `"ask_user_question"`. The matcher is expected to
  // only emit `input-request` messages for kinds it has explicitly
  // mapped, but the reducer must still be defensive (malformed blob /
  // unknown-string / missing-kind) to satisfy the never-throw-inside-
  // fold invariant.
  for (const [variant, payload] of [
    ["garbage-string", { kind: "not-a-real-kind" }],
    ["non-string", { kind: 42 }],
    ["missing", {}],
  ] as const) {
    const sessionId = `sess-ir-${variant}`;
    insertEvent({ hook_event: "SessionStart", session_id: sessionId });
    insertEvent({ hook_event: "UserPromptSubmit", session_id: sessionId });
    insertEvent({
      hook_event: "InputRequest",
      session_id: sessionId,
      data: JSON.stringify(payload),
    });
  }
  drainAll();
  for (const variant of ["garbage-string", "non-string", "missing"]) {
    const row = getInputRequestState(`sess-ir-${variant}`);
    expect(row?.state).toBe("stopped");
    expect(row?.last_input_request_kind).toBe("ask_user_question");
    expect(row?.last_input_request_at).not.toBeNull();
  }
});

test("InputRequest clear arms: UserPromptSubmit clears the pair (paired-NULL clear) and flips state to 'working'", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ir-ups" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ir-ups" });
  insertEvent({
    hook_event: "InputRequest",
    session_id: "sess-ir-ups",
    data: JSON.stringify({ kind: "ask_user_question" }),
  });
  drainAll();
  const blocked = getInputRequestState("sess-ir-ups");
  expect(blocked?.state).toBe("stopped");
  expect(blocked?.last_input_request_at).not.toBeNull();
  expect(blocked?.last_input_request_kind).toBe("ask_user_question");

  // The human answers — UserPromptSubmit unconditionally clears BOTH
  // columns of the pair (paired-NULL invariant) and flips state to
  // 'working'.
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ir-ups" });
  drainAll();
  const revived = getInputRequestState("sess-ir-ups");
  expect(revived?.state).toBe("working");
  expect(revived?.last_input_request_at).toBeNull();
  expect(revived?.last_input_request_kind).toBeNull();
});

test("InputRequest clear arms: SessionStart resume clears the pair (paired-NULL clear)", () => {
  // Set up a blocked row, then drive a resume via a duplicate SessionStart.
  // The ON CONFLICT branch is what fires on resume; that's the v25-extended
  // clear path.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ir-ss" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ir-ss" });
  insertEvent({
    hook_event: "InputRequest",
    session_id: "sess-ir-ss",
    data: JSON.stringify({ kind: "ask_user_question" }),
  });
  drainAll();
  const blocked = getInputRequestState("sess-ir-ss");
  expect(blocked?.last_input_request_at).not.toBeNull();
  expect(blocked?.last_input_request_kind).toBe("ask_user_question");

  // Duplicate SessionStart — resume. The ON CONFLICT branch unconditionally
  // clears the input-request pair (paired-NULL invariant); the rest of the
  // ON CONFLICT semantics (terminal→stopped, pid/start_time COALESCE) are
  // unaffected.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ir-ss" });
  drainAll();
  const resumed = getInputRequestState("sess-ir-ss");
  expect(resumed?.last_input_request_at).toBeNull();
  expect(resumed?.last_input_request_kind).toBeNull();
});

test("InputRequest clear arms: PreToolUse + PostToolUse clear the pair (gated on IS NOT NULL)", () => {
  // The hot-path clear arms: AskUserQuestion fires no hook of its own, so
  // the closest "answered" signal is the next tool the agent uses. The
  // gate on `last_input_request_at IS NOT NULL` keeps the cost at zero
  // for the overwhelming majority of tool calls — without the gate, every
  // tool call in every session would no-op-write the pair to NULL.

  // PreToolUse arm: blocked → PreToolUse clears.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ir-pre" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ir-pre" });
  insertEvent({
    hook_event: "InputRequest",
    session_id: "sess-ir-pre",
    data: JSON.stringify({ kind: "ask_user_question" }),
  });
  drainAll();
  expect(
    getInputRequestState("sess-ir-pre")?.last_input_request_at,
  ).not.toBeNull();
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Bash",
    session_id: "sess-ir-pre",
  });
  drainAll();
  expect(getInputRequestState("sess-ir-pre")?.last_input_request_at).toBeNull();
  expect(
    getInputRequestState("sess-ir-pre")?.last_input_request_kind,
  ).toBeNull();

  // PostToolUse arm: blocked → PostToolUse clears.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ir-post" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ir-post" });
  insertEvent({
    hook_event: "InputRequest",
    session_id: "sess-ir-post",
    data: JSON.stringify({ kind: "ask_user_question" }),
  });
  drainAll();
  expect(
    getInputRequestState("sess-ir-post")?.last_input_request_at,
  ).not.toBeNull();
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-ir-post",
  });
  drainAll();
  expect(
    getInputRequestState("sess-ir-post")?.last_input_request_at,
  ).toBeNull();
  expect(
    getInputRequestState("sess-ir-post")?.last_input_request_kind,
  ).toBeNull();
});

test("InputRequest clear gate: PreToolUse/PostToolUse on a session with last_input_request_at IS NULL does NOT touch jobs (no last_event_id bump)", () => {
  // Hot-path no-op gate: without the `IS NOT NULL` predicate, every tool
  // call in every session would no-op-write the pair (already NULL),
  // bumping last_event_id + updated_at and re-fanning embedded arrays.
  // Pin the gate by asserting `last_event_id` does NOT advance past the
  // pre-tool-call snapshot when there's no annotation to clear.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ir-gate" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ir-gate" });
  drainAll();
  const before = db
    .query("SELECT last_event_id FROM jobs WHERE job_id = ?")
    .get("sess-ir-gate") as { last_event_id: number };
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Bash",
    session_id: "sess-ir-gate",
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-ir-gate",
  });
  drainAll();
  const after = db
    .query("SELECT last_event_id FROM jobs WHERE job_id = ?")
    .get("sess-ir-gate") as { last_event_id: number };
  // No clear-arm UPDATE fired, so jobs.last_event_id stayed at the
  // UserPromptSubmit event id. (PreToolUse / PostToolUse have no other
  // jobs-write path on this session — no plan_ref, no planctl_op.)
  expect(after.last_event_id).toBe(before.last_event_id);
});

test("InputRequest re-fold determinism: rewind-and-redrain reproduces byte-identical jobs row", () => {
  // CLAUDE.md byte-identical re-fold invariant: a from-scratch re-fold of
  // the event log must reproduce jobs row byte-for-byte. Exercises the
  // InputRequest stamp + a clear arm (UserPromptSubmit).
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ir-redrain" });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-ir-redrain",
  });
  insertEvent({
    hook_event: "InputRequest",
    session_id: "sess-ir-redrain",
    data: JSON.stringify({ kind: "ask_user_question" }),
  });
  // Then a fresh prompt clears the pair — exercises both the stamp arm
  // and the unconditional UPS clear arm on re-fold.
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-ir-redrain",
  });
  drainAll();
  const before = db
    .query("SELECT * FROM jobs WHERE job_id = ?")
    .get("sess-ir-redrain");
  expect(before).not.toBeNull();

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  const after = db
    .query("SELECT * FROM jobs WHERE job_id = ?")
    .get("sess-ir-redrain");
  expect(after).toEqual(before);
});

test("syncJobLinksOnJobWrite: InputRequest stamp propagates to epics.job_links; UPS revival clears it", () => {
  // Mirrors the v24 RateLimited link-fan-out test shape: a session linked
  // to an epic gets blocked → the reverse fan-out propagates the
  // input-request pair into the linked epic's `epics.job_links[]` entry;
  // a fresh UserPromptSubmit revives → the reverse fan-out propagates
  // the paired clear back into the link entry.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ir-link" });
  planPlanOpener("sess-ir-link");
  planctlEvent({
    sessionId: "sess-ir-link",
    op: "epic-create",
    target: "fn-15-ir",
    epicId: "fn-15-ir",
    subjectPresent: true,
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ir-link" });
  drainAll();
  // Initial: both fields NULL on the link entry.
  expect(getJobLinks("fn-15-ir")[0]?.last_input_request_at).toBeNull();
  expect(getJobLinks("fn-15-ir")[0]?.last_input_request_kind).toBeNull();

  insertEvent({
    hook_event: "InputRequest",
    session_id: "sess-ir-link",
    data: JSON.stringify({ kind: "ask_user_question" }),
  });
  drainAll();
  const blocked = getJobLinks("fn-15-ir")[0];
  expect(blocked?.state).toBe("stopped");
  expect(blocked?.last_input_request_at).not.toBeNull();
  expect(blocked?.last_input_request_kind).toBe("ask_user_question");

  // Revival via UserPromptSubmit — reverse fan-out propagates the paired
  // clear to the embedded entry.
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ir-link" });
  drainAll();
  const revived = getJobLinks("fn-15-ir")[0];
  expect(revived?.state).toBe("working");
  expect(revived?.last_input_request_at).toBeNull();
  expect(revived?.last_input_request_kind).toBeNull();
});

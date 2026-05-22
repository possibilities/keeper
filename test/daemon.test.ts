/**
 * Daemon boot-drain test. Verifies the catch-up path independent of the wake
 * mechanism: pre-seed the `events` table, then drive `drainToCompletion`
 * directly against a tmp DB (no Worker spawned — `daemon.ts` is import-safe
 * behind its `import.meta.main` guard). The full wake-worker → reducer
 * round-trip is covered by the end-to-end integration test.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainToCompletion } from "../src/daemon";
import { openDb } from "../src/db";
import { drain } from "../src/reducer";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-daemon-test-"));
  dbPath = join(tmpDir, "keeper.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedEvent(
  db: ReturnType<typeof openDb>["db"],
  sessionId: string,
  hookEvent: string,
  ts: number,
  permissionMode: string | null = null,
): void {
  db.run(
    `INSERT INTO events (ts, session_id, pid, hook_event, event_type, permission_mode, data)
       VALUES (?, ?, ?, ?, 'lifecycle', ?, '{}')`,
    [ts, sessionId, 4242, hookEvent, permissionMode],
  );
}

test("boot drain folds a pre-seeded events table to completion", () => {
  const { db } = openDb(dbPath);

  // Pre-seed a full session lifecycle as if events accumulated during downtime.
  seedEvent(db, "sess-a", "SessionStart", 1);
  seedEvent(db, "sess-a", "UserPromptSubmit", 2, "plan");
  seedEvent(db, "sess-a", "Stop", 3);
  seedEvent(db, "sess-b", "SessionStart", 4);
  seedEvent(db, "sess-b", "SessionEnd", 5);

  // Cursor starts at 0 (fresh DB) — nothing folded yet.
  const before = db
    .query("SELECT last_event_id FROM reducer_state WHERE id = 1")
    .get() as { last_event_id: number };
  expect(before.last_event_id).toBe(0);

  drainToCompletion(db);

  // Cursor advanced past every seeded event.
  const after = db
    .query("SELECT last_event_id FROM reducer_state WHERE id = 1")
    .get() as { last_event_id: number };
  expect(after.last_event_id).toBe(5);

  // Projection reflects the folded lifecycle.
  const jobA = db
    .query("SELECT state FROM jobs WHERE job_id = 'sess-a'")
    .get() as { state: string };
  expect(jobA.state).toBe("stopped");

  const jobB = db
    .query("SELECT state FROM jobs WHERE job_id = 'sess-b'")
    .get() as { state: string };
  expect(jobB.state).toBe("ended");

  db.close();
});

test("boot drain is idempotent — a second pass folds nothing", () => {
  const { db } = openDb(dbPath);
  seedEvent(db, "sess-a", "SessionStart", 1);
  seedEvent(db, "sess-a", "Stop", 2);

  drainToCompletion(db);
  const firstCursor = (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;

  // A second drain over an unchanged events table must fold zero new events.
  expect(drain(db)).toBe(0);
  drainToCompletion(db);
  const secondCursor = (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;

  expect(secondCursor).toBe(firstCursor);
  db.close();
});

test("boot drain spanning multiple batches catches up every event", () => {
  const { db } = openDb(dbPath);

  // More events than a single small batch, to exercise the drain loop.
  const total = 25;
  for (let i = 1; i <= total; i += 1) {
    seedEvent(db, `sess-${i}`, "SessionStart", i);
  }

  // Drive drain with a batch size smaller than the backlog so the loop must
  // iterate — same code path boot uses, just a tighter batch.
  while (drain(db, 10) > 0) {
    // keep folding
  }

  const cursor = (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;
  expect(cursor).toBe(total);

  const jobCount = (
    db.query("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }
  ).n;
  expect(jobCount).toBe(total);

  db.close();
});

/**
 * The plan-worker → main path: a `plan-epic`/`plan-task` snapshot message
 * becomes a synthetic `EpicSnapshot`/`TaskSnapshot` events row that main inserts
 * on its writable connection (entity id in `session_id`, the snapshot in
 * `data`), then folds. This mirrors exactly what `runDaemon`'s
 * `planWorker.onmessage` branch does (insert via the same positional column
 * order, then pump a drain) — driven directly here so no Worker is spawned.
 */
function insertPlanSnapshot(
  stmts: ReturnType<typeof openDb>["stmts"],
  hookEvent: "EpicSnapshot" | "TaskSnapshot",
  entityId: string,
  ts: number,
  data: Record<string, unknown>,
): void {
  stmts.insertEvent.run(
    ts, // ts
    entityId, // session_id (the entity pk)
    null, // pid
    hookEvent, // hook_event
    "plan_snapshot", // event_type
    null, // tool_name
    null, // matcher
    null, // cwd
    null, // permission_mode
    null, // agent_id
    null, // agent_type
    null, // stop_hook_active
    JSON.stringify(data), // data (the full snapshot blob)
    null, // subagent_agent_id
    null, // spawn_name
  );
}

test("synthetic EpicSnapshot/TaskSnapshot events fold into epics/tasks", () => {
  const { db, stmts } = openDb(dbPath);

  insertPlanSnapshot(stmts, "EpicSnapshot", "fn-7-add-oauth", 1, {
    epic_number: 7,
    title: "Add OAuth",
    project_dir: "/Users/mike/code/keeper",
    status: "in_progress",
  });
  insertPlanSnapshot(stmts, "TaskSnapshot", "fn-7-add-oauth.2", 2, {
    epic_id: "fn-7-add-oauth",
    task_number: 2,
    title: "Wire the callback",
    target_repo: "/Users/mike/code/keeper",
    status: "open",
  });

  drainToCompletion(db);

  // Cursor advanced past both synthetic events.
  const cursor = (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;
  expect(cursor).toBe(2);

  const epic = db
    .query(
      "SELECT epic_number, title, project_dir, status, last_event_id FROM epics WHERE epic_id = 'fn-7-add-oauth'",
    )
    .get() as {
    epic_number: number;
    title: string;
    project_dir: string;
    status: string;
    last_event_id: number;
  };
  expect(epic.epic_number).toBe(7);
  expect(epic.title).toBe("Add OAuth");
  expect(epic.project_dir).toBe("/Users/mike/code/keeper");
  expect(epic.status).toBe("in_progress");
  expect(epic.last_event_id).toBe(1);

  const task = db
    .query(
      "SELECT epic_id, task_number, title, target_repo, status, last_event_id FROM tasks WHERE task_id = 'fn-7-add-oauth.2'",
    )
    .get() as {
    epic_id: string;
    task_number: number;
    title: string;
    target_repo: string;
    status: string;
    last_event_id: number;
  };
  expect(task.epic_id).toBe("fn-7-add-oauth");
  expect(task.task_number).toBe(2);
  expect(task.title).toBe("Wire the callback");
  expect(task.target_repo).toBe("/Users/mike/code/keeper");
  expect(task.status).toBe("open");
  expect(task.last_event_id).toBe(2);

  db.close();
});

test("a re-arrived EpicSnapshot upserts last-write-wins with monotonic last_event_id", () => {
  const { db, stmts } = openDb(dbPath);

  insertPlanSnapshot(stmts, "EpicSnapshot", "fn-7-add-oauth", 1, {
    epic_number: 7,
    title: "Add OAuth",
    project_dir: "/Users/mike/code/keeper",
    status: "open",
  });
  drainToCompletion(db);

  // A later snapshot for the same epic (status moved on disk) upserts in place.
  insertPlanSnapshot(stmts, "EpicSnapshot", "fn-7-add-oauth", 2, {
    epic_number: 7,
    title: "Add OAuth",
    project_dir: "/Users/mike/code/keeper",
    status: "done",
  });
  drainToCompletion(db);

  const rows = db
    .query(
      "SELECT status, last_event_id FROM epics WHERE epic_id = 'fn-7-add-oauth'",
    )
    .all() as { status: string; last_event_id: number }[];
  // One row (idempotent upsert), the newer snapshot won, version advanced.
  expect(rows.length).toBe(1);
  expect(rows[0].status).toBe("done");
  expect(rows[0].last_event_id).toBe(2);

  db.close();
});

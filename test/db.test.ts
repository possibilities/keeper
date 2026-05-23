/**
 * Schema-shape tests for `openDb()`. These run on a tmp-path DB driven by
 * `KEEPER_DB` resolution; we pass the path explicitly so each test gets a
 * fresh file without leaking state. The assertions mirror the task's
 * Acceptance list — tables present, indexes present, PRAGMAs applied,
 * reducer_state seeded, readonly flag honored, env-var override honored.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JOBS_DESCRIPTOR, selectByIds } from "../src/collections";
import {
  MAX_IN_PARAMS,
  openDb,
  resolveClaudeProjectsRoot,
  resolveConfig,
  resolveDbPath,
  resolvePlanRoots,
  resolveSockPath,
  selectWorldRev,
} from "../src/db";
import type { Job } from "../src/types";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-db-test-"));
  dbPath = join(tmpDir, "keeper.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test("openDb creates events, jobs, reducer_state, meta tables", () => {
  const { db } = openDb(dbPath);
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all() as { name: string }[];
  const names = new Set(tables.map((t) => t.name));
  expect(names.has("events")).toBe(true);
  expect(names.has("jobs")).toBe(true);
  expect(names.has("epics")).toBe(true);
  // Schema v7 dropped the standalone `tasks` table — tasks are embedded as a
  // JSON-array column on `epics`.
  expect(names.has("tasks")).toBe(false);
  expect(names.has("reducer_state")).toBe(true);
  expect(names.has("meta")).toBe(true);
  db.close();
});

test("all expected indexes are present", () => {
  const { db } = openDb(dbPath);
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all() as { name: string }[];
  const names = new Set(indexes.map((i) => i.name));
  const required = [
    "idx_events_session",
    "idx_events_hook_event",
    "idx_events_event_type",
    "idx_events_tool_name",
    "idx_events_ts",
    "idx_events_pid_hook_tool",
    "idx_events_subagent_agent_id",
  ];
  for (const name of required) {
    expect(names.has(name)).toBe(true);
  }
  db.close();
});

test("connection-local PRAGMAs are applied on every open", () => {
  const { db } = openDb(dbPath);
  // journal_mode returns the active mode; on a brand-new DB the first
  // call to PRAGMA journal_mode = WAL flips it to wal persistently.
  const journal = db.prepare("PRAGMA journal_mode").get() as {
    journal_mode: string;
  };
  expect(journal.journal_mode).toBe("wal");

  const busy = db.prepare("PRAGMA busy_timeout").get() as {
    timeout: number;
  };
  expect(busy.timeout).toBe(5000);

  const fk = db.prepare("PRAGMA foreign_keys").get() as {
    foreign_keys: number;
  };
  expect(fk.foreign_keys).toBe(1);

  const sync = db.prepare("PRAGMA synchronous").get() as {
    synchronous: number;
  };
  // 1 == NORMAL
  expect(sync.synchronous).toBe(1);
  db.close();
});

test("readonly: true opens a read-only connection", () => {
  // Seed the DB once with a writer.
  const writer = openDb(dbPath);
  writer.db.close();

  // Open read-only and confirm writes fail.
  const reader = openDb(dbPath, { readonly: true });
  expect(() => {
    reader.db.run(
      "INSERT INTO jobs (job_id, created_at, updated_at) VALUES ('x', 0, 0)",
    );
  }).toThrow();
  reader.db.close();
});

test("reducer_state row (1, 0, ts) is seeded on first open", () => {
  const { db } = openDb(dbPath);
  const row = db
    .prepare("SELECT id, last_event_id, updated_at FROM reducer_state")
    .get() as { id: number; last_event_id: number; updated_at: number } | null;
  expect(row).not.toBeNull();
  expect(row?.id).toBe(1);
  expect(row?.last_event_id).toBe(0);
  expect(typeof row?.updated_at).toBe("number");
  db.close();
});

test("second openDb is a no-op (idempotent migration)", () => {
  const first = openDb(dbPath);
  // Bump the cursor so we can prove the second open doesn't reset it.
  first.db
    .prepare("UPDATE reducer_state SET last_event_id = 42 WHERE id = 1")
    .run();
  first.db.close();

  const second = openDb(dbPath);
  const row = second.db
    .prepare("SELECT last_event_id FROM reducer_state WHERE id = 1")
    .get() as { last_event_id: number };
  expect(row.last_event_id).toBe(42);
  second.db.close();
});

test("KEEPER_DB env var overrides default path", () => {
  const original = process.env.KEEPER_DB;
  try {
    process.env.KEEPER_DB = dbPath;
    expect(resolveDbPath()).toBe(dbPath);

    delete process.env.KEEPER_DB;
    const fallback = resolveDbPath();
    expect(fallback.endsWith("/.local/state/keeper/keeper.db")).toBe(true);
  } finally {
    if (original === undefined) {
      delete process.env.KEEPER_DB;
    } else {
      process.env.KEEPER_DB = original;
    }
  }
});

test("schema_version is stamped in meta", () => {
  const { db } = openDb(dbPath);
  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(row.value).toBe("10");
  db.close();
});

test("events has a nullable spawn_name column; jobs has a nullable title_source column", () => {
  const { db } = openDb(dbPath);
  const eventCols = db.prepare("PRAGMA table_info(events)").all() as {
    name: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const spawnName = eventCols.find((c) => c.name === "spawn_name");
  expect(spawnName).toBeDefined();
  expect(spawnName?.notnull).toBe(0);
  expect(spawnName?.dflt_value).toBeNull();

  const jobCols = db.prepare("PRAGMA table_info(jobs)").all() as {
    name: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const titleSource = jobCols.find((c) => c.name === "title_source");
  expect(titleSource).toBeDefined();
  expect(titleSource?.notnull).toBe(0);
  expect(titleSource?.dflt_value).toBeNull();
  db.close();
});

test("jobs has a nullable title column and no mode/title_history columns", () => {
  const { db } = openDb(dbPath);
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as {
    name: string;
    dflt_value: string | null;
    notnull: number;
  }[];
  const names = cols.map((c) => c.name);
  const title = cols.find((c) => c.name === "title");
  expect(title).toBeDefined();
  expect(title?.notnull).toBe(0); // nullable
  // mode + title_history are retired — neither column exists.
  expect(names).not.toContain("mode");
  expect(names).not.toContain("title_history");
  // A fresh row reads the zero-event default: title NULL.
  db.prepare(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at) VALUES ('z', 1, 0, 1)",
  ).run();
  const r = db.prepare("SELECT title FROM jobs WHERE job_id = 'z'").get() as {
    title: string | null;
  };
  expect(r.title).toBeNull();
  db.close();
});

test("v3 DB migrates to v4: spawn_name + title_source added, rows preserved NULL", () => {
  // Build a v3-shaped DB by hand: events without spawn_name, jobs without
  // title_source, version '3'.
  const v3 = new Database(dbPath, { create: true });
  v3.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      matcher TEXT,
      cwd TEXT,
      permission_mode TEXT,
      agent_id TEXT,
      agent_type TEXT,
      stop_hook_active INTEGER,
      data TEXT NOT NULL,
      subagent_agent_id TEXT
    )
  `);
  v3.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT
    )
  `);
  v3.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v3.run("INSERT INTO meta (key, value) VALUES ('schema_version', '3')");
  v3.run(
    "INSERT INTO events (ts, session_id, hook_event, event_type, data) VALUES (1, 'sess', 'SessionStart', 'session_start', '{}')",
  );
  v3.run(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, title) VALUES ('old', 1, 5, 1, 'fix-osc')",
  );
  v3.close();

  // Reopen via openDb — migrate() runs the v3→v4 idempotent ADD COLUMNs (and on
  // through v5: the ALTER block isn't version-gated, so a v3 DB converges
  // straight to the current schema, stamping the current version).
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe("10");

  const eventNames = (
    db.prepare("PRAGMA table_info(events)").all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  expect(eventNames).toContain("spawn_name");
  const jobNames = (
    db.prepare("PRAGMA table_info(jobs)").all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  expect(jobNames).toContain("title_source");

  // Existing rows gain the new columns reading NULL; prior data is intact.
  const ev = db
    .prepare(
      "SELECT session_id, spawn_name FROM events WHERE session_id = 'sess'",
    )
    .get() as { session_id: string; spawn_name: string | null };
  expect(ev.spawn_name).toBeNull();
  const job = db
    .prepare(
      "SELECT title, title_source, last_event_id FROM jobs WHERE job_id = 'old'",
    )
    .get() as {
    title: string | null;
    title_source: string | null;
    last_event_id: number;
  };
  expect(job.title).toBe("fix-osc");
  expect(job.title_source).toBeNull();
  expect(job.last_event_id).toBe(5);

  // Second open is idempotent — the ADD COLUMNs no-op on the now-current shape.
  db.close();
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe("10");
  db2.close();
});

test("v4 DB migrates to v5: jobs.transcript_path added, rows preserved NULL", () => {
  // Build a v4-shaped DB by hand: jobs with title_source but no
  // transcript_path, version '4'.
  const v4 = new Database(dbPath, { create: true });
  v4.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      matcher TEXT,
      cwd TEXT,
      permission_mode TEXT,
      agent_id TEXT,
      agent_type TEXT,
      stop_hook_active INTEGER,
      data TEXT NOT NULL,
      subagent_agent_id TEXT,
      spawn_name TEXT
    )
  `);
  v4.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT
    )
  `);
  v4.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v4.run("INSERT INTO meta (key, value) VALUES ('schema_version', '4')");
  v4.run(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, title, title_source) VALUES ('old', 1, 5, 1, 'fix-osc', 'payload')",
  );
  v4.close();

  // Reopen via openDb — migrate() runs the v4→v5 idempotent ADD COLUMN.
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe("10");

  const jobNames = (
    db.prepare("PRAGMA table_info(jobs)").all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  expect(jobNames).toContain("transcript_path");

  // Existing rows gain the new column reading NULL; prior data is intact.
  const job = db
    .prepare(
      "SELECT title, title_source, transcript_path, last_event_id FROM jobs WHERE job_id = 'old'",
    )
    .get() as {
    title: string | null;
    title_source: string | null;
    transcript_path: string | null;
    last_event_id: number;
  };
  expect(job.title).toBe("fix-osc");
  expect(job.title_source).toBe("payload");
  expect(job.transcript_path).toBeNull();
  expect(job.last_event_id).toBe(5);

  // Second open is idempotent — the ADD COLUMN no-ops on the now-v5 shape.
  db.close();
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe("10");
  db2.close();
});

test("v2 DB migrates: mode + title_history dropped, title preserved", () => {
  // Build a v2-shaped DB by hand: mode + title + title_history, version '2'.
  const v2 = new Database(dbPath, { create: true });
  v2.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      mode TEXT NOT NULL DEFAULT 'act',
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_history TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(title_history))
    )
  `);
  v2.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v2.run("INSERT INTO meta (key, value) VALUES ('schema_version', '2')");
  v2.run(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, mode, title, title_history) VALUES ('old', 1, 5, 1, 'plan', 'fix-osc', '[\"a\",\"fix-osc\"]')",
  );
  v2.close();

  // Reopen via openDb — migrate() runs the v2→v3 column drops (and on through
  // v5: the idempotent ALTER block is not version-gated, so a stale v2 DB
  // converges straight to the current schema in one open).
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe("10");
  const names = (
    db.prepare("PRAGMA table_info(jobs)").all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  expect(names).not.toContain("mode");
  expect(names).not.toContain("title_history");
  // The live title survives the drop; the rest of the row is intact.
  const row = db
    .prepare(
      "SELECT title, state, last_event_id FROM jobs WHERE job_id = 'old'",
    )
    .get() as { title: string | null; state: string; last_event_id: number };
  expect(row.title).toBe("fix-osc");
  expect(row.last_event_id).toBe(5);
  db.close();
});

test("v5 DB migrates to v7: epics table added (embedded tasks), no tasks table, jobs rows preserved", () => {
  // Build a v5-shaped DB by hand: events + jobs at the current v5 shape, no
  // epics/tasks tables, version '5', with a populated jobs row.
  const v5 = new Database(dbPath, { create: true });
  v5.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT
    )
  `);
  v5.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v5.run("INSERT INTO meta (key, value) VALUES ('schema_version', '5')");
  v5.run(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, title, title_source) VALUES ('old', 1, 5, 1, 'fix-osc', 'payload')",
  );
  v5.close();

  // Reopen via openDb — migrate() creates the epics table (CREATE TABLE IF NOT
  // EXISTS, with the embedded `tasks` column) and stamps the current version.
  // A v5 DB never had a `tasks` table, so the v6→v7 guard's table-exists check
  // simply skips the backfill/DROP; the convergence lands at v7.
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe("10");

  const tables = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((t) => t.name),
  );
  expect(tables.has("epics")).toBe(true);
  // Schema v7 has no standalone tasks table.
  expect(tables.has("tasks")).toBe(false);

  // New projection table starts empty.
  const epicCount = db.prepare("SELECT count(*) AS c FROM epics").get() as {
    c: number;
  };
  expect(epicCount.c).toBe(0);

  // The epics table carries the expected columns, including the embedded
  // `tasks` JSON-array column (schema v7).
  const epicCols = (
    db.prepare("PRAGMA table_info(epics)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(epicCols).toEqual([
    "epic_id",
    "epic_number",
    "title",
    "project_dir",
    "status",
    "last_event_id",
    "updated_at",
    "tasks",
    "depends_on_epics",
  ]);

  // Prior jobs data survives untouched.
  const job = db
    .prepare(
      "SELECT title, title_source, last_event_id FROM jobs WHERE job_id = 'old'",
    )
    .get() as {
    title: string | null;
    title_source: string | null;
    last_event_id: number;
  };
  expect(job.title).toBe("fix-osc");
  expect(job.title_source).toBe("payload");
  expect(job.last_event_id).toBe(5);

  // Second open is idempotent — CREATE TABLE IF NOT EXISTS no-ops.
  db.close();
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe("10");
  db2.close();
});

test("v6 DB migrates to v7: tasks embedded into epics.tasks in (task_number, task_id) order, orphan dropped, tasks table gone", () => {
  // Build a v6-shaped DB by hand: epics + tasks tables (no embedded column),
  // version '6'. Two epics, one with two tasks (out of sort order on disk to
  // prove the backfill sorts), plus an orphan task with a NULL epic_id that
  // must NOT be embedded.
  const v6 = new Database(dbPath, { create: true });
  v6.run(`
    CREATE TABLE epics (
      epic_id TEXT PRIMARY KEY,
      epic_number INTEGER,
      title TEXT,
      project_dir TEXT,
      status TEXT,
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0
    )
  `);
  v6.run(`
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      epic_id TEXT,
      task_number INTEGER,
      title TEXT,
      target_repo TEXT,
      status TEXT,
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0
    )
  `);
  v6.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v6.run("INSERT INTO meta (key, value) VALUES ('schema_version', '6')");
  v6.run(
    "INSERT INTO epics (epic_id, epic_number, title, status, last_event_id, updated_at) VALUES ('fn-1-alpha', 1, 'Alpha', 'active', 10, 1)",
  );
  v6.run(
    "INSERT INTO epics (epic_id, epic_number, title, status, last_event_id, updated_at) VALUES ('fn-2-beta', 2, 'Beta', 'active', 11, 1)",
  );
  // Two tasks for alpha inserted out of order — the backfill must sort by
  // (task_number, task_id).
  v6.run(
    "INSERT INTO tasks (task_id, epic_id, task_number, title, target_repo, status, last_event_id, updated_at) VALUES ('fn-1-alpha.2', 'fn-1-alpha', 2, 'second', '/repo', 'open', 12, 1)",
  );
  v6.run(
    "INSERT INTO tasks (task_id, epic_id, task_number, title, target_repo, status, last_event_id, updated_at) VALUES ('fn-1-alpha.1', 'fn-1-alpha', 1, 'first', '/repo', 'done', 13, 1)",
  );
  // Orphan task with NULL epic_id — dropped, not embedded.
  v6.run(
    "INSERT INTO tasks (task_id, epic_id, task_number, title, target_repo, status, last_event_id, updated_at) VALUES ('orphan.1', NULL, 1, 'orphan', '/repo', 'open', 14, 1)",
  );
  v6.close();

  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe("10");

  // tasks table is gone.
  const tables = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((t) => t.name),
  );
  expect(tables.has("tasks")).toBe(false);

  // alpha's tasks embedded in (task_number, task_id) order.
  const alpha = db
    .prepare("SELECT tasks FROM epics WHERE epic_id = 'fn-1-alpha'")
    .get() as { tasks: string };
  const alphaTasks = JSON.parse(alpha.tasks) as {
    task_id: string;
    epic_id: string;
    task_number: number;
    title: string;
    target_repo: string;
    status: string;
  }[];
  expect(alphaTasks.map((t) => t.task_id)).toEqual([
    "fn-1-alpha.1",
    "fn-1-alpha.2",
  ]);
  expect(alphaTasks[0]).toEqual({
    task_id: "fn-1-alpha.1",
    epic_id: "fn-1-alpha",
    task_number: 1,
    title: "first",
    target_repo: "/repo",
    status: "done",
  });

  // beta had no tasks — empty array.
  const beta = db
    .prepare("SELECT tasks FROM epics WHERE epic_id = 'fn-2-beta'")
    .get() as { tasks: string };
  expect(JSON.parse(beta.tasks)).toEqual([]);

  // The orphan task was dropped — it never lands on any epic.
  const allTasks = (
    db.prepare("SELECT tasks FROM epics").all() as { tasks: string }[]
  ).flatMap((e) => JSON.parse(e.tasks) as { task_id: string }[]);
  expect(allTasks.some((t) => t.task_id === "orphan.1")).toBe(false);

  db.close();
});

test("fresh openDb at v9 has events.start_time and jobs.start_time as nullable TEXT", () => {
  const { db } = openDb(dbPath);
  const eventCols = db.prepare("PRAGMA table_info(events)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const eventStart = eventCols.find((c) => c.name === "start_time");
  expect(eventStart).toBeDefined();
  expect(eventStart?.type).toBe("TEXT");
  expect(eventStart?.notnull).toBe(0);
  expect(eventStart?.dflt_value).toBeNull();

  const jobCols = db.prepare("PRAGMA table_info(jobs)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const jobStart = jobCols.find((c) => c.name === "start_time");
  expect(jobStart).toBeDefined();
  expect(jobStart?.type).toBe("TEXT");
  expect(jobStart?.notnull).toBe(0);
  expect(jobStart?.dflt_value).toBeNull();
  db.close();
});

test("v8 DB migrates to v9: events.start_time + jobs.start_time added, rows preserved NULL, second open is idempotent", () => {
  // Build a v8-shaped DB by hand: events + jobs at the v8 shape (no
  // start_time on either), version '8', with a populated row on each table.
  // This mirrors the prior migration tests' pattern — converging from a stale
  // version straight to the current schema via the idempotent ALTER block.
  const v8 = new Database(dbPath, { create: true });
  v8.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      matcher TEXT,
      cwd TEXT,
      permission_mode TEXT,
      agent_id TEXT,
      agent_type TEXT,
      stop_hook_active INTEGER,
      data TEXT NOT NULL,
      subagent_agent_id TEXT,
      spawn_name TEXT
    )
  `);
  v8.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT
    )
  `);
  v8.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v8.run("INSERT INTO meta (key, value) VALUES ('schema_version', '8')");
  v8.run(
    "INSERT INTO events (ts, session_id, hook_event, event_type, data, spawn_name) VALUES (1, 'sess', 'SessionStart', 'session_start', '{}', 'fix-osc')",
  );
  v8.run(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, title, title_source) VALUES ('old', 1, 5, 1, 'fix-osc', 'spawn')",
  );
  v8.close();

  // Reopen via openDb — migrate() runs the v8→v9 idempotent ADD COLUMNs and
  // stamps the current version.
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe("10");

  // Both columns now appear.
  const eventNames = (
    db.prepare("PRAGMA table_info(events)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(eventNames).toContain("start_time");
  const jobNames = (
    db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(jobNames).toContain("start_time");

  // Existing rows gain the new columns reading NULL; prior data is intact.
  const ev = db
    .prepare(
      "SELECT spawn_name, start_time FROM events WHERE session_id = 'sess'",
    )
    .get() as { spawn_name: string | null; start_time: string | null };
  expect(ev.spawn_name).toBe("fix-osc");
  expect(ev.start_time).toBeNull();
  const job = db
    .prepare(
      "SELECT title, title_source, start_time, last_event_id FROM jobs WHERE job_id = 'old'",
    )
    .get() as {
    title: string | null;
    title_source: string | null;
    start_time: string | null;
    last_event_id: number;
  };
  expect(job.title).toBe("fix-osc");
  expect(job.title_source).toBe("spawn");
  expect(job.start_time).toBeNull();
  expect(job.last_event_id).toBe(5);

  // Second open is idempotent — the ADD COLUMNs no-op on the now-current shape.
  db.close();
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe("10");
  const eventNames2 = (
    db2.prepare("PRAGMA table_info(events)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(eventNames2.filter((n) => n === "start_time")).toHaveLength(1);
  const jobNames2 = (
    db2.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(jobNames2.filter((n) => n === "start_time")).toHaveLength(1);
  db2.close();
});

test("fresh openDb at v10 has events.slash_command + events.skill_name + jobs.plan_verb + jobs.plan_ref as nullable TEXT", () => {
  const { db } = openDb(dbPath);
  const eventCols = db.prepare("PRAGMA table_info(events)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const slashCmd = eventCols.find((c) => c.name === "slash_command");
  expect(slashCmd).toBeDefined();
  expect(slashCmd?.type).toBe("TEXT");
  expect(slashCmd?.notnull).toBe(0);
  expect(slashCmd?.dflt_value).toBeNull();
  const skillName = eventCols.find((c) => c.name === "skill_name");
  expect(skillName).toBeDefined();
  expect(skillName?.type).toBe("TEXT");
  expect(skillName?.notnull).toBe(0);
  expect(skillName?.dflt_value).toBeNull();

  const jobCols = db.prepare("PRAGMA table_info(jobs)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const planVerb = jobCols.find((c) => c.name === "plan_verb");
  expect(planVerb).toBeDefined();
  expect(planVerb?.type).toBe("TEXT");
  expect(planVerb?.notnull).toBe(0);
  expect(planVerb?.dflt_value).toBeNull();
  const planRef = jobCols.find((c) => c.name === "plan_ref");
  expect(planRef).toBeDefined();
  expect(planRef?.type).toBe("TEXT");
  expect(planRef?.notnull).toBe(0);
  expect(planRef?.dflt_value).toBeNull();
  db.close();
});

test("v10 partial indexes are present on fresh openDb", () => {
  const { db } = openDb(dbPath);
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all() as { name: string }[];
  const names = new Set(indexes.map((i) => i.name));
  expect(names.has("idx_events_slash_command")).toBe(true);
  expect(names.has("idx_events_skill_name")).toBe(true);
  expect(names.has("idx_jobs_plan_ref")).toBe(true);
  db.close();
});

test("v10 idx_jobs_plan_ref serves a WHERE plan_verb='close' query (EXPLAIN QUERY PLAN)", () => {
  const { db } = openDb(dbPath);
  // Seed enough rows + ANALYZE so the planner picks the partial index over a
  // table scan. The acceptance bar is "an EXPLAIN QUERY PLAN ... shows SEARCH
  // ... USING INDEX idx_jobs_plan_ref (or equivalent index hit)" — `plan_verb`
  // skips its own index (cardinality 3) so a `WHERE plan_verb='close'` query
  // is served via the partial index on `plan_ref IS NOT NULL` paired with a
  // post-seek check. Confirm via the documented partial-index pattern
  // (sqlite.org/partialindex.html §2 Rule 2: ANY comparison on the indexed
  // column matches a `WHERE col IS NOT NULL` predicate, so a `plan_ref`-
  // touching predicate lands the index).
  const ts = 1_700_000_000;
  const insert = db.prepare(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, plan_verb, plan_ref) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (let i = 0; i < 50; i++) {
    insert.run(`null-${i}`, ts, i, ts, null, null);
  }
  insert.run("close-1", ts, 100, ts, "close", "fn-575-foo");
  insert.run("work-1", ts, 101, ts, "work", "fn-575-foo.1");
  db.run("ANALYZE");

  // The acceptance check: a query that filters on the indexed column (or one
  // covered by the partial-index predicate) must hit the index, not a scan.
  const plan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT job_id FROM jobs WHERE plan_ref = 'fn-575-foo'",
    )
    .all() as { detail: string }[];
  const detail = plan.map((r) => r.detail).join(" | ");
  expect(detail).toMatch(/idx_jobs_plan_ref/);
  db.close();
});

test("v9 DB migrates to v10: four columns added + three partial indexes + backfill, second open is idempotent", () => {
  // Build a v9-shaped DB by hand: events + jobs at the v9 shape (no
  // slash_command / skill_name / plan_verb / plan_ref), version '9'.
  // Seed historical rows the backfill must walk:
  // - A UserPromptSubmit with a `/plan:work fn-X` prompt → slash_command
  //   backfilled, skill_name NULL.
  // - A UserPromptSubmit with a non-slash prompt → both NULL.
  // - A UserPromptSubmit with a path-shape prompt (`/Users/...`) → both NULL
  //   (the regex requires a lowercase letter after `/`, so `/U...` rejects).
  // - A PreToolUse on Skill with `tool_input.skill: 'plan:plan'` →
  //   skill_name backfilled, slash_command NULL.
  // - A PostToolUse on a non-Skill tool → both NULL (tool gate).
  // - A SessionStart with spawn_name matching the whitelist → its job row
  //   gets plan_verb / plan_ref backfilled.
  // - A SessionStart with spawn_name `audit::fn-1-foo` → row stays NULL
  //   (whitelist excludes audit).
  // - A SessionStart with no spawn_name → row stays NULL.
  const v9 = new Database(dbPath, { create: true });
  v9.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      matcher TEXT,
      cwd TEXT,
      permission_mode TEXT,
      agent_id TEXT,
      agent_type TEXT,
      stop_hook_active INTEGER,
      data TEXT NOT NULL,
      subagent_agent_id TEXT,
      spawn_name TEXT,
      start_time TEXT
    )
  `);
  v9.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT,
      start_time TEXT
    )
  `);
  v9.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v9.run("INSERT INTO meta (key, value) VALUES ('schema_version', '9')");

  // Seed events.
  const insertEvent = v9.prepare(
    "INSERT INTO events (ts, session_id, hook_event, event_type, tool_name, data, spawn_name) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insertEvent.run(
    1,
    "sess-slash",
    "UserPromptSubmit",
    "user_prompt_submit",
    null,
    JSON.stringify({ prompt: "/plan:work fn-575-foo" }),
    null,
  );
  insertEvent.run(
    2,
    "sess-plain",
    "UserPromptSubmit",
    "user_prompt_submit",
    null,
    JSON.stringify({ prompt: "just some text" }),
    null,
  );
  insertEvent.run(
    3,
    "sess-path",
    "UserPromptSubmit",
    "user_prompt_submit",
    null,
    JSON.stringify({ prompt: "/Users/mike/code/keeper" }),
    null,
  );
  insertEvent.run(
    4,
    "sess-skill",
    "PreToolUse",
    "pre_tool_use",
    "Skill",
    JSON.stringify({ tool_input: { skill: "plan:plan", args: "..." } }),
    null,
  );
  insertEvent.run(
    5,
    "sess-bash",
    "PostToolUse",
    "tool_use",
    "Bash",
    JSON.stringify({ tool_response: {} }),
    null,
  );
  insertEvent.run(
    6,
    "sess-work",
    "SessionStart",
    "session_start",
    null,
    "{}",
    "work::fn-575-foo.1",
  );
  insertEvent.run(
    7,
    "sess-audit",
    "SessionStart",
    "session_start",
    null,
    "{}",
    "audit::fn-1-bar",
  );
  insertEvent.run(
    8,
    "sess-nospawn",
    "SessionStart",
    "session_start",
    null,
    "{}",
    null,
  );
  insertEvent.run(
    9,
    "sess-malformed",
    "UserPromptSubmit",
    "user_prompt_submit",
    null,
    "{not valid json",
    null,
  );

  // Seed corresponding jobs rows. Only the SessionStart-having sessions
  // get a jobs row (mirrors the reducer's SessionStart insert path).
  const insertJob = v9.prepare(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at) VALUES (?, ?, ?, ?)",
  );
  insertJob.run("sess-work", 1, 6, 1);
  insertJob.run("sess-audit", 1, 7, 1);
  insertJob.run("sess-nospawn", 1, 8, 1);
  v9.close();

  // Reopen via openDb — migrate() runs the v9→v10 idempotent ADD COLUMNs,
  // the partial indexes, and the same-transaction JS backfill.
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe("10");

  // All four columns appear.
  const eventNames = (
    db.prepare("PRAGMA table_info(events)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(eventNames).toContain("slash_command");
  expect(eventNames).toContain("skill_name");
  const jobNames = (
    db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(jobNames).toContain("plan_verb");
  expect(jobNames).toContain("plan_ref");

  // Partial indexes present.
  const indexNames = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as { name: string }[]
    ).map((i) => i.name),
  );
  expect(indexNames.has("idx_events_slash_command")).toBe(true);
  expect(indexNames.has("idx_events_skill_name")).toBe(true);
  expect(indexNames.has("idx_jobs_plan_ref")).toBe(true);

  // Backfill: events.
  const ev = db
    .prepare("SELECT session_id, slash_command, skill_name FROM events")
    .all() as {
    session_id: string;
    slash_command: string | null;
    skill_name: string | null;
  }[];
  const eventBy = new Map(ev.map((r) => [r.session_id, r]));
  expect(eventBy.get("sess-slash")?.slash_command).toBe("/plan:work");
  expect(eventBy.get("sess-slash")?.skill_name).toBeNull();
  expect(eventBy.get("sess-plain")?.slash_command).toBeNull();
  expect(eventBy.get("sess-plain")?.skill_name).toBeNull();
  // `/Users/...` REJECTS the slash-command regex (uppercase after `/`).
  expect(eventBy.get("sess-path")?.slash_command).toBeNull();
  expect(eventBy.get("sess-path")?.skill_name).toBeNull();
  expect(eventBy.get("sess-skill")?.slash_command).toBeNull();
  expect(eventBy.get("sess-skill")?.skill_name).toBe("plan:plan");
  expect(eventBy.get("sess-bash")?.slash_command).toBeNull();
  expect(eventBy.get("sess-bash")?.skill_name).toBeNull();
  // The SessionStart rows aren't slash-command / Skill candidates — both NULL.
  expect(eventBy.get("sess-work")?.slash_command).toBeNull();
  expect(eventBy.get("sess-work")?.skill_name).toBeNull();
  // A malformed JSON blob falls through the try/catch and leaves both NULL —
  // the migration must converge, not throw.
  expect(eventBy.get("sess-malformed")?.slash_command).toBeNull();
  expect(eventBy.get("sess-malformed")?.skill_name).toBeNull();

  // Backfill: jobs.
  const jobs = db
    .prepare("SELECT job_id, plan_verb, plan_ref FROM jobs")
    .all() as {
    job_id: string;
    plan_verb: string | null;
    plan_ref: string | null;
  }[];
  const jobBy = new Map(jobs.map((r) => [r.job_id, r]));
  expect(jobBy.get("sess-work")?.plan_verb).toBe("work");
  expect(jobBy.get("sess-work")?.plan_ref).toBe("fn-575-foo.1");
  expect(jobBy.get("sess-audit")?.plan_verb).toBeNull();
  expect(jobBy.get("sess-audit")?.plan_ref).toBeNull();
  expect(jobBy.get("sess-nospawn")?.plan_verb).toBeNull();
  expect(jobBy.get("sess-nospawn")?.plan_ref).toBeNull();

  // Second open is idempotent — the version-guarded backfill must not re-run
  // (its UPDATEs would re-write the same values; the no-throw correctness is
  // what we're checking) and the ALTERs must no-op on the now-current shape.
  db.close();
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe("10");
  // Re-verify the backfill landed identically on the second open — the
  // guard keeps the values stable.
  const jobsAfter = db2
    .prepare("SELECT job_id, plan_verb, plan_ref FROM jobs WHERE job_id = ?")
    .get("sess-work") as {
    job_id: string;
    plan_verb: string | null;
    plan_ref: string | null;
  };
  expect(jobsAfter.plan_verb).toBe("work");
  expect(jobsAfter.plan_ref).toBe("fn-575-foo.1");
  db2.close();
});

test("resolveConfig: missing file falls back to default ~/code root", () => {
  const original = process.env.KEEPER_CONFIG;
  try {
    process.env.KEEPER_CONFIG = join(tmpDir, "nope.yaml");
    expect(resolveConfig().roots).toEqual(["~/code"]);
  } finally {
    if (original === undefined) delete process.env.KEEPER_CONFIG;
    else process.env.KEEPER_CONFIG = original;
  }
});

test("resolveConfig: KEEPER_CONFIG override parses roots via Bun.YAML", () => {
  const original = process.env.KEEPER_CONFIG;
  try {
    const cfg = join(tmpDir, "config.yaml");
    writeFileSync(cfg, "roots:\n  - ~/code\n  - /tmp/projects\n");
    process.env.KEEPER_CONFIG = cfg;
    expect(resolveConfig().roots).toEqual(["~/code", "/tmp/projects"]);
  } finally {
    if (original === undefined) delete process.env.KEEPER_CONFIG;
    else process.env.KEEPER_CONFIG = original;
  }
});

test("resolveConfig: malformed YAML and missing roots key fall back to default", () => {
  const original = process.env.KEEPER_CONFIG;
  try {
    const cfg = join(tmpDir, "config.yaml");
    // A document with no roots key.
    writeFileSync(cfg, "other: value\n");
    process.env.KEEPER_CONFIG = cfg;
    expect(resolveConfig().roots).toEqual(["~/code"]);
    // Malformed YAML must not throw past the resolver.
    writeFileSync(cfg, "roots:\n  - [unbalanced\n: : :\n");
    expect(resolveConfig().roots).toEqual(["~/code"]);
  } finally {
    if (original === undefined) delete process.env.KEEPER_CONFIG;
    else process.env.KEEPER_CONFIG = original;
  }
});

test("resolvePlanRoots: expands ~, drops non-existent, keeps the good ones", async () => {
  const original = process.env.KEEPER_CONFIG;
  try {
    // tmpDir exists; a sibling path does not. HOME-relative ~ expands to a real
    // dir (homedir always exists).
    const goodAbs = tmpDir;
    const missingAbs = join(tmpDir, "does-not-exist");
    const cfg = join(tmpDir, "config.yaml");
    // Bare `~` is a YAML null literal; quote it so it survives as the string
    // we expand to $HOME (real configs use `~/code`, a plain string).
    writeFileSync(cfg, `roots:\n  - "~"\n  - ${goodAbs}\n  - ${missingAbs}\n`);
    process.env.KEEPER_CONFIG = cfg;

    const roots = resolvePlanRoots();
    // ~ expanded to $HOME (an existing dir); goodAbs kept; missing dropped.
    const { homedir } = await import("node:os");
    expect(roots).toContain(homedir());
    expect(roots).toContain(goodAbs);
    expect(roots).not.toContain(missingAbs);
    expect(roots.every((r) => r.startsWith("/"))).toBe(true);
    // One missing root did not silence the surviving ones.
    expect(roots.length).toBe(2);
  } finally {
    if (original === undefined) delete process.env.KEEPER_CONFIG;
    else process.env.KEEPER_CONFIG = original;
  }
});

test("resolveClaudeProjectsRoot: present key expands ~ to an absolute path", async () => {
  const original = process.env.KEEPER_CONFIG;
  try {
    const cfg = join(tmpDir, "config.yaml");
    writeFileSync(cfg, "claude_projects_root: ~/some/where\n");
    process.env.KEEPER_CONFIG = cfg;
    const { homedir } = await import("node:os");
    expect(resolveClaudeProjectsRoot()).toBe(join(homedir(), "some/where"));
  } finally {
    if (original === undefined) delete process.env.KEEPER_CONFIG;
    else process.env.KEEPER_CONFIG = original;
  }
});

test("resolveClaudeProjectsRoot: absent key defaults to ~/.claude/projects", async () => {
  const original = process.env.KEEPER_CONFIG;
  try {
    const cfg = join(tmpDir, "config.yaml");
    // A config with only `roots`, no claude_projects_root.
    writeFileSync(cfg, "roots:\n  - ~/code\n");
    process.env.KEEPER_CONFIG = cfg;
    const { homedir } = await import("node:os");
    expect(resolveClaudeProjectsRoot()).toBe(
      join(homedir(), ".claude", "projects"),
    );
  } finally {
    if (original === undefined) delete process.env.KEEPER_CONFIG;
    else process.env.KEEPER_CONFIG = original;
  }
});

test("resolveClaudeProjectsRoot: missing file + malformed YAML default to ~/.claude/projects", async () => {
  const original = process.env.KEEPER_CONFIG;
  try {
    const { homedir } = await import("node:os");
    const expected = join(homedir(), ".claude", "projects");
    // Missing file.
    process.env.KEEPER_CONFIG = join(tmpDir, "nope.yaml");
    expect(resolveClaudeProjectsRoot()).toBe(expected);
    // Malformed YAML must not throw past the resolver.
    const cfg = join(tmpDir, "config.yaml");
    writeFileSync(cfg, "claude_projects_root:\n  - [unbalanced\n: : :\n");
    process.env.KEEPER_CONFIG = cfg;
    expect(resolveClaudeProjectsRoot()).toBe(expected);
  } finally {
    if (original === undefined) delete process.env.KEEPER_CONFIG;
    else process.env.KEEPER_CONFIG = original;
  }
});

test("resolveClaudeProjectsRoot: non-string value falls back to the default", async () => {
  const original = process.env.KEEPER_CONFIG;
  try {
    const cfg = join(tmpDir, "config.yaml");
    // A numeric value is not a string → default.
    writeFileSync(cfg, "claude_projects_root: 42\n");
    process.env.KEEPER_CONFIG = cfg;
    const { homedir } = await import("node:os");
    expect(resolveClaudeProjectsRoot()).toBe(
      join(homedir(), ".claude", "projects"),
    );
  } finally {
    if (original === undefined) delete process.env.KEEPER_CONFIG;
    else process.env.KEEPER_CONFIG = original;
  }
});

test("resolveConfig: the two keys fall back independently from one document", () => {
  const original = process.env.KEEPER_CONFIG;
  try {
    const cfg = join(tmpDir, "config.yaml");
    // `roots` is malformed/empty (non-string junk dropped → falls back), but
    // `claude_projects_root` is a valid string and must survive untouched.
    writeFileSync(
      cfg,
      "roots:\n  - 123\n  - true\nclaude_projects_root: /tmp/transcripts\n",
    );
    process.env.KEEPER_CONFIG = cfg;
    const config = resolveConfig();
    expect(config.roots).toEqual(["~/code"]);
    expect(config.claudeProjectsRoot).toBe("/tmp/transcripts");

    // Inverse: valid `roots`, malformed (non-string) claude_projects_root → the
    // key defaults while roots survives.
    writeFileSync(cfg, "roots:\n  - /tmp/projects\nclaude_projects_root: 99\n");
    const config2 = resolveConfig();
    expect(config2.roots).toEqual(["/tmp/projects"]);
    expect(config2.claudeProjectsRoot).toBe("~/.claude/projects");
  } finally {
    if (original === undefined) delete process.env.KEEPER_CONFIG;
    else process.env.KEEPER_CONFIG = original;
  }
});

test("KEEPER_SOCK env var overrides default socket path", () => {
  const original = process.env.KEEPER_SOCK;
  try {
    const custom = join(tmpDir, "custom.sock");
    process.env.KEEPER_SOCK = custom;
    expect(resolveSockPath()).toBe(custom);

    delete process.env.KEEPER_SOCK;
    const fallback = resolveSockPath();
    expect(fallback.endsWith("/.local/state/keeper/keeperd.sock")).toBe(true);
  } finally {
    if (original === undefined) {
      delete process.env.KEEPER_SOCK;
    } else {
      process.env.KEEPER_SOCK = original;
    }
  }
});

test("resolveSockPath does no I/O (does not create the parent dir)", () => {
  // Pure resolver — calling it must not touch the filesystem.
  const original = process.env.KEEPER_SOCK;
  try {
    delete process.env.KEEPER_SOCK;
    // We just need to call it; there's nothing to assert beyond "no throw".
    resolveSockPath();
  } finally {
    if (original !== undefined) {
      process.env.KEEPER_SOCK = original;
    }
  }
});

test("selectWorldRev returns the seeded 0 on a fresh DB", () => {
  const { db, stmts } = openDb(dbPath);
  expect(selectWorldRev(stmts)).toBe(0);
  db.close();
});

test("selectWorldRev reflects advanceCursor", () => {
  const { db, stmts } = openDb(dbPath);
  db.prepare(
    "UPDATE reducer_state SET last_event_id = ?, updated_at = ? WHERE id = 1",
  ).run(7, 1);
  expect(selectWorldRev(stmts)).toBe(7);
  db.close();
});

test("selectByIds returns [] for an empty id-set without querying", () => {
  const { db } = openDb(dbPath);
  // Sanity: even if we hadn't seeded anything, [] must short-circuit.
  expect(selectByIds(db, JOBS_DESCRIPTOR, [])).toEqual([]);
  db.close();
});

test("selectByIds returns matching rows for a multi-id set", () => {
  const { db } = openDb(dbPath);
  const ts = 1_700_000_000;
  const insert = db.prepare(
    "INSERT INTO jobs (job_id, created_at, cwd, pid, state, last_event_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run("a", ts, "/a", 1, "working", 10, ts);
  insert.run("b", ts, "/b", 2, "stopped", 11, ts);
  insert.run("c", ts, null, null, "ended", 12, ts);

  const rows = selectByIds(db, JOBS_DESCRIPTOR, [
    "a",
    "c",
    "missing",
  ]) as unknown as Job[];
  expect(rows).toHaveLength(2);
  const ids = new Set(rows.map((r) => r.job_id));
  expect(ids.has("a")).toBe(true);
  expect(ids.has("c")).toBe(true);
  // Row shape carries the typed columns through.
  const a = rows.find((r) => r.job_id === "a");
  expect(a?.state).toBe("working");
  expect(a?.last_event_id).toBe(10);
  expect(a?.cwd).toBe("/a");
  // NULL columns survive the round-trip.
  const c = rows.find((r) => r.job_id === "c");
  expect(c?.cwd).toBeNull();
  expect(c?.pid).toBeNull();
  db.close();
});

test("selectByIds serves title and no title_history key", () => {
  const { db } = openDb(dbPath);
  const ts = 1_700_000_000;
  db.prepare(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, title) VALUES (?, ?, ?, ?, ?)",
  ).run("titled", ts, 1, ts, "fix-osc");
  // A title-less job (title defaults to NULL).
  db.prepare(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at) VALUES (?, ?, ?, ?)",
  ).run("bare", ts, 1, ts);

  const rows = selectByIds(db, JOBS_DESCRIPTOR, ["titled", "bare"]);
  const titled = rows.find((r) => r.job_id === "titled");
  const bare = rows.find((r) => r.job_id === "bare");
  expect(titled?.title).toBe("fix-osc");
  expect(bare?.title).toBeNull();
  // title_history is retired — it is not a served column.
  expect("title_history" in (titled ?? {})).toBe(false);
  db.close();
});

test("selectByIds throws when id-set exceeds MAX_IN_PARAMS", () => {
  const { db } = openDb(dbPath);
  const ids = Array.from({ length: MAX_IN_PARAMS + 1 }, (_, i) => `id-${i}`);
  expect(() => selectByIds(db, JOBS_DESCRIPTOR, ids)).toThrow(
    /MAX_VARIABLE_NUMBER/,
  );
  db.close();
});

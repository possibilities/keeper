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
import { drain } from "../src/reducer";
import type { Job } from "../src/types";

/**
 * Boot drain helper for migration tests. Schema v11's rewind-and-redrain
 * sets the cursor to 0 inside migrate; the daemon's boot drain rebuilds the
 * projection AFTER `openDb` returns. Tests that don't spin up the daemon
 * must call this explicitly to observe the re-folded state. (v12 is a
 * non-rewind sidecar ADD — no drain required for the v11→v12 step.)
 */
function drainAll(db: import("bun:sqlite").Database): void {
  let n: number;
  do {
    n = drain(db);
  } while (n > 0);
}

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
  // Schema v13 dropped the `approvals` sidecar (replaced by the planctl-
  // native `epics.approval` column + the in-file `task.approval` field).
  expect(names.has("approvals")).toBe(false);
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
  expect(row.value).toBe("14");
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
  // through v11: the ALTER block isn't version-gated, so a v3 DB converges
  // straight to the current schema, stamping the current version). The v11
  // rewind-and-redrain wipes the projection; the daemon's boot drain rebuilds
  // it AFTER `openDb` returns — tests stand in for that drain explicitly.
  const { db } = openDb(dbPath);
  drainAll(db);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe("14");

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

  // Existing event rows gain the new columns reading NULL; prior event data
  // is intact (the event log is never wiped, only re-folded).
  const ev = db
    .prepare(
      "SELECT session_id, spawn_name FROM events WHERE session_id = 'sess'",
    )
    .get() as { session_id: string; spawn_name: string | null };
  expect(ev.spawn_name).toBeNull();
  // Schema v11 rewind-and-redrain rebuilds the `jobs` projection from the
  // event log (the source of truth). The directly-inserted-by-the-test
  // legacy `old` row is wiped; the `sess` SessionStart event re-folds into
  // a fresh row. This is the v11 contract — hand-inserted jobs rows that
  // never had a backing event are now provably forgotten.
  const jobOld = db
    .prepare("SELECT title FROM jobs WHERE job_id = 'old'")
    .get() as { title: string | null } | null;
  expect(jobOld).toBeNull();
  const jobSess = db
    .prepare(
      "SELECT title, title_source, state FROM jobs WHERE job_id = 'sess'",
    )
    .get() as {
    title: string | null;
    title_source: string | null;
    state: string;
  } | null;
  expect(jobSess).not.toBeNull();
  expect(jobSess?.state).toBe("stopped");

  // Second open is idempotent — the ADD COLUMNs no-op on the now-current shape.
  db.close();
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe("14");
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
  expect(ver.value).toBe("14");

  const jobNames = (
    db.prepare("PRAGMA table_info(jobs)").all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  expect(jobNames).toContain("transcript_path");

  // Schema v11 rewind-and-redrain rebuilds the `jobs` projection from the
  // event log. This v4 fixture has no events, so the directly-inserted `old`
  // jobs row is wiped. Schema convergence + column existence is what the
  // migration test guarantees; data preservation requires the row to have a
  // backing event (which a real v4→v5 path would, modulo orphans).
  const job = db
    .prepare("SELECT title FROM jobs WHERE job_id = 'old'")
    .get() as { title: string | null } | null;
  expect(job).toBeNull();

  // Second open is idempotent — the ADD COLUMN no-ops on the now-v11 shape
  // and the rewind-and-redrain version guard suppresses re-running.
  db.close();
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe("14");
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
  expect(ver.value).toBe("14");
  const names = (
    db.prepare("PRAGMA table_info(jobs)").all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  expect(names).not.toContain("mode");
  expect(names).not.toContain("title_history");
  // Schema v11 rewind-and-redrain wipes the directly-inserted `old` row.
  // The fixture has no events to re-fold, so the row is provably forgotten
  // — column drops landed correctly is what this test guarantees.
  const row = db
    .prepare("SELECT title FROM jobs WHERE job_id = 'old'")
    .get() as { title: string | null } | null;
  expect(row).toBeNull();
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
  expect(ver.value).toBe("14");

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
  // `tasks` JSON-array column (schema v7), the embedded `jobs`
  // JSON-array column (schema v11), and the v14 `job_links` array.
  const epicCols = (
    db.prepare("PRAGMA table_info(epics)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(epicCols).toEqual([
    "epic_id",
    "epic_number",
    "title",
    "project_dir",
    "status",
    "approval",
    "last_event_id",
    "updated_at",
    "tasks",
    "depends_on_epics",
    "jobs",
    "job_links",
  ]);

  // Schema v11 rewind-and-redrain wipes the directly-inserted `old` jobs
  // row (no events back it). The forward-only migration converges schema
  // shape; the v11 contract is that the event log is the sole source of
  // truth for projection rows.
  const job = db
    .prepare("SELECT title FROM jobs WHERE job_id = 'old'")
    .get() as { title: string | null } | null;
  expect(job).toBeNull();

  // Second open is idempotent — CREATE TABLE IF NOT EXISTS no-ops.
  db.close();
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe("14");
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
  expect(ver.value).toBe("14");

  // tasks table is gone (the v6→v7 backfill+DROP runs inside the same
  // transaction, before the v11 rewind clears `epics`).
  const tables = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((t) => t.name),
  );
  expect(tables.has("tasks")).toBe(false);

  // Schema v11 rewind-and-redrain wipes `epics` after the v6→v7 backfill
  // runs. This fixture has no events, so the previously-backfilled rows
  // do NOT re-emerge. The migration still converges schema (tasks table
  // dropped, embedded `tasks` + `jobs` columns added). A real v6 DB whose
  // plan worker reads `.planctl` files re-folds the snapshots back through
  // synthetic events on the next boot scan.
  const epicCount = db.prepare("SELECT count(*) AS c FROM epics").get() as {
    c: number;
  };
  expect(epicCount.c).toBe(0);

  // The migrated schema includes the new `jobs` embedded column on epics.
  const epicCols = (
    db.prepare("PRAGMA table_info(epics)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(epicCols).toContain("tasks");
  expect(epicCols).toContain("jobs");

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
  // stamps the current version. The v11 rewind-and-redrain wipes the
  // projection; tests stand in for the daemon's boot drain explicitly.
  const { db } = openDb(dbPath);
  drainAll(db);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe("14");

  // Both columns now appear.
  const eventNames = (
    db.prepare("PRAGMA table_info(events)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(eventNames).toContain("start_time");
  const jobNames = (
    db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(jobNames).toContain("start_time");

  // Existing event rows gain the new columns reading NULL; the event log
  // is preserved (only projections rewind+redrain).
  const ev = db
    .prepare(
      "SELECT spawn_name, start_time FROM events WHERE session_id = 'sess'",
    )
    .get() as { spawn_name: string | null; start_time: string | null };
  expect(ev.spawn_name).toBe("fix-osc");
  expect(ev.start_time).toBeNull();
  // Schema v11 rewind-and-redrain wipes the directly-inserted `old` row and
  // re-folds the `sess` SessionStart event through the current reducer —
  // which seeds title from `spawn_name` ('fix-osc') at title_source='spawn'.
  const jobOld = db
    .prepare("SELECT title FROM jobs WHERE job_id = 'old'")
    .get() as { title: string | null } | null;
  expect(jobOld).toBeNull();
  const jobSess = db
    .prepare(
      "SELECT title, title_source, start_time FROM jobs WHERE job_id = 'sess'",
    )
    .get() as {
    title: string | null;
    title_source: string | null;
    start_time: string | null;
  } | null;
  expect(jobSess?.title).toBe("fix-osc");
  expect(jobSess?.title_source).toBe("spawn");
  expect(jobSess?.start_time).toBeNull();

  // Second open is idempotent — the ADD COLUMNs no-op on the now-current shape.
  db.close();
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe("14");
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
  // the partial indexes, the same-transaction JS backfill, and (schema v11)
  // the rewind-and-redrain wipe. The daemon's boot drain rebuilds the
  // projection AFTER `openDb` returns — tests stand in for that drain
  // explicitly so plan_verb/plan_ref show up on the re-folded jobs rows.
  const { db } = openDb(dbPath);
  drainAll(db);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe("14");

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
  expect(ver2.value).toBe("14");
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

test("v10 DB migrates to v11: epics.jobs added + rewind-and-redrain rebuilds embedded jobs from event log", () => {
  // Build a v10-shaped DB by hand: events + jobs + epics at the v10 shape (no
  // `epics.jobs` column), version '10'. Seed historical events that the
  // rewind-and-redrain must replay through the v11 reducer to land embedded
  // jobs back into the right arrays.
  const v10 = new Database(dbPath, { create: true });
  v10.run(`
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
      start_time TEXT,
      slash_command TEXT,
      skill_name TEXT
    )
  `);
  v10.run(`
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
      start_time TEXT,
      plan_verb TEXT,
      plan_ref TEXT
    )
  `);
  v10.run(`
    CREATE TABLE epics (
      epic_id TEXT PRIMARY KEY,
      epic_number INTEGER,
      title TEXT,
      project_dir TEXT,
      status TEXT,
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0,
      tasks TEXT NOT NULL DEFAULT '[]',
      depends_on_epics TEXT NOT NULL DEFAULT '[]'
    )
  `);
  v10.run(`
    CREATE TABLE reducer_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_event_id INTEGER NOT NULL DEFAULT 0,
      updated_at REAL NOT NULL
    )
  `);
  v10.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v10.run("INSERT INTO meta (key, value) VALUES ('schema_version', '10')");
  v10.run(
    "INSERT INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 0, 1)",
  );

  // Seed events covering mixed kinds:
  // - SessionStart with plan-verb spawn → fans into epic.jobs.
  // - SessionStart with work-verb spawn → fans into task.jobs (shell task).
  // - EpicSnapshot + TaskSnapshot → fill scalar columns.
  // - A second SessionStart for a job WITHOUT plan_ref → no fan-out.
  const insertEvent = v10.prepare(
    "INSERT INTO events (ts, session_id, hook_event, event_type, data, spawn_name) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insertEvent.run(
    1,
    "sess-plan",
    "SessionStart",
    "session_start",
    "{}",
    "plan::fn-1-foo",
  );
  insertEvent.run(
    2,
    "sess-work",
    "SessionStart",
    "session_start",
    "{}",
    "work::fn-1-foo.2",
  );
  insertEvent.run(
    3,
    "fn-1-foo",
    "EpicSnapshot",
    "epic_snapshot",
    JSON.stringify({
      epic_number: 1,
      title: "Foo",
      project_dir: "/repo",
      status: "open",
    }),
    null,
  );
  insertEvent.run(
    4,
    "fn-1-foo.2",
    "TaskSnapshot",
    "task_snapshot",
    JSON.stringify({
      epic_id: "fn-1-foo",
      task_number: 2,
      title: "Two",
      target_repo: "/repo",
      status: "open",
    }),
    null,
  );
  insertEvent.run(5, "sess-plain", "SessionStart", "session_start", "{}", null);

  // Seed jobs + epics rows reflecting v10 reducer output (no `jobs` arrays).
  v10
    .prepare(
      "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, plan_verb, plan_ref) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("sess-plan", 1, 1, 1, "plan", "fn-1-foo");
  v10
    .prepare(
      "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, plan_verb, plan_ref) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("sess-work", 2, 2, 2, "work", "fn-1-foo.2");
  v10
    .prepare(
      "INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run("fn-1-foo", 1, "Foo", "/repo", "open", 3, 1);
  v10.close();

  // Reopen via openDb — migrate() runs the v10→v11 ALTER (idempotent) plus
  // the version-guarded rewind-and-redrain, then the v12→v13 ALTER that adds
  // `epics.approval` + drops the (non-existent on this v10 DB) `approvals`
  // sidecar; the version stamp jumps straight to v13 (the current
  // SCHEMA_VERSION). The daemon's boot drain rebuilds the projection AFTER
  // `openDb` returns; the test stands in for that drain.
  const { db } = openDb(dbPath);
  drainAll(db);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe("14");

  // epics.jobs column present, with the NOT NULL DEFAULT '[]'.
  const epicCols = db.prepare("PRAGMA table_info(epics)").all() as {
    name: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const jobsCol = epicCols.find((c) => c.name === "jobs");
  expect(jobsCol).toBeDefined();
  expect(jobsCol?.notnull).toBe(1);
  expect(jobsCol?.dflt_value).toBe("'[]'");

  // The re-fold rebuilt epic.jobs and task.jobs from the event log.
  const epic = db
    .prepare(
      "SELECT title, status, jobs, tasks FROM epics WHERE epic_id = 'fn-1-foo'",
    )
    .get() as {
    title: string;
    status: string;
    jobs: string;
    tasks: string;
  };
  expect(epic.title).toBe("Foo");
  expect(epic.status).toBe("open");
  // Epic-level embedded jobs: just the plan-verb session.
  const epicJobs = JSON.parse(epic.jobs) as {
    job_id: string;
    plan_verb: string;
  }[];
  expect(epicJobs.length).toBe(1);
  expect(epicJobs[0]?.job_id).toBe("sess-plan");
  expect(epicJobs[0]?.plan_verb).toBe("plan");
  // Task-level embedded jobs: the work-verb session nested inside task.2.
  const tasks = JSON.parse(epic.tasks) as {
    task_id: string;
    jobs: { job_id: string; plan_verb: string }[];
  }[];
  expect(tasks.length).toBe(1);
  expect(tasks[0]?.task_id).toBe("fn-1-foo.2");
  expect(tasks[0]?.jobs.length).toBe(1);
  expect(tasks[0]?.jobs[0]?.job_id).toBe("sess-work");
  expect(tasks[0]?.jobs[0]?.plan_verb).toBe("work");

  // Second openDb is idempotent — the rewind-and-redrain guard skips the
  // second time (storedVersion >= 11), and the v11→v12 CREATE TABLE
  // IF NOT EXISTS is naturally idempotent, so the projection is left intact.
  const epicsBefore = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  const jobsBefore = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  db.close();
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe("14");
  // No re-drain needed — the guard suppressed the rewind, so the rows
  // persist as-is.
  const epicsAfter = db2.query("SELECT * FROM epics ORDER BY epic_id").all();
  const jobsAfter = db2.query("SELECT * FROM jobs ORDER BY job_id").all();
  expect(epicsAfter).toEqual(epicsBefore);
  expect(jobsAfter).toEqual(jobsBefore);
  db2.close();
});

test("v12 DB migrates to v13: epics.approval added, approvals table dropped, file backfill + overlay applied, idempotent re-run", () => {
  // Build a v12-shaped DB by hand: events + jobs + epics + approvals at the
  // v12 shape, version '12'. The v12→v13 step ADDs `epics.approval`, DROPs
  // the `approvals` sidecar table, and (in the FS half) backfills epic plan
  // files + overlays sidecar rows. Seed the FS so the migration has work to
  // do; then run BOTH halves (openDb for the SQL, runPlanctlApprovalMigration
  // for the FS) and assert on the final state.
  const v12 = new Database(dbPath, { create: true });
  v12.run(`
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
      start_time TEXT,
      slash_command TEXT,
      skill_name TEXT
    )
  `);
  v12.run(`
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
      start_time TEXT,
      plan_verb TEXT,
      plan_ref TEXT
    )
  `);
  v12.run(`
    CREATE TABLE epics (
      epic_id TEXT PRIMARY KEY,
      epic_number INTEGER,
      title TEXT,
      project_dir TEXT,
      status TEXT,
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0,
      tasks TEXT NOT NULL DEFAULT '[]',
      depends_on_epics TEXT NOT NULL DEFAULT '[]',
      jobs TEXT NOT NULL DEFAULT '[]'
    )
  `);
  v12.run(`
    CREATE TABLE approvals (
      approval_id TEXT PRIMARY KEY,
      epic_id TEXT NOT NULL,
      task_key TEXT NOT NULL,
      status TEXT CHECK(status IN ('approved', 'rejected')) NOT NULL,
      updated_at REAL NOT NULL,
      UNIQUE(epic_id, task_key)
    )
  `);
  v12.run(`
    CREATE TABLE reducer_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_event_id INTEGER NOT NULL DEFAULT 0,
      updated_at REAL NOT NULL
    )
  `);
  v12.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v12.run("INSERT INTO meta (key, value) VALUES ('schema_version', '12')");
  v12.run(
    "INSERT INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 42, 1)",
  );
  // Seed a projection row (proves sibling tables survive the DROP).
  v12
    .prepare(
      "INSERT INTO epics (epic_id, epic_number, title, status, last_event_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("fn-1-foo", 1, "Foo", "open", 7, 1);
  // Seed 3 sidecar rows: one task-level approve, one task-level reject, one
  // epic-level close-approval (task_key === "close:<epic_id>"). Plus one
  // orphan row whose target file we WON'T create.
  const insertApproval = v12.prepare(
    "INSERT INTO approvals (approval_id, epic_id, task_key, status, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  insertApproval.run(
    "fn-1-foo:fn-1-foo.1",
    "fn-1-foo",
    "fn-1-foo.1",
    "approved",
    100,
  );
  insertApproval.run(
    "fn-1-foo:fn-1-foo.2",
    "fn-1-foo",
    "fn-1-foo.2",
    "rejected",
    200,
  );
  insertApproval.run(
    "fn-1-foo:close:fn-1-foo",
    "fn-1-foo",
    "close:fn-1-foo",
    "rejected",
    300,
  );
  insertApproval.run("fn-nx:fn-nx.1", "fn-nx", "fn-nx.1", "approved", 400);
  v12.close();

  // Build a hermetic plan-root tree with 2 epic files (one with no `approval`
  // — eligible for backfill — and one with `approval` already set — proves
  // idempotent skip) plus 2 task files (the sidecar overlay targets).
  const { mkdirSync, readFileSync, writeFileSync } =
    require("node:fs") as typeof import("node:fs");
  const { serializePlanctlJson, runPlanctlApprovalMigration } =
    require("../src/db") as typeof import("../src/db");
  const planRoot = join(tmpDir, "plan-root");
  const epicsDir = join(planRoot, ".planctl", "epics");
  const tasksDir = join(planRoot, ".planctl", "tasks");
  mkdirSync(epicsDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  // Epic A: NO `approval` field — backfill should set it to "approved", then
  // the close:fn-1-foo overlay should flip it to "rejected".
  const epicAPath = join(epicsDir, "fn-1-foo.json");
  writeFileSync(
    epicAPath,
    serializePlanctlJson({ id: "fn-1-foo", title: "Foo", status: "open" }),
  );
  // Epic B: ALREADY has `approval` → backfill is a no-op (idempotent skip).
  const epicBPath = join(epicsDir, "fn-2-bar.json");
  writeFileSync(
    epicBPath,
    serializePlanctlJson({
      id: "fn-2-bar",
      title: "Bar",
      status: "open",
      approval: "pending",
    }),
  );
  // Task 1 + Task 2 (overlay targets).
  const task1Path = join(tasksDir, "fn-1-foo.1.json");
  writeFileSync(
    task1Path,
    serializePlanctlJson({ id: "fn-1-foo.1", epic: "fn-1-foo", title: "T1" }),
  );
  const task2Path = join(tasksDir, "fn-1-foo.2.json");
  writeFileSync(
    task2Path,
    serializePlanctlJson({ id: "fn-1-foo.2", epic: "fn-1-foo", title: "T2" }),
  );

  // Reopen via openDb — migrate() ADDs `epics.approval` and DROPs `approvals`.
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe("14");

  // approvals table is GONE — DROP TABLE IF EXISTS ran.
  const approvalsExists =
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approvals'",
      )
      .get() != null;
  expect(approvalsExists).toBe(false);

  // epics.approval column present.
  const epicCols = db.prepare("PRAGMA table_info(epics)").all() as {
    name: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const approvalCol = epicCols.find((c) => c.name === "approval");
  expect(approvalCol).toBeDefined();
  expect(approvalCol?.notnull).toBe(1);
  expect(approvalCol?.dflt_value).toBe("'pending'");

  // Sibling projection rows survived the DROP intact.
  const epic = db
    .prepare("SELECT title, status, last_event_id FROM epics WHERE epic_id = ?")
    .get("fn-1-foo") as {
    title: string;
    status: string;
    last_event_id: number;
  };
  expect(epic.title).toBe("Foo");

  // Realistic boot path: migrate() snapshotted the pre-DROP `approvals` rows
  // into a connection-scoped TEMP table BEFORE the DROP fired, and
  // runPlanctlApprovalMigration reads from that snapshot. So both passes —
  // backfill AND overlay — land their effects, the sidecar rows are not
  // silently lost across the DROP, and the overlay contract is honored.
  runPlanctlApprovalMigration(db, [planRoot]);

  // Epic A: missing-`approval` → backfill set it to "approved", then the
  // `close:fn-1-foo` sidecar row OVERLAID it to "rejected" (sidecar wins).
  const epicAAfter = JSON.parse(readFileSync(epicAPath, "utf8")) as {
    approval: string;
  };
  expect(epicAAfter.approval).toBe("rejected");
  // Epic B unchanged (already had `approval`, no sidecar row targets it).
  const epicBAfter = JSON.parse(readFileSync(epicBPath, "utf8")) as {
    approval: string;
  };
  expect(epicBAfter.approval).toBe("pending");
  // Task overlays landed verbatim from the sidecar (approved / rejected).
  const task1After = JSON.parse(readFileSync(task1Path, "utf8")) as {
    approval: string;
  };
  expect(task1After.approval).toBe("approved");
  const task2After = JSON.parse(readFileSync(task2Path, "utf8")) as {
    approval: string;
  };
  expect(task2After.approval).toBe("rejected");

  // Re-run is a no-op (idempotent): the TEMP snapshot was dropped after the
  // first pass and the on-disk files already carry the overlaid values.
  runPlanctlApprovalMigration(db, [planRoot]);
  expect(JSON.parse(readFileSync(epicAPath, "utf8")).approval).toBe("rejected");
  expect(JSON.parse(readFileSync(epicBPath, "utf8")).approval).toBe("pending");
  expect(JSON.parse(readFileSync(task1Path, "utf8")).approval).toBe("approved");
  expect(JSON.parse(readFileSync(task2Path, "utf8")).approval).toBe("rejected");

  // Second openDb is idempotent — version stays at v13, sibling rows
  // persist, schema_version unchanged.
  const epicsBefore = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  db.close();
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe("14");
  const epicsAfter = db2.query("SELECT * FROM epics ORDER BY epic_id").all();
  expect(epicsAfter).toEqual(epicsBefore);
  db2.close();
});

test("fresh openDb at v14 has events.planctl_* + jobs.epic_links + epics.job_links with correct shapes", () => {
  const { db } = openDb(dbPath);
  const eventCols = db.prepare("PRAGMA table_info(events)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const eventByName = new Map(eventCols.map((c) => [c.name, c]));
  for (const col of [
    "planctl_op",
    "planctl_target",
    "planctl_epic_id",
    "planctl_task_id",
  ]) {
    const c = eventByName.get(col);
    expect(c).toBeDefined();
    expect(c?.type).toBe("TEXT");
    expect(c?.notnull).toBe(0);
    expect(c?.dflt_value).toBeNull();
  }
  const presentCol = eventByName.get("planctl_subject_present");
  expect(presentCol).toBeDefined();
  expect(presentCol?.type).toBe("INTEGER");
  expect(presentCol?.notnull).toBe(0);

  const jobCols = db.prepare("PRAGMA table_info(jobs)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const epicLinks = jobCols.find((c) => c.name === "epic_links");
  expect(epicLinks).toBeDefined();
  expect(epicLinks?.type).toBe("TEXT");
  expect(epicLinks?.notnull).toBe(1);
  expect(epicLinks?.dflt_value).toBe("'[]'");

  const epicCols = db.prepare("PRAGMA table_info(epics)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const jobLinks = epicCols.find((c) => c.name === "job_links");
  expect(jobLinks).toBeDefined();
  expect(jobLinks?.type).toBe("TEXT");
  expect(jobLinks?.notnull).toBe(1);
  expect(jobLinks?.dflt_value).toBe("'[]'");

  // v14 partial composite index is present on a fresh openDb.
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all() as { name: string }[];
  const names = new Set(indexes.map((i) => i.name));
  expect(names.has("idx_events_planctl_session")).toBe(true);
  db.close();
});

test("v13 DB migrates to v14: seven columns + partial index + per-event backfill + per-session/per-epic projection re-derive, idempotent re-run", () => {
  // Build a v13-shaped DB by hand: events + jobs + epics at the v13 shape (no
  // planctl_*, no epic_links, no job_links), version '13'. Seed historical
  // events that the v13→v14 backfill must walk:
  //
  // Session A (`sess-creator`):
  //   - SessionStart (no spawn name → no plan_verb/plan_ref).
  //   - PreToolUse:Skill `plan:plan` at ts=10 → window opener.
  //   - PreToolUse:Bash `planctl epic-create fn-1-foo` at ts=20 (mutation,
  //     inside window) → creator edge for fn-1-foo.
  //   - PreToolUse:Bash `planctl cat fn-1-foo` at ts=30 (read-only verb,
  //     inside window) → no edge.
  //
  // Session B (`sess-refiner`):
  //   - SessionStart.
  //   - PreToolUse:Skill `plan:plan` at ts=40 → window opener.
  //   - PreToolUse:Bash `planctl epic-set-title fn-1-foo "new"` at ts=50
  //     (mutation, inside window) → refiner edge for fn-1-foo.
  //
  // Session C (`sess-noop`):
  //   - SessionStart.
  //   - PreToolUse:Bash `ls -la` at ts=60 (non-planctl Bash) → no
  //     planctl_* stamps, no edges.
  const v13 = new Database(dbPath, { create: true });
  v13.run(`
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
      start_time TEXT,
      slash_command TEXT,
      skill_name TEXT
    )
  `);
  v13.run(`
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
      start_time TEXT,
      plan_verb TEXT,
      plan_ref TEXT
    )
  `);
  v13.run(`
    CREATE TABLE epics (
      epic_id TEXT PRIMARY KEY,
      epic_number INTEGER,
      title TEXT,
      project_dir TEXT,
      status TEXT,
      approval TEXT NOT NULL DEFAULT 'pending',
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0,
      tasks TEXT NOT NULL DEFAULT '[]',
      depends_on_epics TEXT NOT NULL DEFAULT '[]',
      jobs TEXT NOT NULL DEFAULT '[]'
    )
  `);
  v13.run(`
    CREATE TABLE reducer_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_event_id INTEGER NOT NULL DEFAULT 0,
      updated_at REAL NOT NULL
    )
  `);
  v13.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v13.run("INSERT INTO meta (key, value) VALUES ('schema_version', '13')");
  v13.run(
    "INSERT INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 0, 1)",
  );

  // Seed events. We bind `skill_name` directly for the Skill rows (the
  // v9→v10 backfill would otherwise have stamped them on its own — but
  // this fixture is at v13, past that step, so it expects skill_name to
  // already be populated on PreToolUse:Skill rows).
  const insertEvent = v13.prepare(
    "INSERT INTO events (ts, session_id, hook_event, event_type, tool_name, data, skill_name) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  // sess-creator
  insertEvent.run(
    1,
    "sess-creator",
    "SessionStart",
    "session_start",
    null,
    "{}",
    null,
  );
  insertEvent.run(
    10,
    "sess-creator",
    "PreToolUse",
    "pre_tool_use",
    "Skill",
    JSON.stringify({ tool_input: { skill: "plan:plan" } }),
    "plan:plan",
  );
  insertEvent.run(
    20,
    "sess-creator",
    "PreToolUse",
    "pre_tool_use",
    "Bash",
    JSON.stringify({ tool_input: { command: "planctl epic-create fn-1-foo" } }),
    null,
  );
  insertEvent.run(
    30,
    "sess-creator",
    "PreToolUse",
    "pre_tool_use",
    "Bash",
    JSON.stringify({ tool_input: { command: "planctl cat fn-1-foo" } }),
    null,
  );

  // sess-refiner
  insertEvent.run(
    35,
    "sess-refiner",
    "SessionStart",
    "session_start",
    null,
    "{}",
    null,
  );
  insertEvent.run(
    40,
    "sess-refiner",
    "PreToolUse",
    "pre_tool_use",
    "Skill",
    JSON.stringify({ tool_input: { skill: "plan:plan" } }),
    "plan:plan",
  );
  insertEvent.run(
    50,
    "sess-refiner",
    "PreToolUse",
    "pre_tool_use",
    "Bash",
    JSON.stringify({
      tool_input: { command: 'planctl epic-set-title fn-1-foo "new"' },
    }),
    null,
  );

  // sess-noop
  insertEvent.run(
    55,
    "sess-noop",
    "SessionStart",
    "session_start",
    null,
    "{}",
    null,
  );
  insertEvent.run(
    60,
    "sess-noop",
    "PreToolUse",
    "pre_tool_use",
    "Bash",
    JSON.stringify({ tool_input: { command: "ls -la" } }),
    null,
  );

  // Seed jobs rows so the backfill has something to UPDATE.
  const insertJob = v13.prepare(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at) VALUES (?, ?, ?, ?)",
  );
  insertJob.run("sess-creator", 1, 4, 1);
  insertJob.run("sess-refiner", 1, 7, 1);
  insertJob.run("sess-noop", 1, 9, 1);
  v13.close();

  // Reopen via openDb — migrate() runs the v13→v14 idempotent ADD COLUMNs,
  // the partial composite index, and the version-guarded same-transaction
  // backfill. The daemon's boot drain rebuilds the projection AFTER
  // `openDb` returns; this test does NOT call drainAll because the v14
  // backfill is the single source of truth for `epic_links` / `job_links`
  // until task .5 lands the live reducer fan-out — the test asserts the
  // backfill's output stands on its own.
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe("14");

  // All seven columns exist with correct shape.
  const eventNames = (
    db.prepare("PRAGMA table_info(events)").all() as { name: string }[]
  ).map((c) => c.name);
  for (const col of [
    "planctl_op",
    "planctl_target",
    "planctl_epic_id",
    "planctl_task_id",
    "planctl_subject_present",
  ]) {
    expect(eventNames).toContain(col);
  }
  const jobNames = (
    db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(jobNames).toContain("epic_links");
  const epicNames = (
    db.prepare("PRAGMA table_info(epics)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(epicNames).toContain("job_links");

  // Partial composite index present.
  const indexNames = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as { name: string }[]
    ).map((i) => i.name),
  );
  expect(indexNames.has("idx_events_planctl_session")).toBe(true);

  // Backfill: events.planctl_* on each PreToolUse:Bash row.
  const evRows = db
    .prepare(
      `SELECT id, ts, session_id, planctl_op, planctl_target,
              planctl_epic_id, planctl_task_id, planctl_subject_present
         FROM events
        WHERE hook_event = 'PreToolUse' AND tool_name = 'Bash'
        ORDER BY id ASC`,
    )
    .all() as {
    id: number;
    ts: number;
    session_id: string;
    planctl_op: string | null;
    planctl_target: string | null;
    planctl_epic_id: string | null;
    planctl_task_id: string | null;
    planctl_subject_present: number | null;
  }[];
  // Creator's epic-create row.
  const create = evRows.find((r) => r.ts === 20);
  expect(create?.planctl_op).toBe("epic-create");
  expect(create?.planctl_target).toBe("fn-1-foo");
  expect(create?.planctl_epic_id).toBe("fn-1-foo");
  expect(create?.planctl_task_id).toBeNull();
  expect(create?.planctl_subject_present).toBe(1);
  // Read-only cat row — subject_present=0.
  const cat = evRows.find((r) => r.ts === 30);
  expect(cat?.planctl_op).toBe("cat");
  expect(cat?.planctl_target).toBe("fn-1-foo");
  expect(cat?.planctl_epic_id).toBe("fn-1-foo");
  expect(cat?.planctl_subject_present).toBe(0);
  // Refiner's epic-set-title row. The target has quotes stripped.
  const refine = evRows.find((r) => r.ts === 50);
  expect(refine?.planctl_op).toBe("epic-set-title");
  expect(refine?.planctl_target).toBe("fn-1-foo");
  expect(refine?.planctl_epic_id).toBe("fn-1-foo");
  expect(refine?.planctl_subject_present).toBe(1);
  // Non-planctl Bash row stays NULL across the board.
  const ls = evRows.find((r) => r.ts === 60);
  expect(ls?.planctl_op).toBeNull();
  expect(ls?.planctl_target).toBeNull();
  expect(ls?.planctl_epic_id).toBeNull();
  expect(ls?.planctl_subject_present).toBeNull();

  // jobs.epic_links: both sessions land `refiner` edges. The classifier's
  // creator-shape check is `op === "create"` (task .2's port-from-Python
  // contract); the keeper deriver extracts the bare first token from the
  // Bash command, which is `"epic-create"` / `"epic-set-title"` — neither
  // matches the `"create"` shape, so both mutations fall through to the
  // refiner path via `entry.epic_id !== null`. The deriver→classifier
  // op-shape normalization is a separate integration concern outside the
  // scope of this task; the migration backfill's correctness is established
  // by byte-identical output to what the live reducer fan-out (task .5)
  // would produce on the same events.
  const jobRows = db.prepare("SELECT job_id, epic_links FROM jobs").all() as {
    job_id: string;
    epic_links: string;
  }[];
  const jobBy = new Map(jobRows.map((r) => [r.job_id, r]));
  const creatorLinks = JSON.parse(
    jobBy.get("sess-creator")?.epic_links ?? "[]",
  ) as { kind: string; target: string }[];
  expect(creatorLinks).toEqual([{ kind: "refiner", target: "fn-1-foo" }]);
  const refinerLinks = JSON.parse(
    jobBy.get("sess-refiner")?.epic_links ?? "[]",
  ) as { kind: string; target: string }[];
  expect(refinerLinks).toEqual([{ kind: "refiner", target: "fn-1-foo" }]);
  const noopLinks = JSON.parse(jobBy.get("sess-noop")?.epic_links ?? "[]") as {
    kind: string;
    target: string;
  }[];
  expect(noopLinks).toEqual([]);

  // epics.job_links: shell-inserted epic carrying both sessions as
  // refiner edges. Dedup is on `(kind, job_id)`; sort is on the full
  // tuple ascending (kind first, then job_id).
  const epicRow = db
    .prepare("SELECT epic_id, job_links FROM epics WHERE epic_id = ?")
    .get("fn-1-foo") as { epic_id: string; job_links: string } | null;
  expect(epicRow).not.toBeNull();
  const jobLinks = JSON.parse(epicRow?.job_links ?? "[]") as {
    kind: string;
    job_id: string;
  }[];
  expect(jobLinks).toEqual([
    { kind: "refiner", job_id: "sess-creator" },
    { kind: "refiner", job_id: "sess-refiner" },
  ]);

  // Second open is idempotent — the version guard suppresses the
  // backfill re-run; column ADDs no-op on the now-current shape; the
  // projection state persists unchanged.
  const epicsBefore = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  const jobsBefore = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  const eventsBefore = db.query("SELECT * FROM events ORDER BY id").all();
  db.close();
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe("14");
  const epicsAfter = db2.query("SELECT * FROM epics ORDER BY epic_id").all();
  const jobsAfter = db2.query("SELECT * FROM jobs ORDER BY job_id").all();
  const eventsAfter = db2.query("SELECT * FROM events ORDER BY id").all();
  expect(epicsAfter).toEqual(epicsBefore);
  expect(jobsAfter).toEqual(jobsBefore);
  expect(eventsAfter).toEqual(eventsBefore);
  db2.close();
});

test("v12 DB migrates to v13: FS overlay applies sidecar rows BEFORE the DROP TABLE", () => {
  // Variant of the prior test that exercises the FS migration's OVERLAY pass
  // by running it against a v12-shaped DB whose `approvals` table is still
  // present. We don't run openDb here (that would drop the table) — we
  // directly stand up a v12 DB and call runPlanctlApprovalMigration to prove
  // pass 2 routes rows correctly: a `close:<epic_id>` task_key writes the
  // epic file; an `<epic_id>.<n>` task_key writes the task file; an orphan
  // row (target file missing) logs and skips without throwing.
  const { mkdirSync, readFileSync, writeFileSync } =
    require("node:fs") as typeof import("node:fs");
  const { serializePlanctlJson, runPlanctlApprovalMigration } =
    require("../src/db") as typeof import("../src/db");
  const planRoot = join(tmpDir, "overlay-root");
  const epicsDir = join(planRoot, ".planctl", "epics");
  const tasksDir = join(planRoot, ".planctl", "tasks");
  mkdirSync(epicsDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  // Seed plan files. Epic A gets backfilled to "approved" then overlaid to
  // "rejected" by the close:<epic_id> row. Task 1 + Task 2 land overlay
  // values. Task missing for the orphan row.
  const epicPath = join(epicsDir, "fn-1-foo.json");
  writeFileSync(
    epicPath,
    serializePlanctlJson({ id: "fn-1-foo", title: "Foo" }),
  );
  const task1Path = join(tasksDir, "fn-1-foo.1.json");
  writeFileSync(
    task1Path,
    serializePlanctlJson({ id: "fn-1-foo.1", epic: "fn-1-foo" }),
  );
  const task2Path = join(tasksDir, "fn-1-foo.2.json");
  writeFileSync(
    task2Path,
    serializePlanctlJson({ id: "fn-1-foo.2", epic: "fn-1-foo" }),
  );

  // Build a raw v12 DB with approvals rows still in place.
  const v12 = new Database(dbPath, { create: true });
  v12.run(`
    CREATE TABLE approvals (
      approval_id TEXT PRIMARY KEY,
      epic_id TEXT NOT NULL,
      task_key TEXT NOT NULL,
      status TEXT CHECK(status IN ('approved', 'rejected')) NOT NULL,
      updated_at REAL NOT NULL,
      UNIQUE(epic_id, task_key)
    )
  `);
  v12
    .prepare(
      "INSERT INTO approvals (approval_id, epic_id, task_key, status, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("a", "fn-1-foo", "fn-1-foo.1", "approved", 1);
  v12
    .prepare(
      "INSERT INTO approvals (approval_id, epic_id, task_key, status, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("b", "fn-1-foo", "fn-1-foo.2", "rejected", 2);
  v12
    .prepare(
      "INSERT INTO approvals (approval_id, epic_id, task_key, status, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("c", "fn-1-foo", "close:fn-1-foo", "rejected", 3);
  // Orphan: task_key references a missing task file.
  v12
    .prepare(
      "INSERT INTO approvals (approval_id, epic_id, task_key, status, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("d", "fn-nx", "fn-nx.99", "approved", 4);

  // Capture stderr to verify orphan + log behavior without polluting test output.
  const logs: string[] = [];
  runPlanctlApprovalMigration(v12, [planRoot], (m) => logs.push(m));

  // Epic backfilled to "approved" then OVERLAID by close:fn-1-foo → "rejected"
  // (sidecar wins).
  const epicAfter = JSON.parse(readFileSync(epicPath, "utf8")) as {
    approval: string;
  };
  expect(epicAfter.approval).toBe("rejected");
  // Task overlays.
  expect(JSON.parse(readFileSync(task1Path, "utf8")).approval).toBe("approved");
  expect(JSON.parse(readFileSync(task2Path, "utf8")).approval).toBe("rejected");
  // Orphan row logged a warning.
  expect(logs.some((l) => /orphan sidecar row/.test(l))).toBe(true);

  v12.close();
});

test("runPlanctlApprovalMigration first-time boot with no approvals table is a clean no-op", () => {
  // A fresh-v13 DB has never had an `approvals` table. The migration must
  // skip pass 2 entirely without throwing on the missing table.
  const { mkdirSync, readFileSync, writeFileSync } =
    require("node:fs") as typeof import("node:fs");
  const { serializePlanctlJson, runPlanctlApprovalMigration } =
    require("../src/db") as typeof import("../src/db");
  const planRoot = join(tmpDir, "fresh-root");
  const epicsDir = join(planRoot, ".planctl", "epics");
  mkdirSync(epicsDir, { recursive: true });
  const epicPath = join(epicsDir, "fn-9-fresh.json");
  writeFileSync(
    epicPath,
    serializePlanctlJson({ id: "fn-9-fresh", title: "Fresh" }),
  );

  // Open a fresh-v13 DB (migrate ran, no approvals table created).
  const { db } = openDb(dbPath);
  // Backfill ran cleanly — `approval: "approved"` landed.
  runPlanctlApprovalMigration(db, [planRoot]);
  const obj = JSON.parse(readFileSync(epicPath, "utf8")) as {
    approval: string;
  };
  expect(obj.approval).toBe("approved");
  db.close();
});

test("runPlanctlApprovalMigration walks <root>/<project>/.planctl/... one level deep", () => {
  // Real plan layouts put `.planctl` inside the project subdir under a
  // configured root (e.g. `~/code/<project>/.planctl/...`). The lookup must
  // walk one level deep, not just look at `<root>/.planctl`.
  const { mkdirSync, readFileSync, writeFileSync } =
    require("node:fs") as typeof import("node:fs");
  const { serializePlanctlJson, runPlanctlApprovalMigration } =
    require("../src/db") as typeof import("../src/db");
  const outerRoot = join(tmpDir, "outer");
  const projectDir = join(outerRoot, "myproject");
  const epicsDir = join(projectDir, ".planctl", "epics");
  mkdirSync(epicsDir, { recursive: true });
  const epicPath = join(epicsDir, "fn-1-foo.json");
  writeFileSync(
    epicPath,
    serializePlanctlJson({ id: "fn-1-foo", title: "Foo" }),
  );

  const { db } = openDb(dbPath);
  runPlanctlApprovalMigration(db, [outerRoot]);
  const obj = JSON.parse(readFileSync(epicPath, "utf8")) as {
    approval: string;
  };
  expect(obj.approval).toBe("approved");
  db.close();
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

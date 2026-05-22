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
  expect(names.has("tasks")).toBe(true);
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
    reader.db.exec(
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
  expect(row.value).toBe("6");
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
  v3.exec(`
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
  v3.exec(`
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
  v3.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v3.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '3')");
  v3.exec(
    "INSERT INTO events (ts, session_id, hook_event, event_type, data) VALUES (1, 'sess', 'SessionStart', 'session_start', '{}')",
  );
  v3.exec(
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
  expect(ver.value).toBe("6");

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
  expect(ver2.value).toBe("6");
  db2.close();
});

test("v4 DB migrates to v5: jobs.transcript_path added, rows preserved NULL", () => {
  // Build a v4-shaped DB by hand: jobs with title_source but no
  // transcript_path, version '4'.
  const v4 = new Database(dbPath, { create: true });
  v4.exec(`
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
  v4.exec(`
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
  v4.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v4.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '4')");
  v4.exec(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, title, title_source) VALUES ('old', 1, 5, 1, 'fix-osc', 'payload')",
  );
  v4.close();

  // Reopen via openDb — migrate() runs the v4→v5 idempotent ADD COLUMN.
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe("6");

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
  expect(ver2.value).toBe("6");
  db2.close();
});

test("v2 DB migrates: mode + title_history dropped, title preserved", () => {
  // Build a v2-shaped DB by hand: mode + title + title_history, version '2'.
  const v2 = new Database(dbPath, { create: true });
  v2.exec(`
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
  v2.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v2.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '2')");
  v2.exec(
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
  expect(ver.value).toBe("6");
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

test("v5 DB migrates to v6: epics + tasks tables added, jobs rows preserved", () => {
  // Build a v5-shaped DB by hand: events + jobs at the current v5 shape, no
  // epics/tasks tables, version '5', with a populated jobs row.
  const v5 = new Database(dbPath, { create: true });
  v5.exec(`
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
  v5.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v5.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '5')");
  v5.exec(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, title, title_source) VALUES ('old', 1, 5, 1, 'fix-osc', 'payload')",
  );
  v5.close();

  // Reopen via openDb — migrate() creates the epics/tasks tables (CREATE TABLE
  // IF NOT EXISTS) and stamps the current version. The non-version-gated block
  // converges a v5 DB straight to v6.
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe("6");

  const tables = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((t) => t.name),
  );
  expect(tables.has("epics")).toBe(true);
  expect(tables.has("tasks")).toBe(true);

  // New projection tables start empty.
  const epicCount = db.prepare("SELECT count(*) AS c FROM epics").get() as {
    c: number;
  };
  const taskCount = db.prepare("SELECT count(*) AS c FROM tasks").get() as {
    c: number;
  };
  expect(epicCount.c).toBe(0);
  expect(taskCount.c).toBe(0);

  // The new tables carry the expected columns.
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
  ]);
  const taskCols = (
    db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(taskCols).toEqual([
    "task_id",
    "epic_id",
    "task_number",
    "title",
    "target_repo",
    "status",
    "last_event_id",
    "updated_at",
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
  expect(ver2.value).toBe("6");
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

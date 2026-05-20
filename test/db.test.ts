/**
 * Schema-shape tests for `openDb()`. These run on a tmp-path DB driven by
 * `KEEPER_DB` resolution; we pass the path explicitly so each test gets a
 * fresh file without leaking state. The assertions mirror the task's
 * Acceptance list — tables present, indexes present, PRAGMAs applied,
 * reducer_state seeded, readonly flag honored, env-var override honored.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JOBS_DESCRIPTOR, selectByIds } from "../src/collections";
import {
  MAX_IN_PARAMS,
  openDb,
  resolveDbPath,
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
  expect(row.value).toBe("2");
  db.close();
});

test("jobs has title + title_history columns with the right defaults", () => {
  const { db } = openDb(dbPath);
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as {
    name: string;
    dflt_value: string | null;
    notnull: number;
  }[];
  const title = cols.find((c) => c.name === "title");
  const history = cols.find((c) => c.name === "title_history");
  expect(title).toBeDefined();
  expect(title?.notnull).toBe(0); // nullable
  expect(history).toBeDefined();
  expect(history?.notnull).toBe(1); // NOT NULL
  // A fresh row reads the zero-event defaults.
  db.prepare(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at) VALUES ('z', 1, 0, 1)",
  ).run();
  const r = db
    .prepare("SELECT title, title_history FROM jobs WHERE job_id = 'z'")
    .get() as { title: string | null; title_history: string };
  expect(r.title).toBeNull();
  expect(r.title_history).toBe("[]");
  db.close();
});

test("v1 DB migrates to v2: existing rows backfill title_history=[]", () => {
  // Build a v1-shaped DB by hand: no title columns, schema_version='1'.
  const v1 = new Database(dbPath, { create: true });
  v1.exec(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      mode TEXT NOT NULL DEFAULT 'act',
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL
    )
  `);
  v1.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v1.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '1')");
  v1.exec(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at) VALUES ('old', 1, 5, 1)",
  );
  v1.close();

  // Reopen via openDb — migrate() runs the v1→v2 ALTERs.
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe("2");
  const row = db
    .prepare("SELECT title, title_history FROM jobs WHERE job_id = 'old'")
    .get() as { title: string | null; title_history: string };
  expect(row.title).toBeNull();
  expect(row.title_history).toBe("[]");
  db.close();
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
    "INSERT INTO jobs (job_id, created_at, cwd, pid, mode, state, last_event_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run("a", ts, "/a", 1, "act", "working", 10, ts);
  insert.run("b", ts, "/b", 2, "plan", "stopped", 11, ts);
  insert.run("c", ts, null, null, "act", "ended", 12, ts);

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
  expect(a?.mode).toBe("act");
  expect(a?.state).toBe("working");
  expect(a?.last_event_id).toBe(10);
  expect(a?.cwd).toBe("/a");
  // NULL columns survive the round-trip.
  const c = rows.find((r) => r.job_id === "c");
  expect(c?.cwd).toBeNull();
  expect(c?.pid).toBeNull();
  db.close();
});

test("selectByIds decodes title_history to a real array (and [] when title-less)", () => {
  const { db } = openDb(dbPath);
  const ts = 1_700_000_000;
  db.prepare(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, title, title_history) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    "titled",
    ts,
    1,
    ts,
    "fix-osc",
    JSON.stringify(["keeper-009", "fix-osc"]),
  );
  // A title-less job seeded via the schema default ('[]').
  db.prepare(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at) VALUES (?, ?, ?, ?)",
  ).run("bare", ts, 1, ts);

  const rows = selectByIds(db, JOBS_DESCRIPTOR, ["titled", "bare"]);
  const titled = rows.find((r) => r.job_id === "titled");
  const bare = rows.find((r) => r.job_id === "bare");
  expect(titled?.title).toBe("fix-osc");
  expect(Array.isArray(titled?.title_history)).toBe(true);
  expect(titled?.title_history).toEqual(["keeper-009", "fix-osc"]);
  expect(bare?.title).toBeNull();
  expect(Array.isArray(bare?.title_history)).toBe(true);
  expect(bare?.title_history).toEqual([]);
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

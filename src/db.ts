/**
 * Keeper SQLite layer. Owns:
 * - Schema bootstrap for `events`, `jobs`, `reducer_state`, `meta`.
 * - Connection-local PRAGMAs (WAL, busy_timeout, foreign_keys, synchronous,
 *   temp_store) — these MUST be re-applied on every open because they are
 *   per-connection in SQLite. The hook spawns a fresh connection per
 *   invocation; without busy_timeout it would default to 0 and any contention
 *   with the daemon would surface as SQLITE_BUSY instead of a wait.
 * - Prepared statements used by the hook and reducer.
 *
 * Schema migrations are forward-only via a `meta(schema_version)` row plus
 * idempotent CREATE TABLE / CREATE INDEX IF NOT EXISTS. No destructive
 * migrations in v1.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Current schema version. Bump only when adding an ALTER block to `migrate()`.
 * Forward-only — never reduce, never branch.
 */
export const SCHEMA_VERSION = 1;

/**
 * Resolve the keeper DB path. `KEEPER_DB` env var wins (used by tests and the
 * inspect CLI); otherwise default to `~/.local/state/keeper/keeper.db`. The
 * parent directory is created if missing — launchd doesn't pre-create state
 * dirs and the daemon must be able to bootstrap on a fresh machine.
 */
export function resolveDbPath(): string {
  const override = process.env.KEEPER_DB;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "keeper.db");
}

const CREATE_EVENTS = `
CREATE TABLE IF NOT EXISTS events (
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
`;

const CREATE_EVENTS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)",
  "CREATE INDEX IF NOT EXISTS idx_events_hook_event ON events(hook_event)",
  "CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type)",
  "CREATE INDEX IF NOT EXISTS idx_events_tool_name ON events(tool_name)",
  "CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)",
  "CREATE INDEX IF NOT EXISTS idx_events_pid_hook_tool ON events(pid, hook_event, tool_name)",
  // Partial index on the sparse subagent bridge column. Only PostToolUse:Agent
  // rows populate it; the WHERE predicate must match consumer queries
  // exactly for SQLite to use the index instead of a scan.
  "CREATE INDEX IF NOT EXISTS idx_events_subagent_agent_id ON events(subagent_agent_id) WHERE subagent_agent_id IS NOT NULL",
];

const CREATE_JOBS = `
CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    created_at REAL NOT NULL,
    cwd TEXT,
    pid INTEGER,
    mode TEXT NOT NULL DEFAULT 'act',
    state TEXT NOT NULL DEFAULT 'stopped',
    last_event_id INTEGER,
    updated_at REAL NOT NULL
)
`;

const CREATE_REDUCER_STATE = `
CREATE TABLE IF NOT EXISTS reducer_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_event_id INTEGER NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL
)
`;

const CREATE_META = `
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
)
`;

/**
 * Prepared statements used by hook + reducer hot paths. Keep these tiny and
 * pre-bound — the hook runs once per Claude Code event and cold-start latency
 * is part of the SessionEnd 1.5s timeout budget.
 */
export interface Stmts {
  insertEvent: ReturnType<Database["prepare"]>;
  selectEventsAfter: ReturnType<Database["prepare"]>;
  upsertJob: ReturnType<Database["prepare"]>;
  advanceCursor: ReturnType<Database["prepare"]>;
}

export interface OpenDbOptions {
  readonly?: boolean;
}

export interface KeeperDb {
  db: Database;
  stmts: Stmts;
}

/**
 * Apply connection-local PRAGMAs. Called on every open (writer + reader).
 *
 * - `journal_mode = WAL`: concurrent readers + single writer; the only safe
 *   mode for the hook+daemon pattern.
 * - `synchronous = NORMAL`: WAL-safe durability; FULL is overkill for an
 *   event log that the daemon re-folds idempotently on boot.
 * - `busy_timeout = 5000`: gives writers 5s to wait on a WAL checkpoint or
 *   another writer instead of erroring SQLITE_BUSY. CRITICAL: this is
 *   connection-local; the hook MUST re-set it per invocation.
 * - `foreign_keys = ON`: bun:sqlite does not auto-enable.
 * - `temp_store = MEMORY`: keeps spill files off disk.
 */
function applyPragmas(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA temp_store = MEMORY");
}

/**
 * Run schema bootstrap + forward-only ALTER block. Writer-only. Wrapped in a
 * single transaction so a half-applied schema can never persist across a
 * crashed boot.
 */
function migrate(db: Database): void {
  db.transaction(() => {
    db.exec(CREATE_EVENTS);
    for (const sql of CREATE_EVENTS_INDEXES) {
      db.exec(sql);
    }
    db.exec(CREATE_JOBS);
    db.exec(CREATE_REDUCER_STATE);
    db.exec(CREATE_META);

    // Seed singleton cursor on first boot. Subsequent boots are no-ops.
    db.exec(
      "INSERT OR IGNORE INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 0, unixepoch('now', 'subsec'))",
    );

    // Read current schema_version (NULL on first boot) and apply forward-only
    // ALTER blocks before stamping the new version. v1 has no ALTERs yet —
    // the slot exists so future tasks add them without rework.
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | null;
    const current = row ? Number.parseInt(row.value, 10) : 0;

    if (current < 1) {
      // Reserved slot for v1→v2 ALTERs. Add lines here as the schema grows.
    }

    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(SCHEMA_VERSION));
  })();
}

/**
 * Build the prepared-statement bundle. Shared between the hook (insertEvent)
 * and the reducer (selectEventsAfter/upsertJob/advanceCursor). Reader
 * connections get the bundle too — selectEventsAfter is read-only and the
 * write-targeting statements simply go unused.
 */
function prepareStmts(db: Database): Stmts {
  return {
    insertEvent: db.prepare(`
      INSERT INTO events (
        ts, session_id, pid, hook_event, event_type, tool_name, matcher,
        cwd, permission_mode, agent_id, agent_type, stop_hook_active, data,
        subagent_agent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    selectEventsAfter: db.prepare(`
      SELECT id, ts, session_id, pid, hook_event, event_type, tool_name,
             matcher, cwd, permission_mode, agent_id, agent_type,
             stop_hook_active, data, subagent_agent_id
        FROM events
       WHERE id > ?
       ORDER BY id ASC
       LIMIT ?
    `),
    upsertJob: db.prepare(`
      INSERT INTO jobs (
        job_id, created_at, cwd, pid, mode, state, last_event_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        cwd = COALESCE(excluded.cwd, jobs.cwd),
        pid = COALESCE(excluded.pid, jobs.pid),
        mode = excluded.mode,
        state = excluded.state,
        last_event_id = excluded.last_event_id,
        updated_at = excluded.updated_at
    `),
    advanceCursor: db.prepare(
      "UPDATE reducer_state SET last_event_id = ?, updated_at = ? WHERE id = 1",
    ),
  };
}

/**
 * Open a keeper DB connection.
 *
 * Writer (default): runs schema migration + seeds the reducer_state row.
 * Reader (`readonly: true`): opens read-only, applies the same PRAGMAs (for
 * data_version polling consistency), skips migration. Used by the wake worker
 * which must not contend on schema writes.
 *
 * The parent directory is auto-created for writer connections; readers fail
 * loudly if the DB file is missing — they have no business booting a fresh
 * keeper from scratch.
 */
export function openDb(path: string, options: OpenDbOptions = {}): KeeperDb {
  const readonly = options.readonly ?? false;

  if (!readonly) {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(
    path,
    readonly ? { readonly: true } : { create: true },
  );
  applyPragmas(db);

  if (!readonly) {
    migrate(db);
  }

  const stmts = prepareStmts(db);
  return { db, stmts };
}

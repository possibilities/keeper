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
 * idempotent steps: CREATE TABLE / CREATE INDEX IF NOT EXISTS, plus
 * `addColumnIfMissing` / `dropColumnIfPresent` ALTERs that converge on the
 * table's actual shape. Destructive steps (DROP COLUMN) are allowed only when
 * idempotent — they no-op once the column is gone, so re-running is safe.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Current schema version. Bump only when adding an ALTER block to `migrate()`.
 * Forward-only — never reduce, never branch.
 */
export const SCHEMA_VERSION = 6;

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

/**
 * Resolve the keeper UDS path. `KEEPER_SOCK` env var wins (override pattern
 * mirrors `resolveDbPath` — used by tests and any future inspect tooling);
 * otherwise default to `~/.local/state/keeper/keeperd.sock`, a sibling of the
 * DB file. The server worker is responsible for ensuring the parent directory
 * exists before bind; this resolver is pure and does no I/O.
 */
export function resolveSockPath(): string {
  const override = process.env.KEEPER_SOCK;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "keeperd.sock");
}

/** Default plan roots when the config file is absent or carries no `roots`. */
const DEFAULT_PLAN_ROOTS = ["~/code"];

/**
 * Default transcript watch root when the config file is absent or carries no
 * `claude_projects_root`. The external tree Claude Code writes session JSONL to.
 */
const DEFAULT_CLAUDE_PROJECTS_ROOT = "~/.claude/projects";

/**
 * Parsed keeper daemon config. `roots` are the directories keeperd
 * scans/watches for `.planctl` plan trees; `claude_projects_root` is the single
 * directory the transcript worker watches for session JSONL. The two keys are
 * INDEPENDENT — a malformed/missing one never disturbs the other.
 * Forward-compatible: unknown keys are ignored.
 */
export interface KeeperConfig {
  roots: string[];
  claudeProjectsRoot?: string;
}

/**
 * Resolve the keeper config path. `KEEPER_CONFIG` env var wins (hermetic tests
 * point it at a tmp file); otherwise default to `~/.config/keeper/config.yaml`.
 * Pure — does no I/O.
 */
export function resolveConfigPath(): string {
  const override = process.env.KEEPER_CONFIG;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".config", "keeper", "config.yaml");
}

/**
 * Read + parse the keeper config YAML via the native `Bun.YAML.parse` (no new
 * dependency). A missing file, a malformed document, or a missing/invalid
 * `roots:` key all fall back to the default single root (`~/code`); the same
 * goes for `claude_projects_root` (default `~/.claude/projects`). The config is
 * best-effort and must never throw past this resolver. The two keys resolve
 * INDEPENDENTLY from the same parsed document — a bad `roots` never disturbs
 * `claude_projects_root` and vice-versa. Only string entries of `roots` survive;
 * non-string junk is dropped. A non-string `claude_projects_root` falls back to
 * the default.
 */
export function resolveConfig(): KeeperConfig {
  const path = resolveConfigPath();
  let roots: string[] = [...DEFAULT_PLAN_ROOTS];
  let claudeProjectsRoot: string = DEFAULT_CLAUDE_PROJECTS_ROOT;
  try {
    if (!existsSync(path)) {
      return { roots, claudeProjectsRoot };
    }
    const raw = Bun.YAML.parse(readFileSync(path, "utf8")) as unknown;
    if (raw && typeof raw === "object") {
      if (Array.isArray((raw as { roots?: unknown }).roots)) {
        const parsed = (raw as { roots: unknown[] }).roots.filter(
          (r): r is string => typeof r === "string" && r.length > 0,
        );
        if (parsed.length > 0) {
          roots = parsed;
        }
      }
      const cpr = (raw as { claude_projects_root?: unknown })
        .claude_projects_root;
      if (typeof cpr === "string" && cpr.length > 0) {
        claudeProjectsRoot = cpr;
      }
    }
  } catch (err) {
    console.error(
      `[keeper] config parse failed (${path}); using defaults:`,
      err,
    );
    return {
      roots: [...DEFAULT_PLAN_ROOTS],
      claudeProjectsRoot: DEFAULT_CLAUDE_PROJECTS_ROOT,
    };
  }
  return { roots, claudeProjectsRoot };
}

/**
 * Resolve the configured plan roots to clean absolute path strings: expand a
 * leading `~` to `$HOME`, then drop any root that is not an existing directory
 * (skip-and-log) so one bad/typo'd root never silences the others. A root that
 * does not exist YET (created later, like the transcript root) is simply
 * skipped on this call — re-resolving picks it up once it appears. The worker
 * receives only absolute, currently-existing directories.
 */
export function resolvePlanRoots(): string[] {
  const home = homedir();
  const out: string[] = [];
  for (const entry of resolveConfig().roots) {
    const expanded =
      entry === "~"
        ? home
        : entry.startsWith("~/")
          ? join(home, entry.slice(2))
          : entry;
    try {
      if (statSync(expanded).isDirectory()) {
        out.push(expanded);
        continue;
      }
      console.error(
        `[keeper] plan root is not a directory, skipping: ${expanded}`,
      );
    } catch {
      console.error(`[keeper] plan root does not exist, skipping: ${expanded}`);
    }
  }
  return out;
}

/**
 * Resolve the transcript watch root to a single clean absolute path: expand a
 * leading `~` to `$HOME`, then return it. Mirrors `resolvePlanRoots`'s tilde
 * expander but SIMPLER — it does NOT existence-filter. The transcript root may
 * not exist yet on a fresh machine; returning the missing path is correct, and
 * the worker tolerates a not-yet-present root (it logs and skips the watch until
 * the tree appears). Defaults to `~/.claude/projects`.
 */
export function resolveClaudeProjectsRoot(): string {
  const home = homedir();
  const entry =
    resolveConfig().claudeProjectsRoot ?? DEFAULT_CLAUDE_PROJECTS_ROOT;
  if (entry === "~") {
    return home;
  }
  if (entry.startsWith("~/")) {
    return join(home, entry.slice(2));
  }
  return entry;
}

/**
 * SQLite default `SQLITE_MAX_VARIABLE_NUMBER` is 999 — `IN (?,?,...)` binds
 * one variable per id. Callers of `selectByIds` (`src/collections.ts`) must
 * chunk past this cap or cap their input. The server-worker page sizes
 * (default limit ~100, hard-capped well below 999) make a single query the
 * common case, but the constant is exported so chunking callers don't have to
 * magic-number it.
 */
export const MAX_IN_PARAMS = 999;

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
    subagent_agent_id TEXT,
    spawn_name TEXT
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
    state TEXT NOT NULL DEFAULT 'stopped',
    last_event_id INTEGER,
    updated_at REAL NOT NULL,
    title TEXT,
    title_source TEXT,
    transcript_path TEXT
)
`;

const CREATE_EPICS = `
CREATE TABLE IF NOT EXISTS epics (
    epic_id TEXT PRIMARY KEY,
    epic_number INTEGER,
    title TEXT,
    project_dir TEXT,
    status TEXT,
    last_event_id INTEGER,
    updated_at REAL NOT NULL DEFAULT 0
)
`;

const CREATE_TASKS = `
CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    epic_id TEXT,
    task_number INTEGER,
    title TEXT,
    target_repo TEXT,
    status TEXT,
    last_event_id INTEGER,
    updated_at REAL NOT NULL DEFAULT 0
)
`;

const CREATE_PLANS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_tasks_epic ON tasks(epic_id)",
];

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
 * Prepared statements kept pre-bound on the hot paths. Keep these tiny — the
 * hook runs once per Claude Code event and cold-start latency is part of the
 * SessionEnd 1.5s timeout budget.
 *
 * Only two statements remain: `insertEvent` (the hook's one write per
 * invocation; also reused by keeperd's main thread for synthetic events) and
 * `selectWorldRev` (the server worker's `rev` source). The reducer folds with
 * inline SQL (it reads/writes by event id and wraps each fold in its own
 * transaction), so it binds no statement from this bundle. The server worker's
 * variable-binding by-id read lives in `src/collections.ts` as `selectByIds`
 * (one statement per arity, descriptor-parameterized).
 */
export interface Stmts {
  insertEvent: ReturnType<Database["prepare"]>;
  selectWorldRev: ReturnType<Database["prepare"]>;
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
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA temp_store = MEMORY");
}

/**
 * Add a column to a table only if it isn't already present. The migrate block
 * runs on EVERY boot, and on a fresh DB the CREATE TABLE already defines the
 * new columns — so an unconditional `ALTER TABLE ... ADD COLUMN` would throw
 * "duplicate column name". Reading `PRAGMA table_info` makes the ALTER an
 * idempotent no-op when the column exists (forward-only: we never drop).
 */
function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  columnDef: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (cols.some((c) => c.name === column)) {
    return;
  }
  db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnDef}`);
}

/**
 * Drop a column only if it is still present. The mirror of
 * {@link addColumnIfMissing}: reading `PRAGMA table_info` first makes the DROP an
 * idempotent no-op once the column is gone, so the step can run on EVERY boot
 * (a fresh DB whose CREATE TABLE already omits the column simply skips it). This
 * is a destructive step, but an idempotent one — it converges on the column's
 * actual absence, never re-running and never failing on a second boot.
 */
function dropColumnIfPresent(
  db: Database,
  table: string,
  column: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === column)) {
    return;
  }
  db.run(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}

/**
 * Run schema bootstrap + forward-only ALTER block. Writer-only. Wrapped in a
 * single transaction so a half-applied schema can never persist across a
 * crashed boot.
 */
function migrate(db: Database): void {
  db.transaction(() => {
    db.run(CREATE_EVENTS);
    for (const sql of CREATE_EVENTS_INDEXES) {
      db.run(sql);
    }
    db.run(CREATE_JOBS);
    db.run(CREATE_EPICS);
    db.run(CREATE_TASKS);
    for (const sql of CREATE_PLANS_INDEXES) {
      db.run(sql);
    }
    db.run(CREATE_REDUCER_STATE);
    db.run(CREATE_META);

    // Seed singleton cursor on first boot. Subsequent boots are no-ops.
    db.run(
      "INSERT OR IGNORE INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 0, unixepoch('now', 'subsec'))",
    );

    // Apply forward-only schema changes, then stamp the new version. These run
    // on EVERY boot and are NOT gated on the stored schema_version: each step is
    // idempotent (addColumnIfMissing reads PRAGMA table_info and no-ops when the
    // column exists), so schema convergence is driven by the table's actual
    // shape, not by trusting the version number. This is deliberate — a version
    // stamped ahead of the real schema (e.g. an interrupted/premature migration)
    // would otherwise skip its ALTERs forever and wedge the reducer. A
    // non-idempotent step (a data backfill, a destructive change) would still
    // need a version guard; add that guard locally to the step that needs it.
    //
    // v1→v2: add the `title` column to `jobs`. ADD COLUMN does not rewrite
    // existing rows, so prior `jobs` rows backfill to `title=NULL` — matching
    // the zero-event projection. Column def matches CREATE_JOBS.
    addColumnIfMissing(db, "jobs", "title", "TEXT");

    // v2→v3: drop the `mode` and `title_history` columns from `jobs` — the
    // plan/act mode projection and the title-history array are both retired.
    // Idempotent (drops only if present), so this runs every boot and converges
    // whether the DB is a fresh v3 (CREATE TABLE already omits them) or an older
    // v1/v2 DB that still carries them. `events.permission_mode` and the
    // `session_title` data-blob field are untouched — only the `jobs`
    // projections of them are removed.
    dropColumnIfPresent(db, "jobs", "mode");
    dropColumnIfPresent(db, "jobs", "title_history");

    // v3→v4: add `events.spawn_name` (the parent claude process's --name/-n
    // session name, scraped by the hook at SessionStart) and `jobs.title_source`
    // (title provenance: NULL = priority 0 = zero-event reading, 'spawn' = 1,
    // 'payload' = 2). Both nullable, no backfill — ADD COLUMN leaves existing
    // rows reading NULL, which is exactly the zero-event/lowest-priority value.
    // Column defs match CREATE_EVENTS / CREATE_JOBS.
    addColumnIfMissing(db, "events", "spawn_name", "TEXT");
    addColumnIfMissing(db, "jobs", "title_source", "TEXT");

    // v4→v5: add `jobs.transcript_path` (the absolute path to the session's
    // transcript JSONL, seeded from the SessionStart payload's top-level
    // `transcript_path` field — display/debug only, never sorted/filtered). The
    // priority-3 'transcript' title source folds from a synthetic
    // `TranscriptTitle` event (title in `data.session_title`); it needs no new
    // `events` column. Nullable, no backfill — ADD COLUMN leaves prior rows NULL.
    // Column def matches CREATE_JOBS.
    addColumnIfMissing(db, "jobs", "transcript_path", "TEXT");

    // v5→v6: add the `epics` + `tasks` plan projection tables (created above via
    // CREATE TABLE IF NOT EXISTS, naturally idempotent and forward-only). No
    // ALTER, no backfill — the tables start empty and the plan reducer fills
    // them from synthetic EpicSnapshot/TaskSnapshot events. A v5 DB gains the
    // two empty tables on first open with all prior `jobs`/`events` rows intact.

    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(SCHEMA_VERSION));
  })();
}

/**
 * Build the prepared-statement bundle. `insertEvent` is the hook's per-event
 * write (also reused by keeperd's main thread for synthetic events);
 * `selectWorldRev` is the server worker's `rev` source. Reader connections get
 * the bundle too — `selectWorldRev` is read-only and `insertEvent` simply goes
 * unused. The reducer folds with inline SQL, so it binds nothing from here.
 */
function prepareStmts(db: Database): Stmts {
  return {
    insertEvent: db.prepare(`
      INSERT INTO events (
        ts, session_id, pid, hook_event, event_type, tool_name, matcher,
        cwd, permission_mode, agent_id, agent_type, stop_hook_active, data,
        subagent_agent_id, spawn_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    selectWorldRev: db.prepare(
      "SELECT last_event_id FROM reducer_state WHERE id = 1",
    ),
  };
}

// ---------------------------------------------------------------------------
// Read helpers for the server worker
// ---------------------------------------------------------------------------

/**
 * Read the singleton world rev (`reducer_state.last_event_id`). Returns 0 on
 * the empty-row corner case — fresh DBs always seed `(1, 0, ts)` so in
 * practice the SELECT lands a row, but the fallback keeps callers branch-free.
 *
 * Cheap (one row, no scan); the server worker calls this on every poll tick.
 */
export function selectWorldRev(stmts: Stmts): number {
  const row = stmts.selectWorldRev.get() as { last_event_id: number } | null;
  return row ? row.last_event_id : 0;
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

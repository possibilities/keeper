/**
 * Keeper SQLite layer. Owns:
 * - Schema bootstrap for `events`, `jobs`, `epics`, `reducer_state`, `meta`,
 *   and the `approvals` sidecar (schema v12 — NOT a reducer projection; the
 *   event-log re-fold determinism guarantee does not touch it, by design).
 *   (As of schema v7 each epic embeds its tasks as a JSON-array `epics.tasks`
 *   column; the standalone `tasks` table was dropped.)
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
import {
  extractSkillName,
  planVerbRefFromSpawnName,
  slashCommandFromPrompt,
} from "./derivers";

/**
 * Current schema version. Bump only when adding an ALTER block to `migrate()`.
 * Forward-only — never reduce, never branch.
 */
export const SCHEMA_VERSION = 13;

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
    spawn_name TEXT,
    start_time TEXT,
    slash_command TEXT,
    skill_name TEXT
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

/**
 * Indexes added in schema v10 that depend on columns added by the v9→v10
 * `addColumnIfMissing` step. KEPT OUT of {@link CREATE_EVENTS_INDEXES} so
 * the unconditional CREATE block doesn't try to index a column that doesn't
 * exist yet on a migrating v9 DB. `migrate()` runs these AFTER the matching
 * ADD COLUMNs in the v9→v10 block; a fresh v10 DB picks them up via the
 * same block (the addColumnIfMissing no-ops on the freshly CREATE'd table).
 * `WHERE col IS NOT NULL` is the canonical SQLite partial-index pattern
 * (sqlite.org/partialindex.html §2 Rule 2): the planner auto-matches any
 * equality/LIKE comparison on the indexed column when the predicate is
 * `IS NOT NULL`, so a `WHERE slash_command = '/plan:work'` / `WHERE
 * skill_name LIKE 'plan:%'` / `WHERE plan_ref = ...` query lands the index
 * instead of a scan.
 */
const CREATE_V10_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_slash_command ON events(slash_command) WHERE slash_command IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_events_skill_name ON events(skill_name) WHERE skill_name IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_jobs_plan_ref ON jobs(plan_ref) WHERE plan_ref IS NOT NULL",
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
    transcript_path TEXT,
    start_time TEXT,
    plan_verb TEXT,
    plan_ref TEXT
)
`;

const CREATE_EPICS = `
CREATE TABLE IF NOT EXISTS epics (
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
 * The `approvals` sidecar table (schema v12). Per-task approval state for the
 * autopilot UI — a row records the most recent `approve`/`reject` decision for
 * one `(epic_id, task_key)` pair. Absent row = "pending"; this avoids
 * backfilling a row per task at scan time and makes `clear` a trivially-safe
 * DELETE.
 *
 * `approval_id` is the real-column pk, populated by the writer (the future
 * `set_approval` RPC, Task .3) as `epic_id || ':' || task_key`. Keeping it a
 * bare column (not a compound expression interpolated through
 * `descriptor.pk`) honors the `src/collections.ts` injection invariant and
 * avoids the `WHERE epic_id || ':' || task_key IN (?,?,?)` pessimization on
 * `selectByIds`.
 *
 * `status` is a CHECK-constrained enum (`approved` / `rejected`) — defense in
 * depth alongside the RPC handler's wire-boundary validation. `updated_at` is
 * a REAL written as `unixepoch('now','subsec')` (sub-microsecond resolution
 * per the SQLite docs); the descriptor uses it as `version` so the diff
 * machinery fires on every UPSERT.
 *
 * This is NOT a reducer projection — the event-log re-fold determinism
 * guarantee does NOT extend to `approvals`. A fresh DB starts with the table
 * empty; rows arrive via the `set_approval` RPC writer connection.
 */
const CREATE_APPROVALS = `
CREATE TABLE IF NOT EXISTS approvals (
    approval_id TEXT PRIMARY KEY,
    epic_id TEXT NOT NULL,
    task_key TEXT NOT NULL,
    status TEXT CHECK(status IN ('approved', 'rejected')) NOT NULL,
    updated_at REAL NOT NULL,
    UNIQUE(epic_id, task_key)
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
    db.run(CREATE_REDUCER_STATE);
    db.run(CREATE_META);
    db.run(CREATE_APPROVALS);

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

    // v6→v7: collapse the standalone `tasks` table into an embedded JSON-array
    // column on `epics`. UNLIKE every step above, this carries a DATA BACKFILL
    // + a DROP TABLE — neither is idempotent (re-running would re-backfill an
    // already-emptied/dropped table, or splice nothing the second time). So the
    // step is VERSION-GUARDED: it runs only when the stored schema_version is
    // still < 7. The `tasks` column itself is added via the idempotent
    // addColumnIfMissing so a fresh v7 DB (CREATE_EPICS already defines it) and a
    // migrating v6 DB converge the same way; only the backfill + DROP are gated.
    //
    // The backfill's array ordering MUST equal the reducer's fold sort
    // (ORDER BY task_number, task_id) — a migrated row that differs from a
    // re-folded one would break the from-scratch re-fold determinism guard.
    // Orphan task rows (NULL/unknown epic_id) are NOT embedded — they are
    // dropped with the table (the per-epic subselect only matches t.epic_id =
    // epics.epic_id).
    addColumnIfMissing(db, "epics", "tasks", "TEXT NOT NULL DEFAULT '[]'");
    const storedVersion = Number(
      (
        db
          .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
          .get() as { value: string } | null
      )?.value ?? "0",
    );
    if (storedVersion < 7) {
      const tasksTableExists =
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'",
          )
          .get() != null;
      if (tasksTableExists) {
        db.run(
          `UPDATE epics SET tasks = COALESCE((
             SELECT json_group_array(json_object(
               'task_id', task_id,
               'epic_id', epic_id,
               'task_number', task_number,
               'title', title,
               'target_repo', target_repo,
               'status', status
             ))
               FROM (
                 SELECT * FROM tasks t
                  WHERE t.epic_id = epics.epic_id
                  ORDER BY task_number, task_id
               )
           ), '[]')
           WHERE tasks IS NULL OR tasks = '[]'`,
        );
        db.run("DROP TABLE IF EXISTS tasks");
      }
    }

    // v7→v8: add `epics.depends_on_epics` (epic-level dependency ids, a JSON-TEXT
    // array). Idempotent ADD COLUMN, NO backfill — the NOT NULL DEFAULT '[]'
    // matches the zero-event projection (an epic with no deps), and the plan
    // reducer fills it from EpicSnapshot blobs. Task-level `depends_on` needs no
    // schema change: it lives inside the embedded `tasks` JSON array. A migrating
    // v7 DB gains the column reading '[]'; a plan-file re-scan then repopulates
    // real deps. Column def matches CREATE_EPICS.
    addColumnIfMissing(
      db,
      "epics",
      "depends_on_epics",
      "TEXT NOT NULL DEFAULT '[]'",
    );

    // v8→v9: add `events.start_time` (process start instant scraped at the
    // SessionStart hook by task 3 — opaque platform-tagged string) and
    // `jobs.start_time` (projection of the seeded value, surfaced to consumers
    // for the (pid, start_time) recycle-safe identity used by the seed sweep and
    // exit-watcher). Both nullable, no backfill — ADD COLUMN leaves prior rows
    // reading NULL, matching the zero-event projection (a row whose SessionStart
    // pre-dated the schema bump simply never gains liveness coverage; the Q7
    // legacy-row rule documented in the epic handles that). Column defs match
    // CREATE_EVENTS / CREATE_JOBS.
    addColumnIfMissing(db, "events", "start_time", "TEXT");
    addColumnIfMissing(db, "jobs", "start_time", "TEXT");

    // v9→v10: index slash-command + Skill-tool invocations and project the
    // canonical `{plan,work,close}::<ref>` spawn-name verb/ref pair onto jobs
    // rows so consumers can associate planctl invocations with sessions
    // without JSON-scanning `events.data` blobs. Four new columns, three new
    // partial indexes (`events.slash_command`, `events.skill_name`,
    // `jobs.plan_ref`), plus a same-transaction backfill of every existing
    // row via the SAME pure derivers the hook + reducer use (single source
    // of truth — guarantees migrated rows byte-match steady-state ones).
    //
    // Column defs match CREATE_EVENTS / CREATE_JOBS literals so a fresh v10
    // DB and a migrated v9→v10 DB converge to identical schema (the
    // addColumnIfMissing/literal lockstep convention). The partial indexes
    // are CREATE INDEX IF NOT EXISTS above; a fresh DB picks them up via
    // CREATE_EVENTS_INDEXES/CREATE_JOBS_INDEXES, and a migrating DB picks
    // them up on the same boot — both paths converge to the same index set.
    addColumnIfMissing(db, "events", "slash_command", "TEXT");
    addColumnIfMissing(db, "events", "skill_name", "TEXT");
    addColumnIfMissing(db, "jobs", "plan_verb", "TEXT");
    addColumnIfMissing(db, "jobs", "plan_ref", "TEXT");

    // CREATE the v10 partial indexes AFTER the ADD COLUMNs they depend on.
    // A fresh v10 DB enters this block too — the addColumnIfMissing calls
    // above no-op (the columns already exist via CREATE_EVENTS/CREATE_JOBS
    // literals), and these CREATE INDEX IF NOT EXISTS calls land the same
    // index set on both a fresh-v10 and a migrating-v9 DB.
    for (const sql of CREATE_V10_INDEXES) {
      db.run(sql);
    }

    // Same-transaction JS-driven backfill. The slash-command anchored regex
    // and the skill-name shape-defensive read aren't expressible in SQLite
    // without REGEXP, so we walk events in JS and write derived columns
    // back via UPDATEs in the same BEGIN IMMEDIATE — if any UPDATE throws
    // the entire migration rolls back (ALTERs included), no half-state
    // possible.
    //
    // Version-guarded: a non-idempotent backfill must run AT MOST once. The
    // guard reads the meta row written by a PRIOR migrate() — on a fresh
    // DB (or one that crashed before stamping v10) `storedVersion < 10`
    // and the backfill runs; on a steady-state v10+ DB it skips, so a
    // second `openDb` is a clean no-op.
    const storedVersionV10 = Number(
      (
        db
          .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
          .get() as { value: string } | null
      )?.value ?? "0",
    );
    if (storedVersionV10 < 10) {
      // Backfill events: walk every row whose hook_event is a candidate for
      // either deriver (UserPromptSubmit → slash_command, Pre/PostToolUse
      // → skill_name), parse the stored `data` JSON, run the same derivers
      // the hook uses, write the two columns back. A row that doesn't match
      // either gate stays NULL — the derivers' gates short-circuit cleanly.
      //
      // The blob is parsed defensively (try/catch → null on malformed JSON):
      // historical rows include some malformed blobs, and a throw here would
      // wedge the migration. The derivers themselves never throw — every
      // shape-mismatch path returns null.
      //
      // IMPORTANT: We use `db.run(sql, params)` (sqlite3_prepare_v3 + step +
      // finalize each call — see Bun docs `Database.run`), NOT a cached
      // `db.prepare(...).run()` or `db.query(...).run()`. A prepared
      // statement compiled inside the same transaction as the ALTER it
      // depends on can pin the pre-ALTER schema metadata (the open
      // oven-sh/bun#1332 statement-cache gotcha called out in the epic's
      // Risks section). `db.run` is the documented uncached path and
      // sidesteps the pin completely. Backfill volume is bounded by the
      // historical event count, run only ONCE per DB upgrade.
      const rows = db
        .prepare(
          `SELECT id, hook_event, tool_name, data
             FROM events
            WHERE hook_event IN ('UserPromptSubmit', 'PreToolUse', 'PostToolUse')`,
        )
        .all() as {
        id: number;
        hook_event: string;
        tool_name: string | null;
        data: string;
      }[];
      for (const row of rows) {
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(row.data) as Record<string, unknown>;
        } catch {
          // malformed blob — skip derivation, columns stay NULL
        }
        let slashCommand: string | null = null;
        let skillName: string | null = null;
        if (parsed != null) {
          if (row.hook_event === "UserPromptSubmit") {
            slashCommand = slashCommandFromPrompt(parsed.prompt);
          }
          skillName = extractSkillName(row.hook_event, row.tool_name, parsed);
        }
        if (slashCommand != null || skillName != null) {
          db.run(
            "UPDATE events SET slash_command = ?, skill_name = ? WHERE id = ?",
            [slashCommand, skillName, row.id],
          );
        }
      }

      // Backfill jobs: for every job, look up its SessionStart event and run
      // the spawn-name parser. A job with no SessionStart row in the log
      // (orphan / hook crash) stays both-NULL. A job whose SessionStart
      // spawn_name doesn't match the strict whitelist also stays both-NULL.
      //
      // The SELECT picks the EARLIEST SessionStart by ts then id — matches
      // the reducer's first-sight upsert path (a duplicate SessionStart on
      // ON CONFLICT RESUME doesn't touch title/title_source/plan_verb/
      // plan_ref, so the FIRST row's spawn_name is what determines the
      // derived pair). The UPDATE uses the same uncached `db.run` path as
      // the events backfill above.
      const jobRows = db.prepare("SELECT job_id FROM jobs").all() as {
        job_id: string;
      }[];
      for (const job of jobRows) {
        const ev = db
          .prepare(
            `SELECT spawn_name
               FROM events
              WHERE session_id = ? AND hook_event = 'SessionStart'
              ORDER BY ts ASC, id ASC
              LIMIT 1`,
          )
          .get(job.job_id) as { spawn_name: string | null } | null;
        const { plan_verb, plan_ref } = planVerbRefFromSpawnName(
          ev?.spawn_name ?? null,
        );
        if (plan_verb != null && plan_ref != null) {
          db.run(
            "UPDATE jobs SET plan_verb = ?, plan_ref = ? WHERE job_id = ?",
            [plan_verb, plan_ref, job.job_id],
          );
        }
      }
    }

    // v10→v11: embed jobs into the `epics` projection. `epic.jobs` carries
    // plan/close-verb jobs (`plan_ref == epic_id`); each task element inside
    // `epic.tasks` carries its own `jobs` sub-array for work-verb jobs
    // (`plan_ref == task_id`). The reducer fans every `plan_ref`-bearing jobs
    // write into the correct array via `syncJobIntoEpic` (see
    // `src/reducer.ts`). Stored as JSON-TEXT; decoded at the read boundary.
    //
    // Column defs match CREATE_EPICS so a fresh v11 DB and a migrated v10→v11
    // DB converge to identical schema (the addColumnIfMissing/literal lockstep
    // convention). Idempotent ADD COLUMN — `addColumnIfMissing` reads PRAGMA
    // table_info and no-ops when the column exists.
    addColumnIfMissing(db, "epics", "jobs", "TEXT NOT NULL DEFAULT '[]'");

    // Version-guarded REWIND-AND-REDRAIN: rather than backfill the new
    // embedded `jobs` arrays directly, we set the cursor back to 0 and
    // `DELETE FROM jobs` / `DELETE FROM epics`. The boot drain (which runs
    // unconditionally after `migrate()` returns) then replays the entire
    // event log through the new v11 reducer — the SINGLE source of truth for
    // the embedded-jobs composition. A migrated row equals a re-folded one
    // byte-for-byte; no migration-specific composition logic to drift from
    // the steady-state reducer.
    //
    // Non-idempotent: must run AT MOST once per DB. The guard reads the
    // version stamped by a prior migrate() — on a fresh v11+ DB it skips
    // cleanly, so a second `openDb` is a no-op. Cost: re-folding the entire
    // event log inside the BEGIN IMMEDIATE — bounded by `events` row count,
    // seconds to tens of seconds on a developer machine. One-time.
    const storedVersionV11 = Number(
      (
        db
          .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
          .get() as { value: string } | null
      )?.value ?? "0",
    );
    if (storedVersionV11 < 11) {
      db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
      db.run("DELETE FROM jobs");
      db.run("DELETE FROM epics");
    }

    // v11→v12: add the `approvals` sidecar table (created above via
    // CREATE TABLE IF NOT EXISTS, naturally idempotent and forward-only).
    // No ALTER, no backfill — the table starts empty and the future
    // `set_approval` RPC fills it; the empty-table bootstrap matches the
    // zero-approval reading (absent row = "pending"). UNLIKE every step
    // above, `approvals` is NOT a reducer projection: the event-log re-fold
    // determinism guarantee does NOT touch it, by design. A v11 DB gains
    // the empty table on first open with all prior `jobs`/`epics`/`events`
    // rows intact.

    // v12→v13: add `epics.approval` (planctl-native approval state). Top-level
    // field on epic + task plan files (the fn-592-approval-as-planctl-field
    // epic), folded through the synthetic EpicSnapshot/TaskSnapshot pipeline.
    // Idempotent ADD COLUMN with `NOT NULL DEFAULT 'pending'` matching
    // CREATE_EPICS: existing rows backfill to `'pending'`, which is also what
    // the plan-worker emits when an old-planctl file omits the field — so a
    // re-fold of an existing event log reproduces the same `'pending'` reading
    // (re-fold determinism preserved). The data-overlay/backfill from the
    // schema-v12 `approvals` sidecar — and the DROP TABLE approvals — lands in
    // a later task (task .3 of this epic). Column def matches CREATE_EPICS so
    // a fresh v13 DB and a migrated v12→v13 DB converge to identical schema.
    addColumnIfMissing(
      db,
      "epics",
      "approval",
      "TEXT NOT NULL DEFAULT 'pending'",
    );

    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(SCHEMA_VERSION));
    // `.immediate()` issues BEGIN IMMEDIATE — grab the writer lock at BEGIN, so
    // a CREATE/ALTER/INSERT inside cannot lose the upgrade-to-writer race to a
    // concurrent hook write and surface as SQLITE_BUSY half-way through migrate.
    // Failure (lock unavailable past `busy_timeout`) is now clean and total at
    // BEGIN, never half-applied. Pairs with the same fix in `applyEvent`.
  }).immediate();
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
    // Named bindings (`$col`) instead of positional `?` — adding a column now
    // means touching THIS statement and the CREATE TABLE definition, with every
    // caller free to pass `$col: null` (or omit-keyed-via-spread) without
    // re-counting positional argument lists. The previous positional shape was
    // a column-shift hazard: a missed call site silently corrupted data
    // (`null` shifted into the next column's slot) without throwing. The fold
    // and the producer workers both share this statement; named bindings make
    // future column additions a localized edit.
    insertEvent: db.prepare(`
      INSERT INTO events (
        ts, session_id, pid, hook_event, event_type, tool_name, matcher,
        cwd, permission_mode, agent_id, agent_type, stop_hook_active, data,
        subagent_agent_id, spawn_name, start_time, slash_command, skill_name
      ) VALUES (
        $ts, $session_id, $pid, $hook_event, $event_type, $tool_name, $matcher,
        $cwd, $permission_mode, $agent_id, $agent_type, $stop_hook_active, $data,
        $subagent_agent_id, $spawn_name, $start_time, $slash_command, $skill_name
      )
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

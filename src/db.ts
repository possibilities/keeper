/**
 * Keeper SQLite layer. Owns:
 * - Schema bootstrap for `events`, `jobs`, `epics`, `git_status`,
 *   `reducer_state`, and `meta`. (As of schema v7 each epic embeds its tasks as a JSON-array
 *   `epics.tasks` column; the standalone `tasks` table was dropped. As of
 *   schema v13 the planctl-native `approval` lives as a top-level field on
 *   the planctl JSON files and rides through the EpicSnapshot/TaskSnapshot
 *   fold into `epics.approval` and each task element's `approval`; the
 *   `approvals` sidecar table — added in v12, dropped in v13 — is gone.)
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
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  extractBashMutation,
  extractPlanctlInvocation,
  extractSkillName,
  planVerbRefFromSpawnName,
  slashCommandFromPrompt,
} from "./derivers";
import { epicIsCompleted, projectBasename, resolveEpicDep } from "./epic-deps";
import {
  type ClassifierInvocation,
  computePlanWindows,
  deriveEpicLinks,
  deriveJobLinks,
  normalizePlanctlOp,
  type PlanWindow,
} from "./plan-classifier";
import type { ResolutionDiagnostic } from "./readiness-diagnostics";
import type { Epic, ResolvedEpicDep } from "./types";

/**
 * Current schema version. Bump only when adding an ALTER block to `migrate()`.
 * Forward-only — never reduce, never branch.
 */
export const SCHEMA_VERSION = 37;

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
 * Default agentuse state-dir watch root when the config file is absent or
 * carries no `agentuse_root`. The flat leaf dir agentuse writes per-profile
 * `<id>.json` envelopes to. Tests override this via the YAML key so the
 * usage worker never touches the user's real envelopes.
 */
const DEFAULT_AGENTUSE_ROOT = "~/.local/state/agentuse";

/**
 * Parsed keeper daemon config. `roots` are the directories keeperd
 * scans/watches for `.planctl` plan trees; `claude_projects_root` is the single
 * directory the transcript worker watches for session JSONL;
 * `agentuse_root` is the single directory the usage worker watches for
 * per-profile usage envelopes. The keys are INDEPENDENT — a malformed/missing
 * one never disturbs the others. Forward-compatible: unknown keys are ignored.
 */
export interface KeeperConfig {
  roots: string[];
  claudeProjectsRoot?: string;
  agentuseRoot?: string;
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
  let agentuseRoot: string = DEFAULT_AGENTUSE_ROOT;
  try {
    if (!existsSync(path)) {
      return { roots, claudeProjectsRoot, agentuseRoot };
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
      const aur = (raw as { agentuse_root?: unknown }).agentuse_root;
      if (typeof aur === "string" && aur.length > 0) {
        agentuseRoot = aur;
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
      agentuseRoot: DEFAULT_AGENTUSE_ROOT,
    };
  }
  return { roots, claudeProjectsRoot, agentuseRoot };
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
 * Resolve the agentuse watch root to a single clean absolute path. Mirrors
 * {@link resolveClaudeProjectsRoot}'s shape — tilde expansion, NO
 * existence-filter (the dir may not exist if agentuse has never run; the
 * usage-worker tolerates absence). Defaults to `~/.local/state/agentuse`;
 * overridable via the `agentuse_root` config key so hermetic integration
 * tests can point the worker at a tmp dir instead of the real per-user
 * envelopes.
 */
export function resolveUsageRoot(): string {
  const home = homedir();
  const entry = resolveConfig().agentuseRoot ?? DEFAULT_AGENTUSE_ROOT;
  if (entry === "~") {
    return home;
  }
  if (entry.startsWith("~/")) {
    return join(home, entry.slice(2));
  }
  return entry;
}

/**
 * Resolve the keeper dead-letter directory (fn-643). `KEEPER_DEAD_LETTER_DIR`
 * env wins (hermetic tests point it at a tmp dir, mirroring the hook's
 * matching override); otherwise default to `~/.local/state/keeper/dead-letters`,
 * a sibling of the DB file. The directory may not exist at daemon boot on a
 * fresh machine (the hook only creates it on a dropped INSERT); the
 * dead-letter worker tolerates absence — see the worker's existsSync guard.
 *
 * MUST match `resolveDeadLetterDir` in `plugin/hooks/events-writer.ts`
 * byte-for-byte — the hook is the sole writer of the NDJSON files and the
 * daemon is the sole reader, so a divergence would silently lose dead-letter
 * visibility. The hook keeps its own local copy because the hook is
 * forbidden from importing `bun:sqlite` (CLAUDE.md "No third-party deps in
 * the hook"); `src/db.ts` carries this duplicate for the daemon-side
 * import surface.
 */
export function resolveDeadLetterDir(): string {
  const override = process.env.KEEPER_DEAD_LETTER_DIR;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "dead-letters");
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
    skill_name TEXT,
    planctl_op TEXT,
    planctl_target TEXT,
    planctl_epic_id TEXT,
    planctl_task_id TEXT,
    planctl_subject_present INTEGER,
    tool_use_id TEXT,
    config_dir TEXT,
    planctl_queue_jump INTEGER,
    bash_mutation_kind TEXT,
    bash_mutation_targets TEXT
)
`;

const CREATE_EVENTS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)",
  "CREATE INDEX IF NOT EXISTS idx_events_hook_event ON events(hook_event)",
  "CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type)",
  "CREATE INDEX IF NOT EXISTS idx_events_tool_name ON events(tool_name)",
  "CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)",
  "CREATE INDEX IF NOT EXISTS idx_events_pid_hook_tool ON events(pid, hook_event, tool_name)",
  // (hook_event, tool_name) composite — the inferred-attribution self-join
  // (`findInferredAttributions`) scans all PreToolUse rows via the single-column
  // `idx_events_hook_event`; this lets the `pre` side seek straight to
  // PreToolUse:Bash. (`idx_events_pid_hook_tool` leads with `pid`, so it can't
  // serve a hook_event-first query.)
  "CREATE INDEX IF NOT EXISTS idx_events_hook_tool ON events(hook_event, tool_name)",
  // (hook_event, tool_name, ts) — the hoisted inferred-attribution window scan
  // (`computeRepoBashWindows`) bounds PreToolUse/PostToolUse:Bash by `ts`; the
  // trailing `ts` keeps that scan under the hook's 1.2s busy_timeout even on a
  // cold cache (measured ~1.8s → ~274ms), so an orphan-heavy GitSnapshot fold
  // never starves a concurrent hook INSERT.
  "CREATE INDEX IF NOT EXISTS idx_events_hook_tool_ts ON events(hook_event, tool_name, ts)",
  // Expression index on the Write/Edit tool's target path — THE hot path. The
  // explicit-attribution scan (`findExplicitAttributions`) matches
  // `json_extract(data,'$.tool_input.file_path') = ?` per dirty file; without
  // this it lands on `idx_events_hook_event` and runs `json_extract` over all
  // ~50k PostToolUse rows (measured 3.5s/file → multi-second GitSnapshot folds
  // that starve hook INSERTs). The partial WHERE + the expression match the
  // query EXACTLY so SQLite turns the scan into a sub-ms SEEK (verified). Pure
  // performance: index choice never changes fold results, so re-fold
  // determinism is untouched and no SCHEMA_VERSION bump is needed (idempotent).
  "CREATE INDEX IF NOT EXISTS idx_events_tool_file_path ON events(json_extract(data, '$.tool_input.file_path')) WHERE hook_event = 'PostToolUse' AND tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')",
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

/**
 * Indexes added in schema v14 that depend on the `planctl_op` column added by
 * the v13→v14 `addColumnIfMissing` step. Mirrors {@link CREATE_V10_INDEXES}'s
 * structure: KEPT OUT of {@link CREATE_EVENTS_INDEXES} so the unconditional
 * CREATE block doesn't reference a column that doesn't exist yet on a
 * migrating v13 DB. `migrate()` runs these AFTER the matching ADD COLUMNs in
 * the v13→v14 block; a fresh v14 DB picks them up via the same block (the
 * addColumnIfMissing no-ops on the freshly CREATE'd table).
 *
 * The composite `(session_id, id)` index with `WHERE planctl_op IS NOT NULL`
 * serves the per-session ordered scan that the classifier fan-out runs on
 * every triggering planctl event (added in task .5 — `syncPlanctlLinks`). The
 * WHERE predicate must match consumer queries syntactically for SQLite to use
 * the index instead of a scan. `ANALYZE events;` runs at the end of the v14
 * block so the planner seeds stats from the first post-upgrade query.
 */
const CREATE_V14_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_planctl_session ON events (session_id, id) WHERE planctl_op IS NOT NULL",
];

/**
 * Indexes added in schema v17 that depend on the `tool_use_id` column added by
 * the v16→v17 `addColumnIfMissing` step. Mirrors {@link CREATE_V10_INDEXES} /
 * {@link CREATE_V14_INDEXES} structure: KEPT OUT of
 * {@link CREATE_EVENTS_INDEXES} so the unconditional CREATE block doesn't
 * reference a column that doesn't exist yet on a migrating v16 DB. `migrate()`
 * runs these AFTER the matching ADD COLUMN in the v16→v17 block; a fresh v17
 * DB picks them up via the same block (the addColumnIfMissing no-ops on the
 * freshly CREATE'd table).
 *
 * `WHERE tool_use_id IS NOT NULL` is the canonical SQLite partial-index
 * pattern (sqlite.org/partialindex.html §2 Rule 2): the planner auto-matches
 * any equality on the indexed column when the predicate is `IS NOT NULL`, so
 * a `WHERE tool_use_id = ?` lookup (the SubagentStart/Stop fold's bridge
 * join, task .3) lands the index instead of a scan.
 */
const CREATE_V17_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_tool_use_id ON events(tool_use_id) WHERE tool_use_id IS NOT NULL",
];

/**
 * Schema-v17 `subagent_invocations` projection table. Composite primary key
 * `(job_id, agent_id, turn_seq)` mirrors the jobctl Python reference
 * (`apps/cli_common/cli_common/subagent_invocations.py`) minus the
 * `tokens` / `tool_use_count` fields. `turn_seq` is the per-job monotone
 * turn counter so re-entrant subagents in a session land on distinct rows.
 *
 * Defaults match the zero-event projection:
 * - `status='running'` is the SubagentStart-time value (a row is created
 *   when SubagentStart folds; flips to `'ok'` / `'failed'` / `'unknown'` on
 *   SubagentStop).
 * - `prompt_chars=0` so a row created by SubagentStart before its matching
 *   PreToolUse:Agent row reads zero — task .3's reducer backfills it via the
 *   `tool_use_id` bridge.
 *
 * Created in the v16→v17 migration block (idempotent CREATE TABLE IF NOT
 * EXISTS), so a migrating v16 DB and a fresh v17 DB both land the same
 * shape. The reducer cases that populate this table arrive in task .3; this
 * task ships the empty table + the bridge column + the partial index.
 */
const CREATE_SUBAGENT_INVOCATIONS = `
CREATE TABLE IF NOT EXISTS subagent_invocations (
    job_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    turn_seq INTEGER NOT NULL,
    ts REAL NOT NULL,
    tool_use_id TEXT,
    subagent_type TEXT,
    description TEXT,
    prompt_chars INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'running',
    duration_ms INTEGER,
    last_event_id INTEGER NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (job_id, agent_id, turn_seq)
)
`;

const CREATE_SUBAGENT_INVOCATIONS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_subagent_invocations_job ON subagent_invocations(job_id)",
];

/**
 * Tier 2 (fn-628) + Tier 4.1 (fn-634) always-run table-scoped indexes on
 * `epics`. Two complementary shapes:
 *
 * 1. `idx_epics_sort_path ON epics(sort_path, epic_id)` — Tier 2 (fn-628).
 *    Serves explicit-status / explicit-filter queries whose WHERE drops the
 *    descriptor's `defaultClause`. EQP shows `SCAN epics USING INDEX
 *    idx_epics_sort_path` (in-order index scan; WHERE applies as a filter
 *    against the indexed rows).
 *
 * 2. `idx_epics_default_visible ON epics(default_visible, sort_path, epic_id)
 *    WHERE default_visible = 1` — Tier 4.1 (fn-634). Serves the default
 *    no-wire-filter epics query. The schema-v32 `default_visible` VIRTUAL
 *    generated column collapses the cross-column `(status='open' OR
 *    approval!='approved')` predicate into a single-column equality
 *    SQLite can serve from a partial index: EQP shows `SEARCH epics USING
 *    (COVERING )?INDEX idx_epics_default_visible` — no SCAN, no temp B-tree
 *    for the ORDER BY. Realizes the forecast in fn-628's original comment
 *    (the OR-predicate filter was dominating the diffTick metaCount tail at
 *    ~3.1 s p95 by Tier 4 measurement); see
 *    `fn-634-contention-review-tier-4-default-visible`.
 *
 * `CREATE INDEX IF NOT EXISTS` is idempotent and forward-only; the
 * `default_visible` partial index is keyed on a column added by the v31→v32
 * migration block in `migrate()`, so the index command runs only after the
 * generated column lands.
 */
const CREATE_EPICS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_epics_sort_path ON epics(sort_path, epic_id)",
  "CREATE INDEX IF NOT EXISTS idx_epics_default_visible ON epics(default_visible, sort_path, epic_id) WHERE default_visible = 1",
];

/**
 * Tier 2 (fn-628) always-run partial composite indexes on `events` for the
 * reducer's `syncPlanctlLinks` cross-session sweep. Two indexes paired with a
 * UNION query rewrite at `src/reducer.ts` (~2371): the planner picks ONE
 * index per cross-column OR, so the original `(planctl_epic_id IN ... OR
 * planctl_target IN ...)` SCANned `idx_events_planctl_session` and only one
 * of the two new indexes was reachable. The UNION form decomposes into a
 * `COMPOUND QUERY` whose left branch SEARCHes `idx_events_planctl_epic` and
 * right branch SEARCHes `idx_events_planctl_target` — both new indexes hit,
 * dedup via temp B-tree, identical session_id set vs the prior
 * `SELECT DISTINCT ... OR ...` form.
 *
 * The `WHERE planctl_op IS NOT NULL` predicate mirrors `idx_events_planctl_session`
 * and satisfies SQLite's partial-index Rule 2 (sqlite.org/partialindex.html
 * §3): any comparison on a column declared `IS NOT NULL` in the index
 * satisfies the predicate, so consumer queries don't need to repeat the
 * predicate verbatim. Trailing `(session_id, id)` keeps the indexes covering
 * for the `SELECT session_id` projection without a heap row-lookup.
 *
 * Practice-scout measured ~12.6% insert overhead on the planctl-bearing
 * subset (~10% of all events) — bounded and acceptable. `CREATE INDEX IF
 * NOT EXISTS` is idempotent; no SCHEMA_VERSION bump.
 */
const CREATE_EVENTS_PLANCTL_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_planctl_epic ON events(planctl_epic_id, session_id, id) WHERE planctl_op IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_events_planctl_target ON events(planctl_target, session_id, id) WHERE planctl_op IS NOT NULL",
];

/**
 * Tier 2 (fn-628) always-run table-scoped index on `jobs`. Serves the default
 * jobs query (`WHERE state NOT IN ('ended','killed') ORDER BY created_at DESC,
 * job_id`). The index shape is `(created_at DESC, job_id, state)` — NOT
 * `(state, created_at DESC, job_id)`: SQLite cannot translate a `NOT IN`
 * predicate into a usable index-entry range on the leading column (negation
 * can't be mapped to a contiguous range), so a `state`-leading index would
 * land but never be picked by the planner. Putting `created_at DESC` as the
 * leader serves the ORDER BY directly; trailing `state` makes the index
 * covering for the post-seek filter. EQP shows `SCAN jobs USING COVERING
 * INDEX idx_jobs_created_state` — sort eliminated, no row-lookup heap fetch.
 */
const CREATE_JOBS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_jobs_created_state ON jobs(created_at DESC, job_id, state)",
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
    plan_ref TEXT,
    epic_links TEXT NOT NULL DEFAULT '[]',
    last_api_error_at REAL,
    last_api_error_kind TEXT,
    last_input_request_at REAL,
    last_input_request_kind TEXT,
    config_dir TEXT,
    git_dirty_count INTEGER NOT NULL DEFAULT 0,
    git_unattributed_to_live_count INTEGER NOT NULL DEFAULT 0,
    git_orphan_count INTEGER NOT NULL DEFAULT 0,
    profile_name TEXT
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
    jobs TEXT NOT NULL DEFAULT '[]',
    job_links TEXT NOT NULL DEFAULT '[]',
    last_validated_at TEXT,
    created_by_closer_of TEXT,
    sort_path TEXT NOT NULL DEFAULT '',
    queue_jump INTEGER NOT NULL DEFAULT 0,
    resolved_epic_deps TEXT,
    default_visible INTEGER NOT NULL GENERATED ALWAYS AS (CASE WHEN status='open' OR approval!='approved' THEN 1 ELSE 0 END) VIRTUAL
)
`;

const CREATE_GIT_STATUS = `
CREATE TABLE IF NOT EXISTS git_status (
    project_dir TEXT PRIMARY KEY,
    branch TEXT,
    head_oid TEXT,
    upstream TEXT,
    ahead INTEGER,
    behind INTEGER,
    dirty_count INTEGER NOT NULL DEFAULT 0,
    orphaned_count INTEGER NOT NULL DEFAULT 0,
    dirty_files TEXT NOT NULL DEFAULT '[]',
    orphaned_files TEXT NOT NULL DEFAULT '[]',
    jobs TEXT NOT NULL DEFAULT '[]',
    last_event_id INTEGER,
    updated_at REAL NOT NULL DEFAULT 0
)
`;

/**
 * Schema-v23 `usage` projection table — one row per agentuse profile
 * (`~/.local/state/agentuse/<id>.json`). The usage-worker watches that flat
 * leaf dir, mints `UsageSnapshot` / `UsageDeleted` synthetic events, and the
 * reducer folds them here via a single-row UPSERT.
 *
 * **Freshness fields are intentionally absent.** The source envelope carries
 * `fetched_at` / `next_fetch_at` / `last_successful_fetch_at` /
 * `last_skipped_fetch_at` which the producer fetches every ~90s even when the
 * underlying quota numbers haven't moved. The change-gate hash on the worker
 * side AND this projection both ignore those fields — so a fetch-only refresh
 * cycle produces zero events and zero projection churn. Future contributors:
 * do NOT add a freshness column here without re-reading the freshness-
 * exclusion discipline notes in `src/usage-worker.ts` (load-bearing).
 *
 * **Schema v35 (fn-642): colocated rate-limit columns.** `last_rate_limit_at`
 * + `last_rate_limit_session_id` mirror the matching `profiles` row so a
 * single `usage` subscribe carries the rate-limit annotation — `scripts/usage.ts`
 * collapses to a one-collection client. The join key is the derived
 * `profile_name = projectBasename(jobs.config_dir)` (the on-disk profile
 * directory's basename — agentuse and keeper agreed on this in agentuse
 * fd283d1), maintained on the `profiles` side and joined in via the
 * bidirectional reducer fan-out. The UsageSnapshot payload does NOT carry
 * these fields; they are populated server-side from `profiles`.
 *
 * Both columns are nullable: a usage row whose matching profile has not yet
 * hit a rate-limit (the steady state) reads NULL on both, and a `''`-sentinel
 * profile (default `~/.claude`, basename `""`) never joins by design. They
 * are carved out of the `projectUsageRow` `ON CONFLICT(id) DO UPDATE SET`
 * clause — a `UsageSnapshot` re-fold must NOT clobber the rate-limit
 * annotation a prior `RateLimited` fan-out wrote (mirrors the
 * `EpicSnapshot` carve-out for `tasks` / `jobs` / `job_links` /
 * `resolved_epic_deps`).
 */
const CREATE_USAGE = `
CREATE TABLE IF NOT EXISTS usage (
    id TEXT PRIMARY KEY,
    target TEXT,
    multiplier INTEGER,
    session_percent REAL,
    session_resets_at TEXT,
    week_percent REAL,
    week_resets_at TEXT,
    sonnet_week_percent REAL,
    sonnet_week_resets_at TEXT,
    last_rate_limit_at REAL,
    last_rate_limit_session_id TEXT,
    last_event_id INTEGER,
    updated_at REAL NOT NULL DEFAULT 0
)
`;

/**
 * Schema-v33 `profiles` projection table (fn-639) — one row per Claude profile
 * directory, keyed by `config_dir` (the `CLAUDE_CONFIG_DIR` env value the hook
 * captures on `SessionStart`, normalized at the hook boundary; the empty-string
 * sentinel `''` collapses NULL → default `~/.claude`). Correlates the last
 * `rate_limit` ApiError with each profile so renderers (`scripts/usage.ts`'s
 * "Rate limits by profile" block) can surface profile-level reset state below
 * the existing per-profile usage stacks.
 *
 * Maintained by two reducer fan-outs inside the existing `BEGIN IMMEDIATE`
 * transaction (cursor + projection advance together — never split across
 * transactions): the SessionStart arm `INSERT OR IGNORE`s a visible row for
 * every unique `config_dir` (quiet or not, `last_rate_limit_*` stay NULL), and
 * the dual-case `RateLimited`/`ApiError` arm gated on `kind === "rate_limit"`
 * UPSERTs `last_rate_limit_at` + `last_rate_limit_session_id` against the
 * session's `jobs.config_dir` (read in-transaction via the
 * `syncIfPlanRef` read-then-write precedent — null-guarded so a missing
 * jobs row skips quietly without throwing inside the open transaction).
 *
 * Both fan-outs use the SAME `COALESCE(config_dir,'')` expression so a NULL-
 * config session's rate limit lands on the exact `''` row it seeded — orphaned
 * or duplicate buckets are impossible by construction. Last-write-wins on
 * `last_rate_limit_at` follows the event log's append-only id ordering (no
 * `max()` guard needed; events fold in id order).
 *
 * Field semantics:
 * - `config_dir` (TEXT, PRIMARY KEY, NOT NULL): the Claude profile directory.
 *   `NOT NULL` is load-bearing — SQLite treats multiple NULL PK rows as
 *   distinct, so a nullable PK + `INSERT OR IGNORE` would NOT dedupe. The
 *   `''` sentinel collapses default `~/.claude` (sessions where
 *   `CLAUDE_CONFIG_DIR` was unset → `events.config_dir = NULL`).
 * - `profile_name` (TEXT, nullable): schema v35 (fn-642) — the derived
 *   `projectBasename(config_dir)` (the last path segment of the profile
 *   directory). Serves as the join key against `usage.id` so the
 *   bidirectional rate-limit fan-out lands on the matching usage row.
 *   Derivation is byte-identical at the SessionStart seed and the v35
 *   one-time backfill (same `projectBasename` helper). NULL only on rows
 *   minted before v35 that did not transit the backfill (defensive — the
 *   backfill runs once per upgrade boot and covers every row); the `''`
 *   sentinel's basename is `""` and the `profile_name != ''` guard on
 *   both sides of the join keeps `''`-sentinel rows out of the join.
 * - `last_rate_limit_at` (REAL, nullable): unix-seconds of the latest
 *   `RateLimited` / `ApiError(kind="rate_limit")` fold for any session under
 *   this profile. NULL until the first rate_limit lands — a seed-only row
 *   (every quiet profile) reads NULL here.
 * - `last_rate_limit_session_id` (TEXT, nullable): the `jobs.job_id` of the
 *   session whose rate_limit minted `last_rate_limit_at`. Paired with the
 *   timestamp; both are NULL together (seed-only row) or both populated.
 * - `last_event_id` (INTEGER, nullable): the `events.id` of the latest
 *   contributing event — display/debug; also the descriptor's `version`
 *   column so the wire diff fires on every fan-out write.
 * - `updated_at` (REAL, NOT NULL, DEFAULT 0): unix-seconds of the latest
 *   reducer write — mirrors every other projection table.
 *
 * Defaults match the zero-event projection: a fresh DB with zero events has
 * zero rows; the SessionStart fan-out is the only seed path, so the table
 * stays empty until the first session arrives. Re-fold determinism: both
 * fan-outs read only the event payload (`event.config_dir`, `event.ts`,
 * `event.id`, `event.session_id`) and the in-transaction `jobs.config_dir`,
 * never `Date.now()`/env/OS state.
 */
const CREATE_PROFILES = `
CREATE TABLE IF NOT EXISTS profiles (
    config_dir TEXT NOT NULL PRIMARY KEY,
    profile_name TEXT,
    last_rate_limit_at REAL,
    last_rate_limit_session_id TEXT,
    last_event_id INTEGER,
    updated_at REAL NOT NULL DEFAULT 0
)
`;

/**
 * Schema-v34 `epic_dep_edges` reverse-dependency index (fn-637). One row per
 * `(consumer_epic, raw_dep_token)` edge — the reverse adjacency list of
 * `epics.depends_on_epics`. Keyed on `(consumer_id, dep_token)` so a forward
 * rebuild (task .3) can wipe-and-reinsert a consumer's edges atomically inside
 * the open `BEGIN IMMEDIATE` transaction, and a paired index on `dep_token`
 * serves the reverse fan-out lookup ("every consumer that depends on token X")
 * the task-.3 `EpicSnapshot` / `EpicDeleted` arms need to re-stamp downstream
 * consumers when an upstream epic changes state.
 *
 * Field semantics:
 * - `consumer_id` (TEXT, part of PK): the `epics.epic_id` of the consumer
 *   epic whose `depends_on_epics` array contains this `dep_token`.
 * - `dep_token` (TEXT, part of PK): the raw token from the consumer's
 *   `depends_on_epics` JSON array — verbatim, NOT the resolved id. Raw-token
 *   keying is resolution-independent: a dangling/ambiguous dep has no resolved
 *   id to key on, and the codebase explicitly rejected resolved-id keying
 *   (the consumer would fall out of the index when its dep is dangling, and
 *   never get re-stamped when disambiguation becomes possible). Keying on the
 *   raw token handles ambiguity flips natively — the upstream `EpicSnapshot`
 *   carries the new epic_number; the reverse lookup against the raw token
 *   (e.g. a bare number `"7"`, a slug like `"fn-7"`, or a full id) finds every
 *   consumer whose dep could match the new candidate, and the per-consumer
 *   re-resolve in task .3 promotes/demotes the state from there.
 *
 * Defaults match the zero-event projection: a fresh DB with zero events has
 * zero rows here (no epics → no edges). The table populates organically from
 * task .3's reducer fan-out (a forward stamp on every `EpicSnapshot` rebuilds
 * the consumer's edges; a `EpicDeleted` for a consumer wipes them). A from-
 * scratch re-fold rebuilds the table byte-deterministically from the event
 * log; the reverse-dep fan-out is the only producer.
 */
const CREATE_EPIC_DEP_EDGES = `
CREATE TABLE IF NOT EXISTS epic_dep_edges (
    consumer_id TEXT NOT NULL,
    dep_token TEXT NOT NULL,
    PRIMARY KEY (consumer_id, dep_token)
)
`;

/**
 * Schema-v34 reverse-lookup index on `epic_dep_edges.dep_token`. Pairs with
 * the table above. The composite PK `(consumer_id, dep_token)` is the leading-
 * `consumer_id` index SQLite implicitly builds; the task-.3 reverse fan-out
 * keys off `dep_token` ALONE ("every consumer whose `depends_on_epics`
 * contains token X"), which needs a dedicated index with `dep_token` first.
 * Without it, the fan-out would SCAN the table on every upstream snapshot.
 */
const CREATE_EPIC_DEP_EDGES_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_epic_dep_edges_dep_token ON epic_dep_edges(dep_token)",
];

/**
 * Schema-v37 `dead_letters` OPERATIONAL sidecar table (fn-643) — one row per
 * recovered hook-INSERT failure. NOT a reducer projection: this table is
 * populated by the daemon's import path (task .3, scanning the per-pid NDJSON
 * dead-letter files the hook writes when its `events` INSERT exhausts the
 * bounded retry) and never folded from events. The whole point of the table
 * is visibility into events that NEVER MADE IT into the event log — so a
 * from-scratch re-fold (rewind cursor, `DELETE FROM jobs; DELETE FROM epics`)
 * MUST NOT delete or touch `dead_letters`: the rows are the daemon's
 * operational record of dropped hook events, orthogonal to the projection
 * graph. The replay verb (task .4) is the only way a row transitions from
 * `waiting` → `recovered`: it appends a plain real event built from the
 * row's saved `bindings` and flips `status` + stamps `recovered_at` +
 * `replayed_event_id` in ONE transaction, so the recovered event folds into
 * the projection through the normal id-ordered drain.
 *
 * Field semantics:
 * - `dl_id` (TEXT, PRIMARY KEY): the hook-generated UUID stamped on the
 *   NDJSON record. The import path's idempotency key — a re-scan of a
 *   `.ndjson` file that's already imported finds matching `dl_id`s and
 *   short-circuits (`INSERT OR IGNORE`), so re-imports never duplicate a
 *   row.
 * - `session_id` (TEXT, NOT NULL): the Claude Code session id from the
 *   dropped insert binding. Display + correlation against the board's
 *   `jobs` rows.
 * - `hook_event` (TEXT, NOT NULL): the dropped event's hook event name
 *   (`SessionStart`, `UserPromptSubmit`, etc.) — useful at a glance for
 *   the board's warn-count tooltip ("waiting: 1 SessionStart").
 * - `ts` (REAL, NOT NULL): the dropped event's own unix-seconds timestamp,
 *   preserved verbatim through the NDJSON record. The replay path
 *   re-uses this `ts` on the appended real event so a re-fold lands the
 *   recovered row at the correct historical position in the reducer's
 *   `last_event_id`-ordered drain.
 * - `dl_written_at` (REAL, NOT NULL): unix-seconds when the hook wrote
 *   the NDJSON record. Distinct from `ts` — `ts` is the EVENT's wall
 *   time; `dl_written_at` is the dead-letter file's write time, and the
 *   "oldest waiting first" replay pick orders on it.
 * - `pid` (INTEGER): the hook process pid (for debugging — the per-pid
 *   NDJSON file naming aligns with this column).
 * - `bindings` (TEXT, NOT NULL): the FULL insert-binding set the hook
 *   would have run against `events` (all derived columns + the
 *   SessionStart-scraped `spawn_name` / `start_time` / `config_dir`),
 *   serialized as JSON. The replay path deserializes this back to bound
 *   parameters and runs the same insert it would have run originally —
 *   so the recovered event row is byte-identical to what the hook would
 *   have produced (modulo the `id` SQLite assigns, which the replay path
 *   captures into `replayed_event_id`).
 * - `status` (TEXT, NOT NULL, DEFAULT 'waiting'): `waiting | recovered`.
 *   The board reads `status='waiting'` for the warn count via the
 *   collection descriptor's `defaultFilter` below. The replay flips
 *   `waiting → recovered` inside the same `BEGIN IMMEDIATE` that appends
 *   the real event; no other transitions.
 * - `recovered_at` (REAL, nullable): unix-seconds when the replay flipped
 *   the row. NULL while `status='waiting'`; both populate together on
 *   replay.
 * - `replayed_event_id` (INTEGER, nullable): the `events.id` of the
 *   appended real event. NULL while `status='waiting'`; populates on
 *   replay so the audit trail joins the dead-letter row back to the
 *   recovered event.
 * - `source_file` (TEXT, nullable): the per-pid NDJSON file path the row
 *   was imported from (display + debugging — "this dead letter came from
 *   this pid file"). Nullable so a future direct-RPC injection path
 *   (out of scope here) doesn't need to fabricate a file name.
 *
 * Defaults match the zero-event-log projection: a fresh DB has zero
 * `dead_letters` rows, and the table populates only from the daemon's
 * import scan (task .3) — never from event-log folds.
 */
const CREATE_DEAD_LETTERS = `
CREATE TABLE IF NOT EXISTS dead_letters (
    dl_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    hook_event TEXT NOT NULL,
    ts REAL NOT NULL,
    dl_written_at REAL NOT NULL,
    pid INTEGER,
    bindings TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting',
    recovered_at REAL,
    replayed_event_id INTEGER,
    source_file TEXT
)
`;

/**
 * Schema-v37 index on `dead_letters` (fn-643). Serves the two access paths:
 * (a) the board's warn-count "how many waiting dead letters" — a partial-index
 * scan keyed by `status='waiting'`, and (b) the replay verb's "oldest waiting
 * first" pick — sorted by `dl_written_at ASC`. The composite (status,
 * dl_written_at) covers both, and SQLite's planner uses the leading
 * `status` column for the equality narrowing.
 */
const CREATE_DEAD_LETTERS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_dead_letters_status_written_at ON dead_letters(status, dl_written_at)",
];

/**
 * Schema-v31 `file_attributions` projection table — one row per
 * `(project_dir, session_id, file_path)` triple. Records the attribution claim
 * that this session has at least one mutation (tool or bash) on this file in
 * this project that has NOT been discharged by a later commit.
 *
 * Maintained by the reducer's `projectGitStatus` arm (task 6) inside the same
 * `BEGIN IMMEDIATE` transaction as the `git_status` write + cursor advance, so
 * a from-scratch re-fold rebuilds the table byte-deterministically from the
 * immutable event log. The discharge rule lives in this column shape: a row
 * exists for as long as the session is on-the-hook for a still-dirty file;
 * `last_commit_at` advances past `last_mutation_at` to clear the attribution
 * (the row stays for the historical record; the readiness pass filters by the
 * inequality), and a fresh mutation flips the same row back into the
 * on-the-hook state by bumping `last_mutation_at` past `last_commit_at`.
 *
 * The composite primary key `(project_dir, session_id, file_path)` carries
 * three orthogonal axes: the same file path under two different worktrees
 * lands two distinct rows (different `project_dir`), and two sessions touching
 * the same file under the same worktree land two distinct rows (different
 * `session_id`). Both are the desired semantics — multi-attribution per file
 * is the whole point of this epic.
 *
 * Field semantics:
 * - `project_dir` (TEXT, part of PK): the git project root for this
 *   attribution, from the `GitSnapshot` event's `project_dir` field.
 * - `session_id` (TEXT, part of PK): the keeper job/session id whose
 *   mutation/Bash event minted the attribution.
 * - `file_path` (TEXT, part of PK): the path of the dirty file, normalized
 *   relative to `project_dir` to match the git status canonical form.
 * - `last_mutation_at` (REAL, NOT NULL): unix-seconds of the latest
 *   mutation event from this session on this file. Bumped on every fresh
 *   mutation (re-edits put the session back on the hook).
 * - `last_commit_at` (REAL, nullable): unix-seconds of the most recent
 *   `Commit` event from this session whose `files` list contains this
 *   `file_path`. NULL while the session has never committed this file.
 *   The readiness rule fires "attributed iff `last_commit_at IS NULL OR
 *   last_commit_at < last_mutation_at`".
 * - `op` (TEXT, NOT NULL): the latest mutation kind — display-only at this
 *   layer (the reducer doesn't gate on the literal value); free-form so
 *   future ops (Edit/Write/MultiEdit/Bash kinds) extend without a schema bump.
 * - `source` (TEXT, NOT NULL, CHECK): provenance — `'tool'` for Edit/Write/
 *   MultiEdit, `'bash'` for the new `bash_mutation_kind` deriver column,
 *   `'inferred'` for time-bracket attribution against Bash event intervals.
 *   The CHECK constraint keeps the enum honest at the storage layer.
 * - `last_event_id` (INTEGER, nullable): the `events.id` of the latest
 *   contributing event. Display/debug.
 * - `updated_at` (REAL, NOT NULL, DEFAULT 0): unix-seconds of the latest
 *   reducer write — mirrors the convention on every other projection table.
 *
 * Defaults match the zero-event projection: every required field has either
 * a `NOT NULL` constraint requiring an explicit insert value, or a `DEFAULT`
 * matching the empty state. A fresh DB with zero events has zero rows here.
 */
const CREATE_FILE_ATTRIBUTIONS = `
CREATE TABLE IF NOT EXISTS file_attributions (
    project_dir TEXT NOT NULL,
    session_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    last_mutation_at REAL NOT NULL,
    last_commit_at REAL,
    op TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('tool','bash','inferred')),
    last_event_id INTEGER,
    updated_at REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (project_dir, session_id, file_path)
)
`;

/**
 * Schema-v31 indexes on `file_attributions`. Both are full (non-partial)
 * indexes — every row is a valid attribution claim, so a partial predicate
 * would only narrow by row-count parity (zero benefit, extra cost on inserts).
 *
 * - `idx_file_attributions_file (project_dir, file_path)`: serves the
 *   per-file multi-attribution read — "all sessions on the hook for this
 *   file in this project". Leading `project_dir` so a worktree-scoped scan
 *   is index-served end-to-end.
 * - `idx_file_attributions_session (session_id)`: serves the per-session
 *   "what files am I on the hook for" read — used by the reducer's
 *   per-job fan-out when a `GitRootDropped` retraction needs to walk every
 *   attribution belonging to a session that was just retracted.
 */
const CREATE_FILE_ATTRIBUTIONS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_file_attributions_file ON file_attributions(project_dir, file_path)",
  "CREATE INDEX IF NOT EXISTS idx_file_attributions_session ON file_attributions(session_id)",
];

/**
 * Schema-v31 partial index on `events.bash_mutation_kind`. Pairs with the new
 * sparse column added in the v30→v31 ALTER block. Mirrors {@link
 * CREATE_V10_INDEXES} structure: KEPT OUT of {@link CREATE_EVENTS_INDEXES} so
 * the unconditional CREATE block doesn't reference a column that doesn't
 * exist yet on a migrating v30 DB. `migrate()` runs this AFTER the matching
 * ADD COLUMN in the v30→v31 block; a fresh v31 DB picks it up via the same
 * block (the `addColumnIfMissing` no-ops on the freshly CREATE'd table).
 *
 * `WHERE bash_mutation_kind IS NOT NULL` is the canonical SQLite partial-
 * index pattern (sqlite.org/partialindex.html §2 Rule 2): the planner
 * auto-matches any equality/LIKE comparison on the indexed column when the
 * predicate is `IS NOT NULL`, so a `WHERE bash_mutation_kind = 'mutates'`
 * scan from the reducer's bash-attribution fold (task 6) lands the index
 * instead of a full events scan.
 */
const CREATE_V31_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_bash_mutation_kind ON events(bash_mutation_kind) WHERE bash_mutation_kind IS NOT NULL",
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
  /**
   * Run schema convergence (`migrate(db)`) after opening. Defaults to `true`
   * for writer connections; readers skip migration unconditionally regardless
   * of this flag. The hook (`plugin/hooks/events-writer.ts`) passes `false`
   * so the daemon remains the sole migrator — a fresh-install ordering
   * constraint that the README spells out (the LaunchAgent boots the daemon
   * before any Claude Code session starts; hook events arriving against a
   * missing/stale schema fail INSERT and exit 0 per the hook's "never block
   * Claude" contract).
   */
  migrate?: boolean;
  /**
   * Connection-local `busy_timeout` in ms (default 5000). Set FIRST in
   * {@link applyPragmas} so the `journal_mode = WAL` switch waits instead of
   * failing instantly under contention. The hook passes `1200` to stay inside
   * Claude's SessionEnd budget.
   */
  busyTimeoutMs?: number;
  /**
   * Per-connection page-cache cap in KB (negative `PRAGMA cache_size`). Omit on
   * the short-lived hook (keeps the small default per spawn); the long-running
   * daemon passes a large value so it retains hot pages across folds instead of
   * re-reading cold pages from the ~850MB log.
   */
  cacheSizeKb?: number;
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
 * - `mmap_size`: memory-map the DB so pages are served from the OS page cache
 *   instead of per-page `read()` syscalls. The event log is ~850MB; with mmap
 *   OFF (the SQLite default) and an ~8MB page cache, a fold that touches cold
 *   pages paid seconds of I/O and held the write lock long enough to starve
 *   concurrent hook INSERTs into dead-letters (measured: a window scan
 *   1486ms cold → 33ms with mmap). mmap is virtual address space backed by the
 *   shared OS page cache — negligible per-connection cost, so the short-lived
 *   hook benefits too without committing heap.
 */
function applyPragmas(
  db: Database,
  busyTimeoutMs = 5000,
  cacheSizeKb?: number,
): void {
  // busy_timeout FIRST. The `journal_mode = WAL` switch below needs a brief
  // write lock; with SQLite's default busy_timeout of 0 it fails INSTANTLY with
  // SQLITE_BUSY under any concurrent writer — the `open:SQLITE_BUSY` hook drops
  // (wait=0ms) the drop-log surfaced. Setting the timeout first makes that
  // switch (and every later statement) wait. Connection-local; the hook passes
  // its tighter `busyTimeoutMs` so the WAL switch can't blow its 1.5s budget.
  db.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA temp_store = MEMORY");
  // 4 GiB cap (SQLite clamps to its compile-time max). mmap serves pages from
  // the shared OS page cache once resident — it removes read() syscall overhead
  // but NOT the first cold disk read, so it pairs with cache_size below.
  db.run("PRAGMA mmap_size = 4294967296");
  // Large per-connection page cache (negative = KB cap). The long-running
  // daemon RETAINS hot index/data pages across folds instead of re-reading cold
  // pages from the ~850MB log — the default ~8MB cache evicts constantly, so a
  // fold that revisits the attribution indexes paid seconds of cold I/O and
  // starved hook INSERTs. Only the daemon passes this; the short-lived hook
  // keeps the small default so each per-invocation spawn stays cheap.
  if (cacheSizeKb != null && cacheSizeKb > 0) {
    db.run(`PRAGMA cache_size = -${cacheSizeKb}`);
  }
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
 * Add a GENERATED ALWAYS column to a table only if it isn't already present.
 * Mirror of {@link addColumnIfMissing} with one critical difference: the
 * presence check reads `PRAGMA table_xinfo` (NOT `PRAGMA table_info`).
 * Generated columns — STORED or VIRTUAL — are excluded from `table_info` per
 * SQLite's behavior; only `table_xinfo` enumerates them. Using `table_info`
 * here would re-attempt the ALTER on every boot after the first migration
 * and throw "duplicate column" at the next reopen, wedging the daemon at
 * launch.
 *
 * SQLite forbids `ALTER TABLE ADD COLUMN ... STORED` — only `VIRTUAL` is
 * allowed via ALTER. Callers must include the `GENERATED ALWAYS AS (...)
 * VIRTUAL` clause in `columnDef`. (Fresh DBs land the column via the
 * `CREATE_*` literal which DOES support STORED, but the lockstep convention
 * across this file is that the literal and the ALTER produce the same
 * schema shape — VIRTUAL in both places.)
 *
 * Idempotence + forward-only: a second call on an already-migrated DB
 * no-ops via the xinfo presence check; the helper never drops or rewrites.
 * Same contract as `addColumnIfMissing`.
 */
function addGeneratedColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  columnDef: string,
): void {
  const cols = db.prepare(`PRAGMA table_xinfo(${table})`).all() as {
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
 * Rename a column only if the OLD name is still present AND the NEW name is
 * not. Quad-state idempotence covers every re-run case:
 *   - Old present, new absent → run the ALTER (the migration path).
 *   - Old absent, new present → already renamed; no-op (re-running migrate()
 *     against an already-migrated DB).
 *   - Old absent, new absent → table doesn't have either yet; no-op (caller
 *     mis-ordered the migration step, or a future contributor dropped the
 *     column entirely).
 *   - Old present, new present → both columns coexist. This is the
 *     **fresh-DB** path under the addColumnIfMissing/literal lockstep
 *     convention: when a v30→v31 ALTER pair renames `git_orphan_count` to
 *     `git_unattributed_to_live_count` and adds a fresh `git_orphan_count`,
 *     the CREATE_JOBS literal MUST carry both names from scratch (otherwise
 *     a fresh-DB schema would differ from a migrated one). On a fresh boot
 *     CREATE_JOBS lands both columns BEFORE the migrate block reaches
 *     `renameColumnIfPresent`, so the helper sees both present. The
 *     correct fresh-DB action is "no-op" — the target schema is already
 *     there. (A genuine drift scenario — two columns with overlapping data
 *     — is indistinguishable from the fresh-DB case at this layer; the
 *     lockstep convention makes the fresh-DB case the common one, and the
 *     column-shape parity tests in `test/db.test.ts` catch a contributor's
 *     accidental drift between literal and migrated paths.)
 *
 * Requires SQLite 3.25+ for `ALTER TABLE ... RENAME COLUMN`; Bun ships
 * SQLite 3.46+, so the floor is well below the runtime. The caller emits a
 * defensive version check upstream of the migration block for extra
 * forward-compat insurance.
 */
function renameColumnIfPresent(
  db: Database,
  table: string,
  oldName: string,
  newName: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  const hasOld = cols.some((c) => c.name === oldName);
  const hasNew = cols.some((c) => c.name === newName);
  if (!hasOld) {
    return; // already renamed OR neither present
  }
  if (hasNew) {
    return; // fresh-DB lockstep: CREATE_TABLE literal already carries both
  }
  db.run(`ALTER TABLE ${table} RENAME COLUMN ${oldName} TO ${newName}`);
}

/**
 * Schema v34 (fn-637): chunked backfill for `resolved_epic_deps` +
 * `epic_dep_edges` on existing `epics` rows. Runs OUTSIDE the main
 * migrate transaction so the WAL writer lock is NOT held across the
 * whole table scan — each chunk writes inside its own short BEGIN
 * IMMEDIATE, releasing the lock between chunks so concurrent hook
 * inserts (the keeper hook's per-event INSERT) are never starved.
 *
 * **Backfill semantics.** Re-derives `epic_dep_edges` + `resolved_epic_deps`
 * for EVERY existing `epics` row. An epic with no `depends_on_epics`
 * gets `resolved_epic_deps = '[]'` (computed, no deps) — distinct from
 * NULL (not-yet-computed). An epic with deps gets the enriched array
 * (resolver outcome per dep — `satisfied | blocked-incomplete |
 * dangling`). Idempotent on re-run: a row whose backfill already
 * landed re-derives to the same shape because the resolver is a pure
 * function of the live `epics` table. The version guard means the
 * post-migrate call only fires on the v33→v34 upgrade boot; a steady-
 * state re-open of an already-migrated DB skips the work entirely.
 *
 * **Chunking.** Walks `epics` rows in slices of {@link BACKFILL_CHUNK_SIZE}
 * via `ORDER BY epic_id LIMIT ? OFFSET ?`. Each chunk runs inside its
 * own BEGIN IMMEDIATE so the writer lock is held for the duration of
 * one chunk only (under a thousand epic rows fit in one chunk by
 * design, so the lock window is sub-millisecond). The full-table scan
 * is bounded by the row count of `epics` — small in the daemon's
 * steady state (under 1k rows in practice).
 *
 * **Cost profile.** Per-row, the backfill assembles the all-epics
 * index ONCE per chunk and reuses it across all rows in the chunk
 * (the index is a pure function of the current `epics` table, which
 * doesn't change inside this routine — chunked writes against
 * different rows don't affect the resolution-relevant `(epic_id,
 * epic_number, project_dir, status, approval)` columns). The per-chunk
 * write cost is O(chunk_size * deps_per_row) ALTER INSERTs +
 * O(chunk_size) UPDATE writes.
 *
 * **Determinism.** The backfill produces the SAME projection a from-
 * scratch re-fold would produce. The resolver injects `now` from each
 * epic's persisted `updated_at` (or `'1970-01-01T00:00:00.000Z'` when
 * NULL/zero — a defensive fallback for the pre-event-stream slot;
 * `enrichEpicDep` drops the diagnostic on the floor anyway, so the
 * `now` value only matters to the diagnostic ts, which is not written
 * to the projection at all). No `Date.now()`, no env reads.
 */
const BACKFILL_CHUNK_SIZE = 200;

function backfillResolvedEpicDeps(db: Database): void {
  // Step 1: enumerate the epics rows that need backfill. Read the row
  // count once OUTSIDE the chunk loop — the loop's LIMIT/OFFSET pagination
  // is stable because the backfill writes `resolved_epic_deps` (a column
  // outside the ORDER BY) and does NOT delete/insert epics rows, so
  // walking by `(ORDER BY epic_id ASC, LIMIT, OFFSET)` is reproducible.
  const epicIdsRow = db
    .prepare("SELECT epic_id FROM epics ORDER BY epic_id ASC")
    .all() as { epic_id: string }[];
  if (epicIdsRow.length === 0) {
    return; // fresh DB; nothing to backfill.
  }
  const allEpicIds = epicIdsRow.map((r) => r.epic_id);

  // Step 2: build the all-epics index ONCE for the full backfill pass.
  // The resolver-relevant columns (`epic_id`, `epic_number`, `project_dir`,
  // `status`, `approval`) are stable across the backfill: the chunked
  // UPDATEs only touch `resolved_epic_deps` + `last_event_id` +
  // `updated_at`, none of which the resolver reads. So a single index
  // assembly suffices for the whole pass.
  //
  // Defensive shape: the same `EpicLite` / `epicLiteToEpic` helpers from
  // the reducer module would be ideal here, but db.ts is the migrator
  // and lives below reducer.ts in the import graph. We re-implement the
  // narrow helper inline (15 LOC) so db.ts stays cycle-free, and the
  // shape matches the reducer's `buildEpicIndex` field-for-field — a
  // re-fold against the same `epics` rows produces the same enriched
  // entries because both sides feed the resolver via the same `EpicLite`
  // → `Epic` projection.
  type BackfillEpicRow = {
    epic_id: string;
    epic_number: number | null;
    project_dir: string | null;
    status: string | null;
    approval: "approved" | "rejected" | "pending";
    depends_on_epics: string | null;
    updated_at: number;
  };
  const indexRows = db
    .prepare(
      `SELECT epic_id, epic_number, project_dir, status, approval
         FROM epics`,
    )
    .all() as Omit<BackfillEpicRow, "depends_on_epics" | "updated_at">[];
  const epicById = new Map<string, Epic>();
  const epicsByNumber = new Map<number, Epic[]>();
  for (const row of indexRows) {
    const epic: Epic = {
      epic_id: row.epic_id,
      epic_number: row.epic_number,
      title: null,
      project_dir: row.project_dir,
      status: row.status,
      approval: row.approval,
      last_event_id: null,
      updated_at: 0,
      depends_on_epics: [],
      tasks: [],
      jobs: [],
      job_links: [],
      last_validated_at: null,
      created_by_closer_of: null,
      sort_path: "",
      queue_jump: 0,
      resolved_epic_deps: null,
    };
    epicById.set(row.epic_id, epic);
    if (row.epic_number != null) {
      const bucket = epicsByNumber.get(row.epic_number);
      if (bucket == null) {
        epicsByNumber.set(row.epic_number, [epic]);
      } else {
        bucket.push(epic);
      }
    }
  }
  for (const bucket of epicsByNumber.values()) {
    bucket.sort((a, b) =>
      a.epic_id < b.epic_id ? -1 : a.epic_id > b.epic_id ? 1 : 0,
    );
  }

  // Step 3: chunked write loop. Each chunk: BEGIN IMMEDIATE → read
  // chunk → for each row recompute the projection → UPDATE +
  // edges-table writes → COMMIT. The chunk size bounds the writer-lock
  // window so concurrent hook inserts get a fair shot between chunks.
  let offset = 0;
  while (offset < allEpicIds.length) {
    const slice = allEpicIds.slice(offset, offset + BACKFILL_CHUNK_SIZE);
    db.transaction(() => {
      // Single SELECT per chunk over a stable id list (driven by the
      // pre-enumerated `allEpicIds`). Avoids LIMIT/OFFSET reads that
      // would re-scan the table on each chunk; the bound id list lets
      // us bind parameters directly.
      const placeholders = slice.map(() => "?").join(",");
      const chunkRows = db
        .prepare(
          `SELECT epic_id, epic_number, project_dir, status, approval,
                  depends_on_epics, updated_at
             FROM epics
            WHERE epic_id IN (${placeholders})`,
        )
        .all(...slice) as BackfillEpicRow[];
      for (const row of chunkRows) {
        const consumerEpic: Epic = {
          epic_id: row.epic_id,
          epic_number: row.epic_number,
          title: null,
          project_dir: row.project_dir,
          status: row.status,
          approval: row.approval,
          last_event_id: null,
          updated_at: 0,
          depends_on_epics: [],
          tasks: [],
          jobs: [],
          job_links: [],
          last_validated_at: null,
          created_by_closer_of: null,
          sort_path: "",
          queue_jump: 0,
          resolved_epic_deps: null,
        };
        let depTokens: string[] = [];
        if (row.depends_on_epics != null && row.depends_on_epics.length > 0) {
          try {
            const parsed = JSON.parse(row.depends_on_epics);
            if (Array.isArray(parsed)) {
              depTokens = parsed.filter(
                (t): t is string => typeof t === "string",
              );
            }
          } catch {
            // malformed → empty deps; row gets `resolved_epic_deps = '[]'`.
          }
        }

        // Wipe + insert this consumer's `epic_dep_edges` rows. Idempotent:
        // a re-run reproduces the same shape because depTokens is a pure
        // function of `depends_on_epics`. The DELETE on a never-seeded row
        // matches zero rows and is a no-op.
        db.prepare("DELETE FROM epic_dep_edges WHERE consumer_id = ?").run(
          row.epic_id,
        );
        const insertEdge = db.prepare(
          "INSERT OR IGNORE INTO epic_dep_edges (consumer_id, dep_token) VALUES (?, ?)",
        );
        for (const tok of depTokens) {
          insertEdge.run(row.epic_id, tok);
        }

        // Compute the enriched array via the shared resolver. The
        // `now` injection is the epic row's persisted `updated_at`
        // converted to ISO-8601 (zero/null fallback to the unix
        // epoch); the diagnostic path is dropped on the floor so the
        // value only matters to the would-be `ResolutionDiagnostic` ts.
        const nowIso =
          row.updated_at > 0
            ? new Date(row.updated_at * 1000).toISOString()
            : new Date(0).toISOString();
        const diagnosticsSink: ResolutionDiagnostic[] = [];
        const enriched: ResolvedEpicDep[] = depTokens.map((tok) => {
          const resolved = resolveEpicDep(
            tok,
            consumerEpic,
            epicById,
            epicsByNumber,
            diagnosticsSink,
            nowIso,
          );
          if (resolved.kind === "dangling") {
            return {
              dep_token: tok,
              resolved_epic_id: null,
              epic_number: null,
              project_basename: null,
              cross_project: false,
              state: "dangling",
            };
          }
          const upstream = resolved.epic;
          return {
            dep_token: tok,
            resolved_epic_id: upstream.epic_id,
            epic_number: upstream.epic_number,
            project_basename: projectBasename(upstream.project_dir),
            cross_project: resolved.cross_project !== null,
            state: epicIsCompleted(upstream)
              ? "satisfied"
              : "blocked-incomplete",
          };
        });

        // Bump `last_event_id` to the row's existing value (read off the
        // current epics row); the backfill is NOT a fold and should not
        // re-stamp the column with a fresh id. We re-stamp `updated_at`
        // to the original row's `updated_at` for the same reason — the
        // backfill is structurally invisible to the wire diff. SQLite
        // can't read+write a row's old column value in one statement
        // cheaply, so we pass the original row's `last_event_id` through
        // a tiny SELECT inside the same chunk transaction.
        const cur = db
          .prepare("SELECT last_event_id FROM epics WHERE epic_id = ?")
          .get(row.epic_id) as { last_event_id: number | null } | null;
        db.prepare(
          "UPDATE epics SET resolved_epic_deps = ?, last_event_id = ?, updated_at = ? WHERE epic_id = ?",
        ).run(
          JSON.stringify(enriched),
          cur?.last_event_id ?? null,
          row.updated_at,
          row.epic_id,
        );
      }
    }).immediate();
    offset += BACKFILL_CHUNK_SIZE;
  }
}

/**
 * Run schema bootstrap + forward-only ALTER block. Writer-only. Wrapped in a
 * single transaction so a half-applied schema can never persist across a
 * crashed boot.
 *
 * Schema v34 (fn-637): after the main migrate transaction commits, run the
 * chunked backfill for `resolved_epic_deps` + `epic_dep_edges` on existing
 * `epics` rows. The backfill is OUTSIDE the main transaction to avoid a
 * mega-transaction WAL lock — see {@link backfillResolvedEpicDeps} for the
 * chunking + version-guard contract. Reading `storedVersion` from
 * `meta` BEFORE entering the transaction lets us detect the v33→v34
 * upgrade reliably (the version stamp inside the transaction is what we
 * see if we read after migrate commits, but we want the PRE-migrate value).
 */
function migrate(db: Database): void {
  // Pre-read storedVersion BEFORE entering the migrate transaction so the
  // post-commit backfill (`resolved_epic_deps`) can branch on whether this
  // boot is the v33→v34 upgrade or a steady-state re-open of an already-
  // migrated v34+ DB. A bare read against `meta` doesn't write, so it
  // never contends with the upcoming BEGIN IMMEDIATE.
  //
  // Fresh DB carve-out: a never-bootstrapped DB has no `meta` table, so
  // the SELECT would throw. Check existence first via `sqlite_master`; a
  // missing table reads as the zero version (which, for a fresh DB, is
  // correct — no backfill needed because the migrate transaction will
  // CREATE TABLE every projection empty).
  const metaTableExists =
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
      )
      .get() != null;
  const preMigrateStoredVersion = metaTableExists
    ? Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      )
    : 0;
  db.transaction(() => {
    db.run(CREATE_EVENTS);
    for (const sql of CREATE_EVENTS_INDEXES) {
      db.run(sql);
    }
    db.run(CREATE_JOBS);
    db.run(CREATE_EPICS);
    db.run(CREATE_GIT_STATUS);
    db.run(CREATE_USAGE);
    db.run(CREATE_REDUCER_STATE);
    db.run(CREATE_META);
    db.run(CREATE_SUBAGENT_INVOCATIONS);
    for (const sql of CREATE_SUBAGENT_INVOCATIONS_INDEXES) {
      db.run(sql);
    }
    db.run(CREATE_FILE_ATTRIBUTIONS);
    for (const sql of CREATE_FILE_ATTRIBUTIONS_INDEXES) {
      db.run(sql);
    }
    db.run(CREATE_PROFILES);
    db.run(CREATE_EPIC_DEP_EDGES);
    for (const sql of CREATE_EPIC_DEP_EDGES_INDEXES) {
      db.run(sql);
    }
    db.run(CREATE_DEAD_LETTERS);
    for (const sql of CREATE_DEAD_LETTERS_INDEXES) {
      db.run(sql);
    }

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

    // v11→v12: HISTORICAL ONLY. v12 added the `approvals` sidecar table — v13
    // (below) drops it, so a fresh-v13 DB never creates it and a v11/v12 DB
    // gets it dropped via the v12→v13 step. The DROP TABLE IF EXISTS is
    // idempotent, so even a v11 DB skipping directly to v13 converges
    // cleanly.

    // v12→v13: planctl-native approval. Two halves:
    //   1) SQL: add `epics.approval` (NOT NULL DEFAULT 'pending'), drop the
    //      schema-v12 `approvals` sidecar table.
    //   2) Filesystem: backfill `approval: "approved"` to every existing
    //      epic plan file that lacks the field, then overlay each existing
    //      approvals-table row onto the matching epic/task file. The
    //      filesystem half lives in `runPlanctlApprovalMigration` (called by
    //      the daemon AFTER `openDb` returns) because the hook process opens
    //      a writer connection per invocation and must NOT pay FS migration
    //      cost. Daemon boot order: `openDb` (this SQL block runs, idempotent
    //      ADD COLUMN + DROP TABLE) → `runPlanctlApprovalMigration` (the FS
    //      half, also idempotent) → workers spawn.
    //
    // The SQL ADD COLUMN is idempotent (no-op when present); the DROP TABLE
    // IF EXISTS is idempotent (no-op when absent). `NOT NULL DEFAULT
    // 'pending'` matches CREATE_EPICS so a fresh v13 DB and a migrated v12→v13
    // DB converge to identical schema. Existing rows backfill to `'pending'`;
    // the plan-worker emits `'pending'` for any file whose `approval` field is
    // missing, so a re-fold of an existing event log reproduces the same
    // reading (re-fold determinism preserved).
    addColumnIfMissing(
      db,
      "epics",
      "approval",
      "TEXT NOT NULL DEFAULT 'pending'",
    );

    // Snapshot the v12 `approvals` rows into a connection-scoped TEMP table
    // BEFORE the DROP fires. The FS half (`runPlanctlApprovalMigration`,
    // called by the daemon after `openDb` returns) needs to overlay those
    // rows onto the matching epic/task plan files — but it runs OUTSIDE this
    // transaction, after the DROP has already executed. Reading from the
    // real `approvals` table from inside the FS pass therefore sees nothing,
    // which silently dropped the overlay in prior boots (the bug this task
    // fixes).
    //
    // TEMP tables in sqlite are connection-scoped: they live for the
    // lifetime of THIS `db` handle and are invisible to every other
    // connection. Creating one inside this `BEGIN IMMEDIATE` keeps the
    // schema-migration atomicity invariant — if the transaction rolls back,
    // the TEMP table goes with it and the DROP never landed either, so a
    // retry re-snapshots from a still-present `approvals`. Idempotent on
    // re-run: a fresh-v13 boot has no `approvals` (the table-exists guard
    // skips the INSERT) and no rows to snapshot, so the FS pass overlays
    // nothing — exactly the desired no-op.
    //
    // We always CREATE the TEMP table (even when `approvals` is absent) so
    // the FS pass has a stable schema to read from; an empty table is a
    // clean no-op. `DROP TABLE IF EXISTS` clears any leftover from a prior
    // `migrate()` call on the same connection (e.g. tests that reopen).
    db.run("DROP TABLE IF EXISTS temp._v13_overlay_pending");
    db.run(`
      CREATE TEMP TABLE _v13_overlay_pending (
        epic_id TEXT NOT NULL,
        task_key TEXT NOT NULL,
        status TEXT NOT NULL
      )
    `);
    const approvalsTableExists =
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approvals'",
        )
        .get() != null;
    if (approvalsTableExists) {
      db.run(
        "INSERT INTO _v13_overlay_pending (epic_id, task_key, status) SELECT epic_id, task_key, status FROM approvals",
      );
    }

    // DROP TABLE while readers live needs the EXCLUSIVE lock the surrounding
    // `BEGIN IMMEDIATE` already holds. `IF EXISTS` keeps the step a no-op on
    // a fresh-v13 DB (table never created) and on any re-run after a prior
    // boot already dropped it. We use uncached `db.run` to sidestep the
    // bun:sqlite statement-cache pin documented on the v9→v10 backfill above
    // — a cached `db.prepare` compiled inside the same transaction as a DDL
    // can pin the pre-DDL schema metadata (oven-sh/bun#1332).
    db.run("DROP TABLE IF EXISTS approvals");

    // v13→v14: index the per-session planctl-CLI invocation footprint and
    // project per-job `epic_links` + per-epic `job_links` arrays so consumers
    // can surface creator/refiner cross-references without re-running the
    // classifier on every read. Seven new columns + one partial composite
    // index, plus a same-transaction JS-driven backfill of every existing
    // event + per-session/per-epic projection re-derive via the SAME pure
    // classifier the live reducer fan-out (task .5) will use.
    //
    // Column defs match CREATE_EVENTS / CREATE_JOBS / CREATE_EPICS literals
    // so a fresh v14 DB and a migrated v13→v14 DB converge to identical
    // schema (the addColumnIfMissing/literal lockstep convention). The
    // partial index lives in CREATE_V14_INDEXES; a fresh DB picks it up via
    // the same block, and a migrating DB picks it up on the same boot —
    // both paths converge to the same index set.
    addColumnIfMissing(db, "events", "planctl_op", "TEXT");
    addColumnIfMissing(db, "events", "planctl_target", "TEXT");
    addColumnIfMissing(db, "events", "planctl_epic_id", "TEXT");
    addColumnIfMissing(db, "events", "planctl_task_id", "TEXT");
    addColumnIfMissing(db, "events", "planctl_subject_present", "INTEGER");
    addColumnIfMissing(db, "jobs", "epic_links", "TEXT NOT NULL DEFAULT '[]'");
    addColumnIfMissing(db, "epics", "job_links", "TEXT NOT NULL DEFAULT '[]'");

    // CREATE the v14 partial index AFTER the ADD COLUMNs it depends on.
    // A fresh v14 DB enters this block too — the addColumnIfMissing calls
    // above no-op (the columns already exist via the CREATE_* literals) and
    // these CREATE INDEX IF NOT EXISTS calls land the same index set on both
    // a fresh-v14 and a migrating-v13 DB.
    for (const sql of CREATE_V14_INDEXES) {
      db.run(sql);
    }

    // Same-transaction JS-driven backfill. The Bash-command parser + the
    // classifier's per-session windowing aren't expressible in SQLite without
    // REGEXP and JSON arithmetic — we walk events in JS and write derived
    // columns back via UPDATEs in the same BEGIN IMMEDIATE. Mirrors the
    // v9→v10 backfill (db.ts:600-708) in shape: an `IS NULL` WHERE clause
    // guards against re-touching already-backfilled rows on partial-run
    // resume, the uncached `db.run` path sidesteps the bun:sqlite
    // statement-cache pin (oven-sh/bun#1332), and a throw rolls the whole
    // migration back (ALTERs included).
    //
    // Version-guarded: a non-idempotent projection re-derive must run AT
    // MOST once. The guard reads the meta row written by a PRIOR migrate() —
    // on a fresh v14 DB (or one that crashed before stamping v14)
    // `storedVersionV14 < 14` and the backfill runs; on a steady-state v14+
    // DB it skips, so a second `openDb` is a clean no-op. (The `planctl_*`
    // events-side stamps are independently idempotent via the `WHERE
    // planctl_op IS NULL` filter, so a partial-run resume is safe even
    // without the version guard. The projection re-derive needs the guard
    // because a re-run would have to re-walk every session.)
    const storedVersionV14 = Number(
      (
        db
          .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
          .get() as { value: string } | null
      )?.value ?? "0",
    );
    if (storedVersionV14 < 14) {
      // Pass 1 — stamp planctl_* columns on every un-backfilled
      // PreToolUse:Bash event. The WHERE filter picks up only rows we
      // haven't touched yet, so partial-run resume on a crash mid-backfill
      // is safe (a row that already has `planctl_op` set is skipped).
      // The deriver returns `null` for any non-planctl Bash command —
      // we leave columns NULL on miss so the partial-index `WHERE
      // planctl_op IS NOT NULL` predicate stays selective.
      //
      // LEGACY (fn-606 task .1 + .2): as of the v19→v20 step below, the
      // live `extractPlanctlInvocation` deriver gates on
      // `PostToolUse:Bash` (parsing the authoritative `planctl_invocation`
      // envelope from `data.tool_response.stdout`), not PreToolUse:Bash
      // — so this Pass 1 now stamps zero rows on a fresh chain run (the
      // gate mismatch is intentional: the v20 block re-stamps from
      // PostToolUse:Bash and supersedes whatever this would have done
      // anyway). Kept in place because removing it would break the
      // version-guarded re-fold contract on already-migrated v14+ DBs.
      const bashRows = db
        .prepare(
          `SELECT id, hook_event, tool_name, data
             FROM events
            WHERE hook_event = 'PreToolUse' AND tool_name = 'Bash'
              AND planctl_op IS NULL`,
        )
        .all() as {
        id: number;
        hook_event: string;
        tool_name: string | null;
        data: string;
      }[];
      for (const row of bashRows) {
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(row.data) as Record<string, unknown>;
        } catch {
          // malformed blob — skip derivation, columns stay NULL.
        }
        if (parsed == null) {
          continue;
        }
        const inv = extractPlanctlInvocation(
          row.hook_event,
          row.tool_name,
          parsed,
        );
        if (inv == null) {
          continue;
        }
        db.run(
          `UPDATE events SET
             planctl_op = ?,
             planctl_target = ?,
             planctl_epic_id = ?,
             planctl_task_id = ?,
             planctl_subject_present = ?
           WHERE id = ?`,
          [
            inv.op,
            inv.target,
            inv.epic_id,
            inv.task_id,
            inv.subject_present ? 1 : 0,
            row.id,
          ],
        );
      }

      // Pass 2 — per-session projection re-derive. For every session_id
      // that has at least one stamped `planctl_op != NULL` event, compute
      // its `/plan:plan` windows from `PreToolUse:Skill AND
      // skill_name='plan:plan'` rows (the locked window-opener gate —
      // see plan-classifier.ts), run `deriveEpicLinks`, and UPDATE
      // `jobs.epic_links`. Then for each touched epic id, gather all
      // sessions+windows touching that epic and run `deriveJobLinks`,
      // UPDATEing `epics.job_links` (shell-insert the epic row if it
      // doesn't exist — mirrors the syncJobIntoEpic shell-insert
      // pattern in `src/reducer.ts`, so a re-fold from scratch
      // reproduces every projection row).
      //
      // The output is byte-identical to what the live reducer fan-out
      // (task .5 — `syncPlanctlLinks`) will produce on steady-state
      // writes because both paths feed the SAME pure classifier
      // functions in `src/plan-classifier.ts`.
      const sessionRows = db
        .prepare(
          `SELECT DISTINCT session_id
             FROM events
            WHERE planctl_op IS NOT NULL`,
        )
        .all() as { session_id: string }[];

      // Build a map of {session_id → ClassifierInvocation[]} and
      // {session_id → opener-ts[]} once. The classifier needs both shapes
      // to produce jobs.epic_links; for epics.job_links we additionally
      // need the per-session aggregates.
      const invocationsBySession = new Map<string, ClassifierInvocation[]>();
      const openerTimestampsBySession = new Map<string, number[]>();

      for (const { session_id } of sessionRows) {
        // Load all planctl invocation rows for this session, ASC by id.
        const invRows = db
          .prepare(
            `SELECT id, ts, planctl_op, planctl_target, planctl_epic_id,
                    planctl_task_id, planctl_subject_present
               FROM events
              WHERE session_id = ? AND planctl_op IS NOT NULL
              ORDER BY id ASC`,
          )
          .all(session_id) as {
          id: number;
          ts: number;
          planctl_op: string;
          planctl_target: string | null;
          planctl_epic_id: string | null;
          planctl_task_id: string | null;
          planctl_subject_present: number | null;
        }[];
        const invocations: ClassifierInvocation[] = invRows.map((r) => ({
          ts: r.ts,
          op: normalizePlanctlOp(r.planctl_op),
          target: r.planctl_target,
          epic_id: r.planctl_epic_id,
          subject_present: r.planctl_subject_present === 1,
        }));
        invocationsBySession.set(session_id, invocations);

        // Load `/plan:plan` window opener timestamps for this session.
        // Locked gate: PreToolUse:Skill AND skill_name='plan:plan' only —
        // slash_command='/plan:plan' UserPromptSubmit rows are NOT
        // openers (they'd double-fire on slash-typed invocations).
        const openerRows = db
          .prepare(
            `SELECT ts
               FROM events
              WHERE session_id = ?
                AND hook_event = 'PreToolUse'
                AND skill_name = 'plan:plan'
              ORDER BY id ASC`,
          )
          .all(session_id) as { ts: number }[];
        openerTimestampsBySession.set(
          session_id,
          openerRows.map((r) => r.ts),
        );
      }

      // Pass 2a — compute and write `jobs.epic_links` per session. Also
      // collect every (epic_id) that appears in any session's
      // epic_links so pass 2b knows which epics need a job_links
      // re-derive.
      const windowsBySession = new Map<string, PlanWindow[]>();
      const touchedEpicIds = new Set<string>();
      for (const session_id of invocationsBySession.keys()) {
        const opens = openerTimestampsBySession.get(session_id) ?? [];
        const windows = computePlanWindows(opens);
        windowsBySession.set(session_id, windows);
        const invocations = invocationsBySession.get(session_id) ?? [];
        const epicLinks = deriveEpicLinks(invocations, windows);
        const epicLinksJson = JSON.stringify(epicLinks);
        // Find the latest event id + ts for this session to stamp the
        // jobs row's `last_event_id` + `updated_at`. Mirrors how a live
        // reducer fan-out would attach the bump to its triggering event.
        const latest = db
          .prepare(
            `SELECT id, ts
               FROM events
              WHERE session_id = ? AND planctl_op IS NOT NULL
              ORDER BY id DESC
              LIMIT 1`,
          )
          .get(session_id) as { id: number; ts: number } | null;
        if (latest == null) {
          continue;
        }
        // UPDATE the jobs row if it exists. We do NOT shell-insert a
        // missing jobs row: a session_id with planctl events but no
        // backing jobs row is an orphan (no SessionStart), and the
        // reducer's invariant is that jobs rows are created only by
        // SessionStart. Mirrors the v9→v10 backfill's behavior.
        db.run(
          `UPDATE jobs SET epic_links = ?, last_event_id = ?, updated_at = ?
            WHERE job_id = ?`,
          [epicLinksJson, latest.id, latest.ts, session_id],
        );
        for (const link of epicLinks) {
          touchedEpicIds.add(link.target);
        }
      }

      // Pass 2b — compute and write `epics.job_links` per epic. For each
      // touched epic, run `deriveJobLinks` over the per-session
      // invocations+windows maps (Read-Only Maps). Shell-insert the epic
      // row if missing so a re-fold from scratch reproduces every
      // projection row.
      for (const epicId of touchedEpicIds) {
        const jobLinks = deriveJobLinks(
          invocationsBySession,
          windowsBySession,
          epicId,
        );
        const jobLinksJson = JSON.stringify(jobLinks);
        // Latest stamp across all sessions touching this epic.
        const latest = db
          .prepare(
            `SELECT MAX(id) AS id, MAX(ts) AS ts
               FROM events
              WHERE planctl_op IS NOT NULL
                AND (planctl_epic_id = ? OR planctl_target = ?)`,
          )
          .get(epicId, epicId) as { id: number | null; ts: number | null };
        const stampId = latest.id ?? 0;
        const stampTs = latest.ts ?? 0;
        const existing = db
          .prepare("SELECT epic_id FROM epics WHERE epic_id = ?")
          .get(epicId) as { epic_id: string } | null;
        if (existing != null) {
          db.run(
            `UPDATE epics SET job_links = ?, last_event_id = ?, updated_at = ?
              WHERE epic_id = ?`,
            [jobLinksJson, stampId, stampTs, epicId],
          );
        } else {
          // Shell-insert: no epic row yet (no EpicSnapshot has folded
          // for this epic — e.g. an epic touched by a planctl
          // invocation before the plan-worker observed its file).
          // Mirrors syncJobIntoEpic's shell-insert pattern (epic_number,
          // title, project_dir, status, approval default to their
          // zero-event readings). A later EpicSnapshot fills the
          // scalars; the ON CONFLICT carve-out (task .5) preserves
          // `job_links`.
          db.run(
            `INSERT INTO epics (
               epic_id, epic_number, title, project_dir, status,
               last_event_id, updated_at, tasks, jobs, job_links
             ) VALUES (?, NULL, NULL, NULL, NULL, ?, ?, '[]', '[]', ?)`,
            [epicId, stampId, stampTs, jobLinksJson],
          );
        }
      }

      // Seed planner stats for the new partial composite index so the
      // first post-upgrade query lands the index instead of a scan
      // (sqlite.org/lang_analyze.html — ANALYZE refreshes the
      // `sqlite_stat1` table the planner reads). One-shot; subsequent
      // boots don't re-ANALYZE here.
      db.run("ANALYZE events");
    }

    // v14→v15: registers the `git_status` table (created above by the
    // unconditional `CREATE_GIT_STATUS` bootstrap block). The CREATE TABLE
    // IF NOT EXISTS is idempotent and runs on every boot — no ALTER step
    // is required here, so this block is a comment-only no-op that
    // documents what the v15 stamp gates. Without this note the bare
    // SCHEMA_VERSION = 15 bump would violate the CLAUDE.md invariant
    // ("Bump SCHEMA_VERSION only when adding an ALTER block to
    // migrate()"); a future real v14→v15 ALTER would have to land
    // alongside this comment's removal.

    // v15→v16: project `last_validated_at` through the epics row. Nullable
    // (no DEFAULT) — a missing field on the planctl JSON is the honest
    // zero-event reading. Idempotent ADD COLUMN, NO backfill, NO
    // rewind-and-redrain: the plan-worker's per-boot re-scan repopulates
    // every epic via the change-gate diff, so a v15 DB gains the column
    // reading NULL and gets filled from disk on the next boot scan. Column
    // def matches CREATE_EPICS so a fresh v16 DB and a migrated v15→v16 DB
    // converge to identical schema.
    addColumnIfMissing(db, "epics", "last_validated_at", "TEXT");

    // v16→v17: add the sparse `events.tool_use_id` bridge column + the
    // `subagent_invocations` peer table + the partial index on the bridge
    // column. Mirrors the v9→v10 / v13→v14 sparse-column + partial-index
    // precedent: one new top-level events column, one CREATE INDEX gated on
    // `IS NOT NULL`, and a same-transaction backfill via uncached `db.run`.
    //
    // Column def matches CREATE_EVENTS literal so a fresh v17 DB and a
    // migrated v16→v17 DB converge to identical schema (the
    // addColumnIfMissing/literal lockstep convention). The
    // `subagent_invocations` table itself is created unconditionally via
    // CREATE TABLE IF NOT EXISTS above; a fresh v17 DB picks it up there,
    // and a migrating DB picks it up on the same boot — both paths
    // converge to the same shape. The partial index lives in
    // CREATE_V17_INDEXES; a fresh DB picks it up via the same block, and a
    // migrating DB picks it up on the same boot.
    //
    // No reducer cases yet — task .3 supplies the SubagentStart/Stop +
    // PreToolUse:Agent / PostToolUse:Agent folds that populate the
    // projection. The intermediate post-task-.1 state is harmless: the
    // table exists but is empty, the events.tool_use_id column is
    // populated forward + backfilled, and the wire collection isn't
    // registered (task .3 adds the descriptor).
    addColumnIfMissing(db, "events", "tool_use_id", "TEXT");

    // CREATE the v17 partial index AFTER the ADD COLUMN it depends on. A
    // fresh v17 DB enters this block too — the addColumnIfMissing above
    // no-ops (the column already exists via the CREATE_EVENTS literal),
    // and this CREATE INDEX IF NOT EXISTS lands the same index set on
    // both a fresh-v17 and a migrating-v16 DB.
    for (const sql of CREATE_V17_INDEXES) {
      db.run(sql);
    }

    // Same-transaction backfill of `events.tool_use_id` for historical
    // rows. Unlike the v9→v10 / v13→v14 backfills (which run derivers in
    // JS), the tool_use_id field is a verbatim json_extract — SQLite can
    // do this entirely in SQL via `json_extract(data, '$.tool_use_id')`.
    // The `WHERE tool_use_id IS NULL AND json_extract(...) IS NOT NULL`
    // guard makes the UPDATE idempotent: a re-run after a partial crash
    // skips already-stamped rows, and a clean re-run sees no work.
    //
    // Uses `db.run(sql)` (uncached path — no bound params, single
    // statement) rather than `db.prepare(...).run()` to sidestep the
    // bun:sqlite statement-cache pin (oven-sh/bun#1332) — the same
    // pattern documented on the v9→v10 backfill above. A throw rolls the
    // whole migration back (ALTERs included).
    //
    // Version-guarded: a non-idempotent backfill on a multi-million-row
    // events log must run AT MOST once. The guard reads the meta row
    // written by a PRIOR migrate() — on a fresh v17 DB (or one that
    // crashed before stamping v17) `storedVersionV17 < 17` and the
    // backfill runs; on a steady-state v17+ DB it skips, so a second
    // `openDb` is a clean no-op. (The events.tool_use_id IS NULL filter
    // would make the UPDATE safe to re-run even without the guard, but
    // the rewind-and-redrain below is non-idempotent and must be gated.)
    const storedVersionV17 = Number(
      (
        db
          .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
          .get() as { value: string } | null
      )?.value ?? "0",
    );
    if (storedVersionV17 < 17) {
      // `json_valid(data)` gates the json_extract so a malformed historical
      // `data` blob (one that pre-dated the hook's structured-JSON
      // contract, or that the hook stored as a non-JSON best-effort
      // string) skips cleanly — `json_extract` raises SQLITE_ERROR on
      // malformed JSON, which would otherwise abort the transaction and
      // wedge the migration. The `tool_use_id IS NULL` filter keeps the
      // UPDATE idempotent across partial-crash resume.
      db.run(
        `UPDATE events
            SET tool_use_id = json_extract(data, '$.tool_use_id')
          WHERE tool_use_id IS NULL
            AND json_valid(data) = 1
            AND json_extract(data, '$.tool_use_id') IS NOT NULL`,
      );

      // Seed planner stats for the new partial index so the first
      // post-upgrade query lands the index instead of a scan
      // (sqlite.org/lang_analyze.html — ANALYZE refreshes the
      // `sqlite_stat1` table the planner reads). One-shot; subsequent
      // boots don't re-ANALYZE here.
      db.run("ANALYZE events");

      // Rewind-and-redrain — same shape as the v10→v11 step. Task .3's
      // reducer cases will populate `subagent_invocations` on the
      // re-drain. The boot drain runs unconditionally after `migrate()`
      // returns, so the projection is rebuilt from the event log in one
      // pass. Until task .3 lands the live folds, the re-drain leaves
      // `subagent_invocations` empty — the table exists but no rows
      // populate (no cases yet). This is harmless: existing `jobs` /
      // `epics` folds tolerate a fresh re-fold cleanly per the v10→v11
      // precedent.
      //
      // Non-idempotent: must run AT MOST once per DB. The version guard
      // above ensures this. Cost: re-folding the entire event log
      // inside the BEGIN IMMEDIATE — bounded by `events` row count,
      // seconds to tens of seconds on a developer machine. One-time.
      db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
      db.run("DELETE FROM jobs");
      db.run("DELETE FROM epics");
      db.run("DELETE FROM subagent_invocations");
    }

    // v17→v18: add `jobs.rate_limited_at REAL` — nullable timestamp stamped
    // by the reducer's `RateLimited` arm (synthetic event minted by main from
    // a transcript-worker `rate-limited` message) and cleared on the next
    // `UserPromptSubmit` revival. Column def matches CREATE_JOBS so a fresh
    // v18 DB and a migrated v17→v18 DB converge to identical schema (the
    // addColumnIfMissing/literal lockstep convention).
    //
    // Pair-step: the same column is added to the embedded `jobs` array
    // shape (`EmbeddedJobElement` in `src/reducer.ts`, mirrored on
    // `EmbeddedJob` in `src/types.ts`), so the field appears on every
    // embedded entry — not just newly-rate-limited ones. Historical
    // serialized arrays from v17 do NOT have the field; without a rewind,
    // incremental `syncJobIntoEpic` writes from later events would
    // re-serialize entries WITH the field while neighbour entries in the
    // same array stayed WITHOUT it, breaking the byte-identical re-fold
    // invariant (CLAUDE.md). The rewind-and-redrain below harmonizes
    // both sides to "new schema everywhere".
    addColumnIfMissing(db, "jobs", "rate_limited_at", "REAL");

    // Non-idempotent rewind-and-redrain — same shape as the v16→v17 step.
    // Version-guarded: re-open of an already-migrated v18+ DB skips it
    // (the guard reads the meta row written by a PRIOR migrate(); on a
    // fresh v18 DB or one that crashed before stamping v18,
    // `storedVersionV18 < 18` and the rewind runs; on steady-state v18+
    // DB it skips). The boot drain after migrate() returns rebuilds
    // `jobs` / `epics` / `subagent_invocations` from the event log,
    // re-emitting embedded `jobs` arrays with the new field present on
    // every entry.
    const storedVersionV18 = Number(
      (
        db
          .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
          .get() as { value: string } | null
      )?.value ?? "0",
    );
    if (storedVersionV18 < 18) {
      db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
      db.run("DELETE FROM jobs");
      db.run("DELETE FROM epics");
      db.run("DELETE FROM subagent_invocations");
    }

    // v18→v19: rename the legacy `status` key on every `epics.tasks` embedded
    // element to `worker_phase`, and add the planctl-native `runtime_status`
    // sibling (defaults to `"todo"`). Both fields ride the embedded JSON
    // array — there is no schema column to ALTER. The reducer is the SINGLE
    // source of truth for the embedded shape (`projectPlanRow` +
    // `syncJobIntoEpic`'s OLD-element carve-out); a rewind-and-redrain
    // replays the event log through the v19 reducer and re-emits every
    // embedded element with the new key shape.
    //
    // Why rewind-and-redrain (not an in-place UPDATE that hand-rewrites the
    // JSON): historical pre-v19 TaskSnapshot events still carry `status` in
    // their `data` blob (immutable event log). Without a re-fold, an in-place
    // JSON rewrite would converge once, but the NEXT `syncJobIntoEpic`
    // fan-out triggered by a `jobs` write would spread the OLD pre-rewrite
    // shape from the row it read back (the carve-out preserves OLD scalars),
    // re-introducing `status` on the touched task element while neighbours
    // kept `worker_phase`. The re-fold guarantees one shape across every
    // embedded element by deriving them all from the same v19 reducer pass.
    // The reducer reads `worker_phase ?? status` so a pre-v19 blob still
    // folds deterministically (re-fold determinism preserved across the
    // boundary).
    //
    // Non-idempotent — version-guarded by the `meta` row written by a PRIOR
    // migrate() so a re-open of an already-migrated v19+ DB skips cleanly.
    // The boot drain after migrate() rebuilds `jobs` / `epics` /
    // `subagent_invocations` from the event log.
    const storedVersionV19 = Number(
      (
        db
          .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
          .get() as { value: string } | null
      )?.value ?? "0",
    );
    if (storedVersionV19 < 19) {
      db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
      db.run("DELETE FROM jobs");
      db.run("DELETE FROM epics");
      db.run("DELETE FROM subagent_invocations");
    }

    // v19→v20: re-stamp the five sparse `events.planctl_*` columns from the
    // authoritative PostToolUse:Bash `planctl_invocation` envelope on
    // `data.tool_response.stdout`, replacing the structurally-wrong v13→v14
    // stamps that came from the now-replaced input-command regex on the
    // PreToolUse:Bash side. Per fn-606 task .1 the live deriver
    // `extractPlanctlInvocation` gates on `PostToolUse:Bash` and parses the
    // envelope; the v13→v14 backfill block above (src/db.ts:1010-1253) calls
    // the SAME deriver against PreToolUse:Bash rows and now returns null for
    // every row — a harmless no-op on a fresh chain run. We leave the v14
    // block untouched (it stays as legacy context; v20 supersedes its
    // output) and re-do the per-event stamps + projection re-derive from the
    // correct shape here.
    //
    // Same structural template as the v13→v14 backfill:
    //
    //   Pass 0 — NULL-out every PreToolUse:Bash row's planctl_* stamps.
    //   Pass 1 — re-stamp PostToolUse:Bash rows via the new deriver.
    //   Pass 2a — per-session `jobs.epic_links` re-derive via deriveEpicLinks.
    //   Pass 2b — per-touched-epic `epics.job_links` re-derive via
    //             deriveJobLinks (shell-insert missing epic rows).
    //   ANALYZE epilogue — refresh `sqlite_stat1` so the first post-upgrade
    //                       query lands the partial composite index.
    //
    // Version-guarded: a non-idempotent projection re-derive must run AT
    // MOST once. The guard reads the meta row written by a PRIOR migrate() —
    // on a fresh v20 DB (or one that crashed before stamping v20)
    // `storedVersionV20 < 20` and the backfill runs; on a steady-state v20+
    // DB it skips. Pass 0's IS NOT NULL filter and Pass 1's IS NULL filter
    // also make the events-side stamps independently idempotent for a
    // partial-run resume; Pass 2a/b is full-replace re-derive (idempotent
    // by construction).
    //
    // Uses `db.run(sql, params)` (uncached path) per bun:sqlite #1332 (still
    // open as of 2026-01) — the v13→v14 / v16→v17 backfills follow the same
    // discipline.
    const storedVersionV20 = Number(
      (
        db
          .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
          .get() as { value: string } | null
      )?.value ?? "0",
    );
    if (storedVersionV20 < 20) {
      // Pass 0 — wipe every PreToolUse:Bash row's structurally-wrong stamps.
      // The v14 backfill stamped these via the now-replaced input-command
      // regex; leaving them populated would have the reducer's
      // hook-event-agnostic `planctl_op != NULL` gate fan-out from
      // wrong-shaped data (e.g. `planctl epic close fn-N-foo` was stamped
      // op='epic' target='close', because the regex captured the first
      // two tokens instead of the two-word verb form). Idempotent re-run
      // safe: the IS NOT NULL predicate becomes a no-op after the first
      // pass.
      db.run(
        `UPDATE events
            SET planctl_op = NULL,
                planctl_target = NULL,
                planctl_epic_id = NULL,
                planctl_task_id = NULL,
                planctl_subject_present = NULL
          WHERE hook_event = 'PreToolUse'
            AND tool_name = 'Bash'
            AND planctl_op IS NOT NULL`,
      );

      // Pass 1 — re-stamp from PostToolUse:Bash rows via the new deriver.
      // The WHERE filter picks up only rows we haven't touched yet, so a
      // partial-run resume on a crash mid-backfill is safe (a row that
      // already has `planctl_op` set is skipped). The deriver returns
      // `null` for any non-envelope-bearing PostToolUse:Bash — we leave
      // columns NULL on miss so the partial-index `WHERE planctl_op IS
      // NOT NULL` predicate stays selective.
      const bashPostRows = db
        .prepare(
          `SELECT id, hook_event, tool_name, data
             FROM events
            WHERE hook_event = 'PostToolUse' AND tool_name = 'Bash'
              AND planctl_op IS NULL`,
        )
        .all() as {
        id: number;
        hook_event: string;
        tool_name: string | null;
        data: string;
      }[];
      for (const row of bashPostRows) {
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(row.data) as Record<string, unknown>;
        } catch {
          // malformed blob — skip derivation, columns stay NULL.
        }
        if (parsed == null) {
          continue;
        }
        const inv = extractPlanctlInvocation(
          row.hook_event,
          row.tool_name,
          parsed,
        );
        if (inv == null) {
          continue;
        }
        db.run(
          `UPDATE events SET
             planctl_op = ?,
             planctl_target = ?,
             planctl_epic_id = ?,
             planctl_task_id = ?,
             planctl_subject_present = ?
           WHERE id = ?`,
          [
            inv.op,
            inv.target,
            inv.epic_id,
            inv.task_id,
            inv.subject_present ? 1 : 0,
            row.id,
          ],
        );
      }

      // Pass 2 — per-session projection re-derive. Mirrors the v13→v14
      // Pass 2 shape exactly (see lines 1075-1246): for every session_id
      // with at least one stamped `planctl_op != NULL` event, compute its
      // `/plan:plan` windows from `PreToolUse:Skill AND
      // skill_name='plan:plan'` rows, run `deriveEpicLinks`, and UPDATE
      // `jobs.epic_links`. Then for each touched epic id, gather all
      // sessions+windows touching that epic and run `deriveJobLinks`,
      // UPDATEing `epics.job_links` (shell-insert the epic row if it
      // doesn't exist — mirrors the syncJobIntoEpic shell-insert pattern
      // in `src/reducer.ts`).
      //
      // The output is byte-identical to what the live reducer fan-out
      // (`syncPlanctlLinks`) produces on steady-state writes because both
      // paths feed the SAME pure classifier functions in
      // `src/plan-classifier.ts` — including the scaffold-as-creator
      // predicate extension from fn-606 task .1.
      const sessionRowsV20 = db
        .prepare(
          `SELECT DISTINCT session_id
             FROM events
            WHERE planctl_op IS NOT NULL`,
        )
        .all() as { session_id: string }[];

      const invocationsBySessionV20 = new Map<string, ClassifierInvocation[]>();
      const openerTimestampsBySessionV20 = new Map<string, number[]>();

      for (const { session_id } of sessionRowsV20) {
        const invRows = db
          .prepare(
            `SELECT id, ts, planctl_op, planctl_target, planctl_epic_id,
                    planctl_task_id, planctl_subject_present
               FROM events
              WHERE session_id = ? AND planctl_op IS NOT NULL
              ORDER BY id ASC`,
          )
          .all(session_id) as {
          id: number;
          ts: number;
          planctl_op: string;
          planctl_target: string | null;
          planctl_epic_id: string | null;
          planctl_task_id: string | null;
          planctl_subject_present: number | null;
        }[];
        const invocations: ClassifierInvocation[] = invRows.map((r) => ({
          ts: r.ts,
          op: normalizePlanctlOp(r.planctl_op),
          target: r.planctl_target,
          epic_id: r.planctl_epic_id,
          subject_present: r.planctl_subject_present === 1,
        }));
        invocationsBySessionV20.set(session_id, invocations);

        // Locked gate: PreToolUse:Skill AND skill_name='plan:plan' only —
        // slash_command='/plan:plan' UserPromptSubmit rows are NOT
        // openers (they'd double-fire on slash-typed invocations).
        const openerRows = db
          .prepare(
            `SELECT ts
               FROM events
              WHERE session_id = ?
                AND hook_event = 'PreToolUse'
                AND skill_name = 'plan:plan'
              ORDER BY id ASC`,
          )
          .all(session_id) as { ts: number }[];
        openerTimestampsBySessionV20.set(
          session_id,
          openerRows.map((r) => r.ts),
        );
      }

      // Pass 2a — compute and write `jobs.epic_links` per session. Also
      // collect every (epic_id) that appears in any session's epic_links
      // so Pass 2b knows which epics need a job_links re-derive.
      const windowsBySessionV20 = new Map<string, PlanWindow[]>();
      const touchedEpicIdsV20 = new Set<string>();
      for (const session_id of invocationsBySessionV20.keys()) {
        const opens = openerTimestampsBySessionV20.get(session_id) ?? [];
        const windows = computePlanWindows(opens);
        windowsBySessionV20.set(session_id, windows);
        const invocations = invocationsBySessionV20.get(session_id) ?? [];
        const epicLinks = deriveEpicLinks(invocations, windows);
        const epicLinksJson = JSON.stringify(epicLinks);
        const latest = db
          .prepare(
            `SELECT id, ts
               FROM events
              WHERE session_id = ? AND planctl_op IS NOT NULL
              ORDER BY id DESC
              LIMIT 1`,
          )
          .get(session_id) as { id: number; ts: number } | null;
        if (latest == null) {
          continue;
        }
        // Orphan sessions (planctl events with no SessionStart, hence no
        // backing jobs row) skip — no shell-insert into `jobs`. Mirrors
        // the v13→v14 Pass 2a invariant: jobs rows are created only by
        // SessionStart.
        db.run(
          `UPDATE jobs SET epic_links = ?, last_event_id = ?, updated_at = ?
            WHERE job_id = ?`,
          [epicLinksJson, latest.id, latest.ts, session_id],
        );
        for (const link of epicLinks) {
          touchedEpicIdsV20.add(link.target);
        }
      }

      // Pass 2b — compute and write `epics.job_links` per touched epic.
      // Shell-insert the epic row if missing so a re-fold from scratch
      // reproduces every projection row. Mirrors the v13→v14 Pass 2b
      // shell-insert pattern (the ON CONFLICT carve-out at the
      // EpicSnapshot fold preserves `job_links`).
      for (const epicId of touchedEpicIdsV20) {
        const jobLinks = deriveJobLinks(
          invocationsBySessionV20,
          windowsBySessionV20,
          epicId,
        );
        const jobLinksJson = JSON.stringify(jobLinks);
        const latest = db
          .prepare(
            `SELECT MAX(id) AS id, MAX(ts) AS ts
               FROM events
              WHERE planctl_op IS NOT NULL
                AND (planctl_epic_id = ? OR planctl_target = ?)`,
          )
          .get(epicId, epicId) as { id: number | null; ts: number | null };
        const stampId = latest.id ?? 0;
        const stampTs = latest.ts ?? 0;
        const existing = db
          .prepare("SELECT epic_id FROM epics WHERE epic_id = ?")
          .get(epicId) as { epic_id: string } | null;
        if (existing != null) {
          db.run(
            `UPDATE epics SET job_links = ?, last_event_id = ?, updated_at = ?
              WHERE epic_id = ?`,
            [jobLinksJson, stampId, stampTs, epicId],
          );
        } else {
          db.run(
            `INSERT INTO epics (
               epic_id, epic_number, title, project_dir, status,
               last_event_id, updated_at, tasks, jobs, job_links
             ) VALUES (?, NULL, NULL, NULL, NULL, ?, ?, '[]', '[]', ?)`,
            [epicId, stampId, stampTs, jobLinksJson],
          );
        }
      }

      // Seed planner stats for the partial composite index so the first
      // post-upgrade query lands the index instead of a scan
      // (sqlite.org/lang_analyze.html — ANALYZE refreshes the
      // `sqlite_stat1` table the planner reads). One-shot; subsequent
      // boots don't re-ANALYZE here.
      db.run("ANALYZE events");
    }

    // v20→v21: widen `epics.job_links` entries from the thin classifier
    // shape `{kind, job_id}` to the enriched projection shape
    // `{kind, job_id, title, state, rate_limited_at}` per fn-612 task .1.
    // The denormalized payload lets renderers (board) and predicates
    // (readiness) read everything off `epics.job_links` with no live-jobs
    // join — terminal sessions and off-page live sessions stop falling
    // through to the degraded `[{job_id}] [{kind}]` render line.
    //
    // The column TYPE is unchanged (TEXT, JSON-array) — only the entry
    // shape widens — so no `ALTER TABLE` runs here. The migration is a
    // version-guarded re-derive of every epic's `job_links` using the
    // SAME `enrichJobLink` + `sortJobLinks` helpers as the live reducer
    // (`src/reducer.ts`). Byte-identical re-fold is non-negotiable
    // (CLAUDE.md "byte-identical re-fold" invariant): if the migration
    // backfill and the live reducer produced different JSON, a from-
    // scratch re-fold would diverge from the migrated state and the
    // server-worker's per-row diff would emit spurious `patch` frames.
    //
    // Single code path enforced by inlining the SAME `(title, state,
    // rate_limited_at)` enrichment shape here — see `enrichJobLink` in
    // `src/reducer.ts` for the live-reducer twin. Defaults on a missing
    // `jobs` row at enrichment time: `{title: null, state: "stopped",
    // rate_limited_at: null}` — preserves orphan entries with safe
    // values so re-fold determinism holds (a from-scratch re-fold sees
    // the same missing row at the same enrichment point and writes the
    // same defaults).
    //
    // Version-guarded: a non-idempotent re-derive must run AT MOST
    // once. The guard reads the meta row written by a PRIOR migrate() —
    // on a fresh v21 DB (or one that crashed before stamping v21)
    // `storedVersionV21 < 21` and the backfill runs; on a steady-state
    // v21+ DB it skips. The re-derive itself is full-replace
    // (idempotent by construction — re-running it on the same input
    // produces byte-identical output), so even a partial-run resume on
    // crash is safe; the guard exists to avoid the per-boot UPDATE
    // storm on a long-lived DB.
    const storedVersionV21 = Number(
      (
        db
          .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
          .get() as { value: string } | null
      )?.value ?? "0",
    );
    if (storedVersionV21 < 21) {
      // Re-derive every epic's `job_links` in place. We don't need to
      // re-run the classifier — the existing `job_links` already carries
      // the right `(kind, job_id)` edges; we only need to enrich each
      // entry with the linked `jobs` row's display fields.
      //
      // Re-using the SAME enrichment shape as the live reducer:
      //   row.{title, state, rate_limited_at} — same column SELECT;
      //   missing row → defaults {title: null, state: "stopped",
      //                            rate_limited_at: null}
      //
      // The (kind, job_id) sort tiebreaker is re-applied for safety —
      // a hand-written or otherwise-mis-sorted blob would otherwise ride
      // through.
      const epicRowsV21 = db
        .prepare("SELECT epic_id, job_links FROM epics")
        .all() as { epic_id: string; job_links: string | null }[];
      for (const row of epicRowsV21) {
        // Safe parse — a malformed blob folds to []. NEVER throw inside
        // migrate() (a throw rolls back the surrounding BEGIN IMMEDIATE
        // and wedges the upgrade).
        let entries: { kind: string; job_id: string }[] = [];
        if (row.job_links != null && row.job_links.length > 0) {
          try {
            const parsed = JSON.parse(row.job_links);
            if (Array.isArray(parsed)) {
              entries = parsed as { kind: string; job_id: string }[];
            }
          } catch {
            // malformed blob — fold to []; the UPDATE below writes '[]'
            // and the entry is gone (matches the zero-event reading).
          }
        }
        const enriched: {
          kind: string;
          job_id: string;
          title: string | null;
          state: string;
          rate_limited_at: number | null;
        }[] = [];
        for (const e of entries) {
          if (
            e == null ||
            typeof e !== "object" ||
            typeof e.kind !== "string" ||
            typeof e.job_id !== "string"
          ) {
            continue; // malformed entry — drop.
          }
          const jobRow = db
            .prepare(
              "SELECT title, state, rate_limited_at FROM jobs WHERE job_id = ?",
            )
            .get(e.job_id) as {
            title: string | null;
            state: string;
            rate_limited_at: number | null;
          } | null;
          if (jobRow == null) {
            // Orphan entry (job_id with no `jobs` row) — retain with
            // safe defaults so re-fold determinism holds.
            enriched.push({
              kind: e.kind,
              job_id: e.job_id,
              title: null,
              state: "stopped",
              rate_limited_at: null,
            });
          } else {
            enriched.push({
              kind: e.kind,
              job_id: e.job_id,
              title: jobRow.title,
              state: jobRow.state,
              rate_limited_at: jobRow.rate_limited_at,
            });
          }
        }
        // Total-order ASC sort on (kind, job_id) — mirrors `sortJobLinks`
        // in `src/reducer.ts`. Re-apply for safety: a hand-written or
        // otherwise-mis-sorted blob would otherwise produce a different
        // post-migration JSON than a from-scratch re-fold.
        enriched.sort((a, b) => {
          if (a.kind < b.kind) return -1;
          if (a.kind > b.kind) return 1;
          if (a.job_id < b.job_id) return -1;
          if (a.job_id > b.job_id) return 1;
          return 0;
        });
        db.run("UPDATE epics SET job_links = ? WHERE epic_id = ?", [
          JSON.stringify(enriched),
          row.epic_id,
        ]);
      }
    }

    // v21→v22: add `events.config_dir` (the `CLAUDE_CONFIG_DIR` env value
    // captured by the hook at SessionStart — the arthack-claude profile
    // directory the session ran under) and `jobs.config_dir` (the projection
    // of that capture, latest-non-NULL-wins via the SessionStart fold's
    // `COALESCE(excluded.config_dir, jobs.config_dir)` ON CONFLICT SET).
    // Both nullable, no backfill — pre-feature SessionStart events have no
    // recoverable env, so ADD COLUMN leaves existing rows NULL, which is
    // exactly the zero-event reading. Mirrors the v3→v4 spawn_name step:
    // column defs match CREATE_EVENTS / CREATE_JOBS verbatim.
    addColumnIfMissing(db, "events", "config_dir", "TEXT");
    addColumnIfMissing(db, "jobs", "config_dir", "TEXT");

    // v22→v23: register the `usage` table (created above by the unconditional
    // `CREATE_USAGE` bootstrap block). Per-profile agentuse quota snapshots
    // — one row per `~/.local/state/agentuse/<id>.json`. The CREATE TABLE
    // IF NOT EXISTS is idempotent and runs on every boot — no ALTER step is
    // required here, so this block is a comment-only no-op that documents
    // what the v23 stamp gates. Without this note the bare SCHEMA_VERSION =
    // 23 bump would violate the CLAUDE.md invariant ("Bump SCHEMA_VERSION
    // only when adding an ALTER block to migrate()"); a future real v22→v23
    // ALTER would have to land alongside this comment's removal. Mirrors the
    // v14→v15 git_status registration step exactly.
    //
    // NO freshness columns: every `fetched_at` / `next_fetch_at` /
    // `last_successful_fetch_at` / `last_skipped_fetch_at` field on the
    // source envelope is read-and-discarded by the worker. See
    // `src/usage-worker.ts` for the change-gate discipline that enforces the
    // same exclusion on the producer side; a freshness column added here
    // (or to the worker's change-gate hash) would churn every ~90s.

    // v23→v24: generalize the rate-limit annotation column into a two-field
    // signal. Replace `jobs.rate_limited_at REAL` with the pair
    // `jobs.last_api_error_at REAL` + `jobs.last_api_error_kind TEXT`,
    // matching the new {@link import("./types").ApiErrorKind} union. The
    // reducer's pre-v24 `RateLimited` arm becomes a dual-case fold over
    // `RateLimited | ApiError` (both labels route to one handler — the
    // historical event log re-folds byte-deterministically; legacy events
    // force `kind = "rate_limit"`, new events read `event.data.kind`).
    //
    // Pair-step: the same two columns are added to the embedded `jobs`
    // array shape (`EmbeddedJobElement` in `src/reducer.ts`, mirrored on
    // `EmbeddedJob` in `src/types.ts`) AND to the `JobLinkEntry` shape on
    // `epics.job_links`. Historical serialized JSON arrays from v23 carry
    // the OLD `rate_limited_at` field; without a rewind, incremental
    // `syncJobIntoEpic` / `syncJobLinksOnJobWrite` writes from later events
    // would re-serialize entries WITH the new field-pair while neighbour
    // entries in the same array stayed WITH the old field, breaking the
    // byte-identical re-fold invariant (CLAUDE.md). The rewind-and-redrain
    // below harmonizes all three sides — `jobs` columns, `epics.jobs[]`,
    // `epics.tasks[].jobs[]`, `epics.job_links[]` — to "new schema
    // everywhere".
    //
    // Step 1: add the two new `jobs` columns. Both nullable, no DEFAULT —
    // ADD COLUMN leaves prior rows reading NULL, which is exactly the
    // zero-event / never-errored projection. Column defs match
    // `CREATE_JOBS` so a fresh v24 DB and a migrated v23→v24 DB converge
    // to identical schema (the addColumnIfMissing/literal lockstep
    // convention).
    addColumnIfMissing(db, "jobs", "last_api_error_at", "REAL");
    addColumnIfMissing(db, "jobs", "last_api_error_kind", "TEXT");

    // Step 2: drop the legacy `rate_limited_at` column. Idempotent
    // (drops only if present), so this runs every boot and converges
    // whether the DB is a fresh v24 (CREATE_JOBS already omits it) or
    // an older v23 DB that still carries it. The historical fact is
    // preserved in the immutable event log (every stored `RateLimited`
    // event still mints the stamp on re-fold via the dual-case alias);
    // the projection is rebuilt fresh by the rewind-and-redrain below,
    // so we can safely drop the column without an explicit backfill.
    dropColumnIfPresent(db, "jobs", "rate_limited_at");

    // Step 3: rewind-and-redrain — same shape as the v17→v18 +
    // v18→v19 steps. Version-guarded: re-open of an already-migrated
    // v24+ DB skips it (the guard reads the meta row written by a
    // PRIOR migrate(); on a fresh v24 DB or one that crashed before
    // stamping v24, `storedVersionV24 < 24` and the rewind runs; on
    // steady-state v24+ DB it skips). The boot drain after migrate()
    // returns rebuilds `jobs` / `epics` / `subagent_invocations` from
    // the event log, re-emitting embedded `jobs` arrays + `job_links`
    // arrays with the new field-pair on every entry — legacy stored
    // `RateLimited` events fold to `kind="rate_limit"` via the dual
    // -case alias, so the post-rewind projection carries the new
    // shape with the right semantic content.
    const storedVersionV24 = Number(
      (
        db
          .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
          .get() as { value: string } | null
      )?.value ?? "0",
    );
    if (storedVersionV24 < 24) {
      db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
      db.run("DELETE FROM jobs");
      db.run("DELETE FROM epics");
      db.run("DELETE FROM subagent_invocations");
    }

    // v24→v25: surface "session blocked on AskUserQuestion" as a two-field
    // signal mirroring the fn-616 (api-error) shape. Add the pair
    // `jobs.last_input_request_at REAL` + `jobs.last_input_request_kind
    // TEXT`, matching the new {@link import("./types").InputRequestKind}
    // union. The reducer's `InputRequest` arm clones the v24 `ApiError`
    // arm's shape: one terminal-guarded UPDATE that flips `state` to
    // `'stopped'` AND stamps both columns together. Four clear arms zero
    // both columns: `UserPromptSubmit` + `SessionStart` unconditionally,
    // `PreToolUse` + `PostToolUse` gated on `last_input_request_at IS NOT
    // NULL` (hot path — `AskUserQuestion` fires no hook of its own, so the
    // closest "answered" signal is the next tool the agent uses).
    //
    // Pair-step: the same two columns are added to the embedded `jobs`
    // array shape (`EmbeddedJobElement` in `src/reducer.ts`, mirrored on
    // `EmbeddedJob` in `src/types.ts`) AND to the `JobLinkEntry` shape on
    // `epics.job_links`. Historical serialized JSON arrays from v24 do
    // NOT carry the new field-pair; without a rewind, incremental
    // `syncJobIntoEpic` / `syncJobLinksOnJobWrite` writes from later
    // events would re-serialize entries WITH the new pair while neighbour
    // entries in the same array stayed WITHOUT it, breaking the
    // byte-identical re-fold invariant (CLAUDE.md). The rewind-and-redrain
    // below harmonizes all three sides — `jobs` columns, `epics.jobs[]`,
    // `epics.tasks[].jobs[]`, `epics.job_links[]` — to "new schema
    // everywhere".
    //
    // Step 1: add the two new `jobs` columns. Both nullable, no DEFAULT —
    // ADD COLUMN leaves prior rows reading NULL, which is exactly the
    // zero-event / never-blocked-on-input-request projection. Column defs
    // match `CREATE_JOBS` so a fresh v25 DB and a migrated v24→v25 DB
    // converge to identical schema (the addColumnIfMissing/literal
    // lockstep convention).
    addColumnIfMissing(db, "jobs", "last_input_request_at", "REAL");
    addColumnIfMissing(db, "jobs", "last_input_request_kind", "TEXT");

    // Step 2: rewind-and-redrain — same shape as the v17→v18, v18→v19,
    // v23→v24 steps. Version-guarded: re-open of an already-migrated v25+
    // DB skips it (the guard reads the meta row written by a PRIOR
    // migrate(); on a fresh v25 DB or one that crashed before stamping
    // v25, `storedVersionV25 < 25` and the rewind runs; on steady-state
    // v25+ DB it skips). The boot drain after migrate() returns rebuilds
    // `jobs` / `epics` / `subagent_invocations` from the event log,
    // re-emitting embedded `jobs` arrays + `job_links` arrays with the
    // new field-pair on every entry — the transcript matcher and the
    // synthetic `InputRequest` mint arrive in the same task .1, so a
    // re-fold of an event log that pre-dates fn-617 contains zero
    // `InputRequest` events and the new columns simply read NULL
    // everywhere (the zero-event projection — which is also the steady-
    // state pre-fn-617 reading).
    const storedVersionV25 = Number(
      (
        db
          .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
          .get() as { value: string } | null
      )?.value ?? "0",
    );
    if (storedVersionV25 < 25) {
      db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
      db.run("DELETE FROM jobs");
      db.run("DELETE FROM epics");
      db.run("DELETE FROM subagent_invocations");
    }

    // v26: widen `SPAWN_VERB_REF_RE` to accept the `approve` verb so
    // sessions launched as `claude --name approve::<ref> '/plan:approve
    // <ref>'` populate `jobs.plan_verb` / `jobs.plan_ref` and embed into
    // the parent epic's / task's `jobs[]` array — uniform with `plan` /
    // `work` / `close`. The regex change is data-incompatible: existing
    // events with `spawn_name="approve::..."` folded under the old regex
    // left `plan_verb` NULL on their jobs row and skipped the
    // `syncJobIntoEpic` embed. Rewind the cursor + clear projections so
    // boot drain re-folds every event under the widened regex and the
    // existing approve sessions land in the right embedded arrays. Same
    // shape as every prior version-guarded rewind in this file.
    const storedVersionV26 = Number(
      (
        db
          .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
          .get() as { value: string } | null
      )?.value ?? "0",
    );
    if (storedVersionV26 < 26) {
      db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
      db.run("DELETE FROM jobs");
      db.run("DELETE FROM epics");
      db.run("DELETE FROM subagent_invocations");
    }

    // v26→v27: surface the agentuse `sonnet_week` quota window as a paired
    // `(sonnet_week_percent, sonnet_week_resets_at)` field on the `usage`
    // projection — third column alongside `session` and `week`. Only some
    // profiles (currently the claude target) carry it, so both columns are
    // nullable with no backfill. Idempotent ADD COLUMN matches the v3→v4
    // shape — no rewind needed: existing `UsageSnapshot` events predate the
    // worker's sonnet_week parse, so a re-fold would leave the columns NULL
    // (which IS the steady-state zero-event reading). The next scrape from
    // the producer surfaces the data via a fresh synthetic event.
    addColumnIfMissing(db, "usage", "sonnet_week_percent", "REAL");
    addColumnIfMissing(db, "usage", "sonnet_week_resets_at", "TEXT");

    // v27→v28: denormalize the per-job dirty-file count and the project-wide
    // orphan-file count onto the `jobs` projection so readiness predicates
    // can branch on git cleanliness without joining `git_status`. Pair-step:
    // add `jobs.git_dirty_count INTEGER NOT NULL DEFAULT 0` (per-job — from
    // the producer's `snapshot.jobs[*].dirty.length`) and
    // `jobs.git_orphan_count INTEGER NOT NULL DEFAULT 0` (project-broadcast
    // — `snapshot.orphaned_files.length` stamped onto every job enumerated
    // in the same snapshot). The reducer's `projectGitStatus` arm fans these
    // out inside the same `BEGIN IMMEDIATE` transaction that writes
    // `git_status`, then re-runs `syncJobIntoEpic` on each touched job so
    // the embedded `jobs[]` arrays on epics + task elements carry the new
    // counts as well (mirrors the schema v24/v25 fan-out shape:
    // `last_api_error_*` / `last_input_request_*` rode the same RMW path).
    //
    // Pair-step: the same two fields are added to `EmbeddedJob` (typed in
    // `src/types.ts`) and to `EmbeddedJobElement` (the reducer-internal
    // mirror in `src/reducer.ts`). `buildEmbeddedJob` reads the new columns
    // off the post-write `jobs` row so every `syncJobIntoEpic` caller (Stop,
    // SessionEnd, UserPromptSubmit, RateLimited, ApiError, InputRequest
    // arms, plus the new GitSnapshot fan-out) automatically lands the new
    // counts in the embedded arrays — no caller audit-and-pass needed
    // because the canonical input shape changes underneath.
    //
    // Step 1: add the two new `jobs` columns. Both `INTEGER NOT NULL
    // DEFAULT 0` — a never-snapshotted job reads "0 dirty, 0 orphan", which
    // is exactly the zero-event projection (no GitSnapshot has fanned in
    // for this session). Column defs match `CREATE_JOBS` so a fresh v28 DB
    // and a migrated v27→v28 DB converge to identical schema (the
    // addColumnIfMissing/literal lockstep convention).
    addColumnIfMissing(
      db,
      "jobs",
      "git_dirty_count",
      "INTEGER NOT NULL DEFAULT 0",
    );
    addColumnIfMissing(
      db,
      "jobs",
      "git_orphan_count",
      "INTEGER NOT NULL DEFAULT 0",
    );

    // Step 2: NO rewind. The migration window is "false-clean" — every
    // pre-v28 jobs row reads 0/0 until the next `GitSnapshot` tick from the
    // git-worker re-snapshots its watched roots (typically sub-second via
    // `data_version` polling). A rewind would be expensive (touches every
    // event) and the steady-state convergence is fast enough that the
    // minimal-scope choice wins. The from-scratch re-fold path is
    // unaffected: replaying every historical GitSnapshot event re-derives
    // the counts byte-identically via the new fan-out, and an event log
    // with zero GitSnapshot events leaves the columns at 0 (which IS the
    // steady-state zero-event reading).

    // v28→v29: surface the "this epic was created by another epic's closer
    // session" relationship as first-class projection fields on `epics`.
    // Two columns:
    //   - `created_by_closer_of TEXT` — the raw closer→child link (the
    //     closer's `plan_ref`, i.e. the id of the closed epic that spawned
    //     this one). NULL for plain epics.
    //   - `sort_path TEXT NOT NULL DEFAULT ''` — a zero-padded-6 dotted
    //     lexicographic key like `"000003.000007"` driving the descriptor's
    //     default sort. The dot (ASCII 46) is strictly less than the digits
    //     (ASCII 48-57) so the prefix-sort invariant
    //     `"000003" < "000003.000007" < "000004"` holds under SQLite BINARY
    //     collation.
    //
    // The reducer's `syncPlanctlLinks` fan-out derives both columns inside
    // the same `BEGIN IMMEDIATE` transaction as the existing `job_links`
    // write, and cascades a `sort_path` change to every transitive
    // descendant (cycle guard caps depth at 50 — defense-in-depth, since
    // `created_by_closer_of` is immutable by construction). The
    // `EPICS_DESCRIPTOR` in `src/collections.ts` flips its `defaultSort`
    // from `epic_number` to `sort_path` so the existing generic ORDER BY
    // template at `src/server-worker.ts` produces the slotted order with
    // zero code change.
    //
    // Step 1: add the two new `epics` columns. `created_by_closer_of` is
    // nullable TEXT with no DEFAULT (matches the reducer's NULL-for-plain-
    // epic semantics). `sort_path` is `TEXT NOT NULL DEFAULT ''` — the
    // empty-string default matches the schema's zero-event reading and the
    // shell-INSERT branches in `syncPlanctlLinks` / `projectPlanRow` (the
    // next `syncPlanctlLinks` call computes the real value). Both column
    // defs match `CREATE_EPICS` so a fresh v29 DB and a migrated v28→v29
    // DB converge to identical schema (the addColumnIfMissing/literal
    // lockstep convention; mirrors the v27→v28 `git_dirty_count` /
    // `git_orphan_count` pair-step shape).
    addColumnIfMissing(db, "epics", "created_by_closer_of", "TEXT");
    addColumnIfMissing(db, "epics", "sort_path", "TEXT NOT NULL DEFAULT ''");

    // Step 2: rewind-and-redrain — same shape as the v25→v26 spawn-name
    // widening. Both new columns are derived from the existing event log
    // (closer-creator link via `jobs.plan_verb` / `plan_ref` of the
    // creator session, surfaced through the v14 `job_links` projection;
    // sort path composed transitively from `epic_number`s along the
    // closer chain). A re-fold from cursor=0 under the new
    // `syncPlanctlLinks` derivation rebuilds both columns byte-deterministic-
    // ally from the same events the daemon already has. Version-guarded
    // mirrors prior rewinds: re-open of an already-migrated v29+ DB skips
    // the block.
    const storedVersionV29 = Number(
      (
        db
          .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
          .get() as { value: string } | null
      )?.value ?? "0",
    );
    if (storedVersionV29 < 29) {
      db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
      db.run("DELETE FROM jobs");
      db.run("DELETE FROM epics");
      db.run("DELETE FROM subagent_invocations");
    }

    // v29→v30: thread the `/plan:queue` priority-jump signal through the
    // existing planctl envelope → events sparse column → epics projection
    // pipeline so root epics scaffolded via `/plan:queue` sort above all
    // other root epics in the dashctl board.
    //
    // Two new columns:
    //   - `events.planctl_queue_jump INTEGER` — sparse; mirrors the existing
    //     `planctl_op` / `planctl_target` / `planctl_epic_id` / `planctl_task_id`
    //     / `planctl_subject_present` five-column pattern. Lifted from
    //     `data.tool_response.stdout`'s `planctl_invocation.queue_jump` boolean
    //     by `extractPlanctlInvocation`. Stays NULL on every row whose
    //     `planctl_op IS NULL`; stamped `0` / `1` whenever the envelope is
    //     present. The deriver's `=== true` defensive check folds absent /
    //     non-boolean / older-envelope shapes to `0`, which is what makes the
    //     v29→v30 re-fold byte-identical: legacy events have no `queue_jump`
    //     key, so they all fold to `0`.
    //   - `epics.queue_jump INTEGER NOT NULL DEFAULT 0` — projected by
    //     `syncPlanctlLinks` from the touched epic's events. Drives the
    //     `!`-prefix `sort_path` branch for root epics (`created_by_closer_of
    //     IS NULL`) so `sort_path = "!" + zeroPad6(epic_number)` lifts the
    //     epic above every non-queued root under SQLite BINARY collation (`!`
    //     is ASCII 33, strictly below the digits at 48-57). The prefix is
    //     propagated through `parentPath` string concat to all transitive
    //     closer-of descendants in `cascadeSortPath` — no separate child-flag
    //     plumbing.
    //
    // Both column defs match `CREATE_EVENTS` / `CREATE_EPICS` so a fresh v30
    // DB and a migrated v29→v30 DB converge to identical schema (the
    // addColumnIfMissing/literal lockstep convention; mirrors the v28→v29
    // pair-step shape one block up). SQLite has no native BOOLEAN; the column
    // is INTEGER (0/1), matching the `planctl_subject_present` convention.
    // No new index — the queue_jump signal is read off the planctl-event
    // partial composite index (`(session_id, id) WHERE planctl_op IS NOT NULL`)
    // already created by v14, since the column is only ever read inside the
    // same per-session scan `syncPlanctlLinks` already runs.
    addColumnIfMissing(db, "events", "planctl_queue_jump", "INTEGER");
    addColumnIfMissing(db, "epics", "queue_jump", "INTEGER NOT NULL DEFAULT 0");

    // Rewind-and-redrain — same shape as v28→v29 one block up. The
    // `events.planctl_queue_jump` column is derived from the immutable event
    // log (the envelope's `queue_jump` boolean lifted by `extractPlanctlInvocation`)
    // and `epics.queue_jump` is projected from it via `syncPlanctlLinks`. A
    // re-fold from cursor=0 under the new deriver + new projection rebuilds
    // both byte-deterministically. Version-guarded mirrors prior rewinds:
    // re-open of an already-migrated v30+ DB skips the block. The boot drain
    // after migrate() returns rebuilds `jobs` / `epics` / `subagent_invocations`
    // from the event log with the new field everywhere; legacy events fold to
    // `0` via the deriver's `=== true` check (their envelope has no
    // `queue_jump` key) so the post-rewind projection carries the new shape
    // with the right semantic content.
    const storedVersionV30 = Number(
      (
        db
          .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
          .get() as { value: string } | null
      )?.value ?? "0",
    );
    if (storedVersionV30 < 30) {
      db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
      db.run("DELETE FROM jobs");
      db.run("DELETE FROM epics");
      db.run("DELETE FROM subagent_invocations");
    }

    // v30→v31: rewrite the git-attribution surface from "files attributed to
    // a live session, everything else is orphan" to honest per-(session, file)
    // attribution with a commit-based discharge rule. This task lands the
    // schema slot only — the reducer fold that fills `file_attributions` from
    // events + the bash mutation deriver land in tasks .3 / .6.
    //
    // Three schema-level changes:
    //   1. `events.bash_mutation_kind TEXT` + `events.bash_mutation_targets TEXT`
    //      — two sparse columns, NULL on every row whose PostToolUse:Bash payload
    //      didn't parse as a mutation. The deriver (task .3) populates them at
    //      hook write time; this block adds the slot. Partial index on
    //      `bash_mutation_kind` follows the schema-v10 / v14 / v17 pattern —
    //      kept OUT of `CREATE_EVENTS_INDEXES` so a migrating v30 DB doesn't
    //      try to index a column it hasn't gained yet, run AFTER the matching
    //      addColumnIfMissing here.
    //   2. `jobs.git_orphan_count` RENAME → `jobs.git_unattributed_to_live_count`
    //      + fresh `jobs.git_orphan_count INTEGER NOT NULL DEFAULT 0` with the
    //      new strict-mystery semantic. The legacy v28 `git_orphan_count`
    //      column held "files-not-attributed-to-a-live-session" (which IS the
    //      definition of `git_unattributed_to_live_count` under the new
    //      vocabulary), so we rename the storage slot in place — that
    //      preserves the column's pre-existing DEFAULT 0 zero-event reading
    //      AND keeps the SQLite RENAME COLUMN cheap (just a catalog patch,
    //      no row rewrite). The fresh `git_orphan_count` column carries the
    //      new strict-mystery semantic (files with no attribution from any
    //      session — past or present), populated by the new reducer fold
    //      in task .6. Both columns land in `CREATE_JOBS` so a fresh v31 DB
    //      and a migrated v30→v31 DB converge to the same schema. Readiness
    //      predicate 6.5 flips to read `git_unattributed_to_live_count`
    //      (the same numeric value it read before under the old name) in
    //      task .6's client work; this task touches only the storage layer.
    //   3. `file_attributions` table — one row per `(project_dir, session_id,
    //      file_path)` triple, the discharge-aware attribution record the
    //      new fold maintains. PK is the three-column composite (so multi-
    //      attribution per file across sessions and worktrees lives as
    //      distinct rows). Two non-partial indexes serve the per-file
    //      multi-attribution read and the per-session retract sweep.
    //
    // Defensive SQLite version check: RENAME COLUMN requires 3.25+ and Bun
    // ships 3.46+, so this is extremely unlikely to trip — but the
    // sub-system invariant (forward-only migration, never-throw-inside-
    // migrate) makes a cheap pre-check the right choice when the
    // alternative is a half-applied schema. The check runs unconditionally
    // (no version guard) so a future SQLite downgrade is caught even on a
    // re-opened v31 DB.
    const sqliteVer = (
      db.prepare("SELECT sqlite_version() AS v").get() as { v: string }
    ).v;
    {
      const parts = sqliteVer.split(".").map((n) => Number(n));
      const major = parts[0] ?? 0;
      const minor = parts[1] ?? 0;
      if (major < 3 || (major === 3 && minor < 25)) {
        throw new Error(
          `schema v31 requires SQLite 3.25+ for RENAME COLUMN; found ${sqliteVer}`,
        );
      }
    }

    // Step 1: events sparse columns.
    addColumnIfMissing(db, "events", "bash_mutation_kind", "TEXT");
    addColumnIfMissing(db, "events", "bash_mutation_targets", "TEXT");

    // Step 2: jobs column rename + new column.
    //
    // The rename runs BEFORE the addColumnIfMissing for the new
    // `git_orphan_count`. Order matters: if we ran `addColumnIfMissing` first
    // against a v30 DB whose `git_orphan_count` was the LEGACY column, the
    // add would no-op (column already present) and the rename below would
    // fail (`hasOld && hasNew` → drift error). By renaming first, the
    // legacy `git_orphan_count` becomes `git_unattributed_to_live_count`,
    // freeing the name for the fresh DEFAULT 0 column the next call adds.
    //
    // On a fresh v31 DB, CREATE_JOBS already carries both column names
    // — the rename is a no-op (`!hasOld && hasNew`) and the
    // addColumnIfMissing is a no-op (`git_orphan_count` is present).
    // On a re-opened already-migrated v31 DB the same two no-ops hold:
    // the migrate-once invariant is maintained without a version guard
    // (the helpers' triple-state idempotence does the work).
    renameColumnIfPresent(
      db,
      "jobs",
      "git_orphan_count",
      "git_unattributed_to_live_count",
    );
    addColumnIfMissing(
      db,
      "jobs",
      "git_orphan_count",
      "INTEGER NOT NULL DEFAULT 0",
    );

    // Step 3: partial index on the new bash_mutation_kind column. Pairs with
    // the addColumnIfMissing above — runs AFTER the column exists, mirrors
    // the v10/v14/v17 partial-index pattern.
    for (const sql of CREATE_V31_INDEXES) {
      db.run(sql);
    }

    // Step 3.5: same-transaction backfill of `bash_mutation_kind` /
    // `bash_mutation_targets` on every stored `PostToolUse:Bash` event row.
    // Mirrors the v9→v10 (slash_command/skill_name) + v13→v14 (planctl_*)
    // + v16→v17 (tool_use_id) + v29→v30 (planctl_queue_jump) backfill
    // precedents: the migration walks every candidate row, re-derives the
    // new sparse columns via the SAME pure deriver the hook will call at
    // steady-state, and UPDATEs them in place. Two invariants drive this
    // shape:
    //
    //   1. Re-fold determinism (CLAUDE.md "byte-identical re-fold"):
    //      historical rows and future hook writes must converge on the
    //      same column values for the same payload. Sharing the deriver
    //      function makes that mechanical — there is no second
    //      implementation to drift against the first.
    //   2. Reducer fold dependency: task .6's bash-attribution fold reads
    //      `bash_mutation_kind IS NOT NULL` to know which events
    //      contributed a mutation edge. Without the backfill, every
    //      pre-v31 Bash event would read NULL on the new columns even
    //      though the deriver, applied to its stored payload, would
    //      stamp a kind. The post-rewind boot drain re-folds every event
    //      from scratch — but the projection fold reads the BACKFILLED
    //      `events` rows, not the live deriver, so the events table MUST
    //      already carry the new columns before the boot drain starts.
    //
    // Version-guarded by the same `storedVersionV31 < 31` check that
    // gates the rewind below: a re-open of an already-migrated v31+ DB
    // skips the backfill (idempotence). The check is duplicated rather
    // than hoisted because the rewind block reads the same `meta` row
    // and we keep the two steps decoupled — task .6 may later move the
    // rewind, and the backfill should ride with the migration shape
    // regardless. (`SELECT value FROM meta WHERE key = 'schema_version'`
    // costs ~microseconds per call; the duplication is free.)
    //
    // Performance: re-running the deriver per row is O(rows × command-
    // length). Bash events on a hot keeper DB sit at ~10k-20k; the
    // tokenizer is single-pass over a length-capped string. Wall-clock
    // budget on a realistic event log is sub-second. If a future log
    // grows past the 5s informal target, the row-walk would need
    // chunking — the spec's "Risks" section flags this as future work.
    const storedVersionV31Backfill = Number(
      (
        db
          .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
          .get() as { value: string } | null
      )?.value ?? "0",
    );
    if (storedVersionV31Backfill < 31) {
      const rows = db
        .prepare(
          `SELECT id, hook_event, tool_name, cwd, data FROM events
             WHERE tool_name = 'Bash' AND hook_event = 'PostToolUse'`,
        )
        .all() as {
        id: number;
        hook_event: string;
        tool_name: string | null;
        cwd: string | null;
        data: string;
      }[];
      const updateStmt = db.prepare(
        `UPDATE events
            SET bash_mutation_kind = ?, bash_mutation_targets = ?
          WHERE id = ?`,
      );
      for (const row of rows) {
        // Defensive parse — a malformed historical `data` blob folds to
        // safe NULL (matching the CLAUDE.md "safe value on malformed
        // payload" invariant); the deriver itself never throws on any
        // parsed shape because every branch is a typeof guard. The
        // try/catch around JSON.parse keeps a corrupt row from wedging
        // the migration.
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(row.data) as Record<string, unknown>;
          if (typeof parsed !== "object" || parsed === null) {
            updateStmt.run(null, null, row.id);
            continue;
          }
        } catch {
          updateStmt.run(null, null, row.id);
          continue;
        }
        const mutation = extractBashMutation(
          row.hook_event,
          row.tool_name,
          parsed,
          row.cwd,
        );
        if (mutation === null) {
          updateStmt.run(null, null, row.id);
          continue;
        }
        updateStmt.run(mutation.kind, JSON.stringify(mutation.targets), row.id);
      }
    }

    // Step 4: version-guarded rewind-and-redrain. Required because the new
    // `git_orphan_count` carries a fundamentally different semantic (strict
    // mystery — populated by the new reducer fold in task .6), AND
    // `file_attributions` rows are computed by the same fold from the event
    // log. A pre-v31 jobs row carries the old legacy `git_orphan_count`
    // value under the renamed column (`git_unattributed_to_live_count`),
    // which is correct under the new vocabulary, but the new `git_orphan_count`
    // column would read DEFAULT 0 — which means "no mystery files" — until
    // the next `GitSnapshot` re-fans counts. The honest path is to wipe and
    // re-fold: cursor=0, DELETE jobs/epics/git_status/file_attributions,
    // boot drain re-derives every column byte-deterministically under the
    // new schema. (`subagent_invocations` is unaffected by this migration
    // but the prior rewind blocks all wipe it for symmetry with the
    // "rebuild every projection table" pattern; v31 follows suit.)
    //
    // Version-guarded mirrors prior rewinds: a re-open of an already-
    // migrated v31+ DB skips this block. The boot drain after migrate()
    // returns rebuilds all four projections from the immutable event log
    // under the new reducer fold (task .6 lands the fold; until that
    // task ships, the post-rewind projection reads zero for the new
    // strict-mystery column and `git_unattributed_to_live_count` reads
    // whatever the existing reducer fold produces — which IS the legacy
    // semantic the rename preserved).
    const storedVersionV31 = Number(
      (
        db
          .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
          .get() as { value: string } | null
      )?.value ?? "0",
    );
    if (storedVersionV31 < 31) {
      db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
      db.run("DELETE FROM jobs");
      db.run("DELETE FROM epics");
      db.run("DELETE FROM git_status");
      db.run("DELETE FROM file_attributions");
      db.run("DELETE FROM subagent_invocations");
    }

    // v31→v32: Tier 4.1 (fn-634) — `epics.default_visible` VIRTUAL generated
    // column. Materializes the cross-column predicate
    // `(status='open' OR approval!='approved')` as a single-column 0/1 derived
    // value SQLite computes on every read. Paired with the partial index
    // `idx_epics_default_visible WHERE default_visible = 1` in the always-run
    // `CREATE_EPICS_INDEXES` block below, this collapses the OR-predicate
    // SCAN (which Tier 4 measurement clocked at p95=3.1s on diffTick/metaCount)
    // into a single-column SEARCH against an index that already covers the
    // ORDER BY. No data backfill — VIRTUAL means SQLite recomputes on read,
    // so existing rows automatically expose the correct value without an
    // UPDATE pass.
    //
    // CASE-wrap is load-bearing: `status` is TEXT-nullable (no NOT NULL
    // constraint on the column), and the bare `(status='open' OR
    // approval!='approved')` returns NULL when status IS NULL AND
    // approval='approved' — which would violate the column's NOT NULL
    // constraint at scan time. CASE always returns 0 or 1, never NULL.
    //
    // Uses `addGeneratedColumnIfMissing` (NOT `addColumnIfMissing`): the
    // helper reads `PRAGMA table_xinfo` so generated columns are visible to
    // the idempotence check; `PRAGMA table_info` excludes generated columns
    // entirely and would re-attempt the ALTER on every reopen, throwing
    // "duplicate column" at the next boot.
    addGeneratedColumnIfMissing(
      db,
      "epics",
      "default_visible",
      "INTEGER NOT NULL GENERATED ALWAYS AS (CASE WHEN status='open' OR approval!='approved' THEN 1 ELSE 0 END) VIRTUAL",
    );

    // Tier 2 (fn-628) always-run table-scoped indexes on epics + jobs +
    // events. Placed AFTER the v28→v29 ADD COLUMN block stamps
    // `epics.sort_path` so a migrating-from-v28 DB has the indexed column by
    // the time the index runs. The remaining indexed columns (`epic_id`,
    // `created_at`, `job_id`, `state`) all exist from schema v1; the
    // planctl_* columns indexed here exist from schema v14. `CREATE INDEX IF
    // NOT EXISTS` is idempotent — no SCHEMA_VERSION bump.
    // `ANALYZE epics; ANALYZE jobs; ANALYZE events;` runs unconditionally on
    // every boot so the planner picks the new indexes on first post-upgrade
    // query — cost is negligible on tables under ~1.1k rows for epics/jobs;
    // events sits at ~110k rows on the daemon's hot DB and ANALYZE costs
    // ~10ms there. The fn-628.2 `CREATE_EVENTS_PLANCTL_INDEXES` block
    // pairs with the OR→UNION rewrite at src/reducer.ts:~2371 so both new
    // partial indexes are SEARCHed (not just one) at the hot-path sweep.
    for (const sql of CREATE_EPICS_INDEXES) {
      db.run(sql);
    }
    for (const sql of CREATE_JOBS_INDEXES) {
      db.run(sql);
    }
    for (const sql of CREATE_EVENTS_PLANCTL_INDEXES) {
      db.run(sql);
    }
    db.run("ANALYZE epics");
    db.run("ANALYZE jobs");
    db.run("ANALYZE events");

    // v32→v33: fn-639 — `profiles` projection table keyed by `config_dir`.
    // Maintained entirely by reducer fan-outs (SessionStart `INSERT OR IGNORE`
    // seed + `RateLimited`/`ApiError(rate_limit)` UPSERT) inside the existing
    // `BEGIN IMMEDIATE` transaction. No data backfill — the table populates
    // from the event log on the next drain. A re-open of an already-migrated
    // v33+ DB picks up the table via the unconditional `CREATE TABLE IF NOT
    // EXISTS CREATE_PROFILES` in the bootstrap block above; this slot exists
    // only to stamp the version bump deterministically alongside the existing
    // ordering of migrate slots (the CREATE itself is idempotent and runs on
    // every boot, so a fresh v33 DB picks it up via the bootstrap path).
    //
    // No rewind: a from-scratch re-fold (rewind cursor + `DELETE FROM
    // profiles`) reproduces the table byte-deterministically from the event
    // log, so an existing v32 DB transitioning to v33 will see `profiles`
    // populate organically on the next SessionStart / rate_limit fold without
    // disturbing the other projections.

    // v33→v34: fn-637 — schema foundation for projecting cross-epic dependency
    // resolution into the `epics` row. Two structural additions:
    //   - `epics.resolved_epic_deps TEXT` (nullable JSON array) — carries the
    //     resolved + enriched state of the epic's `depends_on_epics`. NULL is
    //     load-bearing: it means "not-yet-computed" and is DISTINCT from
    //     `'[]'` ("computed, no deps"). The zero-event projection (a freshly
    //     created epics row) reads NULL until the reducer's task-.3 forward-
    //     stamp computes the array. `decodeRow` returns `null` (not `[]`) for
    //     a NULL column — clients branch on null-ness to distinguish "still
    //     converging" from "empty by design".
    //   - `epic_dep_edges (consumer_id, dep_token)` reverse-index table +
    //     `idx_epic_dep_edges_dep_token` — the reverse adjacency list keying
    //     off the raw token from each consumer's `depends_on_epics`. See the
    //     `CREATE_EPIC_DEP_EDGES` literal for the raw-token-vs-resolved-id
    //     rationale (ambiguity flips, dangling deps).
    //
    // Both column + table defs match the `CREATE_EPICS` / `CREATE_EPIC_DEP_EDGES`
    // literals above so a fresh v34 DB and a migrated v33→v34 DB converge to
    // identical schema (the addColumnIfMissing/literal lockstep convention).
    // `addColumnIfMissing` is idempotent — a fresh v34 DB enters this block
    // too and the helper no-ops because the column is already present from
    // `CREATE_EPICS`. The `epic_dep_edges` table + index are picked up by the
    // unconditional bootstrap CREATE block above; this slot exists for the
    // version-bump stamp ordering and the column ALTER.
    //
    // No rewind: a from-scratch re-fold (rewind cursor + `DELETE FROM epics;
    // DELETE FROM epic_dep_edges`) is the task-.3 determinism guarantee, but
    // for the v33→v34 step itself we just leave `resolved_epic_deps` at NULL
    // on existing rows (the "not-yet-computed" sentinel) — the next
    // `EpicSnapshot` fold under the new reducer logic (task .3) will populate
    // it. Forward-only: NULL on a pre-fold row is the correct zero-event
    // shape. No backfill needed at this layer.
    addColumnIfMissing(db, "epics", "resolved_epic_deps", "TEXT");

    // v34→v35: fn-642 — colocate Claude rate-limit state into the `usage`
    // projection. Three structural additions, all matching the CREATE_USAGE /
    // CREATE_PROFILES literals above so a fresh v35 DB and a migrated v34→v35
    // DB converge to identical schema (the addColumnIfMissing/literal lockstep
    // convention):
    //   - `usage.last_rate_limit_at REAL` (nullable) — colocated mirror of the
    //     matching `profiles` row, populated by the schema-v35 forward
    //     (RateLimited → usage) and reverse (UsageSnapshot ← profiles) fan-out
    //     inside the existing `BEGIN IMMEDIATE`.
    //   - `usage.last_rate_limit_session_id TEXT` (nullable) — paired with
    //     `last_rate_limit_at`. Both NULL together (no rate-limit yet for the
    //     matching profile) or both populated; the `RateLimited` arm stamps
    //     them as a pair.
    //   - `profiles.profile_name TEXT` (nullable) — the derived
    //     `projectBasename(config_dir)` (last path segment), maintained by the
    //     SessionStart seed arm in the reducer. Serves as the join key against
    //     `usage.id` so the bidirectional fan-out lands on the matching row.
    //
    // The version-guarded one-time backfill below stamps `profile_name` on
    // every existing `profiles` row, deriving the value via the same
    // `projectBasename` helper the SessionStart seed uses (byte-identical
    // derivation so a from-scratch re-fold and the backfilled row converge).
    // The backfill is non-idempotent (an UPDATE that ran twice is a no-op,
    // but the spec asks for it gated explicitly so a future re-run of this
    // slot can't corrupt). The two `usage` columns need no backfill — they
    // are NULL on every pre-v35 row and re-populated by the next fan-out fold
    // (either a `RateLimited` arrival or a fresh `UsageSnapshot` joining
    // against the matching profile row).
    addColumnIfMissing(db, "usage", "last_rate_limit_at", "REAL");
    addColumnIfMissing(db, "usage", "last_rate_limit_session_id", "TEXT");
    addColumnIfMissing(db, "profiles", "profile_name", "TEXT");
    if (preMigrateStoredVersion < 35) {
      // Non-idempotent (version-guarded): read every `profiles` row, derive
      // `profile_name` from `config_dir` via the SAME `projectBasename` helper
      // the SessionStart seed uses, and UPDATE in-place. Re-fold determinism:
      // a from-scratch re-fold drops the table and re-seeds via SessionStart,
      // which also calls `projectBasename` — the converged shape matches.
      // The `''` sentinel's basename is `""` — left in place as a valid
      // (but non-joining) `profile_name`; the `profile_name != ''` guard on
      // both sides of the join keeps it out of any usage join.
      const rows = db.prepare("SELECT config_dir FROM profiles").all() as {
        config_dir: string;
      }[];
      const updateStmt = db.prepare(
        "UPDATE profiles SET profile_name = ? WHERE config_dir = ?",
      );
      for (const row of rows) {
        updateStmt.run(projectBasename(row.config_dir), row.config_dir);
      }
    }

    // v35→v36: stamp the derived profile name onto every `jobs` row so the
    // usage surface's "recent sessions" log labels each job with its profile
    // without a client-side join. `jobs.profile_name` mirrors the existing
    // `profiles.profile_name` derivation (`projectBasename(config_dir)`),
    // maintained by the reducer's SessionStart fold — the only arm that writes
    // `jobs.config_dir`. Nullable and tracks `config_dir`'s OWN nullability: a
    // NULL `config_dir` (default `~/.claude`, no `CLAUDE_CONFIG_DIR`) derives a
    // NULL `profile_name` rather than the `''`-collapse the `profiles` seed
    // uses — `jobs.config_dir` stays genuinely NULL (COALESCE-on-resume), so a
    // matching-nullability `profile_name` keeps the resume precedence honest.
    // The literal addition above (CREATE_JOBS) keeps a fresh v36 DB and a
    // migrated v35→v36 DB converged on identical schema.
    addColumnIfMissing(db, "jobs", "profile_name", "TEXT");
    if (preMigrateStoredVersion < 36) {
      // Version-guarded one-time backfill. Derive via the SAME `projectBasename`
      // helper the SessionStart fold uses (byte-identical so a from-scratch
      // re-fold — which drops `jobs` and re-seeds via SessionStart — converges
      // on the same value). A NULL `config_dir` yields a NULL `profile_name`,
      // matching the fold's `config_dir == null ? null : projectBasename(...)`
      // derivation exactly. Non-idempotent, hence the explicit version guard so
      // a future re-run of this slot can't re-stamp a since-cleared value.
      const jobRows = db
        .prepare("SELECT job_id, config_dir FROM jobs")
        .all() as {
        job_id: string;
        config_dir: string | null;
      }[];
      const jobUpdateStmt = db.prepare(
        "UPDATE jobs SET profile_name = ? WHERE job_id = ?",
      );
      for (const row of jobRows) {
        jobUpdateStmt.run(
          row.config_dir == null ? null : projectBasename(row.config_dir),
          row.job_id,
        );
      }
    }

    // v36→v37: fn-643 — `dead_letters` OPERATIONAL sidecar table for
    // recovering hook events the daemon-side INSERT dropped (transient
    // SQLITE_BUSY, schema-transition window during a deploy). Picked up
    // unconditionally by the `CREATE TABLE IF NOT EXISTS CREATE_DEAD_LETTERS`
    // in the bootstrap block above; this slot exists only for the version-
    // bump stamp ordering. No data backfill — the table populates exclusively
    // from the daemon's import scan against the per-pid NDJSON dead-letter
    // files (task .3), and stays empty on a fresh DB / a steady-state v37
    // re-open with no dropped events on disk.
    //
    // The table is NOT a reducer projection — it is the daemon's operational
    // record of events that NEVER MADE IT into the event log. The from-
    // scratch re-fold reset path (`UPDATE reducer_state SET last_event_id =
    // 0; DELETE FROM jobs; DELETE FROM epics`, see the v10→v11 slot above
    // and any future rewind-and-redrain step) MUST NOT delete or touch
    // `dead_letters`: re-folding the event log reproduces the projections
    // byte-deterministically, but it cannot reproduce rows for events that
    // were never appended in the first place. The replay verb (task .4) is
    // the only way a `waiting` row transitions to `recovered`: it appends a
    // plain real event (using the row's preserved `bindings` + `ts`) and
    // flips `status`/stamps `recovered_at`/stamps `replayed_event_id` in
    // ONE `BEGIN IMMEDIATE` — the recovered event then folds through the
    // normal id-ordered drain. Re-fold determinism is preserved on the
    // event-log side; the dead-letter sidecar is the daemon's separate
    // audit log of what was never folded until the human recovered it.
    //
    // See `CREATE_DEAD_LETTERS` above for the column docstring.

    // fn-649: COVERING indexes for the hoisted inferred-attribution window
    // self-join (`computeRepoBashWindows`). Created HERE — after every column-
    // adding version slot above — because they reference `tool_use_id` (added in
    // the v16→v17 slot); placing them in the unconditional pre-migration
    // `CREATE_EVENTS_INDEXES` block would fail "no such column" while migrating a
    // pre-v17 DB. Idempotent `CREATE INDEX IF NOT EXISTS`, so no SCHEMA_VERSION
    // bump is needed (and none claimed — leaves v38 free for fn-645/fn-648).
    //
    // Without them the window join reads 64k bash-event full ROWS (~400MB of
    // `data` blobs), which evicts even a 256MB cache and leaves a cold fold
    // holding the write lock multi-second — starving hook INSERTs into dead-
    // letters. These carry every column the query touches (filter + join +
    // SELECT) so the planner uses COVERING INDEX and never visits a data page:
    // measured 15ms on the live DB with an 8MB cache (cache-independent, scales
    // with the log). `_pre` serves the PreToolUse:Bash driver; `_post` the
    // tool_use_id-joined PostToolUse:Bash side (partial on the sparse column).
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_events_bashwin_pre ON events(hook_event, tool_name, ts, tool_use_id, session_id)",
    );
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_events_bashwin_post ON events(tool_use_id, hook_event, tool_name, ts, cwd, session_id) WHERE tool_use_id IS NOT NULL",
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

  // Schema v34 (fn-637): chunked backfill for `resolved_epic_deps` +
  // `epic_dep_edges`. Runs OUTSIDE the main migrate transaction so the
  // WAL writer lock is NOT held across the whole table scan — instead,
  // the backfill writes one short BEGIN IMMEDIATE per chunk, releasing
  // the lock between chunks so concurrent hook inserts are never
  // starved. Version-guarded on the pre-migrate stored version (read
  // BEFORE the transaction stamped v34) so the work runs exactly once
  // per upgrade; a fresh v34 DB and a steady-state re-open both skip it
  // by construction.
  if (preMigrateStoredVersion < 34) {
    backfillResolvedEpicDeps(db);
  }
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
        subagent_agent_id, spawn_name, start_time, slash_command, skill_name,
        planctl_op, planctl_target, planctl_epic_id, planctl_task_id,
        planctl_subject_present, tool_use_id, config_dir, planctl_queue_jump,
        bash_mutation_kind, bash_mutation_targets
      ) VALUES (
        $ts, $session_id, $pid, $hook_event, $event_type, $tool_name, $matcher,
        $cwd, $permission_mode, $agent_id, $agent_type, $stop_hook_active, $data,
        $subagent_agent_id, $spawn_name, $start_time, $slash_command, $skill_name,
        $planctl_op, $planctl_target, $planctl_epic_id, $planctl_task_id,
        $planctl_subject_present, $tool_use_id, $config_dir, $planctl_queue_jump,
        $bash_mutation_kind, $bash_mutation_targets
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
  applyPragmas(db, options.busyTimeoutMs ?? 5000, options.cacheSizeKb);

  if ((options.migrate ?? true) && !readonly) {
    migrate(db);
  }

  const stmts = prepareStmts(db);
  return { db, stmts };
}

// ---------------------------------------------------------------------------
// Schema v13 — planctl approval migration (filesystem half)
// ---------------------------------------------------------------------------

/**
 * Canonical planctl JSON serializer — MUST match
 * `json.dumps(data, indent=2, sort_keys=True) + "\n"` byte-for-byte (the form
 * locked in by task `.1` of the fn-592-approval-as-planctl-field epic). Two
 * cooperating writers (planctl + keeperd) hit the same files; any byte-level
 * diff produces a noisy ping-pong on the next round-trip.
 *
 * Implementation:
 * - Recursively sort object keys lexicographically (Python `sort_keys=True`).
 *   Arrays preserve order — only objects sort.
 * - `JSON.stringify(value, null, 2)` produces the same `,\n<indent>` separators
 *   and `: ` key-value separator as Python's `json.dumps(indent=2)`.
 * - ASCII-escape non-BMP code points as `\uXXXX` (Python's default
 *   `ensure_ascii=True`). JS `JSON.stringify` already escapes the control
 *   characters Python escapes; the only differences are non-ASCII printable
 *   characters which JS emits raw and Python emits as `\uXXXX`.
 * - Append a single trailing `\n`.
 *
 * Exported for unit reach (tests verify the byte-for-byte match against a
 * planctl-produced fixture).
 */
export function serializePlanctlJson(data: unknown): string {
  const sorted = sortObjectKeys(data);
  const body = JSON.stringify(sorted, null, 2);
  return `${escapeNonAscii(body)}\n`;
}

/**
 * Recursively sort an object's keys lexicographically. Arrays preserve order
 * (only object keys are sorted). Primitives, null, and undefined return as-is.
 * Exported for unit reach.
 */
export function sortObjectKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  const out: Record<string, unknown> = {};
  const keys = Object.keys(value as Record<string, unknown>).sort();
  for (const k of keys) {
    out[k] = sortObjectKeys((value as Record<string, unknown>)[k]);
  }
  return out;
}

/**
 * Escape every non-ASCII code unit to `\uXXXX` — matches Python's default
 * `json.dumps(ensure_ascii=True)`. Operates on UTF-16 code units (JS string
 * units), which mirrors Python's per-BMP-codepoint escape behavior on the
 * already-stringified JSON.
 *
 * `JSON.stringify` already escapes 0x00-0x1f identically to Python, so we
 * leave that range alone. We DO escape 0x7f (DEL — Python escapes, JS emits
 * raw) and every code unit >= 0x80 (Python escapes by default, JS emits raw).
 * Astral codepoints come through as surrogate pairs in JS strings, which is
 * also what Python emits for those — each surrogate goes through this loop
 * and emits as its own `\uXXXX` escape.
 */
function escapeNonAscii(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0x20 && code <= 0x7e) {
      out += s[i];
    } else if (code <= 0x1f) {
      // JS already emitted these as `\u00XX`; pass through unchanged. Note
      // we're scanning the POST-stringify output so a real 0x00-0x1f byte
      // can't appear here — JSON.stringify replaced it with the escape.
      out += s[i];
    } else {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    }
  }
  return out;
}

/**
 * Atomically write `content` to `path` via `<path>.tmp.<pid>.<uuid>` →
 * `renameSync`. The temp file lives in the same directory so the rename is
 * always on the same filesystem (POSIX rename atomicity only holds
 * intra-filesystem). On any throw mid-write the temp file is best-effort
 * unlinked so a partial file never lingers.
 *
 * Mirrors `apps/cli_common/cli_common/atomic.py` in the planctl repo (the
 * sibling writer's atomic primitive). Exported for unit reach.
 */
export function atomicWriteFile(path: string, content: string): void {
  const dir = dirname(path);
  const tmp = join(
    dir,
    `${path.slice(dir.length + 1)}.tmp.${process.pid}.${crypto.randomUUID()}`,
  );
  try {
    writeFileSync(tmp, content, { encoding: "utf8" });
    renameSync(tmp, path);
  } catch (err) {
    try {
      // best-effort cleanup; if the unlink fails (already moved, etc) the
      // throw below carries the original error
      if (existsSync(tmp)) {
        unlinkSync(tmp);
      }
    } catch {
      // swallow — original error is the one the caller cares about
    }
    throw err;
  }
}

/**
 * The schema-v13 planctl approval migration's FILESYSTEM half (the SQL half —
 * `epics.approval` ADD COLUMN + `approvals` DROP TABLE — runs inside
 * `migrate()` during `openDb`). Two passes over the configured plan roots:
 *
 *   1) BACKFILL — for every `.planctl/epics/*.json` across `roots`, load the
 *      JSON; if `approval` is absent, write `approval: "approved"` and
 *      atomically rewrite the file (canonical serializer, same dir temp+rename).
 *      Idempotent: a file that already has `approval` is skipped.
 *
 *   2) OVERLAY — read every row from the (about-to-be-dropped) `approvals`
 *      sidecar table. For each row, derive the target file:
 *        - `task_key === "close:<epic_id>"` (the autopilot's per-epic
 *          close-approval pill) → write `epic.approval = <status>` to the
 *          epic file (overrides the blanket "approved" backfill — sidecar wins).
 *        - Otherwise treat `task_key` as a task id (`<epic_id>.<n>`) → write
 *          `task.approval = <status>` to that task file.
 *      Orphan rows (target file missing) log to stderr and skip.
 *
 * The DROP TABLE itself happens inside `migrate()`'s `BEGIN IMMEDIATE`; this
 * function runs AFTER `openDb` returns. The caller (the daemon) MUST invoke
 * this BEFORE spawning workers so the file backfill is durable before any
 * `@parcel/watcher` callback could re-read a half-migrated file.
 *
 * Naturally idempotent on re-run: a missing-on-backfill check skips files
 * that already have `approval`; the overlay reads from `approvals` (which
 * has been dropped on a successful prior run, so the SELECT returns 0 rows);
 * a malformed/missing plan file logs+skips. An empty `roots` array is a no-op.
 *
 * Exported for unit reach + daemon boot use.
 */
export function runPlanctlApprovalMigration(
  db: Database,
  roots: string[],
  log: (msg: string) => void = (m) => console.error(m),
): void {
  // Pass 1 — backfill `approval: "approved"` to epic files lacking it.
  // We walk only `.planctl/epics/*.json` (NOT tasks): the spec is to default
  // existing epics to "approved" (the autopilot's pre-migration semantics);
  // tasks default to "pending" via the schema-zero reading + the plan
  // worker's coerce, so they need no backfill.
  for (const root of roots) {
    const epicsDir = locatePlanctlEpicsDir(root);
    if (epicsDir === null) {
      continue;
    }
    let names: string[];
    try {
      names = readdirSync(epicsDir);
    } catch (err) {
      log(
        `[keeper] approval migration: failed to read ${epicsDir}: ${stringifyMigrationErr(err)}`,
      );
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const full = join(epicsDir, name);
      backfillEpicApproval(full, log);
    }
  }

  // Pass 2 — overlay sidecar rows onto plan files.
  //
  // Two sources, checked in order:
  //   1) `temp._v13_overlay_pending` — populated by `migrate()`'s v12→v13
  //      step BEFORE the DROP TABLE fires. This is the production path: the
  //      daemon's `openDb` ran migrate on THIS connection, which snapshotted
  //      pre-DROP rows into the TEMP table. After we drain it we drop it so
  //      a re-run on the same connection is a clean no-op.
  //   2) `approvals` — the raw v12 sidecar, used by tests that stand up a
  //      v12-shaped DB WITHOUT running migrate (so they can exercise the FS
  //      pass against a still-present sidecar). On a real daemon boot the
  //      `approvals` table has already been dropped by migrate(), so this
  //      branch only fires in those test fixtures.
  //
  // Defensive: both tables may be absent (e.g. fresh-v13 DB, or a re-run
  // after a prior boot completed both halves) — the SELECT is gated on
  // `sqlite_master` so a missing table is a no-op, not a throw.
  // TEMP tables live in the connection's `temp` schema and are visible via
  // `temp.sqlite_master` (NOT the main-schema `sqlite_master`).
  const overlayTableExists =
    db
      .prepare(
        "SELECT name FROM temp.sqlite_master WHERE type = 'table' AND name = '_v13_overlay_pending'",
      )
      .get() != null;
  let rows: { epic_id: string; task_key: string; status: string }[];
  if (overlayTableExists) {
    rows = db
      .prepare("SELECT epic_id, task_key, status FROM _v13_overlay_pending")
      .all() as { epic_id: string; task_key: string; status: string }[];
  } else {
    const approvalsTableExists =
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approvals'",
        )
        .get() != null;
    if (!approvalsTableExists) {
      return;
    }
    rows = db
      .prepare("SELECT epic_id, task_key, status FROM approvals")
      .all() as { epic_id: string; task_key: string; status: string }[];
  }
  if (rows.length === 0) {
    if (overlayTableExists) {
      db.run("DROP TABLE IF EXISTS temp._v13_overlay_pending");
    }
    return;
  }
  // Build a per-root epics-dir lookup so we can locate the target file
  // without walking each root again per row.
  const epicsDirs: string[] = [];
  for (const root of roots) {
    const dir = locatePlanctlEpicsDir(root);
    if (dir !== null) {
      epicsDirs.push(dir);
    }
  }
  for (const row of rows) {
    overlayApprovalRow(row, epicsDirs, log);
  }

  // Drop the TEMP snapshot now that overlay is durable on disk. A second
  // call to `runPlanctlApprovalMigration` on the same connection (e.g. a
  // test re-invocation) is then a clean no-op — no rows to replay.
  if (overlayTableExists) {
    db.run("DROP TABLE IF EXISTS temp._v13_overlay_pending");
  }
}

function stringifyMigrationErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Locate the `.planctl/epics` directory under a project root. Walks the root
 * one level deep — `.planctl` lives at `<root>/<project>/.planctl`, not at
 * `<root>/.planctl` directly. A root with no `.planctl` subdir anywhere
 * returns null. Returns the FIRST match (the migration assumes one keeper
 * project per root; multiple matches log+take the first).
 *
 * NOT recursive: a full walk would re-implement plan-worker's PRUNE_DIRS
 * logic and the migration only cares about the configured project roots.
 * Tests can point `roots` directly at the project dir to control the lookup.
 */
function locatePlanctlEpicsDir(root: string): string | null {
  // First try the root itself — the test fixtures and many real projects
  // point `roots` directly at the project dir.
  const direct = join(root, ".planctl", "epics");
  if (existsSync(direct)) {
    return direct;
  }
  // Otherwise walk one level deep.
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  for (const name of entries) {
    const candidate = join(root, name, ".planctl", "epics");
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Backfill `approval: "approved"` to one epic file if the field is absent.
 * Idempotent (skip-if-present). Any read/parse failure logs+skips — never
 * throws past the caller (one bad file never wedges the migration).
 */
function backfillEpicApproval(path: string, log: (msg: string) => void): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    log(
      `[keeper] approval migration: failed to read ${path}: ${stringifyMigrationErr(err)}`,
    );
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log(
      `[keeper] approval migration: failed to parse ${path}: ${stringifyMigrationErr(err)}`,
    );
    return;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    log(`[keeper] approval migration: ${path} is not a JSON object; skipping`);
    return;
  }
  const obj = parsed as Record<string, unknown>;
  if ("approval" in obj) {
    // Already migrated — idempotent skip.
    return;
  }
  obj.approval = "approved";
  try {
    atomicWriteFile(path, serializePlanctlJson(obj));
  } catch (err) {
    log(
      `[keeper] approval migration: failed to write ${path}: ${stringifyMigrationErr(err)}`,
    );
  }
}

/**
 * Apply one sidecar `approvals` row to the matching plan file. Routes by
 * `task_key`:
 *   - `close:<epic_id>` or bare `<epic_id>` → epic file (sets epic.approval).
 *   - Otherwise → task file (`<epicsDir>/../tasks/<task_key>.json`).
 *
 * Orphan rows (target file missing) log+skip. The status is taken verbatim
 * from the row (`approved` / `rejected` — the v12 CHECK constraint ensures
 * this is one of the two; a hand-corrupted DB would log+skip when the file
 * write or schema validation downstream catches it). The sidecar's row WINS
 * over the blanket "approved" backfill — overlay runs after backfill.
 */
function overlayApprovalRow(
  row: { epic_id: string; task_key: string; status: string },
  epicsDirs: string[],
  log: (msg: string) => void,
): void {
  // Resolve the (epic_id, task_key) pair to a concrete file path.
  const isEpicLevel =
    row.task_key === row.epic_id || row.task_key === `close:${row.epic_id}`;
  // Try each configured epics dir; the first existing match wins.
  for (const epicsDir of epicsDirs) {
    if (isEpicLevel) {
      const path = join(epicsDir, `${row.epic_id}.json`);
      if (existsSync(path)) {
        writeApprovalField(path, row.status, log);
        return;
      }
    } else {
      const tasksDir = join(epicsDir, "..", "tasks");
      const path = join(tasksDir, `${row.task_key}.json`);
      if (existsSync(path)) {
        writeApprovalField(path, row.status, log);
        return;
      }
    }
  }
  log(
    `[keeper] approval migration: orphan sidecar row (epic_id=${row.epic_id}, task_key=${row.task_key}) — target file not found; skipping`,
  );
}

/**
 * Load a plan file, set `approval = status` (overwriting any prior value),
 * atomically rewrite. Caller has already verified `path` exists; a missing
 * file here means a race we can't help with — log+skip.
 */
function writeApprovalField(
  path: string,
  status: string,
  log: (msg: string) => void,
): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    log(
      `[keeper] approval migration: failed to read ${path}: ${stringifyMigrationErr(err)}`,
    );
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log(
      `[keeper] approval migration: failed to parse ${path}: ${stringifyMigrationErr(err)}`,
    );
    return;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    log(`[keeper] approval migration: ${path} is not a JSON object; skipping`);
    return;
  }
  const obj = parsed as Record<string, unknown>;
  obj.approval = status;
  try {
    atomicWriteFile(path, serializePlanctlJson(obj));
  } catch (err) {
    log(
      `[keeper] approval migration: failed to write ${path}: ${stringifyMigrationErr(err)}`,
    );
  }
}

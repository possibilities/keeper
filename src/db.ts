/**
 * Keeper SQLite layer: schema bootstrap, connection-local PRAGMAs, prepared
 * statements, and the forward-only migration ladder.
 *
 * Connection-local PRAGMAs MUST be re-applied on every open (the hook spawns a
 * fresh connection per invocation). Migrations are forward-only via a
 * `meta(schema_version)` row plus idempotent steps that converge on the table's
 * actual shape; destructive steps (DROP COLUMN) must be idempotent.
 */

import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  extractBackgroundTaskId,
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
 * Forward-only — never reduce, never branch. A SCHEMA_VERSION bump MUST add the
 * version to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the same commit.
 */
export const SCHEMA_VERSION = 63;

/** `KEEPER_DB` env wins; else `~/.local/state/keeper/keeper.db`. */
export function resolveDbPath(): string {
  const override = process.env.KEEPER_DB;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "keeper.db");
}

/** `KEEPER_SOCK` env wins; else `~/.local/state/keeper/keeperd.sock`. Pure. */
export function resolveSockPath(): string {
  const override = process.env.KEEPER_SOCK;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "keeperd.sock");
}

/** `KEEPER_RESTORE_FILE` env wins; else `~/.local/state/keeper/restore.json`. Pure. */
export function resolveRestorePath(): string {
  const override = process.env.KEEPER_RESTORE_FILE;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "restore.json");
}

const DEFAULT_PLAN_ROOTS = ["~/code"];

const DEFAULT_CLAUDE_PROJECTS_ROOT = "~/.claude/projects";

const DEFAULT_AGENTUSE_ROOT = "~/.local/state/agentuse";

/** Mirrors `DEFAULT_ZELLIJ_SESSION` in `src/exec-backend.ts`. */
const DEFAULT_ZELLIJ_SESSION = "autopilot";

/**
 * Parsed keeper daemon config. Keys are INDEPENDENT — a malformed/missing one
 * never disturbs the others. Unknown keys are ignored.
 */
export interface KeeperConfig {
  roots: string[];
  claudeProjectsRoot?: string;
  agentuseRoot?: string;
  zellijSession?: string;
  autocloseWindows?: boolean;
  // `null` (default) is unlimited; only a POSITIVE INTEGER overrides.
  // Enforced as a reconcile-level budget, not a readiness verdict.
  maxConcurrentJobs?: number | null;
  // Cosmetic, client-side `<profile-id>: <display>` aliases for the usage TUI;
  // never folded, never changes a row's identity.
  accountAliases: Record<string, string>;
}

export const DEFAULT_AUTOCLOSE_WINDOWS = true;

/**
 * `null` = unlimited. `null` (not `Infinity`) at rest — `Infinity` serializes to
 * `null` via JSON and fails SQLite, so the unlimited sentinel stays `null`
 * end-to-end and becomes a fast-path bypass only at the budget gate.
 */
export const DEFAULT_MAX_CONCURRENT_JOBS: number | null = null;

/** `KEEPER_CONFIG` env wins; else `~/.config/keeper/config.yaml`. Pure. */
export function resolveConfigPath(): string {
  const override = process.env.KEEPER_CONFIG;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".config", "keeper", "config.yaml");
}

/**
 * Read + parse the keeper config YAML. Best-effort — must never throw past this
 * resolver; every key falls back to its default independently.
 */
export function resolveConfig(): KeeperConfig {
  const path = resolveConfigPath();
  let roots: string[] = [...DEFAULT_PLAN_ROOTS];
  let claudeProjectsRoot: string = DEFAULT_CLAUDE_PROJECTS_ROOT;
  let agentuseRoot: string = DEFAULT_AGENTUSE_ROOT;
  let zellijSession: string = DEFAULT_ZELLIJ_SESSION;
  let autocloseWindows: boolean = DEFAULT_AUTOCLOSE_WINDOWS;
  let maxConcurrentJobs: number | null = DEFAULT_MAX_CONCURRENT_JOBS;
  let accountAliases: Record<string, string> = {};
  try {
    if (!existsSync(path)) {
      return {
        roots,
        claudeProjectsRoot,
        agentuseRoot,
        zellijSession,
        autocloseWindows,
        maxConcurrentJobs,
        accountAliases,
      };
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
      const zs = (raw as { zellij_session?: unknown }).zellij_session;
      if (typeof zs === "string" && zs.length > 0) {
        zellijSession = zs;
      }
      const acw = (raw as { autoclose_windows?: unknown }).autoclose_windows;
      if (typeof acw === "boolean") {
        autocloseWindows = acw;
      }
      // Only a POSITIVE INTEGER overrides the unlimited (`null`) default.
      const mcj = (raw as { max_concurrent_jobs?: unknown })
        .max_concurrent_jobs;
      if (typeof mcj === "number" && Number.isInteger(mcj) && mcj > 0) {
        maxConcurrentJobs = mcj;
      }
      // Keep only string→non-empty-string entries; drop the rest.
      const aliases = (raw as { account_aliases?: unknown }).account_aliases;
      if (aliases && typeof aliases === "object" && !Array.isArray(aliases)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(
          aliases as Record<string, unknown>,
        )) {
          if (typeof v === "string" && v.length > 0) out[k] = v;
        }
        accountAliases = out;
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
      zellijSession: DEFAULT_ZELLIJ_SESSION,
      autocloseWindows: DEFAULT_AUTOCLOSE_WINDOWS,
      maxConcurrentJobs: DEFAULT_MAX_CONCURRENT_JOBS,
      accountAliases: {},
    };
  }
  return {
    roots,
    claudeProjectsRoot,
    agentuseRoot,
    zellijSession,
    autocloseWindows,
    maxConcurrentJobs,
    accountAliases,
  };
}

/**
 * Resolve configured plan roots to absolute paths: tilde-expand, then
 * skip-and-log any non-existent/non-directory root so one bad root never
 * silences the others. Re-resolving picks up a root once it appears.
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
 * Resolve the transcript watch root to an absolute path: tilde-expand only, NO
 * existence-filter (the root may not exist yet; the worker tolerates absence).
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
 * Resolve the agentuse watch root to an absolute path. Tilde-expand only, NO
 * existence-filter (the usage-worker tolerates absence).
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
 * `KEEPER_DEAD_LETTER_DIR` env wins; else `~/.local/state/keeper/dead-letters`.
 * MUST match `resolveDeadLetterDir` in `plugin/hooks/events-writer.ts`
 * byte-for-byte (hook writes the NDJSON, daemon reads it) — the hook keeps its
 * own copy because it cannot import `bun:sqlite`.
 */
export function resolveDeadLetterDir(): string {
  const override = process.env.KEEPER_DEAD_LETTER_DIR;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "dead-letters");
}

/**
 * `KEEPER_EVENTS_LOG` env wins; else `~/.local/state/keeper/events-log`. The
 * hook appends a per-pid `<pid>.ndjson` line here; the daemon's ingester tails
 * the files into `events` rows. MUST match `resolveEventsLogDir` in
 * `plugin/hooks/events-writer.ts` byte-for-byte (the hook cannot import
 * `bun:sqlite`).
 */
export function resolveEventsLogDir(): string {
  const override = process.env.KEEPER_EVENTS_LOG;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "events-log");
}

/**
 * `KEEPER_BACKSTOP_LOG` env wins; else `~/.local/state/keeper/backstop.ndjson`.
 * Main is the SOLE writer; never read by the reducer, never feeds a projection.
 * Pure — does no I/O.
 */
export function resolveBackstopLogPath(): string {
  const override = process.env.KEEPER_BACKSTOP_LOG;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "backstop.ndjson");
}

/**
 * SQLite `SQLITE_MAX_VARIABLE_NUMBER` — `IN (?,?,...)` binds one variable per
 * id, so callers of `selectByIds` must chunk past this cap or cap their input.
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
    -- fn-717.2: data relaxed from NOT NULL to nullable. The hook still always
    -- writes a non-null data inline (single INSERT, must-exit-0 contract
    -- unchanged); nullability exists so the daemon-side compaction relocator
    -- (src/compaction.ts) can NULL the hot column AFTER copying the cold blob
    -- into the event_blobs side table. Every reducer data VALUE read resolves
    -- via COALESCE(events.data, event_blobs.data), so a relocated (now-NULL
    -- inline) blob folds byte-identically. A migrating pre-v58 DB gets the same
    -- relax via the stop-the-world rebuild in the v57->v58 migrate block
    -- (bun:sqlite hard-blocks the O(1) writable_schema schema-text edit, so the
    -- only mechanism is a full table rebuild -- a one-time, version-guarded,
    -- daemon-must-be-stopped migration; see the v57->v58 block for the measured
    -- multi-minute writer-lock hold on a ~1.6 GB DB).
    data TEXT,
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
    bash_mutation_targets TEXT,
    planctl_files TEXT,
    backend_exec_type TEXT,
    backend_exec_session_id TEXT,
    backend_exec_pane_id TEXT,
    background_task_id TEXT
)
`;

const CREATE_EVENTS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)",
  "CREATE INDEX IF NOT EXISTS idx_events_hook_event ON events(hook_event)",
  "CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)",
  "CREATE INDEX IF NOT EXISTS idx_events_pid_hook_tool ON events(pid, hook_event, tool_name)",
  "CREATE INDEX IF NOT EXISTS idx_events_hook_tool_ts ON events(hook_event, tool_name, ts)",
  // Covering expression index for the explicit-attribution scan. The partial
  // WHERE + expression must match the consumer query EXACTLY so SQLite turns
  // the scan into a sub-ms covering SEEK. Pure perf — no SCHEMA_VERSION bump.
  "CREATE INDEX IF NOT EXISTS idx_events_tool_attr ON events(json_extract(data, '$.tool_input.file_path'), ts, session_id, tool_name, hook_event) WHERE hook_event = 'PostToolUse' AND tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')",
  // Partial index on the sparse subagent bridge column; the WHERE must match
  // consumer queries exactly.
  "CREATE INDEX IF NOT EXISTS idx_events_subagent_agent_id ON events(subagent_agent_id) WHERE subagent_agent_id IS NOT NULL",
];

/**
 * Indexes on columns added by the v9→v10 ALTER. KEPT OUT of
 * {@link CREATE_EVENTS_INDEXES} so the unconditional CREATE block never
 * references a column that doesn't exist yet on a migrating DB; `migrate()`
 * runs them after the matching ADD COLUMNs.
 */
const CREATE_V10_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_slash_command ON events(slash_command) WHERE slash_command IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_events_skill_name ON events(skill_name) WHERE skill_name IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_jobs_plan_ref ON jobs(plan_ref) WHERE plan_ref IS NOT NULL",
];

/**
 * Index on the `planctl_op` column added by the v13→v14 ALTER (KEPT OUT of the
 * unconditional CREATE block; see {@link CREATE_V10_INDEXES}). The composite
 * `(session_id, id) WHERE planctl_op IS NOT NULL` serves `syncPlanctlLinks`'s
 * per-session ordered scan; the WHERE must match consumer queries syntactically.
 */
const CREATE_V14_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_planctl_session ON events (session_id, id) WHERE planctl_op IS NOT NULL",
];

/**
 * Index on the `tool_use_id` column added by the v16→v17 ALTER (KEPT OUT of the
 * unconditional CREATE block; see {@link CREATE_V10_INDEXES}). Serves the
 * SubagentStart/Stop fold's `WHERE tool_use_id = ?` bridge join.
 */
const CREATE_V17_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_tool_use_id ON events(tool_use_id) WHERE tool_use_id IS NOT NULL",
];

/**
 * Index on the `background_task_id` column added by the v50→v51 ALTER (KEPT OUT
 * of the unconditional CREATE block; see {@link CREATE_V10_INDEXES}). The
 * composite `(session_id, background_task_id, id, tool_name)` partial index
 * serves the reducer's Stop-arm provenance scan; trailing `tool_name` makes it
 * covering.
 */
const CREATE_V51_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_background_task_id ON events(session_id, background_task_id, id, tool_name) WHERE background_task_id IS NOT NULL",
];

/**
 * `subagent_invocations` projection table. `turn_seq` is the per-job monotone
 * turn counter so re-entrant subagents in a session land on distinct rows.
 * Defaults match the zero-event projection.
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
 * Always-run indexes on `epics`. `idx_epics_sort_path` serves
 * explicit-status/filter queries; `idx_epics_default_visible` (partial on the
 * v32 `default_visible` VIRTUAL generated column) serves the default
 * no-wire-filter query without a SCAN or temp B-tree for the ORDER BY.
 */
const CREATE_EPICS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_epics_sort_path ON epics(sort_path, epic_id)",
  "CREATE INDEX IF NOT EXISTS idx_epics_default_visible ON epics(default_visible, sort_path, epic_id) WHERE default_visible = 1",
];

/**
 * Partial composite indexes on `events` for `syncPlanctlLinks`'s cross-session
 * sweep. Paired with the UNION query rewrite in `src/reducer.ts`: the planner
 * picks ONE index per cross-column OR, so the UNION form SEARCHes both the
 * `_epic` and `_target` index instead of SCANning. Trailing `(session_id, id)`
 * keeps them covering. Pure perf — no SCHEMA_VERSION bump.
 */
const CREATE_EVENTS_PLANCTL_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_planctl_epic ON events(planctl_epic_id, session_id, id) WHERE planctl_op IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_events_planctl_target ON events(planctl_target, session_id, id) WHERE planctl_op IS NOT NULL",
];

/**
 * Index serving the default jobs query (`WHERE state NOT IN (...) ORDER BY
 * created_at DESC, job_id`). Shape is `(created_at DESC, job_id, state)` — a
 * `state`-leading key can't serve the `NOT IN` (negation isn't a contiguous
 * range), so `created_at DESC` leads to serve the ORDER BY and trailing `state`
 * makes it covering.
 */
const CREATE_JOBS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_jobs_created_state ON jobs(created_at DESC, job_id, state)",
  "CREATE INDEX IF NOT EXISTS idx_jobs_pid ON jobs(pid)",
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
    profile_name TEXT,
    name_history TEXT NOT NULL DEFAULT '[]',
    backend_exec_type TEXT,
    backend_exec_session_id TEXT,
    backend_exec_pane_id TEXT,
    monitors TEXT NOT NULL DEFAULT '[]',
    last_permission_prompt_at REAL,
    last_permission_prompt_kind TEXT
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
    default_visible INTEGER NOT NULL GENERATED ALWAYS AS (CASE WHEN status IS NOT NULL AND status='open' THEN 1 ELSE 0 END) VIRTUAL
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
 * `usage` projection table — one row per agentuse profile, folded from
 * `UsageSnapshot` / `UsageDeleted` events via a single-row UPSERT.
 *
 * Freshness fields (`fetched_at` etc.) are intentionally absent: both this
 * projection and the worker's change-gate ignore them so a fetch-only refresh
 * produces zero churn. Do NOT add a freshness column without re-reading the
 * freshness-exclusion discipline in `src/usage-worker.ts`.
 *
 * `last_rate_limit_at` / `last_rate_limit_session_id` are populated server-side
 * from `profiles` (joined on `profile_name = projectBasename(config_dir)`) and
 * are CARVED OUT of `projectUsageRow`'s ON CONFLICT clause so a `UsageSnapshot`
 * re-fold can't clobber a `RateLimited` fan-out. Symmetrically,
 * `rate_limit_lifts_at` / `last_usage_fold_at` ride the percentage path and are
 * carved out of the rate-limit fan-out's UPDATE. `last_usage_fold_at` is set
 * from the event `ts` (never `Date.now()`) only on successful-usage snapshots.
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
    status TEXT,
    subscription_active INTEGER,
    error_type TEXT,
    error_message TEXT,
    error_at TEXT,
    rate_limit_lifts_at TEXT,
    last_usage_fold_at REAL,
    last_event_id INTEGER,
    updated_at REAL NOT NULL DEFAULT 0
)
`;

/**
 * `profiles` projection table — one row per Claude profile directory, keyed by
 * `config_dir`. The `''` sentinel collapses NULL `config_dir` → default
 * `~/.claude`; the PK is NOT NULL because SQLite treats multiple NULL PKs as
 * distinct (a nullable PK + `INSERT OR IGNORE` would not dedupe). Maintained by
 * the SessionStart seed fan-out and the `RateLimited`/`ApiError` fan-out, both
 * using `COALESCE(config_dir,'')` so a NULL-config rate limit lands on its seeded
 * row. `profile_name` is the `projectBasename(config_dir)` join key against
 * `usage.id` (the `!= ''` guard keeps sentinel rows out of the join). Both
 * fan-outs read only event payload + in-transaction `jobs.config_dir`.
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
 * `epic_dep_edges` — the reverse adjacency list of `epics.depends_on_epics`,
 * one row per `(consumer_id, dep_token)` edge. `dep_token` is the RAW token
 * (not the resolved id), so the reverse lookup is resolution-independent and
 * handles ambiguity flips: a re-resolve finds every consumer whose dep could
 * match the new candidate. A from-scratch re-fold rebuilds it deterministically.
 */
const CREATE_EPIC_DEP_EDGES = `
CREATE TABLE IF NOT EXISTS epic_dep_edges (
    consumer_id TEXT NOT NULL,
    dep_token TEXT NOT NULL,
    PRIMARY KEY (consumer_id, dep_token)
)
`;

/**
 * Reverse-lookup index on `epic_dep_edges.dep_token`. The composite PK leads on
 * `consumer_id`; the reverse fan-out keys off `dep_token` alone, so it needs a
 * dedicated `dep_token`-first index or it would SCAN on every upstream snapshot.
 */
const CREATE_EPIC_DEP_EDGES_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_epic_dep_edges_dep_token ON epic_dep_edges(dep_token)",
];

/**
 * `dead_letters` OPERATIONAL sidecar table — one row per recovered hook-INSERT
 * failure. NOT a reducer projection: populated by the daemon's import scan of
 * the per-pid NDJSON files the hook writes on a dropped INSERT, never folded.
 * Records events that NEVER MADE IT into the event log, so a from-scratch
 * re-fold MUST NOT touch it. `dl_id` (the hook-generated UUID) is the import
 * idempotency key. The replay verb is the only `waiting → recovered` path: it
 * appends a real event from the saved `bindings` (re-using the dropped event's
 * `ts`) and flips status + stamps `recovered_at`/`replayed_event_id` in ONE
 * transaction.
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
 * Index on `dead_letters(status, dl_written_at)` — serves both the board's
 * `status='waiting'` warn-count and the replay verb's oldest-waiting-first pick.
 */
const CREATE_DEAD_LETTERS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_dead_letters_status_written_at ON dead_letters(status, dl_written_at)",
];

/**
 * `dispatch_failures` projection table — durable stickiness for a failed
 * `(verb, id)` dispatch until a human retries (the reconciler is otherwise
 * stateless across restarts). A reducer projection (folded from synthetic
 * `DispatchFailed` / `DispatchCleared` events in the cursor-advance
 * transaction), so it goes in the re-fold reset DELETE list. `DispatchCleared`
 * (from the `retry_dispatch` RPC) is the only legal clear — never a direct
 * DELETE. `ts` / `created_at` are lifted from the event PAYLOAD (not `event.ts`,
 * not `Date.now()`) so the fold is re-fold-deterministic.
 */
const CREATE_DISPATCH_FAILURES = `
CREATE TABLE IF NOT EXISTS dispatch_failures (
    verb TEXT NOT NULL,
    id TEXT NOT NULL,
    reason TEXT NOT NULL,
    dir TEXT,
    ts REAL NOT NULL,
    last_event_id INTEGER NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (verb, id)
)
`;

/**
 * `pending_dispatches` projection table — launch-window double-dispatch
 * suppression. The reconciler mints a synthetic `Dispatched{verb,id,dir}` BEFORE
 * `ExecBackend.launch()` (a crash between mint and launch leaves a phantom row
 * that TTL'd-clears, preferable to double-dispatch); the reducer UPSERTs keyed
 * on `(verb, id)`. Discharged by SessionStart bind, `DispatchFailed`, or
 * `DispatchExpired`. Row PRESENCE is the signal — no status column. A reducer
 * projection (re-fold reset DELETE list). `dispatched_at` is lifted from the
 * event PAYLOAD (not `event.ts`/`Date.now()`); the TTL sweep compares it against
 * `Date.now()` IN MAIN, never in the fold.
 */
const CREATE_PENDING_DISPATCHES = `
CREATE TABLE IF NOT EXISTS pending_dispatches (
    verb TEXT NOT NULL,
    id TEXT NOT NULL,
    dir TEXT,
    dispatched_at REAL NOT NULL,
    last_event_id INTEGER NOT NULL,
    PRIMARY KEY (verb, id)
)
`;

/**
 * `epic_tombstones` projection table — a permanent "this epic was deleted"
 * record minted by `EpicDeleted` and cleared by a re-creating `EpicSnapshot`.
 * Every epic-shell-INSERT site consults it and skips the resurrection when a
 * tombstone is active, preventing the headerless scalar-NULL ghost row a later
 * job-side shell-INSERT would otherwise recreate. The full-scalar `EpicSnapshot`
 * INSERT is the CLEAR site, not a shell site. `deleted_at_event_id` is an
 * event-id, not wallclock, for re-fold determinism. Mint is ON CONFLICT DO
 * NOTHING (preserve first-observed); clear sits OUTSIDE the scalar carve-out so
 * it fires on every re-create deterministically. A reducer projection (re-fold
 * reset DELETE list).
 *
 * No GC: never drop a tombstone while the append-only log can still replay
 * events referencing that id — a re-fold without it would replay the
 * resurrection.
 */
const CREATE_EPIC_TOMBSTONES = `
CREATE TABLE IF NOT EXISTS epic_tombstones (
    epic_id TEXT PRIMARY KEY,
    deleted_at_event_id INTEGER NOT NULL
)
`;

/**
 * `event_blobs` cold-blob relocation side table. The compaction pass MOVEs a
 * cold/discharged event's blob here and NULLs `events.data` — the `events` row
 * is never deleted, only the blob's LOCATION moves. Reads resolve via
 * `COALESCE(events.data, event_blobs.data)` so a relocated blob folds
 * byte-identically. `event_id` is a 1:1 FK to `events(id)`. NOT a reducer
 * projection — a content-preserving sidecar of the immutable log, NOT in the
 * rewind-and-redrain DELETE list.
 */
const CREATE_EVENT_BLOBS = `
CREATE TABLE IF NOT EXISTS event_blobs (
    event_id INTEGER PRIMARY KEY REFERENCES events(id),
    data TEXT NOT NULL
)
`;

/**
 * Expression index mirroring `idx_events_tool_attr` onto the relocation side
 * table, so `findExplicitAttributions`'s cold-blob arm SEEKs instead of
 * full-scanning the side table per dirty file. Pure perf — no SCHEMA_VERSION
 * bump. The `CASE WHEN json_valid(data)` guard is load-bearing: a bare
 * `json_extract` THROWS on a malformed blob at build/query time, and the reducer
 * tolerates malformed `data`, so the guard yields NULL instead — the consumer
 * query MUST probe with the identical guarded expression to match this index.
 */
const CREATE_EVENT_BLOBS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_event_blobs_tool_attr ON event_blobs(CASE WHEN json_valid(data) THEN json_extract(data, '$.tool_input.file_path') END)",
];

/**
 * `autopilot_state` SINGLETON projection (`CHECK (id = 1)`) carrying the
 * autopilot pause flag + concurrency cap + mode as durable, viewer-readable
 * state. A reducer projection (re-fold reset DELETE list). The `CHECK (id = 1)`
 * makes a stray non-singleton write fail loudly instead of letting the viewer
 * read whichever row sorts first. `created_at` is preserved on UPSERT and
 * sourced from `event.ts` for re-fold determinism. `max_concurrent_jobs` is
 * frozen from config at boot-append mint time (read on main, never in the fold);
 * `foldAutopilotPaused` / `foldAutopilotCapSet` each preserve the other's column
 * on conflict so a toggle never clobbers the cap. No migration seed row: the
 * unconditional boot-append `AutopilotPaused{paused:true}` folds the row before
 * any viewer reads it, keeping `created_at` purely event-log-derived.
 */
const CREATE_AUTOPILOT_STATE = `
CREATE TABLE IF NOT EXISTS autopilot_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    paused INTEGER NOT NULL,
    last_event_id INTEGER NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    max_concurrent_jobs INTEGER,
    mode TEXT NOT NULL DEFAULT 'yolo'
)
`;

/**
 * `armed_epics` PRESENCE table — per-epic "armed" flag for autopilot `armed`
 * mode. Row PRESENCE means armed. Written by the `EpicArmed` fold (`armed:true`
 * INSERTs, `armed:false` DELETEs) AND pruned by the `EpicSnapshot` fold when an
 * epic folds to `status='done'`. A reducer projection (re-fold reset DELETE
 * list); starts empty on a fresh DB.
 */
const CREATE_ARMED_EPICS = `
CREATE TABLE IF NOT EXISTS armed_epics (
    epic_id TEXT PRIMARY KEY,
    last_event_id INTEGER NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
)
`;

/**
 * `event_ingest_offsets` — the NDJSON→events ingest cursor, one row per per-pid
 * `<pid>.ndjson` file. The offset advance commits in the SAME `BEGIN IMMEDIATE`
 * as the `events` INSERT — that atomic pairing is exactly-once across watcher
 * re-fires and daemon restarts. NOT a reducer projection (never folded, excluded
 * from the re-fold reset DELETE list); a daemon-side cursor UPSTREAM of the fold,
 * distinct from `reducer_state.last_event_id`. Keyed on `(path, inode)` because
 * APFS recycles inodes and pids reuse filenames; the size-vs-offset check in
 * `scanEventsLogDir` falls the offset to 0 on a truncate/replace. The offset
 * advances only past the last COMPLETE parseable line (strict torn-tail).
 */
const CREATE_EVENT_INGEST_OFFSETS = `
CREATE TABLE IF NOT EXISTS event_ingest_offsets (
    path TEXT NOT NULL,
    inode INTEGER NOT NULL,
    offset INTEGER NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (path, inode)
)
`;

/**
 * `file_attributions` projection — one row per `(project_dir, session_id,
 * file_path)` triple recording an un-discharged mutation claim. A reducer
 * projection (re-fold deterministic). The discharge rule lives in the column
 * shape: a session is attributed iff `last_commit_at IS NULL OR last_commit_at <
 * last_mutation_at`; the row stays for the historical record and the readiness
 * pass filters by the inequality. The three-axis PK makes multi-attribution per
 * file (different worktrees / different sessions) distinct rows by design.
 *
 * `worktree_oid` / `worktree_mode` are the filter-correct git blob oid + mode of
 * the WORKTREE bytes, frozen into the event payload (no fold-time git probe) so
 * a re-fold is deterministic. A NULL on either (pre-feature row or a producer
 * hash/observe failure) falls back to timestamp discharge in `foldCommit`. The
 * mode pairs with the oid so a chmod-only dirty file isn't wrongly discharged.
 */
const CREATE_FILE_ATTRIBUTIONS = `
CREATE TABLE IF NOT EXISTS file_attributions (
    project_dir TEXT NOT NULL,
    session_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    last_mutation_at REAL NOT NULL,
    last_commit_at REAL,
    op TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('tool','bash','inferred','planctl')),
    last_event_id INTEGER,
    updated_at REAL NOT NULL DEFAULT 0,
    worktree_oid TEXT,
    worktree_mode TEXT,
    PRIMARY KEY (project_dir, session_id, file_path)
)
`;

/**
 * Indexes on `file_attributions`: `_file (project_dir, file_path)` serves the
 * per-file multi-attribution read; `_session (session_id)` serves the
 * per-session retraction walk on a `GitRootDropped`.
 */
const CREATE_FILE_ATTRIBUTIONS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_file_attributions_file ON file_attributions(project_dir, file_path)",
  "CREATE INDEX IF NOT EXISTS idx_file_attributions_session ON file_attributions(session_id)",
];

/**
 * Index on the `bash_mutation_kind` column added by the v30→v31 ALTER (KEPT OUT
 * of the unconditional CREATE block; see {@link CREATE_V10_INDEXES}). Covering
 * for the reducer's bash-attribution scan; the `IS NOT NULL` partial still
 * serves the equality/`IN` probes.
 */
const CREATE_V31_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_bash_attr ON events(bash_mutation_kind, bash_mutation_targets, ts, session_id) WHERE bash_mutation_kind IS NOT NULL",
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
 * Prepared statements pre-bound on the hot paths. Keep these tiny — the hook's
 * cold-start latency is part of the SessionEnd timeout budget.
 */
export interface Stmts {
  insertEvent: ReturnType<Database["prepare"]>;
  selectWorldRev: ReturnType<Database["prepare"]>;
}

export interface OpenDbOptions {
  readonly?: boolean;
  /**
   * Run `migrate(db)` after opening. Defaults `true` for writers; readers always
   * skip. The hook passes `false` — the daemon is the SOLE migrator.
   */
  migrate?: boolean;
  /**
   * Connection-local `busy_timeout` in ms. Set FIRST in {@link applyPragmas} so
   * the WAL switch waits instead of failing under contention. The hook passes a
   * tighter value to stay inside its SessionEnd budget.
   */
  busyTimeoutMs?: number;
  /**
   * Per-connection page-cache cap in KB (negative `PRAGMA cache_size`). The
   * daemon passes a large value to retain hot pages across folds; omit on the
   * short-lived hook.
   */
  cacheSizeKb?: number;
  /**
   * Build the {@link Stmts} bundle. Defaults `true`. The hook passes `false`
   * because the static `insertEvent` names every events column, which throws on
   * a schema-skewed live DB before the daemon migrates; the hook builds a
   * column-adaptive INSERT instead.
   */
  prepareStmts?: boolean;
}

export interface KeeperDb {
  db: Database;
  stmts: Stmts;
}

/**
 * Apply connection-local PRAGMAs. Called on every open (writer + reader). WAL +
 * `synchronous = NORMAL` is the only safe mode for the hook+daemon pattern;
 * `foreign_keys = ON` because bun:sqlite does not auto-enable. `busy_timeout`
 * MUST be re-set per connection (the hook re-spawns each invocation).
 */
export function applyPragmas(
  db: Database,
  busyTimeoutMs = 5000,
  cacheSizeKb?: number,
): void {
  // busy_timeout FIRST — the WAL switch below needs a brief write lock and
  // would fail INSTANTLY with SQLITE_BUSY under any concurrent writer at the
  // SQLite default of 0.
  db.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA temp_store = MEMORY");
  // mmap serves resident pages from the OS page cache (removes read() syscall
  // overhead, not the first cold read), so it pairs with cache_size below.
  db.run("PRAGMA mmap_size = 4294967296");
  // Large per-connection page cache (negative = KB cap). Only the daemon passes
  // this so it retains hot pages across folds; the hook keeps the small default.
  if (cacheSizeKb != null && cacheSizeKb > 0) {
    db.run(`PRAGMA cache_size = -${cacheSizeKb}`);
  }
}

/**
 * Add a column only if absent. The migrate block runs every boot and a fresh
 * DB's CREATE TABLE already defines new columns, so a `PRAGMA table_info` check
 * makes the ALTER an idempotent no-op when the column exists.
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
 * {@link addColumnIfMissing} for a GENERATED ALWAYS column. The presence check
 * MUST read `PRAGMA table_xinfo` (not `table_info`, which excludes generated
 * columns) or the ALTER re-fires every boot and throws "duplicate column".
 * SQLite allows only `VIRTUAL` via ALTER, so `columnDef` must carry the
 * `GENERATED ALWAYS AS (...) VIRTUAL` clause.
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
 * Drop a column only if present — the idempotent mirror of
 * {@link addColumnIfMissing} (no-ops once the column is gone).
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
 * Rename a column only if the OLD name is present AND the NEW name is not.
 * Quad-state idempotent: old-present/new-absent runs the ALTER; every other
 * combination no-ops — including old-present/new-present, which is the fresh-DB
 * lockstep case (the CREATE_TABLE literal already carries both names).
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
    return;
  }
  if (hasNew) {
    return; // fresh-DB lockstep: CREATE_TABLE literal already carries both
  }
  db.run(`ALTER TABLE ${table} RENAME COLUMN ${oldName} TO ${newName}`);
}

/**
 * Chunked backfill for `resolved_epic_deps` + `epic_dep_edges` on existing
 * `epics` rows, run OUTSIDE the main migrate transaction so the WAL writer lock
 * is released between chunks (concurrent hook INSERTs never starve). Idempotent
 * (the resolver is a pure function of the live `epics` table) and version-guarded
 * to fire only on the upgrade boot. Produces the SAME projection a from-scratch
 * re-fold would: the resolver's `now` is each epic's persisted `updated_at`
 * (never `Date.now()`/env), and only affects a diagnostic ts that isn't written.
 */
const BACKFILL_CHUNK_SIZE = 200;

function backfillResolvedEpicDeps(db: Database): void {
  // LIMIT/OFFSET pagination is stable: the backfill writes only columns outside
  // the ORDER BY and never inserts/deletes epics rows.
  const epicIdsRow = db
    .prepare("SELECT epic_id FROM epics ORDER BY epic_id ASC")
    .all() as { epic_id: string }[];
  if (epicIdsRow.length === 0) {
    return;
  }
  const allEpicIds = epicIdsRow.map((r) => r.epic_id);

  // Build the all-epics index ONCE: the resolver-relevant columns are stable
  // across the backfill (the chunked UPDATEs touch only columns the resolver
  // doesn't read). Re-implemented inline (not the reducer's `buildEpicIndex`) so
  // db.ts stays cycle-free, but field-for-field identical so a re-fold matches.
  type BackfillEpicRow = {
    epic_id: string;
    epic_number: number | null;
    project_dir: string | null;
    status: string | null;
    depends_on_epics: string | null;
    updated_at: number;
  };
  const indexRows = db
    .prepare(
      `SELECT epic_id, epic_number, project_dir, status
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

  let offset = 0;
  while (offset < allEpicIds.length) {
    const slice = allEpicIds.slice(offset, offset + BACKFILL_CHUNK_SIZE);
    db.transaction(() => {
      const placeholders = slice.map(() => "?").join(",");
      const chunkRows = db
        .prepare(
          `SELECT epic_id, epic_number, project_dir, status,
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
            // malformed → empty deps
          }
        }

        // Wipe + insert this consumer's edges. Idempotent — depTokens is a pure
        // function of `depends_on_epics`.
        db.prepare("DELETE FROM epic_dep_edges WHERE consumer_id = ?").run(
          row.epic_id,
        );
        const insertEdge = db.prepare(
          "INSERT OR IGNORE INTO epic_dep_edges (consumer_id, dep_token) VALUES (?, ?)",
        );
        for (const tok of depTokens) {
          insertEdge.run(row.epic_id, tok);
        }

        // `now` is the row's persisted `updated_at` (epoch fallback), not
        // `Date.now()` — it only affects the dropped diagnostic ts.
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

        // Preserve the row's existing `last_event_id` + `updated_at` — the
        // backfill is NOT a fold and must stay invisible to the wire diff.
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
 * Run schema bootstrap + forward-only ALTER block. Writer-only, wrapped in a
 * single transaction so a half-applied schema can never persist across a crash.
 * Post-commit, a chunked backfill runs OUTSIDE the transaction (see
 * {@link backfillResolvedEpicDeps}) to avoid a mega-transaction WAL lock.
 */
function migrate(db: Database): void {
  // Pre-read storedVersion BEFORE the transaction so the post-commit backfill
  // can branch on whether this is the upgrade boot. A fresh DB has no `meta`
  // table, so probe `sqlite_master` first and read a missing table as version 0.
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

  // Runtime downgrade guard: refuse to run an old binary against a DB a newer
  // keeperd already migrated. Thrown BEFORE the transaction so no version-guarded
  // ALTER runs against a newer schema and the unconditional meta stamp can't
  // regress it. Strictly-greater so a fresh (v0) or same-version DB passes. The
  // uncaught throw + LaunchAgent restart loop until the newer binary deploys is
  // INTENDED — no fatalExit wrapper, no read-only fallback.
  if (preMigrateStoredVersion > SCHEMA_VERSION) {
    throw new Error(
      `DB schema v${preMigrateStoredVersion} is newer than this binary's v${SCHEMA_VERSION} — deploy the newer keeperd (or restore the matching binary); refusing to run rather than silently downgrade`,
    );
  }

  // Decide BEFORE the transaction whether the v57→v58 `events.data` rebuild runs,
  // so `PRAGMA foreign_keys` can be toggled AROUND it: the rebuild DROPs the
  // FK-referenced `events` table (needs FK enforcement OFF), and the PRAGMA is a
  // no-op inside a transaction. Shape-driven (live `events.data` actually NOT
  // NULL) so a fresh/already-migrated DB skips it.
  const eventsTableExists =
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'",
      )
      .get() != null;
  const needsEventsRebuild =
    eventsTableExists &&
    (
      db.prepare("PRAGMA table_info('events')").all() as {
        name: string;
        notnull: number;
      }[]
    ).find((c) => c.name === "data")?.notnull === 1;
  // FK enforcement OFF only for the rebuild's DROP; restored in `finally` so a
  // mid-migrate throw never leaves it disabled.
  if (needsEventsRebuild) {
    db.run("PRAGMA foreign_keys = OFF");
  }
  try {
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
      db.run(CREATE_DISPATCH_FAILURES);
      db.run(CREATE_AUTOPILOT_STATE);
      db.run(CREATE_ARMED_EPICS);
      db.run(CREATE_EVENT_INGEST_OFFSETS);
      db.run(CREATE_PENDING_DISPATCHES);
      db.run(CREATE_EPIC_TOMBSTONES);
      db.run(CREATE_EVENT_BLOBS);
      for (const sql of CREATE_EVENT_BLOBS_INDEXES) {
        db.run(sql);
      }

      // Seed singleton cursor on first boot.
      db.run(
        "INSERT OR IGNORE INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 0, unixepoch('now', 'subsec'))",
      );

      // Forward-only schema changes run on EVERY boot, NOT gated on the stored
      // schema_version: each idempotent step converges on the table's actual
      // shape, so a version stamped ahead of the real schema can't skip its ALTERs
      // forever. Non-idempotent steps (data backfills, destructive changes) need a
      // LOCAL version guard.
      addColumnIfMissing(db, "jobs", "title", "TEXT");

      dropColumnIfPresent(db, "jobs", "mode");
      dropColumnIfPresent(db, "jobs", "title_history");

      addColumnIfMissing(db, "events", "spawn_name", "TEXT");
      addColumnIfMissing(db, "jobs", "title_source", "TEXT");

      addColumnIfMissing(db, "jobs", "transcript_path", "TEXT");

      // v6→v7: collapse the standalone `tasks` table into an embedded JSON-array
      // column on `epics`. The backfill + DROP are non-idempotent, so VERSION-
      // GUARDED below; the `tasks` column add is idempotent. The backfill's array
      // ordering MUST equal the reducer's fold sort (ORDER BY task_number,
      // task_id) or a migrated row diverges from a re-folded one.
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

      addColumnIfMissing(
        db,
        "epics",
        "depends_on_epics",
        "TEXT NOT NULL DEFAULT '[]'",
      );

      addColumnIfMissing(db, "events", "start_time", "TEXT");
      addColumnIfMissing(db, "jobs", "start_time", "TEXT");

      // v9→v10: slash-command / skill-name / spawn-name verb-ref columns +
      // partial indexes + a same-transaction backfill via the SAME pure derivers
      // the hook + reducer use, so migrated rows byte-match steady-state ones.
      addColumnIfMissing(db, "events", "slash_command", "TEXT");
      addColumnIfMissing(db, "events", "skill_name", "TEXT");
      addColumnIfMissing(db, "jobs", "plan_verb", "TEXT");
      addColumnIfMissing(db, "jobs", "plan_ref", "TEXT");

      // Indexes AFTER the ADD COLUMNs they depend on.
      for (const sql of CREATE_V10_INDEXES) {
        db.run(sql);
      }

      // JS-driven backfill (the derivers aren't expressible in SQL without
      // REGEXP); a throw rolls the whole migration back. Version-guarded
      // non-idempotent — runs at most once.
      const storedVersionV10 = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV10 < 10) {
        // Backfill writes MUST use uncached `db.run(sql, params)`, NOT
        // `db.prepare(...).run()`: a statement compiled in the same transaction
        // as the ALTER it depends on can pin the pre-ALTER schema metadata
        // (bun:sqlite #1332). Blobs are parsed defensively — a malformed blob
        // would wedge the migration on throw.
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

        // Per job, derive plan_verb/plan_ref from its EARLIEST SessionStart's
        // spawn_name (matches the reducer's first-sight upsert).
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

      // v10→v11: embed jobs into the `epics` projection via the `syncJobIntoEpic`
      // fan-out.
      addColumnIfMissing(db, "epics", "jobs", "TEXT NOT NULL DEFAULT '[]'");

      // Version-guarded REWIND-AND-REDRAIN: rewind the cursor + clear jobs/epics
      // so the boot drain rebuilds the embedded arrays through the v11 reducer
      // (the single source of truth). Non-idempotent — runs at most once.
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

      // v12→v13: add `epics.approval` and drop the v12 `approvals` table.
      // VERSION-GUARDED on `preMigrateStoredVersion < 63` (NOT `< 13`): v62→v63
      // drops `approval` again under a `< 63` guard, so an unguarded
      // presence-idempotent re-add would resurrect it forever on a post-v63 DB.
      // The `< 63` bound (not `< 13`) is load-bearing: the v55→v56
      // `default_visible` rewrite references `approval`, so it must be present
      // for any pre-v63 upgrade passing through v56.
      if (preMigrateStoredVersion < 63) {
        addColumnIfMissing(
          db,
          "epics",
          "approval",
          "TEXT NOT NULL DEFAULT 'pending'",
        );
      }

      db.run("DROP TABLE IF EXISTS approvals");

      // v13→v14: planctl_* event columns + `epic_links`/`job_links` projection
      // columns + partial index + a same-transaction backfill via the SAME pure
      // classifier the live reducer fan-out uses.
      addColumnIfMissing(db, "events", "planctl_op", "TEXT");
      addColumnIfMissing(db, "events", "planctl_target", "TEXT");
      addColumnIfMissing(db, "events", "planctl_epic_id", "TEXT");
      addColumnIfMissing(db, "events", "planctl_task_id", "TEXT");
      addColumnIfMissing(db, "events", "planctl_subject_present", "INTEGER");
      addColumnIfMissing(
        db,
        "jobs",
        "epic_links",
        "TEXT NOT NULL DEFAULT '[]'",
      );
      addColumnIfMissing(
        db,
        "epics",
        "job_links",
        "TEXT NOT NULL DEFAULT '[]'",
      );

      // Index AFTER the ADD COLUMNs it depends on.
      for (const sql of CREATE_V14_INDEXES) {
        db.run(sql);
      }

      // JS-driven backfill (uncached `db.run`; a throw rolls back). Version-
      // guarded non-idempotent — the projection re-derive must run at most once.
      const storedVersionV14 = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV14 < 14) {
        // Pass 1 — stamp planctl_* on un-backfilled PreToolUse:Bash events. The
        // live deriver now gates on PostToolUse:Bash (v19→v20), so this stamps
        // zero rows on a fresh chain run; kept because removing it would break
        // the version-guarded re-fold contract on already-migrated v14+ DBs.
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

        // Pass 2 — per-session projection re-derive, byte-identical to the live
        // `syncPlanctlLinks` fan-out (both feed the same pure classifier).
        const sessionRows = db
          .prepare(
            `SELECT DISTINCT session_id
             FROM events
            WHERE planctl_op IS NOT NULL`,
          )
          .all() as { session_id: string }[];

        const invocationsBySession = new Map<string, ClassifierInvocation[]>();
        const openerTimestampsBySession = new Map<string, number[]>();

        for (const { session_id } of sessionRows) {
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

          // Window-opener gate: PreToolUse:Skill AND skill_name='plan:plan' only
          // — slash-command UserPromptSubmit rows are NOT openers (they'd
          // double-fire on slash-typed invocations).
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

        const windowsBySession = new Map<string, PlanWindow[]>();
        const touchedEpicIds = new Set<string>();
        for (const session_id of invocationsBySession.keys()) {
          const opens = openerTimestampsBySession.get(session_id) ?? [];
          const windows = computePlanWindows(opens);
          windowsBySession.set(session_id, windows);
          const invocations = invocationsBySession.get(session_id) ?? [];
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
          // UPDATE only — never shell-insert a missing jobs row. The reducer
          // invariant is that jobs rows are created only by SessionStart.
          db.run(
            `UPDATE jobs SET epic_links = ?, last_event_id = ?, updated_at = ?
            WHERE job_id = ?`,
            [epicLinksJson, latest.id, latest.ts, session_id],
          );
          for (const link of epicLinks) {
            touchedEpicIds.add(link.target);
          }
        }

        // Pass 2b — write `epics.job_links` per touched epic; shell-insert the
        // epic row if missing so a from-scratch re-fold reproduces every row.
        for (const epicId of touchedEpicIds) {
          const jobLinks = deriveJobLinks(
            invocationsBySession,
            windowsBySession,
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
            // Shell-insert (no EpicSnapshot yet): scalars default to their
            // zero-event readings; a later EpicSnapshot fills them and its ON
            // CONFLICT carve-out preserves `job_links`.
            db.run(
              `INSERT INTO epics (
               epic_id, epic_number, title, project_dir, status,
               last_event_id, updated_at, tasks, jobs, job_links
             ) VALUES (?, NULL, NULL, NULL, NULL, ?, ?, '[]', '[]', ?)`,
              [epicId, stampId, stampTs, jobLinksJson],
            );
          }
        }

        db.run("ANALYZE events");
      }

      // v14→v15: comment-only no-op — `git_status` is created above, no ALTER
      // here, but the version stamp needs a slot per the CLAUDE.md "bump only
      // when adding an ALTER block" invariant.

      // v15→v16: project `last_validated_at`; the plan-worker's boot re-scan
      // repopulates it.
      addColumnIfMissing(db, "epics", "last_validated_at", "TEXT");

      // v16→v17: add `events.tool_use_id` + the `subagent_invocations` table +
      // its partial index + a same-transaction backfill.
      addColumnIfMissing(db, "events", "tool_use_id", "TEXT");

      for (const sql of CREATE_V17_INDEXES) {
        db.run(sql);
      }

      // Backfill `events.tool_use_id` via a pure-SQL `json_extract` (uncached
      // `db.run`; a throw rolls back). Version-guarded — the rewind below is
      // non-idempotent.
      const storedVersionV17 = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV17 < 17) {
        // `json_valid(data)` gates the extract — a bare `json_extract` raises
        // SQLITE_ERROR on a malformed historical blob and would wedge the
        // migration. The `tool_use_id IS NULL` filter keeps the UPDATE idempotent.
        db.run(
          `UPDATE events
            SET tool_use_id = json_extract(data, '$.tool_use_id')
          WHERE tool_use_id IS NULL
            AND json_valid(data) = 1
            AND json_extract(data, '$.tool_use_id') IS NOT NULL`,
        );

        db.run("ANALYZE events");

        // Rewind-and-redrain: the boot drain rebuilds the projections (incl. the
        // new `subagent_invocations`) from the event log. Non-idempotent.
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        db.run("DELETE FROM subagent_invocations");
      }

      // v17→v18: add `jobs.rate_limited_at`. The field also rides every embedded
      // `jobs` array entry, so a rewind-and-redrain is REQUIRED: without it,
      // incremental `syncJobIntoEpic` writes would re-serialize touched entries
      // WITH the field while neighbours in the same array stayed WITHOUT it,
      // breaking byte-identical re-fold.
      addColumnIfMissing(db, "jobs", "rate_limited_at", "REAL");

      // Version-guarded rewind-and-redrain — runs at most once.
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

      // v18→v19: rename the embedded `status` key to `worker_phase` + add the
      // `runtime_status` sibling. No schema column — the fields ride the embedded
      // JSON, so a rewind-and-redrain re-emits every element from the v19 reducer
      // (the reducer reads `worker_phase ?? status` so a pre-v19 blob still folds
      // deterministically). Version-guarded.
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

      // v19→v20: re-stamp the planctl_* columns from the authoritative
      // PostToolUse:Bash envelope, superseding the structurally-wrong v13→v14
      // PreToolUse:Bash stamps (that v14 block now no-ops). Pass 0 wipes the
      // wrong stamps, Pass 1 re-stamps, Pass 2 re-derives the projections.
      // Version-guarded; uncached `db.run`.
      const storedVersionV20 = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV20 < 20) {
        // Pass 0 — wipe the structurally-wrong PreToolUse:Bash stamps; the
        // reducer's `planctl_op != NULL` gate would otherwise fan out from
        // wrong-shaped data. Idempotent (IS NOT NULL no-ops after the first run).
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

        // Pass 1 — re-stamp from PostToolUse:Bash rows via the new deriver
        // (`planctl_op IS NULL` filter keeps it resume-safe).
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

        // Pass 2 — per-session projection re-derive, byte-identical to the live
        // `syncPlanctlLinks` fan-out (same pure classifier).
        const sessionRowsV20 = db
          .prepare(
            `SELECT DISTINCT session_id
             FROM events
            WHERE planctl_op IS NOT NULL`,
          )
          .all() as { session_id: string }[];

        const invocationsBySessionV20 = new Map<
          string,
          ClassifierInvocation[]
        >();
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

          // Window-opener gate: PreToolUse:Skill AND skill_name='plan:plan' only.
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
          // UPDATE only — jobs rows are created only by SessionStart.
          db.run(
            `UPDATE jobs SET epic_links = ?, last_event_id = ?, updated_at = ?
            WHERE job_id = ?`,
            [epicLinksJson, latest.id, latest.ts, session_id],
          );
          for (const link of epicLinks) {
            touchedEpicIdsV20.add(link.target);
          }
        }

        // Pass 2b — write `epics.job_links` per touched epic; shell-insert a
        // missing epic row (its later EpicSnapshot's ON CONFLICT carve-out
        // preserves `job_links`).
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

        db.run("ANALYZE events");
      }

      // v20→v21: enrich `epics.job_links` entries with `{title, state,
      // rate_limited_at}`. No ALTER (TYPE unchanged); a version-guarded re-derive
      // using the SAME `enrichJobLink`/`sortJobLinks` shape as the live reducer
      // so the result is byte-identical to a from-scratch re-fold. A missing jobs
      // row enriches to `{title:null, state:"stopped", rate_limited_at:null}`.
      const storedVersionV21 = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV21 < 21) {
        const epicRowsV21 = db
          .prepare("SELECT epic_id, job_links FROM epics")
          .all() as { epic_id: string; job_links: string | null }[];
        for (const row of epicRowsV21) {
          // Safe parse — a malformed blob folds to []. NEVER throw inside
          // migrate() (rolls back the BEGIN IMMEDIATE and wedges the upgrade).
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
              // Orphan entry — retain with safe defaults for re-fold determinism.
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
          // Total-order ASC sort on (kind, job_id), mirroring `sortJobLinks` —
          // re-applied so a mis-sorted blob can't diverge from a re-fold.
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

      // v21→v22: add `events.config_dir` (`CLAUDE_CONFIG_DIR` scraped at
      // SessionStart) + `jobs.config_dir` (its projection).
      addColumnIfMissing(db, "events", "config_dir", "TEXT");
      addColumnIfMissing(db, "jobs", "config_dir", "TEXT");

      // v22→v23: comment-only no-op — `usage` is created above; the version stamp
      // needs a slot per the CLAUDE.md "bump only when adding an ALTER" invariant.
      // NO freshness columns: the worker read-and-discards the envelope's
      // `fetched_at` etc., so adding one here would churn every ~90s.

      // v23→v24: replace `jobs.rate_limited_at` with the
      // `last_api_error_at`/`last_api_error_kind` pair. The fields also ride the
      // embedded `jobs`/`job_links` arrays, so a rewind-and-redrain is REQUIRED
      // to harmonize every entry (legacy `RateLimited` events fold to
      // `kind="rate_limit"`). The dual-case `RateLimited | ApiError` fold keeps
      // the historical log re-fold deterministic.
      addColumnIfMissing(db, "jobs", "last_api_error_at", "REAL");
      addColumnIfMissing(db, "jobs", "last_api_error_kind", "TEXT");

      dropColumnIfPresent(db, "jobs", "rate_limited_at");

      // Version-guarded rewind-and-redrain.
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

      // v24→v25: add the `last_input_request_at`/`last_input_request_kind` pair
      // (session blocked on AskUserQuestion). The fields ride the embedded
      // arrays, so a rewind-and-redrain is REQUIRED to harmonize every entry.
      addColumnIfMissing(db, "jobs", "last_input_request_at", "REAL");
      addColumnIfMissing(db, "jobs", "last_input_request_kind", "TEXT");

      // Version-guarded rewind-and-redrain.
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

      // v26: widen the spawn-name regex to accept the `approve` verb. The regex
      // change is data-incompatible (old `approve::...` rows left `plan_verb`
      // NULL), so rewind + redrain re-folds them under the widened regex.
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

      // v26→v27: add the `usage` `sonnet_week` percent/resets pair. No rewind —
      // pre-feature events re-fold to NULL (the zero-event reading).
      addColumnIfMissing(db, "usage", "sonnet_week_percent", "REAL");
      addColumnIfMissing(db, "usage", "sonnet_week_resets_at", "TEXT");

      // v27→v28: denormalize `git_dirty_count`/`git_orphan_count` onto `jobs`
      // (fanned out by `projectGitStatus` + `syncJobIntoEpic`, also onto the
      // embedded arrays).
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

      // NO rewind: pre-v28 rows read 0/0 until the next GitSnapshot re-snapshots
      // (sub-second); from-scratch re-fold re-derives the counts anyway.

      // v28→v29: add `epics.created_by_closer_of` + `sort_path`. `sort_path` is a
      // zero-padded-6 dotted key like `"000003.000007"` — the dot (ASCII 46) is
      // strictly below the digits (48-57), so the prefix-sort invariant
      // `"000003" < "000003.000007" < "000004"` holds under BINARY collation.
      addColumnIfMissing(db, "epics", "created_by_closer_of", "TEXT");
      addColumnIfMissing(db, "epics", "sort_path", "TEXT NOT NULL DEFAULT ''");

      // Version-guarded rewind-and-redrain (both columns derive from the log via
      // `syncPlanctlLinks`).
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

      // v29→v30: add `events.planctl_queue_jump` (the `/plan:queue` signal) +
      // `epics.queue_jump`. `queue_jump` drives the `!`-prefix `sort_path` branch
      // for root epics — `"!"` (ASCII 33) sorts strictly below the digits (48-57)
      // under BINARY collation, lifting queued roots above non-queued ones.
      addColumnIfMissing(db, "events", "planctl_queue_jump", "INTEGER");
      addColumnIfMissing(
        db,
        "epics",
        "queue_jump",
        "INTEGER NOT NULL DEFAULT 0",
      );

      // Version-guarded rewind-and-redrain (both columns derive from the log).
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

      // v30→v31: per-(session, file) git attribution. Adds the
      // `bash_mutation_kind`/`bash_mutation_targets` event columns + partial
      // index, renames `jobs.git_orphan_count` → `git_unattributed_to_live_count`
      // and adds a fresh `git_orphan_count`, and creates `file_attributions`.
      //
      // Defensive SQLite version check (RENAME COLUMN needs 3.25+), run
      // unconditionally — never-throw-inside-migrate makes a half-applied schema
      // the worse outcome.
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

      addColumnIfMissing(db, "events", "bash_mutation_kind", "TEXT");
      addColumnIfMissing(db, "events", "bash_mutation_targets", "TEXT");

      // The rename MUST run BEFORE the fresh `git_orphan_count` add: adding first
      // against a legacy-named column would no-op the add and then drift-fail the
      // rename (`hasOld && hasNew`).
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

      // Partial index AFTER the column it depends on.
      for (const sql of CREATE_V31_INDEXES) {
        db.run(sql);
      }

      // Same-transaction backfill of the new sparse columns via the SAME pure
      // deriver the hook uses, so historical rows and future writes converge.
      // The bash-attribution fold reads the BACKFILLED `events` rows (not the
      // live deriver), so the events table MUST carry the columns before the boot
      // drain. Version-guarded.
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
          // Defensive parse — a malformed blob folds to NULL; never throw.
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
          updateStmt.run(
            mutation.kind,
            JSON.stringify(mutation.targets),
            row.id,
          );
        }
      }

      // Version-guarded rewind-and-redrain: the new `git_orphan_count` and
      // `file_attributions` rows are computed by the new fold, so wipe + re-fold.
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

      // v31→v32: `epics.default_visible` VIRTUAL generated column materializing
      // the board's default-visibility predicate as a single-column 0/1 a partial
      // index can serve. The CASE-wrap is load-bearing: bare
      // `(status='open' OR approval!='approved')` returns NULL when status IS NULL
      // — violating the column's NOT NULL constraint at scan time. Uses
      // `addGeneratedColumnIfMissing` (reads `table_xinfo`; `table_info` excludes
      // generated columns and would re-fire the ALTER every boot). This literal
      // matches the v55→v56 rewrite so a v31→v56 jump lands it on the first add.
      addGeneratedColumnIfMissing(
        db,
        "epics",
        "default_visible",
        "INTEGER NOT NULL GENERATED ALWAYS AS (CASE WHEN status IS NOT NULL AND (status='open' OR approval!='approved') THEN 1 ELSE 0 END) VIRTUAL",
      );

      // Always-run indexes on epics/jobs/events, placed AFTER the columns they
      // index. `analysis_limit = 400` caps the per-index ANALYZE sample so it
      // stays bounded on a large `events` table (connection-scoped; writes
      // sqlite_stat1 only — re-fold safe).
      db.run("PRAGMA analysis_limit = 400");
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

      // v32→v33: comment-only no-op — `profiles` is created above and populates
      // organically from the event log; the version stamp needs a slot.

      // v33→v34: add `epics.resolved_epic_deps` + the `epic_dep_edges` table. The
      // column's NULL ("not-yet-computed") is load-bearing — DISTINCT from `'[]'`
      // ("computed, no deps"); `decodeRow` returns null (not []) so clients can
      // tell "still converging" from "empty by design".
      addColumnIfMissing(db, "epics", "resolved_epic_deps", "TEXT");

      // v34→v35: colocate rate-limit state into `usage` + add
      // `profiles.profile_name` (the `projectBasename(config_dir)` join key).
      addColumnIfMissing(db, "usage", "last_rate_limit_at", "REAL");
      addColumnIfMissing(db, "usage", "last_rate_limit_session_id", "TEXT");
      addColumnIfMissing(db, "profiles", "profile_name", "TEXT");
      if (preMigrateStoredVersion < 35) {
        // Version-guarded backfill of `profile_name` via the SAME
        // `projectBasename` the SessionStart seed uses, so a re-fold converges.
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

      // v35→v36: add `jobs.profile_name` (`projectBasename(config_dir)`).
      // Tracks `config_dir`'s OWN nullability (NULL → NULL, not the `''`-collapse
      // the `profiles` seed uses) so the resume COALESCE precedence stays honest.
      addColumnIfMissing(db, "jobs", "profile_name", "TEXT");
      if (preMigrateStoredVersion < 36) {
        // Version-guarded backfill via the SAME `projectBasename` the fold uses
        // (NULL config_dir → NULL), so a re-fold converges.
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

      // v36→v37: comment-only no-op — `dead_letters` is created above and
      // populates only from the daemon's import scan; the version stamp needs a
      // slot. NOT a reducer projection: the re-fold reset path MUST NOT touch it
      // (it records events that never made it into the log).

      // v37→v38: project the agentuse envelope's status/subscription/error axes
      // onto `usage`. `error_at` is projected but EXCLUDED from the worker
      // change-gate (it advances on every failed scrape, ~90s).
      addColumnIfMissing(db, "usage", "status", "TEXT");
      addColumnIfMissing(db, "usage", "subscription_active", "INTEGER");
      addColumnIfMissing(db, "usage", "error_type", "TEXT");
      addColumnIfMissing(db, "usage", "error_message", "TEXT");
      addColumnIfMissing(db, "usage", "error_at", "TEXT");

      // v38→v39: re-backfill `bash_mutation_*` via the shared deriver (its OUTPUT
      // changed — `git-rm`/`git-mv`, redirect-token fix) then rewind + redrain so
      // healed attributions re-fold deterministically. No schema-shape change.
      const storedVersionV39Backfill = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV39Backfill < 39) {
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
          // Defensive parse — a malformed blob folds to NULL; never throw.
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
          updateStmt.run(
            mutation.kind,
            JSON.stringify(mutation.targets),
            row.id,
          );
        }
      }

      // Version-guarded rewind: the boot drain rebuilds the projections under the
      // new reducer logic.
      const storedVersionV39Rewind = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV39Rewind < 39) {
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        db.run("DELETE FROM git_status");
        db.run("DELETE FROM file_attributions");
        db.run("DELETE FROM subagent_invocations");
      }

      // v39→v40: add `jobs.name_history` (distinct titles, oldest→newest, capped
      // at 20). A pure function of the persisted cell + incoming title (no
      // `Date.now`, no arrival ordering) so a re-fold is deterministic.
      addColumnIfMissing(
        db,
        "jobs",
        "name_history",
        "TEXT NOT NULL DEFAULT '[]'",
      );
      if (preMigrateStoredVersion < 40) {
        // Version-guarded backfill: seed `["<title>"]` / `[]`.
        const rows = db.prepare("SELECT job_id, title FROM jobs").all() as {
          job_id: string;
          title: string | null;
        }[];
        const updateStmt = db.prepare(
          "UPDATE jobs SET name_history = ? WHERE job_id = ?",
        );
        for (const row of rows) {
          const seed = row.title != null ? JSON.stringify([row.title]) : "[]";
          updateStmt.run(seed, row.job_id);
        }
      }

      // v40→v41: add `usage.rate_limit_lifts_at` + `last_usage_fold_at`.
      // `last_usage_fold_at` is the event `ts` of the last SUCCESSFUL usage fold
      // (never an idle/stale or rate-limit fold) — sourced from `ts`, never
      // `Date.now()`, for re-fold determinism. Both are carved out of the
      // rate-limit fan-out's UPDATE (the percentage path owns them).
      addColumnIfMissing(db, "usage", "rate_limit_lifts_at", "TEXT");
      addColumnIfMissing(db, "usage", "last_usage_fold_at", "REAL");

      // Covering indexes for the inferred-attribution window self-join, created
      // HERE (after the v16→v17 `tool_use_id` add) so a pre-v17 migrating DB
      // doesn't fail "no such column". Covering keeps the join off the 64k full
      // bash-event rows (cache-independent). Idempotent — no SCHEMA_VERSION bump.
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_events_bashwin_pre ON events(hook_event, tool_name, ts, tool_use_id, session_id)",
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_events_bashwin_post ON events(tool_use_id, hook_event, tool_name, ts, cwd, session_id) WHERE tool_use_id IS NOT NULL",
      );

      // Retire the pre-covering attribution indexes now that idx_events_tool_attr
      // / idx_events_bash_attr cover their scans. Ordered AFTER those CREATEs so
      // an existing DB sheds the uncovered key. Idempotent — no SCHEMA_VERSION bump.
      db.run("DROP INDEX IF EXISTS idx_events_tool_file_path");
      db.run("DROP INDEX IF EXISTS idx_events_bash_mutation_kind");

      // Shed three consumer-less/dead events indexes from already-migrated DBs
      // (the CREATEs were removed from CREATE_EVENTS_INDEXES). Idempotent — no bump.
      db.run("DROP INDEX IF EXISTS idx_events_event_type");
      db.run("DROP INDEX IF EXISTS idx_events_tool_name");
      db.run("DROP INDEX IF EXISTS idx_events_hook_tool");

      // v41→v42: translate keeper's `''` default-profile sentinel ↔ agentuse's
      // `"default"` usage id at the join boundary so a default-account rate limit
      // colocates onto `usage.default`. No schema-shape change — the bump gates
      // the rewind that heals the stranded annotations (the fold output changed).
      // The DELETE adds `usage` + `profiles` to the standard set; MUST NOT touch
      // `dead_letters` (not a reducer projection).
      if (preMigrateStoredVersion < 42) {
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        db.run("DELETE FROM git_status");
        db.run("DELETE FROM file_attributions");
        db.run("DELETE FROM subagent_invocations");
        db.run("DELETE FROM usage");
        db.run("DELETE FROM profiles");
        // Every reducer-owned projection joins this canonical wipe list so any
        // FUTURE rewind stays complete; each is harmless-empty on a pre-feature
        // log.
        db.run("DELETE FROM dispatch_failures");
        db.run("DELETE FROM autopilot_state");
        db.run("DELETE FROM pending_dispatches");
        db.run("DELETE FROM armed_epics");
      }

      // v42→v43: comment-only no-op — `dispatch_failures` is created above and
      // populates from the reducer's fold arms; the version stamp needs a slot.
      // A reducer projection (in the rewind-and-redrain DELETE list).

      // v43→v44: add `file_attributions.worktree_oid` (the filter-correct git
      // blob oid frozen into the GitSnapshot payload). Nullable, no backfill
      // (the oid can't be re-derived from stored events); NULL falls back to
      // timestamp discharge ("cannot confirm content equality → keep active").
      addColumnIfMissing(db, "file_attributions", "worktree_oid", "TEXT");

      // v44→v45: add `file_attributions.worktree_mode`, paired with
      // `worktree_oid` on the discharge gate so a chmod-only dirty file (equal
      // oid, differing mode) is NOT wrongly discharged. Nullable → timestamp
      // discharge fallback.
      addColumnIfMissing(db, "file_attributions", "worktree_mode", "TEXT");

      // v45→v46: attribute planctl file writes. Adds `events.planctl_files`,
      // widens the `file_attributions.source` CHECK to include `'planctl'` (a
      // row-preserving TABLE REBUILD since SQLite can't ALTER a CHECK), backfills,
      // and rewinds. The CHECK rebuild MUST run BEFORE the rewind (DELETE
      // preserves the new CHECK) and before the boot drain writes
      // `source='planctl'` rows the old CHECK would reject. Version-guarded.
      addColumnIfMissing(db, "events", "planctl_files", "TEXT");

      const storedVersionV46 = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );

      // CHECK rebuild (SQLite can't ALTER a CHECK): create-new + byte-faithful
      // copy + drop-old + rename, then re-create the indexes. The copy MUST stay
      // byte-faithful even though the rewind below wipes the table.
      if (storedVersionV46 < 46) {
        // Drop any leftover temp table from an interrupted prior attempt.
        db.run("DROP TABLE IF EXISTS file_attributions_v46_tmp");
        db.run(`
        CREATE TABLE file_attributions_v46_tmp (
            project_dir TEXT NOT NULL,
            session_id TEXT NOT NULL,
            file_path TEXT NOT NULL,
            last_mutation_at REAL NOT NULL,
            last_commit_at REAL,
            op TEXT NOT NULL,
            source TEXT NOT NULL CHECK(source IN ('tool','bash','inferred','planctl')),
            last_event_id INTEGER,
            updated_at REAL NOT NULL DEFAULT 0,
            worktree_oid TEXT,
            worktree_mode TEXT,
            PRIMARY KEY (project_dir, session_id, file_path)
        )
      `);
        // Byte-faithful copy, ORDER BY rowid for stable physical order.
        db.run(`
        INSERT INTO file_attributions_v46_tmp
            (project_dir, session_id, file_path, last_mutation_at,
             last_commit_at, op, source, last_event_id, updated_at,
             worktree_oid, worktree_mode)
          SELECT project_dir, session_id, file_path, last_mutation_at,
                 last_commit_at, op, source, last_event_id, updated_at,
                 worktree_oid, worktree_mode
            FROM file_attributions
        ORDER BY rowid
      `);
        db.run("DROP TABLE file_attributions");
        db.run(
          "ALTER TABLE file_attributions_v46_tmp RENAME TO file_attributions",
        );
        // Re-create the indexes (SQLite drops them with their base table).
        for (const sql of CREATE_FILE_ATTRIBUTIONS_INDEXES) {
          db.run(sql);
        }
      }

      // Backfill `events.planctl_files` via the shared `extractPlanctlInvocation`
      // deriver (defensive parse; non-planctl rows stay NULL).
      if (storedVersionV46 < 46) {
        const rows = db
          .prepare(
            `SELECT id, hook_event, tool_name, data FROM events
             WHERE tool_name = 'Bash' AND hook_event = 'PostToolUse'`,
          )
          .all() as {
          id: number;
          hook_event: string;
          tool_name: string | null;
          data: string;
        }[];
        const updateStmt = db.prepare(
          "UPDATE events SET planctl_files = ? WHERE id = ?",
        );
        for (const row of rows) {
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(row.data) as Record<string, unknown>;
            if (typeof parsed !== "object" || parsed === null) {
              continue;
            }
          } catch {
            continue;
          }
          const inv = extractPlanctlInvocation(
            row.hook_event,
            row.tool_name,
            parsed,
          );
          if (inv === null) continue;
          const json = inv.files === null ? null : JSON.stringify(inv.files);
          updateStmt.run(json, row.id);
        }
      }

      // Cursor-rewind + redrain so historical .planctl orphans re-attribute
      // under the new mint path.
      if (storedVersionV46 < 46) {
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        db.run("DELETE FROM git_status");
        db.run("DELETE FROM file_attributions");
        db.run("DELETE FROM subagent_invocations");
      }

      // v46→v47: comment-only no-op — `autopilot_state` is created above and
      // populates from the boot-append `AutopilotPaused` fold; the version stamp
      // needs a slot. A reducer projection (in the rewind-and-redrain DELETE
      // list). No migration seed row keeps `created_at` purely event-log-derived.

      // v47→v48: backend-exec coordinate columns on `events` + `jobs`. Generic
      // `backend_exec_*` naming lets a future tmux/wezterm backend slot in
      // without a schema change. Whitelist-only Python read (see floor item 10:
      // a SCHEMA_VERSION bump MUST add the version to
      // `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit, or
      // every keeper-py read fails host-wide; test/schema-version.test.ts
      // enforces this on every later bump too).
      addColumnIfMissing(db, "events", "backend_exec_type", "TEXT");
      addColumnIfMissing(db, "events", "backend_exec_session_id", "TEXT");
      addColumnIfMissing(db, "events", "backend_exec_pane_id", "TEXT");
      addColumnIfMissing(db, "jobs", "backend_exec_type", "TEXT");
      addColumnIfMissing(db, "jobs", "backend_exec_session_id", "TEXT");
      addColumnIfMissing(db, "jobs", "backend_exec_pane_id", "TEXT");
      addColumnIfMissing(db, "jobs", "backend_exec_tab_id", "TEXT");
      addColumnIfMissing(db, "jobs", "backend_exec_tab_name", "TEXT");

      // v48→v49: task→committing-session link. NO new column — the field rides
      // FREE inside the embedded `tasks[].jobs[]` JSON-TEXT cell; pre-v49 stored
      // elements decode it as `undefined` and `buildEmbeddedJob` coerces to null
      // for byte-deterministic re-fold. Whitelist-only Python bump (floor 10).

      // v49→v50: comment-only no-op — `pending_dispatches` is created above and
      // populates from the reducer's fold arms; the version stamp needs a slot. A
      // reducer projection (in the rewind-and-redrain DELETE list).

      // v50→v51: add `events.background_task_id` + `jobs.monitors` + the partial
      // index. A version-guarded backfill re-derives the column via the SAME pure
      // deriver the hook uses, so a re-fold reproduces byte-identical
      // `jobs.monitors`.
      addColumnIfMissing(db, "events", "background_task_id", "TEXT");
      addColumnIfMissing(db, "jobs", "monitors", "TEXT NOT NULL DEFAULT '[]'");
      for (const sql of CREATE_V51_INDEXES) {
        db.run(sql);
      }

      if (preMigrateStoredVersion < 51) {
        const rows = db
          .prepare(
            `SELECT id, hook_event, tool_name, data FROM events
             WHERE hook_event = 'PostToolUse'
               AND tool_name IN ('Monitor', 'Bash')`,
          )
          .all() as {
          id: number;
          hook_event: string;
          tool_name: string | null;
          data: string;
        }[];
        const updateStmt = db.prepare(
          "UPDATE events SET background_task_id = ? WHERE id = ?",
        );
        for (const row of rows) {
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(row.data) as Record<string, unknown>;
            if (typeof parsed !== "object" || parsed === null) {
              continue; // schema default NULL already in place.
            }
          } catch {
            continue; // schema default NULL already in place.
          }
          const id = extractBackgroundTaskId(
            row.hook_event,
            row.tool_name,
            parsed,
          );
          if (id !== null) {
            updateStmt.run(id, row.id);
          }
        }
      }

      // v51→v52: add `jobs.last_permission_prompt_at`/`_kind` (blocked on a
      // permission/elicitation prompt), folded from a REAL `Notification` event
      // (not a synthetic mint), layering on top of `[working]` without flipping
      // state. The fields ride the embedded arrays so a rewind is REQUIRED. Unlike
      // the v25 input-request rewind, the live log ALREADY has historical
      // `permission_prompt` rows, so the rewind WILL fold them — intended; the
      // stamp is a pure function of `event.ts`, so a re-fold is deterministic.
      addColumnIfMissing(db, "jobs", "last_permission_prompt_at", "REAL");
      addColumnIfMissing(db, "jobs", "last_permission_prompt_kind", "TEXT");

      // Version-guarded rewind-and-redrain.
      const storedVersionV52 = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV52 < 52) {
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        db.run("DELETE FROM subagent_invocations");
      }

      // v52→v53: `epic_tombstones` guards every epic-shell-INSERT site against
      // the deleted-epic resurrection ghost. A rewind-and-redrain rebuilds
      // existing `epics` ghosts with the tombstone guard engaged.
      const storedVersionV53 = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV53 < 53) {
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        db.run("DELETE FROM subagent_invocations");
        db.run("DELETE FROM epic_tombstones");
      }

      // v53→v54: durable commit-derived creator/refiner edges. NO new column —
      // the commit-trailer union rides FREE inside the existing
      // `epics.job_links` / `jobs.epic_links` cells; `foldCommit` TRIGGERS the
      // per-session rebuild (never writes the cells directly — single-writer
      // preserved). No rewind (fix-forward): pre-feature Commit events default the
      // trailer fields to null, so the union is a historical no-op.

      // v54→v55: drop the dead `jobs.backend_exec_{tab_id,tab_name}` columns
      // (their fold is a no-op). The live `backend_exec_{type,session_id,pane_id}`
      // coords STAY.
      dropColumnIfPresent(db, "jobs", "backend_exec_tab_id");
      dropColumnIfPresent(db, "jobs", "backend_exec_tab_name");

      // v55→v56: rewrite `epics.default_visible` to add the `status IS NOT NULL`
      // materialized gate (status is non-null at exactly the EpicSnapshot UPSERT,
      // so it's an exact "EpicSnapshot folded" discriminator hiding NULL-status
      // shell rows). KEEP the CASE wrap (NOT NULL column, nullable status). SQLite
      // can't ALTER a generated-column expression, so DROP + re-ADD in this one
      // transaction: (1) DROP the index FIRST (it references the column);
      // (2) DROP the VIRTUAL column via a `table_xinfo` check (`table_info`
      // excludes generated columns and would no-op wrongly); (3) re-ADD;
      // (4) recreate the index. Version-guarded; `quick_check` asserts integrity.
      if (preMigrateStoredVersion < 56) {
        const xinfoCols = db.prepare("PRAGMA table_xinfo(epics)").all() as {
          name: string;
        }[];
        if (xinfoCols.some((c) => c.name === "default_visible")) {
          db.run("DROP INDEX IF EXISTS idx_epics_default_visible");
          db.run("ALTER TABLE epics DROP COLUMN default_visible");
        }
        addGeneratedColumnIfMissing(
          db,
          "epics",
          "default_visible",
          "INTEGER NOT NULL GENERATED ALWAYS AS (CASE WHEN status IS NOT NULL AND (status='open' OR approval!='approved') THEN 1 ELSE 0 END) VIRTUAL",
        );
        db.run(
          "CREATE INDEX IF NOT EXISTS idx_epics_default_visible ON epics(default_visible, sort_path, epic_id) WHERE default_visible = 1",
        );
        const integrity = db.prepare("PRAGMA quick_check").get() as {
          quick_check: string;
        } | null;
        if (integrity?.quick_check !== "ok") {
          throw new Error(
            `v55→v56 default_visible rewrite failed integrity quick_check: ${integrity?.quick_check ?? "no result"}`,
          );
        }
      }

      // v56→v57: add the empty `event_blobs` relocation side table. NOT a reducer
      // projection; with it empty every `COALESCE(events.data, event_blobs.data)`
      // returns the inline value, so re-fold is byte-identical.
      db.run(CREATE_EVENT_BLOBS);

      // v57→v58: relax `events.data` from NOT NULL → nullable so the compaction
      // relocator can NULL it after moving a cold blob.
      //
      // STOP-THE-WORLD TABLE REBUILD, not the O(1) `writable_schema` edit:
      // bun:sqlite's DEFENSIVE mode hard-blocks `UPDATE sqlite_master` even under
      // `writable_schema=ON`, so a full rebuild (new table, copy, DROP, RENAME) is
      // the only mechanism. THE DAEMON MUST BE STOPPED — the rebuild holds the
      // writer lock for minutes on a multi-GB DB, far past the hook's busy_timeout,
      // so a concurrent hook INSERT would dead-letter. One-time, shape-guarded
      // (`needsEventsRebuild` probes the live `data` NOT NULL flag, so fresh/
      // already-migrated DBs skip), OFFLINE. Crash-safe: inside the migrate
      // transaction, so an interrupted rebuild rolls back to the v57 table.
      // Re-fold determinism is untouched — `events` is the immutable log; the copy
      // pins column order via an explicit list and preserves the AUTOINCREMENT
      // high-water.
      if (needsEventsRebuild) {
        // Snapshot index SQL + AUTOINCREMENT high-water BEFORE the rename so the
        // rebuild recreates them exactly (no hardcoded index list to drift).
        // Auto-indexes (`sql IS NULL`) are recreated by CREATE TABLE.
        const eventsIndexSql = (
          db
            .prepare(
              "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events' AND sql IS NOT NULL",
            )
            .all() as { sql: string }[]
        ).map((r) => r.sql);
        const seqRow = db
          .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'")
          .get() as { seq: number } | null;

        // Build the relaxed table under a TEMP name, copy, DROP old `events`,
        // RENAME the temp to `events`. This AVOIDS `ALTER events RENAME TO
        // events_old`: a modern-SQLite rename rewrites every REFERENCE to `events`
        // — including `event_blobs`'s FK — leaving it dangling after the old table
        // drops (every later `INSERT INTO event_blobs` then fails `no such table:
        // events_old`). Renaming the NEW table (which nothing references) avoids
        // the rewrite. The DROP of the FK-referenced `events` needs FK enforcement
        // OFF, toggled AROUND the migrate transaction (see `needsEventsRebuild`).
        // The explicit copy column list pins column order.
        db.run(
          CREATE_EVENTS.replace(
            "CREATE TABLE IF NOT EXISTS events",
            "CREATE TABLE events_v58_new",
          ),
        );
        db.run(
          `INSERT INTO events_v58_new (
           id, ts, session_id, pid, hook_event, event_type, tool_name, matcher,
           cwd, permission_mode, agent_id, agent_type, stop_hook_active, data,
           subagent_agent_id, spawn_name, start_time, slash_command, skill_name,
           planctl_op, planctl_target, planctl_epic_id, planctl_task_id,
           planctl_subject_present, tool_use_id, config_dir, planctl_queue_jump,
           bash_mutation_kind, bash_mutation_targets, planctl_files,
           backend_exec_type, backend_exec_session_id, backend_exec_pane_id,
           background_task_id
         )
         SELECT
           id, ts, session_id, pid, hook_event, event_type, tool_name, matcher,
           cwd, permission_mode, agent_id, agent_type, stop_hook_active, data,
           subagent_agent_id, spawn_name, start_time, slash_command, skill_name,
           planctl_op, planctl_target, planctl_epic_id, planctl_task_id,
           planctl_subject_present, tool_use_id, config_dir, planctl_queue_jump,
           bash_mutation_kind, bash_mutation_targets, planctl_files,
           backend_exec_type, backend_exec_session_id, backend_exec_pane_id,
           background_task_id
         FROM events`,
        );
        db.run("DROP TABLE events");
        db.run("ALTER TABLE events_v58_new RENAME TO events");
        // Recreate every captured non-auto index on the rebuilt table.
        for (const sql of eventsIndexSql) {
          db.run(sql);
        }
        // Preserve the AUTOINCREMENT high-water so a future INSERT never reuses an
        // id. `sqlite_sequence` has no PK/UNIQUE, so UPDATE (not UPSERT).
        if (seqRow != null) {
          db.run("UPDATE sqlite_sequence SET seq = ? WHERE name = 'events'", [
            seqRow.seq,
          ]);
        }
        // Belt-and-suspenders: the rebuild is a destructive structural change, so
        // verify the new table is structurally sound before the transaction
        // COMMITs (a failed check throws → rolls back to the v57 table intact).
        const integrity = db.prepare("PRAGMA quick_check").get() as {
          quick_check: string;
        } | null;
        if (integrity?.quick_check !== "ok") {
          throw new Error(
            `v57→v58 events rebuild failed integrity quick_check: ${integrity?.quick_check ?? "no result"}`,
          );
        }
      }

      // v58→v59: carry a `has_live_worker_monitor` occupancy fact on the embedded
      // `epics.tasks[].jobs[]` element. NO new column — it rides FREE inside the
      // JSON cell; no rewind (fix-forward), with a safe absent ≡ `false` default.

      // v59→v60: add the nullable `autopilot_state.max_concurrent_jobs` cap
      // (DEFAULT NULL = unlimited). Frozen from config on main at boot-append mint
      // time (never read in the fold). Already in the autopilot_state rewind entry.
      addColumnIfMissing(
        db,
        "autopilot_state",
        "max_concurrent_jobs",
        "INTEGER",
      );

      // v60→v61: add the empty `event_ingest_offsets` NDJSON→events ingest cursor.
      // NOT a reducer projection (excluded from the re-fold reset DELETE list).
      db.run(CREATE_EVENT_INGEST_OFFSETS);

      // v61→v62: add `autopilot_state.mode` (NOT NULL DEFAULT 'yolo' = today's
      // work-everything baseline, also satisfying NOT NULL for the boot re-arm
      // INSERTs that bind no mode) + the `armed_epics` PRESENCE table (a reducer
      // projection, in the rewind-and-redrain DELETE list).
      addColumnIfMissing(
        db,
        "autopilot_state",
        "mode",
        "TEXT NOT NULL DEFAULT 'yolo'",
      );
      db.run(CREATE_ARMED_EPICS);

      // v62→v63: drop the dead `approval` surface — the v55→v56 virtual-column
      // playbook in REVERSE, all in this transaction: (1) DROP the index FIRST (it
      // references the VIRTUAL column); (2) DROP `default_visible` via a
      // `table_xinfo` check (`table_info` excludes generated columns); (3) re-ADD
      // it with an `approval`-free expression; (4) recreate the index; (5) DROP the
      // now-orphaned `approval` column — MUST follow the rewrite (the old
      // expression referenced it); (6) `quick_check`. Version-guarded.
      if (preMigrateStoredVersion < 63) {
        const xinfoCols = db.prepare("PRAGMA table_xinfo(epics)").all() as {
          name: string;
        }[];
        if (xinfoCols.some((c) => c.name === "default_visible")) {
          db.run("DROP INDEX IF EXISTS idx_epics_default_visible");
          db.run("ALTER TABLE epics DROP COLUMN default_visible");
        }
        addGeneratedColumnIfMissing(
          db,
          "epics",
          "default_visible",
          "INTEGER NOT NULL GENERATED ALWAYS AS (CASE WHEN status IS NOT NULL AND status='open' THEN 1 ELSE 0 END) VIRTUAL",
        );
        db.run(
          "CREATE INDEX IF NOT EXISTS idx_epics_default_visible ON epics(default_visible, sort_path, epic_id) WHERE default_visible = 1",
        );
        dropColumnIfPresent(db, "epics", "approval");
        const integrity = db.prepare("PRAGMA quick_check").get() as {
          quick_check: string;
        } | null;
        if (integrity?.quick_check !== "ok") {
          throw new Error(
            `v62→v63 approval drop / default_visible rewrite failed integrity quick_check: ${integrity?.quick_check ?? "no result"}`,
          );
        }
      }

      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(SCHEMA_VERSION));
      // `.immediate()` grabs the writer lock at BEGIN, so a CREATE/ALTER/INSERT
      // can't lose the upgrade-to-writer race and leave migrate half-applied.
    }).immediate();
  } finally {
    // Restore FK enforcement after the v57→v58 rebuild toggled it OFF; the
    // `finally` guards against a mid-migrate throw leaving it disabled.
    if (needsEventsRebuild) {
      db.run("PRAGMA foreign_keys = ON");
    }
  }

  // Chunked backfill OUTSIDE the migrate transaction (one short BEGIN IMMEDIATE
  // per chunk) so the WAL writer lock isn't held across the whole scan.
  // Version-guarded to run once per upgrade.
  if (preMigrateStoredVersion < 34) {
    backfillResolvedEpicDeps(db);
  }
}

/**
 * Build the prepared-statement bundle. The reducer folds with inline SQL, so it
 * binds nothing here.
 */
export function prepareStmts(db: Database): Stmts {
  return {
    // Named bindings (`$col`), not positional `?`: a positional list is a
    // column-shift hazard — a missed call site silently shifts `null` into the
    // next column without throwing.
    insertEvent: db.prepare(`
      INSERT INTO events (
        ts, session_id, pid, hook_event, event_type, tool_name, matcher,
        cwd, permission_mode, agent_id, agent_type, stop_hook_active, data,
        subagent_agent_id, spawn_name, start_time, slash_command, skill_name,
        planctl_op, planctl_target, planctl_epic_id, planctl_task_id,
        planctl_subject_present, tool_use_id, config_dir, planctl_queue_jump,
        bash_mutation_kind, bash_mutation_targets, planctl_files,
        backend_exec_type, backend_exec_session_id, backend_exec_pane_id,
        background_task_id
      ) VALUES (
        $ts, $session_id, $pid, $hook_event, $event_type, $tool_name, $matcher,
        $cwd, $permission_mode, $agent_id, $agent_type, $stop_hook_active, $data,
        $subagent_agent_id, $spawn_name, $start_time, $slash_command, $skill_name,
        $planctl_op, $planctl_target, $planctl_epic_id, $planctl_task_id,
        $planctl_subject_present, $tool_use_id, $config_dir, $planctl_queue_jump,
        $bash_mutation_kind, $bash_mutation_targets, $planctl_files,
        $backend_exec_type, $backend_exec_session_id, $backend_exec_pane_id,
        $background_task_id
      )
    `),
    selectWorldRev: db.prepare(
      "SELECT last_event_id FROM reducer_state WHERE id = 1",
    ),
  };
}

/** Read the singleton world rev (`reducer_state.last_event_id`); 0 if no row. */
export function selectWorldRev(stmts: Stmts): number {
  const row = stmts.selectWorldRev.get() as { last_event_id: number } | null;
  return row ? row.last_event_id : 0;
}

/**
 * Open a keeper DB connection. Writers migrate + auto-create the parent dir;
 * readers (`readonly: true`) skip migration and fail loudly on a missing file.
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

  // Hook carve-out: `prepareStmts: false` returns a throwing stub because the
  // static `insertEvent` would throw "no such column" on a schema-skewed live
  // DB before `openDb` returns. The hook builds a column-adaptive INSERT instead.
  const stmts = (options.prepareStmts ?? true) ? prepareStmts(db) : noStmts();
  return { db, stmts };
}

/**
 * Throwing-stub {@link Stmts} for `openDb({ prepareStmts: false })`. Accessing
 * either statement is a programming error (only the hook opts out, and it never
 * reads them) — fail loudly instead of handing back a typed `null`.
 */
function noStmts(): Stmts {
  const trap = (): never => {
    throw new Error(
      "openDb({ prepareStmts: false }) — statement bundle is unavailable on this connection",
    );
  };
  return {
    get insertEvent(): never {
      return trap();
    },
    get selectWorldRev(): never {
      return trap();
    },
  };
}

/**
 * Canonical planctl JSON serializer — MUST match
 * `json.dumps(data, indent=2, sort_keys=True) + "\n"` byte-for-byte. Two writers
 * (planctl + keeperd) hit the same files; any byte diff causes a round-trip
 * ping-pong. Sorts object keys, ASCII-escapes non-ASCII (`ensure_ascii=True`),
 * appends one trailing `\n`.
 */
export function serializePlanctlJson(data: unknown): string {
  const sorted = sortObjectKeys(data);
  const body = JSON.stringify(sorted, null, 2);
  return `${escapeNonAscii(body)}\n`;
}

/**
 * Recursively sort object keys lexicographically. Arrays preserve order;
 * primitives pass through.
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
 * Escape every non-ASCII code unit to `\uXXXX` to match Python's
 * `ensure_ascii=True`. `JSON.stringify` already escapes 0x00-0x1f identically,
 * so only 0x7f and >= 0x80 need escaping here (operates on the post-stringify
 * UTF-16 code units, mirroring Python's per-BMP-codepoint escape).
 */
function escapeNonAscii(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0x20 && code <= 0x7e) {
      out += s[i];
    } else if (code <= 0x1f) {
      out += s[i];
    } else {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    }
  }
  return out;
}

/**
 * Atomically write `content` to `path` via a same-directory temp file →
 * `renameSync` (POSIX rename atomicity only holds intra-filesystem). The temp
 * file is best-effort unlinked on any throw so a partial file never lingers.
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
      if (existsSync(tmp)) {
        unlinkSync(tmp);
      }
    } catch {
      // swallow — the original error is what the caller cares about
    }
    throw err;
  }
}

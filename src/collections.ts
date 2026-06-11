/**
 * Collection registry for the keeper read surface. Each `CollectionDescriptor`
 * pulls everything collection-specific (table, columns, pk, sort allowlist,
 * filters, diff key) into one entry so `runQuery` / `diffTick` route by
 * collection name. Adding a collection is one more `REGISTRY` entry with zero
 * wire-protocol or diff-machinery change.
 *
 * INJECTION INVARIANT: every interpolated SQL identifier (table, columns, pk,
 * sort column) comes from a descriptor here — trusted constants, never wire
 * text. Wire `filter` *keys* resolve against `descriptor.filters` by map lookup
 * (never interpolated); `filter` *values* and limit/offset stay bound.
 */

import type { Database } from "bun:sqlite";
import { MAX_IN_PARAMS } from "./db";
import type { FilterValue, Row } from "./protocol";

export type { Row };

/**
 * Everything collection-specific the read surface needs. All identifier-typed
 * fields (`table`, `columns`, `pk`, the values of `filters`, `sortable` /
 * `defaultSort` columns) are trusted constants safe to interpolate into SQL.
 *
 * - `name` — the wire-facing collection name (`query.collection`).
 * - `table` — the SQL table to read.
 * - `columns` — the SELECT list; also the shape served on the wire.
 * - `pk` — the primary-key column; the diff keys watched membership by it.
 * - `version` — the monotonic per-row column the diff fires on (a row patches
 *   when its `version` advances past `lastSent`). NOT the global frame `rev`.
 * - `sortable` — the allowlist of columns a client may sort by.
 * - `defaultSort` — the fallback sort when none/an unknown column is requested.
 * - `filters` — wire filter-key → SQL column. MUST include the pk so a
 *   detail-page single-item subscribe (`filter:{<pk>}`) works.
 * - `defaultFilter` — an optional base scope applied per filter-key when the wire
 *   query leaves that key unconstrained (e.g. epics default to `status: "open"`).
 *   A wire value for the key — bare or `{ ne }` — overrides the default, so a
 *   client can still page any status by asking for it explicitly. Keys MUST also
 *   appear in `filters` (they resolve through the same map-lookup gate).
 * - `defaultClause` — an optional RAW SQL fallback scope, applied when the wire
 *   filter is entirely empty (a pk lookup is exempt). For predicates that can't
 *   be per-key ANDs (e.g. epics' `default_visible = 1`). The `sql` is
 *   interpolated verbatim (the author owns its safety); `params` are bound. ANY
 *   explicit wire filter drops the whole clause. Coexists with `defaultFilter`.
 * - `jsonColumns` — columns stored as JSON TEXT that {@link decodeRow} parses
 *   into real values at the read boundary (so `result` and `patch` frames serve
 *   an array/object, not a JSON string). A parse failure / NULL falls back to
 *   `[]` per row (honors "one bad row never wedges a reader").
 */
export interface CollectionDescriptor {
  name: string;
  table: string;
  columns: readonly string[];
  pk: string;
  version: string;
  sortable: ReadonlySet<string>;
  defaultSort: { column: string; dir: "asc" | "desc" };
  filters: Readonly<Record<string, string>>;
  defaultFilter?: Readonly<Record<string, FilterValue>>;
  defaultClause?: { sql: string; params: readonly (string | number)[] };
  jsonColumns: ReadonlySet<string>;
}

/** The `jobs` descriptor. Default sort `created_at desc`; default scope hides
 *  terminal jobs (`defaultFilter` below). */
export const JOBS_DESCRIPTOR: CollectionDescriptor = {
  name: "jobs",
  table: "jobs",
  columns: [
    "job_id",
    "created_at",
    "cwd",
    "pid",
    "state",
    "last_event_id",
    "updated_at",
    "title",
    "title_source",
    "transcript_path",
    "plan_verb",
    "plan_ref",
    "epic_links",
    "last_api_error_at",
    "last_api_error_kind",
    "last_input_request_at",
    "last_input_request_kind",
    // Paired permission-prompt / elicitation annotation. Display-only.
    "last_permission_prompt_at",
    "last_permission_prompt_kind",
    "git_dirty_count",
    // `git_unattributed_to_live_count`: files not attributed to a LIVE session.
    // `git_orphan_count`: files with no attribution from ANY session. Display +
    // readiness-predicate inputs only.
    "git_unattributed_to_live_count",
    "git_orphan_count",
    // `profile_name`: `projectBasename(config_dir)` (NULL under the default
    // profile). Display-only.
    "profile_name",
    // Backend-exec coordinates, folded latest-non-NULL-wins. Generic naming
    // lets a future tmux/wezterm backend slot in without a schema change.
    // Display-only.
    "backend_exec_type",
    "backend_exec_session_id",
    "backend_exec_pane_id",
    // `monitors`: JSON-TEXT array snapshot-replaced each Stop. The renderer
    // parses the raw string itself, so this stays a raw TEXT scalar at the wire
    // layer — OUT of `jsonColumns`.
    "monitors",
    // `active_since`: Unix-seconds stamped on the rising edge into `working`;
    // the recency key for the unified dash AGENTS timeline. Display/sort-only.
    "active_since",
  ],
  pk: "job_id",
  version: "last_event_id",
  sortable: new Set([
    "updated_at",
    "created_at",
    "last_event_id",
    "job_id",
    "state",
  ]),
  defaultSort: { column: "created_at", dir: "desc" },
  filters: { state: "state", cwd: "cwd", job_id: "job_id" },
  // Default scope: no `state` filter shows only LIVE jobs (working + stopped),
  // hiding both terminal states. An explicit `state` filter overrides; a pk
  // subscribe is exempt (a detail read of a terminal job still resolves).
  defaultFilter: { state: { not_in: ["ended", "killed"] } },
  // `epic_links`: JSON-TEXT array of the creator/refiner cross-references
  // `syncPlanctlLinks` maintains, decoded at the read boundary for display.
  jsonColumns: new Set(["epic_links"]),
};

/**
 * The `epics` descriptor — each epic embeds its tasks + plan/close jobs as
 * JSON-array columns (decoded at the read boundary).
 *
 * Default sort is `sort_path asc` — the materialized-path key the reducer
 * derives (zero-padded-6 dotted lexicographic, e.g. `"000003.000007"`). The dot
 * (ASCII 46) sits below the digits, so under BINARY collation the prefix-sort
 * invariant `"000003" < "000003.000007" < "000004"` slots a closer-created
 * child directly after its parent. Closer-completion thus DOES reorder the page,
 * by design; ordinary task edits do not (they don't touch `sort_path`).
 */
export const EPICS_DESCRIPTOR: CollectionDescriptor = {
  name: "epics",
  table: "epics",
  columns: [
    "epic_id",
    "epic_number",
    "title",
    "project_dir",
    "status",
    "last_event_id",
    "updated_at",
    "tasks",
    "depends_on_epics",
    "jobs",
    "job_links",
    // `last_validated_at`: nullable scalar TEXT. Display-only; out of
    // `jsonColumns` (decoding a scalar would corrupt it to `[]`).
    "last_validated_at",
    // `created_by_closer_of` (closer-creator link) + `sort_path`
    // (materialized-path sort key), both reducer-derived in `syncPlanctlLinks`.
    // `sort_path` lands in `sortable` below; `created_by_closer_of` stays out
    // (downstream branches on its null-ness, not its value).
    "created_by_closer_of",
    "sort_path",
    // `queue_jump`: priority-jump flag (INTEGER 0/1). OUT of `sortable` (the
    // `!`-prefix on `sort_path` carries the ordering signal) and `filters`.
    "queue_jump",
    // `resolved_epic_deps`: nullable JSON-TEXT array. NULL is load-bearing —
    // "not-yet-computed", DISTINCT from `'[]'` ("computed, no deps"). Decoded as
    // a jsonColumn; out of `sortable`/`filters` (clients branch on element
    // shape).
    "resolved_epic_deps",
    // `default_visible`: VIRTUAL generated column (`status IS NOT NULL AND
    // status='open'`) materializing the default-page predicate so a partial
    // index can serve it. Display-only — clients may SEE it but MUST NOT
    // filter/sort by it; it's an implementation detail of `defaultClause`.
    "default_visible",
  ],
  pk: "epic_id",
  version: "last_event_id",
  sortable: new Set([
    "updated_at",
    "last_event_id",
    "epic_id",
    "epic_number",
    "status",
    // The materialized-path sort key — in the trust-boundary allowlist so the
    // generic ORDER BY interpolation accepts it as the default sort column.
    "sort_path",
  ]),
  defaultSort: { column: "sort_path", dir: "asc" },
  filters: {
    epic_id: "epic_id",
    status: "status",
    project_dir: "project_dir",
  },
  // Default scope: no wire filter shows every MATERIALIZED OPEN epic; done and
  // not-yet-materialized rows fall off the page. ANY explicit wire filter drops
  // this clause. The clause MUST be the literal `default_visible = 1` (NOT a
  // bound `= ?`): SQLite's partial-index matcher requires the WHERE term to
  // syntactically imply the index's `WHERE default_visible = 1`, and
  // bound-parameter constant folding isn't guaranteed to hit it across versions.
  defaultClause: {
    sql: "default_visible = 1",
    params: [],
  },
  // JSON-TEXT array columns decoded at the read boundary. Nested `task.jobs`
  // rides through the `tasks` parse, so it needs no separate entry.
  jsonColumns: new Set([
    "tasks",
    "depends_on_epics",
    "jobs",
    "job_links",
    // `resolved_epic_deps` is nullable — `decodeRow` returns `null` for a NULL
    // column. Null-vs-empty-array is load-bearing (still-converging vs no-deps).
    "resolved_epic_deps",
  ]),
};

/**
 * The `git` descriptor — one row per watched git worktree (membership gate:
 * `.planctl present || dirty || ahead of upstream > 0`, recomputed each
 * reconcile). A current-status snapshot plus derived per-live-job dirty/orphan
 * buckets, produced by synthetic `GitSnapshot` events.
 */
export const GIT_DESCRIPTOR: CollectionDescriptor = {
  name: "git",
  table: "git_status",
  columns: [
    "project_dir",
    "branch",
    "head_oid",
    "upstream",
    "ahead",
    "behind",
    "dirty_count",
    "orphaned_count",
    "dirty_files",
    "orphaned_files",
    "jobs",
    "last_event_id",
    "updated_at",
  ],
  pk: "project_dir",
  version: "last_event_id",
  sortable: new Set([
    "updated_at",
    "last_event_id",
    "project_dir",
    "dirty_count",
    "orphaned_count",
    "branch",
  ]),
  defaultSort: { column: "project_dir", dir: "asc" },
  filters: { project_dir: "project_dir", branch: "branch" },
  jsonColumns: new Set(["dirty_files", "orphaned_files", "jobs"]),
};

/**
 * The `usage` descriptor — one row per agentuse profile, a current-state
 * snapshot of one `~/.local/state/agentuse/<id>.json` envelope, produced by
 * synthetic `UsageSnapshot` / `UsageDeleted` events.
 *
 * The source envelope's freshness fields (`fetched_at`, `next_fetch_at`, …) are
 * read-and-discarded by the worker and absent from the projection. `error_at`
 * IS projected for "stale since" display but excluded from the worker
 * change-gate so a re-failed scrape with the same error produces zero events.
 */
export const USAGE_DESCRIPTOR: CollectionDescriptor = {
  name: "usage",
  table: "usage",
  columns: [
    "id",
    "target",
    "multiplier",
    "session_percent",
    "session_resets_at",
    "week_percent",
    "week_resets_at",
    "sonnet_week_percent",
    "sonnet_week_resets_at",
    "last_rate_limit_at",
    "last_rate_limit_session_id",
    "status",
    "subscription_active",
    "error_type",
    "error_message",
    "error_at",
    // Rate-limit lift instant + last-successful-fold freshness stamp, carved out
    // of the rate-limit fan-out so a RateLimited event cannot clobber them.
    "rate_limit_lifts_at",
    "last_usage_fold_at",
    "last_event_id",
    "updated_at",
  ],
  pk: "id",
  version: "last_event_id",
  sortable: new Set(["id", "target", "last_event_id", "updated_at"]),
  defaultSort: { column: "id", dir: "asc" },
  filters: { id: "id", target: "target" },
  jsonColumns: new Set(),
};

/**
 * The `profiles` descriptor — one row per Claude profile directory keyed by
 * `config_dir`, correlating the last `rate_limit` ApiError with each profile.
 * The `''` sentinel collapses the default `~/.claude` profile so a single PK
 * groups every NULL-`config_dir` session.
 */
export const PROFILES_DESCRIPTOR: CollectionDescriptor = {
  name: "profiles",
  table: "profiles",
  columns: [
    "config_dir",
    "profile_name",
    "last_rate_limit_at",
    "last_rate_limit_session_id",
    "last_event_id",
    "updated_at",
  ],
  pk: "config_dir",
  version: "last_event_id",
  sortable: new Set([
    "config_dir",
    "last_rate_limit_at",
    "last_event_id",
    "updated_at",
  ]),
  defaultSort: { column: "config_dir", dir: "asc" },
  filters: { config_dir: "config_dir" },
  jsonColumns: new Set(),
};

/**
 * The `subagent_invocations` descriptor — per-job timeline of `Agent` (Task)
 * tool invocations and their `SubagentStart` / `SubagentStop` lifecycle.
 * Composite pk `(job_id, agent_id, turn_seq)` in the table, but `pk` expects a
 * single column, so `job_id` carries the wire identity (every subscribe filters
 * by it) and the other two ride in `columns` for display.
 */
export const SUBAGENT_INVOCATIONS_DESCRIPTOR: CollectionDescriptor = {
  name: "subagent_invocations",
  table: "subagent_invocations",
  // Narrowed to the columns consumers actually read (wire render, readiness
  // predicate-6, the in-process autopilot read). `last_event_id` MUST stay —
  // it's the `version` column the diff and result re-seed read. Halves the
  // per-frame serialize cost of the large subagent set. NOT a row-filter or
  // page (those break render's count/stuck + the byId diff).
  columns: [
    "job_id",
    "subagent_type",
    "turn_seq",
    "ts",
    "status",
    "description",
    "last_event_id",
  ],
  pk: "job_id",
  version: "last_event_id",
  sortable: new Set(["ts", "turn_seq", "duration_ms"]),
  defaultSort: { column: "ts", dir: "asc" },
  filters: { job_id: "job_id" },
  jsonColumns: new Set(),
};

/**
 * The `dead_letters` descriptor — one row per dropped hook-INSERT recovered by
 * the daemon's import path. NOT a reducer projection: rows arrive via the daemon
 * scanning per-pid NDJSON files the hook wrote when its `events` INSERT
 * exhausted the bounded retry. Drives the board's persistent warn-count + the
 * replay verb's "oldest waiting first" pick.
 *
 * `version: 'dl_written_at'` so the diff fires when a new dead-letter lands.
 * The replay transition (`waiting → recovered`) does NOT bump it (it stamps
 * `recovered_at`); the `defaultFilter` is what hides recovered rows on the
 * default page, NOT a version-column trick.
 */
export const DEAD_LETTERS_DESCRIPTOR: CollectionDescriptor = {
  name: "dead_letters",
  table: "dead_letters",
  columns: [
    "dl_id",
    "session_id",
    "hook_event",
    "ts",
    "dl_written_at",
    "pid",
    "bindings",
    "status",
    "recovered_at",
    "replayed_event_id",
    "source_file",
  ],
  pk: "dl_id",
  version: "dl_written_at",
  sortable: new Set([
    "dl_written_at",
    "ts",
    "recovered_at",
    "hook_event",
    "session_id",
  ]),
  defaultSort: { column: "dl_written_at", dir: "asc" },
  filters: {
    dl_id: "dl_id",
    status: "status",
    session_id: "session_id",
    hook_event: "hook_event",
  },
  // Default scope: hide already-recovered rows so the warn-count tracks the
  // live backlog. An explicit `status` filter overrides; a pk subscribe is
  // exempt.
  defaultFilter: { status: "waiting" },
  jsonColumns: new Set(["bindings"]),
};

/**
 * The `dispatch_failures` descriptor — the reconciler's sticky-failure surface,
 * one row per `(verb, id)` dispatch stamped failed and not yet cleared via a
 * `retry_dispatch` RPC. A reducer projection (re-fold rebuilds it
 * byte-identically). Composite pk `(verb, id)`, but `pk` expects a single
 * column, so `verb` carries the wire identity and `id` rides in `columns` /
 * `filters`.
 */
export const DISPATCH_FAILURES_DESCRIPTOR: CollectionDescriptor = {
  name: "dispatch_failures",
  table: "dispatch_failures",
  columns: [
    "verb",
    "id",
    "reason",
    "dir",
    "ts",
    "last_event_id",
    "created_at",
    "updated_at",
  ],
  pk: "verb",
  version: "last_event_id",
  sortable: new Set(["verb", "id", "ts", "created_at", "updated_at"]),
  defaultSort: { column: "ts", dir: "desc" },
  filters: {
    verb: "verb",
    id: "id",
    reason: "reason",
  },
  jsonColumns: new Set(),
};

/**
 * The `autopilot_state` singleton descriptor — the worker's paused/playing flag
 * (plus cap + mode) as a wire-readable collection so `keeper autopilot`'s banner
 * reflects the worker's real state. One row at most (`id = 1`).
 */
export const AUTOPILOT_STATE_DESCRIPTOR: CollectionDescriptor = {
  name: "autopilot_state",
  table: "autopilot_state",
  columns: [
    "id",
    "paused",
    "last_event_id",
    "created_at",
    "updated_at",
    // Global concurrency cap, rendered from the socket ONLY (never config.yaml).
    // NULL = unlimited → `∞`.
    "max_concurrent_jobs",
    // Autopilot mode enum (`'yolo'` | `'armed'`), defaulting `'yolo'` on a
    // zero-event / pre-existing row.
    "mode",
  ],
  pk: "id",
  version: "last_event_id",
  sortable: new Set(["id", "last_event_id", "created_at", "updated_at"]),
  defaultSort: { column: "id", dir: "asc" },
  filters: {
    id: "id",
  },
  jsonColumns: new Set(),
};

/**
 * The `armed_epics` descriptor — the per-epic armed PRESENCE table the
 * autopilot's `armed` mode reads each reconcile cycle (a row's presence means
 * armed). Registering it here is what makes the table subscribable over the UDS
 * socket.
 */
export const ARMED_EPICS_DESCRIPTOR: CollectionDescriptor = {
  name: "armed_epics",
  table: "armed_epics",
  columns: ["epic_id", "last_event_id", "created_at", "updated_at"],
  pk: "epic_id",
  version: "last_event_id",
  sortable: new Set(["epic_id", "last_event_id", "created_at", "updated_at"]),
  defaultSort: { column: "created_at", dir: "desc" },
  filters: {
    epic_id: "epic_id",
  },
  jsonColumns: new Set(),
};

/**
 * The `pending_dispatches` descriptor — the durable launch-window
 * double-dispatch suppression substrate: one row per `(verb, id)` dispatch the
 * reconciler minted a `Dispatched` event for and that has not yet been
 * discharged (SessionStart bind, `DispatchFailed`, or the TTL sweep's
 * `DispatchExpired`). The dedup source of truth the reconciler reads in its
 * readiness pass; a reducer projection. Composite pk `(verb, id)` → `verb`
 * carries the wire identity, `id` rides in `columns` / `filters`.
 */
export const PENDING_DISPATCHES_DESCRIPTOR: CollectionDescriptor = {
  name: "pending_dispatches",
  table: "pending_dispatches",
  columns: ["verb", "id", "dir", "dispatched_at", "last_event_id"],
  pk: "verb",
  version: "last_event_id",
  sortable: new Set(["verb", "id", "dispatched_at", "last_event_id"]),
  defaultSort: { column: "dispatched_at", dir: "desc" },
  filters: {
    verb: "verb",
    id: "id",
  },
  jsonColumns: new Set(),
};

/**
 * The `builds` descriptor — one row per registered buildbot builder, keyed by
 * builder NAME (`project`). A reducer projection produced by synthetic
 * `BuildSnapshot` / `BuildDeleted` events; the `keeper builds` dashboard
 * subscribes over the socket. All scalar columns (no JSON). `version:
 * 'last_event_id'` so the diff fires on every fold; default sort is stable by
 * pk so the dashboard renders builders alphabetically.
 */
export const BUILDS_DESCRIPTOR: CollectionDescriptor = {
  name: "builds",
  table: "builds",
  columns: [
    "project",
    "builder_id",
    "build_number",
    "complete",
    "results",
    "state_string",
    "started_at",
    "complete_at",
    "last_event_id",
    "updated_at",
  ],
  pk: "project",
  version: "last_event_id",
  sortable: new Set([
    "project",
    "build_number",
    "results",
    "last_event_id",
    "updated_at",
  ]),
  defaultSort: { column: "project", dir: "asc" },
  filters: { project: "project" },
  jsonColumns: new Set(),
};

/** The registry, keyed by wire-facing collection name. */
export const REGISTRY: Map<string, CollectionDescriptor> = new Map([
  [JOBS_DESCRIPTOR.name, JOBS_DESCRIPTOR],
  [EPICS_DESCRIPTOR.name, EPICS_DESCRIPTOR],
  [GIT_DESCRIPTOR.name, GIT_DESCRIPTOR],
  [SUBAGENT_INVOCATIONS_DESCRIPTOR.name, SUBAGENT_INVOCATIONS_DESCRIPTOR],
  [USAGE_DESCRIPTOR.name, USAGE_DESCRIPTOR],
  [PROFILES_DESCRIPTOR.name, PROFILES_DESCRIPTOR],
  [DEAD_LETTERS_DESCRIPTOR.name, DEAD_LETTERS_DESCRIPTOR],
  [DISPATCH_FAILURES_DESCRIPTOR.name, DISPATCH_FAILURES_DESCRIPTOR],
  [AUTOPILOT_STATE_DESCRIPTOR.name, AUTOPILOT_STATE_DESCRIPTOR],
  [PENDING_DISPATCHES_DESCRIPTOR.name, PENDING_DISPATCHES_DESCRIPTOR],
  [ARMED_EPICS_DESCRIPTOR.name, ARMED_EPICS_DESCRIPTOR],
  [BUILDS_DESCRIPTOR.name, BUILDS_DESCRIPTOR],
]);

/** Resolve a collection name to its descriptor, or `undefined` if unknown. */
export function getCollection(name: string): CollectionDescriptor | undefined {
  return REGISTRY.get(name);
}

/**
 * Read a set of rows by primary key. Empty-set short-circuits to `[]` (a bare
 * `IN ()` is a SQL syntax error); over `MAX_IN_PARAMS` throws ("chunk the
 * caller"). Returns rows in SQLite's emission order (NOT input order). Trusted
 * identifiers interpolated, ids bound (`?`).
 */
export function selectByIds(
  db: Database,
  descriptor: CollectionDescriptor,
  ids: readonly string[],
): Row[] {
  if (ids.length === 0) {
    return [];
  }
  if (ids.length > MAX_IN_PARAMS) {
    throw new Error(
      `selectByIds: id-set of ${ids.length} exceeds SQLITE_MAX_VARIABLE_NUMBER (${MAX_IN_PARAMS}); chunk the caller`,
    );
  }
  const placeholders = ids.map(() => "?").join(",");
  const sql = `
    SELECT ${descriptor.columns.join(", ")}
      FROM ${descriptor.table}
     WHERE ${descriptor.pk} IN (${placeholders})
  `;
  // Per-call prepare: the statement shape is arity-dependent and page sizes are
  // small (capped well below MAX_IN_PARAMS), so compile cost is negligible.
  const stmt = db.prepare(sql);
  const rows = stmt.all(...ids) as Row[];
  // Decode any JSON-TEXT columns so the diff/patch path serves the same shape
  // as the page SELECT in `runQuery` (a no-op while `jsonColumns` is empty).
  return rows.map((row) => decodeRow(descriptor, row));
}

/**
 * Read JUST the `(pk, version)` pair for a set of rows — `diffTick`'s
 * version-probe-first pass, which drives the conditional full-row `selectByIds`
 * ONLY when something changed. The two reads can race a writer commit between
 * them (same read-snapshot drift class as elsewhere; self-correcting next tick).
 * Mirrors `selectByIds`'s prelude (empty → empty Map, over-cap throw, per-call
 * prepare). The `Map<string, number | null>` value shape future-proofs against
 * a descriptor making `version` nullable.
 */
export function selectVersionsByIds(
  db: Database,
  descriptor: CollectionDescriptor,
  ids: readonly string[],
): Map<string, number | null> {
  if (ids.length === 0) {
    return new Map();
  }
  if (ids.length > MAX_IN_PARAMS) {
    throw new Error(
      `selectVersionsByIds: id-set of ${ids.length} exceeds SQLITE_MAX_VARIABLE_NUMBER (${MAX_IN_PARAMS}); chunk the caller`,
    );
  }
  const placeholders = ids.map(() => "?").join(",");
  const sql = `
    SELECT ${descriptor.pk} AS pk, ${descriptor.version} AS version
      FROM ${descriptor.table}
     WHERE ${descriptor.pk} IN (${placeholders})
  `;
  const stmt = db.prepare(sql);
  const rows = stmt.all(...ids) as { pk: unknown; version: number | null }[];
  const map = new Map<string, number | null>();
  for (const r of rows) {
    map.set(String(r.pk), r.version);
  }
  return map;
}

/**
 * Caller-side chunking wrappers for {@link selectByIds} /
 * {@link selectVersionsByIds}, which throw past `MAX_IN_PARAMS`. `diffTick`
 * watches WHOLE collections, so a collection over the cap would blow SQLite's
 * bound-variable limit and crash-loop the daemon. These split into
 * `MAX_IN_PARAMS`-sized batches and merge (array form preserves batch order;
 * map form is a disjoint union — pks are unique). Sub-cap calls pass straight
 * through.
 */
export function selectByIdsChunked(
  db: Database,
  descriptor: CollectionDescriptor,
  ids: readonly string[],
): Row[] {
  if (ids.length <= MAX_IN_PARAMS) {
    return selectByIds(db, descriptor, ids);
  }
  const out: Row[] = [];
  for (let i = 0; i < ids.length; i += MAX_IN_PARAMS) {
    const batch = selectByIds(db, descriptor, ids.slice(i, i + MAX_IN_PARAMS));
    for (const row of batch) out.push(row);
  }
  return out;
}

export function selectVersionsByIdsChunked(
  db: Database,
  descriptor: CollectionDescriptor,
  ids: readonly string[],
): Map<string, number | null> {
  if (ids.length <= MAX_IN_PARAMS) {
    return selectVersionsByIds(db, descriptor, ids);
  }
  const merged = new Map<string, number | null>();
  for (let i = 0; i < ids.length; i += MAX_IN_PARAMS) {
    const batch = selectVersionsByIds(
      db,
      descriptor,
      ids.slice(i, i + MAX_IN_PARAMS),
    );
    for (const [pk, version] of batch) merged.set(pk, version);
  }
  return merged;
}

/**
 * Decode a row's JSON-TEXT columns at the read boundary so the wire frame serves
 * arrays/objects, not JSON strings. A NULL/empty cell or parse failure falls
 * back to `[]` (one bad row never wedges a reader). Returns a new row.
 *
 * MUST be called at BOTH row-producing reads (the page SELECT and `selectByIds`
 * on the diff path) so `result` and `patch` frames agree on the decoded shape.
 */
export function decodeRow(descriptor: CollectionDescriptor, row: Row): Row {
  if (descriptor.jsonColumns.size === 0) {
    return row;
  }
  const out: Row = { ...row };
  for (const col of descriptor.jsonColumns) {
    const raw = out[col];
    if (typeof raw === "string" && raw.length > 0) {
      try {
        out[col] = JSON.parse(raw);
        continue;
      } catch {
        // fall through to the [] fallback
      }
    }
    // NULL preservation: for nullable JSON columns (e.g. `resolved_epic_deps`)
    // NULL is load-bearing — "not-yet-computed", DISTINCT from a stored `'[]'`.
    // Preserve `null` so clients can branch on it; an unparseable/empty string
    // still falls back to `[]` (the schema default for NOT NULL JSON columns).
    out[col] = raw === null || raw === undefined ? null : [];
  }
  return out;
}

/** A filtered set's size + a membership fingerprint over its pk identities. */
export interface CountAndToken {
  /** `COUNT(*)` over the full filtered set (the WHERE only — no limit/offset). */
  total: number;
  /**
   * A fingerprint of the matching rows' pk IDENTITIES (never mutable columns),
   * ordered by pk so it's stable tick-to-tick. Changes iff a row enters/leaves
   * the filtered set (incl. a balanced swap: one in, one out, `total` steady).
   * The empty set normalizes to `""` so it compares cleanly against a populated
   * set's token.
   */
  token: string;
}

/**
 * Compute a filtered set's `total` plus a membership `token` in ONE query. The
 * caller passes the SAME `whereClause` + `params` that built the page SELECT so
 * the count can never drift from the page.
 *
 * The token is `group_concat(<pk>)` over the matching pk identities. The inner
 * `ORDER BY <pk>` is REQUIRED: `group_concat` order is otherwise plan-dependent,
 * and an unstable token fires phantom `meta` frames every tick. Ordering by the
 * pk (not the display sort) keeps it a pure membership fingerprint. Zero rows →
 * `NULL`, normalized to `""` for a clean-diffing empty set.
 */
export function countAndToken(
  db: Database,
  descriptor: CollectionDescriptor,
  whereClause: string,
  params: readonly (string | number)[],
): CountAndToken {
  const sql = `
    SELECT COUNT(*) AS n, group_concat(${descriptor.pk}) AS token
      FROM (
        SELECT ${descriptor.pk}
          FROM ${descriptor.table}
          ${whereClause}
         ORDER BY ${descriptor.pk}
      )
  `;
  const row = db.prepare(sql).get(...params) as {
    n: number;
    token: string | null;
  };
  return { total: row.n, token: row.token ?? "" };
}

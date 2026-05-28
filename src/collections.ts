/**
 * Collection registry for the keeper read surface. The UDS subscribe server
 * (`src/server-worker.ts`) used to hardcode `jobs` at every layer — the SQL
 * (`FROM jobs`), the sort allowlist, the filter branches, and the diff key
 * (`job_id` / `last_event_id`). This module pulls everything collection-specific
 * into a `CollectionDescriptor` so `runQuery` / `diffTick` route by collection
 * name instead. Two collections register today — `jobs` and `epics` (each epic
 * embeds its tasks + plan/close jobs as JSON-array columns, and as of schema
 * v13 carries `approval` as a real column). Adding a future collection is one
 * more `REGISTRY` entry with zero wire-protocol or diff-machinery change.
 *
 * Cross-refs:
 * - `src/db.ts` — owns `MAX_IN_PARAMS` (reused here, not redefined) and the
 *   schema the descriptors describe.
 * - `src/protocol.ts` — the wire frames carry the `collection` name resolved
 *   against this registry; `Row` is the generic served-row shape on the frames.
 * - `src/server-worker.ts` — the sole consumer: `getCollection` + `selectByIds`.
 *
 * INJECTION INVARIANT: every interpolated SQL identifier (table, columns, pk,
 * sort column) comes from a descriptor here — trusted constants, never wire
 * text. Wire `filter` *keys* are resolved against `descriptor.filters` by map
 * lookup (never interpolated); `filter` *values* and limit/offset stay bound.
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
 *   filter is entirely empty (and the lookup is not a pk lookup, which is
 *   exempt from defaults). Used for predicates that can't be expressed as
 *   per-key ANDs — e.g. epics default to `(status = 'open' OR approval !=
 *   'approved')`. The `sql` string is interpolated verbatim into the WHERE so
 *   columns / operators are the descriptor author's responsibility; `params`
 *   are bound. ANY explicit wire filter drops the whole clause (the wire is
 *   the user's "I know what I want" override). Distinct from `defaultFilter`
 *   so per-key wins still apply where they make sense; the two can coexist.
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

/**
 * The `jobs` descriptor — the first collection. Mirrors what `runQuery` /
 * `diffTick` / `selectJobsByIds` hardcoded before namespacing: the current
 * SELECT list, the `SORTABLE_COLUMNS` allowlist, the `created_at desc` default
 * (newest-created job on top), and the `state`/`cwd` filters PLUS `job_id` (the
 * pk — for detail-page single-item subscribe). The default scope hides `ended`
 * jobs (`defaultFilter` below).
 */
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
    "git_dirty_count",
    // Schema v31: the legacy `git_orphan_count` (schema v28 — "files-not-
    // attributed-to-a-live-session") is renamed to
    // `git_unattributed_to_live_count` under the new vocabulary. The fresh
    // `git_orphan_count` carries the new strict-mystery semantic (files
    // with no attribution from any session — past or present), populated
    // by the new reducer fold in fn-633.6. Both columns ride here as
    // INTEGER NOT NULL DEFAULT 0; neither is in `sortable` / `filters`
    // (display + readiness-predicate inputs only).
    "git_unattributed_to_live_count",
    "git_orphan_count",
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
  // Default scope: a jobs query with no `state` filter shows only LIVE jobs —
  // working ("running") + stopped — and hides BOTH terminal states (`ended` and
  // `killed`). Job state is exactly working|stopped|ended|killed (see the
  // reducer), so `state NOT IN ("ended", "killed")` is precisely "stopped and
  // running". A client still pages terminal rows by asking explicitly
  // (`filter:{state:"ended"}` or `filter:{state:"killed"}`, or a custom
  // `{in:[...]}`/`{not_in:[...]}` set), which overrides this default; a pk
  // subscribe is exempt (a detail read of an ended/killed job still resolves).
  defaultFilter: { state: { not_in: ["ended", "killed"] } },
  // `title` + `title_source` + `transcript_path` + `plan_verb` + `plan_ref`
  // are read-only display this phase — served on `result`/`patch` (the
  // source/path for provenance + debugging, the planctl verb/ref pair for
  // associating jobs with epics/tasks) but NOT in `sortable`/`filters`. A
  // future client query (e.g. "subscribe to all jobs for epic X") would add
  // `plan_ref` to `filters` and rely on the partial `idx_jobs_plan_ref`
  // index added in schema v10. `epic_links` (schema v14) is the same shape:
  // a JSON-TEXT array decoded at the read boundary for display only — the
  // creator/refiner cross-references the reducer's `syncPlanctlLinks`
  // fan-out maintains for each job's planctl footprint.
  jsonColumns: new Set(["epic_links"]),
};

/**
 * The `epics` descriptor — the plans read surface's first collection. Columns
 * mirror the `epics` table 1:1 (`src/db.ts` `CREATE_EPICS`). `version` is
 * `last_event_id` (the monotonic per-row column the diff fires on, bumped by
 * the snapshot fold). `filters` carries the pk (`epic_id` — detail-page
 * single-item subscribe) plus the natural filter columns `status` +
 * `project_dir` + `approval`. `title`/`epic_number` are read-only display —
 * served but out of `sortable`/`filters`. `project_dir` holds opaque foreign-
 * process JSON; it's a bound filter VALUE here, never an interpolated
 * identifier or a filesystem-read driver.
 *
 * As of schema v7 each epic embeds its tasks as the `tasks` JSON-array column —
 * the standalone `tasks` collection was dropped. `tasks` is served (in
 * `columns`) AND registered in `jsonColumns` so {@link decodeRow} parses the
 * stored TEXT into a real `Task[]` at the read boundary; it is OUT of
 * `sortable`/`filters` (a nested display array, never a sort/filter key).
 *
 * Default sort: schema v29 flips this from `epic_number asc` to `sort_path
 * asc`. `sort_path` is the materialized-path key the reducer derives in
 * `syncPlanctlLinks` (zero-padded-6 dotted lexicographic, like
 * `"000003.000007"`). The dot (ASCII 46) sits strictly below the digits
 * (ASCII 48-57), so under SQLite BINARY collation the prefix-sort invariant
 * `"000003" < "000003.000007" < "000004"` slots a closer-created child
 * directly after its parent and before the next peer epic. This is a
 * MEANINGFUL change from the v6-through-v28 stance: closer-completion DOES
 * reorder the page, by design — the moment a child epic is created from a
 * closer session, it appears one row below the closed parent. The previous
 * rationale ("`epic_number` never reorders, so a task edit can't churn the
 * page") still holds for ordinary edits (task-snapshot folds don't touch
 * `created_by_closer_of` or `sort_path`); only the closer-creation event
 * itself triggers a reorder, which is the explicitly desired behavior.
 *
 * `sort_path` is added to `sortable` (the trust-boundary allowlist for
 * ORDER BY interpolation in `src/server-worker.ts`). `created_by_closer_of`
 * is served as a column but stays OUT of `sortable` / `filters` —
 * downstream consumers (board's `[slotted-after-closer]` pill, future
 * filters) branch on its null-ness, not its value, so a wire filter slot
 * would be cosmetic.
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
    "approval",
    "last_event_id",
    "updated_at",
    "tasks",
    "depends_on_epics",
    "jobs",
    "job_links",
    // `last_validated_at` (schema v16) — plain nullable TEXT (ISO-8601 when
    // set). Served verbatim on `result`/`patch`; out of `sortable` /
    // `filters` (display-only this phase) and out of `jsonColumns` (a
    // scalar string, NOT JSON — decoding it would fall back to `[]` and
    // corrupt the wire value).
    "last_validated_at",
    // Schema v29: closer-creator link + materialized-path sort key. Both
    // reducer-derived inside `syncPlanctlLinks` (see `src/reducer.ts`).
    // `created_by_closer_of` is plain nullable TEXT; `sort_path` is TEXT
    // NOT NULL DEFAULT ''. Both served verbatim on `result`/`patch` and
    // out of `jsonColumns` (scalar strings). `sort_path` lands in
    // `sortable` below (driving the new default ORDER BY);
    // `created_by_closer_of` stays out (downstream branches on its
    // null-ness, not its value).
    "created_by_closer_of",
    "sort_path",
    // Schema v30: `queue_jump` — priority-jump flag projected from the
    // `planctl_invocation` envelope's `queue_jump` boolean by
    // `syncPlanctlLinks`. INTEGER NOT NULL DEFAULT 0 at the SQLite layer;
    // dashctl consumers lift to JS boolean (`queue_jump === 1`) at the
    // read boundary. Served verbatim on `result`/`patch`; kept OUT of
    // `sortable` (the `!`-prefix on `sort_path` carries the ordering
    // signal — sorting by `queue_jump` directly would be a redundant
    // wire knob) AND OUT of `filters` (downstream consumers branch on
    // the value cosmetically — e.g. a `[queued]` pill — rather than
    // wire-filter on it). Out of `jsonColumns` (a scalar integer).
    "queue_jump",
  ],
  pk: "epic_id",
  version: "last_event_id",
  sortable: new Set([
    "updated_at",
    "last_event_id",
    "epic_id",
    "epic_number",
    "status",
    // Schema v29: the materialized-path sort key. Added to the
    // trust-boundary allowlist so the generic ORDER BY interpolation in
    // `src/server-worker.ts` accepts it as the default sort column.
    "sort_path",
  ]),
  defaultSort: { column: "sort_path", dir: "asc" },
  filters: {
    epic_id: "epic_id",
    status: "status",
    project_dir: "project_dir",
    // `approval` (schema v13 — the fn-592-approval-as-planctl-field epic) is
    // the epics-UI's default-hide-approved key. The natural-filter slot
    // matches the same `<wire key> → <SQL column>` shape as `status`; the
    // descriptor's filter machinery ANDs every key together (see
    // `resolveFilter` in `src/server-worker.ts`), so the two-key default scope
    // below composes for free — no new composition machinery required.
    approval: "approval",
  },
  // Default scope: an epics query with no wire filter shows every epic that
  // is OPEN OR NOT-YET-APPROVED — the union, not the intersection. Open work
  // (live) and unreviewed work (needs a human) are both interesting; only
  // done-AND-approved epics fall off the page by default. The predicate
  // crosses two columns, so it lives in `defaultClause` (raw SQL with bound
  // params) rather than the per-key `defaultFilter` map. ANY explicit wire
  // filter — `--status done`, `--show-approved`, a pk subscribe — drops
  // this clause entirely (the wire is the user's "I know what I want"
  // override).
  defaultClause: {
    sql: "(status = ? OR approval != ?)",
    params: ["open", "approved"],
  },
  // `tasks`, `depends_on_epics`, `jobs`, and `job_links` are JSON-TEXT array
  // columns — decoded to real arrays at the read boundary. `jobs` carries the
  // epic-level `EmbeddedJob[]` (plan/close verbs); `job_links` (schema v14)
  // carries the symmetric per-epic creator/refiner cross-references the
  // reducer's `syncPlanctlLinks` fan-out maintains from planctl-CLI
  // invocation classifier output. Nested `task.jobs` (work-verb jobs on each
  // task element) rides through the `tasks` parse — `decodeRow` returns
  // parsed arrays whose nested objects' nested arrays are already arrays, so
  // no separate `jsonColumns` entry is needed for the nested sub-array. All
  // four are served + decoded but OUT of `sortable`/`filters`.
  jsonColumns: new Set(["tasks", "depends_on_epics", "jobs", "job_links"]),
};

/**
 * The `git` descriptor — one row per planctl-backed git worktree observed by
 * the git worker. The row is a current-status snapshot plus derived per-live-job
 * dirty/orphan buckets. It is produced by synthetic `GitSnapshot` events, so the
 * read surface still rides the normal SQLite subscription machinery.
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
 * The `usage` descriptor — one row per agentuse profile observed by the
 * usage worker. The row is a current-state snapshot of one
 * `~/.local/state/agentuse/<id>.json` envelope (target, multiplier, and the
 * two-window session+week percent/reset pair). It is produced by synthetic
 * `UsageSnapshot` / `UsageDeleted` events, so the read surface rides the
 * normal SQLite subscription machinery.
 *
 * **Freshness fields excluded by design.** The source envelope carries
 * `fetched_at` / `next_fetch_at` / `last_successful_fetch_at` /
 * `last_skipped_fetch_at` — these are read-and-discarded by the worker and
 * absent from the projection schema. See `src/usage-worker.ts` for the
 * change-gate discipline that enforces the exclusion.
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
 * The `subagent_invocations` descriptor — per-job timeline of `Agent` (Task)
 * tool invocations and their `SubagentStart` / `SubagentStop` lifecycle. The
 * peer-table projection lives in schema v17 (`src/db.ts`'s
 * `CREATE_SUBAGENT_INVOCATIONS`) and is populated by the reducer arms in
 * `projectSubagentInvocationsRow` (`src/reducer.ts`). Composite pk
 * `(job_id, agent_id, turn_seq)` — re-entrant subagents within a session land
 * on distinct rows via the per-job monotone `turn_seq` counter.
 *
 * Composite-PK note: the descriptor's `pk` field expects a single column name
 * (the diff-tick membership token + `selectByIds` lookup both index on it).
 * `job_id` is the consumer-meaningful identity for the wire (every
 * subscribe currently filters by `job_id`), so it carries the role; the
 * other two pk columns ride in `columns` for display. A future
 * detail-page subscribe on a single turn would need a composite-pk extension
 * to the descriptor — out of scope for fn-600 (the wire surface here is
 * per-job timeline, not per-turn detail).
 *
 * `version: 'last_event_id'` — the reducer bumps this on every UPDATE so the
 * wire collection's diff fires patch frames as a row transitions
 * `running → ok` and `duration_ms` populates on SubagentStop. `defaultSort:
 * { ts ASC }` matches the chronological reading order. No `defaultFilter` /
 * `defaultClause` — a subscribe returns every per-job row by default, and
 * the UI filters/sorts on the descriptor-exposed columns.
 */
export const SUBAGENT_INVOCATIONS_DESCRIPTOR: CollectionDescriptor = {
  name: "subagent_invocations",
  table: "subagent_invocations",
  columns: [
    "job_id",
    "agent_id",
    "turn_seq",
    "ts",
    "tool_use_id",
    "subagent_type",
    "description",
    "prompt_chars",
    "status",
    "duration_ms",
    "last_event_id",
    "updated_at",
  ],
  pk: "job_id",
  version: "last_event_id",
  sortable: new Set(["ts", "turn_seq", "duration_ms"]),
  defaultSort: { column: "ts", dir: "asc" },
  filters: { job_id: "job_id" },
  jsonColumns: new Set(),
};

/**
 * The registry, keyed by wire-facing collection name. `jobs` + the `epics`
 * plan collection (which embeds its tasks + plan/close-verb jobs as JSON-array
 * columns — the standalone `tasks` collection was dropped in schema v7 — and
 * carries `approval` as a real column as of schema v13) + `git` + the
 * `subagent_invocations` per-job Agent-timeline projection (schema v17).
 */
export const REGISTRY: Map<string, CollectionDescriptor> = new Map([
  [JOBS_DESCRIPTOR.name, JOBS_DESCRIPTOR],
  [EPICS_DESCRIPTOR.name, EPICS_DESCRIPTOR],
  [GIT_DESCRIPTOR.name, GIT_DESCRIPTOR],
  [SUBAGENT_INVOCATIONS_DESCRIPTOR.name, SUBAGENT_INVOCATIONS_DESCRIPTOR],
  [USAGE_DESCRIPTOR.name, USAGE_DESCRIPTOR],
]);

/** Resolve a collection name to its descriptor, or `undefined` if unknown. */
export function getCollection(name: string): CollectionDescriptor | undefined {
  return REGISTRY.get(name);
}

/**
 * Read a set of rows from a collection's table by primary key. Generalizes the
 * old `db.selectJobsByIds`: same empty-set → `[]` short-circuit (a bare
 * `IN ()` is a SQL syntax error), same `MAX_IN_PARAMS` cap throw, same per-call
 * prepare. Returns rows in SQLite's emission order (NOT input order) — the
 * caller re-indexes by `descriptor.pk` if rendering order matters.
 *
 * `descriptor.table` / `columns` / `pk` are trusted constants (interpolated);
 * the ids are bound (`?`). See the injection invariant at the top of the file.
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
 * Read JUST the `(pk, version)` pair for a set of rows by primary key. The
 * version-probe-first pass in `diffTick`: cheap to project (no row body, no
 * JSON columns), cheap to decode (no `decodeRow`), and the result feeds a
 * per-conn `version > lastSent` comparison that drives the conditional
 * `selectByIds` for full rows ONLY when something changed. The two reads can
 * race a writer commit between them — same read-snapshot drift class as the
 * existing `readWorldRev` + `selectByIds` sequence; self-correcting next tick.
 *
 * Mirrors `selectByIds`'s prelude one-for-one: empty `ids` short-circuits to
 * an empty Map (`IN ()` is a SQL syntax error), `ids.length > MAX_IN_PARAMS`
 * throws (the cap-throw failure semantics match `selectByIds` — propagates to
 * `pollLoop` → daemon `fatalExit` → LaunchAgent restart), and the prepare is
 * per-call (the IN-list arity varies per tick; caching by SQL string via
 * `db.query()` would leak prepared-statement entries). `AS pk`/`AS version`
 * aliases normalize the returned shape regardless of which descriptor was
 * passed. `descriptor.pk` and `descriptor.version` are trusted constants
 * (interpolation-safe); the ids are bound (`?`).
 *
 * NEVER calls `decodeRow` — by descriptor design, neither `pk` nor `version`
 * is in `jsonColumns` (they're SQL scalar identifiers). The `Map<string,
 * number | null>` value shape preserves today's `selectByIds` row-cast
 * (`row[descriptor.version] as number | null`) at the call site so the
 * existing `version !== null && version > last` guard in `diffTick` keeps
 * unchanged — and future-proofs against a descriptor making `version`
 * nullable.
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
  // Per-call prepare: matches the `selectByIds` rationale — arity-varying
  // IN-list, cache-leak risk via `db.query()`.
  const stmt = db.prepare(sql);
  const rows = stmt.all(...ids) as { pk: unknown; version: number | null }[];
  const map = new Map<string, number | null>();
  for (const r of rows) {
    map.set(String(r.pk), r.version);
  }
  return map;
}

/**
 * Decode a row's JSON-TEXT columns into real values at the read boundary. For
 * each name in `descriptor.jsonColumns`, replaces the row's stored TEXT with
 * `JSON.parse`'d output so the wire frame serves an array/object — not a JSON
 * string. A NULL/empty cell or a parse failure falls back to `[]` for that
 * column (one bad row never wedges a reader). Returns a new row; the input is
 * left untouched.
 *
 * MUST be called at BOTH row-producing reads (the page SELECT in
 * `runQuery` and `selectByIds` on the diff path) so `result` and `patch` frames
 * agree on the decoded shape — a divergence would serve a JSON-TEXT column as a
 * string on one path and a parsed value on the other. `epics.tasks` (schema v7)
 * is the first — and currently only — registered `jsonColumn`: the embedded
 * `Task[]` array decoded here so a `result`/`patch` epic row serves a real
 * array, not a JSON string.
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
    out[col] = [];
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
 * caller passes the already-resolved `whereClause` ("" or "WHERE ...") and its
 * bound `params` — the SAME pair that built the page SELECT — so the count can
 * never drift from the page (a drift would mean "X of N" where X isn't a subset
 * of N).
 *
 * The token is `group_concat(<pk>)` over the matching pk identities, computed
 * via the portable subquery form `SELECT group_concat(pk) FROM (SELECT pk ...
 * ORDER BY pk)`. The inner `ORDER BY <pk>` is REQUIRED: SQLite `group_concat`
 * order is otherwise arbitrary (plan-dependent), and an unstable token fires
 * phantom `meta` frames every tick. Ordering by the pk (the stable identity),
 * not the display sort, keeps the token a pure membership fingerprint. The
 * subquery form (rather than SQLite-3.44+ `group_concat(pk ORDER BY pk)`) drops
 * a runtime-version dependency at zero cost on a tiny table.
 *
 * `group_concat` over zero rows returns `NULL`; we normalize that to `""` so an
 * empty filtered set has a stable `token=""` / `total=0` that diffs cleanly.
 *
 * Injection: only `descriptor.table` / `descriptor.pk` are interpolated
 * (trusted constants); the filter `params` are bound (`?`). The descriptor stays
 * the SOLE SQL-identifier injection gate — see the file-top invariant.
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

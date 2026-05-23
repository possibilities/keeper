/**
 * Collection registry for the keeper read surface. The UDS subscribe server
 * (`src/server-worker.ts`) used to hardcode `jobs` at every layer — the SQL
 * (`FROM jobs`), the sort allowlist, the filter branches, and the diff key
 * (`job_id` / `last_event_id`). This module pulls everything collection-specific
 * into a `CollectionDescriptor` so `runQuery` / `diffTick` route by collection
 * name instead. `jobs` is the first registered descriptor; adding a future
 * collection is a second `REGISTRY` entry with zero wire-protocol or
 * diff-machinery change.
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
  // index added in schema v10. No JSON-TEXT columns are served today
  // (`title_history` was retired), so `decodeRow` short-circuits on the
  // empty set.
  jsonColumns: new Set([]),
};

/**
 * The `epics` descriptor — the plans read surface's first collection. Columns
 * mirror the v6 `epics` table 1:1 (`src/db.ts` `CREATE_EPICS`). `version` is
 * `last_event_id` (the monotonic per-row column the diff fires on, bumped by the
 * snapshot fold). Sort defaults to creation order, newest first, like `jobs`
 * (`epic_number desc` — epics have no `created_at` column, and `epic_number` is
 * the monotonic creation-order signal). `filters`
 * carries the pk (`epic_id` — detail-page single-item subscribe) plus the
 * natural filter columns `status` + `project_dir`. `title`/`epic_number` are
 * read-only display — served but out of `sortable`/`filters`. `project_dir`
 * holds opaque foreign-process JSON; it's a bound filter VALUE here, never an
 * interpolated identifier or a filesystem-read driver.
 *
 * As of schema v7 each epic embeds its tasks as the `tasks` JSON-array column —
 * the standalone `tasks` collection was dropped. `tasks` is served (in
 * `columns`) AND registered in `jsonColumns` so {@link decodeRow} parses the
 * stored TEXT into a real `Task[]` at the read boundary; it is OUT of
 * `sortable`/`filters` (a nested display array, never a sort/filter key). The
 * default sort is `epic_number desc` — newest-created epic on top, a stable
 * creation order, so a task edit (which bumps the epic's `last_event_id`) never
 * reorders the default view.
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
  ],
  pk: "epic_id",
  version: "last_event_id",
  sortable: new Set([
    "updated_at",
    "last_event_id",
    "epic_id",
    "epic_number",
    "status",
  ]),
  defaultSort: { column: "epic_number", dir: "desc" },
  filters: {
    epic_id: "epic_id",
    status: "status",
    project_dir: "project_dir",
  },
  // Default scope: an epics query with no `status` filter shows only OPEN epics
  // (done/closed epics are filtered out of the default view). A client still
  // pages any other status by asking for it explicitly (`filter:{status}` or
  // `{status:{ne}}`), which overrides this default — and a pk subscribe carries
  // its own `epic_id`, not `status`, so detail-page reads of a done epic still
  // resolve. The view-side knob is keeper-frames' `--status` / `--status-ne`.
  defaultFilter: { status: "open" },
  // `tasks`, `depends_on_epics`, and `jobs` are JSON-TEXT array columns —
  // decoded to real arrays at the read boundary. `jobs` carries the
  // epic-level `EmbeddedJob[]` (plan/close verbs). Nested `task.jobs`
  // (work-verb jobs on each task element) rides through the `tasks` parse —
  // `decodeRow` returns parsed arrays whose nested objects' nested arrays
  // are already arrays, so no separate `jsonColumns` entry is needed for
  // the nested sub-array. All three are served + decoded but OUT of
  // `sortable`/`filters`.
  jsonColumns: new Set(["tasks", "depends_on_epics", "jobs"]),
};

/**
 * The registry, keyed by wire-facing collection name. `jobs` + the `epics`
 * plan collection (which now embeds its tasks as a JSON-array column — the
 * standalone `tasks` collection was dropped in schema v7).
 */
export const REGISTRY: Map<string, CollectionDescriptor> = new Map([
  [JOBS_DESCRIPTOR.name, JOBS_DESCRIPTOR],
  [EPICS_DESCRIPTOR.name, EPICS_DESCRIPTOR],
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

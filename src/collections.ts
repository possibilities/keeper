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
import type { Row } from "./protocol";

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
  jsonColumns: ReadonlySet<string>;
}

/**
 * The `jobs` descriptor — the first collection. Mirrors what `runQuery` /
 * `diffTick` / `selectJobsByIds` hardcoded before namespacing: the current
 * SELECT list, the `SORTABLE_COLUMNS` allowlist, the `updated_at desc` default,
 * and the `state`/`cwd` filters PLUS `job_id` (the pk — for detail-page
 * single-item subscribe).
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
  defaultSort: { column: "updated_at", dir: "desc" },
  filters: { state: "state", cwd: "cwd", job_id: "job_id" },
  // `title` is read-only display this phase — NOT in `sortable`/`filters`. No
  // JSON-TEXT columns are served today (`title_history` was retired), so
  // `decodeRow` short-circuits on the empty set.
  jsonColumns: new Set([]),
};

/** The registry, keyed by wire-facing collection name. One entry today. */
export const REGISTRY: Map<string, CollectionDescriptor> = new Map([
  [JOBS_DESCRIPTOR.name, JOBS_DESCRIPTOR],
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
 * string on one path and a parsed value on the other. No collection registers a
 * `jsonColumn` today, so this is dormant generic infrastructure.
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

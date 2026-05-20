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
}

/**
 * The `jobs` descriptor — the first collection. Mirrors what `runQuery` /
 * `diffTick` / `selectJobsByIds` hardcoded before namespacing: the current
 * SELECT list, the `SORTABLE_COLUMNS` allowlist, the `updated_at desc` default,
 * and the `state`/`mode`/`cwd` filters PLUS `job_id` (the pk — for detail-page
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
    "mode",
    "state",
    "last_event_id",
    "updated_at",
  ],
  pk: "job_id",
  version: "last_event_id",
  sortable: new Set([
    "updated_at",
    "created_at",
    "last_event_id",
    "job_id",
    "state",
    "mode",
  ]),
  defaultSort: { column: "updated_at", dir: "desc" },
  filters: { state: "state", mode: "mode", cwd: "cwd", job_id: "job_id" },
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
  return stmt.all(...ids) as Row[];
}

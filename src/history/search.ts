import type { Database } from "bun:sqlite";
import type {
  TranscriptEntryKind,
  TranscriptRole,
  TranscriptSource,
} from "../transcript/model";
import type { HistoryIndexPaths } from "./index-db";
import { openHistoryIndexReadOnly } from "./index-db";
import type {
  HistoryHarness,
  HistorySearchFilters,
  HistorySearchHit,
  HistorySearchQuery,
  HistorySearchResult,
} from "./model";

export const HISTORY_SEARCH_QUERY_MAX_CHARS = 4096;
export const HISTORY_SEARCH_LIMIT_MAX = 200;
export const HISTORY_SEARCH_OFFSET_MAX = 1_000_000;
const HISTORY_SEARCH_DEFAULT_LIMIT = 20;
const HISTORY_SEARCH_BODY_MAX_CHARS = 8192;

function literalFtsQuery(text: string): string {
  // Quote every whitespace-delimited term and supply the ANDs ourselves. FTS
  // operators, wildcards, parentheses, and column-looking tokens remain data,
  // while ordinary multi-word search need not be an exact adjacent phrase.
  return (text.match(/\S+/g) ?? [])
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
}

interface BuiltWhere {
  sql: string;
  params: Array<string | number>;
  impossible: boolean;
}

function appendIn(
  clauses: string[],
  params: Array<string | number>,
  column: string,
  values: readonly string[] | undefined,
): boolean {
  if (values === undefined) return false;
  if (values.length === 0) return true;
  clauses.push(`${column} IN (${values.map(() => "?").join(", ")})`);
  params.push(...values);
  return false;
}

function buildWhere(
  ftsQuery: string,
  filters: HistorySearchFilters,
): BuiltWhere {
  const clauses = ["entries_fts MATCH ?"];
  const params: Array<string | number> = [ftsQuery];
  let impossible = false;
  impossible =
    appendIn(clauses, params, "s.session_key", filters.sessionKeys) ||
    impossible;
  impossible =
    appendIn(clauses, params, "s.harness", filters.harnesses) || impossible;
  impossible =
    appendIn(clauses, params, "s.project", filters.projects) || impossible;
  impossible = appendIn(clauses, params, "e.role", filters.roles) || impossible;
  impossible =
    appendIn(clauses, params, "s.transcript_source", filters.sources) ||
    impossible;
  if (filters.sinceMs !== null && filters.sinceMs !== undefined) {
    clauses.push("e.timestamp_ms >= ?");
    params.push(filters.sinceMs);
  }
  if (filters.untilMs !== null && filters.untilMs !== undefined) {
    clauses.push("e.timestamp_ms <= ?");
    params.push(filters.untilMs);
  }
  return { sql: clauses.join(" AND "), params, impossible };
}

interface SearchRow {
  id: number;
  source_key: string;
  source_ordinal: number;
  role: string;
  kind: string;
  timestamp: string | null;
  timestamp_ms: number | null;
  body: string;
  native_entry_id: string | null;
  parent_native_entry_id: string | null;
  session_key: string;
  harness: string;
  native_id: string;
  project: string | null;
  title: string | null;
  transcript_source: string;
  score: number;
}

function emptyResult(offset: number): HistorySearchResult {
  return {
    kind: "ok",
    hits: [],
    total: 0,
    offset,
    nextOffset: null,
  };
}

/** Search an already-open compatible sidecar. This pure/injected DB seam keeps
 * tests away from host transcript homes and Keeper's control database. */
export function searchHistoryDatabase(
  db: Database,
  query: HistorySearchQuery,
): HistorySearchResult {
  const text = query.text.trim();
  if (text.length === 0) {
    return {
      kind: "invalid_query",
      code: "empty_query",
      message: "history search query must not be empty",
    };
  }
  if (text.length > HISTORY_SEARCH_QUERY_MAX_CHARS) {
    return {
      kind: "invalid_query",
      code: "query_too_long",
      message: "history search query exceeds the local query limit",
    };
  }
  const mode = query.mode ?? "literal";
  const ftsQuery = mode === "advanced" ? text : literalFtsQuery(text);
  const rawOffset = query.offset ?? 0;
  const offset = Number.isFinite(rawOffset)
    ? Math.min(HISTORY_SEARCH_OFFSET_MAX, Math.max(0, Math.trunc(rawOffset)))
    : 0;
  const rawLimit = query.limit ?? HISTORY_SEARCH_DEFAULT_LIMIT;
  const limit = Number.isFinite(rawLimit)
    ? Math.min(HISTORY_SEARCH_LIMIT_MAX, Math.max(1, Math.trunc(rawLimit)))
    : HISTORY_SEARCH_DEFAULT_LIMIT;
  const where = buildWhere(ftsQuery, query.filters ?? {});
  if (where.impossible) return emptyResult(offset);

  try {
    const countRow = db
      .query(`SELECT count(*) AS total
        FROM entries_fts
        JOIN entries e ON e.id = entries_fts.rowid
        JOIN sources s ON s.source_key = e.source_key
        WHERE ${where.sql}`)
      .get(...(where.params as never[])) as { total: number } | null;
    const total = Number(countRow?.total ?? 0);
    const rows = db
      .query(`SELECT
          e.id, e.source_key, e.source_ordinal, e.role, e.kind,
          e.timestamp, e.timestamp_ms, e.body, e.native_entry_id,
          e.parent_native_entry_id, s.session_key, s.harness, s.native_id,
          s.project, s.title, s.transcript_source,
          bm25(entries_fts) AS score
        FROM entries_fts
        JOIN entries e ON e.id = entries_fts.rowid
        JOIN sources s ON s.source_key = e.source_key
        WHERE ${where.sql}
        ORDER BY
          score ASC,
          COALESCE(e.timestamp_ms, -9007199254740991) DESC,
          s.session_key COLLATE BINARY ASC,
          e.source_ordinal ASC,
          e.id ASC
        LIMIT ? OFFSET ?`)
      .all(...([...where.params, limit, offset] as never[])) as SearchRow[];
    const hits: HistorySearchHit[] = rows.map((row) => ({
      entryId: Number(row.id),
      sessionKey: row.session_key,
      harness: row.harness as HistoryHarness,
      nativeId: row.native_id,
      project: row.project,
      title: row.title,
      role: row.role as TranscriptRole,
      kind: row.kind as TranscriptEntryKind,
      source: row.transcript_source as TranscriptSource,
      timestamp: row.timestamp,
      timestampMs: row.timestamp_ms === null ? null : Number(row.timestamp_ms),
      body:
        row.body.length <= HISTORY_SEARCH_BODY_MAX_CHARS
          ? row.body
          : row.body.slice(0, HISTORY_SEARCH_BODY_MAX_CHARS),
      score: Number(row.score),
      context: {
        sessionKey: row.session_key,
        sourceKey: row.source_key,
        source: row.transcript_source as TranscriptSource,
        sourceOrdinal: Number(row.source_ordinal),
        nativeEntryId: row.native_entry_id,
        parentNativeEntryId: row.parent_native_entry_id,
      },
    }));
    const end = offset + hits.length;
    return {
      kind: "ok",
      hits,
      total,
      offset,
      nextOffset: end < total ? end : null,
    };
  } catch {
    // Never echo the raw advanced query or a SQLite diagnostic containing it.
    return {
      kind: "invalid_query",
      code: "invalid_fts_query",
      message: "advanced FTS query is invalid",
    };
  }
}

export function searchHistoryIndex(
  paths: HistoryIndexPaths,
  query: HistorySearchQuery,
): HistorySearchResult {
  const db = openHistoryIndexReadOnly(paths);
  try {
    return searchHistoryDatabase(db, query);
  } finally {
    db.close();
  }
}

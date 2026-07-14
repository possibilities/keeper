import type { Database } from "bun:sqlite";
import type {
  FileEvidenceGrade,
  FileEvidenceSource,
  HistoryContextHandle,
  HistoryHarness,
} from "./model";

export const HISTORY_FILES_LIMIT_MAX = 200;
export const HISTORY_FILES_OFFSET_MAX = 10_000;
export const HISTORY_FILES_DEFAULT_LIMIT = 50;
export const HISTORY_FILE_PROVENANCE_MAX = 24;

export interface HistoryFileEvidenceQuery {
  fragment: string;
  sessionKeys?: readonly string[];
  includeMentions?: boolean;
  offset?: number;
  limit?: number;
}

export interface HistoryFileEvidenceProvenanceRow {
  source: FileEvidenceSource;
  context: HistoryContextHandle | null;
}

export interface HistoryFileEvidenceMatch {
  path: string;
  grade: FileEvidenceGrade;
  sessionKey: string;
  harness: HistoryHarness;
  nativeId: string;
  project: string | null;
  title: string | null;
  provenance: HistoryFileEvidenceProvenanceRow[];
  provenanceTotal: number;
  provenanceTruncated: boolean;
}

export interface HistoryFileEvidenceResult {
  matches: HistoryFileEvidenceMatch[];
  total: number;
  offset: number;
  nextOffset: number | null;
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function normalizedOffset(raw: number | undefined): number {
  return Number.isFinite(raw)
    ? Math.min(HISTORY_FILES_OFFSET_MAX, Math.max(0, Math.trunc(raw as number)))
    : 0;
}

function normalizedLimit(raw: number | undefined): number {
  return Number.isFinite(raw)
    ? Math.min(HISTORY_FILES_LIMIT_MAX, Math.max(1, Math.trunc(raw as number)))
    : HISTORY_FILES_DEFAULT_LIMIT;
}

interface WhereParts {
  sql: string;
  params: Array<string | number>;
  impossible: boolean;
}

function buildWhere(query: HistoryFileEvidenceQuery): WhereParts {
  const clauses = ["fe.path LIKE ? ESCAPE '\\'"];
  const params: Array<string | number> = [`%${escapeLike(query.fragment)}%`];
  let impossible = false;
  if (query.includeMentions !== true) {
    clauses.push("fe.grade != 'mention'");
  }
  if (query.sessionKeys !== undefined) {
    if (query.sessionKeys.length === 0) impossible = true;
    else {
      clauses.push(
        `fe.session_key IN (${query.sessionKeys.map(() => "?").join(", ")})`,
      );
      params.push(...query.sessionKeys);
    }
  }
  return { sql: clauses.join(" AND "), params, impossible };
}

interface EvidenceRow {
  path: string;
  grade: string;
  session_key: string;
  harness: string;
  native_id: string;
  project: string | null;
  title: string | null;
  provenance_json: string;
  provenance_total: number;
}

function parseProvenance(raw: string): HistoryFileEvidenceProvenanceRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item): HistoryFileEvidenceProvenanceRow[] => {
    if (item === null || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.source !== "string") return [];
    const sourceKey =
      typeof row.source_key === "string" ? row.source_key : null;
    const transcriptSource =
      typeof row.transcript_source === "string" ? row.transcript_source : null;
    const sourceOrdinal = Number(row.source_ordinal);
    const hasContext =
      sourceKey !== null &&
      transcriptSource !== null &&
      Number.isInteger(sourceOrdinal) &&
      sourceOrdinal >= 0;
    return [
      {
        source: row.source as FileEvidenceSource,
        context: hasContext
          ? {
              sessionKey: String(row.session_key ?? ""),
              sourceKey,
              source: transcriptSource as HistoryContextHandle["source"],
              sourceOrdinal,
              nativeEntryId:
                typeof row.native_entry_id === "string"
                  ? row.native_entry_id
                  : null,
              parentNativeEntryId:
                typeof row.parent_native_entry_id === "string"
                  ? row.parent_native_entry_id
                  : null,
            }
          : null,
      },
    ];
  });
}

export function queryHistoryFileEvidenceDatabase(
  db: Database,
  query: HistoryFileEvidenceQuery,
): HistoryFileEvidenceResult {
  const offset = normalizedOffset(query.offset);
  const limit = normalizedLimit(query.limit);
  const where = buildWhere(query);
  if (where.impossible) {
    return { matches: [], total: 0, offset, nextOffset: null };
  }
  const countRow = db
    .query(`SELECT count(*) AS total FROM (
        SELECT fe.path, fe.grade, fe.session_key
          FROM file_evidence fe
          JOIN sources s ON s.source_key = fe.source_key
         WHERE ${where.sql}
         GROUP BY fe.path, fe.grade, fe.session_key
      )`)
    .get(...(where.params as never[])) as { total: number } | null;
  const total = Number(countRow?.total ?? 0);
  const rows = db
    .query(`WITH ranked AS (
        SELECT
          fe.*,
          s.harness,
          s.native_id,
          s.project,
          s.title,
          row_number() OVER (
            PARTITION BY fe.path, fe.grade, fe.session_key
            ORDER BY fe.source_key COLLATE BINARY, fe.source_ordinal, fe.id
          ) AS provenance_rank,
          count(*) OVER (
            PARTITION BY fe.path, fe.grade, fe.session_key
          ) AS provenance_total
        FROM file_evidence fe
        JOIN sources s ON s.source_key = fe.source_key
        WHERE ${where.sql}
      )
      SELECT
        path,
        grade,
        session_key,
        harness,
        native_id,
        project,
        title,
        json_group_array(json_object(
          'source', provenance_source,
          'session_key', session_key,
          'source_key', source_key,
          'transcript_source', transcript_source,
          'source_ordinal', source_ordinal,
          'native_entry_id', native_entry_id,
          'parent_native_entry_id', parent_native_entry_id
        )) AS provenance_json,
        max(provenance_total) AS provenance_total
      FROM ranked
      WHERE provenance_rank <= ${HISTORY_FILE_PROVENANCE_MAX}
      GROUP BY path, grade, session_key
      ORDER BY
        CASE grade
          WHEN 'observed_mutation' THEN 0
          WHEN 'possible_mutation' THEN 1
          ELSE 2
        END ASC,
        path COLLATE BINARY ASC,
        session_key COLLATE BINARY ASC
      LIMIT ? OFFSET ?`)
    .all(...([...where.params, limit, offset] as never[])) as EvidenceRow[];
  const matches = rows.map((row) => ({
    path: row.path,
    grade: row.grade as FileEvidenceGrade,
    sessionKey: row.session_key,
    harness: row.harness as HistoryHarness,
    nativeId: row.native_id,
    project: row.project,
    title: row.title,
    provenance: parseProvenance(row.provenance_json),
    provenanceTotal: Number(row.provenance_total),
    provenanceTruncated:
      Number(row.provenance_total) > HISTORY_FILE_PROVENANCE_MAX,
  }));
  const end = offset + matches.length;
  return {
    matches,
    total,
    offset,
    nextOffset: end < total ? end : null,
  };
}

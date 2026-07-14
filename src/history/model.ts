import type {
  TranscriptEntryKind,
  TranscriptRole,
  TranscriptSource,
} from "../transcript/model";

export const HISTORY_HARNESSES = ["claude", "pi"] as const;
export type HistoryHarness = (typeof HISTORY_HARNESSES)[number];

export function isHistoryHarness(value: string): value is HistoryHarness {
  return (HISTORY_HARNESSES as readonly string[]).includes(value);
}

/** One native main-transcript artifact. Artifact path is part of identity because
 * native ids can legitimately be duplicated across projects or harness roots. */
export interface NativeSessionArtifact {
  harness: HistoryHarness;
  nativeId: string;
  path: string;
  project: string | null;
  currentTitle: string | null;
  titleHistory: string[];
  /** False only for a deliberately sampled plain-list scan. Resolvers and
   * index refreshes request complete native title records. */
  titleHistoryComplete?: boolean;
  startedAt: string | null;
  updatedAt: string | null;
  bytes: number;
}

/** The narrow, read-only jobs shape consumed by the catalog. Callers that read
 * keeper.db adapt rows into this shape; the catalog itself never opens keeper.db. */
export interface KeeperJobAlias {
  jobId: string;
  harness: HistoryHarness;
  nativeId: string;
  transcriptPath: string | null;
  project: string | null;
  currentTitle: string | null;
  titleHistory: string[];
  state: string | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  pid: number | null;
  startTime: string | null;
}

export interface KeeperJobRowLike {
  job_id: unknown;
  harness?: unknown;
  resume_target?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  title?: unknown;
  name_history?: unknown;
  state?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  pid?: unknown;
  start_time?: unknown;
}

export type SessionTitleSource = "native" | "keeper_job";

export interface SessionTitleRecord {
  title: string;
  source: SessionTitleSource;
  current: boolean;
  /** Present only for a Keeper job title record. */
  jobId: string | null;
  /** Stable order within that source's native history. */
  ordinal: number;
}

export interface CatalogSessionArtifact {
  path: string;
  bytes: number;
}

export interface CatalogSession {
  /** Stable catalog identity, distinct for duplicate native ids by artifact. */
  sessionKey: string;
  harness: HistoryHarness;
  nativeId: string;
  qualifiedNativeId: string;
  artifact: CatalogSessionArtifact | null;
  project: string | null;
  currentTitle: string | null;
  titleRecords: SessionTitleRecord[];
  /** Exact aliases used by title resolution, in deterministic display order. */
  titles: string[];
  titleHistoryComplete: boolean;
  jobs: KeeperJobAlias[];
  startedAt: string | null;
  updatedAt: string | null;
}

export type HistoryDiagnosticCode =
  | "root_unavailable"
  | "root_read_failed"
  | "artifact_read_failed"
  | "unsupported_job_harness"
  | "job_missing_native_id"
  | "source_changed"
  | "source_read_failed"
  | "source_removed"
  | "keeper_jobs_unavailable"
  | "keeper_mutations_unavailable"
  | "diagnostics_truncated";

export type HistoryDiagnosticScope =
  | "root"
  | "artifact"
  | "job"
  | "index"
  | "mutation";

/** Diagnostics deliberately carry no transcript body, exception text, or query.
 * `count` aggregates identical facts so stale historical rows cannot make one
 * bounded command emit thousands of duplicate diagnostics. */
export interface HistoryDiagnostic {
  code: HistoryDiagnosticCode;
  harness: HistoryHarness | null;
  scope: HistoryDiagnosticScope;
  count?: number;
}

export const HISTORY_DIAGNOSTIC_GROUP_MAX = 32;

export function aggregateHistoryDiagnostics(
  diagnostics: readonly HistoryDiagnostic[],
  maxGroups = HISTORY_DIAGNOSTIC_GROUP_MAX,
): HistoryDiagnostic[] {
  const grouped = new Map<string, HistoryDiagnostic>();
  for (const diagnostic of diagnostics) {
    const harness =
      diagnostic.harness === "claude" || diagnostic.harness === "pi"
        ? diagnostic.harness
        : null;
    const count =
      Number.isInteger(diagnostic.count) && (diagnostic.count ?? 0) > 0
        ? (diagnostic.count as number)
        : 1;
    const key = `${diagnostic.code}\0${harness ?? ""}\0${diagnostic.scope}`;
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, { ...diagnostic, harness, count });
    } else {
      existing.count = (existing.count ?? 1) + count;
    }
  }
  const ordered = [...grouped.values()].sort(
    (a, b) =>
      a.code.localeCompare(b.code) ||
      (a.harness ?? "").localeCompare(b.harness ?? "") ||
      a.scope.localeCompare(b.scope),
  );
  const cap = Math.max(1, Math.trunc(maxGroups));
  if (ordered.length <= cap) return ordered;
  const kept = ordered.slice(0, cap - 1);
  const omitted = ordered
    .slice(cap - 1)
    .reduce((sum, diagnostic) => sum + (diagnostic.count ?? 1), 0);
  kept.push({
    code: "diagnostics_truncated",
    harness: null,
    scope: "index",
    count: omitted,
  });
  return kept;
}

export interface SessionCatalog {
  sessions: CatalogSession[];
  diagnostics: HistoryDiagnostic[];
  /** Harness scans known to be complete enough for deletion reconciliation. */
  authoritativeHarnesses: HistoryHarness[];
}

export type SessionReferenceMatch =
  | "qualified_native_id"
  | "job_id"
  | "native_id"
  | "title";

export interface SessionResolutionCandidate {
  sessionKey: string;
  harness: HistoryHarness;
  nativeId: string;
  qualifiedNativeId: string;
  project: string | null;
  currentTitle: string | null;
  jobIds: string[];
  artifactPath: string | null;
}

export type SessionResolution =
  | {
      kind: "resolved";
      match: SessionReferenceMatch;
      session: CatalogSession;
    }
  | {
      kind: "ambiguous";
      match: SessionReferenceMatch;
      candidates: SessionResolutionCandidate[];
    }
  | { kind: "not_found" };

export interface HistoryContextHandle {
  sessionKey: string;
  sourceKey: string;
  source: TranscriptSource;
  sourceOrdinal: number;
  nativeEntryId: string | null;
  parentNativeEntryId: string | null;
}

export type HistorySearchMode = "literal" | "advanced";

export interface HistorySearchFilters {
  sessionKeys?: readonly string[];
  harnesses?: readonly HistoryHarness[];
  projects?: readonly string[];
  roles?: readonly TranscriptRole[];
  sources?: readonly TranscriptSource[];
  sinceMs?: number | null;
  untilMs?: number | null;
}

export interface HistorySearchQuery {
  text: string;
  mode?: HistorySearchMode;
  filters?: HistorySearchFilters;
  offset?: number;
  limit?: number;
}

export interface HistorySearchHit {
  entryId: number;
  sessionKey: string;
  harness: HistoryHarness;
  nativeId: string;
  project: string | null;
  title: string | null;
  role: TranscriptRole;
  kind: TranscriptEntryKind;
  source: TranscriptSource;
  timestamp: string | null;
  timestampMs: number | null;
  body: string;
  score: number;
  context: HistoryContextHandle;
}

export type HistorySearchResult =
  | {
      kind: "ok";
      hits: HistorySearchHit[];
      total: number;
      offset: number;
      nextOffset: number | null;
    }
  | {
      kind: "invalid_query";
      code: "empty_query" | "query_too_long" | "invalid_fts_query";
      message: string;
    };

export type FileEvidenceGrade =
  | "observed_mutation"
  | "possible_mutation"
  | "mention";

export type FileEvidenceSource =
  | "canonical_mutation"
  | "successful_tool"
  | "shell_inference"
  | "tool_reference"
  | "transcript_text";

export interface FileEvidenceProvenance {
  source: FileEvidenceSource;
  context: HistoryContextHandle | null;
}

export interface FileEvidence {
  path: string;
  grade: FileEvidenceGrade;
  provenance: FileEvidenceProvenance[];
}

/** Already-canonical successful mutation evidence supplied by Keeper events. */
export interface CanonicalMutationFact {
  path: string;
  context?: HistoryContextHandle | null;
}

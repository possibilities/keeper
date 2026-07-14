import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  claudeTranscriptReader,
  readClaudeTitleHistory,
} from "../transcript/claude";
import { piTranscriptReader, readPiTitleHistory } from "../transcript/pi";
import type {
  TranscriptReader,
  TranscriptRootInputs,
} from "../transcript/reader";
import {
  aggregateHistoryDiagnostics,
  type CatalogSession,
  HISTORY_HARNESSES,
  type HistoryDiagnostic,
  type HistoryHarness,
  isHistoryHarness,
  type KeeperJobAlias,
  type KeeperJobRowLike,
  type NativeSessionArtifact,
  type SessionCatalog,
  type SessionTitleRecord,
} from "./model";
import type { HistoryCatalogCacheEntry } from "./catalog-cache";
import { historySourceStat } from "./source-stat";

// Transcript readers already enumerate and sort the complete candidate set per
// call. A large bounded page avoids re-walking every project directory for each
// 256-row chunk while retaining a progress guard for truly enormous corpora.
const DISCOVERY_PAGE_SIZE = 100_000;
const JOB_ID_MAX_CHARS = 512;
const JOB_PATH_MAX_CHARS = 4_096;
const JOB_TITLE_MAX_CHARS = 16_384;
const JOB_TITLE_HISTORY_MAX = 1_000;

export interface HistoryCatalogDiscovery {
  artifacts: NativeSessionArtifact[];
  diagnostics: HistoryDiagnostic[];
  authoritative: boolean;
}

/** Catalog discovery is an adapter contract, not a launch-harness switch. */
export interface HistoryCatalogAdapter {
  readonly harness: HistoryHarness;
  discover(
    root: TranscriptRootInputs,
    titleCache?: ReadonlyMap<string, HistoryCatalogCacheEntry>,
    options?: { completeTitleHistory: boolean },
  ): HistoryCatalogDiscovery;
}

function readerAdapter(
  harness: HistoryHarness,
  reader: TranscriptReader,
  readTitleHistory: (path: string) => string[],
): HistoryCatalogAdapter {
  return {
    harness,
    discover(root, titleCache, options) {
      const artifacts: NativeSessionArtifact[] = [];
      const diagnostics: HistoryDiagnostic[] = [];
      let offset = 0;
      for (;;) {
        const page = reader.list({
          root,
          project: null,
          sinceMs: null,
          untilMs: null,
          offset,
          limit: DISCOVERY_PAGE_SIZE,
          metadataOnly: true,
        });
        if (page.kind === "no_roots") {
          return {
            artifacts: [],
            diagnostics: [{ code: "root_unavailable", harness, scope: "root" }],
            authoritative: false,
          };
        }
        if (page.kind === "error") {
          return {
            artifacts,
            diagnostics: [
              ...diagnostics,
              { code: "root_read_failed", harness, scope: "root" },
            ],
            authoritative: false,
          };
        }
        for (const item of page.items) {
          let titleHistory = item.titleHistory;
          let currentTitle = item.title;
          let titleHistoryComplete = false;
          const cached = titleCache?.get(canonicalArtifactPath(item.path));
          const stat = cached === undefined ? null : historySourceStat(item.path);
          if (
            cached !== undefined &&
            cached.harness === harness &&
            cached.nativeId === item.sessionId &&
            stat?.statFingerprint === cached.statFingerprint
          ) {
            titleHistory = [...cached.titleHistory];
            currentTitle = cached.currentTitle;
            titleHistoryComplete = true;
          } else if (options?.completeTitleHistory !== false) {
            try {
              // The list reader samples large files for display metadata.
              // Catalog resolution needs every rename, so scan only title
              // records. The title readers prefilter lines before JSON parsing.
              titleHistory = readTitleHistory(item.path);
              currentTitle = titleHistory.at(-1) ?? item.title;
              titleHistoryComplete = true;
            } catch {
              diagnostics.push({
                code: "artifact_read_failed",
                harness,
                scope: "artifact",
              });
            }
          }
          artifacts.push({
            harness,
            nativeId: item.sessionId,
            path: item.path,
            project: item.project,
            currentTitle: currentTitle ?? titleHistory.at(-1) ?? item.title,
            titleHistory: [...titleHistory],
            titleHistoryComplete,
            startedAt: item.startedAt,
            updatedAt: item.updatedAt,
            bytes: item.bytes,
          });
        }
        if (page.nextOffset === null) {
          return { artifacts, diagnostics, authoritative: true };
        }
        // A malformed adapter must not trap discovery in an unbounded loop.
        if (page.nextOffset <= offset) {
          return {
            artifacts,
            diagnostics: [
              ...diagnostics,
              { code: "root_read_failed", harness, scope: "root" },
            ],
            authoritative: false,
          };
        }
        offset = page.nextOffset;
      }
    },
  };
}

/** The history membership root is deliberately Claude + Pi only. */
export const DEFAULT_HISTORY_CATALOG_ADAPTERS: readonly HistoryCatalogAdapter[] =
  [
    readerAdapter("claude", claudeTranscriptReader, readClaudeTitleHistory),
    readerAdapter("pi", piTranscriptReader, readPiTitleHistory),
  ];

function canonicalArtifactPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function artifactSessionKey(artifact: NativeSessionArtifact): string {
  const pathHash = createHash("sha256")
    .update(canonicalArtifactPath(artifact.path))
    .digest("hex");
  return `${artifact.harness}:${artifact.nativeId}@${pathHash}`;
}

function jobOnlySessionKey(job: KeeperJobAlias): string {
  return `${job.harness}:${job.nativeId}@job-only`;
}

function qualifiedNativeId(harness: HistoryHarness, nativeId: string): string {
  return `${harness}:${nativeId}`;
}

function nonEmptyString(
  value: unknown,
  maxChars = Number.MAX_SAFE_INTEGER,
): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxChars
    ? value
    : null;
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseNameHistory(value: unknown): string[] {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, JOB_TITLE_HISTORY_MAX).flatMap((item) => {
    const title = nonEmptyString(item, JOB_TITLE_MAX_CHARS);
    return title === null ? [] : [title];
  });
}

export type KeeperJobRowAdaptation =
  | { kind: "ok"; job: KeeperJobAlias }
  | {
      kind: "ignored";
      diagnostic: HistoryDiagnostic;
    };

/** Adapt the current jobs projection shape without giving the catalog a DB edge. */
export function keeperJobAliasFromRow(
  row: KeeperJobRowLike,
): KeeperJobRowAdaptation {
  const jobId = nonEmptyString(row.job_id, JOB_ID_MAX_CHARS);
  const rawHarness = nonEmptyString(row.harness) ?? "claude";
  if (!isHistoryHarness(rawHarness)) {
    return {
      kind: "ignored",
      diagnostic: {
        code: "unsupported_job_harness",
        harness: null,
        scope: "job",
      },
    };
  }
  if (jobId === null) {
    return {
      kind: "ignored",
      diagnostic: {
        code: "job_missing_native_id",
        harness: rawHarness,
        scope: "job",
      },
    };
  }
  const nativeId =
    nonEmptyString(row.resume_target, JOB_ID_MAX_CHARS) ??
    (rawHarness === "claude" ? jobId : null);
  if (nativeId === null) {
    return {
      kind: "ignored",
      diagnostic: {
        code: "job_missing_native_id",
        harness: rawHarness,
        scope: "job",
      },
    };
  }
  const createdSeconds = finiteNumber(row.created_at);
  const updatedSeconds = finiteNumber(row.updated_at);
  const pid = finiteNumber(row.pid);
  return {
    kind: "ok",
    job: {
      jobId,
      harness: rawHarness,
      nativeId,
      transcriptPath: nonEmptyString(row.transcript_path, JOB_PATH_MAX_CHARS),
      project: nonEmptyString(row.cwd, JOB_PATH_MAX_CHARS),
      currentTitle: nonEmptyString(row.title, JOB_TITLE_MAX_CHARS),
      titleHistory: parseNameHistory(row.name_history),
      state: nonEmptyString(row.state, 128),
      createdAtMs: createdSeconds === null ? null : createdSeconds * 1000,
      updatedAtMs: updatedSeconds === null ? null : updatedSeconds * 1000,
      pid: pid === null ? null : Math.trunc(pid),
      startTime: nonEmptyString(row.start_time, 512),
    },
  };
}

export function adaptKeeperJobRows(rows: readonly KeeperJobRowLike[]): {
  jobs: KeeperJobAlias[];
  diagnostics: HistoryDiagnostic[];
} {
  const jobs: KeeperJobAlias[] = [];
  const diagnostics: HistoryDiagnostic[] = [];
  for (const row of rows) {
    const adapted = keeperJobAliasFromRow(row);
    if (adapted.kind === "ok") jobs.push(adapted.job);
    else diagnostics.push(adapted.diagnostic);
  }
  return { jobs, diagnostics: aggregateHistoryDiagnostics(diagnostics) };
}

interface MutableCatalogSession extends CatalogSession {
  titleRecords: SessionTitleRecord[];
  jobs: KeeperJobAlias[];
}

function pushTitleHistory(
  records: SessionTitleRecord[],
  history: readonly string[],
  currentTitle: string | null,
  source: "native" | "keeper_job",
  jobId: string | null,
): void {
  for (let ordinal = 0; ordinal < history.length; ordinal++) {
    const title = history[ordinal];
    if (typeof title !== "string" || title.length === 0) continue;
    records.push({
      title,
      source,
      current: false,
      jobId,
      ordinal,
    });
  }
  if (currentTitle === null) return;
  const tail = records.at(-1);
  if (
    tail?.source === source &&
    tail.jobId === jobId &&
    tail.title === currentTitle
  ) {
    tail.current = true;
    return;
  }
  records.push({
    title: currentTitle,
    source,
    current: true,
    jobId,
    ordinal: history.length,
  });
}

function isoFromMs(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

function newestJob(jobs: readonly KeeperJobAlias[]): KeeperJobAlias | null {
  return (
    [...jobs].sort(
      (a, b) =>
        (b.updatedAtMs ?? b.createdAtMs ?? -1) -
          (a.updatedAtMs ?? a.createdAtMs ?? -1) ||
        a.jobId.localeCompare(b.jobId),
    )[0] ?? null
  );
}

function finalizeSession(session: MutableCatalogSession): CatalogSession {
  session.jobs.sort((a, b) => a.jobId.localeCompare(b.jobId));
  const latestJob = newestJob(session.jobs);
  if (session.artifact === null) {
    session.project = latestJob?.project ?? null;
    session.currentTitle = latestJob?.currentTitle ?? null;
    session.startedAt = isoFromMs(latestJob?.createdAtMs ?? null);
    session.updatedAt = isoFromMs(latestJob?.updatedAtMs ?? null);
  } else {
    if (session.project === null) session.project = latestJob?.project ?? null;
    if (
      session.currentTitle === null ||
      (!session.titleHistoryComplete && latestJob?.currentTitle != null)
    ) {
      session.currentTitle = latestJob?.currentTitle ?? session.currentTitle;
    }
    if (session.startedAt === null) {
      session.startedAt = isoFromMs(latestJob?.createdAtMs ?? null);
    }
    if (session.updatedAt === null) {
      session.updatedAt = isoFromMs(latestJob?.updatedAtMs ?? null);
    }
  }
  for (const job of session.jobs) {
    pushTitleHistory(
      session.titleRecords,
      job.titleHistory,
      job.currentTitle,
      "keeper_job",
      job.jobId,
    );
  }
  const seen = new Set<string>();
  session.titles = [];
  for (const record of session.titleRecords) {
    if (!seen.has(record.title)) {
      seen.add(record.title);
      session.titles.push(record.title);
    }
  }
  return session;
}

function selectJobArtifacts(
  job: KeeperJobAlias,
  candidates: readonly MutableCatalogSession[],
): MutableCatalogSession[] {
  if (candidates.length <= 1) return [...candidates];
  if (job.transcriptPath !== null) {
    const jobPath = canonicalArtifactPath(job.transcriptPath);
    const byPath = candidates.filter(
      (candidate) =>
        candidate.artifact !== null &&
        canonicalArtifactPath(candidate.artifact.path) === jobPath,
    );
    if (byPath.length > 0) return byPath;
  }
  if (job.project !== null) {
    const byProject = candidates.filter(
      (candidate) => candidate.project === job.project,
    );
    if (byProject.length === 1) return byProject;
  }
  // The alias itself is ambiguous; attach it to every exact native-id artifact
  // so exact job-id resolution reports candidates rather than guessing newest.
  return [...candidates];
}

export function buildSessionCatalog(
  artifacts: readonly NativeSessionArtifact[],
  jobs: readonly KeeperJobAlias[] = [],
  options: {
    diagnostics?: readonly HistoryDiagnostic[];
    authoritativeHarnesses?: readonly HistoryHarness[];
  } = {},
): SessionCatalog {
  const sessions = new Map<string, MutableCatalogSession>();
  const byNative = new Map<string, MutableCatalogSession[]>();
  const seenArtifactPaths = new Set<string>();

  for (const artifact of [...artifacts].sort(
    (a, b) =>
      a.harness.localeCompare(b.harness) ||
      a.nativeId.localeCompare(b.nativeId) ||
      a.path.localeCompare(b.path),
  )) {
    const canonicalPath = canonicalArtifactPath(artifact.path);
    const artifactDedupe = `${artifact.harness}\0${canonicalPath}`;
    if (seenArtifactPaths.has(artifactDedupe)) continue;
    seenArtifactPaths.add(artifactDedupe);
    const canonicalArtifact = { ...artifact, path: canonicalPath };
    const sessionKey = artifactSessionKey(canonicalArtifact);
    const titleRecords: SessionTitleRecord[] = [];
    pushTitleHistory(
      titleRecords,
      artifact.titleHistory,
      artifact.currentTitle,
      "native",
      null,
    );
    const session: MutableCatalogSession = {
      sessionKey,
      harness: artifact.harness,
      nativeId: artifact.nativeId,
      qualifiedNativeId: qualifiedNativeId(artifact.harness, artifact.nativeId),
      artifact: { path: canonicalPath, bytes: artifact.bytes },
      project: artifact.project,
      currentTitle: artifact.currentTitle,
      titleRecords,
      titles: [],
      titleHistoryComplete: artifact.titleHistoryComplete !== false,
      jobs: [],
      startedAt: artifact.startedAt,
      updatedAt: artifact.updatedAt,
    };
    sessions.set(sessionKey, session);
    const nativeKey = `${artifact.harness}\0${artifact.nativeId}`;
    const group = byNative.get(nativeKey) ?? [];
    group.push(session);
    byNative.set(nativeKey, group);
  }

  for (const job of [...jobs].sort((a, b) => a.jobId.localeCompare(b.jobId))) {
    const nativeKey = `${job.harness}\0${job.nativeId}`;
    const nativeCandidates = byNative.get(nativeKey) ?? [];
    const selected = selectJobArtifacts(job, nativeCandidates);
    if (selected.length > 0) {
      for (const session of selected) session.jobs.push(job);
      continue;
    }
    const sessionKey = jobOnlySessionKey(job);
    let session = sessions.get(sessionKey);
    if (session === undefined) {
      session = {
        sessionKey,
        harness: job.harness,
        nativeId: job.nativeId,
        qualifiedNativeId: qualifiedNativeId(job.harness, job.nativeId),
        artifact: null,
        project: null,
        currentTitle: null,
        titleRecords: [],
        titles: [],
        titleHistoryComplete: false,
        jobs: [],
        startedAt: null,
        updatedAt: null,
      };
      sessions.set(sessionKey, session);
      byNative.set(nativeKey, [session]);
    }
    session.jobs.push(job);
  }

  const finalized = [...sessions.values()].map(finalizeSession);
  finalized.sort((a, b) => {
    const aUpdated = a.updatedAt === null ? -1 : Date.parse(a.updatedAt);
    const bUpdated = b.updatedAt === null ? -1 : Date.parse(b.updatedAt);
    return bUpdated - aUpdated || a.sessionKey.localeCompare(b.sessionKey);
  });
  return {
    sessions: finalized,
    diagnostics: aggregateHistoryDiagnostics(options.diagnostics ?? []),
    authoritativeHarnesses: [
      ...(options.authoritativeHarnesses ?? HISTORY_HARNESSES),
    ].sort(),
  };
}

export function discoverSessionCatalog(options: {
  root: TranscriptRootInputs;
  jobs?: readonly KeeperJobAlias[];
  adapters?: readonly HistoryCatalogAdapter[];
  titleCache?: ReadonlyMap<string, HistoryCatalogCacheEntry>;
  completeTitleHistory?: boolean;
}): SessionCatalog {
  const artifacts: NativeSessionArtifact[] = [];
  const diagnostics: HistoryDiagnostic[] = [];
  const authoritativeHarnesses: HistoryHarness[] = [];
  for (const adapter of options.adapters ?? DEFAULT_HISTORY_CATALOG_ADAPTERS) {
    try {
      const discovered = adapter.discover(options.root, options.titleCache, {
        completeTitleHistory: options.completeTitleHistory !== false,
      });
      artifacts.push(...discovered.artifacts);
      diagnostics.push(...discovered.diagnostics);
      if (discovered.authoritative) {
        authoritativeHarnesses.push(adapter.harness);
      }
    } catch {
      diagnostics.push({
        code: "root_read_failed",
        harness: adapter.harness,
        scope: "root",
      });
    }
  }
  return buildSessionCatalog(artifacts, options.jobs ?? [], {
    diagnostics: aggregateHistoryDiagnostics(diagnostics),
    authoritativeHarnesses,
  });
}

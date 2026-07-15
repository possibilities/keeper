import type {
  CatalogSession,
  HistoryHarness,
  KeeperJobAlias,
  SessionCatalog,
  SessionReferenceMatch,
  SessionResolution,
  SessionResolutionCandidate,
} from "./model";
import { isHistoryHarness } from "./model";

export const SESSION_RESOLUTION_CANDIDATES_MAX = 20;
const SESSION_RESOLUTION_TEXT_MAX = 512;
const SESSION_RESOLUTION_JOB_IDS_MAX = 10;

export function parseQualifiedSessionReference(
  reference: string,
): { harness: HistoryHarness; nativeId: string } | null {
  const separator = reference.indexOf(":");
  if (separator <= 0) return null;
  const harness = reference.slice(0, separator);
  if (!isHistoryHarness(harness)) return null;
  // Accept the canonical `harness:id` form and the visually explicit
  // `harness::id` spelling while always emitting the former from the catalog.
  const rest = reference.slice(separator + 1);
  const nativeId = rest.startsWith(":") ? rest.slice(1) : rest;
  return nativeId.length === 0 ? null : { harness, nativeId };
}

function candidate(session: CatalogSession): SessionResolutionCandidate {
  return {
    sessionKey: session.sessionKey,
    harness: session.harness,
    nativeId: session.nativeId,
    qualifiedNativeId: session.qualifiedNativeId,
    project: session.project,
    currentTitle: session.currentTitle,
    jobIds: session.jobs.map((job) => job.jobId).sort(),
    artifactPath: session.artifact?.path ?? null,
  };
}

function compareSessionIdentity(a: CatalogSession, b: CatalogSession): number {
  return (
    a.harness.localeCompare(b.harness) ||
    a.nativeId.localeCompare(b.nativeId) ||
    (a.project ?? "").localeCompare(b.project ?? "") ||
    (a.artifact?.path ?? "").localeCompare(b.artifact?.path ?? "") ||
    a.sessionKey.localeCompare(b.sessionKey)
  );
}

function atTier(
  matches: readonly CatalogSession[],
  match: SessionReferenceMatch,
): SessionResolution {
  const distinct = [
    ...new Map(matches.map((item) => [item.sessionKey, item])).values(),
  ].sort(compareSessionIdentity);
  if (distinct.length === 1) {
    return { kind: "resolved", match, session: distinct[0] as CatalogSession };
  }
  return {
    kind: "ambiguous",
    match,
    candidates: distinct.map(candidate),
  };
}

/** Resolve one Session reference through the ADR-defined exact tiers. */
export function resolveSessionReference(
  catalog: SessionCatalog,
  reference: string,
): SessionResolution {
  const qualified = parseQualifiedSessionReference(reference);
  if (qualified !== null) {
    const matches = catalog.sessions.filter(
      (session) =>
        session.harness === qualified.harness &&
        session.nativeId === qualified.nativeId,
    );
    // An explicit qualifier owns the interpretation; never reinterpret a miss as
    // a job id or title that merely contains a colon.
    return matches.length === 0
      ? { kind: "not_found" }
      : atTier(matches, "qualified_native_id");
  }

  const byJobId = catalog.sessions.filter((session) =>
    session.jobs.some((job) => job.jobId === reference),
  );
  if (byJobId.length > 0) return atTier(byJobId, "job_id");

  // A bare native id is authoritative only when native discovery supplies its
  // artifact. An artifact-less job may carry an attempted/stale
  // `resume_target`; allowing that unverified alias to own this tier can shadow
  // an exact title of a real Session forever. Explicit `harness:id` and exact
  // job-id references still resolve artifact-less jobs and surface the honest
  // missing-artifact capability error.
  const byNativeId = catalog.sessions.filter(
    (session) => session.artifact !== null && session.nativeId === reference,
  );
  if (byNativeId.length > 0) return atTier(byNativeId, "native_id");

  const folded = reference.toLowerCase();
  const byTitle = catalog.sessions.filter((session) =>
    session.titles.some((title) => title.toLowerCase() === folded),
  );
  if (byTitle.length > 0) return atTier(byTitle, "title");

  return { kind: "not_found" };
}

export interface TrackedJobResolutionCandidate {
  jobId: string;
  harness: HistoryHarness;
  nativeId: string;
  project: string | null;
  currentTitle: string | null;
  state: string | null;
  updatedAtMs: number | null;
}

/** A Session-first resolution for readers whose payload is keyed by one Keeper
 * job. A native artifact is valid Session history even with no job; that honest
 * capability boundary is `not_tracked`, never `not_found`. */
export type TrackedSessionResolution =
  | {
      kind: "resolved";
      match: SessionReferenceMatch;
      session: CatalogSession;
      job: KeeperJobAlias;
    }
  | { kind: "not_found" }
  | {
      kind: "session_ambiguous";
      match: SessionReferenceMatch;
      candidates: SessionResolutionCandidate[];
    }
  | { kind: "not_tracked"; session: CatalogSession }
  | { kind: "keeper_jobs_unavailable"; session: CatalogSession | null }
  | {
      kind: "job_ambiguous";
      match: SessionReferenceMatch;
      session: CatalogSession;
      candidates: TrackedJobResolutionCandidate[];
    };

function jobsUnavailable(catalog: SessionCatalog): boolean {
  return catalog.diagnostics.some(
    (diagnostic) => diagnostic.code === "keeper_jobs_unavailable",
  );
}

function trackedJobCandidate(
  job: KeeperJobAlias,
): TrackedJobResolutionCandidate {
  return {
    jobId: job.jobId,
    harness: job.harness,
    nativeId: job.nativeId,
    project: job.project,
    currentTitle: job.currentTitle,
    state: job.state,
    updatedAtMs: job.updatedAtMs,
  };
}

/** Resolve a shared Session reference and then require exactly one associated
 * Keeper job. An exact job-id tier narrows a multi-job Session; every other
 * multi-job match remains visible rather than collapsing by recency/liveness. */
export function resolveTrackedSessionReference(
  catalog: SessionCatalog,
  reference: string,
  options: { jobId?: string } = {},
): TrackedSessionResolution {
  let resolution = resolveSessionReference(catalog, reference);
  if (resolution.kind === "not_found") {
    return jobsUnavailable(catalog)
      ? { kind: "keeper_jobs_unavailable", session: null }
      : { kind: "not_found" };
  }
  if (resolution.kind === "ambiguous") {
    if (options.jobId !== undefined) {
      const candidateKeys = new Set(
        resolution.candidates.map((item) => item.sessionKey),
      );
      const narrowed = catalog.sessions.filter(
        (session) =>
          candidateKeys.has(session.sessionKey) &&
          session.jobs.some((job) => job.jobId === options.jobId),
      );
      if (narrowed.length === 0) return { kind: "not_found" };
      if (narrowed.length === 1) {
        resolution = {
          kind: "resolved",
          match: resolution.match,
          session: narrowed[0] as CatalogSession,
        };
      } else {
        return {
          kind: "session_ambiguous",
          match: resolution.match,
          candidates: narrowed.map(candidate),
        };
      }
    } else {
      return {
        kind: "session_ambiguous",
        match: resolution.match,
        candidates: resolution.candidates,
      };
    }
  }

  const { session } = resolution;
  if (session.jobs.length === 0) {
    return jobsUnavailable(catalog)
      ? { kind: "keeper_jobs_unavailable", session }
      : { kind: "not_tracked", session };
  }

  if (resolution.match === "job_id") {
    const exact = session.jobs.filter((job) => job.jobId === reference);
    if (exact.length === 1) {
      if (options.jobId !== undefined && options.jobId !== reference) {
        return { kind: "not_found" };
      }
      return {
        kind: "resolved",
        match: resolution.match,
        session,
        job: exact[0] as KeeperJobAlias,
      };
    }
  }

  if (options.jobId !== undefined) {
    const narrowed = session.jobs.filter((job) => job.jobId === options.jobId);
    if (narrowed.length === 0) return { kind: "not_found" };
    return {
      kind: "resolved",
      match: resolution.match,
      session,
      job: narrowed[0] as KeeperJobAlias,
    };
  }

  if (session.jobs.length === 1) {
    return {
      kind: "resolved",
      match: resolution.match,
      session,
      job: session.jobs[0] as KeeperJobAlias,
    };
  }
  return {
    kind: "job_ambiguous",
    match: resolution.match,
    session,
    candidates: session.jobs.map(trackedJobCandidate),
  };
}

function boundedText(value: string | null): string | null {
  if (value === null || value.length <= SESSION_RESOLUTION_TEXT_MAX)
    return value;
  return value.slice(0, SESSION_RESOLUTION_TEXT_MAX);
}

function publicSessionCandidate(candidate: SessionResolutionCandidate) {
  const jobIds = candidate.jobIds.slice(0, SESSION_RESOLUTION_JOB_IDS_MAX);
  return {
    session_key: boundedText(candidate.sessionKey),
    harness: candidate.harness,
    native_id: boundedText(candidate.nativeId),
    qualified_id: boundedText(candidate.qualifiedNativeId),
    project: boundedText(candidate.project),
    current_title: boundedText(candidate.currentTitle),
    job_ids: jobIds.map((jobId) => boundedText(jobId)),
    job_count: candidate.jobIds.length,
    job_ids_truncated: jobIds.length < candidate.jobIds.length,
    artifact_path: boundedText(candidate.artifactPath),
  };
}

/** Bounded, wire-ready metadata shared by every Session ambiguity envelope. */
export function sessionAmbiguityDetails(
  match: SessionReferenceMatch,
  candidates: readonly SessionResolutionCandidate[],
): Record<string, unknown> {
  const shown = candidates.slice(0, SESSION_RESOLUTION_CANDIDATES_MAX);
  return {
    match,
    candidate_count: candidates.length,
    candidates_truncated: shown.length < candidates.length,
    candidates: shown.map(publicSessionCandidate),
  };
}

/** Bounded, wire-ready metadata shared by every associated-job ambiguity. */
export function jobAmbiguityDetails(
  match: SessionReferenceMatch,
  candidates: readonly TrackedJobResolutionCandidate[],
): Record<string, unknown> {
  const shown = candidates.slice(0, SESSION_RESOLUTION_CANDIDATES_MAX);
  return {
    match,
    candidate_count: candidates.length,
    candidates_truncated: shown.length < candidates.length,
    candidates: shown.map((candidate) => ({
      job_id: boundedText(candidate.jobId),
      harness: candidate.harness,
      native_id: boundedText(candidate.nativeId),
      project: boundedText(candidate.project),
      current_title: boundedText(candidate.currentTitle),
      state: boundedText(candidate.state),
      updated_at_ms: candidate.updatedAtMs,
    })),
  };
}

/** Bounded locator for `not_tracked` and unavailable-job diagnostics. */
export function trackedSessionLocator(
  session: CatalogSession | null,
): Record<string, unknown> | null {
  if (session === null) return null;
  return {
    session_key: boundedText(session.sessionKey),
    harness: session.harness,
    native_id: boundedText(session.nativeId),
    qualified_id: boundedText(session.qualifiedNativeId),
    project: boundedText(session.project),
    current_title: boundedText(session.currentTitle),
    artifact_path: boundedText(session.artifact?.path ?? null),
  };
}

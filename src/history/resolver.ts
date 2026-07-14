import type {
  CatalogSession,
  HistoryHarness,
  SessionCatalog,
  SessionReferenceMatch,
  SessionResolution,
  SessionResolutionCandidate,
} from "./model";
import { isHistoryHarness } from "./model";

function parseQualifiedReference(
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
  const qualified = parseQualifiedReference(reference);
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

  const byNativeId = catalog.sessions.filter(
    (session) => session.nativeId === reference,
  );
  if (byNativeId.length > 0) return atTier(byNativeId, "native_id");

  const folded = reference.toLowerCase();
  const byTitle = catalog.sessions.filter((session) =>
    session.titles.some((title) => title.toLowerCase() === folded),
  );
  if (byTitle.length > 0) return atTier(byTitle, "title");

  return { kind: "not_found" };
}

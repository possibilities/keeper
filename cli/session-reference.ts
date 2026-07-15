import { homedir } from "node:os";
import { resolveDbPath } from "../src/db";
import type { HistoryCatalogAdapter } from "../src/history/catalog";
import { loadSessionCatalog } from "../src/history/load-catalog";
import type {
  HistoryDiagnostic,
  KeeperJobAlias,
  SessionCatalog,
} from "../src/history/model";
import {
  jobAmbiguityDetails,
  resolveTrackedSessionReference,
  sessionAmbiguityDetails,
  type TrackedSessionResolution,
  trackedSessionLocator,
} from "../src/history/resolver";
import { keeperStateDir } from "../src/keeper-state-dir";
import type { TranscriptRootInputs } from "../src/transcript/reader";
import type { ProblemError } from "./envelope";

export interface SessionReferenceCliDeps {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  dbPath?: string;
  stateDir?: string;
  catalog?: SessionCatalog;
  catalogAdapters?: readonly HistoryCatalogAdapter[];
  readKeeperJobs?: () => {
    jobs: KeeperJobAlias[];
    diagnostics: HistoryDiagnostic[];
  };
}

export type LoadedTrackedSessionResolution =
  | TrackedSessionResolution
  | { kind: "catalog_read_failed" };

/** One loader seam for every remaining Session-targeting command. Tests may
 * inject a catalog; production discovers native artifacts and optional aliases
 * through `loadSessionCatalog` rather than copying DB/title matching. */
export function loadCliSessionCatalog(
  deps: SessionReferenceCliDeps = {},
  options: {
    root?: TranscriptRootInputs;
    completeTitleHistory?: boolean;
  } = {},
): SessionCatalog {
  if (deps.catalog !== undefined) return deps.catalog;
  const homeDir = deps.homeDir ?? homedir();
  const env = deps.env ?? process.env;
  return loadSessionCatalog({
    root: options.root ?? { homeDir, env },
    dbPath: deps.dbPath ?? resolveDbPath(),
    stateDir: deps.stateDir ?? keeperStateDir(),
    adapters: deps.catalogAdapters,
    completeTitleHistory: options.completeTitleHistory ?? true,
    readKeeperJobs: deps.readKeeperJobs,
  });
}

export function resolveTrackedCliSession(
  reference: string,
  deps: SessionReferenceCliDeps = {},
  options: { jobId?: string } = {},
): LoadedTrackedSessionResolution {
  try {
    return resolveTrackedSessionReference(
      loadCliSessionCatalog(deps),
      reference,
      options,
    );
  } catch {
    return { kind: "catalog_read_failed" };
  }
}

/** Shared problem mapping. Every ambiguity carries the same bounded candidate
 * metadata, while a readable native-only Session remains distinct from a
 * missing/unreadable Keeper job store. */
export function trackedSessionProblem(
  resolution: Exclude<LoadedTrackedSessionResolution, { kind: "resolved" }>,
): ProblemError {
  switch (resolution.kind) {
    case "catalog_read_failed":
      return {
        code: "catalog_read_failed",
        message: "could not read the shared Session catalog",
        recovery:
          "Confirm native history roots and keeper.db are readable, then retry; this read never mutates state.",
      };
    case "keeper_jobs_unavailable":
      return {
        code: "keeper_jobs_unavailable",
        message: "the Keeper job store is unavailable for this Session read",
        recovery:
          "Restore or point KEEPER_DB at a readable keeper.db, then retry; native history remains available through `keeper history`.",
        details: { session: trackedSessionLocator(resolution.session) },
      };
    case "not_found":
      return {
        code: "session_not_found",
        message: "no Session matched the supplied reference",
        recovery:
          "Run `keeper history list --format json` and retry with a qualified native id, exact job id, or exact title.",
      };
    case "session_ambiguous":
      return {
        code: "session_ambiguous",
        message: "the supplied reference matches multiple Sessions",
        recovery:
          "Retry with a qualified native id and, when duplicate artifacts remain, a project-specific history/transcript selector.",
        details: sessionAmbiguityDetails(
          resolution.match,
          resolution.candidates,
        ),
      };
    case "not_tracked":
      return {
        code: "not_tracked",
        message: "the resolved Harness session is not tracked by a Keeper job",
        recovery:
          "Use `keeper history show` for native transcript history, or choose a Session with a Keeper job alias.",
        details: { session: trackedSessionLocator(resolution.session) },
      };
    case "job_ambiguous":
      return {
        code: "job_ambiguous",
        message:
          "the resolved Harness session is associated with multiple Keeper jobs",
        recovery:
          "Retry with one exact job id from error.details.candidates; Keeper will not choose the newest job.",
        details: jobAmbiguityDetails(resolution.match, resolution.candidates),
      };
  }
}

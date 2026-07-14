import { statSync } from "node:fs";
import { openDb } from "../db";
import type { TranscriptRootInputs } from "../transcript/reader";
import {
  adaptKeeperJobRows,
  discoverSessionCatalog,
  type HistoryCatalogAdapter,
} from "./catalog";
import { readHistoryCatalogCache } from "./catalog-cache";
import { resolveHistoryIndexPaths } from "./index-db";
import type {
  HistoryDiagnostic,
  KeeperJobAlias,
  KeeperJobRowLike,
  SessionCatalog,
} from "./model";
import { aggregateHistoryDiagnostics } from "./model";

export interface KeeperJobAliasRead {
  jobs: KeeperJobAlias[];
  diagnostics: HistoryDiagnostic[];
}

/** Read the narrow jobs projection consumed by the Session catalog. A missing
 * database is an honest metadata-coverage diagnostic; an existing unreadable or
 * incompatible database throws so callers never silently resolve without aliases. */
export function readKeeperJobAliases(dbPath: string): KeeperJobAliasRead {
  try {
    if (!statSync(dbPath).isFile()) {
      throw new Error("keeper database is not a file");
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return {
        jobs: [],
        diagnostics: [
          { code: "keeper_jobs_unavailable", harness: null, scope: "job" },
        ],
      };
    }
    throw error;
  }

  const { db } = openDb(dbPath, { readonly: true, prepareStmts: false });
  try {
    const rows = db
      .query(`SELECT job_id, harness, resume_target, transcript_path, cwd,
                     title, name_history, state, created_at, updated_at,
                     pid, start_time
                FROM jobs`)
      .all() as KeeperJobRowLike[];
    return adaptKeeperJobRows(rows);
  } finally {
    db.close();
  }
}

export interface LoadSessionCatalogOptions {
  root: TranscriptRootInputs;
  dbPath: string;
  stateDir: string;
  adapters?: readonly HistoryCatalogAdapter[];
  completeTitleHistory?: boolean;
  readKeeperJobs?: () => KeeperJobAliasRead;
}

/** Discover the shared Session catalog with optional Keeper aliases and the
 * disposable title cache. Native artifacts remain authoritative. */
export function loadSessionCatalog(
  options: LoadSessionCatalogOptions,
): SessionCatalog {
  const loaded =
    options.readKeeperJobs?.() ?? readKeeperJobAliases(options.dbPath);
  let titleCache: ReturnType<typeof readHistoryCatalogCache> | undefined;
  try {
    titleCache = readHistoryCatalogCache(
      resolveHistoryIndexPaths(options.stateDir),
    );
  } catch {
    // A cache miss or malformed disposable sidecar never masks native history.
  }
  const catalog = discoverSessionCatalog({
    root: options.root,
    jobs: loaded.jobs,
    adapters: options.adapters,
    titleCache,
    completeTitleHistory: options.completeTitleHistory,
  });
  return {
    ...catalog,
    diagnostics: aggregateHistoryDiagnostics([
      ...catalog.diagnostics,
      ...loaded.diagnostics,
    ]),
  };
}

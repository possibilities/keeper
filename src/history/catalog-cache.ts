import type { HistoryIndexPaths } from "./index-db";
import { openHistoryIndexReadOnly } from "./index-db";
import type { HistoryHarness } from "./model";

export interface HistoryCatalogCacheEntry {
  harness: HistoryHarness;
  nativeId: string;
  path: string;
  statFingerprint: string;
  currentTitle: string | null;
  titleHistory: string[];
}

function parseTitles(raw: string): string[] | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const titles: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) return null;
    titles.push(item);
  }
  return titles;
}

/** Read only native-main title metadata from a compatible History index. Any caller
 * treats failure as a cache miss; native artifacts remain authoritative. */
export function readHistoryCatalogCache(
  paths: HistoryIndexPaths,
): ReadonlyMap<string, HistoryCatalogCacheEntry> {
  const db = openHistoryIndexReadOnly(paths);
  try {
    const rows = db
      .query(`SELECT harness, native_id, artifact_path, stat_fingerprint,
                     artifact_title, artifact_title_history
                FROM sources
               WHERE transcript_source = 'main'
                 AND artifact_title_history_complete = 1
               ORDER BY artifact_path COLLATE BINARY`)
      .all() as Array<{
      harness: string;
      native_id: string;
      artifact_path: string;
      stat_fingerprint: string;
      artifact_title: string | null;
      artifact_title_history: string;
    }>;
    const cache = new Map<string, HistoryCatalogCacheEntry>();
    for (const row of rows) {
      if (row.harness !== "claude" && row.harness !== "pi") continue;
      const titleHistory = parseTitles(row.artifact_title_history);
      if (titleHistory === null) continue;
      cache.set(row.artifact_path, {
        harness: row.harness,
        nativeId: row.native_id,
        path: row.artifact_path,
        statFingerprint: row.stat_fingerprint,
        currentTitle:
          typeof row.artifact_title === "string" &&
          row.artifact_title.length > 0
            ? row.artifact_title
            : null,
        titleHistory,
      });
    }
    return cache;
  } finally {
    db.close();
  }
}

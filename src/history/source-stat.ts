import { createHash } from "node:crypto";
import { statSync } from "node:fs";

export interface HistorySourceStat {
  statFingerprint: string;
  size: number;
  mtimeMs: number;
}

/** Strong, metadata-only source identity shared by indexing and catalog-cache
 * reads. A cache hit never requires parsing transcript bodies, while inode,
 * size, mtime, and ctime changes all invalidate stale metadata. */
export function historySourceStat(path: string): HistorySourceStat | null {
  try {
    const stat = statSync(path, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    const parts = [
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
    ].map(String);
    return {
      statFingerprint: createHash("sha256")
        .update(parts.join(":"))
        .digest("hex"),
      size: Number(stat.size),
      mtimeMs: Number(stat.mtimeNs) / 1_000_000,
    };
  } catch {
    return null;
  }
}

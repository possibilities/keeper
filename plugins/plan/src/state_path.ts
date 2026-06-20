// Data-directory resolution — the single seam every read/write/detect site
// routes its data-dir lookup through.
//
// The data dir is `.keeper/` (DATA_DIR). Resolution, detection, and write-back
// all target it; a root with no `.keeper/` yet defaults to minting one on the
// first write (fresh `init`).

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/** The data-dir name — the fresh-init default and every read/write target. */
export const DATA_DIR = ".keeper";

/** The data-dir name(s) to scan / accept, in precedence order. The single
 * source of truth for every "find the data dir" call site. */
export const DATA_DIR_NAMES: readonly string[] = [DATA_DIR];

/** The `.keeper/` path under `root`. The write target and the fresh-init
 * default inside resolveDataDirOrDefault. */
function dataDirFor(root: string): string {
  return join(root, DATA_DIR);
}

/** True iff `p` exists and is a directory (following symlinks). */
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The existing data-dir path under `root`, or null when none exists. Use for
 * reads/detect. */
export function resolveDataDir(root: string): string | null {
  for (const name of DATA_DIR_NAMES) {
    const candidate = join(root, name);
    if (isDir(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** True iff `root` holds a data dir. The project-detection predicate. */
export function hasDataDir(root: string): boolean {
  return DATA_DIR_NAMES.some((name) => existsSync(join(root, name)));
}

/** The data-dir path a read OR write should target: the existing `.keeper/`, or
 * `.keeper/` as the fresh-tree default when none exists. Reads that need a
 * concrete path on an empty tree also use this; pure detection uses
 * resolveDataDir / hasDataDir. */
export function resolveDataDirOrDefault(root: string): string {
  return resolveDataDir(root) ?? dataDirFor(root);
}

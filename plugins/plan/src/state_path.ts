// Data-directory resolution — the single seam every read/write/detect site
// routes its data-dir lookup through.
//
// The convention dir is `.keeper/` (DATA_DIR). A transient fallback to
// `.planctl/` (LEGACY_DATA_DIR) keeps boards minted before the flag-day rename
// usable during the migration window; the fallback is removed once every repo
// has migrated.
//
// WRITE-BACK is the load-bearing invariant: a write (epic/task/state, plus the
// auto-commit scope) targets the dir the board ALREADY RESOLVES to via
// resolveDataDirOrDefault — `.keeper/` when present, else the legacy `.planctl/`
// — so a repo still on `.planctl/` keeps WRITING to `.planctl/`. Unconditional
// `.keeper/` (dataDirFor) is the default for ONE case only: a fresh `init` at a
// root where NEITHER dir exists. Forcing `.keeper/` on a legacy board would spawn
// a shadow dir that wins precedence and hides the live `.planctl/` board; the dir
// migration happens solely via the explicit `git mv .planctl .keeper` in the
// flag-day epic, NEVER via write-routing.
//
// Precedence is deterministic: when BOTH dirs exist at one root, `.keeper/`
// wins and `.planctl/` is ignored. A walk-up / detect that finds only the
// legacy dir resolves to it (read fallback).

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/** The convention data-dir name — the fresh-init default and the write target
 * once a board has migrated. */
export const DATA_DIR = ".keeper";

/** The transient fallback data-dir name. A board still on it resolves to it for
 * BOTH reads and writes (write-back); only a fresh `init` skips it. Removed in
 * the flag-day epic once every repo migrates. */
export const LEGACY_DATA_DIR = ".planctl";

/** Both data-dir names in precedence order (primary first). The single source
 * of truth for "scan / accept either dir" call sites. */
export const DATA_DIR_NAMES: readonly string[] = [DATA_DIR, LEGACY_DATA_DIR];

/** The unconditional `.keeper/` path under `root`, ignoring any existing dir.
 * Used ONLY as the fresh-init default inside resolveDataDirOrDefault — never call
 * it directly from a write path (that would force `.keeper/` onto a legacy board
 * and spawn a shadow dir). Writes go through resolveDataDirOrDefault. */
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

/** The existing data-dir path under `root`, preferring `.keeper/` then falling
 * back to `.planctl/`, or null when neither exists. Use for reads/detect — the
 * deterministic-precedence resolver (`.keeper/` wins when both exist). */
export function resolveDataDir(root: string): string | null {
  for (const name of DATA_DIR_NAMES) {
    const candidate = join(root, name);
    if (isDir(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** True iff `root` holds a data dir under either name. The project-detection
 * predicate (replaces a bare `existsSync(join(root, ".planctl"))`). */
export function hasDataDir(root: string): boolean {
  return DATA_DIR_NAMES.some((name) => existsSync(join(root, name)));
}

/** The data-dir path a read OR write should target: the existing dir (`.keeper/`
 * preferred, else legacy `.planctl/`), or `.keeper/` as the fresh-tree default
 * when neither exists. This is the write-back resolver — a write on a legacy
 * board lands in `.planctl/`, never a forced `.keeper/`. Reads that need a
 * concrete path on an empty tree also use this; pure detection uses
 * resolveDataDir / hasDataDir. */
export function resolveDataDirOrDefault(root: string): string {
  return resolveDataDir(root) ?? dataDirFor(root);
}

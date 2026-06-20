// Project resolution — the port of planctl/project.py.
//
// findGitRoot is a parent-walk for a `.git` entry (directory OR file, so a
// linked-worktree `.git` file counts), never honoring GIT_DIR. realpathSync
// matches Python's Path.resolve() symlink resolution (load-bearing on macOS,
// where the pytest tmp tree resolves /var -> /private/var). resolveProject
// hard-errors through emitError when no data dir (`.keeper/`, or the transient
// `.planctl/` fallback) is present.

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { emitError, type OutputFormat } from "./format.ts";
import { hasDataDir, resolveDataDirOrDefault } from "./state_path.ts";

export interface ProjectContext {
  name: string;
  dataDir: string;
  stateDir: string;
  projectPath: string;
}

/** Resolve `start` (default cwd) and return it; falls back to the raw path when
 * it does not yet exist on disk (realpathSync would throw). */
function resolveStart(start?: string): string {
  const base = start ?? process.cwd();
  try {
    return realpathSync(base);
  } catch {
    return base;
  }
}

/** Nearest ancestor of `start` holding a `.git` entry, or null. */
export function findGitRoot(start?: string): string | null {
  let candidate = resolveStart(start);
  while (true) {
    if (existsSync(join(candidate, ".git"))) {
      return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      return null;
    }
    candidate = parent;
  }
}

/** Git repo root, falling back to the resolved cwd. */
export function findProjectRoot(): string {
  return findGitRoot() ?? resolveStart();
}

/** Build a ProjectContext for `projectRoot`, resolving its data dir (`.keeper/`
 * with the transient `.planctl/` fallback). The shared root→context builder every
 * verb's local helper routes through, so the data-dir resolution lives in one
 * place. */
export function contextForRoot(projectRoot: string): ProjectContext {
  const dataDir = resolveDataDirOrDefault(projectRoot);
  return {
    name: basename(projectRoot),
    dataDir,
    stateDir: join(dataDir, "state"),
    projectPath: projectRoot,
  };
}

/** Resolve the current directory to a ProjectContext, erroring when no data dir
 * (`.keeper/`, or the transient `.planctl/` fallback) is present. `format`
 * selects the error envelope's serialization. */
export function resolveProject(format: OutputFormat | null): ProjectContext {
  const projectRoot = findProjectRoot();

  if (!hasDataDir(projectRoot)) {
    emitError("No planctl project found. Run 'planctl init' first.", format);
  }

  return contextForRoot(projectRoot);
}

/** Resolve a `--project` override to a validated project root for the read-only
 * trailer, mirroring the per-verb --project branch: the flag is expanded with
 * `expandUser` (tilde form) BEFORE the absolute check, so a `~/proj` form agrees
 * with the verb. An absolute path whose data dir exists resolves to its
 * realpath; anything else (unset, relative, or not a project) returns null so the
 * caller falls back to cwd resolution. Trailer-only — it never errors, since the
 * verb already validated the flag. */
export function trailerProjectRoot(project: string | null): string | null {
  if (project === null) {
    return null;
  }
  const expanded = expandUser(project);
  if (!isAbsolute(expanded)) {
    return null;
  }
  let root: string;
  try {
    root = realpathSync(expanded);
  } catch {
    root = expanded;
  }
  return hasDataDir(root) ? root : null;
}

/** Expand a leading `~` / `~/` to $HOME, matching the verb's --project branch. */
function expandUser(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return (process.env.HOME ?? "") + p.slice(1);
  }
  return p;
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path;
}

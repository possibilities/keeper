// Project resolution — the port of planctl/project.py.
//
// findGitRoot is a parent-walk for a `.git` entry (directory OR file, so a
// linked-worktree `.git` file counts), never honoring GIT_DIR. realpathSync
// matches Python's Path.resolve() symlink resolution (load-bearing on macOS,
// where the pytest tmp tree resolves /var -> /private/var). resolveProject
// hard-errors through emitError when `.planctl/` is absent.

import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { emitError, type OutputFormat } from "./format.ts";

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

/** Resolve the current directory to a ProjectContext, erroring when `.planctl/`
 * is absent. `format` selects the error envelope's serialization. */
export function resolveProject(format: OutputFormat | null): ProjectContext {
  const projectRoot = findProjectRoot();
  const planctlDir = join(projectRoot, ".planctl");

  if (!existsSync(planctlDir)) {
    emitError("No planctl project found. Run 'planctl init' first.", format);
  }

  return {
    name: basename(projectRoot),
    dataDir: planctlDir,
    stateDir: join(planctlDir, "state"),
    projectPath: projectRoot,
  };
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path;
}

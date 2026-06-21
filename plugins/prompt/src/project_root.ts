// Corpus-root resolution for `keeper prompt`. The snippet/bundle corpus lives in
// the arthack source repo (claude/arthack/template/_partials/); the keeper engine
// resolves it the way the Python promptctl did — walk up from cwd to the nearest
// `.git` root, falling back to `~/code/arthack` when cwd is not inside a repo.
//
// The fallback mirrors the claudectl AGENTWRAP default home: an agent running a
// `keeper prompt render` from any worktree still finds the corpus.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Walk up from `start` to the nearest ancestor holding a `.git` entry. Returns
 * the absolute root, or null when no ancestor is a repo (the filesystem root is
 * reached without a hit). Mirrors helpers.py find_project_root. */
export function findGitRoot(start: string): string | null {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/** The home fallback corpus root: `~/code/arthack`. */
export function fallbackCorpusRoot(): string {
  return join(homedir(), "code", "arthack");
}

/** Resolve the corpus project root: an explicit `--project-root` wins; else walk
 * up from `cwd` to the `.git` root; else fall back to `~/code/arthack`. The
 * returned path is absolute and resolved but not asserted to exist — callers that
 * read corpus files surface their own missing-file errors. */
export function resolveProjectRoot(
  explicit: string | null,
  cwd: string = process.cwd(),
): string {
  if (explicit) {
    return resolve(explicit);
  }
  return findGitRoot(cwd) ?? fallbackCorpusRoot();
}

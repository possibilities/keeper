// Corpus-root resolution for `keeper prompt`. The snippet/bundle corpus lives at
// `claude/arthack/template/_partials/` — historically in the arthack source repo,
// not keeper's. Resolution walks up from cwd to the nearest `.git` root, but that
// root only wins when it actually holds a corpus; otherwise it falls back to the
// configured authoring home so `keeper prompt render` resolves from any repo
// (notably keeper's own root, which carries no corpus).
//
// The fallback home is config-driven via `KEEPER_PROMPT_CORPUS_ROOT` so a vendored
// corpus can become the primary source without another engine change; it defaults
// to `~/code/arthack` (the claudectl default home).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Corpus marker relative to a project root: the partials dir every render reads
 * from. A root without it holds no corpus and cannot serve renders. */
const CORPUS_MARKER = ["claude", "arthack", "template", "_partials"];

/** True when `root` holds the snippet/bundle corpus (its `_partials` dir). */
export function hasCorpus(root: string): boolean {
  return existsSync(join(root, ...CORPUS_MARKER));
}

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

/** The config-driven home fallback corpus root: `KEEPER_PROMPT_CORPUS_ROOT` when
 * set, else `~/code/arthack`. */
export function fallbackCorpusRoot(): string {
  const configured = process.env.KEEPER_PROMPT_CORPUS_ROOT?.trim();
  if (configured) {
    return resolve(configured);
  }
  return join(homedir(), "code", "arthack");
}

/** Resolve the corpus project root: an explicit `--project-root` wins outright;
 * else walk up from `cwd` to the `.git` root and use it ONLY when it holds a
 * corpus; else fall back to the configured authoring home. The returned path is
 * absolute and resolved but not asserted to exist — callers that read corpus
 * files surface their own missing-file errors. */
export function resolveProjectRoot(
  explicit: string | null,
  cwd: string = process.cwd(),
): string {
  if (explicit) {
    return resolve(explicit);
  }
  const gitRoot = findGitRoot(cwd);
  if (gitRoot !== null && hasCorpus(gitRoot)) {
    return gitRoot;
  }
  return fallbackCorpusRoot();
}

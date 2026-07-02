// Corpus-root resolution for `keeper prompt`. The snippet/bundle corpus lives at
// `claude/arthack/template/_partials/` — authored upstream in the arthack repo,
// vendored into keeper under `plugins/prompt/corpus/`. Resolution walks up from
// cwd to the nearest `.git` root, but that root only wins when it actually holds
// a corpus; otherwise it falls back to the vendored corpus so `keeper prompt
// render` resolves from any repo (notably keeper's own root, which carries no
// corpus of its own — the vendored subset ships beside the engine).
//
// The fallback home is config-driven via `KEEPER_PROMPT_CORPUS_ROOT` (point it at
// an arthack checkout to author against the full upstream corpus); unset, it is
// the vendored subset shipped in-repo, so a fresh clone renders with no arthack
// checkout present.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/** The vendored corpus root shipped beside the engine (`plugins/prompt/corpus`),
 * resolved from this module's own location so it is found regardless of cwd. Its
 * `claude/arthack/template/_partials/` subtree is the keeper-relevant subset. */
export function vendoredCorpusRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "corpus");
}

/** The config-driven home fallback corpus root: `KEEPER_PROMPT_CORPUS_ROOT` when
 * set (an arthack checkout, for authoring against the full corpus), else the
 * in-repo vendored subset. */
export function fallbackCorpusRoot(): string {
  const configured = process.env.KEEPER_PROMPT_CORPUS_ROOT?.trim();
  if (configured) {
    return resolve(configured);
  }
  return vendoredCorpusRoot();
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

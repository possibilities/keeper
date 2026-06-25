/**
 * Dependency-free fnmatch leaf — `node:*`-only, ZERO `src/` imports — so it can
 * enter the hook import graph through `reducer.ts`'s `bashTargetMatches`
 * (mirrors the `src/derivers.ts` / `src/dead-letter.ts` dep-free precedent: a
 * stray `src/` import here breaks the hook's "no third-party / no DB graph"
 * rule). Two consumers share ONE glob implementation: the reducer's deletion-
 * attribution path and the pair/reaper autoclose opt-out matcher.
 *
 * Module-scope cache of token → compiled RegExp. A caller may probe the same
 * token many times (the deletion-attribution path across dirty files; the
 * boot-frozen reaper matcher across sessions); cache so re-compilation stays
 * O(distinct tokens). Cleared only on process restart — re-fold determinism is
 * unaffected because the cache value is a pure function of the key.
 */
const FNMATCH_CACHE = new Map<string, RegExp>();

/**
 * Is `token` a glob pattern (contains an unescaped `*` or `?`)?
 * Callers compile fnmatch only for these — exact match covers the rest and
 * avoids the regex round-trip.
 */
export function isGlobToken(token: string): boolean {
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    if (c === 0x2a /* * */ || c === 0x3f /* ? */) return true;
  }
  return false;
}

/**
 * Compile a glob token to an anchored fnmatch RegExp. Mapping:
 *
 *   - `*` → `[^/]*` (NEVER `.*` — `*` does not cross path separators); a run of
 *     consecutive `*` collapses to a single `[^/]*` (same language, no adjacent
 *     `[^/]*[^/]*` that would invite catastrophic backtracking)
 *   - `?` → `[^/]`  (single non-separator char)
 *   - every other regex meta (`. + ( ) [ ] { } ^ $ | \`) is escaped
 *   - anchored with `^` / `$` so a substring can't accidentally match
 *
 * `:` is NOT a separator, so `panels:*` → `^panels:[^/]*$` matches `panels:foo`
 * but not `panelsfoo`. NO `**` recursive-glob, NO nested quantifiers, NO POSIX
 * character classes. ReDoS-safe by construction: the regex is a flat sequence
 * of `[^/]*` / `[^/]` / single-char literals — no alternation, no
 * backreferences, no nested quantifiers — worst-case linear in input length.
 */
export function compileFnmatch(token: string): RegExp {
  const cached = FNMATCH_CACHE.get(token);
  if (cached !== undefined) return cached;
  let pattern = "^";
  let prevStar = false;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i] as string;
    if (ch === "*") {
      // Collapse a run of `*` — `[^/]*[^/]*` matches the same language as a
      // single `[^/]*` but is a classic catastrophic-backtracking shape.
      if (!prevStar) pattern += "[^/]*";
      prevStar = true;
      continue;
    }
    prevStar = false;
    if (ch === "?") {
      pattern += "[^/]";
    } else if (
      ch === "." ||
      ch === "+" ||
      ch === "(" ||
      ch === ")" ||
      ch === "[" ||
      ch === "]" ||
      ch === "{" ||
      ch === "}" ||
      ch === "^" ||
      ch === "$" ||
      ch === "|" ||
      ch === "\\"
    ) {
      pattern += `\\${ch}`;
    } else {
      pattern += ch;
    }
  }
  pattern += "$";
  const compiled = new RegExp(pattern);
  FNMATCH_CACHE.set(token, compiled);
  return compiled;
}

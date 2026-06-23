/**
 * fn-921: the dep-light git-toplevel resolver, extracted so the gated-root key
 * reconciliation can be applied at the readiness read sites (server-worker,
 * autopilot-worker, boot-seed) WITHOUT dragging the full `git-worker.ts` module
 * graph (its `openDb` + reducer-adjacent imports) into those workers' cold-start
 * path. `git-worker.ts` re-exports `resolveGitToplevel` from here so there is one
 * implementation.
 *
 * Pure producer boundary — shells out to `git`. NEVER call from a fold (the
 * reducer's gated-root self-clear passes no resolver; see `gated-roots.ts`).
 */

/** Subprocess timeout for the toplevel resolve — mirrors git-worker's `GIT_TIMEOUT_MS`. */
const GIT_TOPLEVEL_TIMEOUT_MS = 2000;

/**
 * Resolve a candidate path (typically an `effectiveRoot` or a session `cwd`) to
 * its containing git toplevel, or `null` if the path is not inside a git
 * worktree. `--no-optional-locks` keeps the daemon a pure observer (never takes
 * `.git/index.lock`); the read is time-bound + fail-safe (`null` on
 * timeout/error/non-repo).
 */
export function resolveGitToplevel(path: string): string | null {
  try {
    const res = Bun.spawnSync(
      [
        "git",
        "--no-optional-locks",
        "-C",
        path,
        "rev-parse",
        "--show-toplevel",
      ],
      { stdout: "pipe", stderr: "ignore", timeout: GIT_TOPLEVEL_TIMEOUT_MS },
    );
    if (!res.success || res.exitCode !== 0) return null;
    const root = res.stdout.toString().trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

/**
 * A per-instance memoized {@link resolveGitToplevel}. The gated-root set repeats
 * roots (an epic's close-row root often equals a task `target_repo`), and the
 * readiness snapshot recomputes the unseeded set frequently — so cache the
 * resolve per call. A `null` resolve falls back to the raw key (no worse than the
 * no-resolver identity default in `seededLookupKey`).
 */
export function memoizedGitToplevel(): (root: string) => string {
  const cache = new Map<string, string>();
  return (root: string): string => {
    const hit = cache.get(root);
    if (hit !== undefined) return hit;
    const resolved = resolveGitToplevel(root) ?? root;
    cache.set(root, resolved);
    return resolved;
  };
}

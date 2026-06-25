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
 * The spawn env for a toplevel resolve: a copy of the daemon's env with the git
 * path-pointer vars STRIPPED. An inherited `GIT_DIR`/`GIT_WORK_TREE`/
 * `GIT_INDEX_FILE`/`GIT_COMMON_DIR` would poison `rev-parse --show-toplevel` —
 * `-C <path>` would resolve against the pointed-at worktree, not `<path>`. Bun's
 * `env` option REPLACES the process env, so copy-then-delete keeps PATH et al.
 */
function gitResolveEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_COMMON_DIR;
  return env;
}

/**
 * Resolve a candidate path (typically an `effectiveRoot` or a session `cwd`) to
 * its containing git toplevel, or `null` if the path is not inside a git
 * worktree. `--no-optional-locks` keeps the daemon a pure observer (never takes
 * `.git/index.lock`); the read is time-bound + fail-safe (`null` on
 * timeout/error/non-repo). Empty input short-circuits to `null` BEFORE spawning
 * (`git -C "" rev-parse` resolves against the daemon's own cwd).
 */
export function resolveGitToplevel(path: string): string | null {
  if (path === "") return null;
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
      {
        stdout: "pipe",
        stderr: "ignore",
        timeout: GIT_TOPLEVEL_TIMEOUT_MS,
        env: gitResolveEnv(),
      },
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

/**
 * A per-instance memoized {@link resolveGitToplevel} that PRESERVES `null` — NO
 * `?? root` raw fallback — so a caller can distinguish "resolved to a toplevel"
 * from "not inside a git worktree." Mirrors {@link memoizedGitToplevel} but
 * returns `string | null`: the worktree lane geometry needs the null to mint a
 * distinct `worktree-repo-unresolved` reject rather than fork a lane off an
 * unresolved raw path. Empty input short-circuits to `null` BEFORE spawning.
 *
 * Fresh per cycle — caches `null` WITHIN one build (so a repeated root spawns
 * once) but is GC'd at cycle end, so a transient resolve failure re-resolves on
 * the next cycle rather than permanently darkening an epic. The `hit !==
 * undefined` check distinguishes a cached `null` (a known non-repo) from a miss.
 */
export function memoizedNullableGitToplevel(): (root: string) => string | null {
  const cache = new Map<string, string | null>();
  return (root: string): string | null => {
    if (root === "") return null;
    const hit = cache.get(root);
    if (hit !== undefined) return hit;
    const resolved = resolveGitToplevel(root);
    cache.set(root, resolved);
    return resolved;
  };
}

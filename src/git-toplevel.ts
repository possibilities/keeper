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

/**
 * True IFF local branch `branch` exists in the repo at `repoDir`
 * (`git rev-parse --verify --quiet refs/heads/<branch>`). The SYNCHRONOUS producer
 * peek mirrored on {@link resolveGitToplevel}: env-stripped (an inherited `GIT_DIR`
 * would resolve the ref against the pointed-at worktree, not `repoDir`),
 * `--no-optional-locks` (a pure observer), time-bound + fail-CLOSED (`false` on
 * empty input / timeout / error / non-repo). Used by the worktree grandfather
 * predicate as the branch-side OR signal; NEVER call from a fold.
 */
export function localBranchExists(repoDir: string, branch: string): boolean {
  return localBranchState(repoDir, branch) === "present";
}

/**
 * TRI-STATE local-branch probe: `present` (ref exists), `absent` (the ref
 * DEFINITIVELY does not exist — `rev-parse --verify --quiet` exit 1), or
 * `inconclusive` (a timeout / non-1 error / throw / empty input). Distinct from
 * {@link localBranchExists}, which fail-CLOSES a timeout/error into `false` and so
 * conflates "positively absent" with "could not tell" — a conflation a lane-epoch
 * decision must NOT make (an inconclusive probe defers to the full graph, never a
 * fresh epoch). Same env-stripped / `--no-optional-locks` / time-bound producer peek;
 * NEVER call from a fold.
 */
export function localBranchState(
  repoDir: string,
  branch: string,
): "present" | "absent" | "inconclusive" {
  if (repoDir === "" || branch === "") return "inconclusive";
  try {
    const res = Bun.spawnSync(
      [
        "git",
        "--no-optional-locks",
        "-C",
        repoDir,
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
        timeout: GIT_TOPLEVEL_TIMEOUT_MS,
        env: gitResolveEnv(),
      },
    );
    if (res.exitCode === 0) return "present";
    // Exit 1 is git's DEFINITIVE "no such ref" (with `--verify --quiet`); any other
    // code (timeout SIGKILL, a non-repo error) is NOT proof of absence.
    if (res.exitCode === 1) return "absent";
    return "inconclusive";
  } catch {
    return "inconclusive";
  }
}

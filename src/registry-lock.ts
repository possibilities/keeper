/**
 * The dep-free (node:* only) shared STRUCTURAL-LOCKING leaf — the ONE common-domain
 * serialization every keeper worktree-registry mutation (`git worktree add|remove|prune`,
 * a keeper-lane `git branch -D`) and every checkout/ref effect routes through. It imports
 * NOTHING keeper-specific (no `bun:sqlite`, no `src/db.ts`, no exec backend, no
 * `worktree-git.ts`): the git runner and the flock acquirer are BOTH injected, so the daemon,
 * workers, the baseline worker, and the plan plugin each pull it in without dragging the
 * reconcile core, and a hook could too.
 *
 * ## Why one common-domain lock
 * Every worktree on a repo shares ONE `--git-common-dir` (the shared ref/object store); a
 * linked lane's per-worktree `--git-dir` is distinct but the common dir is not. So the
 * common-dir `keeper-commit-work.lock` — the SAME lock a `keeper commit-work` and a base
 * merge in that domain take — is the universal serialization point: hold it and no other
 * registry mutation on the domain can interleave. This is the domain H7's lane reservation
 * and the actor's effect both consume, making the check→spawn gap non-existent.
 *
 * ## Two capabilities (opaque tokens)
 * A caller cannot MINT a token — only {@link withStructuralLock} / {@link withCheckoutLock}
 * hand one to their callback while the lock(s) are held. A lock-free CORE that REQUIRES a
 * token in its signature therefore proves, by construction, that the lock is held when it
 * runs — the "cores are not exported for external call" discipline the inventory conversion
 * enforces:
 *   - {@link StructuralToken} — registry add/remove/prune. A MISSING worktree (a reattach
 *     `worktree add`, whose per-worktree admin dir does not exist yet) takes structural ONLY.
 *   - {@link CheckoutToken} — checkout/ref effects on an EXISTING worktree. Adds the
 *     per-worktree lock: acquire common FIRST, derive+pin the per-worktree identity UNDER
 *     common, THEN acquire the per-worktree lock LAST.
 *
 * ## Global lock order (codified)
 * trunk-lease (OUTER, owned by the caller — never acquired here) → common structural →
 * per-worktree (LAST). A single global order makes a lock-order cycle impossible. Release
 * unwinds in strict reverse via nested try/finally, so a throwing second acquire OR a
 * throwing release still frees the common lock.
 */

import { isAbsolute, join, resolve } from "node:path";

/** The bounded git-op deadline the common-dir resolution runs under, so an unresolvable or
 *  wedged repo DEFERS rather than freezing a caller. Matches the worktree-git local budget. */
export const REGISTRY_LOCK_GIT_TIMEOUT_MS = 10_000;

/** The registry structural lock LEAF name under a common dir — the SAME
 *  `keeper-commit-work.lock` every keeper `commit-work` and base merge on the domain take. */
export const REGISTRY_LOCK_LEAF = "keeper-commit-work.lock";

/**
 * A bounded flock acquirer: takes an absolute lock path and returns a releasable handle, or
 * `null` on a timed-out / contended acquire (the caller DEFERS — never a frozen thread). May
 * be sync or async. Injected, so the leaf binds no concrete flock backend (production passes
 * the commit-work deadline acquirer; the fast tier stubs it).
 */
export type RegistryLockAcquirer = (
  lockPath: string,
) => { release(): void } | null | Promise<{ release(): void } | null>;

/**
 * The minimal git runner the leaf shells `git rev-parse --git-common-dir` through — the ONLY
 * git it runs. Injected, so the leaf imports no exec backend. Shape-compatible with the
 * repo's `WorktreeGitRunner` so callers pass their existing runner unchanged.
 */
export type RegistryLockGitRunner = (
  args: string[],
  opts: { cwd: string; timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * The STRICTLY-RESOLVED common git dir — `git rev-parse --path-format=absolute
 * --git-common-dir`, resolved absolute. STRICT, NO FALLBACK: a non-zero exit, an empty read,
 * or a non-absolute result yields `null` and the caller DEFERS — the leaf NEVER guesses a
 * bare `.git`, because a wrong common dir would serialize the wrong domain (or none). Async,
 * preserving the no-sync-main rule. NEVER throws (a thrown runner is caught → `null`).
 */
export async function resolveCommonDir(
  cwd: string,
  run: RegistryLockGitRunner,
): Promise<string | null> {
  let r: { code: number; stdout: string; stderr: string };
  try {
    r = await run(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      timeoutMs: REGISTRY_LOCK_GIT_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  const dir = r.stdout.trim();
  if (r.code !== 0 || dir === "" || !isAbsolute(dir)) {
    return null;
  }
  return resolve(dir);
}

/** The common-domain structural lock path under a strictly-resolved common dir. */
export function structuralLockPathFor(commonDir: string): string {
  return join(commonDir, REGISTRY_LOCK_LEAF);
}

/**
 * The STRUCTURAL capability — registry add/remove/prune. Opaque: the private `__t` brand
 * cannot be produced outside this module, so a core requiring it proves the common lock is
 * held. Carries the common lock path only (a missing worktree has no per-worktree lock).
 */
export interface StructuralToken {
  readonly __t: "structural";
  readonly commonLockPath: string;
}

/**
 * The CHECKOUT capability — checkout/ref effects on an EXISTING worktree. Carries BOTH the
 * common and the per-worktree lock paths (both held when the callback runs). Opaque brand,
 * as {@link StructuralToken}.
 */
export interface CheckoutToken {
  readonly __t: "checkout";
  readonly commonLockPath: string;
  readonly worktreeLockPath: string;
}

/**
 * The deferred outcome a `with*Lock` returns when the DOMAIN could not be locked — the common
 * dir was unresolvable, or a lock acquire timed out. Distinct in shape from every effect
 * result (which are `{ kind: … }`-tagged), so a caller disambiguates via {@link isLockDeferred}
 * without a shape collision.
 */
export interface LockDeferred {
  readonly defer: string;
}

/** True iff `x` is a {@link LockDeferred} (a `{ defer: <string> }`), never an effect result. */
export function isLockDeferred(x: unknown): x is LockDeferred {
  return (
    typeof x === "object" &&
    x !== null &&
    "defer" in x &&
    typeof (x as { defer: unknown }).defer === "string" &&
    !("kind" in x)
  );
}

/**
 * Run `fn` holding the COMMON structural lock — the capability for registry add/remove/prune
 * and a MISSING-worktree add (no per-worktree lock exists to take). Order: resolve the common
 * dir (strict; null → defer), acquire the common lock (timeout → defer), run `fn(token)`, then
 * release the common lock in a `finally` so a throwing `fn` still frees it. Returns `fn`'s
 * result, or a {@link LockDeferred}. NEVER acquires a per-worktree lock.
 */
export async function withStructuralLock<R>(
  cwd: string,
  run: RegistryLockGitRunner,
  acquire: RegistryLockAcquirer,
  fn: (token: StructuralToken) => Promise<R>,
): Promise<R | LockDeferred> {
  const commonDir = await resolveCommonDir(cwd, run);
  if (commonDir === null) {
    return { defer: "registry-lock: unresolved common dir" };
  }
  const commonLockPath = structuralLockPathFor(commonDir);
  const common = await acquire(commonLockPath);
  if (common === null) {
    return { defer: "registry-lock: common lock timeout" };
  }
  try {
    return await fn({ __t: "structural", commonLockPath });
  } finally {
    try {
      common.release();
    } catch {
      // A throwing release cannot un-free the lock for the next holder; swallow.
    }
  }
}

/**
 * Derive the per-worktree lock path for an EXISTING worktree UNDER the already-held common
 * lock — so the identity is pinned against a concurrent remove/re-add. Returns `null` on any
 * unresolvable identity (the caller DEFERS). Injected so the pure-`run` fence fakes exercise
 * the checkout path without a real admin dir.
 */
export type WorktreeLockPathDeriver = (
  cwd: string,
  run: RegistryLockGitRunner,
) => Promise<string | null>;

/**
 * Run `fn` holding the common structural lock AND the per-worktree lock — the capability for
 * checkout/ref effects on an EXISTING worktree. FIXED ORDER (global order codified):
 *   1. resolve common dir (strict; null → defer); acquire COMMON (timeout → defer);
 *   2. UNDER common, derive the per-worktree identity via `deriveIdentity` (null → defer);
 *   3. acquire the PER-WORKTREE lock LAST (timeout → defer);
 *   4. run `fn(token)`.
 * Release unwinds in strict REVERSE via NESTED try/finally, so a throwing per-worktree acquire
 * OR a throwing release still frees the common lock. When the per-worktree path COINCIDES with
 * the common path (a main worktree, whose `--git-dir` == `--git-common-dir`) the second acquire
 * is SKIPPED — a second flock on the same path from a distinct fd would self-block the process
 * against its own held lock. Returns `fn`'s result, or a {@link LockDeferred}.
 */
export async function withCheckoutLock<R>(
  cwd: string,
  run: RegistryLockGitRunner,
  acquire: RegistryLockAcquirer,
  deriveIdentity: WorktreeLockPathDeriver,
  fn: (token: CheckoutToken) => Promise<R>,
): Promise<R | LockDeferred> {
  const commonDir = await resolveCommonDir(cwd, run);
  if (commonDir === null) {
    return { defer: "registry-lock: unresolved common dir" };
  }
  const commonLockPath = structuralLockPathFor(commonDir);
  const common = await acquire(commonLockPath);
  if (common === null) {
    return { defer: "registry-lock: common lock timeout" };
  }
  try {
    // Per-worktree identity is derived UNDER common, so a concurrent remove/re-add cannot
    // race the identity out from under the lock.
    const worktreeLockPath = await deriveIdentity(cwd, run);
    if (worktreeLockPath === null) {
      return { defer: "registry-lock: unresolved worktree identity" };
    }
    // Same-path coincidence (main worktree): the common lock already covers it.
    if (worktreeLockPath === commonLockPath) {
      return await fn({ __t: "checkout", commonLockPath, worktreeLockPath });
    }
    // A throwing per-worktree acquire must still release common — the outer finally owns it,
    // so we do NOT catch here; the throw propagates up through the outer finally.
    const perWorktree = await acquire(worktreeLockPath);
    if (perWorktree === null) {
      return { defer: "registry-lock: per-worktree lock timeout" };
    }
    try {
      return await fn({ __t: "checkout", commonLockPath, worktreeLockPath });
    } finally {
      try {
        perWorktree.release();
      } catch {
        // A throwing per-worktree release still lets the outer finally free common.
      }
    }
  } finally {
    try {
      common.release();
    } catch {
      // Swallow: a throwing common release cannot un-free the lock for the next holder.
    }
  }
}

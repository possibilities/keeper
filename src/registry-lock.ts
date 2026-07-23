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
 * ## Two capabilities (unforgeable tokens)
 * A caller cannot STRUCTURALLY construct a token — the brand is a NON-EXPORTED `unique symbol`
 * that external code cannot name, so only this module's mint helpers produce one. A lock-free
 * CORE that requires a token in its signature therefore proves, by construction, that the lock
 * is held when it runs — the "cores are not exported for external call" discipline the
 * inventory conversion enforces:
 *   - {@link StructuralToken} — registry add/remove/prune. A MISSING worktree (a reattach
 *     `worktree add`, whose per-worktree admin dir does not exist yet) takes structural ONLY.
 *   - {@link CheckoutToken} — checkout/ref effects on an EXISTING worktree. Adds the
 *     per-worktree lock: acquire common FIRST, derive+pin the per-worktree identity UNDER
 *     common, THEN acquire the per-worktree lock LAST.
 *
 * ## Global lock order + release discipline
 * trunk-lease (OUTER, owned by the caller — never acquired here) → common structural →
 * per-worktree (LAST). A single global order makes a lock-order cycle impossible. Release
 * unwinds in strict REVERSE, attempting EVERY held lock even if one throws, then AGGREGATES
 * and PROPAGATES any release failure — a possibly-held flock is an operational failure, never
 * a green effect swallowed under a successful body.
 */

import { realpath } from "node:fs/promises";
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
 * Canonicalize an absolute path across symlink / path aliases, or `null` when the path cannot
 * be canonicalized (symlink loop, ENOENT, ambiguous). Injected so the pure-`run` fence fakes
 * exercise the leaf without a real fs; production uses {@link defaultCanonicalize} (a real
 * `realpath`). Canonical identity is load-bearing: two callers reaching the SAME common dir via
 * different aliases must serialize on ONE lock, so a potentially-aliased raw string is never
 * trusted as the lock domain.
 */
export type PathCanonicalizer = (path: string) => Promise<string | null>;

const defaultCanonicalize: PathCanonicalizer = async (p) => {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
};

/** Reject a path that is empty, non-absolute, or carries a CR / LF / NUL (ambiguous, multi-line,
 *  or injection-shaped) — applied to BOTH the raw INPUT and the canonical OUTPUT of {@link
 *  canonicalizeStrict}. A relative or control-char-bearing path must never reach the
 *  canonicalizer (a real `realpath` would resolve a relative path against the process cwd and
 *  select the WRONG lock domain). */
function isCleanAbsolutePath(p: string): boolean {
  return p !== "" && isAbsolute(p) && !/[\r\n\0]/.test(p);
}

/**
 * Validate the raw INPUT, canonicalize, then REVALIDATE the canonicalizer's OUTPUT — not only
 * its input. A non-absolute / empty / CR-LF-NUL RAW path is rejected BEFORE the canonicalizer is
 * even invoked (a relative admin dir from a buggy deriver would else realpath against the process
 * cwd and select the wrong lock domain); a throwing / null / non-absolute / control-char OUTPUT
 * likewise yields `null` so the caller DEFERS, never degrading to a raw-string compare. The
 * single strict canonicalization seam both the common-dir resolution AND the per-worktree
 * identity route through.
 */
async function canonicalizeStrict(
  path: string,
  canonicalize: PathCanonicalizer,
): Promise<string | null> {
  // Reject the raw INPUT before canonicalizing — never realpath a relative / control-char path.
  if (!isCleanAbsolutePath(path)) {
    return null;
  }
  let out: string | null;
  try {
    out = await canonicalize(path);
  } catch {
    return null;
  }
  if (out === null || !isCleanAbsolutePath(out)) {
    return null;
  }
  return out;
}

/**
 * The STRICTLY-RESOLVED, CANONICAL common git dir — `git rev-parse --path-format=absolute
 * --git-common-dir`, normalized, then canonicalized across symlink aliases via `canonicalize`.
 * STRICT, NO FALLBACK: a non-zero exit, an empty / multi-line (ambiguous) read, a non-absolute
 * result, or a path that cannot be canonicalized yields `null` and the caller DEFERS — the leaf
 * NEVER guesses a bare `.git`, and never serializes on a potentially-aliased string. Async,
 * preserving the no-sync-main rule. NEVER throws (a thrown runner / canonicalizer → `null`).
 */
export async function resolveCommonDir(
  cwd: string,
  run: RegistryLockGitRunner,
  canonicalize: PathCanonicalizer = defaultCanonicalize,
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
  // Reject ambiguous resolver output — a non-zero exit, an empty read, a non-absolute path,
  // or MULTIPLE non-empty lines (never serialize on a guessed one of several).
  if (r.code !== 0 || dir === "" || !isAbsolute(dir) || dir.includes("\n")) {
    return null;
  }
  // Canonicalize AND revalidate the output — an ambiguous / uncanonicalizable canonical result
  // rejects (defer), never a raw-string fallback.
  return canonicalizeStrict(resolve(dir), canonicalize);
}

/** The common-domain structural lock path under a strictly-resolved, canonical common dir. */
export function structuralLockPathFor(commonDir: string): string {
  return join(commonDir, REGISTRY_LOCK_LEAF);
}

// ── Unforgeable capability tokens ──────────────────────────────────────────
// The brands are NON-EXPORTED `unique symbol`s: external code cannot name them, so it cannot
// STRUCTURALLY construct a token. Only the mint helpers below (the sole sanctioned producers)
// cast into the branded type, under a held lock.

declare const STRUCTURAL_BRAND: unique symbol;
declare const CHECKOUT_BRAND: unique symbol;

/** The STRUCTURAL capability — registry add/remove/prune. Unforgeable (non-exported brand);
 *  carries the common lock path only (a missing worktree has no per-worktree lock). */
export interface StructuralToken {
  readonly [STRUCTURAL_BRAND]: true;
  readonly commonLockPath: string;
}

/** The CHECKOUT capability — checkout/ref effects on an EXISTING worktree. Unforgeable;
 *  carries BOTH the common and the per-worktree lock paths (both held when the callback runs). */
export interface CheckoutToken {
  readonly [CHECKOUT_BRAND]: true;
  readonly commonLockPath: string;
  readonly worktreeLockPath: string;
}

function mintStructuralToken(commonLockPath: string): StructuralToken {
  return { commonLockPath } as unknown as StructuralToken;
}

function mintCheckoutToken(
  commonLockPath: string,
  worktreeLockPath: string,
): CheckoutToken {
  return { commonLockPath, worktreeLockPath } as unknown as CheckoutToken;
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

// ── Release discipline ─────────────────────────────────────────────────────

/** Release every handle in REVERSE (release-order) sequence, attempting EACH even if one
 *  throws; returns the collected release errors (empty when all released cleanly). */
function releaseReverse(handles: readonly { release(): void }[]): unknown[] {
  const errors: unknown[] = [];
  for (let i = handles.length - 1; i >= 0; i--) {
    try {
      handles[i].release();
    } catch (e) {
      errors.push(e);
    }
  }
  return errors;
}

/** After releasing, surface any failure: a release error (a possibly-held flock) is ALWAYS
 *  thrown — aggregated with the body error when the body also threw — so a stuck lock is never
 *  swallowed under a green result. No-op only when nothing threw. */
function surfaceLockFailures(
  bodyThrew: boolean,
  bodyError: unknown,
  releaseErrors: unknown[],
): void {
  if (releaseErrors.length > 0) {
    throw new AggregateError(
      bodyThrew ? [bodyError, ...releaseErrors] : releaseErrors,
      `registry-lock: ${releaseErrors.length} lock release(s) failed — a flock may still be held`,
    );
  }
  if (bodyThrew) {
    throw bodyError;
  }
}

/**
 * Run `fn` holding the COMMON structural lock — the capability for registry add/remove/prune
 * and a MISSING-worktree add (no per-worktree lock exists to take). Order: resolve+canonicalize
 * the common dir (strict; null → defer), acquire the common lock (timeout → defer), run
 * `fn(token)`, then release common — surfacing a release failure as an operational error, never
 * swallowing it. Returns `fn`'s result, or a {@link LockDeferred}. NEVER acquires a per-worktree
 * lock.
 */
export async function withStructuralLock<R>(
  cwd: string,
  run: RegistryLockGitRunner,
  acquire: RegistryLockAcquirer,
  fn: (token: StructuralToken) => Promise<R>,
  canonicalize: PathCanonicalizer = defaultCanonicalize,
): Promise<R | LockDeferred> {
  const commonDir = await resolveCommonDir(cwd, run, canonicalize);
  if (commonDir === null) {
    return { defer: "registry-lock: unresolved common dir" };
  }
  const commonLockPath = structuralLockPathFor(commonDir);
  const common = await acquire(commonLockPath);
  if (common === null) {
    return { defer: "registry-lock: common lock timeout" };
  }
  let result: R | undefined;
  let bodyError: unknown;
  let threw = false;
  try {
    result = await fn(mintStructuralToken(commonLockPath));
  } catch (e) {
    threw = true;
    bodyError = e;
  }
  surfaceLockFailures(threw, bodyError, releaseReverse([common]));
  return result as R;
}

/**
 * Derive the EXISTING worktree's ADMIN/GIT DIRECTORY (NOT a lock-file path) UNDER the
 * already-held common lock — so the identity is pinned against a concurrent remove/re-add.
 * Returns the git admin dir (`--git-dir`), which {@link withCheckoutLock} then canonicalizes
 * itself (via the SAME injected canonicalizer) and appends {@link REGISTRY_LOCK_LEAF} to — so
 * the deriver never has to realpath a lock leaf that may not exist yet, and the leaf owns the
 * canonical-to-canonical comparison. Returns `null` on any unresolvable identity (the caller
 * DEFERS). Injected so the pure-`run` fence fakes exercise the checkout path without a real
 * admin dir.
 */
export type WorktreeAdminDirDeriver = (
  cwd: string,
  run: RegistryLockGitRunner,
) => Promise<string | null>;

/**
 * Run `fn` holding the common structural lock AND the per-worktree lock — the capability for
 * checkout/ref effects on an EXISTING worktree. FIXED ORDER (global order codified):
 *   1. resolve+canonicalize common dir (strict; null → defer); acquire COMMON (timeout → defer);
 *   2. UNDER common, derive the worktree ADMIN dir, CANONICALIZE it here (same injected
 *      canonicalizer, output revalidated absolute/single-line/non-null; else defer), then append
 *      {@link REGISTRY_LOCK_LEAF} — the leaf owns the canonical per-worktree identity, never
 *      trusting the deriver's raw string;
 *   3. acquire the PER-WORKTREE lock LAST (timeout → defer);
 *   4. run `fn(token)`.
 * Release unwinds in strict REVERSE (per-worktree then common), attempting EVERY held lock even
 * if one throws, then AGGREGATES + PROPAGATES any release failure. When the CANONICAL
 * per-worktree lock path COINCIDES with the CANONICAL common lock path (a main worktree, whose
 * `--git-dir` == `--git-common-dir`, even reached via an alias) the second acquire is SKIPPED —
 * a second flock on the same path from a distinct fd would self-block the process against its own
 * held lock. Returns `fn`'s result, or a {@link LockDeferred}.
 */
export async function withCheckoutLock<R>(
  cwd: string,
  run: RegistryLockGitRunner,
  acquire: RegistryLockAcquirer,
  deriveAdminDir: WorktreeAdminDirDeriver,
  fn: (token: CheckoutToken) => Promise<R>,
  canonicalize: PathCanonicalizer = defaultCanonicalize,
): Promise<R | LockDeferred> {
  const commonDir = await resolveCommonDir(cwd, run, canonicalize);
  if (commonDir === null) {
    return { defer: "registry-lock: unresolved common dir" };
  }
  const commonLockPath = structuralLockPathFor(commonDir);
  const common = await acquire(commonLockPath);
  if (common === null) {
    return { defer: "registry-lock: common lock timeout" };
  }
  // From here common is HELD; every exit path releases it through `held` (reverse-order,
  // aggregated). The per-worktree handle joins `held` only after a successful acquire.
  const held: { release(): void }[] = [common];
  let result: R | LockDeferred | undefined;
  let bodyError: unknown;
  let threw = false;
  try {
    const adminDir = await deriveAdminDir(cwd, run);
    // Canonicalize the DERIVED admin dir HERE (never trusting the deriver's raw string), then
    // append the lock leaf — so an aliased admin dir collapses to ONE per-worktree lock and the
    // self-lock elision compares canonical-to-canonical. An unresolvable / ambiguous canonical
    // identity → defer WHILE the finally releases common.
    const canonAdminDir =
      adminDir === null
        ? null
        : await canonicalizeStrict(adminDir, canonicalize);
    if (canonAdminDir === null) {
      result = { defer: "registry-lock: unresolved worktree identity" };
    } else {
      const worktreeLockPath = join(canonAdminDir, REGISTRY_LOCK_LEAF);
      if (worktreeLockPath === commonLockPath) {
        // Same CANONICAL identity as common (main worktree, even via an alias): the common lock
        // already covers it — skip the self-blocking second acquire.
        result = await fn(mintCheckoutToken(commonLockPath, worktreeLockPath));
      } else {
        const perWorktree = await acquire(worktreeLockPath);
        if (perWorktree === null) {
          result = { defer: "registry-lock: per-worktree lock timeout" };
        } else {
          held.push(perWorktree);
          result = await fn(
            mintCheckoutToken(commonLockPath, worktreeLockPath),
          );
        }
      }
    }
  } catch (e) {
    threw = true;
    bodyError = e;
  }
  surfaceLockFailures(threw, bodyError, releaseReverse(held));
  return result as R | LockDeferred;
}

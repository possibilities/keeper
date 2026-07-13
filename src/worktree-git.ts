/**
 * Producer git driver for autopilot's worktree mode (fn-959).
 *
 * Consumes the pure topology plan from `src/worktree-plan.ts` and turns it into
 * real git side effects on an EXTERNAL working tree: create the lane worktrees
 * (`git worktree add`), run a fan-in's sequential pairwise pre-merges, assert a
 * worktree's HEAD, and tear the worktrees down. This is a PRODUCER — it lives in
 * the autopilot worker, shells `git` on the target repo, and NEVER writes
 * keeper.db, NEVER runs inside a fold, and NEVER reads the wall clock for a
 * decision (re-derive geometry from the DAG + live git each cycle).
 *
 * Every op here is idempotent and re-entrant so a crash mid-cycle is recoverable
 * by simply re-running the cycle:
 *  - `ensureWorktree` skips when the path is already a registered worktree on the
 *    expected branch; it prunes + repairs a stale/orphaned entry before re-add.
 *  - `mergeBranchInto` skips when the source is already an ancestor
 *    (`merge-base --is-ancestor`), and on a CONFLICT aborts via a
 *    `MERGE_HEAD`-guarded `git merge --abort` and reports the conflict (the
 *    caller fails loud + stops — no merge-to-default, no teardown).
 *  - `removeWorktree` NEVER blind-`--force`s: it refuses a dirty linked tree and
 *    surfaces that so the caller can decide, matching the epic's "never force-
 *    delete over a dirty tree" rule.
 *  - `pruneWorktrees` always passes `--expire now` (git's default expiry is 14
 *    DAYS — without the flag stale entries linger and block gc).
 *
 * Merges are SEQUENTIAL PAIRWISE (`git merge` one source at a time, never an
 * octopus merge) and each acquires the per-worktree
 * `<--git-dir>/keeper-commit-work.lock` flock so a merge serializes against a
 * concurrent `keeper commit-work` commit in the SAME worktree (they share the
 * one per-worktree index); disjoint linked worktrees take distinct locks.
 *
 * Default-branch resolution (`git symbolic-ref --short refs/remotes/origin/HEAD`
 * with a `main|master|trunk|develop` fallback) and linked-worktree detection
 * (`--git-dir` vs `--git-common-dir` with a `--show-superproject-working-tree`
 * submodule guard) are split into PURE parse functions so the fast tier covers
 * them via a faked GitRunner with zero real git; the git-shelling wrappers and
 * the worktree/merge lifecycle are covered by the real-git `*.slow.test.ts`.
 */

import { randomUUID } from "node:crypto";
import {
  appendFile,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { CommitWorkLock } from "./commit-work/flock";
import {
  GIT_LOCAL_TIMEOUT_MS,
  GIT_SPAWN_FAILED_CODE,
  GIT_SPAWN_TIMEOUT_CODE,
  type GitRunner,
  gitExec,
} from "./commit-work/git-exec";
import { repoDirHash } from "./worktree-plan";

/**
 * Acquire the shared commit-work flock, returning a releasable handle — or `null`
 * when a bounded acquirer times out. Injectable so the fast tier can stub the lock
 * (the real FFI flock is exercised by the slow real-git test); production uses the
 * DEADLINE-bounded {@link CommitWorkLock.acquireWithDeadline} so a stuck holder
 * degrades the worktree merge to a retry-skip rather than freezing the reconcile
 * cycle. The return is `MaybePromise`-shaped so a synchronous stub (`() => ({
 * release(){} })`) and the async production acquirer both satisfy it; a `null`
 * resolution is the timeout signal {@link mergeBranchInto} maps to `lock-timeout`.
 */
export type LockAcquirer = (
  lockPath: string,
) => { release(): void } | null | Promise<{ release(): void } | null>;

const defaultLockAcquirer: LockAcquirer = (lockPath) =>
  CommitWorkLock.acquireWithDeadline(lockPath);

/** The fallback default-branch chain, tried in order when origin/HEAD is unset. */
export const DEFAULT_BRANCH_FALLBACKS = [
  "main",
  "master",
  "trunk",
  "develop",
] as const;

/** Outcome of a single pairwise merge attempt. */
export type MergeResult =
  /** The source merged cleanly (a real merge commit or fast-forward). */
  | { kind: "merged" }
  /** The source was already an ancestor of the target — nothing to do. */
  | { kind: "already-merged" }
  /**
   * The source lane branch does not resolve — a *phantom* lane that was never
   * created because its task's work landed on the default branch instead
   * (mixed-mode board history). A provably lossless no-op: the rib was never
   * created, so there is no unmerged work to lose. The caller SKIPS this
   * pre-merge rather than failing loud. Sourced ONLY from the pre-merge ref
   * probe — never from a merge/is-ancestor failure, which stays a real error.
   */
  | { kind: "missing-source" }
  /**
   * The merge hit a conflict and was ABORTED (`git merge --abort` ran iff a
   * `MERGE_HEAD` was present). The caller fails loud + stops; `stderr` carries
   * git's conflict output for the sticky DispatchFailed.
   */
  | { kind: "conflict"; stderr: string; conflictedFiles: string[] }
  /**
   * The bounded {@link LockAcquirer} could not take the per-worktree commit-work
   * flock within its deadline — another holder (a concurrent commit-work or a
   * stuck process) owns it. A TRANSIENT degrade: the caller skip-retries the
   * merge next cycle rather than freezing the reconcile thread on a blocking
   * acquire. Never a content failure — no merge was attempted.
   */
  | { kind: "lock-timeout" }
  /**
   * A LOCAL git op on the merge path (the `merge --no-edit` itself, or the
   * source-ref probe) exceeded {@link GIT_LOCAL_TIMEOUT_MS} and was SIGKILLed —
   * almost always a blocking/wedged git hook. A TRANSIENT degrade like
   * {@link lock-timeout}: the caller skip-retries, never a frozen cycle, and
   * NEVER a sticky `conflict` (a timed-out merge's non-zero exit must not be
   * mistaken for a content conflict).
   */
  | { kind: "local-timeout" }
  /**
   * The conflict/timeout guarded `git merge --abort` ITSELF failed or timed out
   * — it returned non-zero (or was SIGKILLed at {@link GIT_LOCAL_TIMEOUT_MS}), so
   * the working copy is left MID-MERGE (MERGE_HEAD + unresolved paths) rather than
   * self-healed. DISTINCT from `conflict` (which aborted cleanly): the residue did
   * NOT clear, so the caller must ESCALATE the wedge instead of silently skip-
   * retrying it forever. `stderr` carries the abort's own output (or a timeout
   * note) for the sticky DispatchFailed.
   */
  | { kind: "abort-failed"; stderr: string };

/** Outcome of a worktree removal attempt. */
export type RemoveResult =
  /** Removed (or already absent — idempotent). */
  | { kind: "removed" }
  /**
   * Refused: the linked worktree has uncommitted changes, so removing it would
   * need a blind `--force` we never issue. The caller drains it manually.
   */
  | { kind: "dirty"; stderr: string };

/**
 * Whether the SHARED main checkout is safe to merge an epic base into RIGHT NOW —
 * the finalize/recover pre-merge guard, result-kind shaped like {@link RemoveResult}.
 * A finalize/recover merge lands in the human's own main worktree, so it must never
 * stomp work-in-progress or fight an in-flight merge/rebase: a not-`ready` result is
 * a clean SKIP-AND-RETRY (the caller stops that epic's finalize and retries next
 * cycle once the tree settles), NEVER a sticky failure.
 */
export type MergeReadiness =
  /** On the expected branch, clean working tree, no merge/rebase in flight. */
  | { kind: "ready" }
  /**
   * A merge is IN FLIGHT on the shared checkout: `MERGE_HEAD` is present (a
   * keeper base-merge that conflicted and stopped, or a crash mid-merge). Probed
   * BEFORE `dirty` because a stopped merge's tree is ALSO dirty — folding the
   * wedge into `dirty` is exactly the mis-classification this arm fixes, so the
   * recover/finalize pass can name it and self-heal only what it owns. Fields:
   * `mergeHead` is the incoming commit; `owner` is a repo-state-only SOLE-
   * ownership attribution — `"keeper"` IFF the branch-set pointing at `mergeHead`
   * is non-empty and consists ENTIRELY of `keeper/epic/*` branches, no
   * MERGE_AUTOSTASH is present, and every ownership probe resolved; ANY foreign
   * branch, an empty set, a probe failure/timeout, or a present autostash reads
   * `"foreign"`. `autostash` reports whether a MERGE_AUTOSTASH ref is set. A
   * caller may auto-abort ONLY an `owner: "keeper"` residue; a `"foreign"` one is
   * never touched.
   */
  | {
      kind: "mid-merge";
      mergeHead: string;
      owner: "keeper" | "foreign";
      autostash: boolean;
    }
  /**
   * The working tree / index is not clean (`git status --porcelain` non-empty),
   * OR a NON-merge in-progress operation is paused on the checkout — a rebase
   * (`rebase-merge`/`rebase-apply`), cherry-pick (`CHERRY_PICK_HEAD`), or revert
   * (`REVERT_HEAD`) — OR a stale `index.lock` sits in the git dir. A mid-MERGE is
   * NO LONGER folded here (it gets the distinct `mid-merge` arm); every other
   * in-progress state IS, but with `detail` NAMING the specific cause so a
   * downstream reason stops saying just "dirty". All of these are foreign-shaped:
   * the caller degrades to a named skip-and-retry and NEVER remediates (never
   * aborts a rebase/cherry-pick/revert, never removes an index.lock).
   */
  | { kind: "dirty"; detail: string }
  /**
   * HEAD is not on `expectedBranch` — a human checked out a feature branch, or a
   * rebase is in flight (which leaves HEAD detached, so `currentBranch` reports
   * `HEAD`). Either way the base merge must wait for the checkout to return.
   */
  | { kind: "off-branch"; head: string }
  /**
   * The incoming lane's tracked paths would OVERWRITE an untracked file already
   * sitting in the main checkout — the intersection of `git ls-files --others
   * --exclude-standard` (main's untracked) and the lane base's tracked tree. A
   * real `git merge` hard-ABORTS on this ("untracked working tree files would be
   * overwritten"), so the caller degrades to a clean skip-and-retry instead of a
   * loud merge failure. Detected ONLY when an `incomingBranch` is supplied;
   * `paths` carries the colliding paths for the skip reason. Distinct from
   * `dirty`: a BENIGN untracked file the merge cannot disturb (no incoming path
   * collides) still reads `ready` — the fn-987 untracked-is-clean behavior holds.
   */
  | { kind: "would-clobber"; paths: string[] };

/** One parsed `git worktree list --porcelain` entry. */
export interface WorktreeEntry {
  /** Absolute worktree path. */
  path: string;
  /** The checked-out branch ref (`refs/heads/...`), or null when detached. */
  branch: string | null;
  /** The checked-out commit oid, or null when not yet resolved. */
  head: string | null;
  /** True when the entry is a bare repo (the main worktree of a bare clone). */
  bare: boolean;
  /** Porcelain `locked` annotation; absent/null means the worktree is unlocked. */
  locked?: string | null;
}

// ---------------------------------------------------------------------------
// Pure parse helpers — fast-tier covered via a faked GitRunner.
// ---------------------------------------------------------------------------

/**
 * Resolve the repo's default branch from a `git symbolic-ref --short
 * refs/remotes/origin/HEAD` result (its stdout + exit code) and the set of local
 * branch names. Pure: the caller does the two git shells, this picks the answer.
 *
 *  1. If `origin/HEAD` resolved (exit 0), strip the `origin/` prefix → that
 *     branch (e.g. `origin/main` → `main`).
 *  2. Else fall back to the FIRST of {@link DEFAULT_BRANCH_FALLBACKS} that exists
 *     among `localBranches`.
 *  3. Else the first fallback (`main`) as a last resort — never hardcode at the
 *     call site, never throw (a fresh repo with no commits still resolves).
 */
export function resolveDefaultBranchPure(
  symbolicRef: { code: number; stdout: string },
  localBranches: readonly string[],
): string {
  if (symbolicRef.code === 0) {
    const ref = symbolicRef.stdout.trim();
    if (ref.length > 0) {
      // `--short` yields `origin/main`; strip the leading remote segment.
      const slash = ref.indexOf("/");
      return slash >= 0 ? ref.slice(slash + 1) : ref;
    }
  }
  const have = new Set(localBranches.map((b) => b.trim()).filter(Boolean));
  for (const cand of DEFAULT_BRANCH_FALLBACKS) {
    if (have.has(cand)) {
      return cand;
    }
  }
  return DEFAULT_BRANCH_FALLBACKS[0];
}

/**
 * Decide whether a cwd is inside a LINKED git worktree, given the three probes:
 *  - `--git-dir` (the per-worktree git dir, `--path-format=absolute`),
 *  - `--git-common-dir` (the shared common dir, `--path-format=absolute`),
 *  - `--show-superproject-working-tree` (non-empty IFF this is a submodule).
 *
 * A linked worktree's `--git-dir` (`<common>/worktrees/<name>`) DIFFERS from its
 * `--git-common-dir` (`<common>`); the main worktree's two are EQUAL. A submodule
 * also has a differing git-dir vs common-dir, so the superproject probe guards
 * that false positive: a non-empty superproject working tree means "submodule,
 * NOT a keeper linked worktree".
 */
export function isLinkedWorktreePure(probes: {
  gitDir: string;
  gitCommonDir: string;
  superproject: string;
}): boolean {
  if (probes.superproject.trim().length > 0) {
    return false; // submodule, not a linked worktree
  }
  const gitDir = stripTrailingSlash(probes.gitDir.trim());
  const common = stripTrailingSlash(probes.gitCommonDir.trim());
  if (gitDir.length === 0 || common.length === 0) {
    return false;
  }
  return gitDir !== common;
}

/**
 * Parse `git worktree list --porcelain` output into entries. The porcelain
 * format is NUL-or-newline-record-grouped `key value` lines per worktree,
 * separated by a blank line; a value-less `bare`/`detached` line is a boolean
 * flag. Unknown keys are ignored. Robust to a trailing blank record.
 */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let cur: Partial<WorktreeEntry> | null = null;
  const flush = (): void => {
    if (cur?.path !== undefined) {
      out.push({
        path: cur.path,
        branch: cur.branch ?? null,
        head: cur.head ?? null,
        bare: cur.bare ?? false,
        ...(cur.locked !== undefined ? { locked: cur.locked } : {}),
      });
    }
    cur = null;
  };
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.length === 0) {
      flush();
      continue;
    }
    const sp = line.indexOf(" ");
    const key = sp >= 0 ? line.slice(0, sp) : line;
    const value = sp >= 0 ? line.slice(sp + 1) : "";
    if (key === "worktree") {
      flush();
      cur = { path: value };
    } else if (cur !== null) {
      if (key === "branch") {
        cur.branch = value;
      } else if (key === "HEAD") {
        cur.head = value;
      } else if (key === "bare") {
        cur.bare = true;
      } else if (key === "locked") {
        cur.locked = value.length > 0 ? value : "locked";
      }
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Git-shelling wrappers — slow real-git covered.
// ---------------------------------------------------------------------------

/**
 * The per-worktree commit-work lock path:
 * `$(git rev-parse --path-format=absolute --git-dir)/keeper-commit-work.lock`.
 * Keyed on the worktree's OWN git dir (IDENTICAL argv to the lock build in
 * `cli/commit-work.ts`), so a base-merge serializes only against a commit-work
 * in the SAME worktree; disjoint linked worktrees take distinct locks. In the
 * main worktree `--git-dir` == `--git-common-dir`, so the path is unchanged. On
 * a git error / empty stdout, falls back to the worktree-anchored absolute
 * `<cwd>/.git/keeper-commit-work.lock` — never a bare relative `.git`.
 */
export async function commitWorkLockPath(
  cwd: string,
  run: GitRunner = gitExec,
): Promise<string> {
  const res = await run(["rev-parse", "--path-format=absolute", "--git-dir"], {
    cwd,
  });
  const gitDir = res.stdout.trim();
  const dir =
    res.code === 0 && gitDir.length > 0 ? gitDir : joinPath(cwd, ".git");
  return joinPath(dir, "keeper-commit-work.lock");
}

/**
 * The base-merge flock path, keyed on the repo's COMMON git dir
 * (`--git-common-dir`) rather than the per-worktree `--git-dir` that
 * {@link commitWorkLockPath} keys on. The plumbing base merge advances
 * `refs/heads/<default>` — a ref that lives in the SHARED common dir, not a
 * per-worktree store — so the common dir is its serialization domain. In the
 * main worktree `--git-common-dir` == `--git-dir`, so this resolves to the SAME
 * `keeper-commit-work.lock` a `keeper commit-work` in that main checkout takes,
 * and the two still collide; a linked lane's commit-work (keyed on its own
 * `--git-dir`) is a distinct path and stays isolated (a lane commit touches its
 * own branch, never default). On a git error / empty stdout, falls back to the
 * worktree-anchored absolute `<cwd>/.git/keeper-commit-work.lock` — never a bare
 * relative `.git`.
 */
export async function baseMergeLockPath(
  cwd: string,
  run: GitRunner = gitExec,
): Promise<string> {
  const res = await run(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd },
  );
  const commonDir = res.stdout.trim();
  const dir =
    res.code === 0 && commonDir.length > 0 ? commonDir : joinPath(cwd, ".git");
  return joinPath(dir, "keeper-commit-work.lock");
}

/**
 * Feature-detect `git merge-tree --write-tree` — the write-tree plumbing mode
 * that lands in git 2.38. The working-tree-free base merge needs it; an older
 * git rejects `--write-tree` (its `merge-tree` speaks only the legacy
 * trivial-merge format the pipeline cannot drive). Parses `git version`
 * (major.minor ≥ 2.38). A failed / unparseable probe reads as UNSUPPORTED so the
 * caller degrades to a transient skip rather than feeding an old git a flag it
 * rejects as an indistinguishable hard error. Bounded so a wedged git never
 * freezes the reconcile cycle.
 */
export async function supportsMergeTreeWriteTree(
  cwd: string,
  run: GitRunner = gitExec,
): Promise<boolean> {
  const r = await run(["version"], { cwd, timeoutMs: GIT_LOCAL_TIMEOUT_MS });
  if (r.code !== 0) {
    return false;
  }
  const m = r.stdout.match(/(\d+)\.(\d+)(?:\.\d+)?/);
  if (m === null) {
    return false;
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 2 || (major === 2 && minor >= 38);
}

/** Resolve the repo's default branch (origin/HEAD, else fallback chain). */
export async function resolveDefaultBranch(
  cwd: string,
  run: GitRunner = gitExec,
): Promise<string> {
  const sym = await run(
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    { cwd },
  );
  const branches = await run(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    { cwd },
  );
  const local =
    branches.code === 0
      ? branches.stdout
          .split("\n")
          .map((b) => b.trim())
          .filter(Boolean)
      : [];
  return resolveDefaultBranchPure(
    { code: sym.code, stdout: sym.stdout },
    local,
  );
}

/** Current branch of `cwd` via `git rev-parse --abbrev-ref HEAD`. */
export async function currentBranch(
  cwd: string,
  run: GitRunner = gitExec,
): Promise<string> {
  // Bound the read (B4): an fsmonitor/FS stall must not wedge the cycle. On a
  // 124 SIGKILL the stdout is empty → "" — a value that never equals a real
  // expected branch, so every caller degrades SAFELY to a branch-mismatch /
  // off-branch defer, never a false "on the right branch".
  const r = await run(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  return r.stdout.trim();
}

/**
 * Abbreviate a branch ref by stripping ONE leading `refs/heads/` prefix; a ref
 * without that prefix passes through unchanged. Matches the abbreviated form
 * {@link currentBranch} returns, so callers comparing a `git worktree list`
 * entry's full ref against a `currentBranch` result compare like with like.
 * Pure — no IO, no clock, never throws.
 */
export function shortBranchName(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

/** True IFF local branch `branch` exists (`git rev-parse --verify refs/heads/<branch>`). */
export async function branchExists(
  cwd: string,
  branch: string,
  run: GitRunner = gitExec,
): Promise<boolean> {
  const r = await run(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd },
  );
  return r.code === 0;
}

/**
 * Delete a local branch (`git branch -D <branch>`), best-effort. Returns `true`
 * when the delete succeeded, `false` when git refused it — most commonly because
 * the branch is still checked out in a live worktree (the caller deletes only
 * AFTER teardown) or never existed. NEVER throws: the prune is a leftover cleanup,
 * never a hard failure, so a refusal is a silent no-op the recover backstop sweeps
 * later. Caller MUST gate on `isAncestorOf` first — `-D` force-deletes regardless
 * of merge state, so an unmerged/diverged branch would lose work.
 */
export async function deleteBranch(
  cwd: string,
  branch: string,
  run: GitRunner = gitExec,
): Promise<boolean> {
  const r = await run(["branch", "-D", branch], {
    cwd,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  return r.code === 0;
}

/**
 * Three-state linked-worktree probe:
 *  - `"linked"` — a linked worktree (git-dir ≠ common-dir, submodule-guarded),
 *  - `"standalone"` — a main / standalone checkout (git-dir == common-dir),
 *  - `"error"` — the git-dir / common-dir probe could not resolve (nonzero exit).
 *
 * The `"error"` case is DISTINCT from `"standalone"` so a caller can DEFER on an
 * inconclusive probe rather than fold the error into "not linked" (fail-open).
 */
export type LinkedWorktreeState = "linked" | "standalone" | "error";

/** Classify `cwd` as a linked worktree, a standalone checkout, or a probe error. */
export async function classifyLinkedWorktree(
  cwd: string,
  run: GitRunner = gitExec,
): Promise<LinkedWorktreeState> {
  const gitDir = await run(
    ["rev-parse", "--path-format=absolute", "--git-dir"],
    { cwd },
  );
  const commonDir = await run(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd },
  );
  if (gitDir.code !== 0 || commonDir.code !== 0) {
    return "error";
  }
  const superproject = await run(
    ["rev-parse", "--show-superproject-working-tree"],
    { cwd },
  );
  return isLinkedWorktreePure({
    gitDir: gitDir.stdout,
    gitCommonDir: commonDir.stdout,
    superproject: superproject.code === 0 ? superproject.stdout : "",
  })
    ? "linked"
    : "standalone";
}

/**
 * True IFF `cwd` is inside a linked git worktree (submodule-guarded). Fails OPEN
 * (a probe error → `false`); a caller that must DEFER on an inconclusive probe
 * uses {@link classifyLinkedWorktree} instead.
 */
export async function isLinkedWorktree(
  cwd: string,
  run: GitRunner = gitExec,
): Promise<boolean> {
  return (await classifyLinkedWorktree(cwd, run)) === "linked";
}

/** Parsed list of every registered worktree (`git worktree list --porcelain`). */
export async function listWorktrees(
  cwd: string,
  run: GitRunner = gitExec,
): Promise<WorktreeEntry[]> {
  const r = await run(["worktree", "list", "--porcelain"], { cwd });
  if (r.code !== 0) {
    return [];
  }
  return parseWorktreeList(r.stdout);
}

/** Prune stale worktree admin entries. ALWAYS `--expire now` (default is 14 days). */
export async function pruneWorktrees(
  cwd: string,
  run: GitRunner = gitExec,
): Promise<void> {
  await run(["worktree", "prune", "--expire", "now"], {
    cwd,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
}

/**
 * The worktree-aware presence probe for a git PSEUDO-REF (`MERGE_HEAD`,
 * `MERGE_AUTOSTASH`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`): the resolved sha when the
 * ref is present, else `null`. Pseudo-refs are PER-WORKTREE, so they are resolved
 * via `git rev-parse --verify --quiet <ref>` and NEVER statted as a hardcoded
 * `.git/<ref>` path. Bounded by {@link GIT_LOCAL_TIMEOUT_MS} (a wedged git hook
 * must never freeze the reconcile cycle); a 124 SIGKILL, any non-zero exit, OR an
 * exit-0-but-empty stdout all read as "absent" (fail-safe — the next cycle re-
 * probes). The single MERGE_HEAD/CHERRY_PICK_HEAD/REVERT_HEAD/MERGE_AUTOSTASH
 * probe every readiness/abort site shares, so the module never grows a fourth
 * ad-hoc merge-state helper.
 */
async function verifyPseudoRef(
  cwd: string,
  run: GitRunner,
  ref: string,
): Promise<string | null> {
  const r = await run(["rev-parse", "--verify", "--quiet", ref], {
    cwd,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (r.code !== 0) {
    return null;
  }
  const sha = r.stdout.trim();
  return sha.length > 0 ? sha : null;
}

/**
 * True IFF `maybeAncestor` is an ancestor of `ref` (`git merge-base --is-ancestor`
 * exit 0). The idempotency guard for the done-but-unmerged backstop: an epic base
 * already merged into the default branch is its ancestor, so the backstop SKIPS it
 * (never a double-merge). A non-existent ref / non-repo cwd → `false` (treat an
 * unresolvable pair as "not merged", the conservative branch — the merge attempt
 * that follows fails loud rather than silently skipping a real orphan).
 */
export async function isAncestorOf(
  cwd: string,
  maybeAncestor: string,
  ref: string,
  run: GitRunner = gitExec,
): Promise<boolean> {
  const r = await run(["merge-base", "--is-ancestor", maybeAncestor, ref], {
    cwd,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  return r.code === 0;
}

/**
 * Tri-state outcome of {@link measureBaseDrift}: a definite magnitude, or a
 * DISTINCT inconclusive signal a caller must DEFER on (never coerce to zero
 * drift, and never a false high-drift reading). Mirrors the containment
 * tri-state in `computeStaleBaseLaneEntries` (autopilot-worker.ts) — a
 * timeout(124)/ambiguous-ref(128)/spawn-fail(127) exit, or an unparseable
 * output, collapses to `inconclusive` rather than a fabricated 0.
 */
export type BaseDriftMeasurement =
  | {
      kind: "measured";
      /** Commits `defaultBranch` has that `base` lacks (`base` is behind by). */
      behindCount: number;
      /**
       * Committer-date (`%ct`, UNIX epoch seconds) of `merge-base(base,
       * defaultBranch)` — a raw snapshot timestamp, NOT a pre-subtracted age
       * (no wall-clock read here); the caller derives age as `now -
       * mergeBaseEpochSeconds`.
       */
      mergeBaseEpochSeconds: number;
    }
  | { kind: "inconclusive" };

/**
 * Measure a lane base's drift from the local default branch: the behind-count
 * (default commits the base lacks, via `git rev-list --left-right --count
 * <base>...<defaultBranch>`) and the merge-base's commit timestamp (via `git
 * show -s --format=%ct $(git merge-base <base> <defaultBranch>)`). Both reads
 * go through the injected {@link GitRunner} seam, bounded by
 * {@link GIT_LOCAL_TIMEOUT_MS}.
 *
 * `--left-right <base>...<defaultBranch>` prints "`<base-only>\t<default-only>`"
 * (left = first ref) — `default-only` (the second count) is the behind-count,
 * since those are the commits on `defaultBranch` that `base` lacks. Getting
 * this order backwards silently inverts every lane's drift reading, so the
 * parse asserts exactly two whitespace-separated non-negative integers.
 *
 * A non-zero exit at ANY step (timeout, ambiguous/unresolvable ref, spawn
 * failure) or unparseable output returns the distinct `inconclusive` kind —
 * never a fabricated magnitude. Never throws.
 */
export async function measureBaseDrift(
  cwd: string,
  base: string,
  defaultBranch: string,
  run: GitRunner = gitExec,
): Promise<BaseDriftMeasurement> {
  const behind = await run(
    ["rev-list", "--left-right", "--count", `${base}...${defaultBranch}`],
    { cwd, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  if (behind.code !== 0) {
    return { kind: "inconclusive" };
  }
  const counts = behind.stdout.trim().split(/\s+/);
  if (counts.length !== 2) {
    return { kind: "inconclusive" };
  }
  const behindCount = Number(counts[1]);
  if (!Number.isInteger(behindCount) || behindCount < 0) {
    return { kind: "inconclusive" };
  }

  const mergeBase = await run(["merge-base", base, defaultBranch], {
    cwd,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (mergeBase.code !== 0) {
    return { kind: "inconclusive" };
  }
  const mergeBaseSha = mergeBase.stdout.trim();
  if (mergeBaseSha.length === 0) {
    return { kind: "inconclusive" };
  }

  const show = await run(["show", "-s", "--format=%ct", mergeBaseSha], {
    cwd,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (show.code !== 0) {
    return { kind: "inconclusive" };
  }
  const mergeBaseEpochSeconds = Number(show.stdout.trim());
  if (!Number.isInteger(mergeBaseEpochSeconds) || mergeBaseEpochSeconds < 0) {
    return { kind: "inconclusive" };
  }

  return { kind: "measured", behindCount, mergeBaseEpochSeconds };
}

/**
 * Existence probe for an on-disk git-dir path (a directory or file like
 * `rebase-merge` or `index.lock`), injectable so the fast tier fakes it with zero
 * fs and zero real git; production uses a real `lstat`. Returns true IFF the path
 * exists (any node type; a broken symlink still counts). NEVER throws — a probe
 * error reads as "absent" (fail-open: an undetectable state is simply not named,
 * never a false wedge). Used ONLY for the non-pseudo-ref in-progress states
 * (rebase dirs, a stale index.lock); pseudo-refs go through {@link verifyPseudoRef}.
 */
export type PathProbe = (path: string) => boolean | Promise<boolean>;

const defaultPathExists: PathProbe = async (p) => {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Classify a present-MERGE_HEAD shared checkout into the `mid-merge` verdict:
 * attach the incoming `mergeHead` sha, a repo-state-only SOLE-ownership `owner`,
 * and whether a MERGE_AUTOSTASH is set. Ownership consults REPO STATE ALONE (the
 * MERGE_MSG is never read — it is attacker-shaped free text): keeper owns the
 * residue IFF `git for-each-ref --points-at=<sha> refs/heads/` (a server-side
 * filter) returns a NON-EMPTY set that is ENTIRELY under `keeper/epic/*`. Any
 * foreign branch at the sha, an empty set, or a probe failure/timeout refuses
 * ownership. A present MERGE_AUTOSTASH ALSO refuses it: `git merge --abort` runs
 * as `git reset --merge` and may be unable to reconstruct the stashed pre-merge
 * changes, so an auto-abort could lose work — never ours to abort. Every probe is
 * bounded (a wedged hook must not freeze the cycle).
 */
async function classifyMidMerge(
  cwd: string,
  run: GitRunner,
  mergeHead: string,
): Promise<MergeReadiness> {
  const refsAt = await run(
    [
      "for-each-ref",
      "--format=%(refname)",
      `--points-at=${mergeHead}`,
      "refs/heads/",
    ],
    { cwd, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  const branches =
    refsAt.code === 0
      ? refsAt.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
      : [];
  const keeperPrefix = `refs/heads/${KEEPER_EPIC_BRANCH_PREFIX}`;
  const soleKeeper =
    refsAt.code === 0 &&
    branches.length > 0 &&
    branches.every((b) => b.startsWith(keeperPrefix));

  const autostashRef = await run(
    ["rev-parse", "--verify", "--quiet", "MERGE_AUTOSTASH"],
    { cwd, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  const autostash =
    autostashRef.code === 0 && autostashRef.stdout.trim().length > 0;
  // A definitive absence exits 1; an exit 0 means present (autostash true). Any
  // OTHER code (124 SIGKILL, 127 spawn-fail, 128 fatal) is an inconclusive probe
  // → refuse ownership (unknown state is never ours to abort).
  const autostashProbeFailed =
    autostashRef.code !== 0 && autostashRef.code !== 1;

  const owner: "keeper" | "foreign" =
    soleKeeper && !autostash && !autostashProbeFailed ? "keeper" : "foreign";
  return { kind: "mid-merge", mergeHead, owner, autostash };
}

/**
 * Name a NON-merge in-progress operation or stale lock on the checkout at `cwd`,
 * mirroring wt-status.c's precedence — a paused rebase (`rebase-merge` /
 * `rebase-apply` dir), cherry-pick (`CHERRY_PICK_HEAD`), revert (`REVERT_HEAD`),
 * or a stale `index.lock` — as a human detail string, or `null` when none. Every
 * such state is FOREIGN-SHAPED: DETECTION ONLY, so the caller names it in a
 * not-ready skip and NEVER remediates (never aborts a rebase/cherry-pick/revert,
 * never removes an index.lock). The pseudo-refs resolve via {@link verifyPseudoRef}
 * (per-worktree, never a hardcoded `.git/` stat); the rebase dirs + index.lock are
 * `pathExists`-probed on the rev-parse-resolved per-worktree git dir. A gitDir
 * probe failure simply skips the on-disk checks (fail-open).
 */
async function nameForeignInProgress(
  cwd: string,
  run: GitRunner,
  pathExists: PathProbe,
): Promise<string | null> {
  const gitDirR = await run(
    ["rev-parse", "--path-format=absolute", "--git-dir"],
    { cwd, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  const gitDir = gitDirR.code === 0 ? gitDirR.stdout.trim() : "";
  if (gitDir.length > 0) {
    if (await pathExists(joinPath(gitDir, "rebase-merge"))) {
      return "rebase in progress (rebase-merge)";
    }
    if (await pathExists(joinPath(gitDir, "rebase-apply"))) {
      return "rebase in progress (rebase-apply)";
    }
  }
  if ((await verifyPseudoRef(cwd, run, "CHERRY_PICK_HEAD")) !== null) {
    return "cherry-pick in progress (CHERRY_PICK_HEAD)";
  }
  if ((await verifyPseudoRef(cwd, run, "REVERT_HEAD")) !== null) {
    return "revert in progress (REVERT_HEAD)";
  }
  if (gitDir.length > 0 && (await pathExists(joinPath(gitDir, "index.lock")))) {
    return "stale index.lock present";
  }
  return null;
}

/**
 * Probe whether `cwd`'s shared main checkout is ready for a base merge: on
 * `expectedBranch`, clean working tree, no merge/rebase/cherry-pick/revert mid-
 * flight, no stale lock. The probes run MOST-SPECIFIC-FIRST so the actionable
 * cause never masks behind a coarser one:
 *  1. `git rev-parse --verify --quiet MERGE_HEAD` — a merge IN FLIGHT →
 *     `{ kind: "mid-merge" }` carrying the sha, a sole-ownership `owner`, and
 *     `autostash`. Probed FIRST because a stopped merge's tree is ALSO dirty:
 *     folding it into `dirty` is the exact wedge this classification fixes.
 *  2. A NAMED non-merge in-progress state (rebase / cherry-pick / revert dir or
 *     ref, or a stale `index.lock`) → `{ kind: "dirty" }` with `detail` naming
 *     it. Foreign-shaped, detection only.
 *  3. `git status --porcelain --untracked-files=no` — any remaining output
 *     (uncommitted edits, staged work) → `{ kind: "dirty" }`. Probed before the
 *     branch check so a checkout that is BOTH dirty and off its expected branch
 *     surfaces the DIRTY cause (the actionable one) rather than masking it behind
 *     a bare off-branch verdict. Untracked files are EXCLUDED: a benign untracked
 *     file (editor temp, un-ignored artifact, a `.env`) a merge cannot disturb
 *     must not force a never-finalizing skip-and-retry. A non-zero status exit is
 *     itself treated as not-ready (`dirty`, conservative).
 *  4. `git rev-parse --abbrev-ref HEAD` — a CLEAN tree off `expectedBranch`
 *     (incl. a detached HEAD, which reports `HEAD`) → `{ kind: "off-branch" }`.
 * When `incomingBranch` is supplied, a clean tree gets ONE further probe: a
 * would-clobber intersection (`incomingBranch`'s tracked paths ∩ the main
 * checkout's untracked files) — a non-empty overlap a `git merge` would hard-
 * abort on returns `{ kind: "would-clobber" }`. Omitting it skips that probe
 * (the bare clean-tree verdict). Otherwise `{ kind: "ready" }`. Pure git reads —
 * never a fetch / write. `run` precedes `incomingBranch` so existing two-/three-
 * arg callers keep the bare-readiness behavior unchanged; `pathExists` is
 * injectable so the fast tier fakes the on-disk in-progress checks. The caller
 * degrades a not-`ready` result to a clean skip-and-retry, never a merge.
 */
export async function mergeReadiness(
  cwd: string,
  expectedBranch: string,
  run: GitRunner = gitExec,
  incomingBranch?: string,
  pathExists: PathProbe = defaultPathExists,
): Promise<MergeReadiness> {
  // Mid-merge FIRST — a stopped merge leaves MERGE_HEAD AND a dirty tree, so the
  // MERGE_HEAD probe MUST precede the dirty check or the wedge folds into a
  // generic `dirty` the recover/finalize pass skip-retries forever.
  const mergeHead = await verifyPseudoRef(cwd, run, "MERGE_HEAD");
  if (mergeHead !== null) {
    return classifyMidMerge(cwd, run, mergeHead);
  }
  // Then the NAMED non-merge in-progress states (rebase / cherry-pick / revert /
  // stale index.lock) — probed before the porcelain dirty check so the SPECIFIC
  // cause wins over generic dirt. Foreign-shaped: detection only, never aborted.
  const foreign = await nameForeignInProgress(cwd, run, pathExists);
  if (foreign !== null) {
    return { kind: "dirty", detail: foreign };
  }
  // Dirty check — a dirty+off-branch checkout must report the actionable DIRTY
  // cause, not mask it as off-branch. Bound the read (B4); a 124 timeout
  // (non-zero) folds through the `code !== 0` arm to `dirty` — a SAFE
  // not-ready/retry-skip, never a false clean.
  const status = await run(["status", "--porcelain", "--untracked-files=no"], {
    cwd,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  const detail = (status.stdout + status.stderr).trim();
  if (status.code !== 0 || detail.length > 0) {
    return { kind: "dirty", detail };
  }
  // Clean tree — now the branch check. Off `expectedBranch` (incl. a detached
  // mid-rebase HEAD, which reports `HEAD`) → off-branch.
  const head = await currentBranch(cwd, run);
  if (head !== expectedBranch) {
    return { kind: "off-branch", head };
  }
  if (incomingBranch !== undefined && incomingBranch.length > 0) {
    const clobbered = await wouldClobberUntracked(cwd, incomingBranch, run);
    // A timed-out clobber probe degrades to a not-ready retry-skip (`dirty`),
    // NEVER a false "no clobber" that could let a would-clobber merge through.
    if (clobbered.kind === "timeout") {
      return { kind: "dirty", detail: "would-clobber probe timed out" };
    }
    if (clobbered.paths.length > 0) {
      return { kind: "would-clobber", paths: clobbered.paths };
    }
  }
  return { kind: "ready" };
}

/**
 * The paths a merge of `incomingBranch` into the main checkout would OVERWRITE:
 * `git ls-files --others --exclude-standard` (main's untracked, ignore-aware) ∩
 * `git ls-tree -r --name-only <incomingBranch>` (the incoming tracked tree). A
 * non-empty result is exactly the set `git merge` refuses to clobber and aborts
 * on. `git merge-tree` is NOT used — it never sees untracked files. A non-timeout
 * probe failure folds to an EMPTY result (no proven collision → let the merge
 * run; its own abort is the loud backstop), never a manufactured block. Both
 * reads are bounded by GIT_LOCAL_TIMEOUT_MS (B4); a 124 SIGKILL surfaces as
 * `{ kind: "timeout" }` so the caller degrades to a not-ready retry-skip rather
 * than a false "no clobber" — an fsmonitor/FS stall must never let a would-
 * clobber merge through. Pure git reads.
 */
type ClobberProbe = { kind: "ok"; paths: string[] } | { kind: "timeout" };

async function wouldClobberUntracked(
  cwd: string,
  incomingBranch: string,
  run: GitRunner,
): Promise<ClobberProbe> {
  const untrackedR = await run(["ls-files", "--others", "--exclude-standard"], {
    cwd,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (untrackedR.code === GIT_SPAWN_TIMEOUT_CODE) {
    return { kind: "timeout" };
  }
  if (untrackedR.code !== 0) {
    return { kind: "ok", paths: [] };
  }
  const untracked = new Set(
    untrackedR.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  );
  if (untracked.size === 0) {
    return { kind: "ok", paths: [] };
  }
  const incomingR = await run(
    ["ls-tree", "-r", "--name-only", incomingBranch],
    {
      cwd,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    },
  );
  if (incomingR.code === GIT_SPAWN_TIMEOUT_CODE) {
    return { kind: "timeout" };
  }
  if (incomingR.code !== 0) {
    return { kind: "ok", paths: [] };
  }
  const clobbered: string[] = [];
  for (const raw of incomingR.stdout.split("\n")) {
    const path = raw.trim();
    if (path.length > 0 && untracked.has(path)) {
      clobbered.push(path);
    }
  }
  return { kind: "ok", paths: clobbered };
}

/**
 * Verdict of {@link classifyPremergeRedundancy}: whether the dirt sitting in a base
 * lane worktree is a PROVABLY-REDUNDANT leak of the incoming rib's content — the
 * fan-in merge would re-apply exactly what the working tree already holds, so
 * restoring the proven paths to HEAD then merging is a lossless no-op on them.
 *
 *  - `redundant` — EVERY dirty tracked path is provably redundant vs `incomingBranch`:
 *    its FILTERED working-tree blob (`git hash-object --path`, `.gitattributes` clean
 *    filters + eol normalization applied — a raw byte compare would falsely differ
 *    under CRLF/`autocrlf`/smudge-clean) equals the incoming branch's committed blob
 *    for that path, that incoming blob differs from HEAD (so the merge genuinely
 *    re-applies it), the change is UNSTAGED-only (index == HEAD), and the mode is
 *    unchanged. `paths` is the exact restore pathspec (possibly empty when a
 *    stat-only refresh already cleaned the tree).
 *  - `not-redundant` — at least one dirty path is NOT provably redundant: an add
 *    (no HEAD blob), a delete, a mode change (incl. a blob-identical mode-only flip),
 *    a staged change, an untracked file, a rename/copy, an unmerged path, a blob that
 *    differs from the incoming, an incoming blob equal to HEAD, OR any probe
 *    failure/timeout. `reason` names the first disqualifier for the retry-skip log.
 *    NEVER discard on this verdict — the dirt may carry real work.
 */
export type PremergeRedundancy =
  | { kind: "redundant"; paths: string[] }
  | { kind: "not-redundant"; reason: string };

/**
 * Classify whether the dirt in base worktree `cwd` is a provably-redundant leak of
 * `incomingBranch`'s content (see {@link PremergeRedundancy}). Pure git READS — a
 * single `git status --porcelain=v2 -z` to enumerate + pre-classify the dirty set
 * (mode + HEAD/index hashes come straight off the v2 record, so an add / delete /
 * mode change / staged path is disqualified with NO extra spawn), then per surviving
 * candidate a filtered `git hash-object --path` and an incoming-blob `rev-parse`.
 * Any non-zero / SIGKILL-timeout probe fails to `not-redundant` (fail SAFE — a doubt
 * never licenses a discard). The caller runs this UNDER the commit-work flock (after
 * an `update-index --really-refresh`); it takes no lock itself. Bounded (B4).
 */
export async function classifyPremergeRedundancy(
  cwd: string,
  incomingBranch: string,
  run: GitRunner = gitExec,
): Promise<PremergeRedundancy> {
  const status = await run(
    ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
    { cwd, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  if (status.code !== 0) {
    return {
      kind: "not-redundant",
      reason:
        status.code === GIT_SPAWN_TIMEOUT_CODE
          ? "git status probe timed out"
          : `git status probe failed (exit ${status.code})`,
    };
  }
  // Parse the NUL-framed porcelain v2 records. An ordinary changed entry is
  // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` (mode + hash fields never contain
  // spaces, so the path is the tail after the 8th field). Any OTHER record kind — an
  // untracked `?`, a rename/copy `2`, an unmerged `u` — or a non-plain `1` (add /
  // delete / mode change / staged) is a hard disqualifier: bail immediately.
  const candidates: { path: string; headHash: string }[] = [];
  const fields = status.stdout.split("\0");
  for (const rec of fields) {
    if (rec.length === 0) {
      continue;
    }
    const kind = rec[0];
    if (kind === "1") {
      const parts = rec.split(" ");
      const mH = parts[3];
      const mW = parts[5];
      const hH = parts[6];
      const hI = parts[7];
      const path = parts.slice(8).join(" ");
      if (
        mH === undefined ||
        mW === undefined ||
        hH === undefined ||
        hI === undefined ||
        path.length === 0
      ) {
        return {
          kind: "not-redundant",
          reason: "unparsable porcelain v2 record",
        };
      }
      if (mH === "000000") {
        return {
          kind: "not-redundant",
          reason: `added path not in HEAD: ${path}`,
        };
      }
      if (mW === "000000") {
        return { kind: "not-redundant", reason: `deleted path: ${path}` };
      }
      if (mH !== mW) {
        return {
          kind: "not-redundant",
          reason: `mode change on ${path} (${mH} → ${mW})`,
        };
      }
      if (hI !== hH) {
        return { kind: "not-redundant", reason: `staged change on ${path}` };
      }
      candidates.push({ path, headHash: hH });
    } else if (kind === "?") {
      return {
        kind: "not-redundant",
        reason: `untracked path: ${rec.slice(2)}`,
      };
    } else if (kind === "2") {
      return { kind: "not-redundant", reason: `rename/copy: ${rec.slice(2)}` };
    } else if (kind === "u") {
      return {
        kind: "not-redundant",
        reason: `unmerged path: ${rec.slice(2)}`,
      };
    }
    // A `# branch.*` header (only with --branch, which we do not pass) or any other
    // line is ignored — never a candidate.
  }
  // Every dirty entry is an unstaged, non-mode ordinary change. Prove each redundant:
  // its filtered working-tree blob == the incoming committed blob AND that blob != HEAD.
  const provenPaths: string[] = [];
  for (const { path, headHash } of candidates) {
    // The FILTERED working-tree blob — `--path=<p>` applies the path's clean filters
    // + eol normalization exactly as `git add` would; the file to hash rides after
    // `--` (an attacker-influenceable path can never be read as an option).
    const wt = await run(["hash-object", `--path=${path}`, "--", path], {
      cwd,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    if (wt.code !== 0) {
      return {
        kind: "not-redundant",
        reason:
          wt.code === GIT_SPAWN_TIMEOUT_CODE
            ? `hash-object timed out for ${path}`
            : `hash-object failed for ${path} (exit ${wt.code})`,
      };
    }
    const wtHash = wt.stdout.trim();
    // The incoming rib's committed blob for the same path — `refs/heads/` guards
    // against a DWIM remote/tag match, `--end-of-options` against a `-`-leading name.
    const inc = await run(
      [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `refs/heads/${incomingBranch}:${path}`,
      ],
      { cwd, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
    );
    if (inc.code === GIT_SPAWN_TIMEOUT_CODE) {
      return {
        kind: "not-redundant",
        reason: `incoming blob probe timed out for ${path}`,
      };
    }
    if (inc.code !== 0) {
      return {
        kind: "not-redundant",
        reason: `incoming ${incomingBranch} has no blob for ${path}`,
      };
    }
    const incHash = inc.stdout.trim();
    if (wtHash.length === 0 || wtHash !== incHash) {
      return {
        kind: "not-redundant",
        reason: `working-tree blob for ${path} differs from incoming ${incomingBranch}`,
      };
    }
    if (incHash === headHash) {
      // The incoming blob equals HEAD — the merge would not re-apply this path, so
      // restoring to HEAD is NOT a no-op the merge undoes. (Unreachable given the
      // status entry is dirty, but proven, not assumed.)
      return {
        kind: "not-redundant",
        reason: `incoming blob for ${path} equals HEAD (merge would not re-apply it)`,
      };
    }
    provenPaths.push(path);
  }
  return { kind: "redundant", paths: provenPaths };
}

/**
 * Outcome of {@link losslessPremergeClean}.
 *  - `ready` — the base worktree is clean on its branch and safe to merge: the dirt
 *    was a provably-redundant leak restored to HEAD, or a stat-only refresh already
 *    cleaned it.
 *  - `retry` — the base could not be losslessly cleaned (not provably redundant, a
 *    path attributed to a live job, the attribution set unavailable, a lock / local
 *    timeout, or a restore / re-probe failure). The caller degrades to a NON-STICKY
 *    retry-skip and logs `reason`; NEVER a merge, NEVER a discard.
 */
export type PremergeCleanOutcome =
  | { kind: "ready" }
  | { kind: "retry"; reason: string };

/**
 * Losslessly clean a DIRTY base lane worktree before a fan-in merge, IFF the dirt is
 * a provably-redundant leak of `incomingBranch` and NONE of it is attributed to a
 * live job — otherwise a retry-skip (never a blind merge, never a discard). The
 * ordered contract:
 *
 *  1. `liveAttributedDirty === null` (the reconciler could not read attribution) →
 *     retry (assume live-attributed — do-not-discard).
 *  2. Take the per-worktree commit-work flock (the restore + index refresh mutate the
 *     index) via the bounded {@link LockAcquirer}; a lock-timeout → retry.
 *  3. `git update-index -q --really-refresh` collapses stat-only (mtime) false
 *     positives so {@link classifyPremergeRedundancy} sees genuine content dirt only
 *     (a non-zero exit is EXPECTED on a dirty tree; only a SIGKILL/spawn-fail stalls).
 *  4. Probe redundancy; a non-`redundant` verdict → retry with its reason.
 *  5. Do-not-discard if any proven path is in `liveAttributedDirty` (a live worker may
 *     re-touch it) → retry.
 *  6. `git restore --source=HEAD --worktree -- <exact proven pathspec>` (never a bare
 *     `git restore .`; the index is left alone — the probe proved index == HEAD).
 *  7. RE-PROBE {@link mergeReadiness}; ONLY a `ready` base returns `ready`. Anything
 *     else → retry.
 *
 * The flock is released before returning, so the caller's own `mergeBranchInto`
 * (which re-takes it) never self-deadlocks. `acquireLock` is injectable for the fast
 * tier; production uses the deadline-bounded commit-work flock.
 */
export async function losslessPremergeClean(
  worktreePath: string,
  expectedBranch: string,
  incomingBranch: string,
  liveAttributedDirty: ReadonlySet<string> | null,
  run: GitRunner = gitExec,
  acquireLock: LockAcquirer = defaultLockAcquirer,
): Promise<PremergeCleanOutcome> {
  if (liveAttributedDirty === null) {
    return {
      kind: "retry",
      reason: `live-job attribution unavailable for ${worktreePath} — not discarding the dirty base`,
    };
  }
  const lockPath = await commitWorkLockPath(worktreePath, run);
  const lock = await acquireLock(lockPath);
  if (lock === null) {
    return {
      kind: "retry",
      reason: `could not acquire the commit-work lock for ${worktreePath} within the deadline (a concurrent holder)`,
    };
  }
  try {
    // `--really-refresh` exits NON-ZERO when paths need updating (i.e. the tree is
    // dirty — expected here), so only a SIGKILL timeout / spawn failure is a stall.
    const refreshed = await run(["update-index", "-q", "--really-refresh"], {
      cwd: worktreePath,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    if (
      refreshed.code === GIT_SPAWN_TIMEOUT_CODE ||
      refreshed.code === GIT_SPAWN_FAILED_CODE
    ) {
      return {
        kind: "retry",
        reason: `git update-index --really-refresh stalled for ${worktreePath} (exit ${refreshed.code})`,
      };
    }
    const probe = await classifyPremergeRedundancy(
      worktreePath,
      incomingBranch,
      run,
    );
    if (probe.kind !== "redundant") {
      return { kind: "retry", reason: probe.reason };
    }
    const attributed = probe.paths.filter((p) => liveAttributedDirty.has(p));
    if (attributed.length > 0) {
      return {
        kind: "retry",
        reason: `dirty base path(s) attributed to a live job: ${attributed.join(", ")}`,
      };
    }
    if (probe.paths.length > 0) {
      const restore = await run(
        ["restore", "--source=HEAD", "--worktree", "--", ...probe.paths],
        { cwd: worktreePath, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
      );
      if (restore.code !== 0) {
        return {
          kind: "retry",
          reason: `git restore failed for ${worktreePath} (exit ${restore.code})`,
        };
      }
    }
    const reready = await mergeReadiness(
      worktreePath,
      expectedBranch,
      run,
      incomingBranch,
    );
    if (reready.kind !== "ready") {
      return {
        kind: "retry",
        reason: `base ${worktreePath} still not ready after restore (${reready.kind})`,
      };
    }
    return { kind: "ready" };
  } finally {
    lock.release();
  }
}

/**
 * Tri-state verdict of {@link remotePushFastForwardable}:
 *  - `"fast-forwardable"` — the cached `origin/<default>` is an ancestor of local
 *    → a push fast-forwards; safe to push.
 *  - `"non-fast-forwardable"` — the cached ref resolves but is NOT an ancestor →
 *    origin moved ahead; a push would be rejected non-fast-forward → the caller
 *    degrades to a skip-and-retry (NEVER an auto-fetch / rebase / force).
 *  - `"unknown"` — the remote-tracking ref does not resolve (a never-pushed
 *    default) → DEFER, do NOT block. The authoritative turn-key probe
 *    (`remotePushTurnKey`, run FIRST) already admits a legitimate first push via
 *    its dry-run; treating an unresolved ref as a hard non-FF would permanently
 *    deadlock a never-pushed-default repo even after turn-key passes.
 */
export type RemotePushFastForwardability =
  | "fast-forwardable"
  | "non-fast-forwardable"
  | "unknown";

/**
 * Whether pushing local `defaultBranch` to `origin/<defaultBranch>` would
 * FAST-FORWARD, decided from the CACHED remote-tracking ref ONLY — no network
 * fetch. Returns a {@link RemotePushFastForwardability} tri-state: the caller
 * blocks ONLY on `"non-fast-forwardable"`; `"unknown"` (unresolved ref) defers to
 * the turn-key probe rather than minting a false permanent non-FF skip.
 */
export async function remotePushFastForwardable(
  cwd: string,
  defaultBranch: string,
  run: GitRunner = gitExec,
): Promise<RemotePushFastForwardability> {
  const remoteRef = `refs/remotes/origin/${defaultBranch}`;
  const exists = await run(["rev-parse", "--verify", "--quiet", remoteRef], {
    cwd,
  });
  if (exists.code !== 0) {
    return "unknown"; // unresolved tracking ref (never-pushed default) → defer
  }
  return (await isAncestorOf(cwd, remoteRef, defaultBranch, run))
    ? "fast-forwardable"
    : "non-fast-forwardable";
}

/**
 * The branch-ref prefix every keeper worktree lane checks out: the base
 * `keeper/epic/<epic_id>` and the ribs `keeper/epic/<epic_id>--<task_id>`. The
 * single classifier of a keeper-managed lane — a worktree on a branch under this
 * prefix is keeper's to recover/finalize; anything else (a foreign
 * `.claude/worktrees/<name>` lane from another tool) is NOT.
 */
export const KEEPER_EPIC_BRANCH_PREFIX = "keeper/epic/";

/**
 * Whether a `git worktree list` entry is a KEEPER-managed lane — checked out on a
 * `keeper/epic/<...>` branch (the base or a rib). The recovery sweep's pass-1
 * abort-merge MUST gate on this: enumerating ALL registered linked worktrees and
 * abort-merging each touches FOREIGN lanes (e.g. a `.claude/worktrees/<name>`
 * worktree another tool registered) — and if such a lane's dir was removed out
 * from under git, the `git` spawn against its vanished cwd ENOENTs. A keeper lane
 * is DEFINED by its branch, so classify on the branch ref, not the path. The
 * entry `branch` is a full `refs/heads/...` ref (or `null` when detached → never
 * a lane). Pure — fast-tier covered.
 */
export function isKeeperLaneEntry(entry: WorktreeEntry): boolean {
  if (entry.branch === null) {
    return false;
  }
  const short = shortBranchName(entry.branch);
  return short.startsWith(KEEPER_EPIC_BRANCH_PREFIX);
}

/**
 * The epic id a keeper lane worktree entry belongs to — the base
 * (`keeper/epic/<epic_id>`) OR a rib (`keeper/epic/<epic_id>--<task_id>`, split on
 * the FIRST `--`), recovered from the entry's branch ref. `null` for a
 * detached/non-keeper entry (mirrors {@link isKeeperLaneEntry}'s classification).
 * Lets the recover pass gate a per-lane action on WHICH epic owns the lane (e.g.
 * skip the pass-1 abort while that epic's autonomous merge-resolver is mid-merge).
 * Pure.
 */
export function epicIdFromKeeperLaneEntry(entry: WorktreeEntry): string | null {
  if (entry.branch === null) {
    return null;
  }
  const short = shortBranchName(entry.branch);
  if (!short.startsWith(KEEPER_EPIC_BRANCH_PREFIX)) {
    return null;
  }
  const rest = short.slice(KEEPER_EPIC_BRANCH_PREFIX.length);
  if (rest.length === 0) {
    return null;
  }
  const sep = rest.indexOf("--");
  if (sep === 0) return null;
  return sep === -1 ? rest : rest.slice(0, sep);
}

/**
 * Enumerate the epic BASE branches (`keeper/epic/<epic_id>`) that still exist as
 * local refs — the done-but-unmerged backstop's candidate set, sourced from LIVE
 * git (never a window-bounded projection read), so a daemon restart between an
 * epic-done and its merge-to-default can never orphan the merge. RIB branches
 * (`keeper/epic/<epic_id>--<task_id>`, distinguished by the `--` separator) are
 * EXCLUDED: only the base merges into the default branch. Returns each match as
 * `{ branch, epicId }` with the `keeper/epic/` prefix stripped to recover the
 * epic id. Order is git's ref order (stable enough; the caller cross-references
 * each id independently so order is not load-bearing).
 */
export async function listEpicBaseBranches(
  cwd: string,
  run: GitRunner = gitExec,
): Promise<{ branch: string; epicId: string }[]> {
  // The merge candidate set is BASES ONLY — filter the ribs out so a rib never
  // reaches the merge-to-default path (a misclassified rib would push lane work
  // to default). The CLEANUP enumeration (`listEpicLaneBranches`) keeps the ribs.
  const lanes = await listEpicLaneBranches(cwd, run);
  return lanes
    .filter((l) => !l.isRib)
    .map(({ branch, epicId }) => ({ branch, epicId }));
}

/**
 * Enumerate EVERY keeper lane branch — the epic BASES (`keeper/epic/<epic_id>`)
 * AND the ribs (`keeper/epic/<epic_id>--<task_id>`) — that still exists as a local
 * ref, each tagged `isRib`. The CLEANUP enumeration the teardown/recover prune
 * sweeps off: a leaked rib (one a snapshot's `laneOrder` never carried, or a
 * crash orphaned) is only prunable once it is SEEN here. Sourced from LIVE git
 * (`git for-each-ref refs/heads/keeper/epic`, the prefix match folding in every
 * descendant ref), so it survives a daemon restart. The `--` separator splits a
 * rib's `<epic_id>--<task_id>` so `epicId` is recovered for BOTH a base and a
 * rib. {@link listEpicBaseBranches} filters this to the merge-eligible bases.
 */
export async function listEpicLaneBranches(
  cwd: string,
  run: GitRunner = gitExec,
): Promise<{ branch: string; epicId: string; isRib: boolean }[]> {
  const r = await run(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads/keeper/epic"],
    { cwd },
  );
  if (r.code !== 0) {
    return [];
  }
  const out: { branch: string; epicId: string; isRib: boolean }[] = [];
  for (const raw of r.stdout.split("\n")) {
    const branch = raw.trim();
    if (!branch.startsWith(KEEPER_EPIC_BRANCH_PREFIX)) {
      continue;
    }
    const rest = branch.slice(KEEPER_EPIC_BRANCH_PREFIX.length);
    if (rest.length === 0) {
      continue;
    }
    // A rib carries the `--` separator (`<epic_id>--<task_id>`); a base does not,
    // so its whole `rest` IS the epic id. Split on the FIRST `--` to recover the
    // epic id of a rib.
    const sep = rest.indexOf("--");
    if (sep === -1) {
      out.push({ branch, epicId: rest, isRib: false });
    } else if (sep > 0) {
      out.push({ branch, epicId: rest.slice(0, sep), isRib: true });
    }
  }
  return out;
}

/**
 * The discriminated result of {@link enumerateEpicLaneBranches}: the FULL set of
 * `keeper/epic/<...>` lane short-names present as local refs (`ok`), or a
 * code-surfaced enumeration FAILURE (`ok:false`) — a non-zero `for-each-ref` exit
 * OR a {@link GIT_LOCAL_TIMEOUT_MS} SIGKILL. The discriminant is the whole point:
 * unlike {@link listEpicLaneBranches} (which collapses an error to `[]`, making a
 * lane-less repo and a failed enumeration indistinguishable) and
 * {@link branchExists} (error→`false`), a caller MUST be able to tell "this branch
 * is DEFINITIVELY absent" (a SUCCESSFUL enumeration that omits it) from "I could
 * not enumerate" (defer). The cross-epic merge-gate's absent-implies-merged arm is
 * sound ONLY on the former.
 */
export type EpicLaneBranchSet =
  | { ok: true; branches: Set<string> }
  | { ok: false };

/**
 * Enumerate EVERY `keeper/epic/<...>` lane short-name (bases AND ribs) present as
 * a local ref, as a code-surfacing discriminated result bounded by
 * {@link GIT_LOCAL_TIMEOUT_MS}. On a non-zero `for-each-ref` exit OR a 124 SIGKILL
 * timeout → `{ ok: false }` (the caller DEFERS — never reads a failed enumeration
 * as "the branch is absent"); on success → `{ ok: true; branches }` carrying the
 * full short-name set (e.g. `keeper/epic/fn-1-foo`), which MAY be empty (a repo
 * with no live lanes — a DEFINITIVE absence, distinct from a failure). The
 * absent-implies-merged half of the cross-epic merge-gate (keeper deletes a base
 * only once it is an ancestor of default) needs exactly this present/absent/
 * inconclusive distinction, which {@link listEpicLaneBranches} (error→`[]`, no
 * timeout) cannot provide.
 */
export async function enumerateEpicLaneBranches(
  cwd: string,
  run: GitRunner = gitExec,
): Promise<EpicLaneBranchSet> {
  const r = await run(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads/keeper/epic"],
    { cwd, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  if (r.code !== 0) {
    return { ok: false };
  }
  const branches = new Set<string>();
  for (const raw of r.stdout.split("\n")) {
    const branch = raw.trim();
    if (branch.startsWith(KEEPER_EPIC_BRANCH_PREFIX)) {
      branches.add(branch);
    }
  }
  return { ok: true, branches };
}

/**
 * Ensure a worktree exists at `path` on `branch`, forked off `commitish` (the
 * parent lane's committed tip, or the base branch for a root). Idempotent + crash-
 * recoverable:
 *  - Already registered at `path` on `branch` → no-op.
 *  - Registered at `path` on a DIFFERENT branch → a conflicting stale entry; the
 *    caller must not let two lanes collide on one path, so we surface it by
 *    throwing (a producer bug, not a transient).
 *  - Path absent but a stale admin entry lingers (post-crash) → `prune --expire
 *    now` then re-add. `git worktree add -b <branch> <path> <commitish>` creates
 *    the branch; if the branch already exists (a prior crashed add), retry
 *    without `-b` to check it out.
 *
 * The `commitish` is required: a worktree forked off a non-deterministic point
 * would break re-derivation, so the producer always passes the parent's tip.
 */
export async function ensureWorktree(
  cwd: string,
  path: string,
  branch: string,
  commitish: string,
  run: GitRunner = gitExec,
): Promise<void> {
  const existing = await listWorktrees(cwd, run);
  const atPath = existing.find((e) => samePath(e.path, path));
  if (atPath !== undefined) {
    const onBranch = atPath.branch === `refs/heads/${branch}`;
    if (onBranch) {
      return; // already what we want
    }
    throw new Error(
      `worktree-git: path ${path} is already a worktree on ${atPath.branch ?? "(detached)"}, expected ${branch}`,
    );
  }

  // No registered entry at `path`. A post-crash orphan (dir gone, admin entry
  // stale, or vice-versa) blocks `add`; prune first, idempotently.
  await pruneWorktrees(cwd, run);

  // Does `branch` already exist (a prior crashed add left it)? Check it out into
  // the new path instead of re-creating it; else create the branch off commitish.
  const branchExists = existing.some(
    (e) => e.branch === `refs/heads/${branch}`,
  );
  const hasBranch =
    branchExists ||
    (
      await run(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
        cwd,
      })
    ).code === 0;

  const args = hasBranch
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", "-b", branch, path, commitish];
  const r = await run(args, { cwd });
  if (r.code !== 0) {
    throw new Error(
      `worktree-git: git ${args.join(" ")} failed (code ${r.code}): ${r.stderr.trim()}`,
    );
  }
}

/** Outcome of the consolidated guarded merge-abort helper. */
type MergeAbortOutcome =
  /** No `MERGE_HEAD` was present — nothing was in flight to abort. */
  | { kind: "no-merge" }
  /** A merge was in flight and the `git merge --abort` cleared it cleanly. */
  | { kind: "aborted" }
  /**
   * A MERGE_HEAD was present but the `git merge --abort` ITSELF returned non-zero
   * or was SIGKILLed at {@link GIT_LOCAL_TIMEOUT_MS}: the mid-merge residue did
   * NOT clear. `stderr` carries the abort's own output (or a timeout note).
   */
  | { kind: "abort-failed"; stderr: string };

/**
 * The single MERGE_HEAD-guarded `git merge --abort` — the consolidated core the
 * whole module's abort paths share. Aborts IFF a merge is actually in flight (a
 * `MERGE_HEAD` exists via {@link verifyPseudoRef}), so a merge that never started
 * is not spuriously "aborted". Run on BOTH the conflict and the local-timeout
 * (SIGKILLed) exits of {@link mergeBranchInto} and behind the boolean
 * {@link abortInterruptedMerge} recover wrapper — a killed merge can leave
 * MERGE_HEAD/partial state that would read as a spurious conflict next cycle. The
 * probe AND the abort are BOTH bounded by GIT_LOCAL_TIMEOUT_MS (the old recover
 * abort was unbounded). Unlike the old void-returning helper, the abort's OUTCOME
 * is surfaced: a failed/timed-out abort returns `abort-failed` (the wedge signal)
 * instead of being silently swallowed, so the caller can escalate rather than
 * skip-retry a checkout that never self-heals.
 */
async function abortMergeIfInProgress(
  cwd: string,
  run: GitRunner,
): Promise<MergeAbortOutcome> {
  if ((await verifyPseudoRef(cwd, run, "MERGE_HEAD")) === null) {
    return { kind: "no-merge" }; // no merge in flight → nothing to abort
  }
  const abort = await run(["merge", "--abort"], {
    cwd,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (abort.code === 0) {
    return { kind: "aborted" };
  }
  const out = (abort.stdout + abort.stderr).trim();
  const stderr =
    abort.code === GIT_SPAWN_TIMEOUT_CODE
      ? `git merge --abort timed out${out.length > 0 ? `: ${out}` : ""}`
      : out.length > 0
        ? out
        : `git merge --abort failed (exit ${abort.code})`;
  return { kind: "abort-failed", stderr };
}

/**
 * Abort an interrupted merge at `cwd` IFF a `MERGE_HEAD` is present (guarded so a
 * tree with no merge in flight is never spuriously `merge --abort`ed). Returns
 * `true` when a merge WAS in flight (an abort was attempted — cleanly or not),
 * `false` when there was nothing to abort. The recover sweep's pass-1 entry point:
 * the caller follows a `true` with a `pruneWorktrees` and lets the next cycle
 * re-attempt the merge (level-triggered retry, no in-process self-heal). A thin
 * boolean adapter over the consolidated {@link abortMergeIfInProgress} core, so
 * the abort is now BOUNDED by GIT_LOCAL_TIMEOUT_MS (it was previously unbounded).
 */
export async function abortInterruptedMerge(
  cwd: string,
  run: GitRunner = gitExec,
): Promise<boolean> {
  return (await abortMergeIfInProgress(cwd, run)).kind !== "no-merge";
}

/**
 * Merge `sourceBranch` into the branch checked out at `worktreePath`, SEQUENTIAL
 * PAIRWISE — one source per call, NEVER octopus. Acquires the shared commit-work
 * flock for the merge window so it serializes against agent commits.
 *
 *  - If `sourceBranch` is already an ancestor of HEAD (`merge-base --is-ancestor`
 *    exit 0) → `{ kind: "already-merged" }`, no merge attempted (idempotent).
 *  - Else `git merge --no-edit <sourceBranch>`; on conflict, abort via a
 *    `MERGE_HEAD`-guarded `git merge --abort` and return `{ kind: "conflict" }`.
 *    The abort is guarded so a merge that failed for a non-conflict reason (and
 *    left no MERGE_HEAD) is not "aborted" spuriously. When the guarded abort
 *    ITSELF fails or times out, the checkout is left mid-merge → the distinct
 *    `{ kind: "abort-failed" }` wedge signal instead of a silently-swallowed
 *    conflict.
 *
 * The flock path comes from the worktree's own git dir, so a merge serializes
 * only against a commit-work in the SAME worktree; disjoint lanes take distinct
 * locks and never block each other.
 */
export async function mergeBranchInto(
  worktreePath: string,
  sourceBranch: string,
  run: GitRunner = gitExec,
  acquireLock: LockAcquirer = defaultLockAcquirer,
): Promise<MergeResult> {
  // Phantom-lane guard: probe the source ref BEFORE any lock or merge-base. On a
  // mixed-mode board a fan-in can reference a lane branch that was never created
  // (its task's work landed on the default branch), and that unresolvable source
  // is a lossless no-op — NOT a conflict. Mirror `branchExists`'s `refs/heads/`
  // idiom (so a phantom name cannot DWIM-match a remote-tracking ref/tag);
  // `^{commit}` peels tags and `--end-of-options` guards a `-`-leading name.
  // Only THIS non-zero exit yields `missing-source`; a later merge/is-ancestor
  // failure stays a genuine error.
  const sourceExists = await run(
    [
      "rev-parse",
      "--quiet",
      "--verify",
      "--end-of-options",
      `refs/heads/${sourceBranch}^{commit}`,
    ],
    { cwd: worktreePath, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  // A timed-out probe is a transient stall (a blocking hook is unusual on
  // rev-parse, but bound it anyway) — degrade to a retry-skip rather than let a
  // 124 masquerade as `missing-source` (a permanent lossless skip).
  if (sourceExists.code === GIT_SPAWN_TIMEOUT_CODE) {
    return { kind: "local-timeout" };
  }
  if (sourceExists.code !== 0) {
    return { kind: "missing-source" };
  }

  // Idempotent skip: already merged in (or fast-forward-equal). A timed-out
  // is-ancestor (124) falls through to the bounded lock+merge below, which
  // re-derives the verdict (an already-merged source merges as "Already up to
  // date" → `merged`) — so it needs no distinct timeout branch here.
  const isAncestor = await run(
    ["merge-base", "--is-ancestor", sourceBranch, "HEAD"],
    { cwd: worktreePath, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  if (isAncestor.code === 0) {
    return { kind: "already-merged" };
  }

  const lockPath = await commitWorkLockPath(worktreePath, run);
  const lock = await acquireLock(lockPath);
  // A bounded acquirer returns null when it cannot take the flock within its
  // deadline — degrade to a retry-skip, NEVER block the reconcile thread.
  if (lock === null) {
    return { kind: "lock-timeout" };
  }
  try {
    const merge = await run(["merge", "--no-edit", sourceBranch], {
      cwd: worktreePath,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    if (merge.code === 0) {
      return { kind: "merged" };
    }
    // A SIGKILLed timeout (124) must NOT be read as a content conflict: a blocking
    // merge hook is transient, so degrade to a retry-skip. Check it BEFORE the
    // conflict/abort path (git's 1/128 conflict codes never collide with 124).
    if (merge.code === GIT_SPAWN_TIMEOUT_CODE) {
      // B2: a SIGKILLed merge can leave MERGE_HEAD/partial state behind, which
      // next cycle would read as a spurious conflict. Run the same MERGE_HEAD-
      // guarded abort here before returning so no residue is left. (The common
      // case already self-heals — next cycle's mergeReadiness sees a dirty tree
      // and defers — so this is belt-and-suspenders.) The kind stays
      // `local-timeout` (a retry-skip) UNLESS the abort itself failed — then the
      // residue did not clear, so surface the `abort-failed` wedge signal.
      const abortedT = await abortMergeIfInProgress(worktreePath, run);
      if (abortedT.kind === "abort-failed") {
        return { kind: "abort-failed", stderr: abortedT.stderr };
      }
      return { kind: "local-timeout" };
    }
    // Non-zero: a conflict (or other failure). Capture the unmerged index paths
    // BEFORE the guarded abort destroys the stage-1/2/3 entries. Best-effort only:
    // a failed/timed-out diff must never replace the merge's real outcome.
    const unmerged = await run(["diff", "--name-only", "--diff-filter=U"], {
      cwd: worktreePath,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    const conflictedFiles =
      unmerged.code === 0
        ? unmerged.stdout
            .split("\n")
            .map((path) => path.trim())
            .filter((path) => path.length > 0)
        : [];
    // Abort iff a MERGE_HEAD exists, so a merge that never started is not
    // spuriously "aborted". A clean abort (or nothing to abort) → the sticky
    // `conflict`; an abort that ITSELF failed left the checkout mid-merge → the
    // distinct `abort-failed` wedge signal.
    const aborted = await abortMergeIfInProgress(worktreePath, run);
    if (aborted.kind === "abort-failed") {
      return { kind: "abort-failed", stderr: aborted.stderr };
    }
    return {
      kind: "conflict",
      stderr: (merge.stdout + merge.stderr).trim(),
      conflictedFiles,
    };
  } finally {
    lock.release();
  }
}

/** A recover-pass lane ownership verdict. Only `owned` permits teardown. */
export type LaneOwnership =
  | { kind: "owned"; epicId: string }
  | { kind: "foreign"; detail: string }
  | { kind: "ambiguous"; detail: string }
  | { kind: "locked"; detail: string };

/**
 * Classify a registered lane using live git identity, not its path spelling. The
 * lane is ours only when its branch parses as `keeper/epic/*`, its git dir is a
 * linked-worktree admin dir, and its common dir equals the main repo's common dir.
 */
export async function classifyLaneOwnership(
  repoCwd: string,
  entry: WorktreeEntry,
  run: GitRunner = gitExec,
): Promise<LaneOwnership> {
  if (entry.locked != null) {
    return { kind: "locked", detail: entry.locked };
  }
  const epicId = epicIdFromKeeperLaneEntry(entry);
  if (epicId === null) {
    return { kind: "ambiguous", detail: "unparseable keeper lane branch" };
  }
  try {
    const repoCommon = await run(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: repoCwd, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
    );
    const laneGit = await run(
      ["rev-parse", "--path-format=absolute", "--git-dir"],
      { cwd: entry.path, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
    );
    const laneCommon = await run(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: entry.path, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
    );
    if (
      repoCommon.code !== 0 ||
      laneGit.code !== 0 ||
      laneCommon.code !== 0 ||
      repoCommon.stdout.trim() === "" ||
      laneGit.stdout.trim() === "" ||
      laneCommon.stdout.trim() === ""
    ) {
      return { kind: "ambiguous", detail: "git identity probe failed" };
    }
    const repoCommonPath = resolve(repoCommon.stdout.trim());
    const laneGitPath = resolve(laneGit.stdout.trim());
    const laneCommonPath = resolve(laneCommon.stdout.trim());
    if (laneGitPath === laneCommonPath) {
      return { kind: "foreign", detail: "standalone .git directory" };
    }
    if (laneCommonPath !== repoCommonPath) {
      return {
        kind: "foreign",
        detail: `git common dir ${laneCommonPath} is outside ${repoCommonPath}`,
      };
    }
    return { kind: "owned", epicId };
  } catch (err) {
    return {
      kind: "ambiguous",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** A conservative, tri-state MERGE_HEAD probe for a lane destroy gate. */
export async function probeLaneMergeHead(
  lanePath: string,
  run: GitRunner = gitExec,
): Promise<"absent" | "present" | "inconclusive"> {
  try {
    const r = await run(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], {
      cwd: lanePath,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    if (r.code === 0 && r.stdout.trim().length > 0) return "present";
    if (r.code === 1) return "absent";
    return "inconclusive";
  } catch {
    return "inconclusive";
  }
}

export const LANE_DIRT_INDEX_MAX_BYTES = 4096;

/** Resolve the operator-managed lane dirt spool. Pure; performs no I/O. */
export function resolveLaneDirtSpoolDir(): string {
  const override = process.env.KEEPER_LANE_DIRT_SPOOL_DIR;
  if (override && override.length > 0) return override;
  return resolve(homedir(), ".local", "state", "keeper", "lane-dirt-spool");
}

export type BackupForceRemoveResult =
  | { kind: "removed"; snapshotDir: string }
  | { kind: "backup-failed"; detail: string }
  | { kind: "remove-failed"; detail: string; snapshotDir: string };

export interface BackupForceRemoveOptions {
  spoolDir?: string;
  nowMs?: () => number;
  snapshotId?: () => string;
}

/**
 * Snapshot every dirt class, append one bounded index record, then and only then
 * force-remove the worktree and prune its registration. This is intentionally a
 * separate recover-only path; {@link removeWorktree} remains lossless.
 */
export async function backupThenForceRemoveWorktree(
  repoCwd: string,
  entry: WorktreeEntry,
  run: GitRunner = gitExec,
  options: BackupForceRemoveOptions = {},
): Promise<BackupForceRemoveResult> {
  const spoolDir = options.spoolDir ?? resolveLaneDirtSpoolDir();
  const nowMs = options.nowMs?.() ?? Date.now();
  const snapshotId =
    options.snapshotId?.() ?? `${nowMs}-${randomUUID().replaceAll("-", "")}`;
  if (!/^[A-Za-z0-9._-]+$/.test(snapshotId) || snapshotId.includes("..")) {
    return { kind: "backup-failed", detail: "invalid snapshot id" };
  }
  const snapshotDir = resolve(spoolDir, snapshotId);
  try {
    const [staged, unstaged, untracked] = await Promise.all([
      run(["diff", "--cached", "--binary", "--no-ext-diff"], {
        cwd: entry.path,
        timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      }),
      run(["diff", "--binary", "--no-ext-diff"], {
        cwd: entry.path,
        timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      }),
      run(["ls-files", "--others", "--exclude-standard", "-z"], {
        cwd: entry.path,
        timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      }),
    ]);
    if (staged.code !== 0 || unstaged.code !== 0 || untracked.code !== 0) {
      return { kind: "backup-failed", detail: "git dirt probe failed" };
    }
    const untrackedPaths = untracked.stdout
      .split("\0")
      .filter((p) => p.length > 0);
    for (const relativePath of untrackedPaths) {
      if (!isSafeLaneRelativePath(relativePath)) {
        return {
          kind: "backup-failed",
          detail: `unsafe untracked path ${JSON.stringify(relativePath)}`,
        };
      }
    }
    await mkdir(spoolDir, { recursive: true });
    await mkdir(snapshotDir, { recursive: false });
    await writeFile(resolve(snapshotDir, "staged.patch"), staged.stdout);
    await writeFile(resolve(snapshotDir, "unstaged.patch"), unstaged.stdout);
    for (const relativePath of untrackedPaths) {
      await snapshotUntrackedNode(
        resolve(entry.path, relativePath),
        resolve(snapshotDir, "untracked", relativePath),
      );
    }
    const indexLine = serializeLaneDirtIndex({
      snapshotId,
      createdAtMs: nowMs,
      repoCwd,
      lanePath: entry.path,
      branch: entry.branch ?? "",
      untrackedPaths,
    });
    await appendFile(resolve(spoolDir, "index.ndjson"), indexLine);
  } catch (err) {
    await rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
    return {
      kind: "backup-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const removed = await run(["worktree", "remove", "--force", entry.path], {
    cwd: repoCwd,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (removed.code !== 0) {
    return {
      kind: "remove-failed",
      detail: (removed.stdout + removed.stderr).trim(),
      snapshotDir,
    };
  }
  await pruneWorktrees(repoCwd, run);
  return { kind: "removed", snapshotDir };
}

function isSafeLaneRelativePath(path: string): boolean {
  if (path.length === 0 || isAbsolute(path) || path.includes("\0"))
    return false;
  const normalized = path.replaceAll("\\", "/");
  return !normalized.split("/").some((part) => part === "" || part === "..");
}

async function snapshotUntrackedNode(
  source: string,
  target: string,
): Promise<void> {
  const st = await lstat(source);
  await mkdir(dirname(target), { recursive: true });
  if (st.isSymbolicLink()) {
    await symlink(await readlink(source), target);
    return;
  }
  if (!st.isFile()) throw new Error(`unsupported untracked node: ${source}`);
  await copyFile(source, target);
}

function serializeLaneDirtIndex(input: {
  snapshotId: string;
  createdAtMs: number;
  repoCwd: string;
  lanePath: string;
  branch: string;
  untrackedPaths: string[];
}): string {
  const bounded = (s: string): string => s.slice(0, 128);
  const record = {
    schema_version: 1,
    snapshot_id: bounded(input.snapshotId),
    created_at_ms: input.createdAtMs,
    repo: bounded(input.repoCwd),
    lane: bounded(input.lanePath),
    branch: bounded(input.branch),
    staged_patch: "staged.patch",
    unstaged_patch: "unstaged.patch",
    untracked_root: "untracked",
    untracked_count: input.untrackedPaths.length,
    untracked_paths: [] as string[],
    truncated: false,
  };
  for (const path of input.untrackedPaths) {
    record.untracked_paths.push(bounded(path));
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line) > LANE_DIRT_INDEX_MAX_BYTES) {
      record.untracked_paths.pop();
      record.truncated = true;
      break;
    }
  }
  let line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line) > LANE_DIRT_INDEX_MAX_BYTES) {
    record.untracked_paths = [];
    record.truncated = true;
    line = `${JSON.stringify(record)}\n`;
  }
  if (Buffer.byteLength(line) > LANE_DIRT_INDEX_MAX_BYTES) {
    line = `${JSON.stringify({
      schema_version: 1,
      snapshot_id: input.snapshotId.slice(0, 32),
      truncated: true,
    })}\n`;
  }
  return line;
}

/**
 * Remove the worktree at `path`. NEVER blind-`--force`: a `git worktree remove`
 * without `--force` already refuses a worktree with uncommitted changes, so we
 * rely on that and report `{ kind: "dirty" }` rather than forcing. Idempotent:
 * a path with no registered worktree returns `{ kind: "removed" }`.
 */
export async function removeWorktree(
  cwd: string,
  path: string,
  run: GitRunner = gitExec,
): Promise<RemoveResult> {
  const existing = await listWorktrees(cwd, run);
  if (!existing.some((e) => samePath(e.path, path))) {
    return { kind: "removed" }; // already gone
  }
  const r = await run(["worktree", "remove", path], {
    cwd,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (r.code === 0) {
    return { kind: "removed" };
  }
  return { kind: "dirty", stderr: (r.stdout + r.stderr).trim() };
}

/** The ONLY top-level entry a husk dir may hold to be swept: session residue. */
const HUSK_RESIDUE_ENTRY = ".claude";

/**
 * After a clean {@link removeWorktree}, sweep a residue-only HUSK directory left
 * behind at `worktreePath` — a leftover holding NOTHING but `.claude` session
 * residue (`git worktree remove` can strip its tracked tree yet leave an ignored
 * `.claude/` dir, so the path lingers empty-but-present). Content-gated and
 * blast-radius-safe:
 *  - NO-OP when the path is already gone (the normal clean-remove case) or is not
 *    a real directory — a symlink or file AT the path is left byte-untouched;
 *  - an lstat-walk (NEVER stat, so a symlink stays a symlink) VETOES the whole
 *    deletion — leaving the dir byte-untouched — if any top-level entry is not
 *    `.claude`, if any node anywhere in the subtree is not a plain file or dir (a
 *    symlink, device, socket, or fifo), or if any child `resolve`s outside the
 *    root;
 *  - only when the ENTIRE subtree is plain files/dirs under `.claude` does it rm
 *    the dir and then run a metadata-only, idempotent `git worktree prune` from
 *    the MAIN repo cwd (NEVER from inside the removed path).
 *
 * Best-effort: an unexpected fs / prune error PROPAGATES so the caller can
 * swallow-and-log it — teardown already succeeded, so minting a failure row here
 * would be an unactionable sticky jam.
 */
export async function pruneWorktreeHusk(
  mainRepoCwd: string,
  worktreePath: string,
  run: GitRunner = gitExec,
): Promise<void> {
  const root = resolve(worktreePath);
  try {
    const rootStat = await lstat(root);
    // A symlink or file AT the worktree path is never ours to delete.
    if (!rootStat.isDirectory()) {
      return;
    }
  } catch (err) {
    if (isEnoent(err)) {
      return; // already gone — the normal clean-remove case
    }
    throw err;
  }
  if (!(await isResidueOnlyDir(root, root, true))) {
    return; // vetoed — leave the dir byte-untouched
  }
  await rm(root, { recursive: true, force: true });
  await pruneWorktrees(mainRepoCwd, run);
}

/**
 * lstat-walk `dir`, returning true IFF every node is a plain file or directory
 * contained within `rootReal` — and, at the top level (`isTop`), every entry is
 * `.claude`. ANY symlink / device / socket / fifo, any `resolve` containment
 * escape, or any unreadable dir returns false (veto). Never follows a symlink
 * (lstat, not stat), so a symlinked entry is rejected rather than traversed.
 */
async function isResidueOnlyDir(
  dir: string,
  rootReal: string,
  isTop: boolean,
): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (isTop && name !== HUSK_RESIDUE_ENTRY) {
      return false; // a non-`.claude` top-level entry vetoes the whole sweep
    }
    const child = resolve(dir, name);
    if (child !== rootReal && !child.startsWith(rootReal + sep)) {
      return false; // containment escape
    }
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(child);
    } catch {
      return false;
    }
    if (st.isSymbolicLink()) {
      return false; // veto ANY symlink — never traverse it
    }
    if (st.isDirectory()) {
      if (!(await isResidueOnlyDir(child, rootReal, false))) {
        return false;
      }
      continue;
    }
    if (!st.isFile()) {
      return false; // device / socket / fifo / other non-regular node vetoes
    }
  }
  return true;
}

/** True when a thrown fs error is a missing-path ENOENT. */
function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "ENOENT"
  );
}

// ---------------------------------------------------------------------------
// Baseline scratch worktrees — the suite-baseline runner's detached checkouts.
// ---------------------------------------------------------------------------

/**
 * The basename prefix every baseline scratch worktree dir carries. STRUCTURALLY
 * distinct from a lane dir (`<repoName>-<hash>--keeper-epic-<...>`, see
 * {@link worktreePathFor}): a lane's pre-`--` segment is `<repoName>-<hash>`, and
 * a `repoDirHash` is a base36 uint32 (≤7 chars, always `< "baselin"`), so no lane
 * basename can ever begin `keeper-baseline--`. The primary safety guarantee is
 * stronger still: a scratch checkout is DETACHED (no branch), so the autopilot
 * recover sweep — which classifies lanes by BRANCH via {@link isKeeperLaneEntry},
 * never by path — can never mistake a scratch tree for a lane and sweep or merge
 * it. The prefix is what lets {@link pruneBaselineScratchWorktrees} identify our
 * own orphans to reap at boot.
 */
export const BASELINE_SCRATCH_PREFIX = "keeper-baseline--";

/**
 * The out-of-repo scratch worktree path the baseline runner checks a sha out at,
 * keyed by (repo, sha). Mirrors {@link worktreePathFor}'s scheme — same
 * `worktreesRoot` parent, same {@link repoDirHash} repo-disambiguation — but with
 * the {@link BASELINE_SCRATCH_PREFIX} basename so it can never collide with a lane
 * path (see the prefix doc). PURE: reaches no environment when `worktreesRoot` is
 * passed (the producer injects `${homedir()}/worktrees`); when omitted it falls
 * back to reading `homedir()` itself, yielding the byte-identical root — safe
 * because that fallback runs PRODUCER-ONLY, never inside a fold. The `sha` is
 * appended verbatim: the runner resolves a full hex sha before keying, so the
 * segment is filesystem-safe.
 */
export function baselineScratchPathFor(
  repoDir: string,
  sha: string,
  worktreesRoot?: string,
): string {
  const root = worktreesRoot ?? `${homedir()}/worktrees`;
  return `${root}/${BASELINE_SCRATCH_PREFIX}${repoDirHash(repoDir)}-${sha}`;
}

/**
 * True IFF `path`'s basename carries the {@link BASELINE_SCRATCH_PREFIX} — the
 * gate that both identifies orphans for the boot reap and authorizes the `--force`
 * in {@link removeScratchWorktree}. Pure — fast-tier covered.
 */
export function isBaselineScratchPath(path: string): boolean {
  return basename(stripTrailingSlash(path.trim())).startsWith(
    BASELINE_SCRATCH_PREFIX,
  );
}

/** The typed outcome of {@link provisionScratchWorktree}. */
export type ScratchProvisionResult =
  /** A detached checkout exists at `path`, HEAD is exactly the sha, tree clean. */
  | { kind: "ready"; path: string }
  /**
   * The scratch checkout could NOT be produced clean at the requested sha — an
   * unresolvable/unfetched sha (the dominant case), a git-add failure, a HEAD
   * that landed off the sha, or a tree that came up dirty. `detail` names the
   * specific cause. A TYPED failure, never a throw: it feeds the baseline
   * store's `infra-error: checkout` verdict a reader can never mistake for
   * "no pre-existing failures". The scratch worktree is reaped before returning.
   */
  | { kind: "checkout-failed"; detail: string };

/**
 * Provision a detached scratch worktree at `sha` under `scratchPath` for the
 * baseline runner. Idempotent + crash-recoverable: reaps any stale scratch entry
 * at the path first (a prior run crashed), then `git worktree add --detach`. Only
 * reports `ready` after verifying HEAD equals `sha` EXACTLY and the tree is clean
 * — a dirty or off-sha scratch tree must never serve a result under a clean key,
 * so it is reaped and returned as a typed `checkout-failed` instead. Every failure
 * path reaps the scratch worktree before returning, so no orphan lingers under a
 * failed key. All git flows through the injectable {@link GitRunner} seam.
 *
 * `scratchPath` MUST be a {@link baselineScratchPathFor} path (its prefix gates
 * the `--force` reap); a non-scratch path throws via {@link removeScratchWorktree}.
 */
export async function provisionScratchWorktree(
  mainRepoCwd: string,
  scratchPath: string,
  sha: string,
  run: GitRunner = gitExec,
): Promise<ScratchProvisionResult> {
  // A crashed prior run may have left a stale worktree at this (repo, sha) path;
  // reap it (+ prune the admin husk) before re-adding so the add never collides.
  await removeScratchWorktree(mainRepoCwd, scratchPath, run);

  const add = await run(["worktree", "add", "--detach", scratchPath, sha], {
    cwd: mainRepoCwd,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (add.code !== 0) {
    // Clear any partial admin entry a failed add may have left, then report the
    // typed failure (an unresolvable sha lands here).
    await removeScratchWorktree(mainRepoCwd, scratchPath, run);
    const out = (add.stdout + add.stderr).trim();
    return {
      kind: "checkout-failed",
      detail:
        out.length > 0
          ? out
          : `git worktree add --detach failed (exit ${add.code})`,
    };
  }

  // Verify HEAD is EXACTLY the requested sha — `--detach <commit-ish>` at a ref
  // could land off the sha, and the baseline key IS the sha.
  const head = await run(["rev-parse", "HEAD"], {
    cwd: scratchPath,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (head.code !== 0) {
    await removeScratchWorktree(mainRepoCwd, scratchPath, run);
    return {
      kind: "checkout-failed",
      detail: `git rev-parse HEAD failed after checkout (exit ${head.code})${
        head.stderr.trim().length > 0 ? `: ${head.stderr.trim()}` : ""
      }`,
    };
  }
  const headSha = head.stdout.trim();
  if (headSha !== sha) {
    await removeScratchWorktree(mainRepoCwd, scratchPath, run);
    return {
      kind: "checkout-failed",
      detail: `scratch HEAD is ${headSha}, expected ${sha}`,
    };
  }

  // Verify the scratch tree is clean — a dirty tree must never produce a result
  // under a clean key.
  const status = await run(["status", "--porcelain"], {
    cwd: scratchPath,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (status.code !== 0) {
    await removeScratchWorktree(mainRepoCwd, scratchPath, run);
    return {
      kind: "checkout-failed",
      detail: `git status failed after checkout (exit ${status.code})${
        status.stderr.trim().length > 0 ? `: ${status.stderr.trim()}` : ""
      }`,
    };
  }
  if (status.stdout.trim().length > 0) {
    await removeScratchWorktree(mainRepoCwd, scratchPath, run);
    return {
      kind: "checkout-failed",
      detail: `scratch tree is not clean at ${sha}`,
    };
  }

  return { kind: "ready", path: scratchPath };
}

/**
 * Remove a baseline scratch worktree, idempotently. Unlike {@link removeWorktree}
 * (which NEVER blind-`--force`s, protecting a lane that may hold real work), this
 * DOES `--force` — TWICE: a scratch tree is a throwaway keyed by (repo, sha)
 * holding only a checkout + build artifacts (nothing human), a killed suite run
 * leaves it dirty in a way a bare remove would refuse, and a run cut mid-
 * `worktree add` leaves git's own `initializing` lock, which a single `--force`
 * refuses (and `worktree prune` skips) — only the double force clears such an
 * orphan. The force is gated on the path carrying the
 * {@link BASELINE_SCRATCH_PREFIX} — a non-scratch path THROWS (a producer bug),
 * so a lane can never reach this force. A failed remove is logged and never
 * thrown (the caller's reap is best-effort; the next boot prune retries).
 * Always prunes the admin husk after (idempotent), so a vanished-dir orphan
 * entry is cleared too.
 */
export async function removeScratchWorktree(
  mainRepoCwd: string,
  scratchPath: string,
  run: GitRunner = gitExec,
): Promise<void> {
  if (!isBaselineScratchPath(scratchPath)) {
    throw new Error(
      `worktree-git: refusing to force-remove non-scratch path ${scratchPath}`,
    );
  }
  const existing = await listWorktrees(mainRepoCwd, run);
  if (existing.some((e) => samePath(e.path, scratchPath))) {
    const rm = await run(
      ["worktree", "remove", "--force", "--force", scratchPath],
      {
        cwd: mainRepoCwd,
        timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      },
    );
    if (rm.code !== 0) {
      console.error(
        `[worktree-git] scratch reap failed (exit ${rm.code}) for ${scratchPath}: ${(rm.stdout + rm.stderr).trim()}`,
      );
    }
  }
  await pruneWorktrees(mainRepoCwd, run);
}

/**
 * Reap EVERY registered baseline scratch worktree — the boot orphan sweep. A
 * scratch tree is owned by the in-daemon runner, so any that survives a restart
 * is by definition a crashed-run orphan; reaping all of them at boot bounds the
 * disk DoS surface. Idempotent (a second call finds none). Returns the reaped
 * paths for the caller's log / a test assertion. Scratch entries are identified
 * by their {@link BASELINE_SCRATCH_PREFIX} path — never by branch (they are
 * detached), so a lane is never touched.
 */
export async function pruneBaselineScratchWorktrees(
  mainRepoCwd: string,
  run: GitRunner = gitExec,
): Promise<string[]> {
  const existing = await listWorktrees(mainRepoCwd, run);
  const scratch = existing.filter((e) => isBaselineScratchPath(e.path));
  for (const entry of scratch) {
    await removeScratchWorktree(mainRepoCwd, entry.path, run);
  }
  return scratch.map((e) => e.path);
}

// ---------------------------------------------------------------------------
// Pure path helpers (no node:path — keep the module dependency-light).
// ---------------------------------------------------------------------------

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.replace(/\/+$/, "") : p;
}

function joinPath(dir: string, name: string): string {
  const base = stripTrailingSlash(dir);
  return base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
}

/** Compare two worktree paths for equality, tolerant of a trailing slash. */
function samePath(a: string, b: string): boolean {
  return stripTrailingSlash(a.trim()) === stripTrailingSlash(b.trim());
}

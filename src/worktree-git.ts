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

import { lstat, readdir, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { CommitWorkLock } from "./commit-work/flock";
import {
  GIT_LOCAL_TIMEOUT_MS,
  GIT_SPAWN_TIMEOUT_CODE,
  type GitRunner,
  gitExec,
} from "./commit-work/git-exec";

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
  | { kind: "conflict"; stderr: string }
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
  | { kind: "local-timeout" };

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
   * The working tree / index is not clean (`git status --porcelain` non-empty).
   * Subsumes a mid-MERGE on the main checkout — a stopped/`--no-commit` merge
   * leaves unmerged or staged entries that show here — and a mid-rebase paused on
   * a conflict. `detail` carries the porcelain lines for the skip reason.
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
 * True IFF a merge is mid-flight at `cwd` (`MERGE_HEAD` present). A crash between
 * `git merge` starting and committing leaves `MERGE_HEAD`; the recovery path
 * detects it here, aborts, and prunes so the next reconcile cycle re-runs the
 * merge from a clean state (level-triggered retry, no in-process self-heal).
 */
async function hasMergeInProgress(
  cwd: string,
  run: GitRunner = gitExec,
): Promise<boolean> {
  const r = await run(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], {
    cwd,
  });
  return r.code === 0;
}

/**
 * Abort an interrupted merge at `cwd` IFF a `MERGE_HEAD` is present (guarded so a
 * tree with no merge in flight is never spuriously `merge --abort`ed). Returns
 * `true` when it aborted, `false` when there was nothing to abort. Producer-only
 * recovery: the caller follows with a `pruneWorktrees` and lets the next cycle
 * re-attempt the merge.
 */
export async function abortInterruptedMerge(
  cwd: string,
  run: GitRunner = gitExec,
): Promise<boolean> {
  if (!(await hasMergeInProgress(cwd, run))) {
    return false;
  }
  await run(["merge", "--abort"], { cwd });
  return true;
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
 * Probe whether `cwd`'s shared main checkout is ready for a base merge: on
 * `expectedBranch`, clean working tree, no merge/rebase mid-flight. Two git
 * reads, DIRTY-FIRST:
 *  1. `git status --porcelain --untracked-files=no` — any output (uncommitted
 *     edits, staged work, or a stopped merge's unmerged entries) → `{ kind:
 *     "dirty" }`. Probed FIRST so a checkout that is BOTH dirty and off its
 *     expected branch surfaces the DIRTY cause (the actionable one — clean the
 *     tree) rather than masking it behind a bare off-branch verdict. Untracked
 *     files are EXCLUDED: a benign untracked file in the human's shared checkout
 *     (editor temp, un-ignored artifact, a `.env`) a merge cannot disturb must
 *     not force a never-finalizing skip-and-retry. A non-zero status exit is
 *     itself treated as not-ready (`dirty`, conservative). This single probe
 *     covers the mid-MERGE and conflict-paused-rebase cases without a separate
 *     `MERGE_HEAD` shell.
 *  2. `git rev-parse --abbrev-ref HEAD` — a CLEAN tree off `expectedBranch`
 *     (incl. a detached HEAD from a mid-rebase, which reports `HEAD`) → `{ kind:
 *     "off-branch" }`.
 * When `incomingBranch` is supplied, a clean tree gets ONE further probe: a
 * would-clobber intersection (`incomingBranch`'s tracked paths ∩ the main
 * checkout's untracked files) — a non-empty overlap a `git merge` would hard-
 * abort on returns `{ kind: "would-clobber" }`. Omitting it skips that probe
 * (the bare clean-tree verdict). Otherwise `{ kind: "ready" }`. Pure git reads —
 * never a fetch / write. `run` precedes `incomingBranch` so existing two-/three-
 * arg callers keep the bare-readiness behavior unchanged. The caller degrades a
 * not-`ready` result to a clean skip-and-retry, never a merge.
 */
export async function mergeReadiness(
  cwd: string,
  expectedBranch: string,
  run: GitRunner = gitExec,
  incomingBranch?: string,
): Promise<MergeReadiness> {
  // Dirty check FIRST — a dirty+off-branch checkout must report the actionable
  // DIRTY cause, not mask it as off-branch. Bound the read (B4); a 124 timeout
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
  const short = entry.branch.startsWith("refs/heads/")
    ? entry.branch.slice("refs/heads/".length)
    : entry.branch;
  return short.startsWith(KEEPER_EPIC_BRANCH_PREFIX);
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
    } else {
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

/**
 * MERGE_HEAD-guarded `git merge --abort`: aborts IFF a merge is actually in
 * flight (a `MERGE_HEAD` exists), so a merge that never started is not
 * spuriously "aborted". Run on BOTH the conflict and the local-timeout
 * (SIGKILLed) exits of {@link mergeBranchInto} — a killed merge can leave
 * MERGE_HEAD/partial state that would read as a spurious conflict next cycle.
 * Best-effort + bounded by GIT_LOCAL_TIMEOUT_MS: a failed probe/abort leaves the
 * common-case self-heal (next cycle's {@link mergeReadiness} sees a dirty tree
 * and defers).
 */
async function abortMergeIfInProgress(
  worktreePath: string,
  run: GitRunner,
): Promise<void> {
  const mergeHead = await run(
    ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
    { cwd: worktreePath, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  if (mergeHead.code === 0) {
    await run(["merge", "--abort"], {
      cwd: worktreePath,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
  }
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
 *    left no MERGE_HEAD) is not "aborted" spuriously.
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
      // and defers — so this is belt-and-suspenders.) The returned kind stays
      // `local-timeout` (a retry-skip), unchanged.
      await abortMergeIfInProgress(worktreePath, run);
      return { kind: "local-timeout" };
    }
    // Non-zero: a conflict (or other failure). Abort iff a MERGE_HEAD exists,
    // so a merge that never started is not spuriously "aborted".
    await abortMergeIfInProgress(worktreePath, run);
    return {
      kind: "conflict",
      stderr: (merge.stdout + merge.stderr).trim(),
    };
  } finally {
    lock.release();
  }
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

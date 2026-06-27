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

import { CommitWorkLock } from "./commit-work/flock";
import { type GitRunner, gitExec } from "./commit-work/git-exec";

/**
 * Acquire the shared commit-work flock, returning a releasable handle. Injectable
 * so the fast tier can stub the lock (the real FFI flock is exercised by the
 * slow real-git test); production uses the blocking {@link CommitWorkLock.acquire}.
 */
export type LockAcquirer = (lockPath: string) => { release(): void };

const defaultLockAcquirer: LockAcquirer = (lockPath) =>
  CommitWorkLock.acquire(lockPath);

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
  | { kind: "conflict"; stderr: string };

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
  const r = await run(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
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
  const r = await run(["branch", "-D", branch], { cwd });
  return r.code === 0;
}

/** True IFF `cwd` is inside a linked git worktree (submodule-guarded). */
export async function isLinkedWorktree(
  cwd: string,
  run: GitRunner = gitExec,
): Promise<boolean> {
  const gitDir = await run(
    ["rev-parse", "--path-format=absolute", "--git-dir"],
    { cwd },
  );
  const commonDir = await run(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd },
  );
  const superproject = await run(
    ["rev-parse", "--show-superproject-working-tree"],
    { cwd },
  );
  if (gitDir.code !== 0 || commonDir.code !== 0) {
    return false;
  }
  return isLinkedWorktreePure({
    gitDir: gitDir.stdout,
    gitCommonDir: commonDir.stdout,
    superproject: superproject.code === 0 ? superproject.stdout : "",
  });
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
  await run(["worktree", "prune", "--expire", "now"], { cwd });
}

/**
 * True IFF a merge is mid-flight at `cwd` (`MERGE_HEAD` present). A crash between
 * `git merge` starting and committing leaves `MERGE_HEAD`; the recovery path
 * detects it here, aborts, and prunes so the next reconcile cycle re-runs the
 * merge from a clean state (level-triggered retry, no in-process self-heal).
 */
export async function hasMergeInProgress(
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
  });
  return r.code === 0;
}

/**
 * Probe whether `cwd`'s shared main checkout is ready for a base merge: on
 * `expectedBranch`, clean working tree, no merge/rebase mid-flight. Two git reads:
 *  1. `git rev-parse --abbrev-ref HEAD` — off `expectedBranch` (incl. a detached
 *     HEAD from a mid-rebase, which reports `HEAD`) → `{ kind: "off-branch" }`.
 *  2. `git status --porcelain --untracked-files=no` — any output (uncommitted
 *     edits, staged work, or a stopped merge's unmerged entries) → `{ kind:
 *     "dirty" }`. Untracked files are EXCLUDED: a benign untracked file in the
 *     human's shared checkout (editor temp, un-ignored artifact, a `.env`) a
 *     merge cannot disturb must not force a never-finalizing skip-and-retry. A
 *     non-zero status exit is itself treated as not-ready (`dirty`,
 *     conservative). This single probe covers the mid-MERGE and conflict-paused-
 *     rebase cases without a separate `MERGE_HEAD` shell.
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
  const head = await currentBranch(cwd, run);
  if (head !== expectedBranch) {
    return { kind: "off-branch", head };
  }
  const status = await run(["status", "--porcelain", "--untracked-files=no"], {
    cwd,
  });
  const detail = (status.stdout + status.stderr).trim();
  if (status.code !== 0 || detail.length > 0) {
    return { kind: "dirty", detail };
  }
  if (incomingBranch !== undefined && incomingBranch.length > 0) {
    const clobbered = await wouldClobberUntracked(cwd, incomingBranch, run);
    if (clobbered.length > 0) {
      return { kind: "would-clobber", paths: clobbered };
    }
  }
  return { kind: "ready" };
}

/**
 * The paths a merge of `incomingBranch` into the main checkout would OVERWRITE:
 * `git ls-files --others --exclude-standard` (main's untracked, ignore-aware) ∩
 * `git ls-tree -r --name-only <incomingBranch>` (the incoming tracked tree). A
 * non-empty result is exactly the set `git merge` refuses to clobber and aborts
 * on. `git merge-tree` is NOT used — it never sees untracked files. Either probe
 * failing folds to an EMPTY result (no proven collision → let the merge run; its
 * own abort is the loud backstop), never a manufactured block. Pure git reads.
 */
async function wouldClobberUntracked(
  cwd: string,
  incomingBranch: string,
  run: GitRunner,
): Promise<string[]> {
  const untrackedR = await run(["ls-files", "--others", "--exclude-standard"], {
    cwd,
  });
  if (untrackedR.code !== 0) {
    return [];
  }
  const untracked = new Set(
    untrackedR.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  );
  if (untracked.size === 0) {
    return [];
  }
  const incomingR = await run(
    ["ls-tree", "-r", "--name-only", incomingBranch],
    { cwd },
  );
  if (incomingR.code !== 0) {
    return [];
  }
  const clobbered: string[] = [];
  for (const raw of incomingR.stdout.split("\n")) {
    const path = raw.trim();
    if (path.length > 0 && untracked.has(path)) {
      clobbered.push(path);
    }
  }
  return clobbered;
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
    { cwd: worktreePath },
  );
  if (sourceExists.code !== 0) {
    return { kind: "missing-source" };
  }

  // Idempotent skip: already merged in (or fast-forward-equal).
  const isAncestor = await run(
    ["merge-base", "--is-ancestor", sourceBranch, "HEAD"],
    { cwd: worktreePath },
  );
  if (isAncestor.code === 0) {
    return { kind: "already-merged" };
  }

  const lockPath = await commitWorkLockPath(worktreePath, run);
  const lock = acquireLock(lockPath);
  try {
    const merge = await run(["merge", "--no-edit", sourceBranch], {
      cwd: worktreePath,
    });
    if (merge.code === 0) {
      return { kind: "merged" };
    }
    // Non-zero: a conflict (or other failure). Abort iff a MERGE_HEAD exists,
    // so a merge that never started is not spuriously "aborted".
    const mergeHead = await run(
      ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
      { cwd: worktreePath },
    );
    if (mergeHead.code === 0) {
      await run(["merge", "--abort"], { cwd: worktreePath });
    }
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
  const r = await run(["worktree", "remove", path], { cwd });
  if (r.code === 0) {
    return { kind: "removed" };
  }
  return { kind: "dirty", stderr: (r.stdout + r.stderr).trim() };
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

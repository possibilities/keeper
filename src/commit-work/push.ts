/**
 * Push leg of `keeper commit-work` — the TypeScript port of jobctl's
 * `_git_push` / `_try_first_push_if_no_upstream` / `_classify_push_error`
 * (apps/jobctl/jobctl/run_commit_work.py:559-692).
 *
 * `pushCommitted()` returns a discriminated {@link PushEnvelope} rather than
 * printing — the caller (`cli/commit-work.ts`) owns ALL stdout so it can emit
 * the compact NDJSON line 2 with the exact Python byte shape and release the
 * commit-work flock on every path. The 6 push-error classes are a CONSUMER
 * contract (the autopilot worker keys dispatch retries on them), so the stderr
 * substrings are replicated byte-for-byte; `auth`/`network` lowercase the
 * combined output before matching, exactly as the Python does.
 */

import { resolveDefaultBranch } from "../worktree-git";
import { type GitRunner, gitExec } from "./git-exec";

/**
 * A push-error class. Unmatched git stderr falls back to `"other"`;
 * `"protected_branch"` is NOT produced by {@link classifyPushError} — it is the
 * defense-in-depth abort `pushCommitted` raises BEFORE shelling git, when a push
 * would land lane work on the default/protected branch from a linked worktree.
 */
export type PushErrorClass =
  | "non_fast_forward"
  | "hook_rejected"
  | "auth"
  | "network"
  | "no_upstream"
  | "protected_branch"
  | "other";

/** Push succeeded — line 2 of the success NDJSON. */
export interface PushSuccess {
  success: true;
  pushed: true;
  remote: "origin";
  branch: string;
}

/**
 * Push deliberately skipped because commit-work ran inside a LINKED git
 * worktree. The commit landed on the worktree's local branch; pushing it would
 * leak a per-lane branch to origin. This is a SUCCESS envelope — callers
 * (keeper plan, the worker dispatch) must treat `skipped: "worktree"` as a
 * pushless success, NOT a push failure. Autopilot pushes once at merge-to-default.
 */
export interface PushSkippedWorktree {
  success: true;
  pushed: false;
  skipped: "worktree";
  branch: string;
}

/** Push failed — emitted compact, then the process exits 1. */
export interface PushFailure {
  success: false;
  pushed: false;
  push_error_class: PushErrorClass;
  push_error: string;
}

/** Discriminated push result. `success` keys success vs failure; on the
 * success side, `pushed` distinguishes an actual push from a worktree skip. */
export type PushEnvelope = PushSuccess | PushSkippedWorktree | PushFailure;

/**
 * Classify a push failure into a named class. Matches the well-known git push
 * stderr substrings; anything unmatched is `"other"`. The match order and the
 * `.toLowerCase()` on the `auth`/`network` arms mirror the Python verbatim.
 */
export function classifyPushError(stderr: string): PushErrorClass {
  const lower = stderr.toLowerCase();
  if (
    stderr.includes("rejected") &&
    (stderr.includes("non-fast-forward") || stderr.includes("fetch first"))
  ) {
    return "non_fast_forward";
  }
  if (
    stderr.includes("declined to push refs") ||
    stderr.includes("pre-receive hook declined")
  ) {
    return "hook_rejected";
  }
  if (
    stderr.includes("Permission denied") ||
    lower.includes("authentication failed")
  ) {
    return "auth";
  }
  if (
    lower.includes("could not resolve host") ||
    lower.includes("could not read from remote")
  ) {
    return "network";
  }
  if (stderr.includes("has no upstream branch")) {
    return "no_upstream";
  }
  return "other";
}

/**
 * Current branch name via `git rev-parse --abbrev-ref HEAD`, pinned to the
 * explicit worktree path (the per-worktree HEAD is authoritative — never a cached
 * string).
 */
async function currentBranch(
  worktree: string,
  run: GitRunner,
): Promise<string> {
  const r = await run(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktree });
  return r.stdout.trim();
}

/**
 * GENERICALLY detect whether `cwd` sits inside a LINKED git worktree (one added
 * via `git worktree add`), as opposed to the main worktree.
 *
 * Detection: in a linked worktree the per-worktree git dir
 * (`$GIT_COMMON_DIR/worktrees/<name>`) differs from the shared common dir, so
 * `--git-dir` != `--git-common-dir`. Both are taken with
 * `--path-format=absolute` so the comparison is over canonical absolute paths
 * (the bare forms emit `.git` vs an absolute common dir from a linked worktree,
 * which would compare unequal for the WRONG reason — and equal-but-relative in
 * the main tree).
 *
 * Submodule false-positive guard (mandatory): a SUBMODULE checkout ALSO has
 * `--git-dir` != `--git-common-dir` (its git dir lives under the superproject's
 * `.git/modules/<path>`), yet it is a legitimate independent repo whose commits
 * SHOULD push. `--show-superproject-working-tree` is non-empty ONLY inside a
 * submodule, so a non-empty result vetoes the worktree verdict.
 *
 * Fail-open: any git error (exit != 0) returns `false` so commit-work falls
 * back to its normal push — a detection glitch must never silently suppress a
 * legit push.
 */
export async function inLinkedWorktree(
  cwd: string,
  run: GitRunner,
): Promise<boolean> {
  const superproject = await run(
    ["rev-parse", "--show-superproject-working-tree"],
    { cwd },
  );
  // Inside a submodule → not a linked worktree; let the normal push run.
  if (superproject.code === 0 && superproject.stdout.trim().length > 0) {
    return false;
  }

  const gitDir = await run(
    ["rev-parse", "--path-format=absolute", "--git-dir"],
    { cwd },
  );
  const commonDir = await run(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd },
  );
  if (gitDir.code !== 0 || commonDir.code !== 0) return false;

  return gitDir.stdout.trim() !== commonDir.stdout.trim();
}

/** The protected-branch abort envelope (defense-in-depth — never push lane work
 * onto the default branch from a linked worktree). */
function protectedBranchAbort(branch: string, worktree: string): PushFailure {
  return {
    success: false,
    pushed: false,
    push_error_class: "protected_branch",
    push_error:
      `refusing to push '${branch}' to origin from linked worktree ${worktree}: ` +
      "lane work must merge to the default branch, never push to it",
  };
}

/**
 * Push the just-landed commit to `origin`, auto-setting upstream on first push.
 * `worktree` is the resolved, worktree-PINNED path the caller threads through
 * every git op — every spawn here runs with `cwd: worktree`, so git discovers the
 * repo from that explicit path (never a perturbed ambient cwd / GIT_DIR).
 *
 * Flow (parity with the Python):
 *  0. SKIP the push entirely inside a linked git worktree (the commit is on a
 *     per-lane branch that must never reach origin; autopilot pushes once at
 *     merge-to-default). DEFENSE-IN-DEPTH: re-check linkage + HEAD immediately
 *     before the push and ABORT if it would push the default/protected branch
 *     from a linked worktree (a producer race can flip the skip gate's verdict).
 *  1. `git rev-parse --abbrev-ref --symbolic-full-name @{u}` — exit 128 means
 *     no upstream is configured, so push with `-u origin HEAD` to set it; that
 *     branch is the whole push (the caller returns early).
 *  2. Otherwise `git push` against the configured upstream.
 *
 * `GIT_TERMINAL_PROMPT=0` is layered over the env so a credential prompt fails
 * fast (classified `auth`) instead of hanging. `--no-progress` suppresses the
 * progress meter so it never pollutes the captured `push_error` substring match.
 *
 * `run` is an injectable {@link GitRunner} — production passes the real
 * {@link gitExec}; tests pass a fake that returns captured-from-real-git push
 * stderr goldens so `classifyPushError`'s branches stay covered with no network.
 */
export async function pushCommitted(
  worktree: string,
  run: GitRunner = gitExec,
): Promise<PushEnvelope> {
  const env = { GIT_TERMINAL_PROMPT: "0" };

  // Resolve the branch ONCE, at op time, pinned to the explicit worktree path.
  const branch = await currentBranch(worktree, run);

  // 0. Skip the push leg entirely inside a linked git worktree — the commit is
  // on a per-lane branch that must never reach origin (autopilot pushes once at
  // merge-to-default). Submodule checkouts are guarded inside the detector and
  // still push. Generic: any linked worktree, not just autopilot's.
  if (await inLinkedWorktree(worktree, run)) {
    return { success: true, pushed: false, skipped: "worktree", branch };
  }

  // Defense-in-depth: immediately before the push, RE-CHECK the linked-worktree
  // verdict + HEAD. The skip gate keys on `--git-dir` vs `--git-common-dir`,
  // which a concurrent producer prune/add can momentarily perturb into a false
  // negative; re-checking here closes that window. If we now resolve as a linked
  // worktree AND would push the default/protected branch, ABORT LOUDLY rather
  // than leak a lane commit onto the default branch via origin. (`&&`
  // short-circuits, so the main worktree never pays the default-branch resolve.)
  if (
    (await inLinkedWorktree(worktree, run)) &&
    (await currentBranch(worktree, run)) ===
      (await resolveDefaultBranch(worktree, run))
  ) {
    return protectedBranchAbort(branch, worktree);
  }

  // 1. Detect missing upstream — exit 128 from @{u} resolution.
  const check = await run(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    { cwd: worktree, env },
  );
  if (check.code === 128) {
    const pushU = await run(["push", "--no-progress", "-u", "origin", "HEAD"], {
      cwd: worktree,
      env,
    });
    if (pushU.code !== 0) {
      const combined = (pushU.stdout + pushU.stderr).trim();
      return {
        success: false,
        pushed: false,
        push_error_class: classifyPushError(combined),
        push_error: combined,
      };
    }
    return { success: true, pushed: true, remote: "origin", branch };
  }

  // 2. Upstream configured — regular push.
  const push = await run(["push", "--no-progress"], { cwd: worktree, env });
  if (push.code !== 0) {
    const combined = (push.stdout + push.stderr).trim();
    return {
      success: false,
      pushed: false,
      push_error_class: classifyPushError(combined),
      push_error: combined,
    };
  }
  return { success: true, pushed: true, remote: "origin", branch };
}

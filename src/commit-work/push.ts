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

import { gitExec } from "./git-exec";

/** A push-error class. Unmatched stderr falls back to `"other"`. */
export type PushErrorClass =
  | "non_fast_forward"
  | "hook_rejected"
  | "auth"
  | "network"
  | "no_upstream"
  | "other";

/** Push succeeded — line 2 of the success NDJSON. */
export interface PushSuccess {
  success: true;
  pushed: true;
  remote: "origin";
  branch: string;
}

/** Push failed — emitted compact, then the process exits 1. */
export interface PushFailure {
  success: false;
  pushed: false;
  push_error_class: PushErrorClass;
  push_error: string;
}

/** Discriminated push result. `success` keys the two arms. */
export type PushEnvelope = PushSuccess | PushFailure;

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

/** Current branch name via `git rev-parse --abbrev-ref HEAD`. */
async function currentBranch(cwd: string): Promise<string> {
  const r = await gitExec(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  return r.stdout.trim();
}

/** A push success envelope for the current branch. */
async function pushSuccessEnvelope(cwd: string): Promise<PushSuccess> {
  return {
    success: true,
    pushed: true,
    remote: "origin",
    branch: await currentBranch(cwd),
  };
}

/**
 * Push the just-landed commit to `origin`, auto-setting upstream on first push.
 *
 * Flow (parity with the Python):
 *  1. `git rev-parse --abbrev-ref --symbolic-full-name @{u}` — exit 128 means
 *     no upstream is configured, so push with `-u origin HEAD` to set it; that
 *     branch is the whole push (the caller returns early).
 *  2. Otherwise `git push` against the configured upstream.
 *
 * `GIT_TERMINAL_PROMPT=0` is layered over the env so a credential prompt fails
 * fast (classified `auth`) instead of hanging. `--no-progress` suppresses the
 * progress meter so it never pollutes the captured `push_error` substring match.
 */
export async function pushCommitted(cwd: string): Promise<PushEnvelope> {
  const env = { GIT_TERMINAL_PROMPT: "0" };

  // 1. Detect missing upstream — exit 128 from @{u} resolution.
  const check = await gitExec(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    { cwd, env },
  );
  if (check.code === 128) {
    const pushU = await gitExec(
      ["push", "--no-progress", "-u", "origin", "HEAD"],
      { cwd, env },
    );
    if (pushU.code !== 0) {
      const combined = (pushU.stdout + pushU.stderr).trim();
      return {
        success: false,
        pushed: false,
        push_error_class: classifyPushError(combined),
        push_error: combined,
      };
    }
    return pushSuccessEnvelope(cwd);
  }

  // 2. Upstream configured — regular push.
  const push = await gitExec(["push", "--no-progress"], { cwd, env });
  if (push.code !== 0) {
    const combined = (push.stdout + push.stderr).trim();
    return {
      success: false,
      pushed: false,
      push_error_class: classifyPushError(combined),
      push_error: combined,
    };
  }
  return pushSuccessEnvelope(cwd);
}

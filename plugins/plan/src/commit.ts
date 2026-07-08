// Per-verb auto-commit machinery — the byte-parity port of planctl/commit.py
// (plus build_subject from planctl/commit_messages.py). Every mutating
// planctl-bun verb's NDJSON envelope carries a plan_invocation payload; the
// emit seam calls autoCommitFromInvocation to land the corresponding
// `chore(plan): <op> <target>` commit inline, BEFORE the success envelope
// prints.
//
// There is no flock here: each commit is pathspec-scoped to its own exact files
// (`git commit -F - -- <files>`), so concurrent same-repo verbs never
// cross-contaminate, and a bounded full-jitter retry absorbs git's two lock
// domains (index.lock for staging, ref-lock for the commit) by re-running
// add+commit from the current HEAD each attempt.
//
// Git spawns ride the ambient environment with ONE exception (applied in
// vcs.ts's runGit): the four worktree-routing vars — GIT_DIR / GIT_WORK_TREE /
// GIT_INDEX_FILE / GIT_COMMON_DIR — are stripped so the explicit per-spawn cwd
// alone fixes the repo + branch (an inherited GIT_DIR otherwise routes a lane-
// worktree commit onto the main branch). Everything else rides through:
// GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM (committer identity, gpgsign, hooks) and
// PLANCTL_* / CLAUDE_CODE_SESSION_ID the conformance harness depends on.
//
// Every git operation routes through the PlanVcs facade (vcs.ts): production gets
// realGitVcs (the verbatim spawns), the bun:test harness installs a fake that
// records commits + snapshot-diffs the data dir, so the default test tier spawns
// zero real git.

import { acquireCommitWorkLock } from "./flock.ts";
import { getVcs, type InProgressOp } from "./vcs.ts";

// Bounded retry over git's own lock domains (index.lock + ref-lock). Sized so
// the worst case (8 x 2s cap ~= 16s) fits the test timeout with margin.
// Full-jitter backoff: delay = random(0, min(cap, base * 2**n)).
const RETRY_MAX_ATTEMPTS = 8;
const RETRY_BASE_SECONDS = 0.1;
const RETRY_CAP_SECONDS = 2.0;

// The em-dash separating subject from optional detail — the literal U+2014, the
// exact codepoint planctl/commit_messages.py uses.
const EM_DASH = "—";

/** Build a `chore(plan): <verb> <id>[ — <detail>]` subject. Mirrors
 * commit_messages._subject: when a detail is given, newlines/CRs collapse to
 * spaces and the result is trimmed before the em-dash join. */
export function buildSubject(
  verb: string,
  targetId: string,
  detail?: string | null,
): string {
  if (detail) {
    const safeDetail = detail.replace(/\n/g, " ").replace(/\r/g, " ").trim();
    return `chore(plan): ${verb} ${targetId} ${EM_DASH} ${safeDetail}`;
  }
  return `chore(plan): ${verb} ${targetId}`;
}

/** Structured commit failure — carries the short error code and verbatim
 * detail so the emit seam can re-shape it into the JSON failure envelope without
 * parsing a free-form message. Mirrors planctl.commit.CommitFailed. */
export class CommitFailed extends Error {
  readonly error: string;
  readonly detail: string;
  readonly extra: Record<string, unknown>;

  constructor(error: string, detail: string, extra?: Record<string, unknown>) {
    super(`${error}: ${detail}`);
    this.name = "CommitFailed";
    this.error = error;
    this.detail = detail;
    this.extra = extra ?? {};
  }
}

// ---------------------------------------------------------------------------
// git plumbing — current head, status filter, stage, commit. Each routes through
// the installed PlanVcs facade (real git in production, fake in tests).
// ---------------------------------------------------------------------------

/** Current HEAD sha, or "unknown" on failure (fresh repo / corrupt HEAD).
 * Matches Python's _current_head sentinel so trailer forensics render the same
 * string across both engines. */
function currentHead(cwd: string): string {
  return getVcs().currentHead(cwd);
}

/** Repo-relative paths under `pathspecs` that git would stage (modified OR
 * already-staged-but-uncommitted), via `status --porcelain=v1 -- <specs>` so
 * submodule/gitignore/pathspec interpretation matches the eventual `git add`
 * exactly. Empty list when nothing is dirty — callers short-circuit to the no-op
 * path. Throws CommitFailed("git_status") on a non-zero exit. */
function dirtyFilesForPathspecs(pathspecs: string[], cwd: string): string[] {
  const result = getVcs().dirtyFilesForPathspecs(pathspecs, cwd);
  if (result.exitCode !== 0) {
    throw new CommitFailed(
      "git_status",
      `git status failed: ${result.stderr.trim()}`,
    );
  }
  return result.files;
}

/** Stage `files` (`git add -- <files>`). Files are already filtered to the
 * dirty subset — only concrete paths, never raw wildcards, so cross-epic /
 * cross-task leakage cannot occur. Throws CommitFailed("git_add") on failure. */
function gitStage(files: string[], cwd: string): void {
  const result = getVcs().stage(files, cwd);
  if (result.exitCode !== 0) {
    throw new CommitFailed(
      "git_add",
      `git add failed: ${result.stderr.trim()}`,
      { files },
    );
  }
}

/** Commit `files` with `msg` (pathspec-scoped). Returns the full SHA. Message
 * goes via stdin (`commit -F -`) for injection-safety; the trailing pathspec
 * builds the committed tree from HEAD plus exactly the listed paths, so a
 * concurrent sibling's staged-but-unrelated files never leak in. Throws
 * CommitFailed("git_commit") on failure (hook reject, empty tree, signing,
 * ref-lock contention — the caller distinguishes contention and retries). */
function gitCommit(msg: string, files: string[], cwd: string): string {
  const result = getVcs().commit(msg, files, cwd);
  if (result.exitCode !== 0) {
    throw new CommitFailed(
      "git_commit",
      `git commit failed: ${result.stderr.trim()}`,
    );
  }
  return result.sha;
}

// ---------------------------------------------------------------------------
// Contention detection — match git's lock-domain stderr, not exit codes.
// ---------------------------------------------------------------------------
//
// Two git lock domains can transiently lose a race against a concurrent
// same-repo verb: the index lock (.git/index.lock, guards `git add`; loser sees
// "Unable to create '...index.lock': File exists") and the ref lock (guards the
// commit's ref update; loser sees "cannot lock ref 'HEAD'"). We match the
// verbatim stderr substrings, not git's numeric exit codes — those are not
// stable across git versions and matching them risks retrying genuine failures
// (hook reject, signing, empty tree) which must surface immediately.

/** True when `message` is an index.lock race (retryable stage loss). */
function isStageContention(message: string): boolean {
  return message.includes("index.lock") || message.includes("File exists");
}

/** True when `message` is a ref-lock race (retryable commit loss). A ref-lock
 * loser must re-run add+commit from the current HEAD so the new commit
 * re-parents off the winner's tip — pathspec-scoping makes that merge-free. */
function isCommitContention(message: string): boolean {
  return message.includes("cannot lock ref");
}

/** The in-progress operation named in git's "cannot do a partial commit during a
 * <op>." fatal, or null when `message` is not that refusal. git emits it when a
 * pathspec commit is attempted while a merge / cherry-pick / revert holds the
 * index — the fn-1183 destruction window. This is the EAFP safety net: a commit
 * that slips past a STALE pre-write probe (the merge began in the probe->commit
 * TOCTOU window) still classifies as the retryable merge_in_progress class, never
 * the contention-retry arm (retrying would spin the whole budget against a wedge
 * that only clears when the operation finishes). */
function partialCommitOp(message: string): string | null {
  const m = message.match(/cannot do a partial commit during a ([a-z-]+)/);
  return m?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Commit message composition — subject from payload + forensic trailers.
// ---------------------------------------------------------------------------

/** Subject + blank line + forensic trailers. Session-Id rides only when
 * present (never stamped empty). Mirrors _build_message_with_trailers byte for
 * byte:
 *   Planctl-Op: <op>
 *   Planctl-Target: <id>
 *   Planctl-Prev-Op: <sha of HEAD before this commit>
 *   Session-Id: <uuid>   (omitted when session_id absent/falsy) */
export function buildMessageWithTrailers(
  subject: string,
  op: string,
  target: string,
  prevOpSha: string,
  sessionId?: string | null,
): string {
  let msg =
    `${subject}\n` +
    `\n` +
    `Planctl-Op: ${op}\n` +
    `Planctl-Target: ${target}\n` +
    `Planctl-Prev-Op: ${prevOpSha}\n`;
  if (sessionId) {
    msg += `Session-Id: ${sessionId}\n`;
  }
  return msg;
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/** The plan_invocation payload autoCommitFromInvocation consumes. */
export interface CommitPayload {
  files?: string[] | null;
  subject?: string | null;
  op?: string;
  target?: string | null;
  state_repo?: string;
  repo_root?: string;
  session_id?: string | null;
}

function sleepMs(ms: number): void {
  // Synchronous busy-wait — keeps autoCommitFromInvocation sync (the emit seam
  // runs it inline before printing). The retry path is rare and bounded.
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // spin
  }
}

/** Commit `payload.files` (pathspec-scoped, with a bounded retry). Returns the
 * commit SHA on success, null on the no-op-clean path (no dirty files in
 * scope), and throws CommitFailed on any hard failure (git status/add/commit
 * error, or "commit_contended" on retry exhaustion). Mirrors
 * planctl.commit.auto_commit_from_invocation.
 *
 * `sleep` is injectable so contention-retry tests can run the 8 attempts
 * instantly (and clear a stale lock on the first backoff). Defaults to a real
 * bounded busy-wait. */
export function autoCommitFromInvocation(
  payload: CommitPayload,
  sleep: (ms: number) => void = sleepMs,
): string | null {
  const rawFiles = payload.files;
  if (!rawFiles || rawFiles.length === 0) {
    // No-op: read-only (files=null), runtime-state-only (files=[]), or no dirty
    // intersection. Never create an empty commit.
    return null;
  }

  // state_repo precedence: explicit field -> repo_root fallback (older envelope
  // shapes). Warn to stderr on the fallback so envelope-shape drift is visible
  // without flipping the success path.
  let stateRepo = payload.state_repo;
  if (typeof stateRepo !== "string" || !stateRepo) {
    const repoRoot = payload.repo_root;
    if (typeof repoRoot === "string" && repoRoot) {
      process.stderr.write(
        `planctl.commit: payload missing state_repo, falling back to ` +
          `repo_root='${repoRoot}'\n`,
      );
      stateRepo = repoRoot;
    } else {
      throw new CommitFailed(
        "missing_state_repo",
        "plan_invocation payload lacks both state_repo and repo_root",
      );
    }
  }

  const subject = payload.subject;
  if (typeof subject !== "string" || !subject) {
    throw new CommitFailed(
      "missing_subject",
      "plan_invocation payload lacks a subject for the commit",
    );
  }

  const op = payload.op ?? "";
  const target = payload.target || "";
  // The committing session id (CLAUDE_CODE_SESSION_ID), carried on the envelope
  // by buildPlanInvocation. Fail-open — absent -> Session-Id trailer omitted,
  // commit still lands.
  const sessionId = payload.session_id || null;

  const files = [...rawFiles];
  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      // Re-confirm dirtiness each attempt — a concurrent verb may have already
      // committed our files (harmless under pathspec-scoping, but short-circuits
      // to no-op instead of an empty commit / spurious hook-reject retry).
      const dirty = dirtyFilesForPathspecs(files, stateRepo);
      if (dirty.length === 0) {
        return null;
      }

      // Re-read HEAD inside the retried body so Planctl-Prev-Op reflects the
      // FINAL parent after a ref-lock re-parent.
      const prevSha = currentHead(stateRepo);
      const msg = buildMessageWithTrailers(
        subject,
        op,
        target,
        prevSha,
        sessionId,
      );

      gitStage(dirty, stateRepo);
      return gitCommit(msg, dirty, stateRepo);
    } catch (exc) {
      if (!(exc instanceof CommitFailed)) {
        throw exc;
      }
      // EAFP: the commit is the authority. A pathspec commit git refuses because
      // the checkout went mid-operation in the probe->commit TOCTOU window is the
      // retryable merge_in_progress class — surface it immediately, never the
      // contention-retry arm below.
      if (exc.error === "git_commit") {
        const midOp = partialCommitOp(exc.detail);
        if (midOp !== null) {
          throw new CommitFailed("merge_in_progress", exc.detail, {
            operation: midOp,
          });
        }
      }
      const stageContended =
        exc.error === "git_add" && isStageContention(exc.detail);
      const commitContended =
        exc.error === "git_commit" && isCommitContention(exc.detail);
      if (!(stageContended || commitContended)) {
        // Genuine failure (hook reject, signing, empty tree, real add/status
        // error) — surface immediately, never mask it.
        throw exc;
      }
      if (attempt === RETRY_MAX_ATTEMPTS - 1) {
        throw new CommitFailed(
          "commit_contended",
          `git lock contention persisted across ${RETRY_MAX_ATTEMPTS} ` +
            `attempts: ${exc.detail}`,
        );
      }
      // Full-jitter backoff before re-running add+commit from HEAD.
      const cap = Math.min(
        RETRY_CAP_SECONDS,
        RETRY_BASE_SECONDS * 2 ** attempt,
      );
      const delay = Math.random() * cap;
      sleep(delay * 1000);
    }
  }

  // Unreachable — the loop either returns or throws on the final attempt.
  throw new CommitFailed(
    "commit_contended",
    `git lock contention persisted across ${RETRY_MAX_ATTEMPTS} attempts`,
  );
}

// ---------------------------------------------------------------------------
// Pre-write merge-window guard + commit-work serialization.
// ---------------------------------------------------------------------------
//
// A plan auto-commit that lands mid-operation is the fn-1183 destruction window:
// its pathspec-staged files are committed into a checkout a later `git merge
// --abort` discards, freeing the number for a concurrent re-mint. Two layers
// close the window on the minting host — a mutating verb calls acquirePlanCommitGuard
// at its entry, BEFORE any plan-state write:
//   1. a lock-free probe of the STATE repo's in-progress op (merge / cherry-pick
//      / revert / rebase / sequencer) that refuses before writing — a verb invoked
//      FROM a deconflict session holds MERGE_HEAD itself, so the refusal must be
//      immediate and never block on the lock that session's own commit may hold;
//   2. the shared commit-work flock, held across the write -> auto-commit window so
//      a plan verb and the daemon's base-merge / commit-work never race one
//      checkout's index. The lock path is byte-identical to the daemon's
//      (vcs.commitWorkLockPath).
// The probe is best-effort UX (TOCTOU is inherent); autoCommitFromInvocation's
// partialCommitOp classifier is the EAFP backstop for a commit that slips past a
// stale probe.

/** Plan-side commit-work lock deadline (ms). Deliberately shorter than the
 * daemon's 45s: a plan verb parked that long behind a lint-matrix commit-work
 * run is retryable-correct but slow, and the caller retries anyway, so a few
 * seconds bounds the wait while still absorbing a brief in-flight commit. */
export const PLAN_COMMIT_WORK_DEADLINE_MS = 5_000;

/** The outcome of {@link acquirePlanCommitGuard}. `refused` means the verb must
 * write nothing and emit the retryable `merge_in_progress` envelope — a probed
 * in-progress op OR the commit-work lock held past the deadline, both carrying
 * the same poll-then-rerun contract. `locked` means the verb may proceed;
 * `release()` MUST run on every exit path via try/finally (never on process exit
 * — close-finalize and the bun test harness run verbs in-process) and is a no-op
 * when the lock degraded fail-soft to unlocked. */
export type PlanCommitGuard =
  | { kind: "refused"; detail: string; message: string }
  | { kind: "locked"; release: () => void };

/** Probe `stateRepo` for an in-progress git operation and, when clean, acquire
 * the shared commit-work lock within `deadlineMs`. The probe fires FIRST and
 * lock-free so a mid-operation refusal is immediate. A timeout is retryable
 * (refused); an environmental acquire failure (unwritable lock dir, IO error)
 * degrades fail-soft to an unlocked proceed with a stderr note, matching
 * withEpicIdLock — the probe still guards the destruction window, only the
 * concurrency serialization is lost. Lock order is fixed: this commit-work lock
 * is the OUTER lock; a verb's epic-id / task lock nests INSIDE it. */
export function acquirePlanCommitGuard(
  stateRepo: string,
  deadlineMs: number = PLAN_COMMIT_WORK_DEADLINE_MS,
): PlanCommitGuard {
  const op: InProgressOp = getVcs().inProgressOp(stateRepo);
  if (op !== "none") {
    return {
      kind: "refused",
      detail: `operation: ${op}`,
      message:
        `the plan state repo has a ${op} in progress — no plan state was ` +
        "written; wait for the operation to finish, then re-run",
    };
  }
  const lockPath = getVcs().commitWorkLockPath(stateRepo);
  const acquired = acquireCommitWorkLock(lockPath, deadlineMs);
  switch (acquired.kind) {
    case "acquired":
      return { kind: "locked", release: () => acquired.lock.release() };
    case "timeout":
      return {
        kind: "refused",
        detail: "operation: commit-work-lock",
        message:
          "the plan state repo's commit-work lock is held by a concurrent " +
          `commit or base-merge past the ${deadlineMs}ms deadline — no plan ` +
          "state was written; re-run once it clears",
      };
    case "environmental":
      // Fail-soft to unlocked (the probe above still guards the destruction
      // window); surface the degrade on stderr without flipping the success path.
      process.stderr.write(
        `planctl.commit: commit-work lock unavailable at ${lockPath} ` +
          `(${acquired.message}); proceeding unlocked\n`,
      );
      return { kind: "locked", release: () => {} };
  }
}

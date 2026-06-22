// Dep-free per-write committer for the `~/docs` repo — the keeper sidecar-writer
// hook calls commitDocsPaths after it lands the `.yaml` sidecar so every
// create/update/delete of a doc is committed immediately, pathspec-scoped, with
// a mechanical `docs: write|update|delete <relpath>` subject.
//
// This is a hook-context port of the plan plugin's per-verb committer
// (plugins/plan/src/commit.ts). A keeper hook MUST NOT import the plan plugin,
// so the machinery is re-derived here. Dep-free by contract: node:path only,
// plus Bun.spawnSync — NO bun:sqlite, NO src/db.ts, NO plan-plugin import.
//
// Hook-context adjustments over the plan committer:
//  - tightened retry cap (~4 attempts) — the plan default's ~16s worst case is
//    too long to block a per-write turn;
//  - every git call carries a subprocess timeout — a hung git must not stall the
//    turn;
//  - `-c commit.gpgsign=false` on the commit — a global `commit.gpgsign=true`
//    would wedge the non-interactive commit, and a mechanical personal-docs
//    commit is intentionally unsigned;
//  - a mid-operation repo-state guard (MERGE_HEAD / CHERRY_PICK_HEAD /
//    rebase-merge / rebase-apply / BISECT_LOG) and a detached-HEAD guard skip
//    the commit cleanly rather than committing into a half-finished operation.
//
// The caller is fail-open: it catches CommitFailed and exits 0 so a commit
// failure never aborts the already-succeeded sidecar write or wedges the
// session.

import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

// Bounded retry over git's two lock domains (index.lock for `git add`, ref-lock
// for the commit). Tightened from the plan committer's 8 — the per-write hook
// runs inline on a human's turn, so the worst case (4 x 2s cap ~= 8s) must stay
// short. Full-jitter backoff: delay = random(0, min(cap, base * 2**n)).
const RETRY_MAX_ATTEMPTS = 4;
const RETRY_BASE_SECONDS = 0.1;
const RETRY_CAP_SECONDS = 2.0;

// Per-git-call wall-clock cap. A hung git (network, lock, stuck hook) must not
// stall the human's turn; the timeout kills the child and the call reports a
// non-zero exit, which the retry/skip logic treats as a normal failure.
const GIT_TIMEOUT_MS = 5000;

/** Structured commit failure — carries a short error code + verbatim detail so
 * the caller can log it without parsing a free-form message. Mirrors the plan
 * committer's CommitFailed. */
export class CommitFailed extends Error {
  readonly error: string;
  readonly detail: string;

  constructor(error: string, detail: string) {
    super(`${error}: ${detail}`);
    this.name = "CommitFailed";
    this.error = error;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// git plumbing — timeout-bounded spawn, status filter, stage, commit, guards.
// ---------------------------------------------------------------------------

/** Run git with the ambient env untouched, an explicit cwd, and a wall-clock
 * timeout. Returns exit code + decoded stdout/stderr. `input`, when given, is
 * fed to stdin (used for `commit -F -`). A timeout surfaces as a non-zero exit
 * code (Bun.spawnSync kills the child), which callers treat as a git failure. */
function runGit(
  args: string[],
  cwd: string,
  input?: string,
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    ...(input !== undefined ? { stdin: Buffer.from(input) } : {}),
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/**
 * True when the repo is mid-operation — a merge, cherry-pick, rebase, or bisect
 * is in flight. Committing the docs scope into a half-finished operation would
 * corrupt it (a stray commit during a rebase, an accidental merge resolution),
 * so the caller skips entirely. Probed via `git rev-parse --git-path <marker>`:
 * git resolves the marker path inside the gitdir (honoring worktrees) and we
 * test it on disk. Any probe failure → treated as "not mid-operation" (the
 * commit attempt itself is the backstop).
 */
function isMidOperation(cwd: string): boolean {
  const markers = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "rebase-merge",
    "rebase-apply",
    "BISECT_LOG",
  ];
  for (const marker of markers) {
    const result = runGit(["rev-parse", "--git-path", marker], cwd);
    if (result.exitCode !== 0) {
      continue;
    }
    const raw = result.stdout.trim();
    if (raw.length === 0) {
      continue;
    }
    // `--git-path` prints a path relative to the repo cwd (e.g. `.git/MERGE_HEAD`),
    // so resolve it against `cwd` — the hook process's own cwd is unrelated.
    const path = isAbsolute(raw) ? raw : resolve(cwd, raw);
    if (existsSync(path)) {
      return true;
    }
  }
  return false;
}

/**
 * True when HEAD is detached (no symbolic ref). A detached-HEAD commit would
 * orphan on the next checkout, so the caller skips. `git symbolic-ref -q HEAD`
 * exits 0 with the ref name on an attached HEAD, non-zero on a detached one.
 * An unborn HEAD (fresh repo, no commits) also reports non-zero — treated as
 * detached and skipped, which is correct (nothing to parent a docs commit off).
 */
function isDetachedHead(cwd: string): boolean {
  const result = runGit(["symbolic-ref", "-q", "HEAD"], cwd);
  return result.exitCode !== 0;
}

/** Repo-relative paths under `pathspecs` that git would stage (modified,
 * deleted, or already-staged-but-uncommitted). Uses `git status --porcelain=v1`
 * so submodule/gitignore/pathspec interpretation matches the eventual `git add`
 * exactly. Empty list when nothing is dirty — callers short-circuit to the
 * no-op path. Throws CommitFailed("git_status") on a non-zero exit. */
function dirtyFilesForPathspecs(pathspecs: string[], cwd: string): string[] {
  const result = runGit(["status", "--porcelain=v1", "--", ...pathspecs], cwd);
  if (result.exitCode !== 0) {
    throw new CommitFailed(
      "git_status",
      `git status failed: ${result.stderr.trim()}`,
    );
  }
  const files: string[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.length < 4) {
      continue;
    }
    // Porcelain v1: `XY <path>` (first 3 chars are status + space). The
    // path-as-printed is fed back to `git add`. A rename shows as `R old -> new`
    // — left alone here (docs writes are atomic-write M, deletes are D, never R
    // for a single doc).
    const path = line.slice(3).trim();
    if (path) {
      files.push(path);
    }
  }
  return files;
}

/** Stage `files` (`git add -A -- <files>`). `-A` so a deletion is staged (a
 * plain `git add -- <deleted>` would not record the removal). Files are already
 * filtered to the dirty subset — only concrete paths, never wildcards. Throws
 * CommitFailed("git_add") on failure. */
function gitStage(files: string[], cwd: string): void {
  const result = runGit(["add", "-A", "--", ...files], cwd);
  if (result.exitCode !== 0) {
    throw new CommitFailed(
      "git_add",
      `git add failed: ${result.stderr.trim()}`,
    );
  }
}

/** Commit `files` with `msg` (pathspec-scoped). Returns the full SHA. Message
 * goes via stdin (`commit -F -`) for injection-safety; the trailing pathspec
 * builds the committed tree from HEAD plus exactly the listed paths. `-c
 * commit.gpgsign=false` keeps a global signing config from wedging this
 * non-interactive mechanical commit. Throws CommitFailed("git_commit") on
 * failure (hook reject, empty tree, ref-lock contention). */
function gitCommit(msg: string, files: string[], cwd: string): string {
  const commitResult = runGit(
    ["-c", "commit.gpgsign=false", "commit", "-F", "-", "--", ...files],
    cwd,
    msg,
  );
  if (commitResult.exitCode !== 0) {
    throw new CommitFailed(
      "git_commit",
      `git commit failed: ${commitResult.stderr.trim()}`,
    );
  }
  const shaResult = runGit(["rev-parse", "HEAD"], cwd);
  return shaResult.stdout.trim();
}

// ---------------------------------------------------------------------------
// Contention detection — match git's lock-domain stderr, not exit codes.
// ---------------------------------------------------------------------------

/** True when `message` is an index.lock race (retryable stage loss). */
function isStageContention(message: string): boolean {
  return message.includes("index.lock") || message.includes("File exists");
}

/** True when `message` is a ref-lock race (retryable commit loss). */
function isCommitContention(message: string): boolean {
  return message.includes("cannot lock ref");
}

// ---------------------------------------------------------------------------
// Subject composition.
// ---------------------------------------------------------------------------

/** A mechanical `docs: <verb> <relpath>` subject. `verb` is `write` (new file),
 * `update` (existing file modified), or `delete` (removal). `relpath` is the
 * doc path relative to the docs repo root, so the subject reads cleanly
 * regardless of where the docs dir lives. */
export function buildDocSubject(verb: string, relpath: string): string {
  return `docs: ${verb} ${relpath}`;
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

function sleepMs(ms: number): void {
  // Synchronous busy-wait — keeps the committer sync (the hook runs it inline
  // before exiting). The retry path is rare and bounded.
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // spin
  }
}

/** The verb stamped in the subject. `write` for a created file, `update` for a
 * modified file, `delete` for a removal. The caller derives it from the tool
 * (Write→write-or-update, Edit/MultiEdit→update, delete commands→delete). */
export type DocCommitVerb = "write" | "update" | "delete";

export interface DocCommitOptions {
  /** Absolute paths to commit — the doc `.md` and/or its `.yaml` sidecar (or a
   * deleted path). Filtered to the docs repo by the caller. */
  paths: string[];
  /** Absolute path to the docs repo root (the dir git runs in). */
  repoRoot: string;
  /** Subject verb. */
  verb: DocCommitVerb;
}

/**
 * Commit the dirty subset of `paths` in the docs repo (pathspec-scoped, with a
 * bounded contention retry). Returns the commit SHA on success, or null on the
 * no-op path: nothing in scope is dirty, the repo is mid-operation, or HEAD is
 * detached/unborn. Throws CommitFailed on a hard failure — the caller catches
 * it and exits 0 (fail-open).
 *
 * `sleep` is injectable so contention-retry tests run the attempts instantly.
 */
export function commitDocsPaths(
  options: DocCommitOptions,
  sleep: (ms: number) => void = sleepMs,
): string | null {
  const { paths, repoRoot, verb } = options;
  if (paths.length === 0) {
    return null;
  }

  // Skip cleanly on a half-finished operation or a detached/unborn HEAD —
  // committing the docs scope there would corrupt the in-flight op or orphan
  // the commit. These are guards, not failures: return null (no-op), not throw.
  if (isMidOperation(repoRoot) || isDetachedHead(repoRoot)) {
    return null;
  }

  // The subject's relpath comes from the FIRST path (the doc `.md` when both
  // `.md` + `.yaml` are committed; the lone path otherwise), relative to the
  // repo root so it reads cleanly.
  const subjectPath = relative(repoRoot, paths[0] as string) || paths[0];
  const subject = buildDocSubject(verb, subjectPath as string);

  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      // Re-confirm dirtiness each attempt — a concurrent write may have already
      // committed our paths (short-circuit to no-op rather than an empty
      // commit). `git status` reports a deletion as `D`, so a `git rm`'d doc is
      // still seen as dirty here.
      const dirty = dirtyFilesForPathspecs(paths, repoRoot);
      if (dirty.length === 0) {
        return null;
      }

      gitStage(dirty, repoRoot);
      const msg = `${subject}\n`;
      return gitCommit(msg, dirty, repoRoot);
    } catch (exc) {
      if (!(exc instanceof CommitFailed)) {
        throw exc;
      }
      const stageContended =
        exc.error === "git_add" && isStageContention(exc.detail);
      const commitContended =
        exc.error === "git_commit" && isCommitContention(exc.detail);
      if (!(stageContended || commitContended)) {
        // Genuine failure (hook reject, empty tree, real add/status error) —
        // surface immediately.
        throw exc;
      }
      if (attempt === RETRY_MAX_ATTEMPTS - 1) {
        throw new CommitFailed(
          "commit_contended",
          `git lock contention persisted across ${RETRY_MAX_ATTEMPTS} ` +
            `attempts: ${exc.detail}`,
        );
      }
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

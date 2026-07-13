#!/usr/bin/env bun
/**
 * Keeper docs-pusher hook (fn-885). A fail-open `Stop` hook that pushes the
 * `~/docs` repo to its remote on a debounced cadence. Stop fires once per turn,
 * which IS the debounce — there is no persistent timer state; each turn that
 * leaves `~/docs` ahead of its upstream flushes it once.
 *
 * Companion to the sidecar-writer (fn-884/`.1`), which commits every doc
 * write/edit/delete inline. The pusher only PUSHES — never commits, never
 * fetches (a per-turn `git fetch` is too costly), never rebases, never
 * `--force`. The ahead-check is a purely local `git rev-list --count @{u}..HEAD`.
 *
 * Flow (every step guards + swallows so the hook can never block a Stop):
 *  - resolve `~/docs` (honoring the same `KEEPER_DOCS_DIR` override as the
 *    committer);
 *  - skip a mid-operation repo (merge/cherry-pick/rebase/bisect) and a
 *    detached/unborn HEAD — pushing mid-op or off a detached HEAD is wrong;
 *  - `@{u}` upstream check: no upstream → no-op; 0 commits ahead → no-op;
 *  - acquire a pid-stamped `.git/keeper-push.lock` lockfile (`wx` open, O_EXCL) so
 *    concurrent sessions don't race a push — an orphaned lock (holder pid gone, or
 *    older than the staleness threshold) is reclaimed; a live one logs + skips;
 *  - `git push --no-progress` with a subprocess timeout and `GIT_TERMINAL_PROMPT=0`
 *    so a credential prompt fails fast instead of hanging;
 *  - on non-fast-forward / auth / network / any failure LOG to a file under
 *    `.git/` and SKIP — never auto-rebase, never `--force`;
 *  - release the lockfile.
 *
 * Hard guarantee — **ALWAYS EXIT 0.** A `Stop` hook that exits 2 PREVENTS Claude
 * from stopping; every path (push failure, mid-op, detached HEAD, hung git,
 * non-repo docs dir, thrown exception) must end exit 0 with errors swallowed and
 * logged. Mirrors the events-writer / sidecar-writer exit-0 contract.
 *
 * Dep-free by contract: `node:fs`/`node:os`/`node:path` + `Bun.spawnSync` only.
 * NO `bun:sqlite`, NO `src/db.ts`, NO plan-plugin import — every import borrows
 * from the cold-start budget.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// Per-git-call wall-clock cap. A hung git (network, credential prompt that
// slipped GIT_TERMINAL_PROMPT, stuck lock) must not stall the turn; the timeout
// kills the child and the call reports a non-zero exit, which is logged + skipped.
const GIT_TIMEOUT_MS = 8000;

// Staleness threshold for an orphaned push lock. A live holder releases its lock
// in `pushDocs`'s finally; the only way a lock outlives its holder is a hard kill
// of the Stop hook (the harness can time one out) between acquire and release.
// Set comfortably above `GIT_TIMEOUT_MS` (the longest a healthy holder can hold
// the lock — one bounded `git push`) so a genuinely-live holder is never
// reclaimed out from under a slow push.
const LOCK_STALE_MS = 60_000;

/** Result of one git invocation — exit code + decoded stdout/stderr. */
export interface GitRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * The synchronous git-runner shape {@link pushDocs} depends on. Production uses
 * {@link spawnGit} (a real timeout-bounded `git` subprocess); tests inject a
 * fake recording runner so the suite asserts the pusher's DECISIONS (the
 * ahead/no-upstream/mid-op/detached guards, the push skip + classified skip-log
 * line, the lock acquire) with zero real git and no network. A plain function
 * type — no DI framework, and the hook's dep-free import set is unchanged.
 */
export type PusherGitRunner = (
  args: string[],
  cwd: string,
  extraEnv?: Record<string, string>,
) => GitRunResult;

/**
 * Run git with the ambient env (plus any `extraEnv`), an explicit cwd, and a
 * wall-clock timeout. Returns exit code + decoded stdout/stderr. A timeout
 * surfaces as a non-zero exit code (Bun.spawnSync kills the child), treated as a
 * git failure by callers.
 */
function spawnGit(
  args: string[],
  cwd: string,
  extraEnv?: Record<string, string>,
): GitRunResult {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/** A push-error class — the consumer-contract substrings from
 * `src/commit-work/push.ts` `classifyPushError`, replicated dep-free here (that
 * module is async + dep-heavy, NOT hook-portable). Used only for the log line. */
export type PushErrorClass =
  | "non_fast_forward"
  | "hook_rejected"
  | "auth"
  | "network"
  | "no_upstream"
  | "other";

/**
 * Classify a push failure into a named class — the well-known git push stderr
 * substrings (match order + the `.toLowerCase()` on the `auth`/`network` arms
 * mirror `src/commit-work/push.ts` `classifyPushError` verbatim). Hook-local so
 * the pusher stays dep-free; only used to annotate the skip-log line.
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
 * Resolve the `~/docs` directory. `KEEPER_DOCS_DIR` env wins (hermetic tests
 * point it at a tmpdir); otherwise default to `~/docs`. MUST match the
 * sidecar-writer's `resolveDocsDir` so both hooks target the same repo.
 */
export function resolveDocsDir(): string {
  const override = process.env.KEEPER_DOCS_DIR;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), "docs");
}

/**
 * True when the repo is mid-operation — a merge, cherry-pick, rebase, or bisect
 * is in flight. Pushing mid-op is fine for the remote but signals a local repo
 * the human is actively reconciling; skip to stay out of the way. Probed via
 * `git rev-parse --git-path <marker>` (honors worktrees), tested on disk. Mirrors
 * the committer's `isMidOperation`. Any probe failure → "not mid-operation".
 */
function isMidOperation(cwd: string, run: PusherGitRunner): boolean {
  const markers = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "rebase-merge",
    "rebase-apply",
    "BISECT_LOG",
  ];
  for (const marker of markers) {
    const result = run(["rev-parse", "--git-path", marker], cwd);
    if (result.exitCode !== 0) {
      continue;
    }
    const raw = result.stdout.trim();
    if (raw.length === 0) {
      continue;
    }
    const path = isAbsolute(raw) ? raw : resolve(cwd, raw);
    if (existsSync(path)) {
      return true;
    }
  }
  return false;
}

/**
 * True when HEAD is detached (or unborn). Pushing a detached HEAD has no branch
 * to push, and an unborn HEAD has nothing committed; skip both. `git symbolic-ref
 * -q HEAD` exits 0 on an attached HEAD, non-zero otherwise. Mirrors the
 * committer's `isDetachedHead`.
 */
function isDetachedHead(cwd: string, run: PusherGitRunner): boolean {
  const result = run(["symbolic-ref", "-q", "HEAD"], cwd);
  return result.exitCode !== 0;
}

/**
 * Count commits the local branch is ahead of its upstream — `git rev-list
 * --count @{u}..HEAD`. `@{u}` (not a hardcoded `origin/main`) survives a non-main
 * branch. Returns the count on success, or `null` when there is no upstream
 * configured (the `@{u}` resolution fails non-zero) — the caller treats both 0
 * and null as a clean no-op. A purely LOCAL count — no network, no `git fetch`.
 */
export function aheadOfUpstream(
  cwd: string,
  run: PusherGitRunner = spawnGit,
): number | null {
  const result = run(
    ["rev-list", "--count", "@{u}..HEAD"],
    cwd,
    // GIT_TERMINAL_PROMPT not needed (local-only), but harmless to keep parity.
    { GIT_TERMINAL_PROMPT: "0" },
  );
  if (result.exitCode !== 0) {
    // No upstream configured (or any other rev-list failure) — treat as no-op.
    return null;
  }
  const n = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve the push lockfile path. Lives under the repo's gitdir so it travels
 * with the repo and is gitignored by construction. Worktree-correct via
 * `git rev-parse --git-dir`; falls back to `<cwd>/.git` when the probe fails
 * (the worktree-rare case — a plain repo).
 */
function lockfilePath(cwd: string, run: PusherGitRunner): string {
  const result = run(["rev-parse", "--git-dir"], cwd);
  let gitDir = `${cwd}/.git`;
  if (result.exitCode === 0) {
    const raw = result.stdout.trim();
    if (raw.length > 0) {
      gitDir = isAbsolute(raw) ? raw : resolve(cwd, raw);
    }
  }
  return join(gitDir, "keeper-push.lock");
}

/**
 * Resolve the skip-log path. `KEEPER_DOCS_PUSH_LOG` env wins (tests point it at a
 * tmp file); otherwise `<gitdir>/keeper-push.log`. Errors here are non-fatal —
 * the caller swallows a logging failure rather than letting it abort the Stop.
 */
function logPath(cwd: string, run: PusherGitRunner): string {
  const override = process.env.KEEPER_DOCS_PUSH_LOG;
  if (override && override.length > 0) {
    return override;
  }
  const result = run(["rev-parse", "--git-dir"], cwd);
  let gitDir = `${cwd}/.git`;
  if (result.exitCode === 0) {
    const raw = result.stdout.trim();
    if (raw.length > 0) {
      gitDir = isAbsolute(raw) ? raw : resolve(cwd, raw);
    }
  }
  return join(gitDir, "keeper-push.log");
}

/** Append a single timestamped line to the skip-log, swallowing any IO error
 * (a logging failure must never break the exit-0 contract). */
function logSkip(cwd: string, line: string, run: PusherGitRunner): void {
  try {
    appendFileSync(logPath(cwd, run), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // best-effort; a logging failure is never fatal.
  }
}

/** Release the lockfile, swallowing a missing-file / IO error. */
function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // best-effort; an orphaned lock (a holder hard-killed before this release) is
    // reclaimed by the next push's `tryAcquireLock` — see its staleness check —
    // so a crashed holder never blocks a Stop forever.
  }
}

/**
 * Decide whether a pre-existing lock is orphaned and safe to reclaim. A lock is
 * orphaned when its stamped holder pid is verifiably gone, OR when it is older
 * than `LOCK_STALE_MS` (the holder was hard-killed before releasing). An
 * unreadable / unstamped / unparseable lock falls back to the mtime check alone.
 * Any probe error is treated as "not reclaimable" — never reclaim on doubt, so a
 * live holder is never raced.
 */
export type PidAlive = (pid: number) => boolean;

function processPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function isLockStale(lockPath: string, pidAlive: PidAlive): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    // Lock vanished between the failed acquire and this stat — let the caller
    // retry the exclusive create rather than reclaim a non-existent lock.
    return false;
  }
  if (Date.now() - mtimeMs > LOCK_STALE_MS) {
    return true;
  }
  // Within the staleness window — only reclaim if the stamped holder is gone.
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  return !pidAlive(pid);
}

/**
 * Try to acquire the push lockfile with an exclusive create (`wx` / O_EXCL),
 * stamping it with this process's pid so a later push can probe holder liveness.
 * Returns true on acquisition. A pre-existing lock that is orphaned (holder pid
 * gone, or older than `LOCK_STALE_MS`) is reclaimed and re-acquired; a live,
 * fresh lock (a concurrent session mid-push) returns false so the caller skips.
 * Any other open / reclaim error returns false (skip rather than race a push).
 */
function tryAcquireLock(lockPath: string, pidAlive: PidAlive): boolean {
  if (stampLock(lockPath)) {
    return true;
  }
  // The exclusive create failed — a lock already exists (or an IO error). If the
  // existing lock is orphaned, reclaim it and retry the exclusive create ONCE; a
  // reclaim failure or a still-live lock falls through to a skip.
  if (!isLockStale(lockPath, pidAlive)) {
    return false;
  }
  try {
    unlinkSync(lockPath);
  } catch {
    // Lost the reclaim race (another session unlinked it first) or an IO error —
    // skip rather than risk a racing push.
    return false;
  }
  return stampLock(lockPath);
}

/**
 * Exclusively create + pid-stamp the lockfile. Returns true on success, false if
 * the lock already exists (O_EXCL collision) or on any IO error. Split out so
 * both the first acquire and the post-reclaim retry stamp identically.
 */
function stampLock(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, "wx");
    try {
      writeSync(fd, `${process.pid}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The pure push decision + action for a resolved docs dir. Exported for tests so
 * they can drive it directly with an injected {@link PusherGitRunner} (zero real
 * git). Returns a short status token describing the outcome (`pushed` /
 * `not-ahead` / `no-upstream` / `mid-op` / `detached` / `locked` /
 * `push-failed` / `not-a-repo`) — purely informational; the hook ignores it and
 * always exits 0.
 *
 * `run` defaults to the real {@link spawnGit}; the test injects a fake returning
 * captured-from-real-git push stderr goldens so the classified skip-log line and
 * the exit-0 fail-open stay covered with no network.
 */
export function pushDocs(
  docsDir: string,
  run: PusherGitRunner = spawnGit,
  pidAlive: PidAlive = processPidAlive,
): string {
  if (!existsSync(docsDir)) {
    return "not-a-repo";
  }
  // A non-repo docs dir: `rev-parse` fails, the guards/ahead-check all no-op.
  if (isMidOperation(docsDir, run)) {
    return "mid-op";
  }
  if (isDetachedHead(docsDir, run)) {
    return "detached";
  }
  const ahead = aheadOfUpstream(docsDir, run);
  if (ahead === null) {
    return "no-upstream";
  }
  if (ahead === 0) {
    return "not-ahead";
  }

  const lockPath = lockfilePath(docsDir, run);
  if (!tryAcquireLock(lockPath, pidAlive)) {
    // A live, fresh lock — a concurrent session is mid-push. Log so a stuck lock
    // (one that never clears across turns) is diagnosable from the skip-log.
    logSkip(
      docsDir,
      `push-skipped class=locked :: lockfile held at ${lockPath}`,
      run,
    );
    return "locked";
  }
  try {
    const result = run(["push", "--no-progress"], docsDir, {
      GIT_TERMINAL_PROMPT: "0",
    });
    if (result.exitCode !== 0) {
      const combined = (result.stdout + result.stderr).trim();
      const klass = classifyPushError(combined);
      // Log + SKIP — never auto-rebase, never --force. A non-fast-forward means
      // the remote moved; the human reconciles manually.
      logSkip(docsDir, `push-skipped class=${klass} :: ${combined}`, run);
      return "push-failed";
    }
    return "pushed";
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Read all of stdin as a UTF-8 string. The Stop payload is small; a truncated or
 * empty payload throws on `JSON.parse` and is caught by the outer exit-0 guard.
 * Mirrors the sidecar-writer's `readStdin`.
 */
async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function main(): Promise<void> {
  // The payload is read + parsed only to fail-open on a malformed one and to keep
  // parity with the other hooks; the pusher needs no field from it (it operates
  // purely on the resolved docs repo state).
  const raw = await readStdin();
  if (raw.trim().length > 0) {
    JSON.parse(raw);
  }
  pushDocs(resolveDocsDir());
}

// Outer guard: ANY failure here exits 0. A `Stop` hook that exits non-zero (2 in
// particular) BLOCKS Claude from stopping — far worse than a missed push. The
// `import.meta.main` gate keeps a plain `import` (tests pulling the pure exports)
// inert.
if (import.meta.main) {
  process.on("uncaughtException", (err) => {
    process.stderr.write(`keeper docs-pusher: uncaught: ${err}\n`);
    process.exit(0);
  });
  process.on("unhandledRejection", (err) => {
    process.stderr.write(`keeper docs-pusher: unhandled: ${err}\n`);
    process.exit(0);
  });
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      process.stderr.write(`keeper docs-pusher: ${err}\n`);
      process.exit(0);
    });
}

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
 *  - acquire a `.git/keeper-push.lock` lockfile (`wx` open, O_EXCL) so concurrent
 *    sessions don't race a push — skip if already locked;
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
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// Per-git-call wall-clock cap. A hung git (network, credential prompt that
// slipped GIT_TERMINAL_PROMPT, stuck lock) must not stall the turn; the timeout
// kills the child and the call reports a non-zero exit, which is logged + skipped.
const GIT_TIMEOUT_MS = 8000;

/**
 * Run git with the ambient env (plus any `extraEnv`), an explicit cwd, and a
 * wall-clock timeout. Returns exit code + decoded stdout/stderr. A timeout
 * surfaces as a non-zero exit code (Bun.spawnSync kills the child), treated as a
 * git failure by callers.
 */
function runGit(
  args: string[],
  cwd: string,
  extraEnv?: Record<string, string>,
): { exitCode: number; stdout: string; stderr: string } {
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
function isDetachedHead(cwd: string): boolean {
  const result = runGit(["symbolic-ref", "-q", "HEAD"], cwd);
  return result.exitCode !== 0;
}

/**
 * Count commits the local branch is ahead of its upstream — `git rev-list
 * --count @{u}..HEAD`. `@{u}` (not a hardcoded `origin/main`) survives a non-main
 * branch. Returns the count on success, or `null` when there is no upstream
 * configured (the `@{u}` resolution fails non-zero) — the caller treats both 0
 * and null as a clean no-op. A purely LOCAL count — no network, no `git fetch`.
 */
export function aheadOfUpstream(cwd: string): number | null {
  const result = runGit(
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
function lockfilePath(cwd: string): string {
  const result = runGit(["rev-parse", "--git-dir"], cwd);
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
function logPath(cwd: string): string {
  const override = process.env.KEEPER_DOCS_PUSH_LOG;
  if (override && override.length > 0) {
    return override;
  }
  const result = runGit(["rev-parse", "--git-dir"], cwd);
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
function logSkip(cwd: string, line: string): void {
  try {
    appendFileSync(logPath(cwd), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // best-effort; a logging failure is never fatal.
  }
}

/**
 * Try to acquire the push lockfile with an exclusive create (`wx` / O_EXCL).
 * Returns true on acquisition. A pre-existing lock (a concurrent session mid-push)
 * returns false — the caller skips this push. Any other open error also returns
 * false (skip rather than risk a racing push).
 */
function tryAcquireLock(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, "wx");
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/** Release the lockfile, swallowing a missing-file / IO error. */
function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // best-effort; a stale lock is cleaned by the next successful acquire path
    // only if removed — but a crashed holder leaving a stale lock self-heals on
    // the operator's next manual push, and never blocks a Stop.
  }
}

/**
 * The pure push decision + action for a resolved docs dir. Exported for tests so
 * they can drive it directly against an `initRepo` + bare-origin fixture without
 * the stdin/exit harness. Returns a short status token describing the outcome
 * (`pushed` / `not-ahead` / `no-upstream` / `mid-op` / `detached` / `locked` /
 * `push-failed` / `not-a-repo`) — purely informational; the hook ignores it and
 * always exits 0.
 */
export function pushDocs(docsDir: string): string {
  if (!existsSync(docsDir)) {
    return "not-a-repo";
  }
  // A non-repo docs dir: `rev-parse` fails, the guards/ahead-check all no-op.
  if (isMidOperation(docsDir)) {
    return "mid-op";
  }
  if (isDetachedHead(docsDir)) {
    return "detached";
  }
  const ahead = aheadOfUpstream(docsDir);
  if (ahead === null) {
    return "no-upstream";
  }
  if (ahead === 0) {
    return "not-ahead";
  }

  const lockPath = lockfilePath(docsDir);
  if (!tryAcquireLock(lockPath)) {
    return "locked";
  }
  try {
    const result = runGit(["push", "--no-progress"], docsDir, {
      GIT_TERMINAL_PROMPT: "0",
    });
    if (result.exitCode !== 0) {
      const combined = (result.stdout + result.stderr).trim();
      const klass = classifyPushError(combined);
      // Log + SKIP — never auto-rebase, never --force. A non-fast-forward means
      // the remote moved; the human reconciles manually.
      logSkip(docsDir, `push-skipped class=${klass} :: ${combined}`);
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

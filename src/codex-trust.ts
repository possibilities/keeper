// Dep-free codex per-directory trust seeder — the ONLY keeper surface that writes
// codex's own config dir. The `keeper agent` launch path calls ensureCodexDirTrust
// best-effort BEFORE launching a codex partner as an interactive TUI, so the
// detached window never hangs on codex's "Do you trust the contents of this
// directory?" prompt.
//
// Dep-free by contract: node:fs/node:os/node:path only — NO bun:sqlite, NO
// src/db.ts, NO third-party deps, NO subprocess. A leaf module like
// src/doc-commit.ts / src/dead-letter.ts.
//
// FAIL-OPEN by contract: every path is wrapped so the function NEVER throws and
// NEVER blocks the launch. On lock-timeout / unwritable config / realpath error it
// logs best-effort (to a KEEPER_CODEX_TRUST_LOG-overridable path, mirroring the
// docs-pusher's KEEPER_DOCS_PUSH_LOG) and returns a status token; the caller
// proceeds to launch regardless. Codex then merely re-prompts (and the pair's
// wait-for-stop timeout still reaps the window) — never worse than today.
//
// Concurrency: the seed acquires an O_EXCL/`wx` lockfile mirroring the
// docs-pusher's tryAcquireLock/stampLock/isLockStale primitives (pid-stamped,
// process.kill(pid,0) liveness, LOCK_STALE_MS) — BUT bounded WAIT-AND-RETRY, not
// the docs-pusher's skip-on-contention: two unlocked concurrent appends would
// duplicate the `[projects]` table and break the TOML parse. After acquiring, the
// seed RE-READS + re-scans (a lock winner may have just seeded the same key) before
// appending.
//
// Trust is EXACT-MATCH only — codex does NOT inherit trust from an ancestor
// directory (verified live: a fresh subdir under a trusted `/Users/mike` still
// prompts), so the key is the canonical `realpathSync(cwd)` and there is no
// ancestor walk. An existing header (any value) is respected and left untouched —
// we never override a user's explicit choice.
//
// Torn-write tradeoff: the seed is a SINGLE append of a small complete snippet
// (`\n[projects."<key>"]\ntrust_level = "trusted"\n`), atomic enough given the
// seed-completes-before-codex-launch ordering (no concurrent codex reader; other
// pair writers are lock-serialized). The atomic-temp-rename alternative rewrites
// the whole config (hundreds of KB) and is unnecessary.

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Staleness threshold for an orphaned trust lock. The only way a lock outlives its
// holder is a hard kill between acquire and release; a healthy holder holds it for
// a single read + append (sub-millisecond). Set well above that. Mirrors the
// docs-pusher's LOCK_STALE_MS shape.
const LOCK_STALE_MS = 60_000;

// Bounded wait-and-retry for the lock (NOT skip-on-contention). A concurrent pair
// launch holds the lock only for one read + append, so a short total budget with a
// small backoff is ample. On exhaustion the function fails open (logs + returns).
const LOCK_WAIT_TOTAL_MS = 2_000;
const LOCK_RETRY_SLEEP_MS = 25;

/** Outcome token — purely informational for the caller's log; the launch never
 *  gates on it. */
export type CodexTrustStatus =
  | "already-trusted"
  | "seeded"
  | "lock-timeout"
  | "error";

export interface EnsureCodexDirTrustOptions {
  /** The partner's target repo (the cwd codex launches in). Canonicalized to its
   *  realpath as the `[projects."<key>"]` key. */
  cwd: string;
  /** The environment to read CODEX_HOME / KEEPER_CODEX_TRUST_LOG from. */
  env: Record<string, string | undefined>;
  /** The home directory `~/.codex` falls back to. Injectable for tests. */
  home?: string;
}

/** Resolve CODEX_HOME the same way transcript-watch does: an explicit non-empty
 *  CODEX_HOME wins, else `<home>/.codex`. keeper only READS this — it never sets
 *  or forces CODEX_HOME. Exported so the launch-time state-sharing guard finds
 *  codex's global-instruction leaf (`<CODEX_HOME|~/.codex>/AGENTS.md`) without a
 *  duplicate resolver. */
export function resolveCodexHome(
  env: Record<string, string | undefined>,
  home: string,
): string {
  return (env.CODEX_HOME ?? "").trim() || join(home, ".codex");
}

/** Escape a POSIX path for a TOML basic-string key. A path can only contain `\`
 *  and `"` of the basic-string escapes, so those two are sufficient: `\`→`\\`
 *  FIRST (else the `"`→`\"` backslash would itself be doubled), then `"`→`\"`.
 *  Exported for a pure escaping unit test (a real dir with these chars is
 *  unreliable across filesystems). */
export function escapeTomlKey(key: string): string {
  return key.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** The exact `[projects."<escaped-key>"]` header line we match / append. */
function projectHeaderLine(escapedKey: string): string {
  return `[projects."${escapedKey}"]`;
}

/** True iff `config` already carries the EXACT header (a trimmed full-line equality
 *  scan — never a substring `includes`, which would false-positive on a value or
 *  comment that merely contains the path). */
function hasExactHeader(config: string, header: string): boolean {
  for (const line of config.split("\n")) {
    if (line.trim() === header) {
      return true;
    }
  }
  return false;
}

/** Best-effort append to the trust log; a logging failure is itself swallowed. */
function logTrust(env: Record<string, string | undefined>, line: string): void {
  try {
    const logPath = (env.KEEPER_CODEX_TRUST_LOG ?? "").trim();
    if (logPath === "") {
      return;
    }
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // best-effort — a logging failure is never fatal.
  }
}

/** Exclusively create + pid-stamp the lockfile. True on success, false on an
 *  O_EXCL collision or any IO error. Mirrors the docs-pusher's stampLock. */
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

/** Decide whether a pre-existing lock is orphaned and safe to reclaim: the stamped
 *  holder pid is verifiably gone (ESRCH), OR the lock is older than LOCK_STALE_MS.
 *  Any probe error → "not reclaimable" (never reclaim on doubt). Mirrors the
 *  docs-pusher's isLockStale. */
function isLockStale(lockPath: string): boolean {
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
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    // Signal 0 probes liveness without delivering a signal: throws ESRCH when no
    // such process exists (reclaimable). EPERM / any other error → holder alive.
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Try once to acquire the lock, reclaiming an orphaned holder. Mirrors the
 *  docs-pusher's tryAcquireLock (sans the skip semantics — the caller loops). */
function tryAcquireLock(lockPath: string): boolean {
  if (stampLock(lockPath)) {
    return true;
  }
  if (!isLockStale(lockPath)) {
    return false;
  }
  try {
    unlinkSync(lockPath);
  } catch {
    // Lost the reclaim race (another launch unlinked it first) or an IO error.
    return false;
  }
  return stampLock(lockPath);
}

/** Release the lockfile, swallowing a missing-file / IO error. An orphaned lock
 *  (holder hard-killed before release) is reclaimed by the next launch's staleness
 *  check, so a crash never blocks a pair forever. */
function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // best-effort.
  }
}

/** Busy-wait a small interval. Sub-`LOCK_RETRY_SLEEP_MS` granularity is fine — the
 *  lock is held for a single read + append, so contention windows are tiny. A busy
 *  loop keeps the helper synchronous (no async surface to thread through the
 *  fail-open caller). */
function sleepMs(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // spin
  }
}

/**
 * Seed codex per-directory trust for `cwd` so a detached interactive codex window
 * does not hang on the trust prompt. Idempotent, concurrency-safe, fail-open —
 * see the module doc. Returns a status token (never throws). The caller proceeds
 * to launch regardless of the outcome.
 */
export function ensureCodexDirTrust(
  opts: EnsureCodexDirTrustOptions,
): CodexTrustStatus {
  const home = opts.home ?? homedir();
  try {
    const codexHome = resolveCodexHome(opts.env, home);
    const configPath = join(codexHome, "config.toml");
    const lockPath = `${configPath}.keeper-trust.lock`;

    // Canonicalize the key — codex stores the realpath (macOS `/var`→`/private/var`),
    // so a raw cwd would mismatch and codex would still prompt. realpath of a
    // not-yet-existent path throws → fail-open via the outer catch.
    const key = realpathSync(opts.cwd);
    const escapedKey = escapeTomlKey(key);
    const header = projectHeaderLine(escapedKey);

    // FAST PATH (no lock): if the exact header is already present, respect it and
    // skip — never override a user's explicit trust_level value.
    if (existsSync(configPath)) {
      const existing = readFileSync(configPath, "utf8");
      if (hasExactHeader(existing, header)) {
        return "already-trusted";
      }
    }

    // SEED PATH: ensure the config dir exists BEFORE the lock loop (the lock lives
    // next to the config). A failure here — e.g. CODEX_HOME is a file (ENOTDIR) —
    // throws to the outer catch and fails open immediately, rather than spinning
    // the full lock-wait budget on a `wx` open that can never succeed.
    mkdirSync(codexHome, { recursive: true });

    // Acquire the lock (bounded wait-and-retry, NOT skip-on-contention).
    const deadline = Date.now() + LOCK_WAIT_TOTAL_MS;
    let acquired = false;
    while (Date.now() < deadline) {
      if (tryAcquireLock(lockPath)) {
        acquired = true;
        break;
      }
      sleepMs(LOCK_RETRY_SLEEP_MS);
    }
    if (!acquired) {
      logTrust(
        opts.env,
        `lock-timeout cwd=${opts.cwd} key=${key} lock=${lockPath}`,
      );
      return "lock-timeout";
    }

    try {
      // RE-READ + re-scan under the lock — a winner may have just seeded this key.
      if (existsSync(configPath)) {
        const current = readFileSync(configPath, "utf8");
        if (hasExactHeader(current, header)) {
          return "already-trusted";
        }
      }
      // Single append of a complete snippet — leading newline guarantees the new
      // table is separated from whatever precedes it (and is harmless on an empty
      // / freshly-created file).
      appendFileSync(configPath, `\n${header}\ntrust_level = "trusted"\n`);
      logTrust(opts.env, `seeded cwd=${opts.cwd} key=${key}`);
      return "seeded";
    } finally {
      releaseLock(lockPath);
    }
  } catch (err) {
    logTrust(
      opts.env,
      `error cwd=${opts.cwd}: ${(err as Error).message ?? String(err)}`,
    );
    return "error";
  }
}

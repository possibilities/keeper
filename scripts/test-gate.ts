#!/usr/bin/env bun
/**
 * Concurrency gate for `bun test` (fn-904). Autopilot fires several agents at
 * once; each running `bun test --parallel` (one worker per core) oversubscribes
 * the CPU and balloons a ~2.4 min suite to 7-8+ min. The gate serializes those
 * runs host-wide and caps the per-run parallelism so concurrent agents queue
 * instead of thrashing.
 *
 * `package.json`'s `test` / `test:full` scripts route through this wrapper. It:
 *
 *  1. Acquires a host-wide advisory `flock` on a DEDICATED path
 *     `~/.local/state/keeper/test.lock` (NOT a repo `.git/` lock — the contention
 *     is across agents on one host, independent of repo/worktree) so concurrent
 *     test runs serialize. `tryAcquire()` first; on contention print what we wait
 *     on to stderr, then poll-block up to `LOCK_TIMEOUT_MS`.
 *  2. Spawns `bun test`, forwarding ALL of the gate's own args verbatim (each
 *     package.json script owns its divergent `--path-ignore-patterns` list — the
 *     gate is generic and holds no ignore-list, so `test` vs `test:full` never
 *     drift), and injecting `--parallel=${KEEPER_TEST_PARALLEL:-4}` only if the
 *     forwarded args carry no `--parallel` already.
 *
 * Fail-open is the prime directive: a wedged gate holding `test.lock` would block
 * EVERY later agent — the exact failure this epic exists to prevent. So on a lock
 * timeout OR any lock error (parent-dir mkdir, openSync, flock dlopen, acquire)
 * we catch and run the suite anyway. The lock releases on EVERY exit path,
 * including SIGINT/SIGTERM. The child's exit code becomes the gate's exit code,
 * and stdio is inherited so the live progress autopilot agents watch survives.
 *
 * `KEEPER_TEST_NO_GATE` bypasses the LOCK only — the `--parallel` cap and the
 * package.json args still apply, so a bypassed run is still a valid, capped
 * suite.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CommitWorkLock } from "../src/commit-work/flock";

// Default per-run worker cap. `bun test --parallel=<N>` takes N worker processes
// and implies `--isolate`; 4 keeps a single run brisk without an agent claiming
// every core. `KEEPER_TEST_PARALLEL` overrides.
const DEFAULT_PARALLEL = 4;

// How long to wait for the host-wide lock before failing open and running the
// suite anyway. Generous (a full suite is minutes) but bounded so a crashed
// holder that somehow keeps the lock can never wedge an agent forever — the
// fail-open path runs tests on timeout.
const LOCK_TIMEOUT_MS = 12 * 60_000; // 12 min

// Poll interval while blocking on a held lock. `flock(LOCK_EX)` itself blocks,
// but a blocking FFI call cannot honor a timeout or a signal mid-wait; polling
// `tryAcquire()` keeps the wait interruptible and bounded.
const POLL_INTERVAL_MS = 500;

/** Resolve the dedicated host-wide lock path: `~/.local/state/keeper/test.lock`. */
export function testLockPath(): string {
  return join(homedir(), ".local", "state", "keeper", "test.lock");
}

/**
 * Build the `bun test` argv from the gate's forwarded args. Injects
 * `--parallel=${KEEPER_TEST_PARALLEL:-4}` only when no `--parallel` is already
 * present (either bare `--parallel` or `--parallel=<n>`) so a script that sets
 * its own parallelism wins. Pure over its inputs for the unit test.
 */
export function buildBunTestArgs(
  forwarded: string[],
  parallelEnv: string | undefined,
): string[] {
  const hasParallel = forwarded.some(
    (a) => a === "--parallel" || a.startsWith("--parallel="),
  );
  const args = ["test", ...forwarded];
  if (!hasParallel) {
    const n = normalizeParallel(parallelEnv);
    args.push(`--parallel=${n}`);
  }
  return args;
}

/** Parse `KEEPER_TEST_PARALLEL` into a positive integer, else the default. */
function normalizeParallel(raw: string | undefined): number {
  if (raw === undefined || raw.length === 0) {
    return DEFAULT_PARALLEL;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PARALLEL;
}

/** True when the lock should be bypassed (cap + args still apply). */
export function lockBypassed(): boolean {
  const v = process.env.KEEPER_TEST_NO_GATE;
  return v !== undefined && v.length > 0;
}

/**
 * Acquire the host-wide test lock, fail-open. Returns the held lock, or `null`
 * when the lock could not be acquired for ANY reason (bypass env, parent-dir
 * mkdir failure, openSync/dlopen/flock error, or the wait timing out) — in every
 * such case the caller runs the suite WITHOUT a lock rather than wedge the agent.
 *
 * On contention it prints what it is waiting on (and the holder pid when the lock
 * file carries one) to stderr, then polls `tryAcquire()` until the deadline.
 */
export async function acquireGate(
  lockPath: string,
): Promise<CommitWorkLock | null> {
  if (lockBypassed()) {
    process.stderr.write(
      "[test-gate] KEEPER_TEST_NO_GATE set — skipping host-wide lock\n",
    );
    return null;
  }
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch (err) {
    process.stderr.write(
      `[test-gate] lock parent mkdir failed (${err}); running un-gated\n`,
    );
    return null;
  }

  try {
    const immediate = CommitWorkLock.tryAcquire(lockPath);
    if (immediate !== null) {
      return immediate;
    }
  } catch (err) {
    process.stderr.write(
      `[test-gate] lock acquire errored (${err}); running un-gated\n`,
    );
    return null;
  }

  // Contended — another agent's suite holds the lock. Announce the wait, then
  // poll until acquired or the deadline elapses.
  process.stderr.write(
    `[test-gate] waiting for host-wide test lock at ${lockPath} ` +
      "(another agent's suite is running) ...\n",
  );

  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MS);
    try {
      const lock = CommitWorkLock.tryAcquire(lockPath);
      if (lock !== null) {
        return lock;
      }
    } catch (err) {
      process.stderr.write(
        `[test-gate] lock poll errored (${err}); running un-gated\n`,
      );
      return null;
    }
  }

  process.stderr.write(
    "[test-gate] lock wait timed out; running un-gated (fail-open)\n",
  );
  return null;
}

/**
 * Spawn `bun test` with inherited stdio and return its exit code. The lock (if
 * held) is released after the child exits via the caller's finally.
 */
async function runBunTest(args: string[]): Promise<number> {
  const child = Bun.spawn(["bun", ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await child.exited;
  return child.exitCode ?? 1;
}

async function main(): Promise<number> {
  const forwarded = Bun.argv.slice(2);
  const args = buildBunTestArgs(forwarded, process.env.KEEPER_TEST_PARALLEL);

  const lockPath = testLockPath();
  let lock: CommitWorkLock | null = null;
  // Release on EVERY exit path: normal return, and a SIGINT/SIGTERM that would
  // otherwise leave the lock held and wedge the next agent.
  const release = () => {
    if (lock !== null) {
      lock.release();
      lock = null;
    }
  };
  const onSignal = (sig: NodeJS.Signals) => {
    release();
    // Re-raise default disposition so the gate exits with the signal's status.
    process.kill(process.pid, sig);
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  try {
    lock = await acquireGate(lockPath);
    return await runBunTest(args);
  } finally {
    release();
  }
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // A gate bug must not silently swallow the suite — surface it, but still
      // fail (non-zero) so a broken gate is loud rather than green.
      process.stderr.write(`[test-gate] fatal: ${err}\n`);
      process.exit(1);
    });
}

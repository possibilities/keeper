/**
 * Bun test PRELOAD that closes the raw-`bun test` gate bypass (fn-934). The
 * gate script `scripts/test-gate.ts` only fires for `bun run test` / `test:full`;
 * a RAW `bun test` (an ad-hoc/agent run) sidesteps it entirely and can flood the
 * shared host with concurrent un-serialized suites — the exact starvation this
 * epic exists to prevent.
 *
 * Registered via `bunfig.toml`'s `[test] preload`, this module runs in-process at
 * the START of EVERY `bun test` invocation regardless of entry point. It acquires
 * the SAME host-wide advisory lock the gate uses (`~/.local/state/keeper/test.lock`)
 * and holds it for the whole test process, so concurrent test runs across agents
 * serialize instead of thrashing the CPU — even when launched raw.
 *
 * Self-deadlock avoidance: when the run came THROUGH the gate, the gate's PARENT
 * process already holds the lock and sets `KEEPER_TEST_GATED=1` on the spawned
 * child's env. The preload sees that flag and skips locking — re-acquiring the same
 * host-wide lock the parent holds would block the child forever. `KEEPER_TEST_NO_GATE`
 * skips the lock too (parity with the gate's bypass).
 *
 * Fail-open is the prime directive (same as the gate): ANY lock error or a wait
 * timeout runs the suite anyway rather than wedge an agent. The lock releases on
 * every process-exit path.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CommitWorkLock } from "../src/commit-work/flock";

// Bound the wait for the host-wide lock, then fail open. Matches the gate's
// generous-but-bounded budget so a crashed holder can never wedge an agent.
const LOCK_TIMEOUT_MS = 12 * 60_000; // 12 min
const POLL_INTERVAL_MS = 500;

/** Host-wide test lock path, identical to `scripts/test-gate.ts`. */
function testLockPath(): string {
  return join(homedir(), ".local", "state", "keeper", "test.lock");
}

/** True when locking should be skipped: gated by the wrapper (parent holds it) or
 * explicitly bypassed. */
function lockSkipped(): boolean {
  const gated = process.env.KEEPER_TEST_GATED;
  if (gated !== undefined && gated.length > 0) {
    return true;
  }
  const noGate = process.env.KEEPER_TEST_NO_GATE;
  return noGate !== undefined && noGate.length > 0;
}

/** Acquire the host-wide lock (blocking-poll, bounded), fail-open to `null`. */
async function acquire(lockPath: string): Promise<CommitWorkLock | null> {
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    return null;
  }
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let announced = false;
  for (;;) {
    try {
      const lock = CommitWorkLock.tryAcquire(lockPath);
      if (lock !== null) {
        return lock;
      }
    } catch {
      return null; // fail-open on any lock error
    }
    if (Date.now() >= deadline) {
      process.stderr.write(
        "[test-preload] lock wait timed out; running un-gated (fail-open)\n",
      );
      return null;
    }
    if (!announced) {
      process.stderr.write(
        `[test-preload] waiting for host-wide test lock at ${lockPath} ` +
          "(another suite is running) ...\n",
      );
      announced = true;
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

if (!lockSkipped()) {
  const lock = await acquire(testLockPath());
  if (lock !== null) {
    // Release on every process-exit path: the test runner exiting normally and a
    // SIGINT/SIGTERM that would otherwise strand the lock and wedge the next run.
    const release = () => lock.release();
    process.on("exit", release);
    process.once("SIGINT", () => {
      release();
      process.kill(process.pid, "SIGINT");
    });
    process.once("SIGTERM", () => {
      release();
      process.kill(process.pid, "SIGTERM");
    });
  }
}

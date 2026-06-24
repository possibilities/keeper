// Bun test PRELOAD that brings the plan plugin's own `bun test` under the same
// host-wide serialization the keeper gate enforces (fn-934). The plan suite runs
// via its own `bun test` and is path-ignored by the keeper gate, so it would
// otherwise run un-gated AND un-serialized — a raw/agent run could flood the
// shared host alongside other suites.
//
// Registered via `bunfig.toml`'s `[test] preload`, this acquires the SAME
// host-wide advisory lock the keeper gate uses (`~/.local/state/keeper/test.lock`)
// and holds it for the whole plan test process, so the plan suite serializes
// against every other keeper/plan suite on the host.
//
// This module is hook-context dep-free by the plan-plugin rule: it imports ONLY
// the plan plugin's own `src/flock.ts` primitives + node builtins, never the
// keeper root `src/`.
//
// Self-deadlock avoidance + fail-open mirror `scripts/test-preload.ts`:
// `KEEPER_TEST_GATED=1` (parent already holds it) or `KEEPER_TEST_NO_GATE` skips
// locking; any lock error or wait timeout runs the suite anyway.

import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { flock, LOCK_EX, LOCK_NB, LOCK_UN } from "../src/flock.ts";

const LOCK_TIMEOUT_MS = 12 * 60_000; // 12 min
const POLL_INTERVAL_MS = 500;

function testLockPath(): string {
  const home = process.env.HOME || homedir();
  return join(home, ".local", "state", "keeper", "test.lock");
}

function lockSkipped(): boolean {
  const gated = process.env.KEEPER_TEST_GATED;
  if (gated !== undefined && gated.length > 0) {
    return true;
  }
  const noGate = process.env.KEEPER_TEST_NO_GATE;
  return noGate !== undefined && noGate.length > 0;
}

/** Acquire the host-wide lock (non-blocking poll, bounded), fail-open to null. */
async function acquire(lockPath: string): Promise<number | null> {
  let fd: number;
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    fd = openSync(lockPath, "w");
  } catch {
    return null;
  }
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let announced = false;
  for (;;) {
    if (flock(fd, LOCK_EX | LOCK_NB) === 0) {
      return fd;
    }
    if (Date.now() >= deadline) {
      process.stderr.write(
        "[plan test-preload] lock wait timed out; running un-gated (fail-open)\n",
      );
      closeSync(fd);
      return null;
    }
    if (!announced) {
      process.stderr.write(
        `[plan test-preload] waiting for host-wide test lock at ${lockPath} ` +
          "(another suite is running) ...\n",
      );
      announced = true;
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

if (!lockSkipped()) {
  const fd = await acquire(testLockPath());
  if (fd !== null) {
    const release = () => {
      flock(fd, LOCK_UN);
      closeSync(fd);
    };
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

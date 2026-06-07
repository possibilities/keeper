/**
 * Daemon-readiness probe for the slow (serial) integration/daemon tier.
 *
 * Replaces the fixed `Bun.sleep(300/400)` boot waits that raced the daemon's
 * migrate + boot-drain + server-worker socket bind. A fixed sleep is a flake
 * on both ends: too short on a loaded machine (the reader's `openDb` hits
 * `SQLITE_CANTOPEN` because the file isn't bootstrapped yet — observed live)
 * and wasted time on a fast one.
 *
 * The daemon's boot order is: migrate the DB (creates + schemas the file) →
 * boot drain → seed sweep → spawn the ten workers, the server-worker among
 * them binds the UDS socket. So a BOUND socket is a strict
 * happens-after-migrate signal: once `sockPath` exists AND accepts a
 * `Bun.connect`, the DB file is guaranteed present + migrated and a read-only
 * `openDb` will succeed. We poll for both (file-exists is cheap; the connect
 * confirms the listener is actually accepting, not a stale socket inode).
 *
 * NOT a substitute for the per-assertion `retryUntil` polls — those wait for a
 * specific projection to fold. This only gates "the daemon has finished
 * booting" so the first reader open + first hook fire don't race the bootstrap.
 */
import { existsSync } from "node:fs";

/**
 * Resolve once the daemon at `sockPath` has bound its UDS listener (which
 * happens-after migrate + boot drain), or throw on timeout. Polls
 * file-existence then a real `Bun.connect` so a stale socket inode (left by a
 * crashed prior run) can't satisfy the gate.
 */
export async function waitForDaemon(
  sockPath: string,
  // Generous ceiling: under the serial slow tier, a freshly-spawned daemon
  // boots alongside a prior test's still-tearing-down @parcel/watcher worker
  // threads, so first-bind latency spikes well past a single daemon's
  // sub-100ms cold boot. This is a readiness GATE (proceed-when-ready), not a
  // latency assertion — the headroom matches the per-test 30s timeout so a slow
  // boot waits instead of flaking, while a genuinely wedged daemon still
  // surfaces as a clean "socket not ready" throw rather than an opaque hang.
  timeoutMs = 30_000,
  cadenceMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(sockPath) && (await canConnect(sockPath))) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `daemon socket ${sockPath} not ready within ${timeoutMs}ms`,
      );
    }
    await Bun.sleep(cadenceMs);
  }
}

/** Best-effort: can we open + immediately close a UDS connection to `sockPath`? */
async function canConnect(sockPath: string): Promise<boolean> {
  try {
    const conn = await Bun.connect({
      unix: sockPath,
      socket: { data() {}, error() {} },
    });
    conn.end();
    return true;
  } catch {
    return false;
  }
}

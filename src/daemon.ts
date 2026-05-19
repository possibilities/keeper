/**
 * Keeper daemon — the long-running reducer process. Managed in production by a
 * LaunchAgent that re-runs `bun run src/daemon.ts` on any non-clean exit.
 *
 * Boot sequence (the locked design):
 *
 *   1. Open the writer connection (`openDb`). DDL + forward-only migration run
 *      inside `openDb`; the reducer_state cursor is seeded there too.
 *   2. Boot drain: `while (drain(db, BATCH) > 0) {}` — fold every unfolded event
 *      using the SAME code path as steady-state. After downtime this catches the
 *      projection up before the daemon goes live.
 *   3. Spawn the wake worker. It opens its own read-only connection and polls
 *      `PRAGMA data_version`, posting a contentless `{ kind: "wake" }` whenever
 *      another connection commits.
 *   4. Steady state: every wake triggers a full drain loop. Wakes that arrive
 *      mid-drain coalesce into the next pass via a single "wake pending" flag —
 *      no event is missed (drain always re-reads from the cursor) and drain is
 *      never invoked re-entrantly.
 *   5. SIGTERM: post `{ type: "shutdown" }` to the worker, await its termination
 *      with a short deadline, close the db, exit 0. This is the ONLY clean exit.
 *
 * Crash policy (single recovery path): ANY unrecoverable error — a worker
 * `error` event, an unhandled rejection, or a fold throw that escapes the
 * per-event guard — calls `process.exit(1)`. The LaunchAgent
 * `KeepAlive.SuccessfulExit = false` then restarts us. We deliberately keep ONE
 * well-tested recovery path rather than attempting in-process self-heal.
 */

import type { Database } from "bun:sqlite";
import { openDb, resolveDbPath } from "./db";
import { DEFAULT_BATCH_SIZE, drain } from "./reducer";
import type {
  ShutdownMessage,
  WakeMessage,
  WakeWorkerData,
} from "./wake-worker";

/** Grace period for the worker to exit on shutdown before we close the db anyway. */
const WORKER_SHUTDOWN_DEADLINE_MS = 2000;

/**
 * Drain the projection to completion: loop `drain()` until it reports 0 newly
 * folded events. Shared by boot catch-up and every steady-state wake — the same
 * idempotent code path the design mandates. Each `drain()` call folds at most
 * `batchSize` events in their own transactions, so the writer lock is released
 * between batches and hook inserts are never starved.
 */
export function drainToCompletion(
  db: Database,
  batchSize = DEFAULT_BATCH_SIZE,
): void {
  while (drain(db, batchSize) > 0) {
    // keep folding until caught up
  }
}

/**
 * Run the daemon. Returns once the process is wired up and the steady-state
 * wake loop is running; the loop itself keeps the event loop alive until SIGTERM
 * or a crash. Exported (rather than executed at import) so a test can drive boot
 * drain in isolation via {@link drainToCompletion} without spawning the worker.
 */
function runDaemon(): void {
  process.title = "keeperd";

  const dbPath = resolveDbPath();
  const { db } = openDb(dbPath);

  // Step 2 — boot drain. MUST finish before the worker spawns: otherwise the
  // worker would fire wakes against a writer connection still iterating boot
  // drain (harmless, drain is idempotent, but wasteful).
  drainToCompletion(db);

  // Coalescing flag: every wake sets it; the run loop resets it before each
  // drain pass. A wake arriving mid-drain leaves the flag set, so the loop runs
  // one more pass. No event is ever missed because drain re-reads from the
  // cursor on every pass.
  let wakePending = false;
  let draining = false;
  let shuttingDown = false;

  /**
   * Process the wake signal. Re-entrancy guard (`draining`) ensures we never
   * call drain recursively if a wake lands while we're already inside the loop;
   * that wake just leaves `wakePending` set for the in-flight loop to pick up.
   */
  function pumpWakes(): void {
    if (draining) {
      return;
    }
    draining = true;
    try {
      while (wakePending && !shuttingDown) {
        wakePending = false;
        drainToCompletion(db);
      }
    } finally {
      draining = false;
    }
  }

  // Step 3 — spawn the wake worker. Bun uses the web Worker API; `workerData`
  // is a worker_threads option not in the DOM lib type, hence the cast.
  const worker = new Worker(new URL("./wake-worker.ts", import.meta.url).href, {
    workerData: { dbPath, pollMs: 50 } satisfies WakeWorkerData,
  } as WorkerOptions & { workerData: unknown });

  // Step 4 — each wake message triggers a (coalescing) drain pass.
  worker.onmessage = (ev: MessageEvent<WakeMessage | undefined>): void => {
    if (ev.data && ev.data.kind === "wake") {
      wakePending = true;
      pumpWakes();
    }
  };

  // Worker `error` event is NOT a message — it signals the worker thread itself
  // failed. Per the single-recovery-path policy: crash → exit 1 → launchd
  // restarts. Do NOT attempt to respawn the worker in-process.
  worker.onerror = (err: ErrorEvent): void => {
    console.error("[keeperd] wake worker error:", err.message ?? err);
    fatalExit();
  };

  /** Crash exit. Reserved for unrecoverable errors so launchd restarts us. */
  function fatalExit(): void {
    try {
      db.close();
    } catch {
      // best-effort; we're crashing either way
    }
    process.exit(1);
  }

  // Unrecoverable async errors that escape every guard also take the single
  // recovery path. (A fold throw inside drain bubbles here if it ever escapes
  // the reducer's per-event handling.)
  process.on("unhandledRejection", (reason) => {
    console.error("[keeperd] unhandled rejection:", reason);
    fatalExit();
  });
  process.on("uncaughtException", (err) => {
    console.error("[keeperd] uncaught exception:", err);
    fatalExit();
  });

  // Step 5 — clean shutdown. The ONLY path that exits 0; under
  // KeepAlive.SuccessfulExit = false a clean exit tells launchd NOT to restart.
  async function shutdown(): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    worker.postMessage({ type: "shutdown" } satisfies ShutdownMessage);

    // Bun surfaces worker exit via the "close" event. Race it against a deadline
    // so a wedged worker can't block our clean shutdown forever.
    const exited = new Promise<void>((resolve) => {
      worker.addEventListener("close", () => resolve());
    });
    await Promise.race([exited, Bun.sleep(WORKER_SHUTDOWN_DEADLINE_MS)]);

    try {
      worker.terminate();
    } catch {
      // best-effort if it already exited
    }

    try {
      db.close();
    } catch {
      // best-effort
    }

    process.exit(0);
  }

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
}

// Only boot the daemon when this file is the process entry point. A plain
// `import` (e.g. a test driving `drainToCompletion` against a tmp DB) must NOT
// spawn the worker or install signal handlers. Mirrors wake-worker's
// `isMainThread` guard.
if (import.meta.main) {
  runDaemon();
}

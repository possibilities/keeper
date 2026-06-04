/**
 * Wake worker. Runs as a Bun Worker thread spawned by the daemon. Its only job
 * is to notice when ANOTHER connection commits to the keeper DB and post a
 * contentless `{ kind: "wake" }` to the parent so the daemon re-drains.
 *
 * Why polling `PRAGMA data_version` and not a filesystem watcher:
 * - FSEvents/kqueue/`fs.watch` drop same-process writes and miss WAL writes
 *   (which land in `keeper.db-wal`, not `keeper.db`) on macOS. Confirmed not
 *   viable — `data_version` polling is the correct primitive on darwin.
 * - `data_version` is connection-local and only increments when a DIFFERENT
 *   connection commits. The worker opens its OWN read-only connection (handles
 *   are thread-affine and not structured-cloneable — the parent cannot hand us
 *   its Database; we get only the path string via `workerData`).
 * - The counter only moves while we stay in autocommit. A surrounding `BEGIN`
 *   would pin a read snapshot and freeze our visibility of new commits, so we
 *   issue naked `PRAGMA data_version` reads with no transaction.
 *
 * The wake is a signal, not a hint: the parent re-reads from
 * `reducer_state.last_event_id` regardless of payload, so we never need to
 * carry the changed rows — just the bare `{ kind: "wake" }`.
 *
 * Startup data crosses the boundary via `node:worker_threads` `workerData`,
 * which Bun supports. We never try to pass the parent's Database handle.
 */

import type { Database } from "bun:sqlite";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { openDb } from "./db";

/**
 * Data the parent passes via `new Worker(url, { workerData })` — only the DB
 * path and an optional poll cadence, since the Database handle cannot cross the
 * Worker boundary.
 */
export interface WakeWorkerData {
  dbPath: string;
  /**
   * Poll cadence in ms. Defaults to 25ms (fn-694 lever B2 — halved from 50 to
   * cut the worst case of the FIRST, irreducible poll; the second poll is
   * collapsed by main's post-fold kick to the server-worker). Floored at 25ms
   * (`MIN_POLL_MS`) to avoid burning a core.
   */
  pollMs?: number;
}

/** Message posted to the parent on any data_version change. Contentless. */
export interface WakeMessage {
  kind: "wake";
}

/** Message the parent sends to ask the worker to stop. */
export interface ShutdownMessage {
  type: "shutdown";
}

// fn-694 lever B2: halved 50→25ms to cut the worst-case latency of the FIRST
// (irreducible) `data_version` poll — the hook is fire-and-forget, so main can
// only learn of a hook write via this poll. Floored at `MIN_POLL_MS`; the
// extra idle `PRAGMA data_version` reads are negligible.
const DEFAULT_POLL_MS = 25;
const MIN_POLL_MS = 25;

interface DataVersionRow {
  data_version: number;
}

/**
 * Run the watch loop against an already-open read-only connection. Exported so
 * the loop can be driven directly in tests without spawning a real Worker.
 *
 * Polls `PRAGMA data_version` every `pollMs`; on any change from the last seen
 * value, invokes `onWake`. `isShutdown` is checked each iteration so the loop
 * tears down cleanly. Resolves once `isShutdown()` returns true.
 */
export async function watchLoop(
  db: Database,
  onWake: () => void,
  isShutdown: () => boolean,
  pollMs: number = DEFAULT_POLL_MS,
): Promise<void> {
  const interval = Math.max(MIN_POLL_MS, pollMs);
  // Naked autocommit read — no BEGIN, or the counter freezes for this conn.
  const query = db.query("PRAGMA data_version");
  let last = (query.get() as DataVersionRow).data_version;

  while (!isShutdown()) {
    await Bun.sleep(interval);
    if (isShutdown()) {
      break;
    }
    const cur = (query.get() as DataVersionRow).data_version;
    if (cur !== last) {
      last = cur;
      onWake();
    }
  }
}

/**
 * Worker entrypoint. Opens its own read-only connection, wires the shutdown
 * message, and runs the watch loop until told to stop.
 */
function main(): void {
  if (!parentPort) {
    console.error("[wake-worker] no parentPort — not running as a Worker");
    process.exit(1);
  }

  const data = workerData as WakeWorkerData | undefined;
  if (!data || typeof data.dbPath !== "string") {
    // Without a path we cannot open a connection. Exit non-zero so the parent's
    // single recovery path (process.exit(1) → LaunchAgent restart) engages.
    console.error("[wake-worker] missing dbPath in workerData");
    process.exit(1);
  }

  const { db } = openDb(data.dbPath, { readonly: true });
  let shutdown = false;

  parentPort.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg && msg.type === "shutdown") {
      shutdown = true;
    }
  });

  const closeDb = (): void => {
    try {
      db.close();
    } catch {
      // best-effort; we're exiting either way
    }
  };

  watchLoop(
    db,
    () => parentPort?.postMessage({ kind: "wake" } satisfies WakeMessage),
    () => shutdown,
    data.pollMs,
  )
    .then(() => {
      // Clean shutdown path: parent asked us to stop.
      closeDb();
      process.exit(0);
    })
    .catch((err) => {
      console.error("[wake-worker] watch loop crashed:", err);
      closeDb();
      process.exit(1);
    });
}

// Only run the loop when actually executing inside a Worker. A plain `import`
// from a test runs on the main thread, where `main()` must not fire.
if (!isMainThread) {
  main();
}

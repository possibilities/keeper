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
import { type BackstopMessage, buildTimeoutRecord } from "./backstop-telemetry";
import { openDb } from "./db";
import { NotadbTolerance } from "./notadb-tolerance";

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
  /**
   * Worker-role discriminator. The bottom-of-file entrypoint runs `main()`
   * ONLY when this is `"wake"`. Consumer worker modules (autopilot / renamer /
   * restore) import this module for its `watchLoop` export and run
   * as `!isMainThread` themselves — the gate stops their import from booting
   * a stowaway wake loop (its own DB connection + an ignored `{kind:"wake"}`
   * stream) inside their threads.
   */
  role?: "wake";
}

/** Message posted to the parent on any data_version change. Contentless. */
export interface WakeMessage {
  kind: "wake";
}

/**
 * Every shape the wake-worker posts to main: the contentless wake pulse,
 * plus the backstop-telemetry channel (fn-1096.3 — a `notadb-skip` record
 * when `watchLoop`'s `PRAGMA data_version` poll tolerates a transient
 * `SQLITE_NOTADB`).
 */
export type WakeWorkerOutbound = WakeMessage | BackstopMessage;

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

export interface WatchLoopScheduler {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realWatchLoopScheduler: WatchLoopScheduler = {
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
};

export interface WatchLoopState {
  lastVersion: number | null;
  lastWakeAt: number;
}

export function stepWatchLoop(
  state: WatchLoopState,
  currentVersion: number | null,
  now: number,
  maxIdleMs: number,
): { state: WatchLoopState; wake: boolean } {
  if (currentVersion !== null && currentVersion !== state.lastVersion) {
    return {
      state: { lastVersion: currentVersion, lastWakeAt: now },
      wake: true,
    };
  }
  if (maxIdleMs > 0 && now - state.lastWakeAt >= maxIdleMs) {
    return {
      state: { lastVersion: state.lastVersion, lastWakeAt: now },
      wake: true,
    };
  }
  return { state, wake: false };
}

/**
 * Run the watch loop against an already-open read-only connection. Exported so
 * the loop can be driven directly in tests without spawning a real Worker.
 *
 * Polls `PRAGMA data_version` every `pollMs`; on any change from the last seen
 * value, invokes `onWake`. `isShutdown` is checked each iteration so the loop
 * tears down cleanly. Resolves once `isShutdown()` returns true.
 *
 * `maxIdleMs` (default 0 = disabled) adds a coalesced IDLE wake: when set, the
 * loop also fires `onWake` once at least `maxIdleMs` of wall time has passed
 * since the last `onWake` (whether that wake came from a data_version change or
 * a prior idle tick). This lets a consumer whose work is NOT triggered by a DB
 * commit (the restore-worker's whole-server tmux topology probe — a pane move
 * happens out-of-band, with no keeper write) still pulse on a periodic cadence.
 * It COALESCES by construction: a data_version change resets the idle clock, so
 * a fresh commit and an overdue idle tick never both fire in one iteration —
 * one `onWake` per loop turn, never two.
 *
 * fn-1096.3: a transient SQLITE_NOTADB on the `data_version` read is a
 * boot-checkpoint view race, not corruption — tolerated via the shared
 * `NotadbTolerance` helper (skip this tick, bounded consecutive-miss
 * rethrow) rather than letting it crash the worker. Shared by every
 * `watchLoop` consumer (wake-worker itself, handoff/renamer/restore
 * workers). `onNotadbSkip` — when given — is invoked with the running
 * consecutive-miss count on every tolerated skip so the caller can post
 * countable backstop telemetry; omitted, a rate-limited-by-nature
 * (skips are rare) `console.error` line covers the default case.
 */
export async function watchLoop(
  db: Database,
  onWake: () => void,
  isShutdown: () => boolean,
  pollMs: number = DEFAULT_POLL_MS,
  maxIdleMs = 0,
  onNotadbSkip?: (consecutiveMisses: number) => void,
  scheduler: WatchLoopScheduler = realWatchLoopScheduler,
): Promise<void> {
  const interval = Math.max(MIN_POLL_MS, pollMs);
  // Naked autocommit read — no BEGIN, or the counter freezes for this conn.
  const query = db.query("PRAGMA data_version");
  const tolerance = new NotadbTolerance();
  const readVersion = (): number | null => {
    const outcome = tolerance.poll(
      () => (query.get() as DataVersionRow).data_version,
    );
    if (outcome.skipped) {
      if (onNotadbSkip) {
        onNotadbSkip(outcome.consecutiveMisses);
      } else {
        // Generic label — `watchLoop` is shared across several worker
        // identities (wake / handoff / renamer / restore), so a consumer
        // that didn't wire `onNotadbSkip` still gets a grep-countable line
        // without falsely attributing it to "wake-worker".
        console.error(
          `[data-version-poll] transient SQLITE_NOTADB — skipped tick (consecutive=${outcome.consecutiveMisses})`,
        );
      }
      return null;
    }
    return outcome.value;
  };
  // A tolerated NOTADB on this VERY FIRST read seeds a `null` baseline — the
  // loop below treats `last === null` as "unknown, always re-diff on the
  // next successful read," never a false suppression.
  let state: WatchLoopState = {
    lastVersion: readVersion(),
    lastWakeAt: scheduler.now(),
  };

  while (!isShutdown()) {
    await scheduler.sleep(interval);
    if (isShutdown()) {
      break;
    }
    const step = stepWatchLoop(
      state,
      readVersion(),
      scheduler.now(),
      maxIdleMs,
    );
    state = step.state;
    if (step.wake) {
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

  const { db } = openDb(data.dbPath, {
    readonly: true,
    prepareStmts: false,
    bootRetry: true,
  });
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
    0,
    // fn-1096.3: countable backstop telemetry for a tolerated transient
    // SQLITE_NOTADB on the data_version poll.
    (consecutiveMisses) => {
      console.error(
        `[wake-worker] transient SQLITE_NOTADB on data_version poll — skipped tick (consecutive=${consecutiveMisses})`,
      );
      parentPort?.postMessage({
        kind: "backstop",
        record: buildTimeoutRecord({
          backstop: "notadb-skip",
          worker: "wake-worker",
          rescued: true,
          now: Date.now(),
          stalenessMs: null,
          detail: { consecutive_misses: String(consecutiveMisses) },
        }),
      } satisfies BackstopMessage);
    },
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

// Only run inside a real Worker spawned AS the wake worker (`role: "wake"`).
// A plain import on the main thread is inert; an import from ANOTHER worker
// module (autopilot / renamer / restore pull `watchLoop` from here)
// must NOT boot a stowaway wake loop in that thread — the role gate enforces
// that.
if (
  !isMainThread &&
  (workerData as WakeWorkerData | undefined)?.role === "wake"
) {
  main();
}

/**
 * Events-ingest watcher worker (fn-736 task .1). keeperd's watch-hint thread
 * for the lock-free events path — the architectural twin of
 * {@link import("./dead-letter-worker")}, joining the producer-worker fleet.
 *
 * The lock-free rework (epic fn-736) flips the hook from a direct SQLite
 * `INSERT INTO events` to a per-pid NDJSON append under
 * `~/.local/state/keeper/events-log/` (task .2 — until then the hook still
 * INSERTs and this dir stays empty/absent, a tolerated no-op). This worker
 * watches that dir with `@parcel/watcher` and posts a contentless
 * `{kind: "events-log-changed"}` message to main whenever the tree changes.
 *
 * MAIN owns the actual `events` write (main is the DB writer, per the "no
 * general write path into the reducer" invariant). On every worker message AND
 * once at boot, main scans each per-pid file FROM ITS DURABLE BYTE-OFFSET,
 * parses each complete line crash-safely (mirror `parseEventLogLine` — null on
 * partial/garbage), and `INSERT INTO events` (assigning the integer id) WITH the
 * per-pid offset advance in ONE `BEGIN IMMEDIATE` — the sacred atomic-cursor
 * invariant, applied to NDJSON→events. The existing fold (`drain()`/
 * `applyEvent()`) reads `events` UNCHANGED, so re-fold determinism is preserved
 * by construction. The two-step (worker watches, main scans+writes) keeps the
 * DB writer single-threaded; the worker holds only a watcher subscription, no
 * DB handle.
 *
 * NOT a fold: the ingest path is UPSTREAM of the fold — it lands rows in the
 * `events` log; the reducer folds them on the next drain pass. The ingester's
 * own `events` INSERT (on main's writer conn) bumps `data_version`, so the
 * existing pollers (wake worker, server worker) wake for FREE — the only new
 * trigger needed is this worker's file-watch hint.
 *
 * Worker contract (see CLAUDE.md "Worker contract"):
 * - `isMainThread` guard — a plain import is inert.
 * - No DB connection (the worker doesn't read or write the DB; main does it
 *   all). Skipping `openDb` keeps the worker featherlight.
 * - Typed message protocol: `{kind:"events-log-changed"}` worker→main,
 *   `{type:"shutdown"}` main→worker. Exit 0 clean / 1 crash.
 * - Subsystem-style teardown: the `@parcel/watcher` subscription is an owned
 *   external resource, `unsubscribe()`d in the shutdown handler.
 *
 * Why a native file watcher when keeper's DO-NOT bans `fs.watch` / FSEvents on
 * keeper's OWN DB: same carve-out as `dead-letter-worker`. The events-log tree
 * is EXTERNAL — written by the hook plugin process (a different process from
 * keeperd), so the same-process-write blind spot does not apply. Every watch
 * event is "go look" (post a message); main re-scans each file FROM ITS DURABLE
 * OFFSET (NEVER byte 0). A drop / FSEvents overrun (`isDropError`) schedules the
 * same single-flight re-scan via the shared {@link RescanScheduler} primitive —
 * and because main always re-reads from the durable offset, the offset-aware
 * drop-recovery is correct, not just present: a dropped event costs at most one
 * missed wake, which the next change (or boot) recovers without re-ingesting a
 * single already-landed line. The events dir churns FAR more than dead-letter,
 * so this correctness matters more here.
 *
 * Missing-dir tolerance: a fresh machine has no `events-log/` tree until the
 * hook's first append (and in task .1 the hook never appends — it still
 * INSERTs). The worker tolerates absence at spawn (the `@parcel/watcher`
 * `subscribe` requires the dir to exist, so it skip-and-logs and stays alive for
 * the shutdown handshake — same shape as `dead-letter-worker`). Main's boot
 * scan applies the same tolerance via `existsSync`.
 */

import { existsSync } from "node:fs";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { AsyncSubscription } from "@parcel/watcher";
import { isDropError, RescanScheduler } from "./rescan";

/**
 * Data the parent passes via `new Worker(url, { workerData })`. Only path
 * strings cross the boundary — no DB handle, since this worker doesn't open
 * one. The path is the directory the hook writes per-pid NDJSON files into.
 */
export interface EventsIngestWorkerData {
  /**
   * Absolute path to the events-log dir. The parent resolves this from
   * {@link import("./db").resolveEventsLogDir} (`KEEPER_EVENTS_LOG` env wins;
   * default `~/.local/state/keeper/events-log`). Overridable so tests point at
   * hermetic tmp dirs.
   */
  dir: string;
  /**
   * fn-747 watcher seam. When `true`, the worker NEVER `import()`s
   * `@parcel/watcher` — it skips the live FSEvents subscribe and stays alive
   * only for the shutdown handshake. The in-process daemon harness sets this so
   * the parallel slow-test tier never dlopens the NAPI addon in a worker thread
   * (the SIGTRAP source). Correctness is preserved: main's own
   * `eventsIngestFallbackTimer` poll (re-scan each per-pid file from its durable
   * byte-offset every interval) ingests every NDJSON line regardless — the
   * watcher subscribe is a latency hint, not the data path.
   */
  disableNativeWatcher?: boolean;
}

/**
 * Contentless "go look" message — the worker carries no payload because main
 * re-reads each per-pid file FROM ITS DURABLE OFFSET on each notification (the
 * safe-value pattern: treat watcher events as triggers, never as data). One
 * message per watcher callback firing — bursts are absorbed by main's scan
 * being idempotent (the atomic per-pid byte-offset is the exactly-once guard).
 */
export interface EventsLogChangedMessage {
  kind: "events-log-changed";
}

/** Message the parent sends to ask the worker to stop. */
export interface ShutdownMessage {
  type: "shutdown";
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Worker entrypoint. Subscribes to the events-log dir and posts a
 * `{kind:"events-log-changed"}` message on every change event (and on
 * recoverable FSEvents drops, via the shared {@link RescanScheduler}). The
 * subscription is the worker's only owned external resource — `unsubscribe()`d
 * in the shutdown handler.
 */
function main(): void {
  if (!parentPort) {
    console.error(
      "[events-ingest-worker] no parentPort — not running as a Worker",
    );
    process.exit(1);
  }

  const data = workerData as EventsIngestWorkerData | undefined;
  if (!data || typeof data.dir !== "string") {
    console.error("[events-ingest-worker] missing dir in workerData");
    process.exit(1);
  }

  const port = parentPort;
  const dir = data.dir;

  let subscription: AsyncSubscription | null = null;
  let shuttingDown = false;

  // Drop-recovery scheduler: a recoverable FSEvents drop schedules a debounced,
  // single-flight notification to main (same idempotent re-scan primitive
  // dead-letter/plan/transcript workers use). The scan body posts a single
  // "go look" message — main does the actual per-file offset-aware scan +
  // INSERT, so a redundant message is harmless (the durable offset re-reads
  // exactly the unread tail).
  const rescan = new RescanScheduler(() => {
    if (shuttingDown) {
      return;
    }
    port.postMessage({
      kind: "events-log-changed",
    } satisfies EventsLogChangedMessage);
  });

  parentPort.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg && msg.type === "shutdown") {
      shuttingDown = true;
      // Clear any armed re-scan timer FIRST (mirrors the dead-letter-worker
      // teardown order) so a pending drop-recovery notification can't fire
      // after we've started unsubscribing.
      rescan.cancel();
      // Release the watcher subscription (external resource), then exit clean.
      // The worker has no DB handle, so there's nothing to close.
      void (async () => {
        if (subscription) {
          try {
            await subscription.unsubscribe();
          } catch {
            // best-effort
          }
          subscription = null;
        }
        process.exit(0);
      })();
    }
  });

  // The events-log dir may not exist yet on a fresh machine — and in task .1 the
  // hook still INSERTs, so it stays absent until task .2 flips the hook.
  // `@parcel/watcher`'s `subscribe` REQUIRES an existing dir, so tolerate
  // absence the same way `dead-letter-worker` does: skip-and-log, stay alive
  // (the parentPort listener keeps the event loop running for the shutdown
  // handshake). Main's boot scan also tolerates absence; a later first-append
  // creates the dir and a subsequent daemon restart picks up the file.
  if (!existsSync(dir)) {
    console.error(
      `[events-ingest-worker] events-log dir ${dir} does not exist; not watching`,
    );
    return;
  }

  // fn-747 watcher seam: skip the native addon dlopen entirely in the
  // in-process tier. Main's `eventsIngestFallbackTimer` poll still ingests every
  // NDJSON line, so this worker just stays alive (the parentPort listener keeps
  // the event loop running) for the shutdown handshake.
  if (data.disableNativeWatcher) {
    return;
  }

  // `subscribe` is the only unrecoverable surface — a rejection (addon load
  // failure, EPERM on the dir) exits non-zero → daemon fatalExit → launchd
  // restart. Recoverable errors (FSEvents drops, transient read failures) stay
  // swallow-and-log per the producer-worker pattern.
  import("@parcel/watcher")
    .then((watcher) =>
      watcher.subscribe(dir, (err, _events) => {
        if (err) {
          console.error(
            `[events-ingest-worker] watcher error: ${stringifyErr(err)}`,
          );
          if (isDropError(err)) {
            rescan.schedule();
          }
          return;
        }
        // Contentless "go look": main re-scans each per-pid file from its
        // durable offset on each notification. We don't filter `_events` here —
        // main's scan is idempotent (atomic offset) and re-reads the unread
        // tail from scratch, so a batched-but-otherwise-empty event list (which
        // @parcel/watcher can deliver under low-rate churn) still triggers the
        // safe re-read.
        port.postMessage({
          kind: "events-log-changed",
        } satisfies EventsLogChangedMessage);
      }),
    )
    .then((sub) => {
      if (shuttingDown) {
        // Shutdown raced the subscribe resolution — release immediately.
        void sub.unsubscribe();
        return;
      }
      subscription = sub;
    })
    .catch((err) => {
      console.error(
        `[events-ingest-worker] failed to subscribe to ${dir}: ${stringifyErr(err)}`,
      );
      process.exit(1);
    });
}

// Only run inside a real Worker; a plain import on the main thread (tests
// driving main's scan path) is inert.
if (!isMainThread) {
  main();
}

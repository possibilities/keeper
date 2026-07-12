/**
 * Dead-letter watcher worker (fn-643 task .3). keeperd's SEVENTH Bun Worker
 * thread, joining the producer-worker fleet (`plan-worker`, `transcript-worker`,
 * `statusline-worker`, `git-worker`, `exit-watcher`, `server-worker`, `wake-worker`).
 *
 * The hook writes per-pid NDJSON files to `~/.local/state/keeper/dead-letters/`
 * when its `events` INSERT exhausts its retry budget (see fn-643 task .2 in
 * `plugins/keeper/plugin/hooks/events-writer.ts`). This worker makes those files visible as
 * `waiting` rows in the schema-v37 `dead_letters` operational table: it watches
 * the dir with `@parcel/watcher` and posts a contentless
 * `{kind: "dead-letter-changed"}` message to main whenever the tree changes.
 *
 * MAIN owns the actual `dead_letters` write (main is the DB writer, per the
 * "no general write path into the reducer" invariant). On every worker
 * message AND once at boot, main scans the dir + reads each file + parses
 * each line via {@link parseDeadLetterLine} + `INSERT OR IGNORE INTO
 * dead_letters` keyed on `dl_id`. The write is a DIRECT operational-table
 * write — NOT an event fold. The two-step (worker watches, main scans+writes)
 * keeps the DB writer single-threaded; the worker holds only a watcher
 * subscription, no DB handle.
 *
 * This is NOT a fold: the import path does NOT write the `events` log and
 * does NOT touch projections. The board renders `dead_letters` as a warn
 * count; the replay verb (task .4) is the only path that mints a real
 * event from a `dead_letters` row.
 *
 * Worker contract (see CLAUDE.md "Worker contract"):
 * - `isMainThread` guard — a plain import is inert.
 * - No DB connection (the worker doesn't read or write the DB; main does it
 *   all). Skipping `openDb` keeps the worker featherlight and removes one
 *   teardown surface.
 * - Typed message protocol: `{kind:"dead-letter-changed"}` worker→main,
 *   `{type:"shutdown"}` main→worker. Exit 0 clean / 1 crash.
 * - Subsystem-style teardown: the `@parcel/watcher` subscription is an
 *   owned external resource, `unsubscribe()`d in the shutdown handler. A
 *   `terminate()` from main alone would leak the native watch.
 *
 * Why a native file watcher here when keeper's DO-NOT bans `fs.watch` /
 * FSEvents on keeper's OWN DB: same carve-out as `plan-worker` and
 * `transcript-worker`. The dead-letters tree is EXTERNAL — written by the
 * hook plugin process (a different process from keeperd), so the
 * same-process-write blind spot does not apply. Every watch event is "go
 * look" (post a message); main re-scans the dir from scratch each time.
 * A drop / FSEvents overrun (`isDropError`) schedules the same single-flight
 * re-scan via the shared {@link RescanScheduler} primitive — no new
 * recovery path.
 *
 * Missing-dir tolerance: a fresh machine has no `dead-letters/` tree until
 * the hook hits its first drop. The worker tolerates absence at spawn (the
 * `@parcel/watcher` `subscribe` requires the dir to exist, so it
 * skip-and-logs and stays alive for the shutdown handshake — same shape as
 * `transcript-worker`'s missing-root path). Main's boot scan applies the
 * same tolerance via `existsSync`.
 */

import { existsSync } from "node:fs";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { AsyncSubscription } from "@parcel/watcher";
import { isDropError, RescanScheduler } from "./rescan";

/**
 * Data the parent passes via `new Worker(url, { workerData })`. Only path
 * strings cross the boundary — no DB handle, since this worker doesn't open
 * one. The path is the directory the hook writes NDJSON files into.
 */
export interface DeadLetterWorkerData {
  /**
   * Absolute path to the dead-letters dir. The parent resolves this from
   * {@link resolveDeadLetterDir} (`KEEPER_DEAD_LETTER_DIR` env wins;
   * default `~/.local/state/keeper/dead-letters`). Overridable so tests
   * point at hermetic tmp dirs.
   */
  dir: string;
  /**
   * fn-747 watcher seam. When `true`, the worker NEVER `import()`s
   * `@parcel/watcher` — it skips the live FSEvents subscribe and stays alive
   * only for the shutdown handshake. The in-process daemon harness sets this so
   * the parallel slow-test tier never dlopens the NAPI addon in a worker thread.
   * Main's boot scan already imported every `waiting` dead-letter at startup;
   * the live subscribe is a latency hint for new drops, which the in-process
   * tier does not exercise.
   */
  disableNativeWatcher?: boolean;
}

/**
 * Contentless "go look" message — the worker carries no payload because
 * main re-reads the dir from scratch on each notification (the safe-value
 * pattern: treat watcher events as triggers, never as data). One message
 * per watcher callback firing — bursts are absorbed by main's scan being
 * idempotent (`INSERT OR IGNORE` on `dl_id`).
 */
export interface DeadLetterChangedMessage {
  kind: "dead-letter-changed";
}

/** Message the parent sends to ask the worker to stop. */
export interface ShutdownMessage {
  type: "shutdown";
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Worker entrypoint. Subscribes to the dead-letters dir and posts a
 * `{kind:"dead-letter-changed"}` message on every change event (and on
 * recoverable FSEvents drops, via the shared {@link RescanScheduler}).
 * The subscription is the worker's only owned external resource —
 * `unsubscribe()`d in the shutdown handler.
 */
function main(): void {
  if (!parentPort) {
    console.error(
      "[dead-letter-worker] no parentPort — not running as a Worker",
    );
    process.exit(1);
  }

  const data = workerData as DeadLetterWorkerData | undefined;
  if (!data || typeof data.dir !== "string") {
    console.error("[dead-letter-worker] missing dir in workerData");
    process.exit(1);
  }

  const port = parentPort;
  const dir = data.dir;

  let subscription: AsyncSubscription | null = null;
  let shuttingDown = false;

  // Drop-recovery scheduler: a recoverable FSEvents drop schedules a
  // debounced, single-flight notification to main (same idempotent re-scan
  // primitive plan/transcript workers use). The scan body posts a single
  // "go look" message — main does the actual dir walk + INSERT OR IGNORE,
  // so a redundant message is harmless.
  const rescan = new RescanScheduler(() => {
    if (shuttingDown) {
      return;
    }
    port.postMessage({
      kind: "dead-letter-changed",
    } satisfies DeadLetterChangedMessage);
  });

  parentPort.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg && msg.type === "shutdown") {
      shuttingDown = true;
      // Clear any armed re-scan timer FIRST (mirrors plan/transcript-worker
      // teardown order) so a pending drop-recovery notification can't fire
      // after we've started unsubscribing.
      rescan.cancel();
      // Release the watcher subscription (external resource), then exit
      // clean. The worker has no DB handle, so there's nothing to close.
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

  // The dead-letters dir may not exist yet on a fresh machine — the hook
  // only creates it on the first dropped INSERT. `@parcel/watcher`'s
  // `subscribe` REQUIRES an existing dir, so tolerate absence the same way
  // `transcript-worker` does its missing-root path: skip-and-log, stay
  // alive (the parentPort listener keeps the event loop running for the
  // shutdown handshake). Main's boot scan also tolerates absence; a later
  // first-drop creates the dir and a subsequent daemon restart picks up
  // the file.
  if (!existsSync(dir)) {
    console.error(
      `[dead-letter-worker] dead-letters dir ${dir} does not exist; not watching`,
    );
    return;
  }

  // fn-747 watcher seam: skip the native addon dlopen entirely in the
  // in-process tier. Main's boot scan already imported every `waiting`
  // dead-letter; this worker just stays alive (the parentPort listener keeps the
  // event loop running) for the shutdown handshake.
  if (data.disableNativeWatcher) {
    return;
  }

  // `subscribe` is the only unrecoverable surface — a rejection (addon load
  // failure, EPERM on the dir) exits non-zero → daemon fatalExit → launchd
  // restart. Recoverable errors (FSEvents drops, transient read failures)
  // stay swallow-and-log per the producer-worker pattern.
  import("@parcel/watcher")
    .then((watcher) =>
      watcher.subscribe(dir, (err, _events) => {
        if (err) {
          console.error(
            `[dead-letter-worker] watcher error: ${stringifyErr(err)}`,
          );
          if (isDropError(err)) {
            rescan.schedule();
          }
          return;
        }
        // Contentless "go look": main re-scans the whole dir on each
        // notification. We don't filter `_events` here — main's scan is
        // idempotent and re-reads the on-disk state from scratch, so a
        // batched-but-otherwise-empty event list (which @parcel/watcher
        // can deliver under low-rate churn) still triggers the safe
        // re-read.
        port.postMessage({
          kind: "dead-letter-changed",
        } satisfies DeadLetterChangedMessage);
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
        `[dead-letter-worker] failed to subscribe to ${dir}: ${stringifyErr(err)}`,
      );
      process.exit(1);
    });
}

// Only run inside a real Worker; a plain import on the main thread (tests
// driving main's scan path) is inert.
if (!isMainThread) {
  main();
}

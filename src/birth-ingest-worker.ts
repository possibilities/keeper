/**
 * Birth-record ingest watcher worker (fn-1103) — keeperd's watch-hint thread for
 * the non-hook presence channel, the architectural twin of
 * {@link import("./events-ingest-worker")}. Where the events-ingest worker
 * watches the hook's per-pid NDJSON log, this one watches the BIRTHS TREE the
 * `keeper agent` launcher drops a maildir record into whenever it spawns Pi
 * (claude announces itself through its own SessionStart hook, so it never births).
 *
 * The worker subscribes to the births dir with `@parcel/watcher` and posts a
 * contentless `{kind:"birth-records-changed"}` message to main on every change.
 * MAIN owns all writes: on each message (and once at boot) main runs
 * {@link import("./daemon").scanBirthDir}, which parses each record under `new/`,
 * mints ONE synthetic `SessionStart` event carrying every record field
 * (including bounded Dispatch-attempt metadata for capable adapters), and
 * retires the file. The fold turns that
 * into a tracked `jobs` row the exit-watcher / renamer / tmux poller inherit with
 * zero changes.
 *
 * Contentless "go look" (never the data): births are one-record maildir files,
 * so a watcher event is a trigger, never a payload. Main's scan is idempotent —
 * a processed file is retired, and a duplicate mint folds idempotently (a repeat
 * SessionStart is a resume) — so a watcher-event burst or an FSEvents drop
 * converges harmlessly. A recoverable drop (`isDropError`) schedules the same
 * single-flight re-scan primitive the events-ingest / dead-letter workers use.
 *
 * Worker contract (see CLAUDE.md "Worker contract"):
 * - `isMainThread` guard — a plain import is inert.
 * - No DB connection: main does every write. The worker holds only the watcher
 *   subscription (an owned external resource), `unsubscribe()`d on shutdown.
 * - Typed protocol: `{kind:"birth-records-changed"}` worker→main,
 *   `{type:"shutdown"}` main→worker. Exit 0 clean / 1 crash.
 *
 * External-tree carve-out: the births tree is written by the launcher process (a
 * different process from keeperd), so the "no kernel watcher on keeper's OWN DB"
 * ban does not apply — same carve-out as `events-ingest-worker` /
 * `dead-letter-worker`.
 *
 * Missing-dir tolerance: a machine that has never launched Pi
 * has no births tree. `@parcel/watcher`'s `subscribe` requires an existing dir,
 * so the worker skip-and-logs and stays alive for the shutdown handshake — same
 * shape as `events-ingest-worker`. Main mkdirs the tree before spawn AND its
 * boot scan tolerates absence, so the live path is never left dead.
 */

import { existsSync } from "node:fs";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { AsyncSubscription } from "@parcel/watcher";
import { isDropError, RescanScheduler } from "./rescan";

/**
 * Data the parent passes via `new Worker(url, { workerData })`. Only the births
 * dir path crosses the boundary — no DB handle (this worker opens none). Main
 * resolves it from {@link import("./birth-record").resolveBirthDir}
 * (`KEEPER_BIRTH_DIR` env wins; default `~/.local/state/keeper/births`), so
 * tests point it at a hermetic tmp dir.
 */
export interface BirthIngestWorkerData {
  /** Absolute path to the births ROOT dir (the maildir `new/` lives under it). */
  dir: string;
  /**
   * Watcher seam, mirrored verbatim from `events-ingest-worker`. When `true`,
   * the worker NEVER `import()`s `@parcel/watcher` — it skips the live FSEvents
   * subscribe and stays alive only for the shutdown handshake. The in-process
   * daemon harness sets this so the parallel slow-test tier never dlopens the
   * NAPI addon in a worker thread (the SIGTRAP source). Correctness holds: main's
   * own birth fallback poll re-scans the tree every interval, so the watcher
   * subscribe is a latency hint, not the data path.
   */
  disableNativeWatcher?: boolean;
}

/**
 * Contentless "go look" message — no payload because main re-reads the births
 * `new/` dir from scratch on each notification (the safe-value pattern: treat
 * watcher events as triggers, never as data). Main's scan is idempotent, so a
 * burst converges harmlessly.
 */
export interface BirthRecordsChangedMessage {
  kind: "birth-records-changed";
}

/** Message the parent sends to ask the worker to stop. */
export interface ShutdownMessage {
  type: "shutdown";
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Worker entrypoint. Subscribes to the births dir and posts a
 * `{kind:"birth-records-changed"}` message on every change event (and on
 * recoverable FSEvents drops, via the shared {@link RescanScheduler}). The
 * subscription is the worker's only owned external resource — `unsubscribe()`d
 * in the shutdown handler.
 */
function main(): void {
  if (!parentPort) {
    console.error(
      "[birth-ingest-worker] no parentPort — not running as a Worker",
    );
    process.exit(1);
  }

  const data = workerData as BirthIngestWorkerData | undefined;
  if (!data || typeof data.dir !== "string") {
    console.error("[birth-ingest-worker] missing dir in workerData");
    process.exit(1);
  }

  const port = parentPort;
  const dir = data.dir;

  let subscription: AsyncSubscription | null = null;
  let shuttingDown = false;

  // Drop-recovery scheduler: a recoverable FSEvents drop schedules a debounced,
  // single-flight "go look" (the same idempotent re-scan primitive the
  // events-ingest / dead-letter workers use). Main does the actual per-file
  // parse + mint + retire, so a redundant message is harmless.
  const rescan = new RescanScheduler(() => {
    if (shuttingDown) {
      return;
    }
    port.postMessage({
      kind: "birth-records-changed",
    } satisfies BirthRecordsChangedMessage);
  });

  parentPort.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg && msg.type === "shutdown") {
      shuttingDown = true;
      // Clear any armed re-scan timer FIRST (mirrors the events-ingest teardown
      // order) so a pending drop-recovery notification can't fire after we've
      // started unsubscribing.
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

  // The births tree may not exist until the first Pi launch. Tolerate
  // absence the same way `events-ingest-worker` does: skip-and-log, stay alive
  // (the parentPort listener keeps the event loop running for the shutdown
  // handshake). Main mkdirs the tree before spawn, so a normal boot finds it;
  // this guard covers a bespoke selector boot that skipped the mkdir.
  if (!existsSync(dir)) {
    console.error(
      `[birth-ingest-worker] births dir ${dir} does not exist; not watching`,
    );
    return;
  }

  // Watcher seam: skip the native addon dlopen entirely in the in-process tier.
  // Main's birth fallback poll still processes every record, so this worker just
  // stays alive (the parentPort listener keeps the event loop running) for the
  // shutdown handshake.
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
            `[birth-ingest-worker] watcher error: ${stringifyErr(err)}`,
          );
          if (isDropError(err)) {
            rescan.schedule();
          }
          return;
        }
        // Contentless "go look": main re-reads the whole `new/` dir on each
        // notification. We don't filter `_events` — a maildir move-in, a `tmp/`
        // stage, or a batched-but-empty event list all trigger the same safe
        // re-scan (idempotent by construction).
        port.postMessage({
          kind: "birth-records-changed",
        } satisfies BirthRecordsChangedMessage);
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
        `[birth-ingest-worker] failed to subscribe to ${dir}: ${stringifyErr(err)}`,
      );
      process.exit(1);
    });
}

// Only run inside a real Worker; a plain import on the main thread (tests
// driving main's scan path) is inert.
if (!isMainThread) {
  main();
}

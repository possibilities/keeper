/**
 * Zellij-events watcher worker (fn-684 task .3). keeperd's eighth
 * Bun Worker thread (and the EIGHTH `@parcel/watcher` producer
 * instance), joining the fleet `plan-worker`, `transcript-worker`,
 * `usage-worker`, `git-worker`, `exit-watcher`, `server-worker`,
 * `wake-worker`, `dead-letter-worker`, `autopilot-worker`,
 * `restore-worker`, `tab-namer-worker` (twelve workers total since
 * fn-684 task .5 retired the `backend-worker` poller).
 *
 * The zellij bridge plugin (fn-684 task .1) appends one NDJSON line per
 * pane delta to its `/host/<session>.ndjson` (WASI sandbox; `/host` is
 * pinned to keeper's events dir by the dotfiles `load_plugins { cwd "..." }`
 * block). This worker watches that dir with `@parcel/watcher` and posts a
 * contentless `{kind: "zellij-events-changed"}` message to main whenever
 * the tree changes — the same "go look" pattern the `dead-letter-worker`
 * uses against its NDJSON dir.
 *
 * MAIN owns the actual scan + event mint (main is the DB writer per the
 * "sole-writer rules" in CLAUDE.md). On every worker message AND once at
 * boot, main runs `scanZellijEventsDir` (defined in `src/daemon.ts`),
 * which reads each `<session>.ndjson` from its persisted byte-offset
 * watermark, parses each new line via `parseZellijEventLine`, joins
 * `(session, pane_id) -> job_id` via the EXISTING `readLiveJobsWithCoords`,
 * and mints one EXISTING `BackendExecSnapshot` synthetic event per
 * resolved pane through `stmts.insertEvent` verbatim — NO schema change
 * and NO reducer change. The two-step (worker watches, main scans+mints)
 * keeps the DB writer single-threaded; the worker holds only a watcher
 * subscription, no DB handle.
 *
 * Always-on as of fn-684 task .5. The legacy `backend-worker` poller
 * (`zellij action list-panes -a -j` per tick) is retired and removed;
 * this worker + main-side `scanZellijEventsDir` is now the sole
 * producer of `jobs.backend_exec_tab_{id,name}`. Rollback path: a
 * single `git revert` of the fn-684 task .5 commit restores the
 * poller + its env-gated dual-feed coexistence. The reducer's fold
 * remains idempotent on matching `(tab_id, tab_name)` writes (LWW by
 * `last_event_id`, monotone via SQLite AUTOINCREMENT) so a
 * re-introduction of the poller during a revert window is safe.
 *
 * Worker contract (see CLAUDE.md "Worker contract"):
 * - `isMainThread` guard — a plain import is inert (tests driving
 *   main's scan path import `scanZellijEventsDir` directly and never
 *   spawn this worker).
 * - No DB connection — the worker doesn't read or write the DB; main
 *   does it all. Skipping `openDb` keeps the worker featherlight and
 *   removes one teardown surface.
 * - Typed message protocol: `{kind:"zellij-events-changed"}` worker→main,
 *   `{type:"shutdown"}` main→worker. Exit 0 clean / 1 crash.
 * - Subsystem-style teardown: the `@parcel/watcher` subscription is an
 *   owned external resource, `unsubscribe()`d in the shutdown handler.
 *   A `terminate()` from main alone would leak the native watch.
 *
 * Why a native file watcher here when keeper's DO-NOT bans `fs.watch` /
 * FSEvents on keeper's OWN DB: same carve-out as `plan-worker`,
 * `transcript-worker`, and `dead-letter-worker`. The events dir is
 * EXTERNAL — written by the zellij plugin process (a different process
 * from keeperd), so the same-process-write blind spot does not apply.
 * Every watch event is "go look" (post a message); main re-scans each
 * `<session>.ndjson` from its persisted watermark. A drop / FSEvents
 * overrun (`isDropError`) schedules the same single-flight re-scan via
 * the shared {@link RescanScheduler} primitive — no new recovery path.
 *
 * Missing-dir tolerance: a fresh machine may not have the events dir
 * until task .4's boot `mkdir` lands (or the dotfiles wiring loads the
 * plugin in any session for the first time). The worker tolerates
 * absence at spawn (`@parcel/watcher`'s `subscribe` requires the dir
 * to exist, so it skip-and-logs and stays alive for the shutdown
 * handshake — same shape as `dead-letter-worker`'s missing-dir path).
 * Main's boot scan applies the same tolerance via `existsSync`.
 */

import { existsSync } from "node:fs";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { AsyncSubscription } from "@parcel/watcher";
import { isDropError, RescanScheduler } from "./rescan";

/**
 * Data the parent passes via `new Worker(url, { workerData })`. Only the
 * path string crosses the boundary — no DB handle, since this worker
 * doesn't open one. The path is the directory the zellij plugin writes
 * `<session>.ndjson` files into (= the plugin's `/host` mount).
 */
export interface ZellijEventsWorkerData {
  /**
   * Absolute path to the zellij events dir. The parent resolves this
   * from `resolveZellijEventsDir()` (`KEEPER_ZELLIJ_EVENTS_DIR` env
   * wins; default `~/.local/state/keeper/zellij-events`). Overridable
   * so tests point at hermetic tmp dirs.
   */
  dir: string;
}

/**
 * Contentless "go look" message — the worker carries no payload because
 * main re-reads the dir from scratch on each notification (the safe-value
 * pattern: treat watcher events as triggers, never as data). One message
 * per watcher callback firing — bursts are absorbed by main's scan being
 * idempotent (each `<session>.ndjson` is re-tailed from its persisted
 * byte offset; a no-new-lines re-scan emits nothing).
 */
export interface ZellijEventsChangedMessage {
  kind: "zellij-events-changed";
}

/** Message the parent sends to ask the worker to stop. */
export interface ShutdownMessage {
  type: "shutdown";
}

// Env-gated tracing (epic fn-704 task .2). Mirrors the `KEEPER_TRACE_SERVER`
// convention in `server-worker.ts`: read the flag ONCE at module load into a
// `const`, gate AT THE CALL SITE so the increment never allocates when off,
// and trace to `console.error` in an awk-parseable shape on a rolling window.
// This worker side counts notification-posts/sec = the RAW input pressure from
// the bridge's write volume (a high rate here with a LOW mint rate at main's
// `scanZellijEventsDir` means the feed is noisy-but-harmless; a high rate that
// tracks the mint rate is the loop driver). The worker has NO DB handle by
// design (sole-writer rule), so the actual `data_version`-bumping mint is only
// observable at main's `scanZellijEventsDir` (gated by `KEEPER_TRACE_ZELLIJ`
// there too) — the RATIO of the two is the loop diagnosis.
const TRACE_ZELLIJ = process.env.KEEPER_TRACE_ZELLIJ === "1";

/** Rolling trace window (ms). A counter flushes one rate line per window. */
const TRACE_WINDOW_MS = 10_000;

/**
 * Allocation-free rolling-window event counter for env-gated tracing. Mirrors
 * the helper in `tab-namer-worker.ts` / `daemon.ts`. The caller MUST gate the
 * `tick()` call behind its module-level `const` flag. Exception-free (integer
 * arithmetic + a `console.error` on a plain string), so it is safe in the
 * notification-post path which must never throw.
 */
class TraceCounter {
  private count = 0;
  private windowStart = 0;
  constructor(private readonly tag: string) {}
  tick(now: number): void {
    if (this.windowStart === 0) this.windowStart = now;
    this.count++;
    if (now - this.windowStart >= TRACE_WINDOW_MS) {
      console.error(
        `[${this.tag}] T=${now} count=${this.count} window_ms=${now - this.windowStart}`,
      );
      this.count = 0;
      this.windowStart = now;
    }
  }
}

// Module-scope counter so the running total survives across watcher
// notifications and drop-recovery re-scans. Inert when `TRACE_ZELLIJ` is off
// (never `tick()`ed).
const traceNotifications = new TraceCounter("trace-zellij-notifications");

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Worker entrypoint. Subscribes to the events dir and posts a
 * `{kind:"zellij-events-changed"}` message on every change event (and
 * on recoverable FSEvents drops, via the shared {@link RescanScheduler}).
 * The subscription is the worker's only owned external resource —
 * `unsubscribe()`d in the shutdown handler.
 */
function main(): void {
  if (!parentPort) {
    console.error(
      "[zellij-events-worker] no parentPort — not running as a Worker",
    );
    process.exit(1);
  }

  const data = workerData as ZellijEventsWorkerData | undefined;
  if (!data || typeof data.dir !== "string") {
    console.error("[zellij-events-worker] missing dir in workerData");
    process.exit(1);
  }

  const port = parentPort;
  const dir = data.dir;

  let subscription: AsyncSubscription | null = null;
  let shuttingDown = false;

  // Drop-recovery scheduler: a recoverable FSEvents drop schedules a
  // debounced, single-flight notification to main (same idempotent
  // re-scan primitive plan/transcript/dead-letter workers use). The scan
  // body posts a single "go look" message — main does the actual dir
  // walk + tail-from-watermark, so a redundant message is harmless.
  const rescan = new RescanScheduler(() => {
    if (shuttingDown) {
      return;
    }
    // fn-704.2 trace: drop-recovery re-scan notification. Call-site gated.
    if (TRACE_ZELLIJ) traceNotifications.tick(Date.now());
    port.postMessage({
      kind: "zellij-events-changed",
    } satisfies ZellijEventsChangedMessage);
  });

  parentPort.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg && msg.type === "shutdown") {
      shuttingDown = true;
      // Clear any armed re-scan timer FIRST (mirrors plan/transcript/
      // dead-letter-worker teardown order) so a pending drop-recovery
      // notification can't fire after we've started unsubscribing.
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

  // The events dir may not exist yet on a fresh machine — task .4's
  // daemon boot `mkdir -p` covers daemon starts, but the dir is also
  // created lazily by the plugin's first append. `@parcel/watcher`'s
  // `subscribe` REQUIRES an existing dir, so tolerate absence the same
  // way `dead-letter-worker` does its missing-dir path: skip-and-log,
  // stay alive (the parentPort listener keeps the event loop running
  // for the shutdown handshake). Main's boot scan also tolerates
  // absence; a later first-write creates the dir and a subsequent
  // daemon restart picks up the file.
  if (!existsSync(dir)) {
    console.error(
      `[zellij-events-worker] events dir ${dir} does not exist; not watching`,
    );
    return;
  }

  // `subscribe` is the only unrecoverable surface — a rejection (addon
  // load failure, EPERM on the dir) exits non-zero → daemon fatalExit →
  // launchd restart. Recoverable errors (FSEvents drops, transient read
  // failures) stay swallow-and-log per the producer-worker pattern.
  import("@parcel/watcher")
    .then((watcher) =>
      watcher.subscribe(dir, (err, _events) => {
        if (err) {
          console.error(
            `[zellij-events-worker] watcher error: ${stringifyErr(err)}`,
          );
          if (isDropError(err)) {
            rescan.schedule();
          }
          return;
        }
        // Contentless "go look": main re-scans the whole dir on each
        // notification. We don't filter `_events` here — main's scan
        // is idempotent (per-file byte-offset watermark), so a
        // batched-but-otherwise-empty event list (which
        // @parcel/watcher can deliver under low-rate churn) still
        // triggers the safe re-read.
        // fn-704.2 trace: raw watcher notification = bridge write pressure.
        // Call-site gated so the counter is inert when the flag is off.
        if (TRACE_ZELLIJ) traceNotifications.tick(Date.now());
        port.postMessage({
          kind: "zellij-events-changed",
        } satisfies ZellijEventsChangedMessage);
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
        `[zellij-events-worker] failed to subscribe to ${dir}: ${stringifyErr(err)}`,
      );
      process.exit(1);
    });
}

// Only run inside a real Worker; a plain import on the main thread
// (tests driving main's scan path) is inert.
if (!isMainThread) {
  main();
}

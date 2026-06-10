/**
 * Maintenance worker (fn-765 task .1). Hosts keeperd's heavy SQLite maintenance
 * schedules OFF main's fold thread.
 *
 * ## Why this worker exists
 *
 * bun:sqlite calls are SYNCHRONOUS. The daily verified backup (`VACUUM INTO` on a
 * ~2 GB DB — a multi-second copy) and the 15-min integrity probe
 * (`PRAGMA quick_check` — a bounded structural sweep) both run synchronous
 * bun:sqlite work; when hosted on main's `setInterval` they STALL the event loop
 * for their full duration, blocking folds and the events-log ingest and feeding
 * the fold-lag class the 2026-06-09 review exists to kill. Each op already opens
 * its OWN short-lived read-only connection (backup: `backupDb`/`backupDb`'s
 * `VACUUM INTO` source conn, src/backup.ts; probe: `liveQuickCheck`,
 * src/integrity-probe.ts), so moving them to a dedicated thread is purely a
 * "stop blocking main's event loop" move — the connection ownership and
 * read-only-never-takes-the-writer-lock posture are unchanged. The point of the
 * move is exactly that bun:sqlite is synchronous and blocks main's loop
 * regardless of which connection it uses.
 *
 * Three schedules, all relocated here from main (daemon.ts):
 * - (a) the 24h verified backup interval (`runBackupPass` → `backupDb(dbPath)`),
 * - (b) the fn-753 boot-time catch-up one-shot (`isCatchUpDue` ⇒ a delayed
 *       single backup pass), evaluated once on worker start,
 * - (c) the 15-min integrity-probe interval (`runIntegrityProbe`).
 *
 * ## Side effects stay main-side (the relay)
 *
 * Logging + the botctl/Telegram page on a backup FAILURE or a probe corruption
 * verdict stay on MAIN, driven by a relayed outcome — the worker carries no
 * botctl spawn, no `console.error` for those paths. The worker posts:
 * - `{kind:"backup-result", result}` after every backup pass — main runs the
 *   identical success-log / failure-log+page branch it ran inline before.
 * - `{kind:"maintenance-log", message}` and `{kind:"maintenance-page", message}`
 *   for the integrity probe, by handing `runIntegrityProbe` a deps object whose
 *   `log` / `page` post these messages up. `runIntegrityProbe`'s decision and
 *   corruption-throw classification are UNCHANGED and run worker-side (only the
 *   blocking `quickCheck` it drives is what we moved off main); its side effects
 *   route through main so the existing logging/alarm behavior is byte-identical.
 *
 * ## Producer-side, never a fold
 *
 * Like the timers it replaces, NOTHING here reads a projection, writes the DB,
 * mints a synthetic event, or runs inside the reducer's `BEGIN IMMEDIATE` — so
 * re-fold determinism and the sole-writer rules are untouched. The backup writes
 * only a sidecar snapshot file under the state dir; the probe writes nothing.
 * Compaction (a WRITER op — `VACUUM INTO` is read-only, but compaction relocates
 * blobs via the writer connection) deliberately STAYS on main, governed by the
 * sole-writer rule.
 *
 * ## Worker contract (CLAUDE.md "Worker contract")
 *
 * - `isMainThread` guard — a plain import (tests driving the relay/pass bodies
 *   directly) is inert.
 * - Owns NO DB handle of its own across calls — each `backupDb` / `liveQuickCheck`
 *   opens and closes its own short-lived read-only connection internally, the
 *   same as when they ran on main. So there is no long-lived connection for the
 *   shutdown handler to close; teardown just clears the timers and exits clean.
 * - Typed messages: `{kind:"backup-result"|"maintenance-log"|"maintenance-page"}`
 *   worker→main, `{type:"shutdown"}` main→worker. Exit 0 clean / 1 crash.
 * - Supervisor-owned lifecycle: main spawns it after migrate+boot-drain and is
 *   the sole terminator; on `onerror`/`close` main `fatalExit`s (LaunchAgent
 *   restart — never an in-process respawn).
 *
 * The pass bodies (`runBackupPass`, `runProbePass`) are exported so the test
 * suite drives the relay shape directly without spawning a real Worker.
 */

import { isMainThread, parentPort, workerData } from "node:worker_threads";
import {
  BACKUP_CATCHUP_DELAY_MS,
  BACKUP_INTERVAL_MS,
  type BackupResult,
  backupDb,
  isCatchUpDue,
  resolveBackupDir,
} from "./backup";
import {
  INTEGRITY_PROBE_INTERVAL_MS,
  type IntegrityProbeDeps,
  liveQuickCheck,
  runIntegrityProbe,
} from "./integrity-probe";

/**
 * Data the parent passes via `new Worker(url, { workerData })`. Only the DB path
 * string crosses the boundary — every connection the worker uses is opened
 * (read-only) and closed internally by `backupDb` / `liveQuickCheck` from this
 * path, since a Database handle cannot cross the Worker boundary.
 */
export interface MaintenanceWorkerData {
  dbPath: string;
}

/** Worker→main: outcome of a single backup pass. Main logs + pages on failure. */
export interface BackupResultMessage {
  kind: "backup-result";
  result: BackupResult;
}

/** Worker→main: a line for main to `console.error` (the probe's log sink). */
export interface MaintenanceLogMessage {
  kind: "maintenance-log";
  message: string;
}

/** Worker→main: a botctl/Telegram page request (the probe's page sink). */
export interface MaintenancePageMessage {
  kind: "maintenance-page";
  message: string;
}

/** Union of every worker→main message this worker posts. */
export type MaintenanceMessage =
  | BackupResultMessage
  | MaintenanceLogMessage
  | MaintenancePageMessage;

/** Message the parent sends to ask the worker to stop. */
export interface ShutdownMessage {
  type: "shutdown";
}

/**
 * Run one backup pass and relay the `BackupResult` to main. Mirrors the
 * never-throws + shuttingDown-guard shape of the timer body it replaces: a
 * backup is pure recovery-floor maintenance (it reads the source via its own RO
 * connection + writes a sidecar snapshot file), so any throw is logged-then-
 * retried, never fatal. The relay carries the verified/path/error fields so main
 * runs its existing success-log / failure-log+page branch.
 *
 * Exported so tests drive the relay shape directly without a real Worker.
 */
export function runBackupPass(
  dbPath: string,
  post: (msg: MaintenanceMessage) => void,
  isShuttingDown: () => boolean,
): void {
  if (isShuttingDown()) return;
  let result: BackupResult;
  try {
    result = backupDb(dbPath);
  } catch (err) {
    // A backup throw is non-fatal: synthesize a failure result so main's
    // existing failure-log+page branch fires, then return. The next interval
    // retries.
    result = {
      snapshotPath: null,
      verified: false,
      bytes: 0,
      pruned: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
  post({ kind: "backup-result", result });
}

/**
 * Run one integrity probe and relay its side effects to main.
 * `runIntegrityProbe` keeps its decision + corruption-throw classification
 * UNCHANGED — only its `log` / `page` sinks are redirected here to post
 * `maintenance-log` / `maintenance-page` messages up, so main keeps the exact
 * logging/alarm behavior. The blocking `quickCheck` (the synchronous bun:sqlite
 * `PRAGMA quick_check` we moved off main) runs worker-side via
 * `liveQuickCheck(dbPath)`. Never-throws: `runIntegrityProbe` degrades
 * internally, so this body is already non-throwing.
 *
 * Exported so tests drive the relay shape directly without a real Worker.
 */
export function runProbePass(
  dbPath: string,
  post: (msg: MaintenanceMessage) => void,
  isShuttingDown: () => boolean,
): void {
  if (isShuttingDown()) return;
  const deps: IntegrityProbeDeps = {
    quickCheck: liveQuickCheck(dbPath),
    log: (message) => post({ kind: "maintenance-log", message }),
    page: (message) => post({ kind: "maintenance-page", message }),
  };
  runIntegrityProbe(deps);
}

/**
 * Worker entrypoint. Wires the shutdown message, schedules the backup +
 * integrity-probe intervals, evaluates the fn-753 boot catch-up one-shot once on
 * start, and posts pass outcomes to main. Owns no long-lived resource beyond the
 * timers, which the shutdown handler clears before exiting clean.
 */
function main(): void {
  if (!parentPort) {
    console.error(
      "[maintenance-worker] no parentPort — not running as a Worker",
    );
    process.exit(1);
  }

  const data = workerData as MaintenanceWorkerData | undefined;
  if (!data || typeof data.dbPath !== "string") {
    // Without a path we cannot open the maintenance connections. Exit non-zero so
    // the parent's single recovery path (fatalExit → LaunchAgent restart) engages.
    console.error("[maintenance-worker] missing dbPath in workerData");
    process.exit(1);
  }

  const port = parentPort;
  const dbPath = data.dbPath;
  let shuttingDown = false;
  const post = (msg: MaintenanceMessage): void => port.postMessage(msg);
  const isShuttingDown = (): boolean => shuttingDown;

  // The 24h verified backup interval (relocated from daemon.ts:runBackupPass).
  const backupTimer = setInterval(() => {
    runBackupPass(dbPath, post, isShuttingDown);
  }, BACKUP_INTERVAL_MS);

  // The 15-min integrity probe interval (relocated from daemon.ts).
  const probeTimer = setInterval(() => {
    runProbePass(dbPath, post, isShuttingDown);
  }, INTEGRITY_PROBE_INTERVAL_MS);

  // fn-753 boot-time catch-up: the regular interval resets on every daemon boot,
  // so a keeperd that restarts more often than BACKUP_INTERVAL_MS would never
  // reach its first fire. If the newest snapshot is overdue (or none exists),
  // schedule a one-shot that runs the SAME backup pass after a short startup
  // delay. Evaluated once on worker start. A fresh snapshot ⇒ no timer scheduled.
  let backupCatchUpTimer: ReturnType<typeof setTimeout> | null = null;
  if (isCatchUpDue(resolveBackupDir(dbPath), Date.now())) {
    backupCatchUpTimer = setTimeout(() => {
      backupCatchUpTimer = null;
      runBackupPass(dbPath, post, isShuttingDown);
    }, BACKUP_CATCHUP_DELAY_MS);
  }

  parentPort.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg && msg.type === "shutdown") {
      shuttingDown = true;
      // Clear the timers FIRST so an interval/one-shot can't fire a heavy backup
      // or probe after we've begun teardown (an outstanding timer also pins a ref
      // on the worker's event loop). Each maintenance op opens + closes its own
      // short-lived RO connection internally, so there is no long-lived handle to
      // close here.
      clearInterval(backupTimer);
      clearInterval(probeTimer);
      if (backupCatchUpTimer !== null) {
        clearTimeout(backupCatchUpTimer);
        backupCatchUpTimer = null;
      }
      process.exit(0);
    }
  });
}

// Only run inside a real Worker; a plain import on the main thread (tests driving
// the pass bodies / relay shape) is inert.
if (!isMainThread) {
  main();
}

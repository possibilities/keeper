/**
 * Backend-exec tab-resolver producer worker (fn-668 / schema v48). Resolves
 * the zellij tab a live job's `(backend_exec_session_id, backend_exec_pane_id)`
 * lives in by running `zellij --session <session> action list-panes -a -j`
 * once per distinct session and filtering by pane id, then posts one
 * `BackendExecSnapshot` message per resolved pane. Main lifts each message
 * into a synthetic `BackendExecSnapshot` event whose reducer fold updates
 * `jobs.backend_exec_tab_{id,name}` (last-known sticks — no clobbering on
 * a vanished pane).
 *
 * INTERVAL-DRIVEN: a `setInterval` tick reads live jobs (those with
 * non-NULL `backend_exec_session_id` AND `backend_exec_pane_id` AND state
 * NOT IN ended-resting-states), dedups by distinct (session, pane), and
 * resolves each (session, pane) via `resolveTabForPane`. Per session,
 * the resolves run SERIALLY — one `list-panes` in flight against any
 * given session at a time, satisfying the epic spec's "one list-panes
 * per distinct session" guarantee; distinct sessions resolve in parallel.
 *
 * The per-tick `isRunning` guard absorbs interval re-entry under slow
 * `list-panes`; the per-session in-flight Map persists across ticks so a
 * slow resolve from tick N suppresses re-spawn against the same session
 * on tick N+1. Non-zero exit / ENOENT / parse failure → log + skip
 * (NEVER post a clobbering snapshot — tab tombstone is "last-known
 * sticks").
 *
 * PRODUCER ONLY: opens `openDb(readonly: true)` to enumerate live jobs;
 * the worker NEVER writes the DB. Main is the sole writer of the
 * synthetic `BackendExecSnapshot` event (CLAUDE.md "Sole-writer rules").
 * A direct DB write here would violate the invariant and break re-fold.
 *
 * Re-fold determinism: the worker's output is a message, not a write —
 * main's synthetic-event mint stamps the snapshot into the immutable
 * event log, so a cursor=0 re-fold over the persisted events reproduces
 * byte-identical `jobs.backend_exec_tab_*` rows. The fold reads only
 * `event.data` (the frozen tab payload) — never re-runs `list-panes`.
 *
 * Shutdown: a `{type:"shutdown"}` message clears the tick interval,
 * sets the `shuttingDown` flag (any in-flight resolve still completes
 * but its post is suppressed and the message-emit gate refuses to fire),
 * closes the read-only DB connection, and `process.exit(0)`s after a
 * `setImmediate` yield to let in-flight ticks drain.
 */

import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { openDb } from "./db";
import { resolveTabForPane } from "./exec-backend";
import type { ShutdownMessage } from "./wake-worker";

/**
 * workerData payload — same shape as the other producer workers
 * (`GitWorkerData`, `UsageWorkerData`): only the absolute DB path is
 * required; the worker opens its own read-only connection. `tickMs` is
 * optional (defaults to 5000) — exposed for tests that need a tight
 * cadence without sleeping.
 */
export interface BackendWorkerData {
  dbPath: string;
  tickMs?: number;
}

/**
 * Default tick cadence. A pane rename via `zellij action rename-tab` is
 * the slowest signal we care about; 5s is fast enough for the human
 * eyeballing `keeper jobs` to see the rename land within one breath,
 * slow enough that a hundred-job repo doesn't spam `list-panes` faster
 * than zellij can answer. The interval is event-loop pacing, not
 * exactly-once — a slow `list-panes` triggers the per-tick `isRunning`
 * guard, NOT overlapping spawns.
 */
const DEFAULT_TICK_MS = 5_000;

/**
 * Wire message — one per resolved pane per tick. The reducer's
 * `BackendExecSnapshot` fold arm reads the embedded payload (`tab_id`,
 * `tab_name`) and UPDATEs `jobs.backend_exec_tab_*` keyed by `job_id`.
 *
 * `tab_id` is a string here (TEXT in the schema) so the wire format
 * matches the column type — the resolver returns `number | null` and
 * we coerce at the message boundary. NULL `tab_id` is allowed (the
 * pane exists in `list-panes` output but the record didn't carry a
 * `tab_id` field — the reducer's fold preserves the prior value via
 * COALESCE rather than clobbering).
 */
export interface BackendExecSnapshotMessage {
  kind: "backend-exec-snapshot";
  job_id: string;
  tab_id: string | null;
  tab_name: string;
}

export type BackendWorkerMessage = BackendExecSnapshotMessage;

/** Row shape read from `jobs` on each tick. */
interface LiveJobRow {
  job_id: string;
  backend_exec_session_id: string;
  backend_exec_pane_id: string;
}

/**
 * Read every live job carrying both a session and a pane id. "Live" =
 * `state NOT IN ('ended', 'killed')` — the same resting-state predicate
 * the rest of the projection uses to decide whether a job's coordinates
 * are still meaningful. An ended job's pane is presumed gone, so we
 * don't waste a `list-panes` spawn on it; the prior `backend_exec_tab_*`
 * value sticks (last-known semantics).
 *
 * Exported for test reach so the per-tick logic can be exercised against
 * a known fixture without spawning the worker.
 */
export function readLiveJobsWithCoords(
  db: import("bun:sqlite").Database,
): LiveJobRow[] {
  return db
    .query(
      `SELECT job_id, backend_exec_session_id, backend_exec_pane_id
         FROM jobs
        WHERE backend_exec_session_id IS NOT NULL
          AND backend_exec_pane_id IS NOT NULL
          AND state NOT IN ('ended', 'killed')`,
    )
    .all() as LiveJobRow[];
}

/**
 * Per-tick driver. Pure w.r.t. the DB (read-only); side effect is the
 * `postMessage` call for each successful resolve. The per-session
 * in-flight `Set` is passed in (lives across ticks in the worker's
 * `main` closure) so a slow `list-panes` from tick N doesn't double-
 * spawn against the same session on tick N+1.
 *
 * Per session, pane buckets resolve SERIALLY — at most one
 * `list-panes` in flight against any given session at any time. Distinct
 * sessions resolve in parallel. The serial walk per session is the
 * source of the "one list-panes per distinct session" guarantee even
 * when N panes in the same session are pending — the next pane waits
 * for the previous resolve to settle.
 *
 * Returns when every per-pane resolve has settled (success → post,
 * failure → skip). Exceptions inside the resolve are caught and logged
 * per-pane so one bad pane can't poison the rest of the session's walk.
 *
 * Exported for tests: a fake `resolveTab` (typed identically to
 * `resolveTabForPane`) lets the test drive the dedup + skip behavior
 * without spawning processes.
 */
export interface TickDeps {
  /** Read-only DB connection. */
  readonly db: import("bun:sqlite").Database;
  /** Per-session in-flight lock — shared across ticks. */
  readonly inFlight: Set<string>;
  /** Resolver injection point. Defaults to `resolveTabForPane`. */
  readonly resolveTab?: typeof resolveTabForPane;
  /** Message sink. Production posts to `parentPort`; tests capture. */
  readonly post: (msg: BackendWorkerMessage) => void;
  /** Shutdown predicate — gates the post AFTER an await so a late
   *  resolve from before shutdown can't slip a message in post-close. */
  readonly isShuttingDown: () => boolean;
}

export async function runTick(deps: TickDeps): Promise<void> {
  const { db, inFlight, post, isShuttingDown } = deps;
  const resolveTab = deps.resolveTab ?? resolveTabForPane;
  const rows = readLiveJobsWithCoords(db);
  if (rows.length === 0) return;

  // Bucket jobs by (session, pane). Multiple jobs sharing the same
  // (session, pane) get one resolve and one snapshot per job — the
  // reducer fold's UPDATE key is `job_id`, so each row catches the
  // tab update independently.
  const paneBuckets = new Map<
    string,
    { session: string; pane: string; jobs: string[] }
  >();
  for (const row of rows) {
    const key = `${row.backend_exec_session_id} ${row.backend_exec_pane_id}`;
    let bucket = paneBuckets.get(key);
    if (bucket == null) {
      bucket = {
        session: row.backend_exec_session_id,
        pane: row.backend_exec_pane_id,
        jobs: [],
      };
      paneBuckets.set(key, bucket);
    }
    bucket.jobs.push(row.job_id);
  }

  // Group pane buckets by session. Distinct sessions resolve in
  // parallel (one `list-panes` spawn per session in flight at a time);
  // multiple panes WITHIN one session resolve SERIALLY so we never
  // have two concurrent `zellij list-panes` against the same session
  // — the epic spec's "one list-panes per distinct session" rule.
  // The `inFlight` Set tracks which sessions are currently being
  // queried (across ticks) so a slow resolve from tick N suppresses
  // re-spawn against the same session on tick N+1.
  const sessionGroups = new Map<
    string,
    Array<{ session: string; pane: string; jobs: string[] }>
  >();
  for (const bucket of paneBuckets.values()) {
    let group = sessionGroups.get(bucket.session);
    if (group == null) {
      group = [];
      sessionGroups.set(bucket.session, group);
    }
    group.push(bucket);
  }

  await Promise.all(
    [...sessionGroups.entries()].map(async ([session, buckets]) => {
      if (inFlight.has(session)) {
        // Another tick is already querying this session — skip the
        // entire group; the next tick will catch up.
        return;
      }
      inFlight.add(session);
      try {
        // Serial walk over the panes in this session — at most one
        // `list-panes` in flight against this session at any moment.
        for (const bucket of buckets) {
          if (isShuttingDown()) return;
          let resolved: {
            tab_id: number | null;
            tab_name: string;
            tab_position: number | null;
          } | null;
          try {
            resolved = await resolveTab(bucket.session, bucket.pane);
          } catch (err) {
            // `resolveTabForPane` is designed to swallow spawn / parse
            // errors internally and return null — but defense-in-depth
            // here keeps a rogue throw (e.g. an injected resolver in a
            // test, a future code path that surfaces an error) from
            // wedging the walk. Log + continue; the next pane in this
            // session's group still gets a chance.
            console.error(
              `[backend-worker] resolveTabForPane threw for session=${bucket.session} pane=${bucket.pane}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            continue;
          }
          if (resolved == null) {
            // No clobbering snapshot — last-known sticks (epic-spec
            // tombstone semantics). The session might have died, the
            // pane might be gone, zellij might not be installed — all
            // expected outcomes during a session shutdown.
            continue;
          }
          if (isShuttingDown()) return;
          // One snapshot per job_id sharing this (session, pane). The
          // reducer fold's UPDATE key is `job_id`, so we post once per
          // job rather than once per pane.
          const tabIdStr =
            resolved.tab_id != null ? String(resolved.tab_id) : null;
          for (const jobId of bucket.jobs) {
            post({
              kind: "backend-exec-snapshot",
              job_id: jobId,
              tab_id: tabIdStr,
              tab_name: resolved.tab_name,
            });
          }
        }
      } finally {
        inFlight.delete(session);
      }
    }),
  );
}

function main(): void {
  if (parentPort == null) {
    console.error("[backend-worker] no parentPort — not running as a Worker");
    process.exit(1);
  }
  const data = workerData as BackendWorkerData | undefined;
  if (data == null || typeof data.dbPath !== "string") {
    console.error("[backend-worker] missing dbPath in workerData");
    process.exit(1);
  }
  const port = parentPort;

  const { db } = openDb(data.dbPath, { readonly: true });
  const tickMs = data.tickMs ?? DEFAULT_TICK_MS;
  const inFlight = new Set<string>();
  let shuttingDown = false;
  let isRunning = false;

  const post = (msg: BackendWorkerMessage): void => {
    if (shuttingDown) return;
    port.postMessage(msg);
  };

  const isShuttingDown = (): boolean => shuttingDown;

  const tick = async (): Promise<void> => {
    if (isRunning) return; // Per-tick guard — `setInterval` does NOT self-throttle.
    if (shuttingDown) return;
    isRunning = true;
    try {
      await runTick({
        db,
        inFlight,
        post,
        isShuttingDown,
      });
    } catch (err) {
      // `runTick` already catches per-pane throws; this catches anything
      // upstream (DB read failure on the live-jobs query, etc.). Log +
      // continue — the next tick will retry. NEVER throw out of here,
      // or the worker's interval callback rejects and the event loop
      // logs a stderr trace but the interval keeps firing — we want
      // the explicit log line instead.
      console.error(
        `[backend-worker] tick threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      isRunning = false;
    }
  };

  const tickTimer = setInterval(() => {
    void tick();
  }, tickMs);

  // Run one immediate tick so a freshly-spawned worker doesn't wait
  // the full interval before resolving the first batch.
  void tick();

  port.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg?.type !== "shutdown") return;
    shuttingDown = true;
    clearInterval(tickTimer);
    try {
      db.close();
    } catch {
      // best-effort; we're exiting either way
    }
    // Give any in-flight tick promise a beat to settle before exit.
    // The `shuttingDown` flag suppresses any late `post()` call.
    setImmediate(() => {
      process.exit(0);
    });
  });
}

// Mirrors every other producer worker: a plain `import` from a test runs
// on the main thread, where `main()` must NOT fire — the pure `runTick`
// and `readLiveJobsWithCoords` symbols are exercised directly by the
// test suite.
if (!isMainThread) {
  main();
}

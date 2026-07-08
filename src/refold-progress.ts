/**
 * `createRefoldProgressPoller` — read-only poller over the keeper DB that
 * surfaces the reducer's re-fold cursor (`reducer_state.last_event_id`)
 * against the events high-water mark (`MAX(events.id)`). Drives the
 * `view-shell` connecting-indicator's percentage so the user sees real
 * progress during a multi-minute boot re-fold (every `SCHEMA_VERSION` bump
 * rewinds the reducer cursor to 0 and re-drains the whole log).
 *
 * Design pillars (see fn-691 epic notes for rationale):
 *  - Lazy, RETRYABLE open. The connection is opened on the FIRST `poll()`,
 *    wrapped in try/catch → null. Importing this module is inert — no fds, no
 *    side effects — so a TUI that never starts the spinner (already-warm
 *    keeperd) never touches sqlite. A failed open does NOT latch dead for the
 *    process lifetime: the poller sits out a modest backoff of polls, then
 *    retries. This is load-bearing for the readiness gate — a viewer launched
 *    while keeperd is still down (no DB file yet) must pick up the re-fold
 *    percentage the moment the daemon boots and starts folding, not stay stuck
 *    on the plain spinner because its very first poll lost the open race.
 *  - One read-only connection, naked autocommit SELECTs. Mirrors
 *    `src/wake-worker.ts`'s pattern: an outer `BEGIN` would pin a WAL
 *    snapshot and starve the daemon's checkpoint. We issue two bare
 *    statements (`SELECT last_event_id FROM reducer_state` and
 *    `SELECT MAX(id) AS m FROM events`) — both O(log n) via the integer
 *    PK indexes, no full-table scan.
 *  - Short `busy_timeout` (100ms). The default 5000ms would freeze the
 *    ~125ms TUI animation during the migration's `BEGIN IMMEDIATE`
 *    write-lock window. On a blocked poll we return null and the caller
 *    holds its last-known floor.
 *  - Idempotent close. Both the self-stop and the SIGINT teardown call
 *    `close()`; double-calling must not throw.
 *
 * The poller does NOT decide what to render — it just surfaces `{cursor,
 * max}` or null. Composition / clamping / last-known-floor / "after N
 * misses drop to plain" all live at the consumer (`view-shell`).
 */

import type { Database } from "bun:sqlite";
import { openDb, resolveDbPath } from "./db";

/**
 * Polls to sit out after a failed lazy open before retrying. Small enough that
 * a viewer launched before keeperd picks up progress within ~half a second of
 * the DB appearing (the spinner polls ~every 125ms), large enough not to hammer
 * a missing/locked file on every animation tick.
 */
const OPEN_RETRY_BACKOFF_POLLS = 4;

/** One observation of the reducer-fold position. */
export interface RefoldProgress {
  /** Latest folded `events.id` per `reducer_state.last_event_id`. */
  cursor: number;
  /** Current high-water `MAX(events.id)` in the events log. */
  max: number;
}

/** Public surface — injectable into `createViewShell`. */
export interface RefoldProgressPoller {
  /** Read one sample. Returns null on any throw / missing row / open failure. */
  poll(): RefoldProgress | null;
  /** Tear down the connection. Idempotent — safe to call twice. */
  close(): void;
}

interface CursorRow {
  last_event_id: number;
}

interface MaxRow {
  m: number | null;
}

/**
 * Build a poller bound to the live keeper DB (`resolveDbPath()` — honors
 * `KEEPER_DB` for tests). The connection is opened lazily on first poll.
 *
 * `dbPath` is exposed only as a test seam — production callers pass nothing
 * and pick up the resolved default. (`KEEPER_DB` env override is the
 * preferred test path; both work.)
 */
export function createRefoldProgressPoller(
  dbPath: string = resolveDbPath(),
): RefoldProgressPoller {
  let db: Database | null = null;
  let closed = false;
  // Backoff countdown (in polls) before the next open ATTEMPT after a failure.
  // `0` = attempt now. A failed open sets it to `OPEN_RETRY_BACKOFF_POLLS` so
  // the poller sits out a few ticks (never hammers a missing/locked DB every
  // ~125ms) but always retries — a cold-start viewer must pick up progress the
  // moment keeperd's DB appears, so the failure is NEVER a process-lifetime latch.
  let openBackoff = 0;

  function ensureOpen(): Database | null {
    if (db !== null || closed) {
      return db;
    }
    if (openBackoff > 0) {
      openBackoff -= 1;
      return null;
    }
    try {
      // Lazy readonly open with a short busy_timeout so a contended SELECT
      // (the migration's `BEGIN IMMEDIATE` window) returns ~100ms instead of
      // freezing the ~125ms animation. `migrate: false` is implicit for
      // readers but stated for clarity in the comment — `openDb` ignores the
      // flag on readonly connections.
      const { db: opened } = openDb(dbPath, {
        readonly: true,
        busyTimeoutMs: 100,
      });
      db = opened;
    } catch {
      // Missing file, locked DB, schema mismatch — all surface as a null
      // poll. The caller (`view-shell`) drops to the plain spinner after a
      // few consecutive misses, so a transient open failure doesn't crash
      // the TUI. Sit out a modest backoff, then retry: the DB file may not
      // exist yet (keeperd still booting) and must be picked up once it does.
      db = null;
      openBackoff = OPEN_RETRY_BACKOFF_POLLS;
    }
    return db;
  }

  function poll(): RefoldProgress | null {
    const conn = ensureOpen();
    if (conn === null) {
      return null;
    }
    try {
      // Naked autocommit SELECTs — no `BEGIN`, or the WAL snapshot pins and
      // freezes our view of new commits (the same primitive `wake-worker`
      // uses against `PRAGMA data_version`).
      const cursorRow = conn
        .query("SELECT last_event_id FROM reducer_state")
        .get() as CursorRow | null;
      if (cursorRow === null) {
        return null;
      }
      const maxRow = conn
        .query("SELECT MAX(id) AS m FROM events")
        .get() as MaxRow | null;
      if (maxRow === null) {
        return null;
      }
      const cursor = cursorRow.last_event_id;
      // `MAX(id)` is null on an empty events table — surface that as a
      // null poll so the consumer falls back to the plain spinner rather
      // than computing `0/0 → NaN%`.
      if (maxRow.m === null) {
        return null;
      }
      return { cursor, max: maxRow.m };
    } catch {
      // BUSY (the migration writer holds the lock past our 100ms budget),
      // schema-skew, prepared-statement errors — all collapse to null.
      // Never throw out of a poll: a TUI animation tick can't recover.
      return null;
    }
  }

  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    if (db !== null) {
      try {
        db.close();
      } catch {
        // best-effort — the process is tearing down anyway.
      }
      db = null;
    }
  }

  return { poll, close };
}

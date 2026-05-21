/**
 * Keeper reducer. Folds events into the `jobs` projection.
 *
 * The core invariant is exactly-once-per-event: every fold of an event into
 * `jobs` and the matching advance of `reducer_state.last_event_id` happen in
 * the SAME `BEGIN IMMEDIATE` transaction. A crash mid-fold rolls back BOTH the
 * projection write and the cursor advance, so the boot drain simply re-folds
 * the event and converges. This is the textbook "update projection + advance
 * cursor atomically" pattern.
 *
 * The state machine is a heavily stripped descendant of hooks-tracker.py's
 * `_maintain_job_state`. All prise / harness / lineage / name-scraping logic is
 * intentionally dropped — keeper v1 holds the simplifying invariant that
 * `job_id === session_id` (one session per job).
 *
 *   event.hook_event   | jobs action
 *   -------------------|------------------------------------------------------
 *   SessionStart        | INSERT OR IGNORE a new job row; seed title from
 *                       |   spawn_name ('spawn' source) when present
 *   UserPromptSubmit    | state -> 'working'  (skipped when state == 'ended')
 *   Stop                | state -> 'stopped'  (skipped when state == 'ended')
 *   SessionEnd          | state -> 'ended'    (always; sticky thereafter)
 *   <any with title>    | title -> data.session_title ('payload' source) by
 *                       |   precedence (write iff it outranks/ties+changes)
 *   <everything else>   | no jobs write; cursor still advances
 *
 * Terminal `ended` is sticky: once a job is ended, UserPromptSubmit/Stop are
 * no-ops. SessionEnd always lands (idempotently re-asserts 'ended').
 *
 * Title provenance/precedence: NULL=0, 'spawn'=1, 'payload'=2. A higher source
 * wins; a lower one never clobbers a higher one (see {@link TITLE_PRIORITY}).
 */

import type { Database } from "bun:sqlite";
import type { Event } from "./types";

/**
 * Default batch size for {@link drain}. Keeps each writer transaction short so
 * the reducer never holds the WAL writer lock long enough to block hook
 * inserts; the caller loops until `drain()` returns 0.
 */
export const DEFAULT_BATCH_SIZE = 200;

/**
 * Test-only seam. When set, {@link applyEvent} invokes this AFTER the jobs
 * write but BEFORE the cursor advance, still inside the open transaction. A
 * throw from it must roll back the entire transaction (jobs write included),
 * proving the exactly-once invariant. Production code never sets this.
 */
export interface ApplyEventOptions {
  /** Injected throw point between jobs write and cursor advance (tests only). */
  onBeforeCursorAdvance?: (event: Event) => void;
}

/** Terminal job state. Once reached, only SessionEnd re-asserts it. */
const ENDED = "ended";

/**
 * Title-source precedence. A higher number wins. NULL `title_source` (the
 * zero-event reading, no title written yet) maps to priority 0 via
 * {@link sourcePriority}. The reducer writes a new title iff the incoming
 * source outranks the persisted one (`p > pp`) OR ties it with a changed value
 * (`p === pp && value changed`) — so a lower-priority source NEVER clobbers a
 * higher one, and an equal-priority re-fold is a value-only last-write-wins.
 *
 * A future transcript-supplement epic slots in as `3` with no reducer rewrite:
 * it just calls the same precedence write with `source = 'transcript'`.
 */
const TITLE_PRIORITY: Record<string, number> = { spawn: 1, payload: 2 };

/** Priority of a persisted/incoming `title_source`; NULL/unknown → 0. */
function sourcePriority(source: string | null): number {
  return source != null ? (TITLE_PRIORITY[source] ?? 0) : 0;
}

/**
 * Extract the top-level `session_title` from an event's `data` blob. try/catch
 * around `JSON.parse(event.data)`, skip-and-log via `console.error` on a
 * malformed blob (the cursor still advances upstream so one bad row never
 * wedges the reducer). `session_title` is NOT lifted to an events column — the
 * raw blob is its only carrier.
 *
 * Run event-agnostically like the mode rule (not gated to UserPromptSubmit); in
 * practice only UserPromptSubmit carries it. Returns the title only when it is a
 * non-empty string, else `null`.
 */
function extractSessionTitle(event: Event): string | null {
  if (event.data && event.data.length > 0) {
    try {
      const parsed = JSON.parse(event.data) as { session_title?: unknown };
      const title = parsed.session_title;
      if (typeof title === "string" && title.length > 0) {
        return title;
      }
    } catch (err) {
      // Malformed JSON: skip-and-log. The cursor still advances upstream so the
      // reducer never wedges on one bad row.
      console.error(
        `keeper reducer: failed to parse data blob for event id=${event.id} session=${event.session_id}: ${err}`,
      );
    }
  }
  return null;
}

/**
 * Apply the jobs-side projection for one event. Runs INSIDE the open
 * transaction opened by {@link applyEvent}; performs zero cursor work.
 *
 * Returns nothing — all writes go straight to `db`. The branches are
 * independent: the title update (when a `session_title` is present) is applied
 * on TOP of the lifecycle write, so e.g. a UserPromptSubmit carrying a new
 * title flips both state and title in one fold.
 */
function projectJobsRow(db: Database, event: Event): void {
  const ts = event.ts;
  const jobId = event.session_id;

  switch (event.hook_event) {
    case "SessionStart":
      // New job (or duplicate SessionStart): INSERT OR IGNORE. The schema
      // default gives state='stopped' — the zero-event reading. Seed the title
      // from the scraped spawn name (priority-1 'spawn' source) so the row
      // reads a non-NULL title from the very first event; a NULL spawn_name
      // leaves title NULL / title_source NULL (priority 0), with Tier 0 (the
      // payload title rule below) still seeding at the first UserPromptSubmit.
      // On a DUPLICATE SessionStart the OR IGNORE no-ops — the seed only lands
      // on first insert, which is correct (a later higher-priority title is
      // owned by the precedence rule, never re-seeded here).
      db.run(
        "INSERT OR IGNORE INTO jobs (job_id, created_at, cwd, pid, last_event_id, updated_at, title, title_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          jobId,
          ts,
          event.cwd,
          event.pid,
          event.id,
          ts,
          event.spawn_name,
          event.spawn_name ? "spawn" : null,
        ],
      );
      break;

    case "UserPromptSubmit":
      // Sticky 'ended': a terminated job ignores further prompts.
      db.run(
        `UPDATE jobs SET state = 'working', last_event_id = ?, updated_at = ?
           WHERE job_id = ? AND state != '${ENDED}'`,
        [event.id, ts, jobId],
      );
      break;

    case "Stop":
      db.run(
        `UPDATE jobs SET state = 'stopped', last_event_id = ?, updated_at = ?
           WHERE job_id = ? AND state != '${ENDED}'`,
        [event.id, ts, jobId],
      );
      break;

    case "SessionEnd":
      // Always lands; terminal and sticky. Matches zero rows for a terminal
      // event with no prior SessionStart — a correct no-op.
      db.run(
        "UPDATE jobs SET state = 'ended', last_event_id = ?, updated_at = ? WHERE job_id = ?",
        [event.id, ts, jobId],
      );
      break;

    default:
      // PreToolUse, PostToolUse, PostToolUseFailure, Notification,
      // SubagentStart, SubagentStop, and any unknown forward-compat event:
      // no lifecycle write. Cursor still advances upstream.
      break;
  }

  // Title precedence rule: a `session_title` in the data blob folds into
  // `jobs.title` as the priority-2 'payload' source, layered on top of any
  // lifecycle write above. Runs on ANY event and has no `state != 'ended'`
  // guard (no title-bearing events arrive post-SessionEnd anyway). Tier 1's
  // 'spawn' source (priority 1) is seeded on the SessionStart insert above, not
  // here; this rule generalizes the write so a higher-priority source promotes
  // the title and a lower one never clobbers it.
  //
  // Re-fold determinism: the write compares the incoming `(title, source)`
  // against the PERSISTED `(title, title_source)` read in-txn, never an
  // accumulator. We write iff the incoming priority outranks the persisted one,
  // or ties it with a changed value — so a rebuild-from-scratch is identical
  // (pure function of persisted state). No row → no-op.
  const title = extractSessionTitle(event);
  if (title != null) {
    const source = "payload";
    const p = sourcePriority(source);
    const row = db
      .query("SELECT title, title_source FROM jobs WHERE job_id = ?")
      .get(jobId) as {
      title: string | null;
      title_source: string | null;
    } | null;
    if (row != null) {
      const pp = sourcePriority(row.title_source);
      if (p > pp || (p === pp && row.title !== title)) {
        db.run(
          "UPDATE jobs SET title = ?, title_source = ?, last_event_id = ?, updated_at = ? WHERE job_id = ?",
          [title, source, event.id, ts, jobId],
        );
      }
    }
  }
}

/**
 * Fold ONE event into `jobs` and advance the cursor to `event.id`, atomically.
 *
 * Both writes share a single `BEGIN IMMEDIATE` transaction (via
 * `db.transaction`, which bun:sqlite runs as IMMEDIATE). On any throw the whole
 * transaction rolls back: neither the projection nor the cursor moves, and the
 * boot drain re-folds the event idempotently.
 *
 * `options.onBeforeCursorAdvance` is a test-only seam to simulate a crash
 * between the jobs write and the cursor advance.
 */
export function applyEvent(
  db: Database,
  event: Event,
  options: ApplyEventOptions = {},
): void {
  const fold = db.transaction(() => {
    projectJobsRow(db, event);
    options.onBeforeCursorAdvance?.(event);
    db.run(
      "UPDATE reducer_state SET last_event_id = ?, updated_at = ? WHERE id = 1",
      [event.id, event.ts],
    );
  });
  fold();
}

/**
 * Drain a batch of unfolded events. Reads up to `batchSize` events with
 * `id > last_event_id`, folds each via {@link applyEvent}, and returns the
 * number drained. Returns 0 when caught up (including when a non-event
 * `data_version` bump — VACUUM / WAL checkpoint — produced no new rows).
 *
 * The caller loops until this returns 0. Each event is folded in its own
 * transaction (NOT one big transaction across the batch) so the writer lock is
 * released between events and hook inserts are never starved.
 *
 * A row whose `data` blob is unparseable still advances the cursor — the parse
 * is guarded inside {@link extractPermissionMode} (skip-and-log), so one
 * malformed row never halts the reducer.
 */
export function drain(db: Database, batchSize = DEFAULT_BATCH_SIZE): number {
  const cursorRow = db
    .query("SELECT last_event_id FROM reducer_state WHERE id = 1")
    .get() as { last_event_id: number } | null;
  const cursor = cursorRow?.last_event_id ?? 0;

  const rows = db
    .query(
      `SELECT id, ts, session_id, pid, hook_event, event_type, tool_name,
              matcher, cwd, permission_mode, agent_id, agent_type,
              stop_hook_active, data, subagent_agent_id, spawn_name
         FROM events
        WHERE id > ?
        ORDER BY id ASC
        LIMIT ?`,
    )
    .all(cursor, batchSize) as Event[];

  for (const row of rows) {
    applyEvent(db, row);
  }

  return rows.length;
}

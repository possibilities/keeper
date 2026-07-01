/**
 * Handoff slug identity — an agent-authored, slugified, globally-unique key for a
 * `keeper handoff`. The slug IS the handoff id: it rides the `handoff::<slug>`
 * spawn-name path and is frozen verbatim into the `HandoffRequested` event, so
 * uniqueness is PERMANENT and host-global (probed against the append-only events
 * log, never re-derived at replay — re-slugifying on a re-fold would let an
 * algorithm change retroactively break the frozen-event invariant).
 *
 * The pure `[a-z0-9-]+` normalize/validate primitives live in the dep-free
 * `src/slug.ts` leaf; this module re-exports them under handoff-scoped names
 * (pinning "handoff slug" wording so handoff error strings stay byte-identical)
 * and adds {@link handoffSlugExists} — the single-writer uniqueness probe main
 * runs synchronously before the append (the ONE piece that needs `bun:sqlite`).
 */

import type { Database } from "bun:sqlite";
import {
  SLUG_MAX_LEN,
  slugify,
  type ValidateSlugResult,
  validateSlug,
} from "./slug";

/** Max slug length (chars) AFTER slugify. The slug rides as a tmux/spawn name
 *  (`handoff::<slug>`) and inline in the event log, so it stays short. */
export const HANDOFF_SLUG_MAX_LEN = SLUG_MAX_LEN;

export type { ValidateSlugResult };

/** Normalize free text to a `[a-z0-9-]+` handoff slug, or `null` when empty. The
 *  CLI-side gate ({@link slugify} from the dep-free leaf). */
export const slugifyHandoffSlug = slugify;

/**
 * Re-validate a handoff slug at the daemon's socket trust boundary. The CLI
 * slugifies, but a hand-crafted RPC bypasses that, so the daemon independently
 * rejects empty / oversized / `.` / `..` / non-`[a-z0-9-]+` / all-hyphen values.
 * Thin "handoff slug"-labeled wrapper over {@link validateSlug}. Pure.
 */
export function validateHandoffSlug(slug: unknown): ValidateSlugResult {
  return validateSlug(slug, "handoff slug");
}

/**
 * Permanent host-global uniqueness probe: does a `HandoffRequested` event already
 * carry this slug? Leads with the `session_id = ?` predicate so the planner uses
 * `idx_events_session` (a seek, not a scan of every `HandoffRequested` row) — the
 * slug rides the event's `session_id` overload. Drain-independent (the events log
 * is the system of record, never the live projection), so uniqueness holds across
 * compaction and re-fold. Pure `(slug, db) -> boolean` — unit-testable without
 * booting the daemon. Main runs this SYNCHRONOUSLY immediately before the append,
 * with no `await` between probe and insert, so the single-writer lock makes it
 * race-free.
 */
export function handoffSlugExists(slug: string, db: Database): boolean {
  const row = db
    .query(
      `SELECT 1 FROM events
        WHERE session_id = ? AND hook_event = 'HandoffRequested'
        LIMIT 1`,
    )
    .get(slug);
  return row != null;
}

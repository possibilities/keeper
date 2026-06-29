/**
 * Handoff slug identity — an agent-authored, slugified, globally-unique key for a
 * `keeper handoff`. The slug IS the handoff id: it rides the `handoff::<slug>`
 * spawn-name path and is frozen verbatim into the `HandoffRequested` event, so
 * uniqueness is PERMANENT and host-global (probed against the append-only events
 * log, never re-derived at replay — re-slugifying on a re-fold would let an
 * algorithm change retroactively break the frozen-event invariant).
 *
 * Three pure helpers: {@link slugifyHandoffSlug} (CLI-side normalization),
 * {@link validateHandoffSlug} (the daemon's socket-boundary re-validation — a
 * hand-crafted RPC bypasses the CLI), and {@link handoffSlugExists} (the
 * single-writer uniqueness probe main runs synchronously before the append).
 */

import type { Database } from "bun:sqlite";

/** Max slug length (chars) AFTER slugify. The slug rides as a tmux/spawn name
 *  (`handoff::<slug>`) and inline in the event log, so it stays short. The CLI
 *  truncates to this; the daemon rejects anything longer. */
export const HANDOFF_SLUG_MAX_LEN = 64;

/**
 * Normalize free text to a `[a-z0-9-]+` handoff slug, or `null` when the result
 * is empty (the CLI rejects that as misuse — slugs are user-authored, never
 * suffixed). Reimplements the shape of `plugins/plan/src/ids.ts:slugify` WITHOUT
 * importing the peer plan plugin: NFKD → strip combining marks (`\p{M}`) → drop
 * remaining non-ASCII (homoglyphs fall out of the ASCII class) → lowercase →
 * collapse every run of non-`[a-z0-9]` to a single `-` → trim leading/trailing
 * `-` → cap length AFTER the transform. `.`/`..`/all-dash/emoji-only inputs all
 * collapse to empty and return `null`.
 */
export function slugifyHandoffSlug(text: string): string | null {
  let s = String(text).normalize("NFKD");
  // Strip combining marks the NFKD decomposition exposed (é → e + ´).
  s = s.replace(/\p{M}/gu, "");
  // Drop anything still outside ASCII (emoji, CJK, homoglyphs).
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII-only gate.
  s = s.replace(/[^\x00-\x7F]/g, "");
  s = s.toLowerCase();
  // Every run of non-alphanumerics collapses to a single hyphen.
  s = s.replace(/[^a-z0-9]+/g, "-");
  s = s.replace(/^-+|-+$/g, "");
  if (s.length > HANDOFF_SLUG_MAX_LEN) {
    s = s.slice(0, HANDOFF_SLUG_MAX_LEN).replace(/-+$/g, "");
  }
  return s === "" ? null : s;
}

/** Discriminated result of {@link validateHandoffSlug}. */
export type ValidateSlugResult = { ok: true } | { ok: false; error: string };

/**
 * Re-validate a slug at the daemon's socket trust boundary. The CLI slugifies,
 * but a hand-crafted RPC bypasses that, so the daemon independently rejects
 * empty / oversized / `.` / `..` / non-`[a-z0-9-]+` / all-hyphen values. Pure —
 * exported for unit reach and reused by the RPC param validator.
 */
export function validateHandoffSlug(slug: unknown): ValidateSlugResult {
  if (typeof slug !== "string" || slug.length === 0) {
    return { ok: false, error: "handoff slug is empty" };
  }
  if (slug === "." || slug === "..") {
    return { ok: false, error: "handoff slug cannot be '.' or '..'" };
  }
  if (slug.length > HANDOFF_SLUG_MAX_LEN) {
    return {
      ok: false,
      error: `handoff slug is ${slug.length} chars, over the ${HANDOFF_SLUG_MAX_LEN}-char cap`,
    };
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return {
      ok: false,
      error:
        "handoff slug must match [a-z0-9-]+ (lowercase letters, digits, hyphens)",
    };
  }
  if (!/[a-z0-9]/.test(slug)) {
    return {
      ok: false,
      error: "handoff slug must contain at least one letter or digit",
    };
  }
  return { ok: true };
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

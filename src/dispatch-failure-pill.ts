/**
 * Pure classifier + key→target resolver for the sticky `dispatch_failures`
 * projection, shared by the board TUI (`cli/board.ts` via `src/board-render.ts`)
 * and the `keeper status` JSON envelope (`cli/status.ts`). Render-layer only:
 * NOTHING here reads a socket, a clock, or the DB, and it imports NO
 * `bun:sqlite` / `icon-theme` / color helper — so `cli/status.ts` can pull it in
 * without dragging TTY deps. Wrong attribution is cosmetic (a mislabeled pill);
 * dispatch is never gated on it.
 *
 * Two concerns:
 *   - `classifyDispatchFailure`: a multi-line `reason` (e.g. a merge-conflict
 *     dump) collapses to one short scannable KIND token via ordered
 *     most-specific-first PREFIX rules (never substring-contains, which silently
 *     collides). The three conflict variants fold to one `merge-conflict` (all
 *     need the same "resolve + retry" action); `non-ff` / `dirty-tree` /
 *     `multi-repo` stay distinct — they route to different operator responses.
 *   - `resolveFailureTarget`: maps a `dispatch_failures` row's `(verb,id)` to the
 *     board row it belongs to — a `work::` row to its task, a `close::` row
 *     (bare OR worktree-mode-keyed) to its epic, or `null` (drop the pill) for a
 *     path-keyed null-epic row or a zero-match.
 */

import {
  DISPATCH_FAILURE_DISPLAY_RULES,
  WORKTREE_CLOSE_KEY_PREFIXES,
} from "./dispatch-failure-key";

/**
 * Collapse a raw `dispatch_failures.reason` to a short display KIND. Ordered
 * prefix rules first; on no match, fall back to the leading token before the
 * first `:` or whitespace (reproducing the historical
 * `reason.split(/[:\s]/, 1)[0]` behavior). NEVER throws, NEVER returns an empty
 * string — an empty/degenerate reason yields `unknown` so the caller never mints
 * a bare `[failed:]` pill.
 */
export function classifyDispatchFailure(reason: string): string {
  for (const rule of DISPATCH_FAILURE_DISPLAY_RULES) {
    if (reason.startsWith(rule.prefix)) {
      return rule.kind;
    }
  }
  const leading = reason.split(/[:\s]/, 1)[0] ?? reason;
  return leading === "" ? "unknown" : leading;
}

/** The board row a sticky failure belongs to. */
export type FailureTarget =
  | { kind: "task"; taskId: string }
  | { kind: "epic"; epicId: string };

/** A matched epic id must be followed by one of these delimiters (or
 * end-of-string) so `fn-106` never claims an `fn-1061-…` key. */
const EPIC_ID_BOUNDARY_CHARS = new Set(["-", ":"]);

/**
 * Resolve a `dispatch_failures` row to the board target its pill decorates.
 *
 * - `verb === "work"`: `id` is the task id verbatim → `{kind:'task'}`.
 * - `verb === "close"`: strip a leading `worktree-finalize:` / `worktree-recover:`
 *   prefix; a remainder that is empty or starts with `/` is a path-keyed
 *   null-epic row → `null`. Otherwise match an epic by BOUNDARY-CHECKED
 *   LONGEST-MATCH against `epicIds` (sort length-desc; require a `-`/`:`/end
 *   boundary after the match). A bare `close::<epic>` (id === an epic id)
 *   resolves directly. Zero match → `null`.
 * - Any other verb → `null`.
 *
 * NEVER throws. `dir` is accepted for call-site symmetry with the row shape but
 * unused (the boundary-checked join needs no worktree-hash strip).
 */
export function resolveFailureTarget(
  row: { verb: string; id: string; dir: string },
  epicIds: readonly string[],
): FailureTarget | null {
  if (row.verb === "work") {
    return row.id === "" ? null : { kind: "task", taskId: row.id };
  }
  if (row.verb !== "close") {
    return null;
  }
  let remainder = row.id;
  for (const prefix of WORKTREE_CLOSE_KEY_PREFIXES) {
    if (remainder.startsWith(prefix)) {
      remainder = remainder.slice(prefix.length);
      break;
    }
  }
  if (remainder === "" || remainder.startsWith("/")) {
    return null;
  }
  const candidates = [...epicIds].sort((a, b) => b.length - a.length);
  for (const epicId of candidates) {
    if (epicId === "" || !remainder.startsWith(epicId)) {
      continue;
    }
    const boundary = remainder.charAt(epicId.length); // "" at end-of-string
    if (boundary === "" || EPIC_ID_BOUNDARY_CHARS.has(boundary)) {
      return { kind: "epic", epicId };
    }
  }
  return null;
}

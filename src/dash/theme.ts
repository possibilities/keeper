/**
 * `keeper dash` color theme — the design layer, forked from board-render's
 * SGR bucket semantics (`src/board-render.ts` `SGR` / `PILL_COLORS`) into
 * semantic ROLES the dash view-model tags every segment with.
 *
 * A role maps to an ANSI-indexed color DESCRIPTOR — plain data (an optional
 * `index` plus optional `dim` / `bold` flags), NOT an RGBA and NOT an
 * `@opentui` import. The materializer converts a descriptor to a renderable
 * color via `RGBA.fromIndex(index)` and layers the flags on as text
 * attributes; an ABSENT `index` means "terminal default foreground" (no fg
 * override at all). Keeping indices (instead of hex strings) lets the
 * rendered hue TRACK the user's terminal theme so dim/semantic tones stay
 * legible on light terminals — the locked-in colors decision.
 *
 * The board bucket → role correspondence (so the two views stay in visual
 * sync without sharing code):
 * - motion    ← board `blue`    (bright blue) — a session in motion right now
 * - ready     ← board `success` (green)       — ready / completed / ok
 * - attention ← board `warn`    (yellow)      — blocked / awaiting a human
 * - failed    ← board `error`   (red)         — failed / rejected / killed
 * - terminal  ← board `faded`   (dim)         — done / inert / receded detail
 * - accent    ← board `active`  (cyan)        — live human-chosen structural
 *                                               signal (armed, markers)
 *
 * Two text roles carry the workability axis the glyph colors complement:
 * - heading — default fg + bold: the title of an epic that is workable RIGHT
 *   NOW (ready / running); it pops against everything else.
 * - text    — default fg: a workable task title or a live job label.
 * Inert lines (completed / blocked) drop to `terminal` so the whole row
 * visually recedes while its status glyph keeps the exact state legible.
 *
 * Pure data + a pure resolver — no I/O, no wall-clock, no `@opentui`.
 */

/** The semantic roles every view-model segment carries. */
export type Role =
  | "motion"
  | "ready"
  | "attention"
  | "failed"
  | "terminal"
  | "accent"
  | "heading"
  | "text";

/**
 * An ANSI-indexed color descriptor — the materializer feeds `index` to
 * `RGBA.fromIndex` (absent ⇒ terminal default foreground, no override) and
 * maps `dim` / `bold` to the renderable's text attributes. Plain data — no
 * RGBA, no `@opentui`.
 */
export interface ColorDescriptor {
  /**
   * Standard ANSI palette index. 0–7 the normal set, 8–15 the bright set —
   * the bright entries mirror board-render's `9x` SGR codes (e.g. bright blue
   * `94` → index 12, bright cyan `96` → index 14). Absent ⇒ default fg.
   */
  readonly index?: number;
  /** Low-intensity rendering — the faded inert tone. */
  readonly dim?: boolean;
  /** High-emphasis rendering — workable-now headings. */
  readonly bold?: boolean;
}

/**
 * The locked-in role → descriptor map, forked from board-render's buckets. The
 * indices are the standard-16 ANSI palette so the hue tracks the terminal
 * theme: bright variants (12/14) match board's `94`/`96` SGR motion/accent
 * hues; `terminal` rides index 7 with `dim` for the faded inert tone;
 * `heading`/`text` carry NO index so titles render in the terminal's own
 * default foreground.
 */
export const ROLE_COLORS: Record<Role, ColorDescriptor> = {
  motion: { index: 12 },
  ready: { index: 2 },
  attention: { index: 3 },
  failed: { index: 1 },
  terminal: { index: 7, dim: true },
  accent: { index: 14 },
  heading: { bold: true },
  text: {},
};

/**
 * The ANSI index for structural chrome — section rules, dividers, and their
 * inline titles. Index 8 (bright black) is the conventional unobtrusive gray
 * that still tracks the terminal palette. Consumed by the materializer for
 * border/title colors, which take an RGBA directly (no attribute channel, so
 * this lives outside the role map).
 */
export const STRUCTURE_COLOR_INDEX = 8;

/** Resolve a role to its ANSI-indexed descriptor. Pure. */
export function colorForRole(role: Role): ColorDescriptor {
  return ROLE_COLORS[role];
}

// ---------------------------------------------------------------------------
// Icon roles — the robot-line status channel
// ---------------------------------------------------------------------------

/**
 * The six icon roles of the robot job-line status ladder (`view-model.ts`
 * `robotRung`). One per rung; each names the COLOR the leading status icon
 * paints to dual-encode status alongside the robot face. Distinct from
 * {@link Role} (which tags the text segments of the board view) because the
 * ladder needs DIM variants of the success/failed/gray hues — `idle-ended`
 * rides green dim, `idle-killed` red dim, `idle-stopped` gray dim — that the
 * text-role map does not carry. The dash materializer (`./app.ts`) feeds the
 * index to `RGBA.fromIndex` and layers `dim` as a paint attribute, so the
 * receded idle rungs recede while the attention rungs stay full-intensity.
 */
export type IconRole =
  | "error"
  | "awaiting"
  | "working"
  | "idle-ended"
  | "idle-stopped"
  | "idle-killed";

/**
 * The icon-role → descriptor map. Indices stay on the standard-16 ANSI palette
 * (so the hue tracks the terminal theme) and the three idle/terminal rungs
 * carry `dim` so completed/stopped/killed lines recede while the attention
 * rungs (error red, awaiting yellow, working blue) stay full-intensity. The
 * indices 1 / 3 / 12 differ in lightness so status survives grayscale and
 * color-deficiency (WCAG SC 1.4.1).
 */
export const ICON_COLORS: Record<IconRole, ColorDescriptor> = {
  error: { index: 1 },
  awaiting: { index: 3 },
  working: { index: 12 },
  "idle-ended": { index: 2, dim: true },
  "idle-stopped": { index: 7, dim: true },
  "idle-killed": { index: 1, dim: true },
};

/** Resolve an icon role to its ANSI-indexed descriptor. Pure. */
export function colorForIcon(role: IconRole): ColorDescriptor {
  return ICON_COLORS[role];
}

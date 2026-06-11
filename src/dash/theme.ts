/**
 * `keeper dash` color theme — the design layer, forked from board-render's
 * SGR bucket semantics (`src/board-render.ts` `SGR` / `PILL_COLORS`) into six
 * semantic ROLES the dash view-model tags every segment with.
 *
 * A role maps to an ANSI-indexed color DESCRIPTOR — plain data (`{ index }`
 * plus an optional `dim` flag), NOT an RGBA and NOT an `@opentui` import. The
 * materializer (task .2) converts a descriptor to a renderable color via
 * `RGBA.fromIndex(index)`; keeping the index here (instead of a hex string)
 * lets the rendered hue TRACK the user's terminal theme so dim/semantic tones
 * stay legible on light terminals — the locked-in colors decision.
 *
 * The board bucket → role correspondence (so the two views stay in visual
 * sync without sharing code):
 * - motion    ← board `blue`    (bright blue) — a session in motion right now
 * - ready     ← board `success` (green)       — ready / completed / ok
 * - attention ← board `warn`    (yellow)      — blocked / awaiting a human
 * - failed    ← board `error`   (red)         — failed / rejected / killed
 * - terminal  ← board `faded`   (dim)         — done / superseded / inert tail
 * - accent    ← board `active`  (cyan)        — live human-chosen structural
 *                                               signal (armed, markers)
 *
 * Pure data + a pure resolver — no I/O, no wall-clock, no `@opentui`.
 */

/** The six semantic roles every view-model segment carries. */
export type Role =
  | "motion"
  | "ready"
  | "attention"
  | "failed"
  | "terminal"
  | "accent";

/**
 * An ANSI-indexed color descriptor — the materializer feeds `index` to
 * `RGBA.fromIndex`. `dim` (when true) is the low-intensity rendering the
 * `terminal` role wants for its inert-tail tone; the materializer layers it on
 * via the renderable's dim attribute. Plain data — no RGBA, no `@opentui`.
 */
export interface ColorDescriptor {
  /**
   * Standard ANSI palette index. 0–7 the normal set, 8–15 the bright set —
   * the bright entries mirror board-render's `9x` SGR codes (e.g. bright blue
   * `94` → index 12, bright cyan `96` → index 14).
   */
  readonly index: number;
  /** Low-intensity rendering — set only on the inert `terminal` tail tone. */
  readonly dim?: boolean;
}

/**
 * The locked-in role → descriptor map, forked from board-render's buckets. The
 * indices are the standard-16 ANSI palette so the hue tracks the terminal
 * theme: bright variants (12/14) match board's `94`/`96` SGR motion/accent
 * hues; `terminal` rides index 7 with `dim` for the faded inert tone.
 */
export const ROLE_COLORS: Record<Role, ColorDescriptor> = {
  motion: { index: 12 },
  ready: { index: 2 },
  attention: { index: 3 },
  failed: { index: 1 },
  terminal: { index: 7, dim: true },
  accent: { index: 14 },
};

/** Resolve a role to its ANSI-indexed descriptor. Pure. */
export function colorForRole(role: Role): ColorDescriptor {
  return ROLE_COLORS[role];
}

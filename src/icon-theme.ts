/**
 * Icon themes for the `keeper board` / `keeper jobs` TUIs (fn-713 follow-on).
 *
 * A theme is a total `pill-token → Nerd Font glyph` map. The board/jobs
 * renderers wrap every state pill as `[<glyph>::<token-text>]` (the `::`
 * delimiter separates the icon from the text the colorizer still tints).
 * The glyph is the source of truth; color stays an orthogonal axis applied
 * by `colorizePillsInLine` keyed on the text half (today's rules).
 *
 * Design + provenance: `~/docs/keeper-tui-icon-sets.md` (the themeable
 * state→glyph form) and `~/docs/pill-inventory.md` (the pill vocabulary).
 * This module is the durable home of the `fa-classic` set we locked in —
 * Font Awesome 4 codepoints (Nerd Font `nf-fa-*`), the most version-stable
 * PUA region. Swap `ACTIVE_THEME` to reskin both views.
 *
 * Glyphs are stored as **hex codepoint strings** (e.g. `"f04b"`), NOT literal
 * glyph bytes — the source stays pure ASCII (greppable, diff-friendly, no
 * font needed to read it) and `glyphForToken` materializes the glyph via
 * `String.fromCodePoint`. Pure data + a pure resolver — no I/O, no
 * wall-clock — so the render path stays deterministic and the live-shell
 * byte-compare holds.
 */

export interface IconTheme {
  name: string;
  /**
   * Exact `inner-token → hex codepoint`. Covers the verdict tags/running
   * kinds, the residual enum values, and the per-kind `failed:<k>` /
   * `awaiting:<k>` tokens (listed explicitly so a kind carries its own glyph).
   */
  exact: Record<string, string>;
  /**
   * `prefix → hex codepoint` fallback for dynamic-payload tokens whose tail
   * is not enumerable: `blocked:<reason …>` (ONE glyph for every block
   * reason — the reason rides on the text), `task-repo:<base>`,
   * `dead-letter:<N>`, plus catch-alls for `failed:` / `awaiting:` /
   * `running:` when a future kind isn't in `exact`. Matched after `exact`
   * misses, longest-prefix-first.
   */
  prefix: Record<string, string>;
}

// Font Awesome 4 codepoints (nf-fa-*), as hex strings. Names mirror FA.
const FA = {
  play: "f04b",
  checkCircle: "f058",
  sync: "f021",
  pencil: "f040",
  cogs: "f085",
  exclTriangle: "f071",
  ban: "f05e",
  circle: "f111",
  circleO: "f10c",
  check: "f00c",
  times: "f00d",
  wrench: "f0ad",
  flagCheckered: "f11e",
  plusCircle: "f055",
  magic: "f0d0",
  dotCircleO: "f192",
  pauseCircle: "f28b",
  clockO: "f017",
  thumbsDown: "f165",
  shield: "f132",
  question: "f128",
  history: "f1da",
  tachometer: "f0e4",
  key: "f084",
  creditCard: "f09d",
  server: "f233",
  bug: "f188",
  commentO: "f0e5",
  handPaperO: "f256",
  commentsO: "f0e6",
  eye: "f06e",
  terminal: "f120",
  plug: "f1e6",
  globe: "f0ac",
  levelDown: "f149",
  envelope: "f0e0",
  random: "f074",
  filesO: "f0c5",
  bolt: "f0e7",
} as const;

/**
 * The locked-in `fa-classic` theme (iterated with the human over the
 * `/tmp/keeper-icon-theme-preview.py` dry runs).
 */
export const FA_CLASSIC: IconTheme = {
  name: "fa-classic",
  exact: {
    // --- verdict (Tier 1A): one glyph per tag; the four running kinds ---
    ready: FA.play,
    completed: FA.checkCircle,
    "running:job-running": FA.sync,
    "running:planner-running": FA.pencil,
    "running:sub-agent-running": FA.cogs,
    "running:sub-agent-stale": FA.exclTriangle,
    // fn-719: a live worker-launched monitor (backgrounded suite) occupying
    // the mutex — `eye` mirrors the `monitor` SessionLifecycle glyph; the
    // stale variant shares the warn triangle with `sub-agent-stale`.
    "running:monitor-running": FA.eye,
    "running:monitor-stale": FA.exclTriangle,
    // (every `blocked:<reason>` → FA.ban via the prefix map below.)

    // --- SessionLifecycle ---
    working: FA.circle,
    stopped: FA.circleO,
    ended: FA.check,
    killed: FA.times,

    // --- SessionRole ---
    planner: FA.pencil,
    worker: FA.wrench,
    closer: FA.flagCheckered,
    creator: FA.plusCircle,
    refiner: FA.magic,

    // --- RuntimeStatus (planctl manual) ---
    todo: FA.circleO,
    in_progress: FA.dotCircleO,
    done: FA.checkCircle,
    "rt:blocked": FA.pauseCircle,

    // --- WorkerPhase ---
    open: FA.circleO,
    "worker-done": FA.checkCircle,

    // --- Approval ---
    pending: FA.clockO,
    approved: FA.check,
    rejected: FA.thumbsDown,

    // --- Validated ---
    validated: FA.shield,
    unvalidated: FA.circleO,

    // --- SubagentStatus ---
    running: FA.sync,
    ok: FA.check,
    failed: FA.times,
    unknown: FA.question,
    superseded: FA.history,

    // --- ApiFailureKind (failed:<kind>) ---
    "failed:rate_limit": FA.tachometer,
    "failed:authentication_failed": FA.key,
    "failed:billing_error": FA.creditCard,
    "failed:server_error": FA.server,
    "failed:invalid_request": FA.bug,
    "failed:unknown": FA.question,

    // --- AwaitingKind (awaiting:<kind>) ---
    "awaiting:ask_user_question": FA.commentO,
    "awaiting:permission": FA.handPaperO,
    "awaiting:elicitation": FA.commentsO,

    // --- MonitorKind ---
    monitor: FA.eye,
    "bash-bg": FA.terminal,
    ambient: FA.plug,

    // --- markers ---
    "slotted-after-closer": FA.levelDown,
    armed: FA.bolt,
  },
  prefix: {
    "blocked:": FA.ban, // ONE glyph for every block reason (reason via text)
    "task-repo:": FA.random,
    "dead-letter:": FA.envelope,
    // catch-alls when a future kind isn't enumerated in `exact`:
    "failed:": FA.times,
    "awaiting:": FA.commentO,
    "running:": FA.sync,
  },
};

/** The theme both views render with. Swap to reskin. */
export const ACTIVE_THEME: IconTheme = FA_CLASSIC;

/** Materialize a hex codepoint string (e.g. `"f04b"`) to its glyph. */
function cp(hex: string): string {
  return String.fromCodePoint(Number.parseInt(hex, 16));
}

/**
 * Resolve a pill's inner token text to its glyph, or `null` when the token
 * is not a themed state (e.g. dep refs `#2` / `arthack#633`, the
 * backend-coords `p3` label) — the caller leaves those as plain `[token]`
 * pills with no icon.
 *
 * Exact match wins; otherwise the longest matching prefix. Pure function.
 */
export function glyphForToken(
  token: string,
  theme: IconTheme = ACTIVE_THEME,
): string | null {
  const exact = theme.exact[token];
  if (exact !== undefined) {
    return cp(exact);
  }
  let bestHex: string | null = null;
  let bestLen = -1;
  for (const [pfx, hex] of Object.entries(theme.prefix)) {
    if (token.startsWith(pfx) && pfx.length > bestLen) {
      bestHex = hex;
      bestLen = pfx.length;
    }
  }
  return bestHex === null ? null : cp(bestHex);
}

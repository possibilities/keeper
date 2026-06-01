/**
 * ANSI SGR → OpenTUI StyledText shim.
 *
 * Board (`cli/board.ts`) emits its frame body with raw SGR escape codes
 * embedded in the line strings — `colorizePillsInLine` wraps `[<token>]`
 * pills with one of six SGR opens (`\x1b[96m`, `\x1b[32m`, `\x1b[31m`,
 * `\x1b[33m`, `\x1b[2;37m`) and one close (`\x1b[0m`). The bespoke pre-
 * OpenTUI renderer wrote those bytes straight to stdout, which the
 * terminal handled natively. The OpenTUI `TextRenderable`, however,
 * treats `.content` as opaque text — embedded SGR bytes render as
 * literal garbage (`^[[96m`, `^[[0m`).
 *
 * This module bridges the gap. It parses a string carrying any subset
 * of the SGR codes board emits and produces an OpenTUI `StyledText`
 * whose chunks carry the equivalent foreground color / DIM attribute.
 * Unrecognized escape sequences are STRIPPED — never passed through as
 * visible bytes — so a typo or a future SGR addition fails clean (no
 * color) rather than leaking `^[[...m` garbage onto the screen.
 *
 * Semantic buckets, mirroring `board.ts`'s `SGR` table (the only
 * site that emits these escapes today; sidecars and lifecycle output
 * stay plain and never reach this shim):
 *
 *   active  (bright cyan, `\x1b[96m`)   — in motion / cyan
 *   blue    (bright blue, `\x1b[94m`)   — a `running` work pill
 *   success (green,       `\x1b[32m`)   — positive resolution
 *   error   (red,         `\x1b[31m`)   — failure
 *   warn    (yellow,      `\x1b[33m`)   — blocked / in the way
 *   faded   (dim white,   `\x1b[2;37m`) — terminal / historical
 *
 * The reset code `\x1b[0m` ends the active style and returns to plain.
 *
 * Why a pure-parser + runtime-injected ctor split. The line-parser
 * (`parseAnsiSegments`) is a pure string→string[] function — tested
 * standalone against every SGR + edge case without standing up OpenTUI.
 * The chunk-builder (`ansiLineToStyled`) takes a runtime helper bag
 * with the `StyledText` / `RGBA` ctors + the `TextAttributes` table —
 * `@opentui/core` runtime imports are heavy (top-level native binary
 * load) and we don't want every test that touches a string-side board
 * helper to pay that cost. Production callers (`src/live-shell.ts`'s
 * paint layer) inject the runtime helpers they already imported for
 * the rest of the scene; the shim test imports them eagerly the same
 * way `test/live-shell.test.ts` does.
 *
 * Multi-line bodies. `linesToContent` is the convenience entry the
 * paint layer calls per frame: walks the row list, returns the plain
 * `\n`-joined string when no line contains any `\x1b` (so the existing
 * fast-path stays a single string assignment), or builds one
 * `StyledText` carrying every row joined by `\n` chunks when any line
 * does. Per-line parsing is independent — a colored line followed by
 * a plain line followed by another colored line all compose into the
 * single body StyledText.
 */

import type { RGBA, StyledText, TextChunk } from "@opentui/core";

/**
 * The semantic buckets `colorizePillsInLine` emits. `plain` is the
 * absence of an SGR open — text outside any colored span, before the
 * first open, after a reset, or between adjacent resets. The parser's
 * output is a flat sequence of these; the chunk-builder maps each to
 * its OpenTUI styling.
 */
export type SegmentKind =
  | "plain"
  | "active"
  | "blue"
  | "success"
  | "error"
  | "warn"
  | "faded";

/**
 * One contiguous text run sharing a single style bucket. The parser
 * splits the input at every SGR boundary it recognizes; consecutive
 * runs of the same bucket are NOT coalesced (the parser is honest
 * about the source boundaries — coalescing belongs at a higher layer
 * if ever needed). An empty `text` is possible when an open
 * immediately follows a reset; the chunk-builder drops zero-length
 * chunks so a `StyledText` never carries empty entries.
 */
export interface ParsedSegment {
  readonly kind: SegmentKind;
  readonly text: string;
}

/**
 * Map of SGR open code → bucket. The six entries match
 * `scripts/board.ts:SGR` verbatim. Multi-parameter `2;37` (dim+white)
 * is keyed as a single composite — the parser matches the full body
 * between `\x1b[` and `m`, so `2;37` is one lookup.
 */
const SGR_OPEN_TO_KIND: Record<string, SegmentKind> = {
  "96": "active",
  "94": "blue",
  "32": "success",
  "31": "error",
  "33": "warn",
  "2;37": "faded",
};

/**
 * Hex foreground colors per bucket. Chosen to match xterm's standard
 * 16-color palette (the colors a default terminal renders for those
 * SGR codes) so a side-by-side comparison of `bun scripts/board.ts`
 * vs `keeper board` is visually identical:
 *
 *   active  → bright cyan  (\x1b[96m) ≈ #5FFFFF / pure cyan family
 *   blue    → bright blue  (\x1b[94m) ≈ #5C5CFF (xterm bright-blue index 12)
 *   success → green        (\x1b[32m) ≈ standard green
 *   error   → red          (\x1b[31m) ≈ standard red
 *   warn    → yellow       (\x1b[33m) ≈ standard yellow
 *   faded   → white + DIM  (\x1b[2;37m) — white with the DIM attribute
 *
 * The `faded` bucket carries the white hex AND sets the DIM attribute
 * on the chunk; the chunk-builder ORs `TextAttributes.DIM` onto the
 * chunk's `attributes` field. `plain` carries no `fg` / `attributes`
 * — the chunk renders in the terminal's default foreground.
 */
const SEGMENT_FG_HEX: Record<Exclude<SegmentKind, "plain">, string> = {
  active: "#00FFFF",
  blue: "#5C5CFF",
  success: "#00CD00",
  error: "#CD0000",
  warn: "#CDCD00",
  faded: "#E5E5E5",
};

/**
 * Runtime helpers the chunk-builder needs from `@opentui/core`. Threaded
 * through as a parameter so this module's import graph stays type-only
 * (no native binary load at module-evaluation time). Production callers
 * (`src/live-shell.ts`'s paint layer) inject the same exports they
 * already imported for the rest of the scene.
 */
export interface AnsiToStyledRuntime {
  readonly StyledText: new (chunks: TextChunk[]) => StyledText;
  readonly RGBA: { fromHex(hex: string): RGBA };
  readonly TextAttributes: { readonly DIM: number };
}

/**
 * Split an input line on SGR boundaries. Returns one `ParsedSegment`
 * per text run. The parser is forgiving:
 *
 *   - Recognized opens (`96` / `32` / `31` / `33` / `2;37`) start a
 *     new run with the matching bucket.
 *   - Reset (`0`) ends the current run; subsequent text falls back to
 *     `plain` until the next open.
 *   - UNRECOGNIZED SGR sequences (anything else between `\x1b[` and
 *     `m`) are STRIPPED — never emitted as visible bytes. This is the
 *     "no literal garbage" guarantee from the spec.
 *   - A malformed escape with no closing `m` (`\x1b[96` at end of
 *     input, no `m`) is stripped — the parser scans up to the first
 *     `m` and gives up on EOL.
 *   - Adjacent opens (`\x1b[31m\x1b[32m`) switch buckets cleanly —
 *     no implicit reset required.
 *   - Plain text passes through verbatim as one `plain` segment.
 *   - An empty input returns an empty array.
 *
 * Zero-length text runs are dropped — a reset immediately followed by
 * an open produces no segment for the zero-byte span between them.
 *
 * Pure: no opentui imports, no side effects. Tested directly.
 */
export function parseAnsiSegments(line: string): ParsedSegment[] {
  if (line.length === 0) {
    return [];
  }
  const out: ParsedSegment[] = [];
  // `current` is the in-progress run; `kind` is its bucket. We flush
  // when the bucket changes (or when we hit EOL). An empty `current`
  // skips the flush.
  let current = "";
  let kind: SegmentKind = "plain";
  const flush = (): void => {
    if (current.length === 0) return;
    out.push({ kind, text: current });
    current = "";
  };
  let i = 0;
  while (i < line.length) {
    const ch = line[i] as string;
    if (ch !== "\x1b") {
      current += ch;
      i++;
      continue;
    }
    // Escape introducer. Expect `\x1b[` followed by the SGR body and
    // a closing `m`. Anything else (a bare `\x1b`, or `\x1b` + non-
    // `[`, or no `m` before EOL) is stripped: advance past whatever
    // we can identify as the escape and emit no segment for it.
    if (line[i + 1] !== "[") {
      // Bare `\x1b` or `\x1b<other>` — drop just the `\x1b` and let
      // the next iteration handle the trailing byte. Conservative
      // (we don't try to parse non-SGR escapes; board doesn't emit
      // them today).
      i++;
      continue;
    }
    // Scan for the closing `m`. The SGR body lives between `i+2` and
    // the `m` index, exclusive. If no `m` exists before EOL, strip
    // everything from `\x1b` to EOL — same defensive behavior.
    const close = line.indexOf("m", i + 2);
    if (close === -1) {
      // Malformed escape with no terminator. Strip and stop scanning
      // for more text — there's nothing parseable after this.
      break;
    }
    const body = line.slice(i + 2, close);
    // Reset closes the current run and returns to plain. The flush
    // is what emits the current run's segment.
    if (body === "0" || body === "") {
      flush();
      kind = "plain";
      i = close + 1;
      continue;
    }
    // Recognized open. Flush the in-progress run (if any) under its
    // current bucket, then switch buckets — the next character (if
    // any) starts a new run under the new bucket.
    const nextKind = SGR_OPEN_TO_KIND[body];
    if (nextKind !== undefined) {
      flush();
      kind = nextKind;
      i = close + 1;
      continue;
    }
    // Unrecognized SGR (a code outside the six board emits) — strip
    // it. The active bucket DOES NOT change; in-flight text continues
    // accumulating under the previous bucket. This is conservative —
    // we don't introduce a phantom style for an unknown code.
    i = close + 1;
  }
  // Final flush for any tail text that didn't end in a reset.
  flush();
  return out;
}

/**
 * Build the `TextChunk[]` payload for one line. Each parsed segment
 * becomes one chunk; `plain` carries no fg/attributes, the styled
 * buckets carry the matching hex foreground (and DIM for `faded`).
 * Zero-length segments are dropped (defensive — the parser already
 * drops them, but the chunk-builder enforces the invariant at the
 * boundary).
 */
function buildChunks(
  segments: readonly ParsedSegment[],
  runtime: AnsiToStyledRuntime,
): TextChunk[] {
  const chunks: TextChunk[] = [];
  for (const seg of segments) {
    if (seg.text.length === 0) continue;
    if (seg.kind === "plain") {
      chunks.push({ __isChunk: true, text: seg.text });
      continue;
    }
    const fgHex = SEGMENT_FG_HEX[seg.kind];
    const fg = runtime.RGBA.fromHex(fgHex);
    const attributes =
      seg.kind === "faded" ? runtime.TextAttributes.DIM : undefined;
    const chunk: TextChunk = { __isChunk: true, text: seg.text, fg };
    if (attributes !== undefined) {
      chunk.attributes = attributes;
    }
    chunks.push(chunk);
  }
  return chunks;
}

/**
 * Convert one body line to a `StyledText`. Empty input yields an
 * empty `StyledText` (chunks: []). Plain input (no `\x1b`) yields a
 * single `plain` chunk carrying the input verbatim — the chunk-
 * builder's plain path still produces a `TextChunk`, so the call
 * site can always set `.content = styled` without branching.
 */
export function ansiLineToStyled(
  line: string,
  runtime: AnsiToStyledRuntime,
): StyledText {
  const segments = parseAnsiSegments(line);
  const chunks = buildChunks(segments, runtime);
  return new runtime.StyledText(chunks);
}

/**
 * Pure detector for the fast-path. Returns `true` iff any line in the
 * input carries a `\x1b` byte. The paint layer uses this to short-
 * circuit the StyledText construction when the body is fully plain —
 * a `.content = string` assignment is cheaper than building a
 * StyledText with one chunk per line plus `\n` joins between them.
 */
export function linesContainAnsi(lines: readonly string[]): boolean {
  for (const line of lines) {
    if (line.includes("\x1b")) return true;
  }
  return false;
}

/**
 * Build the `TextRenderable.content` payload for a frame body. Returns
 * a plain `\n`-joined string when no line carries any `\x1b` (the
 * fast-path — board's non-TTY emission and every non-board TUI fall
 * through here unchanged). Otherwise builds one `StyledText` whose
 * chunks carry every parsed segment, with `\n` plain chunks bridging
 * adjacent rows so the body reads as a single multi-line block.
 *
 * The empty-input case returns an empty string — matches the existing
 * `rows.join("\n")` behavior for an empty `rows` array.
 *
 * Paint-layer call site: `bodyNode.content = linesToContent(rows,
 * runtime)`. The TextRenderable setter accepts `string | StyledText`
 * natively, so the union return type maps cleanly onto the existing
 * mutation.
 */
export function linesToContent(
  lines: readonly string[],
  runtime: AnsiToStyledRuntime,
): StyledText | string {
  if (lines.length === 0) return "";
  if (!linesContainAnsi(lines)) {
    return lines.join("\n");
  }
  const chunks: TextChunk[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      chunks.push({ __isChunk: true, text: "\n" });
    }
    const line = lines[i] as string;
    const segments = parseAnsiSegments(line);
    chunks.push(...buildChunks(segments, runtime));
  }
  return new runtime.StyledText(chunks);
}

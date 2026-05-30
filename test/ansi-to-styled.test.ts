/**
 * Tests for `src/ansi-to-styled.ts` — the ANSI SGR → OpenTUI StyledText
 * shim. Board (`cli/board.ts`) emits its frame body with raw SGR
 * escape codes embedded in line strings, and OpenTUI renders embedded
 * ANSI as literal garbage. The shim parses each of the six SGR codes
 * board emits into matching OpenTUI styling — these tests are the
 * contract for that conversion.
 *
 * Coverage:
 *  - Pure parser (`parseAnsiSegments`):
 *    1. Each of the six SGR codes is recognized and emits the right
 *       semantic bucket.
 *    2. Bare reset returns to plain.
 *    3. Adjacent / nested segments (open-without-prior-reset).
 *    4. Unrecognized SGR sequences are stripped, never leak as bytes.
 *    5. Malformed escape (no closing `m`) is stripped.
 *    6. Empty input yields an empty array.
 *    7. Plain line passes through as a single `plain` segment.
 *  - StyledText builder (`ansiLineToStyled`):
 *    8. Plain line → one `plain` chunk, no fg/attributes.
 *    9. Each colored bucket → one chunk with the matching fg.
 *   10. `faded` chunk carries the DIM attribute AND a fg.
 *   11. Pill line from board's actual emit shape composes into 3 chunks
 *       (`prefix [` plain + token colored + `]` plain).
 *  - Multi-line helper (`linesToContent`):
 *   12. Empty input → empty string.
 *   13. All-plain input → plain string (fast path, no shim).
 *   14. Mixed input (one colored line + one plain) → StyledText with
 *       `\n` plain chunk bridging the rows.
 *   15. Multi-line all-colored → StyledText with `\n` chunks.
 */

import { expect, test } from "bun:test";
import { RGBA, StyledText, TextAttributes } from "@opentui/core";
import {
  type AnsiToStyledRuntime,
  ansiLineToStyled,
  linesContainAnsi,
  linesToContent,
  parseAnsiSegments,
} from "../src/ansi-to-styled";

// Runtime helper bag the chunk-builder needs from `@opentui/core`. The
// shim test pulls these eagerly the same way `test/live-shell.test.ts`
// does — the OpenTUI native binary is already loaded by the test
// runner's other suites, so the cost is paid once.
const RUNTIME: AnsiToStyledRuntime = {
  StyledText,
  RGBA,
  TextAttributes,
};

// The six SGR opens board.ts emits, mirrored here so the tests pin
// the exact byte sequences the shim consumes.
const SGR = {
  active: "\x1b[96m", // bright cyan
  success: "\x1b[32m", // green
  error: "\x1b[31m", // red
  warn: "\x1b[33m", // yellow
  faded: "\x1b[2;37m", // dim + white
  reset: "\x1b[0m",
} as const;

// ---------------------------------------------------------------------------
// parseAnsiSegments — pure parser
// ---------------------------------------------------------------------------

test("parseAnsiSegments: empty input → []", () => {
  expect(parseAnsiSegments("")).toEqual([]);
});

test("parseAnsiSegments: plain line passes through as one plain segment", () => {
  expect(parseAnsiSegments("hello world")).toEqual([
    { kind: "plain", text: "hello world" },
  ]);
});

test("parseAnsiSegments: each of the six SGR codes maps to the right bucket", () => {
  // Six independent runs — each opens its bucket, writes text, resets.
  const cases: Array<
    ["active" | "success" | "error" | "warn" | "faded", string]
  > = [
    ["active", SGR.active],
    ["success", SGR.success],
    ["error", SGR.error],
    ["warn", SGR.warn],
    ["faded", SGR.faded],
  ];
  for (const [kind, open] of cases) {
    const line = `${open}token${SGR.reset}`;
    expect(parseAnsiSegments(line)).toEqual([{ kind, text: "token" }]);
  }
});

test("parseAnsiSegments: prefix + colored token + suffix yields three segments", () => {
  // Mirrors board's actual pill emit: `  X. Quality audit and close [<sgr>open</sgr>] [pending]`.
  const line = `prefix [${SGR.active}running${SGR.reset}] suffix`;
  expect(parseAnsiSegments(line)).toEqual([
    { kind: "plain", text: "prefix [" },
    { kind: "active", text: "running" },
    { kind: "plain", text: "] suffix" },
  ]);
});

test("parseAnsiSegments: bare reset at start drops to plain (no spurious empty segment)", () => {
  const line = `${SGR.reset}text`;
  expect(parseAnsiSegments(line)).toEqual([{ kind: "plain", text: "text" }]);
});

test("parseAnsiSegments: adjacent opens switch buckets without an explicit reset", () => {
  // `\x1b[31m\x1b[32mtext\x1b[0m` — red open immediately followed by
  // green open. The shim should switch buckets cleanly. Text after
  // both opens carries the LATER bucket (green).
  const line = `${SGR.error}${SGR.success}text${SGR.reset}`;
  expect(parseAnsiSegments(line)).toEqual([{ kind: "success", text: "text" }]);
});

test("parseAnsiSegments: nested-style boundaries (red text + green text + plain)", () => {
  const line = `${SGR.error}red${SGR.reset}-${SGR.success}green${SGR.reset}-tail`;
  expect(parseAnsiSegments(line)).toEqual([
    { kind: "error", text: "red" },
    { kind: "plain", text: "-" },
    { kind: "success", text: "green" },
    { kind: "plain", text: "-tail" },
  ]);
});

test("parseAnsiSegments: unrecognized SGR (e.g. 35 magenta) is stripped, NOT passed through", () => {
  // `35m` is magenta — board doesn't emit it; the shim should drop it
  // entirely and the text after it stays plain (the active bucket
  // does NOT change because there was no prior open).
  const line = `\x1b[35mmagenta?${SGR.reset}`;
  expect(parseAnsiSegments(line)).toEqual([
    { kind: "plain", text: "magenta?" },
  ]);
});

test("parseAnsiSegments: malformed escape with no closing `m` is stripped, halts parsing", () => {
  // `\x1b[96` followed by EOL with no terminator — the shim should
  // drop everything from the escape onward (defensive). The text
  // BEFORE the escape stays.
  const line = `before\x1b[96`;
  expect(parseAnsiSegments(line)).toEqual([{ kind: "plain", text: "before" }]);
});

test("parseAnsiSegments: bare `\\x1b` (no `[`) is stripped, surrounding text preserved", () => {
  const line = `a\x1bb`;
  expect(parseAnsiSegments(line)).toEqual([{ kind: "plain", text: "ab" }]);
});

test("parseAnsiSegments: faded bucket recognized for composite `2;37` body", () => {
  const line = `${SGR.faded}fade${SGR.reset}`;
  expect(parseAnsiSegments(line)).toEqual([{ kind: "faded", text: "fade" }]);
});

test("parseAnsiSegments: tail text without closing reset still flushes as the active bucket", () => {
  // `\x1b[31mred-without-reset` — board always closes its opens with
  // a reset, but the parser should be defensive: any tail text under
  // the active bucket still emits as that bucket.
  const line = `${SGR.error}red-without-reset`;
  expect(parseAnsiSegments(line)).toEqual([
    { kind: "error", text: "red-without-reset" },
  ]);
});

// ---------------------------------------------------------------------------
// ansiLineToStyled — chunk builder
// ---------------------------------------------------------------------------

test("ansiLineToStyled: plain line → one plain chunk with no fg/attributes", () => {
  const styled = ansiLineToStyled("just text", RUNTIME);
  expect(styled.chunks).toHaveLength(1);
  const chunk = styled.chunks[0];
  expect(chunk?.text).toBe("just text");
  expect(chunk?.fg).toBeUndefined();
  expect(chunk?.attributes).toBeUndefined();
});

test("ansiLineToStyled: empty input → StyledText with no chunks", () => {
  const styled = ansiLineToStyled("", RUNTIME);
  expect(styled.chunks).toEqual([]);
});

test("ansiLineToStyled: each colored bucket → one chunk with a defined fg", () => {
  // The hex map is internal; what we assert is "every styled bucket
  // produces a chunk carrying an fg color". We don't pin the exact
  // RGBA bytes — that's an implementation detail of the hex palette.
  for (const open of [SGR.active, SGR.success, SGR.error, SGR.warn]) {
    const styled = ansiLineToStyled(`${open}x${SGR.reset}`, RUNTIME);
    expect(styled.chunks).toHaveLength(1);
    const chunk = styled.chunks[0];
    expect(chunk?.text).toBe("x");
    expect(chunk?.fg).toBeDefined();
    // Non-faded buckets carry NO DIM attribute.
    expect(chunk?.attributes).toBeUndefined();
  }
});

test("ansiLineToStyled: faded bucket carries DIM attribute AND a fg", () => {
  const styled = ansiLineToStyled(`${SGR.faded}dim${SGR.reset}`, RUNTIME);
  expect(styled.chunks).toHaveLength(1);
  const chunk = styled.chunks[0];
  expect(chunk?.text).toBe("dim");
  expect(chunk?.fg).toBeDefined();
  expect(chunk?.attributes).toBe(TextAttributes.DIM);
});

test("ansiLineToStyled: board-shape pill line → 3 chunks (plain, colored, plain)", () => {
  // Board's exact emit shape (one of `colorizePillsInLine`'s outputs):
  // `prefix [<sgr-cyan>running</sgr>] suffix`.
  const line = `prefix [${SGR.active}running${SGR.reset}] suffix`;
  const styled = ansiLineToStyled(line, RUNTIME);
  expect(styled.chunks).toHaveLength(3);
  expect(styled.chunks[0]?.text).toBe("prefix [");
  expect(styled.chunks[0]?.fg).toBeUndefined();
  expect(styled.chunks[1]?.text).toBe("running");
  expect(styled.chunks[1]?.fg).toBeDefined();
  expect(styled.chunks[2]?.text).toBe("] suffix");
  expect(styled.chunks[2]?.fg).toBeUndefined();
});

// ---------------------------------------------------------------------------
// linesContainAnsi / linesToContent — multi-line orchestration
// ---------------------------------------------------------------------------

test("linesContainAnsi: empty / all-plain → false", () => {
  expect(linesContainAnsi([])).toBe(false);
  expect(linesContainAnsi(["plain", "more plain"])).toBe(false);
});

test("linesContainAnsi: any single line with `\\x1b` → true", () => {
  expect(linesContainAnsi(["plain", `${SGR.active}x${SGR.reset}`])).toBe(true);
  expect(linesContainAnsi([`${SGR.faded}faded${SGR.reset}`])).toBe(true);
});

test("linesToContent: empty input → '' (matches old rows.join behavior)", () => {
  expect(linesToContent([], RUNTIME)).toBe("");
});

test("linesToContent: all-plain input → plain string fast path (no StyledText)", () => {
  const out = linesToContent(["alpha", "beta", "gamma"], RUNTIME);
  expect(out).toBe("alpha\nbeta\ngamma");
});

test("linesToContent: any ANSI in any line → StyledText with `\\n` bridging chunks", () => {
  const lines = [
    `${SGR.error}red${SGR.reset}`,
    "plain middle",
    `${SGR.success}green${SGR.reset}`,
  ];
  const out = linesToContent(lines, RUNTIME);
  // Type assertion via `instanceof` — StyledText is the OpenTUI class.
  expect(out).toBeInstanceOf(StyledText);
  // Reconstruct the rendered text from the chunks to verify the
  // shape: `red\nplain middle\ngreen`.
  if (!(out instanceof StyledText)) {
    throw new Error("expected StyledText");
  }
  const reconstructed = out.chunks.map((c) => c.text).join("");
  expect(reconstructed).toBe("red\nplain middle\ngreen");
  // Five chunks: red + \n + plain-middle + \n + green.
  expect(out.chunks).toHaveLength(5);
  expect(out.chunks[0]?.fg).toBeDefined(); // red has fg
  expect(out.chunks[1]?.text).toBe("\n"); // bridge
  expect(out.chunks[1]?.fg).toBeUndefined(); // bridge is plain
  expect(out.chunks[2]?.text).toBe("plain middle"); // plain
  expect(out.chunks[2]?.fg).toBeUndefined();
  expect(out.chunks[3]?.text).toBe("\n"); // bridge
  expect(out.chunks[4]?.fg).toBeDefined(); // green has fg
});

test("linesToContent: single-line ANSI → StyledText (no extra `\\n` chunk)", () => {
  const out = linesToContent([`${SGR.warn}warn${SGR.reset}`], RUNTIME);
  expect(out).toBeInstanceOf(StyledText);
  if (!(out instanceof StyledText)) {
    throw new Error("expected StyledText");
  }
  expect(out.chunks).toHaveLength(1);
  expect(out.chunks[0]?.text).toBe("warn");
});

test("linesToContent: round-trip reconstructed text matches the input minus SGR bytes", () => {
  // Sanity round-trip: parse each of the six SGR opens followed by a
  // token, join with `\n`, reconstruct the chunk text — should be the
  // tokens joined with `\n` (escape bytes gone).
  const lines = [
    `${SGR.active}A${SGR.reset}`,
    `${SGR.success}B${SGR.reset}`,
    `${SGR.error}C${SGR.reset}`,
    `${SGR.warn}D${SGR.reset}`,
    `${SGR.faded}E${SGR.reset}`,
  ];
  const out = linesToContent(lines, RUNTIME);
  expect(out).toBeInstanceOf(StyledText);
  if (!(out instanceof StyledText)) {
    throw new Error("expected StyledText");
  }
  const reconstructed = out.chunks.map((c) => c.text).join("");
  expect(reconstructed).toBe("A\nB\nC\nD\nE");
});

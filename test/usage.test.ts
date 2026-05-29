/**
 * Pure-function tests for `scripts/usage.ts`'s `renderRowLines` helper.
 *
 * `renderRowLines` consumes the daemon-side `usage` collection rows and
 * renders a stacked block per agentuse profile: a header line carrying
 * the id chip + target/multiplier chip, then one indented body line per
 * quota window (session / week / sonnet-where-present). Each body line
 * is `label [bar] pct rel` — a 30-wide ASCII bar (`█`/`░`) followed by
 * the numeric pct and a bare relative reset time. Future times render
 * without an `in ` prefix (`3h 5m` / `5m` / `now`) since the column
 * context makes the direction unambiguous; past times keep `2m ago`.
 *
 * `nowMs` is an explicit parameter so tests can drive deterministic
 * snapshots — the live script passes `Date.now()` from both the
 * data-change emit and the 30s tick.
 *
 * The renderer returns body-only lines — the script title (`"usage"`)
 * is rendered by the live-shell banner, not the row body.
 */

import { expect, test } from "bun:test";
import { renderProfileLines, renderRowLines } from "../scripts/usage";

// Fixed reference clock: 2025-01-15T12:00:00.000Z.
const NOW_MS = Date.parse("2025-01-15T12:00:00.000Z");

function isoOffset(minutes: number): string {
  return new Date(NOW_MS + minutes * 60_000).toISOString();
}

/** Find the body line whose label starts with `label` (after the indent). */
function bodyLine(lines: string[], label: string): string {
  const match = lines.find((l) => l.trimStart().startsWith(`${label} `));
  expect(match, `expected a body line for "${label}"`).toBeDefined();
  return match as string;
}

test("renders future reset times with space-separated units", () => {
  const lines = renderRowLines(
    [
      {
        id: "primary",
        target: "opus",
        multiplier: 2,
        session_percent: 42,
        session_resets_at: isoOffset(5), // 5 minutes ahead
        week_percent: 17,
        week_resets_at: isoOffset(185), // 3h 5m ahead
      },
    ],
    NOW_MS,
  );
  // header + session + week
  expect(lines).toHaveLength(3);
  expect(bodyLine(lines, "session")).toMatch(/ 5m$/);
  expect(bodyLine(lines, "week")).toMatch(/ 3h 5m$/);
  // 42% → round(12.6) = 13 of 30 filled; 17% → round(5.1) = 5 of 30
  // filled. Bar is fixed 32-col `[<30 cells>]`; pct cell padStarts to
  // wPct (here 3).
  expect(bodyLine(lines, "session")).toContain(
    "session [█████████████░░░░░░░░░░░░░░░░░] 42%",
  );
  expect(bodyLine(lines, "week")).toContain(
    "week    [█████░░░░░░░░░░░░░░░░░░░░░░░░░] 17%",
  );
});

test("renders the round boundary as 'now'", () => {
  const lines = renderRowLines(
    [
      {
        id: "p",
        target: "sonnet",
        multiplier: 1,
        session_percent: 0,
        session_resets_at: isoOffset(0),
        week_percent: 0,
        week_resets_at: isoOffset(0),
      },
    ],
    NOW_MS,
  );
  expect(bodyLine(lines, "session")).toMatch(/ now$/);
  expect(bodyLine(lines, "week")).toMatch(/ now$/);
});

test("renders past reset times with the 'ago' suffix and spaced units", () => {
  // Defensive: reset times should be in the future, but a stale
  // projection or clock skew could surface a past timestamp. Render
  // it honestly rather than swallowing.
  const lines = renderRowLines(
    [
      {
        id: "p",
        target: "opus",
        multiplier: 1,
        session_percent: 99,
        session_resets_at: isoOffset(-2),
        week_percent: 50,
        week_resets_at: isoOffset(-125),
      },
    ],
    NOW_MS,
  );
  expect(bodyLine(lines, "session")).toMatch(/ 2m ago$/);
  expect(bodyLine(lines, "week")).toMatch(/ 2h 5m ago$/);
});

test("collapses to days at the day boundary; drops residual minutes", () => {
  // ≥ 1d branch: format is `Nd Mh` (residual minutes dropped — at the
  // day scale, minute precision is noise). At exactly 24h the hour
  // residual is zero so the output collapses to `1d`.
  const lines = renderRowLines(
    [
      {
        id: "a",
        target: "opus",
        multiplier: 1,
        session_percent: 0,
        session_resets_at: isoOffset(24 * 60), // exactly 1 day
        week_percent: 0,
        week_resets_at: isoOffset(141 * 60 + 16), // 141h 16m → 5d 21h
      },
    ],
    NOW_MS,
  );
  expect(bodyLine(lines, "session")).toMatch(/ 1d$/);
  expect(bodyLine(lines, "week")).toMatch(/ 5d 21h$/);
});

test("collapses to weeks at the week boundary; drops residual hours", () => {
  // ≥ 1w branch: format is `Nw Md`. At exactly 7d the day residual is
  // zero so the output collapses to `1w`; 8d8h rounds to `1w 1d` (the
  // 8 hours drop because at week scale they're noise).
  const lines = renderRowLines(
    [
      {
        id: "a",
        target: "opus",
        multiplier: 1,
        session_percent: 0,
        session_resets_at: isoOffset(7 * 24 * 60), // exactly 1 week
        week_percent: 0,
        week_resets_at: isoOffset(8 * 24 * 60 + 8 * 60), // 8d 8h → 1w 1d
      },
    ],
    NOW_MS,
  );
  expect(bodyLine(lines, "session")).toMatch(/ 1w$/);
  expect(bodyLine(lines, "week")).toMatch(/ 1w 1d$/);
});

test("malformed ISO falls through unchanged (no throw)", () => {
  // `Date.parse` returns NaN for unparseable strings; the helper must
  // degrade to the raw value rather than throw inside the render hot
  // path. The 30s tick can't afford to crash on a single bad row.
  const lines = renderRowLines(
    [
      {
        id: "p",
        target: "opus",
        multiplier: 1,
        session_percent: 10,
        session_resets_at: "not-an-iso",
        week_percent: 10,
        week_resets_at: "",
      },
    ],
    NOW_MS,
  );
  // Bad ISO → raw value as the trailing rel-cell; empty ISO → no
  // trailing rel at all (renderBody drops the trailing space when
  // rel is empty, so the line ends at the pct cell).
  expect(bodyLine(lines, "session")).toMatch(/ not-an-iso$/);
  expect(bodyLine(lines, "week")).toMatch(/ 10%$/);
});

test("rounds to the nearest minute (30s window)", () => {
  // A reset that's 30s away should round up to "in 1m"; one that's
  // 29s away rounds to "now". This is the contract that justifies the
  // 30s tick interval — half-minute lag at worst.
  const at30s = new Date(NOW_MS + 30_000).toISOString();
  const at29s = new Date(NOW_MS + 29_000).toISOString();
  const lines = renderRowLines(
    [
      {
        id: "a",
        target: "opus",
        multiplier: 1,
        session_percent: 0,
        session_resets_at: at30s,
        week_percent: 0,
        week_resets_at: at29s,
      },
    ],
    NOW_MS,
  );
  expect(bodyLine(lines, "session")).toMatch(/ 1m$/);
  expect(bodyLine(lines, "week")).toMatch(/ now$/);
});

test("empty row set returns an empty array", () => {
  expect(renderRowLines([], NOW_MS)).toEqual([]);
});

test("widest-id padding right-aligns the header id segment", () => {
  const lines = renderRowLines(
    [
      {
        id: "a",
        target: "opus",
        multiplier: 1,
        session_percent: 1,
        session_resets_at: isoOffset(1),
        week_percent: 1,
        week_resets_at: isoOffset(1),
      },
      {
        id: "longer-id",
        target: "opus",
        multiplier: 1,
        session_percent: 1,
        session_resets_at: isoOffset(1),
        week_percent: 1,
        week_resets_at: isoOffset(1),
      },
    ],
    NOW_MS,
  );
  // Each row stacks 3 lines (header + session + week). Headers are at
  // indices 0 and 3. `(a)` padStart-aligns to the wider `(longer-id)`
  // width so the closing `)` stamps at the same column on both header
  // lines; body lines indent past that column to the chip's `[`.
  expect(lines).toHaveLength(6);
  expect(lines[0].startsWith("        (a) ")).toBe(true);
  expect(lines[3].startsWith("(longer-id) ")).toBe(true);
});

test("body indent aligns labels under the chip's `[`", () => {
  // Body lines indent by `wId + 1` spaces so the label column starts
  // directly under the `[` of the target/multiplier chip on the header.
  const lines = renderRowLines(
    [
      {
        id: "claude-multi-3",
        target: "claude",
        multiplier: 20,
        session_percent: 16,
        session_resets_at: isoOffset(29),
        week_percent: 36,
        week_resets_at: isoOffset(4 * 24 * 60 + 5 * 60),
      },
    ],
    NOW_MS,
  );
  // `(claude-multi-3)` = 16 chars, then a space, then `[` at col 17 (0-idx).
  // Body lines begin with 17 spaces of indent, then the label.
  const header = lines[0];
  const bracket = header.indexOf("[");
  expect(bracket).toBe(17);
  const sessionRow = bodyLine(lines, "session");
  expect(sessionRow.indexOf("session")).toBe(bracket);
});

test("sonnet body line appears only on rows with sonnet_week data", () => {
  // Rows without sonnet data simply omit the sonnet body line — no
  // empty placeholder. Label width still aligns pct values across all
  // rendered body lines.
  const lines = renderRowLines(
    [
      {
        id: "codex",
        target: "codex",
        multiplier: 1,
        session_percent: 27,
        session_resets_at: isoOffset(60),
        week_percent: 77,
        week_resets_at: isoOffset(3 * 24 * 60),
        sonnet_week_percent: null,
        sonnet_week_resets_at: null,
      },
      {
        id: "claude-default",
        target: "claude",
        multiplier: 5,
        session_percent: 10,
        session_resets_at: isoOffset(60),
        week_percent: 17,
        week_resets_at: isoOffset(5 * 24 * 60),
        sonnet_week_percent: 2,
        sonnet_week_resets_at: isoOffset(5 * 24 * 60),
      },
    ],
    NOW_MS,
  );
  // codex block has 3 lines (header + session + week); claude block has
  // 4 (header + session + week + sonnet). Total = 7.
  expect(lines).toHaveLength(7);
  // No sonnet line anywhere in the codex block (the first 3 lines).
  expect(lines.slice(0, 3).join("\n")).not.toContain("sonnet");
  // claude block carries a sonnet body line with the proper format.
  const claudeBlock = lines.slice(3).join("\n");
  expect(claudeBlock).toContain("sonnet");
  const sonnetRow = lines.find((l) => l.trimStart().startsWith("sonnet "));
  expect(sonnetRow ?? "").toMatch(/ 5d$/);
});

test("label padding widens to 'sonnet' only when sonnet rows exist", () => {
  // No sonnet → labels pool is {session, week} → widest = 7
  // ("session"). `week` padEnd(7) leaves 3 trailing spaces.
  const sansSonnet = renderRowLines(
    [
      {
        id: "a",
        target: "opus",
        multiplier: 1,
        session_percent: 5,
        session_resets_at: isoOffset(5),
        week_percent: 5,
        week_resets_at: isoOffset(5),
      },
    ],
    NOW_MS,
  );
  // `week` padEnd(7) + " " + bar + " " + `5%` padStart(2 — the wPct in
  // this single-digit row set) → `week    [<bar>] 5%`. Four spaces
  // between `week` and the bar's `[` (3 from padEnd + 1 separator);
  // one space between bar's `]` and the pct cell. 5% → round(1.5) =
  // 2 of 30 cells filled.
  expect(bodyLine(sansSonnet, "week")).toContain(
    "week    [██░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 5%",
  );

  // With sonnet → labels pool gains "sonnet"; widest still 7
  // ("session" beats "sonnet" by 1). wPct is still 2 here.
  const withSonnet = renderRowLines(
    [
      {
        id: "a",
        target: "claude",
        multiplier: 1,
        session_percent: 5,
        session_resets_at: isoOffset(5),
        week_percent: 5,
        week_resets_at: isoOffset(5),
        sonnet_week_percent: 5,
        sonnet_week_resets_at: isoOffset(5),
      },
    ],
    NOW_MS,
  );
  expect(bodyLine(withSonnet, "week")).toContain(
    "week    [██░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 5%",
  );
  // `sonnet` padEnd(7) leaves 1 trailing space; +1 separator → 2 spaces
  // between `sonnet` and the bar's `[`.
  expect(bodyLine(withSonnet, "sonnet")).toContain(
    "sonnet  [██░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 5%",
  );
});

test("pct cells right-align to the widest pct across all body lines", () => {
  // A 100%-bearing row should push every body pct cell to 4-char width
  // (`100%`), even on rows whose own pct values are 1-2 digits. This
  // keeps the `%` column aligned across the whole frame.
  const lines = renderRowLines(
    [
      {
        id: "max",
        target: "claude",
        multiplier: 1,
        session_percent: 100,
        session_resets_at: isoOffset(10),
        week_percent: 9,
        week_resets_at: isoOffset(10),
      },
      {
        id: "low",
        target: "claude",
        multiplier: 1,
        session_percent: 3,
        session_resets_at: isoOffset(10),
        week_percent: 8,
        week_resets_at: isoOffset(10),
      },
    ],
    NOW_MS,
  );
  // `100%` sets the column width; smaller pcts padStart to match. The
  // bar is fixed 12-col so the pct column starts at a uniform offset;
  // padStart(4) gives "100%" / "  3%" / "  9%" / "  8%", which in the
  // body line lands as `] 100%` / `]   3%` etc. — `]` from the bar's
  // closing bracket + 1 separator + the padStart-padded pct.
  const sessionRows = lines.filter((l) => l.trimStart().startsWith("session "));
  const weekRows = lines.filter((l) => l.trimStart().startsWith("week "));
  expect(sessionRows[0]).toContain("] 100%");
  expect(sessionRows[1]).toContain("]   3%");
  expect(weekRows[0]).toContain("]   9%");
  expect(weekRows[1]).toContain("]   8%");
});

// ---------------------------------------------------------------------------
// renderProfileLines — the "Rate limits by profile" block. Driven by the
// `profiles` collection (one row per Claude profile keyed by `config_dir`,
// with `last_rate_limit_at` as REAL unix-SECONDS).
// ---------------------------------------------------------------------------

const NOW_SEC = Math.floor(NOW_MS / 1000);

test("renders one row per profile with relative time or em-dash", () => {
  // Three rows: one default-sentinel with a recent rate limit (5m ago),
  // one explicit config_dir with an older rate limit (3h 12m ago), and one
  // that has NEVER hit a rate limit (NULL last_rate_limit_at → `—`).
  const lines = renderProfileLines(
    [
      {
        config_dir: "",
        last_rate_limit_at: NOW_SEC - 5 * 60,
        last_rate_limit_session_id: "s1",
      },
      {
        config_dir: "~/.claude-profiles/multi-claude-3",
        last_rate_limit_at: NOW_SEC - (3 * 3600 + 12 * 60),
        last_rate_limit_session_id: "s2",
      },
      {
        config_dir: "~/.claude-profiles/quiet-one",
        last_rate_limit_at: null,
        last_rate_limit_session_id: null,
      },
    ],
    NOW_MS,
  );
  // Header line + 3 profile rows.
  expect(lines).toHaveLength(4);
  expect(lines[0]).toBe("Rate limits by profile");
  // `''` sentinel renders as the `(default)` literal — NOT empty parens
  // (which would read as "missing data"). The default profile is a
  // known-correct value here, not absence.
  const defaultRow = lines.find((l) => l.startsWith("(default)"));
  expect(defaultRow, "expected a (default) row").toBeDefined();
  expect(defaultRow as string).toMatch(/ 5m ago$/);
  // Explicit config_dir wraps in parens like the usage block's id chip.
  const multi = lines.find((l) =>
    l.startsWith("(~/.claude-profiles/multi-claude-3)"),
  );
  expect(multi, "expected an explicit-config_dir row").toBeDefined();
  expect(multi as string).toMatch(/ 3h 12m ago$/);
  // NULL last_rate_limit_at renders the em-dash — no raw-float leakage,
  // no whitespace at end-of-line.
  const quiet = lines.find((l) =>
    l.startsWith("(~/.claude-profiles/quiet-one)"),
  );
  expect(quiet, "expected a quiet (null) row").toBeDefined();
  expect(quiet as string).toMatch(/ —$/);
});

test("unix-seconds input renders as relative time (no raw-float leakage)", () => {
  // The `profiles.last_rate_limit_at` column is REAL unix-SECONDS to match
  // `jobs.last_api_error_at` (the source-of-truth for the projection).
  // Feeding it straight into `relTime` would do `Date.parse` and yield NaN,
  // leaking the raw float into the rendered text. The numeric variant
  // routes through `relTimeFromUnixSec` so the rendered cell is the same
  // minute-rounded prose as the usage block's reset times.
  const lines = renderProfileLines(
    [
      {
        config_dir: "p1",
        last_rate_limit_at: NOW_SEC - 120, // 2 minutes ago
      },
    ],
    NOW_MS,
  );
  const row = lines[1];
  expect(row).toMatch(/ 2m ago$/);
  // Defensive: no raw float anywhere in the rendered text.
  expect(row).not.toMatch(/\d+\.\d+/);
});

test("chip column padEnds to the widest profile so relative times align", () => {
  // `(default)` (9 chars) and `(longer-config-dir)` (19 chars) should
  // padEnd to the widest, leaving the relative-time column flush across
  // all rows.
  const lines = renderProfileLines(
    [
      { config_dir: "", last_rate_limit_at: NOW_SEC - 60 },
      { config_dir: "longer-config-dir", last_rate_limit_at: NOW_SEC - 60 },
    ],
    NOW_MS,
  );
  // chips: "(default)" (9), "(longer-config-dir)" (19) — widest = 19. Then
  // a single separator space, then the rel-time.
  const defaultRow = lines.find((l) => l.startsWith("(default)"));
  expect(defaultRow, "expected a (default) row").toBeDefined();
  // padEnd(19) on "(default)" (length 9) = 10 trailing spaces, then " 1m ago".
  expect(defaultRow as string).toBe(`(default)${" ".repeat(10)} 1m ago`);
});

test("empty row set returns an empty array", () => {
  expect(renderProfileLines([], NOW_MS)).toEqual([]);
});

test("renders 'now' at the round boundary for unix-seconds input", () => {
  // A unix-seconds input within 30s of `nowMs` rounds to the same minute
  // and renders as "now" — the same contract as `relTime`'s ISO callers,
  // shared via `relTimeFromMs`.
  const lines = renderProfileLines(
    [
      {
        config_dir: "p1",
        last_rate_limit_at: NOW_SEC, // exact now
      },
    ],
    NOW_MS,
  );
  expect(lines[1]).toMatch(/ now$/);
});

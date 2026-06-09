/**
 * Pure-function tests for `cli/usage.ts`'s `renderRowLines` helper.
 *
 * `renderRowLines` consumes the daemon-side `usage` collection rows and
 * renders a stacked block per agentuse profile: a header line carrying
 * the id chip + target/multiplier chip, then one indented body line per
 * quota window (session / week / sonnet-where-present). Each body line
 * is `label [bar] pct rel` — a 30-wide ASCII bar (`█`/`░`) followed by
 * the numeric pct and a bare relative reset countdown. Future times
 * render without an `in ` prefix (`3h 5m` / `5m` / `now`) since the
 * column context makes the direction unambiguous; a reset that has
 * slipped past (only ever a stale row) collapses to `now`, never a
 * misleading `<rel> ago` (the forward-only guard).
 *
 * `nowMs` is an explicit parameter so tests can drive deterministic
 * snapshots — the live script passes `Date.now()` from both the
 * data-change emit and the 30s tick.
 *
 * The renderer returns body-only lines — the script title (`"usage"`)
 * is rendered by the live-shell banner, not the row body.
 */

import { expect, test } from "bun:test";
import { renderRowLines, renderSessionLines } from "../cli/usage";

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

test("collapses a past reset countdown to 'now', never '<rel> ago'", () => {
  // A reset cell is a strictly-forward countdown — agentuse always resolves
  // `*_resets_at` into the future at scrape time, so a past timestamp is a
  // STALE countdown (envelope didn't refresh past the boundary), not an
  // elapsed event. The forward-only guard collapses it to "now" rather than
  // rendering the misleading "<rel> ago" (an age label on an "until" value).
  // Staleness itself is surfaced separately by the `stale Nm` line.
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
  expect(bodyLine(lines, "session")).toMatch(/ now$/);
  expect(bodyLine(lines, "week")).toMatch(/ now$/);
  expect(bodyLine(lines, "session")).not.toMatch(/ago/);
  expect(bodyLine(lines, "week")).not.toMatch(/ago/);
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
// Colocated rate-limit line (schema v35 / fn-642). `usage` rows now carry
// `last_rate_limit_at` (REAL unix-SECONDS) inline; `renderRowLines` emits a
// `rate-limited <rel>` line under the quota lines for tracked stacks that
// have been rate-limited, omits the line for never-limited rows and for the
// codex stack (which has no rate-limit concept), and untracked profiles do
// not render at all (they have no `usage` row).
// ---------------------------------------------------------------------------

const NOW_SEC = Math.floor(NOW_MS / 1000);

/** Find the body line whose label starts with `label` (after the indent),
 *  matching the literal label exactly (handles dashed labels like
 *  `rate-limited`; the bodyLine helper above appends a trailing space). */
function bodyLineExact(lines: string[], label: string): string | undefined {
  return lines.find((l) => l.trimStart().startsWith(`${label} `));
}

test("emits 'rate-limited for <rel>' when rate_limit_lifts_at is known and future (v41)", () => {
  // Schema v41 (fn-651): the rate-limited line is a forward-looking lift
  // countdown. A tracked stack with a known future `rate_limit_lifts_at`
  // renders `rate-limited for <rel>` — never the fired-time
  // `last_rate_limit_at`.
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
        last_rate_limit_at: NOW_SEC - (3 * 3600 + 12 * 60),
        last_rate_limit_session_id: "s2",
        // Lift in 1h 2m.
        rate_limit_lifts_at: isoOffset(62),
      },
    ],
    NOW_MS,
  );
  // header + session + week + rate-limited = 4 lines.
  expect(lines).toHaveLength(4);
  const row = bodyLineExact(lines, "rate-limited");
  expect(row, "expected a rate-limited line").toBeDefined();
  expect(row as string).toMatch(/ for 1h 2m$/);
  // Defensive: never a fallback to the fired-time "ago" rendering.
  expect(row as string).not.toMatch(/ ago$/);
});

test("renders 'rate-limited n/a' when rate_limit_lifts_at is NULL (v41)", () => {
  // The lift column is NULL → render the explicit `n/a` token, not the
  // fired-time fallback.
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
        last_rate_limit_at: NOW_SEC - (3 * 3600 + 12 * 60),
        last_rate_limit_session_id: "s2",
        rate_limit_lifts_at: null,
      },
    ],
    NOW_MS,
  );
  const row = bodyLineExact(lines, "rate-limited") as string;
  expect(row).toMatch(/ n\/a$/);
  expect(row).not.toMatch(/ ago$/);
});

test("renders 'rate-limited n/a' when rate_limit_lifts_at is in the past (v41 guard)", () => {
  // Past-reset guard: `relTime` would otherwise render "<rel> ago" for a
  // past lift instant — the rate-limited line MUST intercept that and
  // render `n/a` instead. Lift was 2h ago.
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
        last_rate_limit_at: NOW_SEC - (3 * 3600 + 12 * 60),
        last_rate_limit_session_id: "s2",
        rate_limit_lifts_at: isoOffset(-120),
      },
    ],
    NOW_MS,
  );
  const row = bodyLineExact(lines, "rate-limited") as string;
  expect(row).toMatch(/ n\/a$/);
  expect(row).not.toMatch(/ ago$/);
});

test("omits the rate-limited line when last_rate_limit_at is NULL", () => {
  // A tracked stack with no rate-limit annotation renders no
  // `rate-limited` line at all — no `—` placeholder.
  const lines = renderRowLines(
    [
      {
        id: "claude-default",
        target: "claude",
        multiplier: 5,
        session_percent: 10,
        session_resets_at: isoOffset(60),
        week_percent: 17,
        week_resets_at: isoOffset(5 * 24 * 60),
        last_rate_limit_at: null,
        last_rate_limit_session_id: null,
      },
    ],
    NOW_MS,
  );
  // header + session + week only.
  expect(lines).toHaveLength(3);
  expect(bodyLineExact(lines, "rate-limited")).toBeUndefined();
  // And no leaked em-dash or `rate-limited` literal anywhere.
  expect(lines.join("\n")).not.toContain("rate-limited");
  expect(lines.join("\n")).not.toContain("—");
});

test("omits the rate-limited line for the codex stack", () => {
  // The codex stack has no rate-limit concept; even if a non-null
  // `last_rate_limit_at` were on the wire (it shouldn't be), the
  // renderer must suppress the line.
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
        // Defensive: a wire bug delivering a non-null limit should still
        // not render for codex.
        last_rate_limit_at: NOW_SEC - 60,
      },
    ],
    NOW_MS,
  );
  expect(lines).toHaveLength(3);
  expect(bodyLineExact(lines, "rate-limited")).toBeUndefined();
  expect(lines.join("\n")).not.toContain("rate-limited");
});

test("rate-limited line indent + label-padding align under the chip", () => {
  // The rate-limited body line shares the same indent (`wId + 1` spaces,
  // landing under the chip's `[`) as the quota lines, and pads its label
  // to the widest of the labels actually rendered. With `rate-limited`
  // in the pool (12 chars), `session` (7) padEnds to 12, so the quota
  // labels gain trailing whitespace to keep their bars aligned under
  // the rate-limited row's rel-time column position.
  const lines = renderRowLines(
    [
      {
        id: "claude-multi-3",
        target: "claude",
        multiplier: 20,
        session_percent: 5,
        session_resets_at: isoOffset(5),
        week_percent: 5,
        week_resets_at: isoOffset(5),
        last_rate_limit_at: NOW_SEC - 5 * 60,
        // v41: a known future lift renders `rate-limited for <rel>`;
        // a 5m offset round-trips to body "5m" so the trailing tail
        // is "for 5m".
        rate_limit_lifts_at: isoOffset(5),
      },
    ],
    NOW_MS,
  );
  const header = lines[0];
  const bracket = header.indexOf("[");
  expect(bracket).toBe("(claude-multi-3)".length + 1);
  const rl = bodyLineExact(lines, "rate-limited") as string;
  // The rate-limited literal lands at the chip's `[` column.
  expect(rl.indexOf("rate-limited")).toBe(bracket);
  // `rate-limited` is 12 chars (the widest label here), padEnd(12) leaves
  // zero trailing spaces; one separator space precedes the lift-countdown
  // body `for 5m`.
  expect(rl).toBe(`${" ".repeat(bracket)}rate-limited for 5m`);
  // Quota labels are padded to width 12 too so they share the column
  // landing; session is 7 → 5 trailing spaces, week is 4 → 8 trailing.
  const session = bodyLineExact(lines, "session") as string;
  expect(
    session.startsWith(`${" ".repeat(bracket)}session${" ".repeat(5)} [`),
  ).toBe(true);
  const week = bodyLineExact(lines, "week") as string;
  expect(week.startsWith(`${" ".repeat(bracket)}week${" ".repeat(8)} [`)).toBe(
    true,
  );
});

test("label padding ignores 'rate-limited' when no row renders one", () => {
  // Mirror of the existing label-padding test: `rate-limited` must only
  // join the label-width pool when at least one row will render that
  // line, so a limit-less screen keeps its quota labels at width 7
  // (`session`) rather than 12 (`rate-limited`).
  const lines = renderRowLines(
    [
      {
        id: "a",
        target: "opus",
        multiplier: 1,
        session_percent: 5,
        session_resets_at: isoOffset(5),
        week_percent: 5,
        week_resets_at: isoOffset(5),
        last_rate_limit_at: null,
      },
    ],
    NOW_MS,
  );
  expect(bodyLine(lines, "week")).toContain(
    "week    [██░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 5%",
  );
});

test("rate-limited line absent when last_rate_limit_at is NULL even if lift is set", () => {
  // The presence-gate is still `last_rate_limit_at` (the v35 fired-time —
  // proof the row has ever been rate-limited). A future lift without an
  // underlying fired-time renders no rate-limited line at all.
  const lines = renderRowLines(
    [
      {
        id: "p1",
        target: "claude",
        multiplier: 1,
        session_percent: 10,
        session_resets_at: isoOffset(10),
        week_percent: 10,
        week_resets_at: isoOffset(10),
        last_rate_limit_at: null,
        rate_limit_lifts_at: isoOffset(60),
      },
    ],
    NOW_MS,
  );
  expect(bodyLineExact(lines, "rate-limited")).toBeUndefined();
  expect(lines.join("\n")).not.toContain("rate-limited");
});

// ---------------------------------------------------------------------------
// Staleness warning (schema v41 / fn-651). A row whose `last_usage_fold_at`
// is older than the renderer's `STALENESS_THRESHOLD_MS` cutoff (~15m)
// picks up an indented `stale Nm` body line — driven exclusively off
// that stamp, never `updated_at` (a rate-limit fold bumps it) and never
// agentuse's own `status`. NULL stamp leaves the warning off; codex
// gets the same contract.
// ---------------------------------------------------------------------------

test("emits a 'stale <age>' line when last_usage_fold_at is older than threshold", () => {
  // 20m-old fold > 15m threshold → stale warning. Age tail is bare (no
  // "ago" suffix; the `stale` label already conveys direction).
  const lines = renderRowLines(
    [
      {
        id: "p",
        target: "claude",
        multiplier: 5,
        session_percent: 10,
        session_resets_at: isoOffset(60),
        week_percent: 10,
        week_resets_at: isoOffset(60),
        last_usage_fold_at: NOW_SEC - 20 * 60,
      },
    ],
    NOW_MS,
  );
  const stale = bodyLineExact(lines, "stale");
  expect(stale, "expected a stale line").toBeDefined();
  expect(stale as string).toMatch(/ 20m$/);
  expect(stale as string).not.toMatch(/ ago$/);
});

test("no 'stale' line when last_usage_fold_at is fresh under the threshold", () => {
  // 5m-old fold < 15m threshold → no warning.
  const lines = renderRowLines(
    [
      {
        id: "p",
        target: "claude",
        multiplier: 5,
        session_percent: 10,
        session_resets_at: isoOffset(60),
        week_percent: 10,
        week_resets_at: isoOffset(60),
        last_usage_fold_at: NOW_SEC - 5 * 60,
      },
    ],
    NOW_MS,
  );
  expect(bodyLineExact(lines, "stale")).toBeUndefined();
  expect(lines.join("\n")).not.toContain("stale");
});

test("no 'stale' line when last_usage_fold_at is NULL (no successful fold to age)", () => {
  // NULL stamp means we have no successful fold to compare against — leave
  // the warning off so a never-folded row doesn't flap stale on first paint.
  const lines = renderRowLines(
    [
      {
        id: "p",
        target: "claude",
        multiplier: 5,
        session_percent: 10,
        session_resets_at: isoOffset(60),
        week_percent: 10,
        week_resets_at: isoOffset(60),
        last_usage_fold_at: null,
      },
    ],
    NOW_MS,
  );
  expect(bodyLineExact(lines, "stale")).toBeUndefined();
});

test("stale and rate-limited render together as visually distinct lines", () => {
  // Both warnings can fire on the same row — the three states (idle is a
  // header chip, rate-limited is the colocated line, stale is its own
  // labelled line) must stay visually distinct.
  const lines = renderRowLines(
    [
      {
        id: "p",
        target: "claude",
        multiplier: 5,
        session_percent: 10,
        session_resets_at: isoOffset(60),
        week_percent: 10,
        week_resets_at: isoOffset(60),
        last_rate_limit_at: NOW_SEC - 3 * 60 * 60,
        rate_limit_lifts_at: isoOffset(30),
        last_usage_fold_at: NOW_SEC - 20 * 60,
      },
    ],
    NOW_MS,
  );
  // header + session + week + rate-limited + stale = 5 lines.
  expect(lines).toHaveLength(5);
  const rl = bodyLineExact(lines, "rate-limited") as string;
  const stale = bodyLineExact(lines, "stale") as string;
  expect(rl).toMatch(/ for 30m$/);
  expect(stale).toMatch(/ 20m$/);
});

// ---------------------------------------------------------------------------
// renderSessionLines — the "recent sessions" log (schema v36, jobs.profile_name)
// ---------------------------------------------------------------------------
//
// Consumes the `jobs` collection rows newest-first and renders one line per
// job: `profile  id  title  state  <rel> ago`. `profile_name` rides the row
// natively; a NULL/empty name renders as `(default)`. `created_at` is REAL
// unix-SECONDS routed through `relTimeFromUnixSec`.

/** A jobs row with the fields renderSessionLines reads. */
function job(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_id: "abcdef0123",
    profile_name: "multi-claude-3",
    title: "some work",
    state: "ended",
    created_at: NOW_SEC - 120, // 2m ago
    ...over,
  };
}

test("empty job set renders no lines", () => {
  expect(renderSessionLines([], NOW_MS)).toEqual([]);
});

test("labels each session with its profile and a 7-char short id", () => {
  const lines = renderSessionLines(
    [job({ job_id: "8449b0912ff", profile_name: "multi-claude-3" })],
    NOW_MS,
  );
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("multi-claude-3");
  expect(lines[0]).toContain("8449b09"); // sliced to 7
  expect(lines[0]).not.toContain("8449b0912ff"); // full id not shown
  expect(lines[0]).toMatch(/ 2m ago$/);
});

test("NULL or empty profile_name renders as (default)", () => {
  const fromNull = renderSessionLines([job({ profile_name: null })], NOW_MS);
  const fromEmpty = renderSessionLines([job({ profile_name: "" })], NOW_MS);
  expect(fromNull[0]).toContain("(default)");
  expect(fromEmpty[0]).toContain("(default)");
});

test("missing/empty title falls back to <untitled>", () => {
  const fromNull = renderSessionLines([job({ title: null })], NOW_MS);
  const fromEmpty = renderSessionLines([job({ title: "" })], NOW_MS);
  expect(fromNull[0]).toContain("<untitled>");
  expect(fromEmpty[0]).toContain("<untitled>");
});

test("long titles truncate with an ellipsis", () => {
  const long = "x".repeat(80);
  const lines = renderSessionLines([job({ title: long })], NOW_MS);
  expect(lines[0]).toContain("…");
  // Full 80-char title is not present verbatim.
  expect(lines[0]).not.toContain(long);
});

test("includes terminal-state sessions (killed / ended) in the log", () => {
  const lines = renderSessionLines(
    [
      job({ job_id: "a1", state: "killed" }),
      job({ job_id: "b2", state: "ended" }),
      job({ job_id: "c3", state: "working" }),
    ],
    NOW_MS,
  );
  expect(lines).toHaveLength(3);
  expect(lines[0]).toContain("killed");
  expect(lines[1]).toContain("ended");
  expect(lines[2]).toContain("working");
});

test("columns align — profile/id/title/state padEnd to widest present", () => {
  const lines = renderSessionLines(
    [
      job({ profile_name: "short", job_id: "aaa1", title: "t1" }),
      job({ profile_name: "much-longer-profile", job_id: "bb2", title: "t2" }),
    ],
    NOW_MS,
  );
  // The short profile is right-padded to the wider profile's width, so the
  // next column ("id") starts at the same offset on both lines (ids here are
  // ≤7 chars so the short-id slice leaves them intact).
  const idCol0 = lines[0].indexOf("aaa1");
  const idCol1 = lines[1].indexOf("bb2");
  expect(idCol0).toBe(idCol1);
});

test("change-gate insensitivity: rendered tail moves with the clock", () => {
  // Same raw row, two different clocks → different rendered tails. This is the
  // exact case the script's `jobsRowsHashKey` guards against forging a frame:
  // the hash keys off raw `created_at`, not this rendered text.
  const row = [job({ created_at: NOW_SEC - 120 })];
  const at2m = renderSessionLines(row, NOW_MS);
  const at1h = renderSessionLines(row, NOW_MS + 58 * 60_000);
  expect(at2m[0]).toMatch(/ 2m ago$/);
  expect(at1h[0]).toMatch(/ 1h ago$/);
});

// ---------------------------------------------------------------------------
// fn-645: envelope status / subscription_active / stale-error rendering
// ---------------------------------------------------------------------------
//
// `renderRowLines` consumes three new axes:
//   - `subscription_active`: `0` hides the row entirely; `1` and NULL render.
//   - `status`: trailing token on the header line ("active"/"idle"/"stale").
//   - `error_type` + `error_message` + `error_at`: a stale-error body line
//     `<type>: <message…>` truncated to the bar+pct column width with
//     `error_at` ticking on the 30s clock via `relTime`.

test("subscription_active=0 rows are hidden from the render entirely", () => {
  // A no-subscription row would render empty `?` bars with no actionable
  // signal — suppress it. Subscribed rows + unknown (null) rows still render.
  const lines = renderRowLines(
    [
      {
        id: "no-sub",
        target: "claude",
        multiplier: 5,
        subscription_active: 0,
        session_percent: null,
        session_resets_at: null,
        week_percent: null,
        week_resets_at: null,
      },
      {
        id: "subscribed",
        target: "claude",
        multiplier: 5,
        subscription_active: 1,
        session_percent: 10,
        session_resets_at: isoOffset(60),
        week_percent: 10,
        week_resets_at: isoOffset(60),
      },
      {
        id: "codex",
        target: "codex",
        multiplier: 1,
        subscription_active: null,
        session_percent: 5,
        session_resets_at: isoOffset(60),
        week_percent: 5,
        week_resets_at: isoOffset(60),
      },
    ],
    NOW_MS,
  );
  // Hidden row's id is absent; visible rows' ids are present.
  expect(lines.join("\n")).not.toContain("no-sub");
  expect(lines.join("\n")).toContain("subscribed");
  expect(lines.join("\n")).toContain("codex");
});

test("an all-hidden input returns an empty array", () => {
  const lines = renderRowLines(
    [
      {
        id: "no-sub-1",
        subscription_active: 0,
        target: "claude",
        multiplier: 5,
      },
      {
        id: "no-sub-2",
        subscription_active: 0,
        target: "claude",
        multiplier: 5,
      },
    ],
    NOW_MS,
  );
  expect(lines).toEqual([]);
});

test("status renders as a trailing token on the header line", () => {
  // The header line carries `(id) [target mult x]  <status>` when the
  // envelope provided a status. All three real values render.
  for (const status of ["active", "idle", "stale"]) {
    const lines = renderRowLines(
      [
        {
          id: "p",
          target: "claude",
          multiplier: 5,
          status,
          subscription_active: 1,
          session_percent: 10,
          session_resets_at: isoOffset(60),
          week_percent: 10,
          week_resets_at: isoOffset(60),
        },
      ],
      NOW_MS,
    );
    // The header is the first line; status follows the chip with a separator.
    expect(lines[0]).toMatch(new RegExp(`${status}$`));
    expect(lines[0]).toContain("[claude 5x]");
  }
});

test("missing/null status leaves the header without a status token", () => {
  const lines = renderRowLines(
    [
      {
        id: "p",
        target: "claude",
        multiplier: 5,
        // status absent (pre-fn-3 envelope)
        subscription_active: 1,
        session_percent: 10,
        session_resets_at: isoOffset(60),
        week_percent: 10,
        week_resets_at: isoOffset(60),
      },
    ],
    NOW_MS,
  );
  // Header ends at the chip's `]` — no trailing status.
  expect(lines[0]).toMatch(/]$/);
});

test("stale error renders as an indented body line with type:message and ticking error_at", () => {
  // The error line mirrors renderRateLimit's idiom — body indent + label
  // padding matches the quota lines, with the relative-time stamp landing in
  // the same column as the reset stamps. Content short enough to fit in the
  // bar+pct cell width (BAR_WIDTH=30 + brackets + space + wPct=3 ≈ 36 chars).
  const lines = renderRowLines(
    [
      {
        id: "p",
        target: "claude",
        multiplier: 5,
        status: "stale",
        subscription_active: 1,
        session_percent: 10,
        session_resets_at: isoOffset(60),
        week_percent: 10,
        week_resets_at: isoOffset(60),
        error_type: "ParseError",
        error_message: "label not found",
        error_at: isoOffset(-3), // 3 minutes ago
      },
    ],
    NOW_MS,
  );
  // header + session + week + error = 4 lines.
  expect(lines).toHaveLength(4);
  const errLine = lines.find((l) => l.trimStart().startsWith("error "));
  expect(errLine).toBeDefined();
  expect(errLine).toContain("ParseError: label not found");
  expect(errLine).toMatch(/ 3m ago$/);
});

test("error_at ticks on the clock (different nowMs → different rendered tail)", () => {
  const row = [
    {
      id: "p",
      target: "claude",
      multiplier: 5,
      status: "stale",
      subscription_active: 1,
      session_percent: 10,
      session_resets_at: isoOffset(60),
      week_percent: 10,
      week_resets_at: isoOffset(60),
      error_type: "X",
      error_message: "msg",
      error_at: isoOffset(-2), // 2 minutes before NOW_MS
    },
  ];
  const at2m = renderRowLines(row, NOW_MS);
  const at1h = renderRowLines(row, NOW_MS + 58 * 60_000);
  const err2m = at2m.find((l) => l.trimStart().startsWith("error "));
  const err1h = at1h.find((l) => l.trimStart().startsWith("error "));
  expect(err2m).toMatch(/ 2m ago$/);
  expect(err1h).toMatch(/ 1h ago$/);
});

test("error line omitted when error_type is NULL (no stale error to show)", () => {
  // A row without a stale error renders no `error` body line. No literal
  // `error` leaks; no `error` joins the label pool either.
  const lines = renderRowLines(
    [
      {
        id: "p",
        target: "claude",
        multiplier: 5,
        status: "active",
        subscription_active: 1,
        session_percent: 10,
        session_resets_at: isoOffset(60),
        week_percent: 10,
        week_resets_at: isoOffset(60),
        error_type: null,
        error_message: null,
        error_at: null,
      },
    ],
    NOW_MS,
  );
  // header + session + week = 3 lines; no error.
  expect(lines).toHaveLength(3);
  expect(lines.find((l) => l.trimStart().startsWith("error "))).toBeUndefined();
});

test("long error_message truncates with an ellipsis within the bar+pct cell width", () => {
  // The error body content fits in the same column the bar+pct cell occupies
  // so the trailing relative-time stamp lands in the same column as the
  // quota resets. Oversize content truncates with an ellipsis.
  const longMsg = "x".repeat(200);
  const lines = renderRowLines(
    [
      {
        id: "p",
        target: "claude",
        multiplier: 5,
        status: "stale",
        subscription_active: 1,
        session_percent: 10,
        session_resets_at: isoOffset(60),
        week_percent: 10,
        week_resets_at: isoOffset(60),
        error_type: "X",
        error_message: longMsg,
        error_at: isoOffset(-1),
      },
    ],
    NOW_MS,
  );
  const errLine = lines.find((l) => l.trimStart().startsWith("error "));
  expect(errLine).toBeDefined();
  expect(errLine).toContain("…");
  // Full 200-char message is not present verbatim.
  expect(errLine).not.toContain(longMsg);
  // The line still ends in the rel-time stamp.
  expect(errLine).toMatch(/ 1m ago$/);
});

test("error_at column aligns under the quota reset column (same cell width)", () => {
  // The error body content is padded to bar+pct cell width so the relative
  // time stamp lands in the SAME column as the reset stamps on the
  // session/week lines. This is the alignment contract that mirrors
  // renderRateLimit's column landing.
  const lines = renderRowLines(
    [
      {
        id: "p",
        target: "claude",
        multiplier: 5,
        status: "stale",
        subscription_active: 1,
        session_percent: 10,
        session_resets_at: isoOffset(60),
        week_percent: 10,
        week_resets_at: isoOffset(60),
        error_type: "T",
        error_message: "m",
        error_at: isoOffset(-1),
      },
    ],
    NOW_MS,
  );
  const session = lines.find((l) => l.trimStart().startsWith("session "));
  const err = lines.find((l) => l.trimStart().startsWith("error "));
  expect(session).toBeDefined();
  expect(err).toBeDefined();
  // The session reset (1h) and error stamp (1m ago) end the lines; find
  // their starting column by stripping the trailing stamp. The cell-width
  // padding guarantees both rel-times start at the same offset.
  const sessIdx = (session as string).search(/ 1h$/);
  const errIdx = (err as string).search(/ 1m ago$/);
  expect(sessIdx).toBeGreaterThan(0);
  expect(errIdx).toBe(sessIdx);
});

test("label padding ignores 'error' when no row renders a stale error", () => {
  // Mirror of the rate-limited label-pool rule: `error` (5 chars) must only
  // join the label-width pool when a row will render it; otherwise the
  // quota labels stay at width 7 (`session`).
  const lines = renderRowLines(
    [
      {
        id: "p",
        target: "claude",
        multiplier: 5,
        status: "active",
        subscription_active: 1,
        session_percent: 5,
        session_resets_at: isoOffset(5),
        week_percent: 5,
        week_resets_at: isoOffset(5),
      },
    ],
    NOW_MS,
  );
  expect(bodyLine(lines, "week")).toContain(
    "week    [██░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 5%",
  );
});

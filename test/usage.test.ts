/**
 * Pure-function tests for `scripts/usage.ts`'s `renderRowLines` helper.
 *
 * `renderRowLines` consumes the daemon-side `usage` collection rows and
 * renders a stacked block per agentuse profile: a header line carrying
 * the id chip + target/multiplier chip, then one indented body line per
 * quota window (session / week / sonnet-where-present). Reset ISO
 * strings fold into a minute-rounded humanized relative-time form
 * (`in 3h 5m` / `5m` / `now` / `2m ago`).
 *
 * `nowMs` is an explicit parameter so tests can drive deterministic
 * snapshots — the live script passes `Date.now()` from both the
 * data-change emit and the 30s tick.
 *
 * The renderer returns body-only lines — the script title (`"usage"`)
 * is rendered by the live-shell banner, not the row body.
 */

import { expect, test } from "bun:test";
import { renderRowLines } from "../scripts/usage";

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
  expect(bodyLine(lines, "session")).toContain("(resets in 5m)");
  expect(bodyLine(lines, "week")).toContain("(resets in 3h 5m)");
  expect(bodyLine(lines, "session")).toContain("session 42%");
  expect(bodyLine(lines, "week")).toContain("week    17%");
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
  expect(bodyLine(lines, "session")).toContain("(resets now)");
  expect(bodyLine(lines, "week")).toContain("(resets now)");
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
  expect(bodyLine(lines, "session")).toContain("(resets 2m ago)");
  expect(bodyLine(lines, "week")).toContain("(resets 2h 5m ago)");
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
  expect(bodyLine(lines, "session")).toContain("(resets in 1d)");
  expect(bodyLine(lines, "week")).toContain("(resets in 5d 21h)");
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
  expect(bodyLine(lines, "session")).toContain("(resets in 1w)");
  expect(bodyLine(lines, "week")).toContain("(resets in 1w 1d)");
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
  // Bad ISO → raw value; empty → empty (no "(resets )" punctuation
  // hiccup beyond the standing format).
  expect(bodyLine(lines, "session")).toContain("(resets not-an-iso)");
  expect(bodyLine(lines, "week")).toContain("(resets )");
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
  expect(bodyLine(lines, "session")).toContain("(resets in 1m)");
  expect(bodyLine(lines, "week")).toContain("(resets now)");
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
  expect(sonnetRow ?? "").toContain("(resets in 5d)");
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
  // `week` padEnd(7) + " " + `5%` padStart(2 — the wPct in this single
  // -digit row set) → `week    5%`.
  expect(bodyLine(sansSonnet, "week")).toContain("week    5%");

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
  expect(bodyLine(withSonnet, "week")).toContain("week    5%");
  expect(bodyLine(withSonnet, "sonnet")).toContain("sonnet  5%");
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
  // `100%` sets the column width; smaller pcts padStart to match.
  // Two-space indent before pct (label is "session" or "week   ", then
  // space, then padStart 4: "100%", "  3%", "  9%", "  8%").
  const sessionRows = lines.filter((l) => l.trimStart().startsWith("session "));
  const weekRows = lines.filter((l) => l.trimStart().startsWith("week "));
  expect(sessionRows[0]).toContain("session 100%");
  expect(sessionRows[1]).toContain("session   3%");
  expect(weekRows[0]).toContain("week      9%");
  expect(weekRows[1]).toContain("week      8%");
});

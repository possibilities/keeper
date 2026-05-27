/**
 * Pure-function tests for `scripts/usage.ts`'s `renderRowLines` helper.
 *
 * `renderRowLines` consumes the daemon-side `usage` collection rows and
 * renders one line per agentuse profile, with the `session_resets_at` /
 * `week_resets_at` ISO strings folded into a minute-rounded humanized
 * relative-time form (`in 3h5m` / `5m` / `now` / `2m ago`). The function
 * takes an explicit `nowMs` parameter so tests can drive deterministic
 * snapshots — the live script passes `Date.now()` from both the
 * data-change emit and the 30s tick.
 *
 * The renderer returns data rows only — the script title (`"usage"`) is
 * rendered by the live-shell banner, not the row body, so `lines[0]` is
 * the first profile row.
 */

import { expect, test } from "bun:test";
import { renderRowLines } from "../scripts/usage";

// Fixed reference clock: 2025-01-15T12:00:00.000Z.
const NOW_MS = Date.parse("2025-01-15T12:00:00.000Z");

function isoOffset(minutes: number): string {
  return new Date(NOW_MS + minutes * 60_000).toISOString();
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
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("(resets in 5m)");
  expect(lines[0]).toContain("(resets in 3h 5m)");
  expect(lines[0]).toContain("session 42%");
  expect(lines[0]).toContain("week 17%");
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
  expect(lines[0]).toContain("(resets now)");
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
  expect(lines[0]).toContain("(resets 2m ago)");
  expect(lines[0]).toContain("(resets 2h 5m ago)");
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
  expect(lines[0]).toContain("(resets in 1d)");
  expect(lines[0]).toContain("(resets in 5d 21h)");
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
  expect(lines[0]).toContain("(resets in 1w)");
  expect(lines[0]).toContain("(resets in 1w 1d)");
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
  expect(lines[0]).toContain("(resets not-an-iso)");
  expect(lines[0]).toContain("(resets )");
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
  expect(lines[0]).toContain("(resets in 1m)");
  expect(lines[0]).toContain("(resets now)");
});

test("empty row set returns an empty array", () => {
  expect(renderRowLines([], NOW_MS)).toEqual([]);
});

test("widest-id padding right-aligns the parenthesized id segment", () => {
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
  // Each id is wrapped in `(...)` and padStart-aligned to the widest
  // `(id)` length so the closing `)` stamps at a fixed column. The
  // short row gets leading spaces; the long row consumes the full
  // width.
  expect(lines[0].startsWith("        (a) ")).toBe(true);
  expect(lines[1].startsWith("(longer-id) ")).toBe(true);
});

test("sonnet_week_percent adds a third pipe-delimited column to that row", () => {
  // Only rows whose envelope carried `usage.sonnet_week` opt into the
  // third column. A row without sonnet data ends after the week
  // segment; a row with sonnet data appends `| sonnet ...`. Widths
  // for the sonnet pct/reset cells are computed across the sonnet-
  // bearing subset only.
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
  // codex row has no sonnet data — does not render the third column.
  const codexRow = lines.find((l) => l.includes("(codex)")) ?? "";
  expect(codexRow).not.toContain("sonnet");
  // claude row renders `| sonnet 2% (resets ...)` after the week cell.
  const claudeRow = lines.find((l) => l.includes("(claude-default)")) ?? "";
  expect(claudeRow).toContain("| sonnet 2% (resets in 5d)");
});

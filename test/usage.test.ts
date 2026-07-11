/**
 * Pure-function tests for `cli/usage.ts`'s `renderRowLines` helper.
 *
 * `renderRowLines` consumes the daemon-side `usage` collection rows and
 * renders a stacked block per agentusage profile: a header line carrying
 * the id chip + target/multiplier chip, then one indented body line per
 * quota window (session / week / sonnet-where-present). Each body line
 * is `label [bar] pct rel` — a 30-wide ASCII bar (`█`/`░`) followed by
 * the numeric pct and a bare relative reset countdown. Future times
 * render without an `in ` prefix (`3h 5m` / `5m` / `now`) since the
 * column context makes the direction unambiguous. A reset is strictly
 * forward, so a past value never reads as an age: an elapsed-but-fresh
 * reset collapses to `now`, never `<rel> ago`. The ONLY `—` trigger is a
 * keeper-stale row (the `max(fold stamp, lift)` anchor past the threshold),
 * which dashes every reset cell AND drops the `limited` line, with the
 * `stale Nm` line carrying the why. There is no per-cell dash.
 *
 * `nowMs` is an explicit parameter so tests can drive deterministic
 * snapshots — the live script passes `Date.now()` from both the
 * data-change emit and the 30s tick.
 *
 * The renderer returns body-only lines — the script title (`"usage"`)
 * is rendered by the live-shell banner, not the row body.
 */

import { describe, expect, test } from "bun:test";
import {
  createUsageEmitEngine,
  renderRowLines,
  renderSessionLines,
  routeUsage,
  SCRAPE_HELP,
} from "../cli/usage";
import {
  createFramesEmitter,
  type FramesEmitter,
  type FramesIo,
} from "../src/frames-emitter";
import {
  formatMetaLine,
  formatSnapshotOutput,
  SNAPSHOT_SCHEMA_VERSION,
  type SnapshotMeta,
} from "../src/snapshot";

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

test("collapses an elapsed-but-fresh reset to 'now', never '—' or '<rel> ago'", () => {
  // A reset cell is a strictly-forward countdown — agentusage always resolves
  // `*_resets_at` into the future at scrape time. On a FRESH row (no keeper
  // staleness) a PAST timestamp means "the reset is due; a fresh scrape just
  // hasn't landed yet" → `now`. It is neither an age (`<rel> ago` would
  // mislabel an "until" value) nor `—` (that is reserved exclusively for a
  // keeper-stale row). There is no per-cell dash.
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
  expect(bodyLine(lines, "session")).not.toMatch(/—|ago/);
  expect(bodyLine(lines, "week")).not.toMatch(/—|ago/);
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

test("codex-spark body lines appear when spark usage data exists", () => {
  const lines = renderRowLines(
    [
      {
        id: "codex",
        target: "codex",
        multiplier: 1,
        session_percent: 33,
        session_resets_at: isoOffset(60),
        week_percent: 28,
        week_resets_at: isoOffset(3 * 24 * 60),
        codex_spark_session_percent: 27,
        codex_spark_session_resets_at: isoOffset(90),
        codex_spark_week_percent: 48,
        codex_spark_week_resets_at: isoOffset(3 * 24 * 60 + 2 * 60),
      },
    ],
    NOW_MS,
  );

  expect(lines).toHaveLength(5);
  expect(bodyLineExact(lines, "spark-5h") ?? "").toContain("27%");
  expect(bodyLineExact(lines, "spark-week") ?? "").toContain("48%");
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
  const sessionRows = lines.filter(
    (l) => l.trimStart().startsWith("session ") && l.includes("["),
  );
  const weekRows = lines.filter(
    (l) => l.trimStart().startsWith("week ") && l.includes("["),
  );
  expect(sessionRows[0]).toContain("] 100%");
  expect(sessionRows[1]).toContain("]   3%");
  expect(weekRows[0]).toContain("]   9%");
  expect(weekRows[1]).toContain("]   8%");
});

// ---------------------------------------------------------------------------
// Colocated `limited` lift line (schema v41 / fn-651, relabeled + lift-gated
// in fn-754). `usage` rows carry `rate_limit_lifts_at` (ISO, the soonest
// reset among >=100% windows); `renderRowLines` emits a `limited lifts in
// <rel>` line under the quota lines for any non-codex row with a known FUTURE
// lift, `limited lifts now` within the ±30s gap, and omits the line for a
// past/NULL lift and for the codex stack. The gate is the future lift itself,
// NOT the fired-time `last_rate_limit_at`, so a depleted-but-quiet row (weekly
// 100%, `last_rate_limit_at` NULL) still renders its countdown.
// ---------------------------------------------------------------------------

const NOW_SEC = Math.floor(NOW_MS / 1000);

/** Find the body line whose label starts with `label` (after the indent),
 *  matching the literal label exactly (the bodyLine helper above appends a
 *  trailing space, which is fine for single-word labels like `limited`). */
function bodyLineExact(lines: string[], label: string): string | undefined {
  return lines.find((l) => l.trimStart().startsWith(`${label} `));
}

test("Claude quota rows render reserve notes only for windows at the picker threshold", () => {
  const lines = renderRowLines(
    [
      {
        id: "p",
        target: "claude",
        multiplier: 1,
        session_percent: 80,
        session_resets_at: isoOffset(60),
        week_percent: 95,
        week_resets_at: isoOffset(2 * 24 * 60),
      },
    ],
    NOW_MS,
  );
  const reserveLines = lines.filter((l) => l.includes("at reserve"));
  expect(reserveLines).toHaveLength(2);
  expect(reserveLines[0]).toMatch(/session · at reserve of 80%$/);
  expect(reserveLines[1]).toMatch(/week {4}· at reserve of 95%$/);
  expect(lines.indexOf(reserveLines[0] as string)).toBeGreaterThan(
    lines.findIndex((l) => l.trimStart().startsWith("week ")),
  );
});

test("session and week reserve notes render independently", () => {
  const sessionOnly = renderRowLines(
    [
      {
        id: "session-hot",
        target: "claude",
        multiplier: 1,
        session_percent: 80,
        session_resets_at: isoOffset(60),
        week_percent: 94,
        week_resets_at: isoOffset(2 * 24 * 60),
      },
    ],
    NOW_MS,
  ).filter((l) => l.includes("at reserve"));
  expect(sessionOnly).toHaveLength(1);
  expect(sessionOnly[0]).toMatch(/session · at reserve of 80%$/);

  const weekOnly = renderRowLines(
    [
      {
        id: "week-hot",
        target: "claude",
        multiplier: 1,
        session_percent: 79,
        session_resets_at: isoOffset(60),
        week_percent: 95,
        week_resets_at: isoOffset(2 * 24 * 60),
      },
    ],
    NOW_MS,
  ).filter((l) => l.includes("at reserve"));
  expect(weekOnly).toHaveLength(1);
  expect(weekOnly[0]).toMatch(/week {4}· at reserve of 95%$/);
});

test("reserve notes are omitted below threshold, and for codex and account-state rows", () => {
  const lines = renderRowLines(
    [
      {
        id: "below",
        target: "claude",
        multiplier: 1,
        session_percent: 79,
        session_resets_at: isoOffset(60),
        week_percent: 94,
        week_resets_at: isoOffset(2 * 24 * 60),
      },
      {
        id: "codex",
        target: "codex",
        multiplier: 1,
        session_percent: 100,
        session_resets_at: isoOffset(60),
        week_percent: 100,
        week_resets_at: isoOffset(2 * 24 * 60),
      },
      {
        id: "signed-out",
        target: "claude",
        multiplier: null,
        subscription_active: null,
        account_state: "signed_out",
      },
    ],
    NOW_MS,
  );
  expect(lines.join("\n")).not.toContain("at reserve");
});

test("emits 'limited lifts in <rel>' when rate_limit_lifts_at is known and future (fn-754)", () => {
  // fn-754: the `limited` line is a forward-looking lift countdown. A stack
  // with a known future `rate_limit_lifts_at` renders `limited lifts in
  // <rel>` — never the fired-time `last_rate_limit_at`.
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
  // header + session + week + limited = 4 lines.
  expect(lines).toHaveLength(4);
  const row = bodyLineExact(lines, "limited");
  expect(row, "expected a limited line").toBeDefined();
  expect(row as string).toMatch(/ lifts in 1h 2m$/);
  // Defensive: never a fallback to the fired-time "ago" rendering.
  expect(row as string).not.toMatch(/ ago$/);
});

test("omits the limited line when rate_limit_lifts_at is NULL (fn-754)", () => {
  // A NULL lift means no window is currently >=100% — the limit has lifted, so
  // a `limited` line would lie. Drop it (no `—`, no fired-time fallback).
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
  expect(bodyLineExact(lines, "limited")).toBeUndefined();
  expect(lines.join("\n")).not.toContain("limited");
});

test("omits the limited line when rate_limit_lifts_at is clearly past (fn-754)", () => {
  // A clearly-past lift on a fresh row means the limit has lifted — drop the
  // line rather than render "<rel> ago". Lift was 2h ago; the row is fresh
  // (recent fold) so the past lift doesn't keep it anchored.
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
        last_usage_fold_at: NOW_SEC - 60,
        rate_limit_lifts_at: isoOffset(-120),
      },
    ],
    NOW_MS,
  );
  expect(bodyLineExact(lines, "limited")).toBeUndefined();
  expect(lines.join("\n")).not.toContain("limited");
});

test("renders 'limited lifts now' when the lift is within the rounding gap (fn-754)", () => {
  // A lift ~20s out rounds to "now" — the limit is lifting this instant. This
  // is the one past-ish state that still renders: the line stays and shows
  // `lifts now` (not `lifts in …`, not `—`, not omitted).
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
        rate_limit_lifts_at: new Date(NOW_MS + 20_000).toISOString(),
      },
    ],
    NOW_MS,
  );
  const row = bodyLineExact(lines, "limited") as string;
  expect(row, "expected a limited line").toBeDefined();
  expect(row).toMatch(/ lifts now$/);
  expect(row).not.toMatch(/in|ago|—/);
});

test("omits the limited line for the codex stack", () => {
  // The codex stack has no rate-limit concept; even if a future lift were on
  // the wire (it shouldn't be), the renderer must suppress the line.
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
        rate_limit_lifts_at: isoOffset(60),
      },
    ],
    NOW_MS,
  );
  expect(lines).toHaveLength(3);
  expect(bodyLineExact(lines, "limited")).toBeUndefined();
  expect(lines.join("\n")).not.toContain("limited");
});

test("limited line indent + label-padding align under the chip", () => {
  // The `limited` body line shares the same indent (`wId + 1` spaces,
  // landing under the chip's `[`) as the quota lines, and pads its label
  // to the widest of the labels actually rendered. `limited` (7) is no
  // wider than `session` (7), so the label column is 7 and the quota
  // labels keep their normal padding.
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
        // fn-754: a known future lift renders `limited lifts in <rel>`;
        // a 5m offset round-trips to body "5m" so the trailing tail
        // is "lifts in 5m".
        rate_limit_lifts_at: isoOffset(5),
      },
    ],
    NOW_MS,
  );
  const header = lines[0];
  const bracket = header.indexOf("[");
  expect(bracket).toBe("(claude-multi-3)".length + 1);
  const rl = bodyLineExact(lines, "limited") as string;
  // The `limited` literal lands at the chip's `[` column.
  expect(rl.indexOf("limited")).toBe(bracket);
  // `limited` is 7 chars (tied with `session` for widest), padEnd(7) leaves
  // zero trailing spaces; a ` · ` separator precedes the lift body.
  expect(rl).toBe(`${" ".repeat(bracket)}limited · lifts in 5m`);
  // `session` (7) is the widest, padEnd(7) → zero trailing; `week` (4) → 3.
  const session = bodyLineExact(lines, "session") as string;
  expect(session.startsWith(`${" ".repeat(bracket)}session [`)).toBe(true);
  const week = bodyLineExact(lines, "week") as string;
  expect(week.startsWith(`${" ".repeat(bracket)}week${" ".repeat(3)} [`)).toBe(
    true,
  );
});

test("label padding ignores 'limited' when no row renders one", () => {
  // `limited` must only join the label-width pool when at least one row
  // will render that line. Since `limited` (7) ties `session` (7), this is
  // a no-op for width — but it must still not add a phantom label. A
  // limit-less screen keeps its quota labels at width 7 (`session`).
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

test("limited line renders when last_rate_limit_at is NULL but a future lift is set (fn-754)", () => {
  // fn-754 dropped the fired-time gate: the presence test is now the FUTURE
  // lift itself. A depleted-but-quiet row (`last_rate_limit_at` NULL because
  // agentusage paused polling) with a known future `rate_limit_lifts_at` now
  // renders a `limited lifts in <rel>` line — the inverse of the old v41
  // behavior.
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
  const row = bodyLineExact(lines, "limited") as string;
  expect(row, "expected a limited line").toBeDefined();
  expect(row).toMatch(/ lifts in 1h$/);
});

// ---------------------------------------------------------------------------
// Staleness warning (schema v41 / fn-651). A row whose `last_usage_fold_at`
// is older than the renderer's `STALENESS_THRESHOLD_MS` cutoff (~15m)
// picks up an indented `stale Nm` body line — driven exclusively off
// that stamp, never `updated_at` (a rate-limit fold bumps it) and never
// agentusage's own `status`. NULL stamp leaves the warning off; codex
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

// ---------------------------------------------------------------------------
// Lift-aware staleness anchor (fn-754). The stale clock anchors to
// `max(last_usage_fold_at, rate_limit_lifts_at)` so a depleted-but-quiet row
// (agentusage paused polling until its known lift, freezing the fold stamp)
// stays FRESH while the lift is future — surfacing the week countdown + a
// `limited` line instead of `—` + `stale`. After the lift passes, the normal
// 15m grace is measured FROM the lift.
// ---------------------------------------------------------------------------

test("depleted row with a future lift stays fresh: week countdown + limited line, no stale (fn-754)", () => {
  // The headline case: weekly 100%, fold stamp 41m old (would trip the 15m
  // threshold off `last_usage_fold_at` alone), but `rate_limit_lifts_at` is
  // future → the anchor picks the lift → row is NOT stale. The week reset
  // cell renders its countdown (not `—`), a `limited lifts in <rel>` line is
  // present, and there is NO `stale` line. `last_rate_limit_at` is NULL — the
  // depletion case — proving the fired-time gate is gone.
  const lines = renderRowLines(
    [
      {
        id: "mc",
        target: "claude",
        multiplier: 1,
        session_percent: 0,
        session_resets_at: null,
        week_percent: 100,
        week_resets_at: isoOffset(2 * 24 * 60),
        last_rate_limit_at: null,
        rate_limit_lifts_at: isoOffset(90),
        last_usage_fold_at: NOW_SEC - 41 * 60,
      },
    ],
    NOW_MS,
  );
  // Week cell shows a real countdown, not the stale dash.
  const week = bodyLine(lines, "week");
  expect(week).not.toMatch(/ —$/);
  expect(week).toMatch(/ 2d$/);
  // The limited line is present with a forward countdown.
  const limited = bodyLineExact(lines, "limited") as string;
  expect(limited, "expected a limited line").toBeDefined();
  expect(limited).toMatch(/ lifts in 1h 30m$/);
  // And NO stale line.
  expect(bodyLineExact(lines, "stale")).toBeUndefined();
  expect(lines.join("\n")).not.toContain("stale");
});

test("lift within ±30s keeps the row fresh and renders 'limited lifts now' (fn-754)", () => {
  // A lift ~20s out anchors fresh (max picks it) and rounds to `lifts now`.
  const lines = renderRowLines(
    [
      {
        id: "mc",
        target: "claude",
        multiplier: 1,
        session_percent: 0,
        session_resets_at: null,
        week_percent: 100,
        week_resets_at: isoOffset(2 * 24 * 60),
        last_rate_limit_at: null,
        rate_limit_lifts_at: new Date(NOW_MS + 20_000).toISOString(),
        last_usage_fold_at: NOW_SEC - 41 * 60,
      },
    ],
    NOW_MS,
  );
  const limited = bodyLineExact(lines, "limited") as string;
  expect(limited, "expected a limited line").toBeDefined();
  expect(limited).toMatch(/ lifts now$/);
  expect(bodyLineExact(lines, "stale")).toBeUndefined();
  // Week cell is fresh, not dashed.
  expect(bodyLine(lines, "week")).not.toMatch(/ —$/);
});

test("a past lift beyond the 15m grace reverts the row to stale (fn-754)", () => {
  // Lift 20m ago, fold even older (1h ago) → anchor is the lift (-20m), past
  // the 15m grace → row stale again: week `—`, a `stale` line, no `limited`.
  const lines = renderRowLines(
    [
      {
        id: "mc",
        target: "claude",
        multiplier: 1,
        session_percent: 0,
        session_resets_at: null,
        week_percent: 100,
        week_resets_at: isoOffset(2 * 24 * 60),
        last_rate_limit_at: null,
        rate_limit_lifts_at: isoOffset(-20),
        last_usage_fold_at: NOW_SEC - 60 * 60,
      },
    ],
    NOW_MS,
  );
  expect(bodyLine(lines, "week")).toMatch(/ —$/);
  expect(bodyLineExact(lines, "stale")).toBeDefined();
  expect(bodyLineExact(lines, "limited")).toBeUndefined();
  expect(lines.join("\n")).not.toContain("limited");
});

test("a past lift within the 15m grace is not yet stale (fn-754)", () => {
  // Lift 5m ago, fold older (1h ago) → anchor is the lift (-5m), within the
  // 15m grace → NOT stale yet. Week cell renders (not `—`), no `stale` line.
  // The lift is past, so the `limited` line is omitted (no future lift).
  const lines = renderRowLines(
    [
      {
        id: "mc",
        target: "claude",
        multiplier: 1,
        session_percent: 0,
        session_resets_at: null,
        week_percent: 100,
        week_resets_at: isoOffset(2 * 24 * 60),
        last_rate_limit_at: null,
        rate_limit_lifts_at: isoOffset(-5),
        last_usage_fold_at: NOW_SEC - 60 * 60,
      },
    ],
    NOW_MS,
  );
  expect(bodyLine(lines, "week")).not.toMatch(/ —$/);
  expect(bodyLineExact(lines, "stale")).toBeUndefined();
  // Past lift → no limited line.
  expect(bodyLineExact(lines, "limited")).toBeUndefined();
});

test("never-folded row stays fresh regardless of lift (fn-754)", () => {
  // `last_usage_fold_at` NULL → foldAtMs NaN. A NULL lift leaves the anchor
  // NaN → `-1` short-circuit → fresh (unchanged from before fn-754).
  const lines = renderRowLines(
    [
      {
        id: "mc",
        target: "claude",
        multiplier: 1,
        session_percent: 10,
        session_resets_at: isoOffset(60),
        week_percent: 10,
        week_resets_at: isoOffset(60),
        last_usage_fold_at: null,
        rate_limit_lifts_at: null,
      },
    ],
    NOW_MS,
  );
  expect(bodyLineExact(lines, "stale")).toBeUndefined();
  expect(bodyLine(lines, "week")).not.toMatch(/ —$/);
});

test("a keeper-stale row drops the limited line entirely", () => {
  // On a STALE row the lift can't be trusted (a frozen snapshot's lift has
  // necessarily elapsed past the grace). Rather than a dashed `limited —`,
  // the line is dropped ENTIRELY — the `stale Nm` line is the single signal
  // that the row is frozen, and the reset cells still dash to `—`. fn-754:
  // the lift here is PAST (and beyond the 15m grace) so the anchor stays
  // stale; a future lift would keep the row fresh instead.
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
        rate_limit_lifts_at: isoOffset(-30),
        last_usage_fold_at: NOW_SEC - 20 * 60,
      },
    ],
    NOW_MS,
  );
  // header + session + week + stale = 4 lines; no limited line.
  expect(lines).toHaveLength(4);
  expect(bodyLineExact(lines, "limited")).toBeUndefined();
  expect(lines.join("\n")).not.toContain("limited");
  const stale = bodyLineExact(lines, "stale") as string;
  expect(stale).toMatch(/ 20m$/);
  // Reset cells on the stale row still dash to `—`.
  expect(bodyLine(lines, "session")).toMatch(/ —$/);
  expect(bodyLine(lines, "week")).toMatch(/ —$/);
});

test("a stale row dashes its reset countdowns instead of showing a value", () => {
  // The whole point: a frozen snapshot's reset predictions have all
  // elapsed, so a confident `1h` / `now` would be a lie. Every reset cell
  // on a stale row renders `—`; the `stale Nm` line is the single place
  // that explains why. (Freshness is the discriminator — the FUTURE reset
  // offsets here would render normally on a fresh row.)
  const lines = renderRowLines(
    [
      {
        id: "p",
        target: "claude",
        multiplier: 5,
        session_percent: 10,
        session_resets_at: isoOffset(60),
        week_percent: 36,
        week_resets_at: isoOffset(4 * 24 * 60),
        sonnet_week_percent: 8,
        sonnet_week_resets_at: isoOffset(4 * 24 * 60),
        last_usage_fold_at: NOW_SEC - 20 * 60,
      },
    ],
    NOW_MS,
  );
  expect(bodyLine(lines, "session")).toMatch(/ —$/);
  expect(bodyLine(lines, "week")).toMatch(/ —$/);
  expect(bodyLine(lines, "sonnet")).toMatch(/ —$/);
  // No relative-time vocabulary leaks onto the stale reset tail.
  expect(bodyLine(lines, "session")).not.toMatch(/(now|ago|\dm|\dh|\dd)$/);
});

test("omits the session line when the weekly window is depleted (>=100%)", () => {
  // A maxed weekly window collapses the session window to a reset-less 0% on
  // the /usage panel (agentusage emits session with a null reset). The renderer
  // suppresses the now-noise `session` line entirely — only `week` renders.
  const lines = renderRowLines(
    [
      {
        id: "mc2",
        target: "claude",
        multiplier: 1,
        session_percent: 0,
        session_resets_at: null,
        week_percent: 100,
        week_resets_at: isoOffset(4 * 24 * 60),
      },
    ],
    NOW_MS,
  );
  // header + week + week-reserve — the session body line is gone.
  expect(lines).toHaveLength(3);
  expect(bodyLineExact(lines, "session")).toBeUndefined();
  expect(bodyLine(lines, "week")).toMatch(/ 100%/);
});

test("keeps the session line while the weekly window is under 100%", () => {
  // Guard the boundary: a 99% week still renders the session line normally.
  const lines = renderRowLines(
    [
      {
        id: "mc2",
        target: "claude",
        multiplier: 1,
        session_percent: 40,
        session_resets_at: isoOffset(30),
        week_percent: 99,
        week_resets_at: isoOffset(4 * 24 * 60),
      },
    ],
    NOW_MS,
  );
  expect(bodyLine(lines, "session")).toMatch(/ 40%/);
  expect(bodyLine(lines, "week")).toMatch(/ 99%/);
});

test("applies account aliases to the id chip; unmapped ids pass through", () => {
  const lines = renderRowLines(
    [
      {
        id: "multi-claude-2",
        target: "claude",
        multiplier: 1,
        session_percent: 10,
        session_resets_at: isoOffset(30),
        week_percent: 20,
        week_resets_at: isoOffset(4 * 24 * 60),
      },
      {
        id: "codex",
        target: "codex",
        multiplier: 1,
        session_percent: 5,
        session_resets_at: isoOffset(30),
        week_percent: 5,
        week_resets_at: isoOffset(30),
      },
    ],
    NOW_MS,
    { "multi-claude-2": "claude-2" },
  );
  // The aliased account renders its display name; the raw id never leaks.
  expect(lines.join("\n")).toContain("(claude-2)");
  expect(lines.join("\n")).not.toContain("multi-claude-2");
  // codex is unmapped → verbatim.
  expect(lines.join("\n")).toContain("(codex)");
});

test("no aliases (default arg) renders raw account ids", () => {
  const lines = renderRowLines(
    [
      {
        id: "multi-claude-2",
        target: "claude",
        multiplier: 1,
        session_percent: 10,
        session_resets_at: isoOffset(30),
        week_percent: 20,
        week_resets_at: isoOffset(4 * 24 * 60),
      },
    ],
    NOW_MS,
  );
  expect(lines[0]).toContain("(multi-claude-2)");
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

test("applies account aliases to the session profile label", () => {
  const lines = renderSessionLines(
    [job({ profile_name: "multi-claude-2" })],
    NOW_MS,
    {
      "multi-claude-2": "claude-2",
    },
  );
  expect(lines[0]).toContain("claude-2");
  expect(lines[0]).not.toContain("multi-claude-2");
});

test("empty profile_name stays (default) even with aliases set", () => {
  // The `(default)` sentinel is "unknown profile", not the literal `default`
  // account — aliasing `default` must not rewrite it.
  const lines = renderSessionLines([job({ profile_name: "" })], NOW_MS, {
    default: "claude-0",
  });
  expect(lines[0]).toContain("(default)");
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
// `renderRowLines` consumes these axes:
//   - `account_state` (schema v97): `signed_out` → `auth · signed out`,
//     `no_subscription` (or back-compat `subscription_active === 0`) → `no
//     active subscription`; rendered as a standalone annotation line under the
//     header instead of bars. Precedence stale-error → account_state → bars.
//   - `subscription_active`: `0` back-compat folds into `no active
//     subscription`; `1` and NULL render bars (no longer a blanket hide).
//   - `status`: trailing token on the header line ("active"/"idle"/"stale").
//   - `error_type` + `error_message` + `error_at`: a stale-error body line
//     `<type>: <message…>` truncated to the bar+pct column width with
//     `error_at` ticking on the 30s clock via `relTime`.

test("back-compat subscription_active=0 renders a no-subscription line, never hidden", () => {
  // A pre-v97 no-sub row (account_state still NULL) keys off subscription_active
  // === 0 onto the `no active subscription` annotation — no bars, no hide.
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
  // No-sub row now renders with its annotation; no quota bars.
  expect(lines.join("\n")).toContain("no-sub");
  expect(lines.join("\n")).toContain("no active subscription");
  expect(lines.join("\n")).toContain("subscribed");
  expect(lines.join("\n")).toContain("codex");
  // The no-sub row carries no bar glyphs of its own — its block is header +
  // annotation only.
  const noSubBlock = lines.filter(
    (l) => l.includes("no-sub") || l.includes("no active subscription"),
  );
  expect(noSubBlock.join("\n")).not.toMatch(/[█░]/);
});

test("an all-no-subscription input renders one annotation per row (none hidden)", () => {
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
  // header + annotation per row = 4 lines; no bars anywhere.
  expect(lines).toHaveLength(4);
  expect(
    lines.filter((l) => l.trimStart() === "no active subscription"),
  ).toHaveLength(2);
  expect(lines.join("\n")).not.toMatch(/[█░]/);
});

test("an empty input still returns an empty array", () => {
  expect(renderRowLines([], NOW_MS)).toEqual([]);
});

test("account_state='signed_out' renders 'auth · signed out', no bars or stale line", () => {
  const lines = renderRowLines(
    [
      {
        id: "default",
        target: "claude",
        multiplier: 5,
        account_state: "signed_out",
        subscription_active: 0,
        status: "active",
        session_percent: null,
        week_percent: null,
        // A stale fold stamp would normally drive a `stale` line — it must not
        // for a stable state (no usage to age).
        last_usage_fold_at: Math.floor((NOW_MS - 60 * 60_000) / 1000),
      },
    ],
    NOW_MS,
  );
  // header + annotation = 2 lines.
  expect(lines).toHaveLength(2);
  expect(lines[1].trimStart()).toBe("auth · signed out");
  expect(lines.join("\n")).not.toMatch(/[█░]/);
  expect(lines.join("\n")).not.toContain("stale");
  // signed_out outranks the back-compat no-sub arm despite subscription_active=0.
  expect(lines.join("\n")).not.toContain("no active subscription");
});

test("account_state='no_subscription' renders 'no active subscription', no bars", () => {
  const lines = renderRowLines(
    [
      {
        id: "default",
        target: "claude",
        multiplier: 5,
        account_state: "no_subscription",
        // account_state classifies even when subscription_active is null.
        subscription_active: null,
        session_percent: null,
        week_percent: null,
      },
    ],
    NOW_MS,
  );
  expect(lines).toHaveLength(2);
  expect(lines[1].trimStart()).toBe("no active subscription");
  expect(lines.join("\n")).not.toMatch(/[█░]/);
});

test("a stale-error row outranks account_state: keeps bars + error line", () => {
  // Precedence stale-error → account_state → bars: an error line present means
  // the row renders its bars + error line, NOT the state annotation.
  const lines = renderRowLines(
    [
      {
        id: "p",
        target: "claude",
        multiplier: 5,
        account_state: "no_subscription",
        subscription_active: 0,
        status: "stale",
        session_percent: 10,
        session_resets_at: isoOffset(60),
        week_percent: 10,
        week_resets_at: isoOffset(60),
        error_type: "ParseError",
        error_message: "label not found",
        error_at: isoOffset(-3),
        error_kind: "format_changed",
      },
    ],
    NOW_MS,
  );
  expect(lines.join("\n")).not.toContain("no active subscription");
  expect(lines.join("\n")).toContain("ParseError: label not found");
  // Bars render for the quota windows.
  expect(lines.join("\n")).toMatch(/[█░]/);
});

test("a state row does not shift a healthy row's bar column (phrase stays out of wLabel)", () => {
  const healthyRow = {
    id: "primary",
    target: "opus",
    multiplier: 2,
    subscription_active: 1,
    session_percent: 42,
    session_resets_at: isoOffset(5),
    week_percent: 17,
    week_resets_at: isoOffset(185),
  };
  // Solo healthy frame — the baseline bar offset.
  const solo = renderRowLines([healthyRow], NOW_MS);
  const soloSession = bodyLine(solo, "session");
  // Mixed frame: a no-sub state row (id no wider than the healthy id) alongside
  // the same healthy row. The 22-char annotation phrase must NOT enter wLabel.
  const mixed = renderRowLines(
    [
      {
        id: "no-sub",
        target: "claude",
        multiplier: 5,
        account_state: "no_subscription",
        subscription_active: 0,
      },
      healthyRow,
    ],
    NOW_MS,
  );
  const mixedSession = bodyLine(mixed, "session");
  // Byte-identical body line ⇒ the bar column did not move.
  expect(mixedSession).toBe(soloSession);
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

test("a null multiplier on a subscription-active claude row renders `?x` (tier unknown), not `1x`", () => {
  // A `/login` restored the keychain but not the `oauthAccount` tier cache, so
  // the boot resolve returned null. A subscription-active row surfaces that
  // honestly as `?x` rather than a confident-but-wrong `1x`.
  const lines = renderRowLines(
    [
      {
        id: "default",
        target: "claude",
        multiplier: null,
        subscription_active: 1,
        session_percent: 10,
        session_resets_at: isoOffset(60),
        week_percent: 10,
        week_resets_at: isoOffset(60),
      },
    ],
    NOW_MS,
  );
  expect(lines[0]).toContain("[claude ?x]");
  // Never the false `1x` default, never the old broken `[claude  x]`.
  expect(lines[0]).not.toContain("1x");
  expect(lines[0]).not.toMatch(/\[claude {2}x\]/);
});

test("codex keeps `[codex 1x]` (a real numeric multiplier is unaffected by `?x`)", () => {
  const lines = renderRowLines(
    [
      {
        id: "codex",
        target: "codex",
        multiplier: 1,
        session_percent: 10,
        session_resets_at: isoOffset(60),
        week_percent: 10,
        week_resets_at: isoOffset(60),
      },
    ],
    NOW_MS,
  );
  expect(lines[0]).toContain("[codex 1x]");
  expect(lines[0]).not.toContain("?x");
});

test("a signed_out / no_subscription row with a null multiplier DROPS the suffix (`[claude]`), never `?x`", () => {
  // `?x` means "subscribed but tier unknown" — a no-plan / logged-out account
  // must not claim a live-but-unknown tier. The suffix drops to a bare
  // `[claude]`, which also fixes today's broken `[claude  x]`.
  for (const state of ["signed_out", "no_subscription"]) {
    const lines = renderRowLines(
      [
        {
          id: "default",
          target: "claude",
          multiplier: null,
          account_state: state,
          subscription_active: 0,
        },
      ],
      NOW_MS,
    );
    expect(lines[0]).toContain("[claude]");
    expect(lines[0]).not.toContain("?x");
    expect(lines[0]).not.toMatch(/\[claude {2}x\]/);
  }
});

test("`?x` and `20x` right-align under the multiplier column", () => {
  // The full token (incl. `x`) feeds `wMult`, so a mixed `?x` (2-char) /
  // `20x` (3-char) frame pads the shorter token — both `]` close at the same
  // column and the chip width is identical across rows.
  const lines = renderRowLines(
    [
      {
        id: "aaaaaa",
        target: "claude",
        multiplier: null,
        subscription_active: 1,
        session_percent: 10,
        session_resets_at: isoOffset(60),
        week_percent: 10,
        week_resets_at: isoOffset(60),
      },
      {
        id: "bbbbbb",
        target: "claude",
        multiplier: 20,
        subscription_active: 1,
        session_percent: 10,
        session_resets_at: isoOffset(60),
        week_percent: 10,
        week_resets_at: isoOffset(60),
      },
    ],
    NOW_MS,
  );
  // Equal-width ids → headers differ only in the id text + padded mult token.
  const unknownHeader = lines.find((l) => l.includes("(aaaaaa)")) as string;
  const knownHeader = lines.find((l) => l.includes("(bbbbbb)")) as string;
  expect(unknownHeader).toContain("[claude  ?x]");
  expect(knownHeader).toContain("[claude 20x]");
  // Both chips close at the same column ⇒ the column aligns.
  expect(unknownHeader.indexOf("]")).toBe(knownHeader.indexOf("]"));
});

test("stale error renders as an indented body line with type:message and ticking error_at", () => {
  // The error line mirrors renderLimited's idiom — body indent + label
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
  // renderLimited's column landing.
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
  // Mirror of the `limited` label-pool rule: `error` (5 chars) must only
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

test("error_kind drives a kind-specific stale-error label, preserving type/message/age", () => {
  // The projected `error_kind` becomes the line label while the body keeps the
  // full `<type>: <message>` content and the rel-time stamp ticks as before.
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
        error_type: "RunnerError",
        error_message: "exit 1",
        error_at: isoOffset(-4),
        error_kind: "runner_failed",
      },
    ],
    NOW_MS,
  );
  // No generic `error ` line; the kind-specific `runner ` label takes its place.
  expect(lines.find((l) => l.trimStart().startsWith("error "))).toBeUndefined();
  const runnerLine = lines.find((l) => l.trimStart().startsWith("runner "));
  expect(runnerLine).toBeDefined();
  expect(runnerLine).toContain("RunnerError: exit 1");
  expect(runnerLine).toMatch(/ 4m ago$/);
});

test("each error_kind maps to its short label", () => {
  const cases: [string, string][] = [
    ["format_changed", "format"],
    ["panel_missing", "panel"],
    ["scrape_failed", "scrape"],
    ["upstream_limited", "upstream"],
    ["runner_failed", "runner"],
  ];
  for (const [kind, label] of cases) {
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
          error_kind: kind,
        },
      ],
      NOW_MS,
    );
    expect(
      lines.find((l) => l.trimStart().startsWith(`${label} `)),
    ).toBeDefined();
  }
});

test("null or unknown error_kind keeps the generic 'error' label", () => {
  for (const kind of [null, "something_new"]) {
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
          error_at: isoOffset(-2),
          error_kind: kind,
        },
      ],
      NOW_MS,
    );
    const errLine = lines.find((l) => l.trimStart().startsWith("error "));
    expect(errLine).toBeDefined();
    expect(errLine).toContain("ParseError: label not found");
  }
});

test("current Codex weekly-line parse failure renders as 'format' and keeps CodexStatusParseError", () => {
  // Fixture mirroring the live Codex `/status` weekly-line drift: the panel
  // renders (format_changed, not panel_missing) but the parser rejects the
  // weekly line. The label must read `format` while the body still surfaces the
  // exact exception type so an operator can diagnose the drift.
  const lines = renderRowLines(
    [
      {
        id: "codex",
        target: "codex",
        multiplier: 1,
        status: "stale",
        subscription_active: 1,
        session_percent: 20,
        session_resets_at: isoOffset(60),
        week_percent: 20,
        week_resets_at: isoOffset(60),
        error_type: "CodexStatusParseError",
        error_message: "weekly line not found",
        error_at: isoOffset(-7),
        error_kind: "format_changed",
      },
    ],
    NOW_MS,
  );
  expect(lines.find((l) => l.trimStart().startsWith("error "))).toBeUndefined();
  const fmtLine = lines.find((l) => l.trimStart().startsWith("format "));
  expect(fmtLine).toBeDefined();
  expect(fmtLine).toContain("CodexStatusParseError");
  expect(fmtLine).toMatch(/ 7m ago$/);
});

// ---------------------------------------------------------------------------
// fn-772 trailer-drift guard: usage is the open-coded outlier (no
// `createViewShell`), so it threads snapshot mode inline while reusing the
// shared `src/snapshot.ts` formatters. These PURE tests assert its
// `keeper-meta:` trailer stays byte-shape-identical to a `createViewShell`
// sibling (only `script: "usage"` differs).
// ---------------------------------------------------------------------------

/** Build a `SnapshotMeta` for `script` with the no-frame shape. */
function noFrameMeta(script: string): SnapshotMeta {
  return {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    script,
    pid: 4242,
    status: "timeout",
    frame: null,
    frame_count: 0,
    truncated: true,
    state: null,
    frame_txt: null,
    lifecycle: `/tmp/keeper-${script}.4242.lifecycle.txt`,
    meta: `/tmp/keeper-${script}.4242.meta.txt`,
    ts: "2025-01-15T12:00:00.000Z",
  };
}

test("usage trailer: byte-shape-identical to a git trailer (no drift)", () => {
  // The trailer-drift guard. usage's trailer must carry the SAME field set
  // and value shapes as a sibling's — only `script` differs. Serialize both
  // via the shared `formatMetaLine` and diff the parsed records by key set +
  // per-key typeof, so a usage-specific hand-rolled field would fail loudly.
  const usageLine = formatMetaLine(noFrameMeta("usage"));
  const gitLine = formatMetaLine(noFrameMeta("git"));
  expect(usageLine.startsWith("keeper-meta: ")).toBe(true);
  const usageJson = JSON.parse(usageLine.slice("keeper-meta: ".length));
  const gitJson = JSON.parse(gitLine.slice("keeper-meta: ".length));
  // Same key set, same iteration order (JSON.stringify is insertion-ordered;
  // both come from the same struct literal shape).
  expect(Object.keys(usageJson)).toEqual(Object.keys(gitJson));
  for (const k of Object.keys(usageJson)) {
    expect(typeof usageJson[k]).toBe(typeof gitJson[k]);
  }
  // Only the script-derived fields differ in VALUE — `script` itself and the
  // sidecar paths that embed it (`lifecycle` / `meta`). Normalize those three
  // and the records are otherwise identical, proving no extra/missing field.
  const norm = (r: Record<string, unknown>): Record<string, unknown> => ({
    ...r,
    script: "X",
    lifecycle: "X",
    meta: "X",
  });
  expect(usageJson.script).toBe("usage");
  expect(gitJson.script).toBe("git");
  expect(norm(usageJson)).toEqual(norm(gitJson));
});

test("usage snapshot output: composed frame text, then the keeper-meta: line LAST", () => {
  // The full stdout block for a successful usage snapshot is the composed
  // body, a blank separator, the labeled metadata lines, then the single-line
  // `keeper-meta:` record LAST. The composed body blends usage + jobs — assert
  // both halves survive into the printed frame and the trailer trails them.
  const meta: SnapshotMeta = {
    ...noFrameMeta("usage"),
    status: "ok",
    frame: 1,
    frame_count: 1,
    truncated: false,
    state: "/tmp/keeper-usage.4242.state.1.json",
    frame_txt: "/tmp/keeper-usage.4242.frame.1.txt",
  };
  const body = [
    "(primary) [claude 2x]",
    "  session [bar] 42% 5m",
    "",
    "recent sessions",
    "  abc work",
  ].join("\n");
  const out = formatSnapshotOutput({ frameText: body, meta });
  const outLines = out.split("\n");
  // Frame text is at the top.
  expect(out).toContain("recent sessions");
  // The keeper-meta: line is the LAST non-empty line and parses.
  const last = outLines.filter((l) => l.length > 0).at(-1) as string;
  expect(last.startsWith("keeper-meta: ")).toBe(true);
  const parsed = JSON.parse(last.slice("keeper-meta: ".length));
  expect(parsed.script).toBe("usage");
  expect(parsed.frame).toBe(1);
  expect(parsed.truncated).toBe(false);
});

// ---------------------------------------------------------------------------
// `keeper usage scrape` subverb pre-pass. The leading-token router lands ahead
// of the view's parseArgs: a `scrape` token delegates to the merged scrape CLI
// with argv forwarded VERBATIM, `scrape --help`/`-h` is the subverb's own pure
// help, and every other argv (bare, a leading flag, top-level `--help`) is the
// unchanged view path.
// ---------------------------------------------------------------------------
describe("routeUsage — the scrape subverb pre-pass", () => {
  test("a leading scrape token forwards the remaining argv verbatim", () => {
    expect(
      routeUsage([
        "scrape",
        "--target",
        "claude",
        "--profile",
        "default",
        "--rows",
        "50",
      ]),
    ).toEqual({
      kind: "scrape",
      argv: ["--target", "claude", "--profile", "default", "--rows", "50"],
    });
  });

  test("a bare scrape token delegates an empty argv (entry owns the misuse)", () => {
    expect(routeUsage(["scrape"])).toEqual({ kind: "scrape", argv: [] });
  });

  test("scrape --help is the subverb's own pure help", () => {
    expect(routeUsage(["scrape", "--help"])).toEqual({ kind: "scrape-help" });
  });

  test("scrape -h is the subverb's own pure help", () => {
    expect(routeUsage(["scrape", "-h"])).toEqual({ kind: "scrape-help" });
  });

  test("a --help among scrape flags routes to help, not delegation", () => {
    expect(routeUsage(["scrape", "--target", "claude", "--help"])).toEqual({
      kind: "scrape-help",
    });
  });

  test("a bare argv is the unchanged view path", () => {
    expect(routeUsage([])).toEqual({ kind: "view" });
  });

  test("a leading view flag is the unchanged view path", () => {
    expect(routeUsage(["--snapshot"])).toEqual({ kind: "view" });
  });

  test("top-level --help stays the view path (view owns its own help)", () => {
    expect(routeUsage(["--help"])).toEqual({ kind: "view" });
  });

  test("a non-scrape leading positional is the view path", () => {
    expect(routeUsage(["bogus"])).toEqual({ kind: "view" });
  });

  test("SCRAPE_HELP documents the subverb and its flags", () => {
    expect(SCRAPE_HELP).toContain("keeper usage scrape");
    expect(SCRAPE_HELP).toContain("--target");
    expect(SCRAPE_HELP).toContain("--profile");
  });
});

// ---------------------------------------------------------------------------
// fn-1161 frames mode: `keeper frames --view usage`. usage is the open-coded
// outlier (no `createViewShell`), so it plugs the SHARED `src/frames-emitter.ts`
// wire contract into its composed-frame emit path via `createUsageEmitEngine`.
// These PURE tests drive both streams into a real emitter over captured stdout
// (a fake clock + no-op sidecar IO) and assert: one frame per raw-field hash
// change, a relative-time tick mints nothing, both streams count once, the
// bound trips at the emit site, and the envelope is byte-shape-identical to a
// shared-shell (board) envelope.
// ---------------------------------------------------------------------------

// A representative `usage`-stream row (mirrors the renderRowLines fixtures).
const USAGE_ROW: Record<string, unknown> = {
  id: "primary",
  target: "opus",
  multiplier: 2,
  session_percent: 42,
  session_resets_at: isoOffset(5),
  week_percent: 17,
  week_resets_at: isoOffset(185),
};

// A representative `jobs`-stream row for the "recent sessions" log
// (`created_at` is real unix-SECONDS, per renderSessionLines).
const JOBS_ROW: Record<string, unknown> = {
  job_id: "abc123def",
  profile_name: "primary",
  created_at: Math.floor(NOW_MS / 1000) - 60,
  state: "running",
  title: "work fn-1161",
};

/** A frames emitter over captured stdout with a fake clock + constant diff, so
 *  the envelope is fully deterministic in the pure tier. */
function makeFramesCapture(
  view: string,
  opts: { maxFrames?: number | null } = {},
): {
  emitter: FramesEmitter;
  records: () => Array<Record<string, unknown>>;
} {
  const stdout: string[] = [];
  const io: FramesIo = {
    writeFile: () => {},
    unlink: () => {},
    nowIso: () => "2026-06-10T00:00:00.000Z",
    nowMs: () => 0,
  };
  const emitter = createFramesEmitter({
    view,
    writeStdout: (line) => stdout.push(line),
    // Constant diff so a usage frame and a board frame carry byte-identical
    // `diff` — the parity assertion below then needs no diff normalization.
    diffFn: () => "@@ d @@\n",
    io,
    maxFrames: opts.maxFrames ?? null,
    durationMs: null,
  });
  return {
    emitter,
    records: () =>
      stdout.map((l) => JSON.parse(l.trim()) as Record<string, unknown>),
  };
}

/** Build a frames-mode usage engine over `emitter` with a fixed cursor + clock
 *  and no-op live/tick sinks (frames mode never paints). `catchingUp` /
 *  `loadingLine` are the fn-1180 gate deps — omitted (the default) keeps
 *  every existing caller's pre-gate behavior (`catching_up` always `null`). */
function makeUsageFramesEngine(
  emitter: FramesEmitter,
  onMaybeStop: () => void = () => {},
  gate: { catchingUp?: () => boolean | null; loadingLine?: () => string } = {},
): ReturnType<typeof createUsageEmitEngine> {
  return createUsageEmitEngine({
    mode: "frames",
    accountAliases: {},
    framesEmitter: emitter,
    latestCursor: () => "42",
    catchingUp: gate.catchingUp,
    loadingLine: gate.loadingLine,
    onMaybeStop,
    onLiveFrame: () => {},
    onTickRefresh: () => {},
    reportUsageStream: () => {},
    reportJobsStream: () => {},
    nowMs: () => NOW_MS,
  });
}

test("usage frames: one frame per raw-field hash change; unchanged re-delivery mints nothing", () => {
  const cap = makeFramesCapture("usage");
  const engine = makeUsageFramesEngine(cap.emitter);

  engine.emitUsage([USAGE_ROW]); // first accepted frame → baseline
  engine.emitJobs([JOBS_ROW]); // composed body grew → data frame
  // Re-delivering byte-equal rows on either stream is a no-op (the raw-field
  // hash gate suppresses it) — a fetch-only refresh never mints a frame.
  engine.emitUsage([{ ...USAGE_ROW }]);
  engine.emitJobs([{ ...JOBS_ROW }]);

  const recs = cap.records();
  expect(recs.map((r) => r.type)).toEqual(["baseline", "frame"]);
  expect(recs.map((r) => r.seq)).toEqual([0, 1]);
  expect(recs.every((r) => r.view === "usage")).toBe(true);
  expect(recs.every((r) => r.cursor === "42")).toBe(true);
  // 2: FRAMES_SCHEMA_VERSION as of the catching_up field's addition.
  expect(recs.every((r) => r.schema_version === 2)).toBe(true);
});

test("usage frames: a relative-time tick with no data change never mints a frame", () => {
  const cap = makeFramesCapture("usage");
  const engine = makeUsageFramesEngine(cap.emitter);
  engine.emitUsage([USAGE_ROW]); // baseline
  engine.emitJobs([JOBS_ROW]); // frame
  const before = cap.records().length;

  // The 30s tick re-renders relative-time cells but the raw fields are
  // unchanged — the emitter is hooked at the hash-gated emit site, never the
  // tick, so a countdown repaint is exactly the no-op churn a consumer must not
  // drown in. It must produce ZERO new envelopes.
  engine.tick();
  engine.tick();

  expect(cap.records().length).toBe(before);
});

test("usage frames: both streams count once toward coverage accounting", () => {
  const cap = makeFramesCapture("usage");
  const engine = makeUsageFramesEngine(cap.emitter);

  engine.emitUsage([USAGE_ROW]); // baseline (usage's one contribution)
  engine.emitJobs([JOBS_ROW]); // one data frame (jobs' one contribution)
  engine.emitUsage([USAGE_ROW]); // unchanged → no double-count
  engine.emitJobs([JOBS_ROW]); // unchanged → no double-count

  expect(engine.usageStreamReported()).toBe(true);
  expect(engine.jobsStreamReported()).toBe(true);
  expect(engine.framesBaselineEmitted()).toBe(true);
  // Exactly one baseline + one data frame across the four deliveries — each
  // stream's real change landed once, neither re-delivery inflated the count.
  const recs = cap.records();
  expect(recs.filter((r) => r.type === "baseline")).toHaveLength(1);
  expect(recs.filter((r) => r.type === "frame")).toHaveLength(1);
});

test("usage frames: a data frame trips the max-frames bound at the emit site; the baseline does not", () => {
  const cap = makeFramesCapture("usage", { maxFrames: 1 });
  const stops: Array<string | null> = [];
  // `onMaybeStop` is the shell's `maybeStopFrames`: it re-checks the emitter's
  // bound after every emit and (in prod) flushes the trailer + exits.
  const engine = makeUsageFramesEngine(cap.emitter, () =>
    stops.push(cap.emitter.shouldStop()),
  );

  engine.emitUsage([USAGE_ROW]); // baseline — excluded from the data-frame bound
  engine.emitJobs([JOBS_ROW]); // data frame 1 — trips maxFrames: 1

  expect(stops).toEqual([null, "max_frames"]);
});

test("usage frames: a disconnect clears the change-gate and downgrades coverage to gap_possible", () => {
  const cap = makeFramesCapture("usage");
  const engine = makeUsageFramesEngine(cap.emitter);
  engine.emitUsage([USAGE_ROW]); // baseline

  // A disconnect is the sole gap source the emitter's contiguous seq can't see.
  // It must (a) clear the gate so the post-reconnect first paint re-emits even
  // on identical rows, and (b) downgrade the trailer coverage verdict.
  engine.noteDisconnect();
  engine.emitUsage([USAGE_ROW]); // same rows, but the gate was cleared → frame
  cap.emitter.emitTrailer({ reason: "interrupt" });

  const recs = cap.records();
  expect(recs.map((r) => r.type)).toEqual(["baseline", "frame", "trailer"]);
  const trailer = recs.at(-1);
  expect(trailer?.coverage).toBe("gap_possible");
});

test("usage frames: envelope is byte-shape-identical to a shared-shell (board) frames envelope", () => {
  // Drive the REAL usage engine to produce a usage baseline + frame.
  const u = makeFramesCapture("usage");
  const engine = makeUsageFramesEngine(u.emitter);
  engine.emitUsage([USAGE_ROW]); // baseline
  engine.emitJobs([JOBS_ROW]); // frame
  const [uBaseline, uFrame] = u.records();

  // Build a board frames envelope directly through the shared emitter — the
  // shared shell's exact path. Same cursor + constant diff, so only the
  // view-derived fields differ.
  const b = makeFramesCapture("board");
  b.emitter.emitBaseline({ cursor: "42", frameText: "x", stateJson: {} });
  b.emitter.emitFrame({ cursor: "42", frameText: "x\ny", stateJson: {} });
  const [bBaseline, bFrame] = b.records();

  // Normalize the view-derived fields: `view` itself and the sidecar paths that
  // embed it. Everything else must match — same key set, same per-key typeof,
  // and normalized deep-equality — proving usage routes through the shared wire
  // contract with no hand-rolled envelope (mirrors the snapshot trailer-drift
  // guard above).
  const norm = (r: Record<string, unknown>): Record<string, unknown> => ({
    ...r,
    view: "X",
    frame_path: r.frame_path === null ? null : "X",
    state_path: r.state_path === null ? null : "X",
    diff_path: r.diff_path === null ? null : "X",
  });
  for (const [uRec, bRec] of [
    [uBaseline, bBaseline],
    [uFrame, bFrame],
  ] as const) {
    expect(Object.keys(uRec)).toEqual(Object.keys(bRec));
    for (const k of Object.keys(uRec)) {
      expect(typeof uRec[k]).toBe(typeof bRec[k]);
    }
    expect(uRec.view).toBe("usage");
    expect(bRec.view).toBe("board");
    expect(norm(uRec)).toEqual(norm(bRec));
  }
});

// ---------------------------------------------------------------------------
// fn-1180: the catching-up gate's frames-mode one-static-loading-record
// discipline. `deps.catchingUp` omitted keeps every pre-gate caller's
// behavior byte-identical (asserted above); these tests thread it explicitly.
// ---------------------------------------------------------------------------

describe("usage frames — the catching-up gate", () => {
  test("gated (catchingUp true): a real row change never forges a second loading record", () => {
    const cap = makeFramesCapture("usage");
    const engine = makeUsageFramesEngine(cap.emitter, () => {}, {
      catchingUp: () => true,
      loadingLine: () => "re-folding event log…",
    });

    engine.emitUsage([USAGE_ROW]); // gated baseline → the one static record
    engine.emitJobs([JOBS_ROW]); // real data changed underneath — suppressed
    engine.emitUsage([{ ...USAGE_ROW, session_percent: 99 }]); // still suppressed

    const recs = cap.records();
    expect(recs).toHaveLength(1);
    expect(recs[0]?.type).toBe("baseline");
    expect(recs[0]?.catching_up).toBe(true);
    // The static label, never the real composed usage/jobs body.
    expect(recs[0]?.diff).toBeNull();
  });

  test("gated: the static record's frame text is the shell's loading label verbatim, not the composed body", () => {
    // `makeFramesCapture`'s constant `diffFn` can't surface frame TEXT (only a
    // fixed diff string), so this test wires its own emitter with a
    // content-capturing `io.writeFile` to read back the frame sidecar.
    const stdout: string[] = [];
    const written = new Map<string, string>();
    const emitter = createFramesEmitter({
      view: "usage",
      writeStdout: (line) => stdout.push(line),
      diffFn: () => "@@ d @@\n",
      io: {
        writeFile: (path, contents) => written.set(path, contents),
        unlink: () => {},
        nowIso: () => "2026-06-10T00:00:00.000Z",
        nowMs: () => 0,
      },
      maxFrames: null,
      durationMs: null,
    });
    const engine = makeUsageFramesEngine(emitter, () => {}, {
      catchingUp: () => true,
      loadingLine: () => "waiting for git seed…",
    });
    engine.emitUsage([USAGE_ROW]);

    const rec = JSON.parse(stdout[0]?.trim() ?? "{}") as Record<
      string,
      unknown
    >;
    const framePath = rec.frame_path as string;
    expect(written.get(framePath)).toBe("waiting for git seed…\n");
  });

  test("ungated (catchingUp false): frames stamp catching_up:false and compose the real body, same as today", () => {
    const cap = makeFramesCapture("usage");
    const engine = makeUsageFramesEngine(cap.emitter, () => {}, {
      catchingUp: () => false,
    });
    engine.emitUsage([USAGE_ROW]);
    engine.emitJobs([JOBS_ROW]);
    const recs = cap.records();
    expect(recs.map((r) => r.type)).toEqual(["baseline", "frame"]);
    expect(recs.every((r) => r.catching_up === false)).toBe(true);
  });

  test("never observed (catchingUp omitted): every record stamps catching_up:null, matching pre-gate behavior", () => {
    const cap = makeFramesCapture("usage");
    const engine = makeUsageFramesEngine(cap.emitter);
    engine.emitUsage([USAGE_ROW]);
    engine.emitJobs([JOBS_ROW]);
    const recs = cap.records();
    expect(recs.every((r) => r.catching_up === null)).toBe(true);
  });

  test("a gate clear (catchingUp flips false) resumes real composed frames after the one loading record", () => {
    const cap = makeFramesCapture("usage");
    let gated = true;
    const engine = makeUsageFramesEngine(cap.emitter, () => {}, {
      catchingUp: () => gated,
      loadingLine: () => "catching up…",
    });
    engine.emitUsage([USAGE_ROW]); // gated → one static baseline record
    gated = false;
    engine.emitJobs([JOBS_ROW]); // ungated real data change → a real frame

    const recs = cap.records();
    expect(recs.map((r) => r.type)).toEqual(["baseline", "frame"]);
    expect(recs[0]?.catching_up).toBe(true);
    expect(recs[1]?.catching_up).toBe(false);
  });

  test("noteDisconnect resets the one-record latch — a reconnect that is still gated earns a fresh record", () => {
    const cap = makeFramesCapture("usage");
    const engine = makeUsageFramesEngine(cap.emitter, () => {}, {
      catchingUp: () => true,
      loadingLine: () => "catching up…",
    });
    engine.emitUsage([USAGE_ROW]); // gated baseline
    engine.emitUsage([{ ...USAGE_ROW, session_percent: 50 }]); // suppressed
    expect(cap.records()).toHaveLength(1);

    engine.noteDisconnect(); // a reconnect starts a fresh gated window
    engine.emitUsage([{ ...USAGE_ROW, session_percent: 50 }]); // earns its own record

    const recs = cap.records();
    expect(recs).toHaveLength(2);
    expect(recs.map((r) => r.type)).toEqual(["baseline", "frame"]);
    expect(recs[1]?.catching_up).toBe(true);
  });
});

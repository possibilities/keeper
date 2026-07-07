import { describe, expect, test } from "bun:test";
import { Temporal } from "@js-temporal/polyfill";
import {
  claudeSessionResetAt,
  claudeWeekResetAt,
  codexDateResetAt,
  codexTodayResetAt,
  to24h,
} from "../src/usage-scrape/reset-time";

// Pinned NOW: noon on 2026-05-29 in New York. May is EDT (-04:00)
// year-round-stable, so reprojected offsets are deterministic. Expected strings
// below are hand-computed, not re-derived by the resolver.
const CLAUDE_NOW = Temporal.ZonedDateTime.from(
  "2026-05-29T12:00[America/New_York]",
);
// Codex reference NOW: 2026-05-15 12:00 (-04:00).
const CODEX_NOW = Temporal.ZonedDateTime.from(
  "2026-05-15T12:00[America/New_York]",
);

const ISO_SECONDS_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

describe("to24h — 12h to 24h", () => {
  test("12am is midnight (0), 12pm is noon (12)", () => {
    expect(to24h(12, "am")).toBe(0);
    expect(to24h(12, "pm")).toBe(12);
  });

  test("non-boundary hours: am unchanged, pm + 12", () => {
    expect(to24h(11, "am")).toBe(11);
    expect(to24h(3, "pm")).toBe(15);
    expect(to24h(1, "pm")).toBe(13);
  });

  test("am/pm is case-insensitive", () => {
    expect(to24h(12, "AM")).toBe(0);
    expect(to24h(3, "PM")).toBe(15);
  });
});

describe("claudeSessionResetAt — named-zone wall clock, today/tomorrow roll", () => {
  test("12am rolls to tomorrow midnight", () => {
    expect(claudeSessionResetAt(0, 0, "America/New_York", CLAUDE_NOW)).toBe(
      "2026-05-30T00:00:00-04:00",
    );
  });

  test("12pm equals now and rolls to tomorrow noon", () => {
    expect(claudeSessionResetAt(12, 0, "America/New_York", CLAUDE_NOW)).toBe(
      "2026-05-30T12:00:00-04:00",
    );
  });

  test("3pm is later today and stays", () => {
    expect(claudeSessionResetAt(15, 0, "America/New_York", CLAUDE_NOW)).toBe(
      "2026-05-29T15:00:00-04:00",
    );
  });

  test("11am is earlier today and rolls to tomorrow", () => {
    expect(claudeSessionResetAt(11, 0, "America/New_York", CLAUDE_NOW)).toBe(
      "2026-05-30T11:00:00-04:00",
    );
  });

  test("1pm is later today and stays", () => {
    expect(claudeSessionResetAt(13, 0, "America/New_York", CLAUDE_NOW)).toBe(
      "2026-05-29T13:00:00-04:00",
    );
  });

  test("resolves in the named zone, then reprojects to now's zone", () => {
    // now is 08:00 Los Angeles (-07:00) == 11:00 New York. 3pm resolves in NY
    // (15:00 EDT), then reprojects to LA (12:00 PDT).
    const laNow = Temporal.ZonedDateTime.from(
      "2026-05-29T08:00[America/Los_Angeles]",
    );
    expect(claudeSessionResetAt(15, 0, "America/New_York", laNow)).toBe(
      "2026-05-29T12:00:00-07:00",
    );
  });

  test("unknown IANA zone throws RangeError", () => {
    expect(() =>
      claudeSessionResetAt(15, 0, "Mars/Olympus_Mons", CLAUDE_NOW),
    ).toThrow(RangeError);
  });
});

describe("claudeWeekResetAt — named-zone wall clock, this-year/next-year roll", () => {
  test("future date this year stays", () => {
    expect(claudeWeekResetAt(5, 31, 9, 0, "America/New_York", CLAUDE_NOW)).toBe(
      "2026-05-31T09:00:00-04:00",
    );
  });

  test("passed date wraps to next year", () => {
    // January in New York is EST (-05:00), not EDT.
    expect(claudeWeekResetAt(1, 5, 9, 0, "America/New_York", CLAUDE_NOW)).toBe(
      "2027-01-05T09:00:00-05:00",
    );
  });

  test("invalid calendar date throws RangeError (overflow reject, not clamp)", () => {
    expect(() =>
      claudeWeekResetAt(2, 30, 9, 0, "America/New_York", CLAUDE_NOW),
    ).toThrow(RangeError);
  });

  test("unknown IANA zone throws RangeError", () => {
    expect(() =>
      claudeWeekResetAt(5, 31, 9, 0, "Mars/Olympus_Mons", CLAUDE_NOW),
    ).toThrow(RangeError);
  });
});

describe("codexTodayResetAt — system-local wall clock, today/tomorrow roll", () => {
  test("earlier today rolls to tomorrow", () => {
    expect(codexTodayResetAt(9, 30, CODEX_NOW)).toBe(
      "2026-05-16T09:30:00-04:00",
    );
  });

  test("later today stays", () => {
    expect(codexTodayResetAt(14, 5, CODEX_NOW)).toBe(
      "2026-05-15T14:05:00-04:00",
    );
  });

  test("exactly now rolls to tomorrow", () => {
    expect(codexTodayResetAt(12, 0, CODEX_NOW)).toBe(
      "2026-05-16T12:00:00-04:00",
    );
  });
});

describe("codexDateResetAt — system-local wall clock, this-year/next-year roll", () => {
  test("passed date wraps to next year", () => {
    // January is EST (-05:00) in the New York reference zone.
    expect(codexDateResetAt(1, 1, 10, 0, CODEX_NOW)).toBe(
      "2027-01-01T10:00:00-05:00",
    );
  });

  test("future date this year stays", () => {
    expect(codexDateResetAt(5, 30, 18, 28, CODEX_NOW)).toBe(
      "2026-05-30T18:28:00-04:00",
    );
  });

  test("invalid calendar date throws RangeError (overflow reject, not clamp)", () => {
    expect(() => codexDateResetAt(2, 30, 12, 0, CODEX_NOW)).toThrow(RangeError);
  });
});

describe("formatter output — seconds precision, no milliseconds, offset-bearing, no [Zone]", () => {
  test("claude formatter emits seconds-precision offset ISO with no fractional seconds", () => {
    const out = claudeSessionResetAt(15, 0, "America/New_York", CLAUDE_NOW);
    expect(out).toMatch(ISO_SECONDS_OFFSET);
    expect(out).not.toContain(".");
    expect(out).not.toContain("[");
  });

  test("codex formatter emits seconds-precision offset ISO with no fractional seconds", () => {
    const out = codexTodayResetAt(14, 5, CODEX_NOW);
    expect(out).toMatch(ISO_SECONDS_OFFSET);
    expect(out).not.toContain(".");
    expect(out).not.toContain("[");
  });
});

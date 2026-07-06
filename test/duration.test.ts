/**
 * Table-driven suite for the shared unit-required duration grammar
 * (`cli/duration.ts`). Expected millisecond values are hand-computed constants,
 * never re-derived from the parser under test.
 */

import { describe, expect, test } from "bun:test";
import { parseDuration } from "../cli/duration";

describe("parseDuration — valid single-unit values", () => {
  test.each([
    ["500ms", 500],
    ["1ms", 1],
    ["30s", 30_000],
    ["1s", 1_000],
    ["5m", 300_000],
    ["2h", 7_200_000],
    ["  30s  ", 30_000], // surrounding whitespace is trimmed
  ] as const)("%s → %d ms", (raw, ms) => {
    const r = parseDuration(raw);
    expect(r).toEqual({ ok: true, ms });
  });
});

describe("parseDuration — compounds sum their segments", () => {
  test.each([
    ["1h30m", 5_400_000], // 3_600_000 + 1_800_000
    ["1m30s", 90_000], // 60_000 + 30_000
    ["2h5m30s", 7_530_000], // 7_200_000 + 300_000 + 30_000
    ["1s500ms", 1_500], // 1_000 + 500
  ] as const)("%s → %d ms", (raw, ms) => {
    const r = parseDuration(raw);
    expect(r).toEqual({ ok: true, ms });
  });
});

describe("parseDuration — bare numbers are rejected with a self-healing hint", () => {
  test.each(["2", "0", "1500", "600"] as const)(
    "%s names the unit fix",
    (raw) => {
      const r = parseDuration(raw);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.message).toContain("needs a unit");
      // The hint names the fix: the same number with an `s`.
      expect(r.message).toContain(`${raw.trim()}s`);
    },
  );
});

describe("parseDuration — malformed input is rejected", () => {
  test.each([
    "abc",
    "5x",
    "-5",
    "1.5s",
    "1.5",
    "ms",
    "s",
    "",
    "   ",
    "5 s",
  ] as const)("%p → not ok", (raw) => {
    expect(parseDuration(raw).ok).toBe(false);
  });
});

describe("parseDuration — a zero total is not a positive duration", () => {
  test.each(["0s", "0ms", "0h0m"] as const)("%s → not ok", (raw) => {
    const r = parseDuration(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("positive");
  });
});

describe("parseDuration — ms is read greedily before s", () => {
  test("500ms is 500 milliseconds, not 500 minutes + s", () => {
    expect(parseDuration("500ms")).toEqual({ ok: true, ms: 500 });
  });
});

import { expect, test } from "bun:test";
import {
  foldSlope,
  SLOPE_OFFENDER_PCT,
  twoPointSlopes,
} from "../scripts/serve-fold-load";

// Pure smoke tests for the replay-from-zero two-point slope arithmetic — the
// audit's scaling detector. No DB, no fold: just the math that convicts a fold.

test("foldSlope: p95 growth across halves yields the percent slope + offender flag", () => {
  const s = foldSlope("PostToolUse", [1, 1, 1, 1], [2, 2, 2, 2]);
  expect(s.first.p95).toBe(1);
  expect(s.second.p95).toBe(2);
  expect(s.p95SlopePct).toBeCloseTo(100, 6);
  expect(s.offender).toBe(true);
});

test("foldSlope: a flat fold (no growth) is not an offender", () => {
  const s = foldSlope("Commit", [3, 3, 3], [3, 3, 3]);
  expect(s.p95SlopePct).toBeCloseTo(0, 6);
  expect(s.offender).toBe(false);
});

test("foldSlope: growth at the threshold boundary is strict (> not >=)", () => {
  // Exactly +20% is NOT an offender; just above it is.
  const at = foldSlope("k", [10], [12]); // +20%
  expect(at.p95SlopePct).toBeCloseTo(SLOPE_OFFENDER_PCT, 6);
  expect(at.offender).toBe(false);
  const over = foldSlope("k", [10], [13]); // +30%
  expect(over.offender).toBe(true);
});

test("foldSlope: an uncomputable slope is null and never an offender", () => {
  // Kind absent from the first half (no two-point line).
  const absentFirst = foldSlope("k", [], [1, 2, 3]);
  expect(absentFirst.p95SlopePct).toBeNull();
  expect(absentFirst.offender).toBe(false);
  // Kind absent from the second half.
  const absentSecond = foldSlope("k", [1, 2, 3], []);
  expect(absentSecond.p95SlopePct).toBeNull();
  expect(absentSecond.offender).toBe(false);
  // A zero first-half baseline — no ratio to divide by.
  const zeroBase = foldSlope("k", [0, 0, 0], [1, 1, 1]);
  expect(zeroBase.p95SlopePct).toBeNull();
  expect(zeroBase.offender).toBe(false);
});

test("twoPointSlopes: splits at the corpus midpoint and buckets per kind", () => {
  const samples = [
    // first half (mid = floor(8 / 2) = 4)
    { kind: "A", ms: 1 },
    { kind: "A", ms: 1 },
    { kind: "B", ms: 1 },
    { kind: "B", ms: 1 },
    // second half
    { kind: "A", ms: 2 },
    { kind: "A", ms: 2 },
    { kind: "B", ms: 1 },
    { kind: "B", ms: 1 },
  ];
  const { overall, byKind } = twoPointSlopes(samples);

  // Alphabetical kind order.
  expect(byKind.map((s) => s.kind)).toEqual(["A", "B"]);

  const a = byKind[0];
  expect(a?.first.n).toBe(2);
  expect(a?.second.n).toBe(2);
  expect(a?.p95SlopePct).toBeCloseTo(100, 6);
  expect(a?.offender).toBe(true);

  const b = byKind[1];
  expect(b?.p95SlopePct).toBeCloseTo(0, 6);
  expect(b?.offender).toBe(false);

  // Overall: first half all 1s (p95 1), second half {2,2,1,1} (p95 2).
  expect(overall.first.p95).toBe(1);
  expect(overall.second.p95).toBe(2);
  expect(overall.p95SlopePct).toBeCloseTo(100, 6);
  expect(overall.offender).toBe(true);
});

test("twoPointSlopes: an empty corpus produces an uncomputable overall slope", () => {
  const { overall, byKind } = twoPointSlopes([]);
  expect(byKind).toHaveLength(0);
  expect(overall.first.n).toBe(0);
  expect(overall.p95SlopePct).toBeNull();
  expect(overall.offender).toBe(false);
});

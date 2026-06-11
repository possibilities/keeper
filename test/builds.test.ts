/**
 * Renderer unit tests for `cli/builds.ts` — the pure, exported row layout
 * the live shell and snapshot path both consume. One case per buildbot
 * result code (0-6) plus the synthetic RUNNING state, so a regression in
 * the status mapping or the age rendering fails here in the fast tier
 * rather than only end-to-end.
 *
 * The view-shell / CLI process path (mode resolution, dispose-then-exit,
 * trailer shape) is shared with `cli/git.ts` and exercised slow-tier in
 * `test/git.test.ts`; the dispatch route for `keeper builds` is covered in
 * `test/keeper-cli.test.ts`. This file owns the pure renderers only.
 *
 * `now` is injected into every renderer call so age is deterministic — the
 * wall-clock read lives at the production call site (`Date.now()`), never
 * inside the pure function.
 */

import { expect, test } from "bun:test";
import {
  formatAge,
  renderRow,
  renderRowLines,
  resolveStatus,
} from "../cli/builds";

// Fixed reference clock (ms epoch). Rows stamp `updated_at` in SECONDS
// (the reducer copies the event `ts`), so a row 5s old has
// `updated_at = NOW_MS/1000 - 5`.
const NOW_MS = 1_700_000_000_000;
const NOW_S = NOW_MS / 1000;

/** A builds row a few seconds old. */
function freshRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    project: "alpha",
    builder_id: 1,
    build_number: 42,
    complete: 1,
    results: 0,
    state_string: "build successful",
    updated_at: NOW_S - 5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveStatus: one case per buildbot result code + RUNNING + unknown.
// ---------------------------------------------------------------------------

test("resolveStatus: all seven buildbot result codes map to distinct labels", () => {
  const labels = [0, 1, 2, 3, 4, 5, 6].map(
    (results) => resolveStatus({ results, complete: 1 }).label,
  );
  expect(labels).toEqual([
    "SUCCESS",
    "WARNINGS",
    "FAILURE",
    "SKIPPED",
    "EXCEPTION",
    "RETRY",
    "CANCELLED",
  ]);
  // All distinct — no two codes collapse to the same label.
  expect(new Set(labels).size).toBe(7);
});

test("resolveStatus: results NULL + complete falsy is RUNNING, not an error", () => {
  expect(resolveStatus({ results: null, complete: 0 }).label).toBe("RUNNING");
  // `complete` absent (undefined) is also in-flight.
  expect(resolveStatus({ results: null }).label).toBe("RUNNING");
});

test("resolveStatus: an out-of-range / non-numeric code degrades to UNKNOWN", () => {
  expect(resolveStatus({ results: 99, complete: 1 }).label).toBe("UNKNOWN");
  expect(resolveStatus({ results: "2", complete: 1 }).label).toBe("UNKNOWN");
});

// ---------------------------------------------------------------------------
// renderRow: one line per project — glyph, name, #number, label, state, age.
// ---------------------------------------------------------------------------

test("renderRow: SUCCESS row carries project, build number, label, state, age", () => {
  const line = renderRow(freshRow({}), NOW_MS);
  expect(line).toContain("alpha");
  expect(line).toContain("#42");
  expect(line).toContain("SUCCESS");
  expect(line).toContain("build successful");
  expect(line).toContain("5s");
});

test("renderRow: RUNNING row renders distinctly", () => {
  const line = renderRow(
    freshRow({ results: null, complete: 0, state_string: "building" }),
    NOW_MS,
  );
  expect(line).toContain("RUNNING");
  expect(line).toContain("building");
  expect(line).not.toContain("SUCCESS");
});

test("renderRow: each result code produces a distinct rendered line", () => {
  const lines = [0, 1, 2, 3, 4, 5, 6].map((results) =>
    renderRow(freshRow({ results, complete: 1 }), NOW_MS),
  );
  // RUNNING line too — eight distinct renders total.
  lines.push(renderRow(freshRow({ results: null, complete: 0 }), NOW_MS));
  expect(new Set(lines).size).toBe(8);
});

test("renderRow: an older row renders its age in minutes", () => {
  const line = renderRow(freshRow({ updated_at: NOW_S - 120 }), NOW_MS);
  expect(line).toContain("2m");
});

test("renderRow: a missing build number renders #? not a crash", () => {
  const line = renderRow(freshRow({ build_number: null }), NOW_MS);
  expect(line).toContain("#?");
});

// ---------------------------------------------------------------------------
// formatAge: compact whole-unit humanization with a `?` guard.
// ---------------------------------------------------------------------------

test("formatAge: seconds/minutes/hours/days thresholds", () => {
  expect(formatAge(5_000)).toBe("5s");
  expect(formatAge(90_000)).toBe("1m");
  expect(formatAge(3 * 3_600_000)).toBe("3h");
  expect(formatAge(2 * 86_400_000)).toBe("2d");
});

test("formatAge: negative / non-finite age renders `?`", () => {
  expect(formatAge(-1)).toBe("?");
  expect(formatAge(Number.NaN)).toBe("?");
});

// ---------------------------------------------------------------------------
// renderRowLines: empty table hint + one line per row, sort-order preserved.
// ---------------------------------------------------------------------------

test("renderRowLines: empty table renders the configure hint", () => {
  const lines = renderRowLines([], NOW_MS);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("no builds yet");
  expect(lines[0]).toContain("buildbot_url");
});

test("renderRowLines: one line per row in wire order", () => {
  const lines = renderRowLines(
    [
      freshRow({ project: "alpha", results: 0 }),
      freshRow({ project: "beta", results: 2 }),
    ],
    NOW_MS,
  );
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain("alpha");
  expect(lines[0]).toContain("SUCCESS");
  expect(lines[1]).toContain("beta");
  expect(lines[1]).toContain("FAILURE");
});

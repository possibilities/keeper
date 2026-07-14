/**
 * Renderer unit tests for `cli/builds.ts` — the pure, exported row layout
 * the live shell and snapshot path both consume. One case per buildbot
 * result code (0-6) plus the synthetic RUNNING state, so a regression in
 * the status mapping or the age rendering fails here in the fast tier
 * rather than only end-to-end.
 *
 * The view-shell / CLI process path (mode resolution, dispose-then-exit,
 * trailer shape) is shared with `cli/git.ts` and exercised through injected seams in
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
  resolveJobType,
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
    (results) =>
      resolveStatus({ build_number: 42, results, complete: 1 }).label,
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
  // A real running build always carries a build_number — that's what
  // distinguishes it from the never-built placeholder (checked first).
  expect(
    resolveStatus({ build_number: 5, results: null, complete: 0 }).label,
  ).toBe("RUNNING");
  // `complete` absent (undefined) is also in-flight.
  expect(resolveStatus({ build_number: 5, results: null }).label).toBe(
    "RUNNING",
  );
});

test("resolveStatus: NULL build_number is `never built`, checked before RUNNING", () => {
  // The all-null placeholder: build_number AND results both NULL. The
  // never-built branch fires FIRST, so it never collapses into RUNNING.
  expect(resolveStatus({ build_number: null, results: null }).label).toBe(
    "never built",
  );
  expect(
    resolveStatus({ build_number: null, results: null, complete: null }).label,
  ).toBe("never built");
  // Glyph is ASCII-safe and distinct from running (~), unknown (?), skipped (-).
  const glyph = resolveStatus({ build_number: null }).glyph;
  expect(glyph).not.toBe("~");
  expect(glyph).not.toBe("?");
  expect(glyph).not.toBe("-");
  expect(/^[\x20-\x7e]+$/.test(glyph)).toBe(true);
});

test("resolveStatus: an out-of-range / non-numeric code degrades to UNKNOWN", () => {
  expect(
    resolveStatus({ build_number: 1, results: 99, complete: 1 }).label,
  ).toBe("UNKNOWN");
  expect(
    resolveStatus({ build_number: 1, results: "2", complete: 1 }).label,
  ).toBe("UNKNOWN");
});

// ---------------------------------------------------------------------------
// resolveJobType: builder-name suffix → deploy / install / build (epic fn-891).
// ---------------------------------------------------------------------------

test("resolveJobType: suffix derives deploy/install/build (doctor → install)", () => {
  expect(resolveJobType("foo")).toBe("build");
  expect(resolveJobType("foo-deploy")).toBe("deploy");
  expect(resolveJobType("foo-install")).toBe("install");
  expect(resolveJobType("foo-doctor")).toBe("install");
  // Unsuffixed / empty falls through to build.
  expect(resolveJobType("")).toBe("build");
});

test("renderRow: each job type renders a distinct ASCII-safe tag", () => {
  const lines = ["foo", "foo-deploy", "foo-install", "foo-doctor"].map(
    (project) => renderRow(freshRow({ project }), NOW_MS),
  );
  expect(lines[0]).toContain("[build]");
  expect(lines[1]).toContain("[deploy]");
  expect(lines[2]).toContain("[install]");
  // doctor folds into the install family.
  expect(lines[3]).toContain("[install]");
  // build / deploy / install render as three distinct tags.
  expect(new Set(lines.map((l) => /\[(\w+)\]/.exec(l)?.[1])).size).toBe(3);
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

test("renderRow: a never-built (NULL build_number) row renders `never built`, distinct from every other status", () => {
  // The all-null placeholder: build_number AND results NULL.
  const neverBuiltLine = renderRow(
    freshRow({
      build_number: null,
      results: null,
      complete: null,
      state_string: "never built",
    }),
    NOW_MS,
  );
  expect(neverBuiltLine).toContain("never built");
  expect(neverBuiltLine).toContain("#?");
  expect(neverBuiltLine).not.toContain("RUNNING");
  expect(neverBuiltLine).not.toContain("UNKNOWN");
  // Distinct from RUNNING + all seven result codes — nine distinct renders.
  const others = [0, 1, 2, 3, 4, 5, 6].map((results) =>
    renderRow(freshRow({ results, complete: 1 }), NOW_MS),
  );
  others.push(renderRow(freshRow({ results: null, complete: 0 }), NOW_MS));
  expect(new Set([...others, neverBuiltLine]).size).toBe(9);
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

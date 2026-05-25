/**
 * Plan-classifier parity tests. Loads the golden fixture at
 * `test/fixtures/plan_classifier_cases.jsonl` (regenerated from the Python
 * source by `scripts/gen-plan-classifier-fixture.py`) and asserts that the
 * TS port (`src/plan-classifier.ts`) produces byte-identical output per
 * case.
 *
 * The strategy mirrors the epic's "Best practices" section: a Python script
 * imports jobctl's source-of-truth derivers and writes one JSONL line per
 * case; this test loads the file and compares the TS port's output to the
 * captured `expected` array. A future Python-side change that breaks parity
 * surfaces as a regeneration diff (deliberate, never auto).
 *
 * Fixture row shape (mode-tagged):
 * - `mode: "epic_links"` — `{desc, openers, invocations, windows, expected}`.
 *   `windows` is included for cross-check against {@link computePlanWindows}.
 * - `mode: "job_links"` — `{desc, epic_id, sessions, windows_by_session, expected}`.
 *
 * Each `desc` is wired into the test name so a failing case lands an
 * unambiguous Bun-test label.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type ClassifierInvocation,
  computePlanWindows,
  deriveEpicLinks,
  deriveJobLinks,
  MAX_TS_SENTINEL,
  type PlanWindow,
} from "../src/plan-classifier";

// ---------------------------------------------------------------------------
// Fixture loader
// ---------------------------------------------------------------------------

interface EpicLinkFixture {
  desc: string;
  mode: "epic_links";
  openers: number[];
  invocations: ClassifierInvocation[];
  windows: [number, number][];
  expected: { kind: string; target: string }[];
}

interface JobLinkFixture {
  desc: string;
  mode: "job_links";
  epic_id: string;
  sessions: Record<
    string,
    { openers: number[]; invocations: ClassifierInvocation[] }
  >;
  windows_by_session: Record<string, [number, number][]>;
  expected: { kind: string; job_id: string }[];
}

type Fixture = EpicLinkFixture | JobLinkFixture;

function loadFixtures(): Fixture[] {
  const fixturePath = path.join(
    import.meta.dir,
    "fixtures",
    "plan_classifier_cases.jsonl",
  );
  const text = readFileSync(fixturePath, "utf-8");
  const rows: Fixture[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    rows.push(JSON.parse(line) as Fixture);
  }
  return rows;
}

const FIXTURES = loadFixtures();
const EPIC_FIXTURES = FIXTURES.filter(
  (f): f is EpicLinkFixture => f.mode === "epic_links",
);
const JOB_FIXTURES = FIXTURES.filter(
  (f): f is JobLinkFixture => f.mode === "job_links",
);

// ---------------------------------------------------------------------------
// Sanity gates on the fixture itself — guard against an empty/corrupt file
// silently passing every test.
// ---------------------------------------------------------------------------

test("fixture file loads with the expected scale", () => {
  // Acceptance: >= 10 distinct edge cases enumerated. We ship more.
  expect(FIXTURES.length).toBeGreaterThanOrEqual(10);
  expect(EPIC_FIXTURES.length).toBeGreaterThan(0);
  expect(JOB_FIXTURES.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// computePlanWindows — cross-check against the Python's window output.
// ---------------------------------------------------------------------------

describe("computePlanWindows parity", () => {
  for (const f of EPIC_FIXTURES) {
    test(f.desc, () => {
      const got = computePlanWindows(f.openers);
      // PlanWindow is a readonly tuple — translate to plain array pairs for
      // deep-equality matching against the Python's seconds-shaped output.
      const gotPlain = got.map(([s, e]) => [s, e]);
      expect(gotPlain).toEqual(f.windows);
    });
  }
});

test("computePlanWindows MAX_TS_SENTINEL matches Number.MAX_SAFE_INTEGER", () => {
  // Re-fold determinism + SQLite-no-infinity invariant — guard against any
  // future refactor pinning MAX_TS_SENTINEL to JS Infinity.
  expect(MAX_TS_SENTINEL).toBe(Number.MAX_SAFE_INTEGER);
});

// ---------------------------------------------------------------------------
// deriveEpicLinks parity — every epic_links fixture, byte-for-byte.
// ---------------------------------------------------------------------------

describe("deriveEpicLinks parity", () => {
  for (const f of EPIC_FIXTURES) {
    test(f.desc, () => {
      // Build the readonly PlanWindow[] shape the TS API expects.
      const windows: PlanWindow[] = f.windows.map(
        ([s, e]) => [s, e] as PlanWindow,
      );
      const got = deriveEpicLinks(f.invocations, windows);
      expect(got).toEqual(
        f.expected as { kind: "creator" | "refiner"; target: string }[],
      );
    });
  }
});

// ---------------------------------------------------------------------------
// deriveJobLinks parity — every job_links fixture, byte-for-byte.
// ---------------------------------------------------------------------------

describe("deriveJobLinks parity", () => {
  for (const f of JOB_FIXTURES) {
    test(f.desc, () => {
      const invocationsBySession = new Map<string, ClassifierInvocation[]>();
      const windowsBySession = new Map<string, PlanWindow[]>();
      for (const [jobId, payload] of Object.entries(f.sessions)) {
        invocationsBySession.set(jobId, payload.invocations);
        const wins = (f.windows_by_session[jobId] ?? []).map(
          ([s, e]) => [s, e] as PlanWindow,
        );
        windowsBySession.set(jobId, wins);
      }
      const got = deriveJobLinks(
        invocationsBySession,
        windowsBySession,
        f.epic_id,
      );
      expect(got).toEqual(
        f.expected as { kind: "creator" | "refiner"; job_id: string }[],
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Targeted unit-tests — defensive behaviour that the Python parity doesn't
// reach (TS port adds explicit non-finite/NaN guards).
// ---------------------------------------------------------------------------

test("computePlanWindows drops non-finite opener timestamps", () => {
  expect(
    computePlanWindows([Number.NaN, Number.POSITIVE_INFINITY, 100]),
  ).toEqual([[100, MAX_TS_SENTINEL]]);
});

test("deriveEpicLinks returns empty on zero windows", () => {
  const got = deriveEpicLinks(
    [
      {
        ts: 100,
        op: "create",
        target: "fn-1-foo",
        epic_id: "fn-1-foo",
        subject_present: true,
      },
    ],
    [],
  );
  expect(got).toEqual([]);
});

test("deriveJobLinks returns empty on zero-session map", () => {
  const got = deriveJobLinks(new Map(), new Map(), "fn-1-foo");
  expect(got).toEqual([]);
});

// ---------------------------------------------------------------------------
// Keeper-only divergence: scaffold-as-creator. The Python audit layer does
// NOT recognize scaffold; keeper's classifier is strictly richer because
// scaffold is the canonical epic-create path on this codebase.
// ---------------------------------------------------------------------------

test("deriveEpicLinks accepts op='scaffold' with an epic-shaped target as a creator", () => {
  const windows: PlanWindow[] = [[100, MAX_TS_SENTINEL]];
  const got = deriveEpicLinks(
    [
      {
        ts: 150,
        op: "scaffold",
        target: "fn-606-envelope-driven-planctl-op-deriver",
        epic_id: "fn-606-envelope-driven-planctl-op-deriver",
        subject_present: true,
      },
    ],
    windows,
  );
  expect(got).toEqual([
    {
      kind: "creator",
      target: "fn-606-envelope-driven-planctl-op-deriver",
    },
  ]);
});

test("deriveEpicLinks: per-window suppression holds when both create and scaffold fire in the same window", () => {
  // Within one window, a creator-of-X (whether `create` or `scaffold`)
  // suppresses any same-window refiner-of-X. Both creator entries
  // dedupe at the (kind, target) seen-set; only one edge survives.
  const windows: PlanWindow[] = [[100, MAX_TS_SENTINEL]];
  const got = deriveEpicLinks(
    [
      {
        ts: 110,
        op: "scaffold",
        target: "fn-1-foo",
        epic_id: "fn-1-foo",
        subject_present: true,
      },
      {
        ts: 120,
        op: "epic-set-title",
        target: "fn-1-foo",
        epic_id: "fn-1-foo",
        subject_present: true,
      },
      {
        ts: 130,
        op: "create",
        target: "fn-1-foo",
        epic_id: "fn-1-foo",
        subject_present: true,
      },
    ],
    windows,
  );
  // One creator edge — refiner-of-fn-1-foo is suppressed in the same window.
  expect(got).toEqual([{ kind: "creator", target: "fn-1-foo" }]);
});

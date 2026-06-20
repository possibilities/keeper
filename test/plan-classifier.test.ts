/**
 * Plan-classifier golden tests. Loads the fixture at
 * `test/fixtures/plan_classifier_cases.jsonl` and asserts that the windowless
 * classifier (`src/plan-classifier.ts`) produces byte-identical output per case.
 *
 * The fixture is a HAND-EDITED golden — there is no generator. Each `expected`
 * array is hand-computed from the case's invocation log under the windowless
 * rules: every epic-mutating op links (creator = {create, scaffold} with an
 * epic-shaped target; refiner = any other mutating op naming an epic), gated
 * only by the read-only `subject_present === false` skip, with per-session
 * creator-suppression keyed on target/epic. Update the JSONL by hand if the
 * classifier's behavior deliberately changes.
 *
 * Fixture row shape (mode-tagged):
 * - `mode: "epic_links"` — `{desc, invocations, expected}`.
 * - `mode: "job_links"` — `{desc, epic_id, sessions, expected}`.
 *
 * Each `desc` is wired into the test name so a failing case lands an
 * unambiguous Bun-test label.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type ClassifierInvocation,
  deriveEpicLinks,
  deriveJobLinks,
} from "../src/plan-classifier";

// ---------------------------------------------------------------------------
// Fixture loader
// ---------------------------------------------------------------------------

interface EpicLinkFixture {
  desc: string;
  mode: "epic_links";
  invocations: ClassifierInvocation[];
  expected: { kind: string; target: string }[];
}

interface JobLinkFixture {
  desc: string;
  mode: "job_links";
  epic_id: string;
  sessions: Record<string, { invocations: ClassifierInvocation[] }>;
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
// deriveEpicLinks — every epic_links fixture, byte-for-byte.
// ---------------------------------------------------------------------------

describe("deriveEpicLinks", () => {
  for (const f of EPIC_FIXTURES) {
    test(f.desc, () => {
      const got = deriveEpicLinks(f.invocations);
      expect(got).toEqual(
        f.expected as { kind: "creator" | "refiner"; target: string }[],
      );
    });
  }
});

// ---------------------------------------------------------------------------
// deriveJobLinks — every job_links fixture, byte-for-byte.
// ---------------------------------------------------------------------------

describe("deriveJobLinks", () => {
  for (const f of JOB_FIXTURES) {
    test(f.desc, () => {
      const invocationsBySession = new Map<string, ClassifierInvocation[]>();
      for (const [jobId, payload] of Object.entries(f.sessions)) {
        invocationsBySession.set(jobId, payload.invocations);
      }
      const got = deriveJobLinks(invocationsBySession, f.epic_id);
      expect(got).toEqual(
        f.expected as { kind: "creator" | "refiner"; job_id: string }[],
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Targeted unit-tests — defensive behaviour and the windowless invariants the
// fixture cases anchor.
// ---------------------------------------------------------------------------

test("deriveEpicLinks returns empty on no invocations", () => {
  expect(deriveEpicLinks([])).toEqual([]);
});

test("deriveJobLinks returns empty on zero-session map", () => {
  expect(deriveJobLinks(new Map(), "fn-1-foo")).toEqual([]);
});

test("deriveEpicLinks drops malformed / non-finite-ts entries without throwing", () => {
  const got = deriveEpicLinks([
    // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed input.
    null as any,
    {
      ts: Number.NaN,
      op: "create",
      target: "fn-1-foo",
      epic_id: "fn-1-foo",
      subject_present: true,
    },
    {
      ts: 100,
      op: "create",
      target: "fn-2-bar",
      epic_id: "fn-2-bar",
      subject_present: true,
    },
  ]);
  expect(got).toEqual([{ kind: "creator", target: "fn-2-bar" }]);
});

// ---------------------------------------------------------------------------
// Scaffold-as-creator. Scaffold is the canonical epic-create path on this
// codebase (zero `epic-create` events have ever fired), so it is recognized as
// a creator alongside `create`.
// ---------------------------------------------------------------------------

test("deriveEpicLinks accepts op='scaffold' with an epic-shaped target as a creator", () => {
  const got = deriveEpicLinks([
    {
      ts: 150,
      op: "scaffold",
      target: "fn-606-envelope-driven-planctl-op-deriver",
      epic_id: "fn-606-envelope-driven-planctl-op-deriver",
      subject_present: true,
    },
  ]);
  expect(got).toEqual([
    {
      kind: "creator",
      target: "fn-606-envelope-driven-planctl-op-deriver",
    },
  ]);
});

test("deriveEpicLinks: per-session suppression holds when both create and scaffold fire", () => {
  // A creator-of-X (whether `create` or `scaffold`) suppresses a later
  // refiner-of-X in the same session. Both creator entries dedupe at the
  // (kind, target) seen-set; only one creator edge survives.
  const got = deriveEpicLinks([
    {
      ts: 110,
      op: "scaffold",
      target: "fn-1-foo",
      epic_id: "fn-1-foo",
      subject_present: true,
    },
    {
      ts: 120,
      op: "set-title",
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
  ]);
  expect(got).toEqual([{ kind: "creator", target: "fn-1-foo" }]);
});

// ---------------------------------------------------------------------------
// Total-order sort: a `ts`-tie between a creator and a refiner of the same
// epic resolves DETERMINISTICALLY via the `event_id` tiebreak, regardless of
// the input array order. Locks the re-fold-determinism requirement.
// ---------------------------------------------------------------------------

test("deriveEpicLinks: same-ts create vs set-title resolves deterministically by event_id (both array orders agree)", () => {
  const create: ClassifierInvocation = {
    ts: 100,
    event_id: 1,
    op: "create",
    target: "fn-1-foo",
    epic_id: "fn-1-foo",
    subject_present: true,
  };
  const setTitle: ClassifierInvocation = {
    ts: 100,
    event_id: 2,
    op: "set-title",
    target: "fn-1-foo",
    epic_id: "fn-1-foo",
    subject_present: true,
  };
  // event_id=1 (create) sorts before event_id=2 (set-title) on the ts-tie, so
  // the creator fires first and suppresses the refiner — in BOTH input orders.
  const forward = deriveEpicLinks([create, setTitle]);
  const reversed = deriveEpicLinks([setTitle, create]);
  expect(forward).toEqual([{ kind: "creator", target: "fn-1-foo" }]);
  expect(reversed).toEqual(forward);
});

test("deriveJobLinks: same-ts tie resolves deterministically by event_id across array orders", () => {
  const create: ClassifierInvocation = {
    ts: 100,
    event_id: 1,
    op: "create",
    target: "fn-1-foo",
    epic_id: "fn-1-foo",
    subject_present: true,
  };
  const setTitle: ClassifierInvocation = {
    ts: 100,
    event_id: 2,
    op: "set-title",
    target: "fn-1-foo",
    epic_id: "fn-1-foo",
    subject_present: true,
  };
  const forward = deriveJobLinks(
    new Map([["sess-a", [create, setTitle]]]),
    "fn-1-foo",
  );
  const reversed = deriveJobLinks(
    new Map([["sess-a", [setTitle, create]]]),
    "fn-1-foo",
  );
  expect(forward).toEqual([{ kind: "creator", job_id: "sess-a" }]);
  expect(reversed).toEqual(forward);
});

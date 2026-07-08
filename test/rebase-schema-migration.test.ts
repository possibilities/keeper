/**
 * Pure fast-tier tests for the merge-time schema renumber tool. The core
 * `apply(main, lane)` is driven directly over synthetic file CONTENTS — no git,
 * no fs, no real db.ts — so this is a fast-tier file. The one impure re-pin
 * helper is exercised via `openDb(":memory:")` (in-process migrate, fast-tier
 * legal).
 *
 * Expected values come from an independent source of truth: hand-authored
 * fixtures whose intended shift is computed by hand here, and the committed
 * `SCHEMA_FINGERPRINT` constant for the re-pin round-trip — never re-derived by
 * the tool's own path.
 */
import { expect, test } from "bun:test";
import {
  apply,
  applyFingerprintRepin,
  computeRepinnedFingerprint,
  type FileSet,
  parseLadder,
} from "../scripts/rebase-schema-migration";
import { SCHEMA_FINGERPRINT } from "../src/db";

// --- fixture builders --------------------------------------------------------

/** A clean additive step adding one column — the renumberable base case. */
const additive = (version: number, col: string): string =>
  `  { version: ${version}, kind: "additive", apply: (ctx) => { addColumnIfMissing(ctx.db, "jobs", "${col}", "TEXT"); } },`;

/** An entry with an arbitrary kind and body, for refusal fixtures. */
const rawStep = (version: number, kind: string, body: string): string =>
  `  { version: ${version}, kind: "${kind}", apply: (ctx) => { ${body} } },`;

const dbFile = (...steps: string[]): string =>
  `export const SCHEMA_STEPS = [\n${steps.join("\n")}\n];\n` +
  `export const SCHEMA_FINGERPRINT =\n  "v3:0000";\n`;

const fileset = (
  db: string,
  apiPy = "",
  tests: Record<string, string> = {},
): FileSet => ({ db, apiPy, tests });

// --- parser -----------------------------------------------------------------

test("parseLadder extracts version, kind, and body for each entry", () => {
  const src = dbFile(
    additive(2, "a"),
    rawStep(3, "drop", 'dropColumnIfPresent(ctx.db, "jobs", "x");'),
  );
  const steps = parseLadder(src);
  expect(steps.map((s) => s.version)).toEqual([2, 3]);
  expect(steps.map((s) => s.kind)).toEqual(["additive", "drop"]);
  expect(steps[1].bodyText).toContain("dropColumnIfPresent");
});

// --- happy path --------------------------------------------------------------

test("renumbers a single colliding additive lane step onto main-tip+1", () => {
  const main = fileset(
    dbFile(additive(2, "a"), additive(3, "b")),
    "SUPPORTED_SCHEMA_VERSIONS = frozenset({2, 3})",
  );
  const lane = fileset(
    dbFile(additive(2, "a"), additive(3, "c")),
    "SUPPORTED_SCHEMA_VERSIONS = frozenset({2, 3})",
    {
      "t.test.ts": [
        "expect(SCHEMA_VERSION).toBe(3);",
        'const fp = "v3:abc";',
        "expect(unrelated).toBe(99);",
      ].join("\n"),
    },
  );

  const r = apply(main, lane);
  expect(r.refused).toBe(false);
  if (r.refused) return;

  // main tail is 3, so the lane's colliding step 3 moves to 4.
  expect(r.shifts).toEqual([{ from: 3, to: 4 }]);

  // ladder entry: the lane's "c" step now sits at version 4.
  const moved = parseLadder(r.files.db).find((s) => s.bodyText.includes('"c"'));
  expect(moved?.version).toBe(4);

  // whitelist expectation shifts 3 -> 4.
  expect(r.files.apiPy).toContain("frozenset({2, 4})");

  // pinned version assertions shift; the unrelated toBe(99) is left alone.
  const t = r.files.tests["t.test.ts"];
  expect(t).toContain("toBe(4)");
  expect(t).toContain('"v4:abc"');
  expect(t).toContain("toBe(99)");
});

test("shifts a multi-step lane preserving relative order", () => {
  const main = fileset(dbFile(additive(2, "a"), additive(3, "b")));
  const lane = fileset(
    dbFile(additive(2, "a"), additive(3, "c"), additive(4, "d")),
  );

  const r = apply(main, lane);
  expect(r.refused).toBe(false);
  if (r.refused) return;

  expect(r.shifts).toEqual([
    { from: 3, to: 4 },
    { from: 4, to: 5 },
  ]);
  const steps = parseLadder(r.files.db);
  expect(steps.find((s) => s.bodyText.includes('"c"'))?.version).toBe(4);
  expect(steps.find((s) => s.bodyText.includes('"d"'))?.version).toBe(5);
});

// --- refusal cases -----------------------------------------------------------

/** main tail is 3, so a lane step at version 3 always collides and is gated. */
const refusalCase = (kind: string, body: string) =>
  apply(
    fileset(dbFile(additive(2, "a"), additive(3, "b"))),
    fileset(dbFile(additive(2, "a"), rawStep(3, kind, body))),
  );

test("refuses a rewind-kind colliding step", () => {
  const r = refusalCase("rewind", 'ctx.db.run("PRAGMA x");');
  expect(r.refused).toBe(true);
  if (!r.refused) return;
  expect(r.reason).toBe("rewind");
  expect(r.step).toBe(3);
});

test("refuses a drop-kind colliding step", () => {
  const r = refusalCase("drop", 'ctx.db.run("PRAGMA x");');
  expect(r.refused).toBe(true);
  if (!r.refused) return;
  expect(r.reason).toBe("drop");
});

test("refuses a backfill-kind colliding step", () => {
  const r = refusalCase("backfill", 'ctx.db.run("PRAGMA x");');
  expect(r.refused).toBe(true);
  if (!r.refused) return;
  expect(r.reason).toBe("backfill");
});

test("refuses an unknown/noop kind as not provably additive", () => {
  const r = refusalCase("noop", "");
  expect(r.refused).toBe(true);
  if (!r.refused) return;
  expect(r.reason).toBe("unknown");
});

test("refuses an additive step whose body inlines a CREATE TABLE literal", () => {
  const r = refusalCase(
    "additive",
    'ctx.db.run("CREATE TABLE foo (id INTEGER)");',
  );
  expect(r.refused).toBe(true);
  if (!r.refused) return;
  expect(r.reason).toBe("create-literal");
});

test("refuses a mislabeled additive body that runs UPDATE (backfill in disguise)", () => {
  const r = refusalCase("additive", 'ctx.db.run("UPDATE jobs SET x = 1");');
  expect(r.refused).toBe(true);
  if (!r.refused) return;
  expect(r.reason).toBe("backfill");
});

test("refuses a mislabeled additive body that drops a column", () => {
  const r = refusalCase(
    "additive",
    'dropColumnIfPresent(ctx.db, "jobs", "x");',
  );
  expect(r.refused).toBe(true);
  if (!r.refused) return;
  expect(r.reason).toBe("drop");
});

test("an additive body whose COMMENTS name destructive ops is NOT refused", () => {
  // The proof point: real historical additive steps carry comments that mention
  // DELETE / cursor rewind / UPDATE to say what they do NOT do. A comment-stripped
  // (token-based) denylist must let them through.
  const body = [
    "// no DELETE here, no cursor rewind, no UPDATE, never a DROP TABLE — comments only",
    'addColumnIfMissing(ctx.db, "jobs", "c", "TEXT");',
  ].join("\n");
  const r = apply(
    fileset(dbFile(additive(2, "a"), additive(3, "b"))),
    fileset(dbFile(additive(2, "a"), rawStep(3, "additive", body))),
  );
  expect(r.refused).toBe(false);
  if (r.refused) return;
  expect(r.shifts).toEqual([{ from: 3, to: 4 }]);
});

test("refuses a coincidental identical-content collision instead of deduping", () => {
  const dup = 'addColumnIfMissing(ctx.db, "jobs", "z", "TEXT");';
  const main = fileset(
    dbFile(additive(2, "a"), additive(3, "b"), rawStep(4, "additive", dup)),
  );
  const lane = fileset(
    dbFile(additive(2, "a"), additive(3, "c"), rawStep(4, "additive", dup)),
  );
  const r = apply(main, lane);
  expect(r.refused).toBe(true);
  if (!r.refused) return;
  expect(r.reason).toBe("identical-content");
  expect(r.step).toBe(4);
});

// --- idempotency -------------------------------------------------------------

test("applying twice is a no-op — the second run finds no branch-local steps", () => {
  const main = fileset(dbFile(additive(2, "a"), additive(3, "b")));
  const lane = fileset(dbFile(additive(2, "a"), additive(3, "c")));

  const first = apply(main, lane);
  expect(first.refused).toBe(false);
  if (first.refused) return;
  expect(first.shifts.length).toBeGreaterThan(0);

  const second = apply(main, first.files);
  expect(second.refused).toBe(false);
  if (second.refused) return;
  expect(second.shifts).toEqual([]);
  // the already-renumbered lane is returned byte-unchanged.
  expect(second.files.db).toBe(first.files.db);
});

// --- fingerprint re-pin (impure helper, in-process) --------------------------

test("computeRepinnedFingerprint recomputes the live schema fingerprint in-process", () => {
  const fp = computeRepinnedFingerprint();
  expect(fp).toMatch(/^v\d+:[0-9a-f]{64}$/);
  // independent truth: the hand-pinned constant committed in src/db.ts.
  expect(fp).toBe(SCHEMA_FINGERPRINT);
});

test("applyFingerprintRepin replaces the SCHEMA_FINGERPRINT literal", () => {
  const single = 'export const SCHEMA_FINGERPRINT = "v3:old";\n';
  const singleOut = applyFingerprintRepin(single, "v4:new");
  expect(singleOut).toContain('"v4:new"');
  expect(singleOut).not.toContain("v3:old");

  // the real db.ts wraps the literal onto the next line — must match too.
  const multi = 'export const SCHEMA_FINGERPRINT =\n  "v3:old";\n';
  const multiOut = applyFingerprintRepin(multi, "v4:new");
  expect(multiOut).toContain('"v4:new"');
  expect(multiOut).not.toContain("v3:old");
});

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
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  apply,
  applyFingerprintRepin,
  computeRepinnedFingerprint,
  type FileSet,
  parseLadder,
} from "../scripts/rebase-schema-migration";
import { openDb, SCHEMA_FINGERPRINT } from "../src/db";

const REAL_DB_TS = join(import.meta.dir, "..", "src", "db.ts");

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

const fileset = (db: string, tests: Record<string, string> = {}): FileSet => ({
  db,
  tests,
});

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
  const main = fileset(dbFile(additive(2, "a"), additive(3, "b")));
  const lane = fileset(dbFile(additive(2, "a"), additive(3, "c")), {
    "t.test.ts": [
      "expect(SCHEMA_VERSION).toBe(3);",
      'const fp = "v3:abc";',
      "expect(unrelated).toBe(99);",
    ].join("\n"),
  });

  const r = apply(main, lane);
  expect(r.refused).toBe(false);
  if (r.refused) return;

  // main tail is 3, so the lane's colliding step 3 moves to 4.
  expect(r.shifts).toEqual([{ from: 3, to: 4 }]);

  // ladder entry: the lane's "c" step now sits at version 4.
  const moved = parseLadder(r.files.db).find((s) => s.bodyText.includes('"c"'));
  expect(moved?.version).toBe(4);

  // pinned version assertions shift; the unrelated toBe(99) is left alone.
  const t = r.files.tests["t.test.ts"];
  expect(t).toContain("toBe(4)");
  expect(t).toContain('"v4:abc"');
  expect(t).toContain("toBe(99)");
});

test("union-shaped ladder renumbers the local collision without mistaking later main steps for duplicates", () => {
  const mainDb = dbFile(
    additive(119, "account_route"),
    rawStep(120, "drop", 'ctx.db.run("PRAGMA main_drop");'),
    additive(121, "main_121"),
    additive(122, "main_122"),
  );
  // Recorded merge shape: main's complete v119..v122 ladder followed by the
  // lane's independently-authored v119. The old divergence walk sorted by
  // version, then falsely refused when it encountered main's own v120.
  const laneDb = dbFile(
    additive(119, "account_route"),
    rawStep(120, "drop", 'ctx.db.run("PRAGMA main_drop");'),
    additive(121, "main_121"),
    additive(122, "main_122"),
    additive(119, "lane_local"),
  );

  const r = apply(fileset(mainDb), fileset(laneDb));
  expect(r.refused).toBe(false);
  if (r.refused) return;
  expect(r.shifts).toEqual([{ from: 119, to: 123 }]);

  const steps = parseLadder(r.files.db);
  expect(
    steps.find((step) => step.bodyText.includes('"account_route"'))?.version,
  ).toBe(119);
  expect(
    steps.find((step) => step.bodyText.includes('"lane_local"'))?.version,
  ).toBe(123);

  const fingerprint = computeRepinnedFingerprint(r.files.db);
  expect(fingerprint).toBe(hashSchemaAt(123));
  const repinned = applyFingerprintRepin(r.files.db, fingerprint);
  expect(repinned).toContain(`"${fingerprint}"`);
  expect(repinned).not.toContain('"v3:0000"');
});

test("detects and renumbers a branch-local additive step in the middle of shared main entries", () => {
  const main = fileset(
    dbFile(additive(2, "a"), additive(3, "b"), additive(4, "c")),
  );
  const lane = fileset(
    dbFile(
      additive(2, "a"),
      additive(3, "lane_mid"),
      additive(3, "b"),
      additive(4, "c"),
    ),
  );

  const r = apply(main, lane);
  expect(r.refused).toBe(false);
  if (r.refused) return;
  expect(r.shifts).toEqual([{ from: 3, to: 5 }]);
  const steps = parseLadder(r.files.db);
  expect(steps.find((s) => s.bodyText.includes('"lane_mid"'))?.version).toBe(5);
  expect(steps.find((s) => s.bodyText.includes('"b"'))?.version).toBe(3);
  expect(steps.find((s) => s.bodyText.includes('"c"'))?.version).toBe(4);
});

test("absorbs a same-version same-body main step after a local collision", () => {
  const main = fileset(
    dbFile(additive(2, "a"), additive(3, "b"), additive(4, "shared")),
  );
  const lane = fileset(
    dbFile(
      additive(2, "a"),
      additive(3, "lane_local"),
      additive(3, "b"),
      additive(4, "shared"),
    ),
  );

  const r = apply(main, lane);
  expect(r.refused).toBe(false);
  if (r.refused) return;
  expect(r.shifts).toEqual([{ from: 3, to: 5 }]);
  expect(
    parseLadder(r.files.db).find((s) => s.bodyText.includes('"shared"'))
      ?.version,
  ).toBe(4);
});

test("shifts multiple local steps to tail+1..+k and rewrites fingerprint and test pins", () => {
  const main = fileset(
    dbFile(additive(2, "a"), additive(3, "b"), additive(4, "c")),
  );
  const lane = fileset(
    dbFile(
      additive(2, "a"),
      additive(3, "lane_first"),
      additive(3, "b"),
      additive(4, "c"),
      additive(4, "lane_second"),
    ),
    {
      "schema.test.ts": [
        "expect(SCHEMA_VERSION).toBe(4);",
        'const fingerprint = "v4:old";',
        "expect(unrelated).toBe(99);",
      ].join("\n"),
    },
  );

  const r = apply(main, lane);
  expect(r.refused).toBe(false);
  if (r.refused) return;
  expect(r.shifts).toEqual([
    { from: 3, to: 5 },
    { from: 4, to: 6 },
  ]);
  const steps = parseLadder(r.files.db);
  expect(steps.find((s) => s.bodyText.includes('"lane_first"'))?.version).toBe(
    5,
  );
  expect(steps.find((s) => s.bodyText.includes('"lane_second"'))?.version).toBe(
    6,
  );
  expect(steps.find((s) => s.bodyText.includes('"b"'))?.version).toBe(3);
  expect(steps.find((s) => s.bodyText.includes('"c"'))?.version).toBe(4);

  const rewrittenTest = r.files.tests["schema.test.ts"];
  expect(rewrittenTest).toContain("toBe(6)");
  expect(rewrittenTest).toContain('"v6:old"');
  expect(rewrittenTest).toContain("toBe(99)");

  const fingerprint = computeRepinnedFingerprint(r.files.db);
  expect(fingerprint).toBe(hashSchemaAt(6));
  expect(applyFingerprintRepin(r.files.db, fingerprint)).toContain(
    `"${fingerprint}"`,
  );
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

test("refuses the same body at a different version instead of silently deduping", () => {
  const main = fileset(dbFile(additive(2, "a"), additive(3, "same_body")));
  const lane = fileset(
    dbFile(
      additive(2, "a"),
      additive(3, "same_body"),
      additive(4, "same_body"),
    ),
  );
  const r = apply(main, lane);
  expect(r.refused).toBe(true);
  if (!r.refused) return;
  expect(r.reason).toBe("identical-content");
  expect(r.step).toBe(4);
});

test("still refuses a destructive branch-local step among later shared main entries", () => {
  const main = fileset(
    dbFile(additive(2, "a"), additive(3, "b"), additive(4, "c")),
  );
  const lane = fileset(
    dbFile(
      additive(2, "a"),
      rawStep(3, "drop", 'ctx.db.run("PRAGMA destructive_local");'),
      additive(3, "b"),
      additive(4, "c"),
    ),
  );
  const r = apply(main, lane);
  expect(r.refused).toBe(true);
  if (!r.refused) return;
  expect(r.reason).toBe("drop");
  expect(r.step).toBe(3);
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
  // no renumber in play: feed the real, already-consistent committed db.ts.
  const realDb = readFileSync(REAL_DB_TS, "utf8");
  const fp = computeRepinnedFingerprint(realDb);
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

// --- composed: renumber -> re-pin (F1 regression) ----------------------------

/** Directly reproduces `computeSchemaFingerprint`'s dump+hash algorithm
 * (src/db.ts) against a caller-supplied version, so the expected value below
 * is computed independently of `computeRepinnedFingerprint`'s own code path —
 * only the SQL dump query is shared (by necessity: it's the real live schema
 * shape), never the tail-version derivation under test. */
function hashSchemaAt(version: number): string {
  const { db } = openDb(":memory:");
  try {
    const rows = db
      .query(
        `SELECT type, name, sql FROM sqlite_master
          WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
          ORDER BY type, name`,
      )
      .all() as { type: string; name: string; sql: string }[];
    const dump = rows.map((r) => `${r.type}\t${r.name}\t${r.sql}`).join("\n");
    const hash = createHash("sha256")
      .update(`v${version}\n${dump}`)
      .digest("hex");
    return `v${version}:${hash}`;
  } finally {
    db.close();
  }
}

test("composed: renumbering a synthetic colliding lane re-pins a fingerprint consistent with the renumbered tail", () => {
  const realDb = readFileSync(REAL_DB_TS, "utf8");
  const realSteps = parseLadder(realDb);
  const lastStep = realSteps[realSteps.length - 1];
  const mainTail = lastStep.version;

  // Craft a lane that collides at the TIP: the real committed ladder as
  // "main", and a "lane" that independently added its own step reusing
  // main's tip version — the classic two-branches-both-picked-"next" merge
  // collision. Appended right after the real tail entry (not replacing it,
  // so the shared v2..mainTail prefix stays byte-identical and this is the
  // ONLY divergence) via `parseLadder`'s own `versionEnd` offset for the
  // real tail step, scanning forward to the array's closing `];` — the
  // first one after the last step's own body (verified fixture-side: the
  // real ladder's tail body contains no nested array literal to false-hit).
  const collideAt = mainTail;
  const extraStep = `  { version: ${collideAt}, kind: "additive", apply: (ctx) => { addColumnIfMissing(ctx.db, "jobs", "rebase_repin_regression_col", "TEXT"); } },`;
  const closeIdx = realDb.indexOf("\n];", lastStep.versionEnd);
  if (closeIdx < 0)
    throw new Error("could not locate SCHEMA_STEPS closing bracket");
  const laneDb = `${realDb.slice(0, closeIdx)}\n${extraStep}${realDb.slice(closeIdx)}`;

  const main: FileSet = { db: realDb, tests: {} };
  const lane: FileSet = { db: laneDb, tests: {} };

  const r = apply(main, lane);
  expect(r.refused).toBe(false);
  if (r.refused) return;
  expect(r.shifts).toEqual([{ from: collideAt, to: mainTail + 1 }]);

  const renumberedTail = parseLadder(r.files.db).reduce(
    (mx, s) => Math.max(mx, s.version),
    0,
  );
  expect(renumberedTail).toBe(mainTail + 1);

  const fp = computeRepinnedFingerprint(r.files.db);
  // from-scratch: independent recompute over the RENUMBERED tail. Before the
  // fix, computeRepinnedFingerprint pinned against the process-start
  // module's stale (pre-renumber) SCHEMA_VERSION — this fails against that.
  expect(fp).toBe(hashSchemaAt(renumberedTail));
});

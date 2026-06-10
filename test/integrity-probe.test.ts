/**
 * Periodic SQLite integrity probe tests (fn-746.1).
 *
 * Covers the task Acceptance:
 * - The PURE decision (`decideIntegrityProbe`): a single `ok` row → healthy /
 *   silent; a non-`ok` row, multiple rows, or zero rows → unhealthy with a
 *   capped page message naming the offending detail.
 * - The `runIntegrityProbe` wiring: an unhealthy probe LOGS + PAGES once; a
 *   healthy probe is SILENT (no page — corruption is the only signal); a probe
 *   that THROWS degrades to no-throw (logs, no page, treated non-fatal).
 * - The end-to-end PIN the spec requires: a deliberately-corrupted fixture DB
 *   trips the real read-only `liveQuickCheck` + pages; a HEALTHY real DB never
 *   pages. The probe is read-only (the writer connection is untouched).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideIntegrityProbe,
  type IntegrityProbeDeps,
  isCorruptionThrow,
  liveQuickCheck,
  QUICK_CHECK_OK,
  runIntegrityProbe,
} from "../src/integrity-probe";
import { freshDbFile } from "./helpers/template-db";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-integrity-probe-test-"));
  dbPath = join(tmpDir, "keeper.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure decision
// ---------------------------------------------------------------------------

test("decideIntegrityProbe: single `ok` row → healthy, silent", () => {
  const d = decideIntegrityProbe([QUICK_CHECK_OK]);
  expect(d.healthy).toBe(true);
  expect(d.pageMessage).toBeNull();
});

test("decideIntegrityProbe: a non-`ok` row → unhealthy with detail in the page", () => {
  const d = decideIntegrityProbe([
    "*** in database main ***\nPage 42: btree corrupt",
  ]);
  expect(d.healthy).toBe(false);
  expect(d.pageMessage).not.toBeNull();
  expect(d.pageMessage).toContain("quick_check FAILED");
  expect(d.pageMessage).toContain("Page 42");
});

test("decideIntegrityProbe: `ok` AMONG multiple rows is still unhealthy (must be the SOLE row)", () => {
  // A DB that reports `ok` plus extra rows is not healthy — healthy is exactly
  // one row equal to `ok`.
  const d = decideIntegrityProbe([QUICK_CHECK_OK, "row index foo is corrupt"]);
  expect(d.healthy).toBe(false);
  expect(d.pageMessage).toContain("row index foo is corrupt");
});

test("decideIntegrityProbe: zero rows → unhealthy (defensive — quick_check always returns a row)", () => {
  const d = decideIntegrityProbe([]);
  expect(d.healthy).toBe(false);
  expect(d.pageMessage).toContain("no rows");
});

test("decideIntegrityProbe: caps the detail so thousands of corrupt pages can't make a megabyte page", () => {
  const rows = Array.from({ length: 5000 }, (_, i) => `Page ${i}: corrupt`);
  const d = decideIntegrityProbe(rows);
  expect(d.healthy).toBe(false);
  expect(d.pageMessage).toContain("… and 4990 more");
  // The capped message is small — never proportional to the corrupt-page count.
  expect(d.pageMessage ?? "").not.toBe("");
  expect((d.pageMessage ?? "").length).toBeLessThan(2000);
});

// ---------------------------------------------------------------------------
// runIntegrityProbe wiring (injected deps — no real DB)
// ---------------------------------------------------------------------------

function spyDeps(quickCheck: () => string[]): {
  deps: IntegrityProbeDeps;
  pages: string[];
  logs: string[];
} {
  const pages: string[] = [];
  const logs: string[] = [];
  return {
    deps: {
      quickCheck,
      page: (m) => pages.push(m),
      log: (m) => logs.push(m),
    },
    pages,
    logs,
  };
}

test("runIntegrityProbe: healthy probe is SILENT — no page, no log", () => {
  const { deps, pages, logs } = spyDeps(() => [QUICK_CHECK_OK]);
  const d = runIntegrityProbe(deps);
  expect(d.healthy).toBe(true);
  expect(pages).toHaveLength(0);
  expect(logs).toHaveLength(0);
});

test("runIntegrityProbe: unhealthy probe LOGS and PAGES exactly once", () => {
  const { deps, pages, logs } = spyDeps(() => ["Page 7: malformed"]);
  const d = runIntegrityProbe(deps);
  expect(d.healthy).toBe(false);
  expect(pages).toHaveLength(1);
  expect(pages[0]).toContain("Page 7: malformed");
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("integrity_probe FAILED");
});

test("runIntegrityProbe: a BENIGN throw degrades to no-throw (logs, no page, non-fatal)", () => {
  const { deps, pages, logs } = spyDeps(() => {
    throw new Error("database file vanished mid-open");
  });
  // Must NOT throw — the daemon heartbeat is never-throw.
  const d = runIntegrityProbe(deps);
  expect(d.healthy).toBe(true); // treated as non-fatal; next heartbeat retries
  expect(pages).toHaveLength(0); // a benign throw is not a corruption page
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("non-corruption");
});

test("runIntegrityProbe: a CORRUPTION throw is a positive signal — logs AND pages", () => {
  // bun:sqlite raises SQLITE_CORRUPT while stepping quick_check on a malformed
  // image (the 2026-06-07 path). This MUST page, not be swallowed as benign.
  const err = Object.assign(new Error("database disk image is malformed"), {
    code: "SQLITE_CORRUPT",
    errno: 11,
  });
  const { deps, pages, logs } = spyDeps(() => {
    throw err;
  });
  const d = runIntegrityProbe(deps);
  expect(d.healthy).toBe(false);
  expect(pages).toHaveLength(1);
  expect(pages[0]).toContain("malformed");
  expect(logs[0]).toContain("integrity_probe FAILED (threw)");
});

test("isCorruptionThrow: classifies SQLITE_CORRUPT / malformed as corruption, others as benign", () => {
  expect(
    isCorruptionThrow(
      Object.assign(new Error("x"), { code: "SQLITE_CORRUPT" }),
    ),
  ).toBe(true);
  expect(isCorruptionThrow(Object.assign(new Error("x"), { errno: 11 }))).toBe(
    true,
  );
  expect(isCorruptionThrow(new Error("database disk image is malformed"))).toBe(
    true,
  );
  // Benign: an open race / missing file is NOT corruption.
  expect(isCorruptionThrow(new Error("unable to open database file"))).toBe(
    false,
  );
  expect(isCorruptionThrow(null)).toBe(false);
});

test("runIntegrityProbe: a throwing PAGE sink does not crash the heartbeat", () => {
  const logs: string[] = [];
  const deps: IntegrityProbeDeps = {
    quickCheck: () => ["Page 1: corrupt"],
    page: () => {
      throw new Error("botctl missing");
    },
    log: (m) => logs.push(m),
  };
  // Must not throw even though the page sink throws.
  const d = runIntegrityProbe(deps);
  expect(d.healthy).toBe(false);
  expect(logs[0]).toContain("integrity_probe FAILED");
});

// ---------------------------------------------------------------------------
// End-to-end PIN: real read-only quick_check on a healthy vs corrupted DB
// ---------------------------------------------------------------------------

test("liveQuickCheck: a HEALTHY real DB returns exactly `ok` and never pages", () => {
  // Build a real keeper DB, then close all handles so the probe's read-only
  // open sees a quiescent file. fn-769 file variant: the probe opens this SAME
  // path read-only, so the migrated schema must live on disk. `freshDbFile`
  // writes the pre-migrated template image (skipping the ladder).
  const { db } = freshDbFile(dbPath);
  db.run("PRAGMA wal_checkpoint(TRUNCATE)"); // fold the WAL into the main file
  db.close();

  const pages: string[] = [];
  const logs: string[] = [];
  const decision = runIntegrityProbe({
    quickCheck: liveQuickCheck(dbPath),
    page: (m) => pages.push(m),
    log: (m) => logs.push(m),
  });

  expect(decision.healthy).toBe(true);
  expect(pages).toHaveLength(0);
});

test("liveQuickCheck: a deliberately-CORRUPTED fixture DB trips the probe and pages", () => {
  // Build a real keeper DB, checkpoint the WAL into the main file so the
  // corruption we splatter onto the main file is what quick_check reads, then
  // close every handle. fn-769 file variant: the probe re-opens this path
  // read-only and we corrupt the raw on-disk image, so the schema must be on
  // disk. `freshDbFile` bootstraps it from the template (no migrate ladder).
  const { db } = freshDbFile(dbPath);
  // Force a non-trivial DB so there are interior B-tree pages to corrupt.
  for (let i = 0; i < 200; i++) {
    db.run("INSERT INTO meta (key, value) VALUES (?, ?)", [
      `pad-${i}`,
      "x".repeat(2000),
    ]);
  }
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();

  // Deliberately corrupt the on-disk image: overwrite a span of interior pages
  // with garbage. Page 1 is the header (overwriting it would make the file fail
  // to OPEN, not fail quick_check) — so we splatter pages 2..N where the data
  // B-trees live. quick_check must detect the structural damage.
  const fd = openSync(dbPath, "r+");
  try {
    const PAGE_SIZE = 4096;
    const garbage = Buffer.alloc(PAGE_SIZE * 8, 0xff);
    // Start at page 2 (offset = 1 page) to leave the file header intact.
    writeSync(fd, garbage, 0, garbage.length, PAGE_SIZE);
  } finally {
    closeSync(fd);
  }

  const pages: string[] = [];
  const logs: string[] = [];
  const decision = runIntegrityProbe({
    quickCheck: liveQuickCheck(dbPath),
    page: (m) => pages.push(m),
    log: (m) => logs.push(m),
  });

  // On the real driver, a malformed image surfaces as a SQLITE_CORRUPT THROW
  // while stepping quick_check (the 2026-06-07 path) rather than a non-`ok`
  // result row — either way the probe pages. Assert the page fired and names the
  // corruption, regardless of which arm caught it.
  expect(decision.healthy).toBe(false);
  expect(pages).toHaveLength(1);
  expect(pages[0]).toMatch(/quick_check (FAILED|RAISED)/);
  expect(pages[0]).toMatch(/malformed|corrupt/i);
  expect(logs.some((l) => l.includes("integrity_probe FAILED"))).toBe(true);
});

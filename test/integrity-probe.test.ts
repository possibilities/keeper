import { Database } from "bun:sqlite";
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

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keeper-integrity-probe-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("integrity decision accepts only one ok row", () => {
  expect(decideIntegrityProbe([QUICK_CHECK_OK])).toEqual({
    healthy: true,
    pageMessage: null,
  });
  expect(decideIntegrityProbe([]).pageMessage).toContain("no rows");
  expect(
    decideIntegrityProbe([QUICK_CHECK_OK, "row index is corrupt"]).healthy,
  ).toBe(false);
  expect(decideIntegrityProbe(["Page 42: corrupt"]).pageMessage).toContain(
    "Page 42",
  );
});

test("integrity decision caps corrupt-page detail", () => {
  const decision = decideIntegrityProbe(
    Array.from({ length: 5000 }, (_, index) => `Page ${index}: corrupt`),
  );
  expect(decision.pageMessage).toContain("… and 4990 more");
  expect((decision.pageMessage ?? "").length).toBeLessThan(2000);
});

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
      page: (message) => pages.push(message),
      log: (message) => logs.push(message),
    },
    pages,
    logs,
  };
}

test("probe wiring is silent when healthy and logs/pages once when unhealthy", () => {
  const healthy = spyDeps(() => [QUICK_CHECK_OK]);
  expect(runIntegrityProbe(healthy.deps).healthy).toBe(true);
  expect(healthy.pages).toEqual([]);
  expect(healthy.logs).toEqual([]);

  const unhealthy = spyDeps(() => ["Page 7: malformed"]);
  expect(runIntegrityProbe(unhealthy.deps).healthy).toBe(false);
  expect(unhealthy.pages).toHaveLength(1);
  expect(unhealthy.logs).toHaveLength(1);
});

test("benign throw logs without paging; corruption throw pages", () => {
  const benign = spyDeps(() => {
    throw new Error("database file vanished mid-open");
  });
  expect(runIntegrityProbe(benign.deps).healthy).toBe(true);
  expect(benign.pages).toEqual([]);
  expect(benign.logs[0]).toContain("non-corruption");

  const corrupt = spyDeps(() => {
    throw Object.assign(new Error("database disk image is malformed"), {
      code: "SQLITE_CORRUPT",
    });
  });
  expect(runIntegrityProbe(corrupt.deps).healthy).toBe(false);
  expect(corrupt.pages).toHaveLength(1);
  expect(corrupt.logs[0]).toContain("FAILED (threw)");
});

test("corruption throw classification is narrow", () => {
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
  expect(isCorruptionThrow(new Error("unable to open database file"))).toBe(
    false,
  );
});

test("throwing page sink cannot crash the heartbeat", () => {
  const logs: string[] = [];
  expect(() =>
    runIntegrityProbe({
      quickCheck: () => ["Page 1: corrupt"],
      page: () => {
        throw new Error("page sink unavailable");
      },
      log: (message) => logs.push(message),
    }),
  ).not.toThrow();
  expect(logs[0]).toContain("integrity_probe FAILED");
});

test("one tiny corrupted SQLite image trips the real read-only probe", () => {
  const path = join(root, "corrupt.db");
  const db = new Database(path);
  db.run("CREATE TABLE marker (value BLOB NOT NULL)");
  db.run("INSERT INTO marker VALUES (?)", [Buffer.alloc(4096, 0x5a)]);
  const pageSize = (db.query("PRAGMA page_size").get() as { page_size: number })
    .page_size;
  db.close();

  const fd = openSync(path, "r+");
  try {
    writeSync(fd, Buffer.alloc(pageSize, 0xff), 0, pageSize, pageSize);
  } finally {
    closeSync(fd);
  }

  const observed = spyDeps(liveQuickCheck(path));
  const decision = runIntegrityProbe(observed.deps);
  expect(decision.healthy).toBe(false);
  expect(observed.pages).toHaveLength(1);
  expect(observed.logs.some((line) => line.includes("FAILED"))).toBe(true);
});

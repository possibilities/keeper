import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUP_INTERVAL_MS,
  type BackupStorageOperations,
  backupDb,
  decideReclaimOutput,
  decideReclaimVerification,
  executeBackupPlan,
  executeReclaimPlan,
  executeSnapshotPrune,
  isCatchUpDueFromNewest,
  isVerifiedOk,
  newestSnapshotMsFromNames,
  planBackup,
  planReclaim,
  planSnapshotPrune,
  reclaimDb,
  reclaimInstructions,
  resolveBackupDir,
  resolveKeeperdTarget,
  restoreInstructions,
  snapshotName,
  verifySnapshot,
} from "../src/backup";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keeper-backup-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("backup naming and catch-up decisions are pure", () => {
  const earlier = snapshotName(new Date(2026, 5, 7, 2, 7, 8));
  const later = snapshotName(new Date(2026, 5, 7, 2, 7, 10));
  expect(earlier).toBe("keeper-20260607T020708.db");
  expect([later, earlier].sort()).toEqual([earlier, later]);
  const newest = newestSnapshotMsFromNames(["notes.txt", earlier, later]);
  expect(newest).toBe(new Date(2026, 5, 7, 2, 7, 10).getTime());
  expect(isCatchUpDueFromNewest(null, 100)).toBe(true);
  expect(isCatchUpDueFromNewest(100, 100 + BACKUP_INTERVAL_MS)).toBe(true);
  expect(isCatchUpDueFromNewest(100, 101)).toBe(false);
  expect(resolveBackupDir("/state/keeper.db")).toBe("/state/backups");
});

test("backup plan pins destination, name, and retention", () => {
  expect(
    planBackup("/state/keeper.db", {
      backupDir: "/safe/backups",
      now: new Date(2026, 0, 2, 3, 4, 5),
      retain: 2,
    }),
  ).toEqual({
    sourcePath: "/state/keeper.db",
    backupDir: "/safe/backups",
    snapshotPath: "/safe/backups/keeper-20260102T030405.db",
    retain: 2,
  });
});

test("prune plan is canonical, confined, newest-first, and ignores foreign names", () => {
  const stale = planSnapshotPrune(
    "/safe/backups",
    [
      "keeper-20260603T000000.db",
      "../keeper-20260601T000000.db",
      "keeper-20260601T000000.db",
      "README.txt",
      "keeper-20260602T000000.db",
    ],
    1,
  );
  expect(stale).toEqual([
    "/safe/backups/keeper-20260602T000000.db",
    "/safe/backups/keeper-20260601T000000.db",
  ]);
});

test("prune execution exposes partial failure and retry is idempotent", () => {
  const pending = ["/safe/a.db", "/safe/b.db"];
  const existing = new Set(pending);
  let failB = true;
  const remove = (path: string): void => {
    if (path.endsWith("b.db") && failB) throw new Error("busy");
    existing.delete(path);
  };
  const first = executeSnapshotPrune(pending, remove);
  expect(first).toEqual({ pruned: ["/safe/a.db"], failed: ["/safe/b.db"] });
  failB = false;
  const retry = executeSnapshotPrune(first.failed, remove);
  expect(retry).toEqual({ pruned: ["/safe/b.db"], failed: [] });
  expect(executeSnapshotPrune(pending, remove).failed).toEqual([]);
  expect(existing.size).toBe(0);
});

function backupOps(overrides: Partial<BackupStorageOperations> = {}): {
  operations: BackupStorageOperations;
  calls: string[];
} {
  const calls: string[] = [];
  const operations: BackupStorageOperations = {
    ensureDirectory: (path) => calls.push(`mkdir:${path}`),
    createSnapshot: (source, output) => calls.push(`copy:${source}:${output}`),
    verify: (path) => {
      calls.push(`verify:${path}`);
      return ["ok"];
    },
    remove: (path) => calls.push(`remove:${path}`),
    size: () => 42,
    list: () => [
      "keeper-20260101T000000.db",
      "keeper-20260102T000000.db",
      "keeper-20260103T000000.db",
    ],
    ...overrides,
  };
  return { operations, calls };
}

test("backup executor verifies before retention and reports typed success", () => {
  const plan = planBackup("/state/keeper.db", {
    backupDir: "/state/backups",
    now: new Date(2026, 0, 3),
    retain: 1,
  });
  const { operations, calls } = backupOps();
  const result = executeBackupPlan(plan, operations);
  expect(result).toEqual({
    snapshotPath: "/state/backups/keeper-20260103T000000.db",
    verified: true,
    bytes: 42,
    pruned: [
      "/state/backups/keeper-20260102T000000.db",
      "/state/backups/keeper-20260101T000000.db",
    ],
    cleanupFailures: [],
    error: null,
  });
  expect(calls.indexOf(`verify:${plan.snapshotPath}`)).toBeLessThan(
    calls.indexOf("remove:/state/backups/keeper-20260102T000000.db"),
  );
});

test("backup executor rejects failed verification and exposes cleanup failure", () => {
  const plan = planBackup("/state/keeper.db", {
    backupDir: "/state/backups",
    now: new Date(2026, 0, 3),
  });
  const { operations } = backupOps({
    verify: () => ["page corrupt"],
    remove: () => {
      throw new Error("permission denied");
    },
  });
  const result = executeBackupPlan(plan, operations);
  expect(result.verified).toBe(false);
  expect(result.snapshotPath).toBeNull();
  expect(result.error).toContain("failed integrity_check");
  expect(result.cleanupFailures).toEqual([plan.snapshotPath]);
});

test("integrity verdict requires exactly one ok row", () => {
  expect(isVerifiedOk(["ok"])).toBe(true);
  expect(isVerifiedOk([])).toBe(false);
  expect(isVerifiedOk(["ok", "ok"])).toBe(false);
  expect(isVerifiedOk(["corrupt"])).toBe(false);
});

test("one tiny file-backed backup is verified, restorable, and persistent on reopen", () => {
  const source = join(root, "source.db");
  const db = new Database(source);
  db.run("CREATE TABLE marker (value TEXT NOT NULL)");
  db.run("INSERT INTO marker VALUES ('survives')");
  db.close();

  const result = backupDb(source, {
    now: new Date(2026, 0, 2, 3, 4, 5),
    retain: 1,
  });
  expect(result.verified).toBe(true);
  expect(result.cleanupFailures).toEqual([]);
  const snapshot = result.snapshotPath ?? "";
  expect(verifySnapshot(snapshot)).toEqual(["ok"]);

  const restored = new Database(snapshot, { readonly: true });
  expect(
    (restored.query("SELECT value FROM marker").get() as { value: string })
      .value,
  ).toBe("survives");
  restored.close();
});

test("tiny corrupt file is rejected by the real snapshot verifier", () => {
  const corrupt = join(root, "corrupt.db");
  writeFileSync(corrupt, Buffer.from("not a sqlite database"));
  expect(() => verifySnapshot(corrupt)).toThrow();
});

test("reclaim planning and output classification are pure", () => {
  expect(planReclaim("/state/keeper.db", "/state/keeper.db.reclaim")).toEqual({
    sourcePath: "/state/keeper.db",
    outputPath: "/state/keeper.db.reclaim",
  });
  expect(
    decideReclaimOutput({ quickCheckRows: ["ok"], autoVacuum: 2 }),
  ).toBeNull();
  expect(
    decideReclaimOutput({ quickCheckRows: ["broken"], autoVacuum: 2 }),
  ).toContain("quick_check");
  expect(
    decideReclaimOutput({ quickCheckRows: ["ok"], autoVacuum: 0 }),
  ).toContain("auto_vacuum");
});

test("reclaim executor rejects unsafe output and records failed cleanup", () => {
  const output = "/state/keeper.db.reclaim";
  const result = executeReclaimPlan(planReclaim("/state/keeper.db", output), {
    sourceInfo: () => ({ bytes: 100, mode: 0o100600 }),
    remove: () => {
      throw new Error("busy");
    },
    createReclaimed: () => {},
    inspectOutput: () => ({ quickCheckRows: ["ok"], autoVacuum: 0 }),
    chmod: () => {},
    size: () => 50,
  });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("auto_vacuum");
  expect(result.cleanupFailures).toEqual([output]);
});

test("reclaim verification classifies schema, mode, table set, and row counts", () => {
  const source = {
    schemaVersion: 7,
    autoVacuum: 0,
    tableRowCounts: { events: 2, meta: 1 },
  };
  expect(
    decideReclaimVerification(source, {
      schemaVersion: 7,
      autoVacuum: 2,
      tableRowCounts: { events: 2, meta: 1 },
    }).ok,
  ).toBe(true);
  expect(
    decideReclaimVerification(source, {
      schemaVersion: 8,
      autoVacuum: 2,
      tableRowCounts: source.tableRowCounts,
    }).error,
  ).toContain("schema_version");
  expect(
    decideReclaimVerification(source, {
      schemaVersion: 7,
      autoVacuum: 0,
      tableRowCounts: source.tableRowCounts,
    }).error,
  ).toContain("auto_vacuum");
  expect(
    decideReclaimVerification(source, {
      schemaVersion: 7,
      autoVacuum: 2,
      tableRowCounts: { events: 1, meta: 1 },
    }).error,
  ).toContain("row-count mismatch");
});

test("one tiny file-backed reclaim preserves rows and incremental mode", () => {
  const source = join(root, "reclaim-source.db");
  const output = `${source}.reclaim`;
  const db = new Database(source);
  db.run("PRAGMA auto_vacuum=INCREMENTAL");
  db.run("CREATE TABLE marker (value TEXT NOT NULL)");
  db.run("INSERT INTO marker VALUES ('kept')");
  db.close();

  const result = reclaimDb(source, output);
  expect(result.ok).toBe(true);
  const reopened = new Database(output, { readonly: true });
  expect(
    (reopened.query("SELECT value FROM marker").get() as { value: string })
      .value,
  ).toBe("kept");
  expect(
    (reopened.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number })
      .auto_vacuum,
  ).toBe(2);
  reopened.close();
});

test("restore and reclaim runbooks retain stop, swap, sidecar, and verify steps", () => {
  const restore = restoreInstructions("/backups/good.db", "/state/keeper.db");
  expect(restore).toMatch(/stop the daemon/i);
  expect(restore).toContain("-wal");
  expect(restore).toContain("integrity_check");
  const reclaim = reclaimInstructions(
    "/state/keeper.db.reclaim",
    "/state/keeper.db",
    null,
  );
  expect(reclaim).toContain("launchctl bootout <keeperd label>");
  expect(reclaim).toContain("keeper await server-up");
});

test("keeperd target resolution is injectable and fail-safe", () => {
  expect(
    resolveKeeperdTarget({
      platform: "darwin",
      getuid: () => 501,
      launchctlPrint: () => "  path = /tmp/keeperd.plist\n",
    }),
  ).toEqual({
    domain: "gui/501",
    service: "gui/501/arthack.keeperd",
    plistPath: "/tmp/keeperd.plist",
  });
  expect(resolveKeeperdTarget({ platform: "linux" })).toBeNull();
});

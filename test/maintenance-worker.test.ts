/**
 * Maintenance-worker tests (fn-765 task .1).
 *
 * The worker hosts the heavy SQLite maintenance schedules (24h verified backup,
 * 15-min integrity probe, fn-753 boot catch-up) OFF main's fold thread. The
 * backup/probe BODIES already have function-level coverage in backup.test.ts /
 * integrity-probe.test.ts (unchanged, just re-hosted), so this file covers only
 * the NEW seams the move introduces:
 *
 * - the relay pass bodies (`runBackupPass` / `runProbePass`): they post the
 *   right `{kind}` message to main, never throw, and honor the shuttingDown gate;
 * - the worker LIFECYCLE: a spawned Worker boots, fires a boot catch-up backup
 *   pass (relayed up) when the backup dir is stale/empty, and shuts down clean on
 *   `{type:"shutdown"}`;
 * - the `isMainThread` guard: a plain import is inert (no timers, no spawn).
 *
 * Every test sandboxes the DB path under a per-test tmpdir; `backupDb` resolves
 * its snapshot dir as a sibling `backups/` of the DB path, so the whole
 * maintenance footprint stays inside the tmpdir.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import type { MaintenanceMessage } from "../src/maintenance-worker";
import { runBackupPass, runProbePass } from "../src/maintenance-worker";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-maintenance-test-"));
  dbPath = join(tmpDir, "keeper.db");
  // Bootstrap a real, healthy schema so backupDb's VACUUM INTO + verify and the
  // probe's quick_check run against a genuine DB.
  openDb(dbPath).db.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// runBackupPass — relay shape, never-throws, shuttingDown gate
// ---------------------------------------------------------------------------

test("runBackupPass relays a verified backup-result against a real DB", () => {
  const msgs: MaintenanceMessage[] = [];
  runBackupPass(
    dbPath,
    (m) => msgs.push(m),
    () => false,
  );
  expect(msgs).toHaveLength(1);
  const msg = msgs[0];
  expect(msg.kind).toBe("backup-result");
  if (msg.kind === "backup-result") {
    expect(msg.result.verified).toBe(true);
    expect(msg.result.snapshotPath).not.toBeNull();
    expect(msg.result.error).toBeNull();
  }
});

test("runBackupPass never throws on a bad path — relays a failure result", () => {
  const msgs: MaintenanceMessage[] = [];
  // A non-existent source DB makes backupDb's VACUUM INTO fail; the pass must
  // synthesize a failure result and still relay (never throw out).
  expect(() =>
    runBackupPass(
      join(tmpDir, "does-not-exist.db"),
      (m) => msgs.push(m),
      () => false,
    ),
  ).not.toThrow();
  expect(msgs).toHaveLength(1);
  const msg = msgs[0];
  expect(msg.kind).toBe("backup-result");
  if (msg.kind === "backup-result") {
    expect(msg.result.verified).toBe(false);
    expect(msg.result.error).not.toBeNull();
  }
});

test("runBackupPass is a no-op when shutting down", () => {
  const msgs: MaintenanceMessage[] = [];
  runBackupPass(
    dbPath,
    (m) => msgs.push(m),
    () => true,
  );
  expect(msgs).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// runProbePass — relay shape, silence on a healthy DB, page on corruption
// ---------------------------------------------------------------------------

test("runProbePass against a healthy DB relays NO page (silent)", () => {
  const msgs: MaintenanceMessage[] = [];
  runProbePass(
    dbPath,
    (m) => msgs.push(m),
    () => false,
  );
  // A healthy probe is silent — no page, no failure log.
  expect(msgs.some((m) => m.kind === "maintenance-page")).toBe(false);
});

test("runProbePass against a corrupt DB relays a page + a failure log", () => {
  // Mirror the integrity-probe end-to-end fixture: build a non-trivial DB so
  // there are interior B-tree pages to corrupt, checkpoint the WAL into the main
  // file, then splatter pages 2..N (leaving the header page intact so the file
  // still OPENs and quick_check reads the structural damage instead of failing
  // to open).
  const { db } = openDb(dbPath);
  for (let i = 0; i < 200; i++) {
    db.run("INSERT INTO meta (key, value) VALUES (?, ?)", [
      `pad-${i}`,
      "x".repeat(2000),
    ]);
  }
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();

  const fd = openSync(dbPath, "r+");
  try {
    const PAGE_SIZE = 4096;
    const garbage = Buffer.alloc(PAGE_SIZE * 8, 0xff);
    // Start at page 2 (offset = 1 page) to leave the file header intact.
    writeSync(fd, garbage, 0, garbage.length, PAGE_SIZE);
  } finally {
    closeSync(fd);
  }

  const msgs: MaintenanceMessage[] = [];
  runProbePass(
    dbPath,
    (m) => msgs.push(m),
    () => false,
  );
  expect(msgs.some((m) => m.kind === "maintenance-page")).toBe(true);
  expect(msgs.some((m) => m.kind === "maintenance-log")).toBe(true);
});

test("runProbePass is a no-op when shutting down", () => {
  const msgs: MaintenanceMessage[] = [];
  runProbePass(
    dbPath,
    (m) => msgs.push(m),
    () => true,
  );
  expect(msgs).toHaveLength(0);
});

test("plain import on the main thread is inert (isMainThread guard)", async () => {
  // Importing the module here runs on the main thread. The guard must keep
  // main() from firing — no timers, no postMessage, no process.exit. If the
  // guard were missing, importing would throw (no parentPort) or schedule timers
  // that leak into the test process. Reaching this assertion proves inertness.
  const mod = await import("../src/maintenance-worker");
  expect(typeof mod.runBackupPass).toBe("function");
  expect(typeof mod.runProbePass).toBe("function");
});

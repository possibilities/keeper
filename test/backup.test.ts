/**
 * keeper.db backup / snapshot + restore tests (fn-746.2).
 *
 * Covers the task Acceptance:
 * - A backup/snapshot path produces a VERIFIED-RESTORABLE copy: the snapshot
 *   opens, passes `integrity_check`, AND restoring it (mv over a fresh path)
 *   yields a DB whose rows match the source — the end-to-end "is this actually
 *   restorable" PIN.
 * - DB size management: `VACUUM INTO` produces a freelist-compacted copy
 *   SMALLER than a bloated source (the restore doubles as offline VACUUM).
 * - A snapshot that fails verification is DELETED, never left masquerading as a
 *   good backup (restoring it would propagate corruption).
 * - The pruner keeps the newest N by chronological name sort and never touches
 *   non-snapshot files.
 * - The restore procedure is documented (a non-empty, step-bearing string).
 *
 * Producer-side: every backup writes ONLY the snapshot file, never the source.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUP_INTERVAL_MS,
  backupDb,
  DEFAULT_BACKUP_RETENTION,
  isCatchUpDue,
  isVerifiedOk,
  newestSnapshotMs,
  pruneSnapshots,
  resolveBackupDir,
  restoreInstructions,
  snapshotName,
  verifySnapshot,
} from "../src/backup";
import { openDb } from "../src/db";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `keeper-backup-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  dbPath = join(tmpDir, "keeper.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("snapshotName: chronological lexical stamp, zero-padded", () => {
  const name = snapshotName(new Date(2026, 5, 7, 2, 7, 9)); // Jun (month idx 5)
  expect(name).toBe("keeper-20260607T020709.db");
  // Lexical sort == chronological sort (the pruner relies on this).
  const earlier = snapshotName(new Date(2026, 5, 7, 2, 7, 8));
  const later = snapshotName(new Date(2026, 5, 7, 2, 7, 10));
  expect([later, name, earlier].sort()).toEqual([earlier, name, later]);
});

test("isVerifiedOk: exactly one `ok` row is healthy; anything else is not", () => {
  expect(isVerifiedOk(["ok"])).toBe(true);
  expect(isVerifiedOk(["ok", "ok"])).toBe(false);
  expect(isVerifiedOk(["*** in database main ***\nPage 7 is never used"])).toBe(
    false,
  );
  expect(isVerifiedOk([])).toBe(false);
});

test("resolveBackupDir: a sibling `backups/` of the DB", () => {
  expect(resolveBackupDir("/a/b/keeper.db")).toBe("/a/b/backups");
});

// ---------------------------------------------------------------------------
// fn-753 — boot-time catch-up overdue check
// ---------------------------------------------------------------------------

test("newestSnapshotMs: null on a missing/empty dir or no matching files", () => {
  const dir = join(tmpDir, "backups");
  // Missing dir.
  expect(newestSnapshotMs(dir)).toBe(null);
  // Empty dir.
  mkdirSync(dir, { recursive: true });
  expect(newestSnapshotMs(dir)).toBe(null);
  // Non-snapshot files are ignored.
  writeFileSync(join(dir, "notes.txt"), "x");
  writeFileSync(join(dir, "keeper.db"), "x");
  expect(newestSnapshotMs(dir)).toBe(null);
});

test("newestSnapshotMs: parses the lexically-newest stamp as local time", () => {
  const dir = join(tmpDir, "backups");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, snapshotName(new Date(2026, 5, 7, 1, 0, 0))), "x");
  const newest = new Date(2026, 5, 7, 3, 30, 15);
  writeFileSync(join(dir, snapshotName(newest)), "x");
  writeFileSync(join(dir, snapshotName(new Date(2026, 5, 7, 2, 0, 0))), "x");
  expect(newestSnapshotMs(dir)).toBe(newest.getTime());
});

test("isCatchUpDue: NO snapshots ⇒ due (boot with no prior snapshot)", () => {
  const dir = join(tmpDir, "backups");
  expect(isCatchUpDue(dir, Date.now())).toBe(true);
});

test("isCatchUpDue: OVERDUE snapshot ⇒ due (older than the interval)", () => {
  const dir = join(tmpDir, "backups");
  mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - BACKUP_INTERVAL_MS - 60_000);
  writeFileSync(join(dir, snapshotName(old)), "x");
  expect(isCatchUpDue(dir, Date.now())).toBe(true);
  // Exactly at the interval boundary is also due (>=).
  const boundary = new Date(Date.now() - BACKUP_INTERVAL_MS);
  rmSync(join(dir, snapshotName(old)));
  writeFileSync(join(dir, snapshotName(boundary)), "x");
  expect(isCatchUpDue(dir, Date.now())).toBe(true);
});

test("isCatchUpDue: FRESH snapshot ⇒ NOT due (regular timer unchanged)", () => {
  const dir = join(tmpDir, "backups");
  mkdirSync(dir, { recursive: true });
  const fresh = new Date(Date.now() - 60_000); // 1 min ago, well within 24h
  writeFileSync(join(dir, snapshotName(fresh)), "x");
  expect(isCatchUpDue(dir, Date.now())).toBe(false);
});

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

test("pruneSnapshots: keeps newest N, deletes older, ignores non-snapshots", () => {
  const dir = join(tmpDir, "backups");
  mkdirSync(dir, { recursive: true });
  // Five snapshots, ascending stamps + two foreign files.
  const stamps = [
    "keeper-20260601T000000.db",
    "keeper-20260602T000000.db",
    "keeper-20260603T000000.db",
    "keeper-20260604T000000.db",
    "keeper-20260605T000000.db",
  ];
  for (const s of stamps) writeFileSync(join(dir, s), "x");
  writeFileSync(join(dir, "README.txt"), "hand-placed"); // foreign — never pruned
  writeFileSync(join(dir, "keeper.db.corrupt-x"), "forensic"); // foreign

  const pruned = pruneSnapshots(dir, 2);
  // retain=2 keeps the newest 2 (604, 605); the 3 oldest are pruned. Foreign
  // files are untouched.
  expect(pruned.map((p) => p.split("/").pop()).sort()).toEqual([
    "keeper-20260601T000000.db",
    "keeper-20260602T000000.db",
    "keeper-20260603T000000.db",
  ]);
  const left = readdirSync(dir).sort();
  expect(left).toEqual([
    "README.txt",
    "keeper-20260604T000000.db",
    "keeper-20260605T000000.db",
    "keeper.db.corrupt-x",
  ]);
});

test("pruneSnapshots: missing dir is a no-op (no throw)", () => {
  expect(pruneSnapshots(join(tmpDir, "nope"), 3)).toEqual([]);
});

// ---------------------------------------------------------------------------
// End-to-end PIN: backup → verify → restore is actually restorable
// ---------------------------------------------------------------------------

test("backupDb: produces a VERIFIED snapshot that restores to a matching DB", () => {
  // Real keeper DB with a known marker row in `meta`.
  const { db } = openDb(dbPath);
  db.run("INSERT INTO meta (key, value) VALUES (?, ?)", [
    "backup-test-marker",
    "load-bearing-value",
  ]);
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();

  const result = backupDb(dbPath, { now: new Date(2026, 5, 7, 2, 7, 9) });
  expect(result.verified).toBe(true);
  expect(result.error).toBeNull();
  expect(result.snapshotPath).not.toBeNull();
  expect(result.bytes).toBeGreaterThan(0);
  const snapshotPath = result.snapshotPath ?? "";
  expect(snapshotPath).toContain("keeper-20260607T020709.db");

  // The snapshot independently passes integrity_check.
  expect(isVerifiedOk(verifySnapshot(snapshotPath))).toBe(true);

  // RESTORE: open the snapshot as if it were the live DB and read the marker.
  const restored = new Database(snapshotPath, { readonly: true });
  try {
    const row = restored
      .query("SELECT value FROM meta WHERE key = ?")
      .get("backup-test-marker") as { value: string } | null;
    expect(row?.value).toBe("load-bearing-value");
  } finally {
    restored.close();
  }

  // Source untouched (producer-side write only the snapshot).
  const stillThere = new Database(dbPath, { readonly: true });
  try {
    const row = stillThere
      .query("SELECT value FROM meta WHERE key = ?")
      .get("backup-test-marker") as { value: string } | null;
    expect(row?.value).toBe("load-bearing-value");
  } finally {
    stillThere.close();
  }
});

test("backupDb: VACUUM INTO reclaims freelist — snapshot smaller than a bloated source", () => {
  // Bloat the source: insert then delete a large payload so the freelist grows
  // but the file does not shrink (the fn-746.1 deferred-VACUUM condition).
  const { db } = openDb(dbPath);
  for (let i = 0; i < 500; i++) {
    db.run("INSERT INTO meta (key, value) VALUES (?, ?)", [
      `bloat-${i}`,
      "y".repeat(4000),
    ]);
  }
  db.run("DELETE FROM meta WHERE key LIKE 'bloat-%'");
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();

  const sourceBytes = statSync(dbPath).size;
  const result = backupDb(dbPath);
  expect(result.verified).toBe(true);
  // The VACUUM INTO copy drops the freelist, so it is strictly smaller than the
  // bloated source — the restore doubles as offline size reclamation.
  expect(result.bytes).toBeLessThan(sourceBytes);
});

test("backupDb: a snapshot that fails integrity_check is DELETED, reports failure", () => {
  // Build a real DB, back it up to get a real snapshot, then re-run with a
  // pre-corrupted source so the produced snapshot itself is malformed. We
  // simulate by corrupting the SOURCE on disk first, then VACUUM INTO either
  // throws (corruption) or yields a snapshot that fails verify — both land in
  // the failure branch with no leftover snapshot.
  const { db } = openDb(dbPath);
  for (let i = 0; i < 300; i++) {
    db.run("INSERT INTO meta (key, value) VALUES (?, ?)", [
      `pad-${i}`,
      "z".repeat(2000),
    ]);
  }
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();

  // Splatter interior pages (leave page 1 header intact so the file still
  // opens, but the B-trees are damaged — quick/integrity check must catch it).
  const fd = openSync(dbPath, "r+");
  try {
    const PAGE_SIZE = 4096;
    const garbage = Buffer.alloc(PAGE_SIZE * 10, 0xff);
    writeSync(fd, garbage, 0, garbage.length, PAGE_SIZE);
  } finally {
    closeSync(fd);
  }

  const backupDir = join(tmpDir, "backups");
  const result = backupDb(dbPath, { backupDir });
  expect(result.verified).toBe(false);
  expect(result.snapshotPath).toBeNull();
  expect(result.error).not.toBeNull();
  // No corrupt snapshot left masquerading as a good backup.
  const remaining = readdirSync(backupDir).filter((n) =>
    n.startsWith("keeper-"),
  );
  expect(remaining).toEqual([]);
});

test("backupDb: prunes to DEFAULT_BACKUP_RETENTION across successive runs", () => {
  const { db } = openDb(dbPath);
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();

  const backupDir = join(tmpDir, "backups");
  // Run more backups than the retention window, each with a distinct stamp.
  for (let i = 0; i < DEFAULT_BACKUP_RETENTION + 2; i++) {
    const result = backupDb(dbPath, {
      backupDir,
      now: new Date(2026, 5, 7, 0, 0, i),
    });
    expect(result.verified).toBe(true);
  }
  const snapshots = readdirSync(backupDir)
    .filter((n) => /^keeper-\d{8}T\d{6}\.db$/.test(n))
    .sort();
  expect(snapshots).toHaveLength(DEFAULT_BACKUP_RETENTION);
  // The retained set is the NEWEST window.
  expect(snapshots[snapshots.length - 1]).toBe("keeper-20260607T000004.db");
});

// ---------------------------------------------------------------------------
// Documented restore procedure
// ---------------------------------------------------------------------------

test("restoreInstructions: documents the stop → swap → verify → restart steps", () => {
  const text = restoreInstructions(
    "/state/backups/keeper-X.db",
    "/state/keeper.db",
  );
  expect(text).toContain("/state/backups/keeper-X.db");
  expect(text).toContain("/state/keeper.db");
  // The load-bearing steps the Acceptance requires be documented.
  expect(text).toMatch(/stop the daemon/i);
  expect(text).toContain("-wal");
  expect(text).toContain("integrity_check");
  expect(text).toMatch(/restart/i);
});

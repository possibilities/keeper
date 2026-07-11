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
import { daemonUp } from "../cli/reclaim";
import {
  BACKUP_INTERVAL_MS,
  backupDb,
  DEFAULT_BACKUP_RETENTION,
  isCatchUpDue,
  isVerifiedOk,
  newestSnapshotMs,
  pruneSnapshots,
  readSchemaVersion,
  readTableRowCounts,
  reclaimDb,
  reclaimInstructions,
  resolveBackupDir,
  resolveKeeperdTarget,
  restoreInstructions,
  snapshotName,
  verifyReclaim,
  verifySnapshot,
} from "../src/backup";
import { openDb, SCHEMA_VERSION } from "../src/db";
import { freshDbFile } from "./helpers/template-db";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `keeper-backup-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  dbPath = join(tmpDir, "keeper.db");
  // fn-769 file variant: the source DB and the online-backup/VACUUM-INTO path
  // open this SAME path across separate connections, so the migrated schema
  // must live on disk. Pre-write the template image (skipping the ladder);
  // later opens pass `migrate: false`. The image is a valid non-WAL DB file;
  // the size/restore tests do their own `wal_checkpoint(TRUNCATE)` regardless.
  freshDbFile(dbPath).db.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Rebuild `dbPath` so it is BORN `auto_vacuum=INCREMENTAL` (=2) like the live
 * keeper.db — the template image ships auto_vacuum=0 (NONE), which does NOT
 * exercise the production reclaim path. A source whose stored mode already
 * differs from the requested one is the precise condition that makes
 * `PRAGMA auto_vacuum=...` against a READ-ONLY handle throw "attempt to write a
 * readonly database"; an auto_vacuum=0 source silently stages the change and
 * masks the bug. reclaimDb opens its source read-only, so this faithful fixture
 * is what drives the real path.
 */
function makeReclaimSourceAutoVacuum2(path: string): void {
  const { db } = openDb(path, { migrate: false });
  // auto_vacuum mode is immutable in place; the change takes effect only on the
  // next VACUUM, which rewrites the file with the new mode baked into the header.
  db.run("PRAGMA auto_vacuum=INCREMENTAL");
  db.run("VACUUM");
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  const av = db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number };
  db.close();
  if (av.auto_vacuum !== 2) {
    throw new Error(
      `makeReclaimSourceAutoVacuum2: fixture is auto_vacuum=${av.auto_vacuum}, expected 2`,
    );
  }
}

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

test("BACKUP_INTERVAL_MS: pinned at 48h — a wide cadence bounds backup I/O churn", () => {
  // A full VACUUM INTO + integrity_check of a large live DB is the dominant
  // source of backup I/O churn; a wider cadence bounds it with no loss of
  // restore correctness (verify-on-write is unchanged). Pinned as an explicit
  // hand-computed constant so a future edit notices the change.
  expect(BACKUP_INTERVAL_MS).toBe(48 * 60 * 60 * 1000);
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
  const fresh = new Date(Date.now() - 60_000); // 1 min ago, well within the interval
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
  const { db } = openDb(dbPath, { migrate: false });
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
  const { db } = openDb(dbPath, { migrate: false });
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
  const { db } = openDb(dbPath, { migrate: false });
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
  const { db } = openDb(dbPath, { migrate: false });
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

// ---------------------------------------------------------------------------
// fn-1251.3 — reclaimInstructions renders RESOLVED launchctl commands
// ---------------------------------------------------------------------------

test("reclaimInstructions: renders resolved gui/<uid>/arthack.keeperd + real plist path when a target is given", () => {
  const text = reclaimInstructions(
    "/state/keeper.db.reclaim",
    "/state/keeper.db",
    {
      domain: "gui/501",
      service: "gui/501/arthack.keeperd",
      plistPath: "/Users/arthack/Library/LaunchAgents/arthack.keeperd.plist",
    },
  );
  expect(text).toContain(
    "launchctl bootout gui/501/arthack.keeperd   # or: launchctl stop",
  );
  expect(text).toContain(
    "launchctl bootstrap gui/501 /Users/arthack/Library/LaunchAgents/arthack.keeperd.plist && keeper await server-up",
  );
  // Not the unresolved placeholder text.
  expect(text).not.toContain("<keeperd label>");
  expect(text).not.toContain("<keeperd domain/label>");
});

test("reclaimInstructions: falls back to the placeholder text when resolution fails (target null)", () => {
  const text = reclaimInstructions(
    "/state/keeper.db.reclaim",
    "/state/keeper.db",
    null,
  );
  expect(text).toContain(
    "launchctl bootout <keeperd label>   # or: launchctl stop",
  );
  expect(text).toContain(
    "launchctl bootstrap <keeperd domain/label> && keeper await server-up",
  );
});

test("reclaimInstructions: with no target arg, resolves via resolveKeeperdTarget()'s default (never throws)", () => {
  // No injected deps — exercises the real production default path (darwin
  // resolves via the actual environment, non-darwin returns null) without
  // asserting on host-specific output; the point is it renders SOMETHING
  // consistent and never throws.
  const text = reclaimInstructions(
    "/state/keeper.db.reclaim",
    "/state/keeper.db",
  );
  expect(text.length).toBeGreaterThan(0);
  expect(text).toContain("launchctl bootout");
  expect(text).toContain("launchctl bootstrap");
});

test("resolveKeeperdTarget: resolves the loaded plist path from `launchctl print` output", () => {
  const target = resolveKeeperdTarget({
    platform: "darwin",
    getuid: () => 501,
    launchctlPrint: (service) => {
      expect(service).toBe("gui/501/arthack.keeperd");
      return [
        "gui/501/arthack.keeperd = {",
        "\tactive count = 1",
        "\tpath = /Users/arthack/code/keeper/plist/arthack.keeperd.plist",
        "\tstdout path = /Users/arthack/.local/state/keeper/server.stdout",
        "\tstderr path = /Users/arthack/.local/state/keeper/server.stderr",
        "}",
      ].join("\n");
    },
    existsSync: () => {
      throw new Error(
        "existsSync must not be consulted when launchctl resolves the path",
      );
    },
  });
  expect(target).toEqual({
    domain: "gui/501",
    service: "gui/501/arthack.keeperd",
    plistPath: "/Users/arthack/code/keeper/plist/arthack.keeperd.plist",
  });
});

test("resolveKeeperdTarget: falls back to the conventional install path when launchd is unreachable", () => {
  const target = resolveKeeperdTarget({
    platform: "darwin",
    getuid: () => 501,
    launchctlPrint: () => {
      throw new Error("Could not find service");
    },
    existsSync: (p) =>
      p === "/Users/arthack/Library/LaunchAgents/arthack.keeperd.plist",
    homedir: () => "/Users/arthack",
  });
  expect(target).toEqual({
    domain: "gui/501",
    service: "gui/501/arthack.keeperd",
    plistPath: "/Users/arthack/Library/LaunchAgents/arthack.keeperd.plist",
  });
});

test("resolveKeeperdTarget: returns null (safe fallback) when neither launchd nor the conventional path resolve", () => {
  const target = resolveKeeperdTarget({
    platform: "darwin",
    getuid: () => 501,
    launchctlPrint: () => {
      throw new Error("Could not find service");
    },
    existsSync: () => false,
    homedir: () => "/Users/arthack",
  });
  expect(target).toBeNull();
});

test("resolveKeeperdTarget: returns null off macOS without touching getuid/launchctl", () => {
  const target = resolveKeeperdTarget({
    platform: "linux",
    getuid: () => {
      throw new Error("getuid must not be consulted off darwin");
    },
  });
  expect(target).toBeNull();
});

// ---------------------------------------------------------------------------
// fn-847 — reclaim self-verify + daemon-up guard
// ---------------------------------------------------------------------------

test("readSchemaVersion / readTableRowCounts: read meta + per-table counts", () => {
  const { db } = openDb(dbPath, { migrate: false });
  db.run("INSERT INTO meta (key, value) VALUES ('marker-key', 'marker-val')");
  db.close();

  const ro = new Database(dbPath, { readonly: true });
  try {
    expect(readSchemaVersion(ro)).toBe(SCHEMA_VERSION);
    const counts = readTableRowCounts(ro);
    // `events` (the fold source) and `meta` are always present; internal
    // sqlite_* tables are excluded.
    expect(counts.events).toBeGreaterThanOrEqual(0);
    expect(typeof counts.meta).toBe("number");
    expect(Object.keys(counts).some((n) => n.startsWith("sqlite_"))).toBe(
      false,
    );
  } finally {
    ro.close();
  }
});

test("verifyReclaim: a real reclaim self-verifies OK (schema/auto_vacuum/rows)", () => {
  // Seed deterministic rows across two tables so the row-count check is real.
  const { db } = openDb(dbPath, { migrate: false });
  for (let i = 0; i < 50; i++) {
    db.run("INSERT INTO meta (key, value) VALUES (?, ?)", [
      `seed-${i}`,
      "x".repeat(64),
    ]);
  }
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  // Production reality: the live DB is born auto_vacuum=2. reclaimDb relies on
  // VACUUM INTO INHERITING that mode (no read-only-source bake).
  makeReclaimSourceAutoVacuum2(dbPath);

  const outputPath = `${dbPath}.reclaim`;
  const result = reclaimDb(dbPath, outputPath);
  expect(result.ok).toBe(true);

  const verify = verifyReclaim(dbPath, outputPath);
  expect(verify.ok).toBe(true);
  expect(verify.error).toBeNull();
  expect(verify.sourceSchemaVersion).toBe(SCHEMA_VERSION);
  expect(verify.outputSchemaVersion).toBe(SCHEMA_VERSION);
  // The output INHERITS auto_vacuum=INCREMENTAL (2) from the source — no bake.
  expect(verify.outputAutoVacuum).toBe(2);
});

test("reclaimDb: a real read-only auto_vacuum=2 source reclaims with no readonly error (fn-851)", () => {
  // Regression PIN for fn-851: reclaimDb opens its source READ-ONLY, and the
  // live DB is born auto_vacuum=2. The old code issued `PRAGMA
  // auto_vacuum=INCREMENTAL` on that read-only handle, which throws "attempt to
  // write a readonly database" precisely because the stored mode already
  // differs from NONE. An auto_vacuum=0 fixture silently staged the bake and
  // hid the bug; this fixture drives the ACTUAL production path.
  const { db } = openDb(dbPath, { migrate: false });
  for (let i = 0; i < 25; i++) {
    db.run("INSERT INTO meta (key, value) VALUES (?, ?)", [
      `pin-${i}`,
      "y".repeat(48),
    ]);
  }
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  makeReclaimSourceAutoVacuum2(dbPath);

  const outputPath = `${dbPath}.reclaim`;
  const result = reclaimDb(dbPath, outputPath);
  // No readonly error; the output is produced and gated clean.
  expect(result.ok).toBe(true);
  expect(result.error).toBeNull();
  expect(result.outputPath).toBe(outputPath);

  // Output inherited auto_vacuum=2 with no bake against the read-only source.
  const out = new Database(outputPath, { readonly: true });
  try {
    const av = out.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number };
    expect(av.auto_vacuum).toBe(2);
  } finally {
    out.close();
  }

  // Row counts identical across the reclaim (no data lost in the rebuild).
  const verify = verifyReclaim(dbPath, outputPath);
  expect(verify.ok).toBe(true);
  expect(verify.error).toBeNull();
});

test("verifyReclaim: a row-count divergence FAILS the self-verify", () => {
  makeReclaimSourceAutoVacuum2(dbPath);

  const outputPath = `${dbPath}.reclaim`;
  expect(reclaimDb(dbPath, outputPath).ok).toBe(true);

  // Mutate the SOURCE after the reclaim so the counts diverge — the verify must
  // catch it (the Early-proof point: a lost/extra row is caught before swap).
  const { db: db2 } = openDb(dbPath, { migrate: false });
  db2.run("INSERT INTO meta (key, value) VALUES ('drift', 'row')");
  db2.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db2.close();

  const verify = verifyReclaim(dbPath, outputPath);
  expect(verify.ok).toBe(false);
  expect(verify.error).toMatch(/row-count mismatch on 'meta'/);
});

test("verifyReclaim: a non-INCREMENTAL output FAILS the auto_vacuum check", () => {
  const { db } = openDb(dbPath, { migrate: false });
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();

  // A plain VACUUM INTO (no auto_vacuum pragma) yields auto_vacuum=0 — the swap
  // must refuse it (the steady-state incremental_vacuum relies on mode 2).
  const outputPath = `${dbPath}.plain`;
  const src = new Database(dbPath, { readonly: true });
  try {
    src.run(`VACUUM INTO '${outputPath.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }

  const verify = verifyReclaim(dbPath, outputPath);
  expect(verify.ok).toBe(false);
  expect(verify.error).toMatch(/auto_vacuum/);
});

test("daemonUp: guard reads the keeperd lock pid and probes liveness", () => {
  const sockPath = join(tmpDir, "keeperd.sock");
  const lockPath = `${sockPath}.lock`;

  // No lock → daemon down (safe to reclaim).
  expect(daemonUp(sockPath)).toEqual({ up: false, pid: null });

  // Lock with OUR pid (definitely alive) → guard refuses.
  writeFileSync(lockPath, `${process.pid}\n`);
  expect(daemonUp(sockPath)).toEqual({ up: true, pid: process.pid });

  // Lock with a dead pid → stale, reads as down.
  // PID 2^30 is far above any real pid; process.kill(.,0) → ESRCH.
  writeFileSync(lockPath, `${1 << 30}\n`);
  expect(daemonUp(sockPath)).toEqual({ up: false, pid: null });

  // Unparseable lock → conservatively down (matches acquireLock's stale stance).
  writeFileSync(lockPath, "not-a-pid\n");
  expect(daemonUp(sockPath)).toEqual({ up: false, pid: null });
});

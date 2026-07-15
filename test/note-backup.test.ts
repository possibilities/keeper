import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupNotesIfDue,
  resolveNoteBackupDir,
  resolveNoteBackupLockPath,
} from "../src/note-backup";
import { FileLock } from "../src/usage-flock";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function freshDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "keeper-notes-backup-"));
  dirs.push(dir);
  const path = join(dir, "notes.db");
  const db = new Database(path, { create: true });
  db.run("CREATE TABLE notes(id TEXT PRIMARY KEY, body TEXT NOT NULL)");
  db.prepare("INSERT INTO notes VALUES (?, ?)").run("n-1", "hello");
  db.close();
  return { dir, path };
}

test("note backups use a dedicated sibling directory", () => {
  expect(resolveNoteBackupDir("/state/notes.db")).toBe("/state/notes-backups");
  expect(resolveNoteBackupDir("/state/first.db")).not.toBe(
    resolveNoteBackupDir("/state/second.db"),
  );
  expect(resolveNoteBackupLockPath("/state/first.db")).not.toBe(
    resolveNoteBackupLockPath("/state/second.db"),
  );
});

test("backupNotesIfDue creates one verified snapshot then respects the interval", () => {
  const { path } = freshDb();
  const now = new Date(2026, 0, 2, 3, 4, 5).getTime();
  const first = backupNotesIfDue(path, {
    nowMs: now,
    intervalMs: 60_000,
  });
  expect(first?.verified).toBe(true);
  expect(first?.snapshotPath).not.toBeNull();
  expect(readdirSync(resolveNoteBackupDir(path))).toEqual([
    "keeper-20260102T030405.db",
  ]);
  if (
    process.platform !== "win32" &&
    first !== null &&
    first.snapshotPath !== null
  ) {
    expect(statSync(resolveNoteBackupDir(path)).mode & 0o777).toBe(0o700);
    expect(statSync(first.snapshotPath).mode & 0o777).toBe(0o600);
    expect(statSync(resolveNoteBackupLockPath(path)).mode & 0o777).toBe(0o600);
  }
  expect(
    backupNotesIfDue(path, { nowMs: now + 1_000, intervalMs: 60_000 }),
  ).toBeNull();
});

test("backupNotesIfDue skips rather than waiting behind an in-flight backup", () => {
  const { path } = freshDb();
  const lock = FileLock.acquire(resolveNoteBackupLockPath(path));
  try {
    expect(
      backupNotesIfDue(path, {
        nowMs: new Date(2026, 0, 2, 3, 4, 5).getTime(),
        intervalMs: 60_000,
      }),
    ).toBeNull();
  } finally {
    lock.release();
  }
});

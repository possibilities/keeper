import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BACKUP_INTERVAL_MS,
  type BackupResult,
  backupDb,
  DEFAULT_BACKUP_RETENTION,
  isCatchUpDue,
} from "./backup";
import { noteStoreNamespace } from "./note-store";
import { FileLock } from "./usage-flock";

/** Dedicated rolling-snapshot directory for notes.db. */
export function resolveNoteBackupDir(notesDbPath: string): string {
  return join(
    dirname(notesDbPath),
    `${noteStoreNamespace(notesDbPath)}-backups`,
  );
}

/** Advisory lock used only to collapse concurrent snapshot attempts. */
export function resolveNoteBackupLockPath(notesDbPath: string): string {
  return join(
    dirname(notesDbPath),
    `${noteStoreNamespace(notesDbPath)}-backup.lock`,
  );
}

/**
 * Produce a verified notes.db snapshot when the rolling interval is due.
 * Returns `null` when a recent snapshot or another in-flight snapshot already
 * covers the store. Snapshot files sit behind a mode-0700 directory and are
 * tightened to mode 0600 after verification.
 */
export function backupNotesIfDue(
  notesDbPath: string,
  options: {
    nowMs?: number;
    intervalMs?: number;
    retain?: number;
  } = {},
): BackupResult | null {
  const nowMs = options.nowMs ?? Date.now();
  const intervalMs = options.intervalMs ?? BACKUP_INTERVAL_MS;
  const backupDir = resolveNoteBackupDir(notesDbPath);
  if (!isCatchUpDue(backupDir, nowMs, intervalMs)) return null;

  const lockPath = resolveNoteBackupLockPath(notesDbPath);
  const lock = FileLock.tryAcquire(lockPath);
  if (lock === null) return null;
  try {
    chmodSync(lockPath, 0o600);
    // Recheck after winning the lock: another process may have completed the
    // snapshot between this caller's optimistic due check and acquisition.
    if (!isCatchUpDue(backupDir, nowMs, intervalMs)) return null;
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    const result = backupDb(notesDbPath, {
      backupDir,
      now: new Date(nowMs),
      retain: options.retain ?? DEFAULT_BACKUP_RETENTION,
    });
    if (result.snapshotPath !== null) chmodSync(result.snapshotPath, 0o600);
    return result;
  } finally {
    lock.release();
  }
}

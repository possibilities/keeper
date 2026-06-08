#!/usr/bin/env bun
/**
 * Operator backup util (fn-746.2) — produce a verified, restorable snapshot of
 * the live keeper.db and print the documented restore procedure.
 *
 * Safe to run while keeperd is UP: `VACUUM INTO` holds only a read transaction
 * on the source, so it never takes the writer lock or starves a hook INSERT
 * (see `src/backup.ts`). The snapshot is a freelist-compacted copy verified by
 * `PRAGMA integrity_check` before this exits 0 — a snapshot that fails
 * verification is deleted and this exits non-zero.
 *
 *   bun scripts/backup-db.ts            # snapshot under ~/.local/state/keeper/backups/
 *   KEEPER_DB=/path/to.db bun scripts/backup-db.ts
 */
import { backupDb, resolveBackupDir, restoreInstructions } from "../src/backup";
import { resolveDbPath } from "../src/db";

const dbPath = resolveDbPath();
const backupDir = resolveBackupDir(dbPath);

console.log(`[backup] source:  ${dbPath}`);
console.log(`[backup] dest dir: ${backupDir}`);

const result = backupDb(dbPath);

if (!result.verified || result.snapshotPath === null) {
  console.error(`[backup] FAILED: ${result.error ?? "unknown error"}`);
  process.exit(1);
}

const mb = (result.bytes / (1024 * 1024)).toFixed(1);
console.log(
  `[backup] ok — verified snapshot (${mb} MB): ${result.snapshotPath}`,
);
if (result.pruned.length > 0) {
  console.log(`[backup] pruned ${result.pruned.length} old snapshot(s):`);
  for (const p of result.pruned) console.log(`  - ${p}`);
}
console.log("");
console.log(restoreInstructions(result.snapshotPath, dbPath));

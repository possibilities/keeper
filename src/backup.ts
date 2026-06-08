/**
 * keeper.db backup / snapshot + restore mechanism (fn-746.2).
 *
 * On 2026-06-07 keeperd hit `SQLiteError: database disk image is malformed` on
 * a now ~2 GB `keeper.db`. fn-746.1 added the proactive DETECTION probe; this
 * module is the RECOVERY half of the epic: a backup/snapshot path that produces
 * a verified-restorable standalone copy so a future malformed image is a
 * recoverable event, not a catastrophe (the event log + projections are
 * keeper's source of truth, so an unrecoverable corruption takes down the whole
 * system).
 *
 * ## `VACUUM INTO`, not in-place VACUUM or the live file
 *
 * The snapshot is produced with `VACUUM INTO '<dest>'`:
 *
 * - It writes a brand-new, fully-defragmented copy of the DB to `<dest>` —
 *   freelist pages dropped, B-trees rebuilt contiguously — WITHOUT touching the
 *   live file. fn-746.1 found the live ~1.9 GB file carries almost no freelist
 *   (online VACUUM is deliberately deferred — an in-place VACUUM rewrites the
 *   whole 2 GB DB under the writer lock, the exact hot-path hold this epic
 *   avoids), so the `VACUUM INTO` copy doubles as the SIZE-RECLAIMED image: the
 *   documented restore (`mv` the snapshot over the stopped live DB) is the
 *   offline size reclamation, off the hot path.
 * - `VACUUM INTO` holds only a READ transaction on the SOURCE for the duration —
 *   it never takes the source's writer lock, so a concurrent hook INSERT is
 *   never starved (unlike in-place `VACUUM`, which write-locks the live DB). It
 *   is therefore safe to run producer-side against the LIVE DB while keeperd is
 *   up. Run it on a DEDICATED read-only source connection (the worker contract),
 *   never inside a fold and never on the reducer's writer connection.
 *
 * ## Verify-on-write — a backup is only a backup if it restores
 *
 * The task Risk note ("Restore procedure must be tested/documented, not
 * assumed") is load-bearing: a snapshot nobody opened is not a backup. So every
 * snapshot is VERIFIED immediately after `VACUUM INTO` by opening it read-only
 * and running `PRAGMA integrity_check` — the FULL check (not quick_check) is
 * affordable here because it runs once per backup on the freshly-defragmented
 * copy, off the hot path, and a backup is the one place we want the strongest
 * structural guarantee. A snapshot that fails verification is deleted and the
 * backup reports failure: we never leave a corrupt snapshot masquerading as a
 * good one (restoring it would propagate the corruption).
 *
 * ## Producer-side, never in a fold
 *
 * Like the integrity probe, this is a PRODUCER-side operation. It reads the DB
 * (a read transaction on the source) and writes ONLY to the snapshot file — it
 * NEVER writes the live DB, mints no synthetic event, touches no projection or
 * reducer state, and never runs inside a fold or the cursor-advance
 * transaction. Re-fold determinism, the cursor+projection single-transaction,
 * and the sole-writer rules are all untouched. The snapshot lives OUTSIDE the
 * DB (a sibling file under the state dir) so a keeper.db re-fold never observes
 * it.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The string `PRAGMA integrity_check` returns on a healthy DB: exactly one row
 * whose value is the literal `ok`. Anything else is structural corruption.
 */
export const INTEGRITY_CHECK_OK = "ok";

/**
 * Daemon backup cadence (ms). 24h — a backup is a recovery floor, not a
 * point-in-time guarantee (the event log is the source of truth and is already
 * proactively integrity-probed every 15 min), so a daily verified snapshot is
 * the right rolling recovery window without churning the disk on a 2 GB copy.
 * Far slacker than the 15 min integrity probe / 30 s checkpoint heartbeats by
 * design: backup is a heavy producer-side op (a full `VACUUM INTO` copy +
 * `integrity_check`), so it runs rarely and off the hot path.
 */
export const BACKUP_INTERVAL_MS = 86_400_000;

/** The Telegram topic every keeper page routes to (matches the integrity probe). */
export const KEEPER_TOPIC = "Keeper";

/**
 * Production page sink for a BACKUP FAILURE — shell out to botctl (Telegram
 * only; best-effort). A failed backup means recovery is degraded (no fresh
 * verified snapshot), which the operator should know about; mirrors the
 * integrity probe's `livePage`. A SUCCESSFUL backup is silent (no all-clear
 * spam — only a failure is worth a ping).
 */
export function liveBackupPage(): (message: string) => void {
  return (message) => {
    try {
      Bun.spawnSync(
        ["botctl", "send-message", "--topic", KEEPER_TOPIC, message],
        { stdout: "ignore", stderr: "ignore" },
      );
    } catch {
      // Best-effort: a missing/failed botctl must not crash the daemon's
      // never-throw heartbeat.
    }
  };
}

/**
 * Default backup directory, a sibling of the live DB under the state dir
 * (`~/.local/state/keeper/backups/`). Resolved from the live DB path so a
 * `KEEPER_DB` override (tests) keeps backups under the same sandboxed tree.
 */
export function resolveBackupDir(dbPath: string): string {
  return join(dirname(dbPath), "backups");
}

/**
 * Build a timestamped snapshot filename: `keeper-<YYYYMMDDTHHMMSS>.db`. The
 * timestamp is the SOLE distinguishing component, and the lexical sort of the
 * `YYYYMMDDTHHMMSS` form is also the chronological sort — so the pruner can
 * keep the newest N by a plain name sort without parsing dates. Pure given the
 * supplied `now` (tests inject a fixed clock; production passes `new Date()`).
 */
export function snapshotName(now: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `T${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `keeper-${stamp}.db`;
}

/** Outcome of a single backup run — pure data the caller logs / asserts. */
export interface BackupResult {
  /** Absolute path of the verified snapshot, or `null` on failure. */
  snapshotPath: string | null;
  /** True iff the snapshot was produced AND passed `integrity_check`. */
  verified: boolean;
  /** Byte size of the snapshot (0 on failure). */
  bytes: number;
  /** Snapshot paths pruned this run (oldest beyond the retention count). */
  pruned: string[];
  /** Human-readable error when `verified` is false; `null` on success. */
  error: string | null;
}

/** Options for {@link backupDb}. */
export interface BackupOptions {
  /** Destination directory; defaults to {@link resolveBackupDir}. */
  backupDir?: string;
  /** Clock for the snapshot name; defaults to `new Date()`. */
  now?: Date;
  /**
   * How many of the newest snapshots to retain after this run. Older snapshots
   * are deleted. Defaults to {@link DEFAULT_BACKUP_RETENTION}. A 2 GB DB
   * compacts to a sizable copy, so the default is conservative.
   */
  retain?: number;
}

/**
 * Default retained snapshot count. The `VACUUM INTO` copy of a ~2 GB DB is
 * large, so retain a small rolling window — enough to recover from a corruption
 * caught by the integrity probe (the most recent good snapshot), with a couple
 * of generations of slack, without unbounded disk growth.
 */
export const DEFAULT_BACKUP_RETENTION = 3;

/**
 * Open `snapshotPath` read-only and run `PRAGMA integrity_check`. Returns the
 * result rows as strings (a healthy DB returns exactly `["ok"]`). Always closes
 * the connection. Read-only ⇒ takes no writer lock on the snapshot.
 *
 * Exported so the restore procedure / tests can verify an arbitrary snapshot
 * (or a candidate restore target) without re-running a full backup.
 */
export function verifySnapshot(snapshotPath: string): string[] {
  const db = new Database(snapshotPath, { readonly: true });
  try {
    const rows = db.query("PRAGMA integrity_check").all() as Record<
      string,
      unknown
    >[];
    return rows.map((r) => {
      const v =
        "integrity_check" in r ? r.integrity_check : Object.values(r)[0];
      return typeof v === "string" ? v : String(v);
    });
  } finally {
    db.close();
  }
}

/** True iff `integrity_check` rows are exactly the single `ok` row. */
export function isVerifiedOk(rows: string[]): boolean {
  return rows.length === 1 && rows[0] === INTEGRITY_CHECK_OK;
}

/**
 * Prune snapshots in `backupDir` beyond the newest `retain`, returning the
 * pruned paths. Snapshot names sort chronologically by their lexical
 * `YYYYMMDDTHHMMSS` stamp (see {@link snapshotName}), so newest-first is a
 * reverse name sort — no date parsing, and `statSync` mtimes (which can be
 * rewritten by a copy/restore) are NOT trusted for ordering. Only files
 * matching the `keeper-<stamp>.db` shape are considered, so an operator's
 * hand-placed file in the dir is never deleted.
 */
export function pruneSnapshots(backupDir: string, retain: number): string[] {
  let names: string[];
  try {
    names = readdirSync(backupDir);
  } catch {
    return []; // dir missing ⇒ nothing to prune
  }
  const snapshots = names
    .filter((n) => /^keeper-\d{8}T\d{6}\.db$/.test(n))
    .sort()
    .reverse(); // newest (lexically-greatest stamp) first
  const stale = snapshots.slice(Math.max(0, retain));
  const pruned: string[] = [];
  for (const name of stale) {
    const path = join(backupDir, name);
    try {
      rmSync(path, { force: true });
      pruned.push(path);
    } catch {
      // Best-effort: a prune failure (perm, race) must not fail the backup
      // itself — the snapshot we just verified is the load-bearing output.
    }
  }
  return pruned;
}

/**
 * Produce a verified, restorable snapshot of `dbPath` via `VACUUM INTO`, verify
 * it with `PRAGMA integrity_check`, prune old snapshots, and return the result.
 *
 * Safe to run against the LIVE DB while keeperd is up: `VACUUM INTO` holds only
 * a READ transaction on the source, so it never takes the writer lock or
 * starves a concurrent hook INSERT. Producer-side; writes only the snapshot
 * file, never the live DB.
 *
 * On a verification failure the corrupt snapshot is DELETED (a snapshot that
 * fails integrity_check is worse than no snapshot — restoring it would
 * propagate corruption) and `verified: false` is returned with the detail.
 */
export function backupDb(
  dbPath: string,
  options: BackupOptions = {},
): BackupResult {
  const backupDir = options.backupDir ?? resolveBackupDir(dbPath);
  const now = options.now ?? new Date();
  const retain = options.retain ?? DEFAULT_BACKUP_RETENTION;

  mkdirSync(backupDir, { recursive: true });
  const snapshotPath = join(backupDir, snapshotName(now));

  // VACUUM INTO on a DEDICATED read-only source connection — never the daemon's
  // writer connection. Read-only on the source ⇒ no writer-lock contention.
  // The destination is a path literal; quote single-quotes defensively even
  // though our names never contain them.
  const src = new Database(dbPath, { readonly: true });
  try {
    const quoted = snapshotPath.replace(/'/g, "''");
    src.run(`VACUUM INTO '${quoted}'`);
  } catch (err) {
    // A VACUUM INTO failure (disk full, source mid-corruption) leaves no usable
    // snapshot. Clean up any partial file and report failure — do not page or
    // throw here; the caller decides escalation.
    try {
      rmSync(snapshotPath, { force: true });
    } catch {
      /* best-effort */
    }
    return {
      snapshotPath: null,
      verified: false,
      bytes: 0,
      pruned: [],
      error: `VACUUM INTO failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  } finally {
    src.close();
  }

  // VERIFY — a backup is only a backup if it opens and passes integrity_check.
  let verifyRows: string[];
  try {
    verifyRows = verifySnapshot(snapshotPath);
  } catch (err) {
    try {
      rmSync(snapshotPath, { force: true });
    } catch {
      /* best-effort */
    }
    return {
      snapshotPath: null,
      verified: false,
      bytes: 0,
      pruned: [],
      error: `snapshot verification threw (deleted): ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (!isVerifiedOk(verifyRows)) {
    // A snapshot that fails integrity_check is worse than none — delete it.
    try {
      rmSync(snapshotPath, { force: true });
    } catch {
      /* best-effort */
    }
    return {
      snapshotPath: null,
      verified: false,
      bytes: 0,
      pruned: [],
      error: `snapshot failed integrity_check (deleted): ${verifyRows
        .slice(0, 5)
        .join("; ")}`,
    };
  }

  let bytes = 0;
  try {
    bytes = statSync(snapshotPath).size;
  } catch {
    /* size is informational only */
  }

  const pruned = pruneSnapshots(backupDir, retain);

  return { snapshotPath, verified: true, bytes, pruned, error: null };
}

/**
 * The DOCUMENTED restore procedure (the task Acceptance requires it be
 * documented, not assumed). Also rendered by `scripts/backup-db.ts` after a
 * successful backup so the operator always has the steps to hand. Kept as a
 * single source of truth here AND in README `## Backup & restore`.
 */
export function restoreInstructions(
  snapshotPath: string,
  dbPath: string,
): string {
  return [
    "To restore this snapshot over a corrupt live DB:",
    "",
    "  1. Stop the daemon so nothing holds the writer lock or a stale WAL:",
    "       launchctl stop <keeperd label>   # or kill the keeperd process",
    "",
    `  2. Move the corrupt live DB aside (keep it for forensics) and drop the`,
    "     stale WAL/SHM sidecars (they belong to the OLD file):",
    `       mv '${dbPath}' '${dbPath}.corrupt-$(date +%Y%m%dT%H%M%S)'`,
    `       rm -f '${dbPath}-wal' '${dbPath}-shm'`,
    "",
    "  3. Move the verified snapshot into place as the new live DB:",
    `       mv '${snapshotPath}' '${dbPath}'`,
    "",
    "  4. Re-verify in place, then restart the daemon (launchd restarts it,",
    "     or start it manually); it re-opens WAL mode on first write:",
    `       sqlite3 -readonly '${dbPath}' 'PRAGMA integrity_check;'`,
    "       launchctl start <keeperd label>",
    "",
    "The snapshot is a freelist-compacted (VACUUM INTO) copy, so the restored",
    "DB is also the SIZE-RECLAIMED image — restore doubles as offline VACUUM.",
  ].join("\n");
}

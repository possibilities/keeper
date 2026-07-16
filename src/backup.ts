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
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The string `PRAGMA integrity_check` returns on a healthy DB: exactly one row
 * whose value is the literal `ok`. Anything else is structural corruption.
 */
export const INTEGRITY_CHECK_OK = "ok";

/**
 * Daemon backup cadence (ms). 48h — a backup is a recovery floor, not a
 * point-in-time guarantee (the event log is the source of truth and is already
 * proactively integrity-probed every 15 min), so a rolling verified snapshot
 * is the right recovery window without churning the disk on a full-DB copy.
 * Far slacker than the 15 min integrity probe / 30 s checkpoint heartbeats by
 * design: backup is a heavy producer-side op (a full `VACUUM INTO` copy +
 * `integrity_check`), so it runs rarely and off the hot path.
 *
 * On a multi-GB live DB, a full `VACUUM INTO` + `integrity_check` pass is the
 * dominant source of backup I/O churn, so this cadence is deliberately wide:
 * halving the frequency halves that churn with no loss of restore correctness
 * — verify-on-write is unchanged, and the two faster safety nets this backup
 * layers on top of (the immutable event log + the 15 min integrity probe)
 * already catch corruption well inside the window. No compensating
 * `wal_checkpoint(TRUNCATE)` is needed alongside this cadence: a `VACUUM INTO`
 * destination is always written in `journal_mode=DELETE` regardless of the
 * source's mode (verified empirically), so the snapshot carries no WAL to
 * checkpoint; the source DB's own WAL is checkpointed by the steady-state
 * retention pass (`src/compaction.ts` via daemon.ts), which already runs
 * `PRAGMA wal_checkpoint(PASSIVE)` after every batch that moved bytes —
 * deliberately PASSIVE, not TRUNCATE, so it never starves a concurrent writer.
 */
export const BACKUP_INTERVAL_MS = 172_800_000;

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

/**
 * Default startup delay (ms) before a boot-time catch-up backup fires (fn-753).
 * Short enough that a keeperd that restarts more often than the backup
 * interval ({@link BACKUP_INTERVAL_MS}) — the LaunchAgent crash-recovery
 * scenario, where a plain `setInterval` would
 * silently never reach its first fire) still lands a snapshot promptly, but
 * long enough to stay off the boot-drain critical path — the catch-up is a
 * heavy `VACUUM INTO`, so it waits for the daemon to settle first.
 */
export const BACKUP_CATCHUP_DELAY_MS = 45_000;

/**
 * The chronological epoch-ms of the NEWEST verified snapshot in `backupDir`, or
 * `null` if the dir is missing/empty or holds no `keeper-<stamp>.db` file.
 *
 * Snapshot names sort chronologically by their lexical `YYYYMMDDTHHMMSS` stamp
 * (see {@link snapshotName}), so the lexically-greatest matching name is the
 * newest — no `statSync` mtime trust (a copy/restore rewrites mtimes). The
 * stamp is parsed as LOCAL time to match how {@link snapshotName} mints it
 * (`getFullYear`/`getHours`/etc.), so the round-trip is symmetric across DST.
 * Pure read of the dir; never throws (a missing dir or unparseable name ⇒
 * `null`).
 */
export function newestSnapshotMsFromNames(
  names: readonly string[],
): number | null {
  const newest = names
    .filter((n) => /^keeper-\d{8}T\d{6}\.db$/.test(n))
    .sort()
    .at(-1);
  if (newest === undefined) return null;
  // keeper-YYYYMMDDTHHMMSS.db — slice the fixed-width stamp out of the name.
  const m = newest.match(
    /^keeper-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.db$/,
  );
  if (m === null) return null;
  const [, y, mo, d, h, mi, s] = m;
  const ts = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  ).getTime();
  return Number.isNaN(ts) ? null : ts;
}

export function newestSnapshotMs(backupDir: string): number | null {
  try {
    return newestSnapshotMsFromNames(readdirSync(backupDir));
  } catch {
    return null;
  }
}

export function isCatchUpDueFromNewest(
  newestMs: number | null,
  nowMs: number,
  intervalMs: number = BACKUP_INTERVAL_MS,
): boolean {
  return newestMs === null || nowMs - newestMs >= intervalMs;
}

/**
 * Whether a boot-time catch-up backup is due (fn-753): true iff there is NO
 * newest snapshot, OR the newest is at least `intervalMs` old as of `nowMs`.
 * Pure given its inputs (`nowMs` injectable for tests; production passes
 * `Date.now()`). A future-dated snapshot (clock skew) reads as fresh ⇒ no
 * catch-up, the conservative choice.
 */
export function isCatchUpDue(
  backupDir: string,
  nowMs: number,
  intervalMs: number = BACKUP_INTERVAL_MS,
): boolean {
  return isCatchUpDueFromNewest(newestSnapshotMs(backupDir), nowMs, intervalMs);
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
  /** Paths whose best-effort cleanup failed. */
  cleanupFailures: string[];
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
  /** Physical storage boundary; production uses SQLite and the filesystem. */
  operations?: BackupStorageOperations;
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
export interface PruneResult {
  pruned: string[];
  failed: string[];
}

export function planSnapshotPrune(
  backupDir: string,
  names: readonly string[],
  retain: number,
): string[] {
  return names
    .filter((name) => /^keeper-\d{8}T\d{6}\.db$/.test(name))
    .sort()
    .reverse()
    .slice(Math.max(0, retain))
    .map((name) => join(backupDir, name));
}

export function executeSnapshotPrune(
  stale: readonly string[],
  remove: (path: string) => void,
): PruneResult {
  const result: PruneResult = { pruned: [], failed: [] };
  for (const path of stale) {
    try {
      remove(path);
      result.pruned.push(path);
    } catch {
      result.failed.push(path);
    }
  }
  return result;
}

export function pruneSnapshots(backupDir: string, retain: number): string[] {
  let names: string[];
  try {
    names = readdirSync(backupDir);
  } catch {
    return [];
  }
  return executeSnapshotPrune(
    planSnapshotPrune(backupDir, names, retain),
    (path) => rmSync(path, { force: true }),
  ).pruned;
}

export interface BackupPlan {
  sourcePath: string;
  backupDir: string;
  snapshotPath: string;
  retain: number;
}

export interface BackupStorageOperations {
  ensureDirectory(path: string): void;
  createSnapshot(sourcePath: string, snapshotPath: string): void;
  verify(snapshotPath: string): string[];
  remove(path: string): void;
  size(path: string): number;
  list(path: string): string[];
}

export function planBackup(
  dbPath: string,
  options: Pick<BackupOptions, "backupDir" | "now" | "retain"> = {},
): BackupPlan {
  const backupDir = options.backupDir ?? resolveBackupDir(dbPath);
  return {
    sourcePath: dbPath,
    backupDir,
    snapshotPath: join(backupDir, snapshotName(options.now ?? new Date())),
    retain: options.retain ?? DEFAULT_BACKUP_RETENTION,
  };
}

function defaultBackupStorage(): BackupStorageOperations {
  return {
    ensureDirectory: (path) => mkdirSync(path, { recursive: true }),
    createSnapshot: (sourcePath, snapshotPath) => {
      const src = new Database(sourcePath, { readonly: true });
      try {
        src.run(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
      } finally {
        src.close();
      }
    },
    verify: verifySnapshot,
    remove: (path) => rmSync(path, { force: true }),
    size: (path) => statSync(path).size,
    list: readdirSync,
  };
}

function cleanupPath(
  path: string,
  operations: { remove(path: string): void },
): string[] {
  try {
    operations.remove(path);
    return [];
  } catch {
    return [path];
  }
}

export function executeBackupPlan(
  plan: BackupPlan,
  operations: BackupStorageOperations,
): BackupResult {
  operations.ensureDirectory(plan.backupDir);
  try {
    operations.createSnapshot(plan.sourcePath, plan.snapshotPath);
  } catch (err) {
    return {
      snapshotPath: null,
      verified: false,
      bytes: 0,
      pruned: [],
      cleanupFailures: cleanupPath(plan.snapshotPath, operations),
      error: `VACUUM INTO failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let rows: string[];
  try {
    rows = operations.verify(plan.snapshotPath);
  } catch (err) {
    return {
      snapshotPath: null,
      verified: false,
      bytes: 0,
      pruned: [],
      cleanupFailures: cleanupPath(plan.snapshotPath, operations),
      error: `snapshot verification threw (deleted): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!isVerifiedOk(rows)) {
    return {
      snapshotPath: null,
      verified: false,
      bytes: 0,
      pruned: [],
      cleanupFailures: cleanupPath(plan.snapshotPath, operations),
      error: `snapshot failed integrity_check (deleted): ${rows.slice(0, 5).join("; ")}`,
    };
  }

  let bytes = 0;
  try {
    bytes = operations.size(plan.snapshotPath);
  } catch {
    // Size is informational only.
  }
  let prune: PruneResult = { pruned: [], failed: [] };
  try {
    prune = executeSnapshotPrune(
      planSnapshotPrune(
        plan.backupDir,
        operations.list(plan.backupDir),
        plan.retain,
      ),
      operations.remove,
    );
  } catch {
    // Listing failure does not invalidate a verified snapshot.
  }
  return {
    snapshotPath: plan.snapshotPath,
    verified: true,
    bytes,
    pruned: prune.pruned,
    cleanupFailures: prune.failed,
    error: null,
  };
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
  return executeBackupPlan(
    planBackup(dbPath, options),
    options.operations ?? defaultBackupStorage(),
  );
}

/** Outcome of a single {@link reclaimDb} run — pure data the caller logs. */
export interface ReclaimResult {
  /** Absolute path of the reclaimed output file, or `null` on failure. */
  outputPath: string | null;
  /** True iff the output was produced AND passed `quick_check`. */
  ok: boolean;
  /** Byte size of the source DB (0 if unreadable). */
  sourceBytes: number;
  /** Byte size of the reclaimed output (0 on failure). */
  outputBytes: number;
  /** Output paths whose best-effort cleanup failed. */
  cleanupFailures: string[];
  /** Human-readable error when `ok` is false; `null` on success. */
  error: string | null;
}

/**
 * Produce a freelist-compacted, SIZE-RECLAIMED copy of `dbPath` at `outputPath`
 * with `auto_vacuum=INCREMENTAL` BAKED IN, gated on `PRAGMA quick_check`. The
 * physical-reclaim half of the fn-836.4 shed: after the migration logically
 * drops `event_blobs`, the live file still carries the freed pages on the
 * freelist (an in-place online VACUUM is deliberately never run — it rewrites
 * the whole multi-GB DB under the writer lock), so the operator runs this
 * OFFLINE (daemon stopped) and atomically `mv`s the output over the live DB.
 *
 * Why the output carries `auto_vacuum=INCREMENTAL` WITHOUT an explicit bake:
 * `VACUUM INTO` copies the SOURCE's auto_vacuum mode into the generated file,
 * and the live DB is already born INCREMENTAL (=2), so the output inherits it.
 * The steady-state retention pass (fn-836.5) can return freed overflow pages to
 * the OS via `PRAGMA incremental_vacuum` only if the file was BORN INCREMENTAL,
 * which inheritance guarantees here. Setting `PRAGMA auto_vacuum=...` on the
 * read-only source is BOTH redundant and illegal — it writes the header and so
 * throws "attempt to write a readonly database" once the source already differs
 * from the requested mode — so it is never issued; the self-verify gate below
 * asserts the inherited mode is 2 (verified: the output reads back `auto_vacuum=2`).
 *
 * `quick_check` (not the full `integrity_check`) is the go/no-go gate per the
 * task Approach — a bounded structural sweep on the freshly-defragmented output,
 * affordable once off the hot path. A failing output is DELETED and `ok:false`
 * returned: never leave a corrupt reclaim masquerading as good (mv-ing it would
 * propagate corruption). On success the output is chmod'd to match the source's
 * mode so the atomic `mv` preserves permissions. Producer-side: reads the source
 * over a DEDICATED read-only connection (no writer-lock contention), writes only
 * the output file, never the live DB. The caller does the atomic `mv` + stale
 * `-wal`/`-shm` cleanup (see {@link reclaimInstructions}); this function only
 * produces and gates the output.
 */
export interface ReclaimPlan {
  sourcePath: string;
  outputPath: string;
}

export interface ReclaimOutputInspection {
  quickCheckRows: string[];
  autoVacuum: number;
}

export interface ReclaimStorageOperations {
  sourceInfo(path: string): { bytes: number; mode: number };
  remove(path: string): void;
  createReclaimed(sourcePath: string, outputPath: string): void;
  inspectOutput(path: string): ReclaimOutputInspection;
  chmod(path: string, mode: number): void;
  size(path: string): number;
}

export function planReclaim(
  sourcePath: string,
  outputPath: string,
): ReclaimPlan {
  return { sourcePath, outputPath };
}

export function decideReclaimOutput(
  inspection: ReclaimOutputInspection,
): string | null {
  if (!isVerifiedOk(inspection.quickCheckRows)) {
    return "reclaimed output failed quick_check (deleted)";
  }
  if (inspection.autoVacuum !== 2) {
    return `reclaimed output did not bake auto_vacuum=INCREMENTAL (got ${inspection.autoVacuum}, deleted)`;
  }
  return null;
}

function defaultReclaimStorage(): ReclaimStorageOperations {
  return {
    sourceInfo: (path) => {
      const st = statSync(path);
      return { bytes: st.size, mode: st.mode };
    },
    remove: (path) => rmSync(path, { force: true }),
    createReclaimed: (sourcePath, outputPath) => {
      const src = new Database(sourcePath, { readonly: true });
      try {
        src.run(`VACUUM INTO '${outputPath.replace(/'/g, "''")}'`);
      } finally {
        src.close();
      }
    },
    inspectOutput: (path) => {
      const out = new Database(path, { readonly: true });
      try {
        const qc = out.query("PRAGMA quick_check").all() as Record<
          string,
          unknown
        >[];
        const quickCheckRows = qc.map((row) =>
          String(
            "quick_check" in row ? row.quick_check : Object.values(row)[0],
          ),
        );
        const av = out.query("PRAGMA auto_vacuum").get() as {
          auto_vacuum?: unknown;
        } | null;
        return {
          quickCheckRows,
          autoVacuum: typeof av?.auto_vacuum === "number" ? av.auto_vacuum : 0,
        };
      } finally {
        out.close();
      }
    },
    chmod: chmodSync,
    size: (path) => statSync(path).size,
  };
}

export function executeReclaimPlan(
  plan: ReclaimPlan,
  operations: ReclaimStorageOperations,
): ReclaimResult {
  let source: { bytes: number; mode: number };
  try {
    source = operations.sourceInfo(plan.sourcePath);
  } catch {
    return {
      outputPath: null,
      ok: false,
      sourceBytes: 0,
      outputBytes: 0,
      cleanupFailures: [],
      error: `source DB not readable: ${plan.sourcePath}`,
    };
  }

  try {
    operations.remove(plan.outputPath);
  } catch {
    // Creation reports a useful error if an existing output cannot be removed.
  }
  try {
    operations.createReclaimed(plan.sourcePath, plan.outputPath);
  } catch (err) {
    return {
      outputPath: null,
      ok: false,
      sourceBytes: source.bytes,
      outputBytes: 0,
      cleanupFailures: cleanupPath(plan.outputPath, operations),
      error: `VACUUM INTO failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let inspection: ReclaimOutputInspection;
  try {
    inspection = operations.inspectOutput(plan.outputPath);
  } catch (err) {
    return {
      outputPath: null,
      ok: false,
      sourceBytes: source.bytes,
      outputBytes: 0,
      cleanupFailures: cleanupPath(plan.outputPath, operations),
      error: `quick_check threw (deleted): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const refusal = decideReclaimOutput(inspection);
  if (refusal !== null) {
    return {
      outputPath: null,
      ok: false,
      sourceBytes: source.bytes,
      outputBytes: 0,
      cleanupFailures: cleanupPath(plan.outputPath, operations),
      error: refusal,
    };
  }

  try {
    operations.chmod(plan.outputPath, source.mode & 0o777);
  } catch {
    // Permissions are best-effort and reasserted by the swap.
  }
  let outputBytes = 0;
  try {
    outputBytes = operations.size(plan.outputPath);
  } catch {
    // Size is informational only.
  }
  return {
    outputPath: plan.outputPath,
    ok: true,
    sourceBytes: source.bytes,
    outputBytes,
    cleanupFailures: [],
    error: null,
  };
}

export function reclaimDb(
  dbPath: string,
  outputPath: string,
  operations: ReclaimStorageOperations = defaultReclaimStorage(),
): ReclaimResult {
  return executeReclaimPlan(planReclaim(dbPath, outputPath), operations);
}

/**
 * Read the stored `meta.schema_version` from an OPEN read-only DB handle, or
 * `null` if the row is absent/unparseable. Used by the reclaim self-verify to
 * assert the migration version round-tripped unchanged through the `VACUUM
 * INTO` rebuild (a defragmented copy preserves every row, so the version MUST
 * be identical — a mismatch means the swap targeted the wrong file or the copy
 * is structurally wrong).
 */
export function readSchemaVersion(db: Database): number | null {
  try {
    const row = db
      .query("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value?: unknown } | null;
    const raw = row?.value;
    const n = typeof raw === "string" ? Number.parseInt(raw, 10) : Number(raw);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Per-table row counts for every USER table in an OPEN read-only DB handle,
 * keyed by table name. Internal `sqlite_*` tables are excluded (their bookkeeping
 * rows are an implementation detail a `VACUUM INTO` rebuild legitimately
 * rewrites). Table names come from `sqlite_master`, so the set adapts as the
 * schema grows — the self-verify covers `events` (the canonical fold source) AND
 * every projection without a hand-maintained list to drift. Sorted by name for a
 * stable comparison order.
 */
export function readTableRowCounts(db: Database): Record<string, number> {
  const tables = (
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
  const counts: Record<string, number> = {};
  for (const t of tables) {
    // Identifier is a sqlite_master table name (not user input); quote it
    // defensively all the same.
    const quoted = t.replace(/"/g, '""');
    const row = db.query(`SELECT COUNT(*) AS n FROM "${quoted}"`).get() as {
      n?: unknown;
    } | null;
    counts[t] = typeof row?.n === "number" ? row.n : 0;
  }
  return counts;
}

/** Outcome of a {@link verifyReclaim} self-verify — pure data the caller logs. */
export interface ReclaimVerifyResult {
  /** True iff EVERY checked invariant holds (the go/no-go for the swap). */
  ok: boolean;
  /** Source schema_version (`null` if unreadable). */
  sourceSchemaVersion: number | null;
  /** Output schema_version (`null` if unreadable). */
  outputSchemaVersion: number | null;
  /** Output `PRAGMA auto_vacuum` mode (2 == INCREMENTAL is required). */
  outputAutoVacuum: number;
  /** First mismatch detail (`null` on success); names the failing invariant. */
  error: string | null;
}

export interface ReclaimVerificationSnapshot {
  schemaVersion: number | null;
  autoVacuum: number;
  tableRowCounts: Record<string, number>;
}

export function decideReclaimVerification(
  source: ReclaimVerificationSnapshot,
  output: ReclaimVerificationSnapshot,
): ReclaimVerifyResult {
  const base = {
    sourceSchemaVersion: source.schemaVersion,
    outputSchemaVersion: output.schemaVersion,
    outputAutoVacuum: output.autoVacuum,
  };
  if (
    source.schemaVersion === null ||
    output.schemaVersion === null ||
    source.schemaVersion !== output.schemaVersion
  ) {
    return {
      ...base,
      ok: false,
      error: `schema_version mismatch (source=${source.schemaVersion}, output=${output.schemaVersion})`,
    };
  }
  if (output.autoVacuum !== 2) {
    return {
      ...base,
      ok: false,
      error: `output auto_vacuum is ${output.autoVacuum}, expected 2 (INCREMENTAL)`,
    };
  }
  const srcTables = Object.keys(source.tableRowCounts).sort();
  const outTables = Object.keys(output.tableRowCounts).sort();
  if (srcTables.join(",") !== outTables.join(",")) {
    return {
      ...base,
      ok: false,
      error: `table set differs (source: ${srcTables.join("|")}; output: ${outTables.join("|")})`,
    };
  }
  for (const table of srcTables) {
    if (source.tableRowCounts[table] !== output.tableRowCounts[table]) {
      return {
        ...base,
        ok: false,
        error: `row-count mismatch on '${table}' (source=${source.tableRowCounts[table]}, output=${output.tableRowCounts[table]})`,
      };
    }
  }
  return { ...base, ok: true, error: null };
}

/**
 * Self-verify a freshly-{@link reclaimDb}'d OUTPUT against its SOURCE before the
 * operator swaps it in: the reclaimed copy must open clean, carry the SAME
 * `schema_version`, bake `auto_vacuum=INCREMENTAL` (=2), and reproduce IDENTICAL
 * per-table row counts on every user table (so no row — least of all an `events`
 * row, the fold source — was lost or duplicated by the rebuild). The Early-proof
 * point: this runs BEFORE the pre-reclaim snapshot is discarded, so a swap that
 * would corrupt or lose rows is caught while the original is still recoverable.
 *
 * Opens BOTH paths read-only on dedicated short-lived connections (no writer
 * lock); returns the first failing invariant in `error`. Any open/query throw is
 * itself a verify failure (a reclaimed DB that won't open read-only is not
 * swap-safe).
 */
export function verifyReclaim(
  sourcePath: string,
  outputPath: string,
): ReclaimVerifyResult {
  let src: Database | null = null;
  let out: Database | null = null;
  try {
    src = new Database(sourcePath, { readonly: true });
    out = new Database(outputPath, { readonly: true });

    const avRow = out.query("PRAGMA auto_vacuum").get() as {
      auto_vacuum?: unknown;
    } | null;
    return decideReclaimVerification(
      {
        schemaVersion: readSchemaVersion(src),
        autoVacuum: 0,
        tableRowCounts: readTableRowCounts(src),
      },
      {
        schemaVersion: readSchemaVersion(out),
        autoVacuum:
          typeof avRow?.auto_vacuum === "number" ? avRow.auto_vacuum : 0,
        tableRowCounts: readTableRowCounts(out),
      },
    );
  } catch (err) {
    return {
      ok: false,
      sourceSchemaVersion: null,
      outputSchemaVersion: null,
      outputAutoVacuum: 0,
      error: `reclaim self-verify threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  } finally {
    try {
      src?.close();
    } catch {
      /* best-effort */
    }
    try {
      out?.close();
    } catch {
      /* best-effort */
    }
  }
}

/**
 * keeperd's launchd job label. Mirrors `daemon.ts`'s `KEEPERD_LAUNCHD_LABEL`
 * (kept as a local literal rather than an import to avoid a backup.ts ↔
 * daemon.ts import cycle — daemon.ts already imports from backup.ts). Kept in
 * sync with `plist/arthack.keeperd.plist`'s `Label`.
 */
const KEEPERD_LAUNCHD_LABEL = "arthack.keeperd";

/** keeperd's resolved launchctl targets, for {@link reclaimInstructions}. */
export interface KeeperdTarget {
  /** `gui/<uid>` — the launchctl domain-target `bootstrap` takes. */
  domain: string;
  /** `gui/<uid>/arthack.keeperd` — the launchctl service target `bootout` takes. */
  service: string;
  /** The LaunchAgent plist path launchd is loaded from (or the conventional
   * install path, when not currently loaded). */
  plistPath: string;
}

/**
 * Injectable seams for {@link resolveKeeperdTarget} — production defaults to
 * the real platform/uid/launchctl/filesystem; tests inject fakes so resolution
 * stays a pure, subprocess-free unit test (no real `launchctl` spawn).
 */
export interface ResolveKeeperdTargetOptions {
  platform?: NodeJS.Platform;
  getuid?: () => number;
  /** Runs `launchctl print <service>` and returns its stdout; throws on any
   * failure (not loaded, launchctl missing, non-zero exit). */
  launchctlPrint?: (service: string) => string;
  existsSync?: (path: string) => boolean;
  homedir?: () => string;
}

/**
 * Resolve keeperd's launchctl service target and loaded plist path at render
 * time, so {@link reclaimInstructions} can print copy-pasteable commands
 * instead of `<keeperd label>` placeholders. Best-effort and read-only: `null`
 * whenever resolution isn't possible (non-macOS, no usable uid, launchd
 * unreachable, and no conventional plist on disk) — callers fall back to the
 * placeholder text. Never throws.
 */
export function resolveKeeperdTarget(
  options: ResolveKeeperdTargetOptions = {},
): KeeperdTarget | null {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return null;
  }
  const getuid =
    options.getuid ??
    (typeof process.getuid === "function" ? process.getuid : undefined);
  let uid: number;
  try {
    uid = getuid ? getuid() : NaN;
  } catch {
    uid = NaN;
  }
  if (!Number.isInteger(uid) || uid < 0) {
    return null;
  }
  const domain = `gui/${uid}`;
  const service = `${domain}/${KEEPERD_LAUNCHD_LABEL}`;

  // Ask launchd for the plist it actually loaded this service from — the
  // authoritative path while the agent is loaded. `execFileSync` (no shell)
  // so there is nothing here to interpolate.
  const launchctlPrint =
    options.launchctlPrint ??
    ((svc: string) =>
      execFileSync("launchctl", ["print", svc], {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      }));
  let plistPath: string | null = null;
  try {
    const out = launchctlPrint(service);
    const match = out.match(/^[ \t]*path[ \t]*=[ \t]*(\S+\.plist)[ \t]*$/m);
    if (match) {
      plistPath = match[1];
    }
  } catch {
    /* not loaded, launchctl missing, or a print-format change — fall through */
  }

  // Not currently loaded (or unparseable) — the conventional install location
  // (scripts/install.sh symlinks the repo plist here).
  if (plistPath === null) {
    const exists = options.existsSync ?? existsSync;
    const home = options.homedir ?? homedir;
    const conventional = join(
      home(),
      "Library",
      "LaunchAgents",
      `${KEEPERD_LAUNCHD_LABEL}.plist`,
    );
    if (exists(conventional)) {
      plistPath = conventional;
    }
  }

  return plistPath === null ? null : { domain, service, plistPath };
}

/**
 * The DOCUMENTED offline reclaim procedure — pause autopilot, catch-up drain,
 * checkpoint, reclaim, gate, atomic mv, clear stale sidecars, restart, verify.
 * Rendered as a single source of truth here.
 *
 * Covers BOTH offline reclaims: the fn-836.4 `event_blobs` shed and the fn-837
 * retention-predicate widening. The fn-837 version prepends the autopilot-pause
 * interlock + the one-shot catch-up drain (`bun scripts/reclaim-db.ts`) — the
 * steady-state 300s timer would take hours to drain the widened historical
 * backlog and the file won't shrink without the `VACUUM INTO`. Autopilot is
 * level-triggered on `PRAGMA data_version`, which the VACUUM bumps, so it MUST be
 * paused BEFORE the daemon is stopped. Run the VACUUM step with the daemon
 * STOPPED; keep the pre-reclaim snapshot as the rollback until the restarted
 * binary verifies.
 *
 * `target` defaults to {@link resolveKeeperdTarget}'s render-time resolution
 * (real service + plist path); pass it explicitly (or `null`) to pin the
 * rendered bootout/bootstrap lines, e.g. in tests.
 */
export function reclaimInstructions(
  outputPath: string,
  dbPath: string,
  target: KeeperdTarget | null = resolveKeeperdTarget(),
): string {
  const bootoutLine = target
    ? `       launchctl bootout ${target.service}   # or: launchctl stop`
    : "       launchctl bootout <keeperd label>   # or: launchctl stop";
  const bootstrapLine = target
    ? `       launchctl bootstrap ${target.domain} ${target.plistPath} && keeper await server-up`
    : "       launchctl bootstrap <keeperd domain/label> && keeper await server-up";
  return [
    "Offline retention-shed reclaim (daemon STOPPED for the VACUUM):",
    "",
    "  1. Pause autopilot FIRST — it is level-triggered on PRAGMA data_version,",
    "     which the VACUUM bumps; pausing before the daemon stops avoids a",
    "     dispatch racing the swapped-in file:",
    "       keeper autopilot pause",
    "",
    "  2. Drain the widened cold shed-class backlog to completion while the",
    "     daemon is still UP (the SAME paced ≤500-row/tx retention, driven to",
    "     completion; idempotent — safe to re-run):",
    "       bun scripts/reclaim-db.ts   # drains, then reprints this runbook",
    "",
    "  3. Precheck free disk — VACUUM INTO needs ~1-1.5 GB transient headroom —",
    "     then stop the daemon so nothing holds the writer lock or a stale WAL:",
    `       df -h "$(dirname '${dbPath}')"`,
    bootoutLine,
    "",
    "  4. Keep a pre-reclaim snapshot as the rollback (verified VACUUM INTO copy):",
    "       bun scripts/backup-db.ts   # or the existing rolling snapshot",
    "",
    "  5. Checkpoint the WAL fully into the main DB, then reclaim into a new file",
    "     with auto_vacuum=INCREMENTAL baked + quick_check gate:",
    `       sqlite3 '${dbPath}' 'PRAGMA wal_checkpoint(FULL);'`,
    "       # reclaimDb(dbPath, outputPath) does the VACUUM INTO + gate",
    "",
    "  6. Atomically move the reclaimed file into place (SAME filesystem) and",
    "     drop the stale WAL/SHM sidecars (they belong to the OLD file):",
    `       mv '${outputPath}' '${dbPath}'`,
    `       rm -f '${dbPath}-wal' '${dbPath}-shm'`,
    "",
    "  7. Restart, wait for server-up, then verify before discarding the snapshot",
    "     and re-enabling autopilot:",
    bootstrapLine,
    `       sqlite3 -readonly '${dbPath}' 'PRAGMA auto_vacuum;'   # 2 (INCREMENTAL)`,
    `       ls -lh '${dbPath}'                                    # ~0.6 GB`,
    `       sqlite3 -readonly '${dbPath}' "SELECT id FROM events WHERE hook_event = 'UserPromptSubmit' AND instr(json_extract(data, '$.prompt'), 'known term') > 0 LIMIT 1;"   # Keeper event retained`,
    "       keeper history search --syntax literal --format json --limit 1 -- 'known term'   # native history searchable",
    "       keeper autopilot play                                # re-enable",
    "",
    "If post-restart verification fails: stop the daemon, mv the pre-reclaim",
    "snapshot back, restart, leave autopilot paused for triage. Never delete the",
    "snapshot until verification passes.",
  ].join("\n");
}

/**
 * The DOCUMENTED restore procedure (the task Acceptance requires it be
 * documented, not assumed). Also rendered by `scripts/backup-db.ts` after a
 * successful backup so the operator always has the steps to hand. Kept as a
 * single source of truth here.
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

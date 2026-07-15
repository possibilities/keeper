import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { FileLock } from "../file-lock";
import { keeperStateDir } from "../keeper-state-dir";

export const HISTORY_INDEX_SCHEMA_VERSION = 3;
export const HISTORY_INDEX_APPLICATION_ID = 0x4b485354; // "KHST"

export interface HistoryIndexPaths {
  directory: string;
  database: string;
  lock: string;
}

export function resolveHistoryIndexPaths(
  stateDir: string = keeperStateDir(),
): HistoryIndexPaths {
  const directory = join(resolve(stateDir), "history");
  return {
    directory,
    database: join(directory, "index.sqlite"),
    lock: join(directory, "index.lock"),
  };
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function assertSeparateHistoryIndex(path: string): void {
  if (basename(resolve(path)) === "keeper.db") {
    throw new Error("history index must not use keeper.db");
  }
}

const HISTORY_INDEX_SCHEMA = `
  CREATE TABLE history_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID;

  CREATE TABLE sources (
    source_key TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,
    harness TEXT NOT NULL,
    native_id TEXT NOT NULL,
    artifact_path TEXT NOT NULL,
    transcript_source TEXT NOT NULL,
    project TEXT,
    title TEXT,
    title_history TEXT NOT NULL,
    artifact_title TEXT,
    artifact_title_history TEXT NOT NULL,
    artifact_title_history_complete INTEGER NOT NULL,
    stat_fingerprint TEXT NOT NULL,
    content_fingerprint TEXT NOT NULL,
    source_size INTEGER NOT NULL,
    source_mtime_ms REAL NOT NULL,
    indexed_at_ms REAL NOT NULL
  ) WITHOUT ROWID;

  CREATE INDEX idx_sources_session ON sources(session_key, source_key);
  CREATE INDEX idx_sources_native ON sources(harness, native_id, source_key);
  CREATE INDEX idx_sources_project ON sources(project, source_key);

  CREATE TABLE entries (
    id INTEGER PRIMARY KEY,
    source_key TEXT NOT NULL REFERENCES sources(source_key) ON DELETE CASCADE,
    source_ordinal INTEGER NOT NULL,
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
    timestamp TEXT,
    timestamp_ms REAL,
    body TEXT NOT NULL,
    tool_name TEXT,
    native_entry_id TEXT,
    parent_native_entry_id TEXT,
    UNIQUE(source_key, source_ordinal)
  );

  CREATE INDEX idx_entries_source_order
    ON entries(source_key, source_ordinal, id);
  CREATE INDEX idx_entries_time ON entries(timestamp_ms, id);
  CREATE INDEX idx_entries_role ON entries(role, id);

  CREATE TABLE file_evidence (
    id INTEGER PRIMARY KEY,
    session_key TEXT NOT NULL,
    source_key TEXT NOT NULL REFERENCES sources(source_key) ON DELETE CASCADE,
    path TEXT NOT NULL,
    grade TEXT NOT NULL,
    provenance_source TEXT NOT NULL,
    transcript_source TEXT NOT NULL,
    source_ordinal INTEGER,
    native_entry_id TEXT,
    parent_native_entry_id TEXT
  );

  CREATE INDEX idx_file_evidence_path
    ON file_evidence(path, grade, session_key, id);
  CREATE INDEX idx_file_evidence_session
    ON file_evidence(session_key, grade, path, id);
  CREATE INDEX idx_file_evidence_source
    ON file_evidence(source_key, source_ordinal, id);

  CREATE VIRTUAL TABLE entries_fts USING fts5(
    body,
    content='entries',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  );

  CREATE TRIGGER entries_fts_insert AFTER INSERT ON entries BEGIN
    INSERT INTO entries_fts(rowid, body) VALUES (new.id, new.body);
  END;
  CREATE TRIGGER entries_fts_delete AFTER DELETE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, body)
      VALUES ('delete', old.id, old.body);
  END;
  CREATE TRIGGER entries_fts_update AFTER UPDATE OF body ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, body)
      VALUES ('delete', old.id, old.body);
    INSERT INTO entries_fts(rowid, body) VALUES (new.id, new.body);
  END;
`;

function configureConnection(db: Database): void {
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA temp_store = MEMORY");
}

export function createHistoryIndexDatabase(path: string): Database {
  assertSeparateHistoryIndex(path);
  ensurePrivateDirectory(dirname(path));
  rmSync(path, { force: true });
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
  rmSync(`${path}-journal`, { force: true });
  // Pre-create with the final owner-only mode; the containing 0700 directory
  // protects SQLite's transient journal companion as well.
  const seedFd = openSync(path, "wx", 0o600);
  closeSync(seedFd);
  let db: Database;
  try {
    db = new Database(path, { create: true, strict: true });
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
  try {
    configureConnection(db);
    // A closed rebuild must be a single-file publication; DELETE mode leaves no
    // WAL/SHM companions after close.
    db.run("PRAGMA journal_mode = DELETE");
    db.run("PRAGMA synchronous = FULL");
    db.exec(HISTORY_INDEX_SCHEMA);
    db.run(
      "INSERT INTO history_meta(key, value) VALUES ('schema_version', ?)",
      [String(HISTORY_INDEX_SCHEMA_VERSION)],
    );
    db.run(`PRAGMA application_id = ${HISTORY_INDEX_APPLICATION_ID}`);
    db.run(`PRAGMA user_version = ${HISTORY_INDEX_SCHEMA_VERSION}`);
    chmodSync(path, 0o600);
    return db;
  } catch (error) {
    db.close();
    rmSync(path, { force: true });
    throw error;
  }
}

export type HistoryIndexStatus =
  | { kind: "missing" }
  | { kind: "ready"; schemaVersion: number }
  | { kind: "incompatible"; schemaVersion: number | null }
  | { kind: "unreadable" };

function pragmaNumber(db: Database, name: string): number | null {
  const row = db.query(`PRAGMA ${name}`).get() as Record<
    string,
    unknown
  > | null;
  if (row === null) return null;
  const value = Object.values(row)[0];
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function inspectOpenHistoryIndex(db: Database): HistoryIndexStatus {
  const applicationId = pragmaNumber(db, "application_id");
  const schemaVersion = pragmaNumber(db, "user_version");
  if (
    applicationId !== HISTORY_INDEX_APPLICATION_ID ||
    schemaVersion !== HISTORY_INDEX_SCHEMA_VERSION
  ) {
    return { kind: "incompatible", schemaVersion };
  }
  const meta = db
    .query("SELECT value FROM history_meta WHERE key = 'schema_version'")
    .get() as { value: string } | null;
  if (Number(meta?.value) !== HISTORY_INDEX_SCHEMA_VERSION) {
    return { kind: "incompatible", schemaVersion };
  }
  // Prepare every public read surface so a partially published/corrupt image is
  // never classified ready merely because its FTS root page survived.
  db.query("SELECT rowid FROM entries_fts LIMIT 0").all();
  db.query(
    "SELECT source_key, artifact_title, artifact_title_history, artifact_title_history_complete FROM sources LIMIT 0",
  ).all();
  db.query("SELECT id FROM file_evidence LIMIT 0").all();
  return { kind: "ready", schemaVersion };
}

export function inspectHistoryIndex(
  paths: HistoryIndexPaths,
): HistoryIndexStatus {
  assertSeparateHistoryIndex(paths.database);
  if (!existsSync(paths.database)) return { kind: "missing" };
  let db: Database | null = null;
  try {
    db = new Database(paths.database, { readonly: true, strict: true });
    configureConnection(db);
    return inspectOpenHistoryIndex(db);
  } catch {
    return { kind: "unreadable" };
  } finally {
    db?.close();
  }
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function acquireHistoryIndexLock(paths: HistoryIndexPaths): FileLock {
  assertSeparateHistoryIndex(paths.database);
  ensurePrivateDirectory(paths.directory);
  const lock = FileLock.acquire(paths.lock);
  chmodSync(paths.lock, 0o600);
  return lock;
}

/** Caller holds the History-index lock. The temporary DB is closed and fsynced before
 * its one atomic rename onto the publication path. */
function publishHistoryIndexRebuildLocked<T>(
  paths: HistoryIndexPaths,
  populate: (db: Database) => T,
): T {
  const temporary = `${paths.database}.rebuild-${process.pid}-${randomUUID()}`;
  let db: Database | null = null;
  try {
    db = createHistoryIndexDatabase(temporary);
    const result = populate(db);
    db.run("PRAGMA optimize");
    db.close();
    db = null;
    chmodSync(temporary, 0o600);
    fsyncPath(temporary);
    // A stale companion from a damaged/incompatible predecessor must not attach
    // itself to the newly renamed image.
    rmSync(`${paths.database}-wal`, { force: true });
    rmSync(`${paths.database}-shm`, { force: true });
    rmSync(`${paths.database}-journal`, { force: true });
    renameSync(temporary, paths.database);
    chmodSync(paths.database, 0o600);
    fsyncPath(paths.directory);
    return result;
  } finally {
    db?.close();
    rmSync(temporary, { force: true });
    rmSync(`${temporary}-wal`, { force: true });
    rmSync(`${temporary}-shm`, { force: true });
    rmSync(`${temporary}-journal`, { force: true });
  }
}

/** Build a fresh closed image and atomically publish it while holding the one
 * History-index lock. The callback never sees keeper.db. */
export function publishHistoryIndexRebuild<T>(
  paths: HistoryIndexPaths,
  populate: (db: Database) => T,
): T {
  const lock = acquireHistoryIndexLock(paths);
  try {
    return publishHistoryIndexRebuildLocked(paths, populate);
  } finally {
    lock.release();
  }
}

/** Ensure a compatible disposable image exists, rebuilding incompatible images
 * rather than migrating them in Keeper's schema ladder. */
export function ensureHistoryIndex(paths: HistoryIndexPaths): {
  rebuilt: boolean;
} {
  const lock = acquireHistoryIndexLock(paths);
  try {
    // Recheck only after serialization: a waiter that observed "missing" must
    // not replace the populated image another process published while it waited.
    if (inspectHistoryIndex(paths).kind === "ready") return { rebuilt: false };
    publishHistoryIndexRebuildLocked(paths, () => undefined);
    return { rebuilt: true };
  } finally {
    lock.release();
  }
}

/** Serialize one incremental write against rebuild/publication. */
export function withHistoryIndexWrite<T>(
  paths: HistoryIndexPaths,
  operation: (db: Database) => T,
): T {
  const lock = acquireHistoryIndexLock(paths);
  let db: Database | null = null;
  try {
    const status = inspectHistoryIndex(paths);
    if (status.kind !== "ready") {
      throw new Error("history index is not ready");
    }
    db = new Database(paths.database, { strict: true });
    configureConnection(db);
    db.run("PRAGMA journal_mode = DELETE");
    const result = operation(db);
    chmodSync(paths.database, 0o600);
    return result;
  } finally {
    db?.close();
    lock.release();
  }
}

/** Recheck readiness under the writer lock and either update the published
 * image or populate one closed replacement. Concurrent cold refreshes converge
 * on one build instead of each rebuilding from a stale pre-lock observation. */
export function refreshHistoryIndexDatabase<T>(
  paths: HistoryIndexPaths,
  operation: (db: Database, rebuilt: boolean) => T,
): T {
  const lock = acquireHistoryIndexLock(paths);
  let db: Database | null = null;
  try {
    if (inspectHistoryIndex(paths).kind !== "ready") {
      return publishHistoryIndexRebuildLocked(paths, (fresh) =>
        operation(fresh, true),
      );
    }
    db = new Database(paths.database, { strict: true });
    configureConnection(db);
    db.run("PRAGMA journal_mode = DELETE");
    const result = operation(db, false);
    chmodSync(paths.database, 0o600);
    return result;
  } finally {
    db?.close();
    lock.release();
  }
}

export function openHistoryIndexReadOnly(paths: HistoryIndexPaths): Database {
  assertSeparateHistoryIndex(paths.database);
  let db: Database | null = null;
  try {
    // Validate the same handle that is returned. There is no inspect-then-open
    // gap in which purge can remove the checked image; a racing reader opens
    // either the old inode or the newly published one, both complete images.
    db = new Database(paths.database, { readonly: true, strict: true });
    configureConnection(db);
    if (inspectOpenHistoryIndex(db).kind !== "ready") {
      throw new Error("history index is not ready");
    }
    const opened = db;
    db = null;
    return opened;
  } finally {
    db?.close();
  }
}

/** Remove only the closed private History-index image family. The lock file
 * remains as the serialization primitive and no path outside this index's
 * basename is touched. */
export function purgeHistoryIndex(paths: HistoryIndexPaths): void {
  const lock = acquireHistoryIndexLock(paths);
  try {
    assertSeparateHistoryIndex(paths.database);
    const rebuildPrefix = `${basename(paths.database)}.rebuild-`;
    let staleRebuilds: string[] = [];
    try {
      staleRebuilds = readdirSync(paths.directory, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.name.startsWith(rebuildPrefix) &&
            (entry.isFile() || entry.isSymbolicLink()),
        )
        .map((entry) => join(paths.directory, entry.name));
    } catch {
      // The directory was removed concurrently outside Keeper's lock. The fixed
      // image-family removals below remain safe no-ops.
    }
    for (const path of [
      paths.database,
      `${paths.database}-wal`,
      `${paths.database}-shm`,
      `${paths.database}-journal`,
      ...staleRebuilds,
    ]) {
      rmSync(path, { force: true });
    }
    if (existsSync(paths.directory)) fsyncPath(paths.directory);
  } finally {
    lock.release();
  }
}

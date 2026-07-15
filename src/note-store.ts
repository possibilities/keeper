/**
 * Durable note storage in its own SQLite file. This module never opens or
 * migrates keeper.db: notes.db has an independent `PRAGMA user_version` ladder
 * and only reuses keeper's connection-local pragmas.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { applyPragmas } from "./db";
import { keeperStateDir } from "./keeper-state-dir";
import { FileLock } from "./usage-flock";

/** The independent notes.db schema version. */
export const NOTES_SCHEMA_VERSION = 1;

/** Maximum UTF-8 size of one persisted note body (64 KiB). */
export const MAX_NOTE_BYTES = 64 * 1024;

const MAX_NOTE_ID_LENGTH = 128;
const NOTE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DRAFT_SUFFIX = ".md";

export type NoteState = "active" | "archived";
export type NoteDisposition = "clipboard" | "agent";

/** The optional launch context recorded when a note is archived. */
export interface ArchiveMetadata {
  project_path?: string | null;
  launch_triple?: string | null;
  launch_handle?: string | null;
}

/** A row from the independent notes store. */
export interface NoteRow {
  note_id: string;
  body: string;
  state: NoteState;
  revision: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  archived_via: NoteDisposition | null;
  project_path: string | null;
  launch_triple: string | null;
  launch_handle: string | null;
}

/** A failed optimistic mutation. */
export type MutationFailure = {
  ok: false;
  reason: "not_found" | "not_active" | "conflict";
};

export type NoteMutationResult = { ok: true; note: NoteRow } | MutationFailure;

export interface NoteStoreOpenOptions {
  dbPath?: string;
  now?: () => number;
  idFactory?: () => string;
}

/** One editor draft. `mtime` is milliseconds since the Unix epoch. */
export interface NoteDraft {
  id: string;
  path: string;
  mtime: number;
}

export interface NoteDraftCreateOptions {
  dbPath?: string;
  idFactory?: () => string;
}

const CREATE_NOTES = `
CREATE TABLE IF NOT EXISTS notes (
    note_id       TEXT PRIMARY KEY
                  CHECK (
                    length(note_id) BETWEEN 1 AND ${MAX_NOTE_ID_LENGTH}
                    AND note_id GLOB '[A-Za-z0-9]*'
                    AND note_id NOT GLOB '*[^A-Za-z0-9_-]*'
                  ),
    body          TEXT NOT NULL
                  CHECK (
                    length(body) > 0
                    AND instr(body, char(0)) = 0
                    AND length(CAST(body AS BLOB)) <= ${MAX_NOTE_BYTES}
                  ),
    state         TEXT NOT NULL
                  CHECK (state IN ('active', 'archived')),
    revision      INTEGER NOT NULL CHECK (
                    typeof(revision) = 'integer' AND revision >= 1
                  ),
    created_at    INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
    updated_at    INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer'),
    archived_at   INTEGER CHECK (
                    archived_at IS NULL OR typeof(archived_at) = 'integer'
                  ),
    archived_via  TEXT CHECK (
                    archived_via IS NULL
                    OR archived_via IN ('clipboard', 'agent')
                  ),
    project_path  TEXT,
    launch_triple TEXT,
    launch_handle TEXT,
    CHECK (
      (
        state = 'active'
        AND archived_at IS NULL
        AND archived_via IS NULL
        AND project_path IS NULL
        AND launch_triple IS NULL
        AND launch_handle IS NULL
      )
      OR
      (
        state = 'archived'
        AND archived_at IS NOT NULL
        AND archived_via IS NOT NULL
      )
    )
)
`;

const CREATE_NOTES_INDEX =
  "CREATE INDEX IF NOT EXISTS idx_notes_state_updated ON notes(state, updated_at DESC, note_id)";

/** Resolve notes.db without consulting keeper.db's path or configuration. */
export function resolveNotesDbPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.KEEPER_NOTES_DB;
  return override !== undefined && override.length > 0
    ? override
    : join(keeperStateDir(), "notes.db");
}

/**
 * Namespace sibling state by the configured database leaf. The canonical
 * `notes.db` keeps concise `notes-*` names; an override such as `work.db`
 * receives `work.db-*` siblings and cannot consume another store's drafts.
 */
export function noteStoreNamespace(
  dbPath: string = resolveNotesDbPath(),
): string {
  const leaf = basename(dbPath);
  return leaf === "notes.db" ? "notes" : leaf;
}

/** The advisory lock shared by migration and every note mutation. */
export function resolveNotesLockPath(
  dbPath: string = resolveNotesDbPath(),
): string {
  return join(dirname(dbPath), `${noteStoreNamespace(dbPath)}.lock`);
}

/** The private editor-draft directory beside notes.db. */
export function resolveNoteDraftsDir(
  dbPath: string = resolveNotesDbPath(),
): string {
  return join(dirname(dbPath), `${noteStoreNamespace(dbPath)}-drafts`);
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  // `mode` affects only a newly-created leaf; tighten an existing directory too.
  chmodSync(path, 0o700);
}

function ensureDbParent(path: string): void {
  const existed = existsSync(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  // The default Keeper state root is private state owned by this subsystem.
  // An explicit DB override may live in an operator-owned shared directory, so
  // never chmod an existing arbitrary parent behind their back.
  if (!existed || path === keeperStateDir()) chmodSync(path, 0o700);
}

function ensurePrivateDbFile(path: string): void {
  // Pre-create without truncation so SQLite never exposes a newly-created file
  // with its usual 0666 creation mode, even briefly.
  const fd = openSync(path, "a", 0o600);
  closeSync(fd);
  chmodSync(path, 0o600);
}

function storedSchemaVersion(db: Database): number {
  const row = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  } | null;
  return Number(row?.user_version ?? 0);
}

/** Apply the independent, forward-only notes.db migration ladder. */
export function migrateNotesDb(db: Database): void {
  const stored = storedSchemaVersion(db);
  if (stored > NOTES_SCHEMA_VERSION) {
    throw new Error(
      `notes.db schema v${stored} is newer than this binary's v${NOTES_SCHEMA_VERSION}; refusing to downgrade`,
    );
  }
  if (stored === NOTES_SCHEMA_VERSION) return;

  db.transaction(() => {
    if (stored < 1) {
      db.run(CREATE_NOTES);
      db.run(CREATE_NOTES_INDEX);
    }
    db.run(`PRAGMA user_version = ${NOTES_SCHEMA_VERSION}`);
  }).immediate();
}

function assertSafeId(id: string, kind = "note id"): void {
  if (typeof id !== "string" || !NOTE_ID_RE.test(id)) {
    throw new TypeError(
      `${kind} must match ${NOTE_ID_RE.source} and be at most ${MAX_NOTE_ID_LENGTH} characters`,
    );
  }
}

function assertBody(body: string): void {
  if (typeof body !== "string") {
    throw new TypeError("note body must be a string");
  }
  if (body.trim().length === 0) {
    throw new TypeError("note body must contain non-whitespace text");
  }
  if (body.includes("\0")) {
    throw new TypeError("note body must not contain NUL");
  }
  if (Buffer.byteLength(body, "utf8") > MAX_NOTE_BYTES) {
    throw new RangeError(`note body exceeds ${MAX_NOTE_BYTES} UTF-8 bytes`);
  }
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError("note timestamp must be a safe millisecond integer");
  }
}

function assertDisposition(value: NoteDisposition): void {
  if (value !== "clipboard" && value !== "agent") {
    throw new TypeError("note disposition must be clipboard or agent");
  }
}

function nullableString(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new TypeError("archive metadata values must be strings or null");
  }
  return value;
}

function rowToNote(row: Record<string, unknown>): NoteRow {
  return {
    note_id: String(row.note_id),
    body: String(row.body),
    state: row.state as NoteState,
    revision: Number(row.revision),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    archived_at: row.archived_at == null ? null : Number(row.archived_at),
    archived_via:
      row.archived_via == null
        ? null
        : (String(row.archived_via) as NoteDisposition),
    project_path: row.project_path == null ? null : String(row.project_path),
    launch_triple: row.launch_triple == null ? null : String(row.launch_triple),
    launch_handle: row.launch_handle == null ? null : String(row.launch_handle),
  };
}

/** A long-lived connection to the independent note database. */
export class NoteStore {
  readonly dbPath: string;

  private readonly db: Database;
  private readonly lockPath: string;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private closed = false;

  private constructor(
    dbPath: string,
    db: Database,
    now: () => number,
    idFactory: () => string,
  ) {
    this.dbPath = dbPath;
    this.db = db;
    this.lockPath = resolveNotesLockPath(dbPath);
    this.now = now;
    this.idFactory = idFactory;
  }

  /** Open, create, and migrate notes.db while holding its sibling flock. */
  static open(options: NoteStoreOpenOptions = {}): NoteStore {
    const dbPath = options.dbPath ?? resolveNotesDbPath();
    const parent = dirname(dbPath);
    ensureDbParent(parent);

    const lockPath = resolveNotesLockPath(dbPath);
    const lock = FileLock.acquire(lockPath);
    let db: Database | null = null;
    try {
      chmodSync(lockPath, 0o600);
      ensurePrivateDbFile(dbPath);
      db = new Database(dbPath, { create: true });
      applyPragmas(db);
      migrateNotesDb(db);
      chmodSync(dbPath, 0o600);
      return new NoteStore(
        dbPath,
        db,
        options.now ?? Date.now,
        options.idFactory ?? randomUUID,
      );
    } catch (error) {
      db?.close();
      throw error;
    } finally {
      lock.release();
    }
  }

  /** Close the owned connection. Repeated calls are harmless. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** List notes in deterministic newest-updated order. */
  list(state: NoteState | "all"): NoteRow[] {
    this.assertOpen();
    let rows: Record<string, unknown>[];
    if (state === "all") {
      rows = this.db
        .prepare("SELECT * FROM notes ORDER BY updated_at DESC, note_id ASC")
        .all() as Record<string, unknown>[];
    } else if (state === "active" || state === "archived") {
      rows = this.db
        .prepare(
          "SELECT * FROM notes WHERE state = ? ORDER BY updated_at DESC, note_id ASC",
        )
        .all(state) as Record<string, unknown>[];
    } else {
      throw new TypeError("note state must be active, archived, or all");
    }
    return rows.map(rowToNote);
  }

  /** Fetch one note by its stable id. */
  get(noteId: string): NoteRow | null {
    this.assertOpen();
    assertSafeId(noteId);
    return this.getUnchecked(noteId);
  }

  /** Create an active note at revision 1. */
  create(body: string): NoteRow {
    this.assertOpen();
    assertBody(body);
    const noteId = this.idFactory();
    assertSafeId(noteId);
    const now = this.now();
    assertTimestamp(now);

    return this.withWriteTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO notes
             (note_id, body, state, revision, created_at, updated_at)
           VALUES (?, ?, 'active', 1, ?, ?)`,
        )
        .run(noteId, body, now, now);
      const note = this.getUnchecked(noteId);
      if (note === null) throw new Error("created note could not be read back");
      return note;
    });
  }

  /** Replace an active note body when its revision still matches. */
  update(
    noteId: string,
    expectedRevision: number,
    body: string,
  ): NoteMutationResult {
    this.assertOpen();
    assertSafeId(noteId);
    assertBody(body);
    const now = this.now();
    assertTimestamp(now);

    return this.withWriteTransaction(() => {
      const current = this.getUnchecked(noteId);
      const failure = mutationFailure(current, expectedRevision);
      if (failure !== null) return failure;

      this.db
        .prepare(
          `UPDATE notes
              SET body = ?, revision = revision + 1, updated_at = ?
            WHERE note_id = ? AND state = 'active' AND revision = ?`,
        )
        .run(body, now, noteId, expectedRevision);
      const note = this.getUnchecked(noteId);
      if (note === null) throw new Error("updated note could not be read back");
      return { ok: true, note };
    });
  }

  /** Archive an active note and record how the successful disposition occurred. */
  archive(
    noteId: string,
    expectedRevision: number,
    disposition: NoteDisposition,
    metadata: ArchiveMetadata = {},
  ): NoteMutationResult {
    this.assertOpen();
    assertSafeId(noteId);
    assertDisposition(disposition);
    const projectPath = nullableString(metadata.project_path);
    const launchTriple = nullableString(metadata.launch_triple);
    const launchHandle = nullableString(metadata.launch_handle);
    const now = this.now();
    assertTimestamp(now);

    return this.withWriteTransaction(() => {
      const current = this.getUnchecked(noteId);
      const failure = mutationFailure(current, expectedRevision);
      if (failure !== null) return failure;

      this.db
        .prepare(
          `UPDATE notes
              SET state = 'archived',
                  revision = revision + 1,
                  updated_at = ?,
                  archived_at = ?,
                  archived_via = ?,
                  project_path = ?,
                  launch_triple = ?,
                  launch_handle = ?
            WHERE note_id = ? AND state = 'active' AND revision = ?`,
        )
        .run(
          now,
          now,
          disposition,
          projectPath,
          launchTriple,
          launchHandle,
          noteId,
          expectedRevision,
        );
      const note = this.getUnchecked(noteId);
      if (note === null)
        throw new Error("archived note could not be read back");
      return { ok: true, note };
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("NoteStore is closed");
  }

  private getUnchecked(noteId: string): NoteRow | null {
    const row = this.db
      .prepare("SELECT * FROM notes WHERE note_id = ?")
      .get(noteId) as Record<string, unknown> | null;
    return row === null ? null : rowToNote(row);
  }

  private withWriteTransaction<T>(operation: () => T): T {
    this.assertOpen();
    const lock = FileLock.acquire(this.lockPath);
    try {
      return this.db.transaction(operation).immediate();
    } finally {
      lock.release();
    }
  }
}

function mutationFailure(
  current: NoteRow | null,
  expectedRevision: number,
): MutationFailure | null {
  if (current === null) return { ok: false, reason: "not_found" };
  if (current.state !== "active") return { ok: false, reason: "not_active" };
  if (current.revision !== expectedRevision) {
    return { ok: false, reason: "conflict" };
  }
  return null;
}

function draftPathFromId(id: string, dbPath: string): string {
  assertSafeId(id, "draft id");
  return join(resolveNoteDraftsDir(dbPath), `${id}${DRAFT_SUFFIX}`);
}

/** Create an editor draft with O_EXCL semantics; an existing draft is untouched. */
export function createNoteDraft(
  body = "",
  options: NoteDraftCreateOptions = {},
): NoteDraft {
  const dbPath = options.dbPath ?? resolveNotesDbPath();
  const dir = resolveNoteDraftsDir(dbPath);
  ensurePrivateDirectory(dir);

  const id = (options.idFactory ?? randomUUID)();
  const path = draftPathFromId(id, dbPath);
  let fd: number | null = null;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, body, { encoding: "utf8" });
  } catch (error) {
    if (fd !== null) {
      try {
        unlinkSync(path);
      } catch {
        // A failed create has no durable draft to preserve.
      }
    }
    throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  chmodSync(path, 0o600);
  return { id, path, mtime: statSync(path).mtimeMs };
}

/** List only recognized draft files, newest modification first. */
export function listNoteDrafts(
  dbPath: string = resolveNotesDbPath(),
): NoteDraft[] {
  const dir = resolveNoteDraftsDir(dbPath);
  ensurePrivateDirectory(dir);
  const drafts: NoteDraft[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(DRAFT_SUFFIX)) continue;
    const id = entry.name.slice(0, -DRAFT_SUFFIX.length);
    if (!NOTE_ID_RE.test(id)) continue;
    const path = join(dir, entry.name);
    try {
      drafts.push({ id, path, mtime: statSync(path).mtimeMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Another note command removed the draft after this directory snapshot.
    }
  }
  drafts.sort((a, b) => b.mtime - a.mtime || a.id.localeCompare(b.id));
  return drafts;
}

/** Read a draft exactly as stored. Reading never removes it. */
export function readNoteDraft(draft: NoteDraft | string): string {
  const path = typeof draft === "string" ? draft : draft.path;
  return readFileSync(path, "utf8");
}

/** Replace a private draft with the text returned by an interactive writer. */
export function writeNoteDraft(draft: NoteDraft | string, body: string): void {
  const path = typeof draft === "string" ? draft : draft.path;
  writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Explicitly remove a draft. Returns false when it is already absent. */
export function removeNoteDraft(draft: NoteDraft | string): boolean {
  const path = typeof draft === "string" ? draft : draft.path;
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

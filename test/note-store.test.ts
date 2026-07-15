import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createNoteDraft,
  listNoteDrafts,
  MAX_NOTE_BYTES,
  NOTES_SCHEMA_VERSION,
  NoteStore,
  readNoteDraft,
  removeNoteDraft,
  resolveNoteDraftsDir,
  resolveNotesDbPath,
  resolveNotesLockPath,
  writeNoteDraft,
} from "../src/note-store";
import { FileLock } from "../src/usage-flock";

let root: string;
let dbPath: string;
let stores: NoteStore[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "note-store-"));
  dbPath = join(root, "state", "notes.db");
  stores = [];
});

afterEach(() => {
  for (const store of stores) store.close();
  rmSync(root, { recursive: true, force: true });
});

function open(
  options: Omit<Parameters<typeof NoteStore.open>[0], "dbPath"> = {},
): NoteStore {
  const store = NoteStore.open({ dbPath, ...options });
  stores.push(store);
  return store;
}

function ids(...values: string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("test id sequence exhausted");
    index += 1;
    return value;
  };
}

describe("independent notes.db schema", () => {
  test("resolves an explicit non-empty override and otherwise uses keeper state", () => {
    expect(resolveNotesDbPath({ KEEPER_NOTES_DB: "/tmp/separate.db" })).toBe(
      "/tmp/separate.db",
    );

    const prior = process.env.KEEPER_STATE_DIR;
    process.env.KEEPER_STATE_DIR = root;
    try {
      expect(resolveNotesDbPath({ KEEPER_NOTES_DB: "" })).toBe(
        join(root, "notes.db"),
      );
    } finally {
      if (prior === undefined) delete process.env.KEEPER_STATE_DIR;
      else process.env.KEEPER_STATE_DIR = prior;
    }
  });

  test("creates schema v1, the consistency checks, and the requested index", () => {
    const store = open();
    store.close();

    const db = new Database(dbPath, { readonly: true });
    const version = (
      db.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    expect(version).toBe(NOTES_SCHEMA_VERSION);

    const table = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notes'",
      )
      .get() as { sql: string } | null;
    expect(table?.sql).toContain("revision >= 1");
    expect(table?.sql).toContain("state IN ('active', 'archived')");
    expect(table?.sql).toContain("archived_via IN ('clipboard', 'agent')");

    const index = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_notes_state_updated'",
      )
      .get() as { sql: string } | null;
    expect(index?.sql).toContain("(state, updated_at DESC, note_id)");
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
        )
        .get(),
    ).toBeNull();
    db.close();
  });

  test("migration is idempotent across close and reopen and data persists", () => {
    const first = open({ idFactory: () => "persisted", now: () => 1000 });
    expect(first.create("durable").revision).toBe(1);
    first.close();
    expect(() => first.close()).not.toThrow();

    const second = open();
    expect(second.get("persisted")?.body).toBe("durable");
    expect(second.list("all")).toHaveLength(1);
  });

  test("refuses a future schema and releases the migration flock", () => {
    mkdirSync(dirname(dbPath), { recursive: true });
    const future = new Database(dbPath, { create: true });
    future.run(`PRAGMA user_version = ${NOTES_SCHEMA_VERSION + 1}`);
    future.close();

    expect(() => NoteStore.open({ dbPath })).toThrow(/refusing to downgrade/);
    const lock = FileLock.tryAcquire(resolveNotesLockPath(dbPath));
    expect(lock).not.toBeNull();
    lock?.release();
  });

  test("creates private parents without chmodding an existing override directory", () => {
    if (process.platform === "win32") return;
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o777 });
    chmodSync(dirname(dbPath), 0o777);

    const store = open();
    store.close();
    expect(statSync(dirname(dbPath)).mode & 0o777).toBe(0o777);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    expect(statSync(resolveNotesLockPath(dbPath)).mode & 0o777).toBe(0o600);

    const nestedPath = join(root, "new-private-parent", "notes.db");
    const nested = NoteStore.open({ dbPath: nestedPath });
    nested.close();
    expect(statSync(dirname(nestedPath)).mode & 0o777).toBe(0o700);
  });
});

describe("note CRUD and optimistic mutations", () => {
  test("creates, gets, lists newest-updated first, and preserves exact body bytes", () => {
    let now = 1000;
    const store = open({
      now: () => now,
      idFactory: ids("note-a", "note-b"),
    });
    const exact = "  first line\nsecond line  \n";
    const first = store.create(exact);
    now = 2000;
    const second = store.create("second");

    expect(first.body).toBe(exact);
    expect(first).toEqual({
      note_id: "note-a",
      body: exact,
      state: "active",
      revision: 1,
      created_at: 1000,
      updated_at: 1000,
      archived_at: null,
      archived_via: null,
      project_path: null,
      launch_triple: null,
      launch_handle: null,
    });
    expect(store.get("note-a")).toEqual(first);
    expect(store.get("missing")).toBeNull();
    expect(store.list("active").map((note) => note.note_id)).toEqual([
      second.note_id,
      first.note_id,
    ]);

    now = 3000;
    const updated = store.update("note-a", 1, "\n  updated exactly  \n");
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error("unreachable");
    expect(updated.note.body).toBe("\n  updated exactly  \n");
    expect(updated.note.revision).toBe(2);
    expect(updated.note.created_at).toBe(1000);
    expect(updated.note.updated_at).toBe(3000);
    expect(store.list("all").map((note) => note.note_id)).toEqual([
      "note-a",
      "note-b",
    ]);
  });

  test("validates empty, whitespace-only, NUL, UTF-8 size, and generated ids", () => {
    const store = open();
    expect(() => store.create("")).toThrow(/non-whitespace/);
    expect(() => store.create(" \n\t ")).toThrow(/non-whitespace/);
    expect(() => store.create("before\0after")).toThrow(/NUL/);
    expect(() => store.create("é".repeat(MAX_NOTE_BYTES / 2 + 1))).toThrow(
      RangeError,
    );

    const exactCap = "é".repeat(MAX_NOTE_BYTES / 2);
    expect(store.create(exactCap).body).toBe(exactCap);

    const unsafe = NoteStore.open({
      dbPath: join(root, "unsafe", "notes.db"),
      idFactory: () => "../../escape",
    });
    stores.push(unsafe);
    expect(() => unsafe.create("body")).toThrow(/note id/);
  });

  test("reports not-found, conflict, and archived guards without changing rows", () => {
    let now = 1000;
    const store = open({ idFactory: () => "guarded", now: () => now });
    const created = store.create("v1");

    now = 2000;
    expect(store.update("missing", 1, "x")).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(store.update(created.note_id, 99, "lost update")).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(store.get(created.note_id)?.body).toBe("v1");
    expect(store.get(created.note_id)?.revision).toBe(1);

    now = 3000;
    const archived = store.archive(created.note_id, 1, "clipboard");
    expect(archived.ok).toBe(true);
    if (!archived.ok) throw new Error("unreachable");
    expect(store.update(created.note_id, 2, "cannot revive")).toEqual({
      ok: false,
      reason: "not_active",
    });
    expect(store.archive(created.note_id, 1, "agent")).toEqual({
      ok: false,
      reason: "not_active",
    });
    expect(store.list("active")).toEqual([]);
    expect(store.list("archived")).toHaveLength(1);
  });

  test("archive bumps revision and records disposition and launch metadata", () => {
    let now = 10;
    const store = open({ idFactory: () => "send-me", now: () => now });
    store.create("dispatch this");
    now = 25;

    const result = store.archive("send-me", 1, "agent", {
      project_path: "/code/keeper",
      launch_triple: "pi::model::high",
      launch_handle: "session-123",
    });
    expect(result).toEqual({
      ok: true,
      note: {
        note_id: "send-me",
        body: "dispatch this",
        state: "archived",
        revision: 2,
        created_at: 10,
        updated_at: 25,
        archived_at: 25,
        archived_via: "agent",
        project_path: "/code/keeper",
        launch_triple: "pi::model::high",
        launch_handle: "session-123",
      },
    });
  });

  test("a throwing transaction rolls back and always releases notes.lock", () => {
    const store = open({ idFactory: () => "duplicate", now: () => 1 });
    store.create("first");
    expect(() => store.create("second")).toThrow();
    expect(store.list("all").map((note) => note.body)).toEqual(["first"]);

    const lock = FileLock.tryAcquire(resolveNotesLockPath(dbPath));
    expect(lock).not.toBeNull();
    lock?.release();
  });
});

describe("private editor drafts", () => {
  test("two overridden databases in one parent keep separate sibling state", () => {
    const firstDb = join(root, "shared", "first.db");
    const secondDb = join(root, "shared", "second.db");
    const first = createNoteDraft("first body", {
      dbPath: firstDb,
      idFactory: () => "first-draft",
    });
    const second = createNoteDraft("second body", {
      dbPath: secondDb,
      idFactory: () => "second-draft",
    });

    expect(resolveNotesLockPath(firstDb)).not.toBe(
      resolveNotesLockPath(secondDb),
    );
    expect(resolveNoteDraftsDir(firstDb)).not.toBe(
      resolveNoteDraftsDir(secondDb),
    );
    expect(listNoteDrafts(firstDb).map((draft) => draft.id)).toEqual([
      first.id,
    ]);
    expect(listNoteDrafts(secondDb).map((draft) => draft.id)).toEqual([
      second.id,
    ]);
  });

  test("creates without overwrite, lists newest first, reads exactly, and removes explicitly", () => {
    const draftsDir = resolveNoteDraftsDir(dbPath);
    expect(draftsDir).toBe(join(dirname(dbPath), "notes-drafts"));
    mkdirSync(draftsDir, { recursive: true, mode: 0o777 });
    if (process.platform !== "win32") chmodSync(draftsDir, 0o777);

    const older = createNoteDraft("  old draft\n", {
      dbPath,
      idFactory: () => "draft-old",
    });
    const newer = createNoteDraft("new\nbody", {
      dbPath,
      idFactory: () => "draft-new",
    });
    utimesSync(older.path, new Date(1000), new Date(1000));
    utimesSync(newer.path, new Date(2000), new Date(2000));

    expect(listNoteDrafts(dbPath).map((draft) => draft.id)).toEqual([
      "draft-new",
      "draft-old",
    ]);
    expect(readNoteDraft(older)).toBe("  old draft\n");
    expect(existsSync(older.path)).toBe(true);
    expect(() =>
      createNoteDraft("replacement", {
        dbPath,
        idFactory: () => "draft-old",
      }),
    ).toThrow();
    expect(readNoteDraft(older.path)).toBe("  old draft\n");

    writeNoteDraft(newer, "updated by composer\n");
    expect(readNoteDraft(newer)).toBe("updated by composer\n");

    expect(removeNoteDraft(older)).toBe(true);
    expect(removeNoteDraft(older)).toBe(false);
    expect(listNoteDrafts(dbPath).map((draft) => draft.id)).toEqual([
      "draft-new",
    ]);

    if (process.platform !== "win32") {
      expect(statSync(draftsDir).mode & 0o777).toBe(0o700);
      expect(statSync(newer.path).mode & 0o777).toBe(0o600);
    }
  });
});

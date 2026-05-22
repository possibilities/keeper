/**
 * Collection-registry tests for the plans read surface (`epics`).
 *
 * These prove the `epics` `CollectionDescriptor` serves over the existing UDS
 * subscribe machinery with ZERO `server-worker.ts` edits: it's reachable via
 * `getCollection`, `runQuery` pages it, the pk filter narrows to one row, the
 * `status` filter narrows the set, and (schema v7) the embedded `tasks`
 * JSON-array column decodes to a real array at the read boundary. Rows are
 * hand-inserted (no reducer / watcher needed) — the descriptor + `runQuery`
 * path is the unit under test. The standalone `tasks` collection was dropped in
 * schema v7, so it no longer resolves.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EPICS_DESCRIPTOR, getCollection } from "../src/collections";
import { openDb } from "../src/db";
import type { ErrorFrame, ResultFrame } from "../src/protocol";
import { runQuery } from "../src/server-worker";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-collections-test-"));
  dbPath = join(tmpDir, "keeper.db");
  openDb(dbPath).db.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Narrow a runQuery return to a ResultFrame, failing the test if it's an error. */
function asResult(frame: ResultFrame | ErrorFrame): ResultFrame {
  if (frame.type !== "result") {
    throw new Error(`expected result, got ${frame.type} (${frame.code})`);
  }
  return frame;
}

function seedEpic(
  db: Database,
  epic_id: string,
  opts: Partial<{
    epic_number: number;
    title: string;
    project_dir: string;
    status: string;
    last_event_id: number;
    updated_at: number;
    tasks: string;
  }> = {},
): void {
  db.query(
    `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at, tasks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    epic_id,
    opts.epic_number ?? null,
    opts.title ?? null,
    opts.project_dir ?? null,
    opts.status ?? "active",
    opts.last_event_id ?? 0,
    opts.updated_at ?? 1,
    opts.tasks ?? "[]",
  );
}

// ---------------------------------------------------------------------------
// Registry resolution + descriptor shape
// ---------------------------------------------------------------------------

test("getCollection resolves epics; the dropped tasks collection is gone", () => {
  expect(getCollection("epics")).toBe(EPICS_DESCRIPTOR);
  expect(getCollection("tasks")).toBeUndefined();
});

test("epics descriptor: version is last_event_id; filters include pk + status; tasks is a jsonColumn out of sort/filter", () => {
  expect(EPICS_DESCRIPTOR.version).toBe("last_event_id");
  expect(EPICS_DESCRIPTOR.filters.epic_id).toBe("epic_id");
  expect(EPICS_DESCRIPTOR.filters.status).toBe("status");
  expect(EPICS_DESCRIPTOR.filters.project_dir).toBe("project_dir");

  // `tasks` is served + JSON-decoded, but never a sort/filter key.
  expect(EPICS_DESCRIPTOR.columns).toContain("tasks");
  expect(EPICS_DESCRIPTOR.jsonColumns.has("tasks")).toBe(true);
  expect(EPICS_DESCRIPTOR.sortable.has("tasks")).toBe(false);
  expect(EPICS_DESCRIPTOR.filters.tasks).toBeUndefined();
});

test("epics default sort is epic_number desc", () => {
  expect(EPICS_DESCRIPTOR.defaultSort).toEqual({
    column: "epic_number",
    dir: "desc",
  });
});

// ---------------------------------------------------------------------------
// epics: query → result + filters
// ---------------------------------------------------------------------------

test("runQuery pages the epics collection with the served columns + total", () => {
  const { db } = openDb(dbPath, { readonly: false });
  // Both open so the default `status: open` scope keeps them in the page.
  seedEpic(db, "fn-2-beta", { epic_number: 2, status: "open" });
  seedEpic(db, "fn-1-alpha", { epic_number: 1, status: "open" });
  const res = asResult(runQuery(db, 0, { type: "query", collection: "epics" }));
  expect(res.total).toBe(2);
  // Default sort epic_number desc (newest-created epic on top).
  expect(res.rows.map((r) => String(r.epic_id))).toEqual([
    "fn-2-beta",
    "fn-1-alpha",
  ]);
  // Served columns match the descriptor.
  expect(Object.keys(res.rows[0]!).sort()).toEqual(
    [...EPICS_DESCRIPTOR.columns].sort(),
  );
  db.close();
});

test("runQuery decodes the embedded tasks JSON-array column into a real array", () => {
  const { db } = openDb(dbPath, { readonly: false });
  const tasks = JSON.stringify([
    {
      task_id: "fn-1-alpha.1",
      epic_id: "fn-1-alpha",
      task_number: 1,
      title: "first",
      target_repo: "/repo",
      status: "open",
    },
    {
      task_id: "fn-1-alpha.2",
      epic_id: "fn-1-alpha",
      task_number: 2,
      title: "second",
      target_repo: "/repo",
      status: "done",
    },
  ]);
  seedEpic(db, "fn-1-alpha", { epic_number: 1, tasks });
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "epics",
      filter: { epic_id: "fn-1-alpha" },
    }),
  );
  const row = res.rows[0]!;
  expect(Array.isArray(row.tasks)).toBe(true);
  const arr = row.tasks as { task_id: string }[];
  expect(arr.map((t) => t.task_id)).toEqual(["fn-1-alpha.1", "fn-1-alpha.2"]);
  db.close();
});

test("runQuery decodes a NULL/malformed tasks column to []", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedEpic(db, "fn-1-alpha", { epic_number: 1, tasks: "{not json" });
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "epics",
      filter: { epic_id: "fn-1-alpha" },
    }),
  );
  expect(res.rows[0]!.tasks).toEqual([]);
  db.close();
});

test("runQuery resolves the epics pk filter to a single row", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedEpic(db, "fn-1-alpha", { epic_number: 1 });
  seedEpic(db, "fn-2-beta", { epic_number: 2 });
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "epics",
      filter: { epic_id: "fn-2-beta" },
    }),
  );
  expect(res.total).toBe(1);
  expect(String(res.rows[0]!.epic_id)).toBe("fn-2-beta");
  db.close();
});

test("runQuery narrows the epics set by status filter", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedEpic(db, "fn-1-alpha", { epic_number: 1, status: "active" });
  seedEpic(db, "fn-2-beta", { epic_number: 2, status: "done" });
  seedEpic(db, "fn-3-gamma", { epic_number: 3, status: "active" });
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "epics",
      filter: { status: "active" },
    }),
  );
  expect(res.total).toBe(2);
  expect(res.rows.every((r) => r.status === "active")).toBe(true);
  db.close();
});

test("epics descriptor defaults the view scope to status open", () => {
  expect(EPICS_DESCRIPTOR.defaultFilter).toEqual({ status: "open" });
});

test("runQuery applies the default open scope when no status filter is given", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedEpic(db, "fn-1-open", { epic_number: 1, status: "open" });
  seedEpic(db, "fn-2-done", { epic_number: 2, status: "done" });
  // No filter → the default `status: open` scope hides the done epic.
  const res = asResult(runQuery(db, 0, { type: "query", collection: "epics" }));
  expect(res.total).toBe(1);
  expect(res.rows.map((r) => String(r.epic_id))).toEqual(["fn-1-open"]);
  db.close();
});

test("an explicit status filter overrides the default open scope", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedEpic(db, "fn-1-open", { epic_number: 1, status: "open" });
  seedEpic(db, "fn-2-done", { epic_number: 2, status: "done" });
  // Asking for done overrides the default → only the done epic.
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "epics",
      filter: { status: "done" },
    }),
  );
  expect(res.total).toBe(1);
  expect(res.rows.map((r) => String(r.epic_id))).toEqual(["fn-2-done"]);
  db.close();
});

test("a pk lookup resolves a done epic despite the default open scope", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedEpic(db, "fn-2-done", { epic_number: 2, status: "done" });
  // A detail-page single-item subscribe targets one identity and must resolve
  // whatever its status — the default scope is exempt for a pk lookup.
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "epics",
      filter: { epic_id: "fn-2-done" },
    }),
  );
  expect(res.total).toBe(1);
  expect(String(res.rows[0]!.epic_id)).toBe("fn-2-done");
  db.close();
});

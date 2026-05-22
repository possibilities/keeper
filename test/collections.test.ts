/**
 * Collection-registry tests for the plans read surface (`epics` / `tasks`).
 *
 * These prove the two new `CollectionDescriptor`s serve over the existing
 * UDS subscribe machinery with ZERO `server-worker.ts` edits: each is reachable
 * via `getCollection`, `runQuery` pages it, the pk filter narrows to one row,
 * and the `status` filter narrows the set. Rows are hand-inserted (no reducer /
 * watcher needed) — the descriptor + `runQuery` path is the unit under test.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EPICS_DESCRIPTOR,
  getCollection,
  TASKS_DESCRIPTOR,
} from "../src/collections";
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
  }> = {},
): void {
  db.query(
    `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    epic_id,
    opts.epic_number ?? null,
    opts.title ?? null,
    opts.project_dir ?? null,
    opts.status ?? "active",
    opts.last_event_id ?? 0,
    opts.updated_at ?? 1,
  );
}

function seedTask(
  db: Database,
  task_id: string,
  opts: Partial<{
    epic_id: string;
    task_number: number;
    title: string;
    target_repo: string;
    status: string;
    last_event_id: number;
    updated_at: number;
  }> = {},
): void {
  db.query(
    `INSERT INTO tasks (task_id, epic_id, task_number, title, target_repo, status, last_event_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task_id,
    opts.epic_id ?? null,
    opts.task_number ?? null,
    opts.title ?? null,
    opts.target_repo ?? null,
    opts.status ?? "todo",
    opts.last_event_id ?? 0,
    opts.updated_at ?? 1,
  );
}

// ---------------------------------------------------------------------------
// Registry resolution + descriptor shape
// ---------------------------------------------------------------------------

test("getCollection resolves epics + tasks to their descriptors", () => {
  expect(getCollection("epics")).toBe(EPICS_DESCRIPTOR);
  expect(getCollection("tasks")).toBe(TASKS_DESCRIPTOR);
});

test("each descriptor's version is last_event_id; filters include pk + status", () => {
  expect(EPICS_DESCRIPTOR.version).toBe("last_event_id");
  expect(EPICS_DESCRIPTOR.filters.epic_id).toBe("epic_id");
  expect(EPICS_DESCRIPTOR.filters.status).toBe("status");
  expect(EPICS_DESCRIPTOR.filters.project_dir).toBe("project_dir");

  expect(TASKS_DESCRIPTOR.version).toBe("last_event_id");
  expect(TASKS_DESCRIPTOR.filters.task_id).toBe("task_id");
  expect(TASKS_DESCRIPTOR.filters.status).toBe("status");
  expect(TASKS_DESCRIPTOR.filters.epic_id).toBe("epic_id");
  expect(TASKS_DESCRIPTOR.filters.target_repo).toBe("target_repo");
});

// ---------------------------------------------------------------------------
// epics: query → result + filters
// ---------------------------------------------------------------------------

test("runQuery pages the epics collection with the served columns + total", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedEpic(db, "fn-1-alpha", { status: "active", updated_at: 2 });
  seedEpic(db, "fn-2-beta", { status: "done", updated_at: 3 });
  const res = asResult(runQuery(db, 0, { type: "query", collection: "epics" }));
  expect(res.total).toBe(2);
  // Default sort updated_at desc.
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

test("runQuery resolves the epics pk filter to a single row", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedEpic(db, "fn-1-alpha");
  seedEpic(db, "fn-2-beta");
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
  seedEpic(db, "fn-1-alpha", { status: "active" });
  seedEpic(db, "fn-2-beta", { status: "done" });
  seedEpic(db, "fn-3-gamma", { status: "active" });
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

// ---------------------------------------------------------------------------
// tasks: query → result + filters
// ---------------------------------------------------------------------------

test("runQuery pages the tasks collection with the served columns + total", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedTask(db, "fn-1-alpha.1", { epic_id: "fn-1-alpha", updated_at: 2 });
  seedTask(db, "fn-1-alpha.2", { epic_id: "fn-1-alpha", updated_at: 3 });
  const res = asResult(runQuery(db, 0, { type: "query", collection: "tasks" }));
  expect(res.total).toBe(2);
  expect(res.rows.map((r) => String(r.task_id))).toEqual([
    "fn-1-alpha.2",
    "fn-1-alpha.1",
  ]);
  expect(Object.keys(res.rows[0]!).sort()).toEqual(
    [...TASKS_DESCRIPTOR.columns].sort(),
  );
  db.close();
});

test("runQuery resolves the tasks pk filter to a single row", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedTask(db, "fn-1-alpha.1", { epic_id: "fn-1-alpha" });
  seedTask(db, "fn-1-alpha.2", { epic_id: "fn-1-alpha" });
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "tasks",
      filter: { task_id: "fn-1-alpha.2" },
    }),
  );
  expect(res.total).toBe(1);
  expect(String(res.rows[0]!.task_id)).toBe("fn-1-alpha.2");
  db.close();
});

test("runQuery narrows the tasks set by epic_id + status filters", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedTask(db, "fn-1-alpha.1", { epic_id: "fn-1-alpha", status: "done" });
  seedTask(db, "fn-1-alpha.2", { epic_id: "fn-1-alpha", status: "todo" });
  seedTask(db, "fn-2-beta.1", { epic_id: "fn-2-beta", status: "todo" });
  const byEpic = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "tasks",
      filter: { epic_id: "fn-1-alpha" },
    }),
  );
  expect(byEpic.total).toBe(2);
  const byStatus = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "tasks",
      filter: { epic_id: "fn-1-alpha", status: "todo" },
    }),
  );
  expect(byStatus.total).toBe(1);
  expect(String(byStatus.rows[0]!.task_id)).toBe("fn-1-alpha.2");
  db.close();
});

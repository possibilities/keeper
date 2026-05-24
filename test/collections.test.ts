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
import {
  APPROVALS_DESCRIPTOR,
  countAndToken,
  EPICS_DESCRIPTOR,
  getCollection,
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
    tasks: string;
    depends_on_epics: string;
    jobs: string;
  }> = {},
): void {
  db.query(
    `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at, tasks, depends_on_epics, jobs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    epic_id,
    opts.epic_number ?? null,
    opts.title ?? null,
    opts.project_dir ?? null,
    opts.status ?? "active",
    opts.last_event_id ?? 0,
    opts.updated_at ?? 1,
    opts.tasks ?? "[]",
    opts.depends_on_epics ?? "[]",
    opts.jobs ?? "[]",
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

test("runQuery decodes the depends_on_epics JSON-array column into a real array", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedEpic(db, "fn-4-alpha", {
    epic_number: 4,
    status: "open",
    depends_on_epics: JSON.stringify(["fn-3-base"]),
  });
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "epics",
      filter: { epic_id: "fn-4-alpha" },
    }),
  );
  expect(res.rows[0]!.depends_on_epics).toEqual(["fn-3-base"]);
  db.close();
});

test("runQuery decodes the embedded jobs JSON-array column into a real array", () => {
  const { db } = openDb(dbPath, { readonly: false });
  const epicJobs = JSON.stringify([
    {
      job_id: "sess-plan-1",
      plan_verb: "plan",
      state: "stopped",
      title: "plan a thing",
      created_at: 100,
      updated_at: 100,
      last_event_id: 1,
    },
  ]);
  seedEpic(db, "fn-9-jobs", {
    epic_number: 9,
    status: "open",
    jobs: epicJobs,
  });
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "epics",
      filter: { epic_id: "fn-9-jobs" },
    }),
  );
  const row = res.rows[0]!;
  expect(Array.isArray(row.jobs)).toBe(true);
  const arr = row.jobs as { job_id: string; plan_verb: string }[];
  expect(arr.map((j) => j.job_id)).toEqual(["sess-plan-1"]);
  expect(arr[0]?.plan_verb).toBe("plan");
  db.close();
});

test("runQuery nested-decodes task.jobs through the tasks JSON parse", () => {
  // The task element carries its own `jobs` sub-array (work-verb jobs). The
  // `tasks` column decode parses the outer array; the nested `task.jobs` rides
  // for free (decodeRow returns parsed arrays whose nested array fields are
  // already arrays). No separate jsonColumns entry is needed for task.jobs.
  const { db } = openDb(dbPath, { readonly: false });
  const tasks = JSON.stringify([
    {
      task_id: "fn-1-foo.1",
      epic_id: "fn-1-foo",
      task_number: 1,
      title: "T1",
      target_repo: "/repo",
      status: "open",
      depends_on: [],
      jobs: [
        {
          job_id: "sess-work-1",
          plan_verb: "work",
          state: "working",
          title: "doing T1",
          created_at: 200,
          updated_at: 200,
          last_event_id: 5,
        },
      ],
    },
  ]);
  seedEpic(db, "fn-1-foo", {
    epic_number: 1,
    status: "open",
    tasks,
  });
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "epics",
      filter: { epic_id: "fn-1-foo" },
    }),
  );
  const row = res.rows[0]!;
  expect(Array.isArray(row.tasks)).toBe(true);
  const taskArr = row.tasks as {
    task_id: string;
    jobs: { job_id: string; plan_verb: string }[];
  }[];
  expect(taskArr.length).toBe(1);
  expect(Array.isArray(taskArr[0]?.jobs)).toBe(true);
  expect(taskArr[0]?.jobs[0]?.job_id).toBe("sess-work-1");
  expect(taskArr[0]?.jobs[0]?.plan_verb).toBe("work");
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

test("epics descriptor defaults the view scope to status open AND approval ne approved", () => {
  // Composed two-key default (schema v13 — the
  // fn-592-approval-as-planctl-field epic). The descriptor's filter machinery
  // ANDs every key together; each key remains overridable independently.
  expect(EPICS_DESCRIPTOR.defaultFilter).toEqual({
    status: "open",
    approval: { ne: "approved" },
  });
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

// ---------------------------------------------------------------------------
// Approval filter (schema v13 — fn-592-approval-as-planctl-field)
// ---------------------------------------------------------------------------

test("epics descriptor exposes `approval` as a filter column", () => {
  expect(EPICS_DESCRIPTOR.filters.approval).toBe("approval");
  // Approval is a filter key but NOT a sort key (it's a tiny enum domain).
  expect(EPICS_DESCRIPTOR.sortable.has("approval")).toBe(false);
  // The column is served on the wire.
  expect(EPICS_DESCRIPTOR.columns).toContain("approval");
});

test("runQuery applies the composed default { status: open, approval: ne approved }", () => {
  const { db } = openDb(dbPath, { readonly: false });
  // Mix of (status, approval) combinations: only the open + non-approved rows
  // should remain after the composed default scope.
  seedEpic(db, "fn-1", { epic_number: 1, status: "open" });
  // Hand-set approval on this row to "approved" (overrides schema default).
  db.query("UPDATE epics SET approval = 'approved' WHERE epic_id = ?").run(
    "fn-1",
  );
  seedEpic(db, "fn-2", { epic_number: 2, status: "open" }); // approval 'pending'
  seedEpic(db, "fn-3", { epic_number: 3, status: "done" }); // approval 'pending'
  seedEpic(db, "fn-4", { epic_number: 4, status: "open" });
  db.query("UPDATE epics SET approval = 'rejected' WHERE epic_id = ?").run(
    "fn-4",
  );

  // Default scope: status=open AND approval != approved. Keeps fn-2 + fn-4.
  const res = asResult(runQuery(db, 0, { type: "query", collection: "epics" }));
  expect(res.total).toBe(2);
  // epic_number desc — fn-4 first, fn-2 second.
  expect(res.rows.map((r) => String(r.epic_id))).toEqual(["fn-4", "fn-2"]);
  db.close();
});

test("runQuery: explicit { approval: 'approved' } overrides the default ne", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedEpic(db, "fn-1", { epic_number: 1, status: "open" });
  db.query("UPDATE epics SET approval = 'approved' WHERE epic_id = ?").run(
    "fn-1",
  );
  seedEpic(db, "fn-2", { epic_number: 2, status: "open" }); // pending
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "epics",
      filter: { approval: "approved" },
    }),
  );
  expect(res.total).toBe(1);
  expect(String(res.rows[0]!.epic_id)).toBe("fn-1");
  db.close();
});

test("runQuery: { approval: { ne: 'rejected' } } excludes rejected rows", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedEpic(db, "fn-1", { epic_number: 1, status: "open" }); // pending
  seedEpic(db, "fn-2", { epic_number: 2, status: "open" });
  db.query("UPDATE epics SET approval = 'rejected' WHERE epic_id = ?").run(
    "fn-2",
  );
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "epics",
      filter: { approval: { ne: "rejected" } },
    }),
  );
  expect(res.total).toBe(1);
  expect(String(res.rows[0]!.epic_id)).toBe("fn-1");
  db.close();
});

test("runQuery: { approval: { in: [approved, rejected] } } narrows the set", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedEpic(db, "fn-1", { epic_number: 1, status: "open" }); // pending
  seedEpic(db, "fn-2", { epic_number: 2, status: "open" });
  db.query("UPDATE epics SET approval = 'approved' WHERE epic_id = ?").run(
    "fn-2",
  );
  seedEpic(db, "fn-3", { epic_number: 3, status: "open" });
  db.query("UPDATE epics SET approval = 'rejected' WHERE epic_id = ?").run(
    "fn-3",
  );
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "epics",
      filter: { approval: { in: ["approved", "rejected"] } },
    }),
  );
  expect(res.total).toBe(2);
  expect(new Set(res.rows.map((r) => String(r.epic_id)))).toEqual(
    new Set(["fn-2", "fn-3"]),
  );
  db.close();
});

test("epics result rows carry the `approval` column", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedEpic(db, "fn-1", { epic_number: 1, status: "open" });
  db.query("UPDATE epics SET approval = 'approved' WHERE epic_id = ?").run(
    "fn-1",
  );
  // Default scope hides approved; force-include via the explicit override.
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "epics",
      filter: { approval: "approved" },
    }),
  );
  expect(res.rows[0]!.approval).toBe("approved");
  db.close();
});

// ---------------------------------------------------------------------------
// Registry resolution + descriptor shape: approvals
// ---------------------------------------------------------------------------

function seedApproval(
  db: Database,
  approval_id: string,
  epic_id: string,
  task_key: string,
  status: "approved" | "rejected",
  updated_at: number,
): void {
  db.query(
    `INSERT INTO approvals (approval_id, epic_id, task_key, status, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(approval_id, epic_id, task_key, status, updated_at);
}

test("getCollection resolves approvals; descriptor shape matches the schema-v12 table", () => {
  expect(getCollection("approvals")).toBe(APPROVALS_DESCRIPTOR);
  expect(APPROVALS_DESCRIPTOR.pk).toBe("approval_id");
  // `version` fires the diff per row; approvals UPSERTs bump `updated_at`.
  expect(APPROVALS_DESCRIPTOR.version).toBe("updated_at");
  expect(APPROVALS_DESCRIPTOR.defaultSort).toEqual({
    column: "updated_at",
    dir: "desc",
  });
  // pk + the two natural filter keys are exposed; nothing else.
  expect(APPROVALS_DESCRIPTOR.filters.approval_id).toBe("approval_id");
  expect(APPROVALS_DESCRIPTOR.filters.epic_id).toBe("epic_id");
  expect(APPROVALS_DESCRIPTOR.filters.status).toBe("status");
  // No defaultFilter — the autopilot subscribes to all rows.
  expect(APPROVALS_DESCRIPTOR.defaultFilter).toBeUndefined();
  // No JSON columns — all five fields are scalars.
  expect(APPROVALS_DESCRIPTOR.jsonColumns.size).toBe(0);
});

test("runQuery pages the approvals collection sorted by updated_at desc; filters by epic_id and status narrow the set", () => {
  const { db } = openDb(dbPath, { readonly: false });
  // Two epics, three rows total: one approved + one rejected on epic-foo,
  // one approved on epic-bar. `updated_at` increases monotonically; the
  // default sort is `updated_at desc`, so the newest row tops the page.
  seedApproval(db, "fn-foo:.1", "fn-foo", ".1", "approved", 100);
  seedApproval(db, "fn-foo:.2", "fn-foo", ".2", "rejected", 200);
  seedApproval(db, "fn-bar:.1", "fn-bar", ".1", "approved", 300);

  // Unfiltered: all three rows, sorted by updated_at desc.
  const all = asResult(
    runQuery(db, 0, { type: "query", collection: "approvals" }),
  );
  expect(all.total).toBe(3);
  expect(all.rows.map((r) => String(r.approval_id))).toEqual([
    "fn-bar:.1",
    "fn-foo:.2",
    "fn-foo:.1",
  ]);
  // Served columns match the descriptor exactly.
  expect(Object.keys(all.rows[0]!).sort()).toEqual(
    [...APPROVALS_DESCRIPTOR.columns].sort(),
  );

  // epic_id filter narrows the set to the two epic-foo rows.
  const fooRows = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "approvals",
      filter: { epic_id: "fn-foo" },
    }),
  );
  expect(fooRows.total).toBe(2);
  expect(fooRows.rows.every((r) => r.epic_id === "fn-foo")).toBe(true);

  // status filter narrows the set to the two approved rows.
  const approvedRows = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "approvals",
      filter: { status: "approved" },
    }),
  );
  expect(approvedRows.total).toBe(2);
  expect(approvedRows.rows.every((r) => r.status === "approved")).toBe(true);

  db.close();
});

test("approvals countAndToken is stable across re-query when the membership is unchanged", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedApproval(db, "fn-foo:.1", "fn-foo", ".1", "approved", 100);
  seedApproval(db, "fn-foo:.2", "fn-foo", ".2", "rejected", 200);

  // Same (whereClause, params) pair both calls — token + total stay stable.
  const a = countAndToken(db, APPROVALS_DESCRIPTOR, "", []);
  const b = countAndToken(db, APPROVALS_DESCRIPTOR, "", []);
  expect(a.total).toBe(2);
  expect(b.total).toBe(2);
  expect(a.token).toBe(b.token);
  expect(a.token.length).toBeGreaterThan(0);
  db.close();
});

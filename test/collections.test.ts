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
  EPICS_DESCRIPTOR,
  GIT_DESCRIPTOR,
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
    job_links: string;
  }> = {},
): void {
  db.query(
    `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at, tasks, depends_on_epics, jobs, job_links)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    opts.job_links ?? "[]",
  );
}

/**
 * Minimal `jobs` row seeder for the descriptor's `epic_links` round-trip test.
 * Mirrors `seedEpic`'s shape: only the schema-required columns are populated
 * unconditionally; everything else rides defaults so the test stays narrow.
 */
function seedJob(
  db: Database,
  job_id: string,
  opts: Partial<{
    epic_links: string;
    plan_verb: string;
    plan_ref: string;
    state: string;
    last_event_id: number;
  }> = {},
): void {
  db.query(
    `INSERT INTO jobs (
       job_id, created_at, updated_at, state,
       last_event_id, plan_verb, plan_ref, epic_links
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    job_id,
    1,
    1,
    opts.state ?? "stopped",
    opts.last_event_id ?? 0,
    opts.plan_verb ?? null,
    opts.plan_ref ?? null,
    opts.epic_links ?? "[]",
  );
}

// ---------------------------------------------------------------------------
// Registry resolution + descriptor shape
// ---------------------------------------------------------------------------

test("getCollection resolves epics; the dropped tasks collection is gone", () => {
  expect(getCollection("epics")).toBe(EPICS_DESCRIPTOR);
  expect(getCollection("tasks")).toBeUndefined();
});

test("getCollection resolves the git status collection", () => {
  expect(getCollection("git")).toBe(GIT_DESCRIPTOR);
  expect(GIT_DESCRIPTOR.version).toBe("last_event_id");
  expect(GIT_DESCRIPTOR.filters.project_dir).toBe("project_dir");
  expect(GIT_DESCRIPTOR.jsonColumns.has("dirty_files")).toBe(true);
  expect(GIT_DESCRIPTOR.jsonColumns.has("orphaned_files")).toBe(true);
  expect(GIT_DESCRIPTOR.jsonColumns.has("jobs")).toBe(true);
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

test("epics default sort is epic_number asc", () => {
  expect(EPICS_DESCRIPTOR.defaultSort).toEqual({
    column: "epic_number",
    dir: "asc",
  });
});

test("runQuery decodes the git status JSON columns", () => {
  const { db } = openDb(dbPath, { readonly: false });
  db.query(
    `INSERT INTO git_status (
       project_dir, branch, dirty_count, orphaned_count,
       dirty_files, orphaned_files, jobs, last_event_id, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "/repo",
    "main",
    1,
    1,
    JSON.stringify([{ path: "src/a.ts", xy: " M" }]),
    JSON.stringify([{ path: "src/a.ts", xy: " M" }]),
    JSON.stringify([{ job_id: "sess-a", dirty: [] }]),
    12,
    34,
  );
  const res = asResult(runQuery(db, 12, { type: "query", collection: "git" }));
  expect(res.total).toBe(1);
  const row = res.rows[0];
  expect(row).toBeDefined();
  if (row == null) {
    throw new Error("expected one git row");
  }
  expect(Array.isArray(row.dirty_files)).toBe(true);
  expect(Array.isArray(row.orphaned_files)).toBe(true);
  expect(Array.isArray(row.jobs)).toBe(true);
  db.close();
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
  // Default sort epic_number asc (oldest-created epic on top).
  expect(res.rows.map((r) => String(r.epic_id))).toEqual([
    "fn-1-alpha",
    "fn-2-beta",
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

test("runQuery decodes the jobs.epic_links JSON-array column into a real array (creator/refiner cross-references stamped by syncPlanctlLinks)", () => {
  // Schema v14: each `jobs` row carries an `epic_links` JSON-TEXT array
  // (`JOBS_DESCRIPTOR.jsonColumns`) — the per-session view of the planctl
  // invocation classifier's output. The read boundary parses it to a real
  // array so `result`/`patch` frames serve the decoded shape (consumers
  // never see a JSON string).
  const { db } = openDb(dbPath, { readonly: false });
  const links = JSON.stringify([
    { kind: "creator", target: "fn-1-alpha" },
    { kind: "refiner", target: "fn-2-beta" },
  ]);
  seedJob(db, "sess-planner-1", { epic_links: links, plan_verb: "plan" });
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "jobs",
      filter: { job_id: "sess-planner-1" },
    }),
  );
  const row = res.rows[0]!;
  expect(Array.isArray(row.epic_links)).toBe(true);
  const arr = row.epic_links as { kind: string; target: string }[];
  expect(arr).toEqual([
    { kind: "creator", target: "fn-1-alpha" },
    { kind: "refiner", target: "fn-2-beta" },
  ]);
  db.close();
});

test("runQuery decodes the epics.job_links JSON-array column into a real array (symmetric per-epic view)", () => {
  // Schema v14: each `epics` row carries a `job_links` JSON-TEXT array
  // (`EPICS_DESCRIPTOR.jsonColumns`) — the per-epic view of the same
  // invocation classifier output (every session whose planctl-CLI footprint
  // created or refined this epic inside a `/plan:plan` window).
  const { db } = openDb(dbPath, { readonly: false });
  const links = JSON.stringify([
    { kind: "creator", job_id: "sess-planner-1" },
    { kind: "refiner", job_id: "sess-planner-2" },
  ]);
  seedEpic(db, "fn-9-links", {
    epic_number: 9,
    status: "open",
    job_links: links,
  });
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "epics",
      filter: { epic_id: "fn-9-links" },
    }),
  );
  const row = res.rows[0]!;
  expect(Array.isArray(row.job_links)).toBe(true);
  const arr = row.job_links as { kind: string; job_id: string }[];
  expect(arr).toEqual([
    { kind: "creator", job_id: "sess-planner-1" },
    { kind: "refiner", job_id: "sess-planner-2" },
  ]);
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

test("epics descriptor defaults the view scope to status open OR approval ne approved", () => {
  // Cross-column OR default — the predicate can't be expressed as per-key
  // ANDs, so it lives in `defaultClause` (raw SQL with bound params), not the
  // `defaultFilter` map. ANY wire filter drops it (the wire is the user's "I
  // know what I want" override); a pk subscribe is exempt.
  expect(EPICS_DESCRIPTOR.defaultClause).toEqual({
    sql: "(status = ? OR approval != ?)",
    params: ["open", "approved"],
  });
  // The per-key `defaultFilter` map is unused on epics — only the raw OR
  // clause applies.
  expect(EPICS_DESCRIPTOR.defaultFilter).toBeUndefined();
});

test("runQuery applies the default open-OR-not-approved scope when no filter is given", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedEpic(db, "fn-1-open", { epic_number: 1, status: "open" }); // pending
  seedEpic(db, "fn-2-done", { epic_number: 2, status: "done" }); // pending
  seedEpic(db, "fn-3-done-approved", { epic_number: 3, status: "done" });
  db.query("UPDATE epics SET approval = 'approved' WHERE epic_id = ?").run(
    "fn-3-done-approved",
  );
  // No filter → default `status=open OR approval!=approved` keeps fn-1
  // (open) and fn-2 (done but still pending review). Only fn-3
  // (done AND approved) falls off the page.
  const res = asResult(runQuery(db, 0, { type: "query", collection: "epics" }));
  expect(res.total).toBe(2);
  expect(res.rows.map((r) => String(r.epic_id))).toEqual([
    "fn-1-open",
    "fn-2-done",
  ]);
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

test("runQuery applies the composed default (open OR !approved) across all combos", () => {
  const { db } = openDb(dbPath, { readonly: false });
  // Cross-product of (status, approval) — only done-AND-approved should be
  // hidden by the default scope; every other combination matches at least one
  // branch of the OR and stays on the page.
  seedEpic(db, "fn-1", { epic_number: 1, status: "open" }); // open + pending → SHOWN
  seedEpic(db, "fn-2", { epic_number: 2, status: "open" });
  db.query("UPDATE epics SET approval = 'approved' WHERE epic_id = ?").run(
    "fn-2",
  ); // open + approved → SHOWN (open branch)
  seedEpic(db, "fn-3", { epic_number: 3, status: "done" }); // done + pending → SHOWN (!approved branch)
  seedEpic(db, "fn-4", { epic_number: 4, status: "done" });
  db.query("UPDATE epics SET approval = 'approved' WHERE epic_id = ?").run(
    "fn-4",
  ); // done + approved → HIDDEN (matches neither)
  seedEpic(db, "fn-5", { epic_number: 5, status: "open" });
  db.query("UPDATE epics SET approval = 'rejected' WHERE epic_id = ?").run(
    "fn-5",
  ); // open + rejected → SHOWN (both branches)

  // Default scope: status=open OR approval != approved. Only fn-4 falls off.
  const res = asResult(runQuery(db, 0, { type: "query", collection: "epics" }));
  expect(res.total).toBe(4);
  // epic_number asc — fn-1, fn-2, fn-3, fn-5.
  expect(res.rows.map((r) => String(r.epic_id))).toEqual([
    "fn-1",
    "fn-2",
    "fn-3",
    "fn-5",
  ]);
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
// Registry resolution: approvals collection retired in schema v13
// ---------------------------------------------------------------------------

test("getCollection returns undefined for `approvals` (retired in schema v13)", () => {
  expect(getCollection("approvals")).toBeUndefined();
});

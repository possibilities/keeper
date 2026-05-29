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
  DEAD_LETTERS_DESCRIPTOR,
  EPICS_DESCRIPTOR,
  GIT_DESCRIPTOR,
  getCollection,
  JOBS_DESCRIPTOR,
  PROFILES_DESCRIPTOR,
  selectVersionsByIds,
  USAGE_DESCRIPTOR,
} from "../src/collections";
import { MAX_IN_PARAMS, openDb } from "../src/db";
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
    sort_path: string;
    created_by_closer_of: string;
  }> = {},
): void {
  // Schema v29: default the sort_path to zero-padded-6 of epic_number when
  // a number is given so the default `sort_path ASC` order matches what the
  // reducer would derive; callers that need explicit control pass
  // `sort_path` directly. `created_by_closer_of` defaults to null.
  const computedSortPath =
    opts.sort_path != null
      ? opts.sort_path
      : opts.epic_number != null
        ? String(opts.epic_number).padStart(6, "0")
        : "";
  db.query(
    `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at, tasks, depends_on_epics, jobs, job_links, sort_path, created_by_closer_of)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    computedSortPath,
    opts.created_by_closer_of ?? null,
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

test("getCollection resolves the usage collection (fn-615)", () => {
  expect(getCollection("usage")).toBe(USAGE_DESCRIPTOR);
  expect(USAGE_DESCRIPTOR.table).toBe("usage");
  expect(USAGE_DESCRIPTOR.pk).toBe("id");
  expect(USAGE_DESCRIPTOR.version).toBe("last_event_id");
  // Filters: pk + the natural per-target filter.
  expect(USAGE_DESCRIPTOR.filters.id).toBe("id");
  expect(USAGE_DESCRIPTOR.filters.target).toBe("target");
  // Default sort is stable by pk.
  expect(USAGE_DESCRIPTOR.defaultSort).toEqual({ column: "id", dir: "asc" });
  // No JSON-decoded columns (all scalars).
  expect(USAGE_DESCRIPTOR.jsonColumns.size).toBe(0);
  // Columns include every persisted field.
  for (const col of [
    "id",
    "target",
    "multiplier",
    "session_percent",
    "session_resets_at",
    "week_percent",
    "week_resets_at",
    // Schema v35 (fn-642): colocated rate-limit columns.
    "last_rate_limit_at",
    "last_rate_limit_session_id",
    "last_event_id",
    "updated_at",
  ]) {
    expect(USAGE_DESCRIPTOR.columns).toContain(col);
  }
  // Sortable allowlist covers the human-relevant columns.
  expect(USAGE_DESCRIPTOR.sortable.has("id")).toBe(true);
  expect(USAGE_DESCRIPTOR.sortable.has("target")).toBe(true);
  expect(USAGE_DESCRIPTOR.sortable.has("last_event_id")).toBe(true);
  expect(USAGE_DESCRIPTOR.sortable.has("updated_at")).toBe(true);
  // No defaultFilter / defaultClause — every row is interesting by default.
  expect(USAGE_DESCRIPTOR.defaultFilter).toBeUndefined();
  expect(USAGE_DESCRIPTOR.defaultClause).toBeUndefined();
});

test("JOBS_DESCRIPTOR serves profile_name for the recent-sessions log (v36)", () => {
  // Schema v36: the derived `profile_name` rides the jobs row natively so the
  // usage surface's "recent sessions" log labels each job by profile without a
  // client-side join. Display-only — out of sortable / filters / jsonColumns.
  expect(JOBS_DESCRIPTOR.columns).toContain("profile_name");
  expect(JOBS_DESCRIPTOR.sortable.has("profile_name")).toBe(false);
  expect(JOBS_DESCRIPTOR.filters.profile_name).toBeUndefined();
  expect(JOBS_DESCRIPTOR.jsonColumns.has("profile_name")).toBe(false);
});

test("getCollection resolves the profiles collection (fn-639)", () => {
  expect(getCollection("profiles")).toBe(PROFILES_DESCRIPTOR);
  expect(PROFILES_DESCRIPTOR.table).toBe("profiles");
  expect(PROFILES_DESCRIPTOR.pk).toBe("config_dir");
  expect(PROFILES_DESCRIPTOR.version).toBe("last_event_id");
  // Filter: pk only — the per-profile read narrows on the profile dir.
  expect(PROFILES_DESCRIPTOR.filters.config_dir).toBe("config_dir");
  // Default sort is stable by pk.
  expect(PROFILES_DESCRIPTOR.defaultSort).toEqual({
    column: "config_dir",
    dir: "asc",
  });
  // No JSON-decoded columns — every persisted field is a scalar.
  expect(PROFILES_DESCRIPTOR.jsonColumns.size).toBe(0);
  // Columns include every persisted field.
  for (const col of [
    "config_dir",
    // Schema v35 (fn-642): derived basename, the join key against usage.id.
    "profile_name",
    "last_rate_limit_at",
    "last_rate_limit_session_id",
    "last_event_id",
    "updated_at",
  ]) {
    expect(PROFILES_DESCRIPTOR.columns).toContain(col);
  }
  // Sortable allowlist covers config_dir, last_rate_limit_at (time-ordered
  // browse for "most-recently-rate-limited first"), last_event_id, updated_at.
  expect(PROFILES_DESCRIPTOR.sortable.has("config_dir")).toBe(true);
  expect(PROFILES_DESCRIPTOR.sortable.has("last_rate_limit_at")).toBe(true);
  expect(PROFILES_DESCRIPTOR.sortable.has("last_event_id")).toBe(true);
  expect(PROFILES_DESCRIPTOR.sortable.has("updated_at")).toBe(true);
  // No defaultFilter / defaultClause — every row is interesting by default
  // (a quiet seed-only profile is still surface-worthy).
  expect(PROFILES_DESCRIPTOR.defaultFilter).toBeUndefined();
  expect(PROFILES_DESCRIPTOR.defaultClause).toBeUndefined();
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

test("epics default sort is sort_path asc (schema v29)", () => {
  // Schema v29: flipped from `epic_number asc` to `sort_path asc` — the
  // materialized-path key the reducer's `syncPlanctlLinks` derives. Slots
  // closer-created children directly below their parent in the default
  // page; the prefix-sort invariant `"000003" < "000003.000007" < "000004"`
  // holds under SQLite BINARY collation.
  expect(EPICS_DESCRIPTOR.defaultSort).toEqual({
    column: "sort_path",
    dir: "asc",
  });
});

test("epics descriptor: sort_path is in sortable (schema v29 trust boundary)", () => {
  // The generic ORDER BY interpolation in `src/server-worker.ts` reads from
  // the descriptor's `sortable` allowlist. Without `sort_path` here the
  // flipped `defaultSort` would be rejected at the trust boundary.
  expect(EPICS_DESCRIPTOR.sortable.has("sort_path")).toBe(true);
});

test("epics descriptor: created_by_closer_of + sort_path columns are served (schema v29)", () => {
  // Both new schema-v29 columns ride on every `result` / `patch` frame —
  // the board reads `created_by_closer_of` for its `[slotted-after-closer]`
  // pill, and a future client could expose `sort_path` directly.
  expect(EPICS_DESCRIPTOR.columns).toContain("created_by_closer_of");
  expect(EPICS_DESCRIPTOR.columns).toContain("sort_path");
  // `created_by_closer_of` is out of `sortable` / `filters` —
  // downstream branches on its null-ness, not its value.
  expect(EPICS_DESCRIPTOR.sortable.has("created_by_closer_of")).toBe(false);
  expect(EPICS_DESCRIPTOR.filters.created_by_closer_of).toBeUndefined();
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
  expect(Object.keys(res.rows[0] ?? {}).sort()).toEqual(
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
  const row = res.rows[0];
  if (row == null) throw new Error("expected row");
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
  expect(res.rows[0]?.depends_on_epics).toEqual(["fn-3-base"]);
  db.close();
});

test("epics descriptor: resolved_epic_deps is served + a jsonColumn (schema v34, fn-637)", () => {
  // Schema-v34 column carrying the resolved + enriched state of
  // `depends_on_epics`. Served on every `result` / `patch` frame and
  // decoded as JSON at the read boundary (`decodeRow`); NULL is preserved
  // (the "not-yet-computed" sentinel) — DISTINCT from `'[]'` (the
  // "computed, no deps" stored value). Out of `sortable` / `filters`
  // (clients branch on element shape, not column value).
  expect(EPICS_DESCRIPTOR.columns).toContain("resolved_epic_deps");
  expect(EPICS_DESCRIPTOR.jsonColumns.has("resolved_epic_deps")).toBe(true);
  expect(EPICS_DESCRIPTOR.sortable.has("resolved_epic_deps")).toBe(false);
  expect(EPICS_DESCRIPTOR.filters.resolved_epic_deps).toBeUndefined();
});

test("runQuery decodes resolved_epic_deps JSON into a real array (schema v34, fn-637)", () => {
  // Stored as JSON-TEXT — `decodeRow` parses to a real array on the wire.
  // Mirror of the `depends_on_epics` decode test above; the per-entry
  // shape is the task-.3 `ResolvedEpicDep` type but the decode pass is
  // value-agnostic — we round-trip whatever JSON the column carries.
  const { db } = openDb(dbPath, { readonly: false });
  const resolved = JSON.stringify([
    {
      dep_token: "fn-3",
      resolved_epic_id: "fn-3-base",
      epic_number: 3,
      project_basename: "keeper",
      cross_project: false,
      state: "satisfied",
    },
    {
      dep_token: "missing",
      resolved_epic_id: null,
      epic_number: null,
      project_basename: null,
      cross_project: false,
      state: "dangling",
    },
  ]);
  // seedEpic doesn't carry resolved_epic_deps in its options, so we stamp
  // it directly via UPDATE — the row's other defaults stay intact.
  seedEpic(db, "fn-9-resolved", { epic_number: 9, status: "open" });
  db.prepare(
    "UPDATE epics SET resolved_epic_deps = ? WHERE epic_id = 'fn-9-resolved'",
  ).run(resolved);
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "epics",
      filter: { epic_id: "fn-9-resolved" },
    }),
  );
  const row = res.rows[0];
  expect(row).toBeDefined();
  expect(Array.isArray(row?.resolved_epic_deps)).toBe(true);
  const arr = row?.resolved_epic_deps as {
    dep_token: string;
    state: string;
  }[];
  expect(arr).toHaveLength(2);
  expect(arr[0]?.dep_token).toBe("fn-3");
  expect(arr[0]?.state).toBe("satisfied");
  expect(arr[1]?.state).toBe("dangling");
  db.close();
});

test("runQuery preserves NULL on resolved_epic_deps (NOT collapsed to []) — the 'not-yet-computed' sentinel is load-bearing (schema v34, fn-637)", () => {
  // The zero-event projection for `resolved_epic_deps` is NULL, which
  // means "the reducer hasn't computed this yet". That state is DISTINCT
  // from `[]` ("computed, no deps") at the readiness layer — without
  // preserving NULL, downstream consumers couldn't tell convergence apart
  // from a structurally empty dep list. seedEpic stamps the row but never
  // touches `resolved_epic_deps`, so the column reads NULL from the DB;
  // `decodeRow` must preserve that NULL on the wire.
  const { db } = openDb(dbPath, { readonly: false });
  seedEpic(db, "fn-7-pending", { epic_number: 7, status: "open" });
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "epics",
      filter: { epic_id: "fn-7-pending" },
    }),
  );
  const row = res.rows[0];
  expect(row).toBeDefined();
  expect(row?.resolved_epic_deps).toBeNull();
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
  const row = res.rows[0];
  if (row == null) throw new Error("expected row");
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
  const row = res.rows[0];
  if (row == null) throw new Error("expected row");
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
  const row = res.rows[0];
  if (row == null) throw new Error("expected row");
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
  const row = res.rows[0];
  if (row == null) throw new Error("expected row");
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
  expect(res.rows[0]?.tasks).toEqual([]);
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
  expect(String(res.rows[0]?.epic_id)).toBe("fn-2-beta");
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
  // Schema v32 (fn-634): the predicate "open OR not-yet-approved" is
  // materialized via the VIRTUAL generated column `default_visible` and
  // queried as a literal single-column equality `default_visible = 1` —
  // literal-1 (not `params: [1]`) so the partial-index matcher lands
  // `idx_epics_default_visible WHERE default_visible = 1` reliably across
  // SQLite versions. ANY wire filter drops the clause (the wire is the
  // user's "I know what I want" override); a pk subscribe is exempt.
  expect(EPICS_DESCRIPTOR.defaultClause).toEqual({
    sql: "default_visible = 1",
    params: [],
  });
  // The per-key `defaultFilter` map is unused on epics — only the
  // generated-column clause applies.
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
  expect(String(res.rows[0]?.epic_id)).toBe("fn-2-done");
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
  expect(String(res.rows[0]?.epic_id)).toBe("fn-1");
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
  expect(String(res.rows[0]?.epic_id)).toBe("fn-1");
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
  expect(res.rows[0]?.approval).toBe("approved");
  db.close();
});

// ---------------------------------------------------------------------------
// Registry resolution: approvals collection retired in schema v13
// ---------------------------------------------------------------------------

test("getCollection returns undefined for `approvals` (retired in schema v13)", () => {
  expect(getCollection("approvals")).toBeUndefined();
});

// ---------------------------------------------------------------------------
// selectVersionsByIds — the version-probe-first helper that drives diffTick's
// two-pass shape. The helper projects only `(pk, version)` (no JSON columns,
// no decodeRow) so the cheap probe pass per tick scales to N watched rows
// without paying the per-row JSON.parse cost the old shape paid.
// ---------------------------------------------------------------------------

test("selectVersionsByIds: empty ids → empty Map (no SQL run)", () => {
  const { db } = openDb(dbPath, { readonly: false });
  // Seed a row so an erroneous "fetch all" implementation would return non-empty.
  seedEpic(db, "fn-1", { epic_number: 1, last_event_id: 7 });
  const map = selectVersionsByIds(db, EPICS_DESCRIPTOR, []);
  expect(map.size).toBe(0);
  db.close();
});

test("selectVersionsByIds: known seed → Map carries (pk, version) pairs, only requested ids", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedEpic(db, "fn-1", { epic_number: 1, last_event_id: 11 });
  seedEpic(db, "fn-2", { epic_number: 2, last_event_id: 22 });
  seedEpic(db, "fn-3", { epic_number: 3, last_event_id: 33 });
  // Request a strict subset; verify the other row is absent from the result.
  const map = selectVersionsByIds(db, EPICS_DESCRIPTOR, ["fn-1", "fn-3"]);
  expect(map.size).toBe(2);
  expect(map.get("fn-1")).toBe(11);
  expect(map.get("fn-3")).toBe(33);
  expect(map.has("fn-2")).toBe(false);
  db.close();
});

test("selectVersionsByIds: works for the jobs descriptor too (descriptor-agnostic)", () => {
  // The helper is generic over CollectionDescriptor — verify it routes the
  // table/pk/version identifiers correctly for a non-epics descriptor.
  const { db } = openDb(dbPath, { readonly: false });
  seedJob(db, "a", { last_event_id: 5 });
  seedJob(db, "b", { last_event_id: 9 });
  const map = selectVersionsByIds(db, JOBS_DESCRIPTOR, ["a", "b"]);
  expect(map.size).toBe(2);
  expect(map.get("a")).toBe(5);
  expect(map.get("b")).toBe(9);
  db.close();
});

test("selectVersionsByIds: typeof is number for known-non-null versions", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedEpic(db, "fn-1", { epic_number: 1, last_event_id: 42 });
  const map = selectVersionsByIds(db, EPICS_DESCRIPTOR, ["fn-1"]);
  const v = map.get("fn-1");
  expect(typeof v).toBe("number");
  expect(v).toBe(42);
  db.close();
});

test("selectVersionsByIds: id absent from the table is not in the result Map", () => {
  // The schema-never-deletes assumption matches today's `!row` guard in
  // diffTick: a missing id surfaces as `Map.get(id) === undefined`, which the
  // caller treats as "skip silently".
  const { db } = openDb(dbPath, { readonly: false });
  seedEpic(db, "fn-1", { epic_number: 1, last_event_id: 7 });
  const map = selectVersionsByIds(db, EPICS_DESCRIPTOR, ["fn-1", "ghost"]);
  expect(map.size).toBe(1);
  expect(map.get("fn-1")).toBe(7);
  expect(map.get("ghost")).toBeUndefined();
  db.close();
});

test("selectVersionsByIds: ids.length > MAX_IN_PARAMS throws (mirrors selectByIds)", () => {
  const { db } = openDb(dbPath, { readonly: false });
  const ids: string[] = [];
  for (let i = 0; i < MAX_IN_PARAMS + 1; i++) ids.push(`fn-${i}`);
  expect(() => selectVersionsByIds(db, EPICS_DESCRIPTOR, ids)).toThrow(
    /exceeds SQLITE_MAX_VARIABLE_NUMBER/,
  );
  db.close();
});

test("selectVersionsByIds: never selects JSON columns (no decodeRow path; cheap projection)", () => {
  // The whole point of the probe is to skip JSON-column reads. Even though
  // `tasks` is a populated JSON-TEXT column on epics, the returned Map
  // shape (`pk` + `version` only) has no key for it — and since the helper
  // never invokes `decodeRow`, populated JSON data can't sneak into the
  // value. This test catches a regression where someone widens the SELECT
  // projection to include arbitrary columns.
  const { db } = openDb(dbPath, { readonly: false });
  seedEpic(db, "fn-1", {
    epic_number: 1,
    last_event_id: 99,
    tasks: JSON.stringify([{ id: "fn-1.1", title: "stub" }]),
  });
  const map = selectVersionsByIds(db, EPICS_DESCRIPTOR, ["fn-1"]);
  // Value is the bare version number; no row-shape with `tasks` field.
  expect(map.get("fn-1")).toBe(99);
  // typeof guard — the Map<string, number | null> shape is preserved even
  // when adjacent columns carry JSON-TEXT content.
  expect(typeof map.get("fn-1")).toBe("number");
  db.close();
});

test("DEAD_LETTERS_DESCRIPTOR: descriptor shape and registry registration (fn-643)", () => {
  expect(getCollection("dead_letters")).toBe(DEAD_LETTERS_DESCRIPTOR);
  expect(DEAD_LETTERS_DESCRIPTOR.table).toBe("dead_letters");
  expect(DEAD_LETTERS_DESCRIPTOR.pk).toBe("dl_id");
  expect(DEAD_LETTERS_DESCRIPTOR.version).toBe("dl_written_at");
  expect(DEAD_LETTERS_DESCRIPTOR.defaultSort).toEqual({
    column: "dl_written_at",
    dir: "asc",
  });
  // defaultFilter scopes to `waiting` so the board warn-count tracks backlog.
  expect(DEAD_LETTERS_DESCRIPTOR.defaultFilter).toEqual({ status: "waiting" });
  // bindings is the only JSON column.
  expect(DEAD_LETTERS_DESCRIPTOR.jsonColumns.has("bindings")).toBe(true);
  expect(DEAD_LETTERS_DESCRIPTOR.jsonColumns.size).toBe(1);
  // All table columns are enumerated in the descriptor.
  for (const col of [
    "dl_id",
    "session_id",
    "hook_event",
    "ts",
    "dl_written_at",
    "pid",
    "bindings",
    "status",
    "recovered_at",
    "replayed_event_id",
    "source_file",
  ]) {
    expect(DEAD_LETTERS_DESCRIPTOR.columns).toContain(col);
  }
  // Filters include the key access paths.
  expect(DEAD_LETTERS_DESCRIPTOR.filters.dl_id).toBe("dl_id");
  expect(DEAD_LETTERS_DESCRIPTOR.filters.status).toBe("status");
  expect(DEAD_LETTERS_DESCRIPTOR.filters.session_id).toBe("session_id");
});

test("dead_letters defaultFilter: recovered rows excluded from default runQuery page (fn-643)", () => {
  const { db } = openDb(dbPath, { readonly: false });
  // Insert one waiting and one recovered row directly — no reducer path.
  db.query(
    `INSERT INTO dead_letters (dl_id, session_id, hook_event, ts, dl_written_at, bindings, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "dl-wait-1",
    "sess-aaa",
    "SessionStart",
    1000.0,
    1001.0,
    "{}",
    "waiting",
  );
  db.query(
    `INSERT INTO dead_letters (dl_id, session_id, hook_event, ts, dl_written_at, bindings, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "dl-recv-1",
    "sess-bbb",
    "SessionStart",
    1002.0,
    1003.0,
    "{}",
    "recovered",
  );
  // Default query — no explicit filter — should see only the waiting row.
  const res = asResult(
    runQuery(db, 0, { type: "query", collection: "dead_letters" }),
  );
  expect(res.total).toBe(1);
  expect(String(res.rows[0]?.dl_id)).toBe("dl-wait-1");
  // An explicit status=recovered override surfaces the recovered row.
  const res2 = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "dead_letters",
      filter: { status: "recovered" },
    }),
  );
  expect(res2.total).toBe(1);
  expect(String(res2.rows[0]?.dl_id)).toBe("dl-recv-1");
  db.close();
});

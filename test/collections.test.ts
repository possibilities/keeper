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
  AUTOPILOT_STATE_DESCRIPTOR,
  BUILDS_DESCRIPTOR,
  countAndToken,
  DEAD_LETTERS_DESCRIPTOR,
  DISPATCH_FAILURES_DESCRIPTOR,
  DONE_EPICS_REAP_WINDOW_SEC,
  EPICS_DESCRIPTOR,
  EPICS_PINNED_DESCRIPTOR,
  EPICS_RECENT_DONE_DESCRIPTOR,
  GIT_DESCRIPTOR,
  getCollection,
  JOBS_DESCRIPTOR,
  liveKeyExpr,
  liveKeyOf,
  PENDING_DISPATCHES_DESCRIPTOR,
  PROFILES_DESCRIPTOR,
  SCHEDULED_TASKS_DESCRIPTOR,
  selectByIdsChunked,
  selectVersionsByIds,
  selectVersionsByIdsChunked,
  USAGE_DESCRIPTOR,
} from "../src/collections";
import { MAX_IN_PARAMS, openDb } from "../src/db";
import {
  WORKTREE_FINALIZE_ID_PREFIX,
  WORKTREE_RECOVER_KEY_PREFIX,
} from "../src/dispatch-failure-key";
import type { ErrorFrame, ResultFrame } from "../src/protocol";
import { runQuery } from "../src/server-worker";
import { freshDbFile } from "./helpers/template-db";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-collections-test-"));
  dbPath = join(tmpDir, "keeper.db");
  // fn-769 file variant: each test body re-opens this path with a SECOND
  // `openDb(dbPath)` connection, so the migrated schema must live on DISK (a
  // `:memory:` clone is connection-private). `freshDbFile` writes the
  // pre-migrated template image to the path (skipping the 63-version ladder),
  // then we close — the bodies re-open it migration-free since it's already
  // at the current schema_version.
  freshDbFile(dbPath).db.close();
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
  // The default board order is `epic_number ASC` (tie-break `epic_id`); the
  // seeded `epic_number` is what makes that order deterministic.
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

test("getCollection resolves the epics_recent_done collection (fn-950)", () => {
  expect(getCollection("epics_recent_done")).toBe(EPICS_RECENT_DONE_DESCRIPTOR);
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
    "sonnet_week_percent",
    "sonnet_week_resets_at",
    "codex_spark_session_percent",
    "codex_spark_session_resets_at",
    "codex_spark_week_percent",
    "codex_spark_week_resets_at",
    // Schema v35 (fn-642): colocated rate-limit columns.
    "last_rate_limit_at",
    "last_rate_limit_session_id",
    "account_state",
    // Schema v41 (fn-651): rate-limit lift instant + last-successful-fold
    // freshness stamp on the usage wire.
    "rate_limit_lifts_at",
    "last_usage_fold_at",
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

test("JOBS_DESCRIPTOR serves monitors for the expanded-row Monitors section (v51)", () => {
  // Schema v51 / fn-682 / fn-685: `monitors` is a JSON-TEXT array projected
  // by the reducer and rendered by `cli/jobs.ts`'s expanded block via
  // `monitorLinesFor` (which parses the raw JSON string itself). Display-only
  // — out of sortable / filters / jsonColumns, same as `profile_name` and the
  // `backend_exec_*` cluster. Without this entry the wire SELECT strands the
  // field and the Monitors section never renders.
  expect(JOBS_DESCRIPTOR.columns).toContain("monitors");
  expect(JOBS_DESCRIPTOR.sortable.has("monitors")).toBe(false);
  expect(JOBS_DESCRIPTOR.filters.monitors).toBeUndefined();
  expect(JOBS_DESCRIPTOR.jsonColumns.has("monitors")).toBe(false);
});

test("JOBS_DESCRIPTOR serves window_index for the dash intra-band sort", () => {
  // `window_index` (DB v71) is the live tmux `#{window_index}` folded onto the
  // row from `WindowIndexSnapshot`; the dash sorts cards within a session band
  // on it CLIENT-side. A plain INTEGER scalar — display/sort-only, so it is out
  // of sortable / filters / jsonColumns, same as the `backend_exec_*` cluster.
  expect(JOBS_DESCRIPTOR.columns).toContain("window_index");
  expect(JOBS_DESCRIPTOR.sortable.has("window_index")).toBe(false);
  expect(JOBS_DESCRIPTOR.filters.window_index).toBeUndefined();
  expect(JOBS_DESCRIPTOR.jsonColumns.has("window_index")).toBe(false);
});

test("JOBS_DESCRIPTOR serves kill_reason for reap attribution (v103)", () => {
  // `kill_reason` (DB v103 / fn-1075) is WHY keeper reaped the job — the Killed
  // producer arm that minted the reap — folded from the payload as an opaque
  // string copy. Surfaced so `keeper query jobs` exposes reap attribution;
  // display-only, so it is out of sortable / filters / jsonColumns, same as the
  // `close_kind` sibling.
  expect(JOBS_DESCRIPTOR.columns).toContain("kill_reason");
  expect(JOBS_DESCRIPTOR.sortable.has("kill_reason")).toBe(false);
  expect(JOBS_DESCRIPTOR.filters.kill_reason).toBeUndefined();
  expect(JOBS_DESCRIPTOR.jsonColumns.has("kill_reason")).toBe(false);
});

test("JOBS_DESCRIPTOR serves harness + resume_target for the harness-aware revive script (v107/v108)", () => {
  // `harness` / `resume_target` (DB v107/v108 / fn-1103) are the launching harness
  // and its native resume token; served so the restore-worker's revive.sh + JSON
  // mirror tag each agent's harness and emit its own resume argv. Plain TEXT
  // scalars — display-only, so out of sortable / filters / jsonColumns.
  for (const col of ["harness", "resume_target"]) {
    expect(JOBS_DESCRIPTOR.columns).toContain(col);
    expect(JOBS_DESCRIPTOR.sortable.has(col)).toBe(false);
    expect(JOBS_DESCRIPTOR.filters[col]).toBeUndefined();
    expect(JOBS_DESCRIPTOR.jsonColumns.has(col)).toBe(false);
  }
});

test("JOBS_DESCRIPTOR serves worktree for the durable lane pill (v94)", () => {
  // `worktree` (DB v94 / fn-997) is the durable git lane BRANCH the job ran in,
  // folded set-once from `events.worktree`. Display-only — the renderer's
  // `worktreeLaneSeg` lifts it into a `[⑂ …]` pill; out of sortable / filters /
  // jsonColumns, same as the `backend_exec_*` cluster.
  expect(JOBS_DESCRIPTOR.columns).toContain("worktree");
  expect(JOBS_DESCRIPTOR.sortable.has("worktree")).toBe(false);
  expect(JOBS_DESCRIPTOR.filters.worktree).toBeUndefined();
  expect(JOBS_DESCRIPTOR.jsonColumns.has("worktree")).toBe(false);
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

test("getCollection resolves the pending_dispatches collection (schema v50, fn-678)", () => {
  // Schema v50 (epic fn-678): the durable substrate that replaces fn-674's
  // live zellij tab-name probe for launch-window double-dispatch
  // suppression. Mirrors `dispatch_failures` shape (composite-pk workaround:
  // `verb` is the descriptor pk, `id` rides in columns + filters).
  expect(getCollection("pending_dispatches")).toBe(
    PENDING_DISPATCHES_DESCRIPTOR,
  );
  expect(PENDING_DISPATCHES_DESCRIPTOR.table).toBe("pending_dispatches");
  expect(PENDING_DISPATCHES_DESCRIPTOR.pk).toBe("verb");
  expect(PENDING_DISPATCHES_DESCRIPTOR.version).toBe("last_event_id");
  // Composite PK workaround: descriptor pk is `verb`; `id` lives in
  // columns + filters for narrowing.
  expect(PENDING_DISPATCHES_DESCRIPTOR.filters.verb).toBe("verb");
  expect(PENDING_DISPATCHES_DESCRIPTOR.filters.id).toBe("id");
  // Default sort: most-recent dispatch on top (reverse-chronological "what
  // just launched" feed for the autopilot viewer).
  expect(PENDING_DISPATCHES_DESCRIPTOR.defaultSort).toEqual({
    column: "dispatched_at",
    dir: "desc",
  });
  // No JSON-decoded columns — every persisted field is a scalar.
  expect(PENDING_DISPATCHES_DESCRIPTOR.jsonColumns.size).toBe(0);
  // Columns include every persisted field byte-for-byte against
  // CREATE_PENDING_DISPATCHES.
  for (const col of ["verb", "id", "dir", "dispatched_at", "last_event_id"]) {
    expect(PENDING_DISPATCHES_DESCRIPTOR.columns).toContain(col);
  }
  // Sortable allowlist covers verb/id (identity browse), dispatched_at
  // (time-ordered), last_event_id (the version column).
  expect(PENDING_DISPATCHES_DESCRIPTOR.sortable.has("verb")).toBe(true);
  expect(PENDING_DISPATCHES_DESCRIPTOR.sortable.has("id")).toBe(true);
  expect(PENDING_DISPATCHES_DESCRIPTOR.sortable.has("dispatched_at")).toBe(
    true,
  );
  expect(PENDING_DISPATCHES_DESCRIPTOR.sortable.has("last_event_id")).toBe(
    true,
  );
  // No defaultFilter / defaultClause — every in-flight row is interesting
  // (an unconstrained pane shows the live launch window).
  expect(PENDING_DISPATCHES_DESCRIPTOR.defaultFilter).toBeUndefined();
  expect(PENDING_DISPATCHES_DESCRIPTOR.defaultClause).toBeUndefined();
});

test("getCollection resolves the builds collection (schema v64, fn-781)", () => {
  // Schema v64 (epic fn-781 task .1): the `keeper builds` buildbot dashboard
  // surface. One row per registered builder keyed by builder NAME (`project`),
  // produced by synthetic `BuildSnapshot` / `BuildDeleted` events.
  expect(getCollection("builds")).toBe(BUILDS_DESCRIPTOR);
  expect(BUILDS_DESCRIPTOR.table).toBe("builds");
  expect(BUILDS_DESCRIPTOR.pk).toBe("project");
  expect(BUILDS_DESCRIPTOR.version).toBe("last_event_id");
  // Filter: pk only — the per-builder read narrows on the builder name.
  expect(BUILDS_DESCRIPTOR.filters.project).toBe("project");
  // Default sort is stable by pk so the dashboard renders alphabetically.
  expect(BUILDS_DESCRIPTOR.defaultSort).toEqual({
    column: "project",
    dir: "asc",
  });
  // No JSON-decoded columns — every persisted field is a scalar.
  expect(BUILDS_DESCRIPTOR.jsonColumns.size).toBe(0);
  // Columns include every persisted field byte-for-byte against CREATE_BUILDS.
  for (const col of [
    "project",
    "builder_id",
    "build_number",
    "complete",
    "results",
    "state_string",
    "started_at",
    "complete_at",
    "last_event_id",
    "updated_at",
  ]) {
    expect(BUILDS_DESCRIPTOR.columns).toContain(col);
  }
  // Sortable allowlist covers the human-relevant columns.
  expect(BUILDS_DESCRIPTOR.sortable.has("project")).toBe(true);
  expect(BUILDS_DESCRIPTOR.sortable.has("build_number")).toBe(true);
  expect(BUILDS_DESCRIPTOR.sortable.has("results")).toBe(true);
  expect(BUILDS_DESCRIPTOR.sortable.has("last_event_id")).toBe(true);
  expect(BUILDS_DESCRIPTOR.sortable.has("updated_at")).toBe(true);
  // No defaultFilter / defaultClause — every builder row is interesting.
  expect(BUILDS_DESCRIPTOR.defaultFilter).toBeUndefined();
  expect(BUILDS_DESCRIPTOR.defaultClause).toBeUndefined();
});

test("runQuery pages an empty pending_dispatches collection on a fresh DB (schema v50, fn-678)", () => {
  // Zero-event projection: a fresh DB has zero pending_dispatches rows
  // (the table populates exclusively from the reducer's `Dispatched` fold
  // arm — task .2 of the epic). `runQuery` must serve the empty collection
  // without error so the autopilot viewer's "in-flight" pane renders
  // cleanly on a quiescent system.
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const res = asResult(
    runQuery(db, 0, { type: "query", collection: "pending_dispatches" }),
  );
  expect(res.total).toBe(0);
  expect(res.rows).toEqual([]);
  db.close();
});

test("runQuery pages a seeded pending_dispatches row with the served columns (schema v50, fn-678)", () => {
  // Hand-insert a row (no reducer needed — the descriptor + runQuery path
  // is the unit under test). Mirrors the `epics` round-trip test shape.
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  db.query(
    `INSERT INTO pending_dispatches (verb, id, dir, dispatched_at, last_event_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("keeper-work-task", "fn-1-foo.1", "/repo", 1234.5, 42);
  const res = asResult(
    runQuery(db, 42, { type: "query", collection: "pending_dispatches" }),
  );
  expect(res.total).toBe(1);
  const row = res.rows[0];
  if (row == null) throw new Error("expected one pending_dispatches row");
  expect(row.verb).toBe("keeper-work-task");
  expect(row.id).toBe("fn-1-foo.1");
  expect(row.dir).toBe("/repo");
  expect(row.dispatched_at).toBe(1234.5);
  expect(row.last_event_id).toBe(42);
  // Served columns match the descriptor's column list.
  expect(Object.keys(row).sort()).toEqual(
    [...PENDING_DISPATCHES_DESCRIPTOR.columns].sort(),
  );
  db.close();
});

test("runQuery serves autopilot_state.worktree_mode on the wire row (fn-969)", () => {
  // Regression: worktree_mode is in the write path (db column + reducer fold)
  // but was absent from AUTOPILOT_STATE_DESCRIPTOR.columns, so runQuery never
  // projected it and the banner read undefined → permanent worktree:off.
  // worktree_mode is an INTEGER (0/1) and must NOT be a jsonColumn.
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  db.query(
    `INSERT INTO autopilot_state
       (id, paused, last_event_id, created_at, updated_at, max_concurrent_jobs, mode, max_concurrent_per_root, worktree_mode)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(0, 7, 100.0, 200.0, 3, "yolo", 2, 1);
  const res = asResult(
    runQuery(db, 7, { type: "query", collection: "autopilot_state" }),
  );
  expect(res.total).toBe(1);
  const row = res.rows[0];
  if (row == null) throw new Error("expected one autopilot_state row");
  expect(row.worktree_mode).toBe(1);
  expect(row.max_concurrent_per_root).toBe(2);
  // worktree_mode stays out of jsonColumns (it is a scalar INTEGER).
  expect(AUTOPILOT_STATE_DESCRIPTOR.jsonColumns.has("worktree_mode")).toBe(
    false,
  );
  // Served columns match the descriptor's column list exactly.
  expect(Object.keys(row).sort()).toEqual(
    [...AUTOPILOT_STATE_DESCRIPTOR.columns].sort(),
  );
  db.close();
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

test("epics default sort is epic_number asc (orderless creation seed)", () => {
  // No priority/ordering signal lives in epic/board state — the backend serves
  // epics in plain `epic_number ASC` creation order (tie-break `epic_id`).
  // Scheduling consumers reorder through readiness's `orderEpicsForScheduling`
  // seam, never this descriptor.
  expect(EPICS_DESCRIPTOR.defaultSort).toEqual({
    column: "epic_number",
    dir: "asc",
  });
  // `epic_number` is in the `sortable` trust-boundary allowlist so the generic
  // ORDER BY interpolation in `src/server-worker.ts` accepts the default sort.
  expect(EPICS_DESCRIPTOR.sortable.has("epic_number")).toBe(true);
});

test("epics descriptor: the stripped priority columns are gone", () => {
  // fn-936 deleted the static priority/ordering machinery: `sort_path`,
  // `created_by_closer_of`, and `queue_jump` are no longer served, sortable,
  // or filterable.
  for (const col of ["sort_path", "created_by_closer_of", "queue_jump"]) {
    expect(EPICS_DESCRIPTOR.columns).not.toContain(col);
    expect(EPICS_DESCRIPTOR.sortable.has(col)).toBe(false);
    expect(EPICS_DESCRIPTOR.filters[col]).toBeUndefined();
  }
});

test("runQuery decodes the git status JSON columns", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
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
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
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
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
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
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
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
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
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
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
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
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
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

test("runQuery decodes the jobs.epic_links JSON-array column into a real array (creator/refiner cross-references stamped by syncPlanLinks)", () => {
  // Schema v14: each `jobs` row carries an `epic_links` JSON-TEXT array
  // (`JOBS_DESCRIPTOR.jsonColumns`) — the per-session view of the plan
  // invocation classifier's output. The read boundary parses it to a real
  // array so `result`/`patch` frames serve the decoded shape (consumers
  // never see a JSON string).
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
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
  // invocation classifier output (every session whose plan-CLI footprint
  // created or refined this epic inside a `/plan:plan` window).
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
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
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
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
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
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
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
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
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
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
  // Schema v32 (fn-634): the predicate is materialized via the VIRTUAL
  // generated column `default_visible` and queried as a literal single-column
  // equality `default_visible = 1` — literal-1 (not `params: [1]`) so the
  // partial-index matcher lands `idx_epics_default_visible WHERE
  // default_visible = 1` reliably across SQLite versions. fn-756 (v63) rewrote
  // the column expression to `status IS NOT NULL AND status='open'` (the old
  // `approval` branch dropped). ANY wire filter drops the clause (the wire is
  // the user's "I know what I want" override); a pk subscribe is exempt.
  expect(EPICS_DESCRIPTOR.defaultClause).toEqual({
    sql: "default_visible = 1",
    params: [],
  });
  // The per-key `defaultFilter` map is unused on epics — only the
  // generated-column clause applies.
  expect(EPICS_DESCRIPTOR.defaultFilter).toBeUndefined();
});

test("epics_recent_done mirrors EPICS_DESCRIPTOR's row shape (full Epic columns/jsonColumns)", () => {
  // The merged done rows are consumed as full `Epic` objects in
  // `loadReconcileSnapshot` (tasks/jobs/job_links/resolved_epic_deps). `runQuery`
  // projects ONLY `columns` and decodes ONLY `jsonColumns`, so trimming either
  // would silently degrade the reap — they MUST mirror the open descriptor.
  expect(EPICS_RECENT_DONE_DESCRIPTOR.table).toBe("epics");
  expect(EPICS_RECENT_DONE_DESCRIPTOR.columns).toEqual(
    EPICS_DESCRIPTOR.columns,
  );
  expect(EPICS_RECENT_DONE_DESCRIPTOR.pk).toBe(EPICS_DESCRIPTOR.pk);
  expect(EPICS_RECENT_DONE_DESCRIPTOR.version).toBe(EPICS_DESCRIPTOR.version);
  expect(EPICS_RECENT_DONE_DESCRIPTOR.sortable).toBe(EPICS_DESCRIPTOR.sortable);
  expect(EPICS_RECENT_DONE_DESCRIPTOR.jsonColumns).toBe(
    EPICS_DESCRIPTOR.jsonColumns,
  );
  // `updated_at` is the recencyBound + default-sort column, so it must be in the
  // (mirrored) sortable allowlist.
  expect(EPICS_RECENT_DONE_DESCRIPTOR.sortable.has("updated_at")).toBe(true);
});

test("epics_recent_done scopes to done and time-bounds on updated_at (NOT default_visible)", () => {
  // Scope is `status='done'` — it must NOT inherit `default_visible = 1` (which
  // serves only OPEN rows and would return zero done rows).
  expect(EPICS_RECENT_DONE_DESCRIPTOR.defaultClause).toEqual({
    sql: "status = ?",
    params: ["done"],
  });
  // The time bound replacing the old count LIMIT: `updated_at >= now - WINDOW`.
  expect(EPICS_RECENT_DONE_DESCRIPTOR.recencyBound).toEqual({
    column: "updated_at",
    windowSec: DONE_EPICS_REAP_WINDOW_SEC,
  });
  expect(DONE_EPICS_REAP_WINDOW_SEC).toBe(1800);
  // Default sort preserves the prior `updated_at desc` ordering.
  expect(EPICS_RECENT_DONE_DESCRIPTOR.defaultSort).toEqual({
    column: "updated_at",
    dir: "desc",
  });
});

test("runQuery on epics_recent_done: in-window done rows included, stale excluded (boundary at >=)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  // Pin the recency cutoff explicitly via `nowSec` (the 5th runQuery arg) so the
  // boundary is deterministic — `updated_at` is Unix SECONDS, same unit as the
  // cutoff. Mirrors the recencyBound template's NOW_SEC anchor.
  const NOW_SEC = 2_000_000_000;
  const cutoff = NOW_SEC - DONE_EPICS_REAP_WINDOW_SEC;
  seedEpic(db, "fn-1-fresh", {
    epic_number: 1,
    status: "done",
    updated_at: NOW_SEC,
  });
  seedEpic(db, "fn-2-boundary", {
    epic_number: 2,
    status: "done",
    updated_at: cutoff, // exactly at the floor — `>=` includes it
  });
  seedEpic(db, "fn-3-juststale", {
    epic_number: 3,
    status: "done",
    updated_at: cutoff - 1, // one second past the floor — excluded
  });
  seedEpic(db, "fn-4-ancient", {
    epic_number: 4,
    status: "done",
    updated_at: cutoff - DONE_EPICS_REAP_WINDOW_SEC, // far past — excluded
  });
  // An OPEN row must be invisible regardless of recency (scope is done-only).
  seedEpic(db, "fn-5-open", {
    epic_number: 5,
    status: "open",
    updated_at: NOW_SEC,
  });
  const res = asResult(
    runQuery(
      db,
      0,
      { type: "query", collection: "epics_recent_done" },
      undefined,
      NOW_SEC,
    ),
  );
  expect(res.rows.map((r) => String(r.epic_id)).sort()).toEqual([
    "fn-1-fresh",
    "fn-2-boundary",
  ]);
  expect(res.total).toBe(2);
  db.close();
});

// ---------------------------------------------------------------------------
// epics_pinned — the display-only pinned board collection (ADR 0018)
// ---------------------------------------------------------------------------

test("epics_pinned resolves by name and mirrors EPICS_DESCRIPTOR's row shape", () => {
  expect(getCollection("epics_pinned")).toBe(EPICS_PINNED_DESCRIPTOR);
  // Rows are consumed as full `Epic` objects (merged into computeReadiness), so
  // the column/jsonColumn surface MUST mirror the open descriptor.
  expect(EPICS_PINNED_DESCRIPTOR.table).toBe("epics");
  expect(EPICS_PINNED_DESCRIPTOR.columns).toEqual(EPICS_DESCRIPTOR.columns);
  expect(EPICS_PINNED_DESCRIPTOR.pk).toBe(EPICS_DESCRIPTOR.pk);
  expect(EPICS_PINNED_DESCRIPTOR.version).toBe(EPICS_DESCRIPTOR.version);
  expect(EPICS_PINNED_DESCRIPTOR.sortable).toBe(EPICS_DESCRIPTOR.sortable);
  expect(EPICS_PINNED_DESCRIPTOR.jsonColumns).toBe(
    EPICS_DESCRIPTOR.jsonColumns,
  );
  // Stable board slot: epic-number order, never a status-derived rank that jumps
  // rows between frames.
  expect(EPICS_PINNED_DESCRIPTOR.defaultSort).toEqual({
    column: "epic_number",
    dir: "asc",
  });
  // A pin nags until its dispatch_failures row clears — NO recency window.
  expect(EPICS_PINNED_DESCRIPTOR.recencyBound).toBeUndefined();
});

test("epics_pinned defaultClause is a verb-restricted correlated EXISTS over the failure-key vocabulary", () => {
  const clause = EPICS_PINNED_DESCRIPTOR.defaultClause;
  // The epic id comes from the correlated OUTER column, never a bound param.
  expect(clause?.params).toEqual([]);
  const sql = clause?.sql ?? "";
  // A correlated EXISTS restricted to close/work — the verb gate is exactly what
  // excludes a daemon-verb stale-base-lane row that embeds an epic id.
  expect(sql).toContain("EXISTS (SELECT 1 FROM dispatch_failures df");
  expect(sql).toContain("df.verb IN ('close', 'work')");
  // Each membership form, drawn from the ONE key vocabulary so the SQL literals
  // can't drift from the router's prefixes.
  expect(sql).toContain("df.id = epics.epic_id"); // bare close key
  expect(sql).toContain(
    `'${WORKTREE_FINALIZE_ID_PREFIX}' || epics.epic_id || '-%'`,
  );
  expect(sql).toContain(
    `'${WORKTREE_RECOVER_KEY_PREFIX}' || epics.epic_id || '-%'`,
  );
  expect(sql).toContain("epics.epic_id || '.%'"); // <epic>.<n> work-task key
});

test("runQuery on epics_pinned: every live close/work failure form pins its epic, in any status", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  // One epic per membership form, statuses mixed (open AND done) to prove the pin
  // is status-agnostic.
  seedEpic(db, "fn-1-bare", { epic_number: 1, status: "done" });
  seedEpic(db, "fn-2-finalize", { epic_number: 2, status: "done" });
  seedEpic(db, "fn-3-recover", { epic_number: 3, status: "open" });
  seedEpic(db, "fn-4-work", { epic_number: 4, status: "done" });
  // No failure row → never pinned.
  seedEpic(db, "fn-5-clean", { epic_number: 5, status: "open" });
  // Keyed ONLY by a daemon-verb stale-base-lane row → NOT pinned (verb gate).
  seedEpic(db, "fn-6-daemon", { epic_number: 6, status: "done" });

  seedDispatchFailure(db, "close", "fn-1-bare"); // bare close key
  seedDispatchFailure(
    db,
    "close",
    `${WORKTREE_FINALIZE_ID_PREFIX}fn-2-finalize-abc123`,
  );
  seedDispatchFailure(
    db,
    "close",
    `${WORKTREE_RECOVER_KEY_PREFIX}fn-3-recover-def456`,
  );
  seedDispatchFailure(db, "work", "fn-4-work.2"); // <epic>.<n> work-task key
  seedDispatchFailure(db, "daemon", "stale-base-lane:fn-6-daemon-abc123", {
    reason: "stale-base-lane",
  });

  const res = asResult(
    runQuery(db, 0, { type: "query", collection: "epics_pinned" }),
  );
  // epic_number ASC order; fn-5-clean and fn-6-daemon absent.
  expect(res.rows.map((r) => String(r.epic_id))).toEqual([
    "fn-1-bare",
    "fn-2-finalize",
    "fn-3-recover",
    "fn-4-work",
  ]);
  expect(res.total).toBe(4);
  db.close();
});

test("runQuery on epics_pinned: the verb gate excludes a daemon row whose id would otherwise match", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedEpic(db, "fn-1-daemon-bare", { epic_number: 1, status: "done" });
  // A daemon-verb row whose id is the BARE epic id — it would match `df.id =
  // epics.epic_id` were the clause not gated on verb. The verb restriction is the
  // sole guard, so the epic must NOT pin. Proves the gate is load-bearing.
  seedDispatchFailure(db, "daemon", "fn-1-daemon-bare", {
    reason: "stale-base-lane",
  });
  const res = asResult(
    runQuery(db, 0, { type: "query", collection: "epics_pinned" }),
  );
  expect(res.rows).toHaveLength(0);
  expect(res.total).toBe(0);
  db.close();
});

test("runQuery on epics_pinned: a NULL epic_id row is total (matches nothing, never errors)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  // SQLite permits NULL in a TEXT PRIMARY KEY. A shell row (NULL epic_id) must
  // fold cleanly: the correlated concat is NULL, matching nothing — no blowup and
  // no spurious match-everything, even with failure rows present.
  db.query(
    `INSERT INTO epics (epic_id, epic_number, status, updated_at, tasks, depends_on_epics, jobs, job_links)
     VALUES (NULL, 1, 'done', 1, '[]', '[]', '[]', '[]')`,
  ).run();
  seedEpic(db, "fn-2-pinned", { epic_number: 2, status: "done" });
  seedDispatchFailure(db, "close", "fn-2-pinned");
  const res = asResult(
    runQuery(db, 0, { type: "query", collection: "epics_pinned" }),
  );
  expect(res.rows.map((r) => r.epic_id)).toEqual(["fn-2-pinned"]);
  expect(res.total).toBe(1);
  db.close();
});

test("runQuery applies the default open scope when no filter is given", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedEpic(db, "fn-1-open", { epic_number: 1, status: "open" });
  seedEpic(db, "fn-2-done", { epic_number: 2, status: "done" });
  // No filter → default `status=open` keeps fn-1 (open). fn-2 (done) falls off
  // the page.
  const res = asResult(runQuery(db, 0, { type: "query", collection: "epics" }));
  expect(res.total).toBe(1);
  expect(res.rows.map((r) => String(r.epic_id))).toEqual(["fn-1-open"]);
  db.close();
});

test("an explicit status filter overrides the default open scope", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
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
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
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
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  // Seed a row so an erroneous "fetch all" implementation would return non-empty.
  seedEpic(db, "fn-1", { epic_number: 1, last_event_id: 7 });
  const map = selectVersionsByIds(db, EPICS_DESCRIPTOR, []);
  expect(map.size).toBe(0);
  db.close();
});

test("selectVersionsByIds: known seed → Map carries (pk, version) pairs, only requested ids", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
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
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 5 });
  seedJob(db, "b", { last_event_id: 9 });
  const map = selectVersionsByIds(db, JOBS_DESCRIPTOR, ["a", "b"]);
  expect(map.size).toBe(2);
  expect(map.get("a")).toBe(5);
  expect(map.get("b")).toBe(9);
  db.close();
});

test("selectVersionsByIds: typeof is number for known-non-null versions", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
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
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedEpic(db, "fn-1", { epic_number: 1, last_event_id: 7 });
  const map = selectVersionsByIds(db, EPICS_DESCRIPTOR, ["fn-1", "ghost"]);
  expect(map.size).toBe(1);
  expect(map.get("fn-1")).toBe(7);
  expect(map.get("ghost")).toBeUndefined();
  db.close();
});

test("selectVersionsByIds: ids.length > MAX_IN_PARAMS throws (mirrors selectByIds)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const ids: string[] = [];
  for (let i = 0; i < MAX_IN_PARAMS + 1; i++) ids.push(`fn-${i}`);
  expect(() => selectVersionsByIds(db, EPICS_DESCRIPTOR, ids)).toThrow(
    /exceeds SQLITE_MAX_VARIABLE_NUMBER/,
  );
  db.close();
});

// ---------------------------------------------------------------------------
// selectByIdsChunked / selectVersionsByIdsChunked — caller-side chunking that
// keeps diffTick alive when a watched collection exceeds MAX_IN_PARAMS (999).
// The `dead_letters` collection crossing 999 rows crashed the poll loop in a
// restart loop; these wrappers split the id-set into batches and merge.
// ---------------------------------------------------------------------------

test("selectVersionsByIdsChunked: > MAX_IN_PARAMS ids return ALL versions (no throw)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const n = MAX_IN_PARAMS * 2 + 17; // spans 3 batches
  const ids: string[] = [];
  // Seed in ONE transaction — ~2015 per-row autocommit fsyncs collapse to one, keeping the loop under the 10s ceiling under host I/O load.
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      seedEpic(db, `fn-${i}`, { epic_number: i, last_event_id: i });
      ids.push(`fn-${i}`);
    }
  })();
  // The unchunked helper would throw on this id-set.
  expect(() => selectVersionsByIds(db, EPICS_DESCRIPTOR, ids)).toThrow();
  const map = selectVersionsByIdsChunked(db, EPICS_DESCRIPTOR, ids);
  expect(map.size).toBe(n);
  expect(map.get("fn-0")).toBe(0);
  expect(map.get(`fn-${n - 1}`)).toBe(n - 1);
  db.close();
});

test("selectByIdsChunked: > MAX_IN_PARAMS ids return ALL rows (no throw)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const n = MAX_IN_PARAMS + 5; // spans 2 batches
  const ids: string[] = [];
  // Seed in ONE transaction — ~1004 per-row autocommit fsyncs collapse to one, keeping the loop under the 10s ceiling under host I/O load.
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      seedJob(db, `j-${i}`, { last_event_id: i });
      ids.push(`j-${i}`);
    }
  })();
  const rows = selectByIdsChunked(db, JOBS_DESCRIPTOR, ids);
  expect(rows.length).toBe(n);
  db.close();
});

test("chunked wrappers pass sub-cap id-sets straight through", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedEpic(db, "fn-1", { epic_number: 1, last_event_id: 11 });
  expect(
    selectVersionsByIdsChunked(db, EPICS_DESCRIPTOR, ["fn-1"]).get("fn-1"),
  ).toBe(11);
  expect(selectVersionsByIdsChunked(db, EPICS_DESCRIPTOR, []).size).toBe(0);
  db.close();
});

test("selectVersionsByIds: never selects JSON columns (no decodeRow path; cheap projection)", () => {
  // The whole point of the probe is to skip JSON-column reads. Even though
  // `tasks` is a populated JSON-TEXT column on epics, the returned Map
  // shape (`pk` + `version` only) has no key for it — and since the helper
  // never invokes `decodeRow`, populated JSON data can't sneak into the
  // value. This test catches a regression where someone widens the SELECT
  // projection to include arbitrary columns.
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
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
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
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

test("getCollection resolves the scheduled_tasks collection (schema v68, fn-813)", () => {
  // Schema v68 (epic fn-813 task .1): the jobs-TUI expanded-row cron detail
  // surface. One row per cron a session armed via CronCreate, keyed by the
  // composite SQL key (job_id, cron_id) but wire-identified by job_id.
  expect(getCollection("scheduled_tasks")).toBe(SCHEDULED_TASKS_DESCRIPTOR);
  expect(SCHEDULED_TASKS_DESCRIPTOR.table).toBe("scheduled_tasks");
  // Wire pk is job_id (single column) even though the SQL key is composite —
  // every subscribe filters by job_id; cron_id rides in columns for display.
  expect(SCHEDULED_TASKS_DESCRIPTOR.pk).toBe("job_id");
  expect(SCHEDULED_TASKS_DESCRIPTOR.version).toBe("last_event_id");
  expect(SCHEDULED_TASKS_DESCRIPTOR.filters.job_id).toBe("job_id");
  expect(SCHEDULED_TASKS_DESCRIPTOR.defaultSort).toEqual({
    column: "ts",
    dir: "asc",
  });
  // No JSON-decoded columns — every persisted field is a scalar.
  expect(SCHEDULED_TASKS_DESCRIPTOR.jsonColumns.size).toBe(0);
  // cron_id must ride in columns or the client (reading state.rows) collapses
  // every job's crons to one — the composite-key/single-pk contract.
  expect(SCHEDULED_TASKS_DESCRIPTOR.columns).toContain("cron_id");
  for (const col of [
    "job_id",
    "cron_id",
    "cron",
    "human_schedule",
    "recurring",
    "durable",
    "prompt_summary",
    "status",
    "ts",
    "last_event_id",
  ]) {
    expect(SCHEDULED_TASKS_DESCRIPTOR.columns).toContain(col);
  }
  expect(SCHEDULED_TASKS_DESCRIPTOR.defaultFilter).toBeUndefined();
  expect(SCHEDULED_TASKS_DESCRIPTOR.defaultClause).toBeUndefined();
});

test("runQuery pages a seeded scheduled_tasks row filtered by job_id (schema v68, fn-813)", () => {
  // Hand-insert rows for two jobs (no reducer needed — the descriptor +
  // runQuery filter path is the unit under test). The job_id filter must
  // narrow to the one job's crons, versioned on last_event_id.
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  db.query(
    `INSERT INTO scheduled_tasks (
       job_id, cron_id, cron, human_schedule, recurring, durable,
       prompt_summary, status, ts, last_event_id, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "sess-x",
    "cron-1",
    "0 * * * *",
    "Every hour",
    1,
    0,
    "do x",
    "active",
    100.0,
    7,
    100.0,
  );
  db.query(
    `INSERT INTO scheduled_tasks (
       job_id, cron_id, cron, human_schedule, recurring, durable,
       prompt_summary, status, ts, last_event_id, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "sess-y",
    "cron-2",
    "0 9 * * *",
    "Daily",
    1,
    1,
    "do y",
    "active",
    200.0,
    9,
    200.0,
  );
  const res = asResult(
    runQuery(db, 9, {
      type: "query",
      collection: "scheduled_tasks",
      filter: { job_id: "sess-x" },
    }),
  );
  expect(res.total).toBe(1);
  const row = res.rows[0];
  if (row == null) throw new Error("expected one scheduled_tasks row");
  expect(row.job_id).toBe("sess-x");
  expect(row.cron_id).toBe("cron-1");
  expect(row.human_schedule).toBe("Every hour");
  expect(row.recurring).toBe(1);
  expect(row.last_event_id).toBe(7);
  // Served columns match the descriptor's column list.
  expect(Object.keys(row).sort()).toEqual(
    [...SCHEDULED_TASKS_DESCRIPTOR.columns].sort(),
  );
  db.close();
});

// ---------------------------------------------------------------------------
// Composite live-key identity (fn-1065). `dispatch_failures` declares
// `pk: "verb"` while its real identity is `(verb, id)` and `verb` is a tiny
// class (`work` / `close`). The DIFF path keys watched membership / the version
// probe / the byId fan-out / the membership token by `liveKeyExpr` so two
// same-verb rows track independently instead of collapsing to one live pill on
// `board --watch`. These exercise that seam WITHOUT a real subscription.
// ---------------------------------------------------------------------------

function seedDispatchFailure(
  db: Database,
  verb: string,
  id: string,
  opts: Partial<{ reason: string; last_event_id: number }> = {},
): void {
  db.query(
    `INSERT INTO dispatch_failures (verb, id, reason, dir, ts, last_event_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    verb,
    id,
    opts.reason ?? "worktree-finalize-non-fast-forward",
    null,
    1.0,
    opts.last_event_id ?? 1,
    1.0,
    1.0,
  );
}

test("liveKeyExpr: single-pk descriptor falls back to the bare pk column (SQL unchanged)", () => {
  expect(liveKeyExpr(EPICS_DESCRIPTOR)).toBe(EPICS_DESCRIPTOR.pk);
  expect(liveKeyExpr(JOBS_DESCRIPTOR)).toBe(JOBS_DESCRIPTOR.pk);
});

test("liveKeyExpr: dispatch_failures composes (verb, id) into one SQL identity", () => {
  expect(liveKeyExpr(DISPATCH_FAILURES_DESCRIPTOR)).toBe(
    "verb || char(31) || id",
  );
});

test("liveKeyOf: two same-verb dispatch_failures rows produce DISTINCT keys", () => {
  const a = liveKeyOf(DISPATCH_FAILURES_DESCRIPTOR, {
    verb: "close",
    id: "fn-1",
  });
  const b = liveKeyOf(DISPATCH_FAILURES_DESCRIPTOR, {
    verb: "close",
    id: "fn-2",
  });
  expect(a).not.toBe(b);
  // A single-pk descriptor still keys by the pk value alone (unchanged).
  expect(liveKeyOf(EPICS_DESCRIPTOR, { epic_id: "fn-9" })).toBe("fn-9");
});

test("selectVersionsByIds: two same-verb dispatch_failures rows track as two keys, not one", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedDispatchFailure(db, "close", "fn-1", { last_event_id: 5 });
  seedDispatchFailure(db, "close", "fn-2", { last_event_id: 7 });
  const k1 = liveKeyOf(DISPATCH_FAILURES_DESCRIPTOR, {
    verb: "close",
    id: "fn-1",
  });
  const k2 = liveKeyOf(DISPATCH_FAILURES_DESCRIPTOR, {
    verb: "close",
    id: "fn-2",
  });
  const map = selectVersionsByIds(db, DISPATCH_FAILURES_DESCRIPTOR, [k1, k2]);
  // The pk-collapse bug returned ONE entry keyed by "close"; the composite key
  // gives each row its own version cursor for the diff's change detection.
  expect(map.size).toBe(2);
  expect(map.get(k1)).toBe(5);
  expect(map.get(k2)).toBe(7);
  db.close();
});

test("selectByIdsChunked: composite ids fetch BOTH same-verb rows for the diff fan-out", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedDispatchFailure(db, "close", "fn-1", { reason: "merge-conflict" });
  seedDispatchFailure(db, "close", "fn-2", { reason: "non-fast-forward" });
  const k1 = liveKeyOf(DISPATCH_FAILURES_DESCRIPTOR, {
    verb: "close",
    id: "fn-1",
  });
  const k2 = liveKeyOf(DISPATCH_FAILURES_DESCRIPTOR, {
    verb: "close",
    id: "fn-2",
  });
  const rows = selectByIdsChunked(db, DISPATCH_FAILURES_DESCRIPTOR, [k1, k2]);
  expect(rows.length).toBe(2);
  // Re-index by liveKeyOf exactly as the diff's byId fan-out does — two entries,
  // one patch frame each (never a single collapsed "close" slot).
  const byId = new Map(
    rows.map((r) => [liveKeyOf(DISPATCH_FAILURES_DESCRIPTOR, r), r]),
  );
  expect(byId.size).toBe(2);
  expect(byId.get(k1)?.reason).toBe("merge-conflict");
  expect(byId.get(k2)?.reason).toBe("non-fast-forward");
  db.close();
});

test("countAndToken: membership token distinguishes two same-verb rows (composite fingerprint)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedDispatchFailure(db, "close", "fn-1");
  const one = countAndToken(db, DISPATCH_FAILURES_DESCRIPTOR, "", []);
  seedDispatchFailure(db, "close", "fn-2");
  const two = countAndToken(db, DISPATCH_FAILURES_DESCRIPTOR, "", []);
  expect(one.total).toBe(1);
  expect(two.total).toBe(2);
  // A group_concat over the bare `verb` would read "close,close" and miss a
  // balanced same-verb swap; the composite fingerprint carries both ids.
  expect(two.token).not.toBe(one.token);
  expect(two.token).toContain("fn-1");
  expect(two.token).toContain("fn-2");
  db.close();
});

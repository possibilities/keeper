/**
 * Schema-shape tests for `openDb()`. These run on a tmp-path DB driven by
 * `KEEPER_DB` resolution; we pass the path explicitly so each test gets a
 * fresh file without leaking state. The assertions mirror the task's
 * Acceptance list — tables present, indexes present, PRAGMAs applied,
 * reducer_state seeded, readonly flag honored, env-var override honored.
 */

import { Database } from "bun:sqlite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AWAITS_DESCRIPTOR,
  DISPATCH_FAILURES_DESCRIPTOR,
  JOBS_DESCRIPTOR,
  selectByIds,
} from "../src/collections";
import {
  computeSchemaFingerprint,
  DEFAULT_MAX_CONCURRENT_PER_ROOT,
  DEFAULT_REPO_CLONE_ROOT,
  DEFAULT_REPO_CREATE_ROOT,
  DEFAULT_REPO_FORK_ROOT,
  effectivePerRootCap,
  isTransientBootOpenError,
  MAX_EFFECTIVE_CONCURRENT_PER_ROOT,
  MAX_IN_PARAMS,
  openDb,
  resolveClaudeProjectsRoot,
  resolveConfig,
  resolveDbPath,
  resolvePlanRoots,
  resolveRepoCloneRoot,
  resolveRepoCreateRoot,
  resolveRepoForkRoot,
  resolveSockPath,
  SCHEMA_FINGERPRINT,
  SCHEMA_STEPS,
  SCHEMA_VERSION,
  selectWorldRev,
} from "../src/db";
import { __resetEpicIndexMemoForTest, drain } from "../src/reducer";
import type { Job } from "../src/types";
import { freshMemDb } from "./helpers/template-db";

/**
 * Boot drain helper for migration tests. Schema v11's rewind-and-redrain
 * sets the cursor to 0 inside migrate; the daemon's boot drain rebuilds the
 * projection AFTER `openDb` returns. Tests that don't spin up the daemon
 * must call this explicitly to observe the re-folded state. (v12 is a
 * non-rewind sidecar ADD — no drain required for the v11→v12 step.)
 */
function drainAll(
  db: import("bun:sqlite").Database,
  drainFn: (db: import("bun:sqlite").Database) => number = drain,
): void {
  const readCursor = (): number =>
    (
      db
        .query("SELECT last_event_id FROM reducer_state WHERE id = 1")
        .get() as { last_event_id: number } | null
    )?.last_event_id ?? 0;
  // Absolute iteration ceiling — a backstop in case the cursor-advance check
  // ever false-negatives on a real corpus. Each drain() folds up to one batch,
  // so the log drains in (events / batchSize) iterations; this ceiling sits far
  // above any migration corpus a test could build, while still making a runaway
  // synchronous spin structurally impossible.
  const MAX_ITERATIONS = 100_000;
  let iterations = 0;
  let n: number;
  do {
    const before = readCursor();
    n = drainFn(db);
    const after = readCursor();
    // A non-advancing fold — drain() reports work but the cursor stayed put —
    // is a re-fold determinism bug, not a benign stall. applyEvent co-advances
    // reducer_state.last_event_id in the same transaction as every fold, so a
    // healthy drain() returning >0 always moves the cursor. Surface the stall
    // loudly instead of spinning silently.
    if (n > 0 && after <= before) {
      throw new Error(
        `drainAll: non-advancing fold — drain() processed ${n} event(s) but ` +
          `reducer_state.last_event_id did not advance (stuck at ${after}). ` +
          `This is a re-fold determinism bug.`,
      );
    }
    if (++iterations > MAX_ITERATIONS) {
      throw new Error(
        `drainAll: exceeded ${MAX_ITERATIONS} iterations (cursor at ${after}); ` +
          `aborting to avoid a synchronous spin.`,
      );
    }
  } while (n > 0);
}

test("drainAll throws on a non-advancing fold instead of spinning", () => {
  const { db } = openDb(":memory:");
  // Synthetic non-advancing fold: claims one event folded on every call but
  // never moves the cursor. The real drain() can never do this (applyEvent
  // advances the cursor in the same transaction as the fold), so inject a fake
  // to exercise the guard without monkeypatching the module.
  let calls = 0;
  const stuckDrain = (): number => {
    calls += 1;
    return 1;
  };
  expect(() => drainAll(db, stuckDrain)).toThrow(/non-advancing fold/);
  // Bounded: it threw on the first non-advancing iteration, not after a spin.
  expect(calls).toBe(1);
  db.close();
});

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-db-test-"));
  dbPath = join(tmpDir, "keeper.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test("openDb creates events, jobs, reducer_state, meta tables", () => {
  const { db } = openDb(":memory:");
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all() as { name: string }[];
  const names = new Set(tables.map((t) => t.name));
  expect(names.has("events")).toBe(true);
  expect(names.has("jobs")).toBe(true);
  expect(names.has("epics")).toBe(true);
  // Schema v7 dropped the standalone `tasks` table — tasks are embedded as a
  // JSON-array column on `epics`.
  expect(names.has("tasks")).toBe(false);
  expect(names.has("reducer_state")).toBe(true);
  expect(names.has("meta")).toBe(true);
  // Schema v13 dropped the `approvals` sidecar (replaced by the planctl-
  // native `epics.approval` column + the in-file `task.approval` field).
  expect(names.has("approvals")).toBe(false);
  db.close();
});

test("openDb creates the handoffs table with the documented columns (fn-946)", () => {
  // A real openDb migration exercise: the v86→v87 step (the `CREATE_HANDOFFS`
  // run in the steady-state schema-setup block) must materialize the table and
  // every documented column so the durable `keeper handoff` projection has a
  // home before its fold arms (tasks .2/.3) populate it.
  const { db } = openDb(dbPath);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  expect(new Set(tables.map((t) => t.name)).has("handoffs")).toBe(true);

  const cols = db.prepare("PRAGMA table_info(handoffs)").all() as {
    name: string;
    notnull: number;
  }[];
  const colNames = new Set(cols.map((c) => c.name));
  for (const c of [
    "handoff_id",
    "status",
    "doc",
    "title",
    "target_session",
    "target_dir",
    "initiator_session",
    "initiator_pane",
    "initiator_job_id",
    "callee_job_id",
    "claimed_at",
    "never_bound_count",
    "last_event_id",
  ]) {
    expect(colNames.has(c)).toBe(true);
  }

  // Round-trips a row — proves the PK + the NOT NULL columns (`status`, `doc`,
  // `last_event_id`) accept a real insert and read back identically. The doc
  // body rides inline forever (it is read by a fold's keep-set); the WRITE-time
  // cap lives in task .2, not the schema.
  db.run(
    `INSERT INTO handoffs (handoff_id, status, doc, last_event_id)
       VALUES ('h-1', 'requested', 'context: explore X', 7)`,
  );
  const row = db
    .prepare(
      "SELECT handoff_id, status, doc, never_bound_count, last_event_id FROM handoffs WHERE handoff_id = 'h-1'",
    )
    .get() as {
    handoff_id: string;
    status: string;
    doc: string;
    never_bound_count: number;
    last_event_id: number;
  } | null;
  expect(row).not.toBeNull();
  expect(row?.handoff_id).toBe("h-1");
  expect(row?.status).toBe("requested");
  expect(row?.doc).toBe("context: explore X");
  // `never_bound_count` defaults to 0 when omitted.
  expect(row?.never_bound_count).toBe(0);
  expect(row?.last_event_id).toBe(7);
  db.close();
});

test("openDb creates the Durable awaits Projection and its collection descriptor lists rows", () => {
  const { db } = openDb(dbPath);
  const cols = db.prepare("PRAGMA table_info(awaits)").all() as {
    name: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  expect(cols.map((column) => column.name)).toEqual([
    "await_id",
    "condition_spec",
    "follow_up",
    "target_session",
    "target_dir",
    "timeout_at",
    "status",
    "claimed_at",
    "attempt_count",
    "never_bound_count",
    "last_event_id",
  ]);
  db.prepare(
    `INSERT INTO awaits (
       await_id, condition_spec, follow_up, target_session, status, last_event_id
     ) VALUES (?, ?, ?, ?, 'waiting', ?)`,
  ).run(
    "await-listable",
    JSON.stringify([{ condition: "drained" }]),
    "plan the next epic",
    "work",
    12,
  );
  expect(selectByIds(db, AWAITS_DESCRIPTOR, ["await-listable"])).toEqual([
    {
      await_id: "await-listable",
      condition_spec: [{ condition: "drained" }],
      follow_up: "plan the next epic",
      target_session: "work",
      target_dir: null,
      timeout_at: null,
      status: "waiting",
      claimed_at: null,
      attempt_count: 0,
      never_bound_count: 0,
      last_event_id: 12,
    },
  ]);
  db.close();
});

test("openDb adds the jobs.handoff_links column defaulting '[]' (fn-946 task .2)", () => {
  // The v87→v88 step (`addColumnIfMissing(jobs, handoff_links)`) is the per-job
  // home for the rendered handoff edge. A fresh row reads the zero-event default
  // `'[]'` so a re-fold over a pre-feature log re-derives byte-identical rows.
  const { db } = openDb(dbPath);
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as {
    name: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const col = cols.find((c) => c.name === "handoff_links");
  expect(col).toBeDefined();
  expect(col?.notnull).toBe(1);
  db.prepare(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at) VALUES ('jh', 1, 0, 1)",
  ).run();
  const r = db
    .prepare("SELECT handoff_links FROM jobs WHERE job_id = 'jh'")
    .get() as { handoff_links: string };
  expect(r.handoff_links).toBe("[]");
  db.close();
});

test("openDb adds the six nullable v100 session-telemetry columns to jobs (fn-1024 task .1)", () => {
  // The v99→v100 step (`addColumnIfMissing(jobs, current_model_id / …)`) plumbs
  // the CURRENT model / effort / context-window usage from the statusLine
  // payload. All nullable, NO default — a `DEFAULT` would poison the NULL=absent
  // invariant the render reads and break re-fold byte-identity.
  const telemetryCols = [
    { name: "current_model_id", type: "TEXT" },
    { name: "current_model_display", type: "TEXT" },
    { name: "current_effort", type: "TEXT" },
    { name: "context_used_percentage", type: "REAL" },
    { name: "context_input_tokens", type: "INTEGER" },
    { name: "context_window_size", type: "INTEGER" },
  ];
  const { db } = openDb(":memory:");
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  for (const { name, type } of telemetryCols) {
    const col = cols.find((c) => c.name === name);
    expect(col).toBeDefined();
    expect(col?.type).toBe(type);
    // Nullable, NO default (re-fold byte-identity + NULL=absent invariant).
    expect(col?.notnull).toBe(0);
    expect(col?.dflt_value).toBeNull();
  }
  // A bare-inserted row reads NULL for all six (the zero-event shape).
  db.prepare(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at) VALUES ('jt', 1, 0, 1)",
  ).run();
  const r = db
    .prepare(
      "SELECT current_model_id, current_model_display, current_effort, context_used_percentage, context_input_tokens, context_window_size FROM jobs WHERE job_id = 'jt'",
    )
    .get() as Record<string, unknown>;
  for (const { name } of telemetryCols) {
    expect(r[name]).toBeNull();
  }
  db.close();
});

test("the v100 telemetry columns + v103 kill_reason + v108 dispatch_origin + v109 harness/resume_target + v110 adopted + v113 last_lifecycle_ts + v114 escalation_instance + v119 account_route are the byte-identical tail on fresh vs migrated jobs (fn-1024 task .1, fn-1075 task .2, fn-1107 task .1, fn-1103 task .3, fn-1131 task .1, fn-1164 task .1, fn-1171 task .2, fn-1239 task .3)", () => {
  // Kept OUT of the `CREATE_JOBS` literal and appended as the LAST
  // `addColumnIfMissing` calls in `migrate()`, so these columns land as the
  // trailing columns of `table_info(jobs)`, in the same order, on both the fresh
  // path and a migrated-from-old path — the fresh-vs-migrated PRAGMA parity the
  // re-fold determinism charter depends on. `account_route` (v119) is the
  // current final appended column, trailing `escalation_instance` (v114),
  // `last_lifecycle_ts` (v113), `adopted` (v110), `harness`/`resume_target`
  // (v109), `dispatch_origin` (v108), `kill_reason` (v103), and the v100
  // telemetry six.
  const expectedTail = [
    "current_model_id",
    "current_model_display",
    "current_effort",
    "context_used_percentage",
    "context_input_tokens",
    "context_window_size",
    "kill_reason",
    "dispatch_origin",
    "harness",
    "resume_target",
    "adopted",
    "last_lifecycle_ts",
    "escalation_instance",
    "account_route",
  ];
  const tailOf = (database: Database): string[] => {
    const names = (
      database.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]
    ).map((c) => c.name);
    return names.slice(-expectedTail.length);
  };

  const { db: fresh } = openDb(":memory:");
  expect(tailOf(fresh)).toEqual(expectedTail);
  fresh.close();

  // Build a minimal pre-telemetry jobs DB stamped at an old version; migrate()
  // appends every missing column idempotently, ending with the v100 six.
  const old = new Database(dbPath, { create: true });
  old.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT
    )
  `);
  old.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  old.run("INSERT INTO meta (key, value) VALUES ('schema_version', '4')");
  old.close();

  const { db: migrated } = openDb(dbPath);
  expect(
    (
      migrated
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string }
    ).value,
  ).toBe(String(SCHEMA_VERSION));
  expect(tailOf(migrated)).toEqual(expectedTail);
  migrated.close();
});

test("the v104 question + v117 blocks_closing_of are the byte-identical epics tail on fresh vs migrated (fn-1083 task .2, fn-1216 task .1)", () => {
  // Both are declared in the `CREATE_EPICS` literal (after the VIRTUAL
  // `default_visible`) AND appended by an `ALTER TABLE ADD COLUMN` migration
  // step, so they must land as the SAME trailing columns of `table_xinfo(epics)`
  // — in the same order — on both the fresh CREATE path and a migrated-from-old
  // path. `table_xinfo` (not `table_info`) is used because the epics table
  // carries the VIRTUAL `default_visible` generated column; the two scalar tail
  // columns follow it. `blocks_closing_of` (v117) is the current final column,
  // trailing `question` (v104).
  const expectedTail = ["question", "blocks_closing_of"];
  const tailOf = (database: Database): string[] => {
    const names = (
      database.prepare("PRAGMA table_xinfo(epics)").all() as { name: string }[]
    ).map((c) => c.name);
    return names.slice(-expectedTail.length);
  };

  const { db: fresh } = openDb(":memory:");
  expect(tailOf(fresh)).toEqual(expectedTail);
  fresh.close();

  // A v5-shaped DB has no epics table at all; migrate() creates it (v85 rebuild
  // shape) then appends `question` (v104) and `blocks_closing_of` (v117) via
  // idempotent ALTERs, ending with the two-column tail above.
  const old = new Database(dbPath, { create: true });
  old.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  old.run("INSERT INTO meta (key, value) VALUES ('schema_version', '5')");
  old.close();

  const { db: migrated } = openDb(dbPath);
  expect(
    (
      migrated
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string }
    ).value,
  ).toBe(String(SCHEMA_VERSION));
  expect(tailOf(migrated)).toEqual(expectedTail);
  migrated.close();
});

test("boot_catchup_stats.fold_work_ms is the nullable tail on fresh vs migrated (fn-1313)", () => {
  // `fold_work_ms` is declared LAST in the `CREATE_BOOT_CATCHUP_STATS` literal
  // AND appended by an idempotent `ALTER TABLE ADD COLUMN` migration step, so it
  // must land as the SAME trailing column of the operational singleton on both
  // the fresh CREATE path and a stepped upgrade from a DB whose
  // boot_catchup_stats predates the column. It MUST be nullable (no NOT NULL, no
  // DEFAULT) so a pre-migration or never-recorded row reads as "not measured",
  // never as an instant-rebuild 0.
  const colsOf = (
    database: Database,
  ): { name: string; notnull: number; dflt_value: unknown }[] =>
    database.prepare("PRAGMA table_info(boot_catchup_stats)").all() as {
      name: string;
      notnull: number;
      dflt_value: unknown;
    }[];
  const tailOf = (
    cols: { name: string; notnull: number; dflt_value: unknown }[],
  ): { name: string; notnull: number; dflt_value: unknown } =>
    cols[cols.length - 1];

  const { db: fresh } = openDb(":memory:");
  const freshCols = colsOf(fresh);
  const freshTail = tailOf(freshCols);
  expect(freshTail.name).toBe("fold_work_ms");
  expect(freshTail.notnull).toBe(0);
  expect(freshTail.dflt_value).toBeNull();
  fresh.close();

  // A pre-v133-shaped DB has no boot_catchup_stats at all; hand-seed the legacy
  // 6-column shape (the column set before fold_work_ms) so migrate()'s additive
  // step ALTER-appends the column rather than the CREATE literal materializing
  // it. Stamped v5 like the epics-tail convergence gate above, so migrate walks
  // the full ladder over the legacy table.
  const old = new Database(dbPath, { create: true });
  old.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  old.run("INSERT INTO meta (key, value) VALUES ('schema_version', '5')");
  old.run(
    `CREATE TABLE boot_catchup_stats (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        started_at REAL NOT NULL,
        completed_at REAL NOT NULL,
        start_event_id INTEGER NOT NULL,
        end_event_id INTEGER NOT NULL,
        updated_at REAL NOT NULL
      )`,
  );
  old.close();

  const { db: migrated } = openDb(dbPath);
  const migratedCols = colsOf(migrated);
  const migratedTail = tailOf(migratedCols);
  expect(migratedTail.name).toBe("fold_work_ms");
  expect(migratedTail.notnull).toBe(0);
  expect(migratedTail.dflt_value).toBeNull();
  // Fresh and stepped-upgrade converge on the same singleton column order.
  expect(migratedCols.map((c) => c.name)).toEqual(freshCols.map((c) => c.name));
  migrated.close();
});

test("SCHEMA_FINGERPRINT pins the fully-migrated schema shape — re-pin it with EVERY schema change", () => {
  // The pinned constant is the schema's lock file: any schema change (new
  // migration block, CREATE-literal edit, bare version bump) moves the live
  // fingerprint, so this test forces the one-line re-pin in src/db.ts — and two
  // lanes re-pinning to DIFFERENT hashes always git-conflict on that line,
  // where two identical "next SCHEMA_VERSION" integers would merge silently.
  const { db } = openDb(":memory:");
  const live = computeSchemaFingerprint(db);
  db.close();
  expect(live).toMatch(new RegExp(`^v${SCHEMA_VERSION}:[0-9a-f]{64}$`));
  expect(live).toBe(SCHEMA_FINGERPRINT);
});

test("SCHEMA_STEPS versions are unique — a duplicate version is a structural error", () => {
  const versions = SCHEMA_STEPS.map((s) => s.version);
  const uniq = new Set(versions);
  expect(uniq.size).toBe(versions.length);
});

test("SCHEMA_STEPS versions are strictly increasing in array order — a reorder is a structural error", () => {
  const versions = SCHEMA_STEPS.map((s) => s.version);
  for (let i = 1; i < versions.length; i++) {
    expect(versions[i]).toBeGreaterThan(versions[i - 1]);
  }
});

test("SCHEMA_STEPS versions are contiguous from the ladder floor to the tail — a gap is a structural error", () => {
  const versions = SCHEMA_STEPS.map((s) => s.version);
  const floor = versions[0];
  const tail = versions[versions.length - 1];
  const expected = Array.from(
    { length: tail - floor + 1 },
    (_, i) => floor + i,
  );
  expect(versions).toEqual(expected);
});

test("SCHEMA_STEPS tail equals SCHEMA_VERSION — the derived constant must track the ladder", () => {
  expect(SCHEMA_STEPS[SCHEMA_STEPS.length - 1].version).toBe(SCHEMA_VERSION);
});

test("every SCHEMA_STEPS entry carries a machine-readable kind discriminant", () => {
  const validKinds = new Set([
    "additive",
    "rewind",
    "backfill",
    "drop",
    "noop",
  ]);
  for (const step of SCHEMA_STEPS) {
    expect(typeof step.kind).toBe("string");
    expect(validKinds.has(step.kind)).toBe(true);
  }
});

test("v120: a pre-retirement DB with real usage/profiles rows drops both tables idempotently and reopens cleanly (fn-1239 task .6)", () => {
  // Simulate a genuine pre-v120 upgrade: hand-seed POPULATED `usage` /
  // `profiles` tables (real rows, not an empty transient fixture) with NO
  // `meta` row (no version stamp), so `migrate()` reads it as v0 and walks
  // the FULL ladder — the same fresh-0→head path every other "fresh" test in
  // this file exercises, just with two tables (and their data) already
  // present before the steady-state `CREATE TABLE IF NOT EXISTS` block runs
  // (which leaves them untouched). Every historical step still runs against
  // them (some ADD columns, some wipe rows on a rewind-and-redrain, exactly
  // as a real historical upgrade would), and the v120 tail step must DROP
  // both tables unconditionally without throwing; a second openDb must be a
  // no-op (`DROP TABLE IF EXISTS` on an absent table).
  const pre = new Database(dbPath, { create: true });
  pre.run(
    `CREATE TABLE usage (
       id TEXT PRIMARY KEY,
       target TEXT,
       last_event_id INTEGER,
       updated_at REAL NOT NULL DEFAULT 0
     )`,
  );
  pre.run(
    "INSERT INTO usage (id, target, last_event_id, updated_at) VALUES ('claude-default', 'claude', 100, 1)",
  );
  pre.run(
    `CREATE TABLE profiles (
       config_dir TEXT NOT NULL PRIMARY KEY,
       profile_name TEXT,
       last_event_id INTEGER,
       updated_at REAL NOT NULL DEFAULT 0
     )`,
  );
  pre.run(
    "INSERT INTO profiles (config_dir, profile_name, last_event_id, updated_at) VALUES ('', NULL, 100, 1)",
  );
  pre.close();

  expect(() => openDb(dbPath)).not.toThrow();
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));
  for (const table of ["usage", "profiles"]) {
    const has = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table);
    expect(has ?? null).toBeNull();
  }
  db.close();

  // Idempotent re-open: still absent, no throw.
  expect(() => openDb(dbPath)).not.toThrow();
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe(String(SCHEMA_VERSION));
  for (const table of ["usage", "profiles"]) {
    const has = db2
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table);
    expect(has ?? null).toBeNull();
  }
  db2.close();
});

test("openDb adds nullable escalation_instance to jobs + instance_event_id to dispatch_failures, no DEFAULT (fn-1171 task .2)", () => {
  // The v113→v114 step binds an escalation session to its block instance:
  // `jobs.escalation_instance` (the bound instance id) and
  // `dispatch_failures.instance_event_id` (the sticky row's first-appearance
  // incident id). Both nullable INTEGER, NO default — a DEFAULT would poison the
  // NULL=absent invariant and break re-fold byte-identity. A bare-inserted row
  // reads NULL on both (the zero-event shape).
  const { db } = openDb(":memory:");
  const jobsCol = (
    db.prepare("PRAGMA table_info(jobs)").all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[]
  ).find((c) => c.name === "escalation_instance");
  expect(jobsCol).toBeDefined();
  expect(jobsCol?.type).toBe("INTEGER");
  expect(jobsCol?.notnull).toBe(0);
  expect(jobsCol?.dflt_value).toBeNull();

  const dfCol = (
    db.prepare("PRAGMA table_info(dispatch_failures)").all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[]
  ).find((c) => c.name === "instance_event_id");
  expect(dfCol).toBeDefined();
  expect(dfCol?.type).toBe("INTEGER");
  expect(dfCol?.notnull).toBe(0);
  expect(dfCol?.dflt_value).toBeNull();

  db.prepare(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at) VALUES ('je', 1, 0, 1)",
  ).run();
  expect(
    (
      db
        .prepare("SELECT escalation_instance FROM jobs WHERE job_id = 'je'")
        .get() as { escalation_instance: number | null }
    ).escalation_instance,
  ).toBeNull();
  db.prepare(
    "INSERT INTO dispatch_failures (verb, id, reason, ts, last_event_id, created_at, updated_at) VALUES ('close', 'fn-df-i', 'r', 1, 0, 1, 1)",
  ).run();
  expect(
    (
      db
        .prepare(
          "SELECT instance_event_id FROM dispatch_failures WHERE verb = 'close' AND id = 'fn-df-i'",
        )
        .get() as { instance_event_id: number | null }
    ).instance_event_id,
  ).toBeNull();
  db.close();
});

test("openDb adds nullable Dispatch attempt owners to failures and mint gates", () => {
  expect(DISPATCH_FAILURES_DESCRIPTOR.columns).toContain("attempt_id");
  expect(DISPATCH_FAILURES_DESCRIPTOR.columns).toContain("instance_event_id");
  const { db } = openDb(":memory:");
  for (const table of ["dispatch_failures", "dispatch_mint_gate"] as const) {
    const owner = (
      db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        cid: number;
        pk: number;
      }[]
    ).find((column) => column.name === "attempt_id");
    expect(owner).toEqual({
      name: "attempt_id",
      type: "INTEGER",
      notnull: 0,
      dflt_value: null,
      pk: 0,
      cid: expect.any(Number),
    });
  }

  db.prepare(
    "INSERT INTO dispatch_failures (verb, id, reason, ts, last_event_id, created_at, updated_at) VALUES ('work', 'legacy', 'r', 1, 1, 1, 1)",
  ).run();
  db.prepare(
    "INSERT INTO dispatch_mint_gate (dispatch_key, minted_at) VALUES ('work::legacy', 1)",
  ).run();
  expect(
    db
      .prepare(
        "SELECT attempt_id FROM dispatch_failures WHERE verb = 'work' AND id = 'legacy'",
      )
      .get(),
  ).toEqual({ attempt_id: null });
  expect(
    db
      .prepare(
        "SELECT attempt_id FROM dispatch_mint_gate WHERE dispatch_key = 'work::legacy'",
      )
      .get(),
  ).toEqual({ attempt_id: null });
  db.close();
});

test("openDb adds nullable harness + resume_target to BOTH events and jobs (fn-1103 task .3)", () => {
  // The v106->v107 step adds the two multi-harness columns to both surfaces:
  // events via the FIVE-place lockstep (CREATE literal + migration append), jobs
  // migration-only. Nullable, NO default (the NULL=absent + re-fold byte-identity
  // invariant). A bare-inserted row reads NULL on both.
  const { db } = openDb(":memory:");
  for (const table of ["events", "jobs"] as const) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    for (const name of ["harness", "resume_target"] as const) {
      const col = cols.find((c) => c.name === name);
      expect(col).toBeDefined();
      expect(col?.type).toBe("TEXT");
      expect(col?.notnull).toBe(0);
      expect(col?.dflt_value).toBeNull();
    }
  }
  db.prepare(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at) VALUES ('jh', 1, 0, 1)",
  ).run();
  const r = db
    .prepare("SELECT harness, resume_target FROM jobs WHERE job_id = 'jh'")
    .get() as { harness: string | null; resume_target: string | null };
  expect(r.harness).toBeNull();
  expect(r.resume_target).toBeNull();
  db.close();
});

test("openDb adds nullable adopted to BOTH events and jobs (fn-1131 task .1)", () => {
  // The durable adopted marker remains on both harness-agnostic lifecycle
  // surfaces: events via the column lockstep and jobs migration-only. It is
  // nullable with no default, preserving the NULL=absent replay invariant.
  const { db } = openDb(":memory:");
  for (const table of ["events", "jobs"] as const) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const col = cols.find((c) => c.name === "adopted");
    expect(col).toBeDefined();
    expect(col?.type).toBe("INTEGER");
    expect(col?.notnull).toBe(0);
    expect(col?.dflt_value).toBeNull();
  }

  db.prepare(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at) VALUES ('ja', 1, 0, 1)",
  ).run();
  const r = db
    .prepare("SELECT adopted FROM jobs WHERE job_id = 'ja'")
    .get() as { adopted: number | null };
  expect(r.adopted).toBeNull();
  db.close();
});

test("autopilot_state adoption-column drop preserves every surviving value and fresh-schema order", () => {
  const seeded = openDb(dbPath);
  seeded.db.run(
    "ALTER TABLE autopilot_state ADD COLUMN codex_adoption INTEGER",
  );
  seeded.db.run("UPDATE meta SET value = '126' WHERE key = 'schema_version'");
  const fixture = {
    id: 1,
    paused: 0,
    last_event_id: 9_007_199_254_740_001,
    created_at: 1234.125,
    updated_at: 9876.875,
    max_concurrent_jobs: 17,
    mode: "armed",
    max_concurrent_per_root: 4,
    worktree_mode: 1,
    worktree_multi_repo: 0,
    worker_provider: "gpt",
    drift_behind_threshold: 23,
    drift_age_threshold_days: 11,
  };
  seeded.db
    .prepare(`
      INSERT INTO autopilot_state (
        id, paused, last_event_id, created_at, updated_at,
        max_concurrent_jobs, mode, max_concurrent_per_root,
        worktree_mode, worktree_multi_repo, codex_adoption, worker_provider,
        drift_behind_threshold, drift_age_threshold_days
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      fixture.id,
      fixture.paused,
      fixture.last_event_id,
      fixture.created_at,
      fixture.updated_at,
      fixture.max_concurrent_jobs,
      fixture.mode,
      fixture.max_concurrent_per_root,
      fixture.worktree_mode,
      fixture.worktree_multi_repo,
      1,
      fixture.worker_provider,
      fixture.drift_behind_threshold,
      fixture.drift_age_threshold_days,
    );
  seeded.db.close();

  const migrated = openDb(dbPath);
  const migratedInfo = migrated.db
    .prepare("PRAGMA table_info(autopilot_state)")
    .all();
  expect(
    (migratedInfo as { name: string }[]).some(
      (column) => column.name === "codex_adoption",
    ),
  ).toBe(false);
  expect(
    migrated.db.prepare("SELECT * FROM autopilot_state WHERE id = 1").get(),
  ).toEqual(fixture);

  const fresh = openDb(":memory:");
  const freshInfo = fresh.db
    .prepare("PRAGMA table_info(autopilot_state)")
    .all();
  expect(migratedInfo).toEqual(freshInfo);
  fresh.db.close();
  migrated.db.close();

  // Historical additive steps run on every open; the tail drop must therefore
  // converge on re-open rather than allowing the retired column to return.
  const reopened = openDb(dbPath);
  const reopenedInfo = reopened.db
    .prepare("PRAGMA table_info(autopilot_state)")
    .all() as { name: string }[];
  expect(reopenedInfo.some((column) => column.name === "codex_adoption")).toBe(
    false,
  );
  expect(
    reopened.db.prepare("SELECT * FROM autopilot_state WHERE id = 1").get(),
  ).toEqual(fixture);
  reopened.db.close();
});

test("openDb adds nullable drift_behind_threshold + drift_age_threshold_days to autopilot_state (fn-1252 task .3)", () => {
  // The v118->v119 step adds the two durable base-drift threshold config
  // columns — both INTEGER, nullable, NO default (the NULL=absent + re-fold
  // byte-identity invariant). A bare-inserted row reads NULL for both (the
  // OFF/no-detection default).
  const { db } = openDb(":memory:");
  const stateCols = db.prepare("PRAGMA table_info(autopilot_state)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  for (const name of [
    "drift_behind_threshold",
    "drift_age_threshold_days",
  ] as const) {
    const col = stateCols.find((c) => c.name === name);
    expect(col).toBeDefined();
    expect(col?.type).toBe("INTEGER");
    expect(col?.notnull).toBe(0);
    expect(col?.dflt_value).toBeNull();
  }
  db.prepare(
    "INSERT INTO autopilot_state (id, paused, last_event_id, created_at, updated_at) VALUES (1, 1, 0, 1, 1)",
  ).run();
  const s = db
    .prepare(
      "SELECT drift_behind_threshold, drift_age_threshold_days FROM autopilot_state WHERE id = 1",
    )
    .get() as {
    drift_behind_threshold: number | null;
    drift_age_threshold_days: number | null;
  };
  expect(s.drift_behind_threshold).toBeNull();
  expect(s.drift_age_threshold_days).toBeNull();
  db.close();
});

test("a from-scratch re-fold over zero handoff or Durable await Events leaves both Projections empty", () => {
  const { db } = openDb(dbPath);
  drainAll(db);
  for (const table of ["handoffs", "awaits"]) {
    const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
      n: number;
    };
    expect(count.n).toBe(0);
  }
  db.close();
});

test("all expected indexes are present", () => {
  const { db } = openDb(":memory:");
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all() as { name: string }[];
  const names = new Set(indexes.map((i) => i.name));
  const required = [
    "idx_events_session",
    "idx_events_hook_event",
    "idx_events_ts",
    "idx_events_pid_hook_tool",
    "idx_events_subagent_agent_id",
    "idx_jobs_created_state",
    "idx_events_plan_epic",
    "idx_events_plan_target",
    // fn-649: attribution-fold perf indexes (covering variants — the prior
    // key-only idx_events_tool_file_path / idx_events_bash_mutation_kind are
    // dropped in the migrate tail and replaced by these).
    "idx_events_hook_tool_ts",
    "idx_events_tool_attr",
    "idx_events_bash_attr",
    "idx_events_bashwin_pre",
    "idx_events_bashwin_post",
    "idx_events_package_attr_window",
  ];
  for (const name of required) {
    expect(names.has(name)).toBe(true);
  }
  // fn-765.3: three dead events indexes were dropped (removed from
  // CREATE_EVENTS_INDEXES + DROP IF EXISTS in the migrate tail) — a fresh DB
  // must never carry them. idx_events_event_type / idx_events_tool_name are
  // grep-verified consumer-less; idx_events_hook_tool is EXPLAIN-verified dead
  // (the inferred-attribution self-join rides idx_events_bashwin_pre/_post).
  for (const gone of [
    "idx_events_event_type",
    "idx_events_tool_name",
    "idx_events_hook_tool",
  ]) {
    expect(names.has(gone)).toBe(false);
  }
  db.close();
});

test("idx_events_hook_event serves the Commit trailer scan after the fn-765.3 drops", () => {
  // fn-765.3: idx_events_hook_tool (the (hook_event, tool_name) composite) was
  // dropped. The single-scan `Commit` trailer loader (loadAllCommitTrailerFacts,
  // reducer.ts) filters `WHERE hook_event = 'Commit'` and orders by id — the
  // surviving single-column idx_events_hook_event must still SEARCH it with no
  // full-table SCAN. (EXPLAIN confirmed dropping hook_event too would fall the
  // scan back onto the composite + a USE TEMP B-TREE FOR ORDER BY regression,
  // which is why hook_event is kept.) No `json_extract` rides the WHERE anymore
  // — every survivor parses in JS — so the index serves the bare scan directly.
  // Post-shed (fn-836.4) the scan reads `events.data` inline — no
  // `COALESCE(events.data, event_blobs.data)` / `LEFT JOIN event_blobs`.
  const { db } = openDb(":memory:");
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN
         SELECT events.data AS data
           FROM events
          WHERE hook_event = 'Commit'
          ORDER BY events.id ASC`,
    )
    .all() as { detail: string }[];
  const detail = plan.map((r) => r.detail).join(" | ");
  expect(detail).toContain("idx_events_hook_event");
  expect(detail).not.toContain("SCAN events");
  // The dropped composite must be gone so the planner can't pick it.
  expect(detail).not.toContain("idx_events_hook_tool");
  db.close();
});

test("idx_events_tool_attr makes the explicit-attribution tool scan COVERING", () => {
  // fn-649 follow-up: findExplicitAttributions matches this exact json_extract
  // expression per dirty file and SELECTs id,ts,session_id,tool_name. The
  // covering index carries all of them so the planner never reads a data page —
  // the key-only predecessor was a SEEK but faulted one cold page per match,
  // regressing PASS 1 to ~4.5s/file under concurrent load.
  const { db } = openDb(":memory:");
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN
         SELECT id, ts, session_id, tool_name FROM events
          WHERE hook_event = 'PostToolUse'
            AND tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')
            AND json_extract(data, '$.tool_input.file_path') = ?`,
    )
    .all("/x") as { detail: string }[];
  const detail = plan.map((r) => r.detail).join(" | ");
  expect(detail).toContain("idx_events_tool_attr");
  expect(detail).toContain("USING COVERING INDEX");
  expect(detail).not.toContain("SCAN events");
  // The retired key-only index must be gone so the planner can't pick it.
  expect(detail).not.toContain("idx_events_tool_file_path");
  db.close();
});

test("idx_events_bash_attr makes the explicit-attribution bash scan COVERING", () => {
  // fn-649 follow-up: the bash scan filters bash_mutation_kind IS NOT NULL,
  // expands json_each(bash_mutation_targets), SELECTs id,ts,session_id,kind.
  // Covering means no per-row table read even under concurrent I/O.
  const { db } = openDb(":memory:");
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN
         SELECT e.id, e.ts, e.session_id, e.bash_mutation_kind
           FROM events e
          WHERE e.bash_mutation_kind IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM json_each(e.bash_mutation_targets) j WHERE j.value = ?
            )`,
    )
    .all("/x") as { detail: string }[];
  const detail = plan.map((r) => r.detail).join(" | ");
  expect(detail).toContain("USING COVERING INDEX idx_events_bash_attr");
  expect(detail).not.toContain("idx_events_bash_mutation_kind");
  db.close();
});

test("busyTimeoutMs option overrides the default and is set before WAL", () => {
  // fn-649: the hook passes 1200 so the journal_mode=WAL switch waits within
  // its budget instead of failing instantly under contention.
  const { db } = openDb(dbPath, { busyTimeoutMs: 1200 });
  const busy = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
  expect(busy.timeout).toBe(1200);
  // WAL still took effect (the reordered pragma sequence is intact).
  const journal = db.prepare("PRAGMA journal_mode").get() as {
    journal_mode: string;
  };
  expect(journal.journal_mode).toBe("wal");
  db.close();
});

test("connection-local PRAGMAs are applied on every open", () => {
  const { db } = openDb(dbPath);
  // journal_mode returns the active mode; on a brand-new DB the first
  // call to PRAGMA journal_mode = WAL flips it to wal persistently.
  const journal = db.prepare("PRAGMA journal_mode").get() as {
    journal_mode: string;
  };
  expect(journal.journal_mode).toBe("wal");

  const busy = db.prepare("PRAGMA busy_timeout").get() as {
    timeout: number;
  };
  expect(busy.timeout).toBe(5000);

  const fk = db.prepare("PRAGMA foreign_keys").get() as {
    foreign_keys: number;
  };
  expect(fk.foreign_keys).toBe(1);

  const sync = db.prepare("PRAGMA synchronous").get() as {
    synchronous: number;
  };
  // 1 == NORMAL
  expect(sync.synchronous).toBe(1);

  // fn-649: mmap is enabled (clamped to SQLite's compile-time max, but > 0)
  // so folds touching cold pages don't pay read() syscalls on the ~850MB log.
  const mmap = db.prepare("PRAGMA mmap_size").get() as { mmap_size: number };
  expect(mmap.mmap_size).toBeGreaterThan(0);
  db.close();
});

test("readonly: true opens a read-only connection", () => {
  // Seed the DB once with a writer.
  const writer = openDb(dbPath);
  writer.db.close();

  // Open read-only and confirm writes fail.
  const reader = openDb(dbPath, { readonly: true });
  expect(() => {
    reader.db.run(
      "INSERT INTO jobs (job_id, created_at, updated_at) VALUES ('x', 0, 0)",
    );
  }).toThrow();
  reader.db.close();
});

test("migrate: false skips schema convergence but still applies PRAGMAs + prepareStmts", () => {
  // Phase 1 — daemon-style open performs migration + seeds the schema.
  const writer = openDb(dbPath);
  writer.db.close();

  // Phase 2 — hook-style reopen against the now-migrated DB with migrate
  // skipped. PRAGMAs are connection-local so they MUST still run; the
  // prepared `insertEvent` statement MUST still build against the live
  // schema. This is the contract `plugins/keeper/plugin/hooks/events-writer.ts` relies on.
  const hookOpen = openDb(dbPath, { migrate: false });

  const busy = hookOpen.db.prepare("PRAGMA busy_timeout").get() as {
    timeout: number;
  };
  expect(busy.timeout).toBe(5000);

  // The prepared insertEvent stmt must succeed against the live schema.
  hookOpen.stmts.insertEvent.run({
    $ts: 1,
    $session_id: "sess-migrate-false",
    $pid: null,
    $hook_event: "SessionStart",
    $event_type: "session_start",
    $tool_name: null,
    $matcher: null,
    $cwd: null,
    $permission_mode: null,
    $agent_id: null,
    $agent_type: null,
    $stop_hook_active: null,
    $data: "{}",
    $subagent_agent_id: null,
    $spawn_name: null,
    $start_time: null,
    $slash_command: null,
    $skill_name: null,
    $plan_op: null,
    $plan_target: null,
    $plan_epic_id: null,
    $plan_task_id: null,
    $plan_subject_present: null,
    $tool_use_id: null,
    $config_dir: null,
    $bash_mutation_kind: null,
    $bash_mutation_targets: null,
    $plan_files: null,
    $backend_exec_type: null,
    $backend_exec_session_id: null,
    $backend_exec_pane_id: null,
  });

  const count = (
    hookOpen.db.prepare("SELECT COUNT(*) AS n FROM events").get() as {
      n: number;
    }
  ).n;
  expect(count).toBe(1);

  hookOpen.db.close();
});

test("migrate: false against an empty DB fails to prepare (hook outer-guard tolerates)", () => {
  // The hook's contract: if the daemon has never booted, the schema does
  // not exist, `prepareStmts` throws on the missing `events` table, and the
  // outer try/catch in `events-writer.ts` swallows + exits 0. This negative
  // test pins that failure mode so a future refactor cannot silently make
  // the hook self-migrate.
  const freshDbPath = join(tmpDir, "fresh-empty.db");
  let threw = false;
  try {
    openDb(freshDbPath, { migrate: false });
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
});

test("migrate: false against a stale schema fails on a column-binding error (hook outer-guard tolerates)", () => {
  // The companion negative case to the empty-DB test above. CLAUDE.md's
  // migration invariant: "A hook arriving against a missing OR STALE schema
  // fails its INSERT and exits 0." Empty-DB hits a "no such table: events"
  // path in prepareStmts. The stale-schema case — events table present but
  // newer columns absent — hits a DIFFERENT path: prepareStmts succeeds for
  // statements that don't touch the missing columns, but the insertEvent
  // prepare itself fails because the INSERT names columns the live schema
  // doesn't have. The hook's outer try/catch swallows either failure and
  // exits 0; this test pins the column-binding flavor so a future schema
  // bump can't silently make the hook self-migrate or mask the failure.
  const staleDbPath = join(tmpDir, "stale-schema.db");
  // Hand-roll an older events table that omits at least one column
  // insertEvent's INSERT statement names — here, tool_use_id, config_dir,
  // plus the plan_* envelope columns. This is the shape a keeper DB last
  // migrated several schema versions ago would present to a freshly-built
  // hook binary.
  const seed = new Database(staleDbPath, { create: true });
  seed.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      matcher TEXT,
      cwd TEXT,
      permission_mode TEXT,
      agent_id TEXT,
      agent_type TEXT,
      stop_hook_active INTEGER,
      data TEXT,
      subagent_agent_id TEXT,
      spawn_name TEXT,
      start_time INTEGER,
      slash_command TEXT,
      skill_name TEXT
    )
  `);
  seed.close();

  let error: unknown = null;
  try {
    openDb(staleDbPath, { migrate: false });
  } catch (err) {
    error = err;
  }
  expect(error).not.toBeNull();
  const message = String((error as Error).message ?? error);
  // The failure mode must be DISTINCT from the missing-table error in the
  // test above ("no such table: events"). A stale-schema open trips on a
  // missing column reference during prepareStmts' INSERT prepare.
  expect(message).not.toMatch(/no such table/i);
  expect(message).toMatch(/no such column|has no column/i);
});

test("readonly open against a stale schema does NOT prepare the write bundle (schema-bump-deploy-skew window)", () => {
  // The schema-bump-deploy-skew window: a new `keeper` binary whose static
  // `insertEvent` names a column the sole-migrator daemon hasn't yet added to
  // the on-disk DB. A READER (commit-work attribution, the history CLIs, the
  // workers) must open that live DB cleanly — the static write statement is
  // never relevant to a readonly connection, so `openDb({ readonly: true })`
  // must SKIP `prepareStmts` and hand back the throwing stub. Without this a
  // post-bump `keeper commit-work` throws "no such column" on every host until
  // keeperd restarts. Companion to the `migrate: false` (hook write-path) test
  // above, which still throws — only the readonly reader path is exempted.
  const staleDbPath = join(tmpDir, "stale-readonly.db");
  const seed = new Database(staleDbPath, { create: true });
  // WAL mode, matching a real live keeper DB (the daemon sets it) — a readonly
  // open still runs applyPragmas, and `PRAGMA journal_mode=WAL` is a no-op once
  // the file is already WAL but errors on a fresh rollback-journal DB opened
  // readonly. The production reader always meets an already-WAL DB.
  seed.run("PRAGMA journal_mode = WAL");
  // Minimal pre-bump events shape (omits mutation_path + many later columns)
  // plus the reducer_state row a reader actually reads.
  seed.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL, session_id TEXT NOT NULL, hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL, data TEXT
    )
  `);
  seed.run(
    "CREATE TABLE reducer_state (id INTEGER PRIMARY KEY, last_event_id INTEGER NOT NULL DEFAULT 0)",
  );
  seed.run("INSERT INTO reducer_state (id, last_event_id) VALUES (1, 7)");
  seed.close();

  // The open itself must NOT throw (pre-fix it died in prepareStmts' INSERT).
  const { db, stmts } = openDb(staleDbPath, { readonly: true });
  try {
    // The connection is fully usable for ad-hoc reads against the live shape.
    const row = db
      .prepare("SELECT last_event_id FROM reducer_state WHERE id = 1")
      .get() as { last_event_id: number };
    expect(row.last_event_id).toBe(7);
    // The write bundle is the throwing stub — a reader never touches it, and
    // accessing it is a programming error, not a silent no-op.
    expect(() => stmts.insertEvent).toThrow(/statement bundle is unavailable/);
  } finally {
    db.close();
  }
});

// ===========================================================================
// fn-785 — worker open boot-race hardening: prepareStmts:false + bootRetry.
// ===========================================================================

test("prepareStmts:false opens a usable connection but stmts access throws the stub", () => {
  // The 12 worker open sites pass prepareStmts:false because they destructure
  // {db} only and never touch stmts; this is the first LIVE production caller
  // class. The connection must work for queries while ANY stmts access fails
  // loud (a worker reading stmts would be a programming error).
  const writer = openDb(dbPath);
  writer.db.close();

  const { db, stmts } = openDb(dbPath, {
    readonly: true,
    prepareStmts: false,
  });
  try {
    // Connection is fully usable for ad-hoc queries.
    const row = db
      .prepare("SELECT last_event_id FROM reducer_state WHERE id = 1")
      .get() as { last_event_id: number };
    expect(row.last_event_id).toBe(0);

    // Both prepared statements are throwing stubs.
    expect(() => stmts.insertEvent).toThrow(/statement bundle is unavailable/);
    expect(() => stmts.selectWorldRev).toThrow(
      /statement bundle is unavailable/,
    );
  } finally {
    db.close();
  }
});

test("isTransientBootOpenError classifies the boot class, not arbitrary errors", () => {
  // The boot classifier is PRIVATE to openDb's retry but exported for a direct
  // unit test of the class boundary. Retryable: BUSY/LOCKED/CANTOPEN by code,
  // 5/6 by errno, "no such table"/"no such column" by message.
  expect(isTransientBootOpenError({ code: "SQLITE_BUSY" })).toBe(true);
  expect(isTransientBootOpenError({ code: "SQLITE_LOCKED" })).toBe(true);
  expect(isTransientBootOpenError({ code: "SQLITE_CANTOPEN" })).toBe(true);
  expect(isTransientBootOpenError({ errno: 5 })).toBe(true);
  expect(isTransientBootOpenError({ errno: 6 })).toBe(true);
  expect(isTransientBootOpenError(new Error("no such table: events"))).toBe(
    true,
  );
  expect(
    isTransientBootOpenError(new Error("no such column: planctl_files")),
  ).toBe(true);

  // NOT retryable: corruption, foreign-key, generic errors, non-objects.
  expect(isTransientBootOpenError({ code: "SQLITE_CORRUPT" })).toBe(false);
  expect(isTransientBootOpenError(new Error("disk I/O error"))).toBe(false);
  expect(isTransientBootOpenError(null)).toBe(false);
  expect(isTransientBootOpenError("no such table")).toBe(false);
});

test("bootRetry recovers a transient boot failure on a later attempt", () => {
  // Reproduces the worker-spawn race deterministically: a writer open against a
  // fresh empty DB with migrate:false + prepareStmts:true throws "no such
  // table: events" while the schema is absent. The _beforeAttempt seam migrates
  // the DB on attempt 2, so the SAME open span succeeds on retry.
  const freshDbPath = join(tmpDir, "boot-retry-recover.db");
  const seenAttempts: number[] = [];

  const { db } = openDb(freshDbPath, {
    migrate: false,
    bootRetry: { attempts: 4, baseMs: 1 },
    _beforeAttempt: (n) => {
      seenAttempts.push(n);
      if (n === 2) {
        // Converge the schema out-of-band so attempt 2's prepareStmts succeeds.
        openDb(freshDbPath).db.close();
      }
    },
  });
  try {
    // Attempt 1 failed (no schema), attempt 2 succeeded (schema present).
    expect(seenAttempts).toEqual([1, 2]);
    const row = db
      .prepare("SELECT last_event_id FROM reducer_state WHERE id = 1")
      .get() as { last_event_id: number };
    expect(row.last_event_id).toBe(0);
  } finally {
    db.close();
  }
});

test("bootRetry rethrows the transient error after exhausting attempts", () => {
  // The fail-loud contract: bounded retry, then RETHROW so the worker's
  // exit-1 → fatalExit → LaunchAgent path engages. The schema is never created,
  // so every attempt throws "no such table"; after N attempts it propagates.
  const freshDbPath = join(tmpDir, "boot-retry-exhaust.db");
  const seenAttempts: number[] = [];

  let error: unknown = null;
  try {
    openDb(freshDbPath, {
      migrate: false,
      bootRetry: { attempts: 3, baseMs: 1 },
      _beforeAttempt: (n) => seenAttempts.push(n),
    });
  } catch (err) {
    error = err;
  }
  expect(error).not.toBeNull();
  expect(String((error as Error).message)).toMatch(/no such table/i);
  // Exactly N attempts, no more.
  expect(seenAttempts).toEqual([1, 2, 3]);
});

test("bootRetry preserves caller options verbatim across attempts", () => {
  // Per-attempt the driver re-runs the WHOLE span with the SAME options — the
  // server-worker's writer open (migrate:false) must keep migrate:false on
  // every retry. A readonly+prepareStmts:false caller must stay readonly with a
  // stub stmts bundle after a transient retry.
  const freshDbPath = join(tmpDir, "boot-retry-options.db");

  const { db, stmts } = openDb(freshDbPath, {
    readonly: true,
    prepareStmts: false,
    bootRetry: { attempts: 4, baseMs: 1 },
    _beforeAttempt: (n) => {
      // The readonly open fails on attempt 1 (no file/schema); create the DB on
      // attempt 2 so the readonly retry succeeds against a real file.
      if (n === 2) openDb(freshDbPath).db.close();
    },
  });
  try {
    // readonly honored: a write fails at the SQLite layer.
    expect(() =>
      db.query("INSERT INTO meta (key, value) VALUES ('x','y')").run(),
    ).toThrow();
    // prepareStmts:false honored: stub still in place after the retry.
    expect(() => stmts.insertEvent).toThrow(/statement bundle is unavailable/);
  } finally {
    db.close();
  }
});

test("reducer_state row (1, 0, ts) is seeded on first open", () => {
  const { db } = openDb(":memory:");
  const row = db
    .prepare("SELECT id, last_event_id, updated_at FROM reducer_state")
    .get() as { id: number; last_event_id: number; updated_at: number } | null;
  expect(row).not.toBeNull();
  expect(row?.id).toBe(1);
  expect(row?.last_event_id).toBe(0);
  expect(typeof row?.updated_at).toBe("number");
  db.close();
});

test("second openDb is a no-op (idempotent migration)", () => {
  const first = openDb(dbPath);
  // Bump the cursor so we can prove the second open doesn't reset it.
  first.db
    .prepare("UPDATE reducer_state SET last_event_id = 42 WHERE id = 1")
    .run();
  first.db.close();

  const second = openDb(dbPath);
  const row = second.db
    .prepare("SELECT last_event_id FROM reducer_state WHERE id = 1")
    .get() as { last_event_id: number };
  expect(row.last_event_id).toBe(42);
  second.db.close();
});

test("KEEPER_DB env var overrides default path", () => {
  const original = process.env.KEEPER_DB;
  try {
    process.env.KEEPER_DB = dbPath;
    expect(resolveDbPath()).toBe(dbPath);

    delete process.env.KEEPER_DB;
    const fallback = resolveDbPath();
    expect(fallback.endsWith("/.local/state/keeper/keeper.db")).toBe(true);
  } finally {
    if (original === undefined) {
      delete process.env.KEEPER_DB;
    } else {
      process.env.KEEPER_DB = original;
    }
  }
});

test("schema_version is stamped in meta", () => {
  const { db } = openDb(":memory:");
  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(row.value).toBe(String(SCHEMA_VERSION));
  db.close();
});

test("openDb refuses to downgrade a DB stamped newer than this binary (fn-762.3)", () => {
  // Migrate a current DB, then hand-stamp its meta schema_version one ahead of
  // the binary — the shape a host left behind after a newer keeperd migrated it.
  const downgradePath = join(tmpDir, "newer-schema.db");
  const seeded = openDb(downgradePath);
  seeded.db
    .prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'")
    .run(String(SCHEMA_VERSION + 1));
  seeded.db.close();

  let error: unknown = null;
  try {
    openDb(downgradePath);
  } catch (err) {
    error = err;
  }
  // The guard throws BEFORE the migrate transaction — a hard, loud crash.
  expect(error).not.toBeNull();
  const message = String((error as Error).message ?? error);
  // Both versions named, plus the remediation, so the operator knows exactly
  // what to do.
  expect(message).toContain(`v${SCHEMA_VERSION + 1}`);
  expect(message).toContain(`v${SCHEMA_VERSION}`);
  expect(message).toMatch(/refusing to run rather than silently downgrade/);

  // The stamp is unchanged — the guard precedes the unconditional meta stamp,
  // so the newer version was never regressed to the binary's version.
  const after = new Database(downgradePath, { readonly: true });
  const stamp = after
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(stamp.value).toBe(String(SCHEMA_VERSION + 1));
  after.close();
});

test("autopilot_state has a NOT NULL mode column defaulting 'yolo'; armed_epics presence table exists (fn-751 v62)", () => {
  const { db } = openDb(":memory:");
  // The `mode` column is NOT NULL with DEFAULT 'yolo' (the zero-event /
  // work-everything baseline). Lockstep ALTER-vs-CREATE: the bootstrap CREATE
  // and the migration ALTER literal byte-match, so the column shape is
  // identical on a fresh DB and an upgraded one.
  const stateCols = db.prepare("PRAGMA table_info(autopilot_state)").all() as {
    name: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const mode = stateCols.find((c) => c.name === "mode");
  expect(mode).toBeDefined();
  expect(mode?.notnull).toBe(1);
  expect(mode?.dflt_value).toBe("'yolo'");

  // The NOT NULL DEFAULT is what lets the daemon's boot re-arm (which INSERTs
  // paused FIRST and binds no `mode`) satisfy the constraint. Prove it: an
  // INSERT that omits `mode` reads 'yolo'.
  db.prepare(
    "INSERT INTO autopilot_state (id, paused, last_event_id, created_at, updated_at) VALUES (1, 1, 0, 1, 1)",
  ).run();
  const r = db
    .prepare("SELECT mode FROM autopilot_state WHERE id = 1")
    .get() as { mode: string };
  expect(r.mode).toBe("yolo");

  // The armed_epics presence table exists with the right column shape.
  const armedCols = db.prepare("PRAGMA table_info(armed_epics)").all() as {
    name: string;
    pk: number;
  }[];
  expect(armedCols.map((c) => c.name)).toEqual([
    "epic_id",
    "last_event_id",
    "created_at",
    "updated_at",
  ]);
  expect(armedCols.find((c) => c.name === "epic_id")?.pk).toBe(1);
  // Zero-event projection: empty.
  const count = (
    db.prepare("SELECT COUNT(*) AS n FROM armed_epics").get() as { n: number }
  ).n;
  expect(count).toBe(0);
  db.close();
});

test("autopilot_state has a nullable max_concurrent_per_root column (NULL = the in-memory default) (fn-954 v90)", () => {
  const { db } = openDb(":memory:");
  const stateCols = db.prepare("PRAGMA table_info(autopilot_state)").all() as {
    name: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const col = stateCols.find((c) => c.name === "max_concurrent_per_root");
  expect(col).toBeDefined();
  // Nullable, no SQL default — NULL is the "never set" state the reconciler /
  // board resolve `?? DEFAULT_MAX_CONCURRENT_PER_ROOT` (= 1).
  expect(col?.notnull).toBe(0);
  expect(col?.dflt_value).toBeNull();

  // An INSERT that omits the column lands NULL (the lazy-materialize default).
  db.prepare(
    "INSERT INTO autopilot_state (id, paused, last_event_id, created_at, updated_at) VALUES (1, 1, 0, 1, 1)",
  ).run();
  const r = db
    .prepare("SELECT max_concurrent_per_root FROM autopilot_state WHERE id = 1")
    .get() as { max_concurrent_per_root: number | null };
  expect(r.max_concurrent_per_root).toBeNull();
  db.close();
});

test("autopilot_state has a nullable worktree_mode column (NULL = OFF, the default) (fn-959 v91)", () => {
  const { db } = openDb(":memory:");
  const stateCols = db.prepare("PRAGMA table_info(autopilot_state)").all() as {
    name: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const col = stateCols.find((c) => c.name === "worktree_mode");
  expect(col).toBeDefined();
  // Nullable, no SQL default — NULL/absent is OFF, the byte-identical
  // no-worktree behavior the reconciler resolves `?? OFF` at read time.
  expect(col?.notnull).toBe(0);
  expect(col?.dflt_value).toBeNull();

  // An INSERT that omits the column lands NULL (the lazy-materialize OFF default).
  db.prepare(
    "INSERT INTO autopilot_state (id, paused, last_event_id, created_at, updated_at) VALUES (1, 1, 0, 1, 1)",
  ).run();
  const r = db
    .prepare("SELECT worktree_mode FROM autopilot_state WHERE id = 1")
    .get() as { worktree_mode: number | null };
  expect(r.worktree_mode).toBeNull();
  db.close();
});

test("autopilot_state has a nullable TEXT worker_provider column (NULL = unconstrained, the default) (fn-1256, re-appended at v121)", () => {
  const { db } = openDb(":memory:");
  const stateCols = db.prepare("PRAGMA table_info(autopilot_state)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const col = stateCols.find((c) => c.name === "worker_provider");
  expect(col).toBeDefined();
  expect(col?.type).toBe("TEXT");
  // Nullable, no SQL default — NULL/absent is unconstrained, the byte-identical
  // default the producer resolves at read time.
  expect(col?.notnull).toBe(0);
  expect(col?.dflt_value).toBeNull();

  // An INSERT that omits the column lands NULL (the lazy-materialize default).
  db.prepare(
    "INSERT INTO autopilot_state (id, paused, last_event_id, created_at, updated_at) VALUES (1, 1, 0, 1, 1)",
  ).run();
  const r = db
    .prepare("SELECT worker_provider FROM autopilot_state WHERE id = 1")
    .get() as { worker_provider: string | null };
  expect(r.worker_provider).toBeNull();
  db.close();
});

test("the v122 backfill renames the durable worker_provider family label 'codex' → 'gpt' (docs/adr/0047 amendment)", () => {
  // Seed a pre-v122 DB carrying the retired 'codex' family label on the
  // autopilot_state singleton, then reopen through migrate() and assert the
  // v121→v122 backfill rewrote the already-materialized column to 'gpt' — the
  // durable column no re-fold touches (the reducer fold normalizes the same
  // alias for re-fold determinism).
  const { db: seed } = openDb(dbPath);
  seed.run("UPDATE meta SET value = '121' WHERE key = 'schema_version'");
  seed
    .prepare(
      "INSERT INTO autopilot_state (id, paused, last_event_id, created_at, updated_at, worker_provider) VALUES (1, 1, 0, 1, 1, 'codex')",
    )
    .run();
  seed.close();

  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));
  const r = db
    .prepare("SELECT worker_provider FROM autopilot_state WHERE id = 1")
    .get() as { worker_provider: string | null };
  expect(r.worker_provider).toBe("gpt");
  db.close();
});

test("the v113 rewind supersedes the v91→v92 backend_exec terminal-clear data-fix; hand-seeded (event-less) jobs do not survive the rewind (fn-977 v92, fn-1164 v113)", () => {
  // The v91→v92 migration was a ONE-TIME data-fix UPDATE: NULL backend_exec
  // pane/generation on EXISTING terminal jobs so a dead job stops holding a
  // tmux-recyclable pane id. The v113 REWINDING migration (fn-1164) wipes the
  // whole deterministic `jobs` projection and re-derives it purely by replay, so
  // the v92 data-fix is SUPERSEDED for any DB migrating through v113: a
  // directly-seeded job row (no backing events) is DELETEd by the rewind and
  // never rebuilt. The terminal-clear INVARIANT the v92 fix protected is now
  // re-derived on every re-fold by the reducer's SessionEnd/Killed arms — proven
  // directly by the reducer-projections tests "SessionEnd/Killed NULLs the
  // backend_exec pane + generation coords (recycle guard)".
  const { db: seed } = openDb(dbPath);
  seed.run("UPDATE meta SET value = '91' WHERE key = 'schema_version'");
  const ins = (
    jobId: string,
    state: string,
    pane: string | null,
    gen: string | null,
  ) =>
    seed
      .prepare(
        `INSERT INTO jobs (job_id, created_at, updated_at, state, backend_exec_type,
                           backend_exec_pane_id, backend_exec_generation_id)
         VALUES (?, 1, 1, ?, 'tmux', ?, ?)`,
      )
      .run(jobId, state, pane, gen);
  ins("mig-ended", "ended", "%300", "gen-dead-a");
  ins("mig-live", "working", "%300", "gen-live");
  seed.close();

  // Reopen → migrate() runs the v92 data-fix, then the v113 rewind DELETEs the
  // deterministic jobs projection. There are no events to re-fold, so the
  // directly-seeded rows are gone.
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  const jobCount = (
    db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }
  ).n;
  expect(jobCount).toBe(0);
  // The cursor was rewound to 0 by the v113 rewinding migration.
  const cursor = (
    db
      .prepare("SELECT last_event_id FROM reducer_state WHERE id = 1")
      .get() as { last_event_id: number }
  ).last_event_id;
  expect(cursor).toBe(0);
  db.close();
});

test("events has a nullable spawn_name column; jobs has a nullable title_source column", () => {
  const { db } = openDb(":memory:");
  const eventCols = db.prepare("PRAGMA table_info(events)").all() as {
    name: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const spawnName = eventCols.find((c) => c.name === "spawn_name");
  expect(spawnName).toBeDefined();
  expect(spawnName?.notnull).toBe(0);
  expect(spawnName?.dflt_value).toBeNull();

  const jobCols = db.prepare("PRAGMA table_info(jobs)").all() as {
    name: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const titleSource = jobCols.find((c) => c.name === "title_source");
  expect(titleSource).toBeDefined();
  expect(titleSource?.notnull).toBe(0);
  expect(titleSource?.dflt_value).toBeNull();
  db.close();
});

test("jobs has a nullable title column and no mode/title_history columns", () => {
  const { db } = openDb(":memory:");
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as {
    name: string;
    dflt_value: string | null;
    notnull: number;
  }[];
  const names = cols.map((c) => c.name);
  const title = cols.find((c) => c.name === "title");
  expect(title).toBeDefined();
  expect(title?.notnull).toBe(0); // nullable
  // mode + title_history are retired — neither column exists.
  expect(names).not.toContain("mode");
  expect(names).not.toContain("title_history");
  // A fresh row reads the zero-event default: title NULL.
  db.prepare(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at) VALUES ('z', 1, 0, 1)",
  ).run();
  const r = db.prepare("SELECT title FROM jobs WHERE job_id = 'z'").get() as {
    title: string | null;
  };
  expect(r.title).toBeNull();
  db.close();
});

test("v73→v74 shed: relocated shed-class mutation_path captured from event_blobs before DROP", () => {
  // Regression for the fn-836.4 hardening: the destructive v74 shed must capture
  // a RELOCATED shed-class row's `tool_input.file_path` into `mutation_path` from
  // `event_blobs` BEFORE dropping the table. The runtime backfill pass reads only
  // inline `events.data` (post-shed there is no side table), so a relocated body
  // (`data IS NULL`, file_path only in `event_blobs`, `mutation_path` NULL) is
  // unrecoverable once dropped — the exact shape a from-scratch 0→v74 migrate
  // hits before that runtime pass has ever run.

  // Build a v74 DB, then rewind it to the v73-with-event_blobs state the shed
  // migrates FROM.
  {
    const { db } = openDb(dbPath);
    db.run(
      `INSERT INTO events (ts, session_id, hook_event, event_type, tool_name, data)
       VALUES (1, 's1', 'PostToolUse', 'tool_use', 'Edit',
               '{"tool_input":{"file_path":"/repo/shed.ts"}}')`,
    );
    db.run(
      `INSERT INTO events (ts, session_id, hook_event, event_type, tool_name, data)
       VALUES (2, 's1', 'PostToolUse', 'tool_use', 'Bash',
               '{"tool_response":{"stdout":"keep-me"}}')`,
    );
    db.close();
  }
  {
    const raw = new Database(dbPath);
    raw.run(
      "CREATE TABLE IF NOT EXISTS event_blobs (event_id INTEGER PRIMARY KEY, data TEXT NOT NULL)",
    );
    // Relocate every body into event_blobs, NULL the inline data + shed-class
    // mutation_path, and stamp version 73 — the pre-shed shape.
    raw.run(
      "INSERT INTO event_blobs (event_id, data) SELECT id, data FROM events WHERE data IS NOT NULL",
    );
    raw.run("UPDATE events SET data = NULL, mutation_path = NULL");
    raw.run("UPDATE meta SET value = '73' WHERE key = 'schema_version'");
    raw.close();
  }

  // Re-migrate 73→74: restore keep-set inline, capture shed-class mutation_path
  // from event_blobs, then DROP.
  const { db } = openDb(dbPath);
  const ver = (
    db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    }
  ).value;
  const shed = db
    .prepare("SELECT data, mutation_path FROM events WHERE tool_name = 'Edit'")
    .get() as { data: string | null; mutation_path: string | null };
  const keep = db
    .prepare("SELECT data FROM events WHERE tool_name = 'Bash'")
    .get() as { data: string | null };
  const blobsGone =
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='event_blobs'",
        )
        .get() as { n: number }
    ).n === 0;
  db.close();

  expect(ver).toBe(String(SCHEMA_VERSION));
  // shed-class: file_path captured into mutation_path BEFORE the DROP; body shed.
  expect(shed.mutation_path).toBe("/repo/shed.ts");
  expect(shed.data).toBeNull();
  // keep-class: body restored inline.
  expect(keep.data).toBe('{"tool_response":{"stdout":"keep-me"}}');
  // side table dropped.
  expect(blobsGone).toBe(true);
});

test("v77 rewind wipes file_attributions (no surviving 'plan' or 'tool' seed rows)", () => {
  // As of v77 (fn-856) the migration rewinds the cursor and wipes the canonical
  // projection list, which includes `file_attributions` — so a seeded row (with
  // no backing event to re-fold it) does not survive to the migrated end state.
  // (The fn-831 v74→v75 step that once rewrote `source='planctl'` → `'plan'` is
  // moot here: fn-889 v82 narrowed the CHECK to drop `'planctl'`, so the current
  // schema can no longer hold a `'planctl'` row to seed.) Build a current DB,
  // insert one plan row + one tool row, rewind to v74, re-migrate, and confirm
  // the table is empty + version stamped current.
  {
    const { db } = openDb(dbPath);
    db.run(
      `INSERT INTO file_attributions
         (project_dir, session_id, file_path, last_mutation_at, op, source,
          last_event_id, updated_at)
       VALUES ('/repo', 's1', '.planctl/epics/fn-1.json', 100, 'scaffold',
               'plan', 7, 100)`,
    );
    db.run(
      `INSERT INTO file_attributions
         (project_dir, session_id, file_path, last_mutation_at, op, source)
       VALUES ('/repo', 's1', 'src/x.ts', 50, 'edit', 'tool')`,
    );
    db.run("UPDATE meta SET value = '74' WHERE key = 'schema_version'");
    db.close();
  }

  // Re-migrate 74→current: the v77 rewind wipes file_attributions.
  const { db } = openDb(dbPath);
  const ver = (
    db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    }
  ).value;
  const total = (
    db.prepare("SELECT COUNT(*) AS n FROM file_attributions").get() as {
      n: number;
    }
  ).n;
  db.close();

  expect(ver).toBe(String(SCHEMA_VERSION));
  // The v77 rewind wiped every seeded row (neither the 'plan' nor the 'tool' row
  // survives — none had a backing event to re-fold).
  expect(total).toBe(0);
});

test("v3 DB migrates to v4: spawn_name + title_source added, rows preserved NULL", () => {
  // Build a v3-shaped DB by hand: events without spawn_name, jobs without
  // title_source, version '3'.
  const v3 = new Database(dbPath, { create: true });
  v3.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      matcher TEXT,
      cwd TEXT,
      permission_mode TEXT,
      agent_id TEXT,
      agent_type TEXT,
      stop_hook_active INTEGER,
      data TEXT NOT NULL,
      subagent_agent_id TEXT
    )
  `);
  v3.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT
    )
  `);
  v3.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v3.run("INSERT INTO meta (key, value) VALUES ('schema_version', '3')");
  v3.run(
    "INSERT INTO events (ts, session_id, hook_event, event_type, data) VALUES (1, 'sess', 'SessionStart', 'session_start', '{}')",
  );
  v3.run(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, title) VALUES ('old', 1, 5, 1, 'fix-osc')",
  );
  v3.close();

  // Reopen via openDb — migrate() runs the v3→v4 idempotent ADD COLUMNs (and on
  // through v11: the ALTER block isn't version-gated, so a v3 DB converges
  // straight to the current schema, stamping the current version). The v11
  // rewind-and-redrain wipes the projection; the daemon's boot drain rebuilds
  // it AFTER `openDb` returns — tests stand in for that drain explicitly.
  const { db } = openDb(dbPath);
  drainAll(db);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  const eventNames = (
    db.prepare("PRAGMA table_info(events)").all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  expect(eventNames).toContain("spawn_name");
  const jobNames = (
    db.prepare("PRAGMA table_info(jobs)").all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  expect(jobNames).toContain("title_source");

  // Existing event rows gain the new columns reading NULL; prior event data
  // is intact (the event log is never wiped, only re-folded).
  const ev = db
    .prepare(
      "SELECT session_id, spawn_name FROM events WHERE session_id = 'sess'",
    )
    .get() as { session_id: string; spawn_name: string | null };
  expect(ev.spawn_name).toBeNull();
  // Schema v11 rewind-and-redrain rebuilds the `jobs` projection from the
  // event log (the source of truth). The directly-inserted-by-the-test
  // legacy `old` row is wiped; the `sess` SessionStart event re-folds into
  // a fresh row. This is the v11 contract — hand-inserted jobs rows that
  // never had a backing event are now provably forgotten.
  const jobOld = db
    .prepare("SELECT title FROM jobs WHERE job_id = 'old'")
    .get() as { title: string | null } | null;
  expect(jobOld).toBeNull();
  const jobSess = db
    .prepare(
      "SELECT title, title_source, state FROM jobs WHERE job_id = 'sess'",
    )
    .get() as {
    title: string | null;
    title_source: string | null;
    state: string;
  } | null;
  expect(jobSess).not.toBeNull();
  expect(jobSess?.state).toBe("stopped");

  // Second open is idempotent — the ADD COLUMNs no-op on the now-current shape.
  db.close();
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe(String(SCHEMA_VERSION));
  db2.close();
});

test("v57→v58 rebuild relaxes events.data to nullable; rows + seq + indexes preserved", () => {
  // fn-717.2: the v57→v58 migration is a stop-the-world table rebuild that
  // relaxes `events.data` from NOT NULL to nullable (bun:sqlite blocks the
  // O(1) writable_schema edit). Build a genuine v57-shaped DB — current schema
  // EXCEPT `events.data NOT NULL` and version '57' — then reopen through
  // migrate() and assert: data is now nullable, every row preserved
  // byte-for-byte, the AUTOINCREMENT high-water preserved, and all events
  // indexes intact.

  // Build the current schema first (so every projection table + every index
  // exists), then downgrade ONLY the events.data constraint back to v57 shape.
  const built = openDb(dbPath);
  // Seed a couple of real events so the rebuild has rows to copy.
  built.db.run(
    "INSERT INTO events (ts, session_id, hook_event, event_type, tool_name, data) VALUES (1, 'sess-x', 'PostToolUse', 'post_tool_use', 'Write', ?)",
    [JSON.stringify({ tool_input: { file_path: "/repo/a.ts" } })],
  );
  built.db.run(
    "INSERT INTO events (ts, session_id, hook_event, event_type, data) VALUES (2, 'sess-x', 'Stop', 'stop', '{}')",
  );
  // Bump the AUTOINCREMENT high-water well past the live MAX(id) so we can
  // prove the rebuild PRESERVES it (rather than recomputing from MAX(id)).
  built.db.run("UPDATE sqlite_sequence SET seq = 9999 WHERE name = 'events'");

  // Capture the live events index set + the seeded rows for the post-migrate
  // comparison.
  const eventsIndexSqlBefore = built.db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='events' AND sql IS NOT NULL",
    )
    .all() as { name: string; sql: string }[];
  const indexNamesBefore = new Set(eventsIndexSqlBefore.map((r) => r.name));
  const rowsBefore = built.db
    .prepare("SELECT id, session_id, hook_event, data FROM events ORDER BY id")
    .all();

  // Downgrade: rebuild events with `data NOT NULL` and stamp version 57. This
  // reproduces the exact pre-fn-717.2 shape a v57 DB carried — including all
  // its indexes (recreated from the captured SQL) AND a CLEAN `event_blobs` FK
  // (`REFERENCES events`). Use the temp-new-table technique (NOT `RENAME TO
  // events_old`) with FK enforcement OFF, exactly so the downgraded v57 DB is
  // faithful to a real .1 DB — a `RENAME` here would rewrite event_blobs's FK
  // to `events_old` and produce a CORRUPT fixture that the migration-under-test
  // never sees in production.
  built.db.run("PRAGMA foreign_keys = OFF");
  built.db
    .transaction(() => {
      built.db.run(`
      CREATE TABLE events_dn (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts REAL NOT NULL, session_id TEXT NOT NULL, pid INTEGER,
        hook_event TEXT NOT NULL, event_type TEXT NOT NULL, tool_name TEXT,
        matcher TEXT, cwd TEXT, permission_mode TEXT, agent_id TEXT,
        agent_type TEXT, stop_hook_active INTEGER, data TEXT NOT NULL,
        subagent_agent_id TEXT, spawn_name TEXT, start_time TEXT,
        slash_command TEXT, skill_name TEXT, planctl_op TEXT,
        planctl_target TEXT, planctl_epic_id TEXT, planctl_task_id TEXT,
        planctl_subject_present INTEGER, tool_use_id TEXT, config_dir TEXT,
        planctl_queue_jump INTEGER, bash_mutation_kind TEXT,
        bash_mutation_targets TEXT, planctl_files TEXT, backend_exec_type TEXT,
        backend_exec_session_id TEXT, backend_exec_pane_id TEXT,
        background_task_id TEXT
      )
    `);
      // Explicit column list (NOT `SELECT *`): the live `events` carries the
      // v73 `mutation_path` column the faithful v57 fixture must NOT have, so a
      // `*` copy would mismatch `events_dn`'s arity. The seeded rows leave
      // `mutation_path` NULL anyway — it's a no-op for the rebuild fidelity proof.
      // `planctl_queue_jump` stays in the faithful v57 `events_dn` CREATE above
      // but is left unpopulated (NULL): the live `events` no longer carries the
      // column (v85 dropped `plan_queue_jump`), so the copy can't source it.
      built.db.run(`INSERT INTO events_dn (
        id, ts, session_id, pid, hook_event, event_type, tool_name, matcher,
        cwd, permission_mode, agent_id, agent_type, stop_hook_active, data,
        subagent_agent_id, spawn_name, start_time, slash_command, skill_name,
        planctl_op, planctl_target, planctl_epic_id, planctl_task_id,
        planctl_subject_present, tool_use_id, config_dir,
        bash_mutation_kind, bash_mutation_targets, planctl_files,
        backend_exec_type, backend_exec_session_id, backend_exec_pane_id,
        background_task_id
      ) SELECT
        id, ts, session_id, pid, hook_event, event_type, tool_name, matcher,
        cwd, permission_mode, agent_id, agent_type, stop_hook_active, data,
        subagent_agent_id, spawn_name, start_time, slash_command, skill_name,
        plan_op, plan_target, plan_epic_id, plan_task_id,
        plan_subject_present, tool_use_id, config_dir,
        bash_mutation_kind, bash_mutation_targets, plan_files,
        backend_exec_type, backend_exec_session_id, backend_exec_pane_id,
        background_task_id
      FROM events`);
      built.db.run("DROP TABLE events");
      built.db.run("ALTER TABLE events_dn RENAME TO events");
      // Recreate every captured index on the downgraded table so the v57 DB is
      // faithfully indexed (the rebuild-under-test must then carry them forward).
      // SKIP any index referencing a post-v57 column (the v73 `mutation_path`
      // partial index) — it can't exist on the faithful v57 shape; migrate()
      // recreates it from CREATE_V73_INDEXES, and the post-migrate index-set
      // assertion below still sees it (it's in `indexNamesBefore`). SKIP the v78
      // `idx_events_plan_*` indexes too: they reference the renamed `plan_*`
      // columns the v57 fixture (still `planctl_*`) lacks; migrate recreates them
      // via the frozen v14/v30 steps (`idx_events_planctl_*`) then renames forward
      // at v78, so the post-migrate assertion still sees `idx_events_plan_*`.
      for (const idx of eventsIndexSqlBefore) {
        if (idx.sql.includes("mutation_path")) {
          continue;
        }
        // The v107 `idx_events_tmux_generation` indexes the `tmux_generation_id`
        // VIRTUAL generated column the faithful v57 events shape lacks; migrate()
        // recreates it (with the column) at the v106→v107 step on the walk up, so
        // the post-migrate index-set assertion below still sees it.
        if (idx.sql.includes("tmux_generation_id")) {
          continue;
        }
        if (idx.name.startsWith("idx_events_plan_")) {
          continue;
        }
        built.db.run(idx.sql);
      }
      built.db.run(
        "UPDATE sqlite_sequence SET seq = 9999 WHERE name = 'events'",
      );
      // A faithful v57 DB predates `commit_trailer_facts` (created at v66→v67).
      // Drop the anachronistic v78-shaped table so the migrate-under-test
      // recreates it via the frozen v66→v67 CREATE+backfill (which uses the
      // `planctl_*` literal) and then renames it forward at v78 — mirroring a
      // real v57→current walk.
      built.db.run("DROP TABLE IF EXISTS commit_trailer_facts");
      built.db.run("UPDATE meta SET value = '57' WHERE key = 'schema_version'");
    })
    .immediate();
  built.db.run("PRAGMA foreign_keys = ON");
  built.db.close();

  // Reopen through migrate() — drives the v57→v58 rebuild.
  const { db } = openDb(dbPath);

  // Version stamped to current.
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  // events.data is now NULLABLE — the relocator's `UPDATE ... SET data = NULL`
  // succeeds.
  const dataCol = (
    db.prepare("PRAGMA table_info(events)").all() as {
      name: string;
      notnull: number;
    }[]
  ).find((c) => c.name === "data");
  expect(dataCol).toBeDefined();
  expect(dataCol?.notnull).toBe(0);

  // Every seeded row preserved byte-for-byte (id + values intact).
  const rowsAfter = db
    .prepare("SELECT id, session_id, hook_event, data FROM events ORDER BY id")
    .all();
  expect(rowsAfter).toEqual(rowsBefore);

  // AUTOINCREMENT high-water preserved (not recomputed from MAX(id)=2).
  const seq = (
    db
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'")
      .get() as { seq: number }
  ).seq;
  expect(seq).toBe(9999);

  // Every events index the live schema requires is present after the rebuild.
  const indexNamesAfter = new Set(
    (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events' AND sql IS NOT NULL",
        )
        .all() as { name: string }[]
    ).map((r) => r.name),
  );
  for (const name of indexNamesBefore) {
    expect(indexNamesAfter.has(name)).toBe(true);
  }

  // POST-SHED (fn-836.4): `event_blobs` is DROPPED at the v74 tail, so it is GONE
  // at head even though the walk recreated it at v57 and the v57→v58 rebuild ran
  // against it mid-walk. The original FK-rewrite regression guard (the rebuild
  // must not rewrite event_blobs's FK to a temp name) is now moot at head — the
  // table no longer exists — but the rebuild-FIDELITY proof above (rows + seq +
  // indexes + data-nullable preserved) is the live invariant, and a successful
  // 0→head walk through the rebuild is itself the proof that nothing throws.
  const hasEventBlobs = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='event_blobs'",
    )
    .get();
  expect(hasEventBlobs ?? null).toBeNull();

  // events.data NULL update is accepted (the whole point of the v57→v58 relax —
  // retention NULLs cold non-keep payloads in place post-shed).
  expect(() =>
    db.run("UPDATE events SET data = NULL WHERE hook_event = 'Stop'"),
  ).not.toThrow();

  db.close();
});

test("v4 DB migrates to v5: jobs.transcript_path added, rows preserved NULL", () => {
  // Build a v4-shaped DB by hand: jobs with title_source but no
  // transcript_path, version '4'.
  const v4 = new Database(dbPath, { create: true });
  v4.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      matcher TEXT,
      cwd TEXT,
      permission_mode TEXT,
      agent_id TEXT,
      agent_type TEXT,
      stop_hook_active INTEGER,
      data TEXT NOT NULL,
      subagent_agent_id TEXT,
      spawn_name TEXT
    )
  `);
  v4.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT
    )
  `);
  v4.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v4.run("INSERT INTO meta (key, value) VALUES ('schema_version', '4')");
  v4.run(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, title, title_source) VALUES ('old', 1, 5, 1, 'fix-osc', 'payload')",
  );
  v4.close();

  // Reopen via openDb — migrate() runs the v4→v5 idempotent ADD COLUMN.
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  const jobNames = (
    db.prepare("PRAGMA table_info(jobs)").all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  expect(jobNames).toContain("transcript_path");

  // Schema v11 rewind-and-redrain rebuilds the `jobs` projection from the
  // event log. This v4 fixture has no events, so the directly-inserted `old`
  // jobs row is wiped. Schema convergence + column existence is what the
  // migration test guarantees; data preservation requires the row to have a
  // backing event (which a real v4→v5 path would, modulo orphans).
  const job = db
    .prepare("SELECT title FROM jobs WHERE job_id = 'old'")
    .get() as { title: string | null } | null;
  expect(job).toBeNull();

  // Second open is idempotent — the ADD COLUMN no-ops on the now-v11 shape
  // and the rewind-and-redrain version guard suppresses re-running.
  db.close();
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe(String(SCHEMA_VERSION));
  db2.close();
});

test("v2 DB migrates: mode + title_history dropped, title preserved", () => {
  // Build a v2-shaped DB by hand: mode + title + title_history, version '2'.
  const v2 = new Database(dbPath, { create: true });
  v2.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      mode TEXT NOT NULL DEFAULT 'act',
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_history TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(title_history))
    )
  `);
  v2.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v2.run("INSERT INTO meta (key, value) VALUES ('schema_version', '2')");
  v2.run(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, mode, title, title_history) VALUES ('old', 1, 5, 1, 'plan', 'fix-osc', '[\"a\",\"fix-osc\"]')",
  );
  v2.close();

  // Reopen via openDb — migrate() runs the v2→v3 column drops (and on through
  // v5: the idempotent ALTER block is not version-gated, so a stale v2 DB
  // converges straight to the current schema in one open).
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));
  const names = (
    db.prepare("PRAGMA table_info(jobs)").all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  expect(names).not.toContain("mode");
  expect(names).not.toContain("title_history");
  // Schema v11 rewind-and-redrain wipes the directly-inserted `old` row.
  // The fixture has no events to re-fold, so the row is provably forgotten
  // — column drops landed correctly is what this test guarantees.
  const row = db
    .prepare("SELECT title FROM jobs WHERE job_id = 'old'")
    .get() as { title: string | null } | null;
  expect(row).toBeNull();
  db.close();
});

test("v5 DB migrates to v7: epics table added (embedded tasks), no tasks table, jobs rows preserved", () => {
  // Build a v5-shaped DB by hand: events + jobs at the current v5 shape, no
  // epics/tasks tables, version '5', with a populated jobs row.
  const v5 = new Database(dbPath, { create: true });
  v5.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT
    )
  `);
  v5.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v5.run("INSERT INTO meta (key, value) VALUES ('schema_version', '5')");
  v5.run(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, title, title_source) VALUES ('old', 1, 5, 1, 'fix-osc', 'payload')",
  );
  v5.close();

  // Reopen via openDb — migrate() creates the epics table (CREATE TABLE IF NOT
  // EXISTS, with the embedded `tasks` column) and stamps the current version.
  // A v5 DB never had a `tasks` table, so the v6→v7 guard's table-exists check
  // simply skips the backfill/DROP; the convergence lands at v7.
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  const tables = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((t) => t.name),
  );
  expect(tables.has("epics")).toBe(true);
  // Schema v7 has no standalone tasks table.
  expect(tables.has("tasks")).toBe(false);

  // New projection table starts empty.
  const epicCount = db.prepare("SELECT count(*) AS c FROM epics").get() as {
    c: number;
  };
  expect(epicCount.c).toBe(0);

  // The epics table carries the expected columns, including the embedded
  // `tasks` JSON-array column (schema v7), the embedded `jobs`
  // JSON-array column (schema v11), and the v14 `job_links` array.
  // Schema v32 (fn-634) adds `default_visible` as a VIRTUAL generated
  // column — invisible to `PRAGMA table_info` (which excludes generated
  // columns), so the check uses `PRAGMA table_xinfo` to enumerate every
  // column shape on the table.
  const epicCols = (
    db.prepare("PRAGMA table_xinfo(epics)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(epicCols).toEqual([
    "epic_id",
    "epic_number",
    "title",
    "project_dir",
    "status",
    // fn-756 (v63): `approval` was dropped from the table — a v5 DB migrating
    // all the way to v63 lands the post-drop shape (no `approval` column).
    "last_event_id",
    "updated_at",
    "tasks",
    "depends_on_epics",
    "jobs",
    "job_links",
    "last_validated_at",
    // Schema v34 (fn-637): nullable JSON array carrying the resolved +
    // enriched state of `depends_on_epics`. NULL is load-bearing
    // ("not-yet-computed", distinct from `'[]'` = "computed empty"); the
    // task-.3 reducer forward-stamp populates it via the shared
    // `resolveEpicDep` helper.
    "resolved_epic_deps",
    // Schema v32 (fn-634): VIRTUAL generated column collapsing the
    // `status='open'` predicate (fn-756 v63 dropped the old `approval`
    // branch) into a single-column 0/1 derived value served by the partial
    // index `idx_epics_default_visible`.
    "default_visible",
    // Schema v104 (fn-1083 task .2): nullable TEXT carrying the epic-level
    // parked-closer question. Declared AFTER `default_visible` in
    // `CREATE_EPICS` so a fresh CREATE and a migrated `ALTER TABLE ADD
    // COLUMN` (which always appends) produce the same trailing column order.
    "question",
    // Schema v117 (fn-1216 task .1): nullable TEXT carrying the blocking
    // follow-up close-gate pointer (the SOURCE epic id a follow-up gates).
    // Declared AFTER `question` in `CREATE_EPICS` so a fresh CREATE and the
    // migrated `ALTER TABLE ADD COLUMN` append in the same trailing slot.
    "blocks_closing_of",
  ]);

  // Schema v11 rewind-and-redrain wipes the directly-inserted `old` jobs
  // row (no events back it). The forward-only migration converges schema
  // shape; the v11 contract is that the event log is the sole source of
  // truth for projection rows.
  const job = db
    .prepare("SELECT title FROM jobs WHERE job_id = 'old'")
    .get() as { title: string | null } | null;
  expect(job).toBeNull();

  // Second open is idempotent — CREATE TABLE IF NOT EXISTS no-ops.
  db.close();
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe(String(SCHEMA_VERSION));
  db2.close();
});

test("v6 DB migrates to v7: tasks embedded into epics.tasks in (task_number, task_id) order, orphan dropped, tasks table gone", () => {
  // Build a v6-shaped DB by hand: epics + tasks tables (no embedded column),
  // version '6'. Two epics, one with two tasks (out of sort order on disk to
  // prove the backfill sorts), plus an orphan task with a NULL epic_id that
  // must NOT be embedded.
  const v6 = new Database(dbPath, { create: true });
  v6.run(`
    CREATE TABLE epics (
      epic_id TEXT PRIMARY KEY,
      epic_number INTEGER,
      title TEXT,
      project_dir TEXT,
      status TEXT,
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0
    )
  `);
  v6.run(`
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      epic_id TEXT,
      task_number INTEGER,
      title TEXT,
      target_repo TEXT,
      status TEXT,
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0
    )
  `);
  v6.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v6.run("INSERT INTO meta (key, value) VALUES ('schema_version', '6')");
  v6.run(
    "INSERT INTO epics (epic_id, epic_number, title, status, last_event_id, updated_at) VALUES ('fn-1-alpha', 1, 'Alpha', 'active', 10, 1)",
  );
  v6.run(
    "INSERT INTO epics (epic_id, epic_number, title, status, last_event_id, updated_at) VALUES ('fn-2-beta', 2, 'Beta', 'active', 11, 1)",
  );
  // Two tasks for alpha inserted out of order — the backfill must sort by
  // (task_number, task_id).
  v6.run(
    "INSERT INTO tasks (task_id, epic_id, task_number, title, target_repo, status, last_event_id, updated_at) VALUES ('fn-1-alpha.2', 'fn-1-alpha', 2, 'second', '/repo', 'open', 12, 1)",
  );
  v6.run(
    "INSERT INTO tasks (task_id, epic_id, task_number, title, target_repo, status, last_event_id, updated_at) VALUES ('fn-1-alpha.1', 'fn-1-alpha', 1, 'first', '/repo', 'done', 13, 1)",
  );
  // Orphan task with NULL epic_id — dropped, not embedded.
  v6.run(
    "INSERT INTO tasks (task_id, epic_id, task_number, title, target_repo, status, last_event_id, updated_at) VALUES ('orphan.1', NULL, 1, 'orphan', '/repo', 'open', 14, 1)",
  );
  v6.close();

  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  // tasks table is gone (the v6→v7 backfill+DROP runs inside the same
  // transaction, before the v11 rewind clears `epics`).
  const tables = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((t) => t.name),
  );
  expect(tables.has("tasks")).toBe(false);

  // Schema v11 rewind-and-redrain wipes `epics` after the v6→v7 backfill
  // runs. This fixture has no events, so the previously-backfilled rows
  // do NOT re-emerge. The migration still converges schema (tasks table
  // dropped, embedded `tasks` + `jobs` columns added). A real v6 DB whose
  // plan worker reads `.planctl` files re-folds the snapshots back through
  // synthetic events on the next boot scan.
  const epicCount = db.prepare("SELECT count(*) AS c FROM epics").get() as {
    c: number;
  };
  expect(epicCount.c).toBe(0);

  // The migrated schema includes the new `jobs` embedded column on epics.
  const epicCols = (
    db.prepare("PRAGMA table_info(epics)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(epicCols).toContain("tasks");
  expect(epicCols).toContain("jobs");

  db.close();
});

test("fresh openDb at v9 has events.start_time and jobs.start_time as nullable TEXT", () => {
  const { db } = openDb(":memory:");
  const eventCols = db.prepare("PRAGMA table_info(events)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const eventStart = eventCols.find((c) => c.name === "start_time");
  expect(eventStart).toBeDefined();
  expect(eventStart?.type).toBe("TEXT");
  expect(eventStart?.notnull).toBe(0);
  expect(eventStart?.dflt_value).toBeNull();

  const jobCols = db.prepare("PRAGMA table_info(jobs)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const jobStart = jobCols.find((c) => c.name === "start_time");
  expect(jobStart).toBeDefined();
  expect(jobStart?.type).toBe("TEXT");
  expect(jobStart?.notnull).toBe(0);
  expect(jobStart?.dflt_value).toBeNull();
  db.close();
});

test("v8 DB migrates to v9: events.start_time + jobs.start_time added, rows preserved NULL, second open is idempotent", () => {
  // Build a v8-shaped DB by hand: events + jobs at the v8 shape (no
  // start_time on either), version '8', with a populated row on each table.
  // This mirrors the prior migration tests' pattern — converging from a stale
  // version straight to the current schema via the idempotent ALTER block.
  const v8 = new Database(dbPath, { create: true });
  v8.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      matcher TEXT,
      cwd TEXT,
      permission_mode TEXT,
      agent_id TEXT,
      agent_type TEXT,
      stop_hook_active INTEGER,
      data TEXT NOT NULL,
      subagent_agent_id TEXT,
      spawn_name TEXT
    )
  `);
  v8.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT
    )
  `);
  v8.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v8.run("INSERT INTO meta (key, value) VALUES ('schema_version', '8')");
  v8.run(
    "INSERT INTO events (ts, session_id, hook_event, event_type, data, spawn_name) VALUES (1, 'sess', 'SessionStart', 'session_start', '{}', 'fix-osc')",
  );
  v8.run(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, title, title_source) VALUES ('old', 1, 5, 1, 'fix-osc', 'spawn')",
  );
  v8.close();

  // Reopen via openDb — migrate() runs the v8→v9 idempotent ADD COLUMNs and
  // stamps the current version. The v11 rewind-and-redrain wipes the
  // projection; tests stand in for the daemon's boot drain explicitly.
  const { db } = openDb(dbPath);
  drainAll(db);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  // Both columns now appear.
  const eventNames = (
    db.prepare("PRAGMA table_info(events)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(eventNames).toContain("start_time");
  const jobNames = (
    db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(jobNames).toContain("start_time");

  // Existing event rows gain the new columns reading NULL; the event log
  // is preserved (only projections rewind+redrain).
  const ev = db
    .prepare(
      "SELECT spawn_name, start_time FROM events WHERE session_id = 'sess'",
    )
    .get() as { spawn_name: string | null; start_time: string | null };
  expect(ev.spawn_name).toBe("fix-osc");
  expect(ev.start_time).toBeNull();
  // Schema v11 rewind-and-redrain wipes the directly-inserted `old` row and
  // re-folds the `sess` SessionStart event through the current reducer —
  // which seeds title from `spawn_name` ('fix-osc') at title_source='spawn'.
  const jobOld = db
    .prepare("SELECT title FROM jobs WHERE job_id = 'old'")
    .get() as { title: string | null } | null;
  expect(jobOld).toBeNull();
  const jobSess = db
    .prepare(
      "SELECT title, title_source, start_time FROM jobs WHERE job_id = 'sess'",
    )
    .get() as {
    title: string | null;
    title_source: string | null;
    start_time: string | null;
  } | null;
  expect(jobSess?.title).toBe("fix-osc");
  expect(jobSess?.title_source).toBe("spawn");
  expect(jobSess?.start_time).toBeNull();

  // Second open is idempotent — the ADD COLUMNs no-op on the now-current shape.
  db.close();
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe(String(SCHEMA_VERSION));
  const eventNames2 = (
    db2.prepare("PRAGMA table_info(events)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(eventNames2.filter((n) => n === "start_time")).toHaveLength(1);
  const jobNames2 = (
    db2.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(jobNames2.filter((n) => n === "start_time")).toHaveLength(1);
  db2.close();
});

test("fresh openDb at v10 has events.slash_command + events.skill_name + jobs.plan_verb + jobs.plan_ref as nullable TEXT", () => {
  const { db } = openDb(":memory:");
  const eventCols = db.prepare("PRAGMA table_info(events)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const slashCmd = eventCols.find((c) => c.name === "slash_command");
  expect(slashCmd).toBeDefined();
  expect(slashCmd?.type).toBe("TEXT");
  expect(slashCmd?.notnull).toBe(0);
  expect(slashCmd?.dflt_value).toBeNull();
  const skillName = eventCols.find((c) => c.name === "skill_name");
  expect(skillName).toBeDefined();
  expect(skillName?.type).toBe("TEXT");
  expect(skillName?.notnull).toBe(0);
  expect(skillName?.dflt_value).toBeNull();

  const jobCols = db.prepare("PRAGMA table_info(jobs)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const planVerb = jobCols.find((c) => c.name === "plan_verb");
  expect(planVerb).toBeDefined();
  expect(planVerb?.type).toBe("TEXT");
  expect(planVerb?.notnull).toBe(0);
  expect(planVerb?.dflt_value).toBeNull();
  const planRef = jobCols.find((c) => c.name === "plan_ref");
  expect(planRef).toBeDefined();
  expect(planRef?.type).toBe("TEXT");
  expect(planRef?.notnull).toBe(0);
  expect(planRef?.dflt_value).toBeNull();
  db.close();
});

test("v10 partial indexes are present on fresh openDb", () => {
  const { db } = openDb(":memory:");
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all() as { name: string }[];
  const names = new Set(indexes.map((i) => i.name));
  expect(names.has("idx_events_slash_command")).toBe(true);
  expect(names.has("idx_events_skill_name")).toBe(true);
  expect(names.has("idx_jobs_plan_ref")).toBe(true);
  db.close();
});

test("v10 idx_jobs_plan_ref serves a WHERE plan_verb='close' query (EXPLAIN QUERY PLAN)", () => {
  const { db } = openDb(":memory:");
  // Seed enough rows + ANALYZE so the planner picks the partial index over a
  // table scan. The acceptance bar is "an EXPLAIN QUERY PLAN ... shows SEARCH
  // ... USING INDEX idx_jobs_plan_ref (or equivalent index hit)" — `plan_verb`
  // skips its own index (cardinality 3) so a `WHERE plan_verb='close'` query
  // is served via the partial index on `plan_ref IS NOT NULL` paired with a
  // post-seek check. Confirm via the documented partial-index pattern
  // (sqlite.org/partialindex.html §2 Rule 2: ANY comparison on the indexed
  // column matches a `WHERE col IS NOT NULL` predicate, so a `plan_ref`-
  // touching predicate lands the index).
  const ts = 1_700_000_000;
  const insert = db.prepare(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, plan_verb, plan_ref) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (let i = 0; i < 50; i++) {
    insert.run(`null-${i}`, ts, i, ts, null, null);
  }
  insert.run("close-1", ts, 100, ts, "close", "fn-575-foo");
  insert.run("work-1", ts, 101, ts, "work", "fn-575-foo.1");
  db.run("ANALYZE");

  // The acceptance check: a query that filters on the indexed column (or one
  // covered by the partial-index predicate) must hit the index, not a scan.
  const plan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT job_id FROM jobs WHERE plan_ref = 'fn-575-foo'",
    )
    .all() as { detail: string }[];
  const detail = plan.map((r) => r.detail).join(" | ");
  expect(detail).toMatch(/idx_jobs_plan_ref/);
  db.close();
});

test("fn-936: idx_epics_sort_path is gone; idx_jobs_created_state present on fresh openDb", () => {
  const { db } = openDb(":memory:");
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all() as { name: string }[];
  const names = new Set(indexes.map((i) => i.name));
  // fn-936 dropped the `sort_path` index alongside the column.
  expect(names.has("idx_epics_sort_path")).toBe(false);
  expect(names.has("idx_jobs_created_state")).toBe(true);
  db.close();
});

test("Tier 4.1 (fn-634) idx_epics_default_visible is present on fresh openDb", () => {
  // Sibling presence assertion to the Tier 2 test above: the schema v32
  // partial index lands on every fresh open (CREATE INDEX IF NOT EXISTS is
  // idempotent + always-run from CREATE_EPICS_INDEXES).
  const { db } = openDb(":memory:");
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all() as { name: string }[];
  const names = new Set(indexes.map((i) => i.name));
  expect(names.has("idx_epics_default_visible")).toBe(true);
  // The generated column itself must also be present per PRAGMA table_xinfo
  // (regular table_info excludes generated columns).
  const cols = db.prepare("PRAGMA table_xinfo(epics)").all() as {
    name: string;
  }[];
  expect(cols.some((c) => c.name === "default_visible")).toBe(true);
  db.close();
});

test("Tier 4.1 (fn-634) idx_epics_default_visible serves the default epics query (EXPLAIN QUERY PLAN)", () => {
  // Seed ~50 rows + ANALYZE so the planner picks the index. The default epics
  // query (EPICS_DESCRIPTOR.defaultClause = `default_visible = 1`, defaultSort
  // = epic_number asc) is served by the partial composite index
  // `idx_epics_default_visible ON epics(default_visible, epic_number, epic_id)
  // WHERE default_visible = 1`. EQP should show
  // `SEARCH epics USING (COVERING )?INDEX idx_epics_default_visible`
  // — SEARCH (not SCAN), no temp B-tree for the ORDER BY. The literal-1
  // clause is load-bearing: a parameterized `default_visible = ?` with
  // params=[1] might not syntactically match the partial-index predicate
  // across SQLite versions.
  const { db } = openDb(":memory:");
  const insert = db.prepare(
    "INSERT INTO epics (epic_id, epic_number, title, status, last_event_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (let i = 0; i < 50; i++) {
    const status = i % 3 === 0 ? "closed" : "open";
    insert.run(`fn-${i}-foo`, i, `Epic ${i}`, status, i, 1);
  }
  db.run("ANALYZE");

  const plan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT epic_id FROM epics WHERE default_visible = 1 ORDER BY epic_number ASC, epic_id ASC",
    )
    .all() as { detail: string }[];
  const detail = plan.map((r) => r.detail).join(" | ");
  expect(detail).toMatch(
    /SEARCH epics USING (COVERING )?INDEX idx_epics_default_visible/,
  );
  expect(detail).not.toMatch(/USE TEMP B-TREE/);
  db.close();
});

test("fn-712 default_visible = 1 is semantically equivalent to the materialized status form (re-fold determinism guard)", () => {
  // Mirror of the fn-628.2 UNION-vs-OR equivalence test: both predicates
  // must return byte-identical ordered epic_id sets for the same fixture.
  // Seeds the 3 status corners — every cell exercises a different branch of
  // the generated-column CASE expression.
  //
  // fn-712 added the `status IS NOT NULL` "epic is materialized" guard; fn-756
  // (v63) dropped the `approval` branch, so the expression is now simply
  // `status IS NOT NULL AND status='open'`: a NULL-status shell row (no
  // EpicSnapshot folded yet) and a done epic are both HIDDEN.
  const { db } = openDb(":memory:");
  const insert = db.prepare(
    "INSERT INTO epics (epic_id, epic_number, title, status, last_event_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  // status combinations:
  //   open        → default_visible=1
  //   done        → 0 (HIDDEN — terminal)
  //   NULL-status → 0 (HIDDEN — not materialized)
  insert.run("fn-1", 1, "open", "open", 1, 1);
  insert.run("fn-2", 2, "done", "done", 2, 1);
  insert.run("fn-3", 3, "null-status", null, 3, 1);

  const visible = db
    .prepare(
      "SELECT epic_id FROM epics WHERE default_visible = 1 ORDER BY epic_id",
    )
    .all() as { epic_id: string }[];
  const statusForm = db
    .prepare(
      "SELECT epic_id FROM epics WHERE (status IS NOT NULL AND status = 'open') ORDER BY epic_id",
    )
    .all() as { epic_id: string }[];

  expect(visible.map((r) => r.epic_id)).toEqual(
    statusForm.map((r) => r.epic_id),
  );
  // Spot-check: only fn-1 (open) is visible; fn-2 (done) and fn-3 (null) hide.
  expect(visible.map((r) => r.epic_id)).toEqual(["fn-1"]);
  db.close();
});

test("fn-712 default_visible generated column yields the expected 0/1 values across the status corners", () => {
  // Pins the CASE-wrapped expression semantics: every status value must
  // compute the expected 0 or 1 — and never NULL (the CASE-wrap is
  // load-bearing because `status` is TEXT-nullable, so a bare
  // `status='open'` would return NULL on the NULL-status corner and violate
  // the column's NOT NULL constraint).
  //
  // fn-712 added the `status IS NOT NULL` "materialized" guard; fn-756 (v63)
  // dropped the `approval` branch. A NULL-status shell row and a done epic
  // both compute 0; only an open epic computes 1.
  const { db } = openDb(":memory:");
  const insert = db.prepare(
    "INSERT INTO epics (epic_id, epic_number, title, status, last_event_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insert.run("c1", 1, "open", "open", 1, 1);
  insert.run("c2", 2, "done", "done", 2, 1);
  insert.run("c3", 3, "null-status", null, 3, 1);

  const rows = db
    .prepare("SELECT epic_id, default_visible FROM epics ORDER BY epic_id ASC")
    .all() as { epic_id: string; default_visible: number }[];
  expect(rows).toEqual([
    { epic_id: "c1", default_visible: 1 }, // open (materialized)
    { epic_id: "c2", default_visible: 0 }, // HIDDEN (terminal)
    { epic_id: "c3", default_visible: 0 }, // HIDDEN (not materialized)
  ]);
  // CASE-wrap invariant: never NULL.
  for (const row of rows) {
    expect(row.default_visible === 0 || row.default_visible === 1).toBe(true);
  }
  db.close();
});

test("Tier 4.1 (fn-634) write-protection: INSERT INTO default_visible throws (generated-column safety)", () => {
  // SQLite forbids INSERT/UPDATE into a generated column — pins the
  // schema-enforced safety that makes the reducer's EpicSnapshot fold's
  // INSERT (which deliberately omits default_visible) the only correct shape.
  // If a future contributor adds default_visible to the INSERT column list,
  // this test catches it.
  const { db } = openDb(":memory:");
  expect(() => {
    db.run(
      "INSERT INTO epics (epic_id, status, updated_at, default_visible) VALUES ('bad', 'open', 1, 1)",
    );
  }).toThrow(/generated column|GENERATED/);
  db.close();
});

test("Tier 4.1 (fn-634) migrate() is boot-twice idempotent (addGeneratedColumnIfMissing no-ops on second call)", () => {
  // Pins that `addGeneratedColumnIfMissing`'s `PRAGMA table_xinfo` check
  // sees the existing generated column on the second migrate() pass. The
  // wrong primitive (`PRAGMA table_info`) would re-attempt the ALTER and
  // throw "duplicate column" — wedging the daemon at every reopen.
  const { db: db1 } = openDb(dbPath);
  db1.close();
  // A fresh open re-runs migrate() on the same already-migrated DB. The
  // helper must converge silently; the version stamp stays at the current
  // SCHEMA_VERSION.
  const { db: db2 } = openDb(dbPath);
  const ver = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));
  // The column must still be present (sanity).
  const cols = db2.prepare("PRAGMA table_xinfo(epics)").all() as {
    name: string;
  }[];
  expect(cols.some((c) => c.name === "default_visible")).toBe(true);
  db2.close();
});

test("fn-712 a status-NULL shell epic computes default_visible=0 and is excluded from WHERE default_visible=1", () => {
  // The "epic is materialized" gate: a freshly-scaffolded shell row whose
  // EpicSnapshot has not folded yet (status IS NULL) is hidden from the
  // board's default page. A status-set (materialized) open epic still
  // qualifies. Same `status IS NOT NULL` predicate the autopilot's
  // `epic-not-materialized` readiness verdict uses.
  const { db } = openDb(":memory:");
  const insert = db.prepare(
    "INSERT INTO epics (epic_id, epic_number, title, status, last_event_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  // shell rows: status NULL → hidden.
  insert.run("shell-a", 1, "shell", null, 1, 1);
  insert.run("shell-b", 2, "shell", null, 2, 1);
  // materialized open row → visible.
  insert.run("real-open", 3, "real", "open", 3, 1);

  const dv = db
    .prepare("SELECT epic_id, default_visible FROM epics ORDER BY epic_id ASC")
    .all() as { epic_id: string; default_visible: number }[];
  expect(dv).toEqual([
    { epic_id: "real-open", default_visible: 1 },
    { epic_id: "shell-a", default_visible: 0 },
    { epic_id: "shell-b", default_visible: 0 },
  ]);

  // The shell rows fall out of the default board query; only the
  // materialized one survives.
  const visible = db
    .prepare(
      "SELECT epic_id FROM epics WHERE default_visible = 1 ORDER BY epic_id",
    )
    .all() as { epic_id: string }[];
  expect(visible.map((r) => r.epic_id)).toEqual(["real-open"]);
  db.close();
});

test("fn-712 idx_epics_default_visible still serves the default epics query with a status-NULL fixture (EXPLAIN QUERY PLAN)", () => {
  // The added `status IS NOT NULL` guard must not regress the partial-index
  // plan: the board query still SEARCHes idx_epics_default_visible (not a
  // SCAN) with no temp B-tree for the ORDER BY, even when shell rows are
  // present in the table.
  const { db } = openDb(":memory:");
  const insert = db.prepare(
    "INSERT INTO epics (epic_id, epic_number, title, status, last_event_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (let i = 0; i < 40; i++) {
    // Mix materialized + shell rows so the index is meaningfully populated.
    const status = i % 3 === 0 ? null : "open";
    insert.run(`fn-${i}`, i, `e${i}`, status, i + 1, 1);
  }
  db.run("ANALYZE epics");

  const plan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT epic_id FROM epics WHERE default_visible = 1 ORDER BY epic_number ASC, epic_id ASC",
    )
    .all() as { detail: string }[];
  const detail = plan.map((r) => r.detail).join(" | ");
  expect(detail).toMatch(
    /SEARCH epics USING (COVERING )?INDEX idx_epics_default_visible/,
  );
  expect(detail).not.toMatch(/USE TEMP B-TREE/);
  db.close();
});

test("fn-712 migration rewrites default_visible to the materialized expression (fresh-vs-migrated parity)", () => {
  // Build a pre-v56 DB carrying the OLD `default_visible` expression (no
  // `status IS NOT NULL` guard) + the partial index + a stamped version
  // below 56, then reopen via openDb. The v55→v56 block must DROP the index,
  // DROP the VIRTUAL column (via a table_xinfo presence check — table_info
  // can't see generated columns), re-ADD it with the new expression, and
  // recreate the index — all inside one BEGIN IMMEDIATE. The migrated schema
  // must converge byte-identical with a fresh-DB CREATE: a null+pending row
  // computes 0 (it computed 1 under the old expression).
  const old = new Database(dbPath);
  old.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  old.run(`
    CREATE TABLE epics (
      epic_id TEXT PRIMARY KEY,
      epic_number INTEGER,
      title TEXT,
      project_dir TEXT,
      status TEXT,
      approval TEXT NOT NULL DEFAULT 'pending',
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0,
      tasks TEXT NOT NULL DEFAULT '[]',
      depends_on_epics TEXT NOT NULL DEFAULT '[]',
      jobs TEXT NOT NULL DEFAULT '[]',
      job_links TEXT NOT NULL DEFAULT '[]',
      last_validated_at TEXT,
      created_by_closer_of TEXT,
      sort_path TEXT NOT NULL DEFAULT '',
      queue_jump INTEGER NOT NULL DEFAULT 0,
      resolved_epic_deps TEXT,
      default_visible INTEGER NOT NULL GENERATED ALWAYS AS (CASE WHEN status='open' OR approval!='approved' THEN 1 ELSE 0 END) VIRTUAL
    )
  `);
  old.run(
    "CREATE INDEX idx_epics_default_visible ON epics(default_visible, sort_path, epic_id) WHERE default_visible = 1",
  );
  // Seed a null+pending shell row: 1 under the OLD expression, 0 under the new.
  old.run(
    "INSERT INTO epics (epic_id, epic_number, title, status, approval, last_event_id, updated_at) VALUES ('shell', 1, 'shell', NULL, 'pending', 1, 1)",
  );
  // Sanity: the OLD expression surfaces the shell row.
  const before = old
    .prepare("SELECT default_visible AS dv FROM epics WHERE epic_id = 'shell'")
    .get() as { dv: number };
  expect(before.dv).toBe(1);
  old.run("INSERT INTO meta (key, value) VALUES ('schema_version', '55')");
  old.close();

  // Reopen via openDb → the v55→v56 migration rewrites the column.
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  // The v77 rewind (fn-856) wipes the `epics` projection, so the hand-seeded
  // shell row (no backing event) does not survive. Re-insert it into the
  // migrated DB to exercise the rewritten generated column directly: a
  // null-status row computes 0 under the materialized (status-guarded)
  // expression (it computed 1 under the OLD expression).
  const wiped = db
    .prepare("SELECT epic_id FROM epics WHERE epic_id = 'shell'")
    .get() as { epic_id: string } | null;
  expect(wiped).toBeNull();
  db.run(
    "INSERT INTO epics (epic_id, epic_number, title, status, last_event_id, updated_at) VALUES ('shell', 1, 'shell', NULL, 1, 1)",
  );
  const after = db
    .prepare("SELECT default_visible AS dv FROM epics WHERE epic_id = 'shell'")
    .get() as { dv: number };
  expect(after.dv).toBe(0);

  // The column is still a generated column (visible only to table_xinfo).
  const xinfo = db.prepare("PRAGMA table_xinfo(epics)").all() as {
    name: string;
  }[];
  expect(xinfo.some((c) => c.name === "default_visible")).toBe(true);

  // The partial index was recreated.
  const indexes = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as { name: string }[]
    ).map((i) => i.name),
  );
  expect(indexes.has("idx_epics_default_visible")).toBe(true);

  // Parity with a fresh DB: insert the same fixture into a fresh openDb (now
  // v63 — `approval` dropped) and assert byte-identical default_visible.
  const freshPath = join(tmpDir, "fresh.db");
  const { db: fresh } = openDb(freshPath);
  fresh.run(
    "INSERT INTO epics (epic_id, epic_number, title, status, last_event_id, updated_at) VALUES ('shell', 1, 'shell', NULL, 1, 1)",
  );
  const freshDv = fresh
    .prepare("SELECT default_visible AS dv FROM epics WHERE epic_id = 'shell'")
    .get() as { dv: number };
  expect(freshDv.dv).toBe(after.dv);
  fresh.close();
  db.close();
});

test("fn-756 (v63): epics has NO `approval` column; default_visible rewritten to the status-only expr; fresh-vs-migrated table_xinfo parity", () => {
  // The schema-drop keystone (fn-756 task .2): SCHEMA_VERSION === 63 drops
  // `epics.approval` and rewrites the `default_visible` generated column to
  // `CASE WHEN status IS NOT NULL AND status='open' THEN 1 ELSE 0 END`. A
  // fresh-from-empty DB lands the post-drop shape directly via CREATE_EPICS;
  // a pre-v63 DB converges to the SAME shape via the v62→v63 migration. This
  // test pins (a) no `approval` column, (b) the rewritten expression, and
  // (c) fresh-vs-migrated table_xinfo byte-parity (re-fold determinism guard).
  // Version guard tracks the live SCHEMA_VERSION (v64 adds the `builds` table,
  // fn-781; v65 adds `jobs.active_since`, fn-784; v66 adds the
  // `idx_events_pretooluse_agent_session` partial index, fn-787; v67 adds the
  // `commit_trailer_facts` projection table, fn-807; v68 adds the
  // `scheduled_tasks` projection table, fn-813; v69 adds
  // `subagent_invocations.last_disposition`, fn-38.2; v70 adds
  // `jobs.close_kind`, fn-817; v71 adds `jobs.window_index`, fn-817; v72 widens
  // the `file_attributions.source` CHECK to accept `'plan'`, fn-826; v73 adds
  // the `events.mutation_path` column, fn-836.2; v74 restores keep-set bodies
  // inline + DROPs `event_blobs`, fn-836.4; v75 rewrites stored
  // `file_attributions.source='planctl'` rows to `'plan'`, fn-831; v76 adds the
  // `dispatch_never_bound` circuit-breaker projection table, fn-846; v77 ungates
  // the plan-link classifier from `/plan:plan` windows + rewinds the cursor and
  // wipes the canonical projection list, fn-856; v78 renames the `planctl_*`
  // schema surface → `plan_*` + rewrites historical envelopes, fn-864; v79 adds
  // the `git_projection_state` live-only control singleton + skip-floor, fn-868;
  // v80 excludes the worker's `done` + closer's `close` op from the plan-link
  // classifier + rewinds the cursor with a git-floor-raise (not reset), fn-881;
  // v81 converges `epics.job_links` under the cheap per-session `mergeJobLinkSlice`
  // merge via a v80-shaped rewind-and-redrain, fn-888; v82 rewrites historical
  // Commit-event `events.data` keys `planctl_op`/`planctl_target` → `plan_op`/
  // `plan_target` + narrows the `file_attributions.source` CHECK to drop
  // `'planctl'`, fn-889; v83 adds the `jobs.backend_exec_generation_id` +
  // `backend_exec_birth_session_id` columns + the `tmux_projection_state`
  // live-only control singleton + backfills birth_session from the frozen launch
  // session, fn-907; v84 carries the existing `jobs.active_since` fact on the
  // embedded `epics.jobs` element — a JSON-cell-only add, fix-forward (no column,
  // no rewind, absent ≡ null), so readiness can hold a freshly-bound `stopped`
  // worker's root across the bind → first-activity handoff, fn-924); the
  // v62→v63 epics-shape migration this test exercises is unchanged. v85 strips
  // the static priority/ordering machinery — DROPs `epics.sort_path` /
  // `queue_jump` / `created_by_closer_of` + `events.plan_queue_jump`, fn-936;
  // v86 adds the `block_escalations` escalate-once latch projection table, fn-941
  // (comment-only no-op — created via CREATE_BLOCK_ESCALATIONS, populated from
  // the fold arms); v87 adds the `handoffs` durable `keeper handoff` projection
  // table, fn-946 (comment-only no-op — created via CREATE_HANDOFFS, populated
  // from the fold arms in tasks .2/.3); v88 appends the `jobs.handoff_links`
  // column (the per-job home for the rendered handoff edge), fn-946 task .2 —
  // an additive ALTER (mirrors `window_index`/v71), not an epics-shape change.
  // v89 adds the `tmux_client_focus` LIVE-ONLY client-focus singleton, fn-952
  // task .2 (comment-only no-op — created via CREATE_TMUX_CLIENT_FOCUS,
  // populated from the fold arm; no seed/floor, registered in
  // LIVE_ONLY_PROJECTIONS). v90 appends the nullable
  // `autopilot_state.max_concurrent_per_root` config column (an additive ALTER,
  // not an epics-shape change), fn-954 task .1. v91 appends the nullable
  // `autopilot_state.worktree_mode` config column (an additive ALTER, not an
  // epics-shape change), fn-959 task .1. v92 NULLs `backend_exec_pane_id` +
  // `backend_exec_generation_id` on existing terminal (ended/killed) jobs so a
  // dead job stops holding a tmux-recyclable pane id that could be
  // mis-attributed to a fresh window, fn-977 task .2 (a one-time data-fix
  // UPDATE, no column/shape change, version-guarded). v93 appends nullable codex-spark usage columns
  // (additive ALTER, no epics-shape change). v94 appends the nullable
  // `events.worktree` + `jobs.worktree` durable lane-branch marker (an additive
  // ALTER, not an epics-shape change), fn-997 task .1. v95 appends the nullable
  // `usage.error_kind` failure-classification column (an additive ALTER, not an
  // epics-shape change), fn-1000 task .1. v96 appends the nullable
  // `handoffs.target_dir` launch-directory column (an additive ALTER, not an
  // epics-shape change), fn-1003 task .2. v97 appends the nullable
  // `usage.account_state` account-axis column (an additive ALTER, not an
  // epics-shape change), fn-1007 task .1. v98 appends the nullable
  // `dispatch_failures.merge_escalated_at` escalate-once marker for the daemon
  // merge-escalation sweep (an additive ALTER, not an epics-shape change),
  // fn-1009 task .1. v99 adds the `lane_merged` LIVE-ONLY merge-landed observable
  // (a CREATE-only table registered in LIVE_ONLY_PROJECTIONS, not an epics-shape
  // change), fn-1016 task .1. v100 appends the six nullable per-session telemetry
  // columns to `jobs` (current model / effort / context-window usage from the
  // statusLine payload — an additive ALTER, not an epics-shape change), fn-1024
  // task .1. v101 appends the nullable `autopilot_state.worktree_multi_repo`
  // rollout flag for multi-repo worktree epics (an additive ALTER, not an
  // epics-shape change), fn-1034 task .1. v102 adds the durable
  // `dispatch_mint_gate` producer table (the one-logical-dispatch-one-row
  // rate-limit gate at the `Dispatched` mint site — a CREATE-only table, not an
  // epics-shape change), fn-1061 task .1. v103 appends the nullable
  // `jobs.kill_reason` column (WHY keeper reaped a job — the producer arm that
  // minted the synthetic `Killed`; an additive ALTER, not an epics-shape
  // change), fn-1075 task .2. v104 appends the nullable `epics.question`
  // column (the epic-level parked-closer question) — an additive ALTER (both
  // in the migration AND the fresh `CREATE_EPICS` literal, placed after
  // `default_visible` so column order stays fresh-vs-migrated identical); it
  // widens the epics row shape but does not touch the v62→v63
  // `default_visible`/`approval` rewrite this test exercises, fn-1083 task .2.
  // v105 adds the `dispatch_instant_death` reducer projection table (the
  // instant-death circuit breaker's counter — a CREATE-only table, not an
  // epics-shape change), fn-1086 task .1. v106 appends the nullable
  // `dispatch_failures.resolver_dispatched_at` once-marker (the merge-resolver
  // dispatch latch — an additive ALTER, not an epics-shape change), fn-1088 task .1.
  // v107 adds the `events.tmux_generation_id` VIRTUAL generated column + its
  // partial index (the tab-restore generation-summary walk's indexed key — an
  // ALTER + index on `events`, not an epics-shape change), fn-1102 task .1.
  // v108 appends the nullable `jobs.dispatch_origin` provenance column (the
  // autopilot-vs-manual discriminator the autoclose worker scopes on — an
  // additive ALTER, not an epics-shape change), fn-1107 task .1. v109 appends
  // the nullable `harness`/`resume_target` columns to BOTH events (five-place
  // lockstep) and jobs (migration-only) — an additive ALTER, not an epics-shape
  // change, fn-1103 task .3. v110 appends the nullable `human_notified_at`
  // once-marker to BOTH `dispatch_failures` and `block_escalations` (the terminal
  // human-notify stage of the two escalation paths — additive ALTERs, not an
  // epics-shape change), fn-1129 task .1.
  // v111 appends the nullable `adopted` INTEGER column
  // to BOTH events (five-place lockstep) and jobs (migration-only) plus the
  // `autopilot_state.codex_adoption` knob — additive ALTERs, none touching the
  // epics shape, fn-1131 task .1.
  // v112 appends the nullable `epics.selection_review` TEXT column (the
  // epic-level close-time selection-review record) — an additive ALTER (both in
  // the migration AND the fresh `CREATE_EPICS` literal, placed after `question`
  // so column order stays fresh-vs-migrated identical); it widens the epics row
  // shape but does not touch the v62→v63 `default_visible`/`approval` rewrite
  // this test exercises, fn-1151 task .2.
  // v113 appends the nullable `jobs.last_lifecycle_ts` REAL column (the lifecycle
  // stamp) via a REWINDING migration (cursor rewind + wipe the deterministic
  // projection set + re-fold); it widens the jobs row shape and rewinds, but does
  // not touch the epics table SHAPE — the migrated `epics` table_xinfo this test
  // pins is unchanged (only epics ROWS are wiped, which this shape test never
  // seeds), fn-1164 task .1.
  // v114 appends the nullable `jobs.escalation_instance` +
  // `dispatch_failures.instance_event_id` INTEGER columns (the escalation-session
  // block-instance binding) via a plain additive ALTER; it widens the jobs and
  // dispatch_failures row shapes but does not touch the epics table SHAPE this
  // test pins, fn-1171 task .2.
  // v115 appends the nullable `dispatch_failures.repair_dispatched_at`
  // once-marker for the daemon SHARED_BASE_BROKEN repair sweep (an additive
  // ALTER, not an epics-shape change), fn-1173 task .4.
  // v116 DROPS the `epics.selection_review` TEXT column via a REWINDING migration
  // (direct DROP COLUMN + cursor rewind + wipe the deterministic projection set +
  // re-fold). It narrows the epics row shape — but AFTER the `question` column
  // (the trailing append), so the `default_visible`/`approval` rewrite this test
  // exercises is untouched and the migrated table stays byte-clean, fn-1172 task .3.
  // v117 appends the nullable `epics.blocks_closing_of` column (the blocking
  // follow-up close-gate pointer) — an additive ALTER declared in the fresh
  // `CREATE_EPICS` literal too, placed after `question` so column order stays
  // fresh-vs-migrated identical; it widens the epics row shape but does not touch
  // the v62→v63 `default_visible`/`approval` rewrite this test exercises, fn-1216
  // task .1.
  // v118 appends the nullable `git_status.unattributed_to_live_count` column
  // (the exact pass-4 unattributed-to-live scalar) — an additive ALTER on the
  // LIVE-ONLY `git_status` table; it does not touch the epics table SHAPE this
  // test pins, fn-1226 task .1.
  // v119 appends the nullable `events.account_route` + `jobs.account_route`
  // columns (the PII-free per-launch account route) — additive ALTERs that
  // widen the events/jobs row shape, not the epics table this test pins, fn-1239
  // task .3.
  // v120 unconditionally DROPs the retired `usage` / `profiles` tables (the
  // `event_blobs` precedent) — it does not touch the epics table SHAPE this
  // test pins, fn-1239 task .6.
  // v121 re-appends the nullable `autopilot_state.worker_provider` TEXT enum
  // column (the durable work-dispatch provider pin, docs/adr/0047) — an
  // idempotent additive ALTER on `autopilot_state`; it does not touch the
  // epics table SHAPE this test pins.
  // v122 backfills the `autopilot_state.worker_provider` family-label value
  // 'codex' → 'gpt' (docs/adr/0047 amendment) — a pure data UPDATE that does
  // not touch the epics table SHAPE this test pins.
  // v132 adds the ADR 0071 `provider_leg_ownership` / `provider_leg_cascades`
  // projection tables — new standalone tables, not a touch of the epics SHAPE
  // this test pins.
  // v133 adds the fn-1311 `boot_catchup_stats` OPERATIONAL singleton — a new
  // standalone table, not a touch of the epics SHAPE this test pins.
  // v134 appends the nullable `boot_catchup_stats.fold_work_ms` column (the
  // pace-free fold-work rate the full-replay projection derives from) — an
  // additive ALTER on that operational singleton, not a touch of the epics
  // SHAPE this test pins.
  expect(SCHEMA_VERSION).toBe(135);

  // (a) Fresh DB: no `approval` column (table_info excludes generated cols, so
  // a real stored column shows up here if present).
  const { db: fresh } = openDb(":memory:");
  const freshInfo = fresh.prepare("PRAGMA table_info(epics)").all() as {
    name: string;
  }[];
  expect(freshInfo.find((c) => c.name === "approval")).toBeUndefined();

  // (b) default_visible carries the rewritten status-only expression. Read the
  // CREATE TABLE SQL from sqlite_master and pin the new expr / absence of the
  // old `approval` branch.
  const createSql = (
    fresh
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'epics'")
      .get() as { sql: string }
  ).sql;
  expect(createSql).toContain(
    "CASE WHEN status IS NOT NULL AND status='open' THEN 1 ELSE 0 END",
  );
  expect(createSql).not.toContain("approval");

  // (b') The generated column still exists (visible only to table_xinfo).
  const freshXinfo = fresh.prepare("PRAGMA table_xinfo(epics)").all() as {
    name: string;
  }[];
  expect(freshXinfo.some((c) => c.name === "default_visible")).toBe(true);
  fresh.close();

  // (c) Build a pre-v63 DB (v62-shaped epics: `approval` present, old
  // default_visible expr) and migrate it. The post-migrate table_xinfo must
  // byte-match the fresh DB's — same column names in the same order.
  const migPath = join(tmpDir, "v62-to-v63.db");
  const old = new Database(migPath);
  old.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  old.run(`
    CREATE TABLE epics (
      epic_id TEXT PRIMARY KEY,
      epic_number INTEGER,
      title TEXT,
      project_dir TEXT,
      status TEXT,
      approval TEXT NOT NULL DEFAULT 'pending',
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0,
      tasks TEXT NOT NULL DEFAULT '[]',
      depends_on_epics TEXT NOT NULL DEFAULT '[]',
      jobs TEXT NOT NULL DEFAULT '[]',
      job_links TEXT NOT NULL DEFAULT '[]',
      last_validated_at TEXT,
      created_by_closer_of TEXT,
      sort_path TEXT NOT NULL DEFAULT '',
      queue_jump INTEGER NOT NULL DEFAULT 0,
      resolved_epic_deps TEXT,
      default_visible INTEGER NOT NULL GENERATED ALWAYS AS (CASE WHEN status IS NOT NULL AND (status='open' OR approval!='approved') THEN 1 ELSE 0 END) VIRTUAL
    )
  `);
  old.run(
    "CREATE INDEX idx_epics_default_visible ON epics(default_visible, sort_path, epic_id) WHERE default_visible = 1",
  );
  old.run("INSERT INTO meta (key, value) VALUES ('schema_version', '62')");
  old.close();

  const { db: migrated } = openDb(migPath);
  const ver = migrated
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  // Migrated shape: no `approval`, default_visible rewritten, quick_check clean.
  const migInfo = migrated.prepare("PRAGMA table_info(epics)").all() as {
    name: string;
  }[];
  expect(migInfo.find((c) => c.name === "approval")).toBeUndefined();
  const migCreate = (
    migrated
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'epics'")
      .get() as { sql: string }
  ).sql;
  expect(migCreate).toContain(
    "CASE WHEN status IS NOT NULL AND status='open' THEN 1 ELSE 0 END",
  );
  expect(migCreate).not.toContain("approval");
  const integrity = migrated.prepare("PRAGMA quick_check").get() as {
    quick_check: string;
  };
  expect(integrity.quick_check).toBe("ok");

  // Fresh-vs-migrated table_xinfo byte-parity: same column names, same order.
  const { db: fresh2 } = openDb(":memory:");
  const freshNames = (
    fresh2.prepare("PRAGMA table_xinfo(epics)").all() as { name: string }[]
  ).map((c) => c.name);
  const migNames = (
    migrated.prepare("PRAGMA table_xinfo(epics)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(migNames).toEqual(freshNames);
  expect(migNames).not.toContain("approval");
  fresh2.close();
  migrated.close();
});

test("Tier 2 (fn-628) idx_jobs_created_state serves the default jobs query as COVERING (EXPLAIN QUERY PLAN)", () => {
  // Seed ~50 rows + ANALYZE so the planner picks the index. The default jobs
  // query (JOBS_DESCRIPTOR.defaultFilter = state NOT IN ('ended','killed');
  // defaultSort = created_at desc) is served by the corrected index shape
  // `(created_at DESC, job_id, state)` — `created_at DESC` leads so the
  // ORDER BY is satisfied in order, and trailing `state` makes the index
  // covering for the NOT IN filter (no heap row-lookup). The state-leading
  // shape was rejected during planning because SQLite cannot translate a
  // `NOT IN` predicate into a usable index-entry range on the leading
  // column.
  const { db } = freshMemDb();
  const states = ["running", "stopped", "ended", "killed", "spawned"];
  const insert = db.prepare(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, state) VALUES (?, ?, ?, ?, ?)",
  );
  for (let i = 0; i < 60; i++) {
    insert.run(
      `job-${i}`,
      1_700_000_000 + i,
      i,
      1_700_000_000 + i,
      states[i % states.length],
    );
  }
  db.run("ANALYZE");

  const plan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT job_id, state FROM jobs WHERE state NOT IN ('ended', 'killed') ORDER BY created_at DESC, job_id ASC",
    )
    .all() as { detail: string }[];
  const detail = plan.map((r) => r.detail).join(" | ");
  expect(detail).toMatch(
    /SCAN jobs USING COVERING INDEX idx_jobs_created_state/,
  );
  expect(detail).not.toMatch(/USE TEMP B-TREE/);
  db.close();
});

// Tier 2 (fn-628.2) — paired `CREATE_EVENTS_PLANCTL_INDEXES` + UNION rewrite.
// Helper seeds a varied event mix that exercises both the planctl_epic_id and
// planctl_target sides plus rows that match neither. Shared by the three EQP
// tests + the semantic-equivalence test below.
function seedPlanctlEventMix(db: Database): void {
  const insert = db.prepare(
    `INSERT INTO events (
       ts, session_id, hook_event, event_type, data,
       plan_op, plan_target, plan_epic_id
     ) VALUES (?, ?, ?, ?, '{}', ?, ?, ?)`,
  );
  // Sessions whose footprint matches via planctl_epic_id only — the work-verb
  // shape (planctl_target = task id, planctl_epic_id = parent epic).
  for (let i = 0; i < 20; i++) {
    insert.run(
      1_700_000_000 + i,
      `sess-epic-${i}`,
      "PostToolUse",
      "post_tool_use",
      "done",
      `fn-100-foo.${i}`,
      "fn-100-foo",
    );
  }
  // Sessions whose footprint matches via planctl_target only — the
  // epic-targeting shape (planctl_target = epic id directly, planctl_epic_id
  // null because the envelope didn't carry it for this op).
  for (let i = 0; i < 20; i++) {
    insert.run(
      1_700_000_500 + i,
      `sess-target-${i}`,
      "PostToolUse",
      "post_tool_use",
      "approve",
      "fn-100-foo",
      null,
    );
  }
  // Sessions whose footprint matches BOTH (the normal scaffold/work shape:
  // planctl_target = task id, planctl_epic_id = parent epic).
  for (let i = 0; i < 10; i++) {
    insert.run(
      1_700_001_000 + i,
      `sess-both-${i}`,
      "PostToolUse",
      "post_tool_use",
      "scaffold",
      `fn-100-foo.x${i}`,
      "fn-100-foo",
    );
  }
  // Noise: planctl rows pointing at a different epic, plus non-planctl rows.
  for (let i = 0; i < 20; i++) {
    insert.run(
      1_700_001_500 + i,
      `sess-noise-${i}`,
      "PostToolUse",
      "post_tool_use",
      "done",
      `fn-999-bar.${i}`,
      "fn-999-bar",
    );
  }
  // Production-proportion non-planctl noise: ~99% of events carry NULL
  // planctl_op, so the partial-index footprint is ~1% of the full table.
  // Without this mass, ANALYZE can't tell the partial composite apart from
  // `idx_events_session` and the planner picks the simpler one (the planner
  // makes the right pick on the live ~110k-row DB; this scales the fixture
  // proportionally). Diverse session_id keeps `idx_events_session`'s
  // selectivity at production-like (~3k distinct sessions in prod).
  for (let i = 0; i < 5000; i++) {
    insert.run(
      1_700_010_000 + i,
      `sess-non-planctl-${i % 500}`,
      "PostToolUse",
      "post_tool_use",
      null,
      null,
      null,
    );
  }
  db.run("ANALYZE");
}

describe("Tier 2 (fn-628.2) plan event indexes", () => {
  let db: Database;

  beforeAll(() => {
    ({ db } = freshMemDb());
    seedPlanctlEventMix(db);
  });

  afterAll(() => {
    db.close();
  });

  test("Tier 2 (fn-628.2) idx_events_plan_epic + idx_events_plan_target are present on fresh openDb", () => {
    const { db: fresh } = freshMemDb();
    const indexes = fresh
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as { name: string }[];
    const names = new Set(indexes.map((i) => i.name));
    expect(names.has("idx_events_plan_epic")).toBe(true);
    expect(names.has("idx_events_plan_target")).toBe(true);
    fresh.close();
  });

  test("Tier 2 (fn-628.2) cross-session UNION sweep uses BOTH plan partial indexes (EXPLAIN QUERY PLAN)", () => {
    // Mirrors the syncPlanLinks cross-session sweep at src/reducer.ts:~2371
    // after the OR→UNION rewrite. EQP must show a COMPOUND QUERY whose two
    // branches each SEARCH a different new partial index — proving the
    // optimizer can reach both indexes (the prior OR form could only reach one).
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT session_id
           FROM events
          WHERE plan_op IS NOT NULL
            AND plan_epic_id IN ('fn-100-foo')
          UNION
         SELECT session_id
           FROM events
          WHERE plan_op IS NOT NULL
            AND plan_target IN ('fn-100-foo')`,
      )
      .all() as { detail: string }[];
    const detail = plan.map((r) => r.detail).join(" | ");
    expect(detail).toMatch(/COMPOUND QUERY/);
    expect(detail).toMatch(/SEARCH events USING INDEX idx_events_plan_epic/);
    expect(detail).toMatch(/SEARCH events USING INDEX idx_events_plan_target/);
  });

  test("Tier 2 (fn-628.2) per-session ordered plan load still uses idx_events_plan_session (regression guard)", () => {
    // The per-session ordered load at src/reducer.ts:~2389-2395 must NOT be
    // displaced by the new indexes — confirms the v14 session-leading index
    // remains the planner's pick for `WHERE session_id = ? AND plan_op IS
    // NOT NULL ORDER BY id ASC`.
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT ts, plan_op, plan_target, plan_epic_id,
                plan_subject_present
           FROM events
          WHERE session_id = ? AND plan_op IS NOT NULL
          ORDER BY id ASC`,
      )
      .all("sess-both-0") as { detail: string }[];
    const detail = plan.map((r) => r.detail).join(" | ");
    expect(detail).toMatch(/SEARCH events USING INDEX idx_events_plan_session/);
  });

  test("Tier 2 (fn-628.2) UNION rewrite is semantically equivalent to the prior OR form (re-fold determinism guard)", () => {
    // The reducer's `syncPlanLinks` cross-session sweep must produce
    // byte-identical session_id sets after the rewrite. Both forms run against
    // the same fixture; sorted+deduped session_id sets must deep-equal.
    const orForm = db
      .prepare(
        `SELECT DISTINCT session_id
           FROM events
          WHERE plan_op IS NOT NULL
            AND (plan_epic_id IN ('fn-100-foo') OR plan_target IN ('fn-100-foo'))`,
      )
      .all() as { session_id: string }[];
    const unionForm = db
      .prepare(
        `SELECT session_id
           FROM events
          WHERE plan_op IS NOT NULL
            AND plan_epic_id IN ('fn-100-foo')
          UNION
         SELECT session_id
           FROM events
          WHERE plan_op IS NOT NULL
            AND plan_target IN ('fn-100-foo')`,
      )
      .all() as { session_id: string }[];

    const orSet = orForm.map((r) => r.session_id).sort();
    const unionSet = unionForm.map((r) => r.session_id).sort();
    // UNION dedups intrinsically; SELECT DISTINCT does too — both must
    // produce the same set (and contain it without duplicates).
    expect(new Set(orSet).size).toBe(orSet.length);
    expect(new Set(unionSet).size).toBe(unionSet.length);
    expect(unionSet).toEqual(orSet);
    // Spot-check: the fixture has 20 epic-only + 20 target-only + 10 both =
    // 50 distinct sessions that should match (the noise + non-planctl rows
    // point at a different epic / carry NULL planctl columns).
    expect(unionSet.length).toBe(50);
  });
});

test("v9 DB migrates to v10: four columns added + three partial indexes + backfill, second open is idempotent", () => {
  // Build a v9-shaped DB by hand: events + jobs at the v9 shape (no
  // slash_command / skill_name / plan_verb / plan_ref), version '9'.
  // Seed historical rows the backfill must walk:
  // - A UserPromptSubmit with a `/plan:work fn-X` prompt → slash_command
  //   backfilled, skill_name NULL.
  // - A UserPromptSubmit with a non-slash prompt → both NULL.
  // - A UserPromptSubmit with a path-shape prompt (`/Users/...`) → both NULL
  //   (the regex requires a lowercase letter after `/`, so `/U...` rejects).
  // - A PreToolUse on Skill with `tool_input.skill: 'plan:plan'` →
  //   skill_name backfilled, slash_command NULL.
  // - A PostToolUse on a non-Skill tool → both NULL (tool gate).
  // - A SessionStart with spawn_name matching the whitelist → its job row
  //   gets plan_verb / plan_ref backfilled.
  // - A SessionStart with spawn_name `audit::fn-1-foo` → row stays NULL
  //   (whitelist excludes audit).
  // - A SessionStart with no spawn_name → row stays NULL.
  const v9 = new Database(dbPath, { create: true });
  v9.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      matcher TEXT,
      cwd TEXT,
      permission_mode TEXT,
      agent_id TEXT,
      agent_type TEXT,
      stop_hook_active INTEGER,
      data TEXT NOT NULL,
      subagent_agent_id TEXT,
      spawn_name TEXT,
      start_time TEXT
    )
  `);
  v9.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT,
      start_time TEXT
    )
  `);
  v9.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v9.run("INSERT INTO meta (key, value) VALUES ('schema_version', '9')");

  // Seed events.
  const insertEvent = v9.prepare(
    "INSERT INTO events (ts, session_id, hook_event, event_type, tool_name, data, spawn_name) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insertEvent.run(
    1,
    "sess-slash",
    "UserPromptSubmit",
    "user_prompt_submit",
    null,
    JSON.stringify({ prompt: "/plan:work fn-575-foo" }),
    null,
  );
  insertEvent.run(
    2,
    "sess-plain",
    "UserPromptSubmit",
    "user_prompt_submit",
    null,
    JSON.stringify({ prompt: "just some text" }),
    null,
  );
  insertEvent.run(
    3,
    "sess-path",
    "UserPromptSubmit",
    "user_prompt_submit",
    null,
    JSON.stringify({ prompt: "/Users/mike/code/keeper" }),
    null,
  );
  insertEvent.run(
    4,
    "sess-skill",
    "PreToolUse",
    "pre_tool_use",
    "Skill",
    JSON.stringify({ tool_input: { skill: "plan:plan", args: "..." } }),
    null,
  );
  insertEvent.run(
    5,
    "sess-bash",
    "PostToolUse",
    "tool_use",
    "Bash",
    JSON.stringify({ tool_response: {} }),
    null,
  );
  insertEvent.run(
    6,
    "sess-work",
    "SessionStart",
    "session_start",
    null,
    "{}",
    "work::fn-575-foo.1",
  );
  insertEvent.run(
    7,
    "sess-audit",
    "SessionStart",
    "session_start",
    null,
    "{}",
    "audit::fn-1-bar",
  );
  insertEvent.run(
    8,
    "sess-nospawn",
    "SessionStart",
    "session_start",
    null,
    "{}",
    null,
  );
  insertEvent.run(
    9,
    "sess-malformed",
    "UserPromptSubmit",
    "user_prompt_submit",
    null,
    "{not valid json",
    null,
  );

  // Seed corresponding jobs rows. Only the SessionStart-having sessions
  // get a jobs row (mirrors the reducer's SessionStart insert path).
  const insertJob = v9.prepare(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at) VALUES (?, ?, ?, ?)",
  );
  insertJob.run("sess-work", 1, 6, 1);
  insertJob.run("sess-audit", 1, 7, 1);
  insertJob.run("sess-nospawn", 1, 8, 1);
  v9.close();

  // Reopen via openDb — migrate() runs the v9→v10 idempotent ADD COLUMNs,
  // the partial indexes, the same-transaction JS backfill, and (schema v11)
  // the rewind-and-redrain wipe. The daemon's boot drain rebuilds the
  // projection AFTER `openDb` returns — tests stand in for that drain
  // explicitly so plan_verb/plan_ref show up on the re-folded jobs rows.
  const { db } = openDb(dbPath);
  drainAll(db);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  // All four columns appear.
  const eventNames = (
    db.prepare("PRAGMA table_info(events)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(eventNames).toContain("slash_command");
  expect(eventNames).toContain("skill_name");
  const jobNames = (
    db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(jobNames).toContain("plan_verb");
  expect(jobNames).toContain("plan_ref");

  // Partial indexes present.
  const indexNames = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as { name: string }[]
    ).map((i) => i.name),
  );
  expect(indexNames.has("idx_events_slash_command")).toBe(true);
  expect(indexNames.has("idx_events_skill_name")).toBe(true);
  expect(indexNames.has("idx_jobs_plan_ref")).toBe(true);

  // Backfill: events.
  const ev = db
    .prepare("SELECT session_id, slash_command, skill_name FROM events")
    .all() as {
    session_id: string;
    slash_command: string | null;
    skill_name: string | null;
  }[];
  const eventBy = new Map(ev.map((r) => [r.session_id, r]));
  expect(eventBy.get("sess-slash")?.slash_command).toBe("/plan:work");
  expect(eventBy.get("sess-slash")?.skill_name).toBeNull();
  expect(eventBy.get("sess-plain")?.slash_command).toBeNull();
  expect(eventBy.get("sess-plain")?.skill_name).toBeNull();
  // `/Users/...` REJECTS the slash-command regex (uppercase after `/`).
  expect(eventBy.get("sess-path")?.slash_command).toBeNull();
  expect(eventBy.get("sess-path")?.skill_name).toBeNull();
  expect(eventBy.get("sess-skill")?.slash_command).toBeNull();
  expect(eventBy.get("sess-skill")?.skill_name).toBe("plan:plan");
  expect(eventBy.get("sess-bash")?.slash_command).toBeNull();
  expect(eventBy.get("sess-bash")?.skill_name).toBeNull();
  // The SessionStart rows aren't slash-command / Skill candidates — both NULL.
  expect(eventBy.get("sess-work")?.slash_command).toBeNull();
  expect(eventBy.get("sess-work")?.skill_name).toBeNull();
  // A malformed JSON blob falls through the try/catch and leaves both NULL —
  // the migration must converge, not throw.
  expect(eventBy.get("sess-malformed")?.slash_command).toBeNull();
  expect(eventBy.get("sess-malformed")?.skill_name).toBeNull();

  // Backfill: jobs.
  const jobs = db
    .prepare("SELECT job_id, plan_verb, plan_ref FROM jobs")
    .all() as {
    job_id: string;
    plan_verb: string | null;
    plan_ref: string | null;
  }[];
  const jobBy = new Map(jobs.map((r) => [r.job_id, r]));
  expect(jobBy.get("sess-work")?.plan_verb).toBe("work");
  expect(jobBy.get("sess-work")?.plan_ref).toBe("fn-575-foo.1");
  expect(jobBy.get("sess-audit")?.plan_verb).toBeNull();
  expect(jobBy.get("sess-audit")?.plan_ref).toBeNull();
  expect(jobBy.get("sess-nospawn")?.plan_verb).toBeNull();
  expect(jobBy.get("sess-nospawn")?.plan_ref).toBeNull();

  // Second open is idempotent — the version-guarded backfill must not re-run
  // (its UPDATEs would re-write the same values; the no-throw correctness is
  // what we're checking) and the ALTERs must no-op on the now-current shape.
  db.close();
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe(String(SCHEMA_VERSION));
  // Re-verify the backfill landed identically on the second open — the
  // guard keeps the values stable.
  const jobsAfter = db2
    .prepare("SELECT job_id, plan_verb, plan_ref FROM jobs WHERE job_id = ?")
    .get("sess-work") as {
    job_id: string;
    plan_verb: string | null;
    plan_ref: string | null;
  };
  expect(jobsAfter.plan_verb).toBe("work");
  expect(jobsAfter.plan_ref).toBe("fn-575-foo.1");
  db2.close();
});

test("v10 DB migrates to v11: epics.jobs added + rewind-and-redrain rebuilds embedded jobs from event log", () => {
  // Build a v10-shaped DB by hand: events + jobs + epics at the v10 shape (no
  // `epics.jobs` column), version '10'. Seed historical events that the
  // rewind-and-redrain must replay through the v11 reducer to land embedded
  // jobs back into the right arrays.
  const v10 = new Database(dbPath, { create: true });
  v10.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      matcher TEXT,
      cwd TEXT,
      permission_mode TEXT,
      agent_id TEXT,
      agent_type TEXT,
      stop_hook_active INTEGER,
      data TEXT NOT NULL,
      subagent_agent_id TEXT,
      spawn_name TEXT,
      start_time TEXT,
      slash_command TEXT,
      skill_name TEXT
    )
  `);
  v10.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT,
      start_time TEXT,
      plan_verb TEXT,
      plan_ref TEXT
    )
  `);
  v10.run(`
    CREATE TABLE epics (
      epic_id TEXT PRIMARY KEY,
      epic_number INTEGER,
      title TEXT,
      project_dir TEXT,
      status TEXT,
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0,
      tasks TEXT NOT NULL DEFAULT '[]',
      depends_on_epics TEXT NOT NULL DEFAULT '[]'
    )
  `);
  v10.run(`
    CREATE TABLE reducer_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_event_id INTEGER NOT NULL DEFAULT 0,
      updated_at REAL NOT NULL
    )
  `);
  v10.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v10.run("INSERT INTO meta (key, value) VALUES ('schema_version', '10')");
  v10.run(
    "INSERT INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 0, 1)",
  );

  // Seed events covering mixed kinds:
  // - SessionStart with plan-verb spawn → fans into epic.jobs.
  // - SessionStart with work-verb spawn → fans into task.jobs (shell task).
  // - EpicSnapshot + TaskSnapshot → fill scalar columns.
  // - A second SessionStart for a job WITHOUT plan_ref → no fan-out.
  const insertEvent = v10.prepare(
    "INSERT INTO events (ts, session_id, hook_event, event_type, data, spawn_name) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insertEvent.run(
    1,
    "sess-plan",
    "SessionStart",
    "session_start",
    "{}",
    "plan::fn-1-foo",
  );
  insertEvent.run(
    2,
    "sess-work",
    "SessionStart",
    "session_start",
    "{}",
    "work::fn-1-foo.2",
  );
  insertEvent.run(
    3,
    "fn-1-foo",
    "EpicSnapshot",
    "epic_snapshot",
    JSON.stringify({
      epic_number: 1,
      title: "Foo",
      project_dir: "/repo",
      status: "open",
    }),
    null,
  );
  insertEvent.run(
    4,
    "fn-1-foo.2",
    "TaskSnapshot",
    "task_snapshot",
    JSON.stringify({
      epic_id: "fn-1-foo",
      task_number: 2,
      title: "Two",
      target_repo: "/repo",
      status: "open",
    }),
    null,
  );
  insertEvent.run(5, "sess-plain", "SessionStart", "session_start", "{}", null);

  // Seed jobs + epics rows reflecting v10 reducer output (no `jobs` arrays).
  v10
    .prepare(
      "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, plan_verb, plan_ref) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("sess-plan", 1, 1, 1, "plan", "fn-1-foo");
  v10
    .prepare(
      "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, plan_verb, plan_ref) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("sess-work", 2, 2, 2, "work", "fn-1-foo.2");
  v10
    .prepare(
      "INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run("fn-1-foo", 1, "Foo", "/repo", "open", 3, 1);
  v10.close();

  // Reopen via openDb — migrate() runs the v10→v11 ALTER (idempotent) plus
  // the version-guarded rewind-and-redrain, then the v12→v13 ALTER that adds
  // `epics.approval` + drops the (non-existent on this v10 DB) `approvals`
  // sidecar; the version stamp jumps straight to v13 (the current
  // SCHEMA_VERSION). The daemon's boot drain rebuilds the projection AFTER
  // `openDb` returns; the test stands in for that drain.
  const { db } = openDb(dbPath);
  drainAll(db);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  // epics.jobs column present, with the NOT NULL DEFAULT '[]'.
  const epicCols = db.prepare("PRAGMA table_info(epics)").all() as {
    name: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const jobsCol = epicCols.find((c) => c.name === "jobs");
  expect(jobsCol).toBeDefined();
  expect(jobsCol?.notnull).toBe(1);
  expect(jobsCol?.dflt_value).toBe("'[]'");

  // The re-fold rebuilt epic.jobs and task.jobs from the event log.
  const epic = db
    .prepare(
      "SELECT title, status, jobs, tasks FROM epics WHERE epic_id = 'fn-1-foo'",
    )
    .get() as {
    title: string;
    status: string;
    jobs: string;
    tasks: string;
  };
  expect(epic.title).toBe("Foo");
  expect(epic.status).toBe("open");
  // Epic-level embedded jobs: just the plan-verb session.
  const epicJobs = JSON.parse(epic.jobs) as {
    job_id: string;
    plan_verb: string;
  }[];
  expect(epicJobs.length).toBe(1);
  expect(epicJobs[0]?.job_id).toBe("sess-plan");
  expect(epicJobs[0]?.plan_verb).toBe("plan");
  // Task-level embedded jobs: the work-verb session nested inside task.2.
  const tasks = JSON.parse(epic.tasks) as {
    task_id: string;
    jobs: { job_id: string; plan_verb: string }[];
  }[];
  expect(tasks.length).toBe(1);
  expect(tasks[0]?.task_id).toBe("fn-1-foo.2");
  expect(tasks[0]?.jobs.length).toBe(1);
  expect(tasks[0]?.jobs[0]?.job_id).toBe("sess-work");
  expect(tasks[0]?.jobs[0]?.plan_verb).toBe("work");

  // Second openDb is idempotent — the rewind-and-redrain guard skips the
  // second time (storedVersion >= 11), and the v11→v12 CREATE TABLE
  // IF NOT EXISTS is naturally idempotent, so the projection is left intact.
  const epicsBefore = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  const jobsBefore = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  db.close();
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe(String(SCHEMA_VERSION));
  // No re-drain needed — the guard suppressed the rewind, so the rows
  // persist as-is.
  const epicsAfter = db2.query("SELECT * FROM epics ORDER BY epic_id").all();
  const jobsAfter = db2.query("SELECT * FROM jobs ORDER BY job_id").all();
  expect(epicsAfter).toEqual(epicsBefore);
  expect(jobsAfter).toEqual(jobsBefore);
  db2.close();
});

test("fn-602: `tier` survives a re-fold from the immutable event log (rides FREE in embedded JSON, no schema column / migration)", () => {
  // Re-fold determinism guard for fn-602: the producer ships the
  // planctl-native `tier` field on every TaskSnapshot blob; the reducer
  // folds it into the embedded element under the same `tier` key with no
  // schema column (rides FREE in the JSON-TEXT `epics.tasks` array).
  // This test seeds the event log with a tier-bearing TaskSnapshot, drains
  // once to confirm the projection carries the tier, then rewinds the
  // cursor and re-drains to confirm a from-scratch re-fold reproduces the
  // same byte-deterministic value — the CLAUDE.md re-fold invariant.
  const { db } = openDb(dbPath);

  // Seed: EpicSnapshot then TaskSnapshot, both as synthetic plan events.
  const insertEvent = db.prepare(
    "INSERT INTO events (ts, session_id, hook_event, event_type, data) VALUES (?, ?, ?, ?, ?)",
  );
  insertEvent.run(
    1,
    "fn-602-decouple",
    "EpicSnapshot",
    "plan_snapshot",
    JSON.stringify({
      epic_number: 602,
      title: "Decouple",
      project_dir: "/repo",
      status: "open",
    }),
  );
  insertEvent.run(
    2,
    "fn-602-decouple.1",
    "TaskSnapshot",
    "plan_snapshot",
    JSON.stringify({
      epic_id: "fn-602-decouple",
      task_number: 1,
      title: "Project tier",
      target_repo: "/repo",
      tier: "xhigh",
      worker_phase: "open",
      runtime_status: "todo",
    }),
  );

  drainAll(db);

  // First drain: the embedded tasks array carries tier verbatim from the
  // blob.
  const before = JSON.parse(
    (
      db
        .prepare("SELECT tasks FROM epics WHERE epic_id = 'fn-602-decouple'")
        .get() as { tasks: string }
    ).tasks,
  ) as { task_id: string; tier?: string | null }[];
  expect(before.length).toBe(1);
  expect(before[0]?.task_id).toBe("fn-602-decouple.1");
  expect(before[0]?.tier).toBe("xhigh");

  // Rewind + re-drain: same shape every version-guarded rewind in db.ts
  // does. The event log is immutable; only the projection is rebuilt.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM epics");
  __resetEpicIndexMemoForTest(db);
  drainAll(db);

  // After re-fold: byte-identical tier value, no NULLing, no shape drift.
  const after = JSON.parse(
    (
      db
        .prepare("SELECT tasks FROM epics WHERE epic_id = 'fn-602-decouple'")
        .get() as { tasks: string }
    ).tasks,
  ) as { task_id: string; tier?: string | null }[];
  expect(after.length).toBe(1);
  expect(after[0]?.tier).toBe("xhigh");

  db.close();
});

test("v12 DB migrates: SQL half replays cleanly — approvals table dropped, epics.approval re-dropped at v63", () => {
  // Build a v12-shaped DB by hand: events + jobs + epics + approvals at the
  // v12 shape, version '12'. The v12→v13 step ADDs `epics.approval` and DROPs
  // the `approvals` sidecar table (SQL half). fn-759 DELETED the old
  // filesystem half (the boot-time backfill/overlay that rewrote `.planctl`
  // files) — so this test now pins ONLY the SQL ladder: the chain replays
  // cleanly through every step, drops the sidecar, and (via the later v62→v63
  // fn-756 step) leaves no `approval` column at the live version. No FS tree
  // is touched.
  const v12 = new Database(dbPath, { create: true });
  v12.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      matcher TEXT,
      cwd TEXT,
      permission_mode TEXT,
      agent_id TEXT,
      agent_type TEXT,
      stop_hook_active INTEGER,
      data TEXT NOT NULL,
      subagent_agent_id TEXT,
      spawn_name TEXT,
      start_time TEXT,
      slash_command TEXT,
      skill_name TEXT
    )
  `);
  v12.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT,
      start_time TEXT,
      plan_verb TEXT,
      plan_ref TEXT
    )
  `);
  v12.run(`
    CREATE TABLE epics (
      epic_id TEXT PRIMARY KEY,
      epic_number INTEGER,
      title TEXT,
      project_dir TEXT,
      status TEXT,
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0,
      tasks TEXT NOT NULL DEFAULT '[]',
      depends_on_epics TEXT NOT NULL DEFAULT '[]',
      jobs TEXT NOT NULL DEFAULT '[]'
    )
  `);
  v12.run(`
    CREATE TABLE approvals (
      approval_id TEXT PRIMARY KEY,
      epic_id TEXT NOT NULL,
      task_key TEXT NOT NULL,
      status TEXT CHECK(status IN ('approved', 'rejected')) NOT NULL,
      updated_at REAL NOT NULL,
      UNIQUE(epic_id, task_key)
    )
  `);
  v12.run(`
    CREATE TABLE reducer_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_event_id INTEGER NOT NULL DEFAULT 0,
      updated_at REAL NOT NULL
    )
  `);
  v12.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v12.run("INSERT INTO meta (key, value) VALUES ('schema_version', '12')");
  v12.run(
    "INSERT INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 42, 1)",
  );
  // Seed a projection row (proves sibling tables survive the DROP).
  v12
    .prepare(
      "INSERT INTO epics (epic_id, epic_number, title, status, last_event_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("fn-1-foo", 1, "Foo", "open", 7, 1);
  // Seed 3 sidecar rows: one task-level approve, one task-level reject, one
  // epic-level close-approval (task_key === "close:<epic_id>"). Plus one
  // orphan row whose target file we WON'T create.
  const insertApproval = v12.prepare(
    "INSERT INTO approvals (approval_id, epic_id, task_key, status, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  insertApproval.run(
    "fn-1-foo:fn-1-foo.1",
    "fn-1-foo",
    "fn-1-foo.1",
    "approved",
    100,
  );
  insertApproval.run(
    "fn-1-foo:fn-1-foo.2",
    "fn-1-foo",
    "fn-1-foo.2",
    "rejected",
    200,
  );
  insertApproval.run(
    "fn-1-foo:close:fn-1-foo",
    "fn-1-foo",
    "close:fn-1-foo",
    "rejected",
    300,
  );
  insertApproval.run("fn-nx:fn-nx.1", "fn-nx", "fn-nx.1", "approved", 400);
  v12.close();

  // Reopen via openDb — migrate() runs the FULL chain. The v12→v13 step ADDs
  // `epics.approval` and DROPs `approvals`; the later v62→v63 step (fn-756)
  // DROPs `epics.approval` again, so the column is GONE at the live version.
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  // approvals table is GONE — DROP TABLE IF EXISTS ran.
  const approvalsExists =
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approvals'",
      )
      .get() != null;
  expect(approvalsExists).toBe(false);

  // epics.approval column DROPPED at v63 (fn-756): the v12→v13 add is dead
  // history, the live shape carries no `approval` column.
  const epicCols = db.prepare("PRAGMA table_info(epics)").all() as {
    name: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  expect(epicCols.find((c) => c.name === "approval")).toBeUndefined();

  // Sibling tables survived the DROP intact (the epics TABLE is still
  // present — the v12→v13 step only DROPs the `approvals` sidecar). The
  // v16→v17 rewind-and-redrain wipes the projection rows themselves so a
  // direct-seeded `epics` row inserted by this fixture does NOT survive
  // re-fold; consumers in the real daemon rebuild every row from the
  // event log on the post-migrate boot drain. Both invariants are
  // independent — we assert the table shape, not the row.
  const epicsCount = db.prepare("SELECT COUNT(*) AS n FROM epics").get() as {
    n: number;
  };
  expect(epicsCount.n).toBe(0);

  // Second openDb is idempotent — version stays at v13, sibling rows
  // persist, schema_version unchanged.
  const epicsBefore = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  db.close();
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe(String(SCHEMA_VERSION));
  const epicsAfter = db2.query("SELECT * FROM epics ORDER BY epic_id").all();
  expect(epicsAfter).toEqual(epicsBefore);
  db2.close();
});

test("fresh openDb at v14 has events.plan_* + jobs.epic_links + epics.job_links with correct shapes", () => {
  const { db } = openDb(":memory:");
  const eventCols = db.prepare("PRAGMA table_info(events)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const eventByName = new Map(eventCols.map((c) => [c.name, c]));
  for (const col of [
    "plan_op",
    "plan_target",
    "plan_epic_id",
    "plan_task_id",
  ]) {
    const c = eventByName.get(col);
    expect(c).toBeDefined();
    expect(c?.type).toBe("TEXT");
    expect(c?.notnull).toBe(0);
    expect(c?.dflt_value).toBeNull();
  }
  const presentCol = eventByName.get("plan_subject_present");
  expect(presentCol).toBeDefined();
  expect(presentCol?.type).toBe("INTEGER");
  expect(presentCol?.notnull).toBe(0);

  const jobCols = db.prepare("PRAGMA table_info(jobs)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const epicLinks = jobCols.find((c) => c.name === "epic_links");
  expect(epicLinks).toBeDefined();
  expect(epicLinks?.type).toBe("TEXT");
  expect(epicLinks?.notnull).toBe(1);
  expect(epicLinks?.dflt_value).toBe("'[]'");

  const epicCols = db.prepare("PRAGMA table_info(epics)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const jobLinks = epicCols.find((c) => c.name === "job_links");
  expect(jobLinks).toBeDefined();
  expect(jobLinks?.type).toBe("TEXT");
  expect(jobLinks?.notnull).toBe(1);
  expect(jobLinks?.dflt_value).toBe("'[]'");

  // v14 partial composite index is present on a fresh openDb.
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all() as { name: string }[];
  const names = new Set(indexes.map((i) => i.name));
  expect(names.has("idx_events_plan_session")).toBe(true);
  db.close();
});

test("fresh openDb has git_status table for the git read surface", () => {
  const { db } = openDb(":memory:");
  const cols = db.prepare("PRAGMA table_info(git_status)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const byName = new Map(cols.map((c) => [c.name, c]));
  expect(byName.get("project_dir")?.type).toBe("TEXT");
  expect(byName.get("dirty_files")?.dflt_value).toBe("'[]'");
  expect(byName.get("orphaned_files")?.dflt_value).toBe("'[]'");
  expect(byName.get("jobs")?.dflt_value).toBe("'[]'");
  expect(byName.get("dirty_count")?.notnull).toBe(1);
  expect(byName.get("orphaned_count")?.notnull).toBe(1);
  const attributionEventId = byName.get("attribution_event_id");
  expect(attributionEventId?.type).toBe("INTEGER");
  expect(attributionEventId?.notnull).toBe(1);
  expect(attributionEventId?.dflt_value).toBe("0");
  db.close();
});

test("v127→v128 adds the Git attribution watermark and distrusts legacy synthetic-event floors", () => {
  const { db: legacy } = openDb(dbPath);
  legacy.run("ALTER TABLE git_status RENAME TO git_status_v128");
  legacy.run(`
    CREATE TABLE git_status (
      project_dir TEXT PRIMARY KEY,
      branch TEXT,
      head_oid TEXT,
      upstream TEXT,
      ahead INTEGER,
      behind INTEGER,
      dirty_count INTEGER NOT NULL DEFAULT 0,
      orphaned_count INTEGER NOT NULL DEFAULT 0,
      unattributed_to_live_count INTEGER NOT NULL DEFAULT 0,
      dirty_files TEXT NOT NULL DEFAULT '[]',
      orphaned_files TEXT NOT NULL DEFAULT '[]',
      jobs TEXT NOT NULL DEFAULT '[]',
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0
    )
  `);
  legacy.run("DROP TABLE git_status_v128");
  legacy.run("UPDATE meta SET value = '127' WHERE key = 'schema_version'");
  legacy.run(
    `INSERT INTO git_status
       (project_dir, last_event_id, updated_at)
     VALUES ('/repo', 91, 1)`,
  );
  legacy.run(
    `INSERT INTO file_attributions
       (project_dir, session_id, file_path, last_mutation_at, last_commit_at,
        op, source, last_event_id, updated_at)
     VALUES (?, ?, ?, 1, 1, 'attribution-floor', 'plan', 91, 1)`,
    ["/repo", "\u0000keeper-attribution-floor", "\u0000"],
  );
  legacy.close();

  const { db: migrated } = openDb(dbPath);
  const column = (
    migrated.prepare("PRAGMA table_info(git_status)").all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[]
  ).find((candidate) => candidate.name === "attribution_event_id");
  expect(column?.name).toBe("attribution_event_id");
  expect(column?.type).toBe("INTEGER");
  expect(column?.notnull).toBe(1);
  expect(column?.dflt_value).toBe("0");
  const status = migrated
    .prepare(
      "SELECT last_event_id, attribution_event_id FROM git_status WHERE project_dir = '/repo'",
    )
    .get() as { last_event_id: number; attribution_event_id: number };
  expect(status).toEqual({ last_event_id: 91, attribution_event_id: 0 });
  const floor = migrated
    .prepare(
      "SELECT last_event_id FROM file_attributions WHERE project_dir = ? AND session_id = ? AND file_path = ?",
    )
    .get("/repo", "\u0000keeper-attribution-floor", "\u0000") as {
    last_event_id: number;
  };
  expect(floor.last_event_id).toBe(0);
  migrated.close();

  // Version guarding makes a second open a no-op with the conservative values
  // intact.
  const { db: reopened } = openDb(dbPath);
  expect(
    (
      reopened
        .prepare(
          "SELECT attribution_event_id FROM git_status WHERE project_dir = '/repo'",
        )
        .get() as { attribution_event_id: number }
    ).attribution_event_id,
  ).toBe(0);
  reopened.close();
});

test("fresh openDb (0→head): usage is absent at head — retired v120 (fn-1239 task .6, formerly fn-615)", () => {
  // `usage` served the retired agentusage read surface from schema v23
  // through v119; the tail v120 step DROPs it unconditionally (the
  // `event_blobs` precedent). A fresh 0→head walk still exercises the
  // steady-state `CREATE_USAGE` + every historical ADD-column step against a
  // transient table, but nothing survives the final DROP.
  const { db } = openDb(":memory:");
  const hasUsage = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage'",
    )
    .get();
  expect(hasUsage ?? null).toBeNull();
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));
  db.close();
});

test("v22 DB migrates to head: the transient v22→v23 usage CREATE still runs (no throw); usage is absent at head", () => {
  // Build a v22-shaped DB by hand: events + jobs (with config_dir) but no
  // `usage` table. Schema version stamped '22'. Reopen via openDb to drive
  // the full v22→head migrate() path — the v22→v23 hop still creates `usage`
  // transiently (every later historical ADD-column step runs against it
  // without throwing) — and assert it converges to ABSENT at head (v120).
  const v22 = new Database(dbPath, { create: true });
  v22.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      matcher TEXT,
      cwd TEXT,
      permission_mode TEXT,
      agent_id TEXT,
      agent_type TEXT,
      stop_hook_active INTEGER,
      data TEXT NOT NULL,
      subagent_agent_id TEXT,
      spawn_name TEXT,
      start_time TEXT,
      slash_command TEXT,
      skill_name TEXT,
      planctl_op TEXT,
      planctl_target TEXT,
      planctl_epic_id TEXT,
      planctl_task_id TEXT,
      planctl_subject_present INTEGER,
      tool_use_id TEXT,
      config_dir TEXT
    )
  `);
  v22.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT,
      start_time TEXT,
      plan_verb TEXT,
      plan_ref TEXT,
      epic_links TEXT NOT NULL DEFAULT '[]',
      rate_limited_at REAL,
      config_dir TEXT
    )
  `);
  v22.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v22.run("INSERT INTO meta (key, value) VALUES ('schema_version', '22')");
  // Sanity: the migrating DB has no usage table to start with.
  const tablesBefore = (
    v22
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[]
  ).map((t) => t.name);
  expect(tablesBefore).not.toContain("usage");
  v22.close();

  // Drive migrate() via openDb.
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));
  // usage is absent at head on the migrate-path DB — the tail v120 DROP
  // converges the v22→head walk to the same shape as a fresh open.
  const hasUsageMigrated = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage'",
    )
    .get();
  expect(hasUsageMigrated ?? null).toBeNull();
  db.close();

  // Build a fresh-CREATE DB at a sibling path to compare against — same
  // convergence (both walks drop `usage` at the tail).
  const freshPath = join(tmpDir, "keeper-fresh.db");
  const { db: freshDb } = openDb(freshPath);
  const hasUsageFresh = freshDb
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage'",
    )
    .get();
  expect(hasUsageFresh ?? null).toBeNull();
  freshDb.close();
});

test("v22→head migration is idempotent on re-open; usage stays absent", () => {
  // First openDb runs the full v22→head walk (the transient v22→v23 usage
  // CREATE, every historical ADD-column step, the v23→v24 rewind-and-redrain,
  // and the v120 tail DROP); second openDb must be a no-op (every step is
  // idempotent or version-guarded; meta stays at SCHEMA_VERSION; usage stays
  // absent — DROP TABLE IF EXISTS on an already-absent table is a no-op).
  const { db } = openDb(dbPath);
  db.close();
  const { db: db2 } = openDb(dbPath);
  const ver = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));
  const hasUsage = db2
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage'",
    )
    .get();
  expect(hasUsage ?? null).toBeNull();
  db2.close();
});

test("v23 DB migrates to v24: jobs.rate_limited_at dropped; last_api_error_at + last_api_error_kind added; rewind-and-redrain rebuilds projection with new shape; idempotent re-open", () => {
  // Build a v23-shaped DB by hand: events + jobs (with rate_limited_at,
  // with config_dir, no last_api_error_*), epics (with all v23 columns),
  // usage table present, schema_version stamped '23'. Seed a RateLimited
  // synthetic event so the post-rewind redrain produces a row carrying
  // `kind="rate_limit"` via the dual-case fold's legacy alias — the
  // re-fold-determinism keystone for this migration.
  const v23 = new Database(dbPath, { create: true });
  v23.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      matcher TEXT,
      cwd TEXT,
      permission_mode TEXT,
      agent_id TEXT,
      agent_type TEXT,
      stop_hook_active INTEGER,
      data TEXT NOT NULL,
      subagent_agent_id TEXT,
      spawn_name TEXT,
      start_time TEXT,
      slash_command TEXT,
      skill_name TEXT,
      planctl_op TEXT,
      planctl_target TEXT,
      planctl_epic_id TEXT,
      planctl_task_id TEXT,
      planctl_subject_present INTEGER,
      tool_use_id TEXT,
      config_dir TEXT
    )
  `);
  v23.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT,
      start_time TEXT,
      plan_verb TEXT,
      plan_ref TEXT,
      epic_links TEXT NOT NULL DEFAULT '[]',
      rate_limited_at REAL,
      config_dir TEXT
    )
  `);
  v23.run(`
    CREATE TABLE epics (
      epic_id TEXT PRIMARY KEY,
      epic_number INTEGER,
      title TEXT,
      project_dir TEXT,
      status TEXT,
      approval TEXT NOT NULL DEFAULT 'pending',
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0,
      tasks TEXT NOT NULL DEFAULT '[]',
      depends_on_epics TEXT NOT NULL DEFAULT '[]',
      jobs TEXT NOT NULL DEFAULT '[]',
      job_links TEXT NOT NULL DEFAULT '[]',
      last_validated_at TEXT
    )
  `);
  v23.run(`
    CREATE TABLE reducer_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_event_id INTEGER NOT NULL DEFAULT 0,
      updated_at REAL NOT NULL
    )
  `);
  v23.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v23.run("INSERT INTO meta (key, value) VALUES ('schema_version', '23')");
  v23.run(
    "INSERT INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 0, 1)",
  );

  // Seed events: SessionStart + UserPromptSubmit + RateLimited for one
  // session. The RateLimited fold under v24 lands `kind="rate_limit"`
  // via the dual-case alias — the keystone for re-fold determinism
  // across the v23 → v24 boundary (CLAUDE.md "byte-identical re-fold").
  const insertEvt = v23.prepare(
    `INSERT INTO events (ts, session_id, hook_event, event_type, data)
       VALUES (?, ?, ?, ?, ?)`,
  );
  insertEvt.run(100, "sess-rl-v24", "SessionStart", "session_start", "{}");
  insertEvt.run(
    101,
    "sess-rl-v24",
    "UserPromptSubmit",
    "user_prompt_submit",
    "{}",
  );
  insertEvt.run(
    102,
    "sess-rl-v24",
    "RateLimited",
    "rate_limited",
    JSON.stringify({ rate_limit_text: "quota exceeded" }),
  );

  // Seed a hand-built jobs row carrying a non-NULL `rate_limited_at` to
  // confirm the rewind-and-redrain correctly drops the projection and
  // rebuilds from the event log (the new value comes from re-folding
  // the RateLimited event through the v24 dual-case fold, NOT from a
  // hand-stamped column).
  v23.run(
    `INSERT INTO jobs (
       job_id, created_at, state, last_event_id, updated_at,
       rate_limited_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    ["sess-rl-v24", 100, "stopped", 102, 102, 102],
  );
  v23.close();

  // Reopen via openDb — drives the full v23→v24 migration: ADD
  // last_api_error_at + last_api_error_kind; DROP rate_limited_at;
  // rewind reducer_state + DELETE jobs/epics/subagent_invocations.
  // drainAll then re-folds the event log through the v24 reducer.
  const { db } = openDb(dbPath);
  drainAll(db);

  // Step 1: schema_version stamped to 24.
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  // Step 2: jobs column shape has the new two-field pair and NO legacy
  // rate_limited_at column.
  const jobCols = (
    db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(jobCols).toContain("last_api_error_at");
  expect(jobCols).toContain("last_api_error_kind");
  expect(jobCols).not.toContain("rate_limited_at");

  // Step 3: the rewind wiped the hand-seeded jobs row; the boot drain
  // rebuilt it from the event log. The RateLimited event folds via the
  // dual-case alias to `kind="rate_limit"` and stamps both new columns
  // in a paired UPDATE.
  const job = db
    .prepare(
      "SELECT state, last_api_error_at, last_api_error_kind FROM jobs WHERE job_id = ?",
    )
    .get("sess-rl-v24") as {
    state: string;
    last_api_error_at: number | null;
    last_api_error_kind: string | null;
  };
  expect(job.state).toBe("stopped");
  expect(job.last_api_error_at).not.toBeNull();
  expect(job.last_api_error_kind).toBe("rate_limit");

  // Capture post-rewind state for the idempotency re-open assertion.
  const eventsBefore = db.query("SELECT * FROM events ORDER BY id").all();
  const jobsBefore = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  db.close();

  // Idempotent re-open: the v23→v24 rewind guard suppresses re-execution
  // (the meta row was stamped to '24' on the first open), so jobs +
  // events stay byte-identical across the second openDb.
  const { db: db2 } = openDb(dbPath);
  drainAll(db2);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe(String(SCHEMA_VERSION));
  expect(db2.query("SELECT * FROM events ORDER BY id").all()).toEqual(
    eventsBefore,
  );
  expect(db2.query("SELECT * FROM jobs ORDER BY job_id").all()).toEqual(
    jobsBefore,
  );
  db2.close();
});

test("v13 DB migrates to v14: seven columns + partial index + per-event backfill + per-session/per-epic projection re-derive, idempotent re-run", () => {
  // Build a v13-shaped DB by hand: events + jobs + epics at the v13 shape (no
  // planctl_*, no epic_links, no job_links), version '13'. Seed historical
  // events that the v13→v14 backfill must walk:
  //
  // Session A (`sess-creator`):
  //   - SessionStart (no spawn name → no plan_verb/plan_ref).
  //   - PreToolUse:Skill `plan:plan` at ts=10 → window opener.
  //   - PreToolUse:Bash `planctl epic-create fn-1-foo` at ts=20 (mutation,
  //     inside window) → creator edge for fn-1-foo.
  //   - PreToolUse:Bash `planctl cat fn-1-foo` at ts=30 (read-only verb,
  //     inside window) → no edge.
  //
  // Session B (`sess-refiner`):
  //   - SessionStart.
  //   - PreToolUse:Skill `plan:plan` at ts=40 → window opener.
  //   - PreToolUse:Bash `planctl epic-set-title fn-1-foo "new"` at ts=50
  //     (mutation, inside window) → refiner edge for fn-1-foo.
  //
  // Session C (`sess-noop`):
  //   - SessionStart.
  //   - PreToolUse:Bash `ls -la` at ts=60 (non-planctl Bash) → no
  //     planctl_* stamps, no edges.
  const v13 = new Database(dbPath, { create: true });
  v13.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      matcher TEXT,
      cwd TEXT,
      permission_mode TEXT,
      agent_id TEXT,
      agent_type TEXT,
      stop_hook_active INTEGER,
      data TEXT NOT NULL,
      subagent_agent_id TEXT,
      spawn_name TEXT,
      start_time TEXT,
      slash_command TEXT,
      skill_name TEXT
    )
  `);
  v13.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT,
      start_time TEXT,
      plan_verb TEXT,
      plan_ref TEXT
    )
  `);
  v13.run(`
    CREATE TABLE epics (
      epic_id TEXT PRIMARY KEY,
      epic_number INTEGER,
      title TEXT,
      project_dir TEXT,
      status TEXT,
      approval TEXT NOT NULL DEFAULT 'pending',
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0,
      tasks TEXT NOT NULL DEFAULT '[]',
      depends_on_epics TEXT NOT NULL DEFAULT '[]',
      jobs TEXT NOT NULL DEFAULT '[]'
    )
  `);
  v13.run(`
    CREATE TABLE reducer_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_event_id INTEGER NOT NULL DEFAULT 0,
      updated_at REAL NOT NULL
    )
  `);
  v13.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v13.run("INSERT INTO meta (key, value) VALUES ('schema_version', '13')");
  v13.run(
    "INSERT INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 0, 1)",
  );

  // Seed events. We bind `skill_name` directly for the Skill rows (the
  // v9→v10 backfill would otherwise have stamped them on its own — but
  // this fixture is at v13, past that step, so it expects skill_name to
  // already be populated on PreToolUse:Skill rows).
  const insertEvent = v13.prepare(
    "INSERT INTO events (ts, session_id, hook_event, event_type, tool_name, data, skill_name) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  // sess-creator
  insertEvent.run(
    1,
    "sess-creator",
    "SessionStart",
    "session_start",
    null,
    "{}",
    null,
  );
  insertEvent.run(
    10,
    "sess-creator",
    "PreToolUse",
    "pre_tool_use",
    "Skill",
    JSON.stringify({ tool_input: { skill: "plan:plan" } }),
    "plan:plan",
  );
  insertEvent.run(
    20,
    "sess-creator",
    "PreToolUse",
    "pre_tool_use",
    "Bash",
    JSON.stringify({ tool_input: { command: "planctl epic-create fn-1-foo" } }),
    null,
  );
  insertEvent.run(
    30,
    "sess-creator",
    "PreToolUse",
    "pre_tool_use",
    "Bash",
    JSON.stringify({ tool_input: { command: "planctl cat fn-1-foo" } }),
    null,
  );

  // sess-refiner
  insertEvent.run(
    35,
    "sess-refiner",
    "SessionStart",
    "session_start",
    null,
    "{}",
    null,
  );
  insertEvent.run(
    40,
    "sess-refiner",
    "PreToolUse",
    "pre_tool_use",
    "Skill",
    JSON.stringify({ tool_input: { skill: "plan:plan" } }),
    "plan:plan",
  );
  insertEvent.run(
    50,
    "sess-refiner",
    "PreToolUse",
    "pre_tool_use",
    "Bash",
    JSON.stringify({
      tool_input: { command: 'planctl epic-set-title fn-1-foo "new"' },
    }),
    null,
  );

  // sess-noop
  insertEvent.run(
    55,
    "sess-noop",
    "SessionStart",
    "session_start",
    null,
    "{}",
    null,
  );
  insertEvent.run(
    60,
    "sess-noop",
    "PreToolUse",
    "pre_tool_use",
    "Bash",
    JSON.stringify({ tool_input: { command: "ls -la" } }),
    null,
  );

  // Seed jobs rows so the backfill has something to UPDATE.
  const insertJob = v13.prepare(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at) VALUES (?, ?, ?, ?)",
  );
  insertJob.run("sess-creator", 1, 4, 1);
  insertJob.run("sess-refiner", 1, 7, 1);
  insertJob.run("sess-noop", 1, 9, 1);
  v13.close();

  // Reopen via openDb — migrate() runs the v13→v14 idempotent ADD COLUMNs,
  // the partial composite index, and the version-guarded same-transaction
  // backfill. The v16→v17 step that follows immediately rewinds
  // reducer_state + wipes the jobs / epics / subagent_invocations rows,
  // so the v14 backfill's projection output does NOT survive the same
  // openDb call — the daemon rebuilds the projection on its post-migrate
  // boot drain. This test asserts the SHAPE migration (columns, indexes,
  // events.planctl_* stamps) lands cleanly; the projection rebuild lives
  // in the integration suite where the drain runs.
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  // All seven columns exist with correct shape.
  const eventNames = (
    db.prepare("PRAGMA table_info(events)").all() as { name: string }[]
  ).map((c) => c.name);
  for (const col of [
    "plan_op",
    "plan_target",
    "plan_epic_id",
    "plan_task_id",
    "plan_subject_present",
  ]) {
    expect(eventNames).toContain(col);
  }
  const jobNames = (
    db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(jobNames).toContain("epic_links");
  const epicNames = (
    db.prepare("PRAGMA table_info(epics)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(epicNames).toContain("job_links");

  // Partial composite index present.
  const indexNames = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as { name: string }[]
    ).map((i) => i.name),
  );
  expect(indexNames.has("idx_events_plan_session")).toBe(true);

  // Backfill: events.plan_* on each PreToolUse:Bash row. As of
  // fn-606.1 the `extractPlanInvocation` deriver gates on
  // PostToolUse:Bash (parsing the authoritative `plan_invocation`
  // envelope from `tool_response.stdout`), so the v13→v14 backfill — which
  // scans PreToolUse:Bash rows by hook-event gate — stamps zero columns
  // against the new deriver. The v19→v20 migration (fn-606.2) re-stamps
  // from PostToolUse:Bash rows and is the follow-up that restores live
  // edges on historical data. This test asserts the shape (columns added,
  // index present, backfill ran without throwing) — the per-event stamps
  // are deliberately NULL until the v19→v20 step lands.
  const evRows = db
    .prepare(
      `SELECT id, ts, session_id, plan_op, plan_target,
              plan_epic_id, plan_task_id, plan_subject_present
         FROM events
        WHERE hook_event = 'PreToolUse' AND tool_name = 'Bash'
        ORDER BY id ASC`,
    )
    .all() as {
    id: number;
    ts: number;
    session_id: string;
    plan_op: string | null;
    plan_target: string | null;
    plan_epic_id: string | null;
    plan_task_id: string | null;
    plan_subject_present: number | null;
  }[];
  // Every PreToolUse:Bash row is left NULL — the deriver no longer
  // recognizes the PreToolUse gate.
  for (const r of evRows) {
    expect(r.plan_op).toBeNull();
    expect(r.plan_target).toBeNull();
    expect(r.plan_epic_id).toBeNull();
    expect(r.plan_task_id).toBeNull();
    expect(r.plan_subject_present).toBeNull();
  }

  // jobs / epics projection rows do NOT survive the v16→v17
  // rewind-and-redrain: openDb runs both v14 (which would have populated
  // them) and v17 (which DELETEs every row in jobs + epics +
  // subagent_invocations) inside the same migrate() transaction. The
  // daemon's post-migrate boot drain rebuilds the projection from the
  // event log — but task .5's live reducer fan-out hasn't landed, so
  // `epic_links` / `job_links` stay at their column defaults until a
  // future drain after that task ships. This test asserts the rewind
  // shape (rows are gone) without depending on the not-yet-implemented
  // live fan-out.
  const jobsCount = db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as {
    n: number;
  };
  expect(jobsCount.n).toBe(0);
  const epicsCount = db.prepare("SELECT COUNT(*) AS n FROM epics").get() as {
    n: number;
  };
  expect(epicsCount.n).toBe(0);

  // Second open is idempotent — the version guard suppresses the
  // backfill re-run; column ADDs no-op on the now-current shape; the
  // projection state persists unchanged.
  const epicsBefore = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  const jobsBefore = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  const eventsBefore = db.query("SELECT * FROM events ORDER BY id").all();
  db.close();
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe(String(SCHEMA_VERSION));
  const epicsAfter = db2.query("SELECT * FROM epics ORDER BY epic_id").all();
  const jobsAfter = db2.query("SELECT * FROM jobs ORDER BY job_id").all();
  const eventsAfter = db2.query("SELECT * FROM events ORDER BY id").all();
  expect(epicsAfter).toEqual(epicsBefore);
  expect(jobsAfter).toEqual(jobsBefore);
  expect(eventsAfter).toEqual(eventsBefore);
  db2.close();
});

// ---------------------------------------------------------------------------
// Schema v17 — events.tool_use_id + subagent_invocations peer table
// ---------------------------------------------------------------------------

test("fresh openDb at v17 has events.tool_use_id + subagent_invocations table with correct shapes", () => {
  const { db } = openDb(":memory:");
  // events.tool_use_id is a sparse top-level TEXT column with no default.
  const eventCols = db.prepare("PRAGMA table_info(events)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const tuid = eventCols.find((c) => c.name === "tool_use_id");
  expect(tuid).toBeDefined();
  expect(tuid?.type).toBe("TEXT");
  expect(tuid?.notnull).toBe(0);
  expect(tuid?.dflt_value).toBeNull();

  // subagent_invocations peer table exists with the spec'd columns +
  // defaults.
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  const tableNames = new Set(tables.map((t) => t.name));
  expect(tableNames.has("subagent_invocations")).toBe(true);

  const sCols = db.prepare("PRAGMA table_info(subagent_invocations)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }[];
  const sByName = new Map(sCols.map((c) => [c.name, c]));
  expect(sByName.get("job_id")?.type).toBe("TEXT");
  expect(sByName.get("job_id")?.notnull).toBe(1);
  expect(sByName.get("agent_id")?.type).toBe("TEXT");
  expect(sByName.get("agent_id")?.notnull).toBe(1);
  expect(sByName.get("turn_seq")?.type).toBe("INTEGER");
  expect(sByName.get("turn_seq")?.notnull).toBe(1);
  expect(sByName.get("ts")?.type).toBe("REAL");
  expect(sByName.get("ts")?.notnull).toBe(1);
  expect(sByName.get("tool_use_id")?.type).toBe("TEXT");
  expect(sByName.get("subagent_type")?.type).toBe("TEXT");
  expect(sByName.get("description")?.type).toBe("TEXT");
  expect(sByName.get("prompt_chars")?.type).toBe("INTEGER");
  expect(sByName.get("prompt_chars")?.notnull).toBe(1);
  expect(sByName.get("prompt_chars")?.dflt_value).toBe("0");
  expect(sByName.get("status")?.type).toBe("TEXT");
  expect(sByName.get("status")?.notnull).toBe(1);
  expect(sByName.get("status")?.dflt_value).toBe("'running'");
  expect(sByName.get("duration_ms")?.type).toBe("INTEGER");
  expect(sByName.get("last_event_id")?.type).toBe("INTEGER");
  expect(sByName.get("last_event_id")?.notnull).toBe(1);
  expect(sByName.get("updated_at")?.type).toBe("REAL");
  expect(sByName.get("updated_at")?.notnull).toBe(1);

  // Composite primary key is `(job_id, agent_id, turn_seq)`. PRAGMA
  // table_info's `pk` field carries the 1-based PK column ordinal (0 for
  // non-PK columns).
  expect(sByName.get("job_id")?.pk).toBe(1);
  expect(sByName.get("agent_id")?.pk).toBe(2);
  expect(sByName.get("turn_seq")?.pk).toBe(3);

  // v17 indexes are present.
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all() as { name: string }[];
  const indexNames = new Set(indexes.map((i) => i.name));
  expect(indexNames.has("idx_events_tool_use_id")).toBe(true);
  expect(indexNames.has("idx_subagent_invocations_job")).toBe(true);
  db.close();
});

test("v16 DB migrates to v17: tool_use_id column + subagent_invocations + partial index + backfill, idempotent re-run", () => {
  // Build a v16-shaped DB by hand: events + jobs + epics + reducer_state +
  // meta at the v16 shape (no tool_use_id, no subagent_invocations),
  // version '16'. Seed a mix of events whose `data` blobs do / do not
  // carry `tool_use_id` so the backfill has work to verify.
  const v16 = new Database(dbPath, { create: true });
  v16.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      matcher TEXT,
      cwd TEXT,
      permission_mode TEXT,
      agent_id TEXT,
      agent_type TEXT,
      stop_hook_active INTEGER,
      data TEXT NOT NULL,
      subagent_agent_id TEXT,
      spawn_name TEXT,
      start_time TEXT,
      slash_command TEXT,
      skill_name TEXT,
      planctl_op TEXT,
      planctl_target TEXT,
      planctl_epic_id TEXT,
      planctl_task_id TEXT,
      planctl_subject_present INTEGER
    )
  `);
  v16.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT,
      start_time TEXT,
      plan_verb TEXT,
      plan_ref TEXT,
      epic_links TEXT NOT NULL DEFAULT '[]'
    )
  `);
  v16.run(`
    CREATE TABLE epics (
      epic_id TEXT PRIMARY KEY,
      epic_number INTEGER,
      title TEXT,
      project_dir TEXT,
      status TEXT,
      approval TEXT NOT NULL DEFAULT 'pending',
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0,
      tasks TEXT NOT NULL DEFAULT '[]',
      depends_on_epics TEXT NOT NULL DEFAULT '[]',
      jobs TEXT NOT NULL DEFAULT '[]',
      job_links TEXT NOT NULL DEFAULT '[]',
      last_validated_at TEXT
    )
  `);
  v16.run(`
    CREATE TABLE reducer_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_event_id INTEGER NOT NULL DEFAULT 0,
      updated_at REAL NOT NULL
    )
  `);
  v16.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v16.run("INSERT INTO meta (key, value) VALUES ('schema_version', '16')");
  v16.run(
    "INSERT INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 0, 1)",
  );

  // Seed events with a mix of tool_use_id presence.
  const insertEvent = v16.prepare(
    "INSERT INTO events (ts, session_id, hook_event, event_type, tool_name, data) VALUES (?, ?, ?, ?, ?, ?)",
  );
  // Has tool_use_id (PreToolUse:Bash).
  insertEvent.run(
    1,
    "sess-a",
    "PreToolUse",
    "pre_tool_use",
    "Bash",
    JSON.stringify({
      tool_use_id: "toolu_AAA",
      tool_input: { command: "echo hi" },
    }),
  );
  // Has tool_use_id (PostToolUse:Agent).
  insertEvent.run(
    2,
    "sess-a",
    "PostToolUse",
    "tool_use",
    "Agent",
    JSON.stringify({ tool_use_id: "toolu_BBB", tool_response: {} }),
  );
  // No tool_use_id (SessionStart).
  insertEvent.run(
    3,
    "sess-a",
    "SessionStart",
    "session_start",
    null,
    JSON.stringify({ cwd: "/tmp" }),
  );
  // Malformed JSON blob — json_valid must skip without throwing.
  insertEvent.run(
    4,
    "sess-a",
    "UserPromptSubmit",
    "user_prompt_submit",
    null,
    "{not valid json",
  );
  // Has tool_use_id (PreToolUse:Read).
  insertEvent.run(
    5,
    "sess-b",
    "PreToolUse",
    "pre_tool_use",
    "Read",
    JSON.stringify({
      tool_use_id: "toolu_CCC",
      tool_input: { file_path: "/x" },
    }),
  );
  v16.close();

  // Reopen via openDb — migrate() runs the v16→v17 idempotent ADD COLUMN,
  // creates `subagent_invocations`, builds the partial index, runs the
  // version-guarded SQL backfill via json_extract, and rewinds the
  // cursor.
  const { db } = openDb(dbPath);

  // Schema version stamp.
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  // events.tool_use_id exists.
  const eventNames = (
    db.prepare("PRAGMA table_info(events)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(eventNames).toContain("tool_use_id");

  // subagent_invocations table exists.
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'subagent_invocations'",
    )
    .get();
  expect(tables).not.toBeNull();

  // Partial index landed.
  const indexNames = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as { name: string }[]
    ).map((i) => i.name),
  );
  expect(indexNames.has("idx_events_tool_use_id")).toBe(true);
  expect(indexNames.has("idx_subagent_invocations_job")).toBe(true);

  // Backfill: events.tool_use_id populated from json_extract for rows whose
  // data carries it; NULL for rows without it; malformed-JSON rows stay
  // NULL (json_valid gates the extract).
  const rows = db
    .prepare("SELECT ts, tool_use_id FROM events ORDER BY ts")
    .all() as { ts: number; tool_use_id: string | null }[];
  const byTs = new Map(rows.map((r) => [r.ts, r.tool_use_id]));
  expect(byTs.get(1)).toBe("toolu_AAA");
  expect(byTs.get(2)).toBe("toolu_BBB");
  expect(byTs.get(3)).toBeNull();
  expect(byTs.get(4)).toBeNull();
  expect(byTs.get(5)).toBe("toolu_CCC");

  // Rewind happened: reducer_state.last_event_id is back to 0, projection
  // rows wiped (no projections to seed in this fixture, so just assert
  // the cursor). subagent_invocations is empty (no reducer cases yet).
  const cursor = db
    .prepare("SELECT last_event_id FROM reducer_state WHERE id = 1")
    .get() as { last_event_id: number };
  expect(cursor.last_event_id).toBe(0);
  const sCount = db
    .prepare("SELECT COUNT(*) AS n FROM subagent_invocations")
    .get() as { n: number };
  expect(sCount.n).toBe(0);

  // Second openDb is idempotent — version guard suppresses the backfill
  // re-run; the ADD COLUMN no-ops on the now-current shape; the projection
  // state persists unchanged.
  const eventsBefore = db
    .query("SELECT id, tool_use_id FROM events ORDER BY id")
    .all();
  db.close();
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe(String(SCHEMA_VERSION));
  const eventsAfter = db2
    .query("SELECT id, tool_use_id FROM events ORDER BY id")
    .all();
  expect(eventsAfter).toEqual(eventsBefore);
  db2.close();
});

// ---------------------------------------------------------------------------
// Schema v20 — re-stamp planctl_* from PostToolUse:Bash envelope + projection
// re-derive (fn-606 task .2)
// ---------------------------------------------------------------------------

test("v19 DB migrates to v20: PreToolUse:Bash stamps wiped, PostToolUse:Bash re-stamped from envelope, projections re-derived with scaffold-as-creator", () => {
  // Build a v19-shaped DB with hand-stamped PreToolUse:Bash rows carrying
  // the structurally-wrong v14 shape (op='epic' target='close' on a
  // two-word `planctl epic close fn-…` invocation, plus a correctly-shaped
  // `epic-create` stamp from a hyphenated one-word verb). Pair each with a
  // PostToolUse:Bash row whose `data.tool_response.stdout` carries a
  // `plan_invocation` envelope. After v20, the PreToolUse stamps must
  // be NULL across the board and the PostToolUse stamps must reflect the
  // envelope's authoritative shape, including a scaffold → creator edge.
  //
  // Sessions:
  //   sess-creator-scaffold — opens a /plan:plan window, runs
  //     `planctl scaffold fn-7-scaff` (the canonical create path on
  //     keeper); envelope has op='scaffold' target='fn-7-scaff'
  //     subject!=null. After v20 this should drive a creator edge in
  //     jobs.epic_links and a creator entry in epics.job_links.
  //   sess-refiner-twoword — opens a /plan:plan window, runs
  //     `planctl epic close fn-7-scaff` (two-word verb form: this is the
  //     exact shape that v14 mis-stamped op='epic' target='close'). The
  //     PostToolUse envelope writes the authoritative op='epic-close'
  //     target='fn-7-scaff'. Then runs `planctl epic set-title fn-7-scaff
  //     "Renamed"` — a subject-bearing refiner verb that drives a refiner
  //     edge through the classifier (which requires subject_present).
  const v19 = new Database(dbPath, { create: true });
  v19.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      matcher TEXT,
      cwd TEXT,
      permission_mode TEXT,
      agent_id TEXT,
      agent_type TEXT,
      stop_hook_active INTEGER,
      data TEXT NOT NULL,
      subagent_agent_id TEXT,
      spawn_name TEXT,
      start_time TEXT,
      slash_command TEXT,
      skill_name TEXT,
      planctl_op TEXT,
      planctl_target TEXT,
      planctl_epic_id TEXT,
      planctl_task_id TEXT,
      planctl_subject_present INTEGER,
      tool_use_id TEXT
    )
  `);
  v19.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT,
      start_time TEXT,
      plan_verb TEXT,
      plan_ref TEXT,
      epic_links TEXT NOT NULL DEFAULT '[]',
      rate_limited_at REAL
    )
  `);
  v19.run(`
    CREATE TABLE epics (
      epic_id TEXT PRIMARY KEY,
      epic_number INTEGER,
      title TEXT,
      project_dir TEXT,
      status TEXT,
      approval TEXT NOT NULL DEFAULT 'pending',
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0,
      tasks TEXT NOT NULL DEFAULT '[]',
      depends_on_epics TEXT NOT NULL DEFAULT '[]',
      jobs TEXT NOT NULL DEFAULT '[]',
      job_links TEXT NOT NULL DEFAULT '[]',
      last_validated_at TEXT
    )
  `);
  v19.run(`
    CREATE TABLE reducer_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_event_id INTEGER NOT NULL DEFAULT 0,
      updated_at REAL NOT NULL
    )
  `);
  v19.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v19.run("INSERT INTO meta (key, value) VALUES ('schema_version', '19')");
  v19.run(
    "INSERT INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 0, 1)",
  );

  // Seed events. PreToolUse:Bash rows carry the v14-stamped shape (we
  // hand-set the columns to mimic what the old regex deriver would have
  // produced); PostToolUse:Bash rows carry the envelope on stdout.
  const insertEvent = v19.prepare(
    `INSERT INTO events (
       ts, session_id, hook_event, event_type, tool_name, data, skill_name,
       planctl_op, planctl_target, planctl_epic_id, planctl_task_id,
       planctl_subject_present
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // sess-creator-scaffold
  insertEvent.run(
    1,
    "sess-creator-scaffold",
    "SessionStart",
    "session_start",
    null,
    "{}",
    null,
    null,
    null,
    null,
    null,
    null,
  );
  insertEvent.run(
    10,
    "sess-creator-scaffold",
    "PreToolUse",
    "pre_tool_use",
    "Skill",
    JSON.stringify({ tool_input: { skill: "plan:plan" } }),
    "plan:plan",
    null,
    null,
    null,
    null,
    null,
  );
  // The PreToolUse:Bash for the scaffold — historically the regex deriver
  // matched 'scaffold' as a write verb (it wasn't in the readonly
  // allowlist) and stamped op='scaffold' target='fn-7-scaff'. Whatever
  // shape it stamped, v20 Pass 0 must NULL it.
  insertEvent.run(
    20,
    "sess-creator-scaffold",
    "PreToolUse",
    "pre_tool_use",
    "Bash",
    JSON.stringify({
      tool_input: { command: "planctl scaffold fn-7-scaff 'Scaffolded title'" },
    }),
    null,
    "scaffold",
    "fn-7-scaff",
    "fn-7-scaff",
    null,
    1,
  );
  // Matching PostToolUse:Bash with the authoritative envelope on stdout.
  insertEvent.run(
    21,
    "sess-creator-scaffold",
    "PostToolUse",
    "post_tool_use",
    "Bash",
    JSON.stringify({
      tool_input: { command: "planctl scaffold fn-7-scaff 'Scaffolded title'" },
      tool_response: {
        stdout: JSON.stringify({
          plan_invocation: {
            op: "scaffold",
            target: "fn-7-scaff",
            subject: "Scaffolded title",
          },
        }),
      },
    }),
    null,
    null,
    null,
    null,
    null,
    null,
  );

  // sess-refiner-twoword — the two-word verb regex bug.
  insertEvent.run(
    35,
    "sess-refiner-twoword",
    "SessionStart",
    "session_start",
    null,
    "{}",
    null,
    null,
    null,
    null,
    null,
    null,
  );
  insertEvent.run(
    40,
    "sess-refiner-twoword",
    "PreToolUse",
    "pre_tool_use",
    "Skill",
    JSON.stringify({ tool_input: { skill: "plan:plan" } }),
    "plan:plan",
    null,
    null,
    null,
    null,
    null,
  );
  // Wrong v14 shape on the PreToolUse row: the regex captured the first
  // two tokens and stamped op='epic' target='close' instead of op='epic-close'
  // target='fn-7-scaff'. We hand-seed exactly that broken shape.
  insertEvent.run(
    50,
    "sess-refiner-twoword",
    "PreToolUse",
    "pre_tool_use",
    "Bash",
    JSON.stringify({
      tool_input: { command: "planctl epic close fn-7-scaff" },
    }),
    null,
    "epic",
    "close",
    null,
    null,
    0,
  );
  insertEvent.run(
    51,
    "sess-refiner-twoword",
    "PostToolUse",
    "post_tool_use",
    "Bash",
    JSON.stringify({
      tool_input: { command: "planctl epic close fn-7-scaff" },
      tool_response: {
        stdout: JSON.stringify({
          plan_invocation: {
            op: "epic-close",
            target: "fn-7-scaff",
          },
        }),
      },
    }),
    null,
    null,
    null,
    null,
    null,
    null,
  );
  // Subject-bearing refiner — the one that actually drives a refiner edge
  // through the classifier's `subject_present` gate.
  insertEvent.run(
    60,
    "sess-refiner-twoword",
    "PreToolUse",
    "pre_tool_use",
    "Bash",
    JSON.stringify({
      tool_input: {
        command: "planctl epic set-title fn-7-scaff 'Renamed'",
      },
    }),
    null,
    "epic",
    "set-title",
    null,
    null,
    1,
  );
  insertEvent.run(
    61,
    "sess-refiner-twoword",
    "PostToolUse",
    "post_tool_use",
    "Bash",
    JSON.stringify({
      tool_input: {
        command: "planctl epic set-title fn-7-scaff 'Renamed'",
      },
      tool_response: {
        stdout: JSON.stringify({
          plan_invocation: {
            op: "epic-set-title",
            target: "fn-7-scaff",
            subject: "Renamed",
          },
        }),
      },
    }),
    null,
    null,
    null,
    null,
    null,
    null,
  );

  // Seed jobs rows for both sessions (SessionStart implies a jobs row).
  const insertJob = v19.prepare(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at) VALUES (?, ?, ?, ?)",
  );
  insertJob.run("sess-creator-scaffold", 1, 4, 1);
  insertJob.run("sess-refiner-twoword", 35, 9, 35);
  v19.close();

  // Reopen via openDb — runs the v19→v20 migration block AND the
  // v20→v21 enrichment widen-shape pass AND the v23→v24 rewind-and-
  // redrain. The rewind wipes `jobs` / `epics` / `subagent_invocations`
  // and resets `reducer_state.last_event_id = 0`; drainAll re-folds the
  // seeded event log from scratch through the v24 reducer so the
  // projections come back with the v24 shape.
  const { db } = openDb(dbPath);
  drainAll(db);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  // Pass 0 — every PreToolUse:Bash row's plan_* columns are now NULL.
  const preRows = db
    .prepare(
      `SELECT id, plan_op, plan_target, plan_epic_id,
              plan_task_id, plan_subject_present
         FROM events
        WHERE hook_event = 'PreToolUse' AND tool_name = 'Bash'
        ORDER BY id ASC`,
    )
    .all() as {
    id: number;
    plan_op: string | null;
    plan_target: string | null;
    plan_epic_id: string | null;
    plan_task_id: string | null;
    plan_subject_present: number | null;
  }[];
  for (const r of preRows) {
    expect(r.plan_op).toBeNull();
    expect(r.plan_target).toBeNull();
    expect(r.plan_epic_id).toBeNull();
    expect(r.plan_task_id).toBeNull();
    expect(r.plan_subject_present).toBeNull();
  }

  // Pass 1 — PostToolUse:Bash rows carry the envelope's authoritative shape.
  const postRows = db
    .prepare(
      `SELECT session_id, plan_op, plan_target, plan_epic_id,
              plan_task_id, plan_subject_present
         FROM events
        WHERE hook_event = 'PostToolUse' AND tool_name = 'Bash'
        ORDER BY id ASC`,
    )
    .all() as {
    session_id: string;
    plan_op: string | null;
    plan_target: string | null;
    plan_epic_id: string | null;
    plan_task_id: string | null;
    plan_subject_present: number | null;
  }[];
  expect(postRows).toHaveLength(3);
  // sess-creator-scaffold: op='scaffold', target='fn-7-scaff',
  // epic_id='fn-7-scaff', task_id=null, subject_present=1.
  expect(postRows[0]?.session_id).toBe("sess-creator-scaffold");
  expect(postRows[0]?.plan_op).toBe("scaffold");
  expect(postRows[0]?.plan_target).toBe("fn-7-scaff");
  expect(postRows[0]?.plan_epic_id).toBe("fn-7-scaff");
  expect(postRows[0]?.plan_task_id).toBeNull();
  expect(postRows[0]?.plan_subject_present).toBe(1);
  // sess-refiner-twoword: op='epic-close', target='fn-7-scaff' — the
  // two-word verb is now correctly stamped via the envelope, not the
  // broken regex (which would have stamped op='epic' target='close').
  expect(postRows[1]?.session_id).toBe("sess-refiner-twoword");
  expect(postRows[1]?.plan_op).toBe("epic-close");
  expect(postRows[1]?.plan_target).toBe("fn-7-scaff");
  expect(postRows[1]?.plan_epic_id).toBe("fn-7-scaff");
  expect(postRows[1]?.plan_task_id).toBeNull();
  expect(postRows[1]?.plan_subject_present).toBe(0);
  // Second refiner action in the same session, with a subject — drives
  // the actual refiner edge through the classifier.
  expect(postRows[2]?.session_id).toBe("sess-refiner-twoword");
  expect(postRows[2]?.plan_op).toBe("epic-set-title");
  expect(postRows[2]?.plan_target).toBe("fn-7-scaff");
  expect(postRows[2]?.plan_epic_id).toBe("fn-7-scaff");
  expect(postRows[2]?.plan_task_id).toBeNull();
  expect(postRows[2]?.plan_subject_present).toBe(1);

  // Pass 2a — jobs.epic_links populated from the new stamps.
  const creatorJob = db
    .prepare("SELECT epic_links FROM jobs WHERE job_id = ?")
    .get("sess-creator-scaffold") as { epic_links: string };
  const creatorLinks = JSON.parse(creatorJob.epic_links) as {
    kind: string;
    target: string;
  }[];
  expect(creatorLinks).toEqual([{ kind: "creator", target: "fn-7-scaff" }]);

  const refinerJob = db
    .prepare("SELECT epic_links FROM jobs WHERE job_id = ?")
    .get("sess-refiner-twoword") as { epic_links: string };
  const refinerLinks = JSON.parse(refinerJob.epic_links) as {
    kind: string;
    target: string;
  }[];
  expect(refinerLinks).toEqual([{ kind: "refiner", target: "fn-7-scaff" }]);

  // Pass 2b — epics.job_links carries both edges keyed by epic. Shell-insert
  // landed the epic row (no EpicSnapshot has folded for fn-7-scaff in the
  // fixture). The v20→v21 enrichment pass widened each entry from the
  // thin classifier shape `{kind, job_id}` to the enriched projection
  // shape; v23→v24 then renamed `rate_limited_at` into the two-field pair
  // `(last_api_error_at, last_api_error_kind)` — both NULL on every
  // seeded jobs row (no `RateLimited` / `ApiError` event in the fixture).
  // Both seeded jobs rows carry NULL title. Each session fires a
  // PreToolUse/PostToolUse:Bash tool event on the re-fold, which un-stops the
  // SessionStart-resting `'stopped'` row to `'working'` (fn-1056 bare arm) — so
  // the enriched state is `'working'`, not the v19 schema `'stopped'` default.
  const epicRow = db
    .prepare("SELECT epic_id, job_links FROM epics WHERE epic_id = ?")
    .get("fn-7-scaff") as { epic_id: string; job_links: string } | null;
  expect(epicRow).not.toBeNull();
  const jobLinks = JSON.parse(epicRow?.job_links ?? "[]") as {
    kind: string;
    job_id: string;
    title: string | null;
    state: string;
    last_api_error_at: number | null;
    last_api_error_kind: string | null;
    last_input_request_at: number | null;
    last_input_request_kind: string | null;
    last_permission_prompt_at: number | null;
    last_permission_prompt_kind: string | null;
  }[];
  // Sort tiebreaker is `(kind, job_id)` ASC — creator first, then refiner.
  expect(jobLinks).toEqual([
    {
      kind: "creator",
      job_id: "sess-creator-scaffold",
      title: null,
      state: "working",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
      last_permission_prompt_at: null,
      last_permission_prompt_kind: null,
    },
    {
      kind: "refiner",
      job_id: "sess-refiner-twoword",
      title: null,
      state: "working",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
      last_permission_prompt_at: null,
      last_permission_prompt_kind: null,
    },
  ]);

  // Idempotent re-open — version guard suppresses the backfill re-run.
  const epicsBefore = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  const jobsBefore = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  const eventsBefore = db.query("SELECT * FROM events ORDER BY id").all();
  db.close();
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe(String(SCHEMA_VERSION));
  expect(db2.query("SELECT * FROM epics ORDER BY epic_id").all()).toEqual(
    epicsBefore,
  );
  expect(db2.query("SELECT * FROM jobs ORDER BY job_id").all()).toEqual(
    jobsBefore,
  );
  expect(db2.query("SELECT * FROM events ORDER BY id").all()).toEqual(
    eventsBefore,
  );
  db2.close();
});

// ---------------------------------------------------------------------------
// Schema v21 — widen `epics.job_links` entry shape from `{kind, job_id}` to
// `{kind, job_id, title, state, rate_limited_at}` denormalized off the
// linked `jobs` row at the reducer's write boundary (fn-612 task .1).
// ---------------------------------------------------------------------------

test("v20 DB migrates to v21: epics.job_links entries widen from thin {kind, job_id} to enriched {kind, job_id, title, state, rate_limited_at}; orphan entries retain with safe defaults", () => {
  // Build a v20-shaped DB carrying the thin classifier-output shape on
  // `epics.job_links`. After v21, every entry must carry the three
  // denormalized fields read off the linked `jobs` row (or safe
  // defaults when the row is missing — orphan retention).
  //
  // Coverage:
  //   - Live entry (jobs row present, mid-lifecycle, non-default
  //     title/state/rate_limited_at) — enrichment reads all three off
  //     the jobs row.
  //   - Default entry (jobs row present, schema defaults — null title,
  //     state=stopped, null rate_limited_at) — enrichment reads
  //     defaults off the row, NOT the orphan-row defaults branch.
  //   - Orphan entry (no jobs row for the job_id) — enrichment folds
  //     to safe defaults (title: null, state: "stopped",
  //     rate_limited_at: null) and the entry is retained (NOT dropped),
  //     so re-fold determinism holds.
  const v20 = new Database(dbPath, { create: true });
  v20.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      matcher TEXT,
      cwd TEXT,
      permission_mode TEXT,
      agent_id TEXT,
      agent_type TEXT,
      stop_hook_active INTEGER,
      data TEXT NOT NULL,
      subagent_agent_id TEXT,
      spawn_name TEXT,
      start_time TEXT,
      slash_command TEXT,
      skill_name TEXT,
      planctl_op TEXT,
      planctl_target TEXT,
      planctl_epic_id TEXT,
      planctl_task_id TEXT,
      planctl_subject_present INTEGER,
      tool_use_id TEXT
    )
  `);
  v20.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT,
      start_time TEXT,
      plan_verb TEXT,
      plan_ref TEXT,
      epic_links TEXT NOT NULL DEFAULT '[]',
      rate_limited_at REAL
    )
  `);
  v20.run(`
    CREATE TABLE epics (
      epic_id TEXT PRIMARY KEY,
      epic_number INTEGER,
      title TEXT,
      project_dir TEXT,
      status TEXT,
      approval TEXT NOT NULL DEFAULT 'pending',
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0,
      tasks TEXT NOT NULL DEFAULT '[]',
      depends_on_epics TEXT NOT NULL DEFAULT '[]',
      jobs TEXT NOT NULL DEFAULT '[]',
      job_links TEXT NOT NULL DEFAULT '[]',
      last_validated_at TEXT
    )
  `);
  v20.run(`
    CREATE TABLE reducer_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_event_id INTEGER NOT NULL DEFAULT 0,
      updated_at REAL NOT NULL
    )
  `);
  v20.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v20.run("INSERT INTO meta (key, value) VALUES ('schema_version', '20')");
  v20.run(
    "INSERT INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 0, 1)",
  );

  // Seed two jobs rows for enrichment + one orphan reference.
  const insertJob = v20.prepare(
    `INSERT INTO jobs (
       job_id, created_at, state, last_event_id, updated_at,
       title, rate_limited_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  // Live entry — mid-lifecycle, rich enrichment payload.
  insertJob.run("sess-live", 100, "working", 5, 100, "Live session", 200);
  // Default entry — fresh SessionStart-only row with all-default columns.
  insertJob.run("sess-default", 50, "stopped", 1, 50, null, null);

  // Seed one epic carrying the thin v20 shape on `job_links` — three
  // entries: live, default, orphan (no matching jobs row).
  v20
    .prepare(
      `INSERT INTO epics (
       epic_id, epic_number, title, last_event_id, updated_at, job_links
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "fn-21-widen",
      21,
      "Widen Shape",
      9,
      100,
      JSON.stringify([
        { kind: "creator", job_id: "sess-live" },
        { kind: "refiner", job_id: "sess-default" },
        { kind: "refiner", job_id: "sess-orphan" },
      ]),
    );
  v20.close();

  // Reopen via openDb — triggers the full migration chain through
  // v20→v21 (entry-shape enrichment) AND v23→v24 (rewind-and-redrain).
  // The v23→v24 step wipes `jobs` / `epics` / `subagent_invocations`
  // and rewinds `reducer_state.last_event_id` to 0, so post-migration
  // the projection is rebuilt from scratch by the boot drain. This
  // fixture seeds NO events (only direct projection rows on a v20 DB),
  // so the rebuilt projection is empty. The v20→v21 enrichment still
  // ran inside the migration transaction (proved by `addColumnIfMissing`
  // / loop structure being preserved), but its output was immediately
  // wiped by v23→v24's rewind. The MEANINGFUL gate this test exercises
  // post-v24 is: the migration chain completes WITHOUT THROWING despite
  // running enrichment SELECTs that reference the now-dropped
  // `rate_limited_at` column on a fresh-CREATE jobs table (the column
  // is added back by `addColumnIfMissing` at v17→v18 step, then
  // dropped again at v23→v24 — both steps in the same transaction).
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  // Post-migration: the v23→v24 rewind wiped epics + jobs; the boot
  // drain has nothing to rebuild from (no events seeded), so the
  // tables are empty.
  const epicRow = db
    .prepare("SELECT job_links FROM epics WHERE epic_id = ?")
    .get("fn-21-widen") as { job_links: string } | null;
  expect(epicRow).toBeNull();
  expect(
    db.query("SELECT count(*) AS c FROM jobs").get() as { c: number },
  ).toEqual({ c: 0 });

  // Idempotent re-open — version guard suppresses the v23→v24 rewind on
  // a second open (the meta row was stamped to '24' on the first open).
  const epicsBefore = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  const jobsBefore = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  db.close();
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe(String(SCHEMA_VERSION));
  expect(db2.query("SELECT * FROM epics ORDER BY epic_id").all()).toEqual(
    epicsBefore,
  );
  expect(db2.query("SELECT * FROM jobs ORDER BY job_id").all()).toEqual(
    jobsBefore,
  );
  db2.close();
});

test("v20 DB migrates to v21: malformed (non-JSON) epics.job_links blob folds to '[]' without throwing (never-throw-inside-migrate invariant)", () => {
  // CLAUDE.md invariant: "NEVER throw inside the open BEGIN IMMEDIATE
  // transaction — a throw rolls back the cursor and wedges the reducer."
  // The v20→v21 enrichment pass at src/db.ts wraps the per-row JSON.parse
  // in try/catch so a corrupt blob folds to []. Pin that guard against a
  // future refactor that might drop the try/catch.
  //
  // Build a minimal v20 DB carrying a non-JSON string in `epics.job_links`
  // for one epic. After openDb runs the migration block, the column must
  // be `'[]'` and the schema_version must have advanced to 21 — proving
  // the migration neither threw nor rolled back.
  const v20 = new Database(dbPath, { create: true });
  v20.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      matcher TEXT,
      cwd TEXT,
      permission_mode TEXT,
      agent_id TEXT,
      agent_type TEXT,
      stop_hook_active INTEGER,
      data TEXT NOT NULL,
      subagent_agent_id TEXT,
      spawn_name TEXT,
      start_time TEXT,
      slash_command TEXT,
      skill_name TEXT,
      planctl_op TEXT,
      planctl_target TEXT,
      planctl_epic_id TEXT,
      planctl_task_id TEXT,
      planctl_subject_present INTEGER,
      tool_use_id TEXT
    )
  `);
  v20.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT,
      start_time TEXT,
      plan_verb TEXT,
      plan_ref TEXT,
      epic_links TEXT NOT NULL DEFAULT '[]',
      rate_limited_at REAL
    )
  `);
  v20.run(`
    CREATE TABLE epics (
      epic_id TEXT PRIMARY KEY,
      epic_number INTEGER,
      title TEXT,
      project_dir TEXT,
      status TEXT,
      approval TEXT NOT NULL DEFAULT 'pending',
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0,
      tasks TEXT NOT NULL DEFAULT '[]',
      depends_on_epics TEXT NOT NULL DEFAULT '[]',
      jobs TEXT NOT NULL DEFAULT '[]',
      job_links TEXT NOT NULL DEFAULT '[]',
      last_validated_at TEXT
    )
  `);
  v20.run(`
    CREATE TABLE reducer_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_event_id INTEGER NOT NULL DEFAULT 0,
      updated_at REAL NOT NULL
    )
  `);
  v20.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v20.run("INSERT INTO meta (key, value) VALUES ('schema_version', '20')");
  v20.run(
    "INSERT INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 0, 1)",
  );

  // Hand-write a non-JSON string into `epics.job_links` for one epic.
  // The migration's safe-parse must fold this to [] and emit '[]' in
  // the UPDATE, NOT throw.
  v20
    .prepare(
      `INSERT INTO epics (
       epic_id, epic_number, title, last_event_id, updated_at, job_links
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("fn-21-corrupt", 21, "Corrupt Blob", 1, 100, "not-json{[");
  v20.close();

  // Reopen via openDb — the full migration chain v20→v24 must complete
  // cleanly (v20→v21 enrichment runs without throwing on the malformed
  // blob; v23→v24 rewind then wipes the epic row entirely). The MEANINGFUL
  // gate post-v24 is that the chain advances to '24' WITHOUT THROWING
  // despite the corrupt blob — proving the v20→v21 enrichment's safe-parse
  // try/catch still holds (a throw inside migrate() would roll back the
  // surrounding BEGIN IMMEDIATE and wedge the upgrade).
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  // Post-rewind: the corrupt epic row is wiped along with the rest of the
  // projection (no events seeded → empty rebuild).
  const epicRow = db
    .prepare("SELECT job_links FROM epics WHERE epic_id = ?")
    .get("fn-21-corrupt") as { job_links: string } | null;
  expect(epicRow).toBeNull();
  db.close();
});

test("v21 DB migrates to v22: events.config_dir + jobs.config_dir added, rows preserved NULL, idempotent re-open", () => {
  // Build a v21-shaped DB by hand: events without config_dir, jobs without
  // config_dir, schema_version '21'. Mirrors the v3→v4 spawn_name migration
  // test — the canonical sparse-column ADD-COLUMN pattern. Existing rows
  // must read NULL after the upgrade (no backfill — pre-feature SessionStart
  // events have no recoverable env), and a second openDb must be a no-op.
  const v21 = new Database(dbPath, { create: true });
  v21.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      matcher TEXT,
      cwd TEXT,
      permission_mode TEXT,
      agent_id TEXT,
      agent_type TEXT,
      stop_hook_active INTEGER,
      data TEXT NOT NULL,
      subagent_agent_id TEXT,
      spawn_name TEXT,
      start_time TEXT,
      slash_command TEXT,
      skill_name TEXT,
      planctl_op TEXT,
      planctl_target TEXT,
      planctl_epic_id TEXT,
      planctl_task_id TEXT,
      planctl_subject_present INTEGER,
      tool_use_id TEXT
    )
  `);
  v21.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT,
      start_time TEXT,
      plan_verb TEXT,
      plan_ref TEXT,
      epic_links TEXT NOT NULL DEFAULT '[]',
      rate_limited_at REAL
    )
  `);
  v21.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v21.run("INSERT INTO meta (key, value) VALUES ('schema_version', '21')");
  // Seed one row each so we can assert preservation. The events row is a
  // SessionStart shape; the jobs row stands in for a pre-existing projection
  // (the v11 rewind would normally wipe this, but the v11 block only runs on
  // a DB whose stored version < 11 — we stamp '21' so the projection survives).
  v21.run(
    "INSERT INTO events (ts, session_id, hook_event, event_type, data) VALUES (1, 'sess-pre', 'SessionStart', 'session_start', '{}')",
  );
  v21.run(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, title) VALUES ('sess-pre', 1, 1, 1, 'pre-feature')",
  );
  v21.close();

  // Reopen via openDb — migrate() runs the v21→v22 idempotent ADD COLUMNs
  // and the v23→v24 rewind-and-redrain. The full migration chain advances
  // to '24'; ADD COLUMN survives every step (column presence is what this
  // test gates on for the v21→v22 step); the boot drain rebuilds the
  // `jobs` projection from the seeded SessionStart event so the row
  // returns with `title=NULL` (no payload title in the event) — distinct
  // from the pre-rewind "pre-feature" hand-seeded title.
  const { db } = openDb(dbPath);
  drainAll(db);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  const eventCols = (
    db.prepare("PRAGMA table_info(events)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(eventCols).toContain("config_dir");
  const jobCols = (
    db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(jobCols).toContain("config_dir");

  // The events row is preserved (the event log is immutable and outside
  // the rewind's DELETE list). config_dir stays NULL since the row pre-
  // dated the env-capture feature.
  const ev = db
    .prepare(
      "SELECT session_id, config_dir FROM events WHERE session_id = 'sess-pre'",
    )
    .get() as { session_id: string; config_dir: string | null };
  expect(ev.config_dir).toBeNull();
  // The jobs row was rebuilt from the SessionStart event by the post-
  // rewind boot drain — title is NULL (the event has no payload title)
  // and config_dir is NULL (no env captured pre-feature).
  const job = db
    .prepare("SELECT title, config_dir FROM jobs WHERE job_id = 'sess-pre'")
    .get() as { title: string | null; config_dir: string | null };
  expect(job.title).toBeNull();
  expect(job.config_dir).toBeNull();

  db.close();

  // Idempotent re-open: second openDb must be a no-op (addColumnIfMissing
  // guards on column presence; migrate stays version-stamped at 22).
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe(String(SCHEMA_VERSION));
  db2.close();
});

test("openDb against a current-version DB leaves a seeded .planctl tree byte-identical (fn-759 boot-safety pin)", () => {
  // fn-759 DELETED the v13 approval FS backfill — the boot-time pass that
  // rewrote `.planctl` epic files. This pin proves the regression engine is
  // gone: seed a post-fn-756-shaped plan tree (epic + task JSONs that carry NO
  // `approval` field — the live committed shape), run the boot path that
  // previously fired the backfill against a current-version DB, and assert
  // every file is BYTE-identical afterward (content hash, not mtime).
  const { mkdirSync, readFileSync, writeFileSync, readdirSync } =
    require("node:fs") as typeof import("node:fs");
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const planRoot = join(tmpDir, "boot-safety-root");
  const epicsDir = join(planRoot, ".planctl", "epics");
  const tasksDir = join(planRoot, ".planctl", "tasks");
  mkdirSync(epicsDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  // Post-fn-756 shape: NO `approval` field anywhere — the old backfill would
  // have injected `approval: "approved"` into each epic file.
  writeFileSync(
    join(epicsDir, "fn-1-foo.json"),
    JSON.stringify({ id: "fn-1-foo", title: "Foo", status: "open" }, null, 2),
  );
  writeFileSync(
    join(epicsDir, "fn-2-bar.json"),
    JSON.stringify({ id: "fn-2-bar", title: "Bar", status: "open" }, null, 2),
  );
  writeFileSync(
    join(tasksDir, "fn-1-foo.1.json"),
    JSON.stringify(
      { id: "fn-1-foo.1", epic: "fn-1-foo", title: "T1" },
      null,
      2,
    ),
  );

  // Hash every file in the tree, by relative path, before boot.
  const hashTree = (): Map<string, string> => {
    const out = new Map<string, string>();
    for (const dir of [epicsDir, tasksDir]) {
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        out.set(
          full,
          createHash("sha256").update(readFileSync(full)).digest("hex"),
        );
      }
    }
    return out;
  };
  const before = hashTree();

  // Boot path: open a current-version DB with the plan root resolvable. The
  // deleted backfill ran right after `openDb` returned, against exactly this
  // tree. openDb alone is the SQL half; there is no longer any FS pass to call.
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));
  db.close();

  // Tree is byte-identical — boot mutated nothing.
  const after = hashTree();
  expect(after).toEqual(before);
});

test("resolveConfig: missing file falls back to default ~/code root", () => {
  const original = process.env.KEEPER_CONFIG;
  try {
    process.env.KEEPER_CONFIG = join(tmpDir, "nope.yaml");
    expect(resolveConfig().roots).toEqual(["~/code"]);
  } finally {
    if (original === undefined) delete process.env.KEEPER_CONFIG;
    else process.env.KEEPER_CONFIG = original;
  }
});

test("resolveConfig: KEEPER_CONFIG override parses roots via Bun.YAML", () => {
  const original = process.env.KEEPER_CONFIG;
  try {
    const cfg = join(tmpDir, "config.yaml");
    writeFileSync(cfg, "roots:\n  - ~/code\n  - /tmp/projects\n");
    process.env.KEEPER_CONFIG = cfg;
    expect(resolveConfig().roots).toEqual(["~/code", "/tmp/projects"]);
  } finally {
    if (original === undefined) delete process.env.KEEPER_CONFIG;
    else process.env.KEEPER_CONFIG = original;
  }
});

test("resolveConfig: repo roots default independently and resolve with env overrides", async () => {
  const originalConfig = process.env.KEEPER_CONFIG;
  const originalCreate = process.env.KEEPER_REPO_CREATE_ROOT;
  const originalClone = process.env.KEEPER_REPO_CLONE_ROOT;
  const originalFork = process.env.KEEPER_REPO_FORK_ROOT;
  try {
    const cfg = join(tmpDir, "config.yaml");
    writeFileSync(
      cfg,
      "repo_create_root: ~/made\nrepo_clone_root: /tmp/clones\nrepo_fork_root: /tmp/forks\n",
    );
    process.env.KEEPER_CONFIG = cfg;
    const parsed = resolveConfig();
    expect(parsed.repoCreateRoot).toBe("~/made");
    expect(parsed.repoCloneRoot).toBe("/tmp/clones");
    expect(parsed.repoForkRoot).toBe("/tmp/forks");

    const { homedir } = await import("node:os");
    expect(resolveRepoCreateRoot()).toBe(join(homedir(), "made"));
    expect(resolveRepoCloneRoot()).toBe("/tmp/clones");
    expect(resolveRepoForkRoot()).toBe("/tmp/forks");

    process.env.KEEPER_REPO_CREATE_ROOT = "/env/create";
    process.env.KEEPER_REPO_CLONE_ROOT = "/env/clone";
    process.env.KEEPER_REPO_FORK_ROOT = "/env/fork";
    expect(resolveRepoCreateRoot()).toBe("/env/create");
    expect(resolveRepoCloneRoot()).toBe("/env/clone");
    expect(resolveRepoForkRoot()).toBe("/env/fork");
  } finally {
    if (originalConfig === undefined) delete process.env.KEEPER_CONFIG;
    else process.env.KEEPER_CONFIG = originalConfig;
    if (originalCreate === undefined)
      delete process.env.KEEPER_REPO_CREATE_ROOT;
    else process.env.KEEPER_REPO_CREATE_ROOT = originalCreate;
    if (originalClone === undefined) delete process.env.KEEPER_REPO_CLONE_ROOT;
    else process.env.KEEPER_REPO_CLONE_ROOT = originalClone;
    if (originalFork === undefined) delete process.env.KEEPER_REPO_FORK_ROOT;
    else process.env.KEEPER_REPO_FORK_ROOT = originalFork;
  }
});

test("resolveConfig: missing file carries repo root defaults", () => {
  const original = process.env.KEEPER_CONFIG;
  try {
    process.env.KEEPER_CONFIG = join(tmpDir, "nope-repo-roots.yaml");
    const parsed = resolveConfig();
    expect(parsed.repoCreateRoot).toBe(DEFAULT_REPO_CREATE_ROOT);
    expect(parsed.repoCloneRoot).toBe(DEFAULT_REPO_CLONE_ROOT);
    expect(parsed.repoForkRoot).toBe(DEFAULT_REPO_FORK_ROOT);
  } finally {
    if (original === undefined) delete process.env.KEEPER_CONFIG;
    else process.env.KEEPER_CONFIG = original;
  }
});

test("resolveConfig: malformed YAML and missing roots key fall back to default", () => {
  const original = process.env.KEEPER_CONFIG;
  try {
    const cfg = join(tmpDir, "config.yaml");
    // A document with no roots key.
    writeFileSync(cfg, "other: value\n");
    process.env.KEEPER_CONFIG = cfg;
    expect(resolveConfig().roots).toEqual(["~/code"]);
    // Malformed YAML must not throw past the resolver.
    writeFileSync(cfg, "roots:\n  - [unbalanced\n: : :\n");
    expect(resolveConfig().roots).toEqual(["~/code"]);
  } finally {
    if (original === undefined) delete process.env.KEEPER_CONFIG;
    else process.env.KEEPER_CONFIG = original;
  }
});

// ---------------------------------------------------------------------------
// fn-896: the `exec_backend` toggle is retired — keeper agent is keeper's sole,
// direct launch transport. A stale key falls into the silent-ignore path.
// ---------------------------------------------------------------------------

test("resolveConfig: a stale exec_backend key is silently ignored (no field, siblings intact)", () => {
  const original = process.env.KEEPER_CONFIG;
  try {
    const cfg = join(tmpDir, "config.yaml");
    writeFileSync(
      cfg,
      "roots:\n  - /tmp/projects\nexec_backend: keeper agent\n",
    );
    process.env.KEEPER_CONFIG = cfg;
    const got = resolveConfig();
    expect(got).not.toHaveProperty("execBackend");
    expect(got.roots).toEqual(["/tmp/projects"]);
  } finally {
    if (original === undefined) delete process.env.KEEPER_CONFIG;
    else process.env.KEEPER_CONFIG = original;
  }
});

test("resolveConfig: catch-block defaults carry no exec_backend field", () => {
  const original = process.env.KEEPER_CONFIG;
  try {
    const cfg = join(tmpDir, "config.yaml");
    // Malformed YAML → catch block fires; the returned record carries the kept
    // defaults and no retired `execBackend` field.
    writeFileSync(cfg, "roots:\n  - [unbalanced\n: : :\n");
    process.env.KEEPER_CONFIG = cfg;
    const got = resolveConfig();
    expect(got).not.toHaveProperty("execBackend");
    expect(got.roots).toEqual(["~/code"]);
  } finally {
    if (original === undefined) delete process.env.KEEPER_CONFIG;
    else process.env.KEEPER_CONFIG = original;
  }
});

test("resolvePlanRoots: expands ~, drops non-existent, keeps the good ones", async () => {
  const original = process.env.KEEPER_CONFIG;
  try {
    // tmpDir exists; a sibling path does not. HOME-relative ~ expands to a real
    // dir (homedir always exists).
    const goodAbs = tmpDir;
    const missingAbs = join(tmpDir, "does-not-exist");
    const cfg = join(tmpDir, "config.yaml");
    // Bare `~` is a YAML null literal; quote it so it survives as the string
    // we expand to $HOME (real configs use `~/code`, a plain string).
    writeFileSync(cfg, `roots:\n  - "~"\n  - ${goodAbs}\n  - ${missingAbs}\n`);
    process.env.KEEPER_CONFIG = cfg;

    const roots = resolvePlanRoots();
    // ~ expanded to $HOME (an existing dir); goodAbs kept; missing dropped.
    const { homedir } = await import("node:os");
    expect(roots).toContain(homedir());
    expect(roots).toContain(goodAbs);
    expect(roots).not.toContain(missingAbs);
    expect(roots.every((r) => r.startsWith("/"))).toBe(true);
    // One missing root did not silence the surviving ones.
    expect(roots.length).toBe(2);
  } finally {
    if (original === undefined) delete process.env.KEEPER_CONFIG;
    else process.env.KEEPER_CONFIG = original;
  }
});

test("resolveClaudeProjectsRoot: present key expands ~ to an absolute path", async () => {
  const original = process.env.KEEPER_CONFIG;
  try {
    const cfg = join(tmpDir, "config.yaml");
    writeFileSync(cfg, "claude_projects_root: ~/some/where\n");
    process.env.KEEPER_CONFIG = cfg;
    const { homedir } = await import("node:os");
    expect(resolveClaudeProjectsRoot()).toBe(join(homedir(), "some/where"));
  } finally {
    if (original === undefined) delete process.env.KEEPER_CONFIG;
    else process.env.KEEPER_CONFIG = original;
  }
});

test("resolveClaudeProjectsRoot: absent key defaults to ~/.claude/projects", async () => {
  const original = process.env.KEEPER_CONFIG;
  try {
    const cfg = join(tmpDir, "config.yaml");
    // A config with only `roots`, no claude_projects_root.
    writeFileSync(cfg, "roots:\n  - ~/code\n");
    process.env.KEEPER_CONFIG = cfg;
    const { homedir } = await import("node:os");
    expect(resolveClaudeProjectsRoot()).toBe(
      join(homedir(), ".claude", "projects"),
    );
  } finally {
    if (original === undefined) delete process.env.KEEPER_CONFIG;
    else process.env.KEEPER_CONFIG = original;
  }
});

test("resolveClaudeProjectsRoot: missing file + malformed YAML default to ~/.claude/projects", async () => {
  const original = process.env.KEEPER_CONFIG;
  try {
    const { homedir } = await import("node:os");
    const expected = join(homedir(), ".claude", "projects");
    // Missing file.
    process.env.KEEPER_CONFIG = join(tmpDir, "nope.yaml");
    expect(resolveClaudeProjectsRoot()).toBe(expected);
    // Malformed YAML must not throw past the resolver.
    const cfg = join(tmpDir, "config.yaml");
    writeFileSync(cfg, "claude_projects_root:\n  - [unbalanced\n: : :\n");
    process.env.KEEPER_CONFIG = cfg;
    expect(resolveClaudeProjectsRoot()).toBe(expected);
  } finally {
    if (original === undefined) delete process.env.KEEPER_CONFIG;
    else process.env.KEEPER_CONFIG = original;
  }
});

test("resolveClaudeProjectsRoot: non-string value falls back to the default", async () => {
  const original = process.env.KEEPER_CONFIG;
  try {
    const cfg = join(tmpDir, "config.yaml");
    // A numeric value is not a string → default.
    writeFileSync(cfg, "claude_projects_root: 42\n");
    process.env.KEEPER_CONFIG = cfg;
    const { homedir } = await import("node:os");
    expect(resolveClaudeProjectsRoot()).toBe(
      join(homedir(), ".claude", "projects"),
    );
  } finally {
    if (original === undefined) delete process.env.KEEPER_CONFIG;
    else process.env.KEEPER_CONFIG = original;
  }
});

test("resolveConfig: the two keys fall back independently from one document", () => {
  const original = process.env.KEEPER_CONFIG;
  try {
    const cfg = join(tmpDir, "config.yaml");
    // `roots` is malformed/empty (non-string junk dropped → falls back), but
    // `claude_projects_root` is a valid string and must survive untouched.
    writeFileSync(
      cfg,
      "roots:\n  - 123\n  - true\nclaude_projects_root: /tmp/transcripts\n",
    );
    process.env.KEEPER_CONFIG = cfg;
    const config = resolveConfig();
    expect(config.roots).toEqual(["~/code"]);
    expect(config.claudeProjectsRoot).toBe("/tmp/transcripts");

    // Inverse: valid `roots`, malformed (non-string) claude_projects_root → the
    // key defaults while roots survives.
    writeFileSync(cfg, "roots:\n  - /tmp/projects\nclaude_projects_root: 99\n");
    const config2 = resolveConfig();
    expect(config2.roots).toEqual(["/tmp/projects"]);
    expect(config2.claudeProjectsRoot).toBe("~/.claude/projects");
  } finally {
    if (original === undefined) delete process.env.KEEPER_CONFIG;
    else process.env.KEEPER_CONFIG = original;
  }
});

test("KEEPER_SOCK env var overrides default socket path", () => {
  const original = process.env.KEEPER_SOCK;
  try {
    const custom = join(tmpDir, "custom.sock");
    process.env.KEEPER_SOCK = custom;
    expect(resolveSockPath()).toBe(custom);

    delete process.env.KEEPER_SOCK;
    const fallback = resolveSockPath();
    expect(fallback.endsWith("/.local/state/keeper/keeperd.sock")).toBe(true);
  } finally {
    if (original === undefined) {
      delete process.env.KEEPER_SOCK;
    } else {
      process.env.KEEPER_SOCK = original;
    }
  }
});

test("resolveSockPath does no I/O (does not create the parent dir)", () => {
  // Pure resolver — calling it must not touch the filesystem.
  const original = process.env.KEEPER_SOCK;
  try {
    delete process.env.KEEPER_SOCK;
    // We just need to call it; there's nothing to assert beyond "no throw".
    resolveSockPath();
  } finally {
    if (original !== undefined) {
      process.env.KEEPER_SOCK = original;
    }
  }
});

test("selectWorldRev returns the seeded 0 on a fresh DB", () => {
  const { db, stmts } = freshMemDb();
  expect(selectWorldRev(stmts)).toBe(0);
  db.close();
});

test("selectWorldRev reflects advanceCursor", () => {
  const { db, stmts } = freshMemDb();
  db.prepare(
    "UPDATE reducer_state SET last_event_id = ?, updated_at = ? WHERE id = 1",
  ).run(7, 1);
  expect(selectWorldRev(stmts)).toBe(7);
  db.close();
});

test("selectByIds returns [] for an empty id-set without querying", () => {
  const { db } = freshMemDb();
  // Sanity: even if we hadn't seeded anything, [] must short-circuit.
  expect(selectByIds(db, JOBS_DESCRIPTOR, [])).toEqual([]);
  db.close();
});

test("selectByIds returns matching rows for a multi-id set", () => {
  const { db } = freshMemDb();
  const ts = 1_700_000_000;
  const insert = db.prepare(
    "INSERT INTO jobs (job_id, created_at, cwd, pid, state, last_event_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run("a", ts, "/a", 1, "working", 10, ts);
  insert.run("b", ts, "/b", 2, "stopped", 11, ts);
  insert.run("c", ts, null, null, "ended", 12, ts);

  const rows = selectByIds(db, JOBS_DESCRIPTOR, [
    "a",
    "c",
    "missing",
  ]) as unknown as Job[];
  expect(rows).toHaveLength(2);
  const ids = new Set(rows.map((r) => r.job_id));
  expect(ids.has("a")).toBe(true);
  expect(ids.has("c")).toBe(true);
  // Row shape carries the typed columns through.
  const a = rows.find((r) => r.job_id === "a");
  expect(a?.state).toBe("working");
  expect(a?.last_event_id).toBe(10);
  expect(a?.cwd).toBe("/a");
  // NULL columns survive the round-trip.
  const c = rows.find((r) => r.job_id === "c");
  expect(c?.cwd).toBeNull();
  expect(c?.pid).toBeNull();
  db.close();
});

test("selectByIds serves title and no title_history key", () => {
  const { db } = freshMemDb();
  const ts = 1_700_000_000;
  db.prepare(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, title) VALUES (?, ?, ?, ?, ?)",
  ).run("titled", ts, 1, ts, "fix-osc");
  // A title-less job (title defaults to NULL).
  db.prepare(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at) VALUES (?, ?, ?, ?)",
  ).run("bare", ts, 1, ts);

  const rows = selectByIds(db, JOBS_DESCRIPTOR, ["titled", "bare"]);
  const titled = rows.find((r) => r.job_id === "titled");
  const bare = rows.find((r) => r.job_id === "bare");
  expect(titled?.title).toBe("fix-osc");
  expect(bare?.title).toBeNull();
  // title_history is retired — it is not a served column.
  expect("title_history" in (titled ?? {})).toBe(false);
  db.close();
});

test("selectByIds throws when id-set exceeds MAX_IN_PARAMS", () => {
  const { db } = freshMemDb();
  const ids = Array.from({ length: MAX_IN_PARAMS + 1 }, (_, i) => `id-${i}`);
  expect(() => selectByIds(db, JOBS_DESCRIPTOR, ids)).toThrow(
    /MAX_VARIABLE_NUMBER/,
  );
  db.close();
});

test("v24 DB migrates to v25: jobs.last_input_request_at + last_input_request_kind added; rewind-and-redrain rebuilds projection with new shape; idempotent re-open", () => {
  // Build a v24-shaped DB by hand: events + jobs (with last_api_error_*,
  // no last_input_request_*), epics with all v24 columns, schema_version
  // stamped '24'. No InputRequest events in the seed log — fn-617 task .1
  // ships the schema + reducer arm + the daemon mint, but the transcript
  // matcher arrives in task .2, so a pre-fn-617 event log contains zero
  // InputRequest events. The migration's job is to land the new columns
  // reading NULL everywhere (the zero-event projection — also the
  // pre-fn-617 steady-state reading).
  const v24 = new Database(dbPath, { create: true });
  v24.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      matcher TEXT,
      cwd TEXT,
      permission_mode TEXT,
      agent_id TEXT,
      agent_type TEXT,
      stop_hook_active INTEGER,
      data TEXT NOT NULL,
      subagent_agent_id TEXT,
      spawn_name TEXT,
      start_time TEXT,
      slash_command TEXT,
      skill_name TEXT,
      planctl_op TEXT,
      planctl_target TEXT,
      planctl_epic_id TEXT,
      planctl_task_id TEXT,
      planctl_subject_present INTEGER,
      tool_use_id TEXT,
      config_dir TEXT
    )
  `);
  v24.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT,
      start_time TEXT,
      plan_verb TEXT,
      plan_ref TEXT,
      epic_links TEXT NOT NULL DEFAULT '[]',
      last_api_error_at REAL,
      last_api_error_kind TEXT,
      config_dir TEXT
    )
  `);
  v24.run(`
    CREATE TABLE epics (
      epic_id TEXT PRIMARY KEY,
      epic_number INTEGER,
      title TEXT,
      project_dir TEXT,
      status TEXT,
      approval TEXT NOT NULL DEFAULT 'pending',
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0,
      tasks TEXT NOT NULL DEFAULT '[]',
      depends_on_epics TEXT NOT NULL DEFAULT '[]',
      jobs TEXT NOT NULL DEFAULT '[]',
      job_links TEXT NOT NULL DEFAULT '[]',
      last_validated_at TEXT
    )
  `);
  v24.run(`
    CREATE TABLE reducer_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_event_id INTEGER NOT NULL DEFAULT 0,
      updated_at REAL NOT NULL
    )
  `);
  v24.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v24.run("INSERT INTO meta (key, value) VALUES ('schema_version', '24')");
  v24.run(
    "INSERT INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 0, 1)",
  );

  // Seed events: a plain SessionStart + UserPromptSubmit pair for one
  // session. No InputRequest event in the log — the migration's job is
  // to add the columns reading NULL, and a re-fold of this log must
  // reproduce the same NULL reading byte-for-byte.
  const insertEvt = v24.prepare(
    `INSERT INTO events (ts, session_id, hook_event, event_type, data)
       VALUES (?, ?, ?, ?, ?)`,
  );
  insertEvt.run(100, "sess-ir-v25", "SessionStart", "session_start", "{}");
  insertEvt.run(
    101,
    "sess-ir-v25",
    "UserPromptSubmit",
    "user_prompt_submit",
    "{}",
  );

  // Seed a hand-built jobs row WITHOUT the new columns (the v24 schema
  // has no last_input_request_* columns) — the rewind drops the row and
  // the boot drain rebuilds it from the event log through the v25
  // reducer, so the new columns read NULL (no InputRequest events to
  // stamp them).
  v24.run(
    `INSERT INTO jobs (
       job_id, created_at, state, last_event_id, updated_at
     ) VALUES (?, ?, ?, ?, ?)`,
    ["sess-ir-v25", 100, "working", 101, 101],
  );
  v24.close();

  // Reopen via openDb — drives the v24→v25 migration: ADD COLUMN
  // last_input_request_at + last_input_request_kind; rewind + DELETE
  // jobs/epics/subagent_invocations. drainAll then re-folds the event
  // log through the v25 reducer.
  const { db } = openDb(dbPath);
  drainAll(db);

  // Step 1: schema_version stamped to 25.
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  // Step 2: jobs column shape has the new two-field pair alongside the
  // v24 api-error pair.
  const jobCols = (
    db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(jobCols).toContain("last_input_request_at");
  expect(jobCols).toContain("last_input_request_kind");
  expect(jobCols).toContain("last_api_error_at");
  expect(jobCols).toContain("last_api_error_kind");

  // Step 3: the rewind wiped the hand-seeded jobs row; the boot drain
  // rebuilt it from the event log. No InputRequest event in the log →
  // the new pair reads NULL on the rebuilt row (zero-event projection).
  const job = db
    .prepare(
      "SELECT state, last_input_request_at, last_input_request_kind, last_api_error_at, last_api_error_kind FROM jobs WHERE job_id = ?",
    )
    .get("sess-ir-v25") as {
    state: string;
    last_input_request_at: number | null;
    last_input_request_kind: string | null;
    last_api_error_at: number | null;
    last_api_error_kind: string | null;
  };
  // UserPromptSubmit's lifecycle write flipped state from the default
  // 'stopped' to 'working'. No InputRequest event ever fired, so both
  // input-request columns read NULL.
  expect(job.state).toBe("working");
  expect(job.last_input_request_at).toBeNull();
  expect(job.last_input_request_kind).toBeNull();
  // Schema-v24 api-error pair: also NULL (no RateLimited/ApiError event
  // in the seed log).
  expect(job.last_api_error_at).toBeNull();
  expect(job.last_api_error_kind).toBeNull();

  // Capture post-rewind state for the idempotency re-open assertion.
  const eventsBefore = db.query("SELECT * FROM events ORDER BY id").all();
  const jobsBefore = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  db.close();

  // Idempotent re-open: the v24→v25 rewind guard suppresses re-execution
  // (the meta row was stamped to '25' on the first open), so jobs +
  // events stay byte-identical across the second openDb.
  const { db: db2 } = openDb(dbPath);
  drainAll(db2);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe(String(SCHEMA_VERSION));
  expect(db2.query("SELECT * FROM events ORDER BY id").all()).toEqual(
    eventsBefore,
  );
  expect(db2.query("SELECT * FROM jobs ORDER BY job_id").all()).toEqual(
    jobsBefore,
  );
  db2.close();
});

test("fresh v25 DB: CREATE_JOBS literal carries last_input_request_at + last_input_request_kind", () => {
  // Pin the addColumnIfMissing/literal lockstep convention: a fresh
  // openDb (no migration history) lands the new column pair via the
  // CREATE TABLE literal — not via the v24→v25 ALTER step. Re-fold
  // determinism requires that a fresh v25 DB and a migrated v24→v25
  // DB converge to identical schema.
  const { db } = openDb(":memory:");
  const jobCols = (
    db.prepare("PRAGMA table_info(jobs)").all() as {
      name: string;
      type: string;
    }[]
  ).filter(
    (c) =>
      c.name === "last_input_request_at" ||
      c.name === "last_input_request_kind",
  );
  expect(jobCols).toEqual([
    {
      cid: expect.any(Number),
      name: "last_input_request_at",
      type: "REAL",
      notnull: 0,
      dflt_value: null,
      pk: 0,
    } as unknown as {
      name: string;
      type: string;
    },
    {
      cid: expect.any(Number),
      name: "last_input_request_kind",
      type: "TEXT",
      notnull: 0,
      dflt_value: null,
      pk: 0,
    } as unknown as {
      name: string;
      type: string;
    },
  ]);
  db.close();
});

// ---------------------------------------------------------------------------
// fn-936 (v85) — the static priority/ordering columns are gone from epics
// ---------------------------------------------------------------------------

test("fresh DB: epics carries none of the dropped priority columns", () => {
  const { db } = openDb(":memory:");
  const cols = db.prepare("PRAGMA table_info(epics)").all() as {
    name: string;
  }[];
  const names = new Set(cols.map((c) => c.name));
  // fn-936 deleted the static priority/ordering machinery.
  expect(names.has("created_by_closer_of")).toBe(false);
  expect(names.has("sort_path")).toBe(false);
  expect(names.has("queue_jump")).toBe(false);
  db.close();
});

test("fn-936: the dropped epics columns stay gone across a re-open (drop is idempotent)", () => {
  const { db: db1 } = openDb(dbPath);
  db1.close();
  const { db: db2 } = openDb(dbPath);
  const cols = db2.prepare("PRAGMA table_info(epics)").all() as {
    name: string;
  }[];
  const names = cols.map((c) => c.name);
  expect(names.filter((n) => n === "created_by_closer_of").length).toBe(0);
  expect(names.filter((n) => n === "sort_path").length).toBe(0);
  expect(names.filter((n) => n === "queue_jump").length).toBe(0);
  const ver = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));
  db2.close();
});

test("fresh v29 DB schema (CREATE_EPICS) matches v28→v29 migrated schema", () => {
  // Fresh DB — CREATE_EPICS literal runs at first open.
  const fresh = openDb(dbPath).db;
  const freshCols = (
    fresh.prepare("PRAGMA table_info(epics)").all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[]
  ).map((c) => ({
    name: c.name,
    type: c.type,
    notnull: c.notnull,
    dflt_value: c.dflt_value,
  }));
  fresh.close();
  // Build a parallel v28-shaped DB by hand, then migrate it to v29.
  const otherTmp = mkdtempSync(join(tmpdir(), "keeper-db-v28-shape-"));
  const otherPath = join(otherTmp, "k.db");
  const migrated = new Database(otherPath, { create: true });
  // Replicate the v28-shape epics table without the two new columns; the
  // migrate() path's `addColumnIfMissing` ALTERs will add them.
  migrated.run(`
    CREATE TABLE epics (
      epic_id TEXT PRIMARY KEY,
      epic_number INTEGER,
      title TEXT,
      project_dir TEXT,
      status TEXT,
      approval TEXT NOT NULL DEFAULT 'pending',
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0,
      tasks TEXT NOT NULL DEFAULT '[]',
      depends_on_epics TEXT NOT NULL DEFAULT '[]',
      jobs TEXT NOT NULL DEFAULT '[]',
      job_links TEXT NOT NULL DEFAULT '[]',
      last_validated_at TEXT
    )
  `);
  migrated.run(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`);
  migrated.run(`INSERT INTO meta (key, value) VALUES ('schema_version', '28')`);
  migrated.close();
  const reopened = openDb(otherPath).db;
  const migratedCols = (
    reopened.prepare("PRAGMA table_info(epics)").all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[]
  ).map((c) => ({
    name: c.name,
    type: c.type,
    notnull: c.notnull,
    dflt_value: c.dflt_value,
  }));
  reopened.close();
  rmSync(otherTmp, { recursive: true, force: true });
  // PRAGMA table_info order is creation order: ADD COLUMN appends to the
  // end, and CREATE_EPICS lists the two new columns at the end too — so
  // the column-by-column compare lines up.
  // Both shapes must carry every column with identical name/type/notnull/
  // dflt_value tuples.
  expect(migratedCols).toEqual(freshCols);
});

test("v29 DB migrates to head: the v30 queue_jump columns are added then dropped by v85", () => {
  // Build a v29-shaped DB by hand: epics + events tables WITHOUT the new
  // `queue_jump` / `planctl_queue_jump` columns; schema_version '29'. The
  // migrate() ladder adds them at v30 then DROPS them at v85 (fn-936), so the
  // head schema carries neither — proving the full ladder converges.
  const otherTmp = mkdtempSync(join(tmpdir(), "keeper-db-v29-shape-"));
  const otherPath = join(otherTmp, "k.db");
  const migrated = new Database(otherPath, { create: true });
  // Minimal v29-shape epics: every column EXCEPT queue_jump.
  migrated.run(`
    CREATE TABLE epics (
      epic_id TEXT PRIMARY KEY,
      epic_number INTEGER,
      title TEXT,
      project_dir TEXT,
      status TEXT,
      approval TEXT NOT NULL DEFAULT 'pending',
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0,
      tasks TEXT NOT NULL DEFAULT '[]',
      depends_on_epics TEXT NOT NULL DEFAULT '[]',
      jobs TEXT NOT NULL DEFAULT '[]',
      job_links TEXT NOT NULL DEFAULT '[]',
      last_validated_at TEXT,
      created_by_closer_of TEXT,
      sort_path TEXT NOT NULL DEFAULT ''
    )
  `);
  // Seed one row at the pre-v30 shape; the ALTER ADD COLUMN must NOT
  // rewrite it — `queue_jump` should land with the schema DEFAULT 0.
  migrated.run(
    "INSERT INTO epics (epic_id, epic_number, title, status, approval, last_event_id, updated_at) VALUES ('fn-1-pre30', 1, 'Pre-v30 Epic', 'open', 'pending', 100, 1)",
  );
  migrated.run(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`);
  migrated.run(`INSERT INTO meta (key, value) VALUES ('schema_version', '29')`);
  migrated.close();

  // First open runs migrate() → ALTER ADD COLUMN epics.queue_jump etc.
  const reopened = openDb(otherPath).db;

  // Schema_version stamped to the current SCHEMA_VERSION (v31 as of fn-633.2;
  // the v29→v30 ALTERs ran AND the subsequent v30→v31 ALTERs ran in the
  // same migrate() pass, so the stamped value reflects the head schema).
  const ver = reopened
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  // fn-936 (v85): `epics.queue_jump` was DROPPED at the tail of the ladder,
  // so the head schema must NOT carry it.
  const epicCols = (
    reopened.prepare("PRAGMA table_info(epics)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(epicCols).not.toContain("queue_jump");

  // fn-936 (v85): `events.plan_queue_jump` was likewise DROPPED.
  const evCols = (
    reopened.prepare("PRAGMA table_info(events)").all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[]
  ).map((c) => c.name);
  expect(evCols).not.toContain("plan_queue_jump");

  reopened.close();

  // Second open is idempotent — addColumnIfMissing no-ops, schema_version
  // stays at the current SCHEMA_VERSION.
  const { db: db2 } = openDb(otherPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe(String(SCHEMA_VERSION));
  db2.close();
  rmSync(otherTmp, { recursive: true, force: true });
});

test("fn-936: the v30 queue_jump columns are absent from the head schema (drop is idempotent across re-open)", () => {
  // The v30 columns are added then dropped by v85; re-opening must keep the
  // head schema free of them (the v85 drop no-ops on the already-dropped
  // shape) and leave NO stray `planctl_queue_jump` zombie from the v78 rename.
  const { db: db1 } = openDb(dbPath);
  db1.close();
  const { db: db2 } = openDb(dbPath);
  const epicCols = db2.prepare("PRAGMA table_info(epics)").all() as {
    name: string;
  }[];
  const epicNames = epicCols.map((c) => c.name);
  expect(epicNames.filter((n) => n === "queue_jump").length).toBe(0);
  const evCols = db2.prepare("PRAGMA table_info(events)").all() as {
    name: string;
  }[];
  const evNames = evCols.map((c) => c.name);
  expect(evNames.filter((n) => n === "plan_queue_jump").length).toBe(0);
  expect(evNames.filter((n) => n === "planctl_queue_jump").length).toBe(0);
  const ver = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));
  db2.close();
});

// ---------------------------------------------------------------------------
// Schema v31 — fn-633.2 (per-session file attribution storage layer)
// ---------------------------------------------------------------------------

test("fresh v31 DB has events.bash_mutation_kind + events.bash_mutation_targets as nullable TEXT", () => {
  // Fresh-DB path: CREATE_EVENTS literal carries the new columns.
  const { db } = openDb(":memory:");
  const cols = db.prepare("PRAGMA table_info(events)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const kind = cols.find((c) => c.name === "bash_mutation_kind");
  const targets = cols.find((c) => c.name === "bash_mutation_targets");
  expect(kind).toBeDefined();
  expect(kind?.type).toBe("TEXT");
  expect(kind?.notnull).toBe(0);
  expect(kind?.dflt_value).toBeNull();
  expect(targets).toBeDefined();
  expect(targets?.type).toBe("TEXT");
  expect(targets?.notnull).toBe(0);
  expect(targets?.dflt_value).toBeNull();
  db.close();
});

test("fresh v31 DB has jobs.git_unattributed_to_live_count (renamed) + jobs.git_orphan_count (new) as INTEGER NOT NULL DEFAULT 0", () => {
  const { db } = openDb(":memory:");
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const renamed = cols.find((c) => c.name === "git_unattributed_to_live_count");
  const fresh = cols.find((c) => c.name === "git_orphan_count");
  expect(renamed).toBeDefined();
  expect(renamed?.type).toBe("INTEGER");
  expect(renamed?.notnull).toBe(1);
  expect(renamed?.dflt_value).toBe("0");
  expect(fresh).toBeDefined();
  expect(fresh?.type).toBe("INTEGER");
  expect(fresh?.notnull).toBe(1);
  expect(fresh?.dflt_value).toBe("0");
  db.close();
});

test("fresh v31 DB has file_attributions table with the right PK + indexes", () => {
  const { db } = openDb(":memory:");
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_attributions'",
    )
    .all() as { name: string }[];
  expect(tables.length).toBe(1);

  const cols = db.prepare("PRAGMA table_info(file_attributions)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }[];
  const byName = new Map(cols.map((c) => [c.name, c]));
  expect(byName.get("project_dir")?.type).toBe("TEXT");
  expect(byName.get("project_dir")?.notnull).toBe(1);
  expect(byName.get("session_id")?.notnull).toBe(1);
  expect(byName.get("file_path")?.notnull).toBe(1);
  expect(byName.get("last_mutation_at")?.type).toBe("REAL");
  expect(byName.get("last_mutation_at")?.notnull).toBe(1);
  expect(byName.get("last_commit_at")?.type).toBe("REAL");
  expect(byName.get("last_commit_at")?.notnull).toBe(0);
  expect(byName.get("op")?.notnull).toBe(1);
  expect(byName.get("source")?.notnull).toBe(1);
  expect(byName.get("last_event_id")?.notnull).toBe(0);
  expect(byName.get("updated_at")?.notnull).toBe(1);
  expect(byName.get("updated_at")?.dflt_value).toBe("0");
  // Composite PK on (project_dir, session_id, file_path) — PRAGMA `pk`
  // is the 1-indexed position in the composite (0 means not part of the PK).
  expect(byName.get("project_dir")?.pk).toBe(1);
  expect(byName.get("session_id")?.pk).toBe(2);
  expect(byName.get("file_path")?.pk).toBe(3);

  // CHECK constraint on `source` is enforced — verify an invalid value throws
  // and every valid one is accepted. fn-889 (v82) narrowed the CHECK to drop the
  // retired `'planctl'` member (0 live rows; the fold mints `'plan'`), so the
  // legacy spelling now rejects alongside any other non-enum value.
  for (const bad of ["NOT_AN_ENUM", "planctl"]) {
    expect(() => {
      db.run(
        "INSERT INTO file_attributions (project_dir, session_id, file_path, last_mutation_at, op, source) VALUES ('/r', 's', ?, 0, 'edit', ?)",
        [`bad-${bad}`, bad],
      );
    }).toThrow();
  }
  for (const src of ["tool", "bash", "inferred", "plan"]) {
    db.run(
      "INSERT INTO file_attributions (project_dir, session_id, file_path, last_mutation_at, op, source) VALUES (?, 's', ?, 0, 'edit', ?)",
      ["/r", `f-${src}`, src],
    );
  }
  const indexes = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'file_attributions' ORDER BY name",
    )
    .all() as { name: string }[];
  const idxNames = new Set(indexes.map((i) => i.name));
  expect(idxNames.has("idx_file_attributions_file")).toBe(true);
  expect(idxNames.has("idx_file_attributions_session")).toBe(true);
  db.close();
});

test("fresh DB has idx_events_bash_attr covering partial index (replaces idx_events_bash_mutation_kind)", () => {
  const { db } = openDb(":memory:");
  const indexes = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_bash_attr'",
    )
    .all() as { name: string; sql: string }[];
  expect(indexes.length).toBe(1);
  // Partial-index predicate present (so the planner matches a
  // `WHERE bash_mutation_kind = ?` query under Rule 2)…
  expect(indexes[0]?.sql).toMatch(
    /WHERE\s+bash_mutation_kind\s+IS\s+NOT\s+NULL/i,
  );
  // …and it carries bash_mutation_targets so json_each() reads from the index
  // (covering) rather than faulting the data page.
  expect(indexes[0]?.sql).toContain("bash_mutation_targets");
  // The key-only predecessor is retired in the migrate tail.
  const old = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_bash_mutation_kind'",
    )
    .all();
  expect(old.length).toBe(0);
  db.close();
});

test("fresh DB schema_version is stamped at current SCHEMA_VERSION", () => {
  const { db } = openDb(":memory:");
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));
  db.close();
});

test("v30 DB migrates to v31: events sparse columns added, jobs column rename + new column, file_attributions created, rewind runs", () => {
  // Build a v30-shape DB by hand: full v30 events / jobs / epics shapes
  // WITHOUT the v31 additions. The migrate() path's `addColumnIfMissing` +
  // `renameColumnIfPresent` + `CREATE TABLE IF NOT EXISTS` must converge
  // it to the v31 shape.
  const otherTmp = mkdtempSync(join(tmpdir(), "keeper-db-v30-shape-"));
  const otherPath = join(otherTmp, "k.db");
  const v30 = new Database(otherPath, { create: true });
  // Minimal v30-shape events: just enough for the table to exist; we drop
  // the rows in the rewind so the row shape doesn't matter, only the
  // table's column set.
  v30.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      matcher TEXT,
      cwd TEXT,
      permission_mode TEXT,
      agent_id TEXT,
      agent_type TEXT,
      stop_hook_active INTEGER,
      data TEXT NOT NULL,
      subagent_agent_id TEXT,
      spawn_name TEXT,
      start_time TEXT,
      slash_command TEXT,
      skill_name TEXT,
      planctl_op TEXT,
      planctl_target TEXT,
      planctl_epic_id TEXT,
      planctl_task_id TEXT,
      planctl_subject_present INTEGER,
      tool_use_id TEXT,
      config_dir TEXT,
      planctl_queue_jump INTEGER
    )
  `);
  // v30-shape jobs: carries the LEGACY `git_orphan_count` (semantic:
  // files-not-attributed-to-a-live-session, the v28 meaning). The rename
  // ALTER must move it to `git_unattributed_to_live_count` and a fresh
  // `git_orphan_count` (strict-mystery) must land.
  v30.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT,
      start_time TEXT,
      plan_verb TEXT,
      plan_ref TEXT,
      epic_links TEXT NOT NULL DEFAULT '[]',
      last_api_error_at REAL,
      last_api_error_kind TEXT,
      last_input_request_at REAL,
      last_input_request_kind TEXT,
      config_dir TEXT,
      git_dirty_count INTEGER NOT NULL DEFAULT 0,
      git_orphan_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  // Seed one jobs row that the rewind will wipe; we still assert the
  // post-rewind row count is 0.
  v30.run(
    "INSERT INTO jobs (job_id, created_at, updated_at, git_dirty_count, git_orphan_count) VALUES ('legacy-1', 0, 0, 3, 7)",
  );
  v30.run(`
    CREATE TABLE epics (
      epic_id TEXT PRIMARY KEY,
      epic_number INTEGER,
      title TEXT,
      project_dir TEXT,
      status TEXT,
      approval TEXT NOT NULL DEFAULT 'pending',
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0,
      tasks TEXT NOT NULL DEFAULT '[]',
      depends_on_epics TEXT NOT NULL DEFAULT '[]',
      jobs TEXT NOT NULL DEFAULT '[]',
      job_links TEXT NOT NULL DEFAULT '[]',
      last_validated_at TEXT,
      created_by_closer_of TEXT,
      sort_path TEXT NOT NULL DEFAULT '',
      queue_jump INTEGER NOT NULL DEFAULT 0
    )
  `);
  v30.run(
    "INSERT INTO epics (epic_id, epic_number, title, last_event_id, updated_at) VALUES ('e1', 1, 't', 100, 1)",
  );
  v30.run(`
    CREATE TABLE git_status (
      project_dir TEXT PRIMARY KEY,
      branch TEXT,
      head_oid TEXT,
      upstream TEXT,
      ahead INTEGER,
      behind INTEGER,
      dirty_count INTEGER NOT NULL DEFAULT 0,
      orphaned_count INTEGER NOT NULL DEFAULT 0,
      dirty_files TEXT NOT NULL DEFAULT '[]',
      orphaned_files TEXT NOT NULL DEFAULT '[]',
      jobs TEXT NOT NULL DEFAULT '[]',
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0
    )
  `);
  v30.run("INSERT INTO git_status (project_dir, updated_at) VALUES ('/r', 0)");
  v30.run(
    `CREATE TABLE reducer_state (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       last_event_id INTEGER NOT NULL DEFAULT 0,
       updated_at REAL NOT NULL
     )`,
  );
  v30.run(
    "INSERT INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 999, 0)",
  );
  v30.run(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`);
  v30.run(`INSERT INTO meta (key, value) VALUES ('schema_version', '30')`);
  v30.close();

  // First open runs migrate() → ADD events.bash_mutation_*, RENAME jobs
  // .git_orphan_count → .git_unattributed_to_live_count, ADD new
  // jobs.git_orphan_count, CREATE file_attributions, version-guarded rewind.
  const { db: reopened } = openDb(otherPath);

  // events sparse columns present + nullable.
  const evCols = (
    reopened.prepare("PRAGMA table_info(events)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(evCols).toContain("bash_mutation_kind");
  expect(evCols).toContain("bash_mutation_targets");

  // jobs column rename + new column present.
  const jobCols = (
    reopened.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(jobCols).toContain("git_unattributed_to_live_count");
  expect(jobCols).toContain("git_orphan_count");
  // The legacy name is gone (replaced by the rename).
  expect(jobCols.filter((c) => c === "git_orphan_count").length).toBe(1);

  // file_attributions table created.
  const tables = (
    reopened
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_attributions'",
      )
      .all() as { name: string }[]
  ).map((t) => t.name);
  expect(tables).toEqual(["file_attributions"]);

  // Covering partial index on bash_mutation_kind created (the key-only
  // idx_events_bash_mutation_kind was replaced by idx_events_bash_attr).
  const ix = reopened
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_bash_attr'",
    )
    .all() as { name: string }[];
  expect(ix.length).toBe(1);

  // Schema_version stamped to 31.
  const ver = reopened
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  // Version-guarded rewind ran: cursor=0, jobs/epics/git_status/file_attributions
  // wiped.
  const cursor = (
    reopened
      .prepare("SELECT last_event_id FROM reducer_state WHERE id = 1")
      .get() as { last_event_id: number }
  ).last_event_id;
  expect(cursor).toBe(0);
  expect(
    (reopened.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number })
      .n,
  ).toBe(0);
  expect(
    (reopened.prepare("SELECT COUNT(*) AS n FROM epics").get() as { n: number })
      .n,
  ).toBe(0);
  expect(
    (
      reopened.prepare("SELECT COUNT(*) AS n FROM git_status").get() as {
        n: number;
      }
    ).n,
  ).toBe(0);
  expect(
    (
      reopened.prepare("SELECT COUNT(*) AS n FROM file_attributions").get() as {
        n: number;
      }
    ).n,
  ).toBe(0);
  reopened.close();
  rmSync(otherTmp, { recursive: true, force: true });
});

test("v30→v31 rewind is version-guarded: re-open of an already-migrated v31 DB does NOT re-run rewind", () => {
  // First open lands v31 + runs the rewind once. Then we seed a jobs row
  // by hand and re-open; the rewind block must NOT fire again (storedVersion
  // is now >= 31), so the row survives.
  const { db: db1 } = openDb(dbPath);
  db1.run(
    "INSERT INTO jobs (job_id, created_at, updated_at) VALUES ('keeper', 0, 0)",
  );
  db1.close();
  const { db: db2 } = openDb(dbPath);
  const row = db2
    .prepare("SELECT job_id FROM jobs WHERE job_id = 'keeper'")
    .get() as { job_id: string } | null;
  expect(row?.job_id).toBe("keeper");
  // Schema_version stays at 31; addColumnIfMissing / renameColumnIfPresent
  // no-op (quad-state idempotence).
  const ver = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));
  db2.close();
});

test("fresh v31 DB schema (CREATE_JOBS) matches v30→v31 migrated schema (column shape parity)", () => {
  // Fresh DB — CREATE_JOBS literal runs at first open.
  const fresh = openDb(dbPath).db;
  const freshCols = (
    fresh.prepare("PRAGMA table_info(jobs)").all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[]
  ).map((c) => ({
    name: c.name,
    type: c.type,
    notnull: c.notnull,
    dflt_value: c.dflt_value,
  }));
  fresh.close();
  // Build a parallel v30-shape DB by hand (carries the legacy
  // `git_orphan_count` column under its old meaning), then migrate to v31.
  const otherTmp = mkdtempSync(join(tmpdir(), "keeper-db-v30-jobs-shape-"));
  const otherPath = join(otherTmp, "k.db");
  const migrated = new Database(otherPath, { create: true });
  migrated.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT,
      start_time TEXT,
      plan_verb TEXT,
      plan_ref TEXT,
      epic_links TEXT NOT NULL DEFAULT '[]',
      last_api_error_at REAL,
      last_api_error_kind TEXT,
      last_input_request_at REAL,
      last_input_request_kind TEXT,
      config_dir TEXT,
      git_dirty_count INTEGER NOT NULL DEFAULT 0,
      git_orphan_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  migrated.run(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`);
  migrated.run(`INSERT INTO meta (key, value) VALUES ('schema_version', '30')`);
  migrated.close();
  const reopened = openDb(otherPath).db;
  const migratedCols = (
    reopened.prepare("PRAGMA table_info(jobs)").all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[]
  ).map((c) => ({
    name: c.name,
    type: c.type,
    notnull: c.notnull,
    dflt_value: c.dflt_value,
  }));
  reopened.close();
  rmSync(otherTmp, { recursive: true, force: true });
  // Column-by-column compare: PRAGMA table_info order is creation order.
  // The CREATE_JOBS literal lists git_unattributed_to_live_count BEFORE
  // git_orphan_count; the migration path renames the legacy column in
  // place (it stays at its original position — git_unattributed_to_live_count
  // takes the old `git_orphan_count` slot) THEN appends the new
  // `git_orphan_count` at the end. CREATE_JOBS mirrors that order so the
  // parity assert holds.
  expect(migratedCols).toEqual(freshCols);
});

test("v31 DB migrates to v32: epics.default_visible added as VIRTUAL generated column; post-migrate rows compute correct values per status (fn-634, fn-648, fn-756)", () => {
  // Build a v31-shape epics table by hand (16 columns including queue_jump
  // but NO default_visible). Reopen via openDb() → migrate() to verify:
  // (a) version stamp = current SCHEMA_VERSION, (b) default_visible
  // column exists per PRAGMA table_xinfo, (c) post-migrate inserts on the
  // 6 corners of the (status, approval) cross product compute the correct
  // default_visible per the CASE-wrapped expression (open OR !approved → 1;
  // else 0; NULL-status collapses via CASE to 0 on the approved corner).
  // The fn-648 v38→v39 rewind wipes the epics table during migrate, so
  // pre-migrate rows would not survive — VIRTUAL means SQLite recomputes
  // on read regardless of which rows exist, so we insert AFTER migrate to
  // pin the same correctness property.
  const otherTmp = mkdtempSync(join(tmpdir(), "keeper-db-v31-shape-"));
  const otherPath = join(otherTmp, "k.db");
  const v31 = new Database(otherPath, { create: true });
  // Minimal v31-shape epics — exactly the 16 columns the v31 CREATE_EPICS
  // landed (no default_visible).
  v31.run(`
    CREATE TABLE epics (
      epic_id TEXT PRIMARY KEY,
      epic_number INTEGER,
      title TEXT,
      project_dir TEXT,
      status TEXT,
      approval TEXT NOT NULL DEFAULT 'pending',
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0,
      tasks TEXT NOT NULL DEFAULT '[]',
      depends_on_epics TEXT NOT NULL DEFAULT '[]',
      jobs TEXT NOT NULL DEFAULT '[]',
      job_links TEXT NOT NULL DEFAULT '[]',
      last_validated_at TEXT,
      created_by_closer_of TEXT,
      sort_path TEXT NOT NULL DEFAULT '',
      queue_jump INTEGER NOT NULL DEFAULT 0
    )
  `);
  // v31's other tables — minimal shape so migrate()'s schema-converge
  // doesn't trip on missing tables. We seed the 6 corners AFTER migrate
  // (post-rewind) to assert VIRTUAL-computation correctness — see the
  // test-level docstring for the fn-648 rewind context.
  v31.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT,
      start_time TEXT,
      plan_verb TEXT,
      plan_ref TEXT,
      epic_links TEXT NOT NULL DEFAULT '[]',
      last_api_error_at REAL,
      last_api_error_kind TEXT,
      last_input_request_at REAL,
      last_input_request_kind TEXT,
      config_dir TEXT,
      git_dirty_count INTEGER NOT NULL DEFAULT 0,
      git_unattributed_to_live_count INTEGER NOT NULL DEFAULT 0,
      git_orphan_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  v31.run(
    `CREATE TABLE reducer_state (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       last_event_id INTEGER NOT NULL DEFAULT 0,
       updated_at REAL NOT NULL
     )`,
  );
  v31.run(
    "INSERT INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 0, 0)",
  );
  v31.run(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`);
  v31.run(`INSERT INTO meta (key, value) VALUES ('schema_version', '31')`);
  v31.close();

  // First open runs migrate() → addGeneratedColumnIfMissing lands the
  // VIRTUAL column on the existing epics table.
  const { db: reopened } = openDb(otherPath);

  // (a) Version stamp bumped to 32.
  const ver = reopened
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  // (b) default_visible column present per PRAGMA table_xinfo (the
  // generated-column-aware helper).
  const cols = (
    reopened.prepare("PRAGMA table_xinfo(epics)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(cols).toContain("default_visible");

  // (c) Seed the 3 status corners post-migrate (the fn-648 v38→v39 rewind
  // would have wiped any pre-migrate rows). VIRTUAL means SQLite recomputes
  // on every read, so insert-then-read pins the CASE-wrapped expression's
  // correctness. fn-756 (v63) dropped `approval` from the column + the table,
  // so the post-migrate INSERT carries no `approval`.
  const insertPost = reopened.prepare(
    "INSERT INTO epics (epic_id, epic_number, title, status, last_event_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insertPost.run("e1", 1, "open", "open", 1, 1);
  insertPost.run("e2", 2, "done", "done", 2, 1);
  insertPost.run("e3", 3, "null-status", null, 3, 1);
  const rows = reopened
    .prepare("SELECT epic_id, default_visible FROM epics ORDER BY epic_id ASC")
    .all() as { epic_id: string; default_visible: number }[];
  // fn-712 (v56) added the `status IS NOT NULL` materialized guard; fn-756
  // (v63) dropped the `approval` branch. A v31 DB migrating all the way to v63
  // lands the final `status IS NOT NULL AND status='open'` expression (proves
  // the v31→v32 literal + the v55→v56 + v62→v63 drop+re-adds converge): only
  // an open materialized epic is visible.
  expect(rows).toEqual([
    { epic_id: "e1", default_visible: 1 }, // open → 1
    { epic_id: "e2", default_visible: 0 }, // done → 0 (HIDDEN)
    { epic_id: "e3", default_visible: 0 }, // null-status → 0 (not materialized)
  ]);

  // Bonus: the partial index landed too.
  const ix = reopened
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_epics_default_visible'",
    )
    .all() as { name: string }[];
  expect(ix.length).toBe(1);

  // Re-open is idempotent — addGeneratedColumnIfMissing no-ops, the
  // version stamp stays at 32, the row data is intact.
  reopened.close();
  const { db: reopened2 } = openDb(otherPath);
  const ver2 = reopened2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe(String(SCHEMA_VERSION));
  const rowCount = (
    reopened2.prepare("SELECT COUNT(*) AS n FROM epics").get() as {
      n: number;
    }
  ).n;
  expect(rowCount).toBe(3);
  reopened2.close();
  rmSync(otherTmp, { recursive: true, force: true });
});

test("fresh openDb (0→head): profiles is absent at head — retired v120 (fn-1239 task .6, formerly fn-639)", () => {
  // `profiles` served the retired agentusage rate-limit correlation surface
  // from schema v33 through v119; the tail v120 step DROPs it unconditionally
  // alongside `usage` (see the sibling `usage`-absence test above).
  const { db } = openDb(":memory:");
  const hasProfiles = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'profiles'",
    )
    .get();
  expect(hasProfiles ?? null).toBeNull();
  db.close();
});

test("v32 DB migrates to head: the transient v32→v33 profiles CREATE still runs (no throw); profiles is absent at head; pre-existing projections wiped by v38→v39 rewind (fn-1239 task .6, formerly fn-639/fn-648)", () => {
  // Build a v32-shape DB by hand (epics + jobs + reducer_state + meta only —
  // no profiles), then reopen via openDb() → migrate() to verify: (a) the
  // version stamp bumps through v33 to the current SCHEMA_VERSION, (b) the
  // profiles table exists with the correct shape, (c) the pre-existing
  // epics row is WIPED by the fn-648 v38→v39 rewind in the same migrate
  // transaction. The v32→v33 step itself has no rewind — the new profiles
  // table populates organically on the next SessionStart fold — but the
  // later v38→v39 step in the same transaction clears epics/jobs/etc.
  const otherTmp = mkdtempSync(join(tmpdir(), "keeper-db-v32-shape-"));
  const otherPath = join(otherTmp, "k.db");
  const v32 = new Database(otherPath, { create: true });
  // Minimal v32-shape epics — the 17 columns the v32 CREATE_EPICS landed
  // (default_visible was added in v32 as VIRTUAL generated; declare it in
  // the literal here so the v32→v33 migrate path doesn't re-add it).
  v32.run(`
    CREATE TABLE epics (
      epic_id TEXT PRIMARY KEY,
      epic_number INTEGER,
      title TEXT,
      project_dir TEXT,
      status TEXT,
      approval TEXT NOT NULL DEFAULT 'pending',
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0,
      tasks TEXT NOT NULL DEFAULT '[]',
      depends_on_epics TEXT NOT NULL DEFAULT '[]',
      jobs TEXT NOT NULL DEFAULT '[]',
      job_links TEXT NOT NULL DEFAULT '[]',
      last_validated_at TEXT,
      created_by_closer_of TEXT,
      sort_path TEXT NOT NULL DEFAULT '',
      queue_jump INTEGER NOT NULL DEFAULT 0,
      default_visible INTEGER NOT NULL GENERATED ALWAYS AS (CASE WHEN status='open' OR approval!='approved' THEN 1 ELSE 0 END) VIRTUAL
    )
  `);
  v32
    .prepare(
      "INSERT INTO epics (epic_id, epic_number, title, status, approval, last_event_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run("e1", 1, "preserved-across-migrate", "open", "pending", 1, 1);
  v32.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT,
      start_time TEXT,
      plan_verb TEXT,
      plan_ref TEXT,
      epic_links TEXT NOT NULL DEFAULT '[]',
      last_api_error_at REAL,
      last_api_error_kind TEXT,
      last_input_request_at REAL,
      last_input_request_kind TEXT,
      config_dir TEXT,
      git_dirty_count INTEGER NOT NULL DEFAULT 0,
      git_unattributed_to_live_count INTEGER NOT NULL DEFAULT 0,
      git_orphan_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  v32.run(
    `CREATE TABLE reducer_state (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       last_event_id INTEGER NOT NULL DEFAULT 0,
       updated_at REAL NOT NULL
     )`,
  );
  v32.run(
    "INSERT INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 0, 0)",
  );
  v32.run(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`);
  v32.run(`INSERT INTO meta (key, value) VALUES ('schema_version', '32')`);
  v32.close();

  const { db: reopened } = openDb(otherPath);
  // (a) Version stamp bumped to 33.
  const ver = reopened
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));
  // (b) profiles is absent at head — the transient v32→v33 CREATE converges
  // to the v120 tail DROP, same as the fresh-open path.
  const hasProfiles = reopened
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'profiles'",
    )
    .get();
  expect(hasProfiles ?? null).toBeNull();
  // (c) Pre-existing epics row is wiped by the fn-648 v38→v39 rewind in
  // the same migrate transaction. v32→v33 itself has no rewind, but the
  // later v38→v39 step inside the same `migrate()` call clears the
  // projection tables. The boot drain (not run here) would re-fold from
  // the event log under the new reducer match logic.
  const epicRow = reopened
    .prepare("SELECT epic_id, title FROM epics WHERE epic_id = 'e1'")
    .get() as { epic_id: string; title: string } | null;
  expect(epicRow).toBeNull();
  reopened.close();
  // Re-open is idempotent.
  const { db: reopened2 } = openDb(otherPath);
  const ver2 = reopened2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe(String(SCHEMA_VERSION));
  reopened2.close();
  rmSync(otherTmp, { recursive: true, force: true });
});

test("fresh v34 DB has epics.resolved_epic_deps (nullable TEXT) and epic_dep_edges table + dep_token index (fn-637)", () => {
  // Presence + shape gate on the schema-v34 reverse-dependency surface.
  // `resolved_epic_deps` is `TEXT` (nullable; NULL = "not-yet-computed",
  // distinct from `'[]'` = "computed empty") on `epics`. `epic_dep_edges`
  // is a (consumer_id, dep_token) two-column key-only table backed by
  // `idx_epic_dep_edges_dep_token` for the reverse-fan-out lookup keyed
  // on the raw token.
  const { db } = openDb(":memory:");

  // (a) epics.resolved_epic_deps — nullable TEXT, no DEFAULT (NULL is the
  // schema-default zero-event reading).
  const epicCols = db.prepare("PRAGMA table_info(epics)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const rd = epicCols.find((c) => c.name === "resolved_epic_deps");
  expect(rd).toBeDefined();
  expect(rd?.type).toBe("TEXT");
  expect(rd?.notnull).toBe(0);
  expect(rd?.dflt_value).toBeNull();

  // (b) epic_dep_edges table — two-column key-only shape.
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  expect(tables).toContain("epic_dep_edges");
  const edgeCols = db.prepare("PRAGMA table_info(epic_dep_edges)").all() as {
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }[];
  expect(edgeCols.map((c) => c.name)).toEqual(["consumer_id", "dep_token"]);
  const consumer = edgeCols.find((c) => c.name === "consumer_id");
  expect(consumer?.type).toBe("TEXT");
  expect(consumer?.notnull).toBe(1);
  expect(consumer?.pk).toBe(1);
  const depTok = edgeCols.find((c) => c.name === "dep_token");
  expect(depTok?.type).toBe("TEXT");
  expect(depTok?.notnull).toBe(1);
  expect(depTok?.pk).toBe(2);

  // (c) idx_epic_dep_edges_dep_token — the reverse fan-out index. Must
  // exist and key on `dep_token` ALONE (NOT a leading-consumer composite —
  // that's what the implicit PK index covers).
  const idxList = db.prepare("PRAGMA index_list(epic_dep_edges)").all() as {
    name: string;
  }[];
  const idxNames = idxList.map((r) => r.name);
  expect(idxNames).toContain("idx_epic_dep_edges_dep_token");
  const idxCols = db
    .prepare("PRAGMA index_info(idx_epic_dep_edges_dep_token)")
    .all() as { name: string }[];
  expect(idxCols.map((c) => c.name)).toEqual(["dep_token"]);

  // (d) Zero-event projection: both surfaces start empty.
  expect(
    (
      db.prepare("SELECT COUNT(*) AS n FROM epic_dep_edges").get() as {
        n: number;
      }
    ).n,
  ).toBe(0);
  expect(
    (db.prepare("SELECT COUNT(*) AS n FROM epics").get() as { n: number }).n,
  ).toBe(0);

  db.close();
});

test("v33 DB migrates to v34: resolved_epic_deps column + epic_dep_edges table added; pre-existing rows wiped by v38→v39 rewind (fn-637, fn-648)", () => {
  // Build a v33-shape DB by hand (epics with the v33 column set; no
  // resolved_epic_deps; no epic_dep_edges table), then reopen via
  // openDb() → migrate() to verify: (a) version stamp bumps through v34
  // to the current SCHEMA_VERSION, (b) the new column is added,
  // (c) the epic_dep_edges table + dep_token index exist with the
  // expected shape, (d) the pre-existing epics row is WIPED by the
  // fn-648 v38→v39 rewind (the rewind runs after the v33→v34 chunked
  // backfill but inside the same openDb() call — the original v33→v34
  // backfill's projection output does not survive). The boot drain
  // (not run here) would re-fold from the event log under the new
  // reducer match logic; for this fixture there are no events, so the
  // epics table simply reads empty after migrate.
  const otherTmp = mkdtempSync(join(tmpdir(), "keeper-db-v33-shape-"));
  const otherPath = join(otherTmp, "k.db");
  const v33 = new Database(otherPath, { create: true });
  // Minimal v33-shape epics — the 17 columns the v33 CREATE_EPICS landed
  // (`default_visible` was added in v32 as VIRTUAL generated; declare it
  // in the literal here so the v33→v34 migrate path doesn't re-add it).
  v33.run(`
    CREATE TABLE epics (
      epic_id TEXT PRIMARY KEY,
      epic_number INTEGER,
      title TEXT,
      project_dir TEXT,
      status TEXT,
      approval TEXT NOT NULL DEFAULT 'pending',
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0,
      tasks TEXT NOT NULL DEFAULT '[]',
      depends_on_epics TEXT NOT NULL DEFAULT '[]',
      jobs TEXT NOT NULL DEFAULT '[]',
      job_links TEXT NOT NULL DEFAULT '[]',
      last_validated_at TEXT,
      created_by_closer_of TEXT,
      sort_path TEXT NOT NULL DEFAULT '',
      queue_jump INTEGER NOT NULL DEFAULT 0,
      default_visible INTEGER NOT NULL GENERATED ALWAYS AS (CASE WHEN status='open' OR approval!='approved' THEN 1 ELSE 0 END) VIRTUAL
    )
  `);
  v33
    .prepare(
      "INSERT INTO epics (epic_id, epic_number, title, status, approval, last_event_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run("e1", 1, "preserved-across-migrate", "open", "pending", 1, 1);
  v33.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT,
      start_time TEXT,
      plan_verb TEXT,
      plan_ref TEXT,
      epic_links TEXT NOT NULL DEFAULT '[]',
      last_api_error_at REAL,
      last_api_error_kind TEXT,
      last_input_request_at REAL,
      last_input_request_kind TEXT,
      config_dir TEXT,
      git_dirty_count INTEGER NOT NULL DEFAULT 0,
      git_unattributed_to_live_count INTEGER NOT NULL DEFAULT 0,
      git_orphan_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  v33.run(
    `CREATE TABLE reducer_state (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       last_event_id INTEGER NOT NULL DEFAULT 0,
       updated_at REAL NOT NULL
     )`,
  );
  v33.run(
    "INSERT INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 0, 0)",
  );
  v33.run(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`);
  v33.run(`INSERT INTO meta (key, value) VALUES ('schema_version', '33')`);
  v33.close();

  const { db: reopened } = openDb(otherPath);
  // (a) Version stamp bumped through v34 to the current SCHEMA_VERSION.
  const ver = reopened
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));
  // (b) resolved_epic_deps column added. Under the fn-648 v38→v39 rewind,
  // the pre-existing `e1` row is wiped before the chunked v34 backfill
  // runs, so the backfill walks an empty epics table and has nothing to
  // UPDATE. The boot drain (not run here) would re-fold from the event
  // log, re-creating epics rows under the new reducer match logic; this
  // fixture has no events, so the table reads empty.
  const cols = reopened.prepare("PRAGMA table_info(epics)").all() as {
    name: string;
  }[];
  expect(cols.map((c) => c.name)).toContain("resolved_epic_deps");
  const row = reopened
    .prepare(
      "SELECT epic_id, title, resolved_epic_deps FROM epics WHERE epic_id = 'e1'",
    )
    .get() as {
    epic_id: string;
    title: string;
    resolved_epic_deps: string | null;
  } | null;
  expect(row).toBeNull();
  const epicCount = (
    reopened.prepare("SELECT COUNT(*) AS n FROM epics").get() as { n: number }
  ).n;
  expect(epicCount).toBe(0);
  // (c) epic_dep_edges table + dep_token index exist.
  const tables = (
    reopened
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[]
  ).map((r) => r.name);
  expect(tables).toContain("epic_dep_edges");
  const idxList = reopened
    .prepare("PRAGMA index_list(epic_dep_edges)")
    .all() as { name: string }[];
  expect(idxList.map((r) => r.name)).toContain("idx_epic_dep_edges_dep_token");
  reopened.close();
  // (d) Re-open is idempotent — addColumnIfMissing + CREATE IF NOT EXISTS
  // both no-op on a second boot.
  const { db: reopened2 } = openDb(otherPath);
  const ver2 = reopened2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe(String(SCHEMA_VERSION));
  reopened2.close();
  rmSync(otherTmp, { recursive: true, force: true });
});

test("v33 DB with non-trivial deps: pre-existing rows wiped by v38→v39 rewind; chunked v34 backfill walks empty epics (fn-637, fn-648)", () => {
  // Build a v33-shape DB carrying TWO epics: an upstream `fn-1-up`
  // (status=done, approval=approved) and a downstream `fn-2-down`
  // depending on the full upstream id. Reopen via openDb() → migrate()
  // → backfill. Under the fn-648 v38→v39 rewind, both seeded epics are
  // wiped inside the main migrate transaction BEFORE the post-migrate
  // chunked v34 backfill runs — so the backfill walks an empty epics
  // table, no `resolved_epic_deps` is stamped, and `epic_dep_edges`
  // stays empty. The boot drain (not run here) would re-create both
  // epics from the event log and the reducer's `syncResolvedEpicDeps`
  // forward-stamp would populate the projection live; this fixture
  // has no events, so the tables read empty after migrate.
  const otherTmp = mkdtempSync(join(tmpdir(), "keeper-db-v33-deps-"));
  const otherPath = join(otherTmp, "k.db");
  const v33 = new Database(otherPath, { create: true });
  v33.run(`
    CREATE TABLE epics (
      epic_id TEXT PRIMARY KEY,
      epic_number INTEGER,
      title TEXT,
      project_dir TEXT,
      status TEXT,
      approval TEXT NOT NULL DEFAULT 'pending',
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0,
      tasks TEXT NOT NULL DEFAULT '[]',
      depends_on_epics TEXT NOT NULL DEFAULT '[]',
      jobs TEXT NOT NULL DEFAULT '[]',
      job_links TEXT NOT NULL DEFAULT '[]',
      last_validated_at TEXT,
      created_by_closer_of TEXT,
      sort_path TEXT NOT NULL DEFAULT '',
      queue_jump INTEGER NOT NULL DEFAULT 0,
      default_visible INTEGER NOT NULL GENERATED ALWAYS AS (CASE WHEN status='open' OR approval!='approved' THEN 1 ELSE 0 END) VIRTUAL
    )
  `);
  v33
    .prepare(
      `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, approval, depends_on_epics, last_event_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("fn-1-up", 1, "Up", "/repo", "done", "approved", "[]", 1, 1);
  v33
    .prepare(
      `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, approval, depends_on_epics, last_event_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "fn-2-down",
      2,
      "Down",
      "/repo",
      "open",
      "pending",
      JSON.stringify(["fn-1-up"]),
      2,
      2,
    );
  v33.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT,
      start_time TEXT,
      plan_verb TEXT,
      plan_ref TEXT,
      epic_links TEXT NOT NULL DEFAULT '[]',
      last_api_error_at REAL,
      last_api_error_kind TEXT,
      last_input_request_at REAL,
      last_input_request_kind TEXT,
      config_dir TEXT,
      git_dirty_count INTEGER NOT NULL DEFAULT 0,
      git_unattributed_to_live_count INTEGER NOT NULL DEFAULT 0,
      git_orphan_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  v33.run(
    `CREATE TABLE reducer_state (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       last_event_id INTEGER NOT NULL DEFAULT 0,
       updated_at REAL NOT NULL
     )`,
  );
  v33.run(
    "INSERT INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 0, 0)",
  );
  v33.run(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`);
  v33.run(`INSERT INTO meta (key, value) VALUES ('schema_version', '33')`);
  v33.close();

  const { db: reopened } = openDb(otherPath);
  // (a) `epics` table is empty after the fn-648 v38→v39 rewind. Both
  // seeded epics are wiped before the chunked v34 backfill runs, so the
  // backfill has nothing to UPDATE and `resolved_epic_deps` stays
  // unpopulated by construction.
  const epicCount = (
    reopened.prepare("SELECT COUNT(*) AS n FROM epics").get() as { n: number }
  ).n;
  expect(epicCount).toBe(0);
  // (b) `epic_dep_edges` table exists (bootstrap CREATE IF NOT EXISTS) but
  // carries no rows — there are no epics for the backfill to derive from.
  const edges = reopened
    .prepare(
      "SELECT consumer_id, dep_token FROM epic_dep_edges ORDER BY consumer_id, dep_token",
    )
    .all() as { consumer_id: string; dep_token: string }[];
  expect(edges).toEqual([]);
  reopened.close();
  rmSync(otherTmp, { recursive: true, force: true });
});

test("v33→v34 migration is boot-twice idempotent: addColumnIfMissing + CREATE IF NOT EXISTS converge on second open (fn-637)", () => {
  // First open is a fresh v34 — CREATE_EPICS already declares
  // resolved_epic_deps and CREATE_EPIC_DEP_EDGES already creates the table.
  // Second open re-enters the bootstrap + ALTER block: the CREATE statements
  // no-op via `IF NOT EXISTS`, and `addColumnIfMissing` no-ops via the
  // PRAGMA table_info presence check. The block never throws "duplicate
  // column" / "table already exists" — that's the contract this test pins.
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));
  db.close();
  const { db: db2 } = openDb(dbPath);
  // Schema convergence ran clean on the second boot — the version stamp
  // is still 34, the column still exists, and the table still exists.
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe(String(SCHEMA_VERSION));
  const cols = db2.prepare("PRAGMA table_info(epics)").all() as {
    name: string;
  }[];
  expect(cols.some((c) => c.name === "resolved_epic_deps")).toBe(true);
  const tables = (
    db2.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  expect(tables).toContain("epic_dep_edges");
  db2.close();
});

test("v35 DB migrates to current: jobs.profile_name added; pre-existing rows wiped by v38→v39 rewind; idempotent re-open (fn-642, fn-648)", () => {
  // Build a v35-shaped DB by hand: a jobs table WITHOUT profile_name, two
  // pre-existing rows (one under a named profile dir, one default/NULL),
  // schema_version '35'. The v35→v36 step ADDs jobs.profile_name and
  // backfills it from config_dir via projectBasename — but then the
  // fn-648 v38→v39 rewind that follows in the same migrate transaction
  // wipes the jobs table, so the backfill's effect is invisible to the
  // post-migrate state. The boot drain (not run here) would re-seed jobs
  // from SessionStart events under the new reducer match logic; this
  // fixture has no events, so the jobs table reads empty after migrate.
  const v35 = new Database(dbPath, { create: true });
  v35.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT,
      start_time TEXT,
      plan_verb TEXT,
      plan_ref TEXT,
      epic_links TEXT NOT NULL DEFAULT '[]',
      last_api_error_at REAL,
      last_api_error_kind TEXT,
      last_input_request_at REAL,
      last_input_request_kind TEXT,
      config_dir TEXT,
      git_dirty_count INTEGER NOT NULL DEFAULT 0,
      git_unattributed_to_live_count INTEGER NOT NULL DEFAULT 0,
      git_orphan_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  v35.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v35.run("INSERT INTO meta (key, value) VALUES ('schema_version', '35')");
  v35.run(
    "INSERT INTO jobs (job_id, created_at, updated_at, config_dir) VALUES ('j-named', 1, 1, '/Users/x/.claude-profiles/multi-claude-3')",
  );
  v35.run(
    "INSERT INTO jobs (job_id, created_at, updated_at, config_dir) VALUES ('j-default', 2, 2, NULL)",
  );
  v35.close();

  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));
  const jobCols = (
    db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(jobCols).toContain("profile_name");
  // The v35→v36 backfill stamped profile_name on both seeded jobs rows,
  // but the fn-648 v38→v39 rewind in the same migrate transaction wiped
  // the jobs table afterwards — the post-migrate state is empty.
  const jobCount = (
    db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }
  ).n;
  expect(jobCount).toBe(0);
  db.close();

  // Idempotent re-open: second openDb is a no-op (addColumnIfMissing guards on
  // presence; the version-guarded backfill skips at stored ≥ 36).
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe(String(SCHEMA_VERSION));
  db2.close();
});

test("v38→v39: bash_mutation_* backfilled over historical PostToolUse:Bash rows via shared deriver; rewind wipes projections; idempotent re-run", () => {
  // Boot once at v39 so the events / jobs / epics / git_status /
  // file_attributions / subagent_invocations / reducer_state / meta tables
  // exist at the current shape. Then "downgrade" the stamped schema_version
  // to '38' and clear the two sparse bash_mutation columns on a seeded
  // PostToolUse:Bash row that — under the new deriver — should derive
  // `git-rm` with a single-target pathspec. A second openDb runs the
  // version-guarded backfill + rewind:
  //   - backfill: the seeded row's NULL columns must populate via the SAME
  //     `extractBashMutation` the hook calls steady-state, with the new
  //     `git-rm` kind landing.
  //   - rewind: cursor=0, jobs/epics/git_status/file_attributions/
  //     subagent_invocations rows wiped so the boot drain re-folds under the
  //     new reducer match logic.
  // A third openDb verifies idempotence: the stored version is now ≥ 39, so
  // neither the backfill nor the rewind re-runs (hand-seeded row survives).
  const { db: v39 } = openDb(dbPath);
  // Seed a `PostToolUse:Bash` event whose payload describes `git rm foo.txt`
  // — under the new deriver this yields kind=`git-rm` and a single resolved
  // pathspec target. Also seed a malformed-data row to pin the safe-NULL
  // branch (try/catch around JSON.parse, then the typeof guard).
  v39.run(
    `INSERT INTO events (
       ts, session_id, hook_event, event_type, tool_name, data
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      1,
      "sess-v39-backfill",
      "PostToolUse",
      "post_tool_use",
      "Bash",
      JSON.stringify({
        tool_input: { command: "git rm foo.txt" },
        tool_response: { stdout: "", stderr: "", interrupted: false },
      }),
    ],
  );
  v39.run(
    `INSERT INTO events (
       ts, session_id, hook_event, event_type, tool_name, data
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      2,
      "sess-v39-backfill",
      "PostToolUse",
      "post_tool_use",
      "Bash",
      "{ not valid json",
    ],
  );
  // Seed a non-Bash PostToolUse event to prove the WHERE clause scoping —
  // it must NOT be touched by the backfill.
  v39.run(
    `INSERT INTO events (
       ts, session_id, hook_event, event_type, tool_name, data
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    [3, "sess-v39-backfill", "PostToolUse", "post_tool_use", "Read", "{}"],
  );
  // Seed projection rows so the rewind can be observed wiping them.
  v39.run(
    "INSERT INTO jobs (job_id, created_at, updated_at) VALUES ('legacy-pre-v39', 0, 0)",
  );
  v39.run(
    "INSERT INTO epics (epic_id, epic_number, title, last_event_id, updated_at) VALUES ('e-pre-v39', 99, 't', 0, 0)",
  );
  v39.run("UPDATE reducer_state SET last_event_id = 4242 WHERE id = 1");
  // Clear the bash_mutation columns and downgrade the stamped version so
  // the v38→v39 slot's guard fires on next open.
  v39.run(
    "UPDATE events SET bash_mutation_kind = NULL, bash_mutation_targets = NULL",
  );
  // A faithful v38 DB predates `commit_trailer_facts` (created at v66→v67). Drop
  // the anachronistic v78-shaped table so the migrate-under-test recreates it via
  // the frozen v66→v67 CREATE+backfill (`planctl_*` literal) then renames forward
  // at v78 — without this, the v66→v67 backfill's `planctl_*` INSERT collides
  // with the pre-existing `plan_*` table.
  v39.run("DROP TABLE IF EXISTS commit_trailer_facts");
  v39.run("UPDATE meta SET value = '38' WHERE key = 'schema_version'");
  v39.close();

  // Second open: backfill walks PostToolUse:Bash rows; rewind wipes projections.
  const { db: migrated } = openDb(dbPath);

  // Version stamped forward to 39.
  const ver = migrated
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  // Backfill: the `git rm foo.txt` row now carries kind=`git-rm` and a
  // JSON-array of one target. The deriver resolves the bare pathspec
  // against the row's `cwd` (NULL here) so the path stays as-given.
  const gitRm = migrated
    .prepare(
      "SELECT bash_mutation_kind, bash_mutation_targets FROM events WHERE ts = 1",
    )
    .get() as {
    bash_mutation_kind: string | null;
    bash_mutation_targets: string | null;
  };
  expect(gitRm.bash_mutation_kind).toBe("git-rm");
  expect(gitRm.bash_mutation_targets).not.toBeNull();
  const gitRmTargets = JSON.parse(
    gitRm.bash_mutation_targets as string,
  ) as string[];
  expect(Array.isArray(gitRmTargets)).toBe(true);
  expect(gitRmTargets.length).toBe(1);
  expect(gitRmTargets[0]).toContain("foo.txt");

  // Malformed-payload row: defensive try/catch around JSON.parse folds to
  // (NULL, NULL) — the migration does not throw and the row is still
  // touched (the UPDATE writes NULL, the BEGIN IMMEDIATE proceeds).
  const malformed = migrated
    .prepare(
      "SELECT bash_mutation_kind, bash_mutation_targets FROM events WHERE ts = 2",
    )
    .get() as {
    bash_mutation_kind: string | null;
    bash_mutation_targets: string | null;
  };
  expect(malformed.bash_mutation_kind).toBeNull();
  expect(malformed.bash_mutation_targets).toBeNull();

  // Non-Bash PostToolUse row: untouched by the WHERE-scoped backfill —
  // NULL on both columns (its starting state).
  const nonBash = migrated
    .prepare(
      "SELECT bash_mutation_kind, bash_mutation_targets FROM events WHERE ts = 3",
    )
    .get() as {
    bash_mutation_kind: string | null;
    bash_mutation_targets: string | null;
  };
  expect(nonBash.bash_mutation_kind).toBeNull();
  expect(nonBash.bash_mutation_targets).toBeNull();

  // Rewind: cursor=0, projection tables wiped — boot drain (not run here)
  // re-folds under the new reducer logic when the daemon starts.
  const cursor = (
    migrated
      .prepare("SELECT last_event_id FROM reducer_state WHERE id = 1")
      .get() as { last_event_id: number }
  ).last_event_id;
  expect(cursor).toBe(0);
  expect(
    (migrated.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number })
      .n,
  ).toBe(0);
  expect(
    (migrated.prepare("SELECT COUNT(*) AS n FROM epics").get() as { n: number })
      .n,
  ).toBe(0);
  expect(
    (
      migrated.prepare("SELECT COUNT(*) AS n FROM git_status").get() as {
        n: number;
      }
    ).n,
  ).toBe(0);
  expect(
    (
      migrated.prepare("SELECT COUNT(*) AS n FROM file_attributions").get() as {
        n: number;
      }
    ).n,
  ).toBe(0);
  expect(
    (
      migrated
        .prepare("SELECT COUNT(*) AS n FROM subagent_invocations")
        .get() as { n: number }
    ).n,
  ).toBe(0);
  migrated.close();

  // Third open: idempotence. Stored version is now ≥ 39 — neither the
  // backfill nor the rewind re-runs. Hand-seed a row that the rewind WOULD
  // wipe; if the guard works the row survives.
  const { db: third } = openDb(dbPath);
  third.run(
    "INSERT INTO jobs (job_id, created_at, updated_at) VALUES ('post-v39-survivor', 0, 0)",
  );
  third.close();
  const { db: fourth } = openDb(dbPath);
  const survivor = fourth
    .prepare("SELECT job_id FROM jobs WHERE job_id = 'post-v39-survivor'")
    .get() as { job_id: string } | null;
  expect(survivor?.job_id).toBe("post-v39-survivor");
  const ver4 = fourth
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver4.value).toBe(String(SCHEMA_VERSION));
  fourth.close();
});

test("fresh v40 DB has jobs.name_history TEXT NOT NULL DEFAULT '[]' (fn-652)", () => {
  // Schema-shape gate: the new `name_history` column lands in the
  // CREATE_JOBS literal so a fresh-DB path and a migrated-DB path
  // converge on identical schema (the addColumnIfMissing/literal
  // lockstep convention). Mirrors `epic_links` exactly (TEXT NOT NULL
  // DEFAULT '[]') — same JSON-array convention used elsewhere in the
  // `jobs` projection.
  const { db } = openDb(":memory:");
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const nh = cols.find((c) => c.name === "name_history");
  expect(nh).toBeDefined();
  expect(nh?.type).toBe("TEXT");
  expect(nh?.notnull).toBe(1);
  expect(nh?.dflt_value).toBe("'[]'");
  db.close();
});

test("v39 DB migrates to v40: jobs.name_history added; existing rows backfilled then wiped by v41→v42 rewind; idempotent re-open (fn-652, fn-662)", () => {
  // Build a v39-shape DB by hand: a jobs table WITHOUT name_history, three
  // pre-existing rows (titled, NULL-title, and another titled), schema_version
  // '39'. The v39→v40 step ADDs jobs.name_history NOT NULL DEFAULT '[]' and
  // version-guard-backfills each row's seed from its current title.
  const v39 = new Database(dbPath, { create: true });
  v39.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT,
      start_time TEXT,
      plan_verb TEXT,
      plan_ref TEXT,
      epic_links TEXT NOT NULL DEFAULT '[]',
      last_api_error_at REAL,
      last_api_error_kind TEXT,
      last_input_request_at REAL,
      last_input_request_kind TEXT,
      config_dir TEXT,
      git_dirty_count INTEGER NOT NULL DEFAULT 0,
      git_unattributed_to_live_count INTEGER NOT NULL DEFAULT 0,
      git_orphan_count INTEGER NOT NULL DEFAULT 0,
      profile_name TEXT
    )
  `);
  v39.run(
    `CREATE TABLE reducer_state (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       last_event_id INTEGER NOT NULL DEFAULT 0,
       updated_at REAL NOT NULL
     )`,
  );
  v39.run(
    "INSERT INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 0, 0)",
  );
  v39.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v39.run("INSERT INTO meta (key, value) VALUES ('schema_version', '39')");
  v39.run(
    "INSERT INTO jobs (job_id, created_at, updated_at, title) VALUES ('j-titled', 1, 1, 'hello')",
  );
  v39.run(
    "INSERT INTO jobs (job_id, created_at, updated_at, title) VALUES ('j-null-title', 2, 2, NULL)",
  );
  v39.run(
    "INSERT INTO jobs (job_id, created_at, updated_at, title) VALUES ('j-other', 3, 3, 'world')",
  );
  v39.close();

  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  // (a) Column landed via addColumnIfMissing.
  const jobCols = (
    db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(jobCols).toContain("name_history");

  // (b) The v39→v40 backfill DID run (stored=39 < 40) and stamped
  // `name_history` per the seed rule, but the fn-662 v41→v42 rewind that
  // follows in the SAME migrate transaction wipes the jobs table — so the
  // post-migrate state shows the rows gone. The boot drain (not run here)
  // would re-seed jobs from SessionStart events under the new reducer
  // logic; this fixture has no events, so the jobs table reads empty.
  const jobCount = (
    db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }
  ).n;
  expect(jobCount).toBe(0);
  db.close();

  // (c) Idempotent re-open: a second openDb is a no-op (addColumnIfMissing
  // guards on presence; the v39→v40 backfill skips at stored ≥ 40; the
  // v41→v42 rewind skips at stored ≥ 42). Hand-seed a jobs row carrying a
  // distinct `name_history` to prove the second open does NOT re-rewind.
  const { db: db2 } = openDb(dbPath);
  db2.run(
    "INSERT INTO jobs (job_id, created_at, updated_at, title, name_history) VALUES ('j-survive', 9, 9, 'survivor', ?)",
    [JSON.stringify(["survivor"])],
  );
  db2.close();
  const { db: db3 } = openDb(dbPath);
  const persisted = db3
    .prepare("SELECT name_history FROM jobs WHERE job_id = 'j-survive'")
    .get() as { name_history: string } | null;
  expect(persisted?.name_history).toBe(JSON.stringify(["survivor"]));
  const ver3 = db3
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver3.value).toBe(String(SCHEMA_VERSION));
  db3.close();
});

// ---------------------------------------------------------------------------
// Schema v41 (fn-651) — usage.rate_limit_lifts_at + usage.last_usage_fold_at
// (retired v120 alongside the rest of `usage`; fn-1239 task .6)
// ---------------------------------------------------------------------------

test("v40 DB migrates to head: the transient v40→v41 usage ADD-column step still runs (no throw); usage is absent at head (fn-1239 task .6, formerly fn-651/fn-662)", () => {
  // Build a v40-shape DB by hand: a usage table WITHOUT the two v41 columns,
  // two pre-existing rows, schema_version '40'. The v40→v41 step still ADDs
  // the two nullable columns via addColumnIfMissing against the transient
  // table (no throw), the fn-662 v41→v42 rewind still wipes it, and the v120
  // tail DROP converges it to absent at head — proving the whole historical
  // walk survives even though nothing downstream reads `usage` anymore.
  const v40 = new Database(dbPath, { create: true });
  v40.run(`
    CREATE TABLE usage (
      id TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      multiplier INTEGER,
      session_percent REAL,
      session_resets_at TEXT,
      week_percent REAL,
      week_resets_at TEXT,
      sonnet_week_percent REAL,
      sonnet_week_resets_at TEXT,
      last_rate_limit_at REAL,
      last_rate_limit_session_id TEXT,
      status TEXT,
      subscription_active INTEGER,
      error_type TEXT,
      error_message TEXT,
      error_at TEXT,
      last_event_id INTEGER,
      updated_at REAL NOT NULL DEFAULT 0
    )
  `);
  v40.run(
    `CREATE TABLE reducer_state (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       last_event_id INTEGER NOT NULL DEFAULT 0,
       updated_at REAL NOT NULL
     )`,
  );
  v40.run(
    "INSERT INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 0, 0)",
  );
  v40.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v40.run("INSERT INTO meta (key, value) VALUES ('schema_version', '40')");
  v40.run(
    `INSERT INTO usage (id, target, multiplier, session_percent, last_event_id, updated_at)
       VALUES ('claude-default', 'claude', 5, 12.0, 100, 1)`,
  );
  v40.run(
    `INSERT INTO usage (id, target, multiplier, session_percent, last_event_id, updated_at)
       VALUES ('codex-default', 'codex', 1, 5.0, 101, 2)`,
  );
  v40.close();

  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  // usage is absent at head — the transient v40→v41 ADD-column step and the
  // v41→v42 rewind both ran against it without throwing, and the v120 tail
  // DROP converges the walk to the same shape as a fresh open.
  const hasUsage = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage'",
    )
    .get();
  expect(hasUsage ?? null).toBeNull();
  db.close();

  // Idempotent re-open: a second openDb is a no-op (every historical step is
  // idempotent or version-guarded; the v120 tail DROP TABLE IF EXISTS on an
  // already-absent table is a no-op); usage stays absent.
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe(String(SCHEMA_VERSION));
  const hasUsage2 = db2
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage'",
    )
    .get();
  expect(hasUsage2 ?? null).toBeNull();
  db2.close();
});

// ---------------------------------------------------------------------------
// Schema v48 (fn-668) — backend-exec coordinates on events + jobs
// ---------------------------------------------------------------------------

test("fresh DB has events.backend_exec_{type,session_id,pane_id} + jobs.backend_exec_{type,session_id,pane_id}; jobs tab cols dropped (fn-668, dropped fn-710 T2)", () => {
  // Schema-shape gate: the three event columns and three live jobs coords
  // land in the CREATE_EVENTS / CREATE_JOBS literals so a fresh-DB path and a
  // migrated-DB path converge on identical schema (the addColumnIfMissing /
  // literal lockstep convention). All nullable TEXT, no DEFAULT. The two dead
  // `jobs.backend_exec_tab_{id,name}` columns were dropped in fn-710 T2 (sole
  // writer was the now-removed BackendExecSnapshot fold) — assert they are GONE
  // from the fresh CREATE_JOBS literal.
  const { db } = openDb(":memory:");
  const eventCols = db.prepare("PRAGMA table_info(events)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  for (const name of [
    "backend_exec_type",
    "backend_exec_session_id",
    "backend_exec_pane_id",
  ]) {
    const col = eventCols.find((c) => c.name === name);
    expect(col).toBeDefined();
    expect(col?.type).toBe("TEXT");
    expect(col?.notnull).toBe(0);
    expect(col?.dflt_value).toBeNull();
  }
  const jobCols = db.prepare("PRAGMA table_info(jobs)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  for (const name of [
    "backend_exec_type",
    "backend_exec_session_id",
    "backend_exec_pane_id",
  ]) {
    const col = jobCols.find((c) => c.name === name);
    expect(col).toBeDefined();
    expect(col?.type).toBe("TEXT");
    expect(col?.notnull).toBe(0);
    expect(col?.dflt_value).toBeNull();
  }
  // The two dead tab columns must NOT exist on a fresh DB.
  const jobColNames = jobCols.map((c) => c.name);
  expect(jobColNames).not.toContain("backend_exec_tab_id");
  expect(jobColNames).not.toContain("backend_exec_tab_name");
  db.close();
});

test("v47 DB migrates to v48: events + jobs backend_exec_* columns added; existing rows preserved NULL; PRAGMA table_info byte-identical to fresh; idempotent re-open (fn-668)", () => {
  // Build a v47-shape DB by hand: events + jobs WITHOUT the new
  // `backend_exec_*` columns, stamped at `schema_version = 47`. Mirrors the
  // v21→v22 config_dir migration test — the canonical sparse-column ADD
  // pattern. Existing rows must read NULL on the new columns after the
  // upgrade (no backfill — pre-feature events have no recoverable env);
  // a second openDb must be a no-op (addColumnIfMissing guards on presence);
  // and `PRAGMA table_info` rows on the migrated DB must byte-match a fresh
  // v48 DB so the lockstep CREATE-vs-ALTER invariant holds.
  const v47 = new Database(dbPath, { create: true });
  v47.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      matcher TEXT,
      cwd TEXT,
      permission_mode TEXT,
      agent_id TEXT,
      agent_type TEXT,
      stop_hook_active INTEGER,
      data TEXT NOT NULL,
      subagent_agent_id TEXT,
      spawn_name TEXT,
      start_time TEXT,
      slash_command TEXT,
      skill_name TEXT,
      planctl_op TEXT,
      planctl_target TEXT,
      planctl_epic_id TEXT,
      planctl_task_id TEXT,
      planctl_subject_present INTEGER,
      tool_use_id TEXT,
      config_dir TEXT,
      planctl_queue_jump INTEGER,
      bash_mutation_kind TEXT,
      bash_mutation_targets TEXT,
      planctl_files TEXT
    )
  `);
  v47.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT,
      start_time TEXT,
      plan_verb TEXT,
      plan_ref TEXT,
      epic_links TEXT NOT NULL DEFAULT '[]',
      last_api_error_at REAL,
      last_api_error_kind TEXT,
      last_input_request_at REAL,
      last_input_request_kind TEXT,
      config_dir TEXT,
      git_dirty_count INTEGER NOT NULL DEFAULT 0,
      git_unattributed_to_live_count INTEGER NOT NULL DEFAULT 0,
      git_orphan_count INTEGER NOT NULL DEFAULT 0,
      profile_name TEXT,
      name_history TEXT NOT NULL DEFAULT '[]'
    )
  `);
  v47.run(
    `CREATE TABLE reducer_state (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       last_event_id INTEGER NOT NULL DEFAULT 0,
       updated_at REAL NOT NULL
     )`,
  );
  v47.run(
    "INSERT INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 0, 0)",
  );
  v47.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v47.run("INSERT INTO meta (key, value) VALUES ('schema_version', '47')");
  // Seed one row each so we can assert preservation.
  v47.run(
    "INSERT INTO events (ts, session_id, hook_event, event_type, data) VALUES (1, 'sess-pre', 'SessionStart', 'session_start', '{}')",
  );
  v47.run(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, title) VALUES ('sess-pre', 1, 1, 1, 'pre-feature')",
  );
  v47.close();

  // Reopen via openDb — migrate() runs every ADD COLUMN block from v47
  // forward, including the v51→v52 rewind-and-redrain (fn-686). The
  // schema_version stamp advances to current SCHEMA_VERSION.
  const { db } = openDb(dbPath);
  drainAll(db);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  // (a) New event columns present.
  const eventColsMig = (
    db.prepare("PRAGMA table_info(events)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(eventColsMig).toContain("backend_exec_type");
  expect(eventColsMig).toContain("backend_exec_session_id");
  expect(eventColsMig).toContain("backend_exec_pane_id");

  // (b) The three live job coords present; the two dead tab columns were
  // added at v48 then DROPPED at v55 (fn-710 T2) — assert they are GONE
  // after a full forward migration.
  const jobColsMig = (
    db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(jobColsMig).toContain("backend_exec_type");
  expect(jobColsMig).toContain("backend_exec_session_id");
  expect(jobColsMig).toContain("backend_exec_pane_id");
  expect(jobColsMig).not.toContain("backend_exec_tab_id");
  expect(jobColsMig).not.toContain("backend_exec_tab_name");

  // (c) Pre-existing events row preserved with NULL on every new column
  // (no backfill — pre-v48 events have no recoverable env). The event
  // log is immutable and outside the v52 rewind's DELETE list.
  const ev = db
    .prepare(
      "SELECT backend_exec_type, backend_exec_session_id, backend_exec_pane_id FROM events WHERE session_id = 'sess-pre'",
    )
    .get() as {
    backend_exec_type: string | null;
    backend_exec_session_id: string | null;
    backend_exec_pane_id: string | null;
  };
  expect(ev.backend_exec_type).toBeNull();
  expect(ev.backend_exec_session_id).toBeNull();
  expect(ev.backend_exec_pane_id).toBeNull();

  // (d) The hand-seeded jobs row was wiped by the v51→v52 rewind (fn-686
  // — the rewind wipes `jobs` / `epics` / `subagent_invocations` and
  // bumps the reducer cursor to 0); the post-rewind boot drain rebuilt
  // it from the seeded SessionStart event in the immutable log. `title`
  // is NULL (the SessionStart payload carries no title; the hand-seeded
  // "pre-feature" label is gone) and every backend_exec_* column is
  // NULL (no env on the pre-v48 event). Mirrors the v21→v22 / v40→v41
  // rewind-and-redrain test shape above.
  const job = db
    .prepare(
      `SELECT title, backend_exec_type, backend_exec_session_id,
              backend_exec_pane_id
         FROM jobs WHERE job_id = 'sess-pre'`,
    )
    .get() as {
    title: string | null;
    backend_exec_type: string | null;
    backend_exec_session_id: string | null;
    backend_exec_pane_id: string | null;
  };
  expect(job.title).toBeNull();
  expect(job.backend_exec_type).toBeNull();
  expect(job.backend_exec_session_id).toBeNull();
  expect(job.backend_exec_pane_id).toBeNull();

  // (e) Migrated PRAGMA table_info byte-matches a fresh DB — the
  // lockstep CREATE-vs-ALTER invariant. Both sides see the same column
  // list, types, NOT NULL flags, defaults, and PK positions.
  const migratedEvents = db.prepare("PRAGMA table_info(events)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }[];
  const migratedJobs = db.prepare("PRAGMA table_info(jobs)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }[];
  db.close();

  // Fresh DB on a separate tmp path.
  const freshDir = mkdtempSync(join(tmpdir(), "keeper-v48-fresh-"));
  const freshPath = join(freshDir, "keeper.db");
  const { db: freshDb } = openDb(freshPath);
  const freshEvents = freshDb.prepare("PRAGMA table_info(events)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }[];
  const freshJobs = freshDb.prepare("PRAGMA table_info(jobs)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }[];
  freshDb.close();
  rmSync(freshDir, { recursive: true, force: true });
  expect(migratedEvents).toEqual(freshEvents);
  expect(migratedJobs).toEqual(freshJobs);

  // (f) Idempotent re-open: a second openDb must be a no-op
  // (addColumnIfMissing/dropColumnIfPresent guard on column presence;
  // migrate stays version-stamped at the current SCHEMA_VERSION).
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe(String(SCHEMA_VERSION));
  db2.close();
});

test("v48 DB migrates to v49: whitelist-only bump (no new real column); rows preserved; schema_version advances; idempotent re-open (fn-670 T2)", () => {
  // The v48→v49 bump is whitelist-only — the new
  // `last_commit_for_task_at` field rides FREE inside the opaque
  // `epics.tasks[].jobs[]` JSON-TEXT cell. No ALTER, no backfill.
  // The migration's only effect is the `schema_version` stamp
  // advancing 48 → 49. Pre-v49 stored JSON elements lack the field;
  // JSON-decode reads it as `undefined` and the reducer's
  // `buildEmbeddedJob` coerces to `null` — re-fold determinism over
  // pre-/post-v49 events.
  const v48 = new Database(dbPath, { create: true });
  v48.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      matcher TEXT,
      cwd TEXT,
      permission_mode TEXT,
      agent_id TEXT,
      agent_type TEXT,
      stop_hook_active INTEGER,
      data TEXT NOT NULL,
      subagent_agent_id TEXT,
      spawn_name TEXT,
      start_time TEXT,
      slash_command TEXT,
      skill_name TEXT,
      planctl_op TEXT,
      planctl_target TEXT,
      planctl_epic_id TEXT,
      planctl_task_id TEXT,
      planctl_subject_present INTEGER,
      tool_use_id TEXT,
      config_dir TEXT,
      planctl_queue_jump INTEGER,
      bash_mutation_kind TEXT,
      bash_mutation_targets TEXT,
      planctl_files TEXT,
      backend_exec_type TEXT,
      backend_exec_session_id TEXT,
      backend_exec_pane_id TEXT
    )
  `);
  v48.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT,
      start_time TEXT,
      plan_verb TEXT,
      plan_ref TEXT,
      epic_links TEXT NOT NULL DEFAULT '[]',
      last_api_error_at REAL,
      last_api_error_kind TEXT,
      last_input_request_at REAL,
      last_input_request_kind TEXT,
      config_dir TEXT,
      git_dirty_count INTEGER NOT NULL DEFAULT 0,
      git_unattributed_to_live_count INTEGER NOT NULL DEFAULT 0,
      git_orphan_count INTEGER NOT NULL DEFAULT 0,
      profile_name TEXT,
      name_history TEXT NOT NULL DEFAULT '[]',
      backend_exec_type TEXT,
      backend_exec_session_id TEXT,
      backend_exec_pane_id TEXT,
      backend_exec_tab_id TEXT,
      backend_exec_tab_name TEXT
    )
  `);
  v48.run(
    `CREATE TABLE reducer_state (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       last_event_id INTEGER NOT NULL DEFAULT 0,
       updated_at REAL NOT NULL
     )`,
  );
  v48.run(
    "INSERT INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 0, 0)",
  );
  v48.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v48.run("INSERT INTO meta (key, value) VALUES ('schema_version', '48')");
  v48.run(
    "INSERT INTO events (ts, session_id, hook_event, event_type, data) VALUES (1, 'sess-pre', 'SessionStart', 'session_start', '{}')",
  );
  v48.run(
    "INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, title) VALUES ('sess-pre', 1, 1, 1, 'pre-v49')",
  );
  v48.close();

  // Reopen via openDb — migrate() advances the schema_version stamp
  // through every block from v48 forward, including the v51→v52
  // rewind-and-redrain (fn-686).
  const { db } = openDb(dbPath);
  drainAll(db);
  const verAfter = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(verAfter.value).toBe(String(SCHEMA_VERSION));

  // The event log is immutable and survives every rewind; the
  // pre-existing event row stays put.
  const ev = db
    .prepare(
      "SELECT session_id, hook_event FROM events WHERE session_id = 'sess-pre'",
    )
    .get() as { session_id: string; hook_event: string } | undefined;
  expect(ev?.session_id).toBe("sess-pre");
  expect(ev?.hook_event).toBe("SessionStart");

  // The hand-seeded jobs row was wiped by the v51→v52 rewind (fn-686
  // wipes `jobs` / `epics` / `subagent_invocations` and bumps the
  // reducer cursor to 0); the post-rewind boot drain rebuilt the row
  // from the seeded SessionStart event. `title` is NULL because the
  // SessionStart payload carries no title — the hand-seeded "pre-v49"
  // label is gone, matching the v21→v22 / v40→v41 rewind-and-redrain
  // test shape elsewhere in this file.
  const job = db
    .prepare("SELECT title FROM jobs WHERE job_id = 'sess-pre'")
    .get() as { title: string | null } | undefined;
  expect(job?.title).toBeNull();
  db.close();

  // Idempotent re-open — schema_version stays stamped at the current
  // SCHEMA_VERSION.
  const { db: db3 } = openDb(dbPath);
  const verIdem = db3
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(verIdem.value).toBe(String(SCHEMA_VERSION));
  db3.close();
});

test("v54 DB migrates to v55: jobs.backend_exec_tab_{id,name} dropped; live coords + rows preserved; PRAGMA table_info byte-identical to fresh; idempotent re-open (fn-710 T2)", () => {
  // Build a v54-shape `jobs` table by hand WITH the two dead
  // `backend_exec_tab_{id,name}` columns present, stamped at
  // `schema_version = 54`, then reopen via openDb so the v54→v55
  // dropColumnIfPresent step runs. The two tab columns must be GONE
  // after the upgrade; the three live coords + the row's other fields
  // survive; the migrated PRAGMA table_info byte-matches a fresh v55 DB
  // (lockstep CREATE-vs-DROP invariant); and a second openDb is a no-op
  // (dropColumnIfPresent guards on column presence). Mirrors the v47→v48
  // ADD-COLUMN migration test, inverted for a DROP.
  //
  // Stamped at 54 (not earlier) so the hand-seeded `jobs` row survives —
  // the earlier v51→v52 rewind-and-redrain slots are already behind a
  // v54 DB, so no cursor rewind wipes the projection here and the row's
  // tab/coord values are observable directly after migrate.
  const v54 = new Database(dbPath, { create: true });
  v54.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      matcher TEXT,
      cwd TEXT,
      permission_mode TEXT,
      agent_id TEXT,
      agent_type TEXT,
      stop_hook_active INTEGER,
      data TEXT NOT NULL,
      subagent_agent_id TEXT,
      spawn_name TEXT,
      start_time TEXT,
      slash_command TEXT,
      skill_name TEXT,
      planctl_op TEXT,
      planctl_target TEXT,
      planctl_epic_id TEXT,
      planctl_task_id TEXT,
      planctl_subject_present INTEGER,
      tool_use_id TEXT,
      config_dir TEXT,
      planctl_queue_jump INTEGER,
      bash_mutation_kind TEXT,
      bash_mutation_targets TEXT,
      planctl_files TEXT,
      backend_exec_type TEXT,
      backend_exec_session_id TEXT,
      backend_exec_pane_id TEXT,
      background_task_id TEXT
    )
  `);
  v54.run(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      created_at REAL NOT NULL,
      cwd TEXT,
      pid INTEGER,
      state TEXT NOT NULL DEFAULT 'stopped',
      last_event_id INTEGER,
      updated_at REAL NOT NULL,
      title TEXT,
      title_source TEXT,
      transcript_path TEXT,
      start_time TEXT,
      plan_verb TEXT,
      plan_ref TEXT,
      epic_links TEXT NOT NULL DEFAULT '[]',
      last_api_error_at REAL,
      last_api_error_kind TEXT,
      last_input_request_at REAL,
      last_input_request_kind TEXT,
      config_dir TEXT,
      git_dirty_count INTEGER NOT NULL DEFAULT 0,
      git_unattributed_to_live_count INTEGER NOT NULL DEFAULT 0,
      git_orphan_count INTEGER NOT NULL DEFAULT 0,
      profile_name TEXT,
      name_history TEXT NOT NULL DEFAULT '[]',
      backend_exec_type TEXT,
      backend_exec_session_id TEXT,
      backend_exec_pane_id TEXT,
      backend_exec_tab_id TEXT,
      backend_exec_tab_name TEXT,
      monitors TEXT NOT NULL DEFAULT '[]',
      last_permission_prompt_at REAL,
      last_permission_prompt_kind TEXT
    )
  `);
  v54.run(
    `CREATE TABLE reducer_state (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       last_event_id INTEGER NOT NULL DEFAULT 0,
       updated_at REAL NOT NULL
     )`,
  );
  v54.run(
    "INSERT INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 1, 0)",
  );
  v54.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v54.run("INSERT INTO meta (key, value) VALUES ('schema_version', '54')");
  // Seed a row carrying both the live coords AND the doomed tab values so
  // the post-drop SELECT proves the live coords survived the column drop.
  v54.run(
    `INSERT INTO jobs (
       job_id, created_at, last_event_id, updated_at, title,
       backend_exec_type, backend_exec_session_id, backend_exec_pane_id,
       backend_exec_tab_id, backend_exec_tab_name
     ) VALUES (
       'sess-pre', 1, 1, 1, 'pre-v55',
       'tmux', 'ada', '11', '3', 'main'
     )`,
  );
  v54.close();

  // Reopen via openDb — migrate() runs the v54→v55 dropColumnIfPresent
  // step and stamps the version forward.
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  // (a) The two dead tab columns are GONE; the three live coords remain.
  const jobColsMig = (
    db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(jobColsMig).not.toContain("backend_exec_tab_id");
  expect(jobColsMig).not.toContain("backend_exec_tab_name");
  expect(jobColsMig).toContain("backend_exec_type");
  expect(jobColsMig).toContain("backend_exec_session_id");
  expect(jobColsMig).toContain("backend_exec_pane_id");

  // (b) The v77 rewind-and-redrain (fn-856) wipes the `jobs` projection: the
  // hand-seeded `sess-pre` row had no backing event, so the from-scratch
  // re-fold the daemon runs after `openDb` does not rebuild it. The column DROP
  // mechanics are proven by the table-shape parity below (c); row preservation
  // across the v54→v55 DROP COLUMN is no longer observable end-to-end because a
  // later rewind clears the table. Confirm the row is gone.
  const job = db
    .prepare("SELECT job_id FROM jobs WHERE job_id = 'sess-pre'")
    .get() as { job_id: string } | null;
  expect(job).toBeNull();

  // (c) Migrated PRAGMA table_info byte-matches a fresh v55 DB — the
  // lockstep CREATE-vs-DROP invariant (CREATE_JOBS omits the tab columns,
  // the migration drops them; both converge on identical shape).
  const migratedJobs = db.prepare("PRAGMA table_info(jobs)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }[];
  db.close();

  const freshDir = mkdtempSync(join(tmpdir(), "keeper-v55-fresh-"));
  const freshPath = join(freshDir, "keeper.db");
  const { db: freshDb } = openDb(freshPath);
  const freshJobs = freshDb.prepare("PRAGMA table_info(jobs)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }[];
  freshDb.close();
  rmSync(freshDir, { recursive: true, force: true });
  expect(migratedJobs).toEqual(freshJobs);

  // (d) Idempotent re-open: a second openDb is a no-op — dropColumnIfPresent
  // reads PRAGMA table_info and skips the ALTER when the column is absent.
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe(String(SCHEMA_VERSION));
  const jobCols2 = (
    db2.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(jobCols2).not.toContain("backend_exec_tab_id");
  expect(jobCols2).not.toContain("backend_exec_tab_name");
  db2.close();
});

// fn-807.2: the v66→v67 commit_trailer_facts projection-table backfill.
const CTF_UUID = "01234567-89ab-cdef-0123-456789abcdef";
const CTF_UUID_2 = "fedcba98-7654-3210-fedc-ba9876543210";
const CTF_UUID_3 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CTF_OID = "0123456789abcdef0123456789abcdef01234567";
const CTF_OID_2 = "fedcba9876543210fedcba9876543210fedcba98";
const CTF_OID_3 = "abcdef0123456789abcdef0123456789abcdef01";

test("v66 DB migrates to v67: commit_trailer_facts table + indexes + backfill (inline + relocated + malformed/non-planctl skipped); idempotent re-open (fn-807.2)", () => {
  // Build a v66-shaped DB by hand: full current events shape + event_blobs +
  // reducer_state + meta, stamped at schema_version=66. Seed historical Commit
  // rows the v66→v67 backfill must walk through the SAME extractCommit +
  // parsePlanRef JS path the live fold uses:
  //   - inline planctl-trailer Commit (epic-form target)  → fact row
  //   - inline planctl-trailer Commit (task-form target)  → fact row, epic folded
  //   - RELOCATED planctl-trailer Commit (data in event_blobs, hot col NULL)
  //                                                        → fact row (COALESCE)
  //   - planctl-trailer Commit missing committer_session_id → SKIPPED
  //   - malformed-JSON Commit                             → SKIPPED (no throw)
  //   - non-planctl Commit (no trailer fields)            → SKIPPED
  //   - a non-Commit event                                → never considered
  const v66 = new Database(dbPath, { create: true });
  v66.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts REAL NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      hook_event TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      matcher TEXT,
      cwd TEXT,
      permission_mode TEXT,
      agent_id TEXT,
      agent_type TEXT,
      stop_hook_active INTEGER,
      data TEXT,
      subagent_agent_id TEXT,
      spawn_name TEXT,
      start_time TEXT,
      slash_command TEXT,
      skill_name TEXT,
      planctl_op TEXT,
      planctl_target TEXT,
      planctl_epic_id TEXT,
      planctl_task_id TEXT,
      planctl_subject_present INTEGER,
      tool_use_id TEXT,
      config_dir TEXT,
      planctl_queue_jump INTEGER,
      bash_mutation_kind TEXT,
      bash_mutation_targets TEXT,
      planctl_files TEXT,
      backend_exec_type TEXT,
      backend_exec_session_id TEXT,
      backend_exec_pane_id TEXT,
      background_task_id TEXT
    )
  `);
  v66.run(
    "CREATE TABLE event_blobs (event_id INTEGER PRIMARY KEY REFERENCES events(id), data TEXT NOT NULL)",
  );
  v66.run(
    `CREATE TABLE reducer_state (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       last_event_id INTEGER NOT NULL DEFAULT 0,
       updated_at REAL NOT NULL
     )`,
  );
  v66.run(
    "INSERT INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 0, 0)",
  );
  v66.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v66.run("INSERT INTO meta (key, value) VALUES ('schema_version', '66')");

  const commitData = (over: Record<string, unknown>): string =>
    JSON.stringify({
      project_dir: "/repo",
      commit_oid: CTF_OID,
      parent_oid: null,
      files: [
        { path: ".planctl/epics/x.json", blob_oid: null, committed_mode: null },
      ],
      committer_session_id: CTF_UUID,
      task_ids: [],
      planctl_op: "scaffold",
      planctl_target: "fn-1-inline",
      committed_at_ms: 5_000_000,
      ...over,
    });

  const insertCommit = v66.prepare(
    "INSERT INTO events (ts, session_id, hook_event, event_type, data) VALUES (?, ?, 'Commit', 'commit', ?)",
  );
  // (1) inline epic-form trailer.
  insertCommit.run(1, "/repo", commitData({}));
  // (2) inline task-form trailer (epic_id must fold to fn-2-task).
  insertCommit.run(
    2,
    "/repo",
    commitData({
      commit_oid: CTF_OID_2,
      committer_session_id: CTF_UUID_2,
      planctl_op: "set-title",
      planctl_target: "fn-2-task.3",
    }),
  );
  // (3) relocated trailer — seed the row, then move data to event_blobs.
  const relocId = Number(
    (
      insertCommit.run(
        3,
        "/repo",
        commitData({
          commit_oid: CTF_OID_3,
          committer_session_id: CTF_UUID_3,
          planctl_op: "scaffold",
          planctl_target: "fn-3-reloc",
        }),
      ) as { lastInsertRowid: number | bigint }
    ).lastInsertRowid,
  );
  v66.run(
    "INSERT INTO event_blobs (event_id, data) SELECT id, data FROM events WHERE id = ?",
    [relocId],
  );
  v66.run("UPDATE events SET data = NULL WHERE id = ?", [relocId]);
  // (4) planctl trailer but NULL committer_session_id → backfill skips.
  insertCommit.run(
    4,
    "/repo",
    commitData({
      committer_session_id: null,
      planctl_target: "fn-4-nosession",
    }),
  );
  // (5) malformed JSON → extractCommit returns null → skip, never throws.
  insertCommit.run(5, "/repo", "{not valid json");
  // (6) non-planctl Commit (no trailer fields) → skip.
  v66.run(
    "INSERT INTO events (ts, session_id, hook_event, event_type, data) VALUES (6, '/repo', 'Commit', 'commit', ?)",
    [
      JSON.stringify({
        project_dir: "/repo",
        commit_oid: CTF_OID,
        parent_oid: null,
        files: [{ path: "src/a.ts", blob_oid: null, committed_mode: null }],
      }),
    ],
  );
  // (7) a non-Commit event — never considered by the backfill.
  v66.run(
    "INSERT INTO events (ts, session_id, hook_event, event_type, data) VALUES (7, 's', 'SessionStart', 'session_start', '{}')",
  );
  v66.close();

  // Reopen via openDb — migrate() runs the v66→v67 CREATE + indexes + backfill.
  const { db } = openDb(dbPath);
  const ver = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver.value).toBe(String(SCHEMA_VERSION));

  // Table present with the named columns.
  const ctfCols = (
    db.prepare("PRAGMA table_info(commit_trailer_facts)").all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  expect(ctfCols).toEqual([
    "event_id",
    "committer_session_id",
    "plan_op",
    "plan_target",
    "plan_epic_id",
    "committed_at_ms",
  ]);

  // Both composite indexes present.
  const idxNames = new Set(
    (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='commit_trailer_facts'",
        )
        .all() as { name: string }[]
    ).map((i) => i.name),
  );
  expect(idxNames.has("idx_commit_trailer_facts_session")).toBe(true);
  expect(idxNames.has("idx_commit_trailer_facts_epic")).toBe(true);

  // Backfill: exactly the three valid trailers, malformed/non-planctl/no-session
  // skipped. Task-form target folds to its epic; relocated blob resolved.
  const facts = db
    .prepare("SELECT * FROM commit_trailer_facts ORDER BY event_id ASC")
    .all() as {
    event_id: number;
    committer_session_id: string;
    plan_op: string;
    plan_target: string;
    plan_epic_id: string | null;
    committed_at_ms: number;
  }[];
  expect(facts).toEqual([
    {
      event_id: 1,
      committer_session_id: CTF_UUID,
      plan_op: "scaffold",
      plan_target: "fn-1-inline",
      plan_epic_id: "fn-1-inline",
      committed_at_ms: 5_000_000,
    },
    {
      event_id: 2,
      committer_session_id: CTF_UUID_2,
      plan_op: "set-title",
      plan_target: "fn-2-task.3",
      plan_epic_id: "fn-2-task",
      committed_at_ms: 5_000_000,
    },
    {
      event_id: 3,
      committer_session_id: CTF_UUID_3,
      plan_op: "scaffold",
      plan_target: "fn-3-reloc",
      plan_epic_id: "fn-3-reloc",
      committed_at_ms: 5_000_000,
    },
  ]);

  // Second open is idempotent — the version-guarded backfill does not re-run
  // (and INSERT OR IGNORE on the event_id PK would no-op anyway); the row set
  // stays identical.
  db.close();
  const { db: db2 } = openDb(dbPath);
  const ver2 = db2
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string };
  expect(ver2.value).toBe(String(SCHEMA_VERSION));
  const factsAfter = db2
    .prepare("SELECT event_id FROM commit_trailer_facts ORDER BY event_id ASC")
    .all() as { event_id: number }[];
  expect(factsAfter.map((r) => r.event_id)).toEqual([1, 2, 3]);
  db2.close();
});

// fn-862.1 (F2): the v77 (fn-856) cursor-rewind migration wipes the canonical
// projection list but DELIBERATELY omits `commit_trailer_facts`. Re-fold
// idempotency rests on the table's append-only `INSERT OR IGNORE` keyed on
// `event_id`: the rewind replays the same Commit events as no-ops and the rows
// stay consistent. The comment at CREATE_COMMIT_TRAILER_FACTS calls this the
// "MUST NOT touch" invariant. db.test.ts had no `commit_trailer_facts` survival
// case across the rewind, and refold-equivalence.test.ts's
// `rewindAndWipeProjections` DELETEs the table before re-folding (the
// wipe-and-rebuild scenario, NOT this rewind-WITHOUT-wipe-preserves-rows one).
const CTF_V77_UUID_CREATOR = "11111111-2222-3333-4444-555555555555";
const CTF_V77_UUID_REFINER = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const CTF_V77_OID_CREATOR = "1111111111111111111111111111111111111111";
const CTF_V77_OID_REFINER = "2222222222222222222222222222222222222222";

test("v77 rewind preserves commit_trailer_facts (NOT in the wipe list); re-fold reproduces identical creator/refiner edges (fn-862.1)", () => {
  // Build a current-schema DB, seed two committer sessions + two planctl-trailer
  // Commit events (a `scaffold` creator and a `set-title` refiner, both naming
  // the SAME epic so its job_links carries both edges), and drain to populate
  // `commit_trailer_facts` + the link projections. Then rewind `schema_version`
  // to 76 and re-open: the v76→v77 migration runs the cursor-rewind + projection
  // wipe. The seeded facts MUST survive that wipe intact (a regression that
  // added the table to the wipe list would empty it here), and the post-wipe
  // re-fold MUST reproduce byte-identical edges (a regression that double-counted
  // the facts would drift the link arrays).
  const insertEvent = (
    db: Database,
    cols: {
      ts: number;
      session_id: string;
      hook_event: string;
      event_type: string;
      cwd?: string | null;
      data: string;
    },
  ): void => {
    db.prepare(
      `INSERT INTO events (ts, session_id, hook_event, event_type, cwd, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      cols.ts,
      cols.session_id,
      cols.hook_event,
      cols.event_type,
      cols.cwd ?? null,
      cols.data,
    );
  };

  const commitData = (
    oid: string,
    committerSessionId: string,
    planOp: string,
    planTarget: string,
  ): string =>
    JSON.stringify({
      project_dir: "/repo",
      commit_oid: oid,
      parent_oid: null,
      files: [
        { path: ".planctl/epics/x.json", blob_oid: null, committed_mode: null },
      ],
      committer_session_id: committerSessionId,
      task_ids: [],
      plan_op: planOp,
      plan_target: planTarget,
      committed_at_ms: 5_000_000,
    });

  // (1) Build + populate at the current schema.
  {
    const { db } = openDb(dbPath);
    // SessionStart events mint the jobs rows the link enrichment reads.
    insertEvent(db, {
      ts: 1,
      session_id: CTF_V77_UUID_CREATOR,
      hook_event: "SessionStart",
      event_type: "session_start",
      data: "{}",
    });
    insertEvent(db, {
      ts: 2,
      session_id: CTF_V77_UUID_REFINER,
      hook_event: "SessionStart",
      event_type: "session_start",
      data: "{}",
    });
    // Creator: scaffold of an epic-form target → `creator` edge.
    insertEvent(db, {
      ts: 5_000,
      session_id: "/repo",
      hook_event: "Commit",
      event_type: "commit",
      cwd: "/repo",
      data: commitData(
        CTF_V77_OID_CREATOR,
        CTF_V77_UUID_CREATOR,
        "scaffold",
        "fn-1-survives",
      ),
    });
    // Refiner: a non-create mutating op naming the SAME epic → `refiner` edge.
    insertEvent(db, {
      ts: 6_000,
      session_id: "/repo",
      hook_event: "Commit",
      event_type: "commit",
      cwd: "/repo",
      data: commitData(
        CTF_V77_OID_REFINER,
        CTF_V77_UUID_REFINER,
        "set-title",
        "fn-1-survives",
      ),
    });
    drainAll(db);
    db.close();
  }

  // Baseline: the facts the fold derived, plus the two link projection arrays.
  type Fact = {
    event_id: number;
    committer_session_id: string;
    plan_op: string;
    plan_target: string;
    plan_epic_id: string | null;
    committed_at_ms: number;
  };
  let baselineFacts: Fact[];
  let baselineEpicLinksCreator: string;
  let baselineEpicLinksRefiner: string;
  let baselineJobLinks: string;
  {
    const { db } = openDb(dbPath);
    baselineFacts = db
      .prepare("SELECT * FROM commit_trailer_facts ORDER BY event_id ASC")
      .all() as Fact[];
    // Sanity: the seed produced exactly the two trailer facts (epic-folded).
    expect(baselineFacts.map((f) => f.plan_target)).toEqual([
      "fn-1-survives",
      "fn-1-survives",
    ]);
    expect(baselineFacts.map((f) => f.plan_op)).toEqual([
      "scaffold",
      "set-title",
    ]);
    baselineEpicLinksCreator = (
      db
        .prepare("SELECT epic_links FROM jobs WHERE job_id = ?")
        .get(CTF_V77_UUID_CREATOR) as { epic_links: string }
    ).epic_links;
    baselineEpicLinksRefiner = (
      db
        .prepare("SELECT epic_links FROM jobs WHERE job_id = ?")
        .get(CTF_V77_UUID_REFINER) as { epic_links: string }
    ).epic_links;
    baselineJobLinks = (
      db
        .prepare("SELECT job_links FROM epics WHERE epic_id = ?")
        .get("fn-1-survives") as { job_links: string }
    ).job_links;
    // The baseline edges actually exist (otherwise the survival assertion is
    // vacuous): one creator edge, one refiner edge, both kinds on the epic.
    expect(baselineEpicLinksCreator).toContain('"creator"');
    expect(baselineEpicLinksRefiner).toContain('"refiner"');
    expect(baselineJobLinks).toContain('"creator"');
    expect(baselineJobLinks).toContain('"refiner"');

    // Rewind the version stamp to 76 so the next open runs the v76→v77 block.
    // Leave events + facts + projections in place — this is a pre-v77 DB whose
    // facts table is already populated, exactly the state the migration spares.
    db.run("UPDATE meta SET value = '76' WHERE key = 'schema_version'");
    db.close();
  }

  // (2) Re-open → the v76→v77 migration rewinds the cursor and wipes the
  // canonical projection list. Assert (a) facts survived intact BEFORE any
  // re-fold (proving the wipe spared the table, not that a re-fold rebuilt it),
  // and that the wipe did fire (the link projections are empty pre-drain).
  const { db } = openDb(dbPath);
  expect(
    (
      db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string }
    ).value,
  ).toBe(String(SCHEMA_VERSION));

  const survivedFacts = db
    .prepare("SELECT * FROM commit_trailer_facts ORDER BY event_id ASC")
    .all() as Fact[];
  expect(survivedFacts).toEqual(baselineFacts);

  // The wipe ran: the jobs/epics projections were emptied by the rewind, so the
  // edges are gone until the re-fold rebuilds them.
  expect(
    (db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n,
  ).toBe(0);
  expect(
    (db.prepare("SELECT COUNT(*) AS n FROM epics").get() as { n: number }).n,
  ).toBe(0);
  // The cursor was rewound to 0 so the re-fold replays the full log.
  expect(
    (
      db
        .prepare("SELECT last_event_id AS n FROM reducer_state WHERE id = 1")
        .get() as { n: number }
    ).n,
  ).toBe(0);

  // (3) Re-fold over the preserved facts. The Commit events re-INSERT OR IGNORE
  // the same fact rows as no-ops, and the classifier reproduces identical edges.
  drainAll(db);

  // (b) Facts unchanged after the re-fold (idempotent re-insert, no double-count).
  const refoldedFacts = db
    .prepare("SELECT * FROM commit_trailer_facts ORDER BY event_id ASC")
    .all() as Fact[];
  expect(refoldedFacts).toEqual(baselineFacts);

  // (b) The creator/refiner edges are byte-identical to the baseline — a wipe of
  // the facts (no backing rows for the commit-channel sweep) or a double-count
  // (duplicate edges) would diverge here.
  const refoldEpicLinksCreator = (
    db
      .prepare("SELECT epic_links FROM jobs WHERE job_id = ?")
      .get(CTF_V77_UUID_CREATOR) as { epic_links: string }
  ).epic_links;
  const refoldEpicLinksRefiner = (
    db
      .prepare("SELECT epic_links FROM jobs WHERE job_id = ?")
      .get(CTF_V77_UUID_REFINER) as { epic_links: string }
  ).epic_links;
  const refoldJobLinks = (
    db
      .prepare("SELECT job_links FROM epics WHERE epic_id = ?")
      .get("fn-1-survives") as { job_links: string }
  ).job_links;
  expect(refoldEpicLinksCreator).toBe(baselineEpicLinksCreator);
  expect(refoldEpicLinksRefiner).toBe(baselineEpicLinksRefiner);
  expect(refoldJobLinks).toBe(baselineJobLinks);
  db.close();
});

// ---------------------------------------------------------------------------
// fn-1134 — `effectivePerRootCap`: the single stored-intent → effective-cap
// derivation seam. Worktree off ⇒ always 1 (shared checkout safety); worktree on
// ⇒ the stored positive integer capped at a sanity ceiling, else the default
// (1). Fails closed on every malformed shape.
// ---------------------------------------------------------------------------

test("effectivePerRootCap — worktree ON passes a positive-integer stored value through the sanity clamp (fn-1134)", () => {
  expect(effectivePerRootCap(5, true)).toBe(5);
  expect(effectivePerRootCap(1, true)).toBe(1);
  expect(effectivePerRootCap(9999, true)).toBe(
    MAX_EFFECTIVE_CONCURRENT_PER_ROOT,
  );
});

test("effectivePerRootCap — worktree OFF floors every stored value to 1 (fn-1134)", () => {
  for (const stored of [5, 1, 3, 9999, null, undefined, 0, -1, 1.5]) {
    expect(effectivePerRootCap(stored, false)).toBe(1);
  }
  expect(DEFAULT_MAX_CONCURRENT_PER_ROOT).toBe(1);
});

test("effectivePerRootCap — worktree ON with a malformed/absent stored value fails closed to 1 (fn-1134)", () => {
  for (const bad of [
    null,
    undefined,
    0,
    -1,
    -3,
    1.5,
    "3",
    Number.NaN,
    {},
    [],
  ]) {
    expect(effectivePerRootCap(bad, true)).toBe(
      DEFAULT_MAX_CONCURRENT_PER_ROOT,
    );
  }
});

/**
 * Server-worker tests. Two layers, mirroring the wake-worker split:
 *
 * - Direct-call layer (no real Worker, no real socket): exercise lock-file
 *   ownership, `query → result` shaping (sort/limit/offset/filter), and the
 *   dispatch contract (malformed/unknown/unsubscribe) against a tmp DB. A fake
 *   `Writable` drives the backpressure path deterministically.
 * - One real spawned-Worker test: `{ type: "shutdown" }` → clean exit AND the
 *   socket file is gone, racing a 2s timeout.
 *
 * Every test gets its own `mkdtemp` dir so `--isolate` runs don't collide on
 * the socket/DB/lock paths; `KEEPER_DB` / `KEEPER_SOCK` are set per spawn.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countAndToken,
  EPICS_DESCRIPTOR,
  getCollection,
  JOBS_DESCRIPTOR,
  type Row,
} from "../src/collections";
import { openDb } from "../src/db";
import {
  type ErrorFrame,
  encodeFrame,
  type FilterValue,
  type MetaFrame,
  type PatchFrame,
  type ResultFrame,
  type RpcResultFrame,
  type ServerFrame,
} from "../src/protocol";
import {
  ASYNC_RPC_REGISTRY,
  acquireLock,
  BadParamsError,
  type ConnState,
  type DispatchAsyncCtx,
  diffTick,
  dispatchLine,
  handleKick,
  IDLE_CONN_TTL_MS,
  isPidAlive,
  LockHeldError,
  MAX_CONNECTIONS,
  META_MIN_INTERVAL_MS,
  newResultMemo,
  type PreSerialized,
  pollLoop,
  type ReplayBridge,
  type ResultMemo,
  RPC_REGISTRY,
  reapConns,
  registerAsyncRpc,
  registerRpc,
  resolveFilter,
  resumePending,
  runQuery,
  STUCK_PENDING_TTL_MS,
  type SubState,
  startServer,
  unregisterRpc,
  type Writable,
  writeFrames,
} from "../src/server-worker";
import { retryUntil } from "./helpers/retry-until";
import { freshDbFile } from "./helpers/template-db";

let tmpDir: string;
let dbPath: string;
let sockPath: string;
let lockPath: string;

function seedJob(
  db: Database,
  job_id: string,
  opts: Partial<{
    state: string;
    cwd: string;
    last_event_id: number;
    created_at: number;
    updated_at: number;
  }> = {},
): void {
  db.query(
    `INSERT INTO jobs (job_id, created_at, cwd, pid, state, last_event_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    job_id,
    opts.created_at ?? 1,
    opts.cwd ?? null,
    null,
    opts.state ?? "stopped",
    opts.last_event_id ?? 0,
    opts.updated_at ?? 1,
  );
}

function newConn(): ConnState {
  // Mirror the worker's per-connection state shape for direct dispatch.
  return dispatchInit();
}

/**
 * Read the anonymous (legacy single-sub) subscription off a conn — `null` is
 * the sentinel sub-id for queries without an explicit `id`. Returns
 * `undefined` when there is no anonymous sub (e.g. after `unsubscribe` with
 * no id, or before any query).
 */
function anonSub(conn: ConnState): SubState | undefined {
  return conn.subs.get(null);
}

/** Read a named sub off a conn, or `undefined` if absent. */
function subFor(conn: ConnState, id: string): SubState | undefined {
  return conn.subs.get(id);
}

function dispatchInit(): ConnState {
  // The module's newConnState is private; build the equivalent here.
  return {
    // LineBuffer isn't needed for direct dispatchLine calls (we pass whole
    // lines), but the field must exist to satisfy the type.
    buffer: {
      push: () => [],
      pendingLength: () => 0,
    } as unknown as ConnState["buffer"],
    subs: new Map(),
    pending: null,
    pendingSince: null,
    lastActivityAt: Date.now(),
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-server-test-"));
  dbPath = join(tmpDir, "keeper.db");
  sockPath = join(tmpDir, "keeperd.sock");
  lockPath = join(tmpDir, "keeperd.lock");
  // fn-769 file variant: the readonly server connection, the spawned-Worker
  // shutdown test, and the various reader/writer pairs all open this SAME path
  // (a `:memory:` clone is connection-private), so the migrated schema must
  // live on DISK. `freshDbFile` writes the pre-migrated template image to the
  // path (skipping the 63-version ladder); bodies re-open it migration-free.
  freshDbFile(dbPath).db.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Lock-file ownership
// ---------------------------------------------------------------------------

test("acquireLock writes our pid when no lock exists", () => {
  acquireLock(lockPath, sockPath);
  expect(existsSync(lockPath)).toBe(true);
  expect(readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));
});

test("acquireLock refuses when a live pid holds the lock", () => {
  // Our own pid is alive — write it as the holder.
  writeFileSync(lockPath, `${process.pid}\n`);
  expect(() => acquireLock(lockPath, sockPath)).toThrow(LockHeldError);
});

test("acquireLock steals a stale lock (dead pid) and unlinks the socket", () => {
  // A pid that is essentially never alive. process.kill(deadPid, 0) → ESRCH.
  const deadPid = 2147483646;
  expect(isPidAlive(deadPid)).toBe(false);
  writeFileSync(lockPath, `${deadPid}\n`);
  // Plant a stale socket file to prove it gets reclaimed.
  writeFileSync(sockPath, "");
  acquireLock(lockPath, sockPath);
  // Lock now holds OUR pid; the stale socket is gone.
  expect(readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));
  expect(existsSync(sockPath)).toBe(false);
});

test("isPidAlive is true for the current process", () => {
  expect(isPidAlive(process.pid)).toBe(true);
});

// ---------------------------------------------------------------------------
// query → result
// ---------------------------------------------------------------------------

/** Narrow a runQuery return to a ResultFrame, failing the test if it's an error. */
function asResult(frame: ResultFrame | ErrorFrame): ResultFrame {
  if (frame.type !== "result") {
    throw new Error(`expected result, got ${frame.type} (${frame.code})`);
  }
  return frame;
}

/** A row's job_id as a string (rows are generic `Row` post-namespacing). */
function jobId(row: Row): string {
  return String(row.job_id);
}

test("runQuery returns rows ordered by created_at desc by default", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { created_at: 10 });
  seedJob(db, "b", { created_at: 30 });
  seedJob(db, "c", { created_at: 20 });

  const res = asResult(runQuery(db, 7, { type: "query", collection: "jobs" }));
  expect(res.type).toBe("result");
  expect(res.collection).toBe("jobs");
  expect(res.rev).toBe(7);
  expect(res.rows.map(jobId)).toEqual(["b", "c", "a"]);
  db.close();
});

test("runQuery honors limit + offset", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  for (let i = 0; i < 5; i++) {
    seedJob(db, `j${i}`, { created_at: i });
  }
  // desc by created_at: j4,j3,j2,j1,j0. limit 2 offset 1 → j3,j2.
  const res = asResult(
    runQuery(db, 0, { type: "query", collection: "jobs", limit: 2, offset: 1 }),
  );
  expect(res.rows.map(jobId)).toEqual(["j3", "j2"]);
  db.close();
});

test("runQuery treats limit: 0 as 'no limit' — returns the full filtered set", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  // Seed more rows than the default page (DEFAULT_LIMIT is 100) so a plain
  // unlimited query would otherwise truncate; the 'no limit' sentinel must
  // return every row.
  const N = 150;
  for (let i = 0; i < N; i++) {
    seedJob(db, `j${String(i).padStart(3, "0")}`, { created_at: i });
  }
  const res = asResult(
    runQuery(db, 0, { type: "query", collection: "jobs", limit: 0 }),
  );
  expect(res.rows.length).toBe(N);
  expect(res.total).toBe(N);
  // Offset still applies under limit: 0 (LIMIT -1 OFFSET ? in SQL) so a
  // client can still skip a prefix and take every remaining row.
  const offset = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "jobs",
      limit: 0,
      offset: 10,
    }),
  );
  expect(offset.rows.length).toBe(N - 10);
  db.close();
});

test("runQuery applies a state filter", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "w", { state: "working", updated_at: 2 });
  seedJob(db, "s", { state: "stopped", updated_at: 1 });
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "jobs",
      filter: { state: "working" },
    }),
  );
  expect(res.rows.map(jobId)).toEqual(["w"]);
  db.close();
});

test("runQuery applies a not-equal (ne) state filter, excluding ended jobs", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "w", { state: "working", created_at: 3 });
  seedJob(db, "s", { state: "stopped", created_at: 2 });
  seedJob(db, "e", { state: "ended", created_at: 1 });
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "jobs",
      filter: { state: { ne: "ended" } },
    }),
  );
  // Live jobs only; `total` tracks the filtered (non-ended) set, not the table.
  expect(res.rows.map(jobId)).toEqual(["w", "s"]);
  expect(res.total).toBe(2);
  db.close();
});

test("resolveFilter: ne operator emits `!= ?`; unknown operator object ignored", () => {
  const ne = resolveFilter(JOBS_DESCRIPTOR, { state: { ne: "ended" } });
  expect(ne.clause).toBe("WHERE state != ?");
  expect(ne.params).toEqual(["ended"]);
  // A future/unrecognized operator object is silently dropped (forward-compat),
  // never interpolated — same discipline as an undeclared filter key.
  const unknown = resolveFilter(JOBS_DESCRIPTOR, {
    state: { gt: 1 } as unknown as FilterValue,
  });
  expect(unknown.clause).toBe("");
  expect(unknown.params).toEqual([]);
});

test("resolveFilter: in operator emits `IN (?, ?)`, binding one param per value", () => {
  const r = resolveFilter(JOBS_DESCRIPTOR, {
    state: { in: ["working", "stopped"] },
  });
  expect(r.clause).toBe("WHERE state IN (?, ?)");
  expect(r.params).toEqual(["working", "stopped"]);
});

test("resolveFilter: not_in operator emits `NOT IN (?, ?)`, binding one param per value", () => {
  const r = resolveFilter(JOBS_DESCRIPTOR, {
    state: { not_in: ["ended", "killed"] },
  });
  expect(r.clause).toBe("WHERE state NOT IN (?, ?)");
  expect(r.params).toEqual(["ended", "killed"]);
});

test("resolveFilter: empty in matches nothing (WHERE 0); empty not_in matches everything (no clause)", () => {
  // Empty IN: degenerate "match nothing" — emit an always-false guard rather
  // than synthesizing invalid SQL `IN ()`.
  const emptyIn = resolveFilter(JOBS_DESCRIPTOR, {
    state: { in: [] },
  });
  expect(emptyIn.clause).toBe("WHERE 0");
  expect(emptyIn.params).toEqual([]);
  // Empty NOT IN: degenerate "exclude nothing" — contribute no clause at all.
  const emptyNotIn = resolveFilter(JOBS_DESCRIPTOR, {
    state: { not_in: [] },
  });
  expect(emptyNotIn.clause).toBe("");
  expect(emptyNotIn.params).toEqual([]);
});

test("runQuery applies a not_in state filter, excluding terminal states", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "w", { state: "working", created_at: 4 });
  seedJob(db, "s", { state: "stopped", created_at: 3 });
  seedJob(db, "e", { state: "ended", created_at: 2 });
  seedJob(db, "k", { state: "killed", created_at: 1 });
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "jobs",
      filter: { state: { not_in: ["ended", "killed"] } },
    }),
  );
  expect(res.rows.map(jobId)).toEqual(["w", "s"]);
  expect(res.total).toBe(2);
  db.close();
});

test("runQuery applies an in state filter, including only listed states", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "w", { state: "working", created_at: 4 });
  seedJob(db, "s", { state: "stopped", created_at: 3 });
  seedJob(db, "e", { state: "ended", created_at: 2 });
  seedJob(db, "k", { state: "killed", created_at: 1 });
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "jobs",
      filter: { state: { in: ["ended", "killed"] } },
    }),
  );
  expect(res.rows.map(jobId)).toEqual(["e", "k"]);
  expect(res.total).toBe(2);
  db.close();
});

test("jobs descriptor defaults the view scope to live jobs (state NOT IN ended, killed)", () => {
  expect(JOBS_DESCRIPTOR.defaultFilter).toEqual({
    state: { not_in: ["ended", "killed"] },
  });
});

test("runQuery applies the default live scope, hiding both terminal states, unless overridden", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "w", { state: "working", created_at: 4 });
  seedJob(db, "s", { state: "stopped", created_at: 3 });
  seedJob(db, "e", { state: "ended", created_at: 2 });
  seedJob(db, "k", { state: "killed", created_at: 1 });
  // No filter → the default state NOT IN (ended, killed) scope hides both
  // terminal rows, leaving only working + stopped.
  const live = asResult(runQuery(db, 0, { type: "query", collection: "jobs" }));
  expect(live.total).toBe(2);
  expect(live.rows.map(jobId)).toEqual(["w", "s"]);
  // An explicit state filter overrides the default → only the ended job.
  const ended = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "jobs",
      filter: { state: "ended" },
    }),
  );
  expect(ended.rows.map(jobId)).toEqual(["e"]);
  // A pk lookup is exempt: it resolves the ended job by id.
  const pk = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "jobs",
      filter: { job_id: "e" },
    }),
  );
  expect(pk.rows.map(jobId)).toEqual(["e"]);
  db.close();
});

test("resolveFilter: epics default visible-scope applies bare, is dropped by ANY wire filter, exempts pk lookups", () => {
  // No filter → the descriptor's `defaultClause` is appended. Predicate is
  // "status open" (fn-756 dropped the old `approval` branch), materialized as
  // the schema-v32 VIRTUAL generated column `default_visible` and queried via
  // the literal single-column equality `default_visible = 1` (NOT
  // parameterized — the literal is required for the partial-index matcher to
  // land `idx_epics_default_visible`).
  const def = resolveFilter(EPICS_DESCRIPTOR, undefined);
  expect(def.clause).toBe("WHERE default_visible = 1");
  expect(def.params).toEqual([]);

  // An explicit status drops the defaultClause entirely (wire-not-empty is
  // the user's "I know what I want" override). Page now shows ONLY done
  // epics, which the default would have hidden.
  const statusOnly = resolveFilter(EPICS_DESCRIPTOR, { status: "done" });
  expect(statusOnly.clause).toBe("WHERE status = ?");
  expect(statusOnly.params).toEqual(["done"]);

  // A non-default filter key (project_dir) also counts as "wire-not-empty"
  // and drops the default — the scope is the wire's predicate alone.
  const byDir = resolveFilter(EPICS_DESCRIPTOR, { project_dir: "/r" });
  expect(byDir.clause).toBe("WHERE project_dir = ?");
  expect(byDir.params).toEqual(["/r"]);

  // A pk lookup is exempt from the default: it resolves one identity
  // regardless of status (a detail subscribe of a done epic must resolve).
  const pk = resolveFilter(EPICS_DESCRIPTOR, { epic_id: "fn-2-done" });
  expect(pk.clause).toBe("WHERE epic_id = ?");
  expect(pk.params).toEqual(["fn-2-done"]);
});

test("runQuery resolves the pk filter for a detail-page single-item subscribe", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { updated_at: 2 });
  seedJob(db, "b", { updated_at: 1 });
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "jobs",
      filter: { job_id: "a" },
    }),
  );
  expect(res.rows.map(jobId)).toEqual(["a"]);
  db.close();
});

/** Seed a job carrying a title (the live display column). */
function seedTitledJob(db: Database, job_id: string, title: string): void {
  db.query(
    `INSERT INTO jobs (job_id, created_at, last_event_id, updated_at, title)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(job_id, 1, 0, 1, title);
}

test("runQuery result rows serve title; title-less reads null and no title_history", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedTitledJob(db, "titled", "fix-osc");
  seedJob(db, "bare", { updated_at: 0 });
  const res = asResult(runQuery(db, 0, { type: "query", collection: "jobs" }));
  const titled = res.rows.find((r) => jobId(r) === "titled");
  const bare = res.rows.find((r) => jobId(r) === "bare");
  expect(titled?.title).toBe("fix-osc");
  expect(bare?.title).toBeNull();
  // title_history is retired — not a served column.
  expect("title_history" in (titled ?? {})).toBe(false);
  db.close();
});

test("diffTick patch row carries the updated title (parity with result)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedTitledJob(db, "a", "foo");
  setWorldRev(db, 42);
  const sock = fakeSock();
  watch(db, sock, { a: 0 }); // seeded from a snapshot read at version 0

  // Reducer folds a title change: bump last_event_id + rewrite title.
  db.query(
    "UPDATE jobs SET title = 'bar', last_event_id = 6, updated_at = updated_at + 1 WHERE job_id = 'a'",
  ).run();
  diffTick(db, [sock]);

  expect(sock.frames).toHaveLength(1);
  const patch = sock.frames[0] as PatchFrame;
  expect(patch.type).toBe("patch");
  expect(patch.row.title).toBe("bar");
  expect("title_history" in patch.row).toBe(false);
  db.close();
});

test("runQuery ignores a wire filter key not declared by the descriptor", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { updated_at: 2 });
  seedJob(db, "b", { updated_at: 1 });
  // `pid` is not in JOBS_DESCRIPTOR.filters → ignored, never interpolated; the
  // page is unfiltered (no throw, no injection).
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "jobs",
      filter: { pid: 999 },
    }),
  );
  expect(res.rows.map(jobId)).toEqual(["a", "b"]);
  db.close();
});

test("runQuery returns unknown_collection for a well-formed unknown collection", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a");
  const frame = runQuery(db, 3, {
    type: "query",
    collection: "plans",
    id: "q9",
  });
  expect(frame.type).toBe("error");
  const err = frame as ErrorFrame;
  expect(err.code).toBe("unknown_collection");
  expect(err.collection).toBe("plans");
  expect(err.id).toBe("q9");
  expect(err.rev).toBe(3);
  db.close();
});

test("runQuery echoes the query id + collection onto the result", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a");
  const res = asResult(
    runQuery(db, 1, { type: "query", collection: "jobs", id: "q1" }),
  );
  expect(res.id).toBe("q1");
  expect(res.collection).toBe("jobs");
  db.close();
});

test("runQuery falls back to created_at for an unknown sort column", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { created_at: 1 });
  seedJob(db, "b", { created_at: 2 });
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "jobs",
      sort: { column: "drop table jobs" },
    }),
  );
  // Default desc by created_at → b before a (no SQL injection, no throw).
  expect(res.rows.map(jobId)).toEqual(["b", "a"]);
  db.close();
});

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

test("dispatchLine query seeds the collection + watched-set + lastSent", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 5 });
  seedJob(db, "b", { last_event_id: 9 });
  const conn = newConn();
  const frames = dispatchLine(
    db,
    conn,
    JSON.stringify({ type: "query", collection: "jobs" }),
  );
  expect(frames).toHaveLength(1);
  expect((frames[0] as ResultFrame).type).toBe("result");
  const sub = anonSub(conn);
  expect(sub?.collection).toBe("jobs");
  expect([...(sub?.watched ?? [])].sort()).toEqual(["a", "b"]);
  expect(sub?.lastSent.get("a")).toBe(5);
  expect(sub?.lastSent.get("b")).toBe(9);
  db.close();
});

test("dispatchLine unsubscribe clears collection + watched-set", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a");
  const conn = newConn();
  dispatchLine(db, conn, JSON.stringify({ type: "query", collection: "jobs" }));
  expect(anonSub(conn)?.watched.size).toBe(1);
  expect(anonSub(conn)?.collection).toBe("jobs");
  const frames = dispatchLine(
    db,
    conn,
    JSON.stringify({ type: "unsubscribe" }),
  );
  expect(frames).toHaveLength(0);
  // Anonymous-bodied unsubscribe clears every sub on the conn.
  expect(conn.subs.size).toBe(0);
  expect(anonSub(conn)).toBeUndefined();
  db.close();
});

test("dispatchLine query with absent/empty/non-string collection → bad_frame", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a");
  const conn = newConn();
  for (const bad of [
    JSON.stringify({ type: "query" }), // absent
    JSON.stringify({ type: "query", collection: "" }), // empty
    JSON.stringify({ type: "query", collection: 42 }), // non-string
  ]) {
    const frames = dispatchLine(db, conn, bad);
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe("error");
    expect((frames[0] as ErrorFrame).code).toBe("bad_frame");
    // No subscription was ever established.
    expect(conn.subs.size).toBe(0);
  }
  db.close();
});

test("dispatchLine unknown collection → unknown_collection AND prior subscription survives", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 5 });
  const conn = newConn();
  // Establish a live subscription first.
  dispatchLine(db, conn, JSON.stringify({ type: "query", collection: "jobs" }));
  expect(anonSub(conn)?.collection).toBe("jobs");
  expect([...(anonSub(conn)?.watched ?? [])]).toEqual(["a"]);

  // A well-formed query naming an unregistered collection errors WITHOUT
  // touching the existing subscription. (Note: the new query carries `id:
  // "q2"`, which would be a SECOND sub if successful — it must not even
  // allocate that slot on the unknown_collection path.)
  const frames = dispatchLine(
    db,
    conn,
    JSON.stringify({ type: "query", collection: "plans", id: "q2" }),
  );
  expect(frames).toHaveLength(1);
  expect(frames[0].type).toBe("error");
  expect((frames[0] as ErrorFrame).code).toBe("unknown_collection");
  expect((frames[0] as ErrorFrame).collection).toBe("plans");
  // Prior subscription intact; no "q2" slot leaked.
  expect(anonSub(conn)?.collection).toBe("jobs");
  expect([...(anonSub(conn)?.watched ?? [])]).toEqual(["a"]);
  expect(anonSub(conn)?.lastSent.get("a")).toBe(5);
  expect(subFor(conn, "q2")).toBeUndefined();
  db.close();
});

test("dispatchLine returns an error frame for malformed JSON (connection survives)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const conn = newConn();
  const frames = dispatchLine(db, conn, "{not json");
  expect(frames).toHaveLength(1);
  expect(frames[0].type).toBe("error");
  expect((frames[0] as { code: string }).code).toBe("bad_frame");
  // A subsequent valid frame still works → connection state intact.
  seedJob(db, "a");
  const ok = dispatchLine(
    db,
    conn,
    JSON.stringify({ type: "query", collection: "jobs" }),
  );
  expect(ok[0].type).toBe("result");
  db.close();
});

test("dispatchLine returns an error frame for an unknown type", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const conn = newConn();
  const frames = dispatchLine(
    db,
    conn,
    JSON.stringify({ type: "bogus", id: "x" }),
  );
  expect(frames[0].type).toBe("error");
  expect((frames[0] as { code: string }).code).toBe("unknown_type");
  expect((frames[0] as { id?: string }).id).toBe("x");
  db.close();
});

test("dispatchLine ignores a blank line", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const conn = newConn();
  expect(dispatchLine(db, conn, "   ")).toHaveLength(0);
  db.close();
});

// ---------------------------------------------------------------------------
// rpc dispatch
// ---------------------------------------------------------------------------

/**
 * Register a temporary RPC handler scoped to one test. Returns a teardown the
 * test calls inside its own try/finally — beforeEach/afterEach are not
 * granular enough since each test installs a different handler.
 */
function withRpc(
  method: string,
  handler: (db: Database, params: unknown) => unknown,
): () => void {
  registerRpc(method, handler);
  return () => unregisterRpc(method);
}

test("RPC_REGISTRY is empty by default", () => {
  expect(RPC_REGISTRY.size).toBe(0);
});

test("dispatchLine rpc → rpc_result on a registered handler (echoes id, returns handler value)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const teardown = withRpc("noop", () => ({ ok: true }));
  try {
    const conn = newConn();
    const frames = dispatchLine(
      db,
      conn,
      JSON.stringify({ type: "rpc", id: "r1", method: "noop" }),
      db, // pass the writer (here, same DB) for the handler
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe("rpc_result");
    const result = frames[0] as RpcResultFrame;
    expect(result.id).toBe("r1");
    expect(result.value).toEqual({ ok: true });
    expect(typeof result.rev).toBe("number");
  } finally {
    teardown();
    db.close();
  }
});

test("dispatchLine rpc handler receives the writer connection and params", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const seen: { db: Database | null; params: unknown } = {
    db: null,
    params: "untouched",
  };
  const teardown = withRpc("inspect", (handlerDb, params) => {
    seen.db = handlerDb;
    seen.params = params;
    return null;
  });
  try {
    const conn = newConn();
    dispatchLine(
      db,
      conn,
      JSON.stringify({
        type: "rpc",
        id: "r1",
        method: "inspect",
        params: { foo: 1, bar: "baz" },
      }),
      db,
    );
    expect(seen.db).toBe(db);
    expect(seen.params).toEqual({ foo: 1, bar: "baz" });
  } finally {
    teardown();
    db.close();
  }
});

test("dispatchLine rpc → writer connection can INSERT and reader sees the row", () => {
  const { db: reader } = openDb(dbPath, { readonly: true });
  const { db: writer } = openDb(dbPath, { readonly: false, migrate: false });
  const teardown = withRpc("write_marker", (handlerDb) => {
    handlerDb.run(
      "INSERT INTO meta (key, value) VALUES ('test_rpc_marker', 'ok') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    );
    return { wrote: 1 };
  });
  try {
    const conn = newConn();
    const frames = dispatchLine(
      reader,
      conn,
      JSON.stringify({ type: "rpc", id: "r1", method: "write_marker" }),
      writer,
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe("rpc_result");
    // The reader (a distinct connection) sees the writer's commit.
    const row = reader
      .prepare("SELECT value FROM meta WHERE key = 'test_rpc_marker'")
      .get() as { value: string } | null;
    expect(row?.value).toBe("ok");
  } finally {
    teardown();
    reader.close();
    writer.close();
  }
});

test("dispatchLine rpc with no registered method → unknown_method (echoes id)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const conn = newConn();
  const frames = dispatchLine(
    db,
    conn,
    JSON.stringify({ type: "rpc", id: "r1", method: "no_such_method" }),
    db,
  );
  expect(frames).toHaveLength(1);
  expect(frames[0].type).toBe("error");
  const err = frames[0] as ErrorFrame;
  expect(err.code).toBe("unknown_method");
  expect(err.id).toBe("r1");
  db.close();
});

test("dispatchLine rpc handler throw → rpc_failed (echoes id, connection survives)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const teardown = withRpc("boom", () => {
    throw new Error("kaboom");
  });
  try {
    const conn = newConn();
    const frames = dispatchLine(
      db,
      conn,
      JSON.stringify({ type: "rpc", id: "r1", method: "boom" }),
      db,
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe("error");
    const err = frames[0] as ErrorFrame;
    expect(err.code).toBe("rpc_failed");
    expect(err.id).toBe("r1");
    expect(err.message).toContain("kaboom");

    // Connection survives: a follow-up query on the same conn works.
    seedJob(db, "a");
    const ok = dispatchLine(
      db,
      conn,
      JSON.stringify({ type: "query", collection: "jobs" }),
    );
    expect(ok[0].type).toBe("result");
  } finally {
    teardown();
    db.close();
  }
});

test("dispatchLine rpc handler throwing BadParamsError → bad_params (distinct from rpc_failed)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const teardown = withRpc("strict", () => {
    throw new BadParamsError("expected `status` of approve|reject|clear");
  });
  try {
    const conn = newConn();
    const frames = dispatchLine(
      db,
      conn,
      JSON.stringify({ type: "rpc", id: "r1", method: "strict", params: {} }),
      db,
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe("error");
    const err = frames[0] as ErrorFrame;
    expect(err.code).toBe("bad_params");
    expect(err.id).toBe("r1");
    expect(err.message).toContain("approve|reject|clear");
  } finally {
    teardown();
    db.close();
  }
});

test("dispatchLine rpc missing id → bad_frame (no id echoed)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const conn = newConn();
  for (const bad of [
    JSON.stringify({ type: "rpc", method: "noop" }), // absent id
    JSON.stringify({ type: "rpc", id: "", method: "noop" }), // empty id
    JSON.stringify({ type: "rpc", id: 42, method: "noop" }), // non-string id
  ]) {
    const frames = dispatchLine(db, conn, bad, db);
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe("error");
    expect((frames[0] as ErrorFrame).code).toBe("bad_frame");
    // No id was usable to echo back.
    expect((frames[0] as ErrorFrame).id).toBeUndefined();
  }
  db.close();
});

test("dispatchLine rpc missing method → bad_frame (echoes id)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const conn = newConn();
  for (const bad of [
    JSON.stringify({ type: "rpc", id: "r1" }), // absent method
    JSON.stringify({ type: "rpc", id: "r1", method: "" }), // empty method
    JSON.stringify({ type: "rpc", id: "r1", method: 42 }), // non-string method
  ]) {
    const frames = dispatchLine(db, conn, bad, db);
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe("error");
    expect((frames[0] as ErrorFrame).code).toBe("bad_frame");
    expect((frames[0] as ErrorFrame).id).toBe("r1");
  }
  db.close();
});

test("dispatchLine rpc preserves an existing subscription (rpc does not touch ConnState)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const teardown = withRpc("noop", () => null);
  try {
    seedJob(db, "a", { last_event_id: 5 });
    const conn = newConn();
    dispatchLine(
      db,
      conn,
      JSON.stringify({ type: "query", collection: "jobs" }),
    );
    expect(anonSub(conn)?.collection).toBe("jobs");
    expect(anonSub(conn)?.watched.has("a")).toBe(true);

    // An RPC in the middle of a live subscription must NOT touch ConnState.
    dispatchLine(
      db,
      conn,
      JSON.stringify({ type: "rpc", id: "r1", method: "noop" }),
      db,
    );
    expect(anonSub(conn)?.collection).toBe("jobs");
    expect(anonSub(conn)?.watched.has("a")).toBe(true);
    expect(anonSub(conn)?.lastSent.get("a")).toBe(5);
  } finally {
    teardown();
    db.close();
  }
});

test("registerRpc throws on duplicate method", () => {
  const teardown = withRpc("dup", () => null);
  try {
    expect(() => registerRpc("dup", () => null)).toThrow(/already registered/);
  } finally {
    teardown();
  }
});

// ---------------------------------------------------------------------------
// Async RPC dispatch (fn-643 task .4 — `replay_dead_letter` substrate)
// ---------------------------------------------------------------------------

/**
 * Build a stub `DispatchAsyncCtx` with a synchronous-resolving bridge and a
 * collector for frames delivered via `onAsyncResult`. The handler returns
 * the value the bridge resolves with.
 */
function asyncCtxStub(opts: {
  replay: () => Promise<{
    ok: boolean;
    recovered_dl_id?: string | null;
    error?: string;
  }>;
}): {
  ctx: DispatchAsyncCtx;
  bridgeCalls: { count: number };
  delivered: ServerFrame[][];
} {
  const bridgeCalls = { count: 0 };
  const delivered: ServerFrame[][] = [];
  const bridge: ReplayBridge = {
    async replay() {
      bridgeCalls.count += 1;
      return opts.replay();
    },
    // Not exercised by the replay async-RPC tests; satisfies the
    // fn-661/fn-751-extended interface without affecting these test cases.
    async setAutopilotPaused() {
      return { ok: true };
    },
    async retryDispatch() {
      return { ok: true };
    },
    async setAutopilotMode() {
      return { ok: true };
    },
    async setEpicArmed() {
      return { ok: true };
    },
  };
  const ctx: DispatchAsyncCtx = {
    bridge,
    onAsyncResult: (frames) => {
      delivered.push(frames);
    },
  };
  return { ctx, bridgeCalls, delivered };
}

function withAsyncRpc(
  method: string,
  handler: (params: unknown, bridge: ReplayBridge) => Promise<unknown>,
): () => void {
  registerAsyncRpc(method, handler);
  return () => unregisterRpc(method);
}

test("ASYNC_RPC_REGISTRY is empty by default", () => {
  expect(ASYNC_RPC_REGISTRY.size).toBe(0);
});

test("dispatchLine async rpc → returns [] inline; ctx.onAsyncResult delivers rpc_result on resolution", async () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const teardown = withAsyncRpc("async_noop", async (_params, bridge) => {
    const r = await bridge.replay();
    return { ok: true, dl: r.recovered_dl_id };
  });
  try {
    const conn = newConn();
    const { ctx, bridgeCalls, delivered } = asyncCtxStub({
      replay: async () => ({ ok: true, recovered_dl_id: "dl-7" }),
    });
    const inline = dispatchLine(
      db,
      conn,
      JSON.stringify({ type: "rpc", id: "r1", method: "async_noop" }),
      db,
      ctx,
    );
    expect(inline).toEqual([]);
    // Let the microtask queue flush so the resolved promise lands.
    await Bun.sleep(10);
    expect(bridgeCalls.count).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toHaveLength(1);
    const frame = delivered[0][0] as RpcResultFrame;
    expect(frame.type).toBe("rpc_result");
    expect(frame.id).toBe("r1");
    expect(frame.value).toEqual({ ok: true, dl: "dl-7" });
  } finally {
    teardown();
    db.close();
  }
});

test("dispatchLine async rpc → handler throw flows to rpc_failed via onAsyncResult", async () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const teardown = withAsyncRpc("async_boom", async () => {
    throw new Error("kaboom-async");
  });
  try {
    const conn = newConn();
    const { ctx, delivered } = asyncCtxStub({
      replay: async () => ({ ok: true, recovered_dl_id: null }),
    });
    const inline = dispatchLine(
      db,
      conn,
      JSON.stringify({ type: "rpc", id: "r1", method: "async_boom" }),
      db,
      ctx,
    );
    expect(inline).toEqual([]);
    await Bun.sleep(10);
    expect(delivered).toHaveLength(1);
    const frame = delivered[0][0] as ErrorFrame;
    expect(frame.type).toBe("error");
    expect(frame.code).toBe("rpc_failed");
    expect(frame.id).toBe("r1");
    expect(frame.message).toContain("kaboom-async");
  } finally {
    teardown();
    db.close();
  }
});

test("dispatchLine async rpc → BadParamsError throw flows to bad_params via onAsyncResult", async () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const teardown = withAsyncRpc("async_strict", async () => {
    throw new BadParamsError("nope shape mismatch");
  });
  try {
    const conn = newConn();
    const { ctx, delivered } = asyncCtxStub({
      replay: async () => ({ ok: true }),
    });
    dispatchLine(
      db,
      conn,
      JSON.stringify({ type: "rpc", id: "r1", method: "async_strict" }),
      db,
      ctx,
    );
    await Bun.sleep(10);
    expect(delivered).toHaveLength(1);
    const frame = delivered[0][0] as ErrorFrame;
    expect(frame.code).toBe("bad_params");
    expect(frame.id).toBe("r1");
    expect(frame.message).toContain("nope shape mismatch");
  } finally {
    teardown();
    db.close();
  }
});

test("dispatchLine async rpc without asyncCtx → unknown_method (legacy sync caller is unchanged)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const teardown = withAsyncRpc("async_no_ctx", async () => ({ ok: true }));
  try {
    const conn = newConn();
    const frames = dispatchLine(
      db,
      conn,
      JSON.stringify({ type: "rpc", id: "r1", method: "async_no_ctx" }),
      db,
      // no asyncCtx — caller hasn't opted in
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe("error");
    expect((frames[0] as ErrorFrame).code).toBe("unknown_method");
    expect((frames[0] as ErrorFrame).id).toBe("r1");
  } finally {
    teardown();
    db.close();
  }
});

test("registerAsyncRpc collides with a same-name sync registration", () => {
  const teardown = withRpc("collide", () => null);
  try {
    expect(() => registerAsyncRpc("collide", async () => null)).toThrow(
      /already registered/,
    );
  } finally {
    teardown();
  }
});

test("registerRpc collides with a same-name async registration", () => {
  const teardown = withAsyncRpc("collide_async", async () => null);
  try {
    expect(() => registerRpc("collide_async", () => null)).toThrow(
      /already registered/,
    );
  } finally {
    teardown();
  }
});

// ---------------------------------------------------------------------------
// fn-661 task .4 — async dispatch via the extended ReplayBridge
// ---------------------------------------------------------------------------

test("dispatchLine async rpc → handler reaches bridge.setAutopilotPaused (round-trip + rpc_result delivery)", async () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const teardown = withAsyncRpc("ap_paused_probe", async (_p, bridge) => {
    const r = await bridge.setAutopilotPaused(true);
    return { ok: true, relay: r.ok };
  });
  try {
    const conn = newConn();
    const setPausedCalls: boolean[] = [];
    const delivered: ServerFrame[][] = [];
    const bridge: ReplayBridge = {
      async replay() {
        return { ok: true, recovered_dl_id: null };
      },
      async setAutopilotPaused(paused) {
        setPausedCalls.push(paused);
        return { ok: true };
      },
      async retryDispatch() {
        return { ok: true };
      },
      async setAutopilotMode() {
        return { ok: true };
      },
      async setEpicArmed() {
        return { ok: true };
      },
    };
    const ctx: DispatchAsyncCtx = {
      bridge,
      onAsyncResult: (frames) => delivered.push(frames),
    };
    const inline = dispatchLine(
      db,
      conn,
      JSON.stringify({ type: "rpc", id: "r1", method: "ap_paused_probe" }),
      db,
      ctx,
    );
    expect(inline).toEqual([]);
    await Bun.sleep(10);
    expect(setPausedCalls).toEqual([true]);
    expect(delivered).toHaveLength(1);
    const frame = delivered[0][0] as RpcResultFrame;
    expect(frame.type).toBe("rpc_result");
    expect(frame.id).toBe("r1");
    expect(frame.value).toEqual({ ok: true, relay: true });
  } finally {
    teardown();
    db.close();
  }
});

test("dispatchLine async rpc → handler reaches bridge.retryDispatch with the split (verb, id) pair", async () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const teardown = withAsyncRpc("retry_dispatch_probe", async (_p, bridge) => {
    return await bridge.retryDispatch("work", "fn-1-foo.3");
  });
  try {
    const conn = newConn();
    const retryCalls: Array<{ verb: string; id: string }> = [];
    const delivered: ServerFrame[][] = [];
    const bridge: ReplayBridge = {
      async replay() {
        return { ok: true, recovered_dl_id: null };
      },
      async setAutopilotPaused() {
        return { ok: true };
      },
      async retryDispatch(verb, id) {
        retryCalls.push({ verb, id });
        return { ok: true };
      },
      async setAutopilotMode() {
        return { ok: true };
      },
      async setEpicArmed() {
        return { ok: true };
      },
    };
    const ctx: DispatchAsyncCtx = {
      bridge,
      onAsyncResult: (frames) => delivered.push(frames),
    };
    const inline = dispatchLine(
      db,
      conn,
      JSON.stringify({ type: "rpc", id: "r1", method: "retry_dispatch_probe" }),
      db,
      ctx,
    );
    expect(inline).toEqual([]);
    await Bun.sleep(10);
    expect(retryCalls).toEqual([{ verb: "work", id: "fn-1-foo.3" }]);
    expect(delivered).toHaveLength(1);
    const frame = delivered[0][0] as RpcResultFrame;
    expect(frame.type).toBe("rpc_result");
    expect(frame.id).toBe("r1");
  } finally {
    teardown();
    db.close();
  }
});

// ---------------------------------------------------------------------------
// backpressure
// ---------------------------------------------------------------------------

test("writeFrames stashes the remainder on a short write and drain resumes it", () => {
  // Fake socket: accept only `cap` bytes per write, return 0 thereafter until
  // we "drain" (reset accepted budget).
  const accepted: number[] = [];
  let budget = 10; // bytes the socket will take before reporting backpressure
  const sock: Writable = {
    data: { ...newConn(), pending: null },
    write(data, off = 0, len = data.length - off) {
      if (budget <= 0) {
        return 0;
      }
      const take = Math.min(budget, len);
      for (let i = 0; i < take; i++) {
        accepted.push(data[off + i] ?? 0);
      }
      budget -= take;
      return take;
    },
  };

  const frame: ServerFrame = {
    type: "error",
    rev: 1,
    code: "x",
    message: "0123456789ABCDEF", // long enough to exceed the 10-byte budget
  };
  writeFrames(sock, [frame]);
  // Budget exhausted mid-frame → a remainder is stashed.
  expect(sock.data.pending).not.toBeNull();
  const before = accepted.length;
  expect(before).toBe(10);

  // "drain": refill the budget and resume.
  budget = 1000;
  resumePending(sock);
  expect(sock.data.pending).toBeNull();

  // The full encoded frame (JSON + "\n") landed across the two writes.
  const expected = `${JSON.stringify(frame)}\n`;
  const got = Buffer.from(Uint8Array.from(accepted)).toString("utf8");
  expect(got).toBe(expected);
});

test("writeFrames drops the remainder when write returns negative (socket closing)", () => {
  const sock: Writable = {
    data: { ...newConn(), pending: null },
    write() {
      return -1;
    },
  };
  writeFrames(sock, [{ type: "error", rev: 0, code: "x", message: "hi" }]);
  expect(sock.data.pending).toBeNull();
});

// ---------------------------------------------------------------------------
// real bind + spawned-Worker shutdown
// ---------------------------------------------------------------------------

test("startServer binds the socket and stop() releases socket + lock", () => {
  const { db } = openDb(dbPath, { readonly: true });
  const server = startServer(db, sockPath, lockPath);
  expect(server.listener.unix).toBe(sockPath);
  expect(existsSync(sockPath)).toBe(true);
  expect(existsSync(lockPath)).toBe(true);
  server.stop();
  expect(existsSync(sockPath)).toBe(false);
  expect(existsSync(lockPath)).toBe(false);
  db.close();
});

test("spawned Worker shuts down cleanly and removes the socket file", async () => {
  const worker = new Worker(
    new URL("../src/server-worker.ts", import.meta.url).href,
    {
      workerData: { role: "server", dbPath, sockPath, lockPath },
    } as WorkerOptions & { workerData: unknown },
  );

  let closed = false;
  worker.addEventListener("close", () => {
    closed = true;
  });

  // Wait for the `ready` signal so we know the socket is bound.
  await new Promise<void>((resolve) => {
    worker.addEventListener("message", (ev: MessageEvent) => {
      if ((ev.data as { kind?: string })?.kind === "ready") {
        resolve();
      }
    });
  });
  expect(existsSync(sockPath)).toBe(true);

  worker.postMessage({ type: "shutdown" });

  // Flag-only poll: the `{kind:"ready"}` gate above guarantees the worker is
  // listening, so the shutdown trigger can't be missed — no re-emit needed.
  const ok = await retryUntil(() => closed || null, 20_000);
  expect(ok).toBe(true);
  expect(existsSync(sockPath)).toBe(false);
  expect(existsSync(lockPath)).toBe(false);
});

// ---------------------------------------------------------------------------
// realtime poll → diff → patch
// ---------------------------------------------------------------------------

/**
 * A fake socket that records every frame written to it (decoded from the
 * NDJSON bytes `writeFrames` produces). Drives `diffTick` deterministically
 * without a real `Bun.Socket`.
 *
 * Backpressure / liveness knobs (fn-723 task .2):
 * - `accept = false` → `write()` returns 0 (buffer full): the frame stays
 *   `pending` and the connection is skipped by `diffTick`.
 * - `closing = true` → `write()` returns -1 (EPIPE/socket closing): `flush`
 *   drops the tail AND calls `end()` to evict the dead conn.
 * - `end()` is the eviction spy — `ended` flips true and, when a backing
 *   `conns` Set is wired (the reaper/cap proofs), the sock removes itself from
 *   it, mirroring the Bun `close` handler's `conns.delete`.
 */
function fakeSock(conns?: Set<Writable>): Writable & {
  frames: ServerFrame[];
  accept: boolean;
  closing: boolean;
  ended: boolean;
} {
  const sock = {
    data: dispatchInit(),
    accept: true,
    closing: false,
    ended: false,
    frames: [] as ServerFrame[],
    write(data: Uint8Array, off = 0, len = data.length - off): number {
      if (this.closing) {
        return -1; // socket closing: EPIPE — flush drops the tail and evicts
      }
      if (!this.accept) {
        return 0; // backpressure: nothing accepted, remainder stashed
      }
      const text = Buffer.from(data.subarray(off, off + len)).toString("utf8");
      for (const line of text.split("\n")) {
        if (line.length > 0) {
          this.frames.push(JSON.parse(line) as ServerFrame);
        }
      }
      return len;
    },
    end(): void {
      this.ended = true;
      // Mirror the Bun `close` handler: an evicted conn leaves `conns`.
      conns?.delete(this as unknown as Writable);
    },
  };
  return sock;
}

/**
 * Seed a subscription on a connection: its collection + watched-set + lastSent
 * (from the rows the originating query would have paged) PLUS the membership
 * baseline (`where` + `lastTotal` + `lastToken`) the meta pass diffs against.
 * `diffTick` iterates `(sock, subId, sub)` triples and groups by
 * `sub.collection`, so each call here installs ONE sub on the socket.
 *
 * `filter` is the wire filter the subscription was built from (`{}` =
 * unfiltered, the jobs default). The membership baseline is seeded from the SAME
 * resolved filter / countAndToken the server would have used.
 *
 * `subId` keys the sub in `sock.data.subs`. The default `null` preserves the
 * legacy anonymous-sub shape so the 35+ existing call sites work unchanged;
 * multi-sub tests pass explicit string ids to install named subs.
 */
function watch(
  db: Database,
  sock: Writable,
  seed: Record<string, number>,
  filter: Record<string, FilterValue> = {},
  collection = "jobs",
  subId: string | null = null,
): void {
  const descriptor = getCollection(collection);
  if (!descriptor) {
    throw new Error(`watch: no such collection: ${collection}`);
  }
  const where = resolveFilter(descriptor, filter);
  const { total, token } = countAndToken(
    db,
    descriptor,
    where.clause,
    where.params,
  );
  sock.data.subs.set(subId, {
    collection,
    watched: new Set(Object.keys(seed)),
    lastSent: new Map(Object.entries(seed)),
    where,
    lastTotal: total,
    lastToken: token,
    // Matches the real subscribe path (server-worker.ts): a fresh sub seeds the
    // meta-emit clock to 0 so its FIRST membership move always emits. Throttle
    // tests override this to Date.now() to simulate a recent emit.
    lastMetaEmittedAt: 0,
  });
}

/** Bump a job's last_event_id (and updated_at) — simulates a reducer fold. */
function advanceJob(db: Database, job_id: string, last_event_id: number): void {
  db.query(
    "UPDATE jobs SET last_event_id = ?, updated_at = updated_at + 1 WHERE job_id = ?",
  ).run(last_event_id, job_id);
}

/** Set the world rev so emitted frames carry a known `rev`. */
function setWorldRev(db: Database, rev: number): void {
  db.query("UPDATE reducer_state SET last_event_id = ? WHERE id = 1").run(rev);
}

test("diffTick pushes one patch when a watched row advances; rev is stamped", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 5 });
  setWorldRev(db, 42);
  const sock = fakeSock();
  watch(db, sock, { a: 5 }); // seeded from the snapshot read

  advanceJob(db, "a", 6); // reducer folded a new event for `a`
  diffTick(db, [sock]);

  expect(sock.frames).toHaveLength(1);
  const patch = sock.frames[0] as PatchFrame;
  expect(patch.type).toBe("patch");
  expect(patch.collection).toBe("jobs");
  expect(jobId(patch.row)).toBe("a");
  expect(patch.row.last_event_id).toBe(6);
  expect(patch.rev).toBe(42);
  // lastSent advanced to the pushed value.
  expect(sock.data.subs.get(null)?.lastSent.get("a")).toBe(6);
  db.close();
});

test("diffTick emits nothing when no watched row advanced (no-op tick)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 5 });
  seedJob(db, "other", { last_event_id: 1 });
  const sock = fakeSock();
  watch(db, sock, { a: 5 });

  // An unrelated job folds — the watched id is unchanged.
  advanceJob(db, "other", 9);
  diffTick(db, [sock]);

  expect(sock.frames).toHaveLength(0);
  db.close();
});

test("diffTick does not double-send: a second tick with no change emits nothing", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 5 });
  const sock = fakeSock();
  watch(db, sock, { a: 5 });

  advanceJob(db, "a", 6);
  diffTick(db, [sock]);
  expect(sock.frames).toHaveLength(1);

  // Immediate re-tick, no further fold → no new patch.
  diffTick(db, [sock]);
  expect(sock.frames).toHaveLength(1);
  db.close();
});

// fn-694 lever B: the `{type:"kick"}` fast path runs diffTick on a post-fold
// kick from main. `handleKick` is the try/catch-wrapped helper the worker's
// message handler calls; driving it directly proves the kick emits the pending
// patch and is idempotent against a subsequent poll/kick double-fire.
test("handleKick emits the pending patch on a post-fold kick", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 5 });
  setWorldRev(db, 42);
  const sock = fakeSock();
  watch(db, sock, { a: 5 });

  advanceJob(db, "a", 6); // reducer folded; main kicks us
  handleKick(db, [sock]);

  expect(sock.frames).toHaveLength(1);
  const patch = sock.frames[0] as PatchFrame;
  expect(patch.type).toBe("patch");
  expect(patch.row.last_event_id).toBe(6);
  expect(patch.rev).toBe(42);
  expect(sock.data.subs.get(null)?.lastSent.get("a")).toBe(6);
  db.close();
});

test("handleKick + a subsequent kick/poll double-fire is idempotent", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 5 });
  const sock = fakeSock();
  watch(db, sock, { a: 5 });

  advanceJob(db, "a", 6);
  handleKick(db, [sock]); // kick (main's post-fold message)
  expect(sock.frames).toHaveLength(1);

  // The poll's local `last` is not advanced by the kick, so the next poll
  // re-diffs — and a second kick can race it. Neither re-emits: diffTick is
  // version-gated, so both are harmless no-ops.
  diffTick(db, [sock]); // backstop poll re-diff
  handleKick(db, [sock]); // second kick
  expect(sock.frames).toHaveLength(1);
  db.close();
});

test("handleKick never throws out of the handler when diffTick fails", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 5 });
  const sock = fakeSock();
  watch(db, sock, { a: 5 });
  db.close(); // force diffTick's read to throw (connection closed)

  // The worker message handler is in the no-self-heal path: a throw here would
  // crash the worker and bounce the daemon. handleKick must swallow it.
  expect(() => handleKick(db, [sock])).not.toThrow();
});

// ---------------------------------------------------------------------------
// fn-723 task .2 — connection reaping + max-conn cap.
//
// The server must bound its connection set so leaked headless orphan viewers
// (the 2026-06-06 incident) can never again saturate the serial diff fan-out:
// (1) EPIPE-evict a dead conn (write<0 on a diff write), (2) evict a
// dead-but-backpressured conn via a stuck-pending TTL (it's skipped by diffTick
// so it never EPIPEs), (3) reject-new at a hard cap. All in the no-self-heal
// path — a reap throw must never escape.
// ---------------------------------------------------------------------------

test("diffTick EPIPE-evicts a dead conn (write<0) from conns and calls end()", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 5 });
  const conns = new Set<Writable>();
  const sock = fakeSock(conns);
  conns.add(sock);
  watch(db, sock, { a: 5 });

  // The socket is closing: the next diff write returns -1 (EPIPE). `flush` must
  // drop the tail AND evict — end() the sock, which removes it from `conns`.
  sock.closing = true;
  advanceJob(db, "a", 6);
  diffTick(db, conns);

  expect(sock.ended).toBe(true);
  expect(conns.has(sock)).toBe(false);
  db.close();
});

test("diffTick does NOT evict a live attached conn (no false-evict)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 5 });
  const conns = new Set<Writable>();
  const sock = fakeSock(conns); // accept=true, closing=false, no pending
  conns.add(sock);
  watch(db, sock, { a: 5 });

  advanceJob(db, "a", 6);
  diffTick(db, conns);

  // A healthy conn gets its patch and stays in the set, untouched.
  expect(sock.frames).toHaveLength(1);
  expect(sock.ended).toBe(false);
  expect(conns.has(sock)).toBe(true);
  db.close();
});

test("diffTick stuck-pending TTL evicts a backpressured-too-long conn", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 5 });
  const conns = new Set<Writable>();
  const sock = fakeSock(conns);
  conns.add(sock);
  watch(db, sock, { a: 5 });

  // Simulate a conn that backpressured long ago: a non-empty pending buffer and
  // a `pendingSince` aged well past the ceiling (the "fake clock advance").
  sock.data.pending = { bytes: new Uint8Array([1]), offset: 0 };
  sock.data.pendingSince = Date.now() - (STUCK_PENDING_TTL_MS + 1);

  diffTick(db, conns);

  expect(sock.ended).toBe(true);
  expect(conns.has(sock)).toBe(false);
  db.close();
});

test("diffTick stuck-pending TTL does NOT evict a freshly-backpressured conn", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 5 });
  const conns = new Set<Writable>();
  const sock = fakeSock(conns);
  conns.add(sock);
  watch(db, sock, { a: 5 });

  // Backpressured, but only just now — well within the ceiling. Not reaped.
  sock.data.pending = { bytes: new Uint8Array([1]), offset: 0 };
  sock.data.pendingSince = Date.now();

  diffTick(db, conns);

  expect(sock.ended).toBe(false);
  expect(conns.has(sock)).toBe(true);
  db.close();
});

test("diffTick stuck-pending TTL leaves a quiet receive-only conn alone", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 5 });
  const conns = new Set<Writable>();
  const sock = fakeSock(conns);
  conns.add(sock);
  watch(db, sock, { a: 5 });

  // No backpressure (pending === null, pendingSince === null) — a quiet board
  // during a DB-quiet period. The TTL is NOT an idle timer: never evicted.
  expect(sock.data.pending).toBeNull();
  expect(sock.data.pendingSince).toBeNull();

  diffTick(db, conns); // an idle tick (nothing changed)

  expect(sock.ended).toBe(false);
  expect(conns.has(sock)).toBe(true);
  db.close();
});

// ---------------------------------------------------------------------------
// fn-767 — zero-sub idle sweep + every-tick reap.
//
// The ghost-conn leak class: a one-shot query-only client connects, queries,
// and dies in a way the kernel never reports (SIGKILL mid-frame, half-open) —
// firing NEITHER close NOR error. With zero subs it's never in a diff fanout
// (no EPIPE-evict) and `pending === null` (the stuck-pending TTL is inert), so
// it lingers in `conns` forever. The idle sweep evicts a zero-sub conn past
// IDLE_CONN_TTL_MS; a subscribed conn is ALWAYS exempt; and the reapers now run
// on every poll tick, not only `data_version`-changed ticks.
// ---------------------------------------------------------------------------

test("diffTick idle-sweep evicts a zero-sub conn idle past the TTL", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const conns = new Set<Writable>();
  const sock = fakeSock(conns);
  conns.add(sock);

  // A one-shot client that connected + queried long ago and then died silently:
  // zero subscriptions, no backpressure (pending === null), last activity aged
  // well past the ceiling (the "fake clock advance"). This is the leak class.
  expect(sock.data.subs.size).toBe(0);
  sock.data.lastActivityAt = Date.now() - (IDLE_CONN_TTL_MS + 1);

  diffTick(db, conns); // a DB-quiet tick (no subs, nothing to diff)

  expect(sock.ended).toBe(true);
  expect(conns.has(sock)).toBe(false);
  db.close();
});

test("diffTick idle-sweep does NOT evict a fresh zero-sub conn (mid-handshake)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const conns = new Set<Writable>();
  const sock = fakeSock(conns);
  conns.add(sock);

  // Zero subs but just connected (lastActivityAt = now, set by dispatchInit) —
  // a client still mid-handshake / about to query. Never swept.
  expect(sock.data.subs.size).toBe(0);
  expect(Date.now() - sock.data.lastActivityAt).toBeLessThan(IDLE_CONN_TTL_MS);

  diffTick(db, conns);

  expect(sock.ended).toBe(false);
  expect(conns.has(sock)).toBe(true);
  db.close();
});

test("idle-sweep NEVER evicts a subscribed conn, however long it has been quiet", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 5 });
  const conns = new Set<Writable>();
  const sock = fakeSock(conns);
  conns.add(sock);
  watch(db, sock, { a: 5 });

  // A legit board: one long-lived sub, silent during a long DB-quiet period.
  // Its lastActivityAt is ancient (no inbound frames since the subscribe), but
  // the sub-count exemption keeps it alive regardless (the fn-723 no-ping-pong
  // descope stands).
  expect(sock.data.subs.size).toBe(1);
  sock.data.lastActivityAt = Date.now() - IDLE_CONN_TTL_MS * 100;

  reapConns([...conns]);

  expect(sock.ended).toBe(false);
  expect(conns.has(sock)).toBe(true);
  db.close();
});

test("reapConns runs both arms: stuck-pending AND idle zero-sub eviction", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const conns = new Set<Writable>();

  // Arm 1: a backpressured-too-long conn (stuck-pending TTL).
  const stuck = fakeSock(conns);
  conns.add(stuck);
  stuck.data.pending = { bytes: new Uint8Array([1]), offset: 0 };
  stuck.data.pendingSince = Date.now() - (STUCK_PENDING_TTL_MS + 1);

  // Arm 2: an idle zero-sub conn (idle sweep).
  const idle = fakeSock(conns);
  conns.add(idle);
  idle.data.lastActivityAt = Date.now() - (IDLE_CONN_TTL_MS + 1);

  reapConns([...conns]);

  expect(stuck.ended).toBe(true);
  expect(idle.ended).toBe(true);
  expect(conns.size).toBe(0);
  db.close();
});

test("an idle-sweep end() throw is swallowed (no-self-heal) and siblings still reap", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const conns = new Set<Writable>();

  // First conn's end() throws; the second must still be reaped.
  const boomer = fakeSock(conns);
  conns.add(boomer);
  boomer.data.lastActivityAt = Date.now() - (IDLE_CONN_TTL_MS + 1);
  boomer.end = () => {
    throw new Error("boom");
  };

  const sibling = fakeSock(conns);
  conns.add(sibling);
  sibling.data.lastActivityAt = Date.now() - (IDLE_CONN_TTL_MS + 1);

  expect(() => reapConns([...conns])).not.toThrow();
  // The sibling was reaped despite the boomer's throw.
  expect(sibling.ended).toBe(true);
  expect(conns.has(sibling)).toBe(false);
  db.close();
});

test("pollLoop reaps idle zero-sub conns on a DB-quiet tick (no data_version change)", async () => {
  // The deferred fn-723 gap, now closed: the reapers must run on EVERY tick,
  // not only `data_version`-changed ticks. A two-connection real DB so the
  // pollLoop's PRAGMA data_version read sees a frozen counter (no writes), then
  // assert the idle zero-sub conn is evicted anyway.
  const { db } = openDb(dbPath, { readonly: true });
  const conns = new Set<Writable>();
  const idle = fakeSock(conns);
  conns.add(idle);
  idle.data.lastActivityAt = Date.now() - (IDLE_CONN_TTL_MS + 1);

  let stop = false;
  const loop = pollLoop(
    db,
    () => conns,
    () => stop,
    25,
  );
  // No DB write happens — data_version stays frozen. The reaper must still fire.
  const reaped = await retryUntil(() =>
    idle.ended && !conns.has(idle) ? true : null,
  );
  stop = true;
  await loop;

  expect(reaped).toBe(true);
  db.close();
});

test("hard-killed client (SIGKILL, no FIN) is idle-swept from conns", async () => {
  // The hard-death class the kernel never reports as a close: a child process
  // connects, then is SIGKILLed mid-life. On some paths Bun observes the FIN
  // and fires `close` (evicting immediately); on others (half-open) it does
  // not. Either way the idle sweep is the backstop — force the conn's clock
  // past the ceiling and assert a poll tick evicts it. Drives a REAL server +
  // real client socket so the open/close handler wiring is exercised end-to-end.
  const { db } = openDb(dbPath, { readonly: true });
  const server = startServer(db, sockPath, lockPath);

  const client = await Bun.connect({
    unix: sockPath,
    socket: { data() {}, error() {} },
  });
  // Wait for the server to register the conn.
  const seen = await retryUntil(() =>
    server.conns.size === 1 ? [...server.conns][0] : null,
  );
  if (!seen) {
    throw new Error("server never registered the client connection");
  }

  // Simulate the silent-death window: the client is gone but the kernel hasn't
  // reported it (no subs, no activity). Age the server-side conn's clock past
  // the ceiling and tear the client down hard.
  seen.data.lastActivityAt = Date.now() - (IDLE_CONN_TTL_MS + 1);
  client.terminate();

  // The next poll tick's reapConns evicts the aged zero-sub conn.
  const drained = await retryUntil(() =>
    server.conns.size === 0 ? true : null,
  );
  expect(drained).toBe(true);

  server.stop();
  db.close();
});

test("overlapping one-shot query churn returns conns to baseline (never approaches cap)", async () => {
  // The incident shape: N overlapping (not sequential) one-shot clients connect,
  // query, and exit. Clean exits fire the Bun `close` handler → conns.delete, so
  // the set must return to baseline (0) and never approach MAX_CONNECTIONS — even
  // with the churn concurrent. Real server + real clients end-to-end.
  const { db } = openDb(dbPath, { readonly: true });
  const server = startServer(db, sockPath, lockPath);

  const N = 30; // well under the 64 cap; overlapping, not staggered
  let peak = 0;
  const clients: Array<Awaited<ReturnType<typeof Bun.connect>>> = [];
  for (let i = 0; i < N; i++) {
    clients.push(
      await Bun.connect({
        unix: sockPath,
        socket: { data() {}, error() {} },
      }),
    );
    peak = Math.max(peak, server.conns.size);
  }
  // All N admitted concurrently — never rejected, never near the cap.
  await retryUntil(() => (server.conns.size === N ? true : null));
  expect(server.conns.size).toBe(N);
  expect(peak).toBeLessThan(MAX_CONNECTIONS);

  // Every client exits cleanly (FIN): the close handler must drain conns to 0.
  for (const c of clients) {
    c.end();
  }
  const baseline = await retryUntil(() =>
    server.conns.size === 0 ? true : null,
  );
  expect(baseline).toBe(true);

  server.stop();
  db.close();
});

test("flush stamps pendingSince on backpressure and clears it on drain", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 5 });
  const sock = fakeSock();
  watch(db, sock, { a: 5 });

  // Backpressure the conn: the diff write stashes a tail and stamps the clock.
  sock.accept = false;
  advanceJob(db, "a", 6);
  diffTick(db, [sock]);
  expect(sock.data.pending).not.toBeNull();
  expect(sock.data.pendingSince).not.toBeNull();

  // Drain: resumePending fully flushes, clearing both the buffer and the clock.
  sock.accept = true;
  resumePending(sock);
  expect(sock.data.pending).toBeNull();
  expect(sock.data.pendingSince).toBeNull();
  db.close();
});

test("a reap-tick throw is swallowed (no-self-heal) by handleKick", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 5 });
  const sock = fakeSock();
  watch(db, sock, { a: 5 });

  // A stuck-pending conn whose end() throws: the reaper must catch it, and
  // handleKick wraps the whole tick — neither path may escape.
  sock.data.pending = { bytes: new Uint8Array([1]), offset: 0 };
  sock.data.pendingSince = Date.now() - (STUCK_PENDING_TTL_MS + 1);
  sock.end = () => {
    throw new Error("boom");
  };

  expect(() => handleKick(db, [sock])).not.toThrow();
  db.close();
});

test("max-conn cap rejects a new connection with an error frame + close; the oldest survives", async () => {
  const { db } = openDb(dbPath, { readonly: true });
  const server = startServer(db, sockPath, lockPath);

  // Open exactly MAX_CONNECTIONS clients — all should be admitted.
  const clients: Array<Awaited<ReturnType<typeof Bun.connect>>> = [];
  for (let i = 0; i < MAX_CONNECTIONS; i++) {
    clients.push(
      await Bun.connect({
        unix: sockPath,
        socket: { data() {}, error() {} },
      }),
    );
  }
  await retryUntil(() => (server.conns.size === MAX_CONNECTIONS ? true : null));

  // The (cap+1)th connection is rejected: it receives a `max_connections`
  // error frame then the server closes it. Capture the frame on the client.
  const rejectFrames: Array<{ type?: string; code?: string }> = [];
  const overflow = await Bun.connect({
    unix: sockPath,
    socket: {
      data(_s, chunk: Buffer) {
        for (const line of chunk.toString("utf8").split("\n")) {
          if (line.length > 0) {
            rejectFrames.push(
              JSON.parse(line) as { type?: string; code?: string },
            );
          }
        }
      },
      error() {},
    },
  });

  const frame = await retryUntil(() =>
    rejectFrames.find((f) => f.code === "max_connections"),
  );
  expect(frame).toBeDefined();
  expect(frame?.type).toBe("error");
  expect(frame?.code).toBe("max_connections");

  // Reject-new, NOT LRU-evict: the conn count never exceeded the cap, and the
  // first (oldest, live) client was never closed to make room.
  expect(server.conns.size).toBe(MAX_CONNECTIONS);

  overflow.end();
  for (const c of clients) {
    c.end();
  }
  server.stop();
  db.close();
});

test("diffTick fans out only to connections watching the changed id", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 1 });
  seedJob(db, "b", { last_event_id: 1 });
  const watcherA = fakeSock();
  watch(db, watcherA, { a: 1 });
  const watcherB = fakeSock();
  watch(db, watcherB, { b: 1 });

  // Only `a` advances.
  advanceJob(db, "a", 2);
  diffTick(db, [watcherA, watcherB]);

  expect(watcherA.frames).toHaveLength(1);
  expect(jobId((watcherA.frames[0] as PatchFrame).row)).toBe("a");
  expect(watcherB.frames).toHaveLength(0);
  db.close();
});

test("diffTick coalesces multiple folds between ticks into one patch", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 1 });
  const sock = fakeSock();
  watch(db, sock, { a: 1 });

  // Three folds land before the tick observes them; state-based diff collapses.
  advanceJob(db, "a", 2);
  advanceJob(db, "a", 3);
  advanceJob(db, "a", 4);
  diffTick(db, [sock]);

  expect(sock.frames).toHaveLength(1);
  expect((sock.frames[0] as PatchFrame).row.last_event_id).toBe(4);
  db.close();
});

test("diffTick skips a backpressured socket without stalling others; lastSent not advanced", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 1 });
  const slow = fakeSock();
  watch(db, slow, { a: 1 });
  const fast = fakeSock();
  watch(db, fast, { a: 1 });

  // Pre-stash a pending write on `slow` so diffTick sees it as backpressured.
  slow.data.pending = { bytes: new Uint8Array([1]), offset: 0 };

  advanceJob(db, "a", 2);
  diffTick(db, [slow, fast]);

  // Fast connection still got its patch.
  expect(fast.frames).toHaveLength(1);
  // Slow connection was skipped: no NEW patch frame appended by the diff, and
  // lastSent stayed at 1 so the next tick re-reflects current state.
  expect(slow.frames).toHaveLength(0);
  expect(slow.data.subs.get(null)?.lastSent.get("a")).toBe(1);
  db.close();
});

test("diffTick skips a connection with no active subscriptions", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 1 });

  // A conn with NO active subscription (empty subs map — e.g. never queried,
  // or after unsubscribe). diffTick builds zero triples from it and never emits.
  const idle = fakeSock();

  const active = fakeSock();
  watch(db, active, { a: 1 });

  advanceJob(db, "a", 2);
  diffTick(db, [idle, active]);

  // Active conn got its patch; idle (no subs) conn was never visited.
  expect(active.frames).toHaveLength(1);
  expect(idle.frames).toHaveLength(0);
  expect(idle.data.subs.size).toBe(0);
  db.close();
});

test("diffTick groups connections by collection (one selectByIds per group)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 1 });
  // Two conns on the same collection watching the same id → one shared re-read.
  const w1 = fakeSock();
  watch(db, w1, { a: 1 });
  const w2 = fakeSock();
  watch(db, w2, { a: 1 });

  advanceJob(db, "a", 2);
  diffTick(db, [w1, w2]);

  expect(w1.frames).toHaveLength(1);
  expect(w2.frames).toHaveLength(1);
  expect((w1.frames[0] as PatchFrame).collection).toBe("jobs");
  expect((w2.frames[0] as PatchFrame).collection).toBe("jobs");
  db.close();
});

test("diffTick property: K changes ⇒ K patches; only changed rows are fetched/decoded; unchanged rows skip selectByIds", async () => {
  // PROPERTY: after the two-pass rewrite, the second SELECT (`selectByIds`,
  // which is the only path that invokes `decodeRow`) is called with EXACTLY
  // the set of ids whose `version` advanced past `lastSent` — not with the
  // full union. So for N watched rows and K advances, `selectByIds` is
  // either called once with `[K-ids]` (K > 0) or not called at all (K = 0).
  //
  // Implementation: spy on the `selectByIds` import via `mock.module` so we
  // can count its invocations + assert the exact ids it was passed. The spy
  // is scoped to a child-spawn so it can't leak into other test cases.
  const childDb = join(tmpDir, "property.db");
  openDb(childDb).db.close();
  const script = `
    import { mock } from "bun:test";
    import { openDb } from ${JSON.stringify(join(import.meta.dir, "../src/db"))};
    import * as collections from ${JSON.stringify(join(import.meta.dir, "../src/collections"))};
    // Pre-import the real selectByIds so the spy can delegate to it.
    const _realSelectByIds = collections.selectByIds;
    let _selectByIdsCalls = [];
    await mock.module(${JSON.stringify(join(import.meta.dir, "../src/collections"))}, () => ({
      ...collections,
      selectByIds: (db, descriptor, ids) => {
        _selectByIdsCalls.push({ collection: descriptor.name, ids: [...ids] });
        return _realSelectByIds(db, descriptor, ids);
      },
    }));
    // Import server-worker AFTER the mock is installed so its top-level
    // \`import { selectByIds } from "./collections"\` resolves to the spy.
    const { diffTick } = await import(${JSON.stringify(join(import.meta.dir, "../src/server-worker"))});
    const { db } = openDb(${JSON.stringify(childDb)}, { readonly: false });

    // Seed N = 10 epics with non-trivial JSON-column content (so a decoded
    // row is visibly distinct from an undecoded one — \`tasks\` is an array,
    // not a string).
    const N = 10;
    for (let i = 0; i < N; i++) {
      const tasks = JSON.stringify([{ id: \`fn-\${i}.1\`, title: \`t\${i}\` }]);
      db.query(\`
        INSERT INTO epics (
          epic_id, epic_number, title, project_dir, status, last_event_id,
          updated_at, tasks, depends_on_epics, jobs, job_links, sort_path,
          created_by_closer_of
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', ?, NULL)
      \`).run(\`fn-\${i}\`, i, \`title-\${i}\`, "/repo", "open", i * 10, 1, tasks, String(i).padStart(6, "0"));
    }
    db.query("UPDATE reducer_state SET last_event_id = 999 WHERE id = 1").run();

    // Build a fake socket with watched + lastSent seeded from the live row
    // versions — so a fresh diffTick is a no-op until rows actually advance.
    const ids = [];
    const lastSent = new Map();
    for (let i = 0; i < N; i++) {
      const id = \`fn-\${i}\`;
      ids.push(id);
      lastSent.set(id, i * 10);
    }
    const sock = {
      data: {
        subs: new Map([[null, {
          collection: "epics",
          watched: new Set(ids),
          lastSent,
          where: { clause: "", params: [] },
          lastTotal: 0,
          lastToken: "",
          lastMetaEmittedAt: 0,
        }]]),
        pending: null,
        buffer: "",
        id: 0,
        frames: [],
      },
      write(buf, off, len) {
        const text = Buffer.from(buf.subarray(off ?? 0, (off ?? 0) + (len ?? buf.length - (off ?? 0)))).toString("utf8");
        for (const line of text.split("\\n")) {
          if (line.length > 0) this.data.frames.push(JSON.parse(line));
        }
        return len ?? buf.length - (off ?? 0);
      },
    };

    // Tick 1: no advances since baseline → no patch, no selectByIds call.
    _selectByIdsCalls = [];
    diffTick(db, [sock]);
    const tick1 = {
      patches: sock.data.frames.filter(f => f.type === "patch").length,
      calls: _selectByIdsCalls.map(c => ({ collection: c.collection, idCount: c.ids.length, ids: [...c.ids].sort() })),
    };

    // Tick 2: advance K = 3 rows; assert (a) K patches, (b) selectByIds called
    // ONCE with EXACTLY K ids, (c) patched rows have decoded JSON columns
    // (tasks is an array).
    const K = 3;
    const advancedIds = ["fn-2", "fn-5", "fn-8"];
    for (const id of advancedIds) {
      db.query("UPDATE epics SET last_event_id = last_event_id + 100 WHERE epic_id = ?").run(id);
    }
    sock.data.frames = [];
    _selectByIdsCalls = [];
    diffTick(db, [sock]);
    const tick2Patches = sock.data.frames.filter(f => f.type === "patch");
    const tick2 = {
      patchCount: tick2Patches.length,
      patchIds: tick2Patches.map(p => String(p.row.epic_id)).sort(),
      tasksAreArrays: tick2Patches.every(p => Array.isArray(p.row.tasks)),
      tasksFirstHasTitle: tick2Patches.every(p => p.row.tasks[0] && typeof p.row.tasks[0].title === "string"),
      calls: _selectByIdsCalls.map(c => ({ collection: c.collection, idCount: c.ids.length, ids: [...c.ids].sort() })),
    };

    console.log(JSON.stringify({ tick1, tick2, advancedIds: [...advancedIds].sort(), N, K }));
    db.close();
  `;
  const proc = Bun.spawn({
    cmd: ["bun", "--eval", script],
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (proc.exitCode !== 0) {
    throw new Error(
      `child failed (exit=${proc.exitCode})\nstdout: ${stdout}\nstderr: ${stderr}`,
    );
  }
  const result = JSON.parse(stdout.trim()) as {
    tick1: { patches: number; calls: { idCount: number }[] };
    tick2: {
      patchCount: number;
      patchIds: string[];
      tasksAreArrays: boolean;
      tasksFirstHasTitle: boolean;
      calls: { collection: string; idCount: number; ids: string[] }[];
    };
    advancedIds: string[];
    N: number;
    K: number;
  };

  // Tick 1: nothing changed since the seeded baseline → zero patches AND
  // `selectByIds` was NEVER called (the two-pass rewrite's whole point:
  // unchanged rows are not decoded).
  expect(result.tick1.patches).toBe(0);
  expect(result.tick1.calls.length).toBe(0);

  // Tick 2: exactly K = 3 patches; exactly K decoded rows; one selectByIds
  // call carrying ONLY the K changed ids (not N).
  expect(result.tick2.patchCount).toBe(result.K);
  expect(result.tick2.patchIds).toEqual(result.advancedIds);
  expect(result.tick2.tasksAreArrays).toBe(true);
  expect(result.tick2.tasksFirstHasTitle).toBe(true);
  expect(result.tick2.calls.length).toBe(1);
  expect(result.tick2.calls[0]?.collection).toBe("epics");
  expect(result.tick2.calls[0]?.idCount).toBe(result.K);
  expect(result.tick2.calls[0]?.ids).toEqual(result.advancedIds);
}, 15_000);

test("pollLoop drives a patch to a subscriber after a separate writer commits", async () => {
  // Reader connection runs the poll loop (autocommit, observes other conns'
  // commits). A separate writer connection commits a jobs change.
  const { db: reader } = openDb(dbPath, { readonly: true });
  const { db: writer } = openDb(dbPath, { readonly: false, migrate: false });

  seedJob(writer, "a", { last_event_id: 1 });
  setWorldRev(writer, 7);

  const sock = fakeSock();
  watch(writer, sock, { a: 1 });

  let stop = false;
  const loop = pollLoop(
    reader,
    () => [sock],
    () => stop,
    25,
  );

  // Writer commits an advance on the watched row (bumps data_version for the
  // reader's poll connection).
  advanceJob(writer, "a", 2);

  const got = await retryUntil(() =>
    sock.frames.length > 0 ? sock.frames[0] : null,
  );
  stop = true;
  await loop;

  expect(got).not.toBeNull();
  const patch = got as PatchFrame;
  expect(patch.type).toBe("patch");
  expect(patch.collection).toBe("jobs");
  expect(jobId(patch.row)).toBe("a");
  expect(patch.row.last_event_id).toBe(2);
  expect(patch.rev).toBe(7);

  reader.close();
  writer.close();
});

test("pollLoop emits no patch when the committed change misses every watched id", async () => {
  const { db: reader } = openDb(dbPath, { readonly: true });
  const { db: writer } = openDb(dbPath, { readonly: false, migrate: false });

  seedJob(writer, "a", { last_event_id: 1 });
  seedJob(writer, "unwatched", { last_event_id: 1 });

  const sock = fakeSock();
  watch(writer, sock, { a: 1 });

  let stop = false;
  const loop = pollLoop(
    reader,
    () => [sock],
    () => stop,
    25,
  );

  // Commit advances a job nobody watches → data_version bumps, but the diff
  // finds no watched-row change.
  advanceJob(writer, "unwatched", 5);

  // Give the loop several poll cycles to (not) emit.
  await Bun.sleep(200);
  stop = true;
  await loop;

  expect(sock.frames).toHaveLength(0);

  reader.close();
  writer.close();
});

// ---------------------------------------------------------------------------
// total + membership token (countAndToken)
// ---------------------------------------------------------------------------

/** Delete a job — simulates a row leaving the filtered set. */
function deleteJob(db: Database, job_id: string): void {
  db.query("DELETE FROM jobs WHERE job_id = ?").run(job_id);
}

/** First (and only) meta frame on a fake socket, or null. */
function firstMeta(sock: { frames: ServerFrame[] }): MetaFrame | null {
  const f = sock.frames.find((x) => x.type === "meta");
  return (f as MetaFrame | undefined) ?? null;
}

test("runQuery returns total = filtered-set size, independent of limit/offset", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  for (let i = 0; i < 5; i++) {
    seedJob(db, `j${i}`, { updated_at: i });
  }
  // limit/offset trim the page but NOT the total.
  const res = asResult(
    runQuery(db, 0, { type: "query", collection: "jobs", limit: 2, offset: 1 }),
  );
  expect(res.rows).toHaveLength(2);
  expect(res.total).toBe(5);
  db.close();
});

test("runQuery total reflects the filter (not the whole table)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "w1", { state: "working" });
  seedJob(db, "w2", { state: "working" });
  seedJob(db, "s1", { state: "stopped" });
  const res = asResult(
    runQuery(db, 0, {
      type: "query",
      collection: "jobs",
      filter: { state: "working" },
    }),
  );
  expect(res.total).toBe(2);
  db.close();
});

test("countAndToken: token is STABLE across a cell update of a matching row", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 1 });
  seedJob(db, "b", { last_event_id: 1 });
  const before = countAndToken(db, JOBS_DESCRIPTOR, "", []);
  // A pure cell update (last_event_id / updated_at) — membership is unchanged.
  advanceJob(db, "a", 9);
  const after = countAndToken(db, JOBS_DESCRIPTOR, "", []);
  expect(after.total).toBe(before.total);
  expect(after.token).toBe(before.token);
  db.close();
});

test("countAndToken: token CHANGES on a row entering the set", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a");
  const before = countAndToken(db, JOBS_DESCRIPTOR, "", []);
  seedJob(db, "b"); // enters
  const after = countAndToken(db, JOBS_DESCRIPTOR, "", []);
  expect(after.total).toBe(before.total + 1);
  expect(after.token).not.toBe(before.token);
  db.close();
});

test("countAndToken: token CHANGES on a row leaving the set", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a");
  seedJob(db, "b");
  const before = countAndToken(db, JOBS_DESCRIPTOR, "", []);
  deleteJob(db, "b"); // leaves
  const after = countAndToken(db, JOBS_DESCRIPTOR, "", []);
  expect(after.total).toBe(before.total - 1);
  expect(after.token).not.toBe(before.token);
  db.close();
});

test("countAndToken: balanced swap changes token but not total", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a");
  seedJob(db, "b");
  const before = countAndToken(db, JOBS_DESCRIPTOR, "", []);
  // One row leaves as another enters — count steady, membership different.
  deleteJob(db, "b");
  seedJob(db, "c");
  const after = countAndToken(db, JOBS_DESCRIPTOR, "", []);
  expect(after.total).toBe(before.total);
  expect(after.token).not.toBe(before.token);
  db.close();
});

test("countAndToken: empty set normalizes to total=0 / token=''", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  // No jobs match the filter.
  const where = resolveFilter(JOBS_DESCRIPTOR, { state: "nonesuch" });
  const res = countAndToken(db, JOBS_DESCRIPTOR, where.clause, where.params);
  expect(res.total).toBe(0);
  expect(res.token).toBe("");
  db.close();
});

test("countAndToken: token is order-stable regardless of insertion order", () => {
  // Same identity set inserted in different orders → same token (ORDER BY pk).
  const { db: db1 } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db1, "c");
  seedJob(db1, "a");
  seedJob(db1, "b");
  const t1 = countAndToken(db1, JOBS_DESCRIPTOR, "", []).token;
  db1.close();
  // Fresh DB, reversed insertion order.
  rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-server-test-"));
  dbPath = join(tmpDir, "keeper.db");
  freshDbFile(dbPath).db.close();
  const { db: db2 } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db2, "b");
  seedJob(db2, "a");
  seedJob(db2, "c");
  const t2 = countAndToken(db2, JOBS_DESCRIPTOR, "", []).token;
  db2.close();
  expect(t1).toBe(t2);
});

// ---------------------------------------------------------------------------
// diffTick → meta (membership staleness)
// ---------------------------------------------------------------------------

test("diffTick emits a meta when total grows (a row enters the set)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 1 });
  setWorldRev(db, 5);
  const sock = fakeSock();
  watch(db, sock, { a: 1 }); // baseline total=1, token over {a}

  seedJob(db, "b", { last_event_id: 1 }); // enters the unfiltered set
  diffTick(db, [sock]);

  const meta = firstMeta(sock);
  expect(meta).not.toBeNull();
  expect(meta?.collection).toBe("jobs");
  expect(meta?.total).toBe(2);
  expect(meta?.rev).toBe(5);
  // Baseline advanced — a second no-change tick is silent.
  expect(sock.data.subs.get(null)?.lastTotal).toBe(2);
  diffTick(db, [sock]);
  expect(sock.frames.filter((f) => f.type === "meta")).toHaveLength(1);
  db.close();
});

test("diffTick emits a meta on a balanced swap (token-only change, total steady)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 1 });
  seedJob(db, "b", { last_event_id: 1 });
  const sock = fakeSock();
  watch(db, sock, { a: 1 }); // baseline total=2

  // One leaves, one enters — total stays 2, membership differs.
  deleteJob(db, "b");
  seedJob(db, "c", { last_event_id: 1 });
  diffTick(db, [sock]);

  const meta = firstMeta(sock);
  expect(meta).not.toBeNull();
  expect(meta?.total).toBe(2);
  db.close();
});

test("diffTick emits NO meta on a pure cell update (only a patch)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 1 });
  const sock = fakeSock();
  watch(db, sock, { a: 1 });

  advanceJob(db, "a", 2); // cell update of a matching row
  diffTick(db, [sock]);

  expect(sock.frames.filter((f) => f.type === "patch")).toHaveLength(1);
  expect(sock.frames.filter((f) => f.type === "meta")).toHaveLength(0);
  db.close();
});

test("diffTick emits no meta when nothing about membership changed", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 1 });
  seedJob(db, "other", { last_event_id: 1 });
  const sock = fakeSock();
  watch(db, sock, { a: 1 }); // unfiltered baseline total=2

  // An unrelated cell update — membership of the unfiltered set is unchanged.
  advanceJob(db, "other", 9);
  diffTick(db, [sock]);

  expect(sock.frames.filter((f) => f.type === "meta")).toHaveLength(0);
  db.close();
});

test("diffTick shares one count across two conns on the same filter; both advance", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "w1", { state: "working" });
  const w1 = fakeSock();
  watch(db, w1, { w1: 1 }, { state: "working" });
  const w2 = fakeSock();
  watch(db, w2, { w1: 1 }, { state: "working" });

  // A new working job enters the shared filter.
  seedJob(db, "w2", { state: "working" });
  diffTick(db, [w1, w2]);

  expect(firstMeta(w1)?.total).toBe(2);
  expect(firstMeta(w2)?.total).toBe(2);
  expect(w1.data.subs.get(null)?.lastTotal).toBe(2);
  expect(w2.data.subs.get(null)?.lastTotal).toBe(2);
  db.close();
});

test("diffTick distinguishes filters: a working-only conn ignores a stopped enter", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "w1", { state: "working" });
  const working = fakeSock();
  watch(db, working, { w1: 1 }, { state: "working" });

  // A STOPPED job enters — it does not match the working filter.
  seedJob(db, "s1", { state: "stopped" });
  diffTick(db, [working]);

  expect(working.frames.filter((f) => f.type === "meta")).toHaveLength(0);
  db.close();
});

test("diffTick backpressure: a pending conn gets no meta and does NOT advance; next tick delivers", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 1 });
  const sock = fakeSock();
  watch(db, sock, { a: 1 }); // baseline total=1

  // Backpressured: a pending write is stashed.
  sock.data.pending = { bytes: new Uint8Array([1]), offset: 0 };

  seedJob(db, "b", { last_event_id: 1 }); // membership grows to 2
  diffTick(db, [sock]);

  // Skipped: no meta, baseline NOT advanced.
  expect(sock.frames.filter((f) => f.type === "meta")).toHaveLength(0);
  expect(sock.data.subs.get(null)?.lastTotal).toBe(1);

  // Unblock and re-tick: the signal is re-derived from current state.
  sock.data.pending = null;
  diffTick(db, [sock]);
  expect(firstMeta(sock)?.total).toBe(2);
  expect(sock.data.subs.get(null)?.lastTotal).toBe(2);
  db.close();
});

// ---------------------------------------------------------------------------
// fn-697 lever 1: per-SubState meta-emission throttle (META_MIN_INTERVAL_MS).
// The throttle clock is `sub.lastMetaEmittedAt`; tests drive it deterministically
// by stamping that field rather than faking wall-clock — `Date.now()` in the
// meta pass then reads a real "recently emitted" / "interval elapsed" state.
// ---------------------------------------------------------------------------

/**
 * Grab the anonymous sub off a fakeSock as a DEFINITE `SubState` (throwing if
 * absent) — the throttle tests mutate `lastMetaEmittedAt` and assert on
 * `lastTotal`, so they need a concrete reference, not the `| undefined` that
 * `anonSub` returns. Throwing keeps it biome-clean (no `!`).
 */
function requireAnonSub(sock: Writable): SubState {
  const sub = anonSub(sock.data);
  if (!sub) {
    throw new Error("requireAnonSub: no anonymous sub on socket");
  }
  return sub;
}

test("meta throttle: rapid total moves within the interval emit exactly ONE meta", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 1 });
  setWorldRev(db, 5);
  const sock = fakeSock();
  watch(db, sock, { a: 1 }); // baseline total=1, lastMetaEmittedAt=0

  // First move emits (fresh sub, clock=0) and stamps lastMetaEmittedAt≈now.
  seedJob(db, "b", { last_event_id: 1 }); // total → 2
  diffTick(db, [sock]);
  expect(sock.frames.filter((f) => f.type === "meta")).toHaveLength(1);
  const after1 = requireAnonSub(sock);
  expect(after1.lastTotal).toBe(2);
  expect(after1.lastMetaEmittedAt).toBeGreaterThan(0);
  const tokenAfterEmit1 = after1.lastToken; // frozen-baseline reference

  // Two further moves WITHIN the interval (the just-stamped clock is recent):
  // both are throttled away, and the baseline must NOT advance.
  seedJob(db, "c", { last_event_id: 1 }); // total → 3
  diffTick(db, [sock]);
  seedJob(db, "d", { last_event_id: 1 }); // total → 4
  diffTick(db, [sock]);

  expect(sock.frames.filter((f) => f.type === "meta")).toHaveLength(1);
  // CONVERGENCE INVARIANT: baseline + clock frozen on a throttled-away move.
  expect(after1.lastTotal).toBe(2);
  expect(after1.lastToken).toBe(tokenAfterEmit1); // unchanged from emit-1
  db.close();
});

test("meta throttle: a move after the interval emits the LATEST state (no lost-final-update)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 1 });
  setWorldRev(db, 5);
  const sock = fakeSock();
  watch(db, sock, { a: 1 }); // baseline total=1

  // First move emits.
  seedJob(db, "b", { last_event_id: 1 }); // total → 2
  diffTick(db, [sock]);
  const sub = requireAnonSub(sock);
  expect(sub.lastTotal).toBe(2);

  // Two moves WITHIN the interval get throttled (baseline frozen at 2).
  seedJob(db, "c", { last_event_id: 1 }); // total → 3
  diffTick(db, [sock]);
  seedJob(db, "d", { last_event_id: 1 }); // total → 4
  diffTick(db, [sock]);
  expect(sock.frames.filter((f) => f.type === "meta")).toHaveLength(1);
  expect(sub.lastTotal).toBe(2);

  // Interval elapses (simulate by pushing the emit clock into the past). The
  // next tick re-detects the still-pending delta and emits the LATEST total
  // (4), not the stale 3 — the membership delta persisted across throttles.
  sub.lastMetaEmittedAt = Date.now() - META_MIN_INTERVAL_MS - 1;
  diffTick(db, [sock]);

  const metas = sock.frames.filter((f) => f.type === "meta") as MetaFrame[];
  expect(metas).toHaveLength(2);
  expect(metas[metas.length - 1].total).toBe(4); // final state converged
  expect(sub.lastTotal).toBe(4);
  db.close();
});

test("meta throttle: pollLoop convergence tick flushes a throttled-away delta", async () => {
  // Two connections (mirrors the real worker + the existing pollLoop tests):
  // `reader` runs the poll loop in autocommit so it observes the `writer`'s
  // commits via PRAGMA data_version. `diffTick` runs against `reader`.
  const { db: reader } = openDb(dbPath, { readonly: true });
  const { db: writer } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(writer, "a", { last_event_id: 1 });
  const sock = fakeSock();
  watch(writer, sock, { a: 1 });

  // Force the sub into a "recently emitted, delta pending" state: a membership
  // move with the emit clock stamped to now, so the meta pass throttles it.
  const sub = requireAnonSub(sock);
  sub.lastMetaEmittedAt = Date.now();
  seedJob(writer, "b", { last_event_id: 1 }); // total → 2, but throttled
  diffTick(reader, [sock]);
  expect(sock.frames.filter((f) => f.type === "meta")).toHaveLength(0);
  expect(sub.lastTotal).toBe(1); // frozen — delta persists

  // The pollLoop is the convergence safety tick: once the interval elapses, its
  // next data_version-gated diffTick emits the deferred latest state. Simulate
  // the elapsed window, then drive a fresh cross-connection commit so the
  // loop's gated diffTick fires.
  sub.lastMetaEmittedAt = Date.now() - META_MIN_INTERVAL_MS - 1;
  let shutdown = false;
  const loop = pollLoop(
    reader,
    () => [sock],
    () => shutdown,
    25,
  );
  advanceJob(writer, "a", 9); // bumps data_version for the reader's poll conn
  const flushed = await retryUntil(() =>
    sock.frames.some((f) => f.type === "meta") ? true : null,
  );
  shutdown = true;
  await loop;
  expect(flushed).toBe(true);
  expect(firstMeta(sock)?.total).toBe(2); // latest membership converged
  expect(sub.lastTotal).toBe(2);
  reader.close();
  writer.close();
}, 5_000);

test("meta throttle never delays the patch pass: cell updates emit immediately under throttle", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 1 });
  setWorldRev(db, 5);
  const sock = fakeSock();
  watch(db, sock, { a: 1 });

  // Put the sub in a throttled state (recent emit clock) AND advance a watched
  // cell. The meta pass is gated, but the patch pass must NOT be — the cell
  // patch is the correctness-critical stream and is never throttled.
  const sub = requireAnonSub(sock);
  sub.lastMetaEmittedAt = Date.now();
  // Also create a membership move so the meta pass has something to throttle.
  seedJob(db, "b", { last_event_id: 1 }); // total → 2 (would-be meta, throttled)
  advanceJob(db, "a", 2); // watched cell advance → patch
  diffTick(db, [sock]);

  const patches = sock.frames.filter((f) => f.type === "patch");
  const metas = sock.frames.filter((f) => f.type === "meta");
  expect(patches).toHaveLength(1); // patch delivered immediately
  expect(metas).toHaveLength(0); // meta throttled away
  expect(sub.lastTotal).toBe(1); // baseline frozen on the throttled move
  db.close();
});

test("meta throttle is per-SubState: handleKick and pollLoop share one window", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { last_event_id: 1 });
  const sock = fakeSock();
  watch(db, sock, { a: 1 });

  // First move via a kick emits and stamps the per-sub clock.
  seedJob(db, "b", { last_event_id: 1 }); // total → 2
  handleKick(db, [sock]);
  expect(sock.frames.filter((f) => f.type === "meta")).toHaveLength(1);
  const sub = requireAnonSub(sock);
  const stampedAt = sub.lastMetaEmittedAt;
  expect(stampedAt).toBeGreaterThan(0);

  // A SECOND move arrives via a poll-driven diffTick within the interval: it
  // sees the SAME per-sub clock the kick stamped (the window is not split per
  // wake path), so it throttles — proving the state lives on SubState.
  seedJob(db, "c", { last_event_id: 1 }); // total → 3
  diffTick(db, [sock]); // pollLoop's call shape
  expect(sock.frames.filter((f) => f.type === "meta")).toHaveLength(1);
  expect(sub.lastTotal).toBe(2); // frozen — kick's window still in force
  expect(sub.lastMetaEmittedAt).toBe(stampedAt); // same clock, untouched
  db.close();
});

// ---------------------------------------------------------------------------
// KEEPER_TRACE_SERVER gate (subprocess: module-level `const TRACE` reads
// `process.env` exactly once at import, so each test spawns a fresh Bun
// subprocess that boots a server-worker with the env var set/unset, opens a
// UDS connection (which exercises the `open` srvTs call site), then exits.
// stderr is captured and asserted on.)
// ---------------------------------------------------------------------------

async function runTraceGateChild(env: Record<string, string>): Promise<string> {
  const childDb = join(tmpDir, "trace.db");
  const childSock = join(tmpDir, "trace.sock");
  const childLock = join(tmpDir, "trace.lock");
  openDb(childDb).db.close();
  const script = `
    import { openDb } from ${JSON.stringify(join(import.meta.dir, "../src/db"))};
    import { startServer } from ${JSON.stringify(join(import.meta.dir, "../src/server-worker"))};
    const { db } = openDb(${JSON.stringify(childDb)}, { readonly: true });
    const server = startServer(db, ${JSON.stringify(childSock)}, ${JSON.stringify(childLock)});
    const sock = await Bun.connect({ unix: ${JSON.stringify(childSock)}, socket: { data() {}, error() {} } });
    // Give the server's open() handler a tick to run.
    await Bun.sleep(50);
    sock.end();
    await Bun.sleep(50);
    server.stop();
    db.close();
  `;
  const proc = Bun.spawn({
    cmd: ["bun", "--eval", script],
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return stderr;
}

test("KEEPER_TRACE_SERVER unset: no [srv-ts] lines on stderr", async () => {
  const stderr = await runTraceGateChild({ KEEPER_TRACE_SERVER: "" });
  expect(stderr.includes("[srv-ts]")).toBe(false);
}, 10_000);

test("KEEPER_TRACE_SERVER=1: [srv-ts] conn open line appears on stderr", async () => {
  const stderr = await runTraceGateChild({ KEEPER_TRACE_SERVER: "1" });
  expect(stderr.includes("[srv-ts]")).toBe(true);
  expect(/\[srv-ts\] T=\d+ conn \d+ open/.test(stderr)).toBe(true);
}, 10_000);

test("all srvTs( call sites are gated by if (TRACE) (source-level lint)", () => {
  const src = readFileSync(
    join(import.meta.dir, "../src/server-worker.ts"),
    "utf8",
  );
  const lines = src.split("\n");
  // Find every srvTs( occurrence outside the function definition itself and
  // verify it's reached only via an `if (TRACE)` gate — three accepted shapes:
  //   (a) same-line bare prefix:           `if (TRACE) srvTs(...)`
  //   (b) bare prefix on previous line:    `if (TRACE)\n  srvTs(...)`
  //   (c) compound prefix on previous line: `if (TRACE && <pred>)\n  srvTs(...)`
  // Form (c) is the stage-timing threshold pattern (e.g. `if (TRACE &&
  // buf.length >= TRACE_FRAME_BYTES)`), which short-circuits on the env gate
  // first so a TRACE=0 daemon never evaluates the predicate. The grep over
  // the file is documented in the task spec as the regression check; this
  // test bakes it in.
  const compoundPrev = /\bif\s*\(\s*TRACE\s*&&[^)]*\)\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("srvTs(")) continue;
    // Skip the function definition line itself.
    if (line.includes("function srvTs(")) continue;
    const sameLine = line.includes("if (TRACE)");
    const prev = i > 0 ? lines[i - 1] : "";
    const prevTrimmed = prev.trimEnd();
    const prevBare = prevTrimmed.endsWith("if (TRACE)");
    const prevCompound = compoundPrev.test(prevTrimmed);
    expect(sameLine || prevBare || prevCompound).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// Staged timing instrumentation (runQuery / diffTick / writeFrames)
//
// Same subprocess strategy as the TRACE-gate tests above: the module-level
// `TRACE` and `TRACE_FRAME_BYTES` consts read env exactly once at import, so
// each test spawns a fresh Bun child with the env set, exercises the target
// function against a real bun:sqlite DB, and asserts on the captured stderr.
// ---------------------------------------------------------------------------

/**
 * Spawn a Bun child that imports the server-worker, runs the inlined
 * `body` script against a fresh in-memory DB, and returns the captured
 * stderr. The body's lexical environment includes `db` (a writable, just
 * -bootstrapped Database) plus the server-worker exports it imports
 * itself.
 */
async function runStageChild(
  env: Record<string, string>,
  body: string,
): Promise<string> {
  const childDb = join(tmpDir, "stage.db");
  openDb(childDb).db.close();
  const script = `
    import { openDb } from ${JSON.stringify(join(import.meta.dir, "../src/db"))};
    import { runQuery, diffTick, writeFrames, resolveFilter } from ${JSON.stringify(join(import.meta.dir, "../src/server-worker"))};
    import { JOBS_DESCRIPTOR, countAndToken } from ${JSON.stringify(join(import.meta.dir, "../src/collections"))};
    const { db } = openDb(${JSON.stringify(childDb)}, { readonly: false });
    ${body}
    db.close();
  `;
  const proc = Bun.spawn({
    cmd: ["bun", "--eval", script],
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return stderr;
}

test("runQuery: TRACE=1 emits one op=runQuery line per call with all stages", async () => {
  const stderr = await runStageChild(
    { KEEPER_TRACE_SERVER: "1" },
    `
      db.query("INSERT INTO jobs (job_id, created_at, state, last_event_id, updated_at) VALUES ('a', 1, 'working', 0, 1)").run();
      runQuery(db, 0, { type: "query", collection: "jobs" });
      runQuery(db, 0, { type: "query", collection: "jobs" });
    `,
  );
  const lines = stderr.split("\n").filter((l) => l.includes("op=runQuery"));
  expect(lines.length).toBe(2);
  for (const line of lines) {
    expect(line).toMatch(
      /\[srv-ts\] T=\d+ op=runQuery col=jobs rows=\d+ countAndToken=\d+\.\d{2} pageSelect=\d+\.\d{2} decodeRow=\d+\.\d{2} frameEncode=\d+\.\d{2} total=\d+\.\d{2}/,
    );
  }
}, 10_000);

test("runQuery: TRACE unset emits zero op=runQuery lines", async () => {
  const stderr = await runStageChild(
    { KEEPER_TRACE_SERVER: "" },
    `
      runQuery(db, 0, { type: "query", collection: "jobs" });
      runQuery(db, 0, { type: "query", collection: "jobs" });
    `,
  );
  expect(stderr.includes("op=runQuery")).toBe(false);
  expect(stderr.includes("[srv-ts]")).toBe(false);
});

test("diffTick: TRACE=1 emits op=diffTick line for a slow tick (>10ms total)", async () => {
  const stderr = await runStageChild(
    { KEEPER_TRACE_SERVER: "1" },
    `
      // Deterministic threshold crossing via a mocked performance.now() that
      // returns a monotonically increasing virtual clock advanced by +20ms on
      // every call. diffTick's staged-timing instrumentation pulls the clock
      // 7+ times per tick (start, afterRev, g0/g1/g2/g3/g4 per group,
      // afterPatch, end — the probeVersions stage adds one timestamp on top
      // of the pre-rewrite count), so each stage delta lands at +20ms — well
      // above the per-stage 5ms gate and the total 10ms gate. No wall-clock
      // spin, no CI-speed hope: the slow-tick line is guaranteed to emit when
      // (and only when) the threshold gate is wired correctly.
      const _realNow = performance.now.bind(performance);
      let _virtualMs = _realNow();
      performance.now = () => {
        _virtualMs += 20;
        return _virtualMs;
      };
      // Seed one row + one connection that watches it. Volume doesn't matter
      // anymore — the mocked clock supplies the slowness.
      db.query("INSERT INTO jobs (job_id, created_at, state, last_event_id, updated_at) VALUES ('j0', 0, 'working', 0, 0)").run();
      const watched = new Set(["j0"]);
      const where = resolveFilter(JOBS_DESCRIPTOR, {});
      const { total, token } = countAndToken(db, JOBS_DESCRIPTOR, where.clause, where.params);
      const sock = {
        data: {
          subs: new Map([[null, {
            collection: "jobs",
            watched,
            lastSent: new Map(),
            where,
            lastTotal: total,
            lastToken: token,
            lastMetaEmittedAt: 0,
          }]]),
          pending: null,
          buffer: "",
          id: 0,
        },
        write(buf, off, len) { return (len ?? buf.length - (off ?? 0)); },
      };
      diffTick(db, [sock]);
      performance.now = _realNow;
    `,
  );
  // With the mocked clock supplying +20ms per performance.now() call, the
  // threshold gate MUST fire. Assert lines.length > 0 unconditionally, and
  // assert the locked shape on every emitted line.
  const lines = stderr.split("\n").filter((l) => l.includes("op=diffTick"));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line).toMatch(
      /\[srv-ts\] T=\d+ op=diffTick col=\* readWorldRev=\d+\.\d{2} unionWatched=\d+\.\d{2} probeVersions=\d+\.\d{2} selectByIds=\d+\.\d{2} patchFanout=\d+\.\d{2} metaCount=\d+\.\d{2} total=\d+\.\d{2}/,
    );
  }
}, 15_000);

test("diffTick: TRACE=1 fast tick (no work) emits zero op=diffTick lines (threshold gate)", async () => {
  const stderr = await runStageChild(
    { KEEPER_TRACE_SERVER: "1" },
    `
      // Empty connection list → diffTick early-returns BEFORE the stage timer
      // start. The gate isn't even reached. Verify: zero diffTick emissions.
      for (let i = 0; i < 10; i++) diffTick(db, []);
    `,
  );
  expect(stderr.includes("op=diffTick")).toBe(false);
});

test("diffTick: TRACE unset emits zero op=diffTick lines", async () => {
  const stderr = await runStageChild(
    { KEEPER_TRACE_SERVER: "" },
    `
      for (let i = 0; i < 5; i++) diffTick(db, []);
    `,
  );
  expect(stderr.includes("op=diffTick")).toBe(false);
});

test("writeFrames: TRACE=1 + small frame emits no op=writeFrames line", async () => {
  const stderr = await runStageChild(
    { KEEPER_TRACE_SERVER: "1" },
    `
      const sock = {
        data: {
          buffer: { push: () => [], pendingLength: () => 0 },
          collection: "jobs", watched: new Set(), lastSent: new Map(),
          where: null, lastTotal: null, lastToken: null, pending: null,
        },
        write(buf, off, len) { return (len ?? buf.length - (off ?? 0)); },
      };
      // A tiny error frame is well under 4096 bytes.
      writeFrames(sock, [{ type: "error", rev: 0, code: "x", message: "small" }]);
    `,
  );
  expect(stderr.includes("op=writeFrames")).toBe(false);
});

test("writeFrames: TRACE=1 + large frame (>=4096 bytes) emits one op=writeFrames line", async () => {
  const stderr = await runStageChild(
    { KEEPER_TRACE_SERVER: "1" },
    `
      const sock = {
        data: {
          buffer: { push: () => [], pendingLength: () => 0 },
          collection: "jobs", watched: new Set(), lastSent: new Map(),
          where: null, lastTotal: null, lastToken: null, pending: null,
        },
        write(buf, off, len) { return (len ?? buf.length - (off ?? 0)); },
      };
      // Build a result frame with a fat string payload to push past 4096 bytes
      // when encoded as NDJSON.
      const fat = "x".repeat(5000);
      writeFrames(sock, [{ type: "result", collection: "jobs", rev: 0, total: 1, rows: [{ job_id: "a", note: fat }] }]);
    `,
  );
  const lines = stderr.split("\n").filter((l) => l.includes("op=writeFrames"));
  expect(lines.length).toBe(1);
  expect(lines[0]).toMatch(
    /\[srv-ts\] T=\d+ op=writeFrames col=jobs bytes=\d+ frames=1/,
  );
}, 10_000);

test("writeFrames: TRACE unset emits zero op=writeFrames lines even for large frames", async () => {
  const stderr = await runStageChild(
    { KEEPER_TRACE_SERVER: "" },
    `
      const sock = {
        data: {
          buffer: { push: () => [], pendingLength: () => 0 },
          collection: "jobs", watched: new Set(), lastSent: new Map(),
          where: null, lastTotal: null, lastToken: null, pending: null,
        },
        write(buf, off, len) { return (len ?? buf.length - (off ?? 0)); },
      };
      const fat = "x".repeat(5000);
      writeFrames(sock, [{ type: "result", collection: "jobs", rev: 0, total: 1, rows: [{ job_id: "a", note: fat }] }]);
    `,
  );
  expect(stderr.includes("op=writeFrames")).toBe(false);
});

test("KEEPER_TRACE_FRAME_BYTES: lower threshold emits writeFrames lines for smaller frames", async () => {
  const stderr = await runStageChild(
    { KEEPER_TRACE_SERVER: "1", KEEPER_TRACE_FRAME_BYTES: "100" },
    `
      const sock = {
        data: {
          buffer: { push: () => [], pendingLength: () => 0 },
          collection: "jobs", watched: new Set(), lastSent: new Map(),
          where: null, lastTotal: null, lastToken: null, pending: null,
        },
        write(buf, off, len) { return (len ?? buf.length - (off ?? 0)); },
      };
      // A modest error frame easily clears 100 bytes when JSON-encoded.
      writeFrames(sock, [{ type: "error", rev: 0, code: "demo", message: "a-message-long-enough-to-clear-100-bytes-once-encoded-as-NDJSON" }]);
    `,
  );
  const lines = stderr.split("\n").filter((l) => l.includes("op=writeFrames"));
  expect(lines.length).toBe(1);
  expect(lines[0]).toMatch(/bytes=\d+ frames=1/);
});

// ---------------------------------------------------------------------------
// fn-698 — per-worldRev result memo + pre-serialized fan-out
// ---------------------------------------------------------------------------

/** Seed one epic with non-trivial JSON-column content (`tasks`, `epic_links`-
 *  via `job_links`). The jsonColumn round-trip is the riskiest byte-fidelity
 *  case — a `tasks` array decoded then re-serialized must match `encodeFrame`. */
function seedEpic(
  db: Database,
  epic_id: string,
  opts: Partial<{
    epic_number: number;
    last_event_id: number;
    tasks: unknown[];
    job_links: unknown[];
    status: string;
    sort_path: string;
  }> = {},
): void {
  db.query(
    `INSERT INTO epics (
       epic_id, epic_number, title, project_dir, status, last_event_id,
       updated_at, tasks, depends_on_epics, jobs, job_links, sort_path,
       created_by_closer_of
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, NULL)`,
  ).run(
    epic_id,
    opts.epic_number ?? 1,
    `title-${epic_id}`,
    "/repo",
    opts.status ?? "open",
    opts.last_event_id ?? 0,
    1,
    JSON.stringify(opts.tasks ?? []),
    JSON.stringify(opts.job_links ?? []),
    opts.sort_path ?? "000001",
  );
}

/** Narrow + unwrap the single pre-serialized line a memo serve returns. */
function asLine(frames: (ServerFrame | PreSerialized)[]): string {
  expect(frames.length).toBe(1);
  const f = frames[0] as PreSerialized;
  if (typeof f.__line !== "string") {
    throw new Error(`expected pre-serialized __line, got ${JSON.stringify(f)}`);
  }
  return f.__line;
}

test("fn-698 byte-fidelity: epics (jsonColumns) line === encodeFrame(runQuery) — id present", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedEpic(db, "fn-1", {
    last_event_id: 10,
    tasks: [{ id: "fn-1.1", title: "t1", jobs: [{ job_id: "j1" }] }],
    job_links: [{ from: "fn-1", to: "fn-2", kind: "refiner" }],
  });
  setWorldRev(db, 42);

  const frame = { type: "query" as const, collection: "epics", id: "sub-A" };
  const reference = encodeFrame(asResult(runQuery(db, 42, frame)));

  const conn = newConn();
  const memo = newResultMemo();
  const line = asLine(
    dispatchLine(db, conn, JSON.stringify(frame), db, undefined, memo),
  );
  expect(line).toBe(reference);
  db.close();
});

test("fn-698 byte-fidelity: epics line === encodeFrame(runQuery) — id absent", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedEpic(db, "fn-1", {
    last_event_id: 10,
    tasks: [{ id: "fn-1.1", title: "t1" }],
  });
  setWorldRev(db, 7);

  const frame = { type: "query" as const, collection: "epics" };
  const reference = encodeFrame(asResult(runQuery(db, 7, frame)));

  const conn = newConn();
  const memo = newResultMemo();
  const line = asLine(
    dispatchLine(db, conn, JSON.stringify(frame), db, undefined, memo),
  );
  expect(line).toBe(reference);
  // No envelope `id` segment when the frame carried none: the line opens
  // straight into `"collection":` after `"type":"result"` (a row's own nested
  // `"id":` lives later inside `rows`, so we anchor on the envelope prefix).
  expect(line.startsWith('{"type":"result","collection":')).toBe(true);
  db.close();
});

test("fn-698 byte-fidelity: jobs (plain collection) line === encodeFrame(runQuery)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedJob(db, "a", { created_at: 30, last_event_id: 3 });
  seedJob(db, "b", { created_at: 10, last_event_id: 1 });
  setWorldRev(db, 99);

  const frame = { type: "query" as const, collection: "jobs", id: "jq" };
  const reference = encodeFrame(asResult(runQuery(db, 99, frame)));

  const conn = newConn();
  const memo = newResultMemo();
  const line = asLine(
    dispatchLine(db, conn, JSON.stringify(frame), db, undefined, memo),
  );
  expect(line).toBe(reference);
  db.close();
});

test("fn-698 byte-fidelity: empty rows line === encodeFrame(runQuery)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  // No epics seeded → empty filtered set.
  setWorldRev(db, 5);

  const frame = { type: "query" as const, collection: "epics", id: "empty" };
  const reference = encodeFrame(asResult(runQuery(db, 5, frame)));
  expect(JSON.parse(reference.trim()).rows).toEqual([]);

  const conn = newConn();
  const memo = newResultMemo();
  const line = asLine(
    dispatchLine(db, conn, JSON.stringify(frame), db, undefined, memo),
  );
  expect(line).toBe(reference);
  db.close();
});

test("fn-698 single-flight: N identical-signature queries → ONE runQuery + ONE stringify", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  for (let i = 0; i < 5; i++) {
    seedEpic(db, `fn-${i}`, {
      epic_number: i,
      last_event_id: i,
      sort_path: String(i).padStart(6, "0"),
      tasks: [{ id: `fn-${i}.1`, title: `t${i}` }],
    });
  }
  setWorldRev(db, 100);

  // Spy on Database.prepare to count the page SELECTs runQuery issues. The
  // page SELECT carries `LIMIT ? OFFSET ?` — distinctive vs countAndToken.
  const proto = Object.getPrototypeOf(db) as { prepare: Database["prepare"] };
  const realPrepare = proto.prepare;
  let pageSelects = 0;
  proto.prepare = function (this: Database, sql: string, ...rest: unknown[]) {
    if (/FROM epics/.test(sql) && /LIMIT \? OFFSET \?/.test(sql)) pageSelects++;
    // @ts-expect-error variadic passthrough to the real prepare
    return realPrepare.call(this, sql, ...rest);
  } as Database["prepare"];

  // Reference once (un-memoized) BEFORE installing the memo, then reset the
  // counter so we count only the memo path's SELECTs.
  const frame = (id: string) => ({
    type: "query" as const,
    collection: "epics",
    id,
  });
  const reference = encodeFrame(
    asResult(
      runQuery(db, 100, { type: "query", collection: "epics", id: "ref" }),
    ),
  ).replace('"id":"ref"', '"id":"PLACEHOLDER"');
  pageSelects = 0;

  try {
    const memo = newResultMemo();
    const lines: string[] = [];
    for (let i = 0; i < 21; i++) {
      const conn = newConn();
      const f = frame(`conn-${i}`);
      lines.push(
        asLine(dispatchLine(db, conn, JSON.stringify(f), db, undefined, memo)),
      );
    }
    // Exactly ONE page SELECT across all 21 identical-signature queries.
    expect(pageSelects).toBe(1);
    // Each conn's bytes match the reference (modulo its own id segment).
    for (let i = 0; i < 21; i++) {
      expect(lines[i].replace(`"id":"conn-${i}"`, '"id":"PLACEHOLDER"')).toBe(
        reference,
      );
    }
    // One cached entry — 21 identical = ONE signature.
    expect(memo.entries.size).toBe(1);
  } finally {
    proto.prepare = realPrepare;
  }
  db.close();
});

test("fn-698 distinct signatures cache separately; the rows blob is shared per entry", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedEpic(db, "fn-0", {
    epic_number: 0,
    last_event_id: 0,
    sort_path: "000000",
  });
  seedEpic(db, "fn-1", {
    epic_number: 1,
    last_event_id: 1,
    sort_path: "000001",
  });
  setWorldRev(db, 3);

  const memo = newResultMemo();
  // Two DIFFERENT signatures (limit differs) → two entries.
  dispatchLine(
    db,
    newConn(),
    JSON.stringify({ type: "query", collection: "epics", limit: 1 }),
    db,
    undefined,
    memo,
  );
  dispatchLine(
    db,
    newConn(),
    JSON.stringify({ type: "query", collection: "epics", limit: 2 }),
    db,
    undefined,
    memo,
  );
  expect(memo.entries.size).toBe(2);
  db.close();
});

test("fn-698 worldRev advance replaces the cache; new line carries the new rev", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedEpic(db, "fn-1", { last_event_id: 1, tasks: [{ id: "fn-1.1" }] });
  setWorldRev(db, 10);

  const memo = newResultMemo();
  const frame = { type: "query" as const, collection: "epics", id: "s" };
  const line10 = asLine(
    dispatchLine(db, newConn(), JSON.stringify(frame), db, undefined, memo),
  );
  expect(memo.worldRev).toBe(10);
  expect(JSON.parse(line10.trim()).rev).toBe(10);
  const entryCountAt10 = memo.entries.size;
  expect(entryCountAt10).toBe(1);

  // Advance the world rev + a row → the cache must be replaced (clean reset)
  // and the fresh serialize stamped rev 11 with the updated rows.
  setWorldRev(db, 11);
  db.query(
    "UPDATE epics SET last_event_id = 5, tasks = ? WHERE epic_id = ?",
  ).run(JSON.stringify([{ id: "fn-1.1" }, { id: "fn-1.2" }]), "fn-1");
  const reference11 = encodeFrame(asResult(runQuery(db, 11, frame)));
  const line11 = asLine(
    dispatchLine(db, newConn(), JSON.stringify(frame), db, undefined, memo),
  );
  expect(memo.worldRev).toBe(11);
  expect(line11).toBe(reference11);
  expect(JSON.parse(line11.trim()).rev).toBe(11);
  // The rev-10 entry did NOT survive — the Map was replaced, not augmented.
  expect(memo.entries.size).toBe(1);
  db.close();
});

test("fn-698 memo-throw degrades to the un-memoized result path; dispatchLine never throws", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedEpic(db, "fn-1", { last_event_id: 1 });
  setWorldRev(db, 8);

  // A memo whose `entries.get` throws on access — simulates any memo-path bug.
  const poison = newResultMemo();
  Object.defineProperty(poison, "entries", {
    get() {
      throw new Error("boom");
    },
  });

  const conn = newConn();
  const frame = { type: "query" as const, collection: "epics", id: "x" };
  let frames: (ServerFrame | PreSerialized)[] = [];
  expect(() => {
    frames = dispatchLine(
      db,
      conn,
      JSON.stringify(frame),
      db,
      undefined,
      poison as ResultMemo,
    );
  }).not.toThrow();
  // Degraded to the un-memoized path → a real ResultFrame OBJECT, not a line.
  const f = frames[0] as ServerFrame;
  expect((f as unknown as PreSerialized).__line).toBeUndefined();
  expect(f.type).toBe("result");
  // And the subscription still seeded normally.
  expect(anonSub(conn)).toBeUndefined(); // id-keyed sub, not anonymous
  expect(subFor(conn, "x")?.collection).toBe("epics");
  db.close();
});

test("fn-698 unknown collection through the memo path mints the same error (not cached)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  setWorldRev(db, 1);
  const memo = newResultMemo();
  const frames = dispatchLine(
    db,
    newConn(),
    JSON.stringify({ type: "query", collection: "nope", id: "e" }),
    db,
    undefined,
    memo,
  );
  const f = frames[0] as ErrorFrame;
  expect(f.type).toBe("error");
  expect(f.code).toBe("unknown_collection");
  expect(memo.entries.size).toBe(0);
  db.close();
});

test("fn-698 writeFrames writes a PreSerialized line verbatim — fresh path", () => {
  const sock = fakeSock();
  const line =
    '{"type":"result","id":"z","collection":"jobs","rev":4,"total":0,"rows":[]}\n';
  writeFrames(sock, [{ __line: line }]);
  // fakeSock decodes each NDJSON line back to an object — the verbatim line
  // round-trips to the same frame, proving the bytes hit the socket unchanged.
  expect(sock.frames.length).toBe(1);
  expect(sock.frames[0]).toEqual({
    type: "result",
    id: "z",
    collection: "jobs",
    rev: 4,
    total: 0,
    rows: [],
  });
});

test("fn-698 writeFrames writes a PreSerialized line verbatim — backpressure pending-append branch", () => {
  const sock = fakeSock();
  // First, stash a pending tail by refusing the write.
  sock.accept = false;
  const firstLine =
    '{"type":"result","id":"a","collection":"jobs","rev":1,"total":0,"rows":[]}\n';
  writeFrames(sock, [{ __line: firstLine }]);
  expect(sock.data.pending).not.toBeNull();
  expect(sock.frames.length).toBe(0);

  // Now append a SECOND pre-serialized line while pending — it must be encoded
  // verbatim (NOT re-stringified) behind the still-pending tail.
  const secondLine =
    '{"type":"result","id":"b","collection":"jobs","rev":2,"total":0,"rows":[]}\n';
  writeFrames(sock, [{ __line: secondLine }]);

  // Drain: accept everything; both lines flush in order, byte-for-byte.
  sock.accept = true;
  resumePending(sock);
  expect(sock.frames.map((f) => (f as ResultFrame).id)).toEqual(["a", "b"]);
});

test("fn-698 a non-query frame still routes through encodeFrame (object path intact)", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  setWorldRev(db, 2);
  const memo = newResultMemo();
  // An unsubscribe returns [] — never touches the memo / pre-serialized path.
  const frames = dispatchLine(
    db,
    newConn(),
    JSON.stringify({ type: "unsubscribe" }),
    db,
    undefined,
    memo,
  );
  expect(frames).toEqual([]);
  db.close();
});

test("fn-698 cap: a NEW signature past the cap runs un-memoized; the hot signature never sheds", () => {
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  seedEpic(db, "fn-1", { last_event_id: 1 });
  setWorldRev(db, 1);

  // Pre-fill the memo to its cap with distinct signatures (distinct offsets).
  const memo = newResultMemo();
  memo.worldRev = 1;
  for (let i = 0; i < 256; i++) {
    memo.entries.set(`sig-${i}`, {
      rows: [],
      rowsJson: "[]",
      total: 0,
      token: "",
      where: { clause: "", params: [] },
    });
  }
  expect(memo.entries.size).toBe(256);

  // A genuinely NEW signature at the SAME worldRev: capped → un-memoized
  // (object ResultFrame, no new entry minted).
  const frames = dispatchLine(
    db,
    newConn(),
    JSON.stringify({
      type: "query",
      collection: "epics",
      id: "fresh",
      limit: 7,
    }),
    db,
    undefined,
    memo,
  );
  const f = frames[0] as ServerFrame;
  expect((f as unknown as PreSerialized).__line).toBeUndefined();
  expect(f.type).toBe("result");
  // Still 256 — the cap held, nothing evicted, nothing added.
  expect(memo.entries.size).toBe(256);
  db.close();
});

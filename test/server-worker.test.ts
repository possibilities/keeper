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
  JOBS_DESCRIPTOR,
  type Row,
} from "../src/collections";
import { openDb } from "../src/db";
import type {
  ErrorFrame,
  FilterValue,
  MetaFrame,
  PatchFrame,
  ResultFrame,
  RpcResultFrame,
  ServerFrame,
} from "../src/protocol";
import {
  acquireLock,
  BadParamsError,
  type ConnState,
  diffTick,
  dispatchLine,
  isPidAlive,
  LockHeldError,
  pollLoop,
  RPC_REGISTRY,
  registerRpc,
  resolveFilter,
  resumePending,
  runQuery,
  startServer,
  unregisterRpc,
  type Writable,
  writeFrames,
} from "../src/server-worker";

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

function dispatchInit(): ConnState {
  // The module's newConnState is private; build the equivalent here.
  return {
    // LineBuffer isn't needed for direct dispatchLine calls (we pass whole
    // lines), but the field must exist to satisfy the type.
    buffer: {
      push: () => [],
      pendingLength: () => 0,
    } as unknown as ConnState["buffer"],
    collection: null,
    watched: new Set<string>(),
    lastSent: new Map<string, number>(),
    where: null,
    lastTotal: null,
    lastToken: null,
    pending: null,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-server-test-"));
  dbPath = join(tmpDir, "keeper.db");
  sockPath = join(tmpDir, "keeperd.sock");
  lockPath = join(tmpDir, "keeperd.lock");
  // Bootstrap schema with a writer so the readonly server connection can open.
  openDb(dbPath).db.close();
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
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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

test("runQuery applies a state filter", () => {
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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

test("resolveFilter: epics default OR-scope applies bare, is dropped by ANY wire filter, exempts pk lookups", () => {
  // No filter → the descriptor's `defaultClause` (raw SQL with bound params)
  // is appended. Predicate is "open OR not-yet-approved" — the cross-column
  // OR that the per-key `defaultFilter` map can't express.
  const def = resolveFilter(EPICS_DESCRIPTOR, undefined);
  expect(def.clause).toBe("WHERE (status = ? OR approval != ?)");
  expect(def.params).toEqual(["open", "approved"]);

  // An explicit status drops the defaultClause entirely (wire-not-empty is
  // the user's "I know what I want" override). Page now shows ONLY done
  // epics, including done+approved ones the default would have hidden.
  const statusOnly = resolveFilter(EPICS_DESCRIPTOR, { status: "done" });
  expect(statusOnly.clause).toBe("WHERE status = ?");
  expect(statusOnly.params).toEqual(["done"]);

  // An explicit approval also drops the defaultClause; page is scoped to the
  // wire alone. `--show-approved` on autopilot rides this path.
  const approvalOnly = resolveFilter(EPICS_DESCRIPTOR, {
    approval: "approved",
  });
  expect(approvalOnly.clause).toBe("WHERE approval = ?");
  expect(approvalOnly.params).toEqual(["approved"]);

  // A non-default filter key (project_dir) also counts as "wire-not-empty"
  // and drops the default — the scope is the wire's predicate alone.
  const byDir = resolveFilter(EPICS_DESCRIPTOR, { project_dir: "/r" });
  expect(byDir.clause).toBe("WHERE project_dir = ?");
  expect(byDir.params).toEqual(["/r"]);

  // A pk lookup is exempt from the default: it resolves one identity
  // regardless of status or approval (a detail subscribe of a
  // done+approved epic must resolve).
  const pk = resolveFilter(EPICS_DESCRIPTOR, { epic_id: "fn-2-done" });
  expect(pk.clause).toBe("WHERE epic_id = ?");
  expect(pk.params).toEqual(["fn-2-done"]);
});

test("runQuery resolves the pk filter for a detail-page single-item subscribe", () => {
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
  seedJob(db, "a");
  const res = asResult(
    runQuery(db, 1, { type: "query", collection: "jobs", id: "q1" }),
  );
  expect(res.id).toBe("q1");
  expect(res.collection).toBe("jobs");
  db.close();
});

test("runQuery falls back to created_at for an unknown sort column", () => {
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  expect(conn.collection).toBe("jobs");
  expect([...conn.watched].sort()).toEqual(["a", "b"]);
  expect(conn.lastSent.get("a")).toBe(5);
  expect(conn.lastSent.get("b")).toBe(9);
  db.close();
});

test("dispatchLine unsubscribe clears collection + watched-set", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedJob(db, "a");
  const conn = newConn();
  dispatchLine(db, conn, JSON.stringify({ type: "query", collection: "jobs" }));
  expect(conn.watched.size).toBe(1);
  expect(conn.collection).toBe("jobs");
  const frames = dispatchLine(
    db,
    conn,
    JSON.stringify({ type: "unsubscribe" }),
  );
  expect(frames).toHaveLength(0);
  expect(conn.collection).toBeNull();
  expect(conn.watched.size).toBe(0);
  expect(conn.lastSent.size).toBe(0);
  db.close();
});

test("dispatchLine query with absent/empty/non-string collection → bad_frame", () => {
  const { db } = openDb(dbPath, { readonly: false });
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
    expect(conn.collection).toBeNull();
  }
  db.close();
});

test("dispatchLine unknown collection → unknown_collection AND prior subscription survives", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedJob(db, "a", { last_event_id: 5 });
  const conn = newConn();
  // Establish a live subscription first.
  dispatchLine(db, conn, JSON.stringify({ type: "query", collection: "jobs" }));
  expect(conn.collection).toBe("jobs");
  expect([...conn.watched]).toEqual(["a"]);

  // A well-formed query naming an unregistered collection errors WITHOUT
  // touching the existing subscription.
  const frames = dispatchLine(
    db,
    conn,
    JSON.stringify({ type: "query", collection: "plans", id: "q2" }),
  );
  expect(frames).toHaveLength(1);
  expect(frames[0].type).toBe("error");
  expect((frames[0] as ErrorFrame).code).toBe("unknown_collection");
  expect((frames[0] as ErrorFrame).collection).toBe("plans");
  // Prior subscription intact.
  expect(conn.collection).toBe("jobs");
  expect([...conn.watched]).toEqual(["a"]);
  expect(conn.lastSent.get("a")).toBe(5);
  db.close();
});

test("dispatchLine returns an error frame for malformed JSON (connection survives)", () => {
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db: writer } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
  const teardown = withRpc("noop", () => null);
  try {
    seedJob(db, "a", { last_event_id: 5 });
    const conn = newConn();
    dispatchLine(
      db,
      conn,
      JSON.stringify({ type: "query", collection: "jobs" }),
    );
    expect(conn.collection).toBe("jobs");
    expect(conn.watched.has("a")).toBe(true);

    // An RPC in the middle of a live subscription must NOT touch ConnState.
    dispatchLine(
      db,
      conn,
      JSON.stringify({ type: "rpc", id: "r1", method: "noop" }),
      db,
    );
    expect(conn.collection).toBe("jobs");
    expect(conn.watched.has("a")).toBe(true);
    expect(conn.lastSent.get("a")).toBe(5);
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
      workerData: { dbPath, sockPath, lockPath },
    } as WorkerOptions & { workerData: unknown },
  );

  const exited = new Promise<void>((resolve) => {
    worker.addEventListener("close", () => resolve());
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

  const result = await Promise.race([
    exited.then(() => "exited" as const),
    Bun.sleep(2000).then(() => "timeout" as const),
  ]);
  expect(result).toBe("exited");
  expect(existsSync(sockPath)).toBe(false);
  expect(existsSync(lockPath)).toBe(false);
});

// ---------------------------------------------------------------------------
// realtime poll → diff → patch
// ---------------------------------------------------------------------------

/**
 * A fake socket that records every frame written to it (decoded from the
 * NDJSON bytes `writeFrames` produces). Drives `diffTick` deterministically
 * without a real `Bun.Socket`. `accept` controls backpressure: when false,
 * `write()` returns 0 so the frame stays pending and the connection is skipped.
 */
function fakeSock(): Writable & {
  frames: ServerFrame[];
  accept: boolean;
} {
  const sock = {
    data: dispatchInit(),
    accept: true,
    frames: [] as ServerFrame[],
    write(data: Uint8Array, off = 0, len = data.length - off): number {
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
  };
  return sock;
}

/**
 * Seed a connection's active collection + watched-set + lastSent from the rows
 * it would page, PLUS the membership baseline (`where` + `lastTotal` +
 * `lastToken`) the meta pass diffs against. `diffTick` groups by `collection`
 * and skips null-collection conns, so the active collection must be set for the
 * diff to visit the conn. The baseline is computed from the live DB so a pure
 * cell update (membership unchanged) is a meta-pass no-op for these tests.
 *
 * `filter` is the wire filter the subscription was built from (`{}` =
 * unfiltered, the jobs default). The membership baseline is seeded from the SAME
 * resolved filter / countAndToken the server would have used.
 */
function watch(
  db: Database,
  sock: Writable,
  seed: Record<string, number>,
  filter: Record<string, FilterValue> = {},
  collection = "jobs",
): void {
  sock.data.collection = collection;
  sock.data.watched = new Set(Object.keys(seed));
  sock.data.lastSent = new Map(Object.entries(seed));
  const where = resolveFilter(JOBS_DESCRIPTOR, filter);
  const { total, token } = countAndToken(
    db,
    JOBS_DESCRIPTOR,
    where.clause,
    where.params,
  );
  sock.data.where = where;
  sock.data.lastTotal = total;
  sock.data.lastToken = token;
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

async function retryUntil<T>(
  predicate: () => T | null | undefined,
  timeoutMs = 2000,
  cadenceMs = 25,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) {
      return value;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await Bun.sleep(cadenceMs);
  }
}

test("diffTick pushes one patch when a watched row advances; rev is stamped", () => {
  const { db } = openDb(dbPath, { readonly: false });
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
  expect(sock.data.lastSent.get("a")).toBe(6);
  db.close();
});

test("diffTick emits nothing when no watched row advanced (no-op tick)", () => {
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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

test("diffTick fans out only to connections watching the changed id", () => {
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  expect(slow.data.lastSent.get("a")).toBe(1);
  db.close();
});

test("diffTick never visits a null-collection connection", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedJob(db, "a", { last_event_id: 1 });

  // A conn with NO active subscription: watched is populated but collection is
  // null (e.g. after unsubscribe but a stale watched-set lingered). It must be
  // skipped — no patch, watched untouched.
  const idle = fakeSock();
  idle.data.collection = null;
  idle.data.watched = new Set(["a"]);
  idle.data.lastSent = new Map([["a", 1]]);

  const active = fakeSock();
  watch(db, active, { a: 1 });

  advanceJob(db, "a", 2);
  diffTick(db, [idle, active]);

  // Active conn got its patch; idle (null-collection) conn was never visited.
  expect(active.frames).toHaveLength(1);
  expect(idle.frames).toHaveLength(0);
  expect(idle.data.lastSent.get("a")).toBe(1);
  db.close();
});

test("diffTick groups connections by collection (one selectByIds per group)", () => {
  const { db } = openDb(dbPath, { readonly: false });
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

test("pollLoop drives a patch to a subscriber after a separate writer commits", async () => {
  // Reader connection runs the poll loop (autocommit, observes other conns'
  // commits). A separate writer connection commits a jobs change.
  const { db: reader } = openDb(dbPath, { readonly: true });
  const { db: writer } = openDb(dbPath, { readonly: false });

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
  const { db: writer } = openDb(dbPath, { readonly: false });

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
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
  seedJob(db, "a");
  const before = countAndToken(db, JOBS_DESCRIPTOR, "", []);
  seedJob(db, "b"); // enters
  const after = countAndToken(db, JOBS_DESCRIPTOR, "", []);
  expect(after.total).toBe(before.total + 1);
  expect(after.token).not.toBe(before.token);
  db.close();
});

test("countAndToken: token CHANGES on a row leaving the set", () => {
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
  // No jobs match the filter.
  const where = resolveFilter(JOBS_DESCRIPTOR, { state: "nonesuch" });
  const res = countAndToken(db, JOBS_DESCRIPTOR, where.clause, where.params);
  expect(res.total).toBe(0);
  expect(res.token).toBe("");
  db.close();
});

test("countAndToken: token is order-stable regardless of insertion order", () => {
  // Same identity set inserted in different orders → same token (ORDER BY pk).
  const { db: db1 } = openDb(dbPath, { readonly: false });
  seedJob(db1, "c");
  seedJob(db1, "a");
  seedJob(db1, "b");
  const t1 = countAndToken(db1, JOBS_DESCRIPTOR, "", []).token;
  db1.close();
  // Fresh DB, reversed insertion order.
  rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-server-test-"));
  dbPath = join(tmpDir, "keeper.db");
  openDb(dbPath).db.close();
  const { db: db2 } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  expect(sock.data.lastTotal).toBe(2);
  diffTick(db, [sock]);
  expect(sock.frames.filter((f) => f.type === "meta")).toHaveLength(1);
  db.close();
});

test("diffTick emits a meta on a balanced swap (token-only change, total steady)", () => {
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
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
  expect(w1.data.lastTotal).toBe(2);
  expect(w2.data.lastTotal).toBe(2);
  db.close();
});

test("diffTick distinguishes filters: a working-only conn ignores a stopped enter", () => {
  const { db } = openDb(dbPath, { readonly: false });
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
  const { db } = openDb(dbPath, { readonly: false });
  seedJob(db, "a", { last_event_id: 1 });
  const sock = fakeSock();
  watch(db, sock, { a: 1 }); // baseline total=1

  // Backpressured: a pending write is stashed.
  sock.data.pending = { bytes: new Uint8Array([1]), offset: 0 };

  seedJob(db, "b", { last_event_id: 1 }); // membership grows to 2
  diffTick(db, [sock]);

  // Skipped: no meta, baseline NOT advanced.
  expect(sock.frames.filter((f) => f.type === "meta")).toHaveLength(0);
  expect(sock.data.lastTotal).toBe(1);

  // Unblock and re-tick: the signal is re-derived from current state.
  sock.data.pending = null;
  diffTick(db, [sock]);
  expect(firstMeta(sock)?.total).toBe(2);
  expect(sock.data.lastTotal).toBe(2);
  db.close();
});

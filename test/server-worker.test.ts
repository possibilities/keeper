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
import { openDb } from "../src/db";
import type {
  PatchFrame,
  QueryFrame,
  ResultFrame,
  ServerFrame,
} from "../src/protocol";
import {
  acquireLock,
  type ConnState,
  diffTick,
  dispatchLine,
  isPidAlive,
  LockHeldError,
  pollLoop,
  resumePending,
  runQuery,
  startServer,
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
    mode: string;
    cwd: string;
    last_event_id: number;
    updated_at: number;
  }> = {},
): void {
  db.query(
    `INSERT INTO jobs (job_id, created_at, cwd, pid, mode, state, last_event_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    job_id,
    1,
    opts.cwd ?? null,
    null,
    opts.mode ?? "act",
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
    watched: new Set<string>(),
    lastSent: new Map<string, number>(),
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

test("runQuery returns rows ordered by updated_at desc by default", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedJob(db, "a", { updated_at: 10 });
  seedJob(db, "b", { updated_at: 30 });
  seedJob(db, "c", { updated_at: 20 });

  const res = runQuery(db, 7, { type: "query" } as QueryFrame);
  expect(res.type).toBe("result");
  expect(res.rev).toBe(7);
  expect(res.rows.map((r) => r.job_id)).toEqual(["b", "c", "a"]);
  db.close();
});

test("runQuery honors limit + offset", () => {
  const { db } = openDb(dbPath, { readonly: false });
  for (let i = 0; i < 5; i++) {
    seedJob(db, `j${i}`, { updated_at: i });
  }
  // desc by updated_at: j4,j3,j2,j1,j0. limit 2 offset 1 → j3,j2.
  const res = runQuery(db, 0, { type: "query", limit: 2, offset: 1 });
  expect(res.rows.map((r) => r.job_id)).toEqual(["j3", "j2"]);
  db.close();
});

test("runQuery applies a state filter", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedJob(db, "w", { state: "working", updated_at: 2 });
  seedJob(db, "s", { state: "stopped", updated_at: 1 });
  const res = runQuery(db, 0, {
    type: "query",
    filter: { state: "working" },
  });
  expect(res.rows.map((r) => r.job_id)).toEqual(["w"]);
  db.close();
});

test("runQuery echoes the query id onto the result", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedJob(db, "a");
  const res = runQuery(db, 1, { type: "query", id: "q1" });
  expect(res.id).toBe("q1");
  db.close();
});

test("runQuery falls back to updated_at for an unknown sort column", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedJob(db, "a", { updated_at: 1 });
  seedJob(db, "b", { updated_at: 2 });
  const res = runQuery(db, 0, {
    type: "query",
    sort: { column: "drop table jobs" },
  });
  // Default desc by updated_at → b before a (no SQL injection, no throw).
  expect(res.rows.map((r) => r.job_id)).toEqual(["b", "a"]);
  db.close();
});

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

test("dispatchLine query seeds the watched-set + lastSent", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedJob(db, "a", { last_event_id: 5 });
  seedJob(db, "b", { last_event_id: 9 });
  const conn = newConn();
  const frames = dispatchLine(db, conn, JSON.stringify({ type: "query" }));
  expect(frames).toHaveLength(1);
  expect((frames[0] as ResultFrame).type).toBe("result");
  expect([...conn.watched].sort()).toEqual(["a", "b"]);
  expect(conn.lastSent.get("a")).toBe(5);
  expect(conn.lastSent.get("b")).toBe(9);
  db.close();
});

test("dispatchLine unsubscribe clears the watched-set", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedJob(db, "a");
  const conn = newConn();
  dispatchLine(db, conn, JSON.stringify({ type: "query" }));
  expect(conn.watched.size).toBe(1);
  const frames = dispatchLine(
    db,
    conn,
    JSON.stringify({ type: "unsubscribe" }),
  );
  expect(frames).toHaveLength(0);
  expect(conn.watched.size).toBe(0);
  expect(conn.lastSent.size).toBe(0);
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
  const ok = dispatchLine(db, conn, JSON.stringify({ type: "query" }));
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

/** Seed a connection's watched-set + lastSent from the rows it would page. */
function watch(sock: Writable, seed: Record<string, number>): void {
  sock.data.watched = new Set(Object.keys(seed));
  sock.data.lastSent = new Map(Object.entries(seed));
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
  watch(sock, { a: 5 }); // seeded from the snapshot read

  advanceJob(db, "a", 6); // reducer folded a new event for `a`
  diffTick(db, [sock]);

  expect(sock.frames).toHaveLength(1);
  const patch = sock.frames[0] as PatchFrame;
  expect(patch.type).toBe("patch");
  expect(patch.job.job_id).toBe("a");
  expect(patch.job.last_event_id).toBe(6);
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
  watch(sock, { a: 5 });

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
  watch(sock, { a: 5 });

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
  watch(watcherA, { a: 1 });
  const watcherB = fakeSock();
  watch(watcherB, { b: 1 });

  // Only `a` advances.
  advanceJob(db, "a", 2);
  diffTick(db, [watcherA, watcherB]);

  expect(watcherA.frames).toHaveLength(1);
  expect((watcherA.frames[0] as PatchFrame).job.job_id).toBe("a");
  expect(watcherB.frames).toHaveLength(0);
  db.close();
});

test("diffTick coalesces multiple folds between ticks into one patch", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedJob(db, "a", { last_event_id: 1 });
  const sock = fakeSock();
  watch(sock, { a: 1 });

  // Three folds land before the tick observes them; state-based diff collapses.
  advanceJob(db, "a", 2);
  advanceJob(db, "a", 3);
  advanceJob(db, "a", 4);
  diffTick(db, [sock]);

  expect(sock.frames).toHaveLength(1);
  expect((sock.frames[0] as PatchFrame).job.last_event_id).toBe(4);
  db.close();
});

test("diffTick skips a backpressured socket without stalling others; lastSent not advanced", () => {
  const { db } = openDb(dbPath, { readonly: false });
  seedJob(db, "a", { last_event_id: 1 });
  const slow = fakeSock();
  watch(slow, { a: 1 });
  const fast = fakeSock();
  watch(fast, { a: 1 });

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

test("pollLoop drives a patch to a subscriber after a separate writer commits", async () => {
  // Reader connection runs the poll loop (autocommit, observes other conns'
  // commits). A separate writer connection commits a jobs change.
  const { db: reader } = openDb(dbPath, { readonly: true });
  const { db: writer } = openDb(dbPath, { readonly: false });

  seedJob(writer, "a", { last_event_id: 1 });
  setWorldRev(writer, 7);

  const sock = fakeSock();
  watch(sock, { a: 1 });

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
  expect(patch.job.job_id).toBe("a");
  expect(patch.job.last_event_id).toBe(2);
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
  watch(sock, { a: 1 });

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

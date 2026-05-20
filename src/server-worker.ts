/**
 * Server worker. Runs as keeperd's SECOND Bun Worker thread (the first is the
 * wake worker). It owns the read surface: a UDS listener that speaks the NDJSON
 * protocol from `src/protocol.ts`, its OWN read-only DB connection, and the
 * `<state-dir>/keeperd.lock` ownership lock.
 *
 * This task (`.2`) ships the transport + lifecycle + dispatch shell up to a
 * one-shot `query → result`. The live `data_version` poll → diff → `patch`
 * loop lands in task `.3`; the per-connection `lastSent` map and watched-set
 * seeded here are the substrate that loop will read.
 *
 * Conventions mirror `src/wake-worker.ts`:
 * - `isMainThread`-guarded body — a plain `import` from a test is inert.
 * - Own read-only `openDb(path, { readonly: true })` (handles are thread-affine
 *   and not structured-cloneable; the parent hands us only the path string via
 *   `workerData`).
 * - Typed message protocol: `{ kind: ... }` worker→main, `{ type: "shutdown" }`
 *   main→worker. Exit `0` clean / `1` crash. NO in-process self-heal — any
 *   unrecoverable error is `process.exit(1)` and the LaunchAgent restarts.
 *
 * Why a lock file and not the socket file for ownership: AF_UNIX has no
 * `SO_REUSEADDR`, so a crash leaves a stale socket → `Bun.listen` `EADDRINUSE`.
 * We acquire the lock (pid + liveness check) BEFORE the unlink-then-bind, so two
 * instances can never race the path: a live pid refuses to boot (launchd backs
 * off); a dead pid is stale and we steal it (unlink lock + socket, take over).
 *
 * Why the worker releases the socket in its OWN shutdown handler: the socket is
 * bound to the PROCESS, not the Worker thread. `worker.terminate()` from the
 * daemon does NOT release it — so the worker must `listener.stop(true)` +
 * unlink socket + unlink lock here, or the socket leaks into the next boot.
 */

import type { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { openDb, resolveSockPath } from "./db";
import {
  type ClientFrame,
  type ErrorFrame,
  encodeFrame,
  LineBuffer,
  OversizedLineError,
  type QueryFrame,
  type ResultFrame,
  type ServerFrame,
} from "./protocol";
import type { Job } from "./types";

/**
 * Data the parent passes via `new Worker(url, { workerData })`. Only path
 * strings cross the boundary — the Database handle and the listener cannot.
 */
export interface ServerWorkerData {
  dbPath: string;
  sockPath?: string;
  lockPath?: string;
}

/** Message posted to the parent when the listener is bound and serving. */
export interface ReadyMessage {
  kind: "ready";
}

/** Message the parent sends to ask the worker to stop. */
export interface ShutdownMessage {
  type: "shutdown";
}

/** Default page size when a `query` omits `limit`; the hard cap is the same. */
export const DEFAULT_LIMIT = 100;
/** Maximum page size — kept well below `MAX_IN_PARAMS` so a page is one query. */
export const MAX_LIMIT = 500;
/** Columns clients may sort by (allowlist — anything else falls back). */
const SORTABLE_COLUMNS = new Set([
  "updated_at",
  "created_at",
  "last_event_id",
  "job_id",
  "state",
  "mode",
]);

/**
 * Per-connection state, carried on `socket.data` (typed via the
 * `Bun.listen<ConnState>` generic).
 *
 * - `buffer` line-buffers inbound chunks until a `\n` lands (NDJSON framing).
 * - `watched` is the frozen page membership seeded by the latest `query` — the
 *   set task `.3` re-reads + diffs on every `data_version` tick.
 * - `lastSent` maps `job_id → last_event_id` as last pushed to this client, so
 *   `.3` emits a `patch` exactly once per advance.
 * - `pending` holds a backpressured tail: the UTF-8 bytes not yet accepted by
 *   the socket, resumed in `drain`.
 */
export interface ConnState {
  buffer: LineBuffer;
  watched: Set<string>;
  lastSent: Map<string, number>;
  pending: { bytes: Uint8Array; offset: number } | null;
}

function newConnState(): ConnState {
  return {
    buffer: new LineBuffer(),
    watched: new Set(),
    lastSent: new Map(),
    pending: null,
  };
}

// ---------------------------------------------------------------------------
// Lock-file ownership
// ---------------------------------------------------------------------------

/** Thrown when a live instance already owns the lock — boot must refuse. */
export class LockHeldError extends Error {
  constructor(public readonly pid: number) {
    super(`keeperd lock held by live pid ${pid}; refusing to start`);
    this.name = "LockHeldError";
  }
}

/**
 * Acquire the ownership lock at `lockPath`, reclaiming a stale `sockPath` if
 * the prior holder is dead.
 *
 * - Lock absent → write our pid, return.
 * - Lock present, pid alive (`process.kill(pid, 0)` succeeds) → throw
 *   `LockHeldError`; the caller exits non-zero and launchd backs off.
 * - Lock present, pid dead (`ESRCH`) → stale: unlink the lock AND the socket,
 *   then take ownership.
 * - Lock present but unparseable / `process.kill` denied (`EPERM` — pid alive,
 *   owned by another user) → treat as live and refuse.
 *
 * Acquired BEFORE bind so two instances never race the socket path.
 */
export function acquireLock(lockPath: string, sockPath: string): void {
  const dir = dirname(lockPath);
  if (!existsSync(dir)) {
    // `0700` is the real ACL gate on macOS (socket-file mode may be ignored).
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    // Tighten an existing dir — resolveDbPath's mkdirSync does not set mode.
    try {
      chmodSync(dir, 0o700);
    } catch {
      // best-effort; a pre-existing looser dir is not fatal to boot
    }
  }

  if (existsSync(lockPath)) {
    const text = readFileSync(lockPath, "utf8");
    const pid = Number.parseInt(text.trim(), 10);

    if (Number.isInteger(pid) && pid > 0) {
      if (isPidAlive(pid)) {
        throw new LockHeldError(pid);
      }
      // Stale: prior holder is dead. Unlink lock + socket, then steal.
      unlinkIfExists(lockPath);
      unlinkIfExists(sockPath);
    } else {
      // Unparseable lock — treat conservatively as stale and reclaim.
      unlinkIfExists(lockPath);
      unlinkIfExists(sockPath);
    }
  }

  writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o600 });
}

/**
 * Probe whether `pid` is alive. `process.kill(pid, 0)` sends no signal — it
 * just checks existence/permission:
 * - resolves → alive.
 * - `ESRCH` → no such process (dead).
 * - `EPERM` → process exists but owned by another user → treat as alive.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
      return true;
    }
    return false;
  }
}

function unlinkIfExists(path: string): void {
  try {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  } catch {
    // best-effort; a leftover file is reclaimed by the next ownership check
  }
}

// ---------------------------------------------------------------------------
// Query → result
// ---------------------------------------------------------------------------

/**
 * Page the `jobs` projection for a `query` frame. Returns the ordered rows plus
 * the world-rev read in the same logical snapshot — both feed the `result`
 * frame and seed the connection's watched-set / `lastSent`.
 *
 * Ordering, filtering, and paging happen in SQL so the page is read in one go.
 * Sort column is allowlisted (`SORTABLE_COLUMNS`) to avoid SQL injection via
 * the column name; an unknown column falls back to `updated_at`. Direction
 * defaults to `desc` for `updated_at` (most-recent-first) and otherwise honors
 * the frame, defaulting to `asc`.
 */
export function runQuery(
  db: Database,
  worldRev: number,
  frame: QueryFrame,
): ResultFrame {
  const sortCol =
    frame.sort && SORTABLE_COLUMNS.has(frame.sort.column)
      ? frame.sort.column
      : "updated_at";
  const dir =
    frame.sort?.dir === "asc" || frame.sort?.dir === "desc"
      ? frame.sort.dir
      : sortCol === "updated_at"
        ? "desc"
        : "asc";

  const limit = clampLimit(frame.limit);
  const offset =
    typeof frame.offset === "number" && frame.offset > 0
      ? Math.floor(frame.offset)
      : 0;

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (frame.filter?.state) {
    where.push("state = ?");
    params.push(frame.filter.state);
  }
  if (frame.filter?.mode) {
    where.push("mode = ?");
    params.push(frame.filter.mode);
  }
  if (frame.filter?.cwd) {
    where.push("cwd = ?");
    params.push(frame.filter.cwd);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  // sortCol + dir are both allowlisted constants, never user text — safe to
  // interpolate. limit/offset are bound.
  const sql = `
    SELECT job_id, created_at, cwd, pid, mode, state, last_event_id, updated_at
      FROM jobs
      ${whereClause}
     ORDER BY ${sortCol} ${dir.toUpperCase()}, job_id ASC
     LIMIT ? OFFSET ?
  `;
  const rows = db.prepare(sql).all(...params, limit, offset) as Job[];

  return {
    type: "result",
    ...(frame.id !== undefined ? { id: frame.id } : {}),
    rev: worldRev,
    rows,
  };
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Parse and dispatch ONE NDJSON line against the connection state. Returns the
 * server frames to send back (zero or more). NEVER throws on bad input — a
 * malformed/unknown/over-vocabulary frame yields an `error` frame and the
 * connection stays open. Each line is parsed in its own try/catch by the
 * caller too, but we keep the contract here so the unit layer can call this
 * directly.
 */
export function dispatchLine(
  db: Database,
  conn: ConnState,
  line: string,
): ServerFrame[] {
  if (line.trim().length === 0) {
    return []; // blank keep-alive line — ignore
  }

  let frame: ClientFrame;
  try {
    frame = JSON.parse(line) as ClientFrame;
  } catch {
    return [errorFrame(db, "bad_frame", "line is not valid JSON")];
  }

  if (!frame || typeof frame !== "object" || typeof frame.type !== "string") {
    return [errorFrame(db, "bad_frame", "frame missing string `type`")];
  }

  switch (frame.type) {
    case "query": {
      const worldRev = readWorldRev(db);
      const result = runQuery(db, worldRev, frame);
      // Seed the watched-set + lastSent for the live subscription (task .3).
      conn.watched = new Set(result.rows.map((r) => r.job_id));
      conn.lastSent = new Map(
        result.rows.map((r) => [r.job_id, r.last_event_id]),
      );
      return [result];
    }
    case "unsubscribe": {
      conn.watched = new Set();
      conn.lastSent = new Map();
      return [];
    }
    default: {
      const t = (frame as { type?: unknown }).type;
      return [
        errorFrame(
          db,
          "unknown_type",
          `unsupported frame type: ${String(t)}`,
          (frame as { id?: string }).id,
        ),
      ];
    }
  }
}

function errorFrame(
  db: Database,
  code: string,
  message: string,
  id?: string,
): ErrorFrame {
  return {
    type: "error",
    ...(id !== undefined ? { id } : {}),
    rev: readWorldRev(db),
    code,
    message,
  };
}

/** One-shot world-rev read used by error/result framing. */
function readWorldRev(db: Database): number {
  const row = db
    .prepare("SELECT last_event_id FROM reducer_state WHERE id = 1")
    .get() as { last_event_id: number } | null;
  return row ? row.last_event_id : 0;
}

// ---------------------------------------------------------------------------
// Backpressure-aware write
// ---------------------------------------------------------------------------

/**
 * A minimal write interface — just the surface `writeFrames`/`resumePending`
 * touch — so the unit layer can drive backpressure with a fake socket without
 * a real `Bun.Socket`.
 */
export interface Writable {
  write(data: Uint8Array, byteOffset?: number, byteLength?: number): number;
  data: ConnState;
}

const encoder = new TextEncoder();

/**
 * Write a batch of server frames to the socket with backpressure handling.
 * Encodes to one UTF-8 buffer, then writes from `pending.offset`. Bun's
 * `socket.write()` returns BYTES ACCEPTED — may be `< length` (buffer full) or
 * `0`; a negative return means the socket is closing (drop). On a short write
 * we stash the unaccepted tail in `conn.pending` and resume in `drain`.
 *
 * If a `pending` write is already stashed, the new frames are appended to it
 * rather than racing ahead — preserves frame order on the wire.
 */
export function writeFrames(sock: Writable, frames: ServerFrame[]): void {
  if (frames.length === 0 && !sock.data.pending) {
    return;
  }
  let buf: Uint8Array;
  let offset: number;
  if (sock.data.pending) {
    // Append new frames behind the still-pending tail.
    const tail = sock.data.pending.bytes.subarray(sock.data.pending.offset);
    const extra =
      frames.length > 0
        ? encoder.encode(frames.map((f) => encodeFrame(f)).join(""))
        : new Uint8Array(0);
    buf = new Uint8Array(tail.length + extra.length);
    buf.set(tail, 0);
    buf.set(extra, tail.length);
    offset = 0;
  } else {
    buf = encoder.encode(frames.map((f) => encodeFrame(f)).join(""));
    offset = 0;
  }

  flush(sock, buf, offset);
}

/**
 * Resume a stashed partial write after a `drain` event. No-op if nothing is
 * pending.
 */
export function resumePending(sock: Writable): void {
  const p = sock.data.pending;
  if (!p) {
    return;
  }
  sock.data.pending = null;
  flush(sock, p.bytes, p.offset);
}

function flush(sock: Writable, buf: Uint8Array, startOffset: number): void {
  let offset = startOffset;
  while (offset < buf.length) {
    const wrote = sock.write(buf, offset, buf.length - offset);
    if (wrote <= 0) {
      // 0 → buffer full (backpressure); negative → socket closing.
      if (wrote < 0) {
        // Socket is closing/closed — drop the rest; close handler cleans up.
        sock.data.pending = null;
        return;
      }
      // Stash the remainder; drain() resumes it.
      sock.data.pending = { bytes: buf, offset };
      return;
    }
    offset += wrote;
  }
  sock.data.pending = null;
}

// ---------------------------------------------------------------------------
// Worker server lifecycle
// ---------------------------------------------------------------------------

/**
 * What `startServer` returns so the worker `main()` (and tests) can drive
 * shutdown: the bound listener and a `stop()` that releases everything.
 */
export interface RunningServer {
  listener: import("bun").UnixSocketListener<ConnState>;
  stop(): void;
}

/**
 * Acquire the lock, unlink any stale socket, bind the UDS, and wire the NDJSON
 * dispatch handlers. Returns a `RunningServer`. The caller owns calling
 * `stop()` on shutdown (the worker `main` and tests both do).
 *
 * Throws `LockHeldError` if a live instance owns the lock — the caller exits
 * non-zero.
 */
export function startServer(
  db: Database,
  sockPath: string,
  lockPath: string,
): RunningServer {
  acquireLock(lockPath, sockPath);

  // AF_UNIX has no SO_REUSEADDR: a leftover socket file → EADDRINUSE. The lock
  // is already ours, so unlinking here can't race another instance.
  unlinkIfExists(sockPath);

  const listener = Bun.listen<ConnState>({
    unix: sockPath,
    socket: {
      open(socket) {
        socket.data = newConnState();
      },
      data(socket, chunk) {
        handleData(db, socket, chunk);
      },
      drain(socket) {
        resumePending(socket as unknown as Writable);
      },
      close(socket) {
        // Drop per-connection state; nothing process-global to release here.
        socket.data.pending = null;
        socket.data.watched.clear();
        socket.data.lastSent.clear();
      },
      error(_socket, err) {
        console.error("[server-worker] socket error:", err);
      },
    },
  });

  // The 0700 parent dir is the real ACL gate on macOS; chmod the socket 0600
  // as Linux defense-in-depth.
  try {
    chmodSync(sockPath, 0o600);
  } catch {
    // best-effort; the dir mode is the real gate
  }

  return {
    listener,
    stop() {
      // Release the socket HERE — it's owned by the process, not the Worker
      // thread; the daemon's worker.terminate() won't release it.
      try {
        listener.stop(true);
      } catch {
        // best-effort
      }
      unlinkIfExists(sockPath);
      unlinkIfExists(lockPath);
    },
  };
}

/**
 * Feed an inbound chunk into the connection's line buffer and dispatch each
 * complete line. An oversized line (no `\n` past the 1 MiB cap) is a fatal
 * protocol error — send a final `error` frame if we can, then close. Each line
 * dispatches in its own try/catch so one bad line never wedges the connection.
 */
function handleData(
  db: Database,
  socket: import("bun").Socket<ConnState>,
  chunk: Buffer,
): void {
  const w = socket as unknown as Writable;
  let lines: string[];
  try {
    lines = socket.data.buffer.push(chunk.toString("utf8"));
  } catch (err) {
    if (err instanceof OversizedLineError) {
      writeFrames(w, [
        {
          type: "error",
          rev: readWorldRev(db),
          code: "oversized_line",
          message: err.message,
        },
      ]);
      socket.end();
      return;
    }
    throw err;
  }

  for (const line of lines) {
    let frames: ServerFrame[];
    try {
      frames = dispatchLine(db, socket.data, line);
    } catch (err) {
      // Defensive: dispatchLine is contracted not to throw, but a DB hiccup
      // mid-query shouldn't kill the connection.
      frames = [
        {
          type: "error",
          rev: readWorldRev(db),
          code: "internal",
          message: err instanceof Error ? err.message : String(err),
        },
      ];
    }
    if (frames.length > 0) {
      writeFrames(w, frames);
    }
  }
}

/**
 * Worker entrypoint. Opens its own read-only connection, binds the server,
 * wires the shutdown message, and signals `ready` to the parent. Any failure
 * to bind (lock held, EADDRINUSE) exits non-zero so the parent's single
 * recovery path (LaunchAgent restart) engages.
 */
function main(): void {
  if (!parentPort) {
    console.error("[server-worker] no parentPort — not running as a Worker");
    process.exit(1);
  }

  const data = workerData as ServerWorkerData | undefined;
  if (!data || typeof data.dbPath !== "string") {
    console.error("[server-worker] missing dbPath in workerData");
    process.exit(1);
  }

  const sockPath = data.sockPath ?? resolveSockPath();
  const lockPath = data.lockPath ?? `${sockPath}.lock`;

  const { db } = openDb(data.dbPath, { readonly: true });

  let server: RunningServer;
  try {
    server = startServer(db, sockPath, lockPath);
  } catch (err) {
    // Lock held by a live instance, or bind failed. No self-heal — exit
    // non-zero; launchd backs off and the live owner keeps serving.
    console.error("[server-worker] failed to start:", err);
    try {
      db.close();
    } catch {
      // ignore
    }
    process.exit(1);
  }

  const shutdown = (): void => {
    server.stop();
    try {
      db.close();
    } catch {
      // best-effort; exiting either way
    }
    process.exit(0);
  };

  parentPort.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg && msg.type === "shutdown") {
      shutdown();
    }
  });

  parentPort.postMessage({ kind: "ready" } satisfies ReadyMessage);
}

// Only run inside a real Worker; a plain import on the main thread is inert.
if (!isMainThread) {
  main();
}

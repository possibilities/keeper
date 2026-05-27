/**
 * Server worker. Runs as keeperd's SECOND Bun Worker thread (the first is the
 * wake worker). It owns the read surface: a UDS listener that speaks the NDJSON
 * protocol from `src/protocol.ts`, its OWN read-only DB connection, and the
 * `<state-dir>/keeperd.lock` ownership lock.
 *
 * Task `.2` shipped the transport + lifecycle + dispatch shell up to a one-shot
 * `query → result`. Task `.3` added the realtime layer: an independent
 * `data_version` poll (`pollLoop`) that turns committed `jobs` changes into
 * per-entity `patch` pushes via a state-based diff (`diffTick`) keyed on each
 * connection's `lastSent` map + watched-set (seeded from the same read that
 * produced the `result` page). A third beat layers on top: each tick also runs
 * a per-filter `countAndToken` and emits a `meta` frame when a subscription's
 * filtered-set `total` or membership token moved (a row entered/left the set) —
 * a count/staleness signal, NOT a live membership stream (the page stays frozen).
 *
 * The RPC layer landed alongside: an `rpc` request frame routes through the
 * process-global `RPC_REGISTRY` and runs the handler against a dedicated WRITER
 * connection (opened next to the existing reader in `main()`). Concrete
 * handlers live in `src/rpc-handlers.ts` and are installed once per worker
 * spawn by `main()` calling `installRpcHandlers()`. As of schema v13 (the
 * fn-592-approval-as-planctl-field epic) the registry carries two planctl-
 * native approval handlers (`set_task_approval`, `set_epic_approval`) that
 * write `.planctl/{epics,tasks}/*.json` files directly — the v12 sidecar
 * `set_approval` handler was retired alongside the `approvals` table. The
 * two-connection split is load-bearing: the reader's `data_version` poll
 * only sees writes from OTHER connections, so any future SQL-mutating RPC
 * writer must be distinct from the poll reader (today's approval handlers
 * write files, not the DB, but the split stays for future SQL handlers).
 *
 * Conventions mirror `src/wake-worker.ts`:
 * - `isMainThread`-guarded body — a plain `import` from a test is inert.
 * - Own read-only `openDb(path, { readonly: true })` PLUS a writer-mode
 *   `openDb(path)` (handles are thread-affine and not structured-cloneable;
 *   the parent hands us only the path string via `workerData`). Both go
 *   through `applyPragmas` and both release in the shutdown handler.
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
import {
  type CollectionDescriptor,
  countAndToken,
  decodeRow,
  getCollection,
  type Row,
  selectByIds,
} from "./collections";
import { openDb, resolveSockPath } from "./db";
import {
  type ClientFrame,
  type ErrorFrame,
  encodeFrame,
  type FilterValue,
  LineBuffer,
  OversizedLineError,
  type PatchFrame,
  type QueryFrame,
  type ResultFrame,
  type RpcFrame,
  type RpcResultFrame,
  type ServerFrame,
} from "./protocol";
import { installRpcHandlers } from "./rpc-handlers";

/**
 * Data the parent passes via `new Worker(url, { workerData })`. Only path
 * strings cross the boundary — the Database handle and the listener cannot.
 */
export interface ServerWorkerData {
  dbPath: string;
  sockPath?: string;
  lockPath?: string;
  /** Realtime poll cadence in ms (defaults to `DEFAULT_POLL_MS`, floored at 25). */
  pollMs?: number;
}

/** Message posted to the parent when the listener is bound and serving. */
export interface ReadyMessage {
  kind: "ready";
}

/** Message the parent sends to ask the worker to stop. */
export interface ShutdownMessage {
  type: "shutdown";
}

/**
 * Poll cadence (ms) for the realtime `data_version` loop. Mirrors the wake
 * worker's defaults — 50 ms is the sweet spot, floored at 25 ms to avoid
 * burning a core.
 */
export const DEFAULT_POLL_MS = 50;
const MIN_POLL_MS = 25;

/** Default page size when a `query` omits `limit`; the hard cap is the same. */
export const DEFAULT_LIMIT = 100;
/** Maximum page size — kept well below `MAX_IN_PARAMS` so a page is one query. */
export const MAX_LIMIT = 500;

// ---------------------------------------------------------------------------
// DEBUG: timing instrumentation
// ---------------------------------------------------------------------------
//
// Diagnostic-only logs for chasing the "epics frame takes 5s sometimes" bug.
// Every line is `[srv-ts] T=<epochMs> <event>` so a client log emitting the
// same wall-clock can be diffed against it. Connection lifecycle and
// per-call dispatch/tick timings are gated by `KEEPER_TRACE_SERVER=1` AT
// THE CALL SITE — not inside `srvTs` — because the caller's template-literal
// `msg` argument allocates before any in-function gate would fire. Read the
// env var exactly once at module load into a `const`; V8/JSC elides the
// `if (TRACE)` branch in steady-state when off. The rare `[server-worker]`
// error class stays UN-gated.
const TRACE = process.env.KEEPER_TRACE_SERVER === "1";
let __nextConnId = 0;
function srvTs(msg: string): void {
  console.error(`[srv-ts] T=${Date.now()} ${msg}`);
}

/**
 * Per-connection state, carried on `socket.data` (typed via the
 * `Bun.listen<ConnState>` generic).
 *
 * - `buffer` line-buffers inbound chunks until a `\n` lands (NDJSON framing).
 * - `collection` is the active subscription's collection name (`null` until the
 *   first successful `query`; reset to `null` on `unsubscribe`). `diffTick`
 *   groups connections by it and skips `null`-collection conns.
 * - `watched` is the frozen page membership (keyed by the collection's pk)
 *   seeded by the latest `query` — the set re-read + diffed on every
 *   `data_version` tick.
 * - `lastSent` maps pk → the collection's version column as last pushed to this
 *   client, so the diff emits a `patch` exactly once per advance.
 * - `where` is the resolved filter (clause + bound params) the active query was
 *   built from — `null` until the first successful `query`, reset on
 *   `unsubscribe`. `diffTick` reuses it for the membership COUNT+token so the
 *   count can never drift from the page that produced it.
 * - `lastTotal` / `lastToken` are the filtered-set size + membership
 *   fingerprint last reflected to this client (seeded from the same read that
 *   produced the `result`'s `total`); the diff emits a `meta` frame only when
 *   either moves. `null` until the first `query`, reset on `unsubscribe`.
 * - `pending` holds a backpressured tail: the UTF-8 bytes not yet accepted by
 *   the socket, resumed in `drain`.
 *
 * One active subscription per connection: a re-query fully REPLACES
 * `collection` + `watched` + `lastSent` + `where` + `lastTotal` + `lastToken`
 * (list → detail navigation).
 */
export interface ConnState {
  buffer: LineBuffer;
  collection: string | null;
  watched: Set<string>;
  lastSent: Map<string, number>;
  where: ResolvedFilter | null;
  lastTotal: number | null;
  lastToken: string | null;
  pending: { bytes: Uint8Array; offset: number } | null;
  /** DEBUG: per-connection sequence id for `[srv-ts]` log correlation. */
  id?: number;
}

function newConnState(): ConnState {
  return {
    buffer: new LineBuffer(),
    collection: null,
    watched: new Set(),
    lastSent: new Map(),
    where: null,
    lastTotal: null,
    lastToken: null,
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
 * A resolved exact-match filter: the SQL `WHERE` fragment ("" or "WHERE ...")
 * and its bound parameters. Built ONCE per query (`resolveFilter`) and threaded
 * to BOTH the page SELECT and the membership COUNT+token, so the two can never
 * drift apart.
 */
export interface ResolvedFilter {
  clause: string;
  params: (string | number)[];
}

/**
 * Resolve a `query` frame's wire `filter` map into a SQL `WHERE` clause + bound
 * params, by descriptor map lookup. A wire filter key is only honored if the
 * descriptor declares it (→ a trusted SQL column); the value is bound (`?`). A
 * key absent from `descriptor.filters` is silently ignored (forward-compat).
 *
 * Two value forms: a bare `string | number` is an exact match (`col = ?`); the
 * `{ ne: value }` operator form is a not-equal exclusion (`col != ?`). The
 * operator string (`=` / `!=`) is a fixed literal chosen here, never wire text;
 * an operator object lacking a recognized key is ignored (forward-compat).
 *
 * Default scope: for each key in `descriptor.defaultFilter` the wire query does
 * NOT constrain, the descriptor's default value is applied (e.g. epics default
 * to `status: "open"`, so an unfiltered list hides done/closed epics). A wire
 * value for the key — bare or `{ ne }` — overrides the default for that key. A
 * single-item pk lookup (a detail-page subscribe, `filter:{<pk>}`) is EXEMPT
 * from defaults entirely: it targets one identity and must resolve whatever its
 * status, so the documented "filters include the pk for detail subscribe"
 * invariant holds even for a row outside the default scope.
 *
 * The descriptor is the SOLE identifier-injection gate: only declared columns
 * are interpolated; wire keys are never interpolated, operators are fixed
 * literals, values always bound.
 */
export function resolveFilter(
  descriptor: CollectionDescriptor,
  filter: Record<string, FilterValue> | undefined,
): ResolvedFilter {
  const where: string[] = [];
  const params: (string | number)[] = [];
  // A pk lookup (detail-page single-item subscribe) bypasses the default scope.
  const pkKey = pkFilterKey(descriptor);
  const isPkLookup = pkKey != null && filter?.[pkKey] != null;
  const wireIsEmpty = filter == null || Object.keys(filter).length === 0;
  for (const [key, col] of Object.entries(descriptor.filters)) {
    // Wire value wins; an unconstrained key falls back to the descriptor's
    // default scope, except on a pk lookup (which is exempt from defaults).
    const value =
      filter?.[key] ??
      (isPkLookup ? undefined : descriptor.defaultFilter?.[key]);
    if (value == null) {
      continue;
    }
    if (typeof value === "object") {
      // Operator form. `{ ne }` → `col != ?`; `{ in: [...] }` → `col IN (?, ?)`;
      // `{ not_in: [...] }` → `col NOT IN (?, ?)`. An unrecognized operator
      // object is ignored so a future operator is forward-compatible.
      if ("ne" in value && value.ne != null) {
        where.push(`${col} != ?`);
        params.push(value.ne);
      } else if ("in" in value && Array.isArray(value.in)) {
        if (value.in.length === 0) {
          // Empty IN list matches nothing; emit an always-false guard rather
          // than synthesizing `IN ()` (invalid SQL).
          where.push("0");
        } else {
          const placeholders = value.in.map(() => "?").join(", ");
          where.push(`${col} IN (${placeholders})`);
          params.push(...value.in);
        }
      } else if ("not_in" in value && Array.isArray(value.not_in)) {
        if (value.not_in.length === 0) {
          // Empty NOT IN list excludes nothing; contribute no clause.
          continue;
        }
        const placeholders = value.not_in.map(() => "?").join(", ");
        where.push(`${col} NOT IN (${placeholders})`);
        params.push(...value.not_in);
      }
      continue;
    }
    where.push(`${col} = ?`);
    params.push(value);
  }
  // Raw `defaultClause` fallback (cross-column predicates that don't fit the
  // per-key `defaultFilter` map). Applied only when the wire filter is
  // entirely empty AND this is not a pk lookup — the wire is the user's "I
  // know what I want" override; a pk subscribe is exempt from defaults.
  if (wireIsEmpty && !isPkLookup && descriptor.defaultClause) {
    where.push(descriptor.defaultClause.sql);
    params.push(...descriptor.defaultClause.params);
  }
  return {
    clause: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

/**
 * The wire filter key whose declared column IS the collection's pk (the key a
 * detail-page single-item subscribe uses), or `undefined` if none is declared.
 * Used to exempt a pk lookup from the default scope in {@link resolveFilter}.
 */
function pkFilterKey(descriptor: CollectionDescriptor): string | undefined {
  for (const [key, col] of Object.entries(descriptor.filters)) {
    if (col === descriptor.pk) {
      return key;
    }
  }
  return undefined;
}

/**
 * Page a collection for a `query` frame. Returns the ordered rows plus the
 * world-rev read in the same logical snapshot — both feed the `result` frame
 * and seed the connection's watched-set / `lastSent`. A well-formed `query`
 * naming an unregistered collection returns an `unknown_collection` ErrorFrame
 * (carrying `collection` + `id`) rather than throwing.
 *
 * Everything collection-specific routes through the descriptor: table, column
 * list, pk, the sort allowlist, the default sort, and the filter map. Ordering,
 * filtering, and paging happen in SQL so the page is read in one go.
 *
 * Injection: the sort column is validated against `descriptor.sortable` (an
 * unknown column falls back to `descriptor.defaultSort`); table/columns/pk/sort
 * col are descriptor constants, safe to interpolate. Wire `filter` keys are
 * resolved via `descriptor.filters` by map lookup (never interpolated); values
 * and limit/offset are bound (`?`).
 *
 * Sort direction: when the frame omits `dir`, default to the descriptor's
 * default dir only when the chosen column equals the default column (preserving
 * jobs' "updated_at → desc"), else `asc`.
 *
 * `total`: the filtered-set size (the WHERE only, ignoring limit/offset) plus a
 * membership token are read via ONE `countAndToken` over the SAME resolved
 * filter that built the page SELECT — so the count can't drift from the page,
 * and the result's `total` and the subscription's seeded `lastTotal`/`lastToken`
 * (see `runSubscription`) come from one snapshot. The optional `out` collects
 * the resolved filter + count so the caller seeds ConnState without a re-read.
 */
export function runQuery(
  db: Database,
  worldRev: number,
  frame: QueryFrame,
  out?: { where: ResolvedFilter; total: number; token: string },
): ResultFrame | ErrorFrame {
  const descriptor = getCollection(frame.collection);
  if (!descriptor) {
    return {
      type: "error",
      ...(frame.id !== undefined ? { id: frame.id } : {}),
      collection: frame.collection,
      rev: worldRev,
      code: "unknown_collection",
      message: `no such collection: ${frame.collection}`,
    };
  }

  const sortCol =
    frame.sort && descriptor.sortable.has(frame.sort.column)
      ? frame.sort.column
      : descriptor.defaultSort.column;
  const dir =
    frame.sort?.dir === "asc" || frame.sort?.dir === "desc"
      ? frame.sort.dir
      : sortCol === descriptor.defaultSort.column
        ? descriptor.defaultSort.dir
        : "asc";

  const limit = clampLimit(frame.limit);
  const offset =
    typeof frame.offset === "number" && frame.offset > 0
      ? Math.floor(frame.offset)
      : 0;

  // Resolve the filter ONCE (descriptor map lookup, bound values) and thread it
  // to BOTH the page SELECT and the membership count below — they can't drift.
  const where = resolveFilter(descriptor, frame.filter);

  // Filtered-set size + membership token, over the WHERE only (no limit/offset).
  const { total, token } = countAndToken(
    db,
    descriptor,
    where.clause,
    where.params,
  );

  // table/columns/pk/sortCol/dir are descriptor constants, never wire text —
  // safe to interpolate. filter values + limit/offset are bound. A wire
  // `limit: 0` ("no limit" sentinel from clampLimit) is rebound as SQLite's
  // `LIMIT -1` — the documented "all remaining rows" form, which still
  // honors `OFFSET` so a paged scan of the full set works the same way.
  const sqlLimit = limit === 0 ? -1 : limit;
  const sql = `
    SELECT ${descriptor.columns.join(", ")}
      FROM ${descriptor.table}
      ${where.clause}
     ORDER BY ${sortCol} ${dir.toUpperCase()}, ${descriptor.pk} ASC
     LIMIT ? OFFSET ?
  `;
  const rawRows = db
    .prepare(sql)
    .all(...where.params, sqlLimit, offset) as Row[];
  // Decode any JSON-TEXT columns so `result` rows carry the same shape as the
  // diff/patch path (`selectByIds`); a no-op while `jsonColumns` is empty.
  const rows = rawRows.map((row) => decodeRow(descriptor, row));

  if (out) {
    out.where = where;
    out.total = total;
    out.token = token;
  }

  return {
    type: "result",
    ...(frame.id !== undefined ? { id: frame.id } : {}),
    collection: descriptor.name,
    rev: worldRev,
    total,
    rows,
  };
}

/**
 * Resolve a wire `limit` to the page size used by `runQuery`:
 *   - `undefined` / non-finite / negative → `DEFAULT_LIMIT` (the historical
 *     default for clients that omit the field).
 *   - `0` → `0`, the explicit "no limit" sentinel; the SELECT runs without
 *     a row cap and the result carries the full filtered set. Watch out:
 *     diffTick's watched-set fan-out scales linearly with page size, so the
 *     client opts in deliberately.
 *   - positive → clamped at `MAX_LIMIT`.
 */
function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) {
    return DEFAULT_LIMIT;
  }
  if (limit === 0) {
    return 0;
  }
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

// ---------------------------------------------------------------------------
// RPC registry
// ---------------------------------------------------------------------------

/**
 * Handler signature for a registered RPC. Invoked with the server-worker's
 * WRITER connection (so a handler may mutate sidecar tables) and the request
 * frame's `params` (opaque object; handlers MUST validate shape and throw a
 * `BadParamsError` on mismatch). The return value is framed as
 * `rpc_result.value` — shape is per-handler, opaque to the dispatch shell.
 *
 * Contract: a handler MAY throw. The dispatcher catches and frames the throw
 * as an `error` frame with code `rpc_failed` (or `bad_params` for the typed
 * `BadParamsError`). It MUST NOT call `db.close()` and MUST NOT keep
 * connection state across invocations.
 */
export type RpcHandler = (db: Database, params: unknown) => unknown;

/**
 * A typed error a handler may throw when its `params` are malformed; the
 * dispatcher catches it and frames an `error` with code `bad_params`,
 * preserving the message. Distinct from a plain throw so the wire `code`
 * reflects the difference between "you sent garbage" and "we crashed".
 */
export class BadParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadParamsError";
  }
}

/**
 * The RPC dispatch registry: method name → handler. EMPTY by default at
 * module load — concrete handlers live in `src/rpc-handlers.ts` and install
 * themselves into this registry via `installRpcHandlers()`, which `main()`
 * calls once per worker spawn (so a plain import from a test or a main-thread
 * codepath leaves the registry empty). The registry is process-global,
 * matching the writer connection's process-global ownership in the
 * server-worker.
 *
 * Tests register temporary handlers via `registerRpc` + `unregisterRpc`
 * (the latter is test-only — there is no runtime un-registration path).
 */
export const RPC_REGISTRY: Map<string, RpcHandler> = new Map();

/**
 * Register an RPC handler. Throws if `method` is already registered — a
 * collision is a programming error, not a runtime condition the dispatcher
 * should silently paper over.
 */
export function registerRpc(method: string, handler: RpcHandler): void {
  if (RPC_REGISTRY.has(method)) {
    throw new Error(`RPC method already registered: ${method}`);
  }
  RPC_REGISTRY.set(method, handler);
}

/**
 * Remove a handler. Intended for tests that register a temporary handler and
 * tear it down after; production registrations are install-once.
 */
export function unregisterRpc(method: string): void {
  RPC_REGISTRY.delete(method);
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
 *
 * RPC dispatch: an `rpc` frame routes through `RPC_REGISTRY`. The dispatcher
 * runs the handler under the WRITER `db` connection (passed via `writerDb`
 * when present; falls back to the reader `db` only for read-only test wiring).
 * Every RPC failure path returns an `error` frame, never throws —
 * `unknown_method` on missing handler, `bad_params` on a typed
 * `BadParamsError` throw, `rpc_failed` on any other throw.
 */
export function dispatchLine(
  db: Database,
  conn: ConnState,
  line: string,
  writerDb?: Database,
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
      // `collection` is required and must be a non-empty string. Absent / empty
      // / non-string → bad_frame; a well-formed string naming no descriptor →
      // unknown_collection (decided inside runQuery). Either error leaves the
      // existing subscription intact.
      if (
        typeof frame.collection !== "string" ||
        frame.collection.length === 0
      ) {
        return [
          errorFrame(
            db,
            "bad_frame",
            "query frame missing non-empty string `collection`",
            frame.id,
          ),
        ];
      }
      const worldRev = readWorldRev(db);
      // `seed` collects the resolved filter + count from the SAME read that
      // produced the result's `total`, so the result→first-tick boundary emits
      // no spurious `meta`. (The page-read-vs-count-read snapshot race is
      // accepted — it self-heals on the next tick.)
      const seed = {} as {
        where: ResolvedFilter;
        total: number;
        token: string;
      };
      const out = runQuery(db, worldRev, frame, seed);
      if (out.type !== "result") {
        // unknown_collection (or any error): do NOT mutate the subscription.
        return [out];
      }
      const descriptor = getCollection(out.collection) as CollectionDescriptor;
      // Replace the subscription atomically (one synchronous block, no await):
      // collection + watched + lastSent + the membership baseline, keyed by the
      // descriptor's pk/version, so no diffTick interleaves stale rows.
      conn.collection = out.collection;
      conn.watched = new Set(out.rows.map((r) => String(r[descriptor.pk])));
      conn.lastSent = new Map(
        out.rows.map((r) => [
          String(r[descriptor.pk]),
          r[descriptor.version] as number,
        ]),
      );
      conn.where = seed.where;
      conn.lastTotal = seed.total;
      conn.lastToken = seed.token;
      return [out];
    }
    case "unsubscribe": {
      conn.collection = null;
      conn.watched = new Set();
      conn.lastSent = new Map();
      conn.where = null;
      conn.lastTotal = null;
      conn.lastToken = null;
      return [];
    }
    case "rpc": {
      return dispatchRpc(db, frame as RpcFrame, writerDb);
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

/**
 * Dispatch a single RPC frame. Validates shape (`id` and `method` must be
 * non-empty strings — else `bad_frame`, echoing the request id when present),
 * looks up the method (`unknown_method` on miss), invokes the handler with
 * the writer connection inside try/catch, and frames the return as
 * `rpc_result` (or `error` with code `bad_params` / `rpc_failed` on throw).
 *
 * The `id` is echoed on every response frame so a client multiplexing
 * in-flight RPCs can correlate by id alone. The `rev` on `rpc_result` / `error`
 * is the world-rev at frame-construction time — handlers that wrote to the
 * DB will see `rev` reflect their commit on the SAME reader connection used
 * for `rev` reads (the writer commit bumps `data_version`, which the reader
 * picks up on its next prepared-statement execution).
 */
function dispatchRpc(
  db: Database,
  frame: RpcFrame,
  writerDb: Database | undefined,
): ServerFrame[] {
  // `id` must be a non-empty string — without it the client can't correlate
  // the response, and we won't echo `undefined` to paper over the omission.
  const rawId = (frame as { id?: unknown }).id;
  const id = typeof rawId === "string" && rawId.length > 0 ? rawId : undefined;

  if (id === undefined) {
    return [
      errorFrame(db, "bad_frame", "rpc frame missing non-empty string `id`"),
    ];
  }

  if (typeof frame.method !== "string" || frame.method.length === 0) {
    return [
      errorFrame(
        db,
        "bad_frame",
        "rpc frame missing non-empty string `method`",
        id,
      ),
    ];
  }

  const handler = RPC_REGISTRY.get(frame.method);
  if (!handler) {
    return [
      errorFrame(
        db,
        "unknown_method",
        `no such rpc method: ${frame.method}`,
        id,
      ),
    ];
  }

  // Run the handler against the WRITER connection — the server's reader is
  // read-only and will reject INSERTs. Tests may pass `writerDb === undefined`
  // for read-only handlers (in which case we hand the handler the reader,
  // which is enough for a no-op).
  const handlerDb = writerDb ?? db;

  let value: unknown;
  try {
    value = handler(handlerDb, frame.params);
  } catch (err) {
    if (err instanceof BadParamsError) {
      return [errorFrame(db, "bad_params", err.message, id)];
    }
    const message = err instanceof Error ? err.message : String(err);
    return [errorFrame(db, "rpc_failed", message, id)];
  }

  const result: RpcResultFrame = {
    type: "rpc_result",
    id,
    rev: readWorldRev(db),
    value,
  };
  return [result];
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
// Realtime poll → diff → patch
// ---------------------------------------------------------------------------

/**
 * Read the singleton world rev once per tick. Same shape as `readWorldRev` but
 * named for the poll path so the call site reads as "rev stamped on this
 * tick's frames".
 */
function readWorldRevOnce(db: Database): number {
  return readWorldRev(db);
}

/**
 * Compute the union of watched ids across a set of connections (all of which
 * share one collection). The poll loop does ONE shared `selectByIds(union)`
 * re-read per collection group per tick, then fans the rows out — so N
 * connections watching overlapping pages cost one query, not N.
 */
function unionWatched(conns: Iterable<Writable>): string[] {
  const union = new Set<string>();
  for (const sock of conns) {
    for (const id of sock.data.watched) {
      union.add(id);
    }
  }
  return [...union];
}

/**
 * Run ONE realtime tick across all connections.
 *
 * 1. Read world rev once → the GLOBAL reducer cursor stamped on every `patch`
 *    emitted this tick. Distinct from the per-row `version` column the diff
 *    fires on (for jobs both happen to be `last_event_id`; do not conflate).
 * 2. Group connections by active collection (skip `null`-collection conns).
 * 3. Per group: read the union of watched ids once via `selectByIds` and index
 *    by the descriptor's pk.
 * 4. For each connection, for each watched id: push a `patch {collection, rev,
 *    row}` ONLY when `row[descriptor.version] > lastSent[id]`, then bump
 *    `lastSent`. No patch when equal — the diff is state-based, so multiple
 *    folds between ticks collapse to one push (coalescing, no event queue).
 * 5. SECOND pass — membership staleness. Group the live (non-null collection,
 *    non-null `where`) connections by filter signature `[collection, clause,
 *    params]`, run ONE `countAndToken` per distinct signature (mirroring the
 *    one-`selectByIds`-per-collection sharing above), and fan `{total, token}`
 *    out: emit a `meta` frame to each conn whose `total` or `token` moved since
 *    its last, then advance `lastTotal`/`lastToken`. This is the count signal —
 *    NOT a membership stream; the changed rows are never sent (frozen page).
 *
 * Backpressure: a connection with a pending (backpressured) write is SKIPPED
 * for the tick — never blocking fan-out to other connections, and crucially
 * `lastSent` (patch pass) and `lastTotal`/`lastToken` (meta pass) are NOT
 * advanced for a skipped conn, so the next tick re-reflects current state and
 * nothing is lost.
 *
 * Reads the collection table only (never `events`). The self-correcting race —
 * a poll landing after a hook `events` INSERT but before the reducer folds —
 * sees no projection change; the fold is itself a commit that re-bumps
 * `data_version`, so the next poll catches it.
 *
 * Exported so the loop can be driven directly in tests without a real socket.
 */
export function diffTick(db: Database, conns: Iterable<Writable>): void {
  const list = [...conns];
  if (list.length === 0) {
    return;
  }

  // Group connections by their active collection; null-collection conns (no
  // live subscription) are never visited.
  const byCollection = new Map<string, Writable[]>();
  for (const sock of list) {
    const name = sock.data.collection;
    if (name === null) {
      continue;
    }
    const group = byCollection.get(name);
    if (group) {
      group.push(sock);
    } else {
      byCollection.set(name, [sock]);
    }
  }
  if (byCollection.size === 0) {
    return;
  }

  const rev = readWorldRevOnce(db);

  for (const [name, group] of byCollection) {
    const descriptor = getCollection(name);
    if (!descriptor) {
      // A subscription whose collection vanished from the registry (shouldn't
      // happen — the registry is static): nothing to diff.
      continue;
    }
    const ids = unionWatched(group);
    if (ids.length === 0) {
      continue;
    }
    const rows = selectByIds(db, descriptor, ids);
    // Index by the descriptor's pk for per-connection fan-out.
    const byId = new Map<string, Row>();
    for (const row of rows) {
      byId.set(String(row[descriptor.pk]), row);
    }

    for (const sock of group) {
      // Slow consumer: a still-pending write means this socket is
      // backpressured. Skip it (don't advance lastSent); the next tick re-diffs.
      if (sock.data.pending) {
        continue;
      }
      const patches: PatchFrame[] = [];
      for (const id of sock.data.watched) {
        const row = byId.get(id);
        if (!row) {
          // The row vanished (rows are never deleted in v1, but stay
          // defensive): nothing to diff, leave lastSent untouched.
          continue;
        }
        const version = row[descriptor.version] as number | null;
        const last = sock.data.lastSent.get(id) ?? -1;
        if (version !== null && version > last) {
          patches.push({ type: "patch", collection: name, rev, row });
          sock.data.lastSent.set(id, version);
        }
      }
      if (patches.length > 0) {
        writeFrames(sock, patches);
      }
    }
  }

  // Second pass: membership-staleness `meta`. Group the live connections (a
  // non-null collection AND a resolved `where`) by filter signature so two
  // conns paging/sorting the same filter share ONE countAndToken; signature
  // folds in the bound params (so state=working vs state=stopped don't share)
  // and excludes sort/limit/offset (so different pages of one filter do share).
  const byFilter = new Map<
    string,
    {
      descriptor: CollectionDescriptor;
      where: ResolvedFilter;
      conns: Writable[];
    }
  >();
  for (const sock of list) {
    const name = sock.data.collection;
    const where = sock.data.where;
    if (name === null || where === null) {
      continue;
    }
    const descriptor = getCollection(name);
    if (!descriptor) {
      continue;
    }
    const sig = JSON.stringify([name, where.clause, where.params]);
    const group = byFilter.get(sig);
    if (group) {
      group.conns.push(sock);
    } else {
      byFilter.set(sig, { descriptor, where, conns: [sock] });
    }
  }

  for (const { descriptor, where, conns } of byFilter.values()) {
    const { total, token } = countAndToken(
      db,
      descriptor,
      where.clause,
      where.params,
    );
    for (const sock of conns) {
      // Backpressure: skip a pending conn WITHOUT advancing its baseline, so
      // the signal re-fires next tick (mirrors the patch pass).
      if (sock.data.pending) {
        continue;
      }
      if (total !== sock.data.lastTotal || token !== sock.data.lastToken) {
        writeFrames(sock, [
          { type: "meta", collection: descriptor.name, rev, total },
        ]);
        sock.data.lastTotal = total;
        sock.data.lastToken = token;
      }
    }
  }
}

/**
 * Realtime poll loop. Polls `PRAGMA data_version` every `pollMs`; on any change
 * from the last seen value, runs `diffTick` against the live connection set.
 *
 * CRITICAL: the poll connection stays in autocommit — NO surrounding `BEGIN`,
 * or `data_version` freezes for this connection and we go blind to new commits.
 * `getConns` is called per tick so connections opened/closed mid-loop are
 * picked up. Resolves once `isShutdown()` returns true.
 *
 * Exported alongside `diffTick` so the worker `main` wires it and tests can run
 * it against a real two-connection DB.
 */
export async function pollLoop(
  db: Database,
  getConns: () => Iterable<Writable>,
  isShutdown: () => boolean,
  pollMs: number = DEFAULT_POLL_MS,
): Promise<void> {
  const interval = Math.max(MIN_POLL_MS, pollMs);
  // Naked autocommit read — no BEGIN, or the counter freezes for this conn.
  const query = db.query("PRAGMA data_version");
  let last = (query.get() as { data_version: number }).data_version;

  while (!isShutdown()) {
    const _sleepStart = Date.now();
    await Bun.sleep(interval);
    const _sleepActual = Date.now() - _sleepStart;
    if (_sleepActual > interval + 100) {
      // The event loop didn't wake us on time — something held it. Likely the
      // smoking gun for the "epics frame takes 5s" bug.
      if (TRACE)
        srvTs(
          `poll-loop sleep overrun: requested=${interval}ms actual=${_sleepActual}ms`,
        );
    }
    if (isShutdown()) {
      break;
    }
    const cur = (query.get() as { data_version: number }).data_version;
    if (cur !== last) {
      last = cur;
      const _tickStart = Date.now();
      diffTick(db, getConns());
      const _tickDur = Date.now() - _tickStart;
      if (_tickDur >= 20) {
        if (TRACE) srvTs(`poll-loop diffTick duration=${_tickDur}ms`);
      }
    }
  }
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
  /**
   * The live connection set. The realtime `pollLoop` reads this each tick so
   * connections opened/closed mid-loop are picked up; entries are `Writable`
   * (each carries its `ConnState` on `.data`) so `diffTick` / `writeFrames`
   * compose without a real-socket shim.
   */
  conns: Set<Writable>;
  stop(): void;
}

/**
 * Acquire the lock, unlink any stale socket, bind the UDS, and wire the NDJSON
 * dispatch handlers. Returns a `RunningServer`. The caller owns calling
 * `stop()` on shutdown (the worker `main` and tests both do).
 *
 * Two DB connections cross in here: `db` is the read-only reader (powers
 * `query` / `result` / `patch` / `meta` and `data_version` polling — MUST
 * stay autocommit per the pollLoop contract). `writerDb` is the writer-mode
 * connection RPC handlers write through; the reader's `data_version` poll
 * sees the writer's commits because the two are distinct connections (a same-
 * connection write does not bump `data_version`). The lifetime of both
 * connections belongs to the caller (`main()` opens and closes them); this
 * function only forwards `writerDb` into the dispatch path.
 *
 * Throws `LockHeldError` if a live instance owns the lock — the caller exits
 * non-zero.
 */
export function startServer(
  db: Database,
  sockPath: string,
  lockPath: string,
  writerDb?: Database,
): RunningServer {
  acquireLock(lockPath, sockPath);

  // AF_UNIX has no SO_REUSEADDR: a leftover socket file → EADDRINUSE. The lock
  // is already ours, so unlinking here can't race another instance.
  unlinkIfExists(sockPath);

  // Live connection registry. The realtime pollLoop iterates this each tick;
  // open() adds, close() removes. Entries are the sockets themselves (typed as
  // Writable so diffTick/writeFrames compose).
  const conns = new Set<Writable>();

  const listener = Bun.listen<ConnState>({
    unix: sockPath,
    socket: {
      open(socket) {
        socket.data = newConnState();
        socket.data.id = ++__nextConnId;
        conns.add(socket as unknown as Writable);
        if (TRACE) srvTs(`conn ${socket.data.id} open`);
      },
      data(socket, chunk) {
        const id = socket.data.id ?? -1;
        if (TRACE) srvTs(`conn ${id} data chunk=${chunk.length}`);
        const t0 = Date.now();
        handleData(db, socket, chunk, writerDb);
        const dur = Date.now() - t0;
        if (dur >= 5) {
          if (TRACE) srvTs(`conn ${id} handleData duration=${dur}ms`);
        }
      },
      drain(socket) {
        resumePending(socket as unknown as Writable);
      },
      close(socket) {
        if (TRACE) srvTs(`conn ${socket.data.id ?? -1} close`);
        // Drop the connection from the fan-out set, then release per-connection
        // state; nothing process-global to release here.
        conns.delete(socket as unknown as Writable);
        socket.data.pending = null;
        socket.data.collection = null;
        socket.data.watched.clear();
        socket.data.lastSent.clear();
        socket.data.where = null;
        socket.data.lastTotal = null;
        socket.data.lastToken = null;
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
    conns,
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
  writerDb?: Database,
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
    // DEBUG: time each dispatchLine so we can spot a slow query / RPC.
    const _dispatchStart = Date.now();
    let _frameType = "unknown";
    let _collection: string | undefined;
    try {
      const parsed = JSON.parse(line) as {
        type?: unknown;
        collection?: unknown;
      };
      if (typeof parsed.type === "string") _frameType = parsed.type;
      if (typeof parsed.collection === "string")
        _collection = parsed.collection;
    } catch {
      // dispatchLine itself will surface the bad_frame; just log unknown.
    }
    try {
      frames = dispatchLine(db, socket.data, line, writerDb);
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
    const _dispatchDur = Date.now() - _dispatchStart;
    const _id = socket.data.id ?? -1;
    const _collTag = _collection ? ` coll=${_collection}` : "";
    if (_frameType === "query" || _dispatchDur >= 5) {
      if (TRACE)
        srvTs(
          `conn ${_id} dispatch type=${_frameType}${_collTag} duration=${_dispatchDur}ms frames=${frames.length}`,
        );
    }
    if (frames.length > 0) {
      const _writeStart = Date.now();
      writeFrames(w, frames);
      const _writeDur = Date.now() - _writeStart;
      if (_writeDur >= 5) {
        if (TRACE) srvTs(`conn ${_id} writeFrames duration=${_writeDur}ms`);
      }
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

  // Two connections per worker:
  //   - `db` (read-only): backs `query` / `result` / `patch` / `meta` and the
  //     `data_version` poll loop. MUST stay autocommit — a `BEGIN` here freezes
  //     `data_version` for the connection and the poll goes blind.
  //   - `writerDb` (writer mode): the RPC handler write surface. Distinct
  //     connection so the reader's `data_version` poll sees the writer's
  //     commits (a same-connection write does not bump the counter). Goes
  //     through `applyPragmas` like every keeper open (`busy_timeout=5000`
  //     etc), so RPC writes block politely on hook + reducer + planctl-files
  //     writers instead of erroring `SQLITE_BUSY`.
  const { db } = openDb(data.dbPath, { readonly: true });
  const { db: writerDb } = openDb(data.dbPath);

  // Install every concrete RPC handler into `RPC_REGISTRY`. Side-effect import:
  // a plain `import` of `src/server-worker.ts` from main/test code is inert
  // (the `isMainThread` guard skips `main()`), so the registry only fills
  // inside a real worker spawn. Concrete handlers live in
  // `src/rpc-handlers.ts`; this is the single install point.
  installRpcHandlers();

  let server: RunningServer;
  try {
    server = startServer(db, sockPath, lockPath, writerDb);
  } catch (err) {
    // Lock held by a live instance, or bind failed. No self-heal — exit
    // non-zero; launchd backs off and the live owner keeps serving.
    console.error("[server-worker] failed to start:", err);
    try {
      db.close();
    } catch {
      // ignore
    }
    try {
      writerDb.close();
    } catch {
      // ignore
    }
    process.exit(1);
  }

  let stopping = false;

  const shutdown = (): void => {
    stopping = true; // resolves the poll loop on its next iteration check
    server.stop();
    try {
      db.close();
    } catch {
      // best-effort; exiting either way
    }
    try {
      writerDb.close();
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

  // Realtime layer: poll data_version and fan committed jobs changes out as
  // per-entity patches. Runs on the worker's own read-only connection (the same
  // one serving queries — both are autocommit reads, safe to share). A crash in
  // the loop is unrecoverable: no self-heal, exit non-zero → LaunchAgent
  // restart.
  pollLoop(
    db,
    () => server.conns,
    () => stopping,
    data.pollMs,
  ).catch((err) => {
    console.error("[server-worker] poll loop crashed:", err);
    try {
      server.stop();
    } catch {
      // best-effort
    }
    process.exit(1);
  });

  parentPort.postMessage({ kind: "ready" } satisfies ReadyMessage);
}

// Only run inside a real Worker; a plain import on the main thread is inert.
if (!isMainThread) {
  main();
}

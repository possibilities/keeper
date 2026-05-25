/**
 * Shared subscribe client + readiness handoff for the three keeper collections
 * (`epics`, `jobs`, `subagent_invocations`). One imperative API: callers pass
 * a snapshot callback and get back a `dispose()` handle. The helper owns the
 * connection lifecycle (capped-backoff reconnect, post-disconnect re-handshake,
 * per-collection coalesce, steady-poll backstop) plus the all-three-strict
 * first-paint gate and the per-frame `computeReadiness` call; callers do
 * rendering and side effects on top.
 *
 * Identity / scope. The helper is for clients that consume the FULL readiness
 * snapshot — both `scripts/board.ts` (renders a frame) and `scripts/autopilot.ts`
 * (renders a two-block command list, where the second block is gated by
 * verdict). A single-collection client like `scripts/git.ts` is OUT OF SCOPE;
 * it owns three columns of its own and doesn't need this orchestration.
 *
 * Why callback + dispose, not async iterator. Async generators bring two
 * pitfalls for this workload: (a) cancellation requires consumers to call
 * `.return()` correctly, which is easy to miss on SIGINT; (b) recursive
 * `yield*` for reconnect creates per-reconnect frames on the stack. Both
 * consumers want imperative push semantics — a callback fires when a new
 * snapshot is ready, and `dispose()` is the only way out.
 *
 * Why `state.rows` (not `byId.values()`) for `subagent_invocations`. The
 * descriptor exposes `job_id` as the wire pk even though the SQL composite
 * identity is `(job_id, agent_id, turn_seq)`. Two re-entrant sub-agents
 * sharing one `job_id` must BOTH reach `computeReadiness` so predicate 6
 * (`own-progress-sub`) doesn't false-negative. `byId` collapses them
 * last-write-wins; `rows` carries the full wire-order stream. This is the
 * load-bearing invariant covered by `test/board.test.ts`'s regression.
 *
 * Lifecycle contract:
 *   - All-three-strict first-paint gate. No `onSnapshot` fires until epics +
 *     jobs + subagent_invocations have EACH produced their first `result`.
 *     A partial snapshot would compute readiness against a wrong-state input.
 *   - Capped-backoff reconnect: 250 ms → 5000 ms doubling per attempt; resets
 *     on a successful connection.
 *   - Steady-poll backstop (500 ms) refetches all three collections each tick,
 *     coalesced per collection via `queryInFlight` / `refetchDirty`.
 *   - On teardown (disconnect or `dispose`): reset `state.rows`, `state.byId`,
 *     `state.order`, AND `gotResult = false` for all three. The `gotResult`
 *     reset is what board.ts has and autopilot.ts's previous standalone code
 *     was missing — centralized here so both consumers inherit the correct
 *     behavior.
 *   - `dispose()` is idempotent: pre-first-paint bails clean (no callback
 *     fires); during reconnect backoff cancels the pending timer and marks
 *     `shuttingDown`; called twice is a no-op.
 *   - `onSnapshot` exceptions are NOT swallowed — they propagate up to the
 *     caller's I/O frame. Matches keeper's "no in-process self-heal" stance
 *     and matches today's `emitFrameIfChanged`, which has no try/catch.
 *   - SIGINT remains the CALLER's concern; the helper exposes `dispose()`
 *     and the caller wires its own signal handler (so each script's
 *     SIGINT-prints stay per-script).
 */

import {
  encodeFrame,
  LineBuffer,
  type QueryFrame,
  type ServerFrame,
} from "./protocol";
import { computeReadiness, type ReadinessSnapshot } from "./readiness";
import type { Epic, Job, SubagentInvocation } from "./types";

// ---------------------------------------------------------------------------
// Tuning constants — same values the prior board.ts standalone code used.
// ---------------------------------------------------------------------------

const JOBS_PAGE_LIMIT = 10;
const EPICS_PAGE_LIMIT = 0;
const SUBAGENT_INVOCATIONS_PAGE_LIMIT = 0;
const POLL_MS = 500;
const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Snapshot delivered to `onSnapshot` once per emit. `subagentInvocations` is
 * the FLAT `SubagentInvocation[]` projected from `state.rows`, NOT
 * `byId.values()` — see module docstring for the predicate-6 reasoning.
 * `jobs` is a `Map<job_id, Job>` because board's renderer indexes by id for
 * the per-epic `job_links` lookup; autopilot can ignore the map and read
 * only `epics` if it wants to.
 */
export interface ReadinessClientSnapshot {
  readonly epics: Epic[];
  readonly jobs: Map<string, Job>;
  readonly subagentInvocations: SubagentInvocation[];
  readonly readiness: ReadinessSnapshot;
}

/**
 * Fatal-error payload handed to `onFatal` when a terminal `error` frame
 * arrives BEFORE any collection has produced its first `result` (i.e. the
 * query itself is malformed — `bad_frame` / `unknown_collection`). `rev`
 * is the wire-level world-rev when known (the protocol may omit it on
 * pre-handshake errors). The shape is what `onLifecycle` already receives
 * for the same frame; `onFatal` exists so callers can act on the
 * terminal condition instead of just observing it.
 */
export interface FatalError {
  readonly code: string;
  readonly rev?: number;
  readonly message: string;
}

/**
 * Minimal socket shape the helper drives. Matches the surface area of
 * `Bun.Socket` that `subscribeReadiness` touches — `write` to push frames,
 * `end` to half-close. Surfaced as a named type so the test-injection
 * `connect` factory can return a mock without depending on `bun:types`.
 */
export interface ReadinessSocket {
  write(data: string): void;
  end(): void;
}

/**
 * Socket factory injected via `connect`. The helper hands the factory a
 * `handlers` bag carrying `data` / `close` / `error` callbacks; the factory
 * returns the live socket (or rejects, kicking the reconnect-backoff loop).
 * In production this wraps `Bun.connect({ unix, socket })`; in tests, the
 * mock implementation hands the helper a controllable socket that records
 * writes and exposes the handlers for direct frame delivery.
 */
export interface SocketHandlers {
  open(sock: ReadinessSocket): void;
  data(sock: ReadinessSocket, chunk: Buffer): void;
  close(): void;
  error(sock: ReadinessSocket, err: Error): void;
}

export type ConnectFactory = (
  sockPath: string,
  handlers: SocketHandlers,
) => Promise<ReadinessSocket>;

/**
 * Subscribe options. `idPrefix` is appended with the collection name so
 * subscription IDs become `<prefix>-epics` / `<prefix>-jobs` /
 * `<prefix>-subagent-invocations`. The server doesn't enforce uniqueness
 * across connections; the prefix is purely a debug-log discriminator.
 *
 * `onFatal` is called when a terminal `error` frame arrives BEFORE any
 * collection has produced a first `result` — the query itself is
 * unrecoverable and a reconnect cannot fix it. When omitted, the helper
 * defaults to `process.exit(1)` (matching the pre-extraction behavior at
 * `scripts/board.ts:870`, commit `212be34^`). Callers that want
 * non-process-exit semantics (e.g. tests, in-process consumers) pass a
 * custom `onFatal`. The terminal error is also surfaced via `onLifecycle`
 * with the same payload immediately before `onFatal` fires.
 *
 * `connect` is the socket factory used to open a connection — exposed
 * only for test injection. Defaults to a thin wrapper around
 * `Bun.connect({ unix, socket })`; production callers should never set
 * this. Tests use it to substitute an in-memory mock that records
 * outbound frames and delivers inbound frames synchronously.
 */
export interface SubscribeOptions {
  readonly sockPath: string;
  readonly idPrefix: string;
  readonly onSnapshot: (snap: ReadinessClientSnapshot) => void;
  readonly onLifecycle?: (
    event: string,
    detail?: Record<string, unknown>,
  ) => void;
  readonly onFatal?: (err: FatalError) => void;
  readonly connect?: ConnectFactory;
}

/**
 * Caller-facing handle. `dispose()` is idempotent — safe to call from a
 * SIGINT handler that may also be reached via a normal exit path.
 */
export interface ReadinessClientHandle {
  dispose(): void;
}

/**
 * Per-collection page + coalescing state. INTERNAL to this module — the
 * helper deliberately does NOT export `CollectionState` because the public
 * API surface should not leak the internal shape (callers consume the
 * projected snapshot, not the raw `byId` / `order` machinery).
 *
 * `rows` carries the full wire-order stream from the most recent `result`
 * frame. `byId` keys on the wire pk (`epic_id` / `job_id`) and collapses
 * duplicates last-write-wins. For collections whose SQL identity matches
 * the wire pk (`epics`, `jobs`) the two views are equivalent; for
 * `subagent_invocations` they diverge — see the module docstring.
 */
interface CollectionState {
  readonly collection: string;
  readonly subId: string;
  readonly pk: string;
  readonly query: QueryFrame;
  order: string[];
  byId: Map<string, Record<string, unknown>>;
  rows: unknown[];
  gotResult: boolean;
  queryInFlight: boolean;
  refetchDirty: boolean;
}

function makeState(
  collection: string,
  subId: string,
  pk: string,
  limit: number,
): CollectionState {
  return {
    collection,
    subId,
    pk,
    query: { type: "query", collection, id: subId, limit },
    order: [],
    byId: new Map(),
    rows: [],
    gotResult: false,
    queryInFlight: false,
    refetchDirty: false,
  };
}

/**
 * Pure helper — project a collection state into the typed row stream the
 * readiness pipeline expects. Uses `state.rows` (not `byId.values()`) so
 * collections with a composite SQL identity but a single-column wire pk
 * (today: `subagent_invocations`, pk `job_id`, identity
 * `(job_id, agent_id, turn_seq)`) deliver every received row, not just
 * the last-write-wins one per pk value. Exported for the regression test
 * in `test/board.test.ts`.
 */
export function projectRows<T>(state: { rows: readonly unknown[] }): T[] {
  // The descriptors guarantee the row shape matches the typed projection
  // (the server-side `decodeRow` materialises it); this cast is the same
  // shape-trust the readiness handoff already makes. The input type is
  // intentionally permissive (`readonly unknown[]`) so the regression
  // test can hand in a `{ rows: T[] }` literal without an upcast to
  // `Record<string, unknown>[]`.
  return state.rows as unknown as T[];
}

/**
 * Open a subscription to all three readiness collections on a single
 * connection and invoke `onSnapshot` once per emit (after the all-three
 * gate clears). Returns a handle whose `dispose()` tears down the
 * connection, cancels any pending reconnect timer, and releases the
 * steady-poll interval.
 */
export function subscribeReadiness(
  opts: SubscribeOptions,
): ReadinessClientHandle {
  const { sockPath, idPrefix, onSnapshot, onLifecycle } = opts;
  // Default `onFatal` restores the pre-extraction `process.exit(1)`
  // behavior (`scripts/board.ts:870`, commit `212be34^`). Callers that
  // want different semantics pass their own; tests always pass a custom
  // one so the test process never exits.
  const onFatal =
    opts.onFatal ??
    ((_err: FatalError): void => {
      process.exit(1);
    });
  // Default `connect` factory wraps `Bun.connect`. Production callers
  // never override this; tests inject an in-memory mock socket. The
  // factory adapts `Bun.connect`'s socket-handler shape to the more
  // minimal `SocketHandlers` interface so callers (tests) don't depend
  // on `bun:types`.
  const connect: ConnectFactory =
    opts.connect ??
    ((path, handlers) =>
      Bun.connect({
        unix: path,
        socket: {
          open(sock) {
            handlers.open(sock as ReadinessSocket);
          },
          data(sock, chunk) {
            handlers.data(sock as ReadinessSocket, chunk);
          },
          close() {
            handlers.close();
          },
          error(sock, err) {
            handlers.error(sock as ReadinessSocket, err);
          },
        },
      }) as unknown as Promise<ReadinessSocket>);

  const epics = makeState(
    "epics",
    `${idPrefix}-epics`,
    "epic_id",
    EPICS_PAGE_LIMIT,
  );
  const jobs = makeState("jobs", `${idPrefix}-jobs`, "job_id", JOBS_PAGE_LIMIT);
  // The `subagent_invocations` descriptor exposes `job_id` as the wire pk
  // even though the SQL identity is composite `(job_id, agent_id,
  // turn_seq)` — see `src/collections.ts:SUBAGENT_INVOCATIONS_DESCRIPTOR`.
  // `byId` collapses re-entrant sub-agents in one session (multiple rows
  // sharing one `job_id`) to last-write-wins, so the readiness handoff
  // reads from `state.rows` instead — every received invocation reaches
  // `computeReadiness` so predicate 6 (`own-progress-sub`) sees every
  // `running` sub. Page limit 0 streams the full default scope — same
  // scope-is-board reasoning as epics.
  const subagentInvocations = makeState(
    "subagent_invocations",
    `${idPrefix}-subagent-invocations`,
    "job_id",
    SUBAGENT_INVOCATIONS_PAGE_LIMIT,
  );
  const states: CollectionState[] = [epics, jobs, subagentInvocations];
  const byCollection = new Map(states.map((s) => [s.collection, s]));

  let currentSock: ReadinessSocket | null = null;
  let attempt = 0;
  let shuttingDown = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Resolves on the pending `await Bun.sleep(...)` so `dispose()` during
  // backoff doesn't leak the timer. Use `setTimeout` directly (not
  // `Bun.sleep`) so we can `clearTimeout` from `dispose()`.
  let sleepResolve: (() => void) | null = null;

  function emit(event: string, detail?: Record<string, unknown>): void {
    onLifecycle?.(event, detail);
  }

  function emitSnapshot(): void {
    if (!epics.gotResult || !jobs.gotResult || !subagentInvocations.gotResult) {
      return;
    }
    // Cast: the wire delivers each row as `Record<string, unknown>`; the
    // descriptors guarantee the shape matches the typed projection
    // (decoded by `decodeRow` on the server side).
    const epicsTyped = epics.order.map(
      (id) => (epics.byId.get(id) ?? { [epics.pk]: id }) as unknown as Epic,
    );
    const jobsTyped = new Map<string, Job>();
    for (const [id, row] of jobs.byId) {
      jobsTyped.set(id, row as unknown as Job);
    }
    // Read from `state.rows` (not `byId.values()`) — see module docstring.
    const subsTyped = projectRows<SubagentInvocation>(subagentInvocations);
    const readiness = computeReadiness(epicsTyped, jobsTyped, subsTyped);
    // Exceptions from `onSnapshot` propagate. This matches keeper's
    // "no in-process self-heal" stance and the prior board.ts code path,
    // which had no try/catch around its emit either.
    onSnapshot({
      epics: epicsTyped,
      jobs: jobsTyped,
      subagentInvocations: subsTyped,
      readiness,
    });
  }

  function scheduleRefetchFor(state: CollectionState): void {
    if (shuttingDown || !currentSock) {
      return;
    }
    if (state.queryInFlight) {
      state.refetchDirty = true;
      return;
    }
    state.queryInFlight = true;
    currentSock.write(encodeFrame(state.query));
  }

  function pollAll(): void {
    for (const s of states) {
      scheduleRefetchFor(s);
    }
  }

  function handleFrame(frame: ServerFrame): void {
    if (frame.type === "result") {
      const state = byCollection.get(frame.collection);
      if (!state) {
        // A `result` for a collection we don't track — defensive; should
        // never happen on a connection we opened ourselves.
        return;
      }
      state.queryInFlight = false;
      state.order.length = 0;
      state.byId.clear();
      // Re-snapshot `rows` from this frame — see module docstring on why
      // the readiness handoff reads from here.
      state.rows = frame.rows.slice();
      for (const row of frame.rows) {
        const id = String(row[state.pk]);
        state.order.push(id);
        state.byId.set(id, row);
      }
      state.gotResult = true;
      emitSnapshot();
      if (state.refetchDirty) {
        state.refetchDirty = false;
        scheduleRefetchFor(state);
      }
    } else if (frame.type === "patch" || frame.type === "meta") {
      const state = byCollection.get(frame.collection);
      if (state) {
        scheduleRefetchFor(state);
      }
    } else if (frame.type === "error") {
      const detail = {
        code: frame.code,
        rev: frame.rev,
        message: frame.message,
      };
      emit("error", detail);
      // A bad_frame / unknown_collection on our own query is terminal — a
      // reconnect can't fix a malformed query. Terminal iff NO collection
      // has produced a first result (with three collections, that means
      // all three failed); otherwise the error is likely transient and
      // the next refetch will recover.
      if (
        !epics.gotResult &&
        !jobs.gotResult &&
        !subagentInvocations.gotResult
      ) {
        shuttingDown = true;
        try {
          currentSock?.end();
        } catch {
          // already torn down
        }
        // Hand the terminal error off to the caller (default:
        // `process.exit(1)`) AFTER tearing the connection down, so a
        // custom `onFatal` that throws or schedules work observes the
        // helper in its fully-shut-down state. `onFatal` exceptions
        // propagate — same no-self-heal contract as `onSnapshot`.
        onFatal({
          code: frame.code,
          rev: frame.rev,
          message: frame.message,
        });
      }
    }
  }

  function teardownConnection(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    currentSock = null;
    for (const s of states) {
      s.order.length = 0;
      s.byId.clear();
      s.rows.length = 0;
      s.queryInFlight = false;
      s.refetchDirty = false;
      s.gotResult = false;
    }
  }

  async function connectOnce(): Promise<void> {
    const buffer = new LineBuffer();
    await connect(sockPath, {
      open(sock) {
        attempt = 0;
        currentSock = sock;
        emit("connected", { sock: sockPath });
        // Send all three queries up front. Each collection's
        // `queryInFlight` tracks its own send so the poll/refetch
        // coalescer stays sane.
        for (const s of states) {
          s.queryInFlight = true;
          sock.write(encodeFrame(s.query));
        }
        pollTimer = setInterval(pollAll, POLL_MS);
      },
      data(sock, chunk) {
        let lines: string[];
        try {
          lines = buffer.push(chunk.toString("utf8"));
        } catch (err) {
          // A protocol-frame parse failure is fatal for this connection
          // but not for the caller's process — surface via lifecycle
          // and tear down. The reconnect loop will try again.
          emit("error", { message: (err as Error).message });
          try {
            sock.end();
          } catch {
            // ignore
          }
          return;
        }
        for (const line of lines) {
          if (line.trim().length === 0) {
            continue;
          }
          handleFrame(JSON.parse(line) as ServerFrame);
        }
      },
      close() {
        if (shuttingDown) {
          return;
        }
        teardownConnection();
        emit("disconnected");
        void connectWithRetry();
      },
      error(_sock, err) {
        emit("error", { message: err.message });
      },
    });
  }

  async function connectWithRetry(): Promise<void> {
    emit("connecting", { sock: sockPath });
    while (!shuttingDown) {
      try {
        await connectOnce();
        return;
      } catch (err) {
        if (shuttingDown) {
          return;
        }
        attempt += 1;
        const delay = Math.min(
          INITIAL_BACKOFF_MS * 2 ** (attempt - 1),
          MAX_BACKOFF_MS,
        );
        emit("waiting", {
          attempt,
          retry_in_ms: delay,
          reason: (err as Error).message,
        });
        // Use a directly-cancellable timeout so `dispose()` during backoff
        // doesn't leak the timer. `Bun.sleep` returns a Promise we can't
        // resolve from outside.
        await new Promise<void>((resolve) => {
          sleepResolve = resolve;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            sleepResolve = null;
            resolve();
          }, delay);
        });
      }
    }
  }

  // Boot the reconnect loop. Caller does not await — they consume snapshots
  // via the callback and rely on `dispose()` for shutdown.
  void connectWithRetry();

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      shuttingDown = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        // Resolve the pending sleep promise so `connectWithRetry`'s loop
        // observes `shuttingDown` and exits cleanly.
        sleepResolve?.();
        sleepResolve = null;
      }
      try {
        // No `id` → drop every subscription on this connection in one frame.
        if (currentSock != null) {
          currentSock.write(encodeFrame({ type: "unsubscribe" }));
          currentSock.end();
        }
      } catch {
        // socket already gone — nothing to release
      }
      currentSock = null;
    },
  };
}

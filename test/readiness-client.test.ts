/**
 * Lifecycle tests for `src/readiness-client.ts`'s `subscribeReadiness`
 * helper. Driven by an in-memory mock socket injected via the
 * `connect` option — no UDS, no daemon, no `Bun.connect` wire calls.
 * The mock records outbound frames (so we can assert the helper's
 * query/refetch behavior) and exposes the `data` handler so the test
 * can deliver inbound `ServerFrame`s synchronously, byte-identical
 * to the wire format the real server worker emits.
 *
 * Why a mock socket (not a real socket)
 * -------------------------------------
 * The helper's load-bearing invariants are sequencing — the
 * all-three-strict first-paint gate, the per-collection coalesce
 * (`queryInFlight` / `refetchDirty`), the idempotent `dispose()`,
 * and the terminal-error → `onFatal` propagation. These are pure
 * orchestration around frame I/O; a real socket forces the test to
 * boot the daemon for facts unrelated to the helper itself
 * (`test/integration.test.ts` already covers that path end-to-end).
 *
 * Mock contract: `connectMock` returns a `MockSocket` whose `write`
 * pushes onto an `outbound` array, whose `end` flips a flag, and which
 * exposes the helper's `data` / `close` / `error` handlers so the test
 * can synthesise frames mid-test. `open` fires synchronously inside
 * `connect` so the helper sends its three initial queries before
 * `subscribeReadiness` returns the handle — assertions on `outbound`
 * can run immediately.
 *
 * Coverage (per `fn-609.1` acceptance):
 *   (a) first-paint gate — `onSnapshot` does not fire until all three
 *       collections produce a `result`.
 *   (b) per-collection coalesce — a refetch nudge fired while
 *       `queryInFlight` sets `refetchDirty` and a single follow-up
 *       query goes out after the next `result` resolves it.
 *   (c) idempotent `dispose()` — second call is a no-op; no callback
 *       fires.
 *   (d) terminal `error` frame with no `gotResult` invokes `onFatal`
 *       with the error payload (and `onLifecycle` sees the same).
 *
 * The default `onFatal` (which calls `process.exit(1)`) is asserted
 * separately by NOT passing one in (d) and confirming the helper does
 * call the override we wire instead — the contract is "default is
 * `process.exit(1)` iff `opts.onFatal` is omitted", which the
 * source-side branch (`opts.onFatal ?? (() => process.exit(1))`)
 * encodes directly; testing the default would terminate the test
 * runner.
 */

import { expect, test } from "bun:test";
import { encodeFrame, type ServerFrame } from "../src/protocol";
import {
  type ConnectFactory,
  type FatalError,
  type ReadinessClientSnapshot,
  type ReadinessSocket,
  type SocketHandlers,
  subscribeReadiness,
} from "../src/readiness-client";

// ---------------------------------------------------------------------------
// Mock socket / connect factory
// ---------------------------------------------------------------------------

interface MockSocket extends ReadinessSocket {
  readonly outbound: string[];
  ended: boolean;
  handlers: SocketHandlers;
  /** Deliver one or more newline-terminated frames to the helper's `data`. */
  deliver(frames: ServerFrame[]): void;
  /** Trigger the helper's `close` handler (e.g. simulated disconnect). */
  closeFromServer(): void;
  /** Pop and clear `outbound`; returns the parsed frames in send order. */
  takeOutbound(): unknown[];
}

interface MockConnectResult {
  readonly factory: ConnectFactory;
  readonly socketRef: { current: MockSocket | null };
}

/**
 * Build a `connect` factory that hands the helper a controllable mock
 * socket. `socketRef.current` is populated synchronously inside the
 * factory (and `handlers.open` runs synchronously) so tests can drive
 * the helper without awaiting microtasks for boot.
 *
 * The factory returns a Promise that resolves on `close` (mirroring
 * `Bun.connect`'s "promise resolves when the socket is no longer in
 * use" semantics). This matters for the reconnect loop: a clean close
 * without `shuttingDown` would cause the helper to reconnect; tests
 * that don't want a reconnect either set `shuttingDown` (via
 * `dispose()`) before closing, or just don't trigger `close` at all.
 */
function makeMockConnect(): MockConnectResult {
  const socketRef: { current: MockSocket | null } = { current: null };
  const factory: ConnectFactory = (_path, handlers) => {
    let resolveDone: (() => void) | null = null;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const sock: MockSocket = {
      outbound: [],
      ended: false,
      handlers,
      write(data: string): void {
        sock.outbound.push(data);
      },
      end(): void {
        sock.ended = true;
        // Mimic `Bun.connect`: `end` half-closes; the loop also gets a
        // `close`. We resolve here so the helper's `await connect(...)`
        // in `connectOnce` unblocks, but only fire `close` if the test
        // explicitly asks via `closeFromServer()` — otherwise tests
        // that just call `dispose()` would race the reconnect path.
        resolveDone?.();
        resolveDone = null;
      },
      deliver(frames: ServerFrame[]): void {
        const payload = frames.map(encodeFrame).join("");
        sock.handlers.data(sock, Buffer.from(payload, "utf8"));
      },
      closeFromServer(): void {
        sock.handlers.close();
        resolveDone?.();
        resolveDone = null;
      },
      takeOutbound(): unknown[] {
        const parsed = sock.outbound.map((line) => {
          const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
          return JSON.parse(trimmed);
        });
        sock.outbound.length = 0;
        return parsed;
      },
    };
    socketRef.current = sock;
    // Fire `open` synchronously so the helper sends its three initial
    // queries before `subscribeReadiness` returns. `Bun.connect`'s real
    // semantics resolve after `open` fires; doing it in this order is
    // shape-equivalent for the helper.
    handlers.open(sock);
    return done.then(() => sock);
  };
  return { factory, socketRef };
}

// ---------------------------------------------------------------------------
// Frame builders — minimal `result` / `error` shapes for the three
// readiness collections. Row contents don't matter for the lifecycle
// tests; the helper only inspects the descriptor pk (`epic_id` /
// `job_id`) and the `gotResult` boolean.
// ---------------------------------------------------------------------------

function emptyResult(collection: string, id: string, rev = 1): ServerFrame {
  return {
    type: "result",
    id,
    collection,
    rev,
    total: 0,
    rows: [],
  };
}

function errorFrame(
  code: string,
  message: string,
  rev = 0,
  id?: string,
): ServerFrame {
  return {
    type: "error",
    code,
    message,
    rev,
    ...(id === undefined ? {} : { id }),
  };
}

function metaFrame(collection: string, rev = 2): ServerFrame {
  return {
    type: "meta",
    collection,
    rev,
    total: 0,
  };
}

// ---------------------------------------------------------------------------
// (a) first-paint gate — onSnapshot does not fire until all three
//     collections produce a result.
// ---------------------------------------------------------------------------

test("subscribeReadiness: first-paint gate withholds onSnapshot until all three collections have a result", () => {
  const { factory, socketRef } = makeMockConnect();
  const snapshots: ReadinessClientSnapshot[] = [];
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-paintgate",
    onSnapshot: (snap) => snapshots.push(snap),
    connect: factory,
  });

  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }

  // Three initial queries fired on open — one per collection.
  const initial = sock.takeOutbound();
  expect(initial).toHaveLength(3);
  expect(
    initial.map((f) => (f as { collection: string }).collection).sort(),
  ).toEqual(["epics", "jobs", "subagent_invocations"]);

  // Deliver only `epics` first: gate must hold.
  sock.deliver([emptyResult("epics", "test-paintgate-epics")]);
  expect(snapshots).toHaveLength(0);

  // Add `jobs`: gate still holds (need all three).
  sock.deliver([emptyResult("jobs", "test-paintgate-jobs")]);
  expect(snapshots).toHaveLength(0);

  // Add `subagent_invocations`: gate clears, snapshot fires exactly once.
  sock.deliver([
    emptyResult("subagent_invocations", "test-paintgate-subagent-invocations"),
  ]);
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]?.epics).toEqual([]);
  expect(snapshots[0]?.jobs.size).toBe(0);
  expect(snapshots[0]?.subagentInvocations).toEqual([]);

  handle.dispose();
});

// ---------------------------------------------------------------------------
// (b) per-collection coalesce — a refetch while queryInFlight sets
//     refetchDirty, and exactly one follow-up query goes out on the
//     next result.
// ---------------------------------------------------------------------------

test("subscribeReadiness: refetch fired while queryInFlight is coalesced into one follow-up", () => {
  const { factory, socketRef } = makeMockConnect();
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-coalesce",
    onSnapshot: () => {
      /* ignore — coalesce assertions are wire-level */
    },
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }

  // Discard the three initial queries.
  expect(sock.takeOutbound()).toHaveLength(3);

  // BEFORE the `epics` result resolves the in-flight query, deliver TWO
  // `meta` nudges for `epics` — both should fold into one pending
  // refetch via `refetchDirty`, not two writes.
  sock.deliver([metaFrame("epics", 2)]);
  sock.deliver([metaFrame("epics", 3)]);
  // No writes yet — `queryInFlight` is true from the initial query.
  expect(sock.takeOutbound()).toHaveLength(0);

  // The `epics` `result` lands, clears `queryInFlight`, and triggers
  // exactly ONE follow-up query because `refetchDirty` was set.
  sock.deliver([emptyResult("epics", "test-coalesce-epics")]);
  const follow = sock.takeOutbound();
  expect(follow).toHaveLength(1);
  expect((follow[0] as { collection: string }).collection).toBe("epics");
  expect((follow[0] as { type: string }).type).toBe("query");

  // A second `meta` while THIS refetch is in flight should again
  // coalesce — proving the dirty-flag cycle isn't single-shot.
  sock.deliver([metaFrame("epics", 4)]);
  expect(sock.takeOutbound()).toHaveLength(0);
  sock.deliver([emptyResult("epics", "test-coalesce-epics", 5)]);
  expect(sock.takeOutbound()).toHaveLength(1);

  handle.dispose();
});

// ---------------------------------------------------------------------------
// (c) idempotent dispose() — second call is a no-op, no callbacks fire.
// ---------------------------------------------------------------------------

test("subscribeReadiness: dispose() is idempotent — second call is a no-op", () => {
  const { factory, socketRef } = makeMockConnect();
  const snapshots: ReadinessClientSnapshot[] = [];
  const lifecycle: { event: string; detail?: Record<string, unknown> }[] = [];
  let fatalCalls = 0;
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-dispose",
    onSnapshot: (snap) => snapshots.push(snap),
    onLifecycle: (event, detail) => lifecycle.push({ event, detail }),
    onFatal: () => {
      fatalCalls += 1;
    },
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }

  // Reach first-paint so the helper is in steady state.
  sock.takeOutbound();
  sock.deliver([
    emptyResult("epics", "test-dispose-epics"),
    emptyResult("jobs", "test-dispose-jobs"),
    emptyResult("subagent_invocations", "test-dispose-subagent-invocations"),
  ]);
  expect(snapshots).toHaveLength(1);

  // First dispose: sends an `unsubscribe` frame and calls `end()`.
  handle.dispose();
  const out1 = sock.takeOutbound();
  expect(out1).toHaveLength(1);
  expect((out1[0] as { type: string }).type).toBe("unsubscribe");
  expect(sock.ended).toBe(true);

  // Snapshot baseline; second dispose must be inert.
  const snapsBefore = snapshots.length;
  const lifecycleBefore = lifecycle.length;
  const fatalBefore = fatalCalls;

  handle.dispose();

  // No additional outbound frames, no extra callbacks.
  expect(sock.outbound).toHaveLength(0);
  expect(snapshots.length).toBe(snapsBefore);
  expect(lifecycle.length).toBe(lifecycleBefore);
  expect(fatalCalls).toBe(fatalBefore);
});

// ---------------------------------------------------------------------------
// (d) terminal `error` frame with no gotResult invokes onFatal with the
//     error payload (and onLifecycle sees the same error event).
// ---------------------------------------------------------------------------

test("subscribeReadiness: terminal error frame (no prior result) invokes onFatal with the error payload", () => {
  const { factory, socketRef } = makeMockConnect();
  const fatals: FatalError[] = [];
  const lifecycle: { event: string; detail?: Record<string, unknown> }[] = [];
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-fatal",
    onSnapshot: () => {
      throw new Error("onSnapshot must not fire on a pre-handshake error");
    },
    onLifecycle: (event, detail) => lifecycle.push({ event, detail }),
    onFatal: (err) => fatals.push(err),
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }

  // Burn the three initial queries.
  expect(sock.takeOutbound()).toHaveLength(3);

  // Deliver a terminal `error` frame BEFORE any collection has a result.
  sock.deliver([errorFrame("unknown_collection", "no such collection", 0)]);

  // `onFatal` fired exactly once with the error payload.
  expect(fatals).toHaveLength(1);
  expect(fatals[0]).toEqual({
    code: "unknown_collection",
    rev: 0,
    message: "no such collection",
  });

  // `onLifecycle` also saw an `error` event with the same fields (the
  // contract is "lifecycle observes; fatal acts").
  const errorEvents = lifecycle.filter((e) => e.event === "error");
  expect(errorEvents).toHaveLength(1);
  expect(errorEvents[0]?.detail).toEqual({
    code: "unknown_collection",
    rev: 0,
    message: "no such collection",
  });

  // Socket was torn down via `end()` so the reconnect loop won't fire.
  expect(sock.ended).toBe(true);

  handle.dispose();
});

test("subscribeReadiness: non-terminal error (one collection already has a result) does NOT invoke onFatal", () => {
  // Companion-of-(d): pin the gating contract. A `result` from any one
  // collection means the query shape is valid; a subsequent error is
  // likely transient and the next refetch can recover. `onFatal` MUST
  // NOT fire in that branch.
  const { factory, socketRef } = makeMockConnect();
  let fatalCalls = 0;
  const lifecycle: { event: string; detail?: Record<string, unknown> }[] = [];
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-non-fatal",
    onSnapshot: () => {
      /* ignore — gate stays closed (only one collection has a result) */
    },
    onLifecycle: (event, detail) => lifecycle.push({ event, detail }),
    onFatal: () => {
      fatalCalls += 1;
    },
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }
  sock.takeOutbound();

  // One collection succeeds…
  sock.deliver([emptyResult("epics", "test-non-fatal-epics")]);
  // …then an error arrives. Gate gating: at least one `gotResult` =
  // true → NOT terminal → no `onFatal`.
  sock.deliver([errorFrame("bad_frame", "transient", 1)]);

  expect(fatalCalls).toBe(0);
  // Lifecycle still saw the error (the helper always surfaces it).
  expect(lifecycle.filter((e) => e.event === "error")).toHaveLength(1);
  // Socket NOT torn down by the error branch — reconnect loop untouched.
  expect(sock.ended).toBe(false);

  handle.dispose();
});

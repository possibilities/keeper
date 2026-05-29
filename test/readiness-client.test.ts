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
  const factory: ConnectFactory = async (_path, handlers) => {
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
    await done;
    return sock;
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

  // Four initial queries fired on open — fn-626 widened the readiness
  // composition with `git_status`. fn-637's resolver-only completed-epics
  // subscription was deleted by fn-637.4 (predicate 9 and the board pill
  // now read `epic.resolved_epic_deps` off the projection), so the gate is
  // back to four collections.
  const initial = sock.takeOutbound();
  expect(initial).toHaveLength(4);
  expect(
    initial.map((f) => (f as { collection: string }).collection).sort(),
  ).toEqual(["epics", "git", "jobs", "subagent_invocations"]);

  // Deliver only `epics` first: gate must hold.
  sock.deliver([emptyResult("epics", "test-paintgate-epics")]);
  expect(snapshots).toHaveLength(0);

  // Add `jobs`: gate still holds (need all four).
  sock.deliver([emptyResult("jobs", "test-paintgate-jobs")]);
  expect(snapshots).toHaveLength(0);

  // Add `subagent_invocations`: still missing `git`.
  sock.deliver([
    emptyResult("subagent_invocations", "test-paintgate-subagent-invocations"),
  ]);
  expect(snapshots).toHaveLength(0);

  // Add `git`: gate clears, snapshot fires exactly once.
  sock.deliver([emptyResult("git", "test-paintgate-git")]);
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]?.epics).toEqual([]);
  expect(snapshots[0]?.jobs.size).toBe(0);
  expect(snapshots[0]?.subagentInvocations).toEqual([]);
  expect(snapshots[0]?.gitStatus).toEqual([]);

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

  // Discard the four initial queries (fn-626 added `git`; fn-637.4 deleted
  // the completed-epics resolver-only sub, reverting to four collections).
  expect(sock.takeOutbound()).toHaveLength(4);

  // BEFORE the `epics` result resolves the in-flight query, deliver TWO
  // `meta` nudges for `epics` — both should fold into one pending
  // refetch via `refetchDirty`, not two writes. The nudges carry the epics
  // subId so they route to the primary epics sub by id; the collection-
  // only fallback path is also unambiguous now that there's a single
  // `epics` subscription.
  sock.deliver([metaFrameWithId("epics", "test-coalesce-epics", 2)]);
  sock.deliver([metaFrameWithId("epics", "test-coalesce-epics", 3)]);
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
  sock.deliver([metaFrameWithId("epics", "test-coalesce-epics", 4)]);
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
    emptyResult("git", "test-dispose-git"),
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

test("subscribeReadiness: terminal error frame (no prior result) invokes onFatal with the error payload and leaves no pending setInterval", () => {
  // Spy `setInterval` / `clearInterval` on the global so we can track
  // every timer the helper schedules and assert NONE remain pending
  // after `onFatal` fires. This pins the F1 leak: the terminal-error
  // branch used to set `shuttingDown` and call `end()` but never
  // clear `pollTimer`, leaving a live `setInterval` to hold the event
  // loop open whenever a custom `onFatal` returned instead of exiting.
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const pending = new Set<ReturnType<typeof realSetInterval>>();
  globalThis.setInterval = ((
    handler: Parameters<typeof realSetInterval>[0],
    timeout?: number,
    ...args: unknown[]
  ) => {
    const id = realSetInterval(handler, timeout, ...args);
    pending.add(id);
    return id;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
    if (id !== undefined) {
      pending.delete(id);
    }
    realClearInterval(id);
  }) as typeof clearInterval;

  try {
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

    // Burn the four initial queries (fn-626 added `git`; fn-637.4 deleted
    // the completed-epics resolver-only sub).
    expect(sock.takeOutbound()).toHaveLength(4);
    // The helper installed its steady-poll `setInterval` in `open`; the
    // spy must have observed it.
    expect(pending.size).toBe(1);

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

    // The F1 invariant: the terminal-error branch cleared `pollTimer`
    // before invoking `onFatal`, so no live `setInterval` survives.
    expect(pending.size).toBe(0);

    handle.dispose();
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    for (const id of pending) {
      realClearInterval(id);
    }
  }
});

test("subscribeReadiness: capped-backoff reconnect sequence — 250, 500, 1000, 2000, 4000, 5000 ms", async () => {
  // F2 coverage: the reconnect loop computes
  //   delay = min(INITIAL_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS)
  // (`src/readiness-client.ts:524-525`). Drive the mock factory to reject
  // back-to-back and intercept `setTimeout` to capture each `delay` the
  // helper would sleep for. Firing the callback synchronously fast-forwards
  // the backoff so the test stays deterministic and millisecond-fast.
  const expected = [250, 500, 1000, 2000, 4000, 5000, 5000];
  const observed: number[] = [];

  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((
    handler: Parameters<typeof realSetTimeout>[0],
    timeout?: number,
    ...args: unknown[]
  ) => {
    // Capture only the reconnect-sleep timeouts: those are the ones the
    // helper schedules from `connectWithRetry`. Other library timers
    // (Bun internals, microtask shims) generally use `0` or `undefined`;
    // the helper's sleeps are positive, finite millisecond delays
    // matching the expected sequence. Recording every positive `timeout`
    // is safe — the helper schedules no other positive-delay timeouts.
    if (typeof timeout === "number" && timeout > 0) {
      observed.push(timeout);
      // Fire the callback on the next microtask so the awaiting
      // `connectWithRetry` loop advances without a real delay.
      queueMicrotask(() => {
        (handler as () => void)();
      });
      // Return a fake id; helper only uses it for `clearTimeout` on
      // dispose, which we won't reach for these timers.
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(handler as () => void, timeout, ...args);
  }) as typeof setTimeout;

  try {
    let calls = 0;
    let resolveDone: (() => void) | null = null;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const factory: ConnectFactory = (_path, _handlers) => {
      calls += 1;
      if (calls <= expected.length) {
        // Reject without calling `open` — no socket installed, no
        // `setInterval` scheduled. Each rejection bumps `attempt` and
        // schedules one backoff sleep.
        return Promise.reject(new Error(`refused #${calls}`));
      }
      // Final attempt: signal the test we've observed the full capped
      // sequence and hand back a never-resolving promise so the loop
      // sits idle until `dispose()`.
      resolveDone?.();
      resolveDone = null;
      return new Promise<ReadinessSocket>(() => {
        /* never resolves — held until dispose() */
      });
    };

    const lifecycle: { event: string; detail?: Record<string, unknown> }[] = [];
    const handle = subscribeReadiness({
      sockPath: "/tmp/keeper-mock.sock",
      idPrefix: "test-backoff",
      onSnapshot: () => {
        throw new Error("onSnapshot must not fire — no result ever delivered");
      },
      onLifecycle: (event, detail) => lifecycle.push({ event, detail }),
      onFatal: () => {
        throw new Error(
          "onFatal must not fire — connect rejections are not terminal",
        );
      },
      connect: factory,
    });

    // Wait for the full backoff sequence to play out.
    await done;

    // The helper observed expected.length rejections + scheduled
    // expected.length backoff sleeps, capped at MAX_BACKOFF_MS for the
    // tail entries.
    expect(observed).toEqual(expected);

    // Lifecycle should have emitted one `waiting` per backoff with a
    // matching `retry_in_ms`.
    const waits = lifecycle.filter((e) => e.event === "waiting");
    expect(waits).toHaveLength(expected.length);
    expect(waits.map((w) => w.detail?.retry_in_ms)).toEqual(expected);

    handle.dispose();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

// ---------------------------------------------------------------------------
// Slow-flight + hard-deadline reconnect coverage (fn-622.3)
//
// The helper's `pollAll` walks every state on each `POLL_MS` tick and
// compares `Date.now() - queryInFlightSince` against `SLOW_FLIGHT_MS`
// (1 s) and `QUERY_TIMEOUT_MS` (5 s). To stay deterministic and
// millisecond-fast we mock `Date.now()` plus capture the `setInterval`
// handler the helper installs in `open` so the test can fire `pollAll`
// manually at chosen wall-clock points. No real time elapses.
// ---------------------------------------------------------------------------
//
// Shared scaffolding: install `Date.now` + `setInterval` spies, return
// a `tick(ms)` advancer that bumps the mocked clock and runs the
// captured poll handler. `restore()` unwinds both.
// ---------------------------------------------------------------------------

interface TimerHarness {
  setNow(ms: number): void;
  advance(ms: number): void;
  pollHandler(): () => void;
  pollIntervalMs(): number;
  restore(): void;
}

function installTimerHarness(startMs = 1_000_000): TimerHarness {
  const realNow = Date.now;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let now = startMs;
  let captured: (() => void) | null = null;
  let capturedInterval = 0;
  let realId: ReturnType<typeof realSetInterval> | null = null;
  Date.now = () => now;
  globalThis.setInterval = ((
    handler: Parameters<typeof realSetInterval>[0],
    timeout?: number,
    ...args: unknown[]
  ) => {
    // Capture the first positive-interval handler — that's the helper's
    // poll loop. Any other timers (Bun internals) fall through to the
    // real implementation untouched. The captured handler is invoked
    // manually by `pollHandler()`; we still register a real interval
    // with a huge delay so the spy's return id is a valid timer the
    // helper can `clearInterval` without complaint.
    if (captured === null && typeof timeout === "number" && timeout > 0) {
      captured = handler as () => void;
      capturedInterval = timeout;
      realId = realSetInterval(() => {
        /* never fires in test horizon */
      }, 86_400_000);
      return realId;
    }
    return realSetInterval(handler, timeout, ...args);
  }) as typeof setInterval;
  globalThis.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
    if (id !== undefined && id === realId) {
      realClearInterval(realId);
      realId = null;
      captured = null;
      return;
    }
    realClearInterval(id);
  }) as typeof clearInterval;
  return {
    setNow(ms: number): void {
      now = ms;
    },
    advance(ms: number): void {
      now += ms;
    },
    pollHandler(): () => void {
      if (captured === null) {
        throw new Error("poll handler never captured");
      }
      return captured;
    },
    pollIntervalMs(): number {
      return capturedInterval;
    },
    restore(): void {
      Date.now = realNow;
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      if (realId !== null) {
        realClearInterval(realId);
      }
    },
  };
}

test("subscribeReadiness: Path A (<1 s) — result arrives before slow-flight threshold, no events", () => {
  const harness = installTimerHarness();
  try {
    const { factory, socketRef } = makeMockConnect();
    const lifecycle: { event: string; detail?: Record<string, unknown> }[] = [];
    const handle = subscribeReadiness({
      sockPath: "/tmp/keeper-mock.sock",
      idPrefix: "test-patha",
      onSnapshot: () => {
        /* ignore */
      },
      onLifecycle: (event, detail) => lifecycle.push({ event, detail }),
      onFatal: () => {
        throw new Error("onFatal must not fire on the happy path");
      },
      connect: factory,
    });
    const sock = socketRef.current;
    if (!sock) {
      throw new Error("mock socket never installed");
    }
    sock.takeOutbound();

    // Advance to t=500 ms and deliver a result for one collection.
    harness.advance(500);
    sock.deliver([emptyResult("epics", "test-patha-epics")]);

    // Run the poll — no state should be stuck (epics resolved at 500 ms,
    // jobs + subagent still in flight but only at 500 ms in-flight age).
    harness.pollHandler()();

    expect(
      lifecycle.filter((e) => e.event === "query_slow_flight"),
    ).toHaveLength(0);
    expect(lifecycle.filter((e) => e.event === "query_timeout")).toHaveLength(
      0,
    );

    handle.dispose();
  } finally {
    harness.restore();
  }
});

test("subscribeReadiness: Path B (1–5 s) — slow-flight latches once, timeout fires reconnect at 5 s", () => {
  const harness = installTimerHarness();
  try {
    const { factory, socketRef } = makeMockConnect();
    const lifecycle: { event: string; detail?: Record<string, unknown> }[] = [];
    const handle = subscribeReadiness({
      sockPath: "/tmp/keeper-mock.sock",
      idPrefix: "test-pathb",
      onSnapshot: () => {
        /* ignore */
      },
      onLifecycle: (event, detail) => lifecycle.push({ event, detail }),
      onFatal: () => {
        throw new Error("onFatal must not fire — timeout is not a fatal");
      },
      connect: factory,
    });
    const sock = socketRef.current;
    if (!sock) {
      throw new Error("mock socket never installed");
    }
    sock.takeOutbound();

    // t=1000 ms + epsilon: slow-flight should fire exactly once per state.
    harness.advance(1001);
    harness.pollHandler()();

    const slowAt1s = lifecycle.filter((e) => e.event === "query_slow_flight");
    // Four collections all in flight, all crossed 1 s — four emits (fn-626
    // added `git`; fn-637.4 deleted the completed-epics resolver-only sub).
    expect(slowAt1s).toHaveLength(4);
    expect(slowAt1s.map((e) => e.detail?.collection).sort()).toEqual([
      "epics",
      "git",
      "jobs",
      "subagent_invocations",
    ]);

    // t=2500 ms: another poll, latch must hold — no NEW slow-flight events.
    harness.advance(1499);
    harness.pollHandler()();
    expect(
      lifecycle.filter((e) => e.event === "query_slow_flight"),
    ).toHaveLength(4);

    // t=5001 ms: timeout fires. Single-flight `reconnecting` guard means
    // exactly one `query_timeout` event for the FIRST stuck state.
    harness.advance(2501);
    harness.pollHandler()();
    const timeouts = lifecycle.filter((e) => e.event === "query_timeout");
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]?.detail?.collection).toBe("epics");
    expect(typeof timeouts[0]?.detail?.age_ms).toBe("number");
    expect((timeouts[0]?.detail?.age_ms as number) >= 5000).toBe(true);

    // Socket was end()'d to kick the reconnect loop.
    expect(sock.ended).toBe(true);

    handle.dispose();
  } finally {
    harness.restore();
  }
});

test("subscribeReadiness: Path C — reconnect clears slow-flight state, fresh window emits cleanly", async () => {
  const harness = installTimerHarness();
  try {
    let connectCount = 0;
    const socketRefs: { current: MockSocket | null }[] = [];
    const factory: ConnectFactory = async (_path, handlers) => {
      connectCount += 1;
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
      const ref: { current: MockSocket | null } = { current: sock };
      socketRefs.push(ref);
      handlers.open(sock);
      await done;
      return sock;
    };

    const lifecycle: { event: string; detail?: Record<string, unknown> }[] = [];
    const handle = subscribeReadiness({
      sockPath: "/tmp/keeper-mock.sock",
      idPrefix: "test-pathc",
      onSnapshot: () => {
        /* ignore */
      },
      onLifecycle: (event, detail) => lifecycle.push({ event, detail }),
      onFatal: () => {
        throw new Error("onFatal must not fire");
      },
      connect: factory,
    });

    // First connection: trigger a timeout to force reconnect.
    const sock1 = socketRefs[0]?.current;
    if (!sock1) {
      throw new Error("mock socket #1 never installed");
    }
    sock1.takeOutbound();
    harness.advance(5001);
    harness.pollHandler()();
    expect(lifecycle.filter((e) => e.event === "query_timeout")).toHaveLength(
      1,
    );
    expect(sock1.ended).toBe(true);

    // Simulate the close-from-network that follows our `end()` call. The
    // helper's `close` handler runs `teardownConnection()` + kicks
    // `connectWithRetry`, which synchronously re-invokes the factory
    // (the rejection branch is skipped because we return a real
    // resolved promise).
    sock1.closeFromServer();
    // Yield so the awaited connect() resolves and the next `connectOnce`
    // can run.
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(connectCount).toBe(2);
    const sock2 = socketRefs[1]?.current;
    if (!sock2) {
      throw new Error("mock socket #2 never installed");
    }
    sock2.takeOutbound();

    // Fresh window: advance another 1001 ms and poll — slow-flight
    // latch must have been cleared by `teardownConnection`, so we
    // get a brand-new emit per state.
    const slowCountBefore = lifecycle.filter(
      (e) => e.event === "query_slow_flight",
    ).length;
    harness.advance(1001);
    harness.pollHandler()();
    const slowCountAfter = lifecycle.filter(
      (e) => e.event === "query_slow_flight",
    ).length;
    // Four collections in the new window, four fresh emits (fn-626 added
    // `git`; fn-637.4 deleted the completed-epics resolver-only sub).
    expect(slowCountAfter - slowCountBefore).toBe(4);

    handle.dispose();
  } finally {
    harness.restore();
  }
});

test("subscribeReadiness: single-flight — two stuck collections produce ONE reconnect at the 5 s deadline", () => {
  const harness = installTimerHarness();
  try {
    const { factory, socketRef } = makeMockConnect();
    const lifecycle: { event: string; detail?: Record<string, unknown> }[] = [];
    const handle = subscribeReadiness({
      sockPath: "/tmp/keeper-mock.sock",
      idPrefix: "test-singleflight",
      onSnapshot: () => {
        /* ignore */
      },
      onLifecycle: (event, detail) => lifecycle.push({ event, detail }),
      onFatal: () => {
        throw new Error("onFatal must not fire");
      },
      connect: factory,
    });
    const sock = socketRef.current;
    if (!sock) {
      throw new Error("mock socket never installed");
    }
    sock.takeOutbound();

    // All four collections are still in flight (no `result` delivered).
    // At t=5001 ms all four cross the deadline on the same poll tick.
    harness.advance(5001);
    harness.pollHandler()();

    // Exactly ONE `query_timeout` event, named after the FIRST state
    // (`epics` — the order in `states[]` matches the makeState calls in
    // `subscribeReadiness`: epics, jobs, subagent_invocations, git).
    const timeouts = lifecycle.filter((e) => e.event === "query_timeout");
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]?.detail?.collection).toBe("epics");

    // ONE socket end() call (also implies one reconnect kick).
    expect(sock.ended).toBe(true);

    handle.dispose();
  } finally {
    harness.restore();
  }
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

// ---------------------------------------------------------------------------
// Multi-sub routing + 500ms-refetch-removal coverage (fn-632.2)
//
// The server-side multi-sub refactor (fn-632.1) added `id?: string` to
// `patch`/`meta` frames so a connection carrying N concurrent subs can
// route each frame back to the originating sub. The client-side change
// here is two-part: (1) id-first routing on result/patch/meta with a
// fall-through to collection lookup (legacy server compat), (2) drop
// the 500ms steady-poll refetch backstop — patch/meta drive freshness
// now, the poll loop is slow-flight detection only.
// ---------------------------------------------------------------------------

function patchFrame(
  collection: string,
  id: string | undefined,
  rev = 2,
): ServerFrame {
  return {
    type: "patch",
    ...(id === undefined ? {} : { id }),
    collection,
    rev,
    row: { epic_id: "irrelevant" },
  };
}

function metaFrameWithId(
  collection: string,
  id: string | undefined,
  rev = 2,
): ServerFrame {
  return {
    type: "meta",
    ...(id === undefined ? {} : { id }),
    collection,
    rev,
    total: 0,
  };
}

test("subscribeReadiness: id-first routing — patch{id} triggers a refetch on the matching sub", () => {
  const { factory, socketRef } = makeMockConnect();
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-idroute",
    onSnapshot: () => {
      /* ignore */
    },
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }

  // Resolve the four initial queries so subsequent in-flight tracking
  // is clean — refetch coalesce is exercised here, not first-paint.
  expect(sock.takeOutbound()).toHaveLength(4);
  sock.deliver([
    emptyResult("epics", "test-idroute-epics"),
    emptyResult("jobs", "test-idroute-jobs"),
    emptyResult("subagent_invocations", "test-idroute-subagent-invocations"),
    emptyResult("git", "test-idroute-git"),
  ]);
  sock.takeOutbound();

  // A `patch` carrying ONLY the sub id (no collection match needed) is
  // routed via bySubId to the epics state. Verify by asserting exactly
  // ONE follow-up query is emitted, and it targets the `epics`
  // collection.
  sock.deliver([patchFrame("epics", "test-idroute-epics", 3)]);
  const follow = sock.takeOutbound();
  expect(follow).toHaveLength(1);
  expect((follow[0] as { collection: string }).collection).toBe("epics");
  expect((follow[0] as { id: string }).id).toBe("test-idroute-epics");

  handle.dispose();
});

test("subscribeReadiness: legacy server compat — patch with no id falls back to byCollection routing", () => {
  const { factory, socketRef } = makeMockConnect();
  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-legacy",
    onSnapshot: () => {
      /* ignore */
    },
    connect: factory,
  });
  const sock = socketRef.current;
  if (!sock) {
    throw new Error("mock socket never installed");
  }

  expect(sock.takeOutbound()).toHaveLength(4);
  sock.deliver([
    emptyResult("epics", "test-legacy-epics"),
    emptyResult("jobs", "test-legacy-jobs"),
    emptyResult("subagent_invocations", "test-legacy-subagent-invocations"),
    emptyResult("git", "test-legacy-git"),
  ]);
  sock.takeOutbound();

  // A `patch` WITHOUT `id` (legacy single-sub server) is routed by
  // collection — `frame.id === undefined` short-circuits the bySubId
  // lookup, then byCollection.get("jobs") resolves the jobs state.
  sock.deliver([patchFrame("jobs", undefined, 4)]);
  const follow = sock.takeOutbound();
  expect(follow).toHaveLength(1);
  expect((follow[0] as { collection: string }).collection).toBe("jobs");

  // Same for `meta` — legacy servers emit neither id, and the
  // collection lookup is the only routable signal.
  sock.deliver([metaFrameWithId("git", undefined, 5)]);
  const follow2 = sock.takeOutbound();
  expect(follow2).toHaveLength(1);
  expect((follow2[0] as { collection: string }).collection).toBe("git");

  handle.dispose();
});

test("subscribeReadiness: reconnect re-issues queries with the same stable subIds", async () => {
  // Build a multi-connect factory so the helper's reconnect loop can
  // hand a second mock socket on the second `connectOnce()` pass.
  let connectCount = 0;
  const socketRefs: { current: MockSocket | null }[] = [];
  const factory: ConnectFactory = async (_path, handlers) => {
    connectCount += 1;
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
    const ref: { current: MockSocket | null } = { current: sock };
    socketRefs.push(ref);
    handlers.open(sock);
    await done;
    return sock;
  };

  const handle = subscribeReadiness({
    sockPath: "/tmp/keeper-mock.sock",
    idPrefix: "test-reconnect",
    onSnapshot: () => {
      /* ignore — first-paint isn't reached, no results delivered */
    },
    connect: factory,
  });

  const sock1 = socketRefs[0]?.current;
  if (!sock1) {
    throw new Error("mock socket #1 never installed");
  }
  const initial1 = sock1.takeOutbound();
  expect(initial1).toHaveLength(4);
  const initialIds1 = initial1.map((f) => (f as { id: string }).id).sort();
  expect(initialIds1).toEqual([
    "test-reconnect-epics",
    "test-reconnect-git",
    "test-reconnect-jobs",
    "test-reconnect-subagent-invocations",
  ]);

  // Force a close so `connectWithRetry` re-runs `connectOnce` and
  // re-fires the open handler against a fresh socket.
  sock1.closeFromServer();
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  expect(connectCount).toBe(2);
  const sock2 = socketRefs[1]?.current;
  if (!sock2) {
    throw new Error("mock socket #2 never installed");
  }
  const initial2 = sock2.takeOutbound();
  expect(initial2).toHaveLength(4);
  const initialIds2 = initial2.map((f) => (f as { id: string }).id).sort();
  // EXACT same subIds — they're constants in subscribeReadiness, and the
  // states[] list is built once at the top of the helper and reused
  // verbatim across reconnects. This is the invariant that lets the
  // server rebuild the same subs by id post-reconnect.
  expect(initialIds2).toEqual(initialIds1);

  handle.dispose();
});

test("subscribeReadiness: pollAll no longer schedules per-state refetches — freshness is patch-driven only", () => {
  const harness = installTimerHarness();
  try {
    const { factory, socketRef } = makeMockConnect();
    const handle = subscribeReadiness({
      sockPath: "/tmp/keeper-mock.sock",
      idPrefix: "test-no-poll-refetch",
      onSnapshot: () => {
        /* ignore */
      },
      connect: factory,
    });
    const sock = socketRef.current;
    if (!sock) {
      throw new Error("mock socket never installed");
    }
    sock.takeOutbound();

    // Resolve all four initial queries so every state has gotResult and
    // queryInFlight cleared. With the second-pass refetch removed,
    // pollAll over a fully-resolved state list should fire ZERO new
    // outbound writes.
    sock.deliver([
      emptyResult("epics", "test-no-poll-refetch-epics"),
      emptyResult("epics", "test-no-poll-refetch-completed-epics"),
      emptyResult("jobs", "test-no-poll-refetch-jobs"),
      emptyResult(
        "subagent_invocations",
        "test-no-poll-refetch-subagent-invocations",
      ),
      emptyResult("git", "test-no-poll-refetch-git"),
    ]);
    sock.takeOutbound();

    // Advance well past POLL_MS (500) and fire the poll handler several
    // times. If the legacy second pass still existed it would write 4
    // refetch queries per tick — assert zero writes across multiple
    // poll ticks.
    harness.advance(600);
    harness.pollHandler()();
    harness.advance(600);
    harness.pollHandler()();
    harness.advance(600);
    harness.pollHandler()();
    expect(sock.outbound).toHaveLength(0);

    // …but a patch arrival STILL drives a refetch (the legitimate
    // freshness path the poll-loop refetch used to backstop).
    sock.deliver([patchFrame("epics", "test-no-poll-refetch-epics", 2)]);
    expect(sock.takeOutbound()).toHaveLength(1);

    handle.dispose();
  } finally {
    harness.restore();
  }
});

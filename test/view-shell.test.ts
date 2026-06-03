/**
 * `createViewShell` connecting-indicator coverage. The shell harness
 * itself is exercised indirectly by every CLI integration test (board,
 * jobs, autopilot, git all build on top of it); this file isolates the
 * fn-691 timer-driven re-fold progress indicator:
 *
 *   - Arms a single `setInterval(~125ms)` on the first lifecycle event
 *     while `frameCount === 0` and `event !== "connected"`.
 *   - Each tick re-polls the injected progress poller and composes the
 *     line: `re-folding event log NN.N%  C / M` when `cursor<max`,
 *     plain `connecting to keeperd…` otherwise (null poll, `max` falsy,
 *     `cursor>=max`, or after `REFOLD_MISS_BUDGET` consecutive misses).
 *   - Self-stops on the first real `emit()` (NOT on `connected`).
 *   - Tears down the interval + closes the poller from the SIGINT path.
 *   - `close()` is double-call safe across the two teardown paths.
 *
 * Test plumbing
 * -------------
 * The shell internally constructs a `LiveShell` via `createLiveShell`.
 * In the test runner `process.stdout` / `process.stdin` are non-TTY,
 * so the shell falls into the passthrough path and `pushFrame` writes
 * the joined body to `stdout.write`. We capture that sink by spying on
 * `process.stdout.write` for the duration of each test; the captured
 * strings are the bodies the shell pushed.
 *
 * `setInterval` / `clearInterval` are monkeypatched globally (the
 * `readiness-client` house style — see
 * `test/readiness-client.test.ts:461-485`) so a test can drive ticks
 * synchronously and assert on the captured callback / handle without
 * waiting on real wall-clock ms. `process.on("SIGINT", ...)` install
 * goes onto an `EventEmitter` stub so we don't leak listeners onto the
 * real process across files.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { RefoldProgressPoller } from "../src/refold-progress";
import {
  createViewShell,
  type ViewRender,
  type ViewShell,
} from "../src/view-shell";

// ---------------------------------------------------------------------------
// Fake poller — records every `poll()` invocation and returns scripted
// samples in order; once the queue empties, it returns the configured
// trailing value (null by default, so an unbounded run-out keeps the
// fake honest).
// ---------------------------------------------------------------------------

interface FakePoller extends RefoldProgressPoller {
  readonly polls: number;
  readonly closes: number;
}

function makeFakePoller(
  queue: Array<{ cursor: number; max: number } | null>,
  trailing: { cursor: number; max: number } | null = null,
): FakePoller {
  let polls = 0;
  let closes = 0;
  const fake = {
    poll(): { cursor: number; max: number } | null {
      polls += 1;
      if (queue.length === 0) {
        return trailing;
      }
      return queue.shift() ?? null;
    },
    close(): void {
      closes += 1;
    },
    get polls() {
      return polls;
    },
    get closes() {
      return closes;
    },
  } satisfies FakePoller;
  return fake;
}

// ---------------------------------------------------------------------------
// Interval monkeypatch — capture every scheduled callback + handle so a
// test can drive ticks synchronously and assert on `clearInterval`
// receiving the same handle the shell stored.
// ---------------------------------------------------------------------------

interface IntervalCapture {
  callbacks: Array<() => void>;
  delays: number[];
  cleared: unknown[];
  /** Restore the real globals. */
  restore(): void;
  /** Drive one synthetic tick on the most-recently-armed interval. */
  tick(): void;
}

function patchIntervals(): IntervalCapture {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const callbacks: Array<() => void> = [];
  const delays: number[] = [];
  const cleared: unknown[] = [];
  let nextHandle = 1;

  // Fake handles are just bumping integers so a strict-equal assertion
  // on `cleared.includes(handle)` is meaningful. We never return a real
  // timer; the test owns the cadence.
  globalThis.setInterval = ((
    cb: () => void,
    delay?: number,
  ): ReturnType<typeof setInterval> => {
    callbacks.push(cb);
    delays.push(typeof delay === "number" ? delay : 0);
    return nextHandle++ as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;

  globalThis.clearInterval = ((handle?: unknown): void => {
    if (handle !== undefined) {
      cleared.push(handle);
    }
  }) as typeof clearInterval;

  return {
    callbacks,
    delays,
    cleared,
    restore(): void {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    },
    tick(): void {
      if (callbacks.length === 0) {
        throw new Error("no interval armed — tick() before setInterval()");
      }
      callbacks[callbacks.length - 1]();
    },
  };
}

// ---------------------------------------------------------------------------
// stdout sink — passthrough `pushFrame` writes here. Capture and strip
// the trailing newlines / `---` lead so tests assert against the body
// text alone. We also clear the array per-test in `beforeEach`.
// ---------------------------------------------------------------------------

interface StdoutCapture {
  writes: string[];
  restore(): void;
}

function patchStdout(): StdoutCapture {
  const real = process.stdout.write.bind(process.stdout);
  const writes: string[] = [];
  (process.stdout as unknown as { write: typeof process.stdout.write }).write =
    ((data: unknown): boolean => {
      writes.push(typeof data === "string" ? data : String(data));
      return true;
    }) as typeof process.stdout.write;
  return {
    writes,
    restore(): void {
      (
        process.stdout as unknown as { write: typeof process.stdout.write }
      ).write = real;
    },
  };
}

// ---------------------------------------------------------------------------
// Shared per-test scaffolding.
// ---------------------------------------------------------------------------

let intervals: IntervalCapture;
let stdoutCap: StdoutCapture;
let view: ViewShell<{ body: string[] }> | null = null;
// Per-test sidecar prefix — we'll wipe these in afterEach so the
// /tmp tree stays clean across runs. The shell creates them on first
// emit / lifecycle write.
let sidecarBase: string;

beforeEach(() => {
  intervals = patchIntervals();
  stdoutCap = patchStdout();
  view = null;
  sidecarBase = `keeper-view-shell-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
});

afterEach(async () => {
  intervals.restore();
  stdoutCap.restore();
  // Clean up any /tmp/keeper-<script>.<pid>.* the shell created. Best-
  // effort — leaked sidecars are observational, not test-blocking.
  try {
    const { rmSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const f of readdirSync("/tmp")) {
      if (f.startsWith(`keeper-${sidecarBase}.`)) {
        rmSync(join("/tmp", f), { force: true });
      }
    }
  } catch {
    // best-effort
  }
});

function renderBody(snap: { body: string[] }): ViewRender {
  return { bodyLines: snap.body, stateJson: snap };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("arms one setInterval on first non-connected lifecycle event", () => {
  const poller = makeFakePoller([]);
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    refoldProgressPoller: poller,
  });

  // No interval before the first lifecycle event.
  expect(intervals.callbacks).toHaveLength(0);

  view.emitLifecycle("connecting", { attempt: 1 });
  expect(intervals.callbacks).toHaveLength(1);
  expect(intervals.delays[0]).toBeGreaterThanOrEqual(100);
  expect(intervals.delays[0]).toBeLessThanOrEqual(250);

  // A second lifecycle event must NOT arm a second interval — the
  // shell guards against double-arm in `armConnectingSpinner`.
  view.emitLifecycle("waiting", { retry_in_ms: 250 });
  expect(intervals.callbacks).toHaveLength(1);
});

test("does NOT arm on a `connected` lifecycle event (data still pending)", () => {
  // The readiness client emits `connected` BEFORE the first `result`
  // frame lands (see `readiness-client.ts:800`), so `connected` alone
  // is not a paint signal — the shell must not arm the spinner on it
  // (and conversely, must not STOP a previously-armed spinner on it,
  // which is covered by the self-stop test below).
  const poller = makeFakePoller([]);
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    refoldProgressPoller: poller,
  });
  view.emitLifecycle("connected", { sock: "/tmp/x.sock" });
  expect(intervals.callbacks).toHaveLength(0);
});

test("tick composes re-fold % line when cursor<max", () => {
  const poller = makeFakePoller([{ cursor: 12345, max: 67890 }]);
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    refoldProgressPoller: poller,
  });
  view.emitLifecycle("connecting", {});
  expect(intervals.callbacks).toHaveLength(1);

  // Drive one tick. The shell should poll the fake, compose the
  // percentage line, and push it. We assert against the captured
  // stdout sink (passthrough mode) — the line must carry "re-folding
  // event log", the % to 1 decimal, and the thousands-grouped
  // cursor / max counts.
  intervals.tick();
  expect(poller.polls).toBe(1);
  const joined = stdoutCap.writes.join("");
  expect(joined).toContain("re-folding event log");
  expect(joined).toContain("18.2%");
  expect(joined).toContain("12,345");
  expect(joined).toContain("67,890");
});

test("tick falls back to plain spinner on first null poll", () => {
  const poller = makeFakePoller([null]);
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    refoldProgressPoller: poller,
  });
  view.emitLifecycle("connecting", {});
  intervals.tick();
  expect(poller.polls).toBe(1);
  const joined = stdoutCap.writes.join("");
  expect(joined).toContain("connecting to keeperd");
  expect(joined).not.toContain("re-folding event log");
});

test("holds the last-good floor across short null bursts (≤3 misses)", () => {
  // Three consecutive null polls after a good sample: the floor is
  // held through the budget, so the % line keeps painting at the last
  // observed (cursor,max).
  const poller = makeFakePoller(
    [{ cursor: 100, max: 1000 }, null, null, null],
    null,
  );
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    refoldProgressPoller: poller,
  });
  view.emitLifecycle("connecting", {});

  // Tick #1: good sample — paints %.
  intervals.tick();
  let joined = stdoutCap.writes.join("");
  expect(joined).toContain("10.0%");

  // Tick #2/#3/#4: nulls — floor held (REFOLD_MISS_BUDGET = 3).
  intervals.tick();
  intervals.tick();
  intervals.tick();
  joined = stdoutCap.writes.join("");
  // Still painting the % line — the budget hasn't been exceeded.
  expect(joined).toContain("10.0%");

  // Tick #5: a fourth null exceeds the budget; the shell drops to the
  // plain spinner for THIS tick (we count tail occurrences).
  intervals.tick();
  const writesAfterDrop = stdoutCap.writes.slice(-3).join("");
  expect(writesAfterDrop).toContain("connecting to keeperd");
});

test("guards `max<=0` and `cursor>=max` against NaN/>100% paint", () => {
  // A non-monotonic cursor (crash-loop re-fold restart, or a producer
  // mid-rewind) and a zero max both must fall back to the plain
  // spinner. The poller surfaces both shapes; the shell clamps via
  // the `max <= 0 || cursor >= max` guard.
  const poller = makeFakePoller([
    { cursor: 0, max: 0 },
    { cursor: 1500, max: 1000 },
    { cursor: 1000, max: 1000 },
  ]);
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    refoldProgressPoller: poller,
  });
  view.emitLifecycle("connecting", {});

  for (let i = 0; i < 3; i++) {
    intervals.tick();
  }
  const joined = stdoutCap.writes.join("");
  expect(joined).not.toContain("NaN");
  expect(joined).not.toContain("100.0%");
  expect(joined).not.toContain("150.0%");
  // All three ticks fell back to the plain spinner.
  expect(joined).toContain("connecting to keeperd");
});

test("first real emit self-stops the interval and closes the poller", () => {
  const poller = makeFakePoller([{ cursor: 50, max: 100 }]);
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    refoldProgressPoller: poller,
  });
  view.emitLifecycle("connecting", {});
  expect(intervals.callbacks).toHaveLength(1);
  intervals.tick();
  expect(poller.polls).toBe(1);

  // The first data emit should clear the interval (Bun setInterval
  // has no .unref()) and close the poller. We assert the captured
  // clearInterval handle matches the one setInterval returned.
  view.emit({ body: ["data row 1"] });
  expect(intervals.cleared).toHaveLength(1);
  expect(poller.closes).toBe(1);

  // A SECOND emit must not re-clear / re-close. Both teardown calls
  // are idempotent.
  view.emit({ body: ["data row 2"] });
  expect(intervals.cleared).toHaveLength(1);
  expect(poller.closes).toBe(1);
});

test("tick observed AFTER first frame is a no-op (self-stop on `frameCount>0`)", () => {
  // Even if a stale interval tick fires between the data emit and the
  // captured clearInterval taking effect, the tick callback's first
  // act is to check `frameCount > 0` and stop itself — no fake-poll
  // call, no spurious push. This proves the self-stop is defensive at
  // both layers.
  const poller = makeFakePoller([{ cursor: 1, max: 100 }]);
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    refoldProgressPoller: poller,
  });
  view.emitLifecycle("connecting", {});
  view.emit({ body: ["data"] });
  const pollsBefore = poller.polls;
  const closesBefore = poller.closes;
  intervals.tick();
  // No new poll; the close call is idempotent so the count doesn't
  // grow either.
  expect(poller.polls).toBe(pollsBefore);
  expect(poller.closes).toBe(closesBefore);
});

test("SIGINT teardown clears the interval and closes the poller idempotently", () => {
  // We swap `process` for an EventEmitter stub before installing the
  // handler so the test never registers a real process-level SIGINT
  // (which would tear the runner down). The shell's only contract
  // with `process` here is `on(...)` + later `process.exit(0)`; we
  // also stub exit to throw a sentinel we can catch.
  const poller = makeFakePoller([null]);
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    refoldProgressPoller: poller,
  });
  view.emitLifecycle("connecting", {});
  expect(intervals.callbacks).toHaveLength(1);

  // Capture the SIGINT handler.
  const realOn = process.on.bind(process);
  const emitter = new EventEmitter();
  let captured: ((...args: unknown[]) => void) | null = null;
  (process as unknown as { on: typeof process.on }).on = ((
    event: string,
    handler: (...args: unknown[]) => void,
  ) => {
    if (event === "SIGINT") {
      captured = handler;
      return process;
    }
    return realOn(event as never, handler as never);
  }) as typeof process.on;

  const realExit = process.exit;
  (process as unknown as { exit: (code?: number) => never }).exit = ((
    _code?: number,
  ): never => {
    throw new Error("__SIGINT_EXIT__");
  }) as never;

  try {
    view.installSigintHandler(() => {
      /* caller dispose — nothing for this test */
    });
    expect(typeof captured).toBe("function");

    expect(() => captured?.()).toThrow("__SIGINT_EXIT__");

    // The SIGINT path tore down the interval + closed the poller.
    expect(intervals.cleared).toHaveLength(1);
    expect(poller.closes).toBe(1);
  } finally {
    (process as unknown as { exit: typeof process.exit }).exit = realExit;
    (process as unknown as { on: typeof process.on }).on = realOn;
    emitter.removeAllListeners();
  }
});

test("poller.close() is NOT double-called across self-stop + SIGINT", () => {
  // Real-world: a first data frame self-stops, then the user hits
  // Ctrl-C. Both teardown paths fire `stopConnectingSpinner` →
  // `closeRefoldPoller`. The shell's `refoldPollerClosed` flag guards
  // against a double close.
  const poller = makeFakePoller([null]);
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    refoldProgressPoller: poller,
  });
  view.emitLifecycle("connecting", {});
  view.emit({ body: ["row"] });
  expect(poller.closes).toBe(1);

  // Swap process.on + exit, drive SIGINT.
  const realOn = process.on.bind(process);
  let captured: ((...args: unknown[]) => void) | null = null;
  (process as unknown as { on: typeof process.on }).on = ((
    event: string,
    handler: (...args: unknown[]) => void,
  ) => {
    if (event === "SIGINT") {
      captured = handler;
      return process;
    }
    return realOn(event as never, handler as never);
  }) as typeof process.on;

  const realExit = process.exit;
  (process as unknown as { exit: (code?: number) => never }).exit = ((
    _code?: number,
  ): never => {
    throw new Error("__SIGINT_EXIT__");
  }) as never;

  try {
    view.installSigintHandler(() => {});
    expect(() => captured?.()).toThrow("__SIGINT_EXIT__");
    // Close count must still be 1 — the SIGINT path observed
    // `refoldPollerClosed === true` and short-circuited.
    expect(poller.closes).toBe(1);
  } finally {
    (process as unknown as { exit: typeof process.exit }).exit = realExit;
    (process as unknown as { on: typeof process.on }).on = realOn;
  }
});

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
import { readFileSync } from "node:fs";
import {
  createFramesEmitter,
  type FramesEmitter,
  type FramesIo,
} from "../src/frames-emitter";
import type { BootStatus } from "../src/protocol";
import type { RefoldProgressPoller } from "../src/refold-progress";
import {
  armViewerExitTriggers,
  createViewShell,
  DEFAULT_SNAPSHOT_EMPTY_LINE,
  type FramesRunIo,
  snapshotBodyLines,
  type ViewerExitProc,
  type ViewRender,
  type ViewShell,
} from "../src/view-shell";

// ---------------------------------------------------------------------------
// Boot-status header factory for the readiness-gate tests. Sensible ready
// defaults (at head, seeded); overrides drive each branch.
// ---------------------------------------------------------------------------

function makeBoot(overrides: Partial<BootStatus> = {}): BootStatus {
  return {
    rev: 100,
    head_event_id: 100,
    catching_up: false,
    git_seed_required: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// setTimeout monkeypatch — the reconnect grace timer is a bare global
// `setTimeout` (distinct from the injected snapshot/frames timer seams). Mirror
// `patchIntervals`: capture callbacks + handles so a test can fire the grace
// synchronously, and honor `clearTimeout` so a cancelled grace never fires.
// ---------------------------------------------------------------------------

interface TimeoutCapture {
  callbacks: Array<() => void>;
  delays: number[];
  cleared: Set<number>;
  restore(): void;
  /** Fire the most-recently-armed timeout iff it was not cleared. */
  fireLast(): void;
}

function patchTimeouts(): TimeoutCapture {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const callbacks: Array<() => void> = [];
  const handles: number[] = [];
  const delays: number[] = [];
  const cleared = new Set<number>();
  let nextHandle = 1;

  globalThis.setTimeout = ((
    cb: () => void,
    delay?: number,
  ): ReturnType<typeof setTimeout> => {
    const handle = nextHandle++;
    callbacks.push(cb);
    handles.push(handle);
    delays.push(typeof delay === "number" ? delay : 0);
    return handle as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  globalThis.clearTimeout = ((handle?: unknown): void => {
    if (typeof handle === "number") {
      cleared.add(handle);
    }
  }) as typeof clearTimeout;

  return {
    callbacks,
    delays,
    cleared,
    restore(): void {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
    fireLast(): void {
      const i = callbacks.length - 1;
      if (i < 0) {
        throw new Error("no timeout armed — fireLast() before setTimeout()");
      }
      const handle = handles[i];
      if (handle !== undefined && !cleared.has(handle)) {
        callbacks[i]?.();
      }
    },
  };
}

function makeFakeMonotonicClock(initial = 0): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let value = initial;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
}

// Spy on a live view's banner `setStatus` — the reconnecting pill is a banner
// write (not a body write), so it doesn't surface on the passthrough stdout
// sink. The shell reads `liveShell.setStatus` by property, so reassigning it
// intercepts every call.
function spyStatus(v: ViewShell<{ body: string[] }>): string[] {
  const captured: string[] = [];
  const real = v.liveShell.setStatus.bind(v.liveShell);
  (v.liveShell as unknown as { setStatus: (s: string) => void }).setStatus = (
    s: string,
  ): void => {
    captured.push(s);
    real(s);
  };
  return captured;
}

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

test("first real emit self-stops the interval but keeps the poller open for a re-gate", () => {
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

  // The first data emit (daemon ready, no catch-up) clears the interval (Bun
  // setInterval has no .unref()) — the captured clearInterval handle matches
  // the one setInterval returned. The poller is NOT closed: the gate can re-arm
  // the indicator on a later daemon bounce, and a closed poller is dead for the
  // process lifetime, so its fd is released only on teardown.
  view.emit({ body: ["data row 1"] });
  expect(intervals.cleared).toHaveLength(1);
  expect(poller.closes).toBe(0);

  // A SECOND emit must not re-clear. The stop is idempotent.
  view.emit({ body: ["data row 2"] });
  expect(intervals.cleared).toHaveLength(1);
  expect(poller.closes).toBe(0);
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
  // No new poll — the tick self-stops on `!shouldShowIndicator()`. The poller
  // stays open (closed only on teardown), so the close count doesn't move.
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

test("poller.close() fires once on teardown (self-stop leaves it open)", () => {
  // Real-world: a first data frame self-stops the interval (poller stays open
  // for a possible re-gate), then the user hits Ctrl-C. The self-stop must NOT
  // close the poller; teardown closes it exactly once (the `refoldPollerClosed`
  // flag guards against a double close if paths co-fire).
  const poller = makeFakePoller([null]);
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    refoldProgressPoller: poller,
  });
  view.emitLifecycle("connecting", {});
  view.emit({ body: ["row"] });
  // Self-stop kept the poller open.
  expect(poller.closes).toBe(0);

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
    // The SIGINT teardown closes the poller exactly once.
    expect(poller.closes).toBe(1);
  } finally {
    (process as unknown as { exit: typeof process.exit }).exit = realExit;
    (process as unknown as { on: typeof process.on }).on = realOn;
  }
});

// ---------------------------------------------------------------------------
// fn-723: viewer self-exit triggers (SIGHUP / stdin-EOF / ppid===1 poll).
// `armViewerExitTriggers` takes an injectable `proc` so we never register
// real process-level handlers (which would tear the runner down) and can
// drive a faked ppid synchronously. The poll arms a real `globalThis.
// setInterval`, captured by the per-test `intervals` monkeypatch.
// ---------------------------------------------------------------------------

interface FakeProc {
  on: (event: string, handler: (...a: unknown[]) => void) => unknown;
  ppid: number;
  stdin: {
    on: (event: string, handler: (...a: unknown[]) => void) => unknown;
    removeListener: (event: string, handler: (...a: unknown[]) => void) => void;
    resume: () => void;
    isTTY?: boolean;
  };
  /** Fire a captured top-level handler (SIGHUP). */
  fire: (event: string, ...args: unknown[]) => void;
  /** Fire a captured stdin handler ('end' / 'error'). */
  fireStdin: (event: string, ...args: unknown[]) => void;
  resumed: boolean;
}

function makeFakeProc(opts: { ppid: number; isTTY?: boolean }): FakeProc {
  const handlers = new Map<string, (...a: unknown[]) => void>();
  const stdinHandlers = new Map<string, (...a: unknown[]) => void>();
  const proc: FakeProc = {
    ppid: opts.ppid,
    resumed: false,
    on(event, handler) {
      handlers.set(event, handler);
      return proc;
    },
    stdin: {
      isTTY: opts.isTTY,
      on(event, handler) {
        stdinHandlers.set(event, handler);
        return proc.stdin;
      },
      removeListener(event) {
        stdinHandlers.delete(event);
      },
      resume() {
        proc.resumed = true;
      },
    },
    fire(event, ...args) {
      handlers.get(event)?.(...args);
    },
    fireStdin(event, ...args) {
      stdinHandlers.get(event)?.(...args);
    },
  };
  return proc;
}

test("SIGHUP triggers a clean exit exactly once (idempotent tail)", () => {
  const proc = makeFakeProc({ ppid: 4242, isTTY: true });
  let exits = 0;
  // Mirror the real teardown shape: an idempotent tail.
  let toreDown = false;
  const exitCleanly = (): void => {
    if (toreDown) return;
    toreDown = true;
    exits++;
  };
  const { disarm } = armViewerExitTriggers(exitCleanly, {
    proc: proc as unknown as ViewerExitProc,
  });
  try {
    proc.fire("SIGHUP");
    proc.fire("SIGHUP"); // overlapping re-fire must NOT double-exit
    expect(exits).toBe(1);
  } finally {
    disarm();
  }
});

test("stdin-EOF triggers exit on a TTY (and resumes stdin so EOF fires)", () => {
  const proc = makeFakeProc({ ppid: 4242, isTTY: true });
  let exits = 0;
  const { disarm } = armViewerExitTriggers(() => exits++, {
    proc: proc as unknown as ViewerExitProc,
  });
  try {
    // A paused stdin never emits 'end'; the installer must resume it.
    expect(proc.resumed).toBe(true);
    proc.fireStdin("end");
    expect(exits).toBe(1);
  } finally {
    disarm();
  }
});

test("stdin-EOF is NOT armed on a non-TTY run (no mis-fire)", () => {
  const proc = makeFakeProc({ ppid: 4242, isTTY: false });
  let exits = 0;
  const { disarm } = armViewerExitTriggers(() => exits++, {
    proc: proc as unknown as ViewerExitProc,
  });
  try {
    // Non-TTY: stdin neither resumed nor wired — a natural pipe EOF must
    // not be treated as viewer death.
    expect(proc.resumed).toBe(false);
    proc.fireStdin("end");
    expect(exits).toBe(0);
  } finally {
    disarm();
  }
});

test("ppid===1 poll triggers exit when the viewer reparents to init", () => {
  const proc = makeFakeProc({ ppid: 4242, isTTY: true });
  let exits = 0;
  const { disarm } = armViewerExitTriggers(() => exits++, {
    proc: proc as unknown as ViewerExitProc,
    ppidPollMs: 2000,
  });
  try {
    // The poll arms via the captured global setInterval. The last-armed
    // interval is the ppid poll.
    expect(intervals.callbacks.length).toBeGreaterThanOrEqual(1);
    expect(intervals.delays[intervals.delays.length - 1]).toBe(2000);

    // Still parented to a live shell → tick is a no-op.
    intervals.tick();
    expect(exits).toBe(0);

    // Parent dies → reparent to init → next tick self-exits.
    proc.ppid = 1;
    intervals.tick();
    expect(exits).toBe(1);
  } finally {
    disarm();
  }
});

test("a live, attached viewer (ppid!=1, TTY) does NOT exit on a poll tick", () => {
  const proc = makeFakeProc({ ppid: 4242, isTTY: true });
  let exits = 0;
  const { disarm } = armViewerExitTriggers(() => exits++, {
    proc: proc as unknown as ViewerExitProc,
  });
  try {
    intervals.tick();
    intervals.tick();
    expect(exits).toBe(0);
  } finally {
    disarm();
  }
});

test("launch-time ppid===1 guard disables the poll (no false-exit on detached launch)", () => {
  // A legitimately detached launch is born init-owned. The ppid poll can't
  // tell that apart from a post-death reparent, so it must be disabled.
  const proc = makeFakeProc({ ppid: 1, isTTY: true });
  let exits = 0;
  const armedBefore = intervals.callbacks.length;
  const { disarm } = armViewerExitTriggers(() => exits++, {
    proc: proc as unknown as ViewerExitProc,
  });
  try {
    // No new poll interval armed (SIGHUP + stdin still wired).
    expect(intervals.callbacks.length).toBe(armedBefore);
    // SIGHUP still works — only the ppid poll is suppressed.
    proc.fire("SIGHUP");
    expect(exits).toBe(1);
  } finally {
    disarm();
  }
});

test("disarm() clears the ppid poll interval", () => {
  const proc = makeFakeProc({ ppid: 4242, isTTY: true });
  const clearedBefore = intervals.cleared.length;
  const { disarm } = armViewerExitTriggers(() => {}, {
    proc: proc as unknown as ViewerExitProc,
  });
  disarm();
  expect(intervals.cleared.length).toBe(clearedBefore + 1);
});

// ---------------------------------------------------------------------------
// fn-772: snapshot mode. A non-TTY / `--snapshot` run captures the first
// ready composite, prints it + a `keeper-meta:` trailer, disposes the
// subscription, and exits — no live shell, no connecting spinner. We drive
// it with the injectable `snapshotIo` (captured stdout/stderr sinks, a
// fake `exit` recorder, a captured latch timer) so neither `process.exit`
// nor a real 2s timer escapes into the runner.
// ---------------------------------------------------------------------------

interface SnapshotHarness {
  stdout: string[];
  stderr: string[];
  exits: number[];
  disposed: number;
  fireTimeout: () => void;
  timeoutCleared: number;
  io: import("../src/view-shell").SnapshotIo;
}

function makeSnapshotHarness(): SnapshotHarness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  let timeoutCb: (() => void) | null = null;
  let timeoutCleared = 0;
  const h: SnapshotHarness = {
    stdout,
    stderr,
    exits,
    disposed: 0,
    fireTimeout(): void {
      timeoutCb?.();
    },
    get timeoutCleared() {
      return timeoutCleared;
    },
    io: {
      stdoutWrite: (s) => stdout.push(s),
      stderrWrite: (s) => stderr.push(s),
      exit: ((code: number): never => {
        exits.push(code);
        // Throw to stop execution exactly where `process.exit` would — the
        // caller's `runSnapshot` returns void, so a thrower mirrors the
        // never-return contract under bun:test.
        throw new Error(`__SNAPSHOT_EXIT_${code}__`);
      }) as (code: number) => never,
      nowIso: () => "2026-06-10T00:00:00.000Z",
      setTimeoutFn: (cb) => {
        timeoutCb = cb;
        return 1;
      },
      clearTimeoutFn: () => {
        timeoutCleared += 1;
      },
    },
  };
  return h;
}

function parseSnapshotTrailer(joined: string): Record<string, unknown> {
  const lines = joined.split("\n").filter((l) => l.length > 0);
  const last = lines.at(-1);
  if (last === undefined) throw new Error("no stdout");
  expect(last.startsWith("keeper-meta: ")).toBe(true);
  return JSON.parse(last.slice("keeper-meta: ".length)) as Record<
    string,
    unknown
  >;
}

test("snapshot: first ready composite prints frame + keeper-meta: line, exits 0", () => {
  const h = makeSnapshotHarness();
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    mode: "snapshot",
    streamCount: 1,
    snapshotIo: h.io,
  });

  // A lifecycle event in snapshot mode must NOT arm the connecting spinner.
  view.emitLifecycle("connecting", {});
  expect(intervals.callbacks).toHaveLength(0);

  // The single stream's first frame.
  view.emit({ body: ["worktree a", "worktree b"] });

  // runSnapshot resolves synchronously (latch satisfied) — the exit
  // thrower fires from inside it.
  expect(() =>
    view?.runSnapshot(() => {
      h.disposed += 1;
    }),
  ).toThrow("__SNAPSHOT_EXIT_0__");

  expect(h.exits).toEqual([0]);
  expect(h.disposed).toBe(1);
  // Still no spinner interval armed across the whole run.
  expect(intervals.callbacks).toHaveLength(0);

  const joined = h.stdout.join("");
  expect(joined).toContain("worktree a");
  expect(joined).toContain("worktree b");
  const trailer = parseSnapshotTrailer(joined);
  expect(trailer.status).toBe("ok");
  expect(trailer.frame).toBe(1);
  expect(trailer.truncated).toBe(false);
  // 2: SNAPSHOT_SCHEMA_VERSION as of the catching_up field's addition.
  expect(trailer.schema_version).toBe(2);
  expect(typeof trailer.state).toBe("string");
});

test("snapshot: empty-but-healthy projection still emits a frame and exits 0", () => {
  const h = makeSnapshotHarness();
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    mode: "snapshot",
    streamCount: 1,
    snapshotIo: h.io,
  });
  view.emitLifecycle("connected", {});
  // An empty collection still delivers a first `onRows([])` → emit with an
  // empty/placeholder body. Healthy daemon, zero rows → a real frame.
  view.emit({ body: ["no changes"] });
  expect(() =>
    view?.runSnapshot(() => {
      h.disposed += 1;
    }),
  ).toThrow("__SNAPSHOT_EXIT_0__");
  expect(h.exits).toEqual([0]);
  const trailer = parseSnapshotTrailer(h.stdout.join(""));
  expect(trailer.status).toBe("ok");
  expect(trailer.frame).toBe(1);
});

// snapshotBodyLines — the honest-empty normalizer. A zero-line render becomes
// the single stand-in line so a snapshot frame is never bare separators; a
// populated render passes through untouched.
test("snapshotBodyLines — zero lines becomes the honest-empty line", () => {
  expect(snapshotBodyLines([], "idle — nothing here")).toEqual([
    "idle — nothing here",
  ]);
});

test("snapshotBodyLines — a populated render passes through untouched", () => {
  const rows = ["--- current ---", "work::fn-1.2"];
  expect(snapshotBodyLines(rows, "idle — nothing here")).toEqual(rows);
});

test("snapshot: an empty render writes a real frame (honest-empty line), never bare separators", () => {
  const h = makeSnapshotHarness();
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    mode: "snapshot",
    streamCount: 1,
    snapshotIo: h.io,
    snapshotEmptyLine: "idle — no rows",
  });
  view.emitLifecycle("connected", {});
  // Healthy daemon, zero body lines (idle projection) — the first ready emit.
  view.emit({ body: [] });
  expect(() =>
    view?.runSnapshot(() => {
      h.disposed += 1;
    }),
  ).toThrow("__SNAPSHOT_EXIT_0__");
  expect(h.exits).toEqual([0]);

  // stdout frame carries the honest-empty line (not an empty frame).
  const joined = h.stdout.join("");
  expect(joined).toContain("idle — no rows");
  const trailer = parseSnapshotTrailer(joined);
  expect(trailer.status).toBe("ok");
  expect(trailer.frame).toBe(1);

  // The sidecar frame file is `---` + the honest-empty line — never a bare
  // `---` separator alone.
  const frameSidecar = `/tmp/keeper-${sidecarBase}.${process.pid}.frame.1.txt`;
  const frameText = readFileSync(frameSidecar, "utf8");
  expect(frameText).toBe("---\nidle — no rows\n");
  expect(frameText.trim()).not.toBe("---");
});

test("snapshot: an empty render with no custom line falls back to the default honest-empty line", () => {
  const h = makeSnapshotHarness();
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    mode: "snapshot",
    streamCount: 1,
    snapshotIo: h.io,
  });
  view.emitLifecycle("connected", {});
  view.emit({ body: [] });
  expect(() =>
    view?.runSnapshot(() => {
      h.disposed += 1;
    }),
  ).toThrow("__SNAPSHOT_EXIT_0__");
  expect(h.stdout.join("")).toContain(DEFAULT_SNAPSHOT_EMPTY_LINE);
});

test("snapshot: timeout with 0 streams reported → frame:null on stdout, diagnostic on stderr, exit 1", () => {
  const h = makeSnapshotHarness();
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    mode: "snapshot",
    streamCount: 1,
    snapshotIo: h.io,
  });
  // No `connected`, no `emit` — fire the timeout. daemon-unreachable.
  view.runSnapshot(() => {
    h.disposed += 1;
  });
  expect(() => h.fireTimeout()).toThrow("__SNAPSHOT_EXIT_1__");

  expect(h.exits).toEqual([1]);
  expect(h.disposed).toBe(1);
  // stderr carries the human diagnostic; stdout still carries a parseable
  // keeper-meta: line with frame:null.
  expect(h.stderr.join("")).toContain("no frame");
  const trailer = parseSnapshotTrailer(h.stdout.join(""));
  expect(trailer.frame).toBeNull();
  expect(trailer.status).toBe("daemon-unreachable");
  expect(trailer.truncated).toBe(true);
});

test("snapshot: connected-then-timeout (no frame) reports status:timeout", () => {
  const h = makeSnapshotHarness();
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    mode: "snapshot",
    streamCount: 1,
    snapshotIo: h.io,
  });
  view.emitLifecycle("connected", {});
  view.runSnapshot(() => {
    h.disposed += 1;
  });
  expect(() => h.fireTimeout()).toThrow("__SNAPSHOT_EXIT_1__");
  expect(h.exits).toEqual([1]);
  const trailer = parseSnapshotTrailer(h.stdout.join(""));
  expect(trailer.status).toBe("timeout");
  expect(trailer.frame).toBeNull();
});

test("snapshot: timeout-degrade with a partial composite emits truncated:true, exit 0", () => {
  const h = makeSnapshotHarness();
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    // 2 streams — only one will report before the timeout.
    mode: "snapshot",
    streamCount: 2,
    snapshotIo: h.io,
  });
  view.emitLifecycle("connected", {});
  view.emit({ body: ["partial composite"] }); // 1 of 2 streams
  view.runSnapshot(() => {
    h.disposed += 1;
  });
  // Latch not satisfied (2 needed, 1 reported) → still pending; fire timeout.
  expect(() => h.fireTimeout()).toThrow("__SNAPSHOT_EXIT_0__");
  expect(h.exits).toEqual([0]);
  const joined = h.stdout.join("");
  expect(joined).toContain("partial composite");
  const trailer = parseSnapshotTrailer(joined);
  expect(trailer.status).toBe("ok");
  expect(trailer.truncated).toBe(true);
  expect(trailer.frame).toBe(1);
});

test("snapshot: a frame racing the timeout resolves exactly once (no double-exit)", () => {
  const h = makeSnapshotHarness();
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    mode: "snapshot",
    streamCount: 1,
    snapshotIo: h.io,
  });
  view.emit({ body: ["row"] });
  // Latch satisfied synchronously on runSnapshot → exit 0.
  expect(() =>
    view?.runSnapshot(() => {
      h.disposed += 1;
    }),
  ).toThrow("__SNAPSHOT_EXIT_0__");
  expect(h.exits).toEqual([0]);
  // A late timeout fire after settle is a no-op — no second exit.
  h.fireTimeout();
  expect(h.exits).toEqual([0]);
});

// ---------------------------------------------------------------------------
// fn-772 (task .2): multi-stream `reportSnapshotStream` — the latch holds the
// snapshot until EVERY subscribed stream reports its first frame. `view.emit`
// auto-reports the FIRST stream (covers single-stream git/jobs); a
// multi-stream view (board=2, autopilot=4) wires each ADDITIONAL stream's
// first data callback into `reportSnapshotStream` so the captured composite
// is fully folded, not ordering-luck. These drive the latch synchronously via
// the injected timer harness, mirroring the single-stream cases above.
// ---------------------------------------------------------------------------

test("snapshot multi-stream: latch holds until BOTH streams report (board, streamCount 2)", () => {
  const h = makeSnapshotHarness();
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    mode: "snapshot",
    streamCount: 2,
    snapshotIo: h.io,
  });
  // Stream 1 (readiness): the first emit auto-reports.
  view.emit({ body: ["epic block", "[armed]"] });
  view.runSnapshot(() => {
    h.disposed += 1;
  });
  // Only 1 of 2 reported — NOT settled yet (no exit, timer still live).
  expect(h.exits).toEqual([]);
  expect(h.timeoutCleared).toBe(0);
  // Stream 2 (armed_epics): the explicit report satisfies the latch → exit 0,
  // ready (truncated:false), and the timer is cleared.
  expect(() => view?.reportSnapshotStream()).toThrow("__SNAPSHOT_EXIT_0__");
  expect(h.exits).toEqual([0]);
  expect(h.disposed).toBe(1);
  // The timer is cleared on the ready path (idempotent — the latch's own
  // resolve + runSnapshot's finish both clear it; at least once).
  expect(h.timeoutCleared).toBeGreaterThanOrEqual(1);
  const joined = h.stdout.join("");
  // The `[armed]` pill is deterministically present (the latch held for it).
  expect(joined).toContain("[armed]");
  const trailer = parseSnapshotTrailer(joined);
  expect(trailer.status).toBe("ok");
  expect(trailer.truncated).toBe(false);
  expect(trailer.frame).toBe(1);
});

test("snapshot multi-stream: a secondary report BEFORE runSnapshot is buffered + replayed", () => {
  const h = makeSnapshotHarness();
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    mode: "snapshot",
    streamCount: 2,
    snapshotIo: h.io,
  });
  // Both streams report BEFORE runSnapshot arms the latch — the primary via
  // `emit`'s auto-report buffer (`latchReported`) and the secondary via the
  // `pendingExtraReports` buffer. runSnapshot must replay BOTH so the snapshot
  // resolves synchronously without waiting out the timeout.
  view.emit({ body: ["composite row"] });
  view.reportSnapshotStream();
  expect(() =>
    view?.runSnapshot(() => {
      h.disposed += 1;
    }),
  ).toThrow("__SNAPSHOT_EXIT_0__");
  expect(h.exits).toEqual([0]);
  const trailer = parseSnapshotTrailer(h.stdout.join(""));
  expect(trailer.truncated).toBe(false);
  expect(trailer.status).toBe("ok");
});

test("snapshot multi-stream: all four streams report (autopilot, streamCount 4)", () => {
  const h = makeSnapshotHarness();
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    mode: "snapshot",
    streamCount: 4,
    snapshotIo: h.io,
  });
  // Stream 1 (readiness) auto-reports via emit; the other three report
  // explicitly. The latch must hold until ALL FOUR land.
  view.emit({ body: ["folded mode + armed + failed"] });
  view.runSnapshot(() => {
    h.disposed += 1;
  });
  expect(h.exits).toEqual([]); // 1/4
  view.reportSnapshotStream(); // dispatch_failures → 2/4
  expect(h.exits).toEqual([]);
  view.reportSnapshotStream(); // autopilot_state → 3/4
  expect(h.exits).toEqual([]);
  // armed_epics → 4/4 → satisfied, exit 0.
  expect(() => view?.reportSnapshotStream()).toThrow("__SNAPSHOT_EXIT_0__");
  expect(h.exits).toEqual([0]);
  const trailer = parseSnapshotTrailer(h.stdout.join(""));
  expect(trailer.status).toBe("ok");
  expect(trailer.truncated).toBe(false);
});

test("snapshot multi-stream: partial composite on timeout marks truncated:true (streamCount 4, 2 reported)", () => {
  const h = makeSnapshotHarness();
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    mode: "snapshot",
    streamCount: 4,
    snapshotIo: h.io,
  });
  view.emit({ body: ["partial 1/4"] }); // stream 1 (auto)
  view.runSnapshot(() => {
    h.disposed += 1;
  });
  view.reportSnapshotStream(); // 2/4 — still short of 4
  expect(h.exits).toEqual([]);
  // The timeout fires with a partial composite (≥1 reported) → exit 0,
  // truncated:true (a degrade, not a no-frame).
  expect(() => h.fireTimeout()).toThrow("__SNAPSHOT_EXIT_0__");
  expect(h.exits).toEqual([0]);
  const trailer = parseSnapshotTrailer(h.stdout.join(""));
  expect(trailer.status).toBe("ok");
  expect(trailer.truncated).toBe(true);
  expect(trailer.frame).toBe(1);
});

test("snapshot: reportSnapshotStream is inert in live mode (no latch armed)", () => {
  // In live mode no latch is armed; `reportSnapshotStream` must be a safe
  // no-op so the shared subscription wiring can call it unconditionally.
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    mode: "live",
  });
  expect(() => view?.reportSnapshotStream()).not.toThrow();
});

// ---------------------------------------------------------------------------
// fn-1161: frames mode. Each accepted frame (after the byte-compare gate)
// becomes one NDJSON envelope through the injected emitter instead of
// painting; the max-frames / duration bounds and an interrupt all flush a
// terminal trailer as the FINAL line. We drive it with a real
// `createFramesEmitter` over captured sinks + a fake clock, and a
// `FramesRunIo` that injects the exit / timer / process seams so neither
// `process.exit` nor a real handler escapes into the runner.
// ---------------------------------------------------------------------------

interface FramesHarness {
  stdout: string[];
  exits: number[];
  setNow: (ms: number) => void;
  fireTimeout: () => void;
  timeoutClears: () => number;
  makeEmitter: (o?: {
    maxFrames?: number | null;
    durationMs?: number | null;
  }) => FramesEmitter;
  runIo: FramesRunIo;
  records: () => Array<Record<string, unknown>>;
}

function makeFramesHarness(proc?: ViewerExitProc): FramesHarness {
  const stdout: string[] = [];
  const exits: number[] = [];
  let now = 0;
  let timeoutCb: (() => void) | null = null;
  let timeoutClears = 0;
  const io: FramesIo = {
    // Sidecar writes are irrelevant to the wire contract under test — no-op
    // them so the pure tier writes zero files.
    writeFile: () => {},
    unlink: () => {},
    nowIso: () => "2026-06-10T00:00:00.000Z",
    nowMs: () => now,
  };
  const runIo: FramesRunIo = {
    exit: ((code: number): never => {
      exits.push(code);
      // Throw to stop execution exactly where `process.exit` would.
      throw new Error(`__FRAMES_EXIT_${code}__`);
    }) as (code: number) => never,
    setTimeoutFn: (cb) => {
      timeoutCb = cb;
      return 1;
    },
    clearTimeoutFn: () => {
      timeoutClears += 1;
    },
    ...(proc === undefined ? {} : { proc }),
  };
  return {
    stdout,
    exits,
    setNow: (ms) => {
      now = ms;
    },
    fireTimeout: () => timeoutCb?.(),
    timeoutClears: () => timeoutClears,
    makeEmitter: (o = {}) =>
      createFramesEmitter({
        view: "board",
        writeStdout: (line) => stdout.push(line),
        diffFn: () => "@@ fake diff @@\n",
        io,
        maxFrames: o.maxFrames ?? null,
        durationMs: o.durationMs ?? null,
      }),
    runIo,
    records: () =>
      stdout.map((l) => JSON.parse(l.trim()) as Record<string, unknown>),
  };
}

test("frames: envelopes carry monotonic contiguous seq + the freshest cursor", () => {
  const h = makeFramesHarness();
  const emitter = h.makeEmitter();
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    mode: "frames",
    frames: { emitter, io: h.runIo },
  });

  // A lifecycle event in frames mode must NOT arm the connecting spinner
  // (its overlay would corrupt the NDJSON stream).
  view.emitLifecycle("connecting", {});
  expect(intervals.callbacks).toHaveLength(0);

  view.noteCursor("42");
  expect(view.emit({ body: ["a"] })).toBe(true); // baseline
  expect(view.emit({ body: ["a", "b"] })).toBe(true); // frame
  view.noteCursor("43");
  expect(view.emit({ body: ["a", "b", "c"] })).toBe(true); // frame, new cursor
  // An unchanged body is suppressed by the byte-compare gate — no envelope,
  // no seq bump (a multi-stream view's redundant re-emit can't inflate the
  // frame / coverage accounting).
  expect(view.emit({ body: ["a", "b", "c"] })).toBe(false);

  const recs = h.records();
  expect(recs.map((r) => r.type)).toEqual(["baseline", "frame", "frame"]);
  expect(recs.map((r) => r.seq)).toEqual([0, 1, 2]);
  expect(recs.map((r) => r.cursor)).toEqual(["42", "42", "43"]);
  expect(recs.every((r) => r.view === "board")).toBe(true);
  // 2: FRAMES_SCHEMA_VERSION as of the catching_up field's addition.
  expect(recs.every((r) => r.schema_version === 2)).toBe(true);
});

test("frames: max-frames bound terminates with a trailer as the final line", () => {
  const h = makeFramesHarness();
  const emitter = h.makeEmitter({ maxFrames: 2 });
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    mode: "frames",
    frames: { emitter, io: h.runIo },
  });
  view.noteCursor("7");
  view.emit({ body: ["a"] }); // baseline (not counted toward maxFrames)
  view.emit({ body: ["a", "b"] }); // data frame 1
  // The 2nd data frame trips the bound → the trailer flushes + exit fires
  // from inside `emit`.
  expect(() => view?.emit({ body: ["a", "b", "c"] })).toThrow(
    "__FRAMES_EXIT_0__",
  );
  expect(h.exits).toEqual([0]);

  const recs = h.records();
  const last = recs.at(-1);
  expect(last?.type).toBe("trailer");
  expect(last?.reason).toBe("max_frames");
  expect(last?.frames_emitted).toBe(2);
  expect(last?.resume_cursor).toBe("7");
  expect(last?.coverage).toBe("continuous");
  // seq stays contiguous across ALL record types: baseline 0, frames 1+2,
  // trailer 3.
  expect(last?.seq).toBe(3);
});

test("frames: the duration bound flushes a trailer when the stream goes quiet", () => {
  const proc = makeFakeProc({ ppid: 4242, isTTY: false });
  const h = makeFramesHarness(proc as unknown as ViewerExitProc);
  const emitter = h.makeEmitter({ durationMs: 10_000 });
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    mode: "frames",
    frames: { emitter, durationMs: 10_000, io: h.runIo },
  });
  view.noteCursor("5");
  view.emit({ body: ["a"] }); // baseline
  view.runFrames(() => {}); // arms the duration teardown timer

  // Fire the captured duration timer → a `duration` trailer, exit 0.
  expect(() => h.fireTimeout()).toThrow("__FRAMES_EXIT_0__");
  const last = h.records().at(-1);
  expect(last?.type).toBe("trailer");
  expect(last?.reason).toBe("duration");
  expect(last?.resume_cursor).toBe("5");
  expect(last?.frames_emitted).toBe(0);
});

test("frames: an interrupt flushes the trailer as the final line, once", () => {
  const proc = makeFakeProc({ ppid: 4242, isTTY: false });
  const h = makeFramesHarness(proc as unknown as ViewerExitProc);
  const emitter = h.makeEmitter();
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    mode: "frames",
    frames: { emitter, io: h.runIo },
  });
  view.noteCursor("9");
  view.emit({ body: ["hello"] }); // baseline
  view.emit({ body: ["hello", "world"] }); // frame
  let disposed = 0;
  view.runFrames(() => {
    disposed += 1;
  });

  // SIGINT during the run → the trailer is the final line.
  expect(() => proc.fire("SIGINT")).toThrow("__FRAMES_EXIT_0__");
  expect(disposed).toBe(1);
  const last = h.records().at(-1);
  expect(last?.type).toBe("trailer");
  expect(last?.reason).toBe("interrupt");
  expect(last?.resume_cursor).toBe("9");
  expect(last?.frames_emitted).toBe(1);

  // Idempotent: a re-fired interrupt must NOT emit a second trailer / re-exit.
  proc.fire("SIGINT");
  expect(h.records().filter((r) => r.type === "trailer")).toHaveLength(1);
  expect(h.exits).toEqual([0]);
});

test("frames: a reconnect downgrades the trailer coverage to gap_possible", () => {
  const proc = makeFakeProc({ ppid: 4242, isTTY: false });
  const h = makeFramesHarness(proc as unknown as ViewerExitProc);
  const emitter = h.makeEmitter();
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    mode: "frames",
    frames: { emitter, io: h.runIo },
  });
  view.noteCursor("2");
  view.emit({ body: ["a"] }); // baseline, one uninterrupted run so far
  // A disconnect is the sole gap source the emitter's contiguous seq can't
  // see — it must downgrade coverage.
  view.emitLifecycle("disconnected", {});
  view.runFrames(() => {});
  expect(() => proc.fire("SIGINT")).toThrow("__FRAMES_EXIT_0__");

  const last = h.records().at(-1);
  expect(last?.type).toBe("trailer");
  expect(last?.coverage).toBe("gap_possible");
});

test("frames: reportSnapshotStream is inert (no coverage accounting to drift)", () => {
  const h = makeFramesHarness();
  const emitter = h.makeEmitter();
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    mode: "frames",
    frames: { emitter, io: h.runIo },
  });
  view.noteCursor("1");
  expect(view.emit({ body: ["x"] })).toBe(true); // baseline emitted exactly once
  // A multi-stream view's secondary reports are no-ops in frames mode.
  expect(() => view?.reportSnapshotStream()).not.toThrow();
  view.reportSnapshotStream();
  const recs = h.records();
  expect(recs).toHaveLength(1);
  expect(recs[0]?.type).toBe("baseline");
});

// ---------------------------------------------------------------------------
// Live-mode daemon-readiness gate. A catch-up-reporting result holds the data
// frame behind the loading indicator; the ready flip paints the held frame.
// A post-paint disconnect retains the frame through grace, then presents retry
// timing and eventually an age-based DISCONNECTED warning. The re-fold
// percentage never regresses across the poller→wire switch.
// ---------------------------------------------------------------------------

test("live gate: a catch-up result holds the frame and paints the re-fold indicator; the flip paints it", () => {
  const poller = makeFakePoller([]); // wire header drives the branch; poller unused
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    refoldProgressPoller: poller,
  });
  view.emitLifecycle("connecting", {});
  // Daemon reports catch-up with the fold cursor well behind head.
  view.noteCatchingUp(
    true,
    makeBoot({ rev: 20, head_event_id: 100, catching_up: true }),
  );

  // A data emit while gated paints NOTHING — the composite is held.
  expect(view.emit({ body: ["real data row"] })).toBe(false);
  expect(stdoutCap.writes.join("")).not.toContain("real data row");

  // The indicator tick renders the re-fold % straight from the wire header —
  // the sqlite poller is never touched while a header is present.
  intervals.tick();
  let joined = stdoutCap.writes.join("");
  expect(joined).toContain("re-folding event log");
  expect(joined).toContain("20.0%");
  expect(poller.polls).toBe(0);

  // Flip to ready → the held frame paints immediately.
  view.noteCatchingUp(
    false,
    makeBoot({ rev: 100, head_event_id: 100, catching_up: false }),
  );
  joined = stdoutCap.writes.join("");
  expect(joined).toContain("real data row");
  expect(view.getFrameCount()).toBe(1);
});

test("live gate: the git-seed branch renders the roots, and generic wording when the roots list is empty", () => {
  const poller = makeFakePoller([]);
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    refoldProgressPoller: poller,
  });
  view.emitLifecycle("connecting", {});
  // At head, git seed pending, roots present.
  view.noteCatchingUp(
    true,
    makeBoot({
      rev: 50,
      head_event_id: 50,
      catching_up: true,
      git_seed_required: true,
      git_unseeded_roots: ["/repo/a", "/repo/b"],
    }),
  );
  intervals.tick();
  expect(stdoutCap.writes.at(-1)).toContain(
    "waiting for git seed: /repo/a, /repo/b",
  );

  // Empty roots → generic wording (no colon, no roots list).
  view.noteCatchingUp(
    true,
    makeBoot({
      rev: 50,
      head_event_id: 50,
      catching_up: true,
      git_seed_required: true,
      git_unseeded_roots: [],
    }),
  );
  intervals.tick();
  const lastWrite = stdoutCap.writes.at(-1) ?? "";
  expect(lastWrite).toContain("waiting for git seed");
  expect(lastWrite).not.toContain(":");
});

test("live gate: the residual catching-up window renders a plain 'catching up…' line", () => {
  const poller = makeFakePoller([]);
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    refoldProgressPoller: poller,
  });
  view.emitLifecycle("connecting", {});
  // At head, no git seed pending, still catching up (the settling window).
  view.noteCatchingUp(
    true,
    makeBoot({
      rev: 100,
      head_event_id: 100,
      catching_up: true,
      git_seed_required: false,
    }),
  );
  intervals.tick();
  expect(stdoutCap.writes.at(-1)).toContain("catching up…");
});

test("live gate: the re-fold percentage never regresses across the poller→wire source switch", () => {
  // Cold start: the sqlite poller reports 40% (no wire header yet).
  const poller = makeFakePoller([{ cursor: 400, max: 1000 }]);
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    refoldProgressPoller: poller,
  });
  view.emitLifecycle("connecting", {});
  intervals.tick();
  expect(stdoutCap.writes.join("")).toContain("40.0%");

  // The wire header now reports a LOWER raw fraction (30%) on the same head —
  // the display clamps up to the 40% floor instead of regressing.
  view.noteCatchingUp(
    true,
    makeBoot({ rev: 300, head_event_id: 1000, catching_up: true }),
  );
  intervals.tick();
  const joined = stdoutCap.writes.join("");
  expect(joined).not.toContain("30.0%");
  expect(joined).toContain("40.0%");
});

test("live gate: grace holds the frame, then retrying counts down before frame age becomes long-dead", () => {
  const timeouts = patchTimeouts();
  const clock = makeFakeMonotonicClock();
  try {
    view = createViewShell<{ body: string[] }>({
      script: sidecarBase,
      renderBody,
      monotonicNow: clock.now,
      refoldProgressPoller: makeFakePoller([]),
    });
    const status = spyStatus(view);

    view.emit({ body: ["live data"] });
    view.emitLifecycle("disconnected", {});
    expect(status.at(-1)).toBe("reconnecting…");
    expect(intervals.callbacks).toHaveLength(0);

    clock.advance(1500);
    timeouts.fireLast();
    expect(status.at(-1)).toBe("retrying…");
    view.emitLifecycle("waiting", { attempt: 3, retry_in_ms: 800 });
    expect(status.at(-1)).toBe("retrying · attempt 3 · retry in 0.8s");
    expect(intervals.callbacks).toHaveLength(1);

    clock.advance(300);
    intervals.tick();
    expect(status.at(-1)).toBe("retrying · attempt 3 · retry in 0.5s");
    expect(stdoutCap.writes.at(-1)).toContain("live data");

    clock.advance(3200);
    intervals.tick();
    expect(status.at(-1)).toBe("DISCONNECTED · last good frame 5s ago");
    const lastWrite = stdoutCap.writes.at(-1) ?? "";
    expect(lastWrite).toContain("live data");
    expect(lastWrite).toContain("DISCONNECTED");
  } finally {
    timeouts.restore();
  }
});

test("live gate: long-dead age advances by the monotonic frame clock, not socket lifecycle", () => {
  const timeouts = patchTimeouts();
  const clock = makeFakeMonotonicClock();
  try {
    view = createViewShell<{ body: string[] }>({
      script: sidecarBase,
      renderBody,
      monotonicNow: clock.now,
      refoldProgressPoller: makeFakePoller([]),
    });
    const status = spyStatus(view);
    view.emit({ body: ["last good data"] });
    view.emitLifecycle("disconnected", {});
    clock.advance(1500);
    timeouts.fireLast();
    view.emitLifecycle("waiting", { attempt: 1, retry_in_ms: 1000 });

    clock.advance(3500);
    intervals.tick();
    expect(status.at(-1)).toBe("DISCONNECTED · last good frame 5s ago");
    expect(stdoutCap.writes.at(-1)).toContain("last good data");

    // A transport-open event is not a fresh frame and cannot reset its age.
    view.emitLifecycle("connected", {});
    clock.advance(2000);
    intervals.tick();
    expect(status.at(-1)).toBe("DISCONNECTED · last good frame 7s ago");
  } finally {
    timeouts.restore();
  }
});

test("live gate: a transient flash cannot clobber the grace or retrying banner", () => {
  const timeouts = patchTimeouts();
  const poller = makeFakePoller([], null);
  try {
    view = createViewShell<{ body: string[] }>({
      script: sidecarBase,
      renderBody,
      refoldProgressPoller: poller,
    });
    const status = spyStatus(view);

    view.emit({ body: ["live data"] });
    view.emitLifecycle("disconnected", {});
    expect(status.at(-1)).toBe("reconnecting…");

    // A caller-driven flash during the pre-grace pill window is dropped —
    // the pill stays exactly as-is (no new status write at all).
    const beforePreGrace = status.length;
    view.flashStatus("[copied frame 1]");
    expect(status.length).toBe(beforePreGrace);
    expect(status.at(-1)).toBe("reconnecting…");

    // Grace expiry promotes the banner to retrying, which owns the same slot.
    timeouts.fireLast();
    expect(status.at(-1)).toBe("retrying…");

    const beforePostGrace = status.length;
    view.flashStatus("[copied frame 2]");
    expect(status.length).toBe(beforePostGrace);
    expect(status.at(-1)).toBe("retrying…");
  } finally {
    timeouts.restore();
  }
});

test("live gate: a ready paint clears retrying and its countdown", () => {
  const timeouts = patchTimeouts();
  const poller = makeFakePoller([], null);
  try {
    view = createViewShell<{ body: string[] }>({
      script: sidecarBase,
      renderBody,
      refoldProgressPoller: poller,
    });
    const status = spyStatus(view);

    view.emit({ body: ["live data"] });
    view.emitLifecycle("disconnected", {});
    view.emitLifecycle("waiting", { attempt: 2, retry_in_ms: 500 });
    timeouts.fireLast();
    expect(status.at(-1)).toBe("retrying · attempt 2 · retry in 0.5s");

    // A fresh ready frame clears the retry state and repaints normally.
    expect(view.emit({ body: ["fresh data"] })).toBe(true);
    expect(status.at(-1)).toBe("");
    const joined = stdoutCap.writes.join("");
    expect(joined).toContain("fresh data");
  } finally {
    timeouts.restore();
  }
});

test("live gate: a sub-grace reconnect keeps the last frame with no indicator flicker", () => {
  const timeouts = patchTimeouts();
  const poller = makeFakePoller([], null);
  try {
    view = createViewShell<{ body: string[] }>({
      script: sidecarBase,
      renderBody,
      refoldProgressPoller: poller,
    });
    const status = spyStatus(view);

    view.emit({ body: ["live data"] });
    view.emitLifecycle("disconnected", {});
    expect(status).toContain("reconnecting…");
    const writesBefore = stdoutCap.writes.length;

    // Reconnect (ready) BEFORE the grace fires — an identical frame is
    // byte-suppressed (no churn repaint), the grace is cancelled, the pill cleared.
    expect(view.emit({ body: ["live data"] })).toBe(false);
    expect(timeouts.cleared.size).toBeGreaterThanOrEqual(1);
    expect(stdoutCap.writes.length).toBe(writesBefore);
    expect(stdoutCap.writes.join("")).not.toContain("re-folding event log");
    expect(stdoutCap.writes.join("")).not.toContain("connecting to keeperd");
    // The banner was restored (pill cleared) — no persistent pill provider ⇒ "".
    expect(status.at(-1)).toBe("");
  } finally {
    timeouts.restore();
  }
});

test("live gate: a generation re-baseline without a transport drop leaves no connection banner", () => {
  const clock = makeFakeMonotonicClock();
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    monotonicNow: clock.now,
    refoldProgressPoller: makeFakePoller([]),
  });
  const status = spyStatus(view);
  view.emit({ body: ["steady data"] });
  clock.advance(10_000);

  // A ready boot header and byte-identical frame are a generation re-baseline,
  // not a transport drop, so no grace/retry/dead presentation is armed.
  view.noteCatchingUp(false, makeBoot());
  expect(view.emit({ body: ["steady data"] })).toBe(false);
  expect(status).toEqual([]);
  expect(stdoutCap.writes).toHaveLength(1);
});

test("live gate: a reconnect reporting catch-up flips to the indicator immediately (before grace)", () => {
  const timeouts = patchTimeouts();
  const poller = makeFakePoller([{ cursor: 3, max: 10 }], {
    cursor: 3,
    max: 10,
  });
  try {
    view = createViewShell<{ body: string[] }>({
      script: sidecarBase,
      renderBody,
      refoldProgressPoller: poller,
    });
    const status = spyStatus(view);

    view.emit({ body: ["live data"] });
    view.emitLifecycle("disconnected", {});
    expect(status).toContain("reconnecting…");
    expect(intervals.callbacks).toHaveLength(0);

    // The reconnect's first result reports catch-up → flip immediately, without
    // waiting out the grace (which is cancelled).
    view.noteCatchingUp(
      true,
      makeBoot({ rev: 30, head_event_id: 100, catching_up: true }),
    );
    expect(timeouts.cleared.size).toBeGreaterThanOrEqual(1);
    expect(intervals.callbacks).toHaveLength(1);
    intervals.tick();
    const joined = stdoutCap.writes.join("");
    expect(joined).toContain("re-folding event log");
    expect(joined).toContain("30.0%");
  } finally {
    timeouts.restore();
  }
});

test("fn-1199 live gate: a post-paint bounce resolves the reconnecting pill by repainting FRESH data (never a stale hold)", () => {
  // The incident scenario at the view seam: a viewer painted a now-doomed epic,
  // the daemon bounced, and the loss was finally detected (a `disconnected`
  // lifecycle). The reconnect must resolve the reconnecting pill by REPAINTING
  // the fresh state — the stale frame is replaced, never held silently. Distinct
  // from the sub-grace-reconnect test above, which re-delivers a BYTE-IDENTICAL
  // frame (suppressed); here the data actually CHANGED, so a repaint must occur.
  const timeouts = patchTimeouts();
  const poller = makeFakePoller([], null);
  try {
    view = createViewShell<{ body: string[] }>({
      script: sidecarBase,
      renderBody,
      refoldProgressPoller: poller,
    });
    const status = spyStatus(view);

    // Paint a first frame showing the now-doomed epic.
    view.emit({ body: ["epic fn-9 open"] });
    expect(stdoutCap.writes.join("")).toContain("epic fn-9 open");
    expect(view.getFrameCount()).toBe(1);

    // The daemon bounces after the paint → reconnecting pill, last frame held.
    view.emitLifecycle("disconnected", {});
    expect(status).toContain("reconnecting…");

    // The reconnect re-baselines to FRESH data (the epic is gone). The changed
    // body forces a repaint: the pill resolves, the stale frame is replaced.
    expect(view.emit({ body: ["(idle — nothing to display)"] })).toBe(true);
    const joined = stdoutCap.writes.join("");
    expect(joined).toContain("(idle — nothing to display)");
    // The stale epic is no longer the latest frame text.
    expect(view.getLastFrameText()).not.toContain("epic fn-9 open");
    // Pill cleared (banner restored to "" — no persistent pill provider), and
    // the full loading indicator was never armed (fresh data landed in grace).
    expect(status.at(-1)).toBe("");
    expect(joined).not.toContain("connecting to keeperd");
    expect(view.getFrameCount()).toBe(2);
  } finally {
    timeouts.restore();
  }
});

test("frames: a catch-up window emits exactly ONE loading record, then resumes data frames on ready", () => {
  const h = makeFramesHarness();
  const emitter = h.makeEmitter();
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    mode: "frames",
    frames: { emitter, io: h.runIo },
  });
  view.noteCursor("5");
  // Frames mode never arms the connecting spinner overlay.
  view.noteCatchingUp(
    true,
    makeBoot({ rev: 20, head_event_id: 100, catching_up: true }),
  );
  expect(intervals.callbacks).toHaveLength(0);

  // The first emit during catch-up mints ONE loading record (the baseline).
  expect(view.emit({ body: ["provisional a"] })).toBe(true);
  // Further catch-up emits are suppressed — no per-tick record flood.
  expect(view.emit({ body: ["provisional a", "provisional b"] })).toBe(false);
  expect(view.emit({ body: ["provisional c"] })).toBe(false);

  // Flip to ready → data frames resume.
  view.noteCatchingUp(
    false,
    makeBoot({ rev: 100, head_event_id: 100, catching_up: false }),
  );
  expect(view.emit({ body: ["real data"] })).toBe(true);

  const recs = h.records();
  expect(recs.map((r) => r.type)).toEqual(["baseline", "frame"]);
  // The loading record stamps catching_up:true + the freshest cursor.
  expect(recs[0]?.catching_up).toBe(true);
  expect(recs[0]?.cursor).toBe("5");
  // The resumed data frame stamps catching_up:false.
  expect(recs[1]?.catching_up).toBe(false);
});

test("snapshot: the trailer stamps the observed catch-up state (data still flows headless)", () => {
  const hh = makeSnapshotHarness();
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    mode: "snapshot",
    streamCount: 1,
    snapshotIo: hh.io,
  });
  view.emitLifecycle("connected", {});
  view.noteCatchingUp(
    true,
    makeBoot({ rev: 20, head_event_id: 100, catching_up: true }),
  );
  // Snapshot/headless keeps capturing during catch-up — the emit is NOT gated.
  view.emit({ body: ["provisional row"] });
  expect(() => view?.runSnapshot(() => {})).toThrow("__SNAPSHOT_EXIT_0__");

  const trailer = parseSnapshotTrailer(hh.stdout.join(""));
  expect(trailer.catching_up).toBe(true);
  expect(trailer.status).toBe("ok");
  expect(trailer.frame).toBe(1);
  expect(hh.stdout.join("")).toContain("provisional row");
});

test("snapshot: no boot header observed → the trailer's catching_up is null", () => {
  const hh = makeSnapshotHarness();
  view = createViewShell<{ body: string[] }>({
    script: sidecarBase,
    renderBody,
    mode: "snapshot",
    streamCount: 1,
    snapshotIo: hh.io,
  });
  view.emit({ body: ["row"] });
  expect(() => view?.runSnapshot(() => {})).toThrow("__SNAPSHOT_EXIT_0__");
  const trailer = parseSnapshotTrailer(hh.stdout.join(""));
  expect(trailer.catching_up).toBeNull();
});

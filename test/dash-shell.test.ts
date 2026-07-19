/**
 * Process-shell + exit-trigger coverage for `keeper dash` (`src/dash/app.ts`
 * `createDashApp` and `src/dash/exit-triggers.ts` `armViewerExitTriggers`).
 * Closes the fn-783 coverage gap (audit findings F4 + F5).
 *
 * F4 — `createDashApp` teardown discipline. The shell is driven headless: a
 * `createTestRenderer` renderer is injected via `deps.buildRenderer`, the exit
 * triggers via a capturing `deps.armExitTriggers` stub, the socket via a
 * `deps.connect` that resolves to a controllable fake socket (no real UDS),
 * and `process.exit` / stderr / `process.on` via recorders so nothing escapes
 * into the runner. We then assert: the `exited` idempotency flag (the teardown
 * tail runs ONCE across repeated triggers), `app.destroy()` (renderer.destroy)
 * precedes the `exit` call, the single readiness subscription connection + the
 * elapsed interval + the triggers are all disposed/disarmed on teardown, and
 * that the `onFatalError` net (uncaughtException) routes through the same
 * restore-then-exit tail with exit code 1 and a stderr write.
 *
 * F5 — exit-trigger fork parity. `src/dash/exit-triggers.ts` is a verbatim fork
 * of `src/view-shell.ts`'s `armViewerExitTriggers`. We pin it two ways: dedicated
 * behavioral coverage of the fork (SIGHUP / stdin-EOF / non-TTY guard / ppid===1
 * poll / launch-init guard / disarm) AND a source-parity assertion that the
 * fork's function body is byte-identical to the view-shell original, so a future
 * edit to one without the other fails loudly.
 *
 * SERIAL-SAFE CHAIN MAINTENANCE: this file imports `@opentui/core` runtime values
 * (via `createTestRenderer`), so it MUST be in BOTH `package.json`'s
 * `test:opentui` chain AND the fast-tier `--path-ignore-patterns` (in `test` and
 * `test:full`) — otherwise it lands in the `--parallel` pass and re-trips
 * OpenTUI's native-loader TDZ. Mirrors `test/dash-app.test.ts`. Validate via
 * `bun run test`, never a bare `bun test --parallel`.
 */

import { afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  BoxRenderable,
  RGBA,
  ScrollBoxRenderable,
  StyledText,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import {
  createDashApp,
  type DashAppDeps,
  type DashRendererBundle,
} from "../src/dash/app";
import { armViewerExitTriggers } from "../src/dash/exit-triggers";
import type { BootStatus } from "../src/protocol";
import type {
  ConnectFactory,
  ReadinessClientSnapshot,
  subscribeReadiness,
} from "../src/readiness-client";

const APP_RUNTIME = {
  TextRenderable,
  ScrollBoxRenderable,
  BoxRenderable,
  StyledText,
  RGBA,
  TextAttributes,
} as const;

beforeAll(() => {
  process.env.OTUI_USE_CONSOLE = "false";
});

// ---------------------------------------------------------------------------
// F4 — createDashApp process-shell teardown.
//
// A test rig that boots createDashApp against a test renderer and records the
// teardown order. The captured `exitCleanly` / `onFatal` handlers let a test
// drive each exit path synchronously; `events` records every renderer-destroy,
// exit, stderr write, handle dispose, and interval clear in order so ordering
// assertions ("destroy before exit") read off one sequence.
// ---------------------------------------------------------------------------

interface ShellRig {
  /** Ordered teardown event log (`destroy`, `exit:<code>`, etc.). */
  events: string[];
  /** The `exitCleanly` tail the trigger stub captured (q/Ctrl-C/SIGHUP route). */
  fireExitCleanly: () => void;
  /** Fire the captured `uncaughtException` handler (the onFatalError net). */
  fireUncaught: (err: unknown) => void;
  /** Disarm-call count on the injected trigger set. */
  disarmCount: () => number;
  /** How many subscription sockets have been torn down (one — the single
   * readiness connection). */
  socketTeardownCount: () => number;
  /** stderr writes captured on the fatal path. */
  stderrWrites: string[];
  /** Tear the test renderer down. */
  destroyRenderer: () => void;
}

async function bootShell(): Promise<ShellRig> {
  const setup = await createTestRenderer({
    width: 80,
    height: 20,
    exitSignals: [],
  });
  const events: string[] = [];
  const stderrWrites: string[] = [];

  // Wrap renderer.destroy so the teardown log records exactly when the paint
  // layer is torn down relative to the exit call.
  const realDestroy = setup.renderer.destroy.bind(setup.renderer);
  (setup.renderer as unknown as { destroy: () => void }).destroy = () => {
    events.push("destroy");
    realDestroy();
  };

  const bundle: DashRendererBundle = {
    renderer: setup.renderer,
    runtime: APP_RUNTIME,
  };

  // Capturing trigger stub — records the disarm and hands back the exitCleanly
  // tail so the test can drive the SIGHUP/q route without a live 2s interval.
  let capturedExitCleanly: (() => void) | null = null;
  let disarms = 0;
  const armExitTriggers: NonNullable<DashAppDeps["armExitTriggers"]> = (
    exitCleanly,
  ) => {
    capturedExitCleanly = exitCleanly;
    return {
      disarm() {
        disarms += 1;
        events.push("disarm");
      },
    };
  };

  // The single readiness subscription connects to a controllable fake socket
  // that records its own teardown. `dispose()` (run inside the exit tail) writes
  // an unsubscribe frame and hard-destroys the socket via `end()`/`terminate()`,
  // so counting torn-down sockets proves the handle was disposed.
  let socketTeardowns = 0;
  const connect: ConnectFactory = async (_path, handlers) => {
    const sock = {
      write() {},
      end() {
        socketTeardowns += 1;
      },
      terminate() {
        socketTeardowns += 1;
      },
    };
    // Surface the open edge so the subscription reaches connected state (and so
    // its `dispose()` takes the live-socket teardown branch, not a no-op).
    handlers.open(sock);
    return sock;
  };

  // Capture the uncaughtException / unhandledRejection handlers instead of
  // landing them on the real process.
  let uncaughtHandler: ((arg: unknown) => void) | null = null;
  const onProcess: NonNullable<DashAppDeps["onProcess"]> = (event, handler) => {
    if (event === "uncaughtException") {
      uncaughtHandler = handler;
    }
  };

  const deps: DashAppDeps = {
    buildRenderer: async () => bundle,
    armExitTriggers,
    connect,
    exit: (code) => {
      events.push(`exit:${code}`);
    },
    stderrWrite: (s) => {
      stderrWrites.push(s);
      events.push("stderr");
    },
    onProcess,
  };

  await createDashApp("/tmp/keeper-dash-shell-test.nonexistent.sock", deps);

  return {
    events,
    fireExitCleanly: () => {
      if (capturedExitCleanly === null) {
        throw new Error("exitCleanly was never captured by the trigger stub");
      }
      capturedExitCleanly();
    },
    fireUncaught: (err) => {
      if (uncaughtHandler === null) {
        throw new Error("uncaughtException handler was never registered");
      }
      uncaughtHandler(err);
    },
    disarmCount: () => disarms,
    socketTeardownCount: () => socketTeardowns,
    stderrWrites,
    destroyRenderer: () => {
      try {
        realDestroy();
      } catch {
        // best-effort
      }
    },
  };
}

const pendingRigs: ShellRig[] = [];
afterEach(() => {
  while (pendingRigs.length > 0) {
    pendingRigs.pop()?.destroyRenderer();
  }
});

test("createDashApp: clean exit destroys the renderer before exit(0)", async () => {
  const rig = await bootShell();
  pendingRigs.push(rig);

  rig.fireExitCleanly();

  // destroy must precede exit so the terminal is restored first.
  const destroyIdx = rig.events.indexOf("destroy");
  const exitIdx = rig.events.indexOf("exit:0");
  expect(destroyIdx).toBeGreaterThanOrEqual(0);
  expect(exitIdx).toBeGreaterThanOrEqual(0);
  expect(destroyIdx).toBeLessThan(exitIdx);
  // The triggers are disarmed and the readiness subscription socket torn down.
  expect(rig.disarmCount()).toBe(1);
  expect(rig.socketTeardownCount()).toBe(1);
});

test("createDashApp: the exit tail is idempotent across repeated triggers", async () => {
  const rig = await bootShell();
  pendingRigs.push(rig);

  rig.fireExitCleanly();
  rig.fireExitCleanly(); // overlapping re-fire must NOT re-tear-down
  rig.fireExitCleanly();

  // Exactly one teardown: one destroy, one exit, one disarm.
  expect(rig.events.filter((e) => e === "destroy")).toHaveLength(1);
  expect(rig.events.filter((e) => e === "exit:0")).toHaveLength(1);
  expect(rig.disarmCount()).toBe(1);
});

test("createDashApp: onFatalError routes through restore-then-exit with code 1 + stderr", async () => {
  const rig = await bootShell();
  pendingRigs.push(rig);

  rig.fireUncaught(new Error("boom"));

  // Same restore-then-exit discipline, but exit code 1 and a stderr write.
  const destroyIdx = rig.events.indexOf("destroy");
  const stderrIdx = rig.events.indexOf("stderr");
  const exitIdx = rig.events.indexOf("exit:1");
  expect(destroyIdx).toBeGreaterThanOrEqual(0);
  expect(exitIdx).toBeGreaterThanOrEqual(0);
  // Terminal restored (destroy) before stderr write and before exit.
  expect(destroyIdx).toBeLessThan(stderrIdx);
  expect(stderrIdx).toBeLessThan(exitIdx);
  // The error text surfaces on the now-cooked stderr.
  expect(rig.stderrWrites.join("")).toContain("boom");
  expect(rig.stderrWrites.join("")).toContain("keeper dash: fatal");
  // Triggers disarmed + the readiness socket torn down on the fatal path too.
  expect(rig.disarmCount()).toBe(1);
  expect(rig.socketTeardownCount()).toBe(1);
  // No `exit:0` — the clean tail must not have fired.
  expect(rig.events).not.toContain("exit:0");
});

test("createDashApp: a fatal after a clean exit does not double-exit", async () => {
  const rig = await bootShell();
  pendingRigs.push(rig);

  rig.fireExitCleanly(); // clean exit fires first, sets `exited`
  rig.fireUncaught(new Error("late")); // must NOT re-destroy / re-exit-0

  expect(rig.events.filter((e) => e === "destroy")).toHaveLength(1);
  expect(rig.events.filter((e) => e === "exit:0")).toHaveLength(1);
  // The fatal still writes stderr + exits 1 (the failure code is preserved),
  // but does NOT re-run the destroy/dispose body (guarded by `exited`).
  expect(rig.events).toContain("exit:1");
  expect(rig.stderrWrites.join("")).toContain("late");
});

test("createDashApp: raw boot then latch callbacks resolve the gate in client order", async () => {
  const setup = await createTestRenderer({
    width: 80,
    height: 20,
    exitSignals: [],
  });
  const subscriptionRef: {
    current: Parameters<typeof subscribeReadiness>[0] | null;
  } = { current: null };
  const subscribe: typeof subscribeReadiness = ((opts) => {
    subscriptionRef.current = opts;
    return { dispose() {}, reconnect() {} };
  }) as typeof subscribeReadiness;
  try {
    await createDashApp("/tmp/dash-test.sock", {
      buildRenderer: async () => ({
        renderer: setup.renderer,
        runtime: APP_RUNTIME,
      }),
      subscribe,
      armExitTriggers: () => ({ disarm() {} }),
      exit: () => {},
      onProcess: () => {},
    });
    const boot = (catching_up: boolean): BootStatus => ({
      rev: 1,
      head_event_id: 1,
      catching_up,
      git_seed_required: false,
    });
    const opts = subscriptionRef.current;
    if (opts === null) {
      throw new Error("subscription options were not captured");
    }

    opts.onLifecycle?.("connecting");
    await setup.renderOnce();
    // Cold start has no retained body, so connecting gates immediately rather
    // than presenting an empty dashboard as a fresh snapshot.
    expect(setup.captureCharFrame()).toContain("catching up…");

    opts.onLifecycle?.("connected");
    opts.onCatchingUp?.(true, boot(true));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("catching up…");

    // `readiness-client` publishes raw telemetry first, then the initialized /
    // flipped latch for the same result. Neither partial callback may certify
    // the retained prior-connection snapshot as fresh: loading remains until
    // the first complete composite arrives.
    opts.onBootStatus?.(boot(false));
    opts.onCatchingUp?.(false, boot(false));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("catching up…");

    opts.onSnapshot?.({
      jobs: new Map(),
    } as unknown as ReadinessClientSnapshot);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("catching up…");
  } finally {
    setup.renderer.destroy();
  }
});

// ---------------------------------------------------------------------------
// F5 — exit-trigger fork behavioral coverage + source parity pin.
//
// `src/dash/exit-triggers.ts` `armViewerExitTriggers` is a verbatim fork of the
// `src/view-shell.ts` original. The behavioral tests mirror
// test/view-shell.test.ts (a fake `proc` so no real process handler is wired);
// the parity test pins the fork byte-for-byte to its source so a future edit to
// one without the other fails loudly.
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
  fire: (event: string, ...args: unknown[]) => void;
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

// Interval monkeypatch — capture every scheduled callback + handle so the ppid
// poll can be driven synchronously (mirrors test/view-shell.test.ts).
interface IntervalCapture {
  callbacks: Array<() => void>;
  delays: number[];
  cleared: unknown[];
  restore(): void;
  tick(): void;
}

function patchIntervals(): IntervalCapture {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const callbacks: Array<() => void> = [];
  const delays: number[] = [];
  const cleared: unknown[] = [];
  let nextHandle = 1;
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
    restore() {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    },
    tick() {
      if (callbacks.length === 0) {
        throw new Error("no interval armed — tick() before setInterval()");
      }
      callbacks[callbacks.length - 1]();
    },
  };
}

let intervals: IntervalCapture;

test("fork: SIGHUP triggers a clean exit exactly once (idempotent tail)", () => {
  intervals = patchIntervals();
  try {
    const proc = makeFakeProc({ ppid: 4242, isTTY: true });
    let exits = 0;
    let toreDown = false;
    const exitCleanly = (): void => {
      if (toreDown) return;
      toreDown = true;
      exits++;
    };
    const { disarm } = armViewerExitTriggers(exitCleanly, {
      proc: proc as never,
    });
    try {
      proc.fire("SIGHUP");
      proc.fire("SIGHUP");
      expect(exits).toBe(1);
    } finally {
      disarm();
    }
  } finally {
    intervals.restore();
  }
});

test("fork: stdin-EOF exits on a TTY (and resumes stdin); no-fire on non-TTY", () => {
  intervals = patchIntervals();
  try {
    const tty = makeFakeProc({ ppid: 4242, isTTY: true });
    let ttyExits = 0;
    const ttyArm = armViewerExitTriggers(() => ttyExits++, {
      proc: tty as never,
    });
    expect(tty.resumed).toBe(true);
    tty.fireStdin("end");
    expect(ttyExits).toBe(1);
    ttyArm.disarm();

    const piped = makeFakeProc({ ppid: 4242, isTTY: false });
    let pipedExits = 0;
    const pipedArm = armViewerExitTriggers(() => pipedExits++, {
      proc: piped as never,
    });
    expect(piped.resumed).toBe(false);
    piped.fireStdin("end");
    expect(pipedExits).toBe(0);
    pipedArm.disarm();
  } finally {
    intervals.restore();
  }
});

test("fork: ppid===1 poll exits on reparent; live viewer + launch-init guard do not", () => {
  intervals = patchIntervals();
  try {
    // Reparent-to-init exits on the next tick.
    const proc = makeFakeProc({ ppid: 4242, isTTY: true });
    let exits = 0;
    const { disarm } = armViewerExitTriggers(() => exits++, {
      proc: proc as never,
      ppidPollMs: 2000,
    });
    expect(intervals.delays[intervals.delays.length - 1]).toBe(2000);
    intervals.tick(); // still parented → no-op
    expect(exits).toBe(0);
    proc.ppid = 1;
    intervals.tick(); // reparented → exit
    expect(exits).toBe(1);
    disarm();

    // Launch-time ppid===1 disables the poll entirely (born-detached guard).
    const detached = makeFakeProc({ ppid: 1, isTTY: true });
    let detachedExits = 0;
    const armedBefore = intervals.callbacks.length;
    const d = armViewerExitTriggers(() => detachedExits++, {
      proc: detached as never,
    });
    expect(intervals.callbacks.length).toBe(armedBefore); // no poll armed
    detached.fire("SIGHUP"); // SIGHUP still works
    expect(detachedExits).toBe(1);
    d.disarm();
  } finally {
    intervals.restore();
  }
});

test("fork: disarm() clears the ppid poll interval", () => {
  intervals = patchIntervals();
  try {
    const proc = makeFakeProc({ ppid: 4242, isTTY: true });
    const clearedBefore = intervals.cleared.length;
    const { disarm } = armViewerExitTriggers(() => {}, {
      proc: proc as never,
    });
    disarm();
    expect(intervals.cleared.length).toBe(clearedBefore + 1);
  } finally {
    intervals.restore();
  }
});

test("fork parity: dash exit-triggers armViewerExitTriggers is byte-identical to the view-shell source", () => {
  // The dash fork must not drift from its src/view-shell.ts origin. Extract the
  // `armViewerExitTriggers` function body from each module's source and compare
  // them character-for-character (comments stripped — the docstrings legitimately
  // differ; the executable body must not). A divergent edit to one file without
  // the other fails this pin.
  const forkSrc = readFileSync(
    new URL("../src/dash/exit-triggers.ts", import.meta.url),
    "utf8",
  );
  const originSrc = readFileSync(
    new URL("../src/view-shell.ts", import.meta.url),
    "utf8",
  );

  function extractFnBody(src: string): string {
    const marker = "export function armViewerExitTriggers(";
    const start = src.indexOf(marker);
    if (start < 0) {
      throw new Error("armViewerExitTriggers not found in source");
    }
    // Walk braces from the first `{` after the signature to its match.
    const openBrace = src.indexOf("{", src.indexOf(")", start));
    let depth = 0;
    let end = -1;
    for (let i = openBrace; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end < 0) {
      throw new Error("unbalanced braces in armViewerExitTriggers");
    }
    return src.slice(openBrace, end);
  }

  // Strip line comments + normalize whitespace so the comparison is on the
  // executable shape, not formatting/comment differences (the two files word
  // their inline comments slightly differently).
  function normalize(body: string): string {
    return body
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, "").trimEnd())
      .filter((line) => line.trim().length > 0)
      .join("\n")
      .replace(/\s+/g, " ")
      .trim();
  }

  const forkBody = normalize(extractFnBody(forkSrc));
  const originBody = normalize(extractFnBody(originSrc));
  expect(forkBody).toBe(originBody);
});

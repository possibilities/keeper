/**
 * --agentwrap-modal keystone (fn-935.1). Two surfaces, both in-process (no
 * renderer, no real PTY/TTY):
 *
 *  1. main() branch wiring — the modal host fires ONLY for claude under an
 *     interactive TTY; codex/pi, -p/--print, and non-TTY are rejected clearly;
 *     the flag is stripped from the child argv; the no-flag path is unchanged.
 *  2. runModalHost mechanics — raw passthrough (stdin→PTY, child→stdout),
 *     reserved-hotkey interception + stub callback, out-of-band exit-code
 *     propagation, signal re-raise, and terminal restore on every exit path.
 *
 * The real-PTY passthrough smoke lives in test/agent-modal-host.slow.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { main } from "../src/agent/main";
import {
  type HostProcess,
  type HostStdin,
  type HostStdout,
  MODAL_HOTKEY_BYTE,
  type ModalHostDeps,
  type PtyHandle,
  type PtySpawnOptions,
  runModalHost,
} from "../src/agent/modal-host";
import { expectExit, makeHarness } from "./helpers/agent-main-harness";

// ── main() branch wiring ──────────────────────────────────────────────────

describe("--agentwrap-modal main() branch", () => {
  test("claude + interactive TTY routes to the modal host, flag stripped", async () => {
    const h = makeHarness({
      argv: ["--agentwrap-modal", "hello"],
      isInteractive: () => true,
      listProfiles: () => ["default"],
      pickProfile: () => "default",
    });
    await expectExit(main(h.deps));
    expect(h.modalHosted.length).toBe(1);
    expect(h.spawned.length).toBe(0);
    const cmd = h.modalHosted[0] as string[];
    // The launcher flag never reaches the child argv.
    expect(cmd).not.toContain("--agentwrap-modal");
    expect(cmd).toContain("hello");
  });

  test("no flag → runWithJobControl spawn, modal host untouched", async () => {
    const h = makeHarness({
      argv: ["hello"],
      isInteractive: () => true,
      listProfiles: () => ["default"],
      pickProfile: () => "default",
    });
    await expectExit(main(h.deps));
    expect(h.modalHosted.length).toBe(0);
    expect(h.spawned.length).toBe(1);
  });

  test("codex is rejected with a clear error (exit 2)", async () => {
    const h = makeHarness({
      agent: "codex",
      argv: ["--agentwrap-modal"],
      isInteractive: () => true,
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.modalHosted.length).toBe(0);
    expect(h.spawned.length).toBe(0);
    expect(h.err.join("")).toContain("supported only for claude");
  });

  test("pi is rejected with a clear error (exit 2)", async () => {
    const h = makeHarness({
      agent: "pi",
      argv: ["--agentwrap-modal"],
      isInteractive: () => true,
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.modalHosted.length).toBe(0);
    expect(h.err.join("")).toContain("supported only for claude");
  });

  test("-p/--print is rejected (non-interactive)", async () => {
    for (const printFlag of ["--print", "-p"]) {
      const h = makeHarness({
        argv: ["--agentwrap-modal", printFlag],
        isInteractive: () => true,
        listProfiles: () => ["default"],
        pickProfile: () => "default",
      });
      const code = await expectExit(main(h.deps));
      expect(code).toBe(2);
      expect(h.modalHosted.length).toBe(0);
      expect(h.err.join("")).toContain("cannot be used with -p/--print");
    }
  });

  test("non-TTY invocation is rejected (exit 2)", async () => {
    const h = makeHarness({
      argv: ["--agentwrap-modal"],
      isInteractive: () => false,
      listProfiles: () => ["default"],
      pickProfile: () => "default",
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.modalHosted.length).toBe(0);
    expect(h.err.join("")).toContain("interactive TTY");
  });
});

// ── runModalHost mechanics ────────────────────────────────────────────────

interface FakePty extends PtyHandle {
  /** Bytes written into the PTY master, concatenated. */
  readonly written: number[];
  /** Resize calls, [cols, rows]. */
  readonly resizes: [number, number][];
  /** Signals delivered to the child. */
  readonly kills: NodeJS.Signals[];
  /** True once close() ran. */
  readonly closed: () => boolean;
  /** Emit raw output from the child (PTY → parent). */
  emitData(bytes: number[]): void;
  /** Resolve the child with an exit code. */
  finishExit(code: number): void;
  /** Resolve the child as signalled. */
  finishSignal(signal: NodeJS.Signals): void;
}

/** Build the runModalHost deps around a fake PTY + recording host surfaces. */
function makeHostHarness(): {
  deps: ModalHostDeps;
  pty: FakePty;
  stdout: number[];
  exits: number[];
  reraised: NodeJS.Signals[];
  rawModes: boolean[];
  emitStdin: (bytes: number[]) => void;
  resizeTo: (cols: number, rows: number) => void;
  hotkeyFires: () => number;
} {
  const written: number[] = [];
  const resizes: [number, number][] = [];
  const kills: NodeJS.Signals[] = [];
  let closedFlag = false;
  let resolveExited!: (n: number) => void;
  const exited = new Promise<number>((res) => {
    resolveExited = res;
  });
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;

  let optsRef: PtySpawnOptions | null = null;
  const pty: FakePty = {
    written,
    resizes,
    kills,
    closed: () => closedFlag,
    write(data) {
      const bytes =
        typeof data === "string"
          ? Array.from(Buffer.from(data, "utf8"))
          : Array.from(data);
      written.push(...bytes);
    },
    resize(cols, rows) {
      resizes.push([cols, rows]);
    },
    kill(signal) {
      kills.push(signal);
    },
    exited,
    get exitCode() {
      return exitCode;
    },
    get signalCode() {
      return signalCode;
    },
    close() {
      closedFlag = true;
    },
    emitData(bytes) {
      optsRef?.onData(Uint8Array.from(bytes));
    },
    finishExit(code) {
      exitCode = code;
      resolveExited(code);
    },
    finishSignal(signal) {
      signalCode = signal;
      resolveExited(1);
    },
  };

  let cols = 100;
  let rows = 40;
  const rawModes: boolean[] = [];
  const stdinListeners: ((c: Buffer) => void)[] = [];
  const resizeListeners: (() => void)[] = [];
  const procListeners = new Map<string, ((...a: unknown[]) => void)[]>();
  const stdout: number[] = [];
  const exits: number[] = [];
  const reraised: NodeJS.Signals[] = [];
  let hotkeyCount = 0;

  const stdin: HostStdin = {
    isTTY: true,
    setRawMode(mode) {
      rawModes.push(mode);
    },
    resume() {},
    pause() {},
    on(_e, listener) {
      stdinListeners.push(listener);
    },
    off(_e, listener) {
      const i = stdinListeners.indexOf(listener);
      if (i >= 0) stdinListeners.splice(i, 1);
    },
  };
  const stdoutSurface: HostStdout = {
    isTTY: true,
    get columns() {
      return cols;
    },
    get rows() {
      return rows;
    },
    write(data) {
      const bytes =
        typeof data === "string"
          ? Array.from(Buffer.from(data, "utf8"))
          : Array.from(data);
      stdout.push(...bytes);
      return true;
    },
    on(_e, listener) {
      resizeListeners.push(listener);
    },
    off(_e, listener) {
      const i = resizeListeners.indexOf(listener);
      if (i >= 0) resizeListeners.splice(i, 1);
    },
  };
  const proc: HostProcess = {
    pid: 4242,
    on(event, listener) {
      const arr = procListeners.get(event) ?? [];
      arr.push(listener);
      procListeners.set(event, arr);
    },
    removeListener(event, listener) {
      const arr = procListeners.get(event) ?? [];
      const i = arr.indexOf(listener);
      if (i >= 0) arr.splice(i, 1);
    },
    removeAllListeners(event) {
      procListeners.delete(event);
    },
    kill(_pid, signal) {
      // In production, re-raising the signal on ourselves terminates the
      // process here — control never returns to the exit-1 fallback. Model that
      // halt so the test does not see a spurious fallback exit.
      reraised.push(signal);
      throw new SignalHalt(signal);
    },
  };

  const deps: ModalHostDeps = {
    ptySpawn: (_cmd, opts) => {
      optsRef = opts;
      return pty;
    },
    stdin,
    stdout: stdoutSurface,
    proc,
    env: { FOO: "bar" },
    exit: ((code: number) => {
      exits.push(code);
      throw new ExitMarker(code);
    }) as (code: number) => never,
    onHotkey: () => {
      hotkeyCount += 1;
    },
  };

  return {
    deps,
    pty,
    stdout,
    exits,
    reraised,
    rawModes,
    emitStdin: (bytes) => {
      for (const l of stdinListeners) l(Buffer.from(bytes));
    },
    resizeTo: (c, r) => {
      cols = c;
      rows = r;
      for (const l of resizeListeners) l();
    },
    hotkeyFires: () => hotkeyCount,
  };
}

class ExitMarker extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

/** Models the process terminating at the signal re-raise (proc.kill on self). */
class SignalHalt extends Error {
  constructor(public signal: NodeJS.Signals) {
    super(`halt ${signal}`);
  }
}

/** Run runModalHost, swallowing the synthetic exit, returning the exit code. */
async function runHost(
  deps: ModalHostDeps,
  cmd: string[] = ["claude"],
): Promise<void> {
  try {
    await runModalHost(cmd, deps);
  } catch (e) {
    if (e instanceof ExitMarker || e instanceof SignalHalt) return;
    throw e;
  }
}

describe("runModalHost passthrough", () => {
  test("parent stdin streams raw into the PTY", async () => {
    const h = makeHostHarness();
    const run = runHost(h.deps);
    h.emitStdin([0x68, 0x69]); // "hi"
    h.pty.finishExit(0);
    await run;
    expect(h.pty.written).toEqual([0x68, 0x69]);
  });

  test("child output streams verbatim to parent stdout", async () => {
    const h = makeHostHarness();
    const run = runHost(h.deps);
    h.pty.emitData([0x6f, 0x6b]); // "ok"
    h.pty.finishExit(0);
    await run;
    expect(h.stdout).toEqual([0x6f, 0x6b]);
  });

  test("a parent SIGWINCH forwards an explicit PTY resize", async () => {
    const h = makeHostHarness();
    const run = runHost(h.deps);
    h.resizeTo(120, 50);
    h.pty.finishExit(0);
    await run;
    expect(h.pty.resizes).toContainEqual([120, 50]);
  });
});

describe("runModalHost hotkey", () => {
  test("the reserved hotkey byte fires the stub and is swallowed", async () => {
    const h = makeHostHarness();
    const run = runHost(h.deps);
    // "a" + hotkey + "b": the hotkey byte is dropped, the rest forwarded.
    h.emitStdin([0x61, MODAL_HOTKEY_BYTE, 0x62]);
    h.pty.finishExit(0);
    await run;
    expect(h.hotkeyFires()).toBe(1);
    expect(h.pty.written).toEqual([0x61, 0x62]);
  });

  test("a lone hotkey byte fires once and forwards nothing", async () => {
    const h = makeHostHarness();
    const run = runHost(h.deps);
    h.emitStdin([MODAL_HOTKEY_BYTE]);
    h.pty.finishExit(0);
    await run;
    expect(h.hotkeyFires()).toBe(1);
    expect(h.pty.written).toEqual([]);
  });
});

describe("runModalHost disposition", () => {
  test("the child's real exit code is propagated", async () => {
    const h = makeHostHarness();
    const run = runHost(h.deps);
    h.pty.finishExit(7);
    await run;
    expect(h.exits).toEqual([7]);
  });

  test("a signal death re-raises the real signal on ourselves", async () => {
    const h = makeHostHarness();
    const run = runHost(h.deps);
    h.pty.finishSignal("SIGTERM");
    await run;
    // The re-raise (proc.kill) fires; no plain exit code is taken.
    expect(h.reraised).toEqual(["SIGTERM"]);
    expect(h.exits).toEqual([]);
  });
});

describe("runModalHost terminal restore", () => {
  test("raw mode is entered then restored on a clean exit", async () => {
    const h = makeHostHarness();
    const run = runHost(h.deps);
    h.pty.finishExit(0);
    await run;
    // setRawMode(true) on entry, setRawMode(false) on restore.
    expect(h.rawModes[0]).toBe(true);
    expect(h.rawModes.at(-1)).toBe(false);
    expect(h.pty.closed()).toBe(true);
  });

  test("raw mode is restored even on a signal death", async () => {
    const h = makeHostHarness();
    const run = runHost(h.deps);
    h.pty.finishSignal("SIGTERM");
    await run;
    expect(h.rawModes.at(-1)).toBe(false);
    expect(h.pty.closed()).toBe(true);
  });
});

/**
 * Real-PTY passthrough smoke for the --agentwrap-modal host (fn-935.1). The
 * keystone risk is empirical: can Bun's managed `terminal:` PTY host a child
 * cleanly with raw passthrough, resize forwarding, and correct out-of-band exit
 * codes? The in-process unit tests fake the PTY; this drives the REAL
 * `Bun.spawn({terminal})` via `defaultPtySpawn` + `runModalHost` against small,
 * deterministic children (no real claude).
 *
 * Headless-deterministic: the parent stdin/stdout are recording fakes (not the
 * test runner's own TTY), so the host runs without stealing the terminal. Only
 * the CHILD side is a real PTY. retryUntil, never Bun.sleep.
 *
 * Slow tier: ignore-listed from the default run (it spawns a real PTY child).
 */

import { describe, expect, test } from "bun:test";
import {
  defaultPtySpawn,
  type HostProcess,
  type HostStdin,
  type HostStdout,
  type ModalHostDeps,
  runModalHost,
} from "../src/agent/modal-host";
import { retryUntil } from "./helpers/retry-until";

const bunBin = Bun.which("bun");

class ExitMarker extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

/** A recording parent-host harness around the REAL defaultPtySpawn. */
function makeRealHostHarness(): {
  deps: ModalHostDeps;
  stdout: () => Uint8Array;
  exits: number[];
  rawModes: boolean[];
  pushStdin: (bytes: number[]) => void;
  resizeTo: (cols: number, rows: number) => void;
} {
  let cols = 80;
  let rows = 24;
  const rawModes: boolean[] = [];
  const stdinListeners: ((c: Buffer) => void)[] = [];
  const resizeListeners: (() => void)[] = [];
  const procListeners = new Map<string, ((...a: unknown[]) => void)[]>();
  const outChunks: number[] = [];
  const exits: number[] = [];

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
  const stdout: HostStdout = {
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
      outChunks.push(...bytes);
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
    pid: process.pid,
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
    kill() {},
  };

  const deps: ModalHostDeps = {
    ptySpawn: defaultPtySpawn,
    stdin,
    stdout,
    proc,
    env: { ...process.env },
    exit: ((code: number) => {
      exits.push(code);
      throw new ExitMarker(code);
    }) as (code: number) => never,
  };

  return {
    deps,
    stdout: () => Uint8Array.from(outChunks),
    exits,
    rawModes,
    pushStdin: (bytes) => {
      for (const l of stdinListeners) l(Buffer.from(bytes));
    },
    resizeTo: (c, r) => {
      cols = c;
      rows = r;
      for (const l of resizeListeners) l();
    },
  };
}

/** Run runModalHost, swallowing the synthetic exit. */
async function runHost(deps: ModalHostDeps, cmd: string[]): Promise<void> {
  try {
    await runModalHost(cmd, deps);
  } catch (e) {
    if (e instanceof ExitMarker) return;
    throw e;
  }
}

describe.if(bunBin !== null)("real-PTY modal host smoke", () => {
  test("hosts a child, the child's real exit code propagates, terminal restored", async () => {
    const h = makeRealHostHarness();
    // `sh -c 'exit 7'` — a child that exits with a known non-zero code.
    const run = runHost(h.deps, ["sh", "-c", "exit 7"]);
    await run;
    // The REAL exit code (7), read out-of-band, not the PTY-lifecycle status.
    expect(h.exits).toEqual([7]);
    // Raw mode entered then restored.
    expect(h.rawModes[0]).toBe(true);
    expect(h.rawModes.at(-1)).toBe(false);
  }, 15_000);

  test("raw passthrough: stdin written to the child echoes back to parent stdout", async () => {
    const h = makeRealHostHarness();
    // `cat` echoes its stdin to stdout over the PTY. We write a marker, then
    // close cat's stdin by sending ctrl-d (0x04) so it exits cleanly.
    const run = runHost(h.deps, ["cat"]);
    h.pushStdin(Array.from(Buffer.from("ping\n", "utf8")));
    // Wait for the echo to round-trip through the PTY before sending EOF.
    const echoed = await retryUntil(
      () => Buffer.from(h.stdout()).toString("utf8").includes("ping") || null,
      5000,
    );
    expect(echoed).toBe(true);
    h.pushStdin([0x04]); // ctrl-d → EOF → cat exits 0
    await run;
    expect(Buffer.from(h.stdout()).toString("utf8")).toContain("ping");
    expect(h.exits).toEqual([0]);
  }, 15_000);

  test("a parent resize forwards to the PTY without crashing the host", async () => {
    const h = makeRealHostHarness();
    const run = runHost(h.deps, ["cat"]);
    h.resizeTo(132, 50); // forwarded as terminal.resize on the real PTY
    h.pushStdin([0x04]); // EOF
    await run;
    expect(h.exits).toEqual([0]);
    expect(h.rawModes.at(-1)).toBe(false);
  }, 15_000);
});

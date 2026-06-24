/**
 * Real-PTY smoke for the --agentwrap-modal overlay WIRING (fn-935.2). The OpenTUI
 * renderer itself cannot run headless (it grabs the test runner's TTY), so the
 * faithful renderer behavior is covered by the in-process
 * test/agent-modal-overlay.test.ts on a `createTestRenderer`. THIS file proves
 * the host↔overlay seam against a REAL `Bun.spawn({terminal})` child: the hotkey
 * byte opens the overlay (stdin handoff detach), child output is suppressed while
 * the modal owns the screen, dismiss re-attaches + forces the agent redraw, and a
 * child-exit-while-open destroys the overlay BEFORE the parent terminal is
 * restored.
 *
 * Headless-deterministic: the parent stdin/stdout are recording fakes (not the
 * runner's own TTY); only the CHILD side is a real PTY; the overlay is a
 * recording fake driven by the host's seam. retryUntil, never Bun.sleep.
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
import type {
  OverlayHandle,
  OverlayHostSeam,
} from "../src/agent/modal-overlay";
import { retryUntil } from "./helpers/retry-until";

const bunBin = Bun.which("bun");

class ExitMarker extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

interface OverlayLog {
  detach: number;
  attach: number;
  redraw: number;
  destroyed: number;
  opened: number;
  closed: number;
}

/** A recording overlay driven by the host seam — no real renderer. */
function makeRecordingOverlay(seam: OverlayHostSeam): {
  handle: OverlayHandle;
  log: OverlayLog;
} {
  const log: OverlayLog = {
    detach: 0,
    attach: 0,
    redraw: 0,
    destroyed: 0,
    opened: 0,
    closed: 0,
  };
  let open = false;
  let destroyed = false;
  const handle: OverlayHandle = {
    open: () => {
      if (open || destroyed) return;
      open = true;
      log.opened += 1;
      seam.stdinHandoff.detach();
      log.detach += 1;
    },
    close: () => {
      if (!open || destroyed) return;
      open = false;
      log.closed += 1;
      seam.stdinHandoff.attach();
      log.attach += 1;
      seam.requestAgentRedraw();
      log.redraw += 1;
    },
    get isOpen() {
      return open;
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      log.destroyed += 1;
      if (open) {
        open = false;
        seam.stdinHandoff.attach();
        log.attach += 1;
      }
    },
  };
  return { handle, log };
}

/** A recording parent-host harness around the REAL defaultPtySpawn. */
function makeHarness(): {
  deps: ModalHostDeps;
  stdout: () => Uint8Array;
  exits: number[];
  rawModes: boolean[];
  overlayLog: () => OverlayLog | null;
  overlayHandle: () => OverlayHandle | null;
  pushStdin: (bytes: number[]) => void;
} {
  const cols = 80;
  const rows = 24;
  const rawModes: boolean[] = [];
  const stdinListeners: ((c: Buffer) => void)[] = [];
  const resizeListeners: (() => void)[] = [];
  const procListeners = new Map<string, ((...a: unknown[]) => void)[]>();
  const outChunks: number[] = [];
  const exits: number[] = [];
  let overlayLog: OverlayLog | null = null;
  let overlayHandle: OverlayHandle | null = null;

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
    buildOverlay: async (seam) => {
      const { handle, log } = makeRecordingOverlay(seam);
      overlayLog = log;
      overlayHandle = handle;
      return handle;
    },
  };

  return {
    deps,
    stdout: () => Uint8Array.from(outChunks),
    exits,
    rawModes,
    overlayLog: () => overlayLog,
    overlayHandle: () => overlayHandle,
    pushStdin: (bytes) => {
      for (const l of stdinListeners) l(Buffer.from(bytes));
    },
  };
}

async function runHost(deps: ModalHostDeps, cmd: string[]): Promise<void> {
  try {
    await runModalHost(cmd, deps);
  } catch (e) {
    if (e instanceof ExitMarker) return;
    throw e;
  }
}

const MODAL_HOTKEY = 0x1d; // ctrl-]

describe.if(bunBin !== null)("real-PTY modal overlay wiring", () => {
  test("hotkey opens overlay (detach); dismiss re-attaches + redraws; then the child EOFs clean", async () => {
    const h = makeHarness();
    // `cat` echoes its stdin. Open the overlay via the hotkey: the host detaches
    // its stdin listener (the mutex), so the test drives dismiss directly via the
    // captured overlay handle (Esc/click in production), which re-attaches the
    // listener + forces the agent redraw. After dismiss, EOF the child clean.
    const run = runHost(h.deps, ["cat"]);

    // Let the overlay build (async) before driving input.
    await retryUntil(() => h.overlayLog() !== null || null, 5000);

    // Open the overlay via the reserved hotkey byte → stdin handoff detach.
    h.pushStdin([MODAL_HOTKEY]);
    await retryUntil(() => (h.overlayLog()?.opened ?? 0) > 0 || null, 5000);
    expect(h.overlayLog()?.detach).toBe(1);
    expect(h.overlayHandle()?.isOpen).toBe(true);

    // Dismiss via the handle (the host's stdin listener is detached while open,
    // so a real Esc would arrive via OpenTUI; the test stands in for that).
    h.overlayHandle()?.close();
    expect(h.overlayHandle()?.isOpen).toBe(false);
    // Dismiss re-attached the stdin listener (balanced) + forced the agent redraw.
    expect(h.overlayLog()?.attach).toBe(1);
    expect(h.overlayLog()?.redraw).toBe(1);

    // With the listener re-attached, a marker now flows through the PTY again.
    h.pushStdin(Array.from(Buffer.from("after\n", "utf8")));
    const echoed = await retryUntil(
      () => Buffer.from(h.stdout()).toString("utf8").includes("after") || null,
      5000,
    );
    expect(echoed).toBe(true);

    // Clean EOF → cat exits 0, overlay destroyed on teardown, raw mode restored.
    h.pushStdin([0x04]); // ctrl-d
    await run;
    expect(h.overlayLog()?.destroyed).toBe(1);
    expect(h.rawModes.at(-1)).toBe(false);
    expect(h.exits).toEqual([0]);
  }, 20_000);

  test("child-exit-while-open: the host destroys the overlay before restoring the parent terminal", async () => {
    const h = makeHarness();
    // The child self-exits with code 3 after a short delay. Open the overlay
    // immediately and let the REAL child exit WHILE the modal is up. The host's
    // teardown must destroy the overlay (terminal restore) BEFORE propagating the
    // child's disposition, and the destroy rebalances the stdin handoff.
    const run = runHost(h.deps, ["sh", "-c", "sleep 0.4; exit 3"]);
    await retryUntil(() => h.overlayLog() !== null || null, 5000);

    // Open the overlay before the child exits.
    h.pushStdin([MODAL_HOTKEY]);
    await retryUntil(() => (h.overlayHandle()?.isOpen ?? false) || null, 5000);
    expect(h.overlayLog()?.detach).toBe(1);
    expect(h.overlayHandle()?.isOpen).toBe(true);

    // The child exits on its own while the overlay is still open.
    await run;

    // The host destroyed the overlay on teardown (renderer.destroy() → terminal
    // restore), rebalanced the handoff (attach matches the open detach), un-rawed
    // the parent, and propagated the child's REAL exit code (3).
    expect(h.overlayLog()?.destroyed).toBe(1);
    expect(h.overlayLog()?.attach).toBe(1);
    expect(h.rawModes.at(-1)).toBe(false);
    expect(h.exits).toEqual([3]);
  }, 20_000);

  test("no hotkey: raw passthrough echoes child output to parent stdout (overlay never opens)", async () => {
    const h = makeHarness();
    const run = runHost(h.deps, ["cat"]);
    await retryUntil(() => h.overlayLog() !== null || null, 5000);

    h.pushStdin(Array.from(Buffer.from("ping\n", "utf8")));
    const echoed = await retryUntil(
      () => Buffer.from(h.stdout()).toString("utf8").includes("ping") || null,
      5000,
    );
    expect(echoed).toBe(true);
    // Overlay was built but never opened.
    expect(h.overlayLog()?.opened).toBe(0);

    h.pushStdin([0x04]); // EOF
    await run;
    expect(h.exits).toEqual([0]);
    expect(h.rawModes.at(-1)).toBe(false);
  }, 20_000);
});

/**
 * Tests for `src/live-shell.ts`'s `createLiveShell` factory.
 *
 * Driven by `PassThrough`-style fake `stdout` / `stdin` sinks injected
 * through the factory options, plus a `fakeClock` mirroring the
 * `test/rescan.test.ts` pattern so the bare-Esc flush and the resize
 * debounce fire deterministically. No real `process.stdin` /
 * `process.stdout` mutation — the test runner's terminal stays clean and
 * `bun test --isolate` can import the module without side effects.
 *
 * Coverage (per task spec `### Test notes`):
 *   1. Cold start: first `pushFrame` produces enter-alt + a full paint.
 *   2. Steady-state diff: only changed rows emit their per-line diff
 *      sequence; unchanged rows produce no bytes.
 *   3. Resize: simulating a resize event debounces, then full-renders.
 *   4. Scroll-back: a `\x1b[D` (left arrow) decrements `viewIdx`; banner
 *      updates; no auto-snap.
 *   5. New frames during scroll-back: silent append; banner count updates.
 *   6. `G` returns to live and emits a full re-render of the current tip.
 *   7. `q` triggers dispose + onExit; teardown sequence lands in the sink.
 *   8. `dispose()` called twice is a no-op (second call writes nothing).
 *   9. Non-TTY path: `enabled: false` writes plain joined text and
 *      `dispose()` writes nothing.
 *  10. Partial-read key parser: bare `\x1b` → no key fires until idle
 *      flush, then "snap to live".
 *  11. CSI split across chunks: `\x1b[` + later `A` resolves to ↑ once.
 *  12. Resize does NOT clear frame history.
 *  13. `pushFrame` while disposed writes nothing (lifecycle hygiene).
 *  14. Safety-net listeners attach on enable and detach on dispose.
 */

import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  createLiveShell,
  type LiveShellOptions,
  type LiveShellStdin,
  type LiveShellStdout,
  type LiveShellTimers,
} from "../src/live-shell";

// ---------------------------------------------------------------------------
// Sink stdout — captures every `write` byte and surfaces a resize-fire helper.
// ---------------------------------------------------------------------------

interface FakeStdout extends LiveShellStdout {
  readonly chunks: string[];
  fireResize(): void;
  setSize(cols: number, rows: number): void;
  take(): string;
}

function makeFakeStdout(opts: { tty?: boolean } = {}): FakeStdout {
  const isTTY = opts.tty ?? true;
  const chunks: string[] = [];
  const emitter = new EventEmitter();
  let cols = 120;
  let rowsCount = 40;
  const sink: FakeStdout = {
    chunks,
    isTTY,
    get columns() {
      return cols;
    },
    get rows() {
      return rowsCount;
    },
    getWindowSize(): [number, number] {
      return [cols, rowsCount];
    },
    write(data: string): boolean {
      chunks.push(data);
      return true;
    },
    on(event, listener) {
      emitter.on(event, listener);
    },
    off(event, listener) {
      emitter.off(event, listener);
    },
    fireResize() {
      emitter.emit("resize");
    },
    setSize(c, r) {
      cols = c;
      rowsCount = r;
    },
    take() {
      const joined = chunks.join("");
      chunks.length = 0;
      return joined;
    },
  };
  return sink;
}

// ---------------------------------------------------------------------------
// Fake stdin — `feed` pushes bytes to the live-shell as if the user typed.
// ---------------------------------------------------------------------------

interface FakeStdin extends LiveShellStdin {
  feed(s: string): void;
  readonly rawCalls: boolean[];
  paused: boolean;
  resumed: boolean;
  readonly listenerCount: () => number;
}

function makeFakeStdin(
  opts: { tty?: boolean; isRaw?: boolean } = {},
): FakeStdin {
  const isTTY = opts.tty ?? true;
  const initialRaw = opts.isRaw ?? false;
  const emitter = new EventEmitter();
  const rawCalls: boolean[] = [];
  let isRaw = initialRaw;
  const sink: FakeStdin = {
    isTTY,
    get isRaw() {
      return isRaw;
    },
    rawCalls,
    paused: false,
    resumed: false,
    setRawMode(mode) {
      rawCalls.push(mode);
      isRaw = mode;
    },
    setEncoding(_encoding) {
      // ignore — sink consumes whatever bytes the test pushes via `feed`.
    },
    resume() {
      sink.resumed = true;
    },
    pause() {
      sink.paused = true;
    },
    on(event, listener) {
      emitter.on(event, listener);
    },
    off(event, listener) {
      emitter.off(event, listener);
    },
    feed(s) {
      emitter.emit("data", s);
    },
    listenerCount() {
      return emitter.listenerCount("data");
    },
  };
  return sink;
}

// ---------------------------------------------------------------------------
// Fake clock — drives the bare-Esc flush + resize debounce deterministically.
// ---------------------------------------------------------------------------

interface FakeClock {
  readonly timers: LiveShellTimers;
  flush(): void;
  pendingCount(): number;
}

function makeFakeClock(): FakeClock {
  let next = 1;
  const cbs = new Map<number, () => void>();
  const timers: LiveShellTimers = {
    setTimeout: (cb, _ms) => {
      const id = next++;
      cbs.set(id, cb);
      return id;
    },
    clearTimeout: (handle) => {
      if (handle !== undefined) {
        cbs.delete(handle as number);
      }
    },
  };
  return {
    timers,
    flush() {
      const snapshot = [...cbs.entries()];
      cbs.clear();
      for (const [, cb] of snapshot) {
        cb();
      }
    },
    pendingCount() {
      return cbs.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Common boot — assemble a shell with all fakes wired.
// ---------------------------------------------------------------------------

interface BootResult {
  shell: ReturnType<typeof createLiveShell>;
  stdout: FakeStdout;
  stdin: FakeStdin;
  clock: FakeClock;
  safety: EventEmitter;
  /** Live read of the `onExit` invocation count — function, not value, so
   * destructuring callers see the post-keypress value rather than a snapshot. */
  exitCount(): number;
}

function bootShell(overrides: Partial<LiveShellOptions> = {}): BootResult {
  const stdout = makeFakeStdout();
  const stdin = makeFakeStdin();
  const clock = makeFakeClock();
  const safety = new EventEmitter();
  let exits = 0;
  const shell = createLiveShell({
    enabled: true,
    stdout,
    stdin,
    timers: clock.timers,
    safetyNetTarget: safety,
    onExit: () => {
      exits++;
    },
    ...overrides,
  });
  return {
    shell,
    stdout,
    stdin,
    clock,
    safety,
    exitCount: () => exits,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("cold start: enter-alt sequence + first frame full-paints", () => {
  const { shell, stdout } = bootShell();
  // The enter-alt sequence is emitted synchronously at boot.
  expect(stdout.take()).toBe("\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l");

  shell.pushFrame(["line1", "line2"]);
  const out = stdout.take();
  // DEC 2026 wrappers + banner (row 1, empty) + two body rows.
  expect(out).toContain("\x1b[?2026h");
  expect(out).toContain("\x1b[?2026l");
  // Banner row clears row 1 (empty body when live).
  expect(out).toContain("\x1b[1;1H\x1b[2K");
  // Body rows land at row 2 and row 3 — both freshly painted.
  expect(out).toContain("\x1b[2;1H\x1b[2Kline1");
  expect(out).toContain("\x1b[3;1H\x1b[2Kline2");
  shell.dispose();
});

test("steady-state diff: only changed rows re-emit", () => {
  const { shell, stdout } = bootShell();
  stdout.take(); // discard enter-alt
  shell.pushFrame(["alpha", "bravo", "charlie"]);
  stdout.take(); // discard first paint

  // Second push: change only the middle row.
  shell.pushFrame(["alpha", "BRAVO", "charlie"]);
  const out = stdout.take();
  // Unchanged rows produce no bytes; only the changed one does.
  expect(out).not.toContain("\x1b[2;1H\x1b[2Kalpha");
  expect(out).not.toContain("\x1b[4;1H\x1b[2Kcharlie");
  // The changed row (row 3, body index 1 → composite index 2 → 1-indexed 3).
  expect(out).toContain("\x1b[3;1H\x1b[2KBRAVO");
  // Still wrapped in DEC 2026.
  expect(out.startsWith("\x1b[?2026h")).toBe(true);
  expect(out.endsWith("\x1b[?2026l")).toBe(true);
  shell.dispose();
});

test("steady-state diff: identical frame emits only sync wrappers (no row writes)", () => {
  const { shell, stdout } = bootShell();
  stdout.take();
  shell.pushFrame(["only"]);
  stdout.take();
  // Identical content → no row writes between SYNC_BEGIN / SYNC_END.
  shell.pushFrame(["only"]);
  expect(stdout.take()).toBe("\x1b[?2026h\x1b[?2026l");
  shell.dispose();
});

test("removed rows clear-line the orphaned row indices", () => {
  const { shell, stdout } = bootShell();
  stdout.take();
  shell.pushFrame(["a", "b", "c"]);
  stdout.take();
  // Shrink: drop the last row.
  shell.pushFrame(["a", "b"]);
  const out = stdout.take();
  // The orphaned former-`c` row (composite index 3 → row 4) gets a clear-line.
  expect(out).toContain("\x1b[4;1H\x1b[2K");
  shell.dispose();
});

test("resize: debounced, then full re-render of current frame", () => {
  const { shell, stdout, clock } = bootShell();
  stdout.take();
  shell.pushFrame(["x", "y"]);
  stdout.take();

  // Simulate a SIGWINCH-driven resize event. The shell debounces via the
  // injected clock — no bytes until we flush.
  stdout.fireResize();
  expect(clock.pendingCount()).toBe(1);
  expect(stdout.take()).toBe("");

  // Coalesce: fire again before flushing — still just one timer.
  stdout.fireResize();
  expect(clock.pendingCount()).toBe(1);

  clock.flush();
  const out = stdout.take();
  // Force re-render: every row re-paints (banner + both body rows).
  expect(out).toContain("\x1b[1;1H\x1b[2K");
  expect(out).toContain("\x1b[2;1H\x1b[2Kx");
  expect(out).toContain("\x1b[3;1H\x1b[2Ky");
  shell.dispose();
});

test("resize: force-paint clears the alt-screen before walking rows", () => {
  // The force branch (resize) must wipe the alt-screen first so any rogue
  // content from outside the differ's model — past stdout writes, terminal
  // -side reflow, etc. — cannot survive the repaint. The clear lives inside
  // SYNC_BEGIN/SYNC_END so supporting terminals still paint atomically.
  const { shell, stdout, clock } = bootShell();
  stdout.take();
  shell.pushFrame(["x", "y"]);
  stdout.take();

  stdout.fireResize();
  clock.flush();
  const out = stdout.take();
  // The clear-screen + home sequence appears between SYNC_BEGIN and the
  // first row write — i.e. before any `\x1b[r;1H` row position.
  const syncIdx = out.indexOf("\x1b[?2026h");
  const clearIdx = out.indexOf("\x1b[2J\x1b[H");
  const firstRowIdx = out.indexOf("\x1b[1;1H");
  expect(syncIdx).toBe(0);
  expect(clearIdx).toBeGreaterThan(syncIdx);
  expect(clearIdx).toBeLessThan(firstRowIdx);
  shell.dispose();
});

test("steady-state diff does NOT clear the alt-screen (only force paths do)", () => {
  // Defensive: the non-force diff must not emit the clear-screen sequence —
  // doing so would defeat the per-row diff. Only the resize force-paint
  // path clears.
  const { shell, stdout } = bootShell();
  stdout.take();
  shell.pushFrame(["a"]);
  stdout.take();
  shell.pushFrame(["b"]);
  const out = stdout.take();
  expect(out).not.toContain("\x1b[2J\x1b[H");
  shell.dispose();
});

test("scroll-back: left arrow decrements viewIdx and updates banner without auto-snap", () => {
  const { shell, stdout, stdin } = bootShell();
  stdout.take();
  // Three frames build up history.
  shell.pushFrame(["frame-A"]);
  shell.pushFrame(["frame-B"]);
  shell.pushFrame(["frame-C"]);
  stdout.take();

  // Left arrow — `\x1b[D` — should step back one frame, render banner +
  // frame body, and NOT snap to live.
  stdin.feed("\x1b[D");
  const out = stdout.take();
  // Banner shows "frame 2 of 3" (viewIdx = length - 2 = 1; humans: 2/3).
  expect(out).toContain(
    "\x1b[1;1H\x1b[2Kframe 2 of 3 — press G to return to live",
  );
  // Body row 1 (composite row 2) shows the held frame's content.
  expect(out).toContain("\x1b[2;1H\x1b[2Kframe-B");
  shell.dispose();
});

test("new frames during scroll-back silently update banner count, not body", () => {
  const { shell, stdout, stdin } = bootShell();
  stdout.take();
  shell.pushFrame(["F1"]);
  shell.pushFrame(["F2"]);
  shell.pushFrame(["F3"]);
  stdout.take();

  stdin.feed("\x1b[D"); // step back to viewIdx=1 → showing F2
  stdout.take();

  // A new frame lands while scrolled back — body should NOT change to the
  // new content; banner count should bump to 4.
  shell.pushFrame(["F4"]);
  const out = stdout.take();
  expect(out).toContain(
    "\x1b[1;1H\x1b[2Kframe 2 of 4 — press G to return to live",
  );
  // The held-frame body (F2) is unchanged — no row-2 diff bytes.
  expect(out).not.toContain("\x1b[2;1H\x1b[2KF4");
  shell.dispose();
});

test("G snaps to live and re-paints the tip", () => {
  const { shell, stdout, stdin } = bootShell();
  stdout.take();
  shell.pushFrame(["F1"]);
  shell.pushFrame(["F2"]);
  shell.pushFrame(["F3"]);
  stdout.take();

  // Step back twice — now viewing F1 (viewIdx=0).
  stdin.feed("\x1b[D");
  stdin.feed("\x1b[D");
  stdout.take();

  // Press G — snap to live. Banner clears; row 2 shows F3 (the tip).
  stdin.feed("G");
  const out = stdout.take();
  // Banner row clears (empty when live).
  expect(out).toContain("\x1b[1;1H\x1b[2K");
  // Tip body lands at row 2.
  expect(out).toContain("\x1b[2;1H\x1b[2KF3");
  shell.dispose();
});

test("q triggers dispose and onExit; teardown sequence emits leave-alt", () => {
  const { shell, stdout, stdin, exitCount } = bootShell();
  stdout.take();
  shell.pushFrame(["body"]);
  stdout.take();

  stdin.feed("q");
  const out = stdout.take();
  // Leave-alt sequence: show cursor, leave alt-screen, reset SGR.
  expect(out).toContain("\x1b[?25h\x1b[?1049l\x1b[0m");
  expect(exitCount()).toBe(1);
  // A second dispose() is a no-op — already exited.
  shell.dispose();
  expect(stdout.take()).toBe("");
});

test("dispose() called twice is a no-op (second call writes nothing)", () => {
  const { shell, stdout } = bootShell();
  stdout.take();
  shell.pushFrame(["row"]);
  stdout.take();

  shell.dispose();
  const first = stdout.take();
  expect(first).toContain("\x1b[?25h\x1b[?1049l\x1b[0m");

  shell.dispose();
  expect(stdout.take()).toBe("");
});

test("non-TTY path: enabled=false writes plain joined text; dispose is no-op", () => {
  const stdout = makeFakeStdout();
  const stdin = makeFakeStdin();
  const shell = createLiveShell({
    enabled: false,
    stdout,
    stdin,
  });
  // No enter-alt — non-enabled path skips it entirely.
  expect(stdout.take()).toBe("");

  shell.pushFrame(["one", "two", "three"]);
  expect(stdout.take()).toBe("one\ntwo\nthree\n");

  shell.dispose();
  // dispose writes nothing in the non-TTY path.
  expect(stdout.take()).toBe("");
  // And we never touched raw mode.
  expect(stdin.rawCalls).toEqual([]);
});

test("non-TTY path: stdout is TTY but stdin isn't → still disabled", () => {
  const stdout = makeFakeStdout({ tty: true });
  const stdin = makeFakeStdin({ tty: false });
  const shell = createLiveShell({ enabled: true, stdout, stdin });
  expect(stdout.take()).toBe("");
  shell.pushFrame(["x"]);
  expect(stdout.take()).toBe("x\n");
  shell.dispose();
});

test("partial-read key parser: bare Esc fires only after idle flush", () => {
  const { shell, stdout, stdin, clock } = bootShell();
  stdout.take();
  shell.pushFrame(["F1"]);
  shell.pushFrame(["F2"]);
  stdout.take();
  // Step back so we can verify Esc snaps to live.
  stdin.feed("\x1b[D");
  stdout.take();

  // Feed a bare `\x1b` — no key dispatch yet (waiting for follow-up byte
  // or the idle-flush timer to fire).
  stdin.feed("\x1b");
  expect(stdout.take()).toBe("");
  expect(clock.pendingCount()).toBe(1);

  // Flush the idle timer — bare Esc dispatches as "snap to live".
  clock.flush();
  const out = stdout.take();
  // Banner clears (back to live); row 2 shows the tip (F2).
  expect(out).toContain("\x1b[1;1H\x1b[2K");
  expect(out).toContain("\x1b[2;1H\x1b[2KF2");
  shell.dispose();
});

test("CSI split across chunks: \\x1b[ then A resolves to one Up keypress", () => {
  const { shell, stdout, stdin } = bootShell();
  stdout.take();
  shell.pushFrame(["F1"]);
  shell.pushFrame(["F2"]);
  shell.pushFrame(["F3"]);
  stdout.take();

  // Three-stage split: `\x1b`, then `[`, then `A`. Each chunk is fed
  // separately; only the final `A` should complete the sequence and
  // dispatch as Up (step back).
  stdin.feed("\x1b");
  expect(stdout.take()).toBe("");
  stdin.feed("[");
  expect(stdout.take()).toBe("");
  stdin.feed("A");
  const out = stdout.take();
  // Step back: viewIdx becomes 1 (length-2), banner shows "frame 2 of 3".
  expect(out).toContain(
    "\x1b[1;1H\x1b[2Kframe 2 of 3 — press G to return to live",
  );
  expect(out).toContain("\x1b[2;1H\x1b[2KF2");
  shell.dispose();
});

test("resize does NOT clear frame history; scroll-back still works after resize", () => {
  const { shell, stdout, stdin, clock } = bootShell();
  stdout.take();
  shell.pushFrame(["F1"]);
  shell.pushFrame(["F2"]);
  stdout.take();

  stdout.fireResize();
  clock.flush();
  stdout.take();

  // After the resize, scroll-back still has both frames.
  stdin.feed("\x1b[D");
  const out = stdout.take();
  expect(out).toContain(
    "\x1b[1;1H\x1b[2Kframe 1 of 2 — press G to return to live",
  );
  expect(out).toContain("\x1b[2;1H\x1b[2KF1");
  shell.dispose();
});

test("pushFrame while disposed writes nothing", () => {
  const { shell, stdout } = bootShell();
  stdout.take();
  shell.dispose();
  stdout.take(); // discard leave-alt
  shell.pushFrame(["should be silent"]);
  expect(stdout.take()).toBe("");
});

test("safety-net listeners attach on enable and detach on dispose", () => {
  const safety = new EventEmitter();
  expect(safety.listenerCount("exit")).toBe(0);
  expect(safety.listenerCount("uncaughtException")).toBe(0);
  expect(safety.listenerCount("unhandledRejection")).toBe(0);

  const stdout = makeFakeStdout();
  const stdin = makeFakeStdin();
  const shell = createLiveShell({
    enabled: true,
    stdout,
    stdin,
    safetyNetTarget: safety,
    onExit: () => {},
  });
  expect(safety.listenerCount("exit")).toBe(1);
  expect(safety.listenerCount("uncaughtException")).toBe(1);
  expect(safety.listenerCount("unhandledRejection")).toBe(1);

  shell.dispose();
  expect(safety.listenerCount("exit")).toBe(0);
  expect(safety.listenerCount("uncaughtException")).toBe(0);
  expect(safety.listenerCount("unhandledRejection")).toBe(0);
});

test("safety-net 'exit' fire triggers dispose (leave-alt lands)", () => {
  const { stdout, safety } = bootShell();
  stdout.take();
  // Fire process.exit safety-net — the shell should dispose and emit
  // leave-alt without onExit firing (that's the q/Ctrl-C path).
  safety.emit("exit");
  expect(stdout.take()).toContain("\x1b[?25h\x1b[?1049l\x1b[0m");
});

test("raw-mode restored to wasRaw on dispose", () => {
  const stdout = makeFakeStdout();
  // Caller's stdin started in raw mode (e.g. nested TUI). Restore should
  // put it back to true, not blindly false.
  const stdin = makeFakeStdin({ isRaw: true });
  const safety = new EventEmitter();
  const shell = createLiveShell({
    enabled: true,
    stdout,
    stdin,
    safetyNetTarget: safety,
    onExit: () => {},
  });
  expect(stdin.rawCalls).toEqual([true]);
  shell.dispose();
  // First call flipped to true (enable); second restored to wasRaw (true).
  expect(stdin.rawCalls).toEqual([true, true]);
});

test("history ring-buffer caps at historyCap; oldest drops on overflow", () => {
  const { shell, stdout, stdin } = bootShell({ historyCap: 3 });
  stdout.take();
  shell.pushFrame(["F1"]);
  shell.pushFrame(["F2"]);
  shell.pushFrame(["F3"]);
  shell.pushFrame(["F4"]); // overflow — F1 evicted
  stdout.take();

  // Step back to oldest — that's now F2, banner says "1 of 3".
  stdin.feed("g");
  const out = stdout.take();
  expect(out).toContain(
    "\x1b[1;1H\x1b[2Kframe 1 of 3 — press G to return to live",
  );
  expect(out).toContain("\x1b[2;1H\x1b[2KF2");
  shell.dispose();
});

test("Ctrl-C (\\x03) triggers dispose + onExit (same path as q)", () => {
  const { shell, stdout, stdin, exitCount } = bootShell();
  stdout.take();
  shell.pushFrame(["row"]);
  stdout.take();
  stdin.feed("\x03");
  expect(stdout.take()).toContain("\x1b[?25h\x1b[?1049l\x1b[0m");
  expect(exitCount()).toBe(1);
  shell.dispose();
});

test("vim-style h/j/k/l navigate history; printable letters are otherwise ignored", () => {
  const { shell, stdout, stdin } = bootShell();
  stdout.take();
  shell.pushFrame(["F1"]);
  shell.pushFrame(["F2"]);
  shell.pushFrame(["F3"]);
  stdout.take();

  stdin.feed("k"); // step back
  expect(stdout.take()).toContain("\x1b[2;1H\x1b[2KF2");

  stdin.feed("h"); // step back further
  expect(stdout.take()).toContain("\x1b[2;1H\x1b[2KF1");

  stdin.feed("l"); // forward
  expect(stdout.take()).toContain("\x1b[2;1H\x1b[2KF2");

  stdin.feed("j"); // forward — past the tip → snap to live, render F3
  expect(stdout.take()).toContain("\x1b[2;1H\x1b[2KF3");

  // An unmapped printable letter does nothing.
  stdin.feed("z");
  expect(stdout.take()).toBe("");

  shell.dispose();
});

test("refreshLive updates the live view body without growing history", () => {
  // The 30s tick in `scripts/usage.ts` calls `refreshLive` to recompute
  // relative-time strings without minting a new frame. The contract:
  // (a) live view re-renders with the new body, (b) history length
  // does not change, (c) stepping back still shows the original
  // at-capture render.
  const { shell, stdout, stdin } = bootShell();
  stdout.take();
  shell.pushFrame(["captured at 3m"]);
  stdout.take();

  // Tick: same row, fresher text.
  shell.refreshLive(["captured at 2m"]);
  const tickOut = stdout.take();
  expect(tickOut).toContain("\x1b[2;1H\x1b[2Kcaptured at 2m");
  // No new frame: banner still reads "frame 1" / "live results", never
  // bumps the M count.
  expect(tickOut).not.toContain("frame 2");

  // Step back via left-arrow: with only one frame, viewIdx clamps to 0
  // and the *frozen* capture-time text is shown — not the overlay.
  stdin.feed("\x1b[D");
  const backOut = stdout.take();
  expect(backOut).toContain("\x1b[2;1H\x1b[2Kcaptured at 3m");
  expect(backOut).not.toContain("captured at 2m");

  shell.dispose();
});

test("refreshLive overlay is cleared by the next pushFrame", () => {
  // A fresh tip supersedes the overlay — re-rendering after a data
  // change must not show stale overlay text.
  const { shell, stdout } = bootShell();
  stdout.take();
  shell.pushFrame(["original"]);
  stdout.take();
  shell.refreshLive(["ticked"]);
  stdout.take();

  // Data change: new pushFrame's body is what renders, NOT the overlay.
  shell.pushFrame(["fresh-data"]);
  const out = stdout.take();
  expect(out).toContain("\x1b[2;1H\x1b[2Kfresh-data");
  expect(out).not.toContain("ticked");

  shell.dispose();
});

test("refreshLive while scrolled back does not redraw but applies on snap-to-live", () => {
  // Per the contract: when viewIdx !== "live", refreshLive caches the
  // overlay silently. Returning to live (`G`) then paints with the
  // overlay applied. This is how a tick that fires while the user is
  // browsing history still has its effect once they snap back.
  const { shell, stdout, stdin } = bootShell();
  stdout.take();
  shell.pushFrame(["A"]);
  shell.pushFrame(["B"]);
  stdout.take();

  // Step back so viewIdx becomes 0 (frame "A").
  stdin.feed("\x1b[D");
  stdout.take();

  // Tick fires while scrolled back — must produce no body re-render
  // (still showing "A"); only the banner row might repaint, but the
  // body row 2 must NOT change.
  shell.refreshLive(["B-ticked"]);
  const idleOut = stdout.take();
  expect(idleOut).not.toContain("B-ticked");
  // Body row stays on the historical "A" — i.e. either unchanged or
  // explicitly repainted as "A", never as "B-ticked".
  if (idleOut.includes("\x1b[2;1H\x1b[2K")) {
    expect(idleOut).toContain("\x1b[2;1H\x1b[2KA");
  }

  // Snap back to live with `G`: the overlay applies, rendering the
  // ticked body in place of the original tip "B".
  stdin.feed("G");
  const liveOut = stdout.take();
  expect(liveOut).toContain("\x1b[2;1H\x1b[2KB-ticked");

  shell.dispose();
});

test("refreshLive is a silent no-op in the non-TTY pass-through", () => {
  // Piping the script to a file or running under CI: `refreshLive` must
  // not print duplicated frame bodies. Only `pushFrame` produces output.
  const stdout = makeFakeStdout({ tty: false });
  const stdin = makeFakeStdin({ tty: false });
  const shell = createLiveShell({ enabled: true, stdout, stdin });
  shell.pushFrame(["row"]);
  expect(stdout.take()).toBe("row\n");

  shell.refreshLive(["row-ticked"]);
  expect(stdout.take()).toBe("");

  shell.dispose();
});

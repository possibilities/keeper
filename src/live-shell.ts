/**
 * `createLiveShell` — TUI-mode primitives shared by the three keeper scripts
 * (`scripts/autopilot.ts`, `scripts/board.ts`, `scripts/git.ts`) under their
 * forthcoming `--live` flag. Owns every side effect on `process.stdin` /
 * `process.stdout`: alt-screen enter/exit, cursor hide/show, raw-mode
 * lifecycle, per-line ANSI diff wrapped in DEC 2026 synchronized output,
 * ring-buffered frame history with keyboard navigation, the SIGWINCH-debounced
 * full re-render, and the safety-net teardown handlers (`exit` /
 * `uncaughtException` / `unhandledRejection`).
 *
 * Why a factory (no top-level side effects). The module is import-clean —
 * every state mutation happens inside `createLiveShell(opts)`. This means
 * `bun test --isolate` imports it without touching `process.stdin.setRawMode`,
 * without writing alt-screen escapes to the test runner's terminal, and without
 * attaching `process.on('exit', ...)` handlers that would leak between test
 * files. Tests construct an isolated shell against `PassThrough` streams,
 * exercise it, and dispose; no teardown crosstalk.
 *
 * Public surface
 * --------------
 * - `createLiveShell(opts)` — returns a `LiveShell` handle.
 * - `pushFrame(lines)` — called once per script emit. `lines` is one element
 *   per row; the live-shell never splits on `\n` and the caller's contract is
 *   "one row per element."
 * - `dispose()` — synchronous, idempotent. Restores raw mode, leaves the
 *   alt-screen, shows the cursor, detaches all listeners.
 *
 * Non-TTY behavior. When `opts.enabled === false`, OR when either of the
 * detected `stdout` / `stdin` is not a TTY, the returned shell falls back to
 * plain `stdout.write(lines.join("\n") + "\n")` and `dispose()` is a true
 * no-op. This satisfies the epic's "non-TTY behaves as if `--live` was not
 * set" contract — the caller can pass `enabled: true` from `--live` and the
 * shell still does the right thing when piped to a file or running under CI.
 *
 * Per-line diff contract
 * ----------------------
 * History is `string[][]` — each element is one frame, each frame is one
 * element per row (offset by 1 because row 1 is reserved for the banner). The
 * differ walks the rendered frame's rows against `prevLines`, emitting
 * `\x1b[<row>;1H\x1b[2K<line>` for every row where bytes changed and a
 * clear-line for rows past the new tip that existed in `prev`. The whole
 * buffer ships in ONE `stdout.write` wrapped in DEC 2026
 * (`\x1b[?2026h` … `\x1b[?2026l`) — supported terminals paint atomically;
 * unsupported terminals ignore the wrapper silently.
 *
 * Keyboard. CSI/SS3 escape parser modeled after the StdinBuffer pattern:
 * accumulate bytes, classify CSI (`\x1b[` … 0x40–0x7E final byte) and SS3
 * (`\x1bO` + 1 byte), flush a bare `\x1b` after a configurable idle timeout
 * (default 10 ms) so arrow keys aren't lost AND bare Escape isn't swallowed
 * forever. Keymap: `←/h/k` step back; `→/l/j` step forward (snaps to live
 * past the tip); `g` jump to oldest; `G`/`End`/`Esc` snap to live; `q`/`Ctrl-C`
 * dispose+exit; anything else ignored.
 *
 * Ring-buffer history. Capped at `historyCap` (default 500). Oldest frame
 * drops on overflow. `viewIdx` is either the integer index of a held frame OR
 * the sentinel `"live"` — meaning "always show the latest." New frames while
 * scrolled back silently append to history (banner's `M` count updates) and
 * do NOT auto-snap.
 *
 * Why `dispose()` is synchronous. `process.on('exit')` cannot await; an async
 * cleanup would skip in that path AND in `uncaughtException` /
 * `unhandledRejection` safety-nets. Any caller cleanup that must await
 * (socket close, buffered flush) belongs in the script's own
 * `handle.dispose()`, not here.
 *
 * Re-entrant dispose. `dispose()` may be reached three ways in the same tick:
 * (a) explicit caller invocation on SIGINT; (b) `process.on('exit')`
 * safety-net; (c) `q`/`Ctrl-C` key handler. The `disposed` flag guards
 * idempotency — a second call writes no bytes and detaches no listeners.
 *
 * Out of scope. No mouse mode, no scrollback indicator on resize, no
 * windowed history pagination — those land in follow-up tasks if/when a
 * script needs them.
 */

/**
 * Minimal writable-stream shape the shell drives. Matches the surface of
 * `process.stdout` that we touch: `write` to push bytes, `columns` / `rows` /
 * `isTTY` for size + TTY-gate detection, plus the `on`/`off` resize listener
 * pair. `getWindowSize()` is an escape-hatch read used iff `columns` / `rows`
 * are stale (see "Bun compiled-binary `stdout.columns` stale bug" in the
 * task spec). Defined structurally so tests can inject a `PassThrough`-style
 * sink and a real `process.stdout` both satisfy the type.
 */
export interface LiveShellStdout {
  write(data: string): boolean;
  readonly columns?: number;
  readonly rows?: number;
  readonly isTTY?: boolean;
  getWindowSize?(): [number, number];
  on(event: "resize", listener: () => void): void;
  off(event: "resize", listener: () => void): void;
}

/**
 * Minimal readable-stream shape the shell drives. Matches the surface of
 * `process.stdin` that we touch: raw-mode flip, `data` listener attach/detach,
 * `pause` / `resume`, and the encoding setter. `isRaw` reads the current
 * raw-mode state so `dispose()` can restore the exact pre-shell value
 * (protects nested-TUI invocations).
 */
export interface LiveShellStdin {
  setRawMode?(mode: boolean): void;
  resume(): void;
  pause(): void;
  setEncoding(encoding: "utf8"): void;
  on(event: "data", listener: (chunk: string | Buffer) => void): void;
  off(event: "data", listener: (chunk: string | Buffer) => void): void;
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
}

/**
 * Injectable scheduler — mirrors the `SchedulerTimers` pattern in
 * `src/rescan.ts`. Tests pass a fake clock so the escape-flush idle and the
 * resize debounce fire deterministically; production omits the option and
 * the shell wires the global `setTimeout` / `clearTimeout`.
 */
export interface LiveShellTimers {
  setTimeout(
    cb: () => void,
    ms: number,
  ): ReturnType<typeof setTimeout> | number;
  clearTimeout(
    handle: ReturnType<typeof setTimeout> | number | undefined,
  ): void;
}

/**
 * Construction options. `enabled` is the caller's `--live` flag — when false,
 * the factory returns a pass-through shell that never touches raw mode and
 * never writes ANSI. `stdout` / `stdin` default to the process streams; tests
 * inject `PassThrough` siblings. `historyCap` defaults to 500. `timers`
 * defaults to the global scheduler. `escFlushMs` defaults to 10 ms (bare-Esc
 * flush gate). `resizeDebounceMs` defaults to 100 ms (SIGWINCH debounce).
 *
 * `safetyNetTarget` defaults to the live `process`. Tests inject a stub
 * (`new EventEmitter()`) so the shell can attach `exit` / `uncaughtException`
 * / `unhandledRejection` listeners without leaking onto the real process
 * across test files.
 */
export interface LiveShellOptions {
  readonly enabled: boolean;
  readonly stdout?: LiveShellStdout;
  readonly stdin?: LiveShellStdin;
  readonly historyCap?: number;
  readonly timers?: LiveShellTimers;
  readonly escFlushMs?: number;
  readonly resizeDebounceMs?: number;
  readonly safetyNetTarget?: SafetyNetTarget;
  /**
   * Called when `q` / `Ctrl-C` is pressed. Defaults to `() => process.exit(0)`.
   * Tests inject a recorder so they can assert "exit was requested" without
   * actually terminating the test runner.
   */
  readonly onExit?: () => void;
}

/**
 * Safety-net subscription target. The shell attaches `exit`,
 * `uncaughtException`, and `unhandledRejection` listeners so a process-level
 * crash still gets the alt-screen torn down. Structurally typed so tests can
 * inject an `EventEmitter` and verify (a) listeners attach on enable, (b)
 * `dispose()` detaches them, and (c) firing them invokes `dispose()`.
 */
export interface SafetyNetTarget {
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
}

/**
 * Caller-facing handle. `pushFrame` ships one frame's worth of rendered rows
 * (one element per row). `dispose()` is synchronous and idempotent — a second
 * call writes nothing and detaches no listeners.
 */
export interface LiveShell {
  pushFrame(lines: string[]): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// ANSI primitives — captured at module scope so the byte sequences are
// asserted byte-identically in tests (see `test/live-shell.test.ts`).
// ---------------------------------------------------------------------------

const ENTER_ALT = "\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l";
const LEAVE_ALT = "\x1b[?25h\x1b[?1049l\x1b[0m";
const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const CLEAR_LINE = "\x1b[2K";
// Erase entire alt-screen + home cursor — prepended to the force-repaint
// buffer on SIGWINCH so any rogue content (from external stdout writes
// outside `pushFrame`, terminal-side reflow, etc.) cannot survive a
// resize. The differ's `prevLines` model becomes authoritative again
// on the very next paint.
const CLEAR_SCREEN_HOME = "\x1b[2J\x1b[H";

function moveTo(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_HISTORY_CAP = 500;
const DEFAULT_ESC_FLUSH_MS = 10;
const DEFAULT_RESIZE_DEBOUNCE_MS = 100;

const DEFAULT_TIMERS: LiveShellTimers = {
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (handle) => {
    if (handle !== undefined) {
      globalThis.clearTimeout(
        handle as Parameters<typeof globalThis.clearTimeout>[0],
      );
    }
  },
};

// ---------------------------------------------------------------------------
// View-index sentinel — "live" means "always render the tip"; an integer is
// the index of a held frame. A type alias makes the disjunction explicit at
// the call sites that branch on it.
// ---------------------------------------------------------------------------

type ViewIdx = number | "live";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a live-shell handle. See module docstring for the full contract.
 *
 * Lifecycle (when `enabled` resolves to true):
 *   1. Save `wasRaw = stdin.isRaw ?? false`.
 *   2. Write `ENTER_ALT` (alt-screen + clear + home + hide cursor).
 *   3. `stdin.setRawMode(true)`; `setEncoding("utf8")`; `resume()`;
 *      attach `data` listener (escape-sequence parser).
 *   4. Attach `stdout.on('resize', ...)` debounced ~100 ms — re-render the
 *      currently-viewed frame at the new dimensions on each fire.
 *   5. Attach `exit` / `uncaughtException` / `unhandledRejection`
 *      safety-net listeners on `safetyNetTarget`.
 *
 * Teardown reverses the lifecycle (detach listeners → pause stdin →
 * `setRawMode(wasRaw)` → write `LEAVE_ALT`). Order is load-bearing: pausing
 * before flipping raw mode protects against a buffered Ctrl-D closing the
 * parent shell over SSH (epic best-practice).
 */
export function createLiveShell(opts: LiveShellOptions): LiveShell {
  const stdout = (opts.stdout ?? process.stdout) as LiveShellStdout;
  const stdin = (opts.stdin ?? process.stdin) as LiveShellStdin;
  const ttyOk = Boolean(stdout.isTTY) && Boolean(stdin.isTTY);
  const enabled = opts.enabled && ttyOk;

  // ----- Non-TTY / disabled path: pass-through shell, no state, no listeners.
  // `dispose()` is a no-op — we never touched anything to begin with.
  if (!enabled) {
    let disabledDisposed = false;
    return {
      pushFrame(lines: string[]): void {
        if (disabledDisposed) {
          return;
        }
        stdout.write(`${lines.join("\n")}\n`);
      },
      dispose(): void {
        // No-op; flag exists only so a post-dispose `pushFrame` is silent.
        disabledDisposed = true;
      },
    };
  }

  // ----- Enabled path: full TUI state machine.
  const historyCap = Math.max(1, opts.historyCap ?? DEFAULT_HISTORY_CAP);
  const timers = opts.timers ?? DEFAULT_TIMERS;
  const escFlushMs = opts.escFlushMs ?? DEFAULT_ESC_FLUSH_MS;
  const resizeDebounceMs = opts.resizeDebounceMs ?? DEFAULT_RESIZE_DEBOUNCE_MS;
  const safetyNetTarget = opts.safetyNetTarget ?? (process as SafetyNetTarget);
  const onExit = opts.onExit ?? (() => process.exit(0));

  const history: string[][] = [];
  // The currently-painted rows (offset by 1; index 0 is row 2, etc.). `null`
  // before the first paint so the first frame full-paints.
  let prevLines: string[] | null = null;
  let viewIdx: ViewIdx = "live";
  let disposed = false;
  const wasRaw = stdin.isRaw ?? false;

  // ---- Escape-parser state.
  // `escBuf` accumulates bytes that begin with `\x1b`. When a complete CSI
  // (final byte 0x40–0x7E) or SS3 (single byte after `\x1bO`) lands, we
  // dispatch and clear. A bare `\x1b` (no follow-up byte within
  // `escFlushMs`) flushes as the Escape key.
  let escBuf = "";
  let escFlushHandle: ReturnType<typeof setTimeout> | number | undefined;

  // ---- Resize-debounce state.
  let resizeHandle: ReturnType<typeof setTimeout> | number | undefined;

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  /**
   * Compose the banner row (row 1, 1-indexed). Blank when live; "frame N
   * of M — press G to return to live" when scrolled back. Rendered as part
   * of the per-line diff so banner state can't desync from the frame.
   */
  function bannerFor(view: ViewIdx, total: number): string {
    if (view === "live" || total === 0) {
      return "";
    }
    // `view` is 0-indexed within the held frames; humans count from 1.
    return `frame ${view + 1} of ${total} — press G to return to live`;
  }

  /**
   * Resolve the rows the user is currently viewing. `viewIdx === "live"`
   * resolves to the tip; an integer index reads from history. Bounds are
   * already clamped on the input side (the key handler), but this guard
   * is cheap and defensive against an empty-history call.
   */
  function visibleRows(view: ViewIdx): string[] {
    if (history.length === 0) {
      return [];
    }
    if (view === "live") {
      return history[history.length - 1] ?? [];
    }
    return history[view] ?? [];
  }

  /**
   * Per-line diff. Builds the diff buffer (banner row + every changed body
   * row + clear-line for body rows past the new tip that existed in prev),
   * wraps it in DEC 2026, and ships in one `stdout.write`. Updates
   * `prevLines` to the new tip so the next call diffs against this state.
   *
   * `force` skips the diff and full-paints every row — used on resize.
   */
  function renderDiff(force: boolean): void {
    const total = history.length;
    const banner = bannerFor(viewIdx, total);
    const body = visibleRows(viewIdx);
    // Composite "rendered frame" — banner at index 0, body lines after.
    const next = [banner, ...body];
    const prev = force ? null : prevLines;

    // Force-paint (resize): wipe the alt-screen first so any rogue
    // content from outside the differ's model — past stdout writes,
    // terminal-side reflow on resize, etc. — gets cleared. Lives inside
    // the SYNC_BEGIN/END wrapper so supporting terminals still paint
    // atomically.
    let buf = SYNC_BEGIN + (force ? CLEAR_SCREEN_HOME : "");
    const maxLen = Math.max(next.length, prev?.length ?? 0);
    for (let i = 0; i < maxLen; i++) {
      const nextLine = next[i];
      const prevLine = prev?.[i];
      if (i < next.length) {
        if (force || prevLine === undefined || nextLine !== prevLine) {
          // Row N in the protocol = our composite index N + 1 (1-indexed).
          buf += `${moveTo(i + 1, 1)}${CLEAR_LINE}${nextLine ?? ""}`;
        }
      } else if (prevLine !== undefined) {
        // Row existed in prev but not in next — clear it.
        buf += `${moveTo(i + 1, 1)}${CLEAR_LINE}`;
      }
    }
    buf += SYNC_END;
    stdout.write(buf);
    prevLines = next;
  }

  // ---------------------------------------------------------------------
  // Key dispatch
  // ---------------------------------------------------------------------

  /**
   * Move `viewIdx` one frame backward. From "live" we step to the
   * second-to-last frame (the last is what's currently on screen, so
   * "back" means stepping into the held history). Clamps at 0.
   */
  function stepBack(): void {
    if (history.length === 0) {
      return;
    }
    if (viewIdx === "live") {
      // From live, "back" lands on the last held frame BEFORE the tip,
      // i.e. `length - 2`. If history is length 1 (only a tip exists)
      // there's nothing earlier; snap to 0.
      viewIdx = Math.max(0, history.length - 2);
    } else {
      viewIdx = Math.max(0, viewIdx - 1);
    }
    renderDiff(false);
  }

  /**
   * Move `viewIdx` one frame forward. Stepping past the tip snaps to
   * "live" (the tip is always the visible "live" content).
   */
  function stepForward(): void {
    if (history.length === 0) {
      return;
    }
    if (viewIdx === "live") {
      return;
    }
    const next = viewIdx + 1;
    if (next >= history.length - 1) {
      // Landing on (or past) the tip snaps to "live" — the tip IS live.
      viewIdx = "live";
    } else {
      viewIdx = next;
    }
    renderDiff(false);
  }

  function jumpOldest(): void {
    if (history.length === 0) {
      return;
    }
    viewIdx = 0;
    renderDiff(false);
  }

  function snapLive(): void {
    if (viewIdx === "live") {
      return;
    }
    viewIdx = "live";
    renderDiff(false);
  }

  function dispatchKey(key: string): void {
    switch (key) {
      case "\x1b[A": // Up
      case "\x1b[D": // Left
      case "h":
      case "k":
        stepBack();
        return;
      case "\x1b[B": // Down
      case "\x1b[C": // Right
      case "j":
      case "l":
        stepForward();
        return;
      case "g":
        jumpOldest();
        return;
      case "G":
      case "\x1b[F": // End
      case "\x1b": // bare Escape
        snapLive();
        return;
      case "q":
      case "\x03": // Ctrl-C
        dispose();
        onExit();
        return;
      default:
        // ignore everything else (printable letters, unmapped CSI, etc.)
        return;
    }
  }

  // ---------------------------------------------------------------------
  // Escape parser
  // ---------------------------------------------------------------------

  /**
   * Cancel any armed bare-Esc flush. Called when a follow-up byte arrives
   * (the bare-Esc interpretation is wrong — we're in a sequence) AND on
   * teardown.
   */
  function cancelEscFlush(): void {
    if (escFlushHandle !== undefined) {
      timers.clearTimeout(escFlushHandle);
      escFlushHandle = undefined;
    }
  }

  /**
   * Arm the bare-Esc flush. Called after a fresh `\x1b` lands so that, if
   * no follow-up byte arrives within `escFlushMs`, the buffer flushes as
   * the Escape key. Re-arming replaces any prior timer (CSI bytes cancel
   * via `cancelEscFlush`).
   */
  function armEscFlush(): void {
    cancelEscFlush();
    escFlushHandle = timers.setTimeout(() => {
      escFlushHandle = undefined;
      if (escBuf === "\x1b") {
        escBuf = "";
        dispatchKey("\x1b");
      }
    }, escFlushMs);
  }

  /**
   * Feed one chunk of stdin bytes through the parser. Bytes are classified
   * in three modes:
   *   - In an escape sequence (`escBuf` non-empty): accumulate until the
   *     sequence completes (CSI final 0x40–0x7E or SS3 single byte). On
   *     completion, dispatch and clear.
   *   - Bare `\x1b` arrival: stash in `escBuf` and arm the flush timer.
   *   - Any other byte: dispatch directly as a single-char key.
   */
  function feedStdin(chunk: string | Buffer): void {
    const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const ch of str) {
      if (escBuf.length > 0) {
        escBuf += ch;
        // SS3: `\x1bO` + 1 byte → 3-byte sequence.
        if (escBuf.length === 3 && escBuf[1] === "O") {
          const seq = escBuf;
          escBuf = "";
          cancelEscFlush();
          dispatchKey(seq);
          continue;
        }
        // CSI: `\x1b[` … final byte 0x40–0x7E. Once we see `\x1b[`, any
        // byte in that range completes the sequence.
        if (escBuf.length >= 3 && escBuf[1] === "[") {
          const code = ch.charCodeAt(0);
          if (code >= 0x40 && code <= 0x7e) {
            const seq = escBuf;
            escBuf = "";
            cancelEscFlush();
            dispatchKey(seq);
            continue;
          }
          // Otherwise keep accumulating (parameter bytes 0x30–0x3F /
          // intermediate bytes 0x20–0x2F).
          cancelEscFlush();
          continue;
        }
        // The second byte of an escape (anything other than `[` or `O`)
        // is non-CSI/SS3 — treat as a two-byte Meta key; we don't map any
        // today, so just clear and ignore. But cancel the bare-Esc flush
        // because the `\x1b` was a real sequence prefix, not bare Esc.
        if (escBuf.length === 2 && escBuf[1] !== "[" && escBuf[1] !== "O") {
          escBuf = "";
          cancelEscFlush();
          continue;
        }
        // Still in `\x1b` waiting for the second byte — keep waiting.
        continue;
      }
      if (ch === "\x1b") {
        escBuf = "\x1b";
        armEscFlush();
        continue;
      }
      dispatchKey(ch);
    }
  }

  // ---------------------------------------------------------------------
  // Resize debounce
  // ---------------------------------------------------------------------

  /**
   * SIGWINCH handler. Debounces `resizeDebounceMs` and full-paints the
   * currently-viewed frame at the new dimensions. We don't try to ANSI-diff
   * through a resize (the diff state's row indices may not map to the new
   * geometry); a force re-render is correct and cheap.
   */
  function onResize(): void {
    if (resizeHandle !== undefined) {
      timers.clearTimeout(resizeHandle);
      resizeHandle = undefined;
    }
    resizeHandle = timers.setTimeout(() => {
      resizeHandle = undefined;
      if (disposed) {
        return;
      }
      renderDiff(true);
    }, resizeDebounceMs);
  }

  // ---------------------------------------------------------------------
  // Safety-net handlers
  // ---------------------------------------------------------------------

  // Wrap dispose so the unhandled-* listeners can be detached by identity.
  // Listeners receive payload arguments we don't need — we just dispose.
  const onProcessExit = (): void => {
    dispose();
  };
  const onUncaught = (): void => {
    dispose();
  };
  const onUnhandledRejection = (): void => {
    dispose();
  };

  // The `data` listener must be referentially stable so `off()` removes
  // the exact function we attached.
  const onStdinData = (chunk: string | Buffer): void => {
    if (disposed) {
      return;
    }
    feedStdin(chunk);
  };

  // ---------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------

  function pushFrame(lines: string[]): void {
    if (disposed) {
      return;
    }
    // Store a shallow copy so caller mutation can't corrupt history.
    const copy = lines.slice();
    history.push(copy);
    if (history.length > historyCap) {
      // Drop oldest. If `viewIdx` is an integer index, also nudge it down
      // so it keeps pointing at the same logical frame (or clamp to 0 if
      // that frame just got evicted).
      history.shift();
      if (typeof viewIdx === "number") {
        viewIdx = Math.max(0, viewIdx - 1);
      }
    }
    if (viewIdx === "live") {
      // Live: render this frame via per-line diff against prevLines.
      renderDiff(false);
    } else {
      // Scrolled back: don't re-render the body — but the banner row
      // shows `M` (total), so re-render JUST that. The differ does the
      // right thing: only the banner row's bytes will have changed.
      renderDiff(false);
    }
  }

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    // Cancel timers BEFORE detaching anything else so an in-flight resize
    // or esc-flush doesn't fire on a torn-down shell.
    if (resizeHandle !== undefined) {
      timers.clearTimeout(resizeHandle);
      resizeHandle = undefined;
    }
    cancelEscFlush();
    // Detach the stdin listener; pause; restore raw mode (in that order).
    // The `pause()` before `setRawMode(false)` protects a buffered Ctrl-D
    // from closing the parent shell over SSH (epic best-practice).
    try {
      stdin.off("data", onStdinData);
    } catch {
      // listener was never attached (e.g. dispose() called twice racing
      // with enable) — nothing to remove.
    }
    try {
      stdin.pause();
    } catch {
      // already paused / closed
    }
    if (stdin.setRawMode) {
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        // raw mode was already cleared
      }
    }
    // Detach resize listener.
    try {
      stdout.off("resize", onResize);
    } catch {
      // already detached
    }
    // Detach safety-net listeners — by identity.
    try {
      safetyNetTarget.off("exit", onProcessExit);
      safetyNetTarget.off("uncaughtException", onUncaught);
      safetyNetTarget.off("unhandledRejection", onUnhandledRejection);
    } catch {
      // target was a partial emitter — best-effort detach.
    }
    // Finally leave the alt-screen + show the cursor + reset SGR.
    try {
      stdout.write(LEAVE_ALT);
    } catch {
      // stdout closed under us — nothing we can do.
    }
  }

  // ----- Initialize (after handles are defined, so any throw can be caught
  // by the caller; the shell is not "live" until this block completes).
  stdout.write(ENTER_ALT);
  if (stdin.setRawMode) {
    stdin.setRawMode(true);
  }
  stdin.setEncoding("utf8");
  stdin.resume();
  stdin.on("data", onStdinData);
  stdout.on("resize", onResize);
  safetyNetTarget.on("exit", onProcessExit);
  safetyNetTarget.on("uncaughtException", onUncaught);
  safetyNetTarget.on("unhandledRejection", onUnhandledRejection);

  return { pushFrame, dispose };
}

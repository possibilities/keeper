/**
 * `live-shell-core` — the renderer-agnostic state machine extracted from
 * `src/live-shell.ts` ahead of the OpenTUI paint cutover. Pure state +
 * string composition, no terminal I/O.
 *
 * Owns:
 *   - History ring buffer (`historyCap` default 500, `viewIdx` nudge on
 *     evict).
 *   - The `"live"` sentinel + single-slot `liveOverlay` for time-driven
 *     re-renders that don't grow history.
 *   - The `bannerStatus` segment toggled by the paint-layer's
 *     `setStatus(...)`.
 *   - The banner string composer (`[[<title>]] Showing live results` /
 *     `frame N of M — press G to return to live` + status suffix).
 *     Plain text — the paint layer applies dim styling on top.
 *   - The CSI/SS3 escape-sequence parser + keymap dispatch
 *     (`←/→/h/j/k/l/g/G/End/Esc/q/Ctrl-C`).
 *   - The non-TTY pass-through decision — when `enabled === false` OR
 *     either of `ttyOk` is false, `pushFrame` falls back to plain
 *     `onPlainWrite("<lines>\n")` and `refreshLive` / `setStatus` /
 *     `dispose` are silent no-ops.
 *
 * Why a separate module: the core is the durable artifact — its state
 * transitions are tested verbatim against the same inputs/outputs they
 * were tested against pre-OpenTUI-port. The paint layer (`src/live-shell.ts`)
 * swaps from the bespoke per-line ANSI diff to OpenTUI's `TextRenderable`
 * / `ScrollBoxRenderable` mutation surface without disturbing this state.
 *
 * Render notifications: the paint layer subscribes to state changes via
 * the `onRender()` callback — fired whenever a state mutation needs the
 * visible body or banner to repaint. In TUI mode the paint layer routes
 * this into an OpenTUI `requestRender()`; in non-TTY mode the callback
 * is never invoked (we wrote the plain bytes directly).
 *
 * The escape-parser timing is injectable via `LiveShellTimers` — the
 * bare-Esc idle flush fires after `escFlushMs` (default 10) so the
 * parser can disambiguate "bare Escape" from "CSI introducer" without
 * losing arrow keys to a partial-chunk read. Tests pass a fake clock
 * for determinism.
 */

/**
 * Injectable scheduler. Mirrors the `SchedulerTimers` pattern in
 * `src/rescan.ts`. Tests pass a fake clock so the escape-flush idle
 * fires deterministically; production omits the option and the core
 * wires the global `setTimeout` / `clearTimeout`.
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
 * View-index sentinel — `"live"` means "always render the tip"; an
 * integer is the index of a held frame.
 */
export type ViewIdx = number | "live";

/**
 * Construction options for the core. `enabled` mirrors the paint
 * layer's `--live` gate; `ttyOk` is the paint layer's "stdout AND
 * stdin are TTYs" probe. When both are true the core operates in
 * "tui" mode and fires `onRender` on every state change; otherwise
 * it operates in "passthrough" mode and writes plain text via
 * `onPlainWrite`.
 *
 * `onPlainWrite` is the non-TTY write sink. Required even when
 * `enabled === true` because the constructor flips to passthrough
 * iff `ttyOk === false` — the paint layer supplies the stdout's
 * `write` here.
 *
 * `onRender` is the paint-trigger callback for TUI mode. The paint
 * layer routes this into the OpenTUI renderer's `requestRender()`.
 * Never invoked in passthrough mode.
 *
 * `onExit` fires on `q` / Ctrl-C — paint layer typically wires this
 * to `process.exit(0)` after its own teardown. Defaults to a no-op
 * so unit tests can omit it without crashing.
 *
 * `onUnhandledKey` receives any key the built-in keymap doesn't
 * handle. The argument is the raw string the dispatcher saw — a
 * single character for printable keys, or the full CSI/SS3 sequence
 * for escape-prefixed keys. Lets callers bind `c` for copy, etc.
 * without forking the core.
 *
 * `title` is the report prefix folded into the banner row (e.g.
 * `"git"` → `[[git]] Showing live results`). Empty / omitted means
 * no prefix — back-compat for tests and callers that don't need
 * chrome.
 */
export interface LiveShellCoreOptions {
  readonly enabled: boolean;
  readonly ttyOk: boolean;
  readonly title?: string;
  readonly historyCap?: number;
  readonly timers?: LiveShellTimers;
  readonly escFlushMs?: number;
  readonly onPlainWrite: (data: string) => void;
  readonly onRender?: () => void;
  readonly onExit?: () => void;
  readonly onUnhandledKey?: (key: string) => void;
}

/**
 * Public surface for the paint layer to read state and feed input.
 * `pushFrame` / `refreshLive` / `setStatus` are the caller-facing
 * mutations; `feedStdin` is the byte sink the paint layer routes
 * stdin (or a key event's `sequence`) into. `bannerText` /
 * `visibleRows` / `historyLen` / `getViewIdx` are the projection
 * surface the paint layer reads when rendering a frame.
 */
export interface LiveShellCore {
  readonly mode: "tui" | "passthrough";
  pushFrame(lines: string[]): void;
  refreshLive(lines: string[]): void;
  setStatus(status: string): void;
  feedStdin(chunk: string | Buffer): void;
  bannerText(): string;
  visibleRows(): string[];
  historyLen(): number;
  getViewIdx(): ViewIdx;
  dispose(): void;
}

const DEFAULT_HISTORY_CAP = 500;
const DEFAULT_ESC_FLUSH_MS = 10;

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

/**
 * Build the core state machine. See module docstring for the full
 * contract. Synchronous — no native allocations, no listeners attached
 * to external emitters. The paint layer is responsible for stitching
 * `feedStdin` to its stdin source and `onRender` to its repaint trigger.
 */
export function createLiveShellCore(opts: LiveShellCoreOptions): LiveShellCore {
  const enabled = opts.enabled && opts.ttyOk;
  const onPlainWrite = opts.onPlainWrite;

  if (!enabled) {
    // Passthrough mode — write plain joined text on pushFrame; the rest
    // are silent no-ops. dispose() flips a flag so a late pushFrame is
    // silent (matches the original LiveShell contract).
    let passthroughDisposed = false;
    return {
      mode: "passthrough",
      pushFrame(lines: string[]): void {
        if (passthroughDisposed) {
          return;
        }
        onPlainWrite(`${lines.join("\n")}\n`);
      },
      refreshLive(_lines: string[]): void {
        // Silent no-op in passthrough: time-driven re-renders would
        // print duplicate frame bodies when piped to a file or under CI.
      },
      setStatus(_status: string): void {
        // Silent no-op in passthrough: no banner to update.
      },
      feedStdin(_chunk: string | Buffer): void {
        // Silent no-op: passthrough never reads input.
      },
      bannerText(): string {
        return "";
      },
      visibleRows(): string[] {
        return [];
      },
      historyLen(): number {
        return 0;
      },
      getViewIdx(): ViewIdx {
        return "live";
      },
      dispose(): void {
        passthroughDisposed = true;
      },
    };
  }

  // TUI mode — pure state machine. The paint layer subscribes to
  // `onRender` and pulls `bannerText()` / `visibleRows()` on each
  // notification.
  const historyCap = Math.max(1, opts.historyCap ?? DEFAULT_HISTORY_CAP);
  const timers = opts.timers ?? DEFAULT_TIMERS;
  const escFlushMs = opts.escFlushMs ?? DEFAULT_ESC_FLUSH_MS;
  const onRender = opts.onRender ?? (() => {});
  const onExit = opts.onExit ?? (() => {});
  const onUnhandledKey = opts.onUnhandledKey;
  const titlePrefix =
    opts.title != null && opts.title !== "" ? `[[${opts.title}]] ` : "";

  const history: string[][] = [];
  let viewIdx: ViewIdx = "live";
  let disposed = false;
  let liveOverlay: string[] | null = null;
  let bannerStatus = "";

  // Escape-parser state. `escBuf` accumulates bytes that begin with
  // `\x1b`; the bare-Esc flush timer disambiguates a real Escape
  // keystroke from a CSI/SS3 introducer.
  let escBuf = "";
  let escFlushHandle: ReturnType<typeof setTimeout> | number | undefined;

  /**
   * Compose the banner row. Plain text — the paint layer applies dim
   * styling on top. The original ANSI-wrapped form is reproduced
   * faithfully by the OpenTUI paint layer's `TextRenderable` with
   * `attributes: TextAttributes.DIM`.
   */
  function bannerText(): string {
    const total = history.length;
    const statusSuffix = bannerStatus === "" ? "" : ` ${bannerStatus}`;
    if (viewIdx === "live" || total === 0) {
      return total === 0
        ? `${titlePrefix}Showing live results${statusSuffix}`
        : `${titlePrefix}Showing live results (frame ${total})${statusSuffix}`;
    }
    // `viewIdx` is 0-indexed within held frames; humans count from 1.
    return `${titlePrefix}frame ${viewIdx + 1} of ${total} — press G to return to live${statusSuffix}`;
  }

  /**
   * Resolve the rows the user is currently viewing. `viewIdx === "live"`
   * resolves to the tip (or the overlay when set); an integer index
   * reads the held frame. An empty history yields an empty array so
   * a pre-first-frame paint doesn't crash.
   */
  function visibleRows(): string[] {
    if (history.length === 0) {
      return [];
    }
    if (viewIdx === "live") {
      return liveOverlay ?? history[history.length - 1] ?? [];
    }
    return history[viewIdx] ?? [];
  }

  function stepBack(): void {
    if (history.length === 0) {
      return;
    }
    if (viewIdx === "live") {
      // From live, "back" lands on the last held frame BEFORE the tip,
      // i.e. `length - 2`. If history is length 1, snap to 0.
      viewIdx = Math.max(0, history.length - 2);
    } else {
      viewIdx = Math.max(0, viewIdx - 1);
    }
    onRender();
  }

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
    onRender();
  }

  function jumpOldest(): void {
    if (history.length === 0) {
      return;
    }
    viewIdx = 0;
    onRender();
  }

  function snapLive(): void {
    if (viewIdx === "live") {
      return;
    }
    viewIdx = "live";
    onRender();
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
        if (onUnhandledKey !== undefined) {
          onUnhandledKey(key);
        }
        return;
    }
  }

  function cancelEscFlush(): void {
    if (escFlushHandle !== undefined) {
      timers.clearTimeout(escFlushHandle);
      escFlushHandle = undefined;
    }
  }

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
   * Feed one chunk of bytes through the parser. Classifies in three
   * modes: in-escape-sequence accumulation, bare-`\x1b` introducer
   * stash + flush-arm, or direct single-char dispatch.
   */
  function feedStdin(chunk: string | Buffer): void {
    if (disposed) {
      return;
    }
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
        // CSI: `\x1b[` … final byte 0x40–0x7E.
        if (escBuf.length >= 3 && escBuf[1] === "[") {
          const code = ch.charCodeAt(0);
          if (code >= 0x40 && code <= 0x7e) {
            const seq = escBuf;
            escBuf = "";
            cancelEscFlush();
            dispatchKey(seq);
            continue;
          }
          cancelEscFlush();
          continue;
        }
        // Second byte of escape that isn't `[` or `O` — treat as
        // unmapped two-byte Meta key; clear silently.
        if (escBuf.length === 2 && escBuf[1] !== "[" && escBuf[1] !== "O") {
          escBuf = "";
          cancelEscFlush();
          continue;
        }
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

  function pushFrame(lines: string[]): void {
    if (disposed) {
      return;
    }
    // A fresh tip supersedes any time-driven overlay.
    liveOverlay = null;
    const copy = lines.slice();
    history.push(copy);
    if (history.length > historyCap) {
      // Drop oldest; nudge `viewIdx` down so an integer index keeps
      // pointing at the same logical frame (clamp at 0).
      history.shift();
      if (typeof viewIdx === "number") {
        viewIdx = Math.max(0, viewIdx - 1);
      }
    }
    onRender();
  }

  function refreshLive(lines: string[]): void {
    if (disposed) {
      return;
    }
    liveOverlay = lines.slice();
    if (viewIdx === "live") {
      onRender();
    }
    // When scrolled back, the overlay sits dormant until snap-to-live
    // picks it up via `visibleRows`.
  }

  function setStatus(status: string): void {
    if (disposed) {
      return;
    }
    if (bannerStatus === status) {
      return;
    }
    bannerStatus = status;
    onRender();
  }

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    cancelEscFlush();
  }

  return {
    mode: "tui",
    pushFrame,
    refreshLive,
    setStatus,
    feedStdin,
    bannerText,
    visibleRows,
    historyLen: () => history.length,
    getViewIdx: () => viewIdx,
    dispose,
  };
}

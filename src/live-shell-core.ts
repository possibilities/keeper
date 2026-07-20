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
  /**
   * Modal-capture predicate. When supplied AND it returns `true`,
   * `dispatchKey` routes EVERY key to `onUnhandledKey` (normalized to
   * friendly tokens — `up`/`down`/`left`/`right`/`end`/`escape`/`space`,
   * else the raw char) and SKIPS the built-in frame-history keymap, so a
   * view can own the keyboard while in a sub-mode (e.g. jobs' insert
   * mode). Ctrl-C still quits as a safety hatch. Absent/false → the
   * keymap behaves byte-identically to before (board/git/autopilot are
   * untouched).
   */
  readonly captureKeys?: () => boolean;
}

/**
 * Public surface for the paint layer to read state and feed input.
 * `pushFrame` / `refreshLive` / `setStatus` are the caller-facing
 * mutations; `feedStdin` is the byte sink the paint layer routes
 * stdin (or a key event's `sequence`) into. `bannerText` /
 * `visibleRows` / `historyLen` / `getViewIdx` are the projection
 * surface the paint layer reads when rendering a frame.
 */
export interface LiveShellHeader {
  readonly lines: readonly string[];
  readonly renderAtWidth?: (width: number) => string[];
}

export interface LiveShellCore {
  readonly mode: "tui" | "passthrough";
  pushFrame(lines: string[], header?: LiveShellHeader): void;
  refreshLive(lines: string[], header?: LiveShellHeader): void;
  /** Drop the ephemeral live overlay without changing frame history. */
  clearLiveOverlay(): void;
  setStatus(status: string): void;
  feedStdin(chunk: string | Buffer): void;
  bannerText(): string;
  visibleRows(): string[];
  visibleHeaderRows(width: number): string[];
  historyLen(): number;
  getViewIdx(): ViewIdx;
  /**
   * Read-and-clear the "a user-initiated frame switch happened since the
   * last paint" flag. Set ONLY by the four navigation actions
   * (`stepBack` / `stepForward` / `jumpOldest` / `snapLive`) — NOT by
   * `pushFrame` (live data update or ring-buffer eviction), `refreshLive`
   * (overlay), or `setStatus` (banner churn). The paint layer consumes
   * this in `repaint()` to decide whether to snap the ScrollBox back to
   * the top: a genuine frame switch resets scroll so a tall frame opens
   * at its head; a live update preserves the human's scroll position so
   * reading a long board isn't yanked to row 0 on every daemon tick.
   * Passthrough mode always returns `false` (no scrollable surface).
   */
  takeScrollReset(): boolean;
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
      pushFrame(lines: string[], header?: LiveShellHeader): void {
        if (passthroughDisposed) {
          return;
        }
        onPlainWrite(`${[...(header?.lines ?? []), ...lines].join("\n")}\n`);
      },
      refreshLive(lines: string[], header?: LiveShellHeader): void {
        // Write plain exactly like passthrough `pushFrame` so the
        // connecting spinner (fn-696, now routed through `refreshLive`)
        // still emits when non-TTY/piped and the view-shell tests that
        // observe spinner text via stdout keep working. Safe from
        // duplicate-body floods: the only other `refreshLive` caller
        // (`repaintLocal`) is key-driven and passthrough `feedStdin` is a
        // no-op, so it can never fire here.
        if (passthroughDisposed) {
          return;
        }
        onPlainWrite(`${[...(header?.lines ?? []), ...lines].join("\n")}\n`);
      },
      clearLiveOverlay(): void {
        // No retained overlay exists in passthrough mode.
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
      visibleHeaderRows(_width: number): string[] {
        return [];
      },
      historyLen(): number {
        return 0;
      },
      getViewIdx(): ViewIdx {
        return "live";
      },
      takeScrollReset(): boolean {
        return false;
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
  const captureKeys = opts.captureKeys;
  const titlePrefix =
    opts.title != null && opts.title !== "" ? `[[${opts.title}]] ` : "";

  type Frame = { body: string[]; header: LiveShellHeader };
  const emptyHeader: LiveShellHeader = { lines: [] };
  const history: Frame[] = [];
  let viewIdx: ViewIdx = "live";
  let disposed = false;
  let liveOverlay: { body: string[]; header: LiveShellHeader | null } | null =
    null;
  let bannerStatus = "";
  // Set by the navigation actions, read-and-cleared by the paint layer
  // via `takeScrollReset()`. Distinguishes a user-initiated frame switch
  // (snap scroll to top) from a content update (preserve scroll). See
  // the `takeScrollReset` docstring on `LiveShellCore`.
  let scrollResetPending = false;

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
  function visibleFrame(): Frame {
    const tip = history[history.length - 1];
    if (history.length === 0) {
      return {
        body: liveOverlay?.body ?? [],
        header: liveOverlay?.header ?? emptyHeader,
      };
    }
    if (viewIdx === "live" && liveOverlay !== null) {
      return {
        body: liveOverlay.body,
        header: liveOverlay.header ?? tip?.header ?? emptyHeader,
      };
    }
    return viewIdx === "live"
      ? (tip ?? { body: [], header: emptyHeader })
      : (history[viewIdx] ?? { body: [], header: emptyHeader });
  }

  function visibleRows(): string[] {
    return visibleFrame().body;
  }

  function visibleHeaderRows(width: number): string[] {
    const header = visibleFrame().header;
    return (header.renderAtWidth?.(width) ?? header.lines).slice();
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
    scrollResetPending = true;
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
    scrollResetPending = true;
    onRender();
  }

  function jumpOldest(): void {
    if (history.length === 0) {
      return;
    }
    viewIdx = 0;
    scrollResetPending = true;
    onRender();
  }

  function snapLive(): void {
    if (viewIdx === "live") {
      return;
    }
    viewIdx = "live";
    scrollResetPending = true;
    onRender();
  }

  /**
   * Map the raw dispatch string to a friendly token for modal-capture
   * consumers. CSI/SS3 nav sequences collapse to `up`/`down`/`left`/
   * `right`/`end`, bare Escape to `escape`, the space char to `space`;
   * any other single char passes through unchanged (`j`, `k`, `i`, …).
   */
  function normalizeCaptureKey(key: string): string {
    switch (key) {
      case "\x1b[A":
      case "\x1bOA":
        return "up";
      case "\x1b[B":
      case "\x1bOB":
        return "down";
      case "\x1b[C":
      case "\x1bOC":
        return "right";
      case "\x1b[D":
      case "\x1bOD":
        return "left";
      case "\x1b[F":
        return "end";
      case "\x1b":
        return "escape";
      case " ":
        return "space";
      default:
        return key;
    }
  }

  function dispatchKey(key: string): void {
    // Modal capture: a view owns the keyboard. Ctrl-C still quits (never
    // trap the user); everything else is normalized and handed to the
    // view, bypassing the frame-history keymap entirely.
    if (captureKeys?.()) {
      if (key === "\x03") {
        dispose();
        onExit();
        return;
      }
      onUnhandledKey?.(normalizeCaptureKey(key));
      return;
    }
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

  function pushFrame(lines: string[], header?: LiveShellHeader): void {
    if (disposed) {
      return;
    }
    // A fresh tip supersedes any time-driven overlay.
    liveOverlay = null;
    history.push({ body: lines.slice(), header: header ?? emptyHeader });
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

  function refreshLive(lines: string[], header?: LiveShellHeader): void {
    if (disposed) {
      return;
    }
    liveOverlay = { body: lines.slice(), header: header ?? null };
    if (viewIdx === "live") {
      onRender();
    }
    // When scrolled back, the overlay sits dormant until snap-to-live
    // picks it up via `visibleRows`.
  }

  function clearLiveOverlay(): void {
    if (disposed || liveOverlay === null) {
      return;
    }
    liveOverlay = null;
    if (viewIdx === "live") {
      onRender();
    }
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
    clearLiveOverlay,
    setStatus,
    feedStdin,
    bannerText,
    visibleRows,
    visibleHeaderRows,
    historyLen: () => history.length,
    getViewIdx: () => viewIdx,
    takeScrollReset: () => {
      const pending = scrollResetPending;
      scrollResetPending = false;
      return pending;
    },
    dispose,
  };
}

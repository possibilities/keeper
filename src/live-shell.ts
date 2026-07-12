/**
 * `createLiveShell` — shared TUI primitives for keeper viewers.
 * Owns the OpenTUI renderer lifecycle: alt-screen enter/exit (via
 * `screenMode: "alternate-screen"`), raw-mode + cursor handling
 * (driven by OpenTUI's `setupTerminal()`), per-key dispatch via the
 * renderer's `keyInput`, mutation-based content updates against a
 * `TextRenderable` body (pooled — only the count changes on a row-
 * count delta), and the safety-net teardown handlers (`exit` /
 * `uncaughtException` / `unhandledRejection`).
 *
 * Why a factory (no top-level side effects). The module is import-clean
 * — every native allocation happens inside `createLiveShell(opts)`. This
 * means `bun test --isolate` imports it without spawning an OpenTUI
 * renderer, without touching `process.stdin.setRawMode`, and without
 * attaching `process.on('exit', ...)` handlers that would leak between
 * test files.
 *
 * Public surface (unchanged from pre-OpenTUI-port)
 * --------------
 * - `createLiveShell(opts)` — returns a `LiveShell` handle.
 * - `pushFrame(lines)` — called once per script emit. `lines` is one
 *   element per row.
 * - `refreshLive(lines)` — re-render the live view's body without
 *   appending to history. Cleared by the next `pushFrame`.
 * - `setStatus(status)` — update a short caller-controlled segment
 *   folded into the banner row.
 * - `dispose()` — synchronous, idempotent. Tears down the OpenTUI
 *   renderer; restores the terminal.
 *
 * Non-TTY behavior. When `opts.enabled === false`, OR when either of
 * the detected `stdout` / `stdin` is not a TTY, the returned shell
 * NEVER constructs an OpenTUI renderer — it falls back to plain
 * `stdout.write(lines.join("\n") + "\n")` and `dispose()` is a true
 * no-op. The renderer-agnostic core (`src/live-shell-core.ts`) holds
 * this decision so the same passthrough semantics hold whether the
 * caller passes `enabled: true` to a piped invocation or `enabled:
 * false` explicitly.
 *
 * Keyboard ownership. The ScrollBox stays UNFOCUSED — it captures
 * arrow keys only when focused. `autoFocus: false` is set on the
 * renderer; we own every key via `renderer.keyInput.on("keypress",
 * ...)`, translate the OpenTUI `key.name` back to the raw-string
 * contract the core's keymap dispatch expects (a single character
 * for printable keys, or the full CSI/SS3 sequence for nav keys),
 * and route everything else to the caller's `onUnhandledKey`. Ctrl-Z
 * is intercepted in the paint layer for the job-control suspend dance
 * (`renderer.suspend()` → re-raise SIGTSTP → `renderer.resume()` on the
 * SIGCONT that `fg` delivers) since raw mode suppresses the kernel's
 * own ISIG handling.
 *
 * Why `dispose()` is synchronous. `process.on('exit')` cannot await;
 * an async cleanup would skip in that path AND in `uncaughtException`
 * / `unhandledRejection` safety-nets. OpenTUI's `destroy()` is
 * synchronous so we can run it inline.
 *
 * Safety nets are LOAD-BEARING. OpenTUI does NOT hook `process.exit`
 * / unhandled rejections — a hard exit without `renderer.destroy()`
 * leaves the terminal in raw / alt mode. We attach `exit`,
 * `uncaughtException`, and `unhandledRejection` listeners that call
 * `dispose()` regardless of whether the caller did so explicitly.
 *
 * Re-entrant dispose. `dispose()` may be reached three ways in the
 * same tick: (a) explicit caller invocation on SIGINT; (b)
 * `process.on('exit')` safety-net; (c) `q`/`Ctrl-C` key handler. The
 * `disposed` flag guards idempotency.
 */

// Type-only imports from `@opentui/core`. The runtime values
// (`createCliRenderer`, `TextRenderable`, `ScrollBoxRenderable`,
// `TextAttributes`) are dynamically imported inside the TUI-path
// branch of `createLiveShell` and the body of `attachLiveShellPaint`
// — see the docstrings on each. This split exists because the
// `@opentui/core-<platform>-<arch>` native package has a top-level
// `await import(...)` that races under `bun test --isolate` when
// multiple test workers load `@opentui/core` cold; the type-only
// import keeps the script-side tests (`test/git.test.ts` etc.)
// from triggering that load at module-graph evaluation time, since
// they exercise `cli/git.ts` only as far as `renderRowBlocks` and
// never touch a live renderer.
import type {
  CliRenderer,
  KeyEvent,
  RGBA,
  ScrollBoxRenderable,
  StyledText,
  TextRenderable,
} from "@opentui/core";
import { type AnsiToStyledRuntime, linesToContent } from "./ansi-to-styled";
import {
  createLiveShellCore,
  type LiveShellCore,
  type LiveShellTimers,
} from "./live-shell-core";

/**
 * Minimal writable-stream shape the shell reads (TTY probe + write
 * fallback for the passthrough path). The OpenTUI renderer requires
 * `process.stdout` to wire alt-screen / mouse / capability detection;
 * the production path always uses `process.stdout` directly when in
 * TUI mode. Tests boot the shell with `enabled: false` (or non-TTY
 * fakes) to exercise the passthrough; paint tests use OpenTUI's
 * `createTestRenderer` directly, not this factory.
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
 * Minimal readable-stream shape the shell touches for the TTY probe.
 * In TUI mode OpenTUI's renderer drives raw-mode + `resume()` itself
 * via `setupTerminal()`; we only read `isTTY` to decide whether to
 * construct the renderer at all.
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

// Re-export the timer interface for callers that already import it
// from `live-shell` (tests). The interface is owned by the core; this
// is a forwarding alias so the public surface stays stable across
// the OpenTUI port.
export type { LiveShellTimers };

/**
 * Construction options. `enabled` is the caller's `--live` flag —
 * when false, the factory returns a passthrough shell that never
 * constructs an OpenTUI renderer and never touches raw mode. `stdout`
 * / `stdin` default to the process streams. `historyCap` defaults to
 * 500. `timers` defaults to the global scheduler — used by the core's
 * bare-Esc flush.
 *
 * `escFlushMs` / `resizeDebounceMs` are retained for back-compat but
 * `resizeDebounceMs` is unused under the OpenTUI port (the renderer
 * debounces resize internally). `escFlushMs` still drives the core's
 * bare-Esc disambiguation.
 *
 * `safetyNetTarget` defaults to the live `process`. Tests inject a
 * stub (`new EventEmitter()`) so the shell can attach `exit` /
 * `uncaughtException` / `unhandledRejection` listeners without leaking
 * onto the real process across test files. Pre-OpenTUI tests covered
 * this against the bespoke renderer; the safety-net surface itself
 * is preserved exactly.
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
  readonly onExit?: () => void;
  readonly onUnhandledKey?: (key: string) => void;
  /**
   * Modal-capture predicate forwarded to the core. When it returns
   * `true`, every key routes to `onUnhandledKey` and the frame-history
   * keymap is bypassed (see `LiveShellCoreOptions.captureKeys`).
   */
  readonly captureKeys?: () => boolean;
  readonly title?: string;
}

/**
 * Safety-net subscription target. The shell attaches `exit`,
 * `uncaughtException`, and `unhandledRejection` listeners so a
 * process-level crash still tears down the OpenTUI renderer.
 * Structurally typed so tests can inject an `EventEmitter`.
 */
export interface SafetyNetTarget {
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
}

/**
 * Caller-facing handle — unchanged from pre-OpenTUI-port.
 */
export interface LiveShell {
  pushFrame(lines: string[]): void;
  refreshLive(lines: string[]): void;
  setStatus(status: string): void;
  dispose(): void;
}

/**
 * Build a live-shell handle. See module docstring for the full
 * contract.
 *
 * In TUI mode (when `opts.enabled === true` AND both streams are
 * TTYs): synchronously constructs an OpenTUI `CliRenderer` over the
 * process streams (the renderer ctor allocates native resources
 * eagerly; `setupTerminal()` is fired-and-forgotten with frames
 * queued during the brief async window). The root layout is a
 * column Box of:
 *   - row 0: a dim `TextRenderable` banner (height 1, width 100%);
 *   - row 1+: a `ScrollBoxRenderable` body (height: rest of viewport)
 *     containing one `TextRenderable` whose `content` is the joined
 *     visible rows.
 *
 * In passthrough mode: no renderer is constructed; the core's
 * passthrough writes are routed back to `stdout.write`.
 */
export function createLiveShell(opts: LiveShellOptions): LiveShell {
  const stdout = (opts.stdout ?? process.stdout) as LiveShellStdout;
  const stdin = (opts.stdin ?? process.stdin) as LiveShellStdin;
  const ttyOk = Boolean(stdout.isTTY) && Boolean(stdin.isTTY);
  const enabled = opts.enabled && ttyOk;

  // ----- Passthrough path: core handles plain writes; no renderer.
  if (!enabled) {
    const core = createLiveShellCore({
      enabled: opts.enabled,
      ttyOk,
      title: opts.title,
      historyCap: opts.historyCap,
      timers: opts.timers,
      escFlushMs: opts.escFlushMs,
      onPlainWrite: (data) => stdout.write(data),
      onExit: opts.onExit,
      onUnhandledKey: opts.onUnhandledKey,
      captureKeys: opts.captureKeys,
    });
    return {
      pushFrame: (lines) => core.pushFrame(lines),
      refreshLive: (lines) => core.refreshLive(lines),
      setStatus: (status) => core.setStatus(status),
      dispose: () => core.dispose(),
    };
  }

  // ----- TUI path: spin up OpenTUI; wire the core's render trigger
  // through `renderer.requestRender()`.
  const safetyNetTarget = opts.safetyNetTarget ?? (process as SafetyNetTarget);
  const onExit = opts.onExit ?? (() => process.exit(0));

  let disposed = false;
  let setupErrored = false;
  let paint: LiveShellPaint | null = null;

  const core = createLiveShellCore({
    enabled: true,
    ttyOk: true,
    title: opts.title,
    historyCap: opts.historyCap,
    timers: opts.timers,
    escFlushMs: opts.escFlushMs,
    // onPlainWrite is required by the interface but never invoked in
    // TUI mode. Keep it a defensive no-op rather than throwing so a
    // logic bug doesn't crash the renderer.
    onPlainWrite: () => {},
    onRender: () => paint?.repaint(),
    onExit: () => {
      // Sequence: tear down the renderer first (restore terminal),
      // then run the caller's exit hook. Matches the pre-OpenTUI
      // ordering — terminal restored before any caller side effects.
      dispose();
      onExit();
    },
    onUnhandledKey: opts.onUnhandledKey,
    captureKeys: opts.captureKeys,
  });

  // ----- Safety-net plumbing — load-bearing per OpenTUI best
  // practices (the renderer does NOT hook process.exit /
  // unhandledRejection). We attach by named handler so dispose()
  // can detach by identity.
  const onProcessExit = (): void => {
    dispose();
  };
  const onUncaught = (): void => {
    dispose();
  };
  const onUnhandledRejection = (): void => {
    dispose();
  };

  safetyNetTarget.on("exit", onProcessExit);
  safetyNetTarget.on("uncaughtException", onUncaught);
  safetyNetTarget.on("unhandledRejection", onUnhandledRejection);

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    core.dispose();
    // Detach safety-net listeners by identity. The wrapper catches
    // any throw from a partial-emitter test stub.
    try {
      safetyNetTarget.off("exit", onProcessExit);
      safetyNetTarget.off("uncaughtException", onUncaught);
      safetyNetTarget.off("unhandledRejection", onUnhandledRejection);
    } catch {
      // best-effort
    }
    // Destroy the OpenTUI renderer if it managed to come up.
    // Synchronous — restores the terminal in one shot.
    if (paint != null) {
      paint.destroy();
      paint = null;
    }
  }

  // ----- Async renderer setup. The handle MUST be returned
  // synchronously to preserve the caller surface, so we kick the
  // renderer up in a microtask and queue any pushFrame/refreshLive
  // calls (via the core's history) until the renderer is ready —
  // the first paint reads `core.bannerText()` / `core.visibleRows()`
  // as soon as the renderer mounts.
  //
  // OpenTUI is dynamic-imported here (not at module scope) because
  // its native-binary loader has a top-level `await import(...)` that
  // races under `bun test --isolate`. Module-graph consumers that
  // never hit this code path (e.g. `test/git.test.ts` exercising
  // `renderRowBlocks` from `cli/git.ts`) avoid paying the load cost
  // entirely.
  void (async () => {
    try {
      const otui = await import("@opentui/core");
      const r = await otui.createCliRenderer({
        // OpenTUI does NOT hook exit / unhandledRejection — our
        // safety-net listeners handle those. Drop SIGINT from
        // exitSignals AND disable the dedicated Ctrl-C exit path
        // so the `q`/Ctrl-C key handler in the core stays the
        // canonical exit route.
        exitOnCtrlC: false,
        exitSignals: ["SIGTERM", "SIGHUP", "SIGQUIT"],
        autoFocus: false,
        // Use the dedicated alt-screen so we don't trash the user's
        // scrollback. (Default; explicit for clarity.)
        screenMode: "alternate-screen",
      });
      if (disposed) {
        // Caller already disposed before setup completed — tear
        // down the freshly-constructed renderer immediately.
        try {
          r.destroy();
        } catch {
          // best-effort
        }
        return;
      }
      paint = attachLiveShellPaint(
        r,
        core,
        {
          TextRenderable: otui.TextRenderable,
          ScrollBoxRenderable: otui.ScrollBoxRenderable,
          TextAttributes: otui.TextAttributes,
          // fn-646.4: shim runtime — board emits SGR escapes that the
          // paint layer parses into StyledText chunks. Other TUIs emit
          // plain text and short-circuit on the no-`\x1b` fast path
          // inside `linesToContent`.
          StyledText: otui.StyledText,
          RGBA: otui.RGBA,
        },
        { onUnhandledKey: opts.onUnhandledKey },
      );
    } catch (err) {
      setupErrored = true;
      // Setup failure: log to stderr and dispose. We swallow rather
      // than throw because the caller's invocation contract is
      // "createLiveShell returns synchronously" — surfacing the
      // failure here would already be past the caller's catch.
      try {
        process.stderr.write(
          `live-shell: OpenTUI setup failed (${String(err)}); falling back to silent passthrough\n`,
        );
      } catch {
        // best-effort
      }
      dispose();
    }
  })();

  return {
    pushFrame: (lines: string[]): void => {
      if (disposed || setupErrored) {
        return;
      }
      core.pushFrame(lines);
    },
    refreshLive: (lines: string[]): void => {
      if (disposed || setupErrored) {
        return;
      }
      core.refreshLive(lines);
    },
    setStatus: (status: string): void => {
      if (disposed || setupErrored) {
        return;
      }
      core.setStatus(status);
    },
    dispose,
  };
}

// ---------------------------------------------------------------------------
// Paint layer — exposed for paint tests (`test/live-shell.test.ts`) so
// they can build the same scene against `createTestRenderer` without
// forking the renderer-construction code. Production callers go
// through `createLiveShell` above; the paint layer is a private
// implementation detail otherwise.
// ---------------------------------------------------------------------------

/**
 * Options for `attachLiveShellPaint`. `onUnhandledKey` is the same
 * callback the `createLiveShell` factory takes — used by the
 * keypress handler for keys the core's keymap doesn't route. Note
 * that printable keys (`c`, `z`, etc.) reach the caller via the
 * CORE's `onUnhandledKey`, not this one — the paint layer's
 * `onUnhandledKey` fires only on rare empty-sequence keys (an
 * OpenTUI edge case).
 */
export interface LiveShellPaintOptions {
  readonly onUnhandledKey?: (key: string) => void;
  /**
   * Process-signal surface the Ctrl-Z suspend dance drives. Defaults to
   * the live `process`. Tests inject a stub so they can assert the
   * `kill(pid, "SIGTSTP")` + `SIGCONT`-rearm wiring without actually
   * stopping the test runner. Structurally typed so `process` satisfies
   * it.
   */
  readonly signalTarget?: SuspendSignalTarget;
}

/**
 * Minimal process-signal surface the Ctrl-Z handler needs. `process`
 * satisfies this structurally. Ctrl-Z arrives as the literal byte
 * `\x1a` (raw mode disables ISIG, so the terminal never generates
 * SIGTSTP itself) — the app must restore the terminal, then re-raise
 * SIGTSTP to actually stop the process group, then re-enter the
 * renderer on the SIGCONT that `fg` delivers.
 */
export interface SuspendSignalTarget {
  readonly pid: number;
  kill(pid: number, signal: NodeJS.Signals): void;
  once(event: "SIGCONT", listener: () => void): void;
  removeListener(event: "SIGCONT", listener: () => void): void;
}

/**
 * Runtime exports from `@opentui/core` that `attachLiveShellPaint`
 * needs to construct the scene. Threaded through as a parameter so
 * the live-shell module itself only carries a type-only import of
 * `@opentui/core` — the runtime values get loaded lazily inside
 * `createLiveShell`'s async setup block and (for tests) inside the
 * paint test file that boots `createTestRenderer`. This avoids
 * triggering OpenTUI's racy native-binary loader when an unrelated
 * test file (e.g. `test/git.test.ts` exercising `renderRowBlocks`)
 * just imports `cli/git.ts`'s pure-function exports.
 */
export interface LiveShellPaintRuntime {
  readonly TextRenderable: typeof TextRenderable;
  readonly ScrollBoxRenderable: typeof ScrollBoxRenderable;
  readonly TextAttributes: { readonly DIM: number };
  // fn-646.4: the ANSI→StyledText shim's chunk-builder needs these to
  // convert board's embedded SGR escapes into OpenTUI styling at paint
  // time. The body of the scene is the ONLY caller — banner stays
  // plain text + `attributes: DIM` per the docstring above.
  readonly StyledText: new (
    chunks: ConstructorParameters<typeof StyledText>[0],
  ) => StyledText;
  readonly RGBA: { fromHex(hex: string): RGBA };
}

/**
 * Paint handle — the test surface mirrors what `createLiveShell`'s
 * dispose path uses. `repaint()` is what the core's `onRender`
 * callback invokes (test code can also call it directly to force a
 * paint after a state mutation). `destroy()` tears down the renderer
 * synchronously.
 */
export interface LiveShellPaint {
  readonly renderer: CliRenderer;
  readonly banner: TextRenderable;
  readonly body: TextRenderable;
  readonly scrollBox: ScrollBoxRenderable;
  repaint(): void;
  destroy(): void;
}

/**
 * Build the live-shell paint scene against an OpenTUI renderer:
 * column layout with a dim banner pinned at row 0 and a ScrollBox
 * body filling the rest of the viewport. Wires the renderer's
 * `keyInput` to feed the core's `feedStdin` via a `key.name`-to-raw-
 * string translation, and re-fits the ScrollBox height on resize.
 *
 * Production: called from `createLiveShell`'s async renderer setup
 * over a `createCliRenderer({...})` result.
 *
 * Tests: called against a `createTestRenderer({...})` result so
 * `captureCharFrame()` / `mockInput.press()` exercise the paint
 * surface without spawning a real terminal.
 */
export function attachLiveShellPaint(
  renderer: CliRenderer,
  core: LiveShellCore,
  runtime: LiveShellPaintRuntime,
  opts: LiveShellPaintOptions = {},
): LiveShellPaint {
  let destroyed = false;
  const signalTarget = opts.signalTarget ?? (process as SuspendSignalTarget);
  // The armed SIGCONT listener while suspended — `null` when running.
  // Tracked so `destroy()` can detach it if teardown races a suspend.
  let pendingCont: (() => void) | null = null;
  // Track the last applied banner / body content so a no-op render
  // (identical content) is a true no-op on the TextRenderable side
  // (avoids reflow + re-shape work for the same string).
  let lastBannerText: string | null = null;
  let lastBodyText: string | null = null;
  let lastBodyLineCount = -1;
  // Last viewport width the body was padded against — a resize that changes
  // the width re-runs `linesToContent` even when the rows are byte-stable,
  // so the full-row selection highlight re-extends to the new right edge.
  let lastBodyWidth = -1;

  const bannerNode = new runtime.TextRenderable(renderer, {
    id: "live-shell-banner",
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: 1,
    attributes: runtime.TextAttributes.DIM,
    content: core.bannerText(),
  });
  const sb = new runtime.ScrollBoxRenderable(renderer, {
    id: "live-shell-scroll",
    position: "absolute",
    top: 1,
    left: 0,
    width: "100%",
    height: Math.max(0, renderer.height - 1),
    viewportCulling: true,
  });
  // No scrollbar in any keeper TUI. The bar's `visible` SETTER pins
  // `_manualVisibility = true`, permanently disabling auto show-on-overflow
  // for the renderer's lifetime (survives resize). This is the ONLY sticky
  // path: `scrollbarOptions: { visible: false }` at construction does NOT
  // stick (the base Renderable ctor writes `_visible` directly, bypassing the
  // setter, so the bar reappears on overflow), and the post-construction
  // `scrollbarOptions` setter has the same bypass. Hiding the vertical bar
  // reclaims its column, so `sb.viewport.width` can grow by 1 on overflow.
  sb.verticalScrollBar.visible = false;
  sb.horizontalScrollBar.visible = false;
  // fn-646.4: derive the shim runtime bag once — pulled out of the
  // `LiveShellPaintRuntime` (which carries the rest of the scene's
  // ctors) so the body assignment in `repaint()` reads symmetrically
  // for the pass-through and the StyledText paths.
  const shimRuntime: AnsiToStyledRuntime = {
    StyledText: runtime.StyledText,
    RGBA: runtime.RGBA,
    TextAttributes: runtime.TextAttributes,
  };
  const bodyNode = new runtime.TextRenderable(renderer, {
    id: "live-shell-body",
    content: linesToContent(core.visibleRows(), shimRuntime, sb.viewport.width),
  });
  sb.add(bodyNode);
  renderer.root.add(bannerNode);
  renderer.root.add(sb);

  lastBannerText = core.bannerText();
  lastBodyText = core.visibleRows().join("\n");
  lastBodyLineCount = core.visibleRows().length;
  lastBodyWidth = sb.viewport.width;

  /**
   * Translate an OpenTUI `KeyEvent` back to the raw-string contract
   * the core's keymap dispatch expects: a single character for
   * printable keys, a full CSI/SS3 sequence for nav keys, `\x03` for
   * Ctrl-C, `\x1b` for bare Escape. The core dispatches `q` / `c` /
   * etc. against the same raw strings the original bespoke parser
   * produced, so callers' bindings keep working byte-identically.
   *
   * Ctrl-Z is intercepted here (NOT forwarded to the core) — it drives
   * the job-control suspend dance via `suspendToBackground()`.
   */
  function handleKeypress(key: KeyEvent): void {
    if (destroyed) {
      return;
    }
    if (key.ctrl && key.name === "z") {
      suspendToBackground();
      return;
    }
    if (key.ctrl && key.name === "c") {
      core.feedStdin("\x03");
      return;
    }
    if (key.name === "escape") {
      core.feedStdin("\x1b");
      return;
    }
    switch (key.name) {
      case "up":
        core.feedStdin("\x1b[A");
        return;
      case "down":
        core.feedStdin("\x1b[B");
        return;
      case "right":
        core.feedStdin("\x1b[C");
        return;
      case "left":
        core.feedStdin("\x1b[D");
        return;
      case "end":
        core.feedStdin("\x1b[F");
        return;
    }
    if (key.sequence.length > 0) {
      core.feedStdin(key.sequence);
      return;
    }
    opts.onUnhandledKey?.(key.name);
  }

  renderer.keyInput.on("keypress", handleKeypress);

  const onResize = (): void => {
    if (destroyed) {
      return;
    }
    sb.height = Math.max(0, renderer.height - 1);
    repaint();
  };
  renderer.on("resize", onResize);

  /**
   * Ctrl-Z job-control suspend. OpenTUI does NOT wire SIGTSTP/SIGCONT,
   * and raw mode disables the kernel's own ISIG handling — so a naive
   * Ctrl-Z would just feed `\x1a` to a keymap that ignores it, leaving
   * the human stuck in the alt-screen with no way to drop to the shell.
   *
   * The dance, in order:
   *   1. `renderer.suspend()` restores the terminal (cooked mode, leave
   *      alt-screen, show cursor, detach stdin) — so the shell we're
   *      about to return to sees a sane TTY.
   *   2. Arm a one-shot SIGCONT listener BEFORE stopping, so the
   *      foreground (`fg`) resume is guaranteed caught.
   *   3. Re-raise SIGTSTP at ourselves to actually stop the process
   *      group (we suppressed the kernel default by being in raw mode).
   *
   * On SIGCONT we `renderer.resume()` (re-enter alt-screen + raw mode)
   * and force a repaint. Re-entrant Ctrl-Z while already suspended is a
   * no-op (`pendingCont` guards it; stdin is paused anyway).
   */
  function suspendToBackground(): void {
    if (destroyed || pendingCont != null) {
      return;
    }
    const onCont = (): void => {
      pendingCont = null;
      if (destroyed) {
        return;
      }
      try {
        renderer.resume();
      } catch {
        // best-effort — a resume throw must not wedge the key loop.
      }
      repaint();
    };
    pendingCont = onCont;
    signalTarget.once("SIGCONT", onCont);
    try {
      renderer.suspend();
    } catch {
      // best-effort — still re-raise SIGTSTP so the human escapes.
    }
    try {
      signalTarget.kill(signalTarget.pid, "SIGTSTP");
    } catch {
      // best-effort
    }
  }

  function repaint(): void {
    if (destroyed) {
      return;
    }
    const bannerNext = core.bannerText();
    if (bannerNext !== lastBannerText) {
      bannerNode.content = bannerNext;
      lastBannerText = bannerNext;
    }
    const rows = core.visibleRows();
    // Cache key is still the plain `\n`-joined text — it's a faithful
    // change-detector regardless of whether the actual `bodyNode.content`
    // gets a string (no-ANSI fast path) or a StyledText (board's ANSI-
    // bearing lines). Avoids re-running the parser when rows are
    // byte-identical to the last paint.
    const joined = rows.join("\n");
    // Re-pad on every paint (not just content changes) so the selection
    // highlight tracks the live viewport width across a resize: a width
    // change with byte-identical rows still needs the trailing bg-pad
    // recomputed. Cheap — `linesToContent` short-circuits plain (no-ANSI)
    // bodies to a single string with no per-line work.
    const bodyWidth = sb.viewport.width;
    if (
      joined !== lastBodyText ||
      rows.length !== lastBodyLineCount ||
      bodyWidth !== lastBodyWidth
    ) {
      bodyNode.content = linesToContent(rows, shimRuntime, bodyWidth);
      lastBodyText = joined;
      lastBodyLineCount = rows.length;
      lastBodyWidth = bodyWidth;
    }
    // Snap the scroll position to the top ONLY on a user-initiated frame
    // switch (the core sets the flag in its navigation actions) — so a
    // tall historical frame opens at its head. A plain content update
    // (live `pushFrame`, `refreshLive`, banner `setStatus`) leaves the
    // scroll where the human left it, so reading a long board isn't
    // yanked back to row 0 on every daemon tick. `takeScrollReset` is
    // read-and-clear, so each navigation triggers exactly one snap.
    if (core.takeScrollReset()) {
      sb.scrollTo(0);
    }
    renderer.requestRender();
  }

  // First paint — the core may already have history queued from
  // pushFrames that landed during the async renderer setup.
  repaint();

  return {
    renderer,
    banner: bannerNode,
    body: bodyNode,
    scrollBox: sb,
    repaint,
    destroy(): void {
      if (destroyed) {
        return;
      }
      destroyed = true;
      // Detach a SIGCONT listener still armed from an unresumed suspend
      // (teardown racing a backgrounded process) so it can't leak onto
      // the real `process` across test files.
      if (pendingCont != null) {
        try {
          signalTarget.removeListener("SIGCONT", pendingCont);
        } catch {
          // best-effort
        }
        pendingCont = null;
      }
      try {
        renderer.keyInput.off("keypress", handleKeypress);
      } catch {
        // best-effort
      }
      try {
        renderer.off("resize", onResize);
      } catch {
        // best-effort
      }
      try {
        renderer.destroy();
      } catch {
        // renderer was mid-setup or already torn down — best-effort.
      }
    },
  };
}

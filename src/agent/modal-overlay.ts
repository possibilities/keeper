/**
 * OpenTUI modal-overlay shell for the `--agentwrap-modal` host (fn-935.2).
 *
 * The PTY host (`modal-host.ts`, .1) runs claude as a raw passthrough and fires
 * `onHotkey()` when the reserved chord is seen. This module owns what happens
 * next: an OpenTUI renderer built ONCE at host start and kept SUSPENDED as the
 * resting state (so the modal-closed period is byte-identical to a normal
 * launch), then resumed on the hotkey to float a dim scrim + a placeholder test
 * modal. Esc or a click on the scrim dismisses, restoring input to the agent.
 *
 * STDIN IS A STRICT SINGLE-OWNER MUTEX. The host's passthrough `data` listener
 * and OpenTUI's own stdin reader must NEVER both read stdin (a split multi-byte
 * escape = phantom keys). The handoff is atomic:
 *   open  → detach host listener BEFORE renderer.resume()
 *   close → re-add host listener AFTER renderer.suspend()
 * The host supplies the detach/attach pair via {@link OverlayDeps.stdinHandoff}.
 *
 * TERMINAL SAFETY. Each rendered frame is bracketed in `?2026` BSU/ESU (tight,
 * per-frame — a pending BSU on crash freezes the terminal), SKIPPED under tmux
 * ($TMUX on the parent). We do NOT re-enter `?1049h` (the renderer is already on
 * the alt-screen). On dismiss we force a SIGWINCH redraw of the agent via the
 * host's PTY resize. On child-exit-while-open the host calls {@link
 * OverlayHandle.destroy} which runs `renderer.destroy()` (restores the terminal)
 * BEFORE the child's disposition is propagated.
 *
 * v0 BACKDROP is the dim scrim ONLY — no faithful agent render behind it. The
 * libghostty-vt grid backdrop is an explicit follow-on, out of scope here.
 */

/** The kitty-keyboard push/pop pair — claim disambiguated keys while the modal
 * is up, release on dismiss so the child's own protocol level is untouched. */
const KITTY_KEYBOARD_PUSH = "\x1b[>1u";
const KITTY_KEYBOARD_POP = "\x1b[<u";

/** Synchronized-output (`?2026`) begin/end — tight per-frame bracketing. */
const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

/** Disable the child's focus reporting (`?1004l`) while the modal owns input. */
const FOCUS_REPORTING_OFF = "\x1b[?1004l";
/** Re-enable focus reporting (`?1004h`) on close — symmetric to the open-side
 * disable, so the child's focus events survive the modal cycle. The host owns
 * the SAME mode the child enabled at startup; the modal-close redraw alone is
 * not guaranteed to make the child re-assert it. */
const FOCUS_REPORTING_ON = "\x1b[?1004h";

/** Scrim dim: black at half alpha, alpha-blended over whatever sits behind. */
const SCRIM_ALPHA = 0.55;

/** Placeholder modal copy — this is the MECHANICS proof, not the final UI. */
const MODAL_TITLE = " agentwrap modal ";
const MODAL_BODY = "Test modal. Press Esc to dismiss.";

/** Minimal RGBA surface (the subset we construct). Mirrors `@opentui/core`'s. */
export interface RGBAType {
  readonly __rgba: unique symbol;
}
/** The renderable base — only the layering/mount surface we touch. */
export interface RenderableLike {
  zIndex: number;
  onMouseDown?: (event: unknown) => void;
  add(obj: unknown, index?: number): number;
  destroyRecursively(): void;
}
export interface FrameBufferLike extends RenderableLike {
  readonly frameBuffer: {
    setCellWithAlphaBlending(
      x: number,
      y: number,
      char: string,
      fg: RGBAType,
      bg: RGBAType,
      attributes?: number,
    ): void;
    clear(bg?: RGBAType): void;
  };
}
export interface BoxLike extends RenderableLike {
  title?: string;
}
export interface TextLike extends RenderableLike {
  content: string;
}

/** A keypress event — the subset of OpenTUI's `KeyEvent` we read. */
export interface OverlayKeyEvent {
  readonly name: string;
}

/**
 * The renderer surface the overlay drives — the testable seam. A
 * `createTestRenderer` instance (or a production `createCliRenderer`) satisfies
 * it structurally.
 */
export interface OverlayRenderer {
  readonly root: {
    add(obj: unknown, index?: number): number;
    remove(id: string): void;
  };
  readonly keyInput: {
    on(event: "keypress", listener: (key: OverlayKeyEvent) => void): void;
    off(event: "keypress", listener: (key: OverlayKeyEvent) => void): void;
  };
  on(event: "resize", listener: (w: number, h: number) => void): void;
  off(event: "resize", listener: (w: number, h: number) => void): void;
  readonly terminalWidth: number;
  readonly terminalHeight: number;
  requestRender(): void;
  suspend(): void;
  resume(): void;
  destroy(): void;
}

/** The OpenTUI runtime ctors the overlay instantiates (injected for tests). */
export interface OverlayRuntime {
  RGBA: { fromValues(r: number, g: number, b: number, a?: number): RGBAType };
  FrameBufferRenderable: new (
    ctx: unknown,
    opts: {
      id?: string;
      position?: "absolute" | "relative";
      width: number;
      height: number;
      top?: number;
      left?: number;
      respectAlpha?: boolean;
      zIndex?: number;
    },
  ) => FrameBufferLike;
  BoxRenderable: new (
    ctx: unknown,
    opts: {
      id?: string;
      position?: "absolute" | "relative";
      width?: number;
      height?: number;
      top?: number;
      left?: number;
      zIndex?: number;
      border?: boolean;
      title?: string;
      backgroundColor?: string | RGBAType;
    },
  ) => BoxLike;
  TextRenderable: new (
    ctx: unknown,
    opts: {
      id?: string;
      content: string;
      top?: number;
      left?: number;
      zIndex?: number;
    },
  ) => TextLike;
}

/** A built renderer + its runtime ctors — the dash's `DashRendererBundle` shape. */
export interface OverlayBundle {
  renderer: OverlayRenderer;
  runtime: OverlayRuntime;
}

/** The host-supplied seam the overlay uses to honor the stdin mutex + redraw. */
export interface OverlayHostSeam {
  /**
   * Remove keeper's passthrough stdin listener and re-add it. `detach` MUST run
   * BEFORE `renderer.resume()`, `attach` AFTER `renderer.suspend()`.
   */
  stdinHandoff: { detach(): void; attach(): void };
  /** Force a SIGWINCH redraw of the agent (a no-op size change is fine). */
  requestAgentRedraw(): void;
  /** Raw write to the parent terminal (sync brackets, kitty push/pop, ?1004l). */
  termWrite(data: string): void;
  /** True under tmux on the parent — skip `?2026` bracketing. */
  underTmux: boolean;
}

/** Deps for {@link attachModalOverlay} — the bundle plus the host seam. */
export interface OverlayDeps extends OverlayHostSeam {
  bundle: OverlayBundle;
}

/**
 * The handle the host drives. `open`/`close` toggle the modal; `destroy` tears
 * the renderer down (terminal restore) and is idempotent; `isOpen` lets the host
 * decide whether a child-exit needs an auto-dismiss first.
 */
export interface OverlayHandle {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
  /** Tear down the renderer (restores the terminal). Idempotent. */
  destroy(): void;
}

/**
 * Wire the modal overlay onto a pre-built (and SUSPENDED) renderer. The renderer
 * is created once at host start and kept suspended; this attaches the keypress /
 * scrim-click handlers and returns the open/close/destroy handle. Pure of any
 * real PTY/TTY — a `createTestRenderer` renderer drives the whole loop headless.
 */
export function attachModalOverlay(deps: OverlayDeps): OverlayHandle {
  const { bundle, stdinHandoff, requestAgentRedraw, termWrite, underTmux } =
    deps;
  const { renderer, runtime } = bundle;

  let open = false;
  let destroyed = false;
  let scrim: FrameBufferLike | null = null;
  let modal: BoxLike | null = null;
  let modalText: TextLike | null = null;

  // Tight per-frame `?2026` bracketing (skip under tmux). Any draw that mutates
  // the visible surface runs inside one begin/end so a partial frame never
  // flickers; a crash mid-draw leaves at most one frame's sync window pending.
  const drawFrame = (fn: () => void): void => {
    if (!underTmux) {
      termWrite(SYNC_BEGIN);
    }
    try {
      fn();
      renderer.requestRender();
    } finally {
      if (!underTmux) {
        termWrite(SYNC_END);
      }
    }
  };

  // Paint the dim scrim across the full terminal: black at SCRIM_ALPHA, blended
  // over whatever sits behind (v0 = nothing — the alt-screen clear). Sized to the
  // live terminal so a resize-while-open re-lays it out.
  const paintScrim = (fb: FrameBufferLike, w: number, h: number): void => {
    const fg = runtime.RGBA.fromValues(0, 0, 0, 0);
    const bg = runtime.RGBA.fromValues(0, 0, 0, SCRIM_ALPHA);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        fb.frameBuffer.setCellWithAlphaBlending(x, y, " ", fg, bg);
      }
    }
  };

  // Build the scrim (bottom z) + the modal box (top z via add-order + zIndex).
  // The scrim is a visual dim-backdrop only; dismissal is Esc. Mouse is disabled
  // (see `useMouse: false` in the renderer build) to keep the passthrough terminal
  // clean, so there is no click-to-dismiss.
  const buildLayers = (w: number, h: number): void => {
    // Absolute positioning so the scrim and the modal OVERLAP (z-ordered) rather
    // than stacking in the flex flow — a full-screen flex child would otherwise
    // push the modal out of view.
    scrim = new runtime.FrameBufferRenderable(renderer, {
      id: "agentwrap-modal-scrim",
      position: "absolute",
      left: 0,
      top: 0,
      width: w,
      height: h,
      respectAlpha: true,
      zIndex: 0,
    });
    paintScrim(scrim, w, h);

    const modalW = Math.min(Math.max(w - 8, 20), 60);
    const modalH = 5;
    const left = Math.max(0, Math.floor((w - modalW) / 2));
    const top = Math.max(0, Math.floor((h - modalH) / 2));
    modal = new runtime.BoxRenderable(renderer, {
      id: "agentwrap-modal-box",
      position: "absolute",
      width: modalW,
      height: modalH,
      left,
      top,
      zIndex: 10,
      border: true,
      title: MODAL_TITLE,
    });
    modalText = new runtime.TextRenderable(renderer, {
      id: "agentwrap-modal-text",
      content: MODAL_BODY,
      top: 1,
      left: 2,
      zIndex: 11,
    });

    // Add-order = paint-order; scrim first (behind), modal on top.
    renderer.root.add(scrim);
    renderer.root.add(modal);
    modal.add(modalText);
  };

  const teardownLayers = (): void => {
    try {
      if (scrim) {
        renderer.root.remove("agentwrap-modal-scrim");
        scrim.destroyRecursively();
      }
      if (modal) {
        renderer.root.remove("agentwrap-modal-box");
        modal.destroyRecursively();
      }
    } catch {
      // best-effort — a teardown throw must never block the suspend/restore tail.
    }
    scrim = null;
    modal = null;
    modalText = null;
  };

  // Re-layout on a real-terminal resize while the modal is open.
  const onResize = (): void => {
    if (!open || destroyed) {
      return;
    }
    const w = renderer.terminalWidth;
    const h = renderer.terminalHeight;
    drawFrame(() => {
      teardownLayers();
      buildLayers(w, h);
    });
  };

  // Esc dismisses; every other key is absorbed (input is mutexed to the modal —
  // no key leaks to the child while it is open). The placeholder modal has no
  // other interactions in v0.
  const onKeypress = (key: OverlayKeyEvent): void => {
    if (!open || destroyed) {
      return;
    }
    if (key.name === "escape") {
      close();
    }
  };

  renderer.keyInput.on("keypress", onKeypress);
  renderer.on("resize", onResize);

  function open_(): void {
    if (open || destroyed) {
      return;
    }
    open = true;
    // ATOMIC STDIN HANDOFF: drop keeper's passthrough listener BEFORE resume so
    // only OpenTUI reads stdin while the modal is up.
    stdinHandoff.detach();
    // Claim disambiguated keys + silence the child's focus reporting for the
    // modal's lifetime. We do NOT re-enter ?1049h — the renderer owns the
    // alt-screen already.
    termWrite(KITTY_KEYBOARD_PUSH);
    termWrite(FOCUS_REPORTING_OFF);
    renderer.resume();
    const w = renderer.terminalWidth;
    const h = renderer.terminalHeight;
    drawFrame(() => {
      buildLayers(w, h);
    });
  }

  function close(): void {
    if (!open || destroyed) {
      return;
    }
    open = false;
    drawFrame(() => {
      teardownLayers();
    });
    // Release the kitty-keyboard level we pushed at open, and re-enable the
    // child's focus reporting we silenced — symmetric to open, so the child's
    // focus events survive the open→close cycle (no mid-session desync).
    termWrite(KITTY_KEYBOARD_POP);
    termWrite(FOCUS_REPORTING_ON);
    renderer.suspend();
    // ATOMIC STDIN HANDOFF: re-add keeper's listener AFTER suspend so OpenTUI has
    // already released stdin.
    stdinHandoff.attach();
    // Force a SIGWINCH redraw so the agent repaints its screen (we only drew the
    // scrim over it; v0 has no faithful backdrop to restore from).
    requestAgentRedraw();
  }

  function destroy(): void {
    if (destroyed) {
      return;
    }
    destroyed = true;
    renderer.keyInput.off("keypress", onKeypress);
    renderer.off("resize", onResize);
    // If the modal is open on teardown (child exited while up), pop the kitty
    // level + re-add keeper's listener so the handoff stays balanced, THEN
    // destroy the renderer (which restores the terminal).
    const wasOpen = open;
    open = false;
    teardownLayers();
    if (wasOpen) {
      termWrite(KITTY_KEYBOARD_POP);
      stdinHandoff.attach();
    }
    try {
      renderer.destroy();
    } catch {
      // best-effort — destroy must never throw past the host's exit tail.
    }
  }

  return {
    open: open_,
    close,
    get isOpen(): boolean {
      return open;
    },
    destroy,
  };
}

/**
 * Production renderer builder: a SUSPENDED OpenTUI renderer, lifted from the
 * dash's `defaultBuildRenderer`. `exitOnCtrlC:false` + `exitSignals:[]` keep
 * OpenTUI from owning any exit route (the host owns disposition); `autoFocus:
 * false` + alternate-screen mirror the dash. The renderer is suspended by the
 * caller immediately after build so the modal-closed period is byte-identical.
 */
export async function defaultBuildOverlayBundle(): Promise<OverlayBundle> {
  const otui = await import("@opentui/core");
  const renderer = (await otui.createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
    autoFocus: false,
    screenMode: "alternate-screen",
    // Zero mouse footprint. With mouse tracking on, OpenTUI briefly enables it
    // at startup (?1000h..?1003h) before suspend disables it; under a mouse-on
    // multiplexer that brief enable flips the pane into mouse-forwarding, so the
    // user's scroll/motion is then routed to the passthrough child — which is not
    // in mouse mode — and spills into it as literal escape-sequence text. The
    // modal dismisses on Esc, so it needs no mouse at all.
    useMouse: false,
  })) as unknown as OverlayRenderer;
  return {
    renderer,
    runtime: {
      RGBA: otui.RGBA as unknown as OverlayRuntime["RGBA"],
      FrameBufferRenderable:
        otui.FrameBufferRenderable as unknown as OverlayRuntime["FrameBufferRenderable"],
      BoxRenderable:
        otui.BoxRenderable as unknown as OverlayRuntime["BoxRenderable"],
      TextRenderable:
        otui.TextRenderable as unknown as OverlayRuntime["TextRenderable"],
    },
  };
}

/**
 * `keeper dash` materializer — the thin OpenTUI layer over the pure view-model
 * (`./view-model.ts`). Two surfaces:
 *
 * - {@link attachDashApp} — the PAINT layer. Builds the stable renderable tree
 *   ONCE (root Box column 100%/100%; census header Text fixed height over a
 *   full-width rule; body ScrollBox flexGrow:1 + viewportCulling, focused on
 *   mount so j/k/arrows scroll natively), and exposes `render(model)` which
 *   flattens the card model's bands into keyed rows (a band-title rule per
 *   non-empty band, then one card line each) and diffs them into a stable
 *   `Map<rowKey, RowHandle>` — content updates in place, structural
 *   add/remove/reorder ONLY when the keyed ORDER changes (Yoga recalc rides
 *   structure, not content). NOTE: this is the THIN bridge task `.1` ships;
 *   task `.2` replaces it with real boxed cards (rail-colored left border, robot
 *   glyph slot, heavy-cyan focus border, the `t`/`j`/`k` keybinds). The runtime
 *   OpenTUI ctors are THREADED IN so this module carries a type-only
 *   `@opentui/core` import — the same inertness contract `src/live-shell.ts`'s
 *   `attachLiveShellPaint` keeps, so an unrelated test importing the pure
 *   view-model never trips OpenTUI's racy native loader. Exported so
 *   `test/dash-app.test.ts` mounts the same scene against `createTestRenderer`
 *   without forking the renderer-construction code.
 *
 * - {@link createDashApp} — the PROCESS shell. Dynamic-imports OpenTUI, builds
 *   the renderer with the proven viewer config (exitOnCtrlC:false, exitSignals
 *   SIGTERM/SIGHUP/SIGQUIT, alternate-screen), attaches the paint layer, wires
 *   the subscriptions (subscribeReadiness for the live jobs projection, plus the
 *   autopilot_state + armed_epics collection subs whose edges still trigger
 *   repaints) into one current-inputs struct, the 30s staleness repaint
 *   interval, the q/Ctrl-C key handler, the forked exit triggers, an onFatal
 *   override, and uncaughtException/unhandledRejection handlers — every path
 *   routes through ONE idempotent `exitCleanly` so `renderer.destroy()` ALWAYS
 *   precedes `process.exit` (OpenTUI does NOT auto-restore the terminal on
 *   exit/uncaught). Reactive mode — never `renderer.start()`.
 *
 * Read-only end to end: no RPC frame is ever written, no DB is opened.
 */

import type {
  BoxRenderable as BoxRenderableType,
  CliRenderer,
  RGBA as RGBAType,
  ScrollBoxRenderable as ScrollBoxRenderableType,
  StyledText as StyledTextType,
  TextRenderable as TextRenderableType,
} from "@opentui/core";
import {
  type ConnectFactory,
  type ReadinessClientSnapshot,
  subscribeCollection,
  subscribeReadiness,
} from "../readiness-client";
import { armViewerExitTriggers } from "./exit-triggers";
import {
  type ColorDescriptor,
  colorForRail,
  STRUCTURE_COLOR_INDEX,
} from "./theme";
import { buildDashModel, type CardVM, type DashModel } from "./view-model";

/**
 * A thin flattened paint row — task `.1` ships the pure `{ header, bands }` card
 * MODEL; this is the minimal bridge that paints it through the existing
 * keyed-row diff. Task `.2` replaces this with real boxed cards (rail color,
 * robot glyph slot, heavy-cyan focus border, the `t`/`j`/`k` keybinds). A
 * `band` row is the urgency-band title rule; a `card` row is one job line.
 */
type PaintRow =
  | { readonly kind: "band"; readonly key: string; readonly title: string }
  | {
      readonly kind: "card";
      readonly key: string;
      readonly card: CardVM;
    };

// One coarse repaint interval for the wall-clock-aged card fields (age label)
// — 30s (epic-settled). These age off `nowSec`, not data edges.
const STALE_REFRESH_MS = 30_000;

/**
 * Runtime exports from `@opentui/core` that {@link attachDashApp} needs to
 * construct the scene. Threaded through as a parameter so this module carries
 * only a TYPE-only `@opentui/core` import — the runtime values load lazily
 * inside {@link createDashApp}'s async setup (and, for tests, inside the frame
 * test that boots `createTestRenderer`). Mirrors `LiveShellPaintRuntime`.
 */
export interface DashAppRuntime {
  readonly TextRenderable: typeof TextRenderableType;
  readonly ScrollBoxRenderable: typeof ScrollBoxRenderableType;
  readonly BoxRenderable: typeof BoxRenderableType;
  readonly StyledText: typeof StyledTextType;
  readonly RGBA: { fromIndex(index: number): RGBAType };
  readonly TextAttributes: { readonly DIM: number; readonly BOLD: number };
}

/** Options for {@link attachDashApp}. `onQuit` is the caller's teardown tail,
 * invoked on a `q` / Ctrl-C keypress (and idempotent). */
export interface DashAppOptions {
  readonly onQuit?: () => void;
}

/** The paint handle. `render(model)` diffs a fresh view-model into the stable
 * tree; `destroy()` tears the renderer down. Exposed pieces let the frame test
 * read content without re-deriving the tree. */
export interface DashApp {
  readonly renderer: CliRenderer;
  readonly header: TextRenderableType;
  readonly body: ScrollBoxRenderableType;
  render(model: DashModel): void;
  destroy(): void;
}

/** One TextChunk in the OpenTUI wire shape (`text-buffer.ts` `TextChunk`). The
 * `fg` is resolved from the role's ANSI index — ABSENT when the role carries
 * no index (default terminal foreground); `dim` / `bold` descriptors layer the
 * matching text attributes. */
interface BuiltChunk {
  __isChunk: true;
  text: string;
  fg?: RGBAType;
  attributes?: number;
}

/** One mounted body row: the outer node plus, for card rows, the two Text
 * children whose content updates in place. A key never changes kind, so the
 * handle's shape is fixed for its lifetime. */
interface RowHandle {
  readonly kind: PaintRow["kind"];
  readonly node: BoxRenderableType;
  readonly left?: TextRenderableType;
  readonly right?: TextRenderableType;
}

/**
 * Build the renderable scene + the row-diffing `render`. Column layout: a
 * fixed-height header Text pinned at the top, a full-width rule under it, and
 * a flexGrow:1 ScrollBox body filling the rest. The body holds the
 * view-model's keyed rows — split content lines (left text + right-aligned
 * dim metadata) and dividers — each a stable handle in `rowNodes` so a
 * re-render diffs content in place; structural add/remove/reorder fires only
 * when the keyed ORDER changes.
 *
 * Production: called from {@link createDashApp}'s async renderer setup.
 * Tests: called against a `createTestRenderer` result.
 */
export function attachDashApp(
  renderer: CliRenderer,
  runtime: DashAppRuntime,
  opts: DashAppOptions = {},
): DashApp {
  let destroyed = false;
  const { RGBA, TextAttributes } = runtime;
  const structureColor = RGBA.fromIndex(STRUCTURE_COLOR_INDEX);

  // Resolve a color descriptor to its renderable fg (absent index → default
  // foreground) plus the descriptor's DIM/BOLD attributes.
  function chunkFor(text: string, desc: ColorDescriptor): BuiltChunk {
    const chunk: BuiltChunk = { __isChunk: true, text };
    if (desc.index !== undefined) {
      chunk.fg = RGBA.fromIndex(desc.index);
    }
    const attributes =
      (desc.dim === true ? TextAttributes.DIM : 0) |
      (desc.bold === true ? TextAttributes.BOLD : 0);
    if (attributes !== 0) {
      chunk.attributes = attributes;
    }
    return chunk;
  }

  // A single default-fg text run → a StyledText (the header census + plain
  // labels). Task `.2` layers the rail color per card.
  function plainText(text: string): StyledTextType {
    return new runtime.StyledText([chunkFor(text, {})]);
  }

  // Root: a full-screen column. Header fixed at 1 row over a full-width rule;
  // body fills the rest.
  const root = new runtime.BoxRenderable(renderer, {
    id: "dash-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
  });
  const header = new runtime.TextRenderable(renderer, {
    id: "dash-header",
    width: "100%",
    height: 1,
    content: "",
  });
  const headerRule = new runtime.BoxRenderable(renderer, {
    id: "dash-header-rule",
    width: "100%",
    height: 1,
    border: ["top"],
    borderColor: structureColor,
  });
  const body = new runtime.ScrollBoxRenderable(renderer, {
    id: "dash-body",
    width: "100%",
    flexGrow: 1,
    viewportCulling: true,
  });
  // No scrollbar in any keeper TUI. The bar's `visible` SETTER pins
  // `_manualVisibility = true`, permanently disabling auto show-on-overflow
  // for the renderer's lifetime (survives resize). This is the ONLY sticky
  // path: `scrollbarOptions: { visible: false }` at construction does NOT
  // stick (the base Renderable ctor writes `_visible` directly, bypassing the
  // setter, so the bar reappears on overflow), and the post-construction
  // `scrollbarOptions` setter has the same bypass.
  body.verticalScrollBar.visible = false;
  body.horizontalScrollBar.visible = false;
  root.add(header);
  root.add(headerRule);
  root.add(body);
  renderer.root.add(root);
  // Focus the ScrollBox on mount — j/k/arrows are silently dead otherwise.
  body.focus();

  // Stable per-row handle map, keyed by the view-model's row keys. Content
  // diffs in place; membership/order changes restructure (see `render`).
  const rowNodes = new Map<string, RowHandle>();
  // The previous frame's ordered key list — reorder detection.
  let lastOrder = "";

  function buildHandle(row: PaintRow): RowHandle {
    switch (row.kind) {
      case "card": {
        const node = new runtime.BoxRenderable(renderer, {
          id: `dash-row-${row.key}`,
          width: "100%",
          height: 1,
          flexDirection: "row",
          justifyContent: "space-between",
          paddingLeft: 1,
          paddingRight: 1,
        });
        const left = new runtime.TextRenderable(renderer, {
          id: `dash-row-${row.key}-l`,
          height: 1,
          content: "",
        });
        const right = new runtime.TextRenderable(renderer, {
          id: `dash-row-${row.key}-r`,
          height: 1,
          content: "",
        });
        node.add(left);
        node.add(right);
        return { kind: "card", node, left, right };
      }
      case "band":
        return {
          kind: "band",
          node: new runtime.BoxRenderable(renderer, {
            id: `dash-row-${row.key}`,
            width: "100%",
            height: 1,
            border: ["top"],
            borderColor: structureColor,
          }),
        };
    }
  }

  // Flatten the band model into the thin paint-row stream: a band-title rule
  // per NON-EMPTY band (an empty band collapses), then its cards. Task `.2`
  // replaces this with per-band sections of real boxed cards.
  function flatten(model: DashModel): PaintRow[] {
    const rows: PaintRow[] = [];
    for (const b of model.bands) {
      if (b.cards.length === 0) {
        continue;
      }
      rows.push({ kind: "band", key: `band:${b.key}`, title: b.title });
      for (const card of b.cards) {
        rows.push({ kind: "card", key: card.key, card });
      }
    }
    return rows;
  }

  // A card line: the robot glyph (rail-colored) + a space slot, then the title.
  // The right side carries the dim project basename. Task `.2` moves the rail
  // color to a left border and adds the focus/heavy-border channel.
  function cardLeft(card: CardVM): StyledTextType {
    const rail = colorForRail(card.railRole);
    return new runtime.StyledText([
      chunkFor(`${card.robotGlyph} `, rail),
      chunkFor(card.title, {}),
    ]);
  }

  function render(model: DashModel): void {
    if (destroyed) {
      return;
    }
    // One column of left margin, matching the body rows' Box padding (Text
    // ignores padding options, so the margin is a literal space chunk).
    header.content = plainText(` ${model.header}`);

    const paintRows = flatten(model);

    // Ensure every wanted row exists with current content. New nodes mount
    // detached; the order pass below attaches them in position.
    const wantKeys: string[] = [];
    for (const row of paintRows) {
      wantKeys.push(row.key);
      let handle = rowNodes.get(row.key);
      if (handle === undefined) {
        handle = buildHandle(row);
        rowNodes.set(row.key, handle);
      }
      if (row.kind === "card" && handle.left && handle.right) {
        handle.left.content = cardLeft(row.card);
        handle.right.content = plainText(row.card.project);
      }
    }

    // Structural prune: drop any node whose key is no longer wanted.
    const want = new Set(wantKeys);
    for (const [key, handle] of rowNodes) {
      if (!want.has(key)) {
        body.remove(handle.node.id);
        handle.node.destroy();
        rowNodes.delete(key);
      }
    }

    // Order sync: when the ordered key list changed (membership OR position),
    // re-attach every wanted node in model order. Detach-then-append keeps
    // each node alive (only `destroy` frees it); content-only frames skip
    // this entirely so Yoga recalc rides structure, not content.
    const orderSig = wantKeys.join("\n");
    if (orderSig !== lastOrder) {
      for (const key of wantKeys) {
        const handle = rowNodes.get(key);
        if (handle !== undefined) {
          body.remove(handle.node.id);
        }
      }
      for (const key of wantKeys) {
        const handle = rowNodes.get(key);
        if (handle !== undefined) {
          body.add(handle.node);
        }
      }
      lastOrder = orderSig;
    }

    renderer.requestRender();
  }

  function destroy(): void {
    if (destroyed) {
      return;
    }
    destroyed = true;
    try {
      renderer.destroy();
    } catch {
      // best-effort — destroy must never throw past the caller's exit tail.
    }
  }

  // q / Ctrl-C → caller teardown. Other keys fall through to the focused
  // ScrollBox (j/k/arrows scroll natively).
  renderer.keyInput.on("keypress", (key) => {
    if (destroyed) {
      return;
    }
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      opts.onQuit?.();
    }
  });

  return {
    renderer,
    header,
    body,
    render,
    destroy,
  };
}

// ---------------------------------------------------------------------------
// Process shell
// ---------------------------------------------------------------------------

/** The mutable current-inputs struct the subscriptions feed; each edge rebuilds
 * the card model off the latest snapshot. `showTerminal` rides the ended/killed
 * visibility toggle (task `.2` wires the keybind that flips it). */
interface CurrentInputs {
  snapshot: ReadinessClientSnapshot | null;
  showTerminal: boolean;
}

/** The renderer + runtime ctors {@link createDashApp} threads into
 * {@link attachDashApp}. The default factory dynamic-imports `@opentui/core`
 * and builds the real alt-screen renderer; tests inject a `createTestRenderer`
 * result so the whole process shell can be driven headless. */
export interface DashRendererBundle {
  readonly renderer: CliRenderer;
  readonly runtime: DashAppRuntime;
}

/** Test-injection seams for {@link createDashApp}. Production passes none — the
 * defaults reproduce the real renderer / forked triggers / `process` exit +
 * stderr. Tests inject all of them so the teardown discipline (destroy before
 * exit, idempotency, handle disposal, fatal exit-1 routing) is assertable
 * without booting a real alt-screen renderer or calling the real
 * `process.exit`. */
export interface DashAppDeps {
  /** Builds the renderer + runtime ctors. Default: real OpenTUI alt-screen. */
  readonly buildRenderer?: () => Promise<DashRendererBundle>;
  /** Exit-trigger arming. Default: the real forked viewer triggers. */
  readonly armExitTriggers?: (exitCleanly: () => void) => {
    disarm: () => void;
  };
  /** Socket connect for the three subscriptions. Default: the real UDS connect. */
  readonly connect?: ConnectFactory;
  /** Process exit. Default: `process.exit`. Tests inject a thrower. */
  readonly exit?: (code: number) => void;
  /** Fatal-path stderr sink. Default: `process.stderr.write`. */
  readonly stderrWrite?: (s: string) => void;
  /** Registrar for the `uncaughtException` / `unhandledRejection` fatal nets.
   * Default: `process.on`. Tests inject a capturing registrar so the handlers
   * never land on the real `process` (which would fire on unrelated test
   * errors and leak listeners across files). */
  readonly onProcess?: (event: string, handler: (arg: unknown) => void) => void;
}

async function defaultBuildRenderer(): Promise<DashRendererBundle> {
  const otui = await import("@opentui/core");
  const renderer = await otui.createCliRenderer({
    // q / Ctrl-C are the canonical exit route (handled in the key handler);
    // keep OpenTUI's own Ctrl-C exit OFF so it can't bypass our destroy tail.
    exitOnCtrlC: false,
    exitSignals: ["SIGTERM", "SIGHUP", "SIGQUIT"],
    autoFocus: false,
    screenMode: "alternate-screen",
  });
  return {
    renderer,
    runtime: {
      TextRenderable: otui.TextRenderable,
      ScrollBoxRenderable: otui.ScrollBoxRenderable,
      BoxRenderable: otui.BoxRenderable,
      StyledText: otui.StyledText,
      RGBA: otui.RGBA,
      TextAttributes: otui.TextAttributes,
    },
  };
}

/**
 * The production process shell. Builds the renderer + paint layer, wires the
 * data layer + teardown discipline, and runs reactive mode. Returns a promise
 * that resolves once setup is done (the process then lives on the renderer's
 * reactive repaint + the subscriptions until an exit trigger fires). Read-only:
 * no RPC frame is written, no DB opened.
 *
 * Every dep in {@link DashAppDeps} is injectable so a test can drive the whole
 * shell headless (a `createTestRenderer` renderer, a stub trigger set, a fake
 * connect, and a non-exiting `exit`/`stderrWrite`) and assert the teardown
 * discipline without booting a real alt-screen renderer.
 */
export async function createDashApp(
  sockPath: string,
  deps: DashAppDeps = {},
): Promise<void> {
  const buildRenderer = deps.buildRenderer ?? defaultBuildRenderer;
  const armExitTriggers = deps.armExitTriggers ?? defaultArmExitTriggers;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const stderrWrite =
    deps.stderrWrite ?? ((s: string) => void process.stderr.write(s));
  const onProcess =
    deps.onProcess ??
    ((event: string, handler: (arg: unknown) => void) => {
      process.on(event as "uncaughtException", handler);
    });
  const connectOpt =
    deps.connect === undefined ? {} : { connect: deps.connect };

  const { renderer, runtime } = await buildRenderer();

  const inputs: CurrentInputs = {
    snapshot: null,
    showTerminal: false,
  };

  const app = attachDashApp(renderer, runtime, {
    onQuit: () => exitCleanly(),
  });

  function paint(): void {
    const snap = inputs.snapshot;
    app.render(
      buildDashModel(
        snap?.jobs ?? new Map(),
        snap?.subagentInvocations ?? [],
        inputs.showTerminal,
        Math.floor(Date.now() / 1000),
      ),
    );
  }

  // First paint — the empty census before any data lands.
  paint();

  // The readiness subscription feeds the card model off the live jobs
  // projection. The autopilot_state/armed_epics subs below are retained (their
  // edges trigger repaints) though the robot-card model no longer reads them.
  const readinessHandle = subscribeReadiness({
    sockPath,
    idPrefix: "dash",
    ...connectOpt,
    onSnapshot: (snap) => {
      inputs.snapshot = snap;
      paint();
    },
    onLifecycle: (event) => {
      // A snapshot is retained across a drop so the last-good board freezes
      // until the conn comes back.
      if (event === "disconnected" || event === "connecting") {
        paint();
      }
    },
    // Reconnect-forever (settled) — never give up, never tear the TUI down.
    // A fatal pre-paint error (malformed query — should never happen against
    // our own fixed queries) routes through the clean exit tail.
    onFatal: () => exitCleanly(),
  });

  const autopilotHandle = subscribeCollection({
    sockPath,
    idPrefix: "dash",
    collection: "autopilot_state",
    ...connectOpt,
    onRows: () => {
      paint();
    },
    onFatal: () => exitCleanly(),
  });

  const armedHandle = subscribeCollection({
    sockPath,
    idPrefix: "dash",
    collection: "armed_epics",
    ...connectOpt,
    onRows: () => {
      paint();
    },
    onFatal: () => exitCleanly(),
  });

  // One coarse interval refreshes the wall-clock-aged glyphs — the rolled-up
  // job verdict's sub-agent/monitor STALE transitions age off `nowSec`, not
  // data edges, so no subscription repaints them. unref'd so it never pins the
  // loop alive on its own.
  const staleTimer = setInterval(paint, STALE_REFRESH_MS);
  (staleTimer as { unref?: () => void }).unref?.();

  // Single idempotent teardown. destroy() ALWAYS precedes exit so the terminal
  // is restored (OpenTUI does not auto-restore on exit/uncaught). Disposes the
  // subs, clears the interval, disarms the triggers, destroys the renderer.
  let exited = false;
  function exitCleanly(): void {
    if (exited) {
      return;
    }
    exited = true;
    try {
      clearInterval(staleTimer);
    } catch {
      // best-effort
    }
    try {
      readinessHandle.dispose();
      autopilotHandle.dispose();
      armedHandle.dispose();
    } catch {
      // best-effort — a dispose throw must not block terminal restore.
    }
    try {
      triggers.disarm();
    } catch {
      // best-effort
    }
    app.destroy();
    exit(0);
  }

  // Forked viewer exit triggers (SIGHUP, stdin-EOF, ppid===1 poll).
  const triggers = armExitTriggers(exitCleanly);

  // Last-resort safety nets — OpenTUI hooks NEITHER, so an uncaught error would
  // strand the terminal in alt-screen/raw mode. Route both through the same
  // destroy-then-exit tail (then re-exit non-zero to preserve the failure).
  onProcess("uncaughtException", (err) => {
    onFatalError(err);
  });
  onProcess("unhandledRejection", (reason) => {
    onFatalError(reason);
  });

  function onFatalError(err: unknown): void {
    // Restore the terminal first, then surface the error on the now-cooked
    // stderr and exit non-zero. `exitCleanly` exits 0, so duplicate the
    // restore-then-exit here with the failure code.
    if (!exited) {
      exited = true;
      try {
        clearInterval(staleTimer);
      } catch {
        // best-effort
      }
      try {
        readinessHandle.dispose();
        autopilotHandle.dispose();
        armedHandle.dispose();
      } catch {
        // best-effort
      }
      try {
        triggers.disarm();
      } catch {
        // best-effort
      }
      app.destroy();
    }
    try {
      stderrWrite(`keeper dash: fatal — ${String(err)}\n`);
    } catch {
      // best-effort
    }
    exit(1);
  }
}

/** The default exit-trigger arming — the real forked triggers. Pulled out so
 * {@link createDashApp} can take an injected stub. */
function defaultArmExitTriggers(exitCleanly: () => void): {
  disarm: () => void;
} {
  return armViewerExitTriggers(exitCleanly);
}

/**
 * `keeper dash` materializer — the thin OpenTUI layer over the pure view-model
 * (`./view-model.ts`). Two surfaces:
 *
 * - {@link attachDashApp} — the PAINT layer. Builds the stable renderable tree
 *   ONCE (root Box column 100%/100%; header Text fixed height over a full-width
 *   rule; body ScrollBox flexGrow:1 + viewportCulling, focused on mount so
 *   j/k/arrows scroll natively), and exposes `render(model)` which diffs the
 *   view-model's keyed body rows into a stable `Map<rowKey, RowHandle>` — four
 *   row kinds (split / section / divider / spacer), content updates in place,
 *   structural add/remove/reorder ONLY when the keyed ORDER changes (Yoga
 *   recalc rides structure, not content). The runtime OpenTUI ctors are
 *   THREADED IN so this
 *   module carries a type-only `@opentui/core` import — the same inertness
 *   contract `src/live-shell.ts`'s `attachLiveShellPaint` keeps, so an unrelated
 *   test importing the pure view-model never trips OpenTUI's racy native loader.
 *   Exported so `test/dash-app.test.ts` mounts the same scene against
 *   `createTestRenderer` without forking the renderer-construction code.
 *
 * - {@link createDashApp} — the PROCESS shell. Dynamic-imports OpenTUI, builds
 *   the renderer with the proven viewer config (exitOnCtrlC:false, exitSignals
 *   SIGTERM/SIGHUP/SIGQUIT, alternate-screen), attaches the paint layer, wires
 *   the three subscriptions (subscribeReadiness + subscribeCollection
 *   autopilot_state + armed_epics) into one current-inputs struct, the 30s
 *   elapsed interval, the q/Ctrl-C key handler, the forked exit triggers, an
 *   onFatal override, and uncaughtException/unhandledRejection handlers — every
 *   path routes through ONE idempotent `exitCleanly` so `renderer.destroy()`
 *   ALWAYS precedes `process.exit` (OpenTUI does NOT auto-restore the terminal
 *   on exit/uncaught). Reactive mode — never `renderer.start()`.
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
import { colorForRole, STRUCTURE_COLOR_INDEX } from "./theme";
import {
  buildDashModel,
  type ConnectionState,
  type DashBodyRow,
  type DashModel,
  type Row,
} from "./view-model";

// One coarse repaint interval for the elapsed cells — 30s (epic-settled).
const ELAPSED_REFRESH_MS = 30_000;

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

/** One mounted body row: the outer node plus, for split rows, the two Text
 * children whose content updates in place. A key never changes kind, so the
 * handle's shape is fixed for its lifetime. */
interface RowHandle {
  readonly kind: DashBodyRow["kind"];
  readonly node: BoxRenderableType;
  readonly left?: TextRenderableType;
  readonly right?: TextRenderableType;
}

/**
 * Build the renderable scene + the row-diffing `render`. Column layout: a
 * fixed-height header Text pinned at the top, a full-width rule under it, and
 * a flexGrow:1 ScrollBox body filling the rest. The body holds the
 * view-model's keyed rows — split content lines (left text + right-aligned
 * dim metadata), titled section rules, dividers, spacers — each a stable
 * handle in `rowNodes` so a re-render diffs content in place; structural
 * add/remove/reorder fires only when the keyed ORDER changes.
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

  // Resolve a role to its renderable fg (absent index → default foreground)
  // plus the descriptor's DIM/BOLD attributes.
  function chunkFor(text: string, role: Row[number]["role"]): BuiltChunk {
    const desc = colorForRole(role);
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

  // A whole row (segment list) → a StyledText of per-segment chunks.
  function styledRow(segments: Row): StyledTextType {
    const chunks = segments.map((s) => chunkFor(s.text, s.role));
    return new runtime.StyledText(chunks);
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
    paddingLeft: 1,
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

  function buildHandle(row: DashBodyRow): RowHandle {
    switch (row.kind) {
      case "split": {
        const node = new runtime.BoxRenderable(renderer, {
          id: `dash-row-${row.key}`,
          width: "100%",
          height: 1,
          flexDirection: "row",
          justifyContent: "space-between",
          paddingLeft: 1 + (row.indent ?? 0),
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
        return { kind: "split", node, left, right };
      }
      case "section":
        return {
          kind: "section",
          node: new runtime.BoxRenderable(renderer, {
            id: `dash-row-${row.key}`,
            width: "100%",
            height: 1,
            border: ["top"],
            borderColor: structureColor,
            title: ` ${row.title} `,
            titleAlignment: "left",
          }),
        };
      case "divider":
        return {
          kind: "divider",
          node: new runtime.BoxRenderable(renderer, {
            id: `dash-row-${row.key}`,
            width: "100%",
            height: 1,
            border: ["top"],
            borderColor: structureColor,
          }),
        };
      case "spacer":
        return {
          kind: "spacer",
          node: new runtime.BoxRenderable(renderer, {
            id: `dash-row-${row.key}`,
            width: "100%",
            height: 1,
          }),
        };
    }
  }

  function render(model: DashModel): void {
    if (destroyed) {
      return;
    }
    header.content = styledRow(model.header);

    // Ensure every wanted row exists with current content. New nodes mount
    // detached; the order pass below attaches them in position.
    const wantKeys: string[] = [];
    for (const row of model.body) {
      wantKeys.push(row.key);
      let handle = rowNodes.get(row.key);
      if (handle === undefined) {
        handle = buildHandle(row);
        rowNodes.set(row.key, handle);
      }
      if (row.kind === "split" && handle.left && handle.right) {
        handle.left.content = styledRow(row.left);
        handle.right.content = styledRow(row.right);
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

/** The mutable current-inputs struct the three subscriptions feed; each edge
 * rebuilds the view-model off the latest of all three. */
interface CurrentInputs {
  snapshot: ReadinessClientSnapshot | null;
  autopilotRows: Record<string, unknown>[];
  armedRows: Record<string, unknown>[];
  connection: ConnectionState;
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
    autopilotRows: [],
    armedRows: [],
    connection: "connecting",
  };

  const app = attachDashApp(renderer, runtime, {
    onQuit: () => exitCleanly(),
  });

  function paint(): void {
    app.render(
      buildDashModel({
        snapshot: inputs.snapshot,
        autopilotRows: inputs.autopilotRows,
        armedRows: inputs.armedRows,
        connection: inputs.connection,
        nowSec: Math.floor(Date.now() / 1000),
      }),
    );
  }

  // First paint — the connecting/waiting line before any data lands.
  paint();

  // Three subscriptions feeding the one inputs struct. The readiness conn
  // internally subscribes autopilot_state/armed_epics but does NOT expose them
  // on the snapshot, so the header needs these two extra subs.
  const readinessHandle = subscribeReadiness({
    sockPath,
    idPrefix: "dash",
    ...connectOpt,
    onSnapshot: (snap) => {
      inputs.snapshot = snap;
      inputs.connection = "live";
      paint();
    },
    onLifecycle: (event) => {
      // Pre-paint shows `connecting…`; a post-paint drop shows
      // `reconnecting…` with the last-good body frozen (snapshot retained).
      if (event === "disconnected" || event === "connecting") {
        inputs.connection =
          inputs.snapshot === null ? "connecting" : "reconnecting";
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
    onRows: (rows) => {
      inputs.autopilotRows = rows;
      paint();
    },
    onFatal: () => exitCleanly(),
  });

  const armedHandle = subscribeCollection({
    sockPath,
    idPrefix: "dash",
    collection: "armed_epics",
    ...connectOpt,
    onRows: (rows) => {
      inputs.armedRows = rows;
      paint();
    },
    onFatal: () => exitCleanly(),
  });

  // One coarse interval refreshes the elapsed cells (no other repaint driver
  // touches them — they age off wall-clock, not data edges). unref'd so it
  // never pins the loop alive on its own.
  const elapsedTimer = setInterval(paint, ELAPSED_REFRESH_MS);
  (elapsedTimer as { unref?: () => void }).unref?.();

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
      clearInterval(elapsedTimer);
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
        clearInterval(elapsedTimer);
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

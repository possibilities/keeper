/**
 * `keeper dash` materializer — the OpenTUI paint layer over the pure view-model
 * (`./view-model.ts`). Two surfaces:
 *
 * - {@link attachDashApp} — the PAINT layer. Builds the stable renderable tree
 *   ONCE (root column = a single flexGrow:1 `ScrollBox` body) and exposes
 *   `render(model)`, which paints the model as a flat list of one-line jobs
 *   grouped under session rules. Each band contributes a dim full-width rule
 *   (titled inline with the tmux session name, structure-gray) followed by its
 *   job lines; an empty band collapses (no rule). Each job is a flex-ROW per
 *   `job:<id>` — a growing `<caret><icon>  <job name>` Text on the left and a
 *   right-justified, dimmer `<project>` Text on the right. The leading robot icon
 *   carries the status color (face + hue dual-encode status); when the row is
 *   narrow the job name CLIPS at the end (no ellipsis) before the project does.
 *   The SELECTION cursor (keyed on `job_id`, surviving a re-sort) marks the
 *   current line with a full-bleed background bar + a cyan caret + bold, and
 *   `scrollChildIntoView`s it; `j`/`k`/arrows move it and WRAP at the ends (and a
 *   click on a line selects it directly), selection starts EMPTY on load (j/↓
 *   seeds the first line, k/↑ the last) and ESC clears it. There is no border and
 *   no card. Nodes are MUTATED in place
 *   across frames (Text content); structural detach-then-append fires ONLY when
 *   the keyed line order changes, so Yoga recalc rides structure, not content.
 *   The runtime OpenTUI ctors are THREADED IN so this module carries
 *   only a type-only `@opentui/core` import — the same inertness contract
 *   `src/live-shell.ts`'s `attachLiveShellPaint` keeps, so an unrelated test
 *   importing the pure view-model never trips OpenTUI's racy native loader.
 *   Exported so `test/dash-app.test.ts` mounts the same scene against
 *   `createTestRenderer` without forking the renderer-construction code.
 *
 * - {@link createDashApp} — the PROCESS shell. Dynamic-imports OpenTUI, builds
 *   the renderer with the proven viewer config (exitOnCtrlC:false, exitSignals
 *   SIGTERM/SIGHUP/SIGQUIT, alternate-screen), attaches the paint layer, wires
 *   the live jobs subscription (`subscribeReadiness`, live-only default scope
 *   capped at a bounded first page so the snapshot stays under the NDJSON line
 *   cap; the `t` toggle is deferred/inert), the key handler, the forked exit
 *   triggers, an onFatal override, and uncaughtException/unhandledRejection
 *   handlers — every path routes through ONE idempotent `exitCleanly` so
 *   `renderer.destroy()` ALWAYS precedes `process.exit` (OpenTUI does NOT
 *   auto-restore the terminal on exit/uncaught). Reactive mode — never
 *   `renderer.start()`.
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
import type { BootStatus } from "../protocol";
import {
  type ConnectFactory,
  type ReadinessClientSnapshot,
  subscribeReadiness,
} from "../readiness-client";
import { armViewerExitTriggers } from "./exit-triggers";
import {
  type ColorDescriptor,
  colorForIcon,
  STRUCTURE_COLOR_INDEX,
} from "./theme";
import {
  buildDashModel,
  type CardVM,
  type DashLoadingState,
  type DashModel,
} from "./view-model";

// Bounded first page for the jobs subscription. The feed serializes the
// snapshot onto one NDJSON line, so an unbounded fetch over a large job history
// exceeds the 1 MiB `MAX_LINE_LENGTH` and closes the connection before the
// first snapshot. 50 (`created_at DESC`) keeps the newest live jobs, well under
// the line cap.
const DASH_JOBS_PAGE = 50;

// Selection chrome — no border, no outline. The selected line gets a cyan caret
// (bright cyan, index 14 — the dash accent, mirroring `theme.ts` ROLE_COLORS
// .accent and board-render's `96` SGR), bold text, and a subtle gray background
// wash (index 8, the structure gray) so it reads as the current line without
// any box.
const ACCENT_COLOR_INDEX = 14;
const SELECT_BG_INDEX = 8;
// The selection caret occupies the leading gutter on the current line; an
// unselected line pads the same two columns with spaces so nothing shifts.
const SELECT_CARET = "❯ ";
const NO_CARET = "  ";

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
 * invoked on a `q` / Ctrl-C keypress (and idempotent); `onToggleTerminal` is
 * invoked on the `t` keypress so the caller flips `showTerminal` and repaints.
 * Inert against today's live-only jobs feed (no ended/killed rows to reveal);
 * retained for a future bounded terminal page. */
export interface DashAppOptions {
  readonly onQuit?: () => void;
  readonly onToggleTerminal?: () => void;
}

/** The paint handle. `render(model)` diffs a fresh view-model into the stable
 * tree; `destroy()` tears the renderer down. The `body` ScrollBox is exposed so
 * the frame test can assert mount/focus state. */
export interface DashApp {
  readonly renderer: CliRenderer;
  readonly body: ScrollBoxRenderableType;
  render(model: DashModel): void;
  destroy(): void;
}

/** One TextChunk in the OpenTUI wire shape (`text-buffer.ts` `TextChunk`). The
 * `fg` is resolved from the role's ANSI index — ABSENT when the role carries
 * no index (default terminal foreground); `dim` / `bold` descriptors layer the
 * matching text attributes. (The selection highlight is a full-bleed row
 * background, not a per-chunk bg.) */
interface BuiltChunk {
  __isChunk: true;
  text: string;
  fg?: RGBAType;
  attributes?: number;
}

/** A flattened paint row: a `band` is the dim session-band rule (titled inline);
 * a `line` is one job's row. The view-model's per-frame order drives the
 * structural diff. */
type PaintRow =
  | { readonly kind: "band"; readonly key: string; readonly title: string }
  | { readonly kind: "line"; readonly key: string; readonly card: CardVM };

/** One mounted job line: a flex-row `node` holding a `left` Text (caret + icon +
 * job name — grows to fill and TRUNCATES first when the screen is narrow) and a
 * right-justified, dimmer `right` Text (project — never shrinks). `card` is the
 * last-painted model so a selection move repaints without a full re-render. */
interface LineHandle {
  kind: "line";
  readonly node: BoxRenderableType;
  readonly left: TextRenderableType;
  readonly right: TextRenderableType;
  card: CardVM;
}

/** One mounted band rule (no interior text — the title rides the box border). */
interface BandHandle {
  readonly kind: "band";
  readonly node: BoxRenderableType;
}

type RowHandle = LineHandle | BandHandle;

/**
 * Build the renderable scene + the row-diffing `render`. Column layout: a single
 * flexGrow:1 ScrollBox body filling the screen. The body holds the view-model's
 * bands as dim rule rows + one Text line per job, each a stable handle in
 * `rowNodes` so a re-render mutates content in place; structural
 * detach-then-append fires only when the keyed ORDER changes.
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
  const selectBg = RGBA.fromIndex(SELECT_BG_INDEX);

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

  // Root: a full-screen column holding just the scrolling list body.
  const root = new runtime.BoxRenderable(renderer, {
    id: "dash-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
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
  root.add(body);
  renderer.root.add(root);
  // Focus the ScrollBox on mount — j/k/arrows reach the key handler regardless,
  // but the ScrollBox owns native wheel/page scroll.
  body.focus();

  // Stable per-row handle map, keyed by the view-model's row keys. Content
  // mutates in place; membership/order changes restructure (see `render`).
  const rowNodes = new Map<string, RowHandle>();
  // The previous frame's ordered key list — reorder detection.
  let lastOrder = "";
  // The ordered list of LINE keys (band rules excluded) in the last paint — the
  // j/k cursor walks this, so the selection survives a re-sort (it's keyed on
  // the job_id, not a positional index).
  let lineOrder: string[] = [];
  // The selected line key (job:<id>), or null when nothing is selected. Survives
  // re-sort because it's the key, not an index; cleared only when the line
  // leaves the rendered set.
  let selectedKey: string | null = null;
  // The single readiness-gate loading line, mounted lazily and torn down the
  // moment the model resumes cards. Kept OUTSIDE `rowNodes` — its lifecycle
  // (one node, content-only updates, no selection/order participation) is
  // deliberately simpler than a job/band row's.
  let loadingNode: TextRenderableType | null = null;

  /** Paint the loading line, pruning every job/band row first so a resumed
   *  gate never blends stale cards behind it. Idempotent per call. */
  function renderLoading(line: string): void {
    for (const [key, handle] of rowNodes) {
      body.remove(handle.node.id);
      handle.node.destroy();
      rowNodes.delete(key);
    }
    lastOrder = "";
    lineOrder = [];
    selectedKey = null;
    if (loadingNode === null) {
      loadingNode = new runtime.TextRenderable(renderer, {
        id: "dash-loading",
        width: "100%",
        height: 1,
        content: "",
      });
      body.add(loadingNode);
    }
    loadingNode.content = line;
    renderer.requestRender();
  }

  /** Tear down the loading node once the gate clears. No-op if never mounted. */
  function clearLoading(): void {
    if (loadingNode !== null) {
      body.remove(loadingNode.id);
      loadingNode.destroy();
      loadingNode = null;
    }
  }

  function buildLineHandle(key: string, card: CardVM): LineHandle {
    const node = new runtime.BoxRenderable(renderer, {
      id: `dash-row-${key}`,
      width: "100%",
      height: 1,
      flexDirection: "row",
    });
    // The job-name side grows into the slack. `wrapMode:"none"` + `truncate:false`
    // clip it at the END (no ellipsis — OpenTUI's only native end-positioned
    // truncation; `truncate:true` would middle-ellipsis). A far higher flexShrink
    // than the project means the job name gives way FIRST when the row is narrow.
    const left = new runtime.TextRenderable(renderer, {
      id: `dash-row-${key}-l`,
      flexGrow: 1,
      flexShrink: 100,
      minWidth: 0,
      overflow: "hidden",
      wrapMode: "none",
      truncate: false,
      height: 1,
      content: "",
    });
    // The right-justified project clips the SAME way (end, no ellipsis), but only
    // once the job name has fully given way (tiny flexShrink weight).
    const right = new runtime.TextRenderable(renderer, {
      id: `dash-row-${key}-r`,
      flexShrink: 1,
      minWidth: 0,
      overflow: "hidden",
      wrapMode: "none",
      truncate: false,
      height: 1,
      content: "",
    });
    node.add(left);
    node.add(right);
    // A click anywhere on the row selects that job line.
    node.onMouseDown = () => selectByKey(key);
    return { kind: "line", node, left, right, card };
  }

  function buildBandHandle(key: string): BandHandle {
    return {
      kind: "band",
      node: new runtime.BoxRenderable(renderer, {
        id: `dash-row-${key}`,
        width: "100%",
        height: 1,
        border: ["top"],
        borderColor: structureColor,
      }),
    };
  }

  // Flatten the band model into the paint-row stream: a band-title rule per
  // NON-EMPTY band (an empty band collapses), then its job lines.
  function flatten(model: DashModel): PaintRow[] {
    const rows: PaintRow[] = [];
    for (const b of model.bands) {
      if (b.cards.length === 0) {
        continue;
      }
      rows.push({ kind: "band", key: `band:${b.key}`, title: b.title });
      for (const card of b.cards) {
        rows.push({ kind: "line", key: card.key, card });
      }
    }
    return rows;
  }

  // The job-name side: `<caret><icon>  <title>`. The robot icon carries the
  // status color; the selected line gets the cyan caret and bold title. An
  // unselected line pads the caret gutter so columns never shift.
  function buildLeftStyled(card: CardVM, selected: boolean): StyledTextType {
    const icon = colorForIcon(card.iconRole);
    const emphasis: ColorDescriptor = selected ? { bold: true } : {};
    return new runtime.StyledText([
      selected
        ? chunkFor(SELECT_CARET, { index: ACCENT_COLOR_INDEX, bold: true })
        : chunkFor(NO_CARET, {}),
      chunkFor(`${card.robotGlyph}  `, icon),
      chunkFor(card.title, emphasis),
    ]);
  }

  // The right-justified project — always dim (a receded secondary label). The
  // leading gap keeps it off a truncated job name; the trailing gap insets it
  // from the right edge to match the left gutter.
  function buildRightStyled(card: CardVM): StyledTextType {
    return new runtime.StyledText([
      chunkFor(`  ${card.project}  `, { dim: true }),
    ]);
  }

  // Repaint one job line from its last card + the current selection. The
  // selection highlight is a FULL-BLEED row background (covers the whole width,
  // including the truncation ellipsis); the caret + bold ride on top. Idempotent
  // — safe to call every frame and on every selection move.
  function paintLine(key: string): void {
    const handle = rowNodes.get(key);
    if (handle?.kind === "line") {
      const selected = key === selectedKey;
      handle.node.backgroundColor = selected ? selectBg : undefined;
      handle.left.content = buildLeftStyled(handle.card, selected);
      handle.right.content = buildRightStyled(handle.card);
    }
  }

  // Select a job line by key (the shared path for keyboard moves and clicks):
  // repaint the old + new lines and scroll the new one into view.
  function selectByKey(key: string): void {
    if (key === selectedKey) {
      return;
    }
    const prevKey = selectedKey;
    selectedKey = key;
    if (prevKey !== null) {
      paintLine(prevKey);
    }
    paintLine(key);
    const handle = rowNodes.get(key);
    if (handle !== undefined) {
      // Nearest-edge scroll; a no-op if already visible.
      body.scrollChildIntoView(handle.node.id);
    }
    renderer.requestRender();
  }

  function render(model: DashModel): void {
    if (destroyed) {
      return;
    }
    if (model.loading !== undefined) {
      renderLoading(model.loading.line);
      return;
    }
    clearLoading();
    const paintRows = flatten(model);

    // Ensure every wanted row exists and carries current content. New nodes
    // mount detached; the order pass below attaches them in position.
    const wantKeys: string[] = [];
    const nextLineOrder: string[] = [];
    for (const row of paintRows) {
      wantKeys.push(row.key);
      let handle = rowNodes.get(row.key);
      if (handle === undefined) {
        handle =
          row.kind === "line"
            ? buildLineHandle(row.key, row.card)
            : buildBandHandle(row.key);
        rowNodes.set(row.key, handle);
      }
      // Update the band title in place (it rides the box border).
      if (row.kind === "band" && handle.kind === "band") {
        handle.node.title = row.title;
      }
      // Stash the latest card; the selection-aware content paint happens after
      // the structural pass, once selectedKey is settled.
      if (row.kind === "line" && handle.kind === "line") {
        nextLineOrder.push(row.key);
        handle.card = row.card;
      }
    }
    lineOrder = nextLineOrder;

    // The selection cursor starts EMPTY (nothing selected on load) and clears
    // again if the selected line leaves the set or on ESC. It is never
    // auto-seeded — the first j/↓ lands on the first line, k/↑ on the last.
    if (selectedKey !== null && !lineOrder.includes(selectedKey)) {
      selectedKey = null;
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
    // re-attach every wanted node in model order. Detach-then-append keeps each
    // node alive (only `destroy` frees it); content-only frames skip this so
    // Yoga recalc rides structure, not content.
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

    // Paint every line's content AFTER the structural pass, so the selection
    // marker lands on the settled selectedKey.
    for (const key of lineOrder) {
      paintLine(key);
    }

    renderer.requestRender();
  }

  // Move the selection cursor by `delta` steps through the rendered line order
  // (keyed on job_id, so it survives a re-sort). From "nothing selected", j/↓
  // lands on the first line, k/↑ on the last; from a selection it WRAPS at the
  // ends (j past the last → first, k past the first → last).
  function moveSelection(delta: number): void {
    const len = lineOrder.length;
    if (len === 0) {
      return;
    }
    const cur = selectedKey === null ? -1 : lineOrder.indexOf(selectedKey);
    const next =
      cur === -1 ? (delta > 0 ? 0 : len - 1) : (cur + delta + len) % len;
    const nextKey = lineOrder[next];
    if (nextKey !== undefined) {
      selectByKey(nextKey);
    }
  }

  // ESC drops back to "nothing selected" — the load state. The next j/↓ re-seeds
  // the first line, k/↑ the last.
  function clearSelection(): void {
    if (selectedKey === null) {
      return;
    }
    const prevKey = selectedKey;
    selectedKey = null;
    paintLine(prevKey);
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

  // Key handler: q/Ctrl-C → caller teardown; j/down + k/up → move the selection
  // cursor; ESC → clear the selection; t → caller's terminal-visibility toggle.
  renderer.keyInput.on("keypress", (key) => {
    if (destroyed) {
      return;
    }
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      opts.onQuit?.();
      return;
    }
    if (key.name === "j" || key.name === "down") {
      moveSelection(1);
      return;
    }
    if (key.name === "k" || key.name === "up") {
      moveSelection(-1);
      return;
    }
    if (key.name === "escape") {
      clearSelection();
      return;
    }
    if (key.name === "t") {
      opts.onToggleTerminal?.();
    }
  });

  return {
    renderer,
    body,
    render,
    destroy,
  };
}

// ---------------------------------------------------------------------------
// Process shell
// ---------------------------------------------------------------------------

/** The mutable current-inputs struct the subscription feeds; each edge rebuilds
 * the model off the latest snapshot. `showTerminal` rides the ended/killed
 * visibility toggle the `t` keybind flips. */
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
  /** Socket connect for the subscription. Default: the real UDS connect. */
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
 * reactive repaint + the subscription until an exit trigger fires). Read-only:
 * no RPC frame is written, no DB opened.
 *
 * The jobs subscription uses the descriptor's live-only default scope (`state
 * not_in [ended, killed]`), capped at a bounded first page (`created_at DESC`)
 * so the snapshot stays under the 1 MiB NDJSON line cap. The `t` toggle /
 * `showTerminal` plumbing is retained but inert against this live-only feed;
 * re-enabling it awaits a future bounded terminal page.
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
    onToggleTerminal: () => {
      inputs.showTerminal = !inputs.showTerminal;
      paint();
    },
  });

  // ── catching-up gate (fn-1180) ──────────────────────────────────────────
  // dash rides ONE `subscribeReadiness` connection (unlike usage's two
  // streams), so the gate is a direct read of its per-connection latch — no
  // latest-wins merge needed.
  let catchingUp = false;
  let freshestBoot: BootStatus | undefined;
  // Monotonic floor for the displayed re-fold percentage — never regresses
  // within a run.
  let maxRefoldPct = 0;
  // Grace timer + latch for an unreachable socket: armed on EVERY `connecting`
  // (cold-start-while-down and every post-disconnect reconnect alike — the
  // event fires once at the top of each connect attempt), flips the gate to
  // loading `CATCHUP_GRACE_MS` later if no `connected` has landed by then.
  const CATCHUP_GRACE_MS = 1500;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let graceExpiredUnreachable = false;

  function isGated(): boolean {
    return catchingUp || graceExpiredUnreachable;
  }

  /** The loading line: category text plus, for a real re-fold, a monotonic
   *  percentage. No per-root git-seed list — that detail is the board's. */
  function formatLoadingLine(): DashLoadingState {
    const boot = freshestBoot;
    if (boot === undefined) {
      return { line: "catching up…" };
    }
    if (boot.git_seed_required) {
      return { line: "waiting for git seed…" };
    }
    if (boot.head_event_id > 0 && boot.rev < boot.head_event_id) {
      const rawPct = (boot.rev / boot.head_event_id) * 100;
      if (rawPct > maxRefoldPct) {
        maxRefoldPct = rawPct;
      }
      return {
        line: `re-folding event log  ${maxRefoldPct.toFixed(1)}%  ${boot.rev.toLocaleString()} / ${boot.head_event_id.toLocaleString()}`,
      };
    }
    return { line: "catching up…" };
  }

  function armCatchupGrace(): void {
    if (graceTimer !== undefined) {
      return;
    }
    graceTimer = setTimeout(() => {
      graceTimer = undefined;
      graceExpiredUnreachable = true;
      paint();
    }, CATCHUP_GRACE_MS);
  }

  function disarmCatchupGrace(): void {
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer);
      graceTimer = undefined;
    }
    graceExpiredUnreachable = false;
  }

  function paint(): void {
    if (isGated()) {
      app.render(
        buildDashModel(new Map(), inputs.showTerminal, formatLoadingLine()),
      );
      return;
    }
    const snap = inputs.snapshot;
    app.render(buildDashModel(snap?.jobs ?? new Map(), inputs.showTerminal));
  }

  // First paint — the empty list before any data lands.
  paint();

  // The readiness subscription feeds the model off the live jobs projection, on
  // the descriptor's default live-only scope (`state not_in [ended, killed]`),
  // capped at a bounded first page so the snapshot stays under the 1 MiB NDJSON
  // line cap. The `t` toggle / `showTerminal` is inert against this live-only
  // feed — a future bounded terminal page re-enables it.
  const readinessHandle = subscribeReadiness({
    sockPath,
    idPrefix: "dash",
    jobsLimit: DASH_JOBS_PAGE,
    ...connectOpt,
    onSnapshot: (snap) => {
      inputs.snapshot = snap;
      paint();
    },
    onLifecycle: (event) => {
      // A snapshot is retained across a drop so the last-good list freezes
      // until the conn comes back (or, past grace, the gate takes over).
      if (event === "disconnected" || event === "connecting") {
        paint();
      }
      if (event === "connecting") {
        armCatchupGrace();
      }
      if (event === "connected") {
        // A fresh connection is no longer "unreachable" — its own
        // catching-up latch (reset to ready on reconnect) takes the gate
        // from here.
        disarmCatchupGrace();
        paint();
      }
    },
    onBootStatus: (boot) => {
      freshestBoot = boot;
      paint();
    },
    onCatchingUp: (next, boot) => {
      catchingUp = next;
      if (boot !== undefined) {
        freshestBoot = boot;
      }
      paint();
    },
    // Reconnect-forever (settled) — never give up, never tear the TUI down.
    // A fatal pre-paint error (malformed query — should never happen against
    // our own fixed queries) routes through the clean exit tail.
    onFatal: () => exitCleanly(),
  });

  // Single idempotent teardown. destroy() ALWAYS precedes exit so the terminal
  // is restored (OpenTUI does not auto-restore on exit/uncaught). Disposes the
  // sub, disarms the triggers, destroys the renderer.
  let exited = false;
  function exitCleanly(): void {
    if (exited) {
      return;
    }
    exited = true;
    try {
      readinessHandle.dispose();
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
        readinessHandle.dispose();
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

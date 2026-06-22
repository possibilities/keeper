/**
 * `keeper dash` materializer — the OpenTUI paint layer over the pure view-model
 * (`./view-model.ts`). Two surfaces:
 *
 * - {@link attachDashApp} — the PAINT layer. Builds the stable renderable tree
 *   ONCE (root column = a single flexGrow:1 `ScrollBox` body) and exposes
 *   `render(model)`, which paints the card model as a single column of
 *   robot-faced CARDS. Each band contributes a
 *   dim full-width rule (titled inline, structure-gray) followed by its cards;
 *   an empty band collapses (no rule). Each card is one `BoxRenderable` per
 *   `job:<id>` — rounded structure-gray border, project name in the border
 *   title, three interior `Text` lines (`<rail><robot> <status> · <role> ·
 *   ◉<count>` / `<title>` / `<age> · <session:pane>`). The left RAIL glyph
 *   carries the status color (the only color channel; the border is always
 *   structure-gray). A `j`/`k`/arrows focus cursor keyed on `job_id` swaps the
 *   focused card to a HEAVY cyan border and `scrollChildIntoView`s it; `t`
 *   toggles ended/killed visibility through the caller. Nodes are MUTATED in
 *   place across frames (`borderColor`/`borderStyle`/child Text content);
 *   structural detach-then-append fires ONLY when the keyed band order changes,
 *   so Yoga recalc rides structure, not content. The runtime OpenTUI ctors are
 *   THREADED IN so this module carries only a type-only `@opentui/core` import —
 *   the same inertness contract `src/live-shell.ts`'s `attachLiveShellPaint`
 *   keeps, so an unrelated test importing the pure view-model never trips
 *   OpenTUI's racy native loader. Exported so `test/dash-app.test.ts` mounts the
 *   same scene against `createTestRenderer` without forking the
 *   renderer-construction code.
 *
 * - {@link createDashApp} — the PROCESS shell. Dynamic-imports OpenTUI, builds
 *   the renderer with the proven viewer config (exitOnCtrlC:false, exitSignals
 *   SIGTERM/SIGHUP/SIGQUIT, alternate-screen), attaches the paint layer, wires
 *   the live jobs subscription (`subscribeReadiness`, live-only default scope
 *   capped at a bounded first page so the snapshot stays under the NDJSON line
 *   cap; the `t` toggle is deferred/inert), the 30s staleness repaint interval, the key
 *   handler, the forked exit triggers, an onFatal override, and
 *   uncaughtException/unhandledRejection handlers — every path routes through
 *   ONE idempotent `exitCleanly` so `renderer.destroy()` ALWAYS precedes
 *   `process.exit` (OpenTUI does NOT auto-restore the terminal on exit/uncaught).
 *   Reactive mode — never `renderer.start()`.
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
  subscribeReadiness,
} from "../readiness-client";
import { armViewerExitTriggers } from "./exit-triggers";
import {
  type ColorDescriptor,
  colorForRail,
  STRUCTURE_COLOR_INDEX,
} from "./theme";
import { buildDashModel, type CardVM, type DashModel } from "./view-model";

// One coarse repaint interval for the wall-clock-aged card fields (age label)
// — 30s (epic-settled). These age off `nowSec`, not data edges.
const STALE_REFRESH_MS = 30_000;

// Bounded first page for the jobs subscription. The feed serializes the
// snapshot onto one NDJSON line, so an unbounded fetch over a large job history
// exceeds the 1 MiB `MAX_LINE_LENGTH` and closes the connection before the
// first snapshot. 50 (`created_at DESC`) keeps the newest live jobs, well under
// the line cap.
const DASH_JOBS_PAGE = 50;

// Card chrome: rounded structure-gray border by default; HEAVY cyan when the
// focus cursor lands on it. The cyan is the dash accent (bright cyan, index 14
// — mirrors `theme.ts` ROLE_COLORS.accent and board-render's `96` SGR).
const FOCUS_COLOR_INDEX = 14;

// The left RAIL glyphs — the lone status color channel. Solid bar for the
// attention rungs (error/awaiting/working), thin bar for the receded idle
// rungs, so the rail's WEIGHT reinforces the dim/bright lightness split.
const RAIL_SOLID = "▌";
const RAIL_THIN = "▏";

// The running-subagent count marker (a small filled lozenge). Dropped when the
// card has zero running sub-agents.
const SUBAGENT_MARKER = "◉";

// A card is a bordered box (2 rows of border) over 3 interior content lines.
const CARD_HEIGHT = 5;
// Cap the column width so cards stay readable on a wide terminal — full-width
// up to this, then centered slack.
const CARD_MAX_WIDTH = 80;

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
 * tree; `destroy()` tears the renderer down. Exposed pieces let the frame test
 * read content without re-deriving the tree. */
export interface DashApp {
  readonly renderer: CliRenderer;
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

/** A flattened paint row: a `band` is the dim urgency-band rule (titled inline);
 * a `card` is one job's bordered card. The view-model's per-frame order drives
 * the structural diff. */
type PaintRow =
  | { readonly kind: "band"; readonly key: string; readonly title: string }
  | { readonly kind: "card"; readonly key: string; readonly card: CardVM };

/** One mounted card: the bordered box plus its three interior Text lines, all
 * mutated in place across frames. */
interface CardHandle {
  readonly kind: "card";
  readonly node: BoxRenderableType;
  readonly line1: TextRenderableType;
  readonly line2: TextRenderableType;
  readonly line3: TextRenderableType;
}

/** One mounted band rule (no interior text — the title rides the box border). */
interface BandHandle {
  readonly kind: "band";
  readonly node: BoxRenderableType;
}

type RowHandle = CardHandle | BandHandle;

/**
 * Build the renderable scene + the row-diffing `render`. Column layout: a single
 * flexGrow:1 ScrollBox body filling the screen. The body holds the
 * view-model's bands as dim rule rows + one bordered card per job, each a stable
 * handle in `rowNodes` so a re-render mutates content/border in place;
 * structural detach-then-append fires only when the keyed ORDER changes.
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
  const focusColor = RGBA.fromIndex(FOCUS_COLOR_INDEX);

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

  // Root: a full-screen column holding just the scrolling card body.
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

  // Stable per-row handle map, keyed by the view-model's row keys. Content +
  // border mutate in place; membership/order changes restructure (see `render`).
  const rowNodes = new Map<string, RowHandle>();
  // The previous frame's ordered key list — reorder detection.
  let lastOrder = "";
  // The ordered list of CARD keys (band rules excluded) in the last paint — the
  // j/k cursor walks this, so the focus survives a re-sort (it's keyed on the
  // job_id, not a positional index).
  let cardOrder: string[] = [];
  // The focused card key (job:<id>), or null when nothing is focused. Survives
  // re-sort because it's the key, not an index; cleared only when the card
  // leaves the rendered set.
  let focusedKey: string | null = null;

  function buildCardHandle(key: string): CardHandle {
    const node = new runtime.BoxRenderable(renderer, {
      id: `dash-row-${key}`,
      width: "100%",
      maxWidth: CARD_MAX_WIDTH,
      height: CARD_HEIGHT,
      flexDirection: "column",
      borderStyle: "rounded",
      border: true,
      borderColor: structureColor,
      paddingLeft: 1,
      paddingRight: 1,
    });
    const line1 = new runtime.TextRenderable(renderer, {
      id: `dash-row-${key}-1`,
      height: 1,
      content: "",
    });
    const line2 = new runtime.TextRenderable(renderer, {
      id: `dash-row-${key}-2`,
      height: 1,
      content: "",
    });
    const line3 = new runtime.TextRenderable(renderer, {
      id: `dash-row-${key}-3`,
      height: 1,
      content: "",
    });
    node.add(line1);
    node.add(line2);
    node.add(line3);
    return { kind: "card", node, line1, line2, line3 };
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
  // NON-EMPTY band (an empty band collapses), then its cards.
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

  // Card line 1: the rail + robot glyph (both status-colored), a space slot,
  // then the dim status word · role · running-subagent count. The robot glyph
  // sits in the same status-colored run as the rail; the metadata recedes (dim).
  function cardLine1(card: CardVM): StyledTextType {
    const rail = colorForRail(card.railRole);
    const railGlyph = rail.dim === true ? RAIL_THIN : RAIL_SOLID;
    const chunks: BuiltChunk[] = [
      chunkFor(`${railGlyph}${card.robotGlyph} `, rail),
    ];
    const meta: string[] = [card.statusWord];
    if (card.roleLabel !== "") {
      meta.push(card.roleLabel);
    }
    if (card.subagentCount > 0) {
      meta.push(`${SUBAGENT_MARKER}${card.subagentCount}`);
    }
    chunks.push(chunkFor(meta.join(" · "), { dim: true }));
    return new runtime.StyledText(chunks);
  }

  // Card line 2: the job title in the terminal default foreground (the one line
  // that must stay legible at full intensity).
  function cardLine2(card: CardVM): StyledTextType {
    return new runtime.StyledText([chunkFor(card.title, {})]);
  }

  // Card line 3: the dim age · session coordinate footer.
  function cardLine3(card: CardVM): StyledTextType {
    const parts = [card.ageLabel];
    if (card.sessionLabel !== "") {
      parts.push(card.sessionLabel);
    }
    return new runtime.StyledText([chunkFor(parts.join(" · "), { dim: true })]);
  }

  // Paint a card's focus chrome: HEAVY cyan border when focused, rounded
  // structure-gray otherwise. Idempotent — safe to call every frame.
  function applyFocusChrome(handle: CardHandle, focused: boolean): void {
    if (focused) {
      handle.node.borderStyle = "heavy";
      handle.node.borderColor = focusColor;
    } else {
      handle.node.borderStyle = "rounded";
      handle.node.borderColor = structureColor;
    }
  }

  function render(model: DashModel): void {
    if (destroyed) {
      return;
    }
    const paintRows = flatten(model);

    // Ensure every wanted row exists with current content. New nodes mount
    // detached; the order pass below attaches them in position.
    const wantKeys: string[] = [];
    const nextCardOrder: string[] = [];
    for (const row of paintRows) {
      wantKeys.push(row.key);
      let handle = rowNodes.get(row.key);
      if (handle === undefined) {
        handle =
          row.kind === "card"
            ? buildCardHandle(row.key)
            : buildBandHandle(row.key);
        rowNodes.set(row.key, handle);
      }
      // Update the band title in place (it rides the box border).
      if (row.kind === "band" && handle.kind === "band") {
        handle.node.title = row.title;
      }
      if (row.kind === "card" && handle.kind === "card") {
        nextCardOrder.push(row.key);
        // The project name rides the border title (inherits border color —
        // OpenTUI 0.3.0 has no titleColor, so status color lives only in the
        // rail, never the border/title).
        handle.node.title = row.card.project;
        handle.line1.content = cardLine1(row.card);
        handle.line2.content = cardLine2(row.card);
        handle.line3.content = cardLine3(row.card);
      }
    }
    cardOrder = nextCardOrder;

    // The focus cursor: clear it if the focused card left the set; seed it onto
    // the first card when nothing is focused but cards exist.
    if (focusedKey !== null && !cardOrder.includes(focusedKey)) {
      focusedKey = null;
    }
    if (focusedKey === null && cardOrder.length > 0) {
      focusedKey = cardOrder[0] ?? null;
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

    // Apply focus chrome to every card AFTER the structural pass (a re-attached
    // node keeps its ctor-default border until repainted).
    for (const key of cardOrder) {
      const handle = rowNodes.get(key);
      if (handle?.kind === "card") {
        applyFocusChrome(handle, key === focusedKey);
      }
    }

    renderer.requestRender();
  }

  // Move the focus cursor by `delta` steps through the rendered card order
  // (keyed on job_id, so it survives a re-sort), keep the focused card in view,
  // and repaint the border swap.
  function moveFocus(delta: number): void {
    if (cardOrder.length === 0) {
      return;
    }
    const cur = focusedKey === null ? -1 : cardOrder.indexOf(focusedKey);
    // From "nothing focused", j lands on the first card, k on the last.
    let next: number;
    if (cur === -1) {
      next = delta > 0 ? 0 : cardOrder.length - 1;
    } else {
      next = Math.min(Math.max(cur + delta, 0), cardOrder.length - 1);
    }
    const nextKey = cardOrder[next] ?? null;
    if (nextKey === focusedKey) {
      return;
    }
    focusedKey = nextKey;
    for (const key of cardOrder) {
      const handle = rowNodes.get(key);
      if (handle?.kind === "card") {
        applyFocusChrome(handle, key === focusedKey);
      }
    }
    if (focusedKey !== null) {
      const handle = rowNodes.get(focusedKey);
      if (handle !== undefined) {
        // Nearest-edge scroll; a no-op if already visible (no key-repeat jitter).
        body.scrollChildIntoView(handle.node.id);
      }
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

  // Key handler: q/Ctrl-C → caller teardown; j/down + k/up → move the focus
  // cursor; t → caller's terminal-visibility toggle.
  renderer.keyInput.on("keypress", (key) => {
    if (destroyed) {
      return;
    }
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      opts.onQuit?.();
      return;
    }
    if (key.name === "j" || key.name === "down") {
      moveFocus(1);
      return;
    }
    if (key.name === "k" || key.name === "up") {
      moveFocus(-1);
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
 * the card model off the latest snapshot. `showTerminal` rides the ended/killed
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
  // projection, on the descriptor's default live-only scope (`state not_in
  // [ended, killed]`), capped at a bounded first page so the snapshot stays
  // under the 1 MiB NDJSON line cap. The `t` toggle / `showTerminal` is inert
  // against this live-only feed — a future bounded terminal page re-enables it.
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

  // One coarse interval refreshes the wall-clock-aged glyphs — the card age
  // labels age off `nowSec`, not data edges, so no subscription repaints them.
  // unref'd so it never pins the loop alive on its own.
  const staleTimer = setInterval(paint, STALE_REFRESH_MS);
  (staleTimer as { unref?: () => void }).unref?.();

  // Single idempotent teardown. destroy() ALWAYS precedes exit so the terminal
  // is restored (OpenTUI does not auto-restore on exit/uncaught). Disposes the
  // sub, clears the interval, disarms the triggers, destroys the renderer.
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

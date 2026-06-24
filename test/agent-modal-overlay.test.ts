/**
 * OpenTUI modal-overlay test for `--agentwrap-modal` (fn-935.2). Drives the
 * overlay headless on a `createTestRenderer` renderer (the same boot path as
 * test/dash-app.test.ts):
 *
 *  - the hotkey (overlay.open()) floats the test modal over the dim scrim — the
 *    scrim + box renderables mount and the placeholder copy paints;
 *  - Esc dismisses, and a click on the scrim (NOT the modal) dismisses;
 *  - while open the stdin mutex is honored (detach BEFORE resume, attach AFTER
 *    suspend) and a dismiss forces the agent redraw;
 *  - destroy() while open auto-dismisses (child-exit-while-open) and tears the
 *    renderer down, leaving the handoff balanced.
 *
 * SERIAL-SAFE CHAIN MAINTENANCE: this file imports `@opentui/core` runtime
 * values, so it MUST be in BOTH `package.json`'s `test:opentui` chain AND the
 * fast-tier `--path-ignore-patterns` (in `test` and `test:full`) — otherwise it
 * lands in the `--parallel` pass and re-trips OpenTUI's native-loader TDZ.
 * Validate via `bun run test`, never a bare `bun test --parallel`.
 */

import { afterEach, beforeAll, expect, test } from "bun:test";
import {
  BoxRenderable,
  FrameBufferRenderable,
  RGBA,
  TextRenderable,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import {
  attachModalOverlay,
  type OverlayBundle,
  type OverlayHandle,
  type OverlayHostSeam,
} from "../src/agent/modal-overlay";

// Runtime ctors threaded through `attachModalOverlay` — production loads these
// dynamically; the test imports them eagerly since `createTestRenderer` already
// pulls the native binary in.
const RUNTIME = {
  RGBA,
  FrameBufferRenderable,
  BoxRenderable,
  TextRenderable,
} as unknown as OverlayBundle["runtime"];

const MODAL_BODY = "Test modal. Press Esc or click the scrim to dismiss.";

beforeAll(() => {
  process.env.OTUI_USE_CONSOLE = "false";
});

interface SeamLog {
  detach: number;
  attach: number;
  redraw: number;
  termWrites: string[];
}

const pending: OverlayHandle[] = [];
afterEach(() => {
  while (pending.length > 0) {
    try {
      pending.pop()?.destroy();
    } catch {
      // best-effort
    }
  }
});

async function bootOverlay(
  options: { width?: number; height?: number; underTmux?: boolean } = {},
): Promise<{
  setup: Awaited<ReturnType<typeof createTestRenderer>>;
  overlay: OverlayHandle;
  log: SeamLog;
}> {
  const width = options.width ?? 80;
  const height = options.height ?? 24;
  const setup = await createTestRenderer({ width, height, exitSignals: [] });
  // Resting state: the renderer is suspended at host start.
  setup.renderer.suspend();

  const log: SeamLog = { detach: 0, attach: 0, redraw: 0, termWrites: [] };
  const seam: OverlayHostSeam = {
    stdinHandoff: {
      detach: () => {
        log.detach += 1;
      },
      attach: () => {
        log.attach += 1;
      },
    },
    requestAgentRedraw: () => {
      log.redraw += 1;
    },
    termWrite: (data) => {
      log.termWrites.push(data);
    },
    underTmux: options.underTmux ?? false,
  };

  const overlay = attachModalOverlay({
    ...seam,
    bundle: { renderer: setup.renderer, runtime: RUNTIME } as OverlayBundle,
  });
  pending.push(overlay);
  return { setup, overlay, log };
}

// A lone ESC byte is held by the renderer's key parser until a short idle flush
// fires, so the `escape` keypress arrives asynchronously. Poll until `want`
// holds (or give up) instead of a fixed sleep.
async function waitUntil(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  want: () => boolean,
): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (want()) {
      return;
    }
    await Bun.sleep(10);
    await setup.renderOnce();
  }
}

test("hotkey opens the modal: scrim + test box mount and the copy paints", async () => {
  const { setup, overlay } = await bootOverlay();
  expect(overlay.isOpen).toBe(false);

  overlay.open();
  await setup.renderOnce();

  expect(overlay.isOpen).toBe(true);
  // Both layers mounted on the renderer root.
  expect(
    setup.renderer.root.getRenderable("agentwrap-modal-scrim"),
  ).toBeTruthy();
  expect(setup.renderer.root.getRenderable("agentwrap-modal-box")).toBeTruthy();
  // The placeholder copy is on screen.
  expect(setup.captureCharFrame()).toContain(MODAL_BODY);
});

test("Esc dismisses: layers gone, agent redraw forced, handoff balanced", async () => {
  const { setup, overlay, log } = await bootOverlay();
  overlay.open();
  await setup.renderOnce();
  expect(log.detach).toBe(1);

  setup.mockInput.pressEscape();
  await waitUntil(setup, () => !overlay.isOpen);

  expect(overlay.isOpen).toBe(false);
  expect(setup.renderer.root.getRenderable("agentwrap-modal-box")).toBeFalsy();
  expect(
    setup.renderer.root.getRenderable("agentwrap-modal-scrim"),
  ).toBeFalsy();
  // Dismiss forced a SIGWINCH redraw of the agent.
  expect(log.redraw).toBe(1);
  // Stdin mutex honored: detach on open, attach on close (balanced).
  expect(log.detach).toBe(1);
  expect(log.attach).toBe(1);
});

test("clicking the scrim dismisses; clicking the modal does not", async () => {
  const { setup, overlay } = await bootOverlay({ width: 80, height: 24 });
  overlay.open();
  await setup.renderOnce();

  // Click on the modal box center (does NOT dismiss).
  await setup.mockMouse.click(40, 12);
  await setup.renderOnce();
  expect(overlay.isOpen).toBe(true);

  // Click on the scrim (top-left corner, far from the centered modal) dismisses.
  await setup.mockMouse.click(0, 0);
  await waitUntil(setup, () => !overlay.isOpen);
  expect(overlay.isOpen).toBe(false);
});

test("input is mutexed to the modal while open (a non-Esc key is absorbed)", async () => {
  const { setup, overlay } = await bootOverlay();
  overlay.open();
  await setup.renderOnce();

  // A non-dismiss key while open: the overlay absorbs it (no leak path exists —
  // the host's stdin listener is detached) and stays open.
  setup.mockInput.pressKey("a");
  await setup.renderOnce();
  expect(overlay.isOpen).toBe(true);
});

test("?2026 bracketing wraps a frame; skipped under tmux", async () => {
  const { setup, overlay, log } = await bootOverlay({ underTmux: false });
  overlay.open();
  await setup.renderOnce();
  // A non-tmux open emitted a tight BSU/ESU pair around the frame.
  expect(log.termWrites).toContain("\x1b[?2026h");
  expect(log.termWrites).toContain("\x1b[?2026l");

  const tmux = await bootOverlay({ underTmux: true });
  tmux.overlay.open();
  await tmux.setup.renderOnce();
  // Under tmux the ?2026 window is skipped.
  expect(tmux.log.termWrites).not.toContain("\x1b[?2026h");
  expect(tmux.log.termWrites).not.toContain("\x1b[?2026l");
});

test("destroy() while open auto-dismisses and balances the handoff (child-exit-while-open)", async () => {
  const { setup, overlay, log } = await bootOverlay();
  overlay.open();
  await setup.renderOnce();
  expect(overlay.isOpen).toBe(true);
  expect(log.detach).toBe(1);
  expect(log.attach).toBe(0);

  // Child exits while the modal is up → the host destroys the overlay.
  overlay.destroy();
  // The renderer is torn down (restores the terminal); the handoff is rebalanced
  // so keeper's stdin listener is restored.
  expect(overlay.isOpen).toBe(false);
  expect(log.attach).toBe(1);
});

test("focus reporting is silenced on open and re-enabled on close (no mid-session desync)", async () => {
  const { setup, overlay, log } = await bootOverlay();
  overlay.open();
  await setup.renderOnce();
  // Open silenced the child's focus reporting.
  expect(log.termWrites).toContain("\x1b[?1004l");

  setup.mockInput.pressEscape();
  await waitUntil(setup, () => !overlay.isOpen);

  // Close re-enabled it — symmetric to open, so the child's focus events survive
  // the modal open→close cycle. The agent redraw is also forced.
  expect(log.termWrites).toContain("\x1b[?1004h");
  expect(log.redraw).toBe(1);
  // Balanced: focus-off precedes focus-on in write order.
  const off = log.termWrites.indexOf("\x1b[?1004l");
  const on = log.termWrites.indexOf("\x1b[?1004h");
  expect(off).toBeGreaterThanOrEqual(0);
  expect(on).toBeGreaterThan(off);
});

test("the resting state mounts nothing (renderer suspended, no layers)", async () => {
  const { setup } = await bootOverlay();
  // Before any open, neither layer exists — the modal-closed period is bare.
  expect(
    setup.renderer.root.getRenderable("agentwrap-modal-scrim"),
  ).toBeFalsy();
  expect(setup.renderer.root.getRenderable("agentwrap-modal-box")).toBeFalsy();
});

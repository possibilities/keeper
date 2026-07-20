/**
 * Paint tests for the OpenTUI-backed `src/live-shell.ts`. State /
 * keymap / esc-parser coverage lives in `test/live-shell-core.test.ts`;
 * this file proves the OpenTUI paint surface — banner pinning, body
 * mutation on frame change, scrollTo-on-frame-switch, keyboard event
 * translation from OpenTUI's `KeyEvent` back to the core's raw-string
 * contract, and clean teardown via `paint.destroy()`.
 *
 * NB on test runner: this file (and `test/ansi-to-styled.test.ts`) are
 * the only suites that load `@opentui/core` runtime values, and they
 * MUST run under `bun test` (no `--isolate`). Under `--isolate`,
 * `@opentui/core`'s native loader (built form
 * `node_modules/.../@opentui/core/index-*.js` ~L12528, sourcemap to
 * `src/zig.ts:67-68`) trips a top-level-await TDZ —
 *   `ReferenceError: Cannot access 'default' before initialization`
 * — because Bun's per-test-file fresh-global resets the loader chunk
 * mid-evaluation. A `bunfig.toml` `[test] preload` that early-imports
 * `@opentui/core` does NOT hold (the preload's own `await import` hits
 * the same TDZ). `package.json`'s `test` script therefore runs the
 * non-OpenTUI suite under `--parallel` (path-ignoring this pair) and
 * this pair separately under plain `bun test` (`test:opentui`).
 *
 * MAINTENANCE: the split is an explicit allowlist. Any NEW test file
 * that imports `@opentui/core` runtime values must be added to BOTH
 * `test:opentui` AND the `--path-ignore-patterns` of the `--parallel`
 * pass in `test` — otherwise it lands in the parallel pass and
 * re-trips this TDZ, false-reding `bun run test`. (And validate the
 * suite via `bun run test`, never a bare `bun test --parallel`, which
 * deliberately re-includes these files and will always show the TDZ.)
 * Minimal upstream repro (Bun 1.3.14 / @opentui/core 0.3.0):
 *   `bun test --parallel test/ansi-to-styled.test.ts test/live-shell.test.ts`
 * — fails with the TDZ above; filing upstream is deferred to a
 * separate human-approved task.
 *
 * Per the OpenTUI docs the tests boot via `createTestRenderer` with:
 *   - explicit width/height (CI reports columns=0)
 *   - `exitSignals: []` (we don't want SIGINT teardown in test isolation)
 *   - `OTUI_USE_CONSOLE=false` via env (suppresses the renderer's
 *     auto-overlay output that would otherwise show up in captures)
 *   - `destroy()` after each test (leaked native fds → flaky)
 *
 * Coverage:
 *  1. Banner pin: row 0 carries the banner text after first paint.
 *  2. Body mutation: pushFrame swaps the body to the new tip.
 *  3. Scrolled-back banner repaints with `frame N of M` text.
 *  4. Left/right arrow via `mockInput.pressArrow` step through history.
 *  5. `q` keypress disposes via the core's onExit path (no terminal
 *     state leaks).
 *  6. `c` keypress (unmapped by the core's keymap) forwards to the
 *     caller's `onUnhandledKey` with the raw character.
 *  7. `dispose()` is idempotent (second call is a no-op).
 *  8. ScrollTo(0) is invoked on frame switch (read via the scrollBox's
 *     `scrollTop`).
 */

import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import {
  RGBA,
  ScrollBoxRenderable,
  StyledText,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { attachLiveShellPaint, type LiveShellPaint } from "../src/live-shell";
import { createLiveShellCore } from "../src/live-shell-core";

// Runtime constructors threaded through `attachLiveShellPaint` —
// production loads these dynamically (see the `attachLiveShellPaint`
// docstring). Tests import them eagerly since the OpenTUI test
// runner already pulls the same native binary in via
// `createTestRenderer`. `StyledText` / `RGBA` were added in fn-646.4
// for the ANSI→StyledText shim that converts board's embedded SGR
// escapes into OpenTUI styling at paint time.
const PAINT_RUNTIME = {
  TextRenderable,
  ScrollBoxRenderable,
  TextAttributes,
  StyledText,
  RGBA,
} as const;

/**
 * Read a TextRenderable's current content as a plain string. The
 * `.content` getter returns a `StyledText` whose `chunks[].text`
 * carries the literal characters; we join chunks to recover the
 * un-styled text that was set via `content = "..."`.
 */
function textContent(node: TextRenderable): string {
  const styled = node.content;
  const chunks = styled?.chunks ?? [];
  return chunks.map((c) => c.text).join("");
}

// The OpenTUI test renderer pulls capabilities from env — disable the
// console overlay so it doesn't leak into `captureCharFrame()`.
beforeAll(() => {
  process.env.OTUI_USE_CONSOLE = "false";
});

// Each test pushes its created paint onto this stack so the afterEach
// hook tears them all down deterministically. Leaked native fds across
// tests have been observed to flake the runner.
const pendingPaints: LiveShellPaint[] = [];
afterEach(() => {
  while (pendingPaints.length > 0) {
    const p = pendingPaints.pop();
    try {
      p?.destroy();
    } catch {
      // best-effort
    }
  }
});

/**
 * A `SuspendSignalTarget` stub: records `kill(pid, signal)` calls and
 * lets the test fire the SIGCONT that `fg` would deliver, without
 * stopping the test runner. `once`/`removeListener` mirror the live
 * `process` EventEmitter surface the suspend dance uses.
 */
function makeSignalStub() {
  const killed: Array<{ pid: number; signal: string }> = [];
  let contListener: (() => void) | null = null;
  return {
    pid: 4242,
    killed,
    kill(pid: number, signal: string) {
      killed.push({ pid, signal });
    },
    once(_event: "SIGCONT", listener: () => void) {
      contListener = listener;
    },
    removeListener(_event: "SIGCONT", listener: () => void) {
      if (contListener === listener) {
        contListener = null;
      }
    },
    /** Simulate the SIGCONT delivered on `fg`. `once` auto-disarms. */
    fireCont() {
      const l = contListener;
      contListener = null;
      l?.();
    },
    hasContListener: () => contListener != null,
  };
}

async function bootPaint(
  options: {
    title?: string;
    width?: number;
    height?: number;
    signalTarget?: ReturnType<typeof makeSignalStub>;
  } = {},
) {
  const width = options.width ?? 60;
  const height = options.height ?? 8;
  const setup = await createTestRenderer({ width, height, exitSignals: [] });
  let exitCount = 0;
  const unhandledKeys: string[] = [];
  const core = createLiveShellCore({
    enabled: true,
    ttyOk: true,
    title: options.title,
    onPlainWrite: () => {},
    onRender: () => paint.repaint(),
    onExit: () => {
      exitCount++;
    },
    onUnhandledKey: (k) => unhandledKeys.push(k),
  });
  const paint = attachLiveShellPaint(setup.renderer, core, PAINT_RUNTIME, {
    signalTarget: options.signalTarget,
  });
  pendingPaints.push(paint);
  return {
    setup,
    core,
    paint,
    getExitCount: () => exitCount,
    unhandledKeys,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("first paint: banner pinned at row 0; body empty before any pushFrame", async () => {
  const { setup, paint } = await bootPaint({ title: "git" });
  // The banner node owns row 0 exclusively.
  expect(paint.banner.top).toBe(0);
  expect(paint.banner.height).toBe(1);
  // Body starts at row 1 — under the banner.
  expect(paint.scrollBox.top).toBe(1);
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  // Row 0 carries the banner text.
  const firstRow = frame.split("\n")[0] ?? "";
  expect(firstRow).toContain("[[git]] Showing live results");
});

test("pushFrame: body mutates to the new tip; banner counts frames", async () => {
  const { setup, core, paint } = await bootPaint({ title: "git" });
  core.pushFrame(["line-A", "line-B"]);
  await setup.renderOnce();
  // Body node was mutated in place — same TextRenderable reference,
  // new content.
  const bodyText = textContent(paint.body) ?? "";
  expect(bodyText).toBe("line-A\nline-B");
  // Banner reflects the new frame count.
  const bannerText = textContent(paint.banner) ?? "";
  expect(bannerText).toBe("[[git]] Showing live results (frame 1)");

  core.pushFrame(["only"]);
  await setup.renderOnce();
  expect(textContent(paint.body)).toBe("only");
  expect(textContent(paint.banner)).toBe(
    "[[git]] Showing live results (frame 2)",
  );
});

test("scrolled-back: left arrow updates banner to 'frame N of M' and body to held frame", async () => {
  const { setup, core, paint } = await bootPaint();
  core.pushFrame(["F1"]);
  core.pushFrame(["F2"]);
  core.pushFrame(["F3"]);
  await setup.renderOnce();
  // Press left arrow via OpenTUI's mock keys.
  setup.mockInput.pressArrow("left");
  await setup.renderOnce();
  expect(textContent(paint.banner)).toBe(
    "frame 2 of 3 — press G to return to live",
  );
  expect(textContent(paint.body)).toBe("F2");
});

test("G snaps to live; banner clears the scrolled-back text", async () => {
  const { setup, core, paint } = await bootPaint();
  core.pushFrame(["F1"]);
  core.pushFrame(["F2"]);
  core.pushFrame(["F3"]);
  setup.mockInput.pressArrow("left");
  setup.mockInput.pressArrow("left");
  await setup.renderOnce();
  expect(textContent(paint.body)).toBe("F1");
  setup.mockInput.pressKey("G", { shift: true });
  await setup.renderOnce();
  expect(textContent(paint.banner)).toBe("Showing live results (frame 3)");
  expect(textContent(paint.body)).toBe("F3");
});

test("q triggers the core's onExit (without process.exit)", async () => {
  const { setup, core, getExitCount } = await bootPaint();
  core.pushFrame(["x"]);
  await setup.renderOnce();
  setup.mockInput.pressKey("q");
  expect(getExitCount()).toBe(1);
});

test("Ctrl-C triggers the core's onExit (same path as q)", async () => {
  const { setup, core, getExitCount } = await bootPaint();
  core.pushFrame(["x"]);
  await setup.renderOnce();
  setup.mockInput.pressCtrlC();
  expect(getExitCount()).toBe(1);
});

test("Ctrl-Z suspends: restores terminal, re-raises SIGTSTP, then resumes on SIGCONT", async () => {
  const signalTarget = makeSignalStub();
  const { setup, getExitCount, unhandledKeys } = await bootPaint({
    signalTarget,
  });
  // Stub the renderer's native suspend/resume so the dance doesn't
  // tear down the test runner's TTY — we only assert the wiring.
  const suspendSpy = spyOn(setup.renderer, "suspend").mockImplementation(
    () => {},
  );
  const resumeSpy = spyOn(setup.renderer, "resume").mockImplementation(
    () => {},
  );

  setup.mockInput.pressKey("z", { ctrl: true });

  // Terminal restored, then the process group stopped via SIGTSTP —
  // and a SIGCONT listener armed before stopping.
  expect(suspendSpy).toHaveBeenCalledTimes(1);
  expect(signalTarget.killed).toEqual([{ pid: 4242, signal: "SIGTSTP" }]);
  expect(signalTarget.hasContListener()).toBe(true);
  // Ctrl-Z is NOT an exit and NOT forwarded as an unhandled key.
  expect(getExitCount()).toBe(0);
  expect(unhandledKeys).toEqual([]);

  // `fg` delivers SIGCONT → renderer re-enters; the one-shot listener
  // disarms itself.
  signalTarget.fireCont();
  expect(resumeSpy).toHaveBeenCalledTimes(1);
  expect(signalTarget.hasContListener()).toBe(false);

  suspendSpy.mockRestore();
  resumeSpy.mockRestore();
});

test("unmapped printable key 'c' reaches the caller's onUnhandledKey with the raw char", async () => {
  const { setup, core, unhandledKeys } = await bootPaint();
  core.pushFrame(["x"]);
  await setup.renderOnce();
  setup.mockInput.pressKey("c");
  expect(unhandledKeys).toEqual(["c"]);
});

test("vim-style h/j/k/l navigate history via the same paint-layer dispatch", async () => {
  const { setup, core, paint } = await bootPaint();
  core.pushFrame(["F1"]);
  core.pushFrame(["F2"]);
  core.pushFrame(["F3"]);
  await setup.renderOnce();
  setup.mockInput.pressKey("k");
  await setup.renderOnce();
  expect(textContent(paint.body)).toBe("F2");
  setup.mockInput.pressKey("h");
  await setup.renderOnce();
  expect(textContent(paint.body)).toBe("F1");
  setup.mockInput.pressKey("l");
  await setup.renderOnce();
  expect(textContent(paint.body)).toBe("F2");
  setup.mockInput.pressKey("j");
  await setup.renderOnce();
  expect(textContent(paint.body)).toBe("F3");
});

test("setStatus updates the banner without growing history", async () => {
  const { setup, core, paint } = await bootPaint();
  core.pushFrame(["x"]);
  await setup.renderOnce();
  core.setStatus("[copied frame 1]");
  await setup.renderOnce();
  expect(textContent(paint.banner)).toBe(
    "Showing live results (frame 1) [copied frame 1]",
  );
  expect(core.historyLen()).toBe(1);
});

test("semantic headers stay pinned and resize their body geometry", async () => {
  const { setup, core, paint } = await bootPaint({ width: 100, height: 8 });
  const header = {
    lines: ["Fable focus: c2 · permanent · focused", "autopilot: playing"],
    renderAtWidth: (width: number) =>
      width >= 80
        ? ["Fable focus: c2 · permanent · focused", "autopilot: playing"]
        : ["Fable focus: c2", "lifetime: permanent", "state: focused"],
  };
  core.pushFrame(tallFrame(), header);
  await setup.renderOnce();
  expect(textContent(paint.header)).toBe(
    "Fable focus: c2 · permanent · focused\nautopilot: playing",
  );
  expect(paint.scrollBox.top).toBe(3);
  expect(paint.scrollBox.height).toBe(5);

  paint.scrollBox.scrollTop = 12;
  setup.resize(40, 8);
  await setup.renderOnce();
  expect(textContent(paint.header)).toBe(
    "Fable focus: c2\nlifetime: permanent\nstate: focused",
  );
  expect(paint.scrollBox.top).toBe(4);
  expect(paint.scrollBox.height).toBe(4);
  expect(paint.scrollBox.scrollTop).toBe(12);

  core.setStatus("[copied frame 1]");
  setup.resize(100, 8);
  await setup.renderOnce();
  expect(textContent(paint.banner)).toContain("[copied frame 1]");
  expect(textContent(paint.header)).toBe(
    "Fable focus: c2 · permanent · focused\nautopilot: playing",
  );
  expect(paint.scrollBox.top).toBe(3);
  expect(paint.scrollBox.height).toBe(5);
  expect(paint.scrollBox.scrollTop).toBe(12);
});

// A frame taller than the viewport so the ScrollBox has somewhere to
// scroll. height 6 viewport → ~5 body rows visible, 30 rows of content.
const tallFrame = (tag = ""): string[] =>
  Array.from({ length: 30 }, (_, i) => `row${i}${tag}`);

test("a live content update PRESERVES the human's scroll position", async () => {
  // The reported bug: scroll down to read a long board, then a daemon
  // tick yanks you back to the top. A live `pushFrame` keeps
  // `viewIdx === "live"` (no frame switch), so the paint layer must
  // leave the scroll where the human left it.
  const { setup, core, paint } = await bootPaint({ width: 40, height: 6 });
  core.pushFrame(tallFrame());
  await setup.renderOnce();
  paint.scrollBox.scrollTop = 12;
  await setup.renderOnce();
  expect(paint.scrollBox.scrollTop).toBe(12);
  // New live frame at the same height — position must survive.
  core.pushFrame(tallFrame("b"));
  await setup.renderOnce();
  expect(paint.scrollBox.scrollTop).toBe(12);
});

test("a user-initiated frame switch RESETS scroll to the top", async () => {
  // Navigating history (arrow / h / k / g / G / Esc) should open the
  // target frame at its head, not inherit a stale offset from the frame
  // you were just reading. The core flags the switch; the paint layer
  // snaps vertical scroll to 0.
  const { setup, core, paint } = await bootPaint({ width: 40, height: 6 });
  core.pushFrame(tallFrame("a"));
  core.pushFrame(tallFrame("b"));
  await setup.renderOnce();
  paint.scrollBox.scrollTop = 15;
  await setup.renderOnce();
  expect(paint.scrollBox.scrollTop).toBe(15);
  // Left arrow → stepBack → frame switch → scroll resets to 0.
  setup.mockInput.pressArrow("left");
  await setup.renderOnce();
  expect(core.getViewIdx()).toBe(0);
  expect(paint.scrollBox.scrollTop).toBe(0);
});

test("dispose is idempotent — second destroy() is a no-op", async () => {
  const setup = await createTestRenderer({
    width: 60,
    height: 8,
    exitSignals: [],
  });
  const core = createLiveShellCore({
    enabled: true,
    ttyOk: true,
    onPlainWrite: () => {},
  });
  const paint = attachLiveShellPaint(setup.renderer, core, PAINT_RUNTIME);
  paint.destroy();
  // Second call must not throw nor re-destroy the underlying
  // renderer (which would tear down twice).
  expect(() => paint.destroy()).not.toThrow();
});

test("identical-content pushFrame is a no-op on TextRenderable content (same value)", async () => {
  // The repaint short-circuits when both banner and body match the
  // last-painted values. Concrete signal: the TextRenderable.content
  // reference stays the same after an identical pushFrame.
  const { setup, core, paint } = await bootPaint();
  core.pushFrame(["only"]);
  await setup.renderOnce();
  const beforeContent = textContent(paint.body);
  core.pushFrame(["only"]);
  await setup.renderOnce();
  const afterContent = textContent(paint.body);
  // Content equals before AND the banner only bumped the frame count
  // (so the banner DID re-render, but the body did not visibly
  // change). The body still equals "only".
  expect(afterContent).toBe(beforeContent);
  expect(afterContent).toBe("only");
});

test("captureCharFrame reflects the banner+body composition end-to-end", async () => {
  // End-to-end paint assertion against the renderer's char-frame
  // buffer: write a frame, capture, assert both banner row and
  // body row are present.
  const { setup, core } = await bootPaint({ title: "git" });
  core.pushFrame(["body-text"]);
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  const rows = frame.split("\n");
  expect(rows[0]).toContain("[[git]] Showing live results (frame 1)");
  // The body lands on row 1 (under the banner).
  expect(rows[1]).toContain("body-text");
});

test("refreshLive updates the body in place without growing history", async () => {
  const { setup, core, paint } = await bootPaint();
  core.pushFrame(["captured at 3m"]);
  await setup.renderOnce();
  core.refreshLive(["captured at 2m"]);
  await setup.renderOnce();
  expect(textContent(paint.body)).toBe("captured at 2m");
  expect(core.historyLen()).toBe(1);
});

test("clearLiveOverlay restores the history tip without growing it", async () => {
  const { setup, core, paint } = await bootPaint();
  core.pushFrame(["held frame"]);
  core.refreshLive(["loading"]);
  await setup.renderOnce();
  expect(textContent(paint.body)).toBe("loading");

  core.clearLiveOverlay();
  await setup.renderOnce();
  expect(textContent(paint.body)).toBe("held frame");
  expect(core.historyLen()).toBe(1);
});

test("ScrollBox is unfocused — arrow keys reach the live-shell keymap, not the box", async () => {
  // The spec calls out that the ScrollBox must NOT steal arrow keys
  // (it captures them when focused). Verify by pressing left/right
  // and asserting the core's viewIdx moves — if the box ate the
  // arrow, the viewIdx would stay at "live".
  const { setup, core } = await bootPaint();
  core.pushFrame(["A"]);
  core.pushFrame(["B"]);
  core.pushFrame(["C"]);
  await setup.renderOnce();
  expect(core.getViewIdx()).toBe("live");
  setup.mockInput.pressArrow("left");
  await setup.renderOnce();
  expect(core.getViewIdx()).toBe(1);
});

/**
 * Tests for `src/live-shell-core.ts`'s `createLiveShellCore` factory.
 *
 * Pure-state coverage — every assertion is against the core's
 * projection surface (`bannerText`, `visibleRows`, `historyLen`,
 * `getViewIdx`, the `onRender` notification count, the
 * `onUnhandledKey` capture stream) and the passthrough write sink.
 * The render-byte assertions from the pre-OpenTUI-port live-shell
 * tests moved to `test/live-shell.test.ts`, which drives OpenTUI's
 * `createTestRenderer`.
 *
 * Coverage (mirrors the pre-port test layout, minus the render-byte
 * cases that moved to the paint tests):
 *   - History append + ring-buffer eviction
 *   - View-index transitions: live → stepBack → stepForward → snap
 *   - `g` jumps to oldest; `G` / `Esc` snap to live
 *   - `q` / Ctrl-C trigger dispose + onExit
 *   - `dispose()` is idempotent
 *   - Banner string composition (with / without title / status /
 *     scrolled-back)
 *   - Banner status segment toggle (no history bump, single render
 *     notify)
 *   - `refreshLive` overlay applied when live, dormant when scrolled
 *     back, cleared by next `pushFrame`
 *   - Esc parser: bare-Esc idle flush, three-stage CSI split across
 *     chunks, SS3 sequence
 *   - `feedStdin` on a disposed core is silent
 *   - vim-style h/j/k/l navigation
 *   - Unmapped printable letter → `onUnhandledKey`
 *   - Passthrough mode: plain text writes; refresh/setStatus
 *     silent; dispose silent
 */

import { expect, test } from "bun:test";
import {
  createLiveShellCore,
  type LiveShellTimers,
} from "../src/live-shell-core";

// ---------------------------------------------------------------------------
// Fake clock — same shape as the original live-shell test's makeFakeClock.
// ---------------------------------------------------------------------------

interface FakeClock {
  readonly timers: LiveShellTimers;
  flush(): void;
  pendingCount(): number;
}

function makeFakeClock(): FakeClock {
  let next = 1;
  const cbs = new Map<number, () => void>();
  const timers: LiveShellTimers = {
    setTimeout: (cb, _ms) => {
      const id = next++;
      cbs.set(id, cb);
      return id;
    },
    clearTimeout: (handle) => {
      if (handle !== undefined) {
        cbs.delete(handle as number);
      }
    },
  };
  return {
    timers,
    flush(): void {
      const snapshot = [...cbs.entries()];
      cbs.clear();
      for (const [, cb] of snapshot) {
        cb();
      }
    },
    pendingCount(): number {
      return cbs.size;
    },
  };
}

interface BootResult {
  core: ReturnType<typeof createLiveShellCore>;
  clock: FakeClock;
  renderCount(): number;
  exitCount(): number;
  unhandledKeys(): string[];
  plainWrites(): string[];
}

function bootCore(
  overrides: Partial<Parameters<typeof createLiveShellCore>[0]> = {},
): BootResult {
  const clock = makeFakeClock();
  let renders = 0;
  let exits = 0;
  const unhandled: string[] = [];
  const plain: string[] = [];
  const core = createLiveShellCore({
    enabled: true,
    ttyOk: true,
    timers: clock.timers,
    onPlainWrite: (s) => plain.push(s),
    onRender: () => {
      renders++;
    },
    onExit: () => {
      exits++;
    },
    onUnhandledKey: (k) => unhandled.push(k),
    ...overrides,
  });
  return {
    core,
    clock,
    renderCount: () => renders,
    exitCount: () => exits,
    unhandledKeys: () => unhandled,
    plainWrites: () => plain,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("cold start: no history; banner says 'Showing live results'", () => {
  const { core } = bootCore();
  expect(core.mode).toBe("tui");
  expect(core.historyLen()).toBe(0);
  expect(core.bannerText()).toBe("Showing live results");
  expect(core.visibleRows()).toEqual([]);
  expect(core.getViewIdx()).toBe("live");
});

test("pushFrame appends history and notifies onRender; banner counts frames", () => {
  const { core, renderCount } = bootCore();
  core.pushFrame(["line1", "line2"]);
  expect(core.historyLen()).toBe(1);
  expect(core.visibleRows()).toEqual(["line1", "line2"]);
  expect(core.bannerText()).toBe("Showing live results (frame 1)");
  expect(renderCount()).toBe(1);

  core.pushFrame(["only"]);
  expect(core.historyLen()).toBe(2);
  expect(core.visibleRows()).toEqual(["only"]);
  expect(core.bannerText()).toBe("Showing live results (frame 2)");
  expect(renderCount()).toBe(2);
});

test("title prefix folds into the banner when provided", () => {
  const { core } = bootCore({ title: "git" });
  expect(core.bannerText()).toBe("[[git]] Showing live results");
  core.pushFrame(["x"]);
  expect(core.bannerText()).toBe("[[git]] Showing live results (frame 1)");
});

test("scrolled-back banner: frame N of M — press G to return to live", () => {
  const { core } = bootCore();
  core.pushFrame(["A"]);
  core.pushFrame(["B"]);
  core.pushFrame(["C"]);
  // Step back via left arrow.
  core.feedStdin("\x1b[D");
  expect(core.getViewIdx()).toBe(1);
  expect(core.bannerText()).toBe("frame 2 of 3 — press G to return to live");
  expect(core.visibleRows()).toEqual(["B"]);
});

test("new frames during scroll-back: silent body, banner count bumps", () => {
  const { core } = bootCore();
  core.pushFrame(["F1"]);
  core.pushFrame(["F2"]);
  core.pushFrame(["F3"]);
  core.feedStdin("\x1b[D"); // viewIdx = 1 (F2)
  expect(core.visibleRows()).toEqual(["F2"]);
  core.pushFrame(["F4"]);
  // Body unchanged — still showing F2; banner count now M=4.
  expect(core.visibleRows()).toEqual(["F2"]);
  expect(core.bannerText()).toBe("frame 2 of 4 — press G to return to live");
});

test("G snaps to live and renders the tip", () => {
  const { core } = bootCore();
  core.pushFrame(["F1"]);
  core.pushFrame(["F2"]);
  core.pushFrame(["F3"]);
  // Step back twice → viewIdx = 0 (F1).
  core.feedStdin("\x1b[D");
  core.feedStdin("\x1b[D");
  expect(core.getViewIdx()).toBe(0);
  core.feedStdin("G");
  expect(core.getViewIdx()).toBe("live");
  expect(core.visibleRows()).toEqual(["F3"]);
});

test("End (CSI F) snaps to live (same as G)", () => {
  const { core } = bootCore();
  core.pushFrame(["A"]);
  core.pushFrame(["B"]);
  core.feedStdin("\x1b[D");
  expect(core.getViewIdx()).toBe(0);
  core.feedStdin("\x1b[F");
  expect(core.getViewIdx()).toBe("live");
});

test("g jumps to oldest frame", () => {
  const { core } = bootCore();
  core.pushFrame(["A"]);
  core.pushFrame(["B"]);
  core.pushFrame(["C"]);
  core.feedStdin("g");
  expect(core.getViewIdx()).toBe(0);
  expect(core.visibleRows()).toEqual(["A"]);
});

test("q triggers dispose and onExit", () => {
  const { core, exitCount } = bootCore();
  core.pushFrame(["x"]);
  core.feedStdin("q");
  expect(exitCount()).toBe(1);
  // After dispose, further pushes are silent.
  core.pushFrame(["should be silent"]);
  expect(core.historyLen()).toBe(1);
});

test("Ctrl-C (\\x03) triggers dispose + onExit (same path as q)", () => {
  const { core, exitCount } = bootCore();
  core.pushFrame(["x"]);
  core.feedStdin("\x03");
  expect(exitCount()).toBe(1);
});

test("dispose() is idempotent — second call does not double-fire onExit", () => {
  const { core, exitCount } = bootCore();
  core.dispose();
  core.dispose();
  expect(exitCount()).toBe(0);
});

test("history ring-buffer caps at historyCap; oldest drops on overflow", () => {
  const { core } = bootCore({ historyCap: 3 });
  core.pushFrame(["F1"]);
  core.pushFrame(["F2"]);
  core.pushFrame(["F3"]);
  core.pushFrame(["F4"]); // overflow — F1 evicted
  expect(core.historyLen()).toBe(3);
  // Step back to oldest — that's now F2, banner says "1 of 3".
  core.feedStdin("g");
  expect(core.getViewIdx()).toBe(0);
  expect(core.visibleRows()).toEqual(["F2"]);
  expect(core.bannerText()).toBe("frame 1 of 3 — press G to return to live");
});

test("history ring-buffer eviction nudges a held viewIdx down", () => {
  const { core } = bootCore({ historyCap: 3 });
  core.pushFrame(["F1"]);
  core.pushFrame(["F2"]);
  core.pushFrame(["F3"]);
  // Step back twice — viewIdx = 0 (F1).
  core.feedStdin("\x1b[D");
  core.feedStdin("\x1b[D");
  expect(core.getViewIdx()).toBe(0);
  expect(core.visibleRows()).toEqual(["F1"]);
  // Evict F1 — the held viewIdx clamps at 0 and now points at F2.
  core.pushFrame(["F4"]);
  expect(core.getViewIdx()).toBe(0);
  expect(core.visibleRows()).toEqual(["F2"]);
});

test("vim-style h/j/k/l navigate history", () => {
  const { core } = bootCore();
  core.pushFrame(["F1"]);
  core.pushFrame(["F2"]);
  core.pushFrame(["F3"]);
  core.feedStdin("k"); // back
  expect(core.visibleRows()).toEqual(["F2"]);
  core.feedStdin("h"); // back again
  expect(core.visibleRows()).toEqual(["F1"]);
  core.feedStdin("l"); // forward
  expect(core.visibleRows()).toEqual(["F2"]);
  core.feedStdin("j"); // forward → past tip → snap to live
  expect(core.getViewIdx()).toBe("live");
  expect(core.visibleRows()).toEqual(["F3"]);
});

test("unmapped printable letter → onUnhandledKey receives the raw char", () => {
  const { core, unhandledKeys } = bootCore();
  core.pushFrame(["x"]);
  core.feedStdin("z");
  core.feedStdin("c");
  expect(unhandledKeys()).toEqual(["z", "c"]);
});

test("setStatus toggles the banner suffix; identical-value setStatus is a no-op (no render notify)", () => {
  const { core, renderCount } = bootCore();
  core.pushFrame(["x"]);
  const baseline = renderCount();
  expect(core.bannerText()).toBe("Showing live results (frame 1)");
  core.setStatus("[copied frame 1]");
  expect(core.bannerText()).toBe(
    "Showing live results (frame 1) [copied frame 1]",
  );
  expect(renderCount()).toBe(baseline + 1);
  // Identical status — no render.
  core.setStatus("[copied frame 1]");
  expect(renderCount()).toBe(baseline + 1);
  // Clear status — empty hides the segment.
  core.setStatus("");
  expect(core.bannerText()).toBe("Showing live results (frame 1)");
});

test("setStatus does not grow history", () => {
  const { core } = bootCore();
  core.pushFrame(["x"]);
  core.setStatus("[copied]");
  core.setStatus("");
  expect(core.historyLen()).toBe(1);
});

test("refreshLive updates the live view without growing history", () => {
  const { core } = bootCore();
  core.pushFrame(["captured at 3m"]);
  expect(core.visibleRows()).toEqual(["captured at 3m"]);
  core.refreshLive(["captured at 2m"]);
  expect(core.historyLen()).toBe(1);
  expect(core.visibleRows()).toEqual(["captured at 2m"]);
  // The frozen frame is still at index 0.
  core.feedStdin("\x1b[D");
  expect(core.getViewIdx()).toBe(0);
  expect(core.visibleRows()).toEqual(["captured at 3m"]);
});

test("refreshLive overlay is cleared by the next pushFrame", () => {
  const { core } = bootCore();
  core.pushFrame(["original"]);
  core.refreshLive(["ticked"]);
  expect(core.visibleRows()).toEqual(["ticked"]);
  core.pushFrame(["fresh-data"]);
  expect(core.visibleRows()).toEqual(["fresh-data"]);
});

test("refreshLive while scrolled back does not redraw but applies on snap-to-live", () => {
  const { core, renderCount } = bootCore();
  core.pushFrame(["A"]);
  core.pushFrame(["B"]);
  core.feedStdin("\x1b[D"); // viewIdx = 0 → A
  const baseline = renderCount();
  core.refreshLive(["B-ticked"]);
  // Body unchanged while scrolled back.
  expect(core.visibleRows()).toEqual(["A"]);
  // No render notify fired for the dormant refresh.
  expect(renderCount()).toBe(baseline);
  core.feedStdin("G");
  expect(core.getViewIdx()).toBe("live");
  expect(core.visibleRows()).toEqual(["B-ticked"]);
});

test("esc parser: bare \\x1b waits for follow-up; idle flush dispatches snap-to-live", () => {
  const { core, clock } = bootCore();
  core.pushFrame(["A"]);
  core.pushFrame(["B"]);
  core.feedStdin("\x1b[D"); // viewIdx = 0
  expect(core.getViewIdx()).toBe(0);
  core.feedStdin("\x1b");
  // No dispatch yet — the parser is waiting for the second byte.
  expect(core.getViewIdx()).toBe(0);
  expect(clock.pendingCount()).toBe(1);
  // Flush the idle timer — bare Esc dispatches as snap-to-live.
  clock.flush();
  expect(core.getViewIdx()).toBe("live");
});

test("esc parser: CSI split across chunks → \\x1b then [ then A resolves to Up", () => {
  const { core } = bootCore();
  core.pushFrame(["F1"]);
  core.pushFrame(["F2"]);
  core.pushFrame(["F3"]);
  core.feedStdin("\x1b");
  expect(core.getViewIdx()).toBe("live");
  core.feedStdin("[");
  expect(core.getViewIdx()).toBe("live");
  core.feedStdin("A");
  expect(core.getViewIdx()).toBe(1);
  expect(core.visibleRows()).toEqual(["F2"]);
});

test("esc parser: SS3 sequence (\\x1bO + 1 byte) is recognised", () => {
  // SS3 nav doesn't currently map to a builtin handler — the dispatch
  // path is exercised by the unhandled-key channel. Send `\x1bOA`
  // (some terminals' Up) and assert it lands as a single unmapped
  // key handed to `onUnhandledKey`, not three separate characters.
  const { core, unhandledKeys } = bootCore();
  core.pushFrame(["x"]);
  core.feedStdin("\x1bOA");
  expect(unhandledKeys()).toEqual(["\x1bOA"]);
});

test("feedStdin on a disposed core is silent", () => {
  const { core, exitCount, unhandledKeys } = bootCore();
  core.pushFrame(["x"]);
  core.dispose();
  core.feedStdin("q");
  core.feedStdin("z");
  expect(exitCount()).toBe(0);
  expect(unhandledKeys()).toEqual([]);
});

test("passthrough mode: enabled=false writes plain joined text and is otherwise silent", () => {
  const writes: string[] = [];
  const core = createLiveShellCore({
    enabled: false,
    ttyOk: true,
    onPlainWrite: (s) => writes.push(s),
  });
  expect(core.mode).toBe("passthrough");
  core.pushFrame(["one", "two", "three"]);
  expect(writes).toEqual(["one\ntwo\nthree\n"]);
  core.refreshLive(["row-ticked"]);
  expect(writes).toEqual(["one\ntwo\nthree\n"]);
  core.setStatus("[copied]");
  expect(writes).toEqual(["one\ntwo\nthree\n"]);
  core.dispose();
  // Post-dispose pushFrame is silent.
  core.pushFrame(["should be silent"]);
  expect(writes).toEqual(["one\ntwo\nthree\n"]);
});

test("passthrough mode: ttyOk=false also flips to passthrough", () => {
  const writes: string[] = [];
  const core = createLiveShellCore({
    enabled: true,
    ttyOk: false,
    onPlainWrite: (s) => writes.push(s),
  });
  expect(core.mode).toBe("passthrough");
  core.pushFrame(["x"]);
  expect(writes).toEqual(["x\n"]);
});

test("passthrough mode: feedStdin is a silent no-op", () => {
  const writes: string[] = [];
  let exits = 0;
  const core = createLiveShellCore({
    enabled: false,
    ttyOk: true,
    onPlainWrite: (s) => writes.push(s),
    onExit: () => {
      exits++;
    },
  });
  core.feedStdin("q");
  core.feedStdin("\x1b[D");
  expect(exits).toBe(0);
  expect(writes).toEqual([]);
});

test("stepBack from live with single frame snaps to viewIdx=0", () => {
  const { core } = bootCore();
  core.pushFrame(["only"]);
  core.feedStdin("\x1b[D");
  expect(core.getViewIdx()).toBe(0);
  expect(core.visibleRows()).toEqual(["only"]);
});

test("stepForward from live is a no-op", () => {
  const { core, renderCount } = bootCore();
  core.pushFrame(["x"]);
  const baseline = renderCount();
  core.feedStdin("\x1b[C"); // right arrow
  expect(renderCount()).toBe(baseline);
  expect(core.getViewIdx()).toBe("live");
});

test("banner status suffix is preserved across scrolled-back state", () => {
  const { core } = bootCore({ title: "git" });
  core.pushFrame(["A"]);
  core.pushFrame(["B"]);
  core.setStatus("[copy failed]");
  core.feedStdin("\x1b[D");
  expect(core.bannerText()).toBe(
    "[[git]] frame 1 of 2 — press G to return to live [copy failed]",
  );
});

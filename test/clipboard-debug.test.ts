import { expect, test } from "bun:test";
import { buildDebugSnapshot } from "../src/clipboard-debug";

test("debug snapshots retain the accepted plain semantic header", () => {
  const frame = [
    "---",
    "\x1b[31mFable focus: c2 · permanent · focused\x1b[0m",
    "Non-Fable focus: off",
    "autopilot: playing · yolo · cap ∞ · root 1",
    "1. board body",
  ].join("\n");
  const snapshot = buildDebugSnapshot({
    script: "board",
    pid: 4242,
    frame,
    frameNumber: 3,
    metaSidecar: "/tmp/keeper-board.4242.meta.txt",
    lifecycleSidecar: "/tmp/keeper-board.4242.lifecycle.txt",
    nowIso: "2026-06-10T00:00:00.000Z",
  });

  expect(snapshot).toContain(
    "---\nFable focus: c2 · permanent · focused\nNon-Fable focus: off\nautopilot: playing · yolo · cap ∞ · root 1\n1. board body",
  );
  expect(snapshot).not.toContain("\x1b[");
});

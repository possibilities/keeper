/**
 * Real-process timeout-classification test for `defaultTmuxCommandRunner`,
 * extracted from `agent-tmux-launch.test.ts` into its own `*.slow.test.ts`
 * because it spawns a real subprocess (`sleep`) — real-process tests live off
 * the fast `bun run test` tier and run under `bun run test:full`. The injected
 * tiny timeout trips the spawn bound in milliseconds, so it exercises the same
 * classification path the product's multi-second floor would, without the wait.
 */

import { describe, expect, test } from "bun:test";
import { defaultTmuxCommandRunner } from "../src/agent/tmux-launch";

describe("defaultTmuxCommandRunner timeout classification", () => {
  test("a timed-out spawn yields a classifiable non-zero result, not a throw", () => {
    // `sleep 30` far exceeds the injected 50ms bound; Bun.spawnSync returns a
    // result with exitCode null on timeout — the runner must map it, never throw.
    const result = defaultTmuxCommandRunner(["sleep", "30"], 50);

    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out");
  });
});

/**
 * Real-process timeout-classification test for `defaultTmuxCommandRunner`,
 * extracted from `agent-tmux-launch.test.ts` into its own `*.slow.test.ts`
 * because it spawns `sleep 30` and blocks on the product's real 5s spawn-timeout
 * floor (`TMUX_DEFAULT_TIMEOUT_MS`) — ~5s wall-clock. That floor is a product
 * contract, not a test inefficiency, so it can't be tuned away; the rest of
 * `agent-tmux-launch.test.ts` runs in-process and fast. This file is path-ignored
 * from the fast `bun run test` tier and still runs under `bun run test:full`.
 */

import { describe, expect, test } from "bun:test";
import { defaultTmuxCommandRunner } from "../src/agent/tmux-launch";

describe("defaultTmuxCommandRunner timeout classification", () => {
  test("a timed-out spawn yields a classifiable non-zero result, not a throw", () => {
    // `sleep 30` exceeds the 5s default bound; Bun.spawnSync returns a result
    // with exitCode null on timeout — the runner must map it, never throw.
    // The test bound is set above the 5s spawn bound so the spawn timeout,
    // not the runner timeout, is what the assertion observes.
    const result = defaultTmuxCommandRunner(["sleep", "30"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out");
  }, 10_000);
});

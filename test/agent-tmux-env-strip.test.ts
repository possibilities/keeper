/**
 * The tmux env strip (src/main.ts): under the default tmux socket, main() carries
 * the pane id to KEEPER_TMUX_PANE then deletes TMUX/TMUX_PANE from the child env
 * so Claude's ink2 renderer emits truecolor while keeper's hook keeps the pane id
 * for window renaming. Asserted on deps.env post-main() (the mutation Claude
 * inherits), NOT on recorded spawn args (SpawnFn carries only argv).
 */

import { describe, expect, test } from "bun:test";
import { main } from "../src/agent/main";
import { makeHarness, runAndCapture } from "./helpers/agent-main-harness";

describe("tmux env strip", () => {
  test("under $TMUX, carries TMUX_PANE to KEEPER_TMUX_PANE then deletes both", async () => {
    const h = makeHarness({
      argv: ["--print"],
      env: { TMUX: "/tmp/tmux-1000/default,123,0", TMUX_PANE: "%7" },
      listProfiles: () => ["default"],
      pickProfile: () => "default",
    });
    await runAndCapture(h, main);
    expect(h.deps.env.KEEPER_TMUX_PANE).toBe("%7");
    expect(h.deps.env.TMUX).toBeUndefined();
    expect(h.deps.env.TMUX_PANE).toBeUndefined();
  });

  test("no $TMUX: block skipped, KEEPER_TMUX_PANE never set", async () => {
    const h = makeHarness({
      argv: ["--print"],
      env: {},
      listProfiles: () => ["default"],
      pickProfile: () => "default",
    });
    await runAndCapture(h, main);
    expect(h.deps.env.KEEPER_TMUX_PANE).toBeUndefined();
  });

  test("foreign tmux socket: no carrier, but vars still stripped", async () => {
    const h = makeHarness({
      argv: ["--print"],
      env: { TMUX: "/tmp/tmux-1000/jobsearch,123,0", TMUX_PANE: "%7" },
      listProfiles: () => ["default"],
      pickProfile: () => "default",
    });
    await runAndCapture(h, main);
    expect(h.deps.env.KEEPER_TMUX_PANE).toBeUndefined();
    expect(h.deps.env.TMUX).toBeUndefined();
    expect(h.deps.env.TMUX_PANE).toBeUndefined();
  });

  test("$TMUX present but TMUX_PANE empty: no carrier, but vars still stripped", async () => {
    const h = makeHarness({
      argv: ["--print"],
      env: { TMUX: "/tmp/tmux-1000/default,123,0", TMUX_PANE: "" },
      listProfiles: () => ["default"],
      pickProfile: () => "default",
    });
    await runAndCapture(h, main);
    expect(h.deps.env.KEEPER_TMUX_PANE).toBeUndefined();
    expect(h.deps.env.TMUX).toBeUndefined();
    expect(h.deps.env.TMUX_PANE).toBeUndefined();
  });

  test("$TMUX present but TMUX_PANE absent: no carrier set", async () => {
    const h = makeHarness({
      argv: ["--print"],
      env: { TMUX: "/tmp/tmux-1000/default,123,0" },
      listProfiles: () => ["default"],
      pickProfile: () => "default",
    });
    await runAndCapture(h, main);
    expect(h.deps.env.KEEPER_TMUX_PANE).toBeUndefined();
    expect(h.deps.env.TMUX).toBeUndefined();
  });
});

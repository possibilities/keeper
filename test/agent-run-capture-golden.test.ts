/**
 * Characterization golden pins for the PURE `keeper agent` launch-argv builder.
 * Each assertion locks the exact composed command so a mechanical refactor that
 * drifts the launch flags fails loudly.
 *
 * The target is a pure builder — no subprocess/tmux/git is touched (per
 * CLAUDE.md test isolation).
 */

import { describe, expect, test } from "bun:test";
import { buildAgentLaunchArgv } from "../src/agent/launch-config";

const PREFIX = [
  "/fake-home/.bun/bin/bun",
  "/fake-home/code/keeper/cli/keeper.ts",
  "agent",
] as const;

describe("golden: buildAgentLaunchArgv", () => {
  test("claude write-mode launch (model + session, no preset)", () => {
    expect(
      buildAgentLaunchArgv({
        launcherArgvPrefix: PREFIX,
        cli: "claude",
        prompt: "do the thing",
        model: "opus",
        session: "pair",
      }),
    ).toEqual([
      "/fake-home/.bun/bin/bun",
      "/fake-home/code/keeper/cli/keeper.ts",
      "agent",
      "claude",
      "--x-tmux",
      "--x-tmux-detached",
      "--x-no-confirm",
      "--x-tmux-session",
      "pair",
      "--x-tmux-env",
      "KEEPER_TMUX_SESSION=pair",
      "--permission-mode",
      "acceptEdits",
      "--dangerously-skip-permissions",
      "--model",
      "opus",
      "do the thing",
    ]);
  });

  test("claude read-only launch (preset, no session) — posture-independent flags (no strip)", () => {
    expect(
      buildAgentLaunchArgv({
        launcherArgvPrefix: PREFIX,
        cli: "claude",
        prompt: "explore",
        preset: "reviewer",
      }),
    ).toEqual([
      "/fake-home/.bun/bin/bun",
      "/fake-home/code/keeper/cli/keeper.ts",
      "agent",
      "claude",
      "--x-tmux",
      "--x-tmux-detached",
      "--x-no-confirm",
      "--x-preset",
      "reviewer",
      "--permission-mode",
      "acceptEdits",
      "--dangerously-skip-permissions",
      "explore",
    ]);
  });

  test("codex read-only launch (model + effort + session) — keeps write flags", () => {
    expect(
      buildAgentLaunchArgv({
        launcherArgvPrefix: PREFIX,
        cli: "codex",
        prompt: "review this",
        model: "gpt-5",
        effort: "high",
        session: "pair",
      }),
    ).toEqual([
      "/fake-home/.bun/bin/bun",
      "/fake-home/code/keeper/cli/keeper.ts",
      "agent",
      "codex",
      "--x-tmux",
      "--x-tmux-detached",
      "--x-no-confirm",
      "--x-tmux-session",
      "pair",
      "--dangerously-bypass-approvals-and-sandbox",
      "-m",
      "gpt-5",
      "-c",
      'model_reasoning_effort="high"',
      "review this",
    ]);
  });

  test("codex omits the claude-only KEEPER_TMUX_SESSION env carrier", () => {
    const argv = buildAgentLaunchArgv({
      launcherArgvPrefix: PREFIX,
      cli: "codex",
      prompt: "p",
      session: "pair",
    });
    expect(argv).not.toContain("--x-tmux-env");
  });

  test("claude with --name — window-name knob + native --name, both pinned", () => {
    expect(
      buildAgentLaunchArgv({
        launcherArgvPrefix: PREFIX,
        cli: "claude",
        prompt: "weigh in",
        session: "panels",
        name: "panel::smoke::opus",
      }),
    ).toEqual([
      "/fake-home/.bun/bin/bun",
      "/fake-home/code/keeper/cli/keeper.ts",
      "agent",
      "claude",
      "--x-tmux",
      "--x-tmux-detached",
      "--x-no-confirm",
      "--x-tmux-session",
      "panels",
      "--x-tmux-env",
      "KEEPER_TMUX_SESSION=panels",
      "--x-tmux-window-name",
      "panel::smoke::opus",
      "--permission-mode",
      "acceptEdits",
      "--dangerously-skip-permissions",
      "--name",
      "panel::smoke::opus",
      "weigh in",
    ]);
  });

  test("codex with --name — window-name knob only, NO native --name", () => {
    expect(
      buildAgentLaunchArgv({
        launcherArgvPrefix: PREFIX,
        cli: "codex",
        prompt: "weigh in",
        name: "panel::smoke::gpt5",
      }),
    ).toEqual([
      "/fake-home/.bun/bin/bun",
      "/fake-home/code/keeper/cli/keeper.ts",
      "agent",
      "codex",
      "--x-tmux",
      "--x-tmux-detached",
      "--x-no-confirm",
      "--x-tmux-window-name",
      "panel::smoke::gpt5",
      "--dangerously-bypass-approvals-and-sandbox",
      "weigh in",
    ]);
  });

  test("claude RESUME launch — fork pins (--session-id + --fork-session) and a dash-guarded prompt, no trailing positional", () => {
    expect(
      buildAgentLaunchArgv({
        launcherArgvPrefix: PREFIX,
        cli: "claude",
        prompt: "keep going",
        name: "reviewer",
        resumeTarget: "parent-uuid",
        resumeSessionId: "child-uuid",
      }),
    ).toEqual([
      "/fake-home/.bun/bin/bun",
      "/fake-home/code/keeper/cli/keeper.ts",
      "agent",
      "claude",
      "--x-tmux",
      "--x-tmux-detached",
      "--x-no-confirm",
      "--x-tmux-window-name",
      "reviewer",
      "--permission-mode",
      "acceptEdits",
      "--dangerously-skip-permissions",
      "--name",
      "reviewer",
      "--resume",
      "parent-uuid",
      "--session-id",
      "child-uuid",
      "--fork-session",
      "--",
      "keep going",
    ]);
  });

  test("codex RESUME launch — verb-position resume LEADS, dash-guarded prompt trails, no separate positional", () => {
    expect(
      buildAgentLaunchArgv({
        launcherArgvPrefix: PREFIX,
        cli: "codex",
        prompt: "keep going",
        resumeTarget: "rollout-uuid",
      }),
    ).toEqual([
      "/fake-home/.bun/bin/bun",
      "/fake-home/code/keeper/cli/keeper.ts",
      "agent",
      "codex",
      "--x-tmux",
      "--x-tmux-detached",
      "--x-no-confirm",
      "resume",
      "rollout-uuid",
      "--dangerously-bypass-approvals-and-sandbox",
      "--",
      "keep going",
    ]);
  });

  test("pi read-only launch (model + session) — posture-independent flags (no strip)", () => {
    expect(
      buildAgentLaunchArgv({
        launcherArgvPrefix: PREFIX,
        cli: "pi",
        prompt: "scan",
        model: "pi-1",
        session: "pair",
      }),
    ).toEqual([
      "/fake-home/.bun/bin/bun",
      "/fake-home/code/keeper/cli/keeper.ts",
      "agent",
      "pi",
      "--x-tmux",
      "--x-tmux-detached",
      "--x-no-confirm",
      "--x-tmux-session",
      "pair",
      "-na",
      "--model",
      "pi-1",
      "scan",
    ]);
  });
});

/**
 * Byte-pin: the `keeper agent` launcher (`src/agent/main.ts`) composes a stable
 * native argv per agent CLI — if a later mechanical change drifts the composed
 * agent command, these pins fail loudly.
 *
 * Drives `main()` through the recording harness with fully deterministic stubs
 * (fixed uuid, no profiles, null launcher defaults) so the composed argv is a
 * function only of the input flags. The pinned arrays are the exact native
 * commands the launcher produces for the same inputs.
 */

import { describe, expect, test } from "bun:test";
import { main } from "../src/agent/main";
import { buildKeeperAgentLaunchArgv } from "../src/exec-backend";
import { makeHarness, runAndCapture } from "./helpers/agent-main-harness";

const CLAUDE_BIN = "/fake-home/.local/bin/claude";
const CODEX_BIN = "/fake-home/bin/codex";
const PI_BIN = "/fake-home/.local/bin/pi";
const UUID = "11111111-1111-1111-1111-111111111111";

describe("keeper agent byte-pin — claude native argv", () => {
  test("bare prompt launch composes the pinned claude command", async () => {
    const h = makeHarness({
      argv: ["claude", "hello world"],
      rawArgv: true,
      randomUuid: () => UUID,
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      CLAUDE_BIN,
      "hello world",
      "--strict-mcp-config",
      "--teammate-mode",
      "in-process",
      "--session-id",
      UUID,
      "--name",
      "proj-001",
    ]);
  });

  test("--continue keeps the persisted session (no id/name injected)", async () => {
    const h = makeHarness({
      argv: ["claude", "--continue"],
      rawArgv: true,
      randomUuid: () => UUID,
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      CLAUDE_BIN,
      "--continue",
      "--strict-mcp-config",
      "--teammate-mode",
      "in-process",
    ]);
  });
});

describe("keeper agent byte-pin — codex native argv", () => {
  test("bare prompt launch composes the pinned codex command", async () => {
    const h = makeHarness({
      argv: ["codex", "hello"],
      rawArgv: true,
      randomUuid: () => UUID,
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      CODEX_BIN,
      "--dangerously-bypass-approvals-and-sandbox",
      "--search",
      "hello",
    ]);
  });
});

describe("keeper agent byte-pin — pi native argv", () => {
  test("bare prompt launch composes the pinned pi command", async () => {
    const h = makeHarness({
      argv: ["pi", "hello"],
      rawArgv: true,
      randomUuid: () => UUID,
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      PI_BIN,
      "hello",
      "--session-id",
      UUID,
      "--name",
      "proj-001",
    ]);
  });
});

/**
 * Negative byte-pin: the bare `agent <cli>` launch and the managed
 * `buildKeeperAgentLaunchArgv` worker/dispatch launch must carry NO read-only
 * posture and NO extra `CLAUDE*` env strip. Posture (`--read-only`,
 * `--exclude-tools`, `--disallowed-tools`) belongs only on a future posture-bearing
 * path; this is the byte-stability anchor that keeps later increments from leaking
 * it onto the managed launch surface.
 */
const POSTURE_FLAGS = [
  "--read-only",
  "--exclude-tools",
  "--disallowed-tools",
] as const;

describe("keeper agent byte-pin — bare launch carries no posture", () => {
  for (const cli of ["claude", "codex", "pi"] as const) {
    test(`bare ${cli} launch emits no posture flags or CLAUDE env delete`, async () => {
      const h = makeHarness({
        argv: [cli, "hello"],
        rawArgv: true,
        randomUuid: () => UUID,
      });
      const cmd = await runAndCapture(h, main);
      for (const flag of POSTURE_FLAGS) {
        expect(cmd).not.toContain(flag);
      }
      // No CLAUDE-prefixed env carrier/delete leaks into the composed argv.
      expect(cmd.join(" ")).not.toContain("CLAUDE");
    });
  }
});

describe("keeper agent byte-pin — managed launch carries no posture", () => {
  test("buildKeeperAgentLaunchArgv (prompt mode) emits no posture flags", () => {
    const cmd = buildKeeperAgentLaunchArgv({
      launcherArgvPrefix: [
        "/fake-home/.bun/bin/bun",
        "/fake-home/code/keeper/cli/keeper.ts",
        "agent",
      ],
      session: "work",
      prompt: "do it",
      claudeName: "proj-001",
      noConfirm: true,
    });
    for (const flag of POSTURE_FLAGS) {
      expect(cmd).not.toContain(flag);
    }
    // The only env carriers are KEEPER_*; no CLAUDE-prefixed env delete leaks.
    expect(cmd.join(" ")).not.toContain("CLAUDE");
  });

  test("buildKeeperAgentLaunchArgv (resume mode) emits no posture flags", () => {
    const cmd = buildKeeperAgentLaunchArgv({
      launcherArgvPrefix: [
        "/fake-home/.bun/bin/bun",
        "/fake-home/code/keeper/cli/keeper.ts",
        "agent",
      ],
      session: "work",
      prompt: "ignored",
      resumeTarget: "sess-xyz",
      noConfirm: true,
    });
    for (const flag of POSTURE_FLAGS) {
      expect(cmd).not.toContain(flag);
    }
    expect(cmd.join(" ")).not.toContain("CLAUDE");
  });
});

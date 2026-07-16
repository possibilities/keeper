/**
 * Pi launcher pins: `keeper agent pi` maps wrapper features onto Pi-native CLI
 * contracts. There is no Keeper-owned Pi profile farm — model/thinking defaults
 * become `--model`/`--thinking`, session naming uses Pi's `--session-id` and
 * `--name`, and package/metadata commands pass through cleanly.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgsForAgent } from "../src/agent/args";
import type { PresetCatalog } from "../src/agent/config";
import { main } from "../src/agent/main";
import {
  KEEPER_AGENT_PI_PROMPT_CLI_ENV,
  KEEPER_AGENT_PI_PROMPT_EXECUTABLE_ENV,
  PiPromptArtifactsError,
} from "../src/agent/pi-prompt-artifacts";
import {
  expectExit,
  flagValues,
  makeHarness,
  runAndCapture,
} from "./helpers/agent-main-harness";

function piHarness(
  argv: string[],
  opts: Omit<Parameters<typeof makeHarness>[0], "argv"> = {},
) {
  return makeHarness({
    ...opts,
    argv: ["pi", ...argv],
    rawArgv: true,
  });
}

// The harness's default pi_default injects `--thinking high --model glm` on a
// fresh pi launch (see DEFAULT_PRESET_CATALOG).
const DEFAULT_THINKING = ["--thinking", "high"];
const DEFAULT_MODEL = ["--model", "glm"];

/** A catalog whose pi_default triple pins the given model + thinking. The triple's
 *  effort segment carries the keeper effort that maps onto pi's thinking band. */
function piDefaultCatalog(model: string, thinking: string): PresetCatalog {
  return {
    presets: {},
    pi_default: { harness: "pi", model, effort: thinking },
  };
}

describe("Pi parse signals", () => {
  test("Pi session/fork/headless flags are detected without stripping them", () => {
    const session = parseArgsForAgent(["--session", "abc", "hello"], "pi");
    expect(session.hasContinueOrResume).toBe(true);
    expect(session.remainingArgs).toEqual(["--session", "abc", "hello"]);

    const fork = parseArgsForAgent(["--fork", "abc"], "pi");
    expect(fork.hasContinueOrResume).toBe(true);
    expect(fork.hasForkSession).toBe(true);

    expect(parseArgsForAgent(["--print", "hello"], "pi").hasPrint).toBe(true);
    expect(parseArgsForAgent(["--mode", "json"], "pi").hasPrint).toBe(true);
  });
});

describe("Pi command assembly", () => {
  test("fresh interactive launch adds Pi session flags without Claude-only flags", async () => {
    const h = piHarness(["--x-no-confirm", "hello"]);
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      h.deps.piBin,
      "hello",
      ...DEFAULT_THINKING,
      ...DEFAULT_MODEL,
      "--session-id",
      "00000000-0000-0000-0000-000000000000",
      "--name",
      "proj-001",
    ]);
    expect(cmd).not.toContain("--strict-mcp-config");
    expect(cmd).not.toContain("--teammate-mode");
  });

  test("configured model and thinking are injected for Pi", async () => {
    const h = piHarness(["--print", "hello"], {
      presetCatalog: piDefaultCatalog("openai/gpt-4o", "high"),
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--model")).toEqual(["openai/gpt-4o"]);
    expect(flagValues(cmd, "--thinking")).toEqual(["high"]);
  });

  test("explicit native model and thinking suppress the configured Pi default", async () => {
    const h = piHarness(
      ["--print", "--model", "sonnet", "--thinking", "low", "hello"],
      {
        presetCatalog: piDefaultCatalog("openai/gpt-4o", "high"),
      },
    );
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--model")).toEqual(["sonnet"]);
    expect(flagValues(cmd, "--thinking")).toEqual(["low"]);
  });

  test("an explicit --x-profile has no effect — no Pi profile farm remains", async () => {
    const h = piHarness(["--x-profile", "work", "--print", "hello"]);
    const cmd = await runAndCapture(h, main);
    expect(cmd[0]).toBe(h.deps.piBin);
    expect(cmd).toContain("--print");
    expect(h.deps.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(h.deps.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  test("--fork gets a fresh display name but not a wrapper session id", async () => {
    const h = piHarness(["--fork", "abc"], {
      env: { PWD: "/Users/mike/code/keeper" },
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--session-id")).toEqual([]);
    expect(flagValues(cmd, "--name")).toEqual(["proj-001"]);
  });

  test("--no-session suppresses wrapper session id and name", async () => {
    const h = piHarness(["--no-session", "hello"], {
      env: { PWD: "/Users/mike/code/keeper" },
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--session-id")).toEqual([]);
    expect(flagValues(cmd, "--name")).toEqual([]);
  });

  test("arms the keeper pi extension (-e) when the resolver yields flags", async () => {
    const h = piHarness(["--x-no-confirm", "hello"], {
      resolvePiExtensionArgs: () => ["-e", "/fake/keeper-events.ts"],
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "-e")).toEqual(["/fake/keeper-events.ts"]);
  });

  test("omits -e when the extension resolver fails open to []", async () => {
    // The harness default resolver returns [] (extension absent / partial checkout).
    const h = piHarness(["--x-no-confirm", "hello"]);
    const cmd = await runAndCapture(h, main);
    expect(cmd).not.toContain("-e");
  });
});

describe("Pi prompt-artifact preflight", () => {
  test("managed Pi launches overwrite spoofed compiler stamps before preflight", async () => {
    const launcherArgvPrefix = [
      "/trusted/bin/bun",
      "/trusted/keeper/cli/keeper.ts",
      "agent",
    ];
    const h = piHarness(["--x-no-confirm", "hello"], {
      launcherArgvPrefix,
      env: {
        PI_CODING_AGENT_DIR: "/tmp/pi-override",
        [KEEPER_AGENT_PI_PROMPT_EXECUTABLE_ENV]: "/spoof/bun",
        [KEEPER_AGENT_PI_PROMPT_CLI_ENV]: "/spoof/keeper.ts",
      },
    });

    await runAndCapture(h, main);

    expect(h.piPromptArtifactEnvSnapshots).toHaveLength(1);
    expect(h.piPromptArtifactEnvSnapshots[0]).toMatchObject({
      PI_CODING_AGENT_DIR: "/tmp/pi-override",
      [KEEPER_AGENT_PI_PROMPT_EXECUTABLE_ENV]: launcherArgvPrefix[0],
      [KEEPER_AGENT_PI_PROMPT_CLI_ENV]: launcherArgvPrefix[1],
    });
  });

  test("managed Pi launches preflight before state discovery and spawn", async () => {
    const h = piHarness(["--x-no-confirm", "hello"]);

    await runAndCapture(h, main);

    expect(h.piPromptArtifactsCalls).toHaveLength(1);
    expect(h.piStateSharingCalls).toHaveLength(1);
    expect(h.piLaunchOrder).toEqual(["preflight", "state", "intent", "spawn"]);
  });

  test("a birth-intent failure aborts before Pi spawn", async () => {
    const h = piHarness(["--x-no-confirm", "hello"]);
    h.deps.writeBirthIntent = () => {
      throw new Error("birth intent unavailable");
    };

    await expect(main(h.deps)).rejects.toThrow("birth intent unavailable");
    expect(h.spawned).toEqual([]);
  });

  test("a preflight failure exits before Pi state discovery or spawn", async () => {
    const h = piHarness(["--x-no-confirm", "hello"], {
      ensurePiPromptArtifacts: () => {
        throw new PiPromptArtifactsError("prompt artifacts are unavailable");
      },
    });

    expect(await expectExit(main(h.deps))).toBe(1);
    expect(h.err.join("")).toContain("prompt artifacts are unavailable");
    expect(h.piLaunchOrder).toEqual(["preflight"]);
    expect(h.piStateSharingCalls).toEqual([]);
    expect(h.spawned).toEqual([]);
  });

  test("the outer tmux delegator skips preflight and the inner Pi launch runs it once", async () => {
    const outer = piHarness(
      ["--x-tmux", "--x-tmux-detached", "--x-no-confirm", "hello"],
      {
        launcherStateDir: mkdtempSync(join(tmpdir(), "keeper-pi-tmux-")),
        tmuxCommand: (cmd) =>
          cmd.includes("new-window")
            ? { exitCode: 0, stdout: "agent\x01@1\x01%1\n", stderr: "" }
            : { exitCode: 0, stdout: "", stderr: "" },
      },
    );

    expect(await expectExit(main(outer.deps))).toBe(0);
    expect(outer.piPromptArtifactsCalls).toEqual([]);
    expect(outer.piStateSharingCalls).toEqual([]);
    const outerMetadata = JSON.parse(outer.out.join("")) as {
      launchScript: string;
    };
    const launchScript = readFileSync(outerMetadata.launchScript, "utf8");
    expect(launchScript).toContain(
      `export ${KEEPER_AGENT_PI_PROMPT_EXECUTABLE_ENV}='/fake-home/.bun/bin/bun'`,
    );
    expect(launchScript).toContain(
      `export ${KEEPER_AGENT_PI_PROMPT_CLI_ENV}='/fake-home/code/keeper/cli/keeper.ts'`,
    );

    const inner = piHarness(["--x-no-confirm", "hello"]);
    await runAndCapture(inner, main);
    expect(inner.piPromptArtifactsCalls).toHaveLength(1);
    expect(inner.piPromptArtifactEnvSnapshots[0]).toMatchObject({
      [KEEPER_AGENT_PI_PROMPT_EXECUTABLE_ENV]: "/fake-home/.bun/bin/bun",
      [KEEPER_AGENT_PI_PROMPT_CLI_ENV]: "/fake-home/code/keeper/cli/keeper.ts",
    });
    expect(
      outer.piPromptArtifactsCalls.length + inner.piPromptArtifactsCalls.length,
    ).toBe(1);
  });
});

describe("Pi passthrough commands", () => {
  test("package commands pass through without model or session defaults", async () => {
    const h = piHarness(["list"], {
      presetCatalog: piDefaultCatalog("openai/gpt-4o", "high"),
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([h.deps.piBin, "list"]);
    expect(h.piLaunchOrder).toEqual(["preflight", "state", "spawn"]);
  });

  test("metadata flags pass through without model or session defaults", async () => {
    const h = piHarness(["--list-models"], {
      presetCatalog: piDefaultCatalog("openai/gpt-4o", "high"),
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([h.deps.piBin, "--list-models"]);
  });

  test("a package-command-shaped --print prompt is not passthrough", async () => {
    const h = piHarness(["--print", "install"], {
      presetCatalog: piDefaultCatalog("openai/gpt-4o", "high"),
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      h.deps.piBin,
      "--print",
      "install",
      "--thinking",
      "high",
      "--model",
      "openai/gpt-4o",
      "--session-id",
      "00000000-0000-0000-0000-000000000000",
      "--name",
      "proj-001",
    ]);
  });

  test("an explicit --x-profile still has no effect for passthrough", async () => {
    const h = piHarness(["--x-profile", "work", "list"]);
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([h.deps.piBin, "list"]);
    expect(h.deps.env.PI_CODING_AGENT_DIR).toBeUndefined();
  });

  test("the canonical AGENTS.md leaf-guard fn runs on a passthrough launch", async () => {
    // Pi passthrough launches (package commands like `list`) must still reach
    // the leaf guard exactly once, matching every other pi launch — there is no
    // profile farm loop left to gate it behind.
    const h = piHarness(["list"]);
    await runAndCapture(h, main);
    expect(h.piStateSharingCalls).toHaveLength(1);
  });
});

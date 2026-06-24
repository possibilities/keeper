/**
 * Pi launcher pins: `agentwrap pi` maps wrapper features onto Pi-native CLI
 * contracts. Profile routing uses PI_CODING_AGENT_DIR, model/thinking defaults
 * become `--model`/`--thinking`, session naming uses Pi's `--session-id` and
 * `--name`, and package/metadata commands pass through cleanly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgsForAgent } from "../src/agent/args";
import { main } from "../src/agent/main";
import { ensureAgentwrapPiProfileDir } from "../src/agent/state-sharing";
import {
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
    const h = piHarness(["--agentwrap-no-confirm", "hello"]);
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      h.deps.piBin,
      "hello",
      "--session-id",
      "00000000-0000-0000-0000-000000000000",
      "--name",
      "proj-001",
    ]);
    expect(cmd).not.toContain("--strict-mcp-config");
    expect(cmd).not.toContain("--teammate-mode");
    expect(h.deps.env.AGENTWRAP_PI_PROFILE).toBe("default");
    expect(h.deps.env.AGENTWRAP_CLAUDE_PROFILE).toBeUndefined();
  });

  test("configured model and thinking are injected for Pi", async () => {
    const h = piHarness(["--print", "hello"], {
      piLauncherModel: "openai/gpt-4o",
      piLauncherThinking: "high",
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--model")).toEqual(["openai/gpt-4o"]);
    expect(flagValues(cmd, "--thinking")).toEqual(["high"]);
  });

  test("explicit native model and thinking suppress configured Pi defaults", async () => {
    const h = piHarness(
      ["--print", "--model", "sonnet", "--thinking", "low", "hello"],
      {
        piLauncherModel: "openai/gpt-4o",
        piLauncherThinking: "high",
      },
    );
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--model")).toEqual(["sonnet"]);
    expect(flagValues(cmd, "--thinking")).toEqual(["low"]);
  });

  test("explicit wrapper profile maps to PI_CODING_AGENT_DIR", async () => {
    const h = piHarness(["--agentwrap-profile", "work", "--print", "hello"], {
      profileDir: "/fake-home/.pi-profiles/work",
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd[0]).toBe(h.deps.piBin);
    expect(cmd).toContain("--print");
    expect(h.bootstrappedProfiles).toEqual(["work"]);
    expect(h.deps.env.PI_CODING_AGENT_DIR).toBe("/fake-home/.pi-profiles/work");
    expect(h.deps.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(h.deps.env.AGENTWRAP_PI_PROFILE).toBe("work");
  });

  test("--fork gets a fresh display name but not a wrapper session id", async () => {
    const h = piHarness(["--fork", "abc"]);
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--session-id")).toEqual([]);
    expect(flagValues(cmd, "--name")).toEqual(["proj-001"]);
  });

  test("--no-session suppresses wrapper session id and name", async () => {
    const h = piHarness(["--no-session", "hello"]);
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--session-id")).toEqual([]);
    expect(flagValues(cmd, "--name")).toEqual([]);
  });
});

describe("Pi passthrough commands", () => {
  test("package commands pass through without model or session defaults", async () => {
    const h = piHarness(["list"], {
      piLauncherModel: "openai/gpt-4o",
      piLauncherThinking: "high",
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([h.deps.piBin, "list"]);
  });

  test("metadata flags pass through without model or session defaults", async () => {
    const h = piHarness(["--list-models"], {
      piLauncherModel: "openai/gpt-4o",
      piLauncherThinking: "high",
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([h.deps.piBin, "--list-models"]);
  });

  test("a package-command-shaped --print prompt is not passthrough", async () => {
    const h = piHarness(["--print", "install"], {
      piLauncherModel: "openai/gpt-4o",
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      h.deps.piBin,
      "--print",
      "install",
      "--model",
      "openai/gpt-4o",
      "--session-id",
      "00000000-0000-0000-0000-000000000000",
      "--name",
      "proj-001",
    ]);
  });

  test("explicit profile still sets PI_CODING_AGENT_DIR for passthrough", async () => {
    const h = piHarness(["--agentwrap-profile", "work", "list"], {
      profileDir: "/fake-home/.pi-profiles/work",
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([h.deps.piBin, "list"]);
    expect(h.bootstrappedProfiles).toEqual(["work"]);
    expect(h.deps.env.PI_CODING_AGENT_DIR).toBe("/fake-home/.pi-profiles/work");
  });
});

let tmpDir: string;
let home: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agentwrap-pi-profile-"));
  home = join(tmpDir, "home");
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("ensureAgentwrapPiProfileDir", () => {
  test("links shared Pi state while leaving auth profile-local", () => {
    const canonicalDir = join(home, ".pi", "agent");
    mkdirSync(join(canonicalDir, "sessions"), { recursive: true });
    writeFileSync(join(canonicalDir, "settings.json"), '{"theme":"dark"}\n');
    writeFileSync(join(canonicalDir, "auth.json"), '{"native":true}\n');

    const profileDir = join(home, ".pi-profiles", "work");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, "auth.json"), '{"profile":true}\n');

    const log: string[] = [];
    const [dir, changed] = ensureAgentwrapPiProfileDir("work", log, home);

    expect(changed).toBe(true);
    expect(dir).toBe(profileDir);
    expect(lstatSync(join(profileDir, "settings.json")).isSymbolicLink()).toBe(
      true,
    );
    expect(realpathSync(join(profileDir, "settings.json"))).toBe(
      realpathSync(join(canonicalDir, "settings.json")),
    );
    expect(lstatSync(join(profileDir, "sessions")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(profileDir, "auth.json"), "utf8")).toBe(
      '{"profile":true}\n',
    );
    expect(log.some((line) => line.includes("Linked shared Pi path"))).toBe(
      true,
    );
  });
});

/**
 * Codex launcher pins: `agentwrap codex` uses Codex-native CLI contracts
 * instead of forwarding Claude-only flags. Explicit/env profiles map to Codex
 * `--profile`; `model`/`effort` defaults become `--model` and
 * `-c model_reasoning_effort="..."`; admin subcommands pass through.
 */

import { describe, expect, test } from "bun:test";
import { parseArgsForAgent } from "../src/agent/args";
import { main } from "../src/agent/main";
import { makeHarness, runAndCapture } from "./helpers/agent-main-harness";

const CODEX_WRAPPER_DEFAULTS = [
  "--dangerously-bypass-approvals-and-sandbox",
  "--search",
];

function codexHarness(
  argv: string[],
  opts: Omit<Parameters<typeof makeHarness>[0], "argv"> = {},
) {
  return makeHarness({
    ...opts,
    argv: ["codex", ...argv],
    rawArgv: true,
  });
}

describe("Codex parse signals", () => {
  test("-p is a native profile flag, not Claude print mode", () => {
    const p = parseArgsForAgent(["-p", "work", "hello"], "codex");
    expect(p.hasPrint).toBe(false);
    expect(p.remainingArgs).toEqual(["-p", "work", "hello"]);
  });

  test("-c is a native config flag, not Claude continuation mode", () => {
    const p = parseArgsForAgent(
      ["-c", 'model_reasoning_effort="high"', "exec", "hi"],
      "codex",
    );
    expect(p.hasContinueOrResume).toBe(false);
    expect(p.hasPrint).toBe(true);
    expect(p.remainingArgs).toEqual([
      "-c",
      'model_reasoning_effort="high"',
      "exec",
      "hi",
    ]);
  });

  test("synthetic session name is a wrapper-only flag", () => {
    const p = parseArgsForAgent(
      ["--agentwrap-codex-session-name", "work item", "hello"],
      "codex",
    );
    expect(p.agentwrapCodexSessionName).toBe("work item");
    expect(p.remainingArgs).toEqual(["hello"]);
  });
});

describe("Codex command assembly", () => {
  test("fresh interactive launch derives a synthetic Codex session name", async () => {
    const h = codexHarness(["--agentwrap-no-confirm", "hello"], {
      env: { CODEX_HOME: "/fake-home/.codex" },
      cwd: "/fake-home/code/proj",
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([h.deps.codexBin, ...CODEX_WRAPPER_DEFAULTS, "hello"]);
    expect(cmd).not.toContain("--strict-mcp-config");
    expect(cmd).not.toContain("--teammate-mode");
    expect(cmd).not.toContain("--session-id");
    expect(cmd).not.toContain("--name");
    expect(h.codexSessionNameIndexers).toHaveLength(1);
    expect(h.codexSessionNameIndexers[0]).toMatchObject({
      codexHome: "/fake-home/.codex",
      threadName: "proj-001",
      expectedCwd: "/fake-home/code/proj",
    });
    expect(h.deps.env.AGENTWRAP_CODEX_PROFILE).toBe("default");
    expect(h.deps.env.AGENTWRAP_CLAUDE_PROFILE).toBeUndefined();
  });

  test("slug-shaped prompts feed the Codex session indexer", async () => {
    const h = codexHarness(["--agentwrap-no-confirm", "/work fn-53"], {
      env: { CODEX_HOME: "/fake-home/.codex" },
      cwd: "/fake-home/code/proj",
    });
    await runAndCapture(h, main);
    expect(h.codexSessionNameIndexers).toHaveLength(1);
    expect(h.codexSessionNameIndexers[0]).toMatchObject({
      threadName: "fn-53",
      expectedCwd: "/fake-home/code/proj",
    });
  });

  test("explicit wrapper profile maps to Codex --profile", async () => {
    const h = codexHarness([
      "--agentwrap-no-confirm",
      "--agentwrap-profile",
      "work",
      "hello",
    ]);
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      h.deps.codexBin,
      ...CODEX_WRAPPER_DEFAULTS,
      "--profile",
      "work",
      "hello",
    ]);
    expect(h.deps.env.AGENTWRAP_CODEX_PROFILE).toBe("work");
  });

  test("native Codex --profile suppresses wrapper profile injection", async () => {
    const h = codexHarness([
      "--agentwrap-no-confirm",
      "--agentwrap-profile",
      "work",
      "--profile",
      "native",
      "hello",
    ]);
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      h.deps.codexBin,
      ...CODEX_WRAPPER_DEFAULTS,
      "--profile",
      "native",
      "hello",
    ]);
  });

  test("env profile maps to Codex --profile", async () => {
    const h = codexHarness(["--agentwrap-no-confirm", "hello"], {
      env: { AGENTWRAP_PROFILE: "work" },
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      h.deps.codexBin,
      ...CODEX_WRAPPER_DEFAULTS,
      "--profile",
      "work",
      "hello",
    ]);
  });

  test("configured model and effort are injected before the Codex subcommand", async () => {
    const h = codexHarness(["exec", "hello"], {
      codexLauncherModel: "gpt-5.2-codex",
      codexLauncherEffort: "high",
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      h.deps.codexBin,
      ...CODEX_WRAPPER_DEFAULTS,
      "--model",
      "gpt-5.2-codex",
      "-c",
      'model_reasoning_effort="high"',
      "exec",
      "hello",
    ]);
  });

  test("explicit native model and effort suppress configured defaults", async () => {
    const h = codexHarness(
      ["-m", "gpt-5.1-codex", "-c", 'model_reasoning_effort="low"', "exec"],
      {
        codexLauncherModel: "gpt-5.2-codex",
        codexLauncherEffort: "high",
      },
    );
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      h.deps.codexBin,
      ...CODEX_WRAPPER_DEFAULTS,
      "-m",
      "gpt-5.1-codex",
      "-c",
      'model_reasoning_effort="low"',
      "exec",
    ]);
  });

  test("explicit permissions and search config suppress wrapper defaults", async () => {
    const h = codexHarness([
      "--agentwrap-no-confirm",
      "--sandbox",
      "workspace-write",
      "-c",
      'web_search="cached"',
      "hello",
    ]);
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      h.deps.codexBin,
      "--sandbox",
      "workspace-write",
      "-c",
      'web_search="cached"',
      "hello",
    ]);
  });

  test("synthetic session name starts Codex indexer without forwarding flag", async () => {
    const h = codexHarness(
      [
        "--agentwrap-no-confirm",
        "--agentwrap-codex-session-name=work item",
        "hello",
      ],
      {
        env: { CODEX_HOME: "/fake-home/.codex" },
        cwd: "/fake-home/code/agentwrap",
      },
    );
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([h.deps.codexBin, ...CODEX_WRAPPER_DEFAULTS, "hello"]);
    expect(cmd).not.toContain("--agentwrap-codex-session-name=work item");
    expect(h.codexSessionNameIndexers).toHaveLength(1);
    expect(h.codexSessionNameIndexers[0]).toMatchObject({
      codexHome: "/fake-home/.codex",
      threadName: "work item",
      expectedCwd: "/fake-home/code/agentwrap",
    });
  });
});

describe("Codex passthrough commands", () => {
  test("plugin list passes through without model/effort defaults", async () => {
    const h = codexHarness(["plugin", "list"], {
      codexLauncherModel: "gpt-5.2-codex",
      codexLauncherEffort: "high",
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      h.deps.codexBin,
      ...CODEX_WRAPPER_DEFAULTS,
      "plugin",
      "list",
    ]);
  });

  test("synthetic session name is ignored for passthrough commands", async () => {
    const h = codexHarness([
      "--agentwrap-codex-session-name",
      "work item",
      "plugin",
      "list",
    ]);
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      h.deps.codexBin,
      ...CODEX_WRAPPER_DEFAULTS,
      "plugin",
      "list",
    ]);
    expect(h.codexSessionNameIndexers).toHaveLength(0);
  });

  test("exec remains a wrapped agent run", async () => {
    const h = codexHarness(["exec", "hello"], {
      codexLauncherModel: "gpt-5.2-codex",
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      h.deps.codexBin,
      ...CODEX_WRAPPER_DEFAULTS,
      "--model",
      "gpt-5.2-codex",
      "exec",
      "hello",
    ]);
  });
});

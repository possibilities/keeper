/**
 * Codex launcher pins: `keeper agent codex` uses Codex-native CLI contracts
 * instead of forwarding Claude-only flags. An explicit `--x-profile` maps to
 * Codex's native `--profile` (there is no `KEEPER_AGENT_PROFILE` env-forcing —
 * that mechanism is retired); `model`/`effort` defaults become `--model` and
 * `-c model_reasoning_effort="..."`; admin subcommands pass through.
 */

import { describe, expect, test } from "bun:test";
import { parseArgsForAgent } from "../src/agent/args";
import type { PresetCatalog } from "../src/agent/config";
import { main } from "../src/agent/main";
import { makeHarness, runAndCapture } from "./helpers/agent-main-harness";

const CODEX_WRAPPER_DEFAULTS = [
  "--dangerously-bypass-approvals-and-sandbox",
  "--search",
];

// The harness's default codex_default injects `--model gpt -c ...="high"` on a
// fresh codex launch (see DEFAULT_PRESET_CATALOG); a bare launch therefore no
// longer resolves an empty model/effort — it resolves these.
const DEFAULT_MODEL = ["--model", "gpt"];
const DEFAULT_EFFORT = ["-c", 'model_reasoning_effort="high"'];

/** A catalog whose codex_default triple pins the given model + effort. */
function codexDefaultCatalog(model: string, effort: string): PresetCatalog {
  return {
    presets: {},
    codex_default: { harness: "codex", model, effort },
  };
}

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
      ["--x-codex-session-name", "work item", "hello"],
      "codex",
    );
    expect(p.launcherCodexSessionName).toBe("work item");
    expect(p.remainingArgs).toEqual(["hello"]);
  });
});

describe("Codex command assembly", () => {
  test("fresh interactive launch derives a synthetic Codex session name", async () => {
    const h = codexHarness(["--x-no-confirm", "hello"], {
      env: { CODEX_HOME: "/fake-home/.codex" },
      cwd: "/fake-home/code/proj",
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      h.deps.codexBin,
      ...CODEX_WRAPPER_DEFAULTS,
      ...DEFAULT_MODEL,
      ...DEFAULT_EFFORT,
      "hello",
    ]);
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
    // The canonical AGENTS.md leaf-guard runs on interactive launches too.
    expect(h.codexStateSharingCalls).toHaveLength(1);
  });

  test("slug-shaped prompts feed the Codex session indexer", async () => {
    const h = codexHarness(["--x-no-confirm", "/work fn-53"], {
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
    const h = codexHarness(["--x-no-confirm", "--x-profile", "work", "hello"]);
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      h.deps.codexBin,
      ...CODEX_WRAPPER_DEFAULTS,
      "--profile",
      "work",
      ...DEFAULT_MODEL,
      ...DEFAULT_EFFORT,
      "hello",
    ]);
  });

  test("native Codex --profile suppresses wrapper profile injection", async () => {
    const h = codexHarness([
      "--x-no-confirm",
      "--x-profile",
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

  test("KEEPER_AGENT_PROFILE env is retired — it no longer maps to Codex --profile", async () => {
    const h = codexHarness(["--x-no-confirm", "hello"], {
      env: { KEEPER_AGENT_PROFILE: "work" },
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      h.deps.codexBin,
      ...CODEX_WRAPPER_DEFAULTS,
      ...DEFAULT_MODEL,
      ...DEFAULT_EFFORT,
      "hello",
    ]);
    expect(cmd).not.toContain("--profile");
  });

  test("configured model and effort are injected before the Codex subcommand", async () => {
    const h = codexHarness(["exec", "hello"], {
      presetCatalog: codexDefaultCatalog("gpt-5.2-codex", "high"),
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

  test("explicit native model and effort suppress the configured default", async () => {
    const h = codexHarness(
      ["-m", "gpt-5.1-codex", "-c", 'model_reasoning_effort="low"', "exec"],
      {
        presetCatalog: codexDefaultCatalog("gpt-5.2-codex", "high"),
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
      "--x-no-confirm",
      "--sandbox",
      "workspace-write",
      "-c",
      'web_search="cached"',
      "hello",
    ]);
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      h.deps.codexBin,
      ...DEFAULT_MODEL,
      ...DEFAULT_EFFORT,
      "--sandbox",
      "workspace-write",
      "-c",
      'web_search="cached"',
      "hello",
    ]);
  });

  test("synthetic session name starts Codex indexer without forwarding flag", async () => {
    const h = codexHarness(
      ["--x-no-confirm", "--x-codex-session-name=work item", "hello"],
      {
        env: { CODEX_HOME: "/fake-home/.codex" },
        cwd: "/fake-home/code/keeper",
      },
    );
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      h.deps.codexBin,
      ...CODEX_WRAPPER_DEFAULTS,
      ...DEFAULT_MODEL,
      ...DEFAULT_EFFORT,
      "hello",
    ]);
    expect(cmd).not.toContain("--x-codex-session-name=work item");
    expect(h.codexSessionNameIndexers).toHaveLength(1);
    expect(h.codexSessionNameIndexers[0]).toMatchObject({
      codexHome: "/fake-home/.codex",
      threadName: "work item",
      expectedCwd: "/fake-home/code/keeper",
    });
  });
});

describe("Codex passthrough commands", () => {
  test("plugin list passes through without model/effort defaults", async () => {
    const h = codexHarness(["plugin", "list"], {
      presetCatalog: codexDefaultCatalog("gpt-5.2-codex", "high"),
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
      "--x-codex-session-name",
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

  test("the canonical AGENTS.md leaf-guard fn runs on a passthrough launch", async () => {
    // Codex is almost always passthrough, so the guard must reach these launches.
    const h = codexHarness(["plugin", "list"]);
    await runAndCapture(h, main);
    expect(h.codexStateSharingCalls).toHaveLength(1);
  });

  test("exec remains a wrapped agent run", async () => {
    const h = codexHarness(["exec", "hello"], {
      presetCatalog: codexDefaultCatalog("gpt-5.2-codex", "high"),
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
});

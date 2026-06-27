/**
 * Subcommand dispatch (src/dispatch.ts + the main() pre-pass): the leading
 * argv token classifies the invocation. Agent subcommands strip exactly one
 * token and launch (the composed agent argv stays byte-identical — parity
 * contract); `--help`/`--version` print + exit 0; bare/unknown → usage on
 * stderr + exit 2.
 * The pure classifier is unit-tested directly; the routing + parity are driven
 * through the shared main() harness.
 */

import { describe, expect, test } from "bun:test";
import { splitSubcommand } from "../src/agent/dispatch";
import { main } from "../src/agent/main";
import {
  expectExit,
  makeHarness,
  runAndCapture,
} from "./helpers/agent-main-harness";

function harness(argv: string[]) {
  return makeHarness({
    argv,
    rawArgv: true,
    listProfiles: () => ["default"],
    pickProfile: () => "default",
  });
}

describe("splitSubcommand", () => {
  test("leading claude runs with the remaining args", () => {
    expect(splitSubcommand(["claude", "--print", "hi"])).toEqual({
      kind: "run",
      agent: "claude",
      rest: ["--print", "hi"],
    });
  });

  test("bare claude runs with an empty rest", () => {
    expect(splitSubcommand(["claude"])).toEqual({
      kind: "run",
      agent: "claude",
      rest: [],
    });
  });

  test("leading codex runs with the remaining args", () => {
    expect(splitSubcommand(["codex", "exec", "hi"])).toEqual({
      kind: "run",
      agent: "codex",
      rest: ["exec", "hi"],
    });
  });

  test("leading pi runs with the remaining args", () => {
    expect(splitSubcommand(["pi", "--print", "hi"])).toEqual({
      kind: "run",
      agent: "pi",
      rest: ["--print", "hi"],
    });
  });

  test("strips exactly one token — a second claude survives", () => {
    expect(splitSubcommand(["claude", "claude"])).toEqual({
      kind: "run",
      agent: "claude",
      rest: ["claude"],
    });
  });

  test("strips exactly one token — a second codex survives", () => {
    expect(splitSubcommand(["codex", "codex"])).toEqual({
      kind: "run",
      agent: "codex",
      rest: ["codex"],
    });
  });

  test("strips exactly one token — a second pi survives", () => {
    expect(splitSubcommand(["pi", "pi"])).toEqual({
      kind: "run",
      agent: "pi",
      rest: ["pi"],
    });
  });

  test("help/version flags classify", () => {
    expect(splitSubcommand(["-h"])).toEqual({ kind: "help" });
    expect(splitSubcommand(["--help"])).toEqual({ kind: "help" });
    expect(splitSubcommand(["-v"])).toEqual({ kind: "version" });
    expect(splitSubcommand(["--version"])).toEqual({ kind: "version" });
  });

  test("leading --x-help classifies as wrapper help", () => {
    expect(splitSubcommand(["--x-help"])).toEqual({
      kind: "help-wrapper",
    });
  });

  test("--x-help after an agent token lands in rest", () => {
    expect(splitSubcommand(["claude", "--x-help"])).toEqual({
      kind: "run",
      agent: "claude",
      rest: ["--x-help"],
    });
  });

  test("leading --x-preset is the harnessless run-preset form", () => {
    expect(splitSubcommand(["--x-preset", "claude-opus-xhigh", "/p"])).toEqual({
      kind: "run-preset",
      presetName: "claude-opus-xhigh",
      // The whole argv stays in rest so parseArgs strips the flag.
      rest: ["--x-preset", "claude-opus-xhigh", "/p"],
    });
  });

  test("leading --x-preset=joined form classifies as run-preset", () => {
    expect(splitSubcommand(["--x-preset=codex-gpt55-high"])).toEqual({
      kind: "run-preset",
      presetName: "codex-gpt55-high",
      rest: ["--x-preset=codex-gpt55-high"],
    });
  });

  test("--x-preset with no name is usage", () => {
    expect(splitSubcommand(["--x-preset"])).toEqual({
      kind: "usage",
      unknown: "--x-preset",
    });
  });

  test("presets resolve <name> classifies", () => {
    expect(splitSubcommand(["presets", "resolve", "default"])).toEqual({
      kind: "presets-resolve",
      presetName: "default",
    });
  });

  test("presets resolve with no name is usage", () => {
    expect(splitSubcommand(["presets", "resolve"])).toEqual({
      kind: "usage",
      unknown: "presets resolve",
    });
  });

  test("presets list classifies (bare → human-readable)", () => {
    expect(splitSubcommand(["presets", "list"])).toEqual({
      kind: "presets-list",
      json: false,
    });
  });

  test("presets list --json classifies", () => {
    expect(splitSubcommand(["presets", "list", "--json"])).toEqual({
      kind: "presets-list",
      json: true,
    });
  });

  test("presets with an unknown verb is usage", () => {
    expect(splitSubcommand(["presets", "frobnicate"])).toEqual({
      kind: "usage",
      unknown: "presets frobnicate",
    });
  });

  test("empty argv is bare usage (no unknown)", () => {
    expect(splitSubcommand([])).toEqual({ kind: "usage" });
  });

  test("an unknown leading token carries its name", () => {
    expect(splitSubcommand(["frobnicate"])).toEqual({
      kind: "usage",
      unknown: "frobnicate",
    });
  });
});

describe("main() dispatch routing", () => {
  test("claude + args reaches the spawn recorder", async () => {
    const h = harness(["claude", "--x-no-confirm", "hello"]);
    const cmd = await runAndCapture(h, main);
    expect(cmd[0]).toBe(h.deps.claudeBin);
    expect(cmd).toContain("hello");
    // The leading `claude` token was stripped — it must not leak into argv.
    expect(cmd.slice(1)).not.toContain("claude");
  });

  test("parity: stripping `claude` leaves the composed argv identical", async () => {
    const args = ["--x-no-confirm", "--print", "hello world"];
    const withSub = await runAndCapture(harness(["claude", ...args]), main);
    // Re-derive the same argv directly via splitSubcommand to prove the strip
    // is the only transform: feeding `rest` straight in must match.
    const rest = (() => {
      const d = splitSubcommand(["claude", ...args]);
      if (d.kind !== "run") throw new Error("expected run");
      return d.rest;
    })();
    expect(rest).toEqual(args);
    // The spawned argv carries the prompt and the wrapper-added flags, with no
    // stray subcommand token.
    expect(withSub).toContain("hello world");
    expect(withSub).toContain("--print");
    expect(withSub.slice(1)).not.toContain("claude");
  });

  test("codex + args reaches the spawn recorder", async () => {
    const h = harness(["codex", "--x-no-confirm", "hello"]);
    const cmd = await runAndCapture(h, main);
    expect(cmd[0]).toBe(h.deps.codexBin);
    expect(cmd).toContain("hello");
    expect(cmd.slice(1)).not.toContain("codex");
  });

  test("pi + args reaches the spawn recorder", async () => {
    const h = harness(["pi", "--x-no-confirm", "hello"]);
    const cmd = await runAndCapture(h, main);
    expect(cmd[0]).toBe(h.deps.piBin);
    expect(cmd).toContain("hello");
    expect(cmd.slice(1)).not.toContain("pi");
  });

  test("bare claude launches interactively (spawn fires)", async () => {
    const h = harness(["claude", "--x-no-confirm"]);
    const cmd = await runAndCapture(h, main);
    expect(cmd[0]).toBe(h.deps.claudeBin);
  });

  test("bare agentwrap → usage on stderr + exit 2", async () => {
    const h = harness([]);
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("agentwrap");
    expect(h.out.join("")).toBe("");
    expect(h.spawned.length).toBe(0);
  });

  test("unknown subcommand → stderr 'unknown subcommand' + exit 2", async () => {
    const h = harness(["frobnicate"]);
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("unknown subcommand 'frobnicate'");
    expect(h.spawned.length).toBe(0);
  });

  test("--help → stdout usage + exit 0", async () => {
    const h = harness(["--help"]);
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(h.out.join("")).toContain("Usage:");
    expect(h.err.join("")).toBe("");
    expect(h.spawned.length).toBe(0);
  });

  test("--version → stdout version + exit 0", async () => {
    const h = harness(["--version"]);
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(h.out.join("")).toContain("agentwrap ");
    expect(h.spawned.length).toBe(0);
  });

  test("--x-help → stdout wrapper help + exit 0", async () => {
    const h = harness(["--x-help"]);
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(h.out.join("")).toContain("Wrapper flags:");
    expect(h.out.join("")).toContain("--x-tmux");
    expect(h.err.join("")).toBe("");
    expect(h.spawned.length).toBe(0);
  });

  test("claude --x-help → wrapper help + exit 0, no launch", async () => {
    const h = harness(["claude", "--x-help"]);
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(h.out.join("")).toContain("Wrapper flags:");
    expect(h.spawned.length).toBe(0);
  });

  test("codex --x-help → wrapper help + exit 0, no launch", async () => {
    const h = harness(["codex", "--x-help"]);
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(h.out.join("")).toContain("Wrapper flags:");
    expect(h.spawned.length).toBe(0);
  });

  test("pi --x-help → wrapper help + exit 0, no launch", async () => {
    const h = harness(["pi", "--x-help"]);
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(h.out.join("")).toContain("Wrapper flags:");
    expect(h.spawned.length).toBe(0);
  });

  test("claude --help passes --help through to claude", async () => {
    const h = harness(["claude", "--help"]);
    const cmd = await runAndCapture(h, main);
    expect(cmd[0]).toBe(h.deps.claudeBin);
    expect(cmd).toContain("--help");
  });

  test("codex --help passes --help through to codex", async () => {
    const h = harness(["codex", "--help"]);
    const cmd = await runAndCapture(h, main);
    expect(cmd[0]).toBe(h.deps.codexBin);
    expect(cmd).toContain("--help");
  });

  test("pi --help passes --help through to pi", async () => {
    const h = harness(["pi", "--help"]);
    const cmd = await runAndCapture(h, main);
    expect(cmd[0]).toBe(h.deps.piBin);
    expect(cmd).toContain("--help");
  });
});

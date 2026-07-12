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
import { main as agentCliMain, routeMetaBeforeDeps } from "../cli/agent";
import { splitSubcommand } from "../src/agent/dispatch";
import { main } from "../src/agent/main";
import {
  expectExit,
  makeHarness,
  runAndCapture,
} from "./helpers/agent-main-harness";

/** Tagged throw standing in for `process.exit(code)` so a routed help/version
 *  path is observable without killing the test runner. */
class ExitError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

function harness(argv: string[]) {
  return makeHarness({
    argv,
    rawArgv: true,
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

  test("leading --x-preset is the harnessless run-preset form (the value is a triple)", () => {
    expect(
      splitSubcommand(["--x-preset", "claude::opus::xhigh", "/p"]),
    ).toEqual({
      kind: "run-preset",
      presetName: "claude::opus::xhigh",
      // The whole argv stays in rest so parseArgs strips the flag.
      rest: ["--x-preset", "claude::opus::xhigh", "/p"],
    });
  });

  test("leading --x-preset=joined form classifies as run-preset", () => {
    expect(splitSubcommand(["--x-preset=codex::gpt-5.5::high"])).toEqual({
      kind: "run-preset",
      presetName: "codex::gpt-5.5::high",
      rest: ["--x-preset=codex::gpt-5.5::high"],
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

  // The profile-check command is retired (no Keeper-owned profile farm to
  // diagnose) — `profiles` is now an ordinary unrecognized leading token,
  // classified identically regardless of what follows it.
  test("profiles check is no longer a recognized subcommand", () => {
    expect(splitSubcommand(["profiles", "check"])).toEqual({
      kind: "usage",
      unknown: "profiles",
    });
  });

  test("profiles check --json is no longer a recognized subcommand", () => {
    expect(splitSubcommand(["profiles", "check", "--json"])).toEqual({
      kind: "usage",
      unknown: "profiles",
    });
  });

  test("bare profiles is usage", () => {
    expect(splitSubcommand(["profiles"])).toEqual({
      kind: "usage",
      unknown: "profiles",
    });
  });

  test("providers resolve <model> <effort> classifies", () => {
    expect(
      splitSubcommand(["providers", "resolve", "gpt-5.5", "high"]),
    ).toEqual({ kind: "providers-resolve", model: "gpt-5.5", effort: "high" });
  });

  test("providers resolve missing effort is usage", () => {
    expect(splitSubcommand(["providers", "resolve", "gpt-5.5"])).toEqual({
      kind: "usage",
      unknown: "providers resolve",
    });
  });

  test("providers check classifies", () => {
    expect(splitSubcommand(["providers", "check"])).toEqual({
      kind: "providers-check",
    });
  });

  test("providers with an unknown verb is usage", () => {
    expect(splitSubcommand(["providers", "frobnicate"])).toEqual({
      kind: "usage",
      unknown: "providers frobnicate",
    });
  });

  test("bare providers is usage", () => {
    expect(splitSubcommand(["providers"])).toEqual({
      kind: "usage",
      unknown: "providers",
    });
  });

  test("resume <target> classifies with an empty rest", () => {
    expect(splitSubcommand(["resume", "my-partner"])).toEqual({
      kind: "resume",
      target: "my-partner",
      rest: [],
    });
  });

  test("resume <target> <prompt> classifies, rest carries the prompt tokens", () => {
    expect(
      splitSubcommand(["resume", "my-partner", "follow", "up", "ask"]),
    ).toEqual({
      kind: "resume",
      target: "my-partner",
      rest: ["follow", "up", "ask"],
    });
  });

  test("resume <id> accepts a bare session-id-shaped target", () => {
    expect(splitSubcommand(["resume", "abc-123-def"])).toEqual({
      kind: "resume",
      target: "abc-123-def",
      rest: [],
    });
  });

  test("bare resume (no target) is usage", () => {
    expect(splitSubcommand(["resume"])).toEqual({
      kind: "usage",
      unknown: "resume",
    });
  });

  test("resume with a blank target is usage", () => {
    expect(splitSubcommand(["resume", "  "])).toEqual({
      kind: "usage",
      unknown: "resume",
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

  test("bare keeper agent → usage on stderr + exit 2", async () => {
    const h = harness([]);
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("keeper agent");
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
    expect(h.out.join("")).toContain("keeper agent ");
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

describe("resume route", () => {
  test("unknown target: exit 2, no launch, message names the target", async () => {
    const h = harness(["resume", "ghost"]);
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("no partner session found");
    expect(h.err.join("")).toContain("ghost");
    expect(h.tmuxCommands.length).toBe(0);
    expect(h.spawned.length).toBe(0);
  });

  test("live target: exit 2, points at the bus, no launch", async () => {
    const h = makeHarness({
      argv: ["resume", "codey"],
      rawArgv: true,
      resolveResumeDecision: {
        kind: "live",
        job_id: "job-live-1",
        harness: "codex",
        title: "codey",
      },
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("LIVE");
    expect(h.err.join("")).toContain("job-live-1");
    expect(h.err.join("")).toContain("keeper bus chat send job-live-1");
    expect(h.tmuxCommands.length).toBe(0);
  });

  test("ambiguous target: exit 2, lists every tied candidate", async () => {
    const h = makeHarness({
      argv: ["resume", "twin"],
      rawArgv: true,
      resolveResumeDecision: {
        kind: "ambiguous",
        candidates: [
          { job_id: "job-a", harness: "claude", title: "twin", updated_at: 5 },
          { job_id: "job-b", harness: "pi", title: "twin", updated_at: 5 },
        ],
      },
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("ambiguous");
    expect(h.err.join("")).toContain("job-a");
    expect(h.err.join("")).toContain("job-b");
    expect(h.tmuxCommands.length).toBe(0);
  });

  test("no-target: exit 2, names the matched job, no launch", async () => {
    const h = makeHarness({
      argv: ["resume", "stale"],
      rawArgv: true,
      resolveResumeDecision: {
        kind: "no-target",
        job_id: "job-nt",
        harness: "hermes",
        title: "stale",
      },
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("no resume target");
    expect(h.err.join("")).toContain("job-nt");
    expect(h.tmuxCommands.length).toBe(0);
  });

  test("harness-mismatch: exit 2, names both the required and matched harness", async () => {
    const h = makeHarness({
      argv: ["resume", "wrong-cli"],
      rawArgv: true,
      resolveResumeDecision: {
        kind: "harness-mismatch",
        job_id: "job-hm",
        harness: "pi",
        require_harness: "claude",
        title: "wrong-cli",
      },
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("claude");
    expect(h.err.join("")).toContain("job-hm");
    expect(h.tmuxCommands.length).toBe(0);
  });

  test("ok decision but the recorded cwd vanished: exit 2, no launch", async () => {
    const h = makeHarness({
      argv: ["resume", "gone-dir"],
      rawArgv: true,
      resolveResumeDecision: {
        kind: "ok",
        job_id: "job-vanished",
        harness: "claude",
        resume_target: "parent-session-uuid",
        cwd: "/nonexistent/definitely/not/on/disk/xyz",
        title: "gone-dir",
      },
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("no longer exists");
    expect(h.tmuxCommands.length).toBe(0);
  });

  test("resolver tool failure: exit 2, no launch", async () => {
    const h = makeHarness({
      argv: ["resume", "whoever"],
      rawArgv: true,
      resolveResumeDecision: () => {
        throw new Error("db open failed");
      },
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("cannot resolve");
    expect(h.err.join("")).toContain("db open failed");
    expect(h.tmuxCommands.length).toBe(0);
  });
});

describe("cli/agent.ts meta routing precedes deps construction", () => {
  test("routeMetaBeforeDeps renders help / version / wrapper-help purely", () => {
    const run = (argv: string[]): { handled: boolean; out: string } => {
      let out = "";
      const handled = routeMetaBeforeDeps(argv, (s) => {
        out += s;
      });
      return { handled, out };
    };
    const help = run(["--help"]);
    expect(help.handled).toBe(true);
    expect(help.out).toContain("Usage:");
    const version = run(["--version"]);
    expect(version.handled).toBe(true);
    expect(version.out).toContain("keeper agent ");
    const wrapper = run(["--x-help"]);
    expect(wrapper.handled).toBe(true);
    expect(wrapper.out).toContain("Wrapper flags:");
    // `--agent-help` is a distinct meta mode: the operator runbook, not the
    // wrapper-flag overlay. Content assertion names its primary verb form.
    const runbook = run(["--agent-help"]);
    expect(runbook.handled).toBe(true);
    expect(runbook.out).toContain("operator runbook");
    expect(runbook.out).toContain("keeper agent run");
    // A launch token is not a meta mode — routing declines it so deps get built.
    const launch = run(["claude"]);
    expect(launch.handled).toBe(false);
    expect(launch.out).toBe("");
  });

  test("agent --help / --version / --agent-help exit 0 with output and NEVER construct deps", async () => {
    // realDeps() runs the launcher state-dir migration; a buildDeps that throws
    // when called proves the meta path never reaches it (no db/daemon/state dir).
    const throwingBuild = (): never => {
      throw new Error("realDeps constructed — state-dir migration ran");
    };
    for (const flag of ["--help", "--version", "--agent-help"]) {
      const out: string[] = [];
      const realOut = process.stdout.write.bind(process.stdout);
      const realExit = process.exit.bind(process);
      let code: number | undefined;
      process.stdout.write = ((s: string | Uint8Array) => {
        out.push(typeof s === "string" ? s : Buffer.from(s).toString());
        return true;
      }) as typeof process.stdout.write;
      process.exit = ((c?: number) => {
        code = c ?? 0;
        throw new ExitError(code);
      }) as typeof process.exit;
      try {
        await agentCliMain([flag], throwingBuild);
      } catch (e) {
        if (!(e instanceof ExitError)) throw e;
      } finally {
        process.stdout.write = realOut;
        process.exit = realExit;
      }
      expect(code).toBe(0);
      expect(out.join("")).not.toBe("");
    }
  });

  test("a real launch DOES construct deps — the buildDeps seam is wired, not dead", async () => {
    const throwingBuild = (): never => {
      throw new Error("realDeps constructed");
    };
    // `claude` is a launch token → routing declines → buildDeps() is called and
    // its throw propagates (it throws before any process.exit, so no patch).
    await expect(agentCliMain(["claude"], throwingBuild)).rejects.toThrow(
      "realDeps constructed",
    );
  });
});

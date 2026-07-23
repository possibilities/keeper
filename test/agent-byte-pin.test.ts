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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgentLaunchArgv,
  FINAL_MESSAGE_DIRECTIVE,
  READ_ONLY_DIRECTIVE,
} from "../src/agent/launch-config";
import { launchEnvForAgent } from "../src/agent/launch-handle";
import { main } from "../src/agent/main";
import { buildKeeperAgentLaunchArgv } from "../src/exec-backend";
import {
  expectExit,
  makeHarness,
  runAndCapture,
} from "./helpers/agent-main-harness";

const CSWAP_BIN = "/fake-home/.local/bin/cswap";
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
      CSWAP_BIN,
      "run",
      "1",
      "--share-history",
      "--",
      "hello world",
      "--effort",
      "high",
      "--model",
      "opus",
      "--strict-mcp-config",
      "--teammate-mode",
      "in-process",
      "--settings",
      "/fake-home/code/keeper/plugins/keeper/settings.json",
      "--session-id",
      UUID,
      "--name",
      "proj-001",
    ]);
  });
  test("a Claude required-value option value that looks like --name still generates a session name", async () => {
    const h = makeHarness({
      argv: ["claude", "--add-dir", "--name=handoff::x", "hello"],
      rawArgv: true,
      randomUuid: () => UUID,
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual(
      expect.arrayContaining([
        "--add-dir",
        "--name=handoff::x",
        "--session-id",
        UUID,
        "--name",
        "proj-001",
      ]),
    );
  });
  test("--continue keeps the persisted session (no id/name injected)", async () => {
    const h = makeHarness({
      argv: ["claude", "--continue"],
      rawArgv: true,
      randomUuid: () => UUID,
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      CSWAP_BIN,
      "run",
      "1",
      "--share-history",
      "--",
      "--continue",
      "--strict-mcp-config",
      "--teammate-mode",
      "in-process",
      "--settings",
      "/fake-home/code/keeper/plugins/keeper/settings.json",
    ]);
  });
  test("caller --settings wins over keeper statusline config", async () => {
    const h = makeHarness({
      argv: ["claude", "--settings", "/tmp/custom.json", "hello"],
      rawArgv: true,
      randomUuid: () => UUID,
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toContain("/tmp/custom.json");
    expect(cmd).not.toContain(
      "/fake-home/code/keeper/plugins/keeper/settings.json",
    );
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
      "--thinking",
      "high",
      "--model",
      "glm",
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
 * posture and NO extra `CLAUDE*` env strip. Read-only is prompting-only — the
 * `--read-only` flag never reaches a launched native argv, and the retired
 * tool-strip flags (`--exclude-tools`/`--disallowed-tools`) are emitted nowhere;
 * this is the byte-stability anchor that keeps any of them from leaking onto the
 * managed launch surface.
 */
const POSTURE_FLAGS = [
  "--read-only",
  "--exclude-tools",
  "--disallowed-tools",
] as const;
describe("keeper agent byte-pin — bare launch carries no posture", () => {
  for (const cli of ["claude", "pi"] as const) {
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
/**
 * Positive byte-pins for the `agent run` POSTURE path (the increment this file's
 * negative pins anticipated). `agent run` routes through the shared launch helper,
 * which persists the composed native command in `run.json`. Driving `main()` with
 * a real on-disk transcript lets the launch→wait→show compose complete, so the
 * `run.json` `command` is the exact native argv the detached pane would exec.
 */
const RUN_UUID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "agent-byte-pin-run-"));
}
/** Write a minimal claude transcript so the run's wait-for-stop resolves at once. */
function writeClaudeTranscript(home: string, cwd: string, text: string): void {
  const dir = join(home, ".claude", "projects", cwd.replace(/\//g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${RUN_UUID}.jsonl`),
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "assistant",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text }],
      },
    })}\n`,
  );
}
interface RunCommandOpts {
  readOnly?: boolean;
  system?: string;
  systemFile?: string;
  preset?: string;
  session?: string;
}
/** The native `command` the launch persisted to run.json (`tmux-<uuid>/run.json`). */
async function runCommand(opts: RunCommandOpts = {}): Promise<string[]> {
  const stateDir = tempDir();
  const home = tempDir();
  const cwd = "/fake-home/code/proj";
  writeClaudeTranscript(home, cwd, "done");
  const flags: string[] = [];
  if (opts.readOnly) {
    flags.push("--read-only");
  }
  if (opts.systemFile !== undefined) {
    flags.push("--system-file", opts.systemFile);
  } else if (opts.system !== undefined) {
    flags.push("--system", opts.system);
  }
  if (opts.preset !== undefined) {
    flags.push("--preset", opts.preset);
  }
  if (opts.session !== undefined) {
    flags.push("--session", opts.session);
  }
  const argv = ["run", ...flags, "claude", "say hi"];
  const h = makeHarness({
    argv,
    rawArgv: true,
    launcherStateDir: stateDir,
    transcriptHomeDir: home,
    cwd,
    randomUuid: () => RUN_UUID,
    // A claude default triple lets a bare `agent run claude` clear the fresh-launch
    // gate, which requires the resolved default to supply BOTH model + second axis.
    presetCatalog: {
      presets: {},
      claude_default: { harness: "claude", model: "opus", effort: "high" },
    },
    tmuxCommand: (cmd) =>
      cmd.includes("has-session")
        ? { exitCode: 1, stdout: "", stderr: "no session" }
        : { exitCode: 0, stdout: "keeper agent\x01@1\x01%1\n", stderr: "" },
  });
  await expectExit(main(h.deps));
  const runJson = JSON.parse(
    readFileSync(
      join(stateDir, "tmux-runs", `tmux-${RUN_UUID}`, "run.json"),
      "utf8",
    ),
  ) as {
    command: string[];
  };
  return runJson.command;
}
describe("keeper agent byte-pin — agent run posture", () => {
  test("run --read-only claude: read-only then final-message directive, NO tool strip (prompting-only)", async () => {
    const cmd = await runCommand({ readOnly: true });
    // Read-only is prompting-only — the native command carries NO tool strip.
    expect(cmd).not.toContain("--disallowed-tools");
    expect(cmd).not.toContain("--exclude-tools");
    // Both directives are prepended CALLER-SIDE with a raw `\n\n` join — no
    // `User:` scaffold (agent run has no role framing); read-only leads, the
    // always-on final-message directive follows it, and neither is
    // double-prepended.
    expect(cmd.at(-1)).toBe(
      `${READ_ONLY_DIRECTIVE}\n\n${FINAL_MESSAGE_DIRECTIVE}\n\nsay hi`,
    );
    expect(cmd.filter((t) => t === READ_ONLY_DIRECTIVE).length).toBe(0);
  });
  test("run claude (no --read-only): bare prompt carries the final-message directive only", async () => {
    const cmd = await runCommand();
    expect(cmd).not.toContain("--disallowed-tools");
    expect(cmd.at(-1)).toBe(`${FINAL_MESSAGE_DIRECTIVE}\n\nsay hi`);
    expect(cmd.join("\n")).not.toContain(READ_ONLY_DIRECTIVE);
  });
  test("run --system claude: final-message directive then `System:` block, no --append-system-prompt", async () => {
    const cmd = await runCommand({ system: "be terse" });
    // Uniform caller-side compose: the always-on final-message directive leads,
    // then `System: <text>\n\n<prompt>` at the positional.
    expect(cmd.at(-1)).toBe(
      `${FINAL_MESSAGE_DIRECTIVE}\n\nSystem: be terse\n\nsay hi`,
    );
    // The uniform prepend is user-turn text — the native path is a future upgrade.
    expect(cmd).not.toContain("--append-system-prompt");
    expect(cmd).not.toContain("--append-system-prompt-file");
  });
  test("run --read-only --system claude: read-only → final-message → System → prompt block order", async () => {
    const cmd = await runCommand({ readOnly: true, system: "be terse" });
    expect(cmd.at(-1)).toBe(
      `${READ_ONLY_DIRECTIVE}\n\n${FINAL_MESSAGE_DIRECTIVE}\n\nSystem: be terse\n\nsay hi`,
    );
    expect(cmd).not.toContain("--append-system-prompt");
  });
  test("run --system '' claude: empty-after-trim is a no-op (no System: block)", async () => {
    const cmd = await runCommand({ system: "   " });
    expect(cmd.at(-1)).toBe(`${FINAL_MESSAGE_DIRECTIVE}\n\nsay hi`);
    expect(cmd.join("\n")).not.toContain("System:");
  });
  test("run --system-file claude: file body composes the System: block", async () => {
    const dir = tempDir();
    const path = join(dir, "sys.txt");
    writeFileSync(path, "  from file  \n");
    const cmd = await runCommand({ systemFile: path });
    expect(cmd.at(-1)).toBe(
      `${FINAL_MESSAGE_DIRECTIVE}\n\nSystem: from file\n\nsay hi`,
    );
    expect(cmd).not.toContain("--append-system-prompt");
  });
  test("run --system-file <missing> claude: bad_args exit 2, no launch", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const h = makeHarness({
      argv: ["run", "--system-file", "/no/such/file.txt", "claude", "say hi"],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      cwd,
      randomUuid: () => RUN_UUID,
      tmuxCommand: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    const envelope = JSON.parse(h.out.join("").trim()) as {
      outcome: string;
    };
    expect(envelope.outcome).toBe("bad_args");
  });
});
/**
 * Byte-pins for the `agent run --preset`/`--session` threading. The positive arm
 * confirms the two flags reach the launch as the wrapper flags `--x-preset` /
 * `--x-tmux-session` (session on claude also mints the `KEEPER_TMUX_SESSION` env
 * carrier); the absent arm is the byte-stability regression — no flag, no wrapper
 * token — so a no-`--preset`/`--session` run stays byte-identical.
 */
describe("keeper agent byte-pin — agent run preset/session threading", () => {
  test("buildAgentLaunchArgv carries --x-preset / --x-tmux-session when set", () => {
    const cmd = buildAgentLaunchArgv({
      launcherArgvPrefix: [],
      cli: "claude",
      prompt: "say hi",
      preset: "claude::opus::high",
      session: "panels",
    });
    // The launch triple rides as a launcher flag (keeper agent owns model/effort
    // resolution); the session rides as the tmux grouping flag.
    expect(cmd).toContain("--x-preset");
    expect(cmd[cmd.indexOf("--x-preset") + 1]).toBe("claude::opus::high");
    expect(cmd).toContain("--x-tmux-session");
    expect(cmd[cmd.indexOf("--x-tmux-session") + 1]).toBe("panels");
    // claude's session grouping also mints the tracked-job env carrier.
    expect(cmd).toContain("--x-tmux-env");
    expect(cmd).toContain("KEEPER_TMUX_SESSION=panels");
  });
  test("buildAgentLaunchArgv without preset/session carries NEITHER (absent-flag pin)", () => {
    const cmd = buildAgentLaunchArgv({
      launcherArgvPrefix: [],
      cli: "claude",
      prompt: "say hi",
    });
    expect(cmd).not.toContain("--x-preset");
    expect(cmd).not.toContain("--x-tmux-session");
    expect(cmd.join(" ")).not.toContain("KEEPER_TMUX_SESSION");
  });
  test("agent run --preset threads the launch triple as --x-preset into the launched command", async () => {
    const cmd = await runCommand({ preset: "claude::opus::high" });
    // --x-preset survives into the pane's inner argv (the tmux parser leaves it
    // for the detached re-exec to resolve); --x-tmux-session is consumed into the
    // session grouping, so it is pinned at the buildAgentLaunchArgv level above.
    expect(cmd).toContain("--x-preset");
    expect(cmd[cmd.indexOf("--x-preset") + 1]).toBe("claude::opus::high");
  });
  test("agent run without --preset/--session carries no wrapper posture (regression)", async () => {
    const cmd = await runCommand();
    expect(cmd).not.toContain("--x-preset");
    expect(cmd).not.toContain("--x-tmux-session");
  });
});
/**
 * The `System:`-composed prompt rides as the FINAL positional for EVERY harness
 * (`buildAgentLaunchArgv` places `prompt` last, uniform across claude/codex/pi),
 * and NO native `--append-system-prompt` is minted — the compose is caller-side
 * user-turn text this increment, not a privileged system prompt.
 */
describe("keeper agent byte-pin — System: prompt uniform across harnesses", () => {
  const composed = "System: be terse\n\nsay hi";
  for (const cli of ["claude", "pi"] as const) {
    test(`${cli}: composed prompt is the final positional, no --append-system-prompt`, () => {
      const cmd = buildAgentLaunchArgv({
        launcherArgvPrefix: [],
        cli,
        prompt: composed,
      });
      expect(cmd.at(-1)).toBe(composed);
      expect(cmd).not.toContain("--append-system-prompt");
      expect(cmd).not.toContain("--append-system-prompt-file");
    });
  }
});
/**
 * `agent run codex`/`pi` launch with `CLAUDE*` stripped by default (the
 * agent-conditional partner-isolation scrub — a new-verb improvement, pinned so a
 * drift doesn't read as accidental). The scrub is an env-OBJECT transform, not an
 * argv token: the launch script env is whitelisted, so the only meaningful
 * observation point is `launchEnvForAgent` — the exact function the run launch
 * feeds its env through. claude keeps the full inherited env.
 */
describe("keeper agent byte-pin — agent run env scrub", () => {
  const env = { PATH: "/usr/bin", CLAUDE_CODE_X: "leak", ANTHROPIC_X: "kept" };
  for (const agent of ["pi"] as const) {
    test(`run ${agent} drops CLAUDE* carriers, keeps the rest`, () => {
      const out = launchEnvForAgent(agent, env);
      expect(out.CLAUDE_CODE_X).toBeUndefined();
      expect(out.PATH).toBe("/usr/bin");
      // Future-hardening note: only CLAUDE* is stripped today (ANTHROPIC*/*_API_KEY
      // are a separate, deliberate change) — pin the current contract.
      expect(out.ANTHROPIC_X).toBe("kept");
    });
  }
  test("run claude keeps the full inherited env (no scrub)", () => {
    expect(launchEnvForAgent("claude", env)).toBe(env);
  });
});

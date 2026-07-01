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
import { launchEnvForAgent } from "../src/agent/launch-handle";
import { main } from "../src/agent/main";
import { buildKeeperAgentLaunchArgv } from "../src/exec-backend";
import { buildPairLaunchArgv, READ_ONLY_DIRECTIVE } from "../src/pair-command";
import {
  expectExit,
  makeHarness,
  runAndCapture,
} from "./helpers/agent-main-harness";

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
      "--settings",
      "/fake-home/.config/keeper/agent-statusline-settings.json",
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
      "--settings",
      "/fake-home/.config/keeper/agent-statusline-settings.json",
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
  const argv = ["run", ...flags, "claude", "say hi"];
  const h = makeHarness({
    argv,
    rawArgv: true,
    launcherStateDir: stateDir,
    transcriptHomeDir: home,
    cwd,
    randomUuid: () => RUN_UUID,
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
  ) as { command: string[] };
  return runJson.command;
}

describe("keeper agent byte-pin — agent run posture", () => {
  test("run --read-only claude: directive prepended + edit-tool strip present", async () => {
    const cmd = await runCommand({ readOnly: true });
    // The claude read-only strip reaches the native command.
    expect(cmd).toContain("--disallowed-tools");
    expect(cmd).toContain("Edit,Write,NotebookEdit");
    // The directive is prepended CALLER-SIDE with a raw `\n\n` join — no `User:`
    // scaffold (agent run has no role framing), and NOT double-prepended.
    expect(cmd.at(-1)).toBe(`${READ_ONLY_DIRECTIVE}\n\nsay hi`);
    expect(cmd.filter((t) => t === READ_ONLY_DIRECTIVE).length).toBe(0);
  });

  test("run claude (no --read-only): bare prompt, no strip, no directive", async () => {
    const cmd = await runCommand();
    expect(cmd).not.toContain("--disallowed-tools");
    expect(cmd.at(-1)).toBe("say hi");
    expect(cmd.join("\n")).not.toContain(READ_ONLY_DIRECTIVE);
  });

  test("run --system claude: `System:` block prepended, no --append-system-prompt", async () => {
    const cmd = await runCommand({ system: "be terse" });
    // Uniform caller-side compose: `System: <text>\n\n<prompt>` at the positional.
    expect(cmd.at(-1)).toBe("System: be terse\n\nsay hi");
    // The uniform prepend is user-turn text — the native path is a future upgrade.
    expect(cmd).not.toContain("--append-system-prompt");
    expect(cmd).not.toContain("--append-system-prompt-file");
  });

  test("run --read-only --system claude: directive → System → prompt block order", async () => {
    const cmd = await runCommand({ readOnly: true, system: "be terse" });
    expect(cmd.at(-1)).toBe(
      `${READ_ONLY_DIRECTIVE}\n\nSystem: be terse\n\nsay hi`,
    );
    expect(cmd).not.toContain("--append-system-prompt");
  });

  test("run --system '' claude: empty-after-trim is a no-op (no System: block)", async () => {
    const cmd = await runCommand({ system: "   " });
    expect(cmd.at(-1)).toBe("say hi");
    expect(cmd.join("\n")).not.toContain("System:");
  });

  test("run --system-file claude: file body composes the System: block", async () => {
    const dir = tempDir();
    const path = join(dir, "sys.txt");
    writeFileSync(path, "  from file  \n");
    const cmd = await runCommand({ systemFile: path });
    expect(cmd.at(-1)).toBe("System: from file\n\nsay hi");
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
 * The `System:`-composed prompt rides as the FINAL positional for EVERY harness
 * (`buildPairLaunchArgv` places `prompt` last, uniform across claude/codex/pi),
 * and NO native `--append-system-prompt` is minted — the compose is caller-side
 * user-turn text this increment, not a privileged system prompt.
 */
describe("keeper agent byte-pin — System: prompt uniform across harnesses", () => {
  const composed = "System: be terse\n\nsay hi";
  for (const cli of ["claude", "codex", "pi"] as const) {
    test(`${cli}: composed prompt is the final positional, no --append-system-prompt`, () => {
      const cmd = buildPairLaunchArgv({
        launcherArgvPrefix: [],
        cli,
        prompt: composed,
        readOnly: false,
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

  for (const agent of ["codex", "pi"] as const) {
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

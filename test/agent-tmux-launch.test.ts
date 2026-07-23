import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/agent/main";
import {
  collectUnsettledPanelRunIds,
  launchKeeperAgentInTmux,
  parseKeeperAgentTmuxArgs,
  resolveKeeperAgentBin,
  resolveTmuxBin,
  selectRunDirsToSweep,
  sweepRunArtifacts,
  TMUX_EXIT,
  TmuxLaunchError,
  type TmuxLaunchRequest,
  tmuxSpawnEnv,
} from "../src/agent/tmux-launch";
import { expectExit, makeHarness } from "./helpers/agent-main-harness";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "keeper-agent-tmux-test-"));
}

function writeCodexTranscript(
  home: string,
  cwd: string,
  stopped = false,
): string {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const dir = join(home, ".codex", "sessions", year, month, day);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "rollout-2026-06-22T00-00-00-test.jsonl");
  const lines = [
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "session_meta",
      payload: { id: "codex-session", cwd },
    }),
  ];
  if (stopped) {
    lines.push(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "event_msg",
        payload: { type: "task_complete" },
      }),
    );
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function writeClaudeTranscript(
  home: string,
  cwd: string,
  sessionId: string,
): string {
  const dir = join(home, ".claude", "projects", cwd.replace(/\//g, "-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(
    path,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "assistant",
      message: { role: "assistant", stop_reason: "end_turn" },
    })}\n`,
  );
  return path;
}

function writePiTranscript(
  home: string,
  cwd: string,
  sessionId: string,
): string {
  const encoded = `--${cwd.replace(/^\/+|\/+$/g, "").replace(/\//g, "-")}--`;
  const dir = join(home, ".pi", "agent", "sessions", encoded);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-06-22T00-00-00-000Z_${sessionId}.jsonl`);
  writeFileSync(
    path,
    `${JSON.stringify({
      type: "session",
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd,
    })}\n`,
  );
  return path;
}

function parseJsonOutput(out: string[]): Record<string, unknown> {
  const lastLine = out.join("").trim().split("\n").at(-1);
  if (lastLine === undefined) {
    throw new Error("missing JSON output");
  }
  return JSON.parse(lastLine) as Record<string, unknown>;
}

describe("--x-tmux", () => {
  test("inside tmux, opens a new focused unnamed window and returns metadata", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    writeCodexTranscript(home, cwd);
    const h = makeHarness({
      argv: ["claude", "--x-tmux", "--x-account", "c1", "hello"],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      env: { TMUX: "/tmp/tmux-501/default,1,0", PATH: "/fake/bin" },
      cwd,
      randomUuid: () => "11111111-1111-1111-1111-111111111111",
      tmuxCommand: (cmd) => {
        if (cmd.includes("display-message")) {
          return { exitCode: 0, stdout: "dash\n", stderr: "" };
        }
        if (cmd.includes("has-session")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (cmd.includes("new-window")) {
          return { exitCode: 0, stdout: "dash\x01@9\x01%10\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(0);
    expect(h.spawned).toEqual([]);
    const launchScript = join(
      stateDir,
      "tmux-runs",
      "tmux-11111111-1111-1111-1111-111111111111",
      "launch.sh",
    );
    expect(h.tmuxCommands).toEqual([
      ["tmux", "display-message", "-p", "#{session_name}"],
      ["tmux", "has-session", "-t", "=dash"],
      [
        "tmux",
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{session_name}\x01#{window_id}\x01#{pane_id}",
        "-t",
        "=dash:",
        "-e",
        "KEEPER_AGENT_TMUX_SESSION_ID=11111111-1111-1111-1111-111111111111",
        "-c",
        cwd,
        `exec bash '${launchScript}'`,
      ],
      [
        "tmux",
        "set-option",
        "-p",
        "-t",
        "%10",
        "@keeper_job_id",
        "11111111-1111-1111-1111-111111111111",
      ],
      ["tmux", "select-window", "-t", "@9"],
      ["tmux", "switch-client", "-t", "dash"],
    ]);

    const script = readFileSync(launchScript, "utf8");
    expect(script).toContain("cd -- '/fake-home/code/proj'");
    expect(script).toContain("export PATH='/fake/bin'");
    expect(script).toContain(
      'KEEPER_AGENT_SHELL="' + "$" + "{SHELL:-/bin/sh}" + '"',
    );
    expect(script).toContain(
      `exec "$KEEPER_AGENT_SHELL" -l -i -c '"$@"; __kr=$?; [ "$__kr" -eq 0 ] || printf "\\n[keeper] pane command exited %s - run keeper tabs list for restore state and the rerun command.\\n" "$__kr" >&2; exec "$0" -l -i' "$KEEPER_AGENT_SHELL" '/fake-home/.bun/bin/bun' '/fake-home/code/keeper/cli/keeper.ts' 'agent' 'claude' '--x-account' 'c1' 'hello'`,
    );
    expect(script).not.toContain("--x-tmux");
    // Non-wait launch: one JSON line, transcriptPath null, exits before the poll.
    expect(h.out.join("").trim().split("\n")).toHaveLength(1);
    expect(parseJsonOutput(h.out)).toMatchObject({
      schema_version: 1,
      agent: "claude",
      session: "dash",
      windowId: "@9",
      paneId: "%10",
      transcriptPath: null,
      waitedForStop: false,
      stop: null,
      tmux: { session: "dash", windowId: "@9", paneId: "%10" },
    });
  });

  test("the KEEPER_AGENT_* family forwards into the pane env, but KEEPER_AGENT_PATH is excluded", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    writeCodexTranscript(home, cwd);
    const h = makeHarness({
      argv: ["claude", "--x-tmux", "hello"],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      env: {
        TMUX: "/tmp/tmux-501/default,1,0",
        PATH: "/fake/bin",
        // A family var that ONLY the prefix branch forwards (not in the static
        // key set) — proves the KEEPER_AGENT_* family still crosses.
        KEEPER_AGENT_CLAUDE_PROFILE: "work",
        // The launcher's own re-exec resolution env: shares the family prefix
        // but must NOT cross into the pane.
        KEEPER_AGENT_PATH: "/custom/keeper.ts",
      },
      cwd,
      randomUuid: () => "55555555-5555-5555-5555-555555555555",
      tmuxCommand: (cmd) => {
        if (cmd.includes("display-message")) {
          return { exitCode: 0, stdout: "dash\n", stderr: "" };
        }
        if (cmd.includes("new-window")) {
          return { exitCode: 0, stdout: "dash\x01@9\x01%10\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(0);
    const launchScript = join(
      stateDir,
      "tmux-runs",
      "tmux-55555555-5555-5555-5555-555555555555",
      "launch.sh",
    );
    const script = readFileSync(launchScript, "utf8");
    expect(script).toContain("export KEEPER_AGENT_CLAUDE_PROFILE='work'");
    expect(script).not.toContain("KEEPER_AGENT_PATH");
  });

  test("outside tmux, creates the default session and returns metadata without attaching", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const sessionId = "22222222-2222-2222-2222-222222222222";
    writeClaudeTranscript(home, cwd, sessionId);
    const h = makeHarness({
      argv: ["claude", "--x-tmux", "hello"],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      env: { HOME: "/fake-home" },
      cwd,
      randomUuid: () => sessionId,
      tmuxCommand: (cmd) => {
        if (cmd.includes("has-session")) {
          return { exitCode: 1, stdout: "", stderr: "no session" };
        }
        if (cmd.includes("new-session")) {
          return {
            exitCode: 0,
            stdout: "keeper agent\x01@1\x01%2\n",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(0);
    expect(h.tmuxCommands.map((cmd) => cmd[1])).toEqual([
      "has-session",
      "new-session",
      "set-option",
      "select-window",
    ]);
    const newSession = h.tmuxCommands.find((cmd) =>
      cmd.includes("new-session"),
    );
    expect(newSession?.at(newSession.indexOf("-c") + 1)).toBe("/fake-home");
    expect(h.spawned).toEqual([]);
    expect(parseJsonOutput(h.out)).toMatchObject({
      schema_version: 1,
      agent: "claude",
      session: "keeper agent",
      windowId: "@1",
      paneId: "%2",
      transcriptPath: null,
      waitedForStop: false,
      tmux: { session: "keeper agent", windowId: "@1", paneId: "%2" },
    });
  });

  test("TOCTOU: a 'duplicate session' from a concurrent launch recovers via new-window", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const sessionId = "44444444-4444-4444-4444-444444444444";
    writeClaudeTranscript(home, cwd, sessionId);
    const h = makeHarness({
      argv: ["claude", "--x-tmux", "hello"],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      cwd,
      randomUuid: () => sessionId,
      tmuxCommand: (cmd) => {
        // Session absent at probe time…
        if (cmd.includes("has-session")) {
          return { exitCode: 1, stdout: "", stderr: "no session" };
        }
        // …but a concurrent launch created it before our new-session ran.
        if (cmd.includes("new-session")) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "duplicate session: keeper agent",
          };
        }
        // Recovery: add a window to the now-existing session.
        if (cmd.includes("new-window")) {
          return {
            exitCode: 0,
            stdout: "keeper agent\x01@7\x01%8\n",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(0);
    // probe → new-session (rejected duplicate) → new-window (recovery) → owner stamp → select
    expect(h.tmuxCommands.map((cmd) => cmd[1])).toEqual([
      "has-session",
      "new-session",
      "new-window",
      "set-option",
      "select-window",
    ]);
    expect(parseJsonOutput(h.out)).toMatchObject({
      session: "keeper agent",
      windowId: "@7",
      paneId: "%8",
    });
  });

  test("tmux-like session, socket, window, and detached flags imply tmux launch", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const sessionId = "33333333-3333-3333-3333-333333333333";
    writePiTranscript(home, cwd, sessionId);
    const h = makeHarness({
      argv: [
        "pi",
        "--x-tmux-L",
        "agents",
        "--x-tmux-session=work",
        "--x-tmux-window-name",
        "review",
        "--x-tmux-detached",
        "hello",
      ],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      cwd,
      randomUuid: () => sessionId,
      tmuxCommand: (cmd) => {
        if (cmd.includes("new-window")) {
          return { exitCode: 0, stdout: "work\x01@5\x01%6\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(0);
    expect(h.spawned).toEqual([]);
    expect(h.tmuxCommands[0]).toEqual([
      "tmux",
      "-L",
      "agents",
      "has-session",
      "-t",
      "=work",
    ]);
    expect(h.tmuxCommands[1]?.slice(0, 15)).toEqual([
      "tmux",
      "-L",
      "agents",
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{session_name}\x01#{window_id}\x01#{pane_id}",
      "-t",
      "=work:",
      "-n",
      "review",
      // The pinned transcript session-id carrier is forwarded into the pane so
      // the inner re-exec mints the SAME uuid recorded in run.json.
      "-e",
      `KEEPER_AGENT_TMUX_SESSION_ID=${sessionId}`,
      "-c",
    ]);
    expect(parseJsonOutput(h.out)).toMatchObject({
      schema_version: 1,
      agent: "pi",
      session: "work",
      windowId: "@5",
      paneId: "%6",
      transcriptPath: null,
      waitedForStop: false,
      tmux: { session: "work", windowId: "@5", paneId: "%6" },
    });

    const launchScript = join(
      stateDir,
      "tmux-runs",
      "tmux-33333333-3333-3333-3333-333333333333",
      "launch.sh",
    );
    const script = readFileSync(launchScript, "utf8");
    expect(script).toContain(
      `exec "$KEEPER_AGENT_SHELL" -l -i -c '"$@"; __kr=$?; [ "$__kr" -eq 0 ] || printf "\\n[keeper] pane command exited %s - run keeper tabs list for restore state and the rerun command.\\n" "$__kr" >&2; exec "$0" -l -i' "$KEEPER_AGENT_SHELL" '/fake-home/.bun/bin/bun' '/fake-home/code/keeper/cli/keeper.ts' 'agent' 'pi' 'hello'`,
    );
    expect(script).not.toContain("--x-tmux-L");
  });

  test("a launch records run.json with agent/cwd/session for the subcommands", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const h = makeHarness({
      argv: ["claude", "--x-tmux", "--x-tmux-detached", "hello"],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      cwd,
      randomUuid: () => "abababab-abab-abab-abab-abababababab",
      tmuxCommand: (cmd) => {
        if (cmd.includes("has-session")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (cmd.includes("new-window")) {
          return {
            exitCode: 0,
            stdout: "keeper agent\x01@7\x01%8\n",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(0);
    // The launch JSON carries the handle id and never the (not-yet-known)
    // transcript — reading it is the wait-for-stop / show-last-message job.
    expect(parseJsonOutput(h.out)).toMatchObject({
      schema_version: 1,
      id: "tmux-abababab-abab-abab-abab-abababababab",
      agent: "claude",
      transcriptPath: null,
      waitedForStop: false,
      stop: null,
    });
    // run.json carries what a later subcommand resolves the handle from.
    const runJson = JSON.parse(
      readFileSync(
        join(
          stateDir,
          "tmux-runs",
          "tmux-abababab-abab-abab-abab-abababababab",
          "run.json",
        ),
        "utf8",
      ),
    );
    expect(runJson).toMatchObject({
      agent: "claude",
      cwd,
      lifecycleJobId: "abababab-abab-abab-abab-abababababab",
    });
    expect(typeof runJson.startedAtMs).toBe("number");
  });

  test("missing tmux flag values fail before any tmux command", async () => {
    const h = makeHarness({
      argv: ["claude", "--x-tmux-session"],
      rawArgv: true,
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(2);
    expect(h.tmuxCommands).toEqual([]);
    expect(h.err.join("")).toContain("--x-tmux-session requires a value");
    // Structured JSON error is emitted even on a bad-args exit (Pattern A).
    expect(parseJsonOutput(h.out)).toMatchObject({
      schema_version: 1,
      error: true,
      reason: "bad_args",
      exitCode: 2,
    });
  });

  test("an injected absolute tmux binary threads into every tmux argv", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    writeClaudeTranscript(home, cwd, "44444444-4444-4444-4444-444444444444");
    const h = makeHarness({
      argv: ["claude", "--x-tmux", "hello"],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      cwd,
      randomUuid: () => "44444444-4444-4444-4444-444444444444",
      tmuxBin: "/opt/homebrew/bin/tmux",
      tmuxCommand: (cmd) => {
        if (cmd.includes("has-session")) {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        if (cmd.includes("new-session")) {
          return {
            exitCode: 0,
            stdout: "keeper agent\x01@1\x01%2\n",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(0);
    expect(
      h.tmuxCommands.every((cmd) => cmd[0] === "/opt/homebrew/bin/tmux"),
    ).toBe(true);
  });
});

describe("--x-tmux exit-code taxonomy", () => {
  test("the taxonomy codes are distinct", () => {
    const codes = [
      TMUX_EXIT.INTERNAL,
      TMUX_EXIT.BAD_ARGS,
      TMUX_EXIT.NOOP,
      TMUX_EXIT.RETRYABLE,
    ];
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual([1, 2, 3, 4]);
  });

  test("tmux-not-found exits 3 with a structured prerequisite_missing error", async () => {
    const h = makeHarness({
      argv: ["claude", "--x-tmux-L", "scratch", "hello"],
      rawArgv: true,
      launcherStateDir: tempDir(),
      cwd: "/fake-home/code/proj",
      tmuxCommand: () => {
        throw new TmuxLaunchError(
          "tmux command not found. Install tmux or remove --x-tmux.",
          TMUX_EXIT.NOOP,
        );
      },
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(3);
    expect(h.err.join("")).toContain("tmux command not found");
    expect(parseJsonOutput(h.out)).toMatchObject({
      schema_version: 1,
      error: true,
      reason: "prerequisite_missing",
      exitCode: 3,
    });
  });

  test("a timeout result exits 4 with a structured transient error", async () => {
    const h = makeHarness({
      argv: ["claude", "--x-tmux-L", "scratch", "hello"],
      rawArgv: true,
      launcherStateDir: tempDir(),
      cwd: "/fake-home/code/proj",
      tmuxCommand: (cmd) => {
        if (cmd.includes("has-session")) {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        if (cmd.includes("new-session")) {
          // The runner's timeout sentinel result code.
          return {
            exitCode: 124,
            stdout: "",
            stderr: "tmux command timed out",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(4);
    expect(parseJsonOutput(h.out)).toMatchObject({
      schema_version: 1,
      error: true,
      reason: "transient",
      exitCode: 4,
    });
  });

  test("a pane-owner stamp failure removes the new window and fails the launch", async () => {
    const h = makeHarness({
      argv: ["claude", "--x-tmux-L", "scratch", "hello"],
      rawArgv: true,
      launcherStateDir: tempDir(),
      cwd: "/fake-home/code/proj",
      randomUuid: () => "77777777-7777-7777-7777-777777777777",
      tmuxCommand: (cmd) => {
        if (cmd.includes("has-session")) {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        if (cmd.includes("new-session")) {
          return {
            exitCode: 0,
            stdout: "keeper agent\x01@7\x01%8\n",
            stderr: "",
          };
        }
        if (cmd.includes("set-option")) {
          return { exitCode: 1, stdout: "", stderr: "option failed" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(1);
    expect(h.tmuxCommands.map((cmd) => cmd[3] ?? cmd[1])).toEqual([
      "has-session",
      "new-session",
      "set-option",
      "kill-window",
    ]);
    expect(h.tmuxCommands.at(-1)).toEqual([
      "tmux",
      "-L",
      "scratch",
      "kill-window",
      "-t",
      "@7",
    ]);
    expect(parseJsonOutput(h.out)).toMatchObject({
      schema_version: 1,
      error: true,
      reason: "internal",
      exitCode: 1,
    });
  });

  test("a malformed created-window line exits 1 with a structured internal error", async () => {
    const h = makeHarness({
      argv: ["claude", "--x-tmux-L", "scratch", "hello"],
      rawArgv: true,
      launcherStateDir: tempDir(),
      cwd: "/fake-home/code/proj",
      tmuxCommand: (cmd) => {
        if (cmd.includes("has-session")) {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        if (cmd.includes("new-session")) {
          // Exit 0 but an unparseable target — a parse/internal failure.
          return { exitCode: 0, stdout: "garbage-no-delimiters\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(1);
    expect(parseJsonOutput(h.out)).toMatchObject({
      schema_version: 1,
      error: true,
      reason: "internal",
      exitCode: 1,
    });
  });
});

describe("tmuxSpawnEnv", () => {
  test("defaults LANG/LC_CTYPE/TERM/COLORTERM when absent, spreads the rest", () => {
    const env = tmuxSpawnEnv({ PATH: "/usr/bin", KEEPER_TMUX_PANE: "%7" });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.KEEPER_TMUX_PANE).toBe("%7");
    expect(env.LANG).toBe("C.UTF-8");
    expect(env.LC_CTYPE).toBe("C.UTF-8");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.COLORTERM).toBe("truecolor");
    expect(env.LC_ALL).toBeUndefined();
  });

  test("never sets a global LC_ALL", () => {
    const env = tmuxSpawnEnv({});
    expect(env.LC_ALL).toBeUndefined();
  });

  test("preserves an explicit UTF-8 locale and TERM/COLORTERM", () => {
    const env = tmuxSpawnEnv({
      LANG: "en_GB.UTF-8",
      TERM: "screen-256color",
      COLORTERM: "24bit",
    });

    expect(env.LANG).toBe("en_GB.UTF-8");
    expect(env.LC_CTYPE).toBeUndefined();
    expect(env.TERM).toBe("screen-256color");
    expect(env.COLORTERM).toBe("24bit");
  });

  test("defaults locale and drops a non-UTF-8 LC_ALL (C/POSIX)", () => {
    const env = tmuxSpawnEnv({ LANG: "C", LC_ALL: "POSIX" });

    // A non-UTF-8 LC_ALL would override the CTYPE category, so it is dropped
    // (not set) and CTYPE/LANG are pinned to UTF-8 so the delimiter survives.
    expect(env.LC_ALL).toBeUndefined();
    expect(env.LC_CTYPE).toBe("C.UTF-8");
    expect(env.LANG).toBe("C.UTF-8");
  });

  test("preserves a UTF-8 LC_ALL", () => {
    const env = tmuxSpawnEnv({ LC_ALL: "en_US.UTF-8", LANG: "C" });

    expect(env.LC_ALL).toBe("en_US.UTF-8");
    expect(env.LC_CTYPE).toBeUndefined();
    expect(env.LANG).toBe("C");
  });

  test("empty-string locale vars count as unset", () => {
    const env = tmuxSpawnEnv({ LANG: "", LC_CTYPE: "" });
    expect(env.LANG).toBe("C.UTF-8");
    expect(env.LC_CTYPE).toBe("C.UTF-8");
  });
});

describe("resolveKeeperAgentBin", () => {
  test("returns an absolute path unchanged", () => {
    expect(resolveKeeperAgentBin("/abs/keeper", "/cwd")).toBe("/abs/keeper");
  });

  test("resolves a relative path against the invocation cwd", () => {
    expect(resolveKeeperAgentBin("./bin/keeper.ts", "/Users/x/proj")).toBe(
      "/Users/x/proj/bin/keeper.ts",
    );
  });
});

describe("resolveTmuxBin", () => {
  test("resolves tmux to an absolute path", () => {
    const resolved = resolveTmuxBin(process.env);
    // Either Bun.which found it on PATH, a known dir held it, or (no tmux on
    // this box) the literal fallback. Absolute when found.
    if (resolved !== "tmux") {
      expect(resolved.startsWith("/")).toBe(true);
      expect(resolved.endsWith("/tmux")).toBe(true);
    }
  });

  test("scans the known bin dirs when PATH is stripped", () => {
    // With an empty PATH, Bun.which fails; the known-dir scan finds the real
    // binary if tmux is installed in a standard location.
    const resolved = resolveTmuxBin({ PATH: "" });
    if (resolved !== "tmux") {
      expect(resolved.startsWith("/")).toBe(true);
    }
  });
});

// The `defaultTmuxCommandRunner` real-process timeout-classification scenario
// (`sleep 30` against the 5s spawn floor) is too heavy for the fast tier and has
// manual verification remains available.

describe("parseKeeperAgentTmuxArgs --x-tmux-env", () => {
  test("split and joined forms both parse; repeatable; last-wins per KEY", () => {
    const parsed = parseKeeperAgentTmuxArgs([
      "--x-tmux-env",
      "KEEPER_TMUX_SESSION=probe",
      "--x-tmux-env=KEEPER_DB=/tmp/test.db",
      "--x-tmux-env",
      "KEEPER_TMUX_SESSION=final",
      "hello",
    ]);

    expect(parsed.error).toBeNull();
    expect(parsed.enabled).toBe(true);
    expect(parsed.remainingArgs).toEqual(["hello"]);
    expect(parsed.options.env).toEqual([
      ["KEEPER_TMUX_SESSION", "final"],
      ["KEEPER_DB", "/tmp/test.db"],
    ]);
  });

  test("a value may itself contain '=' (split only on the first)", () => {
    const parsed = parseKeeperAgentTmuxArgs(["--x-tmux-env=FOO=a=b=c"]);

    expect(parsed.error).toBeNull();
    expect(parsed.options.env).toEqual([["FOO", "a=b=c"]]);
  });

  test("a missing '=' is rejected with bad-args", () => {
    const parsed = parseKeeperAgentTmuxArgs(["--x-tmux-env", "NOEQ"]);
    expect(parsed.error).toContain("missing '='");
  });

  test("a malformed key (lowercase / leading digit / dash) is rejected", () => {
    for (const bad of ["foo=1", "1FOO=1", "FO-O=1"]) {
      const parsed = parseKeeperAgentTmuxArgs(["--x-tmux-env", bad]);
      expect(parsed.error).toContain("key must match");
    }
  });

  test("dynamic-linker keys are hard-blocked", () => {
    for (const bad of [
      "LD_PRELOAD=/x.so",
      "DYLD_INSERT_LIBRARIES=/x.dylib",
      "LD_LIBRARY_PATH=/x",
    ]) {
      const parsed = parseKeeperAgentTmuxArgs(["--x-tmux-env", bad]);
      expect(parsed.error).toContain("dynamic-linker");
    }
  });

  test("control chars are stripped from the value", () => {
    const parsed = parseKeeperAgentTmuxArgs([
      "--x-tmux-env",
      "FOO=a\x00b\x1fc\x7fd\te",
    ]);
    expect(parsed.error).toBeNull();
    expect(parsed.options.env).toEqual([["FOO", "abcde"]]);
  });

  test("a trailing --x-tmux-env with no value is rejected", () => {
    const parsed = parseKeeperAgentTmuxArgs(["--x-tmux-env"]);
    expect(parsed.error).toContain("requires a value");
  });
});

describe("--x-tmux-env injection", () => {
  test("injected env reaches the pane via -e on new-window (warm start) and never leaks", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const sessionId = "44444444-4444-4444-4444-444444444444";
    writeCodexTranscript(home, cwd);
    const h = makeHarness({
      argv: [
        "claude",
        "--x-tmux-session=work",
        "--x-tmux-detached",
        "--x-tmux-env",
        "KEEPER_TMUX_SESSION=work",
        "--x-tmux-env=KEEPER_DB=/tmp/t.db",
        "hello",
      ],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      cwd,
      randomUuid: () => sessionId,
      tmuxCommand: (cmd) => {
        if (cmd.includes("has-session")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (cmd.includes("new-window")) {
          return { exitCode: 0, stdout: "work\x01@7\x01%8\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(0);
    const newWindow = h.tmuxCommands.find((cmd) => cmd.includes("new-window"));
    expect(newWindow).toBeDefined();
    expect(newWindow).toContain("-e");
    expect(newWindow).toContain("KEEPER_TMUX_SESSION=work");
    expect(newWindow).toContain("KEEPER_DB=/tmp/t.db");

    const launchScript = join(
      stateDir,
      "tmux-runs",
      `tmux-${sessionId}`,
      "launch.sh",
    );
    const script = readFileSync(launchScript, "utf8");
    expect(script).not.toContain("--x-tmux-env");
    expect(script).not.toContain("KEEPER_TMUX_SESSION=work");
  });

  test("injected env reaches the pane via -e on new-session (cold start)", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const sessionId = "55555555-5555-5555-5555-555555555555";
    writeCodexTranscript(home, cwd);
    const h = makeHarness({
      argv: [
        "claude",
        "--x-tmux-L",
        "scratch",
        "--x-tmux-session=cold",
        "--x-tmux-detached",
        "--x-tmux-env",
        "KEEPER_TMUX_SESSION=cold",
        "hello",
      ],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      cwd,
      randomUuid: () => sessionId,
      tmuxCommand: (cmd) => {
        if (cmd.includes("has-session")) {
          return { exitCode: 1, stdout: "", stderr: "no session" };
        }
        if (cmd.includes("new-session")) {
          return { exitCode: 0, stdout: "cold\x01@1\x01%2\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(0);
    const newSession = h.tmuxCommands.find((cmd) =>
      cmd.includes("new-session"),
    );
    expect(newSession).toBeDefined();
    expect(newSession).toContain("-e");
    expect(newSession).toContain("KEEPER_TMUX_SESSION=cold");
  });

  test("a blocked dynamic-linker env key exits 2 with a structured bad-args error", async () => {
    const h = makeHarness({
      argv: [
        "claude",
        "--x-tmux-L",
        "scratch",
        "--x-tmux-env",
        "LD_PRELOAD=/evil.so",
        "hello",
      ],
      rawArgv: true,
      launcherStateDir: tempDir(),
      cwd: "/fake-home/code/proj",
      tmuxCommand: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(TMUX_EXIT.BAD_ARGS);
    expect(parseJsonOutput(h.out)).toMatchObject({
      schema_version: 1,
      error: true,
      exitCode: 2,
    });
  });
});

describe("selectRunDirsToSweep", () => {
  const HOUR = 60 * 60 * 1_000;
  const now = 1_000 * HOUR;
  const ttl = 24 * HOUR;

  test("sweeps only dirs that are BOTH past-TTL AND not-live", () => {
    const doomed = selectRunDirsToSweep(
      [
        // old + dead -> deleted
        { name: "tmux-old-dead", mtimeMs: now - 30 * HOUR, pidAlive: false },
        // old + unknown pid -> age-only -> deleted
        { name: "tmux-old-unknown", mtimeMs: now - 30 * HOUR, pidAlive: null },
        // old + alive -> kept (liveness wins over age)
        { name: "tmux-old-alive", mtimeMs: now - 30 * HOUR, pidAlive: true },
        // recent -> kept
        { name: "tmux-recent", mtimeMs: now - 1 * HOUR, pidAlive: null },
      ],
      now,
      ttl,
    );

    expect(new Set(doomed)).toEqual(
      new Set(["tmux-old-dead", "tmux-old-unknown"]),
    );
  });

  test("count-cap sweeps the oldest dead overflow, never a live one", () => {
    const candidates = Array.from({ length: 5 }, (_, i) => ({
      name: `tmux-${i}`,
      // all recent (under TTL) so only the cap can sweep them
      mtimeMs: now - i * 60_000,
      pidAlive: false,
    }));
    // Keep at most 2 newest; the 3 oldest dead ones are swept.
    const doomed = selectRunDirsToSweep(candidates, now, ttl, 2);
    expect(new Set(doomed)).toEqual(new Set(["tmux-2", "tmux-3", "tmux-4"]));
  });

  test("a live pid is never swept by the count-cap", () => {
    const candidates = [
      { name: "tmux-newest", mtimeMs: now, pidAlive: false },
      { name: "tmux-mid", mtimeMs: now - 60_000, pidAlive: false },
      { name: "tmux-oldest-alive", mtimeMs: now - 120_000, pidAlive: true },
    ];
    const doomed = selectRunDirsToSweep(candidates, now, ttl, 1);
    expect(new Set(doomed)).toEqual(new Set(["tmux-mid"]));
  });

  test("an unresolved Panel cleanup pin wins over both TTL and count limits", () => {
    const doomed = selectRunDirsToSweep(
      [
        {
          name: "tmux-panel-owned",
          mtimeMs: now - 100 * HOUR,
          pidAlive: false,
          panelCleanupPinned: true,
        },
        { name: "tmux-recent", mtimeMs: now, pidAlive: false },
      ],
      now,
      ttl,
      1,
    );
    expect(doomed).toEqual([]);
  });
});

describe("sweepRunArtifacts", () => {
  const HOUR = 60 * 60 * 1_000;

  function makeRunDir(root: string, name: string, ageMs: number): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "launch.sh"), "#!/usr/bin/env bash\n");
    writeFileSync(
      join(dir, "run.json"),
      JSON.stringify({ id: name, pid: null }),
    );
    const past = (Date.now() - ageMs) / 1000;
    // backdate so the age gate can fire
    utimesSync(dir, past, past);
    return dir;
  }

  test("deletes only old dirs, keeps recent, and ignores non-children", () => {
    const root = join(tempDir(), "tmux-runs");
    mkdirSync(root, { recursive: true });
    const oldDir = makeRunDir(root, "tmux-old", 30 * HOUR);
    const recentDir = makeRunDir(root, "tmux-recent", 1 * HOUR);
    // A non-prefixed sibling must never be touched.
    const stranger = join(root, "not-a-run");
    mkdirSync(stranger, { recursive: true });

    sweepRunArtifacts(root, Date.now());

    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(recentDir)).toBe(true);
    expect(existsSync(stranger)).toBe(true);
  });

  test("a missing root is a no-op (best-effort)", () => {
    expect(() =>
      sweepRunArtifacts(join(tempDir(), "does-not-exist"), Date.now()),
    ).not.toThrow();
  });

  test("Panel-owned run artifacts stay pinned until cleanup settles, then release", () => {
    const state = tempDir();
    const panels = join(state, "panels");
    const panelDir = join(panels, "request-a");
    const runs = join(state, "tmux-runs");
    const runId = "tmux-panel-run";
    const runDir = makeRunDir(runs, runId, 30 * HOUR);
    mkdirSync(panelDir, { recursive: true });
    const controlPath = join(panelDir, "alpha.control.json");
    writeFileSync(
      controlPath,
      JSON.stringify({
        schema_version: 1,
        run_id: runId,
        agent: "claude",
        started_at_ms: 1,
        kill_window_command: [
          "/opt/tmux",
          "-S",
          "/tmp/panel.sock",
          "kill-window",
          "-t",
          "@9",
        ],
        status: "cancelling",
        owner: { request_id: "req-a", member: "alpha", attempt: 1 },
      }),
    );
    const manifest = {
      dir: panelDir,
      slug: "request-a",
      request_id: "req-a",
      state: "cancelled",
      cleanup_status: "failed",
      members: [
        {
          name: "alpha",
          harness: "claude",
          yaml: join(panelDir, "alpha.yaml"),
          pidfile: join(panelDir, "alpha.pidfile"),
          attempts: [
            {
              attempt: 1,
              yaml: join(panelDir, "alpha.yaml"),
              pidfile: join(panelDir, "alpha.pidfile"),
              startfile: null,
              launched_at: 1,
              state: "cleanup_failed",
              control: {
                path: controlPath,
                request_id: "req-a",
                member: "alpha",
                attempt: 1,
              },
            },
          ],
        },
      ],
    };
    const manifestPath = join(panelDir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const pins = collectUnsettledPanelRunIds(panels);
    expect([...(pins ?? [])]).toEqual([runId]);
    sweepRunArtifacts(runs, Date.now(), pins ?? new Set());
    expect(existsSync(runDir)).toBe(true);

    writeFileSync(controlPath, "{}\n");
    expect(collectUnsettledPanelRunIds(panels)).toBeNull();
    expect(existsSync(runDir)).toBe(true);

    writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, cleanup_status: "settled" }),
    );
    const released = collectUnsettledPanelRunIds(panels);
    expect([...(released ?? [])]).toEqual([]);
    sweepRunArtifacts(runs, Date.now(), released ?? new Set());
    expect(existsSync(runDir)).toBe(false);
  });
});

describe("--no-artifacts", () => {
  test("suppresses launch.sh/run.json, returns null runDir, still launches", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const sessionId = "66666666-6666-6666-6666-666666666666";
    writeCodexTranscript(home, cwd);
    const h = makeHarness({
      argv: [
        "claude",
        "--x-tmux-L",
        "scratch",
        "--x-tmux-session=work",
        "--x-tmux-detached",
        "--no-artifacts",
        "hello",
      ],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      cwd,
      randomUuid: () => sessionId,
      tmuxCommand: (cmd) => {
        if (cmd.includes("has-session")) {
          return { exitCode: 1, stdout: "", stderr: "no session" };
        }
        if (cmd.includes("new-session")) {
          return { exitCode: 0, stdout: "work\x01@3\x01%4\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(0);
    // No run dir was created on disk.
    expect(existsSync(join(stateDir, "tmux-runs", `tmux-${sessionId}`))).toBe(
      false,
    );
    expect(parseJsonOutput(h.out)).toMatchObject({
      schema_version: 1,
      agent: "claude",
      session: "work",
      windowId: "@3",
      paneId: "%4",
      runDir: null,
      launchScript: null,
      transcriptPath: null,
      waitedForStop: false,
    });

    // The launch command is inlined as `bash -c <body>` carrying the -l -i
    // re-exec semantics, never an `exec bash <launchScript>`.
    const newSession = h.tmuxCommands.find((cmd) =>
      cmd.includes("new-session"),
    );
    expect(newSession).toBeDefined();
    const launchCmd = newSession?.at(-1) ?? "";
    expect(launchCmd).toStartWith("exec bash -c ");
    expect(launchCmd).toContain("-l -i -c");
    expect(launchCmd).toContain("'hello'");
    expect(launchCmd).not.toContain("/launch.sh");
  });

  test("parses --no-artifacts and enables tmux mode", () => {
    const parsed = parseKeeperAgentTmuxArgs(["--no-artifacts", "hello"]);
    expect(parsed.error).toBeNull();
    expect(parsed.enabled).toBe(true);
    expect(parsed.options.noArtifacts).toBe(true);
    expect(parsed.remainingArgs).toEqual(["hello"]);
  });
});

describe("run.json publication is atomic; a failed publish tears down the exact window", () => {
  const RUN_ID = "tmux-abababab-abab-abab-abab-abababababab";

  function launchReq(
    stateDir: string,
    tmuxCommands: string[][],
    fsOverride: Partial<
      Pick<TmuxLaunchRequest, "writeFile" | "renameFile" | "unlinkFile">
    >,
  ): TmuxLaunchRequest {
    return {
      agent: "claude",
      innerArgs: ["hello"],
      options: {
        session: "work",
        windowName: null,
        socketName: "agents",
        socketPath: null,
        detached: true,
        noArtifacts: false,
        env: [],
      },
      env: {},
      cwd: "/work/proj",
      transcriptSessionId: null,
      startedAtMs: 123,
      stateDir,
      tmuxBin: "tmux",
      launcherArgvPrefix: ["/bin/bun", "/code/keeper/cli/keeper.ts", "agent"],
      randomUuid: () => "abababab-abab-abab-abab-abababababab",
      runTmuxCommand: (cmd) => {
        tmuxCommands.push(cmd);
        if (cmd.includes("has-session")) {
          return { exitCode: 1, stdout: "", stderr: "no session" };
        }
        if (cmd.includes("new-session") || cmd.includes("new-window")) {
          return { exitCode: 0, stdout: "work\x01@7\x01%8\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      ...fsOverride,
    };
  }

  function expectPublishFailureTeardown(
    stateDir: string,
    tmuxCommands: string[][],
    thrown: unknown,
  ): void {
    // (c) the caller sees launch_failed: launchToResolvedHandle maps a
    //     TmuxLaunchError to a failed launch → composeRunCapture's launch_failed.
    expect(thrown).toBeInstanceOf(TmuxLaunchError);
    expect((thrown as TmuxLaunchError).exitCode).toBe(TMUX_EXIT.INTERNAL);
    expect((thrown as TmuxLaunchError).message).toContain(
      "failed to publish run metadata",
    );
    // (b) teardown targets EXACTLY the just-created window (@7), never a name sweep.
    const kill = tmuxCommands.find((c) => c.includes("kill-window"));
    expect(kill).toEqual(["tmux", "-L", "agents", "kill-window", "-t", "@7"]);
    // (a) no partial run.json — and no leftover temp file — remains on disk.
    const runDir = join(stateDir, "tmux-runs", RUN_ID);
    expect(existsSync(join(runDir, "run.json"))).toBe(false);
    expect(readdirSync(runDir).some((f) => f.includes(".tmp"))).toBe(false);
  }

  test("a WRITE failure kills the exact just-created window and leaves no partial run.json", () => {
    const stateDir = tempDir();
    const tmuxCommands: string[][] = [];
    // The temp-file write itself fails after the window is up.
    const req = launchReq(stateDir, tmuxCommands, {
      writeFile: () => {
        throw new Error("disk full");
      },
    });

    let thrown: unknown;
    try {
      launchKeeperAgentInTmux(req);
    } catch (err) {
      thrown = err;
    }
    expectPublishFailureTeardown(stateDir, tmuxCommands, thrown);
  });

  test("a RENAME failure unlinks the temp file, kills the exact window, and fails the launch", () => {
    const stateDir = tempDir();
    const tmuxCommands: string[][] = [];
    // The temp write succeeds (real fs); the atomic rename over run.json fails —
    // the temp file must be unlinked (real fs), so no .tmp litter survives.
    const req = launchReq(stateDir, tmuxCommands, {
      renameFile: () => {
        throw new Error("cross-device rename");
      },
    });

    let thrown: unknown;
    try {
      launchKeeperAgentInTmux(req);
    } catch (err) {
      thrown = err;
    }
    expectPublishFailureTeardown(stateDir, tmuxCommands, thrown);
  });
});

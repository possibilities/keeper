/**
 * Process-layer wiring: the spawn seam receives the composed command, a normal
 * exit propagates the child's code verbatim, and a signal-death path re-raises
 * the real signal (never 128+n). Uses an injected spawn recorder + a throwing
 * exit so no real subprocess or process.exit fires — the DI seam the test-port
 * task records against.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEEPER_AGENT_HELP, USAGE } from "../src/agent/dispatch";
import { main } from "../src/agent/main";
import {
  runPassthrough,
  runWithJobControl,
  type SpawnedChild,
} from "../src/agent/run";
import { expectExit, makeHarness } from "./helpers/agent-main-harness";

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}
const throwingExit = (code: number): never => {
  throw new ExitSignal(code);
};

function fakeChild(opts: {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}): SpawnedChild {
  return {
    exited: Promise.resolve(opts.exitCode ?? 0),
    exitCode: opts.exitCode,
    signalCode: opts.signalCode,
    kill() {},
  };
}

describe("runWithJobControl", () => {
  test("the spawn seam receives the run command", async () => {
    const received: string[][] = [];
    const spawn = (cmd: string[]): SpawnedChild => {
      received.push(cmd);
      return fakeChild({ exitCode: 0, signalCode: null });
    };
    await expect(
      runWithJobControl(["claude", "--print", "hi"], spawn, throwingExit),
    ).rejects.toBeInstanceOf(ExitSignal);
    expect(received[0]).toEqual(["claude", "--print", "hi"]);
  });

  test("a normal exit propagates the child's code", async () => {
    const spawn = (): SpawnedChild =>
      fakeChild({ exitCode: 7, signalCode: null });
    try {
      await runWithJobControl(["claude"], spawn, throwingExit);
      throw new Error("should have exited");
    } catch (e) {
      expect(e).toBeInstanceOf(ExitSignal);
      expect((e as ExitSignal).code).toBe(7);
    }
  });

  test("passes explicit env and cwd through the spawn seam", async () => {
    const env = { PATH: "/fake/bin", KEEPER_JOB_ID: "job-1" };
    const seen: unknown[] = [];
    const spawn = (_cmd: string[], options?: unknown): SpawnedChild => {
      seen.push(options);
      return fakeChild({ exitCode: 0, signalCode: null });
    };
    await expect(
      runWithJobControl(
        ["pi", "--session", "native"],
        spawn,
        throwingExit,
        undefined,
        {
          env,
          cwd: "/repo/pi",
        },
      ),
    ).rejects.toBeInstanceOf(ExitSignal);
    expect(seen).toEqual([{ env, cwd: "/repo/pi" }]);
  });

  test("a zero exit propagates 0", async () => {
    const spawn = (): SpawnedChild =>
      fakeChild({ exitCode: 0, signalCode: null });
    try {
      await runWithJobControl(["claude"], spawn, throwingExit);
    } catch (e) {
      expect((e as ExitSignal).code).toBe(0);
    }
  });

  test("removes its signal listeners after the child exits", async () => {
    const before = process.listenerCount("SIGTERM");
    const spawn = (): SpawnedChild =>
      fakeChild({ exitCode: 0, signalCode: null });
    try {
      await runWithJobControl(["claude"], spawn, throwingExit);
    } catch {
      // expected ExitSignal
    }
    expect(process.listenerCount("SIGTERM")).toBe(before);
    expect(process.listenerCount("SIGINT")).toBe(0);
  });

  test("forwards wrapper SIGTERM and SIGHUP to the foreground child", async () => {
    let release: (() => void) | undefined;
    const exited = new Promise<number>((resolve) => {
      release = () => resolve(0);
    });
    const signals: NodeJS.Signals[] = [];
    const child: SpawnedChild = {
      exited,
      exitCode: 0,
      signalCode: null,
      kill(signal) {
        signals.push(signal);
      },
    };
    const running = runWithJobControl(
      ["pi", "--session", "native-id"],
      () => child,
      throwingExit,
    );

    process.emit("SIGTERM", "SIGTERM");
    process.emit("SIGHUP", "SIGHUP");
    release?.();
    await expect(running).rejects.toBeInstanceOf(ExitSignal);
    expect(signals).toEqual(["SIGTERM", "SIGHUP"]);
  });
});

describe("runPassthrough", () => {
  test("propagates the child's exit code verbatim", async () => {
    const spawn = (): SpawnedChild =>
      fakeChild({ exitCode: 3, signalCode: null });
    try {
      await runPassthrough(["claude", "mcp"], spawn, throwingExit);
    } catch (e) {
      expect((e as ExitSignal).code).toBe(3);
    }
  });
});

describe("agent run proof-window forwarding", () => {
  test("documents one run-wrapper proof-window form in install and CLI help", () => {
    const canonical = "keeper agent run pi --x-codex-pool-proof-window=arm";
    expect(
      readFileSync(join(import.meta.dir, "..", "docs", "install.md"), "utf8"),
    ).toContain(canonical);
    expect(USAGE.replace(/\s+/g, " ")).toContain(canonical);
    expect(KEEPER_AGENT_HELP.replace(/\s+/g, " ")).toContain(canonical);
  });

  test("forwards the documented proof-window flag into the managed Pi argv", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agent-run-proof-state-"));
    const home = mkdtempSync(join(tmpdir(), "agent-run-proof-home-"));
    const cwd = "/fake-home/code/proof";
    const sessionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const sessionsDir = join(home, ".pi", "agent", "sessions", "proof");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, `${sessionId}.jsonl`),
      `${[
        JSON.stringify({ type: "session", id: sessionId, cwd }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "proof complete" }],
          },
        }),
        JSON.stringify({ type: "turn.completed" }),
      ].join("\n")}\n`,
    );
    const h = makeHarness({
      argv: [
        "run",
        "pi",
        "--x-codex-pool-proof-window=arm",
        "--model",
        "openai-codex/gpt-5.4-mini",
        "--effort",
        "high",
        "Call the codex_pool_proof tool exactly once and return its JSON result.",
      ],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      cwd,
      randomUuid: () => sessionId,
      tmuxCommand: (cmd) =>
        cmd.includes("has-session")
          ? { exitCode: 1, stdout: "", stderr: "no session" }
          : {
              exitCode: 0,
              stdout: "keeper agent\u0001@1\u0001%1\n",
              stderr: "",
            },
    });

    expect(await expectExit(main(h.deps))).toBe(0);
    const launch = readFileSync(
      join(stateDir, "tmux-runs", `tmux-${sessionId}`, "launch.sh"),
      "utf8",
    );
    expect(launch).toContain("'--x-codex-pool-proof-window=arm'");
    expect(h.err.join("")).not.toContain("unknown flag");
  });

  test("does not pass arbitrary --x flags through agent run", async () => {
    const h = makeHarness({
      argv: ["run", "pi", "--x-not-a-launcher-flag", "prove routing"],
      rawArgv: true,
    });

    expect(await expectExit(main(h.deps))).toBe(2);
    expect(h.err.join("")).toContain("unknown flag: --x-not-a-launcher-flag");
  });
});

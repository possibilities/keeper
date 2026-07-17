import { describe, expect, test } from "bun:test";
import {
  type CommandResult,
  type RestartBootMarker,
  type RestartDeps,
  runRestart,
} from "../cli/restart";

class ExitError extends Error {
  constructor(
    readonly code: number,
    readonly output: string,
  ) {
    super(`exit ${code}`);
  }
}

function restartHarness(inputs: {
  kickstart: CommandResult;
  latestBoot: RestartBootMarker | null;
  timeoutMs?: number;
}) {
  let now = 0;
  let bootReads = 0;
  const stdout: string[] = [];
  const deps: RestartDeps = {
    runLaunchctl: async (args) => {
      if (args[0] === "kickstart") return inputs.kickstart;
      return { exitCode: 0, stdout: "state = running", stderr: "" };
    },
    probeHealth: async () => true,
    readLatestBoot: async () => {
      bootReads += 1;
      return bootReads === 1
        ? { boot_id: "boot-before", ts: 100 }
        : inputs.latestBoot;
    },
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
    random: () => 0.5,
    uid: () => 501,
    writeStdout: (text) => stdout.push(text),
    writeStderr: () => {},
    exit: (code): never => {
      throw new ExitError(code, stdout.join(""));
    },
  };
  return {
    args: { sock: "/tmp/keeperd.sock", timeoutMs: inputs.timeoutMs ?? 500 },
    deps,
    stdout,
  };
}

async function restartAndCapture(
  args: { sock: string; timeoutMs: number },
  deps: RestartDeps,
): Promise<ExitError> {
  try {
    await runRestart(args, deps);
  } catch (error) {
    if (error instanceof ExitError) return error;
    throw error;
  }
  throw new Error("restart did not exit");
}

describe("keeper daemon restart evidence verdict", () => {
  test("accepts a fresh healthy boot after a nonzero kickstart and reports its warning", async () => {
    const longStdout = "x".repeat(4_100);
    const h = restartHarness({
      kickstart: {
        exitCode: 17,
        stdout: longStdout,
        stderr: " launchctl said no ",
        timedOut: true,
      },
      latestBoot: { boot_id: "boot-after", ts: 200 },
    });

    const exit = await restartAndCapture(h.args, h.deps);

    expect(exit.code).toBe(0);
    expect(JSON.parse(h.stdout.join(""))).toEqual({
      schema_version: 1,
      ok: true,
      error: null,
      data: {
        domain: "gui/501/arthack.keeperd",
        healthy_probes: 3,
        kickstart_warning: {
          exit_code: 17,
          stdout: `${"x".repeat(4_084)}…[truncated]`,
          stderr: "launchctl said no",
          timed_out: true,
        },
      },
    });
  });

  test("retains failed kickstart output when no fresh boot appears by the deadline", async () => {
    const h = restartHarness({
      kickstart: {
        exitCode: 9,
        stdout: "launchctl output",
        stderr: "launchctl error",
      },
      latestBoot: { boot_id: "boot-before", ts: 100 },
      timeoutMs: 400,
    });

    const exit = await restartAndCapture(h.args, h.deps);

    expect(exit.code).toBe(1);
    expect(JSON.parse(h.stdout.join(""))).toEqual({
      schema_version: 1,
      ok: false,
      error: {
        code: "kickstart-failed",
        message: "launchd could not restart the keeper daemon.",
        recovery:
          "Confirm the LaunchAgent is bootstrapped, then retry. Plist edits require launchctl bootout plus bootstrap, not kickstart.",
        details: {
          kickstart_warning: {
            exit_code: 9,
            stdout: "launchctl output",
            stderr: "launchctl error",
            timed_out: false,
          },
        },
      },
      data: null,
    });
  });

  test("keeps a zero-status kickstart success free of a warning", async () => {
    const h = restartHarness({
      kickstart: { exitCode: 0, stdout: "unused", stderr: "unused" },
      latestBoot: { boot_id: "boot-after", ts: 200 },
    });

    const exit = await restartAndCapture(h.args, h.deps);

    expect(exit.code).toBe(0);
    expect(JSON.parse(h.stdout.join(""))).toEqual({
      schema_version: 1,
      ok: true,
      error: null,
      data: {
        domain: "gui/501/arthack.keeperd",
        healthy_probes: 3,
      },
    });
  });
});

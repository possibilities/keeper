import { describe, expect, test } from "bun:test";
import {
  type CommandResult,
  DEFAULT_RESTART_TIMEOUT_MS,
  parseRestartArgs,
  REQUIRED_HEALTHY_PROBES,
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

function harness(inputs: {
  probes: boolean[];
  prints?: CommandResult[];
  timeoutMs?: number;
}) {
  let now = 0;
  const stdout: string[] = [];
  const calls: string[][] = [];
  let probeIndex = 0;
  let preProbed = false;
  let printIndex = 0;
  let bootReadCount = 0;
  const oldIdentity = {
    boot_id: "before-restart",
    pid: 101,
    start_time: "darwin:before",
  };
  const nextIdentity = {
    boot_id: "after-restart",
    pid: 202,
    start_time: "darwin:after",
  };
  const deps: RestartDeps = {
    runLaunchctl: async (args) => {
      calls.push(args);
      if (args[0] === "kickstart")
        return { exitCode: 0, stdout: "", stderr: "" };
      return (
        inputs.prints?.[printIndex++] ?? {
          exitCode: 0,
          stdout: "state = running",
          stderr: "",
        }
      );
    },
    probeHealth: async () => {
      if (!preProbed) {
        preProbed = true;
        return {
          status: "served",
          identity: oldIdentity,
          healthy: true,
          catching_up: false,
        };
      }
      const healthy =
        inputs.probes[probeIndex++] ?? inputs.probes.at(-1) ?? false;
      return healthy
        ? {
            status: "served",
            identity: nextIdentity,
            healthy: true,
            catching_up: false,
          }
        : { status: "unavailable", diagnostic: "refused" };
    },
    readBootLedger: async () => ({
      status: "readable",
      boots:
        bootReadCount++ === 0
          ? [{ ...oldIdentity, ts: 1 }]
          : [
              { ...oldIdentity, ts: 1 },
              { ...nextIdentity, ts: 2 },
            ],
    }),
    classifyOldProcess: async () => "dead" as const,
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
    random: () => 0.5,
    uid: () => 501,
    writeStdout: (text) => stdout.push(text),
    writeStderr: () => {},
    exit: (code) => {
      throw new ExitError(code, stdout.join(""));
    },
  };
  return {
    deps,
    calls,
    stdout,
    args: {
      sock: "/tmp/keeperd.sock",
      timeoutMs: inputs.timeoutMs ?? DEFAULT_RESTART_TIMEOUT_MS,
    },
  };
}

describe("keeper daemon restart", () => {
  test("requires consecutive healthy caught-up probes after kickstart", async () => {
    const h = harness({ probes: [true, false, true, true, true] });
    let caught: unknown;
    try {
      await runRestart(h.args, h.deps);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExitError);
    expect((caught as ExitError).code).toBe(0);
    expect(h.calls[0]).toEqual(["kickstart", "-k", "gui/501/arthack.keeperd"]);
    const envelope = JSON.parse(h.stdout.join(""));
    expect(envelope.ok).toBe(true);
    expect(envelope.data.proof_path).toBe("exact-replacement");
    expect(envelope.data.healthy_probes).toBeGreaterThanOrEqual(
      REQUIRED_HEALTHY_PROBES,
    );
  });

  test("treats refused probes during replacement as transient", async () => {
    const h = harness({ probes: [false, false, true, true, true] });
    let caught: unknown;
    try {
      await runRestart(h.args, h.deps);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExitError);
    expect((caught as ExitError).code).toBe(0);
    expect(h.calls.filter((call) => call[0] === "print")).toHaveLength(2);
  });

  test("reports a launchd throttle separately", async () => {
    const h = harness({
      probes: [false],
      timeoutMs: 500,
      prints: [
        {
          exitCode: 0,
          stdout: "state = waiting\nreason = throttle",
          stderr: "",
        },
      ],
    });
    let caught: unknown;
    try {
      await runRestart(h.args, h.deps);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExitError);
    expect((caught as ExitError).code).toBe(1);
    expect(JSON.parse(h.stdout.join(""))).toMatchObject({
      ok: false,
      error: { code: "throttled-respawn" },
    });
  });

  test("enforces the overall restart bound", async () => {
    const h = harness({ probes: [false, false, false], timeoutMs: 150 });
    let caught: unknown;
    try {
      await runRestart(h.args, h.deps);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExitError);
    expect((caught as ExitError).code).toBe(1);
    expect(JSON.parse(h.stdout.join(""))).toMatchObject({
      ok: false,
      error: { code: "health-timeout" },
    });
  });

  test("parses the restart verb without opening a database", () => {
    expect(
      parseRestartArgs(["restart", "--timeout", "2m", "--sock", "/tmp/x"]),
    ).toEqual({
      ok: true,
      args: { timeoutMs: 120_000, sock: "/tmp/x" },
    });
  });
});

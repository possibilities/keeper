import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommandResult,
  DEFAULT_RESTART_TIMEOUT_MS,
  isCaughtUpFrame,
  KICKSTART_TIMEOUT_MS,
  type RestartBootMarker,
  type RestartDeps,
  readLatestBoot,
  runRestart,
} from "../cli/restart";

describe("isCaughtUpFrame", () => {
  test("a steady-state memo result frame with no boot header is caught up", () => {
    // The live serve shape: pre-serialized memo lines carry no boot header and
    // ride only at steady state.
    expect(
      isCaughtUpFrame({
        type: "result",
        // biome-ignore lint/suspicious/noExplicitAny: mirrors the wire frame's extra keys
      } as any),
    ).toBe(true);
  });

  test("a result frame positively catching up is not caught up", () => {
    expect(
      isCaughtUpFrame({ type: "result", boot: { catching_up: true } }),
    ).toBe(false);
  });

  test("a result frame with catching_up false is caught up", () => {
    expect(
      isCaughtUpFrame({ type: "result", boot: { catching_up: false } }),
    ).toBe(true);
  });

  test("a non-result frame never reads caught up", () => {
    expect(isCaughtUpFrame({ type: "error" })).toBe(false);
    expect(isCaughtUpFrame({})).toBe(false);
  });
});

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

describe("readLatestBoot", () => {
  const KEY = "KEEPER_RESTART_LEDGER";

  test("uses the override, skips non-boots and torn lines, and returns the last valid boot", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "keeper-restart-cli-ledger-"));
    const saved = process.env[KEY];
    const ledgerPath = join(tempDir, "restart-ledger.json");
    process.env[KEY] = ledgerPath;
    try {
      writeFileSync(
        ledgerPath,
        [
          JSON.stringify({ kind: "boot", boot_id: "boot-first", ts: 100 }),
          JSON.stringify({ kind: "death", boot_id: "boot-ignored", ts: 150 }),
          JSON.stringify({ kind: "boot", boot_id: "boot-second", ts: 200 }),
          '{"kind":"boot","boot_id":"torn',
        ].join("\n"),
      );

      await expect(readLatestBoot()).resolves.toEqual({
        boot_id: "boot-second",
        ts: 200,
      });

      process.env[KEY] = join(tempDir, "missing-restart-ledger.json");
      await expect(readLatestBoot()).resolves.toBeNull();
    } finally {
      if (saved === undefined) delete process.env[KEY];
      else process.env[KEY] = saved;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

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

  test("accepts a fresh boot that lands after the healthy-probe window, near the deadline", async () => {
    // Live reproduction: kickstart exits 143 (our own launchctl-kill timeout,
    // empty output), probes are healthy throughout, but the fresh boot row
    // lands only after the three-consecutive-healthy window — during the final
    // backoff before the deadline. The in-loop success check reads the ledger
    // only on a healthy probe, so it never sees the boot; the verdict must
    // still fall through to the final evidence re-check and report success.
    let now = 0;
    const stdout: string[] = [];
    // Boot lands at t=400: after the third healthy probe's ledger read (t=300)
    // but before the t=500 deadline — the exact gap the in-loop check misses.
    const bootLandsAt = 400;
    const deps: RestartDeps = {
      runLaunchctl: async (args) =>
        args[0] === "kickstart"
          ? { exitCode: 143, stdout: "", stderr: "", timedOut: true }
          : { exitCode: 0, stdout: "state = running", stderr: "" },
      probeHealth: async () => true,
      readLatestBoot: async () =>
        now >= bootLandsAt
          ? { boot_id: "boot-after", ts: 200 }
          : { boot_id: "boot-before", ts: 100 },
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

    const exit = await restartAndCapture(
      { sock: "/tmp/keeperd.sock", timeoutMs: 500 },
      deps,
    );

    expect(exit.code).toBe(0);
    expect(JSON.parse(stdout.join(""))).toEqual({
      schema_version: 1,
      ok: true,
      error: null,
      data: {
        domain: "gui/501/arthack.keeperd",
        healthy_probes: 3,
        kickstart_warning: {
          exit_code: 143,
          stdout: "",
          stderr: "",
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

  test("reports a health timeout when a successful kickstart has no fresh boot", async () => {
    const h = restartHarness({
      kickstart: { exitCode: 0, stdout: "", stderr: "" },
      latestBoot: { boot_id: "boot-before", ts: 100 },
      timeoutMs: 400,
    });

    const exit = await restartAndCapture(h.args, h.deps);

    expect(exit.code).toBe(1);
    const envelope = JSON.parse(h.stdout.join(""));
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("health-timeout");
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

  test("gives kickstart its own multi-second subprocess budget, not the 1s probe budget", async () => {
    let capturedKickstartTimeout: number | null = null;
    let bootReads = 0;
    const deps: RestartDeps = {
      runLaunchctl: async (args, timeoutMs) => {
        if (args[0] === "kickstart") {
          capturedKickstartTimeout = timeoutMs;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "state = running", stderr: "" };
      },
      probeHealth: async () => true,
      readLatestBoot: async () => {
        bootReads += 1;
        return bootReads === 1
          ? { boot_id: "boot-before", ts: 100 }
          : { boot_id: "boot-after", ts: 200 };
      },
      sleep: async () => {},
      now: () => 0,
      random: () => 0.5,
      uid: () => 501,
      writeStdout: () => {},
      writeStderr: () => {},
      exit: (code): never => {
        throw new ExitError(code, "");
      },
    };

    await restartAndCapture(
      { sock: "/tmp/keeperd.sock", timeoutMs: DEFAULT_RESTART_TIMEOUT_MS },
      deps,
    );

    expect(capturedKickstartTimeout).not.toBeNull();
    expect(capturedKickstartTimeout ?? -1).toBe(KICKSTART_TIMEOUT_MS);
    expect(KICKSTART_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(KICKSTART_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });

  test("a healthy restart shape with a multi-second kickstart and sub-2-minute catch-up succeeds without a kickstart warning", async () => {
    let now = 0;
    let bootReads = 0;
    const stdout: string[] = [];
    // A real kill-and-respawn: kickstart itself takes 12s (well inside the
    // 15s KICKSTART_TIMEOUT_MS budget), then the daemon reports catching_up
    // for 90s of post-boot catch-up (well inside the 150s default deadline
    // and under the acceptance's 2-minute bar).
    const kickstartDurationMs = 12_000;
    const caughtUpAtMs = 90_000;
    const deps: RestartDeps = {
      runLaunchctl: async (args, timeoutMs) => {
        if (args[0] === "kickstart") {
          now += kickstartDurationMs;
          const timedOut = kickstartDurationMs > timeoutMs;
          return {
            exitCode: timedOut ? 143 : 0,
            stdout: "",
            stderr: "",
            timedOut,
          };
        }
        return { exitCode: 0, stdout: "state = running", stderr: "" };
      },
      probeHealth: async () => now >= caughtUpAtMs,
      readLatestBoot: async () => {
        bootReads += 1;
        return bootReads === 1
          ? { boot_id: "boot-before", ts: 100 }
          : { boot_id: "boot-after", ts: 200 };
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

    const exit = await restartAndCapture(
      { sock: "/tmp/keeperd.sock", timeoutMs: DEFAULT_RESTART_TIMEOUT_MS },
      deps,
    );

    expect(exit.code).toBe(0);
    expect(JSON.parse(stdout.join(""))).toEqual({
      schema_version: 1,
      ok: true,
      error: null,
      data: {
        domain: "gui/501/arthack.keeperd",
        healthy_probes: 3,
      },
    });
  });

  test("the same slow-catch-up boot still fails under an explicit short --timeout", async () => {
    let now = 0;
    let bootReads = 0;
    const stdout: string[] = [];
    const kickstartDurationMs = 12_000;
    const caughtUpAtMs = 90_000;
    const deps: RestartDeps = {
      runLaunchctl: async (args, timeoutMs) => {
        if (args[0] === "kickstart") {
          now += kickstartDurationMs;
          const timedOut = kickstartDurationMs > timeoutMs;
          return {
            exitCode: timedOut ? 143 : 0,
            stdout: "",
            stderr: "",
            timedOut,
          };
        }
        return { exitCode: 0, stdout: "state = running", stderr: "" };
      },
      probeHealth: async () => now >= caughtUpAtMs,
      readLatestBoot: async () => {
        bootReads += 1;
        return bootReads === 1
          ? { boot_id: "boot-before", ts: 100 }
          : { boot_id: "boot-after", ts: 200 };
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

    const exit = await restartAndCapture(
      { sock: "/tmp/keeperd.sock", timeoutMs: 10_000 },
      deps,
    );

    expect(exit.code).toBe(1);
    const envelope = JSON.parse(stdout.join(""));
    expect(envelope.ok).toBe(false);
    expect(["kickstart-failed", "health-timeout"]).toContain(
      envelope.error.code,
    );
  });
});

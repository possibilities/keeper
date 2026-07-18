import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommandResult,
  isCaughtUpFrame,
  KICKSTART_TIMEOUT_MS,
  parseRestartHealthFrame,
  type RestartDeps,
  type RestartHealthProbe,
  readLatestBoot,
  readRestartBootLedger,
  runRestart,
} from "../cli/restart";
import type {
  RestartIdentity,
  RestartLedgerSnapshot,
  RestartProcessIdentityState,
} from "../src/restart-observation";

const OLD: RestartIdentity = {
  boot_id: "boot-old",
  pid: 410,
  start_time: "darwin:old",
};
const NEXT: RestartIdentity = {
  boot_id: "boot-next",
  pid: 520,
  start_time: "darwin:next",
};
const THIRD: RestartIdentity = {
  boot_id: "boot-third",
  pid: 630,
  start_time: "darwin:third",
};

function served(
  identity: RestartIdentity,
  catching_up = false,
): RestartHealthProbe {
  return { status: "served", identity, healthy: true, catching_up };
}

function readable(...identities: RestartIdentity[]): RestartLedgerSnapshot {
  return {
    status: "readable",
    boots: identities.map((identity, index) => ({
      ...identity,
      ts: 100 + index * 100,
    })),
  };
}

class ExitError extends Error {
  constructor(
    readonly code: number,
    readonly output: string,
  ) {
    super(`exit ${code}`);
  }
}

interface HarnessOptions {
  kickstart?: CommandResult;
  timeoutMs?: number;
  probe?: (call: number, now: number) => RestartHealthProbe;
  ledger?: (read: number, now: number) => RestartLedgerSnapshot;
  oldProcess?: RestartProcessIdentityState;
  cancelled?: (now: number) => boolean;
}

function restartHarness(options: HarnessOptions = {}) {
  let now = 0;
  let probeCalls = 0;
  let ledgerReads = 0;
  const launchctlCalls: string[][] = [];
  const stdout: string[] = [];
  const deps: RestartDeps = {
    runLaunchctl: async (args) => {
      launchctlCalls.push(args);
      return args[0] === "kickstart"
        ? (options.kickstart ?? { exitCode: 0, stdout: "", stderr: "" })
        : { exitCode: 0, stdout: "state = running", stderr: "" };
    },
    probeHealth: async () => {
      const call = probeCalls++;
      return (
        options.probe?.(call, now) ?? (call === 0 ? served(OLD) : served(NEXT))
      );
    },
    readBootLedger: async () => {
      const read = ledgerReads++;
      return (
        options.ledger?.(read, now) ??
        (read === 0 ? readable(OLD) : readable(OLD, NEXT))
      );
    },
    classifyOldProcess: async () => options.oldProcess ?? "dead",
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
    random: () => 0.5,
    isCancelled: () => options.cancelled?.(now) ?? false,
    uid: () => 501,
    writeStdout: (text) => stdout.push(text),
    writeStderr: () => {},
    exit: (code): never => {
      throw new ExitError(code, stdout.join(""));
    },
  };
  return {
    args: {
      sock: "/tmp/keeperd.sock",
      timeoutMs: options.timeoutMs ?? 30_000,
    },
    deps,
    launchctlCalls,
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

describe("structured restart health", () => {
  test("requires a result frame with exact identity and boolean Drain state", () => {
    expect(
      parseRestartHealthFrame({
        type: "result",
        boot: { ...NEXT, catching_up: false },
      }),
    ).toEqual(served(NEXT));
    expect(isCaughtUpFrame({ type: "result" })).toBe(false);
    expect(
      isCaughtUpFrame({
        type: "result",
        boot: { ...NEXT, catching_up: true },
      }),
    ).toBe(false);
    expect(
      isCaughtUpFrame({
        type: "result",
        boot: { ...NEXT, catching_up: false },
      }),
    ).toBe(true);
    expect(parseRestartHealthFrame({ type: "error" })).toEqual({
      status: "unavailable",
      diagnostic: "non-result response frame",
    });
  });
});

describe("restart ledger reader", () => {
  test("returns full valid boot identities and distinguishes a missing ledger", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "keeper-restart-cli-ledger-"));
    const saved = process.env.KEEPER_RESTART_LEDGER;
    const ledgerPath = join(tempDir, "restart-ledger.json");
    process.env.KEEPER_RESTART_LEDGER = ledgerPath;
    try {
      writeFileSync(
        ledgerPath,
        [
          JSON.stringify({
            kind: "boot",
            ...OLD,
            ts: 100,
            provenance: "launchd",
            prev_runtime_ms: null,
          }),
          JSON.stringify({ kind: "death", boot_id: "ignored", ts: 150 }),
          JSON.stringify({
            kind: "boot",
            ...NEXT,
            ts: 200,
            provenance: "launchd",
            prev_runtime_ms: 100,
          }),
          JSON.stringify({
            kind: "boot",
            boot_id: "legacy-incomplete",
            pid: null,
            start_time: null,
            ts: 300,
          }),
          '{"kind":"boot","boot_id":"torn',
        ].join("\n"),
      );

      await expect(readRestartBootLedger()).resolves.toEqual(
        readable(OLD, NEXT),
      );
      await expect(readLatestBoot()).resolves.toEqual({ ...NEXT, ts: 200 });

      process.env.KEEPER_RESTART_LEDGER = join(tempDir, "missing.json");
      await expect(readRestartBootLedger()).resolves.toEqual({
        status: "missing",
      });
      await expect(readLatestBoot()).resolves.toBeNull();
    } finally {
      if (saved === undefined) delete process.env.KEEPER_RESTART_LEDGER;
      else process.env.KEEPER_RESTART_LEDGER = saved;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("keeper daemon restart evidence verdict", () => {
  test("proves one distinct ledger-backed identity through twelve monotonic seconds", async () => {
    const h = restartHarness();
    const exit = await restartAndCapture(h.args, h.deps);

    expect(exit.code).toBe(0);
    expect(JSON.parse(exit.output)).toEqual({
      schema_version: 1,
      ok: true,
      error: null,
      data: {
        domain: "gui/501/arthack.keeperd",
        identity: NEXT,
        healthy_probes: 12,
        stabilized_for_ms: 12_000,
      },
    });
    expect(
      h.launchctlCalls.filter((args) => args[0] === "kickstart"),
    ).toHaveLength(1);
  });

  test("resets stabilization when the served identity changes", async () => {
    const h = restartHarness({
      timeoutMs: 35_000,
      probe: (call, now) => {
        if (call === 0) return served(OLD);
        return served(now < 6_000 ? NEXT : THIRD);
      },
      ledger: (read) =>
        read === 0 ? readable(OLD) : readable(OLD, NEXT, THIRD),
    });

    const exit = await restartAndCapture(h.args, h.deps);
    expect(exit.code).toBe(0);
    const envelope = JSON.parse(exit.output);
    expect(envelope.data.identity).toEqual(THIRD);
    expect(envelope.data.stabilized_for_ms).toBeGreaterThanOrEqual(12_000);
  });

  test("reports an unstable replacement when the reset run misses the deadline", async () => {
    const h = restartHarness({
      timeoutMs: 13_000,
      probe: (call, now) => {
        if (call === 0) return served(OLD);
        return served(now < 6_000 ? NEXT : THIRD);
      },
      ledger: (read) =>
        read === 0 ? readable(OLD) : readable(OLD, NEXT, THIRD),
    });

    const exit = await restartAndCapture(h.args, h.deps);
    expect(exit.code).toBe(1);
    const envelope = JSON.parse(exit.output);
    expect(envelope.error.code).toBe("restart-unproven");
    expect(envelope.error.details.evidence.reasons).toContainEqual({
      code: "replacement-during-stabilization",
      phase: "stabilization",
    });
  });

  test("retains a bounded kickstart warning only after stronger proof succeeds", async () => {
    const h = restartHarness({
      kickstart: {
        exitCode: 143,
        stdout: "x".repeat(5_000),
        stderr: " launchctl timed out ",
        timedOut: true,
      },
    });

    const exit = await restartAndCapture(h.args, h.deps);
    expect(exit.code).toBe(0);
    const warning = JSON.parse(exit.output).data.kickstart_warning;
    expect(warning).toEqual({
      exit_code: 143,
      stdout: `${"x".repeat(4_084)}…[truncated]`,
      stderr: "launchctl timed out",
      timed_out: true,
    });
    expect(
      h.launchctlCalls.filter((args) => args[0] === "kickstart"),
    ).toHaveLength(1);
  });

  test("cannot succeed while the old recycle-safe identity remains alive", async () => {
    const h = restartHarness({ oldProcess: "alive", timeoutMs: 13_000 });
    const exit = await restartAndCapture(h.args, h.deps);

    expect(exit.code).toBe(1);
    const envelope = JSON.parse(exit.output);
    expect(envelope.error.code).toBe("health-timeout");
    expect(envelope.error.details.evidence.reasons).toContainEqual({
      code: "old-process-still-alive",
      phase: "replacement",
    });
  });

  test("rejects a served identity whose durable row only partially matches", async () => {
    const h = restartHarness({
      timeoutMs: 13_000,
      ledger: (read) =>
        read === 0
          ? readable(OLD)
          : readable(OLD, { ...NEXT, start_time: "darwin:wrong" }),
    });
    const exit = await restartAndCapture(h.args, h.deps);

    expect(exit.code).toBe(1);
    const envelope = JSON.parse(exit.output);
    expect(envelope.error.code).toBe("restart-unproven");
    expect(envelope.error.details.evidence.reasons).toContainEqual({
      code: "durable-boot-mismatched",
      phase: "durable-boot",
    });
  });

  test("reports bounded unreadable-ledger evidence", async () => {
    const h = restartHarness({
      timeoutMs: 1_000,
      ledger: () => ({
        status: "unreadable",
        diagnostic: "E".repeat(10_000),
      }),
    });
    const exit = await restartAndCapture(h.args, h.deps);

    expect(exit.code).toBe(1);
    const envelope = JSON.parse(exit.output);
    expect(envelope.error.code).toBe("restart-unproven");
    expect(envelope.error.details.ledger.length).toBeLessThanOrEqual(512);
    expect(envelope.error.details.evidence.durable_boot.status).toBe(
      "unreadable",
    );
  });

  test("fails honestly when no replacement is ever served", async () => {
    const h = restartHarness({
      timeoutMs: 1_000,
      probe: (call) =>
        call === 0
          ? served(OLD)
          : { status: "unavailable", diagnostic: "connection refused" },
    });
    const exit = await restartAndCapture(h.args, h.deps);

    expect(exit.code).toBe(1);
    const envelope = JSON.parse(exit.output);
    expect(envelope.error.code).toBe("health-timeout");
    expect(envelope.error.details.last_probe).toBe("connection refused");
    expect(envelope.error.details.evidence.replacement.status).toBe("old-gone");
  });

  test("a short deadline cannot borrow elapsed time beyond the deadline", async () => {
    const h = restartHarness({ timeoutMs: 5_000 });
    const exit = await restartAndCapture(h.args, h.deps);

    expect(exit.code).toBe(1);
    const evidence = JSON.parse(exit.output).error.details.evidence;
    expect(evidence.stabilization.status).toBe("deadline-exceeded");
    expect(evidence.stabilization.observed_for_ms).toBeLessThan(12_000);
  });

  test("cancellation returns bounded incomplete evidence without another command", async () => {
    const h = restartHarness({ cancelled: (now) => now >= 700 });
    const exit = await restartAndCapture(h.args, h.deps);

    expect(exit.code).toBe(1);
    const envelope = JSON.parse(exit.output);
    expect(envelope.error.code).toBe("restart-unproven");
    expect(envelope.error.details.cancelled).toBe(true);
    expect(
      h.launchctlCalls.filter((args) => args[0] === "kickstart"),
    ).toHaveLength(1);
  });

  test("gives the one kickstart its bounded multi-second command budget", async () => {
    let captured = 0;
    const h = restartHarness({
      timeoutMs: 20_000,
      cancelled: () => true,
    });
    const original = h.deps.runLaunchctl;
    const deps: RestartDeps = {
      ...h.deps,
      runLaunchctl: async (args, timeoutMs) => {
        if (args[0] === "kickstart") captured = timeoutMs;
        return original(args, timeoutMs);
      },
    };

    await restartAndCapture(h.args, deps);
    expect(captured).toBe(KICKSTART_TIMEOUT_MS);
    expect(captured).toBeGreaterThanOrEqual(10_000);
    expect(
      h.launchctlCalls.filter((args) => args[0] === "kickstart"),
    ).toHaveLength(1);
  });
});

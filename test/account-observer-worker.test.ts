import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ProviderRunOutcome,
  readObservationSidecar,
} from "../src/account-observation";
import {
  AccountObserver,
  type ExactArgvRunner,
  type ObserverClock,
  providerSubprocessEnvironment,
} from "../src/account-observer-worker";
import {
  createFileRecoveryStateStore,
  type RecoveryState,
  type RecoveryStateStore,
} from "../src/account-recovery";
import {
  OBSERVATION_SCHEMA_VERSION,
  observationSidecarPath,
} from "../src/account-routing-config";

const NOW_MS = Date.UTC(2026, 5, 1, 12, 0, 0);
const CSWAP_ARGV = ["CSWAP", "list", "--json"];

function outcome(): ProviderRunOutcome {
  return {
    code: 0,
    stdout: JSON.stringify({
      schemaVersion: 1,
      activeAccountNumber: 3,
      accounts: [
        {
          number: 3,
          usageStatus: "ok",
          usage: {
            fiveHour: { pct: 10 },
            sevenDay: { pct: 5 },
            scoped: [],
          },
          usageAgeSeconds: 15,
        },
      ],
    }),
  };
}

function runnerWithCalls(): { runner: ExactArgvRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: async (argv) => {
      calls.push(argv);
      return outcome();
    },
  };
}

function fakeLock(): { release(): void } {
  return { release() {} };
}

function memoryRecoveryStateStore(): RecoveryStateStore {
  let state: RecoveryState = { schema_version: 1, slots: {} };
  return {
    read: () => structuredClone(state),
    mutate: (update) => {
      const next = structuredClone(state);
      if (update(next)) state = next;
    },
  };
}

describe("AccountObserver", () => {
  test("one cycle fetches cswap and publishes a managed-only current sidecar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-observer-"));
    try {
      const { runner, calls } = runnerWithCalls();
      const observer = new AccountObserver({
        stateDir: dir,
        runner,
        clock: { nowMs: () => NOW_MS, uniform: () => 0, sleep: async () => {} },
        shutdownSignal: new AbortController().signal,
        cswapArgv: CSWAP_ARGV,
        tryAcquireLock: () => fakeLock(),
      });
      await observer.runCycleNoThrow();

      expect(calls).toEqual([CSWAP_ARGV]);
      const observation = readObservationSidecar(observationSidecarPath(dir));
      expect(observation?.schema_version).toBe(OBSERVATION_SCHEMA_VERSION);
      expect(observation?.routes.map((route) => route.id)).toEqual([
        "claude-swap:3",
      ]);
      expect(JSON.stringify(observation)).not.toContain("default");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("publishes list, recovers one expired slot, then publishes forced verification", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-observer-"));
    try {
      const calls: string[][] = [];
      let lists = 0;
      const observer = new AccountObserver({
        stateDir: dir,
        runner: async (argv) => {
          calls.push(argv);
          if (argv[1] === "recover") {
            return {
              code: 0,
              stdout: JSON.stringify({
                schemaVersion: 1,
                operation: "recover",
                accountNumber: 3,
                recoveryStatus: "recovered",
              }),
            };
          }
          lists += 1;
          if (lists <= 2) {
            return {
              code: 0,
              stdout: JSON.stringify({
                schemaVersion: 1,
                accounts: [{ number: 3, usageStatus: "token_expired" }],
              }),
            };
          }
          return outcome();
        },
        clock: { nowMs: () => NOW_MS, uniform: () => 0, sleep: async () => {} },
        shutdownSignal: new AbortController().signal,
        cswapArgv: CSWAP_ARGV,
        cswapBin: "CSWAP",
        tryAcquireLock: () => fakeLock(),
        tryAcquireRecoveryLock: () => fakeLock(),
        recoveryStateStore: memoryRecoveryStateStore(),
      });
      await observer.runCycleNoThrow();
      expect(calls).toEqual([
        CSWAP_ARGV,
        CSWAP_ARGV,
        ["CSWAP", "recover", "3", "--json"],
        CSWAP_ARGV,
      ]);
      expect(
        readObservationSidecar(observationSidecarPath(dir))?.routes[0]?.id,
      ).toBe("claude-swap:3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ordinary refresh-lock contention is a bounded no-op", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-observer-"));
    try {
      let sleeps = 0;
      const observer = new AccountObserver({
        stateDir: dir,
        runner: async () => {
          throw new Error("must not fetch while contended");
        },
        clock: {
          nowMs: () => NOW_MS,
          uniform: () => 0,
          sleep: async () => {
            sleeps += 1;
          },
        },
        shutdownSignal: new AbortController().signal,
        tryAcquireLock: () => null,
        contentionWaitMs: 7,
        contentionTimeoutMs: 7,
        logLine: () => {},
      });
      await observer.runCycleNoThrow();
      expect(sleeps).toBe(1);
      expect(readObservationSidecar(observationSidecarPath(dir))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("held recovery-state lock defers without blocking worker shutdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-observer-"));
    try {
      const controller = new AbortController();
      let calls = 0;
      let stateLockAttempts = 0;
      const observer = new AccountObserver({
        stateDir: dir,
        runner: async () => {
          calls += 1;
          return {
            code: 0,
            stdout: JSON.stringify({
              schemaVersion: 1,
              accounts: [{ number: 3, usageStatus: "token_expired" }],
            }),
          };
        },
        clock: { nowMs: () => NOW_MS, uniform: () => 0, sleep: async () => {} },
        shutdownSignal: controller.signal,
        cswapArgv: CSWAP_ARGV,
        tryAcquireLock: () => fakeLock(),
        tryAcquireRecoveryLock: () => fakeLock(),
        recoveryStateStore: createFileRecoveryStateStore(dir, () => {
          stateLockAttempts += 1;
          return null;
        }),
        logLine: () => {},
      });
      await observer.runCycleNoThrow();
      controller.abort();
      expect(calls).toBe(1);
      expect(stateLockAttempts).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shutdown aborts the in-flight provider call and lets the loop settle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-observer-"));
    try {
      const controller = new AbortController();
      let started: (() => void) | undefined;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      let receivedSignal: AbortSignal | undefined;
      const observer = new AccountObserver({
        stateDir: dir,
        runner: async (_argv, signal) => {
          receivedSignal = signal;
          started?.();
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          return { code: null, stdout: "", failure: "aborted" };
        },
        clock: { nowMs: () => NOW_MS, uniform: () => 0, sleep: async () => {} },
        shutdownSignal: controller.signal,
        cswapArgv: CSWAP_ARGV,
        tryAcquireLock: () => fakeLock(),
        logLine: () => {},
      });
      const running = observer.run();
      await entered;
      controller.abort();
      await running;
      expect(receivedSignal).toBe(controller.signal);
      expect(readObservationSidecar(observationSidecarPath(dir))?.health).toBe(
        "absent",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the loop sleeps after one cycle and exits on shutdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-observer-"));
    try {
      const { runner, calls } = runnerWithCalls();
      const controller = new AbortController();
      const sleepDurations: number[] = [];
      const clock: ObserverClock = {
        nowMs: () => NOW_MS,
        uniform: (lo, hi) => {
          expect(lo).toBe(0);
          expect(hi).toBe(30_000);
          return hi;
        },
        sleep: async (ms) => {
          sleepDurations.push(ms);
          controller.abort();
        },
      };
      const observer = new AccountObserver({
        stateDir: dir,
        runner,
        clock,
        shutdownSignal: controller.signal,
        cswapArgv: CSWAP_ARGV,
        tryAcquireLock: () => fakeLock(),
      });
      await observer.run();
      expect(calls).toHaveLength(1);
      expect(sleepDurations).toEqual([210_000]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("at-risk cadence visibility", () => {
  test("a keeping-up cycle never logs at-risk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-observer-"));
    try {
      const logs: string[] = [];
      const observer = new AccountObserver({
        stateDir: dir,
        runner: runnerWithCalls().runner,
        clock: { nowMs: () => NOW_MS, uniform: () => 0, sleep: async () => {} },
        shutdownSignal: new AbortController().signal,
        cswapArgv: CSWAP_ARGV,
        tryAcquireLock: () => fakeLock(),
        logLine: (line) => logs.push(line),
      });
      await observer.runCycleNoThrow();
      expect(logs).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("at-risk fires once per episode and re-arms after a fresh success", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-observer-"));
    try {
      const logs: string[] = [];
      let contended = true;
      let now = NOW_MS;
      const observer = new AccountObserver({
        stateDir: dir,
        runner: runnerWithCalls().runner,
        clock: { nowMs: () => now, uniform: () => 0, sleep: async () => {} },
        shutdownSignal: new AbortController().signal,
        cswapArgv: CSWAP_ARGV,
        tryAcquireLock: () => (contended ? null : fakeLock()),
        contentionWaitMs: 1,
        contentionTimeoutMs: 1,
        logLine: (line) => logs.push(line),
      });
      const atRisk = (): string[] =>
        logs.filter((line) => line.includes("refresh cadence at risk"));

      // Episode one: repeated contention logs exactly once.
      await observer.runCycleNoThrow();
      await observer.runCycleNoThrow();
      expect(atRisk()).toHaveLength(1);
      expect(atRisk()[0]).toContain("refresh-lock contention");

      // A fresh success clears the episode without logging.
      contended = false;
      await observer.runCycleNoThrow();
      expect(atRisk()).toHaveLength(1);

      // Drifting past the ceiling minus one interval re-arms and logs again.
      contended = true;
      now = NOW_MS + 200_000;
      await observer.runCycleNoThrow();
      expect(atRisk()).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("provider subprocess environment", () => {
  test("copies the inherited environment without mutation", () => {
    const inherited = { PATH: "/test/bin", CUSTOM: "1" };
    const environment = providerSubprocessEnvironment(inherited);
    expect(environment).toEqual(inherited);
    expect(environment).not.toBe(inherited);
  });
});

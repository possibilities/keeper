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
      });
      await observer.runCycleNoThrow();
      expect(sleeps).toBe(1);
      expect(readObservationSidecar(observationSidecarPath(dir))).toBeNull();
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

describe("provider subprocess environment", () => {
  test("copies the inherited environment without mutation", () => {
    const inherited = { PATH: "/test/bin", CUSTOM: "1" };
    const environment = providerSubprocessEnvironment(inherited);
    expect(environment).toEqual(inherited);
    expect(environment).not.toBe(inherited);
  });
});

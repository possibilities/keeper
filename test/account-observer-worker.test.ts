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
  NATIVE_ROUTE_ID,
  observationSidecarPath,
} from "../src/account-routing-config";

const NOW_MS = Date.UTC(2026, 5, 1, 12, 0, 0);
const CLAUDE_ARGV = ["CLAUDE"];
const CODEX_ARGV = ["CODEX"];
const CSWAP_ARGV = ["CSWAP"];

function outcome(provider: string): ProviderRunOutcome {
  if (provider === "claude") {
    return {
      code: 0,
      stdout: JSON.stringify({
        provider,
        usage: { primary: { usedPercent: 20 }, secondary: { usedPercent: 30 } },
      }),
    };
  }
  if (provider === "codex") {
    return {
      code: 0,
      stdout: JSON.stringify([
        {
          provider,
          usage: {
            secondary: { usedPercent: 40 },
            codexResetCredits: { availableCount: 1 },
          },
        },
      ]),
    };
  }
  return {
    code: 0,
    stdout: JSON.stringify({
      schemaVersion: 1,
      accounts: [
        {
          number: 3,
          usageStatus: "ok",
          usage: { fiveHour: { pct: 10 }, sevenDay: { pct: 5 } },
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
      if (argv[0] === "CLAUDE") return outcome("claude");
      if (argv[0] === "CODEX") return outcome("codex");
      return outcome("cswap");
    },
  };
}

function fakeLock(): { release(): void } {
  return { release() {} };
}

describe("AccountObserver", () => {
  test("one cycle uses the shared three-provider refresher and publishes v3", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-observer-"));
    try {
      const { runner, calls } = runnerWithCalls();
      const observer = new AccountObserver({
        stateDir: dir,
        runner,
        clock: { nowMs: () => NOW_MS, uniform: () => 0, sleep: async () => {} },
        shutdownSignal: new AbortController().signal,
        codexbarArgv: CLAUDE_ARGV,
        codexCodexbarArgv: CODEX_ARGV,
        cswapArgv: CSWAP_ARGV,
        tryAcquireLock: () => fakeLock(),
      });
      await observer.runCycleNoThrow();

      expect(calls).toEqual([CLAUDE_ARGV, CODEX_ARGV, CSWAP_ARGV]);
      const observation = readObservationSidecar(observationSidecarPath(dir));
      expect(observation?.schema_version).toBe(3);
      expect(observation?.routes.map((route) => route.id)).toEqual([
        NATIVE_ROUTE_ID,
        "claude-swap:3",
      ]);
      expect(observation?.codex).toMatchObject({
        health: "ok",
        resetCreditsAvailableCount: 1,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ordinary refresh-lock contention is a bounded no-op, not loop death", async () => {
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
        uniform: () => 7,
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
        codexbarArgv: CLAUDE_ARGV,
        codexCodexbarArgv: CODEX_ARGV,
        cswapArgv: CSWAP_ARGV,
        tryAcquireLock: () => fakeLock(),
      });
      await observer.run();
      expect(calls).toHaveLength(3);
      expect(sleepDurations).toEqual([60_007]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("provider subprocess environment", () => {
  test("removes the retired disable flag without mutating input", () => {
    const inherited = {
      PATH: "/test/bin",
      CODEXBAR_DISABLE_KEYCHAIN_ACCESS: "1",
    };
    const environment = providerSubprocessEnvironment(inherited);
    expect(environment).toEqual({ PATH: "/test/bin" });
    expect(environment).not.toBe(inherited);
    expect(inherited.CODEXBAR_DISABLE_KEYCHAIN_ACCESS).toBe("1");
  });
});

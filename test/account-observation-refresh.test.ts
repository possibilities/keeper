import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Observation,
  type ProviderRunOutcome,
  readObservationSidecar,
  writeObservationSidecar,
} from "../src/account-observation";
import {
  type ExactArgvRunner,
  observeOnce,
  type RefreshLock,
  refreshObservationIfStale,
} from "../src/account-observation-refresh";
import {
  cswapListArgv,
  observationSidecarPath,
} from "../src/account-routing-config";

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

function providerOutcome(): ProviderRunOutcome {
  return {
    code: 0,
    stdout: JSON.stringify({
      schemaVersion: 1,
      activeAccountNumber: 2,
      accounts: [
        {
          number: 2,
          usageStatus: "ok",
          usageFetchedAt: new Date(NOW - 1_000).toISOString(),
          usage: { fiveHour: { pct: 20 }, sevenDay: { pct: 30 } },
        },
      ],
    }),
  };
}

function recordingRunner(): { runner: ExactArgvRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: async (argv) => {
      calls.push(argv);
      return providerOutcome();
    },
  };
}

function observation(observedAtMs: number): Observation {
  return {
    schema_version: 4,
    observed_at_ms: observedAtMs,
    health: "ok",
    routes: [
      {
        id: "claude-swap:2",
        kind: "managed",
        slot: 2,
        windows: [{ key: "session", utilization: 0.2, resetsAt: null }],
        measuredAtMs: observedAtMs,
      },
    ],
    claude_accounts: { count: 1, ordinals: { "claude-swap:2": 0 } },
    notes: [],
  };
}

function held(onRelease?: () => void): RefreshLock {
  return { release: onRelease ?? (() => {}) };
}

describe("observeOnce", () => {
  test("makes exactly one cswap list call", async () => {
    const { runner, calls } = recordingRunner();
    const result = await observeOnce({ runner, nowMs: () => NOW });
    expect(calls).toEqual([cswapListArgv()]);
    expect(result.health).toBe("ok");
    expect(result.routes.map((route) => route.id)).toEqual(["claude-swap:2"]);
  });
});

describe("refreshObservationIfStale", () => {
  test("fresh sidecar skips lock acquisition and provider calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-refresh-"));
    try {
      writeObservationSidecar(
        observationSidecarPath(dir),
        observation(NOW - 10),
      );
      const { runner, calls } = recordingRunner();
      let lockAttempts = 0;
      const result = await refreshObservationIfStale({
        stateDir: dir,
        runner,
        nowMs: () => NOW,
        maxAgeMs: 100,
        tryAcquireLock: () => {
          lockAttempts += 1;
          return held();
        },
      });
      expect(result?.observed_at_ms).toBe(NOW - 10);
      expect(lockAttempts).toBe(0);
      expect(calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stale sidecar refreshes once, publishes, and releases", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-refresh-"));
    try {
      writeObservationSidecar(
        observationSidecarPath(dir),
        observation(NOW - 101),
      );
      const { runner, calls } = recordingRunner();
      let releases = 0;
      const result = await refreshObservationIfStale({
        stateDir: dir,
        runner,
        nowMs: () => NOW,
        maxAgeMs: 100,
        tryAcquireLock: () => held(() => releases++),
      });
      expect(calls).toEqual([cswapListArgv()]);
      expect(releases).toBe(1);
      expect(result?.observed_at_ms).toBe(NOW);
      expect(
        readObservationSidecar(observationSidecarPath(dir))?.observed_at_ms,
      ).toBe(NOW);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("double-check under lock observes another publisher and skips fetch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-refresh-"));
    try {
      const path = observationSidecarPath(dir);
      writeObservationSidecar(path, observation(NOW - 1_000));
      const { runner, calls } = recordingRunner();
      let releases = 0;
      const result = await refreshObservationIfStale({
        stateDir: dir,
        runner,
        nowMs: () => NOW,
        maxAgeMs: 100,
        tryAcquireLock: () => {
          writeObservationSidecar(path, observation(NOW));
          return held(() => releases++);
        },
      });
      expect(result?.observed_at_ms).toBe(NOW);
      expect(calls).toEqual([]);
      expect(releases).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("contention re-reads a publication and never fetches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-refresh-"));
    try {
      const path = observationSidecarPath(dir);
      const { runner, calls } = recordingRunner();
      const sleeps: number[] = [];
      const result = await refreshObservationIfStale({
        stateDir: dir,
        runner,
        nowMs: () => NOW,
        maxAgeMs: 100,
        contentionWaitMs: 7,
        tryAcquireLock: () => null,
        sleep: async (ms) => {
          sleeps.push(ms);
          writeObservationSidecar(path, observation(NOW));
        },
      });
      expect(sleeps).toEqual([7]);
      expect(result?.observed_at_ms).toBe(NOW);
      expect(calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("contention deadline returns without fetching", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-refresh-"));
    try {
      const { runner, calls } = recordingRunner();
      const sleeps: number[] = [];
      const result = await refreshObservationIfStale({
        stateDir: dir,
        runner,
        nowMs: () => NOW,
        maxAgeMs: 100,
        contentionWaitMs: 7,
        contentionTimeoutMs: 15,
        tryAcquireLock: () => null,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });
      expect(sleeps).toEqual([7, 7, 1]);
      expect(result).toBeNull();
      expect(calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

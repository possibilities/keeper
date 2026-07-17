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
  claudeCodexBarUsageArgv,
  codexCodexBarUsageArgv,
  cswapListArgv,
  observationSidecarPath,
} from "../src/account-routing-config";

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
const TEST_CODEXBAR_SHA256 = "e".repeat(64);

function providerOutcome(argv: string[]): ProviderRunOutcome {
  const providerIndex = argv.indexOf("--provider");
  const provider = providerIndex >= 0 ? argv[providerIndex + 1] : null;
  if (provider === "claude") {
    return {
      code: 0,
      binary_sha256: TEST_CODEXBAR_SHA256,
      stdout: JSON.stringify([
        {
          provider: "claude",
          usage: {
            primary: { usedPercent: 20 },
            secondary: { usedPercent: 30 },
          },
        },
      ]),
    };
  }
  if (provider === "codex") {
    return {
      code: 0,
      binary_sha256: TEST_CODEXBAR_SHA256,
      stdout: JSON.stringify([
        {
          provider: "codex",
          usage: {
            secondary: { usedPercent: 40 },
            codexResetCredits: { availableCount: 2 },
          },
        },
      ]),
    };
  }
  return {
    code: 0,
    stdout: JSON.stringify({ schemaVersion: 1, accounts: [] }),
  };
}

function recordingRunner(): { runner: ExactArgvRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: async (argv) => {
      calls.push(argv);
      return providerOutcome(argv);
    },
  };
}

function observation(observedAtMs: number): Observation {
  return {
    schema_version: 3,
    codexbar_binary_sha256: null,
    observed_at_ms: observedAtMs,
    health: "ok",
    codex: {
      health: "ok",
      windows: [{ key: "week", utilization: 0.4, resetsAt: null }],
      resetCreditsAvailableCount: 2,
      notes: [],
    },
    routes: [
      {
        id: "default",
        kind: "native",
        slot: null,
        windows: [{ key: "session", utilization: 0.2, resetsAt: null }],
        measuredAtMs: observedAtMs,
      },
    ],
    notes: [],
  };
}

function held(onRelease?: () => void): RefreshLock {
  return { release: onRelease ?? (() => {}) };
}

describe("observeOnce", () => {
  test("makes exactly the Claude, Codex, and cswap argv calls", async () => {
    const { runner, calls } = recordingRunner();
    const result = await observeOnce({ runner, nowMs: () => NOW });
    expect(calls).toEqual([
      claudeCodexBarUsageArgv(),
      codexCodexBarUsageArgv(),
      cswapListArgv(),
    ]);
    expect(result.health).toBe("ok");
    expect(result.codexbar_binary_sha256).toBe(TEST_CODEXBAR_SHA256);
    expect(result.codex).toEqual({
      health: "ok",
      windows: [{ key: "week", utilization: 0.4, resetsAt: null }],
      resetCreditsAvailableCount: 2,
      notes: [],
    });
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

  test("a fresh sidecar rejected by the generation gate refreshes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-refresh-"));
    try {
      writeObservationSidecar(observationSidecarPath(dir), observation(NOW));
      const { runner, calls } = recordingRunner();
      const result = await refreshObservationIfStale({
        stateDir: dir,
        runner,
        nowMs: () => NOW,
        maxAgeMs: 100,
        acceptObservation: (candidate) =>
          candidate.codexbar_binary_sha256 === TEST_CODEXBAR_SHA256,
        tryAcquireLock: () => held(),
      });
      expect(calls).toHaveLength(3);
      expect(result?.observed_at_ms).toBe(NOW);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a newly produced superseded generation is neither published nor returned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-refresh-"));
    try {
      const { runner, calls } = recordingRunner();
      const result = await refreshObservationIfStale({
        stateDir: dir,
        runner,
        nowMs: () => NOW,
        maxAgeMs: 100,
        acceptObservation: (candidate) =>
          candidate.codexbar_binary_sha256 === "f".repeat(64),
        tryAcquireLock: () => held(),
      });
      expect(calls).toHaveLength(3);
      expect(result).toBeNull();
      expect(readObservationSidecar(observationSidecarPath(dir))).toBeNull();
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
      expect(calls).toHaveLength(3);
      expect(releases).toBe(1);
      expect(result?.observed_at_ms).toBe(NOW);
      expect(
        readObservationSidecar(observationSidecarPath(dir))?.observed_at_ms,
      ).toBe(NOW);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a faster caller's publication suppresses a slower caller's fetch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-refresh-"));
    try {
      const path = observationSidecarPath(dir);
      writeObservationSidecar(path, observation(NOW - 30_000));
      const { runner, calls } = recordingRunner();
      await refreshObservationIfStale({
        stateDir: dir,
        runner,
        nowMs: () => NOW,
        maxAgeMs: 29_999,
        tryAcquireLock: () => held(),
      });
      expect(calls).toHaveLength(3);

      await refreshObservationIfStale({
        stateDir: dir,
        runner,
        nowMs: () => NOW + 10_000,
        maxAgeMs: 59_999,
        tryAcquireLock: () => {
          throw new Error("fresh slower caller must not acquire");
        },
      });
      expect(calls).toHaveLength(3);
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

  test("contention waits once, re-reads publication, and never fetches", async () => {
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

  test("contention retries boundedly until the active publisher lands", async () => {
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
        contentionWaitMs: 5,
        contentionTimeoutMs: 20,
        tryAcquireLock: () => null,
        sleep: async (ms) => {
          sleeps.push(ms);
          if (sleeps.length === 3) {
            writeObservationSidecar(path, observation(NOW));
          }
        },
      });
      expect(sleeps).toEqual([5, 5, 5]);
      expect(result?.observed_at_ms).toBe(NOW);
      expect(calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("contention deadline returns without fetching or blocking forever", async () => {
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

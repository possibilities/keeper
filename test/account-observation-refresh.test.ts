import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  makeBoundedRunner,
  observeOnce,
  type RefreshLock,
  refreshObservationIfStale,
  runProviderSafeRefresh,
} from "../src/account-observation-refresh";
import {
  cswapListArgv,
  OBSERVATION_SCHEMA_VERSION,
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
          usage: {
            fiveHour: { pct: 20 },
            sevenDay: { pct: 30 },
            scoped: [],
          },
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
    schema_version: OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: observedAtMs,
    health: "ok",
    routes: [
      {
        id: "claude-swap:2",
        kind: "managed",
        slot: 2,
        windows: [
          { key: "session", utilization: 0.2, resetsAt: null },
          { key: "week", utilization: 0.3, resetsAt: null },
        ],
        measuredAtMs: observedAtMs,
      },
    ],
    claude_accounts: { count: 1, ordinals: { "claude-swap:2": 0 } },
    account_issues: {},
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
  test("replaces a sidecar from the prior admission schema", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-refresh-"));
    try {
      writeFileSync(
        observationSidecarPath(dir),
        `${JSON.stringify({ ...observation(NOW), schema_version: 6 })}\n`,
      );
      expect(readObservationSidecar(observationSidecarPath(dir))).toBeNull();
      const { runner, calls } = recordingRunner();
      const result = await refreshObservationIfStale({
        stateDir: dir,
        runner,
        nowMs: () => NOW,
        maxAgeMs: 100,
        tryAcquireLock: () => held(),
      });
      expect(calls).toEqual([cswapListArgv()]);
      expect(result?.schema_version).toBe(7);
      expect(readObservationSidecar(observationSidecarPath(dir))).toEqual(
        result,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  test("force acquires the shared lock and refreshes a fresh sidecar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-refresh-"));
    try {
      writeObservationSidecar(observationSidecarPath(dir), observation(NOW));
      const { runner, calls } = recordingRunner();
      let releases = 0;
      const result = await runProviderSafeRefresh({
        stateDir: dir,
        runner,
        nowMs: () => NOW,
        maxAgeMs: 100,
        force: true,
        tryAcquireLock: () => held(() => releases++),
      });
      expect(result.outcome).toBe("refreshed");
      expect(calls).toEqual([cswapListArgv()]);
      expect(releases).toBe(1);
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

describe("makeBoundedRunner", () => {
  test("an AbortSignal terminates and joins the owned provider child", async () => {
    let killedWith: number | undefined | null = null;
    let closeStream: (() => void) | undefined;
    let resolveExit: ((code: number) => void) | undefined;
    const runner = makeBoundedRunner({
      spawn: () => ({
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            closeStream = () => controller.close();
          },
        }),
        exited: new Promise<number>((resolve) => {
          resolveExit = resolve;
        }),
        kill(signal) {
          killedWith = signal ?? null;
          closeStream?.();
          resolveExit?.(143);
        },
      }),
    });
    const controller = new AbortController();
    const pending = runner(["CSWAP", "list", "--json"], controller.signal);
    controller.abort();
    expect(await pending).toEqual({
      code: null,
      stdout: "",
      failure: "aborted",
    });
    expect(killedWith).toBeNull();
  });

  test("timeout terminates and joins the owned child through injected seams", async () => {
    let killed = false;
    let closeStream: (() => void) | undefined;
    let resolveExit: ((code: number) => void) | undefined;
    const runner = makeBoundedRunner({
      timeoutMs: 5,
      setTimer: (callback, ms) => {
        expect(ms).toBe(5);
        queueMicrotask(callback);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
      spawn: () => ({
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            closeStream = () => controller.close();
          },
        }),
        exited: new Promise<number>((resolve) => {
          resolveExit = resolve;
        }),
        kill() {
          killed = true;
          closeStream?.();
          resolveExit?.(143);
        },
      }),
    });
    expect(await runner(["CSWAP", "list", "--json"])).toEqual({
      code: null,
      stdout: "",
      failure: "timeout",
    });
    expect(killed).toBe(true);
  });

  test("child exit does not disarm the deadline while stdout remains open", async () => {
    let canceled = false;
    let kills = 0;
    const runner = makeBoundedRunner({
      timeoutMs: 5,
      setTimer: (callback) => {
        queueMicrotask(callback);
        return 1;
      },
      clearTimer: () => {},
      spawn: () => ({
        stdout: new ReadableStream<Uint8Array>({
          cancel() {
            canceled = true;
          },
        }),
        exited: Promise.resolve(0),
        kill() {
          kills += 1;
        },
      }),
    });
    expect(await runner(["CSWAP", "list", "--json"])).toEqual({
      code: null,
      stdout: "",
      failure: "timeout",
    });
    expect(canceled).toBe(true);
    expect(kills).toBe(1);
  });

  test("rechecks an abort delivered synchronously inside spawn", async () => {
    const controller = new AbortController();
    let closeStream: (() => void) | undefined;
    let resolveExit: ((code: number) => void) | undefined;
    let kills = 0;
    const runner = makeBoundedRunner({
      spawn: () => {
        controller.abort();
        return {
          stdout: new ReadableStream<Uint8Array>({
            start(streamController) {
              closeStream = () => streamController.close();
            },
          }),
          exited: new Promise<number>((resolve) => {
            resolveExit = resolve;
          }),
          kill() {
            kills += 1;
            closeStream?.();
            resolveExit?.(143);
          },
        };
      },
    });
    expect(
      await runner(["CSWAP", "list", "--json"], controller.signal),
    ).toEqual({
      code: null,
      stdout: "",
      failure: "aborted",
    });
    expect(kills).toBe(1);
  });

  test("returns after a post-SIGKILL deadline when exit never settles", async () => {
    const signals: Array<number | undefined> = [];
    let terminationTimers = 0;
    const runner = makeBoundedRunner({
      timeoutMs: 5,
      terminationGraceMs: 5,
      postKillWaitMs: 5,
      setTimer: (callback) => {
        queueMicrotask(callback);
        return 1;
      },
      clearTimer: () => {},
      setTerminationTimer: (callback) => {
        terminationTimers += 1;
        queueMicrotask(callback);
        return terminationTimers;
      },
      clearTerminationTimer: () => {},
      spawn: () => ({
        stdout: null,
        exited: new Promise<number>(() => {}),
        kill(signal) {
          signals.push(signal);
        },
      }),
    });
    expect(await runner(["CSWAP", "list", "--json"])).toEqual({
      code: null,
      stdout: "",
      failure: "timeout",
    });
    expect(signals).toEqual([undefined, 9]);
    expect(terminationTimers).toBeGreaterThanOrEqual(2);
  });

  test("an already-aborted signal never spawns", async () => {
    const controller = new AbortController();
    controller.abort();
    let spawned = false;
    const runner = makeBoundedRunner({
      spawn: () => {
        spawned = true;
        throw new Error("must not spawn");
      },
    });
    expect(await runner(["CSWAP"], controller.signal)).toEqual({
      code: null,
      stdout: "",
      failure: "aborted",
    });
    expect(spawned).toBe(false);
  });
});

describe("runProviderSafeRefresh outcomes", () => {
  test("a provider call reports refreshed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-refresh-"));
    try {
      writeObservationSidecar(
        observationSidecarPath(dir),
        observation(NOW - 101),
      );
      const { runner } = recordingRunner();
      const result = await runProviderSafeRefresh({
        stateDir: dir,
        runner,
        nowMs: () => NOW,
        maxAgeMs: 100,
        tryAcquireLock: () => held(),
      });
      expect(result.outcome).toBe("refreshed");
      expect(result.observation?.observed_at_ms).toBe(NOW);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an in-flight refresh publishing during the wait reports peer-published", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-refresh-"));
    try {
      const path = observationSidecarPath(dir);
      const { runner, calls } = recordingRunner();
      const result = await runProviderSafeRefresh({
        stateDir: dir,
        runner,
        nowMs: () => NOW,
        maxAgeMs: 100,
        contentionWaitMs: 7,
        tryAcquireLock: () => null,
        sleep: async () => {
          writeObservationSidecar(path, observation(NOW));
        },
      });
      expect(result.outcome).toBe("peer-published");
      expect(result.observation?.observed_at_ms).toBe(NOW);
      expect(calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("owned mode waits past a newer peer publication and performs its own call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-refresh-"));
    try {
      const path = observationSidecarPath(dir);
      writeObservationSidecar(path, observation(NOW - 10));
      const { runner, calls } = recordingRunner();
      let acquireAttempts = 0;
      const result = await runProviderSafeRefresh({
        stateDir: dir,
        runner,
        nowMs: () => NOW,
        maxAgeMs: 100,
        force: true,
        requireOwnedCall: true,
        contentionWaitMs: 7,
        contentionTimeoutMs: 14,
        tryAcquireLock: () => {
          acquireAttempts += 1;
          return acquireAttempts === 1 ? null : held();
        },
        sleep: async () => {
          writeObservationSidecar(path, observation(NOW - 1));
        },
      });
      expect(result.outcome).toBe("refreshed");
      expect(result.observation?.observed_at_ms).toBe(NOW);
      expect(calls).toEqual([cswapListArgv()]);
      expect(acquireAttempts).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("forced contention never mistakes an unchanged fresh sidecar for peer publication", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-refresh-"));
    try {
      writeObservationSidecar(observationSidecarPath(dir), observation(NOW));
      const { runner, calls } = recordingRunner();
      const result = await runProviderSafeRefresh({
        stateDir: dir,
        runner,
        nowMs: () => NOW,
        maxAgeMs: 100,
        force: true,
        contentionWaitMs: 7,
        contentionTimeoutMs: 7,
        tryAcquireLock: () => null,
        sleep: async () => {},
      });
      expect(result.outcome).toBe("contended");
      expect(calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a held lock through the deadline reports contended", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-refresh-"));
    try {
      const { runner, calls } = recordingRunner();
      const result = await runProviderSafeRefresh({
        stateDir: dir,
        runner,
        nowMs: () => NOW,
        maxAgeMs: 100,
        contentionWaitMs: 7,
        contentionTimeoutMs: 7,
        tryAcquireLock: () => null,
        sleep: async () => {},
      });
      expect(result.outcome).toBe("contended");
      expect(result.observation).toBeNull();
      expect(calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

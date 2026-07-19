import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_OBSERVATION_SCHEMA_VERSION,
  codexObservationSidecarPath,
} from "../src/account-routing-config";
import {
  type CodexCapacityObservation,
  readCodexObservationSidecar,
  writeCodexObservationSidecar,
} from "../src/codex-account-observation";
import {
  type CodexExactArgvRunner,
  type CodexRefreshLock,
  codexObserverSubprocessEnvironment,
  observeCodexOnce,
  refreshCodexObservationIfStale,
} from "../src/codex-account-observation-refresh";

const NOW = Date.parse("2026-07-18T12:00:00Z");
const ARGV = ["keeper-pi-codex-observe"];
const BINDING = "b".repeat(64);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function observation(observedAtMs: number): CodexCapacityObservation {
  return {
    schema_version: CODEX_OBSERVATION_SCHEMA_VERSION,
    provider: "openai-codex",
    config_binding: BINDING,
    observed_at_ms: observedAtMs,
    aliases: [
      {
        alias: "keeper-codex-a",
        status: "healthy",
        observed_at_ms: observedAtMs,
        expires_at_ms: NOW + 120_000,
        windows: [{ role: "primary", used_percent: 25, reset_at_ms: null }],
      },
    ],
  };
}

function outcome(observedAtMs = NOW) {
  return {
    code: 0,
    stdout: JSON.stringify({
      schema_version: 1,
      config_binding: BINDING,
      observed_at_ms: observedAtMs,
      aliases: observation(observedAtMs).aliases.map((alias) => ({
        alias: alias.alias,
        usage: { schema_version: 1, ...alias },
      })),
      truncated: false,
    }),
  };
}

function runnerWithCalls(): {
  runner: CodexExactArgvRunner;
  calls: readonly string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    runner: async (argv) => {
      calls.push([...argv]);
      return outcome();
    },
  };
}

function held(onRelease: () => void = () => {}): CodexRefreshLock {
  return { release: onRelease };
}

describe("observeCodexOnce", () => {
  test("runs the companion observer with one exact argv and validates output", async () => {
    const { runner, calls } = runnerWithCalls();
    const result = await observeCodexOnce({
      runner,
      nowMs: () => NOW,
      observerArgv: ARGV,
    });
    expect(calls).toEqual([ARGV]);
    expect(result?.provider).toBe("openai-codex");
    expect(result?.aliases.map((entry) => entry.alias)).toEqual([
      "keeper-codex-a",
    ]);
  });

  test("marks the bounded command as Keeper-owned without mutating input", () => {
    const inherited = { PATH: "/test/bin" };
    const environment = codexObserverSubprocessEnvironment(inherited);
    expect(environment).toEqual({
      PATH: "/test/bin",
      KEEPER_JOB_ID: "keeperd-codex-observer",
    });
    expect(inherited).toEqual({ PATH: "/test/bin" });
  });
});

describe("refreshCodexObservationIfStale", () => {
  test("fresh state skips the refresh lock and command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-refresh-"));
    roots.push(dir);
    writeCodexObservationSidecar(
      codexObservationSidecarPath(dir),
      observation(NOW - 10),
    );
    const { runner, calls } = runnerWithCalls();
    let lockAttempts = 0;
    const result = await refreshCodexObservationIfStale({
      stateDir: dir,
      runner,
      nowMs: () => NOW,
      maxAgeMs: 100,
      observerArgv: ARGV,
      tryAcquireLock: () => {
        lockAttempts += 1;
        return held();
      },
    });
    expect(result?.observed_at_ms).toBe(NOW - 10);
    expect(lockAttempts).toBe(0);
    expect(calls).toEqual([]);
  });

  test("publishes one validated replacement and releases the lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-refresh-"));
    roots.push(dir);
    writeCodexObservationSidecar(
      codexObservationSidecarPath(dir),
      observation(NOW - 101),
    );
    const { runner, calls } = runnerWithCalls();
    let releases = 0;
    const result = await refreshCodexObservationIfStale({
      stateDir: dir,
      runner,
      nowMs: () => NOW,
      maxAgeMs: 100,
      observerArgv: ARGV,
      tryAcquireLock: () => held(() => releases++),
    });
    expect(calls).toEqual([ARGV]);
    expect(releases).toBe(1);
    expect(result?.observed_at_ms).toBe(NOW);
    expect(
      readCodexObservationSidecar(codexObservationSidecarPath(dir))
        ?.observed_at_ms,
    ).toBe(NOW);
  });

  test("malformed refresh retains the last good snapshot without refreshing it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-refresh-"));
    roots.push(dir);
    const stale = observation(NOW - 1_000);
    writeCodexObservationSidecar(codexObservationSidecarPath(dir), stale);
    const result = await refreshCodexObservationIfStale({
      stateDir: dir,
      runner: async () => ({
        code: 0,
        stdout: "owner@example.test",
      }),
      nowMs: () => NOW,
      maxAgeMs: 100,
      observerArgv: ARGV,
      tryAcquireLock: () => held(),
    });
    expect(result).toEqual(stale);
    expect(
      readCodexObservationSidecar(codexObservationSidecarPath(dir)),
    ).toEqual(stale);
  });

  test("double-check under the lock observes another publisher", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-refresh-"));
    roots.push(dir);
    const path = codexObservationSidecarPath(dir);
    writeCodexObservationSidecar(path, observation(NOW - 1_000));
    const { runner, calls } = runnerWithCalls();
    const result = await refreshCodexObservationIfStale({
      stateDir: dir,
      runner,
      nowMs: () => NOW,
      maxAgeMs: 100,
      observerArgv: ARGV,
      tryAcquireLock: () => {
        writeCodexObservationSidecar(path, observation(NOW));
        return held();
      },
    });
    expect(result?.observed_at_ms).toBe(NOW);
    expect(calls).toEqual([]);
  });

  test("contention is bounded and never invokes the observer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-refresh-"));
    roots.push(dir);
    const sleeps: number[] = [];
    let calls = 0;
    const result = await refreshCodexObservationIfStale({
      stateDir: dir,
      runner: async () => {
        calls += 1;
        return outcome();
      },
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
    expect(calls).toBe(0);
    expect(result).toBeNull();
  });
});

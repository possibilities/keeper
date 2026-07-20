import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  readCodexObservationRefreshFailureState,
} from "../src/codex-account-observation-refresh";
import {
  CodexAccountObserver,
  type CodexAccountObserverClock,
} from "../src/codex-account-observer-worker";

const NOW = Date.parse("2026-07-18T12:00:00Z");
const BINDING = "e".repeat(64);
const ARGV = ["OBSERVER", "--bounded"];
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function envelope() {
  return {
    code: 0,
    stdout: JSON.stringify({
      schema_version: 1,
      config_binding: BINDING,
      observed_at_ms: NOW,
      aliases: [
        {
          alias: "keeper-codex-a",
          usage: {
            schema_version: 1,
            alias: "keeper-codex-a",
            status: "healthy",
            observed_at_ms: NOW,
            expires_at_ms: NOW + 60_000,
            windows: [{ role: "primary", used_percent: 10, reset_at_ms: null }],
          },
        },
      ],
      truncated: false,
    }),
  };
}

function staleObservation(): CodexCapacityObservation {
  return {
    schema_version: CODEX_OBSERVATION_SCHEMA_VERSION,
    provider: "openai-codex",
    config_binding: BINDING,
    observed_at_ms: NOW - 60_000,
    aliases: [
      {
        alias: "keeper-codex-a",
        status: "healthy",
        observed_at_ms: NOW - 60_000,
        expires_at_ms: NOW + 60_000,
        windows: [{ role: "primary", used_percent: 30, reset_at_ms: null }],
      },
    ],
  };
}

function immediateClock(): CodexAccountObserverClock {
  return {
    nowMs: () => NOW,
    uniform: () => 0,
    sleep: async () => {},
  };
}

function fakeLock(): { release(): void } {
  return { release() {} };
}

describe("CodexAccountObserver", () => {
  test("one cycle invokes exact argv and publishes a provider-qualified sidecar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-worker-"));
    roots.push(dir);
    const calls: string[][] = [];
    const runner: CodexExactArgvRunner = async (argv) => {
      calls.push([...argv]);
      return envelope();
    };
    const observer = new CodexAccountObserver({
      stateDir: dir,
      runner,
      clock: immediateClock(),
      shutdownSignal: new AbortController().signal,
      observerArgv: ARGV,
      tryAcquireLock: () => fakeLock(),
    });
    await observer.runCycleNoThrow();
    expect(calls).toEqual([ARGV]);
    expect(
      readCodexObservationSidecar(codexObservationSidecarPath(dir)),
    ).toMatchObject({
      provider: "openai-codex",
      aliases: [{ alias: "keeper-codex-a", status: "healthy" }],
    });
  });

  test("a bad cycle is fail-soft, records one bounded failure log, and preserves the last good bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-worker-"));
    roots.push(dir);
    const path = codexObservationSidecarPath(dir);
    writeCodexObservationSidecar(path, staleObservation());
    const before = readFileSync(path, "utf8");
    const observer = new CodexAccountObserver({
      stateDir: dir,
      runner: async () => ({ code: 0, stdout: "owner@example.test" }),
      clock: immediateClock(),
      shutdownSignal: new AbortController().signal,
      observerArgv: ARGV,
      tryAcquireLock: () => fakeLock(),
    });
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (message?: unknown) => {
      logs.push(String(message));
    };
    try {
      await observer.runCycleNoThrow();
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(readCodexObservationRefreshFailureState(dir)).toEqual({
        schema_version: 1,
        consecutive_failures: 1,
        last_failure_class: "parse",
        last_failure_at_ms: NOW,
      });
      expect(logs).toEqual([
        "[codex-account-observer] refresh failed class=parse consecutive=1",
      ]);
      expect(logs[0]?.length).toBeLessThanOrEqual(160);
    } finally {
      console.error = originalError;
    }
  });

  test("refresh-lock contention is bounded and does not invoke the command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-worker-"));
    roots.push(dir);
    let calls = 0;
    let sleeps = 0;
    const observer = new CodexAccountObserver({
      stateDir: dir,
      runner: async () => {
        calls += 1;
        return envelope();
      },
      clock: {
        nowMs: () => NOW,
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
    expect(calls).toBe(0);
    expect(sleeps).toBe(1);
  });

  test("the loop releases an abort-aware sleep and exits cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-worker-"));
    roots.push(dir);
    const shutdown = new AbortController();
    const sleeps: number[] = [];
    const observer = new CodexAccountObserver({
      stateDir: dir,
      runner: async () => envelope(),
      clock: {
        nowMs: () => NOW,
        uniform: (lo, hi) => {
          expect(lo).toBe(0);
          expect(hi).toBe(5_000);
          return hi;
        },
        sleep: async (ms) => {
          sleeps.push(ms);
          shutdown.abort();
        },
      },
      shutdownSignal: shutdown.signal,
      observerArgv: ARGV,
      tryAcquireLock: () => fakeLock(),
    });
    await observer.run();
    expect(sleeps).toEqual([35_000]);
  });
});

describe("worker import boundary", () => {
  test("the module is import-inert and guarded by isMainThread", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-worker-inert-"));
    roots.push(root);
    expect(existsSync(join(root, "observation.json"))).toBe(false);
    const source = readFileSync(
      join(import.meta.dir, "../src/codex-account-observer-worker.ts"),
      "utf8",
    );
    expect(source).toContain("if (!isMainThread) main();");
    expect(source).not.toContain("openDb");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Observation } from "../src/account-observation";
import type { CodexResetTerminal } from "../src/codex-reset-tui";
import {
  type CodexResetLatch,
  type CodexResetLatchRead,
  type CodexUsageResetDeps,
  crossedUsageBuckets,
  makeNotifyctlNotifier,
  maxObservationAgeForCadence,
  notifyctlShowMessageArgv,
  predictCodexResetShotDeadlineMs,
  readCodexResetLatch,
  runCodexUsageResetController,
  writeCodexResetLatch,
} from "../src/codex-usage-reset";

const roots: string[] = [];
const OLD_WINDOW = "2026-08-12T12:00:00Z";
const NEW_WINDOW = "2026-08-19T12:00:00Z";

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function observation(
  nowMs: number,
  usedPercent: number,
  input: {
    window?: string;
    credits?: number | null;
    health?: Observation["codex"]["health"];
  } = {},
): Observation {
  return {
    schema_version: 3,
    codexbar_binary_sha256: null,
    observed_at_ms: nowMs,
    health: "ok",
    codex: {
      health: input.health ?? "ok",
      windows: [
        {
          key: "week",
          utilization: usedPercent / 100,
          resetsAt: input.window ?? OLD_WINDOW,
        },
      ],
      resetCreditsAvailableCount: input.credits ?? 1,
      notes: [],
    },
    routes: [],
    notes: [],
  };
}

const unusedTerminal: CodexResetTerminal = {
  start: async () => undefined,
  capture: async () => "",
  wait: async () => undefined,
  sendLiteral: async () => undefined,
  sendKey: async () => undefined,
  close: async () => undefined,
};

function harness(
  rows: Array<(nowMs: number) => Observation | null>,
  input: {
    latch?: CodexResetLatchRead;
    onWrite?: (latch: CodexResetLatch) => void;
    tuiEvents?: string[];
    abort?: AbortController;
    uncertain?: boolean;
    rejected?: string;
    lockBusy?: boolean;
    onSleep?: (ms: number) => void;
  } = {},
): {
  deps: CodexUsageResetDeps;
  refreshAges: number[];
  sleeps: number[];
  notifications: string[];
  stdout: string[];
  writes: CodexResetLatch[];
} {
  const root = mkdtempSync(join(tmpdir(), "codex-reset-controller-"));
  roots.push(root);
  let nowMs = Date.UTC(2026, 7, 11, 12, 0, 0);
  const refreshAges: number[] = [];
  const sleeps: number[] = [];
  const notifications: string[] = [];
  const stdout: string[] = [];
  const writes: CodexResetLatch[] = [];
  const queue = [...rows];
  const deps: CodexUsageResetDeps = {
    stateDir: root,
    signal: (input.abort ?? new AbortController()).signal,
    clock: {
      nowMs: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
        input.onSleep?.(ms);
      },
    },
    refresh: async (maxAgeMs) => {
      refreshAges.push(maxAgeMs);
      const next = queue.shift();
      return next === undefined ? null : next(nowMs);
    },
    tryAcquireCommandLock: (path) => {
      if (input.lockBusy) return null;
      writeFileSync(path, "", { mode: 0o600 });
      return { release: () => undefined };
    },
    createTerminal: () => unusedTerminal,
    runTui: async (_terminal, beforeFinalEnter, options) => {
      try {
        await options?.prepareFinalEnter?.();
        await beforeFinalEnter();
      } catch (error) {
        return {
          kind: "pre-submit-failure",
          stage: "before-final-enter",
          error,
        };
      }
      input.tuiEvents?.push("final-enter");
      if (input.uncertain) {
        return { kind: "final-enter-uncertain", error: new Error("lost") };
      }
      if (input.rejected) {
        return { kind: "submitted-rejected", message: input.rejected };
      }
      return { kind: "submitted" };
    },
    readLatch: () => input.latch ?? { kind: "missing" },
    writeLatch: (_path, latch) => {
      writes.push(latch);
      input.onWrite?.(latch);
    },
    notify: async (message) => {
      notifications.push(message);
    },
    stdout: (line) => stdout.push(line),
    stderr: () => undefined,
  };
  return { deps, refreshAges, sleeps, notifications, stdout, writes };
}

function validLatch(window = OLD_WINDOW): CodexResetLatch {
  return {
    schema_version: 1,
    reset_window: window,
    observed_used_percent: 99,
    timestamp_ms: 1,
    state: "armed",
  };
}

describe("Codex reset timing and progress", () => {
  test("predicts the final boundary with one poll plus 15s safety", () => {
    expect(
      predictCodexResetShotDeadlineMs(
        [
          { atMs: 0, usedPercent: 98.9 },
          { atMs: 10_000, usedPercent: 99 },
        ],
        5_000,
      ),
    ).toBeCloseTo(90_000);
    expect(
      predictCodexResetShotDeadlineMs(
        [
          { atMs: 0, usedPercent: 98 },
          { atMs: 120_000, usedPercent: 99 },
        ],
        30_000,
      ),
    ).toBe(195_000);
    expect(
      predictCodexResetShotDeadlineMs(
        [
          { atMs: 0, usedPercent: 90 },
          { atMs: 10_000, usedPercent: 99 },
        ],
        5_000,
      ),
    ).toBe(10_000);
  });

  test("builds and runs bounded notifyctl exact argv without a shell", async () => {
    expect(notifyctlShowMessageArgv("hello", "/fake/notifyctl")).toEqual([
      "/fake/notifyctl",
      "show-message",
      "-t",
      "Keeper Codex quota reset",
      "-m",
      "hello",
    ]);
    const calls: Array<{ argv: readonly string[]; timeoutMs: number }> = [];
    await makeNotifyctlNotifier(async (argv, timeoutMs) => {
      calls.push({ argv, timeoutMs });
      return { exitCode: 0, stdout: "", stderr: "" };
    }, "/fake/notifyctl")("done");
    expect(calls).toEqual([
      {
        argv: notifyctlShowMessageArgv("done", "/fake/notifyctl"),
        timeoutMs: 5_000,
      },
    ]);
  });

  test("refreshes at the configured inclusive cadence boundary", () => {
    expect(maxObservationAgeForCadence(30_000)).toBe(29_999);
    expect(maxObservationAgeForCadence(1)).toBe(0);
  });

  test("reports every crossed bucket once", () => {
    expect(crossedUsageBuckets(89, 99, 5)).toEqual([90, 95]);
    expect(crossedUsageBuckets(99, 99, 5)).toEqual([]);
    expect(crossedUsageBuckets(99, 98, 5)).toEqual([]);
  });

  test("polls the shared refresher at the configured cadence and deduplicates progress", async () => {
    const h = harness([
      (now) => observation(now, 89),
      (now) => observation(now, 96),
      (now) => observation(now, 94),
      (now) => observation(now, 99),
      (now) => observation(now, 99),
    ]);
    const result = await runCodexUsageResetController(h.deps, {
      checkEveryMs: 5_000,
      notifyEveryPercent: 5,
      confirmationPolls: 0,
    });
    expect(result.kind).toBe("submitted-unconfirmed");
    expect(h.refreshAges).toEqual([4_999, 4_999, 4_999, 4_999, 4_999]);
    expect(h.notifications.filter((line) => line.includes("crossed"))).toEqual([
      "Codex weekly usage crossed 90% used.",
      "Codex weekly usage crossed 95% used.",
    ]);
    expect(h.notifications.at(-1)).toContain("submitted but not confirmed");
  });
});

describe("Codex reset critical section", () => {
  test("a contended stale read retries instead of terminating the watcher", async () => {
    const h = harness([
      () => null,
      (now) => observation(now, 98.9),
      (now) => observation(now, 99),
      (now) => observation(now, 99),
    ]);
    const result = await runCodexUsageResetController(h.deps, {
      checkEveryMs: 5_000,
      confirmationPolls: 0,
    });
    expect(result.kind).toBe("submitted-unconfirmed");
    expect(h.refreshAges).toEqual([4_999, 4_999, 4_999, 4_999]);
    expect(h.sleeps.slice(0, 2)).toEqual([5_000, 5_000]);
  });

  test("lock contention has one final notification and touches no provider", async () => {
    const h = harness([], { lockBusy: true });
    const result = await runCodexUsageResetController(h.deps, {
      checkEveryMs: 5_000,
      confirmationPolls: 0,
    });
    expect(result.kind).toBe("lock-busy");
    expect(h.refreshAges).toEqual([]);
    expect(h.notifications).toHaveLength(1);
  });

  test("writes and reads a schema-v1 latch with private permissions", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-reset-latch-"));
    roots.push(root);
    const path = join(root, "nested", "latch.json");
    const latch = validLatch();
    writeCodexResetLatch(path, latch);
    expect(readCodexResetLatch(path)).toEqual({ kind: "valid", latch });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "nested")).mode & 0o777).toBe(0o700);
  });

  test("delays to the predicted deadline, then refreshes before the latch", async () => {
    const h = harness([
      (now) => observation(now, 98.9),
      (now) => observation(now, 99),
      (now) => observation(now, 99),
    ]);
    const result = await runCodexUsageResetController(h.deps, {
      checkEveryMs: 5_000,
      confirmationPolls: 0,
    });
    expect(result.kind).toBe("submitted-unconfirmed");
    expect(h.sleeps).toEqual([5_000, 30_000]);
    expect(h.refreshAges).toEqual([4_999, 4_999, 4_999]);
  });

  test("cancellation during a shot delay prevents the latch and final Enter", async () => {
    const abort = new AbortController();
    const events: string[] = [];
    const h = harness(
      [(now) => observation(now, 98.9), (now) => observation(now, 99)],
      {
        abort,
        tuiEvents: events,
        onSleep: (ms) => {
          if (ms > 5_000) abort.abort();
        },
      },
    );
    const result = await runCodexUsageResetController(h.deps, {
      checkEveryMs: 5_000,
      confirmationPolls: 0,
    });
    expect(result.kind).toBe("cancelled");
    expect(h.writes).toEqual([]);
    expect(events).toEqual([]);
  });

  test("strict pre-final rollover sends no latch or final Enter", async () => {
    const events: string[] = [];
    const h = harness(
      [
        (now) => observation(now, 99, { window: OLD_WINDOW }),
        (now) => observation(now, 99, { window: NEW_WINDOW }),
      ],
      { tuiEvents: events },
    );
    const result = await runCodexUsageResetController(h.deps, {
      checkEveryMs: 5_000,
      confirmationPolls: 0,
    });
    expect(result.kind).toBe("failure");
    expect(h.writes).toEqual([]);
    expect(events).toEqual([]);
  });

  test("writes the armed latch before the only final Enter", async () => {
    const events: string[] = [];
    const h = harness(
      [(now) => observation(now, 99), (now) => observation(now, 99)],
      {
        tuiEvents: events,
        onWrite: (latch) => events.push(`latch:${latch.state}`),
      },
    );
    await runCodexUsageResetController(h.deps, {
      checkEveryMs: 5_000,
      confirmationPolls: 0,
    });
    expect(events).toEqual(["latch:armed", "final-enter", "latch:submitted"]);
    expect(events.filter((event) => event === "final-enter")).toHaveLength(1);
  });

  test("same-window and malformed latches fail closed", async () => {
    for (const latch of [
      { kind: "valid", latch: validLatch() } as const,
      { kind: "malformed" } as const,
    ]) {
      const h = harness(
        [(now) => observation(now, 99), (now) => observation(now, 99)],
        { latch },
      );
      const result = await runCodexUsageResetController(h.deps, {
        checkEveryMs: 5_000,
        confirmationPolls: 0,
      });
      expect(["already-submitted", "failure"]).toContain(result.kind);
      expect(h.writes).toEqual([]);
    }
  });

  test("a strictly later current window may replace an older latch", async () => {
    const h = harness(
      [
        (now) => observation(now, 99, { window: NEW_WINDOW }),
        (now) => observation(now, 99, { window: NEW_WINDOW }),
      ],
      { latch: { kind: "valid", latch: validLatch(OLD_WINDOW) } },
    );
    const result = await runCodexUsageResetController(h.deps, {
      checkEveryMs: 5_000,
      confirmationPolls: 0,
    });
    expect(result.kind).toBe("submitted-unconfirmed");
    expect(h.writes[0]?.reset_window).toBe(NEW_WINDOW);
  });

  test("an explicit terminal rejection is reported once and remains latched", async () => {
    const h = harness(
      [(now) => observation(now, 99), (now) => observation(now, 99)],
      { rejected: "That reset is no longer available." },
    );
    const result = await runCodexUsageResetController(h.deps, {
      checkEveryMs: 5_000,
      confirmationPolls: 0,
    });
    expect(result.kind).toBe("submitted-rejected");
    expect(h.writes.map((latch) => latch.state)).toEqual([
      "armed",
      "submitted",
    ]);
    expect(h.notifications.at(-1)).toContain("no longer available");
  });

  test("transport uncertainty retains the blocking armed latch and one final outcome", async () => {
    const h = harness(
      [(now) => observation(now, 99), (now) => observation(now, 99)],
      { uncertain: true },
    );
    const result = await runCodexUsageResetController(h.deps, {
      checkEveryMs: 5_000,
      confirmationPolls: 0,
    });
    expect(result.kind).toBe("final-enter-uncertain");
    expect(h.writes.map((latch) => latch.state)).toEqual(["armed"]);
    expect(h.notifications.at(-1)).toContain("uncertain");
  });

  test("does not misreport a natural weekly rollover as redemption", async () => {
    const h = harness([
      (now) => observation(now, 99, { window: OLD_WINDOW }),
      (now) => observation(now, 99, { window: OLD_WINDOW }),
      (now) => observation(now, 0, { window: NEW_WINDOW, credits: 1 }),
    ]);
    const result = await runCodexUsageResetController(h.deps, {
      checkEveryMs: 5_000,
      confirmationPolls: 1,
    });
    expect(result.kind).toBe("submitted-unconfirmed");
  });

  test("confirms only after normalized usage materially falls", async () => {
    const h = harness([
      (now) => observation(now, 99),
      (now) => observation(now, 99),
      (now) => observation(now, 97.5),
    ]);
    const result = await runCodexUsageResetController(h.deps, {
      checkEveryMs: 5_000,
      confirmationPolls: 1,
    });
    expect(result.kind).toBe("confirmed");
    expect(h.notifications.at(-1)).toBe("Codex reset confirmed.");
  });
});

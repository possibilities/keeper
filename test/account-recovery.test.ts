import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Observation,
  ProviderRunOutcome,
  Route,
} from "../src/account-observation";
import type { RefreshResult } from "../src/account-observation-refresh";
import {
  type AccountRecoveryOutcome,
  accountRecoveryStatePath,
  createFileRecoveryStateStore,
  cswapRecoverArgv,
  parseCswapRecovery,
  type RecoveryState,
  RecoveryStateLockContentionError,
  type RecoveryStateStore,
  runAutomaticAccountRecovery,
  runForegroundAccountRecovery,
} from "../src/account-recovery";
import { OBSERVATION_SCHEMA_VERSION } from "../src/account-routing-config";

const NOW = Date.UTC(2026, 6, 1, 12, 0, 0);
const CSWAP = "/fake/cswap";

function recoveryEnvelope(
  status: "recovered" | "not_needed" | "retry_later" | "human_required",
  slot = 5,
): ProviderRunOutcome {
  return {
    code: 0,
    stdout: JSON.stringify({
      schemaVersion: 1,
      operation: "recover",
      accountNumber: slot,
      recoveryStatus: status,
    }),
  };
}

function route(slot: number): Route {
  return {
    id: `claude-swap:${slot}`,
    kind: "managed",
    slot,
    measuredAtMs: NOW,
    windows: [
      { key: "session", utilization: 0.1, resetsAt: null },
      { key: "week", utilization: 0.2, resetsAt: null },
    ],
  };
}

function observation(
  accounts: Array<{
    slot: number;
    issue?: Observation["account_issues"][string];
  }>,
): Observation {
  const ordinals: Record<string, number> = {};
  const issues: Observation["account_issues"] = {};
  const routes: Route[] = [];
  accounts.forEach((account, ordinal) => {
    const id = `claude-swap:${account.slot}`;
    ordinals[id] = ordinal;
    if (account.issue === undefined) routes.push(route(account.slot));
    else issues[id] = account.issue;
  });
  return {
    schema_version: OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: NOW,
    health: "ok",
    routes,
    claude_accounts: { count: accounts.length, ordinals },
    account_issues: issues,
    notes: [],
  };
}

function refreshed(obs: Observation): RefreshResult {
  return { outcome: "refreshed", observation: obs };
}

function nextRefresh(queue: RefreshResult[]): RefreshResult {
  const value = queue.shift();
  if (value === undefined) throw new Error("refresh fixture exhausted");
  return value;
}

class MemoryStateStore implements RecoveryStateStore {
  state: RecoveryState = { schema_version: 1, slots: {} };

  read(): RecoveryState {
    return structuredClone(this.state);
  }

  mutate(update: (state: RecoveryState) => boolean): void {
    const next = structuredClone(this.state);
    if (update(next)) this.state = next;
  }
}

class FailingBeginStateStore extends MemoryStateStore {
  override mutate(update: (state: RecoveryState) => boolean): void {
    const next = structuredClone(this.state);
    const changed = update(next);
    const priorAttempts = this.state.slots["5"]?.attempts ?? 0;
    if ((next.slots["5"]?.attempts ?? 0) > priorAttempts) {
      throw new Error("state write failed");
    }
    if (changed) this.state = next;
  }
}

function lock() {
  return { release() {} };
}

function deepJson(depth: number): string {
  let value: unknown = "leaf";
  for (let index = 0; index < depth; index += 1) value = { value };
  return JSON.stringify(value);
}

describe("claude-swap recovery envelope", () => {
  test("maps every fixed status at the exact owner slot", () => {
    const cases: Array<
      [Parameters<typeof recoveryEnvelope>[0], AccountRecoveryOutcome]
    > = [
      ["recovered", "recovered"],
      ["not_needed", "not-needed"],
      ["retry_later", "retry-later"],
      ["human_required", "human-required"],
    ];
    for (const [status, expected] of cases) {
      expect(parseCswapRecovery(recoveryEnvelope(status), 5)).toBe(expected);
    }
    expect(cswapRecoverArgv(5, CSWAP)).toEqual([
      CSWAP,
      "recover",
      "5",
      "--json",
    ]);
  });

  test("collapses malformed, mismatched, deep, oversized, and tool failures", () => {
    const invalid: ProviderRunOutcome[] = [
      { code: null, stdout: "", failure: "spawn" },
      { code: 2, stdout: recoveryEnvelope("recovered").stdout },
      {
        code: 0,
        stdout: recoveryEnvelope("recovered").stdout,
        failure: "timeout",
      },
      { code: 0, stdout: "not-json" },
      { code: 0, stdout: deepJson(40) },
      { code: 0, stdout: "x".repeat(262_145) },
      {
        code: 0,
        stdout: JSON.stringify({ error: { code: "bad_args" } }),
      },
      recoveryEnvelope("recovered", 6),
      {
        code: 0,
        stdout: JSON.stringify({
          ...JSON.parse(recoveryEnvelope("recovered").stdout),
          email: "must-not-cross-boundary@example.invalid",
        }),
      },
      {
        code: 0,
        stdout: JSON.stringify({
          schemaVersion: 2,
          operation: "recover",
          accountNumber: 5,
          recoveryStatus: "recovered",
        }),
      },
      {
        code: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          operation: "recover",
          accountNumber: 5,
          recoveryStatus: "surprise",
        }),
      },
    ];
    for (const outcome of invalid) {
      expect(parseCswapRecovery(outcome, 5)).toBe("tool-failure");
    }
  });
});

describe("automatic recovery state sidecar", () => {
  test("atomically writes owner-only bounded PII-free state with an injected lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "account-recovery-state-"));
    let releases = 0;
    try {
      const store = createFileRecoveryStateStore(dir, () => ({
        release: () => {
          releases += 1;
        },
      }));
      store.mutate((state) => {
        state.slots["5"] = {
          attempts: 2,
          next_attempt_at_ms: NOW + 6 * 60_000,
          human_required: false,
        };
        return true;
      });
      const path = accountRecoveryStatePath(dir);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(store.read().slots["5"]?.attempts).toBe(2);
      expect(releases).toBe(2);
      const body = readFileSync(path, "utf8");
      expect(body.length).toBeLessThan(16 * 1024);
      expect(body).not.toContain("email");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("state-lock contention fails immediately without entering a blocking acquire", () => {
    const dir = mkdtempSync(join(tmpdir(), "account-recovery-state-"));
    let attempts = 0;
    try {
      const store = createFileRecoveryStateStore(dir, () => {
        attempts += 1;
        return null;
      });
      expect(() => store.read()).toThrow(RecoveryStateLockContentionError);
      expect(() => store.mutate(() => true)).toThrow(
        RecoveryStateLockContentionError,
      );
      expect(attempts).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("automatic account recovery", () => {
  test("chooses one inventory-ordered due slot and applies 3/6 minute backoff", async () => {
    const stateStore = new MemoryStateStore();
    const calls: string[][] = [];
    let now = NOW;
    const expired = observation([
      { slot: 5, issue: "token-expired" },
      { slot: 7, issue: "token-expired" },
    ]);
    const runner = async (argv: string[]): Promise<ProviderRunOutcome> => {
      calls.push(argv);
      return recoveryEnvelope("retry_later", Number(argv[2]));
    };
    const deps = {
      stateDir: "/fake/state",
      runner,
      nowMs: () => now,
      forceRefresh: async () => refreshed(expired),
      cswapBin: CSWAP,
      tryAcquireRecoveryLock: () => lock(),
      stateStore,
    };

    expect((await runAutomaticAccountRecovery(expired, deps))?.outcome).toBe(
      "retry-later",
    );
    expect(calls).toEqual([[CSWAP, "recover", "5", "--json"]]);
    expect(stateStore.state.slots["5"]).toEqual({
      attempts: 1,
      next_attempt_at_ms: NOW + 3 * 60_000,
      human_required: false,
    });

    now = NOW + 2 * 60_000;
    await runAutomaticAccountRecovery(expired, deps);
    expect(calls[1]).toEqual([CSWAP, "recover", "7", "--json"]);
    expect(stateStore.state.slots["5"]?.attempts).toBe(1);

    now = NOW + 3 * 60_000;
    await runAutomaticAccountRecovery(expired, deps);
    expect(calls).toHaveLength(3);
    expect(stateStore.state.slots["5"]?.attempts).toBe(2);
    expect(stateStore.state.slots["5"]?.next_attempt_at_ms).toBe(
      now + 6 * 60_000,
    );
    expect(stateStore.state.slots["7"]?.attempts).toBe(1);
  });

  test("caps the exponential automatic schedule at 60 minutes", async () => {
    const stateStore = new MemoryStateStore();
    let now = NOW;
    for (const expectedMinutes of [3, 6, 12, 24, 48, 60]) {
      const expired = {
        ...observation([{ slot: 5, issue: "token-expired" }]),
        observed_at_ms: now,
      };
      await runAutomaticAccountRecovery(expired, {
        stateDir: "/fake/state",
        runner: async () => recoveryEnvelope("retry_later"),
        nowMs: () => now,
        forceRefresh: async () => refreshed(expired),
        tryAcquireRecoveryLock: () => lock(),
        stateStore,
      });
      const next = stateStore.state.slots["5"]?.next_attempt_at_ms;
      expect(next).toBe(now + expectedMinutes * 60_000);
      if (next === undefined) throw new Error("expected prearmed state");
      now = next;
    }
    expect(stateStore.state.slots["5"]?.attempts).toBe(6);
  });

  test("human-required latches automatic attempts until positive observation", async () => {
    const stateStore = new MemoryStateStore();
    const expired = observation([{ slot: 5, issue: "token-expired" }]);
    let calls = 0;
    let now = NOW;
    const deps = {
      stateDir: "/fake/state",
      runner: async () => {
        calls += 1;
        return recoveryEnvelope("human_required");
      },
      nowMs: () => now,
      forceRefresh: async () => refreshed(expired),
      cswapBin: CSWAP,
      tryAcquireRecoveryLock: () => lock(),
      stateStore,
    };
    expect((await runAutomaticAccountRecovery(expired, deps))?.outcome).toBe(
      "human-required",
    );
    now += 24 * 60 * 60_000;
    expect(await runAutomaticAccountRecovery(expired, deps)).toBeNull();
    expect(calls).toBe(1);

    const healthy = { ...observation([{ slot: 5 }]), observed_at_ms: now };
    expect(await runAutomaticAccountRecovery(healthy, deps)).toBeNull();
    expect(stateStore.state.slots).toEqual({});
  });

  test("recovery output remains unverified until the forced second list clears expiry", async () => {
    const stateStore = new MemoryStateStore();
    const expired = observation([{ slot: 5, issue: "token-expired" }]);
    let refreshes = 0;
    const outcome = await runAutomaticAccountRecovery(expired, {
      stateDir: "/fake/state",
      runner: async () => recoveryEnvelope("recovered"),
      nowMs: () => NOW,
      forceRefresh: async () => {
        refreshes += 1;
        return refreshed(expired);
      },
      cswapBin: CSWAP,
      tryAcquireRecoveryLock: () => lock(),
      stateStore,
    });
    expect(refreshes).toBe(2);
    expect(outcome).toMatchObject({
      outcome: "recovery-unverified",
      ok: false,
      problem_code: "route-unverified",
    });
    expect(stateStore.state.slots["5"]?.next_attempt_at_ms).toBe(
      NOW + 3 * 60_000,
    );
  });

  test("prearms before invocation and a thrown runner leaves the slot suppressed", async () => {
    const stateStore = new MemoryStateStore();
    const expired = observation([{ slot: 5, issue: "token-expired" }]);
    let calls = 0;
    const deps = {
      stateDir: "/fake/state",
      runner: async (): Promise<ProviderRunOutcome> => {
        calls += 1;
        expect(stateStore.state.slots["5"]).toEqual({
          attempts: 1,
          next_attempt_at_ms: NOW + 3 * 60_000,
          human_required: false,
        });
        throw new Error("simulated crash after durable begin");
      },
      nowMs: () => NOW,
      forceRefresh: async () => refreshed(expired),
      tryAcquireRecoveryLock: () => lock(),
      stateStore,
    };

    expect((await runAutomaticAccountRecovery(expired, deps))?.outcome).toBe(
      "tool-failure",
    );
    expect(await runAutomaticAccountRecovery(expired, deps)).toBeNull();
    expect(calls).toBe(1);
    expect(stateStore.state.slots["5"]?.attempts).toBe(1);
  });

  test("a failed begin-state write prevents the recovery side effect", async () => {
    const expired = observation([{ slot: 5, issue: "token-expired" }]);
    let calls = 0;
    const outcome = await runAutomaticAccountRecovery(expired, {
      stateDir: "/fake/state",
      runner: async () => {
        calls += 1;
        return recoveryEnvelope("recovered");
      },
      nowMs: () => NOW,
      forceRefresh: async () => refreshed(expired),
      tryAcquireRecoveryLock: () => lock(),
      stateStore: new FailingBeginStateStore(),
    });
    expect(outcome).toMatchObject({
      outcome: "tool-failure",
      problem_code: "tool-failure",
    });
    expect(calls).toBe(0);
  });

  test("revalidates the selected stable route and never switches to a peer slot", async () => {
    const initiallyExpired = observation([
      { slot: 5, issue: "token-expired" },
      { slot: 7, issue: "token-expired" },
    ]);
    const raced = observation([
      { slot: 5 },
      { slot: 7, issue: "token-expired" },
    ]);
    let calls = 0;
    const outcome = await runAutomaticAccountRecovery(initiallyExpired, {
      stateDir: "/fake/state",
      runner: async () => {
        calls += 1;
        return recoveryEnvelope("recovered");
      },
      nowMs: () => NOW,
      forceRefresh: async () => refreshed(raced),
      tryAcquireRecoveryLock: () => lock(),
      stateStore: new MemoryStateStore(),
    });
    expect(outcome).toBeNull();
    expect(calls).toBe(0);
  });

  test("a non-owned revalidation is unverified and never invokes recovery", async () => {
    const expired = observation([{ slot: 5, issue: "token-expired" }]);
    let calls = 0;
    const outcome = await runAutomaticAccountRecovery(expired, {
      stateDir: "/fake/state",
      runner: async () => {
        calls += 1;
        return recoveryEnvelope("recovered");
      },
      nowMs: () => NOW,
      forceRefresh: async () => ({
        outcome: "peer-published",
        observation: expired,
      }),
      tryAcquireRecoveryLock: () => lock(),
      stateStore: new MemoryStateStore(),
    });
    expect(outcome).toMatchObject({
      outcome: "recovery-unverified",
      problem_code: "route-unverified",
    });
    expect(calls).toBe(0);
  });

  test("a contended selected slot defers without trying another slot", async () => {
    const expired = observation([
      { slot: 5, issue: "token-expired" },
      { slot: 7, issue: "token-expired" },
    ]);
    let calls = 0;
    expect(
      await runAutomaticAccountRecovery(expired, {
        stateDir: "/fake/state",
        runner: async () => {
          calls += 1;
          return recoveryEnvelope("recovered");
        },
        nowMs: () => NOW,
        forceRefresh: async () => refreshed(expired),
        tryAcquireRecoveryLock: () => null,
        stateStore: new MemoryStateStore(),
      }),
    ).toBeNull();
    expect(calls).toBe(0);
  });
});

describe("foreground account recovery", () => {
  test("collapses refresh and state failures to bounded tool outcomes", async () => {
    const refreshFailure = await runForegroundAccountRecovery({
      ordinal: 0,
      stateDir: "/private/path",
      runner: async () => recoveryEnvelope("recovered"),
      nowMs: () => NOW,
      forceRefresh: async () => {
        throw new Error("sensitive external detail");
      },
      tryAcquireRecoveryLock: () => lock(),
      stateStore: new MemoryStateStore(),
    });
    expect(refreshFailure).toEqual({
      schema_version: 1,
      operation: "recover",
      account: "c0",
      outcome: "tool-failure",
      ok: false,
      problem_code: "tool-failure",
    });
    expect(JSON.stringify(refreshFailure)).not.toContain("sensitive");
  });

  test("held state lock returns bounded busy without invoking recovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "account-recovery-state-"));
    let calls = 0;
    try {
      const outcome = await runForegroundAccountRecovery({
        ordinal: 0,
        stateDir: dir,
        runner: async () => {
          calls += 1;
          return recoveryEnvelope("recovered");
        },
        nowMs: () => NOW,
        forceRefresh: async () =>
          refreshed(observation([{ slot: 5, issue: "token-expired" }])),
        tryAcquireRecoveryLock: () => lock(),
        stateStore: createFileRecoveryStateStore(dir, () => null),
      });
      expect(outcome).toMatchObject({
        outcome: "tool-failure",
        problem_code: "recovery-busy",
      });
      expect(calls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed post-recovery list stays unverified and arms backoff", async () => {
    const stateStore = new MemoryStateStore();
    const expired = observation([{ slot: 5, issue: "token-expired" }]);
    let refreshes = 0;
    const outcome = await runForegroundAccountRecovery({
      ordinal: 0,
      stateDir: "/fake/state",
      runner: async () => recoveryEnvelope("recovered"),
      nowMs: () => NOW,
      forceRefresh: async () => {
        refreshes += 1;
        if (refreshes <= 2) return refreshed(expired);
        throw new Error("private provider failure");
      },
      tryAcquireRecoveryLock: () => lock(),
      stateStore,
    });
    expect(outcome).toMatchObject({
      outcome: "recovery-unverified",
      problem_code: "route-unverified",
    });
    expect(stateStore.state.slots["5"]?.next_attempt_at_ms).toBe(
      NOW + 3 * 60_000,
    );
  });

  test("returns not-needed without recovery when the forced inventory route is healthy", async () => {
    let runnerCalls = 0;
    const outcome = await runForegroundAccountRecovery({
      ordinal: 0,
      stateDir: "/fake/state",
      runner: async () => {
        runnerCalls += 1;
        return recoveryEnvelope("recovered");
      },
      nowMs: () => NOW,
      forceRefresh: async () => refreshed(observation([{ slot: 5 }])),
      tryAcquireRecoveryLock: () => lock(),
      stateStore: new MemoryStateStore(),
    });
    expect(outcome).toEqual({
      schema_version: 1,
      operation: "recover",
      account: "c0",
      outcome: "not-needed",
      ok: true,
      problem_code: null,
    });
    expect(runnerCalls).toBe(0);
  });

  test("refuses a non-token issue without invoking recovery", async () => {
    let runnerCalls = 0;
    const stateStore = new MemoryStateStore();
    stateStore.state.slots["5"] = {
      attempts: 1,
      next_attempt_at_ms: NOW + 60_000,
      human_required: true,
    };
    const outcome = await runForegroundAccountRecovery({
      ordinal: 0,
      stateDir: "/fake/state",
      runner: async () => {
        runnerCalls += 1;
        return recoveryEnvelope("recovered");
      },
      nowMs: () => NOW,
      forceRefresh: async () =>
        refreshed(observation([{ slot: 5, issue: "relogin-required" }])),
      tryAcquireRecoveryLock: () => lock(),
      stateStore,
    });
    expect(outcome).toMatchObject({
      outcome: "recovery-unverified",
      ok: false,
      problem_code: "account-not-token-expired",
    });
    expect(runnerCalls).toBe(0);
    expect(stateStore.state.slots).toEqual({});
  });

  test("revalidates under the slot lock and skips a route repaired by a delayed peer", async () => {
    const stateStore = new MemoryStateStore();
    stateStore.state.slots["5"] = {
      attempts: 1,
      next_attempt_at_ms: NOW + 60_000,
      human_required: true,
    };
    const expired = observation([{ slot: 5, issue: "token-expired" }]);
    const healthy = observation([{ slot: 5 }]);
    const refreshes = [refreshed(expired), refreshed(healthy)];
    let calls = 0;
    const outcome = await runForegroundAccountRecovery({
      ordinal: 0,
      stateDir: "/fake/state",
      runner: async () => {
        calls += 1;
        return recoveryEnvelope("recovered");
      },
      nowMs: () => NOW,
      forceRefresh: async () => nextRefresh(refreshes),
      tryAcquireRecoveryLock: () => lock(),
      stateStore,
    });
    expect(outcome).toMatchObject({ outcome: "not-needed", ok: true });
    expect(calls).toBe(0);
    expect(stateStore.state.slots).toEqual({});
  });

  test("a foreground begin-state failure is bounded and prevents recovery", async () => {
    const expired = observation([{ slot: 5, issue: "token-expired" }]);
    let calls = 0;
    const outcome = await runForegroundAccountRecovery({
      ordinal: 0,
      stateDir: "/fake/state",
      runner: async () => {
        calls += 1;
        return recoveryEnvelope("recovered");
      },
      nowMs: () => NOW,
      forceRefresh: async () => refreshed(expired),
      tryAcquireRecoveryLock: () => lock(),
      stateStore: new FailingBeginStateStore(),
    });
    expect(outcome).toMatchObject({
      outcome: "tool-failure",
      problem_code: "tool-failure",
    });
    expect(calls).toBe(0);
  });

  test("uses exact recovery argv and requires a second fresh healthy route", async () => {
    const calls: string[][] = [];
    const expired = observation([{ slot: 5, issue: "token-expired" }]);
    const healthy = observation([{ slot: 5 }]);
    const refreshes = [
      refreshed(expired),
      refreshed(expired),
      refreshed(healthy),
    ];
    const outcome = await runForegroundAccountRecovery({
      ordinal: 0,
      stateDir: "/fake/state",
      runner: async (argv) => {
        calls.push(argv);
        return recoveryEnvelope("recovered");
      },
      nowMs: () => NOW,
      forceRefresh: async () => nextRefresh(refreshes),
      cswapBin: CSWAP,
      tryAcquireRecoveryLock: () => lock(),
      stateStore: new MemoryStateStore(),
    });
    expect(calls).toEqual([[CSWAP, "recover", "5", "--json"]]);
    expect(outcome).toMatchObject({ outcome: "recovered", ok: true });
    expect(refreshes).toHaveLength(0);
  });

  test("foreground bypasses a human latch but keeps per-slot single-flight", async () => {
    const stateStore = new MemoryStateStore();
    stateStore.state.slots["5"] = {
      attempts: 1,
      next_attempt_at_ms: NOW + 60 * 60_000,
      human_required: true,
    };
    const expired = observation([{ slot: 5, issue: "token-expired" }]);
    let recoveryCalls = 0;
    const outcome = await runForegroundAccountRecovery({
      ordinal: 0,
      stateDir: "/fake/state",
      runner: async () => {
        recoveryCalls += 1;
        expect(stateStore.state.slots["5"]).toEqual({
          attempts: 2,
          next_attempt_at_ms: NOW + 6 * 60_000,
          human_required: false,
        });
        return recoveryEnvelope("retry_later");
      },
      nowMs: () => NOW,
      forceRefresh: async () => refreshed(expired),
      tryAcquireRecoveryLock: () => lock(),
      stateStore,
    });
    expect(recoveryCalls).toBe(1);
    expect(outcome.outcome).toBe("retry-later");
    expect(stateStore.state.slots["5"]?.human_required).toBe(false);

    const busy = await runForegroundAccountRecovery({
      ordinal: 0,
      stateDir: "/fake/state",
      runner: async () => {
        throw new Error("must not run while locked");
      },
      nowMs: () => NOW,
      forceRefresh: async () => refreshed(expired),
      tryAcquireRecoveryLock: () => null,
      stateStore,
    });
    expect(busy).toMatchObject({
      outcome: "tool-failure",
      problem_code: "recovery-busy",
    });
  });
});

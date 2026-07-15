/**
 * Lifecycle pins for the Capacity-observation producer (`src/account-observer-worker.ts`):
 * one observe cycle over an INJECTED exact-argv runner (both providers healthy,
 * each absent, partial failure), the exact argv passed to the runner, the atomic
 * sidecar publish, the no-throw cycle guard, and the abort-terminated loop.
 *
 * Provider-cycle tests inject canned outcomes + a pinned clock and a sandboxed
 * state dir. One runner-policy test starts only the current Bun executable to
 * inspect its environment; no provider, worker thread, daemon, or Keychain path
 * runs (the worker body is `isMainThread`-guarded, so importing it here is inert).
 */

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
  makeBoundedRunner,
  type ObserverClock,
  observeOnce,
  providerSubprocessEnvironment,
  publishObservation,
} from "../src/account-observer-worker";
import {
  codexBarUsageArgv,
  cswapListArgv,
  NATIVE_ROUTE_ID,
  observationSidecarPath,
} from "../src/account-routing-config";

const NOW_MS = Date.UTC(2026, 5, 1, 12, 0, 0);

const CB_ARGV = ["CB"];
const CS_ARGV = ["CS"];

function codexOk(): ProviderRunOutcome {
  return {
    code: 0,
    stdout: JSON.stringify({
      provider: "claude",
      usage: { primary: { usedPercent: 20 }, secondary: { usedPercent: 30 } },
    }),
  };
}

function cswapOk(slot: number): ProviderRunOutcome {
  return {
    code: 0,
    stdout: JSON.stringify({
      schemaVersion: 1,
      accounts: [
        {
          number: slot,
          usageStatus: "ok",
          usage: { fiveHour: { pct: 10 }, sevenDay: { pct: 5 } },
          usageAgeSeconds: 15,
        },
      ],
    }),
  };
}

/** A runner that returns canned outcomes keyed on the first argv token, recording calls. */
function stubRunner(
  codex: ProviderRunOutcome,
  cswap: ProviderRunOutcome,
): { runner: ExactArgvRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: ExactArgvRunner = async (argv) => {
    calls.push(argv);
    if (argv[0] === "CB") return codex;
    if (argv[0] === "CS") return cswap;
    return { code: null, stdout: "" };
  };
  return { runner, calls };
}

// ---------- observeOnce -----------------------------------------------------

describe("observeOnce", () => {
  test("both providers healthy → native + managed routes, health ok", async () => {
    const { runner } = stubRunner(codexOk(), cswapOk(3));
    const obs = await observeOnce({
      runner,
      nowMs: () => NOW_MS,
      codexbarArgv: CB_ARGV,
      cswapArgv: CS_ARGV,
    });
    expect(obs.health).toBe("ok");
    expect(obs.routes.map((r) => r.id)).toEqual([
      NATIVE_ROUTE_ID,
      "claude-swap:3",
    ]);
    expect(obs.observed_at_ms).toBe(NOW_MS);
    // native carries CodexBar's ambient windows: 20% / 30% used → 0.2 / 0.3.
    expect(obs.routes[0].windows).toEqual([
      { key: "session", utilization: 0.2, resetsAt: null },
      { key: "week", utilization: 0.3, resetsAt: null },
    ]);
  });

  test("CodexBar absent → health absent, native carries no windows", async () => {
    // cswap is healthy, but a closed CodexBar gate means the native route carries
    // no ambient capacity (the router will disable balancing regardless).
    const { runner } = stubRunner({ code: null, stdout: "" }, cswapOk(3));
    const obs = await observeOnce({
      runner,
      nowMs: () => NOW_MS,
      codexbarArgv: CB_ARGV,
      cswapArgv: CS_ARGV,
    });
    expect(obs.health).toBe("absent");
    expect(obs.routes[0]).toMatchObject({ id: NATIVE_ROUTE_ID, windows: [] });
  });

  test("claude-swap absent → native only, no error surfaced", async () => {
    const { runner } = stubRunner(codexOk(), { code: null, stdout: "" });
    const obs = await observeOnce({
      runner,
      nowMs: () => NOW_MS,
      codexbarArgv: CB_ARGV,
      cswapArgv: CS_ARGV,
    });
    expect(obs.health).toBe("ok");
    expect(obs.routes.map((r) => r.id)).toEqual([NATIVE_ROUTE_ID]);
  });

  test("partial failure: CodexBar ok, claude-swap errored → native only", async () => {
    const { runner } = stubRunner(codexOk(), {
      code: 1,
      stdout: JSON.stringify({
        schemaVersion: 1,
        error: { type: "X", message: "y" },
      }),
    });
    const obs = await observeOnce({
      runner,
      nowMs: () => NOW_MS,
      codexbarArgv: CB_ARGV,
      cswapArgv: CS_ARGV,
    });
    expect(obs.health).toBe("ok");
    expect(obs.routes.map((r) => r.id)).toEqual([NATIVE_ROUTE_ID]);
  });

  test("invokes each provider through the runner with EXACTLY its argv", async () => {
    const { runner, calls } = stubRunner(codexOk(), cswapOk(3));
    await observeOnce({
      runner,
      nowMs: () => NOW_MS,
      codexbarArgv: CB_ARGV,
      cswapArgv: CS_ARGV,
    });
    expect(calls).toContainEqual(CB_ARGV);
    expect(calls).toContainEqual(CS_ARGV);
  });

  test("defaults to the config exact-argv when none is injected (no shell)", async () => {
    const calls: string[][] = [];
    const runner: ExactArgvRunner = async (argv) => {
      calls.push(argv);
      return { code: null, stdout: "" };
    };
    await observeOnce({ runner, nowMs: () => NOW_MS });
    expect(calls).toContainEqual(codexBarUsageArgv());
    expect(calls).toContainEqual(cswapListArgv());
  });
});

// ---------- subprocess safety -----------------------------------------------

describe("production provider subprocess policy", () => {
  test("forces CodexBar Keychain access off without mutating inherited env", () => {
    const inherited = {
      PATH: "/test/bin",
      CODEXBAR_DISABLE_KEYCHAIN_ACCESS: "0",
      SENTINEL: "preserved",
    };

    expect(providerSubprocessEnvironment(inherited)).toEqual({
      PATH: "/test/bin",
      CODEXBAR_DISABLE_KEYCHAIN_ACCESS: "1",
      SENTINEL: "preserved",
    });
    expect(inherited.CODEXBAR_DISABLE_KEYCHAIN_ACCESS).toBe("0");
  });

  test("the bounded runner passes the forced safety flag to its child", async () => {
    const runner = makeBoundedRunner(5_000, 4_096, {
      CODEXBAR_DISABLE_KEYCHAIN_ACCESS: "0",
    });
    const outcome = await runner([
      process.execPath,
      "-e",
      "process.stdout.write(process.env.CODEXBAR_DISABLE_KEYCHAIN_ACCESS ?? 'missing')",
    ]);

    expect(outcome).toEqual({ code: 0, stdout: "1" });
  });
});

// ---------- publish + loop --------------------------------------------------

describe("AccountObserver", () => {
  test("runCycleNoThrow publishes a readable sidecar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-obs-worker-"));
    try {
      const { runner } = stubRunner(codexOk(), cswapOk(3));
      const observer = new AccountObserver({
        stateDir: dir,
        runner,
        clock: { nowMs: () => NOW_MS, uniform: () => 0, sleep: async () => {} },
        shutdownSignal: new AbortController().signal,
        codexbarArgv: CB_ARGV,
        cswapArgv: CS_ARGV,
      });
      await observer.runCycleNoThrow();
      const obs = readObservationSidecar(observationSidecarPath(dir));
      expect(obs?.health).toBe("ok");
      expect(obs?.routes.map((r) => r.id)).toEqual([
        NATIVE_ROUTE_ID,
        "claude-swap:3",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a throwing runner degrades to a no-op — never escapes the cycle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-obs-worker-"));
    try {
      const runner: ExactArgvRunner = async () => {
        throw new Error("boom");
      };
      const observer = new AccountObserver({
        stateDir: dir,
        runner,
        clock: { nowMs: () => NOW_MS, uniform: () => 0, sleep: async () => {} },
        shutdownSignal: new AbortController().signal,
        codexbarArgv: CB_ARGV,
        cswapArgv: CS_ARGV,
      });
      // No throw, and nothing published (no prior sidecar to preserve).
      await observer.runCycleNoThrow();
      expect(readObservationSidecar(observationSidecarPath(dir))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the loop runs a cycle then exits on the shutdown signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-obs-worker-"));
    try {
      const { runner, calls } = stubRunner(codexOk(), cswapOk(3));
      const controller = new AbortController();
      // The first inter-cycle sleep aborts, so the loop settles after ONE cycle.
      const clock: ObserverClock = {
        nowMs: () => NOW_MS,
        uniform: () => 0,
        sleep: async (_ms, signal) => {
          controller.abort();
          void signal;
        },
      };
      const observer = new AccountObserver({
        stateDir: dir,
        runner,
        clock,
        shutdownSignal: controller.signal,
        codexbarArgv: CB_ARGV,
        cswapArgv: CS_ARGV,
      });
      await observer.run();
      // Exactly one cycle → two provider calls (codex + cswap), one publish.
      expect(calls).toHaveLength(2);
      expect(readObservationSidecar(observationSidecarPath(dir))?.health).toBe(
        "ok",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- direct publish --------------------------------------------------

test("publishObservation creates the state dir and writes an atomic sidecar", () => {
  const base = mkdtempSync(join(tmpdir(), "acct-obs-worker-"));
  try {
    // A not-yet-existing nested state dir — publish must mkdir it.
    const dir = join(base, "nested", "routing");
    publishObservation(dir, {
      schema_version: 1,
      observed_at_ms: NOW_MS,
      health: "ok",
      routes: [
        {
          id: NATIVE_ROUTE_ID,
          kind: "native",
          slot: null,
          windows: [],
          measuredAtMs: NOW_MS,
        },
      ],
      notes: [],
    });
    expect(
      readObservationSidecar(observationSidecarPath(dir))?.observed_at_ms,
    ).toBe(NOW_MS);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

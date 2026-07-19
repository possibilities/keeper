import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_FAILURE_COOLDOWN_MS,
  CODEX_OBSERVATION_SCHEMA_VERSION,
  CODEX_PRESSURE_TTL_MS,
  codexObservationSidecarPath,
  codexPressureLedgerPath,
} from "../src/account-routing-config";
import {
  type CodexCapacityAlias,
  type CodexCapacityObservation,
  writeCodexObservationSidecar,
} from "../src/codex-account-observation";
import {
  CODEX_NATIVE_FALLBACK_WARNING,
  inspectCodexRouting,
  recordCodexRouteOutcome,
  selectCodexRoute,
} from "../src/codex-account-router";

const NOW = Date.parse("2026-07-18T12:00:00Z");
const BINDING = "c".repeat(64);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-router-"));
  roots.push(dir);
  return dir;
}

function alias(
  name: string,
  usedPercent: number,
  options: {
    status?: CodexCapacityAlias["status"];
    failureClass?: CodexCapacityAlias["failure_class"];
  } = {},
): CodexCapacityAlias {
  const status = options.status ?? "healthy";
  return {
    alias: name,
    status,
    observed_at_ms: NOW,
    expires_at_ms: NOW + 180_000,
    windows:
      status === "unavailable"
        ? []
        : [
            {
              role: "primary",
              used_percent: usedPercent,
              reset_at_ms: NOW + 180_000,
            },
          ],
    ...(options.failureClass ? { failure_class: options.failureClass } : {}),
  };
}

function observation(
  aliases: CodexCapacityAlias[],
  observedAtMs = NOW,
): CodexCapacityObservation {
  return {
    schema_version: CODEX_OBSERVATION_SCHEMA_VERSION,
    provider: "openai-codex",
    config_binding: BINDING,
    observed_at_ms: observedAtMs,
    aliases,
  };
}

function publish(
  dir: string,
  aliases: CodexCapacityAlias[],
  observedAtMs = NOW,
): void {
  writeCodexObservationSidecar(
    codexObservationSidecarPath(dir),
    observation(aliases, observedAtMs),
  );
}

function lock(): { release(): void } {
  return { release() {} };
}

const injectedLock = () => lock();

describe("Codex route selection", () => {
  test("missing, stale, and all-unavailable evidence visibly falls back", () => {
    const dir = root();
    expect(
      selectCodexRoute({
        stateDir: dir,
        nowMs: NOW,
        tryAcquireLock: injectedLock,
      }),
    ).toEqual({
      kind: "native-fallback",
      provider: "openai-codex",
      reason: "observation-missing",
      warning: CODEX_NATIVE_FALLBACK_WARNING,
    });

    publish(dir, [alias("keeper-codex-a", 10)], NOW - 90_001);
    expect(
      selectCodexRoute({
        stateDir: dir,
        nowMs: NOW,
        tryAcquireLock: injectedLock,
      }),
    ).toMatchObject({ kind: "native-fallback", reason: "observation-stale" });

    publish(dir, [
      alias("keeper-codex-a", 0, {
        status: "unavailable",
        failureClass: "auth",
      }),
      alias("keeper-codex-b", 100, { status: "exhausted" }),
    ]);
    const unavailable = selectCodexRoute({
      stateDir: dir,
      nowMs: NOW,
      tryAcquireLock: injectedLock,
    });
    expect(unavailable).toEqual({
      kind: "native-fallback",
      provider: "openai-codex",
      reason: "pool-unavailable",
      warning: CODEX_NATIVE_FALLBACK_WARNING,
    });
  });

  test("chooses greatest worst-window headroom", () => {
    const dir = root();
    publish(dir, [alias("keeper-codex-a", 70), alias("keeper-codex-b", 20)]);
    expect(
      selectCodexRoute({
        stateDir: dir,
        nowMs: NOW,
        tryAcquireLock: injectedLock,
      }),
    ).toEqual({
      kind: "pooled",
      provider: "openai-codex",
      alias: "keeper-codex-b",
      reason: "selected",
    });
  });

  test("pressure and deterministic LRU spread equal candidates", () => {
    const dir = root();
    publish(dir, [alias("keeper-codex-a", 20), alias("keeper-codex-b", 20)]);
    const first = selectCodexRoute({
      stateDir: dir,
      nowMs: NOW,
      tryAcquireLock: injectedLock,
    });
    const second = selectCodexRoute({
      stateDir: dir,
      nowMs: NOW + 1,
      tryAcquireLock: injectedLock,
    });
    expect(first).toMatchObject({ kind: "pooled", alias: "keeper-codex-a" });
    expect(second).toMatchObject({ kind: "pooled", alias: "keeper-codex-b" });
    const ledger = JSON.parse(
      readFileSync(codexPressureLedgerPath(dir), "utf8"),
    );
    expect(ledger.provider).toBe("openai-codex");
    expect(Object.keys(ledger.aliases)).toEqual([
      "keeper-codex-a",
      "keeper-codex-b",
    ]);
  });

  test("crashed-process pressure expires and is cleaned on the next choice", () => {
    const dir = root();
    publish(dir, [alias("keeper-codex-a", 20), alias("keeper-codex-b", 20)]);
    selectCodexRoute({
      stateDir: dir,
      nowMs: NOW,
      tryAcquireLock: injectedLock,
    });
    selectCodexRoute({
      stateDir: dir,
      nowMs: NOW + 1,
      tryAcquireLock: injectedLock,
    });
    const afterExpiry = selectCodexRoute({
      stateDir: dir,
      nowMs: NOW + CODEX_PRESSURE_TTL_MS + 2,
      tryAcquireLock: injectedLock,
    });
    expect(afterExpiry).toMatchObject({
      kind: "pooled",
      alias: "keeper-codex-a",
    });
    const ledger = JSON.parse(
      readFileSync(codexPressureLedgerPath(dir), "utf8"),
    );
    expect(ledger.aliases["keeper-codex-a"].reservations).toEqual([
      NOW + CODEX_PRESSURE_TTL_MS + 2,
    ]);
    expect(ledger.aliases["keeper-codex-b"].reservations).toEqual([]);
  });

  test("cooldowns exclude failures and recover half-open after expiry", () => {
    const dir = root();
    publish(dir, [alias("keeper-codex-a", 20), alias("keeper-codex-b", 20)]);
    expect(
      selectCodexRoute({
        stateDir: dir,
        nowMs: NOW,
        tryAcquireLock: injectedLock,
      }),
    ).toMatchObject({ alias: "keeper-codex-a" });
    expect(
      recordCodexRouteOutcome({
        stateDir: dir,
        nowMs: NOW,
        alias: "keeper-codex-a",
        outcome: "quota",
        tryAcquireLock: injectedLock,
      }),
    ).toBe(true);
    expect(
      selectCodexRoute({
        stateDir: dir,
        nowMs: NOW + 1,
        tryAcquireLock: injectedLock,
      }),
    ).toMatchObject({ alias: "keeper-codex-b" });
    expect(
      recordCodexRouteOutcome({
        stateDir: dir,
        nowMs: NOW + 1,
        alias: "keeper-codex-b",
        outcome: "rate",
        tryAcquireLock: injectedLock,
      }),
    ).toBe(true);
    expect(
      selectCodexRoute({
        stateDir: dir,
        nowMs: NOW + 2,
        tryAcquireLock: injectedLock,
      }),
    ).toMatchObject({ kind: "native-fallback", reason: "pool-unavailable" });
    expect(
      selectCodexRoute({
        stateDir: dir,
        nowMs: NOW + CODEX_FAILURE_COOLDOWN_MS,
        tryAcquireLock: injectedLock,
      }),
    ).toEqual({
      kind: "pooled",
      provider: "openai-codex",
      alias: "keeper-codex-a",
      reason: "cooldown-recovered",
    });
  });

  test("lock contention is a bounded native fallback", () => {
    const dir = root();
    publish(dir, [alias("keeper-codex-a", 10)]);
    let attempts = 0;
    expect(
      selectCodexRoute({
        stateDir: dir,
        nowMs: NOW,
        tryAcquireLock: () => {
          attempts += 1;
          return null;
        },
      }),
    ).toMatchObject({
      kind: "native-fallback",
      reason: "pressure-contended",
    });
    expect(attempts).toBe(1);
  });

  test("a corrupt or mismatched ledger cannot create durable starvation", () => {
    const dir = root();
    publish(dir, [alias("keeper-codex-a", 10)]);
    writeFileSync(
      codexPressureLedgerPath(dir),
      JSON.stringify({
        schema_version: 1,
        provider: "openai-codex",
        config_binding: "d".repeat(64),
        aliases: {
          "keeper-codex-a": {
            reservations: [Number.MAX_SAFE_INTEGER],
            cooldown_until_ms: Number.MAX_SAFE_INTEGER,
            last_selected_at_ms: Number.MAX_SAFE_INTEGER,
          },
        },
      }),
    );
    expect(
      selectCodexRoute({
        stateDir: dir,
        nowMs: NOW,
        tryAcquireLock: injectedLock,
      }),
    ).toMatchObject({ kind: "pooled", alias: "keeper-codex-a" });
  });
});

describe("Codex routing inspection", () => {
  test("reports the same choice without creating pressure", () => {
    const dir = root();
    publish(dir, [alias("keeper-codex-a", 60), alias("keeper-codex-b", 10)]);
    const result = inspectCodexRouting({ stateDir: dir, nowMs: NOW });
    expect(result).toMatchObject({
      provider: "openai-codex",
      health: "ready",
      fresh: true,
      verdict: { kind: "pooled", alias: "keeper-codex-b" },
    });
    expect(result.candidates.map((candidate) => candidate.alias)).toEqual([
      "keeper-codex-a",
      "keeper-codex-b",
    ]);
    expect(existsSync(codexPressureLedgerPath(dir))).toBe(false);
  });
});

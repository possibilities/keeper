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
  CODEX_PRESSURE_LEDGER_SCHEMA_VERSION,
  CODEX_PRESSURE_TTL_MS,
  codexObservationSidecarPath,
  codexPressureLedgerPath,
} from "../src/account-routing-config";
import {
  type CodexCapacityAlias,
  type CodexCapacityObservation,
  type CodexCapacityWindow,
  writeCodexObservationSidecar,
} from "../src/codex-account-observation";
import {
  CODEX_NATIVE_FALLBACK_WARNING,
  inspectCodexRouting,
  recordCodexRouteOutcome,
  selectCodexRoute,
} from "../src/codex-account-router";
import {
  CODEX_GENERIC_QUOTA_SCOPE,
  CODEX_SPARK_QUOTA_SCOPE,
  type CodexQuotaScope,
} from "../src/codex-quota-scope";

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

function windowFor(
  quotaScope: CodexQuotaScope,
  usedPercent: number,
): CodexCapacityWindow {
  return {
    role: "primary",
    quota_scope: quotaScope,
    key: quotaScope === CODEX_GENERIC_QUOTA_SCOPE ? "session" : "model:spark",
    label: quotaScope === CODEX_GENERIC_QUOTA_SCOPE ? "session" : "spark",
    window_seconds: 18_000,
    used_percent: usedPercent,
    exhausted: usedPercent >= 100,
    reset_at_ms: NOW + 180_000,
  };
}

function alias(
  name: string,
  usedPercent: number,
  options: {
    status?: CodexCapacityAlias["status"];
    failureClass?: CodexCapacityAlias["failure_class"];
    sparkUsedPercent?: number;
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
            windowFor(CODEX_GENERIC_QUOTA_SCOPE, usedPercent),
            ...(options.sparkUsedPercent === undefined
              ? []
              : [windowFor(CODEX_SPARK_QUOTA_SCOPE, options.sparkUsedPercent)]),
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

  test("chooses greatest scoped headroom", () => {
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
    expect(ledger.schema_version).toBe(CODEX_PRESSURE_LEDGER_SCHEMA_VERSION);
    expect(ledger.provider).toBe("openai-codex");
    expect(Object.keys(ledger.aliases)).toEqual([
      "keeper-codex-a",
      "keeper-codex-b",
    ]);
    expect(ledger.aliases["keeper-codex-a"]).toMatchObject({
      shared_cooldown_until_ms: 0,
      quota_cooldown_until_ms: {
        [CODEX_GENERIC_QUOTA_SCOPE]: 0,
        [CODEX_SPARK_QUOTA_SCOPE]: 0,
      },
    });
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

  test("uses exact quota scope so generic exhaustion does not hide Spark", () => {
    const dir = root();
    publish(dir, [
      alias("keeper-codex-a", 100, { sparkUsedPercent: 0 }),
      alias("keeper-codex-b", 80, { sparkUsedPercent: 6 }),
    ]);
    expect(
      selectCodexRoute({
        stateDir: dir,
        nowMs: NOW,
        quotaScope: CODEX_SPARK_QUOTA_SCOPE,
        tryAcquireLock: injectedLock,
      }),
    ).toMatchObject({ kind: "pooled", alias: "keeper-codex-a" });
    expect(
      selectCodexRoute({
        stateDir: dir,
        nowMs: NOW + 1,
        tryAcquireLock: injectedLock,
      }),
    ).toMatchObject({ kind: "pooled", alias: "keeper-codex-b" });
  });

  test("Spark exhaustion does not hide generic capacity", () => {
    const dir = root();
    publish(dir, [
      alias("keeper-codex-a", 10, { sparkUsedPercent: 100 }),
      alias("keeper-codex-b", 20, { sparkUsedPercent: 0 }),
    ]);
    expect(
      selectCodexRoute({
        stateDir: dir,
        nowMs: NOW,
        tryAcquireLock: injectedLock,
      }),
    ).toMatchObject({ kind: "pooled", alias: "keeper-codex-a" });
  });

  test("missing Spark evidence fails closed for Spark", () => {
    const dir = root();
    publish(dir, [alias("keeper-codex-a", 10)]);
    expect(
      selectCodexRoute({
        stateDir: dir,
        nowMs: NOW,
        quotaScope: CODEX_SPARK_QUOTA_SCOPE,
        tryAcquireLock: injectedLock,
      }),
    ).toEqual({
      kind: "native-fallback",
      provider: "openai-codex",
      reason: "pool-unavailable",
      warning: CODEX_NATIVE_FALLBACK_WARNING,
    });
  });

  test("explicit authorization restricts candidates and empty disables pooling", () => {
    const dir = root();
    publish(dir, [alias("keeper-codex-a", 1), alias("keeper-codex-b", 90)]);
    expect(
      selectCodexRoute({
        stateDir: dir,
        nowMs: NOW,
        authorizedAliases: ["not-an-alias", "keeper-codex-b"],
        tryAcquireLock: injectedLock,
      }),
    ).toMatchObject({ kind: "pooled", alias: "keeper-codex-b" });
    expect(
      selectCodexRoute({
        stateDir: dir,
        nowMs: NOW + 1,
        authorizedAliases: ["keeper-codex-missing"],
        tryAcquireLock: injectedLock,
      }),
    ).toMatchObject({ kind: "native-fallback", reason: "pool-unavailable" });
    expect(
      selectCodexRoute({
        stateDir: dir,
        nowMs: NOW + 2,
        authorizedAliases: [],
        tryAcquireLock: injectedLock,
      }),
    ).toMatchObject({ kind: "native-fallback", reason: "pool-unavailable" });
    expect(
      recordCodexRouteOutcome({
        stateDir: dir,
        nowMs: NOW + 3,
        alias: "keeper-codex-a",
        outcome: "quota",
        authorizedAliases: ["keeper-codex-b"],
        tryAcquireLock: injectedLock,
      }),
    ).toBe(false);
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

  test("quota cooldowns isolate requested scopes", () => {
    const dir = root();
    publish(dir, [alias("keeper-codex-a", 20, { sparkUsedPercent: 0 })]);
    expect(
      selectCodexRoute({
        stateDir: dir,
        nowMs: NOW,
        tryAcquireLock: injectedLock,
      }),
    ).toMatchObject({ kind: "pooled", alias: "keeper-codex-a" });
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
    ).toMatchObject({ kind: "native-fallback", reason: "pool-unavailable" });
    expect(
      selectCodexRoute({
        stateDir: dir,
        nowMs: NOW + 2,
        quotaScope: CODEX_SPARK_QUOTA_SCOPE,
        tryAcquireLock: injectedLock,
      }),
    ).toMatchObject({ kind: "pooled", alias: "keeper-codex-a" });
  });

  test("shared failures block all scopes", () => {
    const dir = root();
    publish(dir, [alias("keeper-codex-a", 20, { sparkUsedPercent: 0 })]);
    expect(
      selectCodexRoute({
        stateDir: dir,
        nowMs: NOW,
        tryAcquireLock: injectedLock,
      }),
    ).toMatchObject({ kind: "pooled", alias: "keeper-codex-a" });
    expect(
      recordCodexRouteOutcome({
        stateDir: dir,
        nowMs: NOW,
        alias: "keeper-codex-a",
        outcome: "transport",
        tryAcquireLock: injectedLock,
      }),
    ).toBe(true);
    expect(
      selectCodexRoute({
        stateDir: dir,
        nowMs: NOW + 1,
        tryAcquireLock: injectedLock,
      }),
    ).toMatchObject({ kind: "native-fallback", reason: "pool-unavailable" });
    expect(
      selectCodexRoute({
        stateDir: dir,
        nowMs: NOW + 2,
        quotaScope: CODEX_SPARK_QUOTA_SCOPE,
        tryAcquireLock: injectedLock,
      }),
    ).toMatchObject({ kind: "native-fallback", reason: "pool-unavailable" });
  });

  test("success releases one reservation and does not clear cooldown", () => {
    const dir = root();
    publish(dir, [alias("keeper-codex-a", 20)]);
    selectCodexRoute({
      stateDir: dir,
      nowMs: NOW,
      tryAcquireLock: injectedLock,
    });
    expect(
      recordCodexRouteOutcome({
        stateDir: dir,
        nowMs: NOW,
        alias: "keeper-codex-a",
        outcome: "rate",
        tryAcquireLock: injectedLock,
      }),
    ).toBe(true);
    expect(
      recordCodexRouteOutcome({
        stateDir: dir,
        nowMs: NOW + 1,
        alias: "keeper-codex-a",
        outcome: "success",
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
    const ledger = JSON.parse(
      readFileSync(codexPressureLedgerPath(dir), "utf8"),
    );
    expect(ledger.aliases["keeper-codex-a"].reservations).toEqual([]);
    expect(ledger.aliases["keeper-codex-a"].shared_cooldown_until_ms).toBe(
      NOW + CODEX_FAILURE_COOLDOWN_MS,
    );
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
        config_binding: BINDING,
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
    const ledger = JSON.parse(
      readFileSync(codexPressureLedgerPath(dir), "utf8"),
    );
    expect(ledger.schema_version).toBe(CODEX_PRESSURE_LEDGER_SCHEMA_VERSION);
    expect(ledger.aliases["keeper-codex-a"].shared_cooldown_until_ms).toBe(0);
  });

  test("a valid v2 ledger with far-future cooldowns cannot starve routing", () => {
    const dir = root();
    publish(dir, [
      alias("keeper-codex-a", 5, { sparkUsedPercent: 5 }),
      alias("keeper-codex-b", 10, { sparkUsedPercent: 10 }),
    ]);
    writeFileSync(
      codexPressureLedgerPath(dir),
      JSON.stringify({
        schema_version: CODEX_PRESSURE_LEDGER_SCHEMA_VERSION,
        provider: "openai-codex",
        config_binding: BINDING,
        aliases: {
          "keeper-codex-a": {
            reservations: [NOW - 1, Number.MAX_SAFE_INTEGER],
            shared_cooldown_until_ms: Number.MAX_SAFE_INTEGER,
            quota_cooldown_until_ms: {
              [CODEX_GENERIC_QUOTA_SCOPE]: Number.MAX_SAFE_INTEGER,
              [CODEX_SPARK_QUOTA_SCOPE]: Number.MAX_SAFE_INTEGER,
            },
            last_selected_at_ms: Number.MAX_SAFE_INTEGER,
          },
          "keeper-codex-b": {
            reservations: [],
            shared_cooldown_until_ms: 0,
            quota_cooldown_until_ms: {
              [CODEX_GENERIC_QUOTA_SCOPE]: NOW + CODEX_FAILURE_COOLDOWN_MS,
              [CODEX_SPARK_QUOTA_SCOPE]: 0,
            },
            last_selected_at_ms: NOW - 10,
          },
        },
      }),
    );
    expect(
      selectCodexRoute({
        stateDir: dir,
        nowMs: NOW,
        quotaScope: CODEX_GENERIC_QUOTA_SCOPE,
        tryAcquireLock: injectedLock,
      }),
    ).toMatchObject({ kind: "pooled", alias: "keeper-codex-a" });
    const ledger = JSON.parse(
      readFileSync(codexPressureLedgerPath(dir), "utf8"),
    );
    expect(ledger.aliases["keeper-codex-a"]).toMatchObject({
      shared_cooldown_until_ms: 0,
      quota_cooldown_until_ms: {
        [CODEX_GENERIC_QUOTA_SCOPE]: 0,
        [CODEX_SPARK_QUOTA_SCOPE]: 0,
      },
      last_selected_at_ms: NOW,
    });
    expect(ledger.aliases["keeper-codex-b"].quota_cooldown_until_ms).toEqual({
      [CODEX_GENERIC_QUOTA_SCOPE]: NOW + CODEX_FAILURE_COOLDOWN_MS,
      [CODEX_SPARK_QUOTA_SCOPE]: 0,
    });
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
      quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
      verdict: { kind: "pooled", alias: "keeper-codex-b" },
    });
    expect(result.candidates.map((candidate) => candidate.alias)).toEqual([
      "keeper-codex-a",
      "keeper-codex-b",
    ]);
    expect(result.candidates[0]).toMatchObject({
      quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
      used_percent: 60,
      worst_used_percent: 60,
      pressure: 0,
      shared_cooldown_until_ms: 0,
      quota_cooldown_until_ms: 0,
      capacity_cooldown_until_ms: 0,
      authorized: true,
      eligible: true,
    });
    expect(existsSync(codexPressureLedgerPath(dir))).toBe(false);
  });

  test("reports scoped authorization and cooldown facts", () => {
    const dir = root();
    publish(dir, [
      alias("keeper-codex-a", 10, { sparkUsedPercent: 5 }),
      alias("keeper-codex-b", 20, { sparkUsedPercent: 1 }),
    ]);
    expect(
      inspectCodexRouting({
        stateDir: dir,
        nowMs: NOW,
        quotaScope: CODEX_SPARK_QUOTA_SCOPE,
        authorizedAliases: [],
      }),
    ).toMatchObject({
      health: "unavailable",
      candidates: [],
      verdict: { kind: "native-fallback", reason: "pool-unavailable" },
    });
    selectCodexRoute({
      stateDir: dir,
      nowMs: NOW,
      quotaScope: CODEX_SPARK_QUOTA_SCOPE,
      authorizedAliases: ["keeper-codex-a"],
      tryAcquireLock: injectedLock,
    });
    recordCodexRouteOutcome({
      stateDir: dir,
      nowMs: NOW,
      alias: "keeper-codex-a",
      quotaScope: CODEX_SPARK_QUOTA_SCOPE,
      outcome: "quota",
      authorizedAliases: ["keeper-codex-a"],
      tryAcquireLock: injectedLock,
    });
    const result = inspectCodexRouting({
      stateDir: dir,
      nowMs: NOW + 1,
      quotaScope: CODEX_SPARK_QUOTA_SCOPE,
      authorizedAliases: ["keeper-codex-b"],
    });
    expect(result.quota_scope).toBe(CODEX_SPARK_QUOTA_SCOPE);
    expect(result.verdict).toMatchObject({
      kind: "pooled",
      alias: "keeper-codex-b",
    });
    expect(result.candidates).toEqual([
      expect.objectContaining({
        alias: "keeper-codex-a",
        quota_scope: CODEX_SPARK_QUOTA_SCOPE,
        used_percent: 5,
        shared_cooldown_until_ms: 0,
        quota_cooldown_until_ms: NOW + CODEX_FAILURE_COOLDOWN_MS,
        authorized: false,
        eligible: false,
      }),
      expect.objectContaining({
        alias: "keeper-codex-b",
        quota_scope: CODEX_SPARK_QUOTA_SCOPE,
        used_percent: 1,
        authorized: true,
        eligible: true,
      }),
    ]);
  });
});

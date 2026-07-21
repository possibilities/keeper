import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_MAX_OBSERVER_OUTPUT_BYTES,
  CODEX_OBSERVATION_SCHEMA_VERSION,
} from "../src/account-routing-config";
import {
  CODEX_PROVIDER,
  codexScopedAliasCapacityView,
  isCodexObservationFresh,
  parseCodexObserverOutcome,
  readCodexObservationSidecar,
  validateCodexObservation,
  writeCodexObservationSidecar,
} from "../src/codex-account-observation";
import {
  CODEX_GENERIC_QUOTA_SCOPE,
  CODEX_SPARK_QUOTA_SCOPE,
} from "../src/codex-quota-scope";

const NOW = Date.parse("2026-07-18T12:00:00Z");
const BINDING = "a".repeat(64);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function envelope(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema_version: 1,
    config_binding: BINDING,
    observed_at_ms: NOW,
    aliases: [
      {
        alias: "keeper-codex-a",
        usage: {
          schema_version: 2,
          alias: "keeper-codex-a",
          status: "healthy",
          account_category: "pro",
          observed_at_ms: NOW,
          expires_at_ms: NOW + 60_000,
          windows: [
            {
              role: "primary",
              quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
              key: "week",
              label: "weekly",
              window_seconds: 604_800,
              used_percent: 12.3,
              exhausted: false,
              reset_at_ms: NOW + 30_000,
              private_plan: "enterprise-secret",
            },
          ],
          owner_email: "owner@example.test",
        },
        raw_token: "Bearer private-token",
      },
    ],
    truncated: false,
    raw_headers: { Authorization: "Bearer private-token" },
    ...overrides,
  };
}

function parse(value: unknown = envelope()) {
  return parseCodexObserverOutcome({
    code: 0,
    stdout: JSON.stringify(value),
  });
}

/** Narrow a fixture value that must exist; a missing one is a test bug. */
function must<T>(v: T | undefined | null): T {
  if (v == null) throw new Error("fixture value missing");
  return v;
}

describe("Codex observer envelope", () => {
  test("normalizes provider-qualified bounded capacity without retaining PII", () => {
    const observation = parse();
    expect(observation).toEqual({
      schema_version: CODEX_OBSERVATION_SCHEMA_VERSION,
      provider: CODEX_PROVIDER,
      config_binding: BINDING,
      observed_at_ms: NOW,
      aliases: [
        {
          alias: "keeper-codex-a",
          status: "healthy",
          account_category: "pro",
          observed_at_ms: NOW,
          expires_at_ms: NOW + 60_000,
          windows: [
            {
              role: "primary",
              quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
              key: "week",
              label: "weekly",
              window_seconds: 604_800,
              used_percent: 12.3,
              exhausted: false,
              reset_at_ms: NOW + 30_000,
            },
          ],
        },
      ],
    });
    const rendered = JSON.stringify(observation);
    for (const forbidden of [
      "owner@example.test",
      "enterprise-secret",
      "private-token",
      "Authorization",
      "raw_headers",
    ]) {
      expect(rendered).not.toContain(forbidden);
    }
  });

  test("rejects failed, malformed, unsupported, truncated, duplicate, and oversized input", () => {
    expect(
      parseCodexObserverOutcome({
        code: 1,
        stdout: JSON.stringify(envelope()),
      }),
    ).toBeNull();
    expect(parseCodexObserverOutcome({ code: 0, stdout: "{" })).toBeNull();
    expect(parse(envelope({ schema_version: 2 }))).toBeNull();
    const oldUsage = envelope() as Record<string, unknown>;
    const oldUsageAliases = oldUsage.aliases as Array<{
      usage: Record<string, unknown>;
    }>;
    if (oldUsageAliases[0]) oldUsageAliases[0].usage.schema_version = 1;
    expect(parse(oldUsage)).toBeNull();
    expect(parse(envelope({ truncated: true }))).toBeNull();
    const duplicate = envelope() as Record<string, unknown>;
    duplicate.aliases = [
      ...(duplicate.aliases as unknown[]),
      ...(duplicate.aliases as unknown[]),
    ];
    expect(parse(duplicate)).toBeNull();
    expect(
      parseCodexObserverOutcome({
        code: 0,
        stdout: "x".repeat(CODEX_MAX_OBSERVER_OUTPUT_BYTES + 1),
      }),
    ).toBeNull();
  });

  test("accepts only fixed status classes, categories, opaque aliases, and bounded windows", () => {
    const invalidAlias = envelope() as Record<string, unknown>;
    invalidAlias.aliases = [
      {
        alias: "owner@example.test",
        usage: {
          schema_version: 2,
          alias: "owner@example.test",
          status: "healthy",
          observed_at_ms: NOW,
          expires_at_ms: NOW + 1,
          windows: [
            {
              role: "primary",
              quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
              key: "session",
              label: "session",
              window_seconds: 18_000,
              used_percent: 10,
              exhausted: false,
              reset_at_ms: null,
            },
          ],
        },
      },
    ];
    expect(parse(invalidAlias)).toBeNull();

    const invalidCategory = envelope() as Record<string, unknown>;
    const categoryAliases = invalidCategory.aliases as Array<{
      usage: Record<string, unknown>;
    }>;
    if (categoryAliases[0]) {
      categoryAliases[0].usage.account_category = "private-enterprise-plan";
    }
    expect(parse(invalidCategory)).toBeNull();

    const unavailable = envelope() as Record<string, unknown>;
    unavailable.aliases = [
      {
        alias: "keeper-codex-a",
        usage: {
          schema_version: 2,
          alias: "keeper-codex-a",
          status: "unavailable",
          failure_class: "auth",
          observed_at_ms: NOW,
          expires_at_ms: NOW,
          windows: [],
        },
      },
    ];
    expect(parse(unavailable)?.aliases[0]?.failure_class).toBe("auth");

    const raw = unavailable.aliases as Array<Record<string, unknown>>;
    (raw[0]?.usage as Record<string, unknown>).failure_class =
      "private provider error";
    expect(parse(unavailable)).toBeNull();
  });
});

describe("Codex scoped capacity view", () => {
  test("keeps generic and Spark exhaustion independent with reset-effective windows", () => {
    const observation = parse();
    if (observation === null) throw new Error("fixture did not parse");
    const alias = {
      ...must(observation.aliases[0]),
      status: "exhausted" as const,
      windows: [
        {
          role: "primary" as const,
          quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
          key: "week",
          label: "weekly",
          window_seconds: 604_800,
          used_percent: 100,
          exhausted: true,
          reset_at_ms: NOW,
        },
        {
          role: "additional" as const,
          quota_scope: CODEX_SPARK_QUOTA_SCOPE,
          key: "meter:spark:primary",
          label: "GPT-5.3-Codex-Spark",
          window_seconds: null,
          used_percent: 0,
          exhausted: false,
          reset_at_ms: NOW + 30_000,
        },
      ],
    };

    expect(
      codexScopedAliasCapacityView(alias, CODEX_GENERIC_QUOTA_SCOPE, NOW),
    ).toMatchObject({
      quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
      status: "healthy",
      windows: [{ quota_scope: CODEX_GENERIC_QUOTA_SCOPE }],
      used_percent: 0,
      cooldown_until_ms: 0,
    });
    expect(
      codexScopedAliasCapacityView(alias, CODEX_SPARK_QUOTA_SCOPE, NOW),
    ).toMatchObject({
      quota_scope: CODEX_SPARK_QUOTA_SCOPE,
      status: "healthy",
      windows: [{ quota_scope: CODEX_SPARK_QUOTA_SCOPE }],
      used_percent: 0,
      cooldown_until_ms: 0,
    });
  });

  test("Spark exhaustion does not hide generic and missing Spark is unavailable", () => {
    const observation = parse();
    if (observation === null) throw new Error("fixture did not parse");
    const alias = {
      ...must(observation.aliases[0]),
      windows: [
        {
          ...must(must(observation.aliases[0]).windows[0]),
          quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
          used_percent: 10,
          exhausted: false,
        },
        {
          role: "additional" as const,
          quota_scope: CODEX_SPARK_QUOTA_SCOPE,
          key: "meter:spark:primary",
          label: "GPT-5.3-Codex-Spark",
          window_seconds: null,
          used_percent: 0,
          exhausted: true,
          reset_at_ms: NOW + 30_000,
        },
      ],
    };

    expect(
      codexScopedAliasCapacityView(alias, CODEX_GENERIC_QUOTA_SCOPE, NOW)
        .status,
    ).toBe("healthy");
    expect(
      codexScopedAliasCapacityView(alias, CODEX_SPARK_QUOTA_SCOPE, NOW),
    ).toMatchObject({ status: "exhausted", cooldown_until_ms: NOW + 30_000 });
    expect(
      codexScopedAliasCapacityView(
        { ...alias, windows: alias.windows.slice(0, 1) },
        CODEX_SPARK_QUOTA_SCOPE,
        NOW,
      ),
    ).toMatchObject({
      status: "unavailable",
      used_percent: 100,
      windows: [],
      cooldown_until_ms: 0,
    });
  });
});

describe("Codex capacity sidecar", () => {
  test("atomically replaces a private sidecar and strictly revalidates reads", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-observation-"));
    roots.push(root);
    const path = join(root, "observation.json");
    const first = parse();
    expect(first).not.toBeNull();
    if (first === null) throw new Error("fixture did not parse");
    writeCodexObservationSidecar(path, first);
    const second = {
      ...first,
      observed_at_ms: NOW + 1,
      aliases: first.aliases.map((alias) => ({
        ...alias,
        observed_at_ms: NOW + 1,
      })),
    };
    writeCodexObservationSidecar(path, second);
    expect(readCodexObservationSidecar(path)).toEqual(second);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(root)).toEqual(["observation.json"]);
    expect(
      validateCodexObservation({
        ...second,
        schema_version: CODEX_OBSERVATION_SCHEMA_VERSION + 1,
      }),
    ).toBeNull();
    expect(
      validateCodexObservation({ ...second, provider: "claude" }),
    ).toBeNull();
    expect(
      validateCodexObservation({
        ...second,
        schema_version: CODEX_OBSERVATION_SCHEMA_VERSION - 1,
      }),
    ).toBeNull();
    writeFileSync(
      path,
      JSON.stringify({
        ...second,
        schema_version: CODEX_OBSERVATION_SCHEMA_VERSION - 1,
      }),
    );
    expect(readCodexObservationSidecar(path)).toBeNull();

    chmodSync(path, 0o644);
    writeCodexObservationSidecar(path, second);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("freshness rejects future and expired observations", () => {
    const observation = parse();
    if (observation === null) throw new Error("fixture did not parse");
    expect(isCodexObservationFresh(observation, NOW, 1)).toBe(true);
    expect(isCodexObservationFresh(observation, NOW - 1, 60_000)).toBe(false);
    expect(isCodexObservationFresh(observation, NOW + 60_001, 60_000)).toBe(
      false,
    );
  });
});

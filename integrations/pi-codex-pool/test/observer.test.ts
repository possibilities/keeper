import { describe, expect, test } from "bun:test";
import { CredentialVault, MemoryCredentialStorage } from "../src/auth.ts";
import {
  observePool,
  renderObserverEnvelope,
  runObserverCommand,
} from "../src/observer.ts";
import { PoolRouteState } from "../src/state.ts";
import { parseUsageResponse } from "../src/usage.ts";

function jwt(accountId: string, suffix: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.${suffix}`;
}

const TOKENS = {
  "keeper-codex-a": jwt("account-private-a", "signature-a"),
  "keeper-codex-b": jwt("account-private-b", "signature-b"),
};

function vault() {
  return new CredentialVault(
    new MemoryCredentialStorage({
      "keeper-codex-a": {
        type: "oauth",
        access: TOKENS["keeper-codex-a"],
        refresh: "private-refresh-a",
        expires: 1_000_000,
      },
      "keeper-codex-b": {
        type: "oauth",
        access: TOKENS["keeper-codex-b"],
        refresh: "private-refresh-b",
        expires: 1_000_000,
      },
    }),
    async (credential) => credential,
    () => 100,
  );
}

function usage(usedPercent: number) {
  return {
    plan_type: "private-enterprise-plan",
    owner_email: "owner@example.test",
    raw_headers: { Authorization: "Bearer should-never-render" },
    rate_limit: {
      allowed: usedPercent < 100,
      limit_reached: usedPercent >= 100,
      primary_window: {
        used_percent: usedPercent,
        reset_at: 200,
        limit_window_seconds: 18_000,
      },
      secondary_window: {
        used_percent: Math.max(0, usedPercent - 10),
        reset_at: 300,
        limit_window_seconds: 604_800,
      },
    },
    additional_rate_limits: [
      {
        limit_name: "GPT-5.3-Codex-Spark",
        metered_feature: "private-feature",
        rate_limit: {
          primary_window: { used_percent: usedPercent / 2, reset_at: 250 },
        },
      },
    ],
  };
}

describe("Codex usage observer", () => {
  test("keeps the executable inert and sanitized outside a Keeper marker", async () => {
    const outputs: string[] = [];
    expect(
      await runObserverCommand({ PATH: process.env.PATH }, (output) =>
        outputs.push(output),
      ),
    ).toBe(2);
    expect(outputs).toEqual([
      JSON.stringify({
        schema_version: 1,
        status: "unavailable",
        reason: "pool-unavailable",
      }),
    ]);
  });

  test("normalizes two independent aliases without crossing the observer boundary", async () => {
    const aliases = ["keeper-codex-a", "keeper-codex-b"];
    const routes = new PoolRouteState(aliases, null, () => 100);
    const requests: Array<{
      access: string;
      accountId: string;
    }> = [];
    const envelope = await observePool({
      aliases,
      vault: vault(),
      routes,
      now: () => 100,
      async requestUsage({ access, accountId }) {
        requests.push({ access, accountId });
        return usage(accountId.endsWith("a") ? 90 : 10);
      },
    });
    expect(requests).toEqual([
      {
        access: TOKENS["keeper-codex-a"],
        accountId: "account-private-a",
      },
      {
        access: TOKENS["keeper-codex-b"],
        accountId: "account-private-b",
      },
    ]);
    expect(envelope.aliases.map((entry) => entry.usage.status)).toEqual([
      "healthy",
      "healthy",
    ]);
    expect(envelope.aliases[0]?.usage.windows).toEqual([
      {
        role: "primary",
        key: "session",
        label: "session",
        window_seconds: 18_000,
        used_percent: 90,
        reset_at_ms: 200_000,
      },
      {
        role: "secondary",
        key: "week",
        label: "weekly",
        window_seconds: 604_800,
        used_percent: 80,
        reset_at_ms: 300_000,
      },
      {
        role: "additional",
        key: "meter:95e633c373a9cdcf6cdc5e63:primary",
        label: "GPT-5.3-Codex-Spark",
        window_seconds: null,
        used_percent: 45,
        reset_at_ms: 250_000,
      },
    ]);
    expect(routes.select("new-session")).toBe("keeper-codex-b");

    const rendered = renderObserverEnvelope(envelope);
    for (const forbidden of [
      ...Object.values(TOKENS),
      "private-refresh-a",
      "private-refresh-b",
      "account-private-a",
      "account-private-b",
      "private-enterprise-plan",
      "owner@example.test",
      "Authorization",
      "should-never-render",
      "private-feature",
    ]) {
      expect(rendered).not.toContain(forbidden);
    }
    expect(rendered).toContain("GPT-5.3-Codex-Spark");
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(16 * 1024);
  });

  test("reduces raw failures to fixed classes", async () => {
    const aliases = ["keeper-codex-a", "keeper-codex-b"];
    const envelope = await observePool({
      aliases,
      vault: vault(),
      routes: new PoolRouteState(aliases, null, () => 100),
      now: () => 100,
      async requestUsage({ accountId }) {
        throw new Error(
          `usage-response-403 for ${accountId} owner@example.test Bearer private-token`,
        );
      },
    });
    expect(envelope.aliases.map((entry) => entry.usage.failure_class)).toEqual([
      "response",
      "response",
    ]);
    const rendered = renderObserverEnvelope(envelope);
    expect(rendered).not.toContain("account-private");
    expect(rendered).not.toContain("owner@example.test");
    expect(rendered).not.toContain("private-token");
  });

  test("rejects malformed and unbounded usage fields instead of copying them", () => {
    expect(() =>
      parseUsageResponse(
        "keeper-codex-a",
        { rate_limit: { primary_window: { used_percent: 101 } } },
        100,
      ),
    ).toThrow("usage-schema-invalid");
    const parsed = parseUsageResponse(
      "keeper-codex-a",
      {
        rate_limit: {
          primary_window: { used_percent: 12.34, reset_at: null },
        },
        unknown: "Bearer raw-secret",
      },
      100,
    );
    expect(parsed.windows).toEqual([
      {
        role: "primary",
        key: "window:primary",
        label: "primary",
        window_seconds: null,
        used_percent: 12.3,
        reset_at_ms: null,
      },
    ]);
    expect(JSON.stringify(parsed)).not.toContain("unknown");
    expect(JSON.stringify(parsed)).not.toContain("raw-secret");

    const privateLabel = parseUsageResponse(
      "keeper-codex-a",
      {
        additional_rate_limits: [
          {
            limit_name: "OpenAI Account 123456",
            rate_limit: {
              primary_window: { used_percent: 8, reset_at: null },
            },
          },
        ],
      },
      100,
    );
    expect(privateLabel.windows[0]?.label).toBe("additional 1");
    expect(JSON.stringify(privateLabel)).not.toContain("Account 123456");
  });

  test("bounds rendered output even for a hostile in-memory envelope", () => {
    const rendered = renderObserverEnvelope({
      schema_version: 1,
      config_binding: "a".repeat(64),
      observed_at_ms: 100,
      aliases: Array.from({ length: 100 }, (_, index) => ({
        alias: `keeper-codex-${index}`,
        usage: {
          schema_version: 1,
          alias: `keeper-codex-${index}`,
          status: "healthy",
          observed_at_ms: 100,
          expires_at_ms: 200,
          windows: Array.from({ length: 100 }, () => ({
            role: "additional" as const,
            used_percent: 10,
            reset_at_ms: 200,
          })),
        },
      })),
      truncated: false,
    });
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(16 * 1024);
    expect(JSON.parse(rendered).truncated).toBe(true);
  });
});

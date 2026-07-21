import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CODEX_GENERIC_QUOTA_SCOPE,
  CODEX_SPARK_QUOTA_SCOPE,
} from "../../../src/codex-quota-scope.ts";
import { CredentialVault, MemoryCredentialStorage } from "../src/auth.ts";
import {
  loadInstalledCodexOAuth,
  observePool,
  renderObserverEnvelope,
  runObserverCommand,
} from "../src/observer.ts";
import { PoolRouteState } from "../src/state.ts";
import { parseUsageResponse, usageScopeView } from "../src/usage.ts";

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

function makeSandbox(): string {
  return mkdtempSync(join(tmpdir(), "codex-pool-observer-"));
}

function writeCatalogSource(path: string, marker: string): void {
  writeFileSync(
    path,
    `export function builtinProviders() {
  return [{
    id: "openai-codex",
    auth: {
      oauth: {
        name: ${JSON.stringify(marker)},
        async login() { throw new Error("unused-login"); },
        async refresh(credential) { return credential; },
        async toAuth() { return {}; }
      }
    }
  }];
}
`,
    "utf8",
  );
}

function writePackageCatalog(packageRoot: string, marker: string): string {
  const catalogDir = join(
    packageRoot,
    "node_modules",
    "@earendil-works",
    "pi-ai",
    "dist",
    "providers",
  );
  mkdirSync(catalogDir, { recursive: true });
  const catalogPath = join(catalogDir, "all.js");
  writeCatalogSource(catalogPath, marker);
  return catalogPath;
}

function writeDirectCatalog(catalogDir: string, marker: string): string {
  mkdirSync(catalogDir, { recursive: true });
  const catalogPath = join(catalogDir, "all.js");
  writeCatalogSource(catalogPath, marker);
  return catalogPath;
}

function fakeObserverModuleUrl(packageRoot: string): string {
  const observerPath = join(packageRoot, "src", "observer.ts");
  mkdirSync(dirname(observerPath), { recursive: true });
  writeFileSync(observerPath, "", "utf8");
  return pathToFileURL(observerPath).href;
}

function writePiExecutablePackage(packageRoot: string, marker: string): string {
  writePackageCatalog(packageRoot, marker);
  const binDir = join(packageRoot, "bin");
  mkdirSync(binDir, { recursive: true });
  const piPath = join(binDir, "pi");
  writeFileSync(piPath, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(piPath, 0o755);
  return binDir;
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

  test("loads codex oauth from an explicit catalog override before other candidates", async () => {
    const sandbox = makeSandbox();
    try {
      const overrideDir = join(sandbox, "override-providers");
      writeDirectCatalog(overrideDir, "env-override");
      const packageRoot = join(sandbox, "observer-package");
      writePackageCatalog(packageRoot, "package-relative");
      const pathBin = writePiExecutablePackage(
        join(sandbox, "path-package"),
        "path-fallback",
      );

      const oauth = await loadInstalledCodexOAuth(
        { KEEPER_PI_CODEX_CATALOG_DIR: overrideDir, PATH: pathBin },
        { moduleUrl: fakeObserverModuleUrl(packageRoot) },
      );

      expect(oauth.name).toBe("env-override");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("runs with an explicit catalog override without a PATH pi executable", async () => {
    const sandbox = makeSandbox();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(sandbox, "agent");
    try {
      const overrideDir = join(sandbox, "override-providers");
      writeDirectCatalog(overrideDir, "env-command");
      const outputs: string[] = [];
      const code = await runObserverCommand(
        {
          KEEPER_JOB_ID: "job-1",
          KEEPER_PI_CODEX_CATALOG_DIR: overrideDir,
          KEEPER_PI_CODEX_POOL_ALIASES: JSON.stringify(["keeper-codex-a"]),
          PATH: join(sandbox, "empty-bin"),
        },
        (output) => outputs.push(output),
        {
          catalogResolver: {
            moduleUrl: fakeObserverModuleUrl(join(sandbox, "observer-package")),
          },
        },
      );
      const parsed = JSON.parse(outputs[0] ?? "{}") as {
        schema_version?: unknown;
        status?: unknown;
        aliases?: { alias?: unknown; usage?: { status?: unknown } }[];
        truncated?: unknown;
      };

      expect(code).toBe(0);
      expect(outputs).toHaveLength(1);
      expect(parsed.schema_version).toBe(1);
      expect(parsed.status).toBeUndefined();
      expect(parsed.truncated).toBe(false);
      expect(parsed.aliases?.map((entry) => entry.alias)).toEqual([
        "keeper-codex-a",
      ]);
      expect(parsed.aliases?.[0]?.usage?.status).toBe("unavailable");
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("loads codex oauth relative to the observer package before PATH fallback", async () => {
    const sandbox = makeSandbox();
    try {
      const packageRoot = join(sandbox, "observer-package");
      writePackageCatalog(packageRoot, "package-relative");
      const pathBin = writePiExecutablePackage(
        join(sandbox, "path-package"),
        "path-fallback",
      );

      const oauth = await loadInstalledCodexOAuth(
        {
          KEEPER_PI_CODEX_CATALOG_DIR: join(sandbox, "missing-override"),
          PATH: pathBin,
        },
        { moduleUrl: fakeObserverModuleUrl(packageRoot) },
      );

      expect(oauth.name).toBe("package-relative");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("loads codex oauth from a home nvm pi install without PATH pi", async () => {
    const sandbox = makeSandbox();
    try {
      const home = join(sandbox, "home");
      const piPackageRoot = join(
        home,
        ".nvm",
        "versions",
        "node",
        "v24.16.0",
        "lib",
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
      );
      writePackageCatalog(piPackageRoot, "home-nvm");

      const oauth = await loadInstalledCodexOAuth(
        { HOME: home, PATH: join(sandbox, "empty-bin") },
        { moduleUrl: fakeObserverModuleUrl(join(sandbox, "observer-package")) },
      );

      expect(oauth.name).toBe("home-nvm");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("loads codex oauth through the legacy PATH pi fallback last", async () => {
    const sandbox = makeSandbox();
    try {
      const observerRoot = join(sandbox, "observer-package");
      const pathBin = writePiExecutablePackage(
        join(sandbox, "path-package"),
        "path-fallback",
      );

      const oauth = await loadInstalledCodexOAuth(
        { PATH: pathBin },
        { moduleUrl: fakeObserverModuleUrl(observerRoot) },
      );

      expect(oauth.name).toBe("path-fallback");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("emits the bounded unavailable envelope when the whole catalog chain misses", async () => {
    const sandbox = makeSandbox();
    try {
      const outputs: string[] = [];
      const code = await runObserverCommand(
        { KEEPER_JOB_ID: "job-1", PATH: join(sandbox, "empty-bin") },
        (output) => outputs.push(output),
        {
          catalogResolver: {
            moduleUrl: fakeObserverModuleUrl(join(sandbox, "observer-package")),
            exists: () => false,
          },
        },
      );

      expect(code).toBe(1);
      expect(outputs).toEqual([
        JSON.stringify({
          schema_version: 1,
          status: "unavailable",
          reason: "pool-unavailable",
        }),
      ]);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("normalizes two independent aliases without crossing the observer boundary", async () => {
    const aliases = ["keeper-codex-a", "keeper-codex-b"];
    const routes = new PoolRouteState(
      aliases,
      null,
      () => 100,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      {
        [CODEX_GENERIC_QUOTA_SCOPE]: aliases,
        [CODEX_SPARK_QUOTA_SCOPE]: [],
      },
    );
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
        quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
        key: "session",
        label: "session",
        window_seconds: 18_000,
        used_percent: 90,
        exhausted: false,
        reset_at_ms: 200_000,
      },
      {
        role: "secondary",
        quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
        key: "week",
        label: "weekly",
        window_seconds: 604_800,
        used_percent: 80,
        exhausted: false,
        reset_at_ms: 300_000,
      },
      {
        role: "additional",
        quota_scope: CODEX_SPARK_QUOTA_SCOPE,
        key: "meter:95e633c373a9cdcf6cdc5e63:primary",
        label: "GPT-5.3-Codex-Spark",
        window_seconds: null,
        used_percent: 45,
        exhausted: false,
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

  test("equal-timestamp unavailable observations dominate prior Spark health", async () => {
    const aliases = ["keeper-codex-a"];
    const now = 100;
    const routes = new PoolRouteState(
      aliases,
      null,
      () => now,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      {
        [CODEX_GENERIC_QUOTA_SCOPE]: aliases,
        [CODEX_SPARK_QUOTA_SCOPE]: aliases,
      },
    );
    await observePool({
      aliases,
      vault: vault(),
      routes,
      now: () => now,
      async requestUsage() {
        return usage(20);
      },
    });
    expect(routes.hasEligibleRoute(CODEX_SPARK_QUOTA_SCOPE)).toBe(true);

    const envelope = await observePool({
      aliases,
      vault: vault(),
      routes,
      now: () => now,
      async requestUsage() {
        return { rate_limit: { primary_window: { used_percent: 101 } } };
      },
    });

    expect(envelope.aliases[0]?.usage).toEqual(
      expect.objectContaining({
        alias: "keeper-codex-a",
        status: "unavailable",
        observed_at_ms: now,
        failure_class: "schema",
      }),
    );
    expect(routes.hasEligibleRoute(CODEX_SPARK_QUOTA_SCOPE)).toBe(false);
    const account = routes.snapshot().accounts[0];
    expect(
      account?.quota_scopes.find(
        (scope) => scope.quota_scope === CODEX_SPARK_QUOTA_SCOPE,
      ),
    ).toEqual(
      expect.objectContaining({
        used_percent: 100,
        usage_expires_at_ms: 0,
        observed_at_ms: now,
        exhausted: false,
      }),
    );
  });

  test("malformed observations immediately overwrite prior Spark health", async () => {
    const aliases = ["keeper-codex-a"];
    let now = 100;
    const routes = new PoolRouteState(
      aliases,
      null,
      () => now,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      {
        [CODEX_GENERIC_QUOTA_SCOPE]: aliases,
        [CODEX_SPARK_QUOTA_SCOPE]: aliases,
      },
    );
    await observePool({
      aliases,
      vault: vault(),
      routes,
      now: () => now,
      async requestUsage() {
        return usage(20);
      },
    });
    expect(routes.hasEligibleRoute(CODEX_SPARK_QUOTA_SCOPE)).toBe(true);

    now = 200;
    const envelope = await observePool({
      aliases,
      vault: vault(),
      routes,
      now: () => now,
      async requestUsage() {
        return { rate_limit: { primary_window: { used_percent: 101 } } };
      },
    });

    expect(envelope.aliases[0]?.usage).toEqual(
      expect.objectContaining({
        alias: "keeper-codex-a",
        status: "unavailable",
        observed_at_ms: 200,
        failure_class: "schema",
      }),
    );
    expect(routes.hasEligibleRoute(CODEX_SPARK_QUOTA_SCOPE)).toBe(false);
    const account = routes.snapshot().accounts[0];
    expect(
      account?.quota_scopes.find(
        (scope) => scope.quota_scope === CODEX_SPARK_QUOTA_SCOPE,
      ),
    ).toEqual(
      expect.objectContaining({
        used_percent: 100,
        usage_expires_at_ms: 0,
        observed_at_ms: 200,
        exhausted: false,
      }),
    );
  });

  test("aborted observations immediately overwrite prior Spark health", async () => {
    const aliases = ["keeper-codex-a"];
    let now = 100;
    const routes = new PoolRouteState(
      aliases,
      null,
      () => now,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      {
        [CODEX_GENERIC_QUOTA_SCOPE]: aliases,
        [CODEX_SPARK_QUOTA_SCOPE]: aliases,
      },
    );
    await observePool({
      aliases,
      vault: vault(),
      routes,
      now: () => now,
      async requestUsage() {
        return usage(20);
      },
    });
    expect(routes.hasEligibleRoute(CODEX_SPARK_QUOTA_SCOPE)).toBe(true);

    now = 200;
    const controller = new AbortController();
    controller.abort();
    const envelope = await observePool({
      aliases,
      vault: vault(),
      routes,
      now: () => now,
      signal: controller.signal,
      async requestUsage() {
        throw new Error("request-should-not-run");
      },
    });

    expect(envelope.aliases[0]?.usage).toEqual(
      expect.objectContaining({
        alias: "keeper-codex-a",
        status: "unavailable",
        observed_at_ms: 200,
        failure_class: "network",
      }),
    );
    expect(routes.hasEligibleRoute(CODEX_SPARK_QUOTA_SCOPE)).toBe(false);
  });

  test("keeps Spark meter exhaustion out of generic aggregate status", () => {
    const sparkExhausted = parseUsageResponse("keeper-codex-a", usage(80), 100);
    const sparkWindow = sparkExhausted.windows.find(
      (window) => window.quota_scope === CODEX_SPARK_QUOTA_SCOPE,
    );
    if (sparkWindow === undefined) throw new Error("missing spark fixture");
    sparkWindow.exhausted = true;

    expect(sparkExhausted.status).toBe("healthy");
    expect(
      usageScopeView(sparkExhausted, CODEX_GENERIC_QUOTA_SCOPE, 100).status,
    ).toBe("healthy");
    expect(
      usageScopeView(sparkExhausted, CODEX_SPARK_QUOTA_SCOPE, 100).status,
    ).toBe("exhausted");

    const explicitSpark = parseUsageResponse(
      "keeper-codex-a",
      {
        ...usage(80),
        additional_rate_limits: [
          {
            limit_name: "GPT-5.3-Codex-Spark",
            rate_limit: {
              allowed: false,
              limit_reached: true,
              primary_window: { used_percent: 40, reset_at: 250 },
            },
          },
        ],
      },
      100,
    );
    const explicitWindow = explicitSpark.windows.find(
      (window) => window.quota_scope === CODEX_SPARK_QUOTA_SCOPE,
    );
    expect(explicitSpark.status).toBe("healthy");
    expect(explicitWindow).toEqual(
      expect.objectContaining({ used_percent: 40, exhausted: true }),
    );
    expect(usageScopeView(explicitSpark, CODEX_SPARK_QUOTA_SCOPE, 100)).toEqual(
      expect.objectContaining({ status: "exhausted", used_percent: 40 }),
    );

    const missingSpark = parseUsageResponse(
      "keeper-codex-a",
      { rate_limit: { primary_window: { used_percent: 20 } } },
      100,
    );
    expect(
      usageScopeView(missingSpark, CODEX_SPARK_QUOTA_SCOPE, 100).status,
    ).toBe("unavailable");
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

  test("normalizes only known provider account categories", () => {
    const categories = [
      ["free", "free"],
      ["go", "go"],
      ["plus", "plus"],
      ["pro", "pro"],
      ["prolite", "pro-lite"],
      ["team", "business"],
      ["self_serve_business_usage_based", "business"],
      ["business", "enterprise"],
      ["enterprise_cbp_usage_based", "enterprise"],
      ["hc", "enterprise"],
      ["education", "edu"],
    ] as const;
    for (const [planType, expected] of categories) {
      const parsed = parseUsageResponse(
        "keeper-codex-a",
        {
          plan_type: planType,
          rate_limit: {
            primary_window: { used_percent: 12, reset_at: null },
          },
        },
        100,
      );
      expect(parsed.account_category).toBe(expected);
    }

    const unknown = parseUsageResponse(
      "keeper-codex-a",
      {
        plan_type: "private-enterprise-plan",
        rate_limit: {
          primary_window: { used_percent: 12, reset_at: null },
        },
      },
      100,
    );
    expect(unknown.account_category).toBeUndefined();
    expect(JSON.stringify(unknown)).not.toContain("private-enterprise-plan");
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
        quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
        key: "window:primary",
        label: "primary",
        window_seconds: null,
        used_percent: 12.3,
        exhausted: false,
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
          schema_version: 2,
          alias: `keeper-codex-${index}`,
          status: "healthy",
          observed_at_ms: 100,
          expires_at_ms: 200,
          windows: Array.from({ length: 100 }, () => ({
            role: "additional" as const,
            quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
            key: "additional",
            label: "additional",
            window_seconds: null,
            used_percent: 10,
            exhausted: false,
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

// biome-ignore-all lint/suspicious/noExplicitAny: Structural Pi doubles keep the companion tests runtime-independent.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_GENERIC_QUOTA_SCOPE,
  CODEX_SPARK_QUOTA_SCOPE,
} from "../../../src/codex-quota-scope.ts";
import { writePrivateJsonAtomic } from "../src/auth.ts";
import { classifyLiveProof, reportQuotaScope } from "../src/proof.ts";
import {
  PoolRouteState,
  poolAliasPolicyBinding,
  poolAliasPolicyFromEnvironment,
} from "../src/state.ts";

const MODEL = {
  id: "gpt-proof-test",
  name: "GPT Proof Test",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 100,
} as const;
const CONTEXT = {
  systemPrompt: "system",
  messages: [{ role: "user", content: "run proof", timestamp: 1 }],
};
const REVISION = "0123456789abcdef0123456789abcdef01234567";
const ALIASES = ["keeper-codex-a", "keeper-codex-b"];

function jwt(accountId: string, suffix: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.${suffix}`;
}
const GENERIC_ALIAS_POLICY = JSON.stringify({
  [CODEX_GENERIC_QUOTA_SCOPE]: ALIASES,
  [CODEX_SPARK_QUOTA_SCOPE]: [],
});
const SPARK_ALIAS_POLICY = JSON.stringify({
  [CODEX_GENERIC_QUOTA_SCOPE]: [],
  [CODEX_SPARK_QUOTA_SCOPE]: ["keeper-codex-b"],
});
const SPARK_MODEL = {
  ...MODEL,
  id: "openai-codex/gpt-5.3-codex-spark",
  name: "GPT-5.3 Codex Spark",
} as const;

function message(stopReason: "stop" | "error" = "stop") {
  return {
    role: "assistant" as const,
    content: [],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function successfulStream() {
  const final = message();
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: final };
      yield {
        type: "text_delta",
        contentIndex: 0,
        delta: "ok",
        partial: {
          ...final,
          content: [{ type: "text", text: "ok" }],
        },
      };
      yield { type: "done", reason: "stop", message: final };
    },
    result: async () => final,
  };
}

let nativeStreamImpl: () => any = successfulStream;
const nativeStream = () => nativeStreamImpl();
let refreshSequence = 0;
mock.module("@earendil-works/pi-ai", () => ({
  openAICodexResponsesApi: () => ({ streamSimple: nativeStream }),
}));
mock.module("@earendil-works/pi-ai/providers/all", () => ({
  builtinProviders: () => [],
}));

function credentials(now: number) {
  return {
    "keeper-codex-a": {
      type: "oauth" as const,
      access: jwt("account-private-a", "initial-a"),
      refresh: "initial-refresh-a",
      expires: now + 3_600_000,
    },
    "keeper-codex-b": {
      type: "oauth" as const,
      access: jwt("account-private-b", "initial-b"),
      refresh: "initial-refresh-b",
      expires: now + 3_600_000,
    },
  };
}

function scopedUsage(usedPercent = 20, includeSpark = true) {
  const resetAt = Math.floor((Date.now() + 900_000) / 1000);
  return {
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: usedPercent,
        reset_at: resetAt,
        limit_window_seconds: 18_000,
      },
      secondary_window: {
        used_percent: usedPercent,
        reset_at: resetAt,
        limit_window_seconds: 604_800,
      },
    },
    additional_rate_limits: includeSpark
      ? [
          {
            limit_name: "GPT-5.3-Codex-Spark",
            rate_limit: {
              primary_window: {
                used_percent: usedPercent,
                reset_at: resetAt,
                limit_window_seconds: 18_000,
              },
            },
          },
        ]
      : [],
  };
}

const TEST_OAUTH = {
  name: "Codex",
  login: async () => credentials(Date.now()),
  refresh: async (credential: any) => {
    refreshSequence += 1;
    return {
      ...credential,
      access: jwt(
        credential.refresh.endsWith("-a")
          ? "account-private-a"
          : "account-private-b",
        `rotated-${refreshSequence}`,
      ),
      refresh: `rotated-refresh-${refreshSequence}`,
      expires: Date.now() + 3_600_000,
    };
  },
  toAuth: async () => ({ apiKey: "unused" }),
};

async function consume(source: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of source) {
    // Stream consumption is the production routing trigger.
  }
}

const ENV_KEYS = [
  "KEEPER_JOB_ID",
  "PI_CODING_AGENT_DIR",
  "KEEPER_PI_CODEX_POOL_ALIASES",
  "KEEPER_PI_CODEX_POOL_MODE",
  "KEEPER_PI_CODEX_POOL_CONFIG_BINDING",
  "KEEPER_PI_CODEX_POOL_INITIAL_ALIAS",
  "KEEPER_PI_CODEX_POOL_INITIAL_SCOPE",
  "KEEPER_PI_CODEX_POOL_ALIAS_POLICY",
  "KEEPER_PI_CODEX_POOL_POLICY_BINDING",
  "KEEPER_PI_CODEX_POOL_PROOF_WINDOW",
  "KEEPER_PI_CODEX_POOL_REVISION",
  "KEEPER_PI_CODEX_POOL_CONFIG_ROOT",
] as const;
const savedEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

interface InstalledProof {
  sandbox: string;
  binding: string;
  aliasBinding: string;
  openaiStream: any;
  proofCommand: any;
  tool: any;
  reportPath: string;
}

async function installProof(
  remainingMs = 900_000,
  model: typeof MODEL | typeof SPARK_MODEL = MODEL,
): Promise<InstalledProof> {
  const { installCodexPool } = await import("../src/index.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "codex-pool-orchestrator-"));
  const now = Date.now();
  const armedAt = now - (900_000 - remainingMs);
  const binding = new PoolRouteState(ALIASES, null, () => now).binding;
  const sparkProof = model.id === SPARK_MODEL.id;
  process.env.KEEPER_JOB_ID = "keeper-proof-job";
  process.env.PI_CODING_AGENT_DIR = sandbox;
  process.env.KEEPER_PI_CODEX_POOL_CONFIG_ROOT = sandbox;
  process.env.KEEPER_PI_CODEX_POOL_MODE = "proof";
  process.env.KEEPER_PI_CODEX_POOL_ALIASES = JSON.stringify(ALIASES);
  const aliasPolicy = sparkProof ? SPARK_ALIAS_POLICY : GENERIC_ALIAS_POLICY;
  const parsedPolicy = poolAliasPolicyFromEnvironment(aliasPolicy, ALIASES);
  if (parsedPolicy === null) throw new Error("policy fixture invalid");
  process.env.KEEPER_PI_CODEX_POOL_ALIAS_POLICY = aliasPolicy;
  process.env.KEEPER_PI_CODEX_POOL_POLICY_BINDING = poolAliasPolicyBinding(
    ALIASES,
    parsedPolicy,
  );
  process.env.KEEPER_PI_CODEX_POOL_CONFIG_BINDING = binding;
  process.env.KEEPER_PI_CODEX_POOL_INITIAL_ALIAS = ALIASES[0];
  process.env.KEEPER_PI_CODEX_POOL_INITIAL_SCOPE = sparkProof
    ? CODEX_SPARK_QUOTA_SCOPE
    : CODEX_GENERIC_QUOTA_SCOPE;
  process.env.KEEPER_PI_CODEX_POOL_REVISION = REVISION;
  process.env.KEEPER_PI_CODEX_POOL_PROOF_WINDOW = JSON.stringify({
    schema_version: 1,
    armed_at_ms: armedAt,
    expires_at_ms: armedAt + 900_000,
    launcher_pid: process.ppid,
    seams: { forced_refresh: true, fault_injection: true },
  });
  writePrivateJsonAtomic(join(sandbox, "auth.json"), credentials(now));
  writePrivateJsonAtomic(join(sandbox, "keeper-codex-pool-state.json"), {
    schema_version: 2,
    config_binding: binding,
    accounts: ALIASES.map((alias, index) => ({
      alias,
      quota_scopes: [
        {
          quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
          used_percent: index * 10,
          usage_expires_at_ms: now + 60_000,
          cooldown_until_ms: 0,
          observed_at_ms: now,
          exhausted: false,
        },
        {
          quota_scope: CODEX_SPARK_QUOTA_SCOPE,
          used_percent: index * 10,
          usage_expires_at_ms: now + 60_000,
          cooldown_until_ms: 0,
          observed_at_ms: now,
          exhausted: false,
        },
      ],
      pressure: index,
      pressure_expires_at_ms: index === 0 ? 0 : now + 30_000,
      cooldown_until_ms: 0,
      last_selected_at_ms: 0,
    })),
  });

  let openaiStream: any;
  let proofCommand: any;
  let tool: any;
  let sessionStart: any;
  installCodexPool(
    {
      on(_event: string, handler: unknown) {
        sessionStart = handler;
      },
      registerProvider(name: string, config: { streamSimple?: unknown }) {
        if (name === "openai-codex") openaiStream = config.streamSimple;
      },
      registerCommand(name: string, options: unknown) {
        if (name === "codex-pool-proof") proofCommand = options;
      },
      registerTool(definition: unknown) {
        tool = definition;
      },
    } as never,
    {
      nativeDelegate: nativeStream as never,
      oauth: TEST_OAUTH as never,
      requestUsage: async ({ accountId }) =>
        scopedUsage(
          accountId === "account-private-a" ? 0 : 10,
          accountId !== "account-private-a",
        ),
    },
  );
  sessionStart(
    { reason: "startup" },
    { sessionManager: { getSessionId: () => "root-proof-session" } },
  );
  await consume(
    openaiStream(model, CONTEXT, { sessionId: "root-proof-session" }),
  );

  const { aliasRoleBinding } = await import("../src/proof.ts");
  return {
    sandbox,
    binding,
    aliasBinding: aliasRoleBinding([
      { alias: ALIASES[0], role: "primary" },
      { alias: ALIASES[1], role: "alternate" },
    ]),
    openaiStream,
    proofCommand,
    tool,
    reportPath: join(sandbox, "live-proof.json"),
  };
}

afterEach(() => {
  nativeStreamImpl = successfulStream;
  refreshSequence = 0;
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("atomic Codex pool proof tool", () => {
  test("drives all clauses and writes a sanitation-clean attested report", async () => {
    const installed = await installProof();
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      expect(installed.tool.name).toBe("codex_pool_proof");
      expect(installed.tool.parameters).toEqual({
        type: "object",
        properties: {},
        additionalProperties: false,
      });
      const result = await installed.tool.execute("proof-call", {}, undefined);
      expect(result.details).toEqual({
        schema_version: 1,
        status: "written",
        verdict: "proven",
        interrupted: false,
      });
      const report = JSON.parse(readFileSync(installed.reportPath, "utf8"));
      expect(report.schema_version).toBe(3);
      expect(report.quota_scope).toBe(CODEX_GENERIC_QUOTA_SCOPE);
      expect(reportQuotaScope(report)).toBe(CODEX_GENERIC_QUOTA_SCOPE);
      expect(
        report.routes.every(
          (route: any) => route.quota_scope === CODEX_GENERIC_QUOTA_SCOPE,
        ),
      ).toBe(true);
      expect(report.verdict).toBe("proven");
      const firstRootAlias = report.routes
        .find((route: any) => route.session_role === "root")
        ?.aliases.at(-1);
      const firstChildAlias = report.routes
        .find((route: any) => route.session_role === "child")
        ?.aliases.at(-1);
      expect(firstRootAlias).toBe(firstChildAlias);
      expect(
        report.routes.some(
          (route: any) =>
            route.session_role === "child" &&
            route.aliases.at(-1) !== firstRootAlias,
        ),
      ).toBe(true);
      expect(report.transcript).toHaveLength(13);
      expect(
        report.transcript.every(
          (entry: { evidence: string[] }) => entry.evidence.length > 0,
        ),
      ).toBe(true);
      expect(report.artifact_scan).toEqual({
        status: "clean",
        scanned_count: 8,
        scanned_bytes: report.artifact_scan.scanned_bytes,
        finding_classes: [],
      });
      expect(
        report.routes.some(
          (route: any) =>
            route.attempts === 2 && route.failure_class === "quota",
        ),
      ).toBe(true);
      expect(
        report.routes.some(
          (route: any) =>
            route.attempts === 1 &&
            route.failure_class === "rate" &&
            route.substantive_output,
        ),
      ).toBe(true);
      expect(
        classifyLiveProof(report, {
          revision: REVISION,
          config_binding: installed.binding,
          alias_binding: installed.aliasBinding,
          now_ms: report.completed_at_ms,
        }),
      ).toEqual({ verdict: "proven", reasons: [] });
    } finally {
      console.warn = originalWarn;
      rmSync(installed.sandbox, { recursive: true, force: true });
    }
  });

  test("records empty content starts as pre-output proof evidence", async () => {
    const installed = await installProof();
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      let attempts = 0;
      nativeStreamImpl = () => {
        attempts += 1;
        return {
          async *[Symbol.asyncIterator]() {
            const partial: any = message();
            const emptyThinking = { type: "thinking", thinking: "" };
            yield { type: "start", partial };
            partial.content.push(emptyThinking);
            yield {
              type: "thinking_start",
              contentIndex: 0,
              partial,
            };
            yield {
              type: "error",
              reason: "error",
              error: {
                ...message("error"),
                content: partial.content,
                errorMessage: "WebSocket error",
              },
            };
          },
          result: async () => ({
            ...message("error"),
            content: [{ type: "thinking", thinking: "" }],
            errorMessage: "WebSocket error",
          }),
        };
      };

      await consume(
        installed.openaiStream(MODEL, CONTEXT, {
          sessionId: "empty-start-proof-session",
        }),
      );
      expect(attempts).toBe(2);

      const notifications: string[] = [];
      await installed.proofCommand.handler("", {
        ui: {
          notify(rendered: string) {
            notifications.push(rendered);
          },
        },
      });
      expect(JSON.parse(notifications.at(-1) as string).status).toBe("written");
      const report = JSON.parse(readFileSync(installed.reportPath, "utf8"));
      expect(
        report.routes.some(
          (route: any) =>
            route.attempts === 2 &&
            route.failure_class === "transport" &&
            route.substantive_output === false,
        ),
      ).toBe(true);
    } finally {
      console.warn = originalWarn;
      rmSync(installed.sandbox, { recursive: true, force: true });
    }
  });

  test("writes Spark proof reports under the Spark quota scope", async () => {
    const installed = await installProof(900_000, SPARK_MODEL);
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const result = await installed.tool.execute(
        "proof-call-spark",
        {},
        undefined,
      );
      expect(result.details).toEqual({
        schema_version: 1,
        status: "written",
        verdict: "proven",
        interrupted: false,
      });
      const report = JSON.parse(readFileSync(installed.reportPath, "utf8"));
      expect(report.schema_version).toBe(3);
      expect(report.quota_scope).toBe(CODEX_SPARK_QUOTA_SCOPE);
      expect(reportQuotaScope(report)).toBe(CODEX_SPARK_QUOTA_SCOPE);
      expect(
        report.routes.every(
          (route: any) =>
            route.quota_scope === CODEX_SPARK_QUOTA_SCOPE &&
            route.aliases.every((alias: string) => alias === "keeper-codex-b"),
        ),
      ).toBe(true);
      expect(report.alias_health).toEqual([
        {
          alias: "keeper-codex-a",
          scope_supported: false,
          status: "unavailable",
        },
        {
          alias: "keeper-codex-b",
          scope_supported: true,
          status: "healthy",
        },
      ]);
      expect(report.degraded).toBeNull();
      expect(
        classifyLiveProof(report, {
          revision: REVISION,
          config_binding: installed.binding,
          alias_binding: installed.aliasBinding,
          now_ms: report.completed_at_ms,
        }),
      ).toEqual({ verdict: "proven", reasons: [] });
    } finally {
      console.warn = originalWarn;
      rmSync(installed.sandbox, { recursive: true, force: true });
    }
  });

  for (const interruption of ["external", "deadline"] as const) {
    test(`records ${interruption} interruption and never proves the run`, async () => {
      const installed = await installProof(
        interruption === "deadline" ? 100 : 900_000,
      );
      try {
        const controller = new AbortController();
        if (interruption === "external") controller.abort();
        const result = await installed.tool.execute(
          "proof-interruption",
          {},
          controller.signal,
        );
        expect(result.details).toEqual(
          expect.objectContaining({
            status: "written",
            interrupted: true,
          }),
        );
        expect(result.details.verdict).not.toBe("proven");
        const report = JSON.parse(readFileSync(installed.reportPath, "utf8"));
        expect(report.interrupted).toBe(true);
        expect(report.verdict).not.toBe("proven");
        expect(
          classifyLiveProof(report, {
            revision: REVISION,
            config_binding: installed.binding,
            alias_binding: installed.aliasBinding,
            now_ms: report.completed_at_ms,
          }),
        ).toEqual(
          expect.objectContaining({
            verdict: "incomplete",
            reasons: expect.arrayContaining(["interrupted"]),
          }),
        );
      } finally {
        rmSync(installed.sandbox, { recursive: true, force: true });
      }
    });
  }

  test("is absent without a Keeper job and registration failure is fail-open", async () => {
    const { installCodexPool } = await import("../src/index.ts");
    const providers: string[] = [];
    delete process.env.KEEPER_JOB_ID;
    installCodexPool({
      registerProvider(name: string) {
        providers.push(name);
      },
      registerCommand() {},
      registerTool() {
        throw new Error("must-not-register");
      },
    } as never);
    expect(providers).toEqual([]);

    const installed = await installProof();
    try {
      expect(installed.tool).toBeDefined();
      const sandbox = mkdtempSync(join(tmpdir(), "codex-pool-register-fail-"));
      const now = Date.now();
      process.env.PI_CODING_AGENT_DIR = sandbox;
      process.env.KEEPER_PI_CODEX_POOL_CONFIG_ROOT = sandbox;
      process.env.KEEPER_PI_CODEX_POOL_REVISION = REVISION;
      process.env.KEEPER_PI_CODEX_POOL_PROOF_WINDOW = JSON.stringify({
        schema_version: 1,
        armed_at_ms: now,
        expires_at_ms: now + 900_000,
        launcher_pid: process.ppid,
        seams: { forced_refresh: true, fault_injection: true },
      });
      writePrivateJsonAtomic(join(sandbox, "auth.json"), credentials(now));
      let registrationAttempted = false;
      expect(() =>
        installCodexPool(
          {
            registerProvider() {},
            registerCommand() {},
            registerTool() {
              registrationAttempted = true;
              throw new Error("registration-failed");
            },
          } as never,
          { nativeDelegate: nativeStream as never, oauth: TEST_OAUTH as never },
        ),
      ).not.toThrow();
      expect(registrationAttempted).toBe(true);
      rmSync(sandbox, { recursive: true, force: true });
    } finally {
      rmSync(installed.sandbox, { recursive: true, force: true });
    }
    expect(existsSync(installed.reportPath)).toBe(false);
  });
});

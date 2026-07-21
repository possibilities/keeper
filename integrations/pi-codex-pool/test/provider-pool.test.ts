// biome-ignore-all lint/suspicious/noExplicitAny: Structural Pi stream doubles avoid loading peer modules in correctness tests.
// biome-ignore-all lint/style/noNonNullAssertion: Fixture guards and deferred callbacks establish values before use.
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  captureCodexPoolProof,
  codexPoolBindings,
  FileCodexPoolActivationStore,
  resolveCodexPoolWorkflowPaths,
} from "../../../src/codex-pool-activation.ts";
import {
  CODEX_GENERIC_QUOTA_SCOPE,
  CODEX_SPARK_QUOTA_SCOPE,
} from "../../../src/codex-quota-scope.ts";
import { walkClosure } from "../../../test/helpers/depgraph.ts";
import {
  CredentialVault,
  FileCredentialStorage,
  MemoryCredentialStorage,
  writePrivateJsonAtomic,
} from "../src/auth.ts";
import { classifyPoolFailure, createPooledCodexStream } from "../src/pool.ts";
import {
  MAX_POOL_FAILURE_LOG_RECORDS,
  MAX_POOL_FAILURE_MESSAGE_BYTES,
  type PersistedPoolState,
  POOL_STATE_SCHEMA_VERSION,
  PoolFailureLog,
  PoolRouteState,
  PoolStateStore,
  type PoolStateTransactResult,
  poolAliasPolicyBinding,
  poolAliasPolicyFromEnvironment,
} from "../src/state.ts";
import { acquireOwnerFileLock } from "../src/state-lock.ts";
import { parseUsageResponse, unavailableUsage } from "../src/usage.ts";

const MODEL = {
  id: "gpt-test",
  name: "GPT Test",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
} as const;
const CONTEXT = {
  systemPrompt: "system",
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

function message(
  stopReason: "stop" | "error" | "aborted" = "stop",
  errorMessage?: string,
) {
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
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp: 1,
  };
}

function stream(events: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    result: async () => message(),
  };
}

async function collect(source: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of source) events.push(event);
  return events;
}

function credentials(expires = 10_000) {
  return {
    "keeper-codex-a": {
      type: "oauth" as const,
      access: "fake-access-a",
      refresh: "fake-refresh-a",
      expires,
    },
    "keeper-codex-b": {
      type: "oauth" as const,
      access: "fake-access-b",
      refresh: "fake-refresh-b",
      expires,
    },
  };
}

function scopedUsage(genericPercent: number, sparkPercent: number | null) {
  return {
    rate_limit: {
      allowed: genericPercent < 100,
      limit_reached: genericPercent >= 100,
      primary_window: {
        used_percent: genericPercent,
        reset_at: 200,
        limit_window_seconds: 18_000,
      },
    },
    ...(sparkPercent === null
      ? {}
      : {
          additional_rate_limits: [
            {
              limit_name: "GPT-5.3-Codex-Spark",
              rate_limit: {
                primary_window: {
                  used_percent: sparkPercent,
                  reset_at: 250,
                },
              },
            },
          ],
        }),
  };
}

function applyScopedUsage(
  routes: PoolRouteState,
  alias: string,
  genericPercent: number,
  sparkPercent: number | null,
  nowMs = 100,
): void {
  routes.applyUsage(
    parseUsageResponse(alias, scopedUsage(genericPercent, sparkPercent), nowMs),
  );
}

function aliasPolicy(
  aliases: readonly string[],
  scopes: readonly string[] = [CODEX_GENERIC_QUOTA_SCOPE],
) {
  const policy = poolAliasPolicyFromEnvironment(
    JSON.stringify({
      [CODEX_GENERIC_QUOTA_SCOPE]: scopes.includes(CODEX_GENERIC_QUOTA_SCOPE)
        ? aliases
        : [],
      [CODEX_SPARK_QUOTA_SCOPE]: scopes.includes(CODEX_SPARK_QUOTA_SCOPE)
        ? aliases
        : [],
    }),
    aliases,
  );
  if (policy === null) throw new Error("policy fixture invalid");
  return policy;
}

function bothScopesPolicy(aliases: readonly string[]) {
  return aliasPolicy(aliases, [
    CODEX_GENERIC_QUOTA_SCOPE,
    CODEX_SPARK_QUOTA_SCOPE,
  ]);
}

function aliasPolicyEnv(
  aliases: readonly string[],
  scopes: readonly string[] = [CODEX_GENERIC_QUOTA_SCOPE],
): string {
  return JSON.stringify(aliasPolicy(aliases, scopes));
}

function aliasPolicyBindingEnv(
  aliases: readonly string[],
  scopes: readonly string[] = [CODEX_GENERIC_QUOTA_SCOPE],
): string {
  return poolAliasPolicyBinding(aliases, aliasPolicy(aliases, scopes));
}

function setAliasPolicyEnv(
  aliases: readonly string[],
  scopes: readonly string[] = [CODEX_GENERIC_QUOTA_SCOPE],
): void {
  process.env.KEEPER_PI_CODEX_POOL_ALIAS_POLICY = aliasPolicyEnv(
    aliases,
    scopes,
  );
  process.env.KEEPER_PI_CODEX_POOL_POLICY_BINDING = aliasPolicyBindingEnv(
    aliases,
    scopes,
  );
}

function routeState(
  aliases: readonly string[] = ["keeper-codex-a", "keeper-codex-b"],
  now: () => number = () => 100,
): PoolRouteState {
  return new PoolRouteState(
    aliases,
    null,
    now,
    undefined,
    CODEX_GENERIC_QUOTA_SCOPE,
    aliasPolicy(aliases),
  );
}

function processStartId(pid: number): string {
  return `test-process-start-${pid}`;
}

function lockOwner(
  pid: number,
  nonce: string,
  startId = processStartId(pid),
): string {
  return `${JSON.stringify({
    schema_version: 2,
    pid,
    process_start_id: startId,
    nonce,
  })}\n`;
}

function accountSnapshot(routes: PoolRouteState, alias = "keeper-codex-a") {
  const account = routes
    .snapshot()
    .accounts.find((entry) => entry.alias === alias);
  if (account === undefined) throw new Error("missing account fixture");
  return account;
}

class InjectedFailurePoolStateStore extends PoolStateStore {
  failNextStage: "lock" | "load" | "save" | null = null;

  transact<T>(
    aliases: readonly string[],
    binding: string,
    mutate: (state: PersistedPoolState) => T,
    now = Date.now(),
  ): PoolStateTransactResult<T> {
    const stage = this.failNextStage;
    this.failNextStage = null;
    if (stage !== null) {
      return { ok: false, stage, error: new Error(`injected-${stage}`) };
    }
    return super.transact(aliases, binding, mutate, now);
  }
}

const extensionDelegateApiKeys: Array<string | undefined> = [];
const emptyNativeStream = () => ({
  async *[Symbol.asyncIterator]() {},
  result: async () => message(),
});
let extensionDelegateImpl: (
  model: unknown,
  context: unknown,
  options?: { apiKey?: string; sessionId?: string },
) => any = emptyNativeStream;
const nativeStream = (
  model: unknown,
  context: unknown,
  options?: { apiKey?: string; sessionId?: string },
) => {
  extensionDelegateApiKeys.push(options?.apiKey);
  return extensionDelegateImpl(model, context, options);
};

mock.module("@earendil-works/pi-ai", () => ({
  openAICodexResponsesApi: () => ({ streamSimple: nativeStream }),
}));
mock.module("@earendil-works/pi-ai/providers/all", () => ({
  builtinProviders: () => [
    {
      id: "openai-codex",
      auth: {
        oauth: {
          name: "Codex",
          login: async () => credentials()["keeper-codex-a"],
          refresh: async (credential: any) => ({
            ...credential,
            access: `refreshed-${credential.access}`,
            refresh: `rotated-${credential.refresh}`,
            expires: credential.expires + 3_600_000,
          }),
          toAuth: async () => ({ apiKey: "fake" }),
        },
      },
    },
  ],
}));

const savedEnv = {
  KEEPER_JOB_ID: process.env.KEEPER_JOB_ID,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  KEEPER_PI_CODEX_POOL_ALIASES: process.env.KEEPER_PI_CODEX_POOL_ALIASES,
  KEEPER_PI_CODEX_POOL_MODE: process.env.KEEPER_PI_CODEX_POOL_MODE,
  KEEPER_PI_CODEX_POOL_CONFIG_BINDING:
    process.env.KEEPER_PI_CODEX_POOL_CONFIG_BINDING,
  KEEPER_PI_CODEX_POOL_INITIAL_ALIAS:
    process.env.KEEPER_PI_CODEX_POOL_INITIAL_ALIAS,
  KEEPER_PI_CODEX_POOL_INITIAL_SCOPE:
    process.env.KEEPER_PI_CODEX_POOL_INITIAL_SCOPE,
  KEEPER_PI_CODEX_POOL_ALIAS_POLICY:
    process.env.KEEPER_PI_CODEX_POOL_ALIAS_POLICY,
  KEEPER_PI_CODEX_POOL_POLICY_BINDING:
    process.env.KEEPER_PI_CODEX_POOL_POLICY_BINDING,
  KEEPER_PI_CODEX_POOL_PROOF_WINDOW:
    process.env.KEEPER_PI_CODEX_POOL_PROOF_WINDOW,
  KEEPER_PI_CODEX_POOL_REVISION: process.env.KEEPER_PI_CODEX_POOL_REVISION,
  KEEPER_PI_CODEX_POOL_CONFIG_ROOT:
    process.env.KEEPER_PI_CODEX_POOL_CONFIG_ROOT,
};

afterEach(() => {
  extensionDelegateApiKeys.length = 0;
  extensionDelegateImpl = emptyNativeStream;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("provider registration and compatibility", () => {
  test("standalone Pi is inert while a Keeper-marked native-mode instance registers aliases and fallback", async () => {
    const { installCodexPool } = await import("../src/index.ts");
    const sandbox = mkdtempSync(join(tmpdir(), "codex-pool-extension-"));
    process.env.PI_CODING_AGENT_DIR = sandbox;
    const providers: string[] = [];
    const commands: string[] = [];
    const pi = {
      registerProvider(name: string) {
        providers.push(name);
      },
      registerCommand(name: string) {
        commands.push(name);
      },
    };
    delete process.env.KEEPER_JOB_ID;
    installCodexPool(pi as never);
    expect(providers).toEqual([]);
    expect(commands).toEqual([]);

    process.env.KEEPER_JOB_ID = "keeper-session";
    process.env.KEEPER_PI_CODEX_POOL_MODE = "native";
    setAliasPolicyEnv(["keeper-codex-a", "keeper-codex-b"]);
    installCodexPool(pi as never);
    expect(providers).toEqual([
      "keeper-codex-a",
      "keeper-codex-b",
      "openai-codex",
    ]);
    expect(commands).toEqual(["codex-pool-observe"]);
    rmSync(sandbox, { recursive: true, force: true });
  });

  test("active mode without an alias policy falls back to native Codex", async () => {
    const { installCodexPool } = await import("../src/index.ts");
    const sandbox = mkdtempSync(join(tmpdir(), "codex-pool-no-policy-"));
    try {
      const aliases = ["keeper-codex-a", "keeper-codex-b"];
      process.env.KEEPER_JOB_ID = "keeper-no-policy-session";
      process.env.PI_CODING_AGENT_DIR = sandbox;
      process.env.KEEPER_PI_CODEX_POOL_MODE = "active";
      process.env.KEEPER_PI_CODEX_POOL_ALIASES = JSON.stringify(aliases);
      process.env.KEEPER_PI_CODEX_POOL_CONFIG_BINDING =
        routeState(aliases).binding;
      delete process.env.KEEPER_PI_CODEX_POOL_ALIAS_POLICY;
      delete process.env.KEEPER_PI_CODEX_POOL_POLICY_BINDING;
      let openaiStream: any;
      const providers: string[] = [];
      installCodexPool({
        registerProvider(name: string, config: { streamSimple?: unknown }) {
          providers.push(name);
          if (name === "openai-codex") openaiStream = config.streamSimple;
        },
        registerCommand() {},
      } as never);
      await collect(openaiStream(MODEL, CONTEXT, { sessionId: "native" }));
      expect(providers).toEqual(["openai-codex"]);
      expect(extensionDelegateApiKeys).toEqual([undefined]);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("active/proof routing requires an exact policy binding", async () => {
    const { installCodexPool } = await import("../src/index.ts");
    const originalWarn = console.warn;
    try {
      const cases: Array<{
        mode: "active" | "proof";
        scopes: readonly string[];
        binding?: string;
      }> = [
        { mode: "active", scopes: [CODEX_GENERIC_QUOTA_SCOPE] },
        {
          mode: "active" as const,
          scopes: [CODEX_GENERIC_QUOTA_SCOPE],
          binding: "f".repeat(64),
        },
        {
          mode: "active" as const,
          scopes: [CODEX_GENERIC_QUOTA_SCOPE, CODEX_SPARK_QUOTA_SCOPE],
          binding: aliasPolicyBindingEnv(["keeper-codex-a", "keeper-codex-b"]),
        },
        { mode: "proof", scopes: [CODEX_GENERIC_QUOTA_SCOPE] },
      ];
      for (const testCase of cases) {
        extensionDelegateApiKeys.length = 0;
        const warnings: string[] = [];
        console.warn = (message?: unknown) => warnings.push(String(message));
        const sandbox = mkdtempSync(join(tmpdir(), "codex-pool-policy-bind-"));
        try {
          const now = Date.now();
          const aliases = ["keeper-codex-a", "keeper-codex-b"];
          process.env.KEEPER_JOB_ID = `keeper-${testCase.mode}-policy-bind`;
          process.env.PI_CODING_AGENT_DIR = sandbox;
          process.env.KEEPER_PI_CODEX_POOL_CONFIG_ROOT = sandbox;
          process.env.KEEPER_PI_CODEX_POOL_MODE = testCase.mode;
          process.env.KEEPER_PI_CODEX_POOL_ALIASES = JSON.stringify(aliases);
          process.env.KEEPER_PI_CODEX_POOL_ALIAS_POLICY = aliasPolicyEnv(
            aliases,
            testCase.scopes,
          );
          if (testCase.binding === undefined) {
            delete process.env.KEEPER_PI_CODEX_POOL_POLICY_BINDING;
          } else {
            process.env.KEEPER_PI_CODEX_POOL_POLICY_BINDING = testCase.binding;
          }
          process.env.KEEPER_PI_CODEX_POOL_CONFIG_BINDING = routeState(
            aliases,
            () => now,
          ).binding;
          if (testCase.mode === "proof") {
            process.env.KEEPER_PI_CODEX_POOL_PROOF_WINDOW = JSON.stringify({
              schema_version: 1,
              armed_at_ms: now,
              expires_at_ms: now + 900_000,
              launcher_pid: process.ppid,
            });
          }
          writePrivateJsonAtomic(join(sandbox, "auth.json"), {
            "keeper-codex-a": credentials(now + 120_000)["keeper-codex-a"],
            "keeper-codex-b": credentials(now + 120_000)["keeper-codex-b"],
          });
          let openaiStream: any;
          installCodexPool({
            registerProvider(name: string, config: { streamSimple?: unknown }) {
              if (name === "openai-codex") openaiStream = config.streamSimple;
            },
            registerCommand() {},
          } as never);

          await collect(
            openaiStream(MODEL, CONTEXT, { sessionId: "fallback" }),
          );
          expect(extensionDelegateApiKeys).toEqual([undefined]);
          expect(warnings).toEqual([
            "[keeper-codex-pool] pool-unavailable; using native openai-codex",
          ]);
        } finally {
          rmSync(sandbox, { recursive: true, force: true });
        }
      }
    } finally {
      console.warn = originalWarn;
    }
  });

  test("a valid proof window installs the real pooled delegate and consumes its carrier", async () => {
    const { installCodexPool } = await import("../src/index.ts");
    const sandbox = mkdtempSync(join(tmpdir(), "codex-pool-proof-window-"));
    try {
      const now = Date.now();
      process.env.KEEPER_JOB_ID = "keeper-proof-session";
      process.env.PI_CODING_AGENT_DIR = sandbox;
      process.env.KEEPER_PI_CODEX_POOL_MODE = "proof";
      process.env.KEEPER_PI_CODEX_POOL_ALIASES =
        '["keeper-codex-a","keeper-codex-b"]';
      setAliasPolicyEnv(["keeper-codex-a", "keeper-codex-b"]);
      process.env.KEEPER_PI_CODEX_POOL_CONFIG_BINDING = new PoolRouteState(
        ["keeper-codex-a", "keeper-codex-b"],
        null,
        () => now,
      ).binding;
      process.env.KEEPER_PI_CODEX_POOL_PROOF_WINDOW = JSON.stringify({
        schema_version: 1,
        armed_at_ms: now,
        expires_at_ms: now + 900_000,
        launcher_pid: process.ppid,
      });
      writePrivateJsonAtomic(join(sandbox, "auth.json"), {
        "keeper-codex-a": credentials(now + 120_000)["keeper-codex-a"],
        "keeper-codex-b": credentials(now + 120_000)["keeper-codex-b"],
      });
      let openaiStream: any;
      installCodexPool({
        registerProvider(name: string, config: { streamSimple?: unknown }) {
          if (name === "openai-codex") openaiStream = config.streamSimple;
        },
        registerCommand() {},
      } as never);

      expect(process.env.KEEPER_PI_CODEX_POOL_PROOF_WINDOW).toBeUndefined();
      await collect(
        openaiStream(MODEL, CONTEXT, { sessionId: "proof-root-session" }),
      );
      expect(extensionDelegateApiKeys).toHaveLength(2);
      expect(new Set(extensionDelegateApiKeys)).toEqual(
        new Set(["fake-access-a", "fake-access-b"]),
      );
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("an installed proof delegate falls back natively at its deadline", async () => {
    const { installCodexPool } = await import("../src/index.ts");
    const sandbox = mkdtempSync(join(tmpdir(), "codex-pool-proof-expiry-"));
    const originalNow = Date.now;
    const originalWarn = console.warn;
    let now = 1_000_000;
    const warnings: string[] = [];
    try {
      Date.now = () => now;
      console.warn = (message?: unknown) => warnings.push(String(message));
      process.env.KEEPER_JOB_ID = "keeper-expiring-proof-session";
      process.env.PI_CODING_AGENT_DIR = sandbox;
      process.env.KEEPER_PI_CODEX_POOL_CONFIG_ROOT = sandbox;
      process.env.KEEPER_PI_CODEX_POOL_MODE = "proof";
      process.env.KEEPER_PI_CODEX_POOL_ALIASES =
        '["keeper-codex-a","keeper-codex-b"]';
      setAliasPolicyEnv(["keeper-codex-a", "keeper-codex-b"]);
      process.env.KEEPER_PI_CODEX_POOL_CONFIG_BINDING = new PoolRouteState(
        ["keeper-codex-a", "keeper-codex-b"],
        null,
        () => now,
      ).binding;
      process.env.KEEPER_PI_CODEX_POOL_PROOF_WINDOW = JSON.stringify({
        schema_version: 1,
        armed_at_ms: 1_000_000,
        expires_at_ms: 1_900_000,
        launcher_pid: process.ppid,
      });
      writePrivateJsonAtomic(join(sandbox, "auth.json"), {
        "keeper-codex-a": credentials(3_000_000)["keeper-codex-a"],
        "keeper-codex-b": credentials(3_000_000)["keeper-codex-b"],
      });
      let openaiStream: any;
      let proofCommand: any;
      installCodexPool({
        registerProvider(name: string, config: { streamSimple?: unknown }) {
          if (name === "openai-codex") openaiStream = config.streamSimple;
        },
        registerCommand(name: string, options: unknown) {
          if (name === "codex-pool-proof") proofCommand = options;
        },
      } as never);

      now = 1_900_000;
      await collect(
        openaiStream(MODEL, CONTEXT, { sessionId: "expired-proof-session" }),
      );
      expect(extensionDelegateApiKeys).toEqual([undefined]);
      expect(warnings).toEqual([
        "[keeper-codex-pool] pool-unavailable; using native openai-codex",
      ]);
      await proofCommand.handler("", { ui: { notify() {} } });
      expect(existsSync(join(sandbox, "live-proof.json"))).toBe(false);
    } finally {
      Date.now = originalNow;
      console.warn = originalWarn;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("keeps manually assembled evidence diagnostic-only", async () => {
    const { installCodexPool } = await import("../src/index.ts");
    const sandbox = mkdtempSync(join(tmpdir(), "codex-pool-live-proof-"));
    const revision = "0123456789abcdef0123456789abcdef01234567";
    const now = Date.now();
    const aliases = ["keeper-codex-a", "keeper-codex-b"];
    const binding = routeState(aliases, () => now).binding;
    const calls = new Map<string, number>();
    let failNativeFallback = false;
    extensionDelegateImpl = (_model, _context, options) => {
      const sessionId = options?.sessionId ?? "native";
      const count = (calls.get(sessionId) ?? 0) + 1;
      calls.set(sessionId, count);
      const start = { type: "start", partial: message() };
      const text = {
        type: "text_delta",
        contentIndex: 0,
        delta: "ok",
        partial: { ...message(), content: [{ type: "text", text: "ok" }] },
      };
      const done = { type: "done", reason: "stop", message: message() };
      if (sessionId === "native" && failNativeFallback) {
        return stream([
          start,
          {
            type: "error",
            reason: "error",
            error: message("error", "native unavailable"),
          },
        ]);
      }
      if (sessionId === "retry-session" && count === 1) {
        return stream([
          start,
          {
            type: "error",
            reason: "error",
            error: message("error", "quota reached"),
          },
        ]);
      }
      if (sessionId === "cutoff-session") {
        return stream([
          start,
          text,
          {
            type: "error",
            reason: "error",
            error: message("error", "quota reached"),
          },
        ]);
      }
      if (sessionId === "abort-session") {
        return stream([
          start,
          {
            type: "error",
            reason: "aborted",
            error: message("aborted", "request aborted"),
          },
        ]);
      }
      return stream([start, text, done]);
    };

    try {
      process.env.KEEPER_JOB_ID = "keeper-live-proof-session";
      process.env.PI_CODING_AGENT_DIR = sandbox;
      process.env.KEEPER_PI_CODEX_POOL_CONFIG_ROOT = sandbox;
      process.env.KEEPER_PI_CODEX_POOL_MODE = "proof";
      process.env.KEEPER_PI_CODEX_POOL_ALIASES = JSON.stringify(aliases);
      setAliasPolicyEnv(aliases);
      process.env.KEEPER_PI_CODEX_POOL_CONFIG_BINDING = binding;
      process.env.KEEPER_PI_CODEX_POOL_REVISION = revision;
      process.env.KEEPER_PI_CODEX_POOL_PROOF_WINDOW = JSON.stringify({
        schema_version: 1,
        armed_at_ms: now,
        expires_at_ms: now + 900_000,
        launcher_pid: process.ppid,
      });
      writePrivateJsonAtomic(join(sandbox, "auth.json"), {
        "keeper-codex-a": credentials(now + 1)["keeper-codex-a"],
        "keeper-codex-b": credentials(now + 1)["keeper-codex-b"],
      });
      let openaiStream: any;
      let sessionStart: any;
      const commands = new Map<string, any>();
      const notifications: Array<{ message: string; level: string }> = [];
      installCodexPool({
        on(_event: string, handler: unknown) {
          sessionStart = handler;
        },
        registerProvider(name: string, config: { streamSimple?: unknown }) {
          if (name === "openai-codex") openaiStream = config.streamSimple;
        },
        registerCommand(name: string, options: unknown) {
          commands.set(name, options);
        },
      } as never);
      const context = {
        ui: {
          notify(message: string, level: string) {
            notifications.push({ message, level });
          },
        },
      };

      sessionStart(
        { reason: "startup" },
        { sessionManager: { getSessionId: () => "root-session" } },
      );
      await commands.get("codex-pool-observe").handler("", context);
      await commands.get("codex-pool-proof").handler("", context);
      expect(existsSync(join(sandbox, "live-proof.json"))).toBe(false);
      expect(notifications.at(-1)).toEqual({
        message: JSON.stringify({
          schema_version: 1,
          status: "unavailable",
          reason: "proof-write-failed",
        }),
        level: "error",
      });
      await Promise.all([
        collect(openaiStream(MODEL, CONTEXT, { sessionId: "root-session" })),
        collect(openaiStream(MODEL, CONTEXT, { sessionId: "child-session" })),
      ]);
      await collect(
        openaiStream(MODEL, CONTEXT, { sessionId: "root-session" }),
      );
      for (const sessionId of [
        "retry-session",
        "cutoff-session",
        "abort-session",
      ]) {
        await collect(openaiStream(MODEL, CONTEXT, { sessionId }));
      }
      await collect(openaiStream(MODEL, CONTEXT));
      await commands.get("codex-pool-proof").handler("", context);

      const path = join(sandbox, "live-proof.json");
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const report = JSON.parse(readFileSync(path, "utf8"));
      expect(report.schema_version).toBe(2);
      expect(report.quota_scope).toBe(CODEX_GENERIC_QUOTA_SCOPE);
      expect(
        report.routes.every(
          (route: any) => route.quota_scope === CODEX_GENERIC_QUOTA_SCOPE,
        ),
      ).toBe(true);
      expect(report.verdict).toBe("incomplete");
      expect(report.artifact_scan.status).toBe("clean");
      expect(notifications.at(-1)).toEqual({
        message: JSON.stringify({
          schema_version: 1,
          status: "written",
          verdict: "incomplete",
        }),
        level: "warning",
      });

      const store = new FileCodexPoolActivationStore(
        resolveCodexPoolWorkflowPaths({
          KEEPER_PI_CODEX_POOL_CONFIG_ROOT: sandbox,
        }),
      );
      expect(
        captureCodexPoolProof(
          {
            store,
            bindings: codexPoolBindings(revision, aliases),
            nowMs: () => Date.now(),
          },
          path,
        ),
      ).toEqual(
        expect.objectContaining({
          schema_version: 1,
          ok: true,
          operation: "proof-capture",
          state: "native",
          problem_code: "proof-incomplete",
          proof: expect.objectContaining({
            verdict: "incomplete",
            reasons: expect.arrayContaining(["clause-incomplete"]),
          }),
        }),
      );

      failNativeFallback = true;
      await collect(openaiStream(MODEL, CONTEXT));
      await commands.get("codex-pool-proof").handler("", context);
      expect(JSON.parse(readFileSync(path, "utf8")).verdict).not.toBe("proven");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("keeps collection inert in native and active modes", async () => {
    const { installCodexPool } = await import("../src/index.ts");
    for (const mode of ["native", "active"] as const) {
      const sandbox = mkdtempSync(join(tmpdir(), `codex-pool-${mode}-`));
      try {
        const now = Date.now();
        const aliases = ["keeper-codex-a", "keeper-codex-b"];
        process.env.KEEPER_JOB_ID = `keeper-${mode}-session`;
        process.env.PI_CODING_AGENT_DIR = sandbox;
        process.env.KEEPER_PI_CODEX_POOL_CONFIG_ROOT = sandbox;
        process.env.KEEPER_PI_CODEX_POOL_MODE = mode;
        process.env.KEEPER_PI_CODEX_POOL_ALIASES = JSON.stringify(aliases);
        setAliasPolicyEnv(aliases);
        process.env.KEEPER_PI_CODEX_POOL_CONFIG_BINDING = new PoolRouteState(
          aliases,
          null,
          () => now,
        ).binding;
        writePrivateJsonAtomic(join(sandbox, "auth.json"), {
          "keeper-codex-a": credentials(now + 120_000)["keeper-codex-a"],
          "keeper-codex-b": credentials(now + 120_000)["keeper-codex-b"],
        });
        let openaiStream: any;
        const commands: string[] = [];
        installCodexPool({
          registerProvider(name: string, config: { streamSimple?: unknown }) {
            if (name === "openai-codex") openaiStream = config.streamSimple;
          },
          registerCommand(name: string) {
            commands.push(name);
          },
        } as never);
        expect(commands).toEqual(["codex-pool-observe"]);
        await collect(
          openaiStream(MODEL, CONTEXT, { sessionId: `${mode}-session` }),
        );
        expect(existsSync(join(sandbox, "live-proof.json"))).toBe(false);
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    }
  });

  test("active mode keeps sessionless compaction traffic on the root route", async () => {
    const { installCodexPool } = await import("../src/index.ts");
    const sandbox = mkdtempSync(join(tmpdir(), "codex-pool-compaction-"));
    try {
      const now = Date.now();
      const aliases = ["keeper-codex-a", "keeper-codex-b"];
      process.env.KEEPER_JOB_ID = "keeper-launch-session";
      process.env.PI_CODING_AGENT_DIR = sandbox;
      process.env.KEEPER_PI_CODEX_POOL_CONFIG_ROOT = sandbox;
      process.env.KEEPER_PI_CODEX_POOL_MODE = "active";
      process.env.KEEPER_PI_CODEX_POOL_ALIASES = JSON.stringify(aliases);
      setAliasPolicyEnv(aliases);
      process.env.KEEPER_PI_CODEX_POOL_CONFIG_BINDING = routeState(
        aliases,
        () => now,
      ).binding;
      process.env.KEEPER_PI_CODEX_POOL_INITIAL_ALIAS = "keeper-codex-b";
      writePrivateJsonAtomic(join(sandbox, "auth.json"), {
        "keeper-codex-a": credentials(now + 120_000)["keeper-codex-a"],
        "keeper-codex-b": credentials(now + 120_000)["keeper-codex-b"],
      });

      let openaiStream: any;
      let sessionStart: any;
      const delegatedSessionIds: Array<string | undefined> = [];
      extensionDelegateImpl = (_model, _context, options) => {
        delegatedSessionIds.push(options?.sessionId);
        return stream([
          { type: "start", partial: message() },
          { type: "done", reason: "stop", message: message() },
        ]);
      };
      installCodexPool({
        on(_event: string, handler: unknown) {
          sessionStart = handler;
        },
        registerProvider(name: string, config: { streamSimple?: unknown }) {
          if (name === "openai-codex") openaiStream = config.streamSimple;
        },
        registerCommand() {},
      } as never);

      sessionStart(
        { reason: "startup" },
        { sessionManager: { getSessionId: () => "root-session" } },
      );
      await collect(openaiStream(MODEL, CONTEXT));

      expect(delegatedSessionIds).toEqual(["root-session"]);
      expect(extensionDelegateApiKeys).toEqual(["fake-access-b"]);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("does not consume a launch alias tagged for another quota scope", async () => {
    const { installCodexPool } = await import("../src/index.ts");
    const sandbox = mkdtempSync(join(tmpdir(), "codex-pool-initial-scope-"));
    try {
      const now = Date.now();
      const aliases = ["keeper-codex-a", "keeper-codex-b"];
      process.env.KEEPER_JOB_ID = "keeper-initial-scope-session";
      process.env.PI_CODING_AGENT_DIR = sandbox;
      process.env.KEEPER_PI_CODEX_POOL_MODE = "active";
      process.env.KEEPER_PI_CODEX_POOL_ALIASES = JSON.stringify(aliases);
      setAliasPolicyEnv(aliases, [
        CODEX_GENERIC_QUOTA_SCOPE,
        CODEX_SPARK_QUOTA_SCOPE,
      ]);
      process.env.KEEPER_PI_CODEX_POOL_CONFIG_BINDING = routeState(
        aliases,
        () => now,
      ).binding;
      process.env.KEEPER_PI_CODEX_POOL_INITIAL_ALIAS = "keeper-codex-b";
      process.env.KEEPER_PI_CODEX_POOL_INITIAL_SCOPE = CODEX_SPARK_QUOTA_SCOPE;
      writePrivateJsonAtomic(join(sandbox, "auth.json"), {
        "keeper-codex-a": credentials(now + 120_000)["keeper-codex-a"],
        "keeper-codex-b": credentials(now + 120_000)["keeper-codex-b"],
      });

      let openaiStream: any;
      extensionDelegateImpl = () =>
        stream([
          { type: "start", partial: message() },
          { type: "done", reason: "stop", message: message() },
        ]);
      installCodexPool({
        registerProvider(name: string, config: { streamSimple?: unknown }) {
          if (name === "openai-codex") openaiStream = config.streamSimple;
        },
        registerCommand() {},
      } as never);

      await collect(openaiStream(MODEL, CONTEXT, { sessionId: "generic" }));
      expect(extensionDelegateApiKeys).toEqual(["fake-access-a"]);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("keeps the extension import graph free of Bun-only builtins", () => {
    const root = resolve(import.meta.dir, "../src/index.ts");
    const closure = walkClosure(root).files;
    const rels = new Set(closure.map((file) => file.rel));
    expect(rels).toContain("src/codex-pool-proof-window.ts");
    expect(rels).not.toContain("src/codex-pool-activation.ts");
    expect(rels).not.toContain("src/file-lock.ts");
    expect(
      closure.flatMap((file) => [
        ...file.valueSpecs
          .filter((specifier) => specifier.startsWith("bun:"))
          .map((specifier) => `${file.rel}: ${specifier}`),
        ...(file.code.match(/\bBun\s*\./) === null
          ? []
          : [`${file.rel}: Bun API`]),
      ]),
    ).toEqual([]);
    const index = closure.find(
      (file) => file.rel === "integrations/pi-codex-pool/src/index.ts",
    );
    expect(
      index?.valueSpecs.filter((specifier) =>
        specifier.startsWith("../../../src/"),
      ),
    ).toEqual([
      "../../../src/codex-pool-proof-window.ts",
      "../../../src/codex-quota-scope.ts",
    ]);
  });

  test("pins the compat-root delegate source and independent root/child routes", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/index.ts"),
      "utf8",
    );
    expect(source).toContain(
      'type CompatPiAi = typeof import("@earendil-works/pi-ai/compat")',
    );
    expect(source).toContain("openAICodexResponsesApi()");
    expect(source).not.toContain(
      "@earendil-works/pi-ai/api/openai-codex-responses",
    );

    const aliases = ["keeper-codex-a", "keeper-codex-b"];
    const routes = new PoolRouteState(
      aliases,
      null,
      () => 100,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      aliasPolicy(aliases),
    );
    const root = routes.select("root-session-id");
    const child = routes.select("child-session-id");
    expect(root).not.toBe(child);
    expect(routes.routeFor("root-session-id")).toBe(root);
    expect(routes.routeFor("child-session-id")).toBe(child);
  });
});

describe("credential and route state", () => {
  test("resolves aliases independently and serializes one refresh per alias", async () => {
    let refreshCalls = 0;
    const storage = new MemoryCredentialStorage(credentials(10));
    const vault = new CredentialVault(
      storage,
      async (credential) => {
        refreshCalls += 1;
        return {
          ...credential,
          access: `refreshed-${credential.access}`,
          refresh: `rotated-${credential.refresh}`,
          expires: 10_000,
        };
      },
      () => 100,
    );
    const sameAlias = await Promise.all(
      Array.from({ length: 8 }, () => vault.resolve("keeper-codex-a")),
    );
    expect(refreshCalls).toBe(1);
    expect(new Set(sameAlias.map((entry) => entry.access))).toEqual(
      new Set(["refreshed-fake-access-a"]),
    );
    const other = await vault.resolve("keeper-codex-b");
    expect(other.access).toBe("refreshed-fake-access-b");
    expect(refreshCalls).toBe(2);
  });

  test("lets an aborted caller leave a shared alias refresh without leaking its result", async () => {
    let releaseRefresh!: (
      value: ReturnType<typeof credentials>["keeper-codex-a"],
    ) => void;
    const refreshResult = new Promise<
      ReturnType<typeof credentials>["keeper-codex-a"]
    >((resolve) => {
      releaseRefresh = resolve;
    });
    const vault = new CredentialVault(
      new MemoryCredentialStorage(credentials(10)),
      async () => refreshResult,
      () => 100,
    );
    const owner = vault.resolve("keeper-codex-a");
    const controller = new AbortController();
    const joining = vault.resolve("keeper-codex-a", {
      signal: controller.signal,
    });
    controller.abort();
    await expect(joining).rejects.toThrow("credential-aborted");
    releaseRefresh({
      type: "oauth",
      access: "shared-refreshed-access",
      refresh: "shared-refreshed-refresh",
      expires: 10_000,
    });
    expect(await owner).toEqual({
      access: "shared-refreshed-access",
      expires: 10_000,
    });
  });

  test("writes refreshed credentials atomically with private permissions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-pool-auth-"));
    const authPath = join(dir, "auth.json");
    writePrivateJsonAtomic(authPath, credentials(10));
    const vault = new CredentialVault(
      new FileCredentialStorage(authPath),
      async (credential) => ({
        ...credential,
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: 50_000,
      }),
      () => 100,
    );
    await Promise.all([
      vault.resolve("keeper-codex-a"),
      vault.resolve("keeper-codex-a"),
    ]);
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(readFileSync(authPath, "utf8"))["keeper-codex-a"],
    ).toEqual({
      type: "oauth",
      access: "rotated-access",
      refresh: "rotated-refresh",
      expires: 50_000,
    });
    expect(readFileSync(authPath, "utf8")).not.toContain(".tmp");
    rmSync(dir, { recursive: true, force: true });
  });

  test("parses bounded per-scope alias policy with fail-closed default", () => {
    const aliases = ["keeper-codex-a", "keeper-codex-b"];
    expect(poolAliasPolicyFromEnvironment(undefined, aliases)).toBeNull();
    expect(poolAliasPolicyFromEnvironment("", aliases)).toBeNull();
    expect(
      poolAliasPolicyFromEnvironment(
        JSON.stringify({
          [CODEX_GENERIC_QUOTA_SCOPE]: ["keeper-codex-a"],
          [CODEX_SPARK_QUOTA_SCOPE]: ["keeper-codex-b"],
        }),
        aliases,
      ),
    ).toEqual({
      [CODEX_GENERIC_QUOTA_SCOPE]: ["keeper-codex-a"],
      [CODEX_SPARK_QUOTA_SCOPE]: ["keeper-codex-b"],
    });
    expect(
      poolAliasPolicyFromEnvironment(
        JSON.stringify({ [CODEX_SPARK_QUOTA_SCOPE]: ["keeper-codex-b"] }),
        aliases,
      ),
    ).toEqual({
      [CODEX_GENERIC_QUOTA_SCOPE]: [],
      [CODEX_SPARK_QUOTA_SCOPE]: ["keeper-codex-b"],
    });
    expect(
      poolAliasPolicyFromEnvironment(
        JSON.stringify({ [CODEX_GENERIC_QUOTA_SCOPE]: ["keeper-codex-z"] }),
        aliases,
      ),
    ).toBeNull();
    expect(
      poolAliasPolicyFromEnvironment(
        JSON.stringify({ unknown: ["keeper-codex-a"] }),
        aliases,
      ),
    ).toBeNull();
    expect(
      poolAliasPolicyFromEnvironment("x".repeat(3000), aliases),
    ).toBeNull();
  });

  test("binds alias policy by exact scopes and enrolled alias order", () => {
    const aliases = ["keeper-codex-a", "keeper-codex-b"];
    const genericOnly = aliasPolicy(aliases);
    const genericReordered = poolAliasPolicyFromEnvironment(
      JSON.stringify({
        [CODEX_GENERIC_QUOTA_SCOPE]: ["keeper-codex-b", "keeper-codex-a"],
        [CODEX_SPARK_QUOTA_SCOPE]: [],
      }),
      aliases,
    );
    if (genericReordered === null) throw new Error("policy fixture invalid");
    const sparkBroadened = aliasPolicy(aliases, [
      CODEX_GENERIC_QUOTA_SCOPE,
      CODEX_SPARK_QUOTA_SCOPE,
    ]);

    expect(poolAliasPolicyBinding(aliases, genericOnly)).toBe(
      poolAliasPolicyBinding(aliases, genericReordered),
    );
    expect(poolAliasPolicyBinding(aliases, genericOnly)).not.toBe(
      poolAliasPolicyBinding(aliases, sparkBroadened),
    );
    expect(
      poolAliasPolicyBinding(aliases, {
        [CODEX_GENERIC_QUOTA_SCOPE]: [],
        [CODEX_SPARK_QUOTA_SCOPE]: [],
      }),
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  test("consumes the sanitized launch route once before independent child selection", () => {
    const aliases = ["keeper-codex-a", "keeper-codex-b"];
    const routes = new PoolRouteState(
      aliases,
      null,
      () => 100,
      "keeper-codex-b",
      CODEX_GENERIC_QUOTA_SCOPE,
      aliasPolicy(aliases),
    );
    expect(routes.select("root")).toBe("keeper-codex-b");
    expect(routes.select("child")).toBe("keeper-codex-a");
    expect(routes.select("root")).toBe("keeper-codex-b");
  });

  test("selects deterministically, keeps sessions sticky, and reacts to pressure and cooldown", () => {
    let now = 100;
    const aliases = ["keeper-codex-a", "keeper-codex-b"];
    const routes = new PoolRouteState(
      aliases,
      null,
      () => now,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      aliasPolicy(aliases),
    );
    expect(routes.select("root")).toBe("keeper-codex-a");
    expect(routes.select("child")).toBe("keeper-codex-b");
    expect(routes.select("root")).toBe("keeper-codex-a");
    routes.recordFailure("root", "keeper-codex-a", "quota");
    expect(routes.select("root", new Set(["keeper-codex-a"]))).toBe(
      "keeper-codex-b",
    );
    now += 61_000;
    routes.recordSuccess("root", "keeper-codex-b");
    expect(
      routes.snapshot().accounts.every((entry) => entry.pressure <= 1),
    ).toBe(true);
  });

  test("keeps scoped usage eligibility and authorization separate", () => {
    const alias = "keeper-codex-a";
    const aliases = [alias];
    const bothPolicy = poolAliasPolicyFromEnvironment(
      JSON.stringify({
        [CODEX_GENERIC_QUOTA_SCOPE]: aliases,
        [CODEX_SPARK_QUOTA_SCOPE]: aliases,
      }),
      aliases,
    );
    if (bothPolicy === null) throw new Error("policy fixture invalid");

    const genericFull = new PoolRouteState(
      aliases,
      null,
      () => 100,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      bothPolicy,
    );
    applyScopedUsage(genericFull, alias, 100, 0);
    expect(() =>
      genericFull.select("generic", CODEX_GENERIC_QUOTA_SCOPE),
    ).toThrow("account-pool-exhausted");
    expect(genericFull.select("spark", CODEX_SPARK_QUOTA_SCOPE)).toBe(alias);

    const sparkFull = new PoolRouteState(
      aliases,
      null,
      () => 100,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      bothPolicy,
    );
    applyScopedUsage(sparkFull, alias, 80, 100);
    expect(sparkFull.select("generic", CODEX_GENERIC_QUOTA_SCOPE)).toBe(alias);
    expect(() => sparkFull.select("spark", CODEX_SPARK_QUOTA_SCOPE)).toThrow(
      "account-pool-exhausted",
    );

    const missingSpark = new PoolRouteState(
      aliases,
      null,
      () => 100,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      bothPolicy,
    );
    applyScopedUsage(missingSpark, alias, 20, null);
    expect(() => missingSpark.select("spark", CODEX_SPARK_QUOTA_SCOPE)).toThrow(
      "account-pool-exhausted",
    );

    const absentPolicy = new PoolRouteState(aliases, null, () => 100);
    applyScopedUsage(absentPolicy, alias, 20, 0);
    expect(() =>
      absentPolicy.select("generic", CODEX_GENERIC_QUOTA_SCOPE),
    ).toThrow("account-pool-exhausted");
    expect(() => absentPolicy.select("spark", CODEX_SPARK_QUOTA_SCOPE)).toThrow(
      "account-pool-exhausted",
    );
  });

  test("keeps scoped stickiness and quota cooldowns isolated", () => {
    const aliases = ["keeper-codex-a", "keeper-codex-b"];
    const policy = poolAliasPolicyFromEnvironment(
      JSON.stringify({
        [CODEX_GENERIC_QUOTA_SCOPE]: aliases,
        [CODEX_SPARK_QUOTA_SCOPE]: aliases,
      }),
      aliases,
    );
    if (policy === null) throw new Error("policy fixture invalid");
    const routes = new PoolRouteState(
      aliases,
      null,
      () => 100,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      policy,
    );
    for (const alias of aliases) applyScopedUsage(routes, alias, 10, 10);

    expect(routes.select("same-session", CODEX_GENERIC_QUOTA_SCOPE)).toBe(
      "keeper-codex-a",
    );
    expect(routes.select("same-session", CODEX_SPARK_QUOTA_SCOPE)).toBe(
      "keeper-codex-b",
    );
    routes.recordFailure(
      "same-session",
      "keeper-codex-a",
      "quota",
      CODEX_GENERIC_QUOTA_SCOPE,
    );
    expect(
      routes.routeFor("same-session", CODEX_GENERIC_QUOTA_SCOPE),
    ).toBeUndefined();
    expect(routes.routeFor("same-session", CODEX_SPARK_QUOTA_SCOPE)).toBe(
      "keeper-codex-b",
    );
    const first = routes
      .snapshot()
      .accounts.find((account) => account.alias === "keeper-codex-a");
    expect(
      first?.quota_scopes.find(
        (scope) => scope.quota_scope === CODEX_GENERIC_QUOTA_SCOPE,
      )?.cooldown_until_ms,
    ).toBeGreaterThan(100);
    expect(
      first?.quota_scopes.find(
        (scope) => scope.quota_scope === CODEX_SPARK_QUOTA_SCOPE,
      )?.cooldown_until_ms,
    ).toBe(0);

    routes.recordFailure(
      "same-session",
      "keeper-codex-b",
      "quota",
      CODEX_SPARK_QUOTA_SCOPE,
    );
    routes.recordSuccess(
      "generic-success",
      "keeper-codex-b",
      CODEX_GENERIC_QUOTA_SCOPE,
    );
    const second = routes
      .snapshot()
      .accounts.find((account) => account.alias === "keeper-codex-b");
    expect(
      second?.quota_scopes.find(
        (scope) => scope.quota_scope === CODEX_GENERIC_QUOTA_SCOPE,
      )?.cooldown_until_ms,
    ).toBe(0);
    expect(
      second?.quota_scopes.find(
        (scope) => scope.quota_scope === CODEX_SPARK_QUOTA_SCOPE,
      )?.cooldown_until_ms,
    ).toBeGreaterThan(100);
  });

  test("applies shared cooldowns to both scopes and never falls back to cooling aliases", () => {
    const alias = "keeper-codex-a";
    const aliases = [alias];
    const policy = poolAliasPolicyFromEnvironment(
      JSON.stringify({
        [CODEX_GENERIC_QUOTA_SCOPE]: aliases,
        [CODEX_SPARK_QUOTA_SCOPE]: aliases,
      }),
      aliases,
    );
    if (policy === null) throw new Error("policy fixture invalid");
    for (const failureClass of ["auth", "transport"] as const) {
      const routes = new PoolRouteState(
        aliases,
        null,
        () => 100,
        undefined,
        CODEX_GENERIC_QUOTA_SCOPE,
        policy,
      );
      applyScopedUsage(routes, alias, 10, 10);
      routes.recordFailure(
        "session",
        alias,
        failureClass,
        CODEX_GENERIC_QUOTA_SCOPE,
      );
      expect(() => routes.select("generic", CODEX_GENERIC_QUOTA_SCOPE)).toThrow(
        "account-pool-exhausted",
      );
      expect(() => routes.select("spark", CODEX_SPARK_QUOTA_SCOPE)).toThrow(
        "account-pool-exhausted",
      );
    }

    const quotaOnly = routeState(aliases);
    quotaOnly.recordFailure(
      "session",
      alias,
      "quota",
      CODEX_GENERIC_QUOTA_SCOPE,
    );
    expect(() =>
      quotaOnly.select("generic", CODEX_GENERIC_QUOTA_SCOPE),
    ).toThrow("account-pool-exhausted");
  });

  test("persists only bounded alias routing facts", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-pool-state-"));
    const path = join(dir, "state.json");
    const aliases = ["keeper-codex-a", "keeper-codex-b"];
    const routes = new PoolRouteState(
      aliases,
      new PoolStateStore(path),
      () => 100,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      aliasPolicy(aliases),
    );
    routes.select("private-session-id");
    const persisted = readFileSync(path, "utf8");
    expect(persisted).not.toContain("private-session-id");
    expect(persisted).not.toContain("fake-access");
    expect(JSON.parse(persisted)).toEqual(
      expect.objectContaining({
        schema_version: 2,
        accounts: expect.any(Array),
      }),
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });

  test("bounds persisted schema-v2 cooldowns and pressure before scoped routing", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-pool-state-bounds-"));
    const path = join(dir, "state.json");
    const now = 100;
    const aliases = [
      "keeper-codex-a",
      "keeper-codex-b",
      "keeper-codex-c",
      "keeper-codex-d",
      "keeper-codex-e",
      "keeper-codex-f",
    ];
    const policy = bothScopesPolicy(aliases);
    const binding = new PoolRouteState(
      aliases,
      null,
      () => now,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      policy,
    ).binding;
    const scope = (quotaScope: string, cooldownUntilMs: number) => ({
      quota_scope: quotaScope,
      used_percent: 10,
      usage_expires_at_ms: now + 300_000,
      cooldown_until_ms: cooldownUntilMs,
      observed_at_ms: now,
      exhausted: false,
    });
    const account = (
      alias: string,
      cooldownUntilMs: number,
      pressureExpiresAtMs: number,
      genericCooldownUntilMs: number,
      sparkCooldownUntilMs: number,
    ) => ({
      alias,
      quota_scopes: [
        scope(CODEX_GENERIC_QUOTA_SCOPE, genericCooldownUntilMs),
        scope(CODEX_SPARK_QUOTA_SCOPE, sparkCooldownUntilMs),
      ],
      pressure: 100,
      pressure_expires_at_ms: pressureExpiresAtMs,
      cooldown_until_ms: cooldownUntilMs,
      last_selected_at_ms: 0,
    });
    writePrivateJsonAtomic(path, {
      schema_version: POOL_STATE_SCHEMA_VERSION,
      config_binding: binding,
      accounts: [
        account(
          "keeper-codex-a",
          Number.MAX_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER,
          0,
          0,
        ),
        account("keeper-codex-b", 0, 0, Number.MAX_SAFE_INTEGER, 0),
        account("keeper-codex-c", 0, 0, 0, Number.MAX_SAFE_INTEGER),
        account("keeper-codex-d", now + 60_000, 0, 0, 0),
        account("keeper-codex-e", 0, 0, now + 60_000, 0),
        account("keeper-codex-f", 0, 0, 0, now + 45 * 24 * 60 * 60 * 1000),
      ],
    });

    const routes = new PoolRouteState(
      aliases,
      new PoolStateStore(path),
      () => now,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      policy,
    );
    expect(routes.select("generic", CODEX_GENERIC_QUOTA_SCOPE)).toBe(
      "keeper-codex-a",
    );
    expect(routes.select("spark", CODEX_SPARK_QUOTA_SCOPE)).toBe(
      "keeper-codex-b",
    );
    expect(() =>
      routes.select(
        "valid-shared",
        CODEX_GENERIC_QUOTA_SCOPE,
        new Set([
          "keeper-codex-a",
          "keeper-codex-b",
          "keeper-codex-c",
          "keeper-codex-e",
          "keeper-codex-f",
        ]),
      ),
    ).toThrow("account-pool-exhausted");
    expect(() =>
      routes.select(
        "valid-generic",
        CODEX_GENERIC_QUOTA_SCOPE,
        new Set([
          "keeper-codex-a",
          "keeper-codex-b",
          "keeper-codex-c",
          "keeper-codex-d",
          "keeper-codex-f",
        ]),
      ),
    ).toThrow("account-pool-exhausted");
    expect(() =>
      routes.select(
        "valid-spark",
        CODEX_SPARK_QUOTA_SCOPE,
        new Set([
          "keeper-codex-a",
          "keeper-codex-b",
          "keeper-codex-c",
          "keeper-codex-d",
          "keeper-codex-e",
        ]),
      ),
    ).toThrow("account-pool-exhausted");

    const byAlias = new Map(
      routes.snapshot().accounts.map((entry) => [entry.alias, entry]),
    );
    expect(byAlias.get("keeper-codex-a")?.cooldown_until_ms).toBe(0);
    expect(byAlias.get("keeper-codex-a")?.pressure_expires_at_ms).toBe(
      now + 30_000,
    );
    expect(
      byAlias
        .get("keeper-codex-b")
        ?.quota_scopes.find(
          (entry) => entry.quota_scope === CODEX_GENERIC_QUOTA_SCOPE,
        )?.cooldown_until_ms,
    ).toBe(0);
    expect(
      byAlias
        .get("keeper-codex-c")
        ?.quota_scopes.find(
          (entry) => entry.quota_scope === CODEX_SPARK_QUOTA_SCOPE,
        )?.cooldown_until_ms,
    ).toBe(0);
    expect(byAlias.get("keeper-codex-d")?.cooldown_until_ms).toBe(now + 60_000);
    expect(
      byAlias
        .get("keeper-codex-e")
        ?.quota_scopes.find(
          (entry) => entry.quota_scope === CODEX_GENERIC_QUOTA_SCOPE,
        )?.cooldown_until_ms,
    ).toBe(now + 60_000);
    expect(
      byAlias
        .get("keeper-codex-f")
        ?.quota_scopes.find(
          (entry) => entry.quota_scope === CODEX_SPARK_QUOTA_SCOPE,
        )?.cooldown_until_ms,
    ).toBe(now + 45 * 24 * 60 * 60 * 1000);
    rmSync(dir, { recursive: true, force: true });
  });

  test("bounds persisted schema-v2 usage and future timestamps before Spark routing", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-pool-state-usage-bounds-"));
    const path = join(dir, "state.json");
    const ordinaryPath = join(dir, "ordinary-state.json");
    const now = 100;
    const alias = "keeper-codex-a";
    const aliases = [alias];
    const policy = bothScopesPolicy(aliases);
    const binding = new PoolRouteState(
      aliases,
      null,
      () => now,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      policy,
    ).binding;
    const scope = (
      quotaScope: string,
      usageExpiresAtMs: number,
      observedAtMs: number,
    ) => ({
      quota_scope: quotaScope,
      used_percent: quotaScope === CODEX_SPARK_QUOTA_SCOPE ? 0 : 10,
      usage_expires_at_ms: usageExpiresAtMs,
      cooldown_until_ms: 0,
      observed_at_ms: observedAtMs,
      exhausted: false,
    });
    const account = (
      usageExpiresAtMs: number,
      observedAtMs: number,
      lastSelectedAtMs: number,
    ) => ({
      alias,
      quota_scopes: [
        scope(CODEX_GENERIC_QUOTA_SCOPE, 0, observedAtMs),
        scope(CODEX_SPARK_QUOTA_SCOPE, usageExpiresAtMs, observedAtMs),
      ],
      pressure: 0,
      pressure_expires_at_ms: 0,
      cooldown_until_ms: 0,
      last_selected_at_ms: lastSelectedAtMs,
    });
    writePrivateJsonAtomic(path, {
      schema_version: POOL_STATE_SCHEMA_VERSION,
      config_binding: binding,
      accounts: [
        account(
          now + 300_001,
          Number.MAX_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER,
        ),
      ],
    });

    const routes = new PoolRouteState(
      aliases,
      new PoolStateStore(path),
      () => now,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      policy,
    );
    expect(() =>
      routes.select("malicious-spark", CODEX_SPARK_QUOTA_SCOPE),
    ).toThrow("account-pool-exhausted");
    const maliciousAccount = accountSnapshot(routes);
    expect(maliciousAccount.last_selected_at_ms).toBe(0);
    expect(
      maliciousAccount.quota_scopes.find(
        (entry) => entry.quota_scope === CODEX_SPARK_QUOTA_SCOPE,
      ),
    ).toEqual(
      expect.objectContaining({
        usage_expires_at_ms: 0,
        observed_at_ms: 0,
        exhausted: false,
      }),
    );

    applyScopedUsage(routes, alias, 20, 0, now);
    expect(routes.select("fresh-spark", CODEX_SPARK_QUOTA_SCOPE)).toBe(alias);
    expect(
      accountSnapshot(routes).quota_scopes.find(
        (entry) => entry.quota_scope === CODEX_SPARK_QUOTA_SCOPE,
      ),
    ).toEqual(
      expect.objectContaining({
        usage_expires_at_ms: now + 60_000,
        observed_at_ms: now,
        exhausted: false,
      }),
    );

    writePrivateJsonAtomic(ordinaryPath, {
      schema_version: POOL_STATE_SCHEMA_VERSION,
      config_binding: binding,
      accounts: [account(now + 60_000, now, now - 1)],
    });
    const ordinaryRoutes = new PoolRouteState(
      aliases,
      new PoolStateStore(ordinaryPath),
      () => now,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      policy,
    );
    const ordinaryAccount = accountSnapshot(ordinaryRoutes);
    expect(ordinaryAccount.last_selected_at_ms).toBe(now - 1);
    expect(
      ordinaryAccount.quota_scopes.find(
        (entry) => entry.quota_scope === CODEX_SPARK_QUOTA_SCOPE,
      ),
    ).toEqual(
      expect.objectContaining({
        usage_expires_at_ms: now + 60_000,
        observed_at_ms: now,
      }),
    );
    expect(
      ordinaryRoutes.select("ordinary-spark", CODEX_SPARK_QUOTA_SCOPE),
    ).toBe(alias);
    rmSync(dir, { recursive: true, force: true });
  });

  test("uses an owner lockfile for acquire, matching-live timeout, and dead-owner recovery", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-pool-owner-lock-"));
    const lockPath = join(dir, "state.json.lock");
    let now = 100;
    const sleeps: number[] = [];
    const first = acquireOwnerFileLock(lockPath, {
      deps: {
        pid: () => 111,
        nonce: () => "a".repeat(32),
        pidLiveness: () => "alive",
        processStartIdentity: (pid) => processStartId(pid),
      },
    });
    expect(readFileSync(lockPath, "utf8")).toBe(lockOwner(111, "a".repeat(32)));
    expect(readFileSync(lockPath, "utf8")).not.toContain(lockPath);
    expect(() =>
      acquireOwnerFileLock(lockPath, {
        timeoutMs: 10,
        retryMs: 5,
        maxRetries: 2,
        deps: {
          now: () => now,
          sleep: (ms) => {
            sleeps.push(ms);
            now += ms;
          },
          pid: () => 222,
          nonce: () => "b".repeat(32),
          pidLiveness: (pid) => (pid === 111 ? "alive" : "unknown"),
          processStartIdentity: (pid) => processStartId(pid),
        },
      }),
    ).toThrow("owner-file-lock-timeout");
    expect(sleeps).toEqual([5, 5]);
    expect(readFileSync(lockPath, "utf8")).toBe(lockOwner(111, "a".repeat(32)));
    first.release();
    first.release();
    expect(existsSync(lockPath)).toBe(false);

    writeFileSync(lockPath, lockOwner(333, "c".repeat(32)), { mode: 0o600 });
    const recovered = acquireOwnerFileLock(lockPath, {
      deps: {
        pid: () => 444,
        nonce: () => "d".repeat(32),
        pidLiveness: (pid) => (pid === 333 ? "dead" : "alive"),
        processStartIdentity: (pid) => processStartId(pid),
      },
    });
    expect(readFileSync(lockPath, "utf8")).toBe(lockOwner(444, "d".repeat(32)));
    recovered.release();
    expect(existsSync(lockPath)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("fails closed on malformed owner lockfiles", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-pool-owner-lock-bad-"));
    const lockPath = join(dir, "state.json.lock");
    writeFileSync(lockPath, "not-json", { mode: 0o600 });
    expect(() =>
      acquireOwnerFileLock(lockPath, {
        timeoutMs: 0,
        deps: {
          pid: () => 555,
          nonce: () => "e".repeat(32),
          pidLiveness: () => "dead",
          processStartIdentity: (pid) => processStartId(pid),
        },
      }),
    ).toThrow("owner-file-lock-ambiguous-owner");
    expect(readFileSync(lockPath, "utf8")).toBe("not-json");
    rmSync(dir, { recursive: true, force: true });
  });

  test("recovers owner lockfiles from live PID reuse", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-pool-owner-lock-reuse-"));
    const lockPath = join(dir, "state.json.lock");
    writeFileSync(lockPath, lockOwner(666, "f".repeat(32), "old-start"), {
      mode: 0o600,
    });
    const recovered = acquireOwnerFileLock(lockPath, {
      deps: {
        pid: () => 777,
        nonce: () => "a".repeat(32),
        pidLiveness: (pid) => (pid === 666 ? "alive" : "unknown"),
        processStartIdentity: (pid) =>
          pid === 666 ? "new-start" : processStartId(pid),
      },
    });
    expect(readFileSync(lockPath, "utf8")).toBe(lockOwner(777, "a".repeat(32)));
    recovered.release();
    expect(existsSync(lockPath)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("stale owner reclamation leaves replacement owners untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-pool-owner-lock-race-"));
    const lockPath = join(dir, "state.json.lock");
    writeFileSync(lockPath, lockOwner(1200, "0".repeat(32)), {
      mode: 0o600,
    });
    let replaced = false;
    expect(() =>
      acquireOwnerFileLock(lockPath, {
        timeoutMs: 0,
        maxRetries: 1,
        deps: {
          pid: () => 1202,
          nonce: () => "2".repeat(32),
          pidLiveness: (pid) => (pid === 1200 ? "dead" : "alive"),
          processStartIdentity: (pid) => processStartId(pid),
        },
        hooks: {
          beforeStaleOwnerUnlink() {
            if (replaced) return;
            replaced = true;
            rmSync(lockPath, { force: true });
            writeFileSync(lockPath, lockOwner(1201, "1".repeat(32)), {
              flag: "wx",
              mode: 0o600,
            });
          },
        },
      }),
    ).toThrow("owner-file-lock-timeout");
    expect(replaced).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe(
      lockOwner(1201, "1".repeat(32)),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("recovers dead reclaim gates before acquiring owner locks", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-pool-owner-lock-gate-"));
    const lockPath = join(dir, "state.json.lock");
    const gatePath = `${lockPath}.reclaim`;
    writeFileSync(gatePath, lockOwner(1300, "3".repeat(32)), {
      mode: 0o600,
    });
    const held = acquireOwnerFileLock(lockPath, {
      deps: {
        pid: () => 1301,
        nonce: () => "4".repeat(32),
        pidLiveness: (pid) => (pid === 1300 ? "dead" : "alive"),
        processStartIdentity: (pid) => processStartId(pid),
      },
    });
    expect(readFileSync(lockPath, "utf8")).toBe(
      lockOwner(1301, "4".repeat(32)),
    );
    expect(existsSync(gatePath)).toBe(false);
    held.release();
    expect(existsSync(lockPath)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("fails closed when owner process identities are unknown", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-pool-owner-lock-unknown-"));
    const ownLockPath = join(dir, "own.lock");
    expect(() =>
      acquireOwnerFileLock(ownLockPath, {
        deps: {
          pid: () => 888,
          nonce: () => "b".repeat(32),
          pidLiveness: () => "alive",
          processStartIdentity: () => null,
        },
      }),
    ).toThrow("owner-file-lock-owner-identity-unavailable");
    expect(existsSync(ownLockPath)).toBe(false);

    const contendedLockPath = join(dir, "contended.lock");
    writeFileSync(contendedLockPath, lockOwner(999, "c".repeat(32)), {
      mode: 0o600,
    });
    expect(() =>
      acquireOwnerFileLock(contendedLockPath, {
        deps: {
          pid: () => 1000,
          nonce: () => "d".repeat(32),
          pidLiveness: (pid) => (pid === 999 ? "alive" : "unknown"),
          processStartIdentity: (pid) =>
            pid === 999 ? null : processStartId(pid),
        },
      }),
    ).toThrow("owner-file-lock-ambiguous-owner");
    expect(readFileSync(contendedLockPath, "utf8")).toBe(
      lockOwner(999, "c".repeat(32)),
    );

    const unknownLivenessLockPath = join(dir, "unknown-liveness.lock");
    writeFileSync(unknownLivenessLockPath, lockOwner(1001, "0".repeat(32)), {
      mode: 0o600,
    });
    expect(() =>
      acquireOwnerFileLock(unknownLivenessLockPath, {
        deps: {
          pid: () => 1002,
          nonce: () => "1".repeat(32),
          pidLiveness: (pid) => (pid === 1001 ? "unknown" : "alive"),
          processStartIdentity: (pid) => processStartId(pid),
        },
      }),
    ).toThrow("owner-file-lock-ambiguous-owner");
    expect(readFileSync(unknownLivenessLockPath, "utf8")).toBe(
      lockOwner(1001, "0".repeat(32)),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("owner lock release is nonce-checked", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-pool-owner-lock-release-"));
    const lockPath = join(dir, "state.json.lock");
    const held = acquireOwnerFileLock(lockPath, {
      deps: {
        pid: () => 1111,
        nonce: () => "e".repeat(32),
        pidLiveness: () => "alive",
        processStartIdentity: (pid) => processStartId(pid),
      },
    });
    writeFileSync(lockPath, lockOwner(1111, "f".repeat(32)), { mode: 0o600 });
    held.release();
    expect(readFileSync(lockPath, "utf8")).toBe(
      lockOwner(1111, "f".repeat(32)),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("releaseSelection drops charged pressure exactly once", () => {
    const routes = routeState(["keeper-codex-a"]);
    const first = routes.select("release-session");
    const second = routes.select("release-session");
    expect(first).toBe("keeper-codex-a");
    expect(second).toBe("keeper-codex-a");
    expect(accountSnapshot(routes).pressure).toBe(2);
    routes.releaseSelection("release-session", "keeper-codex-a");
    expect(accountSnapshot(routes).pressure).toBe(1);
    routes.releaseSelection("release-session", "keeper-codex-a");
    routes.releaseSelection("release-session", "keeper-codex-a");
    const account = accountSnapshot(routes);
    expect(account.pressure).toBe(0);
    expect(account.pressure_expires_at_ms).toBe(0);
    expect(account.cooldown_until_ms).toBe(0);
  });

  test("reloads observer usage from another instance before routing", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-pool-state-live-"));
    const path = join(dir, "state.json");
    const aliases = ["keeper-codex-a", "keeper-codex-b"];
    const policy = aliasPolicy(aliases);
    const active = new PoolRouteState(
      aliases,
      new PoolStateStore(path),
      () => 100,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      policy,
    );
    const observer = new PoolRouteState(
      aliases,
      new PoolStateStore(path),
      () => 100,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      policy,
    );
    applyScopedUsage(observer, "keeper-codex-a", 90, null, 100);
    applyScopedUsage(observer, "keeper-codex-b", 10, null, 100);
    expect(active.select("fresh-session")).toBe("keeper-codex-b");
    rmSync(dir, { recursive: true, force: true });
  });

  test("stale route writes do not clobber newer persisted usage", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-pool-state-clobber-"));
    const path = join(dir, "state.json");
    const aliases = ["keeper-codex-a", "keeper-codex-b"];
    const policy = aliasPolicy(aliases);
    const stale = new PoolRouteState(
      aliases,
      new PoolStateStore(path),
      () => 200,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      policy,
    );
    const observer = new PoolRouteState(
      aliases,
      new PoolStateStore(path),
      () => 200,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      policy,
    );
    applyScopedUsage(observer, "keeper-codex-a", 100, null, 200);
    stale.recordSuccess("old-session", "keeper-codex-a");
    const scope = stale
      .snapshot()
      .accounts.find((account) => account.alias === "keeper-codex-a")
      ?.quota_scopes.find(
        (entry) => entry.quota_scope === CODEX_GENERIC_QUOTA_SCOPE,
      );
    expect(scope).toEqual(
      expect.objectContaining({
        observed_at_ms: 200,
        used_percent: 100,
        exhausted: true,
      }),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("orders stale and equal usage observations deterministically", () => {
    const aliases = ["keeper-codex-a"];
    const routes = routeState(aliases, () => 300);
    applyScopedUsage(routes, "keeper-codex-a", 100, null, 200);
    applyScopedUsage(routes, "keeper-codex-a", 10, null, 100);
    let scope = routes
      .snapshot()
      .accounts[0]?.quota_scopes.find(
        (entry) => entry.quota_scope === CODEX_GENERIC_QUOTA_SCOPE,
      );
    expect(scope).toEqual(
      expect.objectContaining({
        observed_at_ms: 200,
        used_percent: 100,
        exhausted: true,
      }),
    );

    const equal = routeState(aliases, () => 300);
    applyScopedUsage(equal, "keeper-codex-a", 40, null, 300);
    equal.applyUsage(
      parseUsageResponse(
        "keeper-codex-a",
        {
          rate_limit: {
            allowed: false,
            limit_reached: true,
            primary_window: { used_percent: 20, reset_at: 400 },
          },
        },
        300,
      ),
    );
    scope = equal
      .snapshot()
      .accounts[0]?.quota_scopes.find(
        (entry) => entry.quota_scope === CODEX_GENERIC_QUOTA_SCOPE,
      );
    expect(scope).toEqual(
      expect.objectContaining({
        observed_at_ms: 300,
        used_percent: 40,
        exhausted: true,
      }),
    );
  });

  test("newer healthy usage clears an older scoped exhaustion cooldown", () => {
    const aliases = ["keeper-codex-a"];
    let now = 100;
    const routes = routeState(aliases, () => now);

    applyScopedUsage(routes, "keeper-codex-a", 100, null, now);
    let scope = accountSnapshot(routes).quota_scopes.find(
      (entry) => entry.quota_scope === CODEX_GENERIC_QUOTA_SCOPE,
    );
    expect(scope).toEqual(
      expect.objectContaining({
        observed_at_ms: 100,
        used_percent: 100,
        exhausted: true,
      }),
    );
    expect(scope?.cooldown_until_ms).toBeGreaterThan(now);

    now = 200;
    applyScopedUsage(routes, "keeper-codex-a", 0, null, now);
    scope = accountSnapshot(routes).quota_scopes.find(
      (entry) => entry.quota_scope === CODEX_GENERIC_QUOTA_SCOPE,
    );
    expect(scope).toEqual(
      expect.objectContaining({
        observed_at_ms: 200,
        used_percent: 0,
        cooldown_until_ms: 0,
        exhausted: false,
      }),
    );
    expect(routes.select("recovered-session")).toBe("keeper-codex-a");
  });

  test("success does not clear a newer scoped or shared cooldown", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-pool-state-success-"));
    const path = join(dir, "state.json");
    const aliases = ["keeper-codex-a"];
    const policy = aliasPolicy(aliases);
    let now = 100;
    const stale = new PoolRouteState(
      aliases,
      new PoolStateStore(path),
      () => now,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      policy,
    );
    const failing = new PoolRouteState(
      aliases,
      new PoolStateStore(path),
      () => now,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      policy,
    );
    now = 200;
    failing.recordFailure("quota-session", "keeper-codex-a", "quota");
    failing.recordFailure("rate-session", "keeper-codex-a", "rate");
    stale.recordSuccess("quota-session", "keeper-codex-a");
    const account = stale.snapshot().accounts[0];
    expect(account?.cooldown_until_ms).toBeGreaterThan(200);
    expect(
      account?.quota_scopes.find(
        (entry) => entry.quota_scope === CODEX_GENERIC_QUOTA_SCOPE,
      )?.cooldown_until_ms,
    ).toBeGreaterThan(200);
    rmSync(dir, { recursive: true, force: true });
  });

  test("failed unavailable observation latches Spark closed and persists on recovery sync", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-pool-state-pending-usage-"));
    const path = join(dir, "state.json");
    const aliases = ["keeper-codex-a", "keeper-codex-b"];
    const policy = bothScopesPolicy(aliases);
    const store = new InjectedFailurePoolStateStore(path);
    const routes = new PoolRouteState(
      aliases,
      store,
      () => 100,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      policy,
    );
    applyScopedUsage(routes, "keeper-codex-a", 10, 10, 100);
    applyScopedUsage(routes, "keeper-codex-b", 20, 20, 100);

    store.failNextStage = "save";
    routes.applyUsage(unavailableUsage("keeper-codex-a", 100, "network"));

    expect(routes.select("spark-recovery", CODEX_SPARK_QUOTA_SCOPE)).toBe(
      "keeper-codex-b",
    );
    const recovered = new PoolRouteState(
      aliases,
      new PoolStateStore(path),
      () => 100,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      policy,
    );
    expect(
      accountSnapshot(recovered).quota_scopes.find(
        (entry) => entry.quota_scope === CODEX_SPARK_QUOTA_SCOPE,
      ),
    ).toEqual(
      expect.objectContaining({
        used_percent: 100,
        usage_expires_at_ms: 0,
        observed_at_ms: 100,
        exhausted: false,
      }),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("failed quota and shared cooldowns latch locally and persist on recovery sync", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-pool-state-pending-fail-"));
    const path = join(dir, "state.json");
    const aliases = ["keeper-codex-a", "keeper-codex-b"];
    const policy = bothScopesPolicy(aliases);
    const store = new InjectedFailurePoolStateStore(path);
    const routes = new PoolRouteState(
      aliases,
      store,
      () => 100,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      policy,
    );
    applyScopedUsage(routes, "keeper-codex-a", 10, 10, 100);
    applyScopedUsage(routes, "keeper-codex-b", 20, 20, 100);

    store.failNextStage = "save";
    routes.recordFailure(
      "quota-failure",
      "keeper-codex-a",
      "quota",
      CODEX_SPARK_QUOTA_SCOPE,
    );
    routes.recordSuccess(
      "sync-quota",
      "keeper-codex-a",
      CODEX_SPARK_QUOTA_SCOPE,
    );
    expect(routes.select("spark-after-quota", CODEX_SPARK_QUOTA_SCOPE)).toBe(
      "keeper-codex-b",
    );

    store.failNextStage = "save";
    routes.recordFailure("rate-failure", "keeper-codex-b", "rate");
    expect(routes.select("generic-after-rate")).toBe("keeper-codex-a");

    const recovered = new PoolRouteState(
      aliases,
      new PoolStateStore(path),
      () => 100,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      policy,
    );
    expect(
      accountSnapshot(recovered).quota_scopes.find(
        (entry) => entry.quota_scope === CODEX_SPARK_QUOTA_SCOPE,
      )?.cooldown_until_ms,
    ).toBeGreaterThan(100);
    expect(
      accountSnapshot(recovered, "keeper-codex-b").cooldown_until_ms,
    ).toBeGreaterThan(100);
    rmSync(dir, { recursive: true, force: true });
  });

  test("failed release consumes local in-flight once and persists one recovery decrement", () => {
    const dir = mkdtempSync(
      join(tmpdir(), "codex-pool-state-pending-release-"),
    );
    const path = join(dir, "state.json");
    const aliases = ["keeper-codex-a"];
    const policy = aliasPolicy(aliases);
    const store = new InjectedFailurePoolStateStore(path);
    const routes = new PoolRouteState(
      aliases,
      store,
      () => 100,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      policy,
    );

    expect(routes.select("release-failure")).toBe("keeper-codex-a");
    expect(accountSnapshot(routes).pressure).toBe(1);
    store.failNextStage = "save";
    routes.releaseSelection("release-failure", "keeper-codex-a");
    const beforeRecovery = new PoolRouteState(
      aliases,
      new PoolStateStore(path),
      () => 100,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      policy,
    );
    expect(accountSnapshot(beforeRecovery).pressure).toBe(1);

    routes.releaseSelection("release-failure", "keeper-codex-a");
    const recovered = new PoolRouteState(
      aliases,
      new PoolStateStore(path),
      () => 100,
      undefined,
      CODEX_GENERIC_QUOTA_SCOPE,
      policy,
    );
    expect(accountSnapshot(recovered).pressure).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("pool failure log", () => {
  test("writes one private record per terminal failure carrying the real message", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-pool-failure-log-"));
    const path = join(dir, "failures.ndjson");
    const log = new PoolFailureLog(path, () => 12_345);
    log.record({
      sessionId: "session-a",
      alias: "keeper-codex-a",
      attempt: 1,
      failureClass: "other",
      message: "Bearer sk-private opaque provider failure",
    });
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines.length).toBe(1);
    const record = JSON.parse(lines[0]);
    expect(record).toEqual({
      schema_version: 1,
      ts_ms: 12_345,
      session_id: "session-a",
      attempt: 1,
      alias: "keeper-codex-a",
      failure_class: "other",
      message: "Bearer sk-private opaque provider failure",
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });

  test("bounds the private failure log to a fixed record count", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-pool-failure-log-bounds-"));
    const path = join(dir, "failures.ndjson");
    const log = new PoolFailureLog(path, () => 1);
    const total = MAX_POOL_FAILURE_LOG_RECORDS + 25;
    for (let index = 0; index < total; index += 1) {
      log.record({
        sessionId: `session-${index}`,
        alias: "keeper-codex-a",
        attempt: 1,
        failureClass: "transport",
        message: `failure number ${index}`,
      });
    }
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines.length).toBe(MAX_POOL_FAILURE_LOG_RECORDS);
    const first = JSON.parse(lines[0]);
    const last = JSON.parse(lines.at(-1) as string);
    expect(first.session_id).toBe(
      `session-${total - MAX_POOL_FAILURE_LOG_RECORDS}`,
    );
    expect(last.session_id).toBe(`session-${total - 1}`);
    rmSync(dir, { recursive: true, force: true });
  });

  test("caps an individual record's message text length", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-pool-failure-log-message-"));
    const path = join(dir, "failures.ndjson");
    const log = new PoolFailureLog(path, () => 1);
    log.record({
      sessionId: "session-oversized",
      alias: "keeper-codex-a",
      attempt: 1,
      failureClass: "other",
      message: "x".repeat(MAX_POOL_FAILURE_MESSAGE_BYTES * 2),
    });
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    const record = JSON.parse(lines[0]);
    expect(Buffer.byteLength(record.message, "utf8")).toBe(
      MAX_POOL_FAILURE_MESSAGE_BYTES,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("never throws into the caller when the log path is unwritable", () => {
    const dir = mkdtempSync(
      join(tmpdir(), "codex-pool-failure-log-unwritable-"),
    );
    const path = join(dir, "nested", "unreachable", "failures.ndjson");
    writeFileSync(join(dir, "nested"), "not-a-directory");
    const log = new PoolFailureLog(path, () => 1);
    expect(() =>
      log.record({
        sessionId: "session-a",
        alias: "keeper-codex-a",
        attempt: 1,
        failureClass: "other",
        message: "unreachable",
      }),
    ).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("pooled Codex stream", () => {
  test("retries one different alias before output and preserves the request contract and ordering", async () => {
    const calls: Array<{ model: unknown; context: unknown; options: any }> = [];
    const clock = Date.now();
    const routes = routeState(
      ["keeper-codex-a", "keeper-codex-b"],
      () => clock,
    );
    const vault = new CredentialVault(
      new MemoryCredentialStorage(credentials(clock + 100_000)),
      async (credential) => credential,
      () => clock,
    );
    const firstStart = { type: "start", partial: message() };
    const secondStart = { type: "start", partial: message() };
    const text = {
      type: "text_delta",
      contentIndex: 0,
      delta: "ok",
      partial: { ...message(), content: [{ type: "text", text: "ok" }] },
    };
    const done = { type: "done", reason: "stop", message: message() };
    const payloadCallback = () => undefined;
    const responseCallback = () => undefined;
    const headers = { "x-test": "yes" };
    const metadata = { purpose: "test" };
    const env = { REGION: "test" };
    const options = {
      sessionId: "root-session",
      temperature: 0.2,
      maxTokens: 77,
      transport: "websocket-cached" as const,
      cacheRetention: "long" as const,
      onPayload: payloadCallback,
      onResponse: responseCallback,
      headers,
      timeoutMs: 1234,
      websocketConnectTimeoutMs: 222,
      maxRetries: 9,
      maxRetryDelayMs: 333,
      metadata,
      env,
      reasoning: "high" as const,
      thinkingBudgets: { high: 42 },
    };
    const pooled = createPooledCodexStream(
      {
        vault,
        routes,
        now: () => clock,
        warn: () => {
          throw new Error("unexpected-fallback");
        },
        nativeDelegate: () => stream([]) as any,
        delegate(modelArg, contextArg, attemptOptions) {
          calls.push({
            model: modelArg,
            context: contextArg,
            options: attemptOptions,
          });
          return (
            calls.length === 1
              ? stream([
                  firstStart,
                  {
                    type: "error",
                    reason: "error",
                    error: message(
                      "error",
                      "quota reached for owner@example.test Bearer secret-value",
                    ),
                  },
                ])
              : stream([secondStart, text, done])
          ) as any;
        },
      },
      MODEL as any,
      CONTEXT as any,
      options,
    );
    const events = await collect(pooled);
    expect(events).toEqual([secondStart, text, done]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.model).toBe(MODEL);
    expect(calls[0]?.context).toBe(CONTEXT);
    expect(calls.map((call) => call.options.apiKey)).toEqual([
      "fake-access-a",
      "fake-access-b",
    ]);
    for (const call of calls) {
      expect(call.options).toEqual({
        ...options,
        apiKey: call.options.apiKey,
        maxRetries: 0,
        timeoutMs: 1234,
      });
      expect(call.options.sessionId).toBe("root-session");
      expect(call.options.headers).toBe(headers);
      expect(call.options.onPayload).toBe(payloadCallback);
      expect(call.options.onResponse).toBe(responseCallback);
      expect(call.options.metadata).toBe(metadata);
      expect(call.options.env).toBe(env);
    }
    expect(JSON.stringify(events)).not.toContain("owner@example.test");
    expect(JSON.stringify(events)).not.toContain("secret-value");
    expect(routes.routeFor("root-session")).toBe("keeper-codex-b");
  });

  test("stops after the second different alias fails before output", async () => {
    let calls = 0;
    let nativeCalls = 0;
    const events = await collect(
      createPooledCodexStream(
        {
          vault: new CredentialVault(
            new MemoryCredentialStorage(credentials()),
            async (credential) => credential,
            () => 100,
          ),
          routes: routeState(),
          warn: () => {},
          nativeDelegate: () => {
            nativeCalls += 1;
            return stream([]) as any;
          },
          delegate: () => {
            calls += 1;
            return stream([
              { type: "start", partial: message() },
              {
                type: "error",
                reason: "error",
                error: message("error", "rate limit Bearer hidden-value"),
              },
            ]) as any;
          },
        },
        MODEL as any,
        CONTEXT as any,
        { sessionId: "two-attempt-session" },
      ),
    );
    expect(calls).toBe(2);
    expect(nativeCalls).toBe(0);
    expect(events.map((event: any) => event.type)).toEqual(["error"]);
    expect(JSON.stringify(events)).not.toContain("hidden-value");
  });

  test("keeps reusable transport identity scoped to each sticky account and exact session id", async () => {
    const aliases = ["keeper-codex-a", "keeper-codex-b"];
    const routes = routeState(aliases);
    const vault = new CredentialVault(
      new MemoryCredentialStorage(credentials()),
      async (credential) => credential,
      () => 100,
    );
    const transportAccounts = new Map<string, string>();
    const calls: Array<{ sessionId: string; access: string }> = [];
    const delegate = (_model: unknown, _context: unknown, options?: any) => {
      const prior = transportAccounts.get(options.sessionId);
      if (prior !== undefined && prior !== options.apiKey) {
        throw new Error("transport-account-crossed");
      }
      transportAccounts.set(options.sessionId, options.apiKey);
      calls.push({ sessionId: options.sessionId, access: options.apiKey });
      return stream([
        { type: "start", partial: message() },
        { type: "done", reason: "stop", message: message() },
      ]) as any;
    };
    const deps = {
      vault,
      routes,
      warn: () => {},
      nativeDelegate: delegate,
      delegate,
    };
    await collect(
      createPooledCodexStream(deps as any, MODEL as any, CONTEXT as any, {
        sessionId: "root-session",
      }),
    );
    await collect(
      createPooledCodexStream(deps as any, MODEL as any, CONTEXT as any, {
        sessionId: "root-session",
      }),
    );
    await collect(
      createPooledCodexStream(deps as any, MODEL as any, CONTEXT as any, {
        sessionId: "child-session",
      }),
    );
    expect(calls).toEqual([
      { sessionId: "root-session", access: "fake-access-a" },
      { sessionId: "root-session", access: "fake-access-a" },
      { sessionId: "child-session", access: "fake-access-b" },
    ]);
  });

  test("text, thinking, tool-call, and unknown events all close the retry window", async () => {
    const cutoffEvents = [
      {
        type: "text_start",
        contentIndex: 0,
        partial: message(),
      },
      {
        type: "thinking_start",
        contentIndex: 0,
        partial: message(),
      },
      {
        type: "toolcall_start",
        contentIndex: 0,
        partial: message(),
      },
      { type: "future_provider_event", opaque: true },
    ];
    for (const cutoff of cutoffEvents) {
      let calls = 0;
      const vault = new CredentialVault(
        new MemoryCredentialStorage(credentials()),
        async (credential) => credential,
        () => 100,
      );
      const pooled = createPooledCodexStream(
        {
          vault,
          routes: routeState(),
          warn: () => {},
          nativeDelegate: () => stream([]) as any,
          delegate: () => {
            calls += 1;
            return stream([
              { type: "start", partial: message() },
              cutoff,
              {
                type: "error",
                reason: "error",
                error: message("error", "rate limit Bearer hidden-secret"),
              },
            ]) as any;
          },
        },
        MODEL as any,
        CONTEXT as any,
        { sessionId: `session-${cutoff.type}` },
      );
      const events = await collect(pooled);
      expect(calls).toBe(1);
      expect(events.map((event: any) => event.type)).toEqual([
        "start",
        cutoff.type,
        "error",
      ]);
      expect(JSON.stringify(events)).not.toContain("hidden-secret");
    }
  });

  test("surfaces context overflow for Pi recovery without cooling the account", async () => {
    let calls = 0;
    const routes = routeState();
    const pooled = createPooledCodexStream(
      {
        vault: new CredentialVault(
          new MemoryCredentialStorage(credentials()),
          async (credential) => credential,
          () => 100,
        ),
        routes,
        warn: () => {},
        nativeDelegate: () => stream([]) as any,
        delegate: () => {
          calls += 1;
          return stream([
            { type: "start", partial: message() },
            {
              type: "error",
              reason: "error",
              error: message(
                "error",
                "Your input exceeds the context window Bearer private-value",
              ),
            },
          ]) as any;
        },
      },
      MODEL as any,
      CONTEXT as any,
      { sessionId: "context-session" },
    );

    const events = await collect(pooled);
    expect(calls).toBe(1);
    expect((events.at(-1) as any).error.errorMessage).toBe(
      "context_length_exceeded",
    );
    expect(JSON.stringify(events)).not.toContain("private-value");
    expect(routes.routeFor("context-session")).toBe("keeper-codex-a");
    expect(
      routes
        .snapshot()
        .accounts.every((account) => account.cooldown_until_ms === 0),
    ).toBe(true);
  });

  test("retries recognized transient provider failures on another account", async () => {
    let calls = 0;
    const pooled = createPooledCodexStream(
      {
        vault: new CredentialVault(
          new MemoryCredentialStorage(credentials()),
          async (credential) => credential,
          () => 100,
        ),
        routes: routeState(),
        warn: () => {},
        nativeDelegate: () => stream([]) as any,
        delegate: () => {
          calls += 1;
          return calls === 1
            ? (stream([
                { type: "start", partial: message() },
                {
                  type: "error",
                  reason: "error",
                  error: message(
                    "error",
                    "Codex error: internal server error Bearer private-value",
                  ),
                },
              ]) as any)
            : (stream([
                { type: "start", partial: message() },
                { type: "done", reason: "stop", message: message() },
              ]) as any);
        },
      },
      MODEL as any,
      CONTEXT as any,
      { sessionId: "transient-session" },
    );

    const events = await collect(pooled);
    expect(calls).toBe(2);
    expect(events.map((event: any) => event.type)).toEqual(["start", "done"]);
    expect(JSON.stringify(events)).not.toContain("private-value");
    for (const message of [
      "Codex response failed",
      "server overloaded; try again",
      "upstream connect error",
    ]) {
      expect(classifyPoolFailure(message)).toBe("transport");
    }
  });

  test("classifies login and credential-expiry phrasings as auth", () => {
    for (const message of [
      "Error: you are not logged in. Please run `codex login`.",
      "your login expired, please sign in again",
      "session expired: please re-authenticate",
      "please run codex login to continue",
      "your credentials are invalid",
      "credentials expired",
      "credential missing for this account",
    ]) {
      expect(classifyPoolFailure(message)).toBe("auth");
    }
    // A genuinely unclassifiable phrasing stays bucketed as "other".
    expect(classifyPoolFailure("opaque provider failure code 7")).toBe("other");
  });

  test("retries the same alias once when no healthy alternate exists", async () => {
    const aliases = ["keeper-codex-a", "keeper-codex-b"];
    const routes = new PoolRouteState(
      aliases,
      null,
      () => 100,
      "keeper-codex-b",
      CODEX_GENERIC_QUOTA_SCOPE,
      aliasPolicy(aliases),
    );
    routes.recordFailure("depleted", "keeper-codex-a", "quota");
    const apiKeys: Array<string | undefined> = [];
    const pooled = createPooledCodexStream(
      {
        vault: new CredentialVault(
          new MemoryCredentialStorage(credentials()),
          async (credential) => credential,
          () => 100,
        ),
        routes,
        warn: () => {},
        nativeDelegate: () => stream([]) as any,
        delegate: (_model, _context, options) => {
          apiKeys.push(options?.apiKey);
          return apiKeys.length === 1
            ? (stream([
                { type: "start", partial: message() },
                {
                  type: "error",
                  reason: "error",
                  error: message("error", "server overloaded; please retry"),
                },
              ]) as any)
            : (stream([
                { type: "start", partial: message() },
                { type: "done", reason: "stop", message: message() },
              ]) as any);
        },
      },
      MODEL as any,
      CONTEXT as any,
      { sessionId: "degraded-session" },
    );

    const events = await collect(pooled);
    expect(apiKeys).toEqual(["fake-access-b", "fake-access-b"]);
    expect(events.map((event: any) => event.type)).toEqual(["start", "done"]);
  });

  test("retries a rejected cached continuation once on the same alias", async () => {
    const apiKeys: Array<string | undefined> = [];
    const pooled = createPooledCodexStream(
      {
        vault: new CredentialVault(
          new MemoryCredentialStorage(credentials()),
          async (credential) => credential,
          () => 100,
        ),
        routes: routeState(),
        warn: () => {},
        nativeDelegate: () => stream([]) as any,
        delegate: (_model, _context, options) => {
          apiKeys.push(options?.apiKey);
          return apiKeys.length === 1
            ? (stream([
                { type: "start", partial: message() },
                {
                  type: "error",
                  reason: "error",
                  error: message(
                    "error",
                    "Codex error: Previous response with id 'resp_stale' not found.",
                  ),
                },
              ]) as any)
            : (stream([
                { type: "start", partial: message() },
                { type: "done", reason: "stop", message: message() },
              ]) as any);
        },
      },
      MODEL as any,
      CONTEXT as any,
      { sessionId: "stale-continuation-session" },
    );

    const events = await collect(pooled);
    expect(apiKeys).toEqual(["fake-access-a", "fake-access-a"]);
    expect(events.map((event: any) => event.type)).toEqual(["start", "done"]);
  });

  test("keeps the retried alias sticky when its second attempt overflows context", async () => {
    const aliases = ["keeper-codex-a", "keeper-codex-b"];
    const routes = new PoolRouteState(
      aliases,
      null,
      () => 100,
      "keeper-codex-b",
      CODEX_GENERIC_QUOTA_SCOPE,
      aliasPolicy(aliases),
    );
    routes.recordFailure("depleted", "keeper-codex-a", "quota");
    const apiKeys: Array<string | undefined> = [];
    const pooled = createPooledCodexStream(
      {
        vault: new CredentialVault(
          new MemoryCredentialStorage(credentials()),
          async (credential) => credential,
          () => 100,
        ),
        routes,
        warn: () => {},
        nativeDelegate: () => stream([]) as any,
        delegate: (_model, _context, options) => {
          apiKeys.push(options?.apiKey);
          return stream([
            { type: "start", partial: message() },
            {
              type: "error",
              reason: "error",
              error: message(
                "error",
                apiKeys.length === 1
                  ? "server overloaded; please retry"
                  : "Your input exceeds the context window Bearer private-value",
              ),
            },
          ]) as any;
        },
      },
      MODEL as any,
      CONTEXT as any,
      { sessionId: "degraded-overflow-session" },
    );

    const events = await collect(pooled);
    expect(apiKeys).toEqual(["fake-access-b", "fake-access-b"]);
    expect((events.at(-1) as any).error.errorMessage).toBe(
      "context_length_exceeded",
    );
    expect(routes.routeFor("degraded-overflow-session")).toBe("keeper-codex-b");
    expect(
      routes
        .snapshot()
        .accounts.find((account) => account.alias === "keeper-codex-b")
        ?.cooldown_until_ms,
    ).toBe(60_100);
    expect(JSON.stringify(events)).not.toContain("private-value");
  });

  test("fails over exactly once for a pre-substantive unclassified failure", async () => {
    const apiKeys: Array<string | undefined> = [];
    const pooled = createPooledCodexStream(
      {
        vault: new CredentialVault(
          new MemoryCredentialStorage(credentials()),
          async (credential) => credential,
          () => 100,
        ),
        routes: routeState(),
        warn: () => {},
        nativeDelegate: () => stream([]) as any,
        delegate: (_model, _context, options) => {
          apiKeys.push(options?.apiKey);
          return stream([
            { type: "start", partial: message() },
            {
              type: "error",
              reason: "error",
              error: message(
                "error",
                "opaque provider failure owner@example.test Bearer private-value",
              ),
            },
          ]) as any;
        },
      },
      MODEL as any,
      CONTEXT as any,
      { sessionId: "unclassified-session" },
    );
    const events = await collect(pooled);
    expect(apiKeys).toEqual(["fake-access-a", "fake-access-b"]);
    expect((events.at(-1) as any).error.errorMessage).toBe(
      "pool-other-failure",
    );
    expect(JSON.stringify(events)).not.toContain("owner@example.test");
    expect(JSON.stringify(events)).not.toContain("private-value");
  });

  test("does not retry a post-substantive unclassified failure", async () => {
    let calls = 0;
    const pooled = createPooledCodexStream(
      {
        vault: new CredentialVault(
          new MemoryCredentialStorage(credentials()),
          async (credential) => credential,
          () => 100,
        ),
        routes: routeState(),
        warn: () => {},
        nativeDelegate: () => stream([]) as any,
        delegate: () => {
          calls += 1;
          return stream([
            { type: "start", partial: message() },
            {
              type: "text_delta",
              contentIndex: 0,
              delta: "partial",
              partial: {
                ...message(),
                content: [{ type: "text", text: "partial" }],
              },
            },
            {
              type: "error",
              reason: "error",
              error: message(
                "error",
                "opaque provider failure owner@example.test Bearer private-value",
              ),
            },
          ]) as any;
        },
      },
      MODEL as any,
      CONTEXT as any,
      { sessionId: "unclassified-post-substantive-session" },
    );
    const events = await collect(pooled);
    expect(calls).toBe(1);
    expect(events.map((event: any) => event.type)).toEqual([
      "start",
      "text_delta",
      "error",
    ]);
    expect((events.at(-1) as any).error.errorMessage).toBe(
      "pool-other-failure",
    );
    expect(JSON.stringify(events)).not.toContain("owner@example.test");
    expect(JSON.stringify(events)).not.toContain("private-value");
  });

  test("logs the real upstream message privately while sanitizing the visible stream", async () => {
    const recorded: Array<{
      sessionId: string;
      alias: string;
      attempt: number;
      failureClass: string;
      message: string;
    }> = [];
    const pooled = createPooledCodexStream(
      {
        vault: new CredentialVault(
          new MemoryCredentialStorage(credentials()),
          async (credential) => credential,
          () => 100,
        ),
        routes: routeState(["keeper-codex-a"]),
        warn: () => {},
        nativeDelegate: () => stream([]) as any,
        failureLog: {
          record: (entry) => recorded.push(entry),
        },
        delegate: () => {
          return stream([
            { type: "start", partial: message() },
            {
              type: "text_delta",
              contentIndex: 0,
              delta: "partial",
              partial: {
                ...message(),
                content: [{ type: "text", text: "partial" }],
              },
            },
            {
              type: "error",
              reason: "error",
              error: message(
                "error",
                "session expired: please re-authenticate owner@example.test",
              ),
            },
          ]) as any;
        },
      },
      MODEL as any,
      CONTEXT as any,
      { sessionId: "failure-log-session" },
    );
    const events = await collect(pooled);
    expect((events.at(-1) as any).error.errorMessage).toBe("pool-auth-failure");
    expect(JSON.stringify(events)).not.toContain("owner@example.test");
    expect(recorded).toEqual([
      {
        sessionId: "failure-log-session",
        alias: "keeper-codex-a",
        attempt: 1,
        failureClass: "auth",
        message: "session expired: please re-authenticate owner@example.test",
      },
    ]);
  });

  test("does not retry a stream that ends without a terminal event after output", async () => {
    let calls = 0;
    const pooled = createPooledCodexStream(
      {
        vault: new CredentialVault(
          new MemoryCredentialStorage(credentials()),
          async (credential) => credential,
          () => 100,
        ),
        routes: routeState(),
        warn: () => {},
        nativeDelegate: () => stream([]) as any,
        delegate: () => {
          calls += 1;
          return stream([
            { type: "start", partial: message() },
            { type: "future_provider_event", opaque: true },
          ]) as any;
        },
      },
      MODEL as any,
      CONTEXT as any,
      { sessionId: "unterminated-session" },
    );
    const events = await collect(pooled);
    expect(calls).toBe(1);
    expect(events.map((event: any) => event.type)).toEqual([
      "start",
      "future_provider_event",
      "error",
    ]);
  });

  test("shares one total deadline across both possible account attempts", async () => {
    const clock = Date.now();
    let now = clock;
    let calls = 0;
    const events = await collect(
      createPooledCodexStream(
        {
          vault: new CredentialVault(
            new MemoryCredentialStorage(credentials(clock + 100_000)),
            async (credential) => credential,
            () => now,
          ),
          routes: routeState(["keeper-codex-a", "keeper-codex-b"], () => now),
          now: () => now,
          warn: () => {},
          nativeDelegate: () => stream([]) as any,
          delegate: (_model, _context, options) => {
            calls += 1;
            expect(options?.timeoutMs).toBe(100);
            now = clock + 101;
            return stream([
              {
                type: "error",
                reason: "error",
                error: message("error", "temporary network timeout"),
              },
            ]) as any;
          },
        },
        MODEL as any,
        CONTEXT as any,
        { sessionId: "deadline-session", timeoutMs: 100 },
      ),
    );
    expect(calls).toBe(1);
    expect((events.at(-1) as any).reason).toBe("error");
    expect((events.at(-1) as any).error.errorMessage).toBe(
      "pool-deadline-exceeded",
    );
  });

  test("emits the deadline error when the budget expires during retry backoff", async () => {
    const clock = 1_000;
    let now = clock;
    let calls = 0;
    const waits: number[] = [];
    const events = await collect(
      createPooledCodexStream(
        {
          vault: new CredentialVault(
            new MemoryCredentialStorage(credentials(clock + 100_000)),
            async (credential) => credential,
            () => now,
          ),
          routes: routeState(["keeper-codex-a", "keeper-codex-b"], () => now),
          now: () => now,
          retryBackoffMs: 500,
          retryWait: async (ms) => {
            waits.push(ms);
            now += ms;
          },
          warn: () => {
            throw new Error("unexpected-fallback");
          },
          nativeDelegate: () => stream([]) as any,
          delegate: (_model, _context, options) => {
            calls += 1;
            expect(options?.timeoutMs).toBe(100);
            return stream([
              {
                type: "error",
                reason: "error",
                error: message("error", "temporary network timeout"),
              },
            ]) as any;
          },
        },
        MODEL as any,
        CONTEXT as any,
        { sessionId: "backoff-deadline-session", timeoutMs: 100 },
      ),
    );
    expect(calls).toBe(1);
    expect(waits).toEqual([100]);
    expect((events.at(-1) as any).reason).toBe("error");
    expect((events.at(-1) as any).error.errorMessage).toBe(
      "pool-deadline-exceeded",
    );
  });

  test("native fallback after selection and credential failures gets the remaining timeout", async () => {
    const sparkModel = {
      ...MODEL,
      id: "openai-codex/gpt-5.3-codex-spark",
    };
    const nativeTimeouts: Array<number | undefined> = [];
    const warnings: string[] = [];

    let now = 1_000;
    await collect(
      createPooledCodexStream(
        {
          vault: new CredentialVault(
            new MemoryCredentialStorage(credentials(10_000)),
            async (credential) => credential,
            () => now,
          ),
          routes: routeState(["keeper-codex-a"], () => {
            now = 1_040;
            return now;
          }),
          now: () => now,
          warn: (reason) => warnings.push(reason),
          delegate: () => {
            throw new Error("must-not-call");
          },
          nativeDelegate: (_model, _context, options) => {
            nativeTimeouts.push(options?.timeoutMs);
            return stream([
              { type: "done", reason: "stop", message: message() },
            ]) as any;
          },
        },
        sparkModel as any,
        CONTEXT as any,
        { sessionId: "selection-fallback-session", timeoutMs: 100 },
      ),
    );

    now = 2_000;
    await collect(
      createPooledCodexStream(
        {
          vault: new CredentialVault(
            {
              read: async () => {
                now = 2_075;
                return undefined;
              },
              modify: async () => undefined,
            } as any,
            async (credential) => credential,
            () => now,
          ),
          routes: routeState(["keeper-codex-a"], () => now),
          now: () => now,
          warn: (reason) => warnings.push(reason),
          delegate: () => {
            throw new Error("must-not-call");
          },
          nativeDelegate: (_model, _context, options) => {
            nativeTimeouts.push(options?.timeoutMs);
            return stream([
              { type: "done", reason: "stop", message: message() },
            ]) as any;
          },
        },
        MODEL as any,
        CONTEXT as any,
        { sessionId: "credential-fallback-session", timeoutMs: 100 },
      ),
    );

    expect(nativeTimeouts).toEqual([60, 25]);
    expect(warnings).toEqual(["pool-unavailable", "pool-unavailable"]);
  });

  test("expired budget prevents native fallback", async () => {
    const sparkModel = {
      ...MODEL,
      id: "openai-codex/gpt-5.3-codex-spark",
    };
    let now = 3_000;
    let nativeCalls = 0;
    const warnings: string[] = [];
    const events = await collect(
      createPooledCodexStream(
        {
          vault: new CredentialVault(
            new MemoryCredentialStorage(credentials(10_000)),
            async (credential) => credential,
            () => now,
          ),
          routes: routeState(["keeper-codex-a"], () => {
            now = 3_100;
            return now;
          }),
          now: () => now,
          warn: (reason) => warnings.push(reason),
          delegate: () => {
            throw new Error("must-not-call");
          },
          nativeDelegate: () => {
            nativeCalls += 1;
            return stream([]) as any;
          },
        },
        sparkModel as any,
        CONTEXT as any,
        { sessionId: "expired-fallback-session", timeoutMs: 100 },
      ),
    );

    expect(nativeCalls).toBe(0);
    expect(warnings).toEqual([]);
    expect((events.at(-1) as any).reason).toBe("error");
    expect((events.at(-1) as any).error.errorMessage).toBe(
      "pool-deadline-exceeded",
    );
  });

  test("pre-delegation aborts and deadlines release pressure without cooling", async () => {
    const expectNeutral = (routes: PoolRouteState): void => {
      const account = accountSnapshot(routes);
      expect(account.pressure).toBe(0);
      expect(account.pressure_expires_at_ms).toBe(0);
      expect(account.cooldown_until_ms).toBe(0);
      expect(
        account.quota_scopes.every((scope) => scope.cooldown_until_ms === 0),
      ).toBe(true);
    };
    let delegateCalls = 0;
    let nativeCalls = 0;
    const nativeDelegate = () => {
      nativeCalls += 1;
      return stream([]) as any;
    };
    const delegate = () => {
      delegateCalls += 1;
      return stream([]) as any;
    };

    const abortRoutes = routeState(["keeper-codex-a"]);
    for (const sessionId of ["credential-abort-a", "credential-abort-b"]) {
      const controller = new AbortController();
      const events = await collect(
        createPooledCodexStream(
          {
            vault: {
              resolve: async () => {
                controller.abort();
                throw new Error("credential-aborted");
              },
            } as any,
            routes: abortRoutes,
            warn: () => {},
            nativeDelegate,
            delegate,
          },
          MODEL as any,
          CONTEXT as any,
          { sessionId, signal: controller.signal },
        ),
      );
      expect((events.at(-1) as any).reason).toBe("aborted");
      expectNeutral(abortRoutes);
    }

    let now = 1_000;
    const expiredAfterSelection = routeState(["keeper-codex-a"], () => {
      now = 1_101;
      return now;
    });
    const postSelectionDeadline = await collect(
      createPooledCodexStream(
        {
          vault: {
            resolve: async () => {
              throw new Error("must-not-resolve");
            },
          } as any,
          routes: expiredAfterSelection,
          now: () => now,
          warn: () => {},
          nativeDelegate,
          delegate,
        },
        MODEL as any,
        CONTEXT as any,
        { sessionId: "post-selection-deadline", timeoutMs: 100 },
      ),
    );
    expect((postSelectionDeadline.at(-1) as any).error.errorMessage).toBe(
      "pool-deadline-exceeded",
    );
    expectNeutral(expiredAfterSelection);

    now = 2_000;
    const exhaustedAfterCredentials = routeState(["keeper-codex-a"], () => now);
    const remainingBudgetDeadline = await collect(
      createPooledCodexStream(
        {
          vault: {
            resolve: async () => {
              now = 2_100;
              return { access: "unused", expires: 3_000 };
            },
          } as any,
          routes: exhaustedAfterCredentials,
          now: () => now,
          warn: () => {},
          nativeDelegate,
          delegate,
        },
        MODEL as any,
        CONTEXT as any,
        { sessionId: "remaining-budget-deadline", timeoutMs: 100 },
      ),
    );
    expect((remainingBudgetDeadline.at(-1) as any).error.errorMessage).toBe(
      "pool-deadline-exceeded",
    );
    expectNeutral(exhaustedAfterCredentials);

    now = 3_000;
    const failedAfterDelegation = routeState(["keeper-codex-a"], () => now);
    await collect(
      createPooledCodexStream(
        {
          vault: {
            resolve: async () => ({ access: "delegated", expires: 4_000 }),
          } as any,
          routes: failedAfterDelegation,
          now: () => now,
          warn: () => {},
          nativeDelegate,
          delegate: () =>
            stream([
              {
                type: "error",
                reason: "error",
                error: message("error", "invalid token"),
              },
            ]) as any,
        },
        MODEL as any,
        CONTEXT as any,
        { sessionId: "delegated-auth-failure" },
      ),
    );
    const failedAccount = accountSnapshot(failedAfterDelegation);
    expect(failedAccount.pressure).toBe(0);
    expect(failedAccount.cooldown_until_ms).toBeGreaterThan(now);
    expect(delegateCalls).toBe(0);
    expect(nativeCalls).toBe(0);
  });

  test("aborts during credential selection, retry backoff, and streaming without changing accounts", async () => {
    let releaseRefresh!: (
      value: ReturnType<typeof credentials>["keeper-codex-a"],
    ) => void;
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const pendingRefresh = new Promise<
      ReturnType<typeof credentials>["keeper-codex-a"]
    >((resolve) => {
      releaseRefresh = resolve;
    });
    const selectionAbort = new AbortController();
    const selectionStream = createPooledCodexStream(
      {
        vault: new CredentialVault(
          new MemoryCredentialStorage(credentials(10)),
          async () => {
            markRefreshStarted();
            return pendingRefresh;
          },
          () => 100,
        ),
        routes: routeState(),
        warn: () => {},
        nativeDelegate: () => stream([]) as any,
        delegate: () => stream([]) as any,
      },
      MODEL as any,
      CONTEXT as any,
      { sessionId: "active-selection-abort", signal: selectionAbort.signal },
    );
    const collectingSelection = collect(selectionStream);
    await refreshStarted;
    selectionAbort.abort();
    const activeSelectionEvents = await collectingSelection;
    expect((activeSelectionEvents.at(-1) as any).reason).toBe("aborted");
    releaseRefresh({
      type: "oauth",
      access: "unused-refreshed-access",
      refresh: "unused-refreshed-refresh",
      expires: 10_000,
    });

    const beforeSelection = new AbortController();
    beforeSelection.abort();
    let calls = 0;
    const vault = new CredentialVault(
      new MemoryCredentialStorage(credentials()),
      async (credential) => credential,
      () => 100,
    );
    const deps = {
      vault,
      routes: routeState(),
      warn: () => {},
      nativeDelegate: () => stream([]) as any,
      delegate: () => {
        calls += 1;
        return stream([]) as any;
      },
    };
    const selectionEvents = await collect(
      createPooledCodexStream(deps, MODEL as any, CONTEXT as any, {
        sessionId: "selection-abort",
        signal: beforeSelection.signal,
      }),
    );
    expect(calls).toBe(0);
    expect((selectionEvents[0] as any).reason).toBe("aborted");

    const duringBackoff = new AbortController();
    const collectingBackoff = collect(
      createPooledCodexStream(
        {
          ...deps,
          retryBackoffMs: 50,
          delegate: () => {
            calls += 1;
            return stream([
              {
                type: "error",
                reason: "error",
                error: message("error", "temporary network timeout"),
              },
            ]) as any;
          },
        },
        MODEL as any,
        CONTEXT as any,
        { sessionId: "backoff-abort", signal: duringBackoff.signal },
      ),
    );
    setTimeout(() => duringBackoff.abort(), 0);
    const backoffEvents = await collectingBackoff;
    expect(calls).toBe(1);
    expect((backoffEvents.at(-1) as any).reason).toBe("aborted");

    const duringStream = new AbortController();
    let streamCalls = 0;
    const streamEvents = await collect(
      createPooledCodexStream(
        {
          ...deps,
          delegate: () => {
            streamCalls += 1;
            return {
              async *[Symbol.asyncIterator]() {
                yield { type: "start", partial: message() };
                duringStream.abort();
                yield {
                  type: "error",
                  reason: "aborted",
                  error: message("aborted", "Bearer private-stream-token"),
                };
              },
            } as any;
          },
        },
        MODEL as any,
        CONTEXT as any,
        { sessionId: "stream-abort", signal: duringStream.signal },
      ),
    );
    expect(streamCalls).toBe(1);
    expect((streamEvents.at(-1) as any).reason).toBe("aborted");
    expect(JSON.stringify(streamEvents)).not.toContain("private-stream-token");
  });

  test("routes sessionless managed calls with the supplied root identity", async () => {
    const delegatedSessionIds: Array<string | undefined> = [];
    let nativeCalls = 0;
    const pooled = createPooledCodexStream(
      {
        vault: new CredentialVault(
          new MemoryCredentialStorage(credentials(Date.now() + 120_000)),
          async (credential) => credential,
        ),
        routes: routeState(["keeper-codex-a", "keeper-codex-b"], Date.now),
        fallbackSessionId: "root-session",
        warn: () => {
          throw new Error("must-not-warn");
        },
        delegate: (_model, _context, options) => {
          delegatedSessionIds.push(options?.sessionId);
          return stream([
            { type: "start", partial: message() },
            { type: "done", reason: "stop", message: message() },
          ]) as any;
        },
        nativeDelegate: () => {
          nativeCalls += 1;
          return stream([]) as any;
        },
      },
      MODEL as any,
      CONTEXT as any,
    );

    await collect(pooled);
    expect(delegatedSessionIds).toEqual(["root-session"]);
    expect(nativeCalls).toBe(0);
  });

  test("falls visibly back to native Codex when Spark is not policy-authorized", async () => {
    const warnings: string[] = [];
    let nativeCalls = 0;
    const nativeEvents = [
      { type: "start", partial: message() },
      { type: "done", reason: "stop", message: message() },
    ];
    const sparkModel = {
      ...MODEL,
      id: "openai-codex/gpt-5.3-codex-spark",
    };
    const events = await collect(
      createPooledCodexStream(
        {
          vault: new CredentialVault(
            new MemoryCredentialStorage(credentials()),
            async (credential) => credential,
          ),
          routes: routeState(),
          warn: (reason) => warnings.push(reason),
          delegate: () => {
            throw new Error("must-not-call");
          },
          nativeDelegate: () => {
            nativeCalls += 1;
            return stream(nativeEvents) as any;
          },
        },
        sparkModel as any,
        CONTEXT as any,
        { sessionId: "spark-session" },
      ),
    );
    expect(events).toEqual(nativeEvents);
    expect(nativeCalls).toBe(1);
    expect(warnings).toEqual(["pool-unavailable"]);
  });

  test("falls visibly back to native Codex when pool credentials are unavailable", async () => {
    const originalOptions = {
      sessionId: "native-session",
      apiKey: "native-key",
      headers: { "x-native": "yes" },
      maxRetries: 3,
    };
    const nativeEvents = [
      { type: "start", partial: message() },
      { type: "done", reason: "stop", message: message() },
    ];
    const warnings: string[] = [];
    let nativeArgs: unknown[] = [];
    const pooled = createPooledCodexStream(
      {
        vault: new CredentialVault(
          new MemoryCredentialStorage(),
          async (credential) => credential,
        ),
        routes: routeState(),
        warn: (reason) => warnings.push(reason),
        delegate: () => {
          throw new Error("must-not-call");
        },
        nativeDelegate: (...args) => {
          nativeArgs = args;
          return stream(nativeEvents) as any;
        },
      },
      MODEL as any,
      CONTEXT as any,
      originalOptions,
    );
    expect(await collect(pooled)).toEqual(nativeEvents);
    expect(warnings).toEqual(["pool-unavailable"]);
    expect(nativeArgs).toEqual([MODEL, CONTEXT, originalOptions]);
  });
});

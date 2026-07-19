// biome-ignore-all lint/suspicious/noExplicitAny: Structural Pi stream doubles avoid loading peer modules in correctness tests.
// biome-ignore-all lint/style/noNonNullAssertion: Fixture guards and deferred callbacks establish values before use.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialVault,
  FileCredentialStorage,
  MemoryCredentialStorage,
  writePrivateJsonAtomic,
} from "../src/auth.ts";
import { createPooledCodexStream } from "../src/pool.ts";
import { PoolRouteState, PoolStateStore } from "../src/state.ts";

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

const nativeStream = () => ({
  async *[Symbol.asyncIterator]() {},
  result: async () => message(),
});

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
          refresh: async (credential: unknown) => credential,
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
};

afterEach(() => {
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
    installCodexPool(pi as never);
    expect(providers).toEqual([
      "keeper-codex-a",
      "keeper-codex-b",
      "openai-codex",
    ]);
    expect(commands).toEqual(["codex-pool-observe"]);
    rmSync(sandbox, { recursive: true, force: true });
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

    const routes = new PoolRouteState(
      ["keeper-codex-a", "keeper-codex-b"],
      null,
      () => 100,
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

  test("consumes the sanitized launch route once before independent child selection", () => {
    const routes = new PoolRouteState(
      ["keeper-codex-a", "keeper-codex-b"],
      null,
      () => 100,
      "keeper-codex-b",
    );
    expect(routes.select("root")).toBe("keeper-codex-b");
    expect(routes.select("child")).toBe("keeper-codex-a");
    expect(routes.select("root")).toBe("keeper-codex-b");
  });

  test("selects deterministically, keeps sessions sticky, and reacts to pressure and cooldown", () => {
    let now = 100;
    const routes = new PoolRouteState(
      ["keeper-codex-a", "keeper-codex-b"],
      null,
      () => now,
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

  test("persists only bounded alias routing facts", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-pool-state-"));
    const path = join(dir, "state.json");
    const routes = new PoolRouteState(
      ["keeper-codex-a", "keeper-codex-b"],
      new PoolStateStore(path),
      () => 100,
    );
    routes.select("private-session-id");
    const persisted = readFileSync(path, "utf8");
    expect(persisted).not.toContain("private-session-id");
    expect(persisted).not.toContain("fake-access");
    expect(JSON.parse(persisted)).toEqual(
      expect.objectContaining({
        schema_version: 1,
        accounts: expect.any(Array),
      }),
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("pooled Codex stream", () => {
  test("retries one different alias before output and preserves the request contract and ordering", async () => {
    const calls: Array<{ model: unknown; context: unknown; options: any }> = [];
    const clock = Date.now();
    const routes = new PoolRouteState(
      ["keeper-codex-a", "keeper-codex-b"],
      null,
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
          routes: new PoolRouteState(
            ["keeper-codex-a", "keeper-codex-b"],
            null,
            () => 100,
          ),
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
    const routes = new PoolRouteState(aliases, null, () => 100);
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
          routes: new PoolRouteState(
            ["keeper-codex-a", "keeper-codex-b"],
            null,
            () => 100,
          ),
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

  test("does not retry an unclassified failure before output", async () => {
    let calls = 0;
    const pooled = createPooledCodexStream(
      {
        vault: new CredentialVault(
          new MemoryCredentialStorage(credentials()),
          async (credential) => credential,
          () => 100,
        ),
        routes: new PoolRouteState(
          ["keeper-codex-a", "keeper-codex-b"],
          null,
          () => 100,
        ),
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
    expect(calls).toBe(1);
    expect(events.map((event: any) => event.type)).toEqual(["start", "error"]);
    expect(JSON.stringify(events)).not.toContain("owner@example.test");
    expect(JSON.stringify(events)).not.toContain("private-value");
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
        routes: new PoolRouteState(
          ["keeper-codex-a", "keeper-codex-b"],
          null,
          () => 100,
        ),
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
          routes: new PoolRouteState(
            ["keeper-codex-a", "keeper-codex-b"],
            null,
            () => now,
          ),
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
        routes: new PoolRouteState(
          ["keeper-codex-a", "keeper-codex-b"],
          null,
          () => 100,
        ),
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
      routes: new PoolRouteState(
        ["keeper-codex-a", "keeper-codex-b"],
        null,
        () => 100,
      ),
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
        routes: new PoolRouteState(
          ["keeper-codex-a", "keeper-codex-b"],
          null,
          () => 100,
        ),
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

// biome-ignore-all lint/suspicious/noExplicitAny: Structural Pi stream fixtures avoid loading runtime-only peer types.
import { describe, expect, test } from "bun:test";
import {
  armCodexPoolProofWindow,
  codexPoolProofSeamActive,
} from "../../../src/codex-pool-proof-window.ts";
import {
  CODEX_GENERIC_QUOTA_SCOPE,
  CODEX_SPARK_QUOTA_SCOPE,
} from "../../../src/codex-quota-scope.ts";
import {
  type CredentialStorage,
  CredentialVault,
  MemoryCredentialStorage,
  type StoredOAuthCredential,
} from "../src/auth.ts";
import {
  type CodexDelegate,
  classifyPoolFailure,
  createCodexPoolProofFaultDelegate,
  createPooledCodexStream,
} from "../src/pool.ts";
import { PoolRouteState } from "../src/state.ts";

const NOW = 1_000_001;
const PARENT_PID = 4242;
const KEEPER_JOB_ID = "keeper-proof-job";
const ARMED_WINDOW = armCodexPoolProofWindow(1_000_000, PARENT_PID);
const ALIAS = "keeper-codex-a";
const FORCE_REQUEST = { schema_version: 1, alias: ALIAS } as const;

function routeState(
  aliases: readonly string[] = [ALIAS],
  now: () => number = () => NOW,
): PoolRouteState {
  return new PoolRouteState(
    aliases,
    null,
    now,
    undefined,
    CODEX_GENERIC_QUOTA_SCOPE,
    {
      [CODEX_GENERIC_QUOTA_SCOPE]: [...aliases],
      [CODEX_SPARK_QUOTA_SCOPE]: [],
    },
  );
}
const INITIAL_CREDENTIAL: StoredOAuthCredential = {
  type: "oauth",
  access: "initial-access",
  refresh: "initial-refresh",
  expires: 2_000_000,
};
const ROTATED_CREDENTIAL: StoredOAuthCredential = {
  type: "oauth",
  access: "rotated-access",
  refresh: "rotated-refresh",
  expires: 3_000_000,
};

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
const USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const DONE_MESSAGE = {
  role: "assistant" as const,
  content: [{ type: "text" as const, text: "ok" }],
  api: MODEL.api,
  provider: MODEL.provider,
  model: MODEL.id,
  usage: USAGE,
  stopReason: "stop" as const,
  timestamp: 1,
};
const START_EVENT = { type: "start", partial: DONE_MESSAGE } as const;
const TEXT_EVENT = {
  type: "text_delta",
  contentIndex: 0,
  delta: "ok",
  partial: DONE_MESSAGE,
} as const;
const DONE_EVENT = {
  type: "done",
  reason: "stop",
  message: DONE_MESSAGE,
} as const;

function proofSeamActive(
  seam: "forced_refresh" | "fault_injection",
  proofWindow: unknown = ARMED_WINDOW,
  keeperJobId: string | undefined = KEEPER_JOB_ID,
): boolean {
  return codexPoolProofSeamActive(
    proofWindow,
    seam,
    NOW,
    PARENT_PID,
    keeperJobId,
  );
}

function credentialStorage(): MemoryCredentialStorage {
  return new MemoryCredentialStorage({ [ALIAS]: INITIAL_CREDENTIAL });
}

function eventStream(events: readonly unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    result: async () => DONE_MESSAGE,
  };
}

async function collect(source: AsyncIterable<unknown>): Promise<any[]> {
  const events: any[] = [];
  for await (const event of source) events.push(event);
  return events;
}

describe("forced-refresh proof seam", () => {
  test("is inert without both an armed window and a Keeper job", async () => {
    let reads = 0;
    let modifies = 0;
    let refreshes = 0;
    const storage: CredentialStorage = {
      async read() {
        reads += 1;
        return INITIAL_CREDENTIAL;
      },
      async modify(_alias, update) {
        modifies += 1;
        return update(INITIAL_CREDENTIAL);
      },
    };
    let proofWindow: unknown = null;
    let keeperJobId: string | undefined = KEEPER_JOB_ID;
    const vault = new CredentialVault(
      storage,
      async () => {
        refreshes += 1;
        return ROTATED_CREDENTIAL;
      },
      () => NOW,
      () => proofSeamActive("forced_refresh", proofWindow, keeperJobId),
      [ALIAS],
    );
    const oversized = JSON.stringify({
      schema_version: 1,
      alias: ALIAS,
      padding: "x".repeat(600),
    });

    expect(await vault.forceRefresh(oversized)).toEqual({ status: "inactive" });
    proofWindow = ARMED_WINDOW;
    keeperJobId = "";
    expect(await vault.forceRefresh(oversized)).toEqual({ status: "inactive" });
    expect({ reads, modifies, refreshes }).toEqual({
      reads: 0,
      modifies: 0,
      refreshes: 0,
    });
  });

  test("coalesces concurrent forced refreshes into one stored rotation", async () => {
    let refreshCalls = 0;
    let markStarted!: () => void;
    let finishRefresh!: (credential: StoredOAuthCredential) => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pending = new Promise<StoredOAuthCredential>((resolve) => {
      finishRefresh = resolve;
    });
    const storage = credentialStorage();
    const observedRotations: string[] = [];
    const vault = new CredentialVault(
      storage,
      async () => {
        refreshCalls += 1;
        markStarted();
        return pending;
      },
      () => NOW,
      () => proofSeamActive("forced_refresh"),
      [ALIAS],
      (alias) => observedRotations.push(alias),
    );

    const operations = Array.from({ length: 8 }, () =>
      vault.forceRefresh(JSON.stringify(FORCE_REQUEST)),
    );
    await started;
    expect(refreshCalls).toBe(1);
    finishRefresh(ROTATED_CREDENTIAL);
    const outcomes = await Promise.all(operations);

    expect(outcomes).toHaveLength(8);
    expect(new Set(outcomes.map((outcome) => JSON.stringify(outcome)))).toEqual(
      new Set([
        JSON.stringify({ status: "rotated", alias: ALIAS, expires: 3_000_000 }),
      ]),
    );
    expect(refreshCalls).toBe(1);
    expect(observedRotations).toEqual([ALIAS]);
    expect(await storage.read(ALIAS)).toEqual(ROTATED_CREDENTIAL);
  });

  test("joins an in-flight normal rotation instead of starting a second refresh", async () => {
    let refreshCalls = 0;
    let markStarted!: () => void;
    let finishRefresh!: (credential: StoredOAuthCredential) => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pending = new Promise<StoredOAuthCredential>((resolve) => {
      finishRefresh = resolve;
    });
    const storage = new MemoryCredentialStorage({
      [ALIAS]: { ...INITIAL_CREDENTIAL, expires: NOW + 1 },
    });
    const vault = new CredentialVault(
      storage,
      async () => {
        refreshCalls += 1;
        markStarted();
        return pending;
      },
      () => NOW,
      () => proofSeamActive("forced_refresh"),
      [ALIAS],
    );

    const normal = vault.resolve(ALIAS);
    await started;
    const forced = Promise.all([
      vault.forceRefresh(FORCE_REQUEST),
      vault.forceRefresh(FORCE_REQUEST),
    ]);
    finishRefresh(ROTATED_CREDENTIAL);

    expect(await normal).toEqual({
      access: "rotated-access",
      expires: 3_000_000,
    });
    expect(await forced).toEqual([
      { status: "rotated", alias: ALIAS, expires: 3_000_000 },
      { status: "rotated", alias: ALIAS, expires: 3_000_000 },
    ]);
    expect(refreshCalls).toBe(1);
  });

  test("reports unchanged and failed refreshes as distinct typed outcomes", async () => {
    let unchangedCalls = 0;
    const observedRotations: string[] = [];
    const unchangedStorage = credentialStorage();
    const unchangedVault = new CredentialVault(
      unchangedStorage,
      async (credential) => {
        unchangedCalls += 1;
        return { ...credential };
      },
      () => NOW,
      () => proofSeamActive("forced_refresh"),
      [ALIAS],
      (alias) => observedRotations.push(alias),
    );
    expect(await unchangedVault.forceRefresh(FORCE_REQUEST)).toEqual({
      status: "inconclusive",
      alias: ALIAS,
      outcome: "already-fresh",
      reason: "credential-unchanged",
    });
    expect(unchangedCalls).toBe(1);
    expect(observedRotations).toEqual([]);
    expect(await unchangedStorage.read(ALIAS)).toEqual(INITIAL_CREDENTIAL);

    const failedVault = new CredentialVault(
      credentialStorage(),
      async () => {
        throw new Error("provider rejected refresh");
      },
      () => NOW,
      () => proofSeamActive("forced_refresh"),
      [ALIAS],
    );
    expect(await failedVault.forceRefresh(FORCE_REQUEST)).toEqual({
      status: "failed",
      alias: ALIAS,
      reason: "credential-refresh-failed",
    });
  });

  test("rejects malformed and oversized active requests", async () => {
    const vault = new CredentialVault(
      credentialStorage(),
      async () => ROTATED_CREDENTIAL,
      () => NOW,
      () => proofSeamActive("forced_refresh"),
      [ALIAS],
    );
    await expect(
      vault.forceRefresh({ schema_version: 1, alias: "not-an-alias" }),
    ).rejects.toThrow("credential-proof-seam-invalid");
    await expect(
      vault.forceRefresh(
        JSON.stringify({
          schema_version: 1,
          alias: ALIAS,
          padding: "x".repeat(600),
        }),
      ),
    ).rejects.toThrow("credential-proof-seam-invalid");
  });

  test("rejects a valid but unenrolled alias before credential storage", async () => {
    let reads = 0;
    let modifies = 0;
    let refreshes = 0;
    const storage: CredentialStorage = {
      async read() {
        reads += 1;
        return INITIAL_CREDENTIAL;
      },
      async modify(_alias, update) {
        modifies += 1;
        return update(INITIAL_CREDENTIAL);
      },
    };
    const vault = new CredentialVault(
      storage,
      async () => {
        refreshes += 1;
        return ROTATED_CREDENTIAL;
      },
      () => NOW,
      () => proofSeamActive("forced_refresh"),
      [ALIAS],
    );

    await expect(
      vault.forceRefresh({
        schema_version: 1,
        alias: "keeper-codex-stale",
      }),
    ).rejects.toThrow("credential-proof-seam-invalid");
    expect({ reads, modifies, refreshes }).toEqual({
      reads: 0,
      modifies: 0,
      refreshes: 0,
    });
  });
});

const FAULTS = [
  {
    failureClass: "quota",
    message: "codex pool proof quota exceeded",
  },
  {
    failureClass: "rate",
    message: "codex pool proof rate limit",
  },
  {
    failureClass: "auth",
    message: "codex pool proof unauthorized",
  },
  {
    failureClass: "transport",
    message: "codex pool proof network timeout",
  },
] as const;
const PHASES = [
  { phase: "pre-output", eventTypes: ["error"], delegateCalls: 0 },
  {
    phase: "mid-stream",
    eventTypes: ["start", "text_delta", "error"],
    delegateCalls: 1,
  },
] as const;

describe("classified fault proof seam", () => {
  for (const fault of FAULTS) {
    for (const phase of PHASES) {
      test(`emits ${fault.failureClass} ${phase.phase}`, async () => {
        let delegateCalls = 0;
        const outcomes: unknown[] = [];
        const base: CodexDelegate = () => {
          delegateCalls += 1;
          return eventStream([START_EVENT, TEXT_EVENT, DONE_EVENT]) as never;
        };
        const delegate = createCodexPoolProofFaultDelegate(base, {
          request: {
            schema_version: 1,
            failure_class: fault.failureClass,
            phase: phase.phase,
          },
          active: () => proofSeamActive("fault_injection"),
          onOutcome: (outcome) => outcomes.push(outcome),
        });

        const source = delegate(MODEL as never, CONTEXT as never);
        const events = await collect(source as AsyncIterable<unknown>);
        expect(events.map((event) => event.type)).toEqual(phase.eventTypes);
        expect(delegateCalls).toBe(phase.delegateCalls);
        const terminal = events.at(-1);
        expect(terminal.error.errorMessage).toBe(fault.message);
        expect(classifyPoolFailure(terminal.error.errorMessage)).toBe(
          fault.failureClass,
        );
        expect((await source.result()).errorMessage).toBe(fault.message);
        expect(outcomes).toEqual([
          {
            status: "injected",
            failure_class: fault.failureClass,
            phase: phase.phase,
          },
        ]);
      });
    }
  }

  test("is inert without both an armed window and a Keeper job", async () => {
    let delegateCalls = 0;
    const base: CodexDelegate = () => {
      delegateCalls += 1;
      return eventStream([START_EVENT, TEXT_EVENT, DONE_EVENT]) as never;
    };
    for (const active of [
      () => proofSeamActive("fault_injection", null, KEEPER_JOB_ID),
      () => proofSeamActive("fault_injection", ARMED_WINDOW, ""),
    ]) {
      const delegate = createCodexPoolProofFaultDelegate(base, {
        request: { failure_class: "not-classifiable" },
        active,
      });
      expect(delegate).toBe(base);
      expect(
        (
          await collect(
            delegate(
              MODEL as never,
              CONTEXT as never,
            ) as AsyncIterable<unknown>,
          )
        ).map((event) => event.type),
      ).toEqual(["start", "text_delta", "done"]);
    }
    expect(delegateCalls).toBe(2);
  });

  test("rejects out-of-enum, non-record, and oversized active requests", () => {
    const base = (() => eventStream([])) as CodexDelegate;
    const active = () => proofSeamActive("fault_injection");
    expect(() =>
      createCodexPoolProofFaultDelegate(base, {
        request: {
          schema_version: 1,
          failure_class: "invalid_grant",
          phase: "pre-output",
        },
        active,
      }),
    ).toThrow("proof-fault-request-invalid");
    expect(() =>
      createCodexPoolProofFaultDelegate(base, {
        request: "{}\n{}",
        active,
      }),
    ).toThrow("proof-fault-request-invalid");
    expect(() =>
      createCodexPoolProofFaultDelegate(base, {
        request: JSON.stringify({
          schema_version: 1,
          failure_class: "quota",
          phase: "pre-output",
          padding: "x".repeat(600),
        }),
        active,
      }),
    ).toThrow("proof-fault-request-invalid");
  });

  test("rejects terminal invalid_grant before touching credential storage", () => {
    let reads = 0;
    let modifies = 0;
    const storage: CredentialStorage = {
      async read() {
        reads += 1;
        return INITIAL_CREDENTIAL;
      },
      async modify(_alias, update) {
        modifies += 1;
        return update(INITIAL_CREDENTIAL);
      },
    };
    expect(() =>
      createPooledCodexStream(
        {
          vault: new CredentialVault(storage, async () => ROTATED_CREDENTIAL),
          routes: routeState([ALIAS], () => NOW),
          delegate: () => eventStream([]) as never,
          nativeDelegate: () => eventStream([]) as never,
          warn: () => {},
          proofFault: {
            request: {
              schema_version: 1,
              failure_class: "invalid_grant",
              phase: "pre-output",
            },
            active: () => proofSeamActive("fault_injection"),
          },
        },
        MODEL as never,
        CONTEXT as never,
        { sessionId: "terminal-fault-rejection" },
      ),
    ).toThrow("proof-fault-request-invalid");
    expect({ reads, modifies }).toEqual({ reads: 0, modifies: 0 });
  });

  test("drives pooled retry before output and cutoff after output", async () => {
    const aliases = [ALIAS, "keeper-codex-b"];
    const makeVault = () =>
      new CredentialVault(
        new MemoryCredentialStorage({
          [ALIAS]: INITIAL_CREDENTIAL,
          "keeper-codex-b": {
            type: "oauth",
            access: "alternate-access",
            refresh: "alternate-refresh",
            expires: 2_000_000,
          },
        }),
        async (credential) => credential,
        () => NOW,
      );
    let preOutputCalls = 0;
    const preOutputRoutes = routeState(aliases, () => NOW);
    const preOutputEvents = await collect(
      createPooledCodexStream(
        {
          vault: makeVault(),
          routes: preOutputRoutes,
          delegate: () => {
            preOutputCalls += 1;
            return eventStream([START_EVENT, TEXT_EVENT, DONE_EVENT]) as never;
          },
          nativeDelegate: () => eventStream([]) as never,
          warn: () => {
            throw new Error("unexpected native fallback");
          },
          proofFault: {
            request: {
              schema_version: 1,
              failure_class: "quota",
              phase: "pre-output",
            },
            active: () => proofSeamActive("fault_injection"),
          },
        },
        MODEL as never,
        CONTEXT as never,
        { sessionId: "pre-output-session" },
      ) as AsyncIterable<unknown>,
    );
    expect(preOutputEvents.map((event) => event.type)).toEqual([
      "start",
      "text_delta",
      "done",
    ]);
    expect(preOutputCalls).toBe(1);
    expect(preOutputRoutes.routeFor("pre-output-session")).toBe(
      "keeper-codex-b",
    );

    let midStreamCalls = 0;
    const midStreamRoutes = routeState(aliases, () => NOW);
    const midStreamEvents = await collect(
      createPooledCodexStream(
        {
          vault: makeVault(),
          routes: midStreamRoutes,
          delegate: () => {
            midStreamCalls += 1;
            return eventStream([START_EVENT, TEXT_EVENT, DONE_EVENT]) as never;
          },
          nativeDelegate: () => eventStream([]) as never,
          warn: () => {
            throw new Error("unexpected native fallback");
          },
          proofFault: {
            request: {
              schema_version: 1,
              failure_class: "rate",
              phase: "mid-stream",
            },
            active: () => proofSeamActive("fault_injection"),
          },
        },
        MODEL as never,
        CONTEXT as never,
        { sessionId: "mid-stream-session" },
      ) as AsyncIterable<unknown>,
    );
    expect(midStreamEvents.map((event) => event.type)).toEqual([
      "start",
      "text_delta",
      "error",
    ]);
    expect(midStreamCalls).toBe(1);
    expect(midStreamEvents.at(-1).error.errorMessage).toBe("pool-rate-failure");
    expect(midStreamRoutes.routeFor("mid-stream-session")).toBeUndefined();
  });

  test("does not inject when the proof gate closes before substantive output", async () => {
    let active = true;
    const outcomes: unknown[] = [];
    const base = (() => ({
      async *[Symbol.asyncIterator]() {
        yield START_EVENT;
        active = false;
        yield TEXT_EVENT;
        yield DONE_EVENT;
      },
      result: async () => DONE_MESSAGE,
    })) as CodexDelegate;
    const delegate = createCodexPoolProofFaultDelegate(base, {
      request: {
        schema_version: 1,
        failure_class: "quota",
        phase: "mid-stream",
      },
      active: () => active && proofSeamActive("fault_injection"),
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    const source = delegate(MODEL as never, CONTEXT as never);

    expect(
      (await collect(source as AsyncIterable<unknown>)).map(
        (event) => event.type,
      ),
    ).toEqual(["start", "text_delta", "done"]);
    expect(await source.result()).toBe(DONE_MESSAGE);
    expect(outcomes).toEqual([
      {
        status: "inactive",
        failure_class: "quota",
        phase: "mid-stream",
        reason: "proof-seam-inactive",
      },
    ]);
  });

  test("preserves a genuine thrown pre-output failure for pooled retry", async () => {
    const aliases = [ALIAS, "keeper-codex-b"];
    let calls = 0;
    const outcomes: unknown[] = [];
    const events = await collect(
      createPooledCodexStream(
        {
          vault: new CredentialVault(
            new MemoryCredentialStorage({
              [ALIAS]: INITIAL_CREDENTIAL,
              "keeper-codex-b": {
                type: "oauth",
                access: "alternate-access",
                refresh: "alternate-refresh",
                expires: 2_000_000,
              },
            }),
            async (credential) => credential,
            () => NOW,
          ),
          routes: routeState(aliases, () => NOW),
          delegate: () => {
            calls += 1;
            if (calls === 1) {
              return {
                [Symbol.asyncIterator]() {
                  return {
                    async next() {
                      throw new Error("temporary network timeout");
                    },
                  };
                },
                result: async () => {
                  throw new Error("temporary network timeout");
                },
              } as never;
            }
            return eventStream([START_EVENT, TEXT_EVENT, DONE_EVENT]) as never;
          },
          nativeDelegate: () => eventStream([]) as never,
          warn: () => {
            throw new Error("unexpected native fallback");
          },
          proofFault: {
            request: {
              schema_version: 1,
              failure_class: "rate",
              phase: "mid-stream",
            },
            active: () => proofSeamActive("fault_injection"),
            onOutcome: (outcome) => outcomes.push(outcome),
          },
        },
        MODEL as never,
        CONTEXT as never,
        { sessionId: "thrown-transport-session" },
      ) as AsyncIterable<unknown>,
    );

    expect(calls).toBe(2);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_delta",
      "done",
    ]);
    expect(outcomes).toEqual([
      {
        status: "inconclusive",
        failure_class: "rate",
        phase: "mid-stream",
        reason: "substantive-output-not-observed",
      },
    ]);
  });

  test("reports a content start without payload as inconclusive", async () => {
    const outcomes: unknown[] = [];
    const base = (() =>
      eventStream([
        START_EVENT,
        {
          type: "thinking_start",
          contentIndex: 0,
          partial: {
            ...DONE_MESSAGE,
            content: [{ type: "thinking", thinking: "" }],
          },
        },
        DONE_EVENT,
      ])) as CodexDelegate;
    const delegate = createCodexPoolProofFaultDelegate(base, {
      request: {
        schema_version: 1,
        failure_class: "transport",
        phase: "mid-stream",
      },
      active: () => proofSeamActive("fault_injection"),
      onOutcome: (outcome) => outcomes.push(outcome),
    });

    expect(
      (
        await collect(
          delegate(MODEL as never, CONTEXT as never) as AsyncIterable<unknown>,
        )
      ).map((event) => event.type),
    ).toEqual(["start", "thinking_start", "done"]);
    expect(outcomes).toEqual([
      {
        status: "inconclusive",
        failure_class: "transport",
        phase: "mid-stream",
        reason: "substantive-output-not-observed",
      },
    ]);
  });
});

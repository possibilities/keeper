import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CODEX_POOL_PROOF_WINDOW_ENV,
  codexPoolProofSeamActive,
  codexPoolProofWindowActive,
} from "../../../src/codex-pool-proof-window.ts";
import {
  aliasesFromEnvironment,
  type CanonicalOAuth,
  CredentialVault,
  extensionOAuthFromCanonical,
  FileCredentialStorage,
} from "./auth.ts";
import { observePool, renderObserverEnvelope } from "./observer.ts";
import {
  type CodexDelegate,
  type CodexPoolProofFaultOptions,
  classifyPoolFailure,
  createCodexPoolProofFaultDelegate,
  createPooledCodexStream,
} from "./pool.ts";
import type {
  ArtifactSurface,
  LiveProofClause,
  LiveProofReport,
  ProofTranscriptEntry,
} from "./proof.ts";
import { PoolRouteState, PoolStateStore } from "./state.ts";

type CompatPiAi = typeof import("@earendil-works/pi-ai/compat");
const { openAICodexResponsesApi } = piAi as unknown as CompatPiAi;

const KEEPER_MARKER = "KEEPER_JOB_ID";
const ALIASES_ENV = "KEEPER_PI_CODEX_POOL_ALIASES";
const MODE_ENV = "KEEPER_PI_CODEX_POOL_MODE";
const CONFIG_BINDING_ENV = "KEEPER_PI_CODEX_POOL_CONFIG_BINDING";
const INITIAL_ALIAS_ENV = "KEEPER_PI_CODEX_POOL_INITIAL_ALIAS";
const REVISION_ENV = "KEEPER_PI_CODEX_POOL_REVISION";
const CONFIG_ROOT_ENV = "KEEPER_PI_CODEX_POOL_CONFIG_ROOT";
const WARNING =
  "[keeper-codex-pool] pool-unavailable; using native openai-codex";

type ReportFailureClass = "none" | "quota" | "rate" | "auth" | "transport";

interface CommandContext {
  ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
  };
  signal?: AbortSignal;
}

interface ProofToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

interface ProofToolDefinition {
  name: "codex_pool_proof";
  label: string;
  description: string;
  executionMode: "sequential";
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, never>,
    signal: AbortSignal | undefined,
  ): Promise<ProofToolResult>;
}

export interface CodexPoolInstallOptions {
  nativeDelegate?: CodexDelegate;
  oauth?: CanonicalOAuth;
}

interface PoolExtensionApi {
  on?(
    event: "session_start",
    handler: (
      event: unknown,
      ctx: { sessionManager: { getSessionId(): string } },
    ) => void,
  ): void;
  registerProvider(
    name: string,
    config: {
      name?: string;
      api?: string;
      oauth?: ReturnType<typeof extensionOAuthFromCanonical>;
      streamSimple?: (
        model: Model<"openai-codex-responses">,
        context: Context,
        options?: SimpleStreamOptions,
      ) => AssistantMessageEventStream;
    },
  ): void;
  registerCommand(
    name: string,
    options: {
      description: string;
      handler(args: string, ctx: CommandContext): Promise<void> | void;
    },
  ): void;
  registerTool?(tool: ProofToolDefinition): void;
}

interface RouteEvidence {
  sessionId: string;
  sessionRole: "root" | "child";
  attempts: number;
  aliases: string[];
  failureClass: ReportFailureClass;
  substantiveOutput: boolean;
  requestContract: boolean;
  terminal: boolean;
  restored: boolean;
  aborted: boolean;
  deliberateAbort: boolean;
  proofFaultPhase: "pre-output" | "mid-stream" | null;
}

function eventFailureClass(event: AssistantMessageEvent): ReportFailureClass {
  if (event.type !== "error") return "none";
  const classified = classifyPoolFailure(event.error.errorMessage ?? "");
  return classified === "other" || classified === "context"
    ? "none"
    : classified;
}

function isSubstantiveEvent(event: AssistantMessageEvent): boolean {
  return !["start", "done", "error"].includes(event.type);
}

function sameRequestContract(
  originalModel: Model<"openai-codex-responses">,
  originalContext: Context,
  originalOptions: SimpleStreamOptions | undefined,
  attemptModel: Model<"openai-codex-responses">,
  attemptContext: Context,
  attemptOptions: SimpleStreamOptions | undefined,
): boolean {
  if (
    originalModel !== attemptModel ||
    originalContext !== attemptContext ||
    attemptOptions === undefined ||
    attemptOptions.maxRetries !== 0
  ) {
    return false;
  }
  const original = (originalOptions ?? {}) as Record<string, unknown>;
  const attempt = attemptOptions as Record<string, unknown>;
  const replaced = new Set(["apiKey", "maxRetries", "timeoutMs"]);
  for (const [key, value] of Object.entries(original)) {
    if (!replaced.has(key) && !Object.is(attempt[key], value)) return false;
  }
  for (const key of Object.keys(attempt)) {
    if (!(key in original) && !replaced.has(key)) return false;
  }
  return attemptOptions.sessionId === originalOptions?.sessionId;
}

class ProofEvidence {
  readonly routes: RouteEvidence[] = [];
  private readonly completedAliases = new Map<string, string[]>();
  private readonly refreshedAliases = new Set<string>();
  private observerArtifact: string | null = null;
  aliasHealth: Array<{
    alias: string;
    status: "healthy" | "exhausted" | "unavailable";
  }> = [];
  private rootSessionId: string | null = null;
  private compatDelegateUsed = false;
  private activeRoutes = 0;
  private concurrentPressure = false;
  private nativeFallbackAttempts = 0;
  private nativeFallbackSuccesses = 0;
  interrupted = false;

  setRootSession(sessionId: string): void {
    if (sessionId.trim() !== "") this.rootSessionId = sessionId;
  }

  credentialRefreshed(alias: string): void {
    this.refreshedAliases.add(alias);
  }

  beginRoute(options: SimpleStreamOptions | undefined): RouteEvidence | null {
    const sessionId = options?.sessionId;
    if (!sessionId) return null;
    if (this.routes.length >= 16) {
      this.interrupted = true;
      return null;
    }
    this.activeRoutes += 1;
    if (this.activeRoutes > 1) this.concurrentPressure = true;
    const route: RouteEvidence = {
      sessionId,
      sessionRole: sessionId === this.rootSessionId ? "root" : "child",
      attempts: 0,
      aliases: [],
      failureClass: "none",
      substantiveOutput: false,
      requestContract: true,
      terminal: false,
      restored: false,
      aborted: false,
      deliberateAbort: false,
      proofFaultPhase: null,
    };
    this.routes.push(route);
    return route;
  }

  deliberateAbort(route: RouteEvidence | null): void {
    if (route !== null) route.deliberateAbort = true;
  }

  proofFault(
    route: RouteEvidence | null,
    phase: "pre-output" | "mid-stream",
  ): void {
    if (route !== null) route.proofFaultPhase = phase;
  }

  attempt(
    route: RouteEvidence | null,
    alias: string | undefined,
    contractMatches: boolean,
  ): void {
    this.compatDelegateUsed = true;
    if (route === null) return;
    route.attempts += 1;
    if (alias === undefined) {
      route.requestContract = false;
    } else {
      route.aliases.push(alias);
    }
    route.requestContract &&= contractMatches;
    if (route.attempts > 2) this.interrupted = true;
  }

  attemptEvent(
    route: RouteEvidence | null,
    event: AssistantMessageEvent,
  ): void {
    if (route === null) return;
    if (isSubstantiveEvent(event)) route.substantiveOutput = true;
    const failureClass = eventFailureClass(event);
    if (failureClass !== "none" && route.failureClass === "none") {
      route.failureClass = failureClass;
    }
  }

  attemptEnded(
    route: RouteEvidence | null,
    sawTerminal: boolean,
    sawSubstantive: boolean,
  ): void {
    if (
      route !== null &&
      !sawTerminal &&
      !sawSubstantive &&
      route.failureClass === "none"
    ) {
      route.failureClass = "transport";
    }
  }

  outputEvent(route: RouteEvidence | null, event: AssistantMessageEvent): void {
    if (route === null) return;
    if (isSubstantiveEvent(event)) route.substantiveOutput = true;
    if (event.type === "done" || event.type === "error") {
      route.terminal = true;
      route.restored = true;
      if (event.type === "error" && event.reason === "aborted") {
        route.aborted = true;
      }
      const alias = route.aliases.at(-1);
      if (event.type === "done" && alias !== undefined) {
        const completed = this.completedAliases.get(route.sessionId) ?? [];
        completed.push(alias);
        this.completedAliases.set(route.sessionId, completed);
      }
    }
  }

  outputEnded(route: RouteEvidence | null): void {
    if (route !== null) {
      this.activeRoutes = Math.max(0, this.activeRoutes - 1);
      if (!route.terminal || route.attempts === 0) this.interrupted = true;
    }
  }

  observed(rendered: string): void {
    this.observerArtifact = rendered;
    try {
      const parsed = JSON.parse(rendered) as {
        aliases?: Array<{ alias?: unknown; usage?: { status?: unknown } }>;
      };
      this.aliasHealth = (parsed.aliases ?? []).flatMap((entry) => {
        const status = entry.usage?.status;
        return typeof entry.alias === "string" &&
          (status === "healthy" ||
            status === "exhausted" ||
            status === "unavailable")
          ? [{ alias: entry.alias, status }]
          : [];
      });
    } catch {
      this.aliasHealth = [];
    }
  }

  beginNativeFallback(): void {
    this.nativeFallbackAttempts += 1;
  }

  nativeFallbackEnded(outcome: "done" | "error" | "unterminated"): void {
    if (outcome === "done") {
      this.nativeFallbackSuccesses += 1;
    } else {
      this.interrupted = true;
    }
  }

  restorationRequired(routes: LiveProofReport["routes"]): boolean {
    return (
      this.nativeFallbackAttempts > 0 ||
      routes.some((route) => route.failure_class !== "none")
    );
  }

  restorationCompleted(routes: LiveProofReport["routes"]): boolean {
    return (
      routes.every((route) => route.restored) &&
      this.nativeFallbackSuccesses === this.nativeFallbackAttempts
    );
  }

  transcriptEvidence(
    aliasRoles: ReadonlyArray<{
      alias: string;
      role: "primary" | "alternate";
    }>,
    state: ReturnType<PoolRouteState["snapshot"]>,
  ): Partial<Record<LiveProofClause, readonly string[]>> {
    const observed: Partial<Record<LiveProofClause, string[]>> = {};
    const add = (
      clause: LiveProofClause,
      condition: boolean,
      token: string,
    ) => {
      if (!condition) return;
      const entries = observed[clause] ?? [];
      entries.push(token);
      observed[clause] = entries;
    };
    const retryRoutes = this.routes.filter((route) => route.attempts === 2);
    const classifiedRetries = retryRoutes.filter(
      (route) =>
        route.proofFaultPhase === "pre-output" &&
        route.failureClass !== "none" &&
        route.aliases.length === 2 &&
        route.aliases[0] !== route.aliases[1],
    );
    const rootAlias = this.routes
      .find((route) => route.sessionRole === "root")
      ?.aliases.at(-1);
    const childAlias = this.routes
      .find((route) => route.sessionRole === "child")
      ?.aliases.at(-1);
    const primary = aliasRoles.find((entry) => entry.role === "primary")?.alias;
    const alternates = aliasRoles
      .filter((entry) => entry.role === "alternate")
      .map((entry) => entry.alias);
    add(
      "independent_credentials",
      primary !== undefined && this.refreshedAliases.has(primary),
      "primary-credential-rotated",
    );
    add(
      "independent_credentials",
      alternates.some((alias) => this.refreshedAliases.has(alias)),
      "alternate-credential-rotated",
    );
    add(
      "sanitized_observer",
      this.observerArtifact !== null,
      "sanitized-observer-rendered",
    );
    add("deterministic_routing", this.routes.length > 0, "routes-recorded");
    add(
      "deterministic_routing",
      this.routes.length > 0 &&
        this.routes.every(
          (route) =>
            route.aliases.length === route.attempts &&
            route.aliases.every((alias) => alias.length > 0),
        ),
      "attempt-aliases-recorded",
    );
    add(
      "session_stickiness",
      [...this.completedAliases.values()].some(
        (entries) => entries.length >= 2 && new Set(entries).size === 1,
      ),
      "completed-session-reused-alias",
    );
    add(
      "pressure_cooldown",
      this.concurrentPressure,
      "concurrent-routes-observed",
    );
    add(
      "pressure_cooldown",
      classifiedRetries.length > 0,
      "classified-retry-observed",
    );
    add(
      "pressure_cooldown",
      state.accounts.some((account) => account.cooldown_until_ms > 0),
      "cooldown-observed",
    );
    add("single_retry", retryRoutes.length > 0, "two-attempt-route-observed");
    add(
      "single_retry",
      this.routes.every((route) => route.attempts <= 2),
      "all-routes-at-most-two-attempts",
    );
    add(
      "substantive_cutoff",
      this.routes.some(
        (route) =>
          route.proofFaultPhase === "mid-stream" &&
          route.substantiveOutput &&
          route.failureClass !== "none" &&
          route.attempts === 1,
      ),
      "substantive-output-fault-not-retried",
    );
    add(
      "abort_preserved",
      this.routes.some(
        (route) =>
          route.deliberateAbort && route.aborted && route.attempts === 1,
      ),
      "deliberate-child-abort-not-retried",
    );
    add(
      "request_contract",
      this.routes.length > 0 &&
        this.routes.every((route) => route.requestContract),
      "all-attempts-preserved-request-contract",
    );
    add(
      "native_fallback",
      this.nativeFallbackAttempts > 0 &&
        this.nativeFallbackSuccesses === this.nativeFallbackAttempts,
      "native-fallback-completed",
    );
    add(
      "compat_root_delegate",
      this.compatDelegateUsed,
      "compat-root-delegate-used",
    );
    add(
      "root_child_sessions",
      this.routes.some((route) => route.sessionRole === "root"),
      "root-route-observed",
    );
    add(
      "root_child_sessions",
      this.routes.some((route) => route.sessionRole === "child"),
      "child-route-observed",
    );
    add(
      "transport_isolation",
      rootAlias !== undefined &&
        childAlias !== undefined &&
        rootAlias !== childAlias,
      "root-child-distinct-aliases",
    );
    return observed;
  }

  reportRoutes(): LiveProofReport["routes"] {
    return this.routes
      .filter((route) => route.attempts > 0)
      .map((route) => ({
        session_role: route.sessionRole,
        attempts: Math.min(2, route.attempts),
        aliases: [...route.aliases].slice(0, 2),
        failure_class: route.failureClass,
        substantive_output: route.substantiveOutput,
        restored: route.restored,
      }));
  }

  artifacts(
    transcript: readonly ProofTranscriptEntry[],
    clauses: Record<string, boolean>,
    routes: LiveProofReport["routes"],
    state: ReturnType<PoolRouteState["snapshot"]>,
  ): Array<{ surface: ArtifactSurface; content: string }> {
    const failureClasses = routes
      .map((route) => route.failure_class)
      .filter((failureClass) => failureClass !== "none");
    return [
      {
        surface: "observer",
        content: this.observerArtifact ?? "observer-not-run",
      },
      { surface: "state", content: JSON.stringify(state) },
      {
        surface: "proof",
        content: JSON.stringify({ clauses, routes }),
      },
      { surface: "transcript", content: JSON.stringify(transcript) },
      {
        surface: "log",
        content:
          this.nativeFallbackAttempts > 0 ? WARNING : "no-native-fallback",
      },
      {
        surface: "error",
        content: JSON.stringify({ failure_classes: failureClasses }),
      },
      {
        surface: "session",
        content: JSON.stringify(
          routes.map(({ session_role, attempts }) => ({
            session_role,
            attempts,
          })),
        ),
      },
      { surface: "tool", content: "codex_pool_proof" },
    ];
  }
}

function tapStream(
  source: AssistantMessageEventStream,
  onEvent: (event: AssistantMessageEvent) => void,
  onEnd: () => void,
): AssistantMessageEventStream {
  return {
    result: () => source.result(),
    async *[Symbol.asyncIterator]() {
      try {
        for await (const event of source) {
          onEvent(event);
          yield event;
        }
      } finally {
        onEnd();
      }
    },
  } as AssistantMessageEventStream;
}

function nativeOAuth(): CanonicalOAuth | undefined {
  const provider = builtinProviders().find(
    (candidate) => candidate.id === "openai-codex",
  );
  return provider?.auth.oauth as CanonicalOAuth | undefined;
}

function warn(): void {
  console.warn(WARNING);
}

function fallbackStream(
  nativeDelegate: CodexDelegate,
  model: Model<"openai-codex-responses">,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  warn();
  return nativeDelegate(model, context, options);
}

function reportPath(env: NodeJS.ProcessEnv): string {
  const configured = env[CONFIG_ROOT_ENV]?.trim();
  return join(
    configured || join(homedir(), ".config", "keeper", "codex-pool"),
    "live-proof.json",
  );
}

function proofWindowTimes(
  input: string | undefined,
): { startedAt: number; expiresAt: number } | null {
  try {
    const value = JSON.parse(input ?? "null") as {
      armed_at_ms?: unknown;
      expires_at_ms?: unknown;
    };
    return Number.isSafeInteger(value.armed_at_ms) &&
      Number.isSafeInteger(value.expires_at_ms)
      ? {
          startedAt: value.armed_at_ms as number,
          expiresAt: value.expires_at_ms as number,
        }
      : null;
  } catch {
    return null;
  }
}

function deliberateAbortStream(
  model: Model<"openai-codex-responses">,
): AssistantMessageEventStream {
  const error = {
    role: "assistant" as const,
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "aborted" as const,
    errorMessage: "request-aborted",
    timestamp: Date.now(),
  };
  const event = { type: "error" as const, reason: "aborted" as const, error };
  return {
    result: async () => error,
    async *[Symbol.asyncIterator]() {
      yield event;
    },
  } as AssistantMessageEventStream;
}

async function consumeStream(
  source: AssistantMessageEventStream,
): Promise<void> {
  for await (const _event of source) {
    // Consuming the production stream drives its retry and restoration paths.
  }
}

export function installCodexPool(
  pi: PoolExtensionApi,
  options: CodexPoolInstallOptions = {},
): void {
  const launchSessionId = (process.env[KEEPER_MARKER] ?? "").trim();
  if (launchSessionId === "") return;

  const nativeDelegate =
    options.nativeDelegate ??
    (openAICodexResponsesApi().streamSimple as CodexDelegate);
  let aliases: string[];
  let oauth: CanonicalOAuth | undefined;
  try {
    aliases = aliasesFromEnvironment(process.env[ALIASES_ENV]);
    oauth = options.oauth ?? nativeOAuth();
  } catch {
    aliases = [];
  }

  const requestedMode = process.env[MODE_ENV];
  const mode =
    requestedMode === "active" || requestedMode === "proof"
      ? requestedMode
      : "native";
  const proofWindow = process.env[CODEX_POOL_PROOF_WINDOW_ENV];
  const revision = process.env[REVISION_ENV];
  delete process.env[CODEX_POOL_PROOF_WINDOW_ENV];
  delete process.env[REVISION_ENV];
  const proofWindowActive = (): boolean =>
    codexPoolProofWindowActive(proofWindow, Date.now(), process.ppid);
  const proofRefreshActive = (): boolean =>
    codexPoolProofSeamActive(
      proofWindow,
      "forced_refresh",
      Date.now(),
      process.ppid,
      process.env[KEEPER_MARKER],
    );
  const proofFaultActive = (): boolean =>
    codexPoolProofSeamActive(
      proofWindow,
      "fault_injection",
      Date.now(),
      process.ppid,
      process.env[KEEPER_MARKER],
    );
  if (!oauth || aliases.length === 0) {
    pi.registerProvider("openai-codex", {
      api: "openai-codex-responses",
      streamSimple: (model, context, options) =>
        fallbackStream(nativeDelegate, model, context, options),
    });
    pi.registerCommand("codex-pool-observe", {
      description: "Report bounded Keeper Codex pool capacity",
      handler(_args, ctx) {
        ctx.ui.notify(
          JSON.stringify({
            schema_version: 1,
            status: "unavailable",
            reason: "pool-unavailable",
          }),
          "warning",
        );
      },
    });
    return;
  }

  const aliasOAuth = extensionOAuthFromCanonical(oauth);
  for (const [index, alias] of aliases.entries()) {
    pi.registerProvider(alias, {
      name: `Keeper Codex account ${index + 1}`,
      oauth: aliasOAuth,
    });
  }

  const evidence =
    mode === "proof" && proofWindowActive() ? new ProofEvidence() : null;
  const vault = new CredentialVault(
    new FileCredentialStorage(),
    (credential, signal) => oauth.refresh(credential, signal),
    Date.now,
    proofRefreshActive,
    aliases,
    (alias) => evidence?.credentialRefreshed(alias),
  );
  const routes = new PoolRouteState(
    aliases,
    new PoolStateStore(),
    Date.now,
    process.env[INITIAL_ALIAS_ENV],
  );
  const active =
    process.env[CONFIG_BINDING_ENV] === routes.binding &&
    (mode === "active" || evidence !== null);
  if (!active) {
    pi.registerProvider("openai-codex", {
      api: "openai-codex-responses",
      streamSimple: (model, context, options) =>
        fallbackStream(nativeDelegate, model, context, options),
    });
    pi.registerCommand("codex-pool-observe", {
      description: "Report bounded Keeper Codex pool capacity",
      async handler(_args, ctx) {
        try {
          ctx.ui.notify(
            renderObserverEnvelope(
              await observePool({ aliases, vault, routes, signal: ctx.signal }),
            ),
            "info",
          );
        } catch {
          ctx.ui.notify(
            JSON.stringify({
              schema_version: 1,
              status: "unavailable",
              reason: "pool-unavailable",
            }),
            "warning",
          );
        }
      },
    });
    return;
  }

  let rootSessionId = launchSessionId;
  pi.on?.("session_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (sessionId.trim() !== "") rootSessionId = sessionId;
    evidence?.setRootSession(sessionId);
  });

  type ProofInvocation = {
    model: Model<"openai-codex-responses">;
    context: Context;
    options: SimpleStreamOptions;
  };
  type ProofRouteControls = {
    fault?: {
      failure_class: "quota" | "rate" | "auth" | "transport";
      phase: "pre-output" | "mid-stream";
    };
    deliberateAbort?: boolean;
  };
  let proofInvocation: ProofInvocation | null = null;

  const createManagedStream = (
    model: Model<"openai-codex-responses">,
    context: Context,
    options?: SimpleStreamOptions,
    controls: ProofRouteControls = {},
  ): AssistantMessageEventStream => {
    if (mode === "proof" && !proofWindowActive()) {
      return fallbackStream(nativeDelegate, model, context, options);
    }
    if (evidence === null) {
      return createPooledCodexStream(
        {
          vault,
          routes,
          delegate: nativeDelegate,
          nativeDelegate,
          warn: () => warn(),
          ...(mode === "active" ? { fallbackSessionId: rootSessionId } : {}),
        },
        model,
        context,
        options,
      );
    }
    const route = evidence.beginRoute(options);
    if (controls.deliberateAbort === true) evidence.deliberateAbort(route);
    let attemptDelegate: CodexDelegate = nativeDelegate;
    if (controls.deliberateAbort === true) {
      attemptDelegate = (attemptModel) => deliberateAbortStream(attemptModel);
    } else if (controls.fault !== undefined) {
      const faultOptions: CodexPoolProofFaultOptions = {
        request: { schema_version: 1, ...controls.fault },
        active: proofFaultActive,
        onOutcome(outcome) {
          if (outcome.status === "injected") {
            evidence.proofFault(route, outcome.phase);
          }
        },
      };
      attemptDelegate = createCodexPoolProofFaultDelegate(
        nativeDelegate,
        faultOptions,
      );
    }
    const instrumentedDelegate: CodexDelegate = (
      attemptModel,
      attemptContext,
      attemptOptions,
    ) => {
      const alias =
        attemptOptions?.sessionId === undefined
          ? undefined
          : routes.routeFor(attemptOptions.sessionId);
      evidence.attempt(
        route,
        alias,
        sameRequestContract(
          model,
          context,
          options,
          attemptModel,
          attemptContext,
          attemptOptions,
        ),
      );
      let terminal = false;
      let substantive = false;
      const upstream = attemptDelegate(
        attemptModel,
        attemptContext,
        attemptOptions,
      );
      return tapStream(
        upstream,
        (event) => {
          terminal ||= event.type === "done" || event.type === "error";
          substantive ||= isSubstantiveEvent(event);
          evidence.attemptEvent(route, event);
        },
        () => evidence.attemptEnded(route, terminal, substantive),
      );
    };
    const instrumentedNativeDelegate: CodexDelegate = (
      nativeModel,
      nativeContext,
      nativeOptions,
    ) => {
      evidence.beginNativeFallback();
      let outcome: "done" | "error" | "unterminated" = "unterminated";
      const native = nativeDelegate(nativeModel, nativeContext, nativeOptions);
      return tapStream(
        native,
        (event) => {
          if (event.type === "done") outcome = "done";
          if (event.type === "error") outcome = "error";
        },
        () => evidence.nativeFallbackEnded(outcome),
      );
    };
    const pooled = createPooledCodexStream(
      {
        vault,
        routes,
        delegate: instrumentedDelegate,
        nativeDelegate: instrumentedNativeDelegate,
        warn: () => warn(),
        ...(mode === "active" ? { fallbackSessionId: rootSessionId } : {}),
      },
      model,
      context,
      options,
    );
    return tapStream(
      pooled,
      (event) => evidence.outputEvent(route, event),
      () => evidence.outputEnded(route),
    );
  };

  const pooledDelegate = (
    model: Model<"openai-codex-responses">,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    if (evidence !== null && options?.sessionId !== undefined) {
      proofInvocation = { model, context, options: { ...options } };
    }
    return createManagedStream(model, context, options);
  };

  const aliasRoles = aliases.map((alias, index) => ({
    alias,
    role: index === 0 ? ("primary" as const) : ("alternate" as const),
  }));
  const writeProofReport = async (
    interrupted: boolean,
  ): Promise<LiveProofReport> => {
    if (
      revision === undefined ||
      !/^[a-f0-9]{7,64}$/.test(revision) ||
      !/^[a-f0-9]{64}$/.test(routes.binding)
    ) {
      throw new Error("proof-binding-invalid");
    }
    const times = proofWindowTimes(proofWindow);
    if (times === null) throw new Error("proof-window-invalid");
    const proof = await import("./proof.ts");
    const state = routes.snapshot();
    const transcript = proof.buildProofTranscript(
      evidence?.transcriptEvidence(aliasRoles, state) ?? {},
    );
    const clauses = proof.clausesFromProofTranscript(transcript);
    const reportRoutes = evidence?.reportRoutes() ?? [];
    const artifactScan = proof.scanProofArtifacts(
      evidence?.artifacts(transcript, clauses, reportRoutes, state) ?? [],
    );
    const completedAt = Date.now();
    const aliasBinding = proof.aliasRoleBinding(aliasRoles);
    const report = proof.collectLiveProof(
      {
        revision,
        config_binding: routes.binding,
        alias_binding: aliasBinding,
        started_at_ms: times.startedAt,
        completed_at_ms: completedAt,
        interrupted: interrupted || evidence?.interrupted === true,
        alias_roles: aliasRoles,
        transcript,
        clauses,
        routes: reportRoutes,
        alias_health: evidence?.aliasHealth ?? [],
        restoration: {
          required: evidence?.restorationRequired(reportRoutes) ?? false,
          completed: evidence?.restorationCompleted(reportRoutes) ?? false,
        },
        artifact_scan: artifactScan,
      },
      {
        revision,
        config_binding: routes.binding,
        alias_binding: aliasBinding,
        now_ms: completedAt,
      },
    );
    proof.writeLiveProofReport(reportPath(process.env), report);
    return report;
  };

  pi.registerProvider("openai-codex", {
    api: "openai-codex-responses",
    streamSimple: pooledDelegate,
  });
  pi.registerCommand("codex-pool-observe", {
    description: "Report bounded Keeper Codex pool capacity",
    async handler(_args, ctx) {
      try {
        const envelope = await observePool({
          aliases,
          vault,
          routes,
          signal: ctx.signal,
        });
        const rendered = renderObserverEnvelope(envelope);
        evidence?.observed(rendered);
        ctx.ui.notify(rendered, "info");
      } catch {
        ctx.ui.notify(
          JSON.stringify({
            schema_version: 1,
            status: "unavailable",
            reason: "pool-unavailable",
          }),
          "warning",
        );
      }
    },
  });

  if (evidence !== null) {
    pi.registerCommand("codex-pool-proof", {
      description: "Write the armed Keeper Codex pool live-proof report",
      async handler(args, ctx) {
        if (args.trim() !== "" || !proofWindowActive()) {
          ctx.ui.notify(
            JSON.stringify({
              schema_version: 1,
              status: "unavailable",
              reason: "proof-window-inactive",
            }),
            "warning",
          );
          return;
        }
        try {
          const report = await writeProofReport(ctx.signal?.aborted === true);
          ctx.ui.notify(
            JSON.stringify({
              schema_version: 1,
              status: "written",
              verdict: report.verdict,
            }),
            report.verdict === "proven" ? "info" : "warning",
          );
        } catch {
          ctx.ui.notify(
            JSON.stringify({
              schema_version: 1,
              status: "unavailable",
              reason: "proof-write-failed",
            }),
            "error",
          );
        }
      },
    });

    let proofExecution: Promise<ProofToolResult> | null = null;
    const executeProof = async (
      signal: AbortSignal | undefined,
    ): Promise<ProofToolResult> => {
      const invocation = proofInvocation;
      const times = proofWindowTimes(proofWindow);
      if (
        invocation === null ||
        invocation.options.sessionId === undefined ||
        times === null ||
        !proofWindowActive()
      ) {
        const unavailable = {
          schema_version: 1,
          status: "unavailable",
          reason: "proof-window-inactive",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(unavailable) }],
          details: unavailable,
        };
      }

      const deadline = times.expiresAt - 250;
      const controller = new AbortController();
      let interruption: "deadline" | "external" | null = null;
      const interrupt = (kind: "deadline" | "external"): void => {
        interruption ??= kind;
        controller.abort();
      };
      const onExternalAbort = (): void => interrupt("external");
      signal?.addEventListener("abort", onExternalAbort, { once: true });
      if (signal?.aborted) onExternalAbort();
      const remainingAtStart = deadline - Date.now();
      const timer = setTimeout(
        () => interrupt("deadline"),
        Math.max(0, remainingAtStart),
      );
      const assertRunnable = (): void => {
        if (
          controller.signal.aborted ||
          Date.now() >= deadline ||
          !proofWindowActive()
        ) {
          if (interruption === null) interrupt("deadline");
          throw new Error("proof-run-interrupted");
        }
      };
      const runRoute = async (
        sessionId: string | undefined,
        controls: ProofRouteControls = {},
      ): Promise<void> => {
        assertRunnable();
        const timeoutMs = Math.max(1, deadline - Date.now());
        await consumeStream(
          createManagedStream(
            invocation.model,
            invocation.context,
            {
              ...invocation.options,
              sessionId,
              signal: controller.signal,
              timeoutMs,
            },
            controls,
          ),
        );
        assertRunnable();
      };

      try {
        evidence.setRootSession(invocation.options.sessionId);
        for (const alias of aliases.slice(0, 2)) {
          assertRunnable();
          await vault.forceRefresh(
            { schema_version: 1, alias },
            { signal: controller.signal, deadlineMs: deadline },
          );
        }
        assertRunnable();
        evidence.observed(
          renderObserverEnvelope(
            await observePool({
              aliases,
              vault,
              routes,
              signal: controller.signal,
            }),
          ),
        );
        assertRunnable();

        const rootSession = invocation.options.sessionId;
        const childSession = `${rootSession}:codex-pool-proof-child`;
        await Promise.all([runRoute(rootSession), runRoute(childSession)]);
        await runRoute(rootSession);
        await runRoute(`${childSession}:retry`, {
          fault: { failure_class: "quota", phase: "pre-output" },
        });
        await runRoute(`${childSession}:cutoff`, {
          fault: { failure_class: "rate", phase: "mid-stream" },
        });
        await runRoute(`${childSession}:abort`, { deliberateAbort: true });
        await runRoute(undefined);
      } catch {
        evidence.interrupted = true;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onExternalAbort);
      }

      const report = await writeProofReport(interruption !== null);
      const result = {
        schema_version: 1,
        status: "written",
        verdict: report.verdict,
        interrupted: report.interrupted,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    };

    try {
      pi.registerTool?.({
        name: "codex_pool_proof",
        label: "Codex Pool Proof",
        description:
          "Run the complete armed Codex pool proof once and write its attested report.",
        executionMode: "sequential",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute(_toolCallId, _params, signal) {
          proofExecution ??= executeProof(signal);
          return proofExecution;
        },
      });
    } catch {
      // Tool registration cannot disable provider routing or manual diagnosis.
    }
  }
}

export default function keeperCodexPool(pi: ExtensionAPI): void {
  try {
    installCodexPool(pi as unknown as PoolExtensionApi);
  } catch {
    // A companion failure never prevents Pi from starting.
  }
}

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
  codexPoolProofWindowActive,
} from "../../../src/codex-pool-proof-window.ts";
import {
  aliasesFromEnvironment,
  type CanonicalOAuth,
  type CredentialStorage,
  CredentialVault,
  extensionOAuthFromCanonical,
  FileCredentialStorage,
  type StoredOAuthCredential,
} from "./auth.ts";
import { observePool, renderObserverEnvelope } from "./observer.ts";
import {
  type CodexDelegate,
  classifyPoolFailure,
  createPooledCodexStream,
} from "./pool.ts";
import type { ArtifactSurface, LiveProofReport } from "./proof.ts";
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
}

function eventFailureClass(event: AssistantMessageEvent): ReportFailureClass {
  if (event.type !== "error") return "none";
  const classified = classifyPoolFailure(event.error.errorMessage ?? "");
  return classified === "other" ? "none" : classified;
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
    };
    this.routes.push(route);
    return route;
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

  clauses(): Record<string, boolean> {
    const aliases = new Set(this.routes.flatMap((route) => route.aliases));
    const retryRoutes = this.routes.filter((route) => route.attempts === 2);
    const sticky = [...this.completedAliases.values()].some(
      (entries) => entries.length >= 2 && new Set(entries).size === 1,
    );
    const rootAlias = this.routes
      .find((route) => route.sessionRole === "root")
      ?.aliases.at(-1);
    const childAlias = this.routes
      .find((route) => route.sessionRole === "child")
      ?.aliases.at(-1);
    const isolated =
      rootAlias !== undefined &&
      childAlias !== undefined &&
      rootAlias !== childAlias;
    return {
      independent_credentials:
        aliases.size >= 2 && this.refreshedAliases.size >= 2,
      sanitized_observer: this.observerArtifact !== null,
      deterministic_routing:
        this.routes.length > 0 &&
        this.routes.every(
          (route) =>
            route.aliases.length === route.attempts &&
            route.aliases.every((alias) => alias.length > 0),
        ),
      session_stickiness: sticky,
      pressure_cooldown:
        this.concurrentPressure &&
        retryRoutes.some(
          (route) =>
            route.failureClass !== "none" &&
            route.aliases.length === 2 &&
            route.aliases[0] !== route.aliases[1],
        ),
      single_retry:
        retryRoutes.length > 0 &&
        this.routes.every((route) => route.attempts <= 2),
      substantive_cutoff: this.routes.some(
        (route) =>
          route.substantiveOutput &&
          route.failureClass !== "none" &&
          route.attempts === 1,
      ),
      abort_preserved: this.routes.some(
        (route) => route.aborted && route.attempts === 1,
      ),
      request_contract:
        this.routes.length > 0 &&
        this.routes.every((route) => route.requestContract),
      native_fallback:
        this.nativeFallbackAttempts > 0 &&
        this.nativeFallbackSuccesses === this.nativeFallbackAttempts,
      compat_root_delegate: this.compatDelegateUsed,
      root_child_sessions:
        this.routes.some((route) => route.sessionRole === "root") &&
        this.routes.some((route) => route.sessionRole === "child"),
      transport_isolation: isolated,
    };
  }

  reportRoutes(): LiveProofReport["routes"] {
    return this.routes
      .filter((route) => route.attempts > 0)
      .map((route) => ({
        session_role: route.sessionRole,
        attempts: Math.min(2, route.attempts),
        failure_class: route.failureClass,
        substantive_output: route.substantiveOutput,
        restored: route.restored,
      }));
  }

  artifacts(
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
      { surface: "tool", content: "codex-pool-proof" },
    ];
  }
}

class ProofCredentialStorage implements CredentialStorage {
  constructor(
    private readonly storage: CredentialStorage,
    private readonly evidence: ProofEvidence,
  ) {}

  read(alias: string): Promise<StoredOAuthCredential | undefined> {
    return this.storage.read(alias);
  }

  async modify(
    alias: string,
    update: (
      current: StoredOAuthCredential | undefined,
    ) => Promise<StoredOAuthCredential | undefined>,
    options?: { signal?: AbortSignal; deadlineMs?: number },
  ): Promise<StoredOAuthCredential | undefined> {
    let refreshed = false;
    const result = await this.storage.modify(
      alias,
      async (current) => {
        const next = await update(current);
        refreshed = next !== undefined && next !== current;
        return next;
      },
      options,
    );
    if (refreshed) this.evidence.credentialRefreshed(alias);
    return result;
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

function proofWindowStart(input: string | undefined): number | null {
  try {
    const value = JSON.parse(input ?? "null") as { armed_at_ms?: unknown };
    return Number.isSafeInteger(value.armed_at_ms)
      ? (value.armed_at_ms as number)
      : null;
  } catch {
    return null;
  }
}

export function installCodexPool(pi: PoolExtensionApi): void {
  if ((process.env[KEEPER_MARKER] ?? "").trim() === "") return;

  const nativeDelegate = openAICodexResponsesApi()
    .streamSimple as CodexDelegate;
  let aliases: string[];
  let oauth: CanonicalOAuth | undefined;
  try {
    aliases = aliasesFromEnvironment(process.env[ALIASES_ENV]);
    oauth = nativeOAuth();
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
  const fileStorage = new FileCredentialStorage();
  const vault = new CredentialVault(
    evidence === null
      ? fileStorage
      : new ProofCredentialStorage(fileStorage, evidence),
    (credential, signal) => oauth.refresh(credential, signal),
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

  if (evidence !== null) {
    pi.on?.("session_start", (_event, ctx) => {
      evidence.setRootSession(ctx.sessionManager.getSessionId());
    });
  }

  const pooledDelegate = (
    model: Model<"openai-codex-responses">,
    context: Context,
    options?: SimpleStreamOptions,
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
        },
        model,
        context,
        options,
      );
    }
    const route = evidence.beginRoute(options);
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
      const upstream = nativeDelegate(
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
          if (
            revision === undefined ||
            !/^[a-f0-9]{7,64}$/.test(revision) ||
            !/^[a-f0-9]{64}$/.test(routes.binding)
          ) {
            throw new Error("proof-binding-invalid");
          }
          const startedAt = proofWindowStart(proofWindow);
          if (startedAt === null) throw new Error("proof-window-invalid");
          const completedAt = Date.now();
          const proof = await import("./proof.ts");
          const aliasRoles = aliases.map((alias, index) => ({
            alias,
            role: index === 0 ? ("primary" as const) : ("alternate" as const),
          }));
          const clauses = evidence.clauses();
          const reportRoutes = evidence.reportRoutes();
          const artifactScan = proof.scanProofArtifacts(
            evidence.artifacts(clauses, reportRoutes, routes.snapshot()),
          );
          const report = proof.collectLiveProof(
            {
              revision,
              config_binding: routes.binding,
              alias_binding: proof.aliasRoleBinding(aliasRoles),
              started_at_ms: startedAt,
              completed_at_ms: completedAt,
              interrupted: evidence.interrupted || ctx.signal?.aborted === true,
              alias_roles: aliasRoles,
              clauses: Object.fromEntries(
                proof.LIVE_PROOF_CLAUSES.map((clause) => [
                  clause,
                  clauses[clause] === true,
                ]),
              ) as LiveProofReport["clauses"],
              routes: reportRoutes,
              restoration: {
                required: evidence.restorationRequired(reportRoutes),
                completed: evidence.restorationCompleted(reportRoutes),
              },
              artifact_scan: artifactScan,
            },
            {
              revision,
              config_binding: routes.binding,
              alias_binding: proof.aliasRoleBinding(aliasRoles),
              now_ms: completedAt,
            },
          );
          proof.writeLiveProofReport(reportPath(process.env), report);
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
  }
}

export default function keeperCodexPool(pi: ExtensionAPI): void {
  try {
    installCodexPool(pi as unknown as PoolExtensionApi);
  } catch {
    // A companion failure never prevents Pi from starting.
  }
}

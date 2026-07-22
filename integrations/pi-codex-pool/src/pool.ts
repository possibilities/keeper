import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  boundedCodexPoolProofRecord,
  exactKeys,
} from "../../../src/codex-pool-proof-window.ts";
import {
  type CodexQuotaScope,
  codexQuotaScopeForModelId,
} from "../../../src/codex-quota-scope.ts";
import { type CredentialVault, PoolCredentialError } from "./auth.ts";
import type {
  PoolFailureClass,
  PoolFailureLogger,
  PoolRouteState,
} from "./state.ts";

export type CodexDelegate = (
  model: Model<"openai-codex-responses">,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export type CodexPoolProofFaultClass = Exclude<
  PoolFailureClass,
  "context" | "other"
>;
export type CodexPoolProofFaultPhase = "pre-output" | "mid-stream";

export interface CodexPoolProofFaultRequest {
  schema_version: 1;
  failure_class: CodexPoolProofFaultClass;
  phase: CodexPoolProofFaultPhase;
}

export type CodexPoolProofFaultOutcome =
  | {
      status: "injected";
      failure_class: CodexPoolProofFaultClass;
      phase: CodexPoolProofFaultPhase;
    }
  | {
      status: "inconclusive";
      failure_class: CodexPoolProofFaultClass;
      phase: "mid-stream";
      reason: "substantive-output-not-observed";
    }
  | {
      status: "inactive";
      failure_class: CodexPoolProofFaultClass;
      phase: "mid-stream";
      reason: "proof-seam-inactive";
    };

export class CodexPoolProofFaultError extends Error {
  readonly code = "proof-fault-request-invalid";

  constructor() {
    super("proof-fault-request-invalid");
    this.name = "CodexPoolProofFaultError";
  }
}

export interface CodexPoolProofFaultOptions {
  request: unknown;
  active(): boolean;
  onOutcome?(outcome: CodexPoolProofFaultOutcome): void;
}

export interface PoolStreamDependencies {
  vault: CredentialVault;
  routes: PoolRouteState;
  delegate: CodexDelegate;
  nativeDelegate: CodexDelegate;
  warn(reason: "pool-unavailable"): void;
  allowNativeFallback?: boolean;
  onNativeFallbackBlocked?(): void;
  /** Stable managed identity for provider calls, such as compaction, that omit one. */
  fallbackSessionId?: string;
  retryBackoffMs?: number;
  retryWait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  proofFault?: CodexPoolProofFaultOptions;
  /** Private, bounded sink for the real upstream text behind a sanitized failure code. */
  failureLog?: PoolFailureLogger;
}

class ForwardingEventStream implements AsyncIterable<AssistantMessageEvent> {
  private readonly queue: AssistantMessageEvent[] = [];
  private readonly waiters: Array<
    (value: IteratorResult<AssistantMessageEvent>) => void
  > = [];
  private ended = false;
  private readonly final: Promise<AssistantMessage>;
  private resolveFinal!: (message: AssistantMessage) => void;

  constructor() {
    this.final = new Promise((resolve) => {
      this.resolveFinal = resolve;
    });
  }

  push(event: AssistantMessageEvent): void {
    if (this.ended) return;
    if (event.type === "done") this.resolveFinal(event.message);
    if (event.type === "error") this.resolveFinal(event.error);
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  result(): Promise<AssistantMessage> {
    return this.final;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    while (true) {
      const queued = this.queue.shift();
      if (queued) {
        yield queued;
        continue;
      }
      if (this.ended) return;
      const next = await new Promise<IteratorResult<AssistantMessageEvent>>(
        (resolve) => this.waiters.push(resolve),
      );
      if (next.done) return;
      yield next.value;
    }
  }
}

function failureMessage(event: AssistantMessageEvent): string {
  if (event.type !== "error") return "";
  return event.error.errorMessage ?? "";
}

export function classifyPoolFailure(message: string): PoolFailureClass {
  if (/usage limit|quota|billing|out of budget|insufficient/i.test(message)) {
    return "quota";
  }
  if (/rate.?limit|too many requests|\b429\b|throttl/i.test(message)) {
    return "rate";
  }
  if (
    /context.?window|context.?length|prompt (?:is )?too long|input (?:is )?too long|maximum prompt length|reduce the length of (?:the )?messages|request_too_large|model_context_window_exceeded|token limit exceeded/i.test(
      message,
    )
  ) {
    return "context";
  }
  if (
    /unauthori[sz]ed|forbidden|invalid.?token|expired.?token|\b40[13]\b|not logged in|login expired|session expired|please run .* login|credentials? (?:are )?(?:invalid|expired|missing)/i.test(
      message,
    )
  ) {
    return "auth";
  }
  if (
    /network|fetch|socket|websocket|connection|timed? ?out|timeout|econn|dns|service unavailable|overload|upstream|internal server|server error|temporar(?:y|ily)|try again|request failed|response failed|something went wrong|error processing|\b50[0234]\b/i.test(
      message,
    ) ||
    /you can retry your request|try your request again|please retry your request/i.test(
      message,
    )
  ) {
    return "transport";
  }
  return "other";
}

function retryable(failureClass: PoolFailureClass): boolean {
  return ["quota", "rate", "auth", "transport", "other"].includes(failureClass);
}

function staleCodexContinuationFailure(message: string): boolean {
  return /previous response with id ['"][^'"\r\n]{1,256}['"] not found/i.test(
    message,
  );
}

function shouldRetrySameAlias(
  failureClass: PoolFailureClass,
  failureMessage: string,
  delegatedAttempts: number,
  routes: PoolRouteState,
  quotaScope: CodexQuotaScope,
  excluded: ReadonlySet<string>,
): boolean {
  if (delegatedAttempts >= 2) return false;
  if (staleCodexContinuationFailure(failureMessage)) return true;
  if (failureClass !== "transport") return false;
  try {
    return !routes.hasEligibleRoute(quotaScope, excluded);
  } catch {
    return false;
  }
}

function substantive(
  event: AssistantMessageEvent | { type?: unknown },
): boolean {
  if (
    event.type === "start" ||
    event.type === "done" ||
    event.type === "error"
  ) {
    return false;
  }
  return true;
}

function zeroUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function terminalMessage(
  model: Model<"openai-codex-responses">,
  reason: "error" | "aborted",
  code: string,
  source?: AssistantMessage,
): AssistantMessage {
  return {
    role: "assistant",
    content: source?.content ?? [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    ...(source?.responseModel === undefined
      ? {}
      : { responseModel: source.responseModel }),
    ...(source?.responseId === undefined
      ? {}
      : { responseId: source.responseId }),
    usage: source?.usage ?? zeroUsage(),
    stopReason: reason,
    errorMessage: code,
    timestamp: source?.timestamp ?? Date.now(),
  };
}

function sanitizedErrorEvent(
  model: Model<"openai-codex-responses">,
  reason: "error" | "aborted",
  failureClass: PoolFailureClass | "deadline",
  source?: AssistantMessage,
): AssistantMessageEvent {
  const code =
    reason === "aborted"
      ? "request-aborted"
      : failureClass === "deadline"
        ? "pool-deadline-exceeded"
        : failureClass === "context"
          ? "context_length_exceeded"
          : `pool-${failureClass}-failure`;
  return {
    type: "error",
    reason,
    error: terminalMessage(model, reason, code, source),
  };
}

function recordPoolFailure(
  deps: PoolStreamDependencies,
  context: { sessionId: string; alias: string; attempt: number },
  failureClass: PoolFailureClass,
  message: string,
): void {
  try {
    deps.failureLog?.record({
      sessionId: context.sessionId,
      alias: context.alias,
      attempt: context.attempt,
      failureClass,
      message,
    });
  } catch {
    // Diagnostics must never break the pool stream.
  }
}

function parseProofFaultRequest(input: unknown): CodexPoolProofFaultRequest {
  const request = boundedCodexPoolProofRecord(input);
  if (
    request === null ||
    !exactKeys(request, ["schema_version", "failure_class", "phase"]) ||
    request.schema_version !== 1 ||
    !["quota", "rate", "auth", "transport"].includes(
      String(request.failure_class),
    ) ||
    !["pre-output", "mid-stream"].includes(String(request.phase))
  ) {
    throw new CodexPoolProofFaultError();
  }
  return {
    schema_version: 1,
    failure_class: request.failure_class as CodexPoolProofFaultClass,
    phase: request.phase as CodexPoolProofFaultPhase,
  };
}

function proofFaultActive(options: CodexPoolProofFaultOptions): boolean {
  try {
    return options.active();
  } catch {
    return false;
  }
}

function reportProofFaultOutcome(
  options: CodexPoolProofFaultOptions,
  outcome: CodexPoolProofFaultOutcome,
): void {
  try {
    options.onOutcome?.(outcome);
  } catch {
    // Evidence collection cannot change provider-stream behavior.
  }
}

function proofFaultEvent(
  model: Model<"openai-codex-responses">,
  failureClass: CodexPoolProofFaultClass,
): Extract<AssistantMessageEvent, { type: "error" }> {
  const messages: Record<CodexPoolProofFaultClass, string> = {
    quota: "codex pool proof quota exceeded",
    rate: "codex pool proof rate limit",
    auth: "codex pool proof unauthorized",
    transport: "codex pool proof network timeout",
  };
  return {
    type: "error",
    reason: "error",
    error: terminalMessage(model, "error", messages[failureClass]),
  };
}

function createMidStreamProofFault(
  upstream: AssistantMessageEventStream,
  fault: AssistantMessageEvent & { type: "error" },
  request: CodexPoolProofFaultRequest,
  options: CodexPoolProofFaultOptions,
): AssistantMessageEventStream {
  let resolveFinal!: (message: AssistantMessage) => void;
  let rejectFinal!: (error: unknown) => void;
  let settled = false;
  const final = new Promise<AssistantMessage>((resolve, reject) => {
    resolveFinal = resolve;
    rejectFinal = reject;
  });
  void final.catch(() => {});
  const resolve = (message: AssistantMessage): void => {
    if (settled) return;
    settled = true;
    resolveFinal(message);
  };
  const reject = (error: unknown): void => {
    if (settled) return;
    settled = true;
    rejectFinal(error);
  };
  return {
    result: () => final,
    async *[Symbol.asyncIterator]() {
      let injected = false;
      let inactive = false;
      try {
        for await (const event of upstream) {
          if (event.type === "done") resolve(event.message);
          if (event.type === "error") resolve(event.error);
          yield event;
          if (!substantive(event) || injected || inactive) continue;
          if (!proofFaultActive(options)) {
            inactive = true;
            reportProofFaultOutcome(options, {
              status: "inactive",
              failure_class: request.failure_class,
              phase: "mid-stream",
              reason: "proof-seam-inactive",
            });
            continue;
          }
          injected = true;
          resolve(fault.error);
          reportProofFaultOutcome(options, {
            status: "injected",
            failure_class: request.failure_class,
            phase: request.phase,
          });
          yield fault;
          return;
        }
        if (!settled) void upstream.result().then(resolve, reject);
      } catch (error) {
        reject(error);
        throw error;
      } finally {
        if (!injected && !inactive) {
          reportProofFaultOutcome(options, {
            status: "inconclusive",
            failure_class: request.failure_class,
            phase: "mid-stream",
            reason: "substantive-output-not-observed",
          });
        }
      }
    },
  } as AssistantMessageEventStream;
}

export function createCodexPoolProofFaultDelegate(
  delegate: CodexDelegate,
  options: CodexPoolProofFaultOptions,
): CodexDelegate {
  if (!proofFaultActive(options)) return delegate;
  const request = parseProofFaultRequest(options.request);
  let consumed = false;
  return (model, context, streamOptions) => {
    if (consumed || !proofFaultActive(options)) {
      return delegate(model, context, streamOptions);
    }
    consumed = true;
    const fault = proofFaultEvent(model, request.failure_class);
    if (request.phase === "pre-output") {
      const output = new ForwardingEventStream();
      reportProofFaultOutcome(options, {
        status: "injected",
        failure_class: request.failure_class,
        phase: request.phase,
      });
      output.push(fault);
      output.end();
      return output as unknown as AssistantMessageEventStream;
    }
    const upstream = delegate(model, context, streamOptions);
    return createMidStreamProofFault(upstream, fault, request, options);
  };
}

function remainingTimeout(
  original: number | undefined,
  deadlineMs: number | undefined,
  now: () => number,
): number | undefined {
  if (deadlineMs === undefined) return original;
  const remaining = Math.floor(deadlineMs - now());
  return remaining > 0 ? remaining : undefined;
}

function deadlineBudgetExpired(
  deadlineMs: number | undefined,
  now: () => number,
): boolean {
  return (
    deadlineMs !== undefined &&
    remainingTimeout(undefined, deadlineMs, now) === undefined
  );
}

function boundedNativeOptions(
  options: SimpleStreamOptions | undefined,
  deadlineMs: number | undefined,
  now: () => number,
): SimpleStreamOptions | undefined | null {
  if (deadlineMs === undefined) return options;
  const timeoutMs = remainingTimeout(undefined, deadlineMs, now);
  if (timeoutMs === undefined) return null;
  return { ...options, timeoutMs };
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new Error("request-aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("request-aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function startNativeFallback(
  output: ForwardingEventStream,
  deps: PoolStreamDependencies,
  model: Model<"openai-codex-responses">,
  context: Context,
  options: SimpleStreamOptions | undefined,
): void {
  if (deps.allowNativeFallback === false) {
    deps.onNativeFallbackBlocked?.();
    output.push(sanitizedErrorEvent(model, "error", "other"));
    output.end();
    return;
  }
  deps.warn("pool-unavailable");
  void (async () => {
    try {
      const native = deps.nativeDelegate(model, context, options);
      for await (const event of native) output.push(event);
    } catch {
      output.push(sanitizedErrorEvent(model, "error", "other"));
    } finally {
      output.end();
    }
  })();
}

function startBoundedNativeFallback(
  output: ForwardingEventStream,
  deps: PoolStreamDependencies,
  model: Model<"openai-codex-responses">,
  context: Context,
  options: SimpleStreamOptions | undefined,
  deadlineMs: number | undefined,
  now: () => number,
): void {
  if (deps.allowNativeFallback === false) {
    startNativeFallback(output, deps, model, context, options);
    return;
  }
  const fallbackOptions = boundedNativeOptions(options, deadlineMs, now);
  if (fallbackOptions === null) {
    output.push(sanitizedErrorEvent(model, "error", "deadline"));
    output.end();
    return;
  }
  startNativeFallback(output, deps, model, context, fallbackOptions);
}

export function createPooledCodexStream(
  deps: PoolStreamDependencies,
  model: Model<"openai-codex-responses">,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const delegate =
    deps.proofFault === undefined
      ? deps.delegate
      : createCodexPoolProofFaultDelegate(deps.delegate, deps.proofFault);
  const output = new ForwardingEventStream();
  const now = deps.now ?? Date.now;
  const quotaScope = codexQuotaScopeForModelId(model.id);
  const sessionId = options?.sessionId ?? deps.fallbackSessionId;
  if (!sessionId || deps.routes.aliases.length === 0) {
    startNativeFallback(output, deps, model, context, options);
    return output as unknown as AssistantMessageEventStream;
  }
  const timeoutMs = options?.timeoutMs;
  const deadlineMs =
    timeoutMs !== undefined && timeoutMs > 0 ? now() + timeoutMs : undefined;

  void (async () => {
    const excluded = new Set<string>();
    let delegatedAttempts = 0;
    let retryAlias: string | undefined;
    let lastFailure: PoolFailureClass = "other";
    let lastErrorMessage: AssistantMessage | undefined;
    let lastAlias: string | undefined;

    while (delegatedAttempts < 2) {
      if (options?.signal?.aborted) {
        output.push(
          sanitizedErrorEvent(model, "aborted", lastFailure, lastErrorMessage),
        );
        output.end();
        return;
      }
      if (deadlineBudgetExpired(deadlineMs, now)) {
        output.push(
          sanitizedErrorEvent(model, "error", "deadline", lastErrorMessage),
        );
        output.end();
        return;
      }

      let alias: string;
      try {
        alias =
          retryAlias ?? deps.routes.select(sessionId, quotaScope, excluded);
        retryAlias = undefined;
        lastAlias = alias;
      } catch {
        if (delegatedAttempts === 0) {
          startBoundedNativeFallback(
            output,
            deps,
            model,
            context,
            options,
            deadlineMs,
            now,
          );
          return;
        }
        recordPoolFailure(
          deps,
          {
            sessionId,
            alias: lastAlias ?? "",
            attempt: delegatedAttempts,
          },
          lastFailure,
          lastErrorMessage?.errorMessage ?? "",
        );
        output.push(
          sanitizedErrorEvent(model, "error", lastFailure, lastErrorMessage),
        );
        output.end();
        return;
      }

      if (deadlineBudgetExpired(deadlineMs, now)) {
        deps.routes.releaseSelection(sessionId, alias, quotaScope);
        output.push(
          sanitizedErrorEvent(model, "error", "deadline", lastErrorMessage),
        );
        output.end();
        return;
      }

      let apiKey: string;
      try {
        const credential = await deps.vault.resolve(alias, {
          signal: options?.signal,
          ...(deadlineMs === undefined ? {} : { deadlineMs }),
        });
        apiKey = credential.access;
      } catch (error) {
        if (options?.signal?.aborted) {
          deps.routes.releaseSelection(sessionId, alias, quotaScope);
          output.push(sanitizedErrorEvent(model, "aborted", "auth"));
          output.end();
          return;
        }
        if (
          deadlineMs !== undefined &&
          (deadlineBudgetExpired(deadlineMs, now) ||
            (error instanceof PoolCredentialError &&
              error.code === "credential-aborted"))
        ) {
          deps.routes.releaseSelection(sessionId, alias, quotaScope);
          output.push(sanitizedErrorEvent(model, "error", "deadline"));
          output.end();
          return;
        }
        deps.routes.recordFailure(sessionId, alias, "auth", quotaScope);
        excluded.add(alias);
        lastFailure = "auth";
        if (excluded.size < deps.routes.aliases.length) continue;
        if (delegatedAttempts === 0) {
          startBoundedNativeFallback(
            output,
            deps,
            model,
            context,
            options,
            deadlineMs,
            now,
          );
          return;
        }
        recordPoolFailure(
          deps,
          { sessionId, alias, attempt: delegatedAttempts + 1 },
          "auth",
          error instanceof Error ? error.message : String(error),
        );
        output.push(sanitizedErrorEvent(model, "error", "auth"));
        output.end();
        return;
      }

      if (options?.signal?.aborted) {
        deps.routes.releaseSelection(sessionId, alias, quotaScope);
        output.push(
          sanitizedErrorEvent(model, "aborted", lastFailure, lastErrorMessage),
        );
        output.end();
        return;
      }
      const attemptTimeoutMs = remainingTimeout(timeoutMs, deadlineMs, now);
      if (deadlineMs !== undefined && attemptTimeoutMs === undefined) {
        deps.routes.releaseSelection(sessionId, alias, quotaScope);
        output.push(sanitizedErrorEvent(model, "error", "deadline"));
        output.end();
        return;
      }
      delegatedAttempts += 1;
      const attemptOptions: SimpleStreamOptions = {
        ...options,
        ...(options?.sessionId === undefined ? { sessionId } : {}),
        apiKey,
        maxRetries: 0,
        timeoutMs: attemptTimeoutMs,
      };
      let bufferedStart: AssistantMessageEvent | undefined;
      let exposedSubstantive = false;
      let terminal = false;
      try {
        const upstream = delegate(model, context, attemptOptions);
        for await (const rawEvent of upstream as AsyncIterable<AssistantMessageEvent>) {
          const event = rawEvent as AssistantMessageEvent & { type: string };
          if (event.type === "start") {
            bufferedStart ??= event;
            continue;
          }
          if (substantive(event)) {
            if (bufferedStart) {
              output.push(bufferedStart);
              bufferedStart = undefined;
            }
            exposedSubstantive = true;
            output.push(event);
            continue;
          }
          if (event.type === "done") {
            if (bufferedStart) output.push(bufferedStart);
            output.push(event);
            deps.routes.recordSuccess(sessionId, alias, quotaScope);
            terminal = true;
            break;
          }
          if (event.type === "error") {
            const reason = event.reason === "aborted" ? "aborted" : "error";
            const upstreamFailureMessage = failureMessage(event);
            const failureClass = classifyPoolFailure(upstreamFailureMessage);
            lastFailure = failureClass;
            lastErrorMessage = event.error;
            if (reason === "aborted" || options?.signal?.aborted) {
              if (bufferedStart) output.push(bufferedStart);
              output.push(
                sanitizedErrorEvent(
                  model,
                  "aborted",
                  failureClass,
                  event.error,
                ),
              );
              deps.routes.recordFailure(
                sessionId,
                alias,
                failureClass,
                quotaScope,
              );
              terminal = true;
              break;
            }
            if (!exposedSubstantive && retryable(failureClass)) {
              deps.routes.recordFailure(
                sessionId,
                alias,
                failureClass,
                quotaScope,
              );
              excluded.add(alias);
              if (
                shouldRetrySameAlias(
                  failureClass,
                  upstreamFailureMessage,
                  delegatedAttempts,
                  deps.routes,
                  quotaScope,
                  excluded,
                )
              ) {
                retryAlias = alias;
              }
              break;
            }
            if (bufferedStart) output.push(bufferedStart);
            recordPoolFailure(
              deps,
              { sessionId, alias, attempt: delegatedAttempts },
              failureClass,
              upstreamFailureMessage,
            );
            output.push(
              sanitizedErrorEvent(model, "error", failureClass, event.error),
            );
            deps.routes.recordFailure(
              sessionId,
              alias,
              failureClass,
              quotaScope,
            );
            terminal = true;
            break;
          }
        }
        if (!terminal && !excluded.has(alias)) {
          lastFailure = "transport";
          deps.routes.recordFailure(sessionId, alias, lastFailure, quotaScope);
          excluded.add(alias);
          if (
            !exposedSubstantive &&
            shouldRetrySameAlias(
              lastFailure,
              "",
              delegatedAttempts,
              deps.routes,
              quotaScope,
              excluded,
            )
          ) {
            retryAlias = alias;
          }
          if (exposedSubstantive) {
            recordPoolFailure(
              deps,
              { sessionId, alias, attempt: delegatedAttempts },
              lastFailure,
              "stream ended without a terminal event",
            );
            output.push(sanitizedErrorEvent(model, "error", lastFailure));
            terminal = true;
          }
        }
      } catch (error) {
        const caughtMessage = error instanceof Error ? error.message : "";
        const failureClass = classifyPoolFailure(caughtMessage);
        lastFailure = failureClass;
        deps.routes.recordFailure(sessionId, alias, failureClass, quotaScope);
        excluded.add(alias);
        if (
          !exposedSubstantive &&
          shouldRetrySameAlias(
            failureClass,
            caughtMessage,
            delegatedAttempts,
            deps.routes,
            quotaScope,
            excluded,
          )
        ) {
          retryAlias = alias;
        }
        if (options?.signal?.aborted) {
          output.push(sanitizedErrorEvent(model, "aborted", failureClass));
          terminal = true;
        } else if (exposedSubstantive || !retryable(failureClass)) {
          recordPoolFailure(
            deps,
            { sessionId, alias, attempt: delegatedAttempts },
            failureClass,
            error instanceof Error ? error.message : String(error),
          );
          output.push(sanitizedErrorEvent(model, "error", failureClass));
          terminal = true;
        }
      }

      if (terminal) {
        output.end();
        return;
      }
      if (
        delegatedAttempts >= 2 ||
        (retryAlias === undefined &&
          excluded.size >= deps.routes.aliases.length)
      ) {
        recordPoolFailure(
          deps,
          { sessionId, alias, attempt: delegatedAttempts },
          lastFailure,
          lastErrorMessage?.errorMessage ?? "",
        );
        output.push(
          sanitizedErrorEvent(model, "error", lastFailure, lastErrorMessage),
        );
        output.end();
        return;
      }
      if (deadlineBudgetExpired(deadlineMs, now)) {
        output.push(
          sanitizedErrorEvent(model, "error", "deadline", lastErrorMessage),
        );
        output.end();
        return;
      }
      const retryBackoffMs = deps.retryBackoffMs ?? 0;
      const retryWaitMs =
        deadlineMs === undefined
          ? retryBackoffMs
          : Math.min(
              retryBackoffMs,
              remainingTimeout(undefined, deadlineMs, now) ?? 0,
            );
      try {
        await (deps.retryWait ?? waitForRetry)(retryWaitMs, options?.signal);
      } catch {
        output.push(
          sanitizedErrorEvent(model, "aborted", lastFailure, lastErrorMessage),
        );
        output.end();
        return;
      }
      if (options?.signal?.aborted) {
        output.push(
          sanitizedErrorEvent(model, "aborted", lastFailure, lastErrorMessage),
        );
        output.end();
        return;
      }
      if (deadlineBudgetExpired(deadlineMs, now)) {
        output.push(
          sanitizedErrorEvent(model, "error", "deadline", lastErrorMessage),
        );
        output.end();
        return;
      }
    }
    output.push(
      sanitizedErrorEvent(model, "error", lastFailure, lastErrorMessage),
    );
    output.end();
  })().catch(() => {
    output.push(sanitizedErrorEvent(model, "error", "other"));
    output.end();
  });

  return output as unknown as AssistantMessageEventStream;
}

import { randomUUID } from "node:crypto";

export interface PiTaskParams {
  subagent_type: string;
  description: string;
  prompt: string;
}

export interface PiTaskEventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

export interface PiTaskToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

export interface PiTaskToolDefinition {
  name: "Task";
  label: string;
  description: string;
  executionMode: "parallel";
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: PiTaskParams,
    signal?: AbortSignal,
  ): Promise<PiTaskToolResult>;
}

/** The minimal Pi extension surface needed to expose the Task facade. */
export interface PiTaskExtensionApi {
  events?: PiTaskEventBus;
  registerTool?(tool: PiTaskToolDefinition): void;
}

interface RpcSuccess {
  success: true;
  data?: unknown;
}

interface RpcFailure {
  success: false;
  error?: unknown;
}

type RpcEnvelope = RpcSuccess | RpcFailure;

interface TerminalEvent {
  id: string;
  type?: string;
  description?: string;
  result?: string;
  error?: string;
  status?: string;
  toolUses?: number;
  durationMs?: number;
  tokens?: unknown;
}

const RPC_VERSION = 3;
const RPC_TIMEOUT_MS = 2_000;
// The owner finalizer has its own five-second bound. Leave enough transport
// headroom for it to report either terminal cleanup or exact failures.
const STOP_RPC_TIMEOUT_MS = 7_000;
const PACKAGE_NAME = "@tintinweb/pi-subagents@0.14.0";

const TASK_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    subagent_type: {
      type: "string",
      description: "Named subagent type, such as plan:repo-scout.",
    },
    description: {
      type: "string",
      description: "Short task description shown in the subagent UI.",
    },
    prompt: {
      type: "string",
      description: "Complete prompt for the subagent.",
    },
  },
  required: ["subagent_type", "description", "prompt"],
  additionalProperties: false,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cancellationReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("Task cancelled");
  error.name = "AbortError";
  return error;
}

function cancellationReasonText(signal: AbortSignal): string {
  const reason = cancellationReason(signal);
  return reason instanceof Error ? reason.message : String(reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseRpcEnvelope(value: unknown, operation: string): RpcEnvelope {
  if (!isRecord(value) || typeof value.success !== "boolean") {
    throw new Error(`${operation} returned a malformed RPC envelope`);
  }
  if (value.success === false) {
    const message =
      typeof value.error === "string" ? value.error : "unknown RPC failure";
    return { success: false, error: message };
  }
  return { success: true, data: value.data };
}

function parseTerminalEvent(value: unknown): TerminalEvent | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    type: typeof value.type === "string" ? value.type : undefined,
    description:
      typeof value.description === "string" ? value.description : undefined,
    result: typeof value.result === "string" ? value.result : undefined,
    error: typeof value.error === "string" ? value.error : undefined,
    status: typeof value.status === "string" ? value.status : undefined,
    toolUses: typeof value.toolUses === "number" ? value.toolUses : undefined,
    durationMs:
      typeof value.durationMs === "number" ? value.durationMs : undefined,
    tokens: value.tokens,
  };
}

function rpcCall(
  events: PiTaskEventBus,
  channel: string,
  payload: Record<string, unknown>,
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<RpcEnvelope> {
  const requestId = randomUUID();
  const replyChannel = `${channel}:reply:${requestId}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `${PACKAGE_NAME} did not answer ${channel} within ${timeoutMs}ms`,
          ),
        ),
      );
    }, timeoutMs);

    try {
      unsubscribe = events.on(replyChannel, (raw) => {
        finish(() => {
          try {
            resolve(parseRpcEnvelope(raw, channel));
          } catch (error) {
            reject(error);
          }
        });
      });
      events.emit(channel, { ...payload, requestId });
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

async function requireProtocol(events: PiTaskEventBus): Promise<void> {
  const reply = await rpcCall(events, "subagents:rpc:ping", {});
  if (!reply.success) {
    throw new Error(`${PACKAGE_NAME} ping failed: ${String(reply.error)}`);
  }
  if (!isRecord(reply.data) || reply.data.version !== RPC_VERSION) {
    const observed = isRecord(reply.data) ? reply.data.version : undefined;
    throw new Error(
      `${PACKAGE_NAME} RPC protocol mismatch: expected ${RPC_VERSION}, got ${String(observed ?? "missing")}`,
    );
  }
}

function validateParams(params: PiTaskParams): void {
  for (const key of ["subagent_type", "description", "prompt"] as const) {
    if (typeof params[key] !== "string" || params[key].trim() === "") {
      throw new Error(`Task requires a non-empty ${key}`);
    }
  }
}

function beforeSpawnOrAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) return Promise.reject(cancellationReason(signal));
  let removeAbort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(cancellationReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", onAbort);
  });
  return Promise.race([operation, cancelled]).finally(removeAbort);
}

async function executeTask(
  events: PiTaskEventBus,
  params: PiTaskParams,
  signal?: AbortSignal,
): Promise<PiTaskToolResult> {
  validateParams(params);
  if (signal?.aborted) throw cancellationReason(signal);
  await beforeSpawnOrAbort(requireProtocol(events), signal);
  if (signal?.aborted) throw cancellationReason(signal);

  let agentId: string | null = null;
  let ownerHandle: string | null = null;
  let resolveTerminal: (event: TerminalEvent) => void = () => {};
  const buffered = new Map<string, TerminalEvent>();
  const terminal = new Promise<TerminalEvent>((resolve) => {
    resolveTerminal = resolve;
  });

  const onTerminal = (raw: unknown): void => {
    const event = parseTerminalEvent(raw);
    if (event === null) return;
    if (agentId === event.id) {
      resolveTerminal(event);
    } else if (agentId === null) {
      buffered.set(event.id, event);
    }
  };
  const unsubscribeCompleted = events.on("subagents:completed", onTerminal);
  const unsubscribeFailed = events.on("subagents:failed", onTerminal);

  const cleanup = (): void => {
    unsubscribeCompleted();
    unsubscribeFailed();
  };

  let stopPromise: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    if (stopPromise !== null) return stopPromise;
    if (ownerHandle === null || signal === undefined) {
      return Promise.reject(
        new Error(
          `${PACKAGE_NAME} cannot cancel Task without its ownership scope`,
        ),
      );
    }
    stopPromise = (async () => {
      const reply = await rpcCall(
        events,
        "subagents:rpc:stop",
        {
          version: RPC_VERSION,
          handle: ownerHandle,
          reason: cancellationReasonText(signal),
        },
        STOP_RPC_TIMEOUT_MS,
      );
      if (!reply.success) {
        throw new Error(
          `${PACKAGE_NAME} scoped cancellation failed: ${String(reply.error)}`,
        );
      }
      if (
        !isRecord(reply.data) ||
        typeof reply.data.settled !== "boolean" ||
        !Array.isArray(reply.data.failures) ||
        !reply.data.failures.every((failure) => typeof failure === "string")
      ) {
        throw new Error(
          `${PACKAGE_NAME} scoped cancellation returned a malformed acknowledgement`,
        );
      }
      if (!reply.data.settled || reply.data.failures.length > 0) {
        const failures =
          reply.data.failures.join("; ") || "cleanup did not settle";
        throw new Error(
          `${PACKAGE_NAME} scoped cancellation did not settle: ${failures}`,
        );
      }
    })();
    return stopPromise;
  };

  try {
    const spawn = await rpcCall(events, "subagents:rpc:spawn", {
      version: RPC_VERSION,
      type: params.subagent_type,
      prompt: params.prompt,
      options: {
        description: params.description,
        isBackground: false,
        ...(signal === undefined ? {} : { signal }),
      },
    });
    if (!spawn.success) {
      throw new Error(`${PACKAGE_NAME} spawn failed: ${String(spawn.error)}`);
    }
    if (
      !isRecord(spawn.data) ||
      typeof spawn.data.id !== "string" ||
      spawn.data.id.length === 0 ||
      typeof spawn.data.handle !== "string" ||
      spawn.data.handle.length === 0
    ) {
      throw new Error(`${PACKAGE_NAME} spawn returned no owned agent scope`);
    }
    agentId = spawn.data.id;
    ownerHandle = spawn.data.handle;
    const early = buffered.get(agentId);
    if (early !== undefined) resolveTerminal(early);

    if (signal?.aborted) {
      await stop();
      throw cancellationReason(signal);
    }

    let removeAbort = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      if (signal === undefined) return;
      const onAbort = (): void => {
        void stop().then(() => reject(cancellationReason(signal)), reject);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", onAbort);
    });

    try {
      const event = await Promise.race([terminal, cancelled]);
      // An abort owns the outcome once observed. A terminal event racing ahead
      // of the acknowledged recursive stop must never leak a late success.
      if (signal?.aborted) {
        await stop();
        throw cancellationReason(signal);
      }
      if (
        event.status === "error" ||
        event.status === "stopped" ||
        event.status === "aborted" ||
        event.error
      ) {
        throw new Error(
          `Task ${params.subagent_type} failed: ${event.error ?? event.status ?? "unknown failure"}`,
        );
      }
      // A completed subagent with no textual result is a protocol violation,
      // not an answer: the provider errored or the turn ended textless and the
      // subagent runner misreported it as success. Fail loudly so the caller
      // sees a Task error instead of silently consuming "No output".
      const resultText = typeof event.result === "string" ? event.result : "";
      if (resultText.trim() === "") {
        throw new Error(
          `Task ${params.subagent_type} completed without a textual result (empty subagent answer)`,
        );
      }
      return {
        content: [{ type: "text", text: resultText }],
        details: {
          agent_id: event.id,
          subagent_type: event.type ?? params.subagent_type,
          status: event.status ?? "completed",
          duration_ms: event.durationMs ?? null,
          tool_uses: event.toolUses ?? null,
          tokens: event.tokens ?? null,
          rpc_protocol: RPC_VERSION,
        },
      };
    } finally {
      removeAbort();
    }
  } finally {
    cleanup();
  }
}

export function createTaskFacadeTool(
  events: PiTaskEventBus,
): PiTaskToolDefinition {
  return {
    name: "Task",
    label: "Task",
    description:
      "Run a named Pi subagent in an isolated foreground session and return only its final result. Multiple Task calls in one assistant message run concurrently.",
    executionMode: "parallel",
    parameters: TASK_PARAMETERS,
    async execute(_toolCallId, params, signal) {
      try {
        return await executeTask(events, params, signal);
      } catch (error) {
        // Pi passes the caller's AbortSignal through the tool boundary. Keep
        // its native reason object and AbortError typing instead of converting
        // cancellation into an ordinary Task failure.
        if (
          signal?.aborted &&
          (error === signal.reason ||
            (error instanceof Error && error.name === "AbortError"))
        ) {
          throw error;
        }
        throw new Error(`Task facade: ${errorMessage(error)}`);
      }
    },
  };
}

/**
 * Minimal Pi extension entry point for a nested AgentSession that needs Task.
 * It deliberately owns no lifecycle, title, telemetry, bus, or status surface;
 * those remain scoped to the tracked top-level session extension.
 */
export default function taskFacadeExtension(pi: PiTaskExtensionApi): void {
  try {
    if ((process.env.KEEPER_JOB_ID ?? "").trim() === "") return;
    if (pi.events === undefined || typeof pi.registerTool !== "function")
      return;
    pi.registerTool(createTaskFacadeTool(pi.events));
  } catch {
    // A Task-facade load failure must never prevent the child session starting.
  }
}

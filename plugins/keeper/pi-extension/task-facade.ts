import { execFile } from "node:child_process";
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
const PROMPT_COMPILE_TIMEOUT_MS = 15_000;
const PROMPT_COMPILE_MAX_BUFFER = 64 * 1024;
const PACKAGE_NAME = "@tintinweb/pi-subagents@0.14.0";

export interface RpcDeadline {
  schedule(callback: () => void, timeoutMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface PromptCompilerExecOptions {
  readonly encoding: "utf8";
  readonly env: NodeJS.ProcessEnv;
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly shell: false;
  readonly signal?: AbortSignal;
}

export interface PromptCompilerExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type PromptCompilerRunner = (
  executable: string,
  args: readonly string[],
  options: PromptCompilerExecOptions,
) => Promise<PromptCompilerExecResult>;

export interface TaskFacadeOptions {
  rpcTimeoutMs?: number;
  stopRpcTimeoutMs?: number;
  deadline?: RpcDeadline;
  compilerRunner?: PromptCompilerRunner;
}

interface ResolvedTaskFacadeOptions {
  rpcTimeoutMs: number;
  stopRpcTimeoutMs: number;
  deadline: RpcDeadline;
  compilerRunner: PromptCompilerRunner;
}

const systemDeadline: RpcDeadline = {
  schedule: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const systemCompilerRunner: PromptCompilerRunner = (
  executable,
  args,
  options,
) =>
  new Promise((resolve, reject) => {
    try {
      execFile(executable, [...args], options, (error, stdout, stderr) => {
        if (error !== null) {
          if (options.signal?.aborted) {
            reject(cancellationReason(options.signal));
            return;
          }
          const detail = stderr.trim();
          reject(
            new Error(
              `keeper prompt compile failed: ${detail || error.message}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      });
    } catch (error) {
      reject(error);
    }
  });

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
  deadline: RpcDeadline = systemDeadline,
): Promise<RpcEnvelope> {
  const requestId = randomUUID();
  const replyChannel = `${channel}:reply:${requestId}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    let timer: unknown;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      deadline.cancel(timer);
      unsubscribe();
      fn();
    };
    timer = deadline.schedule(() => {
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

async function requireProtocol(
  events: PiTaskEventBus,
  options: ResolvedTaskFacadeOptions,
): Promise<void> {
  const reply = await rpcCall(
    events,
    "subagents:rpc:ping",
    {},
    options.rpcTimeoutMs,
    options.deadline,
  );
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

const PLAN_ROLE_RE = /^plan:[a-z0-9][a-z0-9._-]*$/;
const LAUNCH_MODEL_SEGMENT_RE = /^[a-z0-9._-]+$/;
const THINKING_MAX_TURNS = {
  low: 25,
  medium: 40,
  high: 60,
  xhigh: 75,
} as const;

type PiThinkingLevel = keyof typeof THINKING_MAX_TURNS;

interface CompiledLaunchOptions {
  model: string;
  thinkingLevel: PiThinkingLevel;
  maxTurns: number;
}

function isLaunchModel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value
      .split("/")
      .every(
        (segment) =>
          LAUNCH_MODEL_SEGMENT_RE.test(segment) && !segment.startsWith("."),
      )
  );
}

function isThinkingLevel(value: unknown): value is PiThinkingLevel {
  return (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

function isCanonicalPlanRole(type: string): boolean {
  if (!type.startsWith("plan:")) return false;
  if (!PLAN_ROLE_RE.test(type)) {
    throw new Error(
      "Task plan subagent_type must be a fully-qualified plan:name token",
    );
  }
  return true;
}

function parseCompiledLaunch(
  stdout: string,
  role: string,
): CompiledLaunchOptions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      `keeper prompt compile for ${role} returned malformed or multi-document JSON`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`keeper prompt compile for ${role} returned a non-object`);
  }
  if (parsed.ok === false) {
    throw new Error(`keeper prompt compile for ${role} reported ok:false`);
  }
  if (
    parsed.schema_version !== 1 ||
    parsed.target !== "pi" ||
    parsed.ok !== true ||
    (parsed.outcome !== "hit" &&
      parsed.outcome !== "compiled" &&
      parsed.outcome !== "repaired") ||
    !isRecord(parsed.request) ||
    parsed.request.kind !== "role" ||
    parsed.request.name !== role ||
    !Array.isArray(parsed.outputs)
  ) {
    throw new Error(
      `keeper prompt compile for ${role} returned a malformed result envelope`,
    );
  }

  const outputs: Record<string, unknown>[] = [];
  for (const output of parsed.outputs) {
    if (!isRecord(output) || typeof output.role !== "string") {
      throw new Error(
        `keeper prompt compile for ${role} returned a malformed output row`,
      );
    }
    if (output.role === role) outputs.push(output);
  }
  if (outputs.length !== 1) {
    throw new Error(
      `keeper prompt compile for ${role} returned ${outputs.length} matching output rows`,
    );
  }

  const output = outputs[0] as Record<string, unknown>;
  if (!isRecord(output.launch_cell) || output.launch_cell.provider !== "pi") {
    throw new Error(
      `keeper prompt compile for ${role} returned an invalid launch cell`,
    );
  }
  const model = output.launch_cell.model;
  if (!isLaunchModel(model)) {
    throw new Error(
      `keeper prompt compile for ${role} returned an invalid launch model`,
    );
  }
  const effort = output.launch_cell.effort;
  const expectedThinking = effort === "max" ? "xhigh" : effort;
  if (
    !isThinkingLevel(output.thinking) ||
    output.thinking !== expectedThinking
  ) {
    throw new Error(
      `keeper prompt compile for ${role} returned invalid Pi thinking`,
    );
  }
  if (
    !Number.isInteger(output.max_turns) ||
    output.max_turns !== THINKING_MAX_TURNS[output.thinking]
  ) {
    throw new Error(
      `keeper prompt compile for ${role} returned invalid Pi max_turns`,
    );
  }
  return {
    model,
    thinkingLevel: output.thinking,
    maxTurns: output.max_turns as number,
  };
}

async function compilePlanRole(
  role: string,
  signal: AbortSignal | undefined,
  runner: PromptCompilerRunner,
): Promise<CompiledLaunchOptions | null> {
  if (!isCanonicalPlanRole(role)) return null;
  const args = ["prompt", "compile", "--role", role, "--target", "pi"];
  const result = await runner("keeper", args, {
    encoding: "utf8",
    env: process.env,
    timeout: PROMPT_COMPILE_TIMEOUT_MS,
    maxBuffer: PROMPT_COMPILE_MAX_BUFFER,
    shell: false,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!isRecord(result) || typeof result.stdout !== "string") {
    throw new Error(`keeper prompt compile for ${role} returned no stdout`);
  }
  return parseCompiledLaunch(result.stdout, role);
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
  signal: AbortSignal | undefined,
  options: ResolvedTaskFacadeOptions,
): Promise<PiTaskToolResult> {
  validateParams(params);
  if (signal?.aborted) throw cancellationReason(signal);
  await beforeSpawnOrAbort(requireProtocol(events, options), signal);
  if (signal?.aborted) throw cancellationReason(signal);
  const compiledLaunch = await beforeSpawnOrAbort(
    compilePlanRole(params.subagent_type, signal, options.compilerRunner),
    signal,
  );
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
        options.stopRpcTimeoutMs,
        options.deadline,
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
    const spawn = await rpcCall(
      events,
      "subagents:rpc:spawn",
      {
        version: RPC_VERSION,
        type: params.subagent_type,
        prompt: params.prompt,
        options: {
          description: params.description,
          isBackground: false,
          ...(compiledLaunch ?? {}),
          ...(signal === undefined ? {} : { signal }),
        },
      },
      options.rpcTimeoutMs,
      options.deadline,
    );
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
  overrides: TaskFacadeOptions = {},
): PiTaskToolDefinition {
  const options: ResolvedTaskFacadeOptions = {
    rpcTimeoutMs: overrides.rpcTimeoutMs ?? RPC_TIMEOUT_MS,
    stopRpcTimeoutMs: overrides.stopRpcTimeoutMs ?? STOP_RPC_TIMEOUT_MS,
    deadline: overrides.deadline ?? systemDeadline,
    compilerRunner: overrides.compilerRunner ?? systemCompilerRunner,
  };
  return {
    name: "Task",
    label: "Task",
    description:
      "Run a named Pi subagent in an isolated foreground session and return only its final result. Multiple Task calls in one assistant message run concurrently.",
    executionMode: "parallel",
    parameters: TASK_PARAMETERS,
    async execute(_toolCallId, params, signal) {
      try {
        return await executeTask(events, params, signal, options);
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

import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

export const MONITOR_DEFAULT_TIMEOUT_MS = 300_000;
export const MONITOR_MIN_TIMEOUT_MS = 1_000;
export const MONITOR_MAX_TIMEOUT_MS = 3_600_000;
export const MONITOR_BATCH_WINDOW_MS = 200;
export const MONITOR_MAX_LINE_CHARS = 8_192;
export const MONITOR_MAX_QUEUED_LINES = 128;
export const MONITOR_SUPPRESSION_BUDGET = 1_024;

const TERM_GRACE_MS = 500;
const KILL_GRACE_MS = 100;

export interface PiMonitorParams {
  command: string;
  description: string;
  persistent?: boolean;
  timeout_ms?: number;
}

export interface ResolvedPiMonitorParams {
  command: string;
  description: string;
  persistent: boolean;
  timeout_ms: number;
}

export interface MonitorTaskSnapshot {
  id: string;
  type: "shell";
  kind: "monitor";
  command: string;
  description: string;
}

export interface MonitorLineBatch {
  taskId: string;
  description: string;
  lines: readonly string[];
}

export type MonitorTerminalStatus =
  | "exited"
  | "spawn_failed"
  | "timed_out"
  | "stopped"
  | "shutdown"
  | "flood"
  | "artifact_failed";

export interface MonitorTerminalOutcome {
  taskId: string;
  description: string;
  status: MonitorTerminalStatus;
  artifactPath: string | null;
  exitCode: number | null;
  signal: string | null;
  error?: string;
  suppressedLines: number;
}

export interface MonitorReadable {
  on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown;
  off?(event: "data", listener: (chunk: Uint8Array | string) => void): unknown;
  removeListener?(
    event: "data",
    listener: (chunk: Uint8Array | string) => void,
  ): unknown;
}

export interface MonitorChild {
  pid?: number;
  exitCode?: number | null;
  stdout: MonitorReadable | null;
  stderr: MonitorReadable | null;
  once(
    event: "close" | "exit" | "error",
    listener: (...args: unknown[]) => void,
  ): unknown;
  off?(
    event: "close" | "exit" | "error",
    listener: (...args: unknown[]) => void,
  ): unknown;
  removeListener?(
    event: "close" | "exit" | "error",
    listener: (...args: unknown[]) => void,
  ): unknown;
  kill?(signal?: NodeJS.Signals): boolean;
}

export interface MonitorSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: "/bin/bash";
  detached: true;
  stdio: readonly ["ignore", "pipe", "pipe"];
}

export type SpawnMonitor = (
  command: string,
  options: MonitorSpawnOptions,
) => MonitorChild;

export interface MonitorArtifact {
  readonly path: string;
  write(stream: "stdout" | "stderr", chunk: Uint8Array): void;
  close(): void;
}

export type CreateMonitorArtifact = (taskId: string) => MonitorArtifact;

export interface MonitorClock {
  setTimer(callback: () => void, timeoutMs: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface PiMonitorControllerOptions {
  deliverBatch(batch: MonitorLineBatch): void;
  deliverTerminal(outcome: MonitorTerminalOutcome): void;
  spawn?: SpawnMonitor;
  clock?: MonitorClock;
  allocateTaskId?: () => string;
  createArtifact?: CreateMonitorArtifact;
  killTree?: (child: MonitorChild, signal: NodeJS.Signals) => void;
  defer?: (callback: () => void) => void;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  batchWindowMs?: number;
  maxLineChars?: number;
  maxQueuedLines?: number;
  suppressionBudget?: number;
  termGraceMs?: number;
  killGraceMs?: number;
}

export interface PiMonitorToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: { taskId: string };
}

export interface PiMonitorToolDefinition {
  name: "Monitor";
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: PiMonitorParams,
    signal?: AbortSignal,
  ): Promise<PiMonitorToolResult>;
}

interface ActiveMonitor {
  readonly generation: number;
  readonly id: string;
  readonly params: ResolvedPiMonitorParams;
  readonly child: MonitorChild;
  readonly artifact: MonitorArtifact;
  readonly decoder: StringDecoder;
  buffer: string;
  discardingLine: boolean;
  queue: string[];
  suppressedLines: number;
  batchTimer: unknown | null;
  timeoutTimer: unknown | null;
  terminal: MonitorTerminalStatus | null;
  terminalPromise: Promise<void> | null;
  deliveryReady: boolean;
  pendingDeliveries: Array<() => void>;
  stdoutListener: (chunk: Uint8Array | string) => void;
  stderrListener: (chunk: Uint8Array | string) => void;
  closeListener: (...args: unknown[]) => void;
  exitListener: (...args: unknown[]) => void;
  errorListener: (...args: unknown[]) => void;
}

const systemClock: MonitorClock = {
  setTimer: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const MONITOR_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description: "Shell command to run and monitor.",
    },
    description: {
      type: "string",
      description: "Short description of the monitored command.",
    },
    persistent: {
      type: "boolean",
      default: false,
      description: "Keep watching until explicitly stopped.",
    },
    timeout_ms: {
      type: "integer",
      minimum: MONITOR_MIN_TIMEOUT_MS,
      maximum: MONITOR_MAX_TIMEOUT_MS,
      default: MONITOR_DEFAULT_TIMEOUT_MS,
      description: "Deadline in milliseconds, ignored for persistent watches.",
    },
  },
  required: ["command", "description"],
  additionalProperties: false,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveMonitorParams(value: unknown): ResolvedPiMonitorParams {
  if (!isRecord(value)) throw new Error("Monitor parameters must be an object");
  const allowed = new Set([
    "command",
    "description",
    "persistent",
    "timeout_ms",
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown Monitor parameter: ${unknown.sort()[0]}`);
  }
  if (typeof value.command !== "string") {
    throw new Error("Monitor command must be a string");
  }
  if (typeof value.description !== "string") {
    throw new Error("Monitor description must be a string");
  }
  if (value.persistent !== undefined && typeof value.persistent !== "boolean") {
    throw new Error("Monitor persistent must be a boolean");
  }
  if (
    value.timeout_ms !== undefined &&
    (!Number.isInteger(value.timeout_ms) ||
      (value.timeout_ms as number) < MONITOR_MIN_TIMEOUT_MS ||
      (value.timeout_ms as number) > MONITOR_MAX_TIMEOUT_MS)
  ) {
    throw new Error(
      `Monitor timeout_ms must be an integer from ${MONITOR_MIN_TIMEOUT_MS} to ${MONITOR_MAX_TIMEOUT_MS}`,
    );
  }
  return {
    command: value.command,
    description: value.description,
    persistent: (value.persistent as boolean | undefined) ?? false,
    timeout_ms:
      (value.timeout_ms as number | undefined) ?? MONITOR_DEFAULT_TIMEOUT_MS,
  };
}

function spawnMonitor(
  command: string,
  options: MonitorSpawnOptions,
): MonitorChild {
  return nodeSpawn(command, {
    cwd: options.cwd,
    env: options.env,
    shell: options.shell,
    detached: options.detached,
    stdio: [...options.stdio],
  }) as unknown as MonitorChild;
}

function defaultKillTree(child: MonitorChild, signal: NodeJS.Signals): void {
  if (typeof child.pid === "number" && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // A child can exit between the liveness check and the process-group signal.
    }
  }
  child.kill?.(signal);
}

function artifactRoot(env: NodeJS.ProcessEnv): string {
  const stateRoot = env.KEEPER_STATE_DIR?.trim();
  return resolve(
    stateRoot === undefined || stateRoot === ""
      ? join(homedir(), ".local", "state", "keeper")
      : stateRoot,
    "pi-monitors",
  );
}

function fileArtifactFactory(env: NodeJS.ProcessEnv): CreateMonitorArtifact {
  return () => {
    const root = artifactRoot(env);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    const path = join(root, `${randomUUID()}.log`);
    const fd = openSync(
      path,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let closed = false;
    let lastStream: "stdout" | "stderr" | null = null;
    return {
      path,
      write(stream, chunk) {
        if (closed) return;
        if (lastStream !== stream) {
          writeSync(
            fd,
            Buffer.from(`${lastStream === null ? "" : "\n"}[${stream}]\n`),
          );
          lastStream = stream;
        }
        writeSync(fd, chunk);
      },
      close() {
        if (closed) return;
        closed = true;
        closeSync(fd);
      },
    };
  };
}

function removeListener(
  emitter: MonitorChild | MonitorReadable | null,
  event: "data" | "close" | "exit" | "error",
  listener: (...args: never[]) => void,
): void {
  if (emitter === null) return;
  const target = emitter as unknown as {
    off?(event: string, listener: (...args: never[]) => void): unknown;
    removeListener?(
      event: string,
      listener: (...args: never[]) => void,
    ): unknown;
  };
  if (typeof target.off === "function") target.off(event, listener);
  else target.removeListener?.(event, listener);
}

export class PiMonitorController {
  readonly #deliverBatch: (batch: MonitorLineBatch) => void;
  readonly #deliverTerminal: (outcome: MonitorTerminalOutcome) => void;
  readonly #spawn: SpawnMonitor;
  readonly #clock: MonitorClock;
  readonly #allocateTaskId: () => string;
  readonly #createArtifact: CreateMonitorArtifact;
  readonly #killTree: (child: MonitorChild, signal: NodeJS.Signals) => void;
  readonly #defer: (callback: () => void) => void;
  readonly #cwd: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #batchWindowMs: number;
  readonly #maxLineChars: number;
  readonly #maxQueuedLines: number;
  readonly #suppressionBudget: number;
  readonly #termGraceMs: number;
  readonly #killGraceMs: number;
  readonly #tasks = new Map<string, ActiveMonitor>();
  #generation = 0;

  constructor(options: PiMonitorControllerOptions) {
    this.#deliverBatch = options.deliverBatch;
    this.#deliverTerminal = options.deliverTerminal;
    this.#spawn = options.spawn ?? spawnMonitor;
    this.#clock = options.clock ?? systemClock;
    this.#allocateTaskId =
      options.allocateTaskId ?? (() => `monitor-${randomUUID()}`);
    this.#env = options.env ?? process.env;
    this.#createArtifact =
      options.createArtifact ?? fileArtifactFactory(this.#env);
    this.#killTree = options.killTree ?? defaultKillTree;
    this.#defer = options.defer ?? queueMicrotask;
    this.#cwd = options.cwd ?? process.cwd();
    this.#batchWindowMs = options.batchWindowMs ?? MONITOR_BATCH_WINDOW_MS;
    this.#maxLineChars = options.maxLineChars ?? MONITOR_MAX_LINE_CHARS;
    this.#maxQueuedLines = options.maxQueuedLines ?? MONITOR_MAX_QUEUED_LINES;
    this.#suppressionBudget =
      options.suppressionBudget ?? MONITOR_SUPPRESSION_BUDGET;
    this.#termGraceMs = options.termGraceMs ?? TERM_GRACE_MS;
    this.#killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  }

  arm(params: PiMonitorParams): string {
    const resolved = resolveMonitorParams(params);
    const id = this.#allocateTaskId();
    if (id.trim() === "" || this.#tasks.has(id)) {
      throw new Error(
        "Monitor task id allocator returned an invalid or duplicate id",
      );
    }

    let artifact: MonitorArtifact;
    try {
      artifact = this.#createArtifact(id);
    } catch (error) {
      this.#defer(() =>
        this.#safeTerminal({
          taskId: id,
          description: resolved.description,
          status: "spawn_failed",
          artifactPath: null,
          exitCode: null,
          signal: null,
          error: `artifact creation failed: ${errorMessage(error)}`,
          suppressedLines: 0,
        }),
      );
      return id;
    }

    let child: MonitorChild;
    try {
      child = this.#spawn(resolved.command, {
        cwd: this.#cwd,
        env: this.#env,
        shell: "/bin/bash",
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      try {
        artifact.close();
      } catch {
        // The launch failure remains the terminal cause.
      }
      this.#defer(() =>
        this.#safeTerminal({
          taskId: id,
          description: resolved.description,
          status: "spawn_failed",
          artifactPath: artifact.path,
          exitCode: null,
          signal: null,
          error: errorMessage(error),
          suppressedLines: 0,
        }),
      );
      return id;
    }

    const generation = ++this.#generation;
    const state: ActiveMonitor = {
      generation,
      id,
      params: resolved,
      child,
      artifact,
      decoder: new StringDecoder("utf8"),
      buffer: "",
      discardingLine: false,
      queue: [],
      suppressedLines: 0,
      batchTimer: null,
      timeoutTimer: null,
      terminal: null,
      terminalPromise: null,
      deliveryReady: false,
      pendingDeliveries: [],
      stdoutListener: () => {},
      stderrListener: () => {},
      closeListener: () => {},
      exitListener: () => {},
      errorListener: () => {},
    };
    this.#tasks.set(id, state);

    state.stdoutListener = (chunk) => this.#onStdout(state, chunk);
    state.stderrListener = (chunk) => this.#onStderr(state, chunk);
    state.closeListener = (code, signal) => {
      void this.#finish(state, {
        status: "exited",
        exitCode: typeof code === "number" ? code : (child.exitCode ?? null),
        signal: typeof signal === "string" ? signal : null,
      });
    };
    state.exitListener = state.closeListener;
    state.errorListener = (error) => {
      void this.#finish(
        state,
        {
          status: "spawn_failed",
          exitCode: child.exitCode ?? null,
          signal: null,
          error: errorMessage(error),
        },
        true,
      );
    };

    try {
      child.stdout?.on("data", state.stdoutListener);
      child.stderr?.on("data", state.stderrListener);
      child.once("close", state.closeListener);
      child.once("exit", state.exitListener);
      child.once("error", state.errorListener);
      if (!resolved.persistent) {
        state.timeoutTimer = this.#clock.setTimer(() => {
          void this.#finish(
            state,
            {
              status: "timed_out",
              exitCode: child.exitCode ?? null,
              signal: null,
            },
            true,
          );
        }, resolved.timeout_ms);
      }
      if (child.exitCode != null) {
        void this.#finish(state, {
          status: "exited",
          exitCode: child.exitCode,
          signal: null,
        });
      }
    } catch (error) {
      void this.#finish(
        state,
        {
          status: "spawn_failed",
          exitCode: child.exitCode ?? null,
          signal: null,
          error: errorMessage(error),
        },
        true,
      );
    }

    state.deliveryReady = true;
    for (const delivery of state.pendingDeliveries.splice(0)) {
      this.#defer(delivery);
    }
    return id;
  }

  list(): MonitorTaskSnapshot[] {
    return [...this.#tasks.values()]
      .filter((state) => state.terminal === null)
      .map((state) => ({
        id: state.id,
        type: "shell" as const,
        kind: "monitor" as const,
        command: state.params.command,
        description: state.params.description,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  stop(id: string): Promise<boolean> {
    const state = this.#tasks.get(id);
    if (state === undefined || state.terminal !== null) {
      return Promise.resolve(false);
    }
    return this.#finish(
      state,
      {
        status: "stopped",
        exitCode: state.child.exitCode ?? null,
        signal: null,
      },
      true,
    ).then(() => true);
  }

  async stopAll(): Promise<void> {
    const tasks = [...this.#tasks.values()];
    await Promise.all(
      tasks.map((state) =>
        this.#finish(
          state,
          {
            status: "shutdown",
            exitCode: state.child.exitCode ?? null,
            signal: null,
          },
          true,
        ),
      ),
    );
  }

  #isCurrent(state: ActiveMonitor): boolean {
    return (
      this.#tasks.get(state.id) === state &&
      state.generation <= this.#generation &&
      state.terminal === null
    );
  }

  #onStdout(state: ActiveMonitor, chunk: Uint8Array | string): void {
    if (!this.#isCurrent(state)) return;
    const bytes =
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    try {
      state.artifact.write("stdout", bytes);
    } catch (error) {
      void this.#finish(
        state,
        {
          status: "artifact_failed",
          exitCode: state.child.exitCode ?? null,
          signal: null,
          error: errorMessage(error),
        },
        true,
      );
      return;
    }
    try {
      const decoded =
        typeof chunk === "string" ? chunk : state.decoder.write(bytes);
      this.#frameStdout(state, decoded);
    } catch (error) {
      void this.#finish(
        state,
        {
          status: "artifact_failed",
          exitCode: state.child.exitCode ?? null,
          signal: null,
          error: `stdout framing failed: ${errorMessage(error)}`,
        },
        true,
      );
    }
  }

  #onStderr(state: ActiveMonitor, chunk: Uint8Array | string): void {
    if (!this.#isCurrent(state)) return;
    const bytes =
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    try {
      state.artifact.write("stderr", bytes);
    } catch (error) {
      void this.#finish(
        state,
        {
          status: "artifact_failed",
          exitCode: state.child.exitCode ?? null,
          signal: null,
          error: errorMessage(error),
        },
        true,
      );
    }
  }

  #frameStdout(state: ActiveMonitor, decoded: string): void {
    let offset = 0;
    while (offset < decoded.length && this.#isCurrent(state)) {
      if (state.discardingLine) {
        const newline = decoded.indexOf("\n", offset);
        if (newline === -1) return;
        state.discardingLine = false;
        offset = newline + 1;
        continue;
      }

      const newline = decoded.indexOf("\n", offset);
      if (newline === -1) {
        const tail = decoded.slice(offset);
        if (state.buffer.length + tail.length > this.#maxLineChars) {
          state.buffer = "";
          state.discardingLine = true;
          this.#suppressLine(state);
        } else {
          state.buffer += tail;
        }
        return;
      }

      const segment = decoded.slice(offset, newline);
      offset = newline + 1;
      if (state.buffer.length + segment.length > this.#maxLineChars) {
        state.buffer = "";
        this.#suppressLine(state);
        continue;
      }
      let line = state.buffer + segment;
      state.buffer = "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.#enqueueLine(state, line);
    }
  }

  #enqueueLine(state: ActiveMonitor, line: string): void {
    if (!this.#isCurrent(state)) return;
    if (state.queue.length >= this.#maxQueuedLines) {
      this.#suppressLine(state);
      return;
    }
    state.queue.push(line);
    if (state.batchTimer === null) {
      state.batchTimer = this.#clock.setTimer(
        () => this.#flushBatch(state),
        this.#batchWindowMs,
      );
    }
  }

  #suppressLine(state: ActiveMonitor): void {
    if (!this.#isCurrent(state)) return;
    state.suppressedLines += 1;
    if (state.suppressedLines < this.#suppressionBudget) return;
    void this.#finish(
      state,
      {
        status: "flood",
        exitCode: state.child.exitCode ?? null,
        signal: null,
        error: `monitor output exceeded the ${this.#suppressionBudget}-line suppression budget`,
      },
      true,
    );
  }

  #flushBatch(state: ActiveMonitor): void {
    if (state.batchTimer !== null) {
      this.#clock.clearTimer(state.batchTimer);
      state.batchTimer = null;
    }
    if (state.queue.length === 0) return;
    const lines = state.queue.splice(0);
    this.#deliver(state, () =>
      this.#safeBatch({
        taskId: state.id,
        description: state.params.description,
        lines,
      }),
    );
  }

  #deliver(state: ActiveMonitor, delivery: () => void): void {
    if (state.deliveryReady) delivery();
    else state.pendingDeliveries.push(delivery);
  }

  #safeBatch(batch: MonitorLineBatch): void {
    try {
      this.#deliverBatch(batch);
    } catch {
      // A replaced Pi runtime can invalidate its delivery surface at any time.
    }
  }

  #safeTerminal(outcome: MonitorTerminalOutcome): void {
    try {
      this.#deliverTerminal(outcome);
    } catch {
      // Terminal cleanup must not depend on the host accepting a notification.
    }
  }

  #finish(
    state: ActiveMonitor,
    outcome: Omit<
      MonitorTerminalOutcome,
      "taskId" | "description" | "artifactPath" | "suppressedLines"
    >,
    terminateTree = false,
  ): Promise<void> {
    if (state.terminalPromise !== null) return state.terminalPromise;
    state.terminal = outcome.status;
    if (state.timeoutTimer !== null) {
      this.#clock.clearTimer(state.timeoutTimer);
      state.timeoutTimer = null;
    }
    if (state.batchTimer !== null) {
      this.#clock.clearTimer(state.batchTimer);
      state.batchTimer = null;
    }
    this.#flushBatch(state);
    this.#detach(state);

    state.terminalPromise = (async () => {
      if (terminateTree) await this.#terminateTree(state.child);
      try {
        state.artifact.close();
      } catch {
        // The already-selected terminal outcome remains authoritative.
      }
      if (this.#tasks.get(state.id) === state) this.#tasks.delete(state.id);
      this.#deliver(state, () =>
        this.#safeTerminal({
          taskId: state.id,
          description: state.params.description,
          artifactPath: state.artifact.path,
          suppressedLines: state.suppressedLines,
          ...outcome,
        }),
      );
      state.pendingDeliveries = [];
    })();
    return state.terminalPromise;
  }

  #detach(state: ActiveMonitor): void {
    removeListener(
      state.child.stdout,
      "data",
      state.stdoutListener as (...args: never[]) => void,
    );
    removeListener(
      state.child.stderr,
      "data",
      state.stderrListener as (...args: never[]) => void,
    );
    removeListener(
      state.child,
      "close",
      state.closeListener as (...args: never[]) => void,
    );
    removeListener(
      state.child,
      "exit",
      state.exitListener as (...args: never[]) => void,
    );
    removeListener(
      state.child,
      "error",
      state.errorListener as (...args: never[]) => void,
    );
  }

  async #terminateTree(child: MonitorChild): Promise<void> {
    if (child.exitCode != null) return;
    if (await this.#signalAndWait(child, "SIGTERM", this.#termGraceMs)) return;
    await this.#signalAndWait(child, "SIGKILL", this.#killGraceMs);
  }

  #signalAndWait(
    child: MonitorChild,
    signal: NodeJS.Signals,
    timeoutMs: number,
  ): Promise<boolean> {
    if (child.exitCode != null) return Promise.resolve(true);
    return new Promise((resolvePromise) => {
      let settled = false;
      let timer: unknown | null = null;
      const finish = (exited: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) this.#clock.clearTimer(timer);
        removeListener(child, "close", onExit as (...args: never[]) => void);
        removeListener(child, "exit", onExit as (...args: never[]) => void);
        resolvePromise(exited);
      };
      const onExit = (): void => finish(true);
      child.once("close", onExit);
      child.once("exit", onExit);
      if (settled) return;
      timer = this.#clock.setTimer(() => finish(false), timeoutMs);
      if (settled) {
        this.#clock.clearTimer(timer);
        return;
      }
      try {
        this.#killTree(child, signal);
      } catch {
        finish(false);
      }
    });
  }
}

export function createMonitorFacadeTool(
  controller: PiMonitorController,
): PiMonitorToolDefinition {
  return {
    name: "Monitor",
    label: "Monitor",
    description:
      "Run a shell command and deliver complete stdout lines as bounded background notifications.",
    parameters: MONITOR_PARAMETERS,
    async execute(_toolCallId, params) {
      const taskId = controller.arm(params);
      return {
        content: [{ type: "text", text: `Monitor started: ${taskId}` }],
        details: { taskId },
      };
    },
  };
}

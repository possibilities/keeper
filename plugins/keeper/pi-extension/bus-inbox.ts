import { spawn as nodeSpawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/**
 * Pi loads keeper's extension in isolation, so this helper deliberately depends
 * only on node:* and structural process types. The child is the existing keeper
 * CLI watcher; it owns daemon reconnects while this controller owns exactly one
 * Pi-session lifetime.
 */

export const BUS_WATCH_ARGV = [
  "bus",
  "watch",
  "--json",
  "--lifetime-stdin",
] as const;

export const BUS_WATCH_COMMAND = `keeper ${BUS_WATCH_ARGV.join(" ")}`;
export const BUS_WATCH_DESCRIPTION = "keeper agent bus";

const MAX_WATCH_RECORD_CHARS = 8_192;
const OWNER_KEY = Symbol.for("keeper.pi.agent-bus-inbox-owner");
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_DELAY_MS = 250;
const EOF_GRACE_MS = 500;
const TERM_GRACE_MS = 500;
const KILL_GRACE_MS = 100;

interface ReadableLike {
  on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown;
  resume?(): unknown;
}

interface WritableLike {
  end(): unknown;
}

export interface BusWatchChild {
  pid?: number;
  exitCode?: number | null;
  stdin: WritableLike | null;
  stdout: ReadableLike | null;
  stderr: ReadableLike | null;
  once(
    event: "close" | "exit" | "error",
    listener: (...args: unknown[]) => void,
  ): unknown;
  off?(
    event: "close" | "exit",
    listener: (...args: unknown[]) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnBusWatch = () => BusWatchChild;

/**
 * Claim the one top-level inbox allowed in a Pi process. Nested AgentSessions
 * load extensions in the same process and inherit KEEPER_JOB_ID; without this
 * process-global lease their watchers would repeatedly take over one bus
 * identity.
 */
export function claimBusInboxOwnership(token: object): boolean {
  const shared = globalThis as unknown as Record<PropertyKey, unknown>;
  const owner = shared[OWNER_KEY];
  if (owner !== undefined && owner !== token) return false;
  shared[OWNER_KEY] = token;
  return true;
}

export function releaseBusInboxOwnership(token: object): void {
  const shared = globalThis as unknown as Record<PropertyKey, unknown>;
  if (shared[OWNER_KEY] === token) delete shared[OWNER_KEY];
}

export interface AmbientBusWatchTask {
  id: string;
  type: "shell";
  command: string;
  description: string;
}

interface BusInboxControllerOptions {
  deliver(line: string): void;
  spawn?: SpawnBusWatch;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

function spawnBusWatch(): BusWatchChild {
  return nodeSpawn("keeper", [...BUS_WATCH_ARGV], {
    cwd: process.cwd(),
    detached: false,
    env: process.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as BusWatchChild;
}

/** Parse one machine-framed watcher record. Malformed and oversized input drops. */
export function parseBusWatchRecord(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_WATCH_RECORD_CHARS) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      parsed.type !== "agent_bus_message" ||
      typeof parsed.line !== "string" ||
      parsed.line.length === 0 ||
      parsed.line.length > MAX_WATCH_RECORD_CHARS
    ) {
      return null;
    }
    return parsed.line;
  } catch {
    return null;
  }
}

/**
 * One session-scoped Pi Agent Bus inbox. Start is idempotent; stop invalidates
 * delivery before closing the lifetime lease, so late stdout from a replaced Pi
 * runtime can never call its stale extension API.
 */
export class PiBusInboxController {
  readonly #deliver: (line: string) => void;
  readonly #spawn: SpawnBusWatch;
  readonly #setTimer: typeof setTimeout;
  readonly #clearTimer: typeof clearTimeout;
  #child: BusWatchChild | null = null;
  #generation = 0;
  #shouldRun = false;
  #restartAttempts = 0;
  #restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: BusInboxControllerOptions) {
    this.#deliver = options.deliver;
    this.#spawn = options.spawn ?? spawnBusWatch;
    this.#setTimer = options.setTimer ?? setTimeout;
    this.#clearTimer = options.clearTimer ?? clearTimeout;
  }

  start(): void {
    if (this.#shouldRun) return;
    this.#shouldRun = true;
    this.#restartAttempts = 0;
    const generation = ++this.#generation;
    this.#startChild(generation);
  }

  #startChild(generation: number): void {
    if (!this.#shouldRun || this.#generation !== generation) return;
    let child: BusWatchChild;
    try {
      child = this.#spawn();
    } catch {
      this.#scheduleRestart(generation);
      return;
    }
    this.#child = child;
    child.stderr?.resume?.();

    const decoder = new StringDecoder("utf8");
    let buffered = "";
    let discardingOversizedRecord = false;
    child.stdout?.on("data", (chunk) => {
      if (this.#child !== child || this.#generation !== generation) return;
      try {
        const decoded =
          typeof chunk === "string"
            ? chunk
            : decoder.write(Buffer.from(chunk));
        if (discardingOversizedRecord) {
          const newline = decoded.indexOf("\n");
          if (newline === -1) return;
          discardingOversizedRecord = false;
          buffered = decoded.slice(newline + 1);
        } else {
          buffered += decoded;
        }
        let newline = buffered.indexOf("\n");
        while (newline !== -1) {
          const record = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          const line = parseBusWatchRecord(record);
          if (line !== null) {
            try {
              this.#deliver(line);
            } catch {
              // Pi invalidates an old extension API during session replacement.
            }
          }
          newline = buffered.indexOf("\n");
        }
        if (buffered.length > MAX_WATCH_RECORD_CHARS) {
          buffered = "";
          discardingOversizedRecord = true;
        }
      } catch {
        buffered = "";
        discardingOversizedRecord = false;
      }
    });

    const clearIfCurrent = (): void => {
      if (this.#child === child && this.#generation === generation) {
        this.#child = null;
        this.#scheduleRestart(generation);
      }
    };
    child.once("error", clearIfCurrent);
    child.once("close", clearIfCurrent);
    child.once("exit", clearIfCurrent);
  }

  ambientTask(): AmbientBusWatchTask | null {
    const child = this.#child;
    if (child === null || child.exitCode != null) return null;
    return {
      id: `pi-bus-${child.pid ?? "starting"}`,
      type: "shell",
      command: BUS_WATCH_COMMAND,
      description: BUS_WATCH_DESCRIPTION,
    };
  }

  async stop(): Promise<void> {
    const child = this.#child;
    this.#shouldRun = false;
    ++this.#generation;
    this.#child = null;
    if (this.#restartTimer !== null) {
      this.#clearTimer(this.#restartTimer);
      this.#restartTimer = null;
    }
    if (child === null) return;

    try {
      child.stdin?.end();
    } catch {
      // Fall through to the bounded signal ladder.
    }
    if (await this.#waitForExit(child, EOF_GRACE_MS)) return;

    try {
      child.kill("SIGTERM");
    } catch {
      // Fall through to SIGKILL.
    }
    if (await this.#waitForExit(child, TERM_GRACE_MS)) return;

    try {
      child.kill("SIGKILL");
    } catch {
      return;
    }
    await this.#waitForExit(child, KILL_GRACE_MS);
  }

  #scheduleRestart(generation: number): void {
    if (
      !this.#shouldRun ||
      this.#generation !== generation ||
      this.#restartTimer !== null ||
      this.#restartAttempts >= MAX_RESTART_ATTEMPTS
    ) {
      return;
    }
    this.#restartAttempts += 1;
    this.#restartTimer = this.#setTimer(() => {
      this.#restartTimer = null;
      this.#startChild(generation);
    }, RESTART_DELAY_MS * this.#restartAttempts);
  }

  #waitForExit(child: BusWatchChild, timeoutMs: number): Promise<boolean> {
    if (child.exitCode != null) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (exited: boolean): void => {
        if (settled) return;
        settled = true;
        this.#clearTimer(timer);
        child.off?.("close", onExit);
        child.off?.("exit", onExit);
        resolve(exited);
      };
      const onExit = (): void => finish(true);
      const timer = this.#setTimer(() => finish(false), timeoutMs);
      child.once("close", onExit);
      child.once("exit", onExit);
    });
  }
}

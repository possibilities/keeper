import type { CodexResetNamedKey, CodexResetTerminal } from "./codex-reset-tui";

export const CODEX_RESET_TMUX_COLUMNS = 120;
export const CODEX_RESET_TMUX_ROWS = 40;
export const CODEX_RESET_CAPTURE_MAX_BYTES = 64 * 1024;
export const CODEX_RESET_COMMAND_TIMEOUT_MS = 5_000;
export const CODEX_RESET_CAPTURE_SETTLE_MS = 150;

export interface CodexResetBinaries {
  readonly tmuxBin: string;
  readonly codexBin: string;
}

export interface CodexResetCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
}

/** Exact-argv command seam. deadlineMs is an absolute clock deadline. */
export interface CodexResetCommandRunner {
  run(
    argv: readonly string[],
    options: { readonly deadlineMs: number; readonly maxOutputBytes: number },
  ): Promise<CodexResetCommandResult>;
}

export interface CodexResetClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface CreateCodexResetTmuxOptions {
  readonly session: string;
  readonly env?: Record<string, string | undefined>;
  readonly runner?: CodexResetCommandRunner;
  readonly clock?: CodexResetClock;
  readonly commandTimeoutMs?: number;
  readonly captureMaxBytes?: number;
  readonly captureSettleMs?: number;
}

function requiredValue(value: string | undefined, label: string): string {
  if (value === undefined || value === "") {
    throw new Error(`${label} must be nonempty`);
  }
  return value;
}

export function resolveCodexResetBinaries(
  env: Record<string, string | undefined>,
): CodexResetBinaries {
  return {
    tmuxBin: env.KEEPER_TMUX_BIN || "tmux",
    codexBin: env.KEEPER_CODEX_BIN || "codex",
  };
}

export function buildCodexResetNewSessionArgv(input: {
  readonly tmuxBin: string;
  readonly codexBin: string;
  readonly session: string;
  readonly home: string;
}): string[] {
  return [
    input.tmuxBin,
    "new-session",
    "-d",
    "-s",
    input.session,
    "-x",
    String(CODEX_RESET_TMUX_COLUMNS),
    "-y",
    String(CODEX_RESET_TMUX_ROWS),
    "-c",
    input.home,
    "--",
    input.codexBin,
    "-c",
    "check_for_update_on_startup=false",
  ];
}

function exactTarget(session: string): string {
  return `=${session}`;
}

export function buildCodexResetCaptureArgv(
  tmuxBin: string,
  session: string,
): string[] {
  return [tmuxBin, "capture-pane", "-p", "-J", "-t", exactTarget(session)];
}

export function buildCodexResetLiteralSendArgv(
  tmuxBin: string,
  session: string,
  literal: string,
): string[] {
  return [
    tmuxBin,
    "send-keys",
    "-l",
    "-t",
    exactTarget(session),
    "--",
    literal,
  ];
}

export function buildCodexResetNamedKeyArgv(
  tmuxBin: string,
  session: string,
  key: CodexResetNamedKey,
): string[] {
  return [tmuxBin, "send-keys", "-t", exactTarget(session), "--", key];
}

export function buildCodexResetKillSessionArgv(
  tmuxBin: string,
  session: string,
): string[] {
  return [tmuxBin, "kill-session", "-t", exactTarget(session)];
}

function capUtf8(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= maxBytes) return text;
  return new TextDecoder().decode(encoded.slice(0, maxBytes));
}

const systemClock: CodexResetClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

async function readBoundedStream(
  stream: unknown,
  maxBytes: number,
): Promise<string> {
  if (!(stream instanceof ReadableStream)) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - size;
      if (remaining > 0) {
        const kept =
          value.byteLength <= remaining ? value : value.slice(0, remaining);
        chunks.push(kept);
        size += kept.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** Production runner: Bun receives an argv array directly; no shell is involved. */
export function createCodexResetCommandRunner(
  clock: CodexResetClock = systemClock,
): CodexResetCommandRunner {
  return {
    async run(argv, options): Promise<CodexResetCommandResult> {
      const remainingMs = options.deadlineMs - clock.now();
      if (remainingMs <= 0) {
        return { exitCode: -1, stdout: "", stderr: "", timedOut: true };
      }

      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn([...argv], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (error) {
        throw new Error(`failed to launch ${argv[0] ?? "command"}`, {
          cause: error,
        });
      }

      const stdoutPromise = readBoundedStream(
        proc.stdout,
        options.maxOutputBytes,
      );
      const stderrPromise = readBoundedStream(
        proc.stderr,
        options.maxOutputBytes,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), remainingMs);
      });
      const exit = await Promise.race([
        proc.exited.then((code) => ({ code })),
        timeout,
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (exit === "timeout") {
        try {
          proc.kill();
        } catch {
          // The process may have exited between the timeout and kill.
        }
        return { exitCode: -1, stdout: "", stderr: "", timedOut: true };
      }

      const [stdout, stderr] = await Promise.all([
        stdoutPromise,
        stderrPromise,
      ]);
      return { exitCode: exit.code, stdout, stderr };
    },
  };
}

class CodexResetTmuxTerminal implements CodexResetTerminal {
  readonly #session: string;
  readonly #home: string;
  readonly #binaries: CodexResetBinaries;
  readonly #runner: CodexResetCommandRunner;
  readonly #clock: CodexResetClock;
  readonly #commandTimeoutMs: number;
  readonly #captureMaxBytes: number;
  readonly #captureSettleMs: number;
  #closed = false;

  constructor(options: CreateCodexResetTmuxOptions) {
    this.#session = requiredValue(options.session, "session");
    const env = options.env ?? process.env;
    this.#home = requiredValue(env.HOME, "HOME");
    this.#binaries = resolveCodexResetBinaries(env);
    this.#clock = options.clock ?? systemClock;
    this.#runner = options.runner ?? createCodexResetCommandRunner(this.#clock);
    this.#commandTimeoutMs =
      options.commandTimeoutMs ?? CODEX_RESET_COMMAND_TIMEOUT_MS;
    this.#captureMaxBytes =
      options.captureMaxBytes ?? CODEX_RESET_CAPTURE_MAX_BYTES;
    this.#captureSettleMs =
      options.captureSettleMs ?? CODEX_RESET_CAPTURE_SETTLE_MS;
    for (const [name, value] of [
      ["commandTimeoutMs", this.#commandTimeoutMs],
      ["captureMaxBytes", this.#captureMaxBytes],
    ] as const) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be positive`);
      }
    }
    if (!Number.isFinite(this.#captureSettleMs) || this.#captureSettleMs < 0) {
      throw new Error("captureSettleMs must be nonnegative");
    }
  }

  async #run(
    argv: string[],
    timeoutMs = this.#commandTimeoutMs,
  ): Promise<string> {
    const result = await this.#runner.run(argv, {
      deadlineMs:
        this.#clock.now() + Math.min(timeoutMs, this.#commandTimeoutMs),
      maxOutputBytes: this.#captureMaxBytes,
    });
    if (result.timedOut) {
      throw new Error(`${argv[1] ?? "tmux"} timed out`);
    }
    if (result.exitCode !== 0) {
      const detail = capUtf8(result.stderr, 512).trimEnd();
      throw new Error(
        `${argv[1] ?? "tmux"} exited ${result.exitCode}${detail === "" ? "" : `: ${detail}`}`,
      );
    }
    return capUtf8(result.stdout, this.#captureMaxBytes);
  }

  async start(): Promise<void> {
    await this.#run(
      buildCodexResetNewSessionArgv({
        ...this.#binaries,
        session: this.#session,
        home: this.#home,
      }),
    );
  }

  async capture(timeoutMs: number): Promise<string> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("capture timeout must be positive");
    }
    const startedAt = this.#clock.now();
    if (this.#captureSettleMs > 0) {
      if (this.#captureSettleMs >= timeoutMs) {
        throw new Error("capture timed out before pane read");
      }
      await this.#clock.sleep(this.#captureSettleMs);
    }
    const remaining = timeoutMs - (this.#clock.now() - startedAt);
    if (remaining <= 0) throw new Error("capture timed out before pane read");
    return this.#run(
      buildCodexResetCaptureArgv(this.#binaries.tmuxBin, this.#session),
      remaining,
    );
  }

  async wait(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error("wait duration must be nonnegative");
    }
    await this.#clock.sleep(ms);
  }

  async sendLiteral(text: string): Promise<void> {
    await this.#run(
      buildCodexResetLiteralSendArgv(
        this.#binaries.tmuxBin,
        this.#session,
        text,
      ),
    );
  }

  async sendKey(key: CodexResetNamedKey): Promise<void> {
    await this.#run(
      buildCodexResetNamedKeyArgv(this.#binaries.tmuxBin, this.#session, key),
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#run(
      buildCodexResetKillSessionArgv(this.#binaries.tmuxBin, this.#session),
    );
  }
}

export function createCodexResetTmuxTerminal(
  options: CreateCodexResetTmuxOptions,
): CodexResetTerminal {
  return new CodexResetTmuxTerminal(options);
}

import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  CODEX_MAX_OBSERVER_OUTPUT_BYTES,
  CODEX_OBSERVER_TIMEOUT_MS,
  codexObservationRefreshLockPath,
  codexObservationSidecarPath,
  codexObserverArgv,
} from "./account-routing-config";
import {
  type CodexCapacityObservation,
  type CodexObserverRunOutcome,
  isCodexObservationFresh,
  parseCodexObserverEnvelope,
  parseCodexObserverOutcome,
  readCodexObservationSidecar,
  writeCodexObservationSidecar,
} from "./codex-account-observation";
import { FileLock } from "./file-lock";

export type CodexExactArgvRunner = (
  argv: readonly string[],
) => Promise<CodexObserverRunOutcome>;

export type CodexObservationRefreshFailureClass =
  | "spawn"
  | "timeout"
  | "unavailable-envelope"
  | "parse";

export interface CodexObservationRefreshFailureState {
  schema_version: 1;
  consecutive_failures: number;
  last_failure_class: CodexObservationRefreshFailureClass | null;
  last_failure_at_ms: number | null;
}

const CODEX_REFRESH_FAILURE_SCHEMA_VERSION = 1;
const CODEX_REFRESH_FAILURE_MAX_BYTES = 512;

export function codexObservationRefreshFailureSidecarPath(
  stateDir: string,
): string {
  return join(stateDir, "observation-refresh-failures.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRefreshFailureClass(
  value: unknown,
): value is CodexObservationRefreshFailureClass {
  return (
    value === "spawn" ||
    value === "timeout" ||
    value === "unavailable-envelope" ||
    value === "parse"
  );
}

function parseRefreshFailureState(
  value: unknown,
): CodexObservationRefreshFailureState | null {
  if (
    !isRecord(value) ||
    value.schema_version !== CODEX_REFRESH_FAILURE_SCHEMA_VERSION
  ) {
    return null;
  }
  const count = value.consecutive_failures;
  const failureClass = value.last_failure_class;
  const failureAt = value.last_failure_at_ms;
  if (
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > Number.MAX_SAFE_INTEGER ||
    (failureClass !== null && !isRefreshFailureClass(failureClass)) ||
    (failureAt !== null &&
      (typeof failureAt !== "number" ||
        !Number.isSafeInteger(failureAt) ||
        failureAt < 0)) ||
    (count === 0 && (failureClass !== null || failureAt !== null)) ||
    (count > 0 && (failureClass === null || failureAt === null))
  ) {
    return null;
  }
  return {
    schema_version: CODEX_REFRESH_FAILURE_SCHEMA_VERSION,
    consecutive_failures: count,
    last_failure_class:
      failureClass as CodexObservationRefreshFailureClass | null,
    last_failure_at_ms: failureAt as number | null,
  };
}

export function readCodexObservationRefreshFailureState(
  stateDir: string,
): CodexObservationRefreshFailureState | null {
  try {
    const path = codexObservationRefreshFailureSidecarPath(stateDir);
    if (!existsSync(path)) return null;
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > CODEX_REFRESH_FAILURE_MAX_BYTES) {
      return null;
    }
    return parseRefreshFailureState(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export function writeCodexObservationRefreshFailureState(
  stateDir: string,
  state: CodexObservationRefreshFailureState,
): void {
  const validated = parseRefreshFailureState(state);
  if (validated === null)
    throw new Error("invalid Codex refresh failure state");
  const content = `${JSON.stringify(validated)}\n`;
  if (Buffer.byteLength(content, "utf8") > CODEX_REFRESH_FAILURE_MAX_BYTES) {
    throw new Error("Codex refresh failure state exceeds size limit");
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const path = codexObservationRefreshFailureSidecarPath(stateDir);
  const temporary = join(
    stateDir,
    `.observation-refresh-failures.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    writeFileSync(fd, content, "utf8");
    closeSync(fd);
    fd = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
}

function validTimestamp(nowMs: number): number {
  return Number.isSafeInteger(nowMs) && nowMs >= 0 ? nowMs : 0;
}

function recordCodexObservationRefreshFailure(
  stateDir: string,
  failureClass: CodexObservationRefreshFailureClass,
  nowMs: number,
): CodexObservationRefreshFailureState {
  const previous = readCodexObservationRefreshFailureState(stateDir);
  const state: CodexObservationRefreshFailureState = {
    schema_version: CODEX_REFRESH_FAILURE_SCHEMA_VERSION,
    consecutive_failures: Math.min(
      Number.MAX_SAFE_INTEGER,
      (previous?.consecutive_failures ?? 0) + 1,
    ),
    last_failure_class: failureClass,
    last_failure_at_ms: validTimestamp(nowMs),
  };
  writeCodexObservationRefreshFailureState(stateDir, state);
  return state;
}

function resetCodexObservationRefreshFailures(stateDir: string): void {
  writeCodexObservationRefreshFailureState(stateDir, {
    schema_version: CODEX_REFRESH_FAILURE_SCHEMA_VERSION,
    consecutive_failures: 0,
    last_failure_class: null,
    last_failure_at_ms: null,
  });
}

function classifyCodexObservationFailure(
  outcome: CodexObserverRunOutcome,
): CodexObservationRefreshFailureClass {
  if (outcome.failure === "timeout") return "timeout";
  if (outcome.failure !== undefined) return "spawn";
  if (outcome.code !== 0 || outcome.stdout.trim().length === 0) {
    return "unavailable-envelope";
  }
  if (
    Buffer.byteLength(outcome.stdout, "utf8") > CODEX_MAX_OBSERVER_OUTPUT_BYTES
  ) {
    return "parse";
  }
  try {
    return parseCodexObserverEnvelope(JSON.parse(outcome.stdout)) === null
      ? "unavailable-envelope"
      : "parse";
  } catch {
    return "parse";
  }
}

export interface CodexObserveDeps {
  runner: CodexExactArgvRunner;
  nowMs: () => number;
  observerArgv?: readonly string[];
}

export async function observeCodexOnce(
  deps: CodexObserveDeps,
): Promise<CodexCapacityObservation | null> {
  const outcome = await deps.runner(deps.observerArgv ?? codexObserverArgv());
  return parseCodexObserverOutcome(outcome);
}

export function publishCodexObservation(
  stateDir: string,
  observation: CodexCapacityObservation,
): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeCodexObservationSidecar(
    codexObservationSidecarPath(stateDir),
    observation,
  );
}

export interface CodexRefreshLock {
  release(): void;
}

export type TryAcquireCodexRefreshLock = (
  path: string,
) => CodexRefreshLock | null;

export interface RefreshCodexObservationDeps extends CodexObserveDeps {
  stateDir: string;
  maxAgeMs: number;
  tryAcquireLock?: TryAcquireCodexRefreshLock;
  sleep?: (ms: number) => Promise<void>;
  contentionWaitMs?: number;
  contentionTimeoutMs?: number;
  onRefreshFailure?: (state: CodexObservationRefreshFailureState) => void;
}

const DEFAULT_CONTENTION_WAIT_MS = 100;
const DEFAULT_CONTENTION_TIMEOUT_MS = CODEX_OBSERVER_TIMEOUT_MS + 1_000;
const realTryAcquireLock: TryAcquireCodexRefreshLock = (path) =>
  FileLock.tryAcquire(path);
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function refreshCodexObservationIfStale(
  deps: RefreshCodexObservationDeps,
): Promise<CodexCapacityObservation | null> {
  const sidecarPath = codexObservationSidecarPath(deps.stateDir);
  const readFresh = (): CodexCapacityObservation | null => {
    const observation = readCodexObservationSidecar(sidecarPath);
    return observation &&
      isCodexObservationFresh(observation, deps.nowMs(), deps.maxAgeMs)
      ? observation
      : null;
  };
  const before = readFresh();
  if (before) return before;

  mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 });
  const acquire = deps.tryAcquireLock ?? realTryAcquireLock;
  const sleep = deps.sleep ?? realSleep;
  const waitMs = Math.max(
    1,
    deps.contentionWaitMs ?? DEFAULT_CONTENTION_WAIT_MS,
  );
  let remainingMs = Math.max(
    0,
    deps.contentionTimeoutMs ?? DEFAULT_CONTENTION_TIMEOUT_MS,
  );
  let lock = acquire(codexObservationRefreshLockPath(deps.stateDir));
  while (lock === null && remainingMs > 0) {
    const delay = Math.min(waitMs, remainingMs);
    await sleep(delay);
    remainingMs -= delay;
    const published = readFresh();
    if (published) return published;
    lock = acquire(codexObservationRefreshLockPath(deps.stateDir));
  }
  if (lock === null) return readCodexObservationSidecar(sidecarPath);

  try {
    const underLock = readFresh();
    if (underLock) return underLock;
    let outcome: CodexObserverRunOutcome;
    try {
      outcome = await deps.runner(deps.observerArgv ?? codexObserverArgv());
    } catch {
      const failure = recordCodexObservationRefreshFailure(
        deps.stateDir,
        "spawn",
        deps.nowMs(),
      );
      try {
        deps.onRefreshFailure?.(failure);
      } catch {}
      return readCodexObservationSidecar(sidecarPath);
    }
    const observation = parseCodexObserverOutcome(outcome);
    if (observation === null) {
      const failure = recordCodexObservationRefreshFailure(
        deps.stateDir,
        classifyCodexObservationFailure(outcome),
        deps.nowMs(),
      );
      try {
        deps.onRefreshFailure?.(failure);
      } catch {}
      return readCodexObservationSidecar(sidecarPath);
    }
    publishCodexObservation(deps.stateDir, observation);
    resetCodexObservationRefreshFailures(deps.stateDir);
    return observation;
  } finally {
    lock.release();
  }
}

export function codexObserverSubprocessEnvironment(
  inherited: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  return {
    ...inherited,
    KEEPER_JOB_ID: inherited.KEEPER_JOB_ID?.trim() || "keeperd-codex-observer",
  };
}

export function makeCodexBoundedRunner(
  options: {
    timeoutMs?: number;
    maxBytes?: number;
    inheritedEnvironment?: Readonly<Record<string, string | undefined>>;
    signal?: AbortSignal;
  } = {},
): CodexExactArgvRunner {
  const timeoutMs = Math.max(1, options.timeoutMs ?? CODEX_OBSERVER_TIMEOUT_MS);
  const maxBytes = Math.max(
    1,
    options.maxBytes ?? CODEX_MAX_OBSERVER_OUTPUT_BYTES,
  );
  const environment = codexObserverSubprocessEnvironment(
    options.inheritedEnvironment,
  );
  return async (argv): Promise<CodexObserverRunOutcome> => {
    if (options.signal?.aborted) {
      return { code: null, stdout: "", failure: "aborted" };
    }
    try {
      if (argv.length === 0 || argv.some((part) => part.length === 0)) {
        return { code: null, stdout: "", failure: "spawn" };
      }
      const proc = Bun.spawn([...argv], {
        env: environment,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      const captured = captureCapped(proc.stdout, maxBytes);
      const timeout = Symbol("timeout");
      const aborted = Symbol("aborted");
      const oversized = Symbol("oversized");
      const exitFailed = Symbol("exit-failed");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<typeof timeout>((resolve) => {
        timer = setTimeout(() => resolve(timeout), timeoutMs);
      });
      let abortListener: (() => void) | undefined;
      const abortPromise = new Promise<typeof aborted>((resolve) => {
        abortListener = () => resolve(aborted);
        options.signal?.addEventListener("abort", abortListener, {
          once: true,
        });
      });
      const oversizedPromise = captured.then((result) =>
        result.oversized
          ? oversized
          : new Promise<never>(() => {
              return;
            }),
      );
      const result = await Promise.race([
        proc.exited.catch(() => exitFailed),
        timeoutPromise,
        abortPromise,
        oversizedPromise,
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (abortListener) {
        options.signal?.removeEventListener("abort", abortListener);
      }
      if (result === timeout || result === aborted || result === oversized) {
        await stopProcess(proc);
        return {
          code: null,
          stdout: "",
          failure:
            result === timeout
              ? "timeout"
              : result === aborted
                ? "aborted"
                : "oversize",
        };
      }
      if (typeof result !== "number") {
        return { code: null, stdout: "", failure: "spawn" };
      }
      const output = await captured;
      return output.oversized
        ? { code: null, stdout: "", failure: "oversize" }
        : { code: result, stdout: output.stdout };
    } catch {
      return { code: null, stdout: "", failure: "spawn" };
    }
  };
}

async function captureCapped(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ stdout: string; oversized: boolean }> {
  if (stream === null) return { stdout: "", oversized: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let oversized = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        oversized = true;
        break;
      }
      chunks.push(value);
    }
  } catch {
    return { stdout: "", oversized: true };
  } finally {
    try {
      await reader.cancel();
    } catch {
      // best effort
    }
  }
  return {
    stdout: oversized ? "" : Buffer.concat(chunks).toString("utf8"),
    oversized,
  };
}

async function stopProcess(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  try {
    proc.kill();
  } catch {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    proc.exited.then(() => true).catch(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), 1_000);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (!settled) {
    try {
      proc.kill(9);
    } catch {
      // best effort
    }
  }
}

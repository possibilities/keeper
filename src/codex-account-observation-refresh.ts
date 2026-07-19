import { mkdirSync } from "node:fs";
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
  parseCodexObserverOutcome,
  readCodexObservationSidecar,
  writeCodexObservationSidecar,
} from "./codex-account-observation";
import { FileLock } from "./file-lock";

export type CodexExactArgvRunner = (
  argv: readonly string[],
) => Promise<CodexObserverRunOutcome>;

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
    const observation = await observeCodexOnce(deps);
    if (observation === null) {
      return readCodexObservationSidecar(sidecarPath);
    }
    publishCodexObservation(deps.stateDir, observation);
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

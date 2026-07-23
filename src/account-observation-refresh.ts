/**
 * Shared, DB-free claude-swap observation refresh boundary. One exact-argv
 * inventory call is bounded, normalized, and atomically published under a
 * nonblocking refresh lock.
 */

import { mkdirSync } from "node:fs";
import {
  buildObservation,
  isObservationFresh,
  type Observation,
  type ProviderRunOutcome,
  parseCswapList,
  readObservationSidecar,
  writeObservationSidecar,
} from "./account-observation";
import {
  cswapListArgv,
  MAX_OUTPUT_BYTES,
  observationRefreshLockPath,
  observationSidecarPath,
  SUBPROCESS_TIMEOUT_MS,
} from "./account-routing-config";
import { FileLock } from "./file-lock";

export type ExactArgvRunner = (
  argv: string[],
  signal?: AbortSignal,
) => Promise<ProviderRunOutcome>;

export interface ObserveDeps {
  runner: ExactArgvRunner;
  nowMs: () => number;
  cswapArgv?: string[];
  signal?: AbortSignal;
}

export async function observeOnce(deps: ObserveDeps): Promise<Observation> {
  const outcome = await deps.runner(
    deps.cswapArgv ?? cswapListArgv(),
    deps.signal,
  );
  const observedAtMs = deps.nowMs();
  return buildObservation({
    observedAtMs,
    cswap: parseCswapList(outcome, observedAtMs),
  });
}

export function publishObservation(stateDir: string, obs: Observation): void {
  mkdirSync(stateDir, { recursive: true });
  writeObservationSidecar(observationSidecarPath(stateDir), obs);
}

export interface RefreshLock {
  release(): void;
}

export type TryAcquireRefreshLock = (path: string) => RefreshLock | null;

export interface RefreshObservationDeps extends ObserveDeps {
  stateDir: string;
  maxAgeMs: number;
  tryAcquireLock?: TryAcquireRefreshLock;
  sleep?: (ms: number) => Promise<void>;
  contentionWaitMs?: number;
  contentionTimeoutMs?: number;
  /** Acquire the shared lock and call the provider even if a sidecar is fresh. */
  force?: boolean;
  /** Wait boundedly for the lock and accept only this caller's provider call. */
  requireOwnedCall?: boolean;
}

const DEFAULT_CONTENTION_WAIT_MS = 100;
const DEFAULT_CONTENTION_TIMEOUT_MS = SUBPROCESS_TIMEOUT_MS + 1_000;
const realTryAcquireLock: TryAcquireRefreshLock = (path) =>
  FileLock.tryAcquire(path);
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How one provider-safe refresh resolved, so a caller can distinguish a
 * completed provider call from a withheld one without re-deriving state.
 * `contended` means the refresh lock stayed held for the whole bounded wait,
 * so this attempt withheld its own provider call rather than pile a second on.
 */
export type RefreshOutcome =
  | "already-fresh"
  | "peer-published"
  | "refreshed"
  | "contended";

export interface RefreshResult {
  outcome: RefreshOutcome;
  /** Best available observation after the attempt, or null when none exists. */
  observation: Observation | null;
}

/**
 * The shared provider-safe refresh both the observer cadence and an on-demand
 * launch refresh run through: at most one bounded `cswap` call under a
 * nonblocking lock, with contention bounded to a re-read rather than a second
 * provider call.
 */
export async function runProviderSafeRefresh(
  deps: RefreshObservationDeps,
): Promise<RefreshResult> {
  const sidecar = observationSidecarPath(deps.stateDir);
  const freshSidecar = (): Observation | null => {
    const observation = readObservationSidecar(sidecar);
    return observation &&
      isObservationFresh(observation, deps.nowMs(), deps.maxAgeMs)
      ? observation
      : null;
  };
  const before = freshSidecar();
  if (!deps.force && !deps.requireOwnedCall && before) {
    return { outcome: "already-fresh", observation: before };
  }

  mkdirSync(deps.stateDir, { recursive: true });
  const acquire = deps.tryAcquireLock ?? realTryAcquireLock;
  const lockPath = observationRefreshLockPath(deps.stateDir);
  const sleep = deps.sleep ?? realSleep;
  const waitMs = Math.max(
    1,
    deps.contentionWaitMs ?? DEFAULT_CONTENTION_WAIT_MS,
  );
  let remainingMs = Math.max(
    0,
    deps.contentionTimeoutMs ?? DEFAULT_CONTENTION_TIMEOUT_MS,
  );
  let lock = acquire(lockPath);
  while (lock === null && remainingMs > 0) {
    const delay = Math.min(waitMs, remainingMs);
    await sleep(delay);
    remainingMs -= delay;
    const published = freshSidecar();
    if (
      !deps.requireOwnedCall &&
      published &&
      (!deps.force ||
        before === null ||
        published.observed_at_ms > before.observed_at_ms)
    ) {
      return { outcome: "peer-published", observation: published };
    }
    lock = acquire(lockPath);
  }
  if (lock === null) {
    return {
      outcome: "contended",
      observation: readObservationSidecar(sidecar),
    };
  }

  try {
    const underLock = freshSidecar();
    if (!deps.force && !deps.requireOwnedCall && underLock) {
      return { outcome: "peer-published", observation: underLock };
    }
    const observation = await observeOnce(deps);
    publishObservation(deps.stateDir, observation);
    return { outcome: "refreshed", observation };
  } finally {
    lock.release();
  }
}

export async function refreshObservationIfStale(
  deps: RefreshObservationDeps,
): Promise<Observation | null> {
  return (await runProviderSafeRefresh(deps)).observation;
}

/** Preserve the caller environment; no retired provider-specific flags exist. */
export function providerSubprocessEnvironment(
  inherited: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  return { ...inherited };
}

export interface BoundedRunnerProcess {
  stdout: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(signal?: number): void;
}

export type SpawnBoundedRunnerProcess = (
  argv: string[],
  environment: Record<string, string | undefined>,
) => BoundedRunnerProcess;

export interface BoundedRunnerOptions {
  timeoutMs?: number;
  maxBytes?: number;
  inheritedEnvironment?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  spawn?: SpawnBoundedRunnerProcess;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  terminationGraceMs?: number;
  postKillWaitMs?: number;
  setTerminationTimer?: (callback: () => void, ms: number) => unknown;
  clearTerminationTimer?: (timer: unknown) => void;
}

const defaultSpawnBoundedRunnerProcess: SpawnBoundedRunnerProcess = (
  argv,
  environment,
) =>
  Bun.spawn(argv, {
    env: environment,
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });

export function makeBoundedRunner(
  options?: BoundedRunnerOptions,
): ExactArgvRunner;
export function makeBoundedRunner(
  timeoutMs?: number,
  maxBytes?: number,
  inheritedEnvironment?: Readonly<Record<string, string | undefined>>,
): ExactArgvRunner;
export function makeBoundedRunner(
  optionsOrTimeout?: BoundedRunnerOptions | number,
  legacyMaxBytes: number = MAX_OUTPUT_BYTES,
  legacyEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): ExactArgvRunner {
  const options: BoundedRunnerOptions =
    typeof optionsOrTimeout === "object"
      ? optionsOrTimeout
      : {
          timeoutMs: optionsOrTimeout,
          maxBytes: legacyMaxBytes,
          inheritedEnvironment: legacyEnvironment,
        };
  const timeoutMs = Math.max(1, options.timeoutMs ?? SUBPROCESS_TIMEOUT_MS);
  const maxBytes = Math.max(1, options.maxBytes ?? MAX_OUTPUT_BYTES);
  const environment = providerSubprocessEnvironment(
    options.inheritedEnvironment,
  );
  const spawn = options.spawn ?? defaultSpawnBoundedRunnerProcess;
  const setTimer =
    options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ??
    ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const terminationGraceMs = Math.max(1, options.terminationGraceMs ?? 1_000);
  const postKillWaitMs = Math.max(1, options.postKillWaitMs ?? 1_000);
  const setTerminationTimer =
    options.setTerminationTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTerminationTimer =
    options.clearTerminationTimer ??
    ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));

  const cleanUp = async (
    proc: BoundedRunnerProcess,
    capture: CappedCapture,
  ): Promise<void> => {
    await Promise.all([
      stopProcess(
        proc,
        terminationGraceMs,
        postKillWaitMs,
        setTerminationTimer,
        clearTerminationTimer,
      ),
      settleWithin(
        capture.cancel(),
        postKillWaitMs,
        setTerminationTimer,
        clearTerminationTimer,
      ),
    ]);
  };

  return async (argv, invocationSignal): Promise<ProviderRunOutcome> => {
    const signal = invocationSignal ?? options.signal;
    if (signal?.aborted) {
      return { code: null, stdout: "", failure: "aborted" };
    }
    let proc: BoundedRunnerProcess | undefined;
    let captured: CappedCapture | undefined;
    try {
      if (argv.length === 0 || argv.some((part) => part.length === 0)) {
        return { code: null, stdout: "", failure: "spawn" };
      }
      proc = spawn([...argv], environment);
      captured = captureCapped(proc.stdout, maxBytes);
      const timedOut = Symbol("timed-out");
      const aborted = Symbol("aborted");
      const oversized = Symbol("oversized");
      let timer: unknown;
      const timeout = new Promise<typeof timedOut>((resolve) => {
        timer = setTimer(() => resolve(timedOut), timeoutMs);
      });
      let abortListener: (() => void) | undefined;
      const abort = new Promise<typeof aborted>((resolve) => {
        abortListener = () => resolve(aborted);
        signal?.addEventListener("abort", abortListener, { once: true });
        if (signal?.aborted) abortListener();
      });
      const oversizedOutput = captured.settled.then((value) =>
        value.oversized
          ? oversized
          : new Promise<never>(() => {
              return;
            }),
      );
      const completed = Promise.all([
        proc.exited.then(
          (code) => ({ kind: "exited" as const, code }),
          () => ({ kind: "failed" as const }),
        ),
        captured.settled,
      ] as const);
      const race = await Promise.race([
        completed,
        timeout,
        abort,
        oversizedOutput,
      ]);
      if (timer !== undefined) clearTimer(timer);
      if (abortListener !== undefined) {
        signal?.removeEventListener("abort", abortListener);
      }
      if (race === timedOut || race === aborted || race === oversized) {
        await cleanUp(proc, captured);
        return {
          code: null,
          stdout: "",
          failure:
            race === timedOut
              ? "timeout"
              : race === aborted
                ? "aborted"
                : "oversize",
        };
      }
      const [exit, output] = race;
      if (exit.kind === "failed") {
        await cleanUp(proc, captured);
        return { code: null, stdout: "", failure: "spawn" };
      }
      return output.oversized
        ? { code: null, stdout: "", failure: "oversize" }
        : { code: exit.code, stdout: output.stdout };
    } catch {
      if (proc !== undefined && captured !== undefined) {
        await cleanUp(proc, captured);
      } else if (proc !== undefined) {
        await stopProcess(
          proc,
          terminationGraceMs,
          postKillWaitMs,
          setTerminationTimer,
          clearTerminationTimer,
        );
      }
      return { code: null, stdout: "", failure: "spawn" };
    }
  };
}

interface CapturedOutput {
  stdout: string;
  oversized: boolean;
}

interface CappedCapture {
  settled: Promise<CapturedOutput>;
  cancel(): Promise<void>;
}

function captureCapped(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): CappedCapture {
  if (stream === null) {
    return {
      settled: Promise.resolve({ stdout: "", oversized: false }),
      cancel: async () => {},
    };
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let cancelPromise: Promise<void> | null = null;
  const settled = (async (): Promise<CapturedOutput> => {
    let total = 0;
    let oversized = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          oversized = true;
          try {
            await reader.cancel();
          } catch {
            // best effort
          }
          break;
        }
        chunks.push(value);
      }
    } catch {
      oversized = true;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // A broken stream may reject release while cancellation settles.
      }
    }
    return {
      stdout: oversized ? "" : Buffer.concat(chunks).toString("utf8"),
      oversized,
    };
  })();
  return {
    settled,
    cancel: () => {
      cancelPromise ??= (async () => {
        try {
          await reader.cancel();
        } catch {
          // best effort
        }
        await settled.catch(() => undefined);
      })();
      return cancelPromise;
    },
  };
}

async function settleWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
  setTimer: (callback: () => void, ms: number) => unknown,
  clearTimer: (timer: unknown) => void,
): Promise<void> {
  let timer: unknown;
  const deadline = Symbol("deadline");
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<typeof deadline>((resolve) => {
      timer = setTimer(() => resolve(deadline), timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimer(timer);
}

async function stopProcess(
  proc: BoundedRunnerProcess,
  graceMs: number,
  postKillWaitMs: number,
  setTimer: (callback: () => void, ms: number) => unknown,
  clearTimer: (timer: unknown) => void,
): Promise<void> {
  try {
    proc.kill();
  } catch {
    // It may already have exited; still join its exit promise below.
  }
  const exited = proc.exited.then(() => true).catch(() => true);
  let graceTimer: unknown;
  const graceElapsed = Symbol("grace-elapsed");
  const settled = await Promise.race([
    exited,
    new Promise<typeof graceElapsed>((resolve) => {
      graceTimer = setTimer(() => resolve(graceElapsed), graceMs);
    }),
  ]);
  if (graceTimer !== undefined) clearTimer(graceTimer);
  if (settled !== graceElapsed) return;

  try {
    proc.kill(9);
  } catch {
    // It may have exited between the grace timer and the signal.
  }
  await settleWithin(exited, postKillWaitMs, setTimer, clearTimer);
}

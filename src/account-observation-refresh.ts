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

export type ExactArgvRunner = (argv: string[]) => Promise<ProviderRunOutcome>;

export interface ObserveDeps {
  runner: ExactArgvRunner;
  nowMs: () => number;
  cswapArgv?: string[];
}

export async function observeOnce(deps: ObserveDeps): Promise<Observation> {
  const outcome = await deps.runner(deps.cswapArgv ?? cswapListArgv());
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
}

const DEFAULT_CONTENTION_WAIT_MS = 100;
const DEFAULT_CONTENTION_TIMEOUT_MS = SUBPROCESS_TIMEOUT_MS + 1_000;
const realTryAcquireLock: TryAcquireRefreshLock = (path) =>
  FileLock.tryAcquire(path);
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function refreshObservationIfStale(
  deps: RefreshObservationDeps,
): Promise<Observation | null> {
  const sidecar = observationSidecarPath(deps.stateDir);
  const freshSidecar = (): Observation | null => {
    const observation = readObservationSidecar(sidecar);
    return observation &&
      isObservationFresh(observation, deps.nowMs(), deps.maxAgeMs)
      ? observation
      : null;
  };
  const before = freshSidecar();
  if (before) return before;

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
    if (published) return published;
    lock = acquire(lockPath);
  }
  if (lock === null) return readObservationSidecar(sidecar);

  try {
    const underLock = freshSidecar();
    if (underLock) return underLock;
    const observation = await observeOnce(deps);
    publishObservation(deps.stateDir, observation);
    return observation;
  } finally {
    lock.release();
  }
}

/** Preserve the caller environment; no retired provider-specific flags exist. */
export function providerSubprocessEnvironment(
  inherited: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  return { ...inherited };
}

export function makeBoundedRunner(
  timeoutMs: number = SUBPROCESS_TIMEOUT_MS,
  maxBytes: number = MAX_OUTPUT_BYTES,
  inheritedEnvironment: Readonly<
    Record<string, string | undefined>
  > = process.env,
): ExactArgvRunner {
  return async (argv: string[]): Promise<ProviderRunOutcome> => {
    try {
      const proc = Bun.spawn(argv, {
        env: providerSubprocessEnvironment(inheritedEnvironment),
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = Symbol("timed-out");
      const timeout = new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs);
      });
      const drain = readCapped(proc.stdout, maxBytes);
      const race = await Promise.race([proc.exited, timeout]);
      if (timer !== undefined) clearTimeout(timer);
      if (race === timedOut) {
        try {
          proc.kill();
        } catch {
          // already dead
        }
        const killGrace = Symbol("kill-grace");
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const settled = await Promise.race([
          proc.exited,
          new Promise<typeof killGrace>((resolve) => {
            killTimer = setTimeout(() => resolve(killGrace), 1_000);
          }),
        ]).catch(() => killGrace);
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (settled === killGrace) {
          try {
            proc.kill(9);
          } catch {
            // best effort
          }
        }
        return { code: null, stdout: "", failure: "timeout" };
      }
      return { code: race, stdout: await drain };
    } catch {
      return { code: null, stdout: "", failure: "spawn" };
    }
  };
}

async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (stream == null) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total > maxBytes) break;
    }
  } catch {
    // Strict parsing decides whether captured output is usable.
  } finally {
    try {
      await reader.cancel();
    } catch {
      // best effort
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

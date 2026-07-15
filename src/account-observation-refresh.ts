/**
 * Shared, DB-free observation refresh boundary. It serializes only a single
 * refresh, double-checks freshness under that lock, runs the three exact-argv
 * provider calls concurrently, and atomically replaces the PII-free sidecar.
 */

import { mkdirSync } from "node:fs";
import {
  buildObservation,
  isObservationFresh,
  type Observation,
  type ProviderRunOutcome,
  parseCodexBar,
  parseCodexBarCodex,
  parseCswapList,
  readObservationSidecar,
  writeObservationSidecar,
} from "./account-observation";
import {
  claudeCodexBarUsageArgv,
  codexCodexBarUsageArgv,
  cswapListArgv,
  MAX_OUTPUT_BYTES,
  observationRefreshLockPath,
  observationSidecarPath,
  ROUTE_MEASUREMENT_FRESHNESS_CEILING_MS,
  SUBPROCESS_TIMEOUT_MS,
} from "./account-routing-config";
import { FileLock } from "./file-lock";

/** Exact argv only; no command strings or shell interpretation. */
export type ExactArgvRunner = (argv: string[]) => Promise<ProviderRunOutcome>;

export interface ObserveDeps {
  runner: ExactArgvRunner;
  nowMs: () => number;
  claudeCodexbarArgv?: string[];
  codexCodexbarArgv?: string[];
  /** Compatibility alias for the Claude provider argv. */
  codexbarArgv?: string[];
  cswapArgv?: string[];
  freshnessCeilingMs?: number;
}

/** Fetch all independent providers concurrently and normalize one observation. */
export async function observeOnce(deps: ObserveDeps): Promise<Observation> {
  const claudeArgv =
    deps.claudeCodexbarArgv ?? deps.codexbarArgv ?? claudeCodexBarUsageArgv();
  const codexArgv = deps.codexCodexbarArgv ?? codexCodexBarUsageArgv();
  const cswapArgv = deps.cswapArgv ?? cswapListArgv();
  const [claudeOutcome, codexOutcome, cswapOutcome] = await Promise.all([
    deps.runner(claudeArgv),
    deps.runner(codexArgv),
    deps.runner(cswapArgv),
  ]);
  const observedAtMs = deps.nowMs();
  return buildObservation({
    observedAtMs,
    codex: parseCodexBar(claudeOutcome),
    codexCapacity: parseCodexBarCodex(codexOutcome),
    cswap: parseCswapList(
      cswapOutcome,
      observedAtMs,
      deps.freshnessCeilingMs ?? ROUTE_MEASUREMENT_FRESHNESS_CEILING_MS,
    ),
  });
}

/** Ensure the state root exists, then atomically publish its sole observation. */
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
  /** Caller-specific age threshold; foreground and worker callers may differ. */
  maxAgeMs: number;
  tryAcquireLock?: TryAcquireRefreshLock;
  /** Injectable bounded contention wait; production never spins. */
  sleep?: (ms: number) => Promise<void>;
  /** Delay between non-blocking lock attempts. */
  contentionWaitMs?: number;
  /** Total time allowed for another refresher to publish. */
  contentionTimeoutMs?: number;
}

const DEFAULT_CONTENTION_WAIT_MS = 100;
const DEFAULT_CONTENTION_TIMEOUT_MS = SUBPROCESS_TIMEOUT_MS + 1_000;

const realTryAcquireLock: TryAcquireRefreshLock = (path) =>
  FileLock.tryAcquire(path);

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Return a fresh existing observation or refresh it once. Lock contention is a
 * normal bounded wait: repeatedly re-read the sidecar and retry the nonblocking
 * lock until the active publisher lands or the provider-sized deadline expires.
 */
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
  if (lock === null) {
    return readObservationSidecar(sidecar);
  }

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

const CODEXBAR_DISABLE_KEYCHAIN_ACCESS = "CODEXBAR_DISABLE_KEYCHAIN_ACCESS";

/** Force headless CodexBar operation for every provider child. */
export function providerSubprocessEnvironment(
  inherited: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  return {
    ...inherited,
    [CODEXBAR_DISABLE_KEYCHAIN_ACCESS]: "1",
  };
}

/** Build the no-shell, output-capped, deadline-bounded production runner. */
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
            // best effort; the caller still receives an unavailable outcome
          }
        }
        return { code: null, stdout: "" };
      }
      return { code: race, stdout: await drain };
    } catch {
      return { code: null, stdout: "" };
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
    // Return captured output; strict parsing decides whether it is usable.
  } finally {
    try {
      await reader.cancel();
    } catch {
      // best effort
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

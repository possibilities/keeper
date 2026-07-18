/**
 * Supervised producer for the latest claude-swap Capacity observation. It owns
 * no DB handle and publishes one private, replace-in-place sidecar. Provider and
 * I/O failures are nonfatal to the loop; launches fail closed when no fresh
 * routeable account is available.
 */

import { mkdirSync } from "node:fs";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import {
  type ExactArgvRunner,
  makeBoundedRunner,
  type ObserveDeps,
  observeOnce,
  providerSubprocessEnvironment,
  publishObservation,
  refreshObservationIfStale,
  type TryAcquireRefreshLock,
} from "./account-observation-refresh";
import {
  cswapListArgv,
  OBSERVE_INTERVAL_MS,
  OBSERVE_JITTER_MS,
  resolveAccountRoutingRoot,
  resolveCswapCommand,
} from "./account-routing-config";

export {
  makeBoundedRunner,
  observeOnce,
  providerSubprocessEnvironment,
  publishObservation,
};
export type { ExactArgvRunner, ObserveDeps };

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ObserverClock {
  nowMs: () => number;
  uniform: (lo: number, hi: number) => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const REAL_OBSERVER_CLOCK: ObserverClock = {
  nowMs: () => Date.now(),
  uniform: (lo, hi) => lo + Math.random() * (hi - lo),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }),
};

export interface AccountObserverDeps {
  stateDir: string;
  runner: ExactArgvRunner;
  clock: ObserverClock;
  shutdownSignal: AbortSignal;
  cswapArgv?: string[];
  tryAcquireLock?: TryAcquireRefreshLock;
  contentionWaitMs?: number;
  contentionTimeoutMs?: number;
}

export class AccountObserver {
  constructor(private readonly deps: AccountObserverDeps) {}

  async runCycleNoThrow(): Promise<void> {
    try {
      await refreshObservationIfStale({
        stateDir: this.deps.stateDir,
        runner: this.deps.runner,
        nowMs: this.deps.clock.nowMs,
        maxAgeMs: Math.max(0, OBSERVE_INTERVAL_MS - 1),
        cswapArgv: this.deps.cswapArgv,
        tryAcquireLock: this.deps.tryAcquireLock,
        contentionWaitMs: this.deps.contentionWaitMs,
        contentionTimeoutMs: this.deps.contentionTimeoutMs,
        sleep: (ms) => this.deps.clock.sleep(ms, this.deps.shutdownSignal),
      });
    } catch (err) {
      console.error(
        `[account-observer] cycle threw (non-fatal): ${stringifyErr(err)}`,
      );
    }
  }

  async run(): Promise<void> {
    const { clock, shutdownSignal } = this.deps;
    while (!shutdownSignal.aborted) {
      await this.runCycleNoThrow();
      if (shutdownSignal.aborted) return;
      await clock.sleep(
        OBSERVE_INTERVAL_MS + clock.uniform(0, OBSERVE_JITTER_MS),
        shutdownSignal,
      );
    }
  }
}

export interface AccountObserverWorkerData {
  stateDir: string;
}

function main(): void {
  if (!parentPort) {
    console.error("[account-observer] no parentPort — not running as a Worker");
    process.exit(1);
  }
  const data = workerData as AccountObserverWorkerData | undefined;
  const stateDir =
    data && typeof data.stateDir === "string" && data.stateDir.length > 0
      ? data.stateDir
      : resolveAccountRoutingRoot();
  try {
    mkdirSync(stateDir, { recursive: true });
  } catch (err) {
    console.error(
      `[account-observer] could not prepare state dir ${stateDir} (${stringifyErr(err)}); exiting`,
    );
    process.exit(1);
  }

  const shutdownController = new AbortController();
  const cswapBin = resolveCswapCommand();
  const observer = new AccountObserver({
    stateDir,
    runner: makeBoundedRunner(),
    clock: REAL_OBSERVER_CLOCK,
    shutdownSignal: shutdownController.signal,
    cswapArgv: cswapListArgv(cswapBin),
  });
  observer
    .run()
    .then(() => {
      if (!shutdownController.signal.aborted) {
        console.error("[account-observer] loop settled unexpectedly");
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error(
        `[account-observer] loop threw unexpectedly: ${stringifyErr(err)}`,
      );
      process.exit(1);
    });

  parentPort.on("message", (msg: { type?: string } | undefined) => {
    if (msg?.type === "shutdown") {
      shutdownController.abort();
      process.exit(0);
    }
  });
}

if (!isMainThread) main();

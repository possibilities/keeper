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
  type RefreshResult,
  runProviderSafeRefresh,
  type TryAcquireRefreshLock,
} from "./account-observation-refresh";
import {
  cswapListArgv,
  OBSERVATION_FRESHNESS_CEILING_MS,
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

function logToStderr(message: string): void {
  console.error(message);
}

/** PII-free cause phrase for the at-risk cadence line. */
function cadenceCause(result: RefreshResult): string {
  if (result.outcome === "contended") return "refresh-lock contention";
  const observation = result.observation;
  if (observation === null) return "no published observation";
  if (observation.health !== "ok")
    return `provider health ${observation.health}`;
  return "delayed refresh";
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
  /** Bounded diagnostic sink; defaults to worker stderr. */
  logLine?: (message: string) => void;
}

export class AccountObserver {
  /** `observed_at_ms` of the last fresh, healthy publish this observer saw. */
  private lastFreshSuccessMs: number | null = null;
  /** One at-risk line per episode; cleared by the next fresh success. */
  private cadenceAtRiskLogged = false;

  constructor(private readonly deps: AccountObserverDeps) {}

  async runCycleNoThrow(): Promise<void> {
    try {
      const result = await runProviderSafeRefresh({
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
      this.noteCadence(result);
    } catch (err) {
      this.log(
        `[account-observer] cycle threw (non-fatal): ${stringifyErr(err)}`,
      );
    }
  }

  /**
   * Emit one bounded at-risk line when a cycle leaves the snapshot old enough
   * that the launch freshness ceiling is within one interval of breaching, or a
   * contention skip lands already past half the ceiling — so the next stale
   * refusal is diagnosable from logs, not archaeology. Fires once per episode.
   */
  private noteCadence(result: RefreshResult): void {
    const now = this.deps.clock.nowMs();
    const observation = result.observation;
    if (observation !== null && observation.health === "ok") {
      this.lastFreshSuccessMs = Math.max(
        this.lastFreshSuccessMs ?? Number.NEGATIVE_INFINITY,
        observation.observed_at_ms,
      );
    }
    const sinceSuccessMs =
      this.lastFreshSuccessMs === null ? null : now - this.lastFreshSuccessMs;
    // Cadence keeps up while the last healthy observation is younger than one
    // observer interval; the launch ceiling is a laxer, downstream bound.
    if (sinceSuccessMs !== null && sinceSuccessMs <= OBSERVE_INTERVAL_MS) {
      this.cadenceAtRiskLogged = false;
      return;
    }
    const cadenceDrifted =
      sinceSuccessMs === null ||
      sinceSuccessMs > OBSERVATION_FRESHNESS_CEILING_MS - OBSERVE_INTERVAL_MS;
    const contentionAtRisk =
      result.outcome === "contended" &&
      sinceSuccessMs !== null &&
      sinceSuccessMs > OBSERVATION_FRESHNESS_CEILING_MS / 2;
    if (!(cadenceDrifted || contentionAtRisk) || this.cadenceAtRiskLogged) {
      return;
    }
    this.cadenceAtRiskLogged = true;
    const since =
      sinceSuccessMs === null
        ? "no fresh observation yet"
        : `${Math.round(sinceSuccessMs / 1000)}s since last fresh observation`;
    this.log(
      `[account-observer] refresh cadence at risk (${cadenceCause(result)}); ` +
        `${since}, ceiling ${OBSERVATION_FRESHNESS_CEILING_MS / 1000}s`,
    );
  }

  private log(message: string): void {
    (this.deps.logLine ?? logToStderr)(message);
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

/**
 * The Capacity-observation PRODUCER worker. On a bounded cadence it asks the
 * shared refresher for Claude + Codex CodexBar capacity and claude-swap managed
 * inventory. A stale cycle uses an injected exact-argv runner and atomically
 * publishes ONE user-private observation sidecar; fresh cycles do no provider
 * work. It retains no observation history.
 *
 * **Optional and bounded, never a source of truth.** Missing, unhealthy, or
 * unlaunchable providers degrade to a native-default observation; a subprocess is
 * force-killed at its deadline; the whole cycle is no-throw so an observation
 * failure never reaches the worker's `onerror`/`fatalExit` path. The sidecar is
 * the observer's SOLE output — it posts nothing to main and holds no DB handle
 * (main stays the sole event writer).
 *
 * The per-launch router consumes Claude route capacity from this sidecar, while
 * foreground quota controls consume its Codex capacity. Neither read path invokes
 * a provider directly while the shared observation is fresh for that caller.
 *
 * DB-free island: `node:*` + this subsystem's own dep-free helpers only, never
 * `src/db.ts`. `isMainThread`-guarded — a plain import (tests driving `observeOnce`
 * / the loop with a stub runner + a sandboxed state dir) is inert.
 */

import { mkdirSync } from "node:fs";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { Observation } from "./account-observation";
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
  codexBarClaudeUsageArgv,
  codexBarCodexUsageArgv,
  OBSERVE_INTERVAL_MS,
  OBSERVE_JITTER_MS,
  resolveAccountRoutingRoot,
  resolveCodexBarCommand,
} from "./account-routing-config";
import {
  isCodexBarObservationCurrent,
  makeAuthorizedCodexBarRunner,
} from "./codexbar-authorization";

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

// ---------- loop clock (injectable) -----------------------------------------

/** Clock + jitter + sleep the observer loop reads — injectable so tests pin them. */
export interface ObserverClock {
  nowMs: () => number;
  uniform: (lo: number, hi: number) => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Production clock: real `Date`, `Math.random` jitter, abortable timer-sleep. */
export const REAL_OBSERVER_CLOCK: ObserverClock = {
  nowMs: () => Date.now(),
  uniform: (lo, hi) => lo + Math.random() * (hi - lo),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const t = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(t);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }),
};

// ---------- the observer loop -----------------------------------------------

/** Dependencies the {@link AccountObserver} loop runs against — injectable. */
export interface AccountObserverDeps {
  stateDir: string;
  runner: ExactArgvRunner;
  clock: ObserverClock;
  shutdownSignal: AbortSignal;
  codexbarArgv?: string[];
  codexCodexbarArgv?: string[];
  cswapArgv?: string[];
  /** Test seam: production defaults to the real non-blocking FileLock. */
  tryAcquireLock?: TryAcquireRefreshLock;
  /** Test seams for bounded refresh-lock contention. */
  contentionWaitMs?: number;
  contentionTimeoutMs?: number;
  /** Reject sidecar state from a superseded or unauthorized generation. */
  acceptObservation?: (observation: Observation) => boolean;
}

/**
 * The observer's scheduling loop. Runs CONTINUOUSLY until `shutdownSignal`
 * aborts. Each cycle observes and publishes; the WHOLE cycle is no-throw so a
 * provider/IO failure degrades to a logged line and continues — it NEVER escapes
 * to the worker's error path. Exported + dependency-injected so a test drives a
 * full cycle with a stub runner, a pinned clock, and a sandboxed state dir — no
 * real subprocess, worker, or daemon.
 */
export class AccountObserver {
  constructor(private readonly deps: AccountObserverDeps) {}

  /** One cycle: observe + publish. No-throw — returns nothing, logs on failure. */
  async runCycleNoThrow(): Promise<void> {
    try {
      await refreshObservationIfStale({
        stateDir: this.deps.stateDir,
        runner: this.deps.runner,
        nowMs: this.deps.clock.nowMs,
        // `isObservationFresh` is inclusive; one millisecond less makes an
        // N-millisecond observer wake refresh at the N boundary, not 2N.
        maxAgeMs: Math.max(0, OBSERVE_INTERVAL_MS - 1),
        codexbarArgv: this.deps.codexbarArgv,
        codexCodexbarArgv: this.deps.codexCodexbarArgv,
        cswapArgv: this.deps.cswapArgv,
        tryAcquireLock: this.deps.tryAcquireLock,
        contentionWaitMs: this.deps.contentionWaitMs,
        contentionTimeoutMs: this.deps.contentionTimeoutMs,
        acceptObservation: this.deps.acceptObservation,
        sleep: (ms) => this.deps.clock.sleep(ms, this.deps.shutdownSignal),
      });
    } catch (err) {
      console.error(
        `[account-observer] cycle threw (non-fatal): ${stringifyErr(err)}`,
      );
    }
  }

  /** Run forever (until shutdown). Each iteration is internally no-throw. */
  async run(): Promise<void> {
    const { clock, shutdownSignal } = this.deps;
    while (!shutdownSignal.aborted) {
      await this.runCycleNoThrow();
      if (shutdownSignal.aborted) {
        return;
      }
      const sleepMs = OBSERVE_INTERVAL_MS + clock.uniform(0, OBSERVE_JITTER_MS);
      await clock.sleep(sleepMs, shutdownSignal);
    }
  }
}

// ---------- worker data + entrypoint ----------------------------------------

/** Data the parent passes via `new Worker(url, { workerData })`. */
export interface AccountObserverWorkerData {
  /** Resolved account-routing state root (the sandbox seam threads through here). */
  stateDir: string;
}

/**
 * Worker entrypoint. Resolves the state root, builds the production runner +
 * clock, and runs the {@link AccountObserver} loop. Each stale refresh takes its
 * own non-blocking lock; contention skips that cycle without ending the worker.
 * An unwritable root or unexpectedly settled loop exits nonzero so the daemon's
 * supervisor owns recovery. Shutdown aborts the loop sleep and exits 0.
 */
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
  const codexbarBin = resolveCodexBarCommand();
  const observer = new AccountObserver({
    stateDir,
    runner: makeAuthorizedCodexBarRunner({
      stateDir,
      codexbarBin,
      runner: makeBoundedRunner(),
      onBlocked: (provider, failure) => {
        console.error(
          `[account-observer] CodexBar ${provider} authorization blocked after ` +
            `${failure ?? "provider failure"}; run ` +
            "keeper agent accounts authorize-codexbar",
        );
      },
    }),
    clock: REAL_OBSERVER_CLOCK,
    shutdownSignal: shutdownController.signal,
    codexbarArgv: codexBarClaudeUsageArgv(codexbarBin),
    codexCodexbarArgv: codexBarCodexUsageArgv(codexbarBin),
    acceptObservation: (observation) =>
      isCodexBarObservationCurrent({
        binarySha256: observation.codexbar_binary_sha256,
        codexbarBin,
      }),
  });
  // The loop is internally no-throw. Any unexpected settle outside an orderly
  // shutdown is nevertheless fatal so main's worker supervisor owns recovery.
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
    if (msg && msg.type === "shutdown") {
      shutdownController.abort();
      process.exit(0);
    }
  });
}

// Only run inside a real Worker; a plain import on the main thread (tests driving
// the pure helpers + AccountObserver with a stub runner) is inert.
if (!isMainThread) {
  main();
}

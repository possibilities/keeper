import { mkdirSync } from "node:fs";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import {
  CODEX_OBSERVE_INTERVAL_MS,
  CODEX_OBSERVE_JITTER_MS,
  codexObserverArgv,
  resolveCodexAccountRoutingRoot,
  resolveCodexObserverCommand,
} from "./account-routing-config";
import {
  type CodexExactArgvRunner,
  type CodexObservationRefreshFailureState,
  makeCodexBoundedRunner,
  refreshCodexObservationIfStale,
  type TryAcquireCodexRefreshLock,
} from "./codex-account-observation-refresh";

export interface CodexAccountObserverClock {
  nowMs(): number;
  uniform(lo: number, hi: number): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const REAL_CODEX_OBSERVER_CLOCK: CodexAccountObserverClock = {
  nowMs: () => Date.now(),
  uniform: (lo, hi) => lo + Math.random() * (hi - lo),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    }),
};

const MAX_REFRESH_FAILURE_LOG_CHARS = 160;

function logRefreshFailure(state: CodexObservationRefreshFailureState): void {
  console.error(
    (
      `[codex-account-observer] refresh failed class=${state.last_failure_class ?? "unknown"} ` +
      `consecutive=${state.consecutive_failures}`
    ).slice(0, MAX_REFRESH_FAILURE_LOG_CHARS),
  );
}

export interface CodexAccountObserverDeps {
  stateDir: string;
  runner: CodexExactArgvRunner;
  clock: CodexAccountObserverClock;
  shutdownSignal: AbortSignal;
  observerArgv?: readonly string[];
  tryAcquireLock?: TryAcquireCodexRefreshLock;
  contentionWaitMs?: number;
  contentionTimeoutMs?: number;
}

export class CodexAccountObserver {
  constructor(private readonly deps: CodexAccountObserverDeps) {}

  async runCycleNoThrow(): Promise<void> {
    try {
      await refreshCodexObservationIfStale({
        stateDir: this.deps.stateDir,
        runner: this.deps.runner,
        nowMs: this.deps.clock.nowMs,
        maxAgeMs: Math.max(0, CODEX_OBSERVE_INTERVAL_MS - 1),
        observerArgv: this.deps.observerArgv,
        tryAcquireLock: this.deps.tryAcquireLock,
        contentionWaitMs: this.deps.contentionWaitMs,
        contentionTimeoutMs: this.deps.contentionTimeoutMs,
        onRefreshFailure: logRefreshFailure,
        sleep: (ms) => this.deps.clock.sleep(ms, this.deps.shutdownSignal),
      });
    } catch {
      console.error("[codex-account-observer] cycle failed (non-fatal)");
    }
  }

  async run(): Promise<void> {
    while (!this.deps.shutdownSignal.aborted) {
      await this.runCycleNoThrow();
      if (this.deps.shutdownSignal.aborted) return;
      await this.deps.clock.sleep(
        CODEX_OBSERVE_INTERVAL_MS +
          this.deps.clock.uniform(0, CODEX_OBSERVE_JITTER_MS),
        this.deps.shutdownSignal,
      );
    }
  }
}

export interface CodexAccountObserverWorkerData {
  stateDir: string;
}

export interface CodexAccountObserverMainMessage {
  type: "shutdown";
}

function main(): void {
  if (!parentPort) {
    console.error(
      "[codex-account-observer] no parentPort — not running as a Worker",
    );
    process.exit(1);
  }
  const data = workerData as CodexAccountObserverWorkerData | undefined;
  const stateDir =
    data && typeof data.stateDir === "string" && data.stateDir.length > 0
      ? data.stateDir
      : resolveCodexAccountRoutingRoot();
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  } catch {
    console.error(
      "[codex-account-observer] could not prepare state dir; exiting",
    );
    process.exit(1);
  }

  const shutdown = new AbortController();
  const observer = new CodexAccountObserver({
    stateDir,
    runner: makeCodexBoundedRunner({ signal: shutdown.signal }),
    clock: REAL_CODEX_OBSERVER_CLOCK,
    shutdownSignal: shutdown.signal,
    observerArgv: codexObserverArgv(resolveCodexObserverCommand()),
  });
  observer
    .run()
    .then(() => {
      if (shutdown.signal.aborted) {
        process.exit(0);
      }
      console.error("[codex-account-observer] loop settled unexpectedly");
      process.exit(1);
    })
    .catch(() => {
      console.error("[codex-account-observer] loop threw unexpectedly");
      process.exit(1);
    });

  parentPort.on(
    "message",
    (message: CodexAccountObserverMainMessage | undefined) => {
      if (message?.type === "shutdown") shutdown.abort();
    },
  );
}

if (!isMainThread) main();

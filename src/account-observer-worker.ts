/**
 * The Capacity-observation PRODUCER worker. On a bounded cadence it invokes the
 * two installed public CLIs — CodexBar (ambient-account usage + the balancing
 * gate) and `cswap list --json` (managed-account inventory) — through an injected
 * exact-argv runner, validates the payloads with the strict parsers, and
 * atomically publishes ONE user-private observation sidecar. It retains no
 * observation history: each cycle replaces the sidecar in place.
 *
 * **Optional and bounded, never a source of truth.** Missing, unhealthy, or
 * unlaunchable providers degrade to a native-default observation; a subprocess is
 * force-killed at its deadline; the whole cycle is no-throw so an observation
 * failure never reaches the worker's `onerror`/`fatalExit` path. The sidecar is
 * the observer's SOLE output — it posts nothing to main and holds no DB handle
 * (main stays the sole event writer).
 *
 * **Shadow mode.** The observer publishes health + candidate snapshots but the
 * launch path does not yet consume them; the per-launch router is the only seam
 * allowed to read the sidecar for a launch, wired in a later task.
 *
 * DB-free island: `node:*` + this subsystem's own dep-free helpers only, never
 * `src/db.ts`. `isMainThread`-guarded — a plain import (tests driving `observeOnce`
 * / the loop with a stub runner + a sandboxed state dir) is inert.
 */

import { mkdirSync } from "node:fs";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import {
  buildObservation,
  type Observation,
  type ProviderRunOutcome,
  parseCodexBar,
  parseCswapList,
  writeObservationSidecar,
} from "./account-observation";
import {
  codexBarUsageArgv,
  cswapListArgv,
  MAX_OUTPUT_BYTES,
  OBSERVE_INTERVAL_MS,
  OBSERVE_JITTER_MS,
  observationSidecarPath,
  ROUTE_MEASUREMENT_FRESHNESS_CEILING_MS,
  resolveAccountRoutingRoot,
  SUBPROCESS_TIMEOUT_MS,
} from "./account-routing-config";
import { FileLock } from "./file-lock";

/**
 * A bounded, exact-argv command runner — the observer's ONLY window onto the two
 * provider CLIs. Production uses {@link makeBoundedRunner} (no shell, capped
 * output, a hard deadline, concurrent stream drain); tests inject canned outcomes
 * so no real subprocess ever spawns. Never rejects: an un-runnable command
 * resolves `{ code: null, stdout: "" }`.
 */
export type ExactArgvRunner = (argv: string[]) => Promise<ProviderRunOutcome>;

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------- observe one cycle (pure over its injected deps) -----------------

/** Dependencies one {@link observeOnce} call runs against — all injectable. */
export interface ObserveDeps {
  runner: ExactArgvRunner;
  /** The cycle instant (epoch ms). */
  nowMs: () => number;
  /** Exact argv for the two provider calls (defaults resolved from config). */
  codexbarArgv?: string[];
  cswapArgv?: string[];
  /** Managed-measurement freshness ceiling (ms). */
  freshnessCeilingMs?: number;
}

/**
 * Run one observation cycle: invoke both provider CLIs (concurrently — they are
 * independent), strictly parse each, and assemble the normalized observation.
 * Pure over its injected runner + clock; never spawns a process itself.
 */
export async function observeOnce(deps: ObserveDeps): Promise<Observation> {
  const codexbarArgv = deps.codexbarArgv ?? codexBarUsageArgv();
  const cswapArgv = deps.cswapArgv ?? cswapListArgv();
  const [codexOutcome, cswapOutcome] = await Promise.all([
    deps.runner(codexbarArgv),
    deps.runner(cswapArgv),
  ]);
  const observedAtMs = deps.nowMs();
  const codex = parseCodexBar(codexOutcome);
  const cswap = parseCswapList(
    cswapOutcome,
    observedAtMs,
    deps.freshnessCeilingMs ?? ROUTE_MEASUREMENT_FRESHNESS_CEILING_MS,
  );
  return buildObservation({ observedAtMs, codex, cswap });
}

/** Ensure the state dir exists, then atomically publish the observation sidecar. */
export function publishObservation(stateDir: string, obs: Observation): void {
  mkdirSync(stateDir, { recursive: true });
  writeObservationSidecar(observationSidecarPath(stateDir), obs);
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
  cswapArgv?: string[];
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
      const obs = await observeOnce({
        runner: this.deps.runner,
        nowMs: this.deps.clock.nowMs,
        codexbarArgv: this.deps.codexbarArgv,
        cswapArgv: this.deps.cswapArgv,
      });
      publishObservation(this.deps.stateDir, obs);
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

// ---------- production bounded runner ---------------------------------------

/**
 * Build the production exact-argv runner: no shell, a hard `timeoutMs` deadline
 * (the child is force-killed on expiry and the outcome degrades to unavailable),
 * concurrently drained stdout capped at `maxBytes`, and a `null` code on ENOENT /
 * spawn failure / timeout. Never rejects.
 */
export function makeBoundedRunner(
  timeoutMs: number = SUBPROCESS_TIMEOUT_MS,
  maxBytes: number = MAX_OUTPUT_BYTES,
): ExactArgvRunner {
  return async (argv: string[]): Promise<ProviderRunOutcome> => {
    try {
      const proc = Bun.spawn(argv, {
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = Symbol("timed-out");
      const timeout = new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs);
      });
      // Drain stdout concurrently with the exit await so a child that fills its
      // pipe buffer cannot deadlock against our wait.
      const drain = readCapped(proc.stdout, maxBytes);
      const race = await Promise.race([proc.exited, timeout]);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (race === timedOut) {
        try {
          proc.kill();
        } catch {
          // best-effort — already-dead child
        }
        try {
          await proc.exited;
        } catch {
          // best-effort
        }
        return { code: null, stdout: "" };
      }
      const stdout = await drain;
      return { code: race, stdout };
    } catch {
      // ENOENT (binary not installed) / spawn failure.
      return { code: null, stdout: "" };
    }
  };
}

/**
 * Drain a readable stream to text, stopping once `maxBytes` is exceeded (the
 * captured text then over-runs the cap and the strict parser rejects it). Bounds
 * memory to at most one chunk past the cap. Returns `""` on a null/empty stream.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (stream == null) {
    return "";
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      total += value.byteLength;
      if (total > maxBytes) {
        break; // already over cap — the parser will reject on size
      }
    }
  } catch {
    // stream error — return whatever we captured
  } finally {
    try {
      await reader.cancel();
    } catch {
      // best-effort
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ---------- worker data + entrypoint ----------------------------------------

/** Data the parent passes via `new Worker(url, { workerData })`. */
export interface AccountObserverWorkerData {
  /** Resolved account-routing state root (the sandbox seam threads through here). */
  stateDir: string;
}

/**
 * Worker entrypoint. Resolves the state root, acquires a NON-blocking singleton
 * lock so two observers never publish the same sidecar, builds the production
 * runner + clock, and runs the {@link AccountObserver} loop. A held lock or an
 * unwritable root un-arms the worker (warn, return) rather than crash-looping.
 * Shutdown aborts the loop's sleep + any in-flight provider child, releases the
 * lock, and exits 0.
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

  let lock: FileLock | null = null;
  try {
    mkdirSync(stateDir, { recursive: true });
    lock = FileLock.tryAcquire(`${stateDir}/observer.lock`);
  } catch (err) {
    console.error(
      `[account-observer] could not prepare state dir ${stateDir} (${stringifyErr(err)}); not observing`,
    );
    return;
  }
  if (lock === null) {
    console.error(
      `[account-observer] another observer holds the lock at ${stateDir}; not observing`,
    );
    return;
  }

  const shutdownController = new AbortController();
  const observer = new AccountObserver({
    stateDir,
    runner: makeBoundedRunner(),
    clock: REAL_OBSERVER_CLOCK,
    shutdownSignal: shutdownController.signal,
  });
  // The loop is internally no-throw; this catch is belt-and-suspenders so an
  // unexpected throw outside a cycle never surfaces as an unhandled rejection.
  observer.run().catch((err) => {
    console.error(
      `[account-observer] loop settled unexpectedly: ${stringifyErr(err)}`,
    );
  });

  const releaseLock = (): void => {
    if (lock) {
      try {
        lock.release();
      } catch {
        // best-effort
      }
      lock = null;
    }
  };

  parentPort.on("message", (msg: { type?: string } | undefined) => {
    if (msg && msg.type === "shutdown") {
      shutdownController.abort();
      releaseLock();
      process.exit(0);
    }
  });
}

// Only run inside a real Worker; a plain import on the main thread (tests driving
// the pure helpers + AccountObserver with a stub runner) is inert.
if (!isMainThread) {
  main();
}

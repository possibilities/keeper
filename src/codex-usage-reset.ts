import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { isObservationFresh, type Observation } from "./account-observation";
import {
  makeBoundedRunner,
  refreshObservationIfStale,
} from "./account-observation-refresh";
import {
  codexUsageResetCommandLockPath,
  codexUsageResetLatchPath,
  resolveAccountRoutingRoot,
} from "./account-routing-config";
import {
  type CodexResetCommandResult,
  createCodexResetTmuxTerminal,
} from "./codex-reset-tmux";
import {
  type CodexResetOutcome,
  type CodexResetTerminal,
  runCodexResetTui,
} from "./codex-reset-tui";
import { FileLock } from "./file-lock";

export const DEFAULT_CODEX_RESET_CHECK_EVERY_MS = 30_000;
export const DEFAULT_CODEX_RESET_NOTIFY_EVERY_PERCENT = 5;
export const MIN_CODEX_RESET_CHECK_EVERY_MS = 5_000;
export const MAX_CODEX_RESET_CHECK_EVERY_MS = 5 * 60_000;
export const CODEX_RESET_TRIGGER_PERCENT = 99;
export const CODEX_RESET_SHOT_SAFETY_MS = 15_000;
export const CODEX_RESET_CONFIRMATION_POLLS = 3;
export const CODEX_RESET_MATERIAL_DROP_PERCENT = 1;
export const CODEX_RESET_LATCH_SCHEMA_VERSION = 1;

export interface CodexResetLoopOptions {
  readonly checkEveryMs?: number;
  readonly notifyEveryPercent?: number;
  readonly confirmationPolls?: number;
}

export interface UsageTransition {
  readonly atMs: number;
  readonly usedPercent: number;
}

export interface ValidCodexObservation {
  readonly observation: Observation;
  readonly usedPercent: number;
  readonly resetWindow: string;
  readonly resetWindowMs: number;
  readonly resetCreditsAvailableCount: 1;
}

export type CodexResetLatchState = "armed" | "submitted";

export interface CodexResetLatch {
  readonly schema_version: 1;
  readonly reset_window: string;
  readonly observed_used_percent: number;
  readonly timestamp_ms: number;
  readonly state: CodexResetLatchState;
}

export type CodexResetLatchRead =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | { readonly kind: "valid"; readonly latch: CodexResetLatch };

export interface LifetimeLock {
  release(): void;
}

export interface CodexUsageResetClock {
  nowMs(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface CodexUsageResetDeps {
  readonly stateDir: string;
  readonly signal: AbortSignal;
  readonly clock: CodexUsageResetClock;
  readonly refresh: (maxAgeMs: number) => Promise<Observation | null>;
  readonly tryAcquireCommandLock: (path: string) => LifetimeLock | null;
  readonly createTerminal: () => CodexResetTerminal;
  readonly runTui?: typeof runCodexResetTui;
  readonly readLatch?: (path: string) => CodexResetLatchRead;
  readonly writeLatch?: (path: string, latch: CodexResetLatch) => void;
  readonly notify: (message: string) => Promise<void>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export type CodexUsageResetOutcomeKind =
  | "confirmed"
  | "submitted-unconfirmed"
  | "submitted-rejected"
  | "final-enter-uncertain"
  | "failure"
  | "already-submitted"
  | "cancelled"
  | "lock-busy";

export interface CodexUsageResetOutcome {
  readonly kind: CodexUsageResetOutcomeKind;
  readonly message: string;
  readonly error?: unknown;
}

class CancelledBeforeSubmission extends Error {}
class ExistingLatch extends Error {}

const NEVER_ABORTED = new AbortController().signal;

function hasTimezone(stamp: string): boolean {
  if (/[zZ]$/u.test(stamp)) return true;
  const t = stamp.indexOf("T");
  return /[+-]\d{2}:?\d{2}$/u.test(t >= 0 ? stamp.slice(t + 1) : stamp);
}

function parseResetWindow(stamp: string): number | null {
  if (!hasTimezone(stamp)) return null;
  const value = new Date(stamp).getTime();
  return Number.isFinite(value) ? value : null;
}

/** Strictly extract the sole weekly Codex window used by this controller. */
export function validateCodexResetObservation(
  observation: Observation,
  nowMs: number,
  maxAgeMs: number,
): ValidCodexObservation | null {
  if (!isObservationFresh(observation, nowMs, maxAgeMs)) return null;
  if (observation.codex.health !== "ok") return null;
  const weeks = observation.codex.windows.filter(
    (window) => window.key === "week",
  );
  if (weeks.length !== 1) return null;
  const week = weeks[0];
  if (week === undefined || week.resetsAt === null) return null;
  const resetWindowMs = parseResetWindow(week.resetsAt);
  if (resetWindowMs === null) return null;
  if (observation.codex.resetCreditsAvailableCount !== 1) return null;
  const usedPercent = week.utilization * 100;
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
    return null;
  }
  return {
    observation,
    usedPercent,
    resetWindow: week.resetsAt,
    resetWindowMs,
    resetCreditsAvailableCount: 1,
  };
}

/**
 * Predict the 100% boundary from the latest positive transition and subtract a
 * full poll interval plus UI safety. Large threshold-crossing jumps do not wait.
 */
export function predictCodexResetShotDeadlineMs(
  transitions: readonly UsageTransition[],
  checkEveryMs: number,
): number | null {
  if (transitions.length < 2) return null;
  const latest = transitions[transitions.length - 1];
  const previous = transitions[transitions.length - 2];
  if (latest === undefined || previous === undefined) return null;
  const deltaPercent = latest.usedPercent - previous.usedPercent;
  const deltaMs = latest.atMs - previous.atMs;
  if (deltaPercent <= 0 || deltaMs <= 0) return null;
  if (
    previous.usedPercent < CODEX_RESET_TRIGGER_PERCENT &&
    latest.usedPercent >= CODEX_RESET_TRIGGER_PERCENT &&
    deltaPercent > 1
  ) {
    return latest.atMs;
  }
  const remainingPercent = Math.max(0, 100 - latest.usedPercent);
  const predictedBoundary =
    latest.atMs + (remainingPercent * deltaMs) / deltaPercent;
  return predictedBoundary - checkEveryMs - CODEX_RESET_SHOT_SAFETY_MS;
}

/** Inclusive freshness uses one millisecond less so an N-ms wake refreshes at N. */
export function maxObservationAgeForCadence(cadenceMs: number): number {
  return Math.max(0, cadenceMs - 1);
}

export function crossedUsageBuckets(
  previousPercent: number,
  currentPercent: number,
  step: number,
): number[] {
  if (currentPercent <= previousPercent) return [];
  const first = (Math.floor(previousPercent / step) + 1) * step;
  const result: number[] = [];
  for (
    let bucket = first;
    bucket <= currentPercent && bucket <= 100;
    bucket += step
  ) {
    result.push(bucket);
  }
  return result;
}

function isLatch(value: unknown): value is CodexResetLatch {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const row = value as Record<string, unknown>;
  return (
    row.schema_version === CODEX_RESET_LATCH_SCHEMA_VERSION &&
    typeof row.reset_window === "string" &&
    parseResetWindow(row.reset_window) !== null &&
    typeof row.observed_used_percent === "number" &&
    Number.isFinite(row.observed_used_percent) &&
    row.observed_used_percent >= 0 &&
    row.observed_used_percent <= 100 &&
    typeof row.timestamp_ms === "number" &&
    Number.isFinite(row.timestamp_ms) &&
    (row.state === "armed" || row.state === "submitted")
  );
}

export function readCodexResetLatch(path: string): CodexResetLatchRead {
  if (!existsSync(path)) return { kind: "missing" };
  try {
    const raw = readFileSync(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 16_384) return { kind: "malformed" };
    const parsed: unknown = JSON.parse(raw);
    return isLatch(parsed)
      ? { kind: "valid", latch: parsed }
      : { kind: "malformed" };
  } catch {
    return { kind: "malformed" };
  }
}

/** Atomic, user-private publication of the at-most-once latch. */
export function writeCodexResetLatch(
  path: string,
  latch: CodexResetLatch,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(latch, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    throw error;
  }
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  // The latch grants at-most-once permission. Commit the renamed directory
  // entry before final Enter so a power loss cannot resurrect permission.
  const directoryFd = openSync(dirname(path), "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionsWithDefaults(
  options: CodexResetLoopOptions,
): Required<CodexResetLoopOptions> {
  return {
    checkEveryMs: options.checkEveryMs ?? DEFAULT_CODEX_RESET_CHECK_EVERY_MS,
    notifyEveryPercent:
      options.notifyEveryPercent ?? DEFAULT_CODEX_RESET_NOTIFY_EVERY_PERCENT,
    confirmationPolls:
      options.confirmationPolls ?? CODEX_RESET_CONFIRMATION_POLLS,
  };
}

function assertOptions(options: Required<CodexResetLoopOptions>): void {
  if (
    !Number.isFinite(options.checkEveryMs) ||
    options.checkEveryMs < MIN_CODEX_RESET_CHECK_EVERY_MS ||
    options.checkEveryMs > MAX_CODEX_RESET_CHECK_EVERY_MS
  ) {
    throw new Error("checkEveryMs is outside 5s..5m");
  }
  if (
    !Number.isInteger(options.notifyEveryPercent) ||
    options.notifyEveryPercent < 1 ||
    options.notifyEveryPercent > 100
  ) {
    throw new Error("notifyEveryPercent is outside 1..100");
  }
  if (
    !Number.isInteger(options.confirmationPolls) ||
    options.confirmationPolls < 0
  ) {
    throw new Error("confirmationPolls must be a nonnegative integer");
  }
}

async function safeNotify(
  deps: CodexUsageResetDeps,
  message: string,
): Promise<void> {
  try {
    await deps.notify(message);
  } catch (error) {
    deps.stderr(
      `keeper usage: notification failed: ${stringifyError(error)}\n`,
    );
  }
}

async function finish(
  deps: CodexUsageResetDeps,
  outcome: CodexUsageResetOutcome,
): Promise<CodexUsageResetOutcome> {
  deps.stdout(`${outcome.message}\n`);
  await safeNotify(deps, outcome.message);
  return outcome;
}

function failure(error: unknown): CodexUsageResetOutcome {
  return {
    kind: "failure",
    message: `Codex reset failed: ${stringifyError(error)}`,
    error,
  };
}

function requireNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CancelledBeforeSubmission("cancelled");
}

function checkLatchForWindow(
  read: CodexResetLatchRead,
  current: ValidCodexObservation,
): void {
  if (read.kind === "malformed") {
    throw new Error("Codex reset latch is malformed or unsupported");
  }
  if (read.kind === "missing") return;
  const latchedWindow = parseResetWindow(read.latch.reset_window);
  if (latchedWindow === null)
    throw new Error("Codex reset latch has an invalid window");
  if (latchedWindow === current.resetWindowMs) {
    throw new ExistingLatch(
      "a reset is already latched for this weekly window",
    );
  }
  if (current.resetWindowMs < latchedWindow) {
    throw new Error("Codex reset latch is for a later weekly window");
  }
}

async function confirmSubmission(
  deps: CodexUsageResetDeps,
  options: Required<CodexResetLoopOptions>,
  submitted: ValidCodexObservation,
): Promise<boolean> {
  for (let index = 0; index < options.confirmationPolls; index += 1) {
    // Step just beyond the inclusive freshness boundary so this confirmation
    // poll can advance shared data without violating the configured cadence.
    await deps.clock.sleep(options.checkEveryMs + 1, NEVER_ABORTED);
    let observation: Observation | null;
    try {
      observation = await deps.refresh(
        maxObservationAgeForCadence(options.checkEveryMs),
      );
    } catch {
      continue;
    }
    if (
      observation === null ||
      !isObservationFresh(observation, deps.clock.nowMs(), options.checkEveryMs)
    ) {
      continue;
    }
    const weeks = observation.codex.windows.filter(
      (window) => window.key === "week",
    );
    const week = weeks.length === 1 ? weeks[0] : undefined;
    const credits = observation.codex.resetCreditsAvailableCount;
    const sameWindow = week?.resetsAt === submitted.resetWindow;
    if (
      observation.codex.health === "ok" &&
      week !== undefined &&
      ((sameWindow &&
        submitted.usedPercent - week.utilization * 100 >=
          CODEX_RESET_MATERIAL_DROP_PERCENT) ||
        (typeof credits === "number" &&
          credits < submitted.resetCreditsAvailableCount))
    ) {
      return true;
    }
  }
  return false;
}

/** Run one foreground controller invocation through exactly one terminal outcome. */
export async function runCodexUsageResetController(
  deps: CodexUsageResetDeps,
  suppliedOptions: CodexResetLoopOptions = {},
): Promise<CodexUsageResetOutcome> {
  const options = optionsWithDefaults(suppliedOptions);
  try {
    assertOptions(options);
  } catch (error) {
    return finish(deps, failure(error));
  }

  const lockPath = codexUsageResetCommandLockPath(deps.stateDir);
  let lock: LifetimeLock | null;
  try {
    mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(deps.stateDir, 0o700);
    lock = deps.tryAcquireCommandLock(lockPath);
    if (lock !== null && existsSync(lockPath)) chmodSync(lockPath, 0o600);
  } catch (error) {
    return finish(deps, failure(error));
  }
  if (lock === null) {
    return finish(deps, {
      kind: "lock-busy",
      message: "Codex reset not started: another reset controller is running.",
    });
  }

  try {
    requireNotCancelled(deps.signal);
    const latchPath = codexUsageResetLatchPath(deps.stateDir);
    let previousPercent: number | null = null;
    let transitionWindow: string | null = null;
    const transitions: UsageTransition[] = [];
    const notifiedBuckets = new Set<number>();
    let started = false;
    let triggered: ValidCodexObservation | null = null;
    let shotDelayMs = 0;

    while (triggered === null) {
      requireNotCancelled(deps.signal);
      let observation: Observation | null;
      try {
        observation = await deps.refresh(
          maxObservationAgeForCadence(options.checkEveryMs),
        );
      } catch (error) {
        deps.stderr(
          `keeper usage: shared usage refresh failed; retrying: ${stringifyError(error)}\n`,
        );
        await deps.clock.sleep(options.checkEveryMs, deps.signal);
        continue;
      }
      if (
        observation === null ||
        !isObservationFresh(
          observation,
          deps.clock.nowMs(),
          options.checkEveryMs,
        )
      ) {
        deps.stderr(
          "keeper usage: shared usage refresh is still contended or stale; retrying\n",
        );
        await deps.clock.sleep(options.checkEveryMs, deps.signal);
        continue;
      }
      const current = validateCodexResetObservation(
        observation,
        deps.clock.nowMs(),
        options.checkEveryMs,
      );
      if (current === null) {
        throw new Error(
          "fresh Codex weekly usage and exactly one reset credit are required",
        );
      }
      // Refuse immediately on a malformed/same-window latch instead of waiting
      // all the way to the shot before discovering an at-most-once block.
      checkLatchForWindow(
        (deps.readLatch ?? readCodexResetLatch)(latchPath),
        current,
      );

      if (transitionWindow !== current.resetWindow) {
        transitions.length = 0;
        notifiedBuckets.clear();
        previousPercent = null;
        transitionWindow = current.resetWindow;
      }
      if (previousPercent === null || current.usedPercent !== previousPercent) {
        transitions.push({
          atMs: deps.clock.nowMs(),
          usedPercent: current.usedPercent,
        });
        if (transitions.length > 4) transitions.shift();
      }

      if (!started) {
        started = true;
        deps.stdout(
          `Codex reset watch started at ${current.usedPercent.toFixed(1)}% used.\n`,
        );
        await safeNotify(
          deps,
          `Codex reset watch started: ${current.usedPercent.toFixed(1)}% used.`,
        );
      } else if (previousPercent !== null) {
        for (const bucket of crossedUsageBuckets(
          previousPercent,
          current.usedPercent,
          options.notifyEveryPercent,
        )) {
          if (notifiedBuckets.has(bucket)) continue;
          notifiedBuckets.add(bucket);
          const line = `Codex weekly usage crossed ${bucket}% used.`;
          deps.stdout(`${line}\n`);
          await safeNotify(deps, line);
        }
      }
      previousPercent = current.usedPercent;

      if (current.usedPercent >= CODEX_RESET_TRIGGER_PERCENT) {
        const deadline = predictCodexResetShotDeadlineMs(
          transitions,
          options.checkEveryMs,
        );
        shotDelayMs =
          deadline === null ? 0 : Math.max(0, deadline - deps.clock.nowMs());
        triggered = current;
        break;
      }
      await deps.clock.sleep(options.checkEveryMs, deps.signal);
    }

    let armedLatch: CodexResetLatch | null = null;
    let prepared: ValidCodexObservation | null = null;
    const tui = deps.runTui ?? runCodexResetTui;
    const tuiOutcome: CodexResetOutcome = await tui(
      deps.createTerminal(),
      async () => {
        requireNotCancelled(deps.signal);
        if (prepared === null) {
          throw new Error("Codex reset was not prepared before arming");
        }
        checkLatchForWindow(
          (deps.readLatch ?? readCodexResetLatch)(latchPath),
          prepared,
        );
        requireNotCancelled(deps.signal);
        armedLatch = {
          schema_version: CODEX_RESET_LATCH_SCHEMA_VERSION,
          reset_window: prepared.resetWindow,
          observed_used_percent: prepared.usedPercent,
          timestamp_ms: deps.clock.nowMs(),
          state: "armed",
        };
        (deps.writeLatch ?? writeCodexResetLatch)(latchPath, armedLatch);
      },
      {
        prepareFinalEnter: async () => {
          requireNotCancelled(deps.signal);
          if (shotDelayMs > 0) {
            await deps.clock.sleep(shotDelayMs, deps.signal);
            requireNotCancelled(deps.signal);
          }
          const observation = await deps.refresh(
            maxObservationAgeForCadence(options.checkEveryMs),
          );
          const current =
            observation === null
              ? null
              : validateCodexResetObservation(
                  observation,
                  deps.clock.nowMs(),
                  options.checkEveryMs,
                );
          if (current === null) {
            throw new Error("Codex data failed strict pre-submit revalidation");
          }
          if (current.resetWindow !== triggered.resetWindow) {
            throw new Error(
              "Codex weekly window rolled over before submission",
            );
          }
          if (current.usedPercent < CODEX_RESET_TRIGGER_PERCENT) {
            throw new Error(
              "Codex weekly usage fell below the reset threshold",
            );
          }
          prepared = current;
        },
      },
    );

    if (tuiOutcome.kind === "pre-submit-failure") {
      if (deps.signal.aborted && armedLatch === null) {
        return finish(deps, {
          kind: "cancelled",
          message: "Codex reset cancelled before submission.",
        });
      }
      if (tuiOutcome.error instanceof ExistingLatch) {
        return finish(deps, {
          kind: "already-submitted",
          message:
            "Codex reset blocked: already submitted for this weekly window.",
        });
      }
      if (tuiOutcome.error instanceof CancelledBeforeSubmission) {
        return finish(deps, {
          kind: "cancelled",
          message: "Codex reset cancelled before submission.",
        });
      }
      return finish(deps, failure(tuiOutcome.error));
    }
    if (tuiOutcome.kind === "final-enter-uncertain") {
      return finish(deps, {
        kind: "final-enter-uncertain",
        message:
          "Codex reset final Enter is uncertain; the window remains latched.",
        error: tuiOutcome.error,
      });
    }
    if (tuiOutcome.kind === "submitted-rejected") {
      if (armedLatch !== null) {
        try {
          (deps.writeLatch ?? writeCodexResetLatch)(latchPath, {
            ...(armedLatch as CodexResetLatch),
            state: "submitted",
          });
        } catch (error) {
          deps.stderr(
            `keeper usage: could not update rejected submission latch: ${stringifyError(error)}\n`,
          );
        }
      }
      return finish(deps, {
        kind: "submitted-rejected",
        message: `Codex rejected the submitted Full reset: ${tuiOutcome.message} The window remains latched.`,
      });
    }
    if (armedLatch === null) {
      return finish(
        deps,
        failure(new Error("reset submitted without a durable latch")),
      );
    }

    try {
      (deps.writeLatch ?? writeCodexResetLatch)(latchPath, {
        ...(armedLatch as CodexResetLatch),
        state: "submitted",
      });
    } catch (error) {
      deps.stderr(
        `keeper usage: could not update submitted latch: ${stringifyError(error)}\n`,
      );
    }
    const confirmed = await confirmSubmission(deps, options, triggered);
    return finish(
      deps,
      confirmed
        ? { kind: "confirmed", message: "Codex reset confirmed." }
        : {
            kind: "submitted-unconfirmed",
            message:
              "Codex reset submitted but not confirmed; the window remains latched.",
          },
    );
  } catch (error) {
    if (error instanceof CancelledBeforeSubmission) {
      return finish(deps, {
        kind: "cancelled",
        message: "Codex reset cancelled before submission.",
      });
    }
    if (error instanceof ExistingLatch) {
      return finish(deps, {
        kind: "already-submitted",
        message:
          "Codex reset blocked: already submitted for this weekly window.",
      });
    }
    return finish(deps, failure(error));
  } finally {
    try {
      lock.release();
    } catch (error) {
      deps.stderr(
        `keeper usage: command lock release failed: ${stringifyError(error)}\n`,
      );
    }
  }
}

const REAL_CLOCK: CodexUsageResetClock = {
  nowMs: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    }),
};

export function notifyctlShowMessageArgv(
  message: string,
  bin = process.env.KEEPER_NOTIFYCTL_BIN || "notifyctl",
): string[] {
  return [bin, "show-message", "-t", "Keeper Codex quota reset", "-m", message];
}

export type SmallCommandRunner = (
  argv: readonly string[],
  timeoutMs: number,
) => Promise<CodexResetCommandResult>;

export function makeNotifyctlNotifier(
  runner: SmallCommandRunner,
  bin = process.env.KEEPER_NOTIFYCTL_BIN || "notifyctl",
): (message: string) => Promise<void> {
  return async (message) => {
    const result = await runner(notifyctlShowMessageArgv(message, bin), 5_000);
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(
        result.timedOut
          ? "notifyctl timed out"
          : `notifyctl exited ${result.exitCode}`,
      );
    }
  };
}

/** Bounded exact-argv runner used only for foreground notifications. */
export function createSmallCommandRunner(): SmallCommandRunner {
  return async (argv, timeoutMs) => {
    try {
      const proc = Bun.spawn([...argv], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = Symbol("timeout");
      const winner = await Promise.race([
        proc.exited,
        new Promise<typeof timedOut>((resolve) => {
          timer = setTimeout(() => resolve(timedOut), timeoutMs);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (winner === timedOut) {
        try {
          proc.kill();
        } catch {
          // already exited
        }
        return { exitCode: -1, stdout: "", stderr: "", timedOut: true };
      }
      return { exitCode: winner, stdout: "", stderr: "" };
    } catch (error) {
      throw new Error(`failed to launch ${argv[0] ?? "notifyctl"}`, {
        cause: error,
      });
    }
  };
}

/** Build all production dependencies without starting the loop or touching state. */
export function buildProductionCodexUsageResetDeps(input: {
  readonly signal: AbortSignal;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly stateDir?: string;
}): CodexUsageResetDeps {
  const stateDir = input.stateDir ?? resolveAccountRoutingRoot();
  const runner = makeBoundedRunner();
  return {
    stateDir,
    signal: input.signal,
    clock: REAL_CLOCK,
    refresh: (maxAgeMs) =>
      refreshObservationIfStale({
        stateDir,
        maxAgeMs,
        runner,
        nowMs: () => Date.now(),
      }),
    tryAcquireCommandLock: (path) => FileLock.tryAcquire(path),
    createTerminal: () =>
      createCodexResetTmuxTerminal({
        session: `keeper-codex-reset-${process.pid}`,
      }),
    notify: makeNotifyctlNotifier(createSmallCommandRunner()),
    stdout: input.stdout ?? ((line) => process.stdout.write(line)),
    stderr: input.stderr ?? ((line) => process.stderr.write(line)),
  };
}

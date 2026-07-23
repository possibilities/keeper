/*
 * DB-free claude-swap token recovery boundary. claude-swap remains the sole
 * credential owner; Keeper may request recovery for one observed expired slot,
 * then trusts only a second, fresh Capacity observation for routing.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  isObservationFresh,
  type Observation,
  type ProviderRunOutcome,
} from "./account-observation";
import type {
  ExactArgvRunner,
  RefreshResult,
} from "./account-observation-refresh";
import {
  MAX_CSWAP_ACCOUNTS,
  MAX_JSON_DEPTH,
  MAX_OUTPUT_BYTES,
  OBSERVATION_FRESHNESS_CEILING_MS,
  resolveCswapCommand,
} from "./account-routing-config";
import { FileLock } from "./file-lock";

export const ACCOUNT_RECOVERY_SCHEMA_VERSION = 1;
const RECOVERY_STATE_MAX_BYTES = 16 * 1024;
const BACKOFF_MINUTES = [3, 6, 12, 24, 48, 60] as const;

export type AccountRecoveryOutcome =
  | "recovered"
  | "not-needed"
  | "retry-later"
  | "human-required"
  | "tool-failure"
  | "recovery-unverified";

export type AccountRecoveryProblemCode =
  | null
  | "observation-unavailable"
  | "account-not-found"
  | "account-not-token-expired"
  | "recovery-busy"
  | "tool-failure"
  | "route-unverified";

/** The bounded, PII-free foreground/automatic result. */
export interface AccountRecoveryResult {
  schema_version: 1;
  operation: "recover";
  account: string;
  outcome: AccountRecoveryOutcome;
  ok: boolean;
  problem_code: AccountRecoveryProblemCode;
}

export interface RecoverySlotState {
  attempts: number;
  next_attempt_at_ms: number;
  human_required: boolean;
}

export interface RecoveryState {
  schema_version: 1;
  slots: Record<string, RecoverySlotState>;
}

export interface RecoveryStateStore {
  read(): RecoveryState;
  mutate(update: (state: RecoveryState) => boolean): void;
}

export interface RecoveryLock {
  release(): void;
}

export type TryAcquireRecoveryLock = (path: string) => RecoveryLock | null;
export type TryAcquireRecoveryStateLock = (path: string) => RecoveryLock | null;

export type RecoveryRefresh = (mode: {
  requireOwnedCall: true;
}) => Promise<RefreshResult>;

export class RecoveryStateLockContentionError extends Error {
  constructor() {
    super("account recovery state is busy");
    this.name = "RecoveryStateLockContentionError";
  }
}

export interface AccountRecoveryDeps {
  stateDir: string;
  runner: ExactArgvRunner;
  nowMs: () => number;
  forceRefresh: RecoveryRefresh;
  cswapBin?: string;
  signal?: AbortSignal;
  tryAcquireRecoveryLock?: TryAcquireRecoveryLock;
  stateStore?: RecoveryStateStore;
}

export interface ForegroundAccountRecoveryDeps extends AccountRecoveryDeps {
  ordinal: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exceedsDepth(value: unknown, maxDepth: number): boolean {
  const walk = (candidate: unknown, depth: number): boolean => {
    if (depth > maxDepth) return true;
    if (Array.isArray(candidate)) {
      return candidate.some((entry) => walk(entry, depth + 1));
    }
    if (isRecord(candidate)) {
      return Object.values(candidate).some((entry) => walk(entry, depth + 1));
    }
    return false;
  };
  return walk(value, 0);
}

function parseBoundedJson(stdout: string, maxBytes: number): unknown | null {
  if (Buffer.byteLength(stdout, "utf8") > maxBytes) return null;
  try {
    const parsed: unknown = JSON.parse(stdout);
    return exceedsDepth(parsed, MAX_JSON_DEPTH) ? null : parsed;
  } catch {
    return null;
  }
}

/**
 * Strictly validate the fixed claude-swap recovery envelope. Tool errors,
 * error envelopes, mismatched slots, unknown statuses, and oversized/deep JSON
 * collapse to one PII-free Keeper outcome.
 */
export function parseCswapRecovery(
  outcome: ProviderRunOutcome,
  expectedSlot: number,
): AccountRecoveryOutcome {
  if (
    !Number.isSafeInteger(expectedSlot) ||
    expectedSlot <= 0 ||
    outcome.code !== 0 ||
    outcome.failure !== undefined
  ) {
    return "tool-failure";
  }
  const parsed = parseBoundedJson(outcome.stdout, MAX_OUTPUT_BYTES);
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 4 ||
    !["schemaVersion", "operation", "accountNumber", "recoveryStatus"].every(
      (key) => Object.hasOwn(parsed, key),
    ) ||
    parsed.schemaVersion !== 1 ||
    parsed.operation !== "recover" ||
    parsed.accountNumber !== expectedSlot
  ) {
    return "tool-failure";
  }
  switch (parsed.recoveryStatus) {
    case "recovered":
      return "recovered";
    case "not_needed":
      return "not-needed";
    case "retry_later":
      return "retry-later";
    case "human_required":
      return "human-required";
    default:
      return "tool-failure";
  }
}

export function cswapRecoverArgv(
  slot: number,
  bin: string = resolveCswapCommand(),
): string[] {
  if (!Number.isSafeInteger(slot) || slot <= 0) {
    throw new Error("claude-swap recovery slot must be a positive integer");
  }
  return [bin, "recover", String(slot), "--json"];
}

function emptyRecoveryState(): RecoveryState {
  return { schema_version: ACCOUNT_RECOVERY_SCHEMA_VERSION, slots: {} };
}

function validateRecoveryState(value: unknown): RecoveryState | null {
  if (
    !isRecord(value) ||
    value.schema_version !== ACCOUNT_RECOVERY_SCHEMA_VERSION ||
    !isRecord(value.slots)
  ) {
    return null;
  }
  const entries = Object.entries(value.slots);
  if (entries.length > MAX_CSWAP_ACCOUNTS) return null;
  const slots: Record<string, RecoverySlotState> = {};
  for (const [key, raw] of entries) {
    if (
      !/^[1-9]\d*$/u.test(key) ||
      !Number.isSafeInteger(Number(key)) ||
      !isRecord(raw) ||
      typeof raw.attempts !== "number" ||
      !Number.isInteger(raw.attempts) ||
      raw.attempts < 0 ||
      raw.attempts > BACKOFF_MINUTES.length ||
      typeof raw.next_attempt_at_ms !== "number" ||
      !Number.isFinite(raw.next_attempt_at_ms) ||
      raw.next_attempt_at_ms < 0 ||
      typeof raw.human_required !== "boolean"
    ) {
      return null;
    }
    slots[key] = {
      attempts: raw.attempts,
      next_attempt_at_ms: raw.next_attempt_at_ms,
      human_required: raw.human_required,
    };
  }
  return { schema_version: ACCOUNT_RECOVERY_SCHEMA_VERSION, slots };
}

export function accountRecoveryStatePath(root: string): string {
  return join(root, "recovery-state.json");
}

export function accountRecoveryStateLockPath(root: string): string {
  return join(root, "recovery-state.json.lock");
}

export function accountRecoverySlotLockPath(
  root: string,
  slot: number,
): string {
  return join(root, `recovery-slot-${slot}.lock`);
}

function readRecoveryStateFile(path: string): RecoveryState {
  if (!existsSync(path)) return emptyRecoveryState();
  try {
    const body = readFileSync(path, "utf8");
    return (
      validateRecoveryState(parseBoundedJson(body, RECOVERY_STATE_MAX_BYTES)) ??
      emptyRecoveryState()
    );
  } catch {
    return emptyRecoveryState();
  }
}

function writeRecoveryStateFile(path: string, state: RecoveryState): void {
  const validated = validateRecoveryState(state);
  if (validated === null) {
    throw new Error("account recovery state is invalid");
  }
  const body = `${JSON.stringify(validated)}\n`;
  if (Buffer.byteLength(body, "utf8") > RECOVERY_STATE_MAX_BYTES) {
    throw new Error("account recovery state exceeds its bound");
  }
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, body);
    closeSync(fd);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    throw error;
  }
  renameSync(tmp, path);
}

class FileRecoveryStateStore implements RecoveryStateStore {
  constructor(
    private readonly root: string,
    private readonly tryAcquireLock: TryAcquireRecoveryStateLock,
  ) {}

  private acquire(): RecoveryLock {
    const lock = this.tryAcquireLock(accountRecoveryStateLockPath(this.root));
    if (lock === null) throw new RecoveryStateLockContentionError();
    return lock;
  }

  read(): RecoveryState {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const lock = this.acquire();
    try {
      return readRecoveryStateFile(accountRecoveryStatePath(this.root));
    } finally {
      lock.release();
    }
  }

  mutate(update: (state: RecoveryState) => boolean): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const lock = this.acquire();
    try {
      const state = cloneState(
        readRecoveryStateFile(accountRecoveryStatePath(this.root)),
      );
      if (update(state)) {
        writeRecoveryStateFile(accountRecoveryStatePath(this.root), state);
      }
    } finally {
      lock.release();
    }
  }
}

export function createFileRecoveryStateStore(
  root: string,
  tryAcquireLock: TryAcquireRecoveryStateLock = (path) =>
    FileLock.tryAcquire(path),
): RecoveryStateStore {
  return new FileRecoveryStateStore(root, tryAcquireLock);
}

function cloneState(state: RecoveryState): RecoveryState {
  return {
    schema_version: ACCOUNT_RECOVERY_SCHEMA_VERSION,
    slots: Object.fromEntries(
      Object.entries(state.slots).map(([slot, entry]) => [slot, { ...entry }]),
    ),
  };
}

function result(
  ordinal: number,
  outcome: AccountRecoveryOutcome,
  ok: boolean,
  problemCode: AccountRecoveryProblemCode,
): AccountRecoveryResult {
  return {
    schema_version: ACCOUNT_RECOVERY_SCHEMA_VERSION,
    operation: "recover",
    account: `c${ordinal}`,
    outcome,
    ok,
    problem_code: problemCode,
  };
}

function ownedHealthyObservation(
  refresh: RefreshResult,
  nowMs: number,
): Observation | null {
  const observation = refresh.observation;
  return refresh.outcome === "refreshed" &&
    observation !== null &&
    observation.health === "ok" &&
    isObservationFresh(observation, nowMs, OBSERVATION_FRESHNESS_CEILING_MS)
    ? observation
    : null;
}

function routeIdAtOrdinal(
  observation: Observation,
  ordinal: number,
): string | null {
  return (
    Object.entries(observation.claude_accounts.ordinals).find(
      ([, candidate]) => candidate === ordinal,
    )?.[0] ?? null
  );
}

function slotFromRouteId(routeId: string): number | null {
  const match = /^claude-swap:([1-9]\d*)$/u.exec(routeId);
  if (match === null) return null;
  const slot = Number(match[1]);
  return Number.isSafeInteger(slot) ? slot : null;
}

function routeIsHealthy(observation: Observation, routeId: string): boolean {
  return observation.routes.some((route) => route.id === routeId);
}

function observationClearsSlot(
  observation: Observation,
  slot: number,
): boolean {
  const routeId = `claude-swap:${slot}`;
  return (
    observation.claude_accounts.ordinals[routeId] === undefined ||
    observation.account_issues[routeId] !== "token-expired"
  );
}

function updateState(
  store: RecoveryStateStore,
  mutate: (state: RecoveryState) => boolean,
): void {
  store.mutate(mutate);
}

function clearSlotState(store: RecoveryStateStore, slot: number): void {
  updateState(store, (state) => {
    const key = String(slot);
    if (state.slots[key] === undefined) return false;
    delete state.slots[key];
    return true;
  });
}

function beginAttempt(
  store: RecoveryStateStore,
  slot: number,
  nowMs: number,
): void {
  updateState(store, (state) => {
    const key = String(slot);
    const prior = state.slots[key];
    if (
      prior === undefined &&
      Object.keys(state.slots).length >= MAX_CSWAP_ACCOUNTS
    ) {
      throw new Error("account recovery state is full");
    }
    const attempts = Math.min(
      BACKOFF_MINUTES.length,
      (prior?.attempts ?? 0) + 1,
    );
    state.slots[key] = {
      attempts,
      next_attempt_at_ms: nowMs + BACKOFF_MINUTES[attempts - 1] * 60_000,
      human_required: false,
    };
    return true;
  });
}

function latchHumanRequired(store: RecoveryStateStore, slot: number): void {
  updateState(store, (state) => {
    const entry = state.slots[String(slot)];
    if (entry === undefined || entry.human_required) return false;
    entry.human_required = true;
    return true;
  });
}

function dueForAutomatic(
  store: RecoveryStateStore,
  slot: number,
  nowMs: number,
): boolean {
  const entry = store.read().slots[String(slot)];
  return (
    entry === undefined ||
    (!entry.human_required && nowMs >= entry.next_attempt_at_ms)
  );
}

function reconcileFreshObservation(
  store: RecoveryStateStore,
  observation: Observation,
): void {
  updateState(store, (state) => {
    let changed = false;
    for (const key of Object.keys(state.slots)) {
      const slot = Number(key);
      if (observationClearsSlot(observation, slot)) {
        delete state.slots[key];
        changed = true;
      }
    }
    return changed;
  });
}

const realTryAcquireRecoveryLock: TryAcquireRecoveryLock = (path) =>
  FileLock.tryAcquire(path);
const OWNED_REFRESH = { requireOwnedCall: true } as const;

function recoveryProblemCode(
  outcome: AccountRecoveryOutcome,
): AccountRecoveryProblemCode {
  if (outcome === "recovery-unverified") return "route-unverified";
  if (outcome === "tool-failure") return "tool-failure";
  return null;
}

async function invokeRecovery(
  deps: AccountRecoveryDeps,
  slot: number,
): Promise<AccountRecoveryOutcome> {
  if (deps.signal?.aborted) return "tool-failure";
  try {
    const processOutcome = await deps.runner(
      cswapRecoverArgv(slot, deps.cswapBin),
      deps.signal,
    );
    return parseCswapRecovery(processOutcome, slot);
  } catch {
    return "tool-failure";
  }
}

/**
 * Run at most one due automatic recovery from one already-published fresh
 * observation. The per-slot lock covers owned revalidation, the prearmed
 * attempt, credential mutation, and the post-recovery Capacity proof.
 */
export async function runAutomaticAccountRecovery(
  observation: Observation,
  deps: AccountRecoveryDeps,
): Promise<AccountRecoveryResult | null> {
  const nowMs = deps.nowMs();
  if (
    deps.signal?.aborted ||
    observation.health !== "ok" ||
    !isObservationFresh(observation, nowMs, OBSERVATION_FRESHNESS_CEILING_MS)
  ) {
    return null;
  }
  const store = deps.stateStore ?? createFileRecoveryStateStore(deps.stateDir);
  const candidates = Object.entries(observation.claude_accounts.ordinals)
    .filter(
      ([routeId]) => observation.account_issues[routeId] === "token-expired",
    )
    .sort((left, right) => left[1] - right[1]);

  let selected: [string, number] | undefined;
  try {
    reconcileFreshObservation(store, observation);
    selected = candidates.find(([routeId]) => {
      const slot = slotFromRouteId(routeId);
      return slot !== null && dueForAutomatic(store, slot, nowMs);
    });
  } catch {
    return null;
  }
  if (selected === undefined) return null;
  const [routeId, ordinal] = selected;
  const slot = slotFromRouteId(routeId);
  if (slot === null) return null;
  const acquire = deps.tryAcquireRecoveryLock ?? realTryAcquireRecoveryLock;
  const lock = acquire(accountRecoverySlotLockPath(deps.stateDir, slot));
  if (lock === null) return null;
  try {
    try {
      if (!dueForAutomatic(store, slot, deps.nowMs())) return null;

      let revalidatedRefresh: RefreshResult;
      try {
        revalidatedRefresh = await deps.forceRefresh(OWNED_REFRESH);
      } catch {
        return result(
          ordinal,
          "recovery-unverified",
          false,
          "route-unverified",
        );
      }
      const revalidated = ownedHealthyObservation(
        revalidatedRefresh,
        deps.nowMs(),
      );
      if (revalidated === null) {
        return result(
          ordinal,
          "recovery-unverified",
          false,
          "route-unverified",
        );
      }
      reconcileFreshObservation(store, revalidated);
      if (
        revalidated.claude_accounts.ordinals[routeId] === undefined ||
        revalidated.account_issues[routeId] !== "token-expired"
      ) {
        return null;
      }

      beginAttempt(store, slot, deps.nowMs());
      const recoveryOutcome = await invokeRecovery(deps, slot);
      if (recoveryOutcome === "human-required") {
        latchHumanRequired(store, slot);
      }

      let refreshed: RefreshResult;
      try {
        refreshed = await deps.forceRefresh(OWNED_REFRESH);
      } catch {
        const failedOutcome =
          recoveryOutcome === "recovered" || recoveryOutcome === "not-needed"
            ? "recovery-unverified"
            : recoveryOutcome;
        return result(
          ordinal,
          failedOutcome,
          false,
          recoveryProblemCode(failedOutcome),
        );
      }
      const after = ownedHealthyObservation(refreshed, deps.nowMs());
      if (after !== null && observationClearsSlot(after, slot)) {
        clearSlotState(store, slot);
        if (
          routeIsHealthy(after, routeId) &&
          (recoveryOutcome === "recovered" || recoveryOutcome === "not-needed")
        ) {
          return result(ordinal, recoveryOutcome, true, null);
        }
      }
      const effectiveOutcome =
        recoveryOutcome === "recovered" || recoveryOutcome === "not-needed"
          ? "recovery-unverified"
          : recoveryOutcome;
      return result(
        ordinal,
        effectiveOutcome,
        false,
        recoveryProblemCode(effectiveOutcome),
      );
    } catch (error) {
      if (error instanceof RecoveryStateLockContentionError) return null;
      return result(ordinal, "tool-failure", false, "tool-failure");
    }
  } finally {
    lock.release();
  }
}

/**
 * Explicit foreground recovery by current inventory ordinal. It always forces
 * owned inventory before selection and again under the stable route's slot
 * lock. It bypasses prior backoff/latch by prearming a new attempt.
 */
export async function runForegroundAccountRecovery(
  deps: ForegroundAccountRecoveryDeps,
): Promise<AccountRecoveryResult> {
  try {
    return await runForegroundAccountRecoveryInner(deps);
  } catch (error) {
    return error instanceof RecoveryStateLockContentionError
      ? result(deps.ordinal, "tool-failure", false, "recovery-busy")
      : result(deps.ordinal, "tool-failure", false, "tool-failure");
  }
}

async function runForegroundAccountRecoveryInner(
  deps: ForegroundAccountRecoveryDeps,
): Promise<AccountRecoveryResult> {
  const ordinal = deps.ordinal;
  const before = ownedHealthyObservation(
    await deps.forceRefresh(OWNED_REFRESH),
    deps.nowMs(),
  );
  if (before === null) {
    return result(
      ordinal,
      "recovery-unverified",
      false,
      "observation-unavailable",
    );
  }
  const store = deps.stateStore ?? createFileRecoveryStateStore(deps.stateDir);
  reconcileFreshObservation(store, before);
  const routeId = routeIdAtOrdinal(before, ordinal);
  if (routeId === null) {
    return result(ordinal, "recovery-unverified", false, "account-not-found");
  }
  if (routeIsHealthy(before, routeId)) {
    return result(ordinal, "not-needed", true, null);
  }
  if (before.account_issues[routeId] !== "token-expired") {
    return result(
      ordinal,
      "recovery-unverified",
      false,
      "account-not-token-expired",
    );
  }
  const slot = slotFromRouteId(routeId);
  if (slot === null) {
    return result(ordinal, "recovery-unverified", false, "account-not-found");
  }
  const acquire = deps.tryAcquireRecoveryLock ?? realTryAcquireRecoveryLock;
  const lock = acquire(accountRecoverySlotLockPath(deps.stateDir, slot));
  if (lock === null) {
    return result(ordinal, "tool-failure", false, "recovery-busy");
  }
  try {
    let revalidatedRefresh: RefreshResult;
    try {
      revalidatedRefresh = await deps.forceRefresh(OWNED_REFRESH);
    } catch {
      return result(ordinal, "recovery-unverified", false, "route-unverified");
    }
    const revalidated = ownedHealthyObservation(
      revalidatedRefresh,
      deps.nowMs(),
    );
    if (revalidated === null) {
      return result(ordinal, "recovery-unverified", false, "route-unverified");
    }
    reconcileFreshObservation(store, revalidated);
    if (revalidated.claude_accounts.ordinals[routeId] === undefined) {
      return result(ordinal, "recovery-unverified", false, "account-not-found");
    }
    if (routeIsHealthy(revalidated, routeId)) {
      return result(ordinal, "not-needed", true, null);
    }
    if (revalidated.account_issues[routeId] !== "token-expired") {
      return result(
        ordinal,
        "recovery-unverified",
        false,
        "account-not-token-expired",
      );
    }

    beginAttempt(store, slot, deps.nowMs());
    const recoveryOutcome = await invokeRecovery(deps, slot);
    if (recoveryOutcome === "human-required") {
      latchHumanRequired(store, slot);
    }
    if (recoveryOutcome !== "recovered" && recoveryOutcome !== "not-needed") {
      return result(
        ordinal,
        recoveryOutcome,
        false,
        recoveryProblemCode(recoveryOutcome),
      );
    }

    let refreshed: RefreshResult;
    try {
      refreshed = await deps.forceRefresh(OWNED_REFRESH);
    } catch {
      return result(ordinal, "recovery-unverified", false, "route-unverified");
    }
    const after = ownedHealthyObservation(refreshed, deps.nowMs());
    if (after !== null && observationClearsSlot(after, slot)) {
      clearSlotState(store, slot);
      if (routeIsHealthy(after, routeId)) {
        return result(ordinal, recoveryOutcome, true, null);
      }
    }
    return result(ordinal, "recovery-unverified", false, "route-unverified");
  } finally {
    lock.release();
  }
}

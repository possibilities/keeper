import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type {
  AccountFocusInput,
  AccountFocusPolicy,
  AccountFocusStatus,
  ManagedAccountRouteId,
  NonFableFocusInput,
  NonFableFocusPolicy,
  NonFableFocusStatus,
} from "./types";

export const ACCOUNT_FOCUS_LEAF_SCHEMA_VERSION = 1;
export const MAX_ACCOUNT_FOCUS_LEAF_BYTES = 8_192;
export const NON_FABLE_FOCUS_LEAF_SCHEMA_VERSION =
  ACCOUNT_FOCUS_LEAF_SCHEMA_VERSION;
export const MAX_NON_FABLE_FOCUS_LEAF_BYTES = MAX_ACCOUNT_FOCUS_LEAF_BYTES;

export type AccountFocusDelivery<P = AccountFocusPolicy> =
  | { available: true; policy: P | null }
  | {
      available: false;
      diagnostic: AccountFocusDeliveryDiagnostic;
    };

export type AccountFocusDeliveryDiagnostic =
  | "delivery-missing"
  | "delivery-malformed"
  | "delivery-unsupported"
  | "delivery-insecure"
  | "delivery-unreachable";

export interface AccountFocusLeaf<P = AccountFocusPolicy> {
  schema_version: 1;
  policy: P | null;
}

export type NonFableFocusDelivery = AccountFocusDelivery<NonFableFocusPolicy>;
export type NonFableFocusLeaf = AccountFocusLeaf<NonFableFocusPolicy>;
export type NormalizedAccountFocusInput = AccountFocusInput;
export type NormalizedNonFableFocusInput = NonFableFocusInput;

export interface AccountFocusPublishDeps {
  rename?: typeof renameSync;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function normalizeManagedRouteId(
  value: unknown,
): ManagedAccountRouteId | null {
  if (typeof value !== "string") return null;
  const match = /^claude-swap:([1-9]\d*)$/u.exec(value);
  if (match === null) return null;
  const slot = Number(match[1]);
  return Number.isSafeInteger(slot) ? (`claude-swap:${slot}` as const) : null;
}

function hasTimezone(value: string): boolean {
  if (/[zZ]$/u.test(value)) return true;
  const time = value.includes("T")
    ? value.slice(value.indexOf("T") + 1)
    : value;
  return /[+-]\d{2}:?\d{2}$/u.test(time);
}

export function normalizeUtcTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !hasTimezone(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

export function normalizeAccountFocusInput(
  value: unknown,
): NormalizedAccountFocusInput | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["target_route", "lifetime"])) {
    return null;
  }
  const targetRoute = normalizeManagedRouteId(value.target_route);
  const lifetime = value.lifetime;
  if (
    targetRoute === null ||
    !isRecord(lifetime) ||
    typeof lifetime.kind !== "string"
  ) {
    return null;
  }
  if (lifetime.kind === "permanent") {
    return hasOnlyKeys(lifetime, ["kind"])
      ? { target_route: targetRoute, lifetime: { kind: "permanent" } }
      : null;
  }
  if (lifetime.kind !== "absolute") return null;
  if (!hasOnlyKeys(lifetime, ["kind", "deadline_at"])) return null;
  const deadline = normalizeUtcTimestamp(lifetime.deadline_at);
  return deadline === null
    ? null
    : {
        target_route: targetRoute,
        lifetime: { kind: "absolute", deadline_at: deadline },
      };
}

export const normalizeNonFableFocusInput = normalizeAccountFocusInput;

export function materializeAccountFocusPolicy<T extends boolean>(
  input: NormalizedAccountFocusInput,
  eventId: number,
  eventTsSeconds: number,
  fableIntent: T,
): AccountFocusPolicy<T> | null {
  if (!Number.isSafeInteger(eventId) || eventId <= 0) return null;
  let eventStamp: string;
  try {
    eventStamp = new Date(eventTsSeconds * 1_000).toISOString();
  } catch {
    return null;
  }
  const setAt = normalizeUtcTimestamp(eventStamp);
  if (setAt === null) return null;
  return {
    schema_version: 1,
    policy_id: `event:${eventId}`,
    target_route: input.target_route,
    fable_intent: fableIntent,
    set_at: setAt,
    lifetime: input.lifetime,
  };
}

export function materializeNonFableFocusPolicy(
  input: NormalizedNonFableFocusInput,
  eventId: number,
  eventTsSeconds: number,
): NonFableFocusPolicy | null {
  if (
    input.lifetime.kind === "absolute" &&
    Date.parse(input.lifetime.deadline_at) <= eventTsSeconds * 1_000
  ) {
    return null;
  }
  return materializeAccountFocusPolicy(input, eventId, eventTsSeconds, false);
}

export function validateAccountFocusPolicy<T extends boolean>(
  value: unknown,
  fableIntent: T,
): AccountFocusPolicy<T> | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schema_version",
      "policy_id",
      "target_route",
      "fable_intent",
      "set_at",
      "lifetime",
    ]) ||
    value.schema_version !== 1 ||
    typeof value.policy_id !== "string" ||
    !/^event:[1-9]\d*$/u.test(value.policy_id) ||
    value.fable_intent !== fableIntent
  ) {
    return null;
  }
  const targetRoute = normalizeManagedRouteId(value.target_route);
  const setAt = normalizeUtcTimestamp(value.set_at);
  if (
    targetRoute === null ||
    setAt === null ||
    setAt !== value.set_at ||
    !isRecord(value.lifetime)
  ) {
    return null;
  }
  const normalized = normalizeAccountFocusInput({
    target_route: targetRoute,
    lifetime: value.lifetime,
  });
  if (normalized === null) return null;
  return {
    schema_version: 1,
    policy_id: value.policy_id,
    target_route: targetRoute,
    fable_intent: fableIntent,
    set_at: setAt,
    lifetime: normalized.lifetime,
  };
}

export function validateNonFableFocusPolicy(
  value: unknown,
): NonFableFocusPolicy | null {
  return validateAccountFocusPolicy(value, false);
}

export function serializeAccountFocusPolicy(
  policy: AccountFocusPolicy,
): string {
  return JSON.stringify(policy);
}

export function serializeNonFableFocusPolicy(
  policy: NonFableFocusPolicy,
): string {
  return serializeAccountFocusPolicy(policy);
}

export function parseAccountFocusPolicy<T extends boolean>(
  value: unknown,
  fableIntent: T,
): AccountFocusPolicy<T> | null {
  if (
    typeof value !== "string" ||
    value.length > MAX_ACCOUNT_FOCUS_LEAF_BYTES
  ) {
    return null;
  }
  try {
    return validateAccountFocusPolicy(JSON.parse(value), fableIntent);
  } catch {
    return null;
  }
}

export function parseNonFableFocusPolicy(
  value: unknown,
): NonFableFocusPolicy | null {
  return parseAccountFocusPolicy(value, false);
}

export function effectiveAccountFocus<T extends boolean>(
  delivery: AccountFocusDelivery<AccountFocusPolicy<T>>,
  _observation: unknown,
  nowMs: number,
  fableIntent: T,
): AccountFocusStatus<AccountFocusPolicy<T>> {
  if (!delivery.available) {
    return {
      state: "unavailable",
      policy: null,
      diagnostic: delivery.diagnostic,
    };
  }
  const policy = delivery.policy;
  if (policy === null) {
    return { state: "off", policy: null, diagnostic: "none" };
  }
  if (
    validateAccountFocusPolicy(policy, fableIntent) === null ||
    !Number.isFinite(nowMs)
  ) {
    return {
      state: "invalid",
      policy: null,
      diagnostic: "policy-invalid",
    };
  }
  if (policy.lifetime.kind === "absolute") {
    return {
      state:
        nowMs < Date.parse(policy.lifetime.deadline_at) ? "active" : "expired",
      policy,
      diagnostic: "none",
    };
  }
  return { state: "active", policy, diagnostic: "none" };
}

export function effectiveNonFableFocus(
  delivery: NonFableFocusDelivery,
  observation: unknown,
  nowMs: number,
): NonFableFocusStatus {
  return effectiveAccountFocus(delivery, observation, nowMs, false);
}

export function serializeAccountFocusLeaf<P>(policy: P | null): string {
  return `${JSON.stringify({
    schema_version: ACCOUNT_FOCUS_LEAF_SCHEMA_VERSION,
    policy,
  } satisfies AccountFocusLeaf<P>)}\n`;
}

export const serializeNonFableFocusLeaf =
  serializeAccountFocusLeaf<NonFableFocusPolicy>;

export function publishValidatedAccountFocusLeaf<P>(
  path: string,
  policy: P | null,
  validatePolicy: (value: unknown) => P | null,
  deps: AccountFocusPublishDeps = {},
): void {
  if (policy !== null && validatePolicy(policy) === null) {
    throw new Error("refusing to publish an invalid Account-focus policy");
  }
  const serialized = serializeAccountFocusLeaf(policy);
  if (Buffer.byteLength(serialized, "utf8") > MAX_ACCOUNT_FOCUS_LEAF_BYTES) {
    throw new Error("refusing to publish an oversized Account-focus policy");
  }
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(
      tmp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    writeSync(fd, serialized);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    (deps.rename ?? renameSync)(tmp, path);
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup; the authoritative Projection is unchanged
    }
    throw error;
  }
}

export function publishAccountFocusLeaf<T extends boolean>(
  path: string,
  policy: AccountFocusPolicy<T> | null,
  fableIntent: T,
  deps: AccountFocusPublishDeps = {},
): void {
  publishValidatedAccountFocusLeaf(
    path,
    policy,
    (value) => validateAccountFocusPolicy(value, fableIntent),
    deps,
  );
}

export function publishNonFableFocusLeaf(
  path: string,
  policy: NonFableFocusPolicy | null,
  deps: AccountFocusPublishDeps = {},
): void {
  publishValidatedAccountFocusLeaf(
    path,
    policy,
    validateNonFableFocusPolicy,
    deps,
  );
}

export function readValidatedAccountFocusLeaf<P>(
  path: string,
  validatePolicy: (value: unknown) => P | null,
): AccountFocusDelivery<P> {
  if (!existsSync(path)) {
    return { available: false, diagnostic: "delivery-missing" };
  }
  let fd: number | null = null;
  let text: string;
  try {
    const pathStat = lstatSync(path);
    if (!pathStat.isFile() || (pathStat.mode & 0o077) !== 0) {
      return { available: false, diagnostic: "delivery-insecure" };
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      return { available: false, diagnostic: "delivery-insecure" };
    }
    if (stat.size <= 0 || stat.size > MAX_ACCOUNT_FOCUS_LEAF_BYTES) {
      return { available: false, diagnostic: "delivery-malformed" };
    }
    text = readFileSync(fd, "utf8");
    closeSync(fd);
    fd = null;
  } catch {
    return { available: false, diagnostic: "delivery-unreachable" };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { available: false, diagnostic: "delivery-malformed" };
  }
  if (!isRecord(parsed)) {
    return { available: false, diagnostic: "delivery-malformed" };
  }
  if (parsed.schema_version !== ACCOUNT_FOCUS_LEAF_SCHEMA_VERSION) {
    return { available: false, diagnostic: "delivery-unsupported" };
  }
  if (!hasOnlyKeys(parsed, ["schema_version", "policy"])) {
    return { available: false, diagnostic: "delivery-malformed" };
  }
  if (parsed.policy === null) return { available: true, policy: null };
  const policy = validatePolicy(parsed.policy);
  return policy === null
    ? { available: false, diagnostic: "delivery-malformed" }
    : { available: true, policy };
}

export function readAccountFocusLeaf<T extends boolean>(
  path: string,
  fableIntent: T,
): AccountFocusDelivery<AccountFocusPolicy<T>> {
  return readValidatedAccountFocusLeaf(path, (value) =>
    validateAccountFocusPolicy(value, fableIntent),
  );
}

export function readNonFableFocusLeaf(path: string): NonFableFocusDelivery {
  return readValidatedAccountFocusLeaf(path, validateNonFableFocusPolicy);
}

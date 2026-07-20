import {
  ACCOUNT_FOCUS_LEAF_SCHEMA_VERSION,
  type AccountFocusDelivery,
  type AccountFocusLeaf,
  type AccountFocusPublishDeps,
  effectiveAccountFocus,
  MAX_ACCOUNT_FOCUS_LEAF_BYTES,
  materializeAccountFocusPolicy,
  normalizeAccountFocusInput,
  normalizeManagedRouteId,
  normalizeUtcTimestamp,
  publishValidatedAccountFocusLeaf,
  readValidatedAccountFocusLeaf,
  serializeAccountFocusLeaf,
} from "./account-focus";
import {
  isObservationFresh,
  isRouteMeasurementFresh,
  type Observation,
} from "./account-observation";
import type {
  FableFocusInput,
  FableFocusPolicy,
  FableFocusStatus,
  ManagedAccountRouteId,
} from "./types";

export { normalizeManagedRouteId, normalizeUtcTimestamp };

export const FABLE_FOCUS_LEAF_SCHEMA_VERSION =
  ACCOUNT_FOCUS_LEAF_SCHEMA_VERSION;
export const MAX_FABLE_FOCUS_LEAF_BYTES = MAX_ACCOUNT_FOCUS_LEAF_BYTES;

export type FableFocusLeaf = AccountFocusLeaf<FableFocusPolicy>;
export type FableFocusDelivery = AccountFocusDelivery<FableFocusPolicy>;

export interface NormalizedFableFocusInput {
  target_route: ManagedAccountRouteId;
  lifetime: FableFocusPolicy["lifetime"];
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

/** Strictly validate and canonicalize the one atomic generic-config field. */
export function normalizeFableFocusInput(
  value: unknown,
): NormalizedFableFocusInput | null {
  const common = normalizeAccountFocusInput(value);
  if (common !== null) return common;
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
  if (lifetime.kind === "current-reset") {
    if (!hasOnlyKeys(lifetime, ["kind", "reset_at"])) return null;
    const reset = normalizeUtcTimestamp(lifetime.reset_at);
    return reset === null
      ? null
      : {
          target_route: targetRoute,
          lifetime: { kind: "absolute", deadline_at: reset },
        };
  }
  if (lifetime.kind === "cycle-end") {
    if (!hasOnlyKeys(lifetime, ["kind", "reset_at"])) return null;
    const reset = normalizeUtcTimestamp(lifetime.reset_at);
    return reset === null
      ? null
      : {
          target_route: targetRoute,
          lifetime: { kind: "cycle-end", reset_at: reset },
        };
  }
  return null;
}

/** Build the canonical durable policy from event-owned identity and time. */
export function materializeFableFocusPolicy(
  input: NormalizedFableFocusInput,
  eventId: number,
  eventTsSeconds: number,
): FableFocusPolicy | null {
  if (input.lifetime.kind !== "cycle-end") {
    return materializeAccountFocusPolicy(
      { target_route: input.target_route, lifetime: input.lifetime },
      eventId,
      eventTsSeconds,
      true,
    );
  }
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
    fable_intent: true,
    set_at: setAt,
    lifetime: input.lifetime,
  };
}

export function validateFableFocusPolicy(
  value: unknown,
): FableFocusPolicy | null {
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
    value.fable_intent !== true
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
  const normalized = normalizeFableFocusInput({
    target_route: targetRoute,
    lifetime: value.lifetime,
  });
  if (normalized === null) return null;
  if (normalized.lifetime.kind !== value.lifetime.kind) return null;
  return {
    schema_version: 1,
    policy_id: value.policy_id,
    target_route: targetRoute,
    fable_intent: true,
    set_at: setAt,
    lifetime: normalized.lifetime,
  };
}

export function serializeFableFocusPolicy(policy: FableFocusPolicy): string {
  return JSON.stringify(policy);
}

export function parseFableFocusPolicy(value: unknown): FableFocusPolicy | null {
  if (typeof value !== "string" || value.length > MAX_FABLE_FOCUS_LEAF_BYTES) {
    return null;
  }
  try {
    return validateFableFocusPolicy(JSON.parse(value));
  } catch {
    return null;
  }
}

function matchingFableWindowCompleted(
  policy: FableFocusPolicy,
  observation: Observation | null,
  nowMs: number,
): boolean {
  if (
    policy.lifetime.kind !== "cycle-end" ||
    observation === null ||
    observation.health !== "ok" ||
    !isObservationFresh(observation, nowMs)
  ) {
    return false;
  }
  const route = observation.routes.find(
    (candidate) => candidate.id === policy.target_route,
  );
  if (route === undefined || !isRouteMeasurementFresh(route, nowMs)) {
    return false;
  }
  const boundaryMs = Date.parse(policy.lifetime.reset_at);
  return route.windows.some((window) => {
    if (window.key.toLowerCase() !== "model:fable") return false;
    if (window.resetsAt === null) return false;
    return (
      Date.parse(window.resetsAt) === boundaryMs && window.utilization >= 1
    );
  });
}

/** Pure half-open lifetime evaluation for one delivered policy. */
export function effectiveFableFocus(
  delivery: FableFocusDelivery,
  observation: Observation | null,
  nowMs: number,
): FableFocusStatus {
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
  if (validateFableFocusPolicy(policy) === null || !Number.isFinite(nowMs)) {
    return {
      state: "invalid",
      policy: null,
      diagnostic: "policy-invalid",
    };
  }
  if (policy.lifetime.kind !== "cycle-end") {
    return effectiveAccountFocus(
      { available: true, policy: { ...policy, lifetime: policy.lifetime } },
      observation,
      nowMs,
      true,
    );
  }
  const completed =
    nowMs >= Date.parse(policy.lifetime.reset_at) ||
    matchingFableWindowCompleted(policy, observation, nowMs);
  return {
    state: completed ? "completed" : "active",
    policy,
    diagnostic: "none",
  };
}

export type CurrentResetFocusResult =
  | { ok: true; focus: FableFocusInput }
  | {
      ok: false;
      reason:
        | "observation-unavailable"
        | "observation-stale"
        | "target-unavailable"
        | "reset-unavailable"
        | "reset-elapsed"
        | "reset-mismatch";
    };

/** Guarded current-reset construction; it never advances to a later cycle. */
export function buildCurrentResetFableFocus(
  targetRouteValue: unknown,
  observation: Observation | null,
  nowMs: number,
  expectedReset: string | null = null,
): CurrentResetFocusResult {
  const targetRoute = normalizeManagedRouteId(targetRouteValue);
  if (observation === null || observation.health !== "ok") {
    return { ok: false, reason: "observation-unavailable" };
  }
  if (!isObservationFresh(observation, nowMs)) {
    return { ok: false, reason: "observation-stale" };
  }
  const route = observation.routes.find(
    (candidate) => candidate.id === targetRoute,
  );
  if (
    targetRoute === null ||
    route === undefined ||
    !isRouteMeasurementFresh(route, nowMs)
  ) {
    return { ok: false, reason: "target-unavailable" };
  }
  const window = route.windows.find(
    (candidate) => candidate.key.toLowerCase() === "model:fable",
  );
  const resetAt = normalizeUtcTimestamp(window?.resetsAt);
  if (resetAt === null) return { ok: false, reason: "reset-unavailable" };
  const resetMs = Date.parse(resetAt);
  if (nowMs >= resetMs) return { ok: false, reason: "reset-elapsed" };
  if (expectedReset !== null) {
    const expected = normalizeUtcTimestamp(expectedReset);
    if (
      expected === null ||
      Math.floor(Date.parse(expected) / 1_000) !== Math.floor(resetMs / 1_000)
    ) {
      return { ok: false, reason: "reset-mismatch" };
    }
  }
  return {
    ok: true,
    focus: {
      target_route: targetRoute,
      lifetime: { kind: "current-reset", reset_at: resetAt },
    },
  };
}

export function serializeFableFocusLeaf(
  policy: FableFocusPolicy | null,
): string {
  return serializeAccountFocusLeaf(policy);
}

export interface FableFocusPublishDeps extends AccountFocusPublishDeps {}

/** Atomically publish one owner-only launch leaf. */
export function publishFableFocusLeaf(
  path: string,
  policy: FableFocusPolicy | null,
  deps: FableFocusPublishDeps = {},
): void {
  if (policy !== null && validateFableFocusPolicy(policy) === null) {
    throw new Error("refusing to publish an invalid Fable-focus policy");
  }
  publishValidatedAccountFocusLeaf(
    path,
    policy,
    validateFableFocusPolicy,
    deps,
  );
}

/** Bounded, mode-restricted cold-launch read. It never throws. */
export function readFableFocusLeaf(path: string): FableFocusDelivery {
  return readValidatedAccountFocusLeaf(path, validateFableFocusPolicy);
}

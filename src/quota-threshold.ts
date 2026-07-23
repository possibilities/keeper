/**
 * Canonical percentage-threshold predicates plus the frozen-route model the
 * `context-used-at-least` and `weekly-quota-at-most` awaits evaluate against.
 *
 * The pure half — percent parsing, the two inclusive raw-percent comparisons,
 * frozen-route (de)serialization, and evidence→verdict evaluation — never
 * touches the filesystem or a provider observer so it re-folds and unit-tests
 * deterministically. The impure adapter half reads validated Capacity sidecars
 * and routing inspectors through the same readers the display surfaces use; it
 * never opens a writable DB, refreshes an observer, or reads credentials, and
 * every reader is injectable so callers can drive it from fixtures.
 */

import {
  isObservationFresh,
  type Observation,
  type Route,
  readObservationSidecar,
} from "./account-observation";
import { inspectRouting, type RoutingInspection } from "./account-router";
import {
  observationSidecarPath,
  resolveAccountRoutingRoot,
} from "./account-routing-config";
import {
  type CodexRoutingInspection,
  inspectCodexRouting,
} from "./codex-account-router";
import {
  CODEX_GENERIC_QUOTA_SCOPE,
  type CodexQuotaScope,
  isCodexQuotaScope,
} from "./codex-quota-scope";
import {
  type ExactRuntimeObservation,
  RUNTIME_CURRENT_MAX_AGE_MS,
  readExactRuntimeObservation,
  resolveSessionRuntimeDir,
} from "./session-runtime";

// ---------------------------------------------------------------------------
// Percent parsing + the two inclusive raw-percent predicates
// ---------------------------------------------------------------------------

export const THRESHOLD_MIN_PERCENT = 0;
export const THRESHOLD_MAX_PERCENT = 100;
/** The single stable weekly meter key both providers expose. */
export const WEEKLY_METER = "week" as const;

export type ThresholdParse =
  | { ok: true; value: number }
  | { ok: false; message: string };

/**
 * Parse an inclusive `[0,100]` percent. Accepts a finite integer or
 * fixed-point fractional (`50`, `50.5`, `0`, `100`); rejects a sign,
 * scientific notation, `Infinity`/`NaN`, and any out-of-range value. The
 * parsed value is the RAW canonical percent compared at equality — never
 * rounded or renormalized.
 */
export function parseThresholdPercent(raw: string): ThresholdParse {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return {
      ok: false,
      message: `'${raw}' is not a finite percent in [${THRESHOLD_MIN_PERCENT},${THRESHOLD_MAX_PERCENT}]`,
    };
  }
  const value = Number(trimmed);
  if (
    !Number.isFinite(value) ||
    value < THRESHOLD_MIN_PERCENT ||
    value > THRESHOLD_MAX_PERCENT
  ) {
    return {
      ok: false,
      message: `'${raw}' is out of range (expected [${THRESHOLD_MIN_PERCENT},${THRESHOLD_MAX_PERCENT}])`,
    };
  }
  return { ok: true, value };
}

/** `context-used-at-least P`: the used percentage is at or above `P`. */
export function contextUsedAtLeastMet(
  usedPercent: number,
  threshold: number,
): boolean {
  return usedPercent >= threshold;
}

/** `weekly-quota-at-most P`: the used percentage is at or below `P`. */
export function weeklyQuotaAtMostMet(
  usedPercent: number,
  threshold: number,
): boolean {
  return usedPercent <= threshold;
}

// ---------------------------------------------------------------------------
// Frozen weekly route — the immutable armed intent
// ---------------------------------------------------------------------------

export type WeeklyRouteProvider = "claude" | "codex";

/**
 * The concrete route, weekly meter, and (Codex) quota scope frozen at arm
 * time. A durable weekly-quota await watches THIS route's meter for its whole
 * life; a later routing decision never retargets it.
 */
export interface FrozenWeeklyRoute {
  provider: WeeklyRouteProvider;
  /** Stable Claude managed-route id, or opaque Codex alias. */
  route: string;
  weekly_meter: typeof WEEKLY_METER;
  /** Codex quota scope; `null` for a Claude route. */
  quota_scope: CodexQuotaScope | null;
  resolved_at_ms: number;
}

/** The persisted durable-await condition segment for a weekly-quota wait. */
export interface WeeklyQuotaDurableCondition {
  condition: "weekly-quota-at-most";
  threshold: number;
  provider: WeeklyRouteProvider;
  route: string;
  weekly_meter: typeof WEEKLY_METER;
  quota_scope: CodexQuotaScope | null;
  resolved_at_ms: number;
}

export function buildWeeklyQuotaCondition(
  threshold: number,
  frozen: FrozenWeeklyRoute,
): WeeklyQuotaDurableCondition {
  return {
    condition: "weekly-quota-at-most",
    threshold,
    provider: frozen.provider,
    route: frozen.route,
    weekly_meter: WEEKLY_METER,
    quota_scope: frozen.quota_scope,
    resolved_at_ms: frozen.resolved_at_ms,
  };
}

/**
 * Strictly validate a persisted weekly-quota condition back into its typed
 * shape. Returns `null` on any missing/mistyped field so a malformed durable
 * row folds to a bounded "unknown condition" wait rather than a silent zero.
 */
export function parseWeeklyQuotaCondition(
  raw: Record<string, unknown>,
): WeeklyQuotaDurableCondition | null {
  if (raw.condition !== "weekly-quota-at-most") return null;
  const threshold = raw.threshold;
  if (
    typeof threshold !== "number" ||
    !Number.isFinite(threshold) ||
    threshold < THRESHOLD_MIN_PERCENT ||
    threshold > THRESHOLD_MAX_PERCENT
  ) {
    return null;
  }
  const provider = raw.provider;
  if (provider !== "claude" && provider !== "codex") return null;
  const route = raw.route;
  if (typeof route !== "string" || route.length === 0) return null;
  if (raw.weekly_meter !== WEEKLY_METER) return null;
  const quotaScope = raw.quota_scope;
  if (provider === "claude") {
    if (quotaScope !== null) return null;
  } else if (!isCodexQuotaScope(quotaScope)) {
    return null;
  }
  const resolvedAt = raw.resolved_at_ms;
  if (typeof resolvedAt !== "number" || !Number.isFinite(resolvedAt)) {
    return null;
  }
  return {
    condition: "weekly-quota-at-most",
    threshold,
    provider,
    route,
    weekly_meter: WEEKLY_METER,
    quota_scope: provider === "claude" ? null : (quotaScope as CodexQuotaScope),
    resolved_at_ms: resolvedAt,
  };
}

export function frozenRouteOf(
  condition: WeeklyQuotaDurableCondition,
): FrozenWeeklyRoute {
  return {
    provider: condition.provider,
    route: condition.route,
    weekly_meter: condition.weekly_meter,
    quota_scope: condition.quota_scope,
    resolved_at_ms: condition.resolved_at_ms,
  };
}

// ---------------------------------------------------------------------------
// Weekly-quota evidence → verdict (pure)
// ---------------------------------------------------------------------------

/** Bounded, PII-free reason codes surfaced on a weekly-quota verdict. */
export type WeeklyQuotaReason =
  | "met"
  | "below-threshold"
  | "route-evidence-missing"
  | "route-evidence-stale"
  | "route-removed"
  | "weekly-meter-missing";

/**
 * Normalized weekly-quota reading. `usage` is a fresh, present measurement;
 * every other member is a distinct not-yet-decidable state that leaves the
 * await visibly waiting rather than reading as zero usage.
 */
export type WeeklyQuotaEvidence =
  | { kind: "usage"; used_percent: number }
  | { kind: "missing" }
  | { kind: "stale" }
  | { kind: "removed" }
  | { kind: "meter-missing" };

export interface WeeklyQuotaVerdict {
  met: boolean;
  reason: WeeklyQuotaReason;
  /** Present only for a decidable reading. */
  used_percent: number | null;
}

export function evaluateWeeklyQuotaThreshold(
  evidence: WeeklyQuotaEvidence,
  threshold: number,
): WeeklyQuotaVerdict {
  switch (evidence.kind) {
    case "missing":
      return {
        met: false,
        reason: "route-evidence-missing",
        used_percent: null,
      };
    case "stale":
      return { met: false, reason: "route-evidence-stale", used_percent: null };
    case "removed":
      return { met: false, reason: "route-removed", used_percent: null };
    case "meter-missing":
      return { met: false, reason: "weekly-meter-missing", used_percent: null };
    case "usage": {
      const met = weeklyQuotaAtMostMet(evidence.used_percent, threshold);
      return {
        met,
        reason: met ? "met" : "below-threshold",
        used_percent: evidence.used_percent,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Context evidence → verdict (pure)
// ---------------------------------------------------------------------------

export type ContextReason =
  | "met"
  | "below-threshold"
  | "runtime-missing"
  | "runtime-stale"
  | "context-unavailable"
  | "target-ended";

/**
 * Normalized ambient-runtime context reading. `usage` is a fresh, proven
 * measurement; `ended` is a proven terminal subject (a bounded target-ended
 * failure); the rest leave the await waiting.
 */
export type ContextEvidence =
  | { kind: "usage"; used_percent: number }
  | { kind: "missing" }
  | { kind: "stale" }
  | { kind: "context-unavailable" }
  | { kind: "ended" };

export interface ContextVerdict {
  met: boolean;
  reason: ContextReason;
  /** True for a bounded target-ended terminal (never a plain wait). */
  ended: boolean;
  used_percent: number | null;
}

export function evaluateContextThreshold(
  evidence: ContextEvidence,
  threshold: number,
): ContextVerdict {
  switch (evidence.kind) {
    case "ended":
      return {
        met: false,
        reason: "target-ended",
        ended: true,
        used_percent: null,
      };
    case "missing":
      return {
        met: false,
        reason: "runtime-missing",
        ended: false,
        used_percent: null,
      };
    case "stale":
      return {
        met: false,
        reason: "runtime-stale",
        ended: false,
        used_percent: null,
      };
    case "context-unavailable":
      return {
        met: false,
        reason: "context-unavailable",
        ended: false,
        used_percent: null,
      };
    case "usage": {
      const met = contextUsedAtLeastMet(evidence.used_percent, threshold);
      return {
        met,
        reason: met ? "met" : "below-threshold",
        ended: false,
        used_percent: evidence.used_percent,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Weekly-quota capacity adapter (impure — validated readers, no writes)
// ---------------------------------------------------------------------------

/** Highest weekly-window utilization (0–1) for a Claude route, or null. */
export function weeklyUtilizationForRoute(route: Route): number | null {
  let found = false;
  let worst = 0;
  for (const window of route.windows) {
    if (window.key === WEEKLY_METER) {
      found = true;
      worst = Math.max(worst, window.utilization);
    }
  }
  return found ? worst : null;
}

export interface WeeklyEvidenceDeps {
  /** Read the Claude Capacity observation sidecar. */
  readClaudeObservation?: () => Observation | null;
  observationFresh?: (obs: Observation, nowMs: number) => boolean;
  /** Inspect scoped Codex routing for a quota scope. */
  inspectCodex?: (quotaScope: CodexQuotaScope) => CodexRoutingInspection;
}

function productionReadClaudeObservation(): Observation | null {
  return readObservationSidecar(
    observationSidecarPath(resolveAccountRoutingRoot()),
  );
}

/**
 * Read one frozen route's current weekly meter through the provider-owned
 * freshness/eligibility readers. Missing/stale/removed evidence never becomes
 * zero usage — each maps to a distinct waiting evidence member.
 */
export function readWeeklyQuotaEvidence(
  frozen: FrozenWeeklyRoute,
  nowMs: number,
  deps: WeeklyEvidenceDeps = {},
): WeeklyQuotaEvidence {
  if (frozen.provider === "claude") {
    const observation = (
      deps.readClaudeObservation ?? productionReadClaudeObservation
    )();
    if (observation === null) return { kind: "missing" };
    const fresh = (deps.observationFresh ?? isObservationFresh)(
      observation,
      nowMs,
    );
    if (!fresh) return { kind: "stale" };
    const route = observation.routes.find((r) => r.id === frozen.route);
    if (route === undefined) return { kind: "removed" };
    const weekly = weeklyUtilizationForRoute(route);
    if (weekly === null) return { kind: "meter-missing" };
    return { kind: "usage", used_percent: weekly * 100 };
  }
  const scope = frozen.quota_scope ?? CODEX_GENERIC_QUOTA_SCOPE;
  const inspection = (
    deps.inspectCodex ??
    ((s: CodexQuotaScope) => inspectCodexRouting({ quotaScope: s }))
  )(scope);
  if (inspection.health === "missing") return { kind: "missing" };
  if (inspection.health === "stale" || !inspection.fresh) {
    return { kind: "stale" };
  }
  const candidate = inspection.candidates.find(
    (c) => c.alias === frozen.route && c.quota_scope === scope,
  );
  if (candidate === undefined) return { kind: "removed" };
  return { kind: "usage", used_percent: candidate.worst_used_percent };
}

// ---------------------------------------------------------------------------
// route:current / explicit-route resolution (impure — arm-time freeze)
// ---------------------------------------------------------------------------

export type FreezeRouteResult =
  | { ok: true; frozen: FrozenWeeklyRoute }
  | { ok: false; reason: string };

export interface FreezeRouteDeps {
  now?: () => number;
  /** The arming session's proven harness, or null when no ambient subject. */
  currentHarness?: () => "claude" | "pi" | null;
  inspectClaude?: () => RoutingInspection;
  inspectCodex?: (quotaScope: CodexQuotaScope) => CodexRoutingInspection;
}

function productionCurrentHarness(
  ownSessionId: string | null,
): "claude" | "pi" | null {
  if (ownSessionId === null) return null;
  const observation = readExactRuntimeObservation(
    ownSessionId,
    resolveSessionRuntimeDir(),
  );
  return observation?.subject.harness ?? null;
}

function freezeClaudeCurrent(
  nowMs: number,
  deps: FreezeRouteDeps,
): FreezeRouteResult {
  const inspection = (deps.inspectClaude ?? (() => inspectRouting({})))();
  const chosen = inspection.would_choose;
  if (chosen === null || !inspection.fresh) {
    return {
      ok: false,
      reason: "no fresh current Claude route to freeze",
    };
  }
  return {
    ok: true,
    frozen: {
      provider: "claude",
      route: chosen.id,
      weekly_meter: WEEKLY_METER,
      quota_scope: null,
      resolved_at_ms: nowMs,
    },
  };
}

function freezeCodexCurrent(
  nowMs: number,
  deps: FreezeRouteDeps,
): FreezeRouteResult {
  const scope = CODEX_GENERIC_QUOTA_SCOPE;
  const inspection = (
    deps.inspectCodex ??
    ((s: CodexQuotaScope) => inspectCodexRouting({ quotaScope: s }))
  )(scope);
  if (!inspection.fresh || inspection.verdict.kind !== "pooled") {
    return {
      ok: false,
      reason: "no fresh current Codex route to freeze",
    };
  }
  return {
    ok: true,
    frozen: {
      provider: "codex",
      route: inspection.verdict.alias,
      weekly_meter: WEEKLY_METER,
      quota_scope: scope,
      resolved_at_ms: nowMs,
    },
  };
}

/**
 * Resolve a weekly-quota route token into a frozen route. `route:current`
 * (the default) freezes the arming session's proven provider + route once;
 * absent authoritative current routing refuses. Explicit `route:claude:<id>`
 * and `route:codex:<alias>[:<scope>]` use the same validation and freeze
 * without an ambient subject.
 */
export function resolveWeeklyRoute(
  token: string,
  ownSessionId: string | null,
  deps: FreezeRouteDeps = {},
): FreezeRouteResult {
  const nowMs = Math.floor((deps.now ?? Date.now)());
  if (token === "route:current") {
    const harness = (
      deps.currentHarness ?? (() => productionCurrentHarness(ownSessionId))
    )();
    if (harness === null) {
      return {
        ok: false,
        reason: "no ambient runtime subject to resolve route:current",
      };
    }
    return harness === "pi"
      ? freezeCodexCurrent(nowMs, deps)
      : freezeClaudeCurrent(nowMs, deps);
  }
  if (token.startsWith("route:claude:")) {
    const id = token.slice("route:claude:".length);
    if (id.length === 0) {
      return { ok: false, reason: "route:claude:<id> requires a route id" };
    }
    return {
      ok: true,
      frozen: {
        provider: "claude",
        route: id,
        weekly_meter: WEEKLY_METER,
        quota_scope: null,
        resolved_at_ms: nowMs,
      },
    };
  }
  if (token.startsWith("route:codex:")) {
    const rest = token.slice("route:codex:".length);
    if (rest.length === 0) {
      return {
        ok: false,
        reason: "route:codex:<alias>[:<scope>] requires an alias",
      };
    }
    // The alias is opaque; an optional trailing `:<scope>` selects the quota
    // scope. Split on the LAST colon only when the tail is a known scope so an
    // alias that itself contains a colon is never mis-split.
    let alias = rest;
    let scope: CodexQuotaScope = CODEX_GENERIC_QUOTA_SCOPE;
    const lastColon = rest.lastIndexOf(":");
    if (lastColon > 0) {
      const candidateScope = rest.slice(lastColon + 1);
      if (isCodexQuotaScope(candidateScope)) {
        alias = rest.slice(0, lastColon);
        scope = candidateScope;
      }
    }
    if (alias.length === 0) {
      return {
        ok: false,
        reason: "route:codex:<alias>[:<scope>] requires an alias",
      };
    }
    return {
      ok: true,
      frozen: {
        provider: "codex",
        route: alias,
        weekly_meter: WEEKLY_METER,
        quota_scope: scope,
        resolved_at_ms: nowMs,
      },
    };
  }
  return {
    ok: false,
    reason: `invalid route token '${token}' (expected route:current, route:claude:<id>, or route:codex:<alias>[:<scope>])`,
  };
}

// ---------------------------------------------------------------------------
// Context ambient-runtime adapter (impure — validated leaf read, no writes)
// ---------------------------------------------------------------------------

export interface ContextEvidenceDeps {
  now?: () => number;
  /** Read the ambient session's exact runtime leaf. */
  readExactRuntime?: (sessionId: string) => ExactRuntimeObservation | null;
  maxAgeMs?: number;
}

/**
 * Read the ambient exact-runtime context percentage for `ownSessionId`. A
 * null session id is a proven target-ended (no ambient subject to bind); a
 * fresh leaf whose subject scope is `unavailable` is likewise an ended
 * subject. A stale or absent leaf, or a fresh leaf with no context reading,
 * stays waiting.
 */
export function readContextEvidence(
  ownSessionId: string | null,
  deps: ContextEvidenceDeps = {},
): ContextEvidence {
  if (ownSessionId === null) return { kind: "ended" };
  const nowMs = Math.floor((deps.now ?? Date.now)());
  const observation = (
    deps.readExactRuntime ??
    ((sessionId: string) =>
      readExactRuntimeObservation(sessionId, resolveSessionRuntimeDir()))
  )(ownSessionId);
  if (observation === null) return { kind: "missing" };
  const maxAgeMs = deps.maxAgeMs ?? RUNTIME_CURRENT_MAX_AGE_MS;
  const ageMs = nowMs - observation.observed_at_ms;
  if (!(ageMs >= 0 && ageMs <= maxAgeMs)) return { kind: "stale" };
  if (observation.subject.scope === "unavailable") return { kind: "ended" };
  if (observation.context_used_percentage === null) {
    return { kind: "context-unavailable" };
  }
  return { kind: "usage", used_percent: observation.context_used_percentage };
}

import { createHash } from "node:crypto";
import {
  CODEX_GENERIC_QUOTA_SCOPE,
  CODEX_SPARK_QUOTA_SCOPE,
  type CodexQuotaScope,
  codexQuotaScopeForUsageMeter,
} from "../../../src/codex-quota-scope.ts";

export const USAGE_SCHEMA_VERSION = 2;
export const MAX_USAGE_WINDOWS = 6;
const MAX_RESET_FUTURE_MS = 45 * 24 * 60 * 60 * 1000;
const MAX_WINDOW_SECONDS = 45 * 24 * 60 * 60;
const MAX_METER_LABEL_LENGTH = 64;

export type UsageStatus = "healthy" | "exhausted" | "unavailable";
export type UsageWindowRole = "primary" | "secondary" | "additional";
export type CodexAccountCategory =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "pro-lite"
  | "business"
  | "enterprise"
  | "edu";

export interface SanitizedUsageWindow {
  role: UsageWindowRole;
  quota_scope: CodexQuotaScope;
  /** Stable, PII-free identity used when a provider adds or removes meters. */
  key: string;
  /** Bounded display name from the quota contract, never account metadata. */
  label: string;
  window_seconds: number | null;
  used_percent: number;
  exhausted: boolean;
  reset_at_ms: number | null;
}

export interface SanitizedUsageSnapshot {
  schema_version: 2;
  alias: string;
  status: UsageStatus;
  account_category?: CodexAccountCategory;
  observed_at_ms: number;
  expires_at_ms: number;
  windows: SanitizedUsageWindow[];
  failure_class?: "auth" | "network" | "response" | "schema";
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function percent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 100) return undefined;
  return Math.round(value * 10) / 10;
}

function accountCategory(value: unknown): CodexAccountCategory | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  switch (normalized) {
    case "free":
    case "go":
    case "plus":
    case "pro":
      return normalized;
    case "prolite":
      return "pro-lite";
    case "team":
    case "self_serve_business_usage_based":
      return "business";
    case "business":
    case "enterprise_cbp_usage_based":
    case "enterprise":
    case "hc":
      return "enterprise";
    case "education":
    case "edu":
      return "edu";
    default:
      return undefined;
  }
}

function resetAtMs(value: unknown, nowMs: number): number | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const millis = value < 10_000_000_000 ? value * 1000 : value;
  if (millis < nowMs - 60_000 || millis > nowMs + MAX_RESET_FUTURE_MS) {
    return undefined;
  }
  return Math.floor(millis);
}

function windowSeconds(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_WINDOW_SECONDS
  ) {
    return undefined;
  }
  return value;
}

function meterLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  if (
    label.length < 1 ||
    label.length > MAX_METER_LABEL_LENGTH ||
    !/^(?:GPT|Codex|OpenAI)(?:[- ._/][A-Za-z0-9][A-Za-z0-9 ._+:/()-]*)?$/iu.test(
      label,
    ) ||
    /\b(?:account|email|key|owner|plan|secret|token)\b/iu.test(label) ||
    /\d{6,}/u.test(label)
  ) {
    return null;
  }
  return label;
}

function meterKey(label: string, nativeRole: string): string {
  const digest = createHash("sha256").update(label).digest("hex").slice(0, 24);
  return `meter:${digest}:${nativeRole}`;
}

function durationIdentity(
  seconds: number | null,
  nativeRole: "primary" | "secondary",
): { key: string; label: string } {
  if (seconds === 5 * 60 * 60) return { key: "session", label: "session" };
  if (seconds === 7 * 24 * 60 * 60) return { key: "week", label: "weekly" };
  if (seconds === null) {
    return { key: `window:${nativeRole}`, label: nativeRole };
  }
  const label =
    seconds % (24 * 60 * 60) === 0
      ? `${seconds / (24 * 60 * 60)}-day`
      : seconds % (60 * 60) === 0
        ? `${seconds / (60 * 60)}h`
        : `${seconds}s`;
  return { key: `window:${seconds}`, label };
}

function parseWindow(
  raw: unknown,
  role: UsageWindowRole,
  nativeRole: "primary" | "secondary",
  quotaScope: CodexQuotaScope,
  nowMs: number,
  name: string | null,
  additionalOrdinal: number,
  explicitlyLimited: boolean,
): SanitizedUsageWindow | undefined {
  const record = object(raw);
  if (!record) return undefined;
  const used = percent(record.used_percent);
  const reset = resetAtMs(record.reset_at, nowMs);
  const seconds = windowSeconds(record.limit_window_seconds);
  if (used === undefined || reset === undefined || seconds === undefined) {
    return undefined;
  }
  const identity =
    name === null
      ? role === "additional"
        ? {
            key: `additional:${additionalOrdinal}:${nativeRole}`,
            label: `additional ${additionalOrdinal}`,
          }
        : durationIdentity(seconds, nativeRole)
      : {
          key: meterKey(name, nativeRole),
          label: name,
        };
  return {
    role,
    quota_scope: quotaScope,
    ...identity,
    window_seconds: seconds,
    used_percent: used,
    exhausted: explicitlyLimited || used >= 100,
    reset_at_ms: reset,
  };
}

function appendRateLimitWindows(
  target: SanitizedUsageWindow[],
  raw: unknown,
  nowMs: number,
  additional: boolean,
  quotaScope: CodexQuotaScope,
  name: string | null,
  additionalOrdinal: number,
): void {
  const rateLimit = object(raw);
  if (!rateLimit) return;
  const explicitlyLimited =
    rateLimit.allowed === false || rateLimit.limit_reached === true;
  const primary = parseWindow(
    rateLimit.primary_window,
    additional ? "additional" : "primary",
    "primary",
    quotaScope,
    nowMs,
    name,
    additionalOrdinal,
    explicitlyLimited,
  );
  const secondary = parseWindow(
    rateLimit.secondary_window,
    additional ? "additional" : "secondary",
    "secondary",
    quotaScope,
    nowMs,
    name,
    additionalOrdinal,
    explicitlyLimited,
  );
  if (primary && target.length < MAX_USAGE_WINDOWS) target.push(primary);
  if (secondary && target.length < MAX_USAGE_WINDOWS) target.push(secondary);
}

export function parseUsageResponse(
  alias: string,
  raw: unknown,
  nowMs: number,
  ttlMs = 60_000,
): SanitizedUsageSnapshot {
  const record = object(raw);
  if (!record || !Number.isFinite(nowMs) || ttlMs < 1 || ttlMs > 300_000) {
    throw new Error("usage-schema-invalid");
  }
  const windows: SanitizedUsageWindow[] = [];
  const topRateLimit = object(record.rate_limit);
  appendRateLimitWindows(
    windows,
    topRateLimit,
    nowMs,
    false,
    CODEX_GENERIC_QUOTA_SCOPE,
    meterLabel(topRateLimit?.limit_name),
    0,
  );
  const additional = record.additional_rate_limits;
  if (Array.isArray(additional)) {
    for (const [index, item] of additional
      .slice(0, MAX_USAGE_WINDOWS)
      .entries()) {
      const entry = object(item);
      appendRateLimitWindows(
        windows,
        entry?.rate_limit,
        nowMs,
        true,
        codexQuotaScopeForUsageMeter(entry?.limit_name),
        meterLabel(entry?.limit_name),
        index + 1,
      );
      if (windows.length >= MAX_USAGE_WINDOWS) break;
    }
  }
  if (windows.length === 0) throw new Error("usage-schema-invalid");
  const roleRank: Record<UsageWindowRole, number> = {
    primary: 0,
    secondary: 1,
    additional: 2,
  };
  windows.sort(
    (a, b) =>
      roleRank[a.role] - roleRank[b.role] ||
      a.label.localeCompare(b.label) ||
      a.key.localeCompare(b.key),
  );
  const keyCounts = new Map<string, number>();
  for (const window of windows) {
    const count = keyCounts.get(window.key) ?? 0;
    keyCounts.set(window.key, count + 1);
    if (count > 0) window.key = `${window.key}:${count + 1}`;
  }
  const genericWindows = windows.filter(
    (window) => window.quota_scope === CODEX_GENERIC_QUOTA_SCOPE,
  );
  const exhausted = genericWindows.some((window) => window.exhausted);
  const category = accountCategory(record.plan_type);
  return {
    schema_version: USAGE_SCHEMA_VERSION,
    alias,
    status: exhausted ? "exhausted" : "healthy",
    ...(category === undefined ? {} : { account_category: category }),
    observed_at_ms: Math.floor(nowMs),
    expires_at_ms: Math.floor(nowMs + ttlMs),
    windows,
  };
}

export function unavailableUsage(
  alias: string,
  nowMs: number,
  failureClass: NonNullable<SanitizedUsageSnapshot["failure_class"]>,
): SanitizedUsageSnapshot {
  return {
    schema_version: USAGE_SCHEMA_VERSION,
    alias,
    status: "unavailable",
    observed_at_ms: Math.floor(nowMs),
    expires_at_ms: Math.floor(nowMs),
    windows: [],
    failure_class: failureClass,
  };
}

export interface UsageScopeView {
  quota_scope: CodexQuotaScope;
  status: UsageStatus;
  observed_at_ms: number;
  expires_at_ms: number;
  windows: SanitizedUsageWindow[];
  used_percent: number;
  cooldown_until_ms: number;
}

function cooldownUntil(
  windows: readonly SanitizedUsageWindow[],
  fallbackMs: number,
): number {
  return Math.max(
    fallbackMs,
    ...windows.map((window) => window.reset_at_ms ?? 0),
  );
}

export function usageScopeView(
  snapshot: SanitizedUsageSnapshot,
  quotaScope: CodexQuotaScope,
  nowMs?: number,
): UsageScopeView {
  const windows = snapshot.windows.filter(
    (window) => window.quota_scope === quotaScope,
  );
  const stale =
    nowMs !== undefined &&
    Number.isFinite(nowMs) &&
    Math.floor(nowMs) > snapshot.expires_at_ms;
  if (
    snapshot.status === "unavailable" ||
    stale ||
    (quotaScope === CODEX_SPARK_QUOTA_SCOPE && windows.length === 0)
  ) {
    return {
      quota_scope: quotaScope,
      status: "unavailable",
      observed_at_ms: snapshot.observed_at_ms,
      expires_at_ms: snapshot.expires_at_ms,
      windows,
      used_percent: quotaScope === CODEX_GENERIC_QUOTA_SCOPE ? 50 : 100,
      cooldown_until_ms: 0,
    };
  }
  const windowExhausted = windows.some((window) => window.exhausted);
  const status =
    windowExhausted ||
    (quotaScope === CODEX_GENERIC_QUOTA_SCOPE &&
      snapshot.status === "exhausted")
      ? "exhausted"
      : "healthy";
  const usedPercent =
    windows.length === 0
      ? 50
      : Math.max(...windows.map((window) => window.used_percent));
  return {
    quota_scope: quotaScope,
    status,
    observed_at_ms: snapshot.observed_at_ms,
    expires_at_ms: snapshot.expires_at_ms,
    windows,
    used_percent: usedPercent,
    cooldown_until_ms:
      status === "exhausted"
        ? cooldownUntil(windows, snapshot.expires_at_ms)
        : 0,
  };
}

export function worstUsedPercent(
  snapshot: SanitizedUsageSnapshot,
  quotaScope: CodexQuotaScope = CODEX_GENERIC_QUOTA_SCOPE,
): number {
  return usageScopeView(snapshot, quotaScope).used_percent;
}

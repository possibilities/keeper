export const USAGE_SCHEMA_VERSION = 1;
export const MAX_USAGE_WINDOWS = 6;
const MAX_RESET_FUTURE_MS = 45 * 24 * 60 * 60 * 1000;

export type UsageStatus = "healthy" | "exhausted" | "unavailable";
export type UsageWindowRole = "primary" | "secondary" | "additional";

export interface SanitizedUsageWindow {
  role: UsageWindowRole;
  used_percent: number;
  reset_at_ms: number | null;
}

export interface SanitizedUsageSnapshot {
  schema_version: 1;
  alias: string;
  status: UsageStatus;
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

function resetAtMs(value: unknown, nowMs: number): number | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const millis = value < 10_000_000_000 ? value * 1000 : value;
  if (millis < nowMs - 60_000 || millis > nowMs + MAX_RESET_FUTURE_MS) {
    return undefined;
  }
  return Math.floor(millis);
}

function parseWindow(
  raw: unknown,
  role: UsageWindowRole,
  nowMs: number,
): SanitizedUsageWindow | undefined {
  const record = object(raw);
  if (!record) return undefined;
  const used = percent(record.used_percent);
  const reset = resetAtMs(record.reset_at, nowMs);
  if (used === undefined || reset === undefined) return undefined;
  return { role, used_percent: used, reset_at_ms: reset };
}

function appendRateLimitWindows(
  target: SanitizedUsageWindow[],
  raw: unknown,
  nowMs: number,
  additional: boolean,
): void {
  const rateLimit = object(raw);
  if (!rateLimit) return;
  const primary = parseWindow(
    rateLimit.primary_window,
    additional ? "additional" : "primary",
    nowMs,
  );
  const secondary = parseWindow(
    rateLimit.secondary_window,
    additional ? "additional" : "secondary",
    nowMs,
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
  appendRateLimitWindows(windows, record.rate_limit, nowMs, false);
  const additional = record.additional_rate_limits;
  if (Array.isArray(additional)) {
    for (const item of additional.slice(0, MAX_USAGE_WINDOWS)) {
      appendRateLimitWindows(windows, object(item)?.rate_limit, nowMs, true);
      if (windows.length >= MAX_USAGE_WINDOWS) break;
    }
  }
  if (windows.length === 0) throw new Error("usage-schema-invalid");
  const topRateLimit = object(record.rate_limit);
  const explicitlyLimited =
    topRateLimit?.allowed === false || topRateLimit?.limit_reached === true;
  const exhausted =
    explicitlyLimited || windows.some((window) => window.used_percent >= 100);
  return {
    schema_version: USAGE_SCHEMA_VERSION,
    alias,
    status: exhausted ? "exhausted" : "healthy",
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

export function worstUsedPercent(snapshot: SanitizedUsageSnapshot): number {
  if (snapshot.status === "exhausted") return 100;
  if (snapshot.windows.length === 0) return 50;
  return Math.max(...snapshot.windows.map((window) => window.used_percent));
}

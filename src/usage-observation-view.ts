import { existsSync } from "node:fs";
import {
  type CapacityMultiplier,
  type ClaudeSubscriptionType,
  isObservationFresh,
  type Observation,
  readObservationSidecar,
} from "./account-observation";
import {
  CODEX_OBSERVATION_FRESHNESS_CEILING_MS,
  codexObservationSidecarPath,
  OBSERVATION_FRESHNESS_CEILING_MS,
  observationSidecarPath,
  resolveAccountRoutingRoot,
  resolveCodexAccountRoutingRoot,
} from "./account-routing-config";
import {
  type CodexAccountCategory,
  type CodexCapacityObservation,
  type CodexCapacityWindow,
  isCodexAliasFresh,
  isCodexObservationFresh,
  readCodexObservationSidecar,
} from "./codex-account-observation";

export type UsageProvider = "claude" | "codex";
export type UsageSourceStatus =
  | "ok"
  | "missing"
  | "invalid"
  | "stale"
  | "unhealthy";
export type UsageAccountStatus =
  | "ok"
  | "stale"
  | "exhausted"
  | "unavailable"
  | "issue";

export interface UsageMeter {
  key: string;
  label: string;
  usedPercent: number;
  resetAtMs: number | null;
}

export type UsageAccountCategory =
  | ClaudeSubscriptionType
  | CodexAccountCategory;

export interface UsageAccount {
  id: string;
  sourceId: string;
  status: UsageAccountStatus;
  detail: string | null;
  accountCategory?: UsageAccountCategory;
  capacityMultiplier?: CapacityMultiplier;
  measuredAtMs: number | null;
  meters: UsageMeter[];
}

export interface UsageSource {
  provider: UsageProvider;
  status: UsageSourceStatus;
  detail: string | null;
  observedAtMs: number | null;
  accounts: UsageAccount[];
}

export interface UsageSnapshot {
  loadedAtMs: number;
  claude: UsageSource;
  codex: UsageSource;
}

export interface UsageSnapshotPaths {
  claude: string;
  codex: string;
}

export function resolveUsageSnapshotPaths(): UsageSnapshotPaths {
  return {
    claude: observationSidecarPath(resolveAccountRoutingRoot()),
    codex: codexObservationSidecarPath(resolveCodexAccountRoutingRoot()),
  };
}

function boundedLabel(value: string, fallback: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal controls is the intent.
  const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/gu;
  const label = value
    .replace(controlCharacters, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (label.length === 0) return fallback;
  return label.length <= 64 ? label : `${label.slice(0, 63)}…`;
}

function claudeMeterLabel(key: string): string {
  if (key === "week") return "weekly";
  if (key.startsWith("model:")) {
    return boundedLabel(key.slice("model:".length), "model");
  }
  return boundedLabel(key, "meter");
}

function resetAtFromIso(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildClaudeSource(
  observation: Observation,
  nowMs: number,
): UsageSource {
  const globallyFresh = isObservationFresh(
    observation,
    nowMs,
    OBSERVATION_FRESHNESS_CEILING_MS,
  );
  const status: UsageSourceStatus =
    observation.health === "stale"
      ? "stale"
      : observation.health !== "ok"
        ? "unhealthy"
        : globallyFresh
          ? "ok"
          : "stale";
  const routes = new Map(observation.routes.map((route) => [route.id, route]));
  const ordered = Object.entries(observation.claude_accounts.ordinals).sort(
    (a, b) => a[1] - b[1],
  );
  const accounts = ordered.map(([routeId, ordinal]): UsageAccount => {
    const issue = observation.account_issues[routeId] ?? null;
    const route = routes.get(routeId);
    const capacity = observation.account_capacity?.[routeId];
    const capacityFields = {
      ...(capacity?.subscriptionType === undefined
        ? {}
        : { accountCategory: capacity.subscriptionType }),
      ...(capacity?.rateLimitMultiplier === undefined
        ? {}
        : { capacityMultiplier: capacity.rateLimitMultiplier }),
    };
    if (issue !== null || route === undefined) {
      return {
        id: `Claude ${ordinal + 1}`,
        sourceId: routeId,
        status: "issue",
        detail: issue ?? "account unavailable",
        ...capacityFields,
        measuredAtMs: null,
        meters: [],
      };
    }
    return {
      id: `Claude ${ordinal + 1}`,
      sourceId: routeId,
      status: status === "stale" ? "stale" : "ok",
      detail: null,
      ...capacityFields,
      measuredAtMs: route.measuredAtMs,
      meters: route.windows.map((window) => ({
        key: window.key,
        label: claudeMeterLabel(window.key),
        usedPercent: window.utilization * 100,
        resetAtMs: resetAtFromIso(window.resetsAt),
      })),
    };
  });
  return {
    provider: "claude",
    status,
    detail: observation.health === "ok" ? null : observation.health,
    observedAtMs: observation.observed_at_ms,
    accounts,
  };
}

function durationLabel(seconds: number | null | undefined): string | null {
  if (seconds === 5 * 60 * 60) return "session";
  if (seconds === 7 * 24 * 60 * 60) return "weekly";
  if (seconds === null || seconds === undefined) return null;
  if (seconds % (24 * 60 * 60) === 0) {
    return `${seconds / (24 * 60 * 60)}-day`;
  }
  if (seconds % (60 * 60) === 0) return `${seconds / (60 * 60)}h`;
  return `${seconds}s`;
}

function codexMeter(
  window: CodexCapacityWindow,
  index: number,
  disambiguate: boolean,
): UsageMeter {
  const duration = durationLabel(window.window_seconds);
  let durationToken = duration;
  if (window.window_seconds === 5 * 60 * 60) durationToken = "5h";
  if (window.window_seconds === 7 * 24 * 60 * 60) durationToken = "7d";
  const fallback =
    duration ??
    (window.role === "additional" ? `additional ${index + 1}` : window.role);
  const baseLabel = window.label ?? fallback;
  const label = disambiguate
    ? `${baseLabel} · ${durationToken ?? window.role}`
    : baseLabel;
  return {
    key: window.key ?? `${window.role}:${index}`,
    label: boundedLabel(label, fallback),
    usedPercent: window.used_percent,
    resetAtMs: window.reset_at_ms,
  };
}

function buildCodexSource(
  observation: CodexCapacityObservation,
  nowMs: number,
): UsageSource {
  const globallyFresh = isCodexObservationFresh(
    observation,
    nowMs,
    CODEX_OBSERVATION_FRESHNESS_CEILING_MS,
  );
  return {
    provider: "codex",
    status: globallyFresh ? "ok" : "stale",
    detail: null,
    observedAtMs: observation.observed_at_ms,
    accounts: observation.aliases.map((alias, index) => {
      const labelCounts = new Map<string, number>();
      for (const window of alias.windows) {
        if (window.label !== undefined) {
          labelCounts.set(
            window.label,
            (labelCounts.get(window.label) ?? 0) + 1,
          );
        }
      }
      let status: UsageAccountStatus;
      let detail: string | null = null;
      if (alias.status === "unavailable") {
        status = "unavailable";
        detail = alias.failure_class ?? "unavailable";
      } else if (alias.status === "exhausted") {
        status = "exhausted";
      } else if (!globallyFresh || !isCodexAliasFresh(alias, nowMs)) {
        status = "stale";
      } else {
        status = "ok";
      }
      return {
        id: `Codex ${index + 1}`,
        sourceId: alias.alias,
        status,
        detail,
        ...(alias.account_category === undefined
          ? {}
          : { accountCategory: alias.account_category }),
        measuredAtMs: null,
        meters: alias.windows.map((window, meterIndex) =>
          codexMeter(
            window,
            meterIndex,
            window.label !== undefined &&
              (labelCounts.get(window.label) ?? 0) > 1,
          ),
        ),
      };
    }),
  };
}

function unavailableSource(
  provider: UsageProvider,
  status: "missing" | "invalid",
): UsageSource {
  return { provider, status, detail: null, observedAtMs: null, accounts: [] };
}

export function loadUsageSnapshot(
  paths: UsageSnapshotPaths = resolveUsageSnapshotPaths(),
  nowMs: number = Date.now(),
): UsageSnapshot {
  const claudeObservation = readObservationSidecar(paths.claude);
  const codexObservation = readCodexObservationSidecar(paths.codex);
  const claude =
    claudeObservation !== null
      ? buildClaudeSource(claudeObservation, nowMs)
      : unavailableSource(
          "claude",
          existsSync(paths.claude) ? "invalid" : "missing",
        );
  const codex =
    codexObservation !== null
      ? buildCodexSource(codexObservation, nowMs)
      : unavailableSource(
          "codex",
          existsSync(paths.codex) ? "invalid" : "missing",
        );
  return { loadedAtMs: nowMs, claude, codex };
}

const BAR_WIDTH = 24;

function bar(usedPercent: number): string {
  const safe = Math.max(0, Math.min(100, usedPercent));
  const filled = Math.round((safe / 100) * BAR_WIDTH);
  return `[${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}]`;
}

function percent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function compactDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes === 0) return "now";
  const days = Math.floor(minutes / 1440);
  if (days > 0) {
    const hours = Math.floor((minutes % 1440) / 60);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    const remainder = minutes % 60;
    return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

function ageText(observedAtMs: number | null, nowMs: number): string {
  if (observedAtMs === null) return "";
  const ageMs = nowMs - observedAtMs;
  if (!Number.isFinite(ageMs) || ageMs < 0) return "clock skew";
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function sourceHeading(source: UsageSource, nowMs: number): string {
  const age = ageText(source.observedAtMs, nowMs);
  if (source.status === "ok") {
    return `[${source.provider}] fresh${age === "" ? "" : ` ${age}`}`;
  }
  const detail = source.detail === null ? "" : ` · ${source.detail}`;
  const ageSuffix = age === "" ? "" : ` · ${age}`;
  return `[${source.provider}] [${source.status}]${detail}${ageSuffix}`;
}

function accountCategoryLabel(category: UsageAccountCategory): string {
  switch (category) {
    case "pro-lite":
      return "Pro Lite";
    case "business":
      return "Business";
    case "enterprise":
      return "Enterprise";
    case "edu":
      return "Edu";
    default:
      return `${category.slice(0, 1).toUpperCase()}${category.slice(1)}`;
  }
}

function accountCapacitySuffix(account: UsageAccount): string {
  const fields: string[] = [];
  if (account.accountCategory !== undefined) {
    fields.push(accountCategoryLabel(account.accountCategory));
  }
  if (account.capacityMultiplier !== undefined) {
    fields.push(`${account.capacityMultiplier}×`);
  }
  return fields.length === 0 ? "" : ` · ${fields.join(" ")}`;
}

function accountSuffix(account: UsageAccount, nowMs: number): string {
  const parts: string[] = [];
  if (account.status !== "ok") {
    parts.push(`[${account.status}]`);
    if (account.detail !== null) parts.push(account.detail);
  }
  const measurementAge = ageText(account.measuredAtMs, nowMs);
  if (measurementAge !== "") parts.push(`measured ${measurementAge}`);
  return parts.length === 0 ? "" : `  ${parts.join(" · ")}`;
}

function renderSource(source: UsageSource, nowMs: number): string[] {
  const lines = [sourceHeading(source, nowMs)];
  if (source.accounts.length === 0) {
    lines.push(`  observation ${source.status}`);
    return lines;
  }
  const labelWidth = Math.min(
    28,
    Math.max(
      7,
      ...source.accounts.flatMap((account) =>
        account.meters.map((meter) => meter.label.length),
      ),
    ),
  );
  for (const [accountIndex, account] of source.accounts.entries()) {
    if (accountIndex > 0) lines.push("");
    lines.push(
      `  ${account.id}${accountCapacitySuffix(account)}${accountSuffix(account, nowMs)}`,
    );
    for (const meter of account.meters) {
      const label = boundedLabel(meter.label, "meter").slice(0, labelWidth);
      const reset =
        meter.resetAtMs === null
          ? ""
          : `  ${compactDuration(meter.resetAtMs - nowMs)}`;
      const used = percent(meter.usedPercent).padStart(6);
      lines.push(
        `    ${label.padEnd(labelWidth)}  ${bar(meter.usedPercent)}  ${used}${reset}`,
      );
    }
  }
  return lines;
}

export function renderUsageLines(snapshot: UsageSnapshot): string[] {
  return [
    ...renderSource(snapshot.claude, snapshot.loadedAtMs),
    "",
    ...renderSource(snapshot.codex, snapshot.loadedAtMs),
  ];
}

/** Fingerprint only provider semantics; age and countdown timestamps repaint locally. */
export function usageSemanticFingerprint(snapshot: UsageSnapshot): string {
  const source = (value: UsageSource) => ({
    provider: value.provider,
    status: value.status,
    detail: value.detail,
    accounts: value.accounts.map((account) => ({
      id: account.id,
      status: account.status,
      detail: account.detail,
      accountCategory: account.accountCategory,
      capacityMultiplier: account.capacityMultiplier,
      meters: account.meters.map((meter) => ({
        label: meter.label,
        usedPercent: meter.usedPercent,
      })),
    })),
  });
  return JSON.stringify({
    claude: source(snapshot.claude),
    codex: source(snapshot.codex),
  });
}

export type UsagePollTimer = ReturnType<typeof setTimeout> | number;

export interface UsagePoller {
  start(): void;
  pollNow(): void;
  dispose(): void;
}

export function createUsagePoller(options: {
  read: () => UsageSnapshot;
  onSemanticChange: (snapshot: UsageSnapshot) => void;
  onLocalRepaint: (snapshot: UsageSnapshot) => void;
  intervalMs?: number;
  setTimeoutFn?: (callback: () => void, ms: number) => UsagePollTimer;
  clearTimeoutFn?: (timer: UsagePollTimer) => void;
}): UsagePoller {
  const intervalMs = Math.max(100, options.intervalMs ?? 1_000);
  const setTimer =
    options.setTimeoutFn ??
    ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimeoutFn ??
    ((timer: UsagePollTimer) =>
      clearTimeout(timer as Parameters<typeof clearTimeout>[0]));
  let disposed = false;
  let started = false;
  let timer: UsagePollTimer | null = null;
  let fingerprint: string | null = null;

  const schedule = (): void => {
    if (disposed) return;
    timer = setTimer(poll, intervalMs);
  };
  const poll = (): void => {
    if (disposed) return;
    timer = null;
    try {
      const snapshot = options.read();
      const next = usageSemanticFingerprint(snapshot);
      if (fingerprint === null || next !== fingerprint) {
        fingerprint = next;
        options.onSemanticChange(snapshot);
      } else {
        options.onLocalRepaint(snapshot);
      }
    } finally {
      schedule();
    }
  };

  return {
    start() {
      if (started || disposed) return;
      started = true;
      poll();
    },
    pollNow() {
      if (disposed) return;
      started = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      poll();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

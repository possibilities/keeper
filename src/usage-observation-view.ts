import { existsSync } from "node:fs";
import { readNonFableFocusLeaf } from "./account-focus";
import {
  type CapacityMultiplier,
  type ClaudeSubscriptionType,
  isObservationFresh,
  type NormalizedWindow,
  type Observation,
  readObservationSidecar,
} from "./account-observation";
import {
  type FableFocusRoutingView,
  inspectAccountFocuses,
  type NonFableFocusRoutingView,
} from "./account-router";
import {
  CODEX_OBSERVATION_FRESHNESS_CEILING_MS,
  codexObservationSidecarPath,
  fableFocusPolicyPath,
  nonFableFocusPolicyPath,
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
import { readFableFocusLeaf } from "./fable-focus";

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

export interface UsageFocusSnapshot {
  fable: FableFocusRoutingView;
  nonFable: NonFableFocusRoutingView;
}

export interface UsageSnapshot {
  loadedAtMs: number;
  claude: UsageSource;
  codex: UsageSource;
  /** Human-view focus detail; intentionally omitted from `keeper usage --json`. */
  focus: UsageFocusSnapshot | null;
}

export interface UsageSnapshotPaths {
  claude: string;
  codex: string;
  /** Present on the production path; omission keeps custom snapshot readers isolated. */
  accountRoutingRoot?: string;
}

export function resolveUsageSnapshotPaths(): UsageSnapshotPaths {
  const accountRoutingRoot = resolveAccountRoutingRoot();
  return {
    claude: observationSidecarPath(accountRoutingRoot),
    codex: codexObservationSidecarPath(resolveCodexAccountRoutingRoot()),
    accountRoutingRoot,
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

function claudeMeters(windows: NormalizedWindow[]): UsageMeter[] {
  return windows.map((window) => ({
    key: window.key,
    label: claudeMeterLabel(window.key),
    usedPercent: window.utilization * 100,
    resetAtMs: resetAtFromIso(window.resetsAt),
  }));
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
    const measurement = observation.account_measurements?.[routeId];
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
      const usageUnavailable = issue === "usage-unavailable";
      return {
        id: `Claude ${ordinal + 1}`,
        sourceId: routeId,
        status: usageUnavailable ? "unavailable" : "issue",
        detail: usageUnavailable ? null : (issue ?? "account unavailable"),
        ...capacityFields,
        measuredAtMs: usageUnavailable
          ? (measurement?.measuredAtMs ?? null)
          : null,
        meters:
          usageUnavailable && measurement !== undefined
            ? claudeMeters(measurement.windows)
            : [],
      };
    }
    return {
      id: `Claude ${ordinal + 1}`,
      sourceId: routeId,
      status: status === "stale" ? "stale" : "ok",
      detail: null,
      ...capacityFields,
      measuredAtMs: route.measuredAtMs,
      meters: claudeMeters(route.windows),
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

// ── schema-v1 JSON serialization (`keeper usage --json`) ────────────────────
//
// The camelCase `UsageSnapshot` above is the internal display/poll view; the
// JSON contract is a separate snake_case projection so a wire-field rename
// never forces a render-path rename and vice versa.

export interface UsageJsonMeter {
  key: string;
  label: string;
  used_percent: number;
  reset_at_ms: number | null;
}

export interface UsageJsonAccount {
  id: string;
  source_id: string;
  status: UsageAccountStatus;
  detail: string | null;
  account_category: UsageAccountCategory | null;
  capacity_multiplier: CapacityMultiplier | null;
  measured_at_ms: number | null;
  meters: UsageJsonMeter[];
}

export interface UsageJsonSource {
  provider: UsageProvider;
  status: UsageSourceStatus;
  detail: string | null;
  observed_at_ms: number | null;
  accounts: UsageJsonAccount[];
}

export interface UsageJsonData {
  generated_at_ms: number;
  sources: {
    claude: UsageJsonSource;
    codex: UsageJsonSource;
  };
}

function toJsonMeter(meter: UsageMeter): UsageJsonMeter {
  return {
    key: meter.key,
    label: meter.label,
    used_percent: meter.usedPercent,
    reset_at_ms: meter.resetAtMs,
  };
}

function toJsonAccount(account: UsageAccount): UsageJsonAccount {
  return {
    id: account.id,
    source_id: account.sourceId,
    status: account.status,
    detail: account.detail,
    account_category: account.accountCategory ?? null,
    capacity_multiplier: account.capacityMultiplier ?? null,
    measured_at_ms: account.measuredAtMs,
    meters: account.meters.map(toJsonMeter),
  };
}

function toJsonSource(source: UsageSource): UsageJsonSource {
  return {
    provider: source.provider,
    status: source.status,
    detail: source.detail,
    observed_at_ms: source.observedAtMs,
    accounts: source.accounts.map(toJsonAccount),
  };
}

/** Project a {@link UsageSnapshot} to the `keeper usage --json` schema-v1
 *  payload — every normalized meter, category/multiplier, source status,
 *  observation time, and the display-only last-good measurement distinction
 *  (an `unavailable` account still carrying `measured_at_ms` + `meters` from
 *  its last successful read) all pass through untouched. */
export function buildUsageJsonData(snapshot: UsageSnapshot): UsageJsonData {
  return {
    generated_at_ms: snapshot.loadedAtMs,
    sources: {
      claude: toJsonSource(snapshot.claude),
      codex: toJsonSource(snapshot.codex),
    },
  };
}

function loadUsageFocus(
  accountRoutingRoot: string,
  observation: Observation | null,
  nowMs: number,
): UsageFocusSnapshot {
  return inspectAccountFocuses({
    observation,
    nowMs,
    fableDelivery: readFableFocusLeaf(fableFocusPolicyPath(accountRoutingRoot)),
    nonFableDelivery: readNonFableFocusLeaf(
      nonFableFocusPolicyPath(accountRoutingRoot),
    ),
  });
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
  const focus =
    paths.accountRoutingRoot === undefined
      ? null
      : loadUsageFocus(paths.accountRoutingRoot, claudeObservation, nowMs);
  return { loadedAtMs: nowMs, claude, codex, focus };
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

type UsageFocusRoutingView = FableFocusRoutingView | NonFableFocusRoutingView;

function focusDeadlineDistance(deadlineMs: number, nowMs: number): string {
  const distanceMs = Math.abs(deadlineMs - nowMs);
  if (distanceMs < 60_000) return "less than 1 minute";

  const totalMinutes = Math.max(1, Math.round(distanceMs / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} ${days === 1 ? "day" : "days"}`);
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  if (days === 0 && minutes > 0) {
    parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  }
  return parts.slice(0, 2).join(" ");
}

function focusDeadline(value: string, nowMs: number, timeZone: string): string {
  const deadlineMs = Date.parse(value);
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(nowMs)) return value;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    })
      .formatToParts(deadlineMs)
      .map(({ type, value: part }) => [type, part]),
  );
  const local = `${parts.month} ${parts.day}, ${parts.year} at ${parts.hour}:${parts.minute} ${parts.dayPeriod} ${parts.timeZoneName}`;
  const distance = focusDeadlineDistance(deadlineMs, nowMs);
  const relative =
    deadlineMs > nowMs
      ? `${distance} remaining`
      : deadlineMs < nowMs
        ? `expired ${distance} ago`
        : "expires now";
  return `${local} (${relative})`;
}

function focusLifetime(
  focus: UsageFocusRoutingView,
  nowMs: number,
  timeZone: string,
): string {
  const lifetime = focus.lifetime;
  if (lifetime === null) return "unavailable";
  if (lifetime.kind === "permanent") return "permanent";
  return lifetime.kind === "absolute"
    ? `until ${focusDeadline(lifetime.deadline_at, nowMs, timeZone)}`
    : `until the Fable cycle ending ${focusDeadline(lifetime.reset_at, nowMs, timeZone)}`;
}

function focusEligibility(focus: UsageFocusRoutingView): string {
  return focus.target_eligible === null
    ? "unknown"
    : focus.target_eligible
      ? "yes"
      : "no";
}

function focusState(focus: UsageFocusRoutingView, nowMs: number): string {
  if (focus.state === "unavailable" || focus.state === "invalid") {
    return "unavailable; using normal account balancing";
  }
  if (focus.state === "off") return "off";
  const lifetime = focus.lifetime;
  if (
    focus.state === "active" &&
    lifetime !== null &&
    lifetime.kind !== "permanent" &&
    Number.isFinite(nowMs) &&
    Date.parse(
      lifetime.kind === "absolute" ? lifetime.deadline_at : lifetime.reset_at,
    ) <= nowMs
  ) {
    return "fallback to normal account balancing";
  }
  return focus.state === "active" && focus.outcome === "focused"
    ? "focused"
    : "fallback to normal account balancing";
}

function fableFocusLines(
  focus: FableFocusRoutingView,
  nowMs: number,
  timeZone: string,
): string[] {
  if (!focus.configured && focus.state === "off") {
    return ["Fable focus: off"];
  }
  const lines = ["Fable focus"];
  if (focus.configured) {
    lines.push(
      `  target account route: ${focus.target_route ?? "unavailable"}`,
      `  lifetime: ${focusLifetime(focus, nowMs, timeZone)}`,
      `  target currently eligible: ${focusEligibility(focus)}`,
    );
  } else {
    lines.push("  configured: no");
  }
  lines.push(`  effective routing state: ${focusState(focus, nowMs)}`);
  if (focus.diagnostic !== "none") {
    lines.push(`  diagnostic: ${focus.diagnostic}`);
  }
  return lines;
}

function nonFableFocusLines(
  focus: NonFableFocusRoutingView,
  nowMs: number,
  timeZone: string,
): string[] {
  if (
    !focus.configured &&
    focus.state === "off" &&
    focus.diagnostic === "none"
  ) {
    return ["Non-Fable focus: off"];
  }
  return [
    "Non-Fable focus",
    `  target account route: ${focus.target_route ?? "unavailable"}`,
    `  lifetime: ${focusLifetime(focus, nowMs, timeZone)}`,
    `  target currently eligible: ${focusEligibility(focus)}`,
    `  effective routing state: ${focusState(focus, nowMs)}`,
    `  diagnostic: ${focus.diagnostic}`,
  ];
}

export function renderUsageFocusLines(
  focus: UsageFocusSnapshot,
  nowMs: number,
  timeZone: string,
): string[] {
  return [
    ...fableFocusLines(focus.fable, nowMs, timeZone),
    ...nonFableFocusLines(focus.nonFable, nowMs, timeZone),
  ];
}

export function renderUsageLines(
  snapshot: UsageSnapshot,
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
): string[] {
  return [
    ...renderSource(snapshot.claude, snapshot.loadedAtMs),
    "",
    ...renderSource(snapshot.codex, snapshot.loadedAtMs),
    ...(snapshot.focus === null
      ? []
      : [
          "",
          ...renderUsageFocusLines(
            snapshot.focus,
            snapshot.loadedAtMs,
            timeZone,
          ),
        ]),
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
    focus: snapshot.focus,
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

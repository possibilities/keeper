/**
 * Strict normalization for the public `cswap list --json` contract and the
 * atomic, PII-free Capacity observation sidecar. Unknown, stale, malformed, or
 * unrouteable accounts are excluded rather than treated as spare capacity.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import {
  CSWAP_SUPPORTED_SCHEMA_MAJOR,
  MAX_CSWAP_ACCOUNTS,
  MAX_JSON_DEPTH,
  MAX_NOTE_LENGTH,
  MAX_OBSERVATION_NOTES,
  MAX_OUTPUT_BYTES,
  managedRouteId,
  OBSERVATION_FRESHNESS_CEILING_MS,
  OBSERVATION_SCHEMA_VERSION,
  ROUTE_MEASUREMENT_FRESHNESS_CEILING_MS,
} from "./account-routing-config";

export interface NormalizedWindow {
  key: string;
  utilization: number;
  resetsAt: string | null;
}

export type ClaudeSubscriptionType = "pro" | "max";
export type CapacityMultiplier = 1 | 5 | 20;

export interface AccountCapacityMetadata {
  subscriptionType?: ClaudeSubscriptionType;
  rateLimitMultiplier?: CapacityMultiplier;
}

export interface AccountUsageMeasurement {
  windows: NormalizedWindow[];
  measuredAtMs: number;
}

/** Every current Claude route is a claude-swap managed slot. */
export type RouteKind = "managed";

export interface Route {
  id: string;
  kind: RouteKind;
  slot: number;
  windows: NormalizedWindow[];
  measuredAtMs: number;
}

export type ObservationHealth =
  | "ok"
  | "absent"
  | "stale"
  | "malformed"
  | "unsupported"
  | "error";

export type AccountObservationIssue =
  | "relogin-required"
  | "token-expired"
  | "keychain-unavailable"
  | "no-credentials"
  | "api-key"
  | "usage-unavailable"
  | "account-unavailable"
  | "missing-freshness"
  | "missing-windows"
  | "malformed-scoped-windows";

export interface ClaudeAccountDisplay {
  count: number;
  /** Managed route id → zero-based position in cswap inventory order. */
  ordinals: Record<string, number>;
}

export interface Observation {
  schema_version: number;
  observed_at_ms: number;
  health: ObservationHealth;
  routes: Route[];
  claude_accounts: ClaudeAccountDisplay;
  /** Optional managed route id → bounded account-category/capacity metadata. */
  account_capacity?: Record<string, AccountCapacityMetadata>;
  /** Display-grade last-good usage for unavailable, unrouteable accounts. */
  account_measurements?: Record<string, AccountUsageMeasurement>;
  /** Managed route id → bounded PII-free reason the account was excluded. */
  account_issues: Record<string, AccountObservationIssue>;
  notes: string[];
}

export type ProviderRunFailure = "timeout" | "spawn";

export interface ProviderRunOutcome {
  code: number | null;
  stdout: string;
  failure?: ProviderRunFailure;
}

export interface CswapInventory {
  health: ObservationHealth;
  routes: Route[];
  accountOrdinals: Record<string, number>;
  accountCapacity: Record<string, AccountCapacityMetadata>;
  accountMeasurements: Record<string, AccountUsageMeasurement>;
  accountIssues: Record<string, AccountObservationIssue>;
  notes: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function utilizationFromPercent(raw: unknown): number | null {
  if (
    typeof raw !== "number" ||
    !Number.isFinite(raw) ||
    raw < 0 ||
    raw > 100
  ) {
    return null;
  }
  return raw / 100;
}

function hasTimezone(stamp: string): boolean {
  if (/[zZ]$/u.test(stamp)) return true;
  const t = stamp.indexOf("T");
  const timePart = t >= 0 ? stamp.slice(t + 1) : stamp;
  return /[+-]\d{2}:?\d{2}$/u.test(timePart);
}

function trustworthyResetsAt(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || !hasTimezone(raw)) {
    return null;
  }
  const parsed = new Date(raw).getTime();
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function tzAwareEpochMs(raw: unknown): number | null {
  if (typeof raw !== "string" || !hasTimezone(raw)) return null;
  const parsed = new Date(raw).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function exceedsDepth(value: unknown, max: number): boolean {
  const walk = (v: unknown, depth: number): boolean => {
    if (depth > max) return true;
    if (Array.isArray(v)) return v.some((e) => walk(e, depth + 1));
    if (isRecord(v)) {
      return Object.values(v).some((e) => walk(e, depth + 1));
    }
    return false;
  };
  return walk(value, 0);
}

function parseBoundedJson(stdout: string): unknown | null {
  if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(stdout);
    return exceedsDepth(parsed, MAX_JSON_DEPTH) ? null : parsed;
  } catch {
    return null;
  }
}

const CSWAP_ROUTEABLE_STATUS = "ok";

function statusIssue(status: unknown): AccountObservationIssue {
  switch (status) {
    case "relogin_required":
      return "relogin-required";
    case "token_expired":
      return "token-expired";
    case "keychain_unavailable":
      return "keychain-unavailable";
    case "no_credentials":
      return "no-credentials";
    case "api_key":
      return "api-key";
    case "unavailable":
      return "usage-unavailable";
    default:
      return "account-unavailable";
  }
}

function statusDiagnostic(status: unknown): string {
  switch (status) {
    case "relogin_required":
    case "token_expired":
    case "keychain_unavailable":
    case "no_credentials":
    case "api_key":
      return status;
    default:
      return "unavailable";
  }
}

function emptyInventory(
  health: ObservationHealth,
  note: string,
): CswapInventory {
  return {
    health,
    routes: [],
    accountOrdinals: {},
    accountCapacity: {},
    accountMeasurements: {},
    accountIssues: {},
    notes: [note],
  };
}

/**
 * Parse the managed inventory. Every valid slot keeps its stable display ordinal,
 * while only `usageStatus:"ok"` rows carrying required quota windows become launch
 * candidates. The active slot is retained as an ordinary managed route: Keeper
 * always launches through `cswap run`, including claude-swap's same-account path.
 */
export function parseCswapList(
  outcome: ProviderRunOutcome,
  nowMs: number,
): CswapInventory {
  if (outcome.code === null) {
    return emptyInventory("absent", "cswap: unavailable");
  }
  const parsed = parseBoundedJson(outcome.stdout);
  if (parsed === null || !isRecord(parsed)) {
    return emptyInventory("malformed", "cswap: malformed json");
  }
  if (isRecord(parsed.error) || outcome.code !== 0) {
    return emptyInventory("error", "cswap: reported error");
  }
  if (parsed.schemaVersion !== CSWAP_SUPPORTED_SCHEMA_MAJOR) {
    return emptyInventory("unsupported", "cswap: unsupported schema");
  }
  if (!Array.isArray(parsed.accounts)) {
    return emptyInventory("unsupported", "cswap: no accounts array");
  }
  if (parsed.accounts.length > MAX_CSWAP_ACCOUNTS) {
    return emptyInventory(
      "unsupported",
      `cswap: account count exceeds ${MAX_CSWAP_ACCOUNTS}`,
    );
  }

  const routes: Route[] = [];
  const notes: string[] = [];
  const accountOrdinals: Record<string, number> = {};
  const accountCapacity: Record<string, AccountCapacityMetadata> = {};
  const accountMeasurements: Record<string, AccountUsageMeasurement> = {};
  const accountIssues: Record<string, AccountObservationIssue> = {};
  const seenAccounts = new Set<number>();
  const seenRoutes = new Set<number>();

  for (const row of parsed.accounts) {
    if (isRecord(row)) {
      const slot = row.number;
      if (
        typeof slot === "number" &&
        Number.isInteger(slot) &&
        slot > 0 &&
        !seenAccounts.has(slot)
      ) {
        seenAccounts.add(slot);
        const routeId = managedRouteId(slot);
        accountOrdinals[routeId] = seenAccounts.size - 1;
        const capacity = parseAccountCapacity(row);
        if (capacity !== null) accountCapacity[routeId] = capacity;
        const measurement = parseLastGoodMeasurement(row, nowMs);
        if (measurement !== null) accountMeasurements[routeId] = measurement;
      }
    }

    const parsedRow = parseCswapAccount(row, nowMs);
    if (parsedRow.note) notes.push(parsedRow.note);
    const rowSlot = isRecord(row) ? row.number : null;
    const rowRouteId =
      typeof rowSlot === "number" && Number.isInteger(rowSlot) && rowSlot > 0
        ? managedRouteId(rowSlot)
        : null;
    if (
      parsedRow.issue &&
      rowRouteId !== null &&
      accountOrdinals[rowRouteId] !== undefined &&
      accountIssues[rowRouteId] === undefined
    ) {
      accountIssues[rowRouteId] = parsedRow.issue;
    }
    if (parsedRow.route && !seenRoutes.has(parsedRow.route.slot)) {
      seenRoutes.add(parsedRow.route.slot);
      routes.push(parsedRow.route);
      delete accountIssues[parsedRow.route.id];
    }
  }

  return {
    health: "ok",
    routes,
    accountOrdinals,
    accountCapacity,
    accountMeasurements,
    accountIssues,
    notes: boundNotes(notes),
  };
}

function parseAccountCapacity(
  row: Record<string, unknown>,
): AccountCapacityMetadata | null {
  const capacity: AccountCapacityMetadata = {};
  if (row.subscriptionType === "pro" || row.subscriptionType === "max") {
    capacity.subscriptionType = row.subscriptionType;
  }
  if (
    row.rateLimitMultiplier === 1 ||
    row.rateLimitMultiplier === 5 ||
    row.rateLimitMultiplier === 20
  ) {
    capacity.rateLimitMultiplier = row.rateLimitMultiplier;
  }
  return Object.keys(capacity).length === 0 ? null : capacity;
}

function parseLastGoodMeasurement(
  row: Record<string, unknown>,
  nowMs: number,
): AccountUsageMeasurement | null {
  if (row.usageStatus !== "unavailable") return null;
  const measuredAtMs = measuredAtMsFrom(
    row.lastGoodFetchedAt,
    row.lastGoodAgeSeconds,
    nowMs,
  );
  if (measuredAtMs === null) return null;
  const parsed = parseCswapWindows(row.lastGoodUsage);
  if (parsed.scopedMalformed || parsed.windows.length === 0) return null;
  return { windows: parsed.windows, measuredAtMs };
}

function parseCswapAccount(
  row: unknown,
  nowMs: number,
): { route?: Route; note?: string; issue?: AccountObservationIssue } {
  if (!isRecord(row)) return { note: "cswap: non-object row" };
  const slot = row.number;
  if (typeof slot !== "number" || !Number.isInteger(slot) || slot <= 0) {
    return { note: "cswap: invalid slot" };
  }
  if (row.usageStatus !== CSWAP_ROUTEABLE_STATUS) {
    return {
      note: `cswap: slot ${slot} not routeable (${statusDiagnostic(row.usageStatus)})`,
      issue: statusIssue(row.usageStatus),
    };
  }
  const measuredAtMs = measuredAtMsFrom(
    row.usageFetchedAt,
    row.usageAgeSeconds,
    nowMs,
  );
  if (measuredAtMs === null) {
    return {
      note: `cswap: slot ${slot} has no freshness signal`,
      issue: "missing-freshness",
    };
  }
  const parsedWindows = parseCswapWindows(row.usage);
  if (parsedWindows.scopedMalformed) {
    return {
      note: `cswap: slot ${slot} has malformed scoped windows`,
      issue: "malformed-scoped-windows",
    };
  }
  const { windows } = parsedWindows;
  if (
    !windows.some((window) => window.key === "session") ||
    !windows.some((window) => window.key === "week")
  ) {
    return {
      note: `cswap: slot ${slot} has no required windows`,
      issue: "missing-windows",
    };
  }
  return {
    route: {
      id: managedRouteId(slot),
      kind: "managed",
      slot,
      windows,
      measuredAtMs,
    },
  };
}

function measuredAtMsFrom(
  fetchedAt: unknown,
  ageSeconds: unknown,
  nowMs: number,
): number | null {
  const fetched = tzAwareEpochMs(fetchedAt);
  if (fetched !== null) return fetched;
  const age = ageSeconds;
  if (typeof age === "number" && Number.isFinite(age) && age >= 0) {
    const measuredAtMs = nowMs - age * 1000;
    return Number.isFinite(measuredAtMs) ? measuredAtMs : null;
  }
  return null;
}

interface ParsedCswapWindows {
  windows: NormalizedWindow[];
  scopedMalformed: boolean;
}

function parseCswapWindows(usage: unknown): ParsedCswapWindows {
  if (!isRecord(usage)) return { windows: [], scopedMalformed: false };
  const windows: NormalizedWindow[] = [];
  const add = (raw: unknown, key: string): boolean => {
    if (!isRecord(raw)) return false;
    const utilization = utilizationFromPercent(raw.pct);
    if (utilization === null) return false;
    windows.push({
      key,
      utilization,
      resetsAt: trustworthyResetsAt(raw.resetsAt),
    });
    return true;
  };
  add(usage.fiveHour, "session");
  add(usage.sevenDay, "week");
  add(usage.spend, "spend");

  if (!Object.hasOwn(usage, "scoped")) {
    return { windows, scopedMalformed: false };
  }
  if (!Array.isArray(usage.scoped)) {
    return { windows, scopedMalformed: true };
  }
  const seenScopes = new Set<string>();
  for (const entry of usage.scoped) {
    if (!isRecord(entry) || typeof entry.name !== "string") {
      return { windows, scopedMalformed: true };
    }
    const name = entry.name.trim();
    const normalizedName = name.toLowerCase();
    if (
      normalizedName.length === 0 ||
      name.length > 64 ||
      !/^[A-Za-z0-9][A-Za-z0-9 ._+:/()-]*$/u.test(name) ||
      seenScopes.has(normalizedName) ||
      !add(entry, `model:${name}`)
    ) {
      return { windows, scopedMalformed: true };
    }
    seenScopes.add(normalizedName);
  }
  return { windows, scopedMalformed: false };
}

function boundNotes(notes: string[]): string[] {
  return notes
    .slice(0, MAX_OBSERVATION_NOTES)
    .map((note) =>
      note.length > MAX_NOTE_LENGTH ? note.slice(0, MAX_NOTE_LENGTH) : note,
    );
}

export function buildObservation(input: {
  observedAtMs: number;
  cswap: CswapInventory;
}): Observation {
  const { observedAtMs, cswap } = input;
  return {
    schema_version: OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: observedAtMs,
    health: cswap.health,
    routes: cswap.routes,
    claude_accounts: {
      count: Object.keys(cswap.accountOrdinals).length,
      ordinals: { ...cswap.accountOrdinals },
    },
    ...(Object.keys(cswap.accountCapacity).length === 0
      ? {}
      : { account_capacity: { ...cswap.accountCapacity } }),
    ...(Object.keys(cswap.accountMeasurements).length === 0
      ? {}
      : { account_measurements: { ...cswap.accountMeasurements } }),
    account_issues: { ...cswap.accountIssues },
    notes: boundNotes(cswap.notes),
  };
}

export function serializeObservation(obs: Observation): string {
  return `${JSON.stringify(obs, null, 2)}\n`;
}

export function writeObservationSidecar(path: string, obs: Observation): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, serializeObservation(obs));
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

export function readObservationSidecar(path: string): Observation | null {
  if (!existsSync(path)) return null;
  try {
    return validateObservation(parseBoundedJson(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export function validateObservation(data: unknown): Observation | null {
  if (
    !isRecord(data) ||
    data.schema_version !== OBSERVATION_SCHEMA_VERSION ||
    typeof data.observed_at_ms !== "number" ||
    !Number.isFinite(data.observed_at_ms) ||
    !isObservationHealth(data.health) ||
    !Array.isArray(data.routes)
  ) {
    return null;
  }
  const display = validateClaudeAccountDisplay(data.claude_accounts);
  if (display === null) return null;
  const accountCapacity = validateAccountCapacity(
    data.account_capacity,
    display,
  );
  if (accountCapacity === null) return null;
  const accountMeasurements = validateAccountMeasurements(
    data.account_measurements,
    display,
  );
  if (accountMeasurements === null) return null;
  const accountIssues = validateAccountIssues(data.account_issues, display);
  if (accountIssues === null) return null;
  for (const routeId of Object.keys(accountMeasurements)) {
    if (accountIssues[routeId] !== "usage-unavailable") return null;
  }

  const routes: Route[] = [];
  const routeIds = new Set<string>();
  for (const raw of data.routes) {
    const route = validateRoute(raw);
    if (
      route === null ||
      routeIds.has(route.id) ||
      display.ordinals[route.id] === undefined
    ) {
      return null;
    }
    routeIds.add(route.id);
    routes.push(route);
  }
  for (const routeId of Object.keys(display.ordinals)) {
    const hasRoute = routeIds.has(routeId);
    const hasIssue = accountIssues[routeId] !== undefined;
    if (hasRoute === hasIssue) return null;
  }
  const notes = Array.isArray(data.notes)
    ? data.notes.filter((note): note is string => typeof note === "string")
    : [];
  return {
    schema_version: OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: data.observed_at_ms,
    health: data.health,
    routes,
    claude_accounts: display,
    ...(Object.keys(accountCapacity).length === 0
      ? {}
      : { account_capacity: accountCapacity }),
    ...(Object.keys(accountMeasurements).length === 0
      ? {}
      : { account_measurements: accountMeasurements }),
    account_issues: accountIssues,
    notes: boundNotes(notes),
  };
}

function validateAccountMeasurements(
  data: unknown,
  display: ClaudeAccountDisplay,
): Record<string, AccountUsageMeasurement> | null {
  if (data === undefined) return {};
  if (!isRecord(data)) return null;
  const measurements: Record<string, AccountUsageMeasurement> = {};
  for (const [routeId, value] of Object.entries(data)) {
    if (
      display.ordinals[routeId] === undefined ||
      !isRecord(value) ||
      typeof value.measuredAtMs !== "number" ||
      !Number.isFinite(value.measuredAtMs) ||
      !Array.isArray(value.windows) ||
      value.windows.length === 0
    ) {
      return null;
    }
    const windows: NormalizedWindow[] = [];
    const keys = new Set<string>();
    for (const raw of value.windows) {
      const window = validateWindow(raw);
      if (window === null || keys.has(window.key.toLowerCase())) return null;
      keys.add(window.key.toLowerCase());
      windows.push(window);
    }
    measurements[routeId] = {
      measuredAtMs: value.measuredAtMs,
      windows,
    };
  }
  return measurements;
}

function validateAccountCapacity(
  data: unknown,
  display: ClaudeAccountDisplay,
): Record<string, AccountCapacityMetadata> | null {
  if (data === undefined) return {};
  if (!isRecord(data)) return null;
  const capacity: Record<string, AccountCapacityMetadata> = {};
  for (const [routeId, value] of Object.entries(data)) {
    if (display.ordinals[routeId] === undefined || !isRecord(value))
      return null;
    const metadata = parseAccountCapacity(value);
    if (metadata === null) return null;
    capacity[routeId] = metadata;
  }
  return capacity;
}

function validateClaudeAccountDisplay(
  data: unknown,
): ClaudeAccountDisplay | null {
  if (
    !isRecord(data) ||
    typeof data.count !== "number" ||
    !Number.isInteger(data.count) ||
    data.count < 0 ||
    data.count > MAX_CSWAP_ACCOUNTS ||
    !isRecord(data.ordinals)
  ) {
    return null;
  }
  const ordinals: Record<string, number> = {};
  const seen = new Set<number>();
  for (const [routeId, ordinal] of Object.entries(data.ordinals)) {
    if (
      !/^claude-swap:[1-9]\d*$/u.test(routeId) ||
      typeof ordinal !== "number" ||
      !Number.isInteger(ordinal) ||
      ordinal < 0 ||
      ordinal >= data.count ||
      seen.has(ordinal)
    ) {
      return null;
    }
    seen.add(ordinal);
    ordinals[routeId] = ordinal;
  }
  if (seen.size !== data.count) return null;
  for (let ordinal = 0; ordinal < data.count; ordinal += 1) {
    if (!seen.has(ordinal)) return null;
  }
  return { count: data.count, ordinals };
}

function isAccountObservationIssue(
  value: unknown,
): value is AccountObservationIssue {
  return (
    value === "relogin-required" ||
    value === "token-expired" ||
    value === "keychain-unavailable" ||
    value === "no-credentials" ||
    value === "api-key" ||
    value === "usage-unavailable" ||
    value === "account-unavailable" ||
    value === "missing-freshness" ||
    value === "missing-windows" ||
    value === "malformed-scoped-windows"
  );
}

function validateAccountIssues(
  data: unknown,
  display: ClaudeAccountDisplay,
): Record<string, AccountObservationIssue> | null {
  if (!isRecord(data)) return null;
  const issues: Record<string, AccountObservationIssue> = {};
  for (const [routeId, issue] of Object.entries(data)) {
    if (
      display.ordinals[routeId] === undefined ||
      !isAccountObservationIssue(issue)
    ) {
      return null;
    }
    issues[routeId] = issue;
  }
  return issues;
}

function validateRoute(data: unknown): Route | null {
  if (!isRecord(data) || data.kind !== "managed") return null;
  const slot = data.slot;
  if (
    typeof slot !== "number" ||
    !Number.isInteger(slot) ||
    slot <= 0 ||
    data.id !== managedRouteId(slot) ||
    typeof data.measuredAtMs !== "number" ||
    !Number.isFinite(data.measuredAtMs) ||
    !Array.isArray(data.windows) ||
    data.windows.length === 0
  ) {
    return null;
  }
  const windows: NormalizedWindow[] = [];
  const windowKeys = new Set<string>();
  for (const raw of data.windows) {
    const window = validateWindow(raw);
    if (window === null) return null;
    const normalizedKey = window.key.toLowerCase();
    if (windowKeys.has(normalizedKey)) return null;
    windowKeys.add(normalizedKey);
    windows.push(window);
  }
  if (!windowKeys.has("session") || !windowKeys.has("week")) return null;
  return {
    id: data.id,
    kind: "managed",
    slot,
    measuredAtMs: data.measuredAtMs,
    windows,
  };
}

function validateWindow(data: unknown): NormalizedWindow | null {
  if (
    !isRecord(data) ||
    typeof data.key !== "string" ||
    !isValidWindowKey(data.key) ||
    typeof data.utilization !== "number" ||
    !Number.isFinite(data.utilization) ||
    data.utilization < 0 ||
    data.utilization > 1 ||
    (data.resetsAt !== null && typeof data.resetsAt !== "string")
  ) {
    return null;
  }
  const resetsAt =
    data.resetsAt === null ? null : trustworthyResetsAt(data.resetsAt);
  if (data.resetsAt !== null && resetsAt === null) return null;
  return {
    key: data.key,
    utilization: data.utilization,
    resetsAt,
  };
}

function isValidWindowKey(key: string): boolean {
  if (key === "session" || key === "week" || key === "spend") return true;
  if (!key.startsWith("model:")) return false;
  const name = key.slice("model:".length);
  return (
    name === name.trim() &&
    name.length <= 64 &&
    /^[A-Za-z0-9][A-Za-z0-9 ._+:/()-]*$/u.test(name)
  );
}

function isObservationHealth(value: unknown): value is ObservationHealth {
  return (
    value === "ok" ||
    value === "absent" ||
    value === "stale" ||
    value === "malformed" ||
    value === "unsupported" ||
    value === "error"
  );
}

export function isObservationFresh(
  obs: Observation,
  nowMs: number,
  maxAgeMs: number = OBSERVATION_FRESHNESS_CEILING_MS,
): boolean {
  const ageMs = nowMs - obs.observed_at_ms;
  return ageMs >= 0 && maxAgeMs >= 0 && ageMs <= maxAgeMs;
}

/** Classify Measurement age for diagnostics without changing route admission. */
export function isRouteMeasurementFresh(
  route: Route,
  nowMs: number,
  maxAgeMs: number = ROUTE_MEASUREMENT_FRESHNESS_CEILING_MS,
): boolean {
  const ageMs = nowMs - route.measuredAtMs;
  return ageMs >= 0 && maxAgeMs >= 0 && ageMs <= maxAgeMs;
}

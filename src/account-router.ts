/**
 * Per-launch selection over the latest claude-swap Capacity observation and a
 * short-lived, flock-guarded reservation ledger. Every successful answer is a
 * managed slot; missing or uncertain routing evidence fails before Claude starts.
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
import {
  isObservationFresh,
  isRouteMeasurementFresh,
  type NormalizedWindow,
  type Observation,
  type ObservationHealth,
  type Route,
  readObservationSidecar,
} from "./account-observation";
import {
  LEDGER_SCHEMA_VERSION,
  ledgerLockPath,
  ledgerPath,
  MAX_RESERVATIONS_PER_ROUTE,
  managedRouteId,
  observationSidecarPath,
  RESERVATION_TTL_MS,
  RESERVATION_UTILIZATION_STEP,
  resolveAccountRoutingRoot,
} from "./account-routing-config";
import { FileLock } from "./file-lock";

const MAX_LEDGER_ROUTES = 64;
const MODEL_WINDOW_PREFIX = "model:";
const FABLE_MODEL = "fable";
const SESSION_WINDOW = "session";
const WEEK_WINDOW = "week";

export interface RouteSelection {
  id: string;
  kind: "managed";
  slot: number;
  accountOrdinal?: number;
  reason: string;
}

export type RouteResolution =
  | { ok: true; selection: RouteSelection }
  | { ok: false; error: string };

export type RequestedRouteResolution = RouteResolution;

export interface SelectRouteDeps {
  stateDir?: string;
  nowMs?: number;
  /** Effective Claude launch model. Fable has dedicated conservation policy. */
  model?: string | null;
}

function displayOrdinal(
  obs: Observation | null,
  routeId: string,
): number | undefined {
  const display = obs?.claude_accounts;
  if (!display || display.count <= 1) return undefined;
  return display.ordinals[routeId];
}

function selectedRoute(
  route: Route,
  reason: string,
  obs: Observation,
): RouteSelection {
  const accountOrdinal = displayOrdinal(obs, route.id);
  return {
    id: route.id,
    kind: "managed",
    slot: route.slot,
    ...(accountOrdinal === undefined ? {} : { accountOrdinal }),
    reason,
  };
}

/** Choose one managed route or return a PII-free failure. Never throws. */
export function selectRoute(deps: SelectRouteDeps = {}): RouteResolution {
  try {
    return doSelectRoute(deps);
  } catch {
    return { ok: false, error: "account routing failed" };
  }
}

/** Resolve one explicit zero-based inventory position exactly. Never throws. */
export function selectRouteByAccountOrdinal(
  ordinal: number,
  deps: SelectRouteDeps = {},
): RequestedRouteResolution {
  try {
    return doSelectRouteByAccountOrdinal(ordinal, deps);
  } catch {
    return { ok: false, error: `account c${ordinal} could not be resolved` };
  }
}

function readFreshObservation(
  stateDir: string,
  nowMs: number,
): { ok: true; observation: Observation } | { ok: false; error: string } {
  const observation = readObservationSidecar(observationSidecarPath(stateDir));
  if (observation === null) {
    return {
      ok: false,
      error: "no claude-swap account inventory is available",
    };
  }
  if (!isObservationFresh(observation, nowMs)) {
    return { ok: false, error: "claude-swap account inventory is stale" };
  }
  if (observation.health !== "ok") {
    return {
      ok: false,
      error: `claude-swap account inventory is ${observation.health}`,
    };
  }
  return { ok: true, observation };
}

function normalizedModelName(model: string | null | undefined): string | null {
  if (typeof model !== "string") return null;
  const normalized = model.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function isFableRequest(model: string | null | undefined): boolean {
  return normalizedModelName(model) === FABLE_MODEL;
}

function effectiveUtilization(window: NormalizedWindow, nowMs: number): number {
  if (window.resetsAt !== null) {
    const resetMs = new Date(window.resetsAt).getTime();
    if (!Number.isNaN(resetMs) && resetMs <= nowMs) return 0;
  }
  return window.utilization;
}

function worstUtilizationForKey(
  route: Route,
  key: string,
  nowMs: number,
): number | null {
  let found = false;
  let worst = 0;
  for (const window of route.windows) {
    if (window.key !== key) continue;
    found = true;
    worst = Math.max(worst, effectiveUtilization(window, nowMs));
  }
  return found ? worst : null;
}

function fableUtilization(route: Route, nowMs: number): number | null {
  let found = false;
  let worst = 0;
  for (const window of route.windows) {
    if (
      !window.key.startsWith(MODEL_WINDOW_PREFIX) ||
      normalizedModelName(window.key.slice(MODEL_WINDOW_PREFIX.length)) !==
        FABLE_MODEL
    ) {
      continue;
    }
    found = true;
    worst = Math.max(worst, effectiveUtilization(window, nowMs));
  }
  return found ? worst : null;
}

function hasAvailableBaseQuota(route: Route, nowMs: number): boolean {
  const session = worstUtilizationForKey(route, SESSION_WINDOW, nowMs);
  const week = worstUtilizationForKey(route, WEEK_WINDOW, nowMs);
  return session !== null && week !== null && session < 1 && week < 1;
}

function routeIsEligible(
  route: Route,
  model: string | null | undefined,
  nowMs: number,
): boolean {
  if (!hasAvailableBaseQuota(route, nowMs)) return false;
  if (!isFableRequest(model)) return true;
  const fable = fableUtilization(route, nowMs);
  return fable !== null && fable < 1;
}

function reserveSelection(
  stateDir: string,
  nowMs: number,
  observation: Observation,
  route: Route,
  reason: string,
): RouteSelection {
  mkdirSync(stateDir, { recursive: true });
  const lock = FileLock.acquire(ledgerLockPath(stateDir));
  try {
    const ledger = pruneLedger(loadLedger(stateDir), nowMs);
    recordReservation(ledger, route.id, nowMs);
    writeLedger(stateDir, ledger);
  } finally {
    lock.release();
  }
  return selectedRoute(route, reason, observation);
}

function doSelectRouteByAccountOrdinal(
  ordinal: number,
  deps: SelectRouteDeps,
): RequestedRouteResolution {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    return { ok: false, error: "account index must be a non-negative integer" };
  }
  const stateDir = deps.stateDir ?? resolveAccountRoutingRoot();
  const nowMs = deps.nowMs ?? Date.now();
  const fresh = readFreshObservation(stateDir, nowMs);
  if (!fresh.ok) return fresh;
  const observation = fresh.observation;
  const display = observation.claude_accounts;
  if (ordinal >= display.count) {
    const available =
      display.count === 0
        ? "none"
        : display.count === 1
          ? "c0"
          : `c0-c${display.count - 1}`;
    return {
      ok: false,
      error: `account c${ordinal} is out of range (available: ${available})`,
    };
  }
  const routeId = Object.entries(display.ordinals).find(
    ([, index]) => index === ordinal,
  )?.[0];
  const route = observation.routes.find(
    (candidate) =>
      candidate.id === routeId &&
      candidate.slot > 0 &&
      managedRouteId(candidate.slot) === candidate.id &&
      routeIsEligible(candidate, deps.model, nowMs) &&
      isRouteMeasurementFresh(candidate, nowMs),
  );
  if (!route) {
    return {
      ok: false,
      error: `account c${ordinal} is known but is not currently routeable`,
    };
  }
  return {
    ok: true,
    selection: reserveSelection(
      stateDir,
      nowMs,
      observation,
      route,
      "requested-account",
    ),
  };
}

function doSelectRoute(deps: SelectRouteDeps): RouteResolution {
  const stateDir = deps.stateDir ?? resolveAccountRoutingRoot();
  const nowMs = deps.nowMs ?? Date.now();
  const fresh = readFreshObservation(stateDir, nowMs);
  if (!fresh.ok) return fresh;
  const observation = fresh.observation;
  const candidates = observation.routes.filter(
    (route) =>
      routeIsEligible(route, deps.model, nowMs) &&
      isRouteMeasurementFresh(route, nowMs),
  );
  if (candidates.length === 0) {
    return {
      ok: false,
      error: "no fresh routeable claude-swap account is available",
    };
  }

  mkdirSync(stateDir, { recursive: true });
  const lock = FileLock.acquire(ledgerLockPath(stateDir));
  try {
    const ledger = pruneLedger(loadLedger(stateDir), nowMs);
    const chosen = scoreAndPick(candidates, ledger, nowMs, deps.model);
    recordReservation(ledger, chosen.id, nowMs);
    writeLedger(stateDir, ledger);
    return {
      ok: true,
      selection: selectedRoute(
        chosen,
        candidates.length === 1 ? "sole-candidate" : "selected",
        observation,
      ),
    };
  } finally {
    lock.release();
  }
}

export interface RoutingCandidateView {
  id: string;
  kind: "managed";
  slot: number;
  /** Generic session/week/spend pressure, including launch reservations. */
  worst_utilization: number;
  /** Remaining Fable fraction, or null when this account has no Fable quota. */
  fable_remaining: number | null;
}

export interface RoutingInspection {
  /** Normalized model scope used for scoring, or null for generic windows only. */
  model_scope: string | null;
  health: ObservationHealth | "no-observation";
  observed_at_ms: number | null;
  age_ms: number | null;
  fresh: boolean;
  enabled: boolean;
  error: string | null;
  would_choose: RouteSelection | null;
  candidates: RoutingCandidateView[];
}

export function inspectRouting(deps: SelectRouteDeps = {}): RoutingInspection {
  try {
    return doInspectRouting(deps);
  } catch {
    return disabledInspection("no-observation", "account inspection failed", {
      model_scope: normalizedModelName(deps.model),
    });
  }
}

function disabledInspection(
  health: ObservationHealth | "no-observation",
  error: string,
  extras: Partial<
    Pick<
      RoutingInspection,
      "model_scope" | "observed_at_ms" | "age_ms" | "fresh"
    >
  > = {},
): RoutingInspection {
  return {
    model_scope: extras.model_scope ?? null,
    health,
    observed_at_ms: extras.observed_at_ms ?? null,
    age_ms: extras.age_ms ?? null,
    fresh: extras.fresh ?? false,
    enabled: false,
    error,
    would_choose: null,
    candidates: [],
  };
}

function doInspectRouting(deps: SelectRouteDeps): RoutingInspection {
  const stateDir = deps.stateDir ?? resolveAccountRoutingRoot();
  const nowMs = deps.nowMs ?? Date.now();
  const observation = readObservationSidecar(observationSidecarPath(stateDir));
  if (observation === null) {
    return disabledInspection(
      "no-observation",
      "no claude-swap account inventory is available",
      { model_scope: normalizedModelName(deps.model) },
    );
  }
  const ageMs = nowMs - observation.observed_at_ms;
  const fresh = isObservationFresh(observation, nowMs);
  const extras = {
    model_scope: normalizedModelName(deps.model),
    observed_at_ms: observation.observed_at_ms,
    age_ms: ageMs,
    fresh,
  };
  if (!fresh) {
    return disabledInspection(
      observation.health,
      "claude-swap account inventory is stale",
      extras,
    );
  }
  if (observation.health !== "ok") {
    return disabledInspection(
      observation.health,
      `claude-swap account inventory is ${observation.health}`,
      extras,
    );
  }
  const routeable = observation.routes.filter(
    (route) =>
      routeIsEligible(route, deps.model, nowMs) &&
      isRouteMeasurementFresh(route, nowMs),
  );
  if (routeable.length === 0) {
    return disabledInspection(
      observation.health,
      "no fresh routeable claude-swap account is available",
      extras,
    );
  }

  const ledger = pruneLedger(loadLedger(stateDir), nowMs);
  const candidates: RoutingCandidateView[] = routeable.map((route) => {
    const entry = ledger.routes[route.id];
    const pending = entry?.reservations.length ?? 0;
    const fable = fableUtilization(route, nowMs);
    return {
      id: route.id,
      kind: "managed",
      slot: route.slot,
      worst_utilization: genericPressure(route, pending, nowMs),
      fable_remaining:
        fable === null ? null : Number(Math.max(0, 1 - fable).toFixed(6)),
    };
  });
  const chosen = scoreAndPick(routeable, ledger, nowMs, deps.model);
  return {
    model_scope: normalizedModelName(deps.model),
    health: observation.health,
    observed_at_ms: observation.observed_at_ms,
    age_ms: ageMs,
    fresh: true,
    enabled: true,
    error: null,
    would_choose: selectedRoute(
      chosen,
      routeable.length === 1 ? "sole-candidate" : "selected",
      observation,
    ),
    candidates,
  };
}

function genericPressure(route: Route, pending: number, nowMs: number): number {
  let worst = 0;
  for (const window of route.windows) {
    if (window.key.startsWith(MODEL_WINDOW_PREFIX)) continue;
    const utilization = effectiveUtilization(window, nowMs);
    if (utilization > worst) worst = utilization;
  }
  return worst + pending * RESERVATION_UTILIZATION_STEP;
}

interface RouteScore {
  fableTier: number;
  fablePreference: number;
  genericPressure: number;
}

function routeScore(
  route: Route,
  pending: number,
  nowMs: number,
  model: string | null | undefined,
): RouteScore {
  const fable = fableUtilization(route, nowMs);
  const pressure = genericPressure(route, pending, nowMs);
  if (isFableRequest(model)) {
    return {
      fableTier: 0,
      // Raw Fable percentage is authoritative; reservations and generic
      // pressure may break only an equal Fable percentage.
      fablePreference: fable ?? 1,
      genericPressure: pressure,
    };
  }
  return {
    // No Fable entitlement is the strongest conservation signal.
    fableTier: fable === null ? 0 : 1,
    // Among Fable-bearing accounts, consume generic quota where the least
    // Fable capacity remains (greatest utilization).
    fablePreference: fable === null ? 0 : -fable,
    genericPressure: pressure,
  };
}

function compareScores(a: RouteScore, b: RouteScore): number {
  if (a.fableTier !== b.fableTier) return a.fableTier - b.fableTier;
  if (a.fablePreference !== b.fablePreference) {
    return a.fablePreference - b.fablePreference;
  }
  return a.genericPressure - b.genericPressure;
}

function scoreAndPick(
  candidates: Route[],
  ledger: Ledger,
  nowMs: number,
  model: string | null | undefined,
): Route {
  let best: Route | null = null;
  let bestScore: RouteScore | null = null;
  let bestLastSelected = Number.POSITIVE_INFINITY;
  for (const route of candidates) {
    const entry = ledger.routes[route.id];
    const pending = entry?.reservations.length ?? 0;
    const lastSelected = entry?.last_selected_at ?? Number.NEGATIVE_INFINITY;
    const score = routeScore(route, pending, nowMs, model);
    const scoreOrder =
      bestScore === null ? -1 : compareScores(score, bestScore);
    if (
      best === null ||
      scoreOrder < 0 ||
      (scoreOrder === 0 && lastSelected < bestLastSelected) ||
      (scoreOrder === 0 &&
        lastSelected === bestLastSelected &&
        route.id < best.id)
    ) {
      best = route;
      bestScore = score;
      bestLastSelected = lastSelected;
    }
  }
  return best as Route;
}

interface LedgerEntry {
  reservations: number[];
  last_selected_at: number;
}

interface Ledger {
  schema_version: number;
  routes: Record<string, LedgerEntry>;
}

function emptyLedger(): Ledger {
  return { schema_version: LEDGER_SCHEMA_VERSION, routes: {} };
}

function loadLedger(stateDir: string): Ledger {
  const path = ledgerPath(stateDir);
  if (!existsSync(path)) return emptyLedger();
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return emptyLedger();
  }
  if (
    typeof data !== "object" ||
    data === null ||
    (data as { schema_version?: unknown }).schema_version !==
      LEDGER_SCHEMA_VERSION
  ) {
    return emptyLedger();
  }
  const rawRoutes = (data as { routes?: unknown }).routes;
  const routes: Record<string, LedgerEntry> = {};
  if (
    typeof rawRoutes === "object" &&
    rawRoutes !== null &&
    !Array.isArray(rawRoutes)
  ) {
    for (const [id, entry] of Object.entries(
      rawRoutes as Record<string, unknown>,
    )) {
      if (!/^claude-swap:[1-9]\d*$/u.test(id)) continue;
      const parsed = parseEntry(entry);
      if (parsed) routes[id] = parsed;
    }
  }
  return { schema_version: LEDGER_SCHEMA_VERSION, routes };
}

function parseEntry(entry: unknown): LedgerEntry | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return null;
  }
  const candidate = entry as {
    reservations?: unknown;
    last_selected_at?: unknown;
  };
  const reservations = Array.isArray(candidate.reservations)
    ? candidate.reservations.filter(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value),
      )
    : [];
  const last =
    typeof candidate.last_selected_at === "number" &&
    Number.isFinite(candidate.last_selected_at)
      ? candidate.last_selected_at
      : Number.NEGATIVE_INFINITY;
  return { reservations, last_selected_at: last };
}

function pruneLedger(ledger: Ledger, nowMs: number): Ledger {
  const cutoff = nowMs - RESERVATION_TTL_MS;
  const routes: Record<string, LedgerEntry> = {};
  for (const [id, entry] of Object.entries(ledger.routes)) {
    routes[id] = {
      reservations: entry.reservations
        .filter((timestamp) => timestamp > cutoff)
        .slice(-MAX_RESERVATIONS_PER_ROUTE),
      last_selected_at: entry.last_selected_at,
    };
  }
  const ids = Object.keys(routes);
  if (ids.length > MAX_LEDGER_ROUTES) {
    const evict = ids
      .sort((a, b) => routes[a].last_selected_at - routes[b].last_selected_at)
      .slice(0, ids.length - MAX_LEDGER_ROUTES);
    for (const id of evict) delete routes[id];
  }
  return { schema_version: LEDGER_SCHEMA_VERSION, routes };
}

function recordReservation(ledger: Ledger, id: string, nowMs: number): void {
  const entry = ledger.routes[id] ?? {
    reservations: [],
    last_selected_at: Number.NEGATIVE_INFINITY,
  };
  entry.reservations = [...entry.reservations, nowMs].slice(
    -MAX_RESERVATIONS_PER_ROUTE,
  );
  entry.last_selected_at = nowMs;
  ledger.routes[id] = entry;
}

function writeLedger(stateDir: string, ledger: Ledger): void {
  const path = ledgerPath(stateDir);
  const serializable = {
    schema_version: ledger.schema_version,
    routes: Object.fromEntries(
      Object.entries(ledger.routes).map(([id, entry]) => [
        id,
        {
          reservations: entry.reservations,
          last_selected_at: Number.isFinite(entry.last_selected_at)
            ? entry.last_selected_at
            : null,
        },
      ]),
    ),
  };
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(serializable, null, 2)}\n`);
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

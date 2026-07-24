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
  effectiveNonFableFocus,
  type NonFableFocusDelivery,
  readNonFableFocusLeaf,
} from "./account-focus";
import {
  type AccountObservationIssue,
  isObservationFresh,
  type NormalizedWindow,
  type Observation,
  type ObservationHealth,
  type Route,
  readObservationSidecar,
} from "./account-observation";
import type { RefreshResult } from "./account-observation-refresh";
import {
  fableFocusPolicyPath,
  LEDGER_SCHEMA_VERSION,
  ledgerLockPath,
  ledgerPath,
  MAX_RESERVATIONS_PER_ROUTE,
  managedRouteId,
  nonFableFocusPolicyPath,
  OBSERVATION_FRESHNESS_CEILING_MS,
  observationSidecarPath,
  RESERVATION_TTL_MS,
  RESERVATION_UTILIZATION_STEP,
  resolveAccountRoutingRoot,
} from "./account-routing-config";
import {
  buildCurrentResetFableFocus,
  effectiveFableFocus,
  type FableFocusDelivery,
  normalizeManagedRouteId,
  readFableFocusLeaf,
} from "./fable-focus";
import { FileLock } from "./file-lock";
import type {
  AccountFocusEffectiveState,
  AccountFocusLifetime,
  FableFocusEffectiveState,
  FableFocusInput,
  FableFocusPolicy,
  ManagedAccountRouteId,
  NonFableFocusPolicy,
} from "./types";

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

/**
 * A bounded on-demand refresh attempt, resolved to how it should shape a launch
 * decision. `refreshed` means a fresh, healthy observation is now published;
 * the other arms each carry a PII-free detail the refusal names so the next
 * stale incident is diagnosable without archaeology.
 */
export type OnDemandRefreshOutcome =
  | { kind: "refreshed" }
  | { kind: "still-stale" }
  | { kind: "pacing-declined"; detail: string }
  | { kind: "provider-failed"; detail: string };

/** Provider-safe on-demand refresh seam; the launcher wires the real path. */
export type OnDemandRefresh = (input: {
  stateDir: string;
  nowMs: number;
}) => Promise<OnDemandRefreshOutcome>;

export interface SelectRouteDeps {
  stateDir?: string;
  nowMs?: number;
  /** Effective Claude launch model. Fable has dedicated conservation policy. */
  model?: string | null;
  /** Process-lineage routing purpose, independent from Launch attribution. */
  fableIntent?: boolean | null;
  /** Injectable Fable-focus delivery; the launcher reads its owner-only leaf by default. */
  focusDelivery?: FableFocusDelivery;
  /** Independently injectable Non-Fable-focus delivery. */
  nonFableFocusDelivery?: NonFableFocusDelivery;
  /**
   * When set, a launch that finds a stale snapshot runs one bounded on-demand
   * refresh through this seam before refusing. Absent (the pure selectors),
   * staleness refuses immediately as before.
   */
  refreshObservation?: OnDemandRefresh;
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
    return {
      ok: false,
      error:
        "Claude cannot start because account routing failed unexpectedly; run `keeper agent accounts check --json`",
    };
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
    return {
      ok: false,
      error:
        `requested account c${ordinal} could not be resolved; ` +
        "run `keeper agent accounts check --json`",
    };
  }
}

/**
 * Automatic selection that, on a stale snapshot, runs one bounded on-demand
 * refresh through `deps.refreshObservation` before refusing. A happy (fresh)
 * path never invokes the refresh; a still-stale, pacing-declined, or failed
 * refresh yields a typed refusal that names the cause and the manual fallback.
 */
export async function selectRouteWithRefresh(
  deps: SelectRouteDeps = {},
): Promise<RouteResolution> {
  return withOnDemandRefresh(deps, (pinned) => selectRoute(pinned));
}

/** Explicit-ordinal selection with the same on-demand refresh-before-refusal. */
export async function selectRouteByAccountOrdinalWithRefresh(
  ordinal: number,
  deps: SelectRouteDeps = {},
): Promise<RequestedRouteResolution> {
  return withOnDemandRefresh(deps, (pinned) =>
    selectRouteByAccountOrdinal(ordinal, pinned),
  );
}

/** Return the current snapshot only when it exists and is genuinely stale. */
function staleObservation(stateDir: string, nowMs: number): Observation | null {
  const observation = readObservationSidecar(observationSidecarPath(stateDir));
  if (observation === null || isObservationFresh(observation, nowMs)) {
    return null;
  }
  return observation;
}

async function withOnDemandRefresh(
  deps: SelectRouteDeps,
  select: (deps: SelectRouteDeps) => RouteResolution,
): Promise<RouteResolution> {
  const refresh = deps.refreshObservation;
  if (!refresh) return select(deps);
  const stateDir = deps.stateDir ?? resolveAccountRoutingRoot();
  // Pin ONE authority time so the staleness precheck and the same-cycle
  // selector judge the snapshot at the identical instant — no TTL-edge race
  // where a just-fresh precheck flips to a stale refusal on a re-sampled clock.
  const nowMs = deps.nowMs ?? Date.now();
  const stale = staleObservation(stateDir, nowMs);
  if (stale === null) return select({ ...deps, nowMs });
  let outcome: OnDemandRefreshOutcome;
  try {
    outcome = await refresh({ stateDir, nowMs });
  } catch {
    outcome = { kind: "still-stale" };
  }
  if (outcome.kind === "refreshed") {
    // Judge the refreshed snapshot at its own post-refresh instant, not the
    // stale precheck time, which now trails the just-published observation.
    return select({ ...deps, nowMs: deps.nowMs ?? Date.now() });
  }
  return {
    ok: false,
    error: onDemandRefusal(stale, nowMs, deps.model, outcome),
  };
}

/**
 * Map a completed {@link RefreshResult} to how a launch should treat it. A
 * fresh, healthy observation proceeds; a fresh-but-unhealthy one is a provider
 * failure; a withheld (contended) attempt is pacing; anything still stale asks
 * for another cycle. Callers pass a post-fetch `nowMs`.
 */
export function classifyOnDemandRefresh(
  result: RefreshResult,
  nowMs: number,
): OnDemandRefreshOutcome {
  const observation = result.observation;
  if (observation !== null && isObservationFresh(observation, nowMs)) {
    return observation.health === "ok"
      ? { kind: "refreshed" }
      : { kind: "provider-failed", detail: observation.health };
  }
  if (result.outcome === "contended") {
    return {
      kind: "pacing-declined",
      detail: "a refresh is already in progress",
    };
  }
  return { kind: "still-stale" };
}

function onDemandRefusal(
  observation: Observation,
  nowMs: number,
  model: string | null | undefined,
  outcome: Exclude<OnDemandRefreshOutcome, { kind: "refreshed" }>,
): string {
  switch (outcome.kind) {
    case "still-stale":
      return staleInventoryError(
        observation,
        nowMs,
        model,
        " and an on-demand refresh returned no fresher inventory",
        "wait for keeperd to refresh it or run `cswap list --json`",
      );
    case "pacing-declined":
      return staleInventoryError(
        observation,
        nowMs,
        model,
        `; an on-demand refresh was withheld by provider pacing (${outcome.detail})`,
        "retry shortly or run `cswap list --json`",
      );
    case "provider-failed":
      return staleInventoryError(
        observation,
        nowMs,
        model,
        ` and an on-demand refresh failed (${outcome.detail})`,
        "run `cswap list --json` to refresh status or repair the account",
      );
  }
}

function readFreshObservation(
  stateDir: string,
  nowMs: number,
  model: string | null | undefined,
  fableIntent?: boolean | null,
): { ok: true; observation: Observation } | { ok: false; error: string } {
  const observation = readObservationSidecar(observationSidecarPath(stateDir));
  if (observation === null) {
    return {
      ok: false,
      error: [
        `Claude cannot start${launchModelLabel(model, fableIntent) ? ` with ${launchModelLabel(model, fableIntent)}` : ""}: no current claude-swap inventory is available.`,
        "Next: wait for keeperd to refresh it or run `cswap list --json`.",
      ].join("\n"),
    };
  }
  if (!isObservationFresh(observation, nowMs)) {
    return {
      ok: false,
      error: staleInventoryError(
        observation,
        nowMs,
        model,
        "",
        "wait for keeperd to refresh it or run `cswap list --json`",
      ),
    };
  }
  if (observation.health !== "ok") {
    return {
      ok: false,
      error: inventoryWideError(
        observation,
        model,
        `inventory health is ${observation.health}`,
        "run `cswap list --json` and repair account sign-in or telemetry errors",
      ),
    };
  }
  return { ok: true, observation };
}

function normalizedModelName(model: string | null | undefined): string | null {
  if (typeof model !== "string") return null;
  const normalized = model.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function modelHasFableIntent(model: string | null | undefined): boolean {
  return normalizedModelName(model) === FABLE_MODEL;
}

function isFableRequest(
  model: string | null | undefined,
  fableIntent?: boolean | null,
): boolean {
  return typeof fableIntent === "boolean"
    ? fableIntent
    : modelHasFableIntent(model);
}

/** Classify only proven process-lineage intent for scoped Account focus. */
function scopedFableIntent(
  model: string | null | undefined,
  fableIntent?: boolean | null,
): boolean | null {
  if (typeof fableIntent === "boolean") return fableIntent;
  if (fableIntent === null) return null;
  return normalizedModelName(model) === null
    ? null
    : modelHasFableIntent(model);
}

function worstUtilizationForKey(route: Route, key: string): number | null {
  let found = false;
  let worst = 0;
  for (const window of route.windows) {
    if (window.key !== key) continue;
    found = true;
    worst = Math.max(worst, window.utilization);
  }
  return found ? worst : null;
}

function fableUtilization(route: Route): number | null {
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
    worst = Math.max(worst, window.utilization);
  }
  return found ? worst : null;
}

type LaunchRouteIssue =
  | AccountObservationIssue
  | "session-quota-missing"
  | "session-quota-exhausted"
  | "weekly-quota-missing"
  | "weekly-quota-exhausted"
  | "fable-entitlement-missing"
  | "fable-quota-exhausted";

function routeIssues(
  route: Route,
  model: string | null | undefined,
  fableIntent?: boolean | null,
): LaunchRouteIssue[] {
  const issues: LaunchRouteIssue[] = [];
  const session = worstUtilizationForKey(route, SESSION_WINDOW);
  const week = worstUtilizationForKey(route, WEEK_WINDOW);
  if (session === null) issues.push("session-quota-missing");
  else if (session >= 1) issues.push("session-quota-exhausted");
  if (week === null) issues.push("weekly-quota-missing");
  else if (week >= 1) issues.push("weekly-quota-exhausted");
  if (isFableRequest(model, fableIntent)) {
    const fable = fableUtilization(route);
    if (fable === null) issues.push("fable-entitlement-missing");
    else if (fable >= 1) issues.push("fable-quota-exhausted");
  }
  return issues;
}

function routeIsEligible(
  route: Route,
  model: string | null | undefined,
  fableIntent?: boolean | null,
): boolean {
  return routeIssues(route, model, fableIntent).length === 0;
}

function launchModelLabel(
  model: string | null | undefined,
  fableIntent?: boolean | null,
): string | null {
  if (fableIntent === true) return "Fable";
  const normalized = normalizedModelName(model);
  if (normalized === null) return null;
  if (normalized === FABLE_MODEL) return "Fable";
  return /^[a-z0-9][a-z0-9._/-]{0,63}$/u.test(normalized)
    ? `model '${normalized}'`
    : "the requested model";
}

function inventoryWideError(
  observation: Observation,
  model: string | null | undefined,
  reason: string,
  next: string,
): string {
  const modelLabel = launchModelLabel(model);
  const lines = [
    observation.claude_accounts.count === 0
      ? `Claude cannot start${modelLabel ? ` with ${modelLabel}` : ""}: ${reason}.`
      : `Claude cannot start${modelLabel ? ` with ${modelLabel}` : ""}.`,
  ];
  for (
    let ordinal = 0;
    ordinal < observation.claude_accounts.count;
    ordinal += 1
  ) {
    lines.push(`  c${ordinal}: ${reason}.`);
  }
  lines.push(`Next: ${next}.`);
  return lines.join("\n");
}

/**
 * Build the inventory-wide stale refusal, appending `detail` (an on-demand
 * refresh verdict, or "" for the plain stale case) after the age clause.
 */
function staleInventoryError(
  observation: Observation,
  nowMs: number,
  model: string | null | undefined,
  detail: string,
  next: string,
): string {
  const ageSeconds = Math.max(
    0,
    Math.ceil((nowMs - observation.observed_at_ms) / 1000),
  );
  return inventoryWideError(
    observation,
    model,
    `inventory snapshot is stale (${ageSeconds}s old; maximum ${OBSERVATION_FRESHNESS_CEILING_MS / 1000}s)${detail}`,
    next,
  );
}

function quotaResetSuffix(
  route: Route,
  matches: (window: NormalizedWindow) => boolean,
): string {
  let worst: NormalizedWindow | null = null;
  let worstUtilization = -1;
  for (const window of route.windows) {
    if (!matches(window)) continue;
    if (window.utilization > worstUtilization) {
      worst = window;
      worstUtilization = window.utilization;
    }
  }
  const reset = worst?.resetsAt;
  return typeof reset === "string" && reset.length > 0 && reset.length <= 80
    ? `; resets ${reset}`
    : "";
}

function issueMessage(
  issue: LaunchRouteIssue,
  route: Route | null,
  ordinal?: number,
): string {
  switch (issue) {
    case "relogin-required":
      return "needs sign-in again";
    case "token-expired":
      return ordinal === undefined
        ? "has an expired token; keeperd recovery retries automatically"
        : `has an expired token; keeperd recovery retries automatically, or run \`keeper agent accounts recover c${ordinal}\``;
    case "keychain-unavailable":
      return "credentials are unavailable";
    case "no-credentials":
      return "has no usable credentials";
    case "api-key":
      return "has no subscription quota (API-key account)";
    case "usage-unavailable":
      return "has unavailable usage according to claude-swap";
    case "account-unavailable":
      return "is unavailable according to claude-swap";
    case "missing-freshness":
      return "has no quota freshness timestamp";
    case "missing-windows":
      return "has no usable quota windows";
    case "malformed-scoped-windows":
      return "has malformed or ambiguous model quota data";
    case "session-quota-missing":
      return "has no session quota data";
    case "session-quota-exhausted":
      return `session quota is exhausted${route ? quotaResetSuffix(route, (window) => window.key === SESSION_WINDOW) : ""}`;
    case "weekly-quota-missing":
      return "has no weekly quota data";
    case "weekly-quota-exhausted":
      return `weekly quota is exhausted${route ? quotaResetSuffix(route, (window) => window.key === WEEK_WINDOW) : ""}`;
    case "fable-entitlement-missing":
      return "has no Fable quota";
    case "fable-quota-exhausted":
      return `Fable quota is exhausted${
        route
          ? quotaResetSuffix(
              route,
              (window) =>
                window.key.startsWith(MODEL_WINDOW_PREFIX) &&
                normalizedModelName(
                  window.key.slice(MODEL_WINDOW_PREFIX.length),
                ) === FABLE_MODEL,
            )
          : ""
      }`;
  }
}

function accountRouteIdAtOrdinal(
  observation: Observation,
  ordinal: number,
): string | null {
  return (
    Object.entries(observation.claude_accounts.ordinals).find(
      ([, index]) => index === ordinal,
    )?.[0] ?? null
  );
}

function accountFailureDetail(
  observation: Observation,
  ordinal: number,
  model: string | null | undefined,
  fableIntent?: boolean | null,
): string {
  const routeId = accountRouteIdAtOrdinal(observation, ordinal);
  if (routeId === null) return `c${ordinal}: inventory entry is invalid`;
  const route = observation.routes.find(
    (candidate) => candidate.id === routeId,
  );
  const issues = route
    ? routeIssues(route, model, fableIntent)
    : [observation.account_issues[routeId] ?? "account-unavailable"];
  return `c${ordinal}: ${issues
    .map((issue) => issueMessage(issue, route ?? null, ordinal))
    .join(", ")}`;
}

function routeUnavailableError(
  observation: Observation,
  model: string | null | undefined,
  fableIntent?: boolean | null,
): string {
  const modelLabel = launchModelLabel(model, fableIntent);
  if (observation.claude_accounts.count === 0) {
    return [
      `Claude cannot start${modelLabel ? ` with ${modelLabel}` : ""}: claude-swap has no managed accounts.`,
      "Next: register or sign in to an account, then run `cswap list --json`.",
    ].join("\n");
  }
  const details = Array.from(
    { length: observation.claude_accounts.count },
    (_, ordinal) =>
      accountFailureDetail(observation, ordinal, model, fableIntent),
  );
  return [
    `Claude cannot start${modelLabel ? ` with ${modelLabel}` : ""}.`,
    ...details.map((detail) => `  ${detail}.`),
    "Next: run `cswap list --json` to refresh status or repair the listed account.",
  ].join("\n");
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
    return {
      ok: false,
      error: [
        "Requested account index is invalid.",
        "Next: use a non-negative cN label such as --x-account c0.",
      ].join("\n"),
    };
  }
  const stateDir = deps.stateDir ?? resolveAccountRoutingRoot();
  const nowMs = deps.nowMs ?? Date.now();
  const fresh = readFreshObservation(
    stateDir,
    nowMs,
    deps.model,
    deps.fableIntent,
  );
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
      error: [
        `Requested account c${ordinal} is not registered.`,
        `  Available account labels: ${available}.`,
        "Next: choose a listed --x-account label or register another claude-swap account.",
      ].join("\n"),
    };
  }
  const routeId = Object.entries(display.ordinals).find(
    ([, index]) => index === ordinal,
  )?.[0];
  const route = observation.routes.find(
    (candidate) =>
      candidate.id === routeId &&
      candidate.slot > 0 &&
      managedRouteId(candidate.slot) === candidate.id,
  );
  if (!route || !routeIsEligible(route, deps.model, deps.fableIntent)) {
    const detail = accountFailureDetail(
      observation,
      ordinal,
      deps.model,
      deps.fableIntent,
    );
    const modelLabel = launchModelLabel(deps.model, deps.fableIntent);
    return {
      ok: false,
      error: [
        `Requested account c${ordinal} cannot serve${modelLabel ? ` ${modelLabel}` : " this Claude launch"}.`,
        `  ${detail}.`,
        "Next: choose another --x-account or run `cswap list --json`.",
      ].join("\n"),
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

type ScopedFocusPolicy = FableFocusPolicy | NonFableFocusPolicy;
type ScopedFocusState = FableFocusEffectiveState;

interface EffectiveScopedFocusView<P extends ScopedFocusPolicy> {
  state: ScopedFocusState;
  policy: P | null;
  diagnostic: string;
  activeTarget: Route | null;
  targetEligible: boolean | null;
}

interface FocusDeliveries {
  fable: FableFocusDelivery;
  nonFable: NonFableFocusDelivery;
}

interface EffectiveFocusViews {
  intent: boolean | null;
  fable: EffectiveScopedFocusView<FableFocusPolicy>;
  nonFable: EffectiveScopedFocusView<NonFableFocusPolicy>;
}

function readFocusDeliveries(
  deps: SelectRouteDeps,
  stateDir: string,
): FocusDeliveries {
  return {
    fable:
      deps.focusDelivery ?? readFableFocusLeaf(fableFocusPolicyPath(stateDir)),
    nonFable:
      deps.nonFableFocusDelivery ??
      readNonFableFocusLeaf(nonFableFocusPolicyPath(stateDir)),
  };
}

function effectiveScopedFocusView<P extends ScopedFocusPolicy>(
  effective: {
    state: ScopedFocusState;
    policy: P | null;
    diagnostic: string;
  },
  deps: SelectRouteDeps,
  observation: Observation,
  eligible: Route[],
  _nowMs: number,
): EffectiveScopedFocusView<P> {
  const policy = effective.policy;
  const target =
    policy === null
      ? null
      : (observation.routes.find((route) => route.id === policy.target_route) ??
        null);
  const targetEligible =
    policy === null
      ? null
      : target !== null &&
        routeIsEligible(target, deps.model, deps.fableIntent);
  return {
    state: effective.state,
    policy,
    diagnostic: effective.diagnostic,
    activeTarget:
      effective.state === "active" && targetEligible
        ? (eligible.find((route) => route.id === policy?.target_route) ?? null)
        : null,
    targetEligible,
  };
}

function focusViews(
  deps: SelectRouteDeps,
  observation: Observation,
  eligible: Route[],
  nowMs: number,
  deliveries: FocusDeliveries,
): EffectiveFocusViews {
  return {
    intent: scopedFableIntent(deps.model, deps.fableIntent),
    fable: effectiveScopedFocusView(
      effectiveFableFocus(deliveries.fable, observation, nowMs),
      deps,
      observation,
      eligible,
      nowMs,
    ),
    nonFable: effectiveScopedFocusView(
      effectiveNonFableFocus(deliveries.nonFable, observation, nowMs),
      deps,
      observation,
      eligible,
      nowMs,
    ),
  };
}

function chooseRoute(
  candidates: Route[],
  focuses: EffectiveFocusViews,
  ledger: Ledger,
  _nowMs: number,
  deps: SelectRouteDeps,
): { chosen: Route; reason: string } {
  if (focuses.intent === true && focuses.fable.activeTarget !== null) {
    return { chosen: focuses.fable.activeTarget, reason: "fable-focus" };
  }
  if (focuses.intent === false && focuses.nonFable.activeTarget !== null) {
    return {
      chosen: focuses.nonFable.activeTarget,
      reason: "non-fable-focus",
    };
  }

  let pool = candidates;
  if (
    focuses.intent === false &&
    focuses.fable.activeTarget !== null &&
    candidates.length > 1
  ) {
    pool = candidates.filter(
      (route) => route.id !== focuses.fable.activeTarget?.id,
    );
  }
  const chosen = scoreAndPick(pool, ledger, deps.model, deps.fableIntent);
  const matchingFocus =
    focuses.intent === true
      ? focuses.fable
      : focuses.intent === false
        ? focuses.nonFable
        : null;
  const fallbackReason =
    focuses.intent === true
      ? "fable-focus-fallback"
      : "non-fable-focus-fallback";
  const reason =
    pool.length !== candidates.length
      ? "fable-focus-avoided"
      : matchingFocus?.state === "active" &&
          matchingFocus.policy !== null &&
          matchingFocus.activeTarget === null
        ? fallbackReason
        : candidates.length === 1
          ? "sole-candidate"
          : "selected";
  return { chosen, reason };
}

function doSelectRoute(deps: SelectRouteDeps): RouteResolution {
  const stateDir = deps.stateDir ?? resolveAccountRoutingRoot();
  const nowMs = deps.nowMs ?? Date.now();
  const fresh = readFreshObservation(
    stateDir,
    nowMs,
    deps.model,
    deps.fableIntent,
  );
  if (!fresh.ok) return fresh;
  const observation = fresh.observation;
  const candidates = observation.routes.filter((route) =>
    routeIsEligible(route, deps.model, deps.fableIntent),
  );
  if (candidates.length === 0) {
    return {
      ok: false,
      error: routeUnavailableError(observation, deps.model, deps.fableIntent),
    };
  }

  const deliveries = readFocusDeliveries(deps, stateDir);
  mkdirSync(stateDir, { recursive: true });
  const lock = FileLock.acquire(ledgerLockPath(stateDir));
  try {
    const ledger = pruneLedger(loadLedger(stateDir), nowMs);
    const focuses = focusViews(
      deps,
      observation,
      candidates,
      nowMs,
      deliveries,
    );
    const { chosen, reason } = chooseRoute(
      candidates,
      focuses,
      ledger,
      nowMs,
      deps,
    );
    recordReservation(ledger, chosen.id, nowMs);
    writeLedger(stateDir, ledger);
    return {
      ok: true,
      selection: selectedRoute(chosen, reason, observation),
    };
  } finally {
    lock.release();
  }
}

export type FocusConstructionResult =
  | { ok: true; focus: FableFocusInput }
  | { ok: false; code: string };

export function resolveObservedManagedRoute(
  targetValue: string,
  deps: SelectRouteDeps = {},
):
  | { ok: true; target_route: ManagedAccountRouteId }
  | { ok: false; code: string } {
  const direct = normalizeManagedRouteId(targetValue);
  if (direct !== null) return { ok: true, target_route: direct };
  const stateDir = deps.stateDir ?? resolveAccountRoutingRoot();
  const nowMs = deps.nowMs ?? Date.now();
  const observation = readObservationSidecar(observationSidecarPath(stateDir));
  const match = /^c(0|[1-9]\d*)$/u.exec(targetValue);
  if (
    match === null ||
    observation === null ||
    !isObservationFresh(observation, nowMs) ||
    observation.health !== "ok"
  ) {
    return { ok: false, code: "focus_target_unavailable" };
  }
  const route = normalizeManagedRouteId(
    accountRouteIdAtOrdinal(observation, Number(match[1])),
  );
  return route === null
    ? { ok: false, code: "focus_target_unavailable" }
    : { ok: true, target_route: route };
}

export function constructObservedFableFocus(
  targetValue: string,
  kind: "current-reset" | "cycle-end",
  expectedReset: string | null,
  deps: SelectRouteDeps = {},
): FocusConstructionResult {
  const stateDir = deps.stateDir ?? resolveAccountRoutingRoot();
  const nowMs = deps.nowMs ?? Date.now();
  const observation = readObservationSidecar(observationSidecarPath(stateDir));
  const resolved = resolveObservedManagedRoute(targetValue, deps);
  if (!resolved.ok) return resolved;
  const built = buildCurrentResetFableFocus(
    resolved.target_route,
    observation,
    nowMs,
    expectedReset,
  );
  if (!built.ok)
    return { ok: false, code: `focus_${built.reason.replaceAll("-", "_")}` };
  if (kind === "current-reset") return built;
  const lifetime = built.focus.lifetime;
  if (lifetime.kind !== "current-reset") {
    return { ok: false, code: "focus_reset_unavailable" };
  }
  return {
    ok: true,
    focus: {
      target_route: built.focus.target_route,
      lifetime: { kind: "cycle-end", reset_at: lifetime.reset_at },
    },
  };
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

export type AccountFocusOutcome =
  | "off"
  | "focused"
  | "avoided"
  | "sole-target"
  | "fallback";

export interface AccountFocusRoutingView<
  TState extends ScopedFocusState = ScopedFocusState,
  TLifetime extends
    | AccountFocusLifetime
    | { kind: "cycle-end"; reset_at: string } =
    | AccountFocusLifetime
    | { kind: "cycle-end"; reset_at: string },
> {
  configured: boolean;
  state: TState;
  target_route: ManagedAccountRouteId | null;
  lifetime: TLifetime | null;
  target_eligible: boolean | null;
  outcome: AccountFocusOutcome;
  reason:
    | "policy-off"
    | "target-focused"
    | "target-avoided"
    | "sole-eligible-route"
    | "target-ineligible"
    | "policy-inactive"
    | "policy-unavailable";
  diagnostic: string;
}

export type FableFocusOutcome = AccountFocusOutcome;
export type FableFocusRoutingView = AccountFocusRoutingView<
  FableFocusEffectiveState,
  FableFocusPolicy["lifetime"]
>;
export type NonFableFocusRoutingView = AccountFocusRoutingView<
  AccountFocusEffectiveState,
  NonFableFocusPolicy["lifetime"]
>;

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
  fable_focus: FableFocusRoutingView;
  non_fable_focus: NonFableFocusRoutingView;
}

function inspectionFocusView<
  P extends ScopedFocusPolicy,
  S extends ScopedFocusState,
>(
  effective: { state: S; policy: P | null; diagnostic: string },
  observation: Observation | null,
  focusIntent: boolean,
  deps: SelectRouteDeps = {},
  _nowMs: number = deps.nowMs ?? Date.now(),
): AccountFocusRoutingView<S, P["lifetime"]> {
  const policy = effective.policy;
  if (policy === null) {
    return unavailableFocusView(effective.state, effective.diagnostic);
  }
  const target = observation?.routes.find(
    (route) => route.id === policy.target_route,
  );
  const targetEligible =
    observation === null
      ? null
      : target !== undefined &&
        routeIsEligible(
          target,
          focusIntent ? "fable" : "non-fable",
          focusIntent,
        );
  if (effective.state !== "active") {
    return {
      configured: true,
      state: effective.state,
      target_route: policy.target_route,
      lifetime: policy.lifetime,
      target_eligible: targetEligible,
      outcome: "fallback",
      reason: "policy-inactive",
      diagnostic: effective.diagnostic,
    };
  }
  if (targetEligible !== true) {
    return {
      configured: true,
      state: effective.state,
      target_route: policy.target_route,
      lifetime: policy.lifetime,
      target_eligible: targetEligible,
      outcome: "fallback",
      reason: "target-ineligible",
      diagnostic: effective.diagnostic,
    };
  }
  return {
    configured: true,
    state: effective.state,
    target_route: policy.target_route,
    lifetime: policy.lifetime,
    target_eligible: true,
    outcome: "focused",
    reason: "target-focused",
    diagnostic: effective.diagnostic,
  };
}

function unavailableFocusView<
  S extends ScopedFocusState,
  L extends AccountFocusLifetime | { kind: "cycle-end"; reset_at: string },
>(state: S, diagnostic: string): AccountFocusRoutingView<S, L> {
  return {
    configured: false,
    state,
    target_route: null,
    lifetime: null,
    target_eligible: null,
    outcome: state === "off" ? "off" : "fallback",
    reason:
      state === "off"
        ? "policy-off"
        : state === "unavailable"
          ? "policy-unavailable"
          : "policy-inactive",
    diagnostic,
  };
}

function unavailableFableFocusView(): FableFocusRoutingView {
  return unavailableFocusView("unavailable", "delivery-unreachable");
}

function unavailableNonFableFocusView(): NonFableFocusRoutingView {
  return unavailableFocusView("unavailable", "delivery-unreachable");
}

export interface AccountFocusInspectionViews {
  fable: FableFocusRoutingView;
  nonFable: NonFableFocusRoutingView;
}

/** Inspect both focus scopes against one coherent Capacity observation. */
export function inspectAccountFocuses(input: {
  observation: Observation | null;
  nowMs: number;
  fableDelivery: FableFocusDelivery;
  nonFableDelivery: NonFableFocusDelivery;
}): AccountFocusInspectionViews {
  const usableObservation =
    input.observation !== null &&
    input.observation.health === "ok" &&
    isObservationFresh(input.observation, input.nowMs)
      ? input.observation
      : null;
  return {
    fable: inspectionFocusView(
      effectiveFableFocus(input.fableDelivery, input.observation, input.nowMs),
      usableObservation,
      true,
      { nowMs: input.nowMs },
    ),
    nonFable: inspectionFocusView(
      effectiveNonFableFocus(
        input.nonFableDelivery,
        input.observation,
        input.nowMs,
      ),
      usableObservation,
      false,
      { nowMs: input.nowMs },
    ),
  };
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
      | "model_scope"
      | "observed_at_ms"
      | "age_ms"
      | "fresh"
      | "fable_focus"
      | "non_fable_focus"
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
    fable_focus: extras.fable_focus ?? unavailableFableFocusView(),
    non_fable_focus: extras.non_fable_focus ?? unavailableNonFableFocusView(),
  };
}

function doInspectRouting(deps: SelectRouteDeps): RoutingInspection {
  const stateDir = deps.stateDir ?? resolveAccountRoutingRoot();
  const nowMs = deps.nowMs ?? Date.now();
  const deliveries = readFocusDeliveries(deps, stateDir);
  const observation = readObservationSidecar(observationSidecarPath(stateDir));
  if (observation === null) {
    return disabledInspection(
      "no-observation",
      "no claude-swap account inventory is available",
      {
        model_scope: normalizedModelName(deps.model),
        fable_focus: inspectionFocusView(
          effectiveFableFocus(deliveries.fable, null, nowMs),
          null,
          true,
          deps,
          nowMs,
        ),
        non_fable_focus: inspectionFocusView(
          effectiveNonFableFocus(deliveries.nonFable, null, nowMs),
          null,
          false,
          deps,
          nowMs,
        ),
      },
    );
  }
  const ageMs = nowMs - observation.observed_at_ms;
  const fresh = isObservationFresh(observation, nowMs);
  const usableObservation =
    fresh && observation.health === "ok" ? observation : null;
  const extras = {
    model_scope: normalizedModelName(deps.model),
    observed_at_ms: observation.observed_at_ms,
    age_ms: ageMs,
    fresh,
    fable_focus: inspectionFocusView(
      effectiveFableFocus(deliveries.fable, observation, nowMs),
      usableObservation,
      true,
      deps,
      nowMs,
    ),
    non_fable_focus: inspectionFocusView(
      effectiveNonFableFocus(deliveries.nonFable, observation, nowMs),
      usableObservation,
      false,
      deps,
    ),
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
  const routeable = observation.routes.filter((route) =>
    routeIsEligible(route, deps.model, deps.fableIntent),
  );
  if (routeable.length === 0) {
    return disabledInspection(
      observation.health,
      routeUnavailableError(observation, deps.model, deps.fableIntent),
      {
        ...extras,
        fable_focus: inspectionFocusView(
          effectiveFableFocus(deliveries.fable, observation, nowMs),
          observation,
          true,
          deps,
          nowMs,
        ),
        non_fable_focus: inspectionFocusView(
          effectiveNonFableFocus(deliveries.nonFable, observation, nowMs),
          observation,
          false,
          deps,
        ),
      },
    );
  }

  const ledger = pruneLedger(loadLedger(stateDir), nowMs);
  const candidates: RoutingCandidateView[] = routeable.map((route) => {
    const entry = ledger.routes[route.id];
    const pending = entry?.reservations.length ?? 0;
    const fable = fableUtilization(route);
    return {
      id: route.id,
      kind: "managed",
      slot: route.slot,
      worst_utilization: genericPressure(route, pending),
      fable_remaining:
        fable === null ? null : Number(Math.max(0, 1 - fable).toFixed(6)),
    };
  });
  const focuses = focusViews(deps, observation, routeable, nowMs, deliveries);
  const { chosen, reason } = chooseRoute(
    routeable,
    focuses,
    ledger,
    nowMs,
    deps,
  );
  return {
    model_scope: normalizedModelName(deps.model),
    health: observation.health,
    observed_at_ms: observation.observed_at_ms,
    age_ms: ageMs,
    fresh: true,
    enabled: true,
    error: null,
    would_choose: selectedRoute(chosen, reason, observation),
    candidates,
    fable_focus: inspectionFocusView(
      effectiveFableFocus(deliveries.fable, observation, nowMs),
      observation,
      true,
      deps,
      nowMs,
    ),
    non_fable_focus: inspectionFocusView(
      effectiveNonFableFocus(deliveries.nonFable, observation, nowMs),
      observation,
      false,
      deps,
    ),
  };
}

function genericPressure(route: Route, pending: number): number {
  let worst = 0;
  for (const window of route.windows) {
    if (window.key.startsWith(MODEL_WINDOW_PREFIX)) continue;
    if (window.utilization > worst) worst = window.utilization;
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
  model: string | null | undefined,
  fableIntent?: boolean | null,
): RouteScore {
  const fable = fableUtilization(route);
  const pressure = genericPressure(route, pending);
  if (isFableRequest(model, fableIntent)) {
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
  model: string | null | undefined,
  fableIntent?: boolean | null,
): Route {
  let best: Route | null = null;
  let bestScore: RouteScore | null = null;
  let bestLastSelected = Number.POSITIVE_INFINITY;
  for (const route of candidates) {
    const entry = ledger.routes[route.id];
    const pending = entry?.reservations.length ?? 0;
    const lastSelected = entry?.last_selected_at ?? Number.NEGATIVE_INFINITY;
    const score = routeScore(route, pending, model, fableIntent);
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

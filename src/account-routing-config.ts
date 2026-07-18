/**
 * Shared configuration for Keeper's claude-swap-only account routing. The
 * observer and launcher wrap the public `cswap` CLI with exact argv arrays and
 * no shell. This module is a DB-free leaf: pure paths, constants, and executable
 * resolution only.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Sidecars are transient; an old schema is treated as absent, never migrated. */
export const OBSERVATION_SCHEMA_VERSION = 4;

/** A version mismatch discards incompatible reservation state. */
export const LEDGER_SCHEMA_VERSION = 2;

/** The supported `cswap list --json` schema major. */
export const CSWAP_SUPPORTED_SCHEMA_MAJOR = 1;

/** Build the stable, PII-free route id for one claude-swap slot. */
export function managedRouteId(slot: number): string {
  return `claude-swap:${slot}`;
}

/** PII-free launch attribution injected into every Keeper-launched Claude. */
export const KEEPER_ACCOUNT_ROUTE_ENV = "KEEPER_ACCOUNT_ROUTE";

/** Optional zero-based display position in the ordered cswap inventory. */
export const KEEPER_ACCOUNT_ORDINAL_ENV = "KEEPER_ACCOUNT_ORDINAL";

/** Bound every external CLI call. */
export const SUBPROCESS_TIMEOUT_MS = 15_000;

/** Refuse oversized provider output instead of parsing a truncation. */
export const MAX_OUTPUT_BYTES = 262_144;

/** Refuse pathologically deep JSON. */
export const MAX_JSON_DEPTH = 32;

/** Maximum age of the daemon observation used for one launch decision. */
export const OBSERVATION_FRESHNESS_CEILING_MS = 5 * 60_000;

/** Maximum age of one account's usage measurement. */
export const ROUTE_MEASUREMENT_FRESHNESS_CEILING_MS = 10 * 60_000;

/** Base interval between observer cycles. */
export const OBSERVE_INTERVAL_MS = 60_000;

/** Uniform jitter added to each observer sleep. */
export const OBSERVE_JITTER_MS = 15_000;

/** Short-lived launch reservation lifetime. */
export const RESERVATION_TTL_MS = 90_000;

/** Utilization pressure contributed by one live reservation. */
export const RESERVATION_UTILIZATION_STEP = 0.05;

/** Bound reservation timestamps retained per route. */
export const MAX_RESERVATIONS_PER_ROUTE = 64;

/** Bound PII-free observation diagnostics. */
export const MAX_OBSERVATION_NOTES = 16;
export const MAX_NOTE_LENGTH = 200;

/** Resolve the private account-routing state root. */
export function resolveAccountRoutingRoot(): string {
  const override = process.env.KEEPER_ACCOUNT_ROUTING_ROOT;
  if (override && override.length > 0) return override;
  return join(homedir(), ".local", "state", "keeper", "account-routing");
}

export function observationSidecarPath(root: string): string {
  return join(root, "observation.json");
}

export function ledgerPath(root: string): string {
  return join(root, "reservations.json");
}

export function ledgerLockPath(root: string): string {
  return join(root, "reservations.json.lock");
}

export function observationRefreshLockPath(root: string): string {
  return join(root, "observation.json.refresh.lock");
}

/** Resolve claude-swap through the operator override or PATH. */
export function resolveCswapCommand(): string {
  const override = process.env.KEEPER_CSWAP_BIN;
  return override && override.length > 0 ? override : "cswap";
}

/** Exact no-shell argv for the managed-account inventory. */
export function cswapListArgv(bin: string = resolveCswapCommand()): string[] {
  return [bin, "list", "--json"];
}

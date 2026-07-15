/**
 * Shared configuration leaf for the account-routing subsystem — the tunables,
 * path resolution, and external-executable resolution the capacity observer and
 * the per-launch router both read. DB-free island: `node:*` only, never
 * `src/db.ts` (the bun:sqlite module), so the cold-start launch path stays cheap.
 *
 * Two installed public CLIs back the subsystem, wrapped with exact argument
 * arrays and no shell:
 *  - **CodexBar** (`codexbar`) observes ambient Claude usage for the routing gate
 *    and Codex quota capacity for foreground policy. It never supplies managed
 *    rows.
 *  - **claude-swap** (`cswap`) reports managed-account inventory, launchability,
 *    quota windows, and measurement freshness under a versioned schema.
 *
 * Everything here is a pure resolver or a compile-time constant; the observer and
 * router inject their own clocks and command runners, so nothing in this module
 * touches the network, spawns a process, or reads wall-clock.
 */

import { homedir } from "node:os";
import { join } from "node:path";

// ---------- schema majors --------------------------------------------------

/**
 * The observation sidecar schema. A sidecar carrying any other value is treated
 * as absent (start fresh) rather than migrated — the router fails open to the
 * native default, costing at most one stale-read.
 */
export const OBSERVATION_SCHEMA_VERSION = 2;

/** The reservation-ledger schema. A mismatch discards the ledger (fail-open). */
export const LEDGER_SCHEMA_VERSION = 1;

/**
 * The only `cswap … --json` `schemaVersion` we accept. A newer major is treated
 * as unsupported (no managed routes) rather than optimistically parsed — never
 * infer compatibility from an unknown machine boundary. Additive fields within
 * the major are tolerated by the strict parsers.
 */
export const CSWAP_SUPPORTED_SCHEMA_MAJOR = 1;

// ---------- route identity -------------------------------------------------

/**
 * The native default route id — the ambient Claude account, used verbatim as the
 * fail-open fallback everywhere. A real, PII-free identifier, not a sentinel.
 */
export const NATIVE_ROUTE_ID = "default";

/**
 * Build a managed route's stable, PII-free id from its claude-swap slot number.
 * `claude-swap:<slot>` — never an email/org, so it is safe to persist and log.
 */
export function managedRouteId(slot: number): string {
  return `claude-swap:${slot}`;
}

/**
 * The launch-carrier env var that names the account route a Claude process was
 * launched on. Set on EVERY routed Claude launch (native or managed) to the
 * PII-free route id, so launch attribution can record which route was used. It
 * survives the claude-swap same-account fast path (claude-swap scrubs only
 * auth-override vars and execs with the inherited environment), so route
 * identity is carried WITHOUT relying on `CLAUDE_CONFIG_DIR`.
 */
export const KEEPER_ACCOUNT_ROUTE_ENV = "KEEPER_ACCOUNT_ROUTE";

/**
 * Zero-based position of the selected Claude account in `cswap list --json`'s
 * ordered inventory. Set only when that inventory contains multiple accounts;
 * the Claude statusline renders it as `c<N>`. This display hint is deliberately
 * separate from the stable route id because claude-swap slot numbers may be
 * sparse and are not inventory ordinals.
 */
export const KEEPER_ACCOUNT_ORDINAL_ENV = "KEEPER_ACCOUNT_ORDINAL";

// ---------- bounded-execution knobs ----------------------------------------

/**
 * Per-subprocess wall-clock deadline (ms). A CodexBar/cswap invocation that
 * overruns is force-killed and treated as unavailable; observation must never
 * block the daemon or a launch on a wedged provider CLI.
 */
export const SUBPROCESS_TIMEOUT_MS = 15_000;

/**
 * Hard cap on a single provider CLI's captured stdout (bytes). Output past the
 * cap is a refusal-to-parse (the payload is unbounded or hostile), never a
 * truncated parse. Mirrors CodexBar's own `ClaudeSwapAccountReader.maxOutputBytes`.
 */
export const MAX_OUTPUT_BYTES = 262_144;

/**
 * Maximum JSON nesting depth the strict parsers descend before rejecting. Guards
 * against a pathologically deep payload exhausting the stack; the real shapes are
 * three or four levels deep, so this is generous.
 */
export const MAX_JSON_DEPTH = 32;

// ---------- freshness / cadence --------------------------------------------

/**
 * Maximum age (ms) of the observation sidecar before the router treats the whole
 * observation as stale and disables automatic balancing. Anchored on the
 * sidecar's `observed_at_ms`, so a dead observer worker ages out and selection
 * auto-falls-back to the native default rather than acting on frozen capacity.
 */
export const OBSERVATION_FRESHNESS_CEILING_MS = 5 * 60_000;

/**
 * Maximum age (ms) of a single claude-swap usage measurement before that route
 * is excluded as stale. claude-swap serves last-good numbers with their own age;
 * a measurement past this ceiling is unknown, not spare capacity, so its route
 * drops out of candidacy rather than presenting zero usage.
 */
export const ROUTE_MEASUREMENT_FRESHNESS_CEILING_MS = 10 * 60_000;

/** Base interval (ms) between observer cycles. */
export const OBSERVE_INTERVAL_MS = 60_000;

/**
 * Uniform jitter (ms) added to each observer sleep so multiple hosts / restarts
 * don't synchronize their provider polls into a lockstep cohort.
 */
export const OBSERVE_JITTER_MS = 15_000;

// ---------- reservation ledger knobs ---------------------------------------

/**
 * How long (ms) a Launch reservation biases selection before it expires. Short
 * by design: a reservation only nudges simultaneous picks apart, and a crashed
 * worker or a host suspend must let its reservation lapse rather than harden into
 * an exclusive account claim.
 */
export const RESERVATION_TTL_MS = 90_000;

/**
 * Utilization (as a 0..1 fraction) each live reservation adds to a route's
 * effective worst-window utilization. Non-zero so two equally eligible routes
 * cannot both be chosen by a burst of simultaneous launches — the first pick's
 * reservation shifts the next pick to the other route.
 */
export const RESERVATION_UTILIZATION_STEP = 0.05;

/**
 * Upper bound on the reservation timestamps retained per route. Live pressure is
 * naturally capped by {@link RESERVATION_TTL_MS}, but a pathological burst is
 * clamped here so the ledger stays bounded regardless of launch rate.
 */
export const MAX_RESERVATIONS_PER_ROUTE = 64;

// ---------- diagnostics ----------------------------------------------------

/** Cap on the observation's PII-free diagnostic `notes` array (entries). */
export const MAX_OBSERVATION_NOTES = 16;

/** Cap on a single diagnostic note's length (characters). */
export const MAX_NOTE_LENGTH = 200;

// ---------- path resolution ------------------------------------------------

/**
 * Resolve the account-routing state root to an absolute path. The
 * `KEEPER_ACCOUNT_ROUTING_ROOT` env wins (the test-isolation seam — sandboxes the
 * sidecar + ledger so an observer/router test never touches the real host tree);
 * else `~/.local/state/keeper/account-routing/`, a sibling of the other keeper
 * state dirs. Both the observer (sidecar writer) and the router (sidecar reader +
 * ledger owner) resolve through here so one override moves the whole tree. Pure.
 */
export function resolveAccountRoutingRoot(): string {
  const override = process.env.KEEPER_ACCOUNT_ROUTING_ROOT;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "account-routing");
}

/** The observation sidecar path under `root` — the observer's sole output. */
export function observationSidecarPath(root: string): string {
  return join(root, "observation.json");
}

/** The reservation-ledger path under `root` — the router's flocked RMW target. */
export function ledgerPath(root: string): string {
  return join(root, "reservations.json");
}

/** The advisory-lock path guarding the reservation ledger. */
export function ledgerLockPath(root: string): string {
  return join(root, "reservations.json.lock");
}

/** The per-refresh advisory lock guarding observation publication. */
export function observationRefreshLockPath(root: string): string {
  return join(root, "observation.json.refresh.lock");
}

/** Lifetime non-blocking lock for the foreground Codex reset controller. */
export function codexUsageResetCommandLockPath(root: string): string {
  return join(root, "codex-usage-reset.lock");
}

/** Durable at-most-once latch for one Codex weekly reset window. */
export function codexUsageResetLatchPath(root: string): string {
  return join(root, "codex-usage-reset.json");
}

// ---------- executable resolution ------------------------------------------

/**
 * Resolve the CodexBar executable. `KEEPER_CODEXBAR_BIN` env wins (test /
 * operator override); else the bare `codexbar` name, resolved on PATH at spawn
 * time. Never a shell string — the runner execs the exact argv. Pure.
 */
export function resolveCodexBarCommand(): string {
  const override = process.env.KEEPER_CODEXBAR_BIN;
  return override && override.length > 0 ? override : "codexbar";
}

/**
 * Resolve the claude-swap executable. `KEEPER_CSWAP_BIN` env wins; else the bare
 * `cswap` name, resolved on PATH at spawn time. Pure.
 */
export function resolveCswapCommand(): string {
  const override = process.env.KEEPER_CSWAP_BIN;
  return override && override.length > 0 ? override : "cswap";
}

/** Exact argv (no shell) that fetches CodexBar's Claude usage as JSON. */
export function codexBarClaudeUsageArgv(
  bin: string = resolveCodexBarCommand(),
): string[] {
  return [bin, "--provider", "claude", "--format", "json"];
}

/** Exact argv (no shell) that fetches CodexBar's Codex usage as JSON. */
export function codexBarCodexUsageArgv(
  bin: string = resolveCodexBarCommand(),
): string[] {
  return [bin, "--provider", "codex", "--format", "json"];
}

/** Compatibility aliases for callers using either established naming order. */
export const claudeCodexBarUsageArgv = codexBarClaudeUsageArgv;
export const codexCodexBarUsageArgv = codexBarCodexUsageArgv;
export const codexBarUsageArgv = codexBarClaudeUsageArgv;

/** The exact argv (no shell) that fetches the claude-swap managed inventory. */
export function cswapListArgv(bin: string = resolveCswapCommand()): string[] {
  return [bin, "list", "--json"];
}

/**
 * The per-launch account router — the pure selection policy over the latest
 * Capacity observation plus a short-lived, flock-guarded Launch-reservation
 * ledger. Replaces the retired latched-reserve profile picker: there is no
 * threshold ladder, no reserve account, no hysteresis latch, and no
 * conversation-to-account affinity.
 *
 * DB-free leaf: `node:*` + this subsystem's own dep-free helpers only, never
 * `src/db.ts`, so the `keeper agent` cold start stays cheap. Selection is
 * evidence-sensitive and fails open to the native default account on every
 * uncertain path.
 *
 * **One question, answered continuously.** Every fresh start, resume, and restore
 * calls {@link selectRoute} independently. It reads the observer's latest
 * validated sidecar (never an external CLI — no provider latency on the launch
 * path), then, inside ONE flock-guarded read-modify-write:
 *
 *  1. Selection is DISABLED — the native default route is returned with no ledger
 *     write — whenever there is no observation, it has aged past the freshness
 *     ceiling, or CodexBar health is anything but `ok`.
 *  2. Otherwise it scores every routeable candidate by its WORST normalized
 *     window's effective utilization (base utilization plus this route's live
 *     reservation pressure), prefers the greatest headroom, and breaks ties by
 *     least-recently-used then stable route id.
 *  3. It records one short-lived reservation on the chosen route so simultaneous
 *     launches spread across equally eligible accounts instead of stampeding one.
 *
 * The ledger holds ONLY bounded reservation pressure and recency — no affinity,
 * no reserve latch. A reservation expires after a short TTL, so a crashed worker
 * or a host suspend can never let one harden into an exclusive account claim.
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
  type NormalizedWindow,
  type Route,
  type RouteKind,
  readObservationSidecar,
} from "./account-observation";
import {
  LEDGER_SCHEMA_VERSION,
  ledgerLockPath,
  ledgerPath,
  MAX_RESERVATIONS_PER_ROUTE,
  NATIVE_ROUTE_ID,
  observationSidecarPath,
  RESERVATION_TTL_MS,
  RESERVATION_UTILIZATION_STEP,
  resolveAccountRoutingRoot,
} from "./account-routing-config";
import { FileLock } from "./file-lock";

/** Upper bound on distinct route entries retained in the ledger. */
const MAX_LEDGER_ROUTES = 64;

/**
 * The router's answer: a stable, PII-free route id plus its kind/slot and a
 * short diagnostic `reason`. `reason` explains WHY this route was chosen — for
 * logs and forensics only; it is never fed back into a later selection.
 */
export interface RouteSelection {
  id: string;
  kind: RouteKind;
  slot: number | null;
  reason: string;
}

/** Injectable seams — tests pin the state root and the clock; production defaults. */
export interface SelectRouteDeps {
  /** Where the sidecar + ledger live. Defaults to the resolved routing root. */
  stateDir?: string;
  /** The selection instant (epoch ms). Defaults to `Date.now()`. */
  nowMs?: number;
}

/** The native default selection, returned on every fail-open path. */
function nativeSelection(reason: string): RouteSelection {
  return { id: NATIVE_ROUTE_ID, kind: "native", slot: null, reason };
}

/**
 * Choose the account route for one launch. Never throws — every failure path
 * returns the native default. See the module header for the full contract.
 */
export function selectRoute(deps: SelectRouteDeps = {}): RouteSelection {
  try {
    return doSelectRoute(deps);
  } catch {
    return nativeSelection("error");
  }
}

function doSelectRoute(deps: SelectRouteDeps): RouteSelection {
  const stateDir = deps.stateDir ?? resolveAccountRoutingRoot();
  const nowMs = deps.nowMs ?? Date.now();

  // Read the sidecar OUTSIDE the lock — a local file read, no provider call. The
  // lock guards only the ledger read-modify-write, never an external poll.
  const obs = readObservationSidecar(observationSidecarPath(stateDir));
  if (obs === null) {
    return nativeSelection("no-observation");
  }
  if (!isObservationFresh(obs, nowMs)) {
    return nativeSelection("stale-observation");
  }
  if (obs.health !== "ok") {
    // CodexBar gate closed — automatic balancing disabled.
    return nativeSelection(`disabled-${obs.health}`);
  }

  // Candidates: every route carrying at least one window (an unknown-window route
  // is excluded, never treated as zero usage).
  const candidates = obs.routes.filter((r) => r.windows.length > 0);
  if (candidates.length === 0) {
    return nativeSelection("native-fallback");
  }

  mkdirSync(stateDir, { recursive: true });
  const lock = FileLock.acquire(ledgerLockPath(stateDir));
  try {
    const ledger = pruneLedger(loadLedger(stateDir), nowMs);
    const chosen = scoreAndPick(candidates, ledger, nowMs);
    recordReservation(ledger, chosen.id, nowMs);
    writeLedger(stateDir, ledger);
    return {
      id: chosen.id,
      kind: chosen.kind,
      slot: chosen.slot,
      reason: candidates.length === 1 ? "sole-candidate" : "selected",
    };
  } finally {
    lock.release();
  }
}

// ---------- scoring ---------------------------------------------------------

/**
 * The worst (highest) effective utilization across a route's windows: the base
 * utilization — with rollover grace, so a tz-aware past reset counts as 0 — plus
 * this route's live reservation pressure. Greatest headroom is the LOWEST worst.
 */
function worstEffectiveUtilization(
  windows: NormalizedWindow[],
  pending: number,
  nowMs: number,
): number {
  let worst = 0;
  for (const w of windows) {
    let util = w.utilization;
    if (w.resetsAt !== null) {
      const resetMs = new Date(w.resetsAt).getTime();
      if (!Number.isNaN(resetMs) && resetMs <= nowMs) {
        util = 0; // the window already reset — no quota burned
      }
    }
    if (util > worst) {
      worst = util;
    }
  }
  return worst + pending * RESERVATION_UTILIZATION_STEP;
}

/**
 * Pick the candidate with the greatest worst-window headroom after reservations.
 * Ties break by least-recently-used (oldest `last_selected_at` first; a route
 * never selected sorts epoch-oldest and wins a catch-up turn), then by stable
 * route id (lexicographically smallest). Deterministic — no wall-clock, no RNG.
 */
function scoreAndPick(
  candidates: Route[],
  ledger: Ledger,
  nowMs: number,
): Route {
  let best: Route | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestLastSelected = Number.POSITIVE_INFINITY;
  for (const route of candidates) {
    const entry = ledger.routes[route.id];
    const pending = entry ? entry.reservations.length : 0;
    const lastSelected = entry
      ? entry.last_selected_at
      : Number.NEGATIVE_INFINITY;
    const score = worstEffectiveUtilization(route.windows, pending, nowMs);
    if (
      best === null ||
      score < bestScore ||
      (score === bestScore && lastSelected < bestLastSelected) ||
      (score === bestScore &&
        lastSelected === bestLastSelected &&
        route.id < best.id)
    ) {
      best = route;
      bestScore = score;
      bestLastSelected = lastSelected;
    }
  }
  // `candidates` is non-empty (guarded by the caller), so `best` is set.
  return best as Route;
}

// ---------- reservation ledger ----------------------------------------------

interface LedgerEntry {
  /** Epoch-ms timestamps of live reservations (pruned to the TTL window). */
  reservations: number[];
  /** Epoch ms this route was last selected — the LRU tie-break key. */
  last_selected_at: number;
}

interface Ledger {
  schema_version: number;
  routes: Record<string, LedgerEntry>;
}

function emptyLedger(): Ledger {
  return { schema_version: LEDGER_SCHEMA_VERSION, routes: {} };
}

/** Read the ledger; a fresh empty ledger on missing / corrupt / version mismatch. */
function loadLedger(stateDir: string): Ledger {
  const path = ledgerPath(stateDir);
  if (!existsSync(path)) {
    return emptyLedger();
  }
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
      const parsed = parseEntry(entry);
      if (parsed) {
        routes[id] = parsed;
      }
    }
  }
  return { schema_version: LEDGER_SCHEMA_VERSION, routes };
}

function parseEntry(entry: unknown): LedgerEntry | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return null;
  }
  const e = entry as { reservations?: unknown; last_selected_at?: unknown };
  const reservations = Array.isArray(e.reservations)
    ? e.reservations.filter(
        (t): t is number => typeof t === "number" && Number.isFinite(t),
      )
    : [];
  const last =
    typeof e.last_selected_at === "number" &&
    Number.isFinite(e.last_selected_at)
      ? e.last_selected_at
      : Number.NEGATIVE_INFINITY;
  return { reservations, last_selected_at: last };
}

/**
 * Prune the ledger to a bounded, current state: drop each entry's reservations
 * older than the TTL (a lapsed reservation never hardens into a claim) and cap
 * the per-route reservation list. Entry recency (`last_selected_at`) is retained
 * so the LRU tie-break stays fair after a reservation lapses; boundedness comes
 * from capping the total route count and evicting the least-recently-selected.
 */
function pruneLedger(ledger: Ledger, nowMs: number): Ledger {
  const cutoff = nowMs - RESERVATION_TTL_MS;
  const routes: Record<string, LedgerEntry> = {};
  for (const [id, entry] of Object.entries(ledger.routes)) {
    const live = entry.reservations
      .filter((t) => t > cutoff)
      .slice(-MAX_RESERVATIONS_PER_ROUTE);
    routes[id] = {
      reservations: live,
      last_selected_at: entry.last_selected_at,
    };
  }
  const ids = Object.keys(routes);
  if (ids.length > MAX_LEDGER_ROUTES) {
    // Evict the least-recently-selected entries down to the cap.
    const evict = ids
      .sort((a, b) => routes[a].last_selected_at - routes[b].last_selected_at)
      .slice(0, ids.length - MAX_LEDGER_ROUTES);
    for (const id of evict) {
      delete routes[id];
    }
  }
  return { schema_version: LEDGER_SCHEMA_VERSION, routes };
}

/** Add one reservation on `id` and stamp it least-recently-used-newest. */
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

/**
 * Atomically replace the ledger: write a same-dir tmpfile, then `rename` over the
 * target. `-Infinity` last_selected_at is serialized as `null` (JSON has no
 * Infinity) and read back as epoch-oldest, so a never-selected route stays
 * catch-up-eligible across a round-trip.
 */
function writeLedger(stateDir: string, ledger: Ledger): void {
  const path = ledgerPath(stateDir);
  const serializable = {
    schema_version: ledger.schema_version,
    routes: Object.fromEntries(
      Object.entries(ledger.routes).map(([id, e]) => [
        id,
        {
          reservations: e.reservations,
          last_selected_at: Number.isFinite(e.last_selected_at)
            ? e.last_selected_at
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
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    throw err;
  }
  renameSync(tmp, path);
}

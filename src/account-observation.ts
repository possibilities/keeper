/**
 * The normalized Capacity-observation contract plus the strict parsers for the
 * two public provider payloads (CodexBar usage JSON, `cswap list --json`) and the
 * atomic, PII-free observation sidecar.
 *
 * DB-free island: `node:*` + this module's own `src/account-routing-config.ts`
 * knobs only, never `src/db.ts`. Everything is pure over its inputs — the
 * observer injects the raw command outcomes and the cycle instant; nothing here
 * spawns a process, reads wall-clock, or touches the network.
 *
 * **Provider roles, deliberately asymmetric.** Claude CodexBar observes the
 * ambient Claude account and GATES automatic balancing. Codex CodexBar supplies
 * PII-free quota capacity for foreground Codex policy but never a route.
 * claude-swap remains authoritative for managed Claude inventory, launchability,
 * quota windows, and freshness.
 *
 * **PII containment.** Both parsers drop email, organization, credential paths,
 * identity blocks, and tokens at the boundary. The normalized shapes carry only
 * route metadata, quota windows, reset-credit count, health, and measurement
 * instants, so the sidecar and every log line are credential-free by construction.
 *
 * **Unknown is not zero.** A stale, malformed, expired, signed-out, API-key-only,
 * or otherwise unrouteable candidate is EXCLUDED, never coerced to spare capacity.
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
  MAX_JSON_DEPTH,
  MAX_NOTE_LENGTH,
  MAX_OBSERVATION_NOTES,
  MAX_OUTPUT_BYTES,
  managedRouteId,
  NATIVE_ROUTE_ID,
  OBSERVATION_FRESHNESS_CEILING_MS,
  OBSERVATION_SCHEMA_VERSION,
} from "./account-routing-config";

// ---------- normalized contracts -------------------------------------------

/**
 * One normalized quota window. `key` is a stable, PII-free window name —
 * `"session"` / `"week"` / `"spend"` for account-wide windows, `"model:<name>"`
 * for a per-model scoped window. `utilization` is the fraction consumed in
 * `[0,1]` (higher = more used, less headroom). `resetsAt` is the tz-aware reset
 * instant when trustworthy, else `null` (a naive/absent stamp gets no rollover
 * grace).
 */
export interface NormalizedWindow {
  key: string;
  utilization: number;
  resetsAt: string | null;
}

/** `native` = the ambient default Claude account; `managed` = a claude-swap slot. */
export type RouteKind = "native" | "managed";

/**
 * A routeable candidate. `id` is the stable PII-free identifier the router scores,
 * reserves against, and (later) attributes a launch to — never an email or org.
 * `windows` is empty only for a candidate that should be excluded before scoring.
 * `measuredAtMs` is the epoch-ms freshness of the underlying measurement, or
 * `null` when the provider supplied no age.
 */
export interface Route {
  id: string;
  kind: RouteKind;
  slot: number | null;
  windows: NormalizedWindow[];
  measuredAtMs: number | null;
}

/**
 * The CodexBar health gate. Automatic balancing is enabled ONLY on `"ok"`; every
 * other value means no balancing and a native default launch.
 *  - `ok` — CodexBar ran and returned parseable ambient-account capacity.
 *  - `absent` — CodexBar is not installed / the provider binary is missing.
 *  - `stale` — the observation aged past the freshness ceiling.
 *  - `malformed` — CodexBar ran but its output failed strict parsing.
 *  - `unsupported` — CodexBar output parsed but carried no capacity we understand.
 *  - `error` — CodexBar ran and reported a failure (timeout / unexpected exit).
 */
export type ObservationHealth =
  | "ok"
  | "absent"
  | "stale"
  | "malformed"
  | "unsupported"
  | "error";

/**
 * The latest validated Capacity observation — the observer's sole durable output
 * and the router's sole input. Transient launch advice, never event-sourced
 * domain truth: it is replaced in place each cycle and retains no history.
 */
export interface Observation {
  schema_version: number;
  /** Exact CodexBar generation used for this observation, or null when unknown. */
  codexbar_binary_sha256: string | null;
  /** Epoch ms the observer produced this observation. Drives the staleness gate. */
  observed_at_ms: number;
  /** The Claude CodexBar gate. Selection is disabled unless this is `"ok"`. */
  health: ObservationHealth;
  /** PII-free Codex quota capacity; never a route or identity. */
  codex: CodexCapacityObservation;
  /** Native default + every routeable managed candidate. */
  routes: Route[];
  /**
   * PII-free display metadata from the ordered public claude-swap inventory.
   * Optional so an older schema-v2 sidecar safely renders no account label.
   */
  claude_accounts?: ClaudeAccountDisplay;
  /** Bounded, PII-free diagnostics (excluded rows, parser rejections). */
  notes: string[];
}

/** Ordered claude-swap inventory metadata used only for concise display labels. */
export interface ClaudeAccountDisplay {
  /** Number of unique, valid account slots in the public inventory. */
  count: number;
  /** Route id → zero-based inventory position; `default` aliases the active slot. */
  ordinals: Record<string, number>;
  /**
   * Whether cswap reports the active/native account as currently routeable.
   * Optional only for compatibility with sidecars written before explicit
   * account selection; a missing value is never trusted for a request.
   */
  active_routeable?: boolean;
}

// ---------- provider run outcomes ------------------------------------------

/**
 * One provider CLI invocation's result, as the observer's bounded runner reports
 * it. `code` is `null` when the CLI could not be run at all (binary missing,
 * spawn failure, or a deadline force-kill); otherwise the process exit code.
 * `stdout` is the captured, byte-capped standard output.
 */
export type ProviderRunFailure = "timeout" | "spawn" | "authorization-required";

export interface ProviderRunOutcome {
  code: number | null;
  stdout: string;
  /** PII-free process classification; parsers continue to key on code/stdout. */
  failure?: ProviderRunFailure;
  /** Exact executable digest when a generation-binding runner supplied it. */
  binary_sha256?: string;
}

/** One normalized CodexBar provider result. */
export interface CodexBarObservation {
  health: ObservationHealth;
  windows: NormalizedWindow[];
  notes: string[];
}

/** PII-free Codex capacity retained in the shared sidecar. */
export interface CodexCapacityObservation extends CodexBarObservation {
  /** Available Full reset credits, only when CodexBar supplied a finite number. */
  resetCreditsAvailableCount: number | null;
}

/** The claude-swap half of an observation cycle. */
export interface CswapInventory {
  routes: Route[];
  /** The active (ambient) managed slot, deduplicated against the native route. */
  activeSlot: number | null;
  /**
   * Every unique valid slot's zero-based position in `accounts` order, including
   * active and temporarily unrouteable rows. Optional for source compatibility
   * with callers constructing an empty inventory.
   */
  accountOrdinals?: Record<string, number>;
  /** Whether the active slot passed the same launchability checks as managed rows. */
  activeRouteable?: boolean;
  notes: string[];
}

// ---------- small shared helpers -------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Normalize a raw percent; strict callers reject rather than clamp bad input. */
function utilizationFromPercent(
  raw: unknown,
  strictRange = false,
): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return null;
  }
  if (strictRange && (raw < 0 || raw > 100)) {
    return null;
  }
  return Math.max(0, Math.min(1, raw / 100));
}

/**
 * True iff an ISO 8601 stamp carries an explicit timezone (`Z` or a `±HH:MM` /
 * `±HHMM` offset). A naive stamp is rejected so a reset/measurement instant is
 * never silently read as local time.
 */
function hasTimezone(stamp: string): boolean {
  if (stamp.endsWith("Z") || stamp.endsWith("z")) {
    return true;
  }
  const t = stamp.indexOf("T");
  const timePart = t >= 0 ? stamp.slice(t + 1) : stamp;
  return /[+-]\d{2}:?\d{2}$/.test(timePart);
}

/** A tz-aware reset stamp verbatim, or `null` (a naive/absent stamp gets no grace). */
function trustworthyResetsAt(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || !hasTimezone(raw)) {
    return null;
  }
  return raw;
}

/** Parse a tz-aware ISO stamp to epoch ms, or `null` (naive / unparseable). */
function tzAwareEpochMs(raw: unknown): number | null {
  if (typeof raw !== "string" || !hasTimezone(raw)) {
    return null;
  }
  const t = new Date(raw).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Recursive depth guard — true when `value` nests deeper than `max`. */
function exceedsDepth(value: unknown, max: number): boolean {
  const walk = (v: unknown, depth: number): boolean => {
    if (depth > max) {
      return true;
    }
    if (Array.isArray(v)) {
      return v.some((e) => walk(e, depth + 1));
    }
    if (isRecord(v)) {
      return Object.values(v).some((e) => walk(e, depth + 1));
    }
    return false;
  };
  return walk(value, 0);
}

/**
 * Parse a byte-capped, depth-bounded JSON payload. Returns the parsed value, or
 * `null` on: over-cap output, a JSON syntax error, or over-depth nesting — every
 * "the payload is unbounded or hostile" case folds to one rejection.
 */
function parseBoundedJson(stdout: string): unknown | null {
  if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (exceedsDepth(value, MAX_JSON_DEPTH)) {
    return null;
  }
  return value;
}

// ---------- CodexBar parser ------------------------------------------------

/**
 * CodexBar exit taxonomy (from its `docs/cli.md`): `2` = provider binary missing
 * (treated as absent, same as an un-runnable CLI); `3` = parse/format error; `4`
 * = CLI timeout; `1` = unexpected failure. A `null` code is an un-runnable CLI.
 * Only `0` reaches the payload parse.
 */
export function parseCodexBar(
  outcome: ProviderRunOutcome,
): CodexBarObservation {
  const { code, stdout } = outcome;
  if (code === null || code === 2) {
    return { health: "absent", windows: [], notes: ["codexbar: unavailable"] };
  }
  if (code !== 0) {
    return {
      health: "error",
      windows: [],
      notes: [`codexbar: exit ${code}`],
    };
  }
  const parsed = parseBoundedJson(stdout);
  if (parsed === null) {
    return {
      health: "malformed",
      windows: [],
      notes: ["codexbar: malformed json"],
    };
  }
  const payload = unwrapCodexBarPayload(parsed);
  if (!payload) {
    return {
      health: "unsupported",
      windows: [],
      notes: ["codexbar: expected one object"],
    };
  }
  if (payload.provider !== "claude") {
    return {
      health: "unsupported",
      windows: [],
      notes: ["codexbar: provider mismatch"],
    };
  }
  const usage = payload.usage;
  if (!isRecord(usage)) {
    return {
      health: "unsupported",
      windows: [],
      notes: ["codexbar: no usage block"],
    };
  }
  const windows = parseCodexBarWindows(usage);
  if (windows.length === 0) {
    // A payload we cannot extract any capacity from is unsupported — gating on
    // capacity we do not understand would be worse than falling back.
    return {
      health: "unsupported",
      windows: [],
      notes: ["codexbar: no parseable windows"],
    };
  }
  return { health: "ok", windows, notes: [] };
}

/**
 * Extract the account-wide windows CodexBar documents: `usage.primary` (the
 * ~5-hour session window) → `"session"`, `usage.secondary` (the ~7-day weekly
 * window) → `"week"`, `usage.tertiary` → `"tertiary"` when present. Only the
 * documented fields are read — a machine boundary is never guessed at.
 */
function parseCodexBarWindows(
  usage: Record<string, unknown>,
): NormalizedWindow[] {
  const out: NormalizedWindow[] = [];
  const add = (raw: unknown, key: string): void => {
    const window = parseCodexBarWindow(raw, key);
    if (window) out.push(window);
  };
  add(usage.primary, "session");
  add(usage.secondary, "week");
  add(usage.tertiary, "tertiary");
  return out;
}

function parseCodexBarWindow(
  raw: unknown,
  key: string,
  strictRange = false,
): NormalizedWindow | null {
  if (!isRecord(raw)) return null;
  const utilization = utilizationFromPercent(raw.usedPercent, strictRange);
  if (utilization === null) return null;
  return { key, utilization, resetsAt: trustworthyResetsAt(raw.resetsAt) };
}

/** Accept CodexBar's legacy object or its real, exactly-one-element array. */
function unwrapCodexBarPayload(
  parsed: unknown,
): Record<string, unknown> | null {
  if (isRecord(parsed)) return parsed;
  if (Array.isArray(parsed) && parsed.length === 1 && isRecord(parsed[0])) {
    return parsed[0];
  }
  return null;
}

/** Strictly parse CodexBar's Codex provider capacity and Full reset credits. */
export function parseCodexBarCodex(
  outcome: ProviderRunOutcome,
): CodexCapacityObservation {
  const empty = (
    health: ObservationHealth,
    note: string,
  ): CodexCapacityObservation => ({
    health,
    windows: [],
    resetCreditsAvailableCount: null,
    notes: [note],
  });
  if (outcome.code === null || outcome.code === 2) {
    return empty("absent", "codexbar-codex: unavailable");
  }
  if (outcome.code !== 0) {
    return empty("error", `codexbar-codex: exit ${outcome.code}`);
  }
  const parsed = parseBoundedJson(outcome.stdout);
  if (parsed === null) {
    return empty("malformed", "codexbar-codex: malformed json");
  }
  const payload = unwrapCodexBarPayload(parsed);
  if (!payload) {
    return empty("unsupported", "codexbar-codex: expected one object");
  }
  if (payload.provider !== "codex") {
    return empty("unsupported", "codexbar-codex: provider mismatch");
  }
  if (!isRecord(payload.usage)) {
    return empty("unsupported", "codexbar-codex: no usage block");
  }
  const week = parseCodexBarWindow(payload.usage.secondary, "week", true);
  const credits = payload.usage.codexResetCredits;
  const availableCount =
    isRecord(credits) &&
    typeof credits.availableCount === "number" &&
    Number.isInteger(credits.availableCount) &&
    credits.availableCount >= 0
      ? credits.availableCount
      : null;
  if (!week) {
    const result = empty("unsupported", "codexbar-codex: no weekly window");
    result.resetCreditsAvailableCount = availableCount;
    return result;
  }
  return {
    health: "ok",
    windows: [week],
    resetCreditsAvailableCount: availableCount,
    notes: [],
  };
}

// ---------- claude-swap parser ---------------------------------------------

/**
 * The claude-swap `usageStatus` values a launchable, quota-bearing account can
 * carry. Only `"ok"` is routeable: every other status (`token_expired`,
 * `api_key`, `keychain_unavailable`, `relogin_required`, `no_credentials`,
 * `unavailable`) marks an account that is signed-out, expired, API-key-only, or
 * otherwise unlaunchable — excluded rather than coerced to spare capacity.
 */
const CSWAP_ROUTEABLE_STATUS = "ok";

/**
 * Parse `cswap list --json`. Never surfaces an error to the caller — a missing,
 * errored, unsupported-schema, or malformed inventory simply yields no managed
 * routes (the native default remains). Excludes unlaunchable, stale, and
 * active-slot rows; the active slot is the ambient account the native route
 * already represents, so it must not appear as duplicate capacity.
 */
export function parseCswapList(
  outcome: ProviderRunOutcome,
  nowMs: number,
  freshnessCeilingMs: number,
): CswapInventory {
  const { code, stdout } = outcome;
  if (code === null) {
    return {
      routes: [],
      activeSlot: null,
      accountOrdinals: {},
      activeRouteable: false,
      notes: ["cswap: unavailable"],
    };
  }
  const parsed = parseBoundedJson(stdout);
  if (parsed === null || !isRecord(parsed)) {
    return {
      routes: [],
      activeSlot: null,
      accountOrdinals: {},
      activeRouteable: false,
      notes: ["cswap: malformed json"],
    };
  }
  // A handled claude-swap failure prints `{schemaVersion, error}` and exits
  // non-zero; either way there is no inventory to route on.
  if (isRecord(parsed.error) || code !== 0) {
    return {
      routes: [],
      activeSlot: null,
      accountOrdinals: {},
      activeRouteable: false,
      notes: ["cswap: reported error"],
    };
  }
  if (parsed.schemaVersion !== CSWAP_SUPPORTED_SCHEMA_MAJOR) {
    return {
      routes: [],
      activeSlot: null,
      accountOrdinals: {},
      activeRouteable: false,
      notes: [`cswap: unsupported schema ${String(parsed.schemaVersion)}`],
    };
  }
  const accounts = parsed.accounts;
  if (!Array.isArray(accounts)) {
    return {
      routes: [],
      activeSlot: null,
      accountOrdinals: {},
      activeRouteable: false,
      notes: ["cswap: no accounts array"],
    };
  }
  const activeSlot =
    typeof parsed.activeAccountNumber === "number" &&
    Number.isInteger(parsed.activeAccountNumber)
      ? parsed.activeAccountNumber
      : null;

  const routes: Route[] = [];
  const notes: string[] = [];
  const seenRoutes = new Set<number>();
  const seenAccounts = new Set<number>();
  const accountOrdinals: Record<string, number> = {};
  let activeRouteable = false;
  for (const row of accounts) {
    // Inventory order, not slot arithmetic, defines the human-facing c<N>
    // label. Retain valid rows even when they are active, stale, or otherwise
    // unrouteable so a transient usage state cannot renumber every account.
    if (isRecord(row)) {
      const slot = row.number;
      if (
        typeof slot === "number" &&
        Number.isInteger(slot) &&
        slot > 0 &&
        !seenAccounts.has(slot)
      ) {
        seenAccounts.add(slot);
        accountOrdinals[managedRouteId(slot)] = seenAccounts.size - 1;
      }
    }
    const parsedRow = parseCswapAccount(row, nowMs, freshnessCeilingMs);
    if (parsedRow.note) {
      notes.push(parsedRow.note);
    }
    if (parsedRow.route) {
      const slot = parsedRow.route.slot as number;
      if (activeSlot !== null && slot === activeSlot) {
        activeRouteable = true;
        notes.push(`cswap: slot ${slot} is active (deduped to native)`);
      } else if (!seenRoutes.has(slot)) {
        seenRoutes.add(slot);
        routes.push(parsedRow.route);
      }
    }
  }
  return { routes, activeSlot, accountOrdinals, activeRouteable, notes };
}

/**
 * Parse one claude-swap account row into a managed {@link Route}, or an exclusion
 * with a PII-free note. Applies, in order: valid positive slot, routeable status,
 * freshness ceiling, and non-empty normalized windows. The caller deduplicates a
 * successfully parsed active slot to native while retaining its routeability.
 */
function parseCswapAccount(
  row: unknown,
  nowMs: number,
  freshnessCeilingMs: number,
): { route?: Route; note?: string } {
  if (!isRecord(row)) {
    return { note: "cswap: non-object row" };
  }
  const slot = row.number;
  if (typeof slot !== "number" || !Number.isInteger(slot) || slot <= 0) {
    return { note: "cswap: invalid slot" };
  }
  if (row.usageStatus !== CSWAP_ROUTEABLE_STATUS) {
    return {
      note: `cswap: slot ${slot} not routeable (${String(row.usageStatus)})`,
    };
  }
  const measuredAtMs = cswapMeasuredAtMs(row, nowMs);
  if (measuredAtMs !== null && nowMs - measuredAtMs > freshnessCeilingMs) {
    return { note: `cswap: slot ${slot} measurement stale` };
  }
  const windows = parseCswapWindows(row.usage);
  if (windows.length === 0) {
    return { note: `cswap: slot ${slot} has no windows` };
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

/**
 * Derive a managed row's measurement instant (epoch ms): the tz-aware
 * `usageFetchedAt` when present, else `nowMs - usageAgeSeconds*1000`, else `null`
 * (no freshness signal — trusted as fresh, since claude-swap only serves an `ok`
 * row from its own last-good cache).
 */
function cswapMeasuredAtMs(
  row: Record<string, unknown>,
  nowMs: number,
): number | null {
  const fetched = tzAwareEpochMs(row.usageFetchedAt);
  if (fetched !== null) {
    return fetched;
  }
  const age = row.usageAgeSeconds;
  if (typeof age === "number" && Number.isFinite(age) && age >= 0) {
    return nowMs - age * 1000;
  }
  return null;
}

/**
 * Normalize a claude-swap `usage` block: `fiveHour` → `"session"`, `sevenDay` →
 * `"week"`, `spend` → `"spend"`, and each `scoped[]` entry → `"model:<name>"`.
 * Each window reads its `pct` (percent used) into a `[0,1]` utilization. A window
 * whose `pct` is absent/non-numeric is dropped (unknown, not zero).
 */
function parseCswapWindows(usage: unknown): NormalizedWindow[] {
  if (!isRecord(usage)) {
    return [];
  }
  const out: NormalizedWindow[] = [];
  const add = (raw: unknown, key: string): void => {
    if (!isRecord(raw)) {
      return;
    }
    const utilization = utilizationFromPercent(raw.pct);
    if (utilization === null) {
      return;
    }
    out.push({ key, utilization, resetsAt: trustworthyResetsAt(raw.resetsAt) });
  };
  add(usage.fiveHour, "session");
  add(usage.sevenDay, "week");
  add(usage.spend, "spend");
  if (Array.isArray(usage.scoped)) {
    for (const entry of usage.scoped) {
      if (
        isRecord(entry) &&
        typeof entry.name === "string" &&
        entry.name.length > 0
      ) {
        add(entry, `model:${entry.name}`);
      }
    }
  }
  return out;
}

// ---------- observation assembly -------------------------------------------

/** Cap + truncate the PII-free diagnostic notes so the sidecar stays bounded. */
function boundNotes(notes: string[]): string[] {
  return notes
    .slice(0, MAX_OBSERVATION_NOTES)
    .map((n) => (n.length > MAX_NOTE_LENGTH ? n.slice(0, MAX_NOTE_LENGTH) : n));
}

/**
 * Assemble the normalized {@link Observation} from the two provider halves. The
 * native default route always exists (carrying CodexBar's ambient windows when
 * healthy, empty otherwise); managed routes follow. Health mirrors the CodexBar
 * gate — the router disables selection on any non-`ok` value regardless of what
 * managed inventory happens to be present.
 */
export function buildObservation(input: {
  observedAtMs: number;
  codexbarBinarySha256?: string | null;
  /** Claude provider result retained under the legacy name for compatibility. */
  codex: CodexBarObservation;
  codexCapacity?: CodexCapacityObservation;
  cswap: CswapInventory;
}): Observation {
  const { observedAtMs, codex, cswap } = input;
  const codexCapacity = input.codexCapacity ?? {
    health: "absent" as const,
    windows: [],
    resetCreditsAvailableCount: null,
    notes: ["codexbar-codex: not observed"],
  };
  const nativeRoute: Route = {
    id: NATIVE_ROUTE_ID,
    kind: "native",
    slot: null,
    windows: codex.health === "ok" ? codex.windows : [],
    measuredAtMs: observedAtMs,
  };
  const inventoryOrdinals = cswap.accountOrdinals ?? {};
  const displayOrdinals = { ...inventoryOrdinals };
  if (cswap.activeSlot !== null) {
    const activeOrdinal = inventoryOrdinals[managedRouteId(cswap.activeSlot)];
    if (activeOrdinal !== undefined) {
      // The native route is the active claude-swap account, so both route ids
      // intentionally resolve to the same display ordinal.
      displayOrdinals[NATIVE_ROUTE_ID] = activeOrdinal;
    }
  }
  return {
    schema_version: OBSERVATION_SCHEMA_VERSION,
    codexbar_binary_sha256: input.codexbarBinarySha256 ?? null,
    observed_at_ms: observedAtMs,
    health: codex.health,
    codex: {
      health: codexCapacity.health,
      windows: codexCapacity.windows,
      resetCreditsAvailableCount: codexCapacity.resetCreditsAvailableCount,
      notes: boundNotes(codexCapacity.notes),
    },
    routes: [nativeRoute, ...cswap.routes],
    claude_accounts: {
      count: Object.keys(inventoryOrdinals).length,
      ordinals: displayOrdinals,
      active_routeable: cswap.activeRouteable ?? false,
    },
    notes: boundNotes([...codex.notes, ...codexCapacity.notes, ...cswap.notes]),
  };
}

// ---------- sidecar I/O ----------------------------------------------------

/** Canonical sidecar serialization — pretty JSON + trailing newline. */
export function serializeObservation(obs: Observation): string {
  return `${JSON.stringify(obs, null, 2)}\n`;
}

/**
 * Atomically publish the observation to `path` with user-only (0600) permissions:
 * write a same-dir tmpfile opened `0o600`, then `rename` over the target. The
 * caller ensures the directory exists. A single sidecar — no history is retained.
 */
export function writeObservationSidecar(path: string, obs: Observation): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, serializeObservation(obs));
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

/**
 * Read + validate the observation sidecar. Returns `null` on missing, corrupt,
 * over-cap, unsupported-version, or shape-invalid content, so every failure path
 * folds to "no observation" (the router then serves the native default). Never
 * throws.
 */
export function readObservationSidecar(path: string): Observation | null {
  if (!existsSync(path)) {
    return null;
  }
  let data: unknown;
  try {
    data = parseBoundedJson(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  return validateObservation(data);
}

/** Structural validation of a decoded sidecar → a typed Observation or `null`. */
export function validateObservation(data: unknown): Observation | null {
  if (!isRecord(data)) {
    return null;
  }
  if (data.schema_version !== OBSERVATION_SCHEMA_VERSION) {
    return null;
  }
  if (
    (data.codexbar_binary_sha256 !== null &&
      (typeof data.codexbar_binary_sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(data.codexbar_binary_sha256))) ||
    typeof data.observed_at_ms !== "number" ||
    !Number.isFinite(data.observed_at_ms)
  ) {
    return null;
  }
  if (!isObservationHealth(data.health)) {
    return null;
  }
  const codex = validateCodexCapacity(data.codex);
  if (!codex || !Array.isArray(data.routes)) {
    return null;
  }
  let claudeAccounts: ClaudeAccountDisplay | undefined;
  if (data.claude_accounts !== undefined) {
    const validated = validateClaudeAccountDisplay(data.claude_accounts);
    if (validated === null) {
      return null;
    }
    claudeAccounts = validated;
  }
  const routes: Route[] = [];
  for (const r of data.routes) {
    const route = validateRoute(r);
    if (route) {
      routes.push(route);
    }
  }
  const notes = Array.isArray(data.notes)
    ? data.notes.filter((n): n is string => typeof n === "string")
    : [];
  return {
    schema_version: OBSERVATION_SCHEMA_VERSION,
    codexbar_binary_sha256: data.codexbar_binary_sha256,
    observed_at_ms: data.observed_at_ms,
    health: data.health,
    codex,
    routes,
    ...(claudeAccounts === undefined
      ? {}
      : { claude_accounts: claudeAccounts }),
    notes,
  };
}

function validateClaudeAccountDisplay(
  data: unknown,
): ClaudeAccountDisplay | null {
  if (
    !isRecord(data) ||
    typeof data.count !== "number" ||
    !Number.isInteger(data.count) ||
    data.count < 0 ||
    !isRecord(data.ordinals)
  ) {
    return null;
  }
  const ordinals: Record<string, number> = {};
  const inventoryOrdinals = new Set<number>();
  for (const [routeId, ordinal] of Object.entries(data.ordinals)) {
    const isInventoryRoute = /^claude-swap:[1-9]\d*$/.test(routeId);
    if (
      (routeId !== NATIVE_ROUTE_ID && !isInventoryRoute) ||
      typeof ordinal !== "number" ||
      !Number.isInteger(ordinal) ||
      ordinal < 0 ||
      ordinal >= data.count ||
      (isInventoryRoute && inventoryOrdinals.has(ordinal))
    ) {
      return null;
    }
    if (isInventoryRoute) {
      inventoryOrdinals.add(ordinal);
    }
    ordinals[routeId] = ordinal;
  }
  // Every inventory position must be represented exactly once. `default` may
  // duplicate one position because it aliases the active managed account.
  if (inventoryOrdinals.size !== data.count) {
    return null;
  }
  for (let ordinal = 0; ordinal < data.count; ordinal += 1) {
    if (!inventoryOrdinals.has(ordinal)) {
      return null;
    }
  }
  const activeRouteable = data.active_routeable;
  if (activeRouteable !== undefined && typeof activeRouteable !== "boolean") {
    return null;
  }
  return {
    count: data.count,
    ordinals,
    ...(activeRouteable === undefined
      ? {}
      : { active_routeable: activeRouteable }),
  };
}

function isObservationHealth(v: unknown): v is ObservationHealth {
  return (
    v === "ok" ||
    v === "absent" ||
    v === "stale" ||
    v === "malformed" ||
    v === "unsupported" ||
    v === "error"
  );
}

function validateCodexCapacity(data: unknown): CodexCapacityObservation | null {
  if (!isRecord(data) || !isObservationHealth(data.health)) return null;
  if (!Array.isArray(data.windows)) return null;
  const windows: NormalizedWindow[] = [];
  for (const raw of data.windows) {
    const window = validateWindow(raw, true);
    if (!window) return null;
    windows.push(window);
  }
  const count = data.resetCreditsAvailableCount;
  if (
    count !== null &&
    (typeof count !== "number" || !Number.isInteger(count) || count < 0)
  ) {
    return null;
  }
  const notes = Array.isArray(data.notes)
    ? data.notes.filter((n): n is string => typeof n === "string")
    : [];
  return {
    health: data.health,
    windows,
    resetCreditsAvailableCount: count,
    notes,
  };
}

function validateWindow(
  w: unknown,
  strictRange = false,
): NormalizedWindow | null {
  if (
    !isRecord(w) ||
    typeof w.key !== "string" ||
    typeof w.utilization !== "number" ||
    !Number.isFinite(w.utilization) ||
    (strictRange && (w.utilization < 0 || w.utilization > 1))
  ) {
    return null;
  }
  return {
    key: w.key,
    utilization: Math.max(0, Math.min(1, w.utilization)),
    resetsAt: typeof w.resetsAt === "string" ? w.resetsAt : null,
  };
}

function validateRoute(r: unknown): Route | null {
  if (!isRecord(r)) {
    return null;
  }
  if (typeof r.id !== "string" || r.id.length === 0) {
    return null;
  }
  if (r.kind !== "native" && r.kind !== "managed") {
    return null;
  }
  const slot =
    typeof r.slot === "number" && Number.isInteger(r.slot) ? r.slot : null;
  const windows: NormalizedWindow[] = [];
  if (Array.isArray(r.windows)) {
    for (const w of r.windows) {
      const window = validateWindow(w);
      if (window) windows.push(window);
    }
  }
  const measuredAtMs =
    typeof r.measuredAtMs === "number" && Number.isFinite(r.measuredAtMs)
      ? r.measuredAtMs
      : null;
  return { id: r.id, kind: r.kind, slot, windows, measuredAtMs };
}

/** True iff `obs` is not future-dated and is within the caller's max age. */
export function isObservationFresh(
  obs: Observation,
  nowMs: number,
  maxAgeMs: number = OBSERVATION_FRESHNESS_CEILING_MS,
): boolean {
  const ageMs = nowMs - obs.observed_at_ms;
  return ageMs >= 0 && maxAgeMs >= 0 && ageMs <= maxAgeMs;
}

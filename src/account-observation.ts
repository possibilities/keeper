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
 * **Two provider roles, deliberately asymmetric.** CodexBar observes the AMBIENT
 * Claude account and GATES automatic balancing: a healthy CodexBar observation
 * both enables selection and contributes the native default route's capacity. It
 * never supplies managed rows — its ordinary provider payload is not the app-only
 * claude-swap projection. claude-swap is authoritative for managed-account
 * inventory, launchability, quota windows, and freshness.
 *
 * **PII containment.** Both parsers drop email, organization, credential paths,
 * identity blocks, and tokens at the boundary. The normalized shapes carry only a
 * stable route id, its slot, its normalized windows, and a measurement instant —
 * so the sidecar and every log line are credential-free by construction.
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
  /** Epoch ms the observer produced this observation. Drives the staleness gate. */
  observed_at_ms: number;
  /** The CodexBar gate. Selection is disabled unless this is `"ok"`. */
  health: ObservationHealth;
  /** Native default + every routeable managed candidate. */
  routes: Route[];
  /** Bounded, PII-free diagnostics (excluded rows, parser rejections). */
  notes: string[];
}

// ---------- provider run outcomes ------------------------------------------

/**
 * One provider CLI invocation's result, as the observer's bounded runner reports
 * it. `code` is `null` when the CLI could not be run at all (binary missing,
 * spawn failure, or a deadline force-kill); otherwise the process exit code.
 * `stdout` is the captured, byte-capped standard output.
 */
export interface ProviderRunOutcome {
  code: number | null;
  stdout: string;
}

/** The CodexBar half of an observation cycle. */
export interface CodexBarObservation {
  health: ObservationHealth;
  windows: NormalizedWindow[];
  notes: string[];
}

/** The claude-swap half of an observation cycle. */
export interface CswapInventory {
  routes: Route[];
  /** The active (ambient) managed slot, deduplicated against the native route. */
  activeSlot: number | null;
  notes: string[];
}

// ---------- small shared helpers -------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Clamp a raw percent (0..100) to a `[0,1]` utilization fraction; NaN → null. */
function utilizationFromPercent(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
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
  if (!isRecord(parsed)) {
    return {
      health: "unsupported",
      windows: [],
      notes: ["codexbar: non-object payload"],
    };
  }
  const usage = parsed.usage;
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
    if (!isRecord(raw)) {
      return;
    }
    const utilization = utilizationFromPercent(raw.usedPercent);
    if (utilization === null) {
      return;
    }
    out.push({ key, utilization, resetsAt: trustworthyResetsAt(raw.resetsAt) });
  };
  add(usage.primary, "session");
  add(usage.secondary, "week");
  add(usage.tertiary, "tertiary");
  return out;
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
    return { routes: [], activeSlot: null, notes: ["cswap: unavailable"] };
  }
  const parsed = parseBoundedJson(stdout);
  if (parsed === null || !isRecord(parsed)) {
    return { routes: [], activeSlot: null, notes: ["cswap: malformed json"] };
  }
  // A handled claude-swap failure prints `{schemaVersion, error}` and exits
  // non-zero; either way there is no inventory to route on.
  if (isRecord(parsed.error) || code !== 0) {
    return { routes: [], activeSlot: null, notes: ["cswap: reported error"] };
  }
  if (parsed.schemaVersion !== CSWAP_SUPPORTED_SCHEMA_MAJOR) {
    return {
      routes: [],
      activeSlot: null,
      notes: [`cswap: unsupported schema ${String(parsed.schemaVersion)}`],
    };
  }
  const accounts = parsed.accounts;
  if (!Array.isArray(accounts)) {
    return {
      routes: [],
      activeSlot: null,
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
  const seen = new Set<number>();
  for (const row of accounts) {
    const parsedRow = parseCswapAccount(
      row,
      activeSlot,
      nowMs,
      freshnessCeilingMs,
    );
    if (parsedRow.note) {
      notes.push(parsedRow.note);
    }
    if (parsedRow.route && !seen.has(parsedRow.route.slot as number)) {
      seen.add(parsedRow.route.slot as number);
      routes.push(parsedRow.route);
    }
  }
  return { routes, activeSlot, notes };
}

/**
 * Parse one claude-swap account row into a managed {@link Route}, or an exclusion
 * with a PII-free note. Applies, in order: valid positive slot, active-slot
 * dedup, routeable status, freshness ceiling, and non-empty normalized windows.
 */
function parseCswapAccount(
  row: unknown,
  activeSlot: number | null,
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
  if (activeSlot !== null && slot === activeSlot) {
    // The active managed slot IS the ambient account the native route covers —
    // never a second capacity row for the same account.
    return { note: `cswap: slot ${slot} is active (deduped to native)` };
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
  codex: CodexBarObservation;
  cswap: CswapInventory;
}): Observation {
  const { observedAtMs, codex, cswap } = input;
  const nativeRoute: Route = {
    id: NATIVE_ROUTE_ID,
    kind: "native",
    slot: null,
    windows: codex.health === "ok" ? codex.windows : [],
    measuredAtMs: observedAtMs,
  };
  return {
    schema_version: OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: observedAtMs,
    health: codex.health,
    routes: [nativeRoute, ...cswap.routes],
    notes: boundNotes([...codex.notes, ...cswap.notes]),
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
    typeof data.observed_at_ms !== "number" ||
    !Number.isFinite(data.observed_at_ms)
  ) {
    return null;
  }
  if (!isObservationHealth(data.health)) {
    return null;
  }
  if (!Array.isArray(data.routes)) {
    return null;
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
    observed_at_ms: data.observed_at_ms,
    health: data.health,
    routes,
    notes,
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
      if (
        isRecord(w) &&
        typeof w.key === "string" &&
        typeof w.utilization === "number" &&
        Number.isFinite(w.utilization)
      ) {
        windows.push({
          key: w.key,
          utilization: Math.max(0, Math.min(1, w.utilization)),
          resetsAt: typeof w.resetsAt === "string" ? w.resetsAt : null,
        });
      }
    }
  }
  const measuredAtMs =
    typeof r.measuredAtMs === "number" && Number.isFinite(r.measuredAtMs)
      ? r.measuredAtMs
      : null;
  return { id: r.id, kind: r.kind, slot, windows, measuredAtMs };
}

/** True iff `obs` is within the freshness ceiling relative to `nowMs`. */
export function isObservationFresh(obs: Observation, nowMs: number): boolean {
  return nowMs - obs.observed_at_ms <= OBSERVATION_FRESHNESS_CEILING_MS;
}

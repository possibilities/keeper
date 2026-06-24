/**
 * Profile picker — the client-side balancer the README's data contract feeds.
 *
 * Vendored from agentusage's `src/api.ts` (a 1:1 port). The producer scrapes each
 * account and writes `~/.local/state/agentusage/<id>.json` envelopes; this module
 * is a *consumer* — the dumb balancer the `keeper agent` launch path calls to
 * answer one question: **"which Claude profile should I use right now?"** The
 * Python `pick_profile` coexists on the same ledger until the launcher cutover
 * completes, so serialization, schema_version, lock ordering, and stamp shape are
 * all load-bearing cross-runtime invariants.
 *
 * DB-free leaf: imports only `node:fs`/`node:os`/`node:path` + the vendored
 * `src/usage-flock.ts`, never `src/db.ts`, so the `keeper agent` cold-start stays
 * cheap (the `cli/agent.ts` db-free discipline).
 *
 * Two public functions, both fail-open:
 *
 * - `pickProfile() -> string` — credit-weighted balance over subscribed
 *   accounts. Picks the eligible profile minimizing `count / (multiplier ×
 *   session headroom)` — stride scheduling — falling back to multiplier-only
 *   credit when every session window is burned. Never throws; every failure
 *   path returns `DEFAULT_PROFILE`. There is no stale filter: a stale-but-
 *   subscribed account still rotates.
 * - `listProfiles() -> string[]` — the configured Claude profile names; `[]`
 *   on missing / malformed config.
 *
 * `DEFAULT_PROFILE` ("default") is itself a real account id, so the fallback
 * and a legitimate pick are the same string.
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
import { homedir } from "node:os";
import { join } from "node:path";
import { FileLock } from "./usage-flock";

// Returned when no profile resolves. Also a real account id — the wrapper maps
// "default" onto the default Claude account.
export const DEFAULT_PROFILE = "default";

// Bumped when picker.json's shape changes. A file with an unrecognized version
// is treated as absent (start fresh) rather than migrated. Must match
// agentusage.api.PICKER_SCHEMA_VERSION for cross-runtime ledger compatibility.
export const PICKER_SCHEMA_VERSION = 1;

// Mirrors daemon.STATE_DIR / api.STATE_DIR. Deliberately NOT XDG_STATE_HOME —
// matches Python. Kept mutable behind a setter so tests (and `.3`'s
// `resolveUsageRoot()`) can redirect it.
let stateDir = join(homedir(), ".local", "state", "agentusage");

/** Test-only seam: redirect STATE_DIR (mirrors the Python `state_dir` fixture). */
export function setStateDir(dir: string): void {
  stateDir = dir;
}

/** Test-only seam: read the current STATE_DIR. */
export function getStateDir(): string {
  return stateDir;
}

// Injectable clock — `pickProfile`'s notion of "now". The Python suite uses a
// `_MonotonicClock` to defeat microsecond ties and pin `lift_at` comparisons;
// here a module-internal clock with a test-only setter provides the same DI
// seam without `mock.module` (which neither hoists nor auto-resets).
let nowFn: () => Date = () => new Date();

/** Test-only seam: pin the clock `pickProfile` reads. */
export function setClock(fn: () => Date): void {
  nowFn = fn;
}

/** Test-only seam: restore the real wall clock. */
export function resetClock(): void {
  nowFn = () => new Date();
}

function pickerStatePath(): string {
  return join(stateDir, "picker.json");
}

function pickerLockPath(): string {
  return join(stateDir, "picker.json.lock");
}

function configPath(): string {
  // `~/.config/agentusage/config.yaml` — the same catalog the daemon reads.
  const env = process.env.XDG_CONFIG_HOME;
  const base = env ? env : join(homedir(), ".config");
  return join(base, "agentusage", "config.yaml");
}

type Envelope = Record<string, unknown>;
type PickerState = Record<string, unknown>;

// ---------- YAML adapter ----------------------------------------------------

/**
 * Parse a YAML document. Bun.YAML targets YAML 1.2 — no `yes/no/on/off`
 * booleans (the agentusage config corpus is boolean-free, so this is safe).
 * Isolated behind one function so js-yaml could swap in if a 1.1-only document
 * ever appears. Returns `null` on any parse failure (fail-open caller turns
 * that into `[]`).
 */
function parseYaml(text: string): unknown {
  try {
    return Bun.YAML.parse(text);
  } catch {
    return null;
  }
}

// ---------- listProfiles ----------------------------------------------------

/**
 * Configured Claude profile names from agentusage's config.yaml. Reads the same
 * `profiles: [name1, ...]` list the daemon builds its registry from. Fail-open:
 * any missing/malformed config returns `[]` rather than throwing.
 */
export function listProfiles(): string[] {
  let text: string;
  try {
    text = readFileSync(configPath(), "utf8");
  } catch {
    return [];
  }
  const data = parseYaml(text);
  if (!isRecord(data)) {
    return [];
  }
  const raw = data.profiles;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
}

// ---------- pickProfile -----------------------------------------------------

/**
 * Credit-weighted balance over subscribed accounts; `"default"` if none. Never
 * throws — every failure path returns `DEFAULT_PROFILE`.
 */
export function pickProfile(): string {
  try {
    return doPickProfile();
  } catch {
    return DEFAULT_PROFILE;
  }
}

function doPickProfile(): string {
  let eligible = eligibleProfiles(false);
  if (eligible.length === 0) {
    // Fail-open: if the rate-limit filter stranded the eligible set, fall back
    // to the subscribed-only set so a launch isn't blocked just because every
    // profile is cooling down. Better to pick a rate-limited profile than to
    // silently route every launch to DEFAULT_PROFILE.
    eligible = eligibleProfiles(true);
    if (eligible.length === 0) {
      return DEFAULT_PROFILE;
    }
  }

  mkdirSync(stateDir, { recursive: true });
  const lock = FileLock.acquire(pickerLockPath());
  try {
    const state = loadPickerState();
    seedNewEntrants(
      state,
      eligible.map(([name]) => name),
    );
    const chosen = choose(eligible, counts(state));
    recordPick(state, chosen);
    writePickerState(state);
    return chosen;
  } finally {
    lock.release();
  }
}

/**
 * True iff the envelope's `lift_at` parses as a future instant. Pure: the
 * caller supplies `now`. Returns false on missing / non-string / unparseable /
 * past lift_at, and — critically — false on a naive (offset-less) stamp:
 * agentusage always writes tz-aware ISO, so a naive `lift` is a corrupted
 * envelope. JS's `Date` parses a naive ISO as LOCAL time silently, so we
 * require an explicit offset or `Z` suffix before trusting the parse, matching
 * Python's `datetime.fromisoformat(...).tzinfo is None` rejection.
 */
function isRateLimitedNow(envelope: Envelope, now: Date): boolean {
  const raw = envelope.lift_at;
  if (typeof raw !== "string") {
    return false;
  }
  if (!hasTimezone(raw)) {
    return false;
  }
  const lift = new Date(raw);
  if (Number.isNaN(lift.getTime())) {
    return false;
  }
  return lift.getTime() > now.getTime();
}

/**
 * True iff an ISO 8601 stamp carries an explicit timezone: a trailing `Z`, or a
 * `±HH:MM` / `±HHMM` offset on the time portion. Guards against JS silently
 * reading a naive stamp as local time.
 */
function hasTimezone(stamp: string): boolean {
  if (stamp.endsWith("Z") || stamp.endsWith("z")) {
    return true;
  }
  // Only consider the part after the date (skip the YYYY-MM-DD leading dashes).
  const timePart = stamp.slice(stamp.indexOf("T") + 1);
  return /[+-]\d{2}:?\d{2}$/.test(timePart);
}

/**
 * Configured profiles confirmed to have an active Claude subscription, as
 * `[name, envelope]` pairs. A profile qualifies only when its envelope exists
 * and says `target === "claude"` and `subscription_active === true`. No status
 * check — stale accounts still rotate. By default, profiles whose `lift_at` is
 * a future instant are excluded (rate-limit cooldown); `includeRateLimited`
 * bypasses that for the fail-open fallback.
 */
function eligibleProfiles(
  includeRateLimited: boolean,
): Array<[string, Envelope]> {
  const now = nowFn();
  const eligible: Array<[string, Envelope]> = [];
  for (const name of listProfiles()) {
    const envelope = loadEnvelope(join(stateDir, `${name}.json`));
    if (envelope.target !== "claude") {
      continue;
    }
    if (envelope.subscription_active !== true) {
      continue;
    }
    if (!includeRateLimited && isRateLimitedNow(envelope, now)) {
      continue;
    }
    eligible.push([name, envelope]);
  }
  return eligible;
}

/**
 * `multiplier × session_headroom` for one envelope. `multiplier` is external
 * input coerced to 1 below; `session_headroom` = clamp(1 −
 * usage.session.percent_used/100, 0, 1) with full headroom (1.0) on a
 * missing/non-numeric percent. The nesting is exactly
 * `usage.session.percent_used`.
 */
function effectiveWeight(envelope: Envelope): number {
  return multiplier(envelope) * sessionHeadroom(envelope);
}

function multiplier(envelope: Envelope): number {
  const raw = envelope.multiplier;
  // Replicate Python's bool guard: a bool, a non-integer, or a value < 1 → 1.
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    return 1;
  }
  return raw;
}

function sessionHeadroom(envelope: Envelope): number {
  const usage = envelope.usage;
  const session = isRecord(usage) ? usage.session : undefined;
  const percent = isRecord(session) ? session.percent_used : undefined;
  // bool is excluded (typeof true === "boolean"); only finite numbers count.
  if (typeof percent !== "number" || !Number.isFinite(percent)) {
    return 1.0;
  }
  const headroom = 1.0 - percent / 100.0;
  return Math.min(1.0, Math.max(0.0, headroom));
}

/**
 * Eligible profile minimizing `count / effective_weight`; ties by name. Stride
 * scheduling. Profiles whose weight floors to 0 are excluded; if every weight
 * is 0 (all session windows burned), the rule re-runs on `multiplier` alone.
 */
function choose(
  eligible: Array<[string, Envelope]>,
  ledger: Record<string, number>,
): string {
  let positive: Array<[string, number]> = [];
  for (const [name, env] of eligible) {
    const w = effectiveWeight(env);
    if (w > 0.0) {
      positive.push([name, w]);
    }
  }
  if (positive.length === 0) {
    positive = eligible.map(([name, env]) => [name, multiplier(env)]);
  }

  let best: [string, number] | null = null;
  let bestStride = Number.POSITIVE_INFINITY;
  let bestName = "";
  for (const [name, w] of positive) {
    const stride = (ledger[name] ?? 0) / w;
    if (stride < bestStride || (stride === bestStride && name < bestName)) {
      best = [name, w];
      bestStride = stride;
      bestName = name;
    }
  }
  // `positive` is always non-empty here (eligible is non-empty), so best is set.
  return (best as [string, number])[0];
}

/** Per-profile pick `count` from picker.json state; non-int entries → 0. */
function counts(state: PickerState): Record<string, number> {
  const picks = state.picks;
  if (!isRecord(picks)) {
    return {};
  }
  const out: Record<string, number> = {};
  for (const [name, entry] of Object.entries(picks)) {
    const count = isRecord(entry) ? entry.count : undefined;
    out[name] =
      typeof count === "number" && Number.isInteger(count) ? count : 0;
  }
  return out;
}

/**
 * Materialize any eligible profile that has no ledger entry at the pool minimum
 * — the stride-scheduling new-entrant rule — so a fresh profile draws no
 * catch-up burst. Baseline is `min` over the counts of eligible profiles
 * already in the ledger, else 0. History is never reset.
 */
function seedNewEntrants(state: PickerState, eligible: string[]): void {
  const ledger = counts(state);
  const recorded = eligible
    .filter((name) => name in ledger)
    .map((name) => ledger[name] as number);
  const baseline = recorded.length > 0 ? Math.min(...recorded) : 0;
  const fresh = eligible.filter((name) => !(name in ledger));
  if (fresh.length === 0) {
    return;
  }
  let picks = state.picks;
  if (!isRecord(picks)) {
    picks = {};
    state.picks = picks;
  }
  state.schema_version = PICKER_SCHEMA_VERSION;
  for (const name of fresh) {
    let entry = (picks as Record<string, unknown>)[name];
    if (!isRecord(entry)) {
      entry = {};
      (picks as Record<string, unknown>)[name] = entry;
    }
    (entry as Record<string, unknown>).count = baseline;
  }
}

/**
 * Stamp the chosen profile's last-pick time and bump its count in place. The
 * `last_picked_at` stamp is OFFSET-BEARING local ISO — matching Python's
 * `now().astimezone().isoformat()` shape, NOT `toISOString()`'s `Z` form — so
 * the Python reader (which rejects naive stamps) sees a stamp it trusts.
 */
function recordPick(state: PickerState, chosen: string): void {
  state.schema_version = PICKER_SCHEMA_VERSION;
  let picks = state.picks;
  if (!isRecord(picks)) {
    picks = {};
    state.picks = picks;
  }
  let entry = (picks as Record<string, unknown>)[chosen];
  if (!isRecord(entry)) {
    entry = {};
    (picks as Record<string, unknown>)[chosen] = entry;
  }
  const rec = entry as Record<string, unknown>;
  rec.last_picked_at = localIsoWithOffset(nowFn());
  const count = rec.count;
  rec.count =
    (typeof count === "number" && Number.isInteger(count) ? count : 0) + 1;
}

/**
 * Format a Date as local-time ISO 8601 with an explicit `±HH:MM` offset,
 * matching Python's `datetime.now().astimezone().isoformat()` (e.g.
 * `2026-06-12T09:20:00.901270-07:00`). `toISOString()` would emit a `Z`-form
 * UTC stamp; the Python reader treats local-offset stamps as the canonical
 * shape, so we mirror it for ledger compatibility.
 */
function localIsoWithOffset(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const offsetMin = -d.getTimezoneOffset(); // JS sign is inverted vs ISO
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  const ms = pad(d.getMilliseconds(), 3);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms}${offset}`
  );
}

// ---------- picker.json I/O -------------------------------------------------

/** Read picker.json; empty object on missing/corrupt/unrecognized version. */
function loadPickerState(): PickerState {
  const path = pickerStatePath();
  if (!existsSync(path)) {
    return {};
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  if (!isRecord(data)) {
    return {};
  }
  if (data.schema_version !== PICKER_SCHEMA_VERSION) {
    return {};
  }
  return data;
}

/**
 * Atomically replace picker.json: write a tmpfile in the same directory, then
 * `rename` over the target (same-filesystem atomic swap). Serialization is
 * `JSON.stringify(state, null, 2) + "\n"` — byte-compatible with Python's
 * `json.dump(state, f, indent=2)` + trailing newline.
 */
function writePickerState(state: PickerState): void {
  const path = pickerStatePath();
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
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

/** Read a per-account `<id>.json` envelope; empty object on missing/corrupt. */
function loadEnvelope(path: string): Envelope {
  if (!existsSync(path)) {
    return {};
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  return isRecord(data) ? data : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Profile picker — the client-side balancer over the agentusage usage envelopes.
 *
 * A scraper writes `~/.local/state/agentusage/<id>.json` envelopes (session/week
 * usage windows, `lift_at`, `last_successful_fetch_at`); this module is the dumb
 * balancer the `keeper agent` launch path calls to answer one question: **"which
 * Claude profile should I use right now?"** It owns `picker.json` end to end —
 * sole reader and sole writer.
 *
 * Two independent mechanisms decide a pick, both inside one flock-guarded
 * read-modify-write:
 *
 *  - **A hard admission gate** on scraped ground-truth usage decides *who is
 *    allowed*. A small burst reservation (`pending`) inflates a profile's
 *    effective usage between scrapes so a burst of launches parks hot accounts
 *    at the buffer instead of driving them into their rate limit.
 *  - **Pure LRU** (oldest `last_picked_at` first, ties by name) decides *whose
 *    turn* it is within the admitted set — never a usage-weighted priority.
 *
 * Selection walks a five-rung fail-open ladder; the first non-empty rung wins
 * (see {@link chooseByLadder}). A dead or stalled scraper degrades the fleet to
 * plain LRU rotation and the picker never throws.
 *
 * DB-free leaf: imports only `node:fs`/`node:os`/`node:path` + the dep-free
 * `src/usage-flock.ts` / `src/usage-models.ts`, never `src/db.ts`, so the
 * `keeper agent` cold-start stays cheap (the `cli/agent.ts` db-free discipline).
 *
 * Two public functions, both fail-open:
 *
 * - `pickProfile() -> string` — the admitted, LRU-oldest subscribed account;
 *   never throws, every failure path returns `DEFAULT_PROFILE`.
 * - `listProfiles() -> string[]` — the declared claude profile ids from the
 *   `usage_models` keeper-config registry; `[]` on missing / malformed config.
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
import { claudeProfileIds, resolveUsageModels } from "./usage-models";

// Returned when no profile resolves. Also a real account id — the wrapper maps
// "default" onto the default Claude account.
export const DEFAULT_PROFILE = "default";

// Bumped when picker.json's shape changes. A file with an unrecognized version
// is treated as absent (start fresh) rather than migrated — a v1 file is
// discarded on first pick, costing one name-ordered rotation.
export const PICKER_SCHEMA_VERSION = 2;

// Admission thresholds on effective usage percent. Rung 1 (primary pool) admits
// a profile below the buffer; rung 2 (overflow) admits below the harder cap.
// `effective_X = scraped_percent_X + pending * STEP_X / multiplier` — the burst
// reservation, so a hot account climbs toward its limit as it is picked.
const SESSION_BUFFER = 80;
const WEEK_BUFFER = 95;
const SESSION_OVERFLOW = 90;
const WEEK_OVERFLOW = 98;
const STEP_SESSION = 5;
const STEP_WEEK = 1;

// Non-XDG by deliberate design (NOT XDG_STATE_HOME). Kept mutable behind a
// setter so tests (and the agent launcher's `resolveUsageRoot()`) can redirect
// it.
let stateDir = join(homedir(), ".local", "state", "agentusage");

/** Test-only seam: redirect STATE_DIR. */
export function setStateDir(dir: string): void {
  stateDir = dir;
}

/** Test-only seam: read the current STATE_DIR. */
export function getStateDir(): string {
  return stateDir;
}

// Injectable clock — `pickProfile`'s notion of "now". A module-internal clock
// with a test-only setter provides a DI seam without `mock.module` (which
// neither hoists nor auto-resets); tests pin it to defeat microsecond ties and
// control `lift_at` / `last_picked_at` comparisons.
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

type Envelope = Record<string, unknown>;
type PickerState = Record<string, unknown>;
type PicksMap = Record<string, unknown>;

/** One subscribed account under consideration for a pick. */
interface Candidate {
  name: string;
  envelope: Envelope;
  /** Rate-limit-parked (future `lift_at`, or a usage-endpoint throttle). */
  parked: boolean;
}

/** A candidate paired with its computed effective usage for the gate. */
interface Row {
  cand: Candidate;
  effSession: number;
  effWeek: number;
}

// ---------- listProfiles ----------------------------------------------------

/**
 * The declared claude profile ids from the `usage_models` keeper-config registry
 * (every declared id except `codex`) — the same set the producer's
 * `buildAccounts` scrapes. Fail-open: a missing/malformed config folds to an
 * empty registry, so this returns `[]` rather than throwing. Reads the registry
 * through the dep-free `src/usage-models.ts` so the picker stays off `src/db.ts`.
 */
export function listProfiles(): string[] {
  return claudeProfileIds(resolveUsageModels());
}

// ---------- pickProfile -----------------------------------------------------

/**
 * Buffered-LRU balance over subscribed accounts; `"default"` if none. Never
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
  const now = nowFn();
  const subscribed = subscribedProfiles(now);
  if (subscribed.length === 0) {
    // Rung 5: no subscribed profile at all → DEFAULT_PROFILE with NO state
    // write (preserves the no-eligible-no-write behavior).
    return DEFAULT_PROFILE;
  }

  mkdirSync(stateDir, { recursive: true });
  const lock = FileLock.acquire(pickerLockPath());
  try {
    const state = loadPickerState();
    state.schema_version = PICKER_SCHEMA_VERSION;
    const picks = ensurePicks(state);
    // Reconcile every subscribed profile against fresh scrape data before
    // gating, so a landed scrape zeroes stale reservations in the same write.
    for (const cand of subscribed) {
      reconcilePending(picks, cand.name, cand.envelope);
    }
    const { chosen, rung } = chooseByLadder(subscribed, picks, now);
    recordPick(state, picks, chosen, rung, now);
    writePickerState(state);
    return chosen;
  } finally {
    lock.release();
  }
}

/**
 * Subscribed Claude accounts as {@link Candidate}s. A profile qualifies only
 * when its envelope exists and says `target === "claude"` and
 * `subscription_active === true`. No status check — stale accounts still
 * rotate. Each carries a `parked` flag: a future `lift_at` (rate-limit
 * cooldown) or a usage-endpoint throttle marks it unusable for the primary
 * rungs, but it still counts as subscribed for the rung-4 backstop.
 */
function subscribedProfiles(now: Date): Candidate[] {
  const out: Candidate[] = [];
  for (const name of listProfiles()) {
    const envelope = loadEnvelope(join(stateDir, `${name}.json`));
    if (envelope.target !== "claude") {
      continue;
    }
    if (envelope.subscription_active !== true) {
      continue;
    }
    const parked =
      isRateLimitedNow(envelope, now) || isUsageEndpointRateLimited(envelope);
    out.push({ name, envelope, parked });
  }
  return out;
}

/**
 * True iff the envelope's `lift_at` parses as a future instant. Pure: the
 * caller supplies `now`. Returns false on missing / non-string / unparseable /
 * past lift_at, and — critically — false on a naive (offset-less) stamp:
 * agentusage always writes tz-aware ISO, so a naive `lift` is a corrupted
 * envelope. JS's `Date` parses a naive ISO as LOCAL time silently, so we
 * require an explicit offset or `Z` suffix before trusting the parse.
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

function isUsageEndpointRateLimited(envelope: Envelope): boolean {
  const error = envelope.error;
  return isRecord(error) && error.type === "ClaudeUsageEndpointRateLimited";
}

// ---------- admission gate + LRU --------------------------------------------

/**
 * Multiplier coercion, reused as the reservation divisor. `multiplier` is
 * external input: a bool, a non-integer, or a value < 1 all coerce to 1, so the
 * divisor is always a safe positive integer.
 */
function multiplier(envelope: Envelope): number {
  const raw = envelope.multiplier;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    return 1;
  }
  return raw;
}

/**
 * One window's scraped percent, defensive: `usage.<window>.percent_used`
 * null/missing/non-number counts as 0. Rollover grace: when the window's
 * `resets_at` is a tz-aware PAST instant the window has already reset, so its
 * scraped percent is treated as 0 (a naive/unparseable `resets_at` gets no
 * grace). Grace never touches `pending` — it self-clears on the next scrape.
 */
function scrapedPercent(usage: unknown, window: string, now: Date): number {
  const win = isRecord(usage) ? usage[window] : undefined;
  const raw = isRecord(win) ? win.percent_used : undefined;
  let percent =
    typeof raw === "number" && Number.isFinite(raw) ? (raw as number) : 0;
  const resets = isRecord(win) ? win.resets_at : undefined;
  if (typeof resets === "string" && hasTimezone(resets)) {
    const t = new Date(resets).getTime();
    if (!Number.isNaN(t) && t <= now.getTime()) {
      percent = 0;
    }
  }
  return percent;
}

/**
 * Resolve the pick via the five-rung fail-open ladder; the first non-empty rung
 * wins, LRU-ordered within it. `subscribed` is guaranteed non-empty, so rung 4
 * always resolves (rung 5 — zero subscribed — is handled before the lock).
 *
 *  1. **Admitted**: unparked AND under both buffers.
 *  2. **Overflow**: unparked AND under both (harder) overflow caps.
 *  3. **Any unparked** — thresholds dropped. The designed degradation: a
 *     stalled scraper (frozen fetch stamp, accumulating `pending`) lands the
 *     fleet here, i.e. plain rotation. This rung is the liveness backstop.
 *  4. **All subscribed** including parked.
 */
function chooseByLadder(
  subscribed: Candidate[],
  picks: PicksMap,
  now: Date,
): { chosen: string; rung: number } {
  const rows: Row[] = subscribed.map((cand) => {
    const pending = readPending(picks, cand.name);
    const mult = multiplier(cand.envelope);
    const usage = cand.envelope.usage;
    const effSession =
      scrapedPercent(usage, "session", now) + (pending * STEP_SESSION) / mult;
    const effWeek =
      scrapedPercent(usage, "week", now) + (pending * STEP_WEEK) / mult;
    return { cand, effSession, effWeek };
  });

  const unparked = rows.filter((r) => !r.cand.parked);

  const admitted = unparked.filter(
    (r) => r.effSession < SESSION_BUFFER && r.effWeek < WEEK_BUFFER,
  );
  if (admitted.length > 0) {
    return { chosen: lruWinner(admitted, picks), rung: 1 };
  }

  const overflow = unparked.filter(
    (r) => r.effSession < SESSION_OVERFLOW && r.effWeek < WEEK_OVERFLOW,
  );
  if (overflow.length > 0) {
    return { chosen: lruWinner(overflow, picks), rung: 2 };
  }

  if (unparked.length > 0) {
    return { chosen: lruWinner(unparked, picks), rung: 3 };
  }

  return { chosen: lruWinner(rows, picks), rung: 4 };
}

/**
 * The LRU-oldest name in `rows`: smallest `last_picked_at` instant first, ties
 * by name. An absent/corrupt/naive/unparseable stamp sorts epoch-oldest so a
 * fresh profile wins one catch-up turn and the comparator never throws.
 */
function lruWinner(rows: Row[], picks: PicksMap): string {
  let bestName = "";
  let bestEpoch = Number.POSITIVE_INFINITY;
  let chosen = false;
  for (const { cand } of rows) {
    const epoch = pickedAtEpoch(picks[cand.name]);
    if (
      !chosen ||
      epoch < bestEpoch ||
      (epoch === bestEpoch && cand.name < bestName)
    ) {
      bestName = cand.name;
      bestEpoch = epoch;
      chosen = true;
    }
  }
  return bestName;
}

/**
 * Parse a ledger entry's `last_picked_at` into a sortable epoch-ms. Anything
 * that is not a trustworthy tz-aware stamp (absent, non-string, naive,
 * unparseable) sorts as `-Infinity` (epoch-oldest), never throwing.
 */
function pickedAtEpoch(entry: unknown): number {
  const raw = isRecord(entry) ? entry.last_picked_at : undefined;
  if (typeof raw !== "string" || !hasTimezone(raw)) {
    return Number.NEGATIVE_INFINITY;
  }
  const t = new Date(raw).getTime();
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/** A profile's current reservation count; non-number/negative reads as 0. */
function readPending(picks: PicksMap, name: string): number {
  const entry = picks[name];
  const raw = isRecord(entry) ? entry.pending : undefined;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

/**
 * Reconcile one profile's `pending` reservation against the envelope's
 * `last_successful_fetch_at`. A strict-equality compare of the stored
 * `seen_fetch_at` (normalized to `string | null`) against the envelope stamp
 * decides: `null == null` (or two equal strings) is unchanged and preserves the
 * accumulated `pending`; any change means fresh scrape data landed, so `pending`
 * resets to 0 and the new stamp is stored.
 */
function reconcilePending(
  picks: PicksMap,
  name: string,
  envelope: Envelope,
): void {
  const raw = envelope.last_successful_fetch_at;
  const envFetch = typeof raw === "string" ? raw : null;
  const existing = picks[name];
  const storedSeen =
    isRecord(existing) && typeof existing.seen_fetch_at === "string"
      ? existing.seen_fetch_at
      : null;
  if (storedSeen === envFetch) {
    return;
  }
  const entry = ensureEntry(picks, name);
  entry.pending = 0;
  entry.seen_fetch_at = envFetch;
}

/**
 * Stamp the chosen profile's `last_picked_at` (offset-bearing local ISO) and
 * increment its `pending` reservation in place. Also writes the top-level
 * `last_pick` forensic blob — the resolved rung is an operational signal, kept
 * out of the string-returning contract.
 */
function recordPick(
  state: PickerState,
  picks: PicksMap,
  chosen: string,
  rung: number,
  now: Date,
): void {
  const entry = ensureEntry(picks, chosen);
  const at = localIsoWithOffset(now);
  entry.last_picked_at = at;
  entry.pending = readPending(picks, chosen) + 1;
  state.last_pick = { profile: chosen, rung, at };
}

function ensurePicks(state: PickerState): PicksMap {
  let picks = state.picks;
  if (!isRecord(picks)) {
    picks = {};
    state.picks = picks;
  }
  return picks as PicksMap;
}

function ensureEntry(picks: PicksMap, name: string): Record<string, unknown> {
  let entry = picks[name];
  if (!isRecord(entry)) {
    entry = {};
    picks[name] = entry;
  }
  return entry as Record<string, unknown>;
}

/**
 * Format a Date as local-time ISO 8601 with an explicit `±HH:MM` offset (e.g.
 * `2026-06-12T09:20:00.901270-07:00`). `toISOString()` would emit a `Z`-form
 * UTC stamp; the offset-bearing local form is the canonical `last_picked_at`
 * shape, which the tz-aware `pickedAtEpoch` parse trusts.
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
 * `JSON.stringify(state, null, 2) + "\n"`.
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

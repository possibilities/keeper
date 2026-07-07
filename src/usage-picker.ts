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
 *  - **A latched reserve** decides *who is viable*. While any healthy account
 *    exists (unparked, under the session and week thresholds on effective usage)
 *    the latch stays closed and only the healthy set is viable — over-threshold
 *    accounts are held non-viable. The moment no healthy account remains the
 *    latch OPENS in the same pick and the full unparked set becomes viable,
 *    balancing up to each account's real rate limit. It RE-LATCHES to
 *    healthy-only only when an account recovers under the lower re-arm mark; a
 *    recovery merely under the threshold does not close it (the anti-flap
 *    hysteresis band). A small burst reservation (`pending`) inflates a
 *    profile's effective usage between scrapes, so a burst can open the reserve
 *    ahead of the next scrape — the intended slow-close asymmetry.
 *  - **Pure LRU** (oldest `last_picked_at` first, ties by name) decides *whose
 *    turn* it is within the viable set — never a usage-weighted priority.
 *
 * The latch update runs before viability is resolved, so the pick that empties
 * the healthy set is itself served from the reserve (see {@link chooseLatched}).
 * When even the unparked set is empty a single all-included backstop tier keeps
 * the fleet rotating, and the picker never throws.
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

// Latch gates on effective usage percent. An account is *healthy* below both
// thresholds and *re-armed* below the lower session mark; the 80→50 session gap
// is the anti-flap hysteresis band (edit the const to retune — no config/env
// plumbing). `effective_X = scraped_percent_X + pending * STEP_X / multiplier` —
// the burst reservation, so a hot account climbs toward its limit as it is
// picked and can open the reserve ahead of the next scrape.
export const SESSION_THRESHOLD = 80;
export const WEEK_THRESHOLD = 95;
const SESSION_REARM = 50;
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

/**
 * Which set served the pick: `healthy` (latch closed, viable = healthy set),
 * `reserve` (latch open, viable = full unparked set), or `backstop` (nothing
 * unparked — the all-included fail-open tier). A forensic signal on `last_pick`,
 * kept out of the string-returning contract.
 */
type Tier = "healthy" | "reserve" | "backstop";

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
    // No subscribed profile at all → DEFAULT_PROFILE with NO state write
    // (preserves the no-eligible-no-write behavior).
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
    const { chosen, tier, reserveOpen } = chooseLatched(
      state,
      subscribed,
      picks,
      now,
    );
    recordPick(state, picks, chosen, tier, reserveOpen, now);
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
 * cooldown) or a usage-endpoint throttle marks it non-viable for the healthy
 * and reserve tiers, but it still counts as subscribed for the all-included
 * backstop.
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
 * Resolve the pick through the latched reserve, LRU-ordered within the viable
 * set. `subscribed` is guaranteed non-empty (the zero-subscribed case returns
 * before the lock), so the backstop always resolves a name.
 *
 * The latch is `state.reserve_open`, read strictly (absent / null / non-bool →
 * latched, the conservative fail-open state). Two accounts pools drive it, both
 * over the burst-inflated effective usage:
 *
 *  - **healthy**: unparked AND under both thresholds — the viable set while the
 *    latch is closed.
 *  - **re-armed**: unparked AND under the lower session re-arm mark (⊆ healthy
 *    by construction, so a re-latch can never leave the viable set empty).
 *
 * The latch updates before viability is resolved: it OPENS the pick that empties
 * the healthy set (served from the reserve in the same call — fast-open) and
 * RE-LATCHES only when a re-armed account exists (slow-close). `viable` is then
 * the unparked set when open, the healthy set when closed; if that is empty
 * (nothing unparked) the all-included backstop tier keeps the fleet rotating.
 */
function chooseLatched(
  state: PickerState,
  subscribed: Candidate[],
  picks: PicksMap,
  now: Date,
): { chosen: string; tier: Tier; reserveOpen: boolean } {
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
  const healthy = unparked.filter(
    (r) => r.effSession < SESSION_THRESHOLD && r.effWeek < WEEK_THRESHOLD,
  );
  const rearm = unparked.filter(
    (r) => r.effSession < SESSION_REARM && r.effWeek < WEEK_THRESHOLD,
  );

  let reserveOpen = state.reserve_open === true;
  if (!reserveOpen && healthy.length === 0) {
    reserveOpen = true; // OPEN: no healthy account remains
  } else if (reserveOpen && rearm.length > 0) {
    reserveOpen = false; // RE-LATCH: an account recovered under the re-arm mark
  }

  let viable = reserveOpen ? unparked : healthy;
  let tier: Tier;
  if (viable.length > 0) {
    tier = reserveOpen ? "reserve" : "healthy";
  } else {
    viable = rows;
    tier = "backstop";
  }

  return { chosen: lruWinner(viable, picks), tier, reserveOpen };
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
 * increment its `pending` reservation in place. Persists the authoritative
 * top-level `reserve_open` latch — the value the next pick reads — and the
 * `last_pick` forensic blob carrying the resolved tier and latch state. The
 * next pick reads `reserve_open`, never `last_pick.reserve_open`.
 */
function recordPick(
  state: PickerState,
  picks: PicksMap,
  chosen: string,
  tier: Tier,
  reserveOpen: boolean,
  now: Date,
): void {
  const entry = ensureEntry(picks, chosen);
  const at = localIsoWithOffset(now);
  entry.last_picked_at = at;
  entry.pending = readPending(picks, chosen) + 1;
  state.reserve_open = reserveOpen;
  state.last_pick = { profile: chosen, tier, reserve_open: reserveOpen, at };
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

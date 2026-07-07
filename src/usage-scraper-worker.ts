/**
 * Usage-scraper PRODUCER worker (fn-930 `.4`). keeperd's in-process port of
 * agentusage's retired `daemon.py` — it owns the ORCHESTRATION that scrapes each
 * Claude/Codex account's `/usage`|`/status` panel and writes the per-account
 * `~/.local/state/agentusage/<id>.json` envelopes the existing
 * {@link import("./usage-worker")} CONSUMER folds into the `usage` projection.
 *
 * This worker writes ONLY its own external surface — the envelope files, the
 * `<id>.error.json` sidecars, and the `events.jsonl` audit log under the resolved
 * agentusage root. It NEVER writes keeper.db (main stays the sole event writer;
 * the existing usage-worker mints `UsageSnapshot` events FROM these files). It
 * opens a read-only keeper.db connection only to satisfy the worker contract's
 * `openDb` convention (it holds no live keeper state); the scrape state is all on
 * disk.
 *
 * **Structural model: the builds-worker poll producer, NOT a watcher.** N
 * CONCURRENT per-account async loops (one per configured Claude profile + the
 * codex account) share a GLOBAL profile-gate (launches >= 60s apart) and a
 * PER-TARGET mutex (same-target claude TUI spawns serialize so parallel Ink
 * processes don't starve each other). Each loop runs the builds-worker discipline:
 * setTimeout-after-completion (`scheduleNext` after the cycle settles, never
 * setInterval), a per-cycle NO-THROW guard so a scrape bug degrades to a `stale`
 * envelope + an `events.jsonl` line and NEVER reaches `onerror`/`fatalExit` (an
 * unguarded throw → LaunchAgent restart loop), and an `inFlight` skip.
 *
 * **The scrape itself shells out via `.3`'s {@link ScrapeRunner}** — a single
 * `<uv> run --directory <agentusage> python -m agentusage.scrape_cli …`
 * subprocess that `pexpect`-spawns the real TUI and prints one discriminated JSON
 * object. Production threads `runScrape`; tests inject a fake returning a canned
 * {@link ScrapeResult}. The runtime resolution (uv path + project dir) is the
 * SPAWN GATE in `daemon.ts`: an unresolved runtime un-spawns the worker (+ warns,
 * never `fatalExit`), so by the time `main()` runs the runtime is present.
 *
 * **Producer-side wall-clock owns the envelope assembly** (multiplier,
 * `next_fetch_at = now + uniform(60,180)s`, `last_*_fetch_at`, `lift_at` carry).
 * The Python parser's `derive_lift_at` is ported here ({@link deriveLiftAt}) — the
 * success path derives `lift_at` fresh, never carrying the prior. The tier ↔
 * multiplier resolution + account discovery (config profiles + codex) move TS-side
 * ({@link resolveMultiplierOrNull} / {@link buildAccounts}). A tier-read failure
 * KEEPS THE PRIOR multiplier (the mutable account record is the carrier) so a Max
 * account never silently downgrades to 1x. The multiplier re-resolves on a ~60s
 * sub-cadence INDEPENDENT of cooldown/idle parking: the no-scrape sleeps are capped
 * at {@link MULTIPLIER_POLL_INTERVAL_S} (post-scrape backoffs are NOT), and a change
 * vs the on-disk envelope breaks both gates early and forces a scrape. An mtime memo
 * ({@link multiplierMemo}) keeps the multi-MB re-read free on an unchanged file.
 *
 * `isMainThread`-guarded body — a plain import (tests driving the pure helpers +
 * the {@link AccountLoop} with a stub runner + sandboxed root) is inert.
 */

import {
  closeSync,
  type Dirent,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { MAX_CLAUDE_JSON_BYTES, resolveTierMultiplier } from "./claude-tier";
import { openDb } from "./db";
import { FileLock } from "./usage-flock";
import {
  claudeProfileIds,
  hasCodexModel,
  resolveUsageModels,
  type UsageModels,
} from "./usage-models";
import {
  type AccountState,
  asAccountState,
  asUsageErrorKind,
  runScrape,
  type ScrapeAccount,
  type ScrapeResult,
  type ScrapeRunner,
  type ScrapeUsage,
  type UsageErrorKind,
} from "./usage-scrape-runner";
import type { ShutdownMessage } from "./wake-worker";

/**
 * Envelope schema version. Mirrors agentusage's `ENVELOPE_SCHEMA_VERSION` — the
 * consumer (usage-worker) + the vendored picker read this. NOT the scrape-contract
 * schema version (that one lives in `usage-scrape-runner.ts`; the worker owns the
 * envelope, the util owns the scrape contract).
 */
export const ENVELOPE_SCHEMA_VERSION = 1;

/** Idle window: skip the scrape when no agent session log moved within this. */
const IDLE_THRESHOLD_S = 15 * 60;

/**
 * Freshness floor: force a genuine scrape when the last SUCCESSFUL scrape is older
 * than this, bypassing BOTH the cooldown (rate-limit park) and idle skip gates. A
 * parked/idle account otherwise coasts on carried-forward usage until its derived
 * `lift_at` — so a provider-side quota reset that lands EARLIER than the predicted
 * lift stays invisible for days. The floor caps that blind window: every account is
 * re-read at least once per interval no matter its park/idle state. Anchored on
 * `last_successful_fetch_at` (the last real look), which every skip carries forward,
 * so it measures time-since-actual-scrape — not reset by parked/idle heartbeats.
 */
const FORCED_SCRAPE_FLOOR_S = 15 * 60;

/**
 * Sub-cadence cap on the NO-SCRAPE sleeps (cooldown, idle, restart-delay): a
 * parked account re-resolves its tier→multiplier within ~one poll instead of
 * staying frozen until a multi-day cooldown lifts. ONLY the no-scrape sleeps are
 * capped — a post-scrape backoff (esp. the /usage endpoint-rate-limit retry) must
 * stay long so a throttled endpoint is not re-hammered every minute.
 */
const MULTIPLIER_POLL_INTERVAL_S = 60;

/**
 * Jitter added to the poll cap so per-account loops don't synchronize their parked
 * wakes into a lockstep cohort. Jitters the CAP only, never the mtime stat.
 */
const MULTIPLIER_POLL_JITTER_S = 10;

/** Min interval between profile launches — the global profile-gate cadence. */
const MIN_PROFILE_USE_INTERVAL_S = 60.0;

/** Backoff for Claude's transient `/usage` endpoint throttle. */
const USAGE_ENDPOINT_RATE_LIMIT_RETRY_MIN_S = 15 * 60;
const USAGE_ENDPOINT_RATE_LIMIT_RETRY_MAX_S = 30 * 60;

/** One account the worker scrapes: a stable id + the TUI target + its multiplier. */
export interface Account {
  /** Stable account id — also the envelope filename stem; MUST pass `isUsageFilename`. */
  id: string;
  target: "claude" | "codex";
  /** Profile name forwarded to the scrape util (claude); "" for codex. */
  profile: string;
  /**
   * Mutable multiplier — the keep-prior carrier across a failed tier re-resolve.
   * `null` ≡ the tier never resolved at boot (renders `?x`, "tier unknown"). A
   * transient per-cycle re-read failure KEEPS the prior value (see
   * {@link reResolveMultiplier}), so `null` surfaces ONLY for a boot-time
   * never-resolved tier — never a downgrade of a known-good account.
   */
  multiplier: number | null;
  /** Per-account episode flag: a tier resolve is currently failing (warning already fired). */
  tierResolveFailed?: boolean;
}

/** Canonical envelope key order — every variant emits exactly these keys. */
export interface Envelope {
  schema_version: number;
  id: string;
  target: string;
  /** `null` ≡ tier unresolved (renders `?x`); the column stays `INTEGER|NULL`. */
  multiplier: number | null;
  status: "active" | "idle" | "stale";
  subscription_active: boolean | null;
  /**
   * Orthogonal account-state axis — see {@link AccountState}. NULL ≡ subscribed
   * (or codex). Stable across a transient scrape failure (carried forward by
   * {@link priorAccountState}) so a signed-out / no-subscription account does not
   * flicker while a blip surfaces via the stale-error precedence.
   */
  account_state: AccountState | null;
  last_successful_fetch_at: string | null;
  last_skipped_fetch_at: string | null;
  last_failed_fetch_at: string | null;
  next_fetch_at: string;
  usage: ScrapeUsage | null;
  lift_at: string | null;
  error: {
    type: string;
    message: string;
    at: string;
    /** Stable failure classification — see {@link UsageErrorKind}. */
    kind: UsageErrorKind | null;
  } | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------- account discovery + tier resolution (TS-side) -------------------

/**
 * Per-path {size, mtimeMs} → resolved-multiplier memo gating the readFileSync +
 * JSON.parse in {@link resolveMultiplierOrNull}. `.claude.json` runs multi-MB and
 * the parked sub-cadence re-resolves it every ~60s, so a byte-identical
 * {size, mtimeMs} short-circuits to the cached multiplier (a cached `null`
 * included). mtime is LOAD-BEARING: the claude CLI rewrites the file WHOLESALE
 * (atomic rename), not appended, so size alone would false-skip a same-size tier
 * flip — gate on both, and a ~60s cadence absorbs the atomic-rename mtime skew.
 * `statSync` reads no file data, so the gate is free regardless of the 2-3 MB
 * size. In-memory only — an empty memo after restart just costs one parse.
 */
const multiplierMemo = new Map<
  string,
  { size: number; mtimeMs: number; multiplier: number | null }
>();

/**
 * Resolve a profile's multiplier from its `.claude.json` tier string, or `null`
 * on EVERY failure path (oversize file, read/parse error, missing/unknown tier).
 * The `null` is load-bearing — the per-cycle re-resolve KEEPS the prior multiplier
 * on `null` so a transient blip never downgrades a Max account. Mirrors the
 * daemon's `_resolve_multiplier_or_none`. Pure-ish (reads the fs); never throws.
 * An mtime memo ({@link multiplierMemo}) skips the parse on an unchanged file.
 */
export function resolveMultiplierOrNull(
  profile: string,
  homeDir: string = homedir(),
): number | null {
  // `default` canonically lives in `~/.claude`, not a `~/.claude-profiles/default`
  // shadow (which nothing else reads). Mirror the scraper's default special-case
  // here so BOTH the boot path and the per-cycle re-resolve read the right tier.
  const path =
    profile === "default"
      ? join(homeDir, ".claude", ".claude.json")
      : join(homeDir, ".claude-profiles", profile, ".claude.json");
  let size: number;
  let mtimeMs: number;
  try {
    const st = statSync(path);
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    // Missing/unreadable: drop any memo so a re-appeared file always re-resolves.
    multiplierMemo.delete(path);
    return null;
  }
  const memo = multiplierMemo.get(path);
  if (memo && memo.size === size && memo.mtimeMs === mtimeMs) {
    return memo.multiplier;
  }
  const multiplier = parseTierMultiplier(path, size);
  multiplierMemo.set(path, { size, mtimeMs, multiplier });
  return multiplier;
}

/** Read + parse the resolved tier multiplier (no memo); null on every failure. */
function parseTierMultiplier(path: string, size: number): number | null {
  if (size > MAX_CLAUDE_JSON_BYTES) {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(data) || !isRecord(data.oauthAccount)) {
    return null;
  }
  return resolveTierMultiplier(data.oauthAccount.organizationRateLimitTier);
}

/**
 * Per-cycle tier re-resolve with keep-prior + episode-throttled warning. On a
 * non-null result, adopt it and clear the failure flag (re-arming the warning).
 * On `null`, KEEP `acct.multiplier` and — only at failure onset, gated by
 * `tierResolveFailed` — fire exactly one `log(...)` so a silent freeze (file
 * past the cap, unknown tier) becomes visible instead of recurring per cycle.
 */
export function reResolveMultiplier(
  acct: Account,
  homeDir: string = homedir(),
  log: (msg: string) => void = console.error,
): void {
  const resolved = resolveMultiplierOrNull(acct.profile, homeDir);
  if (resolved !== null) {
    acct.multiplier = resolved;
    acct.tierResolveFailed = false;
    return;
  }
  if (!acct.tierResolveFailed) {
    acct.tierResolveFailed = true;
    // A boot-time never-resolved tier carries a null prior — render it as the
    // unresolved sentinel rather than the literal `nullx`.
    const prior =
      acct.multiplier === null ? "unknown (?x)" : `${acct.multiplier}x`;
    log(
      `[usage-scraper] tier resolve failed for ${JSON.stringify(acct.id)}; keeping prior multiplier ${prior}`,
    );
  }
}

/**
 * Build the runtime account registry from the declared `usage_models` set: one
 * claude `Account` per declared claude id (multiplier derived from its own tier)
 * plus the codex account (no tier, 1x) ONLY when `codex` is declared. An empty
 * registry yields no accounts — the worker then idles (there is no implicit
 * codex). The registry keys are already envelope-id-validated at parse time, so
 * no per-id shape check is needed here. Mirrors the daemon's `_build_accounts`.
 */
export function buildAccounts(
  models: UsageModels,
  homeDir: string = homedir(),
): Account[] {
  const accounts: Account[] = [];
  for (const id of claudeProfileIds(models)) {
    accounts.push({
      id,
      target: "claude",
      profile: id,
      multiplier: resolveMultiplierOrNull(id, homeDir),
    });
  }
  if (hasCodexModel(models)) {
    accounts.push({ id: "codex", target: "codex", profile: "", multiplier: 1 });
  }
  return accounts;
}

/**
 * The envelope-id predicate — the SAME shape the consumer's `isUsageFilename`
 * applies to `<id>.json` (anchored `^[a-z0-9-]+$` on the stem). Kept local (a
 * leaf must not import the db-bearing usage-worker), asserted parity in tests.
 */
export function isUsageId(id: string): boolean {
  return /^[a-z0-9-]+$/.test(id);
}

// ---------- idle / cooldown gates -------------------------------------------

/**
 * Newest mtime (epoch seconds) across claude + codex session logs; 0 if none.
 * Claude profiles all symlink `projects/` to `~/.claude/projects`, so one walk
 * covers every claude account; codex writes per-session rollouts under
 * `~/.codex/sessions`. Paths containing `agentusage-scrape-` are filtered (a
 * future scrape change must not keep the worker awake). Bounded: never throws —
 * an unreadable entry is skipped. Pure over its `roots` arg for tests.
 */
export function latestAgentActivity(
  roots: string[] = [
    join(homedir(), ".claude", "projects"),
    join(homedir(), ".codex", "sessions"),
  ],
): number {
  let newest = 0;
  for (const root of roots) {
    walkJsonlMtimes(root, (mtimeMs) => {
      const sec = mtimeMs / 1000;
      if (sec > newest) newest = sec;
    });
  }
  return newest;
}

/** Recursively visit `*.jsonl` mtimes under `root`; skip scrape artifacts + errors. */
function walkJsonlMtimes(root: string, visit: (mtimeMs: number) => void): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return; // missing / unreadable root — nothing to contribute.
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      walkJsonlMtimes(full, visit);
      continue;
    }
    if (!entry.name.endsWith(".jsonl")) {
      continue;
    }
    if (full.includes("agentusage-scrape-")) {
      continue;
    }
    try {
      visit(statSync(full).mtimeMs);
    } catch {
      // unreadable file — skip.
    }
  }
}

/**
 * True iff `raw` parses as a tz-AWARE ISO instant strictly after `now`. Mirrors
 * the picker's `isRateLimitedNow` / the daemon's `_parse_aware_isoformat` + `>
 * now` check: a naive (offset-less) stamp is rejected (a corrupted envelope), so
 * a cooldown is never derived from garbage. Pure.
 */
export function liftIsInFuture(raw: unknown, now: Date): boolean {
  if (typeof raw !== "string" || !hasTimezone(raw)) {
    return false;
  }
  const lift = new Date(raw);
  if (Number.isNaN(lift.getTime())) {
    return false;
  }
  return lift.getTime() > now.getTime();
}

/** True iff an ISO stamp carries an explicit `Z` or `±HH:MM`/`±HHMM` offset. */
function hasTimezone(stamp: string): boolean {
  if (stamp.endsWith("Z") || stamp.endsWith("z")) {
    return true;
  }
  const timePart = stamp.slice(stamp.indexOf("T") + 1);
  return /[+-]\d{2}:?\d{2}$/.test(timePart);
}

// ---------- lift_at derivation (ported from parse_claude_usage) -------------

/**
 * The binding rate-limit lift instant for a parsed `usage` dict: the soonest
 * `resets_at` among windows whose `percent_used >= 100`. `null` when usage is
 * absent, no window is at >=100%, or every >=100% window lacks `resets_at`.
 * Ported 1:1 from agentusage's `derive_lift_at`. Pure.
 */
export function deriveLiftAt(
  usage: ScrapeUsage | null | undefined,
): string | null {
  if (!usage) {
    return null;
  }
  let soonest: string | null = null;
  for (const window of Object.values(usage)) {
    if (!isRecord(window)) {
      continue;
    }
    const percent = window.percent_used;
    const resetsAt = window.resets_at;
    if (
      typeof percent !== "number" ||
      typeof resetsAt !== "string" ||
      percent < 100
    ) {
      continue;
    }
    if (soonest === null || resetsAt < soonest) {
      soonest = resetsAt;
    }
  }
  return soonest;
}

// ---------- wall-clock / jitter (injectable for tests) ----------------------

/** Clock + RNG the loop reads — injectable so tests pin instants + jitter. */
export interface LoopClock {
  /** Current wall-clock instant. */
  now: () => Date;
  /** Monotonic seconds (the profile-gate cadence reference). */
  monotonic: () => number;
  /** Uniform jitter in `[lo, hi)`. */
  uniform: (lo: number, hi: number) => number;
  /** Sleep `ms`, resolving early when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Production clock: real `Date`, `performance.now`, `Math.random`, timer-sleep. */
export const REAL_CLOCK: LoopClock = {
  now: () => new Date(),
  monotonic: () => performance.now() / 1000,
  uniform: (lo, hi) => lo + Math.random() * (hi - lo),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const t = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(t);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }),
};

/**
 * Cap a no-scrape sleep at the multiplier poll sub-cadence (+ a small jitter) so a
 * parked account re-resolves its tier within ~one minute. Returns `sleepSec`
 * unchanged when it is already under the cap (a cold-boot or short idle delay).
 * NEVER applied to a post-scrape backoff — the /usage rate-limit retry must stay
 * long so a throttled endpoint is not re-hammered every poll.
 */
function capNoScrapeSleepSeconds(sleepSec: number, clock: LoopClock): number {
  const cap =
    MULTIPLIER_POLL_INTERVAL_S + clock.uniform(0, MULTIPLIER_POLL_JITTER_S);
  return Math.min(sleepSec, cap);
}

/**
 * Format a Date as local-time ISO 8601 with an explicit `±HH:MM` offset — the
 * SAME shape Python's `datetime.now().astimezone().isoformat()` writes (NOT
 * `toISOString()`'s `Z` form). The consumer + picker reject naive stamps, so the
 * offset-bearing local form is the cross-runtime canonical envelope shape.
 */
export function localIsoWithOffset(d: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  const ms = pad(d.getMilliseconds(), 3);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms}${offset}`
  );
}

// ---------- on-disk I/O (state dir, atomic write, events log) ---------------

/** Per-account paths under the resolved agentusage state root. */
function statePath(stateDir: string, id: string): string {
  return join(stateDir, `${id}.json`);
}
function errorPath(stateDir: string, id: string): string {
  return join(stateDir, `${id}.error.json`);
}

/**
 * Atomically replace `path` with `payload` serialized as pretty JSON + a trailing
 * newline — byte-compatible with Python's `json.dump(payload, f, indent=2)` + the
 * `f.write("\n")`. Temp file in the same dir, then `rename` (same-fs atomic swap).
 */
function writeAtomicJson(path: string, payload: unknown): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
    closeSync(fd);
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort
    }
    throw err;
  }
  renameSync(tmp, path);
}

/** Read a prior envelope; empty object on missing/corrupt. Mirrors `_load_envelope`. */
export function loadEnvelope(path: string): Record<string, unknown> {
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

/** Append one event line to `events.jsonl`. Failures are logged, never raised. */
function appendEvent(stateDir: string, payload: Record<string, unknown>): void {
  const path = join(stateDir, "events.jsonl");
  try {
    const fd = openSync(path, "a");
    try {
      writeSync(fd, `${JSON.stringify(payload)}\n`);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    console.error(
      `[usage-scraper] failed to append event: ${stringifyErr(err)}`,
    );
  }
}

// ---------- envelope builder ------------------------------------------------

/** Build a canonical-shape envelope. Every writer routes through here. */
export function buildEnvelope(
  acct: Account,
  fields: {
    status: "active" | "idle" | "stale";
    subscription_active: boolean | null;
    account_state: AccountState | null;
    usage: ScrapeUsage | null;
    lift_at: string | null;
    last_successful_fetch_at: string | null;
    last_skipped_fetch_at: string | null;
    last_failed_fetch_at: string | null;
    next_fetch_at: string;
    error: Envelope["error"];
  },
): Envelope {
  return {
    schema_version: ENVELOPE_SCHEMA_VERSION,
    id: acct.id,
    target: acct.target,
    multiplier: acct.multiplier,
    status: fields.status,
    subscription_active: fields.subscription_active,
    account_state: fields.account_state,
    last_successful_fetch_at: fields.last_successful_fetch_at,
    last_skipped_fetch_at: fields.last_skipped_fetch_at,
    last_failed_fetch_at: fields.last_failed_fetch_at,
    next_fetch_at: fields.next_fetch_at,
    usage: fields.usage,
    lift_at: fields.lift_at,
    error: fields.error,
  };
}

/** Read a string field off a prior envelope record, else null. */
function priorStr(prior: Record<string, unknown>, key: string): string | null {
  const v = prior[key];
  return typeof v === "string" ? v : null;
}

/** Read a finite numeric field off a prior envelope record, else null. */
function priorNum(prior: Record<string, unknown>, key: string): number | null {
  const v = prior[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * The freshness-floor bypass ({@link FORCED_SCRAPE_FLOOR_S}): true when the last
 * SUCCESSFUL scrape is STRICTLY older than the floor — or absent/unparseable (never
 * scraped, so force one). Strict `>` so an exactly-at-the-floor prior still parks;
 * the ~60s poll cadence makes `>` vs `>=` immaterial in production. Pure over `now`.
 */
export function forcedScrapeDue(
  prior: Record<string, unknown>,
  now: Date,
): boolean {
  const last = priorStr(prior, "last_successful_fetch_at");
  if (last === null) {
    return true;
  }
  const lastMs = new Date(last).getTime();
  if (Number.isNaN(lastMs)) {
    return true;
  }
  return (now.getTime() - lastMs) / 1000 > FORCED_SCRAPE_FLOOR_S;
}

/** Read the prior `usage` sub-object, else null. */
function priorUsage(prior: Record<string, unknown>): ScrapeUsage | null {
  return isRecord(prior.usage) ? (prior.usage as ScrapeUsage) : null;
}

/** Read the prior `subscription_active`, else null. */
function priorSubscription(prior: Record<string, unknown>): boolean | null {
  const v = prior.subscription_active;
  return v === true ? true : v === false ? false : null;
}

/** Read + validate the prior `account_state`, else null (garbage folds to null). */
function priorAccountState(
  prior: Record<string, unknown>,
): AccountState | null {
  return asAccountState(prior.account_state);
}

/** Read the prior `error` object, else null. */
function priorError(prior: Record<string, unknown>): Envelope["error"] {
  const e = prior.error;
  if (
    isRecord(e) &&
    typeof e.type === "string" &&
    typeof e.message === "string" &&
    typeof e.at === "string"
  ) {
    // A pre-classification (older keeper) prior carries no `kind` → null.
    return {
      type: e.type,
      message: e.message,
      at: e.at,
      kind: asUsageErrorKind(e.kind),
    };
  }
  return null;
}

/**
 * True iff a parked re-write would carry no new information — the on-disk prior is
 * already an `idle` heartbeat at the SAME multiplier. Suppressing the rewrite +
 * event keeps a multi-day cooldown (re-polling every ~60s) from churning the
 * envelope + growing the events log by ~1440 lines/day/account. Equality folds
 * both unresolved sides together: a null `acct.multiplier` matching a non-numeric
 * prior (`priorNum` → null) is a benign no-op suppress. A prior that DIFFERS —
 * two distinct numbers, or numeric⇄unresolved — is NOT redundant (the rewrite
 * refreshes it).
 */
function isRedundantParkedWake(
  prior: Record<string, unknown>,
  acct: Account,
): boolean {
  return (
    prior.status === "idle" && priorNum(prior, "multiplier") === acct.multiplier
  );
}

// ---------- profile gate ----------------------------------------------------

/**
 * The shared global launch gate — keeps profile launches >= 60s apart AND (held
 * with the per-target mutex) serializes live TUI processes globally. Held across
 * a `waitTurn()` await per the daemon's `_wait_for_profile_gate`.
 */
export class ProfileGate {
  private nextAllowedAt = 0;
  // A simple FIFO mutex so only one loop is inside `waitTurn` at a time.
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly clock: LoopClock) {}

  /**
   * Acquire the gate, sleep out any remaining `MIN_PROFILE_USE_INTERVAL_S`, bump
   * the next-allowed instant, and return a release fn. The caller MUST call the
   * returned release in a `finally`. Aborts cooperatively on `signal`.
   */
  async acquire(signal: AbortSignal): Promise<() => void> {
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const prior = this.chain;
    this.chain = this.chain.then(() => mine);
    await prior;
    const now = this.clock.monotonic();
    const waitFor = this.nextAllowedAt - now;
    if (waitFor > 0) {
      await this.clock.sleep(waitFor * 1000, signal);
    }
    this.nextAllowedAt = this.clock.monotonic() + MIN_PROFILE_USE_INTERVAL_S;
    return release;
  }
}

/** Per-target serialization: same-target scrapes never overlap. */
export class TargetMutex {
  private readonly chains = new Map<string, Promise<void>>();

  /** Run `fn` exclusively per `target`. Returns `fn`'s result. */
  async run<T>(target: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(target) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    this.chains.set(
      target,
      prior.then(() => mine),
    );
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

// ---------- per-account loop ------------------------------------------------

/** Dependencies one {@link AccountLoop} runs against — injectable for tests. */
export interface AccountLoopDeps {
  stateDir: string;
  clock: LoopClock;
  gate: ProfileGate;
  targets: TargetMutex;
  runScrape: ScrapeRunner;
  shutdownSignal: AbortSignal;
  /** Latest agent activity (epoch seconds) — injectable so tests force idle/active. */
  latestActivity?: () => number;
  /** Home dir the per-cycle tier re-resolve reads — injectable so tests sandbox it. */
  homeDir?: string;
}

/**
 * One account's scheduling loop — the ported `account_loop`. Runs CONTINUOUSLY
 * until `shutdownSignal` aborts. Each cycle: re-resolve the multiplier
 * (keep-prior on failure), then — UNLESS the resolved multiplier differs from the
 * on-disk envelope (a change forces a scrape so the corrected tier lands at once) —
 * run the cooldown + idle gates (writing an `idle` envelope + an `events.jsonl`
 * line on a skip), else scrape behind the per-target mutex + profile gate, assemble
 * + atomically write the envelope. The no-scrape sleeps (cooldown/idle/restart) are
 * capped at {@link MULTIPLIER_POLL_INTERVAL_S} so a parked account re-resolves its
 * multiplier within ~one minute; a redundant parked re-write (already idle at the
 * same multiplier) is suppressed so a long park doesn't grow the log. The WHOLE
 * cycle is no-throw: a scrape/IO failure writes a `stale` envelope + `.error.json` +
 * an event and continues — it NEVER escapes to the worker's error path.
 *
 * Exported + dependency-injected so a test drives a full cycle with a stub
 * `runScrape`, a pinned clock, and a sandboxed `stateDir` — no real `uv`/PTY.
 */
export class AccountLoop {
  constructor(
    private readonly acct: Account,
    private readonly deps: AccountLoopDeps,
  ) {}

  /** Restart-cheap initial delay: sleep out a prior future `next_fetch_at`. */
  initialDelaySeconds(): number {
    const { clock } = this.deps;
    const path = statePath(this.deps.stateDir, this.acct.id);
    if (!existsSync(path)) {
      return clock.uniform(0, 60);
    }
    const prior = loadEnvelope(path);
    const raw = prior.next_fetch_at;
    if (typeof raw !== "string") {
      return clock.uniform(0, 60);
    }
    const next = new Date(raw);
    if (Number.isNaN(next.getTime())) {
      return clock.uniform(0, 60);
    }
    const remaining = (next.getTime() - clock.now().getTime()) / 1000;
    // Cap a long prior next_fetch_at so a restart re-resolves the multiplier within
    // the poll window instead of sleeping out a multi-day cooldown.
    return remaining > 0
      ? capNoScrapeSleepSeconds(remaining, clock)
      : clock.uniform(0, 60);
  }

  /** Run forever (until shutdown). Each iteration is internally no-throw. */
  async run(): Promise<void> {
    const { clock, shutdownSignal } = this.deps;
    const initial = this.initialDelaySeconds();
    if (initial > 0) {
      await clock.sleep(initial * 1000, shutdownSignal);
    }
    while (!shutdownSignal.aborted) {
      const sleepSec = await this.runCycleNoThrow();
      if (shutdownSignal.aborted) {
        return;
      }
      if (sleepSec > 0) {
        await clock.sleep(sleepSec * 1000, shutdownSignal);
      }
    }
  }

  /**
   * One cycle. Returns the seconds to sleep before the next. Wraps {@link cycle}
   * so a throw NEVER escapes — defense in depth on top of `cycle`'s own internal
   * handling; the worker's `onerror`/`fatalExit` must never see a scrape bug.
   */
  async runCycleNoThrow(): Promise<number> {
    try {
      return await this.cycle();
    } catch (err) {
      console.error(
        `[usage-scraper] ${this.acct.id} cycle threw (non-fatal): ${stringifyErr(err)}`,
      );
      // Defensive cadence so a wedged cycle still backs off.
      return this.deps.clock.uniform(60, 180);
    }
  }

  /** The cycle body — see {@link run}. Internally handles scrape failure. */
  private async cycle(): Promise<number> {
    const { acct } = this;
    const { clock, stateDir } = this.deps;
    const path = statePath(stateDir, acct.id);
    const now = clock.now();

    // Re-resolve the tier multiplier every cycle (a mid-run plan change reaches
    // the envelope within one window). KEEP THE PRIOR on a null read — the
    // mutable `acct.multiplier` is the carrier, so a Max account never downgrades.
    if (acct.target === "claude") {
      reResolveMultiplier(acct, this.deps.homeDir);
    }

    // Idle / cooldown gates — only when a prior envelope exists AND it is not
    // `stale` (a failing account must keep retrying through quiet periods). A
    // multiplier change vs the ON-DISK prior (the frozen value) ALSO bypasses both
    // gates and forces a scrape so the corrected tier reaches the envelope at once.
    // Compare against the on-disk prior, NOT acct's pre-resolve value: boot already
    // corrects `acct.multiplier`, so an in-memory before/after compare never fires.
    // The freshness floor ({@link forcedScrapeDue}) is a THIRD bypass: a parked/idle
    // account still gets a real scrape once its last success ages past the floor, so
    // a provider-side quota reset before the derived `lift_at` is caught within one
    // floor window instead of coasting on stale usage until the predicted lift.
    if (existsSync(path)) {
      const prior = loadEnvelope(path);
      const priorMult = priorNum(prior, "multiplier");
      const multiplierChanged =
        priorMult !== null && priorMult !== acct.multiplier;
      if (
        !multiplierChanged &&
        !forcedScrapeDue(prior, now) &&
        prior.status !== "stale"
      ) {
        const cooldown = this.maybeCooldownSkip(prior, now);
        if (cooldown !== null) {
          return cooldown;
        }
        const idle = this.maybeIdleSkip(prior, now);
        if (idle !== null) {
          return idle;
        }
      }
    }

    // Scrape behind the per-target mutex + global profile gate.
    const result = await this.deps.targets.run(acct.target, async () => {
      const release = await this.deps.gate.acquire(this.deps.shutdownSignal);
      try {
        return await this.deps.runScrape(this.scrapeAccount());
      } finally {
        release();
      }
    });

    return this.handleResult(result, now);
  }

  /** Translate the account into the scrape util's request shape. */
  private scrapeAccount(): ScrapeAccount {
    return { target: this.acct.target, profile: this.acct.profile };
  }

  /**
   * Cooldown gate: if the prior envelope's `lift_at` is a future instant, skip the
   * scrape and re-check at/after the lift (+ jitter so a cohort doesn't hammer the
   * upstream at the same instant). Writes an `idle` envelope + an event. Returns
   * the seconds to sleep, or null when no cooldown applies.
   */
  private maybeCooldownSkip(
    prior: Record<string, unknown>,
    now: Date,
  ): number | null {
    const { clock } = this.deps;
    if (!liftIsInFuture(prior.lift_at, now)) {
      return null;
    }
    const liftMs = new Date(prior.lift_at as string).getTime();
    const wakeupMs = liftMs + clock.uniform(0, 60) * 1000;
    const wakeup = new Date(wakeupMs);
    // Suppress a redundant parked re-write so a multi-day cooldown re-polling every
    // ~60s doesn't churn the envelope + grow the events log; still re-poll soon.
    if (!isRedundantParkedWake(prior, this.acct)) {
      const envelope = buildEnvelope(this.acct, {
        status: "idle",
        subscription_active: priorSubscription(prior),
        account_state: priorAccountState(prior),
        usage: priorUsage(prior),
        lift_at: priorStr(prior, "lift_at"),
        last_successful_fetch_at: priorStr(prior, "last_successful_fetch_at"),
        last_skipped_fetch_at: localIsoWithOffset(now),
        last_failed_fetch_at: priorStr(prior, "last_failed_fetch_at"),
        next_fetch_at: localIsoWithOffset(wakeup),
        error: priorError(prior),
      });
      this.writeState(envelope);
      appendEvent(this.deps.stateDir, {
        ts: localIsoWithOffset(now),
        id: this.acct.id,
        target: this.acct.target,
        event: "rate_limited_skipped",
        lift_at: priorStr(prior, "lift_at"),
        next_fetch_at: envelope.next_fetch_at,
      });
    }
    // Cap the no-scrape sleep so the multiplier re-resolves within the poll window
    // even while parked — NOT the post-scrape backoffs (those stay long).
    const sleepFor = (wakeupMs - clock.now().getTime()) / 1000;
    return capNoScrapeSleepSeconds(Math.max(sleepFor, 0), clock);
  }

  /**
   * Idle gate: if no agent session log moved within `IDLE_THRESHOLD_S`, skip the
   * scrape (the prior usage values are still current — no quota burned). Writes an
   * `idle` heartbeat envelope + an event. Returns the seconds to sleep, or null.
   */
  private maybeIdleSkip(
    prior: Record<string, unknown>,
    now: Date,
  ): number | null {
    const { clock } = this.deps;
    const latest = (this.deps.latestActivity ?? latestAgentActivity)();
    const idleFor = clock.now().getTime() / 1000 - latest;
    if (idleFor <= IDLE_THRESHOLD_S) {
      return null;
    }
    // Cap the idle no-scrape sleep at the poll window so a re-resolved multiplier
    // reaches the envelope within ~60s even during a long idle stretch.
    const delay = capNoScrapeSleepSeconds(clock.uniform(60, 180), clock);
    // Suppress a redundant idle re-write (already idle at the same multiplier).
    if (!isRedundantParkedWake(prior, this.acct)) {
      const nextFetch = new Date(now.getTime() + delay * 1000);
      const envelope = buildEnvelope(this.acct, {
        status: "idle",
        subscription_active: priorSubscription(prior),
        account_state: priorAccountState(prior),
        usage: priorUsage(prior),
        lift_at: priorStr(prior, "lift_at"),
        last_successful_fetch_at: priorStr(prior, "last_successful_fetch_at"),
        last_skipped_fetch_at: localIsoWithOffset(now),
        last_failed_fetch_at: priorStr(prior, "last_failed_fetch_at"),
        next_fetch_at: localIsoWithOffset(nextFetch),
        error: priorError(prior),
      });
      this.writeState(envelope);
      appendEvent(this.deps.stateDir, {
        ts: localIsoWithOffset(now),
        id: this.acct.id,
        target: this.acct.target,
        event: "idle_skipped",
        idle_for_s: Math.round(idleFor * 10) / 10,
        next_fetch_at: envelope.next_fetch_at,
      });
    }
    return delay;
  }

  /** Branch the scrape result into success / no-sub / failure envelope writes. */
  private handleResult(result: ScrapeResult, now: Date): number {
    if (result.kind === "ok") {
      return this.handleSuccess(result, now);
    }
    // Both `error` (parse drift / panel never rendered) and `runner_failure`
    // (spawn/timeout/contract miss) write the `stale` failure envelope.
    return this.handleFailure(result, now);
  }

  /** Success arm: a fresh `active` envelope. lift_at is derived fresh, never carried. */
  private handleSuccess(
    result: Extract<ScrapeResult, { kind: "ok" }>,
    _now: Date,
  ): number {
    const { acct } = this;
    const { clock, stateDir } = this.deps;
    const fetchedAt = clock.now();
    const delay = clock.uniform(60, 180);
    const nextFetch = new Date(fetchedAt.getTime() + delay * 1000);
    const prior = loadEnvelope(statePath(stateDir, acct.id));

    // Three-way account axis: signed_out (logged out — no usage, no
    // subscription signal), no_subscription (logged in, no active plan), or
    // subscribed (account_state NULL). Codex only ever takes the subscribed
    // arm, so it stays account_state=NULL.
    let usage: ScrapeUsage | null;
    let subscriptionActive: boolean | null;
    let accountState: AccountState | null;
    if ("signed_out" in result) {
      usage = null;
      subscriptionActive = null;
      accountState = "signed_out";
    } else if (result.no_subscription) {
      usage = null;
      subscriptionActive = false;
      accountState = "no_subscription";
    } else {
      usage = result.usage;
      // Claude subscribed → true; codex has no subscription concept so it
      // carries whatever the contract said (null).
      subscriptionActive =
        acct.target === "claude" ? true : result.subscription_active;
      accountState = null;
    }
    const liftAt = deriveLiftAt(usage);

    const envelope = buildEnvelope(acct, {
      status: "active",
      subscription_active: subscriptionActive,
      account_state: accountState,
      usage,
      lift_at: liftAt,
      last_successful_fetch_at: localIsoWithOffset(fetchedAt),
      last_skipped_fetch_at: priorStr(prior, "last_skipped_fetch_at"),
      last_failed_fetch_at: priorStr(prior, "last_failed_fetch_at"),
      next_fetch_at: localIsoWithOffset(nextFetch),
      error: null,
    });
    this.writeState(envelope);
    // Clear the verbose error sidecar on success.
    try {
      unlinkSync(errorPath(stateDir, acct.id));
    } catch {
      // missing — fine.
    }
    appendEvent(stateDir, {
      ts: localIsoWithOffset(fetchedAt),
      id: acct.id,
      target: acct.target,
      event: "scraped",
      next_fetch_at: envelope.next_fetch_at,
      usage,
      subscription_active: subscriptionActive,
    });
    const sleepFor = (nextFetch.getTime() - clock.now().getTime()) / 1000;
    return sleepFor > 0 ? sleepFor : 0;
  }

  /**
   * Failure arm: write the verbose `<id>.error.json` sidecar (keeps the screen
   * excerpt) AND the concise `stale` main envelope (preserving last-good usage /
   * subscription / last_successful from prior). Never throws.
   */
  private handleFailure(
    result: Exclude<ScrapeResult, { kind: "ok" }>,
    _now: Date,
  ): number {
    const { acct } = this;
    const { clock, stateDir } = this.deps;
    const failedAt = clock.now();
    const delay = failureRetryDelaySeconds(result, clock);
    const nextFetch = new Date(failedAt.getTime() + delay * 1000);

    const { errorType, message, screenExcerpt, errorKind } =
      describeFailure(result);

    const errorEnvelope: Record<string, unknown> = {
      id: acct.id,
      target: acct.target,
      multiplier: acct.multiplier,
      failed_at: localIsoWithOffset(failedAt),
      error_kind: errorKind,
      error_type: errorType,
      message,
    };
    if (screenExcerpt.length > 0) {
      errorEnvelope.screen_excerpt = screenExcerpt;
    }
    try {
      writeAtomicJson(errorPath(stateDir, acct.id), errorEnvelope);
    } catch (err) {
      console.error(
        `[usage-scraper] ${acct.id} failed to write error file: ${stringifyErr(err)}`,
      );
    }

    const prior = loadEnvelope(statePath(stateDir, acct.id));
    const envelope = buildEnvelope(acct, {
      status: "stale",
      subscription_active: priorSubscription(prior),
      // Carry the stable account state forward so a transient scrape failure
      // does not flicker a signed-out / no-subscription account; the blip still
      // surfaces via the stale-error precedence.
      account_state: priorAccountState(prior),
      usage: priorUsage(prior),
      lift_at: priorStr(prior, "lift_at"),
      last_successful_fetch_at: priorStr(prior, "last_successful_fetch_at"),
      last_skipped_fetch_at: priorStr(prior, "last_skipped_fetch_at"),
      last_failed_fetch_at: localIsoWithOffset(failedAt),
      next_fetch_at: localIsoWithOffset(nextFetch),
      error: {
        type: errorType,
        message,
        at: localIsoWithOffset(failedAt),
        kind: errorKind,
      },
    });
    this.writeState(envelope);
    appendEvent(stateDir, {
      ts: localIsoWithOffset(failedAt),
      id: acct.id,
      target: acct.target,
      event: "scrape_failed",
      error_kind: errorKind,
      error_type: errorType,
      message,
      next_fetch_at: localIsoWithOffset(nextFetch),
      ...(screenExcerpt.length > 0 ? { screen_excerpt: screenExcerpt } : {}),
    });
    return delay;
  }

  /** Atomic state write, logged-not-raised on failure. */
  private writeState(envelope: Envelope): void {
    try {
      writeAtomicJson(statePath(this.deps.stateDir, this.acct.id), envelope);
    } catch (err) {
      console.error(
        `[usage-scraper] ${this.acct.id} failed to write envelope: ${stringifyErr(err)}`,
      );
    }
  }
}

/**
 * Normalize the two failure arms into `(errorType, message, screenExcerpt,
 * errorKind)`. The kind PREFERS the v2 contract's own `error_kind`; a runner
 * failure is always `runner_failed`; a v1 `error` arm (no `error_kind`) derives
 * a fallback from the exception class via {@link fallbackErrorKind}.
 */
function describeFailure(result: Exclude<ScrapeResult, { kind: "ok" }>): {
  errorType: string;
  message: string;
  screenExcerpt: string[];
  errorKind: UsageErrorKind;
} {
  if (result.kind === "error") {
    return {
      errorType: result.error_type,
      message: result.message,
      screenExcerpt: result.screen_excerpt,
      errorKind: result.error_kind ?? fallbackErrorKind(result.error_type),
    };
  }
  return {
    errorType: `runner_failure:${result.reason}`,
    message: result.message,
    screenExcerpt: [],
    errorKind: "runner_failed",
  };
}

/**
 * Derive an {@link UsageErrorKind} for a v1 `error` arm that carried no
 * `error_kind`, from the parser exception class name:
 *  - `ClaudeUsageEndpointRateLimited` → `upstream_limited` (the target's own
 *    `/usage` endpoint is throttled).
 *  - `*ParseError` (`ClaudeUsageParseError` / `CodexStatusParseError`) →
 *    `format_changed` (the panel rendered but didn't match the expected shape).
 *  - anything else (a scrape crash before/while rendering) → `scrape_failed`.
 *
 * `panel_missing` is NOT derivable from v1's collapsed exception family (the
 * parsers raise the same `*ParseError` for a never-rendered panel as for format
 * drift); only the v2 contract's explicit `error_kind` distinguishes it.
 */
function fallbackErrorKind(errorType: string): UsageErrorKind {
  if (errorType === "ClaudeUsageEndpointRateLimited") {
    return "upstream_limited";
  }
  if (errorType.endsWith("ParseError")) {
    return "format_changed";
  }
  return "scrape_failed";
}

function failureRetryDelaySeconds(
  result: Exclude<ScrapeResult, { kind: "ok" }>,
  clock: LoopClock,
): number {
  if (isUsageEndpointRateLimited(result)) {
    return clock.uniform(
      USAGE_ENDPOINT_RATE_LIMIT_RETRY_MIN_S,
      USAGE_ENDPOINT_RATE_LIMIT_RETRY_MAX_S,
    );
  }
  return clock.uniform(60, 180);
}

function isUsageEndpointRateLimited(
  result: Exclude<ScrapeResult, { kind: "ok" }>,
): boolean {
  if (result.kind !== "error") {
    return false;
  }
  return result.error_type === "ClaudeUsageEndpointRateLimited";
}

// ---------- worker data + entrypoint ----------------------------------------

/** Data the parent passes via `new Worker(url, { workerData })`. */
export interface UsageScraperWorkerData {
  dbPath: string;
  /** Resolved agentusage state root (the sandbox seam threads through here). */
  stateDir: string;
}

/**
 * Worker entrypoint. Opens a read-only keeper.db connection (worker-contract
 * convention; it holds no live keeper state), mkdirs the state root, acquires a
 * singleton FileLock on it so two producers never race the same files, builds the
 * accounts, and runs N concurrent {@link AccountLoop}s sharing one
 * {@link ProfileGate} + {@link TargetMutex}. Shutdown aborts every loop's sleep +
 * any in-flight scrape child (the scrape runner SIGKILLs its `uv` child on the
 * aborted-sleep deadline; the util `killpg`s its TUI grandchild), releases the
 * lock, closes the db, and exits 0.
 */
function main(): void {
  if (!parentPort) {
    console.error("[usage-scraper] no parentPort — not running as a Worker");
    process.exit(1);
  }
  const data = workerData as UsageScraperWorkerData | undefined;
  if (
    !data ||
    typeof data.dbPath !== "string" ||
    typeof data.stateDir !== "string" ||
    data.stateDir.length === 0
  ) {
    console.error("[usage-scraper] missing dbPath/stateDir in workerData");
    process.exit(1);
  }

  const { db } = openDb(data.dbPath, {
    readonly: true,
    prepareStmts: false,
    bootRetry: true,
  });

  const stateDir = data.stateDir;
  let lock: FileLock | null = null;
  try {
    mkdirSync(stateDir, { recursive: true });
    lock = FileLock.acquire(join(stateDir, "scraper.lock"));
  } catch (err) {
    // A held lock (another producer) or an unwritable root: warn + un-arm, never
    // crash-loop. Close the db and exit 0 — the daemon boots normally without us.
    console.error(
      `[usage-scraper] could not acquire state-dir lock at ${stateDir} (${stringifyErr(err)}); not producing`,
    );
    try {
      db.close();
    } catch {
      // best-effort
    }
    return;
  }

  const shutdownController = new AbortController();
  const clock = REAL_CLOCK;
  const gate = new ProfileGate(clock);
  const targets = new TargetMutex();

  const accounts = buildAccounts(resolveUsageModels());
  if (accounts.length === 0) {
    console.error("[usage-scraper] no accounts resolved; idling");
  }

  const loops = accounts.map((acct) =>
    new AccountLoop(acct, {
      stateDir,
      clock,
      gate,
      targets,
      runScrape,
      shutdownSignal: shutdownController.signal,
    }).run(),
  );
  // The loops run forever (until shutdown aborts their sleeps). A rejection is
  // already swallowed per-cycle; this is belt-and-suspenders so an unexpected
  // throw outside a cycle never surfaces as an unhandled rejection.
  Promise.all(loops).catch((err) => {
    console.error(
      `[usage-scraper] loop set settled unexpectedly: ${stringifyErr(err)}`,
    );
  });

  const releaseLock = (): void => {
    if (lock) {
      try {
        lock.release();
      } catch {
        // best-effort
      }
      lock = null;
    }
  };

  parentPort.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg && msg.type === "shutdown") {
      // Abort every loop's sleep + any in-flight scrape child (the runner's
      // sleep-bound deadline SIGKILLs the `uv` child), release the lock, close
      // the db, exit clean.
      shutdownController.abort();
      releaseLock();
      try {
        db.close();
      } catch {
        // best-effort
      }
      process.exit(0);
    }
  });
}

// Only run inside a real Worker; a plain import on the main thread (tests driving
// the pure helpers + AccountLoop with a stub runner) is inert.
if (!isMainThread) {
  main();
}

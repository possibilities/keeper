/**
 * Usage producer worker. keeperd's FIFTH file-watcher producer (after
 * transcript, plan, git) — watches the agentuse daemon's flat leaf state dir
 * `~/.local/state/agentuse/` for one `<id>.json` per profile, reads + parses
 * each on change, and posts typed snapshot/tombstone messages
 * (`{kind:"usage-snapshot"|"usage-deleted", ...}`) to the parent. The parent
 * (and only the parent) turns those messages into synthetic `UsageSnapshot` /
 * `UsageDeleted` `events` rows, which the reducer folds into the `usage`
 * projection. The worker never writes the DB — it opens a READ-ONLY
 * connection (for the restart-seed) and only posts messages, keeping main
 * the sole writer.
 *
 * Clones the producer-worker archetype verbatim from `src/plan-worker.ts`
 * (simplified — one fixed root, flat dir, no per-project nesting):
 * - `isMainThread`-guarded body — a plain `import` from a test is inert; the
 *   pure {@link UsageScanner} core is exported and drivable with no Worker or
 *   watcher.
 * - Own read-only `openDb(path, { readonly: true })` (handles are
 *   thread-affine; the parent hands us only path strings via `workerData`).
 * - Typed message protocol: `{ kind: ... }` worker→main, `{ type: "shutdown" }`
 *   main→worker. Exit `0` clean / `1` crash. NO in-process self-heal — only a
 *   genuine unrecoverable failure exits non-zero.
 * - Subsystem-style teardown: the `@parcel/watcher` subscription is an
 *   external resource the worker owns and `unsubscribe()`s in its shutdown
 *   handler. Terminate alone would leak the FSEvents/inotify fd.
 *
 * Watching strategy: ONE recursive `@parcel/watcher` subscribe on the agentuse
 * state dir, with EMPTY `ignore` (flat leaf dir, no `**` globs to worry about)
 * and an in-callback filename predicate `/^[a-z0-9-]+\.json$/` that rejects
 * `<id>.error.json` (extra dot segment), `server.stdout` / `server.stderr` (no
 * `.json` suffix), and any `<id>.json.tmp.*` temp artifacts the producer
 * leaves mid-rename. The classify-then-read-current-file pattern handles
 * agentuse's atomic `os.replace` writes — parcel surfaces them as `create`,
 * not `update`, so we route on filename + existence, never on `event.type`.
 *
 * Internal guards (skip-and-log, never escalate): a missing root is tolerated
 * (subscribe + scan both no-op until the dir appears — agentuse may never
 * have run yet), per-file read errors, oversize files, and torn/malformed
 * JSON all log to stderr and continue without emitting. Only an unrecoverable
 * failure (the addon failing to load) exits non-zero → daemon `fatalExit` →
 * launchd restart.
 *
 * Boot reconciliation: a file deleted while the daemon was DOWN never fires a
 * live `onDelete`, so it would leave a permanent projection ghost. After the
 * boot scan has populated {@link UsageScanner.markSeen}'s on-disk census,
 * {@link UsageScanner.sweep} retracts any projection id with no backing file.
 * Each retraction rides the same tombstone path (`usage-deleted`) as a live
 * delete — no new event types.
 *
 * **Freshness-exclusion discipline (load-bearing).** The source envelope
 * agentuse writes carries four freshness fields — `fetched_at`,
 * `next_fetch_at`, `last_successful_fetch_at`, `last_skipped_fetch_at` — that
 * refresh on every ~90s fetch cycle even when no real content has moved.
 * Including ANY of them in the change-gate hash (or in the projection schema)
 * would force a synthetic `UsageSnapshot` event every cycle and churn the
 * downstream wire collection. The change-gate here hashes ONLY the
 * projection-meaningful fields produced by {@link buildUsageMessage}, which
 * never carry the four freshness fields. A future contributor adding a
 * "freshness" column would have to route through both `buildUsageMessage`'s
 * field list AND the projection schema in `src/db.ts`; the freshness-
 * exclusion test in `test/usage-worker.test.ts` is the tripwire that fails
 * loudly if either changes.
 */

import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { AsyncSubscription } from "@parcel/watcher";
import { openDb } from "./db";
import { isDropError, RescanScheduler } from "./rescan";
import type { ShutdownMessage } from "./wake-worker";

/**
 * Data the parent passes via `new Worker(url, { workerData })`. Only path
 * strings cross the boundary — the Database handle and the subscription
 * cannot.
 */
export interface UsageWorkerData {
  dbPath: string;
  /**
   * The agentuse state directory to watch (flat leaf — one `<id>.json` per
   * profile). The parent resolves this from {@link resolveUsageRoot}. A
   * missing directory is tolerated (subscribe + scan both no-op until the
   * dir appears — agentuse may not have run yet).
   */
  root: string;
}

/** Snapshot message for one `~/.local/state/agentuse/<id>.json` file. */
export interface UsageSnapshotMessage {
  kind: "usage-snapshot";
  /** Agentuse profile id (the projection pk; rides in the synthetic event's session_id). */
  id: string;
  /**
   * Agent vendor target (`"claude"` / `"codex"` / ...). Stored opaque, never
   * used to drive logic here — display-only on the projection.
   */
  target: string | null;
  /** Plan tier multiplier (Pro=1, Max-5x=5, Max-20x=20, Codex=1). */
  multiplier: number | null;
  /**
   * Current session-window quota percent used (0-100). Null when the source
   * envelope is missing the `usage.session` sub-object — folds to NULL in
   * the projection per the "safe value" invariant.
   */
  session_percent: number | null;
  /** Session-window reset instant — ISO-8601 string when present, else null. */
  session_resets_at: string | null;
  /** Weekly quota percent used (0-100). Null when the source envelope is missing `usage.week`. */
  week_percent: number | null;
  /** Weekly reset instant — ISO-8601 string when present, else null. */
  week_resets_at: string | null;
  /**
   * Sonnet-specific weekly quota percent used (0-100). Only the claude
   * target's envelope carries `usage.sonnet_week`; codex omits it. Null
   * when the source envelope is missing the sub-object.
   */
  sonnet_week_percent: number | null;
  /** Sonnet-specific weekly reset instant — ISO-8601 string when present, else null. */
  sonnet_week_resets_at: string | null;
  /**
   * Envelope freshness/liveness axis (fn-645): `"active" | "idle" | "stale"`.
   * Stamped at write time by agentuse, never derived. Null when the envelope
   * omits the field (forward-compat / pre-fn-3 envelopes).
   */
  status: string | null;
  /**
   * Plan axis (fn-645): `true` = subscribed, `false` = confirmed no
   * subscription, `null` = unknown (codex; never observed yet). Carried as a
   * boolean here; the reducer coerces to 1/0/NULL on the SQLite column.
   */
  subscription_active: boolean | null;
  /**
   * Stale-only error type (fn-645) — the agentuse-side exception class name,
   * e.g. `"ClaudeUsageParseError"`. Present only when `status == "stale"`;
   * null otherwise.
   */
  error_type: string | null;
  /**
   * Stale-only error message (fn-645) — the matching human-readable
   * description. Present only when `status == "stale"`; null otherwise.
   */
  error_message: string | null;
  /**
   * Stale-only error timestamp (fn-645) — ISO-8601 with UTC offset, the
   * stamp of the failed scrape. Present only when `status == "stale"`;
   * null otherwise.
   *
   * **Change-gate exclusion.** `error.at` advances on every failed scrape
   * (~90s during an outage), so {@link usageGateKey} omits it from the
   * worker change-gate — the message still carries it (and the projection
   * still stores it) so the renderer can show "stale since <first
   * occurrence>", but a re-failed scrape with otherwise-unchanged error
   * details produces zero synthetic events. Recovery (stale→active) clears
   * the error_* columns because `status` IS in the gate, which flips and
   * fires one emit. This is the FIRST field that is projected but excluded
   * from the gate, distinct from the four freshness fields (which are
   * neither projected nor gated).
   */
  error_at: string | null;
}

/**
 * Tombstone message for a deleted `<id>.json` file. Main turns it into a
 * synthetic `UsageDeleted` event; the reducer DELETEs the `usage` row.
 */
export interface UsageDeletedMessage {
  kind: "usage-deleted";
  /** Agentuse profile id (the projection pk; rides in the synthetic event's session_id). */
  id: string;
}

/** Either snapshot or tombstone message the worker posts to the parent. */
export type UsageMessage = UsageSnapshotMessage | UsageDeletedMessage;

/**
 * Cap a usage file's size before `JSON.parse`. Usage JSONs live under the
 * user's `~/.local/state/` and are very small (a few hundred bytes); a
 * pathological/oversize file is skip-and-logged so a bad file never balloons
 * memory or stalls the callback. 1 MiB is far above any real agentuse
 * envelope.
 */
const MAX_USAGE_FILE_BYTES = 1024 * 1024;

/**
 * In-callback filename predicate — the in-tree filter the `@parcel/watcher`
 * `ignore` option can't express cleanly (we'd need a negation glob, which
 * parcel mishandles per parcel-bundler/watcher#174).
 *
 * Accepts: bare `<id>.json` (lowercase, digit, hyphen) — matches
 * `claude-default.json`, `claude-multi-1.json`, `codex.json`.
 *
 * Rejects:
 *   - `<id>.error.json`         — extra `.error.` dot segment (agentuse
 *                                 future surface for per-account scrape
 *                                 errors); explicitly not in our envelope.
 *   - `server.stdout` / `server.stderr` — no `.json` suffix; agentuse's
 *                                          daemon-side log files.
 *   - `events.jsonl`            — no `.json` suffix (the trailing `l` blocks);
 *                                 the agentuse-side audit log.
 *   - `<id>.json.tmp.*`         — temp artifacts the producer leaves
 *                                 mid-atomic-rename; the `^[a-z0-9-]+\.json$`
 *                                 anchor on the FULL basename rejects.
 *
 * Pure. Exported for unit reach.
 */
export function isUsageFilename(name: string): boolean {
  return /^[a-z0-9-]+\.json$/.test(name);
}

/**
 * Derive the agentuse profile id from a `<id>.json` filename. Returns the
 * basename minus `.json` when the filename passes {@link isUsageFilename},
 * else null. Pure.
 */
export function idFromUsagePath(path: string): string | null {
  const segments = path.split(sep);
  const base = segments[segments.length - 1];
  if (!isUsageFilename(base)) {
    return null;
  }
  return base.slice(0, -".json".length);
}

/** Raw agentuse envelope shape — only the fields we project. */
interface RawUsage {
  id?: unknown;
  target?: unknown;
  multiplier?: unknown;
  usage?: unknown;
  // fn-645: envelope freshness/plan/error axes — projected.
  status?: unknown;
  subscription_active?: unknown;
  error?: unknown;
  // Freshness fields — present in real agentuse envelopes, read and discarded.
  // `last_failed_fetch_at` joined this set under fn-645 (the stale `error`
  // sub-object carries the same info as `error.at`, projected instead).
  fetched_at?: unknown;
  next_fetch_at?: unknown;
  last_successful_fetch_at?: unknown;
  last_skipped_fetch_at?: unknown;
  last_failed_fetch_at?: unknown;
}

interface RawUsageWindow {
  percent_used?: unknown;
  resets_at?: unknown;
}

/** Raw shape of the agentuse envelope's stale `error` sub-object. */
interface RawUsageError {
  type?: unknown;
  message?: unknown;
  at?: unknown;
}

/** Coerce a value to a non-empty string, else null. */
function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Coerce a value to a finite number, else null. */
function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Coerce a value to an integer, else null. */
function asInteger(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build a `usage-snapshot` message from a parsed envelope JSON, or null when
 * the envelope has no usable id (the projection pk).
 *
 * **Slot order is load-bearing** — the change-gate compares `JSON.stringify`
 * output byte-for-byte, and {@link seedFromDb}'s reconstruction must produce
 * identical key order or every profile re-emits a synthetic `UsageSnapshot`
 * on every daemon boot. Mirrors the same discipline in `buildTaskMessage` /
 * `buildEpicMessage` (`src/plan-worker.ts`).
 *
 * **Freshness fields explicitly absent.** `fetched_at` / `next_fetch_at` /
 * `last_successful_fetch_at` / `last_skipped_fetch_at` are read by the worker
 * (when present) only to discard them; they do NOT enter the message, do NOT
 * enter the change-gate hash, do NOT enter the projection. Adding any of
 * them would force a synthetic event every ~90s fetch cycle.
 *
 * Missing `usage.session` / `usage.week` sub-objects fold to NULL on the
 * matching percent/resets_at fields per the "safe value" invariant — the
 * snapshot still emits.
 */
export function buildUsageMessage(raw: RawUsage): UsageSnapshotMessage | null {
  const id = asString(raw.id);
  if (id === null) {
    return null;
  }
  let sessionPercent: number | null = null;
  let sessionResetsAt: string | null = null;
  let weekPercent: number | null = null;
  let weekResetsAt: string | null = null;
  let sonnetWeekPercent: number | null = null;
  let sonnetWeekResetsAt: string | null = null;
  const usageBlock = raw.usage;
  if (usageBlock != null && typeof usageBlock === "object") {
    const u = usageBlock as {
      session?: unknown;
      week?: unknown;
      sonnet_week?: unknown;
    };
    if (u.session != null && typeof u.session === "object") {
      const s = u.session as RawUsageWindow;
      sessionPercent = asNumber(s.percent_used);
      sessionResetsAt = asString(s.resets_at);
    }
    if (u.week != null && typeof u.week === "object") {
      const w = u.week as RawUsageWindow;
      weekPercent = asNumber(w.percent_used);
      weekResetsAt = asString(w.resets_at);
    }
    if (u.sonnet_week != null && typeof u.sonnet_week === "object") {
      const sw = u.sonnet_week as RawUsageWindow;
      sonnetWeekPercent = asNumber(sw.percent_used);
      sonnetWeekResetsAt = asString(sw.resets_at);
    }
  }
  // fn-645: envelope freshness + plan + stale-error axes. `subscription_active`
  // is a true tri-state (true / false / null) — coerce only proper booleans;
  // anything else (including missing) folds to null. The `error` sub-object is
  // present only when `status == "stale"`; the projection columns mirror that.
  const subRaw = raw.subscription_active;
  const subscriptionActive: boolean | null =
    typeof subRaw === "boolean" ? subRaw : null;
  let errorType: string | null = null;
  let errorMessage: string | null = null;
  let errorAt: string | null = null;
  const errorBlock = raw.error;
  if (errorBlock != null && typeof errorBlock === "object") {
    const e = errorBlock as RawUsageError;
    errorType = asString(e.type);
    errorMessage = asString(e.message);
    errorAt = asString(e.at);
  }
  return {
    kind: "usage-snapshot",
    id,
    target: asString(raw.target),
    multiplier: asInteger(raw.multiplier),
    session_percent: sessionPercent,
    session_resets_at: sessionResetsAt,
    week_percent: weekPercent,
    week_resets_at: weekResetsAt,
    sonnet_week_percent: sonnetWeekPercent,
    sonnet_week_resets_at: sonnetWeekResetsAt,
    status: asString(raw.status),
    subscription_active: subscriptionActive,
    error_type: errorType,
    error_message: errorMessage,
    error_at: errorAt,
  };
}

/**
 * Serialize a usage message into the change-gate key — the byte-stable string
 * the worker compares to suppress re-emits for unchanged content.
 *
 * **fn-645: `error_at` exclusion.** Every other field is included in the gate
 * (and projected onto the wire), but `error_at` is omitted because it
 * advances on every failed scrape (~90s during an outage); including it
 * would force a synthetic event every cycle. Net semantics: "stale since the
 * first occurrence of this error" — the stamp holds while status / error_type
 * / error_message are unchanged, and re-stamps on a status flip (e.g. a
 * recovered scrape sets `status=active` + clears the error_* fields, both in
 * the gate) or on a different error.
 *
 * **Slot order is load-bearing** — {@link seedFromDb}'s reconstruction must
 * route through the SAME helper so a daemon restart's seed key matches the
 * live emit's key byte-for-byte. The other change-gate consumer (the
 * `onChange` path in {@link UsageScanner}) likewise routes through this
 * helper.
 *
 * Pure. Exported for unit reach (the freshness-exclusion tripwire test in
 * `test/usage-worker.test.ts`).
 */
export function usageGateKey(msg: UsageSnapshotMessage): string {
  const { error_at: _errorAt, ...gated } = msg;
  return JSON.stringify(gated);
}

/**
 * Pure, exported usage-file scanner — the deterministic core, drivable in
 * tests with no Worker or watcher. Mirrors {@link import("./plan-worker").PlanScanner}:
 *
 * - `onChange(path)` filters the basename ({@link isUsageFilename}), `fstat`s
 *   + bounds + reads + safe-parses the CURRENT file, derives the projection
 *   fields, and emits a `usage-snapshot` message via `onSnapshot` ONLY when
 *   the snapshot differs from the change-gate. A read-vs-delete race, an
 *   oversize file, a malformed/parse failure, or a missing id all
 *   skip-and-log WITHOUT emitting (keep last good).
 * - `onDelete(path)` emits a `usage-deleted` tombstone so the projection
 *   retracts, then drops the path's change-gate entry. A path that was never
 *   folded (no change-gate entry) emits nothing — there is nothing to retract.
 * - `markSeen(path)` records the path's id in the on-disk census the boot
 *   {@link sweep} diffs against.
 *
 * The change-gate is keyed by the agentuse id (the projection pk) and holds
 * the last-emitted serialized snapshot. {@link seedFromDb} primes it from the
 * `usage` projection so a daemon restart full-scan does not re-emit a
 * synthetic event per profile every boot.
 */
export class UsageScanner {
  /** id → last-emitted serialized snapshot (the change-gate). */
  private readonly lastEmitted = new Map<string, string>();
  /** path → id, so a delete can drop the right change-gate entry. */
  private readonly pathToId = new Map<string, string>();
  /**
   * Filename-derived id census from the boot scan. Keyed off the FILENAME
   * (not a parse result) so a file mid-rewrite that momentarily fails to
   * parse is still "seen" and never spuriously retracted by {@link sweep}.
   */
  private readonly seenOnDisk = new Set<string>();

  constructor(
    private readonly onSnapshot: (msg: UsageMessage) => void,
    private readonly log: (msg: string) => void = (m) => console.error(m),
  ) {}

  /**
   * Seed the change-gate for one entity from the persisted projection so an
   * unchanged file on restart does not re-emit. The seed value MUST match
   * the serialization {@link buildUsageMessage} produces for the same row —
   * {@link seedFromDb} reconstructs the message from projection columns and
   * serializes it the same way.
   */
  seed(id: string, serialized: string): void {
    this.lastEmitted.set(id, serialized);
  }

  /**
   * Record that an agentuse `<id>.json` file was enumerated on disk during a
   * boot scan — the on-disk census {@link sweep} diffs against. Called from
   * the boot-scan loop for EVERY file BEFORE `onChange`, so it counts
   * regardless of whether the snapshot parsed or was change-gate-suppressed.
   *
   * The id is derived from the filename (via {@link idFromUsagePath}); keying
   * off the name (not a parse) means a file mid-rewrite that momentarily
   * fails to parse is still "seen" and never spuriously retracted. A
   * non-matching path is ignored.
   */
  markSeen(path: string): void {
    const id = idFromUsagePath(path);
    if (id !== null) {
      this.seenOnDisk.add(id);
    }
  }

  /**
   * Process a change for `path`. Filename-filter → reads (bounded) →
   * safe-parses → derives → change-gates → emits. Any failure skips-and-logs
   * without emitting.
   */
  onChange(path: string): void {
    const id = idFromUsagePath(path);
    if (id === null) {
      return; // filename predicate rejected — not a usage file we care about.
    }

    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch (err) {
      // Read-vs-delete race (file vanished between watch event and stat):
      // skip-and-log, keep last good, don't emit.
      this.log(`[usage-worker] stat failed for ${path}: ${stringifyErr(err)}`);
      return;
    }
    if (!st.isFile()) {
      return;
    }
    if (st.size > MAX_USAGE_FILE_BYTES) {
      this.log(
        `[usage-worker] ${path} exceeds ${MAX_USAGE_FILE_BYTES} bytes (${st.size}); skipping`,
      );
      return;
    }

    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      this.log(`[usage-worker] read failed for ${path}: ${stringifyErr(err)}`);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.log(
        `[usage-worker] malformed JSON in ${path}: ${stringifyErr(err)}`,
      );
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      this.log(`[usage-worker] non-object JSON in ${path}; skipping`);
      return;
    }

    const msg = buildUsageMessage(parsed as RawUsage);
    if (msg === null) {
      // No usable id — can't key the projection.
      this.log(`[usage-worker] ${path} has no usable id; skipping`);
      return;
    }

    this.pathToId.set(path, msg.id);
    // fn-645: the gate key omits `error_at` so a re-failed scrape with the
    // same error type/message doesn't fire a synthetic event every ~90s.
    // `onSnapshot` still posts the FULL message (carrying `error_at`) so the
    // projection can show "stale since <first occurrence>".
    const gateKey = usageGateKey(msg);
    if (this.lastEmitted.get(msg.id) === gateKey) {
      return; // change-gate: unchanged snapshot, suppress.
    }
    this.lastEmitted.set(msg.id, gateKey);
    this.onSnapshot(msg);
  }

  /**
   * Process a delete for `path`. Emits a tombstone so the projection
   * retracts, then drops the change-gate entry (so a re-created file
   * re-emits). A path with no change-gate entry (never folded) emits nothing
   * — nothing to retract.
   */
  onDelete(path: string): void {
    const id = this.pathToId.get(path);
    if (id === undefined) {
      return; // never folded this path — nothing to retract.
    }
    this.onSnapshot({ kind: "usage-deleted", id });
    this.pathToId.delete(path);
    this.lastEmitted.delete(id);
  }

  /**
   * Boot-reconciliation sweep. After the boot scan has run (so
   * {@link seenOnDisk} is the complete on-disk census), retract any
   * projection id with no backing file — a deletion that happened while the
   * daemon was down never fired a live `onDelete`, so without this pass it
   * would leave a permanent ghost. Mirrors plan-worker's {@link import("./plan-worker").PlanScanner.sweep}
   * — simplified because there is no per-root scope (one fixed root, every
   * row in the `usage` table is in scope).
   *
   * Run AFTER snapshot emission so a moved/rewritten file is re-emitted, not
   * spuriously retracted. The change-gate entry is dropped after each
   * tombstone, mirroring {@link onDelete}.
   *
   * Read-only: uses the worker's own read-only connection.
   */
  sweep(db: Database): void {
    const rows = db.query("SELECT id FROM usage").all() as { id: string }[];
    for (const row of rows) {
      if (this.seenOnDisk.has(row.id)) {
        continue;
      }
      this.onSnapshot({ kind: "usage-deleted", id: row.id });
      this.lastEmitted.delete(row.id);
    }
  }
}

/**
 * Boot scan: enumerate `<id>.json` files at `root` and run each through the
 * scanner. Flat leaf dir — no recursion. Called once after the subscribe
 * resolves so files that pre-existed the daemon's boot are picked up without
 * waiting for a watcher event. The change-gate in {@link UsageScanner}
 * suppresses re-emits for files that already match the seeded projection
 * row. A missing root is treated as empty (no files, no work) — agentuse may
 * never have run yet. Exported for unit reach.
 */
export function scanRoot(root: string, scanner: UsageScanner): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    // Missing/unreadable root — nothing to scan. The live watcher path
    // tolerates absence too; first appearance triggers a re-scan via the
    // drop-recovery scheduler.
    return;
  }
  for (const name of names) {
    if (!isUsageFilename(name)) {
      continue;
    }
    const full = join(root, name);
    // Record the on-disk census FIRST (filename-keyed, parse-independent),
    // then run the snapshot read. The sweep diffs the projection against
    // this census; marking before onChange keeps a mid-rewrite parse failure
    // from looking "absent".
    scanner.markSeen(full);
    scanner.onChange(full);
  }
}

/**
 * Seed the scanner's change-gate from the keeper DB: for each persisted
 * `usage` row, reconstruct the message the scanner would emit for that row
 * and seed its serialized form. A daemon restart's full re-scan does not
 * re-emit a synthetic event for a profile that is byte-identical to its
 * already-folded projection row.
 *
 * **Slot order MUST match {@link buildUsageMessage}** field-for-field, since
 * the change-gate compares serialized messages. Any drift here re-emits a
 * synthetic event for every profile on every boot.
 *
 * Read-only — uses the worker's own read-only connection. Exported for the
 * worker `main` and unit reach.
 */
export function seedFromDb(db: Database, scanner: UsageScanner): void {
  const rows = db
    .query(
      `SELECT id, target, multiplier, session_percent, session_resets_at,
              week_percent, week_resets_at, sonnet_week_percent,
              sonnet_week_resets_at, status, subscription_active,
              error_type, error_message, error_at
         FROM usage`,
    )
    .all() as {
    id: string;
    target: string | null;
    multiplier: number | null;
    session_percent: number | null;
    session_resets_at: string | null;
    week_percent: number | null;
    week_resets_at: string | null;
    sonnet_week_percent: number | null;
    sonnet_week_resets_at: string | null;
    status: string | null;
    subscription_active: number | null;
    error_type: string | null;
    error_message: string | null;
    error_at: string | null;
  }[];
  for (const r of rows) {
    // SQLite stores `subscription_active` as 1/0/NULL — reconstruct the
    // boolean shape `buildUsageMessage` emits so the gate key matches
    // byte-for-byte.
    const sub: boolean | null =
      r.subscription_active === null ? null : r.subscription_active !== 0;
    const msg: UsageSnapshotMessage = {
      kind: "usage-snapshot",
      id: r.id,
      target: r.target,
      multiplier: r.multiplier,
      session_percent: r.session_percent,
      session_resets_at: r.session_resets_at,
      week_percent: r.week_percent,
      week_resets_at: r.week_resets_at,
      sonnet_week_percent: r.sonnet_week_percent,
      sonnet_week_resets_at: r.sonnet_week_resets_at,
      status: r.status,
      subscription_active: sub,
      error_type: r.error_type,
      error_message: r.error_message,
      error_at: r.error_at,
    };
    scanner.seed(r.id, usageGateKey(msg));
  }
}

/**
 * Worker entrypoint. Opens its own read-only connection, seeds the
 * change-gate, subscribes ONE recursive watch on the agentuse state dir
 * (tolerates absence), routes each change event into the scanner, and posts
 * a snapshot/tombstone message per changed file. The subscription is an
 * owned external resource — `unsubscribe()`d in the shutdown handler.
 */
function main(): void {
  if (!parentPort) {
    console.error("[usage-worker] no parentPort — not running as a Worker");
    process.exit(1);
  }

  const data = workerData as UsageWorkerData | undefined;
  if (
    !data ||
    typeof data.dbPath !== "string" ||
    typeof data.root !== "string"
  ) {
    console.error("[usage-worker] missing dbPath/root in workerData");
    process.exit(1);
  }

  const { db } = openDb(data.dbPath, { readonly: true });
  const port = parentPort;
  const scanner = new UsageScanner((msg) => {
    port.postMessage(msg);
  });

  // Restart-seed: don't re-emit a snapshot already folded into the projection.
  try {
    seedFromDb(db, scanner);
  } catch (err) {
    // Non-fatal: worst case a stale snapshot re-emits once (the reducer's
    // idempotent upsert makes that a no-op anyway).
    console.error(`[usage-worker] restart-seed failed: ${stringifyErr(err)}`);
  }

  let subscription: AsyncSubscription | null = null;
  let scheduler: RescanScheduler | null = null;
  let shuttingDown = false;

  const closeDb = (): void => {
    try {
      db.close();
    } catch {
      // best-effort; exiting either way
    }
  };

  parentPort.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg && msg.type === "shutdown") {
      shuttingDown = true;
      // Clear armed drop-recovery timer FIRST so a pending re-scan can't fire
      // against a closing connection.
      if (scheduler !== null) {
        scheduler.cancel();
        scheduler = null;
      }
      // Release the subscription (external resource), then the db, then exit
      // clean. Mirrors plan-worker's teardown pattern.
      void (async () => {
        if (subscription !== null) {
          try {
            await subscription.unsubscribe();
          } catch {
            // best-effort
          }
          subscription = null;
        }
        closeDb();
        process.exit(0);
      })();
    }
  });

  void import("@parcel/watcher")
    .then((watcher) => {
      // Tolerate a missing root: agentuse may never have run, in which case
      // `~/.local/state/agentuse/` doesn't exist yet. Skip subscribe + scan;
      // when (if) the dir appears, the next daemon restart picks it up. A
      // live-mount feature would need a parent-dir watch — out of scope here.
      if (!existsSync(data.root)) {
        console.error(
          `[usage-worker] root ${data.root} does not exist; not watching (agentuse may not have run yet)`,
        );
        return;
      }

      // Drop-recovery scheduler: a recoverable FSEvents drop schedules a
      // debounced, single-flight re-scan via the change-gated boot-scan
      // primitive (scanRoot) — never an unsubscribe+re-subscribe (the
      // subscription stays alive; re-subscribing would open a no-watch gap).
      // The warm in-memory change-gate suppresses re-emits for unchanged
      // files, so recovery is idempotent. The scan re-checks `shuttingDown`
      // so a queued scan can't touch a closing DB.
      const rescan = new RescanScheduler(() => {
        if (shuttingDown) {
          return;
        }
        scanRoot(data.root, scanner);
      });
      scheduler = rescan;

      watcher
        .subscribe(
          data.root,
          (err, events) => {
            if (err) {
              // Always leave a breadcrumb so a future @parcel/watcher wording
              // change (the drop discriminator couples to its message text)
              // is observable in the logs.
              console.error(
                `[usage-worker] watcher error for ${data.root}: ${stringifyErr(err)}`,
              );
              // A recoverable FSEvents drop ("...must be re-scanned"): the
              // lost change may never re-fire, so schedule a debounced
              // re-scan. A non-drop err keeps swallow-and-log.
              if (isDropError(err)) {
                rescan.schedule();
              }
              return;
            }
            for (const ev of events) {
              // In-callback filename filter is the correctness gate — empty
              // `ignore` glob list (flat leaf dir, nothing to prune at the
              // watcher layer; no negated patterns per parcel #174). Route
              // on filename + existence, NOT event.type (agentuse writes via
              // atomic os.replace, so an update may surface as create).
              if (ev.type === "delete") {
                scanner.onDelete(ev.path);
                continue;
              }
              scanner.onChange(ev.path);
            }
          },
          { ignore: [] },
        )
        .then((sub) => {
          if (shuttingDown) {
            // Shutdown raced the subscribe resolution — release immediately.
            void sub.unsubscribe();
            return;
          }
          subscription = sub;
          // Boot scan: pick up files that pre-existed this daemon's start
          // (or were changed while keeperd was down) without waiting for a
          // watcher event. The change-gate suppresses unchanged files.
          scanRoot(data.root, scanner);
          // On-disk census is now recorded; run the boot-reconciliation
          // sweep so projection ghosts (files deleted while down) retract.
          try {
            scanner.sweep(db);
          } catch (err) {
            console.error(
              `[usage-worker] boot sweep failed: ${stringifyErr(err)}`,
            );
          }
        })
        .catch((err) => {
          // Subscribe failure: log and continue without a live watch. The
          // boot scan already ran nothing (we didn't reach scanRoot); the
          // worker stays alive until shutdown.
          console.error(
            `[usage-worker] failed to subscribe to ${data.root}: ${stringifyErr(err)}`,
          );
        });
    })
    .catch((err) => {
      // The addon itself failed to load — the sole unrecoverable surface.
      console.error(
        `[usage-worker] failed to load @parcel/watcher: ${stringifyErr(err)}`,
      );
      closeDb();
      process.exit(1);
    });
}

// Only run inside a real Worker; a plain import on the main thread (tests
// driving the pure UsageScanner) is inert.
if (!isMainThread) {
  main();
}

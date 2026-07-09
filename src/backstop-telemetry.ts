/**
 * Backstop telemetry channel (epic fn-720) — the uniform structured record
 * every keeper change-propagation backstop emits when it fires, tagged with
 * whether it actually RESCUED a missed fast path.
 *
 * Keeper has ~6 change-propagation paths (plan/git/transcript workers,
 * autopilot, pending-dispatch sweep, FSEvents-drop rescans). Each has a fast
 * path (`data_version` poll, post-fold kick, FSEvents) backed by a slow
 * "should-never-fire" heartbeat / ceiling fallback. When a fast path silently
 * drops a wake-up, the slow backstop rescues it — producing the operator's
 * 30–60s stalls. This module makes those rescues VISIBLE and COUNTABLE.
 *
 * Topology (wired by `.2`/`.3`, foundation only here): each worker maintains
 * `last_fast_path_at` in-memory and in-memory counters per (backstop,class)
 * via {@link BackstopCounters}. On a backstop fire the worker
 * `postMessage({kind:"backstop", ...})`s up to main; **main is the SOLE
 * writer** of the single sidecar (matches the CLAUDE.md sole-writer rule;
 * avoids torn concurrent appends), calling {@link appendBackstopRecord}.
 *
 * Volume control: a full {@link BackstopRecord} is written on every RESCUE;
 * no-op fires only bump the in-memory counter and surface as a periodic +
 * on-shutdown {@link BackstopRollup} so the denominator survives without a
 * line per 5s no-op. The loud human stderr ALARM is rate-limited via
 * {@link BackstopRateLimiter}; the NDJSON record + counters are NEVER
 * rate-limited (the metric stays complete).
 *
 * OBSERVABILITY-ONLY: zero behavior change, no synthetic events, no
 * schema bump and no reducer change. The sidecar is a pure consumer-side
 * side-file — never read by the reducer, never feeds a projection. The writer
 * mirrors `src/readiness-diagnostics.ts`
 * `appendDiagnostic` near-verbatim (single appendFileSync, swallow-to-stderr,
 * never throws).
 */

import { appendFileSync } from "node:fs";

/**
 * The fire CLASS. A backstop is either a missed-wake rescue (a fast-path
 * signal was dropped and the slow heartbeat re-converged) or a timeout
 * (an elapsed-since-dispatch ceiling fired with no fast-path notion).
 */
export type BackstopClass = "missed-wake" | "timeout";

/**
 * Which backstop fired. Stable string set so a `grep`/`jq` aggregation can
 * bucket by name. Extend (don't rename) when a new backstop is wired.
 */
export type BackstopName =
  | "plan-heartbeat"
  | "git-heartbeat"
  | "transcript-heartbeat"
  | "rescan-drop"
  | "autopilot-ceiling"
  | "pending-dispatch-sweep"
  // fn-762: a poison NDJSON line parked in `dead_letters` by the events-log
  // ingester (`scanEventsLogDir`). NOT a missed-wake / TTL rescue — it records
  // that the ingester quarantined an unparseable line and advanced past it
  // (rather than silently wedging the file at that offset). Counted/emitted via
  // the same sole-writer sidecar path as `pending-dispatch-sweep`.
  | "events-ingest-poison"
  // fn-1103: a malformed birth record parked in `dead_letters` by the births
  // ingester (`scanBirthDir`) — the non-hook presence channel's analogue of
  // `events-ingest-poison`. Records that the ingester quarantined an unparseable
  // (or perpetually-mint-failing) record and retired it, rather than wedging the
  // scan. Same sole-writer sidecar path.
  | "birth-ingest-poison"
  // fn-1096.3: a transient `SQLITE_NOTADB` tolerated (tick skipped, not a
  // crash) by `NotadbTolerance` on a `PRAGMA data_version` poll — see
  // `src/notadb-tolerance.ts`. One shared name across every poll site;
  // `worker` disambiguates which poller, `detail.consecutive_misses` carries
  // the running miss count for that site.
  | "notadb-skip";

/**
 * Which worker thread (or main) produced the fire. The worker maintains the
 * in-memory `last_fast_path_at` + counters and posts the record up; main is
 * the sole sidecar writer.
 */
export type BackstopWorker =
  | "plan-worker"
  | "git-worker"
  | "transcript-worker"
  | "autopilot-worker"
  // fn-1096.3: the remaining `PRAGMA data_version` pollers, wired for
  // `notadb-skip` telemetry alongside the four above.
  | "exit-watcher"
  | "wake-worker"
  | "server-worker"
  | "main";

/**
 * One backstop-fire record (NDJSON, one JSON object per line). Written ONLY
 * on a genuine RESCUE (`rescued:true`) — a no-op fire bumps the in-memory
 * counter and is summarized by a {@link BackstopRollup} instead, so the plan
 * heartbeat (5s) doesn't write ~17k no-op lines/day.
 *
 * - `ts` — producer wall-clock epoch ms (legal: outside any fold).
 * - `kind` — stable envelope discriminator (readiness-diagnostics convention).
 * - `class` — {@link BackstopClass}.
 * - `backstop` — {@link BackstopName}.
 * - `worker` — {@link BackstopWorker}.
 * - `fast_path` — the expected fast path that was missed; `null` for the
 *   `timeout` class (no fast-path notion).
 * - `rescued` — `true` here by construction (records are written on rescue);
 *   the field is carried explicitly so the line is self-describing and a
 *   future no-op-line variant stays schema-compatible.
 * - `staleness_ms` — missed-wake: `now − last_fast_path_at`; timeout:
 *   elapsed-since-dispatch; `null` when unknown (e.g. cold boot). Kept emitting
 *   alongside `change_to_rescue_ms` (fn-771) for a before/after shakeout
 *   comparison — `staleness_ms` measures idleness-since-last-fast-path (inflates
 *   with quiet minutes), `change_to_rescue_ms` measures true change-to-rescue
 *   latency (the honest freshness signal).
 * - `last_fast_path_at` — epoch ms of the last confirmed fast-path fire;
 *   `null` for the `timeout` class and cold boot.
 * - `change_to_rescue_ms` — fn-771: for a `missed-wake` rescue that discharged
 *   a HEAD-oid delta, the true `now − committed_at_ms` latency from the rescued
 *   change actually landing to the heartbeat catching it (worst-case / oldest
 *   commit when several discharge in one rescue). `null` when there is no commit
 *   anchor (a dirty-tree-only rescue) or the value would be negative (clock
 *   skew — clamped, never emitted negative; a negative would poison the
 *   histogram exactly like the `staleness_ms` idle-inflation bug being fixed).
 *   OPTIONAL — the field is OMITTED entirely for the other backstop-emitting
 *   call sites (non-git backstops never fabricate a latency); a record without
 *   it parses as `null`, so mixed-version ndjson is the steady state.
 * - `reflog_watch` — fn-737 per-wake-path attribution: was a `.git/logs/HEAD`
 *   reflog watch ARMED for the rescued repo at fire time (`present`) or not
 *   (`absent`)? The prime-suspect slow path is a commit in a no-pending repo →
 *   no reflog watch → invisible until the heartbeat, so this field names which
 *   FSEvents commit signal was (un)available. Omitted when the backstop has no
 *   per-repo notion (cold boot, or a fire not scoped to one repo).
 * - `recent_fast_paths` — fn-737 per-wake-path attribution: which fast paths
 *   stamped {@link buildMissedWakeRecord}'s `lastFastPathAt` recently (within
 *   the attribution window), most-recent first. Disambiguates a heartbeat that
 *   mis-attributes to `data_version_poll` when the real miss was a no-reflog-
 *   watch commit. Omitted when no fast path has fired in the window.
 * - `detail` — optional, small `{path|job_id|verb}` for triage; NEVER raw
 *   payloads or plan content.
 */
export type BackstopRecord = {
  ts: number;
  kind: "backstop-rescue";
  class: BackstopClass;
  backstop: BackstopName;
  worker: BackstopWorker;
  fast_path: string | null;
  rescued: boolean;
  staleness_ms: number | null;
  last_fast_path_at: number | null;
  change_to_rescue_ms?: number | null;
  reflog_watch?: "present" | "absent";
  recent_fast_paths?: string[];
  detail?: Record<string, string>;
};

/**
 * The denominator rollup. Carries the running `fires_total` / `rescues_total`
 * per (backstop,class) so `scripts/backstop-stats.ts` (task `.4`) can compute
 * a true rescue RATE (rescues ÷ total fires) instead of a survivorship-biased
 * count. Written periodically and on shutdown — never per no-op fire.
 */
export type BackstopRollup = {
  ts: number;
  kind: "backstop-rollup";
  backstop: BackstopName;
  class: BackstopClass;
  fires_total: number;
  rescues_total: number;
};

/**
 * Worker→main message carrying a backstop record or rollup up to main (the
 * sole sidecar writer). Tagged `{kind:"backstop"}` to slot alongside the
 * existing worker→main `{kind}` discriminators. Workers maintain their own
 * {@link BackstopCounters} + `last_fast_path_at` in-memory and post the
 * already-built {@link BackstopRecord}/{@link BackstopRollup} up; main does
 * NOT re-count — it only writes the line via {@link appendBackstopRecord}.
 * Defined here as the shared contract every backstop-emitting worker (wired
 * in tasks `.2`/`.3`) imports.
 */
export type BackstopMessage = {
  kind: "backstop";
  record: BackstopRecord | BackstopRollup;
};

/** Stable JSON key for a (backstop,class) counter pair. */
function counterKey(backstop: BackstopName, cls: BackstopClass): string {
  return `${backstop} ${cls}`;
}

/**
 * Build the uniform `missed-wake` {@link BackstopRecord} a worker's slow
 * backstop (heartbeat / FSEvents-drop rescan) posts up to main when it fires.
 * Pure — `now` and `lastFastPathAt` are injected (a producer wall-clock read,
 * legal outside any fold; tests pass a synthetic clock), so the four wired
 * workers (tasks `.2`/`.3`) all derive the same shape from one place.
 *
 * Cold-boot sentinel (the epic's flagged risk): when `lastFastPathAt` is `null`
 * — no confirmed fast path has fired yet this process life — `staleness_ms` is
 * `null`, NOT `now − 0` (a ~epoch-sized false-alarm staleness that would poison
 * the histogram). `last_fast_path_at` is carried through verbatim (also `null`
 * on cold boot), so a reader can distinguish a cold-boot fire from a real
 * missed-wake rescue.
 *
 * `rescued` is the denominator-defining boolean: `true` when the change-gated
 * scan actually emitted (a fast path missed a real change), `false` when the
 * backstop fired but had nothing to rescue (the no-op fire the caller counts
 * but does NOT necessarily write — see the volume-control note on
 * {@link BackstopRecord}).
 */
export function buildMissedWakeRecord(args: {
  backstop: BackstopName;
  worker: BackstopWorker;
  fastPath: string;
  rescued: boolean;
  now: number;
  lastFastPathAt: number | null;
  /**
   * fn-771: the true change-to-rescue latency (`now − committed_at_ms` of the
   * rescued change, worst-case / oldest commit). OPTIONAL — omitted (`undefined`)
   * by every non-git backstop call site so the legacy record shape stays exact
   * and no non-commit backstop fabricates a latency. `null` when the producer
   * had no commit anchor (dirty-tree-only rescue). A NEGATIVE value (clock skew:
   * `committed_at_ms > now`) is CLAMPED to `null` — never emitted negative,
   * which would poison the histogram exactly like the idle-inflation bug this
   * field replaces. The field is emitted (present, possibly `null`) whenever the
   * arg is provided at all, so a git-heartbeat rescue always carries it.
   */
  changeToRescueMs?: number | null;
  /**
   * fn-737 per-wake-path attribution: whether a `.git/logs/HEAD` reflog watch
   * was ARMED for the rescued repo at fire time. Omitted (field absent) when
   * the backstop has no per-repo notion — keeps the legacy record shape exact
   * for an un-attributed fire.
   */
  reflogWatch?: "present" | "absent";
  /**
   * fn-737 per-wake-path attribution: the fast-path labels that recently
   * stamped `lastFastPathAt`, most-recent first. Omitted when empty so an
   * un-attributed fire keeps the legacy shape.
   */
  recentFastPaths?: string[];
  detail?: Record<string, string>;
}): BackstopRecord {
  const staleness =
    args.lastFastPathAt === null ? null : args.now - args.lastFastPathAt;
  const rec: BackstopRecord = {
    ts: args.now,
    kind: "backstop-rescue",
    class: "missed-wake",
    backstop: args.backstop,
    worker: args.worker,
    fast_path: args.fastPath,
    rescued: args.rescued,
    staleness_ms: staleness,
    last_fast_path_at: args.lastFastPathAt,
  };
  if (args.changeToRescueMs !== undefined) {
    // Present-with-value whenever the producer supplied the arg. Clamp a
    // negative (clock skew) to null — never emit a negative latency.
    rec.change_to_rescue_ms =
      args.changeToRescueMs !== null && args.changeToRescueMs >= 0
        ? args.changeToRescueMs
        : null;
  }
  if (args.reflogWatch !== undefined) {
    rec.reflog_watch = args.reflogWatch;
  }
  if (args.recentFastPaths !== undefined && args.recentFastPaths.length > 0) {
    rec.recent_fast_paths = args.recentFastPaths;
  }
  if (args.detail !== undefined) {
    rec.detail = args.detail;
  }
  return rec;
}

/**
 * Build the uniform `timeout` {@link BackstopRecord} a timeout-class backstop
 * (the autopilot `confirmRunning` ceiling, the pending-dispatch TTL sweep)
 * posts up to main when it fires. The `timeout` class is categorically
 * distinct from {@link buildMissedWakeRecord}: it measures elapsed-since-
 * dispatch, NOT staleness-since-a-missed-fast-path, so there is NO fast-path
 * notion — `fast_path` and `last_fast_path_at` are ALWAYS `null` (the class
 * discriminator must keep these two record kinds separable so the aggregation
 * script never mixes their staleness histograms).
 *
 * `staleness_ms` carries the elapsed-since-dispatch duration in ms when known
 * (the ceiling's `elapsedMs`), or `null` when the backstop has no elapsed
 * measure (the empty-sweep denominator bump posts no record at all, so the
 * `null` case is just defensive). `rescued` is the denominator-defining
 * boolean: `true` when the backstop actually expired/failed a stuck dispatch,
 * `false` for a fire that found nothing to rescue (counted via
 * {@link BackstopCounters}, NOT written as a line).
 *
 * Pure — `now` is injected (a producer wall-clock read, legal outside any
 * fold; tests pass a synthetic clock), so the two timeout backstops derive
 * the same shape from one place.
 */
export function buildTimeoutRecord(args: {
  backstop: BackstopName;
  worker: BackstopWorker;
  rescued: boolean;
  now: number;
  stalenessMs: number | null;
  detail?: Record<string, string>;
}): BackstopRecord {
  const rec: BackstopRecord = {
    ts: args.now,
    kind: "backstop-rescue",
    class: "timeout",
    backstop: args.backstop,
    worker: args.worker,
    fast_path: null,
    rescued: args.rescued,
    staleness_ms: args.stalenessMs,
    last_fast_path_at: null,
  };
  if (args.detail !== undefined) {
    rec.detail = args.detail;
  }
  return rec;
}

/**
 * In-memory per-(backstop,class) fire/rescue counter. Each worker owns one;
 * every backstop fire calls {@link bump} (a rescue passes `rescued:true`, a
 * no-op fire passes `false`) so BOTH the numerator (`rescues_total`) and the
 * denominator (`fires_total`) accumulate. {@link snapshot} renders the rollup
 * records flushed periodically + on shutdown.
 *
 * Decoupled from the rate-limited stderr ALARM and from the NDJSON write: a
 * rate-limited ALARM must STILL bump the counter (and still write the rescue
 * record), or the denominator breaks. Callers MUST bump regardless of whether
 * the ALARM line was suppressed.
 */
export class BackstopCounters {
  private readonly fires = new Map<string, number>();
  private readonly rescues = new Map<string, number>();

  /**
   * Record one backstop fire. Always increments `fires_total`; increments
   * `rescues_total` too when `rescued` is true. Pure in-memory — never writes
   * the sidecar (the caller routes the rescue RECORD separately so the no-op
   * fire stays line-free).
   */
  bump(backstop: BackstopName, cls: BackstopClass, rescued: boolean): void {
    const key = counterKey(backstop, cls);
    this.fires.set(key, (this.fires.get(key) ?? 0) + 1);
    if (rescued) {
      this.rescues.set(key, (this.rescues.get(key) ?? 0) + 1);
    }
  }

  /**
   * Render the current counters as {@link BackstopRollup} records, one per
   * (backstop,class) pair that has fired at least once. `ts` is stamped by the
   * caller (a producer wall-clock read — legal outside any fold). Sorted by key
   * so a snapshot is deterministic for tests. Returns `[]` when nothing fired.
   */
  snapshot(ts: number): BackstopRollup[] {
    const out: BackstopRollup[] = [];
    for (const key of [...this.fires.keys()].sort()) {
      const sep = key.indexOf(" ");
      const backstop = key.slice(0, sep) as BackstopName;
      const cls = key.slice(sep + 1) as BackstopClass;
      out.push({
        ts,
        kind: "backstop-rollup",
        backstop,
        class: cls,
        fires_total: this.fires.get(key) ?? 0,
        rescues_total: this.rescues.get(key) ?? 0,
      });
    }
    return out;
  }
}

/**
 * Per-key cooldown token bucket gating ONLY the loud human stderr ALARM line
 * (so `server.stderr` can't flood when a fast path is broken and the heartbeat
 * rescues every cycle). The NDJSON record + {@link BackstopCounters} are NEVER
 * gated through this — a suppressed ALARM still bumps the counter and still
 * writes the rescue line, keeping the metric complete.
 *
 * `allow(key, now)` returns `true` the first time it sees a key and again only
 * once `cooldownMs` has elapsed since the last allowed call for that key. The
 * clock is injected (`now`) so producers stamp a real wall-clock read; tests
 * pass a synthetic clock.
 */
export class BackstopRateLimiter {
  private readonly lastAllowed = new Map<string, number>();

  constructor(private readonly cooldownMs: number) {}

  /**
   * `true` iff the ALARM for `key` is allowed at `now` (first-ever sighting, or
   * `cooldownMs` elapsed since the last allow). On `true` it records `now` as
   * the new floor. On `false` the caller MUST still bump the counter and write
   * the NDJSON record — only the stderr line is suppressed.
   */
  allow(key: string, now: number): boolean {
    const last = this.lastAllowed.get(key);
    if (last !== undefined && now - last < this.cooldownMs) {
      return false;
    }
    this.lastAllowed.set(key, now);
    return true;
  }
}

/**
 * Append one {@link BackstopRecord} or {@link BackstopRollup} line to the
 * NDJSON sidecar at `logPath`. Single O_APPEND `write()` of
 * `JSON.stringify(rec)+"\n"` with `mode:0o600` (mirrors the hook's
 * `KEEPER_DROP_LOG` 0600 append + `appendDiagnostic`). Best-effort: any I/O
 * error is swallowed and a one-line note goes to stderr — the sidecar is
 * observational, never load-bearing, so a write failure must NOT throw, must
 * NOT escalate to `fatalExit`, and must NOT wedge the daemon's message loop.
 *
 * Concurrent appends stay atomic under PIPE_BUF, but by the sole-writer rule
 * only MAIN ever calls this in production (workers postMessage records up).
 */
export function appendBackstopRecord(
  rec: BackstopRecord | BackstopRollup,
  logPath: string,
): void {
  try {
    appendFileSync(logPath, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
  } catch (err) {
    process.stderr.write(
      `# warn: backstop-telemetry append failed: ${(err as Error).message}\n`,
    );
  }
}

#!/usr/bin/env bun
/**
 * `babysitters/performance/watch.ts` — the read-only babysitter scanner, the
 * `performance` sitter (epic fn-729 task .1; relocated into the `babysitters/`
 * plugin tree, one sitter per concern).
 *
 * An always-on, escalate-only safety monitor for keeper's recurring failure
 * classes: slowness/wedging, autopilot stalls, erroneous / duplicate
 * dispatches, dead-letter / fold-latency / backstop degradation, and stuck
 * jobs. (fn-766 retired the approval-era checks — fn-756 deleted the approve
 * verb and its window, so dup-approve / approval-review no longer have a
 * mechanism to watch — and added the watches the post-roadmap signal landscape
 * proved missing: duplicate-live-workers per plan_ref [the LOAD-BEARING re-fire
 * tripwire], poison-arrivals, events-log-backlog, db-growth, keeperd-cpu.) This
 * binary is the deterministic DETECTION CORE: it
 * opens `keeper.db` READ-ONLY, scans a
 * recent window of the event log + the projection tables, and emits a stable
 * `Finding[]`. It NEVER writes `keeper.db`, mints no synthetic events, and
 * performs no RPC — a pure external observer.
 *
 * This is its OWN binary, NOT a `keeper` subcommand.
 *
 * Modes:
 *   - default        → human-readable findings table on stdout.
 *   - `--json`       → `{ success: true, findings: [...] }` (the JSON-envelope
 *                      convention; the human-readable / triage input contract).
 *   - `--tick`       → the launchd entry: scan, diff vs persistent seen-state,
 *                      and on genuinely-NEW findings WRITE a follow-up file per
 *                      finding directly to the corpus `/babysit-triage` reads.
 *                      No agent spawn, no page. Silent (exit 0, no write) when
 *                      nothing is new. See the SEEN-STATE + TICK sections below.
 *
 * ## Seen-state + follow-up posture (pull model — fn-792)
 *
 * `--tick` dedups findings against a persistent seen-state file at
 * `~/.local/state/babysitters/performance/seen.json` — its OWN dir, NOT a `KEEPER_*`
 * path (a re-fold of `keeper.db` must never see the monitor's bookkeeping).
 * The file is written atomically (tmp + `renameSync`, via the shared
 * `atomicWriteFile`); a missing or corrupt file loads as an empty baseline.
 *
 * Cold start / corrupt = SILENT BASELINE: seed every current finding as seen
 * and write nothing. Only a genuinely-new finding AFTER a valid baseline writes
 * a follow-up. A TTL prune drops entries unseen >24h; a still-present finding is
 * suppressed (no rewrite of the same follow-up). A finding that re-fires after
 * its seen-entry TTL gets a NEW follow-up file — the resurface rule working.
 *
 * The held-across-ticks signals finalize here using the seen-state history:
 * reducer-wedge fires only after the lag persists ≥N consecutive ticks,
 * dead-letter-growth on a positive delta vs the stored baseline count, and
 * autopilot-stall after the unpaused-no-dispatch condition holds ≥N ticks.
 *
 * ## The Finding contract
 *
 * A `Finding` = `{ key, fingerprint, severity, category, title, detail,
 * evidence }`. `key` is a stable per-condition id (e.g.
 * `dup-approve:fn-728-….2`); `fingerprint` is a hash of (category,
 * stable-resource-id, version) and contains NO timestamps, pids, or free-text
 * — so the .2 seen-state diff dedups on a condition, not on a noisy instance.
 *
 * ## Detection posture (deterministic; thresholds are refinable defaults)
 *
 * Every check is a PURE exported function `(input) => Finding[]` so it
 * unit-tests without a live DB (the `DispatchDeps` injectable model in
 * `cli/keeper.ts`). The DB layer (`scan`) wires the pure detectors over a
 * single recent-window read.
 *
 * The DB is opened `{ readonly: true, prepareStmts: false }` — `prepareStmts`
 * is MANDATORY false: the default `openDb` builds an `insertEvent` statement
 * naming every `events` column known at build time and THROWS "no such column"
 * on a schema-skewed live DB before `openDb` returns (the fn-669 hook
 * carve-out). A read-only scanner must tolerate a behind-schema live DB.
 *
 * Event scans are bounded to a recent window (default ~1h by `events.ts`) so
 * dup-approve / dup-dispatch stay O(recent), not O(all-events), and a tick
 * stays well under keeperd's WAL-checkpoint budget.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { computeStats } from "../../scripts/backstop-stats";
import {
  atomicWriteFile,
  openDb,
  resolveBackstopLogPath,
  resolveDbPath,
  resolveDeadLetterDir,
  resolveEventsLogDir,
  resolveSockPath,
} from "../../src/db";
import { parsePlanRef } from "../../src/derivers";
import {
  type FollowupConfig,
  type FollowupStamps,
  writeFollowup,
} from "../lib/followups";
import { babysitterStateDir } from "../lib/state";

/** This sitter's concern slug — namespaces its state dir + plugin agent. */
const SLUG = "performance";

/**
 * Probe whether `pid` is alive (the stuck-job + daemon-down liveness signal).
 * `process.kill(pid, 0)` sends no signal — it only checks existence/permission:
 * resolves → alive; `ESRCH` → dead; `EPERM` → owned by another user → alive.
 *
 * INLINED rather than imported from `src/server-worker.ts` (fn-766): that module
 * is ~3k lines, and importing one two-line helper from it dragged the whole
 * surface — fn-756 transiently broke the sitter when it removed an UNRELATED
 * export (`setApprovalKickSignal`) from that file, killing every tick silently
 * until the watchdog's 15-min staleness alarm noticed. keeper itself already
 * re-implements this locally in three places for the same reason (`daemon.ts`,
 * `exit-watcher-ffi.ts`). The sitter's only remaining keeper-src imports are the
 * small `src/db.ts` resolvers/`openDb`/`atomicWriteFile` it genuinely needs and
 * the pure `parsePlanRef` deriver — pinned by `test/babysitter-build.test.ts`.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const HELP = `babysitter performance — watch [options]

Read-only babysitter scanner. Opens keeper.db read-only, detects keeper's
recurring failure classes deterministically, and emits a Finding[]. Never
writes keeper.db. NOT a 'keeper' subcommand — its own binary.

Options:
  --json               Emit { success: true, findings: [...] } instead of a table
  --tick               launchd entry: scan, diff vs seen-state, write a follow-up
                       per new finding. Silent (exit 0, no write) when nothing is new.
  --window-secs <n>    Event-log lookback window in seconds (default 3600)
  --help, -h           Show this help
`;

// ---------------------------------------------------------------------------
// The Finding contract
// ---------------------------------------------------------------------------

/** Severity ordering drives the table sort + the .2 escalation threshold. */
export type Severity = "info" | "warning" | "critical";

export type Category =
  | "dup-dispatch"
  | "dispatch-failure"
  | "daemon-down"
  | "reducer-wedge"
  | "dead-letter-growth"
  | "autopilot-stall"
  | "stuck-job"
  // fn-733: backstop-self-telemetry ingest (a degrading rescue or a rising
  // missed-wake counter) + event→projection fold latency over the realtime bar.
  | "backstop-degraded"
  | "fold-latency"
  // fn-766 task 2 — the watches the post-roadmap signal landscape proved
  // missing. `duplicate-live-workers` is the LOAD-BEARING re-fire tripwire
  // (>1 live pid on one plan_ref — the 2026-06-09 triple-dispatch class that a
  // hand-rolled tripwire, not the sitter, caught); `poison-arrivals` watches the
  // fn-762 dead-letter poison-parking surface; `events-log-backlog` watches the
  // fn-736 NDJSON→events ingest for a wedge; `db-growth` watches the keeper.db /
  // WAL footprint; `keeperd-cpu` watches the fn-748 144%-CPU regression class.
  | "duplicate-live-workers"
  | "poison-arrivals"
  | "events-log-backlog"
  | "db-growth"
  | "keeperd-cpu"
  // fn-771 task 1 — the STATE-based sibling of the rate-window dup-dispatch arm.
  // A slow close-loop (the 2026-06-10 fn-12 incident: 8 close workers
  // accumulated over ~6h against a still-open epic, spaced past the 15-min
  // dup-dispatch window so the rate arm never saw them) pages critical on the
  // cumulative count of close dispatches against one still-open epic.
  | "close-loop";

/**
 * One detected condition. `key` is a human-stable per-condition id; the
 * `fingerprint` is the dedup substrate for task .2's seen-state — it hashes
 * ONLY (category, stable-resource-id, version) so the same condition produces
 * the same fingerprint across ticks regardless of when it was observed.
 */
export interface Finding {
  key: string;
  fingerprint: string;
  severity: Severity;
  category: Category;
  title: string;
  /** Human-readable one-liner; free-text, NEVER folded into the fingerprint. */
  detail: string;
  /** Structured evidence for the agent; free-form, NEVER in the fingerprint. */
  evidence: Record<string, unknown>;
}

/**
 * Fingerprint VERSION — bump when a check's detection semantics change in a
 * way that should re-fire a previously-seen condition. Folded into every
 * fingerprint so a semantics change invalidates the .2 seen-state cleanly.
 */
export const FINGERPRINT_VERSION = 2;

/**
 * Stable fingerprint = hash of (category, resourceId, version). Deliberately
 * accepts ONLY a category + a stable resource id (no timestamps, pids, counts,
 * or free-text) so the same condition fingerprints identically across ticks.
 * `Bun.hash` is a fast non-crypto hash — fine for a dedup key (mirrors the
 * `src/restore-worker.ts` change-gate hash precedent).
 */
export function fingerprint(category: Category, resourceId: string): string {
  return String(Bun.hash(`${FINGERPRINT_VERSION} ${category} ${resourceId}`));
}

// ---------------------------------------------------------------------------
// Row shapes (the narrow projections each detector reads)
// ---------------------------------------------------------------------------

/** A recent `events` row, projected to the columns the detectors read. */
export interface EventRow {
  id: number;
  ts: number;
  session_id: string;
  hook_event: string;
  /**
   * The event's structural class (`lifecycle` / `planctl` / `plan_snapshot` /
   * …). fold-latency keys the snapshot side on `event_type='plan_snapshot'`
   * (the synthetic Epic/Task snapshot events folded at `src/daemon.ts`), which
   * is more robust than matching `hook_event IN ('EpicSnapshot','TaskSnapshot')`.
   */
  event_type: string;
  planctl_op: string | null;
  planctl_target: string | null;
  data: string | null;
}

/** A `dispatch_failures` projection row. */
export interface DispatchFailureRow {
  verb: string;
  id: string;
  reason: string;
  dir: string | null;
  ts: number;
}

/** A non-terminal `jobs` projection row with a pid. */
export interface JobRow {
  job_id: string;
  state: string;
  pid: number | null;
  created_at: number;
  title: string | null;
  /**
   * The plan entity this job is bound to (`epic_id` for a plan/close-verb job,
   * `task_id` for a work-verb job) — the re-fire correlation key
   * `detectDuplicateLiveWorkers` groups on. `null` for a non-plan job (ambient
   * session). The `idx_jobs_plan_ref` partial index serves the grouping scan.
   */
  plan_ref: string | null;
  /**
   * The autopilot VERB that minted this job (`'work'` | `'close'`; fn-771).
   * `detectCloseLoop` filters on `'close'` to count accumulating close
   * dispatches against one epic. `null` for a non-autopilot / ambient session
   * job, or on a pre-fn-684 DB whose `jobs.plan_verb` column is absent.
   */
  plan_verb: string | null;
}

/** The single `autopilot_state` row (id=1). */
export interface AutopilotStateRow {
  paused: number;
  last_event_id: number;
  /** fn-751 mode enum: `'yolo'` works everything, `'armed'` works only the
   * armed set + its dep-closure. NULL on a pre-v62 DB → treated as `'yolo'`. */
  mode: string | null;
}

// ---------------------------------------------------------------------------
// Thresholds (refinable defaults). Module-scope literals so the detectors
// stay pure and a future calibration is a one-line edit.
// ---------------------------------------------------------------------------

/** Default event-log lookback window: 1 hour. */
export const DEFAULT_WINDOW_SECS = 3600;
/**
 * dup-dispatch: same verb::id dispatched ≥2x within this span — a WARNING-level
 * heuristic, NOT the authoritative re-fire tripwire.
 *
 * fn-762 semantics caveat: a single `verb::id` legitimately re-dispatches within
 * this 15-min window when a DEFINITIVE pre-launch failure (`aborted-prelaunch`
 * — ack reject / `{ok:false}` / shutdown racing the ack; nothing launched)
 * CLEARS the 200s re-dispatch cooldown so `retry_dispatch` / the next cycle can
 * legitimately re-launch. So a count of 2 here is NOT necessarily a bug; it's a
 * "look at this" signal. The REAL re-fire tripwire — two LIVE workers against
 * the same plan_ref, the class the 2026-06-09 incident's hand-rolled tripwire
 * caught — is `detectDuplicateLiveWorkers` (fn-766 task 2), which checks live
 * pids, not event counts. Keep this check as a cheap corroborating warning.
 */
export const DUP_DISPATCH_WINDOW_SECS = 15 * 60;
export const DUP_DISPATCH_MIN_COUNT = 2;
/** reducer-wedge: MAX(events.id) - reducer_state.last_event_id over this lag. */
export const REDUCER_WEDGE_LAG_THRESHOLD = 50;
/** autopilot-stall: ready work + unpaused + no Dispatched within this span. */
export const AUTOPILOT_STALL_WINDOW_SECS = 30 * 60;
/** stuck-job: a non-terminal dead-pid job older than this isn't a launch race. */
export const STUCK_JOB_MIN_AGE_SECS = 5 * 60;
/** Non-terminal job states a live worker should be backing. */
export const NON_TERMINAL_JOB_STATES = new Set(["working", "stopped"]);

// --- fn-766 task 2: the watches the incident proved missing ---
/**
 * events-log-backlog: a per-pid `<pid>.ndjson` events-log file whose on-disk
 * size exceeds the daemon's stored ingest `offset` by MORE than this many bytes
 * has un-ingested tail — a transient lag of a few unflushed lines is normal, so
 * a small slack avoids paging on a healthy in-flight append. Held across ticks
 * (a genuinely-wedged ingester stays behind; a transient append catches up).
 */
export const EVENTS_LOG_BACKLOG_SLACK_BYTES = 64 * 1024;
/**
 * db-growth: the keeper.db WAL is checkpointed routinely, so a WAL this large
 * means checkpointing has stalled (the DB is effectively unbounded-growing) —
 * the operator-visible disk-footprint class. A generous 1 GiB ceiling: the
 * healthy WAL is single-digit MB, so this only fires on a genuine wedge, never
 * normal churn. info-severity (a slow-burn footprint signal, not an outage).
 */
export const WAL_CEILING_BYTES = 1024 * 1024 * 1024;
/**
 * keeperd-cpu: sustained keeperd %CPU over this bar is the fn-748 144%-CPU
 * regression class (the git-worker's `data_version` fan-out pegged the daemon
 * under multi-agent load). 25% held ≥`HELD_TICKS_THRESHOLD` ticks: a brief spike
 * during a fold burst is normal, sustained 25%+ is a busy-loop. The probe is the
 * one new external input — a single `ps -o %cpu` fork per tick, read-only.
 */
export const KEEPERD_CPU_THRESHOLD_PCT = 25;

// --- close-loop (fn-771 task 1) ---
/**
 * close-loop: the cumulative count of `close`-verb jobs minted against one
 * still-open epic within this window. The STATE-based sibling of
 * `detectDupDispatch`'s rate arm (DUP_DISPATCH_WINDOW_SECS, 15 min): a slow
 * close-loop spaces its re-dispatches FAR past 15 min (the fn-12 incident
 * accumulated 8 close workers over ~6h — each fresh dispatch fell outside the
 * rate window, so the rate arm was structurally blind to it), so the count is
 * tallied over a full DAY. Mirrors the Kubernetes CrashLoopBackOff dual-arm
 * stance: a rate window catches fast loops, a cumulative state counter catches
 * slow ones spaced by cooldowns — keep BOTH arms.
 */
export const CLOSE_LOOP_WINDOW_SECS = 24 * 60 * 60;
/**
 * close-loop: fire critical when ≥ this many `close` jobs land against one open
 * epic in the window. A healthy close lands in 1–2 dispatches (the finalizer
 * runs once; a single pending-dispatch-sweep retry is normal), so N=4 sits well
 * clear of the legit band while still tripping far below the fn-12 incident's 8.
 */
export const CLOSE_LOOP_MIN_COUNT = 4;

// --- backstop-degraded (fn-733) ---
/**
 * backstop-degraded staleness — RETAINED FOR EVIDENCE ONLY (fn-771). The
 * `staleness_ms` of a rescue is `now − last_fast_path_at`: it measures IDLENESS
 * since the last fast path, NOT change-to-rescue latency, so it inflates with
 * quiet minutes (the 2026-06-10 incident: a 2s-old commit rescued after 27 idle
 * minutes reported staleness_ms=1611292 and paged a false critical). The
 * staleness number is no longer a CLASSIFICATION gate — the latency bands below
 * are — but it stays in the finding evidence so a before/after shakeout can
 * compare the two signals.  Lag = observation_ts − event_ts, never
 * now − last_observation (Google Chronicle timestamp discipline).
 */
export const STALENESS_ALARM = 30_000;
/**
 * backstop-degraded latency (fn-771) — the change-to-rescue latency bands that
 * REPLACE the idle-inflated `staleness_ms` gate. `change_to_rescue_ms` is the
 * TRUE freshness signal: `now − committed_at_ms` for the change the heartbeat
 * actually discharged (worst-case / oldest commit when several land in one
 * rescue). A rescue with `change_to_rescue_ms` null (a dirty-tree-only or
 * cold-boot rescue, OR an old-format line predating the field) or below WARN is
 * HEALTHY — an idle-then-instant-rescue is normal FSEvents delivery; absence of
 * events is a LIVENESS question owned by the dead-man watchdog, not a freshness
 * detector (gate freshness checks on "an event actually arrived"). At/above WARN
 * is a warning; at/above CRIT is critical.
 */
export const MISSED_WAKE_LATENCY_WARN_MS = 10_000;
export const MISSED_WAKE_LATENCY_CRIT_MS = 60_000;
/**
 * backstop-degraded: a per-(backstop,class) `rescues_total` DELTA over this bar
 * vs the stored baseline means a fast path is silently dropping wake-ups.
 *
 * fn-766: lowered 5→1 for the ~0-rescue era. At the post-roadmap (fn-759/762/
 * 764/765) baseline of essentially zero rescues, a ≤5/tick bleed was invisible
 * — the old anchor could mask a steady drip. With the delta at 1 the FIRST new
 * rescue per (backstop,class) since the baseline pages: the baseline rolls
 * forward every tick (Prometheus `rate()` over a monotonic counter), so a
 * one-shot rescue fires once and then re-anchors — it can't re-page every tick.
 * A `current < baseline` reset (daemon restart) is still reset semantics
 * (`delta = current`, no fire), so a restart never false-pages.
 */
export const MISSED_WAKE_DELTA = 1;
/**
 * Per-name carve-out (fn-766 task 2): the `events-ingest-poison` backstop
 * (fn-762 — a poison NDJSON line the events-log ingester quarantined) pages on
 * the FIRST rescue delta, not the generic `MISSED_WAKE_DELTA` (>1) bar. A poison
 * line is a hard ingest fault (malformed hook NDJSON / a parser skew), not a
 * timing miss, so even one is worth a look — paired with the `poison-arrivals`
 * dead-letter-count watch. The fire is INCLUSIVE (`delta >= this`), unlike the
 * generic missed-wake's EXCLUSIVE (`delta > MISSED_WAKE_DELTA`) bar.
 */
export const POISON_BACKSTOP_NAME = "events-ingest-poison";
export const POISON_BACKSTOP_MIN_DELTA = 1;

// --- fold-latency (fn-733) ---
/**
 * fold-latency: a matched op→snapshot pair this slow means the realtime WAKE
 * path failed and the change fell to the reconcile heartbeat (or worse). The
 * happy path is ~50ms; the fn-732 live evidence was ~10–20s; the 92s incident
 * was far past.
 *
 * fn-766: lowered 5→2. The original 5s carried a "tunable DOWN as the
 * keeper-core fix lands" note — fn-759/762 ARE that fix (they collapsed the
 * fold lag), so the realtime bar tightens to ~2s and any recurrence past it is
 * treated as a regression of that fix rather than expected slack.
 */
export const FOLD_LATENCY_REALTIME_THRESHOLD = 2;
/**
 * fold-latency re-fold guard: a re-fold mints FRESH snapshot `ts` (`Date.now()`
 * at fold time, see `src/daemon.ts`), so an old op paired to a re-folded
 * snapshot would show an absurd latency. Any latency past this cap (or a
 * negative one — snapshot before op) is a re-fold artifact, never a real
 * timeliness regression, and is discarded.
 */
export const FOLD_LATENCY_SANITY_CAP = 60 * 60;

// ---------------------------------------------------------------------------
// Pure detectors — each `(input) => Finding[]`, no DB, no clock, no env.
// `nowSecs` is passed in (never `Date.now()` inside a detector) so age/window
// math is deterministic in tests.
// ---------------------------------------------------------------------------

/**
 * dup-dispatch: a synthetic `Dispatched` event carries `data` JSON
 * `{ verb, id, dir }`. The same `verb::id` minted ≥`DUP_DISPATCH_MIN_COUNT`
 * times within `DUP_DISPATCH_WINDOW_SECS` means the reconciler re-launched the
 * same work. One finding per `verb::id`.
 *
 * fn-766 semantics annotation: a count of 2 is NOT automatically a bug. fn-762's
 * dispatch model legitimately re-dispatches a `verb::id` within this window when
 * a DEFINITIVE pre-launch failure (`aborted-prelaunch`) CLEARS the 200s
 * re-dispatch cooldown — `retry_dispatch` / the next cycle then re-launches by
 * design (nothing was ever live). So this stays a WARNING heuristic; the
 * authoritative re-fire tripwire is `detectDuplicateLiveWorkers` (two LIVE pids
 * against one plan_ref), not this event-count check.
 */
export function detectDupDispatch(events: EventRow[]): Finding[] {
  const byKey = new Map<string, number[]>();
  for (const e of events) {
    if (e.hook_event !== "Dispatched" || e.data === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(e.data);
    } catch {
      continue; // degrade-don't-throw: a malformed blob is simply not counted
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.verb !== "string" || typeof obj.id !== "string") continue;
    const k = `${obj.verb}::${obj.id}`;
    const list = byKey.get(k) ?? [];
    list.push(e.ts);
    byKey.set(k, list);
  }

  const findings: Finding[] = [];
  for (const k of [...byKey.keys()].sort()) {
    // biome-ignore lint/style/noNonNullAssertion: key came from the map
    const tss = byKey
      .get(k)!
      .slice()
      .sort((a, b) => a - b);
    // Sliding window over dispatch timestamps for the same verb::id.
    let hit: { count: number; first: number; last: number } | null = null;
    for (let i = 0; i < tss.length; i++) {
      let count = 0;
      let last = tss[i];
      for (let j = i; j < tss.length; j++) {
        if (tss[j] - tss[i] > DUP_DISPATCH_WINDOW_SECS) break;
        count++;
        last = tss[j];
      }
      if (count >= DUP_DISPATCH_MIN_COUNT) {
        hit = { count, first: tss[i], last };
        break;
      }
    }
    if (hit === null) continue;
    findings.push({
      key: `dup-dispatch:${k}`,
      fingerprint: fingerprint("dup-dispatch", k),
      severity: "warning",
      category: "dup-dispatch",
      title: `Dispatch repeated ${hit.count}x`,
      detail: `${k} dispatched ${hit.count}x within ${Math.round((hit.last - hit.first) / 60)}m`,
      evidence: {
        dispatchKey: k,
        count: hit.count,
        spanSecs: Math.round(hit.last - hit.first),
      },
    });
  }
  return findings;
}

/**
 * dispatch-failure: any row in `dispatch_failures` is a failed autopilot
 * launch the human should see. One finding per `(verb, id)`; the resource id
 * is `verb::id` so the fingerprint is stable across the row's `updated_at`
 * churn.
 */
export function detectDispatchFailures(rows: DispatchFailureRow[]): Finding[] {
  const findings: Finding[] = [];
  for (const r of rows
    .slice()
    .sort((a, b) => `${a.verb}::${a.id}`.localeCompare(`${b.verb}::${b.id}`))) {
    const k = `${r.verb}::${r.id}`;
    findings.push({
      key: `dispatch-failure:${k}`,
      fingerprint: fingerprint("dispatch-failure", k),
      severity: "warning",
      category: "dispatch-failure",
      title: "Dispatch failed",
      detail: `${k} dispatch failed: ${r.reason}`,
      evidence: { verb: r.verb, id: r.id, reason: r.reason, dir: r.dir },
    });
  }
  return findings;
}

/**
 * daemon-down: the UDS is unreachable AND keeperd is not running. The probe
 * results are PASSED IN (computed by the DB layer / injected in tests) so this
 * detector stays pure. Deliberately does NOT use `reducer_state.updated_at`:
 * that is the event's own `ts` (see `src/reducer.ts`), frozen when idle on a
 * perfectly healthy daemon — a false-positive trap.
 */
export function detectDaemonDown(input: {
  socketReachable: boolean;
  keeperdAlive: boolean;
}): Finding[] {
  if (input.socketReachable || input.keeperdAlive) return [];
  return [
    {
      key: "daemon-down",
      fingerprint: fingerprint("daemon-down", "keeperd"),
      severity: "critical",
      category: "daemon-down",
      title: "keeperd is down",
      detail: "UDS socket unreachable and no keeperd process found",
      evidence: {
        socketReachable: input.socketReachable,
        keeperdAlive: input.keeperdAlive,
      },
    },
  ];
}

/**
 * reducer-wedge: `MAX(events.id) - reducer_state.last_event_id` over
 * `REDUCER_WEDGE_LAG_THRESHOLD`. A large lag means the fold is stuck behind the
 * log. Held-across-ticks confirmation lands in .2 (seen-state); here we emit
 * the magnitude finding. The fingerprint is keyed on `reducer` (singleton) so
 * the lag delta never enters it.
 */
export function detectReducerWedge(input: {
  maxEventId: number;
  lastEventId: number;
}): Finding[] {
  const lag = input.maxEventId - input.lastEventId;
  if (lag < REDUCER_WEDGE_LAG_THRESHOLD) return [];
  return [
    {
      key: "reducer-wedge",
      fingerprint: fingerprint("reducer-wedge", "reducer"),
      severity: "critical",
      category: "reducer-wedge",
      title: `Reducer behind by ${lag} events`,
      detail: `MAX(events.id)=${input.maxEventId} but reducer_state.last_event_id=${input.lastEventId} (lag ${lag})`,
      evidence: {
        maxEventId: input.maxEventId,
        lastEventId: input.lastEventId,
        lag,
      },
    },
  ];
}

/**
 * dead-letter-growth: the current count of files under `resolveDeadLetterDir()`
 * is surfaced as evidence. The delta / growth-rate logic lands in .2 (needs
 * seen-state); here a non-zero count is an info-severity signal. Fingerprint
 * keyed on the dir (singleton) so the count never enters it.
 */
export function detectDeadLetterGrowth(input: {
  count: number;
  dir: string;
}): Finding[] {
  if (input.count <= 0) return [];
  return [
    {
      key: "dead-letter-growth",
      fingerprint: fingerprint("dead-letter-growth", "dead-letters"),
      severity: "info",
      category: "dead-letter-growth",
      title: `${input.count} dead-letter file(s)`,
      detail: `${input.count} dead-letter file(s) present under ${input.dir}`,
      evidence: { count: input.count, dir: input.dir },
    },
  ];
}

/**
 * autopilot-stall: autopilot is UNPAUSED, ready work exists, yet no `Dispatched`
 * event landed within `AUTOPILOT_STALL_WINDOW_SECS`. Deliberately does NOT flag
 * `paused=1` alone — autopilot boots paused BY DESIGN (`src/daemon.ts`), and an
 * idle unpaused autopilot is usually a readiness gate firing correctly
 * (`src/readiness.ts`). The `readyWorkExists` signal is computed by the DB
 * layer and passed in so this detector stays pure.
 *
 * fn-766 mode-awareness: fn-751 added the `armed` mode, which works ONLY a
 * human-chosen set of armed epics (plus their dep-closure). In `armed` mode with
 * ZERO armed epics the autopilot is LEGITIMATELY idle — there is nothing it is
 * allowed to dispatch — so the presence of open epics is NOT a stall. Before
 * fn-766 this false-paged after 3 held ticks. We suppress when `mode==='armed'`
 * AND `armedCount===0`. `yolo` mode (the default) is unaffected: it works every
 * ready epic, so unpaused + ready + idle is a genuine stall. (A non-empty armed
 * set in armed mode is NOT suppressed: the sitter can't cheaply compute the
 * transitive dep-closure that decides true readiness, so it stays conservative
 * and lets the held-across-ticks gate + the human triage the rare case.)
 */
export function detectAutopilotStall(input: {
  paused: boolean;
  readyWorkExists: boolean;
  recentDispatch: boolean;
  mode: string;
  armedCount: number;
}): Finding[] {
  if (input.paused || !input.readyWorkExists || input.recentDispatch) return [];
  // armed mode with nothing armed → legitimately idle, not a stall.
  if (input.mode === "armed" && input.armedCount === 0) return [];
  return [
    {
      key: "autopilot-stall",
      fingerprint: fingerprint("autopilot-stall", "autopilot"),
      severity: "warning",
      category: "autopilot-stall",
      title: "Autopilot stalled",
      detail: `Autopilot is unpaused (mode '${input.mode}', ${input.armedCount} armed) with ready work but no Dispatched event in the last ${Math.round(AUTOPILOT_STALL_WINDOW_SECS / 60)}m`,
      evidence: {
        paused: input.paused,
        readyWorkExists: input.readyWorkExists,
        recentDispatch: input.recentDispatch,
        mode: input.mode,
        armedCount: input.armedCount,
      },
    },
  ];
}

/**
 * stuck-job: a non-terminal `jobs` row (working/stopped) whose `pid` is dead,
 * corroborated by `created_at` age past `STUCK_JOB_MIN_AGE_SECS` to dodge the
 * launch→SessionStart race (a freshly-launched job whose pid hasn't appeared
 * yet). The pid-liveness probe is INJECTED (`isAlive`) so the detector is pure
 * and testable; the scanner is an external observer, so probing liveness here
 * is fine (it is NOT a fold). One finding per stuck job.
 */
export function detectStuckJobs(input: {
  jobs: JobRow[];
  nowSecs: number;
  isAlive: (pid: number) => boolean;
}): Finding[] {
  const findings: Finding[] = [];
  for (const j of input.jobs
    .slice()
    .sort((a, b) => a.job_id.localeCompare(b.job_id))) {
    if (!NON_TERMINAL_JOB_STATES.has(j.state)) continue;
    if (j.pid === null) continue;
    if (input.nowSecs - j.created_at < STUCK_JOB_MIN_AGE_SECS) continue;
    if (input.isAlive(j.pid)) continue;
    findings.push({
      key: `stuck-job:${j.job_id}`,
      fingerprint: fingerprint("stuck-job", j.job_id),
      severity: "warning",
      category: "stuck-job",
      title: "Job stuck (dead pid)",
      detail: `${j.job_id} is '${j.state}' but pid ${j.pid} is not alive (age ${Math.round((input.nowSecs - j.created_at) / 60)}m)`,
      evidence: {
        jobId: j.job_id,
        state: j.state,
        pid: j.pid,
        ageSecs: Math.round(input.nowSecs - j.created_at),
        title: j.title,
      },
    });
  }
  return findings;
}

/**
 * duplicate-live-workers (fn-766 task 2, CRITICAL): the LOAD-BEARING re-fire
 * tripwire. GROUP non-terminal `jobs` by `plan_ref` (non-null), count rows whose
 * `pid` passes the injected `isAlive`, and fire when >1 LIVE worker backs one
 * plan_ref — the 2026-06-09 triple-dispatch signature that a hand-rolled
 * tripwire, not the sitter, caught. This SUPERSEDES `dup-dispatch` (an
 * event-count heuristic that legitimately reads 2 after an `aborted-prelaunch`
 * cooldown clear) as the authoritative detector: it checks LIVE pids, not event
 * history, so it can't false-fire on a re-dispatch that never produced two live
 * workers.
 *
 * The `isAlive` probe is INJECTED (cf. `detectStuckJobs`) so the detector is
 * pure and testable; the scanner is an external observer, so probing liveness
 * here is fine (it is NOT a fold). Pages IMMEDIATELY (not held-across-ticks): two
 * live workers on one plan_ref is never a transient blip worth waiting out — by
 * the time a second tick confirms it, both have been racing the same worktree.
 *
 * The resource id is the `plan_ref` (singleton per group) so the fingerprint is
 * stable across ticks while the pair persists; pids/counts are evidence only.
 * One finding per offending plan_ref, deterministic order (plan_ref ascending).
 */
export function detectDuplicateLiveWorkers(input: {
  jobs: JobRow[];
  isAlive: (pid: number) => boolean;
}): Finding[] {
  // Group live pids by plan_ref over the non-terminal, plan-bound jobs.
  const livePidsByRef = new Map<string, number[]>();
  for (const j of input.jobs) {
    if (!NON_TERMINAL_JOB_STATES.has(j.state)) continue;
    if (j.plan_ref === null) continue;
    if (j.pid === null) continue;
    if (!input.isAlive(j.pid)) continue;
    const list = livePidsByRef.get(j.plan_ref) ?? [];
    list.push(j.pid);
    livePidsByRef.set(j.plan_ref, list);
  }

  const findings: Finding[] = [];
  for (const ref of [...livePidsByRef.keys()].sort()) {
    // biome-ignore lint/style/noNonNullAssertion: ref came from the map
    const pids = livePidsByRef
      .get(ref)!
      .slice()
      .sort((a, b) => a - b);
    if (pids.length <= 1) continue;
    findings.push({
      key: `duplicate-live-workers:${ref}`,
      fingerprint: fingerprint("duplicate-live-workers", ref),
      severity: "critical",
      category: "duplicate-live-workers",
      title: `${pids.length} live workers on ${ref}`,
      detail: `${pids.length} live workers back plan_ref ${ref} (pids ${pids.join(", ")}) — the re-fire signature (two workers racing one worktree)`,
      evidence: { planRef: ref, livePids: pids, liveCount: pids.length },
    });
  }
  return findings;
}

/**
 * close-loop (fn-771 task 1, CRITICAL): the STATE-based sibling of the
 * rate-window `detectDupDispatch` arm. Structurally modeled on
 * `detectDuplicateLiveWorkers` (group by plan_ref, fire critical immediately,
 * fingerprint on plan_ref — NOT held / delta-gated). Where dup-dispatch counts
 * re-dispatch EVENTS in a 15-min rate window (and so is structurally blind to a
 * loop whose re-dispatches are spaced by cooldowns past that window), this
 * counts `close`-verb JOBS rows accumulated against one still-OPEN epic over a
 * full day — the 2026-06-10 fn-12 signature (8 close workers over ~6h, the epic
 * never flipped done). The two arms are complementary (k8s CrashLoopBackOff
 * dual-arm: rate catches fast loops, cumulative state catches slow ones), not a
 * replacement — this is the missing state arm.
 *
 * Inputs are read from the LIVE projections (`jobs.plan_verb='close'` rows +
 * per-epic `status`), so the detector is stateless and the epic-open condition
 * SELF-CLEARS the finding the moment the epic flips done (a done epic yields no
 * finding, so the seen-state drops it without a version bump). We count jobs by
 * row (a pre-launch abort spawns no `jobs` row, so a never-launched dispatch
 * contributes no harm signal — by design).
 *
 * Predicate per epic-form `plan_ref` (parsePlanRef null / task-form → skipped):
 * count its close jobs with `created_at >= nowSecs − CLOSE_LOOP_WINDOW_SECS`;
 * fire when count ≥ CLOSE_LOOP_MIN_COUNT AND `epicStatus[plan_ref] === 'open'`.
 * A MISSING status entry (the epic row wasn't in the keyed read) DEGRADES — no
 * finding — rather than guessing. The fingerprint keys on the `plan_ref` only
 * (no count) so it stays stable across ticks while the loop persists; the count
 * + offending job_ids/states live in evidence/detail. One finding per offending
 * plan_ref, deterministic order (plan_ref ascending).
 */
export function detectCloseLoop(input: {
  jobs: JobRow[];
  /** plan_ref (epic-form) → epic `status`; absent key → degrade (no finding). */
  epicStatus: Map<string, string>;
  nowSecs: number;
}): Finding[] {
  const sinceTs = input.nowSecs - CLOSE_LOOP_WINDOW_SECS;
  // Group in-window close jobs by their epic-form plan_ref.
  const byEpic = new Map<string, JobRow[]>();
  for (const j of input.jobs) {
    if (j.plan_verb !== "close") continue;
    if (j.created_at < sinceTs) continue;
    const parsed = parsePlanRef(j.plan_ref);
    // A close verb is always epic-form; a null / task-form ref is malformed for
    // a close job → skip (degrade-don't-throw).
    if (parsed === null || parsed.kind !== "epic") continue;
    const ref = parsed.epic_id;
    const list = byEpic.get(ref) ?? [];
    list.push(j);
    byEpic.set(ref, list);
  }

  const findings: Finding[] = [];
  for (const ref of [...byEpic.keys()].sort()) {
    // biome-ignore lint/style/noNonNullAssertion: ref came from the map
    const rows = byEpic.get(ref)!;
    if (rows.length < CLOSE_LOOP_MIN_COUNT) continue;
    // Epic-status correlation: missing entry → degrade (no finding); only an
    // explicitly OPEN epic trips. A done epic self-clears the finding.
    if (input.epicStatus.get(ref) !== "open") continue;
    const offenders = rows
      .slice()
      .sort((a, b) => a.created_at - b.created_at)
      .map((j) => ({ job_id: j.job_id, state: j.state }));
    findings.push({
      key: `close-loop:${ref}`,
      fingerprint: fingerprint("close-loop", ref),
      severity: "critical",
      category: "close-loop",
      title: `${rows.length} close jobs on still-open ${ref}`,
      detail: `${rows.length} close-verb jobs minted against still-open epic ${ref} within ${Math.round(CLOSE_LOOP_WINDOW_SECS / 3600)}h — a slow close-loop (the epic never flipped done; offenders ${offenders.map((o) => `${o.job_id}[${o.state}]`).join(", ")})`,
      evidence: {
        planRef: ref,
        closeJobCount: rows.length,
        windowSecs: CLOSE_LOOP_WINDOW_SECS,
        offenders,
      },
    });
  }
  return findings;
}

/**
 * poison-arrivals (fn-766 task 2, warning): the count of `dead_letters` rows with
 * `status='poison'` (the fn-762 events-ingest poison-parking surface). A poison
 * line is one the events-log ingester could not parse and quarantined; a RISING
 * count means the hook is emitting malformed NDJSON or the ingester's parser
 * skewed. Like `detectDeadLetterGrowth` this emits a finding carrying the current
 * count; the POSITIVE-DELTA gate (page only when the count rose vs the stored
 * baseline) lands in {@link applyHeldGate} (it needs the seen-state baseline the
 * pure detector can't hold). A zero count is healthy → no finding.
 *
 * Fingerprint keyed on the singleton surface so the count never enters it.
 */
export function detectPoisonArrivals(input: { count: number }): Finding[] {
  if (input.count <= 0) return [];
  return [
    {
      key: "poison-arrivals",
      fingerprint: fingerprint("poison-arrivals", "dead-letters-poison"),
      severity: "warning",
      category: "poison-arrivals",
      title: `${input.count} poison-parked dead-letter(s)`,
      detail: `${input.count} dead_letters row(s) with status='poison' — the events-log ingester quarantined unparseable line(s)`,
      evidence: { count: input.count },
    },
  ];
}

/**
 * events-log-backlog (fn-766 task 2, warning): the daemon's NDJSON→events
 * ingester tails each per-pid `<pid>.ndjson` file from a stored byte `offset`
 * (`event_ingest_offsets`). A file whose on-disk `size` exceeds its stored
 * `offset` by more than `EVENTS_LOG_BACKLOG_SLACK_BYTES` has un-ingested tail —
 * a wedged / backlogged ingester. The `(path, size, offset)` tuples are computed
 * by the DB layer (join `event_ingest_offsets` against `statSync` of each file)
 * and PASSED IN so this detector stays pure.
 *
 * Held across ticks (see {@link HELD_TICK_CATEGORIES}): a few un-flushed lines
 * mid-append is normal slack; only a backlog that PERSISTS is a wedge. One
 * finding per backlogged path, deterministic order (path ascending).
 */
export function detectEventsLogBacklog(input: {
  files: { path: string; size: number; offset: number }[];
}): Finding[] {
  const findings: Finding[] = [];
  for (const f of input.files
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))) {
    const lag = f.size - f.offset;
    if (lag <= EVENTS_LOG_BACKLOG_SLACK_BYTES) continue;
    findings.push({
      key: `events-log-backlog:${f.path}`,
      fingerprint: fingerprint("events-log-backlog", f.path),
      severity: "warning",
      category: "events-log-backlog",
      title: `Events-log ingest behind by ${lag}B`,
      detail: `${f.path} is ${f.size}B on disk but the ingest offset is ${f.offset}B (${lag}B un-ingested, > ${EVENTS_LOG_BACKLOG_SLACK_BYTES}B slack) — the ingester may be wedged`,
      evidence: { path: f.path, size: f.size, offset: f.offset, lagBytes: lag },
    });
  }
  return findings;
}

/**
 * db-growth (fn-766 task 2, info): the keeper.db WAL is checkpointed routinely,
 * so a WAL over `WAL_CEILING_BYTES` means checkpointing stalled and the file is
 * growing unbounded — the operator-visible disk-footprint class. The byte sizes
 * are PASSED IN (the DB layer `statSync`s `dbPath` + `dbPath-wal`) so this
 * detector stays pure. info-severity — a slow-burn footprint signal, not an
 * outage. Fingerprint keyed on the singleton DB so the byte counts never enter
 * it. (A `null` WAL size — the file is absent — is healthy: no finding.)
 */
export function detectDbGrowth(input: {
  dbBytes: number;
  walBytes: number | null;
}): Finding[] {
  if (input.walBytes === null || input.walBytes <= WAL_CEILING_BYTES) return [];
  return [
    {
      key: "db-growth",
      fingerprint: fingerprint("db-growth", "keeper-db"),
      severity: "info",
      category: "db-growth",
      title: `WAL ${Math.round(input.walBytes / (1024 * 1024))}MB`,
      detail: `keeper.db WAL is ${input.walBytes}B (> ${WAL_CEILING_BYTES}B ceiling) — checkpointing may have stalled (DB ${input.dbBytes}B)`,
      evidence: {
        dbBytes: input.dbBytes,
        walBytes: input.walBytes,
        ceilingBytes: WAL_CEILING_BYTES,
      },
    },
  ];
}

/**
 * keeperd-cpu (fn-766 task 2, warning, held 3 ticks): sustained keeperd %CPU
 * over `KEEPERD_CPU_THRESHOLD_PCT` is the fn-748 144%-CPU regression class. The
 * sampled %CPU is PASSED IN (the DB layer `ps -o %cpu`s the pgrep'd pid) so this
 * detector stays pure; `null` (no keeperd / probe failure) is healthy here
 * (daemon-down is a separate detector). Held across ticks: a brief fold-burst
 * spike is normal, sustained 25%+ is a busy-loop. Singleton fingerprint.
 */
export function detectKeeperdCpu(input: { cpuPct: number | null }): Finding[] {
  if (input.cpuPct === null || input.cpuPct <= KEEPERD_CPU_THRESHOLD_PCT) {
    return [];
  }
  return [
    {
      key: "keeperd-cpu",
      fingerprint: fingerprint("keeperd-cpu", "keeperd"),
      severity: "warning",
      category: "keeperd-cpu",
      title: `keeperd CPU ${Math.round(input.cpuPct)}%`,
      detail: `keeperd is at ${input.cpuPct}% CPU (> ${KEEPERD_CPU_THRESHOLD_PCT}% bar) — the fn-748 busy-loop class (a data_version fan-out or hot poll)`,
      evidence: {
        cpuPct: input.cpuPct,
        thresholdPct: KEEPERD_CPU_THRESHOLD_PCT,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// fold-latency (fn-733) — event→projection timeliness over the realtime bar.
//
// The failure class that bit us: a planctl scaffold/done/approve taking 10–92s
// to reach the board while the reducer lag was ~0 (the realtime WAKE path
// dropped and the change fell to the slow reconcile heartbeat). This is a PURE
// detector over the event window: pair each `planctl_op` event to the FIRST
// matching snapshot event (`event_type='plan_snapshot'`, whose `session_id`
// carries the entity pk — see `src/daemon.ts`), measure `snapshot.ts − op.ts`,
// and fire per pair over the realtime threshold.
//
// Reads ONLY columns (ts, session_id, event_type, planctl_target, planctl_op,
// hook_event) — NEVER parses `data`.
// ---------------------------------------------------------------------------

/**
 * fold-latency: pair each `planctl_op` (scaffold/done/approve) to the FIRST
 * `plan_snapshot` event whose `session_id` equals the op's target ENTITY id,
 * and fire on a `latency = snapshot.ts − op.ts ≥ FOLD_LATENCY_REALTIME_THRESHOLD`.
 *
 * Pairing target (`src/daemon.ts`: the snapshot's pk rides in `session_id`):
 *   - the op's `planctl_target` is split via `parsePlanRef` into `{epic_id,
 *     task_id}`;
 *   - a TASK-form ref pairs to the TaskSnapshot whose `session_id === task_id`
 *     (the "task row shows it" moment);
 *   - an EPIC-form ref (scaffold / epic-level done/approve) pairs to the
 *     EpicSnapshot whose `session_id === epic_id` (the "board shows it" moment).
 *
 * Guards (all degrade-don't-throw, no false infinite-latency):
 *   - SKIP an op with NO matching snapshot in the window (in-flight / out of
 *     window) — never a false page;
 *   - SKIP a pair whose `snapshot.ts < op.ts` (negative) or whose latency
 *     exceeds `FOLD_LATENCY_SANITY_CAP` — a re-fold mints a fresh snapshot ts
 *     and would otherwise carpet-fire.
 *
 * NOT a held-across-ticks member: the events are immutable, so holding would
 * just delay the same verdict and could bury a one-shot 92s spike. The
 * per-pair fingerprint (keyed on `${op}::${entityId}::${opTs}`) + the seen-state
 * cooldown make each slow op page exactly once.
 *
 * Fires one finding per matched-and-over-threshold pair; deterministic order
 * (op id ascending) so a re-run produces byte-identical findings.
 */
export function detectFoldLatency(events: EventRow[]): Finding[] {
  // First snapshot ts per entity id (smallest id wins on ties — the events are
  // ASC by id, so the first sighting is authoritative). A snapshot is a
  // `plan_snapshot` event carrying the entity pk in `session_id`.
  const firstSnapshotTs = new Map<string, number>();
  for (const e of events) {
    if (e.event_type !== "plan_snapshot") continue;
    if (!firstSnapshotTs.has(e.session_id)) {
      firstSnapshotTs.set(e.session_id, e.ts);
    }
  }

  const findings: Finding[] = [];
  for (const e of events) {
    if (e.planctl_op === null || e.planctl_target === null) continue;
    const ref = parsePlanRef(e.planctl_target);
    if (ref === null) continue;
    // task ops pair to the TaskSnapshot (task id); scaffold/epic ops to the
    // EpicSnapshot (epic id).
    const entityId = ref.kind === "task" ? ref.task_id : ref.epic_id;
    const snapTs = firstSnapshotTs.get(entityId);
    if (snapTs === undefined) continue; // in-flight / out-of-window — SKIP
    const latency = snapTs - e.ts;
    // Re-fold guard: a re-fold mints a fresh snapshot ts. A negative latency
    // (snapshot before op) or an absurd one is an artifact, never a real lag.
    if (latency < 0 || latency > FOLD_LATENCY_SANITY_CAP) continue;
    if (latency < FOLD_LATENCY_REALTIME_THRESHOLD) continue;
    // Per-pair fingerprint: op + entity + the op's own ts pins it to THIS
    // op-instance so each slow op pages once (no counts/free-text in the fp).
    const resourceId = `${e.planctl_op}::${entityId}::${e.ts}`;
    findings.push({
      key: `fold-latency:${e.planctl_op}:${entityId}`,
      fingerprint: fingerprint("fold-latency", resourceId),
      severity: "warning",
      category: "fold-latency",
      title: `Fold latency ${Math.round(latency)}s`,
      detail: `${e.planctl_op} ${entityId} took ${Math.round(latency)}s to reach the projection (realtime bar ${FOLD_LATENCY_REALTIME_THRESHOLD}s — the realtime wake path likely dropped)`,
      evidence: {
        op: e.planctl_op,
        entityId,
        target: e.planctl_target,
        opTs: e.ts,
        snapshotTs: snapTs,
        latencySecs: Math.round(latency),
      },
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// backstop-degraded (fn-733) — ingest keeper's OWN backstop self-telemetry.
//
// keeper records every change-propagation backstop fire under
// `~/.local/state/keeper/backstop.ndjson` (fn-720): a `backstop-rescue` line
// per genuine rescue (carries `staleness_ms`) + periodic/on-shutdown
// `backstop-rollup` lines carrying the running `fires_total`/`rescues_total`
// per (backstop,class). Nobody was reading it. This detector ingests it.
//
// The detector is pure over the already-read text; the impurity (the file read
// + its (dev,ino) identity) is injected via `ScanDeps`. The DELTA logic needs
// a persistent baseline that the `SeenEntry.count` scalar can't hold (it needs
// `{fires_total, rescues_total, dev, ino}` per bucket), so a NEW sidecar
// `backstop-baseline.json` lives under `BABYSITTER_STATE_DIR`.
// ---------------------------------------------------------------------------

/** backstop-baseline.json schema version — bump to invalidate on shape change. */
export const BACKSTOP_BASELINE_VERSION = 4;

/**
 * One persisted per-(backstop,class) snapshot. Two jobs:
 *
 *  - the missed-wake delta-vs-baseline key — `fires_total`/`rescues_total` are
 *    the last observed running totals; the sidecar's `(dev,ino)` (carried at
 *    file scope, below) detects a daemon restart / log rotation so a counter
 *    reset reads as a reset, not a regression. The missed-wake delta now keys
 *    off `rescues_total` (the bad-outcome counter), `fires_total` is retained
 *    for evidence continuity. BOTH counters are OPTIONAL: a rescue-only bucket
 *    (rescues seen, no rollup yet) persists an entry carrying ONLY its
 *    watermark — its counters stay `undefined` so a later rollup seeds silently
 *    instead of diffing against a phantom 0.
 *
 *  - the rescue-staleness exclusive cursor — `rescue_watermark_ts` is the max
 *    finite `ts` of any rescue line seen for this bucket so far; the next tick
 *    only arms the staleness alarm on rescues with `ts >` this value (so one
 *    old resolved rescue never re-pages every cooldown window).
 */
export interface BackstopBaselineEntry {
  /** Last observed `fires_total` running total; absent on a rescue-only bucket. */
  fires_total?: number;
  /** Last observed `rescues_total` running total; absent on a rescue-only bucket. */
  rescues_total?: number;
  /** Max finite rescue `ts` seen for this bucket — the staleness exclusive cursor. */
  rescue_watermark_ts: number;
}

/**
 * The whole baseline file: a version tag, the backstop log's `(dev,ino)` at the
 * time the baseline was taken (identity-invalidation guard), and the
 * per-`${backstop} ${class}` counter map.
 */
export interface BackstopBaseline {
  version: number;
  /** `(dev,ino)` of `backstop.ndjson` when the baseline was last written. */
  dev: number | null;
  ino: number | null;
  buckets: Record<string, BackstopBaselineEntry>;
}

/** An empty baseline (cold start / corrupt-fallback). */
export function emptyBackstopBaseline(): BackstopBaseline {
  return {
    version: BACKSTOP_BASELINE_VERSION,
    dev: null,
    ino: null,
    buckets: {},
  };
}

/**
 * Resolve the backstop-baseline sidecar path under `BABYSITTER_STATE_DIR`
 * (its OWN dir, beside `seen.json` — NOT under the keeper state dir, so a
 * re-fold of keeper.db never observes the monitor's bookkeeping). Mirrors
 * {@link resolveSeenStatePath}.
 */
export function resolveBackstopBaselinePath(): string {
  return join(babysitterStateDir(SLUG), "backstop-baseline.json");
}

/**
 * Load the backstop baseline with corrupt/missing → empty fallback. NEVER
 * throws: a malformed file (bad JSON, wrong version, wrong shape) degrades to
 * an empty baseline so a poisoned file just re-seeds, never wedges the tick.
 */
export function loadBackstopBaseline(path: string): BackstopBaseline {
  if (!existsSync(path)) return emptyBackstopBaseline();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return emptyBackstopBaseline();
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.version !== BACKSTOP_BASELINE_VERSION) {
      return emptyBackstopBaseline();
    }
    if (typeof obj.buckets !== "object" || obj.buckets === null) {
      return emptyBackstopBaseline();
    }
    return {
      version: BACKSTOP_BASELINE_VERSION,
      dev: typeof obj.dev === "number" ? obj.dev : null,
      ino: typeof obj.ino === "number" ? obj.ino : null,
      buckets: obj.buckets as Record<string, BackstopBaselineEntry>,
    };
  } catch {
    return emptyBackstopBaseline();
  }
}

/**
 * Atomically persist the backstop baseline (tmp + rename via the shared
 * `atomicWriteFile`; creates the parent dir — launchd does not pre-create state
 * dirs). Stable bucket-key order so an unchanged re-write is byte-identical.
 */
export function saveBackstopBaseline(
  path: string,
  baseline: BackstopBaseline,
): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const ordered: Record<string, BackstopBaselineEntry> = {};
  for (const k of Object.keys(baseline.buckets).sort()) {
    ordered[k] = baseline.buckets[k];
  }
  atomicWriteFile(
    path,
    `${JSON.stringify(
      {
        version: BACKSTOP_BASELINE_VERSION,
        dev: baseline.dev,
        ino: baseline.ino,
        buckets: ordered,
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * backstop-degraded: ingest the backstop NDJSON text + the prior baseline, fire
 * on (a) a genuinely-NEW `backstop-rescue` (its `ts >` the bucket's stored
 * watermark) whose `staleness_ms ≥ STALENESS_ALARM` (null staleness — cold boot
 * — advances the watermark but never arms), or (b) a per-(backstop,class)
 * `rescues_total` DELTA vs the stored baseline that exceeds `MISSED_WAKE_DELTA`.
 * Returns the findings AND the next baseline to persist (so this stays pure —
 * the caller does the I/O).
 *
 * INCREMENTAL by construction (both signals). The staleness alarm uses a per-
 * bucket high-watermark EXCLUSIVE cursor (`ts > watermark`), so one old resolved
 * rescue never re-pages every cooldown window. The missed-wake delta keys off
 * `rescues_total` — the BAD-OUTCOME counter, not `fires_total` (total periodic
 * invocations) — per Prometheus `rate()` guidance.
 *
 * Baseline semantics (Prometheus `rate()` over a monotonic counter):
 *   - file `(dev,ino)` changed (or no prior identity), OR the 1→2 version
 *     reseed / a corrupt-file reseed ⇒ INVALIDATE the whole baseline; every
 *     bucket re-seeds silently this tick — the staleness alarm fires NOTHING and
 *     instead seeds the watermark to `max(ts)` seen this tick (else the first
 *     post-deploy tick re-pages ALL history), and the missed-wake delta seeds
 *     silently too. The watermark is SUBORDINATE to the `(dev,ino)` guard: the
 *     identity invalidates the whole baseline on rotation/restart; the watermark
 *     advances within one file's life.
 *   - otherwise, per bucket: a FIRST observation seeds silently (cold-start
 *     parity); `current < baseline` is a RESET ⇒ `delta = current`; else
 *     `delta = current − baseline`.
 *
 * `current < baseline` (a reset) deliberately does NOT fire even if
 * `current > MISSED_WAKE_DELTA` — a fresh process whose counter happens to
 * exceed the threshold is the restart case, not a regression; it re-seeds and
 * the NEXT tick measures a real delta.
 *
 * EVERY bucket the tick sees persists a `nextBuckets` entry carrying at least
 * its watermark — including a rescue-only bucket (rescues, no rollup), so its
 * cursor survives. A rescue-only bucket leaves the counter fields `undefined`
 * (NOT 0) so a later rollup seeds silently instead of computing a phantom delta.
 *
 * The exclusive `ts > watermark` cursor with millisecond-coarse `ts` could skip
 * a same-ms new rescue; acceptable (rescues are append-ordered producer wall-
 * clock — a new rescue lands at a strictly later ms in practice).
 *
 * Fingerprints are keyed on `${backstop} ${class}` ONLY (stable; no counts, no
 * ts) so the same bucket dedups across ticks. Degrade-don't-throw: empty /
 * absent text yields no finding (the caller passes `""` on a read failure).
 */
export function detectBackstopTelemetry(input: {
  text: string;
  prior: BackstopBaseline;
  /** Current `(dev,ino)` of the backstop log; null when the file is absent. */
  identity: { dev: number; ino: number } | null;
}): { findings: Finding[]; next: BackstopBaseline } {
  const stats = computeStats(input.text);

  // Identity invalidation: a changed (dev,ino) — or no prior identity, or no
  // current identity — means we can't trust the prior counters as a baseline
  // for THIS file, so the whole baseline is re-seeded (no delta fire this tick).
  const identityMatches =
    input.identity !== null &&
    input.prior.dev !== null &&
    input.prior.ino !== null &&
    input.prior.dev === input.identity.dev &&
    input.prior.ino === input.identity.ino;

  const findings: Finding[] = [];
  const nextBuckets: Record<string, BackstopBaselineEntry> = {};

  // Sorted bucket order for deterministic findings.
  const sortedRows = stats.rows
    .slice()
    .sort((a, b) =>
      `${a.backstop} ${a.class}`.localeCompare(`${b.backstop} ${b.class}`),
    );

  for (const row of sortedRows) {
    const bucket = `${row.backstop} ${row.class}`;
    // On a stable identity, the prior entry seeds both the watermark cursor and
    // the missed-wake baseline; a changed identity invalidates the whole thing
    // (re-seed silently this tick, fire nothing).
    const base = identityMatches ? input.prior.buckets[bucket] : undefined;

    // (a) rescue-LATENCY (fn-771) — INCREMENTAL via a per-bucket `ts` watermark.
    // Among this bucket's rescues with a finite `ts >` the prior watermark, take
    // the worst non-null `change_to_rescue_ms` (the TRUE freshness signal) and
    // classify it into warning/critical bands; the idle-inflated `staleness_ms`
    // is NO LONGER a classification gate (the 2026-06-10 false-critical: a 2s-old
    // commit rescued after 27 idle minutes reported staleness_ms=1611292). A
    // rescue whose latency is null — a dirty-tree-only / cold-boot rescue, OR an
    // old-format line that predates the field — is HEALTHY (an idle-then-instant
    // rescue is normal FSEvents delivery; liveness is the dead-man watchdog's
    // job, never a freshness gate). Per-record: mixed-version ndjson is the
    // steady state, so each sample classifies on its OWN latency.
    //
    // The watermark still advances over ALL rescues this tick (incl. null-
    // latency ones — their `ts` was seen). On a fresh/reseeded bucket (no prior
    // entry — a version reseed, corrupt-file reseed, or identity change) the
    // cursor starts at -Infinity so EVERY rescue is "new" by ts — but we MUST
    // fire nothing and only SEED the watermark, else the first post-deploy tick
    // re-pages all history. So: arm only when a prior entry existed for this
    // bucket (cf. how missed-wake seeds silently on first observation).
    //
    // The worst-staleness is still windowed alongside — NOT to classify, only to
    // carry into the finding evidence for a before/after shakeout comparison.
    const priorWatermark =
      base?.rescue_watermark_ts ?? Number.NEGATIVE_INFINITY;
    let maxTsThisTick = Number.NEGATIVE_INFINITY;
    let windowedMaxLatency: number | null = null;
    let windowedMaxStaleness: number | null = null;
    for (const s of row.samples) {
      if (!Number.isFinite(s.ts)) continue;
      // Advance the watermark over ALL rescues this tick (incl. null-latency).
      if (s.ts > maxTsThisTick) maxTsThisTick = s.ts;
      if (s.ts <= priorWatermark) continue; // exclusive cursor — only new rescues
      // Worst-case (oldest-commit) latency drives classification.
      if (
        s.change_to_rescue_ms !== null &&
        (windowedMaxLatency === null ||
          s.change_to_rescue_ms > windowedMaxLatency)
      ) {
        windowedMaxLatency = s.change_to_rescue_ms;
      }
      // Worst staleness rides along for evidence only (never classifies).
      if (
        s.staleness_ms !== null &&
        (windowedMaxStaleness === null || s.staleness_ms > windowedMaxStaleness)
      ) {
        windowedMaxStaleness = s.staleness_ms;
      }
    }
    // Carry the watermark forward: max(this tick's finite ts, the prior cursor)
    // so a tick with no new rescues never regresses the cursor. When neither a
    // prior cursor nor any rescue this tick exists (a fresh rollup-only bucket),
    // seed at 0 — a sane "no rescue ts seen yet" sentinel, never -Infinity.
    const carried = Math.max(
      maxTsThisTick,
      base?.rescue_watermark_ts ?? Number.NEGATIVE_INFINITY,
    );
    const nextWatermark = Number.isFinite(carried) ? carried : 0;

    // Fire only on a bucket that already had a baseline (so a fresh/reseeded
    // bucket seeds the watermark silently) AND a windowed latency at/over WARN.
    if (
      base !== undefined &&
      windowedMaxLatency !== null &&
      windowedMaxLatency >= MISSED_WAKE_LATENCY_WARN_MS
    ) {
      const isCritical = windowedMaxLatency >= MISSED_WAKE_LATENCY_CRIT_MS;
      findings.push({
        key: `backstop-staleness:${bucket}`,
        fingerprint: fingerprint("backstop-degraded", `staleness ${bucket}`),
        severity: isCritical ? "critical" : "warning",
        category: "backstop-degraded",
        title: `Backstop rescue ${Math.round(windowedMaxLatency / 1000)}s behind`,
        detail: `${row.backstop}/${row.class} rescued a change ${Math.round(windowedMaxLatency / 1000)}s after it landed (change_to_rescue_ms=${windowedMaxLatency} ≥ ${
          isCritical ? MISSED_WAKE_LATENCY_CRIT_MS : MISSED_WAKE_LATENCY_WARN_MS
        }) — ${
          row.class === "timeout"
            ? "exceeded its dispatch/confirm/sweep timeout"
            : "a fast path dropped a wake-up"
        }`,
        evidence: {
          backstop: row.backstop,
          class: row.class,
          changeToRescueMs: windowedMaxLatency,
          warnThresholdMs: MISSED_WAKE_LATENCY_WARN_MS,
          critThresholdMs: MISSED_WAKE_LATENCY_CRIT_MS,
          // Raw idleness-since-last-fast-path, retained for the shakeout
          // before/after comparison only — NOT a classification input.
          stalenessMs: windowedMaxStaleness,
        },
      });
    }

    // (b) missed-wake counter delta — keyed off `rescues_total` (the bad-
    // outcome counter, not total invocations). Needs a rollup + a stable
    // identity + a stored baseline counter. Seed silently otherwise.
    //
    // EVERY bucket the tick sees persists a `nextBuckets` entry carrying at
    // least its watermark (R4 — the writeback is OUT of the rollup guard so a
    // rescue-only bucket never loses its cursor). Counters are written ONLY
    // when a rollup landed; a rescue-only bucket leaves them `undefined` so a
    // later rollup seeds silently against `undefined` instead of a phantom 0.
    const entry: BackstopBaselineEntry = { rescue_watermark_ts: nextWatermark };
    if (row.fires_total !== null) entry.fires_total = row.fires_total;
    if (row.rescues_total !== null) entry.rescues_total = row.rescues_total;
    nextBuckets[bucket] = entry;

    if (row.rescues_total !== null) {
      // A missing baseline counter (first observation OR a rescue-only bucket
      // that never carried `rescues_total`) seeds silently.
      const baseRescues = base?.rescues_total;
      if (baseRescues !== undefined) {
        // Prometheus reset semantics: current < baseline ⇒ reset ⇒ delta =
        // current; else delta = current − baseline.
        const isReset = row.rescues_total < baseRescues;
        const delta = isReset
          ? row.rescues_total
          : row.rescues_total - baseRescues;
        // Per-name carve-out (fn-766): the events-ingest-poison backstop pages
        // on the FIRST rescue delta (INCLUSIVE `>= POISON_BACKSTOP_MIN_DELTA`) —
        // a poison line is a hard ingest fault, not a timing miss; the generic
        // missed-wake fires on the EXCLUSIVE `> MISSED_WAKE_DELTA` bar.
        const isPoison = row.backstop === POISON_BACKSTOP_NAME;
        const effectiveThreshold = isPoison
          ? POISON_BACKSTOP_MIN_DELTA
          : MISSED_WAKE_DELTA;
        const overBar = isPoison
          ? delta >= effectiveThreshold
          : delta > effectiveThreshold;
        // A reset (current < baseline) re-seeds and does NOT fire even if
        // current is large — that's a restart, not a regression.
        if (!isReset && overBar) {
          findings.push({
            key: `backstop-missed-wake:${bucket}`,
            fingerprint: fingerprint(
              "backstop-degraded",
              `missed-wake ${bucket}`,
            ),
            severity: "warning",
            category: "backstop-degraded",
            title: isPoison
              ? `Events-ingest poison rescued ${delta}x since baseline`
              : `Backstop ${bucket} rescued ${delta}x since baseline`,
            detail: isPoison
              ? `${row.backstop}/${row.class} rescues_total rose by ${delta} (${baseRescues}→${row.rescues_total}, ≥ ${effectiveThreshold}) — the events-log ingester quarantined a poison NDJSON line (malformed hook output or a parser skew)`
              : `${row.backstop}/${row.class} rescues_total rose by ${delta} (${baseRescues}→${row.rescues_total}, > ${effectiveThreshold}) — ${
                  row.class === "timeout"
                    ? "a dispatch/confirm/sweep timeout keeps elapsing"
                    : "a fast path is dropping wake-ups"
                }`,
            evidence: {
              backstop: row.backstop,
              class: row.class,
              delta,
              baselineRescues: baseRescues,
              currentRescues: row.rescues_total,
              baselineFires: base?.fires_total ?? null,
              currentFires: row.fires_total,
              threshold: effectiveThreshold,
            },
          });
        }
      }
    }
  }

  const next: BackstopBaseline = {
    version: BACKSTOP_BASELINE_VERSION,
    dev: input.identity?.dev ?? null,
    ino: input.identity?.ino ?? null,
    buckets: nextBuckets,
  };
  return { findings, next };
}

// ---------------------------------------------------------------------------
// DB layer — bounded read-only scan that wires the pure detectors.
// ---------------------------------------------------------------------------

/** Probes injected into {@link scan} so the DB layer is testable. */
export interface ScanDeps {
  /** Liveness probe for stuck-job + daemon-down (`isPidAlive` in prod). */
  isAlive: (pid: number) => boolean;
  /** True iff the keeperd UDS socket accepts a connection. */
  socketReachable: () => Promise<boolean>;
  /** True iff a keeperd process is alive. */
  keeperdAlive: () => boolean;
  /** Dead-letter file count under `resolveDeadLetterDir()`. */
  deadLetterCount: () => { count: number; dir: string };
  /** Wall-clock seconds (injected so age/window math is testable). */
  nowSecs: () => number;
  /**
   * Read the backstop-telemetry sidecar text + its `(dev,ino)` identity (the
   * fn-733 backstop-degraded ingest). The injected impurity: a read failure /
   * absent / empty file MUST resolve to `{ text: "", identity: null }` so the
   * detector reads as healthy (degrade-don't-throw). `null` keeps backstop
   * ingest OFF (the `.2` tick wires the live reader; older callers stay inert).
   */
  readBackstop?: () => {
    text: string;
    identity: { dev: number; ino: number } | null;
  };
  /**
   * Load + save the backstop counter baseline across ticks (a NEW sidecar the
   * `SeenEntry.count` scalar can't hold). `null` keeps the missed-wake DELTA
   * signal OFF; the rescue-staleness signal still fires (it needs no baseline).
   */
  backstopBaseline?: {
    load: () => BackstopBaseline;
    save: (next: BackstopBaseline) => void;
  };
  /**
   * fn-766 task 2 — disk footprint of the keeper.db + its `-wal` sidecar (the
   * `db-growth` watch). Injected impurity (a `statSync` of each file); a missing
   * WAL resolves `walBytes: null` (healthy). `undefined` keeps the watch OFF
   * (older callers stay inert).
   */
  dbSizes?: () => { dbBytes: number; walBytes: number | null };
  /**
   * fn-766 task 2 — per-pid events-log files joined to their stored ingest
   * offset (the `events-log-backlog` watch). The DB layer reads
   * `event_ingest_offsets` and `statSync`s each file; this lifts that out so the
   * pure detector sees only `(path, size, offset)`. `undefined` keeps it OFF.
   */
  eventsLogFiles?: () => { path: string; size: number; offset: number }[];
  /**
   * fn-766 task 2 — sampled keeperd %CPU (the `keeperd-cpu` watch). The one new
   * external input: a single `ps -o %cpu` fork per tick against the pgrep'd pid.
   * `null` (no keeperd / probe failure) is healthy here. `undefined` keeps the
   * watch OFF (older callers stay inert).
   */
  keeperdCpu?: () => number | null;
}

/** Run all the detectors over a bounded read-only scan of the live DB. */
export async function scan(
  dbPath: string,
  windowSecs: number,
  deps: ScanDeps,
): Promise<Finding[]> {
  const nowSecs = deps.nowSecs();
  const sinceTs = nowSecs - windowSecs;

  // prepareStmts:false is MANDATORY — the default builds an insertEvent stmt
  // naming every events column and throws on a schema-skewed live DB before
  // openDb returns. readonly:true is the never-write guarantee.
  const { db } = openDb(dbPath, { readonly: true, prepareStmts: false });
  try {
    // Bounded event-window read — only the columns the detectors touch.
    const events = db
      .query(
        `SELECT id, ts, session_id, hook_event, event_type, planctl_op, planctl_target, data
           FROM events WHERE ts >= ? ORDER BY id ASC`,
      )
      .all(sinceTs) as EventRow[];

    const dispatchFailures = db
      .query("SELECT verb, id, reason, dir, ts FROM dispatch_failures")
      .all() as DispatchFailureRow[];

    const jobs = db
      .query(
        "SELECT job_id, state, pid, created_at, title, plan_ref, plan_verb FROM jobs",
      )
      .all() as JobRow[];

    // close-loop (fn-771): a KEYED epics read for the epic-form plan_refs that
    // have close jobs — queried BY ID so a done epic's row is still visible
    // (the existing :1404 scalar open-count read scopes to status='open' and
    // can't see a freshly-done epic). A missing row → no map entry → the
    // detector degrades (no finding). The set is bounded by distinct close-job
    // epics, so the IN-list stays small; skip the read entirely when none.
    const closeLoopEpicIds = new Set<string>();
    for (const j of jobs) {
      if (j.plan_verb !== "close") continue;
      const parsed = parsePlanRef(j.plan_ref);
      if (parsed !== null && parsed.kind === "epic") {
        closeLoopEpicIds.add(parsed.epic_id);
      }
    }
    const closeLoopEpicStatus = new Map<string, string>();
    if (closeLoopEpicIds.size > 0) {
      const ids = [...closeLoopEpicIds];
      const placeholders = ids.map(() => "?").join(", ");
      const rows = db
        .query(
          `SELECT epic_id, status FROM epics WHERE epic_id IN (${placeholders})`,
        )
        .all(...ids) as { epic_id: string; status: string }[];
      for (const r of rows) closeLoopEpicStatus.set(r.epic_id, r.status);
    }

    const autopilot = db
      .query(
        "SELECT paused, last_event_id, mode FROM autopilot_state WHERE id = 1",
      )
      .get() as AutopilotStateRow | null;

    const maxRow = db.query("SELECT MAX(id) AS maxId FROM events").get() as {
      maxId: number | null;
    };
    const reducerRow = db
      .query(
        "SELECT last_event_id AS lastEventId FROM reducer_state WHERE id = 1",
      )
      .get() as { lastEventId: number } | null;

    // readyWork heuristic: an open epic carries ≥1 non-completed task. The
    // recalibration note (epic spec, fn-727 overlap) lives here — if completion
    // verdict recording changes, revisit this signal. Kept conservative: we
    // count epics with status='open' as "has ready work" surface.
    const openEpics = db
      .query("SELECT COUNT(*) AS n FROM epics WHERE status = 'open'")
      .get() as { n: number };
    const readyWorkExists = openEpics.n > 0;

    // recent Dispatched within the autopilot-stall window.
    const recentDispatchSince = nowSecs - AUTOPILOT_STALL_WINDOW_SECS;
    const recentDispatchRow = db
      .query(
        "SELECT COUNT(*) AS n FROM events WHERE hook_event = 'Dispatched' AND ts >= ?",
      )
      .get(recentDispatchSince) as { n: number };

    // autopilot-stall mode-awareness (fn-766): in `armed` mode with zero armed
    // epics the autopilot is legitimately idle (nothing to dispatch), so the
    // detector reads `mode` + the `armed_epics` row count rather than false-
    // paging on open-epics-but-idle. `mode` defaults to 'yolo' on a NULL /
    // pre-v62 column (the work-everything baseline). The COUNT degrades to 0 on
    // a pre-v62 DB whose `armed_epics` table doesn't exist yet.
    const autopilotMode = autopilot?.mode ?? "yolo";
    let armedCount = 0;
    try {
      const armedRow = db
        .query("SELECT COUNT(*) AS n FROM armed_epics")
        .get() as { n: number };
      armedCount = armedRow.n;
    } catch {
      // pre-v62 DB without the armed_epics table → treat as none armed.
      armedCount = 0;
    }

    const dl = deps.deadLetterCount();
    const socketReachable = await deps.socketReachable();
    const keeperdAlive = deps.keeperdAlive();

    // poison-arrivals (fn-766): the count of dead_letters parked with
    // status='poison' (the fn-762 events-ingest poison surface). Degrade-don't-
    // throw: a pre-fn-643 DB without the `status` column → treat as 0.
    let poisonCount = 0;
    try {
      const poisonRow = db
        .query("SELECT COUNT(*) AS n FROM dead_letters WHERE status = 'poison'")
        .get() as { n: number };
      poisonCount = poisonRow.n;
    } catch {
      poisonCount = 0;
    }

    const findings: Finding[] = [
      ...detectDupDispatch(events),
      ...detectDispatchFailures(dispatchFailures),
      ...detectDaemonDown({ socketReachable, keeperdAlive }),
      ...detectReducerWedge({
        maxEventId: maxRow.maxId ?? 0,
        lastEventId: reducerRow?.lastEventId ?? 0,
      }),
      ...detectDeadLetterGrowth(dl),
      ...detectAutopilotStall({
        paused: autopilot ? autopilot.paused !== 0 : true,
        readyWorkExists,
        recentDispatch: recentDispatchRow.n > 0,
        mode: autopilotMode,
        armedCount,
      }),
      ...detectStuckJobs({ jobs, nowSecs, isAlive: deps.isAlive }),
      // fold-latency: pure over the event window (op→first-matching snapshot).
      ...detectFoldLatency(events),
      // fn-766 task 2: the LOAD-BEARING re-fire tripwire — >1 live worker on one
      // plan_ref. Reads jobs + the already-injected isAlive (no new input).
      ...detectDuplicateLiveWorkers({ jobs, isAlive: deps.isAlive }),
      // fn-771 task 1: the STATE-based close-loop arm — ≥N close jobs against
      // one still-open epic over a day. Pairs with dup-dispatch's rate arm.
      ...detectCloseLoop({
        jobs,
        epicStatus: closeLoopEpicStatus,
        nowSecs,
      }),
      // fn-766 task 2: poison-parked dead-letter count (delta-gated downstream).
      ...detectPoisonArrivals({ count: poisonCount }),
    ];

    // fn-766 task 2 — the three watches needing an injected external probe. Each
    // stays OFF for a caller that didn't wire it (older callers / quiet tests),
    // mirroring the readBackstop pattern; never throws if the probe is present.
    if (deps.dbSizes !== undefined) {
      findings.push(...detectDbGrowth(deps.dbSizes()));
    }
    if (deps.eventsLogFiles !== undefined) {
      findings.push(
        ...detectEventsLogBacklog({ files: deps.eventsLogFiles() }),
      );
    }
    if (deps.keeperdCpu !== undefined) {
      findings.push(...detectKeeperdCpu({ cpuPct: deps.keeperdCpu() }));
    }

    // backstop-degraded: ingest keeper's OWN backstop self-telemetry. The read
    // + the baseline persistence are injected (so the detector stays pure); a
    // missing reader keeps the signal OFF (older callers stay inert). The whole
    // ingest degrades to no-finding on any read failure (readBackstop returns
    // empty text), never crashing the scan.
    if (deps.readBackstop !== undefined) {
      const { text, identity } = deps.readBackstop();
      const prior = deps.backstopBaseline?.load() ?? emptyBackstopBaseline();
      const { findings: backstopFindings, next } = detectBackstopTelemetry({
        text,
        prior,
        identity,
      });
      // Persist the rolled-forward baseline so the next tick measures a real
      // delta. The DELTA signal only fires when a baseline persists (load/save
      // wired); the rescue-staleness signal fires regardless.
      deps.backstopBaseline?.save(next);
      findings.push(...backstopFindings);
    }
    return findings;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Production probes (live socket / process / dead-letter dir).
// ---------------------------------------------------------------------------

/**
 * True iff a `Bun.connect` to the keeperd UDS opens within `timeoutMs`. A
 * refused / absent socket resolves `false`. Best-effort + short-lived — the
 * connection is closed immediately; we never write a frame.
 */
export async function probeSocket(
  sockPath: string,
  timeoutMs = 500,
): Promise<boolean> {
  if (!existsSync(sockPath)) return false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (v: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
    Bun.connect({
      unix: sockPath,
      socket: {
        open(s) {
          clearTimeout(timer);
          try {
            s.end();
          } catch {
            // best-effort
          }
          done(true);
        },
        error() {
          clearTimeout(timer);
          done(false);
        },
        close() {
          // no-op
        },
        data() {
          // no-op
        },
      },
    }).catch(() => {
      clearTimeout(timer);
      done(false);
    });
  });
}

/**
 * True iff a `keeperd` process is alive. Best-effort `pgrep -f` against the
 * daemon entrypoint; a non-zero exit (no match) or any spawn failure resolves
 * `false`. Used ONLY as the corroborating signal for daemon-down (an external
 * observer's probe, never a fold).
 */
export function probeKeeperd(): boolean {
  try {
    const res = Bun.spawnSync(["pgrep", "-f", "src/daemon.ts"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    return res.exitCode === 0 && res.stdout.toString().trim().length > 0;
  } catch {
    return false;
  }
}

/** Count files under the dead-letter dir; an absent dir is count 0. */
export function countDeadLetters(dir: string): { count: number; dir: string } {
  if (!existsSync(dir)) return { count: 0, dir };
  try {
    const entries = readdirSync(dir);
    return { count: entries.length, dir };
  } catch {
    return { count: 0, dir };
  }
}

/**
 * Read the backstop-telemetry sidecar text + its `(dev,ino)` identity. Absent /
 * unreadable file resolves to `{ text: "", identity: null }` (degrade-don't-
 * throw): the detector reads that as healthy. The `(dev,ino)` is the
 * Prometheus-reset / log-rotation identity guard for the counter baseline.
 */
export function readBackstopLog(path: string): {
  text: string;
  identity: { dev: number; ino: number } | null;
} {
  if (!existsSync(path)) return { text: "", identity: null };
  try {
    const st = statSync(path);
    const text = readFileSync(path, "utf8");
    return { text, identity: { dev: st.dev, ino: st.ino } };
  } catch {
    return { text: "", identity: null };
  }
}

/**
 * fn-766 task 2 — sampled keeperd %CPU for the `keeperd-cpu` watch. Two
 * best-effort forks: `pgrep -f src/daemon.ts` for the pid, then `ps -o %cpu= -p
 * <pid>` for its instantaneous CPU. Any miss / non-numeric / spawn failure
 * resolves `null` (healthy — daemon-down is a separate detector). The one new
 * external input the epic flagged; read-only, no DB touch.
 */
export function probeKeeperdCpu(): number | null {
  try {
    const pg = Bun.spawnSync(["pgrep", "-f", "src/daemon.ts"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (pg.exitCode !== 0) return null;
    const pid = pg.stdout.toString().trim().split(/\s+/)[0];
    if (pid === undefined || pid.length === 0) return null;
    const ps = Bun.spawnSync(["ps", "-o", "%cpu=", "-p", pid], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (ps.exitCode !== 0) return null;
    const cpu = Number(ps.stdout.toString().trim());
    return Number.isFinite(cpu) ? cpu : null;
  } catch {
    return null;
  }
}

/**
 * fn-766 task 2 — keeper.db + `-wal` byte sizes for the `db-growth` watch.
 * `statSync` of each file; an absent WAL resolves `walBytes: null` (healthy). A
 * stat failure on the DB itself resolves `dbBytes: 0` (degrade-don't-throw).
 */
export function readDbSizes(dbPath: string): {
  dbBytes: number;
  walBytes: number | null;
} {
  let dbBytes = 0;
  try {
    dbBytes = statSync(dbPath).size;
  } catch {
    dbBytes = 0;
  }
  let walBytes: number | null = null;
  try {
    walBytes = statSync(`${dbPath}-wal`).size;
  } catch {
    walBytes = null;
  }
  return { dbBytes, walBytes };
}

/**
 * fn-766 task 2 — the per-pid events-log files joined to their stored ingest
 * offset, for the `events-log-backlog` watch. Opens its OWN read-only connection
 * (the same external-observer posture as the main scan; never writes) to read
 * `event_ingest_offsets`, then `statSync`s each `<events-log-dir>/<path>`. A row
 * whose file is absent / unreadable is skipped (degrade-don't-throw); the whole
 * probe resolves `[]` on any failure so the watch stays inert rather than
 * crashing the tick. The stored `path` is the basename the daemon recorded.
 */
export function readEventsLogFiles(
  dbPath: string,
  eventsLogDir: string,
): { path: string; size: number; offset: number }[] {
  let rows: { path: string; offset: number }[] = [];
  try {
    const { db } = openDb(dbPath, { readonly: true, prepareStmts: false });
    try {
      rows = db
        .query("SELECT path, offset FROM event_ingest_offsets")
        .all() as { path: string; offset: number }[];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
  const out: { path: string; size: number; offset: number }[] = [];
  for (const r of rows) {
    // The stored `path` may be a basename or an absolute path; resolve both.
    const full = r.path.startsWith("/") ? r.path : join(eventsLogDir, r.path);
    try {
      const size = statSync(full).size;
      out.push({ path: full, size, offset: r.offset });
    } catch {
      // File gone / unreadable — the ingester rotated it; nothing to backlog.
    }
  }
  return out;
}

/** Production {@link ScanDeps} wiring the live probes. */
export function liveDeps(): ScanDeps {
  const backstopBaselinePath = resolveBackstopBaselinePath();
  const dbPath = resolveDbPath();
  return {
    isAlive: isPidAlive,
    socketReachable: () => probeSocket(resolveSockPath()),
    keeperdAlive: probeKeeperd,
    deadLetterCount: () => countDeadLetters(resolveDeadLetterDir()),
    nowSecs: () => Date.now() / 1000,
    readBackstop: () => readBackstopLog(resolveBackstopLogPath()),
    backstopBaseline: {
      load: () => loadBackstopBaseline(backstopBaselinePath),
      save: (next) => saveBackstopBaseline(backstopBaselinePath, next),
    },
    dbSizes: () => readDbSizes(dbPath),
    eventsLogFiles: () => readEventsLogFiles(dbPath, resolveEventsLogDir()),
    keeperdCpu: probeKeeperdCpu,
  };
}

// ---------------------------------------------------------------------------
// Seen-state — persistent dedup substrate for `--tick`.
//
// Lives at ~/.local/state/babysitters/performance/seen.json (its OWN dir, NOT a KEEPER_*
// path — a keeper.db re-fold must never observe the monitor's bookkeeping).
// Schema is keyed by fingerprint; each entry tracks the observation history that
// drives the TTL prune and the held-across-ticks finalizers. Written atomically
// (tmp + rename, via the shared atomicWriteFile) so a crash mid-write leaves the
// prior file intact; a corrupt/missing file loads as an empty baseline.
// ---------------------------------------------------------------------------

/**
 * seen.json schema version. fn-792 bumped 1→2 dropping the page-history fields
 * (`notification_count`/`last_notified_at`/`spawn_failures`) when the sitter
 * converged on the pull model — a one-time silent re-baseline on the production
 * host is accepted (persistent findings re-fire next tick; previously-paged
 * findings already have follow-ups). A version mismatch loads as empty.
 */
export const SEEN_STATE_VERSION = 2;

/** TTL: prune an entry not seen within this span (24h). */
export const SEEN_TTL_SECS = 24 * 60 * 60;
/** Held-across-ticks confirmation: a signal must persist this many ticks. */
export const HELD_TICKS_THRESHOLD = 3;

/**
 * One fingerprint's observation history. `first_seen`/`last_seen` drive the
 * follow-up staleness stamps and the TTL prune; `held_ticks` drives the
 * held-across-ticks finalizers; `count` carries the per-category baseline (e.g.
 * dead-letter count) for delta logic.
 */
export interface SeenEntry {
  first_seen: number;
  last_seen: number;
  /** Consecutive ticks this fingerprint has been present (held-across-ticks). */
  held_ticks: number;
  /** Category-specific baseline count (dead-letter delta etc.); null if N/A. */
  count: number | null;
}

/**
 * The whole seen-state file: a version tag, a fingerprint→entry map, and a
 * `baselined` flag. `baselined` is the cold-start sentinel: it is `false` on a
 * fresh / corrupt / missing file and is flipped `true` by the first valid tick.
 * It is INDEPENDENT of finding count — an empty-but-baselined state (a healthy
 * system with zero findings) is distinct from a cold start, so the next genuine
 * finding escalates rather than re-baselining.
 */
export interface SeenState {
  version: number;
  baselined: boolean;
  fingerprints: Record<string, SeenEntry>;
}

/** An empty, NOT-yet-baselined state (cold start / corrupt-fallback). */
export function emptySeenState(): SeenState {
  return { version: SEEN_STATE_VERSION, baselined: false, fingerprints: {} };
}

/**
 * Resolve the seen-state file path. `BABYSITTER_STATE_DIR` env wins (tests +
 * the spawn-test sandbox point it at a tmpdir); otherwise default to
 * `~/.local/state/babysitters/performance/seen.json`. Deliberately its OWN dir — NOT
 * under the keeper state dir — so the monitor's bookkeeping never sits beside
 * keeper.db. Resolver shape mirrors `resolveDbPath` (pure, no I/O).
 */
export function resolveSeenStatePath(): string {
  return join(babysitterStateDir(SLUG), "seen.json");
}

/**
 * Resolve the liveness-heartbeat file path — a sibling of seen.json under
 * `BABYSITTER_STATE_DIR` (default `~/.local/state/babysitters/performance/`).
 * Written as the LAST action on every completed tick path so a hung / crashed
 * tick never touches it; `/babysit-triage` reads its staleness as the sitter's
 * liveness signal (the pull-model replacement for the retired watchdog). Pure
 * (no I/O); mirrors {@link resolveSeenStatePath}.
 */
export function resolveHeartbeatPath(): string {
  return join(babysitterStateDir(SLUG), "heartbeat.json");
}

/** The follow-ups corpus dir — one self-contained brief per NEW finding. */
export function resolveFollowupsDir(): string {
  return join(babysitterStateDir(SLUG), "followups");
}

/**
 * Atomically stamp the liveness heartbeat `{ ts }` at the END of a completed
 * tick. Attests "the performance sitter ran a tick to completion," NOT "keeperd is
 * healthy" (daemon-down is a separate detector). DEGRADE-DON'T-THROW: a write
 * failure (missing dir, full disk) is swallowed — a wedged tick is worse than a
 * missed heartbeat; `/babysit-triage` reads staleness here as the liveness
 * signal, so a genuinely dead tick simply stops stamping.
 */
export function writeHeartbeat(path: string, nowSecs: number): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    atomicWriteFile(path, `${JSON.stringify({ ts: nowSecs })}\n`);
  } catch {
    // Swallow: never wedge a tick on a heartbeat write. A genuinely dead tick
    // stops stamping and triage's staleness check surfaces the death.
  }
}

/**
 * Load seen-state with corrupt/missing → empty fallback. NEVER throws: a
 * malformed file (bad JSON, wrong version, wrong shape) degrades to an empty
 * baseline so a poisoned file can't wedge the tick (it just re-baselines).
 */
export function loadSeenState(path: string): SeenState {
  if (!existsSync(path)) return emptySeenState();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return emptySeenState();
    const obj = parsed as Record<string, unknown>;
    if (obj.version !== SEEN_STATE_VERSION) return emptySeenState();
    if (typeof obj.fingerprints !== "object" || obj.fingerprints === null) {
      return emptySeenState();
    }
    return {
      version: SEEN_STATE_VERSION,
      baselined: obj.baselined === true,
      fingerprints: obj.fingerprints as Record<string, SeenEntry>,
    };
  } catch {
    return emptySeenState();
  }
}

/**
 * Atomically persist seen-state. Creates the parent dir if missing (launchd
 * does not pre-create state dirs), then writes via the shared `atomicWriteFile`
 * (tmp-in-same-dir + `renameSync`) so a crash leaves the prior file intact.
 */
export function saveSeenState(path: string, state: SeenState): void {
  mkdirSync(join(path, ".."), { recursive: true });
  // Stable key order so a re-write of unchanged state is byte-identical.
  const ordered: Record<string, SeenEntry> = {};
  for (const fp of Object.keys(state.fingerprints).sort()) {
    ordered[fp] = state.fingerprints[fp];
  }
  atomicWriteFile(
    path,
    `${JSON.stringify({ version: SEEN_STATE_VERSION, baselined: state.baselined, fingerprints: ordered }, null, 2)}\n`,
  );
}

// ---------------------------------------------------------------------------
// Held-across-ticks finalizers — gate the .1 "magnitude" signals on history.
//
// The .1 detectors fire the instant a condition is present; for the three
// noisy/transient classes we hold escalation until the condition has persisted.
// These run on the ALREADY-SCANNED findings + the prior seen-state, BEFORE the
// dedup diff, so a transient blip never escalates.
// ---------------------------------------------------------------------------

/**
 * Categories whose escalation is gated on persistence/delta rather than on a
 * single present scan. reducer-wedge / autopilot-stall / events-log-backlog /
 * keeperd-cpu require the condition to have held ≥`HELD_TICKS_THRESHOLD`
 * consecutive ticks; dead-letter-growth / poison-arrivals require a POSITIVE
 * delta vs the stored baseline count.
 *
 * fn-766 task 2 additions: `events-log-backlog` (a few un-flushed bytes mid-
 * append is normal — only a PERSISTENT backlog is a wedge) and `keeperd-cpu` (a
 * brief fold-burst spike is normal — only SUSTAINED 25%+ is the fn-748 busy-loop
 * class) are held; `poison-arrivals` is delta-gated like `dead-letter-growth`.
 * `duplicate-live-workers` is deliberately NOT here — two live workers on one
 * plan_ref pages IMMEDIATELY (it's the load-bearing re-fire tripwire).
 * `close-loop` (fn-771) is likewise NOT here — an accumulating close-loop
 * against a still-open epic pages immediately, and its still-open predicate
 * self-clears the finding the moment the epic flips done.
 */
const HELD_TICK_CATEGORIES = new Set<Category>([
  "reducer-wedge",
  "autopilot-stall",
  "events-log-backlog",
  "keeperd-cpu",
]);

/**
 * Categories whose escalation requires a POSITIVE delta vs the stored baseline
 * `count` (seeds silently on first observation, fires when the count rises).
 * Both watch a monotonically-meaningful count surface.
 */
const DELTA_GATE_CATEGORIES = new Set<Category>([
  "dead-letter-growth",
  "poison-arrivals",
]);

/**
 * Apply the held-across-ticks / delta gate. Returns the findings that have
 * cleared their gate this tick, plus a `heldTicks` map (fingerprint → updated
 * consecutive-present count) and a `counts` map (fingerprint → current count)
 * to fold into seen-state. A held finding still PRESENT but not yet over
 * threshold is suppressed (it accrues a tick); a dead-letter finding with a
 * non-positive delta vs baseline is suppressed.
 *
 * Pure: takes the current findings, the prior seen-state, and returns the
 * gated set — no I/O, no clock.
 */
export function applyHeldGate(
  findings: Finding[],
  prior: SeenState,
): {
  gated: Finding[];
  heldTicks: Map<string, number>;
  counts: Map<string, number>;
} {
  const heldTicks = new Map<string, number>();
  const counts = new Map<string, number>();
  const gated: Finding[] = [];
  for (const f of findings) {
    if (HELD_TICK_CATEGORIES.has(f.category)) {
      const priorHeld = prior.fingerprints[f.fingerprint]?.held_ticks ?? 0;
      const held = priorHeld + 1;
      heldTicks.set(f.fingerprint, held);
      if (held >= HELD_TICKS_THRESHOLD) gated.push(f);
      continue;
    }
    if (DELTA_GATE_CATEGORIES.has(f.category)) {
      const current = Number(f.evidence.count ?? 0);
      counts.set(f.fingerprint, current);
      const baseline = prior.fingerprints[f.fingerprint]?.count;
      // Cold start (no baseline yet) → seed, don't escalate. A POSITIVE delta
      // vs a stored baseline is the escalating condition.
      if (baseline !== null && baseline !== undefined && current > baseline) {
        gated.push(f);
      }
      continue;
    }
    gated.push(f);
  }
  return { gated, heldTicks, counts };
}

// ---------------------------------------------------------------------------
// Dedup diff — decide which gated findings are genuinely NEW this tick.
// ---------------------------------------------------------------------------

/**
 * The gated findings genuinely NEW this tick: fingerprint absent from the prior
 * seen-state. A still-present fingerprint is suppressed (no rewrite of the same
 * follow-up); a fingerprint that re-fires after its TTL prune is absent again,
 * so it re-selects and gets a fresh follow-up (the resurface rule). Pure: no I/O.
 */
export function selectNew(gated: Finding[], prior: SeenState): Finding[] {
  return gated.filter((f) => prior.fingerprints[f.fingerprint] === undefined);
}

/**
 * Fold a completed tick into a fresh seen-state. Always-pure rebuild from the
 * prior state + this tick's scan results (no in-place mutation):
 *   - every present fingerprint refreshes `last_seen` (+ first_seen on debut),
 *     held_ticks / count from the gate — EXCEPT a genuinely-new fingerprint
 *     whose follow-up write FAILED (`writeFailed`), which is dropped so it
 *     re-selects and retries next tick (best-effort write contract);
 *   - entries whose fingerprint is NOT present this tick AND are older than the
 *     TTL are pruned.
 *
 * Pure: takes maps + sets + arrays, returns the new state.
 */
export function foldSeenState(input: {
  prior: SeenState;
  present: Finding[];
  heldTicks: Map<string, number>;
  counts: Map<string, number>;
  /** Genuinely-new fingerprints whose follow-up write FAILED — do not commit. */
  writeFailed: Set<string>;
  nowSecs: number;
}): SeenState {
  const { prior, present, heldTicks, counts, writeFailed, nowSecs } = input;
  const next: Record<string, SeenEntry> = {};
  const committedFps = new Set<string>();

  for (const f of present) {
    // A genuinely-new finding (absent from prior) whose write failed is NOT
    // committed: leaving it out makes it `selectNew` again next tick so the
    // write retries. A previously-seen present finding always refreshes.
    const e = prior.fingerprints[f.fingerprint];
    if (e === undefined && writeFailed.has(f.fingerprint)) continue;
    const heldFromGate = heldTicks.get(f.fingerprint);
    const countFromGate = counts.get(f.fingerprint);
    next[f.fingerprint] = {
      first_seen: e?.first_seen ?? nowSecs,
      last_seen: nowSecs,
      held_ticks: heldFromGate ?? 0,
      count: countFromGate ?? e?.count ?? null,
    };
    committedFps.add(f.fingerprint);
  }

  // Carry forward not-present entries that are still within the TTL.
  for (const fp of Object.keys(prior.fingerprints)) {
    if (committedFps.has(fp)) continue;
    const e = prior.fingerprints[fp];
    if (nowSecs - e.last_seen <= SEEN_TTL_SECS) next[fp] = e;
  }

  // Any fold output is the result of a completed tick → the state is baselined
  // (independent of finding count, so a healthy zero-finding tick still counts).
  return { version: SEEN_STATE_VERSION, baselined: true, fingerprints: next };
}

// ---------------------------------------------------------------------------
// Follow-up writer config — the pull-model replacement for the agent spawn.
//
// The scanner writes one self-contained brief per genuinely-NEW finding DIRECTLY
// to the corpus `/babysit-triage` reads (the shared `babysitters/lib/followups`
// writer), no agent spawn and no page. The body below is this sitter's fixed
// human-authored instruction block — untrusted DB strings live ONLY inside the
// fenced `## Evidence` block the lib renders.
// ---------------------------------------------------------------------------

/** This sitter's follow-up config: filename prefix + the investigation body. */
const FOLLOWUP_CONFIG: FollowupConfig = {
  slug: SLUG,
  body: (nowIso) =>
    `You are investigating a keeper finding the babysitter flagged at ${nowIso}.
Analyze the evidence and propose a fix.

Your task, in order:
1. Confirm the impact is real (read keeper.db / the relevant projection read-only; do not mutate state).
2. Locate the suspected root-cause file and region.
3. Propose a concrete fix.`,
};

// ---------------------------------------------------------------------------
// The `--tick` flow — scan, diff vs seen-state, write a follow-up per NEW finding.
// ---------------------------------------------------------------------------

/**
 * Inject the follow-up write so tests drive the write path (capture / force a
 * failure) without touching the real corpus. Returns true on a committed write.
 * Production binds the shared lib writer to this sitter's config + stamps.
 */
export type WriteFollowupFn = (input: {
  finding: Finding;
  nowSecs: number;
  nowIso: string;
  stamps: FollowupStamps;
}) => boolean;

/** The production follow-up write: the shared lib writer, this sitter's config. */
export function liveWriteFollowup(followupsDir: string): WriteFollowupFn {
  return ({ finding, nowSecs, nowIso, stamps }) =>
    writeFollowup(
      FOLLOWUP_CONFIG,
      followupsDir,
      finding,
      nowSecs,
      nowIso,
      stamps,
    );
}

/** Deps injected into {@link tick} so the whole flow is testable. */
export interface TickDeps extends ScanDeps {
  /** Write one follow-up file (defaults to {@link liveWriteFollowup}). */
  writeFollowup: WriteFollowupFn;
}

/** Production {@link TickDeps}: live probes + the shared-lib follow-up writer. */
export function liveTickDeps(): TickDeps {
  return {
    ...liveDeps(),
    writeFollowup: liveWriteFollowup(resolveFollowupsDir()),
  };
}

/**
 * One launchd tick: scan the live DB, apply the held-across-ticks gate, diff
 * vs persistent seen-state, and on genuinely-NEW findings WRITE one follow-up
 * file each DIRECTLY to the corpus `/babysit-triage` reads — no agent spawn, no
 * page. Commits seen-state per the outcome:
 *   - cold start / corrupt seen.json → SILENT BASELINE (seed all, write none);
 *   - no new findings → exit silently, refresh seen-state only;
 *   - new findings → write each (best-effort), commit only the written ones, fold.
 *
 * Writes are BEST-EFFORT: a failed write logs, leaves that fingerprint
 * uncommitted (so it retries next tick), and the tick still exits 0 — never
 * throws, never wedges. Returns a small result for the CLI + tests.
 */
export async function tick(
  dbPath: string,
  windowSecs: number,
  deps: TickDeps,
  seenStatePath: string,
  heartbeatPath: string = resolveHeartbeatPath(),
): Promise<{
  baselined: boolean;
  wrote: boolean;
  selectedCount: number;
  writtenCount: number;
}> {
  const nowSecs = deps.nowSecs();

  // First-boot guard: before keeperd has ever created `keeper.db`, the
  // read-only `openDb` in `scan` skips the existsSync directory guard and lets
  // SQLite throw on the missing file. The launchd contract is always-exit-0, so
  // a missing DB is harmless — return the silent-baseline shape without
  // scanning or touching seen-state.
  if (!existsSync(dbPath)) {
    // A missing-DB early return is still a COMPLETED tick (the sitter ran;
    // keeperd simply hasn't booted yet). Stamp the heartbeat as the last action
    // so triage's staleness check doesn't false-flag before first daemon boot.
    writeHeartbeat(heartbeatPath, nowSecs);
    return {
      baselined: false,
      wrote: false,
      selectedCount: 0,
      writtenCount: 0,
    };
  }

  const findings = sortFindings(await scan(dbPath, windowSecs, deps));
  const prior = loadSeenState(seenStatePath);

  // Held-across-ticks / delta gate runs against the PRIOR state before we fold.
  const { gated, heldTicks, counts } = applyHeldGate(findings, prior);

  // Cold start / corrupt → silent baseline: seed everything, write nothing.
  // Keyed on `prior.baselined` (NOT finding count): a fresh / corrupt / missing
  // file loads `baselined:false`, so the first valid tick only establishes the
  // baseline — but a healthy zero-finding tick is already baselined, so the
  // next genuine finding gets a follow-up instead of re-baselining.
  if (!prior.baselined) {
    saveSeenState(
      seenStatePath,
      foldSeenState({
        prior,
        present: findings,
        heldTicks,
        counts,
        writeFailed: new Set(),
        nowSecs,
      }),
    );
    writeHeartbeat(heartbeatPath, nowSecs);
    return { baselined: true, wrote: false, selectedCount: 0, writtenCount: 0 };
  }

  const selected = selectNew(gated, prior);
  if (selected.length === 0) {
    // Nothing new — refresh seen-state (last_seen / held_ticks / TTL prune) and
    // exit silently.
    saveSeenState(
      seenStatePath,
      foldSeenState({
        prior,
        present: findings,
        heldTicks,
        counts,
        writeFailed: new Set(),
        nowSecs,
      }),
    );
    writeHeartbeat(heartbeatPath, nowSecs);
    return {
      baselined: false,
      wrote: false,
      selectedCount: 0,
      writtenCount: 0,
    };
  }

  // Write one follow-up per genuinely-new finding. The staleness stamps come
  // from the seen-state on debut (first_seen === last_seen === now this tick).
  // A failed write is BEST-EFFORT: it leaves the fingerprint uncommitted so the
  // next tick re-selects + retries — never throws, never wedges the tick.
  const nowIso = new Date(nowSecs * 1000).toISOString();
  const firstSeenAt: Record<string, number> = {};
  for (const f of selected) {
    firstSeenAt[f.fingerprint] =
      prior.fingerprints[f.fingerprint]?.first_seen ?? nowSecs;
  }
  const writeFailed = new Set<string>();
  let writtenCount = 0;
  for (const f of selected) {
    const firstSeen = firstSeenAt[f.fingerprint];
    const ok = deps.writeFollowup({
      finding: f,
      nowSecs,
      nowIso,
      stamps: {
        first_seen_at: new Date(firstSeen * 1000).toISOString(),
        last_seen_at: nowIso,
      },
    });
    if (ok) writtenCount += 1;
    else writeFailed.add(f.fingerprint);
  }

  saveSeenState(
    seenStatePath,
    foldSeenState({
      prior,
      present: findings,
      heldTicks,
      counts,
      writeFailed,
      nowSecs,
    }),
  );

  writeHeartbeat(heartbeatPath, nowSecs);
  return {
    baselined: false,
    wrote: writtenCount > 0,
    selectedCount: selected.length,
    writtenCount,
  };
}

// ---------------------------------------------------------------------------
// Output modes
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/** Stable sort: severity (critical first), then key. */
export function sortFindings(findings: Finding[]): Finding[] {
  return findings.slice().sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    return a.key.localeCompare(b.key);
  });
}

/** Render the findings as a human-readable table on stdout. */
function printTable(findings: Finding[]): void {
  if (findings.length === 0) {
    process.stdout.write("babysitter performance: no findings\n");
    return;
  }
  const lines: string[] = [
    `babysitter performance: ${findings.length} finding(s)`,
    "",
  ];
  for (const f of findings) {
    lines.push(`[${f.severity.toUpperCase()}] ${f.category}  ${f.key}`);
    lines.push(`    ${f.detail}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

interface ParsedArgs {
  json: boolean;
  tick: boolean;
  windowSecs: number;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    json: false,
    tick: false,
    windowSecs: DEFAULT_WINDOW_SECS,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      parsed.help = true;
    } else if (a === "--json") {
      parsed.json = true;
    } else if (a === "--tick") {
      parsed.tick = true;
    } else if (a === "--window-secs") {
      parsed.windowSecs = parseWindow(argv[++i]);
    } else if (a.startsWith("--window-secs=")) {
      parsed.windowSecs = parseWindow(a.slice("--window-secs=".length));
    } else {
      process.stderr.write(
        `babysitter performance: unexpected argument '${a}'\n`,
      );
      process.exit(2);
    }
  }
  return parsed;
}

function parseWindow(raw: string | undefined): number {
  if (raw === undefined) {
    process.stderr.write(
      "babysitter performance: --window-secs requires a value\n",
    );
    process.exit(2);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    process.stderr.write(
      `babysitter performance: --window-secs must be a positive integer (got '${raw}')\n`,
    );
    process.exit(2);
  }
  return n;
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.tick) {
    // The launchd entry: scan → diff vs seen-state → write a follow-up per new
    // finding. Always exits 0; silent unless something genuinely new fires (the
    // follow-up corpus is the durable record, read by /babysit-triage). Errors
    // degrade to a baseline, never a non-zero that would let launchd retry-storm.
    await tick(
      resolveDbPath(),
      args.windowSecs,
      liveTickDeps(),
      resolveSeenStatePath(),
      resolveHeartbeatPath(),
    );
    return;
  }
  const findings = sortFindings(
    await scan(resolveDbPath(), args.windowSecs, liveDeps()),
  );
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ success: true, findings })}\n`);
  } else {
    printTable(findings);
  }
}

if (import.meta.main) {
  void main(Bun.argv.slice(2));
}

/**
 * restore-set — the DB-derived crash-restore candidate set (epic fn-817, T3).
 *
 * The keystone of the RETROSPECTIVE restore model: instead of replaying a frozen
 * `restore.json` snapshot, derive "the windows that were live right before the
 * crash" at READ TIME from `keeper.db` alone. The derivation is boundary-free —
 * there is no global "this is where the crash happened" marker; each `killed`
 * row carries its OWN producer-stamped `close_kind` (WHY it died), and the
 * membership test is a per-row predicate over that column. This works with the
 * daemon DOWN (a read-only DB connection, no socket round-trip), which is
 * exactly the disaster-recovery moment restore exists for.
 *
 * MEMBERSHIP. A candidate is a `state='killed'` job whose death was crash-like:
 *   - `close_kind ∈ {server_gone, pid_died}` — tmux server gone (reboot/crash)
 *     or the hosted `claude` died while its pane stayed listed (held by the
 *     launch wrapper's trailing login shell). Definitely restore.
 *   - `close_kind ∈ {unknown, NULL}` — the producer's liveness probe failed, or
 *     the row predates the v70 `close_kind` column. Resolved via the BURST
 *     HEURISTIC: the boot seed-sweep emits its Killed events back-to-back, so a
 *     contiguous cluster of Killed `event_id`s (≥ {@link BURST_MIN_SIZE}) is a
 *     crash signature; an isolated Killed is a routine close. The cluster key is
 *     `event_id` (rowid) ORDER, never `ts` — boot-sweep Killed events are all
 *     `Date.now()`-stamped at boot, so a timestamp clustering would smear the
 *     whole sweep into one instant and a real reorder would scatter. [fn-817
 *     best-practice: cut as-of queries by sequence, never by `ts`.]
 *   - `close_kind = window_gone_server_alive` — the human deliberately closed
 *     the window. EXCLUDED, always (even inside a burst): a user-close is not a
 *     crash, and "don't re-offer windows the human closed on purpose" is the
 *     whole point of the close_kind discriminator.
 *
 * FILTERS (applied after membership):
 *   - require `backend_exec_session_id` — no backend coords ⇒ nothing to replay.
 *   - exclude `plan_verb='work'` — autopilot workers are reconciler-managed; the
 *     reconciler re-dispatches them, restore must not double-spawn them.
 *   - exclude `job_id`s already occupying a LIVE backend (the UUID-liveness dedup
 *     / idempotence guard — prevents a double-spawn race with autopilot). The
 *     live set is computed from the SAME DB read (`state ∈ {working, stopped}`),
 *     so no socket is needed. [fn-817 best-practice: probe by UUID, never name.]
 *   - exclude rows idle beyond {@link DEFAULT_IDLE_CUTOFF_SECS} (last activity
 *     older than the cutoff), but COUNT and SURFACE the excluded number — a
 *     just-over-cutoff session is a false-negative we make visible, never a
 *     silent drop.
 *
 * ORDER. Candidates sort by captured `window_index` (the live tmux
 * `#{window_index}`, a window's left-to-right VISUAL position) ascending; a
 * NULL/unknown index sinks to the tail, tie-broken by `created_at` then
 * `job_id`. The candidate set is returned already ordered, so
 * `scripts/restore-agents.ts` is a thin presenter that never re-sorts.
 *
 * RESULT. Each candidate carries a `harness` tag and a harness-native
 * `resume_target`: the session UUID (`job_id`) for a claude candidate (exact
 * `claude --resume <uuid>` re-attach), the stored native id for codex/pi/hermes,
 * or EMPTY when a non-claude harness has no resolved target (not-resumable — see
 * {@link isRestorableCandidate}). `label` carries the latest `title` — the session
 * name keeper currently knows, read live from the jobs projection so it is never a
 * frozen name — falling back to the `job_id` for a never-named session. The title
 * is display only; the resume key is the immutable harness-native target.
 *
 * PURE-ISH. The derivation reads ONLY the passed read-only `Database` handle and
 * the (injectable) `now` clock for the idle cutoff. No socket, no env, no
 * wall-clock outside the injected `now`. Empty inputs (first boot, zero killed
 * rows) return cleanly — never throw.
 */

import type { Database } from "bun:sqlite";
import { harnessOrClaude } from "./agent/harness";
import type { CloseKind } from "./exec-backend";
import { extractTmuxTopologySnapshot } from "./reducer";
import { resumeTarget } from "./resume-descriptor";

/**
 * Idle cutoff (seconds): a killed row whose last activity is older than this is
 * excluded from the candidate set (but counted + surfaced, never silently
 * dropped). 7 days — long enough that a session you actually want back survives
 * a weekend, short enough that a months-stale row doesn't clutter the offer. The
 * idle clock keys on `updated_at` (the last lifecycle write), the closest
 * "when did this session last do anything" signal on the row.
 */
export const DEFAULT_IDLE_CUTOFF_SECS = 7 * 24 * 60 * 60;

/**
 * Burst-heuristic threshold: a contiguous run of Killed `event_id`s of this
 * size or larger reads as a crash signature (the boot seed-sweep emits its
 * synthetic Killed events back-to-back, so a reboot/crash leaves a dense
 * cluster). Below this, an `unknown`/legacy-NULL Killed is treated as an
 * isolated routine close and is NOT a candidate. Two is the minimum that can
 * distinguish "swept together" from "died alone"; the recorded 2026-06-16
 * incident left a 13-wide contiguous cluster, comfortably above it.
 */
export const BURST_MIN_SIZE = 2;

/** Crash-like close kinds: a definite-restore membership signal on their own. */
const CRASH_LIKE: ReadonlySet<CloseKind> = new Set<CloseKind>([
  "server_gone",
  "pid_died",
]);

/** The one close kind that is NEVER a candidate — a deliberate user window-close. */
const USER_CLOSED: CloseKind = "window_gone_server_alive";

/**
 * Raw `jobs`-row shape the derivation reads. A read-only projection of the
 * columns the membership/filter/order logic needs — NOT the full {@link Job}.
 * `close_kind` and `window_index` are the fn-817 producer-stamped columns
 * (schema v70 / v71); both may be NULL on a legacy row.
 */
interface KilledJobRow {
  job_id: string;
  created_at: number;
  updated_at: number;
  title: string | null;
  state: string;
  close_kind: string | null;
  window_index: number | null;
  cwd: string | null;
  /** The live tmux session, falling back to the forensic birth session — the
   * SELECT resolves `COALESCE(backend_exec_session_id,
   * backend_exec_birth_session_id)` so a job whose live location has not yet been
   * resolved by a `TmuxTopologySnapshot` still restores under its launch session. */
  backend_exec_session_id: string | null;
  plan_verb: string | null;
  /** The Killed event's rowid — the burst-cluster sort key. */
  last_event_id: number | null;
  /** Launching harness (`jobs.harness`); NULL reads as claude. */
  harness: string | null;
  /** Harness-native resume target (`jobs.resume_target`); NULL/empty ⇒ the
   *  candidate is not-resumable for a non-claude harness. */
  resume_target: string | null;
}

/**
 * One crash-restore candidate. `resume_target` is the job's session UUID
 * (`job_id`) — the exact key `claude --resume` targets; `label` carries the
 * human-readable name (the latest `title`, falling back to the `job_id` for a
 * never-named session) for the render only.
 * `window_index` rides through for the ordered render's debugging/diagnostics.
 * `cwd` is the directory the restore command `cd`s into before `claude --resume`
 * (`null` when the SessionStart event never carried one) — load-bearing, since a
 * session UUID resolves only within the session's project dir plus its git
 * worktrees.
 */
export interface RestoreCandidate {
  job_id: string;
  resume_target: string;
  label: string;
  window_index: number | null;
  cwd: string | null;
  backend_exec_session_id: string;
  created_at: number;
  /**
   * The launching harness (`"claude"`/`"codex"`/`"pi"`/`"hermes"`). ABSENT ⇒
   * claude (a NULL `jobs.harness` reads as claude at every consumer), so a legacy
   * candidate carries none and every claude-only consumer stays byte-stable. The
   * resume surfaces route `resume_target` through this harness's native resume
   * argv; `resume_target` is EMPTY when the harness minted its own id keeper never
   * back-filled — see {@link isRestorableCandidate}.
   */
  harness?: string;
}

/**
 * True when a candidate carries a usable resume target — the gate the restore
 * surfaces read to skip a non-claude agent whose harness-native `resume_target`
 * was never resolved (an empty string), reporting it not-resumable rather than
 * emitting a broken `--resume ""` argv. Claude candidates always resolve to their
 * session UUID, so this is always true for them (a degenerate empty `job_id` is
 * filtered upstream). Pure.
 */
export function isRestorableCandidate(c: RestoreCandidate): boolean {
  return c.resume_target !== "";
}

/** Why a non-candidate killed row was dropped — surfaced in the result counts. */
export interface RestoreSetResult {
  candidates: RestoreCandidate[];
  /** Count of crash-like rows excluded ONLY because they were idle past the
   *  cutoff (a false-negative risk we make visible — never a silent drop). */
  excludedIdleCount: number;
  /**
   * A human-readable note set ONLY when {@link deriveLastGenerationSetFromTopology}
   * degraded to the retrospective {@link deriveLastGenerationSet} fallback (no
   * restorable dying-generation `TmuxTopologySnapshot` survived). `undefined` on
   * the topology-anchored happy path and on the non-last-generation derivers.
   * Mirrors the `[paused]` banner convention so a degraded restore is VISIBLE —
   * the consumer surfaces it, never silently downgrades the restore set.
   */
  fallbackNote?: string;
  /**
   * Set by {@link deriveLastGenerationSetFromTopology} when the auto-picked
   * generation (max restorable) is NOT the newest non-degenerate candidate — the
   * bounded selection could not confidently pick one generation over another, so
   * the consumer must escalate (a TTY picker) or refuse (a non-TTY offer). Absent
   * on an unambiguous pick and on every non-topology deriver. Advisory: the
   * candidates ARE the auto-pick's set; the flag only tells the consumer the pick
   * was contested.
   */
  ambiguous?: boolean;
}

/** Injectable knobs (tests pin `now`/cutoff; production takes the defaults). */
export interface DeriveRestoreSetOptions {
  /** Unix-seconds "now" for the idle cutoff. Defaults to `Date.now()/1000`. */
  now?: number;
  /** Idle cutoff in seconds. Defaults to {@link DEFAULT_IDLE_CUTOFF_SECS}. */
  idleCutoffSecs?: number;
}

const seg = (v: unknown): string => (v == null ? "" : String(v));

/**
 * How many of the newest dead tmux-server generations enter DEFAULT restore
 * candidacy. The bounded generation-summary walk ranks generations by recency
 * (event rowid, never pid compared numerically) and considers only the newest
 * `K` that are also inside {@link DEFAULT_IDLE_CUTOFF_SECS}; anything older is a
 * manual escalation, not an auto-restore. Five is comfortably above the handful
 * of server restarts a human keeps context across, and keeps the per-candidate
 * snapshot decode (max pane count + the newest attributed snapshot) bounded.
 */
export const RECENT_GENERATION_BOUND = 5;

/**
 * A generation is DEGENERATE — a short-lived single-pane skeleton, the 1-pane
 * restore hazard this selection exists to reject — when its peak observed pane
 * count is `<=` this AND (never OR) its snapshot ts-span is under
 * {@link DEGENERATE_MAX_SPAN_SECS}. The AND is load-bearing: a long-lived
 * single-agent session is legitimate and must stay restorable, so a lone pane
 * only reads as a skeleton when it was ALSO observed only briefly. Degenerate
 * generations are excluded from default candidacy but remain listable.
 */
export const DEGENERATE_MAX_PANES = 1;
export const DEGENERATE_MAX_SPAN_SECS = 30 * 60;

/**
 * The index-only generation-summary walk behind {@link summarizeTopologyGenerations}
 * and the bounded selection. GROUPs the `TmuxTopologySnapshot` slice by the
 * v107 `events.tmux_generation_id` generated column, ordered newest-first by
 * MAX(events.id) (the recency key — rowid ORDER, never `ts`, never a numeric pid
 * compare). Served by the partial covering index `idx_events_tmux_generation`
 * `(tmux_generation_id, id, ts) WHERE hook_event = 'TmuxTopologySnapshot'` so the
 * walk never SCANs the `events` heap — EXPLAIN QUERY PLAN names that index (the
 * acceptance instrument). `tmux_generation_id IS NOT NULL` drops a malformed
 * snapshot whose `data` failed the generated column's `json_valid` guard.
 * Exported so a test can EXPLAIN the exact executed statement.
 */
export const GENERATION_SUMMARY_SQL = `SELECT tmux_generation_id AS generation_id,
        MIN(id) AS first_event_id,
        MAX(id) AS last_event_id,
        COUNT(*) AS snapshot_count,
        MIN(ts) AS first_ts,
        MAX(ts) AS last_ts
   FROM events
  WHERE hook_event = 'TmuxTopologySnapshot'
    AND tmux_generation_id IS NOT NULL
  GROUP BY tmux_generation_id
  ORDER BY MAX(id) DESC`;

/**
 * One dead-or-live tmux-server generation summarized for `keeper tabs list` and
 * the bounded restore selection. The `(generation_id, first_event_id)` pair keys
 * a generation so a reused OS pid never aliases two servers; recency is
 * `last_event_id` (rowid ORDER). `max_pane_count` is the peak panes observed
 * across the generation's snapshots; `degenerate` marks the short-lived
 * single-pane skeleton; `restorable` is the post-filter candidate count on the
 * newest snapshot that would actually be restored (0 when no snapshot in the
 * generation yields a candidate).
 */
export interface GenerationSummary {
  generation_id: string;
  /** MIN(events.id) over the generation's snapshots — the first-seen rowid; part
   *  of the summary key so a recycled OS pid never merges two servers downstream. */
  first_event_id: number;
  /** MAX(events.id) — the recency key. */
  last_event_id: number;
  /** Number of `TmuxTopologySnapshot` events emitted in the generation. */
  snapshot_count: number;
  /** MIN/MAX snapshot `events.ts` (unix seconds) — the ts-span bounds. */
  first_ts: number;
  last_ts: number;
  /** Peak pane count observed across the generation's snapshots. */
  max_pane_count: number;
  /** True when this generation is `G_now` (the current live server). */
  is_current: boolean;
  /** Short-lived single-pane skeleton — excluded from default candidacy. */
  degenerate: boolean;
  /** Post-filter restorable candidate count on the newest snapshot that would be
   *  restored (idempotence filters applied; 0 when no snapshot yields one). */
  restorable: number;
}

/**
 * Total-order comparator placing candidates in original visual (left-to-right)
 * tmux window order: a known `window_index` sorts ascending and precedes an
 * unknown (`null`) one; equal or both-unknown tiebreak by `created_at` then
 * `job_id`. The candidate set is the SOLE ordering authority — restore-agents
 * presents the set as-is. Total + deterministic for legacy/partial rows: a
 * non-finite `created_at` coerces to `0` (never NaN, which poisons a sort).
 */
export function compareCandidates(
  a: RestoreCandidate,
  b: RestoreCandidate,
): number {
  const ai = a.window_index;
  const bi = b.window_index;
  const aKnown = typeof ai === "number" && Number.isFinite(ai);
  const bKnown = typeof bi === "number" && Number.isFinite(bi);
  if (aKnown && bKnown) {
    if (ai !== bi) {
      return ai - bi;
    }
  } else if (aKnown !== bKnown) {
    return aKnown ? -1 : 1;
  }
  const at = Number.isFinite(a.created_at) ? a.created_at : 0;
  const bt = Number.isFinite(b.created_at) ? b.created_at : 0;
  if (at !== bt) {
    return at - bt;
  }
  return seg(a.job_id).localeCompare(seg(b.job_id));
}

/**
 * Pure: from the FULL set of killed rows' Killed-event rowids, compute the set
 * of rowids that sit inside a contiguous burst cluster of size ≥
 * {@link BURST_MIN_SIZE}. "Contiguous" = consecutive integer rowids with no gap
 * (the boot seed-sweep inserts its Killed events back-to-back, so a crash sweep
 * is a dense run; a routine close lands a lone rowid surrounded by unrelated
 * events). A NULL/non-finite rowid is never in a burst (it has no position).
 *
 * Keyed on `event_id` (rowid) ORDER, NEVER `ts` — boot-sweep Killed events are
 * all `Date.now()`-stamped at one boot instant, so timestamp clustering would
 * smear the whole sweep into a single point and a true reorder would scatter.
 * Exported for tests.
 */
export function burstEventIds(killedEventIds: (number | null)[]): Set<number> {
  const ids = killedEventIds
    .filter((x): x is number => typeof x === "number" && Number.isFinite(x))
    .sort((a, b) => a - b);
  const burst = new Set<number>();
  // Single forward pass tracking the current run of strictly-consecutive rowids
  // (each within `<= 1` of its predecessor — a defensive step that absorbs an
  // accidental duplicate; real event_ids are a unique PK). When a run breaks (or
  // the list ends), a run of length >= BURST_MIN_SIZE is flushed into the burst
  // set. The cluster key is rowid ORDER, never `ts` — boot-sweep Killed events
  // all share one `Date.now()` instant.
  let run: number[] = [];
  let prev: number | null = null;
  const flush = (): void => {
    if (run.length >= BURST_MIN_SIZE) {
      for (const id of run) {
        burst.add(id);
      }
    }
    run = [];
  };
  for (const id of ids) {
    if (prev !== null && id - prev > 1) {
      flush();
    }
    run.push(id);
    prev = id;
  }
  flush();
  return burst;
}

/**
 * Pure: decide whether a killed row's death is crash-like (a restore candidate
 * by membership, before filters). `server_gone`/`pid_died` qualify outright;
 * `window_gone_server_alive` never does; `unknown`/NULL qualify ONLY when the
 * row's Killed event sits inside a burst cluster (passed in via `inBurst`).
 * Exported for tests.
 */
export function isCrashLike(
  closeKind: string | null,
  inBurst: boolean,
): boolean {
  if (closeKind === USER_CLOSED) {
    return false;
  }
  if (closeKind != null && CRASH_LIKE.has(closeKind as CloseKind)) {
    return true;
  }
  // `unknown`, NULL, or any unrecognized string: crash-eligible ONLY via burst.
  return inBurst;
}

/**
 * One crash-restore candidate paired with the `event_id` (rowid) of the Killed
 * event that produced it — the generation-window sort key
 * {@link deriveLastGenerationSet} bounds on. The bare {@link RestoreCandidate}
 * doesn't carry the rowid (the visual-order presenter never needs it), so the
 * shared membership/filter pass threads it alongside for the as-of-query bound.
 */
interface CandidateWithEventId {
  candidate: RestoreCandidate;
  /** The Killed event's rowid (`events.id`); NULL on a legacy/partial row. */
  last_event_id: number | null;
}

/**
 * Read the killed-job cohort and the live-job id set off a read-only DB
 * connection in ONE pass each. `state='killed'` for the cohort; `state ∈
 * {working, stopped}` for the live dedup set (the same "live" scope the `jobs`
 * collection default uses). Pure read — no writes, no socket.
 */
function loadRows(db: Database): {
  killed: KilledJobRow[];
  liveJobIds: Set<string>;
} {
  const killed = db
    .query(
      `SELECT job_id, created_at, updated_at, title, state, close_kind,
              window_index, cwd,
              COALESCE(backend_exec_session_id, backend_exec_birth_session_id)
                AS backend_exec_session_id,
              plan_verb, last_event_id, harness, resume_target
         FROM jobs
        WHERE state = 'killed'`,
    )
    .all() as KilledJobRow[];
  const liveRows = db
    .query(`SELECT job_id FROM jobs WHERE state IN ('working', 'stopped')`)
    .all() as { job_id: string }[];
  const liveJobIds = new Set<string>();
  for (const r of liveRows) {
    const id = seg(r.job_id);
    if (id !== "") {
      liveJobIds.add(id);
    }
  }
  return { killed, liveJobIds };
}

/**
 * Derive the crash-restore candidate set from a read-only `keeper.db`
 * connection. The module's whole job — membership (crash-like close_kind +
 * burst backstop), filters (backend coords, autopilot workers, live-UUID dedup,
 * idle cutoff), and visual-order sort — folded into one read.
 *
 * Empty / zero-killed inputs return `{ candidates: [], excludedIdleCount: 0 }`
 * cleanly. Never throws on data; a malformed `window_index` coerces to "unknown
 * order" (tail) rather than poisoning the sort.
 */
export function deriveRestoreSet(
  db: Database,
  options: DeriveRestoreSetOptions = {},
): RestoreSetResult {
  const { collected, excludedIdleCount } = collectCrashCandidates(db, options);
  const candidates = collected.map((c) => c.candidate);
  candidates.sort(compareCandidates);
  return { candidates, excludedIdleCount };
}

/**
 * The shared membership/filter pass behind both {@link deriveRestoreSet} and
 * {@link deriveLastGenerationSet}: read the killed cohort, apply crash-like
 * membership (close_kind + burst backstop) and every filter (backend coords,
 * autopilot workers, live-UUID dedup, idle cutoff), and return each surviving
 * candidate PAIRED with its Killed-event rowid (the generation-window sort key).
 * UNORDERED — the callers sort (`deriveRestoreSet` after dropping the rowid;
 * `deriveLastGenerationSet` after the window bound). Never throws on data.
 */
function collectCrashCandidates(
  db: Database,
  options: DeriveRestoreSetOptions,
): { collected: CandidateWithEventId[]; excludedIdleCount: number } {
  const now = options.now ?? Date.now() / 1000;
  const idleCutoffSecs = options.idleCutoffSecs ?? DEFAULT_IDLE_CUTOFF_SECS;
  const idleBefore = now - idleCutoffSecs;

  const { killed, liveJobIds } = loadRows(db);

  // Burst set is computed over the FULL killed cohort's Killed-event rowids, so
  // an `unknown`/NULL row's membership sees the same cluster the boot sweep made
  // — independent of which rows later pass the filters.
  const burst = burstEventIds(killed.map((r) => r.last_event_id));

  const collected: CandidateWithEventId[] = [];
  let excludedIdleCount = 0;

  for (const row of killed) {
    const jobId = seg(row.job_id);
    if (jobId === "") {
      continue;
    }
    const inBurst =
      typeof row.last_event_id === "number" && burst.has(row.last_event_id);
    if (!isCrashLike(row.close_kind, inBurst)) {
      continue; // user-closed, or isolated unknown/legacy — not a candidate.
    }
    // Filter: no backend coords ⇒ nothing to replay.
    const backendSession = row.backend_exec_session_id;
    if (backendSession == null || backendSession === "") {
      continue;
    }
    // Filter: autopilot workers are reconciler-managed; never restore them.
    if (row.plan_verb === "work") {
      continue;
    }
    // Filter: already live under this UUID ⇒ the session still occupies a
    // backend; restoring it would double-spawn. (The idempotence guard.)
    if (liveJobIds.has(jobId)) {
      continue;
    }
    // Filter: idle past the cutoff — EXCLUDE but COUNT (surface, never silent).
    const updatedAt = Number.isFinite(row.updated_at) ? row.updated_at : 0;
    if (updatedAt < idleBefore) {
      excludedIdleCount++;
      continue;
    }

    const label = row.title != null && row.title !== "" ? row.title : jobId;
    const harness = harnessOrClaude(row.harness);
    collected.push({
      candidate: {
        job_id: jobId,
        // Per-harness: claude resolves to its session UUID (`job_id`); a
        // non-claude harness resolves to the stored `resume_target` (EMPTY when
        // never back-filled ⇒ not-resumable, surfaced downstream).
        resume_target: resumeTarget({
          job_id: jobId,
          harness: row.harness,
          resume_target: row.resume_target,
        }),
        label,
        harness,
        window_index:
          typeof row.window_index === "number" &&
          Number.isFinite(row.window_index)
            ? row.window_index
            : null,
        cwd: row.cwd != null && row.cwd !== "" ? row.cwd : null,
        backend_exec_session_id: backendSession,
        created_at: Number.isFinite(row.created_at) ? row.created_at : 0,
      },
      last_event_id:
        typeof row.last_event_id === "number" &&
        Number.isFinite(row.last_event_id)
          ? row.last_event_id
          : null,
    });
  }

  return { collected, excludedIdleCount };
}

/**
 * RETROSPECTIVE last-generation crash-restore set — the LABELED FALLBACK behind
 * {@link deriveLastGenerationSetFromTopology}. The primary path derives the
 * restore set from POSITIVE pre-crash evidence (the dying generation's last
 * `TmuxTopologySnapshot`, immune to the server-restart race). This retrospective
 * model — reconstruct "what was live at the crash" from `state='killed'` rows +
 * a kill-anchored `BackendExecStart` window — is used ONLY when the dying
 * generation left no surviving snapshot; the consumer surfaces a labeled note
 * (`fallbackNote`) when it fires so a degraded restore is VISIBLE.
 *
 * Bounds the crash candidates to the kill-anchored tmux-server generation window
 * — "the session you just lost", not the 7-day pool {@link deriveRestoreSet}
 * returns. (epic fn-819, T2)
 *
 * Membership/filters are IDENTICAL to {@link deriveRestoreSet} (shared via
 * {@link collectCrashCandidates}); the only addition is the generation bound:
 *
 *   - `K_max` = the MAX Killed-event rowid over the surviving candidates — the
 *     most-recent crash kill we're about to offer.
 *   - `B_boundary` = `MAX(events.id) WHERE hook_event='BackendExecStart' AND
 *     id <= K_max` — the generation-start boundary the most-recent kills BELONG
 *     to. Anchoring on the kills (not "the current generation") is the
 *     load-bearing correctness piece: boot ordering mints the dead-generation
 *     Killed events BEFORE the restore-worker posts the new BackendExecStart, so
 *     a naive "after the most-recent start" bound would exclude the very agents
 *     we want. Anchoring at `<= K_max` puts the boundary at the generation the
 *     settled kills sit in, so they stay inside the window.
 *   - keep candidates with `last_event_id >= B_boundary` — this generation only;
 *     a prior-generation straggler (rowid below the boundary) is excluded.
 *
 * FALLBACK. When `B_boundary` is NULL — no `BackendExecStart` recorded before
 * the kills (a fresh / pre-feature DB) — degrade to the BURST heuristic: keep
 * only the candidates in the most-recent contiguous Killed cluster
 * ({@link burstEventIds} over the candidates' rowids, take the cluster with the
 * largest max rowid). This bounds to the last crash sweep, NOT the full 7-day
 * pool (which would reintroduce the over-offer this epic fixes). A candidate
 * with a NULL rowid has no position in either bound and is dropped.
 *
 * Empty candidate set ⇒ empty result. Reads only `events` + `jobs` off the
 * passed read-only connection (daemon-down OK); reuses {@link RestoreCandidate}
 * and {@link compareCandidates} verbatim (resume_target = session UUID).
 */
export function deriveLastGenerationSet(
  db: Database,
  options: DeriveRestoreSetOptions = {},
): RestoreSetResult {
  const { collected, excludedIdleCount } = collectCrashCandidates(db, options);
  if (collected.length === 0) {
    return { candidates: [], excludedIdleCount };
  }

  // K_max: the most-recent Killed-event rowid among the candidates. A candidate
  // with no rowid contributes nothing to the bound (and can never pass it).
  const eventIds = collected
    .map((c) => c.last_event_id)
    .filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  if (eventIds.length === 0) {
    // No positioned candidate at all — no window to bound. Empty, cleanly.
    return { candidates: [], excludedIdleCount };
  }
  const kMax = Math.max(...eventIds);

  // B_boundary: the generation start the most-recent kills belong to. Cut by
  // `events.id` (rowid) ORDER, NEVER `ts` — boot-sweep Killed events share one
  // Date.now() instant, so a timestamp cut would smear the whole sweep. (The PK
  // column is `id`, never `event_id`.)
  const boundaryRow = db
    .query(
      `SELECT MAX(id) AS boundary
         FROM events
        WHERE hook_event = 'BackendExecStart'
          AND id <= ?`,
    )
    .get(kMax) as { boundary: number | null } | null;
  const bBoundary =
    boundaryRow != null &&
    typeof boundaryRow.boundary === "number" &&
    Number.isFinite(boundaryRow.boundary)
      ? boundaryRow.boundary
      : null;

  let kept: CandidateWithEventId[];
  if (bBoundary !== null) {
    // Generation window: keep this generation's kills only.
    kept = collected.filter(
      (c) => c.last_event_id !== null && c.last_event_id >= bBoundary,
    );
  } else {
    // NULL-boundary fallback: no BackendExecStart before the kills. Restrict to
    // the most-recent contiguous Killed burst, NOT the full pool.
    const burst = burstEventIds(collected.map((c) => c.last_event_id));
    if (burst.size > 0) {
      const burstMax = Math.max(...burst);
      // The most-recent contiguous run ends at burstMax; walk back over the
      // gap-free rowids to find that run's floor, then keep candidates inside it.
      let floor = burstMax;
      while (burst.has(floor - 1)) {
        floor--;
      }
      kept = collected.filter(
        (c) =>
          c.last_event_id !== null &&
          c.last_event_id >= floor &&
          c.last_event_id <= burstMax,
      );
    } else {
      // No burst either (every candidate isolated, e.g. a lone server_gone with
      // no BackendExecStart). The most-recent kill is the only last-generation
      // signal we have — keep candidates at K_max.
      kept = collected.filter((c) => c.last_event_id === kMax);
    }
  }

  const candidates = kept.map((c) => c.candidate);
  candidates.sort(compareCandidates);
  return { candidates, excludedIdleCount };
}

/**
 * Injectable knobs for {@link deriveLastGenerationSetFromTopology}: the standard
 * idle/now knobs PLUS `currentGenerationId` — `G_now`, the CURRENT tmux server
 * generation the consumer probed at restore time (NEVER inside a fold). The
 * deriver selects the DYING generation as the newest `TmuxTopologySnapshot` whose
 * `generation_id != G_now`. `null` means no server is up (the post-crash,
 * pre-respawn read), so the newest snapshot overall IS the dying generation.
 */
export interface DeriveFromTopologyOptions extends DeriveRestoreSetOptions {
  /** The current tmux server generation (`probeServerGeneration` result), or
   *  `null` when no server is running. The dying generation is the newest snapshot
   *  whose `generation_id` differs from this. */
  currentGenerationId: string | null;
}

/** The minimal `jobs` columns the topology deriver reads to turn a snapshot pane
 *  into a {@link RestoreCandidate} (job identity already resolved). */
interface TopologyJobRow {
  job_id: string;
  created_at: number;
  title: string | null;
  cwd: string | null;
  backend_exec_session_id: string | null;
  plan_verb: string | null;
  harness: string | null;
  resume_target: string | null;
}

interface PostTerminalBackendRow {
  job_id: string;
  created_at: number;
  title: string | null;
  window_index: number | null;
  cwd: string | null;
  backend_exec_session_id: string | null;
  harness: string | null;
  resume_target: string | null;
  pid: number;
  event_backend_exec_session_id: string | null;
  event_backend_exec_pane_id: string;
}

/**
 * PRIMARY last-generation crash-restore deriver — derives the restore set from
 * POSITIVE pre-crash evidence: a DYING generation's `TmuxTopologySnapshot`
 * events, written BEFORE the crash and so immune to the server-restart race that
 * defeats the retrospective `close_kind`/killed-cohort model (epic fn-955). The
 * selection is RECENCY-BOUNDED and RICHNESS-RANKED over per-generation topology
 * summaries — NOT "single newest non-current generation" (the defect that
 * restored a 1-pane skeleton over a 9-pane session).
 *
 * SELECTION. Probe `G_now` (the current server generation) in the CONSUMER and
 * pass it as `currentGenerationId`. {@link summarizeTopologyGenerations} ranks every
 * generation by recency (event rowid). Candidates are the newest
 * {@link RECENT_GENERATION_BOUND} DEAD (`generation_id != G_now`) generations
 * whose newest snapshot ts is inside the idle cutoff. A DEGENERATE generation (a
 * short-lived single-pane skeleton — see {@link DEGENERATE_MAX_PANES}) is
 * excluded from candidacy but stays listable. The AUTO-PICK is the candidate
 * with the most restorable agents, recency as tiebreak; when that pick is NOT
 * also the newest non-degenerate candidate the result is flagged
 * {@link RestoreSetResult.ambiguous} so the consumer escalates (a TTY picker) or
 * refuses (a non-TTY offer). `G_now == null` (no server up) ⇒ every generation
 * is dead and the richest recent one wins.
 *
 * CANDIDATES. Within the picked generation the restore set is built from its
 * newest ATTRIBUTED snapshot — the newest snapshot that yields at least one
 * candidate — stepping back past the unattributed (zero-job_id) half of the
 * emission pair. Each pane resolves a keeper `job_id` from the EVENT PAYLOAD
 * (`pane.job_id`), with the `(generation_id, pane_id)` projection join as the
 * per-pane fallback when the payload carries none. The job's row supplies the
 * display `label` (latest `title`, `job_id` fallback), its `cwd`, and
 * `created_at`; `resume_target` is the session UUID (`job_id`). The pane's
 * `session_name` is the restore location and
 * its `window_index` the visual order. The idempotence filters are reused
 * VERBATIM: require backend coords, exclude `plan_verb='work'`
 * (reconciler-managed), and exclude any `job_id` already occupying a LIVE
 * backend (the double-spawn guard). Candidates sort by {@link compareCandidates}.
 *
 * FALLBACK. No candidate generation at all, OR every candidate is degenerate, OR
 * zero restorable everywhere ⇒ delegate to {@link deriveLastGenerationSet} (the
 * retrospective killed-cohort model) and set `fallbackNote` so the consumer
 * surfaces a VISIBLE degraded-restore banner (never a silent downgrade).
 *
 * PURE relative to the read-only `db` + injected `currentGenerationId`/`now` — no
 * probe, no env, no wall-clock outside the injected `now`. Reads only `events` +
 * `jobs` (daemon-down OK). Never throws on data: a malformed snapshot decodes to
 * a skip, a missing job row drops the pane. Signature-stable: existing consumers
 * read `candidates`/`fallbackNote` unchanged and gain the richer selection.
 */
export function deriveLastGenerationSetFromTopology(
  db: Database,
  options: DeriveFromTopologyOptions,
): RestoreSetResult {
  const now = options.now ?? Date.now() / 1000;
  const idleCutoffSecs = options.idleCutoffSecs ?? DEFAULT_IDLE_CUTOFF_SECS;
  const idleBefore = now - idleCutoffSecs;

  const enriched = loadEnrichedGenerations(db, options.currentGenerationId);

  // Candidate generations: DEAD (not the current server), newest snapshot inside
  // the idle cutoff, bounded to the newest K (the summaries are already ranked
  // newest-first, so `slice` takes the K most recent).
  const candidateGens = enriched
    .filter((e) => !e.summary.is_current)
    .filter((e) => e.summary.last_ts >= idleBefore)
    .slice(0, RECENT_GENERATION_BOUND);

  // Eligible for auto-pick: non-degenerate AND at least one restorable agent.
  const eligible = candidateGens.filter(
    (e) => !e.summary.degenerate && e.summary.restorable > 0,
  );
  if (eligible.length === 0) {
    // No candidate generation at all, all-degenerate, or zero restorable
    // everywhere — degrade to the retrospective model and LABEL it (visible).
    const fallback = deriveLastGenerationSet(db, options);
    return {
      ...fallback,
      fallbackNote:
        "no restorable dying-generation topology — using the retrospective killed-cohort fallback (restore set may be approximate)",
    };
  }

  // Auto-pick: MAX restorable, recency (highest last_event_id) as the tiebreak.
  const pick = eligible.reduce((best, e) =>
    e.summary.restorable > best.summary.restorable ||
    (e.summary.restorable === best.summary.restorable &&
      e.summary.last_event_id > best.summary.last_event_id)
      ? e
      : best,
  );
  // The newest eligible generation by recency. When the auto-pick is a DIFFERENT
  // generation than this, the richest set was not the freshest — an ambiguous
  // choice the consumer must resolve (picker) or refuse (non-TTY).
  const newestEligible = eligible.reduce((a, b) =>
    b.summary.last_event_id > a.summary.last_event_id ? b : a,
  );
  const ambiguous =
    pick.summary.generation_id !== newestEligible.summary.generation_id ||
    pick.summary.first_event_id !== newestEligible.summary.first_event_id;

  // The topology path has no idle-cutoff concept for the panes themselves (they
  // were all live at crash time); excludedIdleCount is 0 on this path.
  return {
    candidates: pick.candidates,
    excludedIdleCount: 0,
    ...(ambiguous ? { ambiguous: true } : {}),
  };
}

/**
 * The per-generation summaries `keeper tabs list` renders — every observed tmux
 * generation ranked newest-first (event rowid), each enriched with its peak pane
 * count, degenerate flag, current-server flag, and restorable count. Reads only
 * `events` + `jobs` off the read-only connection (daemon-down OK); never throws
 * on data. The SAME enrichment feeds {@link deriveLastGenerationSetFromTopology}'s
 * bounded auto-pick, so the list a human sees and the set restore would offer
 * are computed identically.
 */
export function summarizeTopologyGenerations(
  db: Database,
  options: DeriveFromTopologyOptions,
): GenerationSummary[] {
  return loadEnrichedGenerations(db, options.currentGenerationId).map(
    (e) => e.summary,
  );
}

/**
 * Public read: every observed tmux generation enriched with the restore
 * candidates its newest attributed snapshot yields (summary + candidates),
 * newest-first. The SAME enrichment {@link summarizeTopologyGenerations} and
 * {@link deriveLastGenerationSetFromTopology} read — exposed WHOLE so a consumer
 * can target ONE generation off the same read the list view uses (the
 * `keeper tabs restore` numbered picker and its `--generation <id>` flag both
 * resolve a specific generation's candidates from this list). Reads only
 * `events` + `jobs` off the read-only connection (daemon-down OK); never throws.
 */
export function enrichedTopologyGenerations(
  db: Database,
  options: DeriveFromTopologyOptions,
): EnrichedGeneration[] {
  return loadEnrichedGenerations(db, options.currentGenerationId);
}

/**
 * A generation summary paired with the restore candidates its newest attributed
 * snapshot yields — the shared enrichment behind the list view and the auto-pick.
 */
export interface EnrichedGeneration {
  summary: GenerationSummary;
  candidates: RestoreCandidate[];
}

/**
 * Run the index-only generation-summary walk, then enrich a BOUNDED window of
 * generations by decoding their snapshots: peak pane count, degeneracy,
 * current-server flag, and the restore candidates from the newest attributed
 * snapshot. Ordered newest-first (the walk's `ORDER BY MAX(id) DESC`).
 *
 * The summary walk is index-only and stays full over the retained history, but
 * decoding a generation's snapshots is the cost that grows unbounded on a
 * long-lived host — so only the CURRENT generation (always, for the list view)
 * plus the newest {@link RECENT_GENERATION_BOUND} DEAD generations are decoded;
 * older generations keep only their (never-returned) index-only summary. That
 * window is a superset of every generation the auto-pick's
 * idle-cutoff-then-slice-K selection can reach: rowid order tracks `ts` order in
 * the append-only event log, so any dead generation past the newest K is older
 * than all of them and thus already past the idle cutoff whenever a top-K
 * generation is — bounding the decode never drops a generation the full-scan
 * selection would have picked. `liveJobIds` is read ONCE and shared across every
 * decoded generation's candidate build.
 */
function loadEnrichedGenerations(
  db: Database,
  currentGenerationId: string | null,
): EnrichedGeneration[] {
  const raws = summarizeGenerationsIndexOnly(db);
  if (raws.length === 0) {
    return [];
  }
  // Bound the DECODE (not the index-only summary walk above). `raws` is
  // newest-first, so pushing in encounter order keeps the result newest-first.
  const toEnrich: RawGenerationSummary[] = [];
  let deadEnriched = 0;
  for (const raw of raws) {
    const isCurrent =
      currentGenerationId !== null && raw.generation_id === currentGenerationId;
    if (isCurrent) {
      toEnrich.push(raw);
      continue;
    }
    if (deadEnriched < RECENT_GENERATION_BOUND) {
      toEnrich.push(raw);
      deadEnriched++;
    }
    // Older dead generations past the bound are never decoded.
  }
  const { liveJobIds } = loadRows(db);
  return toEnrich.map((raw) =>
    enrichGeneration(db, raw, currentGenerationId, liveJobIds),
  );
}

/** Raw (pre-enrichment) generation summary straight off {@link GENERATION_SUMMARY_SQL}. */
interface RawGenerationSummary {
  generation_id: string;
  first_event_id: number;
  last_event_id: number;
  snapshot_count: number;
  first_ts: number;
  last_ts: number;
}

/**
 * The index-only GROUP BY walk ({@link GENERATION_SUMMARY_SQL}) decoded into
 * {@link RawGenerationSummary}s, ordered newest-first. Coerces each numeric field
 * defensively (a non-finite value sinks to 0) and drops a row with an empty
 * generation_id. Reads only the read-only `events` table; never throws.
 */
function summarizeGenerationsIndexOnly(db: Database): RawGenerationSummary[] {
  let rows: {
    generation_id: string | null;
    first_event_id: number | null;
    last_event_id: number | null;
    snapshot_count: number | null;
    first_ts: number | null;
    last_ts: number | null;
  }[];
  try {
    rows = db.query(GENERATION_SUMMARY_SQL).all() as typeof rows;
  } catch {
    return [];
  }
  const out: RawGenerationSummary[] = [];
  for (const r of rows) {
    const generationId = seg(r.generation_id);
    if (generationId === "") {
      continue;
    }
    const num = (v: number | null): number =>
      typeof v === "number" && Number.isFinite(v) ? v : 0;
    out.push({
      generation_id: generationId,
      first_event_id: num(r.first_event_id),
      last_event_id: num(r.last_event_id),
      snapshot_count: num(r.snapshot_count),
      first_ts: num(r.first_ts),
      last_ts: num(r.last_ts),
    });
  }
  return out;
}

/**
 * Enrich one generation: decode its snapshots newest-first to find the peak pane
 * count (degeneracy input) and the newest ATTRIBUTED snapshot — the newest that
 * yields at least one candidate, stepping back past the unattributed half of the
 * emission pair. `restorable` is that snapshot's post-filter candidate count (0
 * when none yields). Degenerate ⇔ peak panes `<=` {@link DEGENERATE_MAX_PANES}
 * AND ts-span `<` {@link DEGENERATE_MAX_SPAN_SECS} (AND, never OR — a long-lived
 * single-agent session stays legitimate).
 */
function enrichGeneration(
  db: Database,
  raw: RawGenerationSummary,
  currentGenerationId: string | null,
  liveJobIds: Set<string>,
): EnrichedGeneration {
  const snapshots = readGenerationSnapshotsDesc(db, raw.generation_id);
  let maxPaneCount = 0;
  let candidates: RestoreCandidate[] = [];
  for (const snap of snapshots) {
    if (snap.panes.length > maxPaneCount) {
      maxPaneCount = snap.panes.length;
    }
    // First (newest, DESC order) snapshot that yields candidates is the newest
    // attributed one; keep scanning the rest only to finish the pane-count max.
    if (candidates.length === 0) {
      const built = buildCandidatesFromSnapshot(
        db,
        raw.generation_id,
        snap.panes,
        liveJobIds,
      );
      if (built.length > 0) {
        candidates = built;
      }
    }
  }

  const spanSecs = raw.last_ts - raw.first_ts;
  const degenerate =
    maxPaneCount <= DEGENERATE_MAX_PANES && spanSecs < DEGENERATE_MAX_SPAN_SECS;

  return {
    summary: {
      generation_id: raw.generation_id,
      first_event_id: raw.first_event_id,
      last_event_id: raw.last_event_id,
      snapshot_count: raw.snapshot_count,
      first_ts: raw.first_ts,
      last_ts: raw.last_ts,
      max_pane_count: maxPaneCount,
      is_current:
        currentGenerationId !== null &&
        raw.generation_id === currentGenerationId,
      degenerate,
      // A candidate whose harness-native resume target never resolved is LISTED
      // (surfaced not-resumable) but does NOT count toward `restorable` — the
      // auto-pick/eligibility gate must rank a generation by what it can actually
      // bring back, so a generation of only not-resumable agents reads restorable
      // 0 and falls through, while a mixed one still ranks by its resumable set.
      restorable: candidates.filter(isRestorableCandidate).length,
    },
    candidates,
  };
}

/**
 * Read + decode one generation's `TmuxTopologySnapshot` events newest-first via
 * the v107 `idx_events_tmux_generation` index (`tmux_generation_id = ?` seek,
 * `ORDER BY id DESC`). A malformed snapshot decodes to `null` and is dropped.
 * Reads only the read-only `events` table; never throws.
 */
function readGenerationSnapshotsDesc(
  db: Database,
  generationId: string,
): { id: number; panes: TmuxTopologyPaneLike[] }[] {
  let rows: { id: number; data: string | null }[];
  try {
    rows = db
      .query(
        `SELECT id, data FROM events
          WHERE hook_event = 'TmuxTopologySnapshot'
            AND tmux_generation_id = ?
          ORDER BY id DESC`,
      )
      .all(generationId) as { id: number; data: string | null }[];
  } catch {
    return [];
  }
  const out: { id: number; panes: TmuxTopologyPaneLike[] }[] = [];
  for (const row of rows) {
    let snapshot: ReturnType<typeof extractTmuxTopologySnapshot>;
    try {
      snapshot = extractTmuxTopologySnapshot({
        id: row.id,
        data: row.data,
      } as Parameters<typeof extractTmuxTopologySnapshot>[0]);
    } catch {
      snapshot = null;
    }
    if (snapshot !== null) {
      out.push({ id: row.id, panes: snapshot.panes });
    }
  }
  return out;
}

/**
 * Build the restore candidates from one decoded snapshot's panes: resolve each
 * pane's `job_id` (payload, then the `(generation_id, pane_id)` projection join),
 * apply the idempotence filters VERBATIM (backend coords required,
 * `plan_verb='work'` excluded, live-UUID excluded), and sort by
 * {@link compareCandidates}. Returns `[]` when no pane yields a candidate — the
 * signal {@link enrichGeneration} uses to step back to the attributed sibling.
 */
function buildCandidatesFromSnapshot(
  db: Database,
  generationId: string,
  panes: TmuxTopologyPaneLike[],
  liveJobIds: Set<string>,
): RestoreCandidate[] {
  const candidates: RestoreCandidate[] = [];
  const seen = new Set<string>();
  for (const pane of panes) {
    const jobId =
      pane.job_id ?? resolvePaneJobId(db, generationId, pane.pane_id) ?? null;
    if (jobId === null || jobId === "" || seen.has(jobId)) {
      continue; // unowned pane (never launched / no job row), or a dup pane.
    }
    const row = loadTopologyJobRow(db, jobId);
    if (row === null) {
      continue; // job row gone — nothing to resume.
    }
    // Idempotence filters reused VERBATIM from collectCrashCandidates:
    //  - autopilot workers are reconciler-managed; never restore them.
    if (row.plan_verb === "work") {
      continue;
    }
    //  - already live under this UUID ⇒ restoring would double-spawn.
    if (liveJobIds.has(jobId)) {
      continue;
    }
    // Restore LOCATION is the pane's live session (the snapshot's whole point);
    // fall back to the job's recorded backend coords. No location ⇒ skip.
    const backendSession =
      pane.session_name !== ""
        ? pane.session_name
        : (row.backend_exec_session_id ?? "");
    if (backendSession === "") {
      continue;
    }
    seen.add(jobId);
    const label = row.title != null && row.title !== "" ? row.title : jobId;
    candidates.push({
      job_id: jobId,
      resume_target: resumeTarget({
        job_id: jobId,
        harness: row.harness,
        resume_target: row.resume_target,
      }),
      label,
      harness: harnessOrClaude(row.harness),
      window_index:
        typeof pane.window_index === "number" &&
        Number.isFinite(pane.window_index)
          ? pane.window_index
          : null,
      cwd: row.cwd != null && row.cwd !== "" ? row.cwd : null,
      backend_exec_session_id: backendSession,
      created_at: Number.isFinite(row.created_at) ? row.created_at : 0,
    });
  }
  candidates.sort(compareCandidates);
  return candidates;
}

/** A snapshot pane as decoded by {@link extractTmuxTopologySnapshot} — the shape
 *  the topology deriver joins to jobs. Mirrors the reducer's pane entry without
 *  importing its type (the optional `job_id` is the payload-carried identity). */
interface TmuxTopologyPaneLike {
  pane_id: string;
  session_name: string;
  window_index: number | null;
  job_id?: string;
}

interface LatestTopologyPaneLocation {
  session_name: string;
  window_index: number | null;
}

/**
 * Per-pane projection-join fallback: resolve the keeper `job_id` owning a pane
 * when the snapshot payload carried none. Match on `(backend_exec_generation_id,
 * backend_exec_pane_id)` — the same recycle-guarded key the topology fold writes
 * — so a recycled `%N` from a different generation never resolves to the wrong
 * job. Returns `null` on no match or a degenerate (empty/non-string) id. Reads
 * only the read-only `jobs` projection; never throws.
 */
function resolvePaneJobId(
  db: Database,
  generationId: string,
  paneId: string,
): string | null {
  try {
    const row = db
      .query(
        `SELECT job_id FROM jobs
          WHERE backend_exec_type = 'tmux'
            AND backend_exec_generation_id = ?
            AND backend_exec_pane_id = ?
          LIMIT 1`,
      )
      .get(generationId, paneId) as { job_id: string } | null;
    const jobId = row != null ? seg(row.job_id) : "";
    return jobId === "" ? null : jobId;
  } catch {
    return null;
  }
}

/**
 * Load the `jobs` columns the topology deriver needs to materialize one resolved
 * pane into a candidate (latest name, cwd, created_at, backend coords, plan_verb
 * for the worker filter). `backend_exec_session_id` COALESCEs the live session
 * over the forensic birth session, mirroring {@link loadRows}. Returns `null`
 * when the job row is absent; never throws.
 */
function loadTopologyJobRow(
  db: Database,
  jobId: string,
): TopologyJobRow | null {
  try {
    const row = db
      .query(
        `SELECT job_id, created_at, title, cwd,
                COALESCE(backend_exec_session_id, backend_exec_birth_session_id)
                  AS backend_exec_session_id,
                plan_verb, harness, resume_target
           FROM jobs
          WHERE job_id = ?
          LIMIT 1`,
      )
      .get(jobId) as TopologyJobRow | null;
    return row ?? null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? (err as { code?: unknown }).code
        : null;
    return code === "EPERM";
  }
}

/**
 * Latest tmux pane locations keyed by pane id. This is a read-time helper for
 * the CURRENT snapshot surface; no fold reads it, so probing the latest topology
 * event here does not affect re-fold determinism.
 */
function loadLatestTopologyPaneLocations(
  db: Database,
): Map<string, LatestTopologyPaneLocation> {
  try {
    const row = db
      .query(
        `SELECT id, data FROM events
          WHERE hook_event = 'TmuxTopologySnapshot'
          ORDER BY id DESC
          LIMIT 1`,
      )
      .get() as { id: number; data: string | null } | null;
    if (row === null) {
      return new Map();
    }
    const snapshot = extractTmuxTopologySnapshot({
      id: row.id,
      data: row.data,
    } as Parameters<typeof extractTmuxTopologySnapshot>[0]);
    if (snapshot === null) {
      return new Map();
    }
    const byPane = new Map<string, LatestTopologyPaneLocation>();
    for (const pane of snapshot.panes) {
      byPane.set(pane.pane_id, {
        session_name: pane.session_name,
        window_index: pane.window_index,
      });
    }
    return byPane;
  } catch {
    return new Map();
  }
}

/**
 * Terminal rows normally stay out of a current snapshot. The exception is a row
 * with later backend-exec evidence from the SAME still-live pid: that proves the
 * terminal event did not describe the process currently owning the session. Read
 * only; never writes a repair event or mutates the projection.
 */
function derivePostTerminalCurrentSet(
  db: Database,
  seenJobIds: Set<string>,
): RestoreCandidate[] {
  let rows: PostTerminalBackendRow[];
  try {
    rows = db
      .query(
        `SELECT j.job_id, j.created_at, j.title, j.window_index, j.cwd,
                COALESCE(j.backend_exec_session_id, j.backend_exec_birth_session_id)
                  AS backend_exec_session_id,
                j.harness, j.resume_target, j.pid,
                e.backend_exec_session_id AS event_backend_exec_session_id,
                e.backend_exec_pane_id AS event_backend_exec_pane_id
           FROM jobs j
           JOIN events e ON e.id = (
             SELECT e2.id FROM events e2
              WHERE e2.session_id = j.job_id
                AND e2.id > COALESCE(j.last_event_id, 0)
                AND e2.pid = j.pid
                AND e2.backend_exec_type = 'tmux'
                AND e2.backend_exec_pane_id IS NOT NULL
                AND e2.backend_exec_pane_id != ''
              ORDER BY e2.id DESC
              LIMIT 1
           )
          WHERE j.state IN ('ended', 'killed')
            AND j.pid IS NOT NULL`,
      )
      .all() as PostTerminalBackendRow[];
  } catch {
    return [];
  }

  const locations = loadLatestTopologyPaneLocations(db);
  const candidates: RestoreCandidate[] = [];
  for (const row of rows) {
    const jobId = seg(row.job_id);
    if (jobId === "" || seenJobIds.has(jobId) || !pidAlive(row.pid)) {
      continue;
    }
    const paneLocation = locations.get(seg(row.event_backend_exec_pane_id));
    const backendSession =
      paneLocation?.session_name !== undefined &&
      paneLocation.session_name !== ""
        ? paneLocation.session_name
        : seg(row.event_backend_exec_session_id) !== ""
          ? seg(row.event_backend_exec_session_id)
          : seg(row.backend_exec_session_id);
    if (backendSession === "") {
      continue;
    }
    const label = row.title != null && row.title !== "" ? row.title : jobId;
    candidates.push({
      job_id: jobId,
      resume_target: resumeTarget({
        job_id: jobId,
        harness: row.harness,
        resume_target: row.resume_target,
      }),
      label,
      harness: harnessOrClaude(row.harness),
      window_index:
        paneLocation?.window_index !== undefined
          ? paneLocation.window_index
          : typeof row.window_index === "number" &&
              Number.isFinite(row.window_index)
            ? row.window_index
            : null,
      cwd: row.cwd != null && row.cwd !== "" ? row.cwd : null,
      backend_exec_session_id: backendSession,
      created_at: Number.isFinite(row.created_at) ? row.created_at : 0,
    });
    seenJobIds.add(jobId);
  }
  return candidates;
}

/**
 * Derive the CURRENT live set — every `state ∈ {working, stopped}` job that
 * holds backend coords — as restore candidates, ordered by visual window order.
 * A terminal row also qualifies when later backend-exec evidence from the same
 * still-live pid proves the process remains attached; that read-time guard keeps
 * the current snapshot process-scoped without mutating the projection.
 *
 * This is NOT the crash-restore set: it is a snapshot of what is open RIGHT NOW,
 * the source for `restore-agents --snapshot-current`'s replayable revive script.
 * It applies no crash-membership / idle / dedup filtering — the whole point is to
 * capture the live session verbatim so the human can dump a script and re-run it
 * after a crash the automatic path can't be trusted to catch. The resume target
 * is the session UUID (`job_id`), same as a crash candidate, so the emitted
 * script resumes each session EXACTLY; the display `label` keeps the latest name
 * (`title`, `job_id` fallback). Read-only; empty input returns `[]`, never
 * throws.
 */
export function deriveCurrentSet(db: Database): RestoreCandidate[] {
  const rows = db
    .query(
      `SELECT job_id, created_at, title, window_index, cwd,
              COALESCE(backend_exec_session_id, backend_exec_birth_session_id)
                AS backend_exec_session_id,
              harness, resume_target
         FROM jobs
        WHERE state IN ('working', 'stopped')
          AND COALESCE(backend_exec_session_id, backend_exec_birth_session_id)
                IS NOT NULL
          AND COALESCE(backend_exec_session_id, backend_exec_birth_session_id)
                != ''`,
    )
    .all() as {
    job_id: string;
    created_at: number;
    title: string | null;
    window_index: number | null;
    cwd: string | null;
    backend_exec_session_id: string;
    harness: string | null;
    resume_target: string | null;
  }[];

  const candidates: RestoreCandidate[] = [];
  for (const row of rows) {
    const jobId = seg(row.job_id);
    if (jobId === "") {
      continue;
    }
    const backendSession = seg(row.backend_exec_session_id);
    if (backendSession === "") {
      continue;
    }
    const label = row.title != null && row.title !== "" ? row.title : jobId;
    candidates.push({
      job_id: jobId,
      resume_target: resumeTarget({
        job_id: jobId,
        harness: row.harness,
        resume_target: row.resume_target,
      }),
      label,
      harness: harnessOrClaude(row.harness),
      window_index:
        typeof row.window_index === "number" &&
        Number.isFinite(row.window_index)
          ? row.window_index
          : null,
      cwd: row.cwd != null && row.cwd !== "" ? row.cwd : null,
      backend_exec_session_id: backendSession,
      created_at: Number.isFinite(row.created_at) ? row.created_at : 0,
    });
  }

  const seenJobIds = new Set(candidates.map((c) => c.job_id));
  candidates.push(...derivePostTerminalCurrentSet(db, seenJobIds));

  candidates.sort(compareCandidates);
  return candidates;
}

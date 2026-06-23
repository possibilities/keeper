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
 * RESULT. Each candidate's `resume_target` is the latest `title` — the session
 * name keeper currently knows, read live from the jobs projection so it is never
 * a frozen name — falling back to the `job_id` for a never-named session. `label`
 * carries the same display name. Restore resumes by the LATEST name, which is why
 * deriving from the live DB (not a snapshot) is what makes a renamed session
 * restore correctly.
 *
 * PURE-ISH. The derivation reads ONLY the passed read-only `Database` handle and
 * the (injectable) `now` clock for the idle cutoff. No socket, no env, no
 * wall-clock outside the injected `now`. Empty inputs (first boot, zero killed
 * rows) return cleanly — never throw.
 */

import type { Database } from "bun:sqlite";
import type { CloseKind } from "./exec-backend";

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
}

/**
 * One crash-restore candidate. `resume_target` is the latest `title` (the resume
 * key `claude --resume` targets), falling back to the `job_id` for a never-named
 * session; `label` carries the same human-readable name.
 * `window_index` rides through for the ordered render's debugging/diagnostics.
 * `cwd` is the directory the restore command `cd`s into before `claude --resume`
 * (`null` when the SessionStart event never carried one).
 */
export interface RestoreCandidate {
  job_id: string;
  resume_target: string;
  label: string;
  window_index: number | null;
  cwd: string | null;
  backend_exec_session_id: string;
  created_at: number;
}

/** Why a non-candidate killed row was dropped — surfaced in the result counts. */
export interface RestoreSetResult {
  candidates: RestoreCandidate[];
  /** Count of crash-like rows excluded ONLY because they were idle past the
   *  cutoff (a false-negative risk we make visible — never a silent drop). */
  excludedIdleCount: number;
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
 * Total-order comparator placing candidates in original visual (left-to-right)
 * tmux window order: a known `window_index` sorts ascending and precedes an
 * unknown (`null`) one; equal or both-unknown tiebreak by `created_at` then
 * `job_id`. The candidate set is the SOLE ordering authority — restore-agents
 * presents the set as-is. Total + deterministic for legacy/partial rows: a
 * non-finite `created_at` coerces to `0` (never NaN, which poisons a sort).
 */
function compareCandidates(a: RestoreCandidate, b: RestoreCandidate): number {
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
              plan_verb, last_event_id
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
    collected.push({
      candidate: {
        job_id: jobId,
        resume_target: label,
        label,
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
 * Derive the LAST-GENERATION crash-restore set: the crash candidates bounded to
 * the kill-anchored tmux-server generation window — "the session you just lost",
 * not the 7-day pool {@link deriveRestoreSet} returns. (epic fn-819, T2)
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
 * and {@link compareCandidates} verbatim (resume_target = latest name).
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
 * Derive the CURRENT live set — every `state ∈ {working, stopped}` job that
 * holds backend coords — as restore candidates, ordered by visual window order.
 *
 * This is NOT the crash-restore set: it is a snapshot of what is open RIGHT NOW,
 * the source for `restore-agents --snapshot-current`'s replayable revive script.
 * It applies no crash-membership / idle / dedup filtering — the whole point is to
 * capture the live session verbatim so the human can dump a script and re-run it
 * after a crash the automatic path can't be trusted to catch. The resume target
 * is the latest name (`title`, `job_id` fallback), same as a crash candidate, so
 * the emitted script resumes by the name keeper currently knows. Pure read off
 * the passed read-only connection; empty input returns `[]`, never throws.
 */
export function deriveCurrentSet(db: Database): RestoreCandidate[] {
  const rows = db
    .query(
      `SELECT job_id, created_at, title, window_index, cwd,
              COALESCE(backend_exec_session_id, backend_exec_birth_session_id)
                AS backend_exec_session_id
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
      resume_target: label,
      label,
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

  candidates.sort(compareCandidates);
  return candidates;
}

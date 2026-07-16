/**
 * Pure readiness pipeline — given a snapshot of the `epics`, `jobs`, and
 * `subagent_invocations` projections, returns a per-row verdict map for the
 * board UI's `[ready]` / `[completed]` / `[blocked:<reason>]` pill. Pure (no
 * I/O, no `Date.now()`, no external state) so a fixture can pin a verdict and
 * autopilot can consume the discriminated-union tag without parsing strings.
 *
 * Predicate pipeline — first-match-wins per row. RANK ORDER IS LOAD-BEARING;
 * reordering silently breaks autopilot dispatch:
 *   1.   terminal-completed       — task: (worker_phase==="done" OR the task's
 *                                   OWN epic is status==="done") AND no embedded
 *                                   job working AND no running sub-agent, except
 *                                   a proven-dead worker's orphaned invocation.
 *                                   A done
 *                                   epic is ABSORBING: every task under it reads
 *                                   completed even with an unstamped per-task
 *                                   flag, so the reconciler never re-dispatches
 *                                   `work::` against a finished epic. The
 *                                   liveness clauses hold the verdict at
 *                                   `running:*` until the session is idle, so
 *                                   the mutexes stay held. close: status==="done"
 *   1.5. epic-not-materialized    — epic.status == null (no EpicSnapshot folded)
 *   2.   epic-not-validated       — epic.last_validated_at == null (the sole
 *                                   guard against dispatching a mid-plan /
 *                                   mid-refine epic; see the predicate-2 note)
 *   5.   own-progress-main        — embedded jobs[] state==="working"
 *   6.   own-progress-sub         — running sub-agent under this row's worker
 *   6.6. monitor-running/-stale   — live worker-launched monitor occupies the slot
 *   8.   dep-on-task              — any depends_on upstream NOT completed
 *   9.   dep-on-epic              — any depends_on_epics upstream NOT completed
 *   9.5. epic-no-tasks            — close-row only: the epic has ZERO tasks
 *  10.   dep-on-task-synth-close  — close-row: any non-completed task
 *  10.5. dispatch-pending         — launched-but-unbound worker holds the slot
 * 10.55. bound-pending            — BOUND-but-not-yet-active worker holds the slot
 *                                   (stopped + plan_verb + active_since IS NULL;
 *                                   the post-bind half of dispatch-pending)
 *  10.6. runtime-blocked          — task: keeper plan `runtime_status==="blocked"`
 *                                   (last per-row predicate; converts only the
 *                                   erroneous `ready`, never holds a mutex)
 *  11.   single-task-per-epic     — post-pass: lost its epic's fair share
 *  12.   single-task-per-root     — post-pass: root saturated before its turn
 *
 * Predicates 11+12 are emitted by ONE post-pass, `applyPerRootRoundRobinAllocator`
 * — it distributes up to N (`max_concurrent_per_root`) concurrent slots per root
 * fairly across the root's epics via round-robin, keying on the same occupancy
 * predicate (`isRootOccupant` collapses to `isLiveWorkOccupant`). N=1 is
 * byte-identical to the legacy per-epic-FIRST-then-per-root mutexes (it delegates
 * verbatim). Only `ready` rows are mutated; the seam order + `epic_id` tiebreak
 * are the determinism gate.
 *
 * Epic header rollup (after per-row + both post-passes):
 *   - `[completed]`      if the close row is `completed`.
 *   - `[ready]`          if any task or close row is `ready`.
 *   - `[running:<kind>]` if any task or close row is `running`.
 *   - else `[blocked:<first non-completed row's reason in traversal order>]`.
 */

import {
  type EpicDepResolution,
  resolveEpicDep as resolveEpicDepLeaf,
} from "./epic-deps";
import type { ResolutionDiagnostic } from "./readiness-diagnostics";
import {
  deriveHarnessActivity,
  type HarnessActivity,
  isResourceEvidenceStaleActivity,
} from "./session-activity";
import { isOpenTurnRow } from "./subagent-invocations";
import type { Epic, Job, SubagentInvocation, Task } from "./types";

// Re-export so existing import sites keep working. The canonical home is
// `./epic-deps`; this is a thin compat surface.
export type { EpicDepResolution };

/**
 * Wall-clock-bound wrapper around the fold-safe `resolveEpicDep` in
 * `./epic-deps` — stamps diagnostics with `new Date().toISOString()` for
 * readiness/board callers. The reducer caller goes straight to
 * `./epic-deps#resolveEpicDep` with an event-derived timestamp so its fold
 * stays deterministic.
 */
export function resolveEpicDep(
  rawDep: string,
  consumer: Epic,
  epicById: Map<string, Epic>,
  epicsByNumber: Map<number, Epic[]>,
  diagnostics: ResolutionDiagnostic[],
): EpicDepResolution {
  return resolveEpicDepLeaf(
    rawDep,
    consumer,
    epicById,
    epicsByNumber,
    diagnostics,
    new Date().toISOString(),
  );
}

/**
 * Whether an epic has been STARTED — i.e. real worker activity has touched it.
 * The pure read-time signal behind Rule #1 ("prefer the started epic"); never
 * persisted in epic/board state. An epic counts as started when ANY of:
 *   - it carries an epic-form job (`jobs`) whose verb is NOT `plan` — i.e. a
 *     `close`/`approve` (or any non-planner) verb ran,
 *   - any task carries a task-form job (`task.jobs`) — a `work`/`approve` ran,
 *   - any task's `runtime_status` has advanced off `"todo"`.
 *
 * Deliberately does NOT count a planning-time `plan`-verb epic-form job: every
 * planned epic is created via a `plan` session whose `plan::<ref>` job folds
 * into `epics.jobs[]` (a bare epic ref classifies as `kind=epic`) and persists
 * `state='stopped'` after planning. Counting it would mark essentially every
 * planned-but-unworked epic started and collapse the tiering to a no-op — so a
 * planner job is NOT real worker activity. A genuine `plan`-then-worked epic is
 * already caught by the close/task-job/runtime_status signals above.
 *
 * Deliberately does NOT count `job_links`: every entry is `creator`/`refiner`
 * planning provenance (the symmetric per-epic view of the very `plan` sessions
 * excluded above), so a freshly planned-but-unworked epic carries one yet has had
 * zero worker activity. Counting it would mark every planned epic started — the
 * same collapse the `plan`-verb skip avoids. Real execution surfaces in
 * `jobs` / `task.jobs` / `runtime_status`, never a provenance link.
 *
 * Deliberately does NOT key on `task.worker_phase`: its resting value on a
 * never-worked task shell is `"open"` (not null), so counting it would mark
 * every epic started and collapse the tiering. A fresh epic — only a `plan`
 * planner job, all tasks `runtime_status === "todo"` — is NOT started.
 *
 * Null-safe on every field (missing arrays read as empty, missing
 * `runtime_status` reads as the `"todo"` default, missing `plan_verb` reads as
 * non-`plan` so it still marks started): the board calls the seam via an untyped
 * `snap.epics as Epic[]` cast, so a throw here would crash the render path. Pure.
 */
export function isEpicStarted(epic: Epic): boolean {
  for (const job of epic.jobs ?? []) {
    if (job?.plan_verb !== "plan") {
      return true;
    }
  }
  for (const task of epic.tasks ?? []) {
    if ((task.jobs?.length ?? 0) > 0) {
      return true;
    }
    if ((task.runtime_status ?? "todo") !== "todo") {
      return true;
    }
  }
  return false;
}

/**
 * The single ordering seam every scheduling consumer (the board, the autopilot
 * reconciler, the `keeper autopilot` viewer) routes its epic list through.
 *
 * The backend serves epics in a NEUTRAL `epic_number ASC` creation order (the
 * `EPICS_DESCRIPTOR` default sort); no priority/ordering signal lives in
 * epic/board STATE. This seam applies Rule #1 ("prefer the started epic") as a
 * pure read-time reorder over that seed: STARTED epics (`isEpicStarted`) sort
 * ahead of unstarted ones, so the autopilot finishes in-progress epics before
 * opening new ones and every consuming view stays consistent. No priority is
 * ever persisted — it is recomputed each call from task/job activity. A
 * consumer that wants a different scheduling order changes ONLY this function.
 *
 * STABLE TOTAL ORDER: `tier (started=0, unstarted=1) → epic_number ASC (null
 * sorts last) → epic_id`. The unique `epic_id` final tiebreak makes the result
 * cycle-invariant — the same set in any input order yields the same output, so
 * the reconciler's per-tick `dedupedEpics` ordering can't oscillate the board.
 * Hard-categorical: no aging/floor/threshold — the per-root round-robin
 * allocator bounds same-root concurrency to N (default 1), self-bounding "prefer
 * started" to "finish A, then B, then C" in creation order at N=1, and at N>1
 * walking this same seam order to spread a root's N slots across its epics.
 *
 * Pure: no I/O, no clock, never throws. The tier is snapshotted per epic before
 * sorting (so the comparator stays a cheap field read), and the comparator is
 * null-safe. Returns a fresh array (never mutates the input).
 */
export function orderEpicsForScheduling(epics: readonly Epic[]): Epic[] {
  const tiered = epics.map((epic) => ({
    epic,
    tier: isEpicStarted(epic) ? 0 : 1,
  }));
  tiered.sort((a, b) => {
    if (a.tier !== b.tier) {
      return a.tier - b.tier;
    }
    // null `epic_number` sorts LAST within its tier; never subtract (a null →
    // NaN comparator breaks the total order). Both null falls through to the
    // `epic_id` tiebreak.
    const an = a.epic.epic_number;
    const bn = b.epic.epic_number;
    if (an !== bn) {
      if (an == null) {
        return 1;
      }
      if (bn == null) {
        return -1;
      }
      return an - bn;
    }
    // Unique final tiebreak — guarantees a total order (cycle-invariance).
    return a.epic.epic_id < b.epic.epic_id
      ? -1
      : a.epic.epic_id > b.epic.epic_id
        ? 1
        : 0;
  });
  return tiered.map((t) => t.epic);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Structured block reason — discriminated union with payloads so consumers
 * branch on `kind` without parsing strings.
 *
 * - `job-rejected` / `job-pending`     — RETAINED-BUT-UNPRODUCED: the approval
 *                                        window is gone, so no predicate emits
 *                                        them; the kinds stay for label/pill
 *                                        plumbing.
 * - `git-uncommitted` / `git-orphans`  — RETAINED-BUT-UNPRODUCED: the
 *                                        git-cleanliness gate (rank 6.5) was
 *                                        deleted with the approval window; kept
 *                                        for label/pill plumbing.
 * - `epic-not-validated`               — parent epic has no `last_validated_at`.
 * - `dep-on-task`                      — an upstream task is not completed (carries the upstream id).
 * - `dep-on-epic`                      — an upstream epic's close is not completed. `upstream` is the
 *                                        resolved full id (kept literal for lookup); the optional
 *                                        `cross_project` carries the upstream's project basename so the
 *                                        renderer can prefix `<project>::<id>`, `null` for intra-project.
 * - `dep-on-epic-dangling`             — a `depends_on_epics` entry could not be resolved (full-id miss,
 *                                        bare-id miss, or ambiguous 2+ match). Red pill, distinct from
 *                                        the amber `dep-on-epic`.
 * - `single-task-per-epic`             — lost the per-epic mutex.
 * - `single-task-per-root`             — lost the per-root mutex.
 * - `epic-no-tasks`                    — close-row only: the epic has ZERO tasks (the partial-projection
 *                                        window between an `EpicSnapshot` and its first `TaskSnapshot`).
 *                                        Catches predicate 10's vacuous-true fall-through so a closer
 *                                        isn't dispatched against an epic with no work. Payload-less.
 * - `epic-not-materialized`            — epic.status is NULL ⇔ no `EpicSnapshot` has folded yet (the
 *                                        scaffold shell row). The EARLIEST blocked predicate on both
 *                                        paths, so a freshly-scaffolded epic is non-dispatchable until
 *                                        it materializes; same notion the board's `default_visible`
 *                                        uses to hide the shell row. Payload-less.
 * - `dispatch-pending`                 — a worker was LAUNCHED against this row but its `SessionStart`
 *                                        hasn't folded yet (an open `pending_dispatches` row). The launch
 *                                        → SessionStart blind window has no `jobs` row, so this is the
 *                                        only signal the slot is taken. Set at a LATE per-row rank (after
 *                                        every real running/dep verdict, before the post-pass mutexes) so
 *                                        it occupies both mutexes via `isLiveWorkOccupant`.
 *                                        Non-dispatchable and self-resolving (discharges on SessionStart
 *                                        bind / DispatchFailed / DispatchExpired). Payload-less.
 * - `bound-pending`                    — a worker BOUND (its SessionStart folded a `jobs` row at
 *                                        `state='stopped'` carrying a real `plan_verb`) but not yet ACTIVE
 *                                        (`active_since IS NULL` — never transitioned into `working`). The
 *                                        SAME atomic SessionStart fold that mints this row DELETEs the
 *                                        `pending_dispatches` row, so every snapshot shows EITHER
 *                                        `dispatch-pending` OR `bound-pending` — never neither — closing
 *                                        the launch → bind → first-activity occupancy gap. Ranked
 *                                        immediately after `dispatch-pending` and before the post-pass
 *                                        mutexes so it occupies both via `isLiveWorkOccupant`. The
 *                                        `active_since IS NULL` gate disambiguates a freshly-bound worker
 *                                        (occupy) from a stopped-after-working / dead one (do NOT
 *                                        over-hold). Non-dispatchable, self-resolving (the first
 *                                        UserPromptSubmit flips state → `working` → pred-5 takes over).
 *                                        Payload-less.
 * - `runtime-blocked`                  — keeper plan stamped the task `runtime_status="blocked"` (e.g. a
 *                                        killed worker). Without this gate the task still computes `ready`
 *                                        (its `worker_phase` stays `open`) and the reconciler dispatches a
 *                                        worker that can't progress. The LAST per-row predicate, after
 *                                        terminal-completed/running/dispatch-pending, so it converts ONLY
 *                                        the erroneous `ready` and never masks a truer verdict or releases
 *                                        a live worker's mutex. NOT a `isLiveWorkOccupant` member — a stuck
 *                                        task must not hold the per-task/root mutex. Payload-less.
 * - `unknown`                          — defensive default for verdict/renderer mismatch.
 */
export type BlockReason =
  | { kind: "job-rejected" }
  | { kind: "job-pending" }
  | { kind: "epic-not-materialized" }
  | { kind: "epic-not-validated" }
  | { kind: "git-uncommitted" }
  | { kind: "git-orphans" }
  | { kind: "dep-on-task"; upstream: string }
  | { kind: "dep-on-epic"; upstream: string; cross_project: string | null }
  | { kind: "dep-on-epic-dangling"; upstream: string }
  | { kind: "single-task-per-epic" }
  | { kind: "single-task-per-root" }
  | { kind: "epic-no-tasks" }
  // A close-row-only reason: the epic is the SOURCE of an open blocking
  // follow-up (some epic points its `blocks_closing_of` at this one) that is
  // not yet done-and-close-idle, so the source's close is held. `followup`
  // carries the gating follow-up's epic id for board legibility. Informational
  // and NON-occupying — it stays out of `isLiveWorkOccupant`, so a healthy
  // wait neither holds the per-root mutex nor blocks reaps.
  | { kind: "close-followup"; followup: string }
  | { kind: "dispatch-pending" }
  | { kind: "bound-pending" }
  | { kind: "runtime-blocked" }
  | { kind: "unknown" };

/**
 * The "in-motion" reasons — the sibling `running` Verdict tag. A `running`
 * verdict means the row has a live worker / sub-agent / planner / monitor
 * session in motion, distinct from a `blocked` verdict (stuck waiting on a
 * dependency, repo state, or mutex).
 *
 * `sub-agent-stale` is readiness's conservative rendering of unknown child
 * evidence. It keeps the mutex occupied while making the uncertainty visible;
 * age alone never proves terminality.
 */
export type RunningReason =
  | { kind: "job-running" }
  | { kind: "sub-agent-running" }
  | { kind: "sub-agent-stale" }
  | { kind: "monitor-running" }
  | { kind: "monitor-stale" };

/**
 * Staleness threshold for child evidence. It is anchored on the invocation's
 * `updated_at` last-activity stamp, matching the canonical Harness activity
 * derivation and reducer guards. Crossing it yields unknown, not quiescent.
 *
 * Determinism: `now - inv.updated_at > SUBAGENT_STALENESS_SEC` reads the injected
 * `now`, NOT `Date.now()`. This is a CLIENT computation over the live
 * projection, not a reducer fold — re-fold determinism does not apply. Live
 * callers supply `Math.floor(Date.now()/1000)`; the simulator/tests pass the
 * default `Number.NEGATIVE_INFINITY` so the staleness branch never fires.
 */
export const SUBAGENT_STALENESS_SEC = 120;

/**
 * Soft staleness lease for the `monitor-running` → `monitor-stale` split. A
 * task whose embedded work job carries the `has_live_worker_monitor` fact
 * occupies the mutex; once the freshest occupying job's `updated_at` is older
 * than the injected `now` by strictly more than this, the verdict surfaces
 * `monitor-stale` — STILL occupying, but flagged "may be abandoned".
 *
 * Lease, NOT heartbeat: the anchor is `updated_at`, which bumps per agent
 * turn-end — NOT the backgrounded suite's own runtime. Past the lease the
 * Harness activity fact is unknown and readiness conservatively keeps its hold.
 *
 * Determinism: read-time `now`-injected comparison, NEVER folded — the
 * sanctioned exception, mirroring {@link SUBAGENT_STALENESS_SEC}. Live callers
 * pass `Math.floor(Date.now()/1000)`; the simulator/tests pass the default
 * `Number.NEGATIVE_INFINITY`.
 */
export const MONITOR_STALENESS_SEC = 600;

/** A stopped worker-monitor occupant whose canonical Harness resource evidence
 * remains unknown beyond a caller-provided paging horizon. This is producer
 * input only: discovering one never changes readiness or releases its slot. */
export interface LongUnknownMonitorOccupant {
  jobId: string;
  root: string;
  updatedAt: number;
}

/**
 * Project the monitor occupants that still hold a dispatch root after their
 * canonical Harness activity became `resource-evidence-stale` and stayed that
 * way past `thresholdSec`. The producer separately proves the session pid alive
 * before paging; this pure read-side seam only correlates the canonical activity
 * with the exact embedded task/close row that owns the root mutex.
 *
 * Strictly `>` the threshold, matching the monitor-staleness lease. No age is a
 * terminal verdict: this function returns observations only and never mutates a
 * readiness verdict, releases capacity, or kills a session.
 */
export function findLongUnknownMonitorOccupants(
  epics: readonly Epic[],
  activityByJobId: ReadonlyMap<string, HarnessActivity>,
  now: number,
  thresholdSec: number,
): LongUnknownMonitorOccupant[] {
  const out: LongUnknownMonitorOccupant[] = [];
  const seen = new Set<string>();
  const add = (
    jobs: readonly {
      job_id: string;
      state: string;
      updated_at: number;
      has_live_worker_monitor?: boolean;
    }[],
    root: string,
  ): void => {
    for (const job of jobs) {
      if (
        seen.has(job.job_id) ||
        job.state !== "stopped" ||
        job.has_live_worker_monitor !== true ||
        !Number.isFinite(job.updated_at) ||
        now - job.updated_at <= thresholdSec ||
        !isResourceEvidenceStaleActivity(activityByJobId.get(job.job_id))
      ) {
        continue;
      }
      seen.add(job.job_id);
      out.push({ jobId: job.job_id, root, updatedAt: job.updated_at });
    }
  };

  for (const epic of epics) {
    const projectDir = stringOrNull(epic.project_dir);
    for (const task of epic.tasks) {
      add(task.jobs, effectiveRoot(stringOrNull(task.target_repo), projectDir));
    }
    add(epic.jobs, effectiveRoot(null, projectDir));
  }
  return out;
}

export type Verdict =
  | { tag: "ready" }
  | { tag: "completed" }
  | { tag: "blocked"; reason: BlockReason }
  | { tag: "running"; reason: RunningReason };

/**
 * The full readiness snapshot — per-task, per-close-row, and per-epic-header
 * (close-row + header keyed by epic_id). A renderer-side lookup that misses
 * renders `[blocked:unknown]` — visible (bug indicator) and inert (autopilot
 * won't dispatch on `unknown`).
 *
 * `diagnostics` carries side-band resolver output (ambiguous bare-`fn-N` dep
 * resolutions). Side-effecting consumers drain it per snapshot to the
 * diagnostics JSONL; `computeReadiness` itself never performs I/O.
 */
export interface ReadinessSnapshot {
  perTask: Map<string, Verdict>;
  perCloseRow: Map<string, Verdict>;
  perEpic: Map<string, Verdict>;
  diagnostics: ResolutionDiagnostic[];
}

/**
 * A single open `pending_dispatches` row projected into the plain shape
 * `computeReadiness` consumes for the `dispatch-pending` occupant. A STRUCTURAL
 * type, NOT autopilot's `DispatchKey` / `Verb` — `src/readiness.ts` is the
 * import LEAF, so it cannot reference autopilot's vocabulary; it constructs the
 * canonical `verb::id` key locally.
 *
 * - `verb` / `id` — the `(verb, id)` composite pk, matched against
 *   `work::<task_id>` / `approve::<task_id>` per task and `close::<epic_id>`
 *   per close row.
 * - `dir` — the launch directory. Used ONLY for the root-fallback: a pending
 *   row matching no snapshot row occupies this `dir` as a per-root slot. A null
 *   `dir` contributes no root occupant (degrades safely).
 * - `dispatched_at` — unix-epoch SECONDS the row was minted (the same clock as
 *   the injected `now`). Drives the {@link PENDING_DISPATCH_STALE_CEILING_SEC}
 *   backstop: a pending older than the hard ceiling is EXCLUDED from occupancy
 *   (verdict + per-root mutex + budget) so a stale launch window can't starve
 *   real dispatch in the window before the TTL sweep clears it. A missing value
 *   normalises to `Infinity` (treated as fresh — never excluded).
 *
 * `projectPendingDispatches` in `src/readiness-client.ts` is the SOLE builder,
 * imported by BOTH consumers (the reconciler and `subscribeReadiness`) so they
 * never diverge.
 */
export type PendingDispatch = {
  verb: string;
  id: string;
  dir: string | null;
  dispatched_at: number;
};

/**
 * Hard staleness ceiling (unix SECONDS) for the `pending_dispatches` occupancy
 * backstop. A pending whose `dispatched_at` is older than the injected `now` by
 * strictly more than this is excluded from the `dispatch-pending` verdict, the
 * per-root mutex, and the autopilot budget — a pure LAST-RESORT defense so a
 * stale launch window can't starve real dispatch before the TTL sweep releases
 * it.
 *
 * Set to 2× `PENDING_DISPATCH_TTL_MS` (= 240s, vs the 120s TTL + ~60s sweep
 * cadence) so the exclusion NEVER opens a double-dispatch window: the 60s sweep
 * always expires + DELETEs the row well before this ceiling, so by the time a
 * row would be excluded here it is already gone. Held as a local constant (not
 * imported from `daemon.ts`) to keep readiness an import LEAF, mirroring
 * {@link SUBAGENT_STALENESS_SEC}; the relationship is asserted in tests.
 *
 * Determinism: `now - dispatched_at > ceiling` reads the INJECTED `now`, never
 * `Date.now()`. The simulator/tests pass the default `Number.NEGATIVE_INFINITY`
 * so the branch is inert (`-Infinity - dispatched_at` is always `-Infinity`),
 * keeping readiness/simulator byte-identity — exactly like the staleness gates.
 */
export const PENDING_DISPATCH_STALE_CEILING_SEC = 240;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Pure entry. Walks `epics` in iteration order (the caller hands in a
 * deterministically-ordered iterable). For each epic, builds per-task verdicts
 * via the predicate pipeline, then the synthetic close-row verdict, then the
 * header rollup; `applySingleTaskPerEpicMutex` then
 * `applySingleTaskPerRootMutex` mutate the maps for the two post-pass mutexes
 * (per-epic first — tighter scope reported when both apply). Never mutates its
 * inputs.
 */
export function computeReadiness(
  epics: Iterable<Epic>,
  jobs: Map<string, Job>,
  subagentInvocations: Iterable<SubagentInvocation>,
  // Project-wide git status keyed by `project_dir`. RETAINED-BUT-UNREAD: the
  // sole consumer was the deleted predicate 6.5 (git-cleanliness). Defaults
  // empty. The `unattributed_to_live_count` field deliberately keeps that
  // name while the block-reason kind stays `git-orphans` — autopilot's reason
  // enumeration consumes the literal string.
  gitStatusByProjectDir: Map<
    string,
    { dirty_count: number; unattributed_to_live_count: number }
  > = new Map(),
  // Caller-injected reference timestamp (unix seconds) for the
  // `sub-agent-stale` / `monitor-stale` variants. The pure pass never reads
  // `Date.now()`; the live client supplies `Math.floor(Date.now()/1000)`. The
  // simulator/tests pass the default `Number.NEGATIVE_INFINITY` so the
  // staleness branches never fire (`-Infinity - ts > threshold` is always
  // false). See {@link SUBAGENT_STALENESS_SEC} for the determinism rationale.
  now: number = Number.NEGATIVE_INFINITY,
  // The open `pending_dispatches` rows — workers LAUNCHED but whose
  // `SessionStart` has not folded yet. Each row is matched to a task
  // (`work::<id>` / `approve::<id>`) or close row (`close::<id>`) and sets the
  // `dispatch-pending` occupant verdict at a LATE per-row rank, so the launch
  // → SessionStart blind window holds BOTH mutexes via `isLiveWorkOccupant`. A
  // row matching NO snapshot row falls back to occupying its own `dir` root,
  // seeded into `applySingleTaskPerRootMutex` outside the per-row walk. A row
  // past {@link PENDING_DISPATCH_STALE_CEILING_SEC} (relative to `now`) is
  // EXCLUDED from BOTH the verdict and the root-fallback (the backstop). Default
  // `[]` for callers that don't subscribe to `pending_dispatches`.
  pendingDispatches: PendingDispatch[] = [],
  // Autopilot `armed`-mode eligibility, threaded into the per-root mutex's
  // discretionary pass-2 ready-tiebreak. ABSENT (`undefined`) selects the
  // byte-identical legacy single-pass (yolo / tests / simulator). PROVIDED
  // (even EMPTY) selects the eligible-priority two-pass: an armed (eligible)
  // epic wins a free root over an earlier-sorted unarmed sibling. The caller
  // computes the closure via `computeEligibleEpics`; readiness stays an import
  // LEAF and never derives it. Appended LAST so default-reliant call sites stay
  // valid.
  eligibleEpicIds?: Set<string>,
  // The PER-ROOT git-seed gate. While the live-only git surface is
  // UNSEEDED for a given root (the daemon restarted and the boot-seed hasn't
  // established a `git_status` row above the floor for it yet), it reads EMPTY —
  // so a dispatch decision into that root would race against a surface that
  // can't yet report dirtiness/orphans. Each member is an `effectiveRoot` (keyed
  // IDENTICALLY to the per-root mutex below) whose surface is unseeded; a row
  // whose `effectiveRoot` is in the set is forced to
  // `{tag:"blocked", reason:{kind:"unknown"}}` so the autopilot never dispatches
  // against an unknown surface — but a SEEDED sibling root still dispatches
  // (bulkhead / fault-isolation), and `""` (rootless) rows are never gated. The
  // EMPTY set is today's "seeded" path: no row is gated, so steady-state / test /
  // simulator callers (and the byte-identical re-fold simulator) behave exactly
  // as before. Producers pass an empty set whenever `seed_required` is CLEAR.
  unseededRoots: ReadonlySet<string> = new Set<string>(),
  // The per-root dispatch concurrency count N — how many tasks may
  // dispatch concurrently into a single root, distributed fairly across the
  // root's epics by `applyPerRootRoundRobinAllocator` (which REPLACES the
  // per-epic + per-root mutexes). Default 1 = one-task-per-root behavior
  // (byte-identical in non-worktree mode — the allocator delegates verbatim to
  // the two legacy passes at N=1). Both readiness consumers (board + reconciler)
  // carry the SAME N off `BootStatus` so they compute identical demotions. A LITERAL default
  // (not the imported `DEFAULT_MAX_CONCURRENT_PER_ROOT`) keeps readiness an import
  // LEAF. Appended LAST so default-reliant call sites stay valid.
  maxConcurrentPerRoot: number = 1,
  // The worktree-mode LANE re-key. When worktree mode is ON the producer
  // derives, per epic, the pure DAG → worktree topology and threads each node's
  // worktree path here (task_id → lane path, plus epic_id → the BASE lane path
  // for the close sink). The allocator first keys on the lane path, making each
  // worktree a CAP-1 lane — two agents in one worktree index would corrupt it —
  // then applies the per-root cap over the rows' true roots. ABSENT/empty (the
  // default — OFF mode, tests, simulator) selects today's `effectiveRoot` keying,
  // byte-identical. Threaded
  // into BOTH `applyPerRootRoundRobinAllocator` and (via it) the legacy
  // per-root mutex so the gate never diverges from the dispatch-side resolver,
  // which builds the SAME map off the SAME `deriveWorktreePlan`. Appended LAST so
  // default-reliant call sites stay valid.
  laneKeyById: ReadonlyMap<string, string> = new Map(),
  // Job ids whose owning session the daemon has PROVEN dead — the recorded
  // claude pid re-proved gone by a producer-side probe at snapshot load,
  // mirroring the exit-watcher's own pid-death verdict. Consumed ONLY by the
  // terminal-completed gate (predicate 1): a done task whose OWNING worker is in
  // this set no longer has its `completed` verdict un-set by that job's lingering
  // subagent / monitor rows, which are GHOSTS once the session is dead (a
  // `stopped` row's open-turn subs are never swept the way a `killed`/`ended`
  // fold sweeps them, so a dead worker's orphan `running` sub would otherwise
  // oscillate the verdict completed↔running against unrelated sibling churn).
  // ABSENT/EMPTY (the board, autoclose, tests, the simulator) is byte-identical
  // to the plain gate — a mere `stopped` owning job still holds the verdict off
  // `completed` (conservative; never earlier-firing). NEVER a fold input
  // (producer-side liveness only, so re-fold stays deterministic). Appended LAST
  // so default-reliant call sites stay valid.
  provenDeadJobIds: ReadonlySet<string> = new Set<string>(),
): ReadinessSnapshot {
  // Drop pendings past the hard ceiling BEFORE deriving occupancy: a stale
  // launch window must not count toward the `dispatch-pending` verdict, the
  // per-root mutex, or the autopilot budget, so a phantom can't starve real
  // dispatch in the window before the TTL sweep clears it. `now`-gated EXACTLY
  // like the staleness variants — the default `-Infinity` makes
  // `-Infinity - dispatched_at > ceiling` always false, so every pending stays
  // an occupant and re-fold/simulator byte-identity holds. See
  // {@link PENDING_DISPATCH_STALE_CEILING_SEC}.
  const livePendingDispatches = pendingDispatches.filter(
    (pd) => !(now - pd.dispatched_at > PENDING_DISPATCH_STALE_CEILING_SEC),
  );

  // Index the LIVE (non-stale) pending dispatches by their canonical `verb::id`
  // key (constructed locally — readiness is the import LEAF). The per-row
  // evaluators record every key they MATCH into `matchedPendingKeys`, so the
  // unmatched remainder drives the root-fallback after the per-row walk.
  const pendingKeys = new Set<string>();
  for (const pd of livePendingDispatches) {
    pendingKeys.add(`${pd.verb}::${pd.id}`);
  }
  const matchedPendingKeys = new Set<string>();

  // Build a job_id → SubagentInvocation[] index so predicate 6 is O(1) per row.
  // Keep terminal and malformed evidence in the bounded collection: the
  // canonical Harness activity derivation decides open/terminal/unknown, so an
  // incomplete row can never disappear into an idle verdict at this boundary.
  const subRunningByJobId = new Map<string, SubagentInvocation[]>();
  for (const inv of subagentInvocations) {
    const arr = subRunningByJobId.get(inv.job_id);
    if (arr === undefined) {
      subRunningByJobId.set(inv.job_id, [inv]);
    } else {
      arr.push(inv);
    }
  }

  // Build a tasks-by-id index spanning every epic, so predicate 8's
  // `dep-on-task` upstream lookups hit O(1) and resolve order-independently
  // (forward refs included). Predicate 9 reads `epic.resolved_epic_deps`
  // (maintained by the reducer's forward-stamp + reverse fan-out), so the
  // readiness pass no longer resolves cross-epic EPIC deps live.
  const taskById = new Map<string, Task>();
  // epic_id → Epic, so predicate 9's `satisfied` branch can probe the upstream's
  // raw liveness (see `epicHasLiveCloseScopeWork`). A `satisfied` projection
  // entry means the upstream is status-done, but its closer may still be winding
  // down — the dependent must stay `blocked:dep-on-epic` until the upstream is
  // also idle, so the lookup is by raw epic state, never the upstream's verdict
  // (which may not be computed yet for a forward-referenced upstream).
  const epicsById = new Map<string, Epic>();
  const epicsArr: Epic[] = [];
  // Reverse index for the blocking-follow-up close gate: SOURCE epic id → the
  // follow-up epic whose `blocks_closing_of` points at it. Built ONCE per pass
  // over the (typically empty) set of epics carrying a non-null pointer, so the
  // close-row predicate is an O(1) lookup and the pass never goes quadratic on
  // board size (the epic Risks bar). At most one follow-up per source by the
  // idempotent-child-identity design (docs/adr/0028); a first-write-wins keep
  // is deterministic under the caller's stable epic order.
  const blockingFollowupBySource = new Map<string, Epic>();
  for (const epic of epics) {
    epicsArr.push(epic);
    epicsById.set(epic.epic_id, epic);
    const source = epic.blocks_closing_of;
    if (
      source != null &&
      source !== "" &&
      !blockingFollowupBySource.has(source)
    ) {
      blockingFollowupBySource.set(source, epic);
    }
    for (const task of epic.tasks) {
      taskById.set(task.task_id, task);
    }
  }

  const perTask = new Map<string, Verdict>();
  const perCloseRow = new Map<string, Verdict>();
  const perEpic = new Map<string, Verdict>();
  // The readiness pass no longer resolves cross-epic deps live, so there's no
  // ambiguity-diagnostic surface here — the reducer's fold-time resolver owns
  // ambiguity emission. This slot stays in the snapshot for the public
  // `ReadinessSnapshot` contract and stays empty.
  const diagnostics: ResolutionDiagnostic[] = [];

  for (const epic of epicsArr) {
    // Per-task pass. Predicate 8 resolves each `depends_on` upstream from
    // `taskById` and tests its own terminal-completed state, so a forward
    // reference (upstream with a higher task_number, evaluated later in this
    // pass) resolves correctly regardless of traversal order.
    for (const task of epic.tasks) {
      const verdict = evaluateTask(
        task,
        epic,
        jobs,
        subRunningByJobId,
        taskById,
        perCloseRow,
        epicsById,
        gitStatusByProjectDir,
        now,
        pendingKeys,
        matchedPendingKeys,
        provenDeadJobIds,
      );
      perTask.set(task.task_id, verdict);
    }

    // Synthetic close-row verdict.
    const closeVerdict = evaluateCloseRow(
      epic,
      jobs,
      subRunningByJobId,
      perTask,
      gitStatusByProjectDir,
      now,
      pendingKeys,
      matchedPendingKeys,
      blockingFollowupBySource,
    );
    perCloseRow.set(epic.epic_id, closeVerdict);
  }

  // Root-fallback: a pending dispatch whose `verb::id` matched NO task or
  // close row above (launch→materialize lag or a deleted-target window). Its
  // slot must still be held so a sibling on the same root can't double-dispatch
  // into it, but there's no per-row verdict to set, so seed the row's own `dir`
  // into the per-root mutex's occupied set. A null `dir` contributes nothing
  // (degrades safely — the row's own TTL/discharge still clears it).
  const fallbackRoots = new Set<string>();
  for (const pd of livePendingDispatches) {
    const key = `${pd.verb}::${pd.id}`;
    if (matchedPendingKeys.has(key)) {
      continue;
    }
    if (pd.dir != null && pd.dir !== "") {
      fallbackRoots.add(pd.dir);
    }
  }

  // Post-pass allocator — mutates `perTask` / `perCloseRow` in board
  // traversal order. ONE pass supersedes the two legacy mutexes: it distributes
  // up to `maxConcurrentPerRoot` (N) concurrent slots per root fairly across the
  // root's epics via round-robin. N=1 is byte-identical (it delegates verbatim to
  // the per-epic-FIRST then per-root passes); N>1 fills round-robin. Seeded with
  // the root-fallback occupants resolved above; armed eligibility + the close-row
  // gate carry through both paths.
  applyPerRootRoundRobinAllocator(
    epicsArr,
    perTask,
    perCloseRow,
    subRunningByJobId,
    fallbackRoots,
    maxConcurrentPerRoot,
    eligibleEpicIds,
    laneKeyById,
  );

  // PER-ROOT unseeded-git gate. Force UNKNOWN only for a row whose
  // `effectiveRoot` is unseeded, so the autopilot can't dispatch into a root
  // that reads empty merely because the boot-seed hasn't established it — while a
  // seeded sibling root still dispatches (the coupling is gone). Keyed on the
  // canonical `effectiveRoot` (task.target_repo ?? epic.project_dir), IDENTICAL
  // to the per-root mutex above, so the gate and dispatch root-resolution never
  // drift. `""` (rootless) rows are ungated. Applied AFTER the normal pass
  // (cheaper to overwrite than to gate every predicate) and BEFORE the header
  // rollup so a fully-gated epic rolls up to blocked too. Empty set → no-op
  // (byte-identical to the legacy seeded path).
  if (unseededRoots.size > 0) {
    const unknown: Verdict = { tag: "blocked", reason: { kind: "unknown" } };
    for (const epic of epicsArr) {
      const projectDir = stringOrNull(epic.project_dir);
      for (const task of epic.tasks) {
        const root = effectiveRoot(stringOrNull(task.target_repo), projectDir);
        if (root !== "" && unseededRoots.has(root)) {
          perTask.set(task.task_id, unknown);
        }
      }
      // The close row keys on the epic's own project_dir (no per-row override).
      const closeRoot = effectiveRoot(null, projectDir);
      if (closeRoot !== "" && unseededRoots.has(closeRoot)) {
        perCloseRow.set(epic.epic_id, unknown);
      }
    }
  }

  // Epic header rollup.
  for (const epic of epicsArr) {
    perEpic.set(epic.epic_id, rollupEpicHeader(epic, perTask, perCloseRow));
  }

  return { perTask, perCloseRow, perEpic, diagnostics };
}

// ---------------------------------------------------------------------------
// Predicate pipeline — per-row
// ---------------------------------------------------------------------------

/**
 * Terminal-completed test for a task — predicate 1's condition, factored so the
 * `dep-on-task` upstream check (predicate 8) can ask the SAME question of an
 * arbitrary upstream task directly, ORDER-INDEPENDENTLY. The administrative
 * signal is `worker_phase==="done"` OR the task's OWN parent epic being
 * `status==="done"` — a done epic is ABSORBING, so a task whose per-task flag
 * was never stamped (legacy import, `keeper plan epic close --force`) still
 * reads terminal and the reconciler never re-dispatches `work::` against it
 * (mirrors the close-row literal in `evaluateCloseRow`). The three liveness
 * clauses still hold a done-but-live task off `completed` until its session is
 * idle (see predicate 1's note), so a live worker keeps its per-root mutex.
 *
 * The epic is resolved from `epicsById` via the task's OWN `epic_id`, NOT an
 * ambient epic param, because predicate 8 shares this function to judge
 * possibly-cross-epic upstreams — the ambient epic would misjudge a cross-epic
 * dep. A null/absent `epic_id` (or an id absent from the map) falls back to
 * `worker_phase`-only and never throws.
 *
 * Pure over the task's own fields + the epic index + the running-subagent index
 * + injected `now` — it never reads another row's in-progress verdict, so a
 * forward dependency (`task.depends_on` pointing at a HIGHER-numbered,
 * not-yet-evaluated task) resolves identically regardless of board-traversal
 * order.
 */
function isTaskTerminalCompleted(
  task: Task,
  subRunningByJobId: Map<string, SubagentInvocation[]>,
  epicsById: Map<string, Epic>,
  now: number,
  provenDeadJobIds: ReadonlySet<string>,
): boolean {
  const ownEpic =
    task.epic_id == null ? undefined : epicsById.get(task.epic_id);
  const terminalAdminSignal =
    task.worker_phase === "done" || ownEpic?.status === "done";
  // A still-`working` owning job always holds the verdict off `completed` (the
  // live-worker mutex hold), read over the FULL job set — a proven-dead set is
  // `stopped`-only, so a working job is never in it and this bar is never
  // relaxed.
  if (!terminalAdminSignal || anyEmbeddedJobWorking(task.jobs)) {
    return false;
  }
  // The `completed` verdict is a one-way latch per the OWNING job's terminality.
  // Once that worker session is PROVEN dead (its recorded pid re-proved gone —
  // `provenDeadJobIds`), its lingering subagent / monitor rows are GHOSTS: a
  // `stopped` row's open-turn subs are never swept the way a `killed`/`ended`
  // fold sweeps them, so a dead worker's orphan `running` sub would otherwise
  // oscillate this verdict completed↔running against unrelated sibling churn.
  // Read the subagent + monitor liveness off ONLY the jobs that are NOT proven
  // dead, so a ghost can't un-complete the task. A job still merely `stopped`
  // (NOT proven dead) stays in the set and keeps holding — conservative, never
  // earlier-firing — and a genuinely re-activated owning job re-enters via
  // `anyEmbeddedJobWorking` above (no permanent latch on the task id).
  const liveOwningJobs = excludeProvenDeadJobs(task.jobs, provenDeadJobIds);
  return (
    !anyEmbeddedJobHasRunningSubagent(liveOwningJobs, subRunningByJobId) &&
    !embeddedMonitorOccupies(liveOwningJobs, now)
  );
}

function evaluateTask(
  task: Task,
  epic: Epic,
  // Unused: the live-jobs join was dropped — `JobLinkEntry.state` carries the
  // linked session's last-known lifecycle off the projection. Kept so
  // `computeReadiness`'s public surface is unchanged.
  _jobs: Map<string, Job>,
  subRunningByJobId: Map<string, SubagentInvocation[]>,
  // task_id → Task spanning EVERY epic (built once in `computeReadiness`), so
  // predicate 8's `dep-on-task` upstream check reads the upstream task's OWN
  // terminal-completed state instead of its in-progress verdict — order-
  // independent, mirroring how predicate 9 reads raw epic state. A forward
  // `depends_on` (upstream not yet evaluated) therefore resolves correctly.
  taskById: Map<string, Task>,
  // Unused: predicate 9 reads `epic.resolved_epic_deps` instead of resolving
  // live, so it no longer touches `perCloseRow`. Kept for call-site symmetry.
  _perCloseRow: Map<string, Verdict>,
  // epic_id → Epic, so predicate 9's `satisfied` branch can probe the upstream's
  // raw close-scope liveness via `epicHasLiveCloseScopeWork`. Read by RAW epic
  // state, never the upstream's verdict — a forward-referenced upstream has no
  // verdict computed yet, so gating on it would make the answer board-sort
  // dependent.
  epicsById: Map<string, Epic>,
  // Unused: the sole reader was the deleted predicate 6.5. Kept for call-site
  // symmetry with `computeReadiness`'s public surface.
  _gitStatusByProjectDir: Map<
    string,
    { dirty_count: number; unattributed_to_live_count: number }
  >,
  // Caller-injected reference timestamp for the staleness checks — see
  // `computeReadiness`'s `now` doc.
  now: number,
  // The canonical `verb::id` keys of every open `pending_dispatches` row, and
  // the running set MATCHED so far. The task arm matches `work::<task_id>`; a
  // match records the key into `matchedPendingKeys` and sets the late-rank
  // `dispatch-pending` verdict below.
  pendingKeys: Set<string>,
  matchedPendingKeys: Set<string>,
  // Job ids the daemon has PROVEN dead — threaded into the terminal-completed
  // gate (predicate 1) so a done task's ghost subagent / monitor liveness on a
  // dead owning worker can't un-complete it. Also consulted for predicate 8's
  // upstream terminal check so a proven-dead upstream reads done
  // order-independently. EMPTY on the board / autoclose / test paths.
  provenDeadJobIds: ReadonlySet<string>,
): Verdict {
  // Record a pending dispatch keyed on THIS task's `work::`/`approve::` verb
  // so the root-fallback doesn't ALSO synthesize a root occupant (the per-row
  // pass already holds the slot). Computed BEFORE the pipeline returns, so the
  // match is recorded even when a higher-rank verdict wins.
  const taskHasPending =
    pendingKeys.size > 0 &&
    (pendingKeys.has(`work::${task.task_id}`) ||
      pendingKeys.has(`approve::${task.task_id}`));
  if (taskHasPending) {
    if (pendingKeys.has(`work::${task.task_id}`)) {
      matchedPendingKeys.add(`work::${task.task_id}`);
    }
    if (pendingKeys.has(`approve::${task.task_id}`)) {
      matchedPendingKeys.add(`approve::${task.task_id}`);
    }
  }

  // 1. terminal-completed. `worker_phase === "done"` is the administrative
  // signal (keeper plan stamped `worker_done_at`), which can race ahead of the
  // Claude session's Stop/SessionEnd. The three liveness clauses below hold
  // the verdict at `running:*` (predicate 5/6/6.6) until the session is
  // genuinely idle, so `isLiveWorkOccupant` / `isRootOccupant` don't release
  // the mutexes while the worker is still alive (else the autopilot dispatches
  // a sibling into the same root before the prior worker winds down).
  //
  // Crash robustness: a main-job wedge is unblocked by the reducer's `Killed`
  // arm (exit-watcher-driven). A sub-agent that dies without SubagentStop has
  // no such backstop, so the `sub-agent-stale` verdict keeps occupying the
  // mutex by design — correctness over throughput, cleared by autopilot pause
  // + manual replay.
  if (
    isTaskTerminalCompleted(
      task,
      subRunningByJobId,
      epicsById,
      now,
      provenDeadJobIds,
    )
  ) {
    return { tag: "completed" };
  }

  // 1.5. epic-not-materialized. `epic.status === null` ⇔ no `EpicSnapshot` has
  // folded yet (the scaffold shell row). The EARLIEST blocked predicate (above
  // epic-not-validated) so a not-yet-materialized epic is non-dispatchable —
  // the same `status IS NOT NULL` notion the board's `default_visible` uses.
  if (epic.status == null) {
    return { tag: "blocked", reason: { kind: "epic-not-materialized" } };
  }

  // 2. epic-not-validated. The SOLE guard against dispatching into a
  // mid-plan / mid-refine epic: an epic reads `ready` the moment its plan is
  // validated (`last_validated_at` stamped), even while its planner/refiner
  // session is still running — a validated plan is committed-to, so a worker
  // may pick up a ready, dep-satisfied task concurrently with the planner.
  // Do NOT re-add a planner-busy serialization gate here.
  if (epic.last_validated_at == null) {
    return { tag: "blocked", reason: { kind: "epic-not-validated" } };
  }

  // 5. own-progress-main — embedded jobs[] state (verb implied by location:
  // task-level means verb `work`).
  if (anyEmbeddedJobWorking(task.jobs)) {
    return { tag: "running", reason: { kind: "job-running" } };
  }

  // 6. own-progress-sub — a `running` sub-agent under THIS row's worker
  // session blocks. Split on staleness: if EVERY surviving running sub-agent
  // is past `SUBAGENT_STALENESS_SEC`, render `sub-agent-stale` (a possibly-
  // stuck orphan); else `sub-agent-running`. Runs AFTER the reducer's bounded
  // Stop guard clears predicate 5, so this branch sees only survivors.
  if (anyEmbeddedJobHasRunningSubagent(task.jobs, subRunningByJobId)) {
    if (
      allRunningSubagentsAreStale(
        task.jobs,
        subRunningByJobId,
        now,
        SUBAGENT_STALENESS_SEC,
      )
    ) {
      return { tag: "running", reason: { kind: "sub-agent-stale" } };
    }
    return { tag: "running", reason: { kind: "sub-agent-running" } };
  }

  // 6.6. monitor-running / monitor-stale. A work session that backgrounded a
  // test suite then yielded its turn flips its embedded job to `stopped`
  // (predicates 5 and 6 cleared) while the suite is STILL RUNNING.
  // `has_live_worker_monitor` (true only for worker-launched `monitor`/
  // `bash-bg` monitors; `ambient` watchers never count) holds the per-epic AND
  // per-root mutex but is non-dispatchable, so the closer/approve can't
  // dispatch into a not-actually-idle session.
  //
  // The anchor is the embedded job's `updated_at` (re-stamped per agent
  // turn-end). Past `MONITOR_STALENESS_SEC` the canonical fact is unknown;
  // readiness conservatively renders `monitor-stale` and keeps the mutex hold.
  if (embeddedMonitorOccupies(task.jobs, now)) {
    if (allLiveMonitorsAreStale(task.jobs, now, MONITOR_STALENESS_SEC)) {
      return { tag: "running", reason: { kind: "monitor-stale" } };
    }
    return { tag: "running", reason: { kind: "monitor-running" } };
  }

  // 8. dep-on-task — any upstream NOT terminal-completed. Resolves the upstream
  // from `taskById` and tests its OWN completion (`isTaskTerminalCompleted`),
  // NOT its in-progress `perTask` verdict — so a forward `depends_on` (an
  // upstream with a HIGHER task_number, evaluated LATER in this pass) resolves
  // correctly instead of reading as not-yet-computed. An upstream absent from
  // `taskById` (cross-epic dep not yet folded, malformed id) counts as NOT
  // completed → blocks. Mirrors predicate 9's raw-state read for the same
  // board-sort-independence reason.
  for (const upstream of task.depends_on) {
    const upstreamTask = taskById.get(upstream);
    if (
      upstreamTask === undefined ||
      !isTaskTerminalCompleted(
        upstreamTask,
        subRunningByJobId,
        epicsById,
        now,
        provenDeadJobIds,
      )
    ) {
      return {
        tag: "blocked",
        reason: { kind: "dep-on-task", upstream },
      };
    }
  }

  // 9. dep-on-epic — task-side rollup of the parent epic's dep list, read off
  // `epic.resolved_epic_deps`. Each {@link ResolvedEpicDep}'s tri-state `state`:
  //   - `satisfied` — upstream status-done. Liveness-gated: a `satisfied`
  //     stamp means the upstream's status flipped done, but its closer may
  //     still be winding down. When the resolved upstream is IN-SNAPSHOT and
  //     still has live close-scope work (`epicHasLiveCloseScopeWork`), the
  //     dependent stays `blocked:dep-on-epic` with the same payload a
  //     `blocked-incomplete` upstream produces — done-AND-idle is the bar.
  //     EVERY satisfied entry is checked, not just the first. An ABSENT
  //     upstream (cross-project, out-of-snapshot, or null `resolved_epic_id`)
  //     keeps today's skip: only status settled it, no liveness to read.
  //   - `blocked-incomplete` — upstream resolved but NOT done. Emit
  //     `dep-on-epic` (amber) with the resolved upstream id + cross-project
  //     basename. Payload shape autopilot's consumer reads byte-for-byte.
  //   - `dangling` — no resolution. Emit `dep-on-epic-dangling` (red) with the
  //     raw `dep_token`.
  //
  // The reducer's `satisfied` stamp and `epic-deps.ts` resolution stay
  // status-only by the folds-never-probe-liveness invariant; the liveness gate
  // lives HERE, read-time, so a re-fold reproduces byte-identical projection
  // rows.
  //
  // `null` short-circuits — a fresh-row "not yet computed" state. The reducer
  // stamps the column in the same fold as the EpicSnapshot write, so
  // production reads always see `[]` or a populated array.
  if (epic.resolved_epic_deps !== null) {
    for (const dep of epic.resolved_epic_deps) {
      if (dep.state === "satisfied") {
        const upstream =
          dep.resolved_epic_id !== null
            ? epicsById.get(dep.resolved_epic_id)
            : undefined;
        if (
          upstream !== undefined &&
          epicHasLiveCloseScopeWork(upstream, subRunningByJobId, now)
        ) {
          return {
            tag: "blocked",
            reason: {
              kind: "dep-on-epic",
              upstream: dep.resolved_epic_id ?? dep.dep_token,
              cross_project: dep.cross_project ? dep.project_basename : null,
            },
          };
        }
        continue;
      }
      if (dep.state === "dangling") {
        return {
          tag: "blocked",
          reason: { kind: "dep-on-epic-dangling", upstream: dep.dep_token },
        };
      }
      // blocked-incomplete: reconstruct the readiness-side `cross_project:
      // string | null` from the projection's boolean + basename pair (the
      // basename prefixes the pill when cross-project, else `null`).
      return {
        tag: "blocked",
        reason: {
          kind: "dep-on-epic",
          upstream: dep.resolved_epic_id ?? dep.dep_token,
          cross_project: dep.cross_project ? dep.project_basename : null,
        },
      };
    }
  }

  // 10. dep-on-task-synthetic-close — not applicable to a real task.

  // 10.5. dispatch-pending — a worker LAUNCHED against this task (a `work::`
  // `pending_dispatches` row, per the `(plan|work|close)` whitelist) but whose
  // SessionStart hasn't folded, so no `jobs` row makes the slot visible. A
  // fork-seed row minted by an out-of-order UserPromptSubmit heals + discharges
  // when the SessionStart folds (see `projectJobsRow`). Set at this LATE rank — after
  // every real `running`, structural, and dep verdict (each still WINS so a
  // truer state isn't masked) but BEFORE the post-pass mutexes, so pass-1 of
  // both mutexes sees it as an occupant via `isLiveWorkOccupant`.
  // Non-dispatchable and self-resolving. The match was recorded at the top so
  // the root-fallback never double-counts it.
  if (taskHasPending) {
    return { tag: "blocked", reason: { kind: "dispatch-pending" } };
  }

  // 10.55. bound-pending — the post-bind continuation of dispatch-pending. The
  // SessionStart fold that binds a worker SEEDS a `state='stopped'`,
  // `plan_verb`-bearing `jobs` row AND DELETEs the `pending_dispatches` row in
  // ONE atomic transaction, so the instant 10.5 stops firing THIS predicate
  // takes over — closing the launch → bind → first-activity occupancy gap with
  // no fold change and no version-fence. The `active_since IS NULL` gate (see
  // `anyEmbeddedJobBoundPending`) keeps a stopped-after-working / dead worker
  // from over-holding the root. Ranked AFTER dispatch-pending (so a still-open
  // pending row's verdict wins when both somehow coexist) and BEFORE the
  // post-pass mutexes, so pass-1 of both mutexes sees it as an occupant via
  // `isLiveWorkOccupant`. Non-dispatchable, self-resolving (the first
  // UserPromptSubmit flips state → `working`, and pred-5 takes the hold).
  if (anyEmbeddedJobBoundPending(task.jobs)) {
    return { tag: "blocked", reason: { kind: "bound-pending" } };
  }

  // 10.6. runtime-blocked — keeper plan stamped `runtime_status="blocked"` (e.g. a
  // killed worker). Placed LAST, immediately before the `ready` fall-through, is
  // load-bearing: terminal-completed (1), every running verdict (3/5/6/6.6), and
  // dispatch-pending (10.5) still WIN above, so a `worker_phase="done"` task
  // still completes/reaps despite a stale blocked flag, a live worker's mutex is
  // not released, and a just-launched worker is not raced. This converts ONLY
  // the erroneous `ready`. `runtime_status` defaults `"todo"` and is never null,
  // so `=== "blocked"` is total and cannot throw; ONLY literal `"blocked"` is
  // nondispatchable (`todo`/`in_progress` fall through). `isLiveWorkOccupant`
  // excludes this kind, so a stuck task does NOT hold the per-task/root mutex.
  if (task.runtime_status === "blocked") {
    return { tag: "blocked", reason: { kind: "runtime-blocked" } };
  }

  // 11+12. single-task-per-epic / single-task-per-root — deferred to the
  // post-pass `applyPerRootRoundRobinAllocator` (N-slot round-robin; N=1 is the
  // legacy per-epic-then-per-root mutex byte-identical).

  return { tag: "ready" };
}

/**
 * Close-row verdict pipeline. Predicates 5 (own-progress-main) and 6
 * (own-progress-sub) pool TWO scopes:
 *   - EPIC-LEVEL: `epic.jobs` (close-verb embedded jobs) — the PRIMARY
 *     close-row source.
 *   - TASK-LEVEL: the `task.jobs` of every ALREADY-COMPLETED task — a backstop.
 *     The per-task predicate 1 now also checks worker liveness, so a
 *     `completed` task can no longer have a working job or running sub-agent,
 *     making this scan provably unreachable under current rules. Retained
 *     verbatim as a re-fold-determinism backstop against a future change that
 *     lets the two states coexist again.
 *
 * The verdict alone therefore carries no attribution: a running close row is
 * normally owned by an epic-level source. That matters for
 * `applySingleTaskPerRootMutex` — see its JSDoc for the scoped close-row claim
 * that re-derives epic-level running-ness so a purely task-derived running
 * close row doesn't phantom a `project_dir` lock that starves unrelated epics.
 */
function evaluateCloseRow(
  epic: Epic,
  // Unused — see `evaluateTask` (the live-jobs join was dropped).
  _jobs: Map<string, Job>,
  subRunningByJobId: Map<string, SubagentInvocation[]>,
  perTask: Map<string, Verdict>,
  // Unused: the sole reader was the deleted predicate 6.5. Kept for call-site
  // symmetry.
  _gitStatusByProjectDir: Map<
    string,
    { dirty_count: number; unattributed_to_live_count: number }
  >,
  now: number,
  // The canonical `verb::id` keys, and the matched-key set. The close-row arm
  // matches `close::<epic_id>`; a match records the key and sets the late-rank
  // `dispatch-pending` verdict below.
  pendingKeys: Set<string>,
  matchedPendingKeys: Set<string>,
  // Reverse index (SOURCE epic id → its blocking follow-up epic) built once per
  // pass in `computeReadiness`. Read O(1) by the close-followup predicate below;
  // the close row otherwise receives no cross-epic lookup.
  blockingFollowupBySource: Map<string, Epic>,
): Verdict {
  // Record a matched `close::<epic_id>` dispatch (before the pipeline returns)
  // so the root-fallback never double-synthesizes a root occupant for it.
  const closeHasPending =
    pendingKeys.size > 0 && pendingKeys.has(`close::${epic.epic_id}`);
  if (closeHasPending) {
    matchedPendingKeys.add(`close::${epic.epic_id}`);
  }

  // 1. terminal-completed (close-row variant). `epic.status==="done"` is the
  // administrative signal (keeper plan stamped the epic done), which can race ahead
  // of the closer agent and its sub-agents winding down. The three close-scope
  // liveness clauses hold the verdict off `completed` until the closer is
  // genuinely idle — a done-but-live close row falls through to predicate
  // 5/6/6.6's `running:*`, so `isLiveWorkOccupant`/`isRootOccupant` keep the
  // per-epic AND per-root mutexes held while the closer releases them, unblocks
  // its dep-on-epic dependents, and lets the completion reap fire against a
  // dead pane. The pooled CLOSE-scope booleans match predicates 5/6/6.6 exactly
  // (epic-level close jobs + the completed-task backstop), so the guard and the
  // fall-through agree on scope; the stale-split helpers stay out of this gate.
  //
  // Crash robustness: a never-idle closer rides the existing backstops — the
  // exit-watcher `Killed` arm (main close job), the monitor release ceiling,
  // and the sub-agent-stale pill + autopilot pause/manual replay. No TTL escape
  // hatch here, deliberately: correctness over throughput, mirroring the task
  // path.
  if (
    epic.status === "done" &&
    !anyEmbeddedJobWorking(epic.jobs) &&
    !closeRowHasRunningSubagent(epic, perTask, subRunningByJobId) &&
    !closeRowMonitorOccupies(epic, perTask, now)
  ) {
    return { tag: "completed" };
  }

  // 1.5. epic-not-materialized. `epic.status === null` ⇔ no `EpicSnapshot` has
  // folded yet. The EARLIEST blocked predicate so the autopilot refuses to
  // dispatch a CLOSER against a not-yet-materialized epic — mirror of the
  // per-task gate and the board's `default_visible` predicate.
  if (epic.status == null) {
    return { tag: "blocked", reason: { kind: "epic-not-materialized" } };
  }

  // 2. epic-not-validated. The SOLE guard against dispatching a CLOSER into a
  // mid-plan / mid-refine epic — see the per-task predicate 2 note. Once the
  // plan is validated the close row reads through, even while the planner is
  // still running. Do NOT re-add a planner-busy serialization gate here.
  if (epic.last_validated_at == null) {
    return { tag: "blocked", reason: { kind: "epic-not-validated" } };
  }

  // 5. own-progress-main — block on a running worker at EITHER scope:
  // epic-level (close-verb) embedded jobs (primary), OR a task-level
  // (work-verb) job on an ALREADY-COMPLETED task (backstop, provably
  // unreachable after the per-task liveness guard but retained for re-fold
  // determinism).
  //
  // A not-yet-completed (in-flight) task is deliberately EXCLUDED: predicate
  // 10 blocks the close row on it with the accurate `dep-on-task` reason, and
  // fanning its running-ness here would mislabel a dependency-blocked close as
  // `running:job-running`.
  if (anyEmbeddedJobWorking(epic.jobs)) {
    return { tag: "running", reason: { kind: "job-running" } };
  }
  // Normally unreachable; retained as a re-fold-determinism backstop.
  for (const task of epic.tasks) {
    if (
      perTask.get(task.task_id)?.tag === "completed" &&
      anyEmbeddedJobWorking(task.jobs)
    ) {
      return { tag: "running", reason: { kind: "job-running" } };
    }
  }

  // 6. own-progress-sub — a running sub-agent under a worker bound to this
  // epic. PRIMARY: a close-verb at epic level. BACKSTOP: a work-verb on an
  // ALREADY-COMPLETED task (provably unreachable, `completed`-scoped in the
  // helpers for re-fold determinism). A not-yet-completed task is excluded and
  // falls through to predicate 10's `dep-on-task`.
  //
  // Same stale split as the task path: `sub-agent-stale` iff EVERY surviving
  // running sub-agent across the pooled scopes is past `SUBAGENT_STALENESS_SEC`;
  // a single fresh sub-agent anywhere keeps the close row at
  // `sub-agent-running`.
  if (closeRowHasRunningSubagent(epic, perTask, subRunningByJobId)) {
    if (
      allCloseRowRunningSubagentsAreStale(epic, perTask, subRunningByJobId, now)
    ) {
      return { tag: "running", reason: { kind: "sub-agent-stale" } };
    }
    return { tag: "running", reason: { kind: "sub-agent-running" } };
  }

  // 6.6. monitor-running / monitor-stale — close-row twin of the task-path
  // predicate. Holds the close row at `running:monitor-*` while a live
  // worker-launched monitor occupies any pooled scope (epic-level close-verb
  // jobs, or a completed task's work jobs), so the closer/approve cannot
  // dispatch into a not-actually-idle session. Same soft/hard lease as the
  // task path, shared via `closeRowMonitorOccupies` → `embeddedMonitorOccupies`.
  if (closeRowMonitorOccupies(epic, perTask, now)) {
    if (allCloseRowMonitorsAreStale(epic, perTask, now)) {
      return { tag: "running", reason: { kind: "monitor-stale" } };
    }
    return { tag: "running", reason: { kind: "monitor-running" } };
  }

  // 8/9. dep-on-task / dep-on-epic — not applicable to the close row: it has
  // no direct deps, predicate 10 synthesizes task deps from the epic's tasks,
  // and a downstream epic's dep-on-THIS-epic is enforced on the DOWNSTREAM's
  // task path (evaluateTask predicate 9), where the live-aware gate reads this
  // epic's raw close-scope liveness via `epicHasLiveCloseScopeWork`.

  // 9.5. epic-no-tasks — the epic has ZERO tasks, so predicate 10's loop is
  // vacuously true and the close row would fall through to `ready` and
  // dispatch a closer against an epic with no work (a partial-projection
  // window: an `EpicSnapshot` folds before its first `TaskSnapshot`).
  // DELIBERATELY ranked LATE so every more-specific verdict above still wins;
  // it catches EXACTLY the vacuous fall-through.
  if (epic.tasks.length === 0) {
    return { tag: "blocked", reason: { kind: "epic-no-tasks" } };
  }

  // 10. dep-on-task-synthetic-close — every real task in the epic must be
  // completed. Reason carries the first non-completed task id in
  // traversal (pre-sorted tasks) order.
  for (const task of epic.tasks) {
    const v = perTask.get(task.task_id);
    if (v === undefined || v.tag !== "completed") {
      return {
        tag: "blocked",
        reason: { kind: "dep-on-task", upstream: task.task_id },
      };
    }
  }

  // 10.4. close-followup — the blocking-follow-up close gate (docs/adr/0028).
  // When some epic points its `blocks_closing_of` at THIS epic (a blocking
  // follow-up the close audit minted to correct a consumer-observable flaw),
  // the source's close is held OPEN until that follow-up lands, so no dependent
  // builds on the flaw. RANKED after all-tasks-complete (predicate 10) — the
  // source's own tasks are all done here, so the close would otherwise read
  // `ready` — and before dispatch-pending. The release bar is the SAME
  // done-AND-idle liveness the dep-on-epic predicate uses: the follow-up must
  // be `status==="done"` AND carry no live close-scope work
  // (`epicHasLiveCloseScopeWork`), so a re-dispatched closer only adopts the
  // source once the follow-up is genuinely settled. A follow-up itself gated by
  // its OWN follow-up is simply not-done — the wait nests naturally, no special
  // case. When no epic points at this source (a deleted follow-up), the index
  // has no entry and the row un-blocks; downstream escalation of a deleted
  // follow-up is the saga verb's job, not readiness's. The reason is
  // informational and NON-occupying (out of `isLiveWorkOccupant`), so a healthy
  // wait neither holds the per-root mutex nor blocks reaps.
  const followup = blockingFollowupBySource.get(epic.epic_id);
  if (
    followup !== undefined &&
    !(
      followup.status === "done" &&
      !epicHasLiveCloseScopeWork(followup, subRunningByJobId, now)
    )
  ) {
    return {
      tag: "blocked",
      reason: { kind: "close-followup", followup: followup.epic_id },
    };
  }

  // 10.5. dispatch-pending — close-row twin. A `close::<epic_id>` worker was
  // LAUNCHED but its SessionStart hasn't folded. Set at this LATE rank (after
  // the close row's own verdicts, before the post-pass mutexes) so it occupies
  // BOTH mutexes while the launch → SessionStart window is open.
  // Non-dispatchable and self-resolving; the match was recorded at the top.
  if (closeHasPending) {
    return { tag: "blocked", reason: { kind: "dispatch-pending" } };
  }

  // 10.55. bound-pending — close-row twin of the task-path predicate. A
  // `close::<epic_id>` closer that BOUND (its SessionStart seeded a
  // `state='stopped'`, `plan_verb='close'` epic-level `jobs` row and DELETEd the
  // `pending_dispatches` row in the SAME atomic fold) but is not yet ACTIVE
  // (`active_since IS NULL`) holds BOTH mutexes through the bind →
  // first-activity window. Same `active_since` over-hold guard as the task path,
  // ranked AFTER dispatch-pending and BEFORE the post-pass mutexes so it
  // occupies via `isLiveWorkOccupant`.
  if (anyEmbeddedJobBoundPending(epic.jobs)) {
    return { tag: "blocked", reason: { kind: "bound-pending" } };
  }

  // 11+12. single-task-per-epic / single-task-per-root — deferred to the
  // post-pass `applyPerRootRoundRobinAllocator` (N-slot round-robin; N=1 is the
  // legacy per-epic-then-per-root mutex byte-identical).

  return { tag: "ready" };
}

// ---------------------------------------------------------------------------
// Post-pass mutexes
// ---------------------------------------------------------------------------

/**
 * "Live work" predicate. A row whose verdict claims a mutex slot in pass-1
 * regardless of iteration order — the states where dispatching another job to
 * the same scope would land two live workers on one target.
 *
 * Occupants:
 *   - every `running` verdict (job-running, sub-agent-running,
 *     sub-agent-stale, monitor-running, monitor-stale);
 *   - `dispatch-pending` — a worker LAUNCHED but whose SessionStart hasn't
 *     folded (an open `pending_dispatches` row). No `jobs` row exists in the
 *     launch → SessionStart blind window, so this is the ONLY signal the slot
 *     is taken; holding the mutex demotes a same-epic OR same-root ready
 *     sibling. Non-dispatchable, self-resolving. Per-EPIC AND per-root (no
 *     planner exemption — a pending dispatch is a real launched worker holding
 *     a working tree).
 *
 * Excluded: dependency blocks, admin blocks, mutex-synthesized blocks, and
 * `unknown` — none represent a live worker that would conflict with a
 * freshly-dispatched sibling.
 *
 * Both the per-EPIC and per-ROOT mutexes key on this predicate (`isRootOccupant`
 * is a passthrough), so a live worker occupies both scopes identically.
 */
function isLiveWorkOccupant(verdict: Verdict): boolean {
  return (
    verdict.tag === "running" ||
    // The TWO blocked-but-occupying signals span the unbroken occupancy hold
    // from dispatch-decision through first-confirmed-activity:
    //   - `dispatch-pending`: a launched-but-not-yet-bound worker holding the
    //     mutex through the launch → SessionStart blind window (open
    //     `pending_dispatches` row, no `jobs` row yet).
    //   - `bound-pending`: a BOUND-but-not-yet-active worker (its SessionStart
    //     folded a `state='stopped'`, `plan_verb`-bearing `jobs` row and DELETEd
    //     the `pending_dispatches` row in the SAME atomic fold). Without it the
    //     root frees the instant the worker binds — the launch-window leak where
    //     a same-root sibling co-dispatches before first activity flips the row
    //     to `working`.
    // Every snapshot shows EITHER kind or a `running` verdict — never a gap.
    (verdict.tag === "blocked" &&
      (verdict.reason.kind === "dispatch-pending" ||
        verdict.reason.kind === "bound-pending"))
  );
}

/**
 * Per-root occupancy predicate. A passthrough to `isLiveWorkOccupant` — the
 * per-root mutex and the autopilot cap (`autopilot-worker.ts` counts occupants
 * with this predicate) treat any live worker / `dispatch-pending` row as a root
 * occupant identically to the per-epic mutex. Kept as a distinct exported
 * symbol so the two call sites read intent-clearly and a future divergence has
 * a seam.
 */
export function isRootOccupant(verdict: Verdict): boolean {
  return isLiveWorkOccupant(verdict);
}

export function applySingleTaskPerEpicMutex(
  epicsArr: Epic[],
  perTask: Map<string, Verdict>,
): void {
  for (const epic of epicsArr) {
    // Pass 1: any "live work" verdict (running/queued worker activity)
    // claims the epic slot regardless of iteration order relative to
    // ready siblings. Dependency-style blocks (dep-on-task, etc.) do
    // NOT claim — they represent waiting, not concurrent work.
    let occupied = false;
    for (const task of epic.tasks) {
      const verdict = perTask.get(task.task_id);
      if (verdict === undefined) {
        continue;
      }
      if (isLiveWorkOccupant(verdict)) {
        occupied = true;
        break;
      }
    }

    // Pass 2: walk ready rows. If the slot is already claimed by Pass 1,
    // every ready row is demoted. Otherwise, the first ready row wins
    // and later ready rows are demoted (preserving prior behavior).
    for (const task of epic.tasks) {
      const verdict = perTask.get(task.task_id);
      if (verdict === undefined || verdict.tag !== "ready") {
        continue;
      }
      if (!occupied) {
        occupied = true;
        continue;
      }
      perTask.set(task.task_id, {
        tag: "blocked",
        reason: { kind: "single-task-per-epic" },
      });
    }
  }
}

/**
 * Per-root mutex (predicate 12). Two-pass walk over every per-row verdict in
 * board traversal order. Keys on the effective root `task.target_repo ??
 * epic.project_dir` (BOTH null AND empty fall through — mirroring the
 * reconciler's resolver in `scripts/autopilot.ts` exactly).
 *
 * Pass 1 — root-occupant claim: any verdict satisfying `isRootOccupant` claims
 * its effective root regardless of iteration order. Planners are root-exempt
 * (a sibling epic's ready task may dispatch concurrently); the per-EPIC mutex
 * still blocks the planner's OWN epic. The per-task pass-1 is the primary lock
 * path — the per-task liveness guard already shows a still-alive contributing
 * task here as a root occupant, so no close-row fan-in is needed.
 *
 * Close-row scoped attribution: a running close-row verdict can be INHERITED
 * from a task-level worker in a different `target_repo` (`evaluateCloseRow`
 * pools `epic.jobs` AND every `task.jobs`). An unconditional `project_dir`
 * claim would be redundant when same-root and harmful when cross-root (a
 * phantom lock that starves unrelated epics). The claim is therefore gated on
 * an EPIC-LEVEL non-planner source being live (`epicLevelRunning`), OR — for a
 * `close::<epic_id>` launched-but-not-bound closer — the `dispatch-pending`
 * close kind, strictly scoped to `effectiveRoot(null, projectDir)` so the
 * epic's OWN root is held without the cross-root phantom lock. Planner-running
 * never reaches this gate (the outer `isRootOccupant` guard filters it).
 *
 * Pass 2 — ready tiebreak: if the root is already claimed, every `ready` row
 * on it is demoted to `single-task-per-root`; else the FIRST ready row per
 * root wins and every LATER one is demoted.
 *
 * Exported so the test suite can drive it with a hand-rolled verdict map.
 */
export function applySingleTaskPerRootMutex(
  epicsArr: Epic[],
  perTask: Map<string, Verdict>,
  perCloseRow: Map<string, Verdict>,
  subRunningByJobId: Map<string, SubagentInvocation[]> = new Map(),
  // Root-fallback: roots claimed by an open `pending_dispatches` row whose
  // `verb::id` matched NO task or close row (launch→materialize lag or deleted
  // target). Seeded into `occupiedRoots` BEFORE pass-1 so a sibling ready task
  // on the same root is demoted even though the dispatched target has no row to
  // carry a per-row `dispatch-pending` verdict. Each entry is a non-empty `dir`
  // (null/empty dropped by the caller). Default empty for callers that don't
  // model launch-window occupancy.
  fallbackRoots: Set<string> = new Set(),
  // Autopilot `armed`-mode eligibility for the discretionary pass-2 tiebreak.
  // ABSENT (`undefined`) selects the legacy single-pass (yolo / tests /
  // simulator). PROVIDED (even EMPTY) selects the two-pass split: pass-2a
  // awards a free root to an eligible epic's ready task BEFORE any ineligible
  // sibling, pass-2b lets ineligible rows take the leftovers. The discriminator
  // is `!== undefined`, NEVER `.size === 0` — an empty set means "armed but
  // nothing armed" and must suppress every TASK row, not fall back to yolo.
  // In armed mode a `ready` close row's root-claim is gated on eligibility (it
  // mirrors the launcher's close gate so an ineligible closer can't starve an
  // eligible same-root task); an in-flight closer is preserved by pass-1's
  // eligibility-blind occupancy claim. Yolo (`undefined`) keeps close rows
  // eligibility-blind.
  eligibleEpicIds?: Set<string>,
  // The worktree-mode lane re-key (task_id / epic_id → lane path). When a
  // row's id is present the mutex keys on its lane path, not `effectiveRoot` —
  // each worktree is a CAP-1 lane and parallel sibling lanes (distinct paths) run
  // concurrently. Empty (the default) = today's `effectiveRoot` keying, byte-
  // identical. See {@link rootKeyForRow}.
  laneKeyById: ReadonlyMap<string, string> = new Map(),
): void {
  // Seed the root-fallback occupants first — a pending dispatch with no
  // matching snapshot row still holds its `dir` root.
  const occupiedRoots = new Set<string>(fallbackRoots);

  // Pass 1: every root-occupant verdict (task OR close row) claims its root
  // regardless of iteration order. See `isRootOccupant` — only real worker
  // activity counts; planners are root-exempt and dependency /
  // mutex-synthesized blocks don't claim.
  for (const epic of epicsArr) {
    const projectDir = stringOrNull(epic.project_dir);

    for (const task of epic.tasks) {
      const verdict = perTask.get(task.task_id);
      if (verdict === undefined || !isRootOccupant(verdict)) {
        continue;
      }
      const root = rootKeyForRow(
        task.task_id,
        stringOrNull(task.target_repo),
        projectDir,
        laneKeyById,
      );
      occupiedRoots.add(root);
    }

    // Close-row claim is scoped: fires when at least one EPIC-LEVEL non-planner
    // source is live. See the JSDoc above — a purely task-derived running close
    // row leaves the `project_dir` claim to the contributing task's own pass-1
    // entry, and a purely planner-derived close row is filtered out by the
    // outer `isRootOccupant` guard.
    const closeVerdict = perCloseRow.get(epic.epic_id);
    if (closeVerdict !== undefined && isRootOccupant(closeVerdict)) {
      const epicLevelRunning =
        anyEmbeddedJobWorking(epic.jobs) ||
        anyEmbeddedJobHasRunningSubagent(epic.jobs, subRunningByJobId);
      // A `close::<epic_id>` closer LAUNCHED but not yet bound renders
      // `dispatch-pending` with NO live epic-level job (`epicLevelRunning`
      // false). The launch-window occupancy is the epic's OWN project_dir fact,
      // so hold the epic's own root, strictly scoped to
      // `effectiveRoot(null, projectDir)` (the no-cross-root-phantom-lock
      // narrowing).
      const closeRowDispatchPending =
        closeVerdict.tag === "blocked" &&
        closeVerdict.reason.kind === "dispatch-pending";
      if (epicLevelRunning || closeRowDispatchPending) {
        const root = rootKeyForRow(epic.epic_id, null, projectDir, laneKeyById);
        occupiedRoots.add(root);
      }
    }
  }

  // Demote a ready task to `single-task-per-root` (extracted so the legacy
  // single-pass and the two-pass share one mutation site).
  const demoteTask = (taskId: string): void => {
    perTask.set(taskId, {
      tag: "blocked",
      reason: { kind: "single-task-per-root" },
    });
  };

  // Settle one ready TASK row against `occupiedRoots`: claim the (still-free)
  // root or demote. Shared by every pass-2 walk.
  const settleTask = (task: Task, projectDir: string | null): void => {
    const verdict = perTask.get(task.task_id);
    if (verdict === undefined || verdict.tag !== "ready") {
      return;
    }
    const root = rootKeyForRow(
      task.task_id,
      stringOrNull(task.target_repo),
      projectDir,
      laneKeyById,
    );
    if (!occupiedRoots.has(root)) {
      occupiedRoots.add(root);
      return;
    }
    demoteTask(task.task_id);
  };

  // Settle the synthetic CLOSE row against `occupiedRoots`. Close uses the
  // epic's project_dir directly (no per-row `target_repo`).
  //
  // Armed-mode eligibility gate (`eligibleEpicIds !== undefined`): a `ready`
  // close row may CLAIM a free root only if its epic is in the eligible closure.
  // This mirrors the launcher's close-dispatch gate in `autopilot-worker.ts`
  // (the `armedMode && !eligible?.has(epicId) && !isEpicInFlight(...)` close
  // suppression) so the mutex never reserves a root for a closer the
  // launcher will REFUSE to launch — the bug being fixed, where an ineligible
  // unarmed close row claimed a shared root and starved an eligible same-root
  // armed task to `single-task-per-root`.
  //
  // The launcher's "OR in-flight" disjunct needs no mirror HERE: an in-flight
  // closer (live close job, or launched-but-unbound) renders `running:*` /
  // `blocked:dispatch-pending`, NOT `ready`, and is claimed by PASS-1's
  // eligibility-blind `isRootOccupant` path — so the disarmed-mid-flight closer
  // is preserved. A `ready` close verdict provably means no in-flight closer
  // (predicates 5/6/6.6/10.5 all fell through), so eligibility alone decides.
  //
  // YOLO (`eligibleEpicIds === undefined`) stays mode-EXEMPT — the close row is
  // eligibility-blind and a finalizer is never starved (yolo launches closers).
  const settleCloseRow = (epic: Epic, projectDir: string | null): void => {
    const closeVerdict = perCloseRow.get(epic.epic_id);
    if (closeVerdict === undefined || closeVerdict.tag !== "ready") {
      return;
    }
    const root = rootKeyForRow(epic.epic_id, null, projectDir, laneKeyById);
    // Armed mode: an ineligible close row neither claims the root nor demotes —
    // it leaves the root free for an eligible same-root task and is itself left
    // `ready` (the launcher's close gate suppresses the actual launch).
    if (eligibleEpicIds !== undefined && !eligibleEpicIds.has(epic.epic_id)) {
      return;
    }
    if (!occupiedRoots.has(root)) {
      occupiedRoots.add(root);
    } else {
      perCloseRow.set(epic.epic_id, {
        tag: "blocked",
        reason: { kind: "single-task-per-root" },
      });
    }
  };

  if (eligibleEpicIds === undefined) {
    // Pass 2 (legacy single-pass — yolo / tests / simulator): first ready row
    // per root wins the still-unclaimed slot; subsequent ready rows demote.
    for (const epic of epicsArr) {
      const projectDir = stringOrNull(epic.project_dir);
      for (const task of epic.tasks) {
        settleTask(task, projectDir);
      }
      settleCloseRow(epic, projectDir);
    }
    return;
  }

  // Pass 2 — eligible-priority two-pass (armed mode). Pass-1's `occupiedRoots`
  // seed is shared with the single-pass; only the discretionary ready tiebreak
  // becomes eligibility-aware, so an eligible task never preempts a live worker.
  //
  // Pass-2a (priority): for each ELIGIBLE epic, settle its ready TASK rows so
  // they claim free roots before any ineligible sibling. Settle every ready
  // CLOSE row too, but `settleCloseRow` gates the root-claim on eligibility (an
  // ineligible close row neither claims nor demotes — mirroring the launcher's
  // close-dispatch gate so it can't starve an eligible same-root task). An
  // eligible epic's own closer still beats its same-root eligible task when it
  // sorts first.
  for (const epic of epicsArr) {
    const projectDir = stringOrNull(epic.project_dir);
    if (eligibleEpicIds.has(epic.epic_id)) {
      for (const task of epic.tasks) {
        settleTask(task, projectDir);
      }
    }
    settleCloseRow(epic, projectDir);
  }

  // Pass-2b (residual): walk epics again; for INELIGIBLE epics settle their
  // ready TASK rows — they claim a root only if it's STILL unclaimed after
  // every eligible task + every close row took theirs, else demote. Close rows
  // are already settled in 2a; eligible epics' tasks are already settled in 2a.
  for (const epic of epicsArr) {
    if (eligibleEpicIds.has(epic.epic_id)) {
      continue;
    }
    const projectDir = stringOrNull(epic.project_dir);
    for (const task of epic.tasks) {
      settleTask(task, projectDir);
    }
  }
}

/**
 * Per-root N-slot round-robin allocator (predicates 11+12). The SINGLE
 * post-pass `computeReadiness` runs — it SUPERSEDES the two independent mutexes
 * (`applySingleTaskPerEpicMutex` + `applySingleTaskPerRootMutex`, kept exported
 * for their direct unit tests). `maxConcurrentPerRoot` (N, threaded from
 * `autopilot_state.max_concurrent_per_root ?? 1`) is how many tasks may dispatch
 * concurrently into ONE root, distributed fairly across the root's epics:
 *
 *   - **N === 1 is byte-identical to today** — it delegates verbatim to the two
 *     legacy passes (per-epic FIRST so its tighter scope owns the reason, then
 *     per-root over the same maps). The N=1-equivalence contract is satisfied by
 *     construction: the exact same code runs.
 *   - **N > 1 fills via round-robin.** Per root: seed a per-root occupancy
 *     counter AND a per-(root,epic) counter from in-flight work (`isRootOccupant`
 *     tasks + the scoped close-row claim + `fallbackRoots`), then fill the
 *     remaining `N − occupied` slots round-robin over the root's epics in
 *     `orderEpicsForScheduling` seam order. An epic stacks a 2nd ready task ONLY
 *     after every sibling epic on the root with ready work has its first (the
 *     fill always grants to the epic currently holding the FEWEST tasks on the
 *     root; ties break by seam order). A lone epic takes every free slot.
 *
 * Demotion reason by CAUSE (kinds kept): an epic that received a grant or was
 * already occupied loses its extras to `single-task-per-epic` (its fair share);
 * an epic that got ZERO slots because the root saturated first loses to
 * `single-task-per-root`. At N=1 this reduces to today's per-epic-first
 * attribution.
 *
 * The armed two-pass + close-row eligibility gate carry through
 * BOTH paths: pass-1 physical occupancy is eligibility-blind; in armed mode an
 * eligible epic's ready rows claim free slots before any ineligible sibling, and
 * an ineligible `ready` close row neither claims nor demotes (mirroring the
 * launcher's close gate). Pure + deterministic: no cross-tick cursor, `epic_id`
 * final tiebreak via the seam order. Caps compose under the global
 * `maxConcurrentJobs` budget as an absolute ceiling (demoted rows never reach
 * it). Exported so the test suite can drive N>1 directly.
 *
 * Worktree mode (`laneKeyById` non-empty): first serializes each lane at cap-1
 * (two agents in one worktree index = corruption), then applies the stored
 * per-root cap across the rows' true roots. Parallel sibling lanes may share one
 * epic, so the per-epic mutex is not part of the worktree-mode path.
 */
export function applyPerRootRoundRobinAllocator(
  epicsArr: Epic[],
  perTask: Map<string, Verdict>,
  perCloseRow: Map<string, Verdict>,
  subRunningByJobId: Map<string, SubagentInvocation[]> = new Map(),
  fallbackRoots: Set<string> = new Set(),
  maxConcurrentPerRoot = 1,
  eligibleEpicIds?: Set<string>,
  // The worktree-mode lane re-key (task_id / epic_id → lane path). See
  // {@link rootKeyForRow} + the worktree-mode note above.
  laneKeyById: ReadonlyMap<string, string> = new Map(),
): void {
  const worktreeMode = laneKeyById.size > 0;
  if (worktreeMode) {
    applySingleTaskPerRootMutex(
      epicsArr,
      perTask,
      perCloseRow,
      subRunningByJobId,
      fallbackRoots,
      eligibleEpicIds,
      laneKeyById,
    );
    if (maxConcurrentPerRoot <= 1) {
      applySingleTaskPerRootMutex(
        epicsArr,
        perTask,
        perCloseRow,
        subRunningByJobId,
        fallbackRoots,
        eligibleEpicIds,
      );
      return;
    }
  }

  // N=1 (or any degenerate ≤1 from a misconfig — the config validation guards
  // ≥1, but stay total) is the legacy two-pass verbatim: byte-identical demotions
  // + reason attribution + armed two-pass + close-row gate. This IS the
  // equivalence guarantee — the same code path the prior mutex tests pin.
  if (maxConcurrentPerRoot <= 1) {
    applySingleTaskPerEpicMutex(epicsArr, perTask);
    applySingleTaskPerRootMutex(
      epicsArr,
      perTask,
      perCloseRow,
      subRunningByJobId,
      fallbackRoots,
      eligibleEpicIds,
    );
    return;
  }

  // ---- N > 1: per-root round-robin fill ----

  // Pass 1 — seed occupancy. `rootOccupied` counts every in-flight slot already
  // consumed on a root; `epicHeld` counts how many a given (root, epic) holds, so
  // the fair-share fill grants to the epic holding the FEWEST. A pending dispatch
  // with no matching row (`fallbackRoots`) consumes a root slot but no epic's.
  const rootOccupied = new Map<string, number>();
  const epicHeld = new Map<string, number>(); // key: `${root} ${epicId}`
  const bumpRoot = (root: string): void => {
    rootOccupied.set(root, (rootOccupied.get(root) ?? 0) + 1);
  };
  const epicKey = (root: string, epicId: string): string => `${root} ${epicId}`;
  const bumpEpic = (root: string, epicId: string): void => {
    const k = epicKey(root, epicId);
    epicHeld.set(k, (epicHeld.get(k) ?? 0) + 1);
  };
  for (const root of fallbackRoots) {
    bumpRoot(root);
  }
  for (const epic of epicsArr) {
    const projectDir = stringOrNull(epic.project_dir);
    for (const task of epic.tasks) {
      const verdict = perTask.get(task.task_id);
      if (verdict === undefined || !isRootOccupant(verdict)) {
        continue;
      }
      const root = effectiveRoot(stringOrNull(task.target_repo), projectDir);
      bumpRoot(root);
      bumpEpic(root, epic.epic_id);
    }
    // Close-row occupancy claim — IDENTICAL gate to the legacy per-root mutex's
    // pass-1 (epic-level non-planner source live, OR a launched-but-unbound
    // closer), scoped to the epic's own `effectiveRoot(null, projectDir)`. A
    // running closer is a root-level consumption only (no per-row epic bucket —
    // the per-epic fair share is task-derived).
    const closeVerdict = perCloseRow.get(epic.epic_id);
    if (closeVerdict !== undefined && isRootOccupant(closeVerdict)) {
      const epicLevelRunning =
        anyEmbeddedJobWorking(epic.jobs) ||
        anyEmbeddedJobHasRunningSubagent(epic.jobs, subRunningByJobId);
      const closeRowDispatchPending =
        closeVerdict.tag === "blocked" &&
        closeVerdict.reason.kind === "dispatch-pending";
      if (epicLevelRunning || closeRowDispatchPending) {
        bumpRoot(effectiveRoot(null, projectDir));
      }
    }
  }

  // Pass 2 — fill the remaining slots. The slot ledger decrements as grants land.
  const remaining = new Map<string, number>();
  const slotsLeft = (root: string): number => {
    let r = remaining.get(root);
    if (r === undefined) {
      r = Math.max(0, maxConcurrentPerRoot - (rootOccupied.get(root) ?? 0));
      remaining.set(root, r);
    }
    return r;
  };
  const consumeSlot = (root: string): void => {
    remaining.set(root, slotsLeft(root) - 1);
  };

  // Per-(root) ready-task queues, each keyed by epic so the round-robin can grant
  // to the least-loaded epic. A `granted` tally per (root, epic) drives the
  // per-task keep/demote split after the fill. Built in seam order so the
  // round-robin walk and the tiebreak are deterministic.
  const ordered = orderEpicsForScheduling(epicsArr);
  type EpicQueue = {
    epic: Epic;
    root: string;
    ready: Task[]; // ready tasks on THIS root, traversal order
    granted: number;
  };
  // root → ordered list of per-epic queues (seam order). An epic spanning two
  // roots contributes one queue per root.
  const queuesByRoot = new Map<string, EpicQueue[]>();
  const queueOf = new Map<string, EpicQueue>(); // `${root} ${epicId}`
  for (const epic of ordered) {
    const projectDir = stringOrNull(epic.project_dir);
    for (const task of epic.tasks) {
      const verdict = perTask.get(task.task_id);
      if (verdict === undefined || verdict.tag !== "ready") {
        continue;
      }
      const root = effectiveRoot(stringOrNull(task.target_repo), projectDir);
      const k = epicKey(root, epic.epic_id);
      let q = queueOf.get(k);
      if (q === undefined) {
        q = { epic, root, ready: [], granted: 0 };
        queueOf.set(k, q);
        const list = queuesByRoot.get(root);
        if (list === undefined) {
          queuesByRoot.set(root, [q]);
        } else {
          list.push(q);
        }
      }
      q.ready.push(task);
    }
  }

  // Demote helpers (kinds kept).
  const demotePerEpic = (taskId: string): void => {
    perTask.set(taskId, {
      tag: "blocked",
      reason: { kind: "single-task-per-epic" },
    });
  };
  const demotePerRoot = (taskId: string): void => {
    perTask.set(taskId, {
      tag: "blocked",
      reason: { kind: "single-task-per-root" },
    });
  };

  // Round-robin the queues on ONE root: repeatedly grant to the epic holding the
  // FEWEST tasks (seeded + granted) with an ungranted ready task, tie → seam
  // order (queues are pre-sorted), until the root's slots run dry or no queue has
  // ungranted work. `eligibleFilter` restricts which queues may be granted this
  // sweep (armed pass-2a = eligible only; pass-2b / yolo = all).
  const fillRoot = (
    root: string,
    queues: EpicQueue[],
    eligibleFilter: ((epicId: string) => boolean) | null,
  ): void => {
    for (;;) {
      if (slotsLeft(root) <= 0) {
        return;
      }
      let best: EpicQueue | undefined;
      let bestHeld = Number.POSITIVE_INFINITY;
      for (const q of queues) {
        if (q.granted >= q.ready.length) {
          continue; // every ready task already granted
        }
        if (eligibleFilter !== null && !eligibleFilter(q.epic.epic_id)) {
          continue;
        }
        const held =
          (epicHeld.get(epicKey(root, q.epic.epic_id)) ?? 0) + q.granted;
        // Strict `<` keeps the seam order as the tiebreak (queues are ordered, so
        // the first-seen minimum wins).
        if (held < bestHeld) {
          bestHeld = held;
          best = q;
        }
      }
      if (best === undefined) {
        return; // no grantable queue under this filter
      }
      best.granted += 1;
      consumeSlot(root);
    }
  };

  // Settle one epic's ready CLOSE row against the root slot ledger — same
  // eligibility gate as the legacy `settleCloseRow`: in armed mode an ineligible
  // ready close neither claims nor demotes; otherwise it consumes a slot when one
  // is free, else demotes to `single-task-per-root`. Consumes BEFORE the task
  // fill for its root so an eligible epic's own closer still beats its same-root
  // task (the legacy "close sorts with its epic" ordering).
  const settleCloseRow = (epic: Epic): void => {
    const closeVerdict = perCloseRow.get(epic.epic_id);
    if (closeVerdict === undefined || closeVerdict.tag !== "ready") {
      return;
    }
    if (eligibleEpicIds !== undefined && !eligibleEpicIds.has(epic.epic_id)) {
      return;
    }
    const root = effectiveRoot(null, stringOrNull(epic.project_dir));
    if (slotsLeft(root) > 0) {
      consumeSlot(root);
    } else {
      perCloseRow.set(epic.epic_id, {
        tag: "blocked",
        reason: { kind: "single-task-per-root" },
      });
    }
  };

  // Close rows first (in seam order) — a ready closer is a finalizer that should
  // claim its slot ahead of the discretionary task fill, mirroring the legacy
  // interleave where a close row settles right after its epic's tasks but BEFORE
  // later roots. Settling all closers up front is equivalent for slot accounting
  // and keeps the eligibility gate identical.
  for (const epic of ordered) {
    settleCloseRow(epic);
  }

  // Task fill. Armed mode (`eligibleEpicIds !== undefined`): pass-2a fills
  // eligible epics on every root FIRST, then pass-2b fills the residual with
  // ineligible epics — so an eligible epic claims a free slot before any
  // ineligible sibling. Yolo (`undefined`): one unfiltered sweep per root.
  if (eligibleEpicIds !== undefined) {
    const isEligible = (epicId: string): boolean => eligibleEpicIds.has(epicId);
    for (const [root, queues] of queuesByRoot) {
      fillRoot(root, queues, isEligible);
    }
    for (const [root, queues] of queuesByRoot) {
      fillRoot(root, queues, null);
    }
  } else {
    for (const [root, queues] of queuesByRoot) {
      fillRoot(root, queues, null);
    }
  }

  // Apply: per epic-queue, the first `granted` ready tasks stay `ready`; the rest
  // demote. Reason by cause — an epic that received a grant OR was already
  // occupied (`epicHeld > 0`) loses its extras to `single-task-per-epic` (its
  // fair share); an epic that got NOTHING because the root saturated first loses
  // to `single-task-per-root`.
  for (const queues of queuesByRoot.values()) {
    for (const q of queues) {
      const seeded = epicHeld.get(epicKey(q.root, q.epic.epic_id)) ?? 0;
      const hadRepresentation = q.granted > 0 || seeded > 0;
      // The first `granted` ready tasks keep their slot; demote the rest.
      for (const task of q.ready.slice(q.granted)) {
        if (hadRepresentation) {
          demotePerEpic(task.task_id);
        } else {
          demotePerRoot(task.task_id);
        }
      }
    }
  }
}

/**
 * Single-root key. `target_repo` wins when non-null AND non-empty; else fall
 * through to `project_dir`. Both null/empty produces `""` — the "unknown root"
 * bucket, which collapses every rootless row into one per-root slot.
 *
 * MUST mirror the reconciler's per-row root resolver in
 * `src/autopilot-worker.ts` exactly.
 */
function effectiveRoot(
  targetRepo: string | null,
  projectDir: string | null,
): string {
  if (targetRepo != null && targetRepo !== "") {
    return targetRepo;
  }
  return projectDir ?? "";
}

/**
 * The per-row ALLOCATOR key. In worktree mode the producer supplies a
 * `rowId → lane-worktree-path` map (`laneKeyById`); a row whose id is present
 * keys on its lane path (each worktree a CAP-1 lane), so two parallel sibling
 * lanes — even within ONE epic — are DISTINCT lane keys for the later root-cap
 * fill, while two tasks targeting the SAME lane serialize. A row with NO lane entry
 * (OFF mode, a row outside any worktree plan, every test/simulator caller that
 * passes the empty default) falls through to today's `effectiveRoot`, BYTE-FOR-
 * BYTE unchanged. `rowId` is the `task_id` for a task row, the `epic_id` for the
 * close row (whose lane is always the epic BASE). The gate (`computeReadiness`)
 * and the dispatch-side resolver build this map off the SAME `deriveWorktreePlan`,
 * so they never diverge.
 *
 * A worktree-DISABLED epic (see `WorktreeRepoResolution.disabled`) is a third
 * shape: the producer maps EVERY task id + the epic id to the BARE resolved
 * toplevel (one shared key, NOT per-lane paths), so all its rows collapse to ONE
 * cap-1 mutex key and serialize on the shared checkout before the root-cap fill,
 * so same-toplevel rows of a disabled repo can NEVER parallelize into one shared
 * checkout. The keys are opaque strings; this function needs no special case for
 * them.
 */
function rootKeyForRow(
  rowId: string,
  targetRepo: string | null,
  projectDir: string | null,
  laneKeyById: ReadonlyMap<string, string>,
): string {
  const lane = laneKeyById.get(rowId);
  if (lane !== undefined && lane !== "") {
    return lane;
  }
  return effectiveRoot(targetRepo, projectDir);
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

// ---------------------------------------------------------------------------
// Epic header rollup
// ---------------------------------------------------------------------------

function rollupEpicHeader(
  epic: Epic,
  perTask: Map<string, Verdict>,
  perCloseRow: Map<string, Verdict>,
): Verdict {
  const closeVerdict = perCloseRow.get(epic.epic_id);

  // `[completed]` iff close-row is completed.
  if (closeVerdict !== undefined && closeVerdict.tag === "completed") {
    return { tag: "completed" };
  }

  // `[ready]` iff any task or close-row is ready.
  for (const task of epic.tasks) {
    const v = perTask.get(task.task_id);
    if (v !== undefined && v.tag === "ready") {
      return { tag: "ready" };
    }
  }
  if (closeVerdict !== undefined && closeVerdict.tag === "ready") {
    return { tag: "ready" };
  }

  // `[running]` iff any task or close-row is running — priority slots
  // between `ready` and `blocked`. Reason is the first running row's
  // reason in traversal order (pre-sorted tasks then close row).
  for (const task of epic.tasks) {
    const v = perTask.get(task.task_id);
    if (v !== undefined && v.tag === "running") {
      return { tag: "running", reason: v.reason };
    }
  }
  if (closeVerdict !== undefined && closeVerdict.tag === "running") {
    return { tag: "running", reason: closeVerdict.reason };
  }

  // Otherwise blocked — reason is the first non-completed row in traversal
  // order (pre-sorted tasks then close row).
  for (const task of epic.tasks) {
    const v = perTask.get(task.task_id);
    if (v === undefined) {
      return { tag: "blocked", reason: { kind: "unknown" } };
    }
    if (v.tag === "completed") {
      continue;
    }
    if (v.tag === "blocked") {
      return { tag: "blocked", reason: v.reason };
    }
    // Defensive: ready / running slipped past the early-returns — re-emit.
    return v;
  }

  if (closeVerdict === undefined) {
    return { tag: "blocked", reason: { kind: "unknown" } };
  }
  if (closeVerdict.tag === "blocked") {
    return { tag: "blocked", reason: closeVerdict.reason };
  }
  // Close-row is "ready" / "running" / "completed" — all caught above.
  // Defensive fall-through.
  return closeVerdict;
}

// ---------------------------------------------------------------------------
// Predicate helpers
// ---------------------------------------------------------------------------

/**
 * Drop the embedded jobs whose owning session the daemon has PROVEN dead
 * (recorded pid re-proved gone — `provenDeadJobIds`) so the terminal-completed
 * gate reads subagent / monitor liveness off ONLY the jobs that are NOT proven
 * dead. An EMPTY set (the board / autoclose / test / simulator default) returns
 * the input reference unchanged — byte-identical to the plain gate, and the
 * downstream predicates already null-tolerate. Pure; never mutates the input.
 */
function excludeProvenDeadJobs<T extends { job_id: string }>(
  embedded: T[] | undefined,
  provenDeadJobIds: ReadonlySet<string>,
): T[] | undefined {
  if (embedded === undefined || provenDeadJobIds.size === 0) {
    return embedded;
  }
  return embedded.filter((job) => !provenDeadJobIds.has(job.job_id));
}

function anyEmbeddedJobWorking(
  embedded: { state: string; updated_at?: number }[] | undefined,
): boolean {
  if (embedded === undefined) {
    return false;
  }
  for (const job of embedded) {
    const activity = deriveHarnessActivity({ parent: job });
    if (activity.status === "active" && activity.reason === "main-turn") {
      return true;
    }
  }
  return false;
}

/**
 * Predicate 10.55 helper — a FRESHLY-BOUND but not-yet-active worker. True iff
 * an embedded job is `state='stopped'`, carries a real `plan_verb` (the
 * spawn-name dispatch correlator the `(plan|work|close)` whitelist sets), AND
 * has never been active (`active_since` is null/absent — the reducer stamps it
 * on the first `stopped → working` un-stop edge, then re-stamps it on each
 * subsequent edge; null/absent therefore means no un-stop edge has fired yet).
 *
 * This is the post-bind half of the unbroken occupancy hold: the SessionStart
 * fold that mints this row DELETEs the worker's `pending_dispatches` row in the
 * SAME atomic transaction, so the moment the `dispatch-pending` signal vanishes,
 * THIS one appears — no gap. The `active_since` gate is the disambiguator: a
 * worker that ran then stopped (or was killed) has a non-null `active_since`, so
 * it does NOT over-hold the root; only a never-yet-active bound worker occupies.
 *
 * Distinct from `anyEmbeddedJobWorking` (pred-5) so pred-5's verdict semantics
 * are untouched — a `stopped` job is never `working`, so the two never overlap.
 */
function anyEmbeddedJobBoundPending(
  embedded:
    | { state: string; plan_verb: string; active_since?: number | null }[]
    | undefined,
): boolean {
  if (embedded === undefined) {
    return false;
  }
  for (const job of embedded) {
    if (
      job.state === "stopped" &&
      job.plan_verb !== "" &&
      job.active_since == null
    ) {
      return true;
    }
  }
  return false;
}

function anyEmbeddedJobHasRunningSubagent(
  embedded:
    | { job_id: string; state?: string; updated_at?: number }[]
    | undefined,
  subRunningByJobId: Map<string, SubagentInvocation[]>,
): boolean {
  if (embedded === undefined) {
    return false;
  }
  for (const job of embedded) {
    const activity = deriveHarnessActivity({
      parent: job,
      children: subRunningByJobId.get(job.job_id),
    });
    if (
      (activity.status === "active" && activity.reason === "open-child") ||
      (activity.status === "unknown" &&
        (activity.reason === "child-evidence-incomplete" ||
          activity.reason === "child-evidence-stale"))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Predicate 6 staleness companion to {@link anyEmbeddedJobHasRunningSubagent}.
 * Returns `true` iff EVERY surviving `running` sub-agent has `now - inv.updated_at >
 * threshold`. Vacuous-truth on no running sub-agents — callers MUST gate on
 * {@link anyEmbeddedJobHasRunningSubagent} first. Strict `>` so the boundary
 * tick doesn't flip the pill. "Every" not "any": a single fresh sub-agent
 * keeps the verdict at `sub-agent-running`.
 */
function allRunningSubagentsAreStale(
  embedded: { job_id: string }[] | undefined,
  subRunningByJobId: Map<string, SubagentInvocation[]>,
  now: number,
  threshold: number,
): boolean {
  if (embedded === undefined) {
    return false;
  }
  for (const job of embedded) {
    const hits = subRunningByJobId.get(job.job_id);
    if (hits === undefined) {
      continue;
    }
    for (const inv of hits) {
      if (!isOpenTurnRow(inv)) {
        continue;
      }
      if (now - inv.updated_at <= threshold) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Soft-TTL staleness helper for embedded live-monitor facts. Returns
 * `true` iff EVERY live-monitor job has `now - updated_at > threshold`. A single
 * fresh job keeps the verdict at `monitor-running` (same "every, not any"
 * discipline as {@link allRunningSubagentsAreStale}). Vacuous-truth otherwise —
 * callers MUST gate on {@link anyEmbeddedJobHasLiveMonitor} first. Strict `>`.
 * Read-time, never folded.
 */
function allLiveMonitorsAreStale(
  embedded:
    | { has_live_worker_monitor?: boolean; updated_at: number }[]
    | undefined,
  now: number,
  threshold: number,
): boolean {
  if (embedded === undefined) {
    return false;
  }
  for (const job of embedded) {
    if (job.has_live_worker_monitor !== true) {
      continue;
    }
    if (now - job.updated_at <= threshold) {
      return false;
    }
  }
  return true;
}

/**
 * The occupancy policy for worker-resource Harness activity. Both active and
 * unknown resource evidence hold readiness; only quiescent evidence releases.
 * Predicate 1 and predicate 6.6 share this helper so completion and the running
 * verdict move on the same positive boundary.
 */
function embeddedMonitorOccupies(
  embedded:
    | {
        state: string;
        has_live_worker_monitor?: boolean;
        updated_at: number;
      }[]
    | undefined,
  now: number,
): boolean {
  if (embedded === undefined) {
    return false;
  }
  for (const job of embedded) {
    const activity = deriveHarnessActivity({ parent: job, now });
    if (
      (activity.status === "active" && activity.reason === "worker-resource") ||
      (activity.status === "unknown" &&
        (activity.reason === "resource-evidence-incomplete" ||
          activity.reason === "resource-evidence-stale"))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The per-job rolled-up liveness verdict for the `keeper dash` AGENTS region —
 * the SAME precedence the board pill applies, computed uniformly for a single
 * top-level {@link Job} (plan-linked or ad-hoc). Returns `null` for an idle
 * job (no live worker / sub-agent / monitor) so the caller renders the
 * `stopped` glyph; otherwise a `running:*` {@link Verdict}.
 *
 * Precedence mirrors the board:
 *   1. job `state === 'working'`            → `running:job-running`
 *   2. else a running sub-agent on this job → `running:sub-agent-running`,
 *      or `running:sub-agent-stale` once EVERY surviving running sub-agent is
 *      past {@link SUBAGENT_STALENESS_SEC}.
 *   3. else a live worker-launched monitor  → `running:monitor-running`,
 *      or `running:monitor-stale` once it is past {@link MONITOR_STALENESS_SEC}.
 *   4. else                                  → `null` (idle).
 *
 * The worker-monitor fact is derived from the job's raw `monitors` JSON via the
 * shared {@link hasLiveWorkerMonitor} deriver (worker-launched `monitor`/
 * `bash-bg` only; `ambient` excluded), the SAME bytes `buildEmbeddedJob` reads
 * — so the AGENTS glyph cannot drift from the board pill. The single job is
 * wrapped as a one-element embedded-like array so the existing module-private
 * predicates' LOGIC is reused verbatim, not reimplemented.
 *
 * Read-side: NEVER throws — a malformed `monitors` cell folds to "no monitor"
 * (the deriver's own contract), never an exception mid-frame.
 *
 * `now` is the frame's reference seconds (the dash's `nowSec`); the staleness
 * splits read it, never `Date.now()`.
 */
export function rolledUpJobVerdict(
  job: Job,
  subRunningByJobId: Map<string, SubagentInvocation[]>,
  now: number,
): Verdict | null {
  const activity = deriveHarnessActivity({
    parent: job,
    children: subRunningByJobId.get(job.job_id),
    now,
  });
  if (activity.status === "active") {
    if (activity.reason === "main-turn") {
      return { tag: "running", reason: { kind: "job-running" } };
    }
    if (activity.reason === "open-child") {
      return { tag: "running", reason: { kind: "sub-agent-running" } };
    }
    return { tag: "running", reason: { kind: "monitor-running" } };
  }
  if (activity.status === "unknown") {
    if (
      activity.reason === "child-evidence-incomplete" ||
      activity.reason === "child-evidence-stale"
    ) {
      return { tag: "running", reason: { kind: "sub-agent-stale" } };
    }
    if (
      activity.reason === "resource-evidence-incomplete" ||
      activity.reason === "resource-evidence-stale"
    ) {
      return { tag: "running", reason: { kind: "monitor-stale" } };
    }
  }
  return null;
}

/**
 * Close-row variant of {@link anyEmbeddedJobHasRunningSubagent}, pooling the
 * epic-level jobs AND every ALREADY-COMPLETED task-level jobs sub-array.
 * Returns `true` iff at least one running sub-agent is present in any scope.
 * The task-level branch is normally unreachable (the per-task liveness guard
 * prevents a `completed` task from carrying a running sub-agent) but retained
 * as a re-fold-determinism backstop. The task scan is `completed`-scoped for
 * the same reason as predicate 5's main scan — a not-yet-completed task is
 * already blocked-on by predicate 10's `dep-on-task`.
 */
function closeRowHasRunningSubagent(
  epic: Epic,
  perTask: Map<string, Verdict>,
  subRunningByJobId: Map<string, SubagentInvocation[]>,
): boolean {
  if (anyEmbeddedJobHasRunningSubagent(epic.jobs, subRunningByJobId)) {
    return true;
  }
  for (const task of epic.tasks) {
    if (perTask.get(task.task_id)?.tag !== "completed") {
      continue;
    }
    if (anyEmbeddedJobHasRunningSubagent(task.jobs, subRunningByJobId)) {
      return true;
    }
  }
  return false;
}

/**
 * Close-row variant of {@link allRunningSubagentsAreStale}, pooling every
 * contributing scope (epic-level close jobs + every ALREADY-COMPLETED task's
 * work jobs). Returns `true` iff EVERY surviving running sub-agent is past
 * `SUBAGENT_STALENESS_SEC`. Callers MUST gate on `closeRowHasRunningSubagent`
 * first. `completed`-scoped to mirror that helper exactly.
 */
function allCloseRowRunningSubagentsAreStale(
  epic: Epic,
  perTask: Map<string, Verdict>,
  subRunningByJobId: Map<string, SubagentInvocation[]>,
  now: number,
): boolean {
  if (
    !allRunningSubagentsAreStale(
      epic.jobs,
      subRunningByJobId,
      now,
      SUBAGENT_STALENESS_SEC,
    )
  ) {
    return false;
  }
  for (const task of epic.tasks) {
    if (perTask.get(task.task_id)?.tag !== "completed") {
      continue;
    }
    if (
      !allRunningSubagentsAreStale(
        task.jobs,
        subRunningByJobId,
        now,
        SUBAGENT_STALENESS_SEC,
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Close-row variant of {@link embeddedMonitorOccupies}, pooling every
 * contributing scope (epic-level close jobs + every ALREADY-COMPLETED task's
 * work jobs). Returns `true` iff SOME job carries active or unknown worker
 * resource evidence. `completed`-scoped to
 * mirror the sub-agent twin. The completed-task scan is normally unreachable
 * (the per-task predicates hold such a task at `running:monitor-*`); the
 * PRIMARY value is the epic-level close-verb monitor case. Retained as a
 * re-fold-determinism backstop.
 */
function closeRowMonitorOccupies(
  epic: Epic,
  perTask: Map<string, Verdict>,
  now: number,
): boolean {
  if (embeddedMonitorOccupies(epic.jobs, now)) {
    return true;
  }
  for (const task of epic.tasks) {
    if (perTask.get(task.task_id)?.tag !== "completed") {
      continue;
    }
    if (embeddedMonitorOccupies(task.jobs, now)) {
      return true;
    }
  }
  return false;
}

/**
 * Close-row variant of {@link allLiveMonitorsAreStale}, pooling every
 * contributing scope. Returns `true` iff EVERY live monitor is past
 * `MONITOR_STALENESS_SEC`. Callers MUST gate on {@link closeRowMonitorOccupies}
 * first. Same `completed`-scoped task scan as that helper.
 */
function allCloseRowMonitorsAreStale(
  epic: Epic,
  perTask: Map<string, Verdict>,
  now: number,
): boolean {
  if (!allLiveMonitorsAreStale(epic.jobs, now, MONITOR_STALENESS_SEC)) {
    return false;
  }
  for (const task of epic.tasks) {
    if (perTask.get(task.task_id)?.tag !== "completed") {
      continue;
    }
    if (!allLiveMonitorsAreStale(task.jobs, now, MONITOR_STALENESS_SEC)) {
      return false;
    }
  }
  return true;
}

/**
 * Order-independent close-scope liveness pooler for predicate 9's `satisfied`
 * gate. Returns `true` iff the upstream — already status-done, so this is the
 * closer winding down — still carries ANY live close-scope work: an
 * epic-level OR task-level embedded job `working`, ANY running sub-agent under
 * those jobs, or ANY active/unknown worker resource evidence.
 *
 * DELIBERATELY pools RAW epic state across `epic.jobs` AND every `task.jobs`
 * unconditionally — NOT gated on `perTask` completed tags and NOT reading
 * `perCloseRow`. A forward-referenced upstream (a consumer epic sorts earlier
 * in `epicsArr`) has no verdicts computed yet; gating on them would make the
 * answer depend on board sort order and silently fall back to satisfied for
 * exactly that subset. For a done upstream, a live job ANYWHERE is wind-down
 * and must hold the dependent.
 */
function epicHasLiveCloseScopeWork(
  upstream: Epic,
  subRunningByJobId: Map<string, SubagentInvocation[]>,
  now: number,
): boolean {
  if (
    anyEmbeddedJobWorking(upstream.jobs) ||
    anyEmbeddedJobHasRunningSubagent(upstream.jobs, subRunningByJobId) ||
    embeddedMonitorOccupies(upstream.jobs, now)
  ) {
    return true;
  }
  for (const task of upstream.tasks) {
    if (
      anyEmbeddedJobWorking(task.jobs) ||
      anyEmbeddedJobHasRunningSubagent(task.jobs, subRunningByJobId) ||
      embeddedMonitorOccupies(task.jobs, now)
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Format helper
// ---------------------------------------------------------------------------

/**
 * Render the bracket pill for a verdict — `[ready]`, `[completed]`,
 * `[running:<kind>]`, or `[blocked:<reason>]`. String concerns isolated
 * here so the predicate pipeline never touches strings.
 */
export function formatPill(verdict: Verdict): string {
  if (verdict.tag === "ready") {
    return "[ready]";
  }
  if (verdict.tag === "completed") {
    return "[completed]";
  }
  if (verdict.tag === "running") {
    return `[running:${verdict.reason.kind}]`;
  }
  return `[blocked:${formatReasonShort(verdict.reason)}]`;
}

/**
 * The short form rendered inside the bracket pill. The `default` arm narrows
 * `reason` to `never` — a future `BlockReason` variant that forgets a case
 * here is a compile-time error, not a silent `unknown` fallback.
 */
function formatReasonShort(reason: BlockReason): string {
  switch (reason.kind) {
    case "job-rejected":
      return "job-rejected";
    case "job-pending":
      return "job-pending";
    case "epic-not-materialized":
      return "epic-not-materialized";
    case "epic-not-validated":
      return "epic-not-validated";
    case "git-uncommitted":
      return "git-uncommitted";
    case "git-orphans":
      return "git-orphans";
    case "dep-on-task":
      return `dep-on-task ${reason.upstream}`;
    case "dep-on-epic":
      // The `cross_project` payload carries the upstream's project basename
      // when it differs from the consumer's; prefix the id with `<project>::`.
      // Intra-project deps (`cross_project == null`) keep the bare-id render.
      return reason.cross_project === null
        ? `dep-on-epic ${reason.upstream}`
        : `dep-on-epic ${reason.cross_project}::${reason.upstream}`;
    case "dep-on-epic-dangling":
      return `dep-on-epic-dangling ${reason.upstream}`;
    case "single-task-per-epic":
      return "single-task-per-epic";
    case "single-task-per-root":
      return "single-task-per-root";
    case "epic-no-tasks":
      return "epic-no-tasks";
    case "close-followup":
      // Names the gating follow-up so the board reads `blocked:close-followup
      // <followup-id>` — legible like `dep-on-task <id>`.
      return `close-followup ${reason.followup}`;
    case "dispatch-pending":
      return "dispatch-pending";
    case "bound-pending":
      return "bound-pending";
    case "runtime-blocked":
      return "runtime-blocked";
    case "unknown":
      return "unknown";
    default: {
      // Exhaustiveness guard — a new BlockReason variant without a case above
      // surfaces here as a compile-time error instead of a silent `unknown`.
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

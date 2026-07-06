/**
 * Pure-function predicates for `keeper await` (fn-647).
 *
 * Mirrors `src/readiness.ts`'s ethos: no I/O, no `Date.now()`,
 * fixture-testable. The shipping command (`keeper await complete <id>`,
 * `keeper await unblocked <id>`) computes a board-scoped
 * {@link ReadinessSnapshot} via `subscribeReadiness`, then feeds that snapshot
 * plus the target id + condition into {@link evaluateAwaitCondition} and acts
 * on the discriminated {@link AwaitState} it returns. All scope-exempt
 * re-queries, prior-presence tracking, and the deleted-vs-complete
 * disambiguation live in the command — this module is a pure function of its
 * inputs.
 *
 * Acceptance carve-outs from fn-647 epic spec:
 *
 *   - "Unblocked" deliberately EXCLUDES autopilot's concurrency
 *     serialization. A task held back only by `single-task-per-epic` /
 *     `single-task-per-root` is considered workable — those two block
 *     reasons fire purely because some sibling is in flight, not because
 *     the row itself has anything wrong with it. Every OTHER `blocked`
 *     kind (deps, approval, validation, git, dangling-dep, rejection)
 *     still blocks. The {@link workable} predicate reads correctly off
 *     the POST-mutation snapshot: predicates 11/12 in `computeReadiness`
 *     bake those exact reason kinds in BEFORE the snapshot is handed
 *     out, so a single read off `perTask` / `perCloseRow` is the
 *     authoritative answer.
 *
 *   - "Epic-unblocked" must be computed from `perTask` + `perCloseRow`,
 *     NEVER from the `perEpic` rollup. The rollup picks one verdict per
 *     epic via `rollupEpicHeader`, which can hide a mutex-demoted-but-
 *     workable task under a more-severe sibling state (e.g. an epic
 *     whose only `ready` task got demoted to `blocked:single-task-per-
 *     epic` rolls up as `blocked:single-task-per-epic` even though the
 *     demoted row is workable per our carve-out). The per-row maps are
 *     the honest source.
 *
 *   - "Stuck" covers the two block reasons that need human action
 *     before they can ever flip: `job-rejected` (approval=rejected,
 *     terminal until reset) and `dep-on-epic-dangling` (depends_on_epics
 *     points at an upstream that no longer resolves). All other blocked
 *     kinds resolve themselves when the world moves; only these two are
 *     human-only-recoverable.
 *
 *   - "Not-found vs deleted" is split across the module and the command.
 *     This module reports `not-found` when the target is absent from the
 *     supplied board-scoped inputs. The command tracks prior-presence
 *     across its subscribe stream and, on a present-then-absent
 *     transition, runs a scope-exempt re-query against the daemon to
 *     disambiguate: re-query hit AND the target dropped off the
 *     default-visible board (a keeper plan epic terminalizes as
 *     `status=='done'` — there is no `closed` status) → completed; miss
 *     → `deleted`. This module exposes a `priorPresence` input so the
 *     command can express that decision through the pure surface
 *     without the module doing I/O.
 *
 * Discriminated state shapes (`AwaitState`):
 *
 *   - `met`        — terminal positive; the condition the caller asked
 *                    about is satisfied for the target id. Command exits 0.
 *   - `waiting`    — the condition is not yet met but the target is
 *                    present on the board and there's no blocker that
 *                    rules it out. Command keeps the subscription open.
 *   - `not-found`  — the target is absent from board scope AND was not
 *                    previously present in the subscribe stream. Command
 *                    exits 1 with `reason=not-found`.
 *   - `deleted`    — the target was previously present in the subscribe
 *                    stream but is now absent and the scope-exempt
 *                    re-query MISSED. Command exits 4.
 *   - `stuck`      — target verdict is `blocked` with a human-only-
 *                    recoverable reason kind. Command exits 5 only under
 *                    `--fail-on-stuck` (otherwise treated as `waiting`).
 *
 * `met` for `complete` reads the readiness `completed` verdict (fn-1015) —
 * done-AND-idle, not the administrative pop-off signal that can fire before the
 * worker winds down. A task is complete when `perTask[id].tag === "completed"`
 * (`worker_phase === "done"` AND the session idle); an epic is complete when its
 * close-row `perCloseRow[epic_id].tag === "completed"` (`status === "done"` AND
 * the closer idle), reachable on the present branch because the await-complete
 * path opts the recently-done epics into the observed scope. An epic that has
 * aged past that window (or was deleted) lands on the absent branch, where the
 * command's scope-exempt re-query splits complete (re-query hit) from deleted.
 */

import type { MonitorEntry } from "./derivers";
import {
  MERGE_ESCALATION_REASON_TOKEN,
  WORKTREE_FINALIZE_NON_FF_REASON,
  WORKTREE_RECOVER_REASON_PREFIX,
} from "./dispatch-failure-key";
import type { BlockReason, ReadinessSnapshot, Verdict } from "./readiness";
import type { Epic, GitStatus, Job, Task } from "./types";

// ---------------------------------------------------------------------------
// Target id classification
// ---------------------------------------------------------------------------

/**
 * The two awaitable target shapes. `task` ids carry a trailing `.<digits>`
 * segment (e.g. `fn-643-foo.4`); everything else is treated as an epic id.
 * The `fn-N` bare form is accepted for epics — see {@link classifyTargetId}'s
 * full-vs-bare branch.
 */
export type TargetKind = "epic" | "task";

/**
 * The plan-board condition families — each takes exactly one plan id
 * (`fn-N-slug` epic or `fn-N-slug.M` task). Distinguished from
 * {@link GitJobCondition} (which take NO id and read git/jobs rows
 * directly) so the grammar's per-condition arity is type-driven.
 *
 * `complete` is the end-bookend; `started` is the symmetric start-bookend —
 * a monotonic "work has begun at least once" milestone, NOT the liveness
 * `running` verdict (which flaps between turns and is reconnect-sensitive).
 */
export type PlanCondition = "complete" | "unblocked" | "started";

/**
 * The two non-plan condition families (fn-713). Neither carries a
 * plan id — `git-clean` reads the cwd's `git_status` row, `agents-idle`
 * reads the `jobs` rows. Evaluated by {@link gitCleanState} /
 * {@link agentsIdleState}, NOT {@link evaluateAwaitCondition}.
 */
export type GitJobCondition = "git-clean" | "agents-idle";

/** Every awaitable condition family. */
export type AwaitCondition = PlanCondition | GitJobCondition;

/**
 * Discriminator the command hands to {@link evaluateAwaitCondition}. The
 * `kind` field decides which projection arm the predicate reads off; the
 * `condition` selects between the "complete" and "unblocked" semantics
 * defined in the module docblock. Only the plan families carry an
 * {@link AwaitTarget}; `git-clean` / `agents-idle` use the dedicated
 * predicates and need no id/kind.
 */
export interface AwaitTarget {
  id: string;
  kind: TargetKind;
  condition: PlanCondition;
}

/**
 * Decide whether `id` names a task or an epic by shape. Mirrors the regex
 * shape used by `scripts/approve.ts:174` (task: `^(.+)\.\d+$`) and
 * `cli/board.ts:891` (`taskNumFromId`: `/\.(\d+)$/`) — a trailing `.<digits>`
 * segment names a task; anything else (including the bare `fn-N` form) is
 * an epic. Exported so the command can pre-tag the id without re-deriving
 * the regex.
 *
 * Returns `null` for the empty string only — every other non-empty input
 * resolves to either `"task"` (trailing-digits suffix present) or `"epic"`
 * (everything else). The command treats `null` as a usage error.
 */
export function classifyTargetId(id: string): TargetKind | null {
  if (id.length === 0) {
    return null;
  }
  return /\.\d+$/.test(id) ? "task" : "epic";
}

// ---------------------------------------------------------------------------
// Workable predicate (the concurrency carve-out)
// ---------------------------------------------------------------------------

/**
 * The `unblocked` predicate's load-bearing carve-out: a verdict is
 * "workable" iff the row is genuinely actionable RIGHT NOW or is being
 * held back ONLY by autopilot's concurrency mutexes. Two block reason
 * kinds qualify — `single-task-per-epic` (sibling task in the same epic
 * is in flight) and `single-task-per-root` (some task in a sibling epic
 * under the same project root is in flight). Both fire purely because
 * another row in the same scope is occupying the mutex slot, not because
 * the row itself has anything wrong with it.
 *
 * Every other `blocked` kind — including `epic-not-validated`,
 * `git-uncommitted`, `git-orphans`, `dep-on-task`, `dep-on-epic`,
 * `dep-on-epic-dangling`, `job-pending`, `job-rejected`,
 * `dispatch-pending`, `bound-pending`, `unknown` — is NOT workable. `running`
 * verdicts are never workable (the row is already in motion). `completed` is
 * the terminal positive for `complete` checks and is also not workable (it's
 * done, not "available to start").
 *
 * fn-721 / fn-924 note: `dispatch-pending` AND its post-bind twin
 * `bound-pending` on the DISPATCHED row are NOT workable — a worker has already
 * been launched against it (the row is effectively in motion: `dispatch-pending`
 * before the SessionStart bind, `bound-pending` after the bind but before first
 * activity), so each self-resolves and is `waiting`, NOT actionable. Its DEMOTED
 * siblings, however, render
 * `single-task-per-*` (the occupant claimed their mutex slot), so they
 * KEEP their workable status — the await semantics for "held back only by
 * the concurrency mutex" are unchanged.
 *
 * Reads correctly off the post-mutation snapshot per the doc invariant:
 * predicates 11 / 12 in `computeReadiness` (`applySingleTaskPerEpicMutex`
 * + `applySingleTaskPerRootMutex`) bake those exact reason kinds in
 * before the snapshot is handed out, so a single map lookup is the
 * authoritative answer — no second pass over the input epics required.
 */
export function workable(v: Verdict): boolean {
  if (v.tag === "ready") {
    return true;
  }
  if (v.tag === "blocked") {
    const k = v.reason.kind;
    return k === "single-task-per-epic" || k === "single-task-per-root";
  }
  return false;
}

// ---------------------------------------------------------------------------
// Stuck predicate
// ---------------------------------------------------------------------------

/**
 * The two `BlockReason` kinds that need explicit human action to ever
 * resolve — terminal-blocker semantics. {@link evaluateAwaitCondition}
 * returns `stuck` only when the target verdict is `blocked` AND its
 * reason kind is in this set; the command surfaces that as exit 5 under
 * `--fail-on-stuck` and as plain `waiting` otherwise.
 *
 * `job-rejected` fires when `approval === "rejected"` on the row itself
 * (or, for the epic close-row, on the parent epic). It is terminal
 * until the human flips approval back to `pending`/`approved`.
 *
 * `dep-on-epic-dangling` fires when an upstream epic in `depends_on_epics`
 * resolves to no known epic (full-id miss, bare-id miss, or bare-id
 * ambiguity with no same-project disambiguator). Resolution is reducer-
 * fold-time off the schema-v34 `resolved_epic_deps` projection — the
 * human has to either land the missing upstream or remove the dep.
 *
 * fn-721: `dispatch-pending` is deliberately NOT in this set — it
 * SELF-RESOLVES (the `pending_dispatches` row discharges on the worker's
 * SessionStart bind, or on DispatchFailed / DispatchExpired), so it is
 * plain `waiting`, never `stuck`. No human action is required.
 *
 * `runtime-blocked` fires when keeper plan stamped the task `runtime_status="blocked"`
 * (e.g. a killed worker). It does NOT self-resolve — the human (or a manual
 * replay) has to clear the blocked flag — so it is terminal-blocker semantics.
 */
const STUCK_REASON_KINDS: ReadonlySet<BlockReason["kind"]> = new Set([
  "job-rejected",
  "dep-on-epic-dangling",
  "runtime-blocked",
]);

function isStuck(v: Verdict): boolean {
  return v.tag === "blocked" && STUCK_REASON_KINDS.has(v.reason.kind);
}

/**
 * fn-941: the escalated-but-paused softening. A `runtime-blocked` task whose
 * `block_escalations` latch is present (a planner has been / is being notified)
 * is NOT a terminal stall while the autopilot is PAUSED — the planner is in the
 * loop and the cold re-dispatch that resumes the task simply can't fire until
 * play resumes. Reporting it as `waiting` (escalation in flight) keeps an armed
 * `--fail-on-stuck` await visibly HOLDING instead of surrendering exit-5 on a
 * stall that will clear once the autopilot un-pauses.
 *
 * Gate is narrow and conjunctive: ONLY a `runtime-blocked` verdict (the stamped
 * block kind the daemon escalates), ONLY when the task id carries a latch row,
 * ONLY when the autopilot is paused. An UNPAUSED escalated block is left to its
 * normal verdict — the cold re-dispatch can fire, so it self-resolves and does
 * not need the softening. A non-escalated `runtime-blocked` stays `stuck`.
 */
function escalationSoftensStuck(
  v: Verdict,
  taskId: string,
  escalatedTaskIds: ReadonlySet<string> | undefined,
  autopilotPaused: boolean | undefined,
): boolean {
  return (
    autopilotPaused === true &&
    v.tag === "blocked" &&
    v.reason.kind === "runtime-blocked" &&
    escalatedTaskIds !== undefined &&
    escalatedTaskIds.has(taskId)
  );
}

// ---------------------------------------------------------------------------
// AwaitState
// ---------------------------------------------------------------------------

/**
 * Discriminated result returned by {@link evaluateAwaitCondition}. The
 * `detail` field is an optional human-readable string the command may
 * surface on the terminal `key=value` line — e.g. `detail="task verdict
 * is blocked:dep-on-task"` for a `waiting` result, or
 * `detail="stuck:job-rejected"` for a `stuck` result. The command writes
 * its own line; this module just supplies the supporting prose.
 */
export type AwaitState =
  | { kind: "met"; detail?: string }
  | { kind: "waiting"; detail?: string }
  | { kind: "not-found"; detail?: string }
  | { kind: "deleted"; detail?: string }
  | { kind: "stuck"; detail?: string };

// ---------------------------------------------------------------------------
// Index lookups
// ---------------------------------------------------------------------------

/**
 * Find a task element by `task_id` across a list of epics. Returns `null`
 * if no epic in the input carries a task with the requested id. Linear
 * scan; the input set is the board's default-visible scope (small).
 */
function findTaskById(
  epics: readonly Epic[],
  taskId: string,
): { task: Task; epic: Epic } | null {
  for (const epic of epics) {
    for (const t of epic.tasks) {
      if (t.task_id === taskId) {
        return { task: t, epic };
      }
    }
  }
  return null;
}

/**
 * Find an epic by full id (`fn-N-slug`) or bare id (`fn-N`). The bare
 * form matches by `epic_number`; the full form matches by `epic_id`
 * exactly. Mirrors the bare-vs-full split in `cli/board.ts:439`
 * (`epicNumFromIdOrBare`) without re-using its full resolver shape —
 * here we only need a presence check, not the cross-project tie-break.
 *
 * Returns `null` when no epic in the input scope matches. Ambiguity
 * (two epics in scope with the same `epic_number`) returns the first
 * match by iteration order; the command's scope-exempt re-query path is
 * what disambiguates a truly absent epic from a renamed one.
 */
export function findEpicByIdOrBare(
  epics: readonly Epic[],
  id: string,
): Epic | null {
  const bareMatch = /^fn-(\d+)$/.exec(id);
  if (bareMatch !== null) {
    const num = Number.parseInt(bareMatch[1] ?? "", 10);
    if (Number.isFinite(num)) {
      for (const e of epics) {
        if (e.epic_number === num) {
          return e;
        }
      }
    }
    return null;
  }
  for (const e of epics) {
    if (e.epic_id === id) {
      return e;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Epic-unblocked: read off perTask + perCloseRow, NOT perEpic
// ---------------------------------------------------------------------------

/**
 * Compute "any row in this epic is workable" off the post-mutation
 * per-row verdict maps. Walks every task in the epic plus the synthetic
 * close-row (keyed by `epic.epic_id` in `perCloseRow`); returns true if
 * any verdict passes {@link workable}.
 *
 * Reading the `perEpic` rollup here would be wrong: `rollupEpicHeader`
 * picks one verdict per epic (the most-severe per its precedence
 * table), so an epic whose only `ready` task got demoted to `blocked:
 * single-task-per-epic` would roll up as `blocked:single-task-per-epic`
 * — but that demoted row IS workable per our carve-out, so the epic
 * SHOULD read unblocked. The per-row maps are the honest source.
 */
function epicHasWorkableRow(epic: Epic, snapshot: ReadinessSnapshot): boolean {
  for (const task of epic.tasks) {
    const v = snapshot.perTask.get(task.task_id);
    if (v !== undefined && workable(v)) {
      return true;
    }
  }
  const closeV = snapshot.perCloseRow.get(epic.epic_id);
  if (closeV !== undefined && workable(closeV)) {
    return true;
  }
  return false;
}

/**
 * Same shape as {@link epicHasWorkableRow}, returning the first stuck
 * verdict encountered (or `null`). Used to elevate an epic-level
 * `unblocked` await to `stuck` when no row is workable AND at least one
 * row is human-only-blocked — without this the command would sit in
 * `waiting` forever on an epic whose every task is rejected.
 *
 * fn-941: a task row whose stuck-ness is softened by an escalated-but-paused
 * `runtime-blocked` latch ({@link escalationSoftensStuck}) is SKIPPED — it is
 * escalation-in-flight, not a terminal stall, so it must not elevate the epic
 * to `stuck`. The close row carries no task id, so the softening never applies
 * to it.
 */
function epicAnyStuckRow(
  epic: Epic,
  snapshot: ReadinessSnapshot,
  escalatedTaskIds: ReadonlySet<string> | undefined,
  autopilotPaused: boolean | undefined,
): Verdict | null {
  for (const task of epic.tasks) {
    const v = snapshot.perTask.get(task.task_id);
    if (
      v !== undefined &&
      isStuck(v) &&
      !escalationSoftensStuck(
        v,
        task.task_id,
        escalatedTaskIds,
        autopilotPaused,
      )
    ) {
      return v;
    }
  }
  const closeV = snapshot.perCloseRow.get(epic.epic_id);
  if (closeV !== undefined && isStuck(closeV)) {
    return closeV;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Started: the monotonic "work has begun at least once" milestone
// ---------------------------------------------------------------------------

/**
 * Pure "this task has begun being worked at least once" predicate — the
 * start-bookend keying signal. True once ANY of:
 *   - an embedded `work`/`approve` job is present (`jobs[]` non-empty),
 *   - `runtime_status` is in the explicit started set {in_progress, done},
 *   - `worker_phase === "done"`.
 *
 * Set membership on the opaque `runtime_status` string is deliberate — NEVER
 * `!== "todo"`, which would mint `met` for an unrecognized/blocked-pre-start
 * value. Deliberately NOT the readiness `running` verdict: that flaps between
 * turns and is reconnect-sensitive, while this milestone is monotonic (an
 * embedded job persists `ended`/`killed`; `worker_phase` latches `done`).
 */
function taskStarted(task: Task): boolean {
  if ((task.jobs?.length ?? 0) > 0) {
    return true;
  }
  if (task.runtime_status === "in_progress" || task.runtime_status === "done") {
    return true;
  }
  return task.worker_phase === "done";
}

/**
 * Pure "work has begun on this epic at least once" predicate. True if the
 * epic carries an embedded epic-form job (`plan`/`close`/`approve`) OR any
 * task satisfies {@link taskStarted}.
 */
export function epicStarted(epic: Epic): boolean {
  if ((epic.jobs?.length ?? 0) > 0) {
    return true;
  }
  for (const task of epic.tasks) {
    if (taskStarted(task)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Inputs to {@link evaluateAwaitCondition}. Held as a single object so the
 * command builds them up explicitly and the module never wonders whether
 * something is implicit. Every field is a pure value — no live handles,
 * no functions.
 *
 *   - `epics`          — the epic list as observed by the subscribe stream.
 *                        Normally the board-scoped default-visible set
 *                        (`status='open' OR approval!='approved'`); the
 *                        await-complete path additionally merges the
 *                        recently-done epics (open-wins) so a done epic's
 *                        close-row verdict is reachable on the present branch.
 *                        Drives presence lookups for both kinds.
 *   - `snapshot`       — the post-mutex `ReadinessSnapshot` from the same
 *                        subscribe tick.
 *   - `priorPresence`  — true iff the target was observed at least once
 *                        in the subscribe stream before this evaluation
 *                        tick. The command tracks this across ticks; the
 *                        module uses it to decide `not-found` (never
 *                        present) vs `deleted` (was present, now isn't).
 *   - `reQueryHit`     — only consulted when the target is absent from
 *                        `epics` AND `priorPresence` is true. The command
 *                        runs a scope-exempt re-query (filter by primary
 *                        key, ignoring the `default_visible` filter) and
 *                        sets `true` if the daemon still has the row,
 *                        `false` if it's truly gone. For tasks: a
 *                        re-query hit means the parent epic's
 *                        `.keeper/epics/<id>.json` is still present and
 *                        the task is in its `tasks[]` array (the
 *                        scope-exempt read of the parent epic). For
 *                        epics: a re-query hit means the epic id is
 *                        present in the daemon's `epics` projection
 *                        regardless of approval. Defaults to `false`.
 *   - `escalatedTaskIds` — the set of task ids carrying a `block_escalations`
 *                        latch row (the daemon block-escalation producer's
 *                        escalate-once gate, fn-941). A coarse "escalation in
 *                        flight" signal — membership means a planner has been
 *                        (or is being) notified for that blocked task. Read as
 *                        a yes/no, NOT the latch's internal pending/requested/
 *                        attempted state machine. Defaults EMPTY (no escalation
 *                        plumbed → behave exactly as before).
 *   - `autopilotPaused`  — true iff the autopilot reconciler is paused, so the
 *                        cold re-dispatch that resumes an unblocked task CANNOT
 *                        fire. Together with `escalatedTaskIds` this softens an
 *                        escalated `runtime-blocked` task from `stuck` (terminal
 *                        under `--fail-on-stuck`) to `waiting` (escalation in
 *                        flight) — so an armed await visibly HOLDS instead of
 *                        silently surrendering on a stall the planner will clear.
 *                        Defaults `false`.
 */
export interface AwaitInputs {
  epics: readonly Epic[];
  snapshot: ReadinessSnapshot;
  priorPresence: boolean;
  reQueryHit?: boolean;
  escalatedTaskIds?: ReadonlySet<string>;
  autopilotPaused?: boolean;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Evaluate `target.condition` against `inputs` for `target.id`.
 *
 * Branch summary:
 *
 *   - Target absent from `inputs.epics`:
 *       priorPresence === false → `not-found`
 *       priorPresence === true  → `met` if condition='started' (monotonic —
 *                                   a popped-off target was necessarily
 *                                   started, no re-query) OR (condition=
 *                                   'complete' AND reQueryHit), else `deleted`
 *       (rationale: an epic "popping off the board" because it transitioned
 *       to `status=='done'` (the terminal keeper plan status — there is no
 *       `closed`) is the spec's positive completion signal; the command's
 *       scope-exempt re-query disambiguates that from a real deletion.)
 *
 *   - Target present in `inputs.epics`:
 *       condition='complete'  → read the readiness `completed` verdict:
 *           task: `perTask[id].tag==='completed'` (done AND idle) → `met`; a
 *                 present task with no verdict, or any non-`completed` verdict
 *                 (e.g. `running:sub-agent-stale`), → `waiting`.
 *           epic: `perCloseRow[epic_id].tag==='completed'` (status done AND the
 *                 closer idle) → `met`; present+open or present+done+closer-live
 *                 → `waiting`. A done epic stays present via the await-complete
 *                 recent-done merge; one aged past the window / deleted lands on
 *                 the absent branch.
 *       condition='started'  → read the raw fields (met / waiting only,
 *           evaluated BEFORE any stuck branch so a blocked-but-ran row
 *           reads `met`):
 *           task: taskStarted(task) → `met`; else `waiting`.
 *           epic: epicStarted(epic) → `met`; else `waiting`.
 *       condition='unblocked' → read the verdict map:
 *           task: workable(perTask[id]) → `met`; isStuck(perTask[id])
 *                 → `stuck`; else `waiting`.
 *           epic: epicHasWorkableRow(epic, snap) → `met`;
 *                 epicAnyStuckRow(epic, snap) AND no workable row →
 *                 `stuck`; else `waiting`.
 *
 * Detail strings are best-effort prose for the terminal-line render;
 * never load-bearing for correctness.
 */
export function evaluateAwaitCondition(
  inputs: AwaitInputs,
  target: AwaitTarget,
): AwaitState {
  if (target.kind === "task") {
    return evaluateTaskAwait(inputs, target);
  }
  return evaluateEpicAwait(inputs, target);
}

function evaluateTaskAwait(
  inputs: AwaitInputs,
  target: AwaitTarget,
): AwaitState {
  const hit = findTaskById(inputs.epics, target.id);
  if (hit === null) {
    return absentBranch(inputs, target);
  }
  if (target.condition === "complete") {
    // fn-1015: completion is the readiness `completed` verdict — `worker_phase
    // === "done"` AND the session idle (no embedded job working, no running
    // sub-agent, no held monitor lease) — NOT the raw `worker_phase` pop-off
    // that can race ahead of the worker winding down. A done-but-live task reads
    // `running:*` and stays `waiting` here (a done task whose sub-agent died
    // without SubagentStop is `running:sub-agent-stale` by design, so `complete`
    // holds `waiting` until an operator clears it). Undefined-guard mirrors the
    // unblocked path: a present task with no verdict reads `waiting`.
    const v = inputs.snapshot.perTask.get(target.id);
    if (v === undefined) {
      return {
        kind: "waiting",
        detail: "task present but no verdict in snapshot",
      };
    }
    if (v.tag === "completed") {
      return { kind: "met", detail: "task complete (done and idle)" };
    }
    return {
      kind: "waiting",
      detail: `task not complete (${verdictPhrase(v)})`,
    };
  }
  if (target.condition === "started") {
    // Evaluated off the raw task fields, BEFORE any stuck/blocked read — a
    // blocked task that already ran reads `met` (monotonic milestone), never
    // `stuck`. Returns met / waiting only.
    if (taskStarted(hit.task)) {
      return { kind: "met", detail: "task started" };
    }
    return { kind: "waiting", detail: "task not started yet" };
  }
  // unblocked
  const v = inputs.snapshot.perTask.get(target.id);
  if (v === undefined) {
    return {
      kind: "waiting",
      detail: "task present but no verdict in snapshot",
    };
  }
  if (workable(v)) {
    return { kind: "met", detail: verdictPhrase(v) };
  }
  // fn-941: an escalated-but-paused `runtime-blocked` task is escalation-in-flight,
  // NOT a terminal stall — soften it to `waiting` BEFORE the stuck read so an armed
  // `--fail-on-stuck` await holds for the planner instead of surrendering exit-5.
  if (
    escalationSoftensStuck(
      v,
      target.id,
      inputs.escalatedTaskIds,
      inputs.autopilotPaused,
    )
  ) {
    return {
      kind: "waiting",
      detail: "escalation in flight (blocked:escalated, autopilot paused)",
    };
  }
  if (isStuck(v)) {
    return { kind: "stuck", detail: verdictPhrase(v) };
  }
  return { kind: "waiting", detail: verdictPhrase(v) };
}

function evaluateEpicAwait(
  inputs: AwaitInputs,
  target: AwaitTarget,
): AwaitState {
  const epic = findEpicByIdOrBare(inputs.epics, target.id);
  if (epic === null) {
    return absentBranch(inputs, target);
  }
  if (target.condition === "complete") {
    // fn-1015: with the await-complete opt-in recent-done merge feeding this
    // input set, a done epic stays observable through its close-row wind-down,
    // so completion is the close-row `completed` verdict (status==='done' AND
    // the closer idle — no embedded close job working, no running sub-agent, no
    // held monitor lease) read off `perCloseRow`, NOT the epic merely popping
    // off the board. State machine: present+open → waiting; present+done+
    // idle-close-row → met; present+done+closer-live → waiting. A truly-deleted
    // epic (absent from BOTH the open AND recent-done scopes) lands on the
    // absent branch above, where the scope-exempt re-query disambiguates
    // re-query-hit → met (aged past the 1800s window but still in the
    // projection) from re-query-miss → deleted.
    const closeV = inputs.snapshot.perCloseRow.get(epic.epic_id);
    if (closeV !== undefined && closeV.tag === "completed") {
      return {
        kind: "met",
        detail: "epic complete (done and close-row idle)",
      };
    }
    return {
      kind: "waiting",
      detail: `epic not complete (status=${epic.status ?? "null"}${
        closeV === undefined ? "" : `, ${verdictPhrase(closeV)}`
      })`,
    };
  }
  if (target.condition === "started") {
    // Evaluated off the raw embedded jobs/tasks, BEFORE the workable/stuck
    // read — an epic with any started task reads `met` (monotonic), never
    // `stuck`. Returns met / waiting only.
    if (epicStarted(epic)) {
      return { kind: "met", detail: "epic started" };
    }
    return { kind: "waiting", detail: "epic not started yet" };
  }
  // unblocked
  if (epicHasWorkableRow(epic, inputs.snapshot)) {
    return { kind: "met", detail: "epic has at least one workable row" };
  }
  // fn-941: an escalated-but-paused `runtime-blocked` row is skipped by
  // `epicAnyStuckRow`, so an epic whose only stuck row is escalation-in-flight
  // reports `waiting` (holds for the planner) instead of `stuck`.
  const stuckRow = epicAnyStuckRow(
    epic,
    inputs.snapshot,
    inputs.escalatedTaskIds,
    inputs.autopilotPaused,
  );
  if (stuckRow !== null) {
    return { kind: "stuck", detail: verdictPhrase(stuckRow) };
  }
  return { kind: "waiting", detail: "no workable row yet" };
}

function absentBranch(inputs: AwaitInputs, target: AwaitTarget): AwaitState {
  if (!inputs.priorPresence) {
    return { kind: "not-found", detail: "target absent from board scope" };
  }
  // `started` is monotonic: a target present in a prior tick that has now
  // popped off the board was necessarily started, so `met` fires directly —
  // no `deleted` re-query needed (unlike `complete`, which must disambiguate
  // a true completion from a deletion).
  if (target.condition === "started") {
    return {
      kind: "met",
      detail: "target dropped off board (was started)",
    };
  }
  // Was present in a prior tick, gone now — let the command's
  // scope-exempt re-query disambiguate complete-vs-deleted.
  if (target.condition === "complete" && inputs.reQueryHit === true) {
    return {
      kind: "met",
      detail: "target dropped off board (re-query hit → complete)",
    };
  }
  return {
    kind: "deleted",
    detail: "target dropped off board (re-query miss → deleted)",
  };
}

// ---------------------------------------------------------------------------
// Phrase helper (internal)
// ---------------------------------------------------------------------------

function verdictPhrase(v: Verdict): string {
  switch (v.tag) {
    case "ready":
      return "verdict=ready";
    case "completed":
      return "verdict=completed";
    case "blocked":
      return `verdict=blocked:${v.reason.kind}`;
    case "running":
      return `verdict=running:${v.reason.kind}`;
  }
}

// ---------------------------------------------------------------------------
// git-clean / agents-idle pure predicates (fn-713)
// ---------------------------------------------------------------------------

/**
 * cwd-containment: is `cwd` the root itself or a descendant of it? Mirrors
 * the reducer's `(post.cwd = ? OR post.cwd LIKE ?)` containment at
 * `src/reducer.ts:1856` — `cwd === root || cwd.startsWith(root + "/")`.
 * Trailing slashes are normalized off both sides first so `/repo/` and
 * `/repo` resolve identically and `/repo-sibling` never false-matches
 * `/repo`. Pure — never touches the filesystem.
 */
function cwdInsideRoot(cwd: string, root: string): boolean {
  const c = cwd.endsWith("/") ? cwd.replace(/\/+$/, "") : cwd;
  const r = root.endsWith("/") ? root.replace(/\/+$/, "") : root;
  if (c.length === 0 || r.length === 0) {
    return false;
  }
  return c === r || c.startsWith(`${r}/`);
}

/**
 * `git-clean` predicate (fn-713). Given the cwd's resolved git root and the
 * board's `git_status` rows, the repo is clean (MET) when the row for that
 * root has `dirty_count === 0 AND orphaned_count === 0`.
 *
 * No row for the root → MET (clean): a repo absent from the
 * membership-gated `git_status` projection has no dirty/orphan facts, which
 * is exactly the "nothing to commit" steady state — keeper only mints a
 * `git_status` row for a worktree that is `.keeper`-backed, dirty, or
 * ahead of upstream, so an absent row means none of those held at snapshot
 * time.
 *
 * fn-897 B1: `seedRequired` (the boot-status header's `git_seed_required`)
 * OVERRIDES the absent-row inference. While the live-only git surface is
 * unseeded (the daemon restarted and the boot-seed hasn't run yet), EVERY repo
 * reads as a missing row — which would otherwise falsely report "clean". An
 * unseeded surface is UNKNOWN, not clean, so this returns `waiting` regardless
 * of the rows. Defaults `false` so steady-state callers (and the legacy
 * two-arg form) behave exactly as before.
 *
 * Orphan-metric choice is load-bearing: this uses the STRICT
 * `orphaned_count` column (zero attribution from any session). If a future
 * caller wants this to mirror autopilot's dispatch gate it would instead
 * need the client-computed `unattributed_to_live_count` (the
 * `projectGitStatusByProjectDir` math in `src/readiness-client.ts`) — a
 * deliberate, human-confirmed default per the fn-713 decision log. SWAP
 * POINT: change the `row.orphaned_count` read below.
 *
 * Returns the existing {@link AwaitState} union (`met` / `waiting` only —
 * git has no `deleted` / `stuck` semantic; an absent row is MET, not gone).
 * Pure: no I/O, no `Date.now()`.
 */
export function gitCleanState(
  gitRoot: string,
  gitStatusRows: readonly GitStatus[],
  seedRequired = false,
): AwaitState {
  // fn-897 B1: an unseeded git surface is UNKNOWN — never report "clean" off the
  // empty rows it produces. Hold `waiting` until the boot-seed populates it.
  if (seedRequired) {
    return { kind: "waiting", detail: "git surface unseeded (booting)" };
  }
  const normRoot = gitRoot.endsWith("/")
    ? gitRoot.replace(/\/+$/, "")
    : gitRoot;
  let row: GitStatus | undefined;
  for (const r of gitStatusRows) {
    const rd = r.project_dir.endsWith("/")
      ? r.project_dir.replace(/\/+$/, "")
      : r.project_dir;
    if (rd === normRoot) {
      row = r;
      break;
    }
  }
  if (row === undefined) {
    return { kind: "met", detail: "no git_status row for root (clean)" };
  }
  // SWAP POINT (see docblock): strict `orphaned_count`, NOT the
  // client-computed `unattributed_to_live_count`.
  if (row.dirty_count === 0 && row.orphaned_count === 0) {
    return { kind: "met", detail: "git clean (dirty=0 orphaned=0)" };
  }
  return {
    kind: "waiting",
    detail: `git dirty (dirty=${row.dirty_count} orphaned=${row.orphaned_count})`,
  };
}

/**
 * `agents-idle` predicate (fn-713). Given the cwd's resolved git root, the
 * caller's OWN `session_id` (for self-exclusion), and the `jobs` rows, the
 * repo is idle (MET) when no OTHER job (`job_id !== ownSessionId`) with
 * `state === "working"` has a cwd inside the root.
 *
 * Zero such jobs → MET (idle). cwd containment mirrors the reducer's
 * `src/reducer.ts:1856` prefix match (see {@link cwdInsideRoot}). A job
 * with a null cwd can never be inside the root, so it's skipped.
 *
 * `ownSessionId` is `null` when `CLAUDE_CODE_SESSION_ID` is unset (the
 * self-exclusion is then a no-op — every working job counts, including the
 * caller's own if it somehow appears).
 *
 * Reads `state === "working"` directly: per `src/reducer.ts`'s job state
 * machine the `working` state is held for the whole turn+subagent window,
 * so there's no between-turn flap to debounce. Returns the existing
 * {@link AwaitState} union (`met` / `waiting` only). Pure: no I/O.
 */
export function agentsIdleState(
  gitRoot: string,
  ownSessionId: string | null,
  jobsRows: Iterable<Job>,
): AwaitState {
  let busy = 0;
  for (const job of jobsRows) {
    if (job.state !== "working") {
      continue;
    }
    if (ownSessionId !== null && job.job_id === ownSessionId) {
      continue;
    }
    if (job.cwd === null) {
      continue;
    }
    if (cwdInsideRoot(job.cwd, gitRoot)) {
      busy += 1;
    }
  }
  if (busy === 0) {
    return { kind: "met", detail: "no other agents working in root" };
  }
  return {
    kind: "waiting",
    detail: `${busy} other agent(s) working in root`,
  };
}

/**
 * Selector for the {@link monitorRunningState} `monitor-running` predicate
 * (fn-718). An EXACT matcher over a single {@link MonitorEntry}: a `kind`
 * field (exact equality on the three-way provenance enum) and/or a `command`
 * field (exact equality on the FULL command string). At least one should be
 * set; an all-empty selector matches every entry (the CLI-wiring layer in T3
 * is responsible for rejecting an empty selector upfront). Both set → an entry
 * must satisfy BOTH (AND).
 */
export interface MonitorSelector {
  kind?: MonitorEntry["kind"];
  command?: string;
}

/**
 * `monitor-running` predicate (fn-718). Answers "is a background monitor
 * matching `selector` still running in the CALLER'S OWN session?" — the
 * own-session binding is the chosen scope (a monitor's liveness is a
 * per-session fact; the v51 `jobs.monitors` projection is snapshot-replaced on
 * each Stop and drops dead entries, so absence == done).
 *
 * INVERTS {@link agentsIdleState}'s self-exclusion: that predicate skips
 * `ownSessionId` to ask about OTHER agents; this one looks at ONLY the caller's
 * own row (`job.job_id === ownSessionId`). A terminal own-session job already
 * carries `monitors='[]'` (drop-when-dead), so the absence of a matching entry
 * is the single source of "done" — no separate non-terminal check is needed.
 *
 * RUNNING (`waiting`) iff >=1 entry in the own job's `monitors` array EXACTLY
 * matches the selector; DONE (`met`) iff zero matching entries remain (or the
 * own job is absent / its `monitors` is null / malformed). The own job's
 * `monitors` JSON is parsed defensively — malformed → treated as no monitors,
 * NEVER throws (mirrors `monitorLinesFor`'s `[]` fallback). Pure: no I/O, no
 * `Date.now()`.
 *
 * `ownSessionId` is `null` when `CLAUDE_CODE_SESSION_ID` is unset — there is
 * then no own row to find, so the result is always MET (vacuously done). The
 * arm-time "no match means already-done vs never-started" disambiguation is
 * T3's job (the refuse-upfront pre-check), NOT this predicate's — here a
 * no-match is uniformly `met`.
 *
 * SWAP POINT — match fields: the selector matches EXACTLY on `kind` and/or the
 * FULL `command` string, never substring / `includes` / `RegExp`. The exact
 * choice is deliberate: substring would prefix-collide (`my-script` matching
 * `my-script-v2`), match a wrapper shell's inner command, or open a
 * regex-injection trap. To widen later (e.g. a `description` match or a
 * prefix-anchored command), add a field to {@link MonitorSelector} and a clause
 * below — keep every clause an exact equality.
 */
export function monitorRunningState(
  ownSessionId: string | null,
  selector: MonitorSelector,
  jobsRows: Iterable<Job>,
): AwaitState {
  if (ownSessionId === null) {
    return { kind: "met", detail: "no own session id (vacuously done)" };
  }
  let ownJob: Job | undefined;
  for (const job of jobsRows) {
    if (job.job_id === ownSessionId) {
      ownJob = job;
      break;
    }
  }
  if (ownJob === undefined || ownJob.monitors === null) {
    return { kind: "met", detail: "no own monitors (done)" };
  }
  let entries: unknown;
  try {
    entries = JSON.parse(ownJob.monitors);
  } catch {
    // Mirror `monitorLinesFor`'s `[]` fallback — malformed JSON is treated as
    // no monitors, never throws.
    return { kind: "met", detail: "malformed monitors (treated as done)" };
  }
  if (!Array.isArray(entries)) {
    return { kind: "met", detail: "monitors not an array (treated as done)" };
  }
  let matches = 0;
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const e = entry as Partial<MonitorEntry>;
    if (selector.kind !== undefined && e.kind !== selector.kind) {
      continue;
    }
    if (selector.command !== undefined && e.command !== selector.command) {
      continue;
    }
    matches += 1;
  }
  if (matches === 0) {
    return { kind: "met", detail: "no matching monitor running (done)" };
  }
  return {
    kind: "waiting",
    detail: `${matches} matching monitor(s) still running`,
  };
}

// ---------------------------------------------------------------------------
// Board-level await predicates (fn-1015): drained / changed / epic-added /
// epic-removed. These read the WHOLE board, not one plan target, so they reuse
// the `met`/`waiting`/`stuck` arms of {@link AwaitState} but never
// `not-found`/`deleted` — a board condition has no target presence. All pure:
// no I/O, no `Date.now()`; the command captures the first-paint baseline and
// threads the live rows in.
// ---------------------------------------------------------------------------

/**
 * Is this `dispatch_failures.reason` an operator jam (an open-board sticky that
 * will NOT self-resolve)? The jam allowlist for `await drained --fail-on-stuck`:
 * `worktree-finalize-non-fast-forward` (an origin-ahead non-ff needing an operator
 * to reconcile origin) and a `worktree-merge-conflict` close-sink content conflict.
 * The `worktree-recover*` auto-clear prefix is excluded FIRST — a recover row
 * self-clears level-triggered once its git resolves, so a `worktree-recover-conflict`
 * never counts despite sharing the `worktree-` namespace. Tokens come from the
 * dep-free `dispatch-failure-key` leaf (the single dispatch-failure vocabulary), so
 * this leaf module adopts them with no drift risk. Exported for the `drained` jam
 * check + its test.
 */
export function isJamReason(reason: string): boolean {
  if (reason.startsWith(WORKTREE_RECOVER_REASON_PREFIX)) {
    return false;
  }
  return (
    reason === WORKTREE_FINALIZE_NON_FF_REASON ||
    reason.startsWith(MERGE_ESCALATION_REASON_TOKEN)
  );
}

export interface DrainedInputs {
  /** Per-task readiness verdicts (post-mutex). */
  perTask: ReadonlyMap<string, Verdict>;
  /** Per-close-row readiness verdicts. */
  perCloseRow: ReadonlyMap<string, Verdict>;
  /** Count of OPEN epics on the default-visible board; `0` ⇒ board empty. */
  openEpicCount: number;
  /** In-flight launch-window occupants (`pending_dispatches`). */
  pendingDispatchCount: number;
  /** Jobs in the `working` state. */
  runningJobCount: number;
  /** Reducer still draining toward head — NEVER report drained mid-catch-up. */
  catchingUp: boolean;
  /** The live `dispatch_failures.reason` strings (for the jam check). */
  dispatchFailureReasons?: readonly string[];
  /** Whether `--fail-on-stuck` armed the jam→stuck escalation. */
  failOnStuck?: boolean;
}

/**
 * `drained` predicate (fn-1015). MET when the board is fully at rest:
 * `catching_up===false` AND no in-flight launch AND no running job AND (the
 * open board is empty OR every per-task / per-close-row verdict is
 * `completed`). A deferred-on-upstream-merge epic (a per-(epic, repoDir) entry
 * in the reconciler's `computeDeferredEpicIds` map) always carries a
 * non-`completed` verdict (a ready task / ready close-row held back from cutting
 * its lane), so it reads `waiting` here automatically — the self-resolving
 * carve-out needs no producer-side probe on the client.
 *
 * Under `--fail-on-stuck` a jam-reason sticky ({@link isJamReason}) escalates
 * to `stuck` (exit 5): the board will not drain without an operator, so an
 * armed await must bail rather than block forever. Checked right after the
 * catch-up guard — a jam never self-clears, so siblings still in flight don't
 * make it any less terminal.
 *
 * Level-triggered (no baseline): fires `met` immediately if the board is
 * already at rest at first paint.
 */
export function drainedState(inputs: DrainedInputs): AwaitState {
  if (inputs.catchingUp) {
    return { kind: "waiting", detail: "catching up (reducer draining)" };
  }
  if (inputs.failOnStuck === true) {
    const jams = (inputs.dispatchFailureReasons ?? []).filter(isJamReason);
    if (jams.length > 0) {
      return {
        kind: "stuck",
        detail: `board jammed (${jams.length} sticky: ${jams[0]})`,
      };
    }
  }
  if (inputs.pendingDispatchCount > 0 || inputs.runningJobCount > 0) {
    return {
      kind: "waiting",
      detail: `in-flight (pending=${inputs.pendingDispatchCount} running=${inputs.runningJobCount})`,
    };
  }
  if (inputs.openEpicCount === 0) {
    return { kind: "met", detail: "board empty (drained)" };
  }
  for (const v of inputs.perTask.values()) {
    if (v.tag !== "completed") {
      return {
        kind: "waiting",
        detail: `task ${verdictPhrase(v)} (not drained)`,
      };
    }
  }
  for (const v of inputs.perCloseRow.values()) {
    if (v.tag !== "completed") {
      return {
        kind: "waiting",
        detail: `close-row ${verdictPhrase(v)} (not drained)`,
      };
    }
  }
  return { kind: "met", detail: "all rows completed (drained)" };
}

/**
 * Does `target` (a full `fn-N-slug` epic id or a bare `fn-N`) name `epicId`?
 * The bare form matches the `fn-<number>` numeric prefix; the full form is
 * exact equality. Mirrors {@link findEpicByIdOrBare}'s bare-vs-full split.
 */
function epicIdMatchesTarget(epicId: string, target: string): boolean {
  if (epicId === target) {
    return true;
  }
  const bare = /^fn-(\d+)$/.exec(target);
  if (bare === null) {
    return false;
  }
  const m = /^fn-(\d+)(?:-|$)/.exec(epicId);
  return m !== null && m[1] === bare[1];
}

/**
 * `epic-added` edge predicate (fn-1015). MET when an epic id present in
 * `current` was absent from the first-paint `baseline` — optionally narrowed to
 * `target` (full or bare). Edge-triggered: on the baseline tick `current` ===
 * `baseline`, so it can NEVER fire on first paint (no prior tick to diff).
 */
export function epicAddedMet(
  baseline: readonly string[],
  current: readonly string[],
  target?: string,
): boolean {
  const base = new Set(baseline);
  for (const id of current) {
    if (base.has(id)) {
      continue;
    }
    if (target === undefined || epicIdMatchesTarget(id, target)) {
      return true;
    }
  }
  return false;
}

/**
 * `epic-removed` edge predicate (fn-1015). MET when an epic id matching
 * `target` (full or bare) was present in the first-paint `baseline` but is now
 * absent from `current`. Edge-triggered: never fires on first paint. A target
 * absent from the baseline can never satisfy it (we never saw it present to see
 * it leave) — the command holds `waiting`.
 */
export function epicRemovedMet(
  baseline: readonly string[],
  current: readonly string[],
  target: string,
): boolean {
  const cur = new Set(current);
  for (const id of baseline) {
    if (epicIdMatchesTarget(id, target) && !cur.has(id)) {
      return true;
    }
  }
  return false;
}

/**
 * `landed` predicate — "this epic's lane is merged to the default
 * branch." A thin membership read over the durable MERGE-LANDED set
 * (`ReadinessClientSnapshot.landedEpicIds`, computed by task-1's
 * `computeLandedEpicIds`), so the worktree ON/OFF degradation is ALREADY baked
 * into the input: ON → the `lane_merged` projection ids, OFF → done epics
 * (no lanes, so merged ⇔ done). This consumer just asks "is `target` in the
 * set?" — it never re-derives the degradation.
 *
 * `target` is a full `fn-N-slug` epic id or a bare `fn-N`; matched against the
 * set via {@link epicIdMatchesTarget} (bare → numeric prefix, full → exact).
 *
 * `landedEpicIds === undefined` means the merge-landed observable wasn't opted
 * into (the snapshot omits it for board/dash scopes) or hasn't first-painted —
 * UNKNOWN, so `waiting` (never a false `met`). Membership is authoritative
 * regardless of board presence: a merged epic that has aged off the open board
 * still reads `met` as long as it rides the set, so there is no
 * `not-found`/`deleted` semantic — `landed` is a positive milestone like
 * `started`/`drained`, MET or `waiting` only. Pure: no I/O, no `Date.now()`.
 */
export function landedState(
  target: string,
  landedEpicIds: readonly string[] | undefined,
): AwaitState {
  if (landedEpicIds === undefined) {
    return { kind: "waiting", detail: "merge-landed signal not yet available" };
  }
  for (const id of landedEpicIds) {
    if (epicIdMatchesTarget(id, target)) {
      return { kind: "met", detail: `lane merged to default (${id})` };
    }
  }
  return { kind: "waiting", detail: "lane not yet merged to default" };
}

/** Stable string key for a verdict (tag + reason kind). Exported so the
 *  `keeper watch` coarse diff shares ONE verdict vocabulary with `changed`. */
export function verdictKey(v: Verdict): string {
  switch (v.tag) {
    case "ready":
      return "ready";
    case "completed":
      return "completed";
    case "blocked":
      return `blocked:${v.reason.kind}`;
    case "running":
      return `running:${v.reason.kind}`;
  }
}

export interface BoardSignatureInput {
  epics: readonly { epic_id: string; status: string | null }[];
  perTask: ReadonlyMap<string, Verdict>;
  perCloseRow: ReadonlyMap<string, Verdict>;
  perEpic: ReadonlyMap<string, Verdict>;
  autopilot: {
    mode: string;
    paused: boolean;
    worktreeMode: boolean;
    maxConcurrentJobs: number | null;
    // Keyed on the STORED per-root intent, not the effective cap: setting intent
    // while worktree mode is off is a real board move that must fire a `changed`
    // edge even though effective stays 1. `worktreeMode` is already a signature
    // input, so effective is fully derivable from the pair — no information loss.
    // ABSENT (undefined) when the snapshot carries no autopilot rows.
    maxConcurrentPerRootStored?: number;
  };
}

/**
 * Coarse content signature for `await changed` (fn-1015). Covers ONLY the
 * orient-relevant surface — epic id+status, the three per-row verdict maps, and
 * autopilot mode/pause/worktree/caps — and deliberately EXCLUDES noisy
 * git_status / subagent / job churn so a `changed` await fires on a real board
 * move, not heartbeat noise. Sorted keys ⇒ map-iteration-order churn never
 * perturbs the signature, so a reconnect re-paint of an unchanged board hashes
 * identically (no spurious edge).
 */
export function changedSignature(input: BoardSignatureInput): string {
  const epics = [...input.epics]
    .map((e) => [e.epic_id, e.status ?? null] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
  const mapSig = (m: ReadonlyMap<string, Verdict>): [string, string][] =>
    [...m.entries()]
      .map(([k, v]) => [k, verdictKey(v)] as [string, string])
      .sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify({
    epics,
    perTask: mapSig(input.perTask),
    perCloseRow: mapSig(input.perCloseRow),
    perEpic: mapSig(input.perEpic),
    autopilot: input.autopilot,
  });
}

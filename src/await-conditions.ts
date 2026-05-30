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
 *     disambiguate: re-query hit AND `(epic.approval='approved' AND
 *     epic.status='closed')` (or the task equivalent) → completed; miss
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
 * `met` for `complete` is presence-driven on epics (the spec's "pops off
 * the board" semantics) — the epic disappearing from the default-visible
 * scope is the signal, NOT an explicit `status` value. For tasks `met`
 * reads raw fields directly: `worker_phase === "done" && approval ===
 * "approved"`.
 */

import type { BlockReason, ReadinessSnapshot, Verdict } from "./readiness";
import type { Epic, Task } from "./types";

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
 * Discriminator the command hands to {@link evaluateAwaitCondition}. The
 * `kind` field decides which projection arm the predicate reads off; the
 * `condition` selects between the "complete" and "unblocked" semantics
 * defined in the module docblock.
 */
export interface AwaitTarget {
  id: string;
  kind: TargetKind;
  condition: "complete" | "unblocked";
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
 * `dep-on-epic-dangling`, `job-pending`, `job-rejected`, `unknown` — is
 * NOT workable. `running` verdicts are never workable (the row is
 * already in motion). `completed` is the terminal positive for
 * `complete` checks and is also not workable (it's done, not "available
 * to start").
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
 */
const STUCK_REASON_KINDS: ReadonlySet<BlockReason["kind"]> = new Set([
  "job-rejected",
  "dep-on-epic-dangling",
]);

function isStuck(v: Verdict): boolean {
  return v.tag === "blocked" && STUCK_REASON_KINDS.has(v.reason.kind);
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
function findEpicByIdOrBare(epics: readonly Epic[], id: string): Epic | null {
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
 */
function epicAnyStuckRow(
  epic: Epic,
  snapshot: ReadinessSnapshot,
): Verdict | null {
  for (const task of epic.tasks) {
    const v = snapshot.perTask.get(task.task_id);
    if (v !== undefined && isStuck(v)) {
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
// Inputs
// ---------------------------------------------------------------------------

/**
 * Inputs to {@link evaluateAwaitCondition}. Held as a single object so the
 * command builds them up explicitly and the module never wonders whether
 * something is implicit. Every field is a pure value — no live handles,
 * no functions.
 *
 *   - `epics`          — the board-scoped epic list as observed by the
 *                        subscribe stream (`default_visible = status='open'
 *                        OR approval!='approved'`). Drives presence
 *                        lookups for both kinds.
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
 *                        `.planctl/epics/<id>.json` is still present and
 *                        the task is in its `tasks[]` array (the
 *                        scope-exempt read of the parent epic). For
 *                        epics: a re-query hit means the epic id is
 *                        present in the daemon's `epics` projection
 *                        regardless of approval. Defaults to `false`.
 */
export interface AwaitInputs {
  epics: readonly Epic[];
  snapshot: ReadinessSnapshot;
  priorPresence: boolean;
  reQueryHit?: boolean;
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
 *       priorPresence === true  → `met` if (condition='complete' AND
 *                                   reQueryHit), else `deleted`
 *       (rationale: an epic "popping off the board" because it transitioned
 *       to `approval='approved'` + `status='closed'` is the spec's positive
 *       completion signal; the command's scope-exempt re-query
 *       disambiguates that from a real deletion.)
 *
 *   - Target present in `inputs.epics`:
 *       condition='complete'  → read raw fields:
 *           task: `worker_phase==='done' && approval==='approved'`
 *           epic: never `met` on the present branch (an epic that's
 *                 truly complete has popped off the board scope — see
 *                 absent branch above). If the epic is still on the
 *                 board, it isn't complete yet; return `waiting`.
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
    const { task } = hit;
    if (task.worker_phase === "done" && task.approval === "approved") {
      return { kind: "met", detail: "task complete (done + approved)" };
    }
    return {
      kind: "waiting",
      detail: `task not complete (worker_phase=${task.worker_phase ?? "null"} approval=${task.approval})`,
    };
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
    // An epic that's truly complete (approval='approved' AND
    // status='closed' per the EPICS_DESCRIPTOR's default filter) has
    // popped off the board scope, so it lands on the absent branch
    // above. If we see it here, it's still on the board — not yet
    // complete.
    return {
      kind: "waiting",
      detail: `epic still on board (approval=${epic.approval} status=${epic.status ?? "null"})`,
    };
  }
  // unblocked
  if (epicHasWorkableRow(epic, inputs.snapshot)) {
    return { kind: "met", detail: "epic has at least one workable row" };
  }
  const stuckRow = epicAnyStuckRow(epic, inputs.snapshot);
  if (stuckRow !== null) {
    return { kind: "stuck", detail: verdictPhrase(stuckRow) };
  }
  return { kind: "waiting", detail: "no workable row yet" };
}

function absentBranch(inputs: AwaitInputs, target: AwaitTarget): AwaitState {
  if (!inputs.priorPresence) {
    return { kind: "not-found", detail: "target absent from board scope" };
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

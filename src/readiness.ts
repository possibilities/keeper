/**
 * Pure readiness pipeline — given a snapshot of the `epics`, `jobs`, and
 * `subagent_invocations` projections, returns a per-row verdict map for the
 * board UI's `[ready]` / `[completed]` / `[blocked:<reason>]` pill.
 *
 * Why a separate module: the same pure function is the contract for both the
 * board UI render path AND a future autopilot dispatch path. Keeping it pure
 * (no I/O, no `Date.now()`, no closure over external state) lets a test
 * fixture pin a verdict for a given snapshot, and lets autopilot consume the
 * verdict's discriminated-union tag without parsing strings.
 *
 * Predicate pipeline — first-match-wins, fourteen ordered checks per row:
 *   1. terminal-completed          — task: status==="done" && approval==="approved"
 *                                    close: epic.status==="done" && epic.approval==="approved"
 *   2. epic-not-validated          — parent epic.last_validated_at == null
 *   3. planner-running             — any epic.job_links entry whose job is `working`
 *   4. own-approval-rejected       — task.approval==="rejected" → job-rejected
 *                                    (rejection is permanent regardless of session state, so it
 *                                    ranks ABOVE the session-running checks; pending is split off
 *                                    to predicate 7 so it cannot fire while a worker is still alive)
 *   5. own-progress-main           — task: any embedded jobs[] entry on this row state==="working"
 *                                    close: any embedded jobs[] entry on the epic OR on ANY of its
 *                                    tasks state==="working" (fan-out — see `evaluateCloseRow` for why)
 *   6. own-progress-sub            — task: any subagentInvocations row job_id===<this row's worker.session_id>
 *                                    && status==="running"
 *                                    close: same predicate but joined against worker session ids from
 *                                    epic-level AND every task-level embedded jobs[]
 *   6.5. git-uncommitted / git-orphans
 *                                  — task (gated worker_phase==="done"): look up the live `git_status`
 *                                    row for `task.target_repo ?? epic.project_dir` via
 *                                    `gitStatusByProjectDir`; if its dirty_count > 0 → git-uncommitted,
 *                                    else if unattributed_to_live_count > 0 → git-orphans. Skipped
 *                                    when no entry exists for the root (no snapshot yet, or
 *                                    simulator's empty map) or worker_phase !== "done".
 *                                    close (gated epic.status==="done"): same idea keyed by
 *                                    `epic.project_dir`. Mechanical gate that lifts the inferred git
 *                                    cleanliness check out of /plan:approve's LLM cascade into
 *                                    keeper's deterministic readiness pipeline. Placed AFTER
 *                                    session-running (5/6) and BEFORE approval-pending (7) for the
 *                                    same race rationale as predicate 7: the gate must wait until
 *                                    every worker session and sub-agent is actually idle before
 *                                    sampling git state, otherwise mid-yield Stops produce stale
 *                                    dirty-tree readings that flap the pill. Reads off the live
 *                                    project-wide `git_status` row (not the embedded per-job count
 *                                    columns) — those columns freeze on terminal worker transition
 *                                    while the project's git state may have moved on.
 *                                    The block-reason `kind` is `git-orphans` (preserved for
 *                                    backward compatibility with autopilot's reason enumeration —
 *                                    `scripts/autopilot.ts:230,238,449` consume the literal
 *                                    string), but the underlying signal is the schema-v31
 *                                    `git_unattributed_to_live_count` column (the legacy v28
 *                                    "orphan" semantic preserved under its new name — dirty files
 *                                    no live session is on the hook for). The new strict-mystery
 *                                    `git_orphan_count` column (files with ZERO active
 *                                    attribution from any tracked session) is INFORMATIONAL ONLY
 *                                    at v31 — not a block reason, not a predicate; it surfaces in
 *                                    `scripts/git.ts` for human inspection. See the
 *                                    `gitStatusByProjectDir` doc on `computeReadiness` below for
 *                                    the column-name-vs-reason-kind divergence rationale.
 *   7. own-approval-pending        — task.approval==="pending" && status==="done" → job-pending
 *                                    close: epic.approval==="pending" && epic.status==="done" → job-pending
 *                                    Deliberately ranks BELOW 5/6: `worker_phase==="done"` is stamped
 *                                    by `planctl done` and can race ahead of the Claude session's
 *                                    Stop/SessionEnd, so `job-pending` must wait for the session
 *                                    (and any sub-agent) to actually be idle. Otherwise consumers
 *                                    (autopilot's approval-pending notify) fire prematurely while
 *                                    the worker is still in-flight.
 *   8. dep-on-task                 — any depends_on upstream NOT { tag:"completed" }
 *   9. dep-on-epic                 — any depends_on_epics upstream's close NOT completed
 *  10. dep-on-task-synthetic-close — for the synthetic close row: any non-completed task
 *  11. single-task-per-epic        — post-pass: one non-completed slot per epic
 *  12. single-task-per-root        — post-pass: one non-completed slot per project root
 *
 * The two post-passes (11, 12) run in that order — per-epic FIRST so its
 * tighter scope wins the reason when both would apply. Both share one
 * algorithmic shape: walk in board traversal order, the FIRST non-completed
 * row claims the slot, every LATER row whose verdict is `ready` in that
 * same slot gets mutated to the corresponding blocked reason. Rows already
 * blocked by reasons 1–10 stay with their (more specific) reason; only
 * `ready` rows are mutated. The "occupant" check counts ANY non-completed
 * verdict (working, blocked-by-anything, ready) — so a sibling task that
 * is actively `job-running` or `sub-agent-running` in the same epic/root
 * still blocks later ready rows. Iteration order is the only determinism
 * gate.
 *
 * Epic header rollup (after per-row + both post-passes):
 *   - `[completed]`         if close row verdict is `{ tag: "completed" }`.
 *   - `[ready]`             if any task or close row verdict is `{ tag: "ready" }`.
 *   - `[running:<kind>]`    if any task or close row verdict is `{ tag: "running" }`
 *                           (priority slots between `ready` and `blocked`).
 *   - Otherwise `[blocked:<first non-completed row's reason in traversal order>]`.
 */

import {
  type EpicDepResolution,
  resolveEpicDep as resolveEpicDepLeaf,
} from "./epic-deps";
import type { ResolutionDiagnostic } from "./readiness-diagnostics";
import type { Epic, Job, SubagentInvocation, Task } from "./types";

// Re-export so existing import sites (`scripts/board.ts` and any other
// consumer that pulled `EpicDepResolution` / `resolveEpicDep` from
// `readiness.ts`) keep working without a rename rippling outside this
// extraction. The canonical home is `./epic-deps`; this is a thin
// compat surface.
export type { EpicDepResolution };

/**
 * Wall-clock-bound wrapper around the fold-safe `resolveEpicDep` in
 * `./epic-deps`. Existing readiness/board callers expected the resolver
 * to stamp diagnostics with the current wall-clock time; preserve that
 * exact behavior by passing `new Date().toISOString()` here. The reducer
 * caller (fn-637.3) goes straight to `./epic-deps#resolveEpicDep` with
 * an event-derived timestamp so its fold stays deterministic.
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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Structured block reason — discriminated union with structured payloads so
 * consumers can branch on `kind` without parsing strings.
 *
 * - `job-rejected` / `job-pending`     — this row's own approval state.
 * - `epic-not-validated`               — parent epic has no `last_validated_at`.
 * - `git-uncommitted`                  — the live `git_status` row for this row's project root has
 *                                        `dirty_count > 0` (mechanical gate inserted at rank 6.5;
 *                                        payload-less by design — see the predicate-pipeline docstring
 *                                        for the rationale on placement).
 * - `git-orphans`                      — the live `git_status` row for this row's project root has
 *                                        `unattributed_to_live_count > 0` (mechanical gate inserted
 *                                        at rank 6.5; payload-less by design — complements
 *                                        `git-uncommitted` and fires when dirty count is zero but
 *                                        the project has dirty files no LIVE session is on the hook
 *                                        for). The reason kind string stays `git-orphans` for
 *                                        backward compatibility with autopilot's literal
 *                                        comparisons (`scripts/autopilot.ts:230,238,449`); the
 *                                        underlying column is the schema-v31 rename
 *                                        `git_unattributed_to_live_count` (legacy v28 "orphan"
 *                                        semantic preserved). The new strict-mystery
 *                                        `git_orphan_count` (zero-attribution from any session)
 *                                        is informational only at v31 and does not feed this kind.
 * - `dep-on-task`                      — an upstream task is not completed (carries the upstream id).
 * - `dep-on-epic`                      — an upstream epic's close is not completed. Carries the
 *                                        resolved full epic id as `upstream`. When the upstream's
 *                                        `project_dir` basename differs from the consumer's, the
 *                                        optional `cross_project` field carries the upstream's
 *                                        project basename so the renderer can prefix the pill
 *                                        `dep-on-epic <project>::<id>`; `null` for intra-project
 *                                        deps. The `upstream` field stays a literal id so
 *                                        consumers can use it for lookup without re-parsing.
 * - `dep-on-epic-dangling`             — a `depends_on_epics` entry could not be resolved against
 *                                        the input snapshot. Three sources: a full-id miss
 *                                        (`fn-100-foo` not in `epicById`), a bare-id miss
 *                                        (`fn-100` matched no epic in `epicsByNumber`), or a
 *                                        bare-id ambiguity (2+ matches, no same-project match
 *                                        disambiguates) — the ambiguity case ALSO emits a
 *                                        {@link ResolutionDiagnostic} so the human sees which
 *                                        candidates collided. Red pill (autopilot's structural
 *                                        problem signal), distinct from the amber `dep-on-epic`.
 * - `single-task-per-epic`             — lost the per-epic mutex (a sibling row in the same epic is non-completed).
 * - `single-task-per-root`             — lost the per-root mutex (a row in another epic in the same project root is non-completed).
 * - `unknown`                          — defensive default for verdict/renderer mismatch.
 */
export type BlockReason =
  | { kind: "job-rejected" }
  | { kind: "job-pending" }
  | { kind: "epic-not-validated" }
  | { kind: "git-uncommitted" }
  | { kind: "git-orphans" }
  | { kind: "dep-on-task"; upstream: string }
  | { kind: "dep-on-epic"; upstream: string; cross_project: string | null }
  | { kind: "dep-on-epic-dangling"; upstream: string }
  | { kind: "single-task-per-epic" }
  | { kind: "single-task-per-root" }
  | { kind: "unknown" };

/**
 * The four "in-motion" reasons split out of `BlockReason` into the
 * sibling `running` Verdict tag. A `running` verdict means the row has a
 * live worker / sub-agent / planner session actively in motion — distinct
 * from a `blocked` verdict, which means the row is stuck waiting on a
 * dependency, approval, repo state, or mutex.
 *
 * `sub-agent-stale` (fn-638.4) is the visibility affordance for a
 * still-`running` sub-agent invocation whose start age exceeds
 * `SUBAGENT_STALENESS_SEC` relative to the caller-injected `now`. It is a
 * SUPPLEMENT to the reducer's bounded Stop guard (fn-638.1), not a
 * replacement: the reducer releases the worker's `working` state once the
 * Stop event's `ts` is past the same window, which clears predicate 5; a
 * sub-agent that survives that release because Stop never fired
 * (autopilot-spawned `claude` exited without a Stop hook, or the
 * sub-agent's parent session is orphaned) keeps predicate 6 firing
 * `sub-agent-running` indefinitely. This variant makes the
 * possibly-stuck condition visible on the board so a human can see WHAT
 * is holding a gate instead of seeing a wedged autopilot. The threshold
 * mirrors `MAX_STOP_YIELD_GAP_SEC` (120s) so the two definitions stay
 * aligned — once the bounded Stop guard would have considered the
 * sub-agent old enough to bypass, this predicate surfaces the same row
 * as stale. Aligns with `collapseSubagentsByName`'s client-side
 * "stuck-orphan" notion in convergent intent: the client labels the
 * structurally-stuck rows (older turn_seq superseded but still running),
 * this predicate labels them temporally (older than the freshness
 * window) — both flag the same orphaned-running rows in practice.
 */
export type RunningReason =
  | { kind: "job-running" }
  | { kind: "sub-agent-running" }
  | { kind: "sub-agent-stale" }
  | { kind: "planner-running" };

/**
 * Staleness threshold for the `sub-agent-stale` `RunningReason` variant
 * (fn-638.4). A still-`running` sub-agent whose `ts` is older than the
 * caller-injected `now` by strictly more than this many seconds renders
 * as `sub-agent-stale` instead of `sub-agent-running`. Value mirrors
 * `MAX_STOP_YIELD_GAP_SEC` in `src/reducer.ts` (the bounded Stop guard
 * window): once the reducer would have considered the sub-agent old
 * enough to bypass on a Stop event, this predicate surfaces the same row
 * as stale so the board pill and the autopilot release-window agree on
 * the same row population. Held as a local constant (not imported from
 * `reducer.ts`) so the readiness module stays leaf-ish — both
 * definitions live as bare numeric constants with cross-refs in their
 * docstrings, drifting one without the other surfaces in
 * `test/reducer.test.ts` + `test/readiness.test.ts` together.
 *
 * Determinism: the comparison `now - inv.ts > SUBAGENT_STALENESS_SEC` is
 * a pure function of the injected `now` and the projection's `ts` field
 * — no `Date.now()` here, just like the reducer's bounded Stop guard.
 * Callers in the live path (`subscribeReadiness` → `computeReadiness`)
 * supply `Math.floor(Date.now()/1000)` per snapshot; the autopilot
 * simulator and tests that don't care pass `Number.NEGATIVE_INFINITY`
 * (the parameter's default) so the staleness branch never fires for
 * them. Re-fold determinism does not apply here — this is a CLIENT
 * computation over the live projection, not a reducer fold. The two
 * worlds are deliberately separate: the reducer's bounded Stop guard
 * (fold-time, event-`ts`-driven) does the WORK of releasing the worker;
 * this predicate does the VISIBILITY work of telling a human why a
 * surviving sub-agent is suspect.
 */
export const SUBAGENT_STALENESS_SEC = 120;

export type Verdict =
  | { tag: "ready" }
  | { tag: "completed" }
  | { tag: "blocked"; reason: BlockReason }
  | { tag: "running"; reason: RunningReason };

/**
 * The full readiness snapshot — per-task, per-close-row (keyed by epic_id),
 * and per-epic-header (also keyed by epic_id). Renderer-side lookups that
 * miss should render `[blocked:unknown]` — visible (bug indicator) and inert
 * (autopilot won't dispatch on `unknown`).
 *
 * `diagnostics` carries structured side-band output from the resolver — today
 * just `ambiguous-dep-resolution` rows for bare `fn-N` epic deps that matched
 * 2+ epics with no same-project disambiguator. Side-effecting consumers
 * (`scripts/board.ts`, `scripts/autopilot.ts`) drain this array per snapshot
 * and append each entry to `~/.local/state/keeper/readiness-diagnostics.jsonl`
 * via {@link appendDiagnostic}. Pure-function consumers (tests, the autopilot
 * simulator) read it for assertions or ignore it. `computeReadiness` itself
 * never performs I/O.
 */
export interface ReadinessSnapshot {
  perTask: Map<string, Verdict>;
  perCloseRow: Map<string, Verdict>;
  perEpic: Map<string, Verdict>;
  diagnostics: ResolutionDiagnostic[];
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Pure entry. Walks `epics` in iteration order (the caller is responsible
 * for handing in a deterministically-ordered map — typically the board's
 * `epics.order`-indexed `byId`). For each epic, builds per-task verdicts
 * via the 11-predicate pipeline (first-match-wins), then the synthetic
 * close-row verdict, then the epic header rollup. After the per-row pass,
 * `applySingleTaskPerEpicMutex` and `applySingleTaskPerRootMutex` mutate
 * the verdict maps for the two post-pass mutex predicates (in that order
 * — tighter scope reported first when both would apply).
 *
 * Inputs are keyed by id; both maps and arrays are accepted (an iterable
 * with stable order suffices). The function never mutates its inputs.
 */
export function computeReadiness(
  epics: Iterable<Epic>,
  jobs: Map<string, Job>,
  subagentInvocations: Iterable<SubagentInvocation>,
  // Project-wide git status keyed by `project_dir`. The task arm of
  // predicate 6.5 looks up `task.target_repo ?? epic.project_dir` (same
  // root-resolution shape `effectiveRoot` uses for the per-root mutex);
  // the close-row arm looks up `epic.project_dir` directly. Defaults to an
  // empty map so callers that don't subscribe to `git_status` (today: the
  // autopilot simulator, hand-rolled test fixtures) preserve the pre-fix
  // "predicate 6.5 doesn't fire" semantics. Replaces the schema-v21
  // per-job `git_dirty_count`/`git_orphan_count` read off the freshest
  // embedded worker job — those columns only refresh while the job is in
  // `state IN ('working','stopped')` and freeze on terminal transition,
  // so the live `git_status` row is the honest source of truth.
  //
  // Schema-v31 column-name-vs-reason-kind divergence: the field
  // `unattributed_to_live_count` on this map sources the schema-v31
  // `jobs.git_unattributed_to_live_count` column (renamed from the
  // legacy v28 `git_orphan_count`; same value, more honest name — "dirty
  // files no LIVE session is on the hook for"). The block-reason kind is
  // STILL `git-orphans` because autopilot's reason enumeration
  // (`scripts/autopilot.ts:230,238,449`) consumes the literal string
  // `"git-orphans"`; flipping the kind would ripple through every
  // consumer without semantic benefit. The new strict-mystery
  // `git_orphan_count` column (files with ZERO active attribution from
  // any session past or present) is informational only at v31 — not
  // projected into this map, not consulted by any predicate. If
  // strict-mystery ever needs to block, that's a separate refinement.
  gitStatusByProjectDir: Map<
    string,
    { dirty_count: number; unattributed_to_live_count: number }
  > = new Map(),
  // fn-637: completed upstream epics (`status==="done" && approval==="approved"`)
  // that have been pruned from the default-visible page and so are absent from
  // `epics`. Supplied via a scoped resolver-only read (see `subscribeReadiness`).
  // Merged into the `epicById`/`epicsByNumber` resolver indexes ONLY — never
  // into the verdict/mutex iteration — so predicate 9 resolves a satisfied
  // cross-epic dependency to `found` (completed) instead of falsely reporting
  // `dep-on-epic-dangling`. Defaults to empty so existing callers/tests that
  // don't subscribe to the completed set keep the pre-fix behavior.
  completedEpics: Iterable<Epic> = [],
  // fn-638.4: caller-injected reference timestamp (unix seconds) for the
  // `sub-agent-stale` `RunningReason` variant — a still-`running` sub-agent
  // invocation whose `ts` is older than `now - SUBAGENT_STALENESS_SEC`
  // surfaces as `sub-agent-stale` instead of `sub-agent-running`. Mirrors
  // the injected-timestamp pattern fn-637.1 established in `epic-deps.ts`
  // for `resolveEpicDep`: the pure readiness pass never reads `Date.now()`;
  // the live client (`subscribeReadiness`) supplies
  // `Math.floor(Date.now()/1000)` per snapshot. The autopilot simulator and
  // hand-rolled tests that don't model running sub-agents pass the default
  // `Number.NEGATIVE_INFINITY` so the staleness branch can never fire for
  // them (`-Infinity - inv.ts > threshold` is always false). Held as a
  // separate parameter from `completedEpics`' wall-clock so the two pure
  // surfaces stay independently overridable — a test exercising staleness
  // doesn't need to also supply completed epics, and vice versa. This is a
  // CLIENT computation distinct from the reducer fold (the bounded Stop
  // guard at `src/reducer.ts:MAX_STOP_YIELD_GAP_SEC` does the WORK of
  // releasing the worker; this predicate does the VISIBILITY work of
  // surfacing a sub-agent that survives that release).
  now: number = Number.NEGATIVE_INFINITY,
): ReadinessSnapshot {
  // Build a job_id → SubagentInvocation[] index so predicate 6 is O(1) per row.
  // Filtered to `status === "running"` at index time — the only status that
  // can block; ok/error rows pass silently.
  const subRunningByJobId = new Map<string, SubagentInvocation[]>();
  for (const inv of subagentInvocations) {
    if (inv.status !== "running") {
      continue;
    }
    const arr = subRunningByJobId.get(inv.job_id);
    if (arr === undefined) {
      subRunningByJobId.set(inv.job_id, [inv]);
    } else {
      arr.push(inv);
    }
  }

  // Build a tasks-by-id index spanning every epic, so cross-epic
  // `depends_on` lookups (rare but possible per spec) hit O(1).
  //
  // Parallel `epicById` + `epicsByNumber` indexes feed predicate 9's
  // cwd-then-global resolver (see {@link resolveEpicDep}). `epicById`
  // resolves full ids (`fn-100-foo`); `epicsByNumber` resolves bare
  // `fn-N` ids that may match multiple epics across configured project
  // roots — the resolver's same-project preference picks the consumer's
  // root when multiple candidates exist, falls through to a dangling
  // verdict + diagnostic when no candidate disambiguates.
  const taskById = new Map<string, Task>();
  const epicById = new Map<string, Epic>();
  const epicsByNumber = new Map<number, Epic[]>();
  const epicsArr: Epic[] = [];
  for (const epic of epics) {
    epicsArr.push(epic);
    epicById.set(epic.epic_id, epic);
    if (typeof epic.epic_number === "number") {
      const arr = epicsByNumber.get(epic.epic_number);
      if (arr === undefined) {
        epicsByNumber.set(epic.epic_number, [epic]);
      } else {
        arr.push(epic);
      }
    }
    for (const task of epic.tasks) {
      taskById.set(task.task_id, task);
    }
  }

  // fn-637: merge the completed-epics resolver index. These are done+approved
  // upstreams pruned from the default-visible page; they reach us via a scoped
  // read and are added to `epicById`/`epicsByNumber` ONLY — never to `epicsArr`
  // or `taskById` — so the per-task / close-row / mutex passes stay scoped to
  // the default-visible set exactly as before. The `epicById.has` guard makes
  // the merge a no-op for any epic already in the live set (the two sets are
  // disjoint by construction — `default_visible=1` vs the done+approved
  // supplemental filter — but the guard also prevents a transient
  // double-delivery from creating a phantom same-number bare-id ambiguity).
  for (const epic of completedEpics) {
    if (epicById.has(epic.epic_id)) {
      continue;
    }
    epicById.set(epic.epic_id, epic);
    if (typeof epic.epic_number === "number") {
      const arr = epicsByNumber.get(epic.epic_number);
      if (arr === undefined) {
        epicsByNumber.set(epic.epic_number, [epic]);
      } else {
        arr.push(epic);
      }
    }
  }

  const perTask = new Map<string, Verdict>();
  const perCloseRow = new Map<string, Verdict>();
  const perEpic = new Map<string, Verdict>();
  const diagnostics: ResolutionDiagnostic[] = [];

  for (const epic of epicsArr) {
    // Per-task pass — depends_on is intra-epic, and the pre-sorted tasks
    // array (planctl invariant) is in dependency-safe order for the typical
    // case. For robustness against unusual orderings we still look up the
    // upstream from `taskById` (built above), so a forward-reference in
    // depends_on works as long as both ends live in the input.
    for (const task of epic.tasks) {
      const verdict = evaluateTask(
        task,
        epic,
        jobs,
        subRunningByJobId,
        perTask,
        perCloseRow,
        gitStatusByProjectDir,
        epicById,
        epicsByNumber,
        diagnostics,
        now,
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
    );
    perCloseRow.set(epic.epic_id, closeVerdict);
  }

  // Post-pass mutexes — mutate `perTask` / `perCloseRow` in board traversal
  // order. Per-epic FIRST so its tighter scope reports the reason when both
  // would apply; per-root SECOND over the same maps.
  applySingleTaskPerEpicMutex(epicsArr, perTask);
  applySingleTaskPerRootMutex(epicsArr, perTask, perCloseRow);

  // Epic header rollup.
  for (const epic of epicsArr) {
    perEpic.set(epic.epic_id, rollupEpicHeader(epic, perTask, perCloseRow));
  }

  return { perTask, perCloseRow, perEpic, diagnostics };
}

// ---------------------------------------------------------------------------
// Predicate pipeline — per-row
// ---------------------------------------------------------------------------

function evaluateTask(
  task: Task,
  epic: Epic,
  // Schema v21 dropped the live-jobs join from `anyJobLinkRunning` — the
  // embedded `JobLinkEntry.state` carries the linked session's last-known
  // lifecycle off the projection. The arg stays in the signature so
  // `computeReadiness`'s public surface is unchanged for external
  // callers; the underscore signals it's intentionally unused here.
  _jobs: Map<string, Job>,
  subRunningByJobId: Map<string, SubagentInvocation[]>,
  perTask: Map<string, Verdict>,
  // perCloseRow IS used by predicate 9's tolerant forward-ref evaluator —
  // see the predicate's body for the rationale.
  perCloseRow: Map<string, Verdict>,
  gitStatusByProjectDir: Map<
    string,
    { dirty_count: number; unattributed_to_live_count: number }
  >,
  epicById: Map<string, Epic>,
  epicsByNumber: Map<number, Epic[]>,
  diagnostics: ResolutionDiagnostic[],
  // fn-638.4: caller-injected reference timestamp (unix seconds) for the
  // sub-agent staleness check at predicate 6. See `computeReadiness`'s
  // `now` doc for the determinism rationale.
  now: number,
): Verdict {
  // 1. terminal-completed. Schema v19: read the derived worker-phase binary
  // under its new key — the legacy `status` was renamed to `worker_phase`
  // to free up `runtime_status` for the planctl-native enum. Semantics are
  // unchanged: `worker_done_at` present → `worker_phase === "done"`.
  if (task.worker_phase === "done" && task.approval === "approved") {
    return { tag: "completed" };
  }

  // 2. epic-not-validated.
  if (epic.last_validated_at == null) {
    return { tag: "blocked", reason: { kind: "epic-not-validated" } };
  }

  // 3. planner-running.
  if (anyJobLinkRunning(epic)) {
    return { tag: "running", reason: { kind: "planner-running" } };
  }

  // 4. own-approval-rejected — rejection is permanent regardless of session
  // state, so it ranks ABOVE the session-running checks. The `pending` half
  // of own-approval is split off to predicate 7 (below 5/6) so it cannot
  // fire while a worker session is still alive — see predicate 7's comment.
  if (task.approval === "rejected") {
    return { tag: "blocked", reason: { kind: "job-rejected" } };
  }

  // 5. own-progress-main — embedded jobs[] state vocabulary, no verb check
  // (the embedded array's verb is implied by where it lives — task-level
  // here means verb `work`).
  if (anyEmbeddedJobWorking(task.jobs)) {
    return { tag: "running", reason: { kind: "job-running" } };
  }

  // 6. own-progress-sub — sub-agent invocation under THIS row's worker
  // session. The worker session id is the embedded job's `job_id`; a task
  // may have zero or more workers. A single `running` invocation on any
  // worker blocks.
  //
  // fn-638.4: split the verdict on `now - inv.ts > SUBAGENT_STALENESS_SEC`:
  // if EVERY surviving running sub-agent under this row is stale, render
  // `sub-agent-stale` (visibility affordance for a possibly-stuck
  // orphan); otherwise render `sub-agent-running` (fresh work in
  // flight). The reducer's bounded Stop guard (fn-638.1) releases the
  // worker's `working` state under the same window; this predicate runs
  // AFTER that release surfaces — predicate 5 has already cleared by
  // then, so this branch sees only the sub-agents that survived. Reads
  // the same threshold the reducer uses so the two definitions stay
  // aligned with `collapseSubagentsByName`'s structural stuck-orphan
  // notion (the client labels turn_seq-superseded rows; this predicate
  // labels temporally-old rows — both converge on the same orphaned
  // running rows).
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

  // 6.5. git-uncommitted / git-orphans — mechanical gate that blocks autopilot's
  // /plan:approve dispatch when the worker's worktree has uncommitted dirty
  // files or the project has dirty files no live session is on the hook for.
  // Lifted from the /plan:approve skill's inferred LLM-as-judge cascade into
  // this deterministic predicate.
  //
  // Gated on `worker_phase==="done"` (planctl stamped `worker_done_at`): the
  // task hasn't reached the approval window before that, so the git state
  // can't matter yet. Placed between 6 and 7 for the same race rationale as
  // predicate 7: until every worker session AND every sub-agent is actually
  // idle, the git read could capture a mid-yield Stop's stale dirty-tree
  // reading and flap the pill.
  //
  // Source of counts: the live, project-wide `git_status` row keyed by
  // `task.target_repo ?? epic.project_dir` (mirrors `effectiveRoot`'s
  // task-row resolution). The per-job `git_dirty_count` /
  // `git_unattributed_to_live_count` columns on the embedded jobs[] are a
  // historical record of what each job's last live tick saw and freeze on
  // terminal transition — reading them here would produce false
  // `git-orphans` blocks against a since-clean tree. A missing map entry
  // (no `git_status` snapshot for this root yet, or the autopilot
  // simulator's deliberately-empty map) → skip the predicate and fall
  // through to 7.
  //
  // Schema-v31 rename: the `unattributed_to_live_count` field on the
  // readiness map sources the renamed `git_unattributed_to_live_count`
  // column (legacy v28 "orphan" semantic, preserved under the new
  // vocabulary — dirty files no LIVE session is on the hook for). The
  // block-reason kind is `git-orphans` (NOT renamed) for backward
  // compatibility with autopilot consumers — see `gitStatusByProjectDir`'s
  // doc on `computeReadiness` for the column-name-vs-reason-kind
  // divergence rationale.
  if (task.worker_phase === "done") {
    const root = task.target_repo ?? epic.project_dir;
    const gs = root === null ? undefined : gitStatusByProjectDir.get(root);
    if (gs !== undefined) {
      if (gs.dirty_count > 0) {
        return { tag: "blocked", reason: { kind: "git-uncommitted" } };
      }
      if (gs.unattributed_to_live_count > 0) {
        return { tag: "blocked", reason: { kind: "git-orphans" } };
      }
    }
  }

  // 7. own-approval-pending — deliberately ranks BELOW 5/6. `worker_phase`
  // flips to "done" when planctl stamps `worker_done_at`, which can race
  // ahead of the Claude session's Stop/SessionEnd (planctl `done` returns
  // before the session exits). If `job-pending` fired here without 5/6
  // clearing first, autopilot's approval-pending notify would page the
  // human while the worker is still in-flight — exactly the bug this
  // ordering exists to prevent. Once the session's embedded job state
  // leaves `working` AND every sub-agent invocation finishes, this
  // predicate fires and the notify lands at the right moment. The reducer's
  // Stop arm carries a sub-running guard that keeps `state='working'` across
  // a parent's mid-yield Stop while a sub-agent runs — without it the
  // sequence (Stop while sub running → SubagentStop → UPS-resume → Stop)
  // would dup-clear this predicate twice (see `src/reducer.ts` Stop arm).
  if (task.approval === "pending" && task.worker_phase === "done") {
    return { tag: "blocked", reason: { kind: "job-pending" } };
  }

  // 8. dep-on-task — any upstream NOT `{ tag: "completed" }`. The pre-sorted
  // tasks order means typical intra-epic deps already have their upstream
  // verdict in `perTask`; an upstream absent from `perTask` (cross-epic dep
  // not yet folded, malformed id) counts as NOT completed → blocks.
  for (const upstream of task.depends_on) {
    const upstreamVerdict = perTask.get(upstream);
    if (upstreamVerdict === undefined || upstreamVerdict.tag !== "completed") {
      return {
        tag: "blocked",
        reason: { kind: "dep-on-task", upstream },
      };
    }
  }

  // 9. dep-on-epic — task-side rollup of the parent epic's dep list.
  // fn-635: cwd-then-global resolver via {@link resolveEpicDep}. Each
  // `depends_on_epics` entry is classified as a full id (`fn-100-foo`)
  // or a bare id (`fn-100`); full ids look up `epicById`, bare ids look
  // up `epicsByNumber` and prefer the consumer's own `project_dir` on
  // multi-match. Three resolver outcomes:
  //
  //   - `dangling` — the upstream id has no entry in `epicById` AND no
  //     bare match in `epicsByNumber` (full-id miss or bare-id miss),
  //     OR 2+ matches with no same-project disambiguator. Emit
  //     `dep-on-epic-dangling` (red pill). The ambiguity case also
  //     pushes a `ResolutionDiagnostic` onto the snapshot's diagnostics
  //     array; the dangling-via-miss cases do NOT — they're the normal
  //     "upstream genuinely unknown" signal and a JSONL log line per
  //     frame per dangling dep would flood the channel.
  //   - `found` — the resolver returned the upstream epic + a
  //     cross-project flag (basenames of consumer + upstream
  //     `project_dir` differ). Evaluate the upstream's close verdict:
  //       - `perCloseRow` has the verdict AND it's `completed` →
  //         satisfied, skip.
  //       - `perCloseRow` has the verdict AND it's non-completed →
  //         `dep-on-epic` (amber), carrying the resolved full id and
  //         the cross-project provenance for the renderer.
  //       - `perCloseRow` is missing (forward-ref in iteration order,
  //         rare) → tolerant: treat as satisfied. The upstream IS in
  //         `epicById` so it's not dangling; the close-row verdict will
  //         catch up on a subsequent snapshot fold.
  //
  // The discriminated `cross_project` payload field is null for
  // intra-project deps; the literal upstream id stays on `upstream` so
  // downstream consumers (autopilot, board) can re-look-up without
  // re-parsing the prefix.
  for (const upstreamEpic of epic.depends_on_epics) {
    const resolved = resolveEpicDep(
      upstreamEpic,
      epic,
      epicById,
      epicsByNumber,
      diagnostics,
    );
    if (resolved.kind === "dangling") {
      return {
        tag: "blocked",
        reason: { kind: "dep-on-epic-dangling", upstream: upstreamEpic },
      };
    }
    if (resolved.completed) {
      // fn-637: the upstream is done+approved. It has fallen out of the
      // default-visible page (`default_visible=0`) and reached the resolver
      // only via the completed-epics index, so it has no `perCloseRow`
      // verdict — skip without consulting it. Without this branch the
      // upstream's absence from the live index produced a false
      // `dep-on-epic-dangling` block the instant it completed.
      continue;
    }
    const upstreamClose = perCloseRow.get(resolved.epic.epic_id);
    if (upstreamClose === undefined) {
      // Tolerant forward-ref: upstream IS known (resolved), just hasn't
      // had its close-row verdict computed yet in this iteration. Treat
      // as satisfied; preserves the legacy "rare in-snapshot forward
      // case still flows" handwave.
      continue;
    }
    if (upstreamClose.tag !== "completed") {
      return {
        tag: "blocked",
        reason: {
          kind: "dep-on-epic",
          upstream: resolved.epic.epic_id,
          cross_project: resolved.cross_project,
        },
      };
    }
  }

  // 10. dep-on-task-synthetic-close — not applicable to a real task.

  // 11. single-task-per-epic — deferred to applySingleTaskPerEpicMutex.
  // 12. single-task-per-root — deferred to applySingleTaskPerRootMutex.

  return { tag: "ready" };
}

function evaluateCloseRow(
  epic: Epic,
  // See `evaluateTask` for why this is `_jobs` — schema v21's embedded
  // `JobLinkEntry.state` removed the live-jobs join, and the public
  // `computeReadiness` surface stays unchanged.
  _jobs: Map<string, Job>,
  subRunningByJobId: Map<string, SubagentInvocation[]>,
  perTask: Map<string, Verdict>,
  gitStatusByProjectDir: Map<
    string,
    { dirty_count: number; unattributed_to_live_count: number }
  >,
  // fn-638.4: caller-injected reference timestamp (unix seconds) for the
  // sub-agent staleness check at predicate 6. See `computeReadiness`'s
  // `now` doc for the determinism rationale.
  now: number,
): Verdict {
  // 1. terminal-completed (close-row variant).
  if (epic.status === "done" && epic.approval === "approved") {
    return { tag: "completed" };
  }

  // 2. epic-not-validated.
  if (epic.last_validated_at == null) {
    return { tag: "blocked", reason: { kind: "epic-not-validated" } };
  }

  // 3. planner-running.
  if (anyJobLinkRunning(epic)) {
    return { tag: "running", reason: { kind: "planner-running" } };
  }

  // 4. own-approval-rejected — the close row's own approval lives on the
  // EPIC. Rejection is permanent regardless of session state and stays at
  // rank 4; the `pending` half is split off to predicate 7 below the
  // session-running checks.
  if (epic.approval === "rejected") {
    return { tag: "blocked", reason: { kind: "job-rejected" } };
  }

  // 5. own-progress-main — close-row blocks on a running worker session at
  // EITHER scope: epic-level (close-verb) embedded jobs, OR any task-level
  // (work-verb) embedded job on a task in this epic. The task-level scan
  // matters because predicate 1 (`evaluateTask`) marks a task `completed`
  // as soon as `worker_phase==="done" && approval==="approved"` — which
  // can race ahead of the worker session's Stop/SessionEnd (planctl can
  // record `worker_done_at` and the human can approve before the session
  // exits). Without this fan-out, predicate 10 sees every task `completed`
  // and the close row flips to `ready` while a worker is still alive.
  if (anyEmbeddedJobWorking(epic.jobs)) {
    return { tag: "running", reason: { kind: "job-running" } };
  }
  for (const task of epic.tasks) {
    if (anyEmbeddedJobWorking(task.jobs)) {
      return { tag: "running", reason: { kind: "job-running" } };
    }
  }

  // 6. own-progress-sub — sub-agent invocation under ANY worker session
  // bound to this epic (close-verb at epic level, work-verb at task level).
  // Same race as predicate 5: a task's worker can still be running a
  // sub-agent after planctl/human have driven the task to completed.
  //
  // fn-638.4: same stale split as the task path's predicate 6 — render
  // `sub-agent-stale` iff every surviving running sub-agent across the
  // checked scopes (epic-level close jobs + every task-level work job)
  // is past `SUBAGENT_STALENESS_SEC` relative to `now`; otherwise
  // `sub-agent-running`. The check pools every scope so a single fresh
  // sub-agent on any task keeps the close row at `sub-agent-running`
  // (the close row is genuinely blocked on live work somewhere); the
  // close row only flips to `sub-agent-stale` once every surviving
  // sub-agent across every contributing scope is suspect.
  if (closeRowHasRunningSubagent(epic, subRunningByJobId)) {
    if (allCloseRowRunningSubagentsAreStale(epic, subRunningByJobId, now)) {
      return { tag: "running", reason: { kind: "sub-agent-stale" } };
    }
    return { tag: "running", reason: { kind: "sub-agent-running" } };
  }

  // 6.5. git-uncommitted / git-orphans — close-row variant. Gated on
  // `epic.status === "done"` (planctl stamped the epic-level done status):
  // the close row hasn't reached the approval window before that, so the
  // git state can't matter yet. Same placement rationale as the task path
  // (between 6 and 7 to avoid mid-yield Stop's stale dirty-tree readings).
  //
  // Source of counts: the live, project-wide `git_status` row keyed by
  // `epic.project_dir` (no per-row override on the synthetic close row).
  // Same rationale as the task path — the per-job `git_dirty_count` /
  // `git_unattributed_to_live_count` columns freeze on terminal transition;
  // the live `git_status` row is the honest source of truth.
  //
  // Schema-v31 rename: same column-name-vs-reason-kind divergence as the
  // task path — read `unattributed_to_live_count` (the renamed legacy v28
  // "orphan" column under its honest new name) but emit the unchanged
  // `git-orphans` reason kind for autopilot backward compatibility. See
  // the task path's predicate 6.5 comment and the `gitStatusByProjectDir`
  // doc on `computeReadiness` for the full rationale.
  if (epic.status === "done") {
    const gs =
      epic.project_dir === null
        ? undefined
        : gitStatusByProjectDir.get(epic.project_dir);
    if (gs !== undefined) {
      if (gs.dirty_count > 0) {
        return { tag: "blocked", reason: { kind: "git-uncommitted" } };
      }
      if (gs.unattributed_to_live_count > 0) {
        return { tag: "blocked", reason: { kind: "git-orphans" } };
      }
    }
  }

  // 7. own-approval-pending — close-row variant, mirrors the task path's
  // rationale: `epic.status` flips to "done" via the planctl close-verb
  // synthesis, which can race ahead of the close session's Stop/SessionEnd.
  // Placing this below 5/6 ensures `job-pending` only fires once every
  // close-verb AND work-verb session (and any sub-agent) is actually idle,
  // so autopilot's approval notify lands at the right moment.
  if (epic.approval === "pending" && epic.status === "done") {
    return { tag: "blocked", reason: { kind: "job-pending" } };
  }

  // 8. dep-on-task — not applicable to the close row (it has no direct
  // task deps; predicate 10 below synthesizes those from the epic's tasks).

  // 9. dep-on-epic — also not applicable to the close row (the spec
  // assigns cross-epic deps to the task rows; the close row's deps
  // cascade transitively through tasks).

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

  // 11. single-task-per-epic — deferred to applySingleTaskPerEpicMutex.
  // 12. single-task-per-root — deferred to applySingleTaskPerRootMutex.

  return { tag: "ready" };
}

// ---------------------------------------------------------------------------
// Post-pass mutexes
// ---------------------------------------------------------------------------

/**
 * Per-epic mutex (predicate 11). Two-pass walk over each epic's tasks in
 * pre-sorted order.
 *
 * Pass 1 — live-work claim: scan every task; if any task's verdict satisfies
 * `isLiveWorkOccupant` (i.e. one of `job-running`, `sub-agent-running`,
 * `planner-running`, `job-pending`), that task claims the epic's slot
 * regardless of iteration order. Dependency-style blocks (`dep-on-task`,
 * `dep-on-epic`), admin blocks, repo-state blocks, mutex-synthesized blocks,
 * and `unknown` do NOT claim in pass-1 — they represent waiting, not
 * concurrent worker activity.
 *
 * Pass 2 — ready tiebreak: walk the same tasks again. If pass-1 already
 * claimed the slot, every `{ tag: "ready" }` row is mutated to
 * `{ kind: "single-task-per-epic" }`. Otherwise the FIRST ready row wins the
 * slot and every LATER ready row is demoted. Rows already blocked keep their
 * more-specific reason (only `{ tag: "ready" }` is mutated).
 *
 * The close row is never considered here: predicate 10 already forces close
 * to wait until every task is completed, so close can only be `ready` when
 * no real task in the epic is non-completed → no competitor.
 *
 * Exported separately so the test suite can drive it with a hand-rolled
 * verdict map.
 */
/**
 * "Live work" predicate. A row whose verdict claims a mutex slot in pass-1
 * regardless of iteration order. The set is the running/queued states that
 * represent ACTUAL ongoing or imminent worker activity on a target — the
 * states where dispatching another job to the same scope would land us with
 * two live workers on the same target.
 *
 * Excluded: dependency blocks (`dep-on-task`, `dep-on-epic`), admin blocks
 * (`epic-not-validated`, `job-rejected`), repo-state blocks (`git-uncommitted`,
 * `git-orphans`), mutex-synthesized blocks (`single-task-per-epic`,
 * `single-task-per-root`), and `unknown` — none of those represent a live
 * worker that would conflict with a freshly-dispatched sibling.
 */
function isLiveWorkOccupant(verdict: Verdict): boolean {
  return (
    verdict.tag === "running" ||
    (verdict.tag === "blocked" && verdict.reason.kind === "job-pending")
  );
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
 * board traversal order (epics in input iteration order; per epic: pre-sorted
 * tasks then the synthetic close row). Key on the effective root:
 * `task.target_repo ?? epic.project_dir` (BOTH null AND empty-string fall
 * through to the next fallback — mirroring `scripts/autopilot.ts:206-210`
 * exactly).
 *
 * Pass 1 — live-work claim: scan every task and close row; any verdict
 * satisfying `isLiveWorkOccupant` (one of `job-running`, `sub-agent-running`,
 * `planner-running`, `job-pending`) claims its effective root regardless of
 * iteration order relative to ready siblings in other epics on the same
 * root. Dependency / admin / repo-state / mutex-synthesized blocks and
 * `unknown` do NOT claim in pass-1 — they don't represent a live worker
 * that would conflict with a freshly-dispatched sibling.
 *
 * Pass 2 — ready tiebreak: walk tasks and close rows in iteration order. If
 * the root is already claimed by pass-1, every `{ tag: "ready" }` row on
 * that root is mutated to `{ kind: "single-task-per-root" }`. Otherwise the
 * FIRST ready row per root wins the slot and every LATER ready row on the
 * same root is demoted.
 *
 * Exported separately so the test suite can drive it with a hand-rolled
 * verdict map.
 */
export function applySingleTaskPerRootMutex(
  epicsArr: Epic[],
  perTask: Map<string, Verdict>,
  perCloseRow: Map<string, Verdict>,
): void {
  const occupiedRoots = new Set<string>();

  // Pass 1: every "live work" verdict (task OR close row) claims its
  // root regardless of iteration order relative to ready siblings in
  // other epics on the same root. See `isLiveWorkOccupant` — only
  // running/queued worker activity counts; dependency / mutex-synthesized
  // blocks do not, since they don't represent a live worker that would
  // conflict with a freshly-dispatched sibling.
  for (const epic of epicsArr) {
    const projectDir = stringOrNull(epic.project_dir);

    for (const task of epic.tasks) {
      const verdict = perTask.get(task.task_id);
      if (verdict === undefined || !isLiveWorkOccupant(verdict)) {
        continue;
      }
      const root = effectiveRoot(stringOrNull(task.target_repo), projectDir);
      occupiedRoots.add(root);
    }

    const closeVerdict = perCloseRow.get(epic.epic_id);
    if (closeVerdict !== undefined && isLiveWorkOccupant(closeVerdict)) {
      const root = effectiveRoot(null, projectDir);
      occupiedRoots.add(root);
    }
  }

  // Pass 2: walk ready rows in iteration order. First ready row per root
  // wins the (still-unclaimed) slot; subsequent ready rows are demoted.
  for (const epic of epicsArr) {
    const projectDir = stringOrNull(epic.project_dir);

    for (const task of epic.tasks) {
      const verdict = perTask.get(task.task_id);
      if (verdict === undefined || verdict.tag !== "ready") {
        continue;
      }
      const root = effectiveRoot(stringOrNull(task.target_repo), projectDir);
      if (!occupiedRoots.has(root)) {
        occupiedRoots.add(root);
        continue;
      }
      perTask.set(task.task_id, {
        tag: "blocked",
        reason: { kind: "single-task-per-root" },
      });
    }

    // Close row uses the epic's project_dir directly (no per-row
    // `target_repo` on a synthetic close).
    const closeVerdict = perCloseRow.get(epic.epic_id);
    if (closeVerdict !== undefined && closeVerdict.tag === "ready") {
      const root = effectiveRoot(null, projectDir);
      if (!occupiedRoots.has(root)) {
        occupiedRoots.add(root);
      } else {
        perCloseRow.set(epic.epic_id, {
          tag: "blocked",
          reason: { kind: "single-task-per-root" },
        });
      }
    }
  }
}

/**
 * Single-root key. `target_repo` wins when non-null AND non-empty; otherwise
 * we fall through to `project_dir`. Both null/empty produces `""` — the
 * "unknown root" bucket, which collapses every rootless row into one
 * per-root slot (the safe behavior — at most one rootless row gets
 * `ready`, the rest block).
 *
 * MUST mirror `scripts/autopilot.ts:206-210` predicate exactly:
 *
 *     t.target_repo != null && seg(t.target_repo) !== "" ? seg(t.target_repo) : projectDir
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

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

// ---------------------------------------------------------------------------
// Predicate 9 helper: cwd-then-global epic-dep resolver
// ---------------------------------------------------------------------------
//
// As of fn-637.1 the resolver, its supporting helpers (`projectBasename`,
// `epicIsCompleted`, `BARE_FN_PATTERN`), and the `EpicDepResolution` type
// live in `./epic-deps` so the SAME code path is shared with the reducer
// fold (fn-637.3) without an import cycle. The `resolveEpicDep` wall-clock
// wrapper near the top of this file preserves the legacy
// `new Date().toISOString()` behavior for readiness/board callers; the
// reducer goes straight to the leaf module with an event-derived
// timestamp.

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
 * Predicate 3 (`planner-running`). Reads each link's `state` directly off
 * the embedded `JobLinkEntry` — schema v24 denormalized
 * `(title, state, last_api_error_at, last_api_error_kind)` off the linked
 * `jobs` row at the reducer's write boundary so this predicate no longer
 * needs to join against the live `jobs` page. Terminal sessions and
 * off-page live sessions used to fall through the join and silently
 * false-negative here (link.state was effectively unknown); now the
 * embedded `state` IS the projection's last-known reading and
 * `"working"` is dispositive.
 */
function anyJobLinkRunning(epic: Epic): boolean {
  for (const link of epic.job_links) {
    if (link.state === "working") {
      return true;
    }
  }
  return false;
}

function anyEmbeddedJobWorking(
  embedded: { state: string }[] | undefined,
): boolean {
  if (embedded === undefined) {
    return false;
  }
  for (const job of embedded) {
    if (job.state === "working") {
      return true;
    }
  }
  return false;
}

function anyEmbeddedJobHasRunningSubagent(
  embedded: { job_id: string }[] | undefined,
  subRunningByJobId: Map<string, SubagentInvocation[]>,
): boolean {
  if (embedded === undefined) {
    return false;
  }
  for (const job of embedded) {
    const hits = subRunningByJobId.get(job.job_id);
    if (hits !== undefined && hits.length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * fn-638.4: predicate 6 staleness companion to
 * {@link anyEmbeddedJobHasRunningSubagent}. Returns `true` iff every
 * surviving `running` `subagent_invocation` under the given embedded
 * jobs has `now - inv.ts > threshold`. Vacuous-truth on no running
 * sub-agents (the predicate-6 entry already excluded that case via
 * {@link anyEmbeddedJobHasRunningSubagent}; callers MUST gate on it
 * first). Threshold semantics match the reducer's bounded Stop guard:
 * strict `>` so the boundary tick (`now - inv.ts === threshold`)
 * doesn't yet flip the pill.
 *
 * "Every" (not "any") so a single fresh sub-agent on the same row keeps
 * the verdict at `sub-agent-running`. The point of `sub-agent-stale` is
 * "the only live work is suspect" — if even one sub-agent is fresh, the
 * row genuinely is making progress somewhere and the human shouldn't
 * see a stuck-orphan pill.
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
      if (now - inv.ts <= threshold) {
        return false;
      }
    }
  }
  return true;
}

/**
 * fn-638.4: close-row variant of
 * {@link anyEmbeddedJobHasRunningSubagent}, pooling the
 * epic-level jobs AND every task-level jobs sub-array. Used by
 * `evaluateCloseRow`'s predicate 6 so the close row stalls on any
 * surviving running sub-agent across either scope (mirroring the
 * existing close-row scan that was inlined as two separate calls before
 * the fn-638.4 stale-split). Returns `true` iff at least one running
 * sub-agent is present in any scope.
 */
function closeRowHasRunningSubagent(
  epic: Epic,
  subRunningByJobId: Map<string, SubagentInvocation[]>,
): boolean {
  if (anyEmbeddedJobHasRunningSubagent(epic.jobs, subRunningByJobId)) {
    return true;
  }
  for (const task of epic.tasks) {
    if (anyEmbeddedJobHasRunningSubagent(task.jobs, subRunningByJobId)) {
      return true;
    }
  }
  return false;
}

/**
 * fn-638.4: close-row variant of {@link allRunningSubagentsAreStale},
 * pooling every contributing scope (epic-level close jobs + every
 * task-level work jobs). Returns `true` iff EVERY surviving running
 * sub-agent across every scope is past `SUBAGENT_STALENESS_SEC` — one
 * fresh sub-agent anywhere keeps the verdict at `sub-agent-running`.
 * Callers MUST gate on `closeRowHasRunningSubagent` first; vacuous-
 * truth otherwise.
 */
function allCloseRowRunningSubagentsAreStale(
  epic: Epic,
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
 * The short form rendered inside the bracket pill. The `default` arm
 * narrows `reason` to `never` via the assertNever pattern — a future
 * `BlockReason` variant addition that forgets to add a case here is a
 * compile-time error, not a silent `unknown` fallback.
 */
function formatReasonShort(reason: BlockReason): string {
  switch (reason.kind) {
    case "job-rejected":
      return "job-rejected";
    case "job-pending":
      return "job-pending";
    case "epic-not-validated":
      return "epic-not-validated";
    case "git-uncommitted":
      return "git-uncommitted";
    case "git-orphans":
      return "git-orphans";
    case "dep-on-task":
      return `dep-on-task ${reason.upstream}`;
    case "dep-on-epic":
      // Cross-project provenance lives at the render layer — the
      // `cross_project` payload field carries the upstream's project
      // basename when it differs from the consumer's; renderer prefixes
      // the id with `<project>::`. Intra-project deps (`cross_project ==
      // null`) keep the bare-id render.
      return reason.cross_project === null
        ? `dep-on-epic ${reason.upstream}`
        : `dep-on-epic ${reason.cross_project}::${reason.upstream}`;
    case "dep-on-epic-dangling":
      return `dep-on-epic-dangling ${reason.upstream}`;
    case "single-task-per-epic":
      return "single-task-per-epic";
    case "single-task-per-root":
      return "single-task-per-root";
    case "unknown":
      return "unknown";
    default: {
      // Exhaustiveness guard. If a new BlockReason variant lands without
      // a case above, TypeScript will surface `reason` as the new variant
      // here (not narrowed to `never`), failing the type-check at build
      // time. Keeps a future fn-N addition from silently rendering
      // `unknown`.
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

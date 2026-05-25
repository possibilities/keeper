## Description

**Size:** M
**Files:** scripts/readiness.ts (new), test/readiness.test.ts (new), scripts/board.ts, README.md

### Approach

Build the pure pipeline first, prove it with a fixture-driven test matrix, then wire `scripts/board.ts` to consume it. Keep the pipeline pure (no I/O, no `Date.now()`, no closure over external state) so the same function will later power `scripts/autopilot.ts` dispatch.

Module shape:

- `computeReadiness(epics, jobs, subagentInvocations)` — pure entry. Walks epics in iteration order, for each builds per-task verdicts (10-predicate pipeline, first-match-wins), then the synthetic close row verdict, then the epic header rollup. Returns `{ perTask: Map<task_id, Verdict>, perCloseRow: Map<epic_id, Verdict>, perEpic: Map<epic_id, Verdict> }`. After the per-row pass, calls `applySingleRootMutex` as a separate exported function (testable in isolation) that groups would-be-`[ready]` rows by `task.target_repo ?? epic.project_dir` using the exact `scripts/autopilot.ts:206-210` predicate (both null AND empty-string fall through), keeps the first row per root in board traversal order, mutates the rest to `[blocked:single-root]`.
- `Verdict` is a discriminated union: `{ tag: "ready" } | { tag: "completed" } | { tag: "blocked"; reason: BlockReason }`. `BlockReason` is its own discriminated union with structured payloads (`{ kind: "dep-on-task"; upstream: string }`, `{ kind: "single-root" }`, etc.) so autopilot can later branch on tag without parsing strings.
- `formatPill(verdict): string` — separate exported helper producing the bracket pill (`[ready]`, `[completed]`, `[blocked:<reason>]`). String concerns isolated from logic.
- Defensive default: a row lookup that misses (renderer side or verdict side) renders `[blocked:unknown]` — visible bug indicator, inert for dispatch.

Predicate order (codified as a fixed list, first-match-wins early-return loop):
1. `terminal-completed` — task: `status === "done" && approval === "approved"`; close row: `epic.status === "done" && epic.approval === "approved"`.
2. `epic-not-validated` — parent `epic.last_validated_at == null` (from fn-599). Inherited on every task and close row of the epic.
3. `planner-running` — any entry in `epic.job_links` (from fn-598) whose `job_id` is in `jobs.byId` with `state === "working"`. Absent-from-collection counts as not-working (don't pessimistically block on missing jobs).
4. `own-approval` — `task.approval === "rejected"` → `[blocked:job-rejected]`; `task.approval === "pending" && task.status === "done"` → `[blocked:job-pending]`. Rejected ABOVE pending.
5. `own-progress-main` — any embedded `jobs[]` entry on this row has `state === "working"`. (Embedded array already filters by verb per `src/types.ts` invariant, so no verb check needed.)
6. `own-progress-sub` — any row in `subagentInvocations` with `job_id === <this row's worker session_id> && status === 'running'`. Strict equality on `status === 'running'` (not `!== 'ok'`).
7. `dep-on-task` — any `task.depends_on` upstream's verdict (already computed earlier in the pass — depends_on is intra-epic, so the upstream task verdict exists by the time the dependent is evaluated) is NOT `{ tag: "completed" }`. Reason: `dep-on-task <upstream_task_id>`.
8. `dep-on-epic` — any `epic.depends_on_epics` upstream's close-row verdict is NOT `{ tag: "completed" }`. Absent-from-`epics.byId` counts as satisfied (the dep is done+approved and off the board — mirrors existing `scripts/board.ts:296-297` convention). Reason: `dep-on-epic <upstream_epic_id>`.
9. `dep-on-task-synthetic-close` — for the synthetic close row only: every real task in the epic must be `[completed]`. Reason: `dep-on-task <first non-completed task_id>`.
10. `single-root` — post-pass only; applied by `applySingleRootMutex` after per-row verdicts are built.

Epic header rollup (after per-row + single-root):
- `[completed]` if close row verdict is `{ tag: "completed" }`.
- `[ready]` if any task or close row verdict is `{ tag: "ready" }`.
- Otherwise `[blocked:<reason>]` where reason comes from the first non-completed row in traversal order (pre-sorted tasks then close row).

`scripts/board.ts` integration:

- Add a third `CollectionState` in `makeState` calls (subscription id `subagent-invocations-frames`, pk strategy: use `job_id` only as the index key since predicate 6 only checks `job_id == worker.session_id`; the `byId` Map can key by composite string if the server emits one, but for predicate evaluation we just need a `job_id → row[]` lookup).
- Expand `emitFrameIfChanged`'s first-paint gate from `!epics.gotResult || !jobs.gotResult` to all three. Strict — dark board over partial paint per Priority Question 1.
- Call `computeReadiness(epics.byId, jobs.byId, subagentInvocations.byId)` once inside `emitFrameIfChanged` BEFORE `renderBody()` builds the string. Stash result in module-scope `lastReadiness` for the renderers to read.
- Update `renderJobLines`, `renderEpicBlock`'s task row, close row, and epic header line to append the pill segment after `[status] [approval]`. When verdict is `{ tag: "blocked", reason }`, append a continuation line `   (reason: <formatted-reason>)` after the row.
- Extend `teardownConnection` to reset the third state's `order` / `byId` / `queryInFlight` / `refetchDirty` and clear `lastReadiness`.
- `handleFrame`'s `error` arm: terminal iff no collection has produced a first result (defer to existing convention; with three collections, terminal means all three failed).

### Investigation targets

**Required** (read before coding):
- `scripts/board.ts:201-230` — `CollectionState` interface and `makeState` factory; clone for the third subscription.
- `scripts/board.ts:280-333` — `renderEpicBlock` and `renderJobLines`; locate exact pill insertion points after `[status] [approval]` on each row type.
- `scripts/board.ts:397-407` — `renderBody`; the call site that needs to consume the readiness map.
- `scripts/board.ts:500-516` — `emitFrameIfChanged`; first-paint gate + render call.
- `scripts/board.ts:553-596` — `handleFrame`; route the third collection's `result` / `patch` / `meta` / `error` frames.
- `scripts/board.ts:598-611` — `teardownConnection`; clear the third state and `lastReadiness`.
- `scripts/autopilot.ts:206-210` — single-root predicate to mirror exactly (both null AND empty-string fall through).
- `scripts/board.ts:151-187` — existing `approvalPill` / `planVerbLabel` / `epicNumFromId` / `taskNumFromId` helpers; reuse rather than re-paste.
- `src/types.ts:35-38` — `JobLinkEntry { kind: "creator" | "refiner"; job_id: string }` for `planner-running`.
- `src/types.ts:247-255` — `EmbeddedJob` for `own-progress-main` (state vocabulary, plan_verb is implicit by which array embeds the row).
- `src/types.ts:279-325` — `Epic` (after fn-599 lands `last_validated_at`) — also note `job_links` field.
- `src/types.ts:359-387` — `Task` (`depends_on`, `status`, `approval`, `target_repo`, embedded `jobs`).
- `test/reducer.test.ts` — bun:test convention reference for new `test/readiness.test.ts`.

**Optional** (reference as needed):
- `.planctl/specs/fn-600-subagent-invocations-from-events.md` — `subagent_invocations` collection wire shape, status vocabulary.
- `.planctl/specs/fn-599-epic-validation-pill-and-prune-clients.1.md` — what fn-599's `[validated]` / `[unvalidated]` pill render looks like (the code we're superseding).
- microsoft/lage `SimpleScheduler.getReadyTargets()` and nrwl/nx `canBeScheduled()` — pure readiness function patterns.

### Risks

- **Predicate ordering bug** — the 10 predicates can co-fire (e.g., `terminal-completed` and `own-progress-main` both true for a completed task whose SessionEnd is lagging). First-match-wins is required for stable rendering. Mitigation: predicate-ordering test matrix is acceptance-required.
- **Single-root post-pass non-determinism** — if iteration order over the verdict map is not stable, the same snapshot renders different winners across frames, flickering the pill. Mitigation: iterate in board traversal order (epics in `epics.order`, tasks in pre-sorted array order, close row last) — never iterate a `Map`'s native order without an explicit sort.
- **`subagent_invocations` row-key strategy** — the collection's pk is composite `(job_id, agent_id, turn_seq)` per fn-600.1. `CollectionState.pk` is a single string. Mitigation: pick `job_id` as the index key (predicate 6 only checks `job_id`), or compose the composite into a string key for storage and ignore for predicate 6. Verify against the actual server descriptor when fn-600.3 ships and adjust if the field name differs.
- **fn-599 land-order coupling** — fn-599 task .1 ships a `[validated]` / `[unvalidated]` pill on board.ts that this task replaces wholesale. After fn-599 lands first, this task rewrites those exact lines. Conflict risk is low (we're replacing them, not extending) but document the supersede in the task commit message so future archaeology is clear.
- **Three-subscription teardown leak** — if `teardownConnection` forgets to clear the third state, a reconnect leaves stale `subagent_invocations` rows in `byId`. Mitigation: explicit reset for all three states; covered by lint-only review of the `teardownConnection` body.

### Test notes

`test/readiness.test.ts` — pure-function, no DB needed. Build `Epic[]` / `Job[]` / `SubagentInvocation[]` records inline as fixtures; assert verdict map equality. Coverage:

- Predicate-ordering matrix: one test per ordering edge that matters. Minimum set:
  - `terminal-completed` wins over `own-progress-main` (completed task whose job is still `working`).
  - `terminal-completed` wins over `epic-not-validated` (an unvalidated epic's completed task still shows `[completed]`).
  - `epic-not-validated` wins over `planner-running` (un-validated epic with a running planner shows `epic-not-validated`, not `planner-running`).
  - `planner-running` wins over `own-approval` (planner working blocks dependent task even if its approval is approved).
  - `own-approval` `job-rejected` wins over `job-pending`.
  - `own-approval` wins over `own-progress-main` (a rejected task with a still-running job shows `job-rejected`).
  - `own-progress-main` wins over `own-progress-sub` (predicate 5 listed first).
  - `own-progress-sub` wins over `dep-on-task` (sub-agent running blocks dependents even if upstream is completed... actually predicate 6 is about THIS row's subagent, so a row with its own sub running but completed deps still shows `sub-agent-running`).
  - `dep-on-task` wins over `dep-on-epic`.
  - `dep-on-epic` wins over `single-root` (post-pass).
- Single-root: two would-be-`[ready]` tasks in the same `target_repo` → first wins, second blocks. Same with `target_repo === null` falling back to `project_dir`. Different roots → both ready. Empty-string `target_repo` AND empty-string `project_dir` → both treated as the same "" root.
- Epic header rollup: zero-task epic (close row only) — header = close row verdict. All tasks completed + close blocked → header = close row's reason. Mixed task states → header reason is first non-completed in traversal order.
- Missing inputs: a row in `epics.byId` whose verdict lookup returns undefined → `[blocked:unknown]` from the renderer side. Conversely a verdict for an id not in `epics.byId` → harmless (renderer just doesn't iterate over it).
- Dep-absent-from-collection: `task.depends_on` references a task_id not present in any `epic.tasks[]` → counts as satisfied. Same for `epic.depends_on_epics` not in `epics.byId`.
- `subagent_invocations` defensives: row with `status !== 'running'` → ignored. Row with matching `job_id` but `status === 'ok'` → ignored.

`bun test`, `bunx biome check --no-errors-on-unmatched src test scripts`, and `bunx tsc --noEmit` all pass. Manually verify by running `bun scripts/board.ts` against the live daemon and eyeballing the pills.

## Acceptance

- [ ] `scripts/readiness.ts` exports `computeReadiness`, `applySingleRootMutex`, `formatPill`, and the `Verdict` / `BlockReason` types. `computeReadiness` is pure (no I/O, no `Date.now()`, no external closure).
- [ ] All 10 predicates implemented in spec order with first-match-wins. Single-root runs as a post-pass via `applySingleRootMutex`.
- [ ] Epic header rollup matches spec: `[completed]` iff close row is `[completed]`; `[ready]` iff any task or close row is `[ready]`; otherwise `[blocked:<first non-completed row's reason>]`.
- [ ] `scripts/board.ts` opens a third subscription to `subagent_invocations`. First-paint gate strict on all three. `teardownConnection` resets the third state and `lastReadiness`. `computeReadiness` runs once inside `emitFrameIfChanged` before `renderBody`.
- [ ] Pill renders after `[status] [approval]` on task rows, close row, and epic header. Blocked rows get a continuation line `   (reason: <formatted-reason>)`.
- [ ] Defensive default `[blocked:unknown]` for verdict/renderer mismatch.
- [ ] `test/readiness.test.ts` covers: predicate-ordering matrix (every ordering edge listed in Test notes), single-root post-pass (multi-root, single-root, empty-string root coalescence), epic header rollup edge cases, missing-input defensives, dep-absent semantics, subagent_invocations status filter.
- [ ] `README.md` Example clients section updated to name the richer pill vocabulary (`[ready]` / `[completed]` / `[blocked:<reason>]`) and the three-collection subscribe.
- [ ] `bun test`, `bunx biome check --no-errors-on-unmatched src test scripts`, `bunx tsc --noEmit` all pass.
- [ ] Manual verification: `bun scripts/board.ts` against live keeperd shows the richer pills with reasons matching observed state.

## Done summary
Added scripts/readiness.ts as a pure 10-predicate first-match-wins pipeline (computeReadiness + applySingleRootMutex + formatPill/formatReasonLine over a discriminated Verdict/BlockReason union); wired scripts/board.ts to a third subagent_invocations subscription with strict first-paint gate, post-status/approval [ready|completed|blocked:<reason>] pills on task/close/epic rows plus continuation reason lines, and updated README.md. test/readiness.test.ts (34 tests) covers the full predicate-ordering matrix, single-root post-pass, epic header rollup, missing-input defensives, dep-absent semantics, and subagent_invocations status filter.
## Evidence

## Description

**Size:** M
**Files:** src/await-conditions.ts, test/await-conditions.test.ts

### Approach

Add a pure module `src/await-conditions.ts` mirroring `src/readiness.ts`'s
ethos: no I/O, no `Date.now()`, fixture-testable. Export an
`evaluateAwaitCondition(snapshot, target)` that takes a board-scoped
`ReadinessSnapshot` (plus the `epics` row list for presence + raw
completion fields) and a `target = { id, kind: "epic" | "task", condition:
"complete" | "unblocked" }`, and returns a discriminated
`AwaitState = { kind: "met" | "waiting" | "not-found" | "deleted" | "stuck"; detail?: string }`.

Define the concurrency carve-out exactly:
`workable(v) = v.tag === "ready" || (v.tag === "blocked" && (v.reason.kind === "single-task-per-epic" || v.reason.kind === "single-task-per-root"))`.
It reads correctly off the post-mutation snapshot — predicates 11/12 have
already baked those exact reason kinds in by the time the snapshot is
handed out.

- **task-unblocked**: the task's `perTask` verdict is `workable`.
- **epic-unblocked**: ANY of the epic's task verdicts OR its `perCloseRow`
  verdict is `workable` — compute from `perTask`/`perCloseRow`, NOT the
  `perEpic` rollup (the rollup hides a mutex-demoted ready task).
- **task-complete**: `task.worker_phase === "done" && task.approval === "approved"`.
- **epic-complete**: presence-driven — see below.
- **stuck**: target verdict is `blocked` with `reason.kind` in
  `{ job-rejected, dep-on-epic-dangling }` (human-only-recoverable).
- **not-found / deleted**: this module reports `not-found` when the target
  is absent from the supplied board-scoped inputs and was NOT previously
  present; the present-then-absent → `deleted`-vs-complete disambiguation
  is the command's job (it owns prior-presence state + the scope-exempt
  re-query). Keep the module a pure function of its inputs — accept a
  `priorPresence` boolean (or equivalent) so the command can drive the
  deleted/complete branch without the module doing I/O.

Reuse the `.N` epic-vs-task detection regex shape from
`scripts/board.ts` (`taskNumFromId` `/\.(\d+)$/`, epic `/^fn-(\d+)$/`,
documented in `scripts/approve.ts:152-156`) — export a small
`classifyTargetId(id)` helper here so the command doesn't re-derive it.

### Investigation targets

**Required** (read before coding):
- src/readiness.ts:260-264 — `Verdict` union (consume verbatim).
- src/readiness.ts:182-193 — `BlockReason` union; the `single-task-per-epic` / `single-task-per-root` / `job-rejected` / `dep-on-epic-dangling` kinds.
- src/readiness.ts:281-286 — `ReadinessSnapshot { perTask, perCloseRow, perEpic, diagnostics }`.
- src/types.ts — `Epic` (:755, `approval`, `tasks`), `Task` (worker_phase derived "done" when worker_done_at present; `approval`).
- test/readiness.test.ts — fixture builders `makeTask` / `makeEpic` (:44/:65) and the flat `test(...)` + `computeReadiness(...).perTask.get(id)` assertion style to mirror.

**Optional** (reference as needed):
- scripts/board.ts:877,432 and scripts/approve.ts:152-156 — `.N` detection.
- src/readiness.ts:877,943 — the mutex passes (to confirm the post-mutation reason kinds).

### Risks

- The `perEpic` rollup is a tempting shortcut for epic-unblocked but is
  wrong (post-mutex collapse hides demoted-ready tasks) — compute from the
  per-row maps. Cover this with an explicit fixture (epic whose only ready
  task got mutex-demoted ⇒ still epic-unblocked).
- Keep the module pure: the deleted/complete disambiguation needs the
  command's prior-presence + re-query, so the module must take presence as
  an input, not probe it.

### Test notes

Mirror `test/readiness.test.ts`: build epics/tasks with the local
builders, run `computeReadiness`, then assert `evaluateAwaitCondition`
returns the right `AwaitState` per condition. Cover: task/epic complete
true and false; task/epic unblocked with a genuinely-ready row; the
mutex-demoted-but-workable case for both task and epic; stuck for
job-rejected and dep-on-epic-dangling; not-found for an absent id; the
`classifyTargetId` epic-vs-task split incl. bare `fn-N`.

## Acceptance

- [ ] `src/await-conditions.ts` exports `evaluateAwaitCondition`, the `AwaitState` discriminated union, `workable`, and `classifyTargetId`, all pure (no I/O, no clock).
- [ ] `workable` treats only `single-task-per-epic` / `single-task-per-root` as unblock-eligible blocks; all other blocked/running verdicts are not workable.
- [ ] epic-unblocked is computed from `perTask` + `perCloseRow`, verified by a fixture where the sole ready task is mutex-demoted yet the epic still reads unblocked.
- [ ] complete checks read raw fields (task worker_phase+approval; epic done+approved); stuck covers job-rejected + dep-on-epic-dangling.
- [ ] `bun test test/await-conditions.test.ts` passes; `biome check` and `tsc --noEmit` clean.

## Done summary
Added pure src/await-conditions.ts mirroring readiness.ts's no-I/O/no-clock ethos. Exports evaluateAwaitCondition + AwaitState discriminated union + workable() (concurrency carve-out: only single-task-per-epic / single-task-per-root count as workable) + classifyTargetId. Epic-unblocked reads off perTask+perCloseRow (NOT perEpic rollup) — pinned with a demoted-but-workable regression fixture. Stuck covers job-rejected + dep-on-epic-dangling. 40/40 tests pass; biome + tsc clean.
## Evidence

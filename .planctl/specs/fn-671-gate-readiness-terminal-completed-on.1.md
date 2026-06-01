## Description

**Size:** M
**Files:** src/readiness.ts, test/readiness.test.ts, CLAUDE.md

### Approach

Add a two-clause worker-liveness guard to `evaluateTask` predicate 1 so
it only returns `{tag:"completed"}` when the worker is genuinely idle:

```ts
if (
  task.worker_phase === "done" &&
  task.approval === "approved" &&
  !anyEmbeddedJobWorking(task.jobs) &&
  !anyEmbeddedJobHasRunningSubagent(task.jobs, subRunningByJobId)
) {
  return { tag: "completed" };
}
```

Both helpers are already in scope inside `evaluateTask` — no new imports,
no signature change. When a clause fails, the task falls through to
predicate 5 (`job-running`) or 6 (`sub-agent-running` / `sub-agent-stale`),
all `running` tags that occupy the per-epic and per-root mutex via
`isLiveWorkOccupant` / `isRootOccupant`. This mirrors predicate 7
(own-approval-pending), which is already ordered below 5/6 for the same
race. Tag the new behavior with this epic's `fn-N` in the comment per
house style.

DECISION (locked with the human): the close-row task-level fan-in
(`src/readiness.ts:787-794`) and `closeRowHasRunningSubagent`'s
completed-task loop become provably unreachable after this guard (a
`completed` task can no longer have a `working` job or running sub-agent).
KEEP that code in place as a re-fold-determinism backstop — do NOT delete
it. Only rewrite its JSDoc to say "normally unreachable after the
per-task guard; retained as a backstop if a future change ever lets the
two states coexist."

JSDoc sync (load-bearing — the next reader inherits stale spec
otherwise): update the module-top predicate table (lines 13-14), the
predicate-1 block comment (494-500), the `evaluateCloseRow` JSDoc
(698-724) and its predicate-5 comment (766-783), and the
`applySingleTaskPerRootMutex` fn-655 JSDoc (1010-1062) so the per-task
claim reads as the primary lock path. Add one operational bullet to
CLAUDE.md's "Autopilot dispatch gates" section (edit CLAUDE.md in place;
it is symlinked as AGENTS.md — never rm+recreate).

### Investigation targets

**Required** (read before coding):
- src/readiness.ts:494-500 — predicate 1, the exact fix site
- src/readiness.ts:520-557 — predicates 5/6 (fall-through targets; 6 splits sub-agent-running vs sub-agent-stale, both `running`)
- src/readiness.ts:604-619 — predicate 7, the ordering precedent this mirrors
- src/readiness.ts:939-967 — `isLiveWorkOccupant` / `isRootOccupant` (why `completed` occupies nothing and `running:*` does)
- src/readiness.ts:1063-1144 — `applySingleTaskPerRootMutex` (where the fix's value is realized; pass-1 claim + epic-level gate at 1096-1105)
- src/readiness.ts:1276-1304 — `anyEmbeddedJobWorking` / `anyEmbeddedJobHasRunningSubagent` (reuse as-is)
- src/readiness.ts:787-794, 698-724, 1010-1062 — close-row fan-in + JSDoc to narrow (KEEP code, narrow prose)
- test/readiness.test.ts:216-226 — the must-flip test ("predicate 1 wins over 5") that encodes the OLD buggy intent
- test/readiness.test.ts:2245-2343 — analog close-row race tests to mirror for the per-task path
- test/readiness.test.ts:44-210 — fixture builders (makeTask/makeEpic/makeEmbeddedJob/makeSub) + `run()` / `runWithNow()` harness

**Optional** (reference as needed):
- src/exit-watcher.ts — confirms the `Killed` crash backstop for the main-job wedge window
- CLAUDE.md "Autopilot dispatch gates" — the bullet style to match

### Risks

- The test at test/readiness.test.ts:216-226 asserts the OLD (buggy)
  intent (`done+approved+working → completed`). The fix INVERTS it —
  flip/rename it, do not patch around it, or the build goes red.
- `sub-agent-stale` keeps occupying the mutex by design (correctness over
  throughput). A sub-agent that dies silently and never emits SubagentStop
  has no `Killed`-equivalent backstop, so it holds the per-root slot until
  autopilot pause / manual clear. This is the accepted trade — do NOT add
  a sub-agent reaper in this fix (separate concern). State it in the
  JSDoc / CLAUDE.md bullet so the behavior is documented, not surprising.
- Six JSDoc sites + one CLAUDE.md bullet must move together; the close-row
  fan-in is KEPT (prose narrowed), not deleted.
- Determinism: the guard reads only projection state + the injected `now`
  (readiness is a client computation, not a reducer fold) — confirm no new
  wall-clock/env/fs read sneaks in. `now` default `NEGATIVE_INFINITY` in
  bare `run()` means the staleness branch never fires there.

### Test notes

Mirror the close-row race tests at 2245-2343 for the per-task path,
asserting on `snap.perTask.get(task.task_id)`:
- done+approved + `working` job → `running:job-running` (use `run()`)
- done+approved + stopped job + running sub-agent → `running:sub-agent-running` (use `run()`)
- done+approved + stale sub-agent → `running:sub-agent-stale` (use `runWithNow()` so `now - inv.ts > SUBAGENT_STALENESS_SEC`)
- done+approved + stopped job + no sub-agents → `completed` (clean-collapse; mutex frees)
- per-root mutex: the now-`running` completed-but-live task occupies the slot and demotes a sibling ready task on the same root to `single-task-per-root`
- regression: T1 done+approved+session-still-`working`, T2 `depends_on` T1 → T2 must NOT be `ready` (the exact incident)
- `makeEmbeddedJob` and `makeSub` both default `job_id:"session-1"`, so a no-override pair already lines up for `subRunningByJobId` keying.

## Acceptance

- [ ] Predicate 1 returns `completed` only when `worker_phase==="done" && approval==="approved" && !anyEmbeddedJobWorking(task.jobs) && !anyEmbeddedJobHasRunningSubagent(task.jobs, subRunningByJobId)`
- [ ] done+approved + `working` job → `running:job-running`; occupies per-epic AND per-root mutex; dependent/sibling ready task on the same root demoted
- [ ] done+approved + running sub-agent → `running:sub-agent-running`; stale → `running:sub-agent-stale` (asserted via `runWithNow`)
- [ ] done+approved + idle → `completed`; mutex frees; sibling dispatches
- [ ] Regression test (T1 live, T2 depends on T1 → T2 not ready) added and green
- [ ] test/readiness.test.ts:216-226 flipped/renamed; the five new per-task tests added; `bun test test/readiness.test.ts` green; full `bun test` green
- [ ] JSDoc updated at lines 13-14, 494-500, 698-724, 766-783, 1010-1062; close-row fan-in code KEPT with narrowed prose; one CLAUDE.md autopilot-dispatch-gates bullet added (CLAUDE.md edited in place, AGENTS.md symlink intact)
- [ ] No schema bump, no migration, no keeper-py change

## Done summary

## Evidence

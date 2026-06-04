## Description

**Size:** S
**Files:** src/readiness.ts, test/readiness.test.ts, CLAUDE.md

### Approach

Add a new `BlockReason` variant `{ kind: "epic-no-tasks" }` to the union
(`src/readiness.ts:203-214`) and a matching
`case "epic-no-tasks": return "epic-no-tasks";` in `formatReasonShort`
(`:1529`) — mandatory for the `assertNever` exhaustiveness guard at
`:1566`, and it lands the pill label + colorization for free (the generic
`blocked:` → warn branch in `src/board-render.ts:321`).

In `evaluateCloseRow` (`:775`), add a guard
`if (epic.tasks.length === 0) return { tag: "blocked", reason: { kind: "epic-no-tasks" } };`
placed **immediately before predicate 10's `for (const task of
epic.tasks)` loop** (`:933`) — i.e. AFTER predicates 1–7 — so every
more-specific verdict still wins (`completed`, `epic-not-validated`,
`planner-running`, `job-rejected`, `job-running` / `sub-agent-running`,
`git-uncommitted`, `job-pending`). This catches exactly the vacuous
fall-through to `ready` (`:946`) and nothing else. Carry the same
numbered / rationale comment discipline as the surrounding predicates,
noting the deliberate LATE rank (this refines the initial "place it first"
proposal — first-placement would mask `epic-not-validated` on a
pre-EpicSnapshot stub and `planner-running` during active scaffolding, and
perturbs existing predicate-2-precedence tests).

No change to `src/autopilot-worker.ts` — `verbForVerdict` (`:618`) already
returns `null` for every blocked reason except `job-pending`, so a blocked
close row is non-dispatchable by construction.

Also add the `epic-no-tasks` bullet to CLAUDE.md "Autopilot dispatch
gates" (git-uncommitted bullet style). Root-caused by the
`autopilot-dispatch-timing-issue` investigation; that collaborator
implements this task.

### Investigation targets

**Required** (read before coding):
- src/readiness.ts:775-946 — `evaluateCloseRow`; predicate ordering, the
  vacuous loop at `:933`, fall-through at `:946`.
- src/readiness.ts:203-214 — `BlockReason` union.
- src/readiness.ts:1529-1570 — `formatReasonShort` assertNever switch.
- src/autopilot-worker.ts:618 — `verbForVerdict` (confirm `null` for
  blocked; the regression test asserts this).
- test/readiness.test.ts:65 (`makeEpic`, defaults `tasks:[]`), :182
  (`blocked` helper), :190 (`run`), :784-806 (canonical close-row test).

**Optional** (reference as needed):
- src/readiness.ts:1257-1318 — `rollupEpicHeader` (inherits `closeVerdict`
  — assert, do not patch).
- test/readiness.test.ts:380 — existing predicate-2-precedence test.

### Risks

- **Predicate misplacement.** Placing the guard first would mask
  `epic-not-validated` (pre-EpicSnapshot stub) and `planner-running`
  (active scaffolding), and break the predicate-2-precedence test at
  test/readiness.test.ts:380. Mitigate by placing it late (before
  predicate 10) and writing the zero-task test with `last_validated_at`
  SET so predicate 2 doesn't mask it.

### Test notes

- New: a validated, open, zero-task epic →
  `perCloseRow.get(epic_id)` toEqual `blocked({kind:"epic-no-tasks"})`.
  `makeEpic` already defaults `tasks:[]`.
- Precedence: an UNvalidated zero-task epic still reports
  `epic-not-validated` (not `epic-no-tasks`).
- Rollup: `perEpic.get(epic_id)` also surfaces `blocked:epic-no-tasks`
  for the zero-task epic (no rollup code change).
- Regression (autopilot lock):
  `verbForVerdict("close", <zero-task close verdict>) === null` — locks
  the autopilot side to the readiness fix so a future verdict refactor
  can't silently re-open the hole.

## Acceptance

- [ ] `BlockReason` union includes `{ kind: "epic-no-tasks" }`.
- [ ] `formatReasonShort` returns `"epic-no-tasks"` (assertNever compiles).
- [ ] `evaluateCloseRow` returns `blocked:epic-no-tasks` for a validated
  zero-task epic, placed before predicate 10.
- [ ] Unvalidated zero-task epic still reports `epic-not-validated`
  (precedence preserved).
- [ ] `rollupEpicHeader` surfaces `blocked:epic-no-tasks` (no rollup code
  change).
- [ ] `verbForVerdict("close", <zero-task close verdict>)` returns `null`.
- [ ] CLAUDE.md "Autopilot dispatch gates" documents `epic-no-tasks`.
- [ ] `bun test test/readiness.test.ts` passes.

## Done summary
Added BlockReason variant epic-no-tasks with a rank-9.5 guard in evaluateCloseRow so a validated zero-task epic blocks instead of vacuously falling through to ready; locked the autopilot side via verbForVerdict and documented the gate in CLAUDE.md.
## Evidence

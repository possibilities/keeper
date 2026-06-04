## Overview

A keeper epic and its tasks fold as two separate single-event
transactions (`EpicSnapshot`, then `TaskSnapshot`). Between them an epic
exists with **zero tasks**. `evaluateCloseRow` (`src/readiness.ts`) requires
"every task completed" via a `for…of epic.tasks` loop that is **vacuously
true over an empty list**, so the close-row verdict falls through to
`ready`. The autopilot reconciler is level-triggered on `PRAGMA
data_version`; a reconcile that lands in this window dispatches the closer
(`verbForVerdict` emits `close` on `ready`) against an epic with no work —
observed live on fn-698 (closer + worker dispatched ~8s apart). This is
functionally a vacuous-ACL / auth-bypass-on-empty-collection bug in a
dispatch gate.

This epic closes the hazard with an explicit readiness block reason
`epic-no-tasks` and, per the "show it blocked" decision, makes the board
render half-scaffolded epics **legibly** — a pre-`EpicSnapshot` stub epic
renders a blank `(keeper)  [unvalidated]` line today. End state: a taskless
epic is never dispatchable (close row reads `[blocked:epic-no-tasks]`) and
always renders with a readable, clearly-blocked header row (never hidden).

A vacuous-empty sweep confirmed this close-row predicate is the **only**
live instance — every other `epic.tasks` consumer is safe (mutex/occupancy
helpers init negative; autopilot is verdict-driven; await-conditions
presence-driven). No reducer / schema / keeper-py change: the `Verdict` is
computed client-side at read time, not folded — no re-fold-determinism
concern.

## Quick commands

- `bun test test/readiness.test.ts`
- `bun test test/board.test.ts`
- Manual: scaffold a fresh epic, confirm its close row shows
  `[blocked:epic-no-tasks]` until its task folds, then `dep-on-task`.

## Acceptance

- [ ] A validated, open, zero-task epic yields close-row verdict
  `blocked:epic-no-tasks` (not `ready`).
- [ ] `verbForVerdict("close", <zero-task close verdict>)` returns `null` —
  autopilot cannot dispatch the closer.
- [ ] More-specific verdicts still win for a taskless epic (`completed` /
  `epic-not-validated` / `planner-running` precedence preserved).
- [ ] `rollupEpicHeader` (`perEpic`) surfaces `blocked:epic-no-tasks` for a
  zero-task epic, with no rollup code change.
- [ ] The board renders a zero-task / stub epic with a legible header
  (`epic_id` fallback when `epic_number`/`title` are null), clearly blocked
  — no blank `(keeper)  [unvalidated]` line, and the row is not hidden.
- [ ] Docs updated: CLAUDE.md autopilot dispatch gates, `cli/board.ts`
  doc-comment, README BlockReason vocabulary.

## Early proof point

Task that proves the approach: task `.1` (readiness guard). If it fails, the
predicate-ordering precedence is wrong — recovery: place the guard
immediately before predicate 10 so ONLY the vacuous `ready` fall-through is
caught and every more-specific verdict still wins.

## References

- Root cause + event-log proof and the vacuous-empty sweep were produced by
  the `autopilot-dispatch-timing-issue` investigation (collaborator); that
  collaborator implements task `.1`.
- `src/readiness.ts:933` (predicate 10 vacuous loop), `:946` (`ready`
  fall-through), `:203` (BlockReason union), `:1529` (formatReasonShort
  assertNever switch), `:1257` (rollupEpicHeader).
- `src/autopilot-worker.ts:618` (verbForVerdict — `close` only on `ready`).
- `cli/board.ts:697` (epic header assembly), `:562` (seg helper), `:682`
  (epicId), `src/board-render.ts:321` (blocked:→warn colorize branch).

## Docs gaps

- **CLAUDE.md / AGENTS.md "Autopilot dispatch gates"**: add an
  `epic-no-tasks` bullet (close-row block + predicate rank) following the
  `git-uncommitted` bullet style. (Owned by task `.1`.)
- **cli/board.ts module doc-comment**: name `epic-no-tasks` in the
  readiness-pill vocabulary and update the epic-header format line to
  reflect the `epic_id` fallback. (Owned by task `.2`.)
- **README.md board render / BlockReason vocabulary**: add `epic-no-tasks`
  and the header fallback so `grep epic-no-tasks README.md` hits. (Owned by
  task `.2`.)

## Best practices

- **Explicit non-empty guard:** gate completion as
  `tasks.length > 0 && tasks.every(done)`, never the bare `every` — empty-
  collection vacuous truth is the canonical form of this bug.
- **Model the partial-projection window:** an empty child collection between
  parent/child folds is a named blocked state, not readiness; no time-based
  waits.
- **assertNever exhaustiveness:** the new union variant must land a
  `formatReasonShort` case (compile-time guard).
- **Security framing:** a vacuous "all items satisfy P" check gating
  dispatch is equivalent to auth-bypass-on-empty-collection.

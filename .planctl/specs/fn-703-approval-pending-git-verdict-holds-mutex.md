## Overview

A done-but-unapproved task whose target repo is dirty renders a
`git-uncommitted`/`git-orphans` verdict (readiness predicate 6.5). Those
verdicts are not mutex occupants today, so the task releases its
per-epic/per-root slot mid-approval-window and a depless sibling jumps the
queue (observed live as "task 3 running before task 2" on fn-1). This epic
makes the whole approval-pending window hold the mutex by widening the
shared occupant predicate, then extends the same occupancy to the close-row
path for full symmetry. Render and dispatchability are untouched; this is a
readiness.ts-only, client-side-verdict change — no schema/reducer/keeper-py.

## Quick commands

- `bun test test/readiness.test.ts`

## Acceptance

- [ ] A done+pending+dirty task (git verdict) holds its per-epic slot and claims its per-root slot, demoting ready siblings.
- [ ] A quiescent done-but-unapproved epic on a dirty repo (close-row git verdict) holds its root against a sibling epic's ready task.
- [ ] Rendered verdicts unchanged; `verbForVerdict` still returns null for git verdicts (held slot stays undispatchable).
- [ ] No schema/reducer/keeper-py change; no new `BlockReason` variant.
- [ ] readiness.ts JSDoc + ladder header + CLAUDE.md occupancy docs reflect the new behavior with no contradictions.

## Early proof point

Task that proves the approach: `.1` — the task-level widening plus a regression test reproducing the observed task-3-before-task-2 case. If it fails: the verdict-only occupant predicate isn't the right cut point — fall back to threading a compound `worker_phase==="done" && approval==="pending"` condition through the mutex passes.

## References

- `src/readiness.ts` predicate ladder; fn-671 ("won't release the mutex while the worker session is still alive") is the structural precedent — same failure class (administrative state racing the mutex), one rank lower.
- fn-701 (in-progress) — conceptual coupling on `git-uncommitted` semantics (its approval-RPC convergence reasoning assumes git-blocked tasks don't hold a sibling's slot); this epic depends on fn-701 to avoid rebasing that mental model. No file collision (fn-701 edits `src/plan-worker.ts`).
- Out of scope — "Finding B": fresh work dispatching into a dirty repo (predicate 6.5 is `worker_phase==="done"`-gated, and `verbForVerdict` returns "work" for a fresh ready task, so the documented "won't dispatch into a dirty repo" invariant only actually holds for the approve verb). Different fix shape, much larger blast radius — its own epic.

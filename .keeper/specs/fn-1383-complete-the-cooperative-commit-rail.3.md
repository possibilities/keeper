## Description

**Size:** S
**Files:** plugins/plan/src/verbs/unblock.ts, plugins/plan/src/verbs/done.ts

### Approach

`runUnblock` unconditionally writes `status:"todo"` (plugins/plan/src/verbs/unblock.ts:57-63),
so the AUDIT_READY park → supervisor unblock cycle loses in_progress and the finished
worker's `plan done` refuses (`not in_progress, status: todo`) — the phase-14-proven
recovery (unblock → claim → done from the repo vantage) burns operator time every
occurrence. Fix the state machine at one of the two sanctioned points: unblock
preserves/restores `in_progress` when the claimant session is live-or-recent, or
`done` accepts a todo task carrying a same-session landed commit + audit receipt
(plugins/plan/src/verbs/done.ts:121,255-296 currently writes done with no such path).
Pick the narrower change that keeps `done`'s evidence discipline intact — never a
blanket todo-accepts-done.

**RE-VERIFY AT CLAIM TIME against fn-1352 (retire-escalation-sessions):** that epic
reshapes block/unblock surfaces; if it has landed or is in flight on these files,
park DEPENDENCY_BLOCKED naming the overlap instead of racing it.

### Investigation targets

*Verify before relying — the repo moves.*

**Required** (read before coding):
- plugins/plan/src/verbs/unblock.ts:57-63 — the unconditional todo write
- plugins/plan/src/verbs/done.ts:121,255-296 — the status gate and evidence write
- ~/docs/keeper-phase2-backlog.md #70 — the fn-4.3 live specimen and the proven recovery

### Risks

- Plans are READ-ONLY from the daemon side; these are plan-CLI verbs — keep the fix in the verbs, no new RPC
- Do not let a stale claim resurrect in_progress for a dead claimant (reuse the lifecycle-tail terminal proof semantics)

### Test notes

Verb tests: unblock of a live-claimant in_progress task preserves progress; unblock of a dead-claimant
task still resets; the finished-worker done path lands with evidence. Named gates.

## Acceptance

- [ ] The park → unblock → done cycle completes without an operator claim/done ritual, and evidence discipline is preserved
- [ ] A dead-claimant unblock still resets to todo
- [ ] Suites green via named gates

## Done summary

## Evidence

## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/worktree-git.ts, src/dispatch-failure-key.ts, CLAUDE.md, test/ (fold + worker tests)

### Approach

Producer-side dedup: before posting DispatchFailed (autopilot-worker.ts:4332-4356 via
emitDispatchFailed:4104-4109), consult a per-(verb,id,reason) change-gate keyed like the
existing lastWorktreeStatusKey closure (:4116-4131) — emit on first appearance and on
reason-change; suppress identical re-emits while the condition persists; emit a bounded
still-stuck watermark (e.g. every N cycles) rather than silence forever; DispatchCleared on
resolution stays immediate and resets the gate. Accepted degradation (state it in code
comment + spec): a daemon restart clears the gate and re-emits one event per still-present
condition — bounded burst; a crash-looping daemon regresses toward the old behavior, which is
its own louder alarm. Fix the reason-ordering bug: mergeReadiness (worktree-git.ts:539-558)
checks off-branch before dirty, so a checkout that is both reports not-on-default and masks
the actionable dirty state — check dirty first or report both conditions in one reason.
Update reason strings for actionability through src/dispatch-failure-key.ts's typed router
(DISPATCH_FAILURE_DISPLAY_RULES): keep prefixes collision-free (no entry a prefix of another),
keep the worktree-recover* auto-clear prefix contract intact, and satisfy the assertNever
tripwire. Make the corresponding line-surgical edit to root CLAUDE.md's autopilot paragraph
(lint-gated — minimal delta).

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:4104-4131,4332-4356 — emit sites + the change-gate precedent
- src/worktree-git.ts:539-558 — the ordering bug
- src/dispatch-failure-key.ts — routeDispatchFailure, display rules, prefix constraints
- src/autopilot-worker.ts:3010,3017,3045,3059 + finalizeEpic:2412-2473 — every reason mint

**Optional** (reference as needed):
- daemon.ts:4976-5026, reducer.ts:3967-3999 — the mint + UPSERT the gate protects

### Risks

- The reducer and auto-clear logic key on reason prefixes; a reworded reason must keep the worktree-recover* prefix family for the auto-clear scope and never collide with worktree-finalize keys.
- Suppression must never swallow a REASON CHANGE (dirty→conflict is new information, emit it).

### Test notes

Worker-side unit tests on the gate (first-emit, suppress, reason-change, clear-reset,
watermark cadence) through pure seams; refold-equivalence stays green (no reducer change);
simulate the fn-7 shape: one stuck condition over many cycles yields O(1) events + watermarks.

## Acceptance

- [ ] Persistent unchanged condition: one emit + bounded watermarks; reason change: immediate emit; clear: immediate
- [ ] Dirty+off-branch checkout reports the dirty cause; display rules updated, prefixes collision-free, assertNever satisfied
- [ ] Root CLAUDE.md autopilot paragraph updated minimally; lint-claude-md green

## Done summary

## Evidence

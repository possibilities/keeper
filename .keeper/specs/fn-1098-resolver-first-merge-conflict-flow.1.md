## Description

**Size:** M
**Files:** src/daemon.ts, src/autopilot-worker.ts, plugins/keeper/skills/autopilot/SKILL.md, test/daemon.test.ts

### Approach

Sequence the two sweeps that today fire independently on a sticky worktree-merge-conflict
row. The resolver-dispatch sweep (gated on resolver_dispatched_at) stays first and
unchanged. The merge-escalation sweep (gated on merge_escalated_at) must additionally
require a terminal resolver outcome: the resolve::<epic> job for that row stamped BLOCKED
/ declined, or died without resolving. While a resolver is live or not yet dispatched, the
escalation waits. Both stamps still re-arm only via retry_dispatch. Preserve: the sticky
row itself is never auto-cleared by either sweep; the resolver's authority stays narrower
than a human's (mechanically-clear only); the close audit is unchanged whichever path
resolves. Also close the exclusion gap for the far-edge case where BOTH act: the
escalation body (pause-first directive text) must state whether a resolver is in flight
and tell the operator to wait for its verdict — pause stops the recover sweep and new
dispatches but NOT an in-flight resolver, so say so. Add matching planner-side guidance
(autopilot skill escalation runbook): on a merge-conflict escalation, check for a live
resolve:: job and defer to its verdict.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts — the merge-escalation sweep (merge_escalated_at gate) and the sibling resolver-dispatch sweep (resolver_dispatched_at); buildMergeEscalationBody pause-first text
- src/autopilot-worker.ts — resolver job identification (plan_verb resolve), epicHasActiveResolver precedent (grep -a required, high-byte chars)
- test/daemon.test.ts — existing sweep tests to extend with the sequencing axes

### Risks

- A resolver that hangs forever (never BLOCKED, never dead) would starve the human
  escalation — bound the wait (job liveness/reap already flips dead jobs; rely on that,
  never a new timer class).

## Acceptance

- [ ] On a fresh sticky merge-conflict row, the resolver dispatches and NO planner escalation is sent while its job is live
- [ ] The planner escalation fires exactly once after the resolver stamps BLOCKED or its job reaps dead
- [ ] The escalation body names the resolver's verdict and warns that pause does not stop an in-flight resolver
- [ ] retry_dispatch re-arms both stamps as today; bun test green

## Done summary

## Evidence

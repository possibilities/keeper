## Description

**Size:** S
**Files:** src/daemon.ts, test/daemon.test.ts

### Approach

The resolver- and deconflict-dispatch sweeps must not launch an escalation session
whose resolved cwd (the merge-conflict base checkout) is already occupied by a
live escalation session: the launch is SKIPPED — non-terminal and re-sweepable,
exactly like the existing at_cap/already_live skip outcomes — so no once-marker is
stamped, no dispatch_failures row is minted, and the level-triggered re-sweep
dispatches it once the occupying session reaches a terminal state. The occupancy
probe rides the machinery the cap already uses (live escalation jobs off the jobs
projection plus the in-flight launch memo), keyed by the resolved checkout dir.
The escalation-role posture is role-keyed (diagnosis-only vs write-capable
classes); verify which session classes actually occupy a checkout today and gate
every class that recreates a merge in it.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but this
file moves frequently.*

**Required** (read before coding):
- src/daemon.ts:1675-1685 — EscalationDispatchOutcome skip vocabulary
  (at_cap/already_live) + MAX_LIVE_ESCALATION_SESSIONS: the guard is a sibling
  skip outcome
- src/daemon.ts:2351 — runResolverDispatchSweep; src/daemon.ts:1868 —
  runMergeEscalationSweep: the two sweeps to gate
- src/daemon.ts:2565 — dispatchEscalationSession: the shared cap+occupancy
  dispatch path the guard extends
- src/daemon.ts:9064 — inFlightEscalations memo (launched-but-not-yet-folded
  keys); src/daemon.ts:9704 dispatchResolver + :9140 dispatchDeconflict — cwd
  resolution via mergeConflictBaseCheckout (the key the guard groups on)
- test/daemon.test.ts — the escalation sweep test cluster (injectable-deps
  pattern; add same-checkout serialization + cross-repo concurrency cases)

## Acceptance

- [ ] With two sticky merge conflicts in the same repo, only one escalation
      session whose cwd is that repo's shared checkout is live at a time; the
      second dispatches only after the first reaches a terminal state
- [ ] The deferred dispatch is a pure skip: no once-marker stamped, no
      dispatch_failures row minted, and the row re-sweeps to a successful
      dispatch once the checkout frees
- [ ] Sticky conflicts in different repos dispatch their sessions concurrently
      (the guard is per checkout, never global)
- [ ] Full fast suite green (bun test)

## Done summary

## Evidence

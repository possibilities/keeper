## Description

Addresses finding F1 against `src/daemon.ts`. The resolver worker's
mutual-exclusion against the recover sweep rides the GLOBAL autopilot
pause: `buildResolverBrief` emits step 0 `keeper autopilot pause` (daemon.ts:1326)
and a terminal `keeper autopilot play` (daemon.ts:1345), while
`runResolverDispatchSweepTick` reads `autopilotPaused` once at tick start
(daemon.ts:6432) and dispatches one resolver per pending row.

Two confirmed robustness edges follow. (1) N simultaneously-stuck
merge-conflict closes launch N resolvers in one tick; whichever calls
`play` first re-arms the recover sweep while the others are still
mid-merge. (2) A resolver that pauses at step 0 then dies/reaps before its
terminal `play` leaves the board DURABLY paused (pause is durable per the
reconciler contract), silently halting all autopilot work — across every
unrelated epic — until a human notices the `[paused]` banner.

Harden the exclusion so a crashed or concurrent resolver cannot durably
strand or race the global board. Candidate directions (pick per the
reconciler contract): scope the exclusion to the epic's recover key rather
than the global pause; serialize dispatch to one resolver in-flight; or
bound/auto-recover a resolver-induced pause. Leave the independent
merge-escalation notify and close audit paths untouched.

## Acceptance

- [ ] A resolver crash after step-0 pause and before terminal play cannot durably pause autopilot for unrelated epics.
- [ ] Concurrent stuck fan-ins cannot let one resolver's play re-arm the recover sweep while another is mid-merge.
- [ ] The merge-escalation notify and close audit paths are behaviorally unchanged.

## Done summary
Scoped the merge-resolver's mutual-exclusion per-epic: recover pass-1 now skips a lane whose epic has a live resolve::<epic> job (epicHasActiveResolver), replacing the resolver brief's global autopilot pause/play. A crashed resolver strands nothing (auto-lifts on reap) and concurrent fan-ins stay independent.
## Evidence

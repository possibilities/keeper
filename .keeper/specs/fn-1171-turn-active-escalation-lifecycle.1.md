## Description

**Size:** M
**Files:** src/daemon.ts, test/daemon.test.ts

### Approach

Replace process-liveness with turn-activity for the escalation verbs: a session is occupancy-live iff `jobs.state === 'working'`, unioned with the in-flight launch memo at every consumer. `escalationJobLive`'s stopped-with-live-backend arm (which calls `isStoppedJobLive(job, null)` — unconditionally true) is what starves the guards; `isStoppedJobLive` itself must stay untouched for every other verb. Wire the new predicate into the four consumers: the global cap counter, the per-key occupancy guard, the per-epic serialization guard, and the stage-3 classifier's liveness arm. The per-epic serialization guard is kept — only its liveness input changes.

In the same pass, replace `classifyEscalationOutcome`'s verdict derivation: the current `sawEnded ? declined : died` is unreachable (a clean decline stops the turn, never exits the CLI). New derivation: `declined` = no live row AND the incident is still open (task still blocked under an `'attempted'` latch — the caller pre-computes this board-state boolean and passes it, keeping the classifier pure over its inputs); `died` = a `killed`/`ended` row with the incident open. The invariant to preserve: `{terminal:false}` while any row is turn-active or no row has folded yet (the launch window).

Include the permission-parked pin: an explicit test that drives a session through a mid-turn permission prompt (fold the hook events through the reducer via `freshMemDb` + applyEvent) and asserts `jobs.state` remains `'working'` until Stop. If that pin FAILS (parked presents as `stopped`), stop and extend the predicate with a parked-marker live arm (`stopped` + `last_permission_prompt_at`/`last_input_request_at` set counts live) before shipping — and note the marker-staleness hazard: markers may persist after the turn ends, so the arm must be evidence-bounded, not unconditional.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:1917 — escalationJobLive, the predicate being replaced
- src/daemon.ts:1927,1943,1959 — countLiveEscalationSessions / escalationSessionLiveFor / epicHasLiveUnblock, three of the four consumers
- src/daemon.ts:1979 — classifyEscalationOutcome, the fourth consumer + verdict derivation
- src/daemon.ts:8163-8218 — the in-flight memo; the union with it at each call site is why the current guard never double-dispatches; preserve it at every consumer, not just inside the pure fn
- src/reconcile-core.ts:1266 — isStoppedJobLive, the shared rule that must NOT change for work/close/resolve

**Optional** (reference as needed):
- test/daemon.test.ts:4266-4280,5260-5335 — existing classifier/liveness suites over hand-built Job[] arrays
- test/daemon.test.ts:5285 — the ended→declined case whose shape changes
- test/daemon.test.ts:5340 — fakeEscalationDispatchDeps pattern

### Risks

- The permission-parked pin is load-bearing: if parked sessions present as `stopped`, plain turn-activity frees slots prematurely — the spec's fallback arm handles it, but do not ship the predicate with the pin unresolved.
- The stage-3 classifier consumer is the one site with no memo union today; the verdict change must not make a not-yet-folded launch classify terminal.

### Test notes

Extend the hand-built Job[] suites: stopped-idle session frees cap/occupancy/per-epic slots; working session occupies; decline scenario (stopped row + still-blocked-attempted latch) yields declined; killed row + open incident yields died; no rows yields non-terminal.

## Acceptance

- [ ] A stopped escalation session with a live backend no longer counts toward the global cap, per-key occupancy, or per-epic serialization; a working session still does
- [ ] The in-flight memo still prevents same-tick double-dispatch at all four consumers
- [ ] A declined unblock (stopped session, task still blocked under an attempted latch) classifies terminal declined; a killed session with an open incident classifies died; no folded rows classifies non-terminal
- [ ] The permission-parked pin passes (or the parked-marker fallback arm ships with it, evidence-bounded)
- [ ] isStoppedJobLive behavior for non-escalation verbs is unchanged (existing suites green)

## Done summary

## Evidence

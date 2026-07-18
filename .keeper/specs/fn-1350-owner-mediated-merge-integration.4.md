## Description

**Size:** M
**Files:** src/daemon.ts, src/autopilot-worker.ts, src/reconcile-core.ts, test/daemon.test.ts

### Approach

A level-triggered router closes the loop for incidents with no live owner: an unclaimed incident whose owning session is absent or terminal dispatches the owning verb — work for a task-scoped incident, close for an epic-scoped one — through the ordinary dispatch path. The router bypasses the failed-keys suppression only for keys whose sticky row is an incident it routes (surface-and-stop suppressions stay suppressed); it dispatches nothing while autopilot is paused; and each dispatch counts against the durable attachment bound (about two) before the existing page-once fires. The legacy resolver and merge-escalation sweeps idle from this epic on — their trigger rows stop being minted — and the recover pass demotes to backstop: pass-1 aborts only surfaces with no live claim, pass-2 backstop-merges only closed or tombstoned epics with no dispatchable closer. Base-freshness stops minting resolver chains on conflict: it defers the refresh, records drift, and lets the next fan-in integrate face it.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- The failedKeys suppression arm in src/reconcile-core.ts and suppressRedispatch in src/daemon.ts:1713-1721 — the gate the router selectively bypasses
- src/autopilot-worker.ts:7716 and the recover pass structure — pass-1 abort gating and pass-2 backstop conditions being re-keyed onto claims
- src/autopilot-worker.ts:5634 — the base-freshness merge whose conflict path changes to defer
- src/daemon.ts:14377-14384 and :13491-13498 — the resolver dispatch sweeps that idle from here (removed by the retirement epic)
- The attachment-attempt column landed by the blocked-task epic — the same bound this router consumes for merge incidents

**Optional** (reference as needed):
- src/reconcile-core.ts:2412-2517 — the concurrency budget owner dispatches still respect

### Risks

- The bypass predicate is the sharp edge: too broad re-fires genuinely failed keys into dispatch loops; too narrow starves incidents — it must key on the incident classification of the row, not the reason string shape
- Re-dispatching a closer for a done epic must compose with close-phase resume grades so the re-dispatched closer lands directly in its integrate phase

### Test notes

In-process router tests: unclaimed incident with dead owner dispatches owning verb once; paused autopilot dispatches nothing; suppressed non-incident keys stay suppressed; attachment exhaustion pages once; recover and freshness behaviors under live claim, dead claim, and no claim. Named gates.

## Acceptance

- [ ] An unclaimed incident with no live owner produces exactly one owning-verb dispatch per attachment attempt, bounded durably, then the single page — and never an escalation-verb dispatch
- [ ] Paused autopilot holds all incident dispatches while stickies stay visible
- [ ] Suppressed non-incident failures never re-fire through the bypass
- [ ] Recover and base-freshness honor claims and the demoted roles; all suites green via named gates

## Done summary

## Evidence

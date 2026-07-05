## Description

**Size:** M
**Files:** src/daemon.ts, test/daemon.test.ts

### Approach

The merge-escalation sweep stops messaging planner@ and dispatches the deconflict session; a new terminal stage notifies the human once if that session declines or dies. Stage 2 (rewired runMergeEscalationSweep): unchanged selection gate (worktree-merge-conflict sticky, resolver_dispatched_at set, resolver terminal per the jobs-row probe, merge_escalated_at NULL) now feeds a dispatchDeconflict closure mirroring dispatchResolver — LaunchSpec with prompt `/plan:deconflict <epic_id>`, claudeName `deconflict::<epic_id>`, model/effort from the escalation launch config, keeperAgentLaunch into the managed session; producer-only (never reachable from a fold), pause-gated, stillPending re-read, plus a live-job occupancy guard analogous to epicHasActiveResolver so cadence + fold lag cannot double-dispatch. merge_escalated_at stamps only on a terminal dispatched outcome; a launch failure is non-terminal (marker NULL, row re-sweeps). This task also introduces the shared escalation-dispatch helper both sweep tasks use, including the global live-escalation cap (at most 3 concurrent unblock::+deconflict:: sessions; at-cap rows stay pending and re-sweep). Stage 3 (new sweep): rows with merge_escalated_at set and human_notified_at NULL probe the deconflict::<epic> job for terminal decline/death and then send one structured botctl notification and stamp human_notified_at; a botctl failure records a non-terminal outcome and re-sweeps (or degrades to a durable needs_human row) — it must never wedge the sweep or go silent. A successful deconflict ends with the agent's own `keeper autopilot retry close::<epic>`, which drops the sticky row and every marker with it, so stage 3 never fires. buildMergeEscalationBody and this path's notifyPlanner call are deleted; the notifyPlanner core itself is audited for deletion in the unblock task.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:1264-1324 — runMergeEscalationSweep; :1030 — selectPendingMergeEscalations; :1054 — resolver jobs-row probe / terminal classification
- src/daemon.ts:7600-7634 — dispatchResolver (the closure to mirror); :7636 — tick guards; :7595 — epicHasActiveResolver occupancy mutex
- src/daemon.ts:1127-1211 — buildMergeEscalationBody (delete)
- test/daemon.test.ts:3832 — deps-injected sweep test idiom (SweepDeps stubs, capture-array mint, injected async dispatch)

**Optional** (reference as needed):
- src/daemon.ts:4916-4967 — needs_human recover-row idiom for durable operator visibility

### Risks

- fn-1123 lands adjacent daemon.ts escalation-gate edits and assumes the close::<epic> merge-escalation keying stays stable — rebase deliberately; the sticky-key semantics are shared contract.
- Producer-only discipline: a launch reachable from applyEvent re-fires on re-fold.
- botctl absent or failing must not lose the human notification silently.

### Test notes

Deps-injected sweep tests: dispatch-once with marker stamped only on dispatched; launch-fail re-sweep; no dispatch while the resolver is live or undispatched; stage-3 notify-once on decline and on death; no stage-3 after retry_dispatch cleared the row; paused board defers both stages; global cap respected.

## Acceptance

- [ ] A sticky worktree-merge-conflict whose resolver reached terminal decline/death dispatches exactly one deconflict::<epic> session at the escalation model/effort and sends no planner@ bus message
- [ ] A launch failure leaves the once-marker unstamped and the row re-sweeps; retry_dispatch re-arms the full chain
- [ ] A deconflict session that declines or dies triggers exactly one human notification while the sticky row stays operator-visible
- [ ] buildMergeEscalationBody is gone and the fast suite is green

## Done summary

## Evidence

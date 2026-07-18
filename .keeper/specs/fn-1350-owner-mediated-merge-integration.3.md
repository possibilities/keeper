## Description

**Size:** M
**Files:** src/autopilot-worker.ts, plugins/plan/skills/close/SKILL.md, plugins/plan/src/verbs/close_finalize.ts, src/grant-leaf.ts, src/daemon.ts, test/daemon.test.ts

### Approach

Split finalize: the integrate half (epic base into local default) moves into the close skill as a durable phase with its own resume grade; the teardown half (verification, origin push, lane retirement) stays daemon-side and runs only after the closer exits. The closer acquires the per-repo trunk-integration lease through the spool contract — the daemon publishes a lease leaf carrying a monotonic fencing token, the writable shared-checkout root, expiry, and the observed default tip. Inside the held lease the closer re-probes the tri-state ancestry gate (is-ancestor exit 0 / 1 / anything-else defers) and compares the live default tip against the lease's observed tip; on any defer or mismatch it releases and re-pulls rather than merging. Conflicts route through plan:deconflicter with the same typed receipts as fan-in. Daemon teardown verifies objectively (source ancestor of default, clean tree) before the origin push through the existing push plumbing, preserving every current finalize discriminant — the non-fast-forward sticky, the red-merge-suite gate, the shared-checkout dirty/off-branch/mid-merge classifications, and multi-repo per-group independence (one lease per repo, tokens never shared across repos). Multi-repo epics acquire per-repo leases independently, exactly mirroring today's per-repo finalize groups.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/autopilot-worker.ts:5828 and :5957 — finalizeEpic and mergeLaneBaseIntoDefault (the push-plumbing pipeline that never runs merge in the shared checkout — teardown keeps it)
- plugins/plan/src/verbs/close_finalize.ts:736 — the merge-happens-post-finalize seam being replaced by the in-skill integrate phase
- plugins/plan/skills/close/SKILL.md — phase structure and durable phase_resume grades the integrate phase joins (hand-authored; verify no managed sidecar before editing)
- src/grant-leaf.ts — the leaf contract the lease leaf reuses (root, expiry, fencing token)
- The cross-epic merge-gate tri-state probe — the DEFER-on-inconclusive idiom to copy

### Risks

- This is the highest-interlock seam in the codebase: every existing finalize sticky, retry skip, and shared-checkout classification must map onto the split — enumerate them against tests before cutting
- A closer that dies holding the lease must not wedge the repo: lease expiry plus claimant-death positive evidence releases it, and the incomplete merge surfaces as residue, never as silent retry

### Test notes

In-process: lease round-trip with token monotonicity; defer on ancestry-inconclusive and on tip drift; conflict to deconflicter receipt transitions; teardown refuses on failed objective verification; every legacy finalize discriminant reproduced against the split. Named gates.

## Acceptance

- [ ] The epic-base-to-default merge runs only inside a live closer holding a valid per-repo lease, with the ancestry gate and tip compare re-probed inside the fence and any inconclusive probe deferring
- [ ] Daemon teardown pushes and retires only after objective verification, and every pre-existing finalize outcome class still surfaces identically
- [ ] A dead lease-holder releases by positive evidence without wedging finalize, leaving residue visible as an incident
- [ ] Multi-repo epics hold independent per-repo leases; all suites green via named gates

## Done summary

## Evidence

## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/daemon.ts, src/dispatch-failure-key.ts, src/needs-human.ts, test/autopilot-worker.test.ts, test/daemon.test.ts

### Approach

Investigation-first: the existing `shared-checkout-dirty` daemon-verb distress should have minted during the incident's 8-hour dirty window and did not — find why (grace logic, trigger scoping to the recover pass, worktree-mode gating) using the incident's replayable GitSnapshot events as evidence. Then make sustained shared-checkout dirt reliably surface exactly ONE operator-visible row through that existing family (positive-evidence level-clear on observed-clean, unchanged), and make the repair sweep's dirty-checkout defer attributable to it: the defer diagnostic fn-1198 landed should reference the active distress row rather than aging into a rival family — one dirty checkout, one incident row, two consumers. If investigation shows the non-fire was deliberate scoping, extend the trigger surface (a second producer feeding the same family) rather than minting a new prefix. Any new drop/defer class routed through the repair diagnostics must go through the typed drop() helper and the RepairCandidateDropClass union fn-1201 reconciled.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/dispatch-failure-key.ts:179 SHARED_DIRTY_DISTRESS_* — the existing family + lifecycle (daemon-verb, level-clear)
- src/autopilot-worker.ts:1291 SharedDirtyDistress tracker — the grace/mint machinery that did not fire
- src/daemon.ts:1831 — the repair-defer note; :1546-1872 the sweep region (post-fn-1201 shape)
- src/needs-human.ts classifyNeedsHumanRow — where the row surfaces

**Optional** (reference as needed):
- fn-1198.1's landed per-gate diagnostics — the defer trace format
- CLAUDE.md worktree bullet on shared-checkout-dirty semantics

### Risks

- Widening the dirty-distress trigger could page on transient mid-merge dirt — keep the grace window and positive-evidence clear intact.
- fn-1201 may still be in flight when this dispatches; the dep edge serializes the union edits.

### Test notes

Pure sweep-seam tests: sustained-dirty snapshots mint exactly one row and clear on observed-clean; the repair-defer diagnostic names the active row; transient dirt within grace mints nothing.

## Acceptance

- [ ] The non-fire root cause is named in the Done summary with evidence
- [ ] A shared checkout dirty past grace mints exactly one distress row visible in needs-human, cleared only on observed-clean
- [ ] The repair sweep's dirty-checkout defer names the active distress row in its diagnostic
- [ ] No second family/row pages for the same dirty checkout
- [ ] keeper fast suite green

## Done summary

## Evidence

## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/readiness-client.ts, src/await-conditions.ts, cli/await.ts, test/autopilot-worker.test.ts, test/await-conditions.test.ts, test/await.test.ts, test/await-worker.test.ts

### Approach

Extend `computeMergedLaneEntries` so an explicit whole-epic `disabled` resolution emits the epic's existing `lane_merged`/merge-landed row once the epic is done, without running git probes. Keep `ok` lane proofs and `clustered` all-group aggregation unchanged; do not infer success from a missing lane, a missing resolution, malformed state, or current manifest files in the consumer. Preserve the shared sorted-set contract, and make await help/progress details describe the landing milestone rather than claiming every successful path merged a lane. Foreground await, durable await, and paused `finalize_pending` status then inherit the fix through their existing shared signal.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/autopilot-worker.ts:3588-3605,3695-3785 — producer contract, explicit resolution switch, done evidence, and clustered aggregation
- src/readiness-client.ts:618-644 — pure shared landed-set contract and stable sort behavior
- src/await-worker.ts:267-324 — durable await's direct lane_merged read and shared predicate call
- src/await-conditions.ts:1623-1661 — mode-agnostic membership seam with lane-specific details
- test/autopilot-worker.test.ts:16696-16829 — existing serial done gate and the disabled-resolution test that currently expects a skip

**Optional** (reference as needed):
- cli/await.ts:160-161,216,265 — human and agent help wording
- test/await-conditions.test.ts:2491-2530 — membership/detail and global worktree-off matrix
- src/collections.ts:1048-1081 — lane_merged descriptor whose prose must stay truthful if updated

### Risks

- Emitting on task completion before the epic itself is done would weaken the existing global-worktree-off degradation and may race close semantics; use the epic's done state for the whole-epic serial fallback.
- Broadening arbitrary non-`ok` resolutions would falsely satisfy unresolved or rejected epics; only explicit `disabled` serial execution qualifies.
- Lane-specific output text becomes false for serial/global-off success, while overly vague text can hide why a lane-capable epic still waits.

### Test notes

Add deterministic producer cases for disabled+done → one row with zero git calls, disabled+not-done → no row, missing/unknown resolution → no row, and preserve clustered/ok cases. Update predicate/help assertions for truthful mode-neutral details. Run the focused foreground and durable await suites to prove both paths still consume the same set; use no daemon, UDS, subprocess, or sleeps.

## Acceptance

- [ ] Explicit disabled serial execution emits merge-landed evidence exactly when the epic is done, with zero git probes; unfinished, unresolved, rejected, and unclassified epics do not
- [ ] Existing worktree and clustered multi-repo landing matrices remain green, including no early success before every lane-bearing group lands
- [ ] Foreground and durable landed awaits satisfy from the same serial completion evidence, and status no longer treats that done serial epic as finalize-pending
- [ ] Human and agent-facing await details are truthful for lane and no-lane paths without changing the condition or result envelope
- [ ] Focused await/autopilot tests and typecheck pass

## Done summary

## Evidence

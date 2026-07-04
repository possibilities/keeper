## Description

**Size:** M
**Files:** src/dispatch-failure-key.ts, src/dispatch-failure-pill.ts, src/autopilot-worker.ts, src/daemon.ts, CLAUDE.md, test/dispatch-failure-key.test.ts, test/autopilot-worker.test.ts

### Approach

Make a persistent wedge loud. Following the crash-loop distress idiom, mint
a per-repo synthetic needs_human distress row when the shared checkout stays
wedged past a short grace watermark (~5 minutes, injectable for tests) —
covering the foreign/ambiguous wedge keeper cannot heal and the keeper-owned
wedge whose abort keeps failing. The immediate per-epic recover/finalize
reasons from task 2 fire on the first cycle regardless; this distress row is
the escalation layer on top. The key is per-repo (multi-repo boards can wedge
two checkouts independently), lives OUTSIDE the worktree-recover* auto-clear
prefix, is orphan-GC-exempt like the crash-loop row, and is level-cleared
explicitly by the recover pass when the probe finds the checkout clean. The
grace tracking is in-memory watermark state (a daemon restart re-emits once
per still-present condition — the accepted bounded burst); route the new
reason through the display-rules table and the board pill together. Then
revise the CLAUDE.md Autopilot clause in place: carve the mid-merge subcase
out of the "dirty/off-branch degrades to a non-sticky retry skip" sentence
and state the classification / self-heal / sustained-escalation contract,
keeping the size lint green — consolidate, never append.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/dispatch-failure-key.ts:127-129 — CRASH_LOOP_DISTRESS_VERB/ID/REASON, the fixed-synthetic-key distress idiom to mirror per-repo; :134-142 display-kind union; :152-166 most-specific-first display rules; :259 isWorktreeRecoverReason scope the new key must stay outside
- src/daemon.ts:5967-6015 — mintCrashLoopDistress; the synthetic DispatchFailed mint shape (producer-stamped ts, non-fatal on failure); :4350-4402 the mint-and-level-clear driver; :325-345 the boot-GC exemption the new key needs
- src/autopilot-worker.ts:899, :924-964 — DISPATCH_FAILED_WATERMARK_SEC and createDispatchFailedGate; the change-gated cadence the grace watermark composes with
- CLAUDE.md — the Autopilot section sentence beginning "finalize instead DEGRADES a dirty/off-branch shared-checkout"; bun scripts/lint-claude-md.ts gates the edit

**Optional** (reference as needed):
- src/dispatch-failure-pill.ts — classifyDispatchFailure; must move in lockstep with the display-rules table
- test/autopilot-worker.test.ts — the gate cadence tests (watermarkSec injectable) as the template for grace-window tests

### Risks

- The distress row must never be dismissible by the recover auto-clear or retry_dispatch alone while the wedge persists — its only legitimate clear is the level-trigger seeing a clean checkout
- CLAUDE.md is concurrently edited by fn-1103's docs sweep; this epic depends on fn-1103 so the edit lands as a rebase, but re-verify the clause wording against whatever landed

### Test notes

Pure-seam: drive the recover pass with a persistently wedged fake across
cycles past the injectable grace threshold → exactly one distress mint
(change-gated, no per-cycle spam); clean probe → exactly one clear; per-repo
keys don't collide on a two-repo board; display rules + pill classify the
new reason together.

## Acceptance

- [ ] A wedge persisting past the grace watermark mints exactly one per-repo distress row visible in needs_human, and a recovered checkout level-clears it exactly once
- [ ] The distress key lives outside the recover auto-clear scope, is orphan-GC-exempt, and re-emits at most once per daemon restart while the condition persists
- [ ] Distress events are O(1) per condition episode — no per-cycle re-emits — and the display table and board pill classify the new reason consistently
- [ ] The CLAUDE.md autopilot invariant prose states the new mid-merge contract in place of the stale blanket dirty-degrade wording, and the CLAUDE.md size lint passes

## Done summary
Escalate a sustained shared-checkout mid-merge wedge into a per-repo shared-checkout-wedge needs_human distress row (synthetic daemon verb, orphan-GC-exempt, outside the recover auto-clear, un-retryable) via an in-memory grace tracker that mints exactly-once past a ~5min watermark and level-clears off the durable open-distress set. Routes the new reason through the display-rules table + board pill and carves the mid-merge subcase into the CLAUDE.md autopilot clause.
## Evidence

## Description

**Size:** S
**Files:** src/autopilot-worker.ts, src/dispatch-failure-key.ts, src/daemon.ts, test/autopilot-worker.test.ts, test/dispatch-failure-key.test.ts

### Approach

Mirror the shared-checkout-wedge machinery with a SIBLING dirt surface — never widen the mid-merge predicate or touch its path. A second tracker instance (same pure grace + minted-latch + positive-evidence-clear shape, injectable graceSec, nowSec = producer ts) steps over the repos whose recover pass reported a dirty checkout this cycle; sustained dirt past the grace mints one per-repo distress row with a DISTINCT id prefix and reason (synthetic daemon verb, un-retryable, orphan-GC-exempt), and the row level-clears exactly once when a cycle's dirty-failure set no longer contains the repo. Immediate pre-grace finalize dirt-skips keep minting nothing (the existing invariant). Thread a sibling distress-dirs set through the snapshot loader so mid-merge and dirt rows never cross-clear; register the new reason in the pill map (the assertNever tripwire forces complete wiring) and add the new key to the boot orphan-GC exemption. Reuse the existing distress message channel and change-gating watermark cadence so re-emits stay O(1) and a daemon restart re-mints at most once per still-present condition.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves. Both autopilot files need `grep -a` (a byte makes plain grep treat them as binary).*

**Required** (read before coding):
- src/autopilot-worker.ts:1114-1166 — SharedCheckoutWedgeTracker + factory: THE template (grace, minted-latch, projection-driven clear)
- src/autopilot-worker.ts:1023-1070 — wedge grace const, reason prefixes, isSharedCheckoutWedgeReason (doc at :1039 deliberately EXCLUDES dirty — add a sibling predicate, never widen), sharedWedgeDistressId
- src/autopilot-worker.ts:5211-5252 — recover-pass driver: wedgedRepos build + tracker.step + mint/clear emits; add the parallel dirtyRepos map + second tracker step here (tracker constructed at :4742)
- src/autopilot-worker.ts:3685 — the recover pass already emits worktree-recover-dirty-checkout WorktreeRecoveryFailure — the natural feed for both the dirt grace clock and the clean-observation clear
- src/autopilot-worker.ts:4381-4392, :4624 + src/reconcile-core.ts:425 — snapshot loader's sharedWedgeDistressDirs build; add the sibling dirt set with the new key predicate
- src/dispatch-failure-key.ts:141-160, :190-200, :210 — wedge distress constants + key predicate to sibling; reason-prefix→pill map (worktree-recover-dirty-checkout→"dirty-tree" exists); assertNever tripwire
- src/daemon.ts:341-375, :6659-6720, :6297-6309 — boot orphan-GC exemption (MUST include the new key or GC strips it), mintSharedWedgeDistress, message handler
- test/autopilot-worker.test.ts:12421-12633 — the wedge tracker suite to mirror (matcher, id stability, grace const, mint-once, level-clear-once, restart re-mint)

**Optional** (reference as needed):
- src/autopilot-worker.ts:2490-2585, :2794-2797 — finalize retry-skip + dirty classification (mid-merge case :2799-2806 is OUT of scope, byte-untouched)
- src/autopilot-worker.ts:500-521 — recoverFailuresToClear positive-evidence set-difference pattern
- src/autopilot-worker.ts:951-1020 — DispatchFailed change-gating watermark cadence
- test/autopilot-worker.test.ts:6758, :9828, :10761 — invariants that must keep holding (pre-grace mints nothing; recover-side dirty analogue; mid-merge stays distinct)

## Acceptance

- [ ] A shared checkout that stays dirty (no MERGE_HEAD) past the grace watermark mints exactly one per-repo needs_human distress row with a dirt-specific id and reason — un-retryable, orphan-GC-exempt, and re-minted at most once per still-present condition across a daemon restart
- [ ] The dirt row level-clears exactly once when a recover cycle observes the checkout clean, and never cross-clears with the mid-merge shared-checkout-wedge row; the mid-merge path's behavior is unchanged
- [ ] An immediate pre-grace dirty finalize skip still mints no dispatch_failures row
- [ ] The autopilot and dispatch-failure-key fast suites pass with new tracker-lifecycle tests mirroring the wedge suite

## Done summary
Added a sibling shared-checkout plain-dirty distress escalation mirroring the mid-merge wedge: a per-repo self-clearing needs_human row (createSharedCheckoutDirtyTracker) minted past a grace watermark on a distinct id/reason so the two never cross-clear, wired through the snapshot loader, pill map, and boot orphan-GC exemption.
## Evidence

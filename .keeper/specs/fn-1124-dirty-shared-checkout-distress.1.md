## Description

**Size:** S
**Files:** src/autopilot-worker.ts, src/dispatch-failure-key.ts, src/reconcile-core.ts, src/daemon.ts, test/autopilot-worker.test.ts, test/dispatch-failure-key.test.ts

### Approach

Clone the mid-merge wedge two-layer idiom for plain dirt: a pure, wall-clock-free in-worker grace tracker (per-repo firstWedged clock + minted latch, exactly-once per continuous episode, re-armed when the repo drops out) fed by the recover pass's EXISTING worktree-recover-dirty-checkout failures — which makes the level-clear fall out for free off the durable open-rows set, mirroring the wedge clear. Mint through the existing generic daemon distress message/executor channel under a NEW id family (`shared-checkout-dirty:<repoDirHash>`) with its own reason constants and predicate — never widen isSharedCheckoutWedgeReason, never reuse the `shared-checkout-wedge:` prefix, so the two families never collide on (verb,id) or cross-clear. The new key joins the synthetic un-retryable daemon-verb class: boot orphan-GC exemption, pill-map entry (the compile-time assertNever tripwire enforces it), DispatchFailed change-gating for O(1) re-emits. Finalize's dirty `retry` skip (no sticky row) is deliberately UNCHANGED — this adds a parallel sustained-grace escalation, not a new finalize failure. Snapshot side: collect the new family's open dirs alongside the wedge dirs set and mirror the field on ReconcileSnapshot. Verify a finalize-only dirty stall also surfaces the recover-dirty failure the same cycle (the recover pass probes the shared checkout each cycle) so the tracker feed covers the incident shape.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves. NOTE: src/autopilot-worker.ts reads as binary to plain grep — use `grep -a` or Read, or you will get silent zero-match false negatives.*

**Required** (read before coding):
- src/autopilot-worker.ts:1087-1166 — createSharedCheckoutWedgeTracker: THE template (grace clock, minted latch, level-clear off openDistressDirs)
- src/autopilot-worker.ts:5211-5252 — the recover-pass driver wiring failures → tracker.step → emit/clear deps; the dirt path plugs in here
- src/autopilot-worker.ts:3685 — the recover pass already emits worktree-recover-dirty-checkout into the same failures array (the tracker feed)
- src/autopilot-worker.ts:2794-2796 and :2536-2568 — finalize dirty `retry` skip semantics to leave untouched
- src/dispatch-failure-key.ts:147-166 and :199 — SHARED_WEDGE_DISTRESS_* constants + predicate to clone; the prefix→pill map with the assertNever exhaustiveness tripwire
- src/autopilot-worker.ts:4381-4392, :4624 + src/reconcile-core.ts:425 — sharedWedgeDistressDirs collection + ReconcileSnapshot mirror to parallel
- src/daemon.ts:341-374 — boot orphan-GC exemption predicate to extend; :6300-6740 mintSharedWedgeDistress/clear executor (generic message — reuse, new id family only)
- test/autopilot-worker.test.ts:12421-12633 — the wedge tracker test block to clone; :6758, :10751, :9828 — the retry-skip/dirty tests to sit beside

**Optional** (reference as needed):
- src/autopilot-worker.ts:1033-1055 — isSharedCheckoutWedgeReason doc-comment stating dirty is deliberately excluded (add a sibling matcher)
- src/autopilot-worker.ts:983-1020 — changeGatedDispatchFailedTier / watermark constants
- src/autopilot-worker.ts:8582, :3196-3198 — incident-anchor comments for the silent-stall failure mode

## Acceptance

- [ ] A shared checkout continuously dirty (no MERGE_HEAD) past the grace watermark mints exactly one per-repo needs_human distress row per episode, in a new id/reason family distinct from the mid-merge wedge, un-retryable and boot-GC-exempt, rendered with a pill
- [ ] The row level-clears once the recover pass observes that repo's checkout clean, and a fresh dirty episode re-mints exactly once, including across a worker restart
- [ ] Transient dirt below the grace watermark mints nothing, and finalize's dirty retry-skip still mints no sticky row
- [ ] The fast suite is green with cloned tracker tests (grace-cross, exactly-once mint, level-clear, restart re-arm, per-repo distinctness) and new key-predicate coverage

## Done summary

## Evidence

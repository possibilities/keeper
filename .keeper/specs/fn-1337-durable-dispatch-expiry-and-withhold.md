## Overview

A crash-window dispatch leaves an immortal fence: the durable acquired claim
survives the reboot while the ephemeral pending row — the only feeder of the
never-bound expiry — is boot-truncated, so the reconciler silently withholds
the ready task forever and only an operator retry unsticks it (two live
incidents). This epic makes never-bound expiry durable and boot-safe, and
gives every reconciler withhold of a ready task a visible, transition-gated
reason — silent-withhold is the defect class even when the withhold is right.

## Quick commands

- bun test ./test/reducer-projections.test.ts && bun test ./test/autopilot-worker.test.ts
- keeper autopilot   # frame state carries withhold reasons after the change

## Acceptance

- [ ] A dispatch minted immediately before a daemon crash expires and surfaces visibly after reboot with no pending row surviving, while a wrapper still cold-starting across the boot gets a full post-boot bind window
- [ ] Every withhold of a ready task or close row is observable with a bounded reason, emitted on transition only, machine-readable via the reconciler frame surface
- [ ] The ADR amendment to the attempt-fencing decision records the expiry carve-out and the ownerless self-heal boundary

## Early proof point

Task ordinal 1's red test: fold a Dispatched event, run truncateEphemeralProjections
(the naive re-fold masks the bug), and prove today's sweep never expires the
orphan; then green under the durable scan. If the boot re-anchor proves
untestable deterministically: fall back to age-only with a threshold covering
worst-case downtime plus cold-start, and record the double-dispatch residual.

## References

- src/reducer.ts:5658 foldDispatched (durable claim + ephemeral pending in one fold); :5747 foldDispatchExpired (sole never-bound feeder; alreadyFailed guard ~:5768); :10303 bind-reset; :4353 foldDispatchCleared (the ONLY claim-releasing fold — expiry via existing plumbing trips but does not free)
- src/db.ts:6672 EPHEMERAL_PROJECTIONS + daemon.ts:8077 boot truncate; daemon.ts:893/971 the pending sweep the claim scan joins (heartbeat cadence, never data_version)
- src/reconcile-core.ts:1596 dispatchClaimBlocksReplacement; :2361-2430 the ten silent continue branches; :2586-2620 the fused close-row okToPlan conjunction that must decompose to name its arm
- dispatch_claims has NO launch coordinates (db.ts:5834) — the boot re-anchor exists precisely because no liveness probe is possible
- docs/adr/0070 §2 — the clause the ADR amendment carves; CONTEXT.md — "parked" family is Avoid-listed for this state; frame the sweep as a Reaper
- Epic deps: none (fn-1336 disjoint; fn-1335 landed — rebase on its parked-sticky invariant: never-bound counting never double-fires alongside it)

## Docs gaps

- **docs/adr/ (new record)**: amends ADR 0070 §2 (durable age-keyed expiry is a cross-attempt non-clear mutation of the streak) and records the boot re-anchor + ownerless self-heal boundary; relates 0084/0024/0083
- **docs/problem-codes.md**: REVISE the stale_attempts row (its "remains pending" wording is wrong for the pending-less orphan) and document the withhold-reason enum as the stable contract
- **CONTEXT.md**: an "orphaned claim" entry (never "parked" — Avoid-listed) plus a withhold-reason entry distinct from Readiness

## Best practices

- **Reason-on-surface, transition-gated:** emit only on reason change, bounded enum keys, churn detail out of the key; rate-limit per (target, reason)
- **Durable deadlines are absolute wall-clock stamped by producers; folds compare event ts** — never monotonic values, never in-memory observation counters
- **Jitter mass expiry; skew-grace the comparisons** — a reboot with fifty orphans must not stampede one sweep tick

## Overview

The tier-two interactive-session carve-out (`selectStuckSentinelVerdicts`) ends
its tier-two block in an unconditional `continue` that sits OUTSIDE the
`planRef != null && !adopted` mint guard. As a result a carved-out session
(no plan linkage / adopted) that is stale past `STUCK_TIER2_MIN_AGE_SECS` AND
carries a clock skew never reaches the standalone clock-skew branch — the skew
signal is silently swallowed. This directly contradicts ADR 0025's Decision
section, which promises the standalone clock-skew detect "still fires regardless
of plan linkage", and the inline comment at the carve-out claims a fall-through
that the control flow prevents. Reconcile code, comment, and ADR into agreement.

## Acceptance

- [ ] Code, the inline comment, and ADR 0025 agree on whether a tier-two-aged
      carved-out session with clock skew emits a standalone skew row.
- [ ] A test pins the carved-out + tier-two-stale + clock-skewed edge to the
      chosen behavior.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | exit-watcher.ts:648-661 unconditional continue makes the standalone clock-skew branch (662) unreachable for a tier-two-aged carved-out session, contradicting ADR 0025's "clock-skew fires regardless of plan linkage" promise. |
| F2 | culled | — | daemon.ts buildSharedDirtyObservation MINT>0 vs DEFER-on-null asymmetry is documented deliberate behavior; auditor states no fix required if unseeded is transient — deferred speculative longer-grace enhancement. |
| F3 | merged-into-F1 | .1 | F3's wrong inline comment ("still fall through to the clock-skew detect below") is the same root cause as F1 (the unconditional continue); corrected in the same task. |

## Out of scope

- The `buildSharedDirtyObservation` unseeded-mint gate (F2) — deliberate,
  documented behavior; any longer-grace-on-sustained-unknown enhancement is
  deferred to a later cycle.

# 85. Durable orphaned-claim reaping

## Status

Accepted. Amends ADR 0070 and relates to ADRs 0024, 0083, and 0084.

## Context

A Dispatch attempt is acquired durably before its wrapper binds. The sibling
`pending_dispatches` row is intentionally boot-truncated because it is live-only
launch-window state. A daemon crash between acquisition and binding can therefore
leave an acquired, sessionless Dispatch claim with no pending row. The claim fence
correctly blocks replacement, but the pending-row expiry sweep can no longer see
it. The resulting ready target is withheld indefinitely without a visible reason.

No process or Tmux identity is recorded on an acquired claim. After reboot, the
daemon cannot distinguish a launch that never happened from a wrapper that is
still cold-starting. A liveness probe or immediate boot-time release would trade
the immortal fence for a possible double Dispatch.

## Decision

The heartbeat-cadence pending sweep has a sibling Reaper over exact modern claims
whose state is `acquired`, whose `session_id` is null, and whose key has no pending
row. Bound, released, legacy-unfenced, malformed-age, and already-failed claims are
outside this scan. Pending-row and durable-claim expiry are disjoint by key, so one
heartbeat cannot advance never-bound evidence from both sources.

An orphaned claim becomes eligible only after both deadlines pass: its durable
`acquired_at` age exceeds the pending TTL plus clock-skew grace, and the same full
window has elapsed since the current daemon boot. Stable per-attempt jitter spreads
a reboot cohort across one heartbeat interval, while a fixed batch cap bounds each
pass. These are producer wall-clock decisions. The producer mints the existing
`DispatchExpired` synthetic event with the exact attempt and an orphan-source
reason; the Fold reads no clock and rejects the event if that attempt has since
bound, released, or been superseded.

Each accepted expiry advances the existing never-bound streak. The threshold
mints the existing `never-bound` Sticky before any self-heal, making the withheld
ready target visible. The same timeout sidecar used by pending expiry records the
orphan source and exact attempt.

After the Sticky is folded, the producer may mint `DispatchClaimReleased` only for
the provably ownerless class: the exact claim remains acquired and sessionless and
no `provider_leg_ownership` row exists for its attempt. The event carries an
ownerless-acquired-only restriction. The Fold repeats all conditions, so a late
bind, supersede, or Provider-leg enrollment ordered before release makes the event
a no-op. Attempts with any Provider-leg ownership remain visibly fenced for the
normal leg-cascade or operator path; settled ownership is still ownership and does
not qualify for this self-heal.

## Consequences

- A reboot gives every possibly-starting wrapper a complete fresh bind window.
- A crash-window orphan reaches visible `never-bound` evidence on heartbeat time
  instead of holding a silent permanent fence.
- Pending and durable sources cannot double-increment the never-bound streak in one
  cycle.
- Exact ownerless claims release automatically only after visibility; owned,
  bound, legacy, malformed, and superseded claims fail closed.
- Clock correction can delay expiry by the grace and jitter margins but cannot
  move wall-clock reads into the deterministic Fold.

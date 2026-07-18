# 0070 — Attempt- and incident-fenced dispatch clears

## Status

Accepted. Provisional number — fan-in renumbering per ADR 0020/0022. Amends
[ADR 0055](0055-harness-activity-dispatch-claims-and-resource-holds.md) and
[ADR 0024](0024-stuck-sentinel-orphan-reconciliation.md).

## Context

A delayed `DispatchCleared{verb,id}` can arrive after a newer Dispatch attempt
owns the same target. Key-only clearing then releases the newer claim, erases its
pending launch, re-arms producer gates, and may remove a different open incident.
The event also clears claimless Sticky and Distress rows, whose lifecycle is an
incident episode rather than a Dispatch attempt.

Dispatch attempts already fence acquire, bind, resume, supersede, and explicit
claim release. Failure rows already carry a stable first-event incident identity,
while breaker streaks intentionally accumulate across attempts. Historical clear
events contain neither identity.

## Decision

1. **Two identities, no wildcard.** A modern clear carries an
   `expected_attempt_id` for attempt-owned state and an
   `expected_instance_event_id` for incident-owned state. Field presence is
   explicit; an omitted, malformed, or mismatched modern fence grants no
   authority.
2. **State names its owner.** Claims, pending launches, and the durable Dispatch
   mint gate store the exact attempt. The failure row stores its incident identity
   and latest informational attempt. `DispatchCleared` never touches never-bound
   or instant-death streaks: no single attempt owns cross-attempt evidence. A
   positive bind or surviving terminal resets its respective streak; tripping a
   breaker preserves the streak so a still-broken retry re-trips immediately.
   The durable orphaned-claim Reaper is the narrow exception: its exact-attempt
   expiry advances the never-bound streak, and its release may mutate only the
   same still-acquired, sessionless attempt after the breaker is visible and the
   Fold proves that no Provider-leg ownership row exists.
3. **Compare-and-clear is per effect.** The Fold independently mutates only rows
   whose recorded owner equals the relevant expected identity. A mixed snapshot
   may therefore clear an old incident while preserving a newer claim, pending
   launch, or mint gate. Duplicate and stale clears are idempotent no-ops.
4. **Capture precedes delay.** Automatic producers snapshot the observed fences
   before worker-to-main or other asynchronous transport and carry them unchanged.
   `retry_dispatch` keeps its public key-only input; main snapshots the current
   owners immediately before append, which is the request's linearization point.
5. **The Fold remains authoritative.** Main revalidates producer-carried fences
   before append and emits one bounded mismatch diagnostic. The deterministic Fold
   repeats exact comparisons so a race after that check is still harmless. Public
   success continues to mean the clear request was accepted, not that every
   independently fenced effect matched.
6. **Gate release follows authority.** The durable mint gate is deleted only
   after event append and only for its exact attempt. The worker's in-memory
   failure gate resets from matching projection evidence, never before posting a
   clear. Append failure, daemon restart, and stale delivery cannot re-arm a newer
   attempt.
7. **Legacy history is bounded.** Tokenless historical clears may affect only
   legacy-unfenced attempt rows and the incident deterministically present at that
   point in replay; they never release an exact modern attempt. New producers
   never emit tokenless clears. Rollout does not force a rewind: existing inactive
   projection damage is accepted, while any future re-fold applies this rule.

## Consequences

- An older completion, slot-clear decision, retry, or orphan sweep cannot revoke
  a newer Dispatch attempt or a newly opened incident with the same key.
- Claimless level-triggered incident clears remain usable without pretending an
  unrelated attempt owns them.
- Operator retry no longer erases accumulated breaker evidence; only positive
  recovery evidence makes a broken target fresh again.
- The change needs additive owner columns and complete producer coverage, but no
  public RPC shape change.
- Stale mismatches are safe and diagnosable instead of silently destructive.

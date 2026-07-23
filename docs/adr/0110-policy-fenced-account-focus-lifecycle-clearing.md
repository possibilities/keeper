# 110. Policy-fenced Account-focus lifecycle clearing

## Status

Accepted. Supersedes ADR 0100 while preserving independent scoped focuses, mandatory managed Account routes, explicit-account precedence, fresh eligibility evidence, stable PII-free policy identity, visible fallback, and isolated Projection and launch-delivery cells. Retains ADR 0101 as the Capacity-observation trust boundary.

## Context

An Account focus expresses durable operator intent for one traffic class, but a bounded focus that remains configured after its lifetime is misleading: routing treats it as inactive while inspection continues to show stale intent. A focus intended to consume one quota also ceases to serve its purpose when that quota becomes fully used or starts a fresh cycle.

Quota endpoints are live provider facts rather than deterministic Fold inputs. Detecting an endpoint from one level would clear a policy that was already at that level when armed, while retaining only process memory would lose a real transition across a daemon restart. A delayed automatic clear can also arrive after an operator replaces the focus and must never erase the newer policy.

## Decision

Keeper automatically clears each Fable and Non-Fable Account focus independently when its lifetime ends or its target Usage meter makes either exact transition during the same Focus episode:

- previous utilization is below full and current utilization is exactly full; or
- previous utilization is above zero and current utilization is exactly zero.

The Fable meter is the target route's `model:Fable` window. The Non-Fable meter is its weekly `week` window. Comparisons use admitted raw utilization rather than display rounding. A permanent focus has no lifetime end but remains subject to both quota transitions. An absolute or normalized current-reset lifetime ends at its half-open deadline; Fable cycle-end ends at its reset boundary. A quota level alone does not end a newly armed focus.

Setting either focus requires a fresh, healthy, structurally valid Capacity observation containing the target route and its relevant meter. Missing, stale, malformed, absent, or already-full evidence refuses the mutation. Main validates and stamps the trusted arming measurement into the Synthetic event that materializes the event-owned policy, giving the Focus episode an immutable predecessor without trusting client-supplied evidence or changing the public policy leaf.

A producer retains one bounded, PII-free checkpoint per focus scope and exact `policy_id`. The checkpoint carries the last trusted ordered measurement and any pending clear evidence. Unavailable or malformed observations never advance it; the last trusted predecessor survives observation gaps and daemon restarts. A new policy identity starts from its own arming measurement, and missing or incompatible checkpoint state re-baselines without inventing a transition.

Automatic clearing uses a typed internal request carrying the scope, expected policy identity, cause, and bounded evidence. Main revalidates the policy fence before appending the existing generic config Synthetic event. The event distinguishes a conditional automatic clear from an unconditional operator `null` clear, and the Fold repeats the exact policy comparison. Missing, malformed, duplicate, or mismatched automatic fences are no-ops. Operator clears retain their unconditional semantics.

Simultaneous causes coalesce for one policy; Fable and Non-Fable requests remain separate so each Projection cell, launch leaf, acknowledgement, and retry has an independent failure domain. A clear is acknowledged only after the Projection is off and that scope's owner-only launch leaf is verified off. Until then, pending evidence retries without advancing the checkpoint. An already-cleared Projection repairs and verifies its leaf without appending another clear event.

Lifetime reconciliation is level-triggered. Boot reconciles overdue policies before publishing focus leaves, and the Account observer repeats reconciliation during its normal cadence. Timers may reduce latency but never own truth. Routing's half-open lifetime evaluation remains authoritative while a durable clear is pending.

## Alternatives considered

- **Keep expired intent visible until manual clear.** Rejected because configured-but-inactive state no longer represents actionable operator intent.
- **Clear from current quota level.** Rejected because an endpoint level does not prove the requested transition and can erase a newly armed policy.
- **Store only an in-memory predecessor.** Rejected because restart would either lose a real transition or treat the first post-boot level as one.
- **Discard the predecessor across observation gaps.** Rejected because a transient provider or refresh failure must not suppress a later trusted endpoint.
- **Infer resets from `resetsAt`.** Rejected because ADR 0101 leaves quota truth with fresh claude-swap observations; reset timestamps define focus lifetimes but never manufacture utilization.
- **Clear directly from the observer or add a focus-specific RPC.** Rejected because automatic mutation belongs on the Synthetic-event rail and generic config remains the sole public focus mutation surface.
- **Combine both scopes in one automatic clear.** Rejected because one scope's evidence or publication failure must not affect its sibling.

## Consequences

Account-focus intent retires automatically and eventually disappears from inspection after its purpose ends. A delayed producer cannot clear a replacement policy, and restart or temporary observation loss cannot erase transition history. Focus setting now fails closed when its quota cannot be proven usable, so callers receive an error instead of persisting unverifiable intent. The detector adds bounded live side state and a typed worker-to-main contract, while re-fold determinism, manual clear compatibility, independent scope delivery, and provider-owned measurement authority remain intact.

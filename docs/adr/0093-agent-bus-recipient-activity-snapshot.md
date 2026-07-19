# 93. Agent Bus delivery acknowledgements carry a recipient-activity snapshot

## Status

Accepted. Provisional number — fan-in renumbering per ADR 0020/0022. Complements
[ADR 0048](0048-file-backed-agent-bus-messages.md), whose `delivered` result continues to mean
socket acceptance, and [ADR 0055](0055-harness-activity-dispatch-claims-and-resource-holds.md),
whose Harness activity derivation remains canonical.

## Context

An Agent Bus send can reach a recipient while its Harness session is already active. The recipient
may not incorporate the message until a later model call, so its current reply can cross the newly
arrived message. A bare `delivered` result leaves the sender unable to distinguish that timing from
silence after an idle delivery.

Transport acceptance, Harness activity, notification injection, artifact reading, and message
processing are separate facts. A later active-to-quiescent transition proves only that work became
quiescent; it cannot identify which Bus message the recipient observed or acted on. Turning that
transition into a message-specific follow-up would create false causal certainty and additional Bus
traffic with the same timing ambiguity.

The Bus worker already has a read-only Keeper database connection, and Harness activity already
combines parent lifecycle, canonical child invocations, and attributable resources into
`active | quiescent | unknown`. Raw job state is therefore neither necessary nor sufficient for
sender feedback.

## Decision

A successful live publish acknowledgement may carry one optional `recipient_activity` object:

- `status` is `active`, `quiescent`, or `unknown`;
- `reason` is the canonical Harness activity reason;
- `observed_at` is the Unix-seconds time associated with the observation.

The Bus worker derives the object once from one consistent read-only projection snapshot immediately
before fanout. It uses the already-resolved stable recipient job identity and excludes Dispatch
reservation, process identity, paths, and other internal state. The observation is informational and
never gates, delays, retries, or changes delivery.

The field is present only on `delivered`. A recipient without a stable Keeper identity, an activity
read or validation failure, and any partial evidence-read failure omit the field. A complete canonical
derivation whose evidence is inconclusive emits `status: unknown`; omission means no valid snapshot is
available. `queued_for_wake`, no-fanout outcomes, and failed fanout carry no activity snapshot.

The shared decoder accepts acknowledgements without the field and ignores malformed objects and
unknown future values without changing the delivery result, recipient count, or exit behavior. Sender
copy describes the value as an observation at send time and never as availability, readiness, message
consumption, or processing.

Agent Bus emits no automatic lifecycle-derived follow-up receipt. Any future message-specific receipt
is an explicit correlated protocol tied to the original message identity and remains separate from
Harness activity.

## Consequences

- Senders can recognize when a successful message may not affect the recipient's current reply.
- `delivered` retains its socket-acceptance meaning, and non-CLI consumers remain compatible with the
  additive acknowledgement field.
- Projection lag and lifecycle races remain visible as qualified point-in-time evidence rather than
  stronger causal claims.
- Activity lookup failure degrades only the explanatory metadata; it cannot turn a successful delivery
  into a failed send.
- No Bus or Keeper database migration, persisted activity history, new writer, or post-send watcher is
  required.

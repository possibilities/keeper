# 0048 — File-backed Agent Bus messages

## Status

Accepted (number PROVISIONAL until landed; fan-in renumber per ADR 0020/0022). Supersedes the
message-body transport portion of ADR 0043; its session-scoped Pi watcher lifecycle remains
accepted. The retention scan shape is superseded by ADR 0076 (retention advances past
age-immune rows); the horizons and row-first artifact coupling recorded here stand.

## Context

Agent Bus notifications share bounded harness surfaces. Inline bodies fit only while short;
longer bodies require the watcher to clip a preview, write a receiver-side spill, and rely on the
receiving model to notice and follow the pointer. The bus also persists and replays the inline
body, even though every participant is a same-user process on the same host and can read one
private shared state tree.

The bus must deliver the same legible request shape regardless of body length, preserve offline
`queued_for_wake` delivery, remain compatible with legacy inline rows, and never turn a peer's
reference into an arbitrary filesystem read. Artifact cleanup must stay bounded and must not age
out a message that remains queued indefinitely.

## Decision

- Every new chat publish uses the claim-check pattern. The sending client writes the exact message
  bytes atomically to a private immutable Bus message artifact before publishing; the bus carries
  only a typed, versioned reference. The reference contains an opaque artifact id, byte length, and
  SHA-256 digest. It never carries an arbitrary absolute path.
- The artifact root is a Keeper-owned same-host state directory with exact private permissions.
  Reference resolution is confined beneath that root, rejects unsupported versions and malformed
  ids, and verifies a regular file plus the declared length and digest before presenting it.
- The watcher emits metadata only: sender identity and an explicit instruction to read the resolved
  artifact path. It emits no body preview. The reference text itself remains an explicit read
  instruction so an already-running legacy watcher presents a usable path during rollout.
- Consumers accept legacy inline envelopes and existing inline `queued_for_wake` rows. Producers do
  not create new inline chat messages. Unknown or malformed reference versions fail loud in one
  bounded notification and never fall back to interpreting reference-shaped text as an inline
  body.
- Bus delivery retains its existing meaning: socket acceptance. A queued artifact is protected for
  the row's full queued lifetime. Once terminally delivered, it remains readable for the ordinary
  seven-day message-retention horizon measured from delivery; receipt of the notification never
  deletes it.
- The bus worker owns artifact lifecycle after publication. Row pruning and artifact deletion share
  one bounded retention decision; cleanup failure is retryable and fail-soft. A bounded orphan pass
  collects artifacts whose sender died before publication without scanning the whole tree in one
  tick. Known non-delivery outcomes may remove their artifacts immediately; an acknowledgement
  timeout retains the artifact because delivery is uncertain.
- Message bodies remain capped at the existing one-mebibyte bus envelope ceiling. Artifact contents
  contain only the original body; attribution, timestamps, size, and integrity metadata stay in the
  reference and message row.
- The transport remains local-host and same-account. A remote Agent Bus requires a different blob
  transport rather than making local paths portable.

## Alternatives considered

- **Always spill on the receiver but continue carrying the body over the bus.** Rejected because it
  fixes notification clipping while retaining inline transport, persistence, and receiver-side
  inference.
- **Infer references from path-looking text.** Rejected because ordinary messages can collide with
  the syntax and attacker-influenced paths become arbitrary-read invitations.
- **Delete artifacts when the watcher emits a notification.** Rejected because notification is not
  consumption, replay can duplicate delivery, and a receiving model may read the file later.
- **Age-prune the artifact directory independently.** Rejected because `queued_for_wake` rows are
  deliberately age-immune and independent cleanup can create valid rows with dangling references.

## Consequences

Bus rows and live frames carry small references instead of message contents, and notification size
no longer changes the receiver workflow. Sending gains one local filesystem write and artifact
storage becomes part of bus retention. Legacy readers remain supported while new writers converge
on one contract. Operators can inspect a message body through its private artifact during the
retention window; the bus database remains the routing and lifecycle record rather than a second
copy of message content.

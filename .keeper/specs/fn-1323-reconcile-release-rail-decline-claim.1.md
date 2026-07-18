## Description

Resolve the F1 (+ merged F3) claim/diff drift from the fn-1322 close audit:
the decline half of the cooperative release rail ships a full read/annotate
body with NO production writer, while ADR 0078 presents recorded declines as
a shipped, honored v1 capability.

Evidence path (from the vet): src/commit-work/surface.ts -- WriteReleaseRecordInput
(~:1602) has no declines input field; writeReleaseRecord (~:1616) only carries
forward existing.declines (~:1634); cli/session.ts releaseMain never sets a
decline; the read/annotate/protocol body (parseReleaseDeclines,
declineMatchesClaim, requestDeclineAnnotation, DECLINE_PROTOCOL,
applyReleaseWitness) has no writer but tests. ADR 0078:49-51 ("Declines are
durable and honored") marks decline-recording IN for v1, with only
auto-forfeiture (line 52) deferred.

Default remedy (minimal, ship-safe): amend ADR 0078 to mark decline-RECORDING
as deliberately deferred, parallel to the auto-forfeiture deferral it already
carries, and add a forward-facing doc-comment on the read-side surface noting
it is the awaiting-producer half. Reconcile any done-summary/doc surface that
still presents production decline-recording as delivered. F3 (the missing
production decline round-trip test) needs no new test under this remedy --
there is no producer to exercise; it dissolves with the drift.

Alternative (worker's judgment, only if genuinely small): ship the producer
instead (extend WriteReleaseRecordInput with declines + a verb path to set
them), in which case add the production round-trip test F3 named.

Files:
- docs/adr/0078-cooperative-claim-release.md (mark decline-recording deferred)
- src/commit-work/surface.ts (doc-comment the read-side as awaiting-producer)

## Acceptance

- [ ] ADR 0078 states decline-recording is deferred, parallel to auto-forfeiture,
      matching the shipped surface.
- [ ] The decline read/annotate/protocol surface carries a forward-facing
      doc-comment marking it the awaiting-producer half of the rail.
- [ ] No doc or done-summary surface still presents production decline-recording
      as delivered.

## Done summary
Marked decline-recording deferred in ADR 0078 (parallel to auto-forfeiture), doc-commented the decline read/annotate surface as the awaiting-producer half, and reconciled the stale claim/diff drift in docs/problem-codes.md, the worker template, and fn-1322's task/epic done-summaries and audit brief.
## Evidence

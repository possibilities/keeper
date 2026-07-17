## Overview

Close the Agent Bus's two unbounded-growth paths per ADR 0076: message
retention advances past the age-immune undelivered wake-queue head (a
partial-index-served eligible-row scan, O(batch) per tick regardless of
immune-prefix size), and channel presence rows with no live socket age
out past a generous horizon even when pid identity is unverifiable —
Presence is holding an open watch subscription, not process liveness.
The single-watcher arming chain needed NO production change (the
duplicate-live rejection, terminal client exit, and Pi process-global
lease are all correct on main; no takeover circuit-breaker exists to
cull) — it gains pinning test coverage only.

## Quick commands

- `bun test ./test/bus-db.test.ts` — retention suite incl. the head-block and shared-artifact cases
- `bun test ./test/bus-worker.test.ts` — presence-reap + arming decision coverage
- `bun test ./test/pi-bus-inbox.test.ts` — Pi lease idempotency coverage

## Acceptance

- [ ] Aged eligible messages prune despite an immune head of any size; undelivered queued-for-wake rows are never deleted and the wake-queue replay contract is untouched
- [ ] Retention's per-tick cost is bounded by the batch (index-served), never by the immune-prefix length; no bus schema version bump
- [ ] A socketless channel row past the age horizon is reaped even when its start-time identity is unverifiable; a live-socket row is never reaped
- [ ] The duplicate-arm rejection chain and Pi lease idempotency are pinned by pure-seam tests; no arming production change

## Early proof point

Task that proves the approach: ordinal 1 (the head-block test against the
indexed skip-past scan). If the partial-index predicate proves unsupported
on the installed SQLite: fall back to the same eligible-row query unindexed
with a documented immune-prefix walk bound, and revisit the index shape.

## References

- docs/adr/0076-bus-retention-past-immune-rows-and-socketless-presence-reap.md — the epic's contract (committed at plan time; supersedes ADR 0048's scan shape only)
- docs/adr/0061-bus-takeover-only-over-dead-predecessor.md — arming idempotency rationale; the watch reconnect backoff is its mitigation and stays
- docs/adr/0059-bus-only-serve-stall-degrades-in-place.md — the serve-loop pacing constraint the scan must respect
- Wedge math: parking is total only when the immune head reaches the prune batch size (1000); below that retention drains at batch-minus-K per tick — the fix removes the class, not just the observed instance
- The immune set has NO escape valve by decision — unbounded wake-queue growth is the accepted durability cost (ADR 0076)
- NON-GOALS: bus fan-out / multiple subscribers per identity (retracted); chat-send transport changes

## Docs gaps

- **docs/problem-codes.md**: none expected — the bounds are internal caps minting no new operator-visible code; add a row only if the implementation surfaces one

## Best practices

- **Partial index excluding immune rows** keeps the skip-past scan O(batch) with unbounded immune prefixes; a flipped row enters the index on UPDATE, so no watermark cursor exists to strand it [Kafka active-segment analogy; sqlite.org]
- **Batch counts eligible rows** — predictable drain throughput independent of immune interleaving
- **kill(pid,0) EPERM is not dead** and start-time reads can fail persistently — bound presence by the subscription definition (socket + horizon), not by process forensics

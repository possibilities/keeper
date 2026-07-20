## Description

~780K events rows still carry ~1.2GB of shed-class cold bodies because
the incremental shed's small batches never catch up to the backlog. Under
the task-1 budget, raise the shed's effective throughput (larger bounded
units, more frequent resumption, or both) so the backlog drains to the
retention watermark within days of continuous operation, while ingest
stays current throughout.

## Acceptance

- The shed watermark reaches the cold-tail boundary on a representative
  fixture; the remaining un-shed body count matches the retention
  policy's keep-set exactly (no over-shed — the keep-set invariants from
  the existing retention tests continue to pass).
- Ingest freshness (newest-folded-event age) stays under 5 seconds in a
  deterministic test that interleaves ingest applies with a saturated
  shed backlog under the budget.
- Progress is observable: the shed logs one bounded line per N batches
  with watermark position and remaining-backlog estimate.

## Done summary

## Evidence

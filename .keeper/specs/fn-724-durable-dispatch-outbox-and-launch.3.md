## Description

**Size:** S
**Files:** CLAUDE.md, README.md

Update the dispatch-lifecycle docs to the new durable-ack + three-way-outcome
+ reap-on-pause contract.

### Approach

CLAUDE.md `## Autopilot dispatch gates` fn-678 bullet (~507-523): replace the
"mints Dispatched before launch" outbox-ordering claim with the await-ack
contract; replace the confirm_timeout→DispatchFailed flow with the indoubt
reclassification (row kept, TTL→DispatchExpired); add the reap-on-pause
discharge seam. Sole-writer event list (~62-68): no new event (note if that
changes). README fn-678 para (~1498-1509), eighth-worker para (~1654-1706),
and the `dispatch_failures.source` enum (~1510-1525, drop `confirm_timeout`
as a source if it no longer mints DispatchFailed). Keep it accurate: no
reducer/schema change.

### Investigation targets

**Required** (read before coding):
- CLAUDE.md ## Autopilot dispatch gates fn-678 bullet + sole-writer list.
- README.md fn-678 para, eighth-worker autopilot para, dispatch_failures source enum.
- The shipped .1/.2 behavior (so docs match the actual ack + indoubt + reap).

### Risks

- Don't leave the stale outbox-ordering / confirm_timeout-sticky claims alongside the new ones (implies both live). Revise in place.

## Acceptance

- [ ] CLAUDE.md fn-678 bullet rewritten (await-ack, indoubt, reap-on-pause seam); sole-writer list correct.
- [ ] README fn-678 + eighth-worker paras + dispatch_failures source enum updated; no-schema-change framing preserved.

## Done summary
Updated CLAUDE.md fn-678 bullet and README fn-678/eighth-worker paras + dispatch_failures source enum to the fn-724 durable-ack + three-way ConfirmOutcome (indoubt) + reap-on-pause contract; dropped confirm_timeout source; preserved no-schema-change framing.
## Evidence

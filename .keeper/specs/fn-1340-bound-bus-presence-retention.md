## Overview

Agent Bus Presence is a live watch subscription, but stale socketless channel rows can survive forever when their process identity still matches. The retention sweep also rereads a fixed oldest head, so 64 old connected rows can permanently hide reclaimable rows behind them and force an unindexed full scan/sort every tick. Make expiry follow the existing Presence contract and make bounded traversal actually progress.

## Quick commands

- bun test ./test/bus-worker.test.ts ./test/bus-db.test.ts ./test/pi-bus-inbox.test.ts
- bun run typecheck

## Acceptance

- [ ] A channel with no live watch subscription expires at the Presence horizon regardless of matching process identity, while a live subscribed socket is never reaped
- [ ] The bounded sweep eventually reaches reclaimable rows behind more than one full batch of connected rows without unbounded per-tick work
- [ ] Candidate traversal is served by an explicit index, and concurrent refresh/re-subscribe cannot let an old candidate delete fresh Presence
- [ ] Queued-for-wake immunity, takeover rules, send-only non-Presence, and process-identity early reap inside the horizon remain unchanged

## Early proof point

Task 1 first proves the pure decision boundary and keyset traversal against a greater-than-batch connected head. If the cursor cannot preserve both bounded work and eventual progress, stop rather than replace it with an offset or unbounded exclusion list.

## References

- CONTEXT.md — Presence means holding an open watch subscription, not process liveness
- docs/adr/0076-bus-retention-past-immune-rows-and-socketless-presence-reap.md — accepted expiry and retention bounds
- src/bus-worker.ts:595-630,1677-1745 — pure prune decision, live-socket fence, async sweep
- src/bus-db.ts:248-310 — channel upsert, oldest-row traversal, and identity-fenced delete
- test/bus-worker.test.ts:391-535 — existing liveness/horizon matrix
- test/bus-db.test.ts:732-947 — immune-head/index-plan and bounded channel-order precedents

## Best practices

- **Presence authority:** use the watch socket lease, never a merely live process, as the keep criterion after the horizon
- **Keyset progress:** advance over every examined `(last_heartbeat, channel_id)` row, including connected keeps, under separate bounded scan/probe/delete budgets
- **Freshness fence:** recheck the live socket and compare the candidate's observed durable heartbeat before deletion
- **Fail-open maintenance:** retention/index maintenance never bounces the Bus; strict identity uniqueness remains a separate boot-fatal invariant

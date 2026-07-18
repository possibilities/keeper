## Description

**Size:** M
**Files:** src/bus-worker.ts, src/bus-db.ts, test/bus-worker.test.ts, test/bus-db.test.ts, test/pi-bus-inbox.test.ts, docs/adr/0076-bus-retention-past-immune-rows-and-socketless-presence-reap.md

### Approach

Align `channelPruneDecision` with the glossary and ADR: a row without a live subscribed socket is prunable once `now - last_heartbeat >= CHANNEL_PRESENCE_HORIZON_MS` even when its process identity still matches; before the horizon, preserve the grace plus dead/recycled/unverifiable identity policy. Horizon-expired rows do not consume the process-probe budget. Replace fixed-head rereads with an indexed `(last_heartbeat, channel_id)` keyset traversal whose cursor advances over every examined row and persists in worker memory across retention ticks, wrapping after the ordered set ends. Keep each tick single-flight and independently bound rows examined, identity probes, and deletions; a restart may reset the maintenance cursor without changing correctness. Before deleting, recheck live subscription and CAS the observed identity plus `last_heartbeat` so re-registration freshness wins. Retire a horizon-expired open-but-unsubscribed registration connection before removing its registry entry. Preserve queued-for-wake rows/artifacts, takeover decisions, and `send_only` non-Presence byte-for-byte. Add the traversal index in the unconditional create-if-missing block without a bus schema bump, following the Bus's fail-open maintenance-index policy.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/bus-worker.ts:595-630 — pure channel-prune policy and the matching-identity keep to replace after the horizon
- src/bus-worker.ts:642-670,1677-1745 — RegistryEntry Presence witness, reconnect fence, probe cap, and deletion path
- src/bus-worker.ts:1747-1795 — asynchronous retention timer that needs a single-flight owner for cursor state
- src/bus-db.ts:52-105,139-166 — strict identity index versus fail-open query-index creation
- src/bus-db.ts:248-310 — upsert freshness, fixed-head load, and delete fence
- docs/adr/0076-bus-retention-past-immune-rows-and-socketless-presence-reap.md:20-48 — accepted keep-set and no-schema-bump decision

**Optional** (reference as needed):
- test/bus-db.test.ts:732-875 — immune-head progress and semantic query-plan assertions
- test/bus-worker.test.ts:242-321 — takeover and send-only regression matrix
- test/pi-bus-inbox.test.ts:171-201 — single-watcher lease behavior

### Risks

- Advancing only after a deletion recreates connected-head starvation; advance on every examined row and use a unique tie-breaker.
- Deleting by identity alone can erase a row freshly upserted while a process probe awaited; include the observed heartbeat/freshness stamp and treat a zero-row delete as a benign keep.
- Removing a registry entry while its old registration connection remains open permits a late subscribe outside the registry; close that stale connection as part of retirement.
- An unindexed ordered limit is row-bounded but not work-bounded; assert index use without snapshotting SQLite's exact explain prose.

### Test notes

Deterministically pin the inclusive horizon, live-socket override, expired matching-identity prune with zero probes, and inside-horizon process checks. Seed more than 64 equal/old connected rows plus stale socketless rows behind them; run bounded ticks and prove eventual reach, wrap, and equal-timestamp ordering. Race a same-identity re-upsert between candidate read and delete and prove the fresh row survives. Assert the traversal index is used broadly, and rerun queued-for-wake, takeover, send-only, and Pi single-watcher cases. No real worker, socket, process, daemon, or sleeps.

## Acceptance

- [ ] Socketless Presence expires inclusively at the horizon even for a matching live identity, without consuming a probe; a live subscribed socket always survives
- [ ] The single-flight keyset sweep makes eventual progress beyond a connected head larger than its per-tick batch while keeping scan, probe, and delete work bounded
- [ ] Equal-timestamp traversal neither skips nor duplicates candidates, wraps cleanly, and is served by the intended composite index
- [ ] A candidate refreshed or re-subscribed during async work survives through the live-socket and observed-heartbeat fences; a stale unsubscribed connection is retired with its row
- [ ] Queued-for-wake immunity, takeover, send-only, and watcher-lease regressions remain green
- [ ] Focused Bus tests and typecheck pass

## Done summary

## Evidence

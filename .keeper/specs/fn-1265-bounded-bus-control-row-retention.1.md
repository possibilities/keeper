## Description

**Size:** S
**Files:** src/bus-db.ts, src/bus-worker.ts, test/bus-db.test.ts

### Approach

Add a control-row prune to the bus DB layer: a pure, bounded-batch,
oldest-first delete scoped to the reserved control namespace's
lifecycle events (join/part/reap/takeover), mirroring the existing
message-prune shape (single immediate transaction, id-ascending
front window, queued-for-wake rows immune), driven from the bus
worker's paced retention pass under a dedicated horizon or count cap
constant. The existing backlog must drain through successive paced
ticks — never a bulk full-table DELETE, which re-parks the serve loop
(the very symptom being fixed). Every step fails soft; retention must
never throw. If an index is needed to keep the prune bounded, append
it to the bus DB's own forward-only migration ladder and bump its
schema version (bus.db is a separate store from keeper.db with its
own ladder). Producer-side takeover-row dedupe is a non-goal — note
it for a follow-up if churn stays high after retention lands.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves.*

**Required** (read before coding):
- src/bus-db.ts:429 — pruneMessagesOlderThan: the bounded-batch prune shape to mirror (and its bulk-DELETE warning comment above it)
- src/bus-worker.ts:1527 — runRetentionPass: where the new prune wires in (fail-soft, paced, WAL/vacuum already handled)
- src/bus-worker.ts:1578 — publishControl + CONTROL_NAMESPACE: the sole producer of the rows being bounded
- src/bus-worker.ts:117 — retention tuning constants; the new horizon/cap lives alongside
- src/bus-db.ts:40 — BUS_SCHEMA_VERSION + migrateBusDb, if an index is required
- test/bus-db.test.ts:159 — the append-then-prune test structure to mirror over an in-memory bus.db

## Acceptance

- [ ] The bus worker's retention pass prunes control-namespace lifecycle rows under a dedicated bounded horizon or cap, in bounded oldest-first batches, never via a full-table delete
- [ ] Chat/pair message rows and queued-for-wake rows are provably untouched by the new prune (covered by tests over an in-memory bus DB)
- [ ] A large pre-existing control-row backlog drains to the bound across repeated retention passes in tests, with each pass's work bounded
- [ ] Retention failures stay soft: an injected prune error never propagates out of the retention pass

## Done summary
Added pruneControlMessagesOlderThan to bus-db.ts (namespace-scoped, oldest-first, bounded-batch prune reusing the existing (namespace,id) index) and wired it into bus-worker.ts's runRetentionPass under new CONTROL_RETENTION_HORIZON_MS (24h) / CONTROL_PRUNE_BATCH constants, fail-soft like the sibling message prune. Added namespace-isolation, queued-for-wake-immunity, batch-drain, and no-op tests in bus-db.test.ts.
## Evidence

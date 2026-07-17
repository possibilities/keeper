## Description

**Size:** M
**Files:** src/bus-db.ts, test/bus-db.test.ts

### Approach

Implement ADR 0076's retention scan in the pure bus-db helpers: an
eligible row is aged past its horizon AND not an undelivered
queued-for-wake row; the prune deletes eligible rows THROUGH the
immune set instead of reading only the front window. Serve the scan
with a partial index on messages that excludes queued-for-wake rows,
added to the unconditional create-if-missing index block — NO bus
schema version bump, and a failed create must not wedge the
boot-critical migrate (keep the existing fail-open discipline). The
batch bound counts ELIGIBLE rows. The function's return contract is
unchanged: it returns exactly the artifact ids of rows it deleted
whose artifacts became unreferenced — the row-first artifact GC in the
worker depends on returned-set === deleted-set. The skip predicate is
exactly the queued-for-wake status exclusion, never a broader
recently-delivered filter; a row that flips off queued-for-wake enters
the partial index on that UPDATE and ages out via the ordinary
re-evaluated scan. Apply the same eligible-row shape to the
control-namespace prune (defense-in-depth — control rows are never
immune today; keep the status filter and its existing test). Verify
the partial-index predicate is honored by the installed SQLite inside
the test suite (query plan or behavior probe), and keep every per-tick
operation bounded — no bulk DELETE, no scan whose cost tracks the
immune-prefix length.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/bus-db.ts:475-510 — pruneMessagesOlderThan, the front-window scan to replace; :538 pruneControlMessagesOlderThan (same shape, namespace-scoped)
- src/bus-db.ts:512 — artifactRowExists (order-independent global existence; the returned-set contract's consumer side)
- src/bus-db.ts:442 — selectQueuedForWake (the durable ordered consumer that must be untouched); :422-429 status free-text values (only undelivered queued_for_wake is immune)
- src/bus-db.ts:51-136 — schema, CREATE_MESSAGES_INDEXES unconditional block, migrateBusDb + downgrade throw; the new index belongs in the unconditional block
- src/bus-worker.ts:255 — cleanupBusArtifacts, the row-first artifact GC caller of the return value
- test/bus-db.test.ts:437-596 — existing retention coverage (exact deleted-id assertions; additive change should keep them green); :338 the queued-for-wake append helper
- docs/adr/0076-bus-retention-past-immune-rows-and-socketless-presence-reap.md — the contract

**Optional** (reference as needed):
- src/bus-worker.ts:121-156 — retention constants (horizons, batch sizes, interval)
- src/bus-worker.ts:1355 — the delivered_after_wake status flip (the flip-back path the re-evaluated scan must catch)

### Risks

- Returned-set vs deleted-set drift silently breaks artifact GC — a pruned row's artifact shared with a surviving immune row must NOT be collected
- The partial-index predicate must be proven against the installed SQLite build; if unsupported, fall back per the epic's early-proof recovery and document the walk bound
- Changing batch semantics (eligible-rows-counted) moves drain throughput — pin it explicitly in tests

### Test notes

New cases: a head block of immune rows at low ids (at and above the
batch size) with aged eligible rows behind them — eligible rows prune
despite the head; an artifact referenced by both a pruned row and a
surviving immune row is retained; the subscribe-ack id fence
(maxMessageId) is unchanged by a prune; the batch bound counts
eligible rows. Existing exact-id assertions stay green.

## Acceptance

- [ ] Aged eligible messages prune when an immune head of any size precedes them; undelivered queued-for-wake rows survive every prune and the wake-queue replay read returns them in id order unchanged
- [ ] The prune's per-tick cost is bounded by the batch via the index (proven by a plan or behavior probe in the suite), and the bus schema version is unbumped
- [ ] The prune returns exactly the deleted rows' newly-unreferenced artifact ids; a shared artifact with a surviving immune row is never returned
- [ ] The control-namespace prune shares the eligible-row shape with its status filter intact
- [ ] The full fast correctness gates stay green

## Done summary

## Evidence

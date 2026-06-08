## Description

**Size:** M
**Files:** src/server-worker.ts and/or src/reducer.ts (per `.1` finding), test/server-worker.test.ts

### Approach

Apply the smallest safe lever `.1` identified and prove the p95 win on the same
harness. Likely candidates (confirm against `.1`): subscribe sends a full
snapshot once then row-level deltas (build on `diffTick`'s version-probe);
switch large worker payloads to the top-level `postMessage(string)` fast path;
compute deltas from per-row versions not full-snapshot diffing; add a
`wal_checkpoint(PASSIVE)` cadence. Preserve: cursor+projection single
`BEGIN IMMEDIATE`, short batches (don't starve hook INSERTs), re-fold
determinism, the `data_version` poll/kick contract (separate RO poller; same-conn
writes don't bump data_version, so keep the explicit kick).

### Investigation targets

**Required:**
- the `.1` harness + finding (dominant cost + chosen lever)
- src/server-worker.ts:597,1973-2080 (serve/diff paths to modify)
- src/reducer.ts drain/applyEvent (if fold-side is the lever)

### Risks

- Delta-on-update must stay correct (a missed delta = stale board) — pair with a
  periodic full-snapshot reconcile or a version-cursor the client acks.
- postMessage(string) fast path only triggers when the string is the top-level
  message — don't wrap it.
- Don't break re-fold determinism or the single-writer transaction.

### Test notes

- Re-run the `.1` harness; assert before/after p95 improvement.
- Pin: delta-served board matches a full-snapshot render (no missed changes).

## Acceptance

- [ ] Measured p95 improvement on the harness for the targeted cost
  (single-digit-second connect; sub-second updates under normal load).
- [ ] Delta correctness pinned (delta board == full-snapshot board); determinism
  + single-writer transaction + poll/kick contract unchanged.

## Done summary

## Evidence

## Description

**Size:** M
**Files:** test/server-worker.test.ts, scripts/ (new load harness), src/server-worker.ts + src/reducer.ts (instrument, read-first)

### Approach

Build a controlled, repeatable load harness that reproduces the two symptoms
against a live-size projection: (a) cold subscribe-connect time serving the
~1.26MB snapshot, (b) board update latency while a fold burst runs, (c)
per-fold latency on a large (~600k) event log. Instrument the hot paths
(`serveFromMemo` serialize cost, `diffTick` per-tick cost, drain/applyEvent
cost) and ATTRIBUTE the dominant cost. Write the finding into the Done summary:
which safe lever `.2` should pull (delta-on-subscribe-update, postMessage(string)
fast path, per-row version deltas, WAL checkpoint cadence, or fold-batch tuning).
Record before p50/p95/p99.

### Investigation targets

**Required:**
- src/server-worker.ts:597,630,646 — `serveFromMemo` + `MEMO_SIGNATURE_CAP`
  (cold snapshot serialize on miss)
- src/server-worker.ts:1973,2044,2080,267 — `diffTick`, version-probe
  (`selectVersionsByIdsChunked`), changed-row fetch, the "~21 subscribers
  serially on one event loop" cost note
- src/reducer.ts:163 `DEFAULT_BATCH_SIZE`, the drain loop + `applyEvent`
- test/server-worker.test.ts — existing serve/diff test patterns

### Risks

- n=1 production anecdote (5.4s) is not a baseline — the controlled harness is
  the real instrument; measure, don't assume the lever.
- Use monotonic `performance.now()` for durations.
- Instrumentation must not change fold/serve semantics or determinism.

### Test notes

- The harness IS the deliverable: it deterministically measures connect/update/fold
  p95 at live scale and attributes the dominant cost.

## Acceptance

- [ ] Repeatable harness measuring cold-connect, update-under-burst, and fold p95
  at live scale.
- [ ] Dominant cost attributed; the safe lever for `.2` named in the Done summary
  with before-metrics.

## Done summary

## Evidence

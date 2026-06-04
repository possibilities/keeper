## Description

**Size:** S
**Files:** scripts/bench-latency.ts (reference), src/server-worker.ts (read-only diagnosis), findings note

Lever C, diagnose-only. bench-latency surfaced tight batch-flush clusters
(4-5 rows all surfacing at 698ms, then 1199ms) — the server-worker event
loop was blocked, then flushed a batch when it freed. Find the stall
cause from REAL trace evidence; do NOT pre-commit a fix (its scope is
unknowable until the trace is read).

### Approach

Run the live daemon with `KEEPER_TRACE_SERVER=1` while driving
`scripts/bench-latency.ts`, and capture the existing instrumentation: the
"poll-loop sleep overrun" line (~:1765, fires when the event loop didn't
wake on time) and the "diffTick duration" line (~:1782). Correlate stall
windows with diffTick durations to localize the blocker — leading
suspects: large epics JSON decode in diffTick, a slow query on the
worker's read connection, or `SQLITE_BUSY` busy-wait during a large fold.
Record a findings note (stall signature, suspected cause, supporting trace
lines). Then make a GATED decision: if the cause is in-scope (the
pollLoop/diffTick itself — e.g. a decode or query to optimize), fold the
fix into this task or a tight follow-up; if it's out-of-scope (reducer/GC/
event-loop contention elsewhere), file the findings and recommend a
separate epic. Either way the deliverable is evidence + a decision, not a
speculative fix.

### Investigation targets

**Required** (read before coding):
- src/server-worker.ts:1750-1787 — `pollLoop` + the sleep-overrun detector at :1765
- src/server-worker.ts:1477 — `diffTick`; the staged `performance.now()` timing + duration log at :1782
- src/server-worker.ts (TRACE const ~:276) — `KEEPER_TRACE_SERVER` gating
- scripts/bench-latency.ts — the load generator / measurement harness

**Optional** (reference as needed):
- Commits 01d9130, 83012ce — prior diffTick perf passes (what's already optimized)
- src/collections.ts — epics JSON columns (decode cost suspect)

### Risks

- The stall may be intermittent under low load — drive enough concurrent activity (multiple sessions) to reproduce the clusters seen in the original measurement.
- A fix, if in-scope, overlaps lever B's server-worker.ts edits — sequence after B.

### Test notes

No production code change is guaranteed here; the "test" is reproducing
the stall signature under trace and documenting it. If a fix lands, it
gets its own test against the pollLoop/diffTick harness.

## Acceptance

- [ ] stall signature reproduced and captured from real KEEPER_TRACE_SERVER traces (sleep-overrun + diffTick-duration lines)
- [ ] findings note records the suspected cause with supporting trace evidence
- [ ] gated decision made: in-scope fix folded in, or out-of-scope finding filed with a follow-up recommendation
- [ ] decision + evidence recorded in Evidence

## Done summary

## Evidence

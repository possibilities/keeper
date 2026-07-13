## Description

**Size:** S
**Files:** src/readiness-inputs.ts, src/reconcile-core.ts, src/autopilot-worker.ts, src/autoclose-worker.ts, test/autopilot-worker.test.ts, test/autoclose-worker.test.ts

### Approach

Make the readiness-input reader distinguish an ERROR frame from a genuinely-empty result
(today `read()` coerces any non-result frame to `[]`, so a transient read error looks like
an empty board). Surface it as a `degraded` marker on the loaded inputs (in-memory shape
only — no schema). A degraded tick DEFERS: reap/occupancy consumers (slot reclaim sweep,
autoclose pulse) mint nothing and preserve their grace maps, and the dispatch pass skips
the cycle (the level-triggered reconciler re-runs next tick). A genuine empty set remains
a valid observation — a fresh board must still dispatch. This is the "absence of an
observation is never resolution" idiom the recover pass already uses, generalized to the
one input seam both reapers and the reconciler share.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/readiness-inputs.ts:79 — the read() coercion of non-result frames to []; the seam to change
- src/autoclose-worker.ts:172 — the null-or-empty pane sweep skip; the deferral pattern to mirror
- src/reconcile-core.ts:1791 — computeSlotOccupancy's existing livePaneIds===null degraded guard

**Optional** (reference as needed):
- src/reconcile-core.ts — EpicRecoverVerdict "inconclusive" DEFER idiom (non-result read frame)
- cli/query.ts, cli/watch.ts, cli/autopilot.ts — audit for the same swallow-to-empty; report findings in Done summary, fix only if trivially local

### Risks

- The same read() feeds dispatch: a blanket empty→skip would freeze a fresh board. Only the
  ERROR case may defer; empty-result frames stay valid.
- Skipping the dispatch pass on a degraded tick must not wedge: the reconciler is
  level-triggered, so the retry is the next data_version tick — verify no consumer latches.

### Test notes

In-process regression tests: an error frame on the jobs read → the tick defers (no reclaim
classification, no autoclose reaps, no new dispatch plans); an empty result frame → normal
dispatch on a fresh board. Drive grace/clock via injected now; retryUntil for async.

## Acceptance

- [ ] An errored jobs/epics read marks the loaded readiness inputs degraded, and that tick performs no reap classification, no autoclose reap, and no new dispatch
- [ ] A genuinely empty jobs result still dispatches ready work (fresh-board behavior unchanged)
- [ ] Regression tests cover both paths in the fast suite

## Done summary

## Evidence

## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/board-render.ts, src/readiness.ts, src/dispatch-failure-pill.ts, cli/escalation-brief.ts, test/refold-equivalence.test.ts, test/reducer-projections.test.ts, test/dispatch-failure-pill.test.ts

### Approach

One forward-only ladder entry (version assigned at merge, fingerprint re-pinned) reshapes escalation state into the incident projection: the staged once-markers and the block-escalation stage latch collapse into incident columns on the existing per-key rows — owner reference and generation, durable attempt count, assignment time, reason ref, and human_notified_at copied forward so no migrated row can re-page. The latch folds are replaced by incident folds that stay deterministic, never throw, and replace-merge per key with schema defaults matching the zero-event projection; the claim and attachment folds from the integration epics converge here as the only writers. Board surfaces re-render: incident rows slot into the existing needs-human subset accounting without double-counting, pills name incidents instead of escalation sessions, and the brief CLI reads the incident shape. Re-fold determinism is proven by the equivalence suite over the new folds.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/db.ts:5773-5784 plus the latch-column migrations at :3529, :3681, :3805, :4009 — the shape being collapsed
- src/reducer.ts:6208-6484 — the latch folds being replaced; :4284-4312 the marker-preserving UPSERT
- src/db.ts SCHEMA_STEPS tail and the fingerprint pinning — ladder discipline
- src/board-render.ts:440 and src/readiness.ts:1385 — the render and needs-human accounting seams
- test/refold-equivalence.test.ts — the determinism proof that must stay green

**Optional** (reference as needed):
- src/dispatch-failure-key.ts — reason classification helpers the projection keys reuse

### Risks

- The rewind class matters: dispatch failures are deterministic-replayed — the migration must compose with wipe-and-replay while the carried-forward human_notified_at survives, which means the carry-forward must be event-derivable or explicitly seeded as a versioned migration step, not invented by the fold
- Double-counting in needs-human is silent and wrong in both directions — assert the total against fixtures with mixed incident and non-incident rows

### Test notes

Fold suites over synthetic event streams for every incident transition; refold-equivalence green; migration test from a pre-collapse fixture DB proving no re-page and no lost page state; pill and board fixtures updated. Named gates.

## Acceptance

- [ ] Escalation state lives entirely in the bounded per-key incident projection with deterministic folds and a green equivalence suite
- [ ] A migrated row that already paged never pages again, and un-paged rows keep exactly one future page
- [ ] Board, readiness, pill, and brief surfaces read the incident shape with correct needs-human totals
- [ ] The ladder entry is version-at-merge with the fingerprint re-pinned; all suites green via named gates

## Done summary

## Evidence

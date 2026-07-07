## Description

**Size:** M
**Files:** cli/watch.ts, test/watch.test.ts

### Approach

Extend the coarse delta vocabulary with additive top-level delta types for the six needs-human families: dead-letter, block-escalation, parked-question, stuck-dispatch, finalize-non-ff, instant-death-wall (exact type names follow the existing naming conventions; they must be NEW top-level types, never new kinds routed through an existing type — that would be a shape change). CoarseBoard gains keyed categorical members derived through the shared projector: dead letters keyed by id, block escalations keyed, parked questions keyed by epic, dispatch failures keyed (verb,id) mapped to their most-specific jam class — operator-jam rows only, so self-clearing occupancy blips never project and never emit — and the instant-death wall as a threshold bool that flips on crossing, not per row. Drop last_event_id (and any churn-bearing column) from the projection so a reducer re-write with no net state change diffs to zero; every new delta rides the existing createDeltaEmitter coalesce/flap-settle, never a parallel emitter. Each delta's data names the key, the operation (appeared/cleared), and the reason class so a supervisor can triage from the delta alone. keeper watch itself opts into includeDispatchFailures unconditionally. Extend WATCH_DELTA_TYPES (the single edit point for the type union, --filter allowlist, and validator), revise HELP in place, and leave WATCH_SCHEMA_VERSION unchanged — the addition is purely additive and unknown types are no-op-skipped by old consumers.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/watch.ts:76-83 — WATCH_DELTA_TYPES single edit point; :133-166 — CoarseBoard; :174-223 — projectCoarseBoard and the deliberate-drop comment this task revises; :259-360 — diffCoarseBoard; :478-578 — createDeltaEmitter and the settle pipeline; :56-72 — FLAP_SETTLE_MS rationale
- src/needs-human.ts — the shared projector (task 1) providing classification; consume it, never re-derive
- src/collections.ts:640-654 — the dispatch_failures descriptor whose last_event_id versioning is the churn source
- test/watch.test.ts:38 (makeSnap overrides — add a dispatchFailures field), :80-330 (delta pair-diff test shape), :251/:475/:527 (makeClock + driveEmitter settle tests)

**Optional** (reference as needed):
- cli/watch.ts:275-333 — how epic-status/runtime-status route through verdict-change kinds: the precedent NOT to follow for these six (new top-level types instead)

### Risks

- Any path that bypasses the settle window flaps one line per reducer write — the exact heartbeat noise the original drop comment was avoiding.
- Threshold flap at the wall boundary: the settle window absorbs same-cycle 1↔2 crossings; a genuine slow re-cross SHOULD re-fire (that is signal, not flap).

### Test notes

Pair-diff tests per family: appeared, cleared, and no-op-churn (same rows, bumped last_event_id → zero deltas). Wall threshold: 1→2 fires, 2→1 clears, same-cycle flap nets to zero via makeClock. Most-specific classification: a finalize-non-ff row emits only its own type. Filter tests for the new type names; baseline line carries the new CoarseBoard members.

## Acceptance

- [ ] Each of the six needs-human families emits a crisp, filterable, additive top-level delta on appearance and clearing; the stream schema version is unchanged and unknown-type consumers are unaffected
- [ ] Dispatch-failure deltas fire on operator-jam rows only, each row classified most-specific exactly once; self-clearing occupancy rows emit nothing
- [ ] Reducer-write churn with no net state change emits zero deltas
- [ ] The instant-death-wall delta flips on threshold crossing, not per row
- [ ] --filter accepts the new types, help text is revised in place, and delta tests cover appear/clear/no-op-churn per family

## Done summary
Added six additive top-level needs-human watch deltas (dead-letter, block-escalation, parked-question, stuck-dispatch, finalize-non-ff, instant-death-wall) derived through the shared projectNeedsHuman — operator-jam rows only, most-specific class, wall as a crossing bool; WATCH_SCHEMA_VERSION unchanged.
## Evidence

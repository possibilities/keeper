## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/collections.ts, test/db.test.ts, test/reducer-projections.test.ts, test/refold-equivalence.test.ts

### Approach

Extend `DispatchCleared` with explicit `expected_attempt_id` and `expected_instance_event_id` fields and make each Fold effect an independent exact compare-and-clear. Add nullable attempt ownership to `dispatch_failures` and `dispatch_mint_gate`; the existing `instance_event_id` remains the failure-episode fence. Claims and pending rows already carry their attempt.

Modern clears release a claim, pending launch, or mint gate only on exact attempt equality, and delete a failure row only on exact incident equality. Breaker streak accumulators leave the clear effect set entirely: tripping preserves the streak, while existing positive bind/survival evidence resets it. Tokenless historical events retain only deterministic legacy-unfenced compatibility; deployment does not trigger a rewind.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/reducer.ts:4112-4203` — current clear payload/parser omits all ownership identity.
- `src/reducer.ts:4211-4325` — failure attempt is parsed then dropped; clear currently deletes/release by key.
- `src/reducer.ts:4379-4800` — shared attempt parser and exact claim-release SQL patterns.
- `src/reducer.ts:5035-5298` — breaker streak lifecycle, threshold mint, and positive-evidence resets.
- `src/db.ts:5688-5925` — failure, pending, claim, breaker, and producer mint-gate schemas/helpers.
- `src/collections.ts:634-669` — failure wire descriptor that must expose owner metadata to producers.

**Optional** (reference as needed):
- `test/reducer-projections.test.ts:2366-2410` — existing key-wide clear assertions to replace.
- `test/reducer-projections.test.ts:2670-3033` — exact claim stale/release/supersede matrix.
- `test/refold-equivalence.test.ts:140-151` — retained clear events and replay coverage.
- `docs/adr/0070-attempt-and-incident-fenced-dispatch-clears.md` — accepted ownership and legacy semantics.

### Risks

- Missing fields must distinguish immutable legacy events from malformed or partially modern payloads; a missing field cannot silently become current-owner authority.
- Failure UPSERT preserves `instance_event_id` for one open episode while updating informational attempt ownership; conflating the two breaks either retries or cross-attempt incidents.
- The migration ladder is a singleton resource; assign its provisional version at merge time and re-pin `SCHEMA_FINGERPRINT`.
- Prospective rollout must not invoke a full replay or wipe live-only producer state.

### Test notes

Build table-driven histories for matching A clear, delayed A after B acquire/bind, duplicate A, mixed incident A/attempt B, explicit null/legacy-unfenced state, malformed partial fences, and future re-fold. Prove breaker streaks survive retry and re-trip immediately until positive recovery evidence resets them. Keep all tests in-process over migrated memory databases.

### Detailed phases

1. Add nullable owner columns/defaults and update descriptor/helper surfaces.
2. Parse explicit modern fences while retaining a bounded tokenless-legacy branch.
3. Replace key-wide deletion/release with per-effect exact SQL predicates.
4. Remove breaker streak deletion from clear and preserve threshold evidence.
5. Pin migration, zero-event defaults, malformed-event totality, and re-fold equivalence.

### Alternatives

- Do not infer the expected attempt from the current claim during Fold; that gives delayed work the newer owner's token.
- Do not fence breaker streaks by attempt; they intentionally aggregate successive failed attempts.
- Do not add a force-clear wildcard; exceptional repair requires a separately authorized event design.

### Non-functional targets

- Every matching/mismatch decision is O(1) over indexed target rows.
- Malformed events safely advance the Cursor without throwing.
- Duplicate/stale clears produce no projection churn beyond bounded diagnostics outside re-fold.

### Rollout

The additive schema/fold task is safe before producer activation. Existing live rows receive NULL owner defaults; no forced rewind or projection wipe runs.

## Acceptance

- [ ] A modern clear mutates claim, pending, mint-gate, and failure rows only when each row's exact attempt or incident owner matches its corresponding expected fence.
- [ ] A delayed attempt-A clear preserves every attempt-B row while still being able to clear a matching incident-A row; duplicates are idempotent.
- [ ] Tokenless history can affect only deterministic legacy-unfenced state and cannot release an exact modern attempt during any future re-fold.
- [ ] `DispatchCleared` no longer resets never-bound or instant-death streaks; a still-broken retry re-trips from preserved evidence and positive recovery resets normally.
- [ ] The additive migration, schema fingerprint, descriptor surface, malformed payload matrix, targeted fold tests, and re-fold suite pass without a production rewind.

## Done summary

## Evidence

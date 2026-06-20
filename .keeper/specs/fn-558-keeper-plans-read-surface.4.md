## Description

**Size:** S
**Files:** src/collections.ts, test/collections.test.ts (or extend server-worker/integration test)

Register `epics` and `tasks` as `CollectionDescriptor`s so the existing
UDS subscribe server serves them with zero `server-worker.ts` edits.

### Approach

Add `EPICS_DESCRIPTOR` and `TASKS_DESCRIPTOR` modeled on `JOBS_DESCRIPTOR`,
and add both to `REGISTRY`. For each: `table`/`columns` from the v6 schema,
`pk` = `epic_id`/`task_id`, `version` = `last_event_id` (the monotonic
column the diff fires on), a sensible `sortable` set + `defaultSort`
(e.g. `updated_at desc`), and `filters` mapping wire keys → SQL columns —
**MUST include the pk** (detail-page single-item subscribe) and the
natural filter columns (epics: `status`, `project_dir`; tasks: `epic_id`,
`status`, `target_repo`). `jsonColumns` stays empty (no JSON-array columns
are projected this phase). The descriptor is the sole SQL-identifier
injection gate — only its constants are interpolated; wire filter keys are
resolved by map lookup. Verify `server-worker.ts` needs no change.

### Investigation targets

**Required:**
- src/collections.ts:50-106 — `CollectionDescriptor` interface, `JOBS_DESCRIPTOR`, `REGISTRY`, the injection invariant
- src/collections.ts:123-242 — `selectByIds`/`decodeRow`/`countAndToken` (descriptor-parameterized; confirm they work unchanged for the new descriptors)
- src/server-worker.ts:279-413 — `resolveFilter`/`runQuery` routing through `getCollection` (confirm zero edits needed)

**Optional:**
- src/protocol.ts — frames are generic over `Row`; no protocol change needed

### Risks

- Pick `columns` that exactly match the v6 table; a typo'd identifier is a
  runtime SQL error (descriptor constants are interpolated).
- Keep `title`/`status` display columns out of `sortable`/`filters` only if
  intentionally non-sortable; per spec, `status` IS a useful filter — include it.

### Test notes

A descriptor/collections test (or extend the server-worker/integration
test): hand-insert `epics`/`tasks` rows, `query` each collection, assert
`result` columns + `total`, a pk filter returns the single row, and a
`status` filter narrows the set.

## Acceptance

- [ ] `EPICS_DESCRIPTOR` + `TASKS_DESCRIPTOR` registered in `REGISTRY`; `getCollection("epics"/"tasks")` resolves
- [ ] Each descriptor's `version` is `last_event_id`; `filters` includes the pk plus `status` (+ `project_dir`/`epic_id`/`target_repo`)
- [ ] `src/server-worker.ts` is unchanged; a `query` over the new collections returns a `result` page
- [ ] Injection invariant holds: no wire text reaches SQL except via descriptor map lookup

## Done summary
Registered EPICS_DESCRIPTOR + TASKS_DESCRIPTOR in REGISTRY (version=last_event_id; filters include pk + status + project_dir/epic_id/target_repo), serving both plan collections over the existing UDS subscribe server with zero server-worker.ts edits. Added test/collections.test.ts covering registry resolution, paged result + total, pk filter, and status/epic_id filters.
## Evidence

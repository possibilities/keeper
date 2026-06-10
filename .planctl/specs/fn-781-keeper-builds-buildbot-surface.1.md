## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/collections.ts, keeper/api.py, test/reducer-projections.test.ts, test/collections.test.ts

### Approach

Land the full server-side data contract: the `builds` projection table,
the `BuildSnapshot`/`BuildDeleted` synthetic-event payload shape, the
reducer fold, and the `builds` collection descriptor. Table: one row per
builder, pk `project` (builder NAME — stable across master DB rebuilds),
columns `builder_id INTEGER`, `build_number INTEGER`, `complete INTEGER`,
`results INTEGER` (nullable — NULL means running), `state_string TEXT`,
`started_at`, `complete_at` (nullable), `last_event_id`, `updated_at`.
Schema defaults must match the zero-event projection (fresh table is
empty; no backfill). Bump SCHEMA_VERSION 63->64 and add 64 to
keeper/api.py SUPPORTED_SCHEMA_VERSIONS in the SAME commit.

Define the wire payload with an exported serializer + null-safe extractor
pair (the fn-651 field-drop lesson: pin the shape with a direct test).
Fold `projectBuildsRow`: UPSERT on BuildSnapshot keyed by
`event.session_id` (builder name), DELETE on BuildDeleted; malformed
`data` folds to a no-op with the cursor still advancing (never throw);
`updated_at` comes from `event.ts`, never wall-clock. Add the arm to the
existing `applyEvent` switch — do NOT open a new transaction. Add
`DELETE FROM builds` to the rewind-and-redrain wipe list.

Descriptor: `BUILDS_DESCRIPTOR` (table `builds`, pk `project`, version
`last_event_id`, defaultSort `project ASC`, filter `{project}`, no JSON
columns) registered in REGISTRY. The server query path needs zero changes.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:2501 — `projectUsageRow`, the fold template (flat single-row UPSERT, entity pk from event.session_id); extractor template `extractUsageSnapshot` at :2416
- src/reducer.ts:6122-6157 — `applyEvent` switch where the BuildSnapshot/BuildDeleted arm goes; cursor advance shares the one BEGIN IMMEDIATE
- src/db.ts:4597-4638 — v61->v62 `armed_epics` ladder step, the exact new-table version-bump template; SCHEMA_VERSION at :48; CREATE_* consts near :591; unconditional bootstrap block :1342-1374
- src/db.ts:3460-3491 — rewind-and-redrain DELETE list (add builds)
- keeper/api.py:240 — SUPPORTED_SCHEMA_VERSIONS frozenset (add 64; comment style cites fn number + version)
- src/collections.ts:373 and :424 — GIT_DESCRIPTOR / USAGE_DESCRIPTOR shapes; REGISTRY at :832

**Optional** (reference as needed):
- src/daemon.ts:500-540 — `serializeUsageSnapshot`, the exported-serializer convention (place serializeBuildSnapshot per the same convention; task 2 consumes it)
- test/schema-version.test.ts — the pairing gate that enforces the api.py whitelist

### Risks

Payload-shape mistakes propagate: every field the worker will send must
round-trip serializer -> event.data -> extractor -> projection column, or
it silently folds NULL forever (fn-651 class). The tombstone delete must
key exactly the same `project` string the snapshot upsert used.

### Test notes

Fold tests in test/reducer-projections.test.ts using `freshMemDb()` and
the file-local `insertEvent(overrides)` helper: snapshot upsert (running
and completed shapes), tombstone delete, malformed-data no-throw with
cursor advance, and a re-fold determinism check (fold the same events
twice from empty -> byte-identical rows). Descriptor assertions in
test/collections.test.ts. `bun test` fast tier covers these;
test/schema-version.test.ts must pass (proves the api.py pairing).

## Acceptance

- [ ] `builds` table created at v64; SCHEMA_VERSION=64 in src/db.ts and 64 in keeper/api.py SUPPORTED_SCHEMA_VERSIONS (same commit); test/schema-version.test.ts green
- [ ] Exported serializer + extractor pin the BuildSnapshot payload; direct round-trip test passes
- [ ] BuildSnapshot folds to an UPSERT keyed by builder name; BuildDeleted deletes the row; malformed data no-ops with cursor advanced
- [ ] Re-fold from empty reproduces byte-identical builds rows (uses event.ts, no wall-clock)
- [ ] `getCollection("builds")` resolves with pk/version/sort/filters asserted in test/collections.test.ts
- [ ] `DELETE FROM builds` present in the rewind-and-redrain wipe list

## Done summary

## Evidence

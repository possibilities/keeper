## Description

**Size:** M
**Files:** src/db.ts, src/collections.ts, src/types.ts

### Approach

Schema foundation only — no reducer logic (that is task .3). Bump
`SCHEMA_VERSION` (32 to 33). Add a nullable `resolved_epic_deps TEXT` column to
`epics` (a JSON array; NULL = not-yet-computed, distinct from `'[]'` = computed
empty). Add an `epic_dep_edges` reverse-index table:
`CREATE TABLE epic_dep_edges (consumer_id TEXT NOT NULL, dep_token TEXT NOT
NULL, PRIMARY KEY (consumer_id, dep_token))` plus an index on `dep_token` (the
fan-out lookup key). Follow the v31 to v32 migration template
(addColumnIfMissing + CREATE_EPICS literal lockstep, version-guarded slot). Add
`resolved_epic_deps` to the epics descriptor `columns` AND `jsonColumns` in
collections.ts so `decodeRow` parses it on the wire. Add the field to the
`Epic` type in types.ts. Keep zero-event projection defaults in sync (a fresh
epics row has `resolved_epic_deps` NULL until first computed; `epic_dep_edges`
empty).

Do NOT write the ON CONFLICT carve-out or any backfill here — those live with
the reducer logic in task .3. This task makes the column + table + descriptor +
type exist and migrate cleanly.

### Investigation targets

**Required**:
- src/db.ts:57 (`SCHEMA_VERSION`), :541 (`default_visible` generated col), :2870-2898 (v31 to v32 template), `addColumnIfMissing`
- src/collections.ts:193-308 — epics descriptor `columns` + the `jsonColumns` set (~:308)
- src/types.ts — `Epic` shape

**Optional**:
- test/db.test.ts, test/collections.test.ts — migration + decode coverage patterns

### Risks

- Index choice on `epic_dep_edges` — the `dep_token` index is load-bearing for the task-.3 fan-out lookup; get the column order right.
- Keeping schema defaults in lockstep with the zero-event projection (re-fold from empty must reproduce the same NULL/empty state).

### Test notes

- db.test.ts: a migration test that v32 to v33 adds the column + table idempotently.
- collections.test.ts: `decodeRow` parses `resolved_epic_deps` as JSON.

## Acceptance

- [ ] `SCHEMA_VERSION` bumped; `resolved_epic_deps TEXT` (nullable) on `epics`; `epic_dep_edges(consumer_id, dep_token)` table + `dep_token` index created via the version-guarded slot AND the CREATE literal (lockstep).
- [ ] `resolved_epic_deps` is in the epics descriptor `columns` and `jsonColumns`; `Epic` type carries it.
- [ ] Migration is idempotent and forward-only; re-fold from an empty table reproduces the zero-event defaults.

## Done summary
Bumped SCHEMA_VERSION 33→34; added resolved_epic_deps TEXT (nullable) to epics + epic_dep_edges reverse-index table with dep_token index; wired into EPICS_DESCRIPTOR + jsonColumns; added Epic.resolved_epic_deps + ResolvedEpicDep type; migration + decode tests pass. Fixed makeEpic fixtures in 4 test files + reducer.test getEpic cast in follow-up commit.
## Evidence

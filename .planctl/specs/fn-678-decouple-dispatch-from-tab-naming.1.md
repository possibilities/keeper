## Description

**Size:** M
**Files:** src/db.ts, src/collections.ts, src/types.ts, keeper/api.py

### Approach

Lay the durable foundation everything else reads. Add a
`pending_dispatches(verb, id, dir, dispatched_at, last_event_id)` table,
PK `(verb, id)`, cloning the `CREATE_DISPATCH_FAILURES` DDL shape and its
docstring discipline. Bump `SCHEMA_VERSION` 49→50 and add a v49→v50
`migrate()` slot — a version-bump stamp only (the `CREATE TABLE IF NOT
EXISTS` runs unconditionally in the bootstrap block), mirroring the
v46→v47 `autopilot_state` whitelist-only template. Add
`pending_dispatches` to the rewind-and-redrain DELETE list so a
from-scratch re-fold rebuilds it. Register `PENDING_DISPATCHES_DESCRIPTOR`
in `collections.ts` (composite-pk workaround: descriptor `pk` is the
single column `verb`, `id` rides in `columns`/`filters`, mirroring
`DISPATCH_FAILURES_DESCRIPTOR`). Add the row/projection types to
`types.ts`. Add `50` to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in
THIS change — a missing bump fails every `commit-work` host-wide.

### Investigation targets

**Required** (read before coding):
- src/db.ts:1100 — `CREATE_DISPATCH_FAILURES` DDL + docstring (clone shape)
- src/db.ts:60 — `SCHEMA_VERSION` constant
- src/db.ts:4680 — v46→v47 `autopilot_state` migrate slot (whitelist-only template)
- src/db.ts:4400 — rewind-and-redrain projection DELETE list (`pending_dispatches` must join it)
- src/collections.ts:652 — `DISPATCH_FAILURES_DESCRIPTOR` + REGISTRY registration
- keeper/api.py:152 — `SUPPORTED_SCHEMA_VERSIONS` frozenset

**Optional** (reference as needed):
- test/schema-version.test.ts — the guard that fails if api.py lags `SCHEMA_VERSION`

### Risks

- Forgetting the rewind-and-redrain DELETE entry breaks from-scratch re-fold (silent — only a re-fold test catches it).
- Forgetting the `keeper/api.py` bump fails every `commit-work` on the host, not just a red test.

### Test notes

`test/schema-version.test.ts` passes; `test/collections.test.ts` gains a
`PENDING_DISPATCHES_DESCRIPTOR` wire-diff case mirroring the
`dispatch_failures` cases; a re-fold-from-empty reproduces an empty table.

## Acceptance

- [ ] `SCHEMA_VERSION === 50`; `pending_dispatches` table created with PK `(verb, id)`
- [ ] `pending_dispatches` is in the rewind-and-redrain DELETE list
- [ ] `PENDING_DISPATCHES_DESCRIPTOR` registered and subscribable
- [ ] `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS` includes 50; `test/schema-version.test.ts` passes

## Done summary
Added pending_dispatches projection table (schema v50): CREATE DDL keyed (verb, id), bumped SCHEMA_VERSION 49→50 with v49→v50 migrate slot, joined the rewind-and-redrain DELETE list, registered PENDING_DISPATCHES_DESCRIPTOR + PendingDispatch row type, and added 50 to keeper/api.py SUPPORTED_SCHEMA_VERSIONS.
## Evidence

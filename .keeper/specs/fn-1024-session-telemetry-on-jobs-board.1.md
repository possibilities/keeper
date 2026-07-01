## Description

**Size:** M
**Files:** src/db.ts, keeper/api.py, src/collections.ts, src/types.ts, test/db.test.ts, test/schema-version.test.ts

Add the six nullable telemetry columns to `jobs` behind a forward-only migration, whitelist
the new schema version in keeper-py, and plumb the columns through every projection shape so
they reach the wire/serve/board. This is the foundation the fold (`.3`) and render (`.5`)
build on; it carries no runtime behavior of its own.

### Approach

Bump `SCHEMA_VERSION` 99→100 (`src/db.ts:49`). Append a `// v99→v100` migration block at the
tail of `migrate()`, immediately before the `INSERT INTO meta ('schema_version')` stamp
(~`:5468`), copying the v98→v99 comment template verbatim: six `addColumnIfMissing` calls,
each nullable with NO default. Keep them OUT of the `CREATE_JOBS` literal (`:834` rule) so
fresh-vs-migrated `PRAGMA table_info(jobs)` stays byte-identical. Add `100` to
`SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` (`:392`) in this same task, plus a `# v100`
comment following the file's existing pattern. Append the six columns to
`JOBS_DESCRIPTOR.columns` (`src/collections.ts:79`) and to every `JobRow`/wire shape in
`src/types.ts` (~`:101`, `:133`, `:355`) — a column missing from any shape is silently
dropped before it reaches the board.

Columns: `current_model_id TEXT`, `current_model_display TEXT`, `current_effort TEXT`,
`context_used_percentage REAL`, `context_input_tokens INTEGER`, `context_window_size INTEGER`.

### Investigation targets

**Required** (read before coding):
- src/db.ts:49 — SCHEMA_VERSION
- src/db.ts:5384 — the v93→v94 `addColumnIfMissing` example block (comment template)
- src/db.ts:834 — the frozen CREATE_JOBS rule (why columns are migration-only)
- src/db.ts:1949 — addColumnIfMissing signature
- keeper/api.py:392 — SUPPORTED_SCHEMA_VERSIONS frozenset + :380 comment pattern
- src/collections.ts:79 — JOBS_DESCRIPTOR.columns
- src/types.ts — the JobRow/wire shapes (~:101, :133, :355)

**Optional** (reference as needed):
- test/db.test.ts:2448 — SCHEMA_VERSION pin + PRAGMA parity assertions
- test/schema-version.test.ts:59 — frozenset membership + contiguity

### Risks

A column placed in the `CREATE_JOBS` literal (instead of a migration step) breaks fresh-vs-migrated
PRAGMA parity. Any `DEFAULT` on a new column breaks re-fold byte-identity. Missing a column in one
of the three `types.ts` shapes silently drops it from the wire.

### Test notes

Bump the `test/db.test.ts` SCHEMA_VERSION pin to 100 and add PRAGMA parity + NULL-default assertions
for the six columns (handoff_links precedent ~:194). `test/schema-version.test.ts` passes once
`api.py` carries 100. `test/refold-equivalence.test.ts` stays green because the columns are
nullable/no-default (a pre-v100 event folds them to NULL byte-identically).

## Acceptance

- [ ] SCHEMA_VERSION is 100; the six nullable columns exist on both fresh and migrated `jobs` with byte-identical PRAGMA table_info
- [ ] `100` is in `SUPPORTED_SCHEMA_VERSIONS` with a `# v100` comment
- [ ] All six columns appear in `JOBS_DESCRIPTOR.columns` and every `types.ts` JobRow/wire shape
- [ ] `bun test test/db.test.ts test/schema-version.test.ts test/refold-equivalence.test.ts` green

## Done summary

## Evidence

## Description

**Size:** M
**Files:** src/db.ts, src/derivers.ts, src/daemon.ts, src/types.ts, keeper/api.py, plugins/keeper/plugin/hooks/events-writer.ts, test/schema-version.test.ts, tests

Add the `events.mutation_path` column and populate it going forward, with no destructive
change and no fold behavior change yet (dual-read stays on the blob). This is the online
additive phase.

### Approach

`addColumnIfMissing(db, 'events', 'mutation_path', 'TEXT')` (instant, no rebuild). Add a
hook-safe `extractMutationPath` deriver mirroring `extractBashMutation` (pure, gated on
hook_event=PostToolUse + tool_name in Write/Edit/MultiEdit/NotebookEdit, reads
`data.tool_input.file_path`, returns null on missing/malformed, NEVER throws — same
null-on-malformed semantics as ARM B's `CASE WHEN json_valid`). Wire the hook to derive
it forward (events-writer.ts:695-701 precedent), add it to INGEST_EVENTS_COLUMNS
(daemon.ts:521-555), and land it at the presentCols ingester seam (daemon.ts:764-792) —
including a NEW recompute-for-pre-deriver-lines step (the ingester, sole writer,
recomputes mutation_path when the NDJSON line lacks it). Build the new partial index
`events(mutation_path, ts, session_id, tool_name, hook_event) WHERE mutation_path IS NOT
NULL` alongside the existing expression index (keep both + dual-read until .3 flips).
Bump `SCHEMA_VERSION` to the next free integer (verify the live constant — it is 73 in
the working tree, so this is v74) and add that version to `SUPPORTED_SCHEMA_VERSIONS` in
keeper/api.py IN THE SAME COMMIT (test/schema-version.test.ts enforces membership).

### Investigation targets

**Required** (read before coding):
- src/derivers.ts:866 — extractBashMutation (mirror exactly: pure, hook-safe, null-on-malformed)
- src/db.ts:50 (SCHEMA_VERSION — verify live value), :1173 (addColumnIfMissing), :421 (idx_events_tool_attr to mirror as plain partial index), :520 (CREATE IF NOT EXISTS idempotency precedent)
- src/daemon.ts:521-555 (INGEST_EVENTS_COLUMNS — add column), :764-792 (presentCols seam — land + recompute)
- keeper/api.py:298-341 (SUPPORTED_SCHEMA_VERSIONS frozenset), :199-210 (schema-version comment block)
- plugins/keeper/plugin/hooks/events-writer.ts:695-701 (hook deriver wiring; hook stays dep-free/no-bun:sqlite/exit-0)

**Optional** (reference as needed):
- src/types.ts (Event type — add mutation_path field)
- test/schema-version.test.ts:39 (frozenset parse/enforce)

### Risks

- The ingester recompute-for-pre-deriver-lines is a NEW pattern (no precedent) — a binding mismatch silently drops mutation_path on replayed lines. Test the seam with a line that lacks the binding.
- SCHEMA_VERSION collision: read the live constant and take the next free integer; do not hardcode 74 blindly if the in-flight 73 hasn't landed.
- Hook import contract: `extractMutationPath` must not drag bun:sqlite or any disallowed dep into the hook bundle.

### Test notes

Forward-population test: a fresh Write/Edit event lands with mutation_path set; a
malformed payload lands with mutation_path NULL (no throw). schema-version test passes
with v74 added to api.py. Re-fold still byte-identical (dual-read unchanged) — run the .1 harness.

## Acceptance

- [ ] `events.mutation_path` column exists; new Write/Edit/MultiEdit/NotebookEdit events get it populated (hook-derived + ingester-recomputed for lines lacking it); malformed → NULL, never throws
- [ ] New partial index on mutation_path created; expression index + dual-read still in place (no fold behavior change this task)
- [ ] SCHEMA_VERSION bumped to the next free integer AND added to SUPPORTED_SCHEMA_VERSIONS in keeper/api.py in the same commit; test/schema-version.test.ts green
- [ ] .1 differential harness still byte-identical
- [ ] `bun run test:full` green

## Done summary

## Evidence

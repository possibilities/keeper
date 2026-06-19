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

### SCHEMA_VERSION (read carefully)

Bump `SCHEMA_VERSION` to the NEXT FREE INTEGER above the live constant. HEAD is currently
**72** (the in-flight v73 work — the planctl envelope flip — was STASHED and will be
rerun as a SEPARATE job), so the next free integer is **73**. ALWAYS read the live
`src/db.ts` `SCHEMA_VERSION` constant at implementation time and take next-free — never
hardcode, and NEVER skip an integer: a gap in the migration ladder means a later
`< N`-guarded migration block won't run on a DB already past N. Add the new version to
`SUPPORTED_SCHEMA_VERSIONS` in keeper/api.py IN THE SAME COMMIT (test/schema-version.test.ts
enforces membership). The stashed rerun job will take the next free integer AFTER this
epic's when it lands later — no collision as long as everyone reads-live + takes-next-free.

### Investigation targets

**Required** (read before coding):
- src/derivers.ts:866 — extractBashMutation (mirror exactly: pure, hook-safe, null-on-malformed)
- src/db.ts:50 (SCHEMA_VERSION — currently 72; verify at implementation time), :1173 (addColumnIfMissing), :421 (idx_events_tool_attr to mirror as plain partial index), :520 (CREATE IF NOT EXISTS idempotency precedent)
- src/daemon.ts:521-555 (INGEST_EVENTS_COLUMNS — add column), :764-792 (presentCols seam — land + recompute)
- keeper/api.py:292 (SUPPORTED_SCHEMA_VERSIONS frozenset), :199-210 (schema-version comment block)
- plugins/keeper/plugin/hooks/events-writer.ts:695-701 (hook deriver wiring; hook stays dep-free/no-bun:sqlite/exit-0)

**Optional** (reference as needed):
- src/types.ts (Event type — add mutation_path field)
- test/schema-version.test.ts (frozenset parse/enforce)

### Risks

- The ingester recompute-for-pre-deriver-lines is a NEW pattern (no precedent) — a binding mismatch silently drops mutation_path on replayed lines. Test the seam with a line that lacks the binding.
- SCHEMA_VERSION: read the live constant, take the next free integer (73 at HEAD 72), never hardcode, never skip. The stashed v73 rerun job takes the next slot after this epic's.
- Hook import contract: `extractMutationPath` must not drag bun:sqlite or any disallowed dep into the hook bundle.

### Test notes

Forward-population test: a fresh Write/Edit event lands with mutation_path set; a
malformed payload lands with mutation_path NULL (no throw). schema-version test passes
with the new version added to api.py. Re-fold still byte-identical (dual-read unchanged) —
run the .1 harness.

## Acceptance

- [ ] `events.mutation_path` column exists; new Write/Edit/MultiEdit/NotebookEdit events get it populated (hook-derived + ingester-recomputed for lines lacking it); malformed → NULL, never throws
- [ ] New partial index on mutation_path created; expression index + dual-read still in place (no fold behavior change this task)
- [ ] SCHEMA_VERSION bumped to the next free integer (73 at HEAD 72 — verify live, never skip) AND added to SUPPORTED_SCHEMA_VERSIONS in keeper/api.py in the same commit; test/schema-version.test.ts green
- [ ] .1 differential harness still byte-identical
- [ ] `bun run test:full` green

## Done summary
Added events.mutation_path column (v73, online additive ALTER) promoting the git-attribution fold's lone cross-event field; hook derives it forward and the ingester recomputes for pre-deriver lines. Dual-read on the blob unchanged (no fold/cursor change), re-fold byte-identical. Also skipped the static write-statement bundle on readonly opens so a reader meets a not-yet-migrated live DB without throwing.
## Evidence

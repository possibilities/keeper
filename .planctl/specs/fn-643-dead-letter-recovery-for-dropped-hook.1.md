## Description

**Size:** M
**Files:** src/db.ts, src/collections.ts, src/types.ts, a new src/dead-letter.ts (shared NDJSON record schema), test/collections.test.ts, test/dead-letter.test.ts

The static visibility substrate that the hook (.2), import (.3), replay (.4),
and board (.5) all build on: the schema migration + new operational table,
the shared NDJSON record schema/parse module, and the subscribe collection.
No behavior wiring here — just the table, the record contract, and the read
surface.

### Approach

- Bump `SCHEMA_VERSION` 35→36 in src/db.ts and add a `CREATE_DEAD_LETTERS`
  const + `db.run(CREATE_DEAD_LETTERS)` in `migrate()`'s CREATE block
  (`CREATE TABLE IF NOT EXISTS` is idempotent/unguarded, like
  `CREATE_PROFILES` / `CREATE_EPIC_DEP_EDGES`). Add the v35→v36 ALTER slot
  AFTER fn-642's v35 slot (see epic References — fn-642 owns v35). Stamp
  `meta(schema_version)` at the existing tail.
- Table shape (operational, NOT a reducer projection): `dl_id TEXT PRIMARY
  KEY` (hook-generated UUID), `session_id`, `hook_event`, `ts REAL`,
  `dl_written_at REAL`, `pid`, `bindings TEXT NOT NULL` (JSON of the full
  insert-binding set incl. derived columns + scraped spawn_name/start_time/
  config_dir), `status TEXT NOT NULL DEFAULT 'waiting'`
  (`waiting|recovered`), `recovered_at REAL`, `replayed_event_id INTEGER`,
  `source_file TEXT`. Index on `(status, dl_written_at)` for the
  oldest-waiting replay pick and the board count.
- New `src/dead-letter.ts`: the canonical `DeadLetterRecord` type + a pure
  `serializeDeadLetterRecord(record): string` (one NDJSON line) and
  `parseDeadLetterLine(line): DeadLetterRecord | null` (safe-parse, returns
  null on a partial/truncated/garbage line). NO third-party deps and NO
  bun:sqlite import — the hook (.2) imports this module, so its import graph
  must stay `bun:sqlite`+local-only. This module is the single source of
  truth for the record shape shared by hook-write and daemon-import.
- Register a `DEAD_LETTERS_DESCRIPTOR` in src/collections.ts `REGISTRY`
  (mirror `PROFILES_DESCRIPTOR` / `SUBAGENT_INVOCATIONS_DESCRIPTOR`),
  primary key `dl_id`, with `defaultFilter: { status: 'waiting' }` so the
  board's default count is the waiting backlog (recovered rows fall off).
- Add the `DeadLetter` row type to src/types.ts for the collection.

### Investigation targets

**Required:**
- src/db.ts:60 (`SCHEMA_VERSION`), the `migrate()` CREATE block (~1300) and the v35 ALTER tail — add the v36 slot after fn-642's; `CREATE_PROFILES`/`CREATE_EPIC_DEP_EDGES` are the table templates.
- src/collections.ts `REGISTRY` (~509) and `PROFILES_DESCRIPTOR` (~429) / `SUBAGENT_INVOCATIONS_DESCRIPTOR` (~477) — descriptor + `defaultFilter` shape.
- src/db.ts `resolveDbPath` (~68) — the `~/.local/state/keeper/` root the dead-letters dir siblings.

**Optional:**
- README.md collections enumeration + schema-version narrative (doc edits are task .6, but read for column-naming conventions).

### Risks

- SEQUENCING with fn-642 (v35, in-flight, uncommitted in the tree): the v36 slot must land after v35. If fn-642 hasn't committed when you start, coordinate — don't clobber its migration slot or its `SCHEMA_VERSION` line.
- `dead_letters` must stay OUT of every reducer / re-fold path. The from-scratch re-fold test (`DELETE FROM jobs/epics; rewind cursor; re-drain`) must NOT touch this table — it is daemon-maintained, never folded.

### Test notes

- test/dead-letter.test.ts: round-trip serialize→parse; `parseDeadLetterLine` returns null on a truncated/garbage line (crash-safety contract for import).
- test/collections.test.ts: the new descriptor reads `waiting` rows by default; recovered rows excluded.

## Acceptance

- [ ] `SCHEMA_VERSION` is 36; `CREATE_DEAD_LETTERS` runs idempotently in migrate(); a fresh boot creates the table.
- [ ] `src/dead-letter.ts` exports the record type + pure serialize/parse with NO bun:sqlite or third-party imports; parse returns null on a partial line.
- [ ] `dead_letters` is registered as a subscribable collection with `defaultFilter status='waiting'`.
- [ ] The table is documented as operational/never-folded and excluded from the re-fold reset path.

## Done summary

## Evidence

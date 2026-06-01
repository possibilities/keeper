## Description

Addresses F1 from the fn-669 audit. `KNOWN_EVENT_COLUMNS` (events-writer.ts:501), `insertBindings` (same file), and `CREATE_EVENTS` (src/db.ts:353) are three hand-maintained lists the doc comment at :495 calls out as requiring "TWO local edits" on each schema bump — but nothing enforces it. The HAPPY test (test/events-writer.test.ts:1744) uses a literal 31-column SELECT: it catches removal (SQL won't compile) but passes silently if a new `CREATE_EVENTS` column is added without updating `KNOWN_EVENT_COLUMNS`. Add a test that asserts set-equality between `KNOWN_EVENT_COLUMNS`, the `insertBindings` keys, and the live migrated-DB column list from `PRAGMA table_info('events')` (excluding `id`). Co-locate with the other fn-669 tests (~:1607).

## Acceptance

- [ ] New test reads `PRAGMA table_info('events')` on a migrated DB, collects the non-`id` column names, and asserts symmetric set-equality with `KNOWN_EVENT_COLUMNS`.
- [ ] Same test asserts `KNOWN_EVENT_COLUMNS` equals the key set of `insertBindings`.
- [ ] Full `test/events-writer.test.ts` suite green.

## Done summary
Added test in test/events-writer.test.ts asserting set-equality between KNOWN_EVENT_COLUMNS, the migrated DB's PRAGMA table_info('events') (minus id), and the bare-column key set parsed from the insertBindings literal. Exported KNOWN_EVENT_COLUMNS from events-writer.ts. Closes F1: a CREATE_EVENTS column added without a matching KNOWN_EVENT_COLUMNS entry now fails loud.
## Evidence

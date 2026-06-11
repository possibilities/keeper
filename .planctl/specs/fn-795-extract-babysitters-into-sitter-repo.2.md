## Description

**Size:** M
**Files:** test/fixtures/schema-v66.sql (new), test/helpers/fixture-db.ts (new), test/watch.test.ts, test/watchdog.test.ts, test/build-pin.test.ts

### Approach

Generate the schema contract fixture: run keeper's `migrate()` against
a throwaway DB (from the keeper repo), dump `sqlite3 <db> .schema` to
`test/fixtures/schema-v66.sql`, schema-only — no rows. Document the
regen one-liner (it goes in the README in task 4; note it in the
fixture header comment now). Write `test/helpers/fixture-db.ts`: create
a temp DB, execute the dump, insert the `meta` row
(`schema_version=66`) — the replacement for keeper's `freshDbFile`.

Port the three suites: `keeper-watch.test.ts` → `test/watch.test.ts`
(swap `freshDbFile` for the fixture helper, repoint the `openDb` import
to the vendored `openDbReadonly`); `keeper-watchdog.test.ts` →
`test/watchdog.test.ts` (near-verbatim — sandboxes only
BABYSITTER_STATE_DIR); `babysitter-build.test.ts` →
`test/build-pin.test.ts`, repurposed: the fn-756 re-export risk is gone
with the imports, so the pin now (a) dynamic-imports both entrypoints
to assert they link, (b) asserts the public surface (scan, tick,
liveDeps, liveTickDeps, main), and (c) asserts the zero-keeper-import
fence — no `../src/` or `code/keeper` import anywhere in the graph.

Keep the pure-detector tests byte-equivalent where possible — they are
the regression net for the move.

### Investigation targets

**Required** (read before coding):
- test/keeper-watch.test.ts:83,1548-1600 — the freshDbFile seeding sites + openDb import to replace
- test/helpers/template-db.ts — what freshDbFile provides (full migrate() ladder), i.e. what the fixture must reproduce
- test/babysitter-build.test.ts — the import-pin being repurposed
- test/keeper-watchdog.test.ts — cleanest port, the template for test style

**Optional** (reference as needed):
- test/schema-version.test.ts — keeper's cross-language whitelist pin, the model for fixture-membership assertions

### Risks

- The scan path reads ~10 tables; the current tests INSERT into only 5
  and rely on the full schema existing for the rest — the dump covers
  that, but any keeper trigger/view in the dump that references
  keeper-only functions would fail on execute; prune non-table DDL if so.
- Carried-over live state files (seen.json, backstop-baseline.json) must
  stay deserializable — don't bump state-file versions in the port.

### Test notes

`bun test` green in sitter. The fixture helper is itself the
consumer-side schema contract: when keeper bumps SCHEMA_VERSION, the
regen diff + whitelist update (task 3's constant) is the deliberate
review moment.

## Acceptance

- [ ] test/fixtures/schema-v66.sql checked in, schema-only, with regen command in its header
- [ ] fixture-db helper replaces freshDbFile; no keeper test-helper imports remain
- [ ] all three suites pass under `bun test` in ~/code/sitter
- [ ] build-pin asserts the zero-keeper-import fence

## Done summary

## Evidence

## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/types.ts, test/db.test.ts, test/reducer-projections.test.ts, test/helpers/sandbox-env.ts

### Approach

Append a forward migration physically removing `autopilot_state.codex_adoption`, update the fresh schema/fingerprint, and delete reducer/type handling. Preserve all surviving columns including `worker_provider = gpt`.

### Investigation targets

*Verify before relying — these refs move with the repo.*

**Required** (read before coding):
- `src/db.ts:3830` — introducing migration.
- `src/db.ts:5962` — fresh schema.
- `src/reducer.ts:5722` and `src/reducer.ts:5855` — mapping/fold.
- `test/db.test.ts:652` and `test/reducer-projections.test.ts:4815` — schema/fold tests.

**Optional** (reference as needed):
- `docs/adr/0020-schema-version-renumber-at-merge-time.md` — merge numbering.
- `f28f0bba` — preceding worker-provider migration.

### Risks

Table reconstruction can drop recent columns or values; compare fresh and upgraded schemas and values.

### Test notes

Migrate a DB containing adoption plus current provider/drift fields, prove parity with fresh schema, and prove old data advances safely without recreating the field.

### Detailed phases

1. Add the merge-numbered migration.
2. Preserve all surviving rows/columns while dropping adoption.
3. Remove fresh-schema/type/reducer references and re-pin fingerprint.
4. Replace adoption tests with migration parity/cursor coverage.

### Alternatives

An inert column and rewritten historical migration are both rejected.

### Non-functional targets

Migration is deterministic and preserves every surviving config value byte-for-byte.

### Rollout

Use the normal DB backup; never hardcode a provisional version in prose.

## Acceptance

- [ ] Fresh and upgraded DBs have no adoption column.
- [ ] Every surviving setting, including `worker_provider = gpt`, survives unchanged.
- [ ] Reducer/types contain no adoption field and old data advances safely.
- [ ] Fingerprint and migration tests pass.

## Done summary

## Evidence

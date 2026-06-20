## Description

**Size:** M
**Files:** src/db.ts, test/helpers/template-db.ts (new), test/template-db.test.ts (new), test/reducer.test.ts

### Approach

Export the currently-private `applyPragmas` (src/db.ts:1900) and `prepareStmts` (src/db.ts:6251) — verified safe: the hook imports nothing from db.ts, so new exports cannot violate the hook import-surface rule. Then write `test/helpers/template-db.ts` in the house helper style (long module doc comment stating what it replaces, citing this epic, naming the invariant — see sandbox-env.ts / in-process-daemon.ts for the voice). Contract: a lazily-memoized module-scope template built once per process — `openDb(":memory:")`, assert `meta.schema_version === SCHEMA_VERSION` (hard throw, the stale-template guard), `db.serialize()` to an immutable `Buffer`, close the source. Export `freshMemDb(): KeeperDb` — `Database.deserialize(TEMPLATE)` (options-object form only; positional boolean is `strict`, not `readonly` — leave the footgun comment) → `applyPragmas` (re-applies foreign_keys etc., which deserialize does NOT carry) → `prepareStmts` → return `{db, stmts}` exactly like openDb. Export `freshDbFile(path): KeeperDb` for multi-connection tests — `writeFileSync(path, TEMPLATE)` (a serialized `:memory:` image is a valid non-WAL DB file by construction, so no WAL-checkpoint dance and no `-wal` sidecar stranding) → `openDb(path, { migrate: false })`. Document hard: the serialize path is `:memory:`-ONLY (a WAL file image would SQLITE_CANTOPEN on deserialize). Finally swap reducer.test.ts's `beforeEach` from `openDb(":memory:").db` to `freshMemDb().db` — the exact change already validated by probe (470/470 pass, 28.9s → 6.5s).

### Investigation targets

**Required** (read before coding):
- src/db.ts:6316 — `openDb` body: the shape to replicate minus `migrate()` (new Database → applyPragmas → migrate → prepareStmts)
- src/db.ts:1874 — `KeeperDb` interface; the helper returns this exact shape so call sites are drop-in
- src/db.ts:1900 — `applyPragmas(db, busyTimeoutMs=5000, cacheSizeKb?)` to export
- src/db.ts:6251 — `prepareStmts(db)` to export; its static insertEvent names all events columns, so it throws on a sub-v63 template (let it propagate loudly)
- test/helpers/in-process-daemon.ts:1-35 — the module-doc house style to match
- test/reducer.test.ts:23-35 — the beforeEach to swap + the :memory: re-fold-determinism caveat comment (same-connection rewind still works on a deserialized clone)

**Optional** (reference as needed):
- src/db.ts:60 — `SCHEMA_VERSION = 63` for the version assert

### Risks

- `reducer_state.updated_at` in the template carries a frozen build-time wall-clock shared by all clones in a process — add a one-line helper comment so nobody asserts per-test freshness on it. No current reducer test does.
- Template Buffer must stay immutable — never hand it to anything that writes; each deserialize gets a private writable image.

### Test notes

Add a small `test/template-db.test.ts` self-test: a fresh clone has `PRAGMA foreign_keys` ON, `meta.schema_version` = SCHEMA_VERSION, accepts an INSERT into events, and `stmts.selectWorldRev` works; `freshDbFile` clone supports a second `openDb(path, {readonly:true})` connection seeing the same rows. This pins the pragma-re-apply contract so it can't silently regress.

## Acceptance

- [ ] `bun test test/reducer.test.ts` green and <8s solo (was 28.9s)
- [ ] `bun test test/template-db.test.ts` green (clone invariants pinned)
- [ ] Helper throws loudly when template schema_version mismatches SCHEMA_VERSION
- [ ] `bun run lint` and `bun run typecheck` pass with the new db.ts exports
- [ ] Full suite still green (`bun run test`)

## Done summary
Added test/helpers/template-db.ts (freshMemDb/freshDbFile) that migrates one :memory: DB per process and deserializes a private clone per test, with a stale-template schema_version guard; exported applyPragmas + prepareStmts from db.ts and swapped reducer.test.ts to freshMemDb (28.9s -> 1.9s solo). New self-test pins clone invariants; lint/typecheck/full suite green.
## Evidence

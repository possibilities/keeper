## Description

Finding F1 from the fn-729 audit: `tick` (`cli/keeper-watch.ts:1194`) calls
`scan` (`cli/keeper-watch.ts:583`) which calls `openDb(dbPath, { readonly: true,
prepareStmts: false })`. In read-only mode `openDb` (`src/db.ts:6024`) skips the
`existsSync` directory guard and calls `new Database(path, { readonly: true })`
directly — SQLite throws on a nonexistent file. Neither `scan`, `tick`, nor
`main`'s tick branch (`cli/keeper-watch.ts:1415-1426`) catches this, so a
first-boot run before keeperd has ever created `keeper.db` exits non-zero,
contradicting the comment at line 1417-1419 and the `tick` JSDoc.

Fix: wrap the `await scan(...)` call inside `tick` in a try/catch that logs to
stderr and returns the baseline result shape (or add an early
`if (!existsSync(dbPath)) return baseline` guard). Add a test asserting that
`scan` (or `tick`) against a nonexistent dbPath does not throw and returns
the expected zero-finding / baseline result.

## Acceptance

- [ ] `tick` called with a dbPath that does not exist returns gracefully (no throw, exit 0)
- [ ] A test in `test/keeper-watch.test.ts` covers the missing-DB path and asserts no throw

## Done summary
Added an existsSync first-boot guard at the top of tick so a --tick run before keeperd creates keeper.db returns the baseline shape and exits 0 instead of letting read-only openDb throw; added a tick test covering the missing-DB path (no throw, baseline result, no spawn).
## Evidence

## Description

**Size:** M
**Files:** test/reducer.test.ts, test/db.test.ts

### Approach

reducer.test.ts (CLEAN win): change the `beforeEach` `openDb(dbPath).db` (line ~31) to `openDb(":memory:").db`. All 449 tests share that single connection; the refold tests (~:337, ~:2229) rewind cursor + `DELETE FROM` + re-drain on the SAME connection, which is memory-safe. Verify there is no body-level second `openDb` that expects to see the beforeEach DB's rows (scout: only 1 openDb in body — confirm it's same-connection-safe; if it opens a second connection, that test stays on-disk).

db.test.ts (SELECTIVE, per-test): convert ONLY single-connection schema-shape tests to `:memory:`. KEEP on-disk: the WAL-assertion tests (:168/:179 assert `journal_mode === "wal"` — `:memory:` reports `memory`), the readonly-reader tests (:206/:210 — two connections to the same path), and the migrate test (:228). Two `:memory:` opens are two separate empty DBs, so any multi-connection test silently breaks. Build an explicit line-level allowlist of which tests flip vs stay.

### Investigation targets

**Required** (read before coding):
- test/reducer.test.ts:28-37 (beforeEach), :337, :2229 (refold/rewind tests)
- test/db.test.ts:46 (beforeEach), :168, :179 (WAL asserts — stay on-disk), :206, :210 (readonly reader — stay), :228 (migrate — stay)
- src/db.ts — `openDb(path, options)` accepts `":memory:"`; `applyPragmas` (~:1721) runs `journal_mode = WAL` unconditionally (no-op + reports `memory` on :memory:, harmless)

### Risks

- **Re-fold determinism is sacred (CLAUDE.md):** any test that reopens a real file to prove WAL-persisted refold MUST stay on-disk. Verify each refold test uses the same connection before flipping.
- **Silent multi-connection breakage:** a blanket swap makes readonly-reader tests pass against an empty second DB or fail opaquely — hence the explicit per-test allowlist.

### Test notes

`bun test test/reducer.test.ts` (target ~9.3s→~2s) and `bun test test/db.test.ts` (~6.0s→~1.5s) green. Re-run the refold determinism tests specifically and confirm they still assert byte-identical re-fold.

## Acceptance

- [ ] reducer.test.ts beforeEach uses `:memory:`; all 449 tests pass; refold tests still assert byte-identical re-fold
- [ ] db.test.ts: single-connection tests on `:memory:`, WAL-assertion + readonly-reader + migrate tests confirmed still on-disk; all pass
- [ ] Measured per-file wall time drop recorded for both files

## Done summary

## Evidence

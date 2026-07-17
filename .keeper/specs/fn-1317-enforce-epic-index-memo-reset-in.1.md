## Description

Finding F1 (audit of fn-1315). Evidence: `test/reducer-lifecycle.test.ts` has four
`DELETE FROM epics` wipe-then-refold sites — line 2730 already resets the epic-index
memo (line 2733), but lines 454, 5072, and 5425 do not, despite matching the identical
`DELETE FROM epics` + `UPDATE reducer_state SET last_event_id = 0` + `drainAll()`
pattern the epic enforces on the reused `freshMemDb`-per-test connection. The file
already imports `__resetEpicIndexMemoForTest` (line 20).

Files:
- `test/reducer-lifecycle.test.ts` — add `__resetEpicIndexMemoForTest(db)` after the
  `DELETE FROM epics` and before the re-fold `drainAll()` at the three sites (454,
  5072, 5425). Verify each re-fold exercises the epic index before choosing to add the
  call; if a site provably cannot seed the memo, document the exemption inline instead.

## Acceptance

- [ ] Sites 454, 5072, and 5425 reset the epic-index memo between the epics wipe and the re-fold drain (or carry an inline exemption note if provably unreachable).
- [ ] `test/reducer-lifecycle.test.ts` passes under its named test gate.

## Done summary

## Evidence

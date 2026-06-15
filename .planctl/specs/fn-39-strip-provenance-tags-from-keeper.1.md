## Description

Cleanup of backward-facing provenance tags in the keeper SILENT_STREAM_CUT
detector, bundling F1 and F2 (F2 merged into F1) because they share the same
root cause — tombstone comments — and overlap the same two keeper files, so
they land as one commit.

- F1 (kept): keeper `src/reducer.ts:3801` (JSDoc header) and `:3993` (inline
  comment) both lead with the `(fn-38.2)` task-id tag. Drop the `(fn-38.2)`
  tag; keep the surrounding WHY-prose (cut semantics, the `state='working'`
  guard-doubling argument, the negative-control note) intact.
- F2 (merged-into-F1): keeper `test/silent-stream-cut.test.ts:2` docstring
  leads with `fn-38.2 —`; `:13-14` carry `mirrors ea343ed2` / `cfcbc8ec`; the
  test names at `:134` (`ea343ed2 shape`) and `:159` (`cfcbc8ec negative
  control`) embed commit hashes. Trim the task-id and commit-hash tombstones;
  keep the behavioral description (cut vs clean shape, stop_reason semantics).

Apply keeper's own WHY-only comment discipline. No code logic changes.

## Acceptance

- [ ] `grep -rn "fn-38" src/reducer.ts test/silent-stream-cut.test.ts` returns no comment/docstring hits.
- [ ] `grep -rn "ea343ed2\|cfcbc8ec" test/silent-stream-cut.test.ts` returns nothing.
- [ ] The WHY-prose and behavioral test descriptions are preserved (only the tags removed).
- [ ] keeper test suite stays green.

## Done summary

## Evidence

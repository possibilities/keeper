## Description

Traces to audit finding F1 (evidence: `src/reducer.ts:9570-9578` declares the
MUST-reset invariant; the memo doc at 9549-9551 restates it). Eight test files
`DELETE FROM epics` and re-fold on the reused module-level `db`, but only
`test/refold-equivalence.test.ts` and `test/reducer-lifecycle.test.ts` call
`__resetEpicIndexMemoForTest`. The six gaps —
`test/reducer-projections.test.ts` (e.g. the wipe-then-`drainAll` at
5906-5924), `test/db.test.ts`, `test/reducer-plan.test.ts`,
`test/compaction.test.ts`, `test/daemon.test.ts`, `test/reducer-links.test.ts`
— wipe on a memo-seeded connection without resetting. Fix by calling
`__resetEpicIndexMemoForTest(db)` at each such wipe site, or by factoring the
wipe through a shared helper that resets the memo (mirror
`refold-equivalence`'s `rewindAndWipeProjections`). Files: the six test files
above; optionally a shared test helper for the wipe path.

## Acceptance

- [ ] All six identified test files reset the epic-index memo at every `epics`-wipe-and-refold site (inline or via a shared helper).
- [ ] The named gates covering the touched files remain green.

## Done summary

## Evidence

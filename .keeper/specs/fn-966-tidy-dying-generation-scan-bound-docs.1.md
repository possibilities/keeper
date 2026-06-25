## Description

Three audit survivors from fn-963, all on the DYING_GENERATION_SCAN_LIMIT
bound and its test, bundled because they share the same files
(src/restore-set.ts, test/restore-set.test.ts) and theme (the 256-row
dying-generation scan bound) and land as one commit.

- F1 (src/restore-set.ts:172-176): the LIMIT doc-comment claims the bound is
  "sized far above any plausible count … so a deep dying generation is never
  truncated below its correct snapshot." That overstates an unproven,
  unmonitored invariant. The real failure when the dying generation falls
  outside the 256-row window is selectDyingGenerationSnapshot returning null,
  which the caller (restore-set.ts:613-621) routes to a fallbackNote-labeled
  approximate restore. Reword the comment to state the bound is a heuristic
  whose breach demotes to the labeled fallback. (The audit's alternate "emit
  a warning/counter" remedy was culled — deferred, no current user impact.)
- F2 (test/restore-set.test.ts:1013): the comment lead-in "// F5 regression
  pin:" is a past-tense fn-id provenance tag banned by CLAUDE.md rule #0.
  Drop or rephrase forward-facing (e.g. "Recycle-guard pin:"); keep the rest
  of the comment block (the (generation_id, pane_id) join explanation and the
  lower-rowid wrong-gen seed rationale) intact.
- F3: no test pins the LIMIT-truncation boundary. Add a case seeding
  DYING_GENERATION_SCAN_LIMIT + 1 G_now snapshots ahead of the dying
  generation and assert the labeled fallbackNote fires (rather than a
  wrong/empty candidate set), locking in the degraded-but-visible behavior of
  the new bound. Extract to a *.slow sibling if seeding 257 rows is heavy.

## Acceptance

- [ ] src/restore-set.ts LIMIT comment frames the bound as a heuristic whose breach demotes to the labeled fallback; no "never truncated" claim remains.
- [ ] test/restore-set.test.ts recycle-guard comment carries no fn-id shorthand and the useful join/seed explanation is preserved.
- [ ] A test seeds DYING_GENERATION_SCAN_LIMIT + 1 G_now snapshots and asserts the fallbackNote fires; placed in a *.slow sibling if the seed is heavy.

## Done summary
Reframed the DYING_GENERATION_SCAN_LIMIT comment as a heuristic that demotes to the labeled fallback (no 'never truncated' claim), scrubbed the fn-id provenance tag from the recycle-guard test comment, and added a boundary test pinning that LIMIT+1 G_now snapshots ahead of the dying generation fire the fallbackNote.
## Evidence

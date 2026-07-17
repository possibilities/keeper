## Overview

The source epic added `__resetEpicIndexMemoForTest(db)` at all epics-wipe-then-refold
sites across six test files but left a seventh — `test/reducer-lifecycle.test.ts` —
with three uncovered sibling sites, so the "enforce epic-index memo reset at test"
invariant is not met repo-wide. This follow-up closes those three so a stale pre-wipe
epic-index memo cannot silently serve a post-wipe re-fold (a future edit that adds
epic events to one of these blocks would otherwise pass for the wrong reason).

## Acceptance

- [ ] Every `DELETE FROM epics` wipe-then-refold site in `reducer-lifecycle.test.ts` resets the epic-index memo, matching the enforced convention.
- [ ] The lifecycle test suite stays green.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | reducer-lifecycle.test.ts:454,5072,5425 wipe epics + rewind + re-drain with no memo reset, while sibling site 2730/2733 in the same file has one and the file imports the reset (line 20); the enforced invariant is applied inconsistently and the source done_summary overclaims repo-wide completeness. |

## Out of scope

- The six test files already covered by the source epic (verified 29/29 by the audit).
- Any production code path — this is a test-harness correctness invariant only.

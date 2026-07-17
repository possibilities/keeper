## Overview

The epic-index memo (`src/reducer.ts`) mirrors the MUTABLE `epics` table and
documents a MUST invariant: `__resetEpicIndexMemoForTest(db)` has to run
WHEREVER a test wipes the `epics` projection on a reused connection, or a
stale pre-wipe memo serves the post-wipe re-fold. Six of the eight test files
that `DELETE FROM epics` and re-fold on the module-level connection skip that
reset; they pass today only because a full same-log re-fold self-heals every
entry via patch-in-place. This is test-hygiene work: close the documented
invariant gap so a future partial or divergent re-fold assertion cannot
silently read stale memo state and produce a false pass/fail.

## Acceptance

- [ ] Every test site that wipes `epics` on a reused connection resets the epic-index memo (directly or through a shared wipe helper).
- [ ] The named test gates covering these files stay green.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept   | .1 | reducer.ts:9570-9578 MUST-reset invariant honored at only 2 of 8 DELETE-FROM-epics test files; 6 gaps risk a silent stale-memo trap on a future partial re-fold. |
| F2 | culled | —  | fn-id in code comments violates rule #0 but mirrors a pervasive tree convention (28 src files); cosmetic comment edit, no user impact, would not make the tree compliant. |

## Out of scope

- Stripping fn-id provenance from production code comments (F2 — culled: pervasive existing convention, cosmetic only).
- Any change to production memo behavior; production is cold-by-construction and unaffected.

## Overview

The COALESCE-fold comment block at `src/reducer.ts:7239-7242` still describes
`backend_exec_tab_{id,name}` columns and a T4 tab-resolver worker, both of
which were deleted by fn-710. The comment now points to a non-existent
subsystem and will mislead the next reader of the reducer.

## Acceptance

- [ ] Lines 7239-7242 of `src/reducer.ts` no longer reference deleted columns or the T4 worker
- [ ] The surrounding comment block accurately describes the live three-coordinate reality

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | Confirmed at reducer.ts:7239-7242 — comment describes backend_exec_tab_{id,name} and T4 tab-resolver worker, both deleted; would mislead next reader |

## Out of scope

- Any logic changes to the COALESCE fold itself
- Reformatting or rewriting other comment blocks in the reducer

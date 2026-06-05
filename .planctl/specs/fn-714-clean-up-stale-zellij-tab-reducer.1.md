## Description

Finding F1 from the fn-710 audit: the COALESCE-fold comment block at
`src/reducer.ts:7239-7242` still reads:

> The UPDATE leaves `backend_exec_tab_{id,name}` untouched — those columns
> are stamped only by the T4 tab-resolver worker's synthetic event (a separate
> fold arm). The tombstone semantics for the tab pair (last-known sticks) live
> there, not here.

Both `backend_exec_tab_{id,name}` columns and the T4 tab-resolver worker were
deleted by fn-710. The phrase "live there, not here" now points nowhere.
The rest of the block (lines 7244-7253) is accurate and should be left intact.

## Acceptance

- [ ] Lines 7239-7242 removed or replaced with accurate prose (or the block ends at 7238)
- [ ] No logic change — comment-only edit
- [ ] `tsc --noEmit` still clean after the edit

## Done summary

## Evidence

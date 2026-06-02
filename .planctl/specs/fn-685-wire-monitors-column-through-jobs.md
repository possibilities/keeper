## Overview

The `monitors` column is projected by the reducer and rendered by `cli/jobs.ts`, but was never added to `JOBS_DESCRIPTOR.columns` — the explicit wire SELECT list. As a result, `keeper jobs` never receives the field and the Monitors section never renders in any live invocation. This epic adds the one-line descriptor entry and a companion guard test that matches the established pattern for other display-only columns.

## Acceptance

- [ ] `JOBS_DESCRIPTOR.columns` contains `"monitors"`
- [ ] `keeper jobs` expanded rows render the Monitors section for live jobs
- [ ] A test asserts `JOBS_DESCRIPTOR.columns.includes('monitors')` and that it is not in `sortable`, `filters`, or `jsonColumns`

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| monitors-missing-from-descriptor | kept | .1 | Confirmed: collections.ts:90-144 ends at backend_exec_tab_name; grep for monitors returns nothing; every render test bypasses the wire entirely |
| no-descriptor-wire-render-test | kept | .1 | Pattern already exists for profile_name (collections.test.ts:203); two-line extension guards the same class of future silent-strand bugs |

## Out of scope

- Any doc/comment drift on "insert mode" framing (tier_0 — auditor Consider; no behavioral incorrectness)
- Typo fix in derivers.ts comment (tier_0 — auditor Consider)

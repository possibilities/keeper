## Description

**Size:** M
**Files:** src/exec-backend.ts, test/exec-backend.test.ts

### Approach

Slim the `ExecBackend` contract to be name-free. Add
`closeByTabId(session, tabId)` to the interface and `createZellijBackend`
impl, wrapping the existing pure `buildZellijCloseTabArgs` (which already
routes through `close-tab-by-id`) — handle the tab_id coercion seam (the
`jobs.backend_exec_tab_id` column is TEXT/string; the list-panes JSON
`tab_id` is a number). Delete `liveTabNames`, `tabExistsByName`, and
`closeByName` from the interface and their impls (`liveTabNamesImpl`, the
`closeByName` impl, the shared `list-panes` parse for `tabExistsByName`).
Delete `findPaneByTabName` and its tests. Keep `launch`, `focusPane`,
`resolveTabForPane`. NOTE: this restructures the same `createZellijBackend`
region that in-progress fn-677.2 edits — the epic depends on fn-677 to
serialize; rebase onto its landed shape before deleting.

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts:187 — `ExecBackend` interface (delete liveTabNames/tabExistsByName/closeByName; add closeByTabId)
- src/exec-backend.ts:416 — `buildZellijCloseTabArgs` (wrap, don't reinvent)
- src/exec-backend.ts:555 — `findPaneByTabName` (delete)
- src/exec-backend.ts:1006 — `liveTabNamesImpl`; ~:1108 `closeByName` impl

**Optional** (reference as needed):
- test/exec-backend.test.ts:136 — `buildZellijCloseTabArgs` arg-builder test (template for `closeByTabId`)

### Risks

- Merge conflict with in-progress fn-677.2 on `createZellijBackend` — serialize via the epic dep.
- tab_id string/number coercion mismatch closes the wrong/no pane.
- A deleted primitive still referenced elsewhere — grep before delete.

### Test notes

`closeByTabId` arg-builder test mirroring the `buildZellijCloseTabArgs`
case; `rg` confirms no remaining references to the deleted methods across
`src/`.

## Acceptance

- [ ] `closeByTabId(session, tabId)` added, wrapping `buildZellijCloseTabArgs`, with the tab_id coercion handled and tested
- [ ] `liveTabNames`, `tabExistsByName`, `closeByName`, `findPaneByTabName` deleted with no dangling references
- [ ] `ExecBackend` exposes only `launch`, `closeByTabId`, `focusPane`, `resolveTabForPane`
- [ ] exec-backend tests pass

## Done summary

## Evidence

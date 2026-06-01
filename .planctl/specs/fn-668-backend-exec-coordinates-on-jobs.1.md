## Description

**Size:** M
**Files:** src/exec-backend.ts, test/exec-backend.test.ts

### Approach

Add two pure, dependency-injected additions to `src/exec-backend.ts`, reusing the existing list-panes plumbing. (1) `execBackendEnvMeta(backendType?)` returns `{ backendType, sessionIdEnvVar, paneIdEnvVar }`, defaulting `backendType` to `DEFAULT_EXEC_BACKEND` and, for `"zellij"`, the env-var names `ZELLIJ_SESSION_NAME` / `ZELLIJ_PANE_ID`. This becomes the single home for a backend's env-var names so the hook (T3) stays backend-agnostic. (2) `resolveTabForPane(session, paneId)` runs `buildZellijListPanesAllJsonArgs(session)` via the injectable spawn, parses with `parseListPanesJson`, and uses a new `findPaneById` (model it on `findPaneByTabName`'s none/single/multiple envelope) to find the `is_plugin=false` terminal pane whose `id` matches `paneId` under normalized equality (list-panes emits numeric `id` `11`; the stored/env value is string `"11"`). Returns `{ tab_id, tab_name, tab_position } | null`. No rename builders, no DB access.

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts:162 — DEFAULT_EXEC_BACKEND (reuse, don't re-literal "zellij")
- src/exec-backend.ts:336 — buildZellijListPanesAllJsonArgs(session)
- src/exec-backend.ts:348 — ZellijPane interface (add tab_id/tab_position if absent)
- src/exec-backend.ts:372-440 — FindPaneResult + findPaneByTabName (the none/single/multiple model + number→string id coercion to mirror in findPaneById)
- src/exec-backend.ts:453,540-573 — parseListPanesJson, runCapture (concurrent drain, ENOENT→null)
- test/exec-backend.test.ts:53-79 — makeSpawnStub fake SpawnFn (key by cmd[0]:cmd[1])

### Risks

- Pane-id type coercion: numeric `id` vs string env value — normalized comparison or the join silently never matches and tab stays perpetually NULL.
- `findPaneById` multiple-match arm (split panes share a tab): return the none/single/multiple envelope like the tab-name finder; caller decides.

### Test notes

Unit-test `execBackendEnvMeta()` (default + explicit type) and `findPaneById` (none/single/multiple, numeric-vs-string id) with `makeSpawnStub` canned `list-panes` JSON. No live zellij.

## Acceptance

- [ ] `execBackendEnvMeta()` returns the zellij env-var names by default and is the only place those literals live.
- [ ] `resolveTabForPane(session, paneId)` returns the matching pane's `{tab_id, tab_name, tab_position}` or null, matching numeric `id` against a string pane id.
- [ ] `findPaneById` returns a none/single/multiple envelope; ENOENT / parse-failure / non-zero-exit resolve to null, not throw.
- [ ] Tests pass via injected spawn stub; no rename/mutation code added.

## Done summary
Added execBackendEnvMeta() (single source of truth for ZELLIJ_SESSION_NAME / ZELLIJ_PANE_ID env-var names) and resolveTabForPane(session, paneId, deps) (spawns list-panes -a -j once, returns {tab_id, tab_name, tab_position} | null, never throws). findPaneById mirrors findPaneByTabName's none/single/multiple envelope and normalizes numeric list-panes id against string env value via String(). 16 new tests, all 50 in test/exec-backend.test.ts pass.
## Evidence

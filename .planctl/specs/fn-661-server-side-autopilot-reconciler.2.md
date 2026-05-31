## Description

**Size:** S
**Files:** src/exec-backend.ts, test/exec-backend.test.ts

### Approach

Shrink the `ExecBackend` API to the two operations the reconciler needs and make
zellij stateless from autopilot's side. Collapse `launch` to
`(argv, name, cwd) -> { ok, error? }` — drop the pane-id capture and return
(`list-panes`/`newestTerminalPaneId` after new-tab go away). Add
`closeByName(name)`: run `zellij action list-panes -a -j`, parse the JSON, filter
to the pane whose `tab_name === name` (exact, no substring), and `close-pane -p`
it — closing the pane terminates the agent process and removes the tab in one
shot. Retire `isSurfaceLive`, `buildZellijQueryTabNamesArgs` text-parsing,
`newestTerminalPaneId`, and all `surfaceRef`/`windowId` capture. Keep
`buildZellijNewTabArgs` (`:240`) and `ensureSession`.

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts:106-158 — ExecBackend interface (the shape to shrink); isSurfaceLive at ~:148/:158 to retire
- src/exec-backend.ts:240 — buildZellijNewTabArgs (keep; launch uses it)
- src/exec-backend.ts:319 — buildZellijQueryTabNamesArgs (retire), :382 list-panes args, :395 newestTerminalPaneId (retire)

**Optional** (reference as needed):
- `zellij action list-panes -a -j` field shape: each pane carries `id`, `tab_id`, `tab_name`, `terminal_command`, `exited` — filter on `tab_name` for closeByName

### Risks

- closeByName must match `tab_name` exactly; dedup guarantees one live tab per `verb::id` name so there's a single match, but guard against zero/multiple.
- Confirm that closing the pane (close-pane -p) actually terminates the running claude (SIGHUP on pane close).
- Scattered consumers of the retired helpers (`surfaceRef`, `isSurfaceLive`, `windowId`) live in cli/autopilot.ts — they are removed in the viewer-rewrite task, not here; this task only reshapes exec-backend.ts and its tests.

### Test notes

- Pure arg-builders and the list-panes JSON parse tested directly (bun:test), no real zellij spawn.
- closeByName resolves the correct pane id from a list-panes JSON fixture and emits the right close-pane argv.

## Acceptance

- [ ] `launch(argv, name, cwd)` returns `{ ok, error? }` and no longer captures/returns a pane id
- [ ] `closeByName(name)` resolves the tab by exact `tab_name` via `list-panes -a -j` and closes its pane
- [ ] isSurfaceLive, query-tab-names text-parsing, newestTerminalPaneId, surfaceRef/windowId removed from exec-backend.ts
- [ ] exec-backend.test.ts updated and green

## Done summary

## Evidence

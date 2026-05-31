## Description

**Size:** M
**Files:** src/exec-backend.ts, cli/autopilot.ts, test/exec-backend.test.ts, test/autopilot.test.ts

### Approach

Switch autopilot's auto-close from whole-tab to surgical pane-level, and
make it wrap-safe across zellij-server restarts. Three moves:

1. **Return the pane id from `launch`.** The zellij `launch()` already
resolves the newest `terminal_<n>` via `newestTerminalPaneId` +
`buildZellijListPanesArgs` — but only inside the `opts?.paneName` block,
then discards it (returns the tab id). Un-gate pane resolution so it always
runs, and return the pane id instead of `res.stdout.trim()` (the tab id).
On parse failure (`newestTerminalPaneId` returns null) return `null` — NOT
the tab id — matching the existing `ENOENT→null→"won't auto-close"`
contract; a tab id fed to `close-pane -p` cannot act and would leave an
un-closeable parked pane.

2. **Close by pane.** Add a pure `buildZellijClosePaneArgs(session, paneId)
=> [zellij, --session, session, action, close-pane, -p, paneId]`. Rewire
the zellij `close()` to use it instead of `buildZellijCloseTabArgs`. The
orphan-default-tab reap KEEPS `buildZellijCloseTabArgs` (it deliberately
closes a known-empty default tab) — so both builders coexist; document the
split. `close-pane -p` is surgical by construction (zellij auto-closes a
tab only when it has zero selectable tiled panes), so NO pre-close
`list-panes` guard is needed for the shared-tab-survives case.

3. **Generation-token wrap guard.** Pane ids reset when the
`zellij --server` restarts; `dispatch.log` survives restarts and rehydrates
`windowId`s, so a recycled `terminal_N` could reap a DIFFERENT live pane.
Stamp a server-generation token into the `kind:"window"` dispatch.log row
at launch, and at close only fire `close-pane -p` when the token matches
the live server. A mismatched token (server restarted) OR a missing token
(pre-upgrade row, old tab-id-shaped windowId) is skipped — never reaped.
Missing-token = don't-reap = safe direction (leaves the pane open).
**Pin the token mechanism during investigation** (do not guess): prefer the
server `(pid, start_time)` two-field identity (CLAUDE.md's recycle-proof
precedent — find the `zellij --server` pid); fall back to a zellij-native
session-birth timestamp if 0.44.3 exposes one machine-stably; or, if
neither reads cleanly headless, the no-token variant — at close, verify
`terminal_N` still belongs to a tab named `verb::id` via the existing
`query-tab-names`/`isSurfaceLive` machinery (robust to ALL staleness, one
extra query per close). Whichever is chosen, the acceptance below holds.

Keep the `windowId` field name and `kind:"window"` log kind (hydration is
string-format-agnostic; renaming buys nothing and breaks back-compat).
Update the `DispatchEntry.windowId` docstring + the `ExecBackend.close`
"config flip hands a foreign-format id" rationale (false once there's one
backend) to the new stale-id reasoning.

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts:696-749 — zellij `launch()`; pane id resolved at :722-724 gated behind `opts?.paneName` :721; returns tab id `res.stdout.trim()` :714
- src/exec-backend.ts:422 — `newestTerminalPaneId` (+ docstring :413-421: relies on serialized launches — the settling slot guarantees it)
- src/exec-backend.ts:294-306 — `buildZellijCloseTabArgs` (model for the new close-pane builder; KEEP for orphan reap)
- src/exec-backend.ts:750-776 — zellij `close()` (rewire to close-pane)
- cli/autopilot.ts:2447-2491 — `launchWindow` launch + windowId stamp + `kind:"window"` persist (:2471)
- cli/autopilot.ts:420 — `DispatchEntry.windowId` field + docstring
- cli/autopilot.ts:1504-1653 — `hydrateDispatchLog` (windowRows fold — where the token must round-trip)
- cli/autopilot.ts:2718-2754 — `closeWindow` dep → `backend.close(windowId)`, gated by autoclose + dryRun (token check lands here or in close())
- cli/autopilot.ts:2419 — `isSurfaceLive(key)` (8ef4371) — reuse its query machinery if the no-token variant is chosen; do not weaken it
- test harnesses: `makeSpawnStub` (test/exec-backend.test.ts:52), `writeDispatchLog` + recording-`closeWindow` `DetectJobTransitionsDeps` injection (test/autopilot.test.ts)

**Optional** (reference as needed):
- zellij 0.44.3 `close-pane --help` and `list-panes` / `list-sessions` output shapes (verify the token read is machine-stable headless)

### Risks

- **Wrong-pane reap** is the whole hazard the token guard exists to prevent — get the token round-trip (launch stamp → log → hydrate → close check) right, and make the missing/mismatch case fail CLOSED (skip the close).
- Un-gating pane resolution must not change behavior for callers that omit `paneName`; define the return contract for the parse-fail case (return null).
- `newestTerminalPaneId` correctness now drives auto-close, not just cosmetic rename — confirm the single settling slot is a hard invariant and the un-gate adds no second interleaving `list-panes` call.
- Pre-upgrade `dispatch.log` rows carry tab-id-shaped `windowId`s with no token → must be skipped by the missing-token rule, not fed to `close-pane -p`.

### Test notes

Pure-builder test for `buildZellijClosePaneArgs` argv. Behavior test via
`makeSpawnStub`: `launch` returns the `terminal_<n>` pane id (not the tab
id); `launch` returns null when no terminal pane parses. Token-guard tests:
a window row whose token matches → close fires; mismatched token → skipped;
missing token (pre-upgrade row) → skipped. Assert the orphan-reap path still
uses close-tab. Confirm `isSurfaceLive` + autoclose_windows tests stay green.

## Acceptance

- [ ] `launch` returns the pane id (`terminal_<n>`); returns `null` on pane-parse failure (never the tab id)
- [ ] new `buildZellijClosePaneArgs` pure builder; zellij `close()` runs `close-pane -p <paneId>`; orphan-default-tab reap still uses `close-tab-by-id`
- [ ] a tab the human added a second tiled pane to SURVIVES an autopilot pane close (surgical); the agent's own pane is reaped
- [ ] a server-generation token is stamped at launch, persisted in the `kind:"window"` row, and round-tripped through `hydrateDispatchLog`
- [ ] auto-close fires `close-pane -p` ONLY when the token matches the live server; mismatched OR missing-token rows are skipped (never reaped) — covered by tests
- [ ] token mechanism chosen + justified in the Done summary (server pid/start_time, session-birth, or no-token name-check)
- [ ] `windowId`/`kind:"window"` names retained; stale docstrings updated; `isSurfaceLive` (8ef4371) + `autoclose_windows` (c231506) not regressed
- [ ] `bunx tsc --noEmit` + `bun test test/exec-backend.test.ts test/autopilot.test.ts test/config.test.ts` green

## Done summary
Switched zellij ExecBackend auto-close from whole-tab close-tab-by-id to surgical close-pane -p; launch() returns the pane id (terminal_<n>) instead of the tab id, un-gated from opts.paneName. Wrap-safety: a tabName token (the launch-time verb::id) rides in the dispatch.log kind:"window" row and round-trips through hydrateDispatchLog; the backend's close(windowId, tabName) probes query-tab-names for the name and skips close-pane when the tab is no longer live (server restart wrap-safety). Pre-upgrade rows (bare-numeric tab-id windowId OR missing tabName) skip on shape — fail-safe direction. Token mechanism: no-token name-check variant (the verb::id tab name IS the token), reusing the existing isSurfaceLive/tabNameListed/query-tab-names machinery via a shared internal probe — chosen over server pid/start_time and socket-birth-time because it's platform-portable, reuses well-tested code, and is robust against ALL forms of staleness, not just server-restart wrap. Orphan-default-tab reap KEEPS close-tab-by-id (deliberately closes a known-empty Tab #1). 110/110 unit tests + 1637/1638 full-suite tests green; bunx tsc --noEmit clean.
## Evidence

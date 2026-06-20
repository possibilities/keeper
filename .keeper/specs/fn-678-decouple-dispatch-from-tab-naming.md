## Overview

Today the autopilot reads zellij tab names back at runtime
(`ExecBackend.liveTabNames` / `tabExistsByName` → `snapshot.liveTabKeys`,
fn-674) to suppress double-dispatch during the launch→SessionStart blind
window, and reaps surfaces via `closeByName(verb::id)`. That couples
dispatch correctness to the tab's display string. This epic makes the tab
name a purely cosmetic, freely-mutable label (so it can carry dynamic
status indicators) by moving the launch-window occupancy fact into a
durable event-sourced `pending_dispatches` projection keyed `(verb, id)`,
and switching the reap path to close-by-tab-id using the existing
`jobs.backend_exec_{session_id,tab_id}` metadata (fn-668). End state: no
control path reads the tab name; the `ExecBackend` contract is name-free.

## Quick commands

- `bun test test/reducer.test.ts test/autopilot-worker.test.ts test/exec-backend.test.ts test/collections.test.ts test/schema-version.test.ts`
- `rg -n 'liveTabNames|tabExistsByName|liveTabKeys|closeByName|findPaneByTabName' src/` — expect zero control-path hits after the epic lands

## Acceptance

- [ ] No control path reads a zellij tab name; `ExecBackend` exposes `launch`, `closeByTabId`, `focusPane`, `resolveTabForPane` only
- [ ] Launch-window double-dispatch suppression is served by the durable `pending_dispatches` projection, not a live zellij probe
- [ ] A from-scratch re-fold (cursor=0) over the historical log reproduces byte-identical projections (no `Dispatched` events historically → empty `pending_dispatches`)
- [ ] A never-binding dispatch self-clears via a producer-side TTL sweep on the 60s heartbeat; a bound dispatch self-clears via discharge-on-bind
- [ ] Tab rename never breaks dispatch or reap; `keeper autopilot` continues to pace one-at-a-time with no double-dispatch across the launch→bind window
- [ ] Schema bumped to v50 with `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS` updated in the same change

## Early proof point

Task that proves the approach: `.2` (reducer events, folds, discharge +
re-fold determinism). The load-bearing assumption is that a durable
projection with event-sourced discharge (bind / fail / expire) can replace
the live probe while staying re-fold-deterministic. If `.2` cannot make
discharge-on-bind deterministic inside the SessionStart fold: fall back to
a producer-side reconciliation that mints an explicit `DispatchBound`
synthetic event instead of an in-fold DELETE.

## References

- fn-674 — the per-cycle zellij tab probe this epic reverses (the `liveTabKeys` mechanism is removed)
- fn-661 — `DispatchFailed` / `DispatchCleared` mint→fold→projection pair; the line-for-line precedent for `Dispatched` / `DispatchExpired`
- fn-668 — `BackendExecSnapshot` worker / `jobs.backend_exec_{session_id,pane_id,tab_id}` metadata; reap-by-tab-id depends on it (previously decorative, now load-bearing)
- `fn-677` (overlap) — task fn-677.2 (`Session-agnostic ensureLaunched`) is in-progress on `src/exec-backend.ts`'s `createZellijBackend`, the same surface task `.4` restructures; epic depends on fn-677 to serialize the merge

## Docs gaps

- **CLAUDE.md**: add `Dispatched` / `DispatchExpired` to the sole-writer synthetic-event list (~lines 62-74); replace the fn-674 "per-cycle zellij tab probe" autopilot-gate bullet (~lines 349-377) wholesale, scrubbing the name-as-oracle rationale
- **README.md**: revise the eighth-worker paragraph (~1316-1376: dedup description, `ExecBackend` `closeByName`→`closeByTabId`, `autoclose_windows` reap line); add an "As of schema v50" changelog paragraph (~1151-1193)

## Best practices

- **Mint intent before the side effect (outbox ordering):** mint `Dispatched` BEFORE `launch()` so a crash between launching the tab and recording it cannot reinstate the blind window. The rare cost — a phantom pending row delaying a real dispatch until TTL — is strictly preferable to double-dispatch.
- **Row presence IS the signal:** no `launched` boolean / status column — a row's existence means "in-flight," its absence (discharged by bind/fail/expire) means "clear." A stored flag would re-create the live-query problem.
- **TTL must exceed worker cold-start P99:** cold `claude` boot is 24-33s; TTL set to 120s. Too short re-dispatches a live booting worker (the fn-627 double-dispatch incident).
- **All wallclock lives in the producer:** the TTL sweep reads `Date.now()` in main; the fold reads only `event.ts`. A fold that compares against the clock breaks re-fold determinism.

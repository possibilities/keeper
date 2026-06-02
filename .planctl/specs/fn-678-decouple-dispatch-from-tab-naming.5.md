## Description

**Size:** M
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts, test/autopilot.test.ts

### Approach

Integrate the durable projection into the reconciler and retire the live
probe. Collapse `confirmRunning` to: watermark → mint `Dispatched` (via
`emitDispatched`) BEFORE `launch()` → `launch()` → on `{ok:false}` emit
`DispatchFailed` (the fold discharges the pending row) → return. Delete
the poll loop, the `tabExistsByName` probes, and `DEFAULT_CEILING_MS`. In
`loadReconcileSnapshot`, replace `liveTabNames()` + `candidateKeys` +
intersection with a `read("pending_dispatches")` → `pendingKeys` Set
(mirror the `failedKeys` block exactly); drop the `liveTabNames` param.
Collapse BOTH suppression arms (task arm + close-row arm) to
`snapshot.pendingKeys.has(key)`. `LiveDispatch` / `PlannedReap` gain
`backend_exec_session_id` + `backend_exec_tab_id`, read off the freshest
job by `(plan_verb, plan_ref)` in the reap pass. `runReconcileCycle`
switches `closeByName` → `closeByTabId(session, tabId)` with the
NULL-tab-id contract: if `backend_exec_tab_id` is NULL (the fn-668 backend
tick hasn't resolved it yet), skip the close this cycle and KEEP the
`liveDispatches` entry so it retries; accept a cosmetic husk in the rare
race where the job goes terminal before resolution (the `pending_dispatches`
row TTL-expires regardless). Update the deps-injection harness: drop the
`tabExistsByName` / `closeByName` fakes, add `emitDispatched` /
`closeByTabId`.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:776 — `confirmRunning` (collapse; delete poll loop ~:823-848, tab probes ~:841/:858)
- src/autopilot-worker.ts:1045 — `loadReconcileSnapshot` (replace probe with `pending_dispatches` read; `failedKeys` block ~:1075 is the template)
- src/autopilot-worker.ts:640 — task suppression arm; :682 — close-row arm (both → `pendingKeys.has`)
- src/autopilot-worker.ts:300 — `LiveDispatch` / `PlannedReap`; reap pass ~:701-729; `runReconcileCycle` ~:889-909
- src/backend-worker.ts:111 — the fn-668 worker that is the SOLE writer of `backend_exec_tab_id` (reap correctness now depends on it)

**Optional** (reference as needed):
- src/autopilot-worker.ts:452 — `DEFAULT_CEILING_MS` (delete)

### Risks

- A gap in the pending suppression reintroduces the fn-627 double-dispatch — the `Dispatched`-before-`launch` ordering and the in-memory `state.inFlight` arm must both cover the mint→fold latency.
- The NULL-guard dropping the `liveDispatches` entry would leak a husk on every fast reap — it must RETAIN and retry.

### Test notes

`confirmRunning` mints `Dispatched` before `launch`; reconcile suppresses
on `pendingKeys`; reap retries on NULL `tab_id` then closes once resolved;
no double-dispatch across the launch→bind window; daemon-restart mid-launch
re-arms suppression from the durable projection.

## Acceptance

- [ ] `confirmRunning` collapsed — no poll loop, no `DEFAULT_CEILING_MS`, no `tabExistsByName`; mints `Dispatched` before `launch`
- [ ] `pendingKeys` (from `pending_dispatches`) is the sole launch-window suppression; both arms collapsed to it; `liveTabNames` no longer called
- [ ] Reap closes by tab id with retry-then-accept-husk on NULL `backend_exec_tab_id`
- [ ] deps-injection harness updated; autopilot tests pass with no double-dispatch

## Done summary
Removed tabExistsByName/liveTabNames/closeByName from autopilot worker. loadReconcileSnapshot reads pending_dispatches for liveTabKeys. confirmRunning mints emitDispatched before launch. runReconcileCycle calls closeByTabId with session+tabId from jobs. Tests updated. 572/572 pass.
## Evidence

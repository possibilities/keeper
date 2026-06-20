## Description

**Size:** M
**Files:** src/exec-backend.ts, src/autopilot-worker.ts, test/exec-backend.test.ts, test/autopilot-worker.test.ts, README.md, CLAUDE.md

### Approach

Close the launch->SessionStart blind window with a name-exact zellij tab
probe keyed by the `verb::id` dedup key. Concretely:

1. **New clean `ExecBackend` probe** (e.g. `tabExistsByName(session, name): Promise<boolean>`).
   Run the same `list-panes -a -j` primitive `closeByName` already uses;
   return true iff some pane's `tab_name` === `name` EXACTLY (recycle-safe
   name match, mirroring `resolveTabForPane`'s parse). Return `false`
   (inert) when zellij is missing / the call fails — never throw. Zellij is
   the only backend today; keep the method on the `ExecBackend` interface so
   a future backend supplies its own.
2. **Probe once per cycle, keep `reconcile()` pure.** At snapshot-load time
   (producer-side, where the worker already loads `jobs`/`failedKeys`), query
   the backend for the set of live `verb::id` tab names and pass it into
   `reconcile()` as a new `ReconcileSnapshot` field (e.g.
   `liveTabKeys: Set<DispatchKey>`). NOTHING inside `reconcile()` calls
   zellij/fs/clock — same discipline as the existing snapshot inputs.
3. **New standing dedup arm.** A `(verb, id)` slot is occupied if
   `isOccupyingJob(...)` (post-SessionStart) OR `liveTabKeys.has(key)`
   (pre-SessionStart gap window). This is the guard that stops the
   re-dispatch even after `inFlight` clears and before the `jobs` row lands.
4. **`confirmRunning` early-resolve + no spurious failure.** Poll BOTH
   `findJob` (jobs row) AND the tab probe; resolve `"ok"` as soon as the
   named tab is visible OR the jobs row appears — whichever first — so the
   fn-644 one-at-a-time stagger releases in ~zellij latency, not the full
   ceiling. On ceiling-elapse with NEITHER a tab NOR a jobs row -> genuine
   failure -> emit `DispatchFailed`. Keep the immediate `launch {ok:false}`
   short-circuit minting `DispatchFailed` as-is. A timeout while the tab
   exists mints NOTHING.
5. **Defense-in-depth ceiling bump.** `DEFAULT_CEILING_MS` 18_000 -> 60_000.
   With early-resolve it rarely matters; it just bounds active polling.

Note the give-up is now natural: a launch that never creates a tab fails
honestly (no tab ever observed); a tab that lingers after `claude` exits
keeps the slot occupied until the human / autoclose reaps it — the correct
"still occupying that surface" semantics, matching `isOccupyingJob`'s
treatment of `stopped` jobs. Restart safety is free: the probe reads zellij
live each cycle, so a daemon restart re-derives occupation with no
re-dispatch.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:683-752 — `confirmRunning` (watermark->launch->poll->timeout); add the tab-probe dep + early-resolve, change the timeout-emits-DispatchFailed branch
- src/autopilot-worker.ts:795-835 — `runReconcileCycle`; `finally{inFlight.delete}` :832; on "ok" promotes to liveDispatches
- src/autopilot-worker.ts:509-666 — `reconcile` pure decision + three guards (:566 inFlight / :569 failedKeys / :572 isOccupyingJob); add the liveTabKeys arm
- src/autopilot-worker.ts:464-479 — `isOccupyingJob` (the post-SessionStart arm to sit beside)
- src/autopilot-worker.ts:349-356,:378,:385,:393 — `LaunchResult` (no PID), `ConfirmOutcome`, `DEFAULT_POLL_INTERVAL_MS`, `DEFAULT_CEILING_MS`
- src/autopilot-worker.ts:1086,:1100-1113 — live `deps.launch`/`findJob` wiring + `loadReconcileSnapshot` (where to add the per-cycle tab probe)
- src/exec-backend.ts:279-312 — `buildZellijNewTabArgs --name <key>` (proves tab name === dedup key)
- src/exec-backend.ts:693-748 — `resolveTabForPane` (the `list-panes -a -j` parse to mirror for the new method)
- test/autopilot-worker.test.ts:172-254 — `makeFakeDeps` (extend with a fake tab probe / liveTabKeys)
- test/autopilot-worker.test.ts:577-599 — the BAD test asserting a timeout mints DispatchFailed; SPLIT into "no tab -> emit" vs "tab exists -> no emit, slot held"

**Optional** (reference as needed):
- test/autopilot-worker.test.ts:458-497 — the three existing dedup tests (must stay green; add a fourth for the liveTabKeys arm)
- test/autopilot-worker.test.ts:675-761 — fn-644 one-at-a-time stagger tests (early-resolve must not break them)
- src/exec-backend.ts:363-374 — `buildZellijListTabsArgs` / list-tabs primitive
- src/server-worker.ts:465 — `isPidAlive` (NOT used by option c; confirms why PID-probe was rejected)

### Risks

- **`reconcile()` purity regression.** Easy to accidentally call the async
  probe inside `reconcile()`. Keep the probe at snapshot load; pass a
  `Set` in. Guard with a test that `reconcile()` takes no async deps.
- **Early-resolve vs stagger.** Resolving `"ok"` on tab-visible must still
  promote to `liveDispatches` correctly and not skip the per-launch
  bookkeeping; verify the stagger tests stay green.
- **Probe latency / flakiness.** `list-panes` is a subprocess per cycle;
  if zellij is briefly unresponsive the probe returns false and a
  re-dispatch could slip. Mitigated by the in-flight guard during the
  active confirm and the ceiling; document the residual.
- **fn-673 rebase.** Adding an interface method touches the same
  `ExecBackend` surface fn-673 extends — keep the method minimal.

### Test notes

- New `test/exec-backend.test.ts` case: name-exact match true/false, recycle-safety (same pane id different name -> false), zellij-missing -> false (inert).
- `confirmRunning`: (a) tab appears before jobs row -> early "ok", no emit; (b) ceiling elapses, no tab, no row -> "failed" + emit; (c) launch {ok:false} -> immediate "failed" + emit; (d) tab exists at ceiling, no row yet -> NO emit (split from the old BAD test).
- `reconcile`: a fourth dedup test — `liveTabKeys.has(key)` suppresses a launch even with empty `jobs`/`inFlight`/`failedKeys`.

## Acceptance

- [ ] `ExecBackend` gains a clean name-exact `tabExistsByName(session, name)` (or equivalent) that mirrors `resolveTabForPane`'s `list-panes -a -j` parse and is inert (false, no throw) when zellij is absent
- [ ] The per-cycle tab probe runs at snapshot load; `reconcile()` receives a `liveTabKeys: Set<DispatchKey>` and calls nothing async/impure
- [ ] A `(verb,id)` slot is occupied when `isOccupyingJob` OR `liveTabKeys.has(key)`; a reconcile in the launch->SessionStart window does NOT re-dispatch
- [ ] `confirmRunning` resolves `"ok"` as soon as the named tab OR the jobs row is visible; a timeout while the tab exists mints no `DispatchFailed` and frees no slot
- [ ] `DispatchFailed` mints only on launch `{ok:false}` OR ceiling-elapsed with neither tab nor jobs row
- [ ] `DEFAULT_CEILING_MS` >= 60_000
- [ ] BAD timeout test split into dead-vs-alive; fn-644 stagger + three dedup guards + watermark exclusion stay green; new exec-backend + liveTabKeys tests added
- [ ] No `SCHEMA_VERSION` bump, no `src/reducer.ts` change, no `keeper/api.py` change
- [ ] README eighth-worker paragraph, CLAUDE.md autopilot-dispatch-gates + `confirmRunning` sentence, and the `confirmRunning`/in-flight-map/`DEFAULT_CEILING_MS` JSDoc updated to the new contract

## Done summary
ExecBackend gained tabExistsByName + bulk liveTabNames; ReconcileSnapshot.liveTabKeys feeds a fifth dedup arm; confirmRunning early-resolves on tab-visible OR jobs-row, mints DispatchFailed only on launch failure or ceiling-elapsed with neither signal; DEFAULT_CEILING_MS bumped 18s→60s.
## Evidence

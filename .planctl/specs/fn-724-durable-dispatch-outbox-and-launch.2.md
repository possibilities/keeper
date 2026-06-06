## Description

**Size:** M
**Files:** src/exec-backend.ts, src/autopilot-worker.ts, test/exec-backend.test.ts, test/autopilot-worker.test.ts

On pause/boot-pause, cancel launch-window zellij surfaces so pre-pause
dispatch intents (zellij executes new-tab minutes late) don't escape the
pause boundary as ghost workers.

### Approach

Add a net-new exec-backend helper that enumerates panes
(`buildZellijListPanesAllJsonArgs` → `parseListPanesJson`) and closes those
matching a predicate (`buildZellijClosePaneArgs`), never-throw envelope. Wire
it into the worker `set-paused` handler (src/autopilot-worker.ts:1241-1250;
boot-pause relays through the same path, so one hook covers both). **Candidate
predicate (safety-critical):** tab-name matches `work::|approve::|close::`
AND the surface has an OPEN `pending_dispatches` row (intersect list-panes
with the worker's open-pending set — a row already discharged by SessionStart
= a LIVE worker = NEVER reap). `exited:true` ghost panes with an open row are
the prime target. Abort any in-flight `confirmRunning` (signal) before reaping
so a confirm doesn't keep polling a just-closed pane. Wrap the whole reap in
try/catch (no-self-heal); per-pane close failures log+continue.

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts:383 (list-panes args), :441 (parse), :413 (ZellijPane{id,tab_name,exited}), :327 (close-pane args), :115-160 (never-throw envelope).
- src/autopilot-worker.ts:1241-1250 (set-paused handler — reap hook), :286 (dispatchKey verb::id tab name), the open-pending set source (loadReconcileSnapshot/liveTabKeys).
- src/reducer.ts:6601-6731 (SessionStart discharge — a discharged row means do-not-reap).
- test/exec-backend.test.ts (argv/parse with fake spawn), test/autopilot-worker.test.ts:200-276 (fake-deps for the set-paused reap).

### Risks

- **Highest blast radius:** reaping a live worker. The OPEN-pending-row intersect is the guard — never reap from pane-state alone (list-panes lags zellij reality). Test a live-worker-not-reaped case explicitly.
- Pause-mid-confirm race: abort the in-flight confirm before reaping.
- list-panes empty/unparseable → no-op, never throw (else fatalExit bounces the daemon).
- "multiple panes for one verb::id" → decide (close all / log); don't leave an orphan.

### Test notes

Reap closes a `work::X` pane with an OPEN pending row; does NOT close a
`work::Y` pane whose row discharged (live worker); no-ops on empty/unparseable
list-panes; never throws on close failure.

## Acceptance

- [ ] On pause/boot-pause, surfaces matching `work::|approve::|close::` with an OPEN pending_dispatches row are reaped (close-pane); discharged-row (live) surfaces are never touched.
- [ ] In-flight confirmRunning aborted before reap; whole reap try/caught + never-throws; per-pane failures log+continue.
- [ ] New exec-backend enumerate+close helper has argv/parse tests; a live-worker-not-reaped test pins the safety guard.
- [ ] `bun test test/exec-backend.test.ts test/autopilot-worker.test.ts` green.

## Done summary

## Evidence

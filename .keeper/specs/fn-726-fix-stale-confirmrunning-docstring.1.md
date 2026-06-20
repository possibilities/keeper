## Description

Finding F1 from the fn-724 close audit (`src/autopilot-worker.ts:29-51`). The `confirmRunning` block-level docstring has two stale steps after the fn-724 three-way outcome change:

- **Step 2** (line 34): currently reads `res = await deps.launch(argv, name). {ok:false} → emit DispatchFailed immediately...` — omits the new durable ack step that now precedes `deps.launch`. Add a step 2a (or rewrite step 2) describing `emitDispatched` → await `dispatched-ack{id, ok}` before launch; `ok:false` from the ack or ack-timeout → abort without launching.
- **Step 4** (lines 43-49): currently reads `→ emit DispatchFailed reason="confirm timeout" and resolve "failed"` — contradicts the fn-724 implementation that suppresses the emit and returns `"indoubt"`. Update to describe the three-way `ok`/`failed`/`indoubt`/`aborted` outcome: `launch.ok===false → "failed"` (emit DispatchFailed); SessionStart bound before ceiling → `"ok"`; ceiling elapses with `launch.ok===true` → `"indoubt"` (no emit, keeps pending_dispatches row, releases inFlight).

The inline comments at the ceiling site and the `ConfirmOutcome` type doc were correctly updated by fn-724; only this top-of-function header was missed.

## Acceptance

- [ ] Step 2 (or a new step) describes the durable ack-before-launch gate
- [ ] Step 4 describes the `"indoubt"` ceiling path with suppressed emit
- [ ] The three-way outcome matches the `ConfirmOutcome` type doc already in the file

## Done summary
Refreshed the confirmRunning header docstring in src/autopilot-worker.ts: step 2 now describes the durable emitDispatched/dispatched-ack gate before launch (abort-without-launch on ok:false/timeout), and step 4 describes the three-way ok/failed/indoubt ceiling outcome with suppressed DispatchFailed emit on launch-success, matching the ConfirmOutcome type doc.
## Evidence

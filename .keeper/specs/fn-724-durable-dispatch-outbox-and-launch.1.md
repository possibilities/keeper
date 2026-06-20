## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/daemon.ts, test/autopilot-worker.test.ts, test/daemon.test.ts

The keystone: make the Dispatched mint durable-before-launch (id-correlated
ack) and split the launch outcome three ways (ok/failed/indoubt). Reducer
untouched.

### Approach

Change `emitDispatched` dep (src/autopilot-worker.ts:434) from `(payload)=>void`
to a Promise that resolves on a `dispatched-ack`; in `confirmRunning`
(:845) `await` it before `launch()` (:852); on `ok:false` or timeout
(~5s floor, ≥ busy_timeout+drain), ABORT — do not launch, release inFlight.
Add an id-correlated request/reply on the main↔autopilot-worker channel
(net-new here; mirror the server-worker SetAutopilotPaused Request/Result
and main's append-then-reply at daemon.ts:1252-1345): worker posts
`{kind:"dispatched-request",id,payload}`, main's `handleDispatchedMint`
(:2378-2423) inserts durably then replies `{type:"dispatched-ack",id,ok}`;
worker keys a pending-promise map by id, resolves in its onmessage handler
(:1234), abortable via shutdownController. Widen `ConfirmOutcome` (:565) with
`"indoubt"`; the ceiling branch (:900-914) returns `indoubt` and SUPPRESSES
the `DispatchFailed` emit (keep the pending row → TTL sweep later emits
DispatchExpired); the launch-`{ok:false}` branch (:858-867) STILL emits
DispatchFailed. `runReconcileCycle` releases inFlight on `indoubt` (same as
failed/ok). Reducer arms (foldDispatchFailed :3631-3643) are UNCHANGED.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:825-915 (confirmRunning), :565 (ConfirmOutcome), :420-466 (ConfirmRunningDeps), :1234-1250 (worker onmessage / set-paused), :1317-1355 (live deps factory + emitDispatched :1325).
- src/daemon.ts:2378-2423 (handleDispatchedMint — add reply), :2275-2301 (worker onmessage up), :1252-1345 (set-autopilot-paused ack pattern to mirror), :263 (PENDING_DISPATCH_TTL_MS), busy_timeout value (src/db.ts).
- src/reducer.ts:3631-3643 (foldDispatchFailed DELETE — confirm NO change needed), :3 DispatchExpired fold (idempotent no-op on missing row — verify).
- test/autopilot-worker.test.ts:200-276 (fake-deps), :835 (ceiling assertion that CHANGES), :976 (watermark-before-launch); test/daemon.test.ts:1911-2088 (TTL sweep).

### Risks

- Ack-timeout floor too short → false-abort during boot drain (use ≥5s; confirm busy_timeout). Ack wait must be abortable on shutdown.
- Two abort flavors: ack-timeout (row may have landed → TTL cleans it) vs ok:false (no row) — both don't-launch; document each.
- ceiling<TTL invariant — pin with a test.
- Do NOT touch the reducer (a "fix" there would re-introduce the row-DELETE on timeout). The coupling break is producer-side suppression only.

### Test notes

Prove launch() is NOT called until dispatched-ack resolves; ack ok:false →
no launch, inFlight released; ceiling+launch.ok → indoubt, NO DispatchFailed,
pending row retained; launch.ok:false → DispatchFailed (unchanged). Assert
DEFAULT_CEILING_MS < PENDING_DISPATCH_TTL_MS. Assert SCHEMA_VERSION unchanged.

## Acceptance

- [ ] emitDispatched is awaited; launch() only after a durable `dispatched-ack{ok:true}`; ack ok:false/timeout aborts without launching (inFlight released).
- [ ] id-correlated dispatched-request/ack added on the main↔autopilot-worker channel (mirrors server-worker pattern); abortable on shutdown.
- [ ] `ConfirmOutcome` gains `indoubt`; ceiling+launch.ok → indoubt (no DispatchFailed, pending row kept); launch{ok:false} → DispatchFailed (unchanged).
- [ ] Reducer untouched; no schema bump (test asserts SCHEMA_VERSION=59); ceiling<TTL test pinned.
- [ ] `bun test test/autopilot-worker.test.ts test/daemon.test.ts` green; lint+typecheck clean.

## Done summary
Made the autopilot Dispatched mint durable-before-launch via an id-correlated dispatched-request/ack on the main<->autopilot-worker channel: confirmRunning now awaits main's durable insert before launch() (closing the fn-627 SessionStart-drains-before-Dispatched race), and widened ConfirmOutcome with 'indoubt' so a ceiling-hit with launch.ok keeps the pending_dispatches row and suppresses DispatchFailed. Reducer untouched, no schema bump (stays 59).
## Evidence

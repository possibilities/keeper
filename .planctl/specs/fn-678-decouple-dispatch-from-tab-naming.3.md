## Description

**Size:** M
**Files:** src/daemon.ts, src/autopilot-worker.ts, test/daemon.test.ts

### Approach

Wire the producer side. Define `DispatchedMessage {kind:"dispatched",
payload}` and `DispatchExpiredMessage {kind:"dispatch-expired", payload}`
worker→main wire types next to `DispatchFailedMessage`, and add an
`emitDispatched` field to `ConfirmRunningDeps` (the autopilot collapse in
`.5` calls it; this task only plumbs it). In `daemon.ts` add `onmessage`
handlers that mint each synthetic event on main's writable connection
(mirror the `DispatchFailed` mint: `$session_id = "${verb}::${id}"`,
full column binding, NON-FATAL catch, then `wakePending = true;
pumpWakes()`). Add the producer-side TTL sweep: on the existing 60s
heartbeat, read `pending_dispatches` (read-only), and for each row where
`dispatched_at + TTL_MS (120000) < Date.now()` AND there is no open
`dispatch_failures` row for the same `(verb, id)` (LEFT JOIN guard), mint
`DispatchExpired`. The sweep MUST ride the heartbeat, not the
level-triggered `data_version` wake — a crashed dispatch can be the only
pending row on a quiescent board, and a write-triggered wake would never
fire. All wallclock lives here in the producer, never in a fold.

### Investigation targets

**Required** (read before coding):
- src/daemon.ts:1978 — `DispatchFailed` mint handler (full column binding, non-fatal catch at ~:2027, wake/pump)
- src/daemon.ts:1592 — 60s heartbeat (hook the TTL sweep here)
- src/autopilot-worker.ts:1011 — `DispatchFailedMessage` wire shape + `ConfirmRunningDeps`
- src/daemon.ts:73 — message-type imports

**Optional** (reference as needed):
- src/exit-watcher.ts:223 — `Killed` mint (producer-scans-wallclock-mints-synthetic precedent)

### Risks

- TTL shorter than cold-start → double-dispatch; 120s chosen as ~2x the documented 60s cold-start ceiling.
- Sweep on the `data_version` wake instead of the heartbeat → quiescent-board rows never expire.
- Minting inside a fold is forbidden — mint only on main's writable connection.

### Test notes

Sweep mints `DispatchExpired` for an aged row; skips a row with an open
`dispatch_failures` row; TTL measured from `dispatched_at` (frozen event
ts) so a daemon restart does not reset the clock. Mint handlers survive a
throw without crashing the daemon.

## Acceptance

- [ ] `dispatched` / `dispatch-expired` handlers mint synthetic events on the writable connection, non-fatally
- [ ] TTL sweep runs on the 60s heartbeat with a 120s TTL and skips `(verb,id)` with an open `dispatch_failures` row
- [ ] `emitDispatched` plumbed into `ConfirmRunningDeps`
- [ ] No wallclock read occurs inside any fold

## Done summary

## Evidence

## Overview

A worker the autopilot dispatches that never binds (spawns but never sends its
bind) currently gets re-dispatched forever — the original pile-up amplifier
(it caused the dispatch stalls + lingering-tab blocks during the planctl->keeper
drain). Add a deterministic, event-sourced circuit breaker: fold a per-(verb,id)
consecutive-DispatchExpired-without-bind counter; after K=3 consecutive expires
with no intervening bind, mint a sticky DispatchFailed("never-bound") that the
EXISTING failedKeys gate already suppresses, cleared by `keeper autopilot retry`.
A successful bind resets the counter. Reuses the existing dispatch_failures row +
retry path, so NO readiness/retry-worker changes.

## Quick commands

- `bun run test:full`
- assert: K consecutive DispatchExpired (no bind) mints DispatchFailed("never-bound"); a bind between expires resets the count

## Acceptance

- [ ] foldDispatchExpired folds a per-(verb,id) consecutive-no-bind counter; mints a sticky DispatchFailed("never-bound") at K=3
- [ ] a successful bind (the discharge-on-bind gate) resets the counter to 0; "bound-then-died" does NOT trip the breaker
- [ ] the sticky failure suppresses re-dispatch via the existing failedKeys arm; `keeper autopilot retry` (retry_dispatch -> DispatchCleared) clears both the failure and the counter
- [ ] SCHEMA_VERSION 75->76 + keeper/api.py SUPPORTED_SCHEMA_VERSIONS gains 76 (same commit); re-fold byte-identical; `bun run test:full` green

## Early proof point

The single task. If re-fold diverges, the counter is being bumped non-deterministically (wall-clock instead of the event stream) — fold the bump/reset purely off DispatchExpired + the bind transition.

## References

- src/reducer.ts:3555 foldDispatchExpired (extend); :3379 foldDispatchFailed (reuse for the mint); :6326 discharge-on-bind reset
- src/autopilot-worker.ts:920 failedKeys suppression (auto-handles never-bound — no change); src/daemon.ts:1860 retry_dispatch -> DispatchCleared
- src/db.ts:50 SCHEMA_VERSION; :1184 addColumnIfMissing; keeper/api.py:316 SUPPORTED_SCHEMA_VERSIONS

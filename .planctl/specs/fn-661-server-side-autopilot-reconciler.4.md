## Description

**Size:** M
**Files:** src/daemon.ts, src/server-worker.ts, src/rpc-handlers.ts, test/daemon.test.ts, test/server-worker.test.ts

### Approach

Spawn the autopilot worker from main after migrate + boot-drain (alongside the
existing workers), assembling its injected deps: `launch`/`closeByName` from the
`ExecBackend` (task 2), `emitDispatchFailed` by minting a `DispatchFailed`
synthetic event (git-worker mint precedent `src/daemon.ts:1309-1376` — worker
posts a typed message, main runs `insertEvent.run` then `wakePending=true;
pumpWakes()`), `findJob` via the worker's own read conn, and the `autoclose`
config flag (read at boot; default off). Copy BOTH the `onerror` and
`close`-guarded-by-`!shuttingDown` handlers (`:764-866`) or a crash vanishes. Add
the worker to `shutdown()` (`:1566-1612`) and the SIGTERM fan-out list
(`:1572-1582`) — the fleet is now eight workers.

Main holds the in-memory `paused` flag (default true on boot, never persisted).
Register two RPCs (registry in `src/server-worker.ts:796-844`, bridge precedent
`:731-844` / `src/daemon.ts:800-851`): `set_autopilot_paused(bool)` bridges
server-worker→main; main flips `paused` and relays a `{type:"set_paused"}`
command to the autopilot worker (new main→worker command channel), which gates
its reconcile. `retry_dispatch(id)` validates ONLY the id shape (launch params
come from the projection read, never the RPC payload) and bridges to main, which
appends a `DispatchCleared` event (clearing the failure). Neither RPC writes a
projection directly.

### Investigation targets

**Required** (read before coding):
- src/daemon.ts:1309-1376 — git-worker producer→main synthetic-event mint (the emitDispatchFailed template)
- src/daemon.ts:764-866 — worker spawn + onerror + close→fatalExit (copy both handlers)
- src/daemon.ts:800-851 — server-worker→main async bridge (replay-request/replay-result) — RPC bridge template
- src/daemon.ts:1566-1612 — shutdown() fan-out; :1572-1582 SIGTERM list (add the worker)
- src/server-worker.ts:731-844 — RPC_REGISTRY/ASYNC_RPC_REGISTRY, registerRpc/registerAsyncRpc, ReplayBridge, AsyncRpcHandler
- src/rpc-handlers.ts — installRpcHandlers (where new handlers register)

**Optional** (reference as needed):
- CLAUDE.md `## DO NOT` — RPC writes are scoped; new RPCs must not write projections directly (round-trip via events)
- src/types.ts:1010 — Task.tier (a projection-sourced launch param, not from the RPC)

### Risks

- paused is cross-thread (server-worker RPC → main flag → worker command) — get the ownership + relay ordering right; boots-paused must hold with no persistence.
- retry_dispatch must reject anything but an id (no command/param injection via RPC).
- DispatchFailed payload must carry everything the fold needs (verb, id, reason, dir, ts) — no fold-time clock.
- onerror vs close double-fire: a process.exit(1) fires close, not onerror — wire both.

### Test notes

- daemon.test.ts: worker spawns after boot-drain and is in the shutdown fan-out; boots paused.
- server-worker/rpc-handlers test: set_autopilot_paused flips the flag + relays the command; retry_dispatch appends DispatchCleared and rejects malformed ids.

## Acceptance

- [ ] Autopilot worker spawned after migrate+boot-drain with injected deps (launch/closeByName/emitDispatchFailed/findJob/autoclose-flag); in shutdown() + SIGTERM fan-out; onerror+close both wired
- [ ] keeperd boots PAUSED (in-memory, not persisted)
- [ ] set_autopilot_paused bridges server-worker→main, flips paused, relays a command to the worker
- [ ] retry_dispatch validates id shape only and appends DispatchCleared via main (no direct projection write, no param injection)
- [ ] emitDispatchFailed mints a DispatchFailed event via main (git-worker mint pattern)

## Done summary
Spawned the autopilot worker as the 8th supervisor thread after migrate+boot-drain with paused=true workerData and autoclose/zellijSession config threaded through; wired worker→main mint pattern for DispatchFailed and DispatchCleared; added set_autopilot_paused + retry_dispatch async RPCs bridging server-worker→main with id-shape-only validation (no param injection); worker is in shutdown() + SIGTERM fan-out with onerror+close both wired.
## Evidence

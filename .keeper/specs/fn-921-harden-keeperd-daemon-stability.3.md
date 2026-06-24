## Description

**Size:** M
**Files:** src/bus-worker.ts, src/bus-identity.ts, cli/bus.ts, plugins/keeper/monitors.json (+ tests)

### Approach

Make a live agent reachable again: a live agent that can SEND shows
`not_connected` to directed sends AND is absent from `keeper bus list`. Both the
`not_connected` verdict (`bus-worker.ts:297`) and list membership (`:1122`) gate
on `e.sock !== null`; the send path registers but never subscribes (only `keeper
bus watch` binds `sock`, `:882`), so a `sock=null` "known but not connected"
ghost results.

1. **Pin the concrete failure** (likely BOTH): (a) `runSend`
   (`cli/bus.ts:752-774`) does register→publish→close and leaves a `sock=null`
   send-only ghost; (b) a `keeper bus watch` Monitor that didn't re-arm after the
   bus-worker restart (this incident followed a daemon bounce, which drops all
   bus connections).
2. **Send-only ghost:** don't let a register-without-subscribe leave a `sock=null`
   entry that reads as a reachable target + absent from list. Distinguish a
   never-subscribed send-only registration from a subscribed-then-closed
   reconnecting channel — both are `sock=null` today (the generation-guarded
   close at `:1215-1228`). Options to weigh: don't register on a pure send,
   subscribe-by-deadline reap of a `REGISTERED_UNSUBSCRIBED` entry, or a distinct
   ephemeral state absent from list/dispatch but still resolvable.
3. **Monitor re-arm:** confirm `runWatch`'s reconnect loop (`cli/bus.ts:901-917`)
   actually re-subscribes after a bus-worker restart / lock-before-bind socket
   replacement; close any gap (stale `bus.sock`, ENOENT during the restart window
   treated as non-retryable, backoff exhaustion).
4. **PRESERVE fn-918's contract:** a genuinely-offline-but-known agent stays
   resolvable (`not_connected`, not `unknown`) so durable wake-on-send does not
   regress (`bus-identity.ts:42-47`). The fix must split "send-only ephemeral"
   from "known agent, currently offline, reconnectable".

### Investigation targets

**Required** (read before coding):
- src/bus-worker.ts:775-866 — `opRegister` (creates entry `sock=null`)
- src/bus-worker.ts:868-892 — `opSubscribe` (the ONLY place `sock` is bound + generation bump)
- src/bus-worker.ts:290-300 — `publishOutcome` `not_connected` verdict
- src/bus-worker.ts:1115-1125 — `opList` (`subscribed: e.sock !== null` gate)
- src/bus-worker.ts:1215-1228 — generation-guarded close (keeps a `sock=null` cache row)
- src/bus-identity.ts:42-47 — known-disconnected-is-resolvable contract (fn-918) + `toLiveChannel` connected flag (:423-431)
- cli/bus.ts:752-774 — `runSend` register→publish→close (never subscribes)
- cli/bus.ts:901-917 — `runWatch` reconnect loop (the re-arm path)
- test/bus-worker.test.ts:194 — `publishOutcome("ok", false, 0) === "not_connected"` (update if semantics change)

**Optional** (reference as needed):
- plugins/keeper/monitors.json — the `keeper bus watch` Monitor (`when:"always"`)

### Risks

- **Regressing fn-918 durable wake-on-send:** an offline-but-known agent MUST stay resolvable; only a true send-only ephemeral should be excluded as a target.
- The `(pid, start_time)` takeover key + generation-guarded close are subtle pid-reuse / late-close defenses — don't regress them.
- `bus.db` is the bus-worker's OWN writable sqlite with its OWN `user_version` ladder — any channel-schema change needs a `bus.db` migration (NOT keeper's `SCHEMA_VERSION`).

### Test notes

- Pure unit tests over `publishOutcome` / `selectFanoutTargets` (`test/bus-worker.test.ts`); integration via `sandboxEnv` (sandboxes `KEEPER_BUS_DB`/`KEEPER_BUS_SOCK`), `retryUntil` not `Bun.sleep`. `bun run test:full`.

## Acceptance

- [ ] a live, sending agent is reachable by directed send AND appears in `keeper bus list`
- [ ] a true send-only ephemeral registration does not masquerade as a reachable target
- [ ] `keeper bus watch` Monitors re-arm (re-subscribe) after a bus-worker restart
- [ ] fn-918 durable wake-on-send for genuinely-offline-but-known agents is preserved
- [ ] `bun run test:full` green

## Done summary
Marked a pure-send register (keeper bus chat send/broadcast) as send_only: it binds the from identity without joining the registry, taking over the agent's live watch channel, or persisting a bus.db cache row. Fixes the unreachable-live-agent bug where a transient send evicted the agent's watch and left a sock=null ghost. fn-918 wake-on-send preserved.
## Evidence

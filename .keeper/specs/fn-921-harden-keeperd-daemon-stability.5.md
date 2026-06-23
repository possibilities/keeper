## Description

**Size:** M
**Files:** src/server-worker.ts (+ tests)

### Approach

Make the keeperd read socket (`keeperd.sock`) un-wedgeable by a hammering
client — the recurring-freeze root cause. Today a client that connects without
subscribing (an in-flight one-shot query, or a reconnect-loop client like a
`keeper board` dashboard) piles up as `zero_sub` connections; the reaper
"regressed (no reapable conns among 64)" and CANNOT reap them even when the
daemon is idle and the clients are dead; they hit `MAX_CONNECTIONS=64` → all new
connections rejected → `keeper jobs`/RPC time out → daemon unreachable (you
can't even unpause autopilot). It survives bounces (the client reconnects and
re-fills the cap). Verified: with the daemon at 0% CPU and clients killed, the
64 `zero_sub` did NOT drain — the reaper is broken.

1. **Fix the reaper.** Find the connection sweep + the reapability predicate
   behind the `conn-cap census` / "reaper has regressed" emitter
   (`src/server-worker.ts` — grep the literal strings). A `zero_sub` connection
   that is idle past a threshold, or whose peer is gone (EOF / dead pid), MUST
   be reapable. The current predicate finds "no reapable conns among 64" — that
   is the bug.
2. **Admission control / backpressure.** Add a **subscribe-by-deadline
   force-close**: a connection that does not subscribe OR complete its query
   within N seconds is closed, not parked forever as `zero_sub`. Add per-client
   (per-peer-pid) connection rate-limiting so one client cannot open unbounded
   connections.
3. **Prompt dead-peer detection** so a closed/dead client's connection is
   cleaned immediately (macOS UDS half-open is real — don't rely on the client
   to close cleanly).
4. **Raise `MAX_CONNECTIONS`** (64 is low) behind the real idle-timeout — a
   band-aid ALONE, pair it with the reaper fix.

This is the SAME class of bug as `.3` (a register-without-subscribe / `zero_sub`
connection mishandled) but on the read socket vs the bus. Consider a shared
explicit connection-state FSM: only a SUBSCRIBED/answered connection holds a
durable slot.

### Investigation targets

**Required** (read before coding):
- src/server-worker.ts — grep `"conn-cap census"`, `"reaper has regressed"`, `MAX_CONNECTIONS`, the connection sweep/reaper, the `zero_sub`/`sub_live` accounting
- the connection accept + close handlers (where a conn is added/removed from the registry)

**Optional** (reference as needed):
- src/bus-worker.ts (`.3`) — the parallel `zero_sub`/connected state machine on the bus socket; aim for one model

### Risks

- Do NOT reap a legit in-flight query/subscribe mid-handshake — the deadline
  must be generous enough for a slow cold-boot query (a query can take seconds
  while main warms the fold memo — see `.6`).
- Do NOT break existing `sub_live` watchers (`keeper await`, dashboards).
- The cap-raise alone leaks connections; it MUST be paired with the reaper +
  deadline fix.

### Test notes

- Pure unit tests over the reapability predicate (synthetic conn states: fresh
  zero_sub, idle zero_sub, dead-peer, sub_live) and the subscribe-by-deadline
  decision. Integration: a reconnect-loop client must not wedge the socket
  (`retryUntil`, `sandboxEnv`). `bun run test:full`.

## Acceptance

- [ ] a reconnect-loop / hammering client CANNOT exhaust the connection cap or wedge the read socket
- [ ] stale `zero_sub` connections (idle past threshold / dead peer) ARE reaped — the daemon recovers without a bounce
- [ ] a subscribe-by-deadline force-closes a parked `zero_sub` connection
- [ ] the daemon stays responsive to `keeper jobs`/RPC under a connection storm
- [ ] existing `sub_live` watchers + slow cold-boot queries are not falsely reaped
- [ ] `bun run test:full` green

## Done summary

## Evidence

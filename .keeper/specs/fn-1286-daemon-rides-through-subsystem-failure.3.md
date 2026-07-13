## Description

**Size:** M
**Files:** src/bus-worker.ts, cli/bus.ts, test/bus-worker.test.ts

### Approach

A takeover is legal only over a dead predecessor (ADR 0061). Today the newcomer unconditionally evicts the prior channel for its (pid,start_time) identity; when both connections are live each evicted watcher re-subscribes within its 250ms backoff floor and evicts the other — an infinite eviction war that saturated the accept loop in production. Server side: on duplicate registration, probe the existing channel's connection liveness (the worker owns the socket objects — a write-probe or socket-state check; worker decides the mechanism); dead → evict + admit exactly as today; alive → refuse the newcomer with a typed `duplicate_subscriber` rejection so it terminates visibly instead of fighting. Client side (`keeper bus watch`): treat `duplicate_subscriber` as terminal (clear exit-1 error naming the contract, no retry); add jitter to the reconnect backoff and require a minimum session duration before the backoff resets (today it resets to 250ms on every clean session, so even a jittered evict loop stays in lockstep). The send_only registration path keeps its no-presence carve-out untouched; genuine reconnects (dead predecessor) must keep working unchanged.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/bus-worker.ts:503-519 — takeoverVictim: the pure identity-match seam (extend, don't reinvent)
- src/bus-worker.ts:1141-1164 — the register → takeoverVictim → evict(v,"takeover") call site; the probe-before-evict decision lands here
- cli/bus.ts:1155-1178 — runWatch reconnect loop; backoff reset-on-clean-session at ~1169 is the client half of the war
- cli/bus.ts:1235-1246 — watchOnce register-ack handling (where a typed rejection surfaces)

**Optional** (reference as needed):
- src/bus-worker.ts:326-333, 1188-1189 — the send_only carve-out (precedent for conditional takeover suppression; must stay untouched)
- src/bus-worker.ts:91 — control-namespace lifecycle verbs (join/part/reap/takeover)
- docs/adr/0061-bus-takeover-only-over-dead-predecessor.md — the recorded decision

### Risks

- The liveness probe of the existing connection must not block the accept loop — a hung predecessor socket needs a bounded, non-blocking check (a dead-but-undetected predecessor locking out a legit reconnect is the failure to avoid; a bounded probe timeout that then evicts is acceptable).
- The typed rejection is a client-visible contract change: any script that armed a second watcher and relied on silent takeover now sees exit 1 — that visibility is the point, but the error text must name the fix (one watcher per session).

### Test notes

Truth-table the registration decision as a pure seam: duplicate + dead predecessor → evict+admit; duplicate + live predecessor → reject(duplicate_subscriber); distinct identities → both admitted; send_only → never present, never rejected. Client: backoff builds under repeated short-lived sessions (no reset before the minimum duration), jitter within bounds. No real UDS in the fast tier — inject socket-liveness outcomes. Register new suites with the fn-1281 gate manifest.

## Acceptance

- [ ] A second live watch subscription under an existing (pid,start_time) identity is refused with a typed duplicate_subscriber outcome; the first subscriber's channel is undisturbed.
- [ ] A registration whose predecessor connection is dead evicts and admits exactly as before (reconnect path unchanged).
- [ ] The watch client exits terminally with a clear message on duplicate_subscriber (no retry loop), and its reconnect backoff builds under eviction churn instead of resetting to the floor.
- [ ] An eviction war can no longer be sustained by two live subscribers; the touched suites and the named gate pass.

## Done summary

## Evidence

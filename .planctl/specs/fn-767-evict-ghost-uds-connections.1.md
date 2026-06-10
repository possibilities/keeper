## Description

**Size:** M
**Files:** src/server-worker.ts, test/server-worker.test.ts

### Approach

DIAGNOSE FIRST — the planner's original hypothesis is partially falsified and the
evidence base is now: (1) the Bun `close` handler IS wired and DOES
`conns.delete` (server-worker.ts:2528-2535; eviction paths at :1796, :1908,
:2059 all converge on it), so clean client exits should evict; (2) during the
incident the set held 64 while accepted-conn ids reached 106 over ~43 min, i.e.
entries were NOT being released across that window; (3) twenty minutes after a
bounce the daemon held only 17 unix fds matching ~6 legitimate live clients — no
steady-state leak, so the fill was bursty or class-specific. Suspect classes to
test explicitly: (a) deaths that fire NEITHER close NOR error in Bun (client
process SIGKILLed mid-frame, half-open sockets) — write a test that kills a
client process hard and asserts eviction; (b) the performance babysitter's
daemon-down UDS connect probe (babysitters/performance/watch.ts ~:1230) — verify
it closes its socket on every path including timeout/error, and whether its
socket produces a server-side close event; (c) bursts of overlapping short-lived
clients (the fn-766 worker was running sitter ticks/tests during the incident
window) — churn-test N overlapping (not sequential) one-shot clients; (d) any
server-side path that re-adds or fails to delete on error (`error` handler
coverage vs close). Add temporary-or-permanent conn lifecycle logging (id at
open/close with cause) gated behind TRACE so the next occurrence is attributable
from server.stderr.

Then fix what the diagnosis shows, plus two belt-and-braces arms regardless of
root cause (both are pure connection hygiene per the CLAUDE.md fn-723 carve-out):
(1) an idle sweep — a connection with ZERO subscriptions and no inbound frame
for IDLE_CONN_TTL_MS (~5 min) is evicted in the poll-tick reaper; subscribed
connections are NEVER idle-reaped (the fn-723 no-ping-pong descope stands);
(2) hoist the stuck-pending TTL reap to run on EVERY poll tick, not only
data_version-changed ticks (the deep-review fn-723 gap). Keep reject-new-at-cap
semantics and the loud reaper-regression log line.

### Investigation targets

**Required** (read before coding):
- src/server-worker.ts:2479-2545 — Bun.listen handlers (open/close/error wiring; what fires on hard client death)
- src/server-worker.ts — the poll-tick reaper + its changed-tick gate; conns Set uses (:1796, :1908, :2059, :2468-2510)
- babysitters/performance/watch.ts ~:1230 — the UDS probe's socket lifecycle
- ~/.local/state/keeper/server.stderr — the incident's 83 rejection lines
- test/server-worker.test.ts — existing client/lifecycle seams

### Risks

- Do not evict subscribed-but-quiet viewers; do not LRU-evict at cap.
- The diagnosis verdict (which class actually leaked) goes in Evidence — if none
  reproduces, the lifecycle logging ships anyway so the next occurrence is
  attributable, and the two hygiene arms still close the exposure.

### Test notes

Hard-kill test (SIGKILL a connected client, assert eviction within a tick);
overlapping-churn test (N concurrent one-shots, conns returns to baseline);
sitter-probe test (probe connect/abandon evicted); existing reaper tests
(EPIPE, pending TTL, cap) stay green.

## Acceptance

- [ ] diagnosis verdict in Evidence (which death/probe class leaked, or "not reproduced + lifecycle logging shipped")
- [ ] zero-sub idle sweep + every-tick pending reap live; hard-kill and overlapping-churn tests pin eviction
- [ ] cap/reject semantics and loud log preserved; full bun test green

## Done summary
Closed the ghost-UDS-conn leak: added a 5-min zero-sub idle sweep that evicts a one-shot query-only client which died silently (no close/error fired), and hoisted both hygiene reapers (stuck-pending + idle) to run on EVERY poll tick via reapConns instead of only data_version-changed ticks. Subscribed conns stay exempt; cap/reject + loud reaper-regression log preserved.
## Evidence
- Tests: 7,  , n, e, w,  , +,  , 1, 2, 4,  , e, x, i, s, t, i, n, g,  , g, r, e, e, n,  , (, 1, 3, 1,  , t, o, t, a, l,  , i, n,  , s, e, r, v, e, r, -, w, o, r, k, e, r,  , s, u, i, t, e, ;,  , f, u, l, l,  , s, u, i, t, e,  , 2, 8, 1, 6,  , p, a, s, s,  , /,  , 0,  , f, a, i, l, ), .,  , N, e, w, :,  , z, e, r, o, -, s, u, b,  , i, d, l, e,  , e, v, i, c, t, i, o, n,  , p, a, s, t,  , T, T, L, ,,  , f, r, e, s, h, -, c, o, n, n,  , (, m, i, d, -, h, a, n, d, s, h, a, k, e, ),  , N, O, T,  , s, w, e, p, t, ,,  , s, u, b, s, c, r, i, b, e, d, -, c, o, n, n,  , N, E, V, E, R,  , s, w, e, p, t,  , h, o, w, e, v, e, r,  , l, o, n, g,  , q, u, i, e, t, ,,  , r, e, a, p, C, o, n, n, s,  , r, u, n, s,  , b, o, t, h,  , a, r, m, s, ,,  , n, o, -, s, e, l, f, -, h, e, a, l,  , e, n, d, (, ),  , t, h, r, o, w,  , s, w, a, l, l, o, w, e, d,  , w, i, t, h,  , s, i, b, l, i, n, g, s,  , s, t, i, l, l,  , r, e, a, p, e, d, ,,  , p, o, l, l, L, o, o, p,  , r, e, a, p, s,  , o, n,  , a,  , D, B, -, q, u, i, e, t,  , (, f, r, o, z, e, n,  , d, a, t, a, _, v, e, r, s, i, o, n, ),  , t, i, c, k, ,,  , h, a, r, d, -, k, i, l, l, e, d,  , c, l, i, e, n, t,  , (, S, I, G, K, I, L, L, /, t, e, r, m, i, n, a, t, e, ),  , i, d, l, e, -, s, w, e, p, t,  , e, n, d, -, t, o, -, e, n, d, ,,  , o, v, e, r, l, a, p, p, i, n, g,  , o, n, e, -, s, h, o, t,  , c, h, u, r, n,  , (, N, =, 3, 0, ),  , r, e, t, u, r, n, s,  , c, o, n, n, s,  , t, o,  , b, a, s, e, l, i, n, e,  , 0,  , a, n, d,  , n, e, v, e, r,  , a, p, p, r, o, a, c, h, e, s,  , t, h, e,  , c, a, p, .
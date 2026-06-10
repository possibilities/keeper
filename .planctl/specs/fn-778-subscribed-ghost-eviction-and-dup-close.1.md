## Description

**Size:** M
**Files:** src/server-worker.ts, cli/await.ts (or the shared subscribe client), test/server-worker.test.ts

### Approach

Close the subscribed-ghost hole fn-767 documented as exempt. Preferred mechanism:
record the peer's pid at accept time via getsockopt LOCAL_PEERPID (macOS UDS;
check Bun's API surface or FFI — the exit-watcher's liveness-probe precedent
applies) and have the every-tick reapConns probe kill(pid, 0) on SUBSCRIBED conns
only — a dead peer evicts via the existing eviction path. This distinguishes
dead-peer from quiet-viewer, which is exactly what the fn-723 ping/pong descope
said ping could not do — document that distinction where the descope is cited.
FALLBACK if peer-pid is unreachable from Bun: at cap-pressure (conns > 75% of
MAX_CONNECTIONS) write a benign frame (e.g. a no-op meta/heartbeat line existing
clients already tolerate via LineBuffer) to every subscribed conn — dead peers
EPIPE immediately through the existing evict arm; quiet live viewers ignore it.
Bound the probe cost (per-tick, ~64 conns max — trivial either way).

Client side: on a max_connections (or connect-refused) rejection, `keeper await`'s
reconnect-forever loop must back off exponentially with jitter (e.g. 1s→30s cap)
instead of immediate retry — today ~24 concurrent awaits burn ~20 conn-ids/min
against a full set. Find the shared reconnect loop (fn-757) so board/viewers
inherit the backoff too.

### Investigation targets

**Required** (read before coding):
- src/server-worker.ts — fn-767's reapConns + idle sweep + the subscribed exemption comment; the accept path (Bun.listen open handler) for where peer-pid capture lands
- cli/await.ts + the fn-757 reconnect loop — where backoff goes
- src/exit-watcher*.ts — the kill(pid,0)/liveness-probe precedent
- test/server-worker.test.ts — fn-767's hard-kill + churn test shapes to extend (a SUBSCRIBED hard-killed client must now evict)

### Risks

- NEVER evict a live quiet viewer: the probe keys on peer-process liveness (or
  EPIPE), never on inactivity. The fn-767 zero-sub idle sweep semantics stay
  untouched.
- pid-reuse: a recycled pid passing kill(0) leaves a ghost one more lifetime —
  acceptable (the cap-pressure fallback or next death clears it); note it.

### Test notes

Extend fn-767's tests: SIGKILL a SUBSCRIBED client → evicted within a reap pass;
quiet-but-alive subscribed client survives indefinitely; backoff test on the
client reconnect loop (rejections spaced, not hammered).

## Acceptance

- [ ] subscribed dead-peer conns evicted within one reap pass; quiet live viewers never evicted (both test-pinned)
- [ ] await/viewer reconnect backoff with jitter; full bun test green

## Done summary

## Evidence

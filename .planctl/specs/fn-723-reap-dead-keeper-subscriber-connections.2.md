## Description

**Size:** M
**Files:** src/server-worker.ts, test/server-worker.test.ts

Bound the connection set server-side: evict dead connections and hard-cap
total connections, so leaked subscribers can never again saturate the
serial diff fan-out.

### Approach

(1) **EPIPE-evict:** `flush` (server-worker.ts:1778-1796) already detects
write<0 (closing) but only nulls `pending` and has no `conns` handle.
Resolve reachability — either return a closing-bool up through
writeFrames→diffTick's caller which calls `conns.delete` + `sock.end()`, or
`sock.end()` and rely on the Bun `close` handler (:2321) to `conns.delete`.
(2) **Stuck-pending TTL:** a backpressured conn is SKIPPED by diffTick
(:1995) so it never EPIPEs — track when `pending` was set on ConnState and
evict if stuck beyond a ceiling. This must NOT be a write-side idle timer
(that would kill quiet receive-only subscribers during DB-quiet periods —
anti-pattern); it fires ONLY on a genuinely stuck buffer. (3) **Max-conn
cap (64):** in the Bun.listen `open` handler, if `conns.size >= cap`, write
an error frame (reason `max_connections`) then close — reject-new, NOT
LRU-evict (the oldest is the legit board). Log loudly when the cap is hit
(it means the reaper regressed). All reap/cap logic in the no-self-heal
try/catch (mirror handleKick :2220-2227); clear any timer on shutdown.
Don't log EPIPE/ECONNRESET as error (normal).

### Investigation targets

**Required** (read before coding):
- src/server-worker.ts:1778-1796 (flush, write<0, no conns handle — central plumbing), :2290 (conns Set), :2299-2333 (open/close/error handlers), :722-736 (ConnState/newConnState — add pendingSince), :1879+:1995 (diffTick + backpressure-skip), :1721 (writeFrames), :2220-2227 (no-self-heal try/catch).
- The error-frame shape (existing protocol error frame — reuse, no new frame type).
- test/server-worker.test.ts:1363-1385 (fakeSock — extend: write() returns <0 for EPIPE; add end() spy), :1469-1580 (diffTick drive pattern).

### Risks

- conns-reachability from flush is the key plumbing decision — pick one path and keep eviction the load-bearing act (stops the serial fan-out cost), end() the cleanup.
- Writable type only declares write(); .end() exists at runtime — use the same cast bridge dispose uses.
- Stuck-pending TTL must be distinguishable from a quiet receive-only sub (fire on stuck buffer, not on no-data-to-send).
- reject-vs-evict: reject-new (don't evict the live oldest); a reap throw must be caught (no daemon bounce).

### Test notes

Extend fakeSock to return <0 → assert evicted from conns + end() called.
Stuck-pending: set pending, advance a fake clock past the ceiling → assert
evict. Cap: open cap+1 conns → assert the last gets an error frame + close,
and the first (live) conn survives. Assert a reap-tick throw is swallowed.

## Acceptance

- [ ] Dead conn (write<0) evicted from `conns` (+ sock.end()); a stuck-pending conn evicted via the TTL; neither false-evicts a live attached board.
- [ ] Connection count hard-bounded at 64 — reject-new with an error frame + close (not LRU-evict); cap-hit logged loudly.
- [ ] Reap/cap in no-self-heal try/catch; timer cleared on shutdown; EPIPE not logged as error.
- [ ] No new wire-protocol frame; no reducer/schema change; `bun test test/server-worker.test.ts` green.

## Done summary

## Evidence

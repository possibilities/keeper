## Description

**Size:** M
**Files:** src/server-worker.ts, test/server-worker.test.ts, README.md

### Approach

On cap-hit in the `open(socket)` handler (src/server-worker.ts:2442, MAX_CONNECTIONS=64 at :291): synchronously sweep reapable connections, then accept if space opened, else reject with the existing `max_connections` envelope. The sweep reuses the existing classifications unchanged — `reapConns` (:2016) composing reapStuckPending + reapIdleConns + reapDeadPeers — so the protections hold by construction: reapIdleConns exempts subscribed conns (:1941), reapDeadPeers only evicts dead-pid subscribers, and a live board subscriber can never be evicted (the invariant at :287/:2440). NO new eviction logic, NO LRU.

The one structural change: the reapers' frees must be synchronous for the accept-if-space recheck to see a true `conns.size` — today `conns.delete()` lives only in the async `close` handler (:2492). Free via destroy + inline bookkeeping (conns/subs/pending cleanup at the reap site, mirroring the close handler) and make the close handler idempotent so the later async close event is a no-op. Decrement at the destroy call site, not the close event. Snapshot the iteration list (`[...conns]`) before sweeping — close-path mutation during iteration is the known hazard.

Diagnostics: on every cap-hit, log a one-line conn-state census (pending / zero-sub / subscribed with live peer / subscribed with dead peer). Reframe the log: sweep-recovered accepts log the reaped classes at info; the "the reaper has regressed" alarm moves to the cap-held-AFTER-sweep reject — that is now the genuine anomaly. README conn-cap paragraph (~1248-1258) revised in place.

### Investigation targets

**Required** (read before coding):
- src/server-worker.ts:2442-2460 — the cap-hit reject path being changed
- src/server-worker.ts:2016-2060, :1941, :1978 — reapConns + the exemption logic that must survive unchanged
- src/server-worker.ts:2480-2510 — the close handler whose bookkeeping moves to a shared idempotent helper
- test/server-worker.test.ts:2170 — the real-socket ×64 cap integration test to extend; reapConns unit tests at :1980

### Risks

- Reentrancy: the sweep can run from open() while the pollLoop reap (:2342) also fires — shared idempotent free-helper makes double-reap harmless.
- A subscribed conn evicted by a new code path would regress the board — covered by an explicit never-evicted test.

### Test notes

Extend the integration test: (a) cap-hit with reapable stuck/idle conns → accept succeeds after sweep; (b) cap-hit with a live board subscriber among 64 healthy conns → subscriber survives, new conn rejected; (c) double-close/idempotence. server-worker.test.ts is slow-tier — test:full mandatory.

## Acceptance

- [ ] Cap-hit with reapable conns accepts after synchronous sweep; cap-hit with all-healthy conns rejects with the existing envelope
- [ ] A subscribed live conn is never evicted by the cap-hit path (test proves it)
- [ ] Cap-hit census line + reframed alarm semantics; README paragraph updated in place
- [ ] bun run test:full green

## Done summary

## Evidence

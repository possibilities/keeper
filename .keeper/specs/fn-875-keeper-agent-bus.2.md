## Description

**Size:** M
**Files:** src/bus-worker.ts (new), src/daemon.ts (WorkerName, ALL_WORKERS, want gate, spawn site, teardown, import type), test/bus-worker.test.ts (new, fast-tier pure fns), test/bus-worker.integration.test.ts (new, full tier)

The keystone: a new keeperd worker running the UDS pub/sub relay over the
T1 storage + resolution layer. Proves the whole architecture end-to-end.

### Approach

Register `"bus"` in the `WorkerName` union and `ALL_WORKERS` (NOT
WATCHER_WORKERS — bus does not use a parcel watcher); add a `want("bus")`-gated
`new Worker(new URL("./bus-worker.ts", import.meta.url))` spawn site modeled
on the renamer (onerror/close → fatalExit, NO onmessage — pure actuator); add
it to the shutdown `spawnedWorkers` set. The worker (isMainThread-guarded)
opens TWO connections: bus.db via T1's bus open (writable, sole writer) and
keeper.db via `openDb(..,{readonly:true,prepareStmts:false,bootRetry:true})`
for jobs reads (a reader open does NOT migrate). It runs a `Bun.listen({unix})`
server: `acquireLock`/stale-reclaim before bind, `chmod 0600`, LineBuffer
NDJSON framing per connection with a max-frame guard (destroy on exceed),
`peerPidForFd` to resolve+OVERWRITE the sender `from` (anti-spoof). Op
handlers: register/heartbeat/subscribe/publish(send|broadcast)/list/resolve/
deregister per the epic wire contract; `subscribe` ACK carries the
`last_message_id` replay cursor. Fan-out: pre-serialize the line ONCE, write
to each matching subscriber (namespace ∩ resolved-target), check `write()`
backpressure per subscriber into a bounded per-client queue, flush on drain,
EVICT a slow subscriber via `destroy()` (never `end()`). Reap loop on
MONOTONIC time (not Date.now): two-threshold (warn ~60s / evict ~90s after
consecutive misses), heartbeat ~30s, duplicate-watcher guard for the same
identity with stale takeover (emit `bus`-namespace lifecycle events). Shutdown
handler releases socket + lock + both DB connections within the deadline;
`fatalExit` ONLY on boot failures (bind/db-open) — runtime handling never
throws to the top (drop+log malformed frames, evict broken peers).

### Investigation targets

**Required** (read before coding):
- src/daemon.ts:1133-1148 (WorkerName), :1155-1171 (ALL_WORKERS; pinned by test/daemon.test.ts:25), :1178-1185 (WATCHER_WORKERS — do NOT add), :1234 (want gate), :3689-3709 (renamer spawn site template), :3735-3743 (fatalExit), :3790-3843 (shutdown sequencing)
- src/renamer-worker.ts (whole file — worker contract template; :300-369 main/openDb/shutdown, :240-249 runQuery seam, :373-375 isMainThread guard)
- src/server-worker.ts:2492-2583 (Bun.listen handler block), :717-763 (ConnState), :1806-1886 (writeFrames/resumePending/flush backpressure), :769-823 (acquireLock/LockHeldError), :920 (peerPidForFd), :2480/2585-2588 (unlink + chmod 0600)
- src/protocol.ts:403 (LineBuffer — import for framing, NOT the frame union)
- src/wake-worker.ts:84 (watchLoop — only if a data_version trigger is needed; the bus is socket-driven, so likely not)

**Optional** (reference as needed):
- ~/code/arthack/apps/chatctl/chatctl/run_run_server.py (Registry.register dedup/takeover, relay_loop, reaper_loop, lifecycle publish)
- cli/control-rpc.ts:40 (roundTrip — the client side, built in T3)

### Risks

- Shared crash fate: a bus-worker fatalExit bounces the whole daemon. Mitigation is the discipline above (only boot failures fatal). The documented fallback if this proves untenable is the sibling-daemon mode (epic Early proof point).
- Backpressure correctness: never await drain before the next subscriber (head-of-line blocking); bound queues by length; evict with destroy() not end().
- Socket/lock leak on shutdown blocks the next boot's bind — release in the worker's own shutdown handler.
- pid-reuse / takeover: registration + routing + reap must all key on (pid, start_time); a stale takeover must not let the old watcher tear down the replacement.

### Test notes

Fast tier: pure decision fns (fan-out target selection, backpressure
eviction decision, reap predicate on monotonic clock, from-overwrite) via
freshMemDb — no worker spawn (mirror test/renamer-worker.test.ts:8-10).
Full tier: boot the worker (in-process DaemonHandle or direct), connect two
clients over the sandboxed bus.sock, register → publish → assert fan-out,
assert a former-name target resolves (end-to-end dead-name proof), assert a
slow subscriber is evicted, assert reap drops a silent channel, assert
shutdown releases socket+lock. Use retryUntil (never sleep). This file lands
in the full tier; test:full is mandatory.

## Acceptance

- [ ] `"bus"` is in WorkerName + ALL_WORKERS (test/daemon.test.ts pin updated), NOT in WATCHER_WORKERS; boots under keeperd with the renamer-style spawn/teardown
- [ ] UDS server binds with lock-before-bind + stale reclaim, chmod 0600, NDJSON framing with a max-frame guard
- [ ] register/heartbeat/subscribe/publish/list/resolve/deregister all work; subscribe ACK carries the replay cursor
- [ ] Fan-out routes on (namespace, resolved-target); a former-name target resolves end-to-end; broadcast reaches all live subscribers
- [ ] A slow/dead subscriber is evicted via a bounded per-client queue without blocking the relay; the server overwrites `from` from the peer pid
- [ ] Reap uses monotonic time with the two-threshold rule; duplicate-watcher guard + stale takeover work; shutdown releases socket+lock+DBs; only boot failures fatalExit
- [ ] Full-tier integration test passes; `bun run test:full` green

## Done summary
Built the keystone Agent Bus worker: keeperd's 16th Worker running a UDS pub/sub relay over T1 storage+resolution, with lock-before-bind, 0600 socket, NDJSON max-frame guard, peer-pid anti-spoof from-overwrite, bounded-queue eviction, monotonic two-threshold reap, and (pid,start_time) takeover. Proven end-to-end (directed send, broadcast, dead-name resolution, anti-spoof, shutdown release) by a full-tier integration test; test:full green.
## Evidence

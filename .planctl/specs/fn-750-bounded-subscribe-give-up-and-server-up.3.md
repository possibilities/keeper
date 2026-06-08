## Description

**Size:** M
**Files:** src/readiness-client.ts, test/readiness-client.test.ts, scripts/ (new bounce-soak harness)

### Approach

Reproduce, localize, then fix the ~2GB memory growth in the subscribe
client's reconnect/snapshot path — the leak that turned a stuck `keeper
await` into a 2.16GB runaway over ~4h. Static analysis this session ruled
OUT: in-process re-fold (the `re-folding event log` line is the TUI-only
refold-progress poller, never loaded by `keeper await`); reconnect-chain
accumulation (the `close` handler spawns exactly one fresh
`connectWithRetry`, the original loop returns — one live chain);
per-collection map growth (`teardownConnection` clears
byId/order/rows/lastSeenVersion every disconnect); and await-runner
retention (fixed slots, only the newest snapshot held). The leak therefore
needs RUNTIME evidence: build a bounce-soak harness that runs a subscribe
client against a daemon (or mock socket) bounced in a tight loop, sampling
`process.memoryUsage().rss` across N cycles, and take a heap snapshot to
localize the retention. Lead suspect: sockets are never explicitly
destroyed on teardown (`teardownConnection` nulls `currentSock` but never
`sock.destroy()`s it), so on a flapping daemon thousands of Bun sockets +
native read buffers accumulate faster than GC reclaims (native buffers are
invisible to the JS heap). Fix likely starts with explicit socket destroy
on teardown plus auditing snapshot/closure retention, validated by the
harness showing FLAT RSS across many bounces. Land after `.1` so the
give-up clean-exit anchors the harness and the socket/teardown edits don't
collide.

### Investigation targets

**Required** (read before coding):
- src/readiness-client.ts:975-996 `teardownConnection` — nulls `currentSock` (:980) WITHOUT `sock.destroy()`; the lead-suspect fix site
- src/readiness-client.ts:998-1061 `connectOnce` — per-connection socket + `LineBuffer` lifecycle (buffer is correctly per-connection; do NOT hoist it across reconnects)
- src/readiness-client.ts:1043-1056 `close` handler — teardown + respawn `connectWithRetry`; confirm the old socket is fully released
- src/readiness-client.ts:840-970 `handleFrame` / `result` merge — the snapshot rebuild path driven by the 500ms steady-poll; audit for retained frames/closures
- test/readiness-client.test.ts:94-146 `makeMockConnect` — drive the bounce loop (open → deliver → closeFromServer, repeated)
- recent soak/load harness precedent: `scripts/serve-fold-load` (fn-744) and fn-747's soak harness — mirror the RSS-sampling + bounce-loop structure and the opt-in/bounded run discipline

**Optional** (reference as needed):
- Bun heap-snapshot API + `process.memoryUsage().rss` sampling

### Risks

- The leak may live in Bun's native socket layer rather than JS — if explicit `destroy()` doesn't flatten RSS, the fix may need a different release path or a Bun-version note. The harness is the arbiter, not intuition.
- A multi-minute RSS soak does not belong in the default test tier — make the harness bounded / opt-in / manual (coordinate with fn-747's slow-tier work; possible `scripts/` overlap).
- Edits the same `teardownConnection`/socket code as `.1` — hence `deps: [.1]` to serialize.

### Test notes

- Repro FIRST: the harness shows monotonic RSS growth across N bounces on the pre-fix code (capture the failing baseline before touching the fix).
- After fix: RSS stays flat (within a stated bound) across the same N bounces.
- Existing readiness-client tests stay green; the happy-path steady subscribe is behavior-unchanged.

### Detailed phases

1. Build the bounce-soak harness (mock-socket or sandboxed daemon; sample RSS per cycle; configurable N; bounded/opt-in).
2. Reproduce: confirm monotonic RSS growth on current code; capture a heap snapshot at the high-water mark to name the retained objects.
3. Localize: identify the dominant retained allocation (lead hypothesis: undestroyed sockets / native read buffers).
4. Fix: explicit socket destroy on teardown + any snapshot/closure retention found; re-run the harness → flat RSS.
5. Document the root cause in a code comment and the task Evidence.

## Acceptance

- [ ] a bounce-soak harness reproduces monotonic RSS growth against the pre-fix subscribe client (failing baseline captured)
- [ ] root cause localized via heap snapshot and documented (the named retained allocation)
- [ ] fix lands; the harness shows FLAT RSS across N bounces (within a stated bound)
- [ ] happy-path steady subscribe behavior unchanged; existing readiness-client tests stay green
- [ ] the harness is bounded / opt-in so it does not bloat the default test tier

## Done summary

## Evidence

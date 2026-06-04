## Description

**Size:** M
**Files:** src/server-worker.ts, test/server-worker.test.ts, src/protocol.ts (MetaFrame docstring), README.md

Lever 1. The server's `diffTick` meta pass fans a `meta{total,token}`
frame to all ~21 board subscribers every time the subagent set's
total/membership token moves — which is every fold. Each meta drives a
full client refetch. Coalesce the meta EMISSION so rapid folds collapse
into fewer nudge rounds, without ever delaying a `patch` (the
correctness-critical cell stream) and without losing the final state.

### Approach

Add a per-`SubState` min-interval throttle on the meta pass
(`server-worker.ts:1645-1709`). Store `lastMetaEmittedAt` on `SubState`
(next to `lastTotal`/`lastToken`) and a new named const
`META_MIN_INTERVAL_MS`. When the meta pass detects a total/token move,
only `writeFrames(...meta)` (~:1696) if `Date.now() - lastMetaEmittedAt >=
META_MIN_INTERVAL_MS`; otherwise defer. CRITICAL convergence rule: do NOT
advance `lastTotal`/`lastToken` (or `lastMetaEmittedAt`) when a meta is
throttled away — only advance them on an actual emit. That way the
membership delta persists and the next eligible `diffTick` (kick or poll
tick) emits it; the server `pollLoop` is the convergence safety tick. The
throttle lives on `SubState` because BOTH `handleKick` (:1816) and
`pollLoop` (:1765) call `diffTick` — a `diffTick`-local clock would split.
Gate ONLY the meta pass; the patch pass stays immediate. `Date.now()` is
fine (server-worker is read/serve path, not a fold). Update the
`MetaFrame` docstring (src/protocol.ts) to note nudges may be coalesced.

### Investigation targets

**Required** (read before coding):
- src/server-worker.ts:1645-1709 — meta pass: filter-signature grouping + countAndToken + writeFrames
- src/server-worker.ts:357-364 — `SubState` (lastTotal/lastToken live here; add lastMetaEmittedAt)
- src/server-worker.ts:1492-1644 — diffTick patch pass (must stay immediate — do NOT throttle)
- src/server-worker.ts:1765, :1816 — pollLoop + handleKick both call diffTick (throttle state must persist across both)
- src/protocol.ts:198-204 — MetaFrame docstring to update
- test/server-worker.test.ts:1358 — fakeSock harness + subWith/baseline; existing no-double-send/kick-idempotency tests are the template

**Optional** (reference as needed):
- src/daemon.ts:1411 — the post-fold kick that drives diffTick per pump
- src/collections.ts:1026-1046 — countAndToken (the total/token source; unchanged)

### Risks

- **Lost-final-update**: if `lastTotal`/`lastToken` advance on a throttled (non-emitted) meta, the delta is lost forever — they must advance ONLY on emit. This is the load-bearing invariant.
- Throttling the patch pass by accident would delay cell updates — gate the meta pass exclusively.
- A `diffTick`-local throttle clock would let kick and poll see independent windows — keep it on `SubState`.
- The kick branch is in the no-self-heal path — keep the meta-throttle logic inside the existing diffTick try/catch discipline (never throw).

### Test notes

Extend the fakeSock harness: drive several total/token moves within
`META_MIN_INTERVAL_MS` and assert exactly ONE meta is emitted, THEN assert
a final move after the interval (or a pollLoop convergence tick) DOES emit
the latest state (convergence, no lost-final-update). Assert the patch pass
is unaffected by the throttle. Validate end-to-end with bench-latency +
KEEPER_TRACE_SERVER under several open boards.

## Acceptance

- [ ] meta emission throttled per-`SubState` via `META_MIN_INTERVAL_MS`; rapid total/token moves within the interval emit ONE meta
- [ ] `lastTotal`/`lastToken`/`lastMetaEmittedAt` advance ONLY on an actual emit, so the final state always converges (test proves no lost-final-update)
- [ ] patch pass is never throttled (test asserts patches still emit immediately)
- [ ] throttle state persists across handleKick + pollLoop (lives on SubState)
- [ ] MetaFrame docstring (+ README meta-nudge prose if affected) updated; full suite green
- [ ] bench-latency + KEEPER_TRACE_SERVER show fewer/shorter sleep-overrun clusters (record in Evidence)

## Done summary

## Evidence

## Description

**Size:** M
**Files:** src/readiness-client.ts, test/readiness-client.test.ts

### Approach

Add an optional give-up policy to `MultiOptions` (forwarded unchanged by
`subscribeReadiness` / `subscribeCollection`), threaded into the single
`subscribeMulti` driver. Maintain a continuous-unpainted wall-clock
anchor: arm it from subscribe start (never-painted case) and re-arm on any
drop after a paint; CLEAR it on FIRST PAINT (first `result` frame), NOT on
socket `open` — a half-up daemon that accepts the connection but never
serves must still give up. Check the deadline at the top of each
`connectWithRetry` backoff iteration; when `now() - anchor >= deadlineMs`,
replicate the existing terminal-error ordering (set `shuttingDown`,
`teardownConnection()`, THEN `onFatal`) with a `FatalError` whose
`code` is `"unreachable"`. Inject a `now()` clock dep (default `Date.now`)
so the fake-timer test harness can drive the deadline. Default (no policy)
= reconnect-forever, so `cli/board.ts` and every other current caller are
untouched. Any new timer must be cancellable from `dispose()`; never
accumulate timers across reconnects.

### Investigation targets

**Required** (read before coding):
- src/readiness-client.ts:1063-1096 `connectWithRetry` — the uncapped backoff loop; the deadline check lives here
- src/readiness-client.ts:998-1019 `connectOnce` open handler — resets `attempt`; the anchor must clear on first-paint, NOT here
- src/readiness-client.ts:933-971 terminal-error→onFatal path — replicate teardown-before-onFatal ordering and exception propagation
- src/readiness-client.ts:207-211 `FatalError` — `code` is a free string; use `code:"unreachable"` (no new union member)
- src/readiness-client.ts:614 `MultiOptions` and the public option interfaces (~:1173, ~:1274) — add optional `giveUpPolicy` + `now()` clock, forwarded by both helpers
- src/readiness-client.ts:1102-1132 `dispose()` timer-leak contract — cancel the give-up timer there
- the first-paint detection site (first `result` frame / `gotResult`) — the anchor-clear hook
- test/readiness-client.test.ts:471-566 capped-backoff test — the direct template; INVERT its "onFatal must not fire" assertion for the give-up test
- test/readiness-client.test.ts:94-146 `makeMockConnect` — reject to simulate an unreachable socket

**Optional** (reference as needed):
- src/readiness-client.ts:734-767 `pollAll` — note `pollTimer` is cleared on teardown, so the clock cannot live here
- cli/board.ts:890 — the canonical opt-OUT caller; confirm "default off" needs zero edits there

### Risks

- The fake-timer harness fast-forwards `setTimeout` synchronously without advancing `Date.now()`, so a `Date.now()`-measured deadline never trips in tests — MUST use the injected `now()` clock (this is the epic's early proof point).
- Anchoring on socket-`open` instead of first-paint would let a half-up/wedged-reducer daemon dodge give-up forever — key it on first-paint deliberately.

### Test notes

- New: continuously-unpainted for the deadline → `onFatal` fires exactly once with `code:"unreachable"`, after teardown (invert the existing no-fire assertion).
- New: a successful first-paint resets the clock; a later drop re-arms it (the post-bounce window is fresh).
- Regression: with no policy, the existing `[250,500,1000,2000,4000,5000,5000]` backoff sequence and no-onFatal assertion still hold (board unaffected).

## Acceptance

- [ ] `giveUpPolicy` is optional on the public helpers; absent → reconnect-forever (board/TUI unchanged, zero edits)
- [ ] continuously-unpainted >= deadline → `onFatal({code:"unreachable"})` once, after `teardownConnection()`
- [ ] anchor clears on FIRST PAINT, not socket-open (half-up daemon still gives up)
- [ ] bounds BOTH never-connected and was-connected-then-lost
- [ ] `dispose()` cancels the give-up timer; no timer accumulation across reconnects
- [ ] injected `now()` clock; deterministic under the fake-timer harness

## Done summary
Added opt-in bounded give-up to subscribeMulti: GiveUpPolicy{deadlineMs} + injectable now() clock on MultiOptions, forwarded by both public helpers (default off = reconnect-forever, board/TUI untouched). Continuous-unpainted anchor armed at subscribe start, cleared on FIRST PAINT, re-armed on post-paint drop; deadline checked at top of connectWithRetry loop plus a dispose-cancellable backstop timer for the half-up-daemon case; fires onFatal({code:'unreachable'}) once after teardownConnection(). 3 new deterministic tests under the injected clock.
## Evidence

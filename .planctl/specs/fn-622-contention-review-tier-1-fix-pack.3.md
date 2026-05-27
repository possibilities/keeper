## Description

**Size:** S
**Files:** `src/readiness-client.ts`

### Approach

Add two new fields to `CollectionState`: `queryInFlightSince: number | null` (the `Date.now()` stamp when `queryInFlight` last became `true`) and `lastSlowFlightAt: number | null` (single-fire latch — `null` means "no slow-flight emitted yet for the current stuck window"; non-null means "already emitted once, suppress further emissions until the state clears").

In `scheduleRefetchFor` (`src/readiness-client.ts:422-432`), when transitioning `queryInFlight` to `true`, ALSO stamp `queryInFlightSince = Date.now()` and reset `lastSlowFlightAt = null`. In `handleFrame`'s `result` branch (`:440-464`), when clearing `queryInFlight`, ALSO clear both new fields to `null`.

In `teardownConnection` (`:512-526`), add `queryInFlightSince = null` and `lastSlowFlightAt = null` to the existing reset block alongside `queryInFlight`, `refetchDirty`, `gotResult`, etc. — guarantees a fresh start after reconnect.

In the existing `pollAll` function (already fires every `POLL_MS = 500` ms via the open-handler's `setInterval`), walk every state. For each `state` with `state.queryInFlight && state.queryInFlightSince !== null`, compute `age = Date.now() - state.queryInFlightSince`:

- `age >= QUERY_TIMEOUT_MS` (5000): call `triggerReconnect("query_timeout", state)` — see below — and `return` (single-flight; one reconnect tears down all states).
- else `age >= SLOW_FLIGHT_MS` (1000) AND `state.lastSlowFlightAt === null`: emit `query_slow_flight` lifecycle event `{collection: state.collection, query_id: state.subId, sock: sockPath, age_ms: age}`, set `state.lastSlowFlightAt = Date.now()` to suppress further fires.

After the timeout check (and before `scheduleRefetchFor`), the existing `scheduleRefetchFor` loop continues unchanged.

Define `triggerReconnect(reason, state)` as a top-level helper (peer to `pollAll`): emit lifecycle event `query_timeout {collection: state.collection, query_id: state.subId, sock: sockPath, age_ms: ...}`, then `teardownConnection()`, then `currentSock?.end()`. The existing `close` handler (`:567-574`) invokes `connectWithRetry()`, and the existing `connectOnce` open handler (`:528-579`) reissues every state's initial query and stamps each `queryInFlight = true` + `queryInFlightSince = Date.now()` — no new plumbing.

Single-flight guard: add a module-scope `let reconnecting = false;` (peer of `shuttingDown`). `triggerReconnect` checks `if (reconnecting || shuttingDown) return;` then sets `reconnecting = true;`. The `connectOnce` open handler clears `reconnecting = false` (alongside its existing `attempt = 0` reset). The `close` handler clears it too. Two simultaneously-stuck collections produce one reconnect, not two.

New named constants near the existing `POLL_MS`, `INITIAL_BACKOFF_MS`, `MAX_BACKOFF_MS` (`:93-95`):
```ts
const SLOW_FLIGHT_MS = 1000;
const QUERY_TIMEOUT_MS = 5000;
```

Update the lifecycle docstring (`:172-179`) to add `query_slow_flight` and `query_timeout` to the event taxonomy.

### Investigation targets

**Required** (read before coding):
- `src/readiness-client.ts:93-95` — `POLL_MS`, `INITIAL_BACKOFF_MS`, `MAX_BACKOFF_MS` constants block to extend
- `src/readiness-client.ts:172-179` — lifecycle event docstring to update with the two new event names
- `src/readiness-client.ts:157-160` — `ConnectFactory` test injection point
- `src/readiness-client.ts:422-432` — `scheduleRefetchFor`; the stamp-on-send site
- `src/readiness-client.ts:440-464` — `handleFrame` result branch; the clear-on-result site
- `src/readiness-client.ts:512-526` — `teardownConnection`; the reconnect-reset block to extend
- `src/readiness-client.ts:528-579` — `connectOnce` open handler; reissues queries on reconnect (already handles state reset)
- `src/readiness-client.ts:567-574` — `close` handler; calls `connectWithRetry()`
- `src/readiness-client.ts:581-614` — `connectWithRetry`; existing capped-exponential-backoff reconnect

**Optional** (reference as needed):
- `test/readiness-client.test.ts:437` — existing reconnect-backoff test pattern via `ConnectFactory` rejection — same lever for the 5 s deadline path

### Risks

- **False-positive `query_timeout` after a graceful network close.** Mitigated: `close` handler clears `reconnecting` AND `teardownConnection` clears all `queryInFlightSince` fields. The next poll sees all `queryInFlightSince === null` and skips the timeout check.
- **Double-reconnect on near-simultaneous timeouts.** Mitigated by `reconnecting` single-flight bool.
- **Stuck `lastSlowFlightAt` survives reconnect.** Mitigated by explicit clear in `teardownConnection`.
- **`Date.now()` vs `performance.now()`** — using `Date.now()` here is correct because the values are compared against wall-clock thresholds (1 s, 5 s) and don't need sub-ms precision. `performance.now()` would be sub-ms but wouldn't survive across process restarts (irrelevant — readiness-client is in-process).

### Test notes

Existing test patterns in `test/readiness-client.test.ts` use the `ConnectFactory` injection plus `bun:test` `mock.timers` (or equivalent fake-timer mechanism). New tests:

- **Path A (<1 s):** Send query, mock `result` frame arrives at t=500 ms. Confirm zero `query_slow_flight` events, zero `query_timeout` events.
- **Path B (1–5 s):** Send query, no `result` arrives. Advance fake timer to t=1000 ms + epsilon. Confirm exactly one `query_slow_flight` lifecycle event. Advance to t=2500 ms; confirm NO additional `query_slow_flight` events (latch holds). Advance to t=5000 ms + epsilon; confirm exactly one `query_timeout` lifecycle event AND a reconnect attempt fires.
- **Path C (reconnect clears state):** After Path B's reconnect, send a fresh query at the new socket; confirm `queryInFlightSince` re-stamps and the slow-flight latch resets.
- **Single-flight:** Two collections both stuck; advance timer past 5 s. Confirm exactly one `query_timeout` event (named after the FIRST collection to cross the threshold), exactly one reconnect.

## Acceptance

- [ ] `CollectionState` gains `queryInFlightSince: number | null` and `lastSlowFlightAt: number | null`
- [ ] `scheduleRefetchFor` stamps `queryInFlightSince` on send; `handleFrame` clears both new fields on `result`
- [ ] `teardownConnection` clears both new fields alongside existing reset block
- [ ] `pollAll` emits `query_slow_flight` exactly once per stuck window (1 s threshold, `lastSlowFlightAt` latch)
- [ ] `pollAll` calls `triggerReconnect` at 5 s; `triggerReconnect` emits `query_timeout` then `teardownConnection` + `currentSock?.end()`
- [ ] Module-scope `reconnecting` bool guards against concurrent reconnects from multiple stuck collections
- [ ] `SLOW_FLIGHT_MS = 1000` and `QUERY_TIMEOUT_MS = 5000` constants live next to `POLL_MS`
- [ ] Lifecycle event taxonomy docstring updated
- [ ] Tests cover Path A (<1 s), Path B (1–5 s), Path C (reconnect clears state), single-flight
- [ ] `bun test` green

## Done summary

## Evidence

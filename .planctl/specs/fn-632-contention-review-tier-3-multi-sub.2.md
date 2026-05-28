## Description

**Size:** S
**Files:** `src/readiness-client.ts`, `test/readiness-client.test.ts`, `README.md`

### Approach

Two coupled changes that land together:

**Step 1 — Id-based routing in `handleFrame`** (`src/readiness-client.ts:564-638`):

Today's patch/meta dispatch at lines 593-597:
```ts
} else if (frame.type === "patch" || frame.type === "meta") {
  const state = byCollection.get(frame.collection);
  if (state) scheduleRefetchFor(state);
}
```

Build a `bySubId: Map<string, CollectionState>` alongside the existing `byCollection` Map (the existing line 453 creates `byCollection`; add a parallel `bySubId = new Map(states.map(s => [s.subId, s]))`).

Update the dispatch to id-first, collection-fallback:
```ts
} else if (frame.type === "patch" || frame.type === "meta") {
  // Id-first routing: prefer frame.id (multi-sub server),
  // fall back to frame.collection (legacy single-sub server).
  const state = (frame.id !== undefined ? bySubId.get(frame.id) : undefined)
    ?? byCollection.get(frame.collection);
  if (state) scheduleRefetchFor(state);
}
```

Apply the SAME id-first lookup pattern to the `result` branch at lines 565-592 (which currently keys on `frame.collection`) — result already carries `id`, so the routing fix is uniform across result/patch/meta. This makes the multi-sub semantics work for every frame type.

**Step 2 — Drop the 500ms refetch backstop in `pollAll`** (`src/readiness-client.ts:533-562`):

Today's `pollAll`:
```ts
function pollAll(): void {
  // First pass: slow-flight age check (Tier 1 — keep)
  for (const s of states) {
    if (s.queryInFlight && s.queryInFlightSince !== null) { ... }
  }
  // Second pass: per-state refetch (workaround for F3 single-sub bug — REMOVE)
  for (const s of states) {
    scheduleRefetchFor(s);
  }
}
```

Remove the second pass entirely. `scheduleRefetchFor` continues to be called from `handleFrame` on patch/meta arrival — that's the legitimate "server signaled a change, fetch fresh page" path.

**Step 3 — README revision** (~lines 676-686 readiness-client paragraph):

Drop reference to the 500ms full-refetch backstop. Note that patch/meta routing is now by subscription `id` (with collection fallback for legacy servers). Match existing dense-prose style.

### Investigation targets

**Required** (read before coding):
- `src/readiness-client.ts:263-315` — CollectionState (has `subId: string` at line 265 — 1:1 client/server sub mapping already in place)
- `src/readiness-client.ts:443-739` — subscribeMulti driver
- `src/readiness-client.ts:453` — `byCollection` Map construction (add parallel `bySubId`)
- `src/readiness-client.ts:564-638` — `handleFrame` (THE function being updated)
- `src/readiness-client.ts:565-592` — result branch routing (apply same id-first fix)
- `src/readiness-client.ts:593-597` — patch/meta dispatch (THE main routing fix)
- `src/readiness-client.ts:478-493` — `scheduleRefetchFor` (stays unchanged; remains called from handleFrame)
- `src/readiness-client.ts:533-562` — `pollAll` (first-pass slow-flight detection STAYS; second-pass refetch REMOVED at lines 559-561)
- `src/readiness-client.ts:97, 113, 114` — POLL_MS / SLOW_FLIGHT_MS / QUERY_TIMEOUT_MS constants (unchanged)
- `src/readiness-client.ts:640-660` — teardownConnection (already iterates states; unchanged)
- `src/readiness-client.ts:662-725` — connectOnce open handler (already sends queries with subIds; unchanged)
- `src/readiness-client.ts:942-1080` — subscribeReadiness (constructs states with sub-ids; verify subIds are stable constants and survive reconnect — they ARE: `${idPrefix}-epics`, etc.)
- `test/readiness-client.test.ts:63-105` — MockSocket + connectMock factory
- `test/readiness-client.test.ts` — audit existing tests for any reliance on the 500ms periodic refetch as the convergence mechanism
- `README.md` ~lines 676-686 — readiness-client paragraph to revise

**Optional** (reference as needed):
- The new server-side integration test from Task A — confirms the convergence path Task B relies on
- Tier 1's slow-flight implementation (fn-622) — confirms pollAll's first pass stays intact

### Risks

- **Removing the 500ms refetch changes failure modes**: today's behavior was "data eventually stale → next poll refetches → recovers". Post-Task-A, real-time patches drive freshness; pollAll only detects slow-flight (1s warning) and timeout (5s reconnect). Audit existing tests for any that lean on the periodic refetch as the convergence mechanism rather than the patch path.
- **Legacy server compat**: new client + old server (no `id` echoed in patch/meta) → client falls back to `byCollection.get(frame.collection)`. Tested in test (c) below.
- **Multi-collection id collisions**: subscribeReadiness uses `${idPrefix}-<collection>` format — guaranteed unique per state. Other consumers (none today) would need to use unique ids per sub.
- **Reconnect preserves subIds**: subscribeReadiness's state construction is one-shot at the top; subIds like `${idPrefix}-epics` are constants. Reconnect re-issues queries via `connectOnce`'s open handler with the SAME subIds — server sees the same sub ids and rebuilds the same subs. Verify with test (c).
- **The bySubId Map needs to be rebuilt on state list changes**: but states is also constructed once at the top of subscribeReadiness; immutable for the lifetime of the helper. No rebuild needed.

### Test notes

**New client tests** in `test/readiness-client.test.ts`:

1. **Id-first routing**: send query (id="A", collection="epics"). Server responds with `result{id: "A", collection: "epics", ...}`. Then server emits `patch{id: "A", collection: "epics", row}` (multi-sub server). Assert: routed correctly to the "A" state; `scheduleRefetchFor` called once on the A state.
2. **Collection fallback for legacy server**: send query (id="A", collection="epics"). Server (legacy) responds with `result{collection: "epics", ...}` (NO id echo) and emits `patch{collection: "epics", row}` (NO id). Assert: routed via byCollection lookup; A state still gets refetch. (This proves the fallback chain works for old servers.)
3. **Reconnect preserves subIds**: subscribeReadiness → connect → send queries → server stores subs by id. Inject a connection close. subscribeReadiness reconnects. Assert: the re-issued queries carry the SAME subIds (`${idPrefix}-epics`, etc.) — verifiable by inspecting captured outbound frames.
4. **500ms refetch removal doesn't regress liveness**: subscribeReadiness with three states. Server emits patches for all three (via mocked server simulation). Assert: no `scheduleRefetchFor` is called from `pollAll`'s second pass (which no longer exists). All freshness comes from patch-driven `scheduleRefetchFor` in handleFrame.
5. **Slow-flight detection still fires**: per Tier 1's behavior — queryInFlight + queryInFlightSince > 1s → `query_slow_flight` lifecycle event. > 5s → `query_timeout` → reconnect. Verify Tier 1 tests still pass; the first pass in pollAll is unchanged.

**Audit existing tests**: any test in `test/readiness-client.test.ts` that asserts "after N ms, expect another query was sent" and where N matches POLL_MS (500) or a multiple — those tests were exercising the second-pass refetch. Either convert them to assert "no query sent in absence of a patch arrival" (the new behavior) or remove them as obsolete.

## Acceptance

- [ ] `bySubId` Map constructed in subscribeMulti driver alongside existing `byCollection`.
- [ ] `handleFrame` patch/meta dispatch uses id-first lookup, falls back to collection lookup. Result branch updated to the same pattern.
- [ ] `pollAll`'s second-pass per-state refetch (lines 559-561) REMOVED. First-pass slow-flight check (538-557) UNCHANGED.
- [ ] `scheduleRefetchFor` continues to be called from `handleFrame` on patch/meta arrival — patch-driven freshness path.
- [ ] Five new client tests cover: id-first routing, collection fallback for legacy server, reconnect preserves subIds, 500ms refetch removal doesn't regress liveness, slow-flight detection still fires.
- [ ] Existing client tests audited: tests relying on 500ms periodic refetch either removed or converted to patch-driven assertions.
- [ ] README.md §readiness-client (~lines 676-686) revised in place: drop 500ms refetch reference; note patch/meta routed by subscription id with collection fallback.
- [ ] EVIDENCE: with `KEEPER_TRACE_SERVER=1` enabled and both board.ts + autopilot.ts running, capture server.stderr `[srv-ts] diffTick` lines showing patch fanout to multiple (conn, sub) pairs — proves the F3 fix is live end-to-end. Include actual log excerpts in `## Evidence`.
- [ ] `bun test` green.

## Done summary

## Evidence

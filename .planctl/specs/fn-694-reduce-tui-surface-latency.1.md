## Description

**Size:** M
**Files:** src/readiness-client.ts, test/readiness-client.test.ts

Lever A1. Make `subscribeCollection` (jobs/git/usage sidecars) render the
server's `patch` row directly instead of treating every patch/meta as a
"data changed, refetch" nudge. The `patch` frame already carries the full
updated row (`src/protocol.ts:174`), so the refetch round-trip — which
competes with the server poll loop and loses to the 500ms steady-poll
backstop (`POLL_MS=500`, ~:127) — is pure waste. Scope is sidecars ONLY;
the board's `subscribeReadiness` is deliberately left on its current path
(deferred, separate effort).

### Approach

In `handleFrame` (~:715-728), split the currently-identical patch/meta
branch: `patch` → merge `frame.row` into the subscription state and fire
`onResult` directly; `meta` → keep `scheduleRefetchFor` (membership change
is unmergeable from one row). Mirror the `result` branch's merge shape
(~:674-714): upsert into `byId`, append to `order` if new, replace the
matching `rows` entry. Fix the empty-`pk` footgun: `subscribeCollection`
currently builds state with `pk=""` (~:1013) — thread the descriptor's
real pk via `getCollection(opts.collection)?.pk` into `makeState` so the
merge keys correctly. Guard the merge on `state.gotResult` (drop a patch
that arrives before the initial page is seeded — e.g. mid-reconnect).
Add a lightweight per-`(collection, pk)` version guard reading the
descriptor's version column (`last_event_id`; `dl_written_at` for
dead_letters) and drop any patch whose version isn't strictly newer.
`onRows` must continue to hand back a fresh array copy (consumers retain
the slice — see ~:1020), so a copy-out is preserved after the in-place
merge.

### Investigation targets

**Required** (read before coding):
- src/readiness-client.ts:674-714 — `result` branch; the canonical merge shape to mirror
- src/readiness-client.ts:715-728 — patch/meta branch to split
- src/readiness-client.ts:994-1030 — `subscribeCollection`; the empty-`pk` construction at :1013 and the `onRows(s.rows)` handoff
- src/protocol.ts:157-204 — ResultFrame / PatchFrame / MetaFrame shapes (PatchFrame carries `row`)
- src/collections.ts — per-descriptor `pk` and `version` column (jobs/git/usage: `last_event_id`; dead_letters: `dl_written_at`)
- test/readiness-client.test.ts — mock socket (`makeMockConnect`), `patchFrame`/`metaFrameWithId` helpers (current patch row is `{epic_id:"irrelevant"}` — extend to carry a real versioned row)

**Optional** (reference as needed):
- src/readiness-client.ts:360 — `projectRows` (reuse, don't reinline)
- src/readiness-client.ts:584 — `scheduleRefetchFor` (keep for `meta`)

### Risks

- The merge target must match what `onRows` reads (the `rows` array, in wire/page order) — a byId-only upsert would not surface.
- A patch for a row outside the current page/sort/limit should not appear; the server only watches in-page ids, but the merge should respect page membership rather than blindly append.
- The version guard must be keyed `(collection, pk)`, not a single global cursor — `last_event_id` is shared across collections, so a global guard would let one collection's patch suppress another's.

### Test notes

Extend the `patchFrame` helper to carry a real versioned row. Assert:
(1) a patch renders via `onRows` with the merged row and triggers NO
refetch query (inverts the current "patch triggers one refetch" assertion
~:1018); (2) a `meta` still triggers a refetch; (3) a stale/equal-version
patch is dropped; (4) a patch before the first `result` is dropped
(gotResult guard). Validate end-to-end with
`bun scripts/bench-latency.ts --duration 30 --collections jobs` before and
after — jobs p50/p90 should drop.

## Acceptance

- [ ] `patch` frames merge the row and render via `onRows` with no refetch round-trip; `meta` frames still refetch
- [ ] `subscribeCollection` keys the merge on the descriptor's real pk (no empty-string pk)
- [ ] patch dropped when `!gotResult` (pre-seed / mid-reconnect) and when its version is not strictly newer (per-`(collection, pk)` guard)
- [ ] `onRows` still receives a fresh array copy
- [ ] new/updated tests in test/readiness-client.test.ts pass; full suite green
- [ ] bench-latency jobs p50/p90 measurably lower after the change (record numbers in Evidence)

## Done summary
Lever A1: subscribeCollection now direct-merges the server's patch row in place and renders via onRows with no refetch round-trip; meta still refetches. Threads the descriptor's real pk+version via getCollection, guards on gotResult + a per-(collection,pk) strictly-newer version cursor + page membership, and copies out a fresh array. bench-latency jobs p50 321->176ms (-45%), p90 406->356ms, min 230->33ms.
## Evidence

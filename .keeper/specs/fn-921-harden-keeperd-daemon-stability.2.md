## Description

**Size:** M
**Files:** src/server-worker.ts, src/collections.ts, src/readiness-client.ts, cli/board.ts (+ tests)

### Approach

Kill the server-worker CPU peg: the `subagent_invocations` live subscription
re-sends the entire ~1MB / 4967-row collection as a full `type:result` frame to
all 4 board/dash subscribers on ~every event (dtrace: 8 full results vs 4
patches in 2s, ~928 `sendto`/s).

Root cause is a meta→full-refetch amplification loop: `diffTick`'s membership
token is `group_concat(pk)` over the WHOLE unbounded, no-limit set
(`collections.ts:802`); any new subagent row changes it → the server emits a
`meta` frame → the client ALWAYS treats `meta` as "re-query" and refetches the
full collection (`readiness-client.ts:940-947`). The unbounded collection (4967
rows since 2026-05-19, never compacted) makes each refetch ~1MB.

1. **Bound the membership token (the actual CPU source), the result page, AND
   `COUNT(*)` together** so they agree — render's count/stuck indicator and the
   byId diff stay consistent. This is NOT a blind `LIMIT`: the
   `SUBAGENT_INVOCATIONS_DESCRIPTOR` comment (`collections.ts:356-372`) warns a
   naive row-filter/page breaks render's count/stuck + the byId diff (pk is
   `job_id`, which collapses to one row per job). Bound by recency such that the
   token recompute is small, the page is bounded, and the count reflects the
   bound consistently.
2. **Stop the unconditional full-refetch on `meta`** (`readiness-client.ts:722`,
   `:940-947`): converge membership incrementally (the `patch` direct-merge path
   at `:916-939` is the cheap analogue) or via a bounded refetch — never a full
   ~1MB re-page per membership change.
3. Preserve the convergence invariant (`server-worker.ts:2483-2492`): the meta
   baseline + throttle clock advance ONLY on an actual emit.
4. Optionally bound/compact the `subagent_invocations` table itself so the
   historical backlog stops inflating every recompute.

### Investigation targets

**Required** (read before coding):
- src/server-worker.ts:411-419 — `SubState` (lastTotal/lastToken/lastMetaEmittedAt)
- src/server-worker.ts:2455-2495 — the meta-emission block + the convergence invariant (:2483-2492)
- src/server-worker.ts:295-298 — `DEFAULT_LIMIT`/`MAX_LIMIT`/`clampLimit` (existing bounding primitives)
- src/collections.ts:354-376 — `SUBAGENT_INVOCATIONS_DESCRIPTOR` + the byId/count constraint comment
- src/collections.ts:802-816 — `countAndToken` (`group_concat(pk)` with no LIMIT — the unbounded token)
- src/readiness-client.ts:940-947 — `meta` → unconditional `scheduleRefetchFor` (the amplifier)
- src/readiness-client.ts:916-939 — `patch` direct-merge (the cheap convergence path)

**Optional** (reference as needed):
- cli/board.ts:625 — `subscribeReadiness` (9 collections; don't break the other 8)

### Risks

- A recency bound that drops older rows for the SAME `job_id` must keep the byId diff converging (render's per-job timeline).
- `COUNT(*)` must reflect the bound consistently with render's "N invocations" / stuck indicator.
- A recency `WHERE ts > …` is a live read (fine), but must not break the `version`/`last_event_id` re-seed or leak into a fold.

### Test notes

- Pure unit tests over the bounded `countAndToken` + the meta-emission decision; update existing `server-worker` / `collections` assertions. `bun run test:full`.

## Acceptance

- [ ] the `subagent_invocations` subscription no longer sends a full ~1MB result per event; the token recompute is bounded
- [ ] a `meta` membership change no longer triggers a full-collection client refetch
- [ ] render count / stuck / byId stay correct for the 4 board/dash subscribers
- [ ] the server-worker CPU peg is gone (dtrace shows no result-storm)
- [ ] `bun run test:full` green

## Done summary

## Evidence

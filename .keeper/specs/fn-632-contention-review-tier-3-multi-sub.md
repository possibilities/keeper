## Overview

Tier 3 epic 2 of the keeper contention review fix plan — F3 Option A. True multi-subscription per connection. Tier 1 (fn-622), Tier 2 (fn-628), and Tier 3 epic 1 (fn-631 diffTick version-probe) have all shipped. This is the second and final Tier 3 epic — finishes the F3 protocol shape the reviewer's Q2 prescribed.

The bug: today's `ConnState` has top-level slots (`collection`, `watched`, `lastSent`, `where`, `lastTotal`, `lastToken`) — exactly ONE active subscription per connection. Every `query` frame REPLACES all those slots at `src/server-worker.ts:755-765`. The `readiness-client` sends THREE queries on one socket (epics, jobs, subagent_invocations); only the LAST is the truly subscribed sub. `patch` and `meta` frames are keyed only on `collection`, not `id`. The client masks this with a 500ms steady-poll full-refetch backstop — which is what's hiding the bug AND inflating server load.

The wire protocol ALREADY carries `id` on `query`/`result`/`error`/`unsubscribe` frames (`src/protocol.ts:118-141, 154-161, 246-253`); the server already echoes `id` on result/error via `...(frame.id !== undefined ? { id: frame.id } : {})` at lines 486/561/881. The missing pieces: (1) `ConnState` isn't keyed by subId, (2) `patch`/`meta` frames don't carry `id`. Reviewer's Option A (Q2) prescription finishes the wire shape: `ConnState.subs: Map<subId, SubState>`, `id?: string` on patch/meta, dispatchLine + diffTick iterate per-sub.

Backpressure stays socket-level (`sock.pending` skips ALL subs together — matches today's per-conn skip). Wire change is strictly additive: old client + new server works (client ignores unknown `id`, routes by collection); new client + old server works (client falls back to collection routing). Migration is seamless in both directions.

## Quick commands

- `bun test test/server-worker.test.ts` — full server-worker suite green (multi-sub tests + integration test)
- `bun test test/readiness-client.test.ts` — client-routing suite green
- `bun test` — full project green
- `launchctl kickstart -k gui/$UID/arthack.keeperd` — restart daemon to pick up multi-sub
- `bun ./scripts/board.ts` and `bun scripts/autopilot.ts` (after both tasks ship) — manual verification that the live UI no longer relies on 500ms refetch (real-time patches drive freshness)

## Acceptance

- [ ] `src/protocol.ts` PatchFrame and MetaFrame gain `id?: string`; JSDoc + top-of-file block comment updated (no more "Mirrors `patch` in carrying no `id`"). Strictly additive — no breaking change.
- [ ] `src/server-worker.ts` ConnState refactored to `subs: Map<string | null, SubState>` where SubState carries `{collection, watched, lastSent, where, lastTotal, lastToken}`. Top-level keeps `subs`, `pending`, `buffer`, `id` (the debug counter).
- [ ] `null` is the sentinel sub-id for anonymous queries (no `frame.id`). One anonymous slot per conn (subsequent anonymous queries replace it — matches today's "one active subscription" semantic for legacy clients).
- [ ] `dispatchLine` query handler (at `src/server-worker.ts:718-767`): allocate/replace sub keyed by `frame.id ?? null`. Otherwise unchanged.
- [ ] `dispatchLine` unsubscribe handler (at `src/server-worker.ts:768-776`): with `frame.id` → delete just that sub (silent no-op if not found); without `id` → clear-all (preserves today's semantic + matches the documented protocol).
- [ ] `diffTick` (at `src/server-worker.ts:1066-1302`) iterates `(sock, subId, sub)` triples, groups by `sub.collection`, runs per-collection version-probe + conditional changed-rows fetch + per-sub patch fanout. Meta-pass byFilter signature stays `(collection, clause, params)`; fans one meta per matching sub at emit time. Backpressure skip `if (sock.data.pending) continue` stays socket-level.
- [ ] Patch and meta frames carry `id` when emitted on behalf of a sub with non-null `id` (conditional-spread pattern: `...(sub.id != null ? { id: sub.id } : {})`). Always carry `collection` for backward compat + debugging.
- [ ] Close handler at `src/server-worker.ts:1431-1443` simplifies to `socket.data.subs.clear(); socket.data.pending = null;`.
- [ ] `src/readiness-client.ts` `handleFrame` (lines 593-597) routes patch/meta by id-first (lookup in new `bySubId` map), falls back to collection lookup for legacy server.
- [ ] `src/readiness-client.ts` `pollAll` (lines 559-561) removes the per-state `scheduleRefetchFor` second pass. Keeps the first pass (538-557) for slow-flight detection. `scheduleRefetchFor` STILL fires from `handleFrame` on patch/meta arrival (legitimate "server signaled a change, refetch fresh page" path).
- [ ] 35+ `watch()` call sites in `test/server-worker.test.ts:1079-1099` continue passing — the helper gains a default `subId = null` param; existing tests unchanged.
- [ ] New server tests: (a) two subs same socket different collections get independent patches; (b) two subs same socket same collection different filters: `unionWatched` unions across subs; each gets its own meta; (c) `unsubscribe{id}` clears only the named sub; (d) `unsubscribe{}` clears all; (e) `unsubscribe{id: nonexistent}` is silent no-op; (f) socket backpressure skips ALL subs on that socket together — no lastSent/lastTotal advancement for any sub.
- [ ] New server integration test: mutate a row → assert ALL subscribed `(conn, sub)` pairs receive a patch within one `diffTick`. This is the convergence-replacement test for the 500ms refetch removal.
- [ ] New client tests: (a) patch{id} routes to bySubId state; (b) patch with absent id falls back to byCollection (legacy server compat); (c) reconnect re-issues queries with their original sub-ids preserved (`${idPrefix}-epics`, etc. — these are constants in subscribeReadiness).
- [ ] Existing client tests audited: tests that relied on the 500ms refetch as the convergence mechanism either removed or converted to rely on patch-driven refetch.
- [ ] README.md three sections revised in place: §architecture/§diffTick (~522-533); §UDS server (~514-533); §readiness-client (~676-686). Match existing dense-prose style — no bullet lists.
- [ ] ConnState's 24-line docstring at `src/server-worker.ts:186-213` REWRITTEN entirely (it explicitly claims "One active subscription per connection: a re-query fully REPLACES collection + watched + lastSent + where + lastTotal + lastToken" — that's the doc Option A inverts).
- [ ] `bun test` green.
- [ ] EVIDENCE: post-deploy, with both board.ts and autopilot.ts connected, capture server.stderr `[srv-ts] diffTick` lines showing patch fanout to multiple `(conn, sub)` pairs. Confirm via test that mutating an epics row produces a patch to BOTH the board's epics sub AND autopilot's epics sub if both are subscribed (the F3 fix the whole epic exists for).

## Early proof point

Task that proves the approach: `<epic>.1` (server multi-sub). Once Task A lands, the new server-side integration test ("mutate row → all (conn, sub) pairs receive patch within one tick") is the on-disk evidence that multi-sub fanout works end-to-end. Task B (`<epic>.2`) then flips the client to id-based routing AND removes the 500ms refetch — Task A's integration test continues to pass with the new client, proving end-to-end correctness. If Task A's integration test fails: investigate (a) whether diffTick's iteration shape correctly visits all (conn, sub) pairs, (b) whether `unionWatched` correctly unions across subs not socks, (c) whether the byFilter meta-pass correctly fans per-sub. If Task B's client tests fail post-Task-A: the routing fallback chain (`id → collection → drop`) is the most likely culprit — verify the bySubId map is correctly populated on query-send and cleared on result-receive.

## References

- `/Users/mike/docs/2026-05-27-keeper-syncing-api-daemon-contention-review.md` — F3 ("One-Subscription Server, Multi-Subscription Client") in the original Carmack-style audit
- `/Users/mike/docs/2026-05-27-keeper-review-followup-response.md` — Q2 ("Option A vs Option B for F3"); reviewer reverses the short-term recommendation toward Option A
- `fn-622-contention-review-tier-1-fix-pack` — Tier 1: srvTs gate, staged timing, slow-flight reconnect, OpenDbOptions.migrate (closed + approved)
- `fn-628-contention-review-tier-2-index-pack` — Tier 2: indexes + UNION rewrite + ANALYZE (closed + approved)
- `fn-631-contention-review-tier-3-difftick-probe` — Tier 3 epic 1: diffTick version-probe-first rewrite (closed + approved)

## Docs gaps

- **`src/protocol.ts`**: PatchFrame and MetaFrame gain `id?: string`. JSDoc on both updated to say "echoes the originating query's `id`, routing the patch/meta to the correct subscription on a multi-sub connection." Remove "Mirrors `patch` in carrying no `id`" from MetaFrame's JSDoc. Top-of-file block comment (~lines 14-47) updated to remove any "no id" language and note that patch/meta echo subscription ids.
- **`README.md` Architecture / diffTick prose ~lines 522-533**: currently describes grouping by collection. Revise to reflect grouping by `(conn, subId)` pairs, with the version-probe-first per-collection-group flow preserved from fn-631.
- **`README.md` Architecture / UDS server description ~lines 514-533**: currently implies one active subscription per connection ("the active subscription"). Revise to reflect ConnState.subs and the multi-sub semantic.
- **`README.md` Architecture / readiness-client paragraph ~lines 676-686**: drop reference to the 500ms full-refetch backstop. Note that patch/meta routing is now by subscription `id` (with collection fallback for legacy servers).
- **`src/server-worker.ts:186-213`**: 24-line ConnState docstring REWRITTEN (not patched) to describe the multi-sub shape.

## Best practices

- **`null` as Map key for the anonymous-sub sentinel.** Map keys accept arbitrary values; `null` reads tidily and only one anonymous sub per conn can exist (subsequent anonymous queries replace it — matches today's "one active sub" semantic for legacy clients). String sentinels like `"__legacy__"` collide with legitimate client ids; auto-minted counters create unaddressable subs.
- **Conditional-spread `...(sub.id != null ? { id: sub.id } : {})` on patch/meta emit.** Matches the existing echo pattern at server-worker.ts:486/561/881. Belt-and-braces against accidentally emitting `id: undefined` (which `JSON.stringify` would drop anyway, but the explicit conditional is more readable).
- **Backpressure stays socket-level, not per-sub.** The conn's outbound buffer is the resource being protected; per-sub `pending` would just create coordination overhead with no benefit. The existing `if (sock.data.pending) continue` works unchanged once iterating `(sock, sub)`.
- **Wire protocol additive evolution: optional fields only.** `id` on patch/meta is optional; old clients ignore unknown fields, old servers don't emit it. No version negotiation needed. Migration is seamless in both directions.
- **Idempotent unsubscribe** (`unsubscribe{id: nonexistent}` → silent no-op): matches HTTP DELETE 404-as-success precedent. Forgiving for clients that send `unsubscribe + close` near-simultaneously.
- **Drop the 500ms refetch backstop ENTIRELY in Task B.** Keeping it would mask any wiring bug in the new multi-sub fanout. Replace with a server-side integration test that proves the convergence path works. If a wiring bug exists, it's better to expose it loudly than hide it under the safety net.
- **`watch()` test helper: default subId = null param.** All 35+ existing call sites work unchanged (default-null preserves legacy anonymous-sub shape). New multi-sub tests pass explicit subId values. Lowest-churn refactor strategy.

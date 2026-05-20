## Description

**Size:** M
**Files:** src/protocol.ts, src/server-worker.ts, src/collections.ts, scripts/keeper-subscribe.ts, test/protocol.test.ts, test/server-worker.test.ts, test/integration.test.ts, CLAUDE.md, README.md

Add a live `total` count + a server-side membership-staleness signal to the read-only UDS subscribe server, so a paginated TUI can show "Showing X of N" and a non-disruptive "set changed, refresh" nudge. Frozen membership + live cells (the `query → result → patch` path) are UNCHANGED — this only ADDS a `total` field on `result` and a new `meta` server frame. Explicit non-goals (do NOT build): live insert/remove/reorder membership, multiplexed subscriptions, client/TUI changes, any socket write path.

### Approach

Per active subscription, on every `data_version` tick, compute over the FULL filtered set (the query's `WHERE`, ignoring `limit`/`offset`): `COUNT(*)` plus a **membership token** — a fingerprint over the matching **pk identities only** (never mutable columns), so it changes when a row enters/leaves the filtered set but NOT on cell updates of already-matching rows (those are the existing `patch` path's job). Emit a `meta` frame when `total` OR `token` changed since last sent for that connection.

Concrete shape (resolved design decisions — do not re-litigate):

1. **Membership-token SQL = portable subquery form, ordered by pk:**
   `SELECT COUNT(*) AS n, group_concat(<pk>) AS token FROM (SELECT <pk> FROM <table> [WHERE <clause>] ORDER BY <pk>)`.
   `ORDER BY <pk>` is REQUIRED — SQLite `group_concat` order is arbitrary without it, and an unstable token fires phantom `meta` frames every tick. Order by `descriptor.pk` (the total order / stable identity), NOT the display sort column. The subquery form (not the SQLite-3.44+ in-aggregate `group_concat(pk ORDER BY pk)`) avoids a runtime-version dependency for zero cost on a tiny table. Normalize the empty-set result (`group_concat` over zero rows returns `NULL`) to `""` so an empty filtered set has a stable `token` and `total=0` that compare cleanly tick-to-tick.

2. **This SQL lives in `src/collections.ts` as a new descriptor-parameterized helper** — `countAndToken(db, descriptor, whereClause, params): { total: number; token: string }` — mirroring `selectByIds`: only `descriptor.table` + `descriptor.pk` are interpolated (trusted constants); the filter `params` are bound (`?`). This keeps the descriptor the SOLE SQL-identifier injection gate (do not hand-roll a second filter resolver or a fresh string-concat SQL path in the server worker).

3. **Compute `{whereClause, params}` ONCE and thread it to both the page SELECT and the count** so they can never drift (drift → "X of N" where X isn't a subset of N). Extract the existing WHERE-builder loop (`src/server-worker.ts:290-301`) into a small shared `resolveFilter(descriptor, filter)` helper used by both `runQuery`'s page read and the count.

4. **`ConnState` (src/server-worker.ts) gains:** `where: { clause: string; params: (string|number)[] } | null`, `lastTotal: number | null`, `lastToken: string | null`. `newConnState()` initializes all three to null. The `query` case in `dispatchLine` (`server-worker.ts:362-400`) seeds `where` from `resolveFilter` and seeds `lastTotal`/`lastToken` from the same `countAndToken` read that produced the result's `total` (so the result→first-tick boundary emits no spurious `meta`; the page-read-vs-count-read snapshot race stays accepted — it self-heals next tick). The `unsubscribe` case (`server-worker.ts:401-406`) clears all three back to null alongside `collection`/`watched`/`lastSent`.

5. **`runQuery` (server-worker.ts:253-321)** runs `countAndToken` once and includes `total: number` in the returned `ResultFrame`. (`ErrorFrame` does NOT get a `total`.)

6. **`diffTick` (server-worker.ts:583-654)** keeps its existing collection-grouped `patch` fan-out FIRST, then adds a SECOND pass: group connections (non-null `collection` and non-null `where`) by **filter signature** `JSON.stringify([collection, where.clause, where.params])`, run `countAndToken` ONCE per distinct signature (mirroring how `unionWatched` shares one `selectByIds` per collection — `server-worker.ts:547-555`), and fan the `{total, token}` out: for each conn, **skip if `conn.pending`** (do NOT advance `lastTotal`/`lastToken` — re-fires next tick, matching the patch-path discipline at `:628-633`); else if `total !== lastTotal || token !== lastToken`, emit `meta` via the existing `writeFrames` backpressure path and set `lastTotal`/`lastToken`. Stamp `meta.rev` with the same `readWorldRevOnce(db)` value used for the tick's patches. Keep `diffTick` synchronous (it is `export`ed and driven directly by tests). Never `await` a socket write in the tick.

7. **Protocol (src/protocol.ts):** add `total: number` to `ResultFrame`; add `MetaFrame { type: "meta"; collection: string; rev: number; total: number }` (no `id` — mirrors `patch`, which carries none); add `MetaFrame` to the `ServerFrame` union. Update the file-top frame-shape doc catalog, the `ResultFrame.total` field doc, and the `rev`-on-EVERY-server-frame INVARIANT block to include `meta`. This is purely additive/forward-compat (older clients ignore the unknown `type`); NOT a schema migration — no `SCHEMA_VERSION` bump, no `migrate()` ALTER.

8. **scripts/keeper-subscribe.ts:** render `total` on the `result` line ("rows=K of N") and handle the `meta` frame in `handleFrame` (table mode: print e.g. `▲ meta  rev=… total=N`; `--json` mode already passes it through). Update the file-top JSDoc frame list to include `meta`.

### Investigation targets

**Required** (read before coding):
- src/server-worker.ts:253-321 — `runQuery`: WHERE builder (290-301) to extract; where `total` is added to the result.
- src/server-worker.ts:362-406 — `dispatchLine` query + unsubscribe cases: where ConnState is seeded/cleared.
- src/server-worker.ts:547-654 — `unionWatched` (the sharing idiom to mirror) and `diffTick` (the backpressure-skip discipline at 628-633; `readWorldRevOnce` at 537) where the second pass folds in.
- src/server-worker.ts:100-135 — `ConnState` interface + `newConnState` field-doc style to match.
- src/collections.ts:111-134 — `selectByIds`: the descriptor-parameterized read pattern `countAndToken` must mirror (sole injection gate).
- src/protocol.ts:52-154 — frame types, `ServerFrame` union, the file-top frame catalog + INVARIANT block to keep in sync.
- test/server-worker.test.ts — helpers `seedJob` (:54), `fakeSock` (:526, `accept` flag drives backpressure), `watch` (:555) and `dispatchInit` (:85) which construct `ConnState` and MUST gain the new fields, `advanceJob` (:566), `setWorldRev` (:573), `asResult` (:152).

**Optional** (reference as needed):
- test/integration.test.ts:279-418 — `connectClient` + the spawned-daemon `query→result→patch` test to extend with `result.total` + a live `meta`.
- test/protocol.test.ts — frame encode/decode round-trip suite to extend for `meta` + `ResultFrame.total`.
- src/db.ts — `resolveSockPath`, world-rev reader (reuse, don't add a third).

### Risks

- **Token determinism is the keystone.** Missing/incorrect `ORDER BY <pk>`, or fingerprinting a mutable column instead of pk only, makes the token churn → `meta` fires every tick → the TUI nags "refresh" constantly → feature is worse than nothing. Mitigate with the no-op-on-cell-update test below.
- **Filter-signature aliasing.** The signature MUST fold in bound `params` (so `state=working` and `state=stopped` don't share one count) and MUST exclude sort/limit/offset (so different pages/sorts of the same filter share). Wrong inclusion → silently wrong `total` fanned to the wrong conns.
- **Backpressure correctness.** Advancing `lastTotal`/`lastToken` on a skipped (pending) conn would drop the signal permanently. Mirror the patch path exactly.
- **Doc-catalog drift.** `MetaFrame` touches 4 sites in protocol.ts (interface, union, prose catalog, INVARIANT) — easy to update the type and leave the prose stale.

### Test notes

Add/extend unit + integration coverage:
- protocol.test.ts: `meta` frame and `ResultFrame.total` round-trip.
- server-worker.test.ts:
  - `runQuery` returns a numeric `total` equal to the filtered-set size (independent of `limit`/`offset`).
  - `countAndToken`: token STABLE across a cell update of a matching row; token CHANGES on enter and on leave; token CHANGES on a balanced swap (one row leaves as another enters — `total` unchanged but `token` differs); empty set → `total=0`, `token=""`.
  - `diffTick`: emits `meta` on a `total` change; emits `meta` on a balanced-swap (`token`-only) change; emits NO `meta` on a pure cell update (only a `patch`); no double-send when nothing changed; one `countAndToken` query shared across two conns with the same filter, both advancing.
  - backpressure: a `pending` conn gets no `meta` and does NOT advance `lastTotal`/`lastToken`; the next (unblocked) tick delivers it.
  - extend `dispatchInit`/`watch` helpers to seed `where`/`lastTotal`/`lastToken`.
- integration.test.ts: `result.total` is present on the initial page; firing a hook that makes a NEW job enter the watched filter produces a live `meta` with the incremented `total` (and a leave decrements it).
- Run the full suite: `bun test --isolate`.

## Acceptance

- [ ] `ResultFrame` carries `total: number` (filtered-set size, ignoring limit/offset); `ErrorFrame` does not.
- [ ] New `MetaFrame { type:"meta"; collection; rev; total }` added to `protocol.ts` and the `ServerFrame` union; file-top frame catalog + `rev`-on-every-frame INVARIANT updated to include it.
- [ ] `countAndToken` lives in `src/collections.ts`, descriptor-parameterized (only `table`/`pk` interpolated, params bound), using the portable subquery form ordered by `pk`, with empty-set normalized to `total=0`/`token=""`.
- [ ] `ConnState` gains `where`/`lastTotal`/`lastToken`; seeded in the `query` case from the same read as the result, cleared in `unsubscribe`; `{whereClause, params}` computed once and shared by page + count.
- [ ] `diffTick` emits `meta` only when `total` or `token` changed for a connection, grouped by filter signature with one count query per distinct filter; backpressure-skips a `pending` conn without advancing its `lastTotal`/`lastToken`; stays synchronous; stamps `meta.rev` with the tick's world-rev.
- [ ] Token changes on enter/leave/balanced-swap and is stable on pure cell updates (proven by tests).
- [ ] `scripts/keeper-subscribe.ts` renders `total` and handles `meta`.
- [ ] No `SCHEMA_VERSION` bump, no `migrate()` ALTER, no socket write path; frozen membership + live cells unchanged.
- [ ] Docs updated: CLAUDE.md (module-table rows for protocol/server-worker/collections + the `data_version` invariant note that `meta` is also emitted from the diff tick) and README (What keeper is / Architecture / What keeper is NOT — distinguishing `meta.total` as a count signal, not a live membership stream); JSDoc in the touched modules.
- [ ] `bun test --isolate` passes (protocol, server-worker, integration suites green).

## Done summary
Added a live filtered-set total on result frames and a new additive meta membership-staleness frame: per-tick countAndToken (portable group_concat(pk) subquery ordered by pk, empty-set normalized) through the descriptor injection gate, folded into diffTick as a filter-signature-grouped second pass with patch-path backpressure discipline. Token stable on cell updates, changes on enter/leave/balanced-swap. Docs + script + protocol/server-worker/collections + tests updated; no schema migration, no write path.
## Evidence

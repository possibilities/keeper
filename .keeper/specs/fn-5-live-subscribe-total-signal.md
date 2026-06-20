## Overview

Add a live `total` count and a server-side membership-staleness signal to keeper's read-only UDS subscribe server, so a realtime master-detail TUI (paginated job list + detail pane) can render "Showing X of N" and a non-disruptive "set changed, refresh" nudge WITHOUT the list reflowing under the cursor. Frozen membership + live cells (the `query → result → patch` path) stay exactly as-is; this only ADDS a `total` field on the `result` frame and a new additive `meta` server frame. Per subscription, each `data_version` tick computes `COUNT(*)` over the full filtered set plus a membership token (a fingerprint over matching pk identities only), and emits `meta` when either changes — folded into the existing `diffTick`, with one count query shared per distinct filter and the same backpressure-skip discipline as patches.

## Quick commands

- `bun test --isolate` — full suite (protocol, server-worker, integration) green.
- `bun test --isolate test/server-worker.test.ts` — token stable on cell update, changes on enter/leave/balanced-swap; `meta` emitted only on change; backpressure-skip.
- Live smoke against the running daemon: `bun scripts/keeper-subscribe.ts --filter state=working` then start/stop a Claude session in another terminal — observe `result` carrying `total` and a live `meta` frame as the working-set count moves.

## Acceptance

- [ ] `result` frames carry `total` (filtered-set size, independent of limit/offset); a new additive `meta { type:"meta"; collection; rev; total }` frame is emitted when `total` or the membership token changes for a subscription.
- [ ] Membership token is a pk-identity fingerprint ordered by pk (stable across cell updates, changes on enter/leave/balanced-swap); built through the descriptor injection gate; empty set normalized to `total=0`/`token=""`.
- [ ] Recompute folds into `diffTick` (after patch fan-out), grouped by filter signature (one count query per distinct filter), backpressure-skipping pending connections without losing the signal; `diffTick` stays synchronous and autocommit (no `BEGIN`).
- [ ] No schema migration, no socket write path; frozen membership + live cells unchanged; `scripts/keeper-subscribe.ts` renders `total` and `meta`.
- [ ] Docs (CLAUDE.md + README + module JSDoc) describe the `meta` frame and distinguish `meta.total` as a count/staleness signal, not a live membership stream.

## Early proof point

Task that proves the approach: `fn-5-live-subscribe-total-signal.1` — specifically the `countAndToken` + `diffTick` unit tests asserting the token is STABLE on a pure cell update but CHANGES on a balanced swap (count unchanged, membership different). If that distinction can't be made cleanly (e.g. token churn from non-deterministic `group_concat` ordering), fall back to forcing the pk `ORDER BY` in the subquery and re-verify before building the wire/frame surface on top.

## References

- `src/server-worker.ts` — `runQuery` (page + count), `diffTick` (`unionWatched` sharing idiom at :547-555; backpressure-skip at :628-633), `ConnState`, `dispatchLine` query/unsubscribe cases.
- `src/collections.ts` — `selectByIds` is the descriptor-parameterized-read pattern the new `countAndToken` helper mirrors; the descriptor is the SOLE SQL-identifier injection gate.
- `src/protocol.ts` — frame discriminated union, the file-top frame catalog, and the `rev`-on-every-server-frame INVARIANT.
- All four keeper epics (`fn-1`..`fn-4`) are `done` — no inter-epic dependencies or overlaps (epic-scout).

## Docs gaps

- **CLAUDE.md** (and AGENTS.md via symlink): module-table rows for `src/protocol.ts` (+`meta`), `src/server-worker.ts` (+filter-grouped COUNT/token, `meta` emission, backpressure-skip), `src/collections.ts` (+count-query/`countAndToken` role); the `data_version`-polling invariant blurb should note `meta` is also emitted from the same diff tick.
- **README.md**: "What keeper is" (add `meta` as the third server frame), Architecture (the COUNT+token diff emitting `meta` + filter-group sharing), and "What keeper is NOT" (one sentence: `meta.total` signals a membership *count* change without delivering the new members — a signal, not a live membership stream).
- **src/protocol.ts** JSDoc: frame enumeration + `ServerFrame` union doc + `ResultFrame.total` field + extend the `rev`-on-every-frame INVARIANT.
- **src/server-worker.ts** JSDoc: file-top third beat (count/token → `meta`); `diffTick` JSDoc meta path + backpressure note.
- **src/collections.ts** JSDoc: `countAndToken`'s descriptor-parameterized count-query role.
- **scripts/keeper-subscribe.ts**: file-top frame list + `handleFrame` `meta` rendering.

## Best practices

- **Force a total-order `ORDER BY <pk>` inside the token subquery:** SQLite `group_concat` order is arbitrary without it (plan-dependent) — an unstable token fires phantom `meta` frames every tick. Order by the pk (stable identity), not the display sort. [SQLite forum / Simon Willison TIL]
- **Prefer the portable subquery form** (`SELECT group_concat(pk) FROM (SELECT pk ... ORDER BY pk)`) over the SQLite-3.44+ in-aggregate `group_concat(pk ORDER BY pk)` to drop a runtime-version dependency at no cost on a tiny table. [SQLite 3.44 notes]
- **Fingerprint pk identities only, never mutable columns** — including `state`/`last_event_id` in the token makes it fire on every cell update, defeating the enter/leave-only purpose. [direct consequence of the design]
- **Wire filter keys never reach SQL as identifiers** — resolve via the descriptor allowlist map to a fixed column constant; bind all values (`?`). Identifier injection via filter keys is the only attack surface. [SQLite bind docs / PayloadsAllTheThings]
- **Backpressure is latest-wins, not a queue** — skip the recompute for a pending connection and let the next tick re-derive from current DB state; never enqueue successive `meta` frames. Don't `await` a socket write inside the poll-tick loop. [SocketCluster streams & backpressure]

## Overview

Several live collections — `subagent_invocations`, `scheduled_tasks`, `pending_dispatches` — use a non-unique PARTIAL primary key as their subscription diff identity, so the serve layer collapses sibling rows sharing that key value into one watched slot and silently drops existing-row version transitions. Readiness/UI state then goes stale indefinitely (e.g. a completed subagent's concurrency/occupancy slot stays held). This generalizes keeper's existing `liveKeyColumns` composite-identity mechanism — today declared only on `dispatch_failures` — to every composite-PK collection, adds a schema-derived registry contract test so the invariant cannot silently regress, and stabilizes the subscribe page tie-break that shares the same root cause.

## Quick commands

- `bun test test/collections.test.ts`   # descriptor unit clones + schema-derived registry contract test, fast in-process tier

## Acceptance

- [ ] Existing-row version transitions on the three composite-PK collections are no longer dropped from live subscriptions.
- [ ] A schema-derived registry contract test enforces the live-identity invariant for every current and future composite-PK REGISTRY collection.
- [ ] Subscribe page order is total and stable across refetches for rows sharing a sort value.

## Early proof point

Task that proves the approach: `.1` (descriptor generalization + the `selectVersionsByIds` two-rows-track-as-two regression test). If it fails: the identity helpers are not composing as expected — audit `liveKeyExpr`/`liveKeyOf` char(31)/\x1f byte-parity before proceeding.

## References

- The one correct in-repo exemplar is `dispatch_failures` (`src/collections.ts:623`) — the `pk` + `liveKeyColumns` shape to mirror; `liveKeyExpr`/`liveKeyOf` (`:1020-1041`) are the identity helpers, reuse them, never hand-roll a second join.
- The client direct-merge path (`readiness-client.ts` `mergePatchRow`) still keys on the single wire `pk`, so the existing "read `state.rows`, not `byId`" client guidance stays load-bearing — only the SERVER-side collapse rationale changes.
- Contract-test introspection: treat `PRAGMA table_info.pk` as the boolean "is part of PK" only and compare declared key vs PK columns as SETS (key ordering diverges across SQLite forks).

## Docs gaps

- **CLAUDE.md** (event-sourcing invariants, near the `recencyBound` line): optional single imperative guardrail — a composite-SQLite-PK collection descriptor must declare its live-identity key or its subscription silently misses updates. At most one line; the contract test is the real enforcement — worker's judgment whether it earns its place.

## Best practices

- **Composite identity must be type- and NULL-distinct:** SQLite NUMERIC-vs-TEXT affinity coercion can make two reads of the same row produce different tokens (phantom add+delete) — the exact silent-miss class; the repo's `char(31)` delimiter join is safe only because the live-key columns are NOT NULL, so verify that before adding a column to a live key.
- **Contract test compares PK columns as SETS:** use `table_info.pk` as a boolean, not for ordering — fork engines (e.g. libSQL) have reported `pk=1` for every composite column, losing order.

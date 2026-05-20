## Overview

The UDS subscribe server hardcodes `jobs` at every layer of the read surface — the wire frames (`ResultFrame.rows: Job[]`, `PatchFrame.job`), the query vocabulary (`SORTABLE_COLUMNS`, the `state`/`mode`/`cwd` filter branches), the SQL (`FROM jobs`), and the diff key (`job_id`/`last_event_id`). This epic namespaces the surface by a required `collection` field on every frame and pulls everything collection-specific into a `CollectionDescriptor` registry (`src/collections.ts`), so `runQuery` and `diffTick` route by collection name. `jobs` becomes the first registered descriptor; adding a future collection (e.g. `plans`) becomes a second registration with zero wire-protocol or diff-machinery change. Scope is the API/protocol refactor only — no plan sourcing/ingestion, which will be sourced very differently and is explicitly out of scope. Usage model is one active subscription per connection, replaced on re-query (list → detail navigation).

## Quick commands

- `bun run typecheck && bun run lint && bun test --isolate` — full gate; the refactor is correct when types, lint, and all suites (protocol, db, server-worker, integration) pass.

## Acceptance

- [ ] A `query` frame carries a required `collection`; `result`/`patch` echo it; `patch` payload is `row` (not `job`); rows are generic.
- [ ] `jobs` is served entirely through a `CollectionDescriptor` in `src/collections.ts`; no `jobs`-specific table/column/filter literal remains in `runQuery`/`diffTick`.
- [ ] A well-formed `query` naming an unregistered collection returns an `unknown_collection` error and leaves any existing subscription intact; absent/empty/non-string `collection` returns `bad_frame`.
- [ ] A detail-page single-item subscribe (`filter:{job_id:…}`) returns a one-row page that subsequently emits `patch` frames.
- [ ] The realtime layer is unchanged in behavior for jobs (frozen membership, live cells, one `data_version` poll → `diffTick`, backpressure-skip), with the global frame `rev` kept distinct from the descriptor's per-row version column.
- [ ] CLAUDE.md and README.md describe the namespaced collection surface; all tests updated and green.

## Early proof point

Task that proves the approach: `fn-4-namespace-subscribe-protocol-by.1`. It is the whole refactor as one type-interdependent unit — the canonical proof is the updated `integration.test.ts` end-to-end guard (real worker: `query {collection:"jobs"}` → `result` echoing `collection` → fold a change → `patch` with `row`). If it fails: the type-interdependence means a partial landing won't typecheck, so back out as a unit and re-stage `protocol.ts` + `server-worker.ts` + tests together rather than splitting.

## References

- `fn-3-keeper-v2-audit-follow-ups-crash-gap` (overlap) — task fn-3.2 edits `src/protocol.ts` (the `MAX_LINE_BYTES` rename / line-cap semantics), the same file this epic refactors for collection routing. Coordinate the `src/protocol.ts` edits so the two don't collide; land/close fn-3 first or reconcile in one branch.
- Frozen-membership / live-cells contract: membership is fixed at query time; a live page never gains or loses rows (contrast electric-sql/electric "shapes" and rocicorp/mono Zero move-in/move-out — the complexity this design intentionally avoids).
- `src/wake-worker.ts` — the autocommit/no-`BEGIN` `data_version` poll the realtime layer mirrors (an explicit `BEGIN` on the poll connection freezes `data_version` and pins the snapshot).

## Docs gaps

- **CLAUDE.md**: add a `src/collections.ts` bullet to the directory layout; update the `src/server-worker.ts` and `src/protocol.ts` entries (collection routing; `collection` now a required frame field; `patch.job`→`patch.row`); add a `src/collections.ts` row to the module entry points table.
- **README.md**: generalize the architecture section and the "what keeper is" wording from "page of jobs"/"jobs rows" to name `jobs` as the first/default collection of a namespaced surface (keep README's high-level, no-type-names abstraction level).

## Best practices

- **The descriptor allowlist is the only identifier-injection gate; resolve filter keys by map lookup, never validate-then-passthrough.** Interpolate only descriptor-supplied identifiers (table/columns/pk/sort col); bind all values. [OWASP SQL Injection Prevention]
- **Keep the global frame `rev` separate from the per-row version column.** `rev` is the reducer cursor stamped on every frame for ordering; the diff compares each row's `descriptor.version` against `lastSent`. For jobs both happen to be `last_event_id` today — do not collapse them. [internal invariant + differential-sync]
- **Make frozen membership explicit in the wire contract**: the diff emits cell updates only for rows already in the query-time set; it never re-evaluates the WHERE for move-in/move-out. [contrast Electric/Zero]
- **Fully replace (don't merge) the subscription on re-query**, in one synchronous block, so no `diffTick` interleaves stale rows; reset `collection` to null on `unsubscribe`. [concurrency reasoning]

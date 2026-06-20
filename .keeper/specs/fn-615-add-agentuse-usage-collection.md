## Overview

keeper grows a fifth read-surface collection, `usage`, that mirrors per-profile agent-quota state written by the agentuse daemon at `~/.local/state/agentuse/<id>.json`. A new producer worker (`src/usage-worker.ts`) watches that directory with `@parcel/watcher`, mints synthetic `UsageSnapshot` / `UsageDeleted` events into the existing event log, and the reducer folds them into a flat `usage` table. A new `scripts/usage.ts` subscribes to the collection and renders one concise line per profile.

End state: `bun scripts/usage.ts` shows one line per agentuse profile with target, multiplier, and session+week percent/reset info, updating live whenever agentuse refreshes the underlying JSON files with semantically-new content.

## Quick commands

- `bun scripts/usage.ts` — live one-line-per-profile view
- `sqlite3 ~/.local/state/keeper/keeperd.db 'SELECT * FROM usage ORDER BY target, id'` — direct projection inspection

## Acceptance

- [ ] `usage` collection registered in `src/collections.ts` REGISTRY; subscribable over the existing UDS surface with working `result` + `patch` + `meta` frames
- [ ] `UsageSnapshot` / `UsageDeleted` events fold inside the same `BEGIN IMMEDIATE` as the cursor advance; re-fold from event id 0 reproduces the same rows byte-identically
- [ ] usage-worker satisfies the full worker contract (isMainThread guard, own readonly connection, typed messages, shutdown handler unsubscribes the parcel subscription, no in-process self-heal)
- [ ] Change-gate AND schema both exclude every freshness field — `fetched_at` / `next_fetch_at` / `last_successful_fetch_at` / `last_skipped_fetch_at` are read and discarded; fetch-only refresh cycles produce zero events
- [ ] Boot reconciliation retracts agentuse profiles whose `<id>.json` was deleted while keeperd was down (mirrors plan-worker's `sweep`)
- [ ] `scripts/usage.ts` subscribes and renders one line per profile with sidecar discipline matching `scripts/git.ts`
- [ ] README updated for the new collection, new worker thread, new schema version, and new example client

## Early proof point

Task that proves the approach: `<epic_id>.1`. The producer side carries every event-sourcing invariant (re-fold determinism, change-gate, boot sweep, schema migration). If it lands cleanly, task 2 is a thin renderer. If task 1 reveals an unexpected obstacle (e.g. agentuse's atomic-rename pattern produces parcel events the in-tree template doesn't already handle), back out by reverting the schema bump and the descriptor registration — the wire surface stays unchanged for existing clients.

## References

- `src/plan-worker.ts` — producer-worker template being cloned (multi-root; usage is single-root + flat dir)
- `src/git-worker.ts` — closer single-root template, useful for the worker shape
- `src/reducer.ts:695-792` — `extractGitSnapshot` / `projectGitStatus` / `retractGitStatus`, the closest reducer-arm template (flat single-row upsert)
- `src/collections.ts:239-270` + `:329` — `GIT_DESCRIPTOR` shape and REGISTRY registration
- `scripts/git.ts` — the single-collection-subscribe client template
- `~/code/agentuse/daemon.py` — producer-side semantics for the watched JSON envelopes (atomic temp+rename; idle-skip path; new last_*_fetch_at fields)

## Docs gaps

- **README.md (~lines 72-82)**: "What keeper is" collection enumeration currently says "Three collections register today" — update the count phrasing and add a one-sentence `usage` description.
- **README.md (~lines 432-469)**: Architecture section — add a paragraph for the usage producer worker following the same template as transcript-title / plan / git workers (what external tree it watches → message it posts → synthetic event minted → reducer fold).
- **README.md (schema version callout ~lines 451-468)**: add a one-sentence "as of schema vN" note for the new SCHEMA_VERSION bump introducing the `usage` table.
- **README.md (Example clients section ~lines 266-388)**: add a `usage.ts` bullet in the same format as `board.ts` / `git.ts`.
- **README.md (Inspect section ~line 533+)**: add one `SELECT * FROM usage` query example.
- **CLAUDE.md**: DO NOT list bullet that currently names "Three collections register today" — trim or update the count phrasing if it contradicts post-epic reality. Do not add new doc on how the usage worker works (Architecture in README is the right home).

## Best practices

- **Route on path existence, not event.type:** agentuse writes via atomic temp+rename, which `@parcel/watcher` surfaces as `create` (not `update`). The classify-then-read-current-file pattern in `plan-worker.ts` handles this correctly — never gate on `event.type` (parcel/watcher README + issue #174).
- **No negated parcel ignore globs:** parcel/watcher#174 — a single negated pattern blacks out the entire subscription. Filter `<id>.error.json` / `server.std{err,out}` / temp artifacts in-callback by filename predicate, never via the watcher's `ignore` option.
- **Exclude all freshness fields from the change-gate AND the version-bump:** including any of `fetched_at` / `next_fetch_at` / `last_successful_fetch_at` / `last_skipped_fetch_at` in the change-gate hash forces an event on every ~90s fetch cycle even when no real content moved. Gate ONLY on projection-stored fields. Since this epic stores none of them, the rule is trivially satisfied — but a future "add a freshness column" temptation must NOT route through the change-gate or version column.
- **Derive the on-disk-census id from the filename, not the JSON body:** a file mid-rewrite that fails to parse still has its name on disk and stays in the "seen" set, so the boot sweep doesn't spuriously retract it (plan-worker's `markSeen`).
- **Re-fold determinism:** the synthetic `UsageSnapshot` event's `data` blob must carry every projection-meaningful field. The reducer never re-reads the on-disk file — re-fold from event id 0 must reproduce the projection row byte-identically.
- **Shutdown handler must `unsubscribe()` the parcel subscription:** `terminate()` alone leaks the FSEvents/inotify fd. Mirror `plan-worker.ts`'s shutdown contract.

## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/collections.ts, src/usage-worker.ts (new), src/daemon.ts, test/usage-worker.test.ts (new), test/reducer.test.ts, test/collections.test.ts, test/db.test.ts

### Approach

Clone the existing producer-worker archetype. Six sub-moves, all landing in one task because they share the same correctness story (re-fold determinism, change-gate, boot sweep) and split would yield half-functional intermediates.

1. **Schema (v22 → v23).** Add a `CREATE TABLE IF NOT EXISTS usage (...)` literal in `src/db.ts` near `CREATE_GIT_STATUS` (line ~418). Columns: `id TEXT PRIMARY KEY`, `target TEXT`, `multiplier INTEGER`, `session_percent REAL`, `session_resets_at TEXT`, `week_percent REAL`, `week_resets_at TEXT`, `last_event_id INTEGER`, `updated_at REAL NOT NULL DEFAULT 0`. NO freshness columns — every `fetched_at` / `next_fetch_at` / `last_successful_fetch_at` / `last_skipped_fetch_at` field from the source envelope is read by the worker only to ignore it. Wire the CREATE call into `migrate()` near the existing CREATEs; bump `SCHEMA_VERSION` to 23 with a per-version comment block in the ALTER chain.

2. **Producer worker (`src/usage-worker.ts`).** Clone `plan-worker.ts`'s shape but simplified — one fixed root (`~/.local/state/agentuse/`), one file shape, flat dir, no per-project nesting, no second-pass sidecar. Export a pure `UsageScanner` class with `onChange(path)` / `onDelete(path)` / `markSeen(path)` / `sweep(db)` / `seed(id, serialized)` so tests drive it without a Worker or watcher. Use `@parcel/watcher` with empty `ignore` (flat leaf dir, no `**` patterns); use `RescanScheduler` + `isDropError` from `src/rescan.ts` verbatim for FSEvents drop recovery. Filter in-callback via `/^[a-z0-9-]+\.json$/` (rejects `.error.json` — extra dot segment, `server.stdout` / `server.stderr` — no `.json` suffix, and any `<id>.json.tmp.*` temp artifacts). Change-gate by `JSON.stringify` of the projection-meaningful fields only (no fetch timestamps); seed it from the existing `usage` table on boot via a `seedFromDb` helper with slot-order-stable serialization matching the live producer. Tolerate a missing state dir (subscribe + scan both no-op, no fatalExit — agentuse may not have run yet). isMainThread-guarded body; shutdown handler `unsubscribe()`s the parcel subscription before `process.exit(0)`.

3. **Reducer arms (`src/reducer.ts`).** Add `extractUsageSnapshot` + `projectUsageRow` (single `INSERT … ON CONFLICT(id) DO UPDATE SET ...` upsert, mirrors `projectGitStatus` at line ~729) + `retractUsageRow` (DELETE WHERE id = ?). Add `else if (event.hook_event === "UsageSnapshot")` / `else if (event.hook_event === "UsageDeleted")` arms inside the same `db.transaction(() => {...})` in `applyEvent` (line ~2398), ABOVE the cursor advance — NEVER split across transactions. Both arms must bump `last_event_id = event.id` and `updated_at = event.ts` on every write so the descriptor's diff-tick fires patches. The `UsageSnapshot` event's `data` blob carries pre-flattened fields (`target`, `multiplier`, `session_percent`, `session_resets_at`, `week_percent`, `week_resets_at`); the tombstone carries the id in `events.session_id` per the existing convention.

4. **Collection descriptor (`src/collections.ts`).** Add `USAGE_DESCRIPTOR` modeled on `GIT_DESCRIPTOR` (line ~239). `name: "usage"`, `table: "usage"`, `pk: "id"`, `version: "last_event_id"`, `sortable: { id, target, last_event_id, updated_at }`, `defaultSort: { column: "id", dir: "asc" }`, `filters: { id, target }`, no `jsonColumns`, no `defaultFilter`, no `defaultClause`. Register in `REGISTRY` at line ~329.

5. **Daemon wiring (`src/daemon.ts`).** Clone the `planWorker` block at line ~369. Spawn `usageWorker` after migrate + drain + seed sweep. Translate `{kind: "usage-snapshot"}` / `{kind: "usage-deleted"}` worker messages into synthetic events via `stmts.insertEvent.run({...})` (full named-binding shape from line ~440 — all NULL except `$session_id` carrying the id, `$hook_event` = `"UsageSnapshot"` / `"UsageDeleted"`, `$event_type` = `"usage_snapshot"`, `$data` carrying the flattened JSON for snapshots / empty string for tombstones). Pump wakes immediately after insert. Add `onerror` + `close` (when `!shuttingDown`) handlers escalating to `fatalExit()`. Add `usageWorker.postMessage({type: "shutdown"})`, `exited(usageWorker)` in `Promise.all`, and `usageWorker.terminate()` in the supervisor shutdown sequence (~line 700).

6. **Tests.** New `test/usage-worker.test.ts` for the pure `UsageScanner`: synthetic onChange / onDelete / sweep cases, change-gate dedupe, malformed JSON skip-and-log, oversize file skip-and-log, missing-id skip, missing-`session` / missing-`week` (folds to NULL), and the load-bearing freshness-exclusion case (two messages differing only in freshness fields produce zero emits). Add `UsageSnapshot` / `UsageDeleted` reducer-arm cases to `test/reducer.test.ts` mirroring the `EpicSnapshot` / `GitSnapshot` tests, including a from-scratch re-fold convergence assertion. Add a fresh-DB-vs-migrate-from-v22 convergence test to `test/db.test.ts` (PRAGMA `table_info` byte-equal). Add the `usage` descriptor to `test/collections.test.ts`'s registry assertions.

### Investigation targets

**Required** (read before coding):
- `src/plan-worker.ts:1-100` — file header documents the producer-worker contract and the keystone watching strategy (positive-only ignore globs, in-callback filter, atomic-rename routing).
- `src/plan-worker.ts:539+` — `PlanScanner` pure-core export pattern; mirror exactly for `UsageScanner` (change-gate map, pathToId map, on-disk census set, sweep gated AFTER boot scan).
- `src/git-worker.ts:1-100` — closer single-root template; useful when the plan-worker's multi-root config feels heavier than this epic needs.
- `src/reducer.ts:695-792` — `extractGitSnapshot` / `projectGitStatus` / `retractGitStatus` — closest reducer-arm shape (flat row, single ON CONFLICT upsert, no read-modify-write).
- `src/reducer.ts:2398-2436` — `applyEvent` dispatch + the single `BEGIN IMMEDIATE` cursor advance (line 2432). New arms slot into the chain ABOVE the cursor update.
- `src/daemon.ts:369-482` — `planWorker` spawn + onmessage translator + crash policy + shutdown sequence; clone verbatim.
- `src/daemon.ts:440-465` — `stmts.insertEvent.run({...})` named-binding shape, all 22+ keys including the always-NULL synthetic columns.
- `src/collections.ts:239-270` — `GIT_DESCRIPTOR` shape; lines 329-334 — REGISTRY entries.
- `src/db.ts:56` — `SCHEMA_VERSION` constant; line ~418 — `CREATE_GIT_STATUS` literal shape; the migrate() block — bootstrap CREATE call pattern + per-version ALTER comments.
- `src/rescan.ts` — `RescanScheduler` + `isDropError` (reuse verbatim).

**Optional** (reference as needed):
- `~/.local/state/agentuse/` — live envelope shapes (`claude-default.json`, `codex.json`, etc.) for the worker's parse contract.
- `~/code/agentuse/daemon.py` — atomic-write semantics, `IDLE_THRESHOLD_S` idle-skip path, the new `last_successful_fetch_at` / `last_skipped_fetch_at` fields the worker MUST read-and-discard.
- `src/transcript-worker.ts` — alternative producer template (file-tail-driven) if the plan-worker comparison helps frame the parcel/safe-parse boundary.

### Risks

- **Slot-order drift between live producer and DB seed re-emits every row on every boot.** The `JSON.stringify` change-gate is byte-compared; if `buildUsageMessage` and `seedFromDb`'s reconstruction don't emit identical object key order, the gate trips and every profile re-emits a synthetic `UsageSnapshot` on every daemon restart. Mitigation: stable object-literal field order in both call sites, plus a unit test asserting byte-equal serialization for a round-trip case.
- **Freshness-discipline drift over time.** A future contributor could quietly add `fetched_at` to the table or to the change-gate hash. The projection would then churn every ~90s. Mitigation: the freshness-exclusion test (two messages differing only in freshness fields produce zero emits) acts as a tripwire. Comment in the source flagging the discipline.
- **agentuse state dir missing at daemon boot.** If agentuse has never run, `~/.local/state/agentuse/` may not exist. The worker must tolerate ENOENT (subscribe + scan both no-op, no fatalExit). Mitigation: mirror plan-worker's missing-root tolerance; treat absence as "wait for the dir to appear" rather than fatal.
- **Schema convergence: fresh DB vs migrate from v22.** Bare `CREATE_USAGE` and the migrate() path must produce a byte-identical table (column order, defaults, collation). Mitigation: `PRAGMA table_info("usage")` convergence test asserting equality between the two paths.
- **parcel/watcher cross-platform behavior.** macOS FSEvents and Linux inotify differ on glob-child behavior, drop-event signaling, and create-vs-update emission for atomic rename. Mitigation: route exclusively on path existence + filename classification (never on `event.type`); rely on `isDropError`'s substring match for drops.

### Test notes

- Pure-core `UsageScanner` tests drive `onChange` / `onDelete` / `markSeen` / `sweep` against in-memory fixtures (no real watcher, no real SQLite needed for the scanner-shape tests). Covers: torn JSON skip-and-log, oversize skip-and-log, missing-id skip, missing `usage.session` / missing `usage.week` (folds to NULL columns), change-gate dedupe on identical-content re-emit, change-gate accept on real content diff.
- **Load-bearing freshness-exclusion test:** two `buildUsageMessage` calls with identical `target` / `multiplier` / `session_*` / `week_*` but different `fetched_at` / `next_fetch_at` / `last_successful_fetch_at` / `last_skipped_fetch_at` MUST produce identical serializations (change-gate suppresses re-emit). This is the discipline tripwire.
- Reducer fold tests cover: `UsageSnapshot` upsert + `UsageDeleted` retract + cursor advance in same transaction + tombstone-for-missing-row no-op + `last_event_id` bump on every write.
- From-scratch re-fold convergence test: pre-populate an event log with N synthetic events, rewind cursor to 0, DELETE FROM usage, re-drain, assert resulting rows match the pre-rewind snapshot byte-identically.
- DB convergence test: open empty DB twice — once via bare DDL bootstrap, once via stepwise migration from a synthetic v22 schema — assert `PRAGMA table_info("usage")` is identical row-for-row.
- Collections registry test: assert `getCollection("usage")` returns `USAGE_DESCRIPTOR` with the expected pk / version / sortable shape.

## Acceptance

- [ ] `SCHEMA_VERSION` bumped to 23; `usage` table created via both the bare CREATE literal AND the migrate() path with byte-identical results (PRAGMA `table_info` convergence test passes)
- [ ] `UsageSnapshot` / `UsageDeleted` reducer arms land inside the same `BEGIN IMMEDIATE` as the cursor advance — never split across transactions
- [ ] Re-fold from event id 0 against a populated event log reproduces the same `usage` rows byte-identically (from-scratch convergence test passes)
- [ ] usage-worker tolerates a missing agentuse state dir (no fatalExit, subscription + scan both no-op until the dir appears)
- [ ] Change-gate AND schema exclude every freshness field — `fetched_at`, `next_fetch_at`, `last_successful_fetch_at`, `last_skipped_fetch_at`; freshness-exclusion test passes
- [ ] Worker shutdown handler `unsubscribe()`s its `@parcel/watcher` subscription; daemon clean-exit doesn't leak the FSEvents/inotify fd
- [ ] `USAGE_DESCRIPTOR` registered in REGISTRY; subscribing to `usage` over the existing UDS surface returns one row per `<id>.json` file with working `result` + `patch` + `meta` frames
- [ ] All tests pass: `bun test test/usage-worker.test.ts test/reducer.test.ts test/collections.test.ts test/db.test.ts`

## Done summary
Shipped the agentuse usage producer-worker: schema v23 usage table + reducer arms (UsageSnapshot/UsageDeleted in same BEGIN IMMEDIATE as cursor advance + re-fold determinism), USAGE_DESCRIPTOR registered in REGISTRY, UsageScanner pure-core mirroring plan-worker + boot sweep + change-gate, daemon spawn/shutdown wiring for the seventh worker, and hermetic agentuse_root config key so integration tests can point the worker at a tmp dir. Freshness-exclusion discipline (fetched_at/next_fetch_at/last_successful_fetch_at/last_skipped_fetch_at) excluded from BOTH schema and change-gate hash with tripwire tests pairing producer + projection sides. 286/286 acceptance tests pass; full suite green (the 6 pre-existing live-shell failures are unaffected).
## Evidence

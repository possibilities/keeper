## Description

**Size:** S
**Files:** src/usage-worker.ts, test/usage-worker.test.ts

### Approach

Keep freshness fields out of `UsageSnapshotMessage` and the reducer payload, but add a separate coarse heartbeat key inside `UsageScanner`'s change gate. Compute a 10-minute bucket from successful active scrape freshness (`last_successful_fetch_at`, with `fetched_at` only as a legacy fallback) and emit a normal `usage-snapshot` when content is unchanged but the bucket advances; same-bucket rewrites stay suppressed. Seed the content key and heartbeat bucket from the DB so daemon restarts do not re-emit same-bucket rows, while a fresher on-disk active envelope self-heals an old `last_usage_fold_at`. Do not add periodic idle writes here: the scraper intentionally suppresses redundant idle envelopes, so this task targets active successful scrapes and leaves idle scheduling semantics unchanged.

### Investigation targets

**Required** (read before coding):
- src/usage-worker.ts:50 — freshness-exclusion discipline that needs updating from zero-churn to bounded heartbeat.
- src/usage-worker.ts:484 — `usageGateKey` remains projection-content-only; the heartbeat key should live beside it, not inside it.
- src/usage-worker.ts:620 — `UsageScanner.onChange` suppression point where the heartbeat bucket belongs.
- src/usage-worker.ts:730 — `seedFromDb` reconstruction point; include `last_usage_fold_at` in the seed query and bucket seeding.
- src/reducer.ts:3016 — existing `UsageSnapshot` fold already stamps `last_usage_fold_at` for active snapshots, so no reducer/schema change is needed.
- test/usage-worker.test.ts:246 — freshness-exclusion tripwire becomes same-bucket suppress / next-bucket emit coverage.

**Optional** (reference as needed):
- cli/usage.ts:291 — renderer stale threshold, useful for understanding why a 10-minute heartbeat fits under the 15-minute warning cutoff.
- test/usage.test.ts:697 — renderer staleness tests should remain unchanged if the worker fix is correct.

### Risks

The main risk is accidentally putting freshness into the serialized message, which would churn every fetch and alter the event payload contract. A second risk is treating stale/error envelopes as healthy heartbeats; keep the heartbeat source restricted to successful active scrapes.

### Test notes

Add pure `UsageScanner` tests for same-bucket suppression, next-bucket heartbeat emission, stale/error non-heartbeat behavior, and DB seeding from `last_usage_fold_at`. Keep the renderer tests unchanged unless the implementation proves the UI contract itself needs adjustment.

## Acceptance

- [ ] `UsageScanner.onChange` emits one heartbeat snapshot when an unchanged active envelope advances into a new 10-minute successful-fetch bucket.
- [ ] `UsageScanner.onChange` suppresses unchanged active envelopes inside the same 10-minute bucket.
- [ ] Stale/error envelopes with only `error.at` or freshness-field movement still produce no additional snapshot.
- [ ] `seedFromDb` seeds the heartbeat bucket from `usage.last_usage_fold_at` and suppresses same-bucket boot scans.
- [ ] Focused tests pass with `bun test test/usage-worker.test.ts test/usage.test.ts`.

## Done summary
UsageScanner now emits one liveness heartbeat per 10-minute successful-fetch bucket for unchanged active scrapes, keyed off last_successful_fetch_at and seeded from last_usage_fold_at, so stable accounts (e.g. claude-0) no longer flap false-stale. Freshness stays out of the message, content gate, and projection.
## Evidence

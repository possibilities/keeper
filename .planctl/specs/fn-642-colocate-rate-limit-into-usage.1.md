## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/collections.ts, test/reducer.test.ts, test/collections.test.ts, CLAUDE.md, README.md

### Approach

Bump `SCHEMA_VERSION` 34→35 (src/db.ts:60). Add `last_rate_limit_at REAL` +
`last_rate_limit_session_id TEXT` to `CREATE_USAGE` (db.ts:582-596, matching
the `profiles` shape at L652-653) and `profile_name TEXT` to `CREATE_PROFILES`
(db.ts:649-657). Add a new v34→v35 migrate slot (db.ts:3348-3401) with three
`addColumnIfMissing` ALTERs, plus a version-guarded one-time backfill that
stamps `profile_name = projectBasename(config_dir)` on existing fn-639
`profiles` rows (read rows in JS, compute, UPDATE — non-idempotent, so guard
on the version step). Reuse `projectBasename` from src/epic-deps.ts:49-56 (no
`node:path`); do NOT write a new basename function.

Reducer fan-out, both directions inside the existing `BEGIN IMMEDIATE`:
- **profile_name seed** — SessionStart profiles seed (reducer.ts:4290-4301)
  stamps `profile_name` via `projectBasename(config_dir)`; derivation must be
  byte-identical wherever config_dir is known (same discipline as the
  `COALESCE(?,'')` sentinel).
- **forward (rate→usage)** — in the RateLimited/ApiError arm (reducer.ts:4565-4667),
  after the existing `profiles` UPSERT, run a pure `UPDATE usage SET
  last_rate_limit_at=?, last_rate_limit_session_id=?, last_event_id=<event.id>
  WHERE id = <profile_name> AND profile_name != ''`. Pure UPDATE only — never
  UPSERT (a rate-limit must not mint a phantom usage row). Bumping
  `last_event_id` is required so the wire diff fires.
- **reverse (usage←profiles)** — in `projectUsageRow` (reducer.ts:2042-2082),
  carve the two rate-limit columns OUT of the `ON CONFLICT(id) DO UPDATE SET`
  (mirror the EpicSnapshot carve-out), then after the UPSERT `SELECT
  last_rate_limit_at, last_rate_limit_session_id FROM profiles WHERE
  profile_name = <usage.id> AND profile_name != ''` and stamp them onto the
  usage row. NULL-safe: no matching profiles row → columns stay NULL (a later
  rate-limit fans them in).

No `Date.now()`/env/OS reads in either direction; use `event.ts`. Add the two
usage columns to `USAGE_DESCRIPTOR.columns` and `profile_name` to
`PROFILES_DESCRIPTOR.columns` in collections.ts:386-450 (jsonColumns stays
empty). Do NOT widen the usage-worker change-gate hash. Update CLAUDE.md
invariants + README `## Architecture` per the epic Docs gaps.

### Investigation targets

**Required** (read before coding):
- src/epic-deps.ts:49-56 — `projectBasename`, the basename helper to reuse
- src/reducer.ts:2042-2082 — `projectUsageRow` UPSERT; ON CONFLICT clobber risk at L2057-2067
- src/reducer.ts:4565-4667 — RateLimited/ApiError dual-case arm; profiles UPSERT at L4655
- src/reducer.ts:4290-4301 — SessionStart profiles seed
- src/db.ts:60, :582-596, :649-657, :900-913, :3348-3401 — version, table literals, addColumnIfMissing, migrate slots
- test/reducer.test.ts:2450-2502 — re-fold determinism idiom; :9847-9936 — profiles fan-out tests

**Optional** (reference as needed):
- src/reducer.ts:2644 (syncJobIntoEpic), :3044 (syncJobLinksOnJobWrite), :3190 (syncPlanctlLinks) — fan-out shape (re-derive/full-replace, null-guard, no-op gate)
- src/collections.ts:386-450 — USAGE_DESCRIPTOR + PROFILES_DESCRIPTOR

### Risks

- The `ON CONFLICT DO UPDATE SET` clobbers the new columns on every snapshot unless carved out — highest-likelihood bug.
- Forgetting to bump `usage.last_event_id` on the forward UPDATE → wire diff never fires → UI doesn't update.
- `profile_name` derivation drift between seed and any other write point (keep it byte-identical).
- `''` sentinel (`~/.claude`, basename `""`) must never join a usage row — guard `profile_name != ''` on both sides.
- The backfill is non-idempotent — must be version-guarded so a re-run can't corrupt.

### Test notes

Extend the re-fold determinism test to cover both fan-out directions and event
ordering: (a) UsageSnapshot before SessionStart before RateLimited (usage row
seeded NULL, then rate-limit fans in); (b) a rate-limit arriving after the
usage row already exists still lands; (c) an untracked rate-limit (no usage
row) is a no-op and mints nothing; (d) `''` sentinel never joins. Add the new
columns to the collections descriptor test (test/collections.test.ts:152-188).

## Acceptance

- [ ] schema migrates 34→35 idempotently; the three columns exist via both CREATE literal and ALTER
- [ ] a `rate_limit` event stamps the matching usage row's `last_rate_limit_*` and bumps `last_event_id`; no phantom usage row is created for an untracked profile
- [ ] a `UsageSnapshot` pulls the current rate-limit from the matching profiles row; NULL-safe when none exists
- [ ] `''` sentinel never joins a usage row (guarded both sides)
- [ ] from-scratch re-fold reproduces byte-identical `usage` + `profiles` rows
- [ ] the two usage columns surface on the `usage` collection over the socket
- [ ] CLAUDE.md + README architecture docs updated

## Done summary
Schema v35: added bidirectional usage<->profiles rate-limit fan-out (last_rate_limit_at + last_rate_limit_session_id on usage, profile_name on profiles); ON CONFLICT carve-out preserves the annotation through re-snapshots; pure UPDATE on forward path so untracked profiles do not mint phantom usage rows; '' sentinel guarded on both sides; from-scratch re-fold determinism preserved.
## Evidence

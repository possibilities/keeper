## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/collections.ts, src/epic-deps.ts, src/types.ts, plugins/keeper/skills/query/SKILL.md, test/db.test.ts, test/reducer-lifecycle.test.ts, test/refold-equivalence.test.ts, test/collections.test.ts, test/epic-deps.test.ts, test/query.test.ts

### Approach

Remove `usage` and `profiles` as live query/projection surfaces, delete UsageSnapshot/UsageDeleted folds and profile/rate-limit fan-outs, and append one forward-only destructive migration that leaves those tables absent at schema head. Historical additive steps still execute during a fresh zero-to-head migration; the final retirement step is idempotent so bootstrap cannot resurrect the tables.

Preserve task 3's explicit jobs `account_route` attribution and unrelated API-error/instant-death-wall behavior. Legacy `config_dir`/`profile_name` columns may remain inert historical schema facts if dropping them would rebuild core event/job tables; no live descriptor, fold, join, statusline, or routing path may consume them.

Old usage events remain valid immutable history. A re-fold must advance safely past them without recreating a retired projection or throwing, and live-only rewind boundaries must remain unchanged.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/db.ts:5294 — usage projection schema and profile join contract
- src/db.ts:5336 — profiles projection schema
- src/db.ts:6863 — migration ladder execution semantics
- src/reducer.ts:3016 — UsageSnapshot fold and malformed-data safety
- src/reducer.ts:3221 — profiles-to-usage reverse fan-out
- src/reducer.ts:3357 — usage deletion fold
- src/reducer.ts:8389 — SessionStart profile seed
- src/reducer.ts:9033 — rate-limit profile/usage fan-out
- src/collections.ts:513 — profiles descriptor
- src/collections.ts:1018 — collection registry/allowlist
- src/epic-deps.ts:62 — profile/usage re-fold dependency declarations

**Optional** (reference as needed):
- test/refold-equivalence.test.ts:3583 — precedent for a historical table present during old steps and absent at head
- test/db.test.ts:379 — schema fingerprint pin
- test/rebase-schema-migration.test.ts:86 — destructive-step merge/renumber guard

### Risks

This is a destructive schema-singleton change and cannot be mechanically renumbered across a collision; assign its version at merge time. Deleting folds must not make an old event a dead letter. Removing profile fan-outs must not remove independent rate-limit/instant-death evidence or task 3's attribution.

### Test notes

Cover fresh zero-to-head, pre-retirement upgrade, idempotent reopen, re-fold over historical usage/profile events, schema fingerprint, collection allowlists, and absence of prepared statements against dropped tables. Use `freshMemDb`/`freshDbFile`; no real daemon or migration subprocess.

### Detailed phases

1. Remove query descriptors, projection statements, joins, fan-outs, and reducer dispatch while retaining safe no-op handling for historical events.
2. Append the version-guarded destructive schema step and re-pin the fingerprint.
3. Prune deterministic rewind/delete sets and dependency declarations without touching live-only surfaces.
4. Prove zero-to-head, upgrade, reopen, and re-fold equivalence.

### Alternatives

Retaining empty compatibility tables was rejected because they would remain misleading live projections. Rebuilding the core events/jobs tables solely to erase inert historical columns was rejected as disproportionate risk; those columns carry no live account-routing semantics.

### Non-functional targets

Fold cost remains constant-bounded and deterministic. The migration never reads wall clock, environment, filesystem, or liveness. No query can address retired collections after schema head.

### Rollout

Merge after runtime producers and consumers are gone, so no deployed code writes or queries the tables after the migration lands. A rollback must restore code and schema from source/backup explicitly; the archive is unrelated to the database migration.

## Acceptance

- [ ] `usage` and `profiles` are absent from the head schema, collection registry, query allowlist, reducer writes, and prepared statements.
- [ ] A fresh database can execute historical steps and finishes without recreating either retired table.
- [ ] An upgraded database drops the tables idempotently and reopens cleanly.
- [ ] Historical usage/profile events advance through re-fold without dead letters or projection resurrection.
- [ ] Explicit account-route attribution, API-error evidence, instant-death behavior, and live-only rewind invariants remain intact.
- [ ] Schema fingerprint, migration, collection, reducer, and re-fold tests pass.

## Done summary
Retire the usage/profiles projections at schema v120: DROP both tables unconditionally at the tail (event_blobs precedent), remove their query descriptors/collection registry/allowlist entries, delete the UsageSnapshot/UsageDeleted/profile fan-out fold arms (replaced with explicit no-ops), and prune the now-dead usageIdForProfileName/profileNameForUsageId helpers. Preserved: jobs.config_dir/profile_name as inert historical facts, account_route attribution, and RateLimited/ApiError's last_api_error_at/kind stamp.
## Evidence

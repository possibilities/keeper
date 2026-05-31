## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/daemon.ts, src/collections.ts, CLAUDE.md, README.md, test/reducer.test.ts, test/db.test.ts, test/collections.test.ts

### Approach

Ingest agentuse's new `lift_at` and add a real freshness stamp, both
riding the existing `UsageSnapshot` path (the percentage path — NOT the
rate-limit fan-out).

1. **Schema (src/db.ts).** Bump `SCHEMA_VERSION` 38→**39** (claim the
   next free version at impl time; rebase if fn-648/fn-650 took it). Add
   a `v38→v39` migrate slot; `addColumnIfMissing`:
   - `usage.rate_limit_lifts_at TEXT` (ISO, mirrors `session_resets_at`),
   - `usage.last_usage_fold_at REAL` (unix-seconds; freshness stamp).
   Add both to the `CREATE TABLE` DDL (NULL defaults). No data backfill.
2. **Ingest lift_at (src/reducer.ts `parseUsageSnapshot`, ~ln 2031-2200).**
   Parse `lift_at` from the envelope/event into `rate_limit_lifts_at`
   exactly like `session_resets_at` (TEXT ISO; null-safe).
3. **Freshness stamp (src/reducer.ts UsageSnapshot fold).** Set
   `last_usage_fold_at` to the EVENT's `ts` ONLY when the snapshot
   carries successful usage (status active / usage present) — NOT on
   idle/stale snapshots, and NEVER in the rate-limit (RateLimited/
   ApiError) fold. This is the determinism boundary: the value is the
   event ts, never `Date.now()`.
4. **Serializer (src/daemon.ts ~ln 1218).** Extend the `UsageSnapshot`
   serializer (already fixed in task .1) to also forward `lift_at`.
   (`last_usage_fold_at` is derived in the fold from the event ts, so it
   is NOT a serialized payload field.)
5. **Descriptor (src/collections.ts).** Add `rate_limit_lifts_at` and
   `last_usage_fold_at` to `USAGE_DESCRIPTOR` columns (~ln 400-419).
6. **Carve-out check.** Ensure the rate-limit fan-out (RateLimited/
   ApiError UPDATE) does NOT touch the new columns (they belong to the
   percentage path) — mirror the existing schema-v35 carve-out so a
   rate-limit fold can't clobber a lift/freshness value, and so a
   `UsageSnapshot` doesn't get its lift clobbered by a rate-limit.
7. **Docs.** CLAUDE.md schema-version pin + usage-column-set prose;
   README `## Architecture` "As of schema v39".

### Investigation targets

**Required** (verify line numbers — repo-scout mis-IDed a file earlier):
- src/reducer.ts ~ln 2031-2200 — `parseUsageSnapshot` (the `session_resets_at` parse is the template) + the UsageSnapshot fold arm where the freshness stamp lands.
- src/reducer.ts ~ln 4733-4880 — the RateLimited/ApiError fold + the schema-v35 carve-out precedent (the new columns must NOT be in this UPDATE).
- src/db.ts ~ln 60 `SCHEMA_VERSION`; ~ln 3766 the v37→v38 ADD-COLUMN slot (template).
- src/daemon.ts ~ln 1218 — the serializer extended in task .1.
- src/collections.ts ~ln 400-419 — `USAGE_DESCRIPTOR`.

### Risks

- **Schema-version race** with fn-648/fn-650 on the same `migrate()` slot — claim next free at impl; rebase if taken.
- **Freshness-stamp determinism** — must be the event `ts`, gated on a successful usage fold; a wall-clock read or stamping on rate-limit/idle folds breaks re-fold determinism and the warning's meaning.
- **Two-paths discipline** — `rate_limit_lifts_at`/`last_usage_fold_at` ride UsageSnapshot; keep them out of the rate-limit UPDATE (carve-out) so the two folds don't clobber each other.
- **Re-fold** — old UsageSnapshot events have no `lift_at` → null; events predating "successful usage" semantics → null freshness; from-scratch re-fold must reproduce byte-identically.

### Test notes

Reducer: a successful `UsageSnapshot` with `lift_at` stamps
`rate_limit_lifts_at` + `last_usage_fold_at`(=event ts); an idle/stale
snapshot does NOT bump `last_usage_fold_at`; a RateLimited fold touches
neither new column; from-scratch re-fold byte-identical. db: v38→v39
adds both columns (NULL on existing rows); fresh-DB schema == migrated
schema. collections: both columns ride the usage wire.

## Acceptance

- [ ] `SCHEMA_VERSION` → v39 with a slot adding `usage.rate_limit_lifts_at TEXT` + `usage.last_usage_fold_at REAL` (DDL + ALTER, NULL default, no backfill).
- [ ] `parseUsageSnapshot` ingests `lift_at` → `rate_limit_lifts_at`; `src/daemon.ts` forwards `lift_at`.
- [ ] `last_usage_fold_at` is stamped from the event `ts` only on a successful usage fold (not idle/stale/rate-limit); re-fold is byte-identical.
- [ ] The rate-limit fan-out does not write either new column (carve-out preserved both directions).
- [ ] Both columns ride `USAGE_DESCRIPTOR`; CLAUDE.md + README updated.

## Done summary
Bumped SCHEMA_VERSION 40→41 with two additive nullable usage columns (rate_limit_lifts_at TEXT, last_usage_fold_at REAL) riding the existing UsageSnapshot percentage path. The lift_at envelope field ingests via parseUsageSnapshot into rate_limit_lifts_at; last_usage_fold_at is stamped from the event ts ONLY on a successful usage fold (status active or any per-window percent non-null), preserved through idle/stale folds via COALESCE, and carved out of the rate-limit fan-out's UPDATE (symmetric to v35's last_rate_limit_* carve-out) so the two folds can't clobber each other. Determinism boundary preserved (event ts, never Date.now). Tests cover schema-shape + v40→v41 migration in db.test.ts; the lift_at fold, freshness gate (successful/idle/stale), carve-out, COALESCE preservation, and from-scratch re-fold byte-identity in reducer.test.ts; descriptor columns in collections.test.ts; serializer in daemon.test.ts; buildUsageMessage and gate-emit shape in usage-worker.test.ts. keeper-py whitelist bumped (whitelist-only, no reader logic change). CLAUDE.md + README v41 prose added.
## Evidence

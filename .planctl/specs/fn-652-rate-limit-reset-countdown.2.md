## Description

**Size:** M
**Files:** src/transcript-worker.ts, src/daemon.ts, src/db.ts, src/reducer.ts, CLAUDE.md, README.md, test/transcript-worker.test.ts, test/reducer.test.ts, test/db.test.ts

### Approach

Thread the parsed lift time from producer to projection. The parser
(task .1) is called ONCE at producer time; the value rides the event
payload; the reducer only reads it. No backfill, so the parser is NOT
imported by the reducer or the migration — re-fold reads the stored
payload field and is pure regardless of the parser.

1. **Producer (src/transcript-worker.ts).** In the api-error path, call
   `parseRateLimitResetAt(text, <event ts>)` anchored on the synthetic
   event's `ts`. Carry the result as a new optional field (e.g.
   `rateLimitResetsAt?: number`) on `ApiErrorMessage` (~ln 101-107) and
   thread it through `matchApiError` (~ln 235-277), the `onApiError`
   callback signature (append the new arg, ~ln 410-422), the
   `dispatchLine` is-api-error branch (~ln 772-784), and the worker
   `main` post (~ln 901-908). Update the docstring (~ln 92-99) — the
   worker now parses the reset clock.
2. **Mint (src/daemon.ts ~ln 769).** Add the field to the synthetic
   `ApiError` event's data blob: `JSON.stringify({ kind, text, resetsAt })`.
3. **Extract (src/reducer.ts).** Add `extractApiErrorResetsAt(event)`
   mirroring `extractApiErrorKind` (~ln 252-255): safe-parse, fold to
   `null` on a malformed/absent field — never throw inside the fold.
4. **Schema (src/db.ts).** Bump `SCHEMA_VERSION` 38→**39** (claim the
   next free version at implementation time; if fn-648/fn-650 already
   took 39, rebase to the next). Add a `v38→v39` migrate slot;
   `addColumnIfMissing` `profiles.last_rate_limit_resets_at REAL` and
   `usage.last_rate_limit_resets_at REAL`. Add the columns to the
   `CREATE TABLE` DDL too (defaults match the zero-event projection:
   NULL). **No data backfill** — column is NULL on pre-v39 rows and
   populates on the next rate-limit fan-out (matches the v35
   no-backfill precedent for `last_rate_limit_at`).
5. **Forward fan-out (src/reducer.ts dual-case RateLimited/ApiError arm,
   ~ln 4818-4878).** Add `last_rate_limit_resets_at` to the `profiles`
   UPSERT column list + the `ON CONFLICT DO UPDATE` excluded clause, and
   to the forward `UPDATE usage SET ... WHERE id = projectBasename(...)`
   (keep the `profile_name != ''` guard and the load-bearing
   `last_event_id` bump).
6. **Reverse fan-out (src/reducer.ts `projectUsageRow`, ~ln 2150-2229).**
   THREE sites: add the column to the usage UPSERT `ON CONFLICT` carve-out
   (so a `UsageSnapshot` re-snapshot can't clobber it), to the post-UPSERT
   `SELECT ... FROM profiles WHERE profile_name = ? AND profile_name != ''`,
   and to the subsequent `UPDATE usage`.
7. **Semantics.** `last_rate_limit_resets_at` is INDEPENDENT of the
   `(last_rate_limit_at, last_rate_limit_session_id)` pair — it may be
   NULL while the pair is set (parse failed). A new rate-limit with an
   unparseable reset overwrites a previously-parsed value with NULL
   (last-write-wins via the excluded clause) — intended.
8. **Docs.** Update CLAUDE.md (schema-version pin; the fan-out column-set
   prose everywhere the `last_rate_limit_at` pair is named, incl. the
   `projectUsageRow` carve-out list) and README.md `## Architecture`
   (the "As of schema v39" sentence). Reducer inline comments name the
   new column.

### Investigation targets

**Required** (read before coding — repo-scout mis-identified one file, so
VERIFY every line number against the live source before relying on it):
- src/reducer.ts ~ln 4733-4880 — the dual-case RateLimited/ApiError fold arm (the fan-out template; follow byte-for-byte).
- src/reducer.ts ~ln 2141-2230 — `projectUsageRow` reverse fan-out (the three-site reverse path + carve-out).
- src/reducer.ts ~ln 252-255 — `extractApiErrorKind` (the safe-parse shape to clone).
- src/db.ts ~ln 3766 — the v37→v38 (fn-645) migrate slot as the ADD-COLUMN template; ~ln 60 `SCHEMA_VERSION`.
- src/daemon.ts ~ln 737-787 — where the synthetic `ApiError` event + its data blob are minted.
- src/transcript-worker.ts ~ln 92-107, 235-277, 410-422, 772-784, 901-908 — the producer plumbing.

**Optional:**
- test/reducer.test.ts ~ln 2565-2933 — existing RateLimited fan-out + from-scratch re-fold determinism tests (the template for the new assertions).

### Risks

- **Three-site reverse fan-out** — missing any of the carve-out / SELECT / UPDATE breaks one direction of the bidirectional sync silently. Test both directions.
- **Schema-version race** with fn-648/fn-650 on the same `migrate()` slot — claim the next free version at implementation time; rebase if taken.
- **Legacy `RateLimited` events** carry no `data.text` and no `resetsAt` — the extractor must return `null` gracefully; re-fold of old events yields NULL resets (consistent with no-backfill).
- **Determinism** — the fold must read `data.resetsAt` only and NEVER call the parser or `Date.now()`; a from-scratch re-fold must reproduce byte-identical rows.

### Test notes

Reducer: an `ApiError(kind=rate_limit)` with `resetsAt` stamps the new
column on both `profiles` and `usage` (forward), and a subsequent
`UsageSnapshot` preserves it (reverse carve-out); a malformed
`data.resetsAt` folds to NULL without throwing; from-scratch re-fold is
byte-identical (old events → NULL, new events → stored value). db: the
v38→v39 migration adds the column, NULL on existing rows, and a fresh-DB
schema equals a migrated-DB schema. transcript-worker: the api-error path
carries `rateLimitResetsAt` through to the posted message.

## Acceptance

- [ ] A `rate_limit` `ApiError` with a parseable reset projects `last_rate_limit_resets_at` onto `profiles` AND `usage` in both fan-out directions; an unparseable one projects NULL.
- [ ] `SCHEMA_VERSION` bumped with a `v38→v39` slot adding the REAL column to both tables (DDL + ALTER), NULL default, NO data backfill.
- [ ] The reducer reads the stored payload field only (never re-parses, never reads the wall clock); from-scratch re-fold reproduces byte-identical `profiles`/`usage` rows.
- [ ] Malformed/absent `data.resetsAt` folds to NULL without throwing; the cursor still advances.
- [ ] CLAUDE.md schema-version pin + fan-out prose and README `## Architecture` updated to match the new column.

## Done summary

## Evidence

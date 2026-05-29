## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/collections.ts, test/reducer.test.ts, test/collections.test.ts, test/db.test.ts, CLAUDE.md, README.md

### Approach

Add a new top-level `profiles` projection keyed by `config_dir`, maintained
entirely by reducer fan-outs inside the existing `BEGIN IMMEDIATE` transaction
(cursor + projection advance together — never split across transactions).

1. **Schema (`src/db.ts`).** Add a documented `CREATE_PROFILES` const near
   `CREATE_USAGE` (~:578), following the house doc-comment style:
   `config_dir TEXT NOT NULL PRIMARY KEY` (the `''` sentinel = default `~/.claude`;
   NOT NULL is load-bearing — SQLite treats multiple NULL PK rows as distinct,
   so a nullable PK + `INSERT OR IGNORE` would NOT dedupe), `last_rate_limit_at REAL`
   (NULL until first rate_limit), `last_rate_limit_session_id TEXT`,
   `last_event_id INTEGER`, `updated_at REAL NOT NULL DEFAULT 0`. Run the
   `CREATE TABLE IF NOT EXISTS` in the unconditional bootstrap block (idempotent).
   Bump `SCHEMA_VERSION` to the next free value (currently 32; fn-637.2 claims 33
   and this epic depends on fn-637 — target **v34**, but READ `SCHEMA_VERSION` at
   `src/db.ts:57` at impl time and use whatever is next free) and add a guarded
   migrate slot at the end of `migrate()` (~:2870-2929) with the `meta` stamp.

2. **SessionStart seed (`src/reducer.ts` ~:3629-3668).** In the existing
   SessionStart arm, after the jobs upsert, fan out:
   `INSERT OR IGNORE INTO profiles (config_dir, last_event_id, updated_at) VALUES (COALESCE(?, ''), ?, ?)`
   binding `event.config_dir`, `event.id`, `ts`. This seeds a visible row for
   every unique profile (quiet or not) — stamping `last_event_id`/`updated_at`
   makes the seed fire a wire patch so subscribers see the profile appear.
   `last_rate_limit_*` stay NULL. Pure function of the event (no `Date.now`/env).

3. **Rate-limit fan-out (`src/reducer.ts` ~:3935-3998 RateLimited/ApiError arm).**
   Gate on the already-resolved `kind === "rate_limit"` local (line ~3963-3966 —
   do NOT re-derive; this covers both the legacy `RateLimited` event_type and the
   v24 `ApiError` mint). Read the session's `config_dir` from `jobs` in-transaction,
   null-guarding the row exactly like `syncIfPlanRef` (~:2714-2738) — if the jobs
   row is absent, skip (cursor still advances). Then UPSERT so a rate limit is
   never dropped:
   `INSERT INTO profiles (config_dir, last_rate_limit_at, last_rate_limit_session_id, last_event_id, updated_at) VALUES (COALESCE(?, ''), ?, ?, ?, ?) ON CONFLICT(config_dir) DO UPDATE SET last_rate_limit_at = excluded.last_rate_limit_at, last_rate_limit_session_id = excluded.last_rate_limit_session_id, last_event_id = excluded.last_event_id, updated_at = excluded.updated_at`
   using `ts` for `last_rate_limit_at`, the session id, `event.id`, `ts`.
   Last-write-wins (events fold in id order — no max() guard needed). Use the
   SAME `COALESCE(config_dir,'')` expression as the seed so a NULL-config session's
   rate limit lands on the exact `''` row it seeded.

4. **Descriptor (`src/collections.ts`).** Add `PROFILES_DESCRIPTOR` mirroring
   `USAGE_DESCRIPTOR` (~:364): `name: "profiles"`, `table: "profiles"`, columns
   = the five table columns, `pk: "config_dir"`, `version: "last_event_id"`,
   `sortable` over `config_dir`/`last_rate_limit_at`/`last_event_id`/`updated_at`,
   `defaultSort: { column: "config_dir", dir: "asc" }`, `filters: { config_dir: "config_dir" }`,
   `jsonColumns: new Set()`. Register `[PROFILES_DESCRIPTOR.name, PROFILES_DESCRIPTOR]`
   in the REGISTRY map (~:445-451). No server-worker changes needed.

5. **Docs.** Thread both fan-outs into CLAUDE.md's "Cursor + projection advance in
   the SAME `BEGIN IMMEDIATE`" enumeration inline with a `schema-vNN (fn-...)`
   citation; update README.md collections count (five→six, splice after `usage`),
   the Architecture schema-version trail (worker count UNCHANGED — no new worker),
   and add a `profiles` sqlite3 snippet to the Inspect section.

### Investigation targets

**Required** (read before coding):
- src/db.ts:57 — current `SCHEMA_VERSION` (read the live value; do not trust a hardcoded number)
- src/db.ts:578-592 — `CREATE_USAGE`, the closest table analog + doc-comment style
- src/db.ts:2870-2929 — the v31→v32 migrate slot + `meta` stamp; add the next guarded block here
- src/reducer.ts:3629-3668 — SessionStart arm (binds `event.config_dir`, COALESCE on conflict)
- src/reducer.ts:3935-3998 — RateLimited/ApiError dual-case arm; `kind` resolved at ~3963-3966, `res.changes` guard at ~3992
- src/reducer.ts:2714-2738 — `syncIfPlanRef`, the in-transaction read-then-write + null-guard precedent
- src/collections.ts:364-386 — `USAGE_DESCRIPTOR` template; :445-451 — REGISTRY map
- test/reducer.test.ts:2450-2502 — usage re-fold determinism test to copy verbatim for `profiles`

**Optional** (reference as needed):
- src/db.ts:649-680 — `CREATE_FILE_ATTRIBUTIONS`, a documented v31 table + index-in-migrate-slot pattern
- src/types.ts:38-65 — `ApiErrorKind` union + `API_ERROR_KINDS` (no change needed; filter to literal `"rate_limit"`)
- test/collections.test.ts:151-175 — descriptor test to parallel for `profiles`
- test/db.test.ts:321,379 — schema_version stamp + per-version migration test patterns

### Risks

- Re-fold non-determinism if any fan-out reads `Date.now`/env/OS state — use `event.ts`/`event.id` only.
- Mismatched `COALESCE(config_dir,'')` between seed and rate-limit arm → orphaned/duplicate buckets. Use the identical expression in both.
- A throw inside the fold (unguarded NULL `jobs` row read) wedges the reducer — null-guard like `syncIfPlanRef`.
- Schema-version collision with fn-637.2 (epic dep wires the ordering) — verify the next free `SCHEMA_VERSION` at impl time.
- Re-fold tooling/tests must `DELETE FROM profiles` alongside the other projection wipes.

### Test notes

- Copy test/reducer.test.ts:2450-2502 (usage re-fold determinism) for `profiles`: seed SessionStart (with `config_dir` override) + ApiError(rate_limit) events, drain, snapshot `SELECT * FROM profiles ORDER BY config_dir`, rewind cursor + `DELETE FROM profiles`, re-drain, assert byte-identical.
- Cover: default-profile (`config_dir` NULL → `''` bucket), distinct profiles get distinct rows, last-write-wins on a second rate_limit, seed-only profile renders with NULL `last_rate_limit_at`.
- Add a `profiles` descriptor assertion (parallel to the usage block) and a v→v+1 migration test asserting the table + columns exist after `openDb`.

## Acceptance

- [ ] `profiles` table created (`config_dir TEXT NOT NULL PRIMARY KEY`, `last_rate_limit_at`, `last_rate_limit_session_id`, `last_event_id`, `updated_at`); `SCHEMA_VERSION` bumped to the next free value with a guarded migrate slot
- [ ] SessionStart seeds one visible row per unique `config_dir` (default → `''`); rate_limit upserts `last_rate_limit_at` + `last_rate_limit_session_id` keyed on the same `COALESCE(config_dir,'')`
- [ ] Both fan-outs run inside the existing `BEGIN IMMEDIATE`; from-scratch re-fold reproduces `profiles` byte-identically (test passes)
- [ ] `PROFILES_DESCRIPTOR` registered; `getCollection("profiles")` resolves it; descriptor + migration tests pass
- [ ] CLAUDE.md invariant enumeration + README collections/schema/inspect docs updated

## Done summary

## Evidence

## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, keeper/api.py, CLAUDE.md, test/db.test.ts, test/reducer.test.ts

### Approach

Add `name_history TEXT NOT NULL DEFAULT '[]'` to the `jobs` projection and
append distinct titles to it in the reducer, in lockstep with a v38→v39
schema bump. Steps:

1. `src/db.ts`: bump `SCHEMA_VERSION` 38→39 (line 60); add the column to the
   `CREATE_JOBS` literal after `profile_name` (~line 569), mirroring
   `epic_links` (line 560, `TEXT NOT NULL DEFAULT '[]'`); add an
   `addColumnIfMissing(db, "jobs", "name_history", "TEXT NOT NULL DEFAULT '[]'")`
   slot after line 3794 with a `v38→v39` doc-comment, following the
   `profile_name` exemplar at 3712; add a `preMigrateStoredVersion < 39`
   guarded backfill (pattern at 3713-3736) that seeds `name_history` =
   `["<title>"]` for every existing row with a non-null `title` (and `'[]'`
   where title is null).
2. `src/reducer.ts`: in the title precedence-write block (5048-5074), when
   the guard fires that advances `title` to a NEW distinct value
   (`p > pp || (p === pp && row.title !== title)`), read the persisted
   `name_history` cell from the same in-txn row, append the new title iff
   not already the last element (dedupe), cap to the most-recent 20,
   `JSON.stringify`, and include `name_history = ?` in the same `UPDATE`.
   Seed it on the SessionStart spawn insert (4392-4429) so a spawned job
   starts with `["<spawn name>"]`. Respect the RESUME no-touch invariant
   (4373-4375) — do not re-append or clobber on resume.
3. `keeper/api.py`: add `39` to `SUPPORTED_SCHEMA_VERSIONS` (line 43) with a
   matching doc-comment line — MUST land in this same change or every
   `jobctl commit-work` on the host fails (CLAUDE.md:290-298). Update the
   "Current version" prose at CLAUDE.md:298.
4. Tests: a migration/column test in `test/db.test.ts` (fresh-DB literal ==
   migrated-DB shape; backfill seeds existing rows) and a reducer fold test
   in `test/reducer.test.ts` (distinct-advance appends; same-title no-op;
   dedupe; cap; re-fold determinism). Keep `test/schema-version.test.ts`
   green (adding 39 to the frozenset satisfies `max(supported) >= SCHEMA_VERSION`).

The dedupe/order/cap MUST be a pure function of the persisted array + the
incoming title (no timestamps, no event-arrival ordering) so a
from-scratch re-fold is byte-identical.

### Investigation targets

**Required** (read before coding):
- src/db.ts:60 — `SCHEMA_VERSION = 38` (bump to 39)
- src/db.ts:546-571 — `CREATE_JOBS` literal; `epic_links` at 560 is the JSON-array exemplar; `profile_name` at 569 is the last column
- src/db.ts:1146-1159 — `addColumnIfMissing` helper (do not hand-write the ALTER)
- src/db.ts:3712-3736 — `profile_name` additive slot + the `preMigrateStoredVersion < 36` guarded-backfill pattern to mirror; add the new slot after 3794
- src/db.ts:3820-3822 — the single `meta` schema_version stamp
- src/reducer.ts:5048-5074 — the title precedence-write block (the append hook point); reads persisted `(title, title_source)` in-txn
- src/reducer.ts:4392-4429 — SessionStart `INSERT ... ON CONFLICT DO UPDATE` spawn-title seed; 4373-4375 RESUME no-touch
- src/reducer.ts:321-373 — `TITLE_PRIORITY` / `sourcePriority` / `extractSessionTitle` / `titleSourceForEvent` (don't re-derive precedence)
- keeper/api.py:43 — `SUPPORTED_SCHEMA_VERSIONS` (+ doc-comment block 28-42)
- test/schema-version.test.ts:28-60 — drift-guard (frozenset must stay single-line parseable; only max matters)
- CLAUDE.md:286-312 — migration invariants; 290-298 the whitelist-gates-commit-work-host-wide warning

**Optional** (reference as needed):
- src/collections.ts:157 — `jsonColumns` / `epic_links` (only if UDS exposure is later wanted — OUT of scope here)

### Risks

- **Whitelist lockstep**: bumping SCHEMA_VERSION without adding 39 to keeper-py SUPPORTED_SCHEMA_VERSIONS breaks `commit-work` for the whole host. Land both in one change.
- **Re-fold determinism**: append must derive purely from the persisted cell + incoming title, or a rebuild diverges.
- **RESUME**: must not touch name_history on resume (mirror the title no-touch).
- **Backfill idempotency**: the seed-existing-rows step must be `preMigrateStoredVersion < 39` guarded so a re-run doesn't double-apply.

### Test notes

Verify fresh-DB CREATE literal and migrated-DB shape match; backfill seeds
existing titled rows; reducer appends on distinct advance, no-ops on repeat,
dedupes, caps at 20; a full re-fold from the event log reproduces identical
name_history. `bun test` + keep schema-version drift-guard green.

## Acceptance

- [ ] `jobs.name_history TEXT NOT NULL DEFAULT '[]'` in both CREATE_JOBS and an addColumnIfMissing slot; SCHEMA_VERSION = 39
- [ ] Reducer appends a new distinct title (deduped, ordered, capped 20) on title-advance; seeds on spawn; no-touch on resume; re-fold deterministic
- [ ] v38→v39 guarded backfill seeds existing titled rows with `[title]`
- [ ] keeper-py SUPPORTED_SCHEMA_VERSIONS includes 39; `test/schema-version.test.ts` green; CLAUDE.md version prose updated
- [ ] new db + reducer tests pass; full `bun test` green

## Done summary

## Evidence

## Description

**Size:** M
**Files:** src/reducer.ts, src/db.ts, src/epic-deps.ts, keeper/api.py, test/reducer.test.ts, CLAUDE.md, README.md

### Approach

Add one shared, pure, directional mapping helper (string→string, no DB/clock/env
reads) that resolves keeper's `''` default-profile sentinel to agentuse's
`"default"` usage id and back. Natural home: `src/epic-deps.ts` next to
`projectBasename` (already imported by both `reducer.ts:119` and `db.ts:44`), or
a small local helper in `reducer.ts` — but it must live in exactly ONE place
with the `'default'` magic string appearing exactly once. Suggested shape: a
forward `usageIdForProfileName(profileName) → profileName === "" ? "default" : profileName`
and a reverse `profileNameForUsageId(usageId) → usageId === "default" ? "" : usageId`,
or a single bidirectional helper — planner's discretion, but document the
direction and the agentuse `"default"` contract in a comment citing the design doc.

Wire it into the two fan-out arms only:
- **Forward arm** (`src/reducer.ts:5238-5249`, RateLimited/ApiError `kind==="rate_limit"`):
  today `if (profileName !== "") { UPDATE usage ... WHERE id = profileName }`.
  Change so a `''` profileName targets `WHERE id = 'default'` instead of being
  skipped. Keep the UPDATE's column set IDENTICAL (v41 carve-out at :5225-5237 —
  must NOT touch `rate_limit_lifts_at` / `last_usage_fold_at`). The `profiles`
  UPSERT just above (`COALESCE(?, '')`) is UNCHANGED — only the downstream
  `usage`-targeting UPDATE gets the mapping.
- **Reverse arm** (`src/reducer.ts:2553-2573`, `projectUsageRow` post-UPSERT SELECT):
  today `SELECT ... FROM profiles WHERE profile_name = ? AND profile_name != ''`
  bound to `usage.id`. Change so `id === 'default'` binds the lookup to
  `profile_name = ''` instead of applying the `!= ''` exclusion. Preserve the
  `?? null` NULL-safety and the deliberate non-re-bump of `last_event_id`
  (:2549-2552).

Schema bump v41→v42 in `src/db.ts` (constant at :60). No column ALTER — this is
a fold-output change, same justification as fn-648/v39 (cite :3908-3914). Add a
version-guarded (`preMigrateStoredVersion < 42`) rewind-and-redrain inside the
`.immediate()` transaction (template: v17→v18 at :2556-2577): `UPDATE
reducer_state SET last_event_id = 0 WHERE id = 1` + DELETE the projection tables
the standard rewind sweeps PLUS `DELETE FROM usage` and `DELETE FROM profiles`
(both are full projections of the event log → reconstructed by the boot drain;
deleting them is what makes the backfill clean and byte-identical-determinism-safe).
MUST NOT touch `dead_letters`. Verify the exact standard DELETE set against the
v39 block (:3902-4021) before writing.

Add `42` to `keeper-py`'s `SUPPORTED_SCHEMA_VERSIONS` frozenset (`keeper/api.py:73`)
with a rationale comment in the existing per-version style (whitelist-only —
keeper-py reads neither usage nor profiles).

Revise docs in place: CLAUDE.md "Current version: v41" → v42 + fn parenthetical,
and the v35/fn-642 fan-out prose; README.md v35 colocation block (~899-920) +
profiles schema comment (~1172). Do NOT stack a new "as of v42" paragraph — fold
the correction into the v35 narrative since v42 corrects v35's behavior.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:5177-5249 — forward arm + the profiles UPSERT that seeds `''`; the v41 carve-out comment
- src/reducer.ts:2537-2573 — reverse arm SELECT + UPDATE, the `!= ''` guard, the last_event_id non-bump note
- src/epic-deps.ts:49-56 — projectBasename (sentinel origin; helper-home candidate)
- src/db.ts:60 — SCHEMA_VERSION; :2556-2577 (v17/v18 pure rewind); :3902-4021 (v39 no-ALTER bump precedent); :4143-4145 (version stamp tail, inside .immediate())
- keeper/api.py:55-73 — SUPPORTED_SCHEMA_VERSIONS frozenset + comment style
- test/reducer.test.ts:3375-3686 — fn-642 forward (:3380) / reverse (:3519) tests; the inverted `'' never joins` test (:3639-3686); re-fold pattern (:3466, :3688); harness insertEvent (:50), drainAll (:4066)

**Optional** (reference as needed):
- cli/usage.ts:393-414 — renderer gate (confirm it's purely `last_rate_limit_at` / `rate_limit_lifts_at` on the usage row; OUT of scope to edit)
- test/schema-version.test.ts — asserts max(SUPPORTED) >= SCHEMA_VERSION

### Risks

- **Inverted existing test** (`test/reducer.test.ts:3639-3686`, `'' sentinel never joins a usage row`): its concrete assertion (pathological literal `id=''` mints no row → count 0) STAYS TRUE because of the early empty-session-id guard, but its name/intent is now misleading. Rename/rewrite to assert "literal `id=''` stays non-joinable (directional mapping)" and ADD a positive `id='default'` colocation test — do NOT delete the pathological-`''` coverage.
- **Re-fold cost:** the one-time v42 rewind re-folds the whole log, bounded by existing BOOT_DRAIN_PACE. Only fires once (version-guarded).
- **Magic string sprawl:** `'default'` must appear exactly once (in the helper). A second inline occurrence is the drift bug practice-scout flagged.
- **`default`-basename collision** (accepted edge): a profile literally basenamed `default` would already hit `WHERE id='default'` and last-write-wins with the sentinel — document, don't build handling.

### Test notes

In `test/reducer.test.ts`, add (mirroring the fn-642 templates):
- Forward: SessionStart with NULL config_dir → UserPromptSubmit → RateLimited; assert `usage WHERE id='default'` has `last_rate_limit_at` set. (Seed `usage.default` first via a `UsageSnapshot` with `session_id:'default'`.)
- Reverse: `''`-row rate limit exists, then a `default` UsageSnapshot folds; assert the annotation is pulled onto `usage.default`.
- Negative: literal `id=''` still non-joinable (preserve/rename the existing :3639 test).
- Re-fold determinism (pattern at :3466/:3688): fold, capture usage+profiles, `last_event_id=0`, drainAll, `toEqual` the captured state.
Run `bun test test/reducer.test.ts test/schema-version.test.ts` then the full `bun test`.

## Acceptance

- [ ] One shared pure directional helper resolves `''↔'default'`; `'default'` literal appears exactly once
- [ ] Forward arm colocates a NULL-config RateLimited onto `usage.default` (UPDATE column set unchanged per v41 carve-out)
- [ ] Reverse arm pulls the `''` profiles annotation when `usage.id==='default'`; NULL-safe; no last_event_id re-bump
- [ ] Literal `usage.id=''` remains non-joinable (directional mapping verified by test)
- [ ] v42 bump + version-guarded rewind-and-redrain (cursor reset + DELETE projections incl. usage+profiles, excl. dead_letters) in one BEGIN IMMEDIATE
- [ ] `42` in keeper-py SUPPORTED_SCHEMA_VERSIONS; test/schema-version.test.ts green
- [ ] New forward + reverse + negative + re-fold-determinism tests pass; full `bun test` green
- [ ] CLAUDE.md + README.md revised in place (no stacked v42 paragraph)

## Done summary

## Evidence

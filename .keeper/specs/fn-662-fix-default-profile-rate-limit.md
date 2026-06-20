## Overview

A real session rate limit on the `default` Claude account (the `~/.claude`
profile, no `CLAUDE_CONFIG_DIR`) never renders the `rate-limited` line on the
`keeper usage` TUI. Named profiles render correctly, so the surface works — it
just can't reach the default account. Root cause: the v35/fn-642 bidirectional
rate-limit fan-out joins `usage.id = profiles.profile_name` and both arms guard
`profile_name != ''`. agentuse writes the default account as `usage.id = "default"`;
keeper seeds its default profile under the empty-string sentinel
(`config_dir = ''`, `profile_name = ''`). `'' != 'default'` → the annotation
strands on the `''` profiles row and never colocates onto `usage.default`, so
the renderer's `last_rate_limit_at != null` gate suppresses the line.

Fix (Option A from the design doc): teach both fan-out arms that agentuse's
`"default"` usage id and keeper's `''` default-profile sentinel are the same
entity, via a single shared directional mapping helper. End state: a
default-account rate limit colocates `last_rate_limit_at` onto `usage.default`
and the existing renderer surfaces the line with no renderer change. Ships with
a v41→v42 schema bump + version-guarded rewind-and-redrain to backfill the
historically-stranded annotation and preserve byte-identical re-fold determinism.

Option B (widening the renderer gate to also honor `rate_limit_lifts_at`) is
explicitly OUT of scope. The agentuse daemon restart (so `default.json` carries
`lift_at`) is a separate side-action, not part of this keeper change.

## Quick commands

- `cd /Users/mike/code/keeper && bun test test/reducer.test.ts` — fan-out colocation + re-fold determinism
- `cd /Users/mike/code/keeper && bun test test/schema-version.test.ts` — keeper-py whitelist covers SCHEMA_VERSION
- `cd /Users/mike/code/keeper && bun test` — full suite
- `sqlite3 ~/.local/state/keeper/keeper.db "SELECT id, last_rate_limit_at FROM usage WHERE id='default'"` — post-rewind, default row carries the annotation

## Acceptance

- [ ] A default-profile (NULL `config_dir` → `''`) RateLimited event colocates `last_rate_limit_at` onto `usage` row `id='default'` (forward arm)
- [ ] A `default` UsageSnapshot pulls the `''` profiles row's rate-limit annotation (reverse arm)
- [ ] The `''→'default'` mapping is directional and lives in exactly one shared helper; literal `usage.id=''` is still non-joinable
- [ ] v41→v42 schema bump with a version-guarded rewind-and-redrain (cursor reset + DELETE projections incl. usage + profiles, NOT dead_letters) inside one BEGIN IMMEDIATE
- [ ] `42` added to keeper-py `SUPPORTED_SCHEMA_VERSIONS` in the same change; `test/schema-version.test.ts` passes
- [ ] Byte-identical re-fold determinism holds (fold → capture → rewind → re-fold → equal)
- [ ] CLAUDE.md + README.md prose revised in place to reflect the mapping (no stacked "as of v42" paragraph)

## Early proof point

Task that proves the approach: `<epic>.1` — the forward-arm colocation test
(NULL-config RateLimited → `usage.default.last_rate_limit_at` set) is the
smallest end-to-end proof the mapping threads. If it fails: the helper isn't
wired into the forward UPDATE's `WHERE id` target, or the `usage.default` row
isn't seeded in the test — check the UsageSnapshot insert.

## References

- `~/docs/keeper-default-profile-ratelimit-invisible.md` — diagnosis + Option A at lines 54-57
- `src/reducer.ts:5238-5249` — forward arm (RateLimited/ApiError); v41 carve-out at :5225-5237
- `src/reducer.ts:2553-2573` — reverse arm (projectUsageRow post-UPSERT SELECT)
- `src/reducer.ts:4822-4825` — SessionStart profiles seed (origin of `''` sentinel; leave intact)
- `src/db.ts:3902-4021` — fn-648/v39 precedent: version bump with NO column ALTER purely to gate a rewind
- `src/db.ts:2556-2616` — v17→v18 / v18→v19 pure rewind-and-redrain template
- `keeper/api.py:73` — SUPPORTED_SCHEMA_VERSIONS frozenset
- `test/reducer.test.ts:3375-3686` — fn-642 colocation tests; :3639 is the inverted `'' never joins` test

## Docs gaps

- **CLAUDE.md**: bump "Current version: v41" → v42 with an fn-XXX parenthetical describing the shared mapping helper; revise the v35/fn-642 fan-out prose (the "both directions guard `profile_name != ''`" framing is the root cause being fixed) in place
- **README.md**: fold the correction into the existing v35 rate-limit colocation block (~899-920); update the profiles projection schema comment (~1172) and the usage.ts example-clients note if it implies default rate limits are invisible
- **keeper/api.py**: add a v42 rationale comment alongside the frozenset entry (whitelist-only, keeper-py reads neither usage nor profiles)

## Best practices

- **Single pure mapping helper:** the `''↔'default'` translation must be one side-effect-free function (string→string, no DB/clock/env) called from both arms — bidirectional sync helpers drift the moment the mapping is inlined at multiple sites.
- **Directional, not symmetric:** `''→'default'` (forward) and `'default'→''` (reverse) only; the helper must never make a literal `usage.id=''` join the `''` profiles row (re-opening the cross-contamination the original guard prevented).
- **Determinism boundary:** no `Date.now()` in the helper or the migration backfill — the rewind is a pure cursor-reset + DELETE, and the mapping is a pure function of existing columns.
- **Rewind atomicity:** cursor reset + projection DELETEs in one `BEGIN IMMEDIATE`; never touch `dead_letters` (it is not a reducer projection and cannot be re-folded).

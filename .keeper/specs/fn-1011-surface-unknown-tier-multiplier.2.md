## Description

**Size:** M
**Files:** src/agent/shadow-profiles.ts, src/agent/main.ts, src/agent/dispatch.ts, README.md, test/shadow-profiles.test.ts, test/agent-dispatch.test.ts (or the profiles-check emit test)

### Approach

Add a `keeper agent profiles check` finding for the canonical `~/.claude` being authed
but tier-unresolvable, and complete the re-home runbook. DETECTOR: the fn-1010 detector
scans only `PROFILE_ROOTS` (~/.claude-profiles, ~/.pi-profiles); add a separate inspection
of `~/.claude` itself — fire when `oauthAccount` IS present (authed) AND its
`organizationRateLimitTier` is unresolvable (absent / not a string / not a known tier key /
file oversize) — i.e. the same predicate `parseTierMultiplier` (src/usage-scraper-worker.ts:276-294)
uses, MINUS the missing-oauthAccount arm (that = not authed, a different state). Scope to
`agent==="claude"` (pi has no tier). DB-FREE BOUNDARY: shadow-profiles.ts is a db-free leaf
and CANNOT import from usage-scraper-worker.ts (which imports openDb) — relocate
`TIER_MULTIPLIERS` (src/usage-scraper-worker.ts:123-132) to a db-free leaf shared by both,
or duplicate the tiny tier-key set locally in shadow-profiles. WIRING (src/agent/main.ts):
thread a discriminant so the new finding flows through `ProfilesCheckFindingKind` (:855) +
`profilesCheckKind` classifier (:862) + `profilesCheckRemediation` (:878) — it has no
shadow/tracked semantics, so give it its own kind. Fix the enrich path: `runProfilesCheck`
(:916-967) builds `path = profilesRootDisplay(agent)/name` and `id = ${agent}:${name}` — for
the `~/.claude` finding render the path via a canonical `~/.claude` display and a DISTINCT
id (the naive `claude:default` collides with a leftover `~/.claude-profiles/default`
auth-bearing-reserved-shadow finding). Adding a kind is additive to
`PROFILES_CHECK_SCHEMA_VERSION` (:850) — no bump. Exit/summary: a tier-missing finding
flips exit to 9 (a real actionable finding) but is counted SEPARATELY from the
auth-bearing-shadow tally (its prose differs — "re-home incomplete", not "a login nothing
reads"). DOCS: re-home runbook (README:3907-3930) gains the `oauthAccount.organizationRateLimitTier`
step (after `/login`, before deleting the shadow) + the note that a persistent `?x` means
it's pending; AGENTWRAP_HELP (dispatch.ts:112-117) + USAGE (:53) + README profiles-check
prose (:1408-1412) gain the new finding class (keep AGENTWRAP_HELP/USAGE in sync).

### Investigation targets

**Required** (read before coding):
- src/agent/shadow-profiles.ts:35-46 (ShadowProfileFinding), :143-152 (hasOauthAccount / .claude.json parse), the PROFILE_ROOTS scan + the db-free header (:14-18)
- src/agent/main.ts:850 (PROFILES_CHECK_SCHEMA_VERSION), :855 (ProfilesCheckFindingKind), :862-867 (profilesCheckKind), :878 (profilesCheckRemediation), :916-967 (runProfilesCheck: path :931, id :928, exit/summary)
- src/usage-scraper-worker.ts:123-132 (TIER_MULTIPLIERS), :276-294 (parseTierMultiplier predicate to mirror)
- src/agent/dispatch.ts:53 (USAGE), :112-117 (AGENTWRAP_HELP)
- README.md:3907-3930 (re-home runbook), :1408-1412 (profiles-check prose), :2954-2973 (producer section — cross-ref only)
- test/shadow-profiles.test.ts (detector), test/agent-dispatch.test.ts:166-211 (routing; emit/classification under-tested)

### Risks

- db-free boundary: do NOT import TIER_MULTIPLIERS from the openDb-importing scraper — relocate to a db-free leaf or duplicate; keep shadow-profiles a cold-path leaf.
- id collision: the `~/.claude` tier-missing finding must NOT share `claude:default` with a `~/.claude-profiles/default` shadow finding (duplicate id in --json).
- Predicate drift: the detector's tier-unresolvable test must match the scraper's exactly (minus the missing-oauthAccount arm), or `profiles check` and `keeper usage` disagree.
- Path render: `~/.claude` is not a profiles root — use a canonical display, not `profilesRootDisplay(agent)/name`.

### Test notes

Detector: a `~/.claude` with oauthAccount present but tier absent/unknown → the new finding;
tier present → no finding; missing oauthAccount → NOT this finding. Emit: `runProfilesCheck`
renders the canonical path + a distinct id, counts toward exit-9 but separately from the
shadow tally; `--json` has no duplicate id alongside a default shadow. Scope agent==="claude".

## Acceptance

- [ ] `keeper agent profiles check` reports `~/.claude` authed-but-tier-missing as a distinct finding (own kind, distinct id, canonical `~/.claude` path), scoped to claude.
- [ ] Detector predicate matches the scraper's tier-unresolvable test (minus missing-oauthAccount); stays db-free (TIER_MULTIPLIERS relocated or duplicated).
- [ ] Exit flips to 9 on the finding but it's counted separately from the auth-bearing-shadow tally; PROFILES_CHECK_SCHEMA_VERSION unchanged (additive kind).
- [ ] Re-home runbook gains the oauthAccount-metadata step + the `?x`-means-pending note; AGENTWRAP_HELP/USAGE + README profiles-check prose list the new finding.
- [ ] `bun test test/shadow-profiles.test.ts` (+ the emit test) green; no duplicate `--json` id with a default shadow.

## Done summary
Added a tier-metadata-missing finding to keeper agent profiles check for the native ~/.claude being authed but tier-unresolvable (distinct kind, canonical path, distinct id, counted apart from the shadow tally), relocated the tier table/cap/predicate to a db-free claude-tier leaf shared with the scraper, and documented the oauthAccount re-home step + new finding class.
## Evidence

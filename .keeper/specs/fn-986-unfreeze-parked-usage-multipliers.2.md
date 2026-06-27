## Description

**Size:** M
**Files:** src/usage-scraper-worker.ts, test/usage-scraper-worker.test.ts, README.md

### Approach

Add a named `MULTIPLIER_POLL_INTERVAL_S` constant (~60s; follow the `IDLE_THRESHOLD_S` form at :83). Cap ONLY the no-scrape sleeps at this interval (with a small jitter): the `maybeCooldownSkip` return (:830-831), the `maybeIdleSkip` return (:868), and `initialDelaySeconds()` (:706-707). Do NOT cap the post-scrape `handleSuccess`/`handleFailure` returns — a `stale` envelope bypasses the gates (:763) and capping the /usage endpoint-rate-limit backoff (~:1040) would re-hammer a throttled endpoint every 60s. In `cycle()`, after `reResolveMultiplier`, read the ON-DISK prior envelope's `multiplier` (add a typed `priorNum` helper alongside `priorStr` :567) and compare to the freshly-resolved `acct.multiplier`; on a numeric-and-differing mismatch, bypass BOTH gates and fall through to the scrape (:776). Absent/non-numeric/no-prior → treat as no mismatch (gates apply normally). Critically compare against the on-disk envelope (the frozen 1x), NOT `acct.multiplier`-before-reResolve — boot's `buildAccounts` already corrects `acct.multiplier`, so a before/after compare never fires and the live `default` bug stays. mtime-gate `resolveMultiplierOrNull` (:196-205): reuse the transcript-worker `{size, mtimeMs}` memo shape (src/transcript-worker.ts:415-433) as a module-global Map keyed by absolute path; cache the RESOLVED multiplier (including null) and short-circuit the readFileSync+JSON.parse on an unchanged mtime — mtime is load-bearing (the file is rewritten wholesale, not appended), so don't size-gate alone. Suppress redundant churn: on an unchanged parked wake (multiplier same, already in the same skip state), skip the envelope re-write + `events.jsonl` append so a multi-hour cooldown doesn't grow the event log ~1440 lines/day/account. Update the README scheduling paragraph (~2878) + module JSDoc (34-41) + AccountLoop comment (~674) per the docs gaps.

### Investigation targets

**Required** (read before coding):
- src/usage-scraper-worker.ts:690-726 — `run()` sleep chokepoint + `initialDelaySeconds()` (cap site)
- src/usage-scraper-worker.ts:799-872 — `maybeCooldownSkip` / `maybeIdleSkip` (cap their returns; bypass-on-change)
- src/usage-scraper-worker.ts:746-786 — `cycle()` gate ordering; the `prior.status !== "stale"` guard at :763
- src/usage-scraper-worker.ts:191-215 — `resolveMultiplierOrNull` (mtime-memo target; `statSync` already at :198)
- src/usage-scraper-worker.ts:535-595 — `buildEnvelope` (`multiplier: acct.multiplier`) + `priorStr`/`priorUsage` helpers (add `priorNum`)
- src/usage-scraper-worker.ts:1030-1050 — `handleFailure` rate-limit backoff (MUST stay uncapped)
- src/transcript-worker.ts:415-433, :546-552 — canonical `{size, mtimeMs}` memo to reuse
- src/usage-worker.ts:48-62 — consumer change-gate (confirms freshness churn does not amplify to keeper.db)

**Optional:**
- README.md ~2871-2895 — scheduling paragraph to revise

### Risks

Capping the wrong sleeps re-hammers a throttled /usage endpoint — the cap MUST exclude post-scrape returns. The change-detection baseline (on-disk prior vs in-memory `acct`) is the difference between fixing and not fixing the live bug — both need explicit test coverage.

### Test notes

New tests (depend on `.1`'s home seam): (a) parked cooldown wake re-resolves + rewrites the multiplier within the interval, `calls.length == 0`; (b) prior-envelope multiplier `1` vs resolved `20` bypasses cooldown+idle, `calls.length == 1`; (c) a >interval no-scrape sleep is capped, a post-scrape failure backoff is NOT; (d) unchanged mtime → no re-parse; (e) update the `initialDelaySeconds` restart-cheap test (was `toBeCloseTo(120)`) to the capped value.

## Acceptance

- [ ] `MULTIPLIER_POLL_INTERVAL_S` constant added; no-scrape sleeps (cooldown, idle, initialDelay) capped at it with jitter
- [ ] Post-scrape success/failure returns remain uncapped (failure rate-limit backoff preserved)
- [ ] On-disk prior-envelope multiplier vs resolved `acct.multiplier` mismatch bypasses both gates → full scrape; absent/non-numeric → no mismatch
- [ ] `resolveMultiplierOrNull` skips the JSON parse on unchanged mtime (memo caches the resolved multiplier incl. null)
- [ ] Redundant unchanged-parked envelope/event churn suppressed
- [ ] README + module JSDoc + AccountLoop comment updated to describe the sub-cadence re-resolve
- [ ] `bun test` green; biome + lint-claude-md clean

## Done summary

## Evidence

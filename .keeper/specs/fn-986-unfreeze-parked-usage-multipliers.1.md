## Description

**Size:** S
**Files:** src/usage-scraper-worker.ts, test/usage-scraper-worker.test.ts

### Approach

Thread an injectable home/tier-read seam through `AccountLoopDeps` (alongside the existing `latestActivity` injection ~:669) so `cycle()`'s `reResolveMultiplier(acct)` call at :756 no longer reads the real `homedir()`. Mirror the `resolveMultiplierOrNull(profile, homeDir)` / `reResolveMultiplier(acct, homeDir, log)` injection the standalone tests already use. NO behavior change — pure enabling refactor. Then migrate the existing cooldown (:476), idle (:374), and success (:204) cycle tests to write a sandbox `.claude-profiles/<p>/.claude.json` (via the existing `writeProfileClaudeJson` helper ~:630) so the in-cycle re-resolve is deterministic and no longer silently depends on the dev machine's real profiles.

### Investigation targets

**Required** (read before coding):
- src/usage-scraper-worker.ts:660-708 — AccountLoopDeps interface + the `latestActivity` injection pattern to mirror
- src/usage-scraper-worker.ts:746-786 — `cycle()`; the `reResolveMultiplier(acct)` call at :756 to make injectable
- src/usage-scraper-worker.ts:229-246 — `reResolveMultiplier(acct, homeDir, log)` signature
- test/usage-scraper-worker.test.ts:630-708 — `writeProfileClaudeJson` + injected-home test pattern
- test/usage-scraper-worker.test.ts:204, :374, :476 — the success/idle/cooldown cycle tests to migrate to a sandbox home

**Optional:**
- test/usage-scraper-worker.test.ts:64-72 — `fixedClock` seam

### Risks

Environment-dependent test breakage: today the cycle tests pass profile `"default"` and rely on the in-cycle re-resolve being a silent no-op; on a dev machine with a real `~/.claude-profiles/default` they would mutate `acct.multiplier`. The migration must make every cycle test use a sandbox home so it is deterministic on both CI and dev.

### Test notes

Existing cycle tests stay green after migration; add no new behavior assertions here (behavior lands in `.2`). Drive via `new AccountLoop(acct, makeDeps({...})).runCycleNoThrow()`.

## Acceptance

- [ ] `AccountLoopDeps` carries an injectable home (or tier-read) seam; `cycle()`'s re-resolve uses it, not real `homedir()`
- [ ] Existing cooldown/idle/success cycle tests migrated to a sandbox `.claude.json` and pass deterministically (no dependence on real `~/.claude-profiles`)
- [ ] No behavior change: returned sleep values + envelope statuses unchanged from before
- [ ] `bun test test/usage-scraper-worker.test.ts` green

## Done summary

## Evidence

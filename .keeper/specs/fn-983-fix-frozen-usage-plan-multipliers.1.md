## Description

**Size:** S
**Files:** src/usage-scraper-worker.ts, test/usage-scraper-worker.test.ts

### Approach

- Bump `MAX_CLAUDE_JSON_BYTES` (`src/usage-scraper-worker.ts:93`) from
  `1024 * 1024` to `16 * 1024 * 1024`. Rewrite the `:92` comment to state
  current reasoning — real configs run 1.7-2.4 MB and grow with history; the
  cap only fences off a pathological/runaway file. Forward-facing only (no
  ticket ids, dates, or "used to be").
- Add a trailing `homeDir = homedir()` param to `resolveMultiplierOrNull`
  (`:185`), threaded into the `join(...)` at `:186`. Mirror the canonical
  seam signature (`src/agent/state-sharing.ts:362` et al.). Leave
  `resolveMultiplier` (`:209`) private and argument-free; `buildAccounts`
  (`:239`) and the cycle site keep the default.
- Add an optional `tierResolveFailed?: boolean` field to the `Account`
  interface (`:106-115`) as a per-account episode-throttle flag.
- Extract the per-cycle re-resolve block (`:720-725`) into a small exported
  helper `reResolveMultiplier(acct, homeDir = homedir(), log = console.error)`:
  resolve via `resolveMultiplierOrNull(acct.profile, homeDir)`; on a non-null
  result set `acct.multiplier` and clear `acct.tierResolveFailed`; on `null`
  keep the prior multiplier and, only when `!acct.tierResolveFailed`, set the
  flag and emit one `log(...)` naming the account id and the kept multiplier.
  `cycle()` (`:720`) calls `reResolveMultiplier(acct)` with the defaults.

### Investigation targets

**Required** (read before coding):
- src/usage-scraper-worker.ts:90-211 — cap, `Account` interface, `resolveMultiplierOrNull` / `resolveMultiplier`
- src/usage-scraper-worker.ts:711-754 — `cycle()` and the re-resolve block to replace
- src/agent/state-sharing.ts:362 — canonical `homeDir` seam signature to mirror
- test/usage-scraper-worker.test.ts:31-55 — import block (add `resolveMultiplierOrNull` + `reResolveMultiplier`) and the `mkdtempSync` tmp-dir harness

**Optional** (reference as needed):
- test/agent-profile-bootstrap.test.ts:47-98 — tmp-home construction reference

### Risks

- A warning placed inside `resolveMultiplierOrNull` would fire every 60-180s
  cycle per account forever — it must live at the re-resolve site behind the
  episode flag (fire once per failure onset, re-arm on a successful resolve).
- Two seams (`homeDir`, `log`) on the helper: keep both defaulted so the
  production call site stays argument-free; only tests inject.
- The cap is still a fixed number; the new warning is what makes it
  defensible — a recurrence (file past 16 MB, unknown tier) becomes visible.

### Test notes

- Resolver repro (hermetic via the seam): write
  `<tmpHome>/.claude-profiles/<p>/.claude.json` containing
  `{oauthAccount:{organizationRateLimitTier:"default_claude_max_20x"}}` padded
  past 1 MB, then assert `resolveMultiplierOrNull(p, tmpHome) === 20` (this
  returns `null`/falls back to 1 before the bump).
- Throttle: with a fake `log`, two consecutive failing resolves (missing or
  oversize file) log exactly once and keep the prior multiplier; a successful
  resolve in between re-arms so a subsequent failure logs again.
- Test-isolation: tmp home only, never the real `~/.claude-profiles`; no
  daemon / worker thread / subprocess.

## Acceptance

- [ ] `MAX_CLAUDE_JSON_BYTES` is `16 * 1024 * 1024` with a forward-facing comment; `resolveMultiplierOrNull` resolves real multi-MB `.claude.json` files (default→20, multi-claude-1→5)
- [ ] `resolveMultiplierOrNull` takes `homeDir = homedir()`; `resolveMultiplier` stays private; no other call-site signature changes
- [ ] `Account` has `tierResolveFailed?: boolean`; exported `reResolveMultiplier` keeps prior on `null` and logs once per failure episode (re-armed on recovery) at the cycle site
- [ ] New tests cover the padded >1 MB valid-file resolution and the episode-throttled warning (once across two failures, again after recovery); `bun test test/usage-scraper-worker.test.ts` green

## Done summary
Bumped MAX_CLAUDE_JSON_BYTES to 16MB so real multi-MB .claude.json files resolve the live tier; added an injected homeDir seam on resolveMultiplierOrNull and an exported episode-throttled reResolveMultiplier helper that warns once per failure onset. New tests cover >1MB resolution and the throttled-warning lifecycle.
## Evidence

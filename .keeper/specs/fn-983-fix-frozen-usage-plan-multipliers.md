## Overview

The `keeper usage` TUI shows every account's plan multiplier frozen at 1x,
never tracking the real subscription tier. Root cause: the usage scraper's
`MAX_CLAUDE_JSON_BYTES = 1 MB` cap is now smaller than real `.claude.json`
files (1.7-2.4 MB, growing with history), so `resolveMultiplierOrNull` trips
its size guard and returns `null` every cycle; the keep-prior re-resolve then
holds each account at its 1x boot fallback. End state: the cap clears real
files, multipliers reflect the live tier within one scrape cycle, and a
resolve failure is no longer silent — it logs once per failure episode so the
next recurrence is visible instead of hiding.

## Quick commands

- `bun test test/usage-scraper-worker.test.ts` — regression + throttle tests green
- `bun -e 'import {resolveMultiplierOrNull} from "./src/usage-scraper-worker.ts"; console.log(resolveMultiplierOrNull("default"))'` — prints the real tier multiplier (e.g. `20`), not `null`

## Acceptance

- [ ] Real multi-MB `.claude.json` files resolve; live multipliers reflect the actual subscription tier within one scrape cycle (default→20, multi-claude-1→5, multi-claude-2→1)
- [ ] A claude account whose tier resolve fails emits exactly one warning per failure episode (re-armed on recovery), never once per 60-180s cycle
- [ ] Regression test covers a >1 MB valid `.claude.json` resolving to the correct multiplier; full suite green

## Early proof point

Single task `.1` proves the approach end-to-end (cap bump + seam + warning +
test). If it fails: the cap bump alone (one-line, no seam/warning) still
restores correct multipliers — fall back to that and defer observability.

## References

- Canonical injected-home seam: `src/agent/state-sharing.ts:362` (+ rationale in `test/agent-profile-bootstrap.test.ts:9-12`)
- Re-resolve / keep-prior site: `src/usage-scraper-worker.ts:717-725`
- Tier→multiplier map (unchanged): `src/usage-scraper-worker.ts:100-104`

## Best practices

- **Surface a degraded read, never swallow it:** the bug survived because the size guard returned `null` silently and keep-prior held 1x with no signal. The fix pairs the cap bump with an episode-throttled warning so a future silent freeze is observable.

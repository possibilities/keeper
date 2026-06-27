## Overview

keeper's usage scraper re-resolves an account's tier→multiplier only at the top of each scrape cycle, but a depleted/rate-limited account parks in ONE long sleep until `lift_at` (often days) — so a tier change (Pro→Max, or a stale boot value) stays frozen until the cooldown lifts. fn-983 fixed multiplier *resolution* (16MB read cap); this epic fixes the *staleness*: cap the no-scrape sleeps at a ~60s poll so the multiplier re-resolves every minute even while parked, and on a detected multiplier change break the cooldown/idle gates and resume a full scrape. End state: profile `default` (max_20x, currently frozen at 1x in the TUI) self-corrects within ~1 minute.

## Quick commands

- `bun test test/usage-scraper-worker.test.ts`
- `cat ~/.local/state/agentusage/default.json | jq .multiplier`  # a parked max account shows its real tier, not 1

## Acceptance

- [ ] A parked (cooldown) account re-resolves and rewrites its multiplier within one poll interval, with NO network scrape
- [ ] A multiplier change vs the on-disk prior envelope bypasses BOTH the cooldown and idle gates and triggers a full scrape
- [ ] Post-scrape success/failure backoffs (esp. the /usage endpoint-rate-limit backoff) are NOT capped — only the no-scrape sleeps are
- [ ] The 60s poll does not re-parse the multi-MB `.claude.json` when its mtime is unchanged
- [ ] `bun test` green; biome + lint-claude-md clean

## Early proof point

Task that proves the approach: `.1` — the injection seam + migrated cycle tests must land green before the behavior in `.2` is testable. If it fails: the seam shape is wrong — fall back to threading `homeDir` as a direct `cycle()` param instead of an `AccountLoopDeps` field.

## References

- fn-983 (done): raised `MAX_CLAUDE_JSON_BYTES` 1MB→16MB; this epic fixes the parked-staleness residue it left.
- Consumer insulation: `src/usage-worker.ts` change-gate excludes the freshness fields, so 60s envelope churn does NOT amplify into keeper.db `UsageSnapshot` events; only a real `multiplier` change emits one event.

## Docs gaps

- **README.md (~2878-2895)**: revise the usage-scraper scheduling paragraph — multiplier re-resolves on its own ~60s sub-cadence independent of cooldown/idle parking, and a change breaks the gate early. Consolidate, don't append.
- **src/usage-scraper-worker.ts module JSDoc (34-41) + AccountLoop comment (~674-676)**: reflect the bounded sub-cycle re-resolve + early-exit-on-change; drop any "resolved once per scrape" framing.

## Best practices

- **Stat-gate on mtime (load-bearing), not size:** `.claude.json` is rewritten wholesale by the claude CLI, so the transcript-worker memo's append-only/size caveat does NOT transfer — mtime is the change signal, and a 60s cadence absorbs atomic-rename mtime skew. [practice-scout]
- **Jitter the cap to avoid boot lockstep:** per-account loops all capped at the same interval can synchronize first wakes; add a small ±jitter on the cap (never on the stat). [practice-scout]
- **stat(2) doesn't read file data:** gating the parse behind a stat is free regardless of the 2-3MB size. [practice-scout]

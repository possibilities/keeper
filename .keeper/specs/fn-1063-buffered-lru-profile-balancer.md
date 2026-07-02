## Overview

The Claude profile picker balances `keeper agent` launches across subscription accounts. Stride scheduling over a never-decaying pick ledger starves low-tier accounts (a fresh 1x can go days unpicked while a 69%-burned 20x keeps winning) and has no hard stop before an account hits its rate limit. This epic replaces it with two dumb mechanisms: pure LRU rotation orders the turn-taking, and a hard admission gate on scraped ground-truth usage (with a small burst reservation covering the scrape lag) keeps accounts from being driven into their limits. End state: every account with headroom rotates, hot accounts park themselves at the buffer instead of at the wall, and a dead scraper degrades the system to exactly plain-rotation behavior.

## Quick commands

- `bun test test/usage-picker.test.ts` — deterministic suite proving gate + rotation + ladder
- `for i in 1 2 3 4; do bun -e 'import {pickProfile} from "./src/usage-picker"; console.log(pickProfile())'; done` — live rotation smoke: successive picks spread across admitted profiles; inspect `~/.local/state/agentusage/picker.json` for the v2 shape + `last_pick` rung

## Acceptance

- [ ] A fresh low-tier account is picked ahead of a heavily-used high-tier one (the reported starvation is gone)
- [ ] An account over its buffer (session >= 80 or week >= 95) is not picked while any admitted profile exists
- [ ] Burst launches between scrapes spread across profiles instead of piling onto one
- [ ] With no/stale scrape data the picker behaves as plain LRU rotation and never throws
- [ ] picker.json migrates to v2 automatically on first pick

## Early proof point

Task that proves the approach: `.1` (the only task). If the LRU + gate rewrite stalls, fall back to shipping the gate alone over the existing rotation order — the gate is the rate-limit protection; ordering is fairness only.

## References

- `~/.local/state/agentusage/<profile>.json` — live envelope corpus (session/week windows, lift_at, last_successful_fetch_at)
- src/usage-scraper-worker.ts:148-176 — Envelope contract the gate reads
- `~/code/agentusage` — Python scrape-only producer; keeper's TS picker is the sole picker.json reader/writer

## Docs gaps

- **src/usage-picker.ts (module docstring + schema comment)**: rewrite — stride/cross-runtime/Python-coexistence claims replaced by the buffered-LRU description (part of the task deliverable)
- **src/usage-flock.ts:6-8**: prune the Python-coexistence / cross-runtime-invariant rationale — keeper is the lock's only user
- **src/keeper-state-dir.ts:4-5**: prune the "mirrors the Python daemon/api STATE_DIR" phrase — the deliberate non-XDG choice stands alone

## Best practices

- **Parked is not near-limit:** a rate-limit-parked account is definitively unusable; it enters only the second-to-last ladder rung, never the primary pool [Envoy/tacnode admission-control pattern]
- **Reservations are optimistic hints, not authority:** `pending` inflates effective usage during the scrape lag and self-resets on fresh data, never on a timer [stale-while-revalidate correctness]
- **Hysteresis deferred deliberately:** percent_used is monotonic within a window, so boundary flapping is bounded to reservation noise; add a re-admit threshold only if observed [Envoy/CockroachDB]
- **Name the rung:** every non-primary rung resolution is an operational signal — the `last_pick` blob in picker.json is the forensic trail [Cloudflare fallback-pool pattern]

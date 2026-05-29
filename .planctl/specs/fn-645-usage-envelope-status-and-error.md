## Overview

The agentuse fn-3 epic ("scrape envelope status and subscription axes")
added new top-level envelope fields that keeper currently read-and-discards:
`status` (active|idle|stale), `subscription_active` (bool|null), and a
stale-only `error` object `{type,message,at}`. The existing usage UI is
still correct (the fields keeper projects are unchanged and additive), but
it is blind to freshness/subscription state — a `stale` stack shows
last-good numbers as if fresh, and a no-subscription account renders empty
`?` bars. This epic projects the new axes natively onto the `usage` row
(schema v37→v38) and surfaces them in `scripts/usage.ts`.

## Quick commands

- `bun test test/usage-worker.test.ts` — pure-core + gate tests
- `bun scripts/usage.ts` — visual check of the rendered stacks
- `turbo run //#py:lint` is N/A; use the repo's bun/biome lint via commit-work

## Acceptance

- [ ] schema v38 projects status/subscription_active/error_type/error_message/error_at onto `usage`
- [ ] usage-worker carries the new fields; `error_at` excluded from the change-gate; `last_failed_fetch_at` stays freshness-excluded
- [ ] reducer folds the new columns; rate-limit reverse fan-out carve-out unchanged
- [ ] scripts/usage.ts hides `subscription_active=false` rows, shows the status token, and renders a stale `error` line with `error_at` as a ticking relative stamp
- [ ] lint + typecheck + bun test green

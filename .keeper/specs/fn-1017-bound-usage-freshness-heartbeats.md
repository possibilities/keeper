## Overview

Fix false `keeper usage` stale warnings for accounts whose quota values remain unchanged across successful scrapes. The usage worker should still keep fetch-only churn bounded, but it needs a coarse healthy-scrape heartbeat so `usage.last_usage_fold_at` reflects producer liveness for stable accounts like `claude-0`.

## Quick commands

- bun test test/usage-worker.test.ts test/usage.test.ts

## Acceptance

- [ ] A healthy `active` usage envelope whose quota values are unchanged emits at most one heartbeat snapshot per 10-minute freshness bucket.
- [ ] A healthy `active` usage envelope in the same freshness bucket remains suppressed by the change gate.
- [ ] Stale/error envelopes do not heartbeat solely because `error.at` or fetch timestamps changed.
- [ ] Restart seeding from `usage.last_usage_fold_at` suppresses same-bucket boot scans and emits when the on-disk healthy scrape is in a newer bucket.

## Early proof point

Task that proves the approach: `task 1`. If it fails: keep freshness out of the projected event payload and use a separate seeded gate field instead of relaxing the projection schema.

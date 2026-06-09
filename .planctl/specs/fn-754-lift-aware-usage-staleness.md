## Overview

`keeper usage` blanks the quota-lift time for a depleted-but-validly-quiet
Claude account: a profile at weekly 100% renders `week 100% —` plus a
`stale 41m` line and NO lift info, hiding the one actionable fact (when the
limit lifts). Root cause is a keeper-side rendering rule, not a broken
scrape — agentuse deliberately stops polling a maxed account until its lift
(`next_fetch_at` jumps days out), so `last_usage_fold_at` freezes and the
row trips the 15m staleness threshold, which then dashes the week reset cell
and drops the rate-limit line. The data (`rate_limit_lifts_at`,
`week_resets_at`) is present and valid. Fix: make staleness LIFT-AWARE
(anchor the stale clock to `max(last_usage_fold_at, lift_at)`) so a row with
a future lift stays fresh and surfaces a relabeled `limited` line showing
`lifts in <rel>`. Contained to `cli/usage.ts` + `test/usage.test.ts` (plus
doc-comment / README prose). No schema/worker/reducer/agentuse change.

## Quick commands

- `bun test test/usage.test.ts` — the render-unit suite (pure, no DB)
- `bun run lint` — biome over cli/src/test
- `keeper usage` — eyeball a live depleted profile shows `limited lifts in <rel>`, not `—` + `stale`

## Acceptance

- [ ] A depleted row (`week_percent` 100, old `last_usage_fold_at`, future `rate_limit_lifts_at`) renders the week reset countdown + a `limited lifts in <rel>` line and NO `stale` line.
- [ ] After the lift passes with no fresh fold, the row reverts to stale within the normal 15m grace (week cell `—`, `stale` line, no `limited` line).
- [ ] Codex and never-rate-limited rows are byte-for-byte unchanged.
- [ ] `bun test test/usage.test.ts` and `bun run lint` pass.

## Early proof point

Task that proves the approach: `.1` (the whole fix is one task). The risky
move is reordering the lift parse above `isStale` and the unconditional-`max`
anchor. If it misbehaves, fall back to the brief's guarded form
`(liftMs > nowMs) ? max(foldAtMs, liftMs) : foldAtMs` — but that forfeits the
post-lift 15m grace, so prefer fixing the simple `max`.

## References

- fn-651 — schema v41, `rate_limit_lifts_at` (the lift instant this fix renders); `cli/usage.ts:508-526`
- fn-645 — envelope freshness axis (`active|idle|stale`), the `stale`-line + error-line machinery
- Producer side: `../agentuse/daemon.py:525-555` — the deliberate "pause until lift" that freezes `last_usage_fold_at`
- Practice note: absolute future instants don't decay with producer staleness, unlike relative countdowns — so a future lift is safe to show on a frozen-but-accurate row (a weekly 100% cannot drop before its week boundary = lift).

## Docs gaps

- **README.md (~lines 924-936)**: the `usage.ts` paragraph documents the `rate-limited for <rel>` label, the `n/a` / stale-blank omission rules, and stale-suppression — all wrong after the rename + lift-aware carve-out. Prune, don't append.
- **cli/usage.ts module JSDoc (~lines 23-72, 342-404, the ASCII example ~351)**: enumerates the `rate-limited` label and omission rules; update the label inventory, the omission rule (depleted + future lift is no longer suppressed), and the ASCII sample.

## Best practices

- **Anchor staleness to `max(last_fold, lift)`** so a deliberately-idle producer isn't misread as dead — distinguish "paused with a known resume time" from "no next action." [practice-scout: Kubernetes lease / Aeron liveness]
- **A future absolute instant is re-evaluable and doesn't age**; a relative countdown computed once in a snapshot silently elapses — showing the lift on a frozen-but-accurate row is correct. [UX Movement; Home Assistant absolute-first]
- **Guard the sentinel/NaN boundary**: `Math.max(x, NaN)` is `NaN`, which would render a row neither stale nor fresh — null/unparseable lift must fall back to the fold anchor. [practice-scout key gotcha]
- **Round only for display, not for the anchor predicate** — the `limited` line keeps the existing ±30s rounded convention; the stale anchor compares raw ms.

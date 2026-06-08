## Overview

Round-2 babysitter signal-quality fix (follows the done epic
`fn-738-babysitter-signal-quality`). The read-only `keeper-watch`
backstop-degraded detector floods the followup queue with false pages:
`backstop-staleness` fires on the ALL-HISTORY max staleness over the entire
`backstop.ndjson` (so one old resolved rescue re-pages every hour via the 1h
cooldown), and `backstop-missed-wake` keys off `fires_total` (normal periodic
wake-ups) instead of `rescues_total`. Make both detectors incremental: a
per-bucket rescue `ts` watermark gates staleness to genuinely-new rescues, and
the missed-wake delta keys off `rescues_total`. Bump
`BACKSTOP_BASELINE_VERSION` 1->2 for a silent reseed. Babysitter stays a pure
read-only scanner — no DB/event/RPC surface; all state in
`~/.local/state/keeper-watch/` sidecars.

## Quick commands

- `bun test test/keeper-watch.test.ts test/backstop-stats.test.ts`
- manual: run `keeper-watch --tick` twice over an unchanged `backstop.ndjson` → no repeated `backstop-staleness` followups

## Acceptance

- [ ] repeated `keeper-watch` over an unchanged `backstop.ndjson` does not regenerate staleness followups for the same old rescue
- [ ] a clean post-fn-742 rollup sequence with no rescue growth produces no missed-wake followup
- [ ] genuinely new rescue lines still page with bucket + staleness + raw evidence
- [ ] first tick after the 1->2 reseed (or a `(dev,ino)` identity change) fires nothing and seeds the watermark
- [ ] `bun test test/keeper-watch.test.ts test/backstop-stats.test.ts` passes

## Early proof point

Task that proves the approach: `.1` (the whole change is one task). If it
fails: the watermark/reseed interaction is the risk surface — fall back to
surfacing a compact `{maxTs, maxStaleness, newestRescueTs}` per bucket instead
of full samples if the array contract proves unwieldy, but the
fire-nothing-on-reseed rule is non-negotiable.

## References

- Predecessor (done): `fn-738-babysitter-signal-quality`
- Inter-epic: epic-scout found zero open epics — clear runway, no deps.
- Prometheus `rate()` / counter-reset semantics; high-watermark exclusive-cursor pattern (alert on the bad-outcome counter, not total invocations).

## Docs gaps

- **README.md (~514-521)**: the `KEEPER_BACKSTOP_LOG` / `backstop-stats.ts` description ("rescue count, rate, staleness p50/p95/p99") becomes incomplete once `StatsRow` gains a samples field — fold the new field into the existing sentence.
- **README.md (~2063-2067)**: the babysitter "missed-wake counters + rescue staleness" Architecture para — re-read post-impl to confirm it still holds.
- **CLAUDE.md (~100-110)**: the babysitter rule lists two read-only inputs but not the `backstop-baseline.json` sidecar — add a clause; the 1->2 bump invalidates deployed baselines, so a dev inspecting `~/.local/state/keeper-watch/` should know.

## Best practices

- **Alert on the bad-outcome counter, not total invocations:** key the missed-wake delta on `rescues_total`, not `fires_total` (Prometheus `rate()` guidance).
- **High-watermark exclusive cursor:** query `ts > watermark`, process, advance — never alert on a whole-file aggregate.
- **Version-bump persisted state on shape change:** silent reseed via the version guard; never leave undefined fields to fall through.
- **Don't use the 1h cooldown as a substitute for incremental detection** — the cooldown re-notifies a genuinely-present condition; the fix is to stop falsely reporting presence.

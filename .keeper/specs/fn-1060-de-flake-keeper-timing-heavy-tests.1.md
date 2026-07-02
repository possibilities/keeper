## Description

**Size:** M
**Files:** test/usage-picker.test.ts, test/usage-picker.slow.test.ts (new)

### Approach

Move the four heavy disk-bound loops in `test/usage-picker.test.ts` — the 600-pick tests at :190 ("5x picked five times as often at equal headroom") and :241 ("all sessions burned falls back to multiplier credit") plus the 400-pick peers at :206 and :266 — into a new `test/usage-picker.slow.test.ts` sibling gated exactly like `test/pair-panel.slow.test.ts` (`SLOW_ENABLED = process.env.KEEPER_RUN_SLOW !== undefined`). The buildbot builder runs `bun run test:full` without `--slow`, so the relocated proofs leave the flapping lane while `scripts/test-full.ts --slow` (and any nightly/manual slow run) still exercises them at full N with the 4.5–5.5 band intact. Keep (or add) cheap deterministic fast-tier coverage of pickProfile's weighting semantics — a handful of picks asserting order/credit math via the injectable clock (`setClock`/`installMonotonicClock`), NOT a shrunken statistical sample. Each pick costs a flock + config read + envelope reads + atomic tmp-write+rename, so ~2000 serial picks in one file is what blows the 10s ceiling under contention.

### Investigation targets

**Required** (read before coding):
- test/usage-picker.test.ts:190 — the named repeat-offender loop (and :206, :241, :266 peers in the same worker)
- test/pair-panel.slow.test.ts — the slow-tier gate pattern to copy exactly
- package.json:18 — the root test script's `--timeout=10000` and its `plugins/**` ignore list (confirm the new .slow file is picked up by the slow lane and excluded from fast)

**Optional** (reference as needed):
- src/usage-picker.ts — module header: 1:1 Python port with cross-runtime ledger invariants; do NOT add test-only seams here
- scripts/test-full.ts:64 — how KEEPER_RUN_SLOW is injected per suite

### Risks

The picker shares its `picker.json` ledger format with a Python `pick_profile` — restructure TESTS only; any src/usage-picker.ts seam risks untested byte-compat drift.

### Test notes

`bun run test` must show no usage-picker test above ~1s expected wall; `KEEPER_RUN_SLOW=1 bun test test/usage-picker.slow.test.ts` runs all four proofs.

## Acceptance

- [ ] All four heavy loops live in test/usage-picker.slow.test.ts behind KEEPER_RUN_SLOW, iteration counts and the 4.5–5.5 band unchanged
- [ ] Fast tier retains deterministic pickProfile coverage (injected clock, small pick count)
- [ ] `bun run test` and `bun run test:full` pass; `scripts/test-full.ts --slow` runs the relocated proofs

## Done summary
Split the four heavy large-N usage-picker distribution proofs into test/usage-picker.slow.test.ts behind KEEPER_RUN_SLOW (iteration counts + 4.5-5.5 band preserved); fast tier keeps deterministic weighting coverage via an exact-sequence pick assertion under the injected monotonic clock.
## Evidence

## Description

**Size:** M
**Files:** cli/usage.ts, test/usage.test.ts, README.md

Make `keeper usage` staleness lift-aware and relabel the rate-limited line
to `limited`, so a depleted-but-validly-quiet profile (agentuse paused
polling until its known lift) shows its lift countdown instead of `—` +
`stale`. The fix is entirely in the pure render path — no schema, worker,
reducer, or agentuse change. `rate_limit_lifts_at` / `week_resets_at` /
`last_usage_fold_at` are already projected (`src/collections.ts:431-469`).

### Approach

1. **Reorder the lift parse above `isStale`.** Today `liftIso`/`liftMs`
   are computed at `cli/usage.ts:518-519`, AFTER the `isStale` block
   (`:496-507`). Move that parse (`const liftIso = seg(row.rate_limit_lifts_at)`,
   `const liftMs = liftIso === "" ? Number.NaN : Date.parse(liftIso)`)
   ABOVE the staleness computation so the anchor can consult it. Reuse the
   existing `seg()` + `=== "" ? NaN : Date.parse` null-safe pattern — do
   NOT add a new guard.
2. **Lift-aware staleness anchor.** Replace `staleAgeMs = ... nowMs - foldAtMs`
   with an anchored form:
   `const staleAnchorMs = Number.isNaN(liftMs) ? foldAtMs : Math.max(foldAtMs, liftMs);`
   `const staleAgeMs = Number.isNaN(staleAnchorMs) ? -1 : nowMs - staleAnchorMs;`
   then `isStale = staleAgeMs >= STALENESS_THRESHOLD_MS` unchanged. This is
   the UNCONDITIONAL `max` (not the brief's `liftMs > nowMs ? ... : foldAtMs`):
   while the lift is future, `max` picks `liftMs` → not stale; after lift
   passes, `max` still picks `liftMs` (until a fresh fold lands) → the
   normal 15m grace is measured FROM the lift, exactly as the design
   intends; a null/NaN lift falls back to `foldAtMs`; a never-folded row
   (`foldAtMs` NaN) stays fresh via the `-1` short-circuit (Math.max with
   NaN is NaN → -1). Once `isStale` goes false, the three `resetCell` calls
   (`:546/:549/:555`) un-blank automatically — no change at those sites.
3. **Generalize the rate-limited line into `limited`.** Drop the
   `hasFiredTime` (`last_rate_limit_at` / `rlRaw`) gate at `:520-522` — the
   depletion case has `last_rate_limit_at` NULL, so that gate is exactly
   what suppresses it today. Keep `!isCodex` and `!Number.isNaN(liftMs)`.
   Body: round for DISPLAY with the existing convention —
   `const liftDiffMin = Math.round((liftMs - nowMs) / 60000);`
   `> 0` → `lifts in ${relTime(liftIso, nowMs)}`, `=== 0` → `lifts now`,
   `< 0` → leave empty (omit the line; a past lift means the limit lifted).
4. **Rename the label.** `rate-limited` → `limited` in the width-pool push
   (`:595`) and the render literal (`:618-619`); rename helper
   `renderRateLimit` → `renderLimited`. `limited` (7) is no wider than
   `week`/`session`, so `wLabel` shrinks — re-derive alignment, don't sed.
5. **Update doc-comments + README** in lockstep (stale comments are a
   defect here): file header (`:23-72`), `renderRowLines` JSDoc + ASCII
   example (`:342-404`, esp. `:351`), the `STALENESS_THRESHOLD_MS` /
   `STALE_CELL` / `resetCell` blocks (`:266-324`), the `isStale` block
   (`:486-507`), the rate-limited block (`:508-526`); README.md (~`924-936`)
   — prune the `rate-limited n/a` / stale-blank language for the depleted
   case, describe the new `limited lifts in <rel>` branch.

### Investigation targets

**Required** (read before coding):
- cli/usage.ts:496-507 — `isStale` computation; the anchor site
- cli/usage.ts:518-526 — `rlRel` body + the `hasFiredTime`/`isCodex` gates to generalize
- cli/usage.ts:286-297 — `resetCell` / `STALE_CELL` (consumes `isStale`, no change needed)
- cli/usage.ts:595, 618-619 — label width pool + `renderRateLimit` literal to rename
- cli/usage.ts:201, 219, 234 — `relTime` / `relTimeFromUnixSec` / `relTimeFromMs` (±30s rounding; reuse, don't reinvent)
- test/usage.test.ts:29-41, 421-426 — fixtures (`NOW_MS`, `NOW_SEC`, `isoOffset`) + `bodyLineExact` helper

**Optional** (reference as needed):
- src/collections.ts:431-469 — USAGE_DESCRIPTOR (confirms both columns already projected)
- README.md:916-950 — the `## Architecture` usage paragraph to prune

### Risks

- **Compute-order**: moving the lift parse up must not break the `seg()`/NaN
  guards — a NULL lift must leave `isStale` keyed off `foldAtMs` (NaN must
  not poison `max`).
- **Label-width regression**: narrower `limited` shifts `wLabel`; the
  alignment tests (`test/usage.test.ts:589-660`) assert specific padding and
  must be re-derived, not literal-replaced.
- **Inverted invariant**: the test at `test/usage.test.ts:662`
  ("rate-limited absent when `last_rate_limit_at` NULL even if lift set")
  asserts the OLD behavior — it must be INVERTED to lock in that a future
  lift with NULL `last_rate_limit_at` now renders `limited`.
- **Codex suppression must survive** (`:480` `isCodex`; guarded by `:563-587`).

### Test notes

- Update the v41 rate-limited cluster (`test/usage.test.ts:430-685`): label
  `rate-limited` → `limited`, body `for <rel>` → `lifts in <rel>`, `now` →
  `lifts now`; use `bodyLineExact(lines, "limited")`.
- Invert `:662` (NULL `last_rate_limit_at` + future lift → EXPECT a `limited` line).
- Rewrite the alignment tests (`:589-660`) for the narrower label.
- Add the headline fixture: `week_percent: 100`, `last_usage_fold_at: NOW_SEC - 41*60`,
  `rate_limit_lifts_at: isoOffset(N>0)` (future) → assert week cell shows a
  countdown (NOT `—`), a `limited lifts in <rel>` line is present, and NO
  `stale` line.
- Add: lift within ±30s (`isoOffset` ~0 / `NOW_MS + 20_000`) → `limited lifts now`.
- Add: lift in the PAST beyond grace (`last_usage_fold_at` old, lift `> 15m`
  ago) → row stale again (week `—`, `stale` line, no `limited`).
- Add: lift in the past but WITHIN the 15m grace → NOT yet stale (new grace behavior).
- Confirm codex (null lift) and never-folded (`last_usage_fold_at` null) rows unchanged.
- `bun test test/usage.test.ts` and `bun run lint` (biome) green.

## Acceptance

- [ ] Depleted row (week 100, old fold stamp, future `rate_limit_lifts_at`) renders the week countdown + `limited lifts in <rel>` and NO `stale` line.
- [ ] Lift within ±30s renders `limited lifts now`.
- [ ] After the lift passes with no fresh fold, the row reverts to stale within the 15m grace (week `—`, `stale` line, no `limited`); a past-but-within-grace lift is not yet stale.
- [ ] Codex rows and never-folded rows render byte-for-byte as before.
- [ ] The `:662` null-`last_rate_limit_at` test is inverted; alignment tests re-derived for the narrower `limited` label.
- [ ] cli/usage.ts doc-comments and README.md ~924-936 updated (no stale `rate-limited` prose).
- [ ] `bun test test/usage.test.ts` and `bun run lint` pass.

## Done summary
Made keeper usage staleness lift-aware (anchor max(last_usage_fold_at, rate_limit_lifts_at)) and relabeled the rate-limited line to 'limited', gated on the future lift itself so a depleted-but-quiet profile surfaces 'limited lifts in <rel>' instead of '—' + stale.
## Evidence

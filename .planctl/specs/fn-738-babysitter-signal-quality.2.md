## Description

**Size:** S
**Files:** `cli/keeper-watch.ts`, `test/keeper-watch.test.ts`

### Approach

Branch the `backstop-staleness` finding detail/title on `row.class` so
`timeout`-class backstops stop being labeled as dropped fast-path wakes.

- At `cli/keeper-watch.ts:905` the detail string hardcodes
  `"— a fast path dropped a wake-up"` regardless of class. For
  `class === "missed-wake"` keep the dropped-fast-path wording. For
  `class === "timeout"` (e.g. `autopilot-ceiling`, `pending-dispatch-sweep`,
  where `fast_path` is null) emit elapsed-timeout wording instead — e.g.
  "exceeded its dispatch/confirm/sweep timeout."
- Mirror the already-correct missed-wake DELTA wording at `:943`.
- Sanity-check the fold-latency detail at `:694` and the missed-wake finding
  at `:935-943` — leave them as-is if already class-appropriate.

### Investigation targets

**Required:**
- `cli/keeper-watch.ts:905` (staleness detail), `:935-943` (missed-wake
  delta), `:694` (fold-latency detail) — use `grep -a` (binary byte in file)
- the `BackstopRow`/`class` shape feeding these findings (where `class` is
  `"timeout" | "missed-wake"`)
- `test/keeper-watch.test.ts` backstop-staleness tests

### Risks

- Pure wording/branch change; no behavior, threshold, or fingerprint change
  (keep `key`/`fingerprint` stable so seen-state dedupe is unaffected).
- Read-only scanner invariant unchanged.

### Test notes

- Assert a `timeout`-class row renders timeout wording (no "fast path") and
  a `missed-wake`-class row renders dropped-fast-path wording.

## Acceptance

- [ ] `timeout`-class backstop findings render elapsed-timeout wording with
  no "fast path" language.
- [ ] `missed-wake`-class findings still mention a dropped fast-path wake.
- [ ] `key`/`fingerprint` unchanged; tests cover both variants.

## Done summary
Branched backstop-staleness and missed-wake-delta detail wording on row.class: timeout-class rows now render elapsed dispatch/confirm/sweep timeout wording (no 'fast path' language) while missed-wake rows keep dropped-fast-path wording. key/fingerprint unchanged; tests cover both variants.
## Evidence

## Description

Findings F1 (+ merged F3). In `src/exit-watcher.ts`, the tier-two block of
`selectStuckSentinelVerdicts` reads (afacb594):

    if (ageSecs >= STUCK_TIER2_MIN_AGE_SECS) {
      // Interactive/adopted sessions (no plan linkage) are soft telemetry —
      // no tier-two ack-row, but they still fall through to the clock-skew
      // detect below when applicable.
      if (row.planRef != null && !row.adopted) { out.push(... tier 2 stale-working ...); }
      continue;   // <-- unconditional: carved-out skewed rows never reach the standalone skew branch
    }
    if (clockSkew) { out.push(... tier 2 clock-skew ...); }

The `continue` is outside the mint guard, so a carved-out (planRef==null OR
adopted) session that is tier-two-aged AND clock-skewed emits nothing. This
contradicts ADR 0025's Decision-section promise that the standalone
clock-skew detect "still fires regardless of plan linkage", and the inline
comment (F3) claims a fall-through the code does not perform.

Reconcile all three surfaces into agreement — pick ONE:
  (a) honor the ADR: let a carved-out tier-two-aged row fall through to the
      standalone `if (clockSkew)` branch instead of the unconditional
      `continue` (skew row still emitted, stale-working row still suppressed); OR
  (b) suppress skew too for carved-out tier-two-aged rows, and amend ADR
      0025's Decision + Consequences and the inline comment to state that.

Files: `src/exit-watcher.ts`, `docs/adr/0025-stuck-sentinel-interactive-carve-out.md`,
`test/exit-watcher.test.ts`. Producer-side only — no fold/reducer change (respect
ADR 13's re-fold discipline; wall-clock reads stay in the producer).

## Acceptance

- [ ] The inline comment at the tier-two carve-out matches the actual control flow.
- [ ] ADR 0025 and the code agree on skew emission for tier-two-aged carved-out rows.
- [ ] A `selectStuckSentinelVerdicts` test asserts the output for a carved-out
      (planRef null / adopted) row that is BOTH tier-two-stale AND clock-skewed.

## Done summary
Moved the tier-two carve-out's unconditional continue inside the plan-linked mint guard so a carved-out (planRef null or adopted) tier-two-stale row still falls through to the standalone clock-skew branch, matching ADR 0025 and the inline comment; added a test pinning the carved-out + tier-two-stale + clock-skewed edge.
## Evidence

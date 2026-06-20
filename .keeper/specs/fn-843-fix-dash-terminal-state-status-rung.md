## Overview

A bug fix surfaced by the fn-841 robot job-card dash rewrite: `robotRung`
lets the api-error / awaiting-permission / awaiting-input annotation stamps
outrank a job's terminal `state` unconditionally, but the reducer never
clears those stamps on the SessionEnd/Killed transition. A job that dies
while blocked therefore reads as `error`/`awaiting` forever — pinned in the
needs-you band, never painted with the killed/ended robot glyph, and never
hidden by the `showTerminal` toggle (its computed rung is not terminal).
This matters because the exit-watcher backstop routinely reaps a blocked,
walked-away-from session, so a dead job permanently demands attention in the
dash's most prominent band.

## Acceptance

- [ ] A job with `state` ended/killed resolves to a terminal rung even when a
      stale annotation stamp is still set.
- [ ] Such a job lands in the idle band and is hidden unless `showTerminal`,
      like any other terminal card.
- [ ] A non-terminal blocked job still resolves to error/awaiting (no
      regression to the annotation-outranks-base behavior for live jobs).

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| C3 | kept | .1 | robotRung (view-model.ts:108-130) lets annotation stamps outrank terminal state, but reducer SessionEnd/Killed (reducer.ts:6573/6637) never clear last_*_at, so a job that died while blocked is pinned in needs-you with no terminal glyph. |
| C1 | culled | — | CardVM.isFocused always-false is code-cleanliness with no consumer and no user impact; auditor marked not-blocking. |
| C2 | culled | — | Auto-seeding focus onto the top card is a defensible default-cursor UX choice, not a defect. |
| TG1 | culled | — | Focus-clear/re-seed path is unit-covered; missing end-to-end toggle-off-while-focused test is belt-and-suspenders, not an uncovered defect path. |
| TG2 | culled | — | Empty not_in widening is inspection-verified at server-worker.ts:1028-1031/1006; missing socket test is pure coverage on working code. |

## Out of scope

- Clearing annotation stamps in the reducer on terminal transitions — the dash
  fix is the surgical one; changing the reducer's clear policy would touch the
  board/jobs surfaces and re-fold determinism, outside this follow-up.
- The four culled findings (C1, C2, TG1, TG2).

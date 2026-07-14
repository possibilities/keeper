## Overview

The deterministic-test-gate epic converted the tmux control worker's reread
debounce to an injectable scheduler seam, but the production default dropped
the prior `.unref()` on the timer — the one production-source change in an
otherwise behavior-preserving epic where the seam's default does not reproduce
prior behavior. A pending 50ms debounce can now hold the worker's event loop
alive, diverging from every sibling timer in the same file. This restores the
lost `unref` so the seam is truly behavior-equivalent.

## Acceptance

- [ ] The production reread-scheduler seam re-applies `.unref?.()` to its timer, matching sibling timers.
- [ ] Worker behavior on the reread debounce path matches the pre-epic form (a pending debounce no longer holds the event loop alive).

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1  | culled | —  | Deleting real-integration journeys is the epic's explicit accepted intent (task .8); only theoretical future-regression risk, and the sole remedy is optional real-git smoke machinery the epic deliberately declined. |
| F2  | kept   | .1 | `realRereadScheduler.setTimer` is a bare `setTimeout` dropping the prior `unref`; restore it to make the seam behavior-equivalent. |

## Out of scope

- Re-adding any deleted real-git/real-subprocess integration journey or slow test tier (F1 — the epic's deliberate purge stands).
- Any change to the reread debounce interval or the scheduler seam interface itself.

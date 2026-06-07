## Overview

The block-level `confirmRunning` contract docstring in `src/autopilot-worker.ts` (lines 29-51) was not updated alongside the fn-724 implementation changes. Steps 2 and 4 contradict the code: step 2 omits the durable ack-before-launch gate; step 4 still describes the old ceiling behavior (emit `DispatchFailed reason="confirm timeout"`, return `"failed"`) rather than the `"indoubt"` path that suppresses the emit. The inline comments at the ceiling site and the `ConfirmOutcome` type doc were correctly updated; only this header was missed.

## Acceptance

- [ ] Lines 29-51 describe the ack-before-launch step as a gate before `deps.launch`
- [ ] Step 4 describes the three-way `ok`/`failed`/`indoubt`/`aborted` outcome and the suppressed emit on ceiling-with-successful-launch
- [ ] No other steps contradict the fn-724 implementation

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | Confirmed stale at lines 34 and 43-49: step 2 omits ack-before-launch; step 4 describes retired DispatchFailed emit at ceiling |
| F2 | culled | — | Auditor explicitly "no action needed now"; non-fatal by design, self-heals via next reconcile |
| F3 | culled | — | Auditor: "not worth harness cost"; ack-timeout logic correct by inspection |
| F4 | culled | — | Thin try/caught composition; all component pieces individually tested, low-risk |
| F5 | culled | — | Reasoned-correct per auditor; clean degradation, no realistic user-visible failure path |

## Out of scope

- No behavior changes — doc-only fix
- No new tests required (existing tests cover the implementation)

## Overview

The `creatorIsLive` doc-comment in `src/bus-wake.ts` contradicts the actual
runtime wiring of the new live-pane liveness signal. Its prose claims a `null`
`livePaneIds` (probe unavailable) is "NOT consulted here" and that the caller
passes the empty set only on a genuine empty sweep — but the code consults
`null` and maps it to "live" (the conservative on-doubt-SKIP fallback). This
matters because the wrong comment misdescribes a load-bearing safety invariant
(probe-unavailable must skip the resume, never double-attach), and a future
reader trusting it could "fix" the safe fallback into the exact double-attach
hazard the recheck guards against.

## Acceptance

- [ ] The `creatorIsLive` doc-comment correctly describes the `null` livePaneIds -> treat-as-live behavior, agreeing with the adjacent `isStoppedPaneLive` and `WakeDeps.livePaneIds` docs.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | bus-wake.ts:117-119 prose says null livePaneIds is NOT consulted; code (bus-wake.ts:132->158-160) + wiring (cli/bus.ts:450-462,612-616) consult it and map null->live, contradicting a load-bearing safety invariant. |

## Out of scope

- Any behavior change to the wake liveness recheck — the runtime is correct and ships as-is; this is a comment-only correction.
- The advisory `runWake` null-livePanes end-to-end test gap (auditor marked advisory only; the branch is unit-covered).

## Description

F1 (audit Consider section): the `creatorIsLive` doc-comment at
`src/bus-wake.ts:117-119` states a `null` `livePaneIds` "is therefore NOT
consulted here (the caller passes the empty set only when the probe genuinely
returned an empty sweep)." This is inaccurate. Evidence path: `creatorIsLive`
(bus-wake.ts:132) delegates to `isStoppedPaneLive`, which on `null` returns
live (bus-wake.ts:158-160); the caller `readLivePaneIds` returns `null` on a
degraded/missing-tmux probe (cli/bus.ts:450-462) and `runWakeVerb` passes that
`null` straight through as `livePaneIds: () => livePaneIds` (cli/bus.ts:612-616).
So `null` IS propagated and IS consulted and DOES map to live. Rewrite the
offending sentence so the three doc-comments (`creatorIsLive`,
`isStoppedPaneLive` at bus-wake.ts:142-149, `WakeDeps.livePaneIds` at
bus-wake.ts:227-231) agree: a `null` probe (unavailable) reads as live, the
conservative on-doubt-SKIP fallback. No code change.

## Acceptance

- [ ] The `creatorIsLive` doc-comment no longer claims `null` is "NOT consulted" / "empty set only on genuine empty sweep"; it states the `null`->treat-as-live conservative fallback, consistent with the two adjacent doc-comments. No runtime behavior changes.

## Done summary

## Evidence

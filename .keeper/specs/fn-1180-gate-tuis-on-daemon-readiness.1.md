## Description

**Size:** S
**Files:** src/readiness-client.ts, test/readiness-client.test.ts

### Approach

The shared subscribe client owns a per-connection catching-up value-latch and
surfaces its transitions, so display harnesses can gate rendering while headless
consumers keep receiving data unchanged. Contract: the latch starts ready; a served
frame carrying a boot header sets it to that header's catching_up (strict boolean —
a malformed value mutates nothing); a result frame with NO boot header observed
while latched clears it, because the server's pre-serialized memo path is bypassed
during catch-up, making a headerless result positive steady-state evidence; patch
and meta frames never mutate it; connection teardown resets it to ready and the next
connection's first result re-derives it. Follow the existing maxConcurrentPerRoot
boot-latch precedent — do not invent a parallel mechanism. Surface transitions via a
new optional subscription callback (alongside onBootStatus, which keeps firing per
boot-carrying frame) delivering the readiness boolean plus the freshest BootStatus,
fired on transitions rather than per frame.

While latched catching-up, arm a slow backstop interval (~2-5s) that schedules a
refetch for ONE idle subscribed collection per tick through the existing
scheduleRefetchFor / queryInFlight coalescer, so a freshly stamped result always
arrives to observe the settling flip (boot-complete fans out to no one and
patch/meta carry no header — without this a quiet board wedges the latch). Disarm
the interval the moment the latch clears; clearInterval on every teardown/dispose
path (Bun's setInterval has no unref). Never widen the 500ms pollAll — it is
slow-flight detection only.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves (a sibling epic touches this file — re-read the regions first).*

**Required** (read before coding):
- src/readiness-client.ts:993 — onBootStatus dispatch site (fires only when frame.boot is present)
- src/readiness-client.ts:855-870 — scheduleRefetchFor + queryInFlight/refetchDirty coalescer the backstop rides
- src/readiness-client.ts:1556 and :1973-1996 — maxConcurrentPerRoot boot-latch precedent to mirror
- src/readiness-client.ts:1156-1168 — teardown reset block the latch reset joins
- src/server-worker.ts:2155-2180 — stampBootStatus + memo-bypass doc comment grounding the headerless clear

**Optional** (reference as needed):
- src/readiness-client.ts:900-925 — pollAll (slow-flight only; add no refetches here)
- cli/await.ts:2136-2143 — existing catching_up consumer that must keep working
- test/readiness-client.test.ts:105 and :461-485 — makeMockConnect + fake-timer harness

### Risks

- The headerless-result clear couples to the memo-bypass invariant; if that ever weakens the latch clears one backstop tick early — visible churn, self-correcting on the next stamped header (accepted in the ADR).

### Test notes

Mock socket + fake timers; synthetic BootStatus headers. Cover every latch
transition, backstop arm/coalesce/disarm/dispose, and the regression guard that
bare mock frames without a boot field keep painting.

## Acceptance

- [ ] The subscribe client exposes catching-up transitions: set by a header reporting catch-up, cleared by a header reporting steady state or a boot-less result received while latched, untouched by patch and meta frames
- [ ] While latched catching-up the client refetches an idle collection every few seconds through the existing coalescer, stopping the moment the latch clears or the subscription is disposed, with no timer leak
- [ ] Existing consumers see no data-path change during catch-up: rows still deliver, onBootStatus still fires per boot-carrying frame, and the existing suite passes unchanged
- [ ] New unit coverage exercises every latch transition and the backstop lifecycle with mock socket and fake timers

## Done summary
Added a per-connection catching-up value-latch to the shared subscribe client (subscribeMulti), surfaced via a new onCatchingUp transition callback and threaded through subscribeCollection/subscribeReadiness, plus a slow backstop refetch of one idle collection while latched (disarmed on clear/teardown/dispose, no timer leak). Headless consumers are unaffected.
## Evidence

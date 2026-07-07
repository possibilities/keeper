## Description

**Size:** S
**Files:** cli/usage.ts, test/usage.test.ts

### Approach

Give the open-coded usage viewer the same frames capability through the
shared emitter — the dual-consumer invariant: one wire contract, two
integration points, no re-open-coding. Usage's frames entry plugs the task-1
emitter into its existing composed-frame path, respecting the structures the
shared shell cannot host: both subscribe streams feed one composed frame, the
per-stream once-guards keep coverage accounting honest, and the 30s
relative-time tick must never mint a frame — the raw-field hash change-gate
stays the sole emit trigger (a countdown repaint is exactly the no-op churn a
frames consumer must not drown in). Trailer, bounds, and exit codes behave
identically to the shell viewers. Add a parity test asserting usage's
envelopes are byte-shape-identical to a shared-shell viewer's (normalize
pid/paths/ts), following the existing keeper-meta parity test pattern.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/usage.ts:962-1024 — the open-coded shell: dual subscribeCollection streams, once-guards at :967-971, sidecar paths at :974-977
- cli/usage.ts:19-30 — why this path cannot adopt createViewShell (the constraint the integration works within)
- test/usage.test.ts:1873-1955 — the byte-shape parity test to mirror for frames

**Optional** (reference as needed):
- src/frames-emitter.ts — the emitter API as landed by task 1
- cli/frames.ts — the dispatch arm this entry completes

### Risks

- The 30s tick currently calls refreshLive without sidecar writes; wiring frames at the wrong layer would emit a frame per tick — hook the emitter at the hash-gated emit site, not the tick.

### Test notes

Pure tier with usage's existing fixtures: drive both streams, assert composed
frames emit once per hash change, tick alone emits nothing, parity vs a
shared-shell envelope after normalization.

## Acceptance

- [ ] keeper frames --view usage streams envelopes with the identical schema and trailer discipline as the shell viewers, proven by a normalized byte-shape parity test
- [ ] A relative-time tick with no underlying data change never emits a frame
- [ ] Both usage streams count once toward coverage accounting

## Done summary
Wired the open-coded usage viewer into the shared frames emitter via a new createUsageEmitEngine, so 'keeper frames --view usage' streams baseline/frame/trailer envelopes byte-shape-identical to the shell viewers with the raw-field hash gate as the sole emit trigger (a relative-time tick never mints a frame). Completed the cli/frames.ts usage dispatch arm; added pure parity/tick/coverage/bound tests.
## Evidence

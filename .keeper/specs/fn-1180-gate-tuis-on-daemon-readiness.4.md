## Description

**Size:** M
**Files:** cli/usage.ts, src/dash/app.ts, src/dash/view-model.ts, test/dash-app.test.ts, test/dash-view-model.test.ts

### Approach

The two off-harness human surfaces gate the same way the shared harness does.
usage: wire the subscribe client's transition callback into the open-coded shell —
while un-ready in watch mode, hold composed-frame emission at the engine's live
sink and paint a usage-neutral loading line via its liveShell.refreshLive (re-fold
percentage, a generic git-seed wait, or a plain catching-up label; no per-root
list), keeping the watch-mode-only guard so snapshot and frames stdout are never
touched; the gate latches latest-wins across its two subscription streams (one
daemon — take the freshest header or transition by arrival). Its frames and
snapshot paths thread the observed catch-up state through the envelope inputs with
the same one-static-loading-record discipline in frames mode. dash: extend
buildDashModel — the pure view-model — with a loading variant so the fast test tier
covers the gate without OpenTUI; the app shell wires the transition callback and
boot payload into its existing lifecycle-repaint pattern, renders the loading
variant while un-ready, and applies the same disconnect semantics as the shared
harness (~1.5s grace, immediate flip on a catch-up-reporting reconnect).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/usage.ts:1011-1060 — open-coded shell (liveShell, latestCursor, emit-engine sinks)
- cli/usage.ts:1210-1245 — the two subscribeCollection wirings and onBootStatus sites
- src/dash/app.ts:643-676 — paint, subscribeReadiness, lifecycle repaint
- src/dash/view-model.ts — buildDashModel, the pure seam for the loading variant
- the usage view's existing test suite — locate it before writing new coverage

**Optional** (reference as needed):
- test/dash-app.test.ts and test/dash-view-model.test.ts — existing dash harnesses with injected connect fakes
- src/view-shell.ts — the shared-harness gate semantics to mirror (grace, branches, precedence)

### Risks

- dash renders via OpenTUI, not the line overlay — keep the gate decision in the pure view-model so the fast tier tests it, with only the loading variant's rendering touching the OpenTUI layer.
- usage blends two streams; a gate keyed to a single stream's headers could flap — latch on the freshest across both.

### Test notes

dash: view-model unit tests for the loading variant plus an app-level test via the
injected connect fake. usage: extend its suite — a gated stream still delivers rows
but composes no frame; the loading line renders; the flip resumes composition; the
envelope stamping is threaded.

## Acceptance

- [ ] keeper usage in watch mode renders only a loading line while the daemon reports catch-up or is unreachable past grace, resumes composed frames when ready, and stamps its snapshot and frames envelopes with the observed state
- [ ] keeper dash renders a loading state driven by a pure view-model variant under the same conditions and resumes cards when ready
- [ ] Neither surface writes loading chrome into snapshot or frames stdout
- [ ] Both gates are covered by the fast pure-in-process tier

## Done summary
Gated keeper usage (watch/frames/snapshot) and keeper dash on the daemon's catching-up latch: usage merges the two subscribe streams' transitions latest-wins, holds live emission for a generic loading line, and threads the observed state into frames (one static loading record per gated window) and snapshot envelopes; dash gets a pure buildDashModel loading variant plus app-shell wiring with the same grace/immediate-flip disconnect semantics.
## Evidence

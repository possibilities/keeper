## Description

**Size:** M
**Files:** src/autoclose-worker.ts, src/provider-leg-death-notice.ts, cli/status.ts, docs/adr/0056-wrapped-provider-leg-window-lifecycle.md, docs/adr/0069-provider-leg-death-notices-and-honest-waits.md, docs/install.md, docs/problem-codes.md, plugins/plan/template/_partials/worker-implement-wrapped.md, test/autoclose-worker.test.ts, test/provider-leg-teardown.test.ts

### Approach

Make the cascade reconciler the single actuator for owned-leg window teardown: after exit confirmation it tears the window down from birth-captured pane/generation coords (terminal job rows null their pane ids, so the old bucket structurally cannot) under the same exact-identity preconditions the bucket uses; owned idle-stopped-window cleanup folds in as another trigger keyed by leg_launch_id. Carve the ADR 0056 wrapped autoclose bucket down to the legacy ownerless cohort only, and surface that cohort as a display-only drain gauge in status (not a jam). Coordinate death-notice and cascade paging so one incident pages once. Update the wrapped worker prompt partial to the transfer-not-title rule (regenerate via the prompt compiler — never hand-edit generated outputs), revise ADR 0056's authority text, fill ADR 0069's placeholder with a pointer to 0071, refresh install.md's cleanup description, and add the new problem codes.

### Investigation targets

*Verify before relying.*

**Required:**
- src/autoclose-worker.ts:275-368 — the wrapped bucket's stopped-job/topology preconditions (retain for legacy only) and the pane-id targeting the reconciler replaces
- src/provider-leg-death-notice.ts:172-229 — interim owner inference this epic's registry supersedes; paging coordination point
- cli/status.ts:158-233 — where the drain gauge lands (display-only, never needs_human)
- plugins/plan/template/_partials/worker-implement-wrapped.md:24-48 — the wait/resume prose the transfer rule replaces
- docs/adr/0056 + 0069 — the exact sections 0071 supersedes

**Optional:**
- plugins/prompt/test/render_plugin_templates.test.ts:432-437 — compiler fixture coupling for the partial edit

### Risks

- The legacy bucket must never infer an owner, transfer, or release a claim from title shape — its only remaining job is stopped-window convergence for the pre-ownership cohort.
- Deleting the bucket happens in a LATER epic once the cohort queries zero — this task only carves and gauges.

### Test notes

Cover: reconciler teardown from birth coords after exit-confirm; bucket skips any birth carrying ownership; drain gauge counts; one-page-per-incident across both producers; compiler-rendered partial matches fixtures.

## Acceptance

- [ ] Owned legs' windows are torn down solely by the reconciler; the autoclose bucket acts only on pre-ownership births
- [ ] The legacy cohort renders as a display-only count that trends to zero and never jams the board
- [ ] One terminal incident produces at most one operator page across death-notice and cascade
- [ ] The wrapped worker partial states the transfer-not-title rule and renders through the compiler
- [ ] ADRs 0056/0069, install.md, and problem-codes reflect the 0071 contract

## Done summary
Moved owned Provider-leg tmux window teardown into the durable cascade producer using birth-captured pane/generation identity, carved the ADR 0056 autoclose bucket down to legacy ownerless legs with a display-only drain gauge, coordinated one-page-per-incident across death-notice and cascade, updated the wrapped worker prompt partial to the transfer-not-title rule, and revised ADR 0056/0069, install.md, and problem-codes.md.
## Evidence

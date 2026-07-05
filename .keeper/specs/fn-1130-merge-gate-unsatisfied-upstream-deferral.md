## Overview

The cross-epic merge-gate defers a dependent group's lane cut only for SATISFIED same-resolved-repo upstreams, so a lane cut while an upstream epic is still open gets a permanently stale base (observed: workers DEPENDENCY_BLOCKED, hand-fixed). Since an epic-level dep blocks every task of the dependent until the upstream completes, the early cut buys nothing — extend the gate so a blocked-incomplete same-repo-lane upstream also defers the cut, probe-free, keeping every existing satisfied/inconclusive/absent property intact.

## Quick commands

- `bun test test/autopilot-worker.test.ts` — the merge-gate suite

## Acceptance

- [ ] A dependent epic's lane is never cut in a repo where an unsatisfied same-repo-lane upstream epic exists, with all existing merge-gate properties (satisfied-but-unmerged deferral, inconclusive-defers, absent-implies-merged, cross-repo/dangling not-gating) unchanged and test-pinned

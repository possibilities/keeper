## Overview

The repair-escalation observability work shipped a class-stable operator
grep/alarm contract (`RepairCandidateDropClass`) for repair-candidate drops,
but one drop reason — `empty_token` — is emitted under the same
`repair-candidate-drop` prefix while sitting OUTSIDE that documented union,
bypassing the typed `drop()` helper that exists to enforce it. This closes
that gap so the documented union is the complete, honest alarm contract and
no maintainer building an alarm off it is silently trapped.

## Acceptance

- [ ] Every `# repair-candidate-drop ... class=<x>` line the daemon can emit
      carries a `class` that is a member of the documented drop-class contract
      (either `empty_token` joins the union and routes through the typed helper,
      or it moves to a distinct prefix outside the `repair-candidate-drop`
      grep contract).
- [ ] The class-union stability test reflects the reconciled membership.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | Audited src/daemon.ts emits `class=empty_token` under the repair-candidate-drop prefix but outside the 4-member RepairCandidateDropClass alarm contract, bypassing the typed drop() helper — surprises the next maintainer building an alarm off the union. |
| F2 | culled | — | CLAUDE.md rule #0 provenance/narration-comment nit in test/daemon.test.ts; zero user/behavior/correctness impact and pre-existing fn-870 precedent — fails the keep bar. |
| F3 | culled | — | The console.error production adapter is a thin pass-through over a thoroughly-tested pure seam; auditor marked it non-blocking, no real coverage gap. |

## Out of scope

- Any behavior change to the dirty-checkout DEFER or the dispatch gate itself
  (the audited epic is explicit the gate is correct; only observability was in scope).
- Why the shared checkout stayed dirty for the incident window (already declared
  out of scope by the source epic).
- Provenance-comment / test-narration cleanup and console.error adapter coverage
  (both culled at audit).

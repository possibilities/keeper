## Description

**Size:** S
**Files:** CLAUDE.md, README.md

Update the architecture docs to reflect that `pending_dispatches` is now a
readiness occupant, not a standalone reconcile suppression arm.

### Approach

In CLAUDE.md `## Autopilot dispatch gates`: (1) add `dispatch-pending` to the
canonical occupant-set header as a 4th approval-pending occupant + add the
fn-tag alongside fn-663/671/703/719; (2) REPLACE the "Closes the
launch→SessionStart blind window" bullet — it currently frames
`pending_dispatches` as a fifth `reconcile()` suppression arm OUTSIDE
`computeReadiness`; rewrite to the `dispatch-pending` occupant flow (occupies
both mutexes, `verbForVerdict` null, the root-fallback facet, the predicate
rank) and COLLAPSE the suppression-arm framing rather than adding on top; (3)
add a 4th occupancy-facet bullet parallel to the existing three, ending with
the `verbForVerdict`-returns-null / test-pins-it sentence. In README: update
the eighth-worker `reconcile()` fifth-arm prose (~:1661-1672) to the occupant
flow; the `pending_dispatches` projection mechanics (~:1498) stay valid.
Note the SAFETY SEAM: this is the cross-cycle prerequisite; confirmRunning
still covers intra-cycle until step 3.

### Investigation targets

**Required** (read before coding):
- CLAUDE.md `## Autopilot dispatch gates` — occupant-set header + the three existing facet bullets (the structural template) + the fn-700 bullet (how a non-dispatchable blocked reason is documented) + the "Closes the launch→SessionStart blind window" bullet to replace.
- README.md eighth-worker reconcile prose (~:1661-1672) + pending_dispatches projection (~:1498).
- The shipped src/readiness.ts changes from .1 (so the docs match the actual rank + facet).

### Risks

- Don't overstate: pure observability-of-state in readiness, no behavior change beyond the new demotion; no schema change. Keep the "no reducer/fold change, read-time verdict" framing.
- Don't leave the stale suppression-arm description alongside the new one (implies both mechanisms live).

## Acceptance

- [ ] CLAUDE.md occupant-set header lists `dispatch-pending` + new fn-tag; the blind-window bullet is REPLACED (not appended) with the occupant flow; a 4th facet bullet added with the verbForVerdict-null pin sentence.
- [ ] README reconcile prose updated to the occupant flow; projection mechanics left intact.
- [ ] The SAFETY SEAM (cross-cycle only; confirmRunning still covers intra-cycle until step 3) is documented.

## Done summary
Updated CLAUDE.md + README to frame pending_dispatches as the dispatch-pending readiness occupant (canonical occupant set + 4th facet bullet + replaced blind-window bullet) instead of a standalone reconcile suppression arm; documented the cross-cycle-only SAFETY SEAM with confirmRunning still covering intra-cycle.
## Evidence

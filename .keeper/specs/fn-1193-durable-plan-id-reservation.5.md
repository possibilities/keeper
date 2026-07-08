## Description

**Size:** M
**Files:** src/await-conditions.ts, src/dispatch-failure-key.ts, src/autopilot-worker.ts, cli/board.ts, test/await-conditions.test.ts, test/dispatch-failure-key.test.ts

### Approach

Make a landed duplicate number impossible to consume silently. Three arms. First,
bare-id resolution: findEpicByIdOrBare currently returns the FIRST epic whose
epic_number matches a bare `fn-N`; change the contract to a typed ambiguity outcome
naming every matching full id, and update its callers to surface that refusal
(await conditions error out with the candidate list). The board's sibling resolver
epicNumFromIdOrBare gets the same discipline so the two agree. Second, a
producer-probed distress row: once per reconcile cycle (a pure read over the live
epics projection — never a fold, never per-event) detect two non-done epics in one
project sharing an epic_number and mint a sticky needs-human distress row keyed per
(project, number) following the SHARED_WEDGE_DISTRESS template — synthetic daemon
verb, unknown-arm routing, orphan-GC-exempt, not retry_dispatch-clearable,
level-cleared when the duplicate no longer holds. No new schema surface: the row
rides the existing dispatch_failures shape, so no SCHEMA_VERSION moves fire.
Third, the board renders the distress row like its siblings (existing pill/needs-human
machinery — a text line, no new render subsystem).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/await-conditions.ts:341-370 — findEpicByIdOrBare and its doc-comment acknowledging the first-match ambiguity; enumerate its callers before changing the return contract
- cli/board.ts:439 — epicNumFromIdOrBare, the parallel resolver that must agree
- src/dispatch-failure-key.ts:112-175 — the SHARED_WEDGE_DISTRESS template: key shape, is<X>DistressKey predicate, unknown-arm routing, GC exemption
- src/autopilot-worker.ts — the once-per-cycle producer-probe precedent (the deferredEpicIds pure-reconcile read) for where the duplicate scan slots in

**Optional** (reference as needed):
- CLAUDE.md "Needs-human" vocabulary and the distress-row invariants (level-cleared, never fold-minted)
- CONTEXT.md — Needs-human, Distress row, Pinned epic terms

### Risks

- The probe must be O(open epics) per cycle over the projection read the reconciler already holds — no extra DB scans, no fold participation (re-fold determinism stays untouched)
- Changing findEpicByIdOrBare's return shape ripples through await parsing; a typed sentinel with exhaustive caller updates beats an exception
- A duplicate involving a DONE epic is history, not a jam — scope detection to non-done pairs so closed history cannot mint eternal distress

### Test notes

Fast tier, pure: resolver tests over synthetic epic sets (unique bare → resolves;
duplicate bare → typed refusal naming both; full id always resolves); distress-key
predicate + routing tests mirroring the SHARED_WEDGE suite; producer-probe unit
over a synthetic projection read asserting mint on duplicate, level-clear on
resolution, and key stability across cycles.

## Acceptance

- [ ] A bare `fn-N` that matches two live epics resolves to an explicit ambiguity refusal naming both full ids, in both the await resolver and the board resolver; full-id resolution is unchanged
- [ ] Two non-done same-project epics sharing a number surface as one sticky needs-human distress row that clears itself once the duplicate no longer holds, and closed epics never mint it
- [ ] The detection runs as a bounded per-cycle producer probe with no fold, no new RPC, and no schema change
- [ ] Root fast suite passes with the new tests

## Done summary

## Evidence

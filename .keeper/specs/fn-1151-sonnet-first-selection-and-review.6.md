## Description

**Size:** S
**Files:** plugins/plan/README.md, docs/problem-codes.md

### Approach

Consolidate — never append — the plan README's selector narrative: the sonnet-first
default and burden-of-proof rule, the human-owned hand_tuned section, and the
selection-review lifecycle (close-time audit, the committed dataset file, the clearable
display-only board flag and its clear verb), replacing every stale
route-up-when-uncertain claim. Add problem-codes rows for each new machine-matchable
code shipped by the review verbs (set/clear misuse, audit-brief already-exists, submit
validation rejects), slotted into the plan-family table. Forward-facing prose only; all
docs lint gates stay green.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/README.md — the selector section and the mechanical-default framing to rewrite
- docs/problem-codes.md — family-table format and placement rules

**Optional** (reference as needed):
- docs/adr/0011-close-time-selection-review.md — the decision the prose must match

### Risks

- The README predates both this epic and the multi-harness one landing just before it —
  reconcile against the file as it stands, not against pre-epic assumptions.

### Test notes

Docs lint gates; grep for stale route-up phrasing.

## Acceptance

- [ ] The plan README describes sonnet-first selection, hand_tuned ownership, and the
      selection-review lifecycle as current behavior with no stale route-up claims.
- [ ] Every new machine-matchable verb code has a problem-codes row in the correct
      family table and the docs lint gates pass.

## Done summary

## Evidence

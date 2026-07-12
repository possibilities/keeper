## Description

**Size:** S
**Files:** cli/ or scripts/ (a read-only report surface — determined at build), a reducer read helper, test/

### Approach

Add an out-of-band measurement report that validates the re-scope's hypothesis and the gate's
effect: classify merge-conflict incidents (from keeper.db history + the new structured
`conflicted_files` from `.6`) into base-drift vs file-overlap vs other, report the split (the
diagnostic found 66/29), and — once the gate is enabled — track drift-refreshes performed and
a proxy for conflicts prevented. Out-of-band, read-only (the ADR 0042 #5 measurement framing),
NEVER in the reconcile/fold path. It quantifies whether the base-freshness gate actually reduces
the 66% base-drift conflict rate.

### Investigation targets

*Verify before relying — the repo moves.*

**Required:**
- the `dispatch_failures.conflicted_files` structured data from `.6`
- existing conflict / merge-escalation history in keeper.db (the `events` + `dispatch_failures` surface)
- the read-only report/query verb conventions (out-of-band, never a fold)

**Optional:**
- docs/adr/0042 decision #5 (measurement framing)

### Risks

This is a measurement/validation deliverable — it READS history, it does not gate execution. Keep it out-of-band (never in the reconcile path or a fold).

### Test notes

Test the classifier over a fixture of conflict incidents produces a base-drift-vs-other split; the report shape is stable.

## Acceptance

- [ ] A read-only report classifies conflict incidents into base-drift vs other and reports the split, sourced from structured conflict data.
- [ ] When the gate is enabled, the report surfaces drift-refreshes performed and a proxy for conflicts prevented, validating the base-drift hypothesis.

## Done summary

## Evidence

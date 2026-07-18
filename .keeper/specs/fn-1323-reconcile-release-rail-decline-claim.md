## Overview

The cooperative claim-release rail shipped its decline read/annotate half
(parse, classify, annotate, protocol text) fully built and tested, but no
production code path can ever WRITE a decline record -- yet ADR 0078 and the
source task's done_summary present recorded declines as a shipped, honored
v1 capability. This follow-up reconciles that claim/diff drift so the
read-side lands honestly as forward-scaffolding rather than a claimed-but-
inert feature, removing the "dead code with no producer" surprise for the
next reader.

## Acceptance

- [ ] ADR 0078 marks decline-RECORDING as deliberately deferred (parallel to
      the auto-forfeiture deferral it already states), so the doc matches the
      shipped surface and the read-side reads as named scaffolding.
- [ ] The decline read/annotate/protocol code is documented (doc-comment) as
      the awaiting-producer half of the rail, not live behavior.
- [ ] The claim/diff drift is closed: no doc or done-summary surface still
      presents production decline-recording as delivered.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | No production decline producer: WriteReleaseRecordInput lacks a declines field, writeReleaseRecord only carries forward existing.declines, releaseMain never sets one; ADR 0078 claims declines shipped v1 -- claim/diff drift plus a producerless read body. |
| F2 | culled | — | Minor perf/speculative-generality in applyReleaseWitness; bounds keep it safe, ~0-1 records, branch is dead weight until a producer exists -- no user-observable impact. |
| F3 | merged-into-F1 | .1 | F3 (no production decline round-trip test) shares F1's root cause -- no producer to test; resolving F1's drift dissolves the gap, so F3 folds into F1. |

## Out of scope

- Shipping an actual decline PRODUCER (a keeper session release --decline path
  or a declines-carrying WriteReleaseRecordInput + verb). This is the heavier
  alternative resolution; deferred to a named future decision alongside
  ADR 0078's auto-forfeiture half unless the worker judges the producer small
  enough to land in place of the reconciliation.
- Auto-forfeiture and holder-fencing (already deferred by ADR 0078).

## Description

**Size:** M
**Files:** src (retention sweep + its watermark derivation), test (retention suite)

### Approach

Locate the retention sweep that logs "retention BUG: N keep-set event(s) have a NULL
body" and the shed pass above it. Determine whether (a) an earlier shed overshot the
keep watermark, (b) some writer mints events with NULL bodies that the detector
misclassifies as stripped, or (c) the keep-set/watermark computation drifted (e.g. cursor
vs watermark off-by-window). Fix the true cause. Assess blast radius explicitly: if any
NULL-bodied event is one the deterministic-replay fold reads, a future cursor-0 re-fold
diverges — state whether that class is affected and, if so, what mitigation applies
(the finding gates rewinding migrations until resolved).

### Investigation targets

*Verify before relying — the repo moves.*

**Required** (read before coding):
- The retention worker/sweep in src — the shed pass, the keep watermark, and the BUG detector line
- The events writers — whether any legitimately mints NULL bodies

### Risks

- If bodies inside the keep window are genuinely lost AND re-fold-relevant, a rewinding migration would replay divergently — surface this loudly rather than quietly fixing forward.

## Acceptance

- [ ] Root cause named with evidence; regression test lands in the retention suite
- [ ] Replay blast radius explicitly assessed and stated in the Done summary
- [ ] The BUG line is absent on a fresh healthy run; full fast suite green

## Done summary

## Evidence

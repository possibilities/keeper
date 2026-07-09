## Description

**Size:** S
**Files:** plugins/plan/scripts/model-guidance-check.ts, plugins/plan/model-selector.yaml, plugins/plan/skills/model-guidance/references/gpt-5.3-codex-spark.md, plugins/plan/test/consistency-model-selector.test.ts

### Approach

The drift gate's research map currently errors on any entry not on the embedded subagents axis and skips the hash check when it does — so backfilling research for a host-roster model is impossible without the gate change, and the gate change without hash enforcement would leave the new reference unvalidated. Restructure the research-map check: an entry for a non-configured model is tolerated (mirroring the guidance-block extra tolerance, keeping the gate host-independent), but EVERY entry's reference file must exist and hash-match — the skip-continue goes away. A typo'd entry thus self-reveals as a missing reference file rather than silently passing.

Then the backfill, targeting gpt-5.3-codex-spark (the activation model — codex-served): author references/gpt-5.3-codex-spark.md through the model-guidance skill flow (a real research pass — provenance header with date and sources, strengths/weaknesses/when-to-pick, following the existing per-model reference shape), add the hash-anchored research entry, and refresh the EXISTING gpt-5.3-codex-spark guidance block to the trickle posture: route it only for genuinely-bounded mechanical work (the low/medium band shapes) until out-of-band cell-review cohorts justify promotion — advisory prose only, no selector gating mechanism. The gpt-5.5 guidance block becomes the tolerated extra with no research entry.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/scripts/model-guidance-check.ts:168 coverageErrors allowExtraBlocks (the tolerance precedent), :227-230 the strict research loop and the hash-skipping continue, :264 checkModelGuidanceFromDisk (reads disk subagents.yaml — keep it host-independent)
- plugins/plan/model-selector.yaml:131 the existing gpt-5.3-codex-spark guidance block to refresh (:119 is the gpt-5.5 block that stays a tolerated extra); the research: map shape and header protocol (:1-15)
- plugins/plan/skills/model-guidance/references/opus.md and sonnet.md — the reference-file shape template
- plugins/plan/test/consistency-model-selector.test.ts — the gate assertion to extend

**Optional** (reference as needed):
- plugins/plan/skills/model-guidance/SKILL.md — the research→cache→distill flow this executes once for the new model

### Risks

- The guidance prose rides inside every selector prompt — keep the refreshed block short; raw research stays in the reference file

### Test notes

Gate cases: tolerated extra research entry with matching hash → green; tolerated entry with hash mismatch → red; tolerated entry with missing reference file → red; configured-model behavior unchanged. Consistency test asserts the same in the fast tier.

## Acceptance

- [ ] The model-guidance gate passes with a hash-anchored research entry for a model absent from the embedded axis, fails on any entry whose reference file is missing or hash-divergent, and existing configured-model behavior is unchanged
- [ ] A researched gpt-5.3-codex-spark reference exists with provenance, and its guidance block reads as trickle-posture selection advice distilled from it
- [ ] Plan fast suite green including the extended consistency test

## Done summary

## Evidence

## Description

**Size:** S
**Files:** plugins/plan/src/verbs/selection_brief.ts, plugins/plan/model-selector.yaml, plugins/plan/scripts/model-guidance-check.ts, plugins/plan/test/consistency-model-selector.test.ts

### Approach

selection-brief builds candidate_cells from effectiveMatrix() so wrapped capability
models become selectable the moment the host roster lists them. A roster model with no
model-selector.yaml guidance block fails the brief loudly, naming the missing block —
the enforcement moves to this runtime seam because host-added models are invisible to
repo CI. The committed drift gate keeps asserting both-directions parity against the
embedded default axes only, so suites stay host-independent. Add guidance blocks for
gpt-5.5 and gpt-5.3-codex-spark: capability fit only — strengths, when-to-pick,
when-to-avoid — never cost or provider ordering, which live in the matrix and stay
invisible to the content-blind selector. Verdict schema, assign-cells, and the sidecar
are untouched; model simply ranges wider.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/verbs/selection_brief.ts:189-289 — the brief renderer and candidate_cells build
- plugins/plan/model-selector.yaml — guidance block shape and voice to match
- plugins/plan/scripts/model-guidance-check.ts:157-164 — the both-directions axis gate

**Optional** (reference as needed):
- plugins/plan/test/consistency-model-selector.test.ts — the fast-suite mirror to keep green

### Risks

- Guidance prose that mentions cost or providers would let the content-blind selector
  internalize the pecking order — keep the blocks strictly capability-shaped.

### Test notes

Fixture matrix with one guided and one unguided wrapped model: brief lists the guided
model's cells, fails loud naming the unguided one; drift gate and consistency test green
against embedded defaults.

## Acceptance

- [ ] With a fixture roster the selection brief offers wrapped-model candidate cells and
      the selector verdict schema is unchanged.
- [ ] A roster model lacking a guidance block fails the brief loudly, naming the model
      and the file to edit.
- [ ] Guidance blocks for the two launch models exist, carry no cost or provider
      language, and the guidance drift gates stay green.

## Done summary
selection-brief builds candidate cells + brief axes from effectiveMatrix() so host-roster wrapped models are selectable; unguided roster models fail the brief loud; drift gate tolerates host-provisioned model blocks; added gpt-5.5 and gpt-5.3-codex-spark capability-fit guidance.
## Evidence

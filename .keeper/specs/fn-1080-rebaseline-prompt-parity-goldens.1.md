## Description

**Size:** M
**Files:** plugins/prompt/test/oracle/capture.ts, plugins/prompt/test/oracle/fixtures/**, plugins/prompt/test/parity.test.ts

### Approach

Adapt the capture tooling to record from the current `keeper prompt` engine (the Python
oracle is retired and cannot be re-captured), regenerate the fixture universe against the
current corpus, and prune fixtures whose refs no longer exist. Update the suite header: the
candidate-parity half becomes a regression pin of recorded engine behavior (an independent
recorded snapshot — expected values must not be computed by the same code path at assert
time). Keep the harness-integrity half. Verify the recorded universe covers the same verb
surface (render, find-snippets, check-generated, render-plugin-templates modes) so coverage
does not silently shrink.

### Investigation targets

**Required** (read before coding):
- plugins/prompt/test/oracle/capture.ts — how fixtures are captured and manifest written
- plugins/prompt/test/parity.test.ts:1-60 — the two-half design and normalizer contract
- plugins/prompt/test/oracle/normalize.ts — the promptctl→keeper-prompt transform (may retire)

### Risks

- Recording from the candidate risks freezing a NEW bug as golden — eyeball-review the regenerated fixture diff for the check-generated envelope (paths must exist) and a sample of renders before committing.

### Test notes

Full plugins/prompt suite green; spot-check one deleted-ref fixture is gone and one
check-generated fixture carries the fixed envelope.

## Acceptance

- [ ] Fixtures regenerated from the current engine + corpus; dead refs pruned; suite green
- [ ] Suite/tooling prose reflects the regression-pin role
- [ ] Regenerated fixture diff reviewed for the two known divergence classes (corpus edits, check-generated envelope fix)

## Done summary

## Evidence

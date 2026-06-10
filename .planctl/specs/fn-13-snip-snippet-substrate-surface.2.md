## Description

**Size:** M
**Files:** planctl/brief.py, planctl/run_claim.py, planctl/run_worker_resume.py, planctl/run_close_preflight.py, planctl/run_scaffold.py, tests/conftest.py, tests/test_claim.py, tests/test_scaffold.py, tests/test_stub_contracts.py, tests/test_close_preflight.py, tests/test_worker_resume.py, CLAUDE.md

### Approach

- **brief.py:** `assemble_brief` stops calling `_render_snippet_context` and
  sets `snippet_context: ""` unconditionally — no `promptctl render-spec`
  subprocess on any claim or worker-resume path. The key stays in the brief
  (schema_version stays 1). Remove the now-dead render helper and
  `BriefRenderError` raise path from this flow; the `SNIPPET_RENDER_FAILED`
  translation in run_claim.py goes with it.
- **run_close_preflight.py:** quiet its own `_render_snippet_context` the
  same way — the envelope keeps a `snippet_context` key, always `""`, and no
  subprocess fires. Its `SNIPPET_RENDER_FAILED` emitters go too.
- **run_scaffold.py:966-991:** remove the no-substrate advisory at the
  emission site (the `scaffold_data["warnings"]` append). If the detection
  booleans become unused and trip ruff, remove them as well — emission-site
  quiet is the contract, lint-clean is non-negotiable.
- **Leave fully intact:** `bundle_ref.py`, `sketch_refs.py`, the
  `inline-sketch-refs` shell-outs in scaffold/refine-apply/epic-create,
  `run_{epic,task}_set_{snippets,bundles}.py`, persisted `snippets`/`bundles`
  fields, and `ref_invalid` validation. Dormant means unprompted, not broken.
- **Tests:** rewrite `tests/test_claim.py` snippet assertions (`:175` keeps
  asserting `snippet_context == ""`; delete/replace `test_claim_snippet_render_failed`
  at `:424-448` — the path no longer exists); invert
  `test_scaffold_no_substrate_emits_advisory_warning` (no advisory ever) and
  fold its two no-advisory siblings; retire the render-spec stub coupling in
  `test_stub_contracts.py:39-78` and the vestigial `_mock_brief_render`
  autouse fixture in conftest if nothing shells render-spec anymore; sweep
  test_close_preflight.py and test_worker_resume.py for render assertions.
  Note: tests/conftest.py and tests/test_claim.py carry uncommitted edits
  from concurrent work — touch only what this task owns, never stage
  another session's hunks.
- **CLAUDE.md:** prune to present tense — the "Write-time `sketch/` inlining
  (fn-610/fn-628)" bullet, the scaffold no-substrate advisory sentence in
  the warnings bullet, the snippet-context sentences in the
  Inheritor-skills bullet (claim assembles task spec + epic spec into the
  brief; no substrate clause), and the closing `~/arcs/snippeting` pointer
  line. No tombstones.

### Investigation targets

**Required** (read before coding):
- planctl/brief.py:57-82,97-136 — render helper, assemble_brief, BriefRenderError
- planctl/run_claim.py:283-300 — SNIPPET_RENDER_FAILED translation
- planctl/run_close_preflight.py:89-112,236 — the second render path
- planctl/run_scaffold.py:966-991 — advisory emission site
- tests/test_claim.py:175,424-448 and tests/test_scaffold.py:270-345 — assertions that invert

**Optional** (reference as needed):
- planctl/run_worker_resume.py:138-149 — second assemble_brief caller
- tests/test_stub_contracts.py:39-78 — stub-to-real contract test
- tests/conftest.py:188-222 — _mock_brief_render fixture

### Risks

- The brief key must remain present-and-empty; dropping it is a schema
  change that breaks worker briefs mid-flight.
- `inline-sketch-refs` stays a live shell-out on scaffold writes even though
  nothing authors bundle refs anymore — intentional dormancy, do not remove.

### Test notes

`uv run pytest tests/` green; additionally eyeball one `planctl claim` +
`planctl reconcile` round-trip envelope in a sandbox project if convenient.

## Acceptance

- [ ] No code path in claim, worker-resume, or close-preflight shells `promptctl render-spec`
- [ ] Brief and close-preflight envelopes carry `snippet_context: ""` always; brief schema_version stays 1
- [ ] Scaffold success envelope never carries the no-substrate advisory
- [ ] Dormant verbs (`epic/task set-snippets`/`set-bundles`) and `inline-sketch-refs` integration unchanged and green
- [ ] `uv run pytest tests/` passes; no orphaned stubs or vacuous tests remain
- [ ] CLAUDE.md reads present-tense with all substrate clauses pruned

## Done summary

## Evidence

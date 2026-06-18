## Description

**Size:** M
**Files:** apps/promptctl/promptctl/cli.py, apps/promptctl/promptctl/api.py, apps/promptctl/promptctl/run_render_spec.py, apps/promptctl/promptctl/run_bundle_health.py, apps/promptctl/promptctl/run_bundle_health_snapshot.py, apps/promptctl/promptctl/run_inline_sketch_refs.py, apps/promptctl/tests/, scripts/lint-cli-boundaries.py

### Approach

Delete the four pipeline verb modules (run_render_spec, run_bundle_health, run_bundle_health_snapshot, run_inline_sketch_refs), their cli.py command blocks and AGENT_HELP lines, and their api.py symbols (render_spec, inline_sketch_refs, InlineSketchRefError and any SketchResolutionError) plus the module docstring clauses naming them. SCOPE GUARDS: show-seen-snippets/clear-seen stubs and their --session-id flags belong to fn-663.2 — leave them exactly as found (if fn-663 already landed, they are gone; either state is fine). The kept render verb's --session-id no-op flag (cli.py:199-208, run_render.py) is deliberate (fn-622) — do not touch. In scripts/lint-cli-boundaries.py, remove the promptctl member from the planctl SUBPROCESS_EXEMPTIONS entry (keeper stays) and rewrite the 66-73 comment block — after the planctl-side strip, zero planctl-to-promptctl subprocess calls remain. Run a final --help pass on promptctl to catch help-text drift.

### Investigation targets

**Required** (read before coding):
- apps/promptctl/promptctl/cli.py:151-287 — the command blocks to delete vs the render --session-id flag to keep
- apps/promptctl/promptctl/api.py:181-315 — symbols to strip
- scripts/lint-cli-boundaries.py:66-76 — exemption table + comment block
- apps/promptctl/tests/test_render_dedup_disabled.py — the render_spec-calling test (~140) must be deleted with the symbol, render-only assertions kept

**Optional** (reference as needed):
- apps/promptctl/promptctl/run_render.py:31-33,165,186-188 — the kept no-op flag pattern

### Risks

- fn-663.2 may land before or after this task on the same cli.py/api.py — the scope guard above makes both orders safe, but expect possible rebase noise.

### Test notes

DELETE: test_render_spec.py, test_bundle_health.py, test_bundle_health_snapshot.py, test_inline_sketch_refs.py, test_api_inline_sketch.py. PRUNE: test_render_dedup_disabled.py (keep render-only + HOOKS_TRACKER_DB assertions). Gate: `turbo run py:lint py:typecheck` and `uv run pytest apps/promptctl/tests/` green; `promptctl --help` and `promptctl --agent-help` name no removed verbs.

## Acceptance

- [ ] render-spec, bundle-health, bundle-health-snapshot, inline-sketch-refs absent from cli.py, api.py, --help, and --agent-help; modules deleted
- [ ] render's --session-id flag and the seen-stubs surface (fn-663 territory) untouched by this commit
- [ ] lint-cli-boundaries SUBPROCESS_EXEMPTIONS: planctl maps to keeper only; comment block rewritten present-tense
- [ ] promptctl test suite, py:lint, py:typecheck green

## Done summary
Deleted render_spec, bundle_health, bundle_health_snapshot, inline_sketch_refs pipeline modules + their cli/api surface, tests; fixed generator return-type and tracker_db access diagnostics in test_render_dedup_disabled.py
## Evidence

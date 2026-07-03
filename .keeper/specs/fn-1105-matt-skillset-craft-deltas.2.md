## Description

**Size:** S
**Files:** plugins/plan/template/agents/worker.md.tmpl

### Approach

Shift the tautological-test rule left from audit time to authoring time: the worker template's test phase and completion criteria gain one rule — the expected value in any test the worker writes must come from an independent source of truth (a hand-computed constant, a fixture, a spec), never re-derived by the same code path under test. Mirror the quality-auditor's existing wording so the authoring rule and the audit check speak identically; the auditor stays the audit-time enforcement. Re-render the worker cells after the template edit so the generated-guard test passes.

### Investigation targets

*Verify before relying.*

**Required**:
- plugins/plan/template/agents/worker.md.tmpl:23 (completion criteria) and ~:114 (Phase 3 Tests) — the two insertion sites
- plugins/plan/agents/quality-auditor.md:126 — the canonical wording to mirror
- plugins/prompt/src/render_plugin_templates.ts — `keeper prompt render-plugin-templates` re-render flow; workers/ is gitignored with sha256 sidecars

### Test notes

`cd plugins/plan && bun test` — consistency-generated-guard passes after re-render.

## Acceptance

- [ ] The worker template's test guidance and completion criteria require expected values from an independent source of truth, in the auditor's voice
- [ ] Rendered worker cells are regenerated and the plan suite's generated-guard is green
- [ ] The quality-auditor's audit-time check is unchanged

## Done summary

## Evidence

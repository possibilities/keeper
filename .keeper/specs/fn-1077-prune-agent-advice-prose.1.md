## Description

**Size:** S
**Files:** plugins/plan/template/agents/worker.md.tmpl, plugins/plan/template/skills/work.md.tmpl

### Approach

Delete the worker template Rules block (:217-231) except items stating something no phase
states (audit each line: resume-directives ≈ :30, one-pass ≈ :85, test budget ≈ :112-127,
self-check ≈ :169, trust-git ≈ :153, return cap ≈ :173 — all restatements); keep the phase
bodies and every failure contract intact. Dedup the commit escape-hatch paragraph (:149) to
one statement — after the corpus epic lands it exists as a snippet; cite or inline once,
never twice. Trim work.md.tmpl's Guardrails (:202-211) to items its phases do not state.
Re-render all four worker cells and the work skill; verify byte-stable renders modulo the
intended deletions. Apply the no-op test line by line while in there — but no restructuring
(structure changes are the capabilities epic's).

### Investigation targets

**Required** (read before coding):
- plugins/plan/template/agents/worker.md.tmpl:217-231,149 and the phase lines each Rules item mirrors
- plugins/plan/template/skills/work.md.tmpl:202-211

### Risks

- The heredoc-truncation ban and Edit/Write self-check mitigate a filed harness bug — they stay, wherever they live after the prune.

### Test notes

Render + consistency suites green; diff review confirms only restatement left.

## Acceptance

- [ ] Rules block gone or reduced to non-phase items; escape-hatch stated once
- [ ] Four cells + work skill re-rendered; all sacred worker contracts present verbatim

## Done summary

## Evidence

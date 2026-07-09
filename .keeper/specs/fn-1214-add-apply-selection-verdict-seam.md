## Overview

One trusted apply seam for model-selector verdicts (ADR 0027): a new `apply-selection` verb validates the selector's raw JSON against the on-disk selection brief and lands cells through a core shared with `assign-cells` (live epics) or stages the selection verdict document `close-finalize` consumes (follow-up pre-select). This replaces the triplicated validate→write→degrade prose and heredoc/Write-tool transcription in the plan/defer/close skills; the selector subagent stays read-only and untouched.

## Quick commands

- `cd plugins/plan && bun test` — fast suite including the new saga spec and the cli-help/consistency gates
- `keeper plan apply-selection --help` — verb registration smoke (must exit 0 for the skill-prose gate)

## Acceptance

- [ ] apply-selection is the only apply path the three skills' selector beats invoke, in both live and follow-up contexts
- [ ] No calling skill hand-transcribes selector JSON; provenance hashes are pinned by the verb from the on-disk brief
- [ ] Every selection failure mode still degrades without blocking: live epics still arm, close still finalizes

## Early proof point

Task that proves the approach: `.1`. If it fails: keep the skills on the existing assign-cells/Write-tool paths and retire the verb branch that did not hold.

## References

- docs/adr/0027-trusted-verb-applies-selection-verdicts.md — the decision this epic implements
- plugins/plan/src/verbs/assign_cells.ts, selection_brief.ts, close_finalize.ts — the three seams the verb composes
- CONTEXT.md — Selector verdict vs Selection verdict document (the two artifact senses)

## Docs gaps

- **plugins/plan/README.md**: add apply-selection; consolidate the assign-cells paragraph around the shared core; reword the /plan:close command-table row (task .2 deliverable)
- **docs/problem-codes.md**: register verdict_invalid/brief_missing rows and revise cell_invalid's verb attribution (task .1 deliverable)

## Best practices

- **Layered untrusted-output validation:** parse → schema (strict, unknown-key-hostile) → semantic (exact coverage) → policy (axis allowlist from trusted config, never a model-echoed set) [OWASP LLM insecure-output-handling]
- **Degrade never bypasses validation:** `--degraded` reduces what is asserted, never whether inputs are validated; integrity/provenance checks fail closed with no bypass flag [fail-fast vs degrade-gracefully]
- **Preloaded provenance pinning:** hashes come from the trusted on-disk brief, never model transcription; a smuggled `selection:` block in the verdict is not trusted [OWASP pinning]
- **Atomic staged writes:** temp-then-rename on the same filesystem for the verdict document (the repo's atomicWriteRaw precedent) [write-file-atomic]

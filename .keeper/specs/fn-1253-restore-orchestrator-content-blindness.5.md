## Description

**Size:** S
**Files:** plugins/plan/CLAUDE.md, plugins/plan/README.md, CONTEXT.md, docs/adr/, docs/problem-codes.md

### Approach

Align the doc surface with the restored contract, prune-in-place. plan CLAUDE.md: the hooks sentence gains the fourth guard and the per-task audit-gate description routes through the two verbs; scope the content-blind claim to what is literally true — blind to spec and findings prose, with typed refs, hashes, counts, and enums as the coordination currency — by consolidation so the size lint stays green. README: dispatcher count, command-map rows for the two verbs, the same wording scope-down. CONTEXT.md: add the task-scoped auditor mode term (or extend the Audit gate entry) and sharpen the content-blind phrasing per glossary genre rules. One new ADR records the decision cluster: sizing signals are subagent-self-read from the brief (never orchestrator-carried), findings persist sink-side via task-scoped verbs, and the read guard is advisory fail-open context hygiene rather than a security boundary. problem-codes gains rows only if the verbs task minted new typed codes.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/CLAUDE.md — the hooks and audit-gate sentences to consolidate.
- docs/adr/0014-audit-gate-rides-block-machinery.md — the prior this extends; the gate mechanics are unchanged, so extend rather than supersede.
- plugins/plan/README.md — the three-dispatcher sentence and the command map.

**Optional** (reference as needed):
- docs/problem-codes.md — the plan-family table shape.
- scripts/lint-claude-md.ts — the size gate CLAUDE.md edits must keep green.

### Risks

- CONTEXT.md and docs/adr/ may carry unrelated in-flight changes — commit only files this task authors, by explicit path; slot the ADR number after whatever has landed by execution time.

### Test notes

bun scripts/lint-claude-md.ts; leave the vendor/bake drift gates untouched.

## Acceptance

- [ ] plan CLAUDE.md and README state four guards, list the task-scoped audit verbs, and scope the content-blind claim accurately, with the CLAUDE.md size lint green.
- [ ] CONTEXT.md defines the task-scoped auditor mode and the scoped content-blind term per glossary genre rules.
- [ ] A new ADR records the self-read, sink-persist, advisory-guard decision cluster; problem-codes rows exist exactly when new typed codes shipped.

## Done summary

## Evidence

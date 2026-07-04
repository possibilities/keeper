## Description

**Size:** M
**Files:** plugins/plan/agents/docs-gap-scout.md, plugins/plan/agents/gap-analyst.md, plugins/plan/agents/quality-auditor.md, plugins/plan/agents/close-planner.md, plugins/plan/agents/repo-scout.md, plugins/plan/template/agents/worker.md.tmpl

### Approach

Wire the read tier and the worker into the domain layer, flag-only for readers, hard-bounded for the worker. docs-gap-scout: CONTEXT.md and docs/adr become first-class targets it can flag for update OR deletion, each finding carrying one reason class from a fixed taxonomy — resolved-term-missing, glossary-conflict, adr-conflict, adr-worthy-decision, bloat/prune (bloat/prune covers superseded-but-unmarked ADRs and index staleness); plus the no-docs-sweep rule: never propose a docs-sweep task unless the doc change is itself a deliverable or blocks worker correctness. gap-analyst: a challenge-against-glossary report section — terms in the request or scout findings that conflict with, or are missing from, the target repo's CONTEXT.md surface as flags feeding the priority questions. quality-auditor: two new flags — code or specs using a term the glossary marks Avoid, and a shipped hard-to-reverse decision with no ADR; both Spec-axis findings, advisory. close-planner: routes those findings through its existing kept/culled/QUESTION machinery (verify no new verb needed). repo-scout: one line — read CONTEXT.md when present and speak its terms in the report. worker.md.tmpl doc-&-comment discipline block (the canonical block every surface echoes): consume glossary_md and use its canonical terms; flag Avoid-synonyms encountered in specs rather than propagating them; write CONTEXT.md/docs/adr ONLY when the task's declared deliverable includes that file (Files list membership); otherwise a needed-but-undeclared doc change is a BLOCKED: SCOPE_EXCEEDED escalation, and docs/adr content is exempt from the no-history comment rule. Re-render worker cells after the template edit. All reader edits are prose additions to report formats — verify none gains a write tool.

### Investigation targets

*Verify before relying.*

**Required**:
- plugins/plan/agents/docs-gap-scout.md (existing prune bias + doc-location scan; report headings), gap-analyst.md (report sections + Priority Questions contract), quality-auditor.md (two-axis findings shape, :126 region), close-planner.md (finding vet/cull/QUESTION protocol)
- plugins/plan/template/agents/worker.md.tmpl:231 region (the canonical doc-discipline block) and Phase 1 brief consumption (~:60)
- plugins/plan/CLAUDE.md — the echo-never-fork rule governing the canonical block

### Risks

- Fixed heading contracts: the planner parses scout reports by heading — additions must extend, never rename or reorder existing headings.
- The worker template is also edited by the craft-deltas epic (tautological guard) — this epic lands after; re-read before editing.

### Test notes

`cd plugins/plan && bun test` — generated-guard green after re-render; grep each reader's frontmatter for disallowedTools intact.

## Acceptance

- [ ] docs-gap-scout reports domain-doc findings with exactly one reason class each from the fixed taxonomy and states the no-docs-sweep rule
- [ ] gap-analyst emits a challenge-against-glossary section when a target repo has a CONTEXT.md; quality-auditor flags Avoid-synonym use and missing ADRs as advisory Spec-axis findings; close-planner routes them with no new verb
- [ ] The worker's canonical discipline block consumes the glossary, gates durable-doc writes on declared deliverables with SCOPE_EXCEEDED otherwise, and exempts docs/adr from the no-history rule
- [ ] Every read-tier agent still carries its write-free tool restrictions; worker cells re-rendered and the plan suite green

## Done summary

## Evidence

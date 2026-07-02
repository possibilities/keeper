## Description

**Size:** M
**Files:** plugins/plan/skills/plan/SKILL.md (Phases 5d/5e), plugins/plan/skills/defer/SKILL.md (spec template echo), plugins/keeper/skills/handoff/SKILL.md (brief guidance)

### Approach

Make authored specs durable-behavioral: acceptance criteria describe interfaces, contracts,
and observable outcomes — independently verifiable without reading the diff — and never cite
file:line (specs sit in the DAG for days; paths rot). Investigation targets KEEP file:line
(they are planner-verified at authoring time and cheap to re-verify) but gain a one-line
staleness note in the template ("verify before relying; the repo moves"). Rewrite the 5e task
template guidance accordingly: Approach states the behavioral contract and the why; the
Acceptance section is the checkable+exhaustive bar the worker's completion criteria consume.
Echo the same brief discipline in handoff's prompt-contract section (handoffs are the other
durable brief surface) including reference-don't-duplicate and redact-secrets lines. This is
the most load-bearing single edit in the portfolio — the template determines what every
future worker receives; keep the diff reviewable and the four-section validator contract
unchanged.

### Investigation targets

**Required** (read before coding):
- plugins/plan/skills/plan/SKILL.md Phases 5d/5e — the current template + spec-validator contract (four H2s unchanged)
- plugins/keeper/skills/handoff/SKILL.md — the brief-contract section

### Risks

- Over-rotating to behavioral-only would starve workers of orientation — Investigation targets stay, explicitly.

### Test notes

Scaffold a toy epic with the new template in a tmp plan project; validate passes; spec reads
as behavioral.

## Acceptance

- [ ] Acceptance-criteria guidance is behavioral, no file:line in acceptance; Investigation targets retained with staleness note
- [ ] Handoff brief guidance carries the same discipline; validator contract unchanged

## Done summary
Made authored task specs durable-behavioral: plan 5e (and defer's echo) Acceptance is now observable and file:line-free while Investigation targets keep file:line with a staleness note; handoff brief guidance gains the same discipline plus reference-don't-duplicate and redact-secrets. Four-section validator contract unchanged.
## Evidence

## Overview

New capability on the pruned base (hence the dep): a debugging skill keeper lacks entirely,
completion criteria bound to queryable observables instead of prose, durable behavioral task
briefs, a two-axis quality review, a scope-confirm reflex against the dominant correction
pattern (~340 design pivots where agents charged ahead), decision-ready escalation briefs, and
a skill-authoring guide that codifies the pruning method so the layer never re-bloats. Adapted
throughout for unattended operation: escalation replaces clarifying questions; the controller,
not the agent, owns completion gates.

## Quick commands

- `ls plugins/keeper/skills/debug/SKILL.md` — the new skill exists
- `grep -n "Completion criteria" plugins/plan/template/agents/worker.md.tmpl` — criteria at top, observable-bound

## Acceptance

- [ ] A debugging skill exists: no hypothesis before a red-capable feedback loop; escalates instead of asking; hard-stop when no loop can be built
- [ ] Worker completion criteria are checkable + exhaustive, stated at top-of-prompt, bound to observables (session_files clean, plan done stamped, suite green)
- [ ] Task-spec authoring guidance produces behavioral acceptance criteria; file:line lives only in Investigation targets (planner-verified at authoring time), never in acceptance
- [ ] quality-auditor reviews on two axes (Spec compliance ∥ Standards) reported side by side, never re-ranked into one list
- [ ] The authoring guide codifies the no-op test, leading words, one-trigger-per-branch descriptions, and completion-criteria discipline

## Early proof point

Task that proves the approach: `.2` (worker completion criteria) — it lands on the file with the
clearest observable bar and its effect shows up in the close-out gate metrics from the telemetry epic.

## References

- Method source: the pocock writing-great-skills levers (predictability, leading words, progressive disclosure licensed by branching, checkable+exhaustive completion, sentence-level no-op pruning) — fold as keeper's own guide, adapted for unattended workers
- Evidence anchors: ~340 design-pivot corrections vs 2 wrong-skill redirects in 6.5 weeks; premature-completion pattern (in_progress_uncommitted on 3 of 4 sampled cells)
- Two-axis review: Spec axis (matches the task spec) and Standards axis (repo conventions + smell baseline), reported separately so one axis never masks the other; smells stay judgement-calls, never hard violations; skip anything lint already enforces

## Docs gaps

- **plugins/plan/skills/plan/SKILL.md**: Phases 5d/5e task-spec template — the behavioral-brief change is the most load-bearing single edit
- **plugins/plan/skills/close/SKILL.md**: Phase 2 parse step if the auditor return format gains an axis
- **README.md**: note the new debug skill in the keeper plugin

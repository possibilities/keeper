## Overview

/plan:prompt polishes one tiny edit per turn toward a word-count target, which is tedious and engages only style. This epic rewrites it into a batched, maturity-driven loop: clustered approvable change-sets, AskUserQuestion intent batches, a per-turn slot-meter footer with an explicit verb-first action menu, cumulative content gates per size rung, and a maturity-first ready fork (ship / keep polishing / grow a rung) — with both doc echoes updated and the contract pinned by a consistency test.

## Quick commands

- cd plugins/plan && bun test test/consistency-skills.test.ts  # new prompt-skill literal pins green
- rg -n "AskUserQuestion" plugins/plan/skills/prompt/SKILL.md  # frontmatter grant + fallback + divergence note present

## Acceptance

- [ ] /plan:prompt proposes clustered numbered change-sets with approve-all / cherry-pick / skip semantics and explicit opt-in for scope-cut or constraint-removal items
- [ ] Intent questions batch through AskUserQuestion (at most 4) with an inline plain-text fallback for the picker-no-op failure mode
- [ ] Every turn ends with a named-slot progress meter and an adaptive verb-first plain-text menu; ready is maturity-gate-first with a Ship it / Keep polishing / Grow a rung fork
- [ ] Both doc echoes (plugins/plan/CLAUDE.md paragraph, plugins/plan/README.md row) match the new contract in present tense; the consistency suite pins the load-bearing literals and the plan fast suite is green

## Early proof point

Task that proves the approach: ordinal 1 (the only task). If it fails: the skill is a single static markdown file — revert it and re-land with narrowed scope (batching without the maturity meter).

## References

- anthropics/claude-code#9846 — AskUserQuestion invoked from a skill has historically no-opped and synthesized an answer; drives the inline plain-text fallback at every call site
- Approval-fatigue pattern literature — batch at logical-unit boundaries; high-risk items default off and never ride "approve all"
- Checklist-meter progress design — named finite slots beat an opaque percentage; name the missing slots so the next move is obvious
- Anthropic skill-authoring best practices — procedures over declarations, verbatim output templates, keep SKILL.md under ~500 lines

## Docs gaps

- **plugins/plan/CLAUDE.md**: update the /plan:prompt cadence clause in "Skills and agents" to the batched maturity loop (handled in-task; AGENTS.md symlinks here)
- **plugins/plan/README.md**: update the /plan:prompt skill-table row to the same contract, kept to one dense cell (handled in-task)

## Best practices

- **Risk-tiered batching:** scope cuts and constraint removals never ride "approve all" — explicit by-number opt-in only
- **Named-slot meter:** filled/total with the missing slots listed in ladder order; never an opaque percent
- **AskUserQuestion discipline:** at most 4 questions with 2-4 options, non-inferable slots only, and never assume the picker actually rendered — fall back to plain text
- **Number stability:** cherry-pick numbers are valid only against the immediately-preceding proposal; renumber fresh each turn
- **Stable menu grammar:** identical verb-first token shape every turn so the human learns it once

## Description

Finding F1 (evidence: README.md at the epic branch tip, line 5 vs lines
7-8). Line 5 reads "rationale and provenance live in `.keeper/` specs and
git history"; lines 7-8 read "Domain vocabulary lives in the CONTEXT.md
glossary; resolved architectural decisions live in docs/adr/." The two
adjacent statements give different homes for decision history, and line 5
contradicts CLAUDE.md rule-0 ("History and rationale have exactly one home
— docs/adr/, alongside commit messages"). Consolidate into one coherent
pointer: vocabulary -> CONTEXT.md, resolved decisions -> docs/adr, with
`.keeper/` specs framed as the plan/spec archive only (not a decision-
history home). Do not reintroduce a second rationale home.

## Acceptance

- [ ] README carries a single non-contradictory doc-home map; no line points rationale/decision history anywhere but docs/adr + commit messages

## Done summary

## Evidence

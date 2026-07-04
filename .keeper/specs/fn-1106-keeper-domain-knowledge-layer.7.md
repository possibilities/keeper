## Description

**Size:** M
**Files:** CONTEXT.md, docs/adr/0001-event-sourced-control-data.md, docs/adr/0002-single-host-sqlite.md, docs/adr/0003-fatal-exit-over-self-heal.md, docs/adr/0004-forward-only-migrations.md, CLAUDE.md, README.md

### Approach

Keeper becomes the first adopter — this doc work is the task's declared deliverable, the sanctioned worker-write path. (1) Create root CONTEXT.md: harvest keeper's terms of art from CLAUDE.md, the skills, and code comments — lane, ghost, sticky, fan-in, drain, reaper, pill, arm, board, readiness, projection, fold, synthetic event, Agent Bus, merge-gate, resolver, distress row, sidecar, brief, and peers discovered during the harvest — grouped under bounded-context subheadings (event-sourcing core / plan board / autopilot / worktree / bus). Each entry: 1-2 present-tense sentences plus an Avoid line naming rejected synonyms. Zero implementation detail — definitions name behavior and role, never files or functions. If the glossary exceeds the lint cap, split per the designed escape valve: a small CONTEXT-MAP.md at root pointing at per-context files — expected, not a failure. (2) Seed exactly four ADRs (the genuinely hard-to-reverse, surprising, traded-off decisions): event-sourced control data over a mutable store; single-host single-SQLite; no in-process self-heal — fatalExit plus LaunchAgent respawn; forward-only migrations. Each: Nygard-lightweight — title, status, 1-3 sentence context, the decision, consequences; decision history phrased as decisions, no changelog narration. (3) Prune CLAUDE.md net-smaller: vocabulary now defined in CONTEXT.md is referenced by term, not re-defined; rationale now in ADRs is dropped from guardrail prose; guardrails stay. (4) README gains its one-line pointer to the two homes. Every commit in this task passes through the new domain-docs lint arm — the first real exercise of the gate; treat any false positive as a finding for the pain ledger, use the escape hatch only with the annotation it requires. The task is re-runnable: existing entries and ADR files are updated in place, never duplicated.

### Investigation targets

*Verify before relying.*

**Required**:
- CLAUDE.md (the vocabulary embedded in its guardrail bullets — the harvest source and the prune target)
- plugins/keeper/skills and plugins/plan/skills SKILL.md files — terms of art in live use
- The landed linter's caps and fingerprints (its fixture corpus documents what passes)

### Risks

- The harvest is judgment-heavy: a term earns an entry when it is keeper-specific and load-bearing; general programming vocabulary is rejected at entry.
- CLAUDE.md prune must keep every guardrail an agent would otherwise get wrong — move definitions, never rules.

### Test notes

`bun scripts/lint-claude-md.ts` green with a smaller CLAUDE.md; `keeper commit-work` succeeds through the domain-docs arm; the epic Quick commands smoke the gate.

## Acceptance

- [ ] Keeper's root carries a linted glossary (or CONTEXT-MAP split) defining its terms of art with Avoid lines and no implementation detail
- [ ] Exactly four seed ADRs exist, each passing the 3-part significance test and the ADR structure checks
- [ ] CLAUDE.md is net-smaller with all guardrails intact, passing its lint
- [ ] README points at the two doc homes in one line
- [ ] All commits landed through the domain-docs lint arm

## Done summary
Bootstrapped keeper's domain-knowledge layer: a 55-line linted CONTEXT.md glossary (35 terms across five bounded contexts, each with an Avoid line, zero impl detail), four seed ADRs, a net-smaller CLAUDE.md (110->107 lines) with all guardrails intact, and a README pointer to the two doc homes. All commits passed through the new domain-docs lint arm.
## Evidence

## Description

**Size:** S
**Files:** CLAUDE.md, README.md, plugins/keeper/skills/pair/SKILL.md, plugins/plan/skills/panel/references/panel.md, src/renamer-worker.ts, src/resume-descriptor.ts, src/restore-set.ts

### Approach

Bring the prose in line with the landed system, forward-facing only (no
provenance, no epic ids). CLAUDE.md: generalize the sole-writer bullet — the
events-log tree now has per-file hook-writer-class writers (claude
events-writer, hermes shim, pi extension), the launcher is sole writer of the
births tree, the birth-ingest and codex-state producers feed main's synthetic
events; hook rules cover the shim and the in-process extension (exit-0 /
fail-open, no bun:sqlite, private logging, no host stdout); the restore
guardrail line follows the keeper tabs restore spelling; worker-contract notes
reflect the new workers. Keep bun scripts/lint-claude-md.ts green — consolidate,
don't append. pair SKILL.md: harness enumerations include hermes, consent/trust
notes per harness (codex seeder, pi -na + ephemeral extension, hermes allowlist
seeding). panel.md: eligibility is capability-derived wording. README: ingest
narrative and producer map acknowledge multi-harness sources. Docstring prunes
where code is now harness-agnostic but prose says Claude (renamer-worker,
resume-descriptor, restore-set headers).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- CLAUDE.md sole-writer + hook-rules bullets as landed after the preceding tasks (including fn-1102's guardrail respelling)
- scripts/lint-claude-md.ts — the size/re-narration gate
- plugins/keeper/skills/pair/SKILL.md — every claude|codex|pi enumeration

**Optional** (reference as needed):
- README.md system map block
- plugins/plan/skills/panel/references/panel.md eligibility lines

### Risks

- CLAUDE.md lint gate is strict on size — additions must be paid for with consolidation

### Test notes

bun scripts/lint-claude-md.ts green; grep shows no remaining claim that the
events-writer hook is the only NDJSON writer or that pair/panel are
three-harness.

## Acceptance

- [ ] CLAUDE.md accurately states the multi-writer events-log, the births-tree sole writer, the new producers, and the shim/extension hook discipline, and its lint gate passes
- [ ] pair and panel docs enumerate the four harnesses with correct capability and consent notes
- [ ] No shipped docstring claims claude-only behavior for code that is now harness-agnostic

## Done summary
Aligned CLAUDE.md, README, pair/panel skills, and the renamer-worker docstring with the landed multi-harness system: multi-writer events-log class, births-tree sole writer, birth-ingest + codex-state producers, shim/extension hook discipline, four-harness pair/panel enumeration with capability-derived eligibility. Lint green, fast gate green.
## Evidence

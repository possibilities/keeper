## Description

**Size:** S
**Files:** CLAUDE.md, README.md, plugins/keeper/skills/pair/SKILL.md, plugins/plan/skills/panel/references/panel.md, src/renamer-worker.ts, src/resume-descriptor.ts, src/restore-set.ts

### Approach

Bring the prose in line with the landed system, forward-facing only (no
provenance, no epic ids). CLAUDE.md: generalize the sole-writer bullet — the
events-log tree now has per-file writers (claude events-writer + hermes shim),
the launcher is sole writer of the births tree, the birth-ingest producer feeds
main's synthetic events; hook rules cover the hermes shim (exit-0, no bun:sqlite,
private logging); worker contract count/notes if named. Keep
bun scripts/lint-claude-md.ts green — consolidate, don't append. pair SKILL.md:
harness enumerations include hermes, add its consent/trust note beside the
codex-trust and pi -na notes. panel.md: eligibility is capability-derived
wording. README: the ingest narrative and producer map acknowledge multi-harness
sources. Docstring prunes where code is now harness-agnostic but prose says
Claude (renamer-worker, resume-descriptor, restore-set headers).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- CLAUDE.md sole-writer + hook-rules bullets (as landed after the preceding tasks)
- scripts/lint-claude-md.ts — the size/re-narration gate
- plugins/keeper/skills/pair/SKILL.md — every claude|codex|pi enumeration

**Optional** (reference as needed):
- README.md system map block
- plugins/plan/skills/panel/references/panel.md eligibility lines

### Risks

- CLAUDE.md lint gate is strict on size — additions must be paid for with consolidation

### Test notes

bun scripts/lint-claude-md.ts green; grep shows no remaining claim that the
events-writer hook is the only NDJSON writer or that pair/panel are three-harness.

## Acceptance

- [ ] CLAUDE.md accurately states the multi-writer events-log, the births-tree sole writer, and the shim's hook discipline, and its lint gate passes
- [ ] pair and panel docs enumerate the four harnesses with correct capability and consent notes
- [ ] No shipped docstring claims claude-only behavior for code that is now harness-agnostic

## Done summary

## Evidence

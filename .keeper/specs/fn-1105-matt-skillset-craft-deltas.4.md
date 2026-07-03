## Description

**Size:** M
**Files:** plugins/plan/skills/plan/SKILL.md, plugins/plan/skills/plan/references/operator-orchestration.md, plugins/plan/skills/defer/SKILL.md, docs/skill-authoring.md

### Approach

Three moves on the plan-family prose, applying the repo's own authoring method to its largest violator. (1) Progressive-disclosure split: plan/SKILL.md's operator-facing detail — the cross-skill orchestration topologies and worktree/multi-repo execution notes living inside Phase 6, plus the blocked-worker help flow — moves to a disclosed reference file beside the skill, reached by a sharply-worded context pointer at each branch site; the authoring happy path stops paying for operator-branch prose. (2) Dedup the one-task/ticket-vs-fog guidance: plan Phase 3c keeps the operational statement (it fires on every create run — inline what every run needs), docs/skill-authoring.md keeps the method definition, defer keeps its existing pointer; collapse the intra-plan repetition between Phase 3c and Phase 5d to one statement plus a pointer. (3) skill-authoring.md gains two levers as new sections: the two-load frame (a model-invoked description pays permanent context load every turn; a slash-only skill pays human cognitive load — the human is the index — spent deliberately where judgment matters) and Leitwort-as-compression (reuse a pretrained concept as a repeated token to retire duplicated sentences — distinct from the existing front-load-the-verb rule, which keeps its section). (4) Plan Phase 2d gains the recommended-answer discipline: every priority question presented to the human carries the agent's own recommended answer; no question cap; no AFK auto-proceed.

### Investigation targets

*Verify before relying.*

**Required**:
- plugins/plan/skills/plan/SKILL.md:583-618 (orchestration + blocked-worker regions), :219-231 (Phase 2d), :282-298 (Phase 3c) and Phase 5d — the split/dedup/Q&A sites
- docs/skill-authoring.md — existing sections (Leading words :17-24, ticket-vs-fog :71-79) the new levers sit beside
- plugins/plan/skills/defer/SKILL.md:87-105 — the existing cross-pointer to plan Phase 3c
- plugins/plan/skills/hack/SKILL.md — how its skill-relative references and pointers are worded (pointer-wording precedent)

### Risks

- A weakly-worded pointer on must-have material is a variance bug: the disclosed file must be reached reliably on the operator branches. Word pointers by trigger condition, not by topic.
- The landed-vs-complete region at plan:589 is being re-pointed by the sibling snippet task; this task moves the surrounding block — the snippet task runs after and targets wherever the block lands.

### Test notes

No generated artifacts touched. Sanity: the skill still parses (frontmatter intact), pointer targets exist, and `rg` finds exactly one authoritative one-task statement inside plan/SKILL.md.

## Acceptance

- [ ] plan/SKILL.md no longer inlines the multi-epic orchestration topologies or the blocked-worker flow; both live in a disclosed reference file reached by condition-worded pointers, and the skill is materially smaller
- [ ] The one-task/ticket-vs-fog guidance appears once inside plan/SKILL.md with skill-authoring.md holding the method definition and defer pointing, not restating
- [ ] skill-authoring.md teaches the two-load frame and Leitwort-as-compression as sections distinct from front-load-the-verb
- [ ] Phase 2d requires a recommended answer with every priority question and states no-cap / no-auto-proceed
- [ ] No orphaned references: every pointer target exists; no content was deleted without a surviving authoritative home

## Done summary
Split plan/SKILL.md operator detail (multi-epic orchestration + blocked-worker flow) into references/operator-orchestration.md behind condition-worded pointers; deduped the one-task/decomposition-bias repetition to one authoritative statement; added the two-load frame and Leitwort-as-compression levers to skill-authoring.md; and gave Phase 2d the recommended-answer-per-question, no-cap, no-auto-proceed discipline.
## Evidence

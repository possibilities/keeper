## Description

**Size:** S
**Files:** plugins/keeper/skills/pair/SKILL.md

### Approach

Fold resume into the pair skill as a first-class shape rather than a
bolted-on section: the intro currently frames pairing as launching a
fresh detached partner — rework it so fresh-launch and resume are the two
entry states. Document both shapes with runnable examples (`keeper agent
resume <name> "ask"` interactive; `keeper agent run <cli> "ask" --resume
<name>` captured), the name-or-id resolution semantics (current or former
name, newest-non-live wins and is echoed, live targets refuse toward the
bus), and name-your-partners guidance: pass `--name` on every launch so
partners are resumable by name later. Update the frontmatter description
and argument-hint so the skill advertises resume. Forward-facing prose
only — no fn-ids, no history narration; a name is a lookup, never a
resume key (match CONTEXT.md vocabulary). Prune as readily as adding —
the skill has a lint-gated size discipline culture; keep the doc tight.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/keeper/skills/pair/SKILL.md:1-51 — frontmatter + the fresh-launch framing to rework; :208-221 the partner-choice table the resume flags join; :202 the envelope resume_target prose to align with post-resume semantics
- docs/adr/0034 — the decision record the prose must stay consistent with (refuse-live, newest-wins echo, chaining)

**Optional** (reference as needed):
- CONTEXT.md — Resume target / Session title / Refuse-live entries for vocabulary

### Risks

- Overgrowth: the skill is already 250+ lines; fold-and-prune, never append-only

### Test notes

Prose-only change; verify examples against the landed CLI by running each
documented command once and recording the output in Evidence.

## Acceptance

- [ ] The skill documents both resume shapes with examples that execute as written against the landed CLI
- [ ] Frontmatter description and argument-hint advertise resume so the skill routes on resume-shaped asks
- [ ] The doc recommends naming partners at launch and explains name resolution (former names, newest-wins echo, live refusal) in CONTEXT.md-consistent vocabulary
- [ ] No history narration or plan-id references appear in the doc

## Done summary

## Evidence

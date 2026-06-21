## Description

**Size:** S
**Files:** plugins/plan/skills/hack/SKILL.md, plugins/plan/skills/defer/SKILL.md, plugins/plan/CLAUDE.md, README.md, CLAUDE.md (all edits)

### Approach

Surgical, forward-facing prose edits (present tense, NO "formerly / used to"
narration) so existing docs stay true now that human-invoked operator skills
exist. Two kinds:

**(1) Carve-out.** Tighten the absolutist "never offer `/plan:work`" lines so
they prohibit UNSOLICITED autopilot-drive offers by the planning skills, while
the human-invoked operator hatch (`keeper:dispatch` / `keeper:autopilot`) is
legitimate and reached ONLY by explicit human invocation — the planning skills
NEVER advertise the operator door. Targets: hack/SKILL.md:181,
defer/SKILL.md:178, defer/SKILL.md:186, defer/SKILL.md:14, plugins/plan/CLAUDE.md
(~:34). CRITICAL: do NOT add the operator hatch to hack's "Orchestration is
yours to shape" closed list (~:200-204) — it stays exceptional, not standing
discretion. Only adjust that wording if it now reads as falsely exhaustive, and
never in a way that grants the planning agent execution discretion.

**(2) Enumeration.** README.md (~:383 plugin surface) and CLAUDE.md (~:16) list
all THREE keeper skills (await + dispatch + autopilot). CLAUDE.md is the
symlinked AGENTS.md — EDIT IN PLACE, never rm+recreate. Add a one-sentence
cross-ref from README's dispatch (~:956) and autopilot (~:872) CLI subsections
to the corresponding gateway skill.

### Investigation targets

**Required** (read before editing):
- plugins/plan/skills/hack/SKILL.md:181 — the "never offer /plan:work" line; :200 the closed list (must NOT widen into execution discretion)
- plugins/plan/skills/defer/SKILL.md:14 / :178 / :186 — the three absolutist restatements
- plugins/plan/CLAUDE.md — the "so the skill never offers /plan:work" line
- README.md:383 — plugin-surface enumeration; :872 autopilot CLI subsection; :956 dispatch CLI subsection
- CLAUDE.md:16 — plugin-surface enumeration (symlinked AGENTS.md — edit in place)

**Optional**:
- the new keeper:dispatch / keeper:autopilot SKILL.md (from .1 / .2) to keep skill names and cross-refs consistent

### Risks

- Widening hack's closed-list into "drive execution" would silently grant the planning agent standing license to manually drive — the exact over-reach the design guards against. Keep execution guidance in the keeper:* skills; the planning skills only point at the hatch on explicit human request.
- Forward-facing only: no "previously we never offered work" narration.
- CLAUDE.md / AGENTS.md is a symlink — edit in place; never rm+recreate.

### Test notes

No automated gate. Re-read each edited line in context to confirm the absolutism
is TIGHTENED (not removed) and the closed list is NOT widened. Confirm the
enumeration lists all three skills and the symlink is intact (`ls -l AGENTS.md`).

## Acceptance

- [ ] hack:181, defer:14/178/186, plugins/plan/CLAUDE.md: "never offer /plan:work" tightened to prohibit UNSOLICITED drive offers; planning skills never advertise the operator door
- [ ] hack:200-204 closed list NOT widened into execution discretion
- [ ] README (~383) + CLAUDE.md (~16) enumerate all three keeper skills; README dispatch/autopilot CLI subsections cross-ref the new gateway skills
- [ ] CLAUDE.md edited in place (AGENTS.md symlink intact); forward-facing prose only
- [ ] no plugin manifest or hooks.json edits

## Done summary
Carve-out + enumeration doc edits: tightened planning-skill 'never offer /plan:work' lines to prohibit unsolicited drive offers without advertising the human-gated operator hatch; enumerated all three keeper skills (await/dispatch/autopilot) in README + CLAUDE.md; cross-referenced the gateway skills from the dispatch/autopilot CLI subsections. Hack's closed list left untouched; AGENTS.md symlink intact.
## Evidence

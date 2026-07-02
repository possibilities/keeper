## Description

**Size:** M
**Files:** plugins/plan/agents/quality-auditor.md, plugins/plan/skills/close/SKILL.md, plugins/plan/skills/{hack,plan}/SKILL.md, plugins/keeper/skills/autopilot/SKILL.md, docs (authoring guide)

### Approach

Four bounded additions. (1) Two-axis auditor: quality-auditor reviews Spec compliance and
Standards (repo conventions + a ~12-item smell baseline: mysterious name, feature envy,
primitive obsession, shotgun surgery, speculative generality, et al) as two sections reported
side by side, never merged or re-ranked — one axis must not mask the other; smells are
judgement-calls never hard violations, repo standards override, skip anything lint enforces;
add the tautological-test check (expected values from an independent source of truth) to its
test lens; update close's parse if the return format changes. (2) Scope-confirm reflex: in
hack's work-shaped path and plan's Phase 2d, one line — on an ambiguous or evolving design
ask, state the assumption on the unstated axis in one sentence before proceeding (the ~340
design-pivot corrections are the evidence; this is a single reflex line, not a new
permission gate). (3) Push-right escalation briefs: when autopilot pages the human (sticky
non-ff, merge-conflict escalation), the notification content is a decision-ready brief —
what happened, what was already tried/prepared, the decision needed — not a raw failure dump;
land the wording in the autopilot skill's escalation section and the daemon notify text if it
is string-owned in-repo. (4) The authoring guide: a compact keeper skill-authoring reference
(docs/ or plugins/keeper/) codifying the method — predictability, leading words, progressive
disclosure licensed by branching, one-trigger-per-branch, no-op pruning, checkable+exhaustive
completion criteria, density-earned-for-unattended — plus the ticket-vs-fog test ("can you
state the question precisely now?") added to plan's decomposition guidance so speculative work
stays fog, not fake tasks.

### Investigation targets

**Required** (read before coding):
- plugins/plan/agents/quality-auditor.md + plugins/plan/skills/close/SKILL.md Phase 2 — current contract
- The daemon merge-escalation notify site (src/daemon.ts merge_escalated_at sweep) — whether the message text is in-repo
- plugins/plan/skills/plan/SKILL.md Phase 3c — where the fog test lands

### Risks

- The scope-confirm reflex must not re-litigate settled directives — it fires on genuinely unstated axes only.

### Test notes

Plan suite green; desk-check the auditor's two-axis output against a past close's audit.

## Acceptance

- [ ] Auditor reports two axes side by side with the smell baseline + tautological-test check; close parses it
- [ ] Scope-confirm line in hack + plan; fog test in decomposition guidance
- [ ] Escalation notifications decision-ready; authoring guide landed

## Done summary

## Evidence

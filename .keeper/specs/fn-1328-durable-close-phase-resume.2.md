## Description

**Size:** S
**Files:** plugins/plan/skills/close/SKILL.md, plugins/plan/test/consistency-skills.test.ts, CONTEXT.md

### Approach

The closer skill switches on the preflight `phase_resume` field exactly as it
switches on `blocking_followup` today: satisfied/not_needed phases are skipped
without spawning their agents, execution resumes at the first `unfinished` phase,
and the carried branch facts drive the `findings=0` and `fatal` branches
identically to a fresh run. `blocking_followup` non-null takes precedence (its
existing straight-to-Phase-4 short-circuit already skips everything). Phase 3.6
re-runs on resume — it is an idempotent verb spawning no agent. The closer stays
content-blind: the selection-verdict path for finalize comes from the envelope,
never from opening `state/audits`. The fixed one-line report formats and the
total Phase-4 outcome switch are unchanged. The skill-conformance test pins the
new switch the same way it pins `blocking_followup`. CONTEXT.md gains one
clustered glossary entry for the durable close-phase artifact / resume-gate
vocabulary, disambiguated from Restore, Harness resume, and Resume cursor, and
avoiding the already-bound term "receipt".

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/skills/close/SKILL.md:42 — the blocking-gate re-entry short-circuit whose shape the resume switch extends; Phase 4 outcome switch and report formats further down
- plugins/plan/test/consistency-skills.test.ts — the skill-conformance grep pinning `blocking_followup`; add the resume-field pin beside it
- CONTEXT.md:25,91,116-121 — existing "receipt" and Restore / Harness resume / Resume cursor bindings the new vocabulary must not collide with

**Optional** (reference as needed):
- plugins/plan/CLAUDE.md — the content-blind read guard denying the closer access to state/audits (the constraint the envelope satisfies)

### Risks

- Divergent double-skip logic when blocking_followup and phase_resume are both non-null — precedence must be explicit
- A resumed path drifting from the fresh-run branch behavior on findings=0 / fatal

### Test notes

Skill-conformance additions only (the deterministic behavior is task 1's verb
tests): assert SKILL.md references the resume field, its precedence rule, and the
no-artifact-read constraint. Verify the CONTEXT.md entry renders as pure glossary
(1-2 sentences, Avoid-synonym line, zero implementation detail).

## Acceptance

- [ ] The closer skill documents the phase-resume switch: skip satisfied/not_needed phases, resume at the first unfinished phase, branch facts drive findings=0/fatal identically to a fresh run, blocking_followup precedence stated
- [ ] The skill-conformance test pins the resume-field switch and fails if SKILL.md drops it
- [ ] CONTEXT.md defines the durable close-phase vocabulary without colliding with existing receipt/resume/restore terms
- [ ] The plan test gate passes

## Done summary

## Evidence

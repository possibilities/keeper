## Description

**Size:** S
**Files:** plugins/plan/skills/plan/SKILL.md, plugins/keeper/skills/autopilot/SKILL.md

### Approach

Two doc edits, forward-facing. (1) Plan skill (Phase 5e spec-writing guidance, near the
durable-behavioral-specs block): a task acceptance line must be verifiable from the lane
the worker runs in; anything requiring the LIVE daemon to run the epic's own not-yet-
finalized code (live-host stability, production measurements confounded by the fix being
undeployed) belongs to the operator/await layer after finalize — spec such work as
harness/code-level acceptance plus an explicit operator post-deploy step, or sequence it
as a follow-up epic. (2) Autopilot skill (operator runbook): document the sanctioned
mid-epic deploy procedure — pause first, `git merge --no-edit keeper/epic/<id>` (the base
lane; task lanes only fan in at finalize, so a task lane needs its own merge), true merge
never squash, run the affected-suite gate, push; note finalize later re-merges cleanly
since the lane becomes an ancestor.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/skills/plan/SKILL.md — Phase 5e durable-behavioral-specs paragraph (the insertion point)
- plugins/keeper/skills/autopilot/SKILL.md — the escalation/runbook sections (the deploy procedure's home)

### Risks

- Keep both edits terse and in each file's existing voice; the plan skill is long and the
  lint gates on CLAUDE.md do not apply here, but prose bloat does.

## Acceptance

- [ ] The plan skill names the deploy trap and states where live-verification belongs
- [ ] The autopilot skill carries the operator mid-epic deploy procedure including the pause-first and never-squash rules
- [ ] Both edits are forward-facing (no incident narration)

## Done summary

## Evidence

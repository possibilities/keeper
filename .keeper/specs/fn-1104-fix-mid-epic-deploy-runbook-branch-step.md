## Overview

The operator "Mid-epic deploy (manual lane-merge to main)" runbook in the autopilot
skill merges the epic lane into whatever branch HEAD currently points at and never
tells the operator to switch to main first. Followed literally from any other branch,
it merges the lane into the wrong branch and pushes it, silently failing the to-main
deploy the runbook promises — and leaving the operator's live verification running
against undeployed code, the exact trap this guidance exists to close. This follow-up
hardens the runbook so it is safe to follow literally.

## Acceptance

- [ ] The mid-epic deploy runbook makes the operator land on the main branch before the lane merge.
- [ ] Following the runbook literally from any starting branch deploys the lane to main and pushes main.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | Runbook step 2 (git merge --no-edit keeper/epic/<id>) merges into current HEAD with no switch-to-main step; an operator off main deploys the lane to the wrong branch and step 4 pushes it, silently failing the promised to-main deploy. |

## Out of scope

- The plan-skill acceptance-guidance paragraph — audited clean, no action.
- Any change to close-finalize / worktree merge behavior; this is a docs-only runbook fix.

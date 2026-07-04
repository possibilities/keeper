## Description

Fixes finding F1 (evidence: the runbook added in commit 6cfaf2c3 to
plugins/keeper/skills/autopilot/SKILL.md, section "Mid-epic deploy (manual
lane-merge to main)"). Step 2 issues `git merge --no-edit keeper/epic/<id>`,
which merges into the current HEAD, with no prior instruction to switch to the
main branch; the runbook's title and step 4 (`git push` main) assume main but
never enforce it. Add an explicit "switch to the main branch" step before the
merge (a new step or folded into step 2) so an operator following the runbook
literally from any branch merges the lane into main and pushes main — never the
wrong branch. Preserve the existing invariants the runbook already states
(pause-first, true-merge never squash, gate before push).

## Acceptance

- [ ] The runbook instructs the operator to be on the main branch before the lane merge.
- [ ] Following the runbook literally from a non-main starting branch results in the lane merged to main and main pushed.
- [ ] The pause-first, never-squash, and gate-before-push steps remain intact.

## Done summary
Added an explicit 'git checkout main' step before the lane merge in the mid-epic deploy runbook and renumbered the following steps, so following it literally from any branch deploys the lane to main; pause-first, never-squash, and gate-before-push preserved.
## Evidence

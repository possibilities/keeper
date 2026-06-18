## Description
**Size:** S
**Files:** ~/code/agentrender/.planctl → .keeper, in-repo path refs
### Approach
`git mv .planctl .keeper` in ~/code/agentrender; update `.keeper/CLAUDE.md` + any `.planctl/` path refs to `.keeper/`. Requires the keeper daemon already watching `.keeper/` (epic 4 + restart).
### Investigation targets
**Required**:
- ~/code/agentrender/.planctl — the tree
### Risks
- Daemon must read `.keeper/` first, else this repo's board goes dark.
### Test notes
`keeper board` shows agentrender epics from `.keeper/`.
## Acceptance
- [ ] agentrender `.planctl` → `.keeper` (git mv, committed); refs updated; board visible
## Done summary
## Evidence

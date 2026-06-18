## Description
**Size:** S
**Files:** ~/code/agentuse/.planctl → .keeper, in-repo path refs
### Approach
`git mv .planctl .keeper` in ~/code/agentuse; update `.keeper/CLAUDE.md` + `.planctl/` refs. Requires daemon watching `.keeper/`.
### Investigation targets
**Required**:
- ~/code/agentuse/.planctl
### Risks
- Daemon must read `.keeper/` first.
### Test notes
`keeper board` shows agentuse epics from `.keeper/`.
## Acceptance
- [ ] agentuse `.planctl` → `.keeper` (git mv, committed); refs updated; board visible
## Done summary
## Evidence

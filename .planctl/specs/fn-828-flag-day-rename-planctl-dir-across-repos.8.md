## Description
**Size:** S
**Files:** ~/code/zellijsub/.planctl → .keeper, in-repo path refs
### Approach
`git mv .planctl .keeper` in ~/code/zellijsub; update `.keeper/CLAUDE.md` + `.planctl/` refs. Requires daemon watching `.keeper/`.
### Investigation targets
**Required**:
- ~/code/zellijsub/.planctl
### Risks
- Daemon must read `.keeper/` first.
### Test notes
`keeper board` shows zellijsub epics from `.keeper/`.
## Acceptance
- [ ] zellijsub `.planctl` → `.keeper` (git mv, committed); refs updated; board visible
## Done summary
## Evidence

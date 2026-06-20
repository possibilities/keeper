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
Renamed zellijsub .planctl/ to .keeper/ via git mv and updated the live CLAUDE.md path ref; keeper board renders the repo's epics from .keeper/.
## Evidence

## Description
**Size:** S
**Files:** ~/code/vtkeep/.planctl → .keeper, in-repo path refs
### Approach
`git mv .planctl .keeper` in ~/code/vtkeep; update `.keeper/CLAUDE.md` + `.planctl/` refs. Requires daemon watching `.keeper/`.
### Investigation targets
**Required**:
- ~/code/vtkeep/.planctl
### Risks
- Daemon must read `.keeper/` first.
### Test notes
`keeper board` shows vtkeep epics from `.keeper/`.
## Acceptance
- [ ] vtkeep `.planctl` → `.keeper` (git mv, committed); refs updated; board visible
## Done summary
git mv .planctl .keeper in vtkeep; updated .keeper/CLAUDE.md path ref to .keeper/. Board renders vtkeep plan from .keeper/.
## Evidence

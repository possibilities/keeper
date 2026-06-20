## Description
**Size:** S
**Files:** ~/code/arthack/.planctl → .keeper, in-repo path refs
### Approach
`git mv .planctl .keeper` in ~/code/arthack; update `.keeper/CLAUDE.md` + `.planctl/` refs. Requires daemon watching `.keeper/`.
### Investigation targets
**Required**:
- ~/code/arthack/.planctl
### Risks
- Daemon must read `.keeper/` first.
### Test notes
`keeper board` shows arthack epics from `.keeper/`.
## Acceptance
- [ ] arthack `.planctl` → `.keeper` (git mv, committed); refs updated; board visible
## Done summary
git mv .planctl -> .keeper in arthack; updated path refs in root CLAUDE.md and .keeper/CLAUDE.md. Plan reads from .keeper/ (verified via keeper plan list).
## Evidence

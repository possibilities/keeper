## Description
**Size:** S
**Files:** ~/code/prosectl/.planctl → .keeper, in-repo path refs
### Approach
`git mv .planctl .keeper` in ~/code/prosectl; update `.keeper/CLAUDE.md` + `.planctl/` refs. Requires daemon watching `.keeper/`.
### Investigation targets
**Required**:
- ~/code/prosectl/.planctl
### Risks
- Daemon must read `.keeper/` first.
### Test notes
`keeper board` shows prosectl epics from `.keeper/`.
## Acceptance
- [ ] prosectl `.planctl` → `.keeper` (git mv, committed); refs updated; board visible
## Done summary
Renamed prosectl .planctl -> .keeper via git mv (22 files); updated .keeper/CLAUDE.md heading and path refs from .planctl to .keeper. No other in-repo refs.
## Evidence

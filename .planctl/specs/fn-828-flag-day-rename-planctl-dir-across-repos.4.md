## Description
**Size:** S
**Files:** ~/code/dotfiles/.planctl → .keeper, in-repo path refs
### Approach
`git mv .planctl .keeper` in ~/code/dotfiles; update `.keeper/CLAUDE.md` + `.planctl/` refs. Requires daemon watching `.keeper/`.
### Investigation targets
**Required**:
- ~/code/dotfiles/.planctl
### Risks
- Daemon must read `.keeper/` first.
### Test notes
`keeper board` shows dotfiles epics from `.keeper/`.
## Acceptance
- [ ] dotfiles `.planctl` → `.keeper` (git mv, committed); refs updated; board visible
## Done summary
## Evidence

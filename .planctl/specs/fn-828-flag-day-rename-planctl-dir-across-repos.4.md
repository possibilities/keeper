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
Renamed dotfiles .planctl/ to .keeper/ via git mv (20 files, pure rename) and updated the .keeper/CLAUDE.md directory path ref. keeper board renders dotfiles epics from .keeper/. Source commit 488b264 in dotfiles.
## Evidence

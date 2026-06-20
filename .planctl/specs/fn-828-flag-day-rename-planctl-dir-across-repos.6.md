## Description
**Size:** S
**Files:** ~/code/tmux0r/.planctl → .keeper, in-repo path refs
### Approach
`git mv .planctl .keeper` in ~/code/tmux0r; update `.keeper/CLAUDE.md` + `.planctl/` refs. Requires daemon watching `.keeper/`.
### Investigation targets
**Required**:
- ~/code/tmux0r/.planctl
### Risks
- Daemon must read `.keeper/` first.
### Test notes
`keeper board` shows tmux0r epics from `.keeper/`.
## Acceptance
- [ ] tmux0r `.planctl` → `.keeper` (git mv, committed); refs updated; board visible
## Done summary
Renamed tmux0r .planctl -> .keeper via git mv and updated in-repo path refs in .keeper/CLAUDE.md. keeper board still renders tmux0r's plan from .keeper/.
## Evidence

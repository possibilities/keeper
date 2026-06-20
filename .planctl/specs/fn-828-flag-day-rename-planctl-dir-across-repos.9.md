## Description
**Size:** S
**Files:** ~/code/agentwrap/.planctl → .keeper, in-repo path refs
### Approach
`git mv .planctl .keeper` in ~/code/agentwrap; update `.keeper/CLAUDE.md` + any `.planctl/` path refs to `.keeper/`. Requires the keeper daemon already watching `.keeper/` (epic 4 + restart). agentwrap is the renamed `claudewrap` project; its `.planctl` tree carried over the rename and was not in the original flag-day enumeration.
### Investigation targets
**Required**:
- ~/code/agentwrap/.planctl — the tree
### Risks
- Daemon must read `.keeper/` first, else this repo's board goes dark.
### Test notes
`keeper board` shows agentwrap epics from `.keeper/`.
## Acceptance
- [ ] agentwrap `.planctl` → `.keeper` (git mv, committed); refs updated; board visible
## Done summary
git mv .planctl .keeper in agentwrap; updated the one .planctl path ref in .keeper/CLAUDE.md. keeper board renders agentwrap epics from .keeper/.
## Evidence

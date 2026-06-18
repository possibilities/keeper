## Description

**Size:** S — SUPERVISED
**Files:** ~/code/planctl → ~/archive/planctl

### Approach

With every consumer migrated and the cord cut, `mv ~/code/planctl ~/archive/`. Final verification: `grep -rn planctl` across the live tree (`~/code/keeper`, `~/code/arthack`, other migrated repos) returns nothing but frozen test fixtures; a fresh claudewrap session loads, `keeper board` renders from `.keeper/`, `keeper plan <verb>` works, and there is no `planctl` command on PATH. The GitHub `possibilities/planctl` remote can be archived on GitHub afterward (optional).

### Investigation targets
**Required**:
- the round-1 disconnect inventory (buildbot, codex symlink, plugins.yaml) — confirm all severed before the move

### Risks
- Don't move until tasks .1–.4 done — a lingering live ref would break on the move.

### Test notes
Fresh session smoke; `grep -rn planctl ~/code --glob '!**/.git/**' --glob '!**/archive/**'` clean of live refs.

## Acceptance
- [ ] `~/code/planctl` moved to `~/archive/`; fresh session: board from `.keeper/`, `keeper plan` works, no `planctl` command
- [ ] `grep -rn planctl` across the live tree returns nothing actionable; the name is gone
## Done summary
## Evidence

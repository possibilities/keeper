## Description

**Size:** S — SUPERVISED
**Files:** ~/code/keeper/.planctl → .keeper

### Approach

With the daemon already watching `.keeper/` (epic 4 + restart), `git mv .planctl .keeper` in keeper. This moves the ACTIVE board (including this plan's own task JSON). The plan CLI (`.keeper/` primary) resolves the board post-move; verify `keeper plan show <this-epic>` and `keeper board` still work. SUPERVISED — run by hand, watch the board survive.

### Investigation targets
**Required**:
- confirm the daemon's plan-worker is watching `.keeper/` (epic 4 applied + restarted) BEFORE running

### Risks
- If the daemon still watches only `.planctl/`, the board tombstones on rename — bounce the daemon first.
- The worker doing this is mid-task in the dir being moved; the `.keeper/` primary resolution must be live.

### Test notes
Post-`git mv`: `keeper board` + `keeper plan show` resolve from `.keeper/`; autopilot (if armed) still sees ready work.

## Acceptance
- [ ] keeper `.planctl` → `.keeper` (git mv, committed); active board resolves from `.keeper/`; no dark window
## Done summary
git mv .planctl -> .keeper migrated keeper's active board (1724 files); CLI .keeper/ primary + plan-worker recursive watch resolve it with no dark window. keeper board + plan show verified.
## Evidence

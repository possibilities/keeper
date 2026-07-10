## Description

**Size:** S
**Files:** system/codex/.codex/AGENTS.md (in ~/code/arthack — DELETE)

### Approach

Delete `system/codex/.codex/AGENTS.md` from the arthack repo — the competing codex global-instruction source that `~/.codex/AGENTS.md` currently symlinks into. This depends on the core guard task (`.1`): once that guard has landed AND the keeper binary is rebuilt/reinstalled, the next `keeper agent codex` launch sees `~/.codex/AGENTS.md` as a wrong-target symlink and repairs it to keeper's `system/shared/AGENTS.md`, so deletion is self-healing with no manual re-link. Confirm no `~/.codex/AGENTS.override.md` exists (codex prefers the override over `AGENTS.md` and it would silently shadow the keeper leaf — none exists today; verify). Optionally remove the stale `~/.codex/AGENTS.md.pre-stow-20260320` leftover backup while here. Do NOT touch arthack's claude-package AGENTS.md source — that belongs to the separate `~/.claude/AGENTS.md`-deletion epic.

### Investigation targets

**Required** (read before coding):
- ~/code/arthack/system/codex/.codex/AGENTS.md — the file to delete
- ~/code/arthack/system/codex/.stow-local-ignore — confirm it anchors only `/AGENTS.md` at the package root (why the nested `.codex/AGENTS.md` got stowed originally)

### Risks

- Sequencing/deploy timing: if this landed before the keeper guard is DEPLOYED (binary rebuilt), `~/.codex/AGENTS.md` would dangle until a new-guard launch. The dep on `.1` plus epic finalize/deploy ordering closes the window — the self-heal is a post-deploy operator step, not a mid-lane check.

### Test notes

In-lane: the file is removed (git shows the deletion); `~/.codex/AGENTS.override.md` verified absent. The post-deploy re-link is an operator smoke (epic Quick commands), not task acceptance — a lane worker can't observe the deployed daemon.

## Acceptance

- [ ] `system/codex/.codex/AGENTS.md` is removed from the arthack repo (git shows the deletion).
- [ ] Verified no `~/.codex/AGENTS.override.md` exists that would shadow the keeper leaf.
- [ ] The stale `~/.codex/AGENTS.md.pre-stow-20260320` backup is removed (optional cleanup, if present).

## Done summary
Deleted arthack's competing system/codex/.codex/AGENTS.md source; confirmed no ~/.codex/AGENTS.override.md exists; removed the stale ~/.codex/AGENTS.md.pre-stow-20260320 backup. Self-heals via the fn-1234.1 launch guard once deployed.
## Evidence

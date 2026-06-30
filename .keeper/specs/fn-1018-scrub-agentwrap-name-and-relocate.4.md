## Description

**Size:** S
**Files:** (arthack repo, ~/code/arthack) system/arthack/.config/agentwrap/{claude,plugins}.yaml → system/arthack/.config/keeper/, scripts/install.sh, claude/CLAUDE.md

### Approach

Complete the relocation on the arthack stow side, AFTER the keeper fallback (.3) is live. Move `system/arthack/.config/agentwrap/{claude.yaml,plugins.yaml}` → `system/arthack/.config/keeper/` (create the keeper subdir; only claude+plugins exist, no codex/pi). Run `stow --restow -t ~ -d system arthack` so the `~/.config/agentwrap/{claude,plugins}.yaml` symlinks are removed and `~/.config/keeper/{claude,plugins}.yaml` are created. Update any install.sh wiring that special-cases the agentwrap subdir. Forward-facing scrub of agentwrap prose in claude/CLAUDE.md (lines 1,5,16 — incl. the `~/code/agentwrap` launcher references → `keeper agent`) and install.sh comments (344,435,594-595). Do NOT touch the `AGENTWRAP_CLAUDE_PROFILE` env var in apps/claudectl/.../run_show_statusline.py (independent, out of scope). Do NOT scrub `.keeper/specs` historical records.

### Investigation targets

**Required** (read before coding):
- ~/code/arthack/scripts/install.sh:28-34,76 (`stow_system`) — the restow mechanism + any agentwrap special-casing
- ~/code/arthack/system/arthack/.config/agentwrap/ — the 2 files to move
- ~/code/arthack/claude/CLAUDE.md:1,5,16 — prose to scrub

**Optional** (reference as needed):
- ~/code/arthack/apps/claudectl/claudectl/run_show_statusline.py:108 — confirm the env var is independent (do not touch)

### Risks

- Ordering: must land AFTER .3 (the keeper fallback). If the files move before keeper can read `~/.config/keeper/`, the launcher reads the now-empty agentwrap path → fail-open drops defaults / fail-loud plugins.yaml throws → launchers brick. The dep edge enforces this.
- After restow, verify both symlinks resolve and the old `~/.config/agentwrap/` per-harness symlinks are gone.
- arthack has its own conventions/commit flow; commit there per arthack's norms.

### Test notes

After restow: `ls -la ~/.config/keeper/{claude,plugins}.yaml` shows live symlinks into the stow package; `keeper agent presets list` boots reading the new path; `git grep -i agentwrap` in arthack shows only the independent statusline env var + immutable `.keeper` history.

## Acceptance

- [ ] {claude,plugins}.yaml moved to system/arthack/.config/keeper/; `stow --restow` repoints symlinks to `~/.config/keeper/`
- [ ] Old `~/.config/agentwrap/` per-harness symlinks removed; new ones live and resolving
- [ ] arthack prose (CLAUDE.md, install.sh) scrubbed forward-facing; statusline env var untouched
- [ ] Launcher boots reading `~/.config/keeper/` (fallback now dormant)

## Done summary

## Evidence

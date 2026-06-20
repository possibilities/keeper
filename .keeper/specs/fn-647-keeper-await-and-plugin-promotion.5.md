## Description

**Size:** S
**Files:** ~/code/arthack/system/arthack/.local/bin/arthack-claude.py
(SEPARATE REPO — ~/code/arthack, not keeper).

### Approach

Teach the arthack launcher to load the keeper root plugin for every
profile by appending `--plugin-dir <abs path to ~/code/keeper>` to the
`claude` invocation, unconditionally across profiles (not gated per-agent,
unlike the existing agent-plugins).

Fail-loud preflight: before launching, check that
`~/code/keeper/.claude-plugin/plugin.json` exists; if it's ABSENT, print a
clear error to stderr and exit non-zero rather than launching claude (the
keeper plugin is a hard dependency of the launcher — a missing checkout is
a misconfiguration worth surfacing, not silently skipping). Mirror the
existing `_resolve_agent_plugin` `is_file` existence check, but invert the
outcome: agent-plugins skip-if-absent; the keeper plugin errors-if-absent.

Expand `~` correctly in the Python invocation and point at the repo ROOT
(where the new root `.claude-plugin/plugin.json` lives from task .3), not
the inner `plugin/` dir. `--plugin-dir` is repeatable, so this composes
with any per-agent `--plugin-dir` the launcher already appends.

### Investigation targets

**Required** (read before coding):
- ~/code/arthack/system/arthack/.local/bin/arthack-claude.py — the `claude` argv assembly site; `_resolve_agent_plugin` / `_agent_plugin_dir` (the `claude/agent-plugins/<name>/.claude-plugin/plugin.json` `is_file` gate to mirror); `--plugin-dir` in `_CLAUDE_OPTIONS_WITH_REQUIRED_VALUE` (~:1111).

**Optional** (reference as needed):
- The launcher's profile-iteration / cmd-extend code path so the append lands for all profiles.

### Risks

- **Blast radius**: this append runs for ALL profiles; the fail-loud
  preflight is what keeps a missing `~/code/keeper` from producing an opaque
  claude error — it must fire BEFORE the claude exec, with a clear message.
- Hardcoded `~/code/keeper` path: expand `~` correctly; point at repo root.
- Depends on task .3 — the root plugin manifest must exist for the load to
  succeed (and for the preflight to pass on this machine).

### Test notes

Manual: launch via arthack-claude.py with the keeper plugin present →
`/keeper:keeper-await` available and the hook fires once. Temporarily
rename the keeper plugin manifest → launcher errors loudly and does NOT
exec claude. Restore.

## Acceptance

- [ ] arthack-claude.py appends `--plugin-dir <~/code/keeper abs path>` to the claude invocation for all profiles (repeatable, composes with agent-plugins).
- [ ] If `~/code/keeper/.claude-plugin/plugin.json` is absent, the launcher prints a clear error and exits non-zero before exec'ing claude (fail-loud, not skip).
- [ ] `~` is expanded correctly and the path is the repo root (root manifest), not the inner `plugin/` dir.
- [ ] With the plugin present, a launched session exposes `/keeper:keeper-await` and the hook fires exactly once.

## Done summary
arthack-claude.py loads ~/code/keeper as a root --plugin-dir for every profile with a fail-loud preflight against the root manifest; added autouse fixture so HOME-sandboxed tests seed a stub keeper plugin and the preflight passes.
## Evidence

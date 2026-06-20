## Description

**Size:** S
**Files:** zellij/.config/zellij/config.kdl

### Approach

Set `session_serialization false` in the user's zellij config so the zellij
server never writes the resurrection cache (`session-layout.kdl`) for any
session — structurally eliminating the stale-layout source that the keeper
`--forget` change defends against at mint time. Add the single line
`session_serialization false` to
`zellij/.config/zellij/config.kdl` (the file is stowed to
`~/.config/zellij/config.kdl`). Place it near the existing top-level
settings (e.g. beside `pane_frames false`) with a one-line comment noting
it disables session resurrection (the cause of the bar-less autopilot
sessions). Note the setting "requires restart" — it applies to sessions
created after the zellij server restarts; it does not retroactively purge
an already-cached corpse (the keeper `--forget` change handles the
transition and any stray cache).

### Investigation targets

**Required** (read before coding):
- zellij/.config/zellij/config.kdl — the config file; add the line near `pane_frames false`

**Optional** (reference as needed):
- `zellij setup --dump-config | rg -A1 session_serialization` — canonical comment/default for the key (default true)

### Risks

- Disabling serialization globally means NO zellij session resurrects across the user's environment (intended — the user wants this). Confirm no workflow relied on resurrecting a manually-created session.

### Test notes

After landing, `rg session_serialization ~/.config/zellij/config.kdl` shows the line; a restarted zellij server writes no `session-layout.kdl` under the cache dir for a new session.

## Acceptance

- [ ] `session_serialization false` is present in `zellij/.config/zellij/config.kdl` with a clarifying comment.
- [ ] The stowed `~/.config/zellij/config.kdl` reflects the change (symlink target).
- [ ] `rg -n 'session_serialization false' ~/.config/zellij/config.kdl` returns the line.

## Done summary
Added 'session_serialization false' to zellij/.config/zellij/config.kdl (stowed to ~/.config/zellij/config.kdl) with a comment explaining it disables the resurrection cache that caused bar-less autopilot sessions.
## Evidence

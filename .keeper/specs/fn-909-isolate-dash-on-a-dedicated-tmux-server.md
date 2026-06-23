## Overview

Reshape `keeper setup-tmux` so it provisions only the human `work` session,
and move the deprecated-but-keepable `dash` dashboard onto its own dedicated
`tmux -L dash` server that is blown away (`tmux -L dash kill-server`) and
recreated wholesale on every run. The `autopilot` session is no longer
created by setup-tmux (the daemon's dispatcher mints it on demand on the
default server) but stays in the `--kill-sessions` sweep/kill set so live
workers still surface in the confirm table and get torn down. Lands AFTER
fn-908, building on its `foreground`→`work` rename.

## Quick commands

- `keeper setup-tmux` — rebuilds the `-L dash` server, provisions only
  `work`, leaves a present `work` session untouched.
- `tmux -L dash attach` — attach the dashboard (now on its own socket).
- `tmux ls` (default server) — shows `work` (+ `autopilot` once the daemon
  has dispatched), never `dash`.
- `bun run test:full` — full tier (CLI/tmux process paths) green.

## Acceptance

- [ ] The dash dashboard lives on a dedicated `tmux -L dash` server; every
  dash-targeting tmux call carries `-L dash` (global flag, before the
  subcommand), and teardown is `tmux -L dash kill-server`, run on every
  invocation regardless of `--kill-sessions`.
- [ ] A BARE `kill-server` is never emitted (it would destroy the default
  server where `work` lives) — pinned by a test asserting the exact teardown
  argv `["tmux","-L","dash","kill-server"]`.
- [ ] setup-tmux provisions only `work`; `autopilot` is not created but
  remains in the `--kill-sessions` sweep/kill set; `RESTORABLE` stays
  `["work"]`.
- [ ] A present `work` session is left untouched on a normal run.
- [ ] `bun run test:full` passes.

## Early proof point

Task that proves the approach: `.1`. If it fails, the likely culprits are
the `-L dash` flag-position on every dash builder (must precede the
subcommand) or the test-harness `cmd[0]:cmd[1]` keying shift (dash calls now
key on `tmux:-L`) — re-check those first.

## References

- Depends on fn-908-drop-background-rename-foreground-to (builds on its
  `foreground`→`work` rename and the WORK_SESSIONS/session-creation logic;
  doc edits layer on fn-908's already-revised README/SKILL text). fn-908 in
  turn depends on fn-907 + fn-902, so this is transitively sequenced after
  all three — the shared `cli/setup-tmux.ts` / README surface lands in order.
- dash panes connect to the daemon over its UDS (`KEEPER_SOCK`), independent
  of the tmux socket — moving the dash session to `-L dash` needs NO change
  to any pane command or the `keeper dash` TUI.
- exec-backend mints `autopilot` via plain `new-session` on the default
  server (src/exec-backend.ts), so dropping it from setup-tmux's provision
  set does not orphan the daemon path.

## Docs gaps

- **README.md**: the setup-tmux onboarding step and the `setup-tmux.ts`
  architecture mirror — setup-tmux provisions only `work`; `autopilot` is
  swept-not-created; dash is on a dedicated `-L dash` server; the attach
  hint becomes `tmux -L dash attach`. Layer on top of fn-908's revisions.

## Best practices

- **`-L <name>` is a global flag:** it MUST precede the subcommand (`tmux -L
  dash kill-server`); placed after, tmux silently treats it as a subcommand
  option and targets the default server. [tmux(1)]
- **`kill-server` over `kill-session` for blow-away-and-recreate:**
  kill-session leaves an empty server running so a later new-session lands on
  the stale server; kill-server gives a truly fresh server. [tmux(1)]
- **Clear inherited `$TMUX` on the dash server:** a session minted on the
  `-L dash` socket from inside a default-server pane inherits `$TMUX`
  pointing at the outer server; stamp `-e TMUX=` so dash panes don't
  misroute a bare `tmux` to the wrong server. [tmux env-inheritance]

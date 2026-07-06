## Overview

`keeper setup-tmux` is a one-shot CLI verb that stands up the human's tmux -f /dev/null
control plane: it rebuilds the `dash` dashboard session on every run, ensures
the `autopilot`/`background`/`foreground` work sessions exist (single shell
window each), and never attaches or switch-clients — so it runs safely inside
or outside tmux. `--kill-sessions` tears all four sessions down first, gated
by a busy-pane confirmation prompt. tmux is driven by direct `Bun.spawnSync`
calls — deliberately outside the ExecBackend seam, whose API stays stable;
only pure exported helpers (`localeDefaultedEnv`, `MANAGED_EXEC_SESSION`) are
reused read-only.

## Quick commands

- `keeper setup-tmux && keeper setup-tmux && tmux list-sessions` — idempotence smoke: both runs exit 0; `dash`, `autopilot`, `background`, `foreground` all listed; second run leaves the three work sessions untouched.
- `tmux new-session -d -s background -c ~/code/keeper 'sleep 600'; echo | keeper setup-tmux --kill-sessions; echo "exit=$?"` — non-TTY busy abort: exits 1, no session killed, the busy `background:sleep` pane listed on stderr.

## Acceptance

- [ ] `keeper setup-tmux` is registered in the dispatcher, idempotent across repeat runs, never attaches, and rebuilds `dash` per the keeper-dash recipe every run.
- [ ] `--kill-sessions` kills all four sessions before setup, prompting y/N only when busy (non-shell foreground) panes exist in the three work sessions; non-TTY stdin with busy panes aborts exit 1 having killed nothing.

## Early proof point

Task that proves the approach: `.1` (the whole epic). If the detached dash
build proves brittle (sizing/layout failures), fall back to porting the
dotfiles script semantics verbatim minus the attach/switch-client tail.

## References

- `~/code/dotfiles/bin/.local/bin/keeper-dash` — authoritative dash recipe (its session-reuse branch and attach/switch tail are deliberately dropped: dash rebuilds unconditionally, nothing attaches)
- `src/exec-backend.ts` — read-only reuse of pure exports (`localeDefaultedEnv`, `MANAGED_EXEC_SESSION`); the ExecBackend session-management API itself is out of scope by design (it stays stable; this command is an experiment)

## Docs gaps

- **README.md `## Install`**: add a step pointing at `keeper setup-tmux` for tmux session provisioning — no current step covers creating dash/work sessions
- **README.md `## Example clients`**: add prose bullet + usage snippet for `setup-tmux` following the one-shot-command style of `commit-work`
- **docs/exec-backend.md**: one-line note that `setup-tmux` deliberately drives tmux directly via `Bun.spawnSync`, outside the ExecBackend seam

## Best practices

- **`=name` exact-match targets:** every `-t` uses `=<session>`; bare names fnmatch and can hit the wrong session [tmux(1)]
- **`has-session` exit code conflates "no session" and "no server":** capture stderr, treat any non-zero as "absent → create"; never inherit stderr on existence probes [tmux #4026]
- **Detached sizing:** `#{client_width}/#{client_height}` are valid only inside tmux with an attached client; outside, `tput cols/lines` needs `TERM` and numeric validation; always pass explicit `-x`/`-y` or detached sessions boot 80x24 [tmux wiki]
- **Layout cadence:** `select-layout main-vertical` after EACH split or later splits fail "no space for new pane"; target panes by `#{pane_id}` (from `split-window -P`) instead of positional pane indexes [tmuxp #800]
- **`pane_current_command` is the foreground basename only:** backgrounded jobs behind an idle shell read as not-busy; never default a destructive confirm to yes on non-TTY [community]

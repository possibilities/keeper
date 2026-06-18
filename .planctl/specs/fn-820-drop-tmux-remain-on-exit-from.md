## Overview

keeper's daemon-dispatched tmux windows are minted with `remain-on-exit on`, which leaves a "Pane is dead (status N)" corpse when a window's process tree fully exits — manual/non-plan windows are never reaped, so the human must `kill-pane` by hand. This epic drops that setting so dispatched panes close natively, exactly like hand-created panes.

It is safe because `remain-on-exit` is NOT how keeper detects death (kqueue/pidfd on claude's pid does that) and NOT how panes stay alive after `claude` exits (the launch wrapper's trailing `exec $SHELL -l -i` login shell does). The dead pane was consumed by exactly one thing — `classifyCloseKind`'s `tmux list-panes` probe — and the trailing shell keeps the pane listed, so `pid_died` classification is preserved. `close_kind` is producer-stamped and folded opaquely, so re-fold determinism is untouched and there is no schema bump.

Accepted tradeoff (documented, not fixed): an isolated whole-process-group death that spares the tmux server and is missed by the live watcher classifies `window_gone_server_alive` instead of `pid_died`, dropping it from crash-restore's auto-offer (recoverable by hand via `restore-agents --snapshot-current` / `claude --resume`). Reboots are `server_gone` → still restored; ordinary claude crashes self-heal via the trailing shell → still `pid_died`. This corner is rare on the macOS/launchd setup and never loses data.

## Quick commands

- `grep -rn "remain-on-exit" src/ docs/ test/` — expect zero hits after the change (historical `.planctl/` specs are out of scope)
- `bun run test:full` — mandatory; the change is on the exec/worker path
- Smoke: dispatch a window via the backend, exit its whole process tree, confirm the window closes natively (no "Pane is dead"); a window whose claude exited but trailing shell lives stays open

## Acceptance

- [ ] `remain-on-exit on` no longer set on dispatched windows; panes close natively on full-tree exit
- [ ] `classifyCloseKind` logic unchanged; `pid_died` / `window_gone_server_alive` / `server_gone` semantics preserved for the common cases
- [ ] All comments/docs forward-facing and accurate to the trailing-shell mechanism
- [ ] `bun run test:full` green; landed via `keeper commit-work`

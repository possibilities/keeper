## Overview

Ship a keeper-owned, keeper-installed tmux drop-in (`tmux/keeper-guard.conf`)
so the human gets a `confirm-before` menu-bar prompt before MANUALLY opening a
new window or split-pane inside a keeper-managed tmux session
(`autopilot`/`pair`/`panels`/`agentbus`), while their own non-keeper sessions
behave byte-identically to today. The whole feature is a static tmux config
fragment plus the install wiring — the keeperd daemon is unchanged. A
`session-created[42]` hook stamps a session-scoped marker
`@keeper_managed_session=1` on the 4 managed session names; the create-key
binds are `confirm-before`-wrapped and gated on that marker via `if-shell -F`.
This is a DETERRENT (mouse-menu / programmatic creation bypass key bindings),
not a hard lock.

## Quick commands

- `tmux display-message -p -t '=autopilot:' '#{@keeper_managed_session}'` → `1` after a managed session is minted (empty in `=work:`).
- `tmux list-keys -T prefix | grep ' c '` → shows `if-shell -F "#{@keeper_managed_session}" "confirm-before ... new-window" new-window`.
- `keeper setup-tmux` then `ls -l ~/.config/tmux/conf.d/zz-keeper-guard.conf` → symlink → `<repo>/tmux/keeper-guard.conf`.
- `bun run test:full` (touches CLI + a real-tmux slow test).

## Acceptance

- [ ] In a keeper-managed session, `prefix c` / `prefix |` / `prefix _` / `M-\` / `M--` show a `confirm-before` y/n prompt before creating; `y` proceeds, `n` aborts.
- [ ] In a non-keeper session the same keys behave byte-identically to the human's current binds (no prompt).
- [ ] `keeper setup-tmux` idempotently installs the symlink, fail-open, without disturbing dash rebuild / work-session ensure; re-running is a quiet no-op.
- [ ] The daemon, schema, projections, and the existing `@keeper_managed` window marker are untouched.

## Early proof point

Task that proves the approach: `.1` (the shipped `.conf` + its real-tmux slow
smoke test — the hook stamps a managed-named session, skips a human session,
and both binds install with a byte-identical else-branch). If it fails: the
three-level `confirm-before`/`if-shell`/`-c "…"` quoting or the indexed hook is
the culprit — a verified literal-value proof exists at
`/private/tmp/claude-501/-Users-mike-code-keeper/0e40b570-f77a-4948-8802-455f4c650807/scratchpad/keeper-guard.conf`.

## References

- Managed session-name source of truth: `src/exec-backend.ts:115-146` (`MANAGED_EXEC_SESSION="autopilot"`, `AGENTBUS_EXEC_SESSION="agentbus"`, `PAIR_EXEC_SESSION="pair"`, `PANELS_EXEC_SESSION="panels"`; the 4 names = `MANAGED_AUTOCLOSE_SESSIONS ∪ {autopilot}`). The static `.conf` duplicates these by value — guard with a content test.
- DISTINCT existing marker: `src/bus-wake.ts:61-62` window-scoped `@keeper_managed="agentbus"` (external reaper). The new marker is session-scoped `@keeper_managed_session=1` — no name/scope collision.
- Confirm-before idiom to conform to: the human's `~/.config/tmux/conf.d/navigation.conf:46` `bind-key -n M-q confirm-before -p "kill-window #W? (y/n)" kill-window`. Prompt uses `#S` (verified it expands).
- The human's ACTUAL create-keys (NOT tmux defaults) live in `~/.config/tmux/conf.d/splitting.conf`: `bind |`/`bind _` = `split-window -h|-v -c '#{pane_current_path}'`, root `bind -n M-'\'`/`M-'-'` same commands; `%`/`"` are `unbind`-ed (out of scope). `c` is the unmodified tmux default `new-window`. Prefix is `C-Space`.
- Shipped-template precedent: `plist/arthack.keeperd.plist` symlinked into `~/Library/LaunchAgents/` per `README.md:483-495`.

## Docs gaps

- **README.md step 10 (`keeper setup-tmux` block ~679-694) + the setup-tmux description (~1404-1445)**: add a sentence that the provisioner symlinks `tmux/keeper-guard.conf` → `~/.config/tmux/conf.d/zz-keeper-guard.conf` (revise step 10; the symlink is part of the same provisioner action). Note the precondition: it only activates if the human's `tmux.conf` sources `conf.d/*.conf`.
- **README.md Uninstall (~1447-1463)**: add `rm ~/.config/tmux/conf.d/zz-keeper-guard.conf` and note tmux has no live config-unload (effective after server restart / re-source).
- **cli/setup-tmux.ts HELP (:39-73)**: one clause on the symlink install.
- Managed-session enumerations in README/CLAUDE.md do NOT change — the marker is daemon-unread.

## Best practices

- **Indexed `set-hook -g 'session-created[42]'`:** idempotent on re-source AND coexists with a user's own `session-created` hook — verified on 3.6b. NOT `-g` (replace, clobbers) nor `-ga` (append, duplicates on re-source).
- **Symlink install:** guard with `[ -L ]` (symlink, even broken) vs `[ -e ]` (real file); refuse to clobber a real file; never unconditional `ln -snf`. `mkdir -p` the conf.d parent.
- **`run-shell -b`** for the load-time sweep (non-blocking, best-effort) — a bare `run-shell` blocks the command queue at config load.
- **Deterrent framing** in user-facing copy: "prompts before keyboard-triggered window/split creation", not "prevents creation".

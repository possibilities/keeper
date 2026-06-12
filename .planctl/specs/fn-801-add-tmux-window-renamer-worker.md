## Overview

keeperd gets an eleventh worker thread: the renamer. It watches the `jobs`
projection (level-triggered on `PRAGMA data_version`) and auto-names every
tmux window hosting a live Claude session after that session's job title —
the latest-appeared Claude in a window wins. Pure external actuator: reads
the projection read-only, writes ONLY to tmux (`rename-window`), never the
DB. Human windows get useful tab names for free; autopilot's managed
windows (deliberately unnamed today) finally get labels.

## Quick commands

- `bun test test/renamer-worker.test.ts test/exec-backend.test.ts` — unit tier
- Smoke: start a claude in a tmux window, wait one pulse, then `tmux display-message -t <pane> -p '#{window_name}'` shows the session title
- `tmux list-windows -a -F '#{window_id} #{window_name}'` — eyeball all named windows

## Acceptance

- [ ] ExecBackend exposes session-agnostic `listPanes` / `renameWindow` ops (pure argv builders, injected spawn, never-throw envelopes)
- [ ] renamer-worker names windows from live-job titles, latest-appeared wins, renames only on mismatch
- [ ] Worker registered at all daemon sites (WorkerName union, ALL_WORKERS, spawn, teardown) and NOT in WATCHER_WORKERS
- [ ] No DB writes from the worker; no worker→main messages beyond lifecycle
- [ ] `bun run test:full` passes

## Early proof point

Task that proves the approach: ordinal 1 (the exec ops — tmux mechanics,
`--` separator, tab-safe parse). If it fails: re-derive the sweep/rename
argv against tmux 3.6b by hand in a scratch `-L` server and adjust builders.

## References

- `fn-799-remove-zellij-exec-backend` (dep + overlap) — mid-rewrite of `src/exec-backend.ts` and `docs/exec-backend.md`, the same files task 1 edits; land after it.
- `src/exec-backend.ts:142-144` — the reserved window-naming seam this epic fills.
- `src/restore-worker.ts:580-704` — the existing tmux list-panes poll arm (sweep, gate, dedup-hash patterns).
- tmux/tmux issue #4826 — external `rename-window` is the sanctioned scripted-titling path; `--` separator required.

## Docs gaps

- **README.md** (~line 2355): worker count "ten" → eleven + a renamer paragraph following the ninth-worker (restore) paragraph pattern — covered by task 2.
- **docs/exec-backend.md**: op-categories table, public-surface prose, pure-helpers table gain listPanes/renameWindow rows — covered by task 1.

## Best practices

- **`--` before the name in rename argv:** titles may start with `-`; tmux's own parser misreads them otherwise [tmux/tmux #4826]
- **Rename only on mismatch:** every `rename-window` permanently suppresses that window's automatic-rename; matching names must not re-rename [tmux manpage]
- **Leave automatic-rename suppressed after renaming:** re-enabling makes tmux fight the renamer on every activity tick; owning the name is the plugin-proven strategy [ofirgall/tmux-window-name]
- **TOCTOU rename failures are expected no-ops:** a window can close between sweep and rename; nonzero "can't find window" is not an error
- **Grouped/linked sessions share window objects:** renaming `@N` renames it in every session holding it — unavoidable, accepted

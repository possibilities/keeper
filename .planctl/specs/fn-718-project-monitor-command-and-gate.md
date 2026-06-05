## Overview

Today `keeper jobs` shows each live monitor/ambient background task as an
opaque `[kind] <id>` line, and nothing can block on whether a specific
background script is still running. This epic carries the `command` /
`description` already present on every Stop snapshot through the v51
monitors projection so the script shows on an indented line, and adds a
parent-session-scoped `monitor-running` await condition so an agent can
block until its own background script finishes.

## Quick commands

- `keeper jobs` — expand a job row; each monitor renders `[kind] <description>` with its command/script on an indented continuation line
- `keeper await monitor-running <selector>` — block until the matching monitor in your own session is no longer running
- `bun test test/derivers.test.ts test/reducer.test.ts test/jobs.test.ts test/await-conditions.test.ts test/await.test.ts`

## Acceptance

- [ ] The monitor command/script renders on an indented line under each monitor row in `keeper jobs`
- [ ] A new `keeper await monitor-running <selector>` condition blocks on own-session monitor liveness, exact-matching by command or kind
- [ ] No `SCHEMA_VERSION` bump; re-fold determinism preserved; `keeper/api.py` untouched
- [ ] Liveness is parent-session-scoped (absence = done, whether Stop-dropped or terminal-cleared); no OS PID / exit-watcher

## Early proof point

Task that proves the approach: task 1 (project command + render). If it fails because the `background_tasks[]` payload doesn't carry `command` after all: the command-match selector loses its data — fall back to kind-only matching and drop the indented-command line. (The payload was verified to carry `command`, so this is low-risk.)

## References

- fn-682 — the v51 live monitors projection this extends (`extractBackgroundTasks`, `computeMonitors`, `monitorLinesFor`)
- fn-713 — await git/job-state conditions (`gitCleanState` / `agentsIdleState`); the predicate + CLI-wiring template
- fn-717 (overlap, not a blocker by content) — also edits `src/reducer.ts` (drain SELECT, a different seam); coordinate merge order / rebase after fn-717.1 closes
- Verified: every Stop `background_tasks[]` entry carries `{id, type, status, description, command}`; `status` is always `"running"` (5659/5659), so it is deliberately NOT projected (fn-708 J7 precedent)

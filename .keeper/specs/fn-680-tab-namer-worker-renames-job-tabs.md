## Overview

Add an eleventh keeper daemon worker — the tab-namer worker — that renames
each live job's zellij tab to match the job's transcript-derived `title`.
fn-678 made the tab name purely cosmetic (no control path reads it: reap is
by `backend_exec_tab_id`, launch dedup by `pending_dispatches`), so renaming
every tab — autopilot's included — is now safe. The worker is a PURE
SIDE-EFFECTOR: read-only DB connection, writes nothing to the DB, mints no
events, no schema bump, no reducer arm — it only shells `zellij action
rename-tab-by-id`. End state: `keeper jobs` tabs read as human titles instead
of `verb::id` once a real transcript title emerges.

## Quick commands

- `bun test test/exec-backend.test.ts test/tab-namer-worker.test.ts`
- `bun test` (full suite — daemon boot/shutdown stays clean with the new worker)
- `zellij action rename-tab-by-id --help` (confirms the focus-safe op exists; 0.44.3)
- `grep -rn "TEN\|TENTH\|ALL TEN" src/daemon.ts src/restore-worker.ts` — expect zero stale worker-count refs after task 3

## Acceptance

- [ ] A live job whose sanitized `title` differs from its tab name gets its zellij tab renamed to the title, within ~5s, without stealing the human's focus
- [ ] No schema bump, no new event, no reducer change, no `keeper/api.py` change — the worker writes nothing to the DB and mints nothing
- [ ] The worker uses `rename-tab-by-id` (focus-safe), never `rename-tab --tab-id` (open focus-switch bug #4602)
- [ ] Redundant renames are suppressed (success-gated `lastSet` debounce); a failed rename retries; an ended job's tab is left alone
- [ ] Daemon spawns and cleanly shuts down the worker (all three shutdown lists); worker-count prose bumped to eleven across `src/` and `README.md`

## Early proof point

Task that proves the approach: `.1` (the `ExecBackend.renameTab` op + builder).
The load-bearing assumption is that `zellij action rename-tab-by-id <id> <name>`
renames a tab by its stable id WITHOUT moving the human's focus (the `-t`/`--tab-id`
flag has open bug #4602). Verified present in 0.44.3. If it turns out to disturb
focus in practice: fall back to scoping renames to non-autopilot sessions only, or
drop the worker — the cosmetic gain isn't worth yanking the human's cursor.

## References

- `fn-678-decouple-dispatch-from-tab-naming` (DONE) — made the tab name cosmetic / `ExecBackend` name-free; the prerequisite that makes this safe
- `fn-668` (DONE) — the `BackendExecSnapshot` worker + `jobs.backend_exec_{session_id,tab_id,tab_name}` metadata this worker reads; also the convergence counterparty (reads the new name back)
- `src/backend-worker.ts` — the interval-tick lifecycle template (setInterval + isRunning + setImmediate shutdown)
- `src/restore-worker.ts` — the pure-consumer worker model (read-only DB, no onmessage/post, no DB write)
- zellij issue #4602 — `rename-tab --tab-id` focus-switch bug (why we use `rename-tab-by-id`); #4627 — session-name length hang (why we cap)

## Docs gaps

- **README.md**: add an eleventh-worker paragraph (model on the tenth/restore-snapshot para ~1427); bump "The ten workers..." -> eleven (both occurrences ~1449); add `renameTab` to the `ExecBackend` op list (~1372)
- **CLAUDE.md**: revise the fn-678 bullet's closing sentence (~357-375) — dispatch dedup still never reads the tab name, but `renameTab` is now a real op used by the tab-namer worker, so "exposes only launch, closeByTabId, focusPane, resolveTabForPane" is stale; add `renameTab` to the op enumeration

## Best practices

- **Use `rename-tab-by-id <id> <name>`, never `rename-tab --tab-id`:** the flag form has an open focus-switch bug (#4602) that yanks the human's visible focus to the renamed tab — fatal for a 5s background poller. `rename-tab-by-id` is focus-safe and also LOCKS the name against zellij auto-rename.
- **Pass the title as a discrete argv element (no shell):** `Bun.spawn` is shell-free by default, so a transcript title containing `$()`, backticks, `;`, or quotes is a literal argv string — complete injection mitigation. Never build the command via a shell string.
- **Strip control/ANSI/OSC bytes from the title for DISPLAY safety:** `\x00-\x1f` + `\x7f` (incl. embedded escape sequences) corrupt the tab bar; argv-array spawn handles injection, sanitization handles rendering. Also strip a leading `-` so clap doesn't parse the name as a flag.
- **Success-gated `lastSet` debounce:** record the issued name only on a successful rename, keyed on the sanitized title sent — this bounds spawns to one per (job, title) even if zellij normalizes its stored copy, and lets a transient failure retry on the next tick.
- **Silent no-op on every failure:** a non-zero exit (tab gone / session dead) or ENOENT is expected during a job's lifecycle — never propagate, never escalate (keeper's no-self-heal contract). Don't read the name back to confirm; backend-worker is the single reader of zellij tab state.

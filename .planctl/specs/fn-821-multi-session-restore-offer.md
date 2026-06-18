## Overview

Generalize the `keeper setup-tmux` "restore last session" offer (landed in fn-819) from FOREGROUND-ONLY to all human work sessions — `foreground` AND `background` — so a post-crash setup-tmux offers to relaunch the last generation's crashed agents for both. The reconciler-managed autopilot session stays excluded. End state: after a crash, the first `setup-tmux` shows ONE combined y/N prompt listing each absent work session and its agent count, and on yes relaunches each into its own session.

## Quick commands

- `bun scripts/restore-agents.ts --last-generation` — dry-run candidates across all sessions (foreground + background).
- `bun run test:full` — mandatory; the setup-tmux test exercises the hook/db/process paths the fast tier skips.

## Acceptance

- [ ] The offer covers `RESTORABLE = WORK_SESSIONS` minus `MANAGED_EXEC_SESSION` (= background + foreground); autopilot is never offered or spawned.
- [ ] A session is offered AND restored only when it is ABSENT and has count>0 last-generation candidates; per-session skip-if-exists (foreground present + background absent → only background); both present → no offer; count-0 absent → dropped.
- [ ] ONE combined TTY prompt names each offered session and its own count; one `y` arms all offered sessions, non-TTY never auto-restores; counts computed once before any session-creating call.
- [ ] On yes, each offered session is relaunched via `restore-agents --apply --session <name> --last-generation` (fire-and-forget `run()`, continue-on-error — one session's failure doesn't abort the other or setup).
- [ ] HELP + module docstring + README revised from foreground-only to foreground+background; `bun run test:full` green.

## Early proof point

The single task IS the change; the proof is its test matrix — both-absent, one-absent-one-present, both-present, count-0, and non-TTY, plus the per-session spawn argv. If the gating matrix or prompt grammar is wrong, the tests catch it before landing.

## References

- Refines fn-819 (DONE): the BackendExecStart generation event + `deriveLastGenerationSet` + the foreground-only setup-tmux offer. `restore-agents --session <name>` is already generic (filters by `backend_exec_session_id`), so no restore-agents change is needed. No daemon/schema change, no keeper bounce.

## Docs gaps

- **README.md (~1186-1194, setup-tmux architecture block)**: revise the foreground-only offer prose (condition → prompt → spawn argv → skip) in-place to foreground+background.
- **cli/setup-tmux.ts HELP (~:41-44)** + module docstring (~:2-8): generalize the "When the 'foreground' session is ABSENT…" wording to the human work sessions.

## Best practices

- **One combined prompt that names each session + count, not a per-session y/N loop:** per-session prompting trains "autopilot clicking" past a destructive-ish action. Safe default `[y/N]` (capital N). [NNGroup confirmation dialogs]
- **Continue-on-error for independent sessions:** one session's restore failing must not block the other — keep each spawn on `run()`, consistent with fn-819. [distributed error-handling]
- **Non-TTY never auto-restores:** missing TTY is not implicit consent; print a clear skip. [CLI non-interactive safety]

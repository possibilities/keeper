## Overview

`keeper commit-work` already fails fast (exit 1) when no Claude Code session
id resolves, but with a generic prose error. Reshape that single failure into
a distinct, machine-matchable envelope (`error: "no_session_id"` plus a
`hint`) that tells a session-less agent to commit with git directly — staging
only the files it changed by explicit path. End state: an agent invoking
commit-work outside a recognized session gets an unambiguous, actionable
fallback instead of a dead end.

## Quick commands

- `env -u CLAUDE_CODE_SESSION_ID -u JOBCTL_SESSION_ID -u JOBCTL_JOB_ID bun cli/keeper.ts commit-work --preview-files` — prints `{"success": false, "error": "no_session_id", "hint": "..."}` and exits 1
- `bun test test/commit-work.test.ts` — the no-session-id block passes

## Acceptance

- [ ] no-session-id invocation returns the unique `error: "no_session_id"` + git-direct `hint` envelope (compact, exit 1)
- [ ] hint omits `--session-id`; test updated; `bun run test:full` green

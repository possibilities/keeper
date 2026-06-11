## Overview

The tmux exec backend deliberately does NOT perform the zellij-style
session-gone single-retry — it runs a cheap per-call `has-session` probe
before each `new-window` instead of a memoized ensure with a retry arm. The
de-zellijified docs sweep left one paragraph claiming a generic
`new-tab`/`new-window` retry guarantee that tmux does not provide, which
would mislead the next reader about tmux's actual resilience contract. This
follow-up scopes that doc paragraph correctly and pins the deliberate
non-retry with a regression test.

## Acceptance

- [ ] docs/exec-backend.md accurately describes tmux's per-call-probe
  resilience (no session-gone retry/memo) distinct from zellij's memo-retry.
- [ ] A test pins that tmux `launch` does NOT retry on a session-gone
  `new-window` failure (the inverse of the zellij retry tests).

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | docs/exec-backend.md:178-182 claims a new-window session-gone retry tmux does not perform (src/exec-backend.ts:748-772 launches once, no memo/retry). |
| F2 | culled | — | Once-per-dead-session env-materialization micro-opt; functionally correct, matches documented intent, no user-observable impact. |
| F3 | merged-into-F1 | .1 | F3 (pin tmux non-retry) folds into F1: same root cause and exec-backend tmux-retry file-touch, lands as one commit with the doc fix. |
| F4 | culled | — | Thin jobs.ts TUI focus-routing handler judged acceptable; already covered by backend unit tests. |

## Out of scope

- tmux env-materialization micro-optimization on the cold mint (F2, culled).
- jobs-board-level focus-routing test (F4, culled — covered at unit level).

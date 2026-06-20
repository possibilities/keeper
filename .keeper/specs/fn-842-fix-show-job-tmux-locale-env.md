## Overview

The `keeper show-job` auto-detect ladder uses a tmux pane sweep to pick the
single live agent in the current window, but its `tmux list-panes` spawn
omits `localeDefaultedEnv`. Under a C locale the `-F` TAB delimiters arrive
as `_`, every line fails the parse, and the tmux rung silently reads empty —
exactly in the LaunchAgent/cron/CI contexts this daemon runs under. This is a
one-line robustness fix that brings the call site in line with every other
`buildTmuxListPanesArgs()` caller in the tree.

## Acceptance

- [ ] The tmux pane-sweep spawn in show-job passes `localeDefaultedEnv` so it
  survives a locale-stripped environment.
- [ ] The fix matches the pattern used at every other `buildTmuxListPanesArgs()`
  call site (exec-backend, restore-worker, setup-tmux).

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | cli/show-job.ts:296 omits `env: localeDefaultedEnv` on the tmux spawn; under C locale the `-F` TAB delimiters become `_` and the tmux auto-detect rung silently reads empty in headless contexts. |
| F2 | culled | — | `emit()` `process.exit` skips `finally db.close` (show-job.ts:494-495), but it is harmless on a readonly fd reclaimed at teardown; comment-only remedy, no user impact. |
| F3 | culled | — | `SELECT DISTINCT *` at show-job.ts:276 is sound defensive future-proofing the auditor marked no-change-needed; dead-defense nitpick. |
| F4 | culled | — | Impure-layer unit coverage is deliberately isolated in `main` and needs fixture-heavy real-tmux tests; low-impact coverage-chasing, narrow locale concern lands with F1. |
| F5 | culled | — | resume-descriptor.test.ts reformat is a confirmed no-semantic-change formatter touch, not a defect. |

## Out of scope

- Unit-testing the impure `main`/`autoDetect` layer (deliberately isolated; F4 culled).
- Closing the readonly DB handle on the `process.exit` paths (F2 culled, benign).
- Dropping the defensive `SELECT DISTINCT` (F3 culled).

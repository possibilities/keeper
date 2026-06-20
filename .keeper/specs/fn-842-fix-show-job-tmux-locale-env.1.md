## Description

Originating finding F1 (evidence: cli/show-job.ts:296). The
`Bun.spawnSync(buildTmuxListPanesArgs(), {...})` call in
`tmuxWindowPaneIds` omits the `env:` key, so it inherits the process env
instead of `localeDefaultedEnv(...)`. Per the `localeDefaultedEnv`
docstring (src/exec-backend.ts:320-328), a tmux client under the C locale
sanitizes the `-F` TAB delimiters to `_`, so every `line.split("\t")` parse
fails and the window-scope auto-detect rung reads as an empty (non-degraded)
snapshot. Every other `buildTmuxListPanesArgs()` caller wraps the spawn:
exec-backend.ts:409, exec-backend.ts:684, restore-worker.ts:219,
setup-tmux.ts:465. Add `env: localeDefaultedEnv(process.env as Record<string,
string | undefined>)` to the spawnSync options to match.

## Acceptance

- [ ] cli/show-job.ts:296 passes `env: localeDefaultedEnv(...)` in the
  spawnSync options, matching the sibling call sites.
- [ ] In a locale-stripped env (no `LANG`/`LC_*`), the tmux-window rung
  resolves correctly rather than silently reading empty.
- [ ] No behavior change in an interactive shell with an inherited locale.

## Done summary

## Evidence

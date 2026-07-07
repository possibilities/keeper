## Description

Close the two diagnosis-role git allowlist gaps in
`plugins/keeper/plugin/hooks/escalation-guard.ts`, both rooted in the git
branch of `classifyExecutable` (guard evidence from the audit vet):

- F1 — git config injection. `gitSubcommand` (guard.ts:~380) skips `-c` and
  its value without inspecting it, and `classifyExecutable` (guard.ts:~424)
  clears any subcommand on `READONLY_GIT_SUBCOMMANDS` for a diagnosis role.
  So `git -c core.fsmonitor=/path/to/interp status` (or `diff.external`,
  `core.pager`+paginate, `core.sshCommand`, `*.textconv`, `alias.*`) lexes
  clean and executes an arbitrary program on an allowlisted read subcommand.
  Fix: for a non-write-capable role, deny a git `-c`/`--config`
  config flag carrying an equals-value (the simplest structural cut), or
  specifically block the exec-bearing config keys.

- F2 (merged into F1) — `branch` mutation. `branch` sits in
  `READONLY_GIT_SUBCOMMANDS` (guard.ts:~72-86) and the classifier checks only
  the subcommand name, so `git branch -D/-f/-m` mutates refs from a role
  documented read-only; branch-guard does NOT cover it (it needs `agent_id`,
  which an escalation session lacks). Fix: deny `branch` for diagnosis roles,
  or classify it with a mutating-flag check (bare/list/verbose allowed;
  delete/move/force/create denied).

Keep write-capable roles (`deconflict`/`repair`) unchanged — they get all of git.

Files: `plugins/keeper/plugin/hooks/escalation-guard.ts`,
`plugins/keeper/plugin/hooks/escalation-guard.test.ts` (or the sibling test
that drives the `evaluateEscalationCommand` truth table).

## Acceptance

- [ ] A diagnosis-role git command carrying an exec-bearing `-c` config value on an allowlisted read subcommand is denied.
- [ ] A diagnosis-role `git branch` delete/force/rename form is denied; bare/list/verbose still allowed.
- [ ] Write-capable roles retain full git access (no regression).
- [ ] The `evaluateEscalationCommand` truth table gains deny cases for the git-config exec vector and the branch write forms.

## Done summary

## Evidence

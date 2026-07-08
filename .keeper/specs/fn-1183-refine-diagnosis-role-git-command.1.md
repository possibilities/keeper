## Description

All changes land in `plugins/keeper/plugin/hooks/escalation-guard.ts` and
`test/escalation-guard.test.ts` (audit evidence read against commit 2d5aa9d6).

1. F1 — fix the config-injection over-block. `gitConfigInjection` currently loops the
   whole segment (`for i=1..tokens.length`), so `git log -c --format=%H` and `git show
   -c --format=...` (combined-diff `-c` immediately followed by an `=`-bearing token)
   are denied as injection even though a post-subcommand `-c` is the subcommand's own
   flag, not a git global. Compute `gitSubcommandInfo` first and scan only
   `tokens[1 .. sub.index)` for injection. Git honors `-c` solely as a global (which
   must precede the subcommand), so this still catches the reorder case
   (`git --git-dir d -c x=y status`) while leaving a post-subcommand `-c` alone. Fix
   the stale function comment ("no read subcommand legitimately pairs a `-c` with an
   `=`-bearing value") — `git log -c --format=` does exactly that.
2. F6 — close the exec vector: `grep` is in `READONLY_GIT_SUBCOMMANDS`, so
   `git grep --open-files-in-pager=<cmd>` runs an arbitrary program for a diagnosis
   role. Deny the exec-bearing flag(s) on allowlisted read subcommands (at minimum
   `--open-files-in-pager`), fail-closed and consistent with the config-injection deny.
3. F3/F4/F5 — lock the table tests. Add two DENY cases to the ref-classifier tests:
   a delete flag (`-D`) sitting in a filter-flag value slot after a `--list` filter,
   and the `--unset-upstream` mutating flag (the one mutating flag with no deny-table
   case). Add (after the F1 fix) `git log -c --format=%H` and `git show -c --format=%H`
   to the diagnosis ALLOW table.

## Acceptance

- [ ] `git log -c --format=%H` / `git show -c --format=%H` allow for a diagnosis role; `git -c core.pager=x log` and `git --git-dir d -c x=y status` still deny.
- [ ] `git grep --open-files-in-pager=<cmd>` denies for a diagnosis role.
- [ ] The delete-flag-in-value-slot form (a `--list` filter then a `-D` flag) and the `--unset-upstream` form deny; the new allow/deny rows are in the table tests and green.
- [ ] Write-capable roles retain full git (no regression).

## Done summary
Bounded the escalation-guard git config-injection scan to the pre-subcommand region (combined-diff 'git log/show -c --format' reads now allow while reordered '-c' globals stay fail-closed via valued-global-aware gitSubcommandInfo), denied the 'git grep --open-files-in-pager'/'-O' exec vector for diagnosis roles, and locked the ref-classifier deny/allow table tests.
## Evidence

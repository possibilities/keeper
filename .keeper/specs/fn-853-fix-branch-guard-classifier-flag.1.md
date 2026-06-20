## Description

Fixes two live-reproduced classifier bypasses in
`plugins/keeper/plugin/hooks/branch-guard.ts`, bundled because they share
the same file, the same `isBranchMutatingInvocation` function, and the same
`branch-guard.test.ts` truth-table touch:

- F1 (branch-guard.ts:79-93 switch handler, :67-77 checkout handler): the
  create-flag check is exact-token equality (`t === "--create"` /
  `t === "--orphan"`), so the `=value` form `git switch --create=zzz` and
  `git checkout --orphan=x` slip through as ALLOW. Live-verified:
  `git switch --create=zzz` creates+switches a branch. Match create flags
  with a prefix/equals-aware test that also covers `--create=` / `--orphan=`.

- F2 (branch-guard.ts:95-105 branch handler): the deny rule inspects only
  `tokens[0]`, so any leading flag that consumes no operand (`-f` /
  `--force`) pushes the new branch name to a later token and bypasses the
  guard. Live-verified: `git branch --force newbranch` creates a branch.
  Scan for the first non-flag positional that is not the operand of a
  value-flag (`-d`/`-D`/`-m`/`-M`/`-u`/`--set-upstream-to`/`-t`/`--track`),
  treating `-f`/`--force` as non-operand-consuming.

## Acceptance

- [ ] `git switch --create=<x>` and `git checkout --orphan=<x>` classify as DENY
- [ ] `git branch --force <name>` and `git branch -f <name> <start>` classify as DENY
- [ ] `branch-guard.test.ts` gains deny-cases for all four forms; existing space-form deny cases and allow cases (`git branch -d x`, `git log --grep "git checkout -b"`, file-restore) stay green
- [ ] `bun run test:full` passes (hook process path)

## Done summary
Closed two live-reproduced branch-guard classifier bypasses: switch/checkout now match --create=/--orphan= equals forms, and the branch handler scans for the first non-operand positional past leading -f/--force flags. Added regression cases for all four forms.
## Evidence

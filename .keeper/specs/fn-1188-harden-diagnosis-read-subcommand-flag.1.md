## Description

Harden `gitReadSubcommandExecFlag` in
`plugins/keeper/plugin/hooks/escalation-guard.ts` (audited version around
lines 496-513) to close two read-subcommand escapes for diagnosis roles.

F1 (kept): the short-alias deny `sub === "grep" && arg.startsWith("-O")`
(line 508) only matches a token that *begins* with `-O`. Git honors
short-option bundling, so `git grep -nO<pager>`/`-iO<pager>`/any
`-<flags>O<pager>` reaches `--open-files-in-pager` while the token starts
with `-n`/`-i`, sailing past the check — reproduced live firing the pager
program (`PAGER-EXEC-FIRED`). Detect the exec alias anywhere in a
single-dash, non-`--` short-flag cluster (e.g. `/^-[A-Za-z]*O/` for
`sub === "grep"`; git's optional-arg `-O` consumes the token remainder as
the pager). The un-bundled and long forms already deny; only the bundled
short form leaks.

F2 (merged into F1): the added deny-case tests only exercise leading `-O`
and the long `--open-files-in-pager=` form, so the truth table gives false
confidence. Add deny rows for the bundled forms.

F3 (kept): `git log --output=<file>` / `git diff --output=<file>` write an
arbitrary file for a read-only diagnosis role (reproduced live) — a flag,
not a shell redirect, so the lexer's redirect deny does not catch it, and
`gitReadSubcommandExecFlag` screens only the pager aliases. Deny
`--output` / `--output=<file>` (and the space-separated value form) on the
allowlisted read subcommands as an arbitrary file-write vector.

Files: plugins/keeper/plugin/hooks/escalation-guard.ts,
test/escalation-guard.test.ts.

## Acceptance

- [ ] `git grep -nO<pager>`, `-iO<pager>`, and `-<flags>O<pager>` deny for diagnosis roles.
- [ ] `git log --output=<file>` and `git diff --output=<file>` (glued and space forms) deny for diagnosis roles.
- [ ] Legitimate un-bundled reads and diff/log benign `-O` order-file usage stay allowed.
- [ ] New deny-case tests cover the bundled `-O` form and the `--output=` form; existing allow/deny rows stay green.

## Done summary

## Evidence

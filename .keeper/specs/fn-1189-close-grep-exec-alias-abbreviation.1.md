## Description

Finding F1 (auditor Axis-1 Critical). In
`plugins/keeper/plugin/hooks/escalation-guard.ts`, `gitReadSubcommandExecFlag`
denies the exec alias only via the exact strings `--open-files-in-pager` /
`--open-files-in-pager=` plus the grep-scoped single-dash regex
`/^-[A-Za-z]*O/`. Git parse-options accepts any unambiguous prefix
(`--open`, `--open-f`, `--open-files`, ...) as the same option, and none of
those are caught. Live-verified in this repo: `git grep --open='echo X'`
and `git grep --open-f='echo X'` both executed the caller command (exit 0),
while `--zzzznope=` errors — confirming `--open` is a genuine accepted
abbreviation, so arbitrary program execution reaches a read-only diagnosis
role. Match the exec alias by unambiguous-prefix (deny any read-subcommand
arg matching `^--open(-files(-in(-pager)?)?)?(=|$)` down to the shortest
unambiguous prefix `--open`) rather than the exact literal.

Files:
- plugins/keeper/plugin/hooks/escalation-guard.ts (`gitReadSubcommandExecFlag`)
- test/escalation-guard.test.ts

## Acceptance

- [ ] Deny `--open=<cmd>`, `--open-f=<cmd>`, `--open-files=<cmd>` and every
      unambiguous prefix up to `--open-files-in-pager`, in both glued-`=`
      and space-separated forms
- [ ] Guard still fails closed (no under-block) and existing benign allow
      rows (diff/log `-O` order file, plain grep patterns, `--output` deny)
      remain unchanged
- [ ] New deny-case tests assert `git grep --open=/tmp/evil` and
      `git grep --open-files=/tmp/evil` are denied

## Done summary
Match git's --open-files-in-pager exec alias by unambiguous prefix (--open … full literal) in gitReadSubcommandExecFlag, closing the read-subcommand arbitrary-exec bypass; added deny-case tests for --open=/--open-f=/--open-files= abbreviations in glued and space-separated forms.
## Evidence

## Description

Finishes the fn-906 rename on the plan CLI's user-facing output, missed by
the original sweep (the done_summary enumerates touched files and lists
neither cli.ts nor project.ts; `scripts/lint-retired-name.sh` is a
progressive anti-clobber guard, not a repo-wide grep-clean, so green lint
did not certify completeness).

Folds two findings sharing one root cause and one file-touch theme (plan
CLI src strings), landing as one commit:

- F1 (plugins/plan/src/cli.ts:74) — `const PROG = "planctl";` drives
  `Usage: planctl [OPTIONS]...` (:75) and `Try 'planctl --help' for help.`
  (:754, :761). Rename PROG to the invoked name. While in this file, also
  retire the stale `planctl` references in the comments at :78 and :81.
- F2 (plugins/plan/src/project.ts:79, :186) — user-facing error strings
  `No planctl project found. Run 'planctl init' first.` Substitute the
  retired command name in both.

## Acceptance

- [ ] `PROG` no longer resolves to `planctl`; usage/help/try-help output names the live command.
- [ ] project.ts:79 and :186 error strings no longer name `planctl init`.
- [ ] Stale `planctl` comment references in cli.ts swept.
- [ ] Plan CLI + guard test suites green.

## Done summary
Renamed PROG to 'keeper plan' in cli.ts + subgroup.ts and substituted the retired planctl name across all user-facing usage/help/error/hint strings (project resolution, close-preflight/finalize, verdict/followup hints, audit upgrade message, set-repos hint); updated the pinning test assertions.
## Evidence

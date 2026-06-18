## Description

Originating finding F1 (evidence: cli/keeper.ts:63). The `plan`
subcommand usage line in keeper's `--help` reads `Alias for the planctl
CLI: \`keeper plan <verb>\` execs planctl`. The fn-824 diff removed the
child spawn — cli/keeper.ts:166 now dispatches `keeper plan` in-process
via `(await import("./plan")).main(argv)`. Update the help wording to
reflect in-process dispatch (e.g. "runs planctl in-process"). Verify no
other spawn-implying wording for `keeper plan` remains in the help block.

## Acceptance

- [ ] cli/keeper.ts:63 help line no longer claims `keeper plan` execs/spawns planctl
- [ ] Wording reflects in-process dispatch
- [ ] `keeper --help` output renders the corrected line

## Done summary

## Evidence

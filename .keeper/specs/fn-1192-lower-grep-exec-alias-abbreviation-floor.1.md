## Description

Fixes finding F1 (with its merged test-gap finding F2). At the source epic's
commit aa2d1a3f, `isOpenFilesInPagerAbbrev` in
`plugins/keeper/plugin/hooks/escalation-guard.ts` (lines 490-496) gates on
`flag.length >= "--open".length` — a 6-char floor. Git's minimum unambiguous
prefix for `--open-files-in-pager` is `--op` (4 chars): among git grep's
`--o*` options (`--only-matching`, `--open-files-in-pager`, `--or`), `--op`
uniquely resolves to the exec alias. Verified empirically (git 2.50.1):
`git grep --op=/tmp/x TODO` and `--ope=/tmp/x TODO` both hit
`fatal: cannot exec '/tmp/x'` (exec attempted), while `--o=` is rejected as
`ambiguous option`. The 6-char floor lets the 4- and 5-char prefixes through:
the abbreviation branch fails the length check, `--output` doesn't match, and
the `-O` regex requires a capital `O`. So the command is ALLOWED for the
diagnosis role and git execs the caller-named program.

Lower the floor to git's true minimum. The fail-closed choice is to match any
prefix down to `--o` (over-blocking benign `--or`/`--only-matching` is a
harmless false-positive for a security deny); at minimum set the floor to
`"--op".length`. Correct the predicate's doc-comment in the same edit — its
claim that every prefix "at least as long as `--open`" is the exec alias is
the factual source of the off-by-two.

Files:
- `plugins/keeper/plugin/hooks/escalation-guard.ts` — the
  `isOpenFilesInPagerAbbrev` floor and its doc-comment.
- `test/escalation-guard.test.ts` — add the deny-case tests below to the
  existing diagnosis-role deny table (append-only; do not weaken existing
  assertions).

## Acceptance

- [ ] Floor lowered so `git grep --op=<cmd>` and `--ope=<cmd>` are denied.
- [ ] Deny-case tests added for `--op=/tmp/evil` and `--ope=/tmp/evil` in
      both glued-`=` and space-separated forms.
- [ ] Doc-comment corrected to state git's real `--op` minimum, not `--open`.
- [ ] Optional: an allow/boundary note or test for `--o` (git rejects it as
      ambiguous) documenting where the deny stops.
- [ ] `bun test` green.

## Done summary

## Evidence

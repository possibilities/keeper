## Description

**Size:** M
**Files:** src/derivers.ts, test/derivers.test.ts

### Approach

Add `git rm` / `git mv` as a THIRD git dispatch shape in `extractBashMutation`
(NOT members of `GIT_TREE_MUTATORS` — their operands are pathspecs even
without `--`). Mint two new `BashMutation.kind` values `git-rm` and `git-mv`
(widen the union at ~L586/L629-638 + its JSDoc). Collect positional pathspec
tokens via `firstPositional`-style flag-skipping (all git rm/mv flags are
boolean), honor `--`, resolve against cwd via the existing `resolveAgainstCwd`
(no glob expansion — lexical only). `git mv` collects ALL positionals
(source(s) + dest). Bail to `[TREE_SENTINEL]` when `--pathspec-from-file=` is
present or a token carries `:`-pathspec magic. Empty targets after stripping →
return null (mirror the FS_COMMANDS guard at :903).

Separately, fix the tokenizer redirect bug: `tokenizeShell` stops only at
`;|&`, so `2>&1` / `> file` / `2> log` leak as bogus target tokens. Add a
redirect-token filter in the target-collection path (shared by fs-commands AND
the new git arm) that skips a redirect operator AND its operand. This changes
`fs-remove`/`fs-move`/`fs-copy` output too — intentional.

### Investigation targets

**Required** (read before coding):
- src/derivers.ts:831-949 — extractBashMutation; git arm 908-947, FS_COMMANDS
  584-592, BashMutation union 629-638, TREE_SENTINEL 615
- src/derivers.ts:666-740 — tokenizeShell (redirect bug: stops at ;|& only)
- src/derivers.ts:775-789 — firstPositional (flag/`--` skipping to replicate)
- src/derivers.ts:754-766 — resolveAgainstCwd (reuse, no parallel resolver)
- test/derivers.test.ts:17-25 (bashMutation helper), :871-913 (git-tree-mutator
  tests — template for the new cases)

### Risks

- The redirect fix touches every fs-command's targets — historical rows
  re-derive differently (handled by the task-3 backfill). Keep it pure / no
  throw (exit-0 contract).
- Locking the kind strings now is load-bearing — a later rename is another
  schema rewind.

### Test notes

Cover: `git rm a b c`, `git rm -r dir/`, `git rm --cached f`, `git rm '*.ts'`
(quoted glob token preserved verbatim), `git rm --pathspec-from-file=l`
(→TREE_SENTINEL), `git rm -- -weird`, `git mv src dst` (both targets),
`git mv a b destdir/`, redirect termination (`rm x 2>&1` / `git rm x > log`
→ only real paths), `:`-magic bail.

## Acceptance

- [ ] git rm/git mv derive `git-rm`/`git-mv` kinds with cwd-resolved pathspec
  targets; flags and `--` handled; `--pathspec-from-file=`/`:`-magic bail to
  TREE_SENTINEL.
- [ ] Redirect tokens (`2>&1`, `>`, `2>`, `&>`, `N>&M`) never appear as targets
  for git rm/mv OR fs-remove/move/copy.
- [ ] Deriver never throws; empty-target commands return null.
- [ ] New + existing derivers.test.ts pass.

## Done summary

## Evidence

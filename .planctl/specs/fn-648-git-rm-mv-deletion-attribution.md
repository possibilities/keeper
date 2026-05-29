## Overview

Files deleted via `git rm` (and renamed via `git mv`) show as `<orphan>` on
keeper's git surface — agents can't tell who owns them and fall back to manual
ownership. Root cause: `extractBashMutation` only recognizes
`GIT_TREE_MUTATORS = {checkout,restore,stash,reset}`, so `git rm`/`git mv`
derive `bash_mutation_kind=NULL` (no explicit attribution event), and deleted
files have `mtime_ms=null` so the reducer's inference pass is skipped by
design. End state: `git rm`/`git mv` produce attribution events with pathspec
targets, the reducer matches snapshot-known deleted/renamed paths against those
targets (exact + directory-prefix + dependency-free fnmatch), and a schema bump
+ backfill + cursor-rewind re-drain heals history while preserving re-fold
determinism.

## Quick commands

- `bun test test/derivers.test.ts test/reducer.test.ts test/db.test.ts`
- Manual: `git rm <file>` in a watched repo → keeper-git shows the file
  attributed to the running session, not `<orphan>`.

## Acceptance

- [ ] `git rm a b c`, `git rm -r dir/`, `git mv src dst` produce attribution
  (no `<orphan>`) for the affected dirty files.
- [ ] The `2>&1` / `>file` redirect-token bug no longer pollutes
  `bash_mutation_targets` for any fs-command.
- [ ] Schema bump + backfill + rewind: a from-scratch re-fold reproduces the
  same (healed) projections byte-identically.
- [ ] `__TREE__` sentinel never prefix/glob-matches a real file.
- [ ] No third-party import enters the hook's graph (fnmatch hand-rolled,
  reducer-side only).

## Early proof point

Task that proves the approach: `.1` (deriver recognizes git rm/mv + redirect
fix). If it fails: the parsing contract is wrong; reassess flag/`--`/redirect
handling before building the reducer match.

## References

- Confirmed via live event 130514 (`git rm apps/jobctl/...` → kind NULL).
- v30→v31 backfill+rewind precedent: src/db.ts:3313-3446.
- Codex design review chat ec7f2ed2.

## Docs gaps

- **CLAUDE.md**: deriver column list (~L161), bash-mutation gating invariant
  (L161-175), schema-migration/backfill contract (~L258) — add the new kinds +
  v38 backfill; prune-don't-append.
- **README.md**: ## Architecture bash_mutation paragraph (L657-680) — weave in
  the three reducer match modes; schema-version tail.
- **src/derivers.ts** BashMutation JSDoc (L617-638) — new kinds + delete-vs-
  rename target semantics. **src/reducer.ts** findExplicitAttributions JSDoc
  (L1155-1171) — three match modes.

## Best practices

- **Hand-roll fnmatch, no deps:** the hook forbids third-party imports and
  picomatch is only transitive via @parcel/watcher — `*`→`[^/]*` (never `.*`,
  which crosses `/`), `?`→`[^/]`, escape regex metachars except `*`/`?`, anchor
  `^$`, cache compiled RegExp in a Map, no `**`/nested quantifiers (ReDoS-safe).
- **git rm flags are all boolean** (`-r -f -n --cached --ignore-unmatch …`);
  `--pathspec-from-file=` is a glued single token → bail to TREE_SENTINEL
  (reading the file is forbidden hook I/O). `:`-magic pathspecs → strip/bail.
- **Redirect fix has blast radius:** terminating at redirect tokens also fixes
  existing `fs-remove`/`fs-move`/`fs-copy` derivation — the backfill re-derives
  ALL of them; test `rm x > log` / `cp a b 2>&1`.

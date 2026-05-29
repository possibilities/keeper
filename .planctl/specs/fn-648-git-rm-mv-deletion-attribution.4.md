## Description

**Size:** S
**Files:** CLAUDE.md, README.md, src/derivers.ts, src/reducer.ts

### Approach

Update docs to the final shape, prune-don't-append (integrate into existing
paragraphs, don't tack on). CLAUDE.md: deriver column list (~L161) + the
bash-mutation gating invariant (L161-175) name the new `git-rm`/`git-mv` kinds
and the reducer's three match modes; the schema-migration/backfill contract
(~L258) folds in the v38 backfill+rewind alongside v35/v36/v37 using the
existing "version-guarded so a re-run can't corrupt" phrasing. README.md:
weave the three match modes into the ## Architecture bash_mutation paragraph
(L657-680); add a schema-version sentence only if it can't integrate into the
v31 paragraph. JSDoc: src/derivers.ts BashMutation union (L617-638) — new kinds
+ delete-vs-rename target semantics; src/reducer.ts findExplicitAttributions
(L1155-1171) — three match modes.

### Investigation targets

**Required** (read before coding):
- CLAUDE.md L161-175, ~L258 (deriver list, invariant, backfill contract)
- README.md L657-680 (## Architecture bash_mutation paragraph)
- src/derivers.ts:617-638 (BashMutation JSDoc), src/reducer.ts:1155-1171
  (findExplicitAttributions JSDoc)

### Test notes

No code; verify the final kind strings + match modes match what tasks 1-2
actually shipped (read the merged code, don't trust this spec verbatim).

## Acceptance

- [ ] CLAUDE.md deriver list, bash-mutation invariant, and backfill contract
  reflect the new kinds + v38 backfill/rewind (prune-don't-append).
- [ ] README ## Architecture describes the three reducer match modes.
- [ ] BashMutation + findExplicitAttributions JSDoc updated to final shape.

## Done summary

## Evidence

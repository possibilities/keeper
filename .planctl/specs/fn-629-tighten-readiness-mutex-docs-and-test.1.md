## Description

Addresses F1, F2, and F3 from the fn-627 audit. All changes are in the two
files touched by the fix commit (ad86496).

**F1 (src/readiness.ts:543-560, 628-643):** The JSDoc above
`applySingleTaskPerEpicMutex` and `applySingleTaskPerRootMutex` still says
"counts ANY non-completed verdict (ready, working, blocked-by-anything)" —
true under the old one-pass algorithm, false under the two-pass refactor.
Rewrite both blocks to describe the two-pass semantics: pass-1 claims only
the four `isLiveWorkOccupant` kinds; pass-2 handles ready/close rows with
ordering tiebreaks.

**F2 (test/readiness.test.ts:1117, :1205):** Both test names say
"non-completed non-ready row STILL claims the slot/root" and inline comments
say "any non-completed verdict". Rename to "live-work blocked row claims the
epic/root slot" and update comments to enumerate the four `isLiveWorkOccupant`
kinds explicitly.

**F3 (test/readiness.test.ts):** Add one negative-control test per mutex:
- Epic mutex: t1 = `dep-on-task`, t2 = `ready` → t2 should remain `ready`
  (the `dep-on-task` row does NOT claim the slot in pass-1).
- Root mutex: e1t1 = `dep-on-task`, e2t1 = `ready` on same root → e2t1
  should remain `ready`.

## Acceptance

- [ ] `applySingleTaskPerEpicMutex` JSDoc no longer says "any non-completed" and describes pass-1 / pass-2 split
- [ ] `applySingleTaskPerRootMutex` JSDoc likewise corrected
- [ ] Test at readiness.test.ts:1117 renamed and comment updated
- [ ] Test at readiness.test.ts:1205 renamed and comment updated
- [ ] New epic-mutex negative-control test: `dep-on-task`-first, `ready`-second → ready wins
- [ ] New root-mutex negative-control test: same scenario across two epics → ready wins
- [ ] All existing readiness tests still pass

## Done summary
Rewrote applySingleTaskPerEpicMutex/applySingleTaskPerRootMutex JSDoc to describe pass-1 (isLiveWorkOccupant whitelist) vs pass-2 (ready tiebreak) semantics; renamed two tests away from 'any non-completed verdict' phrasing and added per-mutex dep-on-task negative-control tests that lock in the narrowed whitelist.
## Evidence

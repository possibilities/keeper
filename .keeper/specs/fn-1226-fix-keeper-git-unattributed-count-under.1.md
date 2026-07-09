## Description

Fixes audit finding F1 (with F3 merged in) from
fn-1224-board-first-frame-stall-hunt.

Evidence path (verified this audit):
- `src/reducer.ts:2187-2207` — pass 4 computes `unattributedToLiveCount` per
  project_dir by folding over the FULL `snapshot.dirty_files` via the complete
  `fileToAttributions` map. It is stamped onto `jobs.git_unattributed_to_live_count`
  (line 2252) but the `git_status` INSERT (`src/reducer.ts:2301-2317`) persists
  `orphaned_count` and NOT this unattributed-to-live count.
- `cli/git.ts:227-251` — because the git_status row carries no unattributed
  scalar, `keeper git` re-derives `unattributedCount` by walking `row.dirty_files`,
  which commit 922bc117 capped at GIT_STATUS_DIRTY_FILES_WIRE_CAP=200. For a
  worktree with >200 dirty files the header undercounts and, since `orphan=`
  reads the exact `row.orphaned_count` (line 220/254), can display the
  impossible `unattributed < orphan`.

Fix: add an `unattributed_to_live_count` column to the `git_status` projection
and stamp the pass-4 scalar (`unattributedToLiveCount`) onto it in the INSERT
at `src/reducer.ts:2301`, then have `cli/git.ts` render that scalar instead of
re-deriving from the capped `row.dirty_files`.

Files:
- `src/reducer.ts` — add the column stamp in projectGitStatus pass 4 / INSERT;
  this is a schema change to the live-only git_status projection, so append one
  SCHEMA_STEPS entry (version-guarded) and re-pin SCHEMA_FINGERPRINT per the
  migrations rules. git_status is live-only (boot-seed re-derives), so no
  deterministic-replay concern.
- `cli/git.ts` — render the new scalar; delete the LIVE_STATES re-derivation
  loop (lines ~227-251) that walks the capped array.
- `test/daemon.test.ts` — the F3 merge: extend the existing "git first-frame"
  regression test's SELECT to also fetch `orphaned_count` and add
  `expect(row.orphaned_count).toBe(N)` (the 6000 attribution-less fixture files
  are all orphans), proving the pass-4 rollup folds from the full snapshot and
  not the capped 200-entry array; add a parallel assertion that the new
  unattributed scalar equals N.

## Acceptance

- [ ] git_status carries an exact `unattributed_to_live_count` scalar stamped
      from the full-snapshot pass-4 count; schema step + fingerprint re-pinned
- [ ] `keeper git` renders `unattributed=` from that scalar; a >200-dirty
      worktree shows unattributed >= orphan, never the impossible inversion
- [ ] The regression test asserts orphaned_count (and the new unattributed
      scalar) equal N, exercising the rollup-from-full-map invariant

## Done summary
git_status now carries an exact unattributed_to_live_count scalar (SCHEMA_STEPS v118) stamped from the reducer's pass-4 full-snapshot rollup; keeper git renders it directly instead of re-deriving from the wire-capped dirty_files[] mirror, fixing the impossible unattributed < orphan display on >200-dirty worktrees. Hardened the daemon.test.ts git first-frame regression to assert orphaned_count and the new scalar both equal N.
## Evidence

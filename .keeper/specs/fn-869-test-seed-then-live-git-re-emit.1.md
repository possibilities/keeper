## Description

From audit finding F5 (report.md Test Gaps). The git-boot-seed.ts module
header claims the live git-worker's first emit after the boot-seed is a
benign/idempotent re-confirm, but no test drives it. Evidence path: the
boot-seed populates git_status + file_attributions + the 3 jobs git-counters
for currently-dirty files (seedGitProjection / insertSyntheticGitSnapshot in
src/git-boot-seed.ts:187), then the live git-worker emits a GitSnapshot above
the skip-floor for the same root. Drive that exact sequence on an identical
dirty set and assert the surface is unchanged by the re-emit — so a future
non-idempotent regression in the live fold is caught.

## Acceptance

- [ ] Test seeds a dirty root, then folds a live GitSnapshot for the same
      root above the floor, and asserts git_status, file_attributions, and the
      3 jobs git-counters are byte-identical before vs after the re-emit.

## Done summary

## Evidence

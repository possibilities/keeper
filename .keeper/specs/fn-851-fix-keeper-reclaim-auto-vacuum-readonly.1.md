## Description

**Size:** S
**Files:** src/backup.ts (reclaimDb VACUUM INTO + auto_vacuum logic), test/backup.test.ts

### Approach

In reclaimDb, the source is opened read-only; do NOT issue `PRAGMA auto_vacuum=...`
against it. VACUUM INTO already copies the source's auto_vacuum mode to the output, and
the source is `auto_vacuum=2`, so the output inherits INCREMENTAL with no bake needed.
Either drop the explicit bake entirely (rely on inheritance + assert the output's
auto_vacuum==2 in the self-verify), or if a bake is ever needed apply it on a WRITE
connection to the OUTPUT file after VACUUM INTO — never the read-only source. Extend the
test to exercise the real read-only-source path so the readonly error is caught.

### Investigation targets

**Required** (read before coding):
- src/backup.ts — reclaimDb: the read-only source open + the VACUUM INTO + the auto_vacuum bake that throws
- test/backup.test.ts — the fn-850 run() coverage; make its source read-only-opened like production

### Test notes

- reclaim against a read-only-opened source with auto_vacuum=2 succeeds; output is auto_vacuum=2; row counts identical; `bun run test:full`.

## Acceptance

- [ ] reclaim completes with no readonly error; output auto_vacuum=2 via inheritance (no read-only-source write); regression test on the real path; test:full green

## Done summary
reclaimDb no longer bakes auto_vacuum on the read-only source (the cause of 'attempt to write a readonly database' on the live auto_vacuum=2 DB); the VACUUM INTO output inherits INCREMENTAL and the self-verify gate asserts it. Reclaim/backup tests now drive a faithful auto_vacuum=2 read-only source so the regression is pinned. Full suite green.
## Evidence

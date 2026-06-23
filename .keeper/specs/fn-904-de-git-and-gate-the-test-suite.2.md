## Description

**Size:** M
**Files:** src/git-worker.ts, test/git-worker.test.ts, test/git.test.ts, test/git-wrapper.test.ts

### Approach

Make the git-worker tests run with ZERO real git by extracting pure seams
and feeding them synthetic inputs — production call paths keep their
impure helpers so behavior is byte-identical. Two extractions: (1) a pure
`enumerateCommitsFromLog(rawZ)` split out of `enumerateCommitsInDelta`
(which itself spawns `gitOutput`), mirroring the already-pure
`parsePorcelainV2`; the test feeds golden `git log -z` strings. (2) a pure
`buildGitSnapshotFrom(parsed, oidMap, mtimeMap)` extracted from
`buildGitSnapshot` (whose impurity is `batchHashObjectOids` + `lstatMtimeMs`);
the producer call site keeps calling the two impure helpers then the pure
builder, so the emitted snapshot is unchanged. Rewrite the tests to drive
the pure functions with the existing `snap()`/`dirtyFile()` synthetic
`GitSnapshotPayload` factory and synthetic raw porcelain. CRITICAL: capture
every golden fixture (`git log -z`, porcelain v2) from REAL git ONCE
(commit them as fixture strings) — never hand-author them, or the stride
parser validates against a fabrication. Mind the `-z` rename field-order
reversal (`R100 new\0old`). `test/git.test.ts` tests pure UI
(`renderRowBlocks`) despite its name — verify it is already git-free and
leave it. `git-wrapper.test.ts` exercises the wrapper — de-git or
slow-quarantine per what it actually asserts.

### Investigation targets

**Required** (read before coding):
- src/git-worker.ts:399 (`parsePorcelainV2`, the pure-split template), :515 (`gitOutput`), :939 (`enumerateCommitsInDelta`), :1484 (`batchHashObjectOids`), :1537 (`lstatMtimeMs`), :1564 (`buildGitSnapshot`), :134 (`GitSnapshotPayload`), :94 (`GitDirtyFile`)
- test/git-worker.test.ts:60-73 (synthetic porcelain test), :2790 (`dirtyFile`), :2808 (`snap()` factory), :1240-1300 (the `interpret-trailers` golden-commit builder to replace with captured goldens)

**Optional** (reference as needed):
- test/helpers/git-repo.ts — `initRepo` usage to remove from this file

### Risks

- `enumerateCommitsInDelta`'s `%(trailers)` format-agreement is no longer
  checked by anything once synthetic — accepted (Pantera). Capture the
  goldens from real git so the parser is at least validated against a real
  sample at authoring time.
- OVERLAP with fn-889 on `src/git-worker.ts` — the epic dep sequences this
  after fn-889; rebase onto its changes.

### Test notes

Production `emitSnapshot` keeps the two impure calls; assert the pure
builder's output equals the old path for one captured real fixture, then
drive all other cases synthetically.

## Acceptance

- [ ] `enumerateCommitsFromLog(rawZ)` and `buildGitSnapshotFrom(parsed,oidMap,mtimeMap)` are pure, exported, and unit-tested with captured goldens / synthetic payloads
- [ ] Production snapshot/enumeration behavior is byte-identical (impure helpers still called at the producer call site)
- [ ] test/git-worker.test.ts invokes zero real git; git-wrapper/git tests are git-free or slow-quarantined
- [ ] Golden fixtures are captured-from-real-git strings, not hand-authored

## Done summary
Extracted pure enumerateCommitsFromLog/buildGitSnapshotFrom/parseCommitFiles seams (production byte-identical via impure-wrapper delegation), rewrote test/git-worker.test.ts to drive them with synthetic payloads + captured-from-real-git goldens, and slow-quarantined the genuinely git-coupled tests. test/git-worker.test.ts + git.test.ts now invoke zero real git.
## Evidence

## Description

**Size:** M
**Files:** src/commit-work/private-index.ts, cli/commit-work.ts, test/commit-work.test.ts

### Approach

The publication baseline exists to detect a concurrent worktree mutation racing the
publication compare-and-swap; it does not need the raw bytes of every ignored file to do
that. Restructure the fingerprint so its cost scales with the SELECTED surface rather than
the whole worktree — candidate shapes, worker's judgment which composes: exclude ignored
paths from the raw-read set (status identity alone covers them), fingerprint oversized
paths by stable index metadata (size/mtime/inode) instead of content, or degrade past the
byte budget to a status-only baseline with an audited envelope note. Whatever shape lands,
the invariant to preserve is: a mutation of a SELECTED path between freeze and publish must
still fail the CAS. Separately, the CLI catch that maps a non-`PrivateIndexError` throw to
`stage_failed` must surface `error.message` in the envelope (`stderr_sample` or a new
`detail` field), so a snapshot failure is never a bare `stage_failed` again.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/commit-work/private-index.ts:1334 — rawPathSetFingerprint cumulative cap throw (plain Error, three throw sites)
- src/commit-work/private-index.ts:1459 — worktreeSnapshot builds the path set from status --untracked-files=all --ignored=traditional
- src/commit-work/private-index.ts:2064 — refreshFrozenPublicationBaseline call chain from createFrozenPrivateIndex:744
- cli/commit-work.ts:1610 — the catch that collapses non-typed throws to bare stage_failed (typed?.code ?? "stage_failed")

**Optional** (reference as needed):
- src/commit-work/private-index.ts:666 — requireExactStagedSet shows the typed-error-with-paths pattern to mirror
- test/commit-work.test.ts — existing frozen-index test seams (pure GitRunner injection, no real git needed)

### Risks

- The baseline's race-detection contract is load-bearing for the CAS publish; weakening it for
  unselected ignored paths must not open a window for a selected-path mutation to slip through.
- `excludeRuntimePaths` already filters some paths from one snapshot variant — understand why the
  ignored set is deliberately included today (the whole-worktree `wholeRaw` variant) before excluding.

### Test notes

Deterministic, in-process, through the PrivateIndexFs / GitRunner seams: a fake status feed with a
multi-GiB ignored file must produce a successful freeze; an injected snapshot failure must surface
its message in the envelope. No real git, per test doctrine.

## Acceptance

- [ ] createFrozenPrivateIndex succeeds when unselected ignored/untracked content exceeds the byte budget
- [ ] a mutation of a selected path between freeze and publish still fails the publication CAS
- [ ] a snapshot-path throw reaches the commit-work envelope with its message, never bare stage_failed
- [ ] named commit-work gates green

## Done summary

## Evidence

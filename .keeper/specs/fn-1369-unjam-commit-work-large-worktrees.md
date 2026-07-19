## Overview

`keeper commit-work` fails with a bare `stage_failed` in any repo whose untracked-plus-ignored
content exceeds 1 GiB: the publication-baseline snapshot enumerates every untracked AND ignored
file (`--untracked-files=all --ignored=traditional`) and raw-reads their bytes into a fingerprint
capped at `MAX_WORKTREE_SNAPSHOT_BYTES` (1 GiB), throwing a plain `Error` the CLI collapses into
an envelope with no message. Reproduced deterministically against a faithful arthack clone
(3.4 GiB worktree, node_modules 1.1 GiB): `createFrozenPrivateIndex` → `refreshFrozenPublicationBaseline`
→ `worktreeSnapshot` → `rawPathSetFingerprint` throws `worktree snapshot exceeds 1073741824 bytes`.
End state: commit-work commits normally in large-ignored-content repos, and any snapshot failure
envelope names the underlying error.

## Quick commands

- `bun <scratch>/repro-55.ts <big-repo>` — the direct `createFrozenPrivateIndex` driver must succeed against a worktree with >1 GiB of ignored content.

## Acceptance

- [ ] commit-work succeeds in a repo whose ignored/untracked content exceeds 1 GiB
- [ ] a snapshot-path failure envelope carries the underlying error message, never a bare `stage_failed`

## Early proof point

Task that proves the approach: `.1`. If it fails: land the envelope-opacity fix alone and raise the cap as an interim.

## References

- ~/docs/keeper-phase2-backlog.md item #55 (live evidence: fn-2.1 six bare stage_failed envelopes 07-19 02:1x, events 5408362-5408406)

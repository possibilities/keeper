## Overview

Add the one missing coverage on the live-only git surface: the git-worker's
first post-seed emit must be a benign idempotent re-confirm of the same dirty
set. The boot-seed-then-live-worker sequence is the production path on every
git-enabled boot, and the whole live-only design's correctness rests on that
re-emit not double-counting or drifting the surface. Today this is asserted by
reasoning in the git-boot-seed.ts header, not pinned by a test.

## Acceptance

- [ ] A test drives boot-seed then a live git fold on the SAME dirty set and
      asserts git_status, file_attributions, and the 3 jobs git-counters are
      unchanged by the re-emit.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | readGitProjectionSeedRequired is a producer mid-flight latch; daemon always re-seeds (correct/simpler) and the orienting doc-comments already exist (db.ts:1248, daemon.ts:1421). |
| F2 | culled | — | Hand-mirrored null-bindings in insertSyntheticGitSnapshot match the standard event-insert pattern; refactor is gated on a hypothetical second minter. |
| F3 | culled | — | Test budget ~2.2:1 overage is the auditor's own justified, no-action-needed call. |
| F4 | culled | — | Daemon want(git) boot-ordering guard is a one-line gate already exercised by the startDaemon integration tier; no user-observable gap. |
| F5 | kept | .1 | No test pins seed-then-live-reemit idempotency on an identical dirty set, the invariant the live-only design rests on. |

## Out of scope

- F1/F2/F4 code-cleanup and integration-wiring suggestions — culled at audit.
- Any change to the live-only git fold or boot-seed behavior; this is test-only.

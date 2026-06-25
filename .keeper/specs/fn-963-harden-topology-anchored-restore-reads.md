## Overview

The topology-anchored crash-restore deriver shipped two read-path rough edges
that survived audit. First, the dying-generation snapshot scan loads every
retained TmuxTopologySnapshot row+body into memory now that retention keeps
those rows unconditionally, so the read grows without bound over the DB's
lifetime. Second, the pane-to-job projection join is recycle-guarded on
(generation_id, pane_id) but only implicitly tested, leaving the central
%N-recycle defense unpinned. Both harden the same restore read path in
src/restore-set.ts.

## Acceptance

- [ ] The dying-generation snapshot scan no longer loads the full snapshot
      history into memory; it is bounded near the DESC head.
- [ ] A test proves resolvePaneJobId does NOT resolve a job whose pane_id is
      recycled under a different generation.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept   | .1 | src/restore-set.ts:686-688 unbounded `.all()` over TmuxTopologySnapshot; compaction.ts:201 keep is now unconditional so rows accumulate forever. |
| F2 | culled | —  | probeNow seam wiring is correct per the report; a confirmation, not a defect. |
| F3 | culled | —  | test-quality nitpick on passing tests (visible main()-flow duplication); style preference, fine to ship. |
| F4 | culled | —  | malformed-table catch is a theoretical edge; daemon-down read path already covered. |
| F5 | kept   | .2 | src/restore-set.ts:739-758 keys on (generation_id, pane_id) to guard %N recycling, but no test pins it. |
| F6 | culled | —  | 3.4:1 test ratio is advisory; report self-resolves it as the right side to err on. |
| F7 | culled | —  | restore-worker.test.ts assertions were strengthened not weakened; no outstanding defect. |

## Out of scope

- A generation-aware "last N" snapshot prune (would need a new indexed
  generation_id column) — deferred per compaction.ts's own keep-predicate note,
  only if accumulation is ever observed; this epic bounds the READ, not retention.
- Collapsing the --apply gate tests into the unit tests (F3) and the
  malformed-table catch test (F4) — culled as low-value.

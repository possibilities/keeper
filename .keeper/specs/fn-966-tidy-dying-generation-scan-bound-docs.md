## Overview

The topology-anchored restore read now bounds the dying-generation snapshot
scan with a DESC-head LIMIT 256. Three loose ends survived audit: the bound's
doc-comment asserts a false "never truncated" invariant, a test carries a
banned fn-id provenance tag, and the truncation edge itself is untested. This
follow-up corrects the comment to match the real labeled-fallback failure
mode, scrubs the provenance tag, and pins the boundary behavior — a docs +
test-coverage tidy-up on the bound the parent epic shipped.

## Acceptance

- [ ] The DYING_GENERATION_SCAN_LIMIT comment describes the bound as a heuristic whose breach demotes to the labeled fallback, not an exact "never truncated" guarantee.
- [ ] The recycle-guard test comment carries no fn-id provenance shorthand and reads forward-facing.
- [ ] A test pins that seeding DYING_GENERATION_SCAN_LIMIT + 1 G_now snapshots ahead of the dying generation fires the labeled fallbackNote.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | restore-set.ts:172-176 asserts "never truncated" but restore-set.ts:613-621 demotes to a labeled fallback; correct the false invariant (the speculative warning/counter half was culled as deferred, no user impact). |
| F2 | kept | .1 | test/restore-set.test.ts:1013 "// F5 regression pin:" is past-tense fn-id provenance banned by CLAUDE.md rule #0. |
| F3 | kept | .1 | No test pins the LIMIT-truncation boundary (restore-set.ts:613-621 fallback branch); the epic's headline bound is untested at its edge. |

## Out of scope

- Per-generation snapshot pruning / retention change — explicitly deferred upstream (compaction.ts:197-199, "only if accumulation is ever observed").
- A warning/counter emitted when the scan window fills — speculative observability for a deferred concern; the fallback is already fail-visible.

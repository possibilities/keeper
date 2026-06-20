## Overview

fn-635 added three dep-pill render shapes to the board (`?#N` dangling, `#N` intra-project, `prefix::#N` cross-project) but the `renderEpicBlock` glue at `scripts/board.ts:785-799` has no direct assertions. This epic adds targeted tests covering all three shapes, closing the only coverage gap on the user-visible surface of the cross-project dep feature.

## Acceptance

- [ ] Three assertions covering the dangling, intra-project, and cross-project pill shapes produced by the assembly at board.ts:785-799
- [ ] Tests pass under the existing test runner without structural changes to the test suite

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F4 | kept | .1 | Board pill assembly (dangling/intra-project/cross-project shapes) is the user-visible face of fn-635 and has zero direct coverage |
| F1 | culled | — | Closed epics remain on disk and in the keeper snapshot after close; absent-from-snapshot only fires for genuinely unconfigured project roots — an intentional, honest signal |

## Out of scope

- Coverage for the `consumerEpic === undefined` defensive fallback (board.ts:768) — non-destructive escape hatch unlikely to fire in practice
- Refactoring the `renderEpicBlock` signature (dead `epicIds` param cleanup deferred to a future touch)

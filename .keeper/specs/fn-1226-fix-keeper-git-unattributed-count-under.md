## Overview

The dirty_files wire cap (GIT_STATUS_DIRTY_FILES_WIRE_CAP=200) bounds the
MATERIALIZED git_status.dirty_files array, but `keeper git` still re-derives its
`unattributed=` header by walking that now-capped array while the sibling
`orphan=` reads the exact `orphaned_count` scalar. On a worktree with >200 dirty
files the header undercounts unattributed and can render the logically-impossible
`unattributed < orphan` (orphans are a strict subset of unattributed-to-live) --
precisely on the heavily-dirty worktree the operator is using `keeper git` to
diagnose. The reducer already computes the exact project-wide count in pass 4; it
is just never persisted onto the git_status row. Stamp it and render it, and
harden the regression test to assert scalar exactness folds from the full
snapshot rather than the capped array.

## Acceptance

- [ ] `keeper git` renders `unattributed=` from an exact reducer scalar, never
      the capped array, so a >200-dirty worktree never shows unattributed < orphan
- [ ] The regression test asserts a scalar (orphaned_count) that folds from the
      FULL snapshot equals the true count, guarding the exactness invariant

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | cli/git.ts:234-251 re-derives unattributed= from the capped row.dirty_files while orphan= reads the exact scalar; the reducer computes the value (src/reducer.ts:2188,2206) but never stamps it onto git_status, so a >200-dirty worktree shows an impossible unattributed < orphan |
| F2 | culled | — | Theoretical: the aggregate frame only re-crosses 1 MiB at ~20+ simultaneously heavily-dirty worktrees; single-worktree stall is fixed and the remedy is a doc softening — below the keep bar |
| F3 | merged-into-F1 | .1 | F3 folds into F1: the regression SELECT omits orphaned_count and only asserts the trivial dirty_count scalar, never exercising the pass-4 rollup-from-full-map invariant F1 also relies on; the exactness assertion lands in F1's commit |

## Out of scope

- Bounding the aggregate `git` NDJSON frame at the serve path (F2, culled — theoretical board-scale tail risk, not the observed stall)
- Softening the GIT_STATUS_DIRTY_FILES_WIRE_CAP doc-block claim (F2, culled)

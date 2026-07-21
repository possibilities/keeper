Close-finalize currently merges an epic base into the default branch in the
SHARED checkout and refuses with TRUNK_INTEGRATION_DIRTY when the checkout
carries ANY dirt, related or not (backlog #96, mike-directed HIGH; ADR 0102).
Adopt the operator-proven private-worktree pattern inside finalize itself:
merge and gate in a scratch worktree cut from the default tip, push the
result, and let the shared checkout only ever fast-forward when it is clean —
deferring just the ff, never the integration. Evidence:
plugins/plan/src/verbs/close_finalize.ts:812-825 (whole-repo dirt probe →
TRUNK_INTEGRATION_DIRTY), :747 integrateRepoUnderLease requires HEAD on the
default branch, :886 merges sourceOid in place, :972 integrateEpicBases.

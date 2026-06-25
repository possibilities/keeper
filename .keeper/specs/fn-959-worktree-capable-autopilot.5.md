## Description

**Size:** S
**Files:** src/readiness.ts, test/readiness*.test.ts

### Approach

Re-key the per-root allocator so that, in worktree mode, the root key becomes
the derived worktree/lane path instead of `effectiveRoot(target_repo,
project_dir)` — making each worktree a CAP-1 lane (two agents in one worktree
index = corruption). This must land as a parameter to fn-954's round-robin
allocator (it rewrites this exact ~260-line block), NOT a parallel structure,
and must change BOTH the readiness mutex key (:1487-1495) AND the symmetric
dispatch-side resolver (:618-638) so gate and dispatch never diverge. When
worktree mode is OFF the key is unchanged (byte-identical).

### Investigation targets

**Required** (read before coding):
- fn-954 spec + its allocator design (round-robin per-root, max_concurrent_per_root, N=1 byte-identical) — the surface this parameterizes.
- src/readiness.ts:1487-1495 (effectiveRoot mutex key), :618-638 (symmetric dispatch resolver), :1133-1403 (the allocator block fn-954 rewrites).
- src/worktree-plan.ts (this epic, task .2) — the lane/worktree-path derivation.

### Risks

- High merge-conflict risk with fn-954 in the same block — depend on fn-954 and compose as its parameter; do not fork the allocator.
- The lane re-key must force cap-1 per worktree regardless of fn-954's `max_concurrent_per_root` (a lane is never N>1).
- Symmetric change required at both sites or the mutex desyncs from dispatch.

### Test notes

Readiness unit tests: worktree-OFF byte-identical to today; worktree-ON each lane caps at 1 even when max_concurrent_per_root>1; parallel sibling lanes in one repo run concurrently (the whole point).

## Acceptance

- [ ] In worktree mode the allocator keys on the lane/worktree path; each worktree is cap-1; parallel siblings run concurrently.
- [ ] OFF mode is byte-identical to today's mutex behavior.
- [ ] Both the readiness key and the dispatch-side resolver are re-keyed symmetrically; composes as a parameter to fn-954's allocator.

## Done summary
Re-keyed the per-root allocator on derived lane worktree paths in worktree mode (cap-1 per lane, parallel siblings concurrent) as a parameter to fn-954's round-robin allocator; OFF mode byte-identical, gate and dispatch-side resolver both derive lanes off the same deriveWorktreePlan.
## Evidence

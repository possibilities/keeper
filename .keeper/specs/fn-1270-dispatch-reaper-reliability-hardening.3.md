## Description

**Size:** S
**Files:** src/readiness.ts, src/reconcile-core.ts, src/db.ts, test/readiness.test.ts

### Approach

Flip the worktree-mode branch of applyPerRootRoundRobinAllocator to honor the stored
max_concurrent_per_root while worktree mode is ON — N distinct lanes of one root may run
concurrently, each lane itself staying cap-1 — and floor to one when worktree mode is OFF,
exactly as CONTEXT.md's Per-root cap entry specifies (the glossary is the spec; today's
code is the inverse). Verify the round-robin fill groups by true ROOT (rootKeyForRow),
not by lane, when lanes are present. Delete the stale "hardcoded N=1 / carried but
unconsumed" comments in reconcile-core. Add a modest sanity clamp on the stored N at the
read-time effective-cap seam (a fat-fingered set_autopilot_config must not flood
dispatch). No schema change — the column and RPC patch field already exist.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/readiness.ts:1746 — the worktree-ON cap-1 forcing branch (the real defect); :1776 the N>1 round-robin fill; :1730 the allocator entry
- src/readiness.ts:1376 — isRootOccupant/isLiveWorkOccupant (shared predicate; global-cap accounting at reconcile-core.ts:2067 loops it, so no drift if unforked)
- src/db.ts:4532 — effectivePerRootCap (read-time derivation; clamp lands here)
- src/reconcile-core.ts:844 and :1131 — the stale N=1 comments to delete

**Optional** (reference as needed):
- test/readiness.test.ts:2061 — the fn-954 allocator suite (N=2/N=3 already tested for the non-worktree path)

### Risks

- Raising effective concurrency un-serializes shared-checkout git ops and SQLite writes the
  accidental cap-1 hid — the code change is small, but note the operational ramp guidance
  (ADR 0052 consequences); do not add locking here.
- N-per-lane instead of N-per-root would be a silent mis-fix — the grouping test is the guard.

### Test notes

fn-954-suite additions: worktree ON + N=2 → two distinct lanes of one root allocated, third
defers; each lane still cap-1; worktree OFF → floor-to-one regardless of stored N; clamp
caps an absurd stored N.

## Acceptance

- [ ] With worktree mode ON and stored cap 2, the allocator admits two distinct lanes of one root concurrently and defers the third; each lane stays cap-1
- [ ] With worktree mode OFF the effective cap floors to one regardless of the stored value
- [ ] The stored N is sanity-clamped at read time and the stale N=1 comments are gone
- [ ] fn-954 allocator suite extended and green; no shared predicate forked

## Done summary

## Evidence

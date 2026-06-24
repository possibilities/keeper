## Description

**Size:** M
**Files:** src/readiness.ts, src/autopilot-worker.ts, README.md, CLAUDE.md, test/readiness.test.ts, test/autopilot-worker.test.ts, test/autopilot.test.ts, test/board.test.ts

### Approach

Replace the two independent post-pass mutexes (applySingleTaskPerEpicMutex +
applySingleTaskPerRootMutex) with ONE per-root round-robin allocator reading N
(`max_concurrent_per_root`, threaded via task .1) as a trailing-optional param of
`computeReadiness` (default 1 = byte-identical). Per root: seed a per-root counter
AND a per-(root,epic) counter from existing occupancy (every `isRootOccupant` task,
the scoped close-row claim, and `fallbackRoots`), then fill the remaining `N −
occupied` slots round-robin over the root's epics in `orderEpicsForScheduling` seam
order — round 1 grants each epic its next ready task a slot, round 2 a second, etc.,
so an epic stacks a 2nd task only after every sibling epic with ready work has one.
Demote losers, attributing the reason by cause: epic already at its fair share →
`single-task-per-epic`; root full → `single-task-per-root` (keep both kind names).
Preserve the armed eligible two-pass (eligible ≫ started ≫ creation ≫ round-robin)
and the close-row eligibility gate (fn-835). Pure + deterministic: no cross-tick
cursor, `epic_id` final tiebreak. Hard-categorical prefer-started (fn-949) orders
the walk; no anti-starvation guard.

### Investigation targets

**Required** (read before coding):
- src/readiness.ts:533-541 — the two-mutex call site (replace both); :1145-1184 applySingleTaskPerEpicMutex (folded in); :1216-1403 applySingleTaskPerRootMutex (occupiedRoots Set → per-root + per-(root,epic) counters; settleTask/settleCloseRow; pass-1 occupancy seeding incl. fallbackRoots :518-527; armed two-pass :1369-1402).
- src/readiness.ts:1133-1143 isRootOccupant / isLiveWorkOccupant (occupancy predicate covering running + dispatch-pending + bound-pending) — the allocator counts these as pre-consumed slots, granting max(0, fairShare − running).
- src/readiness.ts:100 orderEpicsForScheduling (canonical group order, fn-949) + the per-row reason attribution comment (~:529-532, per-epic-first).
- src/autopilot-worker.ts:1028-1041 — the global maxConcurrentJobs budget walk; confirm it stays an AND (demoted rows never reach it as ready), no per-root double-count.
- test/readiness.test.ts mutex suites — makeTask/makeEpic/blocked/sharedRootPair(:1248)/runWithEligible(:1234); the N=1-equivalence test goes alongside the single-pass suites, round-robin/occupancy tests after the eligibility suite (extend sharedRootPair to N>1, 2+ ready tasks/epic).

### Risks

- N=1 byte-identity is the contract — same demotions, same reason attribution (per-epic-first), same armed two-pass + close-row gate as today's two-Set passes. The equivalence test is the gate.
- Occupancy seeding (the practice-scout "bonus round" bug): an epic with 2 running must count those 2 as consumed, not be offered 2 more. Seed running+pending in BOTH per-root and per-(root,epic) counters symmetrically.
- Determinism: start from the highest-priority epic each tick (no carried cursor); unique `epic_id` tiebreak; the allocator is a pure function of (seam order, ready counts, occupancy, N).
- Block-reason kind names kept (rename would ripple to await-conditions.ts:196 + the exhaustive switch + every blocked({kind}) test); the README/CLAUDE prose calling it a "mutex"/"single per-root slot" goes stale → update to "N-slot allocator / round-robin".
- Alloc loop must terminate on exhausted ready work (guard N≥1 from task .1's config validation).

### Test notes

`bun run test:full` (mandatory — readiness/autopilot/board). Cover: N=1 equivalence (identical to today over the existing fixtures); round-robin spread (N=3, 4 epics → first 3 epics get 1 each in seam order); intra-epic stacking (lone epic, N=3, 3 ready tasks → all 3); occupancy seeding (epic with 1 running + N=2 gets 1 more, not 2); armed composition (eligible+unstarted beats ineligible+started); close-row eligibility gate intact (fn-835); global-cap AND (per-root grant never exceeds the global budget).

## Acceptance

- [ ] The two mutex passes are replaced by one per-root round-robin allocator reading N; pure + deterministic (no cross-tick cursor, `epic_id` tiebreak).
- [ ] Occupancy seeded per-root + per-(root,epic) from running+pending; grants max(0, fairShare − running) — no bonus-round over-allocation.
- [ ] Round-robin fairness: 2nd task per epic only after every sibling epic with ready work has one; lone epic may take multiple slots.
- [ ] N=1 byte-identical: same demotions + per-epic-first reason attribution + armed two-pass + close-row gate as today.
- [ ] Composes under the global `maxConcurrentJobs` cap as an absolute ceiling; block-reason names kept; README/CLAUDE prose updated forward-facing.
- [ ] `bun run test:full` green.

## Done summary

## Evidence

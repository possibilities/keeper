## Overview

Make per-root dispatch concurrency a configurable setting N (default 1) replacing
the hardcoded one-task-per-root mutex, and distribute a root's N slots fairly across
its epics via round-robin (an epic gets a 2nd concurrent task only after every other
epic in the root with ready work has one). Builds on fn-953 (the runtime
`set_autopilot_config` mechanism — `max_concurrent_per_root` is just another column +
patch field) and fn-949 (prefer-started ordering, which orders the round-robin walk).
The allocator is a pure read-time rewrite of the per-epic + per-root mutexes in
`computeReadiness`; N=1 is byte-identical to today. All three readiness consumers
(board, autopilot, viewer) stay consistent — N rides `BootStatus` to the client.

## Quick commands

- `keeper autopilot config max_concurrent_per_root 3` — set it live (via fn-953's RPC).
- `keeper plan board --snapshot` — up to N tasks per root, spread across epics.
- `bun run test:full` — readiness/autopilot/board paths.

## Acceptance

- [ ] `max_concurrent_per_root` is a config column (in-memory default 1) settable at runtime via fn-953's `set_autopilot_config`; rides `BootStatus` so the board computes the same demotions as the reconciler.
- [ ] The per-epic + per-root mutexes are replaced by one per-root round-robin allocator: seed per-root and per-(root,epic) occupancy from in-flight work (running + dispatch-pending + bound-pending + fallbackRoots), then fill remaining slots round-robin in the orderEpicsForScheduling seam order.
- [ ] An epic gets a 2nd concurrent task only after every other epic in the root with ready work has one; a lone epic may take multiple slots.
- [ ] N=1 is byte-identical to today (same demotions + same `single-task-per-epic` vs `single-task-per-root` reason attribution + armed two-pass + close-row eligibility gate).
- [ ] Deterministic total order (no cross-tick cursor; `epic_id` tiebreak); composes under the global `maxConcurrentJobs` budget as an absolute ceiling.
- [ ] `bun run test:full` green.

## Early proof point

Prove the allocator with the N=1-equivalence test FIRST (same fixtures as today's per-epic/per-root mutex suites, asserting identical demotions). If N=1 diverges, the rewrite is unsafe to land regardless of the N>1 behavior.

## References

- Depends on fn-953 (`set_autopilot_config` + `AutopilotConfigSet` + `autopilot_state` — the config surface this setting rides) and fn-949 (orderEpicsForScheduling started-first order — the round-robin walk order).
- Allocator core: src/readiness.ts applySingleTaskPerEpicMutex (~:1145) + applySingleTaskPerRootMutex (~:1216-1403, occupiedRoots Set → per-root + per-(root,epic) counters), the two-mutex call (~:533-534), isRootOccupant occupancy (~:1133), the armed two-pass (~:1369-1402), settleCloseRow.
- Client consistency: thread N onto BootStatus (protocol.ts ~:106, server-worker.ts ~:1967, readiness-client.ts ~:1399/1703) — the proven `unseededRoots` pattern.
- Fair-share: seed occupancy as pre-consumed (grant max(0, fairShare − running)); avoid the bonus-round over-allocation bug.

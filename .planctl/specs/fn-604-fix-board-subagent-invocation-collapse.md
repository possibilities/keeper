## Overview

The board readiness pipeline collapses re-entrant sub-agent invocations
in `subagentInvocations.byId` because the wire descriptor exposes
`pk: "job_id"` over a collection whose composite identity is
`(job_id, agent_id, turn_seq)`. The pure readiness module accepts an
iterable and builds its own `subRunningByJobId` array index correctly,
but the board hands it a collapsed map — so predicate 6
(`own-progress-sub`) can flip `[blocked:sub-agent-running]` to
`[ready]` while a sub-agent is still running. Today the board pill is
informational; future autopilot dispatch will consume the same verdicts,
making the wiring fix load-bearing.

## Acceptance

- [ ] Every `SubagentInvocation` row delivered in a `result` frame
      reaches `computeReadiness`, not just the last-write-wins one per
      `job_id`.
- [ ] A board state with multiple `running` sub-agent invocations on a
      single `job_id` reports `[blocked:sub-agent-running]`, not
      `[ready]`.
- [ ] A regression test pins the multi-invocation-per-job case.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | Confirmed by code read — `src/collections.ts:313` declares `pk: "job_id"`; `scripts/board.ts:687-691` does `state.byId.set(id, row)` last-write-wins; `scripts/board.ts:621` feeds the collapsed map into `computeReadiness`. Author's own comment at `src/collections.ts:295-302` flags the design intent the wiring then breaks. |
| F2 | culled | — | Already fixed on main in commit `247f41a`; no live defect, only a bisect-cleanliness note. |
| F3 | culled | — | `_perCloseRow` naming polish only; no correctness consequence — fix opportunistically on next touch. |
| F4 | culled | — | Forward dep-on-epic ordering is documented inline as intentional; no user impact from the missing test in isolation. |
| F5 | culled | — | Unreachable defensive return at end of `rollupEpicHeader`; no impact. |

## Out of scope

- Autopilot dispatch consuming readiness verdicts — a separate epic.
- F3 rename and F5 dead-code cleanup — opportunistic, not blocking.

## Overview

Close a re-fold determinism coverage gap in the embedded-jobs projection:
the byte-identical re-fold tests never co-populate `epic.jobs` and a child
`task.jobs[*].jobs` on the SAME epic. The realistic regression — a
`syncJobIntoEpic` fan-out branch clobbering the other array — would slip
through today. This adds one targeted reducer test exercising the dual-array
case end-to-end, including survival across `EpicSnapshot` ON CONFLICT.

## Acceptance

- [ ] A reducer test fires both a plan-verb `SessionStart` for an epic and a
      work-verb `SessionStart` for a child task on the same epic, drains,
      and asserts both `epic.jobs` and the task element's `jobs` sub-array
      are populated with the correct job ids.
- [ ] The test fires a subsequent `EpicSnapshot` on the same epic id and
      asserts both arrays survive the ON CONFLICT carve-out byte-identically.
- [ ] `bun test test/reducer.test.ts` passes.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F6     | kept   | .1   | Concrete behavioral gap on the byte-identical re-fold invariant; the existing re-fold test at `test/reducer.test.ts:2177-2244` never co-populates both jobs arrays on a single epic. |
| F4     | culled | —    | Keeper is a single-user dev tool; in-code migration comment at `src/db.ts:697-723` already documents the rewind cost; the empty-projection window is sub-second-to-tens-of-seconds and bounded to a single boot. No realistic operator scenario benefits from an extra log line. |
| F7     | culled | —    | The existing `second openDb is a no-op` test at `test/db.test.ts:147-161` asserts `last_event_id = 42` survives reopen. That cursor survival shares the same `if (storedVersionV11 < 11)` guard with the `DELETE FROM jobs` / `DELETE FROM epics` block, so a guard regression would surface as a cursor reset. Implicit coverage is sufficient. |

## Out of scope

- The four tier-0 findings (SessionStart sync-gating asymmetry, `buildEmbeddedJob` plan_verb coalesce, sort comparator duplication, extra SELECT per write). Routed to tier_0 by the classifier; no surviving-vet outcome.
- Refactor extracting a shared `sortTasksByNumberThenId` helper — deferred until a second drift site materializes.

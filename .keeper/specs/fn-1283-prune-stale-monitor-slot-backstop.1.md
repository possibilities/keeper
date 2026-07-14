## Description

Two comments left inaccurate by fn-1279's symbol churn (both keeper repo):

- F2 (`src/collections.ts:325`): the `DONE_EPICS_REAP_WINDOW_SEC` doc-comment
  says "1800s tracks `MONITOR_RELEASE_SEC` (the hard closer-release ceiling)",
  but fn-1279 deleted `MONITOR_RELEASE_SEC` from `readiness.ts` — this is now
  the only surviving reference in `src/`. Rewrite the sentence to justify the
  1800s window on its own terms (or against a surviving constant such as
  `MONITOR_SLOT_WEDGE_PAGE_SEC`); do not resurrect the deleted symbol.
- F3 (`src/autopilot-worker.ts:8728-8730`): the `provenDeadJobIds` comment
  claims the set is "Empty whenever the pane probe is degraded
  (`livePaneIds === null`)", but the new backstop occupant loop (~8766-8781)
  is NOT gated on `livePaneIds !== null` and can add a dead-pid job under a
  degraded probe. Correct the comment to say the set may be non-empty under a
  degraded probe but is never consumed then (the consumer `computeSlotOccupancy`
  returns early on `livePaneIds === null`).

Evidence path: `git show 4989c025:src/readiness.ts` confirms the
`MONITOR_RELEASE_SEC` deletion; grep confirms collections.ts:325 is the sole
remaining reference; autopilot-worker.ts:8748-8781 shows the ungated new loop.

Files:
- `src/collections.ts`
- `src/autopilot-worker.ts`

## Acceptance

- [ ] `grep MONITOR_RELEASE_SEC src/` returns nothing
- [ ] The `provenDeadJobIds` comment matches the degraded-probe behavior of the new loop
- [ ] No non-comment lines changed; `bun test` stays green

## Done summary
Rewrote the DONE_EPICS_REAP_WINDOW_SEC doc-comment to stop citing the deleted MONITOR_RELEASE_SEC symbol and to drop a false 1800s-vs-MONITOR_SLOT_WEDGE_PAGE_SEC inequality, and corrected the provenDeadJobIds comment to reflect that the backstop occupant loop can populate it under a degraded pane probe even though computeSlotOccupancy never consumes it then. Comment-only; no non-comment lines changed.
## Evidence

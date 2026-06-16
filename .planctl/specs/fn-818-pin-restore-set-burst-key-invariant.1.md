## Description

F1 (auditor Consider + Test Gap #1). The burst heuristic in
`src/restore-set.ts` (`burstEventIds`, ~lines 190-219; consumed at ~297-308)
keys the contiguous-cluster signature on `KilledJobRow.last_event_id`
(declared at ~line 110 as "the Killed event's rowid"). `last_event_id` is a
generic per-row "last fold that touched this row" column. The burst signature
is correct only while no fold writes a killed row after its Killed event —
enforced today by the reducer's terminal guards and the restore-worker's
window-index-cache prune, but asserted nowhere. Add a reducer-level guard test:
kill a job, then feed an unrelated event that would target that row, and assert
the row's `last_event_id` (the burst key) is unchanged so its burst-cluster
position does not move. The existing window-index-survival test covers the
prune path but asserts `window_index`, not the burst rowid — this closes that
specific gap.

## Acceptance

- [ ] A test kills a job, feeds a subsequent unrelated event targeting that
      row, and asserts the row's `last_event_id` burst key is unchanged.
- [ ] The test would fail if a post-kill fold moved the killed row's burst
      position.
- [ ] `bun run test:full` is green.

## Done summary

## Evidence

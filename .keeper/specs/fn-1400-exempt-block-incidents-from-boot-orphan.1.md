## Description

Two loose ends from the `block_escalations` -> `dispatch_failures` collapse:

- **F1 (Critical).** `gcUnretryableDispatchFailures` (`src/daemon.ts:872`,
  boot call site `src/daemon.ts:10296`) SELECTs every `dispatch_failures`
  row with no verb filter and, after ~14 distress-key exemptions, falls
  through to `mintClear` for any non-retryable row. A collapsed block
  incident is a `('block', task_id)` row (`src/reducer.ts:940`, with
  `instance_event_id = blocked_since = event.id`). `isRetryableDispatchKey`
  is false for `block` (`RETRY_DISPATCH_VERBS` = work/close/approve/repair,
  `src/dispatch-command.ts`), and no `is*DistressKey` guard matches the
  `block` verb, so the row reaches `mintClear`; `foldDispatchCleared`'s
  fenced branch (`src/reducer.ts:4248-4253`) then DELETEs it by exact
  `(verb, id, instance_event_id)`. Result: every daemon boot destroys live
  block incidents, the arm fold (not-blocked -> blocked edge only) never
  re-arms a still-blocked task, the page-once `human_notified_at` guarantee
  is lost, and a spurious `DispatchCleared` is baked into the append-only
  log. Fix: add a `verb === 'block'` `continue` exemption in
  `gcUnretryableDispatchFailures`, alongside the existing producer-owned
  exemptions (mirrors the `repair` guard) — block rows are owned by the
  TaskSnapshot arm/clear folds, never the retry wire.

- **F2.** The retained base-schema literal `CREATE_BLOCK_ESCALATIONS`
  (`src/db.ts:6273`) survives ONLY so v142 collapse migration step 1 can
  `SELECT ... FROM block_escalations` on a fresh DB before step 3 drops it,
  but its doc comment still describes it as a live latch projection ("A row
  exists for as long as a plan task is in `runtime_status='blocked'`... The
  producer walks `pending` rows..."), now false. Replace the comment body
  with a one-line note that the literal exists solely for fresh-DB migration
  ordering and is not a live projection.

Files: `src/daemon.ts` (the boot-GC exemption), `test/daemon.test.ts` (the
regression test, alongside the crash-loop / paging-channel / bus-degraded
exemption cases at ~613-716), `src/db.ts` (the `CREATE_BLOCK_ESCALATIONS`
comment).

- **F3 (live witness, post-v142 boot acbd9d03).** The first v142 boot showed
  `needs_human.block_escalations: 1` with ZERO `('block', *)` rows in
  dispatch_failures and zero runtime-blocked tasks - consistent with F1
  having already GC'd a carried-forward block row at boot while a separate
  needs-human counter surface still reports it (or with the counter reading
  a column/surface the collapse left stale). While fixing F1, locate the
  needs-human block count's read path and add a regression asserting the
  count equals the live `('block', *)` row set - a phantom count on the
  needs-human surface is silent operator-facing drift in both directions.

## Acceptance

- [ ] `gcUnretryableDispatchFailures` skips `verb='block'` rows; a seeded
      live block row survives the sweep and mints no `DispatchCleared`.
- [ ] A regression test in `test/daemon.test.ts` seeds a `verb='block'` row
      and asserts it is NOT swept.
- [ ] The `CREATE_BLOCK_ESCALATIONS` comment states the literal exists only
      for fresh-DB migration ordering, not as a live projection.
- [ ] The needs-human block count provably equals the live ('block', *)
      row set (regression covering the F3 phantom-count witness).

## Done summary

## Evidence

## Description

Fixes F1 (with the F3 test gap folded in). Evidence path from the close
audit (commit 8e43ff96):

- `src/await-conditions.ts` — `advanceCompleteStability` restarts the dwell
  on `versionMoved = prev.watermark !== null && version !== null && version
  !== prev.watermark` (ANY move, needed to catch a diffTick-coalesced
  running→completed flap whose UP move a `<`-only check would miss).
- `src/await-conditions.ts` — `completeWatermark` returns
  `hit?.epic.last_event_id` for a task target. The `epics` row re-folds on
  any embedded task/job change (reducer `UPDATE epics SET tasks=?,
  last_event_id=?`), and tasks are an embedded JSON blob with NO per-task
  version column — so benign sibling churn moves the anchor and resets a
  task-complete dwell.

Decide and implement ONE resolution:
(a) Anchor a task target's dwell on a per-task version (e.g. a task-scoped
    last-touched event id folded into the tasks blob and surfaced on the
    subscribe snapshot) so sibling churn no longer registers as a move —
    note this touches the reducer fold and must hold the re-fold-determinism
    and zero-event-projection-default invariants; OR
(b) Consciously accept the epic-settle tradeoff and document it at the
    `advanceCompleteStability` / `completeWatermark` doc blocks and the
    done_summary, since an epic-scoped watermark cannot distinguish a
    coalesced flap from sibling churn.

Files: `src/await-conditions.ts`, `cli/await.ts` (wiring, if the anchor
changes), `test/await-conditions.test.ts`, `test/await.test.ts`; plus the
reducer/projection surface only if path (a) is chosen.

## Acceptance

- [ ] Sibling-task churn in a multi-task epic does not reset a task-complete
      await's dwell (path a), or the epic-settle tradeoff is documented at the
      doc blocks and done_summary (path b).
- [ ] A genuine target-task flap — including a diffTick-coalesced
      running→completed — still restarts the dwell.
- [ ] A new test names the sibling-churn scenario and asserts the intended
      outcome (the F3 gap).
- [ ] `bun test` and the plan suite stay green.

## Done summary
Anchored a task-complete await's dwell on a per-task version: completeWatermark now returns the MAX last_event_id across the target task's own embedded jobs, not the containing epic's last_event_id. Sibling-task churn (which re-folds the shared epic row) no longer resets the dwell, while the target's own worker re-activation (the coalesced running->completed flap) still restarts it. Pure client-side change (data already on the subscribe snapshot) — no reducer/migration touched. Added F3 sibling-churn + target-flap tests at the module and command level.
## Evidence

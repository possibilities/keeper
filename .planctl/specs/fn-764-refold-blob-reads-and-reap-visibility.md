## Overview

Roadmap epic 3 of the 2026-06-09 deep review (state:
~/docs/keeper-reliability/2026-06-09-roadmap-state.md). Two verified defects: the
subagent bridge reads miss the event_blobs COALESCE so a re-fold of a compacted DB
loses ~98% of PreToolUse:Agent bridges (2,700/2,755 already relocated in prod —
silent re-fold nondeterminism, can flip jobs.state via the supersession scan); and
the fn-727 close-row completion reap is structurally unreachable because
loadReconcileSnapshot's epics read applies default_visible=1 (post-fn-756 =
status='open'), so a done epic vanishes at the exact flip evaluateCloseRow needs —
tonight's close-pane cleanup was the pause-edge launch-window reap covering for it.

## Quick commands

- `bun test test/subagent-invocations.test.ts test/compaction.test.ts test/autopilot-worker.test.ts` — relocate-then-assert + real-snapshot reap tests green
- `bun test --parallel --timeout=30000` — full suite green
- Post-deploy: autopilot-close an epic and confirm its close:: pane closes via completion reap (not only on a pause edge)

## Acceptance

- [ ] both bridge reads COALESCE(e.data, b.data) over LEFT JOIN event_blobs (projection only — WHERE stays on indexed scalars); a forced-relocation test (compactColdBlobs recentRetentionMargin:0) proves the bridge resolves and subagent rows re-fold byte-identical
- [ ] reducer.ts:1602-1609 "the ONE non-COALESCE blob read" claim rewritten as an accurate enumeration of every events.data read site and its safety argument
- [ ] a done epic reaches completedRowIds through the REAL loadReconcileSnapshot query path against a seeded DB (no hand-rolled snapshot); the done-epics read is bounded (sort updated_at desc + limit), never O(all-history); done epics in the snapshot produce ONLY completed verdicts (zero new dispatches, no mutex occupancy — test-pinned)
- [ ] no schema bump, no keeper-py change; stale approve::<id> reap prose corrected in CLAUDE.md / README / docs/exec-backend.md

## Early proof point

Task that proves the approach: task 2 (reap visibility). If merging done epics into
the snapshot perturbs any dispatch verdict, stop and switch to the fallback (a
dedicated reap-only done-epics read consumed ONLY by completedRowIds derivation,
never by reconcile's dispatch arms).

## References

- ~/docs/keeper-reliability/2026-06-09-server-deep-review.md (Tier 1 #4-5) + 2026-06-09-roadmap-state.md
- .planctl/specs/fn-717-*.md (blob relocation), fn-727-*.md (completion reap), fn-756-*.md (default_visible change that exposed the gap), fn-748-*.md (the O(all-history) anti-pattern the bounded read must avoid)
- k8s TTL-after-finished (KEP 592) — bounded recently-completed window, level-triggered cleanup, idempotent action; rejected alternatives = exactly the two traps here (all-history scan, edge-triggered one-shot)
- Decision record: level-triggered two-query merge (open default read + filter:{status:"done"} sort updated_at desc limit ~32); grep-lint inventory pin skipped as gold-plating — the relocate-then-assert tests + corrected enumeration comment are the pins

## Docs gaps

- **src/reducer.ts:1602-1609**: false "ONE read" claim → accurate enumeration [task 1]
- **README Architecture**: add the event_blobs COALESCE read-contract paragraph (currently undocumented) [task 1]; completion-reap paragraph notes the snapshot now includes recently-done epics [task 2]
- **CLAUDE.md completion-reap paragraph (~270-279)**: drop the stale approve::<id> pair mention (fn-756), note the done-epics snapshot scope [task 2]
- **docs/exec-backend.md ~192-238**: remove approve::<id> reap references, fix the "pair" framing [task 2]

## Best practices

- **COALESCE the payload column, never the key/filter columns:** wrapping WHERE columns kills index use; relocation never touches indexed scalars [SQLite optoverview]
- **Archive-then-assert:** relocate everything (margin 0) then re-read through the accessor and assert byte-equality — the canonical tiering pin [event-sourcing determinism literature]
- **Bound the completed-set window, requeue-level, idempotent action:** k8s TTL-after-finished; edge-triggered one-shot cleanup leaks on restart; all-history scans are the fn-748 class
- **Never infer cleanup-done from absence in the query set** — the reap remains level-driven while the row is in the bounded window; the action is already idempotent (reapSurfaces)

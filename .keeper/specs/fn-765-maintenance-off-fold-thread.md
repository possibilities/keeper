## Overview

Final Tier-1 epic of the 2026-06-09 deep review (state:
~/docs/keeper-reliability/2026-06-09-roadmap-state.md): move the synchronous DB
maintenance (daily ~2GB VACUUM INTO backup + verify, 15-min integrity quick_check,
fn-753 boot catch-up) off main's fold thread into a dedicated worker — bun:sqlite
calls are synchronous, so they stall folds/ingest for their full duration today,
feeding the fold-lag class everything else this review fixed. Plus: bound zellij
subprocess awaits (a wedged zellij currently freezes the reconciler forever, no
fatalExit), floor the completion-reap probe (post-fn-764 completedRowIds populates
nearly every cycle), and a small DB/boot hygiene pack. Remaining Tier-2 review
items are deliberately deferred — they stay documented in the review doc.

## Quick commands

- `bun test --parallel --timeout=30000` — full suite green
- After deploy+bounce: trigger a backup pass and confirm fold lag stays flat (no SLOW_FOLD lines, board stays live) while the snapshot is written
- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_events_event_type','idx_events_tool_name','idx_events_hook_tool')"` — empty after the bounce

## Acceptance

- [ ] backup interval + fn-753 boot catch-up + integrity-probe interval run in a dedicated worker (own connections, worker contract honored: isMainThread guard, typed messages, supervisor-owned lifecycle, fatalExit on error/close, no in-process respawn); main's fold thread never executes VACUUM INTO or quick_check
- [ ] a hung zellij subprocess can no longer wedge the reconciler: runCapture races a kill-timeout and degrades to the existing null/{ok:false} envelopes, never throws
- [ ] completion-reap list-panes probe floored to a min interval; reap behavior otherwise unchanged
- [ ] consumer-less events indexes dropped (test array updated same commit), boot ANALYZE bounded, server-worker no longer re-runs the migration ladder, shutdown postMessage guarded
- [ ] no schema bump, no keeper-py change, re-fold determinism untouched (nothing here reads/writes projections or the event log)

## Early proof point

Task that proves the approach: task 1 (the maintenance worker). If hosting the
timers worker-side fights the supervisor contract anywhere, fall back to keeping
the timers on main but dispatching each PASS to the worker via a typed message —
the offload is the requirement, not the timer location.

## References

- ~/docs/keeper-reliability/2026-06-09-server-deep-review.md (Tier 1 #7 + Tier 2 autopilot/db) + 2026-06-09-roadmap-state.md
- CLAUDE.md "Worker contract" + "No in-process self-heal" — the lifecycle rules task 1 must honor
- src/wake-worker.ts — the canonical worker template (isMainThread guard :154, own RO openDb :117, typed messages :47-54, shutdown :120-132, exported loop seam :75)
- Decision record: SpawnFn gains kill() (extending the type + defaultSpawn + test stubs — abandoning the await would leak zombies); integrity probe moves even though it has its own connection (bun:sqlite is synchronous — it blocks main's event loop regardless); idx_events_hook_event dropped ONLY with EXPLAIN proof (it has named consumers; the other three are verified consumer-less/subsumed)

## Docs gaps

- **README backup section**: note backup/integrity now run on the maintenance worker [task 1]
- **CLAUDE.md "No kernel watchers"/worker list prose**: add the maintenance worker to any enumerations of workers if present [task 1]

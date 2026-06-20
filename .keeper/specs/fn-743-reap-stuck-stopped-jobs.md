## Overview

Jobs get stuck in `state='stopped'` and never reach a terminal `ended`/`killed`,
so they accumulate in the `jobs` projection — cluttering `keeper jobs` and
keeping done/rejected epics visible on the board. Root cause (repo-scout):
the exit-watcher's candidate query is `state IN ('working','stopped') AND pid
IS NOT NULL` (src/exit-watcher.ts:154-157), so **a `stopped` row with a NULL pid
is never watched and never folds to terminal** — it lives forever. Worse,
`isOccupyingJob` counts `stopped` as occupying (src/autopilot-worker.ts:955), so
stuck rows also hold dispatch/mutex slots. This epic finds why stopped rows end
up NULL-pid (fix the origin if cheap) and reaps truly-terminal stopped rows
(NULL-pid, or pid-confirmed-dead) to a terminal state.

CRITICAL boundary: this is about the `jobs` PROJECTION ROWS, NOT zellij windows.
`autoclose_windows` is OFF by config — finished worker windows intentionally
stay open. The reaper must NOT close live windows and must NOT reap a row whose
session/pid is still alive (idle-but-alive ≠ terminal). Liveness probing is
PRODUCER-side only (never in a fold); the terminal transition is a synthetic
`Killed` emitted via main, exactly like `seedKilledSweep`.

## Quick commands

- `bun test test/exit-watcher.test.ts test/reducer.test.ts`
- `keeper jobs`  # stuck `stopped` rows should no longer accumulate
- `bun test`

## Acceptance

- [ ] A `stopped` row whose pid is NULL or confirmed-dead is folded to a terminal
  state (`killed`/`ended`) — producer-side, via a synthetic event through main,
  never inside a fold. NULL-pid stopped rows no longer live forever.
- [ ] A `stopped` row whose session/process is still ALIVE is left untouched
  (idle-but-alive is not terminal); no zellij window is closed (autoclose stays off).
- [ ] `keeper jobs` no longer accumulates stale `stopped` rows; re-fold
  determinism preserved (the reaper is a producer, folds use the event's ts).

## Early proof point

Task `.1` is the whole epic. If the NULL-pid origin turns out to be a legitimate
state we can't avoid, the reaper path (liveness-probe + synthetic Killed) is the
fallback that still resolves it.

## References

- Incident: `~/docs/keeper-incident-2026-06-08-continuity.md` (the 11 stuck
  `stopped` rows cluttering the board).
- fn-727 (window autoclose — the machinery to AVOID touching), seed-sweep
  (`seedKilledSweep`, the boot-time liveness→Killed pattern to mirror).

## Best practices

- **Only producers probe liveness; never in a fold** (re-fold determinism). [keeper CLAUDE.md]
- **`kill(pid,0)`: ESRCH = dead, EPERM = alive; a zombie reads alive** — use the
  existing `pidAlive()` contract, don't hand-roll. [practice-scout]
- **Don't conflate row-reap with window-reap** — autoclose is off; this never
  closes a surface. [repo-scout]

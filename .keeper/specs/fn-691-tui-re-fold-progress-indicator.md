## Overview

The keeper TUI's "connecting to keeperd…" placeholder only repaints on a
readiness-client backoff tick (250ms→5000ms), so during a multi-minute boot
re-fold (every `SCHEMA_VERSION` bump rewinds the reducer cursor to 0 and
re-drains the whole event log) the spinner looks frozen. This epic drives the
indicator from a local ~125ms timer and, while the subscribe socket is down,
polls keeper's read-only SQLite (`reducer_state.last_event_id` vs
`MAX(events.id)`) to render a live re-fold progress percentage — degrading
cleanly to the plain spinner when no progress is readable.

## Quick commands

- `keeper jobs` while keeperd is mid-restart after a schema bump → expect
  `⠹  re-folding event log  NN.N%  C / M` advancing smoothly, then the live
  board once the socket binds.
- `bun test test/refold-progress.test.ts test/view-shell.test.ts` → poller
  fallback + timer self-stop/teardown coverage.

## Acceptance

- [ ] During a boot re-fold the indicator animates at ~125ms and shows a real
  cursor/max percentage, not a frozen braille glyph.
- [ ] When the DB is unreadable (missing/locked/throw) the indicator degrades
  to the plain "connecting to keeperd…" line and never crashes the TUI.
- [ ] The interval and the read-only connection are torn down on both
  first-frame self-stop and SIGINT — no leaked timer (TUI exits cleanly) and
  no leaked fd.
- [ ] No `NaN%` / `>100%` / fake-100%: guarded for `max===0`/null and
  `cursor>max`; 100% only on confirmed connection.

## Early proof point

Task that proves the approach: the single task below — the injectable poller +
the timer-driven spinner land together with tests. If it fails (e.g. the
readonly poll blocks the animation): fall back to a fixed-cadence spinner with
no percentage, keeping the timer-driven repaint as the minimum win.

## References

- Prior art: commit `fcc3dd1` (feat(tui): connecting indicator + empty-state
  placeholders) — the block this epic replaces.
- Canonical read-only-connection pattern: `src/wake-worker.ts:69-126` (lazy
  `openDb` readonly + naked autocommit SELECT + close-on-teardown).
- `fn-690` (overlap, advisory) — epic-scout flagged a `src/daemon.ts` overlap,
  but this epic only READS boot-drain/rewind logic as context (the `src/db.ts`
  rewind seam) and edits no shared file; no hard dependency wired.

## Best practices

- **Naked autocommit SELECTs (no BEGIN):** a long read transaction pins a WAL
  snapshot and can starve the daemon's checkpoint — mirror `wake-worker`'s
  per-poll bare `db.query(...).get()`.
- **Short connection-local `busy_timeout`:** the default 5000ms would freeze a
  125ms animation during the migration's `BEGIN IMMEDIATE` write-lock window —
  set ≤100ms on the poller's connection and use last-known values on a
  timed-out/blocked poll.
- **`max(id)` not `count(*)`:** O(log n) via the integer PK vs a full table
  scan every tick.
- **Never fake the total or cap at 99%; clamp [0..1]:** treat a non-monotonic
  cursor (crash-loop re-fold restart) as a reset, hold the last good floor, and
  snap to 100% only on confirmed `connected`.
- **Bun `setInterval` has no `.unref()`:** an explicit `clearInterval` on every
  teardown path is load-bearing for a clean TUI exit, not cosmetic.

## Docs gaps

- **README.md (`## Example clients`, ~635):** revise the reconnect sentence to
  note the boot-window read-only progress poll instead of an implied passive
  wait.
- **README.md (`## Architecture`, view-shell mention ~1341):** note
  `createViewShell`'s new injected poller option + the new
  `src/refold-progress.ts` read-only module.
- **CLAUDE.md (`## DO NOT`, "No kernel file watchers" carve-out ~222):** splice
  a parenthetical permitting one-shot read-only progress queries on a transient
  autocommit connection (no change-detection responsibility); do not add a new
  rule.

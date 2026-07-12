## Description

**Size:** S
**Files:** src/maintenance-worker.ts, src/pair/panel.ts, test/pair-panel.test.ts

### Approach

Reproduce first: confirm `panelPrune` (`src/pair/panel.ts:1593-1620`, TTL 3 days,
trashes terminal + lock-free + pid-dead run dirs to a `.gc` subdir) has NO
automatic caller — only the `keeper agent panel prune` CLI verb references it —
so panel dirs under `<state-dir>/panels/` accumulate (the ~72-since-Jul-1
observation) until a human runs the verb.

Wire `panelPrune` into an automatic periodic caller. Host it in the
maintenance-worker (alongside backup/integrity — the natural periodic-fs-maintenance
home) on its own interval, respecting the worker contract (own read-only-where-possible
connection, release on shutdown) and the no-self-heal / sole-writer invariants.
Confirm `panelPrune`'s own liveness check is recycle-safe `(pid, start_time)` (it
uses `panel.ts`'s own start-time reader, `:658`) so a recycled-live pid can't keep
a dead panel un-reaped, and bound the `.gc` trash it creates (define what empties
`.gc`, else the fix relocates the leak).

### Investigation targets

*Verify before relying — planner-verified at authoring time, repo moves.*

**Required:**
- src/pair/panel.ts:1593-1620 — `panelPrune`; :658 its start-time reader
- src/maintenance-worker.ts:212-215 — existing `BACKUP_INTERVAL_MS` periodic-timer pattern to mirror
- src/agent/dispatch.ts:113,271 — current sole (CLI) caller

### Risks

- `.gc` trash may itself grow unbounded — the fix must bound it or hard-delete.
- New periodic worker must honor sole-writer + no-in-process-self-heal (fatalExit, not respawn).

### Test notes

Extend `test/pair-panel.test.ts`: assert the auto-reaper invokes prune on its interval and that live/locked/pid-alive dirs are preserved (prune is already safe — verify the wiring, not re-test prune).

## Acceptance

- [ ] Panel dirs are pruned automatically on a periodic schedule with no human action.
- [ ] The auto-reaper preserves live, locked, and pid-alive panel dirs.
- [ ] The `.gc` trash is bounded (reaped or hard-deleted), so the leak is fixed, not relocated.

## Done summary
Wired panelPrune onto a 24h auto-reaper in the maintenance-worker (alongside backup/integrity), reusing its existing recycle-safe (pid, start_time) liveness gate; the .gc trash sweep now runs automatically too, bounding it instead of relocating the leak. Added test/pair-panel.test.ts coverage for the wiring (reaps + relays only on an actual reap, preserves live/locked/recycle-guarded dirs, no-op while shutting down).
## Evidence

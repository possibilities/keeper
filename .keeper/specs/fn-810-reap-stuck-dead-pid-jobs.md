## Overview

Three jobs in two days sat in `stopped` state with a dead worker pid and were
never reaped — the exit-watcher's kernel arm (kqueue `EV_ONESHOT`) misses or
races occasionally, and the only other dead-pid detector (`seedKilledSweep`)
runs once per boot. Add a periodic age-gated re-probe inside the exit-watcher
so a non-terminal job whose pid is verifiably dead gets a synthetic `Killed`
minted and folds to the terminal `killed` state. No reducer or schema change:
the existing `Killed` fold already performs the transition with its terminal
guard and `(pid, start_time)` match.

## Quick commands

- `bun test test/exit-watcher.test.ts test/daemon.test.ts` — predicate + integration coverage
- `sqlite3 ~/.local/state/keeper/keeper.db "SELECT id,state,pid FROM jobs WHERE state IN ('working','stopped')"` then kill a worker pid and watch the row fold to `killed` within one re-probe tick

## Acceptance

- [ ] A `stopped` (or `working`) job whose worker pid dies without a kernel-arm fire is folded to `killed` within one re-probe interval plus the age gate
- [ ] No false reap of freshly-launched jobs (age gate on `created_at` >= 5 min, mirroring the sitter's `STUCK_JOB_MIN_AGE_SECS`)
- [ ] Probe failure / null OS start_time leaves the row alone (conservative, matching `seedKilledSweep`)
- [ ] Re-mint on an already-terminal or re-armed row is a no-op (fold-time terminal guard + `(pid,start_time)` match)

## Early proof point

Task that proves the approach: `.1`. If it fails (the exit-watcher's message
path can't host a periodic sweep cleanly): fall back to a main-thread
low-frequency timer reusing the exit-watcher onmessage mint body.

## References

- `src/exit-watcher.ts` — candidate set, `ExitMessage` protocol, pidless path (the host)
- `src/seed-sweep.ts:25-67` — the boot-sweep predicate spec this mirrors steady-state
- `src/daemon.ts:2214-2300` — main's mint path (re-read, terminal guard, `(pid,start_time)` match)
- `src/reducer.ts:6195-6255` — the `Killed` fold (unchanged)
- `/Users/mike/code/sitter/sitters/performance/watch.ts:684` — the external detector whose predicate this internalizes

## Docs gaps

- **README.md**: synthetic-`Killed` producer enumeration (~lines 37-42) gains the periodic re-probe as a third producer; dead-pid mechanisms prose (~2101-2115) currently implies exit-watcher + boot sweep are exhaustive
- **CLAUDE.md**: one-line pointer distinguishing the dead-pid re-probe from the tmux window reaper (autopilot section)

## Best practices

- **Pair pid with OS start_time:** `kill(pid,0)` alone is fooled by macOS pid reuse; the recycled-pid check via `readOsStartTime` mismatch is load-bearing [practice-scout]
- **Reaper only mints events, never signals:** signal authority stays with the daemon paths that own the worker process [practice-scout]
- **Log `(pid, start_time, reason)` per reap:** reaps are rare and forensic [practice-scout]

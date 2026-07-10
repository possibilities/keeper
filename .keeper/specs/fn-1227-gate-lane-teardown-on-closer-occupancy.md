## Overview

The worktree finalize trigger collects epics from a union of two arms — the
occupancy-aware `closerJobFinished` and the projection-done arm
(`completedRowIds`) — and the projection-done arm consults no closer
occupancy, so finalize merges and tears a lane down seconds after the close
commit folds, while the closer session is still mid-turn inside that lane.
The blocking-follow-up close gate gave closers a minutes-long post-close
tail, turning this latent 0-width race into a routine zombie factory: a
session whose cwd is deleted cannot spawn (`posix_spawn` ENOENT), its Stop
hooks die, its job row wedges at `working` forever, and the zombie
ghost-holds per-root occupancy until an operator kills the pid. This epic
restores the original sequencing — closer occupancy is a hard gate on every
finalize arm and on recover-pass teardown — and adds a detect-only
cwd-missing sentinel so any residual phantom-working job pages instead of
silently wedging the board. Decision record: docs/adr/0031.

## Quick commands

- bun test test/autopilot-worker.test.ts test/exit-watcher.test.ts
- bun run test:full

## Acceptance

- [ ] An epic whose projection folds done while its close job still
  occupies its slot is not collected for finalize that cycle, and the
  recover pass never tears down a lane whose epic has an occupying
  close or work job
- [ ] A working job whose recorded cwd is missing on disk while its pid
  is alive mints a visible detect-only needs-human distress row, scoped
  to plan-dispatched sessions
- [ ] Crashed-closer finalize (dead pane) and the conflict-escalation
  path are unchanged
- [ ] Full fast suite green

## Early proof point

Task that proves the approach: ordinal 1 (the finalize/recover occupancy
gate plus the regression test reproducing the incident ordering). If it
fails: the occupancy predicate semantics differ from the June design —
re-read `closerJobFinished` history (998aee10, fcd0e630) and re-derive.

## References

- docs/adr/0031-finalize-defers-on-occupying-closer.md (decision record)
- docs/adr/0028-blocking-followup-close-gate.md (the post-close tail that
  widened the race window)
- Incident evidence: fn-1220/fn-1224 closers zombied 2026-07-09 — close
  commit → merge-to-main 2s later (reflog), closers mid-turn, Stop hooks
  posix_spawn ENOENT from deleted cwd, job rows wedged `working`,
  per-root slots ghost-held
- `git log -S closerJobFinished` — 998aee10 (original closer-done
  trigger), fcd0e630 (projection-done re-route for crash robustness)

## Docs gaps

- **CLAUDE.md**: fold the new cwd-missing distress row into the existing
  Autopilot distress-row family sentence (one line, lint gate green)

## Best practices

- **Advisory probe + fail-closed**: rmdir of another process's cwd
  succeeds on Linux/macOS (EBUSY is mountpoint/root only) — the kernel
  never refuses, so sequencing/deferral is the fix, not error handling
- **Detect-only belts stat the cheap signal first**: cwd existence via
  stat before any event-gap analysis; a throwing probe suppresses the
  page rather than minting one
- **pid + start-time identity, never pid alone** (pid recycling) —
  src/proc-starttime.ts exists for this

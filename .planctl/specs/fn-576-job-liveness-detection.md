## Overview

Keeper's `jobs` projection has no way to know that a process is dead — only a `SessionEnd` hook event moves a row to `ended`. Sessions killed via SIGKILL, terminal-pane closure, machine reboot, or hook crash leave zombie rows that say `working`/`stopped` forever. This epic adds a fourth state `killed` plus the seed-time and live-time detection paths that fold dead processes into it: capturing recycle-safe `(pid, start_time)` identity in the SessionStart hook, a boot-time pid sweep that emits synthetic `Killed` events for stale rows, and a new `exit-watcher` worker that uses kqueue (macOS) / pidfd (Linux) via `bun:ffi` to detect live exits. The default jobs filter tightens to hide both terminal states by default, removing zombie rows from the keeper-frames default view as a side effect.

## Quick commands

- `bun scripts/keeper-frames.ts --collection jobs` — confirms zombies no longer surface in the default view
- `bun scripts/keeper-frames.ts --collection jobs --state killed` — explicit query for killed rows
- `sqlite3 ~/.local/state/keeper/keeperd.sqlite 'SELECT job_id, state, pid, start_time FROM jobs WHERE state = "killed" LIMIT 10'` — direct DB inspection

## Acceptance

- [ ] Jobs FSM is `working|stopped|ended|killed`; `killed` is terminal-but-revivable (SessionStart and UserPromptSubmit re-open to stopped/working respectively)
- [ ] SessionStart hook captures `start_time` on macOS (combined `ps -o args=,lstart=` fork) and Linux (`/proc/$PPID/stat` field 22), platform-tagged opaque string
- [ ] Boot sequence: `migrate → drainToCompletion → seedKilledSweep → drainToCompletion → spawn workers`; sweep emits Killed for dead/recycled pids; legacy rows missing start_time follow Q7 rules
- [ ] Live exit-watcher worker uses kqueue/pidfd via `bun:ffi`; data_version-driven watch set; post-register liveness probe closes the register race; main verifier emits Killed after start_time check
- [ ] Default `JOBS_DESCRIPTOR.defaultFilter` hides both `ended` and `killed`; reachable via explicit `--state`
- [ ] Re-fold from cursor=0 reproduces every killed row byte-identically (event-sourcing invariant preserved)
- [ ] All existing tests pass; new tests cover Killed fold, SessionStart-on-killed re-open, terminal guard, seed sweep, FFI struct layout, live kill detection end-to-end

## Early proof point

Task that proves the approach: task 7 (FFI spike). If it fails: bun:ffi against kqueue/pidfd is the most uncertain piece — if the spike surfaces a fundamental blocker (struct layout drift, JSCallback threading), the rest of the epic still ships value (schema + Killed event + reducer + seed sweep + filter tightening clean up the current zombie backlog), and the live-detection path can degrade to a periodic main-thread polling fallback added later as an epic refine. The standalone scope is what enables that fallback path without re-cutting the rest of the epic.

## References

- `src/reducer.ts:18-38` — state-machine header that will be rewritten to remove the "no process-liveness overlay" claim
- `src/server-worker.ts:226` — existing `isPidAlive(pid)` reused by the seed sweep and the post-register probe
- `src/wake-worker.ts` — clone template for the exit-watcher worker (simpler than server-worker, no socket ownership)
- `src/plan-worker.ts:517-558` — `PlanScanner.sweep` is the closest analog to the seed sweep pattern
- CLAUDE.md DO NOT list — needs a clarifying carve-out for "kqueue-on-processes" vs the existing "no file-watchers on keeper's own DB" rule
- Chromium base/process/kill_mac.cc — canonical EV_ADD+ESRCH race handler (practice-scout reference)
- man7 pidfd_open(2) — Linux kernel ≥5.3 requirement
- Bun FFI docs — https://bun.com/docs/runtime/ffi

## Docs gaps

- **README.md (Architecture section)**: revise 3-state → 4-state vocabulary; 4-worker → 5-worker prose; remove implicit "no liveness overlay" claim; SQL inspect snippet mentions killed alongside ended.
- **CLAUDE.md (and AGENTS.md symlink)**: event-sourcing invariants absorb `Killed` as a main-only synthetic; DO NOT carve-out clarifying that kqueue/pidfd on process descriptors is permitted (distinct from the file-watcher ban on keeper's DB); Worker contract notes exit-watcher's kqueue/pidfd resource release in its own shutdown handler.
- **src/reducer.ts (file header)**: rewrite the state-machine table to include `killed`; rewrite the "no process-liveness overlay" prose block to describe `Killed` as a synthetic event that folds normally.
- **src/collections.ts (defaultFilter comment block, ~lines 102-108)**: change exhaustive state enumeration to four-state; update default-filter description to "hide both terminal states."
- **src/daemon.ts (file header boot-sequence diagram)**: FOUR → FIVE workers; add exit-watcher to numbered list; SIGTERM step says FIVE.
- **scripts/keeper-frames.ts (--state help text comment)**: include killed in the default-hide list alongside ended.
- **plugin/hooks/events-writer.ts (file header)**: extend the pid-field comment to document `(pid, start_time)` two-field identity and why (recycle-safe liveness).

## Best practices

- **(pid, start_time) durable identity is the standard mitigation** for pid recycling (used by systemd, polkit, psutil, Chromium). Bare pid alone is unsafe on macOS where pid space is small and recycle can happen within hours.
- **EV_ADD against an already-dead pid fails with ESRCH (or ENOENT)** — silently dropping the change misses the exit. Always check `kevent()` return; on ESRCH/ENOENT emit the synthetic exit immediately. This is the post-register liveness probe.
- **`kill(pid, 0)` returns EPERM means alive-but-not-ours**, not dead. Only ESRCH = dead. On sandboxed macOS, EPERM is the common case for processes outside our visibility; treating it as dead would falsely kill rows.
- **`EV_ONESHOT` on `EVFILT_PROC | NOTE_EXIT`** — process exit is by definition one-shot; the kernel auto-deletes the registration so no EV_DELETE cleanup is needed and no accidental re-arm bugs are possible.
- **`EVFILT_USER` + `NOTE_TRIGGER` (macOS) / `eventfd` (Linux)** for shutdown wakeup — the kqueue/epoll worker MUST have a way to interrupt its blocking wait when main posts shutdown; otherwise `terminate()` hangs and the worker contract is violated.
- **One Worker, one persistent kqueue/epoll fd, one blocking loop** — don't recreate the kqueue per registration; don't dispatch each registration as a new JS Promise; batch the changelist and call kevent once. (bun:ffi gateway is ~2 ns, irrelevant vs syscall cost in µs.)
- **`proc_pidinfo` over `ps -p X -o lstart=`** — for the seed sweep's start_time re-read on macOS, FFI to `proc_pidinfo` is ~1µs vs ~5-20ms for ps (fork+exec dominates). Worth it when sweep is over many rows.
- **Re-fold determinism MUST be preserved** — the Killed event payload (pid, start_time, detected_at) must be enough to fold deterministically. Any liveness re-probe inside the fold would BREAK re-fold determinism. The producer (seed sweep / exit-watcher) is the ONLY place that probes liveness.

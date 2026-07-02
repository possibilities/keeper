## Description

**Size:** M
**Files:** src/pair/panel.ts, test/pair-panel.test.ts, test/agent-panel-cli.test.ts, plugins/keeper/skills/pair/SKILL.md, plugins/plan/agents/panel-runner.md, README.md

### Approach

Guard A (pid recycle): capture each leg's OS start-time at spawn inside the detached wrapper — it already writes `PIDFILE` via `echo $!`; add a sibling start-time capture (same command/env discipline as `readOsStartTime`: `LC_ALL=C TZ=UTC ps -o lstart= -p $!`) written atomically beside the pidfile. On liveness checks, cross-check the stored value against a live probe through an injectable `PanelDeps` seam (default `readOsStartTime` from src/seed-sweep.ts — mirror bus-worker.ts:481's default-parameter injection; normalize the `darwin:`/`linux:` tag so stored and probed values compare). Thread the check through `probeLeg` (the chokepoint both `reconcileLeg` and `evaluateLeg`/`classifyLegStatus` read) and give `hasLiveLeg` the same guard. Memoize verified `(pid, start_time)` pairs per invocation so the probe runs once per entry, never per 5s poll tick. Fail OPEN on a null live-side probe (trust bare `pidAlive`, retry next entry) — a false "dead" spuriously fails a healthy panel, a false "alive" only extends a bounded wait. A missing stored start-time (old manifest / capture failure) degrades to today's bare-pidAlive behavior.

Guard B (reboot in wait): `panelWait` derives the current boot epoch through the same injectable seam `panelStart` uses (verify the derivation is sleep-proof — kern.boottime, not now()-uptime arithmetic, per macOS Sonoma+ uptime semantics; fix the seam if it is not) and compares against `manifest.boot_epoch_ms` with the existing `BOOT_EPOCH_TOLERANCE_MS`. On mismatch, classify non-terminal legs as terminal-failed with a distinct `machine-rebooted` reason and return promptly under the existing exit-code contract (0 with ok=false). An ABSENT `boot_epoch_ms` (pre-durable manifest) is fail-open no-mismatch — never `?? 0`. `wait` stays strictly read-only: no manifest writes, no relaunches. Update the two consumer docs (pair SKILL.md reboot re-entry ~line 150, panel-runner.md resume flow ~line 110) with one line each: on a `machine-rebooted` verdict, re-issue `panel start` (idempotent reconcile relaunches the legs) and then `wait` again.

### Investigation targets

**Required** (read before coding):
- src/pair/panel.ts:487-597 — `buildPanelLegArgv`, the DETACH_SCRIPT wrapper (pidfile write), and `probeLeg`
- src/pair/panel.ts:848,1290-1298 — `reconcileLeg` and `hasLiveLeg`, the two bare-pidAlive sites
- src/pair/panel.ts:973-976,1071-1073,98 — the boot-epoch derivation, `bootMismatch` comparison, and tolerance to reuse in `wait`
- src/pair/panel.ts:1169-1213 — `panelWait` loop, exit codes, and `evaluateLeg` per-tick calls
- src/bus-worker.ts:469-496 — the verbatim-compare pattern and ONCE-per-entry probe discipline to copy
- src/seed-sweep.ts:101-130 — `readOsStartTime` (import must stay free of daemon/bun:sqlite deps — bus-worker already imports it, verify the graph stays clean)
- src/pair/panel.ts:743-781 — `parseManifest` member reconstruction: any new persisted field must be threaded there and validated-when-present, or it silently drops on every read

**Optional** (reference as needed):
- src/pair/panel.ts:1086-1100 — relaunch generation paths (a relaunched leg needs the same start-time capture)
- test/pair-panel.test.ts:100-119,482,910 — `makeDeps` and the existing recycled-pid-shaped tests to extend

### Risks

- The wrapper's `ps` capture races nothing (serial after `$!`) but its output format must byte-match what the live probe returns after tag normalization — a formatting mismatch makes every leg read recycled (fail-closed by accident); the fail-open rule plus a dedicated format-mismatch test guards this
- If the existing boot-epoch seam turns out to be uptime-derived, fixing it changes `start`'s reconcile behavior too (false-reboot relaunches after long sleep) — that fix is in scope but must keep start and wait on the SAME seam
- `classifyLegStatus` documents "never throws, never mutates" — the new checks must preserve both

### Test notes

All through injected `PanelDeps` (fake `readStartTime`, fake boot epoch, fake clock) — fast tier never forks `ps`. Cover: recycled pid (stored ≠ probed) reads dead; null probe reads alive (fail-open); missing stored value degrades to bare pidAlive; wait against a boot-epoch-mismatched manifest fails legs with the `machine-rebooted` reason and exits promptly; wait against an epoch-absent manifest does NOT fire the guard; the reboot+recycle intersection (Guard B fires first, Guard A backstops same-boot recycle). Extend `makeDeps` with the `readStartTime` override.

## Acceptance

- [ ] A same-boot recycled pid no longer reads as a live leg in reconcile, status, or prune veto paths
- [ ] Post-reboot `panel wait` returns promptly with `machine-rebooted` terminal reasons instead of spinning to 124; pre-durable manifests are unaffected
- [ ] `wait` performs zero manifest writes; sole-writer invariant intact
- [ ] Consumer docs (pair SKILL.md, panel-runner.md) name the re-issue-start-on-reboot step; README liveness + wait sentences updated in place
- [ ] Full fast suite green

## Done summary

## Evidence

## Description

**Size:** M
**Files:** scripts/maintenance-window.ts (new), src/backup.ts (reference), test/ (new)

### Approach

Provide ONE supported command that runs the full offline-reclaim window with the
existing safety gates, replacing the ~8 manual steps. Sequence: capture autopilot
state → pause autopilot → await the plan-worker drain signal from task .1 →
pre-reclaim snapshot → stop the daemon (launchctl bootout, resolved label) →
`keeper reclaim` (which already snapshots + checkpoints + VACUUM INTOs + self-verifies
+ atomically swaps) → restart (launchctl bootstrap, resolved plist) → `keeper await
server-up` → verify (`auto_vacuum=2`, size, a `search-history` forensics probe) →
then either `--hold` (leave autopilot paused) or restore/`play`. Must fail safe: on
any verify mismatch, leave the pre-reclaim DB in place and autopilot paused for
triage (mirror `keeper reclaim`'s own rollback discipline). Honor the no-in-process-
self-heal + sole-writer invariants; the wrapper orchestrates supported verbs, it does
not write keeper.db itself.

### Investigation targets

*Verify before relying — the repo moves.*

**Required:**
- src/backup.ts — `reclaimDb` / `reclaimInstructions` (the sequence to orchestrate); `keeper reclaim` is the offline step
- src/maintenance-worker.ts:212 — the existing backup timer / worker pattern
- task .1's drain signal — the safe-to-stop gate

### Risks

- Stopping/restarting the daemon via launchctl is external to keeper; the wrapper must resolve the correct label/plist (see task .3) and verify the daemon actually stopped before reclaim (reclaim refuses if the lock is held).
- Must not unpause on failure — leave paused for triage.

### Test notes

Test the orchestration logic with injected seams for the launchctl/daemon/verify steps (no real daemon in the fast tier); assert the failure path leaves autopilot paused and the pre-reclaim DB untouched.

## Acceptance

- [ ] One command runs pause → drain-wait → snapshot → stop → reclaim → restart → verify → hold/play with the existing safety gates.
- [ ] A `--hold` mode leaves autopilot paused; the default/`--play` restores the captured state.
- [ ] On any verify failure the pre-reclaim DB is preserved and autopilot is left paused.

## Done summary
Added scripts/maintenance-window.ts: one command running the full offline-reclaim window (pause, drain-wait via task .1's board_work_jobs signal, snapshot, stop, keeper reclaim, restart, verify, hold/play), fail-safe on every step with 14 orchestration tests.
## Evidence
